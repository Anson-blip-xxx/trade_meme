import {createHash,randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import type {Fetcher} from '../http.js';
import {parseSignal,type Chain,type Platform,type Signal} from '../types.js';
import {DebotSessionError} from './debot-session.js';

const CHANNELS:Record<Chain,number>={bsc:2,solana:1,robinhood:83};
const PAGE_SIZE=20;
const MAX_BODY_BYTES=2*1024*1024;
const MAX_WALLETS=100;
const MAX_WALLET_SNAPSHOTS=20;
const object=(value:unknown):value is Record<string,unknown>=>
  value!==null&&typeof value==='object'&&!Array.isArray(value);

export interface DebotSignalObservation {
  id:string;signal:Signal;observedAt:string;
  /** Vendor-reported entries, not independently verified buyers or wallet ownership. */
  walletCount:number;addressCount:number;aliases:string[];
  alertPriceUsd?:number;averageWalletVolumeUsd?:number;
  /** Vendor observations for later matching; absence of a transaction means no verified buy evidence. */
  vendorWallets?:DebotVendorWalletSnapshot[];
}
export interface DebotVendorWalletSnapshot {
  alias?:string;address?:string;lastTradeAt?:string;amount?:string;volumeUsd?:number;priceUsd?:number;
}
export interface DebotVendorWalletDetail extends DebotVendorWalletSnapshot {
  source:'debot';verification:'vendor_report';
  profit?:Partial<Record<'buyVolumeUsd'|'buyAmount'|'actualBuyAmount'|'actualBuyCostUsd'|'holdAmount'|
    'realizedProfitUsd'|'unrealizedProfitUsd',string>>;
}
export interface DebotWalletDetails {
  fetchedAt:string;received:number;rejected:number;vendorWallets:DebotVendorWalletDetail[];reason?:string;
}
export interface NormalizedDebotSignals {
  observations:DebotSignalObservation[];received:number;rejected:number;reason?:string;next?:string;
}

function address(value:unknown,chain:Chain):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-fA-F]{40}$/.test(value)?value.toLowerCase():undefined;
  if(value.length<32||value.length>44)return;
  try {if(bs58.decode(value).length===32)return value;}catch {/* Invalid base58 is not an address. */}
}
function positive(value:unknown):number|undefined {
  if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)))return;
  const parsed=Number(value);
  return Number.isFinite(parsed)&&parsed>0?parsed:undefined;
}
function platform(value:unknown):Platform|undefined {
  return value==='pump'||value==='bonk'||value==='four'||value==='flap'?value:undefined;
}
function walletSnapshot(wallet:Record<string,unknown>,chain:Chain,observedAt:Date):DebotVendorWalletSnapshot|undefined {
  const alias=typeof wallet.alias==='string'&&wallet.alias.length<=80&&wallet.alias.trim()&&
    !/[\u0000-\u001f\u007f]/.test(wallet.alias)?wallet.alias.trim():undefined;
  const actualAddress=address(wallet.wallet,chain);
  if(!alias&&!actualAddress)return;
  const snapshot:DebotVendorWalletSnapshot={...(alias?{alias}:{}),...(actualAddress?{address:actualAddress}:{})};
  const seconds=typeof wallet.last_trade_time==='number'?wallet.last_trade_time:
    typeof wallet.last_trade_time==='string'&&/^\d{1,10}$/.test(wallet.last_trade_time)?Number(wallet.last_trade_time):NaN;
  if(Number.isSafeInteger(seconds)&&seconds>0&&seconds<=9_999_999_999&&seconds*1000<=observedAt.getTime()+30_000)
    snapshot.lastTradeAt=new Date(seconds*1000).toISOString();
  // Keep decimal precision rather than rounding token amounts through Number.
  if(typeof wallet.amount==='string'&&wallet.amount.length<=100&&/^\d+(?:\.\d+)?$/.test(wallet.amount)&&
    /[1-9]/.test(wallet.amount))snapshot.amount=wallet.amount;
  for(const [target,source] of [['volumeUsd','volume'],['priceUsd','price']] as const) {
    const raw=wallet[source];
    if(typeof raw==='string'&&raw.length>100)continue;
    const value=positive(raw);
    if(value!==undefined&&value<=Number.MAX_SAFE_INTEGER)snapshot[target]=value;
  }
  return snapshot;
}

/** Exact observed endpoint envelope; no refresh-time substitution or wallet-identity inference. */
export function normalizeDebotSignals(payload:unknown,chain:Chain,observedAt:Date):NormalizedDebotSignals {
  const result:NormalizedDebotSignals={observations:[],received:0,rejected:0};
  if(!Object.hasOwn(CHANNELS,chain)||!Number.isFinite(observedAt.getTime())) {
    result.reason='DEBOT_SIGNAL_INPUT_INVALID';return result;
  }
  if(!object(payload)||![0,200].includes(payload.code as number)||!object(payload.data)||!Array.isArray(payload.data.results)) {
    result.reason='DEBOT_SIGNAL_RESPONSE_INVALID';return result;
  }
  const data=payload.data,rows=data.results as unknown[];
  result.received=rows.length;
  if(typeof data.next==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(data.next))result.next=data.next;
  const meta=object(data.meta)?data.meta:undefined;
  const tokens=object(meta?.tokens)?meta.tokens:undefined;
  const channels=object(meta?.channel_info)?meta.channel_info:undefined;
  const channel=channels?.[String(CHANNELS[chain])];
  if(channel!==undefined&&(!object(channel)||channel.chain!==chain||channel.id!==CHANNELS[chain])) {
    result.rejected=result.received;result.reason='DEBOT_SIGNAL_CHANNEL_MISMATCH';return result;
  }
  const seen=new Set<string>();
  for(const row of rows.slice(0,PAGE_SIZE)) {
    if(!object(row)||row.chain!==chain||row.channel_id!==CHANNELS[chain]||
      typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(row.id)) {result.rejected++;continue;}
    const token=address(row.token,chain);
    // The endpoint uses Unix seconds. Milliseconds, fractions and fetch-time fallbacks are rejected.
    const seconds=typeof row.create_time==='number'?row.create_time:
      typeof row.create_time==='string'&&/^\d{1,10}$/.test(row.create_time)?Number(row.create_time):NaN;
    if(!token||!Number.isSafeInteger(seconds)||seconds<=0||seconds>9_999_999_999||
      seconds*1000>observedAt.getTime()+30_000) {result.rejected++;continue;}
    // Current web clients support both CA and chain:CA map keys. Check every supplied identity;
    // accepting just the first would conceal a contradiction under a second valid lookup key.
    const keys=new Set([row.token as string,token,`${chain}:${row.token}`,`${chain}:${token}`]);
    const identities=[...keys].flatMap(key=>tokens&&Object.hasOwn(tokens,key)?[tokens[key]]:[]);
    if(identities.some(value=>!object(value)||value.chain!==chain||address(value.address,chain)!==token)) {
      result.rejected++;continue;
    }
    const launchpads=new Set(identities.filter(object).map(value=>value.launchpad).filter(value=>value!==undefined));
    if(launchpads.size>1){result.rejected++;continue;}
    const tokenMeta=identities[0];
    const sourceEventId='debot:signal:'+createHash('sha256')
      .update(JSON.stringify([chain,CHANNELS[chain],row.id])).digest('hex');
    if(seen.has(sourceEventId)){result.rejected++;continue;}
    seen.add(sourceEventId);
    const occurredAt=new Date(seconds*1000).toISOString();
    const claimedPlatform=object(tokenMeta)?platform(tokenMeta.launchpad):undefined;
    const signal=parseSignal({source:'debot',sourceEventId,token:{chain,address:token},occurredAt,
      ...(claimedPlatform?{claimedPlatform}:{}),claim:'unspecified',evidenceUrls:[],
      text:`DeBot 信号；链 ${chain}；频道 ${CHANNELS[chain]}；事件 ${row.id}；CA ${token}；告警时间 ${occurredAt}。`});
    const wallets=Array.isArray(row.wallet_stats)?row.wallet_stats.slice(0,MAX_WALLETS):[];
    const aliases=new Set<string>(),addresses=new Set<string>(),vendorWallets:DebotVendorWalletSnapshot[]=[];
    let walletCount=0;
    for(const wallet of wallets) {
      if(!object(wallet)||address(wallet.token,chain)!==token)continue;
      walletCount++;
      const snapshot=walletSnapshot(wallet,chain,observedAt);
      if(snapshot?.alias&&aliases.size<MAX_WALLET_SNAPSHOTS)aliases.add(snapshot.alias);
      if(snapshot&&vendorWallets.length<MAX_WALLET_SNAPSHOTS)vendorWallets.push(snapshot);
      const actualAddress=address(wallet.wallet,chain);
      if(actualAddress)addresses.add(actualAddress);
    }
    const alertPriceUsd=object(row.token_trading_stat)?positive(row.token_trading_stat.price):undefined;
    const averageWalletVolumeUsd=positive(row.avg_wallet_volume);
    result.observations.push({id:row.id,signal,observedAt:observedAt.toISOString(),walletCount,
      addressCount:addresses.size,aliases:[...aliases],
      ...(vendorWallets.length?{vendorWallets}:{}),
      ...(alertPriceUsd!==undefined?{alertPriceUsd}:{}),
      ...(averageWalletVolumeUsd!==undefined?{averageWalletVolumeUsd}:{})});
  }
  result.rejected+=Math.max(0,rows.length-PAGE_SIZE);
  if(result.rejected)result.reason='DEBOT_SIGNAL_RECORDS_REJECTED';
  return result;
}

/** A successful authenticated socket delivery still supplies vendor claims, not chain verification. */
export function normalizeDebotSignalPush(envelope:unknown,observedAt:Date):NormalizedDebotSignals {
  const invalid=(reason:string):NormalizedDebotSignals=>({observations:[],received:0,rejected:0,reason});
  if(!object(envelope)||typeof envelope.chain!=='string'||!Object.hasOwn(CHANNELS,envelope.chain)||
    typeof envelope.data!=='string')return invalid('DEBOT_SIGNAL_PUSH_INVALID');
  if(Buffer.byteLength(envelope.data,'utf8')>MAX_BODY_BYTES)return invalid('DEBOT_SIGNAL_RESPONSE_TOO_LARGE');
  let payload:unknown;
  try {payload=JSON.parse(envelope.data);}catch {return invalid('DEBOT_SIGNAL_INVALID_JSON');}
  if(!object(payload)||!Array.isArray(payload.results)||Object.hasOwn(payload,'code'))
    return invalid('DEBOT_SIGNAL_PUSH_INVALID');
  return normalizeDebotSignals({code:0,data:payload},envelope.chain as Chain,observedAt);
}

export class DebotSignalError extends Error {
  constructor(readonly reason:string,readonly cooldownUntil?:number) {
    super(reason);this.name='DebotSignalError';
  }
}
function sessionFailure(error:unknown):DebotSignalError|undefined {
  if(!(error instanceof DebotSessionError))return;
  if(error.reason==='DEBOT_SESSION_AUTH_REQUIRED')return new DebotSignalError('DEBOT_SIGNAL_HTTP_401');
  if(error.reason==='DEBOT_SESSION_RATE_LIMITED')return new DebotSignalError('DEBOT_SIGNAL_HTTP_429',error.cooldownUntil);
  if(error.reason==='DEBOT_SESSION_REQUEST_TIMEOUT')return new DebotSignalError('DEBOT_SIGNAL_REQUEST_TIMEOUT');
  if(error.reason==='DEBOT_SESSION_RESPONSE_TOO_LARGE')return new DebotSignalError('DEBOT_SIGNAL_RESPONSE_TOO_LARGE');
  if(error.reason==='DEBOT_SESSION_RESPONSE_INVALID')return new DebotSignalError('DEBOT_SIGNAL_RESPONSE_INVALID');
  return new DebotSignalError('DEBOT_SIGNAL_REQUEST_FAILED');
}
function cooldown(response:Response,now:number):number {
  const value=response.headers.get('retry-after');
  const seconds=value!==null&&/^\d+$/.test(value)?Number(value):NaN;
  const delay=Number.isFinite(seconds)?seconds*1000:value?Date.parse(value)-now:60_000;
  return now+Math.min(3_600_000,Math.max(60_000,Number.isFinite(delay)?delay:60_000));
}
async function readBoundedJson(response:Response):Promise<unknown> {
  const contentLength=response.headers.get('content-length');
  if(contentLength!==null&&/^\d+$/.test(contentLength)&&Number(contentLength)>MAX_BODY_BYTES) {
    await response.body?.cancel().catch(()=>{});throw new DebotSignalError('DEBOT_SIGNAL_RESPONSE_TOO_LARGE');
  }
  if(!response.body)throw new DebotSignalError('DEBOT_SIGNAL_INVALID_JSON');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];
  let size=0;
  try {
    for(;;) {
      const chunk=await reader.read();if(chunk.done)break;
      size+=chunk.value.byteLength;
      if(size>MAX_BODY_BYTES) {
        await reader.cancel().catch(()=>{});throw new DebotSignalError('DEBOT_SIGNAL_RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk.value);
    }
  } finally {reader.releaseLock();}
  try {return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}
  catch {throw new DebotSignalError('DEBOT_SIGNAL_INVALID_JSON');}
}

/** Anonymous, bounded GET to a fixed read-only endpoint. Never follows pagination or redirects. */
export async function fetchDebotSignalPage(chain:Chain,
  options:{fetcher?:Fetcher;now?:()=>Date}={}):Promise<NormalizedDebotSignals> {
  if(!Object.hasOwn(CHANNELS,chain))throw new DebotSignalError('DEBOT_SIGNAL_INPUT_INVALID');
  const now=options.now??(()=>new Date()),url=new URL('https://debot.ai/api/community/signal/channel/list');
  url.searchParams.set('request_id',randomUUID());url.searchParams.set('chain',chain);
  url.searchParams.set('channel_ids',String(CHANNELS[chain]));url.searchParams.set('page_size',String(PAGE_SIZE));
  try {
    const response=await (options.fetcher??fetch)(url,{method:'GET',credentials:'omit',redirect:'error',
      headers:{accept:'application/json'},signal:AbortSignal.timeout(10_000)});
    if(!response.ok) {
      const until=response.status===429?cooldown(response,now().getTime()):undefined;
      await response.body?.cancel().catch(()=>{});
      throw new DebotSignalError([401,403,429].includes(response.status)?
        `DEBOT_SIGNAL_HTTP_${response.status}`:'DEBOT_SIGNAL_HTTP_ERROR',until);
    }
    return normalizeDebotSignals(await readBoundedJson(response),chain,now());
  } catch(error) {
    if(error instanceof DebotSignalError)throw error;
    const sessionError=sessionFailure(error);if(sessionError)throw sessionError;
    if(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError'))
      throw new DebotSignalError('DEBOT_SIGNAL_REQUEST_TIMEOUT');
    throw new DebotSignalError('DEBOT_SIGNAL_REQUEST_FAILED');
  }
}

/** Only a credential-aware caller may fetch account-visible details; no anonymous fallback exists. */
export async function fetchDebotWalletDetails(observation:DebotSignalObservation,
  options:{fetcher:Fetcher;now?:()=>Date}):Promise<DebotWalletDetails> {
  if(!options||typeof options.fetcher!=='function')throw new DebotSignalError('DEBOT_SIGNAL_AUTH_REQUIRED');
  const target=observation?.signal?.token,chain=target?.chain;
  if(!chain||!Object.hasOwn(CHANNELS,chain)||!address(target.address,chain)||observation.signal.source!=='debot'||
    typeof observation.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(observation.id))
    throw new DebotSignalError('DEBOT_SIGNAL_INPUT_INVALID');
  const token=address(target.address,chain)!,now=options.now??(()=>new Date());
  const url=new URL('https://debot.ai/api/community/signal/channel/wallets/profit');
  url.searchParams.set('request_id',randomUUID());url.searchParams.set('chain',chain);
  url.searchParams.set('token',token);url.searchParams.set('notification_id',observation.id);
  url.searchParams.set('channel_id',String(CHANNELS[chain]));
  try {
    // The supplied session client is responsible for attaching its validated login state.
    const response=await options.fetcher(url,{method:'GET',credentials:'omit',redirect:'error',
      headers:{accept:'application/json'},signal:AbortSignal.timeout(10_000)});
    if(!response.ok) {
      const until=response.status===429?cooldown(response,now().getTime()):undefined;
      await response.body?.cancel().catch(()=>{});
      throw new DebotSignalError([401,403,429].includes(response.status)?
        `DEBOT_SIGNAL_HTTP_${response.status}`:'DEBOT_SIGNAL_HTTP_ERROR',until);
    }
    const payload=await readBoundedJson(response),observedAt=now();
    if(!Number.isFinite(observedAt.getTime()))throw new DebotSignalError('DEBOT_SIGNAL_INPUT_INVALID');
    const result:DebotWalletDetails={fetchedAt:observedAt.toISOString(),received:0,rejected:0,vendorWallets:[]};
    if(!object(payload)||![0,200].includes(payload.code as number)||!Array.isArray(payload.data)) {
      result.reason='DEBOT_SIGNAL_RESPONSE_INVALID';return result;
    }
    result.received=payload.data.length;
    for(const row of payload.data.slice(0,MAX_WALLET_SNAPSHOTS)) {
      if(!object(row)||!object(row.wallet_stats)) {result.rejected++;continue;}
      const stats=row.wallet_stats;
      // Some detail rows omit token identity; the fixed request then provides their vendor scope.
      // Explicit contradictory identity must never be hidden by that request context.
      if([row,stats].some(value=>(Object.hasOwn(value,'chain')&&value.chain!==chain)||
        (Object.hasOwn(value,'token')&&address(value.token,chain)!==token))||
        (Object.hasOwn(row,'notification_id')&&row.notification_id!==observation.id)||
        (Object.hasOwn(row,'channel_id')&&String(row.channel_id)!==String(CHANNELS[chain]))) {
        result.rejected++;continue;
      }
      const snapshot=walletSnapshot(stats,chain,observedAt);
      if(!snapshot){result.rejected++;continue;}
      const detail:DebotVendorWalletDetail={...snapshot,source:'debot',verification:'vendor_report'};
      if(object(row.profit)) {
        const profit:NonNullable<DebotVendorWalletDetail['profit']>={};
        for(const [source,destination] of [['buy_volume','buyVolumeUsd'],['buy_amount','buyAmount'],
          ['actual_buy_amount','actualBuyAmount'],['actual_buy_cost','actualBuyCostUsd'],['hold_amount','holdAmount'],
          ['realized_profit','realizedProfitUsd'],['unrealized_profit','unrealizedProfitUsd']] as const) {
          const value=row.profit[source],text=typeof value==='string'?value:typeof value==='number'?String(value):undefined;
          if(text!==undefined&&text.length<=100&&/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)&&
            Number.isFinite(Number(text))&&Math.abs(Number(text))<=1e100)profit[destination]=text;
        }
        if(Object.keys(profit).length)detail.profit=profit;
      }
      result.vendorWallets.push(detail);
    }
    result.rejected+=Math.max(0,payload.data.length-MAX_WALLET_SNAPSHOTS);
    if(result.rejected)result.reason='DEBOT_SIGNAL_RECORDS_REJECTED';
    return result;
  } catch(error) {
    if(error instanceof DebotSignalError)throw error;
    const sessionError=sessionFailure(error);if(sessionError)throw sessionError;
    if(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError'))
      throw new DebotSignalError('DEBOT_SIGNAL_REQUEST_TIMEOUT');
    throw new DebotSignalError('DEBOT_SIGNAL_REQUEST_FAILED');
  }
}
