import {createHash} from 'node:crypto';
import type {NotificationHorizonOutcome,NotificationTriggerOutcome} from './notification-outcomes.js';
import type {Chain} from './types.js';

export type NotificationTriggerCandidateStatus='collecting'|'not_replicated'|'shadow_ready';

interface TriggerVariantMetric {
  /** Sessions in which this policy would have entered. */
  entered:number;
  /** Sessions deliberately not entered because notification four never arrived. */
  skipped:number;
  /** Dense, paired outcomes used for the rate and distribution metrics below. */
  covered:number;
  /** Dense outcome coverage of this variant's entered sessions. */
  coveragePct:number;
  doubleBeforeStopRatePct:number|null;
  stopBeforeDoubleRatePct:number|null;
  medianMaxGainPct:number|null;
  medianEndGainPct:number|null;
  medianMinGainPct:number|null;
}

interface SkippedN3Metric {
  total:number;
  covered:number;
  coveragePct:number;
  doubleBeforeStop:number;
  stopBeforeDouble:number;
  neither:number;
  doubleBeforeStopRatePct:number|null;
  stopBeforeDoubleRatePct:number|null;
  medianMaxGainPct:number|null;
  medianEndGainPct:number|null;
  medianMinGainPct:number|null;
}

interface DecisionMetric {
  verifiable:number;
  favorable:number;
  adverse:number;
  neutral:number;
  favorableRatePct:number|null;
  adverseRatePct:number|null;
}

interface TriggerComparison {
  /** Every mature third-notification session in this chronological partition. */
  total:number;
  n4:{arrived:number;skipped:number;arrivalRatePct:number};
  /** Paired evidence: dense N3 and, when N4 arrived, dense N4. */
  verification:{covered:number;coveragePct:number};
  current:TriggerVariantMetric;
  proposed:TriggerVariantMetric;
  /** What the N3 path did in sessions the proposed N4 policy would skip. */
  skippedN3:SkippedN3Metric;
  decision:{current:DecisionMetric;proposed:DecisionMetric;deltas:{favorableRatePct:number|null;adverseRatePct:number|null}};
  deltas:{
    doubleBeforeStopRatePct:number|null;
    stopBeforeDoubleRatePct:number|null;
    medianMaxGainPct:number|null;
    medianEndGainPct:number|null;
    medianMinGainPct:number|null;
  };
}

export interface NotificationTriggerCandidate {
  schemaVersion:1;
  generatorVersion:'notification-trigger-shadow-v2';
  id:string;
  candidatePolicyVersion:string;
  generatedAt:string;
  mode:'shadow';
  execution:'observation_only';
  livePolicyMutation:'forbidden';
  promotion:'manual_review_only_after_forward_shadow';
  scope:{source:'debot'|'ave';chain:Chain;horizonSec:21600};
  change:{parameter:'signal.trigger_count';from:3;to:4};
  status:NotificationTriggerCandidateStatus;
  reasons:string[];
  requirements:{
    minimumMatureN3:200;
    minimumVerificationCoveragePct:90;
    minimumValidationN3:40;
    minimumTrainN4Arrivals:100;
    minimumValidationN4Arrivals:20;
    maximumTailRegressionPct:5;
  };
  evidence:{
    matureN3:number;
    splitAt?:string;
    purgedTraining:number;
    train:TriggerComparison;
    validation:TriggerComparison;
    limitations:string[];
  };
}

interface CohortRow {
  id:string;
  registeredAt:string;
  outcomeAt:string;
  current:NotificationHorizonOutcome;
  n4Arrived:boolean;
  proposed?:NotificationHorizonOutcome;
}

const HORIZON=21600,MIN_MATURE=200,MIN_COVERAGE=90,MIN_VALIDATION=40,MIN_TRAIN_N4=100,MIN_VALIDATION_N4=20,
  MAX_TAIL_REGRESSION=5;
const stamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const round=(value:number)=>Math.round(value*1e6)/1e6;
const diff=(a:number|null,b:number|null)=>a===null||b===null?null:round(a-b);
const percent=(part:number,total:number)=>total?round(part/total*100):0;
const dense=(value:NotificationHorizonOutcome|undefined):boolean=>
  value?.mature===true&&value.status==='covered'&&value.coverage?.dense===true&&
  typeof value.coverage.baselineDelaySec==='number'&&Number.isFinite(value.coverage.baselineDelaySec)&&
  value.coverage.baselineDelaySec>=0&&value.coverage.baselineDelaySec<=60;

function median(values:number[]):number|null {
  if(!values.length)return null;
  const sorted=values.slice().sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return round(sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2);
}

function numeric(values:readonly NotificationHorizonOutcome[],key:'maxGainPct'|'endGainPct'|'minGainPct'):number[] {
  return values.flatMap(value=>typeof value[key]==='number'&&Number.isFinite(value[key])?[value[key]]:[]);
}

function isVerifiable(row:CohortRow):boolean {
  return dense(row.current)&&(!row.n4Arrived||dense(row.proposed));
}

function variantMetric(rows:readonly CohortRow[],key:'current'|'proposed'):TriggerVariantMetric {
  const entered=key==='current'?rows.length:rows.filter(row=>row.n4Arrived).length;
  const skipped=key==='current'?0:rows.length-entered;
  const outcomes=rows.flatMap(row=>{
    if(!isVerifiable(row))return [];
    if(key==='current')return [row.current];
    return row.n4Arrived&&row.proposed?[row.proposed]:[];
  });
  const doubles=outcomes.filter(value=>value.sampledBarrierOrder==='double_first').length;
  const stops=outcomes.filter(value=>value.sampledBarrierOrder==='stop_first').length;
  return {entered,skipped,covered:outcomes.length,coveragePct:percent(outcomes.length,entered),
    doubleBeforeStopRatePct:outcomes.length?percent(doubles,outcomes.length):null,
    stopBeforeDoubleRatePct:outcomes.length?percent(stops,outcomes.length):null,
    medianMaxGainPct:median(numeric(outcomes,'maxGainPct')),medianEndGainPct:median(numeric(outcomes,'endGainPct')),
    medianMinGainPct:median(numeric(outcomes,'minGainPct'))};
}

function skippedMetric(rows:readonly CohortRow[]):SkippedN3Metric {
  const skipped=rows.filter(row=>!row.n4Arrived),outcomes=skipped.filter(row=>dense(row.current)).map(row=>row.current);
  const doubles=outcomes.filter(value=>value.sampledBarrierOrder==='double_first').length;
  const stops=outcomes.filter(value=>value.sampledBarrierOrder==='stop_first').length;
  const neither=outcomes.filter(value=>value.sampledBarrierOrder==='neither').length;
  return {total:skipped.length,covered:outcomes.length,coveragePct:percent(outcomes.length,skipped.length),
    doubleBeforeStop:doubles,stopBeforeDouble:stops,neither,
    doubleBeforeStopRatePct:outcomes.length?percent(doubles,outcomes.length):null,
    stopBeforeDoubleRatePct:outcomes.length?percent(stops,outcomes.length):null,
    medianMaxGainPct:median(numeric(outcomes,'maxGainPct')),medianEndGainPct:median(numeric(outcomes,'endGainPct')),
    medianMinGainPct:median(numeric(outcomes,'minGainPct'))};
}

function decisions(rows:readonly CohortRow[]):{current:DecisionMetric;proposed:DecisionMetric} {
  const verified=rows.filter(isVerifiable);
  let currentFavorable=0,currentAdverse=0,proposedFavorable=0,proposedAdverse=0;
  for(const row of verified) {
    if(row.current.sampledBarrierOrder==='double_first')currentFavorable++;
    else if(row.current.sampledBarrierOrder==='stop_first')currentAdverse++;
    if(row.n4Arrived) {
      if(row.proposed?.sampledBarrierOrder==='double_first')proposedFavorable++;
      else if(row.proposed?.sampledBarrierOrder==='stop_first')proposedAdverse++;
    } else {
      // Skipping an N3 path which later stops is favorable; skipping one which
      // doubles first is the opportunity cost of requiring notification four.
      if(row.current.sampledBarrierOrder==='stop_first')proposedFavorable++;
      else if(row.current.sampledBarrierOrder==='double_first')proposedAdverse++;
    }
  }
  const result=(favorable:number,adverse:number):DecisionMetric=>({verifiable:verified.length,favorable,adverse,
    neutral:verified.length-favorable-adverse,favorableRatePct:verified.length?percent(favorable,verified.length):null,
    adverseRatePct:verified.length?percent(adverse,verified.length):null});
  return {current:result(currentFavorable,currentAdverse),proposed:result(proposedFavorable,proposedAdverse)};
}

function comparison(rows:readonly CohortRow[]):TriggerComparison {
  const arrived=rows.filter(row=>row.n4Arrived).length,verification=rows.filter(isVerifiable).length;
  const current=variantMetric(rows,'current'),proposed=variantMetric(rows,'proposed'),decision=decisions(rows);
  return {total:rows.length,n4:{arrived,skipped:rows.length-arrived,arrivalRatePct:percent(arrived,rows.length)},
    verification:{covered:verification,coveragePct:percent(verification,rows.length)},current,proposed,skippedN3:skippedMetric(rows),
    decision:{...decision,deltas:{favorableRatePct:diff(decision.proposed.favorableRatePct,decision.current.favorableRatePct),
      adverseRatePct:diff(decision.proposed.adverseRatePct,decision.current.adverseRatePct)}},
    deltas:{doubleBeforeStopRatePct:diff(proposed.doubleBeforeStopRatePct,current.doubleBeforeStopRatePct),
      stopBeforeDoubleRatePct:diff(proposed.stopBeforeDoubleRatePct,current.stopBeforeDoubleRatePct),
      medianMaxGainPct:diff(proposed.medianMaxGainPct,current.medianMaxGainPct),
      medianEndGainPct:diff(proposed.medianEndGainPct,current.medianEndGainPct),
      medianMinGainPct:diff(proposed.medianMinGainPct,current.medianMinGainPct)}};
}

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function buildCandidate(input:{asOf:string;source:'debot'|'ave';chain:Chain;rows:CohortRow[]}):NotificationTriggerCandidate {
  const rows=input.rows.slice().sort((a,b)=>a.registeredAt.localeCompare(b.registeredAt)||a.id.localeCompare(b.id));
  let split=Math.floor(rows.length*.8);
  while(split>0&&rows[split]&&rows[split-1].registeredAt===rows[split].registeredAt)split--;
  const validation=rows.slice(split),splitAt=validation[0]?.registeredAt,early=rows.slice(0,split);
  const train=splitAt?early.filter(row=>row.outcomeAt<=splitAt):[];
  const trainStats=comparison(train),validationStats=comparison(validation),reasons:string[]=[];
  if(rows.length<MIN_MATURE)reasons.push('MINIMUM_MATURE_N3_NOT_MET');
  if(trainStats.verification.coveragePct<MIN_COVERAGE||validationStats.verification.coveragePct<MIN_COVERAGE)
    reasons.push('MINIMUM_VERIFICATION_COVERAGE_NOT_MET');
  if(validation.length<MIN_VALIDATION)reasons.push('MINIMUM_VALIDATION_N3_NOT_MET');
  if(trainStats.n4.arrived<MIN_TRAIN_N4)reasons.push('MINIMUM_TRAIN_N4_ARRIVALS_NOT_MET');
  if(validationStats.n4.arrived<MIN_VALIDATION_N4)reasons.push('MINIMUM_VALIDATION_N4_ARRIVALS_NOT_MET');
  let status:NotificationTriggerCandidateStatus='collecting';
  if(!reasons.length) {
    const improved=(value:TriggerComparison)=>(value.decision.deltas.favorableRatePct??0)>0||
      (value.decision.deltas.adverseRatePct??0)<0;
    const tailDelta=validationStats.decision.deltas.adverseRatePct;
    const distributionTail=validationStats.deltas.medianMinGainPct;
    const tailSafe=tailDelta!==null&&tailDelta<=MAX_TAIL_REGRESSION&&
      (distributionTail===null||distributionTail>=-MAX_TAIL_REGRESSION);
    status=improved(trainStats)&&improved(validationStats)&&tailSafe?'shadow_ready':'not_replicated';
    if(!improved(trainStats))reasons.push('TRAIN_IMPROVEMENT_NOT_OBSERVED');
    if(!improved(validationStats))reasons.push('VALIDATION_IMPROVEMENT_NOT_OBSERVED');
    if(!tailSafe)reasons.push('VALIDATION_TAIL_REGRESSION');
  }
  const scope={source:input.source,chain:input.chain,horizonSec:HORIZON as 21600};
  const change={parameter:'signal.trigger_count' as const,from:3 as const,to:4 as const};
  const body={schemaVersion:1 as const,generatorVersion:'notification-trigger-shadow-v2' as const,
    candidatePolicyVersion:`shadow-trigger-v2-${hash({generatorVersion:'notification-trigger-shadow-v2',scope,change}).slice(0,16)}`,
    generatedAt:input.asOf,mode:'shadow' as const,execution:'observation_only' as const,livePolicyMutation:'forbidden' as const,
    promotion:'manual_review_only_after_forward_shadow' as const,scope,change,status,reasons,
    requirements:{minimumMatureN3:MIN_MATURE as 200,minimumVerificationCoveragePct:MIN_COVERAGE as 90,
      minimumValidationN3:MIN_VALIDATION as 40,minimumTrainN4Arrivals:MIN_TRAIN_N4 as 100,
      minimumValidationN4Arrivals:MIN_VALIDATION_N4 as 20,maximumTailRegressionPct:MAX_TAIL_REGRESSION as 5},
    evidence:{matureN3:rows.length,...(splitAt?{splitAt}:{}),purgedTraining:early.length-train.length,
      train:trainStats,validation:validationStats,
      limitations:['SAMPLED_BARRIER_ORDER_NOT_INTRABLOCK_ORDER','FORWARD_QUOTES_ARE_NOT_REALIZED_TRADES',
        'N4_SKIPPED_IS_A_NO_TRADE_DECISION_NOT_A_LOSS','ONLY_DENSE_FIXED_POOL_PATHS_WITH_BASELINE_WITHIN_60S_ARE_VERIFIABLE',
        'SOURCE_AND_CHAIN_COHORTS_ARE_SEPARATE','ONE_PARAMETER_PER_CANDIDATE','HARD_SAFETY_AND_POSITION_LIMITS_UNCHANGED',
        'NO_AUTOMATIC_LIVE_POLICY_CHANGE']}};
  return {...body,id:hash(body)};
}

function horizon(row:NotificationTriggerOutcome|undefined):NotificationHorizonOutcome|undefined {
  return row?.horizons.find(value=>value.seconds===HORIZON);
}

function outcomeRank(row:NotificationTriggerOutcome):number {
  const value=horizon(row);
  return dense(value)?4:value?.mature&&value.status==='covered'?3:value?.mature?2:value?1:0;
}

function preferred(previous:NotificationTriggerOutcome|undefined,next:NotificationTriggerOutcome):NotificationTriggerOutcome {
  if(!previous||next.triggerAt<previous.triggerAt)return next;
  if(next.triggerAt>previous.triggerAt)return previous;
  const difference=outcomeRank(next)-outcomeRank(previous);
  if(difference!==0)return difference>0?next:previous;
  return next.triggerEventId.localeCompare(previous.triggerEventId)<0?next:previous;
}

/**
 * Evaluates requiring notification four against the current notification-three
 * trigger. Every mature N3 session remains in the denominator. Missing N4 means
 * an observed no-trade decision, never a fabricated losing trade.
 */
export function buildNotificationTriggerCandidates(input:{asOf:string;outcomes:readonly NotificationTriggerOutcome[]}):NotificationTriggerCandidate[] {
  if(!stamp(input.asOf)||!Array.isArray(input.outcomes)||input.outcomes.length>100000)
    throw new Error('NOTIFICATION_TRIGGER_CANDIDATE_INPUT_INVALID');
  const asOf=Date.parse(input.asOf);
  const sessions=new Map<string,{three?:NotificationTriggerOutcome;four?:NotificationTriggerOutcome}>();
  for(const row of input.outcomes) {
    if(!row||![3,4].includes(row.notificationNumber)||!['debot','ave'].includes(row.source)||
      !['bsc','solana','robinhood'].includes(row.chain)||!stamp(row.triggerAt)||!stamp(row.sessionFirstReceivedAt)||
      Date.parse(row.triggerAt)>asOf||!row.address||!Array.isArray(row.horizons))continue;
    const key=JSON.stringify([row.source,row.chain,row.address,row.sessionFirstReceivedAt]),entry=sessions.get(key)??{};
    if(row.notificationNumber===3)entry.three=preferred(entry.three,row);
    else entry.four=preferred(entry.four,row);
    sessions.set(key,entry);
  }
  const groups=new Map<string,{source:'debot'|'ave';chain:Chain;rows:CohortRow[]}>();
  for(const [id,entry] of sessions) {
    if(!entry.three)continue;
    const current=horizon(entry.three);
    if(!current?.mature||!stamp(current.endsAt)||current.endsAt>input.asOf)continue;
    const proposed=horizon(entry.four),n4Arrived=entry.four!==undefined;
    const proposedEnd=proposed&&stamp(proposed.endsAt)?proposed.endsAt:
      n4Arrived?new Date(Date.parse(entry.four!.triggerAt)+HORIZON*1000).toISOString():current.endsAt;
    const outcomeAt=current.endsAt>proposedEnd?current.endsAt:proposedEnd;
    const source=entry.three.source as 'debot'|'ave',groupKey=JSON.stringify([source,entry.three.chain]);
    const group=groups.get(groupKey)??{source,chain:entry.three.chain,rows:[]};
    group.rows.push({id,registeredAt:entry.three.triggerAt,outcomeAt,current,n4Arrived,...(proposed?{proposed}:{})});
    groups.set(groupKey,group);
  }
  return [...groups.values()].map(group=>buildCandidate({asOf:input.asOf,...group}))
    .sort((a,b)=>a.scope.source.localeCompare(b.scope.source)||a.scope.chain.localeCompare(b.scope.chain));
}

export function validateNotificationTriggerCandidate(value:NotificationTriggerCandidate):boolean {
  if(!value||value.schemaVersion!==1||value.generatorVersion!=='notification-trigger-shadow-v2'||value.mode!=='shadow'||
    value.execution!=='observation_only'||value.livePolicyMutation!=='forbidden'||value.promotion!=='manual_review_only_after_forward_shadow'||
    value.change.parameter!=='signal.trigger_count'||value.change.from!==3||value.change.to!==4||value.scope.horizonSec!==21600||
    !['debot','ave'].includes(value.scope.source)||!['bsc','solana','robinhood'].includes(value.scope.chain)||!stamp(value.generatedAt)||
    !/^shadow-trigger-v2-[a-f0-9]{16}$/.test(value.candidatePolicyVersion)||
    !['collecting','not_replicated','shadow_ready'].includes(value.status))return false;
  const semantic={generatorVersion:'notification-trigger-shadow-v2',scope:value.scope,change:value.change};
  const {id,...body}=value;
  return value.candidatePolicyVersion===`shadow-trigger-v2-${hash(semantic).slice(0,16)}`&&/^[a-f0-9]{64}$/.test(id)&&hash(body)===id;
}
