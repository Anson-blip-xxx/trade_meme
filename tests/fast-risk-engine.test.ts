import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,decide,type EvaluationProgress} from '../src/engine.js';
import {combineSafety,researchProvider,requiredSafetyEvidence,type GmgnResearch} from '../src/research.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import type {GmgnTokenSnapshot} from '../src/providers/gmgn-safety.js';
import type {Check} from '../src/types.js';
import {config,providers,signal,now,pass,narrative} from './helpers.js';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const snapshot=():GmgnTokenSnapshot=>({token:signal().token,fetchedAt:now.toISOString(),diagnostics:[],info:{address:signal().token.address}});
const research=():GmgnResearch=>({snapshot:snapshot(),safety:pass(),flow:pass()} as GmgnResearch);

test('provenance starts from the early snapshot while wallet enrichment is still pending',async()=>{
  const p=providers(),started=deferred<void>(),wallets=deferred<GmgnResearch>(),updates:EvaluationProgress[]=[];
  p.research=async(_s,context)=>{context?.onSnapshot?.(snapshot());return wallets.promise;};
  p.provenance=async(_s,r)=>{assert.equal(r?.snapshot.info&&Object.hasOwn(r.snapshot.info,'address'),true);started.resolve();return pass();};
  const pending=evaluate(signal(),config(),p,{now:()=>now,onProgress:p=>updates.push(p)});
  await started.promise;assert.equal(updates.some(p=>p.stage==='wallets'),false);
  wallets.resolve(research());const result=await pending;
  assert.equal(result.decision,'BUY_CANDIDATE');assert.equal(updates.find(p=>p.stage==='wallets')?.status,'pass');
});

test('hard failure cancels independent work promptly and late completions cannot publish or reverse it',async()=>{
  const p=providers(),late=deferred<GmgnResearch>(),updates:EvaluationProgress[]=[];let scope:AbortSignal|undefined;
  p.safety=async()=>({...pass(),status:'fail',reasons:['HONEYPOT']});
  p.research=async(_s,context)=>{scope=context?.signal;return late.promise;};
  const result=await evaluate(signal(),config(),p,{now:()=>now,budgetMs:1000,onProgress:p=>updates.push(p)});
  assert.equal(result.decision,'REJECT');assert.equal(scope?.aborted,true);const before=JSON.stringify(result),count=updates.length;
  late.resolve(research());await new Promise(resolve=>setImmediate(resolve));
  assert.equal(JSON.stringify(result),before);assert.equal(updates.length,count);
});

test('whole-analysis deadline returns WATCH and cancels providers that ignore abort',async()=>{
  const p=providers(),late=deferred<Check>(),updates:EvaluationProgress[]=[];let scope:AbortSignal|undefined;
  p.safety=(_s,context)=>{scope=context?.signal;return late.promise;};
  const result=await evaluate(signal(),config(),p,{now:()=>now,budgetMs:25,onProgress:p=>updates.push(p)});
  assert.equal(result.decision,'WATCH');assert.equal(result.buyEligible,false);assert.ok(result.reasons.includes('ANALYSIS_DEADLINE_EXCEEDED'));
  assert.equal(scope?.aborted,true);const count=updates.length;late.resolve(pass());await new Promise(resolve=>setImmediate(resolve));
  assert.equal(result.decision,'WATCH');assert.equal(updates.length,count);
});

test('slow optional narrative does not delay required checks and its late conflicting payload is ignored',async()=>{
  const p=providers(),late=deferred<Awaited<ReturnType<NonNullable<typeof p.vendor>>>>();let scope:AbortSignal|undefined;
  p.vendor=(_s,context)=>{scope=context?.signal;return late.promise;};
  const start=performance.now(),result=await evaluate(signal(),config(),p,{now:()=>now,budgetMs:1000});
  assert.equal(result.decision,'BUY_CANDIDATE');assert.equal(scope?.aborted,true);assert.ok(performance.now()-start<900);
  const before=JSON.stringify(result);late.resolve({status:'unavailable',fetchedAt:now.toISOString(),reason:'DEBOT_TOKEN_IDENTITY_CONFLICT',
    identityConflict:{field:'data.history.ca_address',address:`0x${'f'.repeat(40)}`}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(JSON.stringify(result),before);
});

test('DeBot age and necessary proof freshness cap final candidate lifetime at 120 seconds',()=>{
  const c=config(),oldSignal=signal({occurredAt:new Date(now.getTime()-121000).toISOString()});
  const stale=decide(oldSignal,now.toISOString(),c,pass(),pass(),narrative(),now);
  assert.equal(stale.decision,'WATCH');assert.ok(stale.reasons.includes('SIGNAL_STALE'));
  const oldCheck={...pass(),checkedAt:new Date(now.getTime()-121000).toISOString()};
  const proof=decide(signal(),now.toISOString(),c,oldCheck,pass(),narrative(),now);
  assert.equal(proof.decision,'WATCH');assert.ok(proof.reasons.includes('REQUIRED_EVIDENCE_STALE'));
  const recent=signal({occurredAt:new Date(now.getTime()-110000).toISOString()});
  const candidate=decide(recent,now.toISOString(),c,pass(),pass(),narrative(),now);
  assert.equal(candidate.validUntil,new Date(now.getTime()+10000).toISOString());
});

test('combining supplemental security preserves the oldest evidence timestamp',()=>{
  const older=new Date(now.getTime()-90_000).toISOString();
  assert.equal(combineSafety({...pass(),checkedAt:older},pass()).checkedAt,older);
  assert.equal(combineSafety(pass(),{...pass(),checkedAt:older}).checkedAt,older);
});

test('research publishes its snapshot before waiting for detail wallet targets, and cancellation stops enrichment',async()=>{
  const ready=deferred<void>(),published=deferred<void>(),controller=new AbortController(),calls:string[]=[];
  const client=new GmgnClient({apiKey:'fast-research-test',minIntervalMs:0,fetcher:async input=>{
    const path=new URL(String(input)).pathname;calls.push(path);
    return Response.json({code:0,data:{address:signal().token.address}});
  }});
  const pending=researchProvider(config(),client,[])(signal(),{signal:controller.signal,walletTargetsReady:ready.promise,
    onSnapshot:()=>published.resolve()});
  await published.promise;assert.deepEqual(calls,['/v1/token/info','/v1/token/security','/v1/token/pool_info']);
  controller.abort();await assert.rejects(pending);ready.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,3);
});


test('a known vendor contract mismatch rejects before optional evidence can hang',async()=>{
  const p=providers();let evidenceCalled=false;
  p.vendor=async()=>({status:'unavailable',fetchedAt:now.toISOString(),reason:'DEBOT_TOKEN_IDENTITY_CONFLICT',
    identityConflict:{field:'data.history.ca_address',address:`0x${'f'.repeat(40)}`}});
  p.evidence=async()=>{evidenceCalled=true;return new Promise(()=>{});};
  const result=await evaluate(signal(),config(),p,{now:()=>now,budgetMs:1000});
  assert.equal(result.decision,'REJECT');assert.ok(result.reasons.includes('NARRATIVE_TOKEN_IDENTITY_CONFLICT'));assert.equal(evidenceCalled,false);
});


test('the final decision preserves specific market risk reasons and reports the revised policy',()=>{
  const c=config();c.marketRiskRequired=true;
  for(const [status,reason,expected] of [['fail','MARKET_ZERO_LIQUIDITY','REJECT'],['unknown','MARKET_POOL_UNVERIFIED','WATCH']] as const) {
    const market={...pass(),status,reasons:[reason]};
    const result=decide(signal(),now.toISOString(),c,pass(),pass(),narrative(),now,'live',undefined,undefined,undefined,market);
    assert.equal(result.decision,expected);assert.equal(result.policyVersion,'entry-gate-v9');
    assert.ok(result.reasons.includes('MARKET_RISK_NOT_PASSED'));assert.ok(result.reasons.includes(reason));
    assert.equal(result.marketRisk,market);
  }
});


test('supplemental timestamps cannot hide malformed or future primary safety evidence',()=>{
  const malformed=combineSafety({...pass(),checkedAt:'invalid'},pass());
  assert.equal(malformed.checkedAt,'invalid');
  const bad=decide(signal(),now.toISOString(),config(),pass(),malformed,narrative(),now);
  assert.equal(bad.decision,'WATCH');assert.ok(bad.reasons.includes('REQUIRED_EVIDENCE_STALE'));
  const future={...pass(),checkedAt:new Date(now.getTime()+31_000).toISOString()},combined=combineSafety(future,pass());
  assert.equal(combined.checkedAt,now.toISOString());assert.ok(requiredSafetyEvidence(combined).includes(future));
  const futureResult=decide(signal(),now.toISOString(),config(),pass(),combined,narrative(),now);
  assert.equal(futureResult.decision,'WATCH');assert.ok(futureResult.reasons.includes('REQUIRED_EVIDENCE_STALE'));
});
