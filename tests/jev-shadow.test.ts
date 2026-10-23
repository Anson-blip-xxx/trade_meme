import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {JevShadow,type JevShadowOptions,type JevPriceSample} from '../src/jev-shadow.js';
import {buildJevRequest,JEV_MODEL,type JevInput} from '../src/jev-input.js';

const start=Date.parse('2026-10-23T08:00:00.000Z'),iso=(at:number)=>new Date(at).toISOString();
const token={chain:'bsc' as const,address:`0x${'a'.repeat(40)}`};
function input(at=start,id='one',patch:Partial<JevInput>={}):JevInput {
  return {reportId:id,token,name:'Test',asOf:iso(at),baseline:{decision:'BUY_CANDIDATE',hardChecksPassed:true,reasons:['BASELINE_ORIGINAL']},
    state:{token:'T01',sample:id,availability:{heat:true,trading_emotion:false,wallet_relay:false,catalyst:false,celebrity:false}},...patch};
}
function response(request:unknown,stance='support',usage:unknown={input_tokens:100,output_tokens:20}):unknown {
  const answers:Record<string,unknown>={};
  for(const [key,q] of Object.entries((request as ReturnType<typeof buildJevRequest>).questions)){
    if(q.type==='score')answers[key]={type:'score',score:3,confidence:0.9,legend:Object.fromEntries(q.criteria.map((v,i)=>[String(i),v])),
      probabilities:{'0':0,'1':0,'2':0,'3':1,'4':0}};
    else {const choice=key==='stance'?stance:key==='phase'?'accelerating':key==='reason'?'FRESH_ACTIVITY_GROWING':'strong';
      answers[key]={type:'choice',choice,confidence:0.9,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))};}
  }
  return {model:JEV_MODEL,answers,usage};
}
type Cleanup={after:(fn:()=>void|Promise<void>)=>void};
function setup(t:Cleanup,extra:Partial<JevShadowOptions>={}) {
  const dir=mkdtempSync(join(tmpdir(),'jev-shadow-test-')),database=join(dir,'shadow.sqlite'),clock={now:start};
  const all:JevShadow[]=[],calls:unknown[]=[],options:JevShadowOptions={enabled:true,database,maxBytes:8*1024*1024,timeoutMs:1000,
    minIntervalMs:0,perTokenIntervalMs:60_000,maxCallsPerDay:500,maxTokensPerDay:1_000_000,clientPath:'/does/not/exist.mjs',now:()=>clock.now,
    invoke:async request=>{calls.push(request);return response(request);},...extra};
  const open=(patch:Partial<JevShadowOptions>={})=>{const runner=new JevShadow({...options,...patch});all.push(runner);runner.start();return runner;};
  t.after(async()=>{await Promise.all(all.map(runner=>runner.stop()));rmSync(dir,{recursive:true,force:true});});
  return {dir,database,clock,calls,open,runner:open()};
}
async function until(predicate:()=>boolean):Promise<void> {
  for(let n=0;n<100;n++){if(predicate())return;await delay(5);}assert.ok(predicate(),'condition did not settle');
}
async function finished(runner:JevShadow,count=1):Promise<void> {await until(()=>runner.status().counts.available+runner.status().counts.unavailable>=count&&!runner.status().inFlight);}
function sample(at:number,priceUsd:number,patch:Partial<JevPriceSample>={}):JevPriceSample {
  return {token,observedAt:iso(at),priceUsd,source:'gmgn_token_info',poolAddress:'pool-one',...patch};
}

test('enqueue snapshots inputs without awaiting model, and cannot change the baseline decision',async t=>{
  let release!:(value:unknown)=>void,sent:unknown,optionsSeen:any;
  const ctx=setup(t,{invoke:(request,options)=>{sent=request;optionsSeen=options;return new Promise(resolve=>{release=resolve;});}}),original=input();
  ctx.runner.enqueue(original);original.baseline.decision='REJECT';original.state.sample='mutation';
  await until(()=>!!release);assert.equal(ctx.runner.list().items[0].status,'pending');
  assert.equal(JSON.stringify(sent).includes('BASELINE_ORIGINAL'),false);assert.equal(JSON.stringify(sent).includes(token.address),false);
  assert.equal((sent as any).state.sample,'one');assert.equal(optionsSeen.retry.maxRetries,0);assert.equal(optionsSeen.timeout,1000);
  release(response(sent));await finished(ctx.runner);
  const row=ctx.runner.list().items[0];assert.equal(row.baseline.decision,'BUY_CANDIDATE');assert.equal(row.result?.score,75);
  assert.equal(row.result?.dimensions.celebrity,null);assert.equal(row.comparison.selected,true);
  assert.equal(ctx.runner.status().budget.knownTokens,120);assert.equal(ctx.runner.status().budget.reservedTokens,0);
  assert.equal(ctx.runner.status().budget.accountBalanceKnown,false);assert.equal(statSync(ctx.database).mode&0o777,0o600);
  assert.equal(ctx.runner.detail(row.id)?.input.state.sample,'one');assert.equal(ctx.runner.detail('../secrets'),undefined);
});

test('quota exhaustion persists across restart, falls back with null score, and permits one recovery probe after cooldown',async t=>{
  let calls=0;const ctx=setup(t,{invoke:async()=>{calls++;throw {status:402,message:'SECRET_KEY_AND_BODY',error:{code:'insufficient_quota'}};}});
  ctx.runner.enqueue(input());await finished(ctx.runner);
  const first=ctx.runner.list().items[0];assert.equal(first.status,'unavailable');assert.equal(first.result,null);assert.equal(first.reason,'JEV_QUOTA_EXHAUSTED');
  assert.deepEqual(first.baseline,input().baseline);assert.equal(first.comparison.selected,null);assert.equal(ctx.runner.status().circuit.retryAt,iso(start+3_600_000));
  await ctx.runner.stop();let successes=0;
  const reopened=ctx.open({invoke:async request=>{successes++;return response(request);}});
  ctx.clock.now+=61_000;reopened.enqueue(input(ctx.clock.now,'two'));await finished(reopened,2);assert.equal(successes,0);assert.equal(calls,1);
  assert.equal(reopened.status().budget.calls,1);assert.equal(reopened.status().budget.unknownUsageCalls,1);
  ctx.clock.now=start+3_600_001;reopened.enqueue(input(ctx.clock.now,'recovery'));await finished(reopened,3);
  assert.equal(successes,1);assert.equal(reopened.status().circuit.reason,null);assert.equal(reopened.status().budget.calls,2);
  assert.equal(readFileSync(ctx.database).includes(Buffer.from('SECRET_KEY_AND_BODY')),false);
});

test('429 retry-after and quota codes are distinguished without inspecting unsafe error messages',async t=>{
  const ctx=setup(t,{invoke:async()=>{throw {status:429,retryAfterMs:123_000,message:'DO_NOT_LOG',headers:{authorization:'SECRET'}};}});
  ctx.runner.enqueue(input());await finished(ctx.runner);assert.equal(ctx.runner.status().circuit.reason,'JEV_RATE_LIMITED');
  assert.equal(ctx.runner.status().circuit.retryAt,iso(start+123_000));
  const quota=ctx.open({database:join(ctx.dir,'quota.sqlite'),invoke:async()=>{throw {status:429,error:{code:'insufficient_quota'}};}});
  quota.enqueue(input());await finished(quota);assert.equal(quota.status().circuit.reason,'JEV_QUOTA_EXHAUSTED');
  assert.equal(quota.status().circuit.retryAt,iso(start+3_600_000));
});

test('authentication and missing client fail closed for model availability without preventing service start',async t=>{
  for(const status of [401,403]){
    const ctx=setup(t,{invoke:async()=>{throw {status,message:'unsafe provider text'};}});ctx.runner.enqueue(input());await finished(ctx.runner);
    assert.equal(ctx.runner.status().circuit.reason,'JEV_AUTH_UNAVAILABLE');assert.equal(ctx.runner.status().running,true);
  }
  const ctx=setup(t,{invoke:undefined});ctx.runner.enqueue(input());await finished(ctx.runner);
  assert.equal(ctx.runner.status().circuit.reason,'JEV_CLIENT_UNAVAILABLE');assert.equal(ctx.runner.list().items[0].result,null);
});

test('hard deadline survives a provider ignoring abort and never overlaps it with another request',async t=>{
  let calls=0;const ctx=setup(t,{timeoutMs:15,invoke:async()=>{calls++;return new Promise(()=>{});}});
  ctx.runner.enqueue(input());await finished(ctx.runner);assert.equal(calls,1);
  assert.equal(ctx.runner.list().items[0].reason,'JEV_TIMEOUT');assert.equal(ctx.runner.status().providerPending,true);
  assert.ok(ctx.runner.list().items[0].latencyMs!<200);
  ctx.clock.now+=61_000;ctx.runner.enqueue(input(ctx.clock.now,'next'));await finished(ctx.runner,2);
  assert.equal(calls,1);assert.equal(ctx.runner.list().items[0].reason,'JEV_PROVIDER_STILL_PENDING');
  await ctx.runner.stop();assert.equal(ctx.runner.status().running,false);
});

test('stop cancels a current call promptly and settles queued work as unavailable',async t=>{
  let started=false;const ctx=setup(t,{timeoutMs:10_000,invoke:async()=>{started=true;return new Promise(()=>{});}});
  ctx.runner.enqueue(input());await until(()=>started);
  ctx.runner.enqueue(input(start,'queued',{token:{...token,address:`0x${'b'.repeat(40)}`}}));
  const begun=Date.now();await ctx.runner.stop();assert.ok(Date.now()-begun<300);
  const reopened=ctx.open();assert.equal(reopened.list().total,2);assert.ok(reopened.list().items.every(row=>row.reason==='JEV_STOPPED'));
});

test('daily call budget persists on restart and resets at Shanghai midnight',async t=>{
  const ctx=setup(t,{maxCallsPerDay:1});ctx.runner.enqueue(input());await finished(ctx.runner);await ctx.runner.stop();
  const runner=ctx.open();ctx.clock.now+=61_000;runner.enqueue(input(ctx.clock.now,'two'));await finished(runner,2);
  assert.equal(ctx.calls.length,1);assert.equal(runner.list().items[0].reason,'JEV_DAILY_CALL_BUDGET');
  assert.equal(runner.list().items[0].retryAt,'2026-10-23T16:00:00.000Z');
  ctx.clock.now=Date.parse('2026-10-23T16:00:00.001Z');runner.enqueue(input(ctx.clock.now,'tomorrow'));await finished(runner,3);
  assert.equal(ctx.calls.length,2);assert.equal(runner.status().budget.day,'2026-10-24');assert.equal(runner.status().budget.calls,1);
});

test('missing usage reserves conservative tokens, and a tiny remaining budget never sends another request',async t=>{
  const reserve=JSON.stringify(buildJevRequest(input())).length+2048;let calls=0;
  const ctx=setup(t,{maxTokensPerDay:reserve+100,invoke:async request=>{calls++;return response(request,'support',null);}});
  ctx.runner.enqueue(input());await finished(ctx.runner);assert.equal(ctx.runner.status().budget.knownTokens,0);
  assert.equal(ctx.runner.status().budget.unknownUsageCalls,1);assert.equal(ctx.runner.status().budget.reservedTokens,reserve);
  await ctx.runner.stop();const runner=ctx.open();ctx.clock.now+=61_000;runner.enqueue(input(ctx.clock.now,'two'));await finished(runner,2);
  assert.equal(calls,1);assert.equal(runner.list().items[0].reason,'JEV_DAILY_TOKEN_BUDGET');assert.equal(runner.list().items[0].result,null);
  assert.equal(runner.status().available,false);assert.equal(runner.status().circuit.reason,'JEV_DAILY_TOKEN_BUDGET');
  assert.equal(runner.status().circuit.retryAt,'2026-10-23T16:00:00.000Z');
});

test('duplicate versions and rapid same-token updates are coalesced instead of consuming API quota',async t=>{
  const ctx=setup(t);ctx.runner.enqueue(input());ctx.runner.enqueue(input());await finished(ctx.runner);
  ctx.clock.now+=1_000;ctx.runner.enqueue(input(ctx.clock.now,'changed'));assert.equal(ctx.runner.list().total,1);
  ctx.clock.now+=60_000;ctx.runner.enqueue(input(ctx.clock.now,'changed'));await finished(ctx.runner,2);
  assert.equal(ctx.calls.length,2);assert.equal(ctx.runner.list().total,2);
});

test('queue is bounded and expires stale snapshots rather than sending old state after a slow request',async t=>{
  let release!:(value:unknown)=>void,sent:unknown,calls=0;
  const ctx=setup(t,{invoke:request=>{calls++;sent=request;return new Promise(resolve=>{release=resolve;});}});
  ctx.runner.enqueue(input());await until(()=>!!release);
  for(let n=0;n<33;n++)ctx.runner.enqueue(input(start,`queued-${n}`,{token:{...token,address:`0x${(n+1).toString(16).padStart(40,'0')}`}}));
  assert.equal(ctx.runner.status().queueDepth,32);assert.equal(ctx.runner.list({limit:100}).items.filter(row=>row.reason==='JEV_QUEUE_FULL').length,1);
  ctx.clock.now+=31_000;release(response(sent));await finished(ctx.runner,34);
  assert.equal(calls,1);assert.equal(ctx.runner.list({limit:100}).items.filter(row=>row.reason==='JEV_QUEUE_EXPIRED').length,32);
});

test('bad responses are unavailable while usage is counted, and failed calls back off exponentially',async t=>{
  const ctx=setup(t,{invoke:async()=>({model:'wrong',usage:{input_tokens:111,output_tokens:22}})});
  ctx.runner.enqueue(input());await finished(ctx.runner);assert.equal(ctx.runner.list().items[0].reason,'JEV_RESPONSE_INVALID');
  assert.equal(ctx.runner.status().budget.knownTokens,133);assert.equal(ctx.runner.status().circuit.retryAt,iso(start+30_000));
  ctx.clock.now+=61_000;ctx.runner.enqueue(input(ctx.clock.now,'two'));await finished(ctx.runner,2);
  assert.equal(ctx.runner.status().circuit.retryAt,iso(ctx.clock.now+60_000));
  assert.ok(ctx.runner.list().items.every(row=>row.result===null));
});

test('paired comparison freezes the first post-model price and horizon observations without hindsight or fills',async t=>{
  const ctx=setup(t);ctx.runner.enqueue(input());await finished(ctx.runner);const id=ctx.runner.list().items[0].id;
  ctx.runner.observePrice(sample(start-1,999));ctx.runner.observePrice(sample(start+1,999));assert.equal(ctx.runner.detail(id)?.comparison.sampleCount,0);
  ctx.clock.now=start+1000;ctx.runner.observePrice(sample(ctx.clock.now,100));
  const baselineAt=ctx.clock.now;ctx.clock.now=baselineAt+300_000;ctx.runner.observePrice(sample(ctx.clock.now,200));
  ctx.runner.observePrice(sample(baselineAt,9999));
  ctx.clock.now=baselineAt+900_000;ctx.runner.observePrice(sample(ctx.clock.now,150));
  ctx.clock.now=baselineAt+3_600_000;ctx.runner.observePrice(sample(ctx.clock.now,300));
  const row=ctx.runner.detail(id)!;
  assert.equal(row.comparison.baselinePriceUsd,100);assert.equal(row.comparison.sampleCount,4);
  assert.equal(row.comparison.horizons['5'].grossReturnPct,100);assert.equal(row.comparison.horizons['15'].grossReturnPct,50);
  assert.equal(row.comparison.horizons['60'].grossReturnPct,200);assert.equal(row.comparison.sampledMaxGainPct,200);
  assert.equal(row.comparison.sampledMaxDrawdownPct,25);assert.equal(row.comparison.method,'observed_price_gross');
  assert.equal(ctx.runner.status().comparison.horizons[0].baselineMeanGrossPct,100);
  assert.equal(ctx.runner.status().comparison.horizons[0].jevSelectedMeanGrossPct,100);
  await ctx.runner.stop();const reopened=ctx.open();assert.deepEqual(reopened.detail(id)?.comparison,row.comparison);
});

test('rejected baseline, missing model and missing first price never become zero-return comparison successes',async t=>{
  const ctx=setup(t);ctx.runner.enqueue(input(start,'reject',{baseline:{decision:'REJECT',hardChecksPassed:false,reasons:['UNSAFE']}}));await finished(ctx.runner);
  ctx.runner.observePrice(sample(start,100));assert.equal(ctx.runner.list().items[0].comparison.excludedReason,'BASELINE_NOT_ELIGIBLE');
  ctx.clock.now+=61_000;ctx.runner.enqueue(input(ctx.clock.now,'accepted'));await finished(ctx.runner,2);
  ctx.clock.now+=121_000;ctx.runner.observePrice(sample(ctx.clock.now,100));
  assert.equal(ctx.runner.list().items[0].comparison.excludedReason,'JEV_BASELINE_PRICE_MISSING');
  assert.equal(ctx.runner.status().comparison.priced,1);assert.equal(ctx.runner.status().comparison.horizons[0].pairs,0);
  assert.equal(ctx.runner.status().comparison.horizons[0].baselineMeanGrossPct,null);
});

test('a changed pool or source skips only that sample; matching series can still complete and late horizons are missed',async t=>{
  for(const patch of [{source:'ave_price_stream_sample'},{poolAddress:'pool-two'}]){
    const ctx=setup(t);ctx.runner.enqueue(input());await finished(ctx.runner);ctx.runner.observePrice(sample(start,100));
    ctx.clock.now+=300_000;ctx.runner.observePrice(sample(ctx.clock.now,999,patch));
    assert.equal(ctx.runner.list().items[0].comparison.seriesMismatchCount,1);assert.equal(ctx.runner.status().comparison.horizons[0].pairs,0);
    ctx.runner.observePrice(sample(ctx.clock.now,200));assert.equal(ctx.runner.status().comparison.horizons[0].pairs,1);
    assert.equal(ctx.runner.list().items[0].comparison.horizons['5'].grossReturnPct,100);
  }
  const ctx=setup(t);ctx.runner.enqueue(input());await finished(ctx.runner);ctx.runner.observePrice(sample(start,100));
  ctx.clock.now+=421_000;ctx.runner.observePrice(sample(ctx.clock.now,999));assert.equal(ctx.runner.list().items[0].comparison.horizons['5'].status,'missed');
  assert.equal(ctx.runner.status().comparison.horizons[0].pairs,0);
});

test('explicitly unavailable input is skipped locally without spending tokens or entering paired performance',async t=>{
  const ctx=setup(t);const missing=input();missing.state.availability={heat:false,trading_emotion:false,wallet_relay:false,catalyst:false,celebrity:false};
  ctx.runner.enqueue(missing);await finished(ctx.runner);ctx.runner.observePrice(sample(start,100));ctx.clock.now+=300_000;ctx.runner.observePrice(sample(ctx.clock.now,200));
  const row=ctx.runner.list().items[0];assert.equal(row.status,'unavailable');assert.equal(row.result,null);assert.equal(ctx.calls.length,0);
  assert.equal(row.comparison.selected,null);assert.equal(row.comparison.excludedReason,'JEV_EVIDENCE_INSUFFICIENT');
  assert.equal(ctx.runner.status().comparison.horizons[0].pairs,0);
});

test('model insufficient stance is excluded even when dimensions are available and the call was successful',async t=>{
  const ctx=setup(t,{invoke:async request=>response(request,'insufficient')});ctx.runner.enqueue(input());await finished(ctx.runner);
  assert.equal(ctx.runner.list().items[0].status,'available');assert.equal(ctx.runner.list().items[0].comparison.selected,null);
  assert.equal(ctx.runner.list().items[0].comparison.excludedReason,'JEV_EVIDENCE_INSUFFICIENT');
});

test('WATCH and REJECT receive descriptive future tracking but never enter an entry comparison cohort',async t=>{
  for(const decision of ['WATCH','REJECT'] as const){
    const ctx=setup(t);ctx.runner.enqueue(input(start,'not-candidate',{baseline:{decision,hardChecksPassed:false,reasons:[]}}));await finished(ctx.runner);
    ctx.runner.observePrice(sample(start,100));ctx.clock.now+=300_000;ctx.runner.observePrice(sample(ctx.clock.now,500));
    const row=ctx.runner.list().items[0];assert.equal(row.comparison.horizons['5'].grossReturnPct,400);
    assert.equal(row.comparison.eligible,false);assert.equal(row.comparison.excludedReason,'BASELINE_NOT_ELIGIBLE');assert.equal(row.baseline.decision,decision);
    assert.equal(ctx.runner.status().comparison.horizons[0].pairs,0);assert.equal(ctx.runner.status().comparison.priced,1);
  }
});

test('late delivery uses the observed time of a still-fresh sample rather than discarding an in-window horizon',async t=>{
  const ctx=setup(t);ctx.runner.enqueue(input());await finished(ctx.runner);ctx.runner.observePrice(sample(start,100));
  ctx.clock.now=start+421_000;ctx.runner.observePrice(sample(start+419_000,150));
  const horizon=ctx.runner.list().items[0].comparison.horizons['5'];assert.equal(horizon.status,'complete');assert.equal(horizon.grossReturnPct,50);
});

test('ineligible model-only support cannot reopen baseline rejects and supported versus rejected cohorts share arithmetic',async t=>{
  const ctx=setup(t,{perTokenIntervalMs:0,invoke:async request=>response(request,(request as any).state.sample==='selected'?'support':'watch')});
  ctx.runner.enqueue(input(start,'selected'));await finished(ctx.runner);
  ctx.runner.enqueue(input(start,'not-selected'));await finished(ctx.runner,2);
  ctx.runner.observePrice(sample(start,100));ctx.clock.now+=300_000;ctx.runner.observePrice(sample(ctx.clock.now,200));
  const summary=ctx.runner.status().comparison.horizons[0];assert.equal(summary.pairs,2);assert.equal(summary.selectedCount,1);assert.equal(summary.rejectedCount,1);
  assert.equal(summary.baselineMeanGrossPct,100);assert.equal(summary.jevSelectedMeanGrossPct,100);
});

test('unavailable storage or disabled configuration cannot throw into the caller or call provider',async t=>{
  const ctx=setup(t,{database:'/dev/null/jev.sqlite'});assert.equal(ctx.runner.status().lastError,'JEV_STORAGE_UNAVAILABLE');
  assert.doesNotThrow(()=>ctx.runner.enqueue(input()));assert.equal(ctx.calls.length,0);assert.equal(ctx.runner.list().total,0);
  const disabled=ctx.open({enabled:false});disabled.enqueue(input());assert.equal(disabled.list().total,0);
  const conflict=ctx.open({startupError:'JEV_PATH_CONFLICT'});assert.equal(conflict.status().lastError,'JEV_STORAGE_UNAVAILABLE');
});
