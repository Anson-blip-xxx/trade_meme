import {abortable,type Fetcher} from '../http.js';
import {normalizePriceToken} from '../market-price-normalizers.js';
import type {ScanPrice,ScanToken} from '../scan-archive.js';
import {DebotSessionError} from './debot-session.js';

const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export class DebotPriceError extends Error {
  constructor(readonly reason:string,readonly cooldownUntil?:number){super(reason);}
}
/** Current market snapshot, not the price embedded in a signal or its historic maximum.
 * Verified against DeBot's /market/token/info web client and a live response.
 * The endpoint has no market timestamp: observedAt uses HTTP receipt time minus cache Age.
 */
export async function fetchDebotPrice(token:ScanToken,options:{fetcher?:Fetcher;signal?:AbortSignal;now?:()=>Date}={}):Promise<ScanPrice|undefined>{
  const normalized=normalizePriceToken(token);
  if(!normalized)throw new DebotPriceError('PRICE_TOKEN_INVALID');
  const now=options.now??(()=>new Date());
  const startedAt=now().getTime();
  const url=new URL('https://debot.ai/api/market/token/info');
  url.searchParams.set('chain',normalized.chain);url.searchParams.set('token',normalized.address);
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(4000)]):AbortSignal.timeout(4000);
  let response:Response;
  try{response=await abortable((options.fetcher??fetch)(url,{method:'GET',redirect:'error',signal,headers:{accept:'application/json'}}),signal);}
  catch(error){
    if(error instanceof DebotSessionError){
      if(error.reason==='DEBOT_SESSION_RATE_LIMITED')throw new DebotPriceError('DEBOT_PRICE_RATE_LIMITED',error.cooldownUntil);
      if(error.reason==='DEBOT_SESSION_AUTH_REQUIRED')throw new DebotPriceError('DEBOT_PRICE_AUTH_REQUIRED');
      throw new DebotPriceError('DEBOT_PRICE_SESSION_UNAVAILABLE');
    }
    throw error;
  }
  if(!response.ok){
    await response.body?.cancel().catch(()=>{});
    if(response.status===429){
      const raw=response.headers.get('retry-after'),at=now().getTime();
      const delay=raw&&/^\d+$/.test(raw)?Number(raw)*1000:raw?Date.parse(raw)-at:60_000;
      throw new DebotPriceError('DEBOT_PRICE_RATE_LIMITED',at+Math.max(1000,Math.min(3600_000,Number.isFinite(delay)?delay:60_000)));
    }
    throw new DebotPriceError('DEBOT_PRICE_HTTP_ERROR');
  }
  const age=response.headers.get('age');
  if(age!==null&&(!/^\d+$/.test(age)||Number(age)>=30)){
    await response.body?.cancel().catch(()=>{});throw new DebotPriceError('PRICE_STALE');
  }
  if(!response.body)throw new DebotPriceError('DEBOT_PRICE_SCHEMA_INVALID');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const row=await abortable(reader.read(),signal);if(row.done)break;
    size+=row.value.byteLength;if(size>1024*1024)throw new DebotPriceError('DEBOT_PRICE_RESPONSE_TOO_LARGE');chunks.push(row.value);
  }}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
  let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{throw new DebotPriceError('DEBOT_PRICE_SCHEMA_INVALID');}
  if(!object(raw)||raw.code!==0||!object(raw.data)||!object(raw.data.meta)||!object(raw.data.market))throw new DebotPriceError('DEBOT_PRICE_SCHEMA_INVALID');
  const returned=normalizePriceToken(raw.data.meta);
  if(!returned||returned.chain!==normalized.chain||returned.address!==normalized.address)throw new DebotPriceError('PRICE_TOKEN_MISMATCH');
  const price=raw.data.market.price;
  if(typeof price!=='number'||!Number.isFinite(price)||price<=0)throw new DebotPriceError('PRICE_VALUE_INVALID');
  const receivedAt=now().getTime();if(receivedAt<startedAt)throw new DebotPriceError('PRICE_CLOCK_REGRESSED');
  return {...normalized,priceUsd:price,observedAt:new Date(receivedAt-Number(age??0)*1000).toISOString(),source:'debot_token_info_sample'};
}
