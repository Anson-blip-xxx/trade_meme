/** Supplier retrospective display statistics. These are never entry prices, local peaks or fills. */
export interface VendorSignalPerformance {
  provider:'debot'|'ave';reportedAt:string;scope:'vendor_reported_retrospective';
  maxGainRaw?:string;maxGainValue?:number;maxGainUnit?:'fractional_return'|'provider_display_ratio';
  maxGainPct?:number;maxGainDisplay?:string;
  firstSignalAt?:string;firstPriceUsd?:number;maxPriceUsd?:number;dayHighPriceUsd?:number;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function numeric(v:unknown,zero=false):number|undefined {
  if(typeof v!=='number'&&(typeof v!=='string'||v.length>100||!/^\d+(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(v)))return;
  const value=Number(v);return Number.isFinite(value)&&(zero?value>=0:value>0)&&value<=Number.MAX_SAFE_INTEGER?value:undefined;
}
function firstTime(v:unknown,observedAt:Date):string|undefined {
  const value=numeric(v);return value!==undefined&&Number.isSafeInteger(value)&&value<=9_999_999_999&&value*1000<=observedAt.getTime()
    ?new Date(value*1000).toISOString():undefined;
}
const display=(value:number)=>String(Number(value.toFixed(2)));

/** DeBot meta.signals: live 2026-10-16 responses confirm max_price_gain =
 * max(0, max_price / first_price - 1). The unit is fractional return, not price multiple.
 * Vendor windows may predate local receipt; no historical value is backfilled as a local sample.
 */
export function normalizeDebotPerformance(raw:unknown,observedAt:Date):VendorSignalPerformance|undefined {
  if(!object(raw)||!Number.isFinite(observedAt.getTime()))return;
  const gain=numeric(raw.max_price_gain,true),first=firstTime(raw.first_time,observedAt);
  const firstPrice=numeric(raw.first_price),maxPrice=numeric(raw.max_price);
  if(gain===undefined&&maxPrice===undefined)return;
  return {provider:'debot',reportedAt:observedAt.toISOString(),scope:'vendor_reported_retrospective',
    ...(gain!==undefined?{maxGainRaw:String(raw.max_price_gain),maxGainValue:gain,maxGainUnit:'fractional_return' as const,
      maxGainPct:gain*100,maxGainDisplay:`${display(gain*100)}%`}:{}),
    ...(first?{firstSignalAt:first}:{}),...(firstPrice!==undefined?{firstPriceUsd:firstPrice}:{}),...(maxPrice!==undefined?{maxPriceUsd:maxPrice}:{})};
}

/** Ave's official smart-card UI renders raw>=1 through formatMultiple(raw),
 * otherwise formatPercent(raw*100). Preserve that display unit without claiming
 * that a displayed 3x equals a 200% or 300% investment return.
 * day_high_price is a vendor daily high, not a locally observed post-signal peak.
 */
export function normalizeAvePerformance(raw:unknown,observedAt:Date):VendorSignalPerformance|undefined {
  if(!object(raw)||!Number.isFinite(observedAt.getTime()))return;
  const gain=numeric(raw.max_price_change,true),high=numeric(raw.day_high_price),first=firstTime(raw.first_signal_time,observedAt);
  if(gain===undefined&&high===undefined)return;
  return {provider:'ave',reportedAt:observedAt.toISOString(),scope:'vendor_reported_retrospective',
    ...(gain!==undefined?{maxGainRaw:String(raw.max_price_change),maxGainValue:gain,maxGainUnit:'provider_display_ratio' as const,
      maxGainDisplay:gain>=1?`${display(gain)}x`:`${display(gain*100)}%`}:{}),
    ...(first?{firstSignalAt:first}:{}),...(high!==undefined?{dayHighPriceUsd:high}:{})};
}
