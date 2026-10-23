import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {MemeObserver} from '../src/meme-observer.js';
import type {Report} from '../src/types.js';
import {signal,pass,narrative} from './helpers.js';

function fixture(extra:NodeJS.ProcessEnv={}) {
  const dir=mkdtempSync(join(tmpdir(),'jev-runtime-'));
  const env={ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),JEV_DATABASE_PATH:join(dir,'jev.sqlite'),
    ENTRY_MODE:'off',JEV_SHADOW_ENABLED:'true',...extra};
  return {dir,env};
}
function complete(runtime:ReturnType<typeof createRuntime>,mode:Report['mode']='live') {
  const at=new Date().toISOString(),s=signal({sourceEventId:crypto.randomUUID(),occurredAt:at});
  const reserved=runtime.store.reserve(s);
  const check={...pass(),checkedAt:at};
  const r:Report={id:reserved.entry.id,mode,policyVersion:'jev-isolation-test',signal:s,receivedAt:reserved.entry.receivedAt,
    evaluatedAt:at,validUntil:new Date(Date.now()+60000).toISOString(),decision:'BUY_CANDIDATE',buyEligible:true,executionEnabled:false,
    reasons:['BASELINE_UNCHANGED'],safety:check,provenance:check,marketRisk:check,
    narrative:{...narrative(),checkedAt:at,evidence:narrative().evidence.map(p=>({...p,publishedAt:at,fetchedAt:at}))}};
  assert.equal(runtime.store.finish(r.id,r,reserved.entry.claimId!),true);return r;
}
async function until(condition:()=>boolean) {
  for(let n=0;n<150&&!condition();n++)await new Promise(r=>setTimeout(r,5));
  assert.ok(condition(),'asynchronous observer finished');
}

test('JEV config defaults off and validates a bounded shadow budget independently of entry mode',()=>{
  const c=readConfig({});assert.equal(c.jev!.enabled,false);assert.equal(c.entryMode,'off');
  assert.equal(c.jev!.maxCallsPerDay,500);assert.equal(c.jev!.maxTokensPerDay,1000000);
  assert.throws(()=>readConfig({JEV_TIMEOUT_MS:'0'}));assert.throws(()=>readConfig({JEV_MAX_CALLS_PER_DAY:'0'}));
});

test('disabled JEV creates no model database and demo reports never enter the research queue',async()=>{
  const f=fixture({JEV_SHADOW_ENABLED:'false'});let runtime=createRuntime(readConfig(f.env));
  try {
    complete(runtime);await new Promise(r=>setImmediate(r));
    assert.equal(runtime.jevShadow,undefined);assert.equal(existsSync(f.env.JEV_DATABASE_PATH),false);
    await runtime.close();runtime=createRuntime(readConfig({...f.env,JEV_SHADOW_ENABLED:'true'}),{jevInvoke:async()=>{throw new Error('must not call');}});
    runtime.jevShadow!.start();complete(runtime,'demo');await new Promise(r=>setImmediate(r));
    assert.equal(runtime.jevShadow!.list({}).total,0);
  }finally {await runtime.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('pending model and credit exhaustion preserve completed baseline and the existing entry result',async()=>{
  const f=fixture();let fail!:(error:unknown)=>void,calls=0;
  const pending=new Promise((_resolve,reject)=>{fail=reject;});
  const runtime=createRuntime(readConfig(f.env),{jevInvoke:async()=>{calls++;return pending;}});
  try {
    runtime.jevShadow!.start();const report=complete(runtime);
    // No model has been called while the scan commit completes.
    assert.equal(calls,0);assert.deepEqual(runtime.store.get(report.id)!.report,report);
    const before=await runtime.entry.consider(report);
    await until(()=>calls===1);
    assert.deepEqual(runtime.store.get(report.id)!.report,report);
    fail(Object.assign(new Error('SECRET_PROVIDER_BODY'),{status:402}));
    await until(()=>runtime.jevShadow!.list({}).items[0]?.status==='unavailable');
    const after=await runtime.entry.consider(report);
    assert.deepEqual(after,before);assert.equal(runtime.dashboardOrders().items.length,0);
    const row=runtime.jevShadow!.list({}).items[0];assert.equal(row.result,null);assert.equal(row.baseline.decision,'BUY_CANDIDATE');
    assert.doesNotMatch(JSON.stringify(runtime.jevStatus()),/SECRET_PROVIDER_BODY/);
    assert.equal(runtime.store.get(report.id)!.report!.buyEligible,true);
  }finally {fail?.({status:402});await runtime.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('JEV storage conflict disables the observer without altering the order database or stopping core runtime',async()=>{
  const f=fixture();f.env.JEV_DATABASE_PATH=f.env.ORDERS_DATABASE_PATH;
  const runtime=createRuntime(readConfig(f.env));
  try {
    runtime.jevShadow!.start();const r=complete(runtime);await new Promise(r=>setImmediate(r));
    assert.equal(runtime.store.get(r.id)!.report!.decision,'BUY_CANDIDATE');
    assert.equal(runtime.jevStatus().lastError,'JEV_DATABASE_CONFLICT');
    assert.equal(runtime.dashboardOrders().items.length,0);
  }finally {await runtime.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('point-in-time observer projection does not read a later overwritten current snapshot',async()=>{
  const f=fixture();let clock=Date.now()-10000;
  const observer=new MemeObserver({database:join(f.dir,'meme.sqlite'),now:()=>new Date(clock),marketBatch:async()=>[]});
  const token=signal().token,start=new Date(clock).toISOString();
  try {
    observer.register(signal({occurredAt:start}));
    observer.recordMarket({version:1,token,source:'dexscreener_pair',observedAt:start,priceUsd:1,windows:{'5m':{buys:2,sells:1}}});
    clock+=6000;
    observer.recordMarket({version:1,token,source:'dexscreener_pair',observedAt:new Date(clock).toISOString(),priceUsd:99,windows:{'5m':{buys:999,sells:1}}});
    const view=observer.researchSnapshot(token,start);
    assert.equal((view.token.market as {priceUsd:number}).priceUsd,1);
    assert.equal(view.items.length,1);assert.doesNotMatch(JSON.stringify(view),/"priceUsd":99/);
  }finally {await observer.close();rmSync(f.dir,{recursive:true,force:true});}
});
