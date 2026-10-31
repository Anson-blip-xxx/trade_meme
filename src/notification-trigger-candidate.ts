import {createHash} from 'node:crypto';
import type {NotificationHorizonOutcome,NotificationTriggerOutcome} from './notification-outcomes.js';
import type {Chain} from './types.js';

export type NotificationTriggerCandidateStatus='collecting'|'not_replicated'|'shadow_ready';
interface TriggerVariantMetric {
  covered:number;coveragePct:number;doubleBeforeStopRatePct:number|null;stopBeforeDoubleRatePct:number|null;
  medianMaxGainPct:number|null;medianEndGainPct:number|null;medianMinGainPct:number|null;denseRatePct:number|null;
}
interface TriggerComparison {
  total:number;current:TriggerVariantMetric;proposed:TriggerVariantMetric;
  deltas:{doubleBeforeStopRatePct:number|null;stopBeforeDoubleRatePct:number|null;medianMaxGainPct:number|null;
    medianEndGainPct:number|null;medianMinGainPct:number|null};
}
export interface NotificationTriggerCandidate {
  schemaVersion:1;generatorVersion:'notification-trigger-shadow-v1';id:string;candidatePolicyVersion:string;
  generatedAt:string;mode:'shadow';execution:'observation_only';livePolicyMutation:'forbidden';
  promotion:'manual_review_only_after_forward_shadow';
  scope:{source:NotificationTriggerOutcome['source'];chain:Chain;horizonSec:21600};
  change:{parameter:'signal.trigger_count';from:3;to:4};
  status:NotificationTriggerCandidateStatus;reasons:string[];
  requirements:{minimumMaturePairs:200;minimumCoveragePct:90;minimumValidationPairs:40;maximumTailRegressionPct:5};
  evidence:{maturePairs:number;splitAt?:string;purgedTraining:number;train:TriggerComparison;validation:TriggerComparison;
    limitations:string[]};
}

interface Pair {id:string;registeredAt:string;outcomeAt:string;current:NotificationHorizonOutcome;proposed:NotificationHorizonOutcome;}
const HORIZON=21600,MIN_MATURE=200,MIN_COVERAGE=90,MIN_VALIDATION=40,MAX_TAIL_REGRESSION=5;
const stamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const round=(value:number)=>Math.round(value*1e6)/1e6;
const diff=(a:number|null,b:number|null)=>a===null||b===null?null:round(a-b);
function median(values:number[]):number|null {
  if(!values.length)return null;const sorted=values.slice().sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return round(sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2);
}
function metric(rows:readonly Pair[],key:'current'|'proposed'):TriggerVariantMetric {
  const covered=rows.flatMap(row=>row[key].status==='covered'?[row[key]]:[]),count=covered.length;
  const doubles=covered.filter(row=>row.sampledBarrierOrder==='double_first').length;
  const stops=covered.filter(row=>row.sampledBarrierOrder==='stop_first').length;
  return {covered:count,coveragePct:rows.length?round(count/rows.length*100):0,
    doubleBeforeStopRatePct:count?round(doubles/count*100):null,stopBeforeDoubleRatePct:count?round(stops/count*100):null,
    medianMaxGainPct:median(covered.flatMap(row=>typeof row.maxGainPct==='number'&&Number.isFinite(row.maxGainPct)?[row.maxGainPct]:[])),
    medianEndGainPct:median(covered.flatMap(row=>typeof row.endGainPct==='number'&&Number.isFinite(row.endGainPct)?[row.endGainPct]:[])),
    medianMinGainPct:median(covered.flatMap(row=>typeof row.minGainPct==='number'&&Number.isFinite(row.minGainPct)?[row.minGainPct]:[])),
    denseRatePct:count?round(covered.filter(row=>row.coverage?.dense===true).length/count*100):null};
}
function comparison(rows:readonly Pair[]):TriggerComparison {
  const current=metric(rows,'current'),proposed=metric(rows,'proposed');
  return {total:rows.length,current,proposed,deltas:{doubleBeforeStopRatePct:diff(proposed.doubleBeforeStopRatePct,current.doubleBeforeStopRatePct),
    stopBeforeDoubleRatePct:diff(proposed.stopBeforeDoubleRatePct,current.stopBeforeDoubleRatePct),
    medianMaxGainPct:diff(proposed.medianMaxGainPct,current.medianMaxGainPct),medianEndGainPct:diff(proposed.medianEndGainPct,current.medianEndGainPct),
    medianMinGainPct:diff(proposed.medianMinGainPct,current.medianMinGainPct)}};
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function buildCandidate(input:{asOf:string;source:NotificationTriggerOutcome['source'];chain:Chain;pairs:Pair[]}):NotificationTriggerCandidate {
  const pairs=input.pairs.slice().sort((a,b)=>a.registeredAt.localeCompare(b.registeredAt)||a.id.localeCompare(b.id));
  let split=Math.floor(pairs.length*.8);while(split>0&&pairs[split]&&pairs[split-1].registeredAt===pairs[split].registeredAt)split--;
  const validation=pairs.slice(split),splitAt=validation[0]?.registeredAt,early=pairs.slice(0,split);
  const train=splitAt?early.filter(row=>row.outcomeAt<=splitAt):[],trainStats=comparison(train),validationStats=comparison(validation),reasons:string[]=[];
  if(pairs.length<MIN_MATURE)reasons.push('MINIMUM_MATURE_PAIRS_NOT_MET');
  if(trainStats.current.coveragePct<MIN_COVERAGE||trainStats.proposed.coveragePct<MIN_COVERAGE||
    validationStats.current.coveragePct<MIN_COVERAGE||validationStats.proposed.coveragePct<MIN_COVERAGE)reasons.push('MINIMUM_COVERAGE_NOT_MET');
  if(validation.length<MIN_VALIDATION)reasons.push('MINIMUM_VALIDATION_PAIRS_NOT_MET');
  let status:NotificationTriggerCandidateStatus='collecting';
  if(!reasons.length){
    const improved=(row:TriggerComparison)=>(row.deltas.doubleBeforeStopRatePct??0)>0||(row.deltas.stopBeforeDoubleRatePct??0)<0||
      (row.deltas.medianEndGainPct??0)>0;
    const tailSafe=(validationStats.deltas.stopBeforeDoubleRatePct??Infinity)<=MAX_TAIL_REGRESSION&&
      (validationStats.deltas.medianMinGainPct??-Infinity)>=-MAX_TAIL_REGRESSION;
    status=improved(trainStats)&&improved(validationStats)&&tailSafe?'shadow_ready':'not_replicated';
    if(!improved(trainStats))reasons.push('TRAIN_IMPROVEMENT_NOT_OBSERVED');
    if(!improved(validationStats))reasons.push('VALIDATION_IMPROVEMENT_NOT_OBSERVED');
    if(!tailSafe)reasons.push('VALIDATION_TAIL_REGRESSION');
  }
  const scope={source:input.source,chain:input.chain,horizonSec:HORIZON as 21600},change={parameter:'signal.trigger_count' as const,from:3 as const,to:4 as const};
  const body={schemaVersion:1 as const,generatorVersion:'notification-trigger-shadow-v1' as const,
    candidatePolicyVersion:`shadow-trigger-${hash({generatorVersion:'notification-trigger-shadow-v1',scope,change}).slice(0,16)}`,
    generatedAt:input.asOf,mode:'shadow' as const,execution:'observation_only' as const,livePolicyMutation:'forbidden' as const,
    promotion:'manual_review_only_after_forward_shadow' as const,scope,change,status,reasons,
    requirements:{minimumMaturePairs:MIN_MATURE as 200,minimumCoveragePct:MIN_COVERAGE as 90,minimumValidationPairs:MIN_VALIDATION as 40,
      maximumTailRegressionPct:MAX_TAIL_REGRESSION as 5},evidence:{maturePairs:pairs.length,...(splitAt?{splitAt}:{}),purgedTraining:early.length-train.length,
      train:trainStats,validation:validationStats,
      limitations:['SAMPLED_BARRIER_ORDER_NOT_INTRABLOCK_ORDER','FORWARD_QUOTES_ARE_NOT_REALIZED_TRADES','SOURCE_AND_CHAIN_COHORTS_ARE_SEPARATE',
        'ONE_PARAMETER_PER_CANDIDATE','HARD_SAFETY_AND_POSITION_LIMITS_UNCHANGED','NO_AUTOMATIC_LIVE_POLICY_CHANGE']}};
  return {...body,id:hash(body)};
}

/** Compares the current third notification with a fourth-notification candidate, independently by source and chain. */
export function buildNotificationTriggerCandidates(input:{asOf:string;outcomes:readonly NotificationTriggerOutcome[]}):NotificationTriggerCandidate[] {
  if(!stamp(input.asOf)||!Array.isArray(input.outcomes)||input.outcomes.length>100000)throw new Error('NOTIFICATION_TRIGGER_CANDIDATE_INPUT_INVALID');
  const asOf=Date.parse(input.asOf),sessions=new Map<string,{three?:NotificationTriggerOutcome;four?:NotificationTriggerOutcome}>();
  for(const row of input.outcomes){
    if(!row||![3,4].includes(row.notificationNumber)||!['debot','gmgn','ave','wallet','manual'].includes(row.source)||
      !['bsc','solana','robinhood'].includes(row.chain)||!stamp(row.triggerAt)||
      !stamp(row.sessionFirstReceivedAt)||Date.parse(row.triggerAt)>asOf||!row.address||!Array.isArray(row.horizons))continue;
    const key=JSON.stringify([row.source,row.chain,row.address,row.sessionFirstReceivedAt]),entry=sessions.get(key)??{};
    if(row.notificationNumber===3){if(!entry.three||row.triggerAt<entry.three.triggerAt)entry.three=row;}
    else if(!entry.four||row.triggerAt<entry.four.triggerAt)entry.four=row;sessions.set(key,entry);
  }
  const groups=new Map<string,{source:NotificationTriggerOutcome['source'];chain:Chain;pairs:Pair[]}>();
  for(const [id,entry] of sessions){
    if(!entry.three||!entry.four)continue;const current=entry.three.horizons.find(row=>row.seconds===HORIZON),proposed=entry.four.horizons.find(row=>row.seconds===HORIZON);
    if(!current?.mature||!proposed?.mature||!stamp(current.endsAt)||!stamp(proposed.endsAt)||current.endsAt>input.asOf||proposed.endsAt>input.asOf)continue;
    const groupKey=JSON.stringify([entry.three.source,entry.three.chain]),group=groups.get(groupKey)??{source:entry.three.source,chain:entry.three.chain,pairs:[]};
    group.pairs.push({id,registeredAt:entry.four.triggerAt,outcomeAt:current.endsAt>proposed.endsAt?current.endsAt:proposed.endsAt,current,proposed});groups.set(groupKey,group);
  }
  return [...groups.values()].map(group=>buildCandidate({asOf:input.asOf,...group})).sort((a,b)=>String(a.scope.source).localeCompare(String(b.scope.source))||a.scope.chain.localeCompare(b.scope.chain));
}

export function validateNotificationTriggerCandidate(value:NotificationTriggerCandidate):boolean {
  if(!value||value.schemaVersion!==1||value.generatorVersion!=='notification-trigger-shadow-v1'||value.mode!=='shadow'||
    value.execution!=='observation_only'||value.livePolicyMutation!=='forbidden'||value.promotion!=='manual_review_only_after_forward_shadow'||
    value.change.parameter!=='signal.trigger_count'||value.change.from!==3||value.change.to!==4||value.scope.horizonSec!==21600||
    !['debot','gmgn','ave','wallet','manual'].includes(value.scope.source)||!['bsc','solana','robinhood'].includes(value.scope.chain)||!stamp(value.generatedAt)||
    !/^shadow-trigger-[a-f0-9]{16}$/.test(value.candidatePolicyVersion)||!['collecting','not_replicated','shadow_ready'].includes(value.status))return false;
  const semantic={generatorVersion:'notification-trigger-shadow-v1',scope:value.scope,change:value.change};
  const {id,...body}=value;return value.candidatePolicyVersion===`shadow-trigger-${hash(semantic).slice(0,16)}`&&/^[a-f0-9]{64}$/.test(id)&&hash(body)===id;
}
