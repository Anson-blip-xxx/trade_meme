import {constants, createHash, createPrivateKey, randomUUID, sign as cryptoSign} from 'node:crypto';
import {abortable} from '../http.js';

const HOST = 'https://openapi.gmgn.ai';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// The fixed Market Signal request returns up to seven independent 50-row
// groups. Its verified payload is already close to the generic 2 MiB ceiling,
// so give only this route a larger, still bounded allowance.
const MAX_MARKET_SIGNAL_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_QUEUE_WAIT_MS = 45_000;
const MAX_LIVE_ENTRY_QUEUE = 16;
const MAX_SIGNAL_POLL_QUEUE = 8;
const MAX_NORMAL_QUEUE = 128;
const MAX_BACKGROUND_QUEUE = 16;
// A busy normal lane still yields one bounded opportunity to its own archive
// work. This is per credential: unrelated API keys retain independent lanes.
const BACKGROUND_FAIRNESS_INTERVAL_MS = 4_000;
// Once a queued archive job earns its turn, let the current fixed-timeout
// request release the lane. This is capped again by MAX_QUEUE_WAIT_MS below,
// so continuous live-entry traffic still cannot retain a queued job forever.
const BACKGROUND_FAIRNESS_GRACE_MS = REQUEST_TIMEOUT_MS + 1_000;
// Discovery is deliberately lower priority than the one-second Market Signal
// poll, but an always-busy signal lane must not starve it forever. Grant one
// bounded, signal-proof read per credential in this interval. Live entry can
// still interrupt the read immediately.
const DISCOVERY_FAIRNESS_INTERVAL_MS = 30_000;
const DISCOVERY_SIGNAL_PROTECTION_MS = 3_000;
// GMGN documents the plan bucket as weight units refilled per second
// (Free 5/5, Plus 20/20, Pro 50/50). The 350 ms floor is intentionally
// conservative enough for Free even when a route carries multiple units.
const RATE_WINDOW_MS = 1_000;
const MIN_OBSERVED_INTERVAL_MS = 350;
const MAX_OBSERVED_INTERVAL_MS = RATE_WINDOW_MS;
const MAX_VALID_RATE_LIMIT = 100;
// Only fixed read-only routes verified in the official OpenApiClient. No
// writes, arbitrary URL, guessed funding endpoint, or redirects.
const READ_ROUTES = new Map<string, Readonly<{method:'GET'|'POST';weight:number}>>([
  ['/v1/token/info', {method:'GET',weight:1}], ['/v1/token/security', {method:'GET',weight:1}],
  ['/v1/token/pool_info', {method:'GET',weight:1}],
  ['/v1/market/token_top_holders', {method:'GET',weight:5}], ['/v1/market/token_top_traders', {method:'GET',weight:5}],
  ['/v1/market/token_kline', {method:'GET',weight:2}], ['/v1/market/rank', {method:'GET',weight:3}],
  ['/v1/trenches', {method:'POST',weight:2}], ['/v1/market/search', {method:'GET',weight:1}],
  ['/v1/user/kol', {method:'GET',weight:1}], ['/v1/user/smartmoney', {method:'GET',weight:1}],
  ['/v1/user/wallet_stats', {method:'GET',weight:3}], ['/v1/user/wallet_activity', {method:'GET',weight:3}],
  ['/v1/user/wallet_token_balance', {method:'GET',weight:2}], ['/v1/user/created_tokens', {method:'GET',weight:2}],
  ['/v1/user/info', {method:'GET',weight:2}], ['/v1/user/follow_tokens', {method:'GET',weight:3}],
  ['/v1/user/follow_token_groups', {method:'GET',weight:1}], ['/v1/trade/gas_price', {method:'GET',weight:1}],
  ['/v1/trade/quote', {method:'GET',weight:10}],
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
  /** Quota window consumed by an aborted discovery read; urgent work may bypass it. */
  preemptedReadDebtUntil?: number;
  observedIntervalMs: number;
  lastStartedAt?: number;
  lastCost?: number;
  /** Earliest next fairness grant after one protected archive turn starts. */
  nextBackgroundFairAt?: number;
  /** Earliest next bounded turn for disposable Market discovery. */
  nextDiscoveryFairAt?: number;
  /** An earlier disposable read was cut short by Signal and is owed one bounded retry. */
  discoverySignalProtectionPending?: boolean;
  /** Archive work is owed one full turn after a higher-priority interruption. */
  backgroundSignalProtectionPending?: boolean;
}
export type GmgnRequestPriority = 'background' | 'normal' | 'signal_poll' | 'live_entry';
export interface GmgnScheduleOptions {
  priority?: GmgnRequestPriority;
  /** Queue budget only. Network requests retain their own fixed timeout. */
  queueTimeoutMs?: number;
}
const DEFAULT_BACKGROUND_SCHEDULING:GmgnScheduleOptions={priority:'background',queueTimeoutMs:5_000};
interface ScheduledRequest<T> {
  lane: RateState;
  priority: GmgnRequestPriority;
  enqueuedAt: number;
  expiresAt: number;
  signal?: AbortSignal;
  waitMs: () => number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  fairnessTimer?: ReturnType<typeof setTimeout>;
  protectionTimer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
  interrupt?: () => void;
  rollbackPacing?: () => void;
  protectedFromSignalPoll?: boolean;
  interruptedBySignalPoll?: boolean;
  interruptedByLiveEntry?: boolean;
  backgroundFairAt?: number;
  backgroundFairTurn?: boolean;
  extendFairnessPromise?: boolean;
  /** Disposable discovery reads never earn or consume archive fairness. */
  disposableBackground?: boolean;
  started: boolean;
  settled: boolean;
}
// One process-wide scheduler owns all queues. Requests sharing a credential are
// strictly serial and share weighted pacing/cooldown; separate credentials have
// independent Plus quotas and therefore cannot head-of-line block each other.
const liveEntryQueue: ScheduledRequest<unknown>[] = [];
const signalPollQueue: ScheduledRequest<unknown>[] = [];
const normalQueue: ScheduledRequest<unknown>[] = [];
const backgroundQueue: ScheduledRequest<unknown>[] = [];
const activeLanes = new Set<RateState>();
const activeRequests = new Map<RateState,ScheduledRequest<unknown>>();
let schedulerActive = false;
let schedulerWake: ReturnType<typeof setTimeout> | undefined;

function removeScheduled(job: ScheduledRequest<unknown>): boolean {
  const queue = job.priority === 'live_entry' ? liveEntryQueue : job.priority === 'signal_poll' ? signalPollQueue :
    job.priority === 'background' ? backgroundQueue : normalQueue;
  const index = queue.indexOf(job);
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}
function cleanupScheduled(job: ScheduledRequest<unknown>): void {
  if (job.timer) clearTimeout(job.timer);
  if (job.fairnessTimer) clearTimeout(job.fairnessTimer);
  if (job.protectionTimer) clearTimeout(job.protectionTimer);
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
function armQueueExpiry(job: ScheduledRequest<unknown>): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    if (job.started) return;
    const now=Date.now();
    // Under process load the event loop can cross both the four-second fair
    // boundary and the original five-second expiry before either callback is
    // dispatched. Default archive work must atomically claim/extend its earned
    // turn here instead of relying on the fairness timer winning that race.
    if(job.extendFairnessPromise) {
      if(!job.backgroundFairTurn)grantBackgroundFairTurn(job,now);
      if(job.backgroundFairTurn&&job.expiresAt>now) {
        kickScheduler();
        return;
      }
    }
    if (!removeScheduled(job)) return;
    rejectScheduled(job, new GmgnError('GMGN_QUEUE_TIMEOUT'));
    kickScheduler();
  }, Math.max(1, job.expiresAt - Date.now()));
}
function effectiveBackgroundFairAt(job:ScheduledRequest<unknown>):number {
  return Math.max(job.backgroundFairAt ?? job.enqueuedAt + BACKGROUND_FAIRNESS_INTERVAL_MS,
    job.lane.nextBackgroundFairAt ?? Number.NEGATIVE_INFINITY);
}
function laneHasBackgroundFairTurn(job:ScheduledRequest<unknown>):boolean {
  if(backgroundQueue.some(other=>other!==job&&other.lane===job.lane&&other.backgroundFairTurn))return true;
  const active=activeRequests.get(job.lane);
  return active?.priority==='background'&&!active.disposableBackground&&active.protectedFromSignalPoll===true;
}
function grantBackgroundFairTurn(job: ScheduledRequest<unknown>, now: number): boolean {
  if (job.started || job.settled || job.priority !== 'background' || job.backgroundFairTurn ||
      job.disposableBackground ||
      !backgroundQueue.includes(job)) return false;
  const position=backgroundQueue.indexOf(job);
  if(backgroundQueue.slice(0,position).some(earlier=>earlier.lane===job.lane))return false;
  if(now<effectiveBackgroundFairAt(job)||laneHasBackgroundFairTurn(job))return false;
  job.backgroundFairTurn = true;
  // The caller's normal five-second budget establishes eligibility. Once
  // earned, retain that promise long enough for the one active GMGN request to
  // hit its fixed timeout and release the serial credential lane. The absolute
  // scheduler cap prevents an unbounded promise under continuous live work.
  const promisedUntil = Math.min(job.enqueuedAt + MAX_QUEUE_WAIT_MS, now + BACKGROUND_FAIRNESS_GRACE_MS);
  if (job.extendFairnessPromise&&promisedUntil > job.expiresAt) {
    job.expiresAt = promisedUntil;
    armQueueExpiry(job);
  }
  return true;
}
function pruneQueue(queue: ScheduledRequest<unknown>[], now: number): void {
  for (let index = queue.length - 1; index >= 0; index--) {
    const job = queue[index];
    // Cancellation always wins, even if default archive work reached its fair
    // boundary at the same instant.
    if(job.signal?.aborted) {
      queue.splice(index, 1);
      rejectScheduled(job,new GmgnError('GMGN_REQUEST_ABORTED'));
      continue;
    }
    if(job.expiresAt<=now) {
      // A scheduler kick can prune queues before overdue timer callbacks run.
      // Give default archive work the same atomic fair-grant opportunity as its
      // expiry callback; explicit queue budgets remain hard deadlines.
      if(job.extendFairnessPromise) {
        if(!job.backgroundFairTurn)grantBackgroundFairTurn(job,now);
        if(job.backgroundFairTurn&&job.expiresAt>now)continue;
      }
      queue.splice(index,1);
      rejectScheduled(job,new GmgnError('GMGN_QUEUE_TIMEOUT'));
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
function nextReadyBackground(now: number): {
  job?: ScheduledRequest<unknown>; wait: number; contended: boolean; protectedTurn: boolean;
} {
  let wait = Number.POSITIVE_INFINITY;
  let unopposed: ScheduledRequest<unknown> | undefined;
  let fair: ScheduledRequest<unknown> | undefined;
  let discoveryFair: ScheduledRequest<unknown> | undefined;
  for (const job of backgroundQueue) {
    if (activeLanes.has(job.lane)) continue;
    const pacingWait = Math.max(0, job.waitMs());
    if (pacingWait > 0) { wait = Math.min(wait, pacingWait); continue; }
    const signalContended=signalPollQueue.some(signal=>signal.lane===job.lane);
    // Disposable discovery receives one complete but time-bounded turn per
    // credential only when Signal is actually contending (or cut its prior
    // attempt short). Unopposed research neither consumes a slot nor gains a
    // special timeout. This remains separate from durable archive fairness.
    if(job.disposableBackground&&(signalContended||job.lane.discoverySignalProtectionPending) &&
        now>=(job.lane.nextDiscoveryFairAt??Number.NEGATIVE_INFINITY)){
      discoveryFair??=job;
      continue;
    }
    // Once a signal poll has cut an archive request short, the next archive
    // attempt must finish (or hit its own timeout) before more signal polls on
    // this credential. This prevents a 1 s poller from starving persistence.
    if ((!job.disposableBackground && job.lane.backgroundSignalProtectionPending) || job.backgroundFairTurn)
      return {job, wait: 0, contended: true, protectedTurn: true};
    // Signal polling is intentionally above ordinary reads, but it still has
    // to yield one complete archive turn at the same bounded fairness boundary.
    // Otherwise a continuously replenished poll queue can keep the archive
    // request queued until its own five-second budget expires.
    const contended = signalPollQueue.some(signal => signal.lane === job.lane) ||
      normalQueue.some(normal => normal.lane === job.lane);
    if (!contended) { unopposed ??= job; continue; }
    const fairAt = effectiveBackgroundFairAt(job);
    const fairnessWait = Math.max(0, fairAt - now);
    if (fairnessWait === 0) {
      if(grantBackgroundFairTurn(job, now))fair ??= job;
      continue;
    }
    wait = Math.min(wait, fairnessWait);
  }
  // A fairness turn is complete, not merely permission to start. New signal
  // polls may queue behind it but cannot interrupt it; live entry still can.
  if (fair) return {job: fair, wait: 0, contended: true, protectedTurn: true};
  if (discoveryFair) return {job: discoveryFair, wait: 0, contended: true, protectedTurn: true};
  if (unopposed) return {job: unopposed, wait: 0, contended: false, protectedTurn: false};
  return {wait, contended: false, protectedTurn: false};
}
async function drainScheduler(): Promise<void> {
  if (schedulerActive) return;
  schedulerActive = true;
  try {
    for (;;) {
      const now = Date.now();
      pruneQueue(liveEntryQueue, now); pruneQueue(signalPollQueue, now); pruneQueue(normalQueue, now); pruneQueue(backgroundQueue, now);
      const live = nextReady(liveEntryQueue);
      const signal = live.job ? {wait: Number.POSITIVE_INFINITY} : nextReady(signalPollQueue);
      const background = live.job ? {wait: Number.POSITIVE_INFINITY, contended: false, protectedTurn: false} :
        nextReadyBackground(now);
      const normal = live.job || signal.job || background.protectedTurn ? {wait: Number.POSITIVE_INFINITY} : nextReady(normalQueue);
      // A contended background job is selected only at its per-credential
      // fairness boundary. Uncontended background work remains below normal
      // priority; the loop can start it concurrently once other lanes are busy.
      const selected = live.job ?? (background.protectedTurn ? background.job : undefined) ?? signal.job ??
        (background.contended ? background.job : normal.job ?? background.job);
      if (!selected) {
        const wait = Math.min(live.wait, signal.wait, normal.wait, background.wait);
        if (Number.isFinite(wait)) schedulerWake = setTimeout(() => {schedulerWake = undefined; kickScheduler();}, wait);
        return;
      }
      removeScheduled(selected); selected.started = true; cleanupScheduled(selected); activeLanes.add(selected.lane);
      if (selected.priority === 'background') {
        selected.protectedFromSignalPoll = selected === background.job && background.protectedTurn;
        if(selected.protectedFromSignalPoll){
          if(selected.disposableBackground){
            selected.lane.nextDiscoveryFairAt=now+DISCOVERY_FAIRNESS_INTERVAL_MS;
            selected.lane.discoverySignalProtectionPending=false;
            // A slow upstream cannot hold Market Signal for the normal 12 s
            // request timeout. Abort this research read at the explicit bound.
            selected.protectionTimer=setTimeout(()=>{
              if(activeRequests.get(selected.lane)===selected)selected.interrupt?.();
            },DISCOVERY_SIGNAL_PROTECTION_MS);
          }else selected.lane.nextBackgroundFairAt=now+BACKGROUND_FAIRNESS_INTERVAL_MS;
        }
      }
      activeRequests.set(selected.lane,selected);
      void (async () => {
        let completed = false;
        try {
          const value = await selected.run();
          completed = true;
          if (!selected.settled) { selected.settled = true; selected.resolve(value); }
        } catch (error) { rejectScheduled(selected, error); }
        // A protected archive attempt consumes its promised full turn even if
        // its own endpoint fails or times out. Only a live-entry preemption
        // preserves protection for the retry; a bad archive route must not
        // become a permanent blocker for signal polling.
        if (selected.priority === 'background' && !selected.disposableBackground && !selected.interruptedByLiveEntry &&
            (completed || selected.protectedFromSignalPoll))
          selected.lane.backgroundSignalProtectionPending = false;
        // Let a completed high-priority metadata read enqueue its dependent
        // holder reads before releasing this credential lane to background work.
        await Promise.resolve();cleanupScheduled(selected);activeLanes.delete(selected.lane); activeRequests.delete(selected.lane); kickScheduler();
      })();
    }
  } finally { schedulerActive = false; }
}
function enqueueScheduled<T>(job: Omit<ScheduledRequest<T>, 'resolve'|'reject'|'started'|'settled'|'enqueuedAt'>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const enqueuedAt=Date.now();
    const scheduled: ScheduledRequest<T> = {...job,enqueuedAt,resolve,reject,started:false,settled:false,
      ...(job.priority==='background'?{backgroundFairAt:enqueuedAt+BACKGROUND_FAIRNESS_INTERVAL_MS}:{})};
    const queue = scheduled.priority === 'live_entry' ? liveEntryQueue : scheduled.priority === 'signal_poll' ? signalPollQueue :
      scheduled.priority === 'background' ? backgroundQueue : normalQueue;
    pruneQueue(queue as ScheduledRequest<unknown>[], Date.now());
    const capacity = scheduled.priority === 'live_entry' ? MAX_LIVE_ENTRY_QUEUE :
      scheduled.priority === 'signal_poll' ? MAX_SIGNAL_POLL_QUEUE :
      scheduled.priority === 'background' ? MAX_BACKGROUND_QUEUE : MAX_NORMAL_QUEUE;
    // Capacity belongs to the credential lane. One configured account must not
    // reject live work for another account that has its own quota and pacing.
    if (queue.reduce((count,queued)=>count+Number(queued.lane===scheduled.lane),0) >= capacity) {
      reject(new GmgnError('GMGN_QUEUE_TIMEOUT')); return;
    }
    armQueueExpiry(scheduled as ScheduledRequest<unknown>);
    scheduled.abort = () => {
      if (scheduled.started || !removeScheduled(scheduled as ScheduledRequest<unknown>)) return;
      rejectScheduled(scheduled as ScheduledRequest<unknown>, new GmgnError('GMGN_REQUEST_ABORTED'));
      kickScheduler();
    };
    scheduled.signal?.addEventListener('abort', scheduled.abort, {once: true});
    if (scheduled.signal?.aborted) { scheduled.abort(); return; }
    queue.push(scheduled as ScheduledRequest<unknown>);
    if(scheduled.priority==='background'&&!scheduled.disposableBackground)scheduled.fairnessTimer=setTimeout(()=>{
      grantBackgroundFairTurn(scheduled as ScheduledRequest<unknown>,Date.now());
      kickScheduler();
    },BACKGROUND_FAIRNESS_INTERVAL_MS);
    // The first signal poll may preempt archive work. Its retry gets one
    // signal-proof turn, while live entry can always preempt either read lane.
    if(scheduled.priority==='signal_poll'||scheduled.priority==='live_entry') {
      const active=activeRequests.get(scheduled.lane);
      // A typed market-discovery call remains disposable even if a caller
      // supplies an unusual queue priority. Signal polling and live execution
      // always cut it short; only durable archive reads participate in the
      // background fairness contract below.
      if(active?.disposableBackground&&active.interrupt) {
        if(scheduled.priority==='live_entry'){
          active.interruptedByLiveEntry=true;
          active.rollbackPacing?.();
          active.interrupt();
        }else if(!active.protectedFromSignalPoll){
          active.interruptedBySignalPoll=true;
          active.lane.discoverySignalProtectionPending=true;
          active.rollbackPacing?.();
          active.interrupt();
        }
      } else if(active?.priority==='background'&&active.interrupt) {
        if(scheduled.priority==='live_entry') {
          active.interruptedByLiveEntry=true;
          // A live request can always preempt archive work. If that archive was
          // already owed a full turn, preserve the promise for its next attempt.
          if(active.protectedFromSignalPoll)active.lane.backgroundSignalProtectionPending=true;
          active.interrupt();
        } else if(!active.protectedFromSignalPoll&&!active.interruptedBySignalPoll) {
          active.interruptedBySignalPoll=true;
          // Discovery snapshots are disposable and retried on their next
          // scanner cycle. They must not mint the signal-proof retry reserved
          // for durable archive work, otherwise a one-second Market Signal
          // poll can be held behind every consecutive discovery request.
          if(!active.disposableBackground)active.lane.backgroundSignalProtectionPending=true;
          active.interrupt();
        }
      } else if(scheduled.priority==='live_entry'&&active?.priority==='signal_poll') active.interrupt?.();
    }
    kickScheduler();
  });
}
const rateStates = new Map<string, RateState>();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
type QueryValue=string|number|readonly string[];

export type GmgnMarketChain='sol'|'bsc'|'base'|'eth'|'arbitrum'|'hyperevm'|'robinhood'|'arc'|'stable'|'avalanche';
export type GmgnMarketDirection='asc'|'desc';
export type GmgnMarketRange=Readonly<{min?:number;max?:number}>;
export type GmgnMarketRanges<Metric extends string>=Readonly<Partial<Record<Metric,GmgnMarketRange>>>;
export type GmgnTrendingInterval='1m'|'5m'|'1h'|'6h'|'24h';
export type GmgnTrendingOrder='default'|'swaps'|'marketcap'|'history_highest_market_cap'|'liquidity'|'volume'|
  'holder_count'|'smart_degen_count'|'renowned_count'|'gas_fee'|'price'|'change1m'|'change5m'|'change1h'|
  'creation_timestamp';
export type GmgnTrendingFilter='renounced'|'frozen'|'burn'|'token_burnt'|'has_social'|'not_social_dup'|
  'not_image_dup'|'dexscr_update_link'|'not_wash_trading'|'is_internal_market'|'is_out_market'|
  'not_honeypot'|'verified'|'locked';
export type GmgnTrendingRangeMetric='volume'|'liquidity'|'marketcap'|'historyHighestMarketcap'|'swaps'|
  'holderCount'|'gasFee'|'renownedCount'|'smartDegenCount'|'botDegenCount'|'visitingCount'|
  'priceChangePercent'|'insiderRate'|'bundlerRate'|'entrapmentRatio'|'top10HolderRate'|
  'top70SniperHoldRate'|'devTeamHoldRate';
export interface GmgnMarketTrendingOptions {
  interval:GmgnTrendingInterval;
  limit?:number;
  orderBy?:GmgnTrendingOrder;
  direction?:GmgnMarketDirection;
  filters?:readonly GmgnTrendingFilter[];
  /** Platform names are shape-checked, not allowlisted, so newly supported launchpads remain visible. */
  platforms?:readonly string[];
  ranges?:GmgnMarketRanges<GmgnTrendingRangeMetric>;
  /** Token age, not a timestamp. Unit suffix is mandatory. */
  minAge?:`${number}${'m'|'h'|'d'}`;
  /** Token age, not a timestamp. Unit suffix is mandatory. */
  maxAge?:`${number}${'m'|'h'|'d'}`;
}

export type GmgnTrenchesCategory='new_creation'|'near_completion'|'completed';
export type GmgnTrenchesRangeMetric='volume24h'|'netBuy24h'|'swaps24h'|'buys24h'|'sells24h'|
  'visitingCount'|'progress'|'marketcap'|'liquidity'|'holderCount'|'topHolderRate'|'rugRatio'|
  'bundlerRate'|'insiderRatio'|'entrapmentRatio'|'privateVaultHoldRate'|'top70SniperHoldRate'|
  'botCount'|'botDegenRate'|'freshWalletRate'|'totalFee'|'smartDegenCount'|'renownedCount'|
  'creatorBalanceRate'|'creatorCreatedCount'|'creatorCreatedOpenCount'|'creatorCreatedOpenRatio'|
  'xFollower'|'twitterRenameCount'|'tgCallCount';
export interface GmgnMarketTrenchesOptions {
  categories?:readonly GmgnTrenchesCategory[];
  platforms?:readonly string[];
  /** GMGN applies this limit independently to each selected category. */
  limit?:number;
  ranges?:GmgnMarketRanges<GmgnTrenchesRangeMetric>;
  /** Token age. Trenches accepts seconds or minutes. */
  minAge?:`${number}${'s'|'m'}`;
  /** Token age. Trenches accepts seconds or minutes. */
  maxAge?:`${number}${'s'|'m'}`;
}

export type GmgnKlineResolution='30s'|'1m'|'5m'|'15m'|'1h'|'4h'|'1d';
export interface GmgnMarketKlineOptions {
  resolution:GmgnKlineResolution;
  /** Inclusive Unix timestamp in seconds; the GMGN wire format uses milliseconds. */
  from?:number;
  /** Inclusive Unix timestamp in seconds; the GMGN wire format uses milliseconds. */
  to?:number;
}

type RangeKind='nonnegative'|'signed'|'integer'|'ratio';
const MARKET_CHAINS=new Set<GmgnMarketChain>(['sol','bsc','base','eth','arbitrum','hyperevm','robinhood','arc','stable','avalanche']);
const TRENDING_INTERVALS=new Set<GmgnTrendingInterval>(['1m','5m','1h','6h','24h']);
const TRENDING_ORDERS=new Set<GmgnTrendingOrder>(['default','swaps','marketcap','history_highest_market_cap',
  'liquidity','volume','holder_count','smart_degen_count','renowned_count','gas_fee','price','change1m',
  'change5m','change1h','creation_timestamp']);
const TRENDING_SOL_FILTERS=new Set<GmgnTrendingFilter>(['renounced','frozen','burn','token_burnt','has_social',
  'not_social_dup','not_image_dup','dexscr_update_link','not_wash_trading','is_internal_market','is_out_market']);
const TRENDING_EVM_FILTERS=new Set<GmgnTrendingFilter>(['not_honeypot','verified','renounced','locked','token_burnt',
  'has_social','not_social_dup','not_image_dup','dexscr_update_link','is_internal_market','is_out_market']);
const TRENCHES_CATEGORIES=new Set<GmgnTrenchesCategory>(['new_creation','near_completion','completed']);
const KLINE_RESOLUTIONS=new Set<GmgnKlineResolution>(['30s','1m','5m','15m','1h','4h','1d']);
const MARKET_PLATFORM=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOL_MARKET_ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_MARKET_ADDRESS=/^0x[0-9a-f]{40}$/i;
const MAX_MARKET_FILTER_VALUE=1e15,MAX_MARKET_FILTER_COUNT=1e9,MAX_UNIX_SECONDS=8_640_000_000_000;
const TRENDING_RANGE_FIELDS:Readonly<Record<GmgnTrendingRangeMetric,readonly [string,RangeKind]>>={
  volume:['volume','nonnegative'],liquidity:['liquidity','nonnegative'],marketcap:['marketcap','nonnegative'],
  historyHighestMarketcap:['history_highest_marketcap','nonnegative'],swaps:['swaps','integer'],
  holderCount:['holder_count','integer'],gasFee:['gas_fee','nonnegative'],renownedCount:['renowned_count','integer'],
  smartDegenCount:['smart_degen_count','integer'],botDegenCount:['bot_degen_count','integer'],
  visitingCount:['visiting_count','integer'],priceChangePercent:['price_change_percent','signed'],
  insiderRate:['insider_rate','ratio'],bundlerRate:['bundler_rate','ratio'],entrapmentRatio:['entrapment_ratio','ratio'],
  top10HolderRate:['top10_holder_rate','ratio'],top70SniperHoldRate:['top70_sniper_hold_rate','ratio'],
  devTeamHoldRate:['dev_team_hold_rate','ratio'],
};
const TRENCHES_RANGE_FIELDS:Readonly<Record<GmgnTrenchesRangeMetric,readonly [string,RangeKind]>>={
  volume24h:['volume_24h','nonnegative'],netBuy24h:['net_buy_24h','signed'],swaps24h:['swaps_24h','integer'],
  buys24h:['buys_24h','integer'],sells24h:['sells_24h','integer'],visitingCount:['visiting_count','integer'],
  progress:['progress','ratio'],marketcap:['marketcap','nonnegative'],liquidity:['liquidity','nonnegative'],
  holderCount:['holder_count','integer'],topHolderRate:['top_holder_rate','ratio'],rugRatio:['rug_ratio','ratio'],
  bundlerRate:['bundler_rate','ratio'],insiderRatio:['insider_ratio','ratio'],entrapmentRatio:['entrapment_ratio','ratio'],
  privateVaultHoldRate:['private_vault_hold_rate','ratio'],top70SniperHoldRate:['top70_sniper_hold_rate','ratio'],
  botCount:['bot_count','integer'],botDegenRate:['bot_degen_rate','ratio'],freshWalletRate:['fresh_wallet_rate','ratio'],
  totalFee:['total_fee','nonnegative'],smartDegenCount:['smart_degen_count','integer'],
  renownedCount:['renowned_count','integer'],creatorBalanceRate:['creator_balance_rate','ratio'],
  creatorCreatedCount:['creator_created_count','integer'],creatorCreatedOpenCount:['creator_created_open_count','integer'],
  creatorCreatedOpenRatio:['creator_created_open_ratio','ratio'],xFollower:['x_follower','integer'],
  twitterRenameCount:['twitter_rename_count','integer'],tgCallCount:['tg_call_count','integer'],
};

function marketInput():never {throw new GmgnError('GMGN_QUERY_INVALID');}
function strictOptions(value:unknown,allowed:readonly string[]):Record<string,unknown>{
  if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))return marketInput();
  return value;
}
function marketChain(value:unknown):GmgnMarketChain {
  if(typeof value!=='string'||!MARKET_CHAINS.has(value as GmgnMarketChain))return marketInput();
  return value as GmgnMarketChain;
}
function marketAddress(chain:GmgnMarketChain,value:unknown):string {
  if(typeof value!=='string'||!(chain==='sol'?SOL_MARKET_ADDRESS:EVM_MARKET_ADDRESS).test(value))return marketInput();
  return value;
}
function uniqueStrings(value:unknown,max:number,valid:(item:string)=>boolean):string[]|undefined {
  if(value===undefined)return undefined;
  if(!Array.isArray(value)||value.length>max||value.some(item=>typeof item!=='string'||!valid(item)))return marketInput();
  const unique=[...new Set(value as string[])];
  if(unique.length>max)return marketInput();
  return unique;
}
function validRangeValue(value:unknown,kind:RangeKind):value is number {
  if(typeof value!=='number'||!Number.isFinite(value))return false;
  if(kind==='ratio')return value>=0&&value<=1;
  if(kind==='integer')return Number.isSafeInteger(value)&&value>=0&&value<=MAX_MARKET_FILTER_COUNT;
  if(kind==='nonnegative')return value>=0&&value<=MAX_MARKET_FILTER_VALUE;
  return Math.abs(value)<=MAX_MARKET_FILTER_VALUE;
}
function appendMarketRanges(query:Record<string,QueryValue>,value:unknown,
  fields:Readonly<Record<string,readonly [string,RangeKind]>>):void {
  if(value===undefined)return;
  if(!object(value)||Object.keys(value).length>Object.keys(fields).length)return marketInput();
  for(const [metric,raw] of Object.entries(value)){
    const field=fields[metric];
    if(!field||!object(raw)||Object.keys(raw).some(key=>key!=='min'&&key!=='max')||
      !Object.hasOwn(raw,'min')&&!Object.hasOwn(raw,'max'))return marketInput();
    const min=raw.min,max=raw.max;
    if(min!==undefined&&!validRangeValue(min,field[1])||max!==undefined&&!validRangeValue(max,field[1])||
      typeof min==='number'&&typeof max==='number'&&min>max)return marketInput();
    if(typeof min==='number')query[`min_${field[0]}`]=min;
    if(typeof max==='number')query[`max_${field[0]}`]=max;
  }
}
function marketAge(value:unknown,units:readonly string[]):{wire:string;seconds:number}|undefined {
  if(value===undefined)return undefined;
  if(typeof value!=='string'||value.length>24)return marketInput();
  const match=/^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?([smhd])$/.exec(value);
  if(!match||!units.includes(match[1]))return marketInput();
  const amount=Number(value.slice(0,-1)),factor=match[1]==='s'?1:match[1]==='m'?60:match[1]==='h'?3600:86400;
  const seconds=amount*factor;
  if(!Number.isFinite(seconds)||seconds>MAX_UNIX_SECONDS)return marketInput();
  return {wire:value,seconds};
}

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
    const route = READ_ROUTES.get(path);
    if (route?.method !== 'GET') throw new GmgnError('GMGN_PATH_NOT_ALLOWED');
    if (!object(query) || Object.keys(query).length > 40 ||
        Object.entries(query).some(([key, value]) => !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
          ['timestamp', 'client_id'].includes(key) ||
          !['string', 'number'].includes(typeof value) ||
          (typeof value === 'number' && !Number.isFinite(value)) || String(value).length > 2_000) ||
        (weight !== undefined && (!Number.isFinite(weight) || weight < 1 || weight > 100))) {
      throw new GmgnError('GMGN_QUERY_INVALID');
    }
    const safeQuery = {...query};
    const cost = Math.max(route.weight, Math.ceil(weight ?? route.weight));
    return this.scheduleRequest(cost, () => this.request(path, safeQuery), scheduling);
  }

  /** Signed, read-only page of trades made by wallets followed in GMGN. */
  async getFollowWallet(chain:'sol'|'bsc'|'robinhood', limit=100,
    scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown> {
    this.checkAborted();
    if(!this.apiKey)throw new GmgnError('GMGN_API_KEY_MISSING');
    if(!this.privateKeyPem)throw new GmgnError('GMGN_SIGNING_KEY_MISSING');
    if(!['sol','bsc','robinhood'].includes(chain)||!Number.isSafeInteger(limit)||limit<1||limit>100)
      throw new GmgnError('GMGN_QUERY_INVALID');
    return this.backgroundRequest(10,scheduling,signal=>this.request('/v1/trade/follow_wallet',{chain,limit},true,'GET',undefined,signal));
  }

  /** Fixed research feed: exits, CTO, smart-money and platform/KOL calls. */
  async getMemeMarketSignals(chain:'sol'|'bsc'|'robinhood',
    scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown> {
    this.checkAborted();
    if(!this.apiKey)throw new GmgnError('GMGN_API_KEY_MISSING');
    if(!['sol','bsc','robinhood'].includes(chain))throw new GmgnError('GMGN_QUERY_INVALID');
    // GMGN caps each group independently. Keep semantically distinct groups
    // separate or a single busy category can silently crowd out the others.
    return this.backgroundRequest(1,scheduling,signal=>this.request('/v1/market/token_signal',{},false,'POST',
      {chain,groups:[{signal_type:[12]},{signal_type:[20]},{signal_type:[13,19]},
        {signal_type:[6,7]},{signal_type:[10,11]},{signal_type:[17,18,21]},
        // Meme heat and attention signals remain observation-only downstream.
        // Keep them in their own group so they cannot crowd smart/KOL calls
        // out of GMGN's per-group 50-row response cap.
        {signal_type:[1,2,3,4,5,8,9]}]},signal,MAX_MARKET_SIGNAL_RESPONSE_BYTES));
  }

  /** Fixed read-only GMGN swap-activity ranking. */
  async getMarketTrending(chain:GmgnMarketChain,options:GmgnMarketTrendingOptions,
    scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown>{
    this.checkAborted();if(!this.apiKey)throw new GmgnError('GMGN_API_KEY_MISSING');
    const safeChain=marketChain(chain),raw=strictOptions(options,
      ['interval','limit','orderBy','direction','filters','platforms','ranges','minAge','maxAge']);
    if(typeof raw.interval!=='string'||!TRENDING_INTERVALS.has(raw.interval as GmgnTrendingInterval)||
      raw.limit!==undefined&&(!Number.isSafeInteger(raw.limit)||Number(raw.limit)<1||Number(raw.limit)>100)||
      raw.orderBy!==undefined&&(typeof raw.orderBy!=='string'||!TRENDING_ORDERS.has(raw.orderBy as GmgnTrendingOrder))||
      raw.direction!==undefined&&!['asc','desc'].includes(String(raw.direction)))return marketInput();
    const allowedFilters=safeChain==='sol'?TRENDING_SOL_FILTERS:TRENDING_EVM_FILTERS;
    const filters=uniqueStrings(raw.filters,16,item=>allowedFilters.has(item as GmgnTrendingFilter));
    const platforms=uniqueStrings(raw.platforms,32,item=>MARKET_PLATFORM.test(item));
    const minAge=marketAge(raw.minAge,['m','h','d']),maxAge=marketAge(raw.maxAge,['m','h','d']);
    if(minAge&&maxAge&&minAge.seconds>maxAge.seconds)return marketInput();
    const query:Record<string,QueryValue>={chain:safeChain,interval:raw.interval,limit:(raw.limit as number|undefined)??100};
    if(raw.orderBy!==undefined)query.order_by=raw.orderBy as string;
    if(raw.direction!==undefined)query.direction=raw.direction as string;
    if(filters?.length)query.filters=filters;
    if(platforms?.length)query.platforms=platforms;
    if(minAge)query.min_created=minAge.wire;
    if(maxAge)query.max_created=maxAge.wire;
    appendMarketRanges(query,raw.ranges,TRENDING_RANGE_FIELDS);
    return this.backgroundRequest(READ_ROUTES.get('/v1/market/rank')!.weight,scheduling,
      signal=>this.request('/v1/market/rank',query,false,'GET',undefined,signal,MAX_RESPONSE_BYTES),true);
  }

  /** Fixed read-only launchpad lifecycle listing. The server applies current platform defaults when omitted. */
  async getMarketTrenches(chain:GmgnMarketChain,options:GmgnMarketTrenchesOptions={},
    scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown>{
    this.checkAborted();if(!this.apiKey)throw new GmgnError('GMGN_API_KEY_MISSING');
    const safeChain=marketChain(chain),raw=strictOptions(options,
      ['categories','platforms','limit','ranges','minAge','maxAge']);
    if(raw.limit!==undefined&&(!Number.isSafeInteger(raw.limit)||Number(raw.limit)<1||Number(raw.limit)>80))return marketInput();
    let categories:GmgnTrenchesCategory[]=['new_creation','near_completion','completed'];
    if(raw.categories!==undefined){
      const selected=uniqueStrings(raw.categories,3,item=>TRENCHES_CATEGORIES.has(item as GmgnTrenchesCategory));
      if(!selected?.length)return marketInput();
      categories=selected as GmgnTrenchesCategory[];
    }
    const platforms=uniqueStrings(raw.platforms,32,item=>MARKET_PLATFORM.test(item));
    const minAge=marketAge(raw.minAge,['s','m']),maxAge=marketAge(raw.maxAge,['s','m']);
    if(minAge&&maxAge&&minAge.seconds>maxAge.seconds)return marketInput();
    const sectionFields:Record<string,QueryValue>={limit:(raw.limit as number|undefined)??80};
    if(platforms?.length)sectionFields.launchpad_platform=platforms;
    if(minAge)sectionFields.min_created=minAge.wire;
    if(maxAge)sectionFields.max_created=maxAge.wire;
    appendMarketRanges(sectionFields,raw.ranges,TRENCHES_RANGE_FIELDS);
    const section={filters:['offchain','onchain'],launchpad_platform_v2:true,...sectionFields};
    const body:Record<string,unknown>={version:'v2'};
    for(const category of categories)body[category]={...section};
    return this.backgroundRequest(READ_ROUTES.get('/v1/trenches')!.weight,scheduling,
      signal=>this.request('/v1/trenches',{chain:safeChain},false,'POST',body,signal,MAX_RESPONSE_BYTES),true);
  }

  /** Standard-plan K-line data. The Pro-only 1s route is deliberately rejected rather than silently degraded. */
  async getMarketKline(chain:GmgnMarketChain,address:string,options:GmgnMarketKlineOptions,
    scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown>{
    this.checkAborted();if(!this.apiKey)throw new GmgnError('GMGN_API_KEY_MISSING');
    const safeChain=marketChain(chain),safeAddress=marketAddress(safeChain,address),raw=strictOptions(options,
      ['resolution','from','to']);
    if(typeof raw.resolution!=='string'||!KLINE_RESOLUTIONS.has(raw.resolution as GmgnKlineResolution))return marketInput();
    for(const value of [raw.from,raw.to])if(value!==undefined&&
      (!Number.isSafeInteger(value)||Number(value)<0||Number(value)>MAX_UNIX_SECONDS))return marketInput();
    if(typeof raw.from==='number'&&typeof raw.to==='number'&&raw.from>raw.to)return marketInput();
    const query:Record<string,QueryValue>={chain:safeChain,address:safeAddress,resolution:raw.resolution};
    // The public CLI accepts Unix seconds but its OpenAPI client sends
    // milliseconds. Keep this boundary explicit so callers cannot mix units.
    if(typeof raw.from==='number')query.from=raw.from*1_000;
    if(typeof raw.to==='number')query.to=raw.to*1_000;
    return this.backgroundRequest(READ_ROUTES.get('/v1/market/token_kline')!.weight,scheduling,
      signal=>this.request('/v1/market/token_kline',query,false,'GET',undefined,signal,MAX_RESPONSE_BYTES),true);
  }

  /** Latest or cursor page from GMGN's read-only global call-out feed. */
  async getCalloutGlobal(chains:readonly ('sol'|'bsc'|'robinhood')[],options:{limit?:number;pageToken?:string;
    onlyDeclaration?:boolean}={},scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown>{
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
    scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown>{
    const safe=this.wallets(chain,wallets,20);
    return this.backgroundRequest(3,scheduling,signal=>this.request('/v1/user/wallet_stats',
      {chain,wallet_address:safe,period},false,'GET',undefined,signal));
  }

  async getWalletProfits(chain:'sol'|'bsc'|'robinhood',wallets:readonly string[],period:'1d'|'7d'|'30d'|'all'='all',
    scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown>{
    const safe=this.wallets(chain,wallets,100);
    return this.backgroundRequest(3,scheduling,signal=>this.request('/v1/user/wallet_profits',{},false,'POST',
      {chain,period,wallet_addresses:safe},signal));
  }

  async getWalletActivity(chain:'sol'|'bsc'|'robinhood',wallet:string,cursor?:string,
    scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown>{
    const [safe]=this.wallets(chain,[wallet],1);
    if(cursor!==undefined&&!/^[\x21-\x7e]{1,512}$/.test(cursor))throw new GmgnError('GMGN_QUERY_INVALID');
    return this.backgroundRequest(3,scheduling,signal=>this.request('/v1/user/wallet_activity',
      {chain,wallet_address:safe,limit:50,...(cursor?{cursor}:{})},false,'GET',undefined,signal));
  }

  async getWalletHoldings(chain:'sol'|'bsc'|'robinhood',wallet:string,
    options:{limit?:number;cursor?:string;closedOnly?:boolean}={},
    scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown>{
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
    scheduling:GmgnScheduleOptions=DEFAULT_BACKGROUND_SCHEDULING):Promise<unknown>{
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

  private backgroundRequest<T>(weight:number,scheduling:GmgnScheduleOptions,run:(signal:AbortSignal)=>Promise<T>,
    disposableBackground=false):Promise<T>{
    const controller=new AbortController();
    return this.scheduleRequest(weight,()=>run(controller.signal),scheduling,()=>controller.abort(),
      !disposableBackground&&scheduling===DEFAULT_BACKGROUND_SCHEDULING,disposableBackground);
  }

  /** Shared budget only: this does not expose a network write method or credentials. */
  async scheduleRequest<T>(weight: number, execute: () => Promise<T>, scheduling: GmgnScheduleOptions = {},
    interrupt?:()=>void,extendFairnessPromise=false,disposableBackground=false): Promise<T> {
    this.checkAborted();
    if (!this.apiKey) throw new GmgnError('GMGN_API_KEY_MISSING');
    if (!Number.isFinite(weight) || weight < 1 || weight > 100) throw new GmgnError('GMGN_QUERY_INVALID');
    if (scheduling.priority !== undefined && !['background','normal','signal_poll','live_entry'].includes(scheduling.priority))
      throw new GmgnError('GMGN_QUERY_INVALID');
    if (scheduling.queueTimeoutMs !== undefined && (!Number.isFinite(scheduling.queueTimeoutMs) ||
      scheduling.queueTimeoutMs < 1 || scheduling.queueTimeoutMs > MAX_QUEUE_WAIT_MS)) throw new GmgnError('GMGN_QUERY_INVALID');
    const cost = Math.ceil(weight), priority = scheduling.priority ?? 'normal';
    const queueTimeoutMs = Math.floor(scheduling.queueTimeoutMs ?? MAX_QUEUE_WAIT_MS);
    let pacingReservation:Readonly<{previousNextAt:number;reservedNextAt:number;previousStartedAt?:number;
      previousCost?:number;startedAt:number}>|undefined;
    const rollbackPacing=disposableBackground?()=>{
      const reservation=pacingReservation;
      if(!reservation||this.state.lastStartedAt!==reservation.startedAt||this.state.lastCost!==cost)return;
      // The request has already reached GMGN and may have consumed quota even
      // though its response is discarded. Urgent signal/execution work can use
      // the remaining Free-tier unit immediately, while every ordinary read
      // keeps respecting the original weighted reservation. If response
      // headers lengthened this request's reservation, retain that too.
      this.state.preemptedReadDebtUntil=Math.max(this.state.preemptedReadDebtUntil??0,
        reservation.reservedNextAt,this.state.nextAt);
      // cooldownUntil is deliberately independent and is never reduced. The
      // active-request identity guard prevents this disposable request from
      // undoing pacing reserved by any later operation on the shared key.
      this.state.nextAt=reservation.previousNextAt;
      this.state.lastStartedAt=reservation.previousStartedAt;
      this.state.lastCost=reservation.previousCost;
      pacingReservation=undefined;
    }:undefined;
    return enqueueScheduled<T>({lane:this.state,priority,expiresAt:Date.now()+queueTimeoutMs,signal:this.signal,interrupt,
      rollbackPacing,extendFairnessPromise,disposableBackground,
      waitMs: () => Math.max(0, Math.max(this.state.nextAt,
        priority==='signal_poll'||priority==='live_entry'?0:this.state.preemptedReadDebtUntil??0)-this.now()), run: async () => {
      this.checkAborted();
      const now = this.now();
      if (this.state.cooldownUntil > now) {
        throw new GmgnError('GMGN_RATE_LIMITED', this.state.cooldownUntil, now);
      }
      this.checkAborted();
      const previousNextAt=this.state.nextAt,previousStartedAt=this.state.lastStartedAt,previousCost=this.state.lastCost,
        reservedNextAt=now+Math.max(this.interval,this.state.observedIntervalMs)*cost;
      this.state.lastStartedAt=now;
      this.state.lastCost=cost;
      this.state.nextAt=reservedNextAt;
      if(disposableBackground)pacingReservation={previousNextAt,reservedNextAt,previousStartedAt,previousCost,startedAt:now};
      return execute();
    }});
  }

  /** Signed execution uses the same cooldown without granting this client write access. */
  recordRateLimit(headers: Headers, payload?: unknown): void {
    this.observePacing(headers);
    this.applyCooldown(headers, payload);
  }

  private async request(path: string, query: Record<string, QueryValue>, signed=false,
    method:'GET'|'POST'='GET',body?:unknown,requestSignal?:AbortSignal,
    maxResponseBytes=MAX_RESPONSE_BYTES): Promise<unknown> {
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
        if (declaredSize && Number(declaredSize) > maxResponseBytes) {
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
            if (length > maxResponseBytes) throw new GmgnError('GMGN_RESPONSE_TOO_LARGE');
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
