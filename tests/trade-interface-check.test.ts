import test from 'node:test';
import assert from 'node:assert/strict';
import {readOnlyGmgnFetch, inspectTestQuote, safeProbeError} from '../src/trade-interface-check.js';

const host = 'https://openapi.gmgn.ai';
const input = 'So11111111111111111111111111111111111111112';
const output = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const expected = {input, output, amount: '1000000', slippage: 1};
const quote = {input_token: input, output_token: output, input_amount: '1000000',
  output_amount: '100000', min_output_amount: '99000', slippage: 1};
const rejection = (reason: string) => (error: unknown) => error instanceof Error && error.message === reason;

test('diagnostic transport rejects writes, bodies, credentials and routes before network I/O', async () => {
  let calls = 0;
  const run = readOnlyGmgnFetch(async () => {calls++; return new Response('{}');});
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    await assert.rejects(run(host + '/v1/trade/quote', {method}), rejection('PROBE_WRITE_OR_ROUTE_DENIED'));
  for (const route of ['/v1/trade/swap', '/v1/trade/strategy/create', '/v1/trade/strategy/cancel',
    '/v1/trade/query_order', '/v1/token/info/'])
    await assert.rejects(run(host + route), rejection('PROBE_WRITE_OR_ROUTE_DENIED'));
  for (const url of ['http://openapi.gmgn.ai/v1/token/info', 'https://evil.test/v1/token/info',
    'https://openapi.gmgn.ai:8443/v1/token/info', 'https://user:password@openapi.gmgn.ai/v1/token/info'])
    await assert.rejects(run(url), rejection('PROBE_WRITE_OR_ROUTE_DENIED'));
  await assert.rejects(run(host + '/v1/token/info', {body: ''}), rejection('PROBE_WRITE_OR_ROUTE_DENIED'));
  const request = new Request(host + '/v1/token/info', {method: 'POST', body: '{}'});
  await assert.rejects(run(request), rejection('PROBE_WRITE_OR_ROUTE_DENIED'));
  await assert.rejects(run(request, {method: 'GET'}), rejection('PROBE_WRITE_OR_ROUTE_DENIED'));
  assert.equal(calls, 0);
});

test('allowed diagnostics force GET, omit credentials and disallow redirect following', async () => {
  let calls = 0;
  const run = readOnlyGmgnFetch(async (url, init) => {
    calls++;
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('x-apikey'), 'test-key');
    return new Response('{"code":0,"data":{"list":[]}}', {headers: {'x-ratelimit-reset': '1900000000'}});
  });
  for (const route of ['/v1/user/info', '/v1/user/wallet_holdings', '/v1/token/info',
    '/v1/trade/quote', '/v1/trade/strategy/orders']) {
    const result = await run(host + route + '?chain=sol', {method: 'get', redirect: 'follow',
      credentials: 'include', headers: {'X-APIKEY': 'test-key'}});
    assert.deepEqual(await result.json(), {code: 0, data: {list: []}});
    assert.equal(result.headers.get('x-ratelimit-reset'), '1900000000');
  }
  assert.equal(calls, 5);
});

test('redirect responses cannot be interpreted as authenticated success', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const run = readOnlyGmgnFetch(async () => new Response('{"code":0,"data":{}}',
      {status, headers: {location: 'https://evil.test/'}}));
    await assert.rejects(run(host + '/v1/user/info'), rejection('PROBE_REDIRECT_DENIED'));
  }
  const redirected = new Response('{}');
  Object.defineProperty(redirected, 'redirected', {value: true});
  await assert.rejects(readOnlyGmgnFetch(async () => redirected)(host + '/v1/user/info'),
    rejection('PROBE_REDIRECT_DENIED'));
});

test('response bounds apply to both declared and streamed sizes, and empty bodies are rejected', async () => {
  for (const response of [new Response('{}', {headers: {'content-length': String(2 * 1024 * 1024 + 1)}}),
    new Response(new Uint8Array(2 * 1024 * 1024 + 1))])
    await assert.rejects(readOnlyGmgnFetch(async () => response)(host + '/v1/user/info'),
      rejection('PROBE_RESPONSE_TOO_LARGE'));
  await assert.rejects(readOnlyGmgnFetch(async () => new Response(null))(host + '/v1/user/info'),
    rejection('PROBE_RESPONSE_EMPTY'));
});

test('HTTP authentication and rate limit evidence survives the read-only transport for safe classification', async () => {
  for (const status of [401, 403, 429, 500]) {
    const response = await readOnlyGmgnFetch(async () => new Response('{"code":429,"error":"RATE_LIMIT_BANNED"}',
      {status, headers: {'retry-after': '30'}}))(host + '/v1/user/info');
    assert.equal(response.status, status);
    assert.equal(response.headers.get('retry-after'), '30');
    assert.equal((await response.json()).error, 'RATE_LIMIT_BANNED');
  }
});

test('quote inspection requires exact token identities, atomic amounts and explicit bounded slippage', () => {
  assert.deepEqual(inspectTestQuote(quote, expected), {status: 'available', inputAmount: '1000000',
    outputAmount: '100000', minimumOutputAmount: '99000', slippage: 1});
  for (const patch of [{input_token: output}, {output_token: input}, {output_token: output.toLowerCase()},
    {input_amount: '1000001'}, {input_amount: 1000000}, {output_amount: 100000}, {min_output_amount: 99000},
    {output_amount: '0'}, {output_amount: '-1'}, {output_amount: '01'}, {output_amount: '1.0'},
    {output_amount: '1e5'}, {output_amount: '18446744073709551616'}, {slippage: '1'}, {slippage: 1.5},
    {slippage: -1}, {slippage: 2}, {slippage: NaN}, {min_output_amount: undefined}])
    assert.equal(inspectTestQuote({...quote, ...patch}, expected).status, 'invalid', JSON.stringify(patch));
  for (const slippage of [NaN, Infinity, -1, 51, 0.5])
    assert.equal(inspectTestQuote(quote, {...expected, slippage}).status, 'invalid');
  for (const value of [null, undefined, [], 'quote', 1])
    assert.equal(inspectTestQuote(value, expected).status, 'invalid');
});

test('quote comparison uses exact bigint arithmetic past the safe-number boundary', () => {
  const amount = '18446744073709551615';
  const minimum = (BigInt(amount) * 99n / 100n).toString();
  const result = inspectTestQuote({...quote, input_amount: amount, output_amount: amount,
    min_output_amount: minimum}, {...expected, amount});
  assert.equal(result.status, 'available');
  assert.equal(result.inputAmount, amount);
  assert.equal(result.minimumOutputAmount, minimum);
  assert.equal(inspectTestQuote({...quote, output_amount: amount,
    min_output_amount: (BigInt(minimum) - 1n).toString()}, expected).reason, 'PROBE_QUOTE_SLIPPAGE_MISMATCH');
});

test('quote minimum cannot exceed output or silently widen slippage', () => {
  for (const minimum of ['100001', '98999'])
    assert.equal(inspectTestQuote({...quote, min_output_amount: minimum}, expected).reason,
      'PROBE_QUOTE_SLIPPAGE_MISMATCH');
  assert.equal(inspectTestQuote({...quote, slippage: 0, min_output_amount: '99999'}, expected).status, 'invalid');
  assert.equal(inspectTestQuote({...quote, slippage: 0, min_output_amount: '100000'}, expected).status, 'available');
});

test('error summaries preserve bounded diagnostic codes while dropping prose, URLs and arbitrary properties', () => {
  const error = {status: 403, apiCode: 403, apiError: 'PLAN_UPGRADE_REQUIRED',
    message: 'https://secret.test/?key=token-secret', request: {apiKey: 'token-secret'}, stack: 'private-stack',
    apiMessage: 'authorization=hidden', signature: 'secret-signature'};
  assert.deepEqual(safeProbeError(error), {status: 'error', httpStatus: 403, apiCode: 403,
    apiError: 'PLAN_UPGRADE_REQUIRED', reason: 'PROBE_REQUEST_FAILED'});
  const serialized = JSON.stringify(safeProbeError(error));
  for (const value of ['secret', 'private', 'hidden', 'authorization', 'signature']) assert.ok(!serialized.includes(value));
  assert.equal(safeProbeError(new Error('PROBE_REDIRECT_DENIED')).reason, 'PROBE_REDIRECT_DENIED');
  assert.equal(safeProbeError(new Error('AN_ARBITRARY_UPPERCASE_SECRET')).reason, 'PROBE_REQUEST_FAILED');
  assert.equal(safeProbeError(new DOMException('private timeout details', 'TimeoutError')).reason, 'PROBE_REQUEST_TIMEOUT');
});

test('error summaries reject malformed codes and invalid numeric status fields', () => {
  for (const value of [null, undefined, 'token-secret', 1, new Error('token-secret')])
    assert.equal(safeProbeError(value).reason, 'PROBE_REQUEST_FAILED');
  for (const status of [NaN, Infinity, -1, 99, 600, 200.1, '403']) assert.equal(safeProbeError({status}).httpStatus, undefined);
  for (const apiCode of [NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1, 'secret-key', 'WITH SPACE', 'A'.repeat(101)])
    assert.equal(safeProbeError({apiCode}).apiCode, undefined);
  assert.equal(safeProbeError({apiError: 'Bearer private-token'}).apiError, undefined);
});
