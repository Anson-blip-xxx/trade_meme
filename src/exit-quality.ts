import {DatabaseSync} from 'node:sqlite';
import type {AdaptiveExitState} from './adaptive-exit.js';
import {shadowReturn,type ShadowReturn} from './exit-shadow-return.js';
import type {Chain} from './types.js';

export const EXIT_QUALITY_SAMPLE_LIMIT=2000;
export const EXIT_QUALITY_WINDOW_SEC=120;
export const EXIT_QUALITY_HORIZONS=[5,15,60] as const;
export interface ExitQualitySample {at:string;priceUsd:number;source:string;pool?:string;}
export type ExitQualityComparisonStatus='valid'|'open'|'return_unavailable'|'not_due'|'awaiting_sample'|'missing_price'|'provenance_unknown'|'provenance_mismatch'|'sample_limit'|'invalid_sample';
export interface ExitQualityComparison {
  minutes:number;status:ExitQualityComparisonStatus;dueAt?:string;windowEndsAt?:string;
  sampleAt?:string;lateSec?:number;source?:string;pool?:string;priceUsd?:number;
  tokenMovePct?:number;impactOnInitialPrincipalPct?:number;
  direction?:'continued_up'|'avoided_drawdown'|'flat';
}
export interface ExitQuality {
  version:'exit-quality-v1';asOf:string;mode:'shadow';execution:'observation_only';costsIncluded:false;
  basis:'initial_principal_pct';status:'open'|'closed'|'unavailable';policyVersion:string;
  finalGainPct?:number;closedAt?:string;reason?:string;
  equityPeak:{status:'valid'|'unknown';reason?:string;gainPct?:number;at?:string;givebackPct?:number;
    samples:number;sampleLimit:number;maxGapSec?:number;scope:'retained_pre_exit_samples_only'};
  afterExit:ExitQualityComparison[];
  comparisonWindowSec:number;
}
export interface ExitQualityInput {
  asOf:string;policyVersion:string;baselineAt:string;baselinePriceUsd:number;returns:ShadowReturn;
  preExitSamples:readonly ExitQualitySample[];preExitTruncated:boolean;
  exitSample?:ExitQualitySample;
  comparisonSamples:Readonly<Record<number,{samples:readonly ExitQualitySample[];truncated:boolean}>>;
}
const time=(value:unknown)=>typeof value==='string'?Date.parse(value):NaN;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const valid=(sample:ExitQualitySample)=>Number.isFinite(time(sample.at))&&finite(sample.priceUsd)&&sample.priceUsd>0&&typeof sample.source==='string'&&sample.source.length>0;
const nearly=(a:number,b:number)=>Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));

/** Describe a frozen, forward-observed paper exit. This never selects a new policy or invents a fill. */
export function exitQuality(input:ExitQualityInput):ExitQuality {
  const result:ExitQuality={version:'exit-quality-v1',asOf:input.asOf,mode:'shadow',execution:'observation_only',costsIncluded:false,
    basis:'initial_principal_pct',status:input.returns.status,policyVersion:input.policyVersion,
    equityPeak:{status:'unknown',samples:input.preExitSamples.length,sampleLimit:EXIT_QUALITY_SAMPLE_LIMIT,scope:'retained_pre_exit_samples_only'},
    afterExit:[],comparisonWindowSec:EXIT_QUALITY_WINDOW_SEC};
  const returns=input.returns,asOf=time(input.asOf),closedAt=time(returns.closedAt),baselineAt=time(input.baselineAt);
  const final=returns.exits.at(-1);
  if(returns.status!=='closed'||!finite(asOf)||!finite(closedAt)||closedAt>asOf||!finite(returns.finalGainPct)||
    !finite(baselineAt)||!finite(input.baselinePriceUsd)||input.baselinePriceUsd<=0||final?.kind!=='full_exit'){
    const open=returns.status==='open';result.status=open?'open':'unavailable';result.reason=open?'POSITION_OPEN':returns.reason??'RETURN_HISTORY_INVALID';
    result.equityPeak.reason=result.reason;
    result.afterExit=EXIT_QUALITY_HORIZONS.map(minutes=>({minutes,status:open?'open':'return_unavailable'}));return result;
  }
  result.finalGainPct=returns.finalGainPct;result.closedAt=returns.closedAt;
  const exit=input.exitSample,exitValid=!!exit&&valid(exit)&&time(exit.at)===closedAt&&exit.priceUsd===final.priceUsd;
  const samples=input.preExitSamples;
  let peakError:string|undefined;
  if(input.preExitTruncated||samples.length>EXIT_QUALITY_SAMPLE_LIMIT)peakError='PRE_EXIT_SAMPLE_LIMIT';
  else if(!exitValid)peakError='EXIT_SAMPLE_UNAVAILABLE';
  else if(!exit.pool||samples.some(sample=>!sample.pool))peakError='POOL_PROVENANCE_UNKNOWN';
  else if(samples.some(sample=>sample.pool!==exit.pool))peakError='POOL_PROVENANCE_MISMATCH';
  else if(!samples.length||time(samples[0].at)!==baselineAt||samples[0].priceUsd!==input.baselinePriceUsd||time(samples.at(-1)!.at)!==closedAt)peakError='PRE_EXIT_HISTORY_INCOMPLETE';
  else {
    let realized=0,remaining=100,eventIndex=0,previousAt=baselineAt,peak=0,peakAt=input.baselineAt,maxGapSec=0;
    for(const sample of samples){
      const at=time(sample.at);
      if(!valid(sample)||at<previousAt||at<baselineAt||at>closedAt){peakError='PRE_EXIT_HISTORY_INVALID';break;}
      maxGapSec=Math.max(maxGapSec,(at-previousAt)/1000);previousAt=at;
      while(eventIndex<returns.exits.length&&time(returns.exits[eventIndex].at)<=at){
        const event=returns.exits[eventIndex++];
        // Every exit must have its own actual sample. A missing event timestamp
        // cannot silently be assigned to a later, more convenient price.
        if(time(event.at)!==at||event.priceUsd!==sample.priceUsd){peakError='PRE_EXIT_HISTORY_INCOMPLETE';break;}
        realized+=event.contributionGainPct;remaining=event.remainingPctOfInitial;
      }
      if(peakError)break;
      const equity=realized+remaining*(sample.priceUsd/input.baselinePriceUsd-1);
      if(!finite(equity)){peakError='RETURN_ARITHMETIC_INVALID';break;}
      if(equity>peak){peak=equity;peakAt=sample.at;}
    }
    if(!peakError&&(eventIndex!==returns.exits.length||remaining!==0||!nearly(realized,returns.finalGainPct)))peakError='PRE_EXIT_HISTORY_INCOMPLETE';
    if(!peakError)result.equityPeak={...result.equityPeak,status:'valid',gainPct:peak,at:peakAt,givebackPct:Math.max(0,peak-returns.finalGainPct),maxGapSec};
  }
  if(peakError)result.equityPeak.reason=peakError;
  result.afterExit=EXIT_QUALITY_HORIZONS.map(minutes=>{
    const due=closedAt+minutes*60_000,end=due+EXIT_QUALITY_WINDOW_SEC*1000;
    const row:ExitQualityComparison={minutes,dueAt:new Date(due).toISOString(),windowEndsAt:new Date(end).toISOString(),status:'not_due'};
    if(asOf<due)return row;
    if(!exitValid)return {...row,status:'invalid_sample'};
    if(!exit.pool)return {...row,status:'provenance_unknown'};
    const bucket=input.comparisonSamples[minutes]??{samples:[],truncated:false};
    // Select in observed time order, never highest price in the window.
    const candidates=bucket.samples.filter(sample=>time(sample.at)>=due&&time(sample.at)<=Math.min(end,asOf))
      .slice().sort((a,b)=>time(a.at)-time(b.at));
    const match=candidates.find(sample=>valid(sample)&&sample.source===exit.source&&sample.pool===exit.pool);
    if(!match){
      if(asOf<end&&!bucket.truncated)return {...row,status:'awaiting_sample'};
      const status:ExitQualityComparisonStatus=bucket.truncated?'sample_limit':candidates.some(sample=>!valid(sample))?'invalid_sample':
        candidates.some(sample=>!sample.pool)?'provenance_unknown':candidates.length?'provenance_mismatch':'missing_price';
      return {...row,status};
    }
    const move=(match.priceUsd/final.priceUsd-1)*100;
    const impact=final.soldPctOfInitial*(match.priceUsd-final.priceUsd)/input.baselinePriceUsd;
    if(!finite(move)||!finite(impact))return {...row,status:'invalid_sample'};
    return {...row,status:'valid',sampleAt:match.at,lateSec:(time(match.at)-due)/1000,source:match.source,pool:match.pool,
      priceUsd:match.priceUsd,tokenMovePct:move,impactOnInitialPrincipalPct:impact,
      direction:Math.abs(move)<1e-9?'flat':move>0?'continued_up':'avoided_drawdown'};
  });
  return result;
}

/** The caller states its population bounds. Unknown prices never enter a success denominator. */
export function summarizeExitQuality(items:readonly ExitQuality[]) {
  const final=items.filter(item=>item.status==='closed'&&finite(item.finalGainPct));
  const peaks=items.filter(item=>item.equityPeak.status==='valid');
  const mean=(numbers:number[])=>numbers.length?numbers.reduce((sum,n)=>sum+n/numbers.length,0):undefined;
  return {positions:items.length,closed:final.length,open:items.filter(item=>item.status==='open').length,
    unavailable:items.filter(item=>item.status==='unavailable').length,
    finalReturn:{denominator:final.length,meanGainPct:mean(final.map(item=>item.finalGainPct!)),profitable:final.filter(item=>item.finalGainPct!>0).length},
    equityGiveback:{denominator:peaks.length,unknown:items.length-peaks.length,meanGivebackPct:mean(peaks.map(item=>item.equityPeak.givebackPct!))},
    afterExit:EXIT_QUALITY_HORIZONS.map(minutes=>{
      const rows=items.map(item=>item.afterExit.find(row=>row.minutes===minutes)!),valid=rows.filter(row=>row.status==='valid');
      const statuses:Record<ExitQualityComparisonStatus,number>={valid:0,open:0,return_unavailable:0,not_due:0,awaiting_sample:0,missing_price:0,provenance_unknown:0,provenance_mismatch:0,sample_limit:0,invalid_sample:0};
      for(const row of rows)statuses[row.status]++;
      return {minutes,denominator:valid.length,statuses,continuedUp:valid.filter(row=>row.direction==='continued_up').length,
        avoidedDrawdown:valid.filter(row=>row.direction==='avoided_drawdown').length,flat:valid.filter(row=>row.direction==='flat').length,
        meanImpactOnInitialPrincipalPct:mean(valid.map(row=>row.impactOnInitialPrincipalPct!))};
    })};
}

interface QualityPositionRow {
  id:string;chain:Chain;address:string;symbol:string|null;state:string;last_price:number;last_price_at:string;error:string|null;
}
function readSample(row:Record<string,unknown>):ExitQualitySample {
  return {at:String(row.at),priceUsd:Number(row.price),source:String(row.source),pool:typeof row.pool==='string'?row.pool:undefined};
}
const sampleColumns="at,price,source,COALESCE(json_extract(context,'$.poolAddress'),json_extract(context,'$.priceEvidence.pool')) AS pool";

/** Indexed per-position reads only; used by the on-demand detail and independent daily worker. */
export function readPositionExitQuality(db:DatabaseSync,row:QualityPositionRow,asOf:string,knownReturns?:ShadowReturn):ExitQuality {
  const state=JSON.parse(row.state) as AdaptiveExitState;
  const exits=knownReturns?[]:db.prepare("SELECT data FROM exit_shadow_events WHERE position_id=? AND json_extract(data,'$.kind') IN ('partial_exit','full_exit') ORDER BY id LIMIT 33")
    .all(row.id).map(event=>JSON.parse(String(event.data)));
  const returns=knownReturns??shadowReturn(state,exits,{priceUsd:row.last_price,at:row.last_price_at,health:row.error?'unavailable':'fresh'});
  const input:ExitQualityInput={asOf,policyVersion:state.policyVersion,baselineAt:state.baselineAt,baselinePriceUsd:state.baselinePriceUsd,
    returns,preExitSamples:[],preExitTruncated:false,comparisonSamples:{}};
  if(returns.status!=='closed'||!returns.closedAt||time(returns.closedAt)>time(asOf))return exitQuality(input);
  // Read a bounded index range; the 2001st row proves truncation without a
  // COUNT over a long-lived position. No unbounded wide-row materialization.
  const rows=db.prepare(`SELECT ${sampleColumns} FROM exit_shadow_samples WHERE position_id=? AND at<=? ORDER BY at LIMIT ?`)
    .all(row.id,returns.closedAt,EXIT_QUALITY_SAMPLE_LIMIT+1);
  input.preExitTruncated=rows.length>EXIT_QUALITY_SAMPLE_LIMIT;
  input.preExitSamples=rows.slice(0,EXIT_QUALITY_SAMPLE_LIMIT).map(readSample);
  const exit=db.prepare(`SELECT ${sampleColumns} FROM exit_shadow_samples WHERE position_id=? AND at=?`).get(row.id,returns.closedAt);
  if(exit)input.exitSample=readSample(exit);
  const buckets:Record<number,{samples:ExitQualitySample[];truncated:boolean}>={};
  for(const minutes of EXIT_QUALITY_HORIZONS){
    const due=time(returns.closedAt)+minutes*60_000,end=Math.min(time(asOf),due+EXIT_QUALITY_WINDOW_SEC*1000);
    if(end<due)continue;
    const samples=db.prepare(`SELECT ${sampleColumns} FROM exit_shadow_samples WHERE position_id=? AND at>=? AND at<=? ORDER BY at LIMIT 201`)
      .all(row.id,new Date(due).toISOString(),new Date(end).toISOString());
    buckets[minutes]={samples:samples.slice(0,200).map(readSample),truncated:samples.length>200};
  }
  input.comparisonSamples=buckets;return exitQuality(input);
}

export interface ExitQualityReviewOptions {asOf:string;sinceAt:string;limit?:number;}
/** Read-only snapshot of exits in an explicit window, for a persisted daily report. No network or policy writes. */
export function readExitQualityReview(path:string,options:ExitQualityReviewOptions) {
  const asOf=time(options.asOf),since=time(options.sinceAt),limit=options.limit??1000;
  if(!finite(asOf)||!finite(since)||since>asOf||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error('EXIT_QUALITY_REVIEW_OPTIONS_INVALID');
  const end=new Date(asOf).toISOString(),start=new Date(since).toISOString(),db=new DatabaseSync(path,{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500; BEGIN');
    const where="phase='triggered' AND json_extract(state,'$.lastObservedAt')>=? AND json_extract(state,'$.lastObservedAt')<=?";
    // Existing databases can be read before the next service restart creates
    // the new index; upgraded stores use its narrow closure-time range.
    const index=db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='exit_shadow_quality_closed_at'").get()?'INDEXED BY exit_shadow_quality_closed_at':'';
    const total=Number(db.prepare(`SELECT count(*) AS n FROM exit_shadow_positions ${index} WHERE ${where}`).get(start,end)!.n);
    const rows=db.prepare(`SELECT id,chain,address,symbol,state,last_price,last_price_at,error FROM exit_shadow_positions ${index} WHERE ${where}
      ORDER BY json_extract(state,'$.lastObservedAt') DESC,id LIMIT ?`).all(start,end,limit) as unknown as QualityPositionRow[];
    const items=rows.map(row=>({id:row.id,chain:row.chain,address:row.address,symbol:row.symbol??undefined,
      quality:readPositionExitQuality(db,row,end)}));
    const summary=summarizeExitQuality(items.map(item=>item.quality));
    const byPolicy=Array.from(new Set(items.map(item=>item.quality.policyVersion))).sort().map(policyVersion=>({policyVersion,
      summary:summarizeExitQuality(items.filter(item=>item.quality.policyVersion===policyVersion).map(item=>item.quality))}));
    const cases=items.slice().sort((a,b)=>(b.quality.equityPeak.givebackPct??-Infinity)-(a.quality.equityPeak.givebackPct??-Infinity)||
      (b.quality.afterExit.find(row=>row.minutes===15)?.impactOnInitialPrincipalPct??-Infinity)-(a.quality.afterExit.find(row=>row.minutes===15)?.impactOnInitialPrincipalPct??-Infinity)||a.id.localeCompare(b.id))
      .slice(0,10).map(item=>({...item,policyVersion:item.quality.policyVersion}));
    const historyComplete=db.prepare("SELECT value FROM exit_shadow_meta WHERE key='history_complete'").get()?.value==='true';
    db.exec('COMMIT');
    return {version:'exit-quality-review-v1' as const,asOf:end,sinceAt:start,scope:'closed_shadow_positions' as const,
      total,reviewed:items.length,limit,truncated:total>items.length,historyComplete,
      summaryBasis:'equal_weight_per_position_gross_simulation' as const,summary,byPolicy,cases};
  }finally {db.close();}
}

export type ExitQualityReview=ReturnType<typeof readExitQualityReview>;
