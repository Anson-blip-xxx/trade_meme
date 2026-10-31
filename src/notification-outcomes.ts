import type {Chain,Signal} from './types.js';
import type {ReviewNotification,ReviewPrice} from './daily-review.js';

type Source=Signal['source'];

export type NotificationOutcomeUnknownReason=
  'TRIGGER_ORDER_AMBIGUOUS'|
  'NO_FIXED_POOL_BASELINE'|
  'FIXED_POOL_AMBIGUOUS'|
  'BASELINE_TOO_LATE'|
  'PRICE_CONFLICT_IN_FIXED_POOL'|
  'NO_POST_BASELINE_SAMPLE';

export interface NotificationOutcomeOptions {
  asOf:string;
  notificationNumbers?:readonly number[];
  horizonsSec?:readonly number[];
  sessionGapSec?:number;
  maxBaselineDelaySec?:number;
  denseMaxGapSec?:number;
  priceConflictTolerancePct?:number;
}

export interface NotificationOutcomeCoverage {
  samples:number;
  baselineDelaySec:number;
  firstSampleAt:string;
  lastSampleAt:string;
  firstPostBaselineDelaySec?:number;
  trailingGapSec:number;
  maxGapSecIncludingEdges:number;
  observedSpanPct:number;
  dense:boolean;
}

export interface NotificationHorizonOutcome {
  seconds:number;
  endsAt:string;
  mature:boolean;
  status:'immature'|'covered'|'unknown';
  unknownReason?:NotificationOutcomeUnknownReason;
  pool?:string;
  baselineAt?:string;
  baselinePriceUsd?:number;
  coverage?:NotificationOutcomeCoverage;
  maxGainPct?:number;
  peakAt?:string;
  minGainPct?:number;
  troughAt?:string;
  endGainPct?:number;
  /** Largest sampled peak-to-subsequent-trough decline, not loss from baseline. */
  maxDrawdownPct?:number;
  firstDoubleAt?:string;
  firstStopAt?:string;
  sampledBarrierOrder?:'double_first'|'stop_first'|'neither'|'unknown';
}

export interface NotificationTriggerOutcome {
  source:Source;
  chain:Chain;
  address:string;
  sessionFirstReceivedAt:string;
  sessionExpiresAt:string;
  notificationNumber:number;
  triggerEventId:string;
  triggerAt:string;
  triggerOrderAmbiguous:boolean;
  horizons:NotificationHorizonOutcome[];
}

interface TimedNotification extends ReviewNotification {atMs:number;}
interface TimedPrice extends ReviewPrice {atMs:number;pool:string;}
interface FixedPoolPath {pool:string;baselineAtMs:number;baselinePrice:number;points:Array<{atMs:number;price:number}>;conflicts:Set<number>;}

const DEFAULT_HORIZONS=[3600,21600,86400] as const;
const DEFAULT_NOTIFICATION_NUMBERS=[2,3,4] as const;
const DEFAULT_SESSION_GAP_SEC=21600;
const DEFAULT_BASELINE_DELAY_SEC=600;
const DEFAULT_DENSE_GAP_SEC=600;
const DEFAULT_CONFLICT_TOLERANCE_PCT=5;

const finiteTime=(value:string):number|undefined=>{
  const ms=Date.parse(value);return Number.isFinite(ms)?ms:undefined;
};
const normalizedAddress=(chain:Chain,address:string)=>chain==='solana'?address:address.toLowerCase();
const tokenKey=(chain:Chain,address:string)=>`${chain}:${normalizedAddress(chain,address)}`;
const groupKey=(source:Source,chain:Chain,address:string)=>`${source}:${tokenKey(chain,address)}`;
const iso=(ms:number)=>new Date(ms).toISOString();
const median=(values:number[])=>{
  const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
};
const positiveIntegers=(values:readonly number[],maximum:number)=>[...new Set(values)]
  .filter(value=>Number.isSafeInteger(value)&&value>0&&value<=maximum).sort((a,b)=>a-b);

function notificationsByGroup(rows:readonly ReviewNotification[],asOfMs:number):Map<string,TimedNotification[]> {
  const grouped=new Map<string,TimedNotification[]>(),seen=new Set<string>();
  for(const row of rows) {
    const atMs=finiteTime(row.receivedAt);
    if(atMs===undefined||atMs>asOfMs||!row.id||!row.address)continue;
    const id=`${row.source}:${row.chain}:${normalizedAddress(row.chain,row.address)}:${row.id}`;
    if(seen.has(id))continue;seen.add(id);
    const key=groupKey(row.source,row.chain,row.address),values=grouped.get(key)??[];
    values.push({...row,address:normalizedAddress(row.chain,row.address),receivedAt:iso(atMs),atMs});grouped.set(key,values);
  }
  for(const values of grouped.values())values.sort((a,b)=>a.atMs-b.atMs||a.id.localeCompare(b.id));
  return grouped;
}

function pricesByToken(rows:readonly ReviewPrice[],asOfMs:number):Map<string,TimedPrice[]> {
  const grouped=new Map<string,TimedPrice[]>();
  for(const row of rows) {
    const atMs=finiteTime(row.at),rawPool=row.pool?.trim(),pool=rawPool?normalizedAddress(row.chain,rawPool):undefined;
    if(atMs===undefined||atMs>asOfMs||!pool||!Number.isFinite(row.price)||row.price<=0||!row.address)continue;
    const key=tokenKey(row.chain,row.address),values=grouped.get(key)??[];
    values.push({...row,address:normalizedAddress(row.chain,row.address),at:iso(atMs),pool,atMs});grouped.set(key,values);
  }
  for(const values of grouped.values())values.sort((a,b)=>a.atMs-b.atMs||a.pool.localeCompare(b.pool)||a.source.localeCompare(b.source));
  return grouped;
}

function fixedPoolPath(prices:readonly TimedPrice[],triggerAtMs:number,maxEndMs:number,maxBaselineDelayMs:number,tolerancePct:number):FixedPoolPath|NotificationOutcomeUnknownReason {
  const candidates=prices.filter(point=>point.atMs>=triggerAtMs&&point.atMs<=maxEndMs);
  if(!candidates.length)return 'NO_FIXED_POOL_BASELINE';
  const firstAt=candidates[0].atMs,firstPools=[...new Set(candidates.filter(point=>point.atMs===firstAt).map(point=>point.pool))];
  if(firstAt-triggerAtMs>maxBaselineDelayMs)return 'BASELINE_TOO_LATE';
  if(firstPools.length!==1)return 'FIXED_POOL_AMBIGUOUS';
  const pool=firstPools[0],byTime=new Map<number,number[]>();
  for(const point of prices)if(point.pool===pool&&point.atMs>=firstAt&&point.atMs<=maxEndMs){
    const values=byTime.get(point.atMs)??[];values.push(point.price);byTime.set(point.atMs,values);
  }
  const points:Array<{atMs:number;price:number}>=[],conflicts=new Set<number>();
  for(const [atMs,values] of [...byTime].sort((a,b)=>a[0]-b[0])) {
    const low=Math.min(...values),high=Math.max(...values);
    if((high/low-1)*100>tolerancePct){conflicts.add(atMs);continue;}
    points.push({atMs,price:median(values)});
  }
  const baseline=points.find(point=>point.atMs===firstAt);
  if(!baseline)return 'PRICE_CONFLICT_IN_FIXED_POOL';
  if(baseline.atMs-triggerAtMs>maxBaselineDelayMs)return 'BASELINE_TOO_LATE';
  return {pool,baselineAtMs:baseline.atMs,baselinePrice:baseline.price,points,conflicts};
}

function unknownHorizon(seconds:number,endsAtMs:number,mature:boolean,reason:NotificationOutcomeUnknownReason,pool?:string):NotificationHorizonOutcome {
  return {seconds,endsAt:iso(endsAtMs),mature,status:mature?'unknown':'immature',unknownReason:reason,...(pool?{pool}:{})};
}

function evaluateHorizon(path:FixedPoolPath|NotificationOutcomeUnknownReason,triggerAtMs:number,seconds:number,asOfMs:number,denseMaxGapSec:number):NotificationHorizonOutcome {
  const endsAtMs=triggerAtMs+seconds*1000,mature=asOfMs>=endsAtMs;
  if(typeof path==='string')return unknownHorizon(seconds,endsAtMs,mature,path);
  if(!mature)return {seconds,endsAt:iso(endsAtMs),mature:false,status:'immature',pool:path.pool,
    baselineAt:iso(path.baselineAtMs),baselinePriceUsd:path.baselinePrice};
  if([...path.conflicts].some(atMs=>atMs>=path.baselineAtMs&&atMs<=endsAtMs))
    return unknownHorizon(seconds,endsAtMs,true,'PRICE_CONFLICT_IN_FIXED_POOL',path.pool);
  const points=path.points.filter(point=>point.atMs>=path.baselineAtMs&&point.atMs<=endsAtMs);
  if(points.length<2)return unknownHorizon(seconds,endsAtMs,true,'NO_POST_BASELINE_SAMPLE',path.pool);
  const baseline=path.baselinePrice,stamps=[triggerAtMs,...points.map(point=>point.atMs),endsAtMs].sort((a,b)=>a-b);
  let peak=baseline,peakAt=path.baselineAtMs,trough=baseline,troughAt=path.baselineAtMs,maxGainPct=0,minGainPct=0,maxDrawdownPct=0,firstDoubleAt:number|undefined,firstStopAt:number|undefined;
  for(const point of points) {
    if(point.price>peak){peak=point.price;peakAt=point.atMs;}
    if(point.price<trough){trough=point.price;troughAt=point.atMs;}
    maxGainPct=Math.max(maxGainPct,(point.price/baseline-1)*100);
    minGainPct=Math.min(minGainPct,(point.price/baseline-1)*100);
    maxDrawdownPct=Math.max(maxDrawdownPct,(1-point.price/peak)*100);
    if(firstDoubleAt===undefined&&point.price>=baseline*2)firstDoubleAt=point.atMs;
    if(firstStopAt===undefined&&point.price<=baseline*.4)firstStopAt=point.atMs;
  }
  const gaps=stamps.slice(1).map((stamp,index)=>(stamp-stamps[index])/1000),maxGapSecIncludingEdges=Math.max(...gaps);
  const last=points.at(-1)!,span=Math.max(0,last.atMs-path.baselineAtMs),horizonMs=seconds*1000;
  const sampledBarrierOrder=firstDoubleAt===undefined&&firstStopAt===undefined?'neither':
    firstStopAt===undefined||firstDoubleAt!==undefined&&firstDoubleAt<firstStopAt?'double_first':'stop_first';
  return {seconds,endsAt:iso(endsAtMs),mature:true,status:'covered',pool:path.pool,baselineAt:iso(path.baselineAtMs),baselinePriceUsd:baseline,
    coverage:{samples:points.length,baselineDelaySec:(path.baselineAtMs-triggerAtMs)/1000,firstSampleAt:iso(points[0].atMs),lastSampleAt:iso(last.atMs),
      firstPostBaselineDelaySec:(points[1].atMs-path.baselineAtMs)/1000,trailingGapSec:(endsAtMs-last.atMs)/1000,
      maxGapSecIncludingEdges,observedSpanPct:Math.min(100,span/horizonMs*100),dense:maxGapSecIncludingEdges<=denseMaxGapSec},
    maxGainPct,peakAt:iso(peakAt),minGainPct,troughAt:iso(troughAt),endGainPct:(last.price/baseline-1)*100,maxDrawdownPct,
    firstDoubleAt:firstDoubleAt===undefined?undefined:iso(firstDoubleAt),
    firstStopAt:firstStopAt===undefined?undefined:iso(firstStopAt),sampledBarrierOrder};
}

/**
 * Pure retrospective calculation. It never authorizes an entry and never
 * substitutes another pool after the first retained post-trigger quote fixes one.
 */
export function buildNotificationOutcomes(notifications:readonly ReviewNotification[],prices:readonly ReviewPrice[],options:NotificationOutcomeOptions):NotificationTriggerOutcome[] {
  const asOfMs=finiteTime(options.asOf);if(asOfMs===undefined)throw new Error('NOTIFICATION_OUTCOME_AS_OF_INVALID');
  const numbers=positiveIntegers(options.notificationNumbers??DEFAULT_NOTIFICATION_NUMBERS,1000);
  const horizons=positiveIntegers(options.horizonsSec??DEFAULT_HORIZONS,7*86400);
  if(!numbers.length||!horizons.length)throw new Error('NOTIFICATION_OUTCOME_RANGE_INVALID');
  const sessionGapSec=options.sessionGapSec??DEFAULT_SESSION_GAP_SEC,maxBaselineDelaySec=options.maxBaselineDelaySec??DEFAULT_BASELINE_DELAY_SEC;
  const denseMaxGapSec=options.denseMaxGapSec??DEFAULT_DENSE_GAP_SEC,tolerancePct=options.priceConflictTolerancePct??DEFAULT_CONFLICT_TOLERANCE_PCT;
  if(![sessionGapSec,maxBaselineDelaySec,denseMaxGapSec].every(value=>Number.isFinite(value)&&value>=0)||
    !Number.isFinite(tolerancePct)||tolerancePct<0||tolerancePct>100)throw new Error('NOTIFICATION_OUTCOME_OPTIONS_INVALID');
  const grouped=notificationsByGroup(notifications,asOfMs),byToken=pricesByToken(prices,asOfMs),results:NotificationTriggerOutcome[]=[];
  for(const events of grouped.values()) {
    const sessions:TimedNotification[][]=[];
    for(const event of events) {
      const current=sessions.at(-1),previous=current?.at(-1);
      if(!current||!previous||event.atMs-previous.atMs>=sessionGapSec*1000)sessions.push([event]);else current.push(event);
    }
    for(const session of sessions)for(const notificationNumber of numbers) {
      const trigger=session[notificationNumber-1];if(!trigger)continue;
      const triggerOrderAmbiguous=session.some((event,index)=>event.atMs===trigger.atMs&&index!==notificationNumber-1);
      const maxEndMs=trigger.atMs+Math.max(...horizons)*1000;
      const path=triggerOrderAmbiguous?'TRIGGER_ORDER_AMBIGUOUS' as const:fixedPoolPath(byToken.get(tokenKey(trigger.chain,trigger.address))??[],trigger.atMs,maxEndMs,maxBaselineDelaySec*1000,tolerancePct);
      results.push({source:trigger.source,chain:trigger.chain,address:trigger.address,sessionFirstReceivedAt:session[0].receivedAt,
        sessionExpiresAt:iso(session.at(-1)!.atMs+sessionGapSec*1000),notificationNumber,triggerEventId:trigger.id,triggerAt:trigger.receivedAt,
        triggerOrderAmbiguous,horizons:horizons.map(seconds=>evaluateHorizon(path,trigger.atMs,seconds,asOfMs,denseMaxGapSec))});
    }
  }
  return results.sort((a,b)=>a.triggerAt.localeCompare(b.triggerAt)||a.source.localeCompare(b.source)||a.chain.localeCompare(b.chain)||a.address.localeCompare(b.address)||a.notificationNumber-b.notificationNumber);
}
