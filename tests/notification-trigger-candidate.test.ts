import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNotificationTriggerCandidates,validateNotificationTriggerCandidate} from '../src/notification-trigger-candidate.js';
import type {NotificationHorizonOutcome,NotificationTriggerOutcome} from '../src/notification-outcomes.js';

const origin=Date.parse('2026-01-01T00:00:00.000Z'),iso=(ms:number)=>new Date(origin+ms).toISOString();
type Result='double'|'stop'|'neither';

function horizon(trigger:number,options:{dense?:boolean;mature?:boolean;result?:Result;baselineDelaySec?:number}={}):NotificationHorizonOutcome {
  const endsAt=iso(trigger+21600_000),mature=options.mature!==false,result=options.result??'double';
  if(!mature)return {seconds:21600,endsAt,mature:false,status:'immature'};
  return {seconds:21600,endsAt,mature:true,status:'covered',pool:'pool',baselineAt:iso(trigger),baselinePriceUsd:1,
    coverage:{samples:100,baselineDelaySec:options.baselineDelaySec??0,firstSampleAt:iso(trigger),lastSampleAt:endsAt,trailingGapSec:0,
      maxGapSecIncludingEdges:options.dense===false?900:300,observedSpanPct:100,dense:options.dense!==false},
    maxGainPct:result==='double'?150:result==='stop'?20:30,minGainPct:result==='stop'?-70:-10,
    endGainPct:result==='double'?80:result==='stop'?-40:5,maxDrawdownPct:result==='stop'?80:20,
    sampledBarrierOrder:result==='double'?'double_first':result==='stop'?'stop_first':'neither'};
}

function session(n:number,options:{
  source?:'debot'|'ave';chain?:'solana'|'bsc';withN4?:boolean;n3Dense?:boolean;n4Dense?:boolean;
  n3Result?:Result;n4Result?:Result;n4Mature?:boolean;spacingHours?:number;n3BaselineDelaySec?:number;n4BaselineDelaySec?:number;
}={}):NotificationTriggerOutcome[] {
  const spacing=(options.spacingHours??8)*3600_000,first=origin+n*spacing,threeAt=first+1000,fourAt=first+2000;
  const base={source:options.source??'debot',chain:options.chain??'solana',address:`token-${n}`,
    sessionFirstReceivedAt:iso(first),sessionExpiresAt:iso(first+21600_000),triggerOrderAmbiguous:false};
  const rows:NotificationTriggerOutcome[]=[{...base,notificationNumber:3,triggerEventId:`3-${n}`,triggerAt:iso(threeAt),
    horizons:[horizon(threeAt,{dense:options.n3Dense,result:options.n3Result,baselineDelaySec:options.n3BaselineDelaySec})]}];
  if(options.withN4!==false)rows.push({...base,notificationNumber:4,triggerEventId:`4-${n}`,triggerAt:iso(fourAt),
    horizons:[horizon(fourAt,{dense:options.n4Dense,mature:options.n4Mature,result:options.n4Result??'double',baselineDelaySec:options.n4BaselineDelaySec})]});
  return rows;
}

const asOf=(rows:NotificationTriggerOutcome[])=>new Date(Math.max(...rows.flatMap(row=>row.horizons.map(value=>Date.parse(value.endsAt))))+1000).toISOString();

test('all mature N3 sessions are the denominator and missing N4 is an explicit skipped decision',()=>{
  const rows=Array.from({length:300},(_,n)=>session(n,{withN4:n%2===0,n3Result:n%4<2?'double':'stop',n4Result:'double'})).flat();
  const candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.generatorVersion,'notification-trigger-shadow-v2');
  assert.equal(candidate.evidence.matureN3,300);
  assert.equal(candidate.evidence.train.total,240);
  assert.equal(candidate.evidence.train.n4.arrived,120);
  assert.equal(candidate.evidence.train.n4.skipped,120);
  assert.equal(candidate.evidence.train.n4.arrivalRatePct,50);
  assert.equal(candidate.evidence.validation.total,60);
  assert.equal(candidate.evidence.validation.n4.arrived,30);
  assert.equal(candidate.evidence.validation.proposed.entered,30);
  assert.equal(candidate.evidence.validation.proposed.skipped,30);
  assert.equal(candidate.evidence.validation.skippedN3.total,30);
  assert.equal(candidate.evidence.validation.skippedN3.doubleBeforeStop,15);
  assert.equal(candidate.evidence.validation.skippedN3.stopBeforeDouble,15);
  assert.equal(candidate.evidence.validation.verification.coveragePct,100);
  assert.equal(candidate.mode,'shadow');
  assert.equal(candidate.livePolicyMutation,'forbidden');
  assert.ok(validateNotificationTriggerCandidate(candidate));
});

test('selection bias is visible: skipped N3 winners remain opportunity cost rather than proposed losses',()=>{
  const rows=Array.from({length:300},(_,n)=>session(n,{withN4:n%3===0,n3Result:n%3===0?'stop':'double',n4Result:'double'})).flat();
  const candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  const validation=candidate.evidence.validation;
  assert.equal(validation.n4.arrivalRatePct,33.333333);
  assert.equal(validation.skippedN3.doubleBeforeStop,40);
  assert.equal(validation.skippedN3.stopBeforeDouble,0);
  assert.equal(validation.proposed.stopBeforeDoubleRatePct,0);
  assert.equal(validation.decision.proposed.adverse,40);
  assert.equal(validation.decision.proposed.adverseRatePct,66.666667);
  assert.equal(validation.proposed.covered,20);
  assert.equal(validation.proposed.skipped,40);
});

test('only dense paths count as verifiable coverage',()=>{
  const rows=Array.from({length:300},(_,n)=>session(n,{withN4:n%2===0,n3Dense:n%10!==0,
    n4Dense:n%10!==2,n3Result:'stop',n4Result:'double'})).flat();
  const candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  // Sparse N3 rows fail directly; sparse N4 rows also invalidate the paired comparison.
  assert.equal(candidate.evidence.train.verification.coveragePct,80);
  assert.equal(candidate.evidence.validation.verification.coveragePct,80);
  assert.equal(candidate.status,'collecting');
  assert.ok(candidate.reasons.includes('MINIMUM_VERIFICATION_COVERAGE_NOT_MET'));
});

test('a dense path with a baseline later than 60 seconds is not promotion evidence',()=>{
  const rows=Array.from({length:300},(_,n)=>session(n,{n3Result:'stop',n4Result:'double',
    n3BaselineDelaySec:n%10===0?61:60,n4BaselineDelaySec:n%10===1?61:60})).flat();
  const candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.evidence.train.verification.coveragePct,80);
  assert.equal(candidate.evidence.validation.verification.coveragePct,80);
  assert.equal(candidate.status,'collecting');
  assert.ok(candidate.reasons.includes('MINIMUM_VERIFICATION_COVERAGE_NOT_MET'));
});

test('N4 arrival with an immature outcome stays in the denominator but is not verified',()=>{
  const rows=Array.from({length:200},(_,n)=>session(n,{n3Result:'stop',n4Result:'double'})).flat();
  const last=session(999,{n3Result:'stop',n4Result:'double',n4Mature:false});
  // Its N3 result is mature while its later N4 result has not completed yet.
  last[1].triggerAt=iso(Date.parse(last[0].triggerAt)-origin+20_000_000);
  last[1].horizons=[horizon(Date.parse(last[1].triggerAt)-origin,{mature:false,result:'double'})];
  const currentEnd=Date.parse(last[0].horizons[0].endsAt),candidate=buildNotificationTriggerCandidates({asOf:new Date(currentEnd+1000).toISOString(),outcomes:last})[0];
  assert.equal(candidate.evidence.matureN3,1);
  assert.equal(candidate.evidence.validation.n4.arrived,1);
  assert.equal(candidate.evidence.validation.n4.skipped,0);
  assert.equal(candidate.evidence.validation.verification.covered,0);
  assert.equal(candidate.evidence.validation.proposed.covered,0);
});

test('an almost-never-arriving N4 cannot look ready merely by avoiding nearly every trade',()=>{
  const rows=Array.from({length:300},(_,n)=>session(n,{withN4:n%30===0,n3Result:'stop',n4Result:'double'})).flat();
  const candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.evidence.train.n4.arrived,8);
  assert.equal(candidate.evidence.validation.n4.arrived,2);
  assert.equal(candidate.evidence.train.verification.coveragePct,100);
  assert.ok(candidate.evidence.train.decision.deltas.favorableRatePct!>0);
  assert.equal(candidate.status,'collecting');
  assert.ok(candidate.reasons.includes('MINIMUM_TRAIN_N4_ARRIVALS_NOT_MET'));
  assert.ok(candidate.reasons.includes('MINIMUM_VALIDATION_N4_ARRIVALS_NOT_MET'));
  assert.deepEqual(candidate.requirements.minimumTrainN4Arrivals,100);
  assert.deepEqual(candidate.requirements.minimumValidationN4Arrivals,20);
});

test('DeBot and Ave cohorts and chains never share a denominator',()=>{
  const rows=[...Array.from({length:200},(_,n)=>session(n,{source:'debot'})).flat(),
    ...Array.from({length:200},(_,n)=>session(n+300,{source:'ave'})).flat(),
    ...Array.from({length:200},(_,n)=>session(n+600,{chain:'bsc'})).flat()];
  const candidates=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows});
  assert.deepEqual(candidates.map(value=>[value.scope.source,value.scope.chain,value.evidence.matureN3]),
    [['ave','solana',200],['debot','bsc',200],['debot','solana',200]]);
});

test('minimum 200 mature N3 and chronological validation gates remain collecting',()=>{
  let rows=Array.from({length:199},(_,n)=>session(n,{n3Result:'stop',n4Result:'double'})).flat();
  let candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.status,'collecting');
  assert.ok(candidate.reasons.includes('MINIMUM_MATURE_N3_NOT_MET'));
  rows=Array.from({length:200},(_,n)=>session(n,{n3Result:'stop',n4Result:'double'})).flat();
  candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.evidence.validation.total,40);
});

test('time holdout rejects a reversal and purges overlapping training outcomes',()=>{
  let rows=Array.from({length:300},(_,n)=>session(n,{n3Result:'stop',n4Result:n>=240?'stop':'double'})).flat();
  let candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.status,'not_replicated');
  assert.ok(candidate.reasons.includes('VALIDATION_IMPROVEMENT_NOT_OBSERVED'));
  rows=Array.from({length:300},(_,n)=>session(n,{spacingHours:1/60,n3Result:'stop',n4Result:'double'})).flat();
  candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.evidence.purgedTraining,240);
  assert.equal(candidate.evidence.train.total,0);
  assert.equal(candidate.status,'collecting');
});

test('later duplicate revisions can supply dense evidence without duplicating the session',()=>{
  const original=session(1,{n3Dense:false,n4Dense:false}),revision=session(1,{n3Dense:true,n4Dense:true});
  const candidate=buildNotificationTriggerCandidates({asOf:asOf(revision),outcomes:[...original,...revision]})[0];
  assert.equal(candidate.evidence.matureN3,1);
  assert.equal(candidate.evidence.validation.verification.covered,1);
});

test('unrelated signal sources and immature N3 sessions are excluded',()=>{
  const manual=session(1).map(value=>({...value,source:'manual' as const}));
  const immature=session(2).map(value=>({...value,horizons:value.horizons.map(item=>({...item,mature:false,status:'immature' as const}))}));
  assert.deepEqual(buildNotificationTriggerCandidates({asOf:asOf([...manual,...immature]),outcomes:[...manual,...immature]}),[]);
});
