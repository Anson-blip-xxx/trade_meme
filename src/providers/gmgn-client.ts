import {constants, createHash, createPrivateKey, randomUUID, sign as cryptoSign} from 'node:crypto';
import {abortable} from '../http.js';

const HOST = 'https://openapi.gmgn.ai';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_QUEUE_WAIT_MS = 45_000;
const MAX_LIVE_ENTRY_QUEUE = 16;
const MAX_NORMAL_QUEUE = 128;
const MAX_BACKGROUND_QUEUE = 16;
// A busy normal lane still yields one bounded opportunity to its own archive
// work. This is per credential: unrelated API keys retain independent lanes.
const BACKGROUND_FAIRNESS_INTERVAL_MS = 5_000;
// GMGN documents the plan bucket as weight units refilled per second
// (Free 5/5, Plus 20/20, Pro 50/50). The 350 ms floor is intentionally
// conservative enough for Free even when a route carries multiple units.
const RATE_WINDOW_MS = 1_000;
const MIN_OBSERVED_INTERVAL_MS = 350;
const MAX_OBSERVED_INTERVAL_MS = RATE_WINDOW_MS;
const MAX_VALID_RATE_LIMIT = 100;
// Only fixed read-only routes verified in the official OpenApiClient. No
// writes, arbitrary URL, guessed funding endpoint, or redirects.
const READ_ROUTES = new Map<string, number>([
  ['/v1/token/info', 1], ['/v1/token/security', 1], ['/v1/token/pool_info', 1],
  ['/v1/market/token_top_holders', 5], ['/v1/market/token_top_traders', 5],
  ['/v1/market/token_kline', 2], ['/v1/market/rank', 3], ['/v1/market/search', 1],
  ['/v1/user/kol', 1], ['/v1/user/smartmoney', 1],
  ['/v1/user/wallet_stats', 3], ['/v1/user/wallet_activity', 3],
  ['/v1/user/wallet_token_balance', 2], ['/v1/user/created_tokens', 2],
  ['/v1/user/info', 2], ['/v1/user/follow_tokens', 3], ['/v1/user/follow_token_groups', 1],
  ['/v1/trade/gas_price', 1], ['/v1/trade/quote', 10],
]);

export type GmgnErrorReason = 'GMGN_API_KEY_MISSING' | 'GMGN_PATH_NOT_ALLOWED' | 'GMGN_QUERY_INVALID'
  | 'GMGN_SIGNING_KEY_MISSING'
  | 'GMGN_RATE_LIMITED' | 'GMGN_QUEUE_TIMEOUT' | 'GMGN_REQUEST_TIMEOUT' | 'GMGN_REQUEST_FAILED'
  | 'GMGN_RESPONSE_TOO_LARGE' | 'GMGN_RESPONSE_INVALID' | 'GMGN_INVALID_JSON'
  | 'GMGN_REQUEST_ABORTED' | 'GMGN_AUTH_FAILED' | 'GMGN_CURSOR_INVALID' | 'GMGN_HTTP_ERROR' | 'GMGN_API_ERROR';

/** Deliberately contains no upstream message, URL, query, key, or response body. */
export class GmgnError extends Error {
  readonly reason: GmgnErrorReason;
  readonly cooldownUntil?: string;
  readonly retryAfterMs?: number;
  constructor(reason: GmgnErrorReason, cooldownUntilMs?: number, now = Date.now()) {
    super(reason);
    this.name = 'GmgnError';
    this.reason = reason;
    if (cooldownUntilMs !== undefined && Number.isFinite(cooldownUntilMs)) {
      this.cooldownUntil = new Date(Math.min(cooldownUntilMs, 8.64e15)).toISOString();
      this.retryAfterMs = Math.max(0, cooldownUntilMs - now);
    }
  }
}

interface RateState {
  nextAt: number;
  cooldownUntil: number;
  observedIntervalMs: number;
  lastStartedAt?: number;
  lastCost?: number;
  lastBackgroundStartedAt?: number;
}
export type GmgnRequestPriority = 'background' | 'normal' | 'live_entry';
export interface GmgnScheduleOptions {
  priority?: GmgnRequestPriority;
  /** Queue budget only. Network requests retain their own fixed timeout. */
  queueTimeoutMs?: number;
}
interface ScheduledRequest<T> {
  lane: RateState;
  priority: GmgnRequestPriority;
  expiresAt: number;
  signal?: AbortSignal;
  waitMs: () => number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
  interrupt?: () => void;
  started: boolean;
  settled: boolean;
}
// One process-wide scheduler owns all queues. Requests sharing a credential are
// strictly serial and share weighted pacing/cooldown; separate credentials have
// independent Plus quotas and therefore cannot head-of-line block each other.
const liveEntryQueue: ScheduledRequest<unknown>[] = [];
const normalQueue: ScheduledRequest<unknown>[] = [];
const backgroundQueue: ScheduledRequest<unknown>[] = [];
const activeLanes = new Set<RateState>();
const activeRequests = new Map<RateState,ScheduledRequest<unknown>>();
let schedulerActive = false;
let schedulerWake: ReturnType<typeof setTimeout> | undefined;

function removeScheduled(job: ScheduledRequest<unknown>): boolean {
  const queue = job.priority === 'live_entry' ? liveEntryQueue : job.priority === 'background' ? backgroundQueue : normalQueue;
  const index = queue.indexOf(job);
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}
function cleanupScheduled(job: ScheduledRequest<unknown>): void {
  if (job.timer) clearTimeout(job.timer);
  if (job.abort && job.signal) job.signal.removeEventListener('abort', job.abort);
}
function rejectScheduled(job: ScheduledRequest<unknown>, error: unknown): void {
  if (job.settled) return;
  job.settled = true;
  cleanupScheduled(job);
  job.reject(error);
}
function kickScheduler(): void {
  if (schedulerWake) { clearTimeout(schedulerWake); schedulerWake = undefined; }
  if (!schedulerActive) void drainScheduler();
}
function pruneQueue(queue: ScheduledRequest<unknown>[], now: number): void {
  for (let index = queue.length - 1; index >= 0; index--) {
    const job = queue[index];
    if (job.signal?.aborted || job.expiresAt <= now) {
      queue.splice(index, 1);
      rejectScheduled(job, new GmgnError(job.signal?.aborted ? 'GMGN_REQUEST_ABORTED' : 'GMGN_QUEUE_TIMEOUT'));
    }
  }
}
function nextReady(queue: ScheduledRequest<unknown>[]): {job?: ScheduledRequest<unknown>; wait: number} {
  let wait = Number.POSITIVE_INFINITY;
  for (const job of queue) {
    if (activeLanes.has(job.lane)) continue;
    const remaining = Math.max(0, job.waitMs());
    if (remaining === 0) return {job, wait: 0};
    wait = Math.min(wait, remaining);
  }
  return {wait};
}
function nextReadyBackground(now: number): {job?: ScheduledRequest<unknown>; wait: number; contended: boolean} {
  let wait = Number.POSITIVE_INFINITY;
  for (const job of backgroundQueue) {
    if (activeLanes.has(job.lane)) continue;
    const pacingWait = Math.max(0, job.waitMs());
    if (pacingWait > 0) { wait = Math.min(wait, pacingWait); continue; }
    const contended = normalQueue.some(normal => normal.lane === job.lane);
    if (!contended) return {job, wait: 0, contended: false};
    const fairAt = (job.lane.lastBackgroundStartedAt ?? Number.NEGATIVE_INFINITY) + BACKGROUND_FAIRNESS_INTERVAL_MS;
    const fairnessWait = Math.max(0, fairAt - now);
    if (fairnessWait === 0) return {job, wait: 0, contended: true};
    wait = Math.min(wait, fairnessWait);
  }
  return {wait, contended: false};
}
async function drainScheduler(): Promise<void> {
  if (schedulerActive) return;
  schedulerActive = true;
  try {
    for (;;) {
      const now = Date.now();
      pruneQueue(liveEntryQueue, now); pruneQueue(normalQueue, now); pruneQueue(backgroundQueue, now);
      const live = nextReady(liveEntryQueue);
      const normal = live.job ? {wait: Number.POSITIVE_INFINITY} : nextReady(normalQueue);
      const background = live.job ? {wait: Number.POSITIVE_INFINITY, contended: false} : nextReadyBackground(now);
      // A contended background job is selected only at its per-credential
      // fairness boundary. Uncontended background work remains below normal
      // priority; the loop can start it concurrently once other lanes are busy.
      const selected = live.job ?? (background.contended ? background.job : normal.job ?? background.job);
      if (!selected) {
        const wait = Math.min(live.wait, normal.wait, background.wait);
        if (Number.isFinite(wait)) schedulerWake = setTimeout(() => {schedulerWake = undefined; kickScheduler();}, wait);
        return;
      }
      removeScheduled(selected); selected.started = true; cleanupScheduled(selected); activeLanes.add(selected.lane);
      if (selected.priority === 'background') selected.lane.lastBackgroundStartedAt = now;
      activeRequests.set(selected.lane,selected);
      void (async () => {
        try {
          const value = await selected.run();
          if (!selected.settled) { selected.settled = true; selected.resolve(value); }
        } catch (error) { rejectScheduled(selected, error); }
        // Let a completed high-priority metadata read enqueue its dependent
        // holder reads before releasing this credential lane to background work.
        await Promise.resolve(); activeLanes.delete(selected.lane); activeRequests.delete(selected.lane); kickScheduler();
      })();
    }
  } finally { schedulerActive = false; }
}
function enqueueScheduled<T>(job: Omit<ScheduledRequest<T>, 'resolve'|'reject'|'started'|'settled'>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const scheduled: ScheduledRequest<T> = {...job, resolve, reject, started: false, settled: false};
    const queue = scheduled.priority === 'live_entry' ? liveEntryQueue : scheduled.priority === 'background' ? backgroundQueue : normalQueue;
    pruneQueue(queue as ScheduledRequest<unknown>[], Date.now());
    const capacity = scheduled.priority === 'live_entry' ? MAX_LIVE_ENTRY_QUEUE :
      scheduled.priority === 'background' ? MAX_BACKGROUND_QUEUE : MAX_NORMAL_QUEUE;
    // Capacity belongs to the credential lane. One configured account must not
    // reject live work for another account that has its own quota and pacing.
    if (queue.reduce((count,queued)=>count+Number(queued.lane===scheduled.lane),0) >= capacity) {
      reject(new GmgnError('GMGN_QUEUE_TIMEOUT')); return;
    }
    scheduled.timer = setTimeout(() => {
      if (scheduled.started || !removeScheduled(scheduled as ScheduledRequest<unknown>)) return;
      rejectScheduled(scheduled as ScheduledRequest<unknown>, new GmgnError('GMGN_QUEUE_TIMEOUT'));
      kickScheduler();
    }, Math.max(1, scheduled.expiresAt - Date.now()));
    scheduled.abort = () => {
      if (scheduled.started || !removeScheduled(scheduled as ScheduledRequest<unknown>)) return;
      rejectScheduled(scheduled as ScheduledRequest<unknown>, new GmgnError('GMGN_REQUEST_ABORTED'));
      kickScheduler();
    };
    scheduled.signal?.addEventListener('abort', scheduled.abort, {once: true});
    if (scheduled.signal?.aborted) { scheduled.abort(); return; }
    queue.push(scheduled as ScheduledRequest<unknown>);
    // Background reads are observational. If an opening-order read arrives,
    // cancel an interruptible background HTTP request on the same credential
    // lane instead of making live work wait for its network timeout.
    if(scheduled.priority==='live_entry') {
      const active=activeRequests.get(scheduled.lane);
      if(active?.priority==='background')active.interrupt?.();
    }
    kickScheduler();
  });
}
const rateStates = new Map<string, RateState>();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
type QueryValue=string|number|readonly string[];

export interface GmgnClientOptions {
  apiKey?: string;
  privateKeyPem?: string;
  minIntervalMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}

export class GmgnClient {
  private readonly apiKey?: string;
  private readonly privateKeyPem?: string;
  private readonly interval: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly state: RateState;
  private readonly signal?: AbortSignal;

  constructor(options: GmgnClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.privateKeyPem = options.privateKeyPem?.trim() || undefined;
    this.interval = Number.isFinite(options.minIntervalMs) && options.minIntervalMs! >= 0
      ? Math.min(options.minIntervalMs!, MAX_QUEUE_WAIT_MS) : 1_200;
    this.fetcher = options.fetcher ?? fetch;
    this.signal = options.signal;
    this.now = options.now ?? Date.now;
    const key = createHash('sha256').update(this.apiKey ?? '').digest('hex');
    let state = rateStates.get(key);
    if (!state) { state = {nextAt: 0, cooldownUntil: 0, observedIntervalMs: 0}; rateStates.set(key, state); }
    this.state = state;
  }

  /** An evaluation scope shares the original credential budget and never resets cooldown. */
  withSignal(signal:AbortSignal):GmgnClient {
    return new GmgnClient({apiKey:this.apiKey,privateKeyPem:this.privateKeyPem,minIntervalMs:this.interval,fetcher:this.fetcher,now:this.now,
      signal:this.signal?AbortSignal.any([this.signal,signal]):signal});
  }
  private checkAborted():void {if(this.signal?.aborted)throw new GmgnError('GMGN_REQUEST_ABORTED');}

  /** Epoch milliseconds; allows pollers to skip work until the shared reset. */
  get cooldownUntil(): number { return this.state.cooldownUntil; }

  async get(path: string, query: Record<string, string | number>, weight?: number,
    scheduling: GmgnScheduleOptions = {}): Promise<unknown> {
    this.checkAborted();
    if (!this.apiKey) throw new GmgnError('GMGN_API_KEY_MISSING');
    const routeWeight = READ_ROUTES.get(path);
    if (routeWeight === undefined) throw new GmgnError('GMGN_PATH_NOT_ALLOWED');
    if (!object(query) || Object.keys(query).length > 40 ||
        Object.entries(query).some(([key, value]) => !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
          ['timestamp', 'client_id'].includes(key) ||
          !['string', 'number'].includes(typeof value) ||
          (typeof value === 'number' && !Number.isFinite(value)) || String(value).length > 2_000) ||
        (weight !== undefined && (!Number.isFinite(weight) || weight < 1 || weight > 100))) {
      throw new GmgnError('GMGN_QUERY_INVALID');
    }
    const safeQuery = {...query};
    const cost = Math.max(routeWeight, Math.ceil(weight ?? routeWeight));
    return this.scheduleRequest(cost, () => this.request(path, safeQuery), scheduling);
  }

  /** Signed, read-only page of trades made by wallets followed in GMGN. */
  async getFollowWallet(chain:'sol'|'bsc'|'robinhood', limit=100,
    scheduling:GmgnScheduleOptions={priority:'background',queueTimeoutMs:5_000}):Promise<unknown> {
    this.checkAborted();
    if(!this.apiKey)throw new GmgnError('GMGN_API_KEY_MISSING');
    if(!this.privateKeyPem)throw new GmgnError('GMGN_SIGNING_KEY_MISSING');
    if(!['sol','bsc','robinhood'].includes(chain)||!Number.isSafeInteger(limit)||limit<1||limit>100)
      throw new GmgnError('GMGN_QUERY_INVALID');
    return this.backgroundRequest(10,scheduling,signal=>this.request('/v1/trade/follow_wallet',{chain,limit},true,'GET',undefined,signal));
  }

  /** Fixed research feed: exits, CTO, smart-money and platform/KOL calls. */
  async getMemeMarketSignals(chain:'sol'|'bsc'|'robinhood',
    scheduling:GmgnScheduleOptions={priority:'background',queueTimeoutMs:5_000}):Promise<unknown> {
    this.checkAborted();
    if(!this.apiKey)throw new GmgnError('GMGN_API_KEY_MISSING');
    if(!['sol','bsc','robinhood'].includes(chain))throw new GmgnError('GMGN_QUERY_INVALID');
    // GMGN caps each group independently. Keep semantically distinct groups
    // separate or a single busy category can silently crowd out the others.
    return this.backgroundRequest(1,scheduling,signal=>this.request('/v1/market/token_signal',{},false,'POST',
      {chain,groups:[{signal_type:[12]},{signal_type:[20]},{signal_type:[13,19]},
        {signal_type:[6,7]},{signal_type:[10,11]},{signal_type:[17,18,21]}]},signal));
  }

  /** Latest or cursor page from GMGN's read-only global call-out feed. */
  async getCalloutGlobal(chains:readonly ('sol'|'bsc'|'robinhood')[],options:{limit?:number;pageToken?:string;
    onlyDeclaration?:boolean}={},scheduling:GmgnScheduleOptions={priority:'background',queueTimeoutMs:5_000}):Promise<unknown>{
    this.checkAborted();if(!this.apiKey)throw new GmgnError('GMGN_API_KEY_MISSING');
    const unique=[...new Set(chains)];
    if(!unique.length||unique.length>20||unique.some(chain=>!['sol','bsc','robinhood'].includes(chain))||
      options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>50)||
      options.pageToken!==undefined&&(!/^[\x21-\x7e]{1,512}$/.test(options.pageToken)))
      throw new GmgnError('GMGN_QUERY_INVALID');
    const body:Record<string,unknown>={chains:unique,limit:options.limit??50};
    if(options.pageToken)body.page_token=options.pageToken;
    if(options.onlyDeclaration)body.only_declaration=true;
    return this.backgroundRequest(3,scheduling,signal=>this.request('/v1/callout/global',{},false,'POST',body,signal));
  }

  async getWalletStats(chain:'sol'|'bsc'|'robinhood',wallets:readonly string[],period:'7d'|'30d'='7d',
    scheduling:GmgnScheduleOptions={priority:'background',queueTimeoutMs:5_000}):Promise<unknown>{
    const safe=this.wallets(chain,wallets,20);
    return this.backgroundRequest(3,scheduling,signal=>this.request('/v1/user/wallet_stats',
      {chain,wallet_address:safe,period},false,'GET',undefined,signal));
  }

  async getWalletProfits(chain:'sol'|'bsc'|'robinhood',wallets:readonly string[],period:'1d'|'7d'|'30d'|'all'='all',
    scheduling:GmgnScheduleOptions={priority:'background',queueTimeoutMs:5_000}):Promise<unknown>{
    const safe=this.wallets(chain,wallets,100);
    return this.backgroundRequest(3,scheduling,signal=>this.request('/v1/user/wallet_profits',{},false,'POST',
      {chain,period,wallet_addresses:safe},signal));
  }

  async getWalletActivity(chain:'sol'|'bsc'|'robinhood',wallet:string,cursor?:string,
    scheduling:GmgnScheduleOptions={priority:'background',queueTimeoutMs:5_000}):Promise<unknown>{
    const [safe]=this.wallets(chain,[wallet],1);
    if(cursor!==undefined&&!/^[\x21-\x7e]{1,512}$/.test(cursor))throw new GmgnError('GMGN_QUERY_INVALID');
    return this.backgroundRequest(3,scheduling,signal=>this.request('/v1/user/wallet_activity',
      {chain,wallet_address:safe,limit:50,...(cursor?{cursor}:{})},false,'GET',undefined,signal));
  }

  async getWalletHoldings(chain:'sol'|'bsc'|'robinhood',wallet:string,
    options:{limit?:number;cursor?:string;closedOnly?:boolean}={},
    scheduling:GmgnScheduleOptions={priority:'background',queueTimeoutMs:5_000}):Promise<unknown>{
    const [safe]=this.wallets(chain,[wallet],1);
    if(!this.privateKeyPem)throw new GmgnError('GMGN_SIGNING_KEY_MISSING');
    if(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>50)||
      options.cursor!==undefined&&!/^[\x21-\x7e]{1,512}$/.test(options.cursor))throw new GmgnError('GMGN_QUERY_INVALID');
    const query:Record<string,QueryValue>={chain,wallet_address:safe,limit:options.limit??50,
      order_by:'usd_value',direction:'desc',hide_abnormal:'false',hide_airdrop:'true',
      hide_closed:options.closedOnly?'false':'true',...(options.closedOnly?{hide_open:'true'}:{}),
      ...(options.cursor?{cursor:options.cursor}:{})};
    return this.backgroundRequest(2,scheduling,signal=>this.request('/v1/user/wallet_holdings',query,true,'GET',undefined,signal));
  }

  async getCalloutRecord(chain:'sol'|'bsc'|'robinhood',wallet:string,
    options:{limit?:number;pageToken?:string}={},
    scheduling:GmgnScheduleOptions={priority:'background',queueTimeoutMs:5_000}):Promise<unknown>{
    const [safe]=this.wallets(chain,[wallet],1);
    if(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>50)||
      options.pageToken!==undefined&&!/^[\x21-\x7e]{1,512}$/.test(options.pageToken))throw new GmgnError('GMGN_QUERY_INVALID');
    const body:Record<string,unknown>={chain,call_wallet:safe,limit:options.limit??50};
    if(options.pageToken)body.page_token=options.pageToken;
    return this.backgroundRequest(3,scheduling,signal=>this.request('/v1/callout/get_record',{},false,'POST',body,signal));
  }

  private wallets(chain:'sol'|'bsc'|'robinhood',wallets:readonly string[],max:number):string[]{
    this.checkAborted();if(!this.apiKey)throw new GmgnError('GMGN_API_KEY_MISSING');
    const evm=/^0x[0-9a-f]{40}$/i,sol=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const safe=[...new Set(wallets)];
    if(!safe.length||safe.length>max||safe.some(value=>!(chain==='sol'?sol:evm).test(value)))throw new GmgnError('GMGN_QUERY_INVALID');
    return safe;
  }

  private backgroundRequest<T>(weight:number,scheduling:GmgnScheduleOptions,run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    const controller=new AbortController();
    return this.scheduleRequest(weight,()=>run(controller.signal),scheduling,()=>controller.abort());
  }

  /** Shared budget only: this does not expose a network write method or credentials. */
  async scheduleRequest<T>(weight: number, execute: () => Promise<T>, scheduling: GmgnScheduleOptions = {},interrupt?:()=>void): Promise<T> {
    this.checkAborted();
    if (!this.apiKey) throw new GmgnError('GMGN_API_KEY_MISSING');
    if (!Number.isFinite(weight) || weight < 1 || weight > 100) throw new GmgnError('GMGN_QUERY_INVALID');
    if (scheduling.priority !== undefined && !['background','normal','live_entry'].includes(scheduling.priority))
      throw new GmgnError('GMGN_QUERY_INVALID');
    if (scheduling.queueTimeoutMs !== undefined && (!Number.isFinite(scheduling.queueTimeoutMs) ||
      scheduling.queueTimeoutMs < 1 || scheduling.queueTimeoutMs > MAX_QUEUE_WAIT_MS)) throw new GmgnError('GMGN_QUERY_INVALID');
    const cost = Math.ceil(weight), priority = scheduling.priority ?? 'normal';
    const queueTimeoutMs = Math.floor(scheduling.queueTimeoutMs ?? MAX_QUEUE_WAIT_MS);
    return enqueueScheduled<T>({lane: this.state, priority, expiresAt: Date.now() + queueTimeoutMs, signal: this.signal,interrupt,
      waitMs: () => Math.max(0, this.state.nextAt - this.now()), run: async () => {
      this.checkAborted();
      const now = this.now();
      if (this.state.cooldownUntil > now) {
        throw new GmgnError('GMGN_RATE_LIMITED', this.state.cooldownUntil, now);
      }
      this.checkAborted();
      this.state.lastStartedAt = now;
      this.state.lastCost = cost;
      this.state.nextAt = now + Math.max(this.interval, this.state.observedIntervalMs) * cost;
      return execute();
    }});
  }

  /** Signed execution uses the same cooldown without granting this client write access. */
  recordRateLimit(headers: Headers, payload?: unknown): void {
    this.observePacing(headers);
    this.applyCooldown(headers, payload);
  }

  private async request(path: string, query: Record<string, QueryValue>, signed=false,
    method:'GET'|'POST'='GET',body?:unknown,requestSignal?:AbortSignal): Promise<unknown> {
    const url = new URL(path, HOST);
    const authQuery:Record<string,QueryValue>={...query,timestamp:String(Math.floor(this.now()/1_000)),client_id:randomUUID()};
    for (const [key, value] of Object.entries(authQuery)) {
      if(Array.isArray(value))for(const item of value)url.searchParams.append(key,String(item));
      else url.searchParams.set(key,String(value));
    }
    const bodyText=body===undefined?'':JSON.stringify(body);
    let signature:string|undefined;
    if(signed)try {
      const sorted=Object.keys(authQuery).sort().flatMap(key=>{const value=authQuery[key],encoded=encodeURIComponent(key);
        return Array.isArray(value)?[...value].sort().map(item=>`${encoded}=${encodeURIComponent(item)}`):
          [`${encoded}=${encodeURIComponent(String(value))}`];}).join('&');
      const message=`${path}:${sorted}:${bodyText}:${authQuery.timestamp}`,key=createPrivateKey(this.privateKeyPem!);
      signature=key.asymmetricKeyType==='ed25519'?cryptoSign(null,Buffer.from(message),key).toString('base64'):
        key.asymmetricKeyType==='rsa'?cryptoSign('sha256',Buffer.from(message),{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).toString('base64'):undefined;
      if(!signature)throw new Error('unsupported key');
    }catch {throw new GmgnError('GMGN_AUTH_FAILED');}
    this.checkAborted();
    const controller = new AbortController();
    const signals=[controller.signal,...(this.signal?[this.signal]:[]),...(requestSignal?[requestSignal]:[])];
    const signal=signals.length===1?signals[0]:AbortSignal.any(signals);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GmgnError('GMGN_REQUEST_TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);
    });
    const run = async (): Promise<unknown> => {
      const response = await this.fetcher(url, {
        method, redirect: 'error', credentials: 'omit', signal,
        headers: {'X-APIKEY': this.apiKey!,accept:'application/json',...(signature?{'X-Signature':signature}:{}),
          ...(method==='POST'?{'content-type':'application/json'}:{})},
        ...(method==='POST'?{body:bodyText}:{}),
      });
      // The quota tier can change while the process is running. Learn only the
      // documented numeric limit and update the shared credential lane before
      // releasing it to another queued request.
      this.observePacing(response.headers);
      // Install a cooldown even if the 429 body is missing, malformed or oversized.
      if (response.status === 429) this.applyCooldown(response.headers);
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        throw new GmgnError('GMGN_AUTH_FAILED');
      }
      if (!response.ok && response.status !== 429) {
        void response.body?.cancel().catch(() => {});
        if(response.status===400&&(['/v1/callout/global','/v1/callout/get_record'].includes(path)&&object(body)&&typeof body.page_token==='string'||
          ['/v1/user/wallet_activity','/v1/user/wallet_holdings'].includes(path)&&typeof query.cursor==='string'))
          throw new GmgnError('GMGN_CURSOR_INVALID');
        throw new GmgnError('GMGN_HTTP_ERROR');
      }
      let payload: unknown;
      try {
        const declaredSize = response.headers.get('content-length');
        if (declaredSize && Number(declaredSize) > MAX_RESPONSE_BYTES) {
          void response.body?.cancel().catch(() => {});
          throw new GmgnError('GMGN_RESPONSE_TOO_LARGE');
        }
        if (!response.body) throw new GmgnError('GMGN_RESPONSE_INVALID');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_RESPONSE_BYTES) throw new GmgnError('GMGN_RESPONSE_TOO_LARGE');
            chunks.push(value);
          }
        } catch (error) { void reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        try { payload = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
        catch { throw new GmgnError('GMGN_INVALID_JSON'); }
      } catch (error) {
        if (response.status === 429) throw this.rateError();
        throw error;
      }
      if (response.status === 429 || (object(payload) &&
          (payload.code === 429 || payload.code === '429' ||
           ['RATE_LIMIT_EXCEEDED', 'RATE_LIMIT_BANNED', 'ERROR_RATE_LIMIT_BLOCKED'].includes(String(payload.error))))) {
        this.applyCooldown(response.headers, payload);
        throw this.rateError();
      }
      if (!object(payload) || !Object.hasOwn(payload, 'code')) throw new GmgnError('GMGN_RESPONSE_INVALID');
      if (payload.code !== 0 && payload.code !== '0') throw new GmgnError('GMGN_API_ERROR');
      if (!Object.hasOwn(payload, 'data')) throw new GmgnError('GMGN_RESPONSE_INVALID');
      return payload.data;
    };
    try { return await abortable(Promise.race([run(), timeout]),signal); }
    catch (error) {
      this.checkAborted();
      if (error instanceof GmgnError) throw error;
      if(requestSignal?.aborted)throw new GmgnError('GMGN_REQUEST_ABORTED');
      if (controller.signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)))
        throw new GmgnError('GMGN_REQUEST_TIMEOUT');
      throw new GmgnError('GMGN_REQUEST_FAILED');
    } finally { clearTimeout(timer!); }
  }

  private observePacing(headers: Headers): void {
    const raw = headers.get('x-ratelimit-limit')?.trim();
    if (!raw || !/^[1-9]\d{0,2}$/.test(raw)) return;
    const limit = Number(raw);
    if (!Number.isSafeInteger(limit) || limit > MAX_VALID_RATE_LIMIT) return;
    const observedIntervalMs = Math.min(MAX_OBSERVED_INTERVAL_MS,
      Math.max(MIN_OBSERVED_INTERVAL_MS, Math.ceil(RATE_WINDOW_MS / limit)));
    this.state.observedIntervalMs = observedIntervalMs;
    if (this.state.lastStartedAt === undefined || this.state.lastCost === undefined) return;
    const reservedUntil = this.state.lastStartedAt +
      Math.max(this.interval, observedIntervalMs) * this.state.lastCost;
    this.state.nextAt = Math.max(this.now(), reservedUntil);
  }

  private applyCooldown(headers: Headers, payload?: unknown): void {
    const now = this.now();
    const candidates: number[] = [];
    const addSeconds = (value: unknown) => {
      if ((typeof value === 'string' && value.trim() !== '') || typeof value === 'number') {
        const n = Number(value);
        if (Number.isFinite(n) && n > now / 1_000 && n < 8.64e12) candidates.push(n * 1_000);
      }
    };
    addSeconds(headers.get('x-ratelimit-reset'));
    if (object(payload)) addSeconds(payload.reset_at);
    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const retryDate = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1_000 : Date.parse(retryAfter);
      if (Number.isFinite(retryDate) && retryDate > now && retryDate < 8.64e15) candidates.push(retryDate);
    }
    this.state.cooldownUntil = Math.max(this.state.cooldownUntil, ...(candidates.length ? candidates : [now + 60_000]));
  }
  private rateError(): GmgnError { return new GmgnError('GMGN_RATE_LIMITED', this.state.cooldownUntil, this.now()); }
}
