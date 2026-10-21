import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ChainHttp,DexPoolData} from '../src/chain-data.js';
import {CHAIN_PRICE_DEPLOYMENTS as D} from '../src/chain-prices.js';
import type {Chain} from '../src/types.js';

const privateUrl='https://provider.invalid/rpc/private-secret?key=private-secret';
const ca='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40);
const fetchReply=(result:unknown):typeof fetch=>async(_input,init)=>Response.json({jsonrpc:'2.0',id:JSON.parse(String(init?.body)).id,result});
const pair=(patch:Record<string,unknown>={})=>({chainId:'bsc',pairAddress:ca,baseToken:{address:D.wbnb},quoteToken:{address:D.usdtBsc},priceUsd:'600',liquidity:{usd:100000},...patch});
const dex=(rows:unknown,options:ConstructorParameters<typeof DexPoolData>[1]={})=>new DexPoolData(async()=>Response.json(rows),{intervalMs:0,...options});

test('RPC serializes read-only calls, snapshots parameters, pins response ID and preserves valid null results',async()=>{
  const calls:any[]=[],times:number[]=[];
  const fetcher:typeof fetch=async(input,init)=>{assert.equal(input,privateUrl);assert.equal(init?.redirect,'error');assert.equal(init?.method,'POST');
    assert.ok(init?.signal instanceof AbortSignal);const body=JSON.parse(String(init?.body));calls.push(body);times.push(Date.now());
    return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='eth_chainId'?'0x38':null});};
  const rpc=new ChainHttp(privateUrl,fetcher,25),params:unknown[]=[{fromBlock:'0x1'}];
  const first=rpc.request('eth_chainId'),second=rpc.request('eth_getLogs',params);(params[0] as any).fromBlock='0xffff';
  assert.deepEqual(await Promise.all([first,second]),['0x38',null]);assert.deepEqual(calls.map(c=>c.id),[1,2]);
  assert.equal(calls[1].params[0].fromBlock,'0x1');assert.ok(times[1]-times[0]>=20);rpc.stop();
});

test('RPC rejects malformed envelopes without returning provider text or credential-shaped errors',async()=>{
  for(const raw of [{jsonrpc:'2.0',id:999,result:'bad'},{id:1,result:'bad'},{jsonrpc:'2.0',id:1},
    {jsonrpc:'2.0',id:1,error:{message:privateUrl}},{jsonrpc:'2.0',id:1,result:'bad',error:null},[]]) {
    const rpc=new ChainHttp(privateUrl,async()=>Response.json(raw),0);
    await assert.rejects(rpc.request('eth_chainId'),/^Error: CHAIN_RPC_REJECTED$/);rpc.stop();
  }
  for(const text of [privateUrl,'CHAIN_PRIVATE_SECRET']) {
    const rpc=new ChainHttp(privateUrl,async()=>{throw new Error(text);},0);
    await assert.rejects(rpc.request('eth_chainId'),/^Error: CHAIN_HTTP_FAILED$/);rpc.stop();
  }
  const malformed=new ChainHttp(privateUrl,async()=>new Response('{"private-secret":'),0);
  await assert.rejects(malformed.request('eth_chainId'),/^Error: CHAIN_HTTP_FAILED$/);malformed.stop();
});

test('RPC rejects writes, cyclic/oversized params and malformed input before any network request',async()=>{
  let calls=0;const rpc=new ChainHttp(privateUrl,async()=>{calls++;return Response.json({});},0);
  const cyclic:any[]=[];cyclic.push(cyclic);
  for(const [method,params] of [['eth_sendRawTransaction',[]],['sendTransaction',[]],['eth_chainId',{}],['eth_call',cyclic],['eth_call',['x'.repeat(1024*1024)]]] as const)
    await assert.rejects(rpc.request(method,params as unknown[]),/^Error: CHAIN_HTTP_REQUEST_INVALID$/);
  assert.equal(calls,0);rpc.stop();
});

test('decoded streaming response and advertised body size are bounded and cancelled',async()=>{
  for(const advertised of [false,true]) {
    let cancelled=false;
    const stream=new ReadableStream<Uint8Array>({start(controller){if(!advertised){controller.enqueue(new Uint8Array(3*1024*1024));controller.enqueue(new Uint8Array(2*1024*1024));}},
      cancel(){cancelled=true;}});
    const rpc=new ChainHttp(privateUrl,async()=>new Response(stream,{headers:advertised?{'content-length':String(5*1024*1024)}:{}}),0);
    await assert.rejects(rpc.request('eth_chainId'),/^Error: CHAIN_HTTP_TOO_LARGE$/);assert.equal(cancelled,true);rpc.stop();
  }
});

test('HTTP rejection cancels the body and 429 pauses subsequent requests until stop aborts the wait',async()=>{
  let calls=0,cancelled=false;
  const rpc=new ChainHttp(privateUrl,async()=>{calls++;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:429,headers:{'retry-after':'3600'}});},0);
  await assert.rejects(rpc.request('eth_chainId'),/^Error: CHAIN_HTTP_RATE_LIMITED$/);assert.equal(cancelled,true);
  const next=rpc.request('eth_blockNumber'),assertion=assert.rejects(next,/^Error: CHAIN_STOPPED$/);
  await delay(15);assert.equal(calls,1);rpc.stop();await assertion;
  await assert.rejects(rpc.request('eth_chainId'),/^Error: CHAIN_STOPPED$/);
});

test('stop resolves active and queued requests even if a provider ignores AbortSignal; late bodies are cancelled',async()=>{
  let release!:(response:Response)=>void,started!:(value?:unknown)=>void,cancelled=false;
  const entered=new Promise(resolve=>{started=resolve;});
  const rpc=new ChainHttp(privateUrl,async()=>{started();return new Promise(resolve=>{release=resolve;});},0);
  const results=Promise.allSettled([rpc.request('eth_chainId'),rpc.request('eth_blockNumber')]);
  await entered;rpc.stop();
  for(const result of await results){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.equal(result.reason.message,'CHAIN_STOPPED');}
  release(new Response(new ReadableStream({cancel(){cancelled=true;}})));await delay(0);assert.equal(cancelled,true);
});

test('caller deadline aborts rate-limit cooldown and stalled fetches without stopping the shared client',async()=>{
  for(const cooling of [true,false]){
    let calls=0;const rpc=new ChainHttp(privateUrl,async()=>{calls++;return cooling?new Response('',{status:429,headers:{'retry-after':'60'}}):new Promise(()=>{});},0,10000);
    if(cooling)await assert.rejects(rpc.request('eth_chainId'),/^Error: CHAIN_HTTP_RATE_LIMITED$/);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20);
    try{await assert.rejects(rpc.request('eth_blockNumber',[],controller.signal),/^Error: CHAIN_HTTP_ABORTED$/);assert.equal(calls,1);}
    finally{clearTimeout(timer);rpc.stop();}
  }
});

test('request timeout covers ignored fetch aborts and stalled response bodies',async()=>{
  for(const stallBody of [false,true]) {
    let cancelled=false;
    const rpc=new ChainHttp(privateUrl,async()=>stallBody?new Response(new ReadableStream({cancel(){cancelled=true;}})):new Promise(()=>{}),0,20);
    await assert.rejects(rpc.request('eth_chainId'),/^Error: CHAIN_HTTP_TIMEOUT$/);
    if(stallBody)assert.equal(cancelled,true);rpc.stop();
  }
});

test('RPC queue has a hard bound and stop drains all accepted work without new fetches',async()=>{
  let calls=0;const rpc=new ChainHttp(privateUrl,async()=>{calls++;return new Promise(()=>{});},0);
  const waiting=Promise.allSettled(Array.from({length:60},()=>rpc.request('eth_chainId')));
  await assert.rejects(rpc.request('eth_chainId'),/^Error: CHAIN_HTTP_QUEUE_FULL$/);rpc.stop();
  assert.ok((await waiting).every(item=>item.status==='rejected'));assert.ok(calls<=1);
});

test('Dex concurrent lookups share retrieval, returned objects cannot poison cache, and cache age never renews on hits',async()=>{
  let now=Date.parse('2026-10-11T10:00:00.000Z'),calls=0;
  const market=new DexPoolData(async(input,init)=>{calls++;assert.equal(String(input),`https://api.dexscreener.com/token-pairs/v1/bsc/${D.wbnb}`);
    assert.equal(init?.redirect,'error');return Response.json([pair({rawRpc:privateUrl})]);},{now:()=>now,intervalMs:0});
  const [pairs,initial]=await Promise.all([market.pairs('bsc',D.wbnb.toUpperCase()),market.anchor('bsc',D.wbnb)]);
  assert.equal(calls,1);assert.equal(initial.observedAt,new Date(now).toISOString());assert.equal(initial.source,'vendor_reference');
  assert.equal(JSON.stringify(pairs).includes('private-secret'),false);
  pairs[0].priceUsd=100000;pairs[0].quoteToken.address=other;pairs.length=0;
  now+=44000;const cached=await market.anchor('bsc',D.wbnb);assert.equal(cached.priceUsd,600);assert.equal(cached.observedAt,initial.observedAt);assert.equal(calls,1);
  now+=1001;const refreshed=await market.anchor('bsc',D.wbnb);assert.equal(calls,2);assert.equal(refreshed.observedAt,new Date(now).toISOString());market.stop();
});

test('anchor permits only canonical quote assets and never mistakes a token-side price for quote USD price',async()=>{
  let calls=0;const market=new DexPoolData(async()=>{calls++;return Response.json([pair()]);},{intervalMs:0});
  await assert.rejects(market.anchor('bsc',other),/^Error: CHAIN_USD_REFERENCE_UNAVAILABLE$/);
  await assert.rejects(market.anchor('robinhood',D.wbnb),/^Error: CHAIN_USD_REFERENCE_UNAVAILABLE$/);assert.equal(calls,0);market.stop();
  for(const rows of [[pair({baseToken:{address:other},quoteToken:{address:D.wbnb}})],
    [pair({quoteToken:{address:other}})],[pair({chainId:'robinhood'})],
    [pair({liquidity:{usd:'1e309'}})],[pair({liquidity:{usd:9999}})],
    [pair({priceUsd:'Infinity'})],[pair({priceUsd:true})],[pair({priceUsd:0})]]) {
    const m=dex(rows);await assert.rejects(m.anchor('bsc',D.wbnb),/^Error: CHAIN_USD_REFERENCE_UNAVAILABLE$/);m.stop();
  }
});

test('references use distinct liquid pools, reject large disagreement and preserve observed stablecoin depegs',async()=>{
  const m=dex([pair(),pair({priceUsd:6000}),pair({pairAddress:other,priceUsd:610}),pair({pairAddress:'0x'+'d'.repeat(40),priceUsd:605})]);
  assert.equal((await m.anchor('bsc',D.wbnb)).priceUsd,605);assert.equal((await m.pairs('bsc',D.wbnb)).length,3);m.stop();
  const divergent=dex([pair(),pair({pairAddress:other,priceUsd:900})]);
  await assert.rejects(divergent.anchor('bsc',D.wbnb),/^Error: CHAIN_USD_REFERENCE_INCONSISTENT$/);divergent.stop();
  const depeg=dex([pair({baseToken:{address:D.usdtBsc},quoteToken:{address:D.usdcBsc},priceUsd:'0.82'})]);
  assert.equal((await depeg.anchor('bsc',D.usdtBsc)).priceUsd,0.82);depeg.stop();
  const sol=dex([pair({chainId:'solana',pairAddress:'11111111111111111111111111111111',baseToken:{address:D.wsol},quoteToken:{address:D.usdcSol},priceUsd:'200'})]);
  assert.equal((await sol.anchor('solana',D.wsol)).priceUsd,200);sol.stop();
});

test('pool discovery rejects chain/address spoofing, de-duplicates and bounds results but never claims on-chain verification',async()=>{
  const rows=Array.from({length:25},(_,i)=>pair({pairAddress:'0x'+(i+1).toString(16).padStart(40,'0'),liquidity:{usd:(i+1)*10000}}));
  const m=dex([...rows,pair({chainId:'solana'}),pair({pairAddress:'bad'}),pair({baseToken:{address:other},quoteToken:{address:ca}})]);
  const result=await m.pairs('bsc',D.wbnb);assert.equal(result.length,20);assert.equal(result[0].liquidity.usd,250000);
  assert.equal(Object.hasOwn(result[0],'verification'),false);m.stop();
});

test('Dex errors are sanitized and bounded JSON reader applies to market responses too',async()=>{
  for(const providerError of [privateUrl,'CHAIN_PRIVATE_SECRET']) {
    const m=new DexPoolData(async()=>{throw new Error(providerError);},{intervalMs:0});
    await assert.rejects(m.pairs('bsc',D.wbnb),/^Error: CHAIN_MARKET_REFERENCE_UNAVAILABLE$/);m.stop();
  }
  const huge=new DexPoolData(async()=>new Response('x',{headers:{'content-length':String(10*1024*1024)}}),{intervalMs:0});
  await assert.rejects(huge.pairs('bsc',D.wbnb),/^Error: CHAIN_HTTP_TOO_LARGE$/);huge.stop();
  const invalid=dex({privateUrl});await assert.rejects(invalid.pairs('bsc',D.wbnb),/^Error: CHAIN_MARKET_REFERENCE_UNAVAILABLE$/);invalid.stop();
  const noNetwork=new DexPoolData(async()=>{throw new Error('MUST_NOT_FETCH');},{intervalMs:0});
  await assert.rejects(noNetwork.pairs('eth' as Chain,D.wbnb),/^Error: CHAIN_ADDRESS_INVALID$/);noNetwork.stop();
});

test('Dex stop invalidates cached results and aborts pending work, including an unresponsive provider',async()=>{
  const cached=dex([pair()]);await cached.pairs('bsc',D.wbnb);cached.stop();
  await assert.rejects(cached.pairs('bsc',D.wbnb),/^Error: CHAIN_STOPPED$/);
  await assert.rejects(cached.anchor('bsc',D.wbnb),/^Error: CHAIN_STOPPED$/);
  let entered!:(v?:unknown)=>void;const started=new Promise(resolve=>{entered=resolve;});
  const pending=new DexPoolData(async()=>{entered();return new Promise(()=>{});},{intervalMs:0});
  const assertions=[assert.rejects(pending.pairs('bsc',D.wbnb),/^Error: CHAIN_STOPPED$/),assert.rejects(pending.pairs('bsc',D.usdtBsc),/^Error: CHAIN_STOPPED$/)];
  await started;pending.stop();await Promise.all(assertions);
});

test('Dex 429 cooldown stops new provider requests and remains promptly stoppable',async()=>{
  let calls=0;const m=new DexPoolData(async()=>{calls++;return new Response(null,{status:429});},{intervalMs:0});
  await assert.rejects(m.pairs('bsc',D.wbnb),/^Error: CHAIN_HTTP_RATE_LIMITED$/);
  const check=assert.rejects(m.pairs('bsc',D.usdtBsc),/^Error: CHAIN_STOPPED$/);await delay(15);assert.equal(calls,1);m.stop();await check;
});
