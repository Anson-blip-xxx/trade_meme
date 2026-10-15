import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DebotScanner,type DebotScannerOptions} from '../src/debot-scanner.js';
import type {DebotSignalObservation,DebotWalletDetails} from '../src/providers/debot-signals.js';
import type {Signal,Report,Check} from '../src/types.js';

const epoch=Date.parse('2026-10-15T02:00:00.000Z');
const at=(ms=0)=>new Date(epoch+ms).toISOString();
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function observation(id:number,token=id,occurred=-1000):DebotSignalObservation {
  return {id:String(id),observedAt:at(),walletCount:3,addressCount:0,aliases:['vendor-alias'],alertPriceUsd:0.0001,
    signal:{source:'debot',sourceEventId:`debot:fast:${id}`,token:{chain:'bsc',address:address(token)},occurredAt:at(occurred),
      text:`signal ${id}`,evidenceUrls:[],claim:'unspecified'}};
}
const page=(...observations:DebotSignalObservation[])=>({observations,received:observations.length,rejected:0});
const emptyDetails=():DebotWalletDetails=>({fetchedAt:at(),received:0,rejected:0,vendorWallets:[]});
const pass=():Check=>({status:'pass',checkedAt:at(),reasons:['TEST_PASSED'],facts:{}});
function report(signal:Signal):Report{return {id:'11111111-1111-4111-8111-111111111111',policyVersion:'test',mode:'live',
  signal,receivedAt:at(),evaluatedAt:at(),validUntil:at(30000),decision:'BUY_CANDIDATE',buyEligible:true,executionEnabled:false,
  reasons:['TEST_PASSED'],safety:pass(),provenance:pass(),marketRisk:pass(),flow:pass(),narrative:{...pass(),evidence:[]}};}
function fixture(overrides:Partial<DebotScannerOptions>={}){
  const dir=mkdtempSync(join(tmpdir(),'debot-fast-risk-')),database=join(dir,'inbox.sqlite');let current=epoch;
  const options:DebotScannerOptions={database,chains:['bsc'],maxAgeSec:600,mode:'authenticated_stream',maxConcurrent:2,
    parallelDetails:true,now:()=>new Date(current),onSignal:async()=>{},...overrides};
  const instances:DebotScanner[]=[];
  const create=()=>{const s=new DebotScanner(options);instances.push(s);return s;};
  const rows=()=>{const db=new DatabaseSync(database,{readOnly:true});
    try{return db.prepare('SELECT * FROM debot_signals ORDER BY id').all();}finally{db.close();}};
  return {create,database,rows,advance:(ms:number)=>{current=epoch+ms;},
    close:async()=>{for(const s of instances)await s.close();rmSync(dir,{recursive:true,force:true});}};
}

test('two distinct-token burst alerts start risk checks concurrently while a third stays within the worker cap',async()=>{
  const release=deferred<void>();let active=0,maxActive=0;const started:string[]=[];
  let scanner:DebotScanner;
  const f=fixture({onSignal:async s=>{
    started.push(s.token.address);active++;maxActive=Math.max(active,maxActive);
    scanner.recordProgress(s.sourceEventId,{stage:'safety',status:'pass',checkedAt:at(),elapsedMs:2,reasons:['TEST_PASSED']});
    await release.promise;active--;
  }});
  try{
    scanner=f.create();scanner.acceptPage(page(observation(1),observation(2),observation(3)));
    const work=scanner.dispatchOnce();await turn();
    assert.equal(started.length,2);assert.equal(maxActive,2);
    assert.equal(f.rows().filter(row=>row.state==='dispatching').length,2);
    assert.equal(f.rows().filter(row=>row.state==='pending').length,1);
    assert.equal(scanner.recent().items.filter(row=>(row.checks as any).safety?.status==='pass').length,2);
    release.resolve();await work;
    assert.equal(started.length,3);assert.equal(maxActive,2);assert.equal(scanner.getStatus().dispatched,3);
  }finally{release.resolve();await f.close();}
});

test('repeated CA alerts keep the first assessment and do not block another token or reanalyze unchanged evidence',async()=>{
  const release=deferred<void>(),active=new Set<string>();const started:number[]=[];let overlap=false;
  const f=fixture({onSignal:async s=>{
    if(active.has(s.token.address))overlap=true;active.add(s.token.address);started.push(Number(s.sourceEventId.split(':').at(-1)));
    await release.promise;active.delete(s.token.address);
  }});
  try{
    const scanner=f.create();scanner.acceptPage(page(observation(1,1,-2000),observation(2,1,-1000),observation(3,3,-1000)));
    const work=scanner.dispatchOnce();await turn();
    assert.equal(started.length,2);assert.ok(started.includes(1));assert.ok(started.includes(3));
    assert.equal(active.size,2);assert.equal(overlap,false);
    release.resolve();await work;assert.equal(started.length,2);assert.equal(overlap,false);
  }finally{release.resolve();await f.close();}
});

test('slow wallet detail retrieval does not delay the safety callback and exposes an awaitable detail boundary',async()=>{
  const details=deferred<DebotWalletDetails>(),analysis=deferred<void>();let began=false,detailsReady=false;
  const f=fixture({fetchDetails:async()=>details.promise,onSignal:async(_signal,_at,context)=>{
    began=true;assert.ok(context?.detailsReady);void context.detailsReady.then(()=>{detailsReady=true;});await analysis.promise;
  }});
  try{
    const scanner=f.create();scanner.acceptPage(page(observation(1)));
    const work=scanner.dispatchOnce();await turn();assert.equal(began,true);assert.equal(detailsReady,false);
    assert.equal(scanner.getStatus().detailsReceived,0);
    details.resolve(emptyDetails());await turn();assert.equal(detailsReady,true);assert.equal(scanner.getStatus().detailsReceived,1);
    analysis.resolve();await work;assert.equal(scanner.getStatus().dispatched,1);
  }finally{details.resolve(emptyDetails());analysis.resolve();await f.close();}
});

test('close waits for late details after an early verdict and never writes to an already closed database',async()=>{
  const details=deferred<DebotWalletDetails>();let callbackFinished=false,closed=false;
  const f=fixture({fetchDetails:async()=>details.promise,onSignal:async()=>{callbackFinished=true;}});
  try{
    const scanner=f.create();scanner.acceptPage(page(observation(1)));
    const work=scanner.dispatchOnce();await turn();assert.equal(callbackFinished,true);
    assert.equal(f.rows()[0].state,'completed');
    const closing=scanner.close().then(()=>{closed=true;});await turn();assert.equal(closed,false);
    details.resolve({...emptyDetails(),received:1,vendorWallets:[{address:address(9),source:'debot',verification:'vendor_report'}]});
    await Promise.all([work,closing]);assert.equal(closed,true);
    assert.equal(JSON.parse(String(f.rows()[0].details)).vendorWallets.length,1);
    assert.doesNotThrow(()=>scanner.recordProgress('debot:fast:1',{stage:'safety',status:'fail',checkedAt:at(),elapsedMs:1,reasons:['TEST_FAILED']}));
  }finally{details.resolve(emptyDetails());await f.close();}
});

test('all passing fast-stage badges still cannot expose a buy candidate until the full callback completes',async()=>{
  const release=deferred<void>();let scanner:DebotScanner;
  const f=fixture({onSignal:async s=>{
    for(const stage of ['safety','provenance','market','wallets'] as const)
      scanner.recordProgress(s.sourceEventId,{stage,status:'pass',checkedAt:at(),elapsedMs:1,reasons:['TEST_PASSED']});
    scanner.recordReport(s.sourceEventId,report(s));await release.promise;
  }});
  try{
    scanner=f.create();scanner.acceptPage(page(observation(1)));const work=scanner.dispatchOnce();await turn();
    const pending=scanner.recent().items[0];assert.equal(pending.state,'dispatching');assert.equal(pending.buyEligible,false);
    assert.equal(Object.keys(pending.checks).length,5);
    release.resolve();await work;assert.equal(scanner.recent().items[0].buyEligible,true);
    f.advance(30000);assert.equal(scanner.recent().items[0].buyEligible,false);
    f.advance(30001);assert.equal(scanner.recent().items[0].buyEligible,false);
  }finally{release.resolve();await f.close();}
});

test('completed verdict and evidence are frozen against late progress, report and binding publications',async()=>{
  let scanner:DebotScanner;
  const alert=observation(1);
  const f=fixture({onSignal:async s=>{
    scanner.bindReport(s.sourceEventId,report(s).id);scanner.recordReport(s.sourceEventId,report(s));
  }});
  try{
    scanner=f.create();scanner.acceptPage(page(alert));await scanner.dispatchOnce();const before=scanner.recent();
    scanner.recordProgress(alert.signal.sourceEventId,{stage:'safety',status:'fail',checkedAt:at(),elapsedMs:999,reasons:['LATE_FAILURE']});
    scanner.recordReport(alert.signal.sourceEventId,{...report(alert.signal),decision:'REJECT',buyEligible:false,reasons:['LATE_FAILURE']});
    scanner.bindReport(alert.signal.sourceEventId,'22222222-2222-4222-8222-222222222222');
    assert.deepEqual(scanner.recent(),before);
  }finally{await f.close();}
});

test('final publication preserves early unchanged risk latency and the first result time of a changed check',async()=>{
  let scanner:DebotScanner;
  const f=fixture({onSignal:async s=>{
    scanner.recordProgress(s.sourceEventId,{stage:'safety',status:'pass',checkedAt:at(),elapsedMs:25,reasons:['TEST_PASSED']});
    scanner.recordProgress(s.sourceEventId,{stage:'market',status:'unknown',checkedAt:at(),elapsedMs:50,reasons:['MARKET_PENDING']});
    f.advance(10000);scanner.recordReport(s.sourceEventId,{...report(s),evaluatedAt:at(10000)});
  }});
  try{
    scanner=f.create();scanner.acceptPage(page(observation(1)));await scanner.dispatchOnce();
    const current=scanner.recent().items[0],checks=current.checks as any;
    assert.equal(current.analysisMs,10000);
    assert.equal(checks.safety.firstResultMs,25);assert.equal(checks.safety.elapsedMs,25);
    assert.equal(checks.market.status,'pass');assert.equal(checks.market.firstResultMs,50);assert.equal(checks.market.elapsedMs,10000);
  }finally{await f.close();}
});

test('different vendor IDs describing the same CA event and unchanged payload dispatch only once, including after restart',async()=>{
  const first=observation(1),second={...structuredClone(first),id:'2',observedAt:at(100),
    signal:{...first.signal,sourceEventId:'debot:fast:2',text:'different vendor notification ID'}};
  let calls=0;const f=fixture({onSignal:async()=>{calls++;}});
  try{
    let scanner=f.create();scanner.acceptPage(page(first,second));await scanner.dispatchOnce();
    assert.equal(calls,1);assert.equal(scanner.getStatus().ignored,1);assert.equal(scanner.recent().items.length,1);
    assert.equal(f.rows()[1].reason,'DEBOT_DUPLICATE_TOKEN_ALERT');
    await scanner.close();scanner=f.create();scanner.acceptPage(page({...second,id:'3',signal:{...second.signal,sourceEventId:'debot:fast:3'}}));
    await scanner.dispatchOnce();assert.equal(calls,1);assert.equal(scanner.getStatus().ignored,2);
    const changed=structuredClone(second);changed.id='4';changed.signal.sourceEventId='debot:fast:4';changed.signal.occurredAt=at(-500);
    scanner.acceptPage(page(changed));await scanner.dispatchOnce();assert.equal(calls,1);
  }finally{await f.close();}
});

test('a stale queued alert never begins analysis after the authenticated 120 second window',async()=>{
  let defer=true,calls=0;
  const f=fixture({shouldDefer:()=>defer?'TEST_BUSY':undefined,onSignal:async()=>{calls++;}});
  try{
    const scanner=f.create();scanner.acceptPage(page(observation(1)));await scanner.dispatchOnce();assert.equal(calls,0);
    f.advance(119001);defer=false;await scanner.dispatchOnce();assert.equal(calls,0);
    assert.equal(f.rows()[0].reason,'DEBOT_SIGNAL_STALE');assert.equal(scanner.recent().items.length,0);
  }finally{await f.close();}
});

test('recent risk endpoint data exposes only bounded decision fields, not vendor details, aliases or credentials',async()=>{
  const secret='raw private cookie=do-not-expose',privateWallet=address(934);let scanner:DebotScanner;
  const alert=observation(1);alert.aliases=[secret];alert.signal.text=secret;
  const f=fixture({fetchDetails:async()=>({...emptyDetails(),received:1,vendorWallets:[{
    address:privateWallet,alias:secret,source:'debot',verification:'vendor_report',profit:{buy_volume:'123'}}] as any}),
    onSignal:async s=>{
      scanner.recordProgress(s.sourceEventId,{stage:'safety',status:'pass',checkedAt:at(),elapsedMs:1,reasons:['TEST_PASSED',secret]});
      const r=report(s);r.reasons.push(secret);r.safety.facts={rawResponse:secret,privateWallet};scanner.recordReport(s.sourceEventId,r);
    }});
  try{
    scanner=f.create();scanner.acceptPage(page(alert));await scanner.dispatchOnce();const recent=scanner.recent();
    const json=JSON.stringify(recent);assert.equal(json.includes(secret),false);assert.equal(json.includes(privateWallet),false);
    for(const field of ['payload','vendorWallets','rawResponse','facts','aliases','details','profit'])assert.equal(json.includes(`"${field}"`),false);
    assert.deepEqual(recent.items[0].reasons,['TEST_PASSED']);
    assert.deepEqual((recent.items[0].checks as any).safety.reasons,['TEST_PASSED']);
  }finally{await f.close();}
});
