import {constants, createPrivateKey, randomUUID, sign, type KeyObject} from 'node:crypto';
import bs58 from 'bs58';
import {abortable} from '../http.js';
import type {TestQuoteRequest, TestTradeClient} from './types.js';

const HOST = 'https://openapi.gmgn.ai';
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const SWAP_FIELDS = new Set(['chain', 'from_address', 'input_token', 'output_token', 'input_amount', 'swap_mode',
  'slippage', 'auto_slippage', 'min_output_amount', 'is_anti_mev', 'priority_fee', 'tip_fee',
  'condition_orders', 'sell_ratio_type']);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const nonce = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const positiveInteger = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value);
function address(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 44) return false;
  try {return bs58.decode(value).length === 32;} catch {return false;}
}

export type GmgnTestErrorReason = 'GMGN_TEST_CREDENTIALS_INVALID' | 'GMGN_TEST_REQUEST_INVALID'
  | 'GMGN_TEST_NONCE_REUSED' | 'GMGN_TEST_RATE_LIMITED' | 'GMGN_TEST_REQUEST_TIMEOUT'
  | 'GMGN_TEST_REQUEST_FAILED' | 'GMGN_TEST_RESPONSE_TOO_LARGE' | 'GMGN_TEST_RESPONSE_INVALID'
  | 'GMGN_TEST_HTTP_ERROR' | 'GMGN_TEST_API_ERROR';

/** No upstream text, request body, URL, signature, credentials, or error cause. */
export class GmgnTestError extends Error {
  constructor(readonly reason: GmgnTestErrorReason, readonly httpStatus?: number,
    readonly apiCode?: number, readonly retryAfterMs?: number) {
    super(reason); this.name = 'GmgnTestError';
  }
}

export interface GmgnTestClientOptions {
  apiKey: string; privateKeyPem: string; fetcher?: typeof fetch; minIntervalMs?: number;
}

/** One explicit test client: no environment reads, automatic writes, or request retries. */
export class GmgnTestClient implements TestTradeClient {
  #apiKey: string;
  #key: KeyObject;
  #fetcher: typeof fetch;
  #interval: number;
  #tail: Promise<void> = Promise.resolve();
  #nextAt = 0;
  #cooldownUntil = 0;
  // Request nonces only; durable business-operation deduplication belongs to the test journal.
  #writeNonces = new Set<string>();

  constructor(options: GmgnTestClientOptions) {
    try {
      if (typeof options.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(options.apiKey) ||
          typeof options.privateKeyPem !== 'string' || options.privateKeyPem.length > 32_768)
        throw new Error();
      const key = createPrivateKey(options.privateKeyPem);
      if (key.asymmetricKeyType !== 'ed25519' && key.asymmetricKeyType !== 'rsa') throw new Error();
      this.#key = key; this.#apiKey = options.apiKey;
    } catch {throw new GmgnTestError('GMGN_TEST_CREDENTIALS_INVALID');}
    if (options.minIntervalMs !== undefined && (!Number.isFinite(options.minIntervalMs) ||
        options.minIntervalMs < 0 || options.minIntervalMs > 60_000))
      throw new GmgnTestError('GMGN_TEST_REQUEST_INVALID');
    this.#fetcher = options.fetcher ?? fetch;
    this.#interval = options.minIntervalMs ?? 1_200;
  }

  async quote(request: TestQuoteRequest): Promise<unknown> {
    if (!object(request) || !address(request.wallet) || !address(request.inputToken) || !address(request.outputToken) ||
        !positiveInteger(request.inputAmount) || !Number.isInteger(request.slippagePct) ||
        request.slippagePct < 0 || request.slippagePct > 100)
      throw new GmgnTestError('GMGN_TEST_REQUEST_INVALID');
    return this.schedule('GET', '/v1/trade/quote', {chain: 'sol', from_address: request.wallet,
      input_token: request.inputToken, output_token: request.outputToken,
      input_amount: request.inputAmount, slippage: request.slippagePct}, '', false);
  }

  async swap(body: Record<string, unknown>, clientId: string): Promise<unknown> {
    let serialized: string;
    try {
      serialized = JSON.stringify(body);
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw new Error();
      const snapshot: unknown = JSON.parse(serialized);
      if (!object(snapshot) || snapshot.chain !== 'sol' ||
          (snapshot.swap_mode !== undefined && snapshot.swap_mode !== 'ExactIn') ||
          Object.keys(snapshot).some(key => !SWAP_FIELDS.has(key)) || !address(snapshot.from_address) ||
          !address(snapshot.input_token) || !address(snapshot.output_token) || !positiveInteger(snapshot.input_amount))
        throw new Error();
    } catch {throw new GmgnTestError('GMGN_TEST_REQUEST_INVALID');}
    this.reserveNonce(clientId);
    return this.schedule('POST', '/v1/trade/swap', {}, serialized, true, clientId);
  }

  async query(orderId: string): Promise<unknown> {
    if (!identifier(orderId)) throw new GmgnTestError('GMGN_TEST_REQUEST_INVALID');
    return this.schedule('GET', '/v1/trade/query_order', {chain: 'sol', order_id: orderId}, '', true);
  }

  async strategies(wallet: string, mint: string, type: 'open' | 'history', pageToken?: string): Promise<unknown> {
    if (!address(wallet) || !address(mint) || !['open', 'history'].includes(type) ||
        (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 4_096)))
      throw new GmgnTestError('GMGN_TEST_REQUEST_INVALID');
    const query: Record<string, string | number> = {chain: 'sol', from_address: wallet, base_token: mint,
      group_tag: 'STMix', type, limit: 100};
    if (pageToken !== undefined && pageToken !== '') query.page_token = pageToken;
    return this.schedule('GET', '/v1/trade/strategy/orders', query, '', true);
  }

  async cancel(wallet: string, orderId: string, clientId: string): Promise<unknown> {
    if (!address(wallet) || !identifier(orderId)) throw new GmgnTestError('GMGN_TEST_REQUEST_INVALID');
    this.reserveNonce(clientId);
    // Official StrategyCancelParams requires these three fields. close_sell_model is undocumented.
    return this.schedule('POST', '/v1/trade/strategy/cancel', {},
      JSON.stringify({chain: 'sol', from_address: wallet, order_id: orderId}), true, clientId);
  }

  private reserveNonce(clientId: string): void {
    if (!nonce(clientId)) throw new GmgnTestError('GMGN_TEST_REQUEST_INVALID');
    if (this.#writeNonces.has(clientId)) throw new GmgnTestError('GMGN_TEST_NONCE_REUSED');
    this.#writeNonces.add(clientId);
  }

  private schedule(method: 'GET' | 'POST', path: string, query: Record<string, string | number>,
    body: string, signed: boolean, clientId?: string): Promise<unknown> {
    const operation = this.#tail.then(async () => {
      if (this.#cooldownUntil > Date.now())
        throw new GmgnTestError('GMGN_TEST_RATE_LIMITED', undefined, undefined, this.#cooldownUntil - Date.now());
      const wait = this.#nextAt - Date.now();
      if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
      this.#nextAt = Date.now() + this.#interval;
      return this.request(method, path, query, body, signed, clientId);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async request(method: 'GET' | 'POST', path: string, query: Record<string, string | number>,
    body: string, signed: boolean, clientId?: string): Promise<unknown> {
    // Generate timestamp/signature only after waiting for the queue and minimum interval.
    const timestamp = Math.floor(Date.now() / 1_000);
    const params = {...query, timestamp, client_id: clientId ?? randomUUID()};
    const sortedQuery = Object.entries(params).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
    const url = `${HOST}${path}?${sortedQuery}`;
    const headers: Record<string, string> = {'X-APIKEY': this.#apiKey, accept: 'application/json',
      'content-type': 'application/json'};
    if (signed) {
      try {
        const message = Buffer.from(`${path}:${sortedQuery}:${body}:${timestamp}`);
        headers['X-Signature'] = (this.#key.asymmetricKeyType === 'ed25519'
          ? sign(null, message, this.#key)
          : sign('sha256', message, {key: this.#key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32})).toString('base64');
      } catch {throw new GmgnTestError('GMGN_TEST_CREDENTIALS_INVALID');}
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new GmgnTestError('GMGN_TEST_REQUEST_TIMEOUT')), TIMEOUT_MS);
    const run = async (): Promise<unknown> => {
      const response = await abortable(this.#fetcher(url, {method, headers, signal: controller.signal,
        redirect: 'error', credentials: 'omit', ...(method === 'POST' ? {body} : {})}), controller.signal);
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new GmgnTestError('GMGN_TEST_REQUEST_TIMEOUT');
      }
      if (response.status === 429) this.rateLimit(response.headers);
      let payload: unknown;
      try {payload = await this.readResponse(response, controller.signal);}
      catch (error) {
        if (response.status === 429) throw new GmgnTestError('GMGN_TEST_RATE_LIMITED', 429, undefined,
          Math.max(0, this.#cooldownUntil - Date.now()));
        throw error;
      }
      if (response.status === 429 || object(payload) &&
          (payload.code === 429 || payload.code === '429' ||
           ['RATE_LIMIT_EXCEEDED', 'RATE_LIMIT_BANNED', 'RATE_LIMIT_BANNED_MAX', 'ERROR_RATE_LIMIT_BLOCKED'].includes(String(payload.error)))) {
        this.rateLimit(response.headers, payload);
        throw new GmgnTestError('GMGN_TEST_RATE_LIMITED', response.status, undefined,
          Math.max(0, this.#cooldownUntil - Date.now()));
      }
      if (!response.ok) throw new GmgnTestError('GMGN_TEST_HTTP_ERROR', response.status);
      if (!object(payload) || !Object.hasOwn(payload, 'code')) throw new GmgnTestError('GMGN_TEST_RESPONSE_INVALID');
      if (payload.code !== 0 && payload.code !== '0') {
        const code = typeof payload.code === 'number' && Number.isSafeInteger(payload.code) ? payload.code : undefined;
        throw new GmgnTestError('GMGN_TEST_API_ERROR', response.status, code);
      }
      if (!Object.hasOwn(payload, 'data')) throw new GmgnTestError('GMGN_TEST_RESPONSE_INVALID');
      return payload.data;
    };
    try {return await abortable(run(), controller.signal);}
    catch (error) {
      if (controller.signal.aborted) throw new GmgnTestError('GMGN_TEST_REQUEST_TIMEOUT');
      if (error instanceof GmgnTestError) throw error;
      throw new GmgnTestError('GMGN_TEST_REQUEST_FAILED');
    } finally {clearTimeout(timer);}
  }

  private async readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new GmgnTestError('GMGN_TEST_RESPONSE_TOO_LARGE');
    }
    if (!response.body) throw new GmgnTestError('GMGN_TEST_RESPONSE_INVALID');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const {value, done} = await abortable(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new GmgnTestError('GMGN_TEST_RESPONSE_TOO_LARGE');
        chunks.push(value);
      }
    } catch (error) {void reader.cancel().catch(() => {}); throw error;}
    finally {reader.releaseLock();}
    try {return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));}
    catch {throw new GmgnTestError('GMGN_TEST_RESPONSE_INVALID');}
  }

  private rateLimit(headers: Headers, payload?: unknown): void {
    const now = Date.now(), candidates = [now + 60_000];
    const absolute = [headers.get('x-ratelimit-reset'), object(payload) ? payload.reset_at : undefined];
    for (const value of absolute) {
      if ((typeof value === 'number' || typeof value === 'string' && value.trim() !== '') &&
          Number.isFinite(Number(value)) && Number(value) * 1_000 > now)
        candidates.push(Math.min(now + 86_400_000, Number(value) * 1_000));
    }
    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const until = /^\d+(?:\.\d+)?$/.test(retryAfter) ? now + Number(retryAfter) * 1_000 : Date.parse(retryAfter);
      if (Number.isFinite(until) && until > now) candidates.push(Math.min(now + 86_400_000, until));
    }
    this.#cooldownUntil = Math.max(this.#cooldownUntil, ...candidates);
  }
}
