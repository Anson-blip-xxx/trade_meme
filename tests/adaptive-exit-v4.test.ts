import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADAPTIVE_SHADOW_V1,ADAPTIVE_SHADOW_V2,ADAPTIVE_SHADOW_V3,ADAPTIVE_SHADOW_V4,
  adaptiveExitPolicy,stepAdaptiveExit,type AdaptiveExitState,type PriceObservation,
} from '../src/adaptive-exit.js';
import {shadowReturn} from '../src/exit-shadow-return.js';

const TOKEN='0x1111111111111111111111111111111111111111';
const at=(minute:number)=>new Date(Date.UTC(2026,0,1,0,minute)).toISOString();
const quote=(priceUsd:number,minute:number):PriceObservation=>({chain:'bsc',address:TOKEN,priceUsd,
  observedAt:at(minute),evaluatedAt:at(minute),source:'dexscreener_token_pairs_sample'});
const start=(price=100)=>stepAdaptiveExit(undefined,quote(price,0),undefined,ADAPTIVE_SHADOW_V4).state!;
const step=(state:AdaptiveExitState,price:number,minute:number)=>stepAdaptiveExit(state,quote(price,minute),undefined,ADAPTIVE_SHADOW_V4);

test('v4 is an explicit +100 runner treatment and leaves frozen v1-v3 parameters unchanged',()=>{
  assert.equal(adaptiveExitPolicy(ADAPTIVE_SHADOW_V4.version),ADAPTIVE_SHADOW_V4);
  assert.equal(ADAPTIVE_SHADOW_V4.hardStopDropPct,40);
  assert.equal(ADAPTIVE_SHADOW_V4.runnerActivationGainPct,100);
  assert.equal(ADAPTIVE_SHADOW_V4.protectionExitConfirmations,2);
  assert.deepEqual(ADAPTIVE_SHADOW_V4.partialExits,[
    {gainPct:100,sellPctRemaining:50},{gainPct:500,sellPctRemaining:20},{gainPct:1000,sellPctRemaining:10},
  ]);
  for(const old of [ADAPTIVE_SHADOW_V1,ADAPTIVE_SHADOW_V2,ADAPTIVE_SHADOW_V3]){
    assert.equal(old.hardStopDropPct,40);
    assert.deepEqual(old.partialExits,[{gainPct:500,sellPctRemaining:20},{gainPct:1000,sellPctRemaining:10}]);
    assert.equal(old.runnerActivationGainPct,undefined);
    assert.equal(old.protectionExitConfirmations,undefined);
  }
});

test('before +100 v4 preserves the v3 hard stop and dynamic-protection decision',()=>{
  for(const prices of [[100,60],[100,160,100]]){
    let v3:AdaptiveExitState|undefined,v4:AdaptiveExitState|undefined,v3Event,v4Event;
    for(const [minute,price] of prices.entries()){
      const a=stepAdaptiveExit(v3,quote(price,minute),undefined,ADAPTIVE_SHADOW_V3);
      const b=stepAdaptiveExit(v4,quote(price,minute),undefined,ADAPTIVE_SHADOW_V4);
      v3=a.state;v4=b.state;v3Event=a.event;v4Event=b.event;
    }
    assert.equal(v4Event?.kind,v3Event?.kind);
    assert.deepEqual(v4Event?.reasons,v3Event?.reasons);
    assert.equal(v4Event?.sellPctRemaining,v3Event?.sellPctRemaining);
    assert.equal(v4?.runnerProtection,undefined);
  }
});

test('at +100 v4 banks half and starts a reset runner, then retains later stages',()=>{
  const doubled=step(start(),200,1);
  assert.deepEqual(doubled.event?.stageGainsPct,[100]);
  assert.equal(doubled.event?.sellPctRemaining,50);
  assert.equal(doubled.state?.remainingPctOfInitial,50);
  assert.deepEqual(doubled.state?.runnerProtection,{activatedAt:at(1),activationStageGainPct:100,
    cyclePeakPriceUsd:200,cyclePeakAt:at(1),cycleProtectionPriceUsd:136,consecutiveBreaches:0});
  assert.equal(doubled.state?.peakPriceUsd,200);
  assert.equal(doubled.state?.protectionPriceUsd,136);

  const fiveX=step(doubled.state!,600,2);
  assert.deepEqual(fiveX.event?.stageGainsPct,[500]);
  assert.equal(fiveX.state?.remainingPctOfInitial,40);
  const tenX=step(fiveX.state!,1100,3);
  assert.deepEqual(tenX.event?.stageGainsPct,[1000]);
  assert.equal(tenX.state?.remainingPctOfInitial,36);
  assert.equal(tenX.state?.shadowClosed,false);
});

test('runner needs two consecutive post-activation breaches and an isolated breach does not sell',()=>{
  const active=step(start(),200,1);
  const first=step(active.state!,130,2);
  assert.equal(first.event,undefined);
  assert.equal(first.state?.remainingPctOfInitial,50);
  assert.equal(first.state?.runnerProtection?.consecutiveBreaches,1);
  assert.equal(first.state?.runnerProtection?.confirmingSince,at(2));

  const confirmed=step(first.state!,129,3);
  assert.equal(confirmed.event?.kind,'full_exit');
  assert.deepEqual(confirmed.event?.reasons,['DYNAMIC_PROTECTION_OBSERVED']);
  assert.equal(confirmed.event?.sellPctRemaining,100);
  assert.equal(confirmed.state?.remainingPctOfInitial,0);
});

test('runner recovery and a long quote gap both break breach continuity',()=>{
  let state=step(start(),200,1).state!;
  state=step(state,130,2).state!;
  const recovered=step(state,150,3);
  assert.equal(recovered.event,undefined);
  assert.equal(recovered.state?.runnerProtection?.consecutiveBreaches,0);
  assert.equal(recovered.state?.runnerProtection?.confirmingSince,undefined);

  const first=step(recovered.state!,130,4);
  assert.equal(first.state?.runnerProtection?.consecutiveBreaches,1);
  const afterGap=step(first.state!,129,10);
  assert.equal(afterGap.event,undefined);
  assert.equal(afterGap.state?.runnerProtection?.consecutiveBreaches,1);
  assert.equal(afterGap.state?.runnerProtection?.confirmingSince,at(10));
  assert.equal(step(afterGap.state!,128,11).event?.kind,'full_exit');
});

test('a new profit stage still records while runner breach confirmation is pending',()=>{
  const active=step(start(),200,1).state!;
  const prepared:AdaptiveExitState={...active,lastPriceUsd:2000,lastObservedAt:at(2),lastEvaluatedAt:at(2),
    peakPriceUsd:2000,peakAt:at(2),protectionPriceUsd:1500,suggestedStages:[100,500],remainingPctOfInitial:40,
    runnerProtection:{...active.runnerProtection!,cyclePeakPriceUsd:2000,cyclePeakAt:at(2),cycleProtectionPriceUsd:1500}};
  const staged=step(prepared,1100,3);
  assert.deepEqual(staged.event?.reasons,['PARTIAL_PROFIT_STAGE_OBSERVED']);
  assert.deepEqual(staged.event?.stageGainsPct,[1000]);
  assert.equal(staged.state?.remainingPctOfInitial,36);
  assert.equal(staged.state?.runnerProtection?.consecutiveBreaches,1);
  assert.equal(step(staged.state!,1090,4).event?.kind,'full_exit');
});

test('v4 partial history remains auditable by initial-principal return accounting',()=>{
  const first=step(start(),200,1),second=step(first.state!,600,2);
  const events=[first.event!,second.event!].map(event=>({at:event.observedAt,kind:event.kind,
    observationOnly:true as const,sellPct:event.sellPctRemaining,priceUsd:event.observedPriceUsd,
    remainingPct:event.remainingPctOfInitial}));
  const value=shadowReturn(second.state!,events,{priceUsd:second.state!.lastPriceUsd,at:second.state!.lastObservedAt,health:'fresh'});
  assert.equal(value.status,'open');
  assert.equal(value.reason,undefined);
  assert.equal(value.remainingPctOfInitial,40);
  assert.equal(value.realizedGainPct,100);
  assert.equal(value.unrealizedGainPct,200);
  assert.equal(value.totalGainPct,300);
});

test('hard stop overrides runner confirmation and restored state is deterministic',()=>{
  const active=step(start(),200,1).state!,first=step(active,130,2).state!;
  const restored=JSON.parse(JSON.stringify(first)) as AdaptiveExitState;
  assert.deepEqual(step(restored,129,3),step(first,129,3));
  const stopped=step(active,60,2);
  assert.deepEqual(stopped.event?.reasons,['HARD_STOP_OBSERVED']);
  assert.equal(stopped.state?.shadowClosed,true);
});

test('v4 rejects corrupt runner persistence and old policies reject v4-only state',()=>{
  const active=step(start(),200,1).state!;
  const corrupt={...active,runnerProtection:{activatedAt:at(1),consecutiveBreaches:1}} as unknown as AdaptiveExitState;
  assert.equal(step(corrupt,150,2).ignoredReason,'STATE_INVALID');
  const impossibleOpen={...active,runnerProtection:{...active.runnerProtection!,consecutiveBreaches:2,
    confirmingSince:at(2)}} as AdaptiveExitState;
  assert.equal(step(impossibleOpen,130,3).ignoredReason,'STATE_INVALID');
  const old=stepAdaptiveExit(undefined,quote(100,0),undefined,ADAPTIVE_SHADOW_V3).state!;
  const contaminated={...old,runnerProtection:active.runnerProtection} as AdaptiveExitState;
  assert.equal(stepAdaptiveExit(contaminated,quote(101,1),undefined,ADAPTIVE_SHADOW_V3).ignoredReason,'STATE_INVALID');
});
