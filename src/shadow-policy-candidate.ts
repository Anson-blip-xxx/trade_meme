import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {Chain,Report} from './types.js';
import type {FollowupFeature} from './signal-followup.js';

export type ShadowEntryParameter=
  'entry.require_positive_net_buy'|'entry.require_social_link'|
  'entry.require_precursor_setup'|'entry.require_public_entry_setup';
export type ShadowCandidateStatus='collecting'|'not_replicated'|'shadow_ready';

export interface ShadowPolicySample {
  id:string;chain:Chain;decision:Report['decision'];policyVersion:string;
  registeredAt:string;matureAt:string;outcomeAt?:string;gainPct?:number;
  features:Record<FollowupFeature,boolean|null>;
}
export interface ShadowPolicyMetric {
  selected:number;covered:number;coveragePct:number|null;
  meanGainPct:number|null;medianGainPct:number|null;winRatePct:number|null;
  p10GainPct:number|null;stopLoss60RatePct:number|null;
}
export interface ShadowPolicyComparison {
  total:number;covered:number;coveragePct:number;current:ShadowPolicyMetric;proposed:ShadowPolicyMetric;
  deltas:{meanGainPct:number|null;medianGainPct:number|null;winRatePct:number|null;p10GainPct:number|null;stopLoss60RatePct:number|null};
}
export interface ShadowPolicyCandidate {
  schemaVersion:1;generatorVersion:'daily-shadow-policy-v1';id:string;
  candidatePolicyVersion:string;generatedAt:string;mode:'shadow';execution:'observation_only';
  livePolicyMutation:'forbidden';promotion:'manual_review_only_after_forward_shadow';
  scope:{chain:Chain;decision:'BUY_CANDIDATE';basePolicyVersion:string;horizonSec:21600};
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
  const selected=proposed?rows.filter(row=>row.features[feature]===true):[...rows];
  const values=selected.flatMap(row=>finite(row.gainPct)?[row.gainPct]:[]);
  return {selected:selected.length,covered:values.length,coveragePct:selected.length?round(values.length/selected.length*100):null,
    meanGainPct:values.length?round(values.reduce((sum,value)=>sum+value,0)/values.length):null,
    medianGainPct:percentile(values,0.5),winRatePct:values.length?round(values.filter(value=>value>0).length/values.length*100):null,
    p10GainPct:percentile(values,0.1),stopLoss60RatePct:values.length?round(values.filter(value=>value<=-60).length/values.length*100):null};
}
function comparison(rows:readonly ShadowPolicySample[],feature:FollowupFeature):ShadowPolicyComparison {
  const current=metric(rows,feature,false),proposed=metric(rows,feature,true),covered=rows.filter(row=>finite(row.gainPct)).length;
  return {total:rows.length,covered,coveragePct:rows.length?round(covered/rows.length*100):0,current,proposed,
    deltas:{meanGainPct:difference(proposed.meanGainPct,current.meanGainPct),medianGainPct:difference(proposed.medianGainPct,current.medianGainPct),
      winRatePct:difference(proposed.winRatePct,current.winRatePct),p10GainPct:difference(proposed.p10GainPct,current.p10GainPct),
      stopLoss60RatePct:difference(proposed.stopLoss60RatePct,current.stopLoss60RatePct)}};
}
function hash(value:unknown):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
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
  if(trainStats.current.covered<MIN_VARIANT||trainStats.proposed.covered<MIN_VARIANT)reasons.push('MINIMUM_TRAIN_VARIANT_NOT_MET');
  if(validationStats.current.covered<MIN_VALIDATION||validationStats.proposed.covered<MIN_VALIDATION)reasons.push('MINIMUM_VALIDATION_VARIANT_NOT_MET');
  let status:ShadowCandidateStatus='collecting';
  if(!reasons.length){
    const trainDirection=(trainStats.deltas.medianGainPct??0)>0||(trainStats.deltas.winRatePct??0)>0;
    const validationDirection=(validationStats.deltas.medianGainPct??0)>0||(validationStats.deltas.winRatePct??0)>0;
    const tailSafe=(validationStats.deltas.p10GainPct??-Infinity)>=-MAX_TAIL_REGRESSION&&
      (validationStats.deltas.stopLoss60RatePct??Infinity)<=MAX_TAIL_REGRESSION;
    status=trainDirection&&validationDirection&&tailSafe?'shadow_ready':'not_replicated';
    if(!trainDirection)reasons.push('TRAIN_IMPROVEMENT_NOT_OBSERVED');
    if(!validationDirection)reasons.push('VALIDATION_IMPROVEMENT_NOT_OBSERVED');
    if(!tailSafe)reasons.push('VALIDATION_TAIL_REGRESSION');
  }
  const change={parameter:input.definition.parameter,from:false as const,to:true as const,feature:input.definition.feature};
  const semantic={generatorVersion:'daily-shadow-policy-v1',scope:input.scope,change};
  const body={schemaVersion:1 as const,generatorVersion:'daily-shadow-policy-v1' as const,
    candidatePolicyVersion:`shadow-entry-${hash(semantic).slice(0,16)}`,generatedAt:input.asOf,mode:'shadow' as const,
    execution:'observation_only' as const,livePolicyMutation:'forbidden' as const,
    promotion:'manual_review_only_after_forward_shadow' as const,scope:input.scope,change,status,reasons,
    requirements:{minimumMatureSamples:MIN_MATURE as 200,minimumCoveragePct:MIN_COVERAGE as 90,minimumVariantCovered:MIN_VARIANT as 100,
      minimumValidationVariantCovered:MIN_VALIDATION as 20,maximumTailRegressionPct:MAX_TAIL_REGRESSION as 5},
    evidence:{mature:rows.length,covered,coveragePct,...(splitAt?{splitAt}:{}),purgedTraining:early.length-train.length,
      train:trainStats,validation:validationStats,
      limitations:['FORWARD_QUOTES_ARE_NOT_REALIZED_TRADES','OBSERVATIONAL_ASSOCIATION_NOT_CAUSATION','ONE_PARAMETER_PER_CANDIDATE',
        'HARD_SAFETY_AND_POSITION_LIMITS_UNCHANGED','NO_AUTOMATIC_LIVE_POLICY_CHANGE']}};
  return {...body,id:hash(body)};
}

/** Builds versioned research candidates only. It has no reference to runtime policy or order execution. */
export function buildShadowPolicyCandidates(input:{asOf:string;samples:readonly ShadowPolicySample[]}):ShadowPolicyCandidate[] {
  if(!stamp(input.asOf)||!Array.isArray(input.samples)||input.samples.length>20000)throw new Error('SHADOW_POLICY_INPUT_INVALID');
  const asOf=Date.parse(input.asOf),groups=new Map<string,ShadowPolicySample[]>(),seen=new Set<string>();
  for(const sample of input.samples){
    if(!sample||!sample.id||sample.id.length>200||!['bsc','solana','robinhood'].includes(sample.chain)||sample.decision!=='BUY_CANDIDATE'||
      !sample.policyVersion||sample.policyVersion.length>100||!stamp(sample.registeredAt)||!stamp(sample.matureAt)||Date.parse(sample.matureAt)>asOf||
      Date.parse(sample.matureAt)<=Date.parse(sample.registeredAt)||sample.outcomeAt!==undefined&&!stamp(sample.outcomeAt)||sample.gainPct!==undefined&&!finite(sample.gainPct))continue;
    const key=JSON.stringify([sample.chain,sample.policyVersion]),identity=`${key}:${sample.id}`;if(seen.has(identity))continue;seen.add(identity);
    const observable=sample.outcomeAt!==undefined&&sample.gainPct!==undefined&&Date.parse(sample.outcomeAt)>=Date.parse(sample.registeredAt)&&
      Date.parse(sample.outcomeAt)<=asOf;
    const normalized={...sample,...(!observable?{outcomeAt:undefined,gainPct:undefined}:{})};
    const list=groups.get(key)??[];list.push(normalized);groups.set(key,list);
  }
  const output:ShadowPolicyCandidate[]=[];
  for(const rows of groups.values()){
    const first=rows[0],scope={chain:first.chain,decision:'BUY_CANDIDATE' as const,basePolicyVersion:first.policyVersion,horizonSec:HORIZON_SEC as 21600};
    for(const definition of DEFINITIONS)output.push(candidate({asOf:input.asOf,scope,definition,rows}));
  }
  return output.sort((a,b)=>a.scope.chain.localeCompare(b.scope.chain)||a.scope.basePolicyVersion.localeCompare(b.scope.basePolicyVersion)||
    a.change.parameter.localeCompare(b.change.parameter));
}

export function validateShadowPolicyCandidate(value:ShadowPolicyCandidate):boolean {
  if(!value||value.schemaVersion!==1||value.generatorVersion!=='daily-shadow-policy-v1'||value.mode!=='shadow'||
    value.execution!=='observation_only'||value.livePolicyMutation!=='forbidden'||value.promotion!=='manual_review_only_after_forward_shadow'||
    value.change.from!==false||value.change.to!==true||!DEFINITIONS.some(row=>row.parameter===value.change.parameter&&row.feature===value.change.feature)||
    !stamp(value.generatedAt)||!/^shadow-entry-[a-f0-9]{16}$/.test(value.candidatePolicyVersion)||!['collecting','not_replicated','shadow_ready'].includes(value.status))return false;
  const semantic={generatorVersion:'daily-shadow-policy-v1',scope:value.scope,change:value.change};
  const {id,...body}=value;return value.candidatePolicyVersion===`shadow-entry-${hash(semantic).slice(0,16)}`&&/^[a-f0-9]{64}$/.test(id)&&hash(body)===id;
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
      if(!stamp(registeredAt)||matureAt>asOf||!initial||!features)continue;
      const normalized=Object.fromEntries(['two_wallet_groups','positive_net_buy','social_link','precursor_setup','public_entry_setup'].map(key=>
        [key,typeof features[key]==='boolean'?features[key]:null])) as unknown as Record<FollowupFeature,boolean|null>;
      const outcomeAt=typeof horizon?.at==='string'&&stamp(horizon.at)&&horizon.at<=asOf&&!performance?.baselineDelayed?horizon.at:undefined;
      const gainPct=outcomeAt&&finite(horizon?.gainPct)?horizon.gainPct:undefined;
      out.push({id:`${row.chain}:${row.address}`,chain:row.chain as Chain,decision:initial.decision as Report['decision'],
        policyVersion:String(initial.policyVersion??''),registeredAt,matureAt,...(outcomeAt&&gainPct!==undefined?{outcomeAt,gainPct}:{}),features:normalized});
    }catch{/* A corrupt compact row is missing evidence, never a zero return. */}}
    return out;
  }finally{db.close();}
}
