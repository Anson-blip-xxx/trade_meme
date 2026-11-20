/**
 * Price-only, executable-quote protection for a native SOL position.
 *
 * Every persisted number is a decimal string so the state survives JSON and
 * never passes a token or lamport amount through a JavaScript number.
 */
export const NATIVE_ADAPTIVE_PROTECTION_POLICY={
  version:'native-adaptive-v1',
  emergencyStopValueBps:'4000',
  activationValueBps:'13000',
  /** Once protection activates, retain at least 10% of the observed gain. */
  minimumProfitLockBps:'1000',
  trail:[
    {belowPeakValueBps:'20000',drawdownBps:'2500'},
    {belowPeakValueBps:'50000',drawdownBps:'2000'},
    {belowPeakValueBps:null,drawdownBps:'1500'},
  ],
  twoXFollowThroughEntryBps:'20000',
  twoXFollowThroughStrongBps:'22000',
  twoXFollowThroughObservations:2,
  /** One full return-point below the local window peak is weakness, not a stall. */
  twoXFollowThroughImmediateWeaknessBps:'100',
  /** Runner gets 10% more peak drawdown than core; true tail gets 20% more. */
  runnerSafetyAdditionalDrawdownBps:'1000',
  tailAdditionalDrawdownBps:'2000',
  /** Five return-points through a floor is actionable without a second quote. */
  immediateBreachDepthBps:'500',
  coreExit:{belowTwoXPercent:20,twoToTwoPointTwoXPercent:50,minimumPercent:20,maximumPercent:50},
  runnerRearmRiseBps:'500',
  runnerMinimumPeakValueBps:'20000',
  runnerTailTargetOriginalBps:'1500',
  ordinaryBreachConfirmations:2,
} as const;

export type NativeAdaptiveProtectionPhase='core'|'runner'|'tail'|'exited';
export type NativeAdaptiveProtectionDecisionKind='emergency_stop'|'profit_protection';
export type NativeTwoXFollowThrough=
  | {status:'watching';seen:0|1|2;windowPeakBps:string}
  | {status:'strong'};

export interface NativeAdaptiveProtectionInput {
  /** Original swap input, excluding fees and tips. */
  costLamports:string;
  /** Token atoms received by the original buy. */
  boughtTokenAtoms:string;
  /** Current aggregate token atoms covered by this exact sell quote. */
  currentTokenAtoms:string;
  /** Expected output of an executable exact-input quote for currentTokenAtoms. */
  quoteOutputLamports:string;
  /** Stable identity of this quote/observation; duplicates never add a confirmation. */
  observationId:string;
}

export interface NativeAdaptiveProtectionDecision {
  actionId:string;
  kind:NativeAdaptiveProtectionDecisionKind;
  cycle:number;
  phase:Exclude<NativeAdaptiveProtectionPhase,'exited'>;
  sellPercent:number;
  valueBps:string;
  peakValueBps:string;
  protectionFloorBps?:string;
  /** A partial intent rounded to zero token atoms, so only a full dust close is executable. */
  dustExit?:true;
}

export interface NativeAdaptiveProtectionState {
  version:typeof NATIVE_ADAPTIVE_PROTECTION_POLICY.version;
  phase:NativeAdaptiveProtectionPhase;
  cycle:number;
  peakValueBps:string;
  protectionFloorBps?:string;
  twoXFollowThrough?:NativeTwoXFollowThrough;
  runnerRearmValueBps?:string;
  runnerArmed?:boolean;
  runnerSafetyFloorBps?:string;
  /** Deeper monotonic floor used after the first partial exit. */
  tailExitFloorBps?:string;
  breachCount:0|1;
  lastObservationId?:string;
  pendingAction?:NativeAdaptiveProtectionDecision;
}

export interface NativeAdaptiveProtectionUpdate {
  state:NativeAdaptiveProtectionState;
  valueBps:string;
  decision?:NativeAdaptiveProtectionDecision;
}

const BPS=10000n,UINT256_MAX=(1n<<256n)-1n;
const atomic=(value:unknown,positive=false):value is string=>{
  if(typeof value!=='string'||!/^(0|[1-9]\d*)$/.test(value)||value.length>78)return false;
  const parsed=BigInt(value);return parsed<=UINT256_MAX&&(!positive||parsed>0n);
};
const observation=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200;
const bps=(value:unknown):value is string=>atomic(value);
const followThrough=(value:unknown):value is NativeTwoXFollowThrough=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const row=value as Record<string,unknown>,keys=Object.keys(row).sort();
  if(row.status==='strong')return keys.length===1&&keys[0]==='status';
  return row.status==='watching'&&keys.join(',')==='seen,status,windowPeakBps'&&
    (row.seen===0||row.seen===1||row.seen===2)&&bps(row.windowPeakBps)&&
    BigInt(row.windowPeakBps)>=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.twoXFollowThroughEntryBps)&&
    BigInt(row.windowPeakBps)<BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.twoXFollowThroughStrongBps);
};

export function createNativeAdaptiveProtectionState():NativeAdaptiveProtectionState {
  return {version:NATIVE_ADAPTIVE_PROTECTION_POLICY.version,phase:'core',cycle:1,peakValueBps:'0',breachCount:0};
}

/** Exact current liquidation value divided by pro-rata original cost, in basis points. */
export function nativeExecutableValueBps(input:NativeAdaptiveProtectionInput):string {
  if(!atomic(input.costLamports,true)||!atomic(input.boughtTokenAtoms,true)||
    !atomic(input.currentTokenAtoms,true)||!atomic(input.quoteOutputLamports)||!observation(input.observationId))
    throw Error('NATIVE_ADAPTIVE_PROTECTION_INPUT_INVALID');
  const value=BigInt(input.quoteOutputLamports)*BigInt(input.boughtTokenAtoms)*BPS/
    (BigInt(input.costLamports)*BigInt(input.currentTokenAtoms));
  if(value>UINT256_MAX)throw Error('NATIVE_ADAPTIVE_PROTECTION_INPUT_INVALID');
  return value.toString();
}

function drawdownBps(peak:bigint):bigint {
  for(const tier of NATIVE_ADAPTIVE_PROTECTION_POLICY.trail)
    if(tier.belowPeakValueBps===null||peak<BigInt(tier.belowPeakValueBps))return BigInt(tier.drawdownBps);
  throw Error('NATIVE_ADAPTIVE_PROTECTION_POLICY_INVALID');
}

function floorForPeak(peak:bigint):bigint {
  const trailing=peak*(BPS-drawdownBps(peak))/BPS;
  const locked=BPS+(peak-BPS)*BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.minimumProfitLockBps)/BPS;
  return trailing>locked?trailing:locked;
}

function tailFloorForPeak(peak:bigint):bigint {
  const drawdown=drawdownBps(peak)+BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.tailAdditionalDrawdownBps);
  const trailing=peak*(BPS-drawdown)/BPS;
  return trailing>BPS?trailing:BPS;
}

function runnerSafetyFloorForPeak(peak:bigint):bigint {
  const drawdown=drawdownBps(peak)+BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.runnerSafetyAdditionalDrawdownBps);
  const trailing=peak*(BPS-drawdown)/BPS;
  return trailing>BPS?trailing:BPS;
}

function runnerRearmValueForPeak(peak:bigint):bigint {
  const rise=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.runnerRearmRiseBps);
  const threshold=(peak*(BPS+rise)+BPS-1n)/BPS;
  const minimum=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.runnerMinimumPeakValueBps);
  return threshold>minimum?threshold:minimum;
}

/** Migrate a legacy position that already sold its old fixed 2x take-profit. */
export function createNativeAdaptiveProtectionStateAfterLegacyTakeProfit():NativeAdaptiveProtectionState {
  const peak=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.twoXFollowThroughEntryBps);
  return {
    version:NATIVE_ADAPTIVE_PROTECTION_POLICY.version,phase:'runner',cycle:2,
    peakValueBps:peak.toString(),protectionFloorBps:floorForPeak(peak).toString(),
    runnerRearmValueBps:runnerRearmValueForPeak(peak).toString(),runnerArmed:false,
    runnerSafetyFloorBps:runnerSafetyFloorForPeak(peak).toString(),breachCount:0,
  };
}

function coreSellPercent(peak:bigint):number {
  const policy=NATIVE_ADAPTIVE_PROTECTION_POLICY.coreExit;
  if(peak<20000n)return policy.belowTwoXPercent;
  if(peak<=22000n)return policy.twoToTwoPointTwoXPercent;
  const rounded=Number((1000000n+peak/2n)/peak);
  return Math.max(policy.minimumPercent,Math.min(policy.maximumPercent,rounded));
}

function runnerSellPercent(input:NativeAdaptiveProtectionInput):number {
  const current=BigInt(input.currentTokenAtoms),bought=BigInt(input.boughtTokenAtoms);
  const target=(bought*BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.runnerTailTargetOriginalBps)+BPS-1n)/BPS;
  let best=1,bestDistance:bigint|undefined;
  for(let percent=1;percent<100;percent++){
    const remaining=current-current*BigInt(percent)/100n;
    const distance=remaining>=target?remaining-target:target-remaining;
    if(bestDistance===undefined||distance<bestDistance){best=percent;bestDistance=distance;}
  }
  return best;
}

function relevantFloor(state:NativeAdaptiveProtectionState):string|undefined {
  if(state.phase==='tail')return state.tailExitFloorBps;
  if(state.phase==='runner'&&!state.runnerArmed)return state.runnerSafetyFloorBps;
  return state.protectionFloorBps;
}

function decision(
  state:NativeAdaptiveProtectionState,kind:NativeAdaptiveProtectionDecisionKind,value:bigint,input:NativeAdaptiveProtectionInput,
):NativeAdaptiveProtectionDecision {
  if(state.phase==='exited')throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  const followReduction=kind==='profit_protection'&&state.phase==='core'&&
    state.twoXFollowThrough?.status==='watching'&&state.twoXFollowThrough.seen===2;
  const floor=followReduction&&state.twoXFollowThrough?.status==='watching'?
    state.twoXFollowThrough.windowPeakBps:relevantFloor(state);
  const sellPercent=kind==='emergency_stop'||state.phase==='tail'?100:followReduction?50:
    state.phase==='runner'?runnerSellPercent(input):coreSellPercent(BigInt(state.peakValueBps));
  return {
    actionId:`${state.version}:${state.cycle}:${state.phase}`,
    kind,cycle:state.cycle,phase:state.phase,
    sellPercent,
    valueBps:value.toString(),peakValueBps:state.peakValueBps,
    ...(floor?{protectionFloorBps:floor}:{}),
  };
}

function emitDecision(
  state:NativeAdaptiveProtectionState,kind:NativeAdaptiveProtectionDecisionKind,value:bigint,input:NativeAdaptiveProtectionInput,
):NativeAdaptiveProtectionUpdate {
  const action=decision(state,kind,value,input);
  if(action.sellPercent<100&&BigInt(input.currentTokenAtoms)*BigInt(action.sellPercent)/100n===0n){
    action.sellPercent=100;action.dustExit=true;
  }
  state.pendingAction=action;state.breachCount=0;
  return {state,valueBps:value.toString(),decision:structuredClone(action)};
}

/**
 * Apply one executable quote. The returned state is a new JSON-safe value.
 * A pending decision is idempotently returned until the caller confirms or cancels it.
 */
export function updateNativeAdaptiveProtection(
  current:NativeAdaptiveProtectionState,input:NativeAdaptiveProtectionInput,
):NativeAdaptiveProtectionUpdate {
  const state=restoreNativeAdaptiveProtectionState(current),value=BigInt(nativeExecutableValueBps(input));
  if(state.pendingAction)return {state,valueBps:value.toString(),decision:structuredClone(state.pendingAction)};
  if(state.phase==='exited'||state.lastObservationId===input.observationId)return {state,valueBps:value.toString()};
  state.lastObservationId=input.observationId;

  const previousPeak=BigInt(state.peakValueBps);
  if(value>previousPeak)state.peakValueBps=value.toString();
  const peak=BigInt(state.peakValueBps),activation=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.activationValueBps);
  if(peak>=activation){
    const candidate=floorForPeak(peak),previous=BigInt(state.protectionFloorBps??'0');
    if(candidate>previous)state.protectionFloorBps=candidate.toString();
    if(state.phase==='runner'){
      const safetyCandidate=runnerSafetyFloorForPeak(peak),safetyPrevious=BigInt(state.runnerSafetyFloorBps??'0');
      if(safetyCandidate>safetyPrevious)state.runnerSafetyFloorBps=safetyCandidate.toString();
    }
    if(state.phase==='tail'){
      const tailCandidate=tailFloorForPeak(peak),tailPrevious=BigInt(state.tailExitFloorBps??'0');
      if(tailCandidate>tailPrevious)state.tailExitFloorBps=tailCandidate.toString();
    }
  }

  if(value<=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.emergencyStopValueBps)){
    return emitDecision(state,'emergency_stop',value,input);
  }

  if(state.phase==='core'){
    const entry=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.twoXFollowThroughEntryBps);
    const strong=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.twoXFollowThroughStrongBps);
    const follow=state.twoXFollowThrough;
    if(follow?.status==='watching'){
      const coreFloor=BigInt(state.protectionFloorBps??'0');
      if(coreFloor>0n&&value<=coreFloor){
        const deep=coreFloor-value>=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.immediateBreachDepthBps);
        if(!deep&&state.breachCount===0){state.breachCount=1;return {state,valueBps:value.toString()};}
        if(follow.seen===2)follow.seen=1;
        return emitDecision(state,'profit_protection',value,input);
      }
      state.breachCount=0;
      if(value>=strong){state.twoXFollowThrough={status:'strong'};state.breachCount=0;return {state,valueBps:value.toString()};}
      if(value>BigInt(follow.windowPeakBps)){
        follow.windowPeakBps=value.toString();follow.seen=0;return {state,valueBps:value.toString()};
      }
      if(BigInt(follow.windowPeakBps)-value>=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.twoXFollowThroughImmediateWeaknessBps)){
        follow.seen=2;return emitDecision(state,'profit_protection',value,input);
      }
      if(follow.seen<NATIVE_ADAPTIVE_PROTECTION_POLICY.twoXFollowThroughObservations)follow.seen=(follow.seen+1) as 1|2;
      if(follow.seen<NATIVE_ADAPTIVE_PROTECTION_POLICY.twoXFollowThroughObservations)return {state,valueBps:value.toString()};
      return emitDecision(state,'profit_protection',value,input);
    }
    if(!follow&&previousPeak<entry&&value>=entry){
      state.twoXFollowThrough=value>=strong?{status:'strong'}:{status:'watching',seen:0,windowPeakBps:value.toString()};
      state.breachCount=0;return {state,valueBps:value.toString()};
    }
    // Forward migration for a core state persisted before follow-through existed.
    const coreFloor=BigInt(state.protectionFloorBps??'0');
    if(!follow&&previousPeak>=entry&&(coreFloor===0n||value>coreFloor)){
      if(previousPeak>=strong||value>=strong)state.twoXFollowThrough={status:'strong'};
      else if(value>previousPeak)state.twoXFollowThrough={status:'watching',seen:0,windowPeakBps:value.toString()};
      else state.twoXFollowThrough={status:'watching',seen:1,windowPeakBps:previousPeak.toString()};
      state.breachCount=0;return {state,valueBps:value.toString()};
    }
  }

  if(state.phase==='runner'&&!state.runnerArmed&&value>previousPeak&&value>=BigInt(state.runnerRearmValueBps!)){
    state.runnerArmed=true;
  }

  const floorValue=relevantFloor(state),floor=floorValue===undefined?undefined:BigInt(floorValue);
  if(floor===undefined||value>floor){state.breachCount=0;return {state,valueBps:value.toString()};}

  const deep=floor-value>=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.immediateBreachDepthBps);
  if(!deep&&state.breachCount===0){state.breachCount=1;return {state,valueBps:value.toString()};}
  return emitDecision(state,'profit_protection',value,input);
}

/** Advance to the retained-tail cycle, or close after a full exit. */
export function confirmNativeAdaptiveProtectionAction(current:NativeAdaptiveProtectionState,actionId:string):NativeAdaptiveProtectionState {
  const state=restoreNativeAdaptiveProtectionState(current),action=state.pendingAction;
  if(!action||action.actionId!==actionId)throw Error('NATIVE_ADAPTIVE_PROTECTION_ACTION_MISMATCH');
  delete state.pendingAction;state.breachCount=0;
  if(action.sellPercent===100){
    state.phase='exited';delete state.twoXFollowThrough;delete state.runnerRearmValueBps;delete state.runnerArmed;delete state.runnerSafetyFloorBps;
    return state;
  }
  if(state.phase==='core'){
    const peak=BigInt(action.peakValueBps);
    state.phase='runner';state.cycle++;
    state.runnerRearmValueBps=runnerRearmValueForPeak(peak).toString();
    state.runnerArmed=false;
    state.runnerSafetyFloorBps=runnerSafetyFloorForPeak(peak).toString();delete state.twoXFollowThrough;
  }else if(state.phase==='runner'){
    state.phase='tail';state.cycle++;delete state.runnerRearmValueBps;delete state.runnerArmed;delete state.runnerSafetyFloorBps;
    const candidate=tailFloorForPeak(BigInt(state.peakValueBps)),previous=BigInt(state.tailExitFloorBps??'0');
    state.tailExitFloorBps=(candidate>previous?candidate:previous).toString();
  }else throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  delete state.lastObservationId;return state;
}

/** Release a failed/non-submitted intent without weakening the established floor. */
export function cancelNativeAdaptiveProtectionAction(current:NativeAdaptiveProtectionState,actionId:string):NativeAdaptiveProtectionState {
  const state=restoreNativeAdaptiveProtectionState(current),action=state.pendingAction;
  if(!action||action.actionId!==actionId)throw Error('NATIVE_ADAPTIVE_PROTECTION_ACTION_MISMATCH');
  delete state.pendingAction;state.breachCount=0;return state;
}

/** Validate untrusted JSON loaded after restart and return an independent copy. */
export function restoreNativeAdaptiveProtectionState(value:unknown):NativeAdaptiveProtectionState {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  const candidate=value as Partial<NativeAdaptiveProtectionState>;
  if(candidate.version!==NATIVE_ADAPTIVE_PROTECTION_POLICY.version||
    !['core','runner','tail','exited'].includes(String(candidate.phase))||
    !Number.isSafeInteger(candidate.cycle)||Number(candidate.cycle)<1||
    !bps(candidate.peakValueBps)||
    candidate.protectionFloorBps!==undefined&&!bps(candidate.protectionFloorBps)||
    candidate.twoXFollowThrough!==undefined&&!followThrough(candidate.twoXFollowThrough)||
    candidate.runnerRearmValueBps!==undefined&&!bps(candidate.runnerRearmValueBps)||
    candidate.runnerArmed!==undefined&&typeof candidate.runnerArmed!=='boolean'||
    candidate.runnerSafetyFloorBps!==undefined&&!bps(candidate.runnerSafetyFloorBps)||
    candidate.tailExitFloorBps!==undefined&&!bps(candidate.tailExitFloorBps)||
    candidate.breachCount!==0&&candidate.breachCount!==1||
    candidate.lastObservationId!==undefined&&!observation(candidate.lastObservationId))throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  const state=structuredClone(candidate) as NativeAdaptiveProtectionState;
  // Migrate an active runner persisted by the immediately preceding policy revision.
  if(state.phase==='runner'&&state.runnerSafetyFloorBps===undefined)
    state.runnerSafetyFloorBps=runnerSafetyFloorForPeak(BigInt(state.peakValueBps)).toString();
  if(state.phase==='core'&&(state.runnerRearmValueBps!==undefined||state.runnerArmed!==undefined||state.runnerSafetyFloorBps!==undefined||state.tailExitFloorBps!==undefined)||
    state.phase==='runner'&&(state.twoXFollowThrough!==undefined||!state.runnerRearmValueBps||typeof state.runnerArmed!=='boolean'||!state.runnerSafetyFloorBps||state.tailExitFloorBps!==undefined)||
    state.phase==='tail'&&(state.twoXFollowThrough!==undefined||state.runnerRearmValueBps!==undefined||state.runnerArmed!==undefined||state.runnerSafetyFloorBps!==undefined||state.tailExitFloorBps===undefined)||
    state.phase==='exited'&&(state.twoXFollowThrough!==undefined||state.pendingAction||state.runnerRearmValueBps!==undefined||state.runnerArmed!==undefined||state.runnerSafetyFloorBps!==undefined))
    throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  if(state.protectionFloorBps!==undefined&&BigInt(state.protectionFloorBps)>BigInt(state.peakValueBps))
    throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  if(state.tailExitFloorBps!==undefined&&
    (BigInt(state.tailExitFloorBps)>BigInt(state.peakValueBps)||
      state.protectionFloorBps!==undefined&&BigInt(state.tailExitFloorBps)>BigInt(state.protectionFloorBps)))
    throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  if(state.runnerSafetyFloorBps!==undefined&&
    (BigInt(state.runnerSafetyFloorBps)<BPS||BigInt(state.runnerSafetyFloorBps)>BigInt(state.peakValueBps)||
      state.protectionFloorBps!==undefined&&BigInt(state.runnerSafetyFloorBps)>BigInt(state.protectionFloorBps)))
    throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  if(state.phase==='core'&&state.twoXFollowThrough){
    const peak=BigInt(state.peakValueBps),strong=BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.twoXFollowThroughStrongBps);
    if(state.twoXFollowThrough.status==='strong'&&peak<strong||
      state.twoXFollowThrough.status==='watching'&&
        (peak>=strong||BigInt(state.twoXFollowThrough.windowPeakBps)!==peak))
      throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  }
  if(state.phase==='runner'){
    const threshold=BigInt(state.runnerRearmValueBps!),peak=BigInt(state.peakValueBps);
    if(threshold<BigInt(NATIVE_ADAPTIVE_PROTECTION_POLICY.runnerMinimumPeakValueBps)||
      state.runnerArmed&&peak<threshold||!state.runnerArmed&&peak>=threshold)
      throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  }
  if(state.pendingAction){
    const action=state.pendingAction;
    const followReduction=action.kind==='profit_protection'&&state.phase==='core'&&
      state.twoXFollowThrough?.status==='watching'&&state.twoXFollowThrough.seen===2;
    const expectedFloor=followReduction&&state.twoXFollowThrough?.status==='watching'?
      state.twoXFollowThrough.windowPeakBps:relevantFloor(state);
    const expectedPercent=action.kind==='emergency_stop'||state.phase==='tail'?100:followReduction?50:
      state.phase==='core'?coreSellPercent(BigInt(state.peakValueBps)):undefined;
    const dustOverride=action.dustExit===true&&action.kind==='profit_protection'&&
      (state.phase==='core'||state.phase==='runner')&&action.sellPercent===100;
    if(action.actionId!==`${state.version}:${state.cycle}:${state.phase}`||action.cycle!==state.cycle||action.phase!==state.phase||
      !['emergency_stop','profit_protection'].includes(action.kind)||!Number.isSafeInteger(action.sellPercent)||action.sellPercent<1||action.sellPercent>100||
      action.dustExit!==undefined&&action.dustExit!==true||
      !bps(action.valueBps)||!bps(action.peakValueBps)||action.peakValueBps!==state.peakValueBps||
      action.protectionFloorBps!==expectedFloor||
      expectedPercent!==undefined&&action.sellPercent!==expectedPercent&&!dustOverride||
      action.kind==='profit_protection'&&action.protectionFloorBps===undefined||
      state.phase==='runner'&&action.kind==='profit_protection'&&action.sellPercent===100&&!dustOverride||
      action.dustExit===true&&!dustOverride)
      throw Error('NATIVE_ADAPTIVE_PROTECTION_STATE_INVALID');
  }
  return state;
}
