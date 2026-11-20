import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelNativeAdaptiveProtectionAction,confirmNativeAdaptiveProtectionAction,
  createNativeAdaptiveProtectionState,createNativeAdaptiveProtectionStateAfterLegacyTakeProfit,
  nativeExecutableValueBps,restoreNativeAdaptiveProtectionState,
  updateNativeAdaptiveProtection,type NativeAdaptiveProtectionInput,type NativeAdaptiveProtectionState,
} from '../src/native-solana/adaptive-protection.js';

const input=(valueBps:number,id:string,overrides:Partial<NativeAdaptiveProtectionInput>={}):NativeAdaptiveProtectionInput=>({
  costLamports:'10000',boughtTokenAtoms:'10000',currentTokenAtoms:'10000',quoteOutputLamports:String(valueBps),observationId:id,...overrides,
});
const step=(state:NativeAdaptiveProtectionState,valueBps:number,id:string)=>updateNativeAdaptiveProtection(state,input(valueBps,id));
const positionStep=(state:NativeAdaptiveProtectionState,valueBps:number,id:string,currentTokenAtoms:string)=>{
  const output=BigInt(valueBps)*BigInt(currentTokenAtoms)/10000n;
  return updateNativeAdaptiveProtection(state,input(0,id,{currentTokenAtoms,quoteOutputLamports:output.toString()}));
};

test('exact executable ratio is integer-only and a rising market never takes fixed-multiple profit',()=>{
  assert.equal(nativeExecutableValueBps(input(12345,'q1',{boughtTokenAtoms:'9007199254740993000',currentTokenAtoms:'4503599627370496500'})),'24690');
  let state=createNativeAdaptiveProtectionState();
  for(const [value,id] of [[12000,'a'],[13500,'b'],[20000,'c'],[60000,'d']] as const){
    const result=step(state,value,id);state=result.state;assert.equal(result.decision,undefined);
  }
  assert.equal(state.peakValueBps,'60000');assert.equal(state.protectionFloorBps,'51000');
  assert.throws(()=>nativeExecutableValueBps({...input(10000,'bad'),currentTokenAtoms:'0'}),/INPUT_INVALID/);
});

test('a legacy completed 2x take-profit resumes as a protected unarmed runner',()=>{
  let state=createNativeAdaptiveProtectionStateAfterLegacyTakeProfit();
  assert.equal(state.phase,'runner');assert.equal(state.peakValueBps,'20000');
  assert.equal(state.protectionFloorBps,'16000');assert.equal(state.runnerSafetyFloorBps,'14000');
  assert.equal(state.runnerRearmValueBps,'21000');assert.equal(state.runnerArmed,false);
  let result=step(state,15600,'legacy-retrace');state=result.state;
  assert.equal(result.decision,undefined,'the retained half is not sold again on a 2x to 1.56x retrace');
  result=step(state,4000,'legacy-crash');assert.equal(result.decision?.kind,'emergency_stop');assert.equal(result.decision?.sellPercent,100);
});

test('the protection floor never falls and ordinary weakness needs two distinct consecutive observations',()=>{
  let state=step(createNativeAdaptiveProtectionState(),18000,'peak').state;
  assert.equal(state.protectionFloorBps,'13500');
  let result=step(state,13400,'first');state=result.state;assert.equal(result.decision,undefined);assert.equal(state.breachCount,1);
  result=step(state,13400,'first');state=result.state;assert.equal(result.decision,undefined);assert.equal(state.breachCount,1,'duplicate quote is not a confirmation');
  state=step(state,14000,'recovery').state;assert.equal(state.breachCount,0);
  state=step(state,13400,'again-1').state;result=step(state,13300,'again-2');
  assert.equal(result.decision?.kind,'profit_protection');assert.equal(result.decision?.sellPercent,20);assert.equal(result.decision?.actionId,'native-adaptive-v1:1:core');
  assert.equal(result.state.protectionFloorBps,'13500');
});

test('core exit size adapts to the observed peak while always retaining a tail',()=>{
  for(const [peak,expected] of [[18000,20],[21000,50],[30000,33],[50000,20],[80000,20]] as const){
    let state=step(createNativeAdaptiveProtectionState(),peak,`peak-${peak}`).state;
    const floor=Number(state.protectionFloorBps);state=step(state,floor-100,`breach-a-${peak}`).state;
    const result=step(state,floor-200,`breach-b-${peak}`);assert.equal(result.decision?.sellPercent,expected);
  }
});

test('first 2x crossing holds new highs, acts on clear weakness, and resolves 2.2x as strong',()=>{
  let state=step(createNativeAdaptiveProtectionState(),19900,'before-2x').state;
  let result=step(state,20000,'cross-2x');state=result.state;
  assert.equal(result.decision,undefined);assert.deepEqual(state.twoXFollowThrough,{status:'watching',seen:0,windowPeakBps:'20000'});
  state=step(state,20000,'cross-2x').state;assert.equal(state.twoXFollowThrough?.status==='watching'&&state.twoXFollowThrough.seen,0);
  state=step(state,21000,'follow-high-1').state;
  assert.deepEqual(state.twoXFollowThrough,{status:'watching',seen:0,windowPeakBps:'21000'});
  state=restoreNativeAdaptiveProtectionState(JSON.parse(JSON.stringify(state)));
  state=step(state,21500,'follow-high-2').state;
  assert.deepEqual(state.twoXFollowThrough,{status:'watching',seen:0,windowPeakBps:'21500'});
  state=step(state,21450,'stall-1').state;
  assert.deepEqual(state.twoXFollowThrough,{status:'watching',seen:1,windowPeakBps:'21500'});
  state=step(state,21600,'recovery-high').state;
  assert.deepEqual(state.twoXFollowThrough,{status:'watching',seen:0,windowPeakBps:'21600'},'a new high clears prior weakness');
  result=step(state,21500,'clear-weakness');
  assert.equal(result.decision?.kind,'profit_protection');assert.equal(result.decision?.sellPercent,50);
  assert.equal(result.decision?.protectionFloorBps,'21600','a fresh high invalidates this action during quote revalidation');
  const pending=restoreNativeAdaptiveProtectionState(JSON.parse(JSON.stringify(result.state)));
  state=cancelNativeAdaptiveProtectionAction(pending,result.decision!.actionId);
  result=step(state,21300,'follow-retry');assert.equal(result.decision?.actionId,'native-adaptive-v1:1:core');
  state=confirmNativeAdaptiveProtectionAction(result.state,result.decision!.actionId);
  assert.equal(state.phase,'runner');assert.equal(state.twoXFollowThrough,undefined);assert.equal(state.runnerSafetyFloorBps,'15120');

  let strong=step(createNativeAdaptiveProtectionState(),20000,'strong-cross').state;
  result=step(strong,22000,'strong-follow');strong=result.state;
  assert.equal(result.decision,undefined);assert.deepEqual(strong.twoXFollowThrough,{status:'strong'});
  assert.throws(()=>restoreNativeAdaptiveProtectionState({...strong,peakValueBps:'21999'}),/STATE_INVALID/);
});

test('sub-one-point stalls require two distinct observations before the follow-through reduction',()=>{
  let state=step(createNativeAdaptiveProtectionState(),20000,'cross').state;
  state=step(state,21000,'new-high').state;
  state=step(state,20950,'stall-1').state;
  assert.deepEqual(state.twoXFollowThrough,{status:'watching',seen:1,windowPeakBps:'21000'});
  state=step(state,20950,'stall-1').state;
  assert.equal(state.pendingAction,undefined,'a duplicate observation cannot confirm the stall');
  const result=step(state,20960,'stall-2');
  assert.equal(result.decision?.sellPercent,50);assert.equal(result.decision?.protectionFloorBps,'21000');
});

test('core floor still overrides the 2x window, and an unrearmed runner safety floor trims to a true tail',()=>{
  let state=step(createNativeAdaptiveProtectionState(),20000,'cross').state;
  let result=step(state,15000,'fast-drop');
  assert.equal(result.decision?.kind,'profit_protection');assert.equal(result.decision?.sellPercent,50);
  assert.equal(result.decision?.protectionFloorBps,'16000','the core floor, not the momentum ceiling, proves the fast-drop action');

  state=step(createNativeAdaptiveProtectionState(),20000,'cross-again').state;
  state=step(state,21000,'higher-1').state;state=step(state,21500,'higher-2').state;
  result=step(state,21400,'clear-weakness');
  state=confirmNativeAdaptiveProtectionAction(result.state,result.decision!.actionId);
  assert.equal(state.phase,'runner');assert.equal(state.runnerArmed,false);assert.equal(state.runnerSafetyFloorBps,'15050');
  result=positionStep(state,14550,'runner-safety-deep','5000');
  assert.equal(result.decision?.phase,'runner');assert.equal(result.decision?.sellPercent,70);
  assert.equal(result.decision?.protectionFloorBps,'15050');
  state=confirmNativeAdaptiveProtectionAction(result.state,result.decision!.actionId);
  assert.equal(state.phase,'tail');assert.equal(state.tailExitFloorBps,'12900','true tail uses a wider floor than runner safety');
});

test('core partial starts an unarmed runner; a fresh five-percent ATH rearms protection and reduces to a 15% original tail',()=>{
  let state=step(createNativeAdaptiveProtectionState(),30000,'peak').state;
  state=step(state,23900,'core-breach-1').state;let result=step(state,23800,'core-breach-2');
  const action=result.decision!;assert.equal(action.sellPercent,33);
  state=confirmNativeAdaptiveProtectionAction(result.state,action.actionId);
  assert.equal(state.phase,'runner');assert.equal(state.cycle,2);assert.equal(state.runnerRearmValueBps,'31500');assert.equal(state.runnerArmed,false);
  assert.equal(state.runnerSafetyFloorBps,'21000');assert.equal(state.tailExitFloorBps,undefined);

  state=positionStep(state,22000,'runner-hold','6700').state;
  assert.equal(state.pendingAction,undefined,'an unrearmed runner holds above its wider safety floor');
  state=positionStep(state,31400,'runner-near','6700').state;assert.equal(state.runnerArmed,false);
  state=positionStep(state,31500,'runner-rearm','6700').state;assert.equal(state.runnerArmed,true);assert.equal(state.protectionFloorBps,'25200');
  state=positionStep(state,25100,'runner-breach-1','6700').state;
  result=positionStep(state,25000,'runner-breach-2','6700');
  assert.equal(result.decision?.phase,'runner');assert.equal(result.decision?.sellPercent,78,'6700 atoms reduce to about 1500 original atoms');
  const restored=restoreNativeAdaptiveProtectionState(JSON.parse(JSON.stringify(result.state)));
  assert.equal(restored.pendingAction?.sellPercent,78);
  assert.throws(()=>restoreNativeAdaptiveProtectionState({...restored,pendingAction:{...restored.pendingAction!,sellPercent:0}}),/STATE_INVALID/);
  assert.throws(()=>restoreNativeAdaptiveProtectionState({...restored,pendingAction:{...restored.pendingAction!,sellPercent:101}}),/STATE_INVALID/);
  state=confirmNativeAdaptiveProtectionAction(restored,result.decision!.actionId);
  assert.equal(state.phase,'tail');assert.equal(state.cycle,3);assert.equal(state.tailExitFloorBps,'18900');

  state=step(state,40000,'tail-new-high').state;
  assert.equal(state.protectionFloorBps,'32000');assert.equal(state.tailExitFloorBps,'24000');
  state=step(state,23900,'tail-breach-1').state;result=step(state,23800,'tail-breach-2');
  assert.equal(result.decision?.sellPercent,100);assert.equal(result.decision?.phase,'tail');
  state=confirmNativeAdaptiveProtectionAction(result.state,result.decision!.actionId);assert.equal(state.phase,'exited');
});

test('a quote five return-points through either relevant floor acts immediately',()=>{
  let state=step(createNativeAdaptiveProtectionState(),18000,'core-peak').state;
  let result=step(state,13000,'core-deep');assert.equal(result.decision?.sellPercent,20);
  state=confirmNativeAdaptiveProtectionAction(result.state,result.decision!.actionId);
  assert.equal(state.phase,'runner');assert.equal(state.runnerRearmValueBps,'20000');
  state=positionStep(state,12000,'unrearmed-deep','8000').state;assert.equal(state.pendingAction,undefined);
  assert.equal(positionStep(state,4000,'unrearmed-emergency','8000').decision?.sellPercent,100);
  state=positionStep(state,20000,'runner-rearm','8000').state;assert.equal(state.runnerArmed,true);
  result=positionStep(state,15500,'runner-deep','8000');assert.equal(result.decision?.sellPercent,81);
  state=confirmNativeAdaptiveProtectionAction(result.state,result.decision!.actionId);assert.equal(state.tailExitFloorBps,'12000');
  result=step(state,11500,'tail-deep');assert.equal(result.decision?.sellPercent,100);
});

test('-60% emergency stop needs one quote and exits the entire remaining position',()=>{
  const result=step(createNativeAdaptiveProtectionState(),4000,'crash');
  assert.equal(result.decision?.kind,'emergency_stop');assert.equal(result.decision?.sellPercent,100);
  assert.equal(result.decision?.dustExit,undefined);
  assert.equal(result.state.breachCount,0);
});

test('a partial that floors to zero atoms becomes a durable marked dust exit',()=>{
  const tiny=(quoteOutputLamports:string,observationId:string):NativeAdaptiveProtectionInput=>({
    costLamports:'10',boughtTokenAtoms:'10',currentTokenAtoms:'1',quoteOutputLamports,observationId,
  });
  let state=updateNativeAdaptiveProtection(createNativeAdaptiveProtectionState(),tiny('2','dust-peak')).state;
  const result=updateNativeAdaptiveProtection(state,tiny('1','dust-breach'));
  assert.equal(result.decision?.kind,'profit_protection');assert.equal(result.decision?.sellPercent,100);assert.equal(result.decision?.dustExit,true);
  state=restoreNativeAdaptiveProtectionState(JSON.parse(JSON.stringify(result.state)));
  assert.throws(()=>restoreNativeAdaptiveProtectionState({...state,pendingAction:{...state.pendingAction!,dustExit:undefined}}),/STATE_INVALID/);
  assert.throws(()=>restoreNativeAdaptiveProtectionState({...state,pendingAction:{...state.pendingAction!,sellPercent:50}}),/STATE_INVALID/);
  state=confirmNativeAdaptiveProtectionAction(state,result.decision!.actionId);assert.equal(state.phase,'exited');
});

test('state and pending action are restart-safe, idempotent and explicitly cancellable',()=>{
  let state=step(createNativeAdaptiveProtectionState(),18000,'peak').state;
  state=step(state,13400,'breach-1').state;
  state=restoreNativeAdaptiveProtectionState(JSON.parse(JSON.stringify(state)));
  let result=step(state,13300,'breach-2');const pending=result.decision!;
  const restarted=restoreNativeAdaptiveProtectionState(JSON.parse(JSON.stringify(result.state)));
  result=step(restarted,19000,'later');assert.deepEqual(result.decision,pending,'a pending financial decision is stable after restart');
  state=cancelNativeAdaptiveProtectionAction(result.state,pending.actionId);assert.equal(state.pendingAction,undefined);assert.equal(state.protectionFloorBps,'13500');
  assert.throws(()=>restoreNativeAdaptiveProtectionState({...state,runnerRearmValueBps:'20000',runnerArmed:false}),/STATE_INVALID/);
});
