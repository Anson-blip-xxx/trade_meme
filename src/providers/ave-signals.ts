import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {abortable,type Fetcher} from '../http.js';
import {parseSignal,type Chain,type Platform,type Signal} from '../types.js';
import {tokenDisplayText} from '../token-display.js';

const CHAINS:readonly Chain[]=['bsc','solana','robinhood'];
const PAGE_SIZE=20,MAX_BODY_BYTES=2*1024*1024,MAX_ACTIONS=100;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Ave identifies these wallets; no transaction receipt or ownership assertion is implied. */
export interface AveVendorWalletSnapshot {
  source:'ave';verification:'vendor_report';id?:string;address:string;alias?:string;
  side?:'buy'|'sell';lastTradeAt?:string;volumeUsd?:number;priceUsd?:number;
}
export interface AveSignalObservation {
  id:string;signal:Signal;observedAt:string;name?:string;symbol?:string;
  kind?:string;vendorWalletCount?:number;vendorWallets?:AveVendorWalletSnapshot[];
  /** Supplier summary and links are context, not independently verified endorsement. */
  headline?:string;socialUrl?:string;firstSignalAt?:string;vendorHistoryCount?:number;
  alertMarketCapUsd?:number;currentPriceUsd?:number;
}
export interface NormalizedAveSignals {
  observations:AveSignalObservation[];received:number;rejected:number;reason?:string;next?:string;
}

function address(value:unknown,chain:Chain):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-fA-F]{40}$/.test(value)?value.toLowerCase():undefined;
  if(value.length<32||value.length>44)return;
  try {if(bs58.decode(value).length===32)return value;}catch {/* An invalid base58 string is not a wallet. */}
}
function integer(value:unknown,allowZero=false):number|undefined {
  if(typeof value!=='number'&&!(typeof value==='string'&&/^\d{1,16}$/.test(value)))return;
  const n=Number(value);return Number.isSafeInteger(n)&&n>=(allowZero?0:1)?n:undefined;
}
function seconds(value:unknown,observedAt:Date):number|undefined {
  const n=integer(value);return n!==undefined&&n<=9_999_999_999&&n*1000<=observedAt.getTime()+30_000?n:undefined;
}
function positive(value:unknown):number|undefined {
  if(typeof value!=='number'&&!(typeof value==='string'&&value.length<=100&&/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)))return;
  const n=Number(value);return Number.isFinite(n)&&n>0&&n<=Number.MAX_SAFE_INTEGER?n:undefined;
}
function platform(value:unknown):Platform|undefined {
  return value==='pump.fun'?'pump':value==='four.meme'?'four':value==='flap.sh'?'flap':undefined;
}
function social(value:unknown):string|undefined {
  if(typeof value!=='string'||value.length>500)return;
  try {const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||
    !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname))return;
    return u.href;
  }catch {/* Invalid supplier links are ignored. */}
}
function wallet(raw:unknown,chain:Chain,token:string,observedAt:Date):AveVendorWalletSnapshot|undefined {
  if(!object(raw))return;
  // Parent signal binds the actions in the observed response. Any explicitly repeated
  // identity must agree as well; never silently ignore a contradictory token or chain.
  if(raw.chain!==undefined&&raw.chain!==chain||raw.token!==undefined&&address(raw.token,chain)!==token)return;
  const actual=address(raw.wallet_address,chain);if(!actual)return;
  const id=integer(raw.id),at=seconds(raw.action_time,observedAt);
  if(raw.action_time!==undefined&&at===undefined)return;
  const alias=tokenDisplayText(raw.wallet_alias,80),volumeUsd=positive(raw.quote_token_volume),priceUsd=positive(raw.target_token_price);
  return {source:'ave',verification:'vendor_report',address:actual,...(id!==undefined?{id:String(id)}:{}),
    ...(alias?{alias}:{}),...(raw.action_type==='buy'||raw.action_type==='sell'?{side:raw.action_type}:{}),
    ...(at!==undefined?{lastTradeAt:new Date(at*1000).toISOString()}:{}),
    ...(volumeUsd!==undefined?{volumeUsd}:{}),...(priceUsd!==undefined?{priceUsd}:{})};
}

/** Exact public-list envelope observed on ave.ai/smart; signal_time is Unix seconds. */
export function normalizeAveSignals(payload:unknown,observedAt:Date,chains:readonly Chain[]=CHAINS):NormalizedAveSignals {
  const result:NormalizedAveSignals={observations:[],received:0,rejected:0};
  if(!Number.isFinite(observedAt.getTime())||!chains.length||chains.some(chain=>!CHAINS.includes(chain))) {
    result.reason='AVE_SIGNAL_INPUT_INVALID';return result;
  }
  if(!object(payload)||payload.status!==1||!object(payload.data)||!Array.isArray(payload.data.list)) {
    result.reason='AVE_SIGNAL_RESPONSE_INVALID';return result;
  }
  const rows=payload.data.list;result.received=rows.length;
  if(typeof payload.data.page_token==='string'&&/^[A-Za-z0-9_:,=.\/-]{1,500}$/.test(payload.data.page_token))result.next=payload.data.page_token;
  const seen=new Set<string>();
  for(const raw of rows.slice(0,PAGE_SIZE)) {
    if(!object(raw)||typeof raw.chain!=='string'||!chains.includes(raw.chain as Chain)) {result.rejected++;continue;}
    const chain=raw.chain as Chain,token=address(raw.token,chain),id=integer(raw.id),at=seconds(raw.signal_time,observedAt);
    if(!token||id===undefined||at===undefined||typeof raw.tag!=='string'||!/^[a-z][a-z0-9_]{1,39}$/.test(raw.tag)||
      (raw.action_type!=='buy'&&raw.action_type!=='sell')||
      (raw.tag.endsWith('_buy')&&raw.action_type!=='buy')||(raw.tag.endsWith('_sell')&&raw.action_type!=='sell')) {
      result.rejected++;continue;
    }
    // Official UI identity is token + chain + tag + signal_time. Mutable display
    // fields, history_count and current prices must never manufacture new alarms.
    const sourceEventId='ave:signal:'+createHash('sha256').update(JSON.stringify([chain,token,raw.tag,at])).digest('hex');
    if(seen.has(sourceEventId)){result.rejected++;continue;}seen.add(sourceEventId);
    const occurredAt=new Date(at*1000).toISOString(),claimedPlatform=platform(raw.issue_platform);
    const signal=parseSignal({source:'ave',sourceEventId,token:{chain,address:token},occurredAt,
      ...(claimedPlatform?{claimedPlatform}:{}),claim:'unspecified',
      evidenceUrls:[`https://ave.ai/token/${token}-${chain}`],
      text:`Ave 信号；链 ${chain}；类型 ${raw.tag}；CA ${token}；告警时间 ${occurredAt}。`});
    const vendorWallets:AveVendorWalletSnapshot[]=[],walletIds=new Set<string>();
    for(const action of (Array.isArray(raw.actions)?raw.actions:[]).slice(0,MAX_ACTIONS)) {
      const snapshot=wallet(action,chain,token,observedAt);if(!snapshot)continue;
      const key=JSON.stringify([snapshot.address,snapshot.id??null,snapshot.lastTradeAt??null,snapshot.side??null]);
      if(walletIds.has(key))continue;walletIds.add(key);vendorWallets.push(snapshot);
    }
    const symbol=tokenDisplayText(raw.symbol,40),name=tokenDisplayText(raw.name,100),headline=tokenDisplayText(raw.headline,2000);
    const socialUrl=social(raw.twitter_url),first=seconds(raw.first_signal_time,observedAt),vendorHistoryCount=integer(raw.history_count,true);
    const vendorWalletCount=integer(raw.action_count,true),alertMarketCapUsd=positive(raw.mc),currentPriceUsd=positive(raw.current_price_usd);
    result.observations.push({id:String(id),signal,observedAt:observedAt.toISOString(),kind:raw.tag,
      ...(symbol?{symbol}:{}),...(name?{name}:{}),...(headline?{headline}:{}),...(socialUrl?{socialUrl}:{}),
      ...(first!==undefined&&first<=at?{firstSignalAt:new Date(first*1000).toISOString()}:{}),
      ...(vendorHistoryCount!==undefined?{vendorHistoryCount}:{}),...(vendorWalletCount!==undefined?{vendorWalletCount}:{}),
      ...(vendorWallets.length?{vendorWallets}:{}),...(alertMarketCapUsd!==undefined?{alertMarketCapUsd}:{}),
      ...(currentPriceUsd!==undefined?{currentPriceUsd}:{})});
  }
  result.rejected+=Math.max(0,rows.length-PAGE_SIZE);
  if(result.rejected)result.reason='AVE_SIGNAL_RECORDS_REJECTED';
  return result;
}

/** Only the observed signal event is admitted, never price updates or heartbeat frames. */
export function normalizeAveSignalPush(payload:unknown,observedAt:Date,chains:readonly Chain[]=CHAINS):NormalizedAveSignals {
  const invalid=():NormalizedAveSignals=>({observations:[],received:0,rejected:0,reason:'AVE_SIGNAL_PUSH_INVALID'});
  if(!object(payload)||payload.jsonrpc!=='2.0'||!object(payload.result)||payload.result.status!=='ok'||
    !object(payload.result.data)||payload.result.data.event!=='signalsv2_public_monitor'||!object(payload.result.data.msg))return invalid();
  return normalizeAveSignals({status:1,data:{list:[payload.result.data.msg]}},observedAt,chains);
}

export class AveSignalError extends Error {
  constructor(readonly reason:string,readonly cooldownUntil?:number){super(reason);this.name='AveSignalError';}
}
function cooldown(response:Response,now:number):number {
  const value=response.headers.get('retry-after'),seconds=value!==null&&/^\d+$/.test(value)?Number(value):NaN;
  const delay=Number.isFinite(seconds)?seconds*1000:value?Date.parse(value)-now:60_000;
  return now+Math.min(3_600_000,Math.max(60_000,Number.isFinite(delay)?delay:60_000));
}
async function boundedJson(response:Response,signal:AbortSignal):Promise<unknown> {
  const length=response.headers.get('content-length');
  if(length!==null&&/^\d+$/.test(length)&&Number(length)>MAX_BODY_BYTES) {
    await response.body?.cancel().catch(()=>{});throw new AveSignalError('AVE_SIGNAL_RESPONSE_TOO_LARGE');
  }
  if(!response.body)throw new AveSignalError('AVE_SIGNAL_INVALID_JSON');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const chunk=await abortable(reader.read(),signal);if(chunk.done)break;
    size+=chunk.value.byteLength;if(size>MAX_BODY_BYTES){await reader.cancel().catch(()=>{});throw new AveSignalError('AVE_SIGNAL_RESPONSE_TOO_LARGE');}
    chunks.push(chunk.value);
  }}catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  try {return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch {throw new AveSignalError('AVE_SIGNAL_INVALID_JSON');}
}

/** Fixed public read endpoint; caller may supply its normal browser-session fetcher.
 * No token generation, login, redirects, trading or arbitrary-host requests occur here. */
export async function fetchAveSignalPage(chains:readonly Chain[]=CHAINS,
  options:{fetcher?:Fetcher;now?:()=>Date;signal?:AbortSignal}={}):Promise<NormalizedAveSignals> {
  if(!chains.length||chains.some(chain=>!CHAINS.includes(chain)))throw new AveSignalError('AVE_SIGNAL_INPUT_INVALID');
  const now=options.now??(()=>new Date()),url=new URL('https://yiyulu.com/v2api/signals/v2/public/multi_chain/list');
  url.searchParams.set('pageSize',String(PAGE_SIZE));url.searchParams.set('chain',[...new Set(chains)].join(','));
  const timeout=AbortSignal.timeout(10_000),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
  try {
    signal.throwIfAborted();
    const response=await abortable((options.fetcher??fetch)(url,{method:'GET',credentials:'omit',redirect:'error',
      headers:{accept:'application/json','Ave-Platform':'web',lang:'en'},signal}),signal);
    if(!response.ok){const until=response.status===429?cooldown(response,now().getTime()):undefined;
      await response.body?.cancel().catch(()=>{});
      throw new AveSignalError([401,403,429].includes(response.status)?`AVE_SIGNAL_HTTP_${response.status}`:'AVE_SIGNAL_HTTP_ERROR',until);
    }
    return normalizeAveSignals(await boundedJson(response,signal),now(),chains);
  }catch(error){
    if(error instanceof AveSignalError)throw error;
    if(signal.aborted||error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))throw new AveSignalError('AVE_SIGNAL_REQUEST_TIMEOUT');
    throw new AveSignalError('AVE_SIGNAL_REQUEST_FAILED');
  }
}
