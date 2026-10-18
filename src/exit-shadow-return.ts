import {adaptiveExitPolicy,type AdaptiveExitState} from './adaptive-exit.js';

interface ExitEvent {
  at:string;kind:string;observationOnly:true;sellPct?:number;priceUsd?:number;remainingPct?:number;
}
export interface ShadowReturnExit {
  at:string;kind:'partial_exit'|'full_exit';priceUsd:number;sellPctRemaining:number;
  soldPctOfInitial:number;remainingPctOfInitial:number;gainPct:number;contributionGainPct:number;
}
export interface ShadowReturn {
  mode:'shadow';execution:'observation_only';basis:'initial_principal_pct';costsIncluded:false;
  status:'open'|'closed'|'unavailable';valuationStatus:'fresh'|'stale'|'unavailable'|'closed';
  realizedGainPct?:number;unrealizedGainPct?:number;totalGainPct?:number;finalGainPct?:number;
  soldPctOfInitial?:number;remainingPctOfInitial?:number;closedAt?:string;valuationAt?:string;
  reason?:'RETURN_HISTORY_INCOMPLETE'|'RETURN_HISTORY_INVALID'|'RETURN_ARITHMETIC_INVALID'|'RETURN_QUOTE_UNAVAILABLE';
  exits:ShadowReturnExit[];
}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const positive=(value:unknown):value is number=>finite(value)&&value>0;
const time=(value:unknown)=>typeof value==='string'?Date.parse(value):NaN;
const close=(left:number,right:number)=>Math.abs(left-right)<=1e-8;

/** Initial-principal weighted paper returns. Observed trigger prices are never fills. */
export function shadowReturn(state:AdaptiveExitState,events:readonly ExitEvent[],quote:{priceUsd:number;at:string;health:'fresh'|'stale'|'unavailable'}):ShadowReturn {
  const base={mode:'shadow' as const,execution:'observation_only' as const,basis:'initial_principal_pct' as const,costsIncluded:false as const};
  const invalid=(reason:ShadowReturn['reason']):ShadowReturn=>({...base,status:'unavailable',valuationStatus:'unavailable',reason,exits:[]});
  const policy=adaptiveExitPolicy(state.policyVersion),baselineAt=time(state.baselineAt),lastAt=time(state.lastObservedAt);
  if(!policy||!positive(state.baselinePriceUsd)||!finite(baselineAt)||!finite(lastAt)||lastAt<baselineAt||
    !finite(state.remainingPctOfInitial)||state.remainingPctOfInitial<0||state.remainingPctOfInitial>100||
    typeof state.shadowClosed!=='boolean'||(state.remainingPctOfInitial===0)!==state.shadowClosed||
    !Array.isArray(state.suggestedStages)||new Set(state.suggestedStages).size!==state.suggestedStages.length||
    state.suggestedStages.some(gain=>!policy.partialExits.some(stage=>stage.gainPct===gain))||events.length>32)
    return invalid('RETURN_HISTORY_INVALID');
  // The state retains completed stages even after closure. This detects a lost
  // partial event before a full exit, whose recorded remaining percentage is 0.
  let expectedPartialRemaining=100;
  for(const stage of policy.partialExits)if(state.suggestedStages.includes(stage.gainPct))expectedPartialRemaining*=1-stage.sellPctRemaining/100;
  let remaining=100,realized=0,previousAt=baselineAt,fullExit:ShadowReturnExit|undefined;
  const exits:ShadowReturnExit[]=[],seen=new Map<string,string>();
  for(const event of events){
    if(!event||!['partial_exit','full_exit'].includes(event.kind)||event.observationOnly!==true||
      !finite(time(event.at))||time(event.at)<baselineAt||time(event.at)>lastAt||!positive(event.priceUsd)||
      !positive(event.sellPct)||event.sellPct>100||!finite(event.remainingPct)||event.remainingPct<0||event.remainingPct>100)
      return invalid('RETURN_HISTORY_INVALID');
    const key=`${event.at}/${event.kind}`,fingerprint=JSON.stringify([event.priceUsd,event.sellPct,event.remainingPct]);
    if(seen.has(key)){if(seen.get(key)!==fingerprint)return invalid('RETURN_HISTORY_INVALID');continue;}
    seen.set(key,fingerprint);
    if(fullExit||time(event.at)<previousAt)return invalid('RETURN_HISTORY_INVALID');
    if(event.kind==='full_exit'&&!close(remaining,expectedPartialRemaining))return invalid('RETURN_HISTORY_INCOMPLETE');
    const after=remaining*(1-event.sellPct/100);
    if(!close(after,event.remainingPct)||(event.kind==='full_exit')!==(event.sellPct===100))return invalid('RETURN_HISTORY_INCOMPLETE');
    const sold=remaining-after,gain=(event.priceUsd/state.baselinePriceUsd-1)*100,contribution=sold/100*gain;
    if(!finite(gain)||!finite(contribution)||!finite(realized+contribution))return invalid('RETURN_ARITHMETIC_INVALID');
    const exit:ShadowReturnExit={at:event.at,kind:event.kind as ShadowReturnExit['kind'],priceUsd:event.priceUsd,
      sellPctRemaining:event.sellPct,soldPctOfInitial:sold,remainingPctOfInitial:after,gainPct:gain,contributionGainPct:contribution};
    exits.push(exit);realized+=contribution;remaining=after;previousAt=time(event.at);
    if(event.kind==='full_exit')fullExit=exit;
  }
  if(!close(remaining,state.remainingPctOfInitial)||(!fullExit&&!close(remaining,expectedPartialRemaining))||
    !!fullExit!==state.shadowClosed||fullExit&&time(fullExit.at)!==lastAt)return invalid('RETURN_HISTORY_INCOMPLETE');
  if(fullExit&&fullExit.priceUsd!==state.lastPriceUsd)return invalid('RETURN_HISTORY_INVALID');
  const result:ShadowReturn={...base,status:fullExit?'closed':'open',valuationStatus:fullExit?'closed':quote.health,
    realizedGainPct:realized,soldPctOfInitial:100-remaining,remainingPctOfInitial:remaining,exits};
  if(fullExit)return {...result,closedAt:fullExit.at,valuationAt:fullExit.at,unrealizedGainPct:0,totalGainPct:realized,finalGainPct:realized};
  if(quote.health!=='fresh'||!positive(quote.priceUsd)||!finite(time(quote.at))||time(quote.at)!==lastAt||quote.priceUsd!==state.lastPriceUsd)
    return {...result,reason:'RETURN_QUOTE_UNAVAILABLE'};
  const unrealized=remaining*(quote.priceUsd/state.baselinePriceUsd-1),total=realized+unrealized;
  if(!finite(unrealized)||!finite(total))return invalid('RETURN_ARITHMETIC_INVALID');
  return {...result,valuationAt:quote.at,unrealizedGainPct:unrealized,totalGainPct:total};
}
