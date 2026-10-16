import bs58 from 'bs58';
import {abortable,scopedFetcher,type Fetcher} from './http.js';
import {normalizeDexMemeMarket,type MemeMarketSample} from './meme-assessment.js';
import type {Signal} from './types.js';

const MAX_BYTES=2_000_000,MAX_TOKENS=30;
type Token=Signal['token']&{poolAddress?:string};
export interface MemeMarketProviderOptions {fetcher?:Fetcher;now?:()=>Date;}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

function address(chain:Signal['token']['chain'],value:unknown):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-fA-F]{40}$/.test(value)&&!/^0x0+$/i.test(value)?value.toLowerCase():undefined;
  try {const decoded=bs58.decode(value);return decoded.length===32&&decoded.some(byte=>byte!==0)?value:undefined;}
  catch {return;}
}

/** Bound bytes while streaming rather than allocating an arbitrarily large response.text(). */
async function readJson(response:Response,signal:AbortSignal):Promise<unknown> {
  const declared=response.headers.get('content-length');
  if(declared&&/^\d+$/.test(declared)&&Number(declared)>MAX_BYTES) {
    void response.body?.cancel().catch(()=>{});throw new Error('MEME_MARKET_RESPONSE_TOO_LARGE');
  }
  const reader=response.body?.getReader();
  if(!reader)throw new Error('MEME_MARKET_INVALID_JSON');
  const chunks:Uint8Array[]= [];let bytes=0,finished=false;
  try {
    while(true) {
      const next=await abortable(reader.read(),signal);
      if(next.done){finished=true;break;}
      bytes+=next.value.byteLength;
      if(bytes>MAX_BYTES||chunks.length>=65_536)throw new Error('MEME_MARKET_RESPONSE_TOO_LARGE');
      chunks.push(next.value);
    }
    const body=new Uint8Array(bytes);let offset=0;
    for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
    try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}
    catch {throw new Error('MEME_MARKET_INVALID_JSON');}
  } finally {
    if(!finished)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

/** One bounded read-only request. Returned prices always belong to an exact base-token match. */
export async function fetchMemeMarkets(tokens:Token[],signal:AbortSignal,options:MemeMarketProviderOptions={}):Promise<MemeMarketSample[]> {
  if(!tokens.length)return [];
  if(tokens.length>MAX_TOKENS)throw new Error('MEME_MARKET_BATCH_TOO_LARGE');
  if(tokens.some(token=>!object(token)||!['bsc','solana','robinhood'].includes(token.chain)))throw new Error('MEME_MARKET_TOKEN_INVALID');
  const chains=new Set(tokens.map(token=>token.chain));
  if(chains.size!==1)throw new Error('MEME_MARKET_MIXED_CHAINS');
  const chain=tokens[0].chain;
  if(chain==='robinhood')return [];
  const targets=new Map<string,Token>();
  for(const token of tokens) {
    const normalized=address(chain,token.address);
    if(!normalized)throw new Error('MEME_MARKET_TOKEN_INVALID');
    const pool=address(chain,token.poolAddress),existing=targets.get(normalized);
    if(!existing)targets.set(normalized,{chain,address:normalized,...(pool?{poolAddress:pool}:{})});
    else if(pool&&(!existing.poolAddress||pool<existing.poolAddress))existing.poolAddress=pool;
  }
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DOMException('Market deadline','TimeoutError')),8_000);
  const scope=AbortSignal.any([signal,controller.signal]),fetcher=scopedFetcher(options.fetcher??fetch,scope);
  try {
    scope.throwIfAborted();
    const url=`https://api.dexscreener.com/tokens/v1/${chain}/${[...targets.keys()].join(',')}`;
    const response=await fetcher(url,{method:'GET',redirect:'error',credentials:'omit',headers:{accept:'application/json'}});
    if(response.status===429) {void response.body?.cancel().catch(()=>{});throw new Error('MEME_MARKET_RATE_LIMITED');}
    if(!response.ok) {void response.body?.cancel().catch(()=>{});throw new Error('MEME_MARKET_HTTP_ERROR');}
    const raw=await readJson(response,scope);
    if(!Array.isArray(raw))throw new Error('MEME_MARKET_RESPONSE_INVALID');
    const now=(options.now??(()=>new Date()))();
    if(!Number.isFinite(now.getTime()))throw new Error('MEME_MARKET_TIME_INVALID');
    const observedAt=now.toISOString(),byToken=new Map<string,Map<string,MemeMarketSample|null>>();
    for(const pair of raw) {
      if(!object(pair)||pair.chainId!==chain||!object(pair.baseToken))continue;
      const base=address(chain,pair.baseToken.address),target=base?targets.get(base):undefined;
      if(!target)continue;
      const sample=normalizeDexMemeMarket(pair,{chain,address:target.address},observedAt);
      if(!sample?.poolAddress)continue;
      const pools=byToken.get(target.address)??new Map<string,MemeMarketSample|null>();
      const prior=pools.get(sample.poolAddress);
      if(prior===undefined)pools.set(sample.poolAddress,sample);
      else if(prior&&JSON.stringify(prior)!==JSON.stringify(sample))pools.set(sample.poolAddress,null);
      byToken.set(target.address,pools);
    }
    const result:MemeMarketSample[]=[];
    for(const target of targets.values()) {
      const pools=byToken.get(target.address);
      if(!pools)continue;
      const preferred=target.poolAddress?pools.get(target.poolAddress):undefined;
      const candidates=[...pools.values()].filter((sample):sample is MemeMarketSample=>!!sample);
      candidates.sort((a,b)=>(b.liquidityUsd??-1)-(a.liquidityUsd??-1)||
        (a.poolAddress!<b.poolAddress!?-1:a.poolAddress!>b.poolAddress!?1:0));
      const selected=preferred??candidates[0];
      if(selected)result.push(selected);
    }
    return result;
  } catch(error) {
    if(scope.aborted)throw new Error(signal.aborted?'MEME_MARKET_CANCELLED':'MEME_MARKET_TIMEOUT');
    if(error instanceof Error&&/^MEME_MARKET_[A-Z_]+$/.test(error.message))throw error;
    throw new Error('MEME_MARKET_UNAVAILABLE');
  } finally {clearTimeout(timer);}
}
