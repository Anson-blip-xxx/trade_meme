import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {buildDashboard} from '../src/dashboard.js';
import type {Report} from '../src/types.js';
import {signal,pass,narrative} from './helpers.js';

const password='independent-shadow-dashboard-test-credential';
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
  const {dir,env}=fixture();let runtime=createRuntime(readConfig(env));
  try {
    const r=candidate(runtime);
    await new Promise(resolve=>setTimeout(resolve,5));
    const before=new Date().toISOString();
    runtime.archive!.recordPrice({...r.signal.token,priceUsd:999,observedAt:before,source:'gmgn_token_info_sample'});
    assert.equal(runtime.archive!.get(r.id)!.performance!.peakPriceUsd,999);
    assert.equal(runtime.exitShadow,undefined);assert.equal(existsSync(env.EXIT_SHADOW_DATABASE_PATH),false);
    await runtime.close();runtime=createRuntime(readConfig({...env,WATCH_RECHECK_ENABLED:'false',EXIT_SHADOW_ENABLED:'true'}));
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
    await runtime.close();runtime=createRuntime(readConfig({...env,EXIT_SHADOW_ENABLED:'true'}));
    assert.equal(runtime.exitShadow!.list().items[0].id,initial.id);
    assert.equal(runtime.exitShadow!.list().items[0].baselinePriceUsd,2);
    assert.equal(runtime.dashboardOverview().exitProtection.liveReady,false);
    assert.equal(runtime.dashboardOrders().items.length,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
function atEligible(runtime:ReturnType<typeof createRuntime>,id:string) {return runtime.archive!.get(id)!.performance!.eligibleAt;}

test('independent shadow failure is visible without suppressing scans; archive failure does not suppress shadow capture',async()=>{
  const {dir,env}=fixture(),runtime=createRuntime(readConfig({...env,EXIT_SHADOW_ENABLED:'true'}));
  try {
    const r=candidate(runtime);
    await new Promise(resolve=>setTimeout(resolve,5));
    runtime.client.get=async(_path,query)=>({address:query.address,price:{price:'2'}});
    const record=runtime.exitShadow!.recordPrice.bind(runtime.exitShadow);
    runtime.exitShadow!.recordPrice=()=>{throw new Error('PRIVATE_ERROR_MUST_NOT_LEAK');};
    const first=await runtime.tracking!.runOnce();assert.equal(first.recorded,1);
    assert.equal(runtime.archive!.get(r.id)!.performance!.samples,1);
    assert.equal(runtime.dashboardOverview().exitProtection.captureError,'EXIT_SHADOW_CAPTURE_FAILED');
    assert.doesNotMatch(JSON.stringify(runtime.dashboardOverview()),/PRIVATE_ERROR/);
    runtime.exitShadow!.recordPrice=record;
    runtime.archive!.recordPrice=()=>{throw new Error('PRIVATE_ERROR');};
    const second=await runtime.tracking!.runOnce();assert.equal(second.errors,1);
    assert.equal(runtime.exitShadow!.summary().status.samples,1);
    assert.equal(runtime.dashboardOrders().items.length,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('protection endpoints require authentication, return normalized audit samples, and cannot execute trades',async()=>{
  const {dir,env}=fixture(),runtime=createRuntime(readConfig({...env,EXIT_SHADOW_ENABLED:'true'}));
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
  const runtime=createRuntime(readConfig({...env,WATCH_RECHECK_ENABLED:'false',CHAIN_STREAM_ENABLED:'true',
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
