import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {PriceTracker, type PriceTrackerOptions} from '../src/price-tracker.js';
import {GmgnError} from '../src/providers/gmgn-client.js';
import type {Chain} from '../src/types.js';
import type {ScanPrice} from '../src/scan-archive.js';

type Token = {chain: Chain; address: string};
type Sample = ScanPrice;
const token = (index = 1, chain: Chain = 'bsc'): Token => ({chain,
  address: chain === 'solana' ? bs58.encode(new Uint8Array(32).fill(index)) : '0x' + index.toString(16).padStart(40, '0')});
const instant = Date.parse('2026-10-09T00:00:00.000Z');
function memoryArchive(initial: Token[]) {
  let tokens = initial;
  const samples: Sample[] = [], errors: {token: Token; reason: string; at: string}[] = [];
  const lookups: {limit?: number; now?: Date}[] = [];
  const archive: PriceTrackerOptions['archive'] = {
    pendingTokens(limit, now) {lookups.push({limit, now}); return tokens.slice(0, limit);},
    recordPrice(sample) {samples.push(structuredClone(sample));},
    recordPriceError(target, reason, now) {errors.push({token: {...target}, reason, at: now!.toISOString()});},
  };
  return {archive, samples, errors, lookups, replace(next: Token[]) {tokens = next;}};
}
function mockedClient(handler?: (query: Record<string, string | number>) => Promise<unknown>) {
  const calls: {path: string; query: Record<string, string | number>; weight?: number}[] = [];
  let cooldown = 0;
  const client: PriceTrackerOptions['client'] = {
    get cooldownUntil() {return cooldown;},
    async get(path, query, weight) {
      calls.push({path, query: {...query}, weight});
      return handler ? handler(query) : {address: query.address, price: {price: '0.001'}};
    },
  };
  return {client, calls, setCooldown(value: number) {cooldown = value;}};
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

test('samples only official current USD field, matches identity, and uses response completion time', async () => {
  const archive = memoryArchive([token(), token(2, 'solana'), token(3, 'robinhood')]);
  let time = instant;
  const ctx = mockedClient(async query => {
    time += 2_000;
    return {address: query.address, chain: query.chain, price: {price: '1.25e-6', price_24h: '99999'}, ath_price: 1e9,
      price_usd: '12345', name: 'untrusted metadata', creation_timestamp: 1};
  });
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client, now: () => new Date(time)});
  const report = await tracker.runOnce();
  assert.equal(report.recorded, 3); assert.equal(report.errors, 0);
  assert.deepEqual(ctx.calls.map(call => call.query.chain), ['bsc', 'sol', 'robinhood']);
  assert.deepEqual(archive.samples.map(sample => sample.observedAt), [2_000, 4_000, 6_000].map(offset => new Date(instant + offset).toISOString()));
  assert.equal(archive.lookups[0].limit, 200); assert.equal(archive.lookups[0].now?.getTime(), instant);
  for (const sample of archive.samples) {
    assert.equal(sample.priceUsd, 0.00000125); assert.equal(sample.source, 'gmgn_token_info_sample');
    assert.deepEqual(Object.keys(sample).sort(), ['address', 'chain', 'observedAt', 'priceUsd', 'source']);
  }
  for (const call of ctx.calls) {assert.equal(call.path, '/v1/token/info'); assert.equal(call.weight, 1);}
  assert.equal(tracker.getStatus().inFlight, false);
});

test('round robin covers all bounded candidates while input order changes and one token fails', async () => {
  const tokens = Array.from({length: 5}, (_, index) => token(index + 1));
  const archive = memoryArchive(tokens);
  const ctx = mockedClient(async query => {
    if (query.address === tokens[0].address) throw new Error('arbitrary upstream secret');
    return {address: query.address, price: {price: '2'}};
  });
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client, maxTokensPerCycle: 2});
  await tracker.runOnce(); archive.replace([...tokens].reverse());
  await tracker.runOnce(); await tracker.runOnce();
  assert.deepEqual(ctx.calls.map(call => call.query.address), [...tokens, tokens[0]].map(value => value.address));
  assert.equal(archive.errors.length, 2); assert.equal(archive.errors[0].reason, 'GMGN_REQUEST_FAILED');
  assert.equal(JSON.stringify(tracker.getStatus()).includes('secret'), false);
  archive.replace([tokens[1], token(6)]);
  await tracker.runOnce();
  assert.deepEqual(ctx.calls.slice(-2).map(call => call.query.address), [tokens[1].address, token(6).address]);
  assert.equal(tracker.getStatus().trackedTokens, 2);
});

test('follow-up market context reuses scoped current fields and preserves missing values',async()=>{
  const archive=memoryArchive([token(),token(2),token(3)]);
  const ctx=mockedClient(async query=>query.address===token().address?{
    address:query.address,chain:'bsc',price:{price:'2',address:query.address,chain:'bsc'},liquidity:'45000.25',
    holder_count:241,stat:{top_10_holder_rate:'0.21'},biggest_pool_address:token(8).address,
    ath_price:99999,price_24h:99,
  }:query.address===token(2).address?{
    address:query.address,price:{price:'3'},liquidity:null,holder_count:'',stat:{top_10_holder_rate:21},
    biggest_pool_address:query.address,
  }:{address:query.address,price:{price:'3'},liquidity:0,holder_count:0,stat:{top_10_holder_rate:0}});
  const tracker=new PriceTracker({archive:archive.archive,client:ctx.client});
  const cycle=await tracker.runOnce();assert.equal(cycle.requests,3);
  assert.deepEqual(archive.samples[0].market,{liquidityUsd:45000.25,holderCount:241,top10HolderRate:0.21,poolAddress:token(8).address});
  assert.equal(archive.samples[1].market,undefined);
  assert.deepEqual(archive.samples[2].market,{liquidityUsd:0,holderCount:0,top10HolderRate:0});
});

test('nested wrong-token current prices cannot enter the follow-up archive',async()=>{
  const archive=memoryArchive([token(),token(2)]);
  const ctx=mockedClient(async query=>({address:query.address,chain:'bsc',liquidity:'99999',
    price:{price:'5',...(query.address===token().address?{address:token(9).address}:{chain:'sol'})}}));
  const tracker=new PriceTracker({archive:archive.archive,client:ctx.client});
  const cycle=await tracker.runOnce();assert.equal(cycle.recorded,0);assert.equal(cycle.errors,2);
  assert.equal(archive.samples.length,0);assert.ok(archive.errors.every(e=>e.reason==='PRICE_TOKEN_MISMATCH'));
});

test('deduplicates full chain plus address identity and bounds archive selection', async () => {
  const evm = token(0xab);
  const archive = memoryArchive([evm, {...evm, address: '0x' + evm.address.slice(2).toUpperCase()},
    {...evm, chain: 'robinhood'}, token(2, 'solana')]);
  const ctx = mockedClient();
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client});
  assert.equal((await tracker.runOnce()).requests, 3);
  assert.equal(tracker.getStatus().trackedTokens, 3);
  archive.replace(Array.from({length: 250}, (_, index) => token(index + 1)));
  const report = await tracker.runOnce();
  assert.equal(report.activeTokens, 200); assert.equal(report.requests, 10); assert.equal(report.deferred, 190);
});

test('rejects missing, mismatched, malformed or wrong-chain asset identities', async () => {
  for (const raw of [null, [], {}, {price: {price: '1'}}, {address: token(2).address, price: {price: '1'}},
    {address: token().address, chain: 'sol', price: {price: '1'}}, {address: 1, price: {price: '1'}}]) {
    const archive = memoryArchive([token()]); const ctx = mockedClient(async () => raw);
    const cycle = await new PriceTracker({archive: archive.archive, client: ctx.client}).runOnce();
    assert.equal(cycle.recorded, 0); assert.equal(archive.errors.length, 1);
    assert.equal(archive.samples.length, 0);
  }
});

test('requires nested price.price string; never falls back to ATH, window values, top-level price or price_usd', async () => {
  for (const change of [{price: '1'}, {price: 1}, {price: {price: 1}}, {price: null}, {price: {price_usd: '1'}},
    {price: {price_1m: '10'}}, {ath_price: 100}, {price_usd: '12'}]) {
    const archive = memoryArchive([token()]);
    const ctx = mockedClient(async () => ({address: token().address, ...change}));
    const cycle = await new PriceTracker({archive: archive.archive, client: ctx.client}).runOnce();
    assert.equal(cycle.recorded, 0); assert.equal(archive.errors[0].reason, 'PRICE_SCHEMA_INVALID');
  }
});

test('rejects zero, negative, nonfinite, underflow and coercion-friendly prices', async () => {
  for (const value of ['0', '0.000', '-1', 'Infinity', 'NaN', '1e309', '1e-999', '', ' 1', '1 ', '0x10',
    '01', '.5', '1_000', {}, true, [], '1'.repeat(129)]) {
    const archive = memoryArchive([token()]);
    const ctx = mockedClient(async query => ({address: query.address, price: {price: value}}));
    assert.equal((await new PriceTracker({archive: archive.archive, client: ctx.client}).runOnce()).recorded, 0);
    assert.equal(archive.errors.length, 1); assert.equal(archive.samples.length, 0);
  }
});

test('shared cooldown produces gap records for the bounded batch without issuing requests', async () => {
  let time = instant;
  const archive = memoryArchive([token(1), token(2), token(3)]), ctx = mockedClient();
  ctx.setCooldown(instant + 120_000);
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client, maxTokensPerCycle: 2, now: () => new Date(time)});
  const cycle = await tracker.runOnce();
  assert.equal(cycle.status, 'cooldown'); assert.equal(cycle.requests, 0); assert.equal(cycle.deferred, 3);
  assert.equal(ctx.calls.length, 0); assert.equal(archive.errors.length, 2);
  assert.ok(archive.errors.every(error => error.reason === 'GMGN_RATE_LIMITED'));
  assert.equal(tracker.getStatus().cooldownUntil, new Date(instant + 120_000).toISOString());
  time += 120_000;
  assert.equal((await tracker.runOnce()).recorded, 2);
  assert.deepEqual(ctx.calls.map(call => call.query.address), [token(3).address, token(1).address]);
});

test('429 stops further requests and uses the advertised reset, including when client getter is stale', async () => {
  const archive = memoryArchive([token(1), token(2), token(3)]);
  const ctx = mockedClient(async () => {throw new GmgnError('GMGN_RATE_LIMITED', instant + 180_000, instant);});
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client, now: () => new Date(instant)});
  assert.equal((await tracker.runOnce()).status, 'cooldown');
  assert.equal(ctx.calls.length, 1); assert.equal(archive.errors.length, 3);
  await tracker.runOnce(); assert.equal(ctx.calls.length, 1);
  assert.equal(tracker.getStatus().cooldownUntil, new Date(instant + 180_000).toISOString());
});

test('missing or invalid credentials are not retried across every token in one cycle', async () => {
  for (const reason of ['GMGN_API_KEY_MISSING', 'GMGN_AUTH_FAILED'] as const) {
    const archive = memoryArchive([token(1), token(2), token(3)]);
    const ctx = mockedClient(async () => {throw new GmgnError(reason);});
    const report = await new PriceTracker({archive: archive.archive, client: ctx.client}).runOnce();
    assert.equal(report.status, 'partial'); assert.equal(report.requests, 1); assert.equal(report.deferred, 2);
    assert.equal(archive.errors[0].reason, reason);
  }
});

test('overlapping runOnce calls share one request and one archive write', async () => {
  const response = deferred<unknown>();
  const archive = memoryArchive([token()]), ctx = mockedClient(() => response.promise);
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client});
  const first = tracker.runOnce(), second = tracker.runOnce();
  assert.equal(first, second); assert.equal(ctx.calls.length, 1); assert.equal(tracker.getStatus().inFlight, true);
  response.resolve({address: token().address, price: {price: '1'}});
  await first;
  assert.equal(archive.samples.length, 1); assert.equal(tracker.getStatus().inFlight, false);
});

test('stop waits for the in-flight GET, discards its response, and never starts remaining requests', async () => {
  const response = deferred<unknown>();
  const archive = memoryArchive([token(), token(2)]), ctx = mockedClient(() => response.promise);
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client});
  tracker.start(); tracker.start();
  let stopped = false; const stop = tracker.stop().then(() => {stopped = true;});
  await Promise.resolve(); assert.equal(stopped, false); assert.equal(ctx.calls.length, 1);
  response.resolve({address: token().address, price: {price: '1'}});
  await stop;
  assert.equal(stopped, true); assert.equal(archive.samples.length, 0); assert.equal(archive.errors.length, 0);
  assert.equal(tracker.getStatus().running, false); assert.equal(tracker.getStatus().inFlight, false);
  assert.equal(tracker.getStatus().lastCycle?.status, 'stopped'); assert.equal(ctx.calls.length, 1);
});

test('backend timer continues sampling without any browser or request invoking runOnce', async () => {
  const second = deferred<void>();
  const archive = memoryArchive([token()]); let calls = 0;
  const ctx = mockedClient(async query => {
    calls++; if (calls === 2) second.resolve();
    return {address: query.address, price: {price: '1'}};
  });
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client, intervalMs: 5});
  tracker.start();
  const guard = setTimeout(() => {second.resolve();}, 500);
  await second.promise; clearTimeout(guard);
  await tracker.stop(); assert.ok(calls >= 2); assert.ok(archive.samples.length >= 1);
});

test('archive failures stop sampling and expose only fixed diagnostics', async () => {
  const archive = memoryArchive([token(), token(2)]), ctx = mockedClient();
  archive.archive.recordPrice = () => {throw new Error('SECRET disk path');};
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client});
  const cycle = await tracker.runOnce();
  assert.equal(cycle.recorded, 0); assert.equal(cycle.requests, 1); assert.equal(cycle.status, 'partial');
  assert.deepEqual(cycle.reasons, ['PRICE_ARCHIVE_WRITE_FAILED']);
  assert.equal(JSON.stringify(tracker.getStatus()).includes('SECRET'), false);
  archive.archive.pendingTokens = () => {throw new Error('SECRET sqlite');};
  assert.deepEqual((await tracker.runOnce()).reasons, ['PRICE_ARCHIVE_UNAVAILABLE']);
  assert.equal(ctx.calls.length, 1);
});

test('time regression cannot create a price sample earlier than its request or candidate selection', async () => {
  let time = instant;
  const archive = memoryArchive([token()]);
  const ctx = mockedClient(async query => {time--; return {address: query.address, price: {price: '1'}};});
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client, now: () => new Date(time)});
  assert.equal((await tracker.runOnce()).recorded, 0);
  assert.equal(archive.errors[0].reason, 'PRICE_CLOCK_REGRESSED');
});

test('bad token identifiers cause no API calls and status snapshots cannot mutate internal diagnostics', async () => {
  const archive = memoryArchive([{chain: 'bsc', address: 'https://attacker.invalid'}, {chain: 'bsc', address: '0x' + '0'.repeat(40)},
    {chain: 'solana', address: '11111111111111111111111111111111'}]), ctx = mockedClient();
  const tracker = new PriceTracker({archive: archive.archive, client: ctx.client});
  const cycle = await tracker.runOnce();
  assert.equal(cycle.requests, 0); assert.equal(cycle.errors, 3); assert.equal(ctx.calls.length, 0);
  const status = tracker.getStatus(); status.lastCycle!.reasons.push('tampered');
  assert.equal(tracker.getStatus().lastCycle!.reasons.includes('tampered'), false);
});

test('configuration rejects unbounded work or invalid intervals', () => {
  const archive = memoryArchive([]), ctx = mockedClient();
  for (const option of [{intervalMs: 0}, {intervalMs: Infinity}, {intervalMs: 3_600_001},
    {maxTokensPerCycle: 0}, {maxTokensPerCycle: 201}, {maxTokensPerCycle: 1.5}])
    assert.throws(() => new PriceTracker({archive: archive.archive, client: ctx.client, ...option}), /PRICE_TRACKER_CONFIG_INVALID/);
});

test('router integration records independent prices and keeps polling despite GMGN cooldown',async()=>{
  const {MarketPriceRouter}=await import('../src/market-price-router.js');
  const archive=memoryArchive([token()]),client=mockedClient(),second=deferred<void>();let time=instant,calls=0;
  client.setCooldown(instant+300_000);
  const router=new MarketPriceRouter({client:client.client,now:()=>new Date(time),maxDebotPerBatch:0,
    fetcher:async()=>{time+=100;calls++;if(calls===2)second.resolve();return new Response(JSON.stringify([
      {chainId:'bsc',baseToken:{address:token().address},pairAddress:token(9).address,priceUsd:'2',liquidity:{usd:10000}},
    ]));}});
  const tracker=new PriceTracker({archive:archive.archive,client:client.client,router,intervalMs:5,now:()=>new Date(time)});
  const keepAlive=setTimeout(()=>second.resolve(),1000);
  tracker.start();await second.promise;clearTimeout(keepAlive);
  await new Promise(resolve=>setTimeout(resolve,1));await tracker.stop();
  assert.ok(archive.samples.length>=2);assert.equal(archive.errors.length,0);assert.equal(client.calls.length,0);
  assert.equal(tracker.getStatus().cooldownUntil,undefined);assert.equal(tracker.getStatus().lastCycle?.status,'ok');
  assert.equal(router.getStatus().sources.gmgn.state,'cooldown');
});

test('router tracker shutdown cancels hung transport without late archive writes',async()=>{
  const {MarketPriceRouter}=await import('../src/market-price-router.js');
  const archive=memoryArchive([token()]),client=mockedClient();let signal:AbortSignal|null|undefined;
  const router=new MarketPriceRouter({client:client.client,fetcher:async(_url,init)=>{signal=init?.signal;return new Promise(()=>{});}});
  const tracker=new PriceTracker({archive:archive.archive,client:client.client,router});
  tracker.start();await Promise.resolve();await tracker.stop();
  assert.equal(signal?.aborted,true);assert.equal(archive.samples.length,0);assert.equal(archive.errors.length,0);
  assert.equal(tracker.getStatus().lastCycle?.status,'stopped');assert.equal(client.calls.length,0);
});

test('router-backed tracking preserves genuine gaps and does not substitute signal or ATH prices',async()=>{
  const {MarketPriceRouter}=await import('../src/market-price-router.js');
  const archive=memoryArchive([token(),token(2)]),client=mockedClient();
  const router=new MarketPriceRouter({client:client.client,maxGmgnPerBatch:0,maxDebotPerBatch:0,now:()=>new Date(instant),
    fetcher:async()=>new Response(JSON.stringify([{chainId:'bsc',baseToken:{address:token().address},pairAddress:token(9).address,
      priceUsd:'2',liquidity:{usd:10000}},{chainId:'bsc',baseToken:{address:token(2).address},pairAddress:token(8).address,ath_price:'99'}]))});
  const tracker=new PriceTracker({archive:archive.archive,client:client.client,router,now:()=>new Date(instant)});
  const cycle=await tracker.runOnce();assert.equal(cycle.recorded,1);assert.equal(cycle.errors,1);assert.equal(cycle.status,'partial');
  assert.equal(archive.errors[0].token.address,token(2).address);assert.equal(archive.errors[0].reason,'PRICE_NO_FRESH_SOURCE');
});

test('router priority brings a newly protected token ahead of an old ring and reserves ordinary-token progress',async()=>{
  const {MarketPriceRouter}=await import('../src/market-price-router.js');
  const initial=Array.from({length:10},(_,i)=>token(i+1)),archive=memoryArchive(initial),client=mockedClient();
  const batches:string[][]=[];let time=instant,protectedTokens:Token[]=[];
  const router=new MarketPriceRouter({client:client.client,now:()=>new Date(time),maxDebotPerBatch:0,maxGmgnPerBatch:0,
    fetcher:async input=>{time+=100;const addresses=String(input).split('/').at(-1)!.split(',');batches.push(addresses);
      return new Response(JSON.stringify(addresses.map(address=>({chainId:'bsc',baseToken:{address},pairAddress:token(99).address,priceUsd:'2'}))));}});
  const tracker=new PriceTracker({archive:archive.archive,client:client.client,router,maxTokensPerCycle:3,now:()=>new Date(time),
    priorityTokens:at=>{assert.equal(at.getTime(),time);return protectedTokens;}});
  await tracker.runOnce();assert.deepEqual(batches[0],initial.slice(0,3).map(t=>t.address));
  archive.replace([...initial,token(50),token(51)]);protectedTokens=[token(50),token(51),token(52)];
  await tracker.runOnce();assert.deepEqual(batches[1],[token(50),token(51),token(4)].map(t=>t.address));
  await tracker.runOnce();assert.deepEqual(batches[2],[token(50),token(51),token(5)].map(t=>t.address));
  await tracker.runOnce();assert.deepEqual(batches[3],[token(50),token(51),token(6)].map(t=>t.address));
  assert.ok(!batches.flat().includes(token(52).address)); // a priority cannot introduce an untracked token
});

test('priority errors fall back to the ordinary ring and legacy GMGN sampling does not invoke priority callbacks',async()=>{
  const {MarketPriceRouter}=await import('../src/market-price-router.js');
  const archive=memoryArchive([token(),token(2)]),client=mockedClient();
  const priorityTokens=()=>{throw new Error('private archive context');};
  const router=new MarketPriceRouter({client:client.client,maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:async()=>new Response('[]')});
  const cycle=await new PriceTracker({archive:archive.archive,client:client.client,router,priorityTokens}).runOnce();
  assert.ok(cycle.reasons.includes('PRICE_PRIORITY_UNAVAILABLE'));assert.equal(JSON.stringify(cycle).includes('private'),false);
  const legacy=await new PriceTracker({archive:archive.archive,client:client.client,priorityTokens}).runOnce();
  assert.equal(legacy.recorded,2);assert.equal(legacy.errors,0);
});

test('two router-backed trackers reserve one shared Dex response for the same token',async()=>{
  const {MarketPriceRouter}=await import('../src/market-price-router.js');
  const archive=memoryArchive([token()]),client=mockedClient(),gate=deferred<void>();let calls=0;
  const router=new MarketPriceRouter({client:client.client,now:()=>new Date(instant),preferStreams:true,minHttpIntervalMs:30_000,
    maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:async()=>{calls++;await gate.promise;return new Response(JSON.stringify([
      {chainId:'bsc',baseToken:{address:token().address},pairAddress:token(9).address,priceUsd:'2'},
    ]));}});
  const first=new PriceTracker({archive:archive.archive,client:client.client,router,now:()=>new Date(instant)}).runOnce();
  await Promise.resolve();
  const second=new PriceTracker({archive:archive.archive,client:client.client,router,now:()=>new Date(instant)}).runOnce();
  await Promise.resolve();assert.equal(calls,1);
  gate.resolve();await Promise.all([first,second]);
  assert.equal(calls,1);assert.equal(archive.samples.length,1);
});
