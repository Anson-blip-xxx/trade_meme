import {createHash} from 'node:crypto';

export type JsonValue=null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue};
export type JsonObject={[key:string]:JsonValue};
export type StrategyCandidateStatus='collecting'|'forward_shadow'|'shadow_champion'|'rejected'|'rolled_back';
export type StrategyArm='champion'|'challenger';

export interface StrategyCandidateSeal {
  schemaVersion:1;id:string;execution:'research_only';liveMutation:'forbidden';
  evidenceCutoff:string;effectiveAt:string;scope:JsonObject;
  championPolicy:JsonObject;challengerPolicy:JsonObject;
}
export interface StrategyCandidate extends StrategyCandidateSeal {registeredAt:string;status:StrategyCandidateStatus;}
export interface StrategyEpisode {
  id:string;candidateId:string;episodeKey:string;arm:StrategyArm;
  registeredAt:string;matureAt:string;context:JsonObject;
  result?:StrategyEpisodeResult;
}
export type StrategyEpisodeResult=
  {status:'valid';observedAt:string;returnPct:number;givebackPct:number;stopped:boolean}|
  {status:'invalid';observedAt:string;reason:string};

export interface StrategyArmMetrics {
  mature:number;valid:number;coveragePct:number;utcDates:number;
  meanReturnPct:number|null;medianReturnPct:number|null;p10ReturnPct:number|null;
  stopRatePct:number|null;meanGivebackPct:number|null;
}
export interface StrategyEvolutionEvaluation {
  candidateId:string;evaluatedAt:string;decision:'continue'|'promote'|'reject'|'rollback';
  champion:StrategyArmMetrics;challenger:StrategyArmMetrics;
  deltas:{meanReturnPct:number|null;medianReturnPct:number|null;p10ReturnPct:number|null;
    stopRatePct:number|null;meanGivebackPct:number|null};
  earlyWindow:{considered:number;champion:number;challenger:number;p10RegressionPct:number|null;stopRateIncreasePct:number|null};
  requirements:{minimumValidPerArm:30;minimumCoveragePct:90;minimumUtcDatesPerArm:3;
    maximumP10RegressionPct:5;maximumStopRateIncreasePct:3;earlyMaximumP10RegressionPct:15;earlyMaximumStopRateIncreasePct:10};
  reasons:string[];
}

const STATUSES:readonly StrategyCandidateStatus[]=['collecting','forward_shadow','shadow_champion','rejected','rolled_back'];
const iso=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const round=(value:number):number=>Math.round(value*1e6)/1e6;

function checkedJson(value:unknown,path:string,depth=0,seen=new Set<object>()):JsonValue {
  if(depth>20)throw new Error(`STRATEGY_EVOLUTION_JSON_DEPTH:${path}`);
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'){
    if(!Number.isFinite(value))throw new Error(`STRATEGY_EVOLUTION_JSON_NUMBER:${path}`);
    return value;
  }
  if(typeof value!=='object')throw new Error(`STRATEGY_EVOLUTION_JSON_TYPE:${path}`);
  if(seen.has(value))throw new Error(`STRATEGY_EVOLUTION_JSON_CYCLE:${path}`);seen.add(value);
  try {
    if(Array.isArray(value))return value.map((item,index)=>checkedJson(item,`${path}[${index}]`,depth+1,seen));
    const prototype=Object.getPrototypeOf(value);
    if(prototype!==Object.prototype&&prototype!==null)throw new Error(`STRATEGY_EVOLUTION_JSON_OBJECT:${path}`);
    const output:JsonObject={};
    for(const key of Object.keys(value as Record<string,unknown>).sort()){
      if(!key||key.length>200)throw new Error(`STRATEGY_EVOLUTION_JSON_KEY:${path}`);
      output[key]=checkedJson((value as Record<string,unknown>)[key],`${path}.${key}`,depth+1,seen);
    }
    return output;
  }finally{seen.delete(value);}
}

export function canonicalJson(value:unknown):string {
  const text=JSON.stringify(checkedJson(value,'$'));
  if(Buffer.byteLength(text)>64*1024)throw new Error('STRATEGY_EVOLUTION_JSON_LIMIT');
  return text;
}
export function normalizeJsonObject(value:unknown,name='value',allowEmpty=false):JsonObject {
  const parsed=JSON.parse(canonicalJson(value)) as JsonValue;
  if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new Error(`STRATEGY_EVOLUTION_${name.toUpperCase()}_INVALID`);
  if(!allowEmpty&&!Object.keys(parsed).length)throw new Error(`STRATEGY_EVOLUTION_${name.toUpperCase()}_EMPTY`);
  return parsed as JsonObject;
}
const hash=(value:unknown):string=>createHash('sha256').update(canonicalJson(value)).digest('hex');

export function createStrategyCandidateSeal(input:{evidenceCutoff:string;effectiveAt:string;scope:unknown;
  championPolicy:unknown;challengerPolicy:unknown}):StrategyCandidateSeal {
  if(!iso(input?.evidenceCutoff)||!iso(input?.effectiveAt)||input.evidenceCutoff>=input.effectiveAt)
    throw new Error('STRATEGY_EVOLUTION_CANDIDATE_TIME_INVALID');
  const scope=normalizeJsonObject(input.scope,'scope'),championPolicy=normalizeJsonObject(input.championPolicy,'champion_policy');
  const challengerPolicy=normalizeJsonObject(input.challengerPolicy,'challenger_policy');
  if(canonicalJson(championPolicy)===canonicalJson(challengerPolicy))throw new Error('STRATEGY_EVOLUTION_POLICY_UNCHANGED');
  const body={schemaVersion:1 as const,execution:'research_only' as const,liveMutation:'forbidden' as const,
    evidenceCutoff:input.evidenceCutoff,effectiveAt:input.effectiveAt,scope,championPolicy,challengerPolicy};
  return {...body,id:hash(body)};
}

export function validateStrategyCandidateSeal(value:unknown):value is StrategyCandidateSeal {
  try {
    const row=value as StrategyCandidateSeal;
    if(!row||row.schemaVersion!==1||row.execution!=='research_only'||row.liveMutation!=='forbidden'||
      !/^[a-f0-9]{64}$/.test(row.id))return false;
    const recreated=createStrategyCandidateSeal(row),sealed={schemaVersion:row.schemaVersion,id:row.id,execution:row.execution,
      liveMutation:row.liveMutation,evidenceCutoff:row.evidenceCutoff,effectiveAt:row.effectiveAt,scope:row.scope,
      championPolicy:row.championPolicy,challengerPolicy:row.challengerPolicy};
    return recreated.id===row.id&&canonicalJson(recreated)===canonicalJson(sealed);
  }catch{return false;}
}

export function assignStrategyArm(candidateId:string,episodeKey:string):StrategyArm {
  if(!/^[a-f0-9]{64}$/.test(candidateId)||typeof episodeKey!=='string'||!episodeKey.trim()||episodeKey.length>256)
    throw new Error('STRATEGY_EVOLUTION_EPISODE_ID_INVALID');
  const digest=createHash('sha256').update(candidateId).update('\0').update(episodeKey).digest();
  return (digest[0]&1)===0?'champion':'challenger';
}

export function strategyEpisodeId(candidateId:string,episodeKey:string):string {
  assignStrategyArm(candidateId,episodeKey);
  return createHash('sha256').update(candidateId).update('\0episode\0').update(episodeKey).digest('hex');
}

export function validateStrategyEpisodeResult(value:unknown):value is StrategyEpisodeResult {
  if(!value||typeof value!=='object')return false;const result=value as StrategyEpisodeResult;
  if(!iso(result.observedAt))return false;
  if(result.status==='invalid')return typeof result.reason==='string'&&!!result.reason.trim()&&result.reason.length<=500;
  return result.status==='valid'&&finite(result.returnPct)&&result.returnPct>=-100&&result.returnPct<=1e9&&
    finite(result.givebackPct)&&result.givebackPct>=0&&result.givebackPct<=1e9&&typeof result.stopped==='boolean';
}

function percentile(values:readonly number[],fraction:number):number|null {
  if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),position=(sorted.length-1)*fraction;
  const low=Math.floor(position),high=Math.ceil(position);return round(sorted[low]+(sorted[high]-sorted[low])*(position-low));
}
function metrics(rows:readonly StrategyEpisode[],arm:StrategyArm):StrategyArmMetrics {
  const all=rows.filter(row=>row.arm===arm),valid=all.filter((row):row is StrategyEpisode&{result:Extract<StrategyEpisodeResult,{status:'valid'}>}=>row.result?.status==='valid');
  const returns=valid.map(row=>row.result.returnPct),givebacks=valid.map(row=>row.result.givebackPct);
  return {mature:all.length,valid:valid.length,coveragePct:all.length?round(valid.length/all.length*100):0,
    utcDates:new Set(valid.map(row=>row.registeredAt.slice(0,10))).size,
    meanReturnPct:returns.length?round(returns.reduce((sum,value)=>sum+value,0)/returns.length):null,
    medianReturnPct:percentile(returns,.5),p10ReturnPct:percentile(returns,.1),
    stopRatePct:valid.length?round(valid.filter(row=>row.result.stopped).length/valid.length*100):null,
    meanGivebackPct:givebacks.length?round(givebacks.reduce((sum,value)=>sum+value,0)/givebacks.length):null};
}
const delta=(challenger:number|null,champion:number|null):number|null=>challenger===null||champion===null?null:round(challenger-champion);

export function evaluateStrategyCandidate(candidate:StrategyCandidateSeal,episodes:readonly StrategyEpisode[],evaluatedAt:string):StrategyEvolutionEvaluation {
  if(!validateStrategyCandidateSeal(candidate)||!iso(evaluatedAt)||evaluatedAt<candidate.effectiveAt||!Array.isArray(episodes)||episodes.length>100000)
    throw new Error('STRATEGY_EVOLUTION_EVALUATION_INVALID');
  const seen=new Set<string>(),mature:StrategyEpisode[]=[];
  for(const row of episodes){
    if(!row||row.candidateId!==candidate.id||!row.id||seen.has(row.id)||typeof row.episodeKey!=='string'||
      strategyEpisodeId(candidate.id,row.episodeKey)!==row.id||assignStrategyArm(candidate.id,row.episodeKey)!==row.arm||
      !iso(row.registeredAt)||!iso(row.matureAt)||row.registeredAt<candidate.effectiveAt||row.matureAt<=row.registeredAt||
      row.matureAt>evaluatedAt||!row.context||Array.isArray(row.context)||typeof row.context!=='object')continue;
    if(row.result&&(!validateStrategyEpisodeResult(row.result)||row.result.observedAt<row.matureAt||row.result.observedAt>evaluatedAt))continue;
    try{canonicalJson(row.context);}catch{continue;}seen.add(row.id);mature.push(row);
  }
  mature.sort((a,b)=>a.registeredAt.localeCompare(b.registeredAt)||a.id.localeCompare(b.id));
  const champion=metrics(mature,'champion'),challenger=metrics(mature,'challenger');
  const deltas={meanReturnPct:delta(challenger.meanReturnPct,champion.meanReturnPct),
    medianReturnPct:delta(challenger.medianReturnPct,champion.medianReturnPct),p10ReturnPct:delta(challenger.p10ReturnPct,champion.p10ReturnPct),
    stopRatePct:delta(challenger.stopRatePct,champion.stopRatePct),meanGivebackPct:delta(challenger.meanGivebackPct,champion.meanGivebackPct)};
  const first=mature.filter(row=>row.result?.status==='valid').slice(0,20),earlyChampion=metrics(first,'champion'),earlyChallenger=metrics(first,'challenger');
  const earlyWindow={considered:first.length,champion:earlyChampion.valid,challenger:earlyChallenger.valid,
    p10RegressionPct:delta(earlyChallenger.p10ReturnPct,earlyChampion.p10ReturnPct),
    stopRateIncreasePct:delta(earlyChallenger.stopRatePct,earlyChampion.stopRatePct)};
  const requirements={minimumValidPerArm:30 as const,minimumCoveragePct:90 as const,minimumUtcDatesPerArm:3 as const,
    maximumP10RegressionPct:5 as const,maximumStopRateIncreasePct:3 as const,earlyMaximumP10RegressionPct:15 as const,
    earlyMaximumStopRateIncreasePct:10 as const};
  const reasons:string[]=[];let decision:StrategyEvolutionEvaluation['decision']='continue';
  const earlyComparable=first.length===20&&earlyChampion.valid>=8&&earlyChallenger.valid>=8;
  if(earlyComparable&&((earlyWindow.p10RegressionPct??0)<-requirements.earlyMaximumP10RegressionPct||
    (earlyWindow.stopRateIncreasePct??0)>requirements.earlyMaximumStopRateIncreasePct)){
    decision='rollback';reasons.push('EARLY_SEVERE_TAIL_REGRESSION');
  }else{
    if(champion.valid<requirements.minimumValidPerArm||challenger.valid<requirements.minimumValidPerArm)reasons.push('MINIMUM_VALID_PER_ARM_NOT_MET');
    if(champion.coveragePct<requirements.minimumCoveragePct||challenger.coveragePct<requirements.minimumCoveragePct)reasons.push('MINIMUM_COVERAGE_NOT_MET');
    if(champion.utcDates<requirements.minimumUtcDatesPerArm||challenger.utcDates<requirements.minimumUtcDatesPerArm)reasons.push('MINIMUM_UTC_DATES_NOT_MET');
    if(!reasons.length){
      const meanSafe=(deltas.meanReturnPct??-Infinity)>=0,medianSafe=(deltas.medianReturnPct??-Infinity)>=0;
      const p10Safe=(deltas.p10ReturnPct??-Infinity)>=-requirements.maximumP10RegressionPct;
      const stopSafe=(deltas.stopRatePct??Infinity)<=requirements.maximumStopRateIncreasePct;
      const improves=(deltas.meanGivebackPct??Infinity)<0||(deltas.meanReturnPct??0)>0||(deltas.medianReturnPct??0)>0;
      if(meanSafe&&medianSafe&&p10Safe&&stopSafe&&improves)decision='promote';
      else {decision='reject';
        if(!meanSafe)reasons.push('MEAN_RETURN_REGRESSION');if(!medianSafe)reasons.push('MEDIAN_RETURN_REGRESSION');
        if(!p10Safe)reasons.push('P10_RETURN_REGRESSION');if(!stopSafe)reasons.push('STOP_RATE_REGRESSION');
        if(!improves)reasons.push('NO_RETURN_OR_GIVEBACK_IMPROVEMENT');
      }
    }
  }
  return {candidateId:candidate.id,evaluatedAt,decision,champion,challenger,deltas,earlyWindow,requirements,reasons};
}

export function canTransitionStrategyCandidate(from:StrategyCandidateStatus,to:StrategyCandidateStatus):boolean {
  if(!STATUSES.includes(from)||!STATUSES.includes(to)||from===to)return false;
  return from==='collecting'?(to==='forward_shadow'||to==='rejected'):
    from==='forward_shadow'?(to==='shadow_champion'||to==='rejected'||to==='rolled_back'):
    from==='shadow_champion'&&to==='rolled_back';
}
