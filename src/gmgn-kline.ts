import {normalizePriceToken} from './market-price-normalizers.js';
import type {ScanToken} from './scan-archive.js';

export type GmgnKlineResolution='30s'|'1m'|'5m'|'15m'|'1h'|'4h'|'1d';

export const GMGN_KLINE_RESOLUTION_MS:Readonly<Record<GmgnKlineResolution,number>>={
  '30s':30_000,'1m':60_000,'5m':300_000,'15m':900_000,'1h':3_600_000,'4h':14_400_000,'1d':86_400_000,
};

export interface GmgnKlineRequest {
  token:ScanToken;resolution:GmgnKlineResolution;
  /** Requested historical interval. Both ends are knowledge cutoffs, not trade times. */
  fromAt:string;untilAt:string;receivedAt:string;
}

export interface GmgnKlineCandle {
  openAt:string;closeAt:string;open:number;high:number;low:number;close:number;
  /** GMGN's public docs and live payload disagree on these meanings. Retain
   * the two validated values without assigning USD/base-token semantics. */
  reportedVolume?:number;reportedAmount?:number;
}

export interface GmgnKlineWindow {
  token:ScanToken;resolution:GmgnKlineResolution;fromAt:string;untilAt:string;receivedAt:string;
  candles:GmgnKlineCandle[];
  coverage:{firstOpenAt?:string;lastCloseAt?:string;maxGapSec?:number;leadingGapSec:number;trailingGapSec:number;dense:boolean};
  diagnostics:{inputRows:number;invalidRows:number;outsideRows:number;openRows:number;duplicateRows:number;conflictRows:number};
}

export type GmgnKlineBarrierOrder='target_first'|'stop_first'|'same_candle_ambiguous'|'neither'|'unknown';
export interface GmgnKlineBarrierResult {
  order:GmgnKlineBarrierOrder;baselinePrice:number;targetPrice:number;stopPrice:number;
  fromAt:string;untilAt:string;candles:number;denseUntilDecision:boolean;
  observedAt?:string;reason?:'NO_CLOSED_CANDLES'|'COVERAGE_GAP'|'DUPLICATE_CANDLE_CONFLICT';
}

export interface GmgnKlineMomentum {
  asOf:string;candles:number;fromAt:string;untilAt:string;changePct:number;
  drawdownFromHighPct:number;meanRangePct:number;dense:boolean;
}

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const iso=(value:unknown):number|undefined=>{
  if(typeof value!=='string'||value.length>40||!/^\d{4}-\d\d-\d\dT/.test(value))return;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:undefined;
};
const decimal=(value:unknown,positive=true):number|undefined=>{
  if(typeof value!=='string'||value.length>128||!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(value))return;
  const parsed=Number(value);return Number.isFinite(parsed)&&(positive?parsed>0:parsed>=0)?parsed:undefined;
};
const epochMs=(value:unknown):number|undefined=>{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)return;
  // The current OpenAPI payload is milliseconds, while two official GMGN
  // documents still describe seconds. Accept only those two bounded forms.
  const parsed=value<100_000_000_000?value*1_000:value;
  return Number.isSafeInteger(parsed)&&parsed>=946_684_800_000&&parsed<=8_640_000_000_000_000?parsed:undefined;
};
const same=(a:GmgnKlineCandle,b:GmgnKlineCandle)=>a.open===b.open&&a.high===b.high&&a.low===b.low&&a.close===b.close&&
  a.reportedVolume===b.reportedVolume&&a.reportedAmount===b.reportedAmount;

/**
 * Normalize only fully closed candles whose entire interval is inside the
 * requested historical window and was knowable when the response arrived.
 * This function deliberately does not turn a candle close into a live quote.
 */
export function normalizeGmgnKline(raw:unknown,request:GmgnKlineRequest):GmgnKlineWindow {
  const token=normalizePriceToken(request.token),from=iso(request.fromAt),until=iso(request.untilAt),received=iso(request.receivedAt);
  const duration=GMGN_KLINE_RESOLUTION_MS[request.resolution];
  if(!token||from===undefined||until===undefined||received===undefined||from>=until||until>received||!duration)
    throw new Error('GMGN_KLINE_REQUEST_INVALID');
  if(!object(raw)||!Array.isArray(raw.list)||raw.list.length>5_000)throw new Error('GMGN_KLINE_RESPONSE_INVALID');
  const diagnostics:GmgnKlineWindow['diagnostics']={inputRows:raw.list.length,invalidRows:0,outsideRows:0,openRows:0,
    duplicateRows:0,conflictRows:0};
  const byTime=new Map<number,GmgnKlineCandle>(),conflicted=new Set<number>();
  const knowledgeCutoff=Math.min(until,received);
  for(const value of raw.list) {
    if(!object(value)){diagnostics.invalidRows++;continue;}
    const openAt=epochMs(value.time),open=decimal(value.open),high=decimal(value.high),low=decimal(value.low),close=decimal(value.close);
    if(openAt===undefined||open===undefined||high===undefined||low===undefined||close===undefined||
      high<Math.max(open,close,low)||low>Math.min(open,close,high)) {diagnostics.invalidRows++;continue;}
    const closeAt=openAt+duration;
    if(closeAt<=from||openAt>=until){diagnostics.outsideRows++;continue;}
    // A candle that began before the event can contain a pre-event extreme;
    // a candle not yet closed at the cutoff can contain a future extreme.
    if(openAt<from||closeAt>knowledgeCutoff){diagnostics.openRows++;continue;}
    const reportedVolume=value.volume===undefined?undefined:decimal(value.volume,false);
    const reportedAmount=value.amount===undefined?undefined:decimal(value.amount,false);
    if(value.volume!==undefined&&reportedVolume===undefined||value.amount!==undefined&&reportedAmount===undefined){
      diagnostics.invalidRows++;continue;
    }
    const candle:GmgnKlineCandle={openAt:new Date(openAt).toISOString(),closeAt:new Date(closeAt).toISOString(),open,high,low,close,
      ...(reportedVolume===undefined?{}:{reportedVolume}),...(reportedAmount===undefined?{}:{reportedAmount})};
    const previous=byTime.get(openAt);
    if(!previous){if(!conflicted.has(openAt))byTime.set(openAt,candle);continue;}
    if(same(previous,candle)){diagnostics.duplicateRows++;continue;}
    diagnostics.conflictRows++;conflicted.add(openAt);byTime.delete(openAt);
  }
  const candles=[...byTime.entries()].sort((a,b)=>a[0]-b[0]).map(([,value])=>value);
  const first=candles[0],last=candles.at(-1);
  const leadingGapSec=first?Math.max(0,(Date.parse(first.openAt)-from)/1_000):(until-from)/1_000;
  const trailingGapSec=last?Math.max(0,(until-Date.parse(last.closeAt))/1_000):(until-from)/1_000;
  let maxGapSec=0;
  for(let index=1;index<candles.length;index++)maxGapSec=Math.max(maxGapSec,
    (Date.parse(candles[index].openAt)-Date.parse(candles[index-1].closeAt))/1_000);
  const resolutionSec=duration/1_000,dense=!!candles.length&&leadingGapSec<=resolutionSec&&trailingGapSec<=resolutionSec&&maxGapSec===0&&diagnostics.conflictRows===0;
  return {token,resolution:request.resolution,fromAt:new Date(from).toISOString(),untilAt:new Date(until).toISOString(),
    receivedAt:new Date(received).toISOString(),candles,coverage:{...(first?{firstOpenAt:first.openAt}:{}),
      ...(last?{lastCloseAt:last.closeAt}:{}),...(candles.length>1?{maxGapSec}:{}),leadingGapSec,trailingGapSec,dense},diagnostics};
}

/** A retrospective barrier order for review only. The baseline must come from
 * an independently observed spot quote. Kline never invents that baseline. */
export function gmgnKlineBarrierOrder(window:GmgnKlineWindow,input:{baselinePrice:number;fromAt:string;untilAt:string;
  targetMultiple?:number;stopMultiple?:number}):GmgnKlineBarrierResult {
  const from=iso(input.fromAt),until=iso(input.untilAt),baseline=input.baselinePrice;
  const targetMultiple=input.targetMultiple??2,stopMultiple=input.stopMultiple??0.4;
  if(from===undefined||until===undefined||from>=until||from<Date.parse(window.fromAt)||until>Date.parse(window.untilAt)||
    !Number.isFinite(baseline)||baseline<=0||!Number.isFinite(targetMultiple)||targetMultiple<=1||
    !Number.isFinite(stopMultiple)||stopMultiple<=0||stopMultiple>=1)throw new Error('GMGN_KLINE_BARRIER_INPUT_INVALID');
  const targetPrice=baseline*targetMultiple,stopPrice=baseline*stopMultiple;
  const candles=window.candles.filter(candle=>Date.parse(candle.openAt)>=from&&Date.parse(candle.closeAt)<=until);
  const base={baselinePrice:baseline,targetPrice,stopPrice,fromAt:new Date(from).toISOString(),untilAt:new Date(until).toISOString(),candles:candles.length};
  if(window.diagnostics.conflictRows)return {...base,order:'unknown',denseUntilDecision:false,reason:'DUPLICATE_CANDLE_CONFLICT'};
  if(!candles.length)return {...base,order:'unknown',denseUntilDecision:false,reason:'NO_CLOSED_CANDLES'};
  const duration=GMGN_KLINE_RESOLUTION_MS[window.resolution];let expected=from,first=true;
  for(const candle of candles) {
    const openAt=Date.parse(candle.openAt);
    // The first fully post-trigger bucket may start less than one resolution
    // after an unaligned trigger. Every later bucket must be contiguous.
    const dense=first?openAt-expected<duration:openAt===expected;
    if(!dense)return {...base,order:'unknown',denseUntilDecision:false,reason:'COVERAGE_GAP'};
    const target=candle.high>=targetPrice,stop=candle.low<=stopPrice;
    if(target&&stop)return {...base,order:'same_candle_ambiguous',denseUntilDecision:true,observedAt:candle.closeAt};
    if(target)return {...base,order:'target_first',denseUntilDecision:true,observedAt:candle.closeAt};
    if(stop)return {...base,order:'stop_first',denseUntilDecision:true,observedAt:candle.closeAt};
    expected=Date.parse(candle.closeAt);first=false;
  }
  if(until-expected>=duration)return {...base,order:'unknown',denseUntilDecision:false,reason:'COVERAGE_GAP'};
  return {...base,order:'neither',denseUntilDecision:true};
}

/** Features available at a decision cutoff. No candle closing after `asOf`
 * participates, making this safe for forward candidate research. */
export function gmgnKlineMomentum(window:GmgnKlineWindow,asOf:string,limit=20):GmgnKlineMomentum|undefined {
  const cutoff=iso(asOf);if(cutoff===undefined||cutoff>Date.parse(window.receivedAt)||!Number.isSafeInteger(limit)||limit<2||limit>200)
    throw new Error('GMGN_KLINE_MOMENTUM_INPUT_INVALID');
  const candles=window.candles.filter(candle=>Date.parse(candle.closeAt)<=cutoff).slice(-limit);if(candles.length<2)return;
  const first=candles[0],last=candles.at(-1)!,high=Math.max(...candles.map(candle=>candle.high));
  const changePct=(last.close/first.open-1)*100,drawdownFromHighPct=(1-last.close/high)*100;
  const meanRangePct=candles.reduce((sum,candle)=>sum+(candle.high-candle.low)/candle.close,0)/candles.length*100;
  if(![changePct,drawdownFromHighPct,meanRangePct].every(Number.isFinite))return;
  let dense=true;const duration=GMGN_KLINE_RESOLUTION_MS[window.resolution];
  for(let index=1;index<candles.length;index++)if(Date.parse(candles[index].openAt)!==Date.parse(candles[index-1].closeAt)){dense=false;break;}
  return {asOf:new Date(cutoff).toISOString(),candles:candles.length,fromAt:first.openAt,untilAt:last.closeAt,
    changePct,drawdownFromHighPct,meanRangePct,dense:dense&&window.diagnostics.conflictRows===0};
}
