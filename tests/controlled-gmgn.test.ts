import test from 'node:test';
import assert from 'node:assert/strict';
import {constants, generateKeyPairSync, randomUUID, verify} from 'node:crypto';
import {inspect} from 'node:util';
import {GmgnTestClient, GmgnTestError, type GmgnTestErrorReason} from '../src/controlled-test/gmgn.js';
import {ControlledTestJournal} from '../src/controlled-test/journal.js';
import {ControlledTradeRunner, newTestRun, TEST_CONDITIONS, TEST_INPUT, TEST_MINT} from '../src/controlled-test/runner.js';
import type {TestQuoteRequest} from '../src/controlled-test/types.js';

// Generated fixture credentials only. All clients inject a mock fetcher; these tests make no API calls.
const keys = generateKeyPairSync('ed25519');
const pem = keys.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
const apiKey = 'test-only-secret-api-key';
const wallet = '11111111111111111111111111111111';
const sol = 'So11111111111111111111111111111111111111112';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const quote: TestQuoteRequest = {wallet, inputToken: sol, outputToken: mint, inputAmount: '10000000', slippagePct: 1};
const body = (): Record<string, unknown> => ({chain: 'sol', from_address: wallet, input_token: sol,
  output_token: mint, input_amount: '10000000', slippage: 1, priority_fee: '0.00001', tip_fee: '0.00001',
  is_anti_mev: true, sell_ratio_type: 'hold_amount', condition_orders: [
    {order_type: 'profit_stop', side: 'sell', price_scale: '100', sell_ratio: '50'},
    {order_type: 'loss_stop', side: 'sell', price_scale: '60', sell_ratio: '100'},
  ]});
const success = (data: unknown = {}) => Response.json({code: 0, data});
const client = (fetcher: typeof fetch, minIntervalMs = 0) =>
  new GmgnTestClient({apiKey, privateKeyPem: pem, fetcher, minIntervalMs});
const reason = (expected: GmgnTestErrorReason) => (error: unknown) =>
  error instanceof GmgnTestError && error.reason === expected;
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {promise: new Promise<T>(r => {resolve = r;}), resolve: (value: T) => resolve(value)};
}
async function flush() {await new Promise(resolve => setImmediate(resolve));}
function assertSignature(input: string | URL | Request, init: RequestInit | undefined) {
  const url = new URL(String(input)), headers = new Headers(init?.headers);
  const message = `${url.pathname}:${url.search.slice(1)}:${init?.body ?? ''}:${url.searchParams.get('timestamp')}`;
  assert.equal(verify(null, Buffer.from(message), keys.publicKey, Buffer.from(headers.get('X-Signature')!, 'base64')), true);
}

test('controlled quote uses only the fixed official host, API-key auth and exact quote arguments', async () => {
  let calls = 0;
  const raw = {input_amount: '10000000', output_amount: '12345', min_output_amount: '12000'};
  const gmgn = client(async (input, init) => {
    calls++;
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    assert.equal(url.origin, 'https://openapi.gmgn.ai'); assert.equal(url.pathname, '/v1/trade/quote');
    assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.equal(headers.get('X-APIKEY'), apiKey); assert.equal(headers.has('X-Signature'), false);
    const params = Object.fromEntries(url.searchParams);
    assert.match(params.client_id, /^[0-9a-f-]{36}$/); assert.match(params.timestamp, /^\d+$/);
    delete params.client_id; delete params.timestamp;
    assert.deepEqual(params, {chain: 'sol', from_address: wallet, input_token: sol, output_token: mint,
      input_amount: '10000000', slippage: '1'});
    return success(raw);
  });
  assert.deepEqual(await gmgn.quote(quote), raw); assert.equal(calls, 1);
  assert.equal(JSON.stringify(gmgn).includes(apiKey), false);
  assert.equal(inspect(gmgn, {showHidden: true}).includes(apiKey), false);
  assert.equal(inspect(gmgn, {showHidden: true}).includes('PRIVATE KEY'), false);
});

test('controlled swap snapshots its body, signs the transmitted bytes and sends a supplied nonce once', async () => {
  const clientId = randomUUID(), request = body(), original = structuredClone(request);
  let calls = 0;
  const gmgn = client(async (input, init) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.pathname, '/v1/trade/swap'); assert.equal(init?.method, 'POST');
    assert.equal(url.searchParams.get('client_id'), clientId);
    assert.deepEqual(JSON.parse(String(init?.body)), original);
    assertSignature(input, init);
    return success({order_id: 'buy-order', strategy_order_id: 'strategy-order'});
  });
  const pending = gmgn.swap(request, clientId);
  request.input_amount = '999999999';
  (request.condition_orders as Record<string, unknown>[])[0].sell_ratio = '100';
  assert.deepEqual(await pending, {order_id: 'buy-order', strategy_order_id: 'strategy-order'});
  await assert.rejects(gmgn.swap(body(), clientId), reason('GMGN_TEST_NONCE_REUSED'));
  await assert.rejects(gmgn.cancel(wallet, 'strategy-order', clientId), reason('GMGN_TEST_NONCE_REUSED'));
  assert.equal(calls, 1);
});

test('actual controlled runner buy reaches signed transport with ExactIn, fees, minimum and both exit conditions intact', async () => {
  const journal = new ControlledTestJournal(':memory:');
  const run = newTestRun(wallet); journal.create(run);
  const submissions: Record<string, unknown>[] = [];
  const gmgn = client(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/trade/quote') return success({
      input_token: url.searchParams.get('input_token'), output_token: url.searchParams.get('output_token'),
      input_amount: url.searchParams.get('input_amount'), output_amount: '1000000', min_output_amount: '990000', slippage: 1,
    });
    assertSignature(input, init);
    if (url.pathname === '/v1/trade/strategy/orders') return success({list: [], next_page_token: ''});
    if (url.pathname === '/v1/trade/swap') {
      assert.equal(init?.method, 'POST');
      submissions.push(JSON.parse(String(init?.body)));
      return success({order_id: 'mock-buy-order'});
    }
    assert.equal(url.pathname, '/v1/trade/query_order');
    // Stop the mock run after submission; this integration test verifies the real request-building path only.
    return success({order_id: 'mock-buy-order', status: 'failed'});
  });
  const runner = new ControlledTradeRunner({journal, client: gmgn, notifier: {notify: async () => {}},
    sleep: async () => {}, pollAttempts: 1, chain: {
      snapshot: async () => ({wallet, mint: TEST_MINT, nativeLamports: '1000000000', tokenAmount: '0', decimals: 5,
        slot: 1, nativeSlot: 1, mintAuthority: null, freezeAuthority: null,
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', extensions: [], checkedAt: new Date().toISOString()}),
      verifyTransaction: async () => {throw new Error('No transaction should need verification in this mock case');},
    }});
  try {
    const result = await runner.execute(run.id);
    assert.equal(result.phase, 'needs_attention'); assert.ok(result.reasons.includes('TEST_TRADE_FAILED'));
    assert.deepEqual(submissions, [{chain: 'sol', from_address: wallet, input_token: TEST_INPUT,
      output_token: TEST_MINT, input_amount: '10000000', swap_mode: 'ExactIn', min_output_amount: '990000',
      slippage: 1, priority_fee: '0.00001', tip_fee: '0.00001', is_anti_mev: true,
      condition_orders: TEST_CONDITIONS, sell_ratio_type: 'hold_amount'}]);
    assert.deepEqual(journal.operation(run.id, 'buy')?.body, submissions[0]);
    assert.equal(journal.operation(run.id, 'sell'), undefined);
  } finally {journal.close();}
});

test('controlled signed queries preserve raw data and strategy pagination without guessing more pages', async () => {
  const calls: string[] = [], pageToken = 'next /?=+&';
  const gmgn = client(async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); assertSignature(input, init);
    if (url.pathname === '/v1/trade/query_order') {
      assert.equal(url.searchParams.get('order_id'), 'buy-order');
      return success({status: 'pending', order_id: 'buy-order'});
    }
    assert.equal(url.pathname, '/v1/trade/strategy/orders');
    assert.equal(url.searchParams.get('chain'), 'sol');
    assert.equal(url.searchParams.get('from_address'), wallet);
    assert.equal(url.searchParams.get('base_token'), mint);
    assert.equal(url.searchParams.get('group_tag'), 'STMix');
    assert.equal(url.searchParams.get('limit'), '100');
    if (url.searchParams.get('type') === 'open') {
      assert.equal(url.searchParams.has('page_token'), false);
      return success({list: [{order_id: 'strategy-order'}], next_page_token: pageToken});
    }
    assert.equal(url.searchParams.get('type'), 'history');
    assert.equal(url.searchParams.get('page_token'), pageToken);
    return success({list: [], next_page_token: ''});
  });
  assert.deepEqual(await gmgn.query('buy-order'), {status: 'pending', order_id: 'buy-order'});
  assert.deepEqual(await gmgn.strategies(wallet, mint, 'open'),
    {list: [{order_id: 'strategy-order'}], next_page_token: pageToken});
  assert.equal(calls.length, 2);
  assert.deepEqual(await gmgn.strategies(wallet, mint, 'history', pageToken), {list: [], next_page_token: ''});
  assert.equal(calls.length, 3);
});

test('controlled cancel uses official singular order_id and required wallet, with no guessed sell mode', async () => {
  const clientId = randomUUID(); let calls = 0;
  const gmgn = client(async (input, init) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.pathname, '/v1/trade/strategy/cancel'); assert.equal(init?.method, 'POST');
    assert.equal(url.searchParams.get('client_id'), clientId);
    assert.deepEqual(JSON.parse(String(init?.body)), {chain: 'sol', from_address: wallet, order_id: 'strategy-order'});
    assertSignature(input, init); return success({accepted: true});
  });
  assert.deepEqual(await gmgn.cancel(wallet, 'strategy-order', clientId), {accepted: true});
  await assert.rejects(gmgn.cancel(wallet, 'strategy-order', clientId), reason('GMGN_TEST_NONCE_REUSED'));
  assert.equal(calls, 1);
});

test('controlled RSA signing uses SHA256 with PSS and a 32-byte salt', async () => {
  const rsa = generateKeyPairSync('rsa', {modulusLength: 2048});
  const gmgn = new GmgnTestClient({apiKey, privateKeyPem: rsa.privateKey.export({type: 'pkcs8', format: 'pem'}).toString(),
    minIntervalMs: 0, fetcher: async (input, init) => {
      const url = new URL(String(input)), headers = new Headers(init?.headers);
      const message = `${url.pathname}:${url.search.slice(1)}::${url.searchParams.get('timestamp')}`;
      assert.equal(verify('sha256', Buffer.from(message), {key: rsa.publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32}, Buffer.from(headers.get('X-Signature')!, 'base64')), true);
      return success({order_id: 'order'});
    }});
  assert.deepEqual(await gmgn.query('order'), {order_id: 'order'});
});

test('controlled requests queue internally and generate timestamps only at actual dispatch', async t => {
  const start = 1_800_000_000_000;
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: start});
  const first = deferred<Response>(), entered = deferred<void>();
  const times: string[] = []; let calls = 0;
  const gmgn = client(async (input, init) => {
    calls++; const url = new URL(String(input)); times.push(url.searchParams.get('timestamp')!); assertSignature(input, init);
    if (calls === 1) {entered.resolve(); return first.promise;}
    return success({order_id: 'second'});
  }, 7_000);
  const a = gmgn.query('first'), b = gmgn.query('second');
  await entered.promise; assert.equal(calls, 1);
  first.resolve(success({order_id: 'first'})); await a; await flush();
  t.mock.timers.tick(6_999); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await b;
  assert.deepEqual(times, [String(start / 1000), String(start / 1000 + 7)]);
});

test('controlled GET and POST never retry 429; cooldown blocks later requests without another dispatch', async () => {
  for (const method of ['quote', 'swap', 'cancel'] as const) {
    let calls = 0;
    const gmgn = client(async () => {calls++; return Response.json({code: 429, message: apiKey,
      reset_at: Math.floor(Date.now() / 1000) + 300}, {status: 429});});
    const work = method === 'quote' ? gmgn.quote(quote) : method === 'swap'
      ? gmgn.swap(body(), randomUUID()) : gmgn.cancel(wallet, 'strategy-order', randomUUID());
    await assert.rejects(work, error => {
      assert.ok(error instanceof GmgnTestError); assert.equal(error.reason, 'GMGN_TEST_RATE_LIMITED');
      assert.ok((error.retryAfterMs ?? 0) > 290_000);
      assert.equal(inspect(error, {showHidden: true}).includes(apiKey), false); return true;
    });
    await assert.rejects(gmgn.query('order'), reason('GMGN_TEST_RATE_LIMITED'));
    assert.equal(calls, 1);
  }
});

test('controlled transport redacts upstream bodies and thrown errors, and never retries uncertain writes', async () => {
  for (const respond of [
    () => Response.json({code: 500, message: `${apiKey} ${pem}`}, {status: 500}),
    () => Response.json({code: 40003701, message: `${apiKey} ${pem}`}),
    () => new Response(`${apiKey} ${pem}`, {status: 200}),
    () => {throw new Error(`${apiKey} ${pem}`);},
  ]) {
    let calls = 0; const clientId = randomUUID();
    const gmgn = client(async () => {calls++; return respond();});
    await assert.rejects(gmgn.swap(body(), clientId), error => {
      assert.ok(error instanceof GmgnTestError);
      const rendered = inspect(error, {showHidden: true});
      assert.equal(rendered.includes(apiKey), false); assert.equal(rendered.includes('BEGIN PRIVATE KEY'), false);
      assert.equal(Object.hasOwn(error, 'cause'), false); return true;
    });
    await assert.rejects(gmgn.swap(body(), clientId), reason('GMGN_TEST_NONCE_REUSED'));
    assert.equal(calls, 1);
  }
});

test('controlled requests time out after 12 seconds even when fetch ignores abort, without re-sending', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const pendingResponse = deferred<Response>(), entered = deferred<void>();
  let calls = 0, signal: AbortSignal | null | undefined;
  const gmgn = client(async (_input, init) => {calls++; signal = init?.signal; entered.resolve(); return pendingResponse.promise;});
  const clientId = randomUUID(), pending = gmgn.swap(body(), clientId);
  const rejected = assert.rejects(pending, reason('GMGN_TEST_REQUEST_TIMEOUT'));
  await entered.promise; t.mock.timers.tick(12_000); await rejected;
  assert.equal(signal?.aborted, true); assert.equal(calls, 1);
  pendingResponse.resolve(success({order_id: 'late-accepted-order'})); await flush();
  await assert.rejects(gmgn.swap(body(), clientId), reason('GMGN_TEST_NONCE_REUSED'));
  assert.equal(calls, 1);
});

test('controlled response size is bounded for both declared and streamed bodies', async () => {
  for (const response of [
    new Response('{}', {headers: {'content-length': String(2 * 1024 * 1024 + 1)}}),
    new Response(new ReadableStream<Uint8Array>({start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close();
    }})),
  ]) {
    let calls = 0; const gmgn = client(async () => {calls++; return response;});
    await assert.rejects(gmgn.query('order'), reason('GMGN_TEST_RESPONSE_TOO_LARGE'));
    assert.equal(calls, 1);
  }
});

test('controlled body reading shares the 12-second deadline and cancels an unfinished stream', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const entered = deferred<void>(); let canceled = false;
  const gmgn = client(async () => {entered.resolve(); return new Response(new ReadableStream<Uint8Array>({
    start(controller) {controller.enqueue(new TextEncoder().encode('{"code":0,"data":'));},
    cancel() {canceled = true;},
  }));});
  const pending = gmgn.query('order'), rejected = assert.rejects(pending, reason('GMGN_TEST_REQUEST_TIMEOUT'));
  await entered.promise; await flush(); t.mock.timers.tick(12_000); await rejected; await flush();
  assert.equal(canceled, true);
});

test('controlled invalid credentials and unsupported request shapes fail before network access', async () => {
  for (const options of [
    {apiKey: '', privateKeyPem: pem}, {apiKey: 'bad\nkey', privateKeyPem: pem},
    {apiKey, privateKeyPem: `${apiKey}-not-a-key`},
  ]) assert.throws(() => new GmgnTestClient(options), reason('GMGN_TEST_CREDENTIALS_INVALID'));
  let calls = 0; const gmgn = client(async () => {calls++; return success();});
  for (const request of [{...quote, inputAmount: '-1'}, {...quote, slippagePct: 101}, {...quote, wallet: 'bad'}])
    await assert.rejects(gmgn.quote(request), reason('GMGN_TEST_REQUEST_INVALID'));
  await assert.rejects(gmgn.swap({...body(), chain: 'bsc'}, randomUUID()), reason('GMGN_TEST_REQUEST_INVALID'));
  for (const swap_mode of ['ExactOut', 'exactin', null, true])
    await assert.rejects(gmgn.swap({...body(), swap_mode}, randomUUID()), reason('GMGN_TEST_REQUEST_INVALID'));
  await assert.rejects(gmgn.swap({...body(), destination: 'unapproved'}, randomUUID()), reason('GMGN_TEST_REQUEST_INVALID'));
  await assert.rejects(gmgn.swap(body(), 'not-a-uuid'), reason('GMGN_TEST_REQUEST_INVALID'));
  await assert.rejects(gmgn.query('../another-route'), reason('GMGN_TEST_REQUEST_INVALID'));
  await assert.rejects(gmgn.cancel('bad', 'order', randomUUID()), reason('GMGN_TEST_REQUEST_INVALID'));
  await assert.rejects(gmgn.strategies(wallet, mint, 'history', 'x'.repeat(4_097)), reason('GMGN_TEST_REQUEST_INVALID'));
  assert.equal(calls, 0);
});
