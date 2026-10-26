import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {GmgnError} from '../src/providers/gmgn-client.js';
import type {Fetcher} from '../src/http.js';
import {buildDashboard} from '../src/dashboard.js';
import type {Report} from '../src/types.js';
import {signal,pass,narrative} from './helpers.js';

const password='independent-shadow-dashboard-test-credential';
const emptyPriceFetcher:Fetcher=async()=>Response.json([]);
function runtimeFor(config:ReturnType<typeof readConfig>,priceFetcher:Fetcher=emptyPriceFetcher){
  const runtime=createRuntime(config,{priceFetcher});
  // Keep test GET stubs inside the router's cancellation scope instead of constructing a real client.
  runtime.client.withSignal=()=>runtime.client;return runtime;
}

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'exit-runtime-'));
  const env={ENTRY_MODE:'off',DASHBOARD_ENABLED:'false',WATCH_RECHECK_ENABLED:'true',
    DASHBOARD_ACCESS_TOKEN:password,SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),EXIT_SHADOW_DATABASE_PATH:join(dir,'shadow.sqlite')};
  return {dir,env};
}
function candidate(runtime:ReturnType<typeof createRuntime>) {
  const at=new Date(Date.now()-1000).toISOString(),s=signal({sourceEventId:'exit-runtime',occurredAt:at});
  const reserved=runtime.store.reserve(s);
  const r:Report={id:reserved.entry.id,mode:'live',policyVersion:'synthetic-test',signal:s,
    receivedAt:reserved.entry.receivedAt,evaluatedAt:new Date().toISOString(),validUntil:new Date(Date.now()+60000).toISOString(),
    decision:'BUY_CANDIDATE',buyEligible:true,executionEnabled:false,reasons:[],
    provenance:pass(),safety:pass(),narrative:narrative()};
  assert.equal(runtime.store.finish(r.id,r,reserved.entry.claimId!),true);return r;
}

test('shadow runtime starts without dashboard, ignores historical highs, reuses tracker GET, survives restart and creates no orders',async()=>{
  const {dir,env}=fixture();let runtime=runtimeFor(readConfig(env));
  try {
    const r=candidate(runtime);
    await new Promise(resolve=>setTimeout(resolve,5));
    const before=new Date().toISOString();
    runtime.archive!.recordPrice({...r.signal.token,priceUsd:999,observedAt:before,source:'gmgn_token_info_sample'});
    assert.equal(runtime.archive!.get(r.id)!.performance!.peakPriceUsd,999);
    assert.equal(runtime.exitShadow,undefined);assert.equal(existsSync(env.EXIT_SHADOW_DATABASE_PATH),false);
    await runtime.close();runtime=runtimeFor(readConfig({...env,WATCH_RECHECK_ENABLED:'false',EXIT_SHADOW_ENABLED:'true'}));
    assert.ok(runtime.archive);assert.ok(runtime.tracking);assert.equal(runtime.exitShadow!.summary().status.samples,0);
    const calls:string[]=[];
    runtime.client.get=async(path,query)=>{calls.push(path);return {address:query.address,price:{price:'2'}};};
    await runtime.tracking!.runOnce();
    const initial=runtime.exitShadow!.list().items[0];assert.ok(initial);
    assert.equal(initial.baselinePriceUsd,2);assert.equal(initial.peakGainPct,0);
    assert.deepEqual(calls,['/v1/token/info']);assert.equal(runtime.dashboardOrders().items.length,0);
    const seed=runtime.archive!.exitObservationSeed(r.signal.token)!;
    assert.equal(seed.candidateId,r.id);assert.equal(seed.eligibleAt,atEligible(runtime,r.id));
    assert.deepEqual(Object.keys(seed).sort(),['candidateId','eligibleAt','endsAt','symbol']);
    assert.equal(runtime.archive!.exitObservationSeed({...r.signal.token,chain:'robinhood'}),undefined);
    assert.equal(runtime.archive!.exitObservationSeed(r.signal.token,new Date(Date.now()+2*86400000)),undefined);
    await runtime.close();runtime=runtimeFor(readConfig({...env,EXIT_SHADOW_ENABLED:'true'}));
    assert.equal(runtime.exitShadow!.list().items[0].id,initial.id);
    assert.equal(runtime.exitShadow!.list().items[0].baselinePriceUsd,2);
    assert.equal(runtime.dashboardOverview().exitProtection.liveReady,false);
    assert.equal(runtime.dashboardOrders().items.length,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
function atEligible(runtime:ReturnType<typeof createRuntime>,id:string) {return runtime.archive!.get(id)!.performance!.eligibleAt;}

test('independent shadow failure is visible without suppressing scans; archive failure does not suppress shadow capture',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-17T02:00:00.000Z')});
  const {dir,env}=fixture(),runtime=runtimeFor(readConfig({...env,EXIT_SHADOW_ENABLED:'true'}));
  try {
    const r=candidate(runtime);
    t.mock.timers.setTime(Date.now()+1); // Archive baselines require a post-decision sample.
    runtime.client.get=async(_path,query)=>({address:query.address,price:{price:'2'}});
    const record=runtime.exitShadow!.recordPrice.bind(runtime.exitShadow);
    runtime.exitShadow!.recordPrice=()=>{throw new Error('PRIVATE_ERROR_MUST_NOT_LEAK');};
    const first=await runtime.tracking!.runOnce();assert.equal(first.recorded,1);
    assert.equal(runtime.archive!.get(r.id)!.performance!.samples,1);
    assert.equal(runtime.dashboardOverview().exitProtection.captureError,'EXIT_SHADOW_CAPTURE_FAILED');
    assert.doesNotMatch(JSON.stringify(runtime.dashboardOverview()),/PRIVATE_ERROR/);
    runtime.exitShadow!.recordPrice=record;
    runtime.archive!.recordPrice=()=>{throw new Error('PRIVATE_ERROR');};
    t.mock.timers.setTime(Date.now()+31000); // A cache hit cannot masquerade as a new quote.
    const second=await runtime.tracking!.runOnce();assert.equal(second.errors,1);
    assert.equal(runtime.exitShadow!.summary().status.samples,1);
    assert.equal(runtime.dashboardOrders().items.length,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('protection endpoints require authentication, return normalized audit samples, and cannot execute trades',async()=>{
  const {dir,env}=fixture(),runtime=runtimeFor(readConfig({...env,EXIT_SHADOW_ENABLED:'true'}));
  const server=buildDashboard(readConfig(env),{archive:runtime.archive!,overview:runtime.dashboardOverview,
    orders:runtime.dashboardOrders,protection:runtime.dashboardProtection,protectionDetail:id=>runtime.exitShadow!.detail(id)});
  try {
    candidate(runtime);await new Promise(resolve=>setTimeout(resolve,5));
    runtime.client.get=async(_path,query)=>({address:query.address,price:{price:'2'}});
    await runtime.tracking!.runOnce();const id=runtime.exitShadow!.list().items[0].id;
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/dashboard/api/protection`;
    const headers={'x-dashboard-access':password};
    for(const path of ['',`/${id}`])assert.equal((await fetch(base+path)).status,401);
    const result=await (await fetch(base,{headers})).json();assert.equal(result.liveReady,false);assert.equal(result.mode,'shadow');
    const detail=await (await fetch(base+'/'+id,{headers})).json();assert.equal(detail.sampleCount,1);
    assert.equal(detail.storedSamplesThinned,false);assert.equal(detail.samples[0].source,'gmgn_token_info_sample');
    assert.equal((await fetch(base+'/00000000-0000-0000-0000-000000000000',{headers})).status,404);
    for(const method of ['POST','PUT','DELETE'])assert.equal((await fetch(base,{headers,method})).status,405);
    assert.equal(runtime.dashboardOrders().items.length,0);
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await runtime.close();rmSync(dir,{recursive:true,force:true});
  }
});

test('standalone chain streaming retains candidate targets and suppresses GMGN only while coverage is healthy',async()=>{
  const {dir,env}=fixture();
  const runtime=runtimeFor(readConfig({...env,WATCH_RECHECK_ENABLED:'false',CHAIN_STREAM_ENABLED:'true',
    CHAIN_STREAM_DATABASE_PATH:join(dir,'chain.sqlite')}));
  try {
    assert.ok(runtime.archive);assert.ok(runtime.chainMonitor);const r=candidate(runtime);let calls=0;
    runtime.client.get=async(_path,query)=>{calls++;return {address:query.address,price:{price:'2'}};};
    runtime.chainMonitor.covers=()=>true;await runtime.tracking!.runOnce();assert.equal(calls,0);
    runtime.chainMonitor.covers=()=>false;await runtime.tracking!.runOnce();assert.equal(calls,1);
    assert.equal(runtime.archive.get(r.id)?.performance?.baselinePriceUsd,2);
    assert.equal(runtime.dashboardOrders().items.length,0);assert.equal(runtime.dashboardOverview().entryMode,'off');
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});


test('real runtime router keeps Dex observations flowing into archive and shadow during GMGN cooldown without orders',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-17T00:00:00.000Z')});
  const {dir,env}=fixture();let withDex=false,target='',getCalls=0;const requests:string[]=[];
  const fetcher:Fetcher=async input=>{const url=String(input);requests.push(url);
    if(!url.startsWith('https://api.dexscreener.com/'))return Response.json([]);
    return Response.json(withDex?[{chainId:'bsc',baseToken:{address:target},pairAddress:'0x'+'b'.repeat(40),priceUsd:'2',liquidity:{usd:100000}}]:[]);
  };
  const runtime=runtimeFor(readConfig({...env,EXIT_SHADOW_ENABLED:'true'}),fetcher);
  try{
    const report=candidate(runtime);target=report.signal.token.address;
    runtime.client.get=async()=>{getCalls++;throw new GmgnError('GMGN_RATE_LIMITED',Date.now()+60000);};
    const failed=await runtime.tracking!.runOnce();assert.ok(failed.errors>0);assert.equal(getCalls,1);
    // The runtime deliberately throttles repeated Dex HTTP reads for one token to 30 seconds.
    // Advance beyond that window so this cycle exercises recovery instead of the expected cache gap.
    withDex=true;t.mock.timers.setTime(Date.now()+31000);
    const recovered=await runtime.tracking!.runOnce();assert.equal(recovered.recorded,1);assert.equal(getCalls,1);
    assert.equal(runtime.archive!.get(report.id)?.performance?.baselinePriceUsd,2);
    const row=runtime.exitShadow!.list().items[0];assert.equal(row.baselinePriceUsd,2);assert.equal(row.priceSource,'dexscreener_token_pairs_sample');
    assert.ok(requests.some(url=>url.includes(`/tokens/v1/bsc/${target}`)));
    assert.equal(runtime.dashboardOrders().items.length,0);assert.equal(runtime.dashboardOverview().entryMode,'off');
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime tracks remainder beyond archive expiry and exits on actual price risk instead of elapsed time',async t=>{
  const started=Date.parse('2026-10-17T01:00:00.000Z');t.mock.timers.enable({apis:['Date'],now:new Date(started)});
  const {dir,env}=fixture();let target='',current=1,available=true;const paths:string[]=[];
  const fetcher:Fetcher=async input=>{const url=String(input);paths.push(url);
    if(!url.startsWith('https://api.dexscreener.com/'))return Response.json([]);
    return Response.json(available?[{chainId:'bsc',baseToken:{address:target},pairAddress:'0x'+'c'.repeat(40),priceUsd:String(current),liquidity:{usd:100000}}]:[]);
  };
  const runtime=runtimeFor(readConfig({...env,EXIT_SHADOW_ENABLED:'true'}),fetcher);
  try{
    const report=candidate(runtime);target=report.signal.token.address;
    runtime.client.get=async()=>{throw new GmgnError('GMGN_RATE_LIMITED',Date.now()+60000);};
    await runtime.tracking!.runOnce();const id=runtime.exitShadow!.list().items[0].id;
    t.mock.timers.setTime(started+60000);current=6;await runtime.tracking!.runOnce();
    t.mock.timers.setTime(started+120000);current=11;await runtime.tracking!.runOnce();
    assert.equal(runtime.exitShadow!.detail(id)?.item.remainingPct,72);
    available=false;t.mock.timers.setTime(started+6*3600_000);assert.equal(runtime.exitShadow!.tick().created,0);
    await runtime.tracking!.runOnce();assert.equal(runtime.exitShadow!.detail(id)?.item.phase,'tracking');
    assert.equal(runtime.exitShadow!.detail(id)?.item.remainingPct,72);assert.equal(runtime.dashboardOrders().items.length,0);
    t.mock.timers.setTime(started+2*86400_000);assert.equal(runtime.archive!.pendingTokens(200,new Date()).length,0);
    available=true;current=12;await runtime.tracking!.runOnce();
    const ongoing=runtime.exitShadow!.detail(id)!;assert.equal(ongoing.item.phase,'tracking');assert.equal(ongoing.item.remainingPct,72);
    assert.equal(ongoing.item.exitPlan.timeExitEnabled,false);assert.equal(ongoing.item.exitPlan.intent,undefined);
    t.mock.timers.setTime(started+2*86400_000+60000);current=0.5;await runtime.tracking!.runOnce();
    const detail=runtime.exitShadow!.detail(id)!;assert.equal(detail.item.phase,'triggered');assert.equal(detail.item.remainingPct,0);
    assert.equal(detail.item.lastEvent?.priceUsd,0.5);assert.equal(detail.item.lastEvent?.reason,'HARD_STOP_OBSERVED');assert.equal(detail.item.liveReady,false);
    assert.equal(runtime.dashboardOrders().items.length,0);assert.equal(runtime.dashboardOverview().entryMode,'off');
    assert.ok(paths.filter(url=>url.includes(`/tokens/v1/bsc/${target}`)).length>=5);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
