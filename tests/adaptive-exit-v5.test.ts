import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADAPTIVE_SHADOW_V1,ADAPTIVE_SHADOW_V2,ADAPTIVE_SHADOW_V3,ADAPTIVE_SHADOW_V4,ADAPTIVE_SHADOW_V5,
  adaptiveExitPolicy,stepAdaptiveExit,type AdaptiveExitState,type PriceObservation,
} from '../src/adaptive-exit.js';
import {shadowReturn} from '../src/exit-shadow-return.js';

const TOKEN='0x1111111111111111111111111111111111111111';
const POOL='0x2222222222222222222222222222222222222222';
const OTHER_POOL='0x3333333333333333333333333333333333333333';
const origin=Date.parse('2026-11-11T00:00:00.000Z');
const at=(seconds:number)=>new Date(origin+seconds*1000).toISOString();
const quote=(priceUsd:number,seconds:number,patch:Partial<PriceObservation>={}):PriceObservation=>({
  chain:'bsc',address:TOKEN,priceUsd,observedAt:at(seconds),evaluatedAt:at(seconds),
  source:'dexscreener_token_pairs_sample',poolAddress:POOL,...patch,
});
const start=()=>stepAdaptiveExit(undefined,quote(100,0),undefined,ADAPTIVE_SHADOW_V5).state!;
const step=(state:AdaptiveExitState,price:number,seconds:number,patch:Partial<PriceObservation>={})=>
  stepAdaptiveExit(state,quote(price,seconds,patch),undefined,ADAPTIVE_SHADOW_V5);

test('v5 is forward-only and leaves all named v1-v4 policies frozen',()=>{
  assert.equal(adaptiveExitPolicy(ADAPTIVE_SHADOW_V5.version),ADAPTIVE_SHADOW_V5);
  assert.equal(ADAPTIVE_SHADOW_V5.hardStopDropPct,60);
  assert.equal(ADAPTIVE_SHADOW_V5.runnerActivationGainPct,100);
  assert.equal(ADAPTIVE_SHADOW_V5.protectionExitConfirmations,2);
  assert.equal(ADAPTIVE_SHADOW_V5.protectionConfirmationMinGapMs,2_000);
  assert.equal(ADAPTIVE_SHADOW_V5.protectionConfirmationMaxGapMs,90_000);
  assert.equal(ADAPTIVE_SHADOW_V5.tailEligibilityPeakGainPct,500);
  assert.equal(ADAPTIVE_SHADOW_V5.tailRetentionPctOfInitial,10);
  assert.equal(ADAPTIVE_SHADOW_V5.tailReaccelerationGainPct,50);
  assert.deepEqual(ADAPTIVE_SHADOW_V5.partialExits,[
    {gainPct:100,sellPctRemaining:50},{gainPct:500,sellPctRemaining:20},{gainPct:1000,sellPctRemaining:10},
  ]);
  for(const old of [ADAPTIVE_SHADOW_V1,ADAPTIVE_SHADOW_V2,ADAPTIVE_SHADOW_V3]){
    assert.equal(old.hardStopDropPct,40);
    assert.equal(old.tailRetentionPctOfInitial,undefined);
  }
  assert.equal(ADAPTIVE_SHADOW_V4.hardStopDropPct,40);
  assert.equal(ADAPTIVE_SHADOW_V4.protectionConfirmationMinGapMs,undefined);
});

test('pre-runner protection ignores one bad point and exits only on two reliable breach samples',()=>{
  let state=step(start(),170,3).state!;
  const first=step(state,105,6);state=first.state!;
  assert.equal(first.event,undefined);
  assert.equal(state.preRunnerProtection?.consecutiveBreaches,1);
  const tooSoon=step(state,104,7);state=tooSoon.state!;
  assert.equal(tooSoon.event,undefined);
  assert.equal(state.preRunnerProtection?.lastBreachAt,at(6));
  const confirmed=step(state,103,9);
  assert.equal(confirmed.event?.kind,'full_exit');
  assert.deepEqual(confirmed.event?.reasons,['DYNAMIC_PROTECTION_OBSERVED']);
  assert.equal(confirmed.state?.remainingPctOfInitial,0);
});

test('pre-runner and runner confirmation require same-source same-pool evidence and reset gaps over the 90 second cadence window',()=>{
  let state=step(start(),170,3).state!;
  state=step(state,105,6).state!;
  const switched=step(state,104,9,{source:'ave_price_stream_sample',poolAddress:OTHER_POOL});state=switched.state!;
  assert.equal(switched.event,undefined);assert.equal(state.preRunnerProtection?.confirmingSince,at(9));
  assert.equal(step(state,103,12,{source:'ave_price_stream_sample',poolAddress:OTHER_POOL}).event?.kind,'full_exit');

  let delayed=step(start(),170,3).state!;
  delayed=step(delayed,105,6).state!;
  const afterLongGap=step(delayed,104,97);delayed=afterLongGap.state!;
  assert.equal(afterLongGap.event,undefined);assert.equal(delayed.preRunnerProtection?.confirmingSince,at(97));
  assert.equal(step(delayed,103,100).event?.kind,'full_exit');

  let runner=step(start(),200,3).state!;
  runner=step(runner,130,6).state!;
  const different=step(runner,129,9,{source:'ave_price_stream_sample'});runner=different.state!;
  assert.equal(different.event,undefined);assert.equal(runner.runnerProtection?.consecutiveBreaches,1);
  assert.equal(runner.runnerProtection?.confirmationSource,'ave_price_stream_sample');
  assert.equal(step(runner,128,12,{source:'ave_price_stream_sample'}).event?.kind,'full_exit');
});

test('unpooled and over-age observations do not erase qualified breach evidence',()=>{
  let pre=step(start(),170,3).state!;
  pre=step(pre,105,6).state!;
  const noPool=step(pre,104,20,{source:'debot_token_info_sample',poolAddress:undefined});pre=noPool.state!;
  assert.equal(noPool.event,undefined);assert.equal(pre.preRunnerProtection?.lastBreachAt,at(6));
  const overAge=step(pre,103,40,{evaluatedAt:at(60)});pre=overAge.state!;
  assert.equal(overAge.event,undefined);assert.equal(pre.preRunnerProtection?.lastBreachAt,at(6));
  const confirmed=step(pre,102,70);
  assert.equal(confirmed.event?.kind,'full_exit');

  let runner=step(start(),200,3).state!;
  runner=step(runner,130,6).state!;
  const runnerNoPool=step(runner,129,20,{source:'debot_token_info_sample',poolAddress:undefined});runner=runnerNoPool.state!;
  assert.equal(runnerNoPool.event,undefined);assert.equal(runner.runnerProtection?.lastBreachAt,at(6));
  const runnerOverAge=step(runner,128,40,{evaluatedAt:at(60)});runner=runnerOverAge.state!;
  assert.equal(runnerOverAge.event,undefined);assert.equal(runner.runnerProtection?.lastBreachAt,at(6));
  assert.equal(step(runner,127,70).event?.kind,'full_exit');
});

test('ordinary +100 runner banks half and fully exits after reliable protection',()=>{
  const doubled=step(start(),200,3);
  assert.deepEqual(doubled.event?.stageGainsPct,[100]);
  assert.equal(doubled.event?.sellPctRemaining,50);
  assert.equal(doubled.state?.remainingPctOfInitial,50);
  assert.equal(doubled.state?.runnerProtection?.phase,'runner');
  const first=step(doubled.state!,130,6);
  assert.equal(first.event,undefined);
  const confirmed=step(first.state!,129,9);
  assert.equal(confirmed.event?.kind,'full_exit');
  assert.equal(confirmed.event?.sellPctRemaining,100);
  assert.equal(confirmed.state?.shadowClosed,true);
});

test('only a +500 runner reduces to a 10 percent tail, then needs a 50 percent new high and another reliable trail',()=>{
  const high=step(start(),600,3);
  assert.deepEqual(high.event?.stageGainsPct,[100,500]);
  assert.equal(high.state?.remainingPctOfInitial,40);
  let state=step(high.state!,440,6).state!;
  const reduced=step(state,439,9);state=reduced.state!;
  assert.equal(reduced.event?.kind,'partial_exit');
  assert.deepEqual(reduced.event?.reasons,['DYNAMIC_PROTECTION_OBSERVED']);
  assert.equal(reduced.event?.sellPctRemaining,75);
  assert.equal(state.remainingPctOfInitial,10);
  assert.equal(state.runnerProtection?.phase,'tail');
  assert.equal(state.runnerProtection?.tailCreatedPeakPriceUsd,600);

  assert.equal(step(state,300,12).event,undefined);
  state=step(state,899,15).state!;
  assert.equal(state.runnerProtection?.reacceleratedAt,undefined);
  state=step(state,900,18).state!;
  assert.equal(state.runnerProtection?.reacceleratedAt,at(18));
  const first=step(state,670,21);state=first.state!;
  assert.equal(first.event,undefined);assert.equal(state.runnerProtection?.consecutiveBreaches,1);
  const exited=step(state,660,24);
  assert.equal(exited.event?.kind,'full_exit');
  assert.equal(exited.state?.remainingPctOfInitial,0);
});

test('unpooled or over-age spikes cannot reaccelerate a dormant tail',()=>{
  let state=step(start(),600,3).state!;
  state=step(state,440,6).state!;
  state=step(state,439,9).state!;
  state=step(state,1000,12,{source:'debot_token_info_sample',poolAddress:undefined}).state!;
  assert.equal(state.runnerProtection?.reacceleratedAt,undefined);
  assert.equal(state.runnerProtection?.cyclePeakPriceUsd,600);
  state=step(state,1001,15,{evaluatedAt:at(31)}).state!;
  assert.equal(state.runnerProtection?.reacceleratedAt,undefined);
  assert.equal(state.runnerProtection?.cyclePeakPriceUsd,600);
  const first=step(state,440,32);state=first.state!;
  const second=step(state,439,35);state=second.state!;
  assert.equal(first.event,undefined);assert.equal(second.event,undefined);
  assert.equal(state.runnerProtection?.phase,'tail');assert.equal(state.remainingPctOfInitial,10);
  const reliable=step(state,900,38);
  assert.equal(reliable.state?.runnerProtection?.reacceleratedAt,at(38));
  assert.equal(step(reliable.state!,899,41).ignoredReason,undefined);
});

test('a fixed 10 percent tail never executes a later ordinary profit tier',()=>{
  let state=step(start(),600,3).state!;
  state=step(state,440,6).state!;
  state=step(state,439,9).state!;
  assert.equal(state.runnerProtection?.phase,'tail');assert.equal(state.remainingPctOfInitial,10);
  state=step(state,900,12).state!;
  const elevenX=step(state,1100,15);state=elevenX.state!;
  assert.equal(elevenX.event,undefined);assert.deepEqual(state.suggestedStages,[100,500]);
  assert.equal(state.remainingPctOfInitial,10);
  const validNext=step(state,1000,18);
  assert.equal(validNext.status,'observed');assert.equal(validNext.ignoredReason,undefined);
  assert.equal(validNext.event,undefined);assert.equal(validNext.state?.remainingPctOfInitial,10);
});

test('v5 retains the inherited pre-runner behavioral momentum exit',()=>{
  let state=start();
  state=step(state,170,60).state!;
  for(let minute=2;minute<=30;minute++){
    const observed=step(state,155-(minute-2)*0.05,minute*60);
    assert.equal(observed.event,undefined);state=observed.state!;
  }
  const exited=step(state,153.55,31*60);
  assert.deepEqual(exited.event?.reasons,['MOMENTUM_STALLED_OBSERVED']);
  assert.equal(exited.event?.kind,'full_exit');
});

test('an unconfirmed protection breach cannot suppress an independently proven momentum exit',()=>{
  let state=start();
  state=step(state,170,60,{poolAddress:undefined}).state!;
  for(let minute=2;minute<=30;minute++){
    const observed=step(state,120,minute*60,{poolAddress:undefined});
    assert.equal(observed.event,undefined);state=observed.state!;
  }
  const exited=step(state,120,31*60);
  assert.deepEqual(exited.event?.reasons,['MOMENTUM_STALLED_OBSERVED']);
  assert.equal(exited.event?.kind,'full_exit');assert.equal(exited.state?.remainingPctOfInitial,0);
});

test('corrupt persisted V5 confirmation objects are rejected without throwing',()=>{
  for(const value of [null,42,'broken']){
    const corrupt={...start(),preRunnerProtection:value} as unknown as AdaptiveExitState;
    const result=step(corrupt,105,3);
    assert.equal(result.status,'ignored');assert.equal(result.ignoredReason,'STATE_INVALID');
  }
  const corruptRunner={...start(),runnerProtection:null} as unknown as AdaptiveExitState;
  assert.equal(step(corruptRunner,105,3).ignoredReason,'STATE_INVALID');
  const corruptMomentum={...start(),momentumObservations:[null]} as unknown as AdaptiveExitState;
  assert.equal(step(corruptMomentum,105,3).ignoredReason,'STATE_INVALID');
});

test('corrupt V5 tail lifecycle and inactive optional fields are rejected',()=>{
  let tail=step(start(),600,3).state!;
  tail=step(tail,440,6).state!;
  tail=step(tail,439,9).state!;
  assert.equal(tail.runnerProtection?.phase,'tail');
  const corruptions:AdaptiveExitState[]=[
    {...tail,suggestedStages:[100]},
    {...tail,runnerProtection:{...tail.runnerProtection!,tailCreatedPeakPriceUsd:100}},
    {...tail,runnerProtection:{...tail.runnerProtection!,reacceleratedAt:tail.lastObservedAt}},
    {...tail,runnerProtection:{...tail.runnerProtection!,cyclePeakPriceUsd:700}},
  ];
  for(const corrupt of corruptions)assert.equal(step(corrupt,430,12).ignoredReason,'STATE_INVALID');

  const runner=step(start(),200,3).state!;
  for(const [field,value] of [
    ['confirmationSource',null],['confirmationSource',''],['confirmationPool',null],['lastBreachAt',null],
    ['tailCreatedAt',null],['tailCreatedPeakPriceUsd',null],['tailCreatedPeakPriceUsd',0],
  ] as const){
    const corrupt={...runner,runnerProtection:{...runner.runnerProtection!,[field]:value}} as unknown as AdaptiveExitState;
    assert.equal(step(corrupt,190,6).ignoredReason,'STATE_INVALID');
  }
  const impossibleStage={...start(),suggestedStages:[500],remainingPctOfInitial:80};
  assert.equal(step(impossibleStage,101,3).ignoredReason,'STATE_INVALID');
  const missingRunner={...start(),lastPriceUsd:200,peakPriceUsd:200,peakAt:at(3),lastObservedAt:at(3),lastEvaluatedAt:at(3),
    protectionActive:true,protectionPriceUsd:150,samples:2,lastSampleGapMs:3000,maxSampleGapMs:3000,
    volatilityReturns:[1],momentumObservations:[{observedAt:at(0),priceUsd:100},{observedAt:at(3),priceUsd:200}]};
  assert.equal(step(missingRunner,190,6).ignoredReason,'STATE_INVALID');
  const splitPeak={...runner,peakPriceUsd:300,peakAt:runner.lastObservedAt};
  assert.equal(step(splitPeak,190,6).ignoredReason,'STATE_INVALID');
  const unearnedRunner={...runner,lastPriceUsd:150,peakPriceUsd:150,protectionPriceUsd:112.5,
    runnerProtection:{...runner.runnerProtection!,cyclePeakPriceUsd:150,cycleProtectionPriceUsd:112.5}};
  assert.equal(step(unearnedRunner,149,6).ignoredReason,'STATE_INVALID');
});

test('v5 hard stop remains immediate and tail history stays initial-principal auditable',()=>{
  const stopped=step(start(),39,3);
  assert.deepEqual(stopped.event?.reasons,['HARD_STOP_OBSERVED']);
  assert.equal(stopped.event?.sellPctRemaining,100);

  const high=step(start(),600,3),first=step(high.state!,440,6),reduced=step(first.state!,439,9);
  const events=[high.event!,reduced.event!].map(event=>({at:event.observedAt,kind:event.kind,
    observationOnly:true as const,sellPct:event.sellPctRemaining,priceUsd:event.observedPriceUsd,
    remainingPct:event.remainingPctOfInitial}));
  const returns=shadowReturn(reduced.state!,events,{priceUsd:439,at:at(9),health:'fresh'});
  assert.equal(returns.status,'open');assert.equal(returns.remainingPctOfInitial,10);
  assert.equal(returns.soldPctOfInitial,90);
  assert.equal(returns.realizedGainPct,401.7);
  assert.equal(returns.unrealizedGainPct,33.9);
  assert.ok(Math.abs(returns.totalGainPct!-435.6)<1e-9);
});

test('a reaccelerated tail full exit remains exactly auditable after JSON restoration',()=>{
  const high=step(start(),600,3),first=step(high.state!,440,6),tail=step(first.state!,439,9);
  let restored=JSON.parse(JSON.stringify(tail.state)) as AdaptiveExitState;
  restored=step(restored,900,12).state!;
  restored=step(restored,670,15).state!;
  const closed=step(restored,660,18);
  assert.equal(closed.event?.kind,'full_exit');assert.equal(closed.state?.remainingPctOfInitial,0);
  const events=[high.event!,tail.event!,closed.event!].map(event=>({at:event.observedAt,kind:event.kind,
    observationOnly:true as const,sellPct:event.sellPctRemaining,priceUsd:event.observedPriceUsd,
    remainingPct:event.remainingPctOfInitial}));
  const returns=shadowReturn(closed.state!,events,{priceUsd:660,at:at(18),health:'fresh'});
  assert.equal(returns.status,'closed');assert.equal(returns.remainingPctOfInitial,0);
  assert.equal(returns.soldPctOfInitial,100);assert.ok(Math.abs(returns.realizedGainPct!-457.7)<1e-9);
  assert.ok(Math.abs(returns.finalGainPct!-457.7)<1e-9);assert.equal(returns.closedAt,at(18));
});
