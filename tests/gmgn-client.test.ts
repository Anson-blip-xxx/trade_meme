import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GmgnClient, GmgnError} from '../src/providers/gmgn-client.js';

const response = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {status, headers});
const key = () => `test-${randomUUID()}`;
const route = '/v1/token/info';
const query = {chain: 'bsc', address: '0x1111111111111111111111111111111111114444'};
const rejects = (reason: string) => (error: unknown) => error instanceof GmgnError && error.reason === reason;
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}

test('client refuses missing credentials, writes, arbitrary URLs and auth-query overrides before fetching', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return response({code: 0, data: {}}); };
  await assert.rejects(new GmgnClient({fetcher}).get(route, query), rejects('GMGN_API_KEY_MISSING'));
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher});
  for (const path of ['/v1/trade/swap', '/v1/trade/strategy/create', '/v1/user/wallet_holdings',
    '/v1/trade/follow_wallet', 'https://evil.test/v1/token/info', '//evil.test/v1/token/info',
    '/v1/token/info?x=y', '/v1/user/wallet_funding']) {
    await assert.rejects(client.get(path, query), rejects('GMGN_PATH_NOT_ALLOWED'));
  }
  for (const bad of [{timestamp: 123}, {client_id: 'override'}, {chain: Number.NaN}, {address: ['one']}])
    await assert.rejects(client.get(route, bad as any), rejects('GMGN_QUERY_INVALID'));
  assert.equal(calls, 0);
});

test('client sends fixed-host GET with fresh normal-auth fields and returns only data', async () => {
  const requests: {url: URL; init: RequestInit | undefined}[] = [];
  const apiKey = key();
  const client = new GmgnClient({apiKey, minIntervalMs: 0, now: () => 1_800_000_000_000,
    fetcher: async (input, init) => {
      requests.push({url: new URL(String(input)), init});
      return response({code: 0, data: {address: query.address}, message: 'ok'});
    }});
  for (let i = 0; i < 2; i++) assert.deepEqual(await client.get(route, query), {address: query.address});
  for (const {url, init} of requests) {
    assert.equal(url.origin, 'https://openapi.gmgn.ai');
    assert.equal(url.pathname, route);
    assert.equal(url.searchParams.get('timestamp'), '1800000000');
    assert.equal(url.searchParams.get('address'), query.address);
    assert.equal(new Headers(init?.headers).get('x-apikey'), apiKey);
    assert.equal(new Headers(init?.headers).has('x-signature'), false);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.ok(init?.signal);
  }
  assert.notEqual(requests[0].url.searchParams.get('client_id'), requests[1].url.searchParams.get('client_id'));
});

test('read-only quote is allowed; path traversal in query stays encoded data', async () => {
  let seen: URL | undefined;
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async input => {
    seen = new URL(String(input)); return response({code: '0', data: {output_amount: '12'}});
  }});
  assert.deepEqual(await client.get('/v1/trade/quote', {chain: 'robinhood', address: 'x&timestamp=bad#fragment'}), {output_amount: '12'});
  assert.equal(seen!.origin, 'https://openapi.gmgn.ai');
  assert.equal(seen!.searchParams.get('address'), 'x&timestamp=bad#fragment');
  assert.notEqual(seen!.searchParams.get('timestamp'), 'bad');
});

test('all instances serialize requests and same-key instances share pacing', async () => {
  const apiKey = key(), starts: number[] = [];
  let active = 0, maxActive = 0;
  const fetcher: typeof fetch = async () => {
    starts.push(Date.now()); active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--; return response({code: 0, data: {}});
  };
  const a = new GmgnClient({apiKey, minIntervalMs: 25, fetcher});
  const b = new GmgnClient({apiKey, minIntervalMs: 25, fetcher});
  await Promise.all([a.get(route, query, 2), b.get(route, query)]);
  assert.equal(maxActive, 1);
  assert.ok(starts[1] - starts[0] >= 45, `weighted pacing gap: ${starts[1] - starts[0]}`);
});

test('same-key clients retain conservative pacing across observed GMGN tiers', async () => {
  const apiKey = key(), starts: number[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    starts.push(Date.now());
    calls++;
    const limit = calls === 1 ? '5' : calls === 2 ? '20' : undefined;
    return response({code: 0, data: calls}, 200, limit ? {'x-ratelimit-limit': limit} : {});
  };
  const a = new GmgnClient({apiKey, minIntervalMs: 350, fetcher});
  const b = new GmgnClient({apiKey, minIntervalMs: 350, fetcher});
  assert.equal(await a.get(route, query), 1);
  assert.equal(await b.get(route, query), 2);
  assert.equal(await a.get(route, query), 3);
  const downgradedGap = starts[1] - starts[0];
  const upgradedGap = starts[2] - starts[1];
  assert.ok(downgradedGap >= 340, `Free-tier pacing gap: ${downgradedGap}`);
  assert.ok(upgradedGap >= 330 && upgradedGap < 900, `recovered Plus-tier pacing gap: ${upgradedGap}`);
});

test('malformed rate-limit headers do not change credential pacing', async () => {
  for (const limit of ['0', '5.5', 'Infinity', '5,20', '1000']) {
    const starts: number[] = [];
    const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async () => {
      starts.push(Date.now());
      return response({code: 0, data: {}}, 200, {'x-ratelimit-limit': limit});
    }});
    await client.get(route, query);
    await client.get(route, query);
    assert.ok(starts[1] - starts[0] < 250, `invalid ${limit} changed pacing by ${starts[1] - starts[0]}ms`);
  }
});

test('live-entry work passes queued normal work without bypassing the global in-flight request', async () => {
  const entered = deferred<void>(), release = deferred<void>(), order: string[] = [];
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async input => {
    const marker = new URL(String(input)).searchParams.get('marker')!; order.push(marker);
    if (marker === 'in-flight') {entered.resolve(); await release.promise;}
    return response({code: 0, data: marker});
  }});
  const inFlight = client.get(route, {...query, marker: 'in-flight'}); await entered.promise;
  const normal = Array.from({length: 32}, (_, index) => client.get(route, {...query, marker: `normal-${index}`}));
  const live = client.get(route, {...query, marker: 'live-entry'}, 1, {priority: 'live_entry'});
  release.resolve();
  await Promise.all([inFlight, ...normal, live]);
  assert.equal(order.length, 34);
  assert.deepEqual(order.slice(0, 2), ['in-flight', 'live-entry']);
});

test('live-entry quote interrupts an in-flight archive request and passes the normal backlog', async () => {
  const entered = deferred<void>(), order: string[] = [];
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/market/token_signal') {
      order.push('archive-start'); entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => {order.push('archive-abort'); reject(new Error('ARCHIVE_ABORTED'));};
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
      });
    }
    const marker = url.searchParams.get('marker') ?? url.pathname;
    order.push(marker);
    return response({code: 0, data: marker});
  }});
  const archive = client.getMemeMarketSignals('sol');
  await entered.promise;
  const archiveRejected = assert.rejects(archive, rejects('GMGN_REQUEST_ABORTED'));
  const normal = Array.from({length: 4}, (_, index) => client.get(route, {...query, marker: `normal-${index}`}));
  const quote = client.get('/v1/trade/quote', {chain:'sol',marker:'live-quote'}, 10, {priority:'live_entry'});
  await archiveRejected;
  assert.equal(await quote, 'live-quote');
  await Promise.all(normal);
  assert.deepEqual(order.slice(0, 3), ['archive-start', 'archive-abort', 'live-quote']);
  assert.deepEqual(order.slice(3), ['normal-0', 'normal-1', 'normal-2', 'normal-3']);
});

test('expired live-entry work is removed and never consumes a later request slot', async () => {
  const entered = deferred<void>(), release = deferred<void>(); let calls = 0;
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async () => {
    calls++; if (calls === 1) {entered.resolve(); await release.promise;}
    return response({code: 0, data: calls});
  }});
  const blocker = client.get(route, query); await entered.promise;
  const expired = client.get(route, query, 1, {priority: 'live_entry', queueTimeoutMs: 10});
  await assert.rejects(expired, rejects('GMGN_QUEUE_TIMEOUT'));
  assert.equal(calls, 1);
  release.resolve(); await blocker;
  await client.get(route, query);
  assert.equal(calls, 2);
});

test('live-entry waiting lane is bounded while preserving accepted work', async () => {
  const entered = deferred<void>(), release = deferred<void>(); let calls = 0;
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async () => {
    calls++; if (calls === 1) {entered.resolve(); await release.promise;}
    return response({code: 0, data: calls});
  }});
  const blocker = client.get(route, query); await entered.promise;
  const accepted = Array.from({length: 16}, () => client.get(route, query, 1, {priority: 'live_entry'}));
  await assert.rejects(client.get(route, query, 1, {priority: 'live_entry'}), rejects('GMGN_QUEUE_TIMEOUT'));
  release.resolve(); await blocker; await Promise.all(accepted);
  assert.equal(calls, 17);
});

test('normal waiting lane is bounded and aborted overflow work never executes', async () => {
  const entered = deferred<void>(), release = deferred<void>(); let calls = 0;
  const apiKey = key(), base = new GmgnClient({apiKey, minIntervalMs: 0, fetcher: async () => {
    calls++; if (calls === 1) {entered.resolve(); await release.promise;}
    return response({code: 0, data: calls});
  }});
  const blocker = base.get(route, query); await entered.promise;
  const controller = new AbortController(), queued = base.withSignal(controller.signal);
  const accepted = Array.from({length: 128}, () => queued.get(route, query));
  const aborted = accepted.map(request => assert.rejects(request, rejects('GMGN_REQUEST_ABORTED')));
  await assert.rejects(queued.get(route, query), rejects('GMGN_QUEUE_TIMEOUT'));
  controller.abort(); await Promise.all(aborted);
  release.resolve(); await blocker; await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('an in-flight normal request on another credential cannot block live-entry work', async () => {
  const entered = deferred<void>(), release = deferred<void>(); const order: string[] = [];
  const normal = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async () => {
    order.push('normal-start'); entered.resolve(); await release.promise; order.push('normal-end');
    return response({code: 0, data: {}});
  }});
  const live = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async () => {
    order.push('live'); return response({code: 0, data: {}});
  }});
  const blocked = normal.get(route, query); await entered.promise;
  await live.get(route, query, 1, {priority: 'live_entry'});
  assert.deepEqual(order, ['normal-start', 'live']);
  release.resolve(); await blocked;
});

test('a full live queue on one credential cannot consume another credential capacity', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const first = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async () => {
    entered.resolve(); await release.promise; return response({code: 0, data: {}});
  }});
  const blocker = first.get(route, query); await entered.promise;
  const queued = Array.from({length: 16}, () => first.get(route, query, 1, {priority: 'live_entry'}));
  const second = new GmgnClient({apiKey: key(), minIntervalMs: 0,
    fetcher: async () => response({code: 0, data: 'independent'})});
  assert.equal(await second.get(route, query, 1, {priority: 'live_entry'}), 'independent');
  release.resolve(); await blocker; await Promise.all(queued);
});

test('429 cooldown is shared, fails fast without retries, and clears after reset', async () => {
  let now = 1_800_000_000_000, calls = 0;
  const apiKey = key();
  const fetcher: typeof fetch = async () => {
    calls++;
    return calls === 1 ? response({error: 'RATE_LIMIT_EXCEEDED'}, 429, {'X-RateLimit-Reset': String(now / 1000 + 30)})
      : response({code: 0, data: 'recovered'});
  };
  const a = new GmgnClient({apiKey, minIntervalMs: 0, now: () => now, fetcher});
  const b = new GmgnClient({apiKey, minIntervalMs: 0, now: () => now, fetcher});
  await assert.rejects(a.get(route, query), error => {
    assert.ok(error instanceof GmgnError);
    assert.equal(error.reason, 'GMGN_RATE_LIMITED');
    assert.equal(error.retryAfterMs, 30_000);
    assert.equal(error.cooldownUntil, new Date(now + 30_000).toISOString());
    return true;
  });
  assert.equal(b.cooldownUntil, now + 30_000);
  await assert.rejects(b.get(route, query), rejects('GMGN_RATE_LIMITED'));
  assert.equal(calls, 1);
  now += 30_001;
  assert.equal(await b.get(route, query), 'recovered');
  assert.equal(calls, 2);
});

test('rate error in HTTP 200 and malformed HTTP 429 both install cooldown', async () => {
  const now = 1_800_000_000_000;
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, now: () => now,
    fetcher: async () => response({code: 429, error: 'RATE_LIMIT_BANNED', reset_at: now / 1000 + 300})});
  await assert.rejects(client.get(route, query), rejects('GMGN_RATE_LIMITED'));
  assert.equal(client.cooldownUntil, now + 300_000);
  const malformed = new GmgnClient({apiKey: key(), minIntervalMs: 0, now: () => now,
    fetcher: async () => new Response('not json', {status: 429})});
  await assert.rejects(malformed.get(route, query), rejects('GMGN_RATE_LIMITED'));
  assert.equal(malformed.cooldownUntil, now + 60_000);
});

test('rejects malformed/envelope errors and never reflects server or transport secrets', async () => {
  const cases: [Response, string][] = [
    [new Response('{broken'), 'GMGN_INVALID_JSON'],
    [response({code: 0}), 'GMGN_RESPONSE_INVALID'],
    [response({code: 500, message: 'secret bearer abc'}), 'GMGN_API_ERROR'],
    [response({data: {}}), 'GMGN_RESPONSE_INVALID'],
    [response({message: 'secret'}, 401), 'GMGN_AUTH_FAILED'],
    [response({message: 'secret'}, 403), 'GMGN_AUTH_FAILED'],
    [response({message: 'secret'}, 500), 'GMGN_HTTP_ERROR'],
  ];
  for (const [res, reason] of cases) {
    const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async () => res});
    await assert.rejects(client.get(route, query), error => {
      assert.ok(error instanceof GmgnError); assert.equal(error.message, reason); return true;
    });
  }
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0,
    fetcher: async () => { throw new Error('APIKEY=secret'); }});
  await assert.rejects(client.get(route, query), rejects('GMGN_REQUEST_FAILED'));
});

test('streamed response limit applies even without content-length', async () => {
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0,
    fetcher: async () => new Response(new ReadableStream({start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1)); controller.close();
    }}))});
  await assert.rejects(client.get(route, query), rejects('GMGN_RESPONSE_TOO_LARGE'));
});

test('a fetch ignoring abort cannot hold the client queue forever', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let started = false;
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async () => {
    started = true; return new Promise<Response>(() => {});
  }});
  const pending = assert.rejects(client.get(route, query), rejects('GMGN_REQUEST_TIMEOUT'));
  for (let i = 0; i < 10 && !started; i++) await Promise.resolve();
  assert.equal(started, true);
  t.mock.timers.tick(12_000);
  await pending;
});
