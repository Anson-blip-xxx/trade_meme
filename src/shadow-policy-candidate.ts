import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {Chain,Report,Signal} from './types.js';
import type {FollowupFeature} from './signal-followup.js';

type Source=Signal['source'];
export type ShadowEntryParameter=
  'entry.require_positive_net_buy'|'entry.require_social_link'|
  'entry.require_precursor_setup'|'entry.require_public_entry_setup';
export type ShadowCandidateStatus='collecting'|'not_replicated'|'shadow_ready';

export interface ShadowPolicySample {
  id:string;source:Source;chain:Chain;decision:Report['decision'];policyVersion:string;
  registeredAt:string;matureAt:string;outcomeAt?:string;gainPct?:number;
  features:Record<FollowupFeature,boolean|null>;
}
export interface ShadowPolicyMetric {
  /** Sessions in which this policy would have entered. */
  entered:number;
  /** Sessions deliberately not entered by this policy. */
  skipped:number;
  /** Entered sessions with a comparable forward outcome. */
  covered:number;
  coveragePct:number|null;
  meanGainPct:number|null;medianGainPct:number|null;winRatePct:number|null;
  p10GainPct:number|null;stopLoss60RatePct:number|null;
}
export interface ShadowPolicySkippedMetric {
  total:number;covered:number;coveragePct:number|null;
  winners:number;losers:number;breakEven:number;stopLosses:number;
  winRatePct:number|null;lossRatePct:number|null;medianGainPct:number|null;
}
export interface ShadowPolicyDecisionMetric {
  /** All covered sessions, including sessions the proposed rule would skip. */
  verifiable:number;favorable:number;adverse:number;neutral:number;
  favorableRatePct:number|null;adverseRatePct:number|null;
}
export interface ShadowPolicyComparison {
  /** Every mature session in this chronological partition. */
  total:number;covered:number;coveragePct:number;
  current:ShadowPolicyMetric;proposed:ShadowPolicyMetric;skipped:ShadowPolicySkippedMetric;
  decision:{current:ShadowPolicyDecisionMetric;proposed:ShadowPolicyDecisionMetric;
    deltas:{favorableRatePct:number|null;adverseRatePct:number|null}};
  deltas:{meanGainPct:number|null;medianGainPct:number|null;winRatePct:number|null;p10GainPct:number|null;stopLoss60RatePct:number|null};
}
export interface ShadowPolicyCandidate {
  schemaVersion:1;generatorVersion:'daily-shadow-policy-v2';id:string;
  candidatePolicyVersion:string;generatedAt:string;mode:'shadow';execution:'observation_only';
  livePolicyMutation:'forbidden';promotion:'manual_review_only_after_forward_shadow';
  scope:{source:Source;chain:Chain;decision:'BUY_CANDIDATE';basePolicyVersion:string;horizonSec:21600};
  change:{parameter:ShadowEntryParameter;from:false;to:true;feature:FollowupFeature};
  status:ShadowCandidateStatus;reasons:string[];
  requirements:{minimumMatureSamples:200;minimumCoveragePct:90;minimumVariantCovered:100;minimumValidationVariantCovered:20;maximumTailRegressionPct:5};
  evidence:{mature:number;covered:number;coveragePct:number;splitAt?:string;purgedTraining:number;
    train:ShadowPolicyComparison;validation:ShadowPolicyComparison;limitations:string[]};
}

interface Definition {parameter:ShadowEntryParameter;feature:FollowupFeature;}
const DEFINITIONS:readonly Definition[]=[
  {parameter:'entry.require_positive_net_buy',feature:'positive_net_buy'},
  {parameter:'entry.require_social_link',feature:'social_link'},
  {parameter:'entry.require_precursor_setup',feature:'precursor_setup'},
  {parameter:'entry.require_public_entry_setup',feature:'public_entry_setup'},
];
const SOURCES:readonly Source[]=['debot','gmgn','ave','wallet','manual'];
const CHAINS:readonly Chain[]=['bsc','solana','robinhood'];
const HORIZON_SEC=21600,TOLERANCE_SEC=600,MIN_MATURE=200,MIN_COVERAGE=90,MIN_VARIANT=100,MIN_VALIDATION=20,MAX_TAIL_REGRESSION=5;
const stamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&
  Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const round=(n:number):number=>Math.round(n*1e6)/1e6;
const difference=(a:number|null,b:number|null):number|null=>a===null||b===null?null:round(a-b);
function percentile(values:number[],fraction:number):number|null {
  if(!values.length)return null;const sorted=values.slice().sort((a,b)=>a-b),index=(sorted.length-1)*fraction;
  const low=Math.floor(index),high=Math.ceil(index);return round(sorted[low]+(sorted[high]-sorted[low])*(index-low));
}
function metric(rows:readonly ShadowPolicySample[],feature:FollowupFeature,proposed:boolean):ShadowPolicyMetric {
  const entered=proposed?rows.filter(row=>row.features[feature]===true):[...rows];
  const values=entered.flatMap(row=>finite(row.gainPct)?[row.gainPct]:[]);
  return {entered:entered.length,skipped:rows.length-entered.length,covered:values.length,
    coveragePct:entered.length?round(values.length/entered.length*100):null,
    meanGainPct:values.length?round(values.reduce((sum,value)=>sum+value,0)/values.length):null,
    medianGainPct:percentile(values,0.5),winRatePct:values.length?round(values.filter(value=>value>0).length/values.length*100):null,
    p10GainPct:percentile(values,0.1),stopLoss60RatePct:values.length?round(values.filter(value=>value<=-60).length/values.length*100):null};
}
function skippedMetric(rows:readonly ShadowPolicySample[],feature:FollowupFeature):ShadowPolicySkippedMetric {
  const skipped=rows.filter(row=>row.features[feature]!==true),values=skipped.flatMap(row=>finite(row.gainPct)?[row.gainPct]:[]);
  const winners=values.filter(value=>value>0).length,losers=values.filter(value=>value<0).length;
  return {total:skipped.length,covered:values.length,coveragePct:skipped.length?round(values.length/skipped.length*100):null,
    winners,losers,breakEven:values.length-winners-losers,stopLosses:values.filter(value=>value<=-60).length,
    winRatePct:values.length?round(winners/values.length*100):null,lossRatePct:values.length?round(losers/values.length*100):null,
    medianGainPct:percentile(values,0.5)};
}
function decisions(rows:readonly ShadowPolicySample[],feature:FollowupFeature):{current:ShadowPolicyDecisionMetric;proposed:ShadowPolicyDecisionMetric} {
  const covered=rows.filter((row):row is ShadowPolicySample&{gainPct:number}=>finite(row.gainPct));
  let currentFavorable=0,currentAdverse=0,proposedFavorable=0,proposedAdverse=0;
  for(const row of covered){
    if(row.gainPct>0)currentFavorable++;else if(row.gainPct<0)currentAdverse++;
    if(row.features[feature]===true){
      if(row.gainPct>0)proposedFavorable++;else if(row.gainPct<0)proposedAdverse++;
    }else{
      // Avoiding a losing session is favorable. Skipping a winner is the
      // opportunity cost of requiring this feature and therefore adverse.
      if(row.gainPct<0)proposedFavorable++;else if(row.gainPct>0)proposedAdverse++;
    }
  }
  const result=(favorable:number,adverse:number):ShadowPolicyDecisionMetric=>({verifiable:covered.length,favorable,adverse,
    neutral:covered.length-favorable-adverse,favorableRatePct:covered.length?round(favorable/covered.length*100):null,
    adverseRatePct:covered.length?round(adverse/covered.length*100):null});
  return {current:result(currentFavorable,currentAdverse),proposed:result(proposedFavorable,proposedAdverse)};
}
function comparison(rows:readonly ShadowPolicySample[],feature:FollowupFeature):ShadowPolicyComparison {
  const current=metric(rows,feature,false),proposed=metric(rows,feature,true),skipped=skippedMetric(rows,feature);
  const covered=rows.filter(row=>finite(row.gainPct)).length,decision=decisions(rows,feature);
  return {total:rows.length,covered,coveragePct:rows.length?round(covered/rows.length*100):0,current,proposed,skipped,
    decision:{...decision,deltas:{favorableRatePct:difference(decision.proposed.favorableRatePct,decision.current.favorableRatePct),
      adverseRatePct:difference(decision.proposed.adverseRatePct,decision.current.adverseRatePct)}},
    deltas:{meanGainPct:difference(proposed.meanGainPct,current.meanGainPct),medianGainPct:difference(proposed.medianGainPct,current.medianGainPct),
      winRatePct:difference(proposed.winRatePct,current.winRatePct),p10GainPct:difference(proposed.p10GainPct,current.p10GainPct),
      stopLoss60RatePct:difference(proposed.stopLoss60RatePct,current.stopLoss60RatePct)}};
}
function hash(value:unknown):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function improved(value:ShadowPolicyComparison):boolean {
  const favorable=value.decision.deltas.favorableRatePct,adverse=value.decision.deltas.adverseRatePct;
  return favorable!==null&&adverse!==null&&(favorable>0||adverse<0)&&favorable>=0&&adverse<=0;
}
function candidate(input:{asOf:string;scope:ShadowPolicyCandidate['scope'];definition:Definition;rows:ShadowPolicySample[]}):ShadowPolicyCandidate {
  const rows=input.rows.slice().sort((a,b)=>a.registeredAt.localeCompare(b.registeredAt)||a.id.localeCompare(b.id));
  let split=Math.floor(rows.length*0.8);while(split>0&&rows[split]&&rows[split-1].registeredAt===rows[split].registeredAt)split--;
  const validation=rows.slice(split),splitAt=validation[0]?.registeredAt,early=rows.slice(0,split);
  // Outcomes that were not yet knowable when validation began cannot train the candidate.
  const train=splitAt?early.filter(row=>row.matureAt<=splitAt&&(!row.outcomeAt||row.outcomeAt<=splitAt)):[];
  const trainStats=comparison(train,input.definition.feature),validationStats=comparison(validation,input.definition.feature);
  const covered=rows.filter(row=>finite(row.gainPct)).length,coveragePct=rows.length?round(covered/rows.length*100):0,reasons:string[]=[];
  if(rows.length<MIN_MATURE)reasons.push('MINIMUM_MATURE_SAMPLES_NOT_MET');
  if(coveragePct<MIN_COVERAGE||trainStats.coveragePct<MIN_COVERAGE||validationStats.coveragePct<MIN_COVERAGE)reasons.push('MINIMUM_COVERAGE_NOT_MET');
  if(trainStats.proposed.covered<MIN_VARIANT||trainStats.skipped.covered<MIN_VARIANT)reasons.push('MINIMUM_TRAIN_VARIANT_NOT_MET');
  if(validationStats.proposed.covered<MIN_VALIDATION||validationStats.skipped.covered<MIN_VALIDATION)reasons.push('MINIMUM_VALIDATION_VARIANT_NOT_MET');
  let status:ShadowCandidateStatus='collecting';
  if(!reasons.length){
    const trainDirection=improved(trainStats),validationDirection=improved(validationStats);
    const tailSafe=(validationStats.deltas.p10GainPct??-Infinity)>=-MAX_TAIL_REGRESSION&&
      (validationStats.deltas.stopLoss60RatePct??Infinity)<=MAX_TAIL_REGRESSION;
    status=trainDirection&&validationDirection&&tailSafe?'shadow_ready':'not_replicated';
    if(!trainDirection)reasons.push('TRAIN_IMPROVEMENT_NOT_OBSERVED');
    if(!validationDirection)reasons.push('VALIDATION_IMPROVEMENT_NOT_OBSERVED');
    if(!tailSafe)reasons.push('VALIDATION_TAIL_REGRESSION');
  }
  const change={parameter:input.definition.parameter,from:false as const,to:true as const,feature:input.definition.feature};
  const semantic={generatorVersion:'daily-shadow-policy-v2',scope:input.scope,change};
  const body={schemaVersion:1 as const,generatorVersion:'daily-shadow-policy-v2' as const,
    candidatePolicyVersion:`shadow-entry-v2-${hash(semantic).slice(0,16)}`,generatedAt:input.asOf,mode:'shadow' as const,
    execution:'observation_only' as const,livePolicyMutation:'forbidden' as const,
    promotion:'manual_review_only_after_forward_shadow' as const,scope:input.scope,change,status,reasons,
    requirements:{minimumMatureSamples:MIN_MATURE as 200,minimumCoveragePct:MIN_COVERAGE as 90,minimumVariantCovered:MIN_VARIANT as 100,
      minimumValidationVariantCovered:MIN_VALIDATION as 20,maximumTailRegressionPct:MAX_TAIL_REGRESSION as 5},
    evidence:{mature:rows.length,covered,coveragePct,...(splitAt?{splitAt}:{}),purgedTraining:early.length-train.length,
      train:trainStats,validation:validationStats,
      limitations:['FORWARD_QUOTES_ARE_NOT_REALIZED_TRADES','OBSERVATIONAL_ASSOCIATION_NOT_CAUSATION','FULL_MATURE_COHORT_IS_DECISION_DENOMINATOR',
        'SKIPPED_WINNERS_ARE_NO_TRADE_OPPORTUNITY_COST','SOURCE_CHAIN_AND_POLICY_COHORTS_ARE_SEPARATE','ONE_PARAMETER_PER_CANDIDATE',
        'HARD_SAFETY_AND_POSITION_LIMITS_UNCHANGED','NO_AUTOMATIC_LIVE_POLICY_CHANGE']}};
  return {...body,id:hash(body)};
}

/** Builds versioned research candidates only. It has no reference to runtime policy or order execution. */
export function buildShadowPolicyCandidates(input:{asOf:string;samples:readonly ShadowPolicySample[]}):ShadowPolicyCandidate[] {
  if(!stamp(input.asOf)||!Array.isArray(input.samples)||input.samples.length>20000)throw new Error('SHADOW_POLICY_INPUT_INVALID');
  const asOf=Date.parse(input.asOf),groups=new Map<string,ShadowPolicySample[]>(),seen=new Set<string>();
  for(const sample of input.samples){
    if(!sample||!sample.id||sample.id.length>200||!SOURCES.includes(sample.source)||!CHAINS.includes(sample.chain)||sample.decision!=='BUY_CANDIDATE'||
      !sample.policyVersion||sample.policyVersion.length>100||!stamp(sample.registeredAt)||!stamp(sample.matureAt)||Date.parse(sample.matureAt)>asOf||
      Date.parse(sample.matureAt)<=Date.parse(sample.registeredAt)||sample.outcomeAt!==undefined&&!stamp(sample.outcomeAt)||sample.gainPct!==undefined&&!finite(sample.gainPct))continue;
    const key=JSON.stringify([sample.source,sample.chain,sample.policyVersion]),identity=`${key}:${sample.id}`;if(seen.has(identity))continue;seen.add(identity);
    const observable=sample.outcomeAt!==undefined&&sample.gainPct!==undefined&&Date.parse(sample.outcomeAt)>=Date.parse(sample.registeredAt)&&
      Date.parse(sample.outcomeAt)<=asOf;
    const normalized={...sample,...(!observable?{outcomeAt:undefined,gainPct:undefined}:{})};
    const list=groups.get(key)??[];list.push(normalized);groups.set(key,list);
  }
  const output:ShadowPolicyCandidate[]=[];
  for(const rows of groups.values()){
    const first=rows[0],scope={source:first.source,chain:first.chain,decision:'BUY_CANDIDATE' as const,
      basePolicyVersion:first.policyVersion,horizonSec:HORIZON_SEC as 21600};
    for(const definition of DEFINITIONS)output.push(candidate({asOf:input.asOf,scope,definition,rows}));
  }
  return output.sort((a,b)=>a.scope.source.localeCompare(b.scope.source)||a.scope.chain.localeCompare(b.scope.chain)||
    a.scope.basePolicyVersion.localeCompare(b.scope.basePolicyVersion)||a.change.parameter.localeCompare(b.change.parameter));
}

export function validateShadowPolicyCandidate(value:ShadowPolicyCandidate):boolean {
  if(!value||value.schemaVersion!==1||value.generatorVersion!=='daily-shadow-policy-v2'||value.mode!=='shadow'||
    value.execution!=='observation_only'||value.livePolicyMutation!=='forbidden'||value.promotion!=='manual_review_only_after_forward_shadow'||
    value.scope.decision!=='BUY_CANDIDATE'||value.scope.horizonSec!==21600||!SOURCES.includes(value.scope.source)||!CHAINS.includes(value.scope.chain)||
    value.change.from!==false||value.change.to!==true||!DEFINITIONS.some(row=>row.parameter===value.change.parameter&&row.feature===value.change.feature)||
    !stamp(value.generatedAt)||!/^shadow-entry-v2-[a-f0-9]{16}$/.test(value.candidatePolicyVersion)||
    !['collecting','not_replicated','shadow_ready'].includes(value.status))return false;
  const semantic={generatorVersion:'daily-shadow-policy-v2',scope:value.scope,change:value.change};
  const {id,...body}=value;return value.candidatePolicyVersion===`shadow-entry-v2-${hash(semantic).slice(0,16)}`&&/^[a-f0-9]{64}$/.test(id)&&hash(body)===id;
}

/** Reads only compact, immutable first-feature snapshots and already-mature 6h outcomes. */
export function readMatureFollowupSamples(path:string,asOf:string):ShadowPolicySample[] {
  if(!path||path.includes('\0')||!stamp(asOf))throw new Error('SHADOW_POLICY_INPUT_INVALID');
  const db=new DatabaseSync(path,{readOnly:true});try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='signal_followups'").get())return [];
    const cutoff=new Date(Date.parse(asOf)-(HORIZON_SEC+TOLERANCE_SEC)*1000).toISOString(),out:ShadowPolicySample[]=[];
    const rows=db.prepare('SELECT chain,address,registered_at,summary_record FROM signal_followups WHERE registered_at<=? ORDER BY registered_at,chain,address LIMIT 20001').all(cutoff);
    if(rows.length>20000)throw new Error('SHADOW_POLICY_INPUT_LIMIT_EXCEEDED');
    for(const row of rows){try{
      const value=JSON.parse(String(row.summary_record)) as Record<string,unknown>,initial=value.initial as Record<string,unknown>|undefined;
      const performance=value.performance as Record<string,unknown>|undefined,horizons=value.horizons as Record<string,unknown>|undefined;
      const features=initial?.features as Record<string,unknown>|undefined,horizon=horizons?.[String(HORIZON_SEC)] as Record<string,unknown>|undefined;
      const registeredAt=String(row.registered_at),matureAt=new Date(Date.parse(registeredAt)+(HORIZON_SEC+TOLERANCE_SEC)*1000).toISOString();
      const source=initial?.source as Source;
      if(!stamp(registeredAt)||matureAt>asOf||!initial||!features||!SOURCES.includes(source))continue;
      const normalized=Object.fromEntries(['two_wallet_groups','positive_net_buy','social_link','precursor_setup','public_entry_setup'].map(key=>
        [key,typeof features[key]==='boolean'?features[key]:null])) as unknown as Record<FollowupFeature,boolean|null>;
      const outcomeAt=typeof horizon?.at==='string'&&stamp(horizon.at)&&horizon.at<=asOf&&!performance?.baselineDelayed&&
        horizon.fixedPoolComparable===true?horizon.at:undefined;
      const gainPct=outcomeAt&&finite(horizon?.gainPct)?horizon.gainPct:undefined;
      out.push({id:`${source}:${row.chain}:${row.address}`,source,chain:row.chain as Chain,decision:initial.decision as Report['decision'],
        policyVersion:String(initial.policyVersion??''),registeredAt,matureAt,...(outcomeAt&&gainPct!==undefined?{outcomeAt,gainPct}:{}),features:normalized});
    }catch{/* A corrupt compact row is missing evidence, never a zero return. */}}
    return out;
  }finally{db.close();}
}
