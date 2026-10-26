import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bs58 from 'bs58';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import type {ExitTracking} from '../src/orders.js';
import type {ScanToken} from '../src/scan-archive.js';
import type {Fetcher} from '../src/http.js';

const epoch=Date.parse('2026-10-25T13:30:00.000Z');
const address=(n:number)=>bs58.encode(new Uint8Array(32).fill(n));
const token=(n:number):ScanToken=>({chain:'solana',address:address(n)});
const wallet=address(80),native='So11111111111111111111111111111111111111112';
type Runtime=ReturnType<typeof createRuntime>;
function fixture(priceFetcher:Fetcher=async()=>{throw Error('PRICE_NETWORK_FORBIDDEN');}){
  const directory=mkdtempSync(join(tmpdir(),'position-price-runtime-'));
  const config=readConfig({ENTRY_MODE:'off',GMGN_BACKGROUND_RESEARCH_ENABLED:'false',
    SCANNER_ENABLED:'false',SCANNER_CHAINS:'solana',DASHBOARD_ENABLED:'false',WATCH_RECHECK_ENABLED:'false',
    EXIT_SHADOW_ENABLED:'false',CHAIN_STREAM_ENABLED:'false',WALLET_RESEARCH_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',
    DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'true',
    ORDERS_DATABASE_PATH:join(directory,'orders.sqlite'),SCAN_DATABASE_PATH:join(directory,'scans.sqlite'),
    AVE_SIGNALS_DATABASE_PATH:join(directory,'ave.sqlite'),AVE_SESSION_PATH:join(directory,'ave-session.json'),
    SOURCE_EVIDENCE_DATABASE_PATH:join(directory,'source-evidence.sqlite'),
    TELEGRAM_DATABASE_PATH:join(directory,'telegram.sqlite'),
    TELEGRAM_BOT_TOKEN:'123456:'+'A'.repeat(35),TELEGRAM_CHAT_ID:'123456789'});
  const runtime=createRuntime(config,{priceFetcher,
    telegramFetcher:async()=>{throw Error('TELEGRAM_NETWORK_FORBIDDEN');},
    heldFetcher:async()=>{throw Error('HOLDING_NETWORK_FORBIDDEN');},
    entryFetcher:async()=>{throw Error('TRADE_NETWORK_FORBIDDEN');}});
  return {runtime,directory,close:async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});}};
}
function observedProtection():ExitTracking {
  const checkedAt=new Date().toISOString();
  return {policy:{enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}},
    state:'monitoring',positionClosed:false,checkedAt,reasons:[],
    assessment:{status:'verified',reasons:[],found:true,policyMatched:true,hasLiveStop:true,terminal:false,conditions:[],checkedAt}};
}
function reserve(runtime:Runtime,n:number){
  const result=runtime.orders.reserve({eventKey:'synthetic-price-runtime:'+n,chain:'solana',tokenAddress:address(n),
    mode:'live',wallet,inputToken:native,inputAmount:'10000000',slippagePct:5,exit:observedProtection(),details:{}},10);
  assert.ok(result.created,result.reason??'synthetic position reservation must succeed');assert.ok(result.order);return result.order;
}
function confirm(runtime:Runtime,id:string,n:number){
  const order=runtime.orders.update(id,['prepared'],{status:'confirmed',providerOrderId:'synthetic-price-order-'+n,
    transactionHash:bs58.encode(new Uint8Array(64).fill(n)),outputAmount:'1000000',actualInputAmount:'10000000'});
  assert.ok(order);return order;
}

test('confirmed SOL opening synchronously subscribes its price as a holding priority without starting runtime or waiting for a timer',async t=>{
  t.mock.timers.enable({apis:['Date'],now:epoch});
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const f=fixture(),runtime=f.runtime;
  try{
    assert.ok(runtime.aveScanner);
    const subscriptions=t.mock.method(runtime.aveScanner,'setPriceTokens');
    const hasSubscription=t.mock.method(runtime.aveScanner,'hasPriceSubscription',()=>true);
    const prepared=reserve(runtime,31);
    const before=subscriptions.mock.callCount();
    const order=confirm(runtime,prepared.id,31);
    assert.ok(subscriptions.mock.callCount()>before,'the committed fill must refresh subscriptions immediately');
    assert.deepEqual(subscriptions.mock.calls.at(-1)?.arguments,[[token(31)],[token(31)]]);
    const subscribed=subscriptions.mock.callCount();
    for(const healthProbe of ['one','two','three'])assert.ok(runtime.orders.update(order.id,['confirmed'],
      {details:{...order.details,healthProbe}}));
    assert.equal(subscriptions.mock.callCount(),subscribed,
      'native protection heartbeats must not synchronously rescan unchanged holding subscriptions');
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(subscriptions.mock.callCount(),subscribed+1,
      'one event-loop turn coalesces a heartbeat burst into one health/subscription refresh');
    assert.ok(hasSubscription.mock.calls.some(call=>call.arguments[0]?.address===order.tokenAddress));
    const overview=runtime.dashboardOverview();
    assert.equal(overview.positionPriceStream.error,undefined);assert.equal(overview.positionPriceStream.health?.monitored,1);
    assert.equal(overview.positionPriceStream.mode,'multi_source_position_quotes');
    assert.equal(overview.positionPriceStream.primary,'native_sol_sell_quote');
    assert.deepEqual(overview.positionPriceStream.fallbacks,['ave_pricev2','dexscreener','debot','gmgn']);
    assert.equal(runtime.aveScanner.getStatus().running,false);assert.equal(Date.now(),epoch);
    assert.equal(network.mock.callCount(),0);
  }finally{await f.close();}
});

test('holding subscriptions retain other active tokens and immediately release an exit with verified zero-balance terminal evidence',async t=>{
  t.mock.timers.enable({apis:['Date'],now:epoch});
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const f=fixture(),runtime=f.runtime;
  try{
    assert.ok(runtime.aveScanner);
    const subscriptions=t.mock.method(runtime.aveScanner,'setPriceTokens');
    t.mock.method(runtime.aveScanner,'hasPriceSubscription',()=>true);
    const first=confirm(runtime,reserve(runtime,32).id,32),second=confirm(runtime,reserve(runtime,33).id,33);
    assert.deepEqual(subscriptions.mock.calls.at(-1)?.arguments,[[token(32),token(33)],[token(32),token(33)]]);
    const checkedAt=new Date().toISOString(),before=subscriptions.mock.callCount();
    const closed=runtime.orders.updateExit(first.id,first.exit,{...first.exit!,state:'closed',positionClosed:true,
      assessment:{...first.exit!.assessment!,status:'terminal',terminal:true,hasLiveStop:false,checkedAt},
      balance:{status:'verified',amount:'0',checkedAt,reasons:[]},checkedAt});
    assert.equal(closed?.exit?.positionClosed,true);assert.ok(subscriptions.mock.callCount()>before);
    assert.deepEqual(subscriptions.mock.calls.at(-1)?.arguments,[[token(33)],[token(33)]]);
    assert.deepEqual(runtime.orders.activePositions().map(order=>order.id),[second.id]);
    assert.equal(runtime.dashboardOverview().positionPriceStream.health?.monitored,1);
    assert.equal(network.mock.callCount(),0);
  }finally{await f.close();}
});

test('runtime price router consumes a fresh Ave current-price frame without any HTTP fallback request',async t=>{
  t.mock.timers.enable({apis:['Date'],now:epoch});
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  let priceRequests=0;const f=fixture(async()=>{priceRequests++;throw Error('FRESH_STREAM_MUST_SKIP_HTTP');}),runtime=f.runtime;
  try{
    confirm(runtime,reserve(runtime,34).id,34);
    const gmgn=t.mock.method(runtime.client,'get',async()=>{throw Error('FRESH_STREAM_MUST_SKIP_GMGN');});
    const time=Math.floor(epoch/1000),mint=token(34);
    const accepted=runtime.priceRouter.ingestAvePriceFrame({jsonrpc:'2.0',result:{status:'ok',data:{event:'pricev2',prices:[{
      chain:'solana',token:mint.address,target_token:mint.address,is_main_pair:true,pair:address(90),uprice:0.000123,time,
    }]}}},new Date(epoch).toISOString());
    assert.equal(accepted,1);
    for(let i=0;i<3;i++){
      const batch=await runtime.priceRouter.read([mint]);
      assert.deepEqual(batch.requests,{dexscreener:0,gmgn:0,debot:0});assert.equal(batch.gaps.length,0);
      assert.equal(batch.samples[0].source,'ave_price_stream_sample');assert.equal(batch.samples[0].priceUsd,0.000123);
      assert.equal(batch.samples[0].observedAt,new Date(epoch).toISOString());
    }
    assert.equal(priceRequests,0);assert.equal(gmgn.mock.callCount(),0);assert.equal(network.mock.callCount(),0);
  }finally{await f.close();}
});

test('runtime HTTP backup remains available but cannot poll a holding more often than every thirty seconds',async t=>{
  t.mock.timers.enable({apis:['Date'],now:epoch});
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const mint=token(35);let priceRequests=0;
  const f=fixture(async input=>{
    assert.equal(new URL(String(input)).origin,'https://api.dexscreener.com');priceRequests++;
    return Response.json([{chainId:'solana',baseToken:{address:mint.address},quoteToken:{address:native},
      pairAddress:address(91),priceUsd:'0.0002',liquidity:{usd:10000}}]);
  }),runtime=f.runtime;
  try{
    confirm(runtime,reserve(runtime,35).id,35);
    const initial=await runtime.priceRouter.read([mint]);assert.equal(initial.requests.dexscreener,1);assert.equal(priceRequests,1);
    for(const elapsed of [5000,15000,29999]){
      t.mock.timers.setTime(epoch+elapsed);
      const batch=await runtime.priceRouter.read([mint]);assert.deepEqual(batch.requests,{dexscreener:0,gmgn:0,debot:0});
      assert.equal(batch.samples.length,1);assert.equal(priceRequests,1);
    }
    t.mock.timers.setTime(epoch+30000);
    const refresh=await runtime.priceRouter.read([mint]);assert.equal(refresh.requests.dexscreener,1);assert.equal(priceRequests,2);
    assert.equal(refresh.samples[0].observedAt,new Date(epoch+30000).toISOString());
    assert.equal(runtime.dashboardOverview().positionPriceStream.httpFallbackMinIntervalMs,30000);
    assert.equal(network.mock.callCount(),0);
  }finally{await f.close();}
});

test('a fresh Dex backup keeps an open holding healthy when Ave has no new frame',async t=>{
  t.mock.timers.enable({apis:['Date'],now:epoch});
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const mint=token(36);let requests=0;
  const f=fixture(async()=>{
    requests++;
    return Response.json([{chainId:'solana',baseToken:{address:mint.address},quoteToken:{address:native},
      pairAddress:address(92),priceUsd:'0.0002',liquidity:{usd:10000}}]);
  }),runtime=f.runtime;
  try{
    const opening=confirm(runtime,reserve(runtime,36).id,36);
    t.mock.method(runtime.aveScanner!,'hasPriceSubscription',()=>false);
    t.mock.method(runtime.aveScanner!,'getStatus',()=>({connected:false,priceStream:{}} as never));
    for(const elapsed of [0,30_000,60_000,90_000]){
      t.mock.timers.setTime(epoch+elapsed);
      const batch=await runtime.priceRouter.read([mint]);
      assert.equal(batch.samples[0]?.source,'dexscreener_token_pairs_sample');
      runtime.orders.update(opening.id,['confirmed'],{details:{...opening.details,healthProbe:elapsed}});
      await new Promise<void>(resolve=>setImmediate(resolve));
      const health=runtime.dashboardOverview().positionPriceStream.health;
      assert.equal(health?.monitored,1);assert.equal(health?.degraded,0);
      assert.equal(health?.positions[0].priceSource,'dexscreener_token_pairs_sample');
    }
    assert.equal(requests,4);assert.equal(network.mock.callCount(),0);
  }finally{await f.close();}
});
