import {createHash, randomUUID} from 'node:crypto';

const HOST = 'https://openapi.gmgn.ai';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_QUEUE_WAIT_MS = 45_000;
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
  | 'GMGN_AUTH_FAILED' | 'GMGN_HTTP_ERROR' | 'GMGN_API_ERROR';

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
// One process-wide request queue. Clients with the same credential also share
// weighted pacing and cooldown, even when constructed by different providers.
let requestTail: Promise<void> = Promise.resolve();
const rateStates = new Map<string, RateState>();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface GmgnClientOptions {
  apiKey?: string;
  minIntervalMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
}

export class GmgnClient {
  private readonly apiKey?: string;
  private readonly interval: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly state: RateState;

  constructor(options: GmgnClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.interval = Number.isFinite(options.minIntervalMs) && options.minIntervalMs! >= 0
      ? Math.min(options.minIntervalMs!, MAX_QUEUE_WAIT_MS) : 1_200;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    const key = createHash('sha256').update(this.apiKey ?? '').digest('hex');
    let state = rateStates.get(key);
    if (!state) { state = {nextAt: 0, cooldownUntil: 0}; rateStates.set(key, state); }
    this.state = state;
  }

  /** Epoch milliseconds; allows pollers to skip work until the shared reset. */
  get cooldownUntil(): number { return this.state.cooldownUntil; }

  async get(path: string, query: Record<string, string | number>, weight?: number): Promise<unknown> {
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
    return this.scheduleRequest(cost, () => this.request(path, safeQuery));
  }

  /** Shared budget only: this does not expose a network write method or credentials. */
  async scheduleRequest<T>(weight: number, execute: () => Promise<T>): Promise<T> {
    if (!this.apiKey) throw new GmgnError('GMGN_API_KEY_MISSING');
    if (!Number.isFinite(weight) || weight < 1 || weight > 100) throw new GmgnError('GMGN_QUERY_INVALID');
    const cost = Math.ceil(weight);
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new GmgnError('GMGN_QUEUE_TIMEOUT')); }, MAX_QUEUE_WAIT_MS);
    });
    const operation = requestTail.then(async () => {
      if (expired) throw new GmgnError('GMGN_QUEUE_TIMEOUT');
      const now = this.now();
      if (this.state.cooldownUntil > now) {
        throw new GmgnError('GMGN_RATE_LIMITED', this.state.cooldownUntil, now);
      }
      const wait = Math.max(0, this.state.nextAt - now);
      if (wait >= MAX_QUEUE_WAIT_MS) throw new GmgnError('GMGN_QUEUE_TIMEOUT', this.state.nextAt, now);
      if (wait) await sleep(wait);
      if (expired) throw new GmgnError('GMGN_QUEUE_TIMEOUT');
      clearTimeout(timer);
      this.state.nextAt = this.now() + this.interval * cost;
      return execute();
    });
    requestTail = operation.then(() => undefined, () => undefined);
    try { return await Promise.race([operation, timeout]); }
    finally { clearTimeout(timer!); }
  }

  /** Signed execution uses the same cooldown without granting this client write access. */
  recordRateLimit(headers: Headers, payload?: unknown): void { this.applyCooldown(headers, payload); }

  private async request(path: string, query: Record<string, string | number>): Promise<unknown> {
    const url = new URL(path, HOST);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    url.searchParams.set('timestamp', String(Math.floor(this.now() / 1_000)));
    url.searchParams.set('client_id', randomUUID());
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GmgnError('GMGN_REQUEST_TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);
    });
    const run = async (): Promise<unknown> => {
      const response = await this.fetcher(url, {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
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
    try { return await Promise.race([run(), timeout]); }
    catch (error) {
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
