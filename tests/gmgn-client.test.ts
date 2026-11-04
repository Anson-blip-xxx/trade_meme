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

test('Market Signal polling passes queued analysis reads but remains behind live-entry work', async () => {
  const entered = deferred<void>(), release = deferred<void>(), order: string[] = [];
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async input => {
    const url=new URL(String(input));
    const marker=url.pathname==='/v1/market/token_signal'?'market':url.searchParams.get('marker')!;
    order.push(marker);
    if(marker==='blocker'){entered.resolve();await release.promise;}
    return response({code:0,data:marker});
  }});
  const blocker=client.get(route,{...query,marker:'blocker'});await entered.promise;
  const normal=client.get(route,{...query,marker:'analysis'});
  const market=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  const live=client.get('/v1/trade/quote',{chain:'sol',marker:'live'},10,{priority:'live_entry'});
  release.resolve();await Promise.all([blocker,normal,market,live]);
  assert.deepEqual(order,['blocker','live','market','analysis']);
});

test('Market Signal polling interrupts an in-flight background archive request', async () => {
  const entered=deferred<void>(),order:string[]=[];
  const client=new GmgnClient({apiKey:key(),minIntervalMs:0,fetcher:async(input,init)=>{
    const url=new URL(String(input)),marker=url.pathname==='/v1/callout/global'?'archive':
      url.pathname==='/v1/market/token_signal'?'market':url.pathname;
    order.push(`${marker}-start`);
    if(marker==='archive'){
      entered.resolve();
      await new Promise<void>((_resolve,reject)=>{
        const abort=()=>{order.push('archive-abort');reject(new Error('ABORTED'));};
        if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
      });
    }
    return response({code:0,data:marker});
  }});
  const archive=client.getCalloutGlobal(['sol']);await entered.promise;
  const rejected=assert.rejects(archive,rejects('GMGN_REQUEST_ABORTED'));
  const market=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  await rejected;assert.equal(await market,'market');
  assert.deepEqual(order,['archive-start','archive-abort','market-start']);
});

test('continuous Market Signal polls yield one non-preemptible retry to background archive work', async () => {
  const archiveStarted=deferred<void>(),firstPollStarted=deferred<void>(),releaseFirstPoll=deferred<void>();
  const protectedStarted=deferred<void>(),releaseProtected=deferred<void>(),order:string[]=[];
  let archiveAttempt=0,marketAttempt=0,protectedAborted=false;
  const client=new GmgnClient({apiKey:key(),minIntervalMs:0,fetcher:async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path==='/v1/callout/global'){
      archiveAttempt++;order.push(`archive-${archiveAttempt}-start`);
      if(archiveAttempt===1){
        archiveStarted.resolve();
        await new Promise<void>((_resolve,reject)=>{
          const abort=()=>{order.push('archive-1-abort');reject(new Error('ABORTED'));};
          if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
        });
      }else{
        protectedStarted.resolve();
        await new Promise<void>((resolve,reject)=>{
          const abort=()=>{protectedAborted=true;reject(new Error('ABORTED'));};
          if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
          releaseProtected.promise.then(resolve,reject);
        });
        order.push('archive-2-finish');
      }
      return response({code:0,data:`archive-${archiveAttempt}`});
    }
    marketAttempt++;order.push(`market-${marketAttempt}`);
    if(marketAttempt===1){firstPollStarted.resolve();await releaseFirstPoll.promise;}
    return response({code:0,data:`market-${marketAttempt}`});
  }});

  const firstArchive=client.getCalloutGlobal(['sol']);await archiveStarted.promise;
  const firstPoll=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  await assert.rejects(firstArchive,rejects('GMGN_REQUEST_ABORTED'));await firstPollStarted.promise;
  const queuedPolls=Array.from({length:3},()=>client.getMemeMarketSignals('sol',
    {priority:'signal_poll',queueTimeoutMs:15_000}));
  const retry=client.getCalloutGlobal(['sol']);
  releaseFirstPoll.resolve();await protectedStarted.promise;
  // This poll arrives while the protected retry is active. It must queue
  // without aborting the archive request.
  const latePoll=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  await Promise.resolve();assert.equal(protectedAborted,false);
  releaseProtected.resolve();
  assert.equal(await retry,'archive-2');
  await Promise.all([firstPoll,...queuedPolls,latePoll]);
  assert.equal(protectedAborted,false);
  assert.deepEqual(order.slice(0,5),['archive-1-start','archive-1-abort','market-1','archive-2-start','archive-2-finish']);
  assert.equal(order.filter(item=>item.startsWith('market-')).length,5);
});

test('continuous Market Signal polls yield a complete background turn at the fairness boundary',
  {timeout:14_000},async()=>{
  const firstPollStarted=deferred<void>(),releaseFirstPoll=deferred<void>();
  const backgroundStarted=deferred<void>(),releaseBackground=deferred<void>();
  const order:string[]=[];let backgroundAttempt=0,marketAttempt=0,backgroundAborted=false;
  const client=new GmgnClient({apiKey:key(),minIntervalMs:0,fetcher:async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path==='/v1/callout/global'){
      backgroundAttempt++;order.push(`background-${backgroundAttempt}-start`);
      if(backgroundAttempt===2){
        backgroundStarted.resolve();
        await new Promise<void>((resolve,reject)=>{
          const abort=()=>{backgroundAborted=true;reject(new Error('ABORTED'));};
          if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
          releaseBackground.promise.then(resolve,reject);
        });
        order.push('background-2-finish');
      }
      return response({code:0,data:`background-${backgroundAttempt}`});
    }
    if(path==='/v1/trade/quote'){
      order.push('live');return response({code:0,data:'live'});
    }
    marketAttempt++;order.push(`market-${marketAttempt}-start`);
    if(marketAttempt===1){
      firstPollStarted.resolve();
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>reject(new Error('ABORTED'));
        if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
        releaseFirstPoll.promise.then(resolve,reject);
      });
    }
    return response({code:0,data:`market-${marketAttempt}`});
  }});

  // Seed the per-credential boundary, then keep the signal lane continuously
  // occupied while the next archive request waits for its bounded fair turn.
  assert.equal(await client.getCalloutGlobal(['sol']), 'background-1');
  const firstPoll=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  await firstPollStarted.promise;
  const queuedAt=Date.now();
  // Use the production default five-second queue budget. The fairness boundary
  // must leave enough margin that its wake cannot lose to the expiry timer.
  const background=client.getCalloutGlobal(['sol']);
  const explicitBackground=client.getCalloutGlobal(['sol'],{},
    {priority:'background',queueTimeoutMs:4_500});
  const explicitRejected=assert.rejects(explicitBackground,rejects('GMGN_QUEUE_TIMEOUT'));
  const queuedPolls=Array.from({length:3},()=>client.getMemeMarketSignals('sol',
    {priority:'signal_poll',queueTimeoutMs:15_000}));
  // Stall the event loop across both the four-second fairness boundary and the
  // original five-second expiry. Neither the timer nor prune path may discard
  // the earned default turn when the fairness callback did not run on time.
  const stalledUntil=Date.now()+5_100;
  while(Date.now()<stalledUntil) { /* intentional event-loop stall */ }
  // Enqueue live synchronously before yielding to overdue timers. Its scheduler
  // kick exercises pruneQueue: default background survives, explicit expires.
  const firstPollRejected=assert.rejects(firstPoll,rejects('GMGN_REQUEST_ABORTED'));
  const live=client.get('/v1/trade/quote',{chain:'sol',marker:'live'},10,{priority:'live_entry'});
  await explicitRejected;await firstPollRejected;releaseFirstPoll.resolve();
  assert.equal(await live,'live');await backgroundStarted.promise;
  const waitedMs=Date.now()-queuedAt;
  assert.ok(waitedMs>=5_000&&waitedMs<6_500,`background started after ${waitedMs}ms`);

  // A newly arriving one-second poll must queue behind the granted turn.
  const latePoll=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(backgroundAborted,false);
  releaseBackground.resolve();assert.equal(await background,'background-2');
  await Promise.all([...queuedPolls,latePoll]);
  assert.equal(backgroundAborted,false);
  assert.deepEqual(order.slice(0,5),['background-1-start','market-1-start','live',
    'background-2-start','background-2-finish']);
});

test('a new background job does not inherit fairness age from an old archive turn',
  {timeout:8_000},async()=>{
  const blockerStarted=deferred<void>(),releaseBlocker=deferred<void>();
  const order:string[]=[];let backgroundAttempt=0;
  const client=new GmgnClient({apiKey:key(),minIntervalMs:0,fetcher:async input=>{
    const url=new URL(String(input));
    if(url.pathname==='/v1/callout/global'){
      backgroundAttempt++;order.push(`background-${backgroundAttempt}`);
      return response({code:0,data:`background-${backgroundAttempt}`});
    }
    if(url.pathname==='/v1/market/token_signal'){
      order.push('market');return response({code:0,data:'market'});
    }
    const marker=url.searchParams.get('marker')!;order.push(marker);
    if(marker==='blocker'){blockerStarted.resolve();await releaseBlocker.promise;}
    return response({code:0,data:marker});
  }});

  assert.equal(await client.getCalloutGlobal(['sol']),'background-1');
  // The old lane-based clock would make a background job submitted after this
  // gap immediately protected and place it ahead of a fresh signal poll.
  await new Promise(resolve=>setTimeout(resolve,4_050));
  const blocker=client.get(route,{...query,marker:'blocker'});await blockerStarted.promise;
  const background=client.getCalloutGlobal(['sol']);
  const signal=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  releaseBlocker.resolve();
  await Promise.all([blocker,background,signal]);
  assert.deepEqual(order,['background-1','blocker','market','background-2']);
});

test('live entry can still preempt a signal-protected background retry', async () => {
  const firstStarted=deferred<void>(),protectedStarted=deferred<void>();let archiveAttempt=0;
  const order:string[]=[];
  const client=new GmgnClient({apiKey:key(),minIntervalMs:0,fetcher:async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==='/v1/callout/global'){
      archiveAttempt++;order.push(`archive-${archiveAttempt}-start`);
      (archiveAttempt===1?firstStarted:protectedStarted).resolve();
      await new Promise<void>((_resolve,reject)=>{
        const abort=()=>{order.push(`archive-${archiveAttempt}-abort`);reject(new Error('ABORTED'));};
        if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
      });
    }
    const marker=url.pathname==='/v1/market/token_signal'?'market':url.searchParams.get('marker')??url.pathname;
    order.push(marker);return response({code:0,data:marker});
  }});

  const first=client.getCalloutGlobal(['sol']);await firstStarted.promise;
  const poll=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  await assert.rejects(first,rejects('GMGN_REQUEST_ABORTED'));assert.equal(await poll,'market');
  const protectedRetry=client.getCalloutGlobal(['sol']);await protectedStarted.promise;
  const live=client.get('/v1/trade/quote',{chain:'sol',marker:'live'},10,{priority:'live_entry'});
  await assert.rejects(protectedRetry,rejects('GMGN_REQUEST_ABORTED'));assert.equal(await live,'live');
  assert.deepEqual(order,['archive-1-start','archive-1-abort','market','archive-2-start','archive-2-abort','live']);
});

test('a protected background failure consumes its turn instead of blocking later signal polls', async () => {
  const firstStarted=deferred<void>(),thirdStarted=deferred<void>();let archiveAttempt=0,marketAttempt=0;
  const order:string[]=[];
  const client=new GmgnClient({apiKey:key(),minIntervalMs:0,fetcher:async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path==='/v1/callout/global'){
      archiveAttempt++;order.push(`archive-${archiveAttempt}-start`);
      if(archiveAttempt===2)return response({message:'archive unavailable'},500);
      (archiveAttempt===1?firstStarted:thirdStarted).resolve();
      await new Promise<void>((_resolve,reject)=>{
        const abort=()=>{order.push(`archive-${archiveAttempt}-abort`);reject(new Error('ABORTED'));};
        if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
      });
    }
    marketAttempt++;order.push(`market-${marketAttempt}`);return response({code:0,data:`market-${marketAttempt}`});
  }});

  const first=client.getCalloutGlobal(['sol']);await firstStarted.promise;
  const firstPoll=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  await assert.rejects(first,rejects('GMGN_REQUEST_ABORTED'));assert.equal(await firstPoll,'market-1');
  await assert.rejects(client.getCalloutGlobal(['sol']),rejects('GMGN_HTTP_ERROR'));

  const third=client.getCalloutGlobal(['sol']);await thirdStarted.promise;
  const secondPoll=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  await assert.rejects(third,rejects('GMGN_REQUEST_ABORTED'));assert.equal(await secondPoll,'market-2');
  assert.deepEqual(order,['archive-1-start','archive-1-abort','market-1','archive-2-start',
    'archive-3-start','archive-3-abort','market-2']);
});

test('live-entry work interrupts an in-flight Market Signal poll', async () => {
  const entered=deferred<void>(),order:string[]=[];
  const client=new GmgnClient({apiKey:key(),minIntervalMs:0,fetcher:async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==='/v1/market/token_signal'){
      order.push('market-start');entered.resolve();
      await new Promise<void>((_resolve,reject)=>{
        const abort=()=>{order.push('market-abort');reject(new Error('ABORTED'));};
        if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
      });
    }
    const marker=url.searchParams.get('marker')??url.pathname;order.push(marker);
    return response({code:0,data:marker});
  }});
  const market=client.getMemeMarketSignals('sol',{priority:'signal_poll',queueTimeoutMs:15_000});
  await entered.promise;
  const rejected=assert.rejects(market,rejects('GMGN_REQUEST_ABORTED'));
  const live=client.get('/v1/trade/quote',{chain:'sol',marker:'live'},10,{priority:'live_entry'});
  await rejected;assert.equal(await live,'live');
  assert.deepEqual(order,['market-start','market-abort','live']);
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

test('a finite normal burst runs before a newly queued background job', async () => {
  const entered = deferred<void>(), release = deferred<void>(), order: string[] = [];
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async input => {
    const marker = new URL(String(input)).searchParams.get('marker')!;
    order.push(marker);
    if (marker === 'blocker') {entered.resolve(); await release.promise;}
    return response({code: 0, data: marker});
  }});
  const blocker = client.get(route, {...query, marker: 'blocker'}); await entered.promise;
  const background = client.get(route, {...query, marker: 'background'}, 1,
    {priority: 'background', queueTimeoutMs: 1_000});
  const normal = Array.from({length: 32}, (_, index) =>
    client.get(route, {...query, marker: `normal-${index}`}));
  release.resolve();
  await Promise.all([blocker, background, ...normal]);
  assert.deepEqual(order.slice(0, 3), ['blocker', 'normal-0', 'normal-1']);
  assert.equal(order.at(-1), 'background');
});

test('sustained normal contention yields one complete background fairness turn',
  {timeout:7_000},async()=>{
  const entered=deferred<void>(),release=deferred<void>(),order:string[]=[];
  const client=new GmgnClient({apiKey:key(),minIntervalMs:0,fetcher:async input=>{
    const marker=new URL(String(input)).searchParams.get('marker')!;order.push(marker);
    if(marker==='blocker'){entered.resolve();await release.promise;}
    return response({code:0,data:marker});
  }});
  const blocker=client.get(route,{...query,marker:'blocker'});await entered.promise;
  const backgrounds=['background-0','background-1'].map(marker=>client.get(route,{...query,marker},1,
    {priority:'background',queueTimeoutMs:5_000}));
  const normals=['normal-0','normal-1'].map(marker=>client.get(route,{...query,marker}));
  await new Promise(resolve=>setTimeout(resolve,4_050));release.resolve();
  await Promise.all([blocker,...backgrounds,...normals]);
  assert.deepEqual(order,['blocker','background-0','normal-0','normal-1','background-1']);
});

test('live entry remains ahead of normal and a newly queued background job', async () => {
  const entered = deferred<void>(), release = deferred<void>(), order: string[] = [];
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async input => {
    const marker = new URL(String(input)).searchParams.get('marker')!;
    order.push(marker);
    if (marker === 'blocker') {entered.resolve(); await release.promise;}
    return response({code: 0, data: marker});
  }});
  const blocker = client.get(route, {...query, marker: 'blocker'}); await entered.promise;
  const background = client.get(route, {...query, marker: 'background'}, 1, {priority: 'background'});
  const normal = client.get(route, {...query, marker: 'normal'});
  const live = client.get(route, {...query, marker: 'live'}, 1, {priority: 'live_entry'});
  release.resolve();
  await Promise.all([blocker, background, normal, live]);
  assert.deepEqual(order, ['blocker', 'live', 'normal', 'background']);
});

test('new background jobs do not pass a finite normal burst', async () => {
  const entered = deferred<void>(), release = deferred<void>(), order: string[] = [];
  const client = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async input => {
    const marker = new URL(String(input)).searchParams.get('marker')!;
    order.push(marker);
    if (marker === 'blocker') {entered.resolve(); await release.promise;}
    return response({code: 0, data: marker});
  }});
  const blocker = client.get(route, {...query, marker: 'blocker'}); await entered.promise;
  const backgrounds = ['background-0', 'background-1'].map(marker =>
    client.get(route, {...query, marker}, 1, {priority: 'background'}));
  const normal = ['normal-0', 'normal-1'].map(marker => client.get(route, {...query, marker}));
  release.resolve();
  await Promise.all([blocker, ...backgrounds, ...normal]);
  assert.deepEqual(order, ['blocker', 'normal-0', 'normal-1', 'background-0', 'background-1']);
});

test('normal traffic on one credential cannot delay background work on another', async () => {
  const entered = deferred<void>(), release = deferred<void>(), backgroundStarted = deferred<void>();
  const busy = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async () => {
    entered.resolve(); await release.promise;
    return response({code: 0, data: 'normal'});
  }});
  const independent = new GmgnClient({apiKey: key(), minIntervalMs: 0, fetcher: async () => {
    backgroundStarted.resolve();
    return response({code: 0, data: 'background'});
  }});
  const blocker = busy.get(route, query); await entered.promise;
  const normal = Array.from({length: 16}, () => busy.get(route, query));
  const background = independent.get(route, query, 1, {priority: 'background'});
  await backgroundStarted.promise;
  assert.equal(await background, 'background');
  release.resolve(); await blocker; await Promise.all(normal);
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

test('Market Signal alone has a bounded 4 MiB response allowance', async () => {
  const accepted='x'.repeat(3*1024*1024);
  const client=new GmgnClient({apiKey:key(),minIntervalMs:0,
    fetcher:async()=>response({code:0,data:accepted})});
  assert.equal(String(await client.getMemeMarketSignals('sol')).length,accepted.length);

  for(const fetcher of [
    async()=>new Response('{}',{headers:{'content-length':String(4*1024*1024+1)}}),
    async()=>new Response(new ReadableStream({start(controller){
      controller.enqueue(new Uint8Array(4*1024*1024));controller.enqueue(new Uint8Array(1));controller.close();
    }})),
  ] satisfies (typeof fetch)[]){
    const oversized=new GmgnClient({apiKey:key(),minIntervalMs:0,fetcher});
    await assert.rejects(oversized.getMemeMarketSignals('sol'),rejects('GMGN_RESPONSE_TOO_LARGE'));
  }
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
