import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {MarketPriceRouter,type MarketPriceSample} from '../src/market-price-router.js';
import {GmgnError} from '../src/providers/gmgn-client.js';
import type {ScanToken} from '../src/scan-archive.js';
import type {Fetcher} from '../src/http.js';

const epoch=Date.parse('2026-10-16T00:00:00.000Z');
const token=(n=1,chain:ScanToken['chain']='bsc'):ScanToken=>({chain,address:chain==='solana'?bs58.encode(new Uint8Array(32).fill(n)):'0x'+n.toString(16).padStart(40,'0')});
const iso=(offset=0)=>new Date(epoch+offset).toISOString();
const json=(body:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
const pair=(t:ScanToken,price='1',pool=token(255,t.chain).address,liquidity=10_000)=>({chainId:t.chain,baseToken:{address:t.address},quoteToken:{address:token(250,t.chain).address},pairAddress:pool,priceUsd:price,liquidity:{usd:liquidity}});
const ave=(rows:unknown[])=>({jsonrpc:'2.0',result:{status:'ok',data:{event:'pricev2',prices:rows}}});
const aveRow=(t:ScanToken,price=1,time=epoch/1000)=>({chain:t.chain,token:t.address,target_token:t.address,pair:token(254,t.chain).address,is_main_pair:true,uprice:price,last_price:999999,time});
const fetcher=(fn:(url:URL,signal?:AbortSignal|null)=>Promise<Response>):Fetcher=>((input,init)=>fn(new URL(String(input)),init?.signal)) as Fetcher;

test('websocket-first reads send no HTTP while matched push prices are fresh; stale pushes use bounded fallback',async()=>{
  let time=epoch,calls=0;
  const router=new MarketPriceRouter({now:()=>new Date(time),preferStreams:true,minHttpIntervalMs:30000,
    maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:fetcher(async()=>{calls++;return json([pair(token())]);})});
  router.ingestAvePriceFrame(ave([aveRow(token())]),iso());
  assert.equal((await router.read([token()])).samples[0].source,'ave_price_stream_sample');assert.equal(calls,0);
  time+=31000;assert.equal((await router.read([token()])).samples[0].source,'dexscreener_token_pairs_sample');assert.equal(calls,1);
  time+=5000;await router.read([token()]);assert.equal(calls,1);
  assert.equal(router.latestStream(token())?.observedAt,iso(),'HTTP must not renew the stream timestamp');
  router.ingestAvePriceFrame(ave([aveRow(token(),1,time/1000)]),new Date(time).toISOString());
  await router.read([token()]);assert.equal(calls,1);
  time+=31000;await router.read([token()]);assert.equal(calls,2);router.close();
});

test('overlapping monitor loops reserve a single HTTP fallback attempt per token',async()=>{
  let calls=0,release!:()=>void;const ready=new Promise<void>(resolve=>release=resolve);
  const router=new MarketPriceRouter({now:()=>new Date(epoch),preferStreams:true,minHttpIntervalMs:30000,
    maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:fetcher(async()=>{calls++;await ready;return json([pair(token())]);})});
  const first=router.read([token()]);await router.read([token()]);assert.equal(calls,1);
  release();await first;assert.equal(router.latest(token()).status,'available');router.close();
});

test('one healthy streamed token does not suppress fallback for a different missing holding',async()=>{
  const requested:string[]=[];
  const router=new MarketPriceRouter({now:()=>new Date(epoch),preferStreams:true,minHttpIntervalMs:30000,
    maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:fetcher(async url=>{requested.push(url.pathname);return json([pair(token(2))]);})});
  router.ingestAvePriceFrame(ave([aveRow(token())]),iso());
  const batch=await router.read([token(),token(2)]);assert.equal(batch.samples.length,2);
  assert.equal(requested.length,1);assert.ok(requested[0].endsWith(token(2).address));assert.equal(requested[0].includes(token().address),false);
  router.close();
});

test('GMGN shared cooldown does not block independent batch spot prices or DeBot fallback',async()=>{
  const calls:string[]=[],samples:MarketPriceSample[]=[];
  const router=new MarketPriceRouter({now:()=>new Date(epoch),client:{cooldownUntil:epoch+180_000,async get(){throw new Error('must not call');}},
    fetcher:fetcher(async url=>{calls.push(url.hostname);return url.hostname==='api.dexscreener.com'?json([pair(token())]):json({code:0,data:{meta:token(2),market:{price:2}}});})});
  const result=await router.read([token(),token(2)],{onSample:s=>samples.push(s)});
  assert.equal(result.samples.length,2);assert.equal(result.gaps.length,0);assert.equal(result.requests.gmgn,0);
  assert.deepEqual(samples.map(s=>s.source),['dexscreener_token_pairs_sample','debot_token_info_sample']);
  assert.equal(router.getStatus().sources.gmgn.state,'cooldown');
  assert.deepEqual(calls,['api.dexscreener.com','debot.ai']);
  assert.ok(samples.every(s=>s.scope==='observed_spot_not_executable_quote'));
});

test('a hung GMGN call cannot delay successful Dex delivery and is cancelled at its own deadline',async()=>{
  const samples:MarketPriceSample[]=[];let scoped:AbortSignal|undefined,started=false;
  const client={cooldownUntil:0,async get(){started=true;return new Promise(()=>{});},withSignal(signal:AbortSignal){scoped=signal;return this as any;}};
  const router=new MarketPriceRouter({now:()=>new Date(epoch),client,gmgnTimeoutMs:25,maxDebotPerBatch:0,
    fetcher:fetcher(async()=>json([pair(token())]))});
  const promise=router.read([token(),token(2)],{onSample:s=>samples.push(s)});
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(samples.length,1);assert.equal(started,true);assert.equal(scoped?.aborted,false);
  const result=await promise;
  assert.equal(result.samples.length,1);assert.equal(result.gaps.length,1);assert.equal(scoped?.aborted,true);
  assert.equal(result.sourceErrors.gmgn,'PRICE_SOURCE_TIMEOUT');
});

test('Dex 429 cools down only Dex; DeBot succeeds and GMGN may stay limited',async()=>{
  let time=epoch,dexCalls=0,debotCalls=0;
  const router=new MarketPriceRouter({now:()=>new Date(time),client:{cooldownUntil:epoch+300_000,async get(){throw new Error('must not call');}},
    fetcher:fetcher(async url=>{if(url.hostname==='api.dexscreener.com'){dexCalls++;return json({},429,{'retry-after':'120'});}
      debotCalls++;return json({code:0,data:{meta:token(),market:{price:1}}});})});
  assert.equal((await router.read([token()])).samples.length,1);
  assert.equal(router.getStatus().sources.dexscreener.state,'cooldown');assert.equal(router.getStatus().sources.debot.state,'available');
  time+=1000;assert.equal((await router.read([token()])).samples.length,1);
  assert.equal(dexCalls,1);assert.equal(debotCalls,1);
  assert.equal(router.getStatus().sources.dexscreener.cooldownUntil,iso(120_000));
});

test('DeBot and GMGN fallback run on distinct missing tokens; a hung fallback does not delay the other callback',async()=>{
  const samples:MarketPriceSample[]=[];
  const router=new MarketPriceRouter({now:()=>new Date(epoch),httpTimeoutMs:30,gmgnTimeoutMs:10,maxDebotPerBatch:1,
    fetcher:fetcher(async url=>url.hostname==='api.dexscreener.com'?json([]):new Promise(()=>{})),
    client:{cooldownUntil:0,async get(_path,query){return {address:query.address,chain:query.chain,price:{price:'3'}};}}});
  const operation=router.read([token(),token(2)],{onSample:s=>samples.push(s)});
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(samples.length,1);assert.equal(samples[0].address,token(2).address);
  const result=await operation;assert.equal(result.requests.gmgn,1);assert.equal(result.requests.debot,1);
  assert.equal(result.gaps.length,1);assert.equal(result.sourceErrors.debot,'PRICE_SOURCE_TIMEOUT');
});

test('limits batches to 30 full addresses and keeps same CA on different chains separate',async()=>{
  const sizes:number[]=[],chains:string[]=[];
  const targets=[...Array.from({length:31},(_,i)=>token(i+1)),token(1,'solana'),token(2,'solana')];
  const router=new MarketPriceRouter({now:()=>new Date(epoch),maxDebotPerBatch:0,maxGmgnPerBatch:0,
    fetcher:fetcher(async url=>{const parts=url.pathname.split('/'),chain=parts.at(-2) as ScanToken['chain'],addresses=parts.at(-1)!.split(',');
      sizes.push(addresses.length);chains.push(chain);return json(addresses.map(address=>pair({chain,address})));})});
  const result=await router.read(targets);assert.equal(result.samples.length,33);assert.equal(result.requests.dexscreener,3);
  assert.deepEqual(sizes.sort((a,b)=>a-b),[1,2,30]);assert.ok(chains.includes('solana'));
  assert.equal(router.latest({...token(),chain:'robinhood'}).status,'unavailable');
});

test('wrong chain/base token and quote-only, ATH-only rows never become current observations',async()=>{
  const router=new MarketPriceRouter({now:()=>new Date(epoch),maxDebotPerBatch:0,maxGmgnPerBatch:0,
    fetcher:fetcher(async()=>json([
      {...pair(token()),chainId:'ethereum'},
      {...pair(token(2)),quoteToken:{address:token().address}},
      {...pair(token()),priceUsd:undefined,ath_price:99},
      {...pair(token()),baseToken:{address:token().address.slice(0,-1)}}
    ]))});
  const result=await router.read([token()]);assert.equal(result.samples.length,0);assert.equal(result.gaps[0].reason,'PRICE_NO_FRESH_SOURCE');
});

test('Ave uses exact current-price channel, matching target, main pair and real fresh event time',()=>{
  let time=epoch+10_000;const router=new MarketPriceRouter({now:()=>new Date(time)});
  assert.equal(router.ingestAvePriceFrame(ave([aveRow(token(),1)]),iso(10_000)),1);
  assert.equal(router.latest(token()).sample?.priceUsd,1);assert.equal(router.latest(token()).sample?.observedAt,iso());
  assert.equal(router.latest(token()).sample?.validUntil,iso(30_000));
  assert.equal(router.ingestAvePriceFrame(ave([aveRow(token(),1)]),iso(10_000)),0);
  for(const row of [
    {...aveRow(token(2)),time:epoch/1000-100},
    {...aveRow(token(2)),time:epoch/1000+11},
    {...aveRow(token(2)),target_token:token(3).address},
    {...aveRow(token(2)),is_main_pair:false},
    {...aveRow(token(2)),uprice:undefined,max_price:99},
    {...aveRow(token(2)),chain:'eth'},
  ])assert.equal(router.ingestAvePriceFrame(ave([row]),iso(10_000)),0);
  assert.equal(router.ingestAvePriceFrame({result:{status:'ok',data:{event:'signalsv2_public_monitor',prices:[aveRow(token(2))]}}}),0);
  assert.equal(router.latest(token(2)).status,'unavailable');
  time=epoch+30_000;assert.equal(router.latest(token()).status,'unavailable');
  time=epoch+41_000;assert.equal(router.getStatus().sources.ave.state,'unavailable');
});

test('future and time-regressing stream events cannot reset freshness or overwrite newer observations',()=>{
  let time=epoch+20_000;const router=new MarketPriceRouter({now:()=>new Date(time)});
  const base={source:'debot' as const,token:token(),priceUsd:2,eventAt:iso(19_000),receivedAt:iso(20_000),kind:'current_price_update' as const};
  assert.equal(router.observeStream(base),true);
  assert.equal(router.observeStream({...base,eventAt:iso(18_000),priceUsd:99}),false);
  assert.equal(router.observeStream({...base,eventAt:iso(21_000)}),false);
  assert.equal(router.observeStream({...base,receivedAt:iso(21_000)}),false);
  assert.equal(router.latest(token()).sample?.priceUsd,2);
  assert.equal(router.latest(token()).sample?.validUntil,iso(49_000));
  time=epoch+50_000;assert.equal(router.latest(token()).status,'unavailable');
});

test('near-simultaneous cross-source disputes and conflicting same-time updates are explicit, not prices',()=>{
  const router=new MarketPriceRouter({now:()=>new Date(epoch+1000)});
  for(const [source,priceUsd]of [['ave',1],['debot',2]] as const)router.observeStream({source,priceUsd,token:token(),eventAt:iso(),receivedAt:iso(1000),kind:'current_price_update'});
  const route=router.latest(token());assert.equal(route.status,'conflict');assert.equal(route.sample,undefined);assert.equal(route.sources.length,2);
  assert.equal(router.getStatus().conflictedTokens,1);
  router.observeStream({source:'ave',priceUsd:1,token:token(2),eventAt:iso(),receivedAt:iso(1000),kind:'current_price_update'});
  assert.equal(router.observeStream({source:'ave',priceUsd:3,token:token(2),eventAt:iso(),receivedAt:iso(1000),kind:'current_price_update'}),false);
  assert.equal(router.latest(token(2)).reason,'PRICE_SAME_TIME_CONFLICT');
});

test('a genuine 50% meme move over twenty seconds uses the newest observation rather than a false conflict',()=>{
  let time=epoch;const router=new MarketPriceRouter({now:()=>new Date(time)});
  router.observeStream({source:'ave',priceUsd:1,token:token(),eventAt:iso(),receivedAt:iso(),kind:'current_price_update'});
  time+=20_000;
  router.observeStream({source:'debot',priceUsd:1.5,token:token(),eventAt:iso(20_000),receivedAt:iso(20_000),kind:'current_price_update'});
  assert.equal(router.latest(token()).status,'available');assert.equal(router.latest(token()).sample?.priceUsd,1.5);
  assert.equal(router.latest(token()).sources.length,2);
});

test('significantly divergent liquid pools and contradictory same-pool rows are quarantined',async()=>{
  for(const rows of [[pair(token(),'1'),pair(token(),'5',token(254).address,5000)], [pair(token(),'1'),pair(token(),'2')]]) {
    const router=new MarketPriceRouter({now:()=>new Date(epoch),maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:fetcher(async()=>json(rows))});
    const samples:MarketPriceSample[]=[];const result=await router.read([token()],{onSample:s=>samples.push(s)});
    assert.equal(result.gaps[0].reason,'PRICE_POOL_CONFLICT');assert.equal(samples.length,0);assert.equal(result.samples.length,0);
  }
});

test('HTTP cache age reduces remaining freshness and stale cache, clock regression and oversized replies fail closed',async()=>{
  const router=new MarketPriceRouter({now:()=>new Date(epoch+20_000),maxDebotPerBatch:0,maxGmgnPerBatch:0,
    fetcher:fetcher(async()=>json([pair(token())],200,{age:'20'}))});
  const sample=(await router.read([token()])).samples[0];assert.equal(sample.observedAt,iso());assert.equal(sample.receivedAt,iso(20_000));assert.equal(sample.validUntil,iso(30_000));
  for(const headers of [{age:'31'},{age:'invalid'},{'content-length':'3000000'}] as Record<string,string>[]) {
    const r=new MarketPriceRouter({now:()=>new Date(epoch),maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:fetcher(async()=>json([pair(token())],200,headers))});
    assert.equal((await r.read([token()])).samples.length,0);
  }
  let clock=epoch;
  const backwards=new MarketPriceRouter({now:()=>new Date(clock),maxDebotPerBatch:0,maxGmgnPerBatch:0,
    fetcher:fetcher(async()=>{clock--;return json([pair(token())]);})});
  assert.equal((await backwards.read([token()])).sourceErrors.dexscreener,'PRICE_CLOCK_REGRESSED');
});

test('one fresh cached event is published once without retimestamping, and stop cancels noncooperative HTTP',async()=>{
  const router=new MarketPriceRouter({now:()=>new Date(epoch),maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:fetcher(async()=>json([]))});
  router.observeStream({source:'ave',token:token(),priceUsd:1,eventAt:iso(),receivedAt:iso(),kind:'current_price_update'});
  let count=0;
  await router.read([token()],{onSample:()=>count++});await router.read([token()],{onSample:()=>count++});assert.equal(count,1);
  let signal:AbortSignal|null|undefined;
  const hanging=new MarketPriceRouter({now:()=>new Date(epoch),fetcher:fetcher(async(_url,s)=>{signal=s;return new Promise(()=>{});})});
  const read=hanging.read([token()]);await Promise.resolve();hanging.close();
  const result=await read;assert.equal(result.samples.length,0);assert.equal(signal?.aborted,true);assert.equal(result.gaps[0].reason,'PRICE_REQUEST_CANCELLED');
});

test('GMGN failure has bounded weight-one budget and never prevents independent sources in the next cycle',async()=>{
  let time=epoch,calls=0;
  const router=new MarketPriceRouter({now:()=>new Date(time),maxDebotPerBatch:0,fetcher:fetcher(async()=>time===epoch?json([]):json([pair(token(),'3')])),
    client:{cooldownUntil:0,async get(_path,_query,weight){calls++;assert.equal(weight,1);throw new GmgnError('GMGN_RATE_LIMITED',epoch+120_000,epoch);}}});
  const first=await router.read([token(),token(2),token(3)]);assert.equal(first.requests.gmgn,1);assert.equal(first.gaps.length,3);
  time+=1000;const second=await router.read([token()]);assert.equal(second.samples.length,1);assert.equal(second.requests.gmgn,0);assert.equal(calls,1);
});

test('Ave current updates publish immediately without a polling request, with shared sample deduplication',async()=>{
  let time=epoch;const samples:MarketPriceSample[]=[];
  const router=new MarketPriceRouter({now:()=>new Date(time),maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:fetcher(async()=>json([]))});
  const capture=(s:MarketPriceSample)=>samples.push(s);
  assert.equal(router.ingestAvePriceFrame(ave([aveRow(token(),1)]),iso(),capture),1);
  assert.equal(samples.length,1);assert.equal(samples[0].priceUsd,1);
  // The subsequent poll and repeated delivery of the same price event produce no duplicate writes.
  await router.read([token()],{onSample:capture});
  router.ingestAvePriceFrame(ave([aveRow(token(),1)]),iso(),capture);assert.equal(samples.length,1);
  time+=1000;router.ingestAvePriceFrame(ave([aveRow(token(),0.6,time/1000)]),iso(1000),capture);
  assert.equal(samples.length,2);assert.equal(samples[1].priceUsd,0.6);
  router.close();time+=1000;router.ingestAvePriceFrame(ave([aveRow(token(),0.5,time/1000)]),iso(2000),capture);
  assert.equal(samples.length,2);
});

test('same-frame contradictory Ave prices are withheld before any callback; failed callback remains retryable',async()=>{
  const router=new MarketPriceRouter({now:()=>new Date(epoch),maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:fetcher(async()=>json([]))});
  let calls=0;
  router.ingestAvePriceFrame(ave([aveRow(token(),1),aveRow(token(),4)]),iso(),()=>calls++);
  assert.equal(calls,0);assert.equal(router.latest(token()).status,'conflict');
  assert.throws(()=>router.ingestAvePriceFrame(ave([aveRow(token(2),1)]),iso(),()=>{throw new Error('archive unavailable');}));
  await router.read([token(2)],{onSample:()=>calls++});assert.equal(calls,1);
});

test('Robinhood Dex current price accepts real Uniswap v4 pool ID without mislabeling it a contract',async()=>{
  const target:ScanToken={chain:'robinhood',address:'0x98096d17e191b3da1d5f99a6d7b3584351b11e18'};
  const poolId='0xfec7b1efe77aa60887986db5bcbfff39ca40b56d964bb8ce3d9dd0d9baaca4d4';
  let url='';
  const router=new MarketPriceRouter({now:()=>new Date(epoch),maxDebotPerBatch:0,maxGmgnPerBatch:0,
    fetcher:fetcher(async input=>{url=input.toString();return json([{chainId:'robinhood',dexId:'uniswap',labels:['v4'],
      pairAddress:poolId,baseToken:{address:target.address},priceUsd:'0.01730',liquidity:{usd:38_000}}]);})});
  const result=await router.read([target]);assert.equal(result.requests.dexscreener,1);assert.equal(result.samples.length,1);
  assert.equal(url,`https://api.dexscreener.com/tokens/v1/robinhood/${target.address}`);
  assert.equal(result.samples[0].priceUsd,0.0173);assert.equal(result.samples[0].market?.liquidityUsd,38_000);
  assert.equal(result.samples[0].market?.poolAddress,undefined);assert.equal(Object.hasOwn(result.samples[0].market??{},'poolAddress'),false);
  assert.equal(JSON.stringify(result.samples[0]).includes(poolId),false);
  assert.equal(router.latest({...target,chain:'bsc'}).status,'unavailable');
});

test('Robinhood can recover through independently authenticated DeBot current-price fallback',async()=>{
  const target:ScanToken={chain:'robinhood',address:'0x98096d17e191b3da1d5f99a6d7b3584351b11e18'};
  let debotCalls=0;
  const router=new MarketPriceRouter({now:()=>new Date(epoch),maxGmgnPerBatch:0,fetcher:fetcher(async()=>json([])),
    debotFetcher:fetcher(async url=>{debotCalls++;assert.equal(url.pathname,'/api/market/token/info');
      assert.equal(url.searchParams.get('chain'),'robinhood');assert.equal(url.searchParams.get('token'),target.address);
      return json({code:0,data:{meta:target,market:{price:0.017478,pair:''}}});})});
  const result=await router.read([target]);assert.equal(result.requests.debot,1);assert.equal(debotCalls,1);
  assert.equal(result.samples[0].priceUsd,0.017478);assert.equal(result.samples[0].source,'debot_token_info_sample');
  assert.equal(result.samples[0].chain,'robinhood');assert.equal(result.gaps.length,0);
});

test('EVM bytes32 pool identity preserves price-conflict checks and rejects invalid identities',async()=>{
  const target=token(1,'robinhood'),pool='0x'+'ab'.repeat(32);
  const conflicting=[pair(target,'1',pool),pair(target,'2',pool)];
  const router=new MarketPriceRouter({now:()=>new Date(epoch),maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:fetcher(async()=>json(conflicting))});
  assert.equal((await router.read([target])).gaps[0].reason,'PRICE_POOL_CONFLICT');
  for(const raw of [
    pair(target,'1','0x'+'0'.repeat(64)),pair(target,'1','0x'+'ab'.repeat(31)),
    {...pair(target,'1',pool),chainId:'bsc'},
    {...pair(target,'1',pool),baseToken:{address:token(2,'robinhood').address}},
  ]) {
    const r=new MarketPriceRouter({now:()=>new Date(epoch),maxDebotPerBatch:0,maxGmgnPerBatch:0,fetcher:fetcher(async()=>json([raw]))});
    assert.equal((await r.read([target])).samples.length,0);
  }
});

test('Robinhood Ave current-price stream accepts verified live schema without treating its pool ID as an address',()=>{
  const at=1792120690*1000,receivedAt=new Date(at+1000).toISOString();
  const router=new MarketPriceRouter({now:()=>new Date(at+1000)}),samples:MarketPriceSample[]=[];
  const address='0x98096d17e191b3da1d5f99a6d7b3584351b11e18';
  const poolId='0x9c89b04303dfa76f3f6fb02c2b77be0e8a00ab8fa00d507119acd54ab3e8640d';
  const count=router.ingestAvePriceFrame(ave([{chain:'robinhood',token:address,target_token:address,is_main_pair:true,
    uprice:0.017277,time:1792120690,pair:poolId}]),receivedAt,sample=>samples.push(sample));
  assert.equal(count,1);assert.equal(samples.length,1);assert.equal(samples[0].chain,'robinhood');
  assert.equal(samples[0].priceUsd,0.017277);assert.equal(samples[0].source,'ave_price_stream_sample');
  assert.equal(samples[0].market?.poolAddress,undefined);assert.equal(JSON.stringify(samples[0]).includes(poolId),false);
  assert.equal(router.latest({chain:'bsc',address}).status,'unavailable');
});

test('maximum Dex response is indexed once and yields before it can stall the event loop',async()=>{
  const targets=Array.from({length:30},(_,index)=>token(index+1));
  const rows=Array.from({length:10_000},(_,index)=>({chainId:'bsc',baseToken:{address:targets[index%targets.length].address},
    pairAddress:token(100+index%targets.length).address,priceUsd:'1'}));
  const body=JSON.stringify(rows);assert.ok(Buffer.byteLength(body)<2_000_000);
  let time=epoch;
  const router=new MarketPriceRouter({now:()=>new Date(time),maxDebotPerBatch:0,maxGmgnPerBatch:0,minHttpIntervalMs:0,
    fetcher:fetcher(async()=>new Response(body))});
  // Warm parsing/JIT independently from the event-loop assertion.
  assert.equal((await router.read(targets)).samples.length,30);time+=31_000;
  assert.equal((await router.read(targets)).samples.length,30);time+=31_000;
  let stopped=false,ticks=0;
  const pulse=()=>setImmediate(()=>{ticks++;if(!stopped)pulse();});pulse();
  const cpuStart=process.cpuUsage(),result=await router.read(targets),cpu=process.cpuUsage(cpuStart);
  stopped=true;await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(result.samples.length,30);assert.equal(result.gaps.length,0);
  assert.ok(ticks>=10,`Dex routing yielded only ${ticks} times`);
  const cpuMs=(cpu.user+cpu.system)/1000;assert.ok(cpuMs<100,`warm bounded Dex routing used ${cpuMs.toFixed(1)}ms CPU`);
});

test('pathological matching Sol pools fail closed within the bounded response without blocking',async()=>{
  const solAddress=(index:number)=>{const bytes=new Uint8Array(32);new DataView(bytes.buffer).setUint32(28,index);return bs58.encode(bytes);};
  const target:ScanToken={chain:'solana',address:solAddress(1)};
  const rows=Array.from({length:10_000},(_,index)=>({chainId:'solana',baseToken:{address:target.address},
    pairAddress:solAddress(index+2),priceUsd:'1'}));
  const body=JSON.stringify(rows);assert.ok(Buffer.byteLength(body)<2_000_000);
  const router=new MarketPriceRouter({now:()=>new Date(epoch),maxDebotPerBatch:0,maxGmgnPerBatch:0,
    fetcher:fetcher(async()=>new Response(body))});
  let stopped=false,ticks=0;
  const pulse=()=>setImmediate(()=>{ticks++;if(!stopped)pulse();});pulse();
  const cpuStart=process.cpuUsage(),result=await router.read([target]),cpu=process.cpuUsage(cpuStart);
  stopped=true;await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(result.samples.length,0);assert.equal(result.gaps[0].reason,'PRICE_NO_FRESH_SOURCE');
  assert.equal(result.sourceErrors.dexscreener,'DEX_PRICE_TOKEN_POOL_LIMIT_EXCEEDED');
  assert.equal(router.latest(target).status,'unavailable');
  assert.ok(ticks>=1,'bounded Sol response did not yield to the event loop');
  const cpuMs=(cpu.user+cpu.system)/1000;assert.ok(cpuMs<100,`bounded Sol response used ${cpuMs.toFixed(1)}ms CPU`);
});
