import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNotificationTriggerCandidates} from '../src/notification-trigger-candidate.js';
import type {NotificationHorizonOutcome,NotificationTriggerOutcome} from '../src/notification-outcomes.js';

const origin=Date.parse('2026-01-01T00:00:00.000Z'),iso=(ms:number)=>new Date(origin+ms).toISOString();
function horizon(trigger:number,covered:boolean,good:boolean):NotificationHorizonOutcome {
  const endsAt=iso(trigger+21600_000);
  if(!covered)return {seconds:21600,endsAt,mature:true,status:'unknown',unknownReason:'NO_POST_BASELINE_SAMPLE'};
  return {seconds:21600,endsAt,mature:true,status:'covered',pool:'pool',baselineAt:iso(trigger),baselinePriceUsd:1,
    coverage:{samples:100,baselineDelaySec:0,firstSampleAt:iso(trigger),lastSampleAt:endsAt,trailingGapSec:0,maxGapSecIncludingEdges:300,observedSpanPct:100,dense:true},
    maxGainPct:good?150:30,minGainPct:good?-10:-70,endGainPct:good?80:-40,maxDrawdownPct:good?20:80,
    sampledBarrierOrder:good?'double_first':'stop_first'};
}
function pair(n:number,options:{source?:'debot'|'ave';chain?:'solana'|'bsc';covered?:boolean;reverse?:boolean;spacingHours?:number}={}):NotificationTriggerOutcome[] {
  const spacing=(options.spacingHours??8)*3600_000,first=origin+n*spacing,threeAt=first+1000,fourAt=first+2000,late=options.reverse===true&&n>=240;
  const base={source:options.source??'debot',chain:options.chain??'solana',address:`token-${n}`,sessionFirstReceivedAt:iso(first),sessionExpiresAt:iso(first+21600_000),triggerOrderAmbiguous:false};
  return [{...base,notificationNumber:3,triggerEventId:`3-${n}`,triggerAt:iso(threeAt),horizons:[horizon(threeAt,options.covered!==false,late)]},
    {...base,notificationNumber:4,triggerEventId:`4-${n}`,triggerAt:iso(fourAt),horizons:[horizon(fourAt,options.covered!==false,!late)]}];
}
const asOf=(rows:NotificationTriggerOutcome[])=>new Date(Math.max(...rows.flatMap(row=>row.horizons.map(h=>Date.parse(h.endsAt))))+1000).toISOString();

test('compares notification three with four per source and chain using a chronological holdout',()=>{
  const rows=Array.from({length:300},(_,n)=>pair(n,{covered:n%20!==0})).flat(),candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.scope.source,'debot');assert.equal(candidate.scope.chain,'solana');assert.equal(candidate.scope.horizonSec,21600);
  assert.deepEqual(candidate.change,{parameter:'signal.trigger_count',from:3,to:4});assert.equal(candidate.status,'shadow_ready');
  assert.equal(candidate.evidence.maturePairs,300);assert.equal(candidate.evidence.train.total,240);assert.equal(candidate.evidence.validation.total,60);
  assert.equal(candidate.evidence.train.current.coveragePct,95);assert.equal(candidate.evidence.validation.proposed.coveragePct,95);
  assert.ok(candidate.evidence.validation.deltas.doubleBeforeStopRatePct!>0);assert.ok(candidate.evidence.validation.deltas.stopBeforeDoubleRatePct!<0);
  assert.equal(candidate.mode,'shadow');assert.equal(candidate.livePolicyMutation,'forbidden');assert.match(candidate.id,/^[a-f0-9]{64}$/);
});

test('source and chain never share a denominator',()=>{
  const rows=[...Array.from({length:200},(_,n)=>pair(n,{source:'debot'})).flat(),
    ...Array.from({length:200},(_,n)=>pair(n+300,{source:'ave'})).flat(),...Array.from({length:200},(_,n)=>pair(n+600,{chain:'bsc'})).flat()];
  const candidates=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows});
  assert.deepEqual(candidates.map(row=>[row.scope.source,row.scope.chain,row.evidence.maturePairs]),[['ave','solana',200],['debot','bsc',200],['debot','solana',200]]);
});

test('fewer than 200 pairs or less than 90% price coverage remains collecting',()=>{
  let rows=Array.from({length:199},(_,n)=>pair(n)).flat(),candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.status,'collecting');assert.ok(candidate.reasons.includes('MINIMUM_MATURE_PAIRS_NOT_MET'));
  rows=Array.from({length:300},(_,n)=>pair(n,{covered:n%10!==0&&n%10!==1})).flat();candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.status,'collecting');assert.ok(candidate.reasons.includes('MINIMUM_COVERAGE_NOT_MET'));
});

test('validation reversal is rejected and outcome overlap is purged',()=>{
  let rows=Array.from({length:300},(_,n)=>pair(n,{reverse:true})).flat(),candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.status,'not_replicated');assert.ok(candidate.reasons.includes('VALIDATION_IMPROVEMENT_NOT_OBSERVED'));
  rows=Array.from({length:300},(_,n)=>pair(n,{spacingHours:1/60})).flat();candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.evidence.purgedTraining,240);assert.equal(candidate.evidence.train.total,0);assert.equal(candidate.status,'collecting');
});

test('unpaired, immature and wrong-horizon observations are excluded instead of treated as losses',()=>{
  const complete=pair(1),unpaired=pair(2).slice(0,1),immature=pair(3).map(row=>({...row,horizons:row.horizons.map(h=>({...h,mature:false,status:'immature' as const}))}));
  const wrong=pair(4).map(row=>({...row,horizons:[{...row.horizons[0],seconds:3600}]}));
  const rows=[...complete,...unpaired,...immature,...wrong],candidate=buildNotificationTriggerCandidates({asOf:asOf(rows),outcomes:rows})[0];
  assert.equal(candidate.evidence.maturePairs,1);assert.equal(candidate.status,'collecting');
});
