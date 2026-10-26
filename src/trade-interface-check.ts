import {abortable} from './http.js';

const ROUTES = new Set(['/v1/user/info', '/v1/user/wallet_holdings', '/v1/token/info',
  '/v1/trade/quote', '/v1/trade/strategy/orders']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const atomic = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= (1n << 64n) - 1n;

/** A separate diagnostic transport: even an SDK regression cannot submit an order. */
export function readOnlyGmgnFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    if (url.origin !== 'https://openapi.gmgn.ai' || url.username || url.password ||
        !ROUTES.has(url.pathname) || (init?.method ?? request?.method ?? 'GET').toUpperCase() !== 'GET' ||
        init?.body != null || request?.body != null) throw new Error('PROBE_WRITE_OR_ROUTE_DENIED');
    const signal = AbortSignal.any([AbortSignal.timeout(12_000),
      ...(init?.signal ? [init.signal] : []), ...(request?.signal ? [request.signal] : [])]);
    const response = await abortable(fetcher(input, {...init, method: 'GET', redirect: 'error', credentials: 'omit', signal}), signal);
    if (response.redirected || response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {}); throw new Error('PROBE_REDIRECT_DENIED');
    }
    if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) {
      void response.body?.cancel().catch(() => {}); throw new Error('PROBE_RESPONSE_TOO_LARGE');
    }
    if (!response.body) throw new Error('PROBE_RESPONSE_EMPTY');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const {done, value} = await abortable(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error('PROBE_RESPONSE_TOO_LARGE');
        chunks.push(value);
      }
    } catch (error) {void reader.cancel().catch(() => {}); throw error;}
    finally {reader.releaseLock();}
    return new Response(Buffer.concat(chunks, size), {status: response.status, headers: response.headers});
  };
}

/** Mirrors the execution gate: an indicative price is not an executable quote. */
export function inspectTestQuote(raw: unknown, expected: {input: string; output: string; amount: string; slippage: number}) {
  if (!Number.isInteger(expected.slippage) || expected.slippage < 0 || expected.slippage > 50 ||
      !object(raw) || raw.input_token !== expected.input || raw.output_token !== expected.output ||
      raw.input_amount !== expected.amount || !atomic(raw.input_amount) || !atomic(raw.output_amount) ||
      !atomic(raw.min_output_amount) || typeof raw.slippage !== 'number' || !Number.isInteger(raw.slippage) ||
      raw.slippage < 0 || raw.slippage > expected.slippage) return {status: 'invalid' as const, reason: 'PROBE_QUOTE_INVALID'};
  const output = BigInt(raw.output_amount), minimum = BigInt(raw.min_output_amount);
  if (minimum > output || minimum < output * BigInt(100 - raw.slippage) / 100n)
    return {status: 'invalid' as const, reason: 'PROBE_QUOTE_SLIPPAGE_MISMATCH'};
  return {status: 'available' as const, inputAmount: raw.input_amount, outputAmount: raw.output_amount,
    minimumOutputAmount: raw.min_output_amount, slippage: raw.slippage};
}

/** Upstream prose may contain request data. Persist only bounded diagnostic codes. */
export function safeProbeError(error: unknown) {
  const e = error as Record<string, unknown> | undefined;
  const safe = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : undefined;
  const reasons = new Set(['PROBE_WRITE_OR_ROUTE_DENIED', 'PROBE_REDIRECT_DENIED', 'PROBE_RESPONSE_TOO_LARGE',
    'PROBE_RESPONSE_EMPTY', 'PROBE_QUOTE_INVALID', 'PROBE_QUOTE_SLIPPAGE_MISMATCH']);
  return {status: 'error' as const, httpStatus: Number.isInteger(e?.status) && Number(e?.status) >= 100 && Number(e?.status) <= 599 ? e!.status as number : undefined,
    apiCode: typeof e?.apiCode === 'number' ? Number.isSafeInteger(e.apiCode) ? e.apiCode : undefined : safe(e?.apiCode), apiError: safe(e?.apiError),
    reason: typeof e?.message === 'string' && reasons.has(e.message) ? e.message :
      e?.name === 'TimeoutError' ? 'PROBE_REQUEST_TIMEOUT' : 'PROBE_REQUEST_FAILED'};
}
