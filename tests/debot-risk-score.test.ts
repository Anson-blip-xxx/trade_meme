import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreDebotRisk,type DebotRiskScoreInput} from '../src/debot-risk-score.js';

const now=new Date('2026-10-15T07:00:00.000Z');
const at=(ms=0)=>new Date(now.getTime()+ms).toISOString();
const pass=()=>({status:'pass',checkedAt:at(),reasons:[]});
function input():DebotRiskScoreInput {
  return {state:'completed',decision:'BUY_CANDIDATE',validUntil:at(30_000),
    checks:{safety:pass(),provenance:pass(),market:pass(),wallets:pass()},reasons:[]};
}
const checks=(value:DebotRiskScoreInput)=>value.checks as Record<string,any>;
const score=(value=input(),clock=now)=>scoreDebotRisk(value,clock);

test('score uses four fixed weights totaling 100 and cannot import a vendor or caller score',()=>{
  const value=input();Object.assign(value,{score:900,value:900,weights:{wallets:900}});
  Object.assign(checks(value).wallets,{score:900,earned:900,weight:900});
  const result=score(value);
  assert.deepEqual(result.components.map(({key,weight,earned,status})=>({key,weight,earned,status})),[
    {key:'safety',weight:30,earned:30,status:'pass'},
    {key:'provenance',weight:15,earned:15,status:'pass'},
    {key:'market',weight:15,earned:15,status:'pass'},
    {key:'wallets',weight:40,earned:40,status:'pass'},
  ]);
  assert.equal(result.value,100);assert.equal(result.max,100);assert.equal(result.version,'risk-evidence-v1');
  assert.equal(result.blocked,false);assert.equal(result.provisional,false);assert.equal(result.stale,false);
});

test('unknown and missing evidence earn no points without inventing safety',()=>{
  const value=input();checks(value).market.status='unknown';delete checks(value).wallets;
  const result=score(value);assert.equal(result.value,45);assert.equal(result.provisional,true);
  assert.equal(result.components[2].earned,0);assert.equal(result.components[3].status,'unknown');
  assert.equal(result.blocked,false);assert.equal(result.stale,true);
});

for(const key of ['safety','provenance','market'])test(`${key} failure overrides total score while preserving the other explanatory components`,()=>{
  const value=input();checks(value)[key].status='fail';const result=score(value);
  assert.equal(result.blocked,true);assert.equal(result.value,0);
  assert.equal(result.components.find(c=>c.key===key)?.earned,0);
  assert.equal(result.components.find(c=>c.key==='wallets')?.earned,40);
  assert.ok(result.reasons.includes(`RISK_SCORE_${key.toUpperCase()}_FAILED`));
});

test('wallet failure earns zero without inventing a contract-safety rejection',()=>{
  const value=input();checks(value).wallets.status='fail';value.decision='WATCH';
  const result=score(value);assert.equal(result.value,60);assert.equal(result.blocked,false);
  assert.equal(result.provisional,false);assert.equal(result.stale,false);
});

test('REJECT decision forces zero even if separately published stage evidence passes',()=>{
  const value=input();value.decision='REJECT';
  const result=score(value);assert.equal(result.value,0);assert.equal(result.blocked,true);
  assert.equal(result.components.reduce((sum,c)=>sum+c.earned,0),100);
  assert.ok(result.reasons.includes('RISK_SCORE_REJECTED'));
});

test('WATCH and unsupported execution mode remain visible without fabricating a point deduction or eligibility',()=>{
  const value=input();value.decision='WATCH';value.reasons=['LAUNCHPAD_MODE_NOT_SUPPORTED'];
  const result=score(value);assert.equal(result.value,100);assert.equal(result.blocked,false);
  assert.ok(result.reasons.includes('LAUNCHPAD_MODE_NOT_SUPPORTED'));
  assert.equal('buyEligible' in result,false);assert.equal(value.decision,'WATCH');
});

test('narrative prose, ratings and narrative status do not add or subtract risk points',()=>{
  const expected=score();const value=input();
  checks(value).narrative={status:'fail',rating:0,checkedAt:'invalid',reasons:['NARRATIVE_REJECTED']};
  assert.deepEqual(score(value),expected);
  checks(value).narrative={status:'pass',score:1000,rating:'strong_buy'};
  assert.deepEqual(score(value),expected);
});

test('in-progress results remain provisional even when every stage has passed',()=>{
  const value=input();value.state='dispatching';delete value.validUntil;
  const result=score(value);assert.equal(result.value,100);assert.equal(result.provisional,true);
  assert.equal(result.stale,false);assert.equal(result.blocked,false);
});

test('pending, interrupted and failed states without returned evidence cannot imply stale checks or completion',()=>{
  for(const state of ['pending','dispatching','interrupted','failed','ignored','invalid']){
    const result=score({state,checks:{}});assert.equal(result.value,0);assert.equal(result.provisional,true);
    assert.equal(result.stale,false);assert.equal(result.blocked,false);
  }
});

test('expiration is inclusive and leaves a historical score explicitly stale',()=>{
  for(const offset of [-1,0,1]){
    const value=input();value.validUntil=at(offset);
    const result=score(value);assert.equal(result.stale,offset<=0);assert.equal(result.value,100);
    assert.equal(result.reasons.includes('RISK_SCORE_EXPIRED'),offset<=0);
  }
});

test('check freshness expires at 120 seconds, but not one millisecond before',()=>{
  for(const age of [119_999,120_000,120_001]){
    const value=input();checks(value).wallets.checkedAt=at(-age);
    const result=score(value);assert.equal(result.stale,age>=120_000);assert.equal(result.value,100);
    assert.equal(result.reasons.includes('RISK_SCORE_STALE_CHECK'),age>=120_000);
  }
});

test('check timestamps allow 30 seconds of skew and reject anything further in the future',()=>{
  for(const future of [29_999,30_000,30_001]){
    const value=input();checks(value).safety.checkedAt=at(future);
    const result=score(value);assert.equal(result.stale,future>30_000);
    assert.equal(result.reasons.includes('RISK_SCORE_FUTURE_CHECK_TIME'),future>30_000);
  }
});

test('missing or malformed final validity is stale; malformed supplied validity is stale during progress too',()=>{
  for(const stamp of [undefined,null,'',false,123,'2026','invalid']){
    const value=input();value.validUntil=stamp as any;
    assert.equal(score(value).stale,true);
    value.state='dispatching';assert.equal(score(value).stale,stamp!==undefined);
  }
});

test('a returned check with missing or malformed time is stale, even while analysis is running',()=>{
  for(const stamp of [undefined,null,'',123,'2026','invalid']){
    const value=input();checks(value).market.checkedAt=stamp;value.state='dispatching';
    const result=score(value);assert.equal(result.stale,true);
    assert.ok(result.reasons.includes('RISK_SCORE_INVALID_CHECK_TIME'));
  }
});

test('timestamp validation rejects impossible calendar dates while accepting explicit ISO time offsets',()=>{
  const value=input();checks(value).safety.checkedAt='2026-02-30T07:00:00.000Z';
  assert.ok(score(value).reasons.includes('RISK_SCORE_INVALID_CHECK_TIME'));
  checks(value).safety.checkedAt='2026-10-15T24:00:00.000Z';
  assert.ok(score(value).reasons.includes('RISK_SCORE_INVALID_CHECK_TIME'));
  checks(value).safety.checkedAt='2026-10-15T15:00:00+08:00';
  value.validUntil='2026-10-15T15:00:30+08:00';
  assert.equal(score(value).stale,false);
});

test('malformed checks and inherited keys are unknown, never accepted as passing evidence',()=>{
  for(const malformed of [undefined,null,[],42,'pass',true,Object.create({safety:pass(),provenance:pass(),market:pass(),wallets:pass()})]){
    const value=input();value.checks=malformed;
    const result=score(value);assert.equal(result.value,0);assert.equal(result.provisional,true);
    assert.equal(result.stale,true);assert.ok(result.components.every(c=>c.status==='unknown'));
  }
  for(const malformed of [null,[],true,'pass',{status:'PASS'},{status:1},{status:true},Object.create(pass())]){
    const value=input();checks(value).wallets=malformed;
    assert.equal(score(value).value,60);assert.equal(score(value).components[3].status,'unknown');
  }
});

test('untrusted text, non-string reasons, oversized codes and extra keys are omitted from bounded output',()=>{
  const value=input();value.reasons=['LAUNCHPAD_MODE_NOT_SUPPORTED','cookie=private-token','<script>secret</script>',
    'secret words',1,null,{},'A'.repeat(101),...Array.from({length:100},(_,n)=>`REASON_${n}`)] as any;
  checks(value).safety.reasons=['LAUNCHPAD_MODE_NOT_SUPPORTED','SAFETY_VALIDATED','Authorization: private'];
  checks(value).private={status:'pass',secret:'private-token'};
  const result=score(value),serialized=JSON.stringify(result);
  assert.ok(result.reasons.length<=32);assert.equal(new Set(result.reasons).size,result.reasons.length);
  assert.equal(result.reasons.filter(r=>r==='LAUNCHPAD_MODE_NOT_SUPPORTED').length,1);
  assert.ok(result.reasons.every(r=>/^[A-Z][A-Z0-9_]{0,99}$/.test(r)));
  assert.equal(serialized.includes('private'),false);assert.equal(serialized.includes('script'),false);
  value.reasons='LAUNCHPAD_MODE_NOT_SUPPORTED' as any;checks(value).safety.reasons={secret:'value'};
  assert.doesNotThrow(()=>score(value));
});

test('input remains unchanged and an invalid clock is explicitly stale instead of silently current',()=>{
  const value=input(),before=structuredClone(value);const result=score(value,new Date('invalid'));
  assert.equal(result.stale,true);assert.ok(result.reasons.includes('RISK_SCORE_CLOCK_INVALID'));
  assert.deepEqual(value,before);
  assert.doesNotThrow(()=>scoreDebotRisk(null as any,now));
});
