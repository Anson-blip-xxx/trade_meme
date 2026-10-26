import {createHash, randomUUID} from 'node:crypto';
import {abortable} from '../http.js';

const HOST = 'https://openapi.gmgn.ai';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_QUEUE_WAIT_MS = 45_000;
const MAX_LIVE_ENTRY_QUEUE = 16;
const MAX_NORMAL_QUEUE = 128;
// Only API-key GET routes verified in the official OpenApiClient. No writes,
// signed wallet routes, arbitrary URL, guessed funding endpoint, or redirects.
const READ_ROUTES = new Map<string, number>([
  ['/v1/token/info', 1], ['/v1/token/security', 1], ['/v1/token/pool_info', 1],
  ['/v1/market/token_top_holders', 5], ['/v1/market/token_top_traders', 5],
  ['/v1/market/token_kline', 2], ['/v1/market/rank', 3], ['/v1/market/search', 1],
  ['/v1/user/kol', 3], ['/v1/user/smartmoney', 3],
  ['/v1/user/wallet_stats', 3], ['/v1/user/wallet_activity', 3],
  ['/v1/user/wallet_token_balance', 2], ['/v1/user/created_tokens', 2],
  ['/v1/user/info', 2], ['/v1/user/follow_tokens', 2], ['/v1/user/follow_token_groups', 2],
  ['/v1/trade/gas_price', 1], ['/v1/trade/quote', 10],
]);

export type GmgnErrorReason = 'GMGN_API_KEY_MISSING' | 'GMGN_PATH_NOT_ALLOWED' | 'GMGN_QUERY_INVALID'
  | 'GMGN_RATE_LIMITED' | 'GMGN_QUEUE_TIMEOUT' | 'GMGN_REQUEST_TIMEOUT' | 'GMGN_REQUEST_FAILED'
  | 'GMGN_RESPONSE_TOO_LARGE' | 'GMGN_RESPONSE_INVALID' | 'GMGN_INVALID_JSON'
  | 'GMGN_REQUEST_ABORTED' | 'GMGN_AUTH_FAILED' | 'GMGN_HTTP_ERROR' | 'GMGN_API_ERROR';

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

interface RateState { nextAt: number; cooldownUntil: number; }
export type GmgnRequestPriority = 'normal' | 'live_entry';
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
  started: boolean;
  settled: boolean;
}
// One process-wide scheduler owns all queues. Requests sharing a credential are
// strictly serial and share weighted pacing/cooldown; separate credentials have
// independent Plus quotas and therefore cannot head-of-line block each other.
const liveEntryQueue: ScheduledRequest<unknown>[] = [];
const normalQueue: ScheduledRequest<unknown>[] = [];
const activeLanes = new Set<RateState>();
let schedulerActive = false;
let schedulerWake: ReturnType<typeof setTimeout> | undefined;

function removeScheduled(job: ScheduledRequest<unknown>): boolean {
  const queue = job.priority === 'live_entry' ? liveEntryQueue : normalQueue;
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
async function drainScheduler(): Promise<void> {
  if (schedulerActive) return;
  schedulerActive = true;
  try {
    for (;;) {
      const now = Date.now();
      pruneQueue(liveEntryQueue, now); pruneQueue(normalQueue, now);
      const live = nextReady(liveEntryQueue);
      const normal = live.job ? {wait: Number.POSITIVE_INFINITY} : nextReady(normalQueue);
      const selected = live.job ?? normal.job;
      if (!selected) {
        const wait = Math.min(live.wait, normal.wait);
        if (Number.isFinite(wait)) schedulerWake = setTimeout(() => {schedulerWake = undefined; kickScheduler();}, wait);
        return;
      }
      removeScheduled(selected); selected.started = true; cleanupScheduled(selected); activeLanes.add(selected.lane);
      void (async () => {
        try {
          const value = await selected.run();
          if (!selected.settled) { selected.settled = true; selected.resolve(value); }
        } catch (error) { rejectScheduled(selected, error); }
        // Let a completed high-priority metadata read enqueue its dependent
        // holder reads before releasing this credential lane to background work.
        await Promise.resolve(); activeLanes.delete(selected.lane); kickScheduler();
      })();
    }
  } finally { schedulerActive = false; }
}
function enqueueScheduled<T>(job: Omit<ScheduledRequest<T>, 'resolve'|'reject'|'started'|'settled'>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const scheduled: ScheduledRequest<T> = {...job, resolve, reject, started: false, settled: false};
    const queue = scheduled.priority === 'live_entry' ? liveEntryQueue : normalQueue;
    pruneQueue(queue as ScheduledRequest<unknown>[], Date.now());
    const capacity = scheduled.priority === 'live_entry' ? MAX_LIVE_ENTRY_QUEUE : MAX_NORMAL_QUEUE;
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
    queue.push(scheduled as ScheduledRequest<unknown>); kickScheduler();
  });
}
const rateStates = new Map<string, RateState>();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface GmgnClientOptions {
  apiKey?: string;
  minIntervalMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}

export class GmgnClient {
  private readonly apiKey?: string;
  private readonly interval: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly state: RateState;
  private readonly signal?: AbortSignal;

  constructor(options: GmgnClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.interval = Number.isFinite(options.minIntervalMs) && options.minIntervalMs! >= 0
      ? Math.min(options.minIntervalMs!, MAX_QUEUE_WAIT_MS) : 1_200;
    this.fetcher = options.fetcher ?? fetch;
    this.signal = options.signal;
    this.now = options.now ?? Date.now;
    const key = createHash('sha256').update(this.apiKey ?? '').digest('hex');
    let state = rateStates.get(key);
    if (!state) { state = {nextAt: 0, cooldownUntil: 0}; rateStates.set(key, state); }
    this.state = state;
  }

  /** An evaluation scope shares the original credential budget and never resets cooldown. */
  withSignal(signal:AbortSignal):GmgnClient {
    return new GmgnClient({apiKey:this.apiKey,minIntervalMs:this.interval,fetcher:this.fetcher,now:this.now,
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

  /** Shared budget only: this does not expose a network write method or credentials. */
  async scheduleRequest<T>(weight: number, execute: () => Promise<T>, scheduling: GmgnScheduleOptions = {}): Promise<T> {
    this.checkAborted();
    if (!this.apiKey) throw new GmgnError('GMGN_API_KEY_MISSING');
    if (!Number.isFinite(weight) || weight < 1 || weight > 100) throw new GmgnError('GMGN_QUERY_INVALID');
    if (scheduling.priority !== undefined && scheduling.priority !== 'normal' && scheduling.priority !== 'live_entry')
      throw new GmgnError('GMGN_QUERY_INVALID');
    if (scheduling.queueTimeoutMs !== undefined && (!Number.isFinite(scheduling.queueTimeoutMs) ||
      scheduling.queueTimeoutMs < 1 || scheduling.queueTimeoutMs > MAX_QUEUE_WAIT_MS)) throw new GmgnError('GMGN_QUERY_INVALID');
    const cost = Math.ceil(weight), priority = scheduling.priority ?? 'normal';
    const queueTimeoutMs = Math.floor(scheduling.queueTimeoutMs ?? MAX_QUEUE_WAIT_MS);
    return enqueueScheduled<T>({lane: this.state, priority, expiresAt: Date.now() + queueTimeoutMs, signal: this.signal,
      waitMs: () => Math.max(0, this.state.nextAt - this.now()), run: async () => {
      this.checkAborted();
      const now = this.now();
      if (this.state.cooldownUntil > now) {
        throw new GmgnError('GMGN_RATE_LIMITED', this.state.cooldownUntil, now);
      }
      this.checkAborted();
      this.state.nextAt = this.now() + this.interval * cost;
      return execute();
    }});
  }

  /** Signed execution uses the same cooldown without granting this client write access. */
  recordRateLimit(headers: Headers, payload?: unknown): void { this.applyCooldown(headers, payload); }

  private async request(path: string, query: Record<string, string | number>): Promise<unknown> {
    const url = new URL(path, HOST);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    url.searchParams.set('timestamp', String(Math.floor(this.now() / 1_000)));
    url.searchParams.set('client_id', randomUUID());
    this.checkAborted();
    const controller = new AbortController();
    const signal=this.signal?AbortSignal.any([controller.signal,this.signal]):controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GmgnError('GMGN_REQUEST_TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);
    });
    const run = async (): Promise<unknown> => {
      const response = await this.fetcher(url, {
        method: 'GET', redirect: 'error', credentials: 'omit', signal,
        headers: {'X-APIKEY': this.apiKey!, accept: 'application/json'},
      });
      // Install a cooldown even if the 429 body is missing, malformed or oversized.
      if (response.status === 429) this.applyCooldown(response.headers);
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        throw new GmgnError('GMGN_AUTH_FAILED');
      }
      if (!response.ok && response.status !== 429) {
        void response.body?.cancel().catch(() => {});
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
      if (controller.signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)))
        throw new GmgnError('GMGN_REQUEST_TIMEOUT');
      throw new GmgnError('GMGN_REQUEST_FAILED');
    } finally { clearTimeout(timer!); }
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
