import type {Chain} from './types.js';
import {chainAddress,object} from './chain-stream-store.js';
import {CHAIN_PRICE_DEPLOYMENTS as D} from './chain-prices.js';

const BODY_LIMIT=4*1024*1024;
// Only this private error type can carry a public reason. Provider errors may contain credentials.
class DataError extends Error {constructor(code:string,readonly retryMs=0){super(code);}}
function fail(code:string):never {throw new DataError(code);}
function cancel(response:Response):void {void response.body?.cancel().catch(()=>{});}
function abortable<T>(promise:Promise<T>,signal:AbortSignal,onLate?:(value:T)=>void):Promise<T> {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const aborted=()=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);reject(new DataError('CHAIN_HTTP_ABORTED'));};
    if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});
    promise.then(value=>{if(settled){onLate?.(value);return;}settled=true;signal.removeEventListener('abort',aborted);resolve(value);},
      error=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);reject(error);});
  });
}
function wait(ms:number,signal:AbortSignal):Promise<void> {
  if(signal.aborted)return Promise.reject(new DataError('CHAIN_HTTP_ABORTED'));
  if(ms<=0)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},ms);
    const aborted=()=>{clearTimeout(timer);signal.removeEventListener('abort',aborted);reject(new DataError('CHAIN_HTTP_ABORTED'));};
    signal.addEventListener('abort',aborted,{once:true});
  });
}
function deadline(parent:AbortSignal,timeoutMs:number) {
  const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),timeoutMs);
  return {signal:AbortSignal.any([parent,timeout.signal]),timedOut:()=>timeout.signal.aborted,close:()=>clearTimeout(timer)};
}
function retryDelay(response:Response):number {
  const value=response.headers.get('retry-after');
  const requested=value&&/^\d{1,6}$/.test(value)?Number(value)*1000:value?Date.parse(value)-Date.now():0;
  return Math.max(10_000,Math.min(60_000,Number.isFinite(requested)?requested:0));
}
/** Bound decoded response bytes, not just Content-Length. Cancellation also covers a stalled reader. */
async function readJson(response:Response,signal:AbortSignal):Promise<unknown> {
  if(!response.ok){cancel(response);throw new DataError(response.status===429?'CHAIN_HTTP_RATE_LIMITED':'CHAIN_HTTP_FAILED',response.status===429?retryDelay(response):0);}
  const length=response.headers.get('content-length');
  if(length&&/^\d+$/.test(length)&&Number(length)>BODY_LIMIT){cancel(response);fail('CHAIN_HTTP_TOO_LARGE');}
  const reader=response.body?.getReader();if(!reader)fail('CHAIN_HTTP_EMPTY');
  let size=0;const chunks:Uint8Array[]=[];
  try {
    for(;;){const {done,value}=await abortable(reader.read(),signal);if(done)break;
      size+=value.length;if(size>BODY_LIMIT)fail('CHAIN_HTTP_TOO_LARGE');chunks.push(value);}
    if(signal.aborted)fail('CHAIN_HTTP_ABORTED');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
const READ_METHODS=new Set(['eth_chainId','eth_blockNumber','eth_getLogs','eth_call','eth_getBlockByNumber',
  'eth_getBalance','eth_getCode','eth_getTransactionReceipt','eth_getTransactionByHash',
  'getGenesisHash','getSignaturesForAddress','getMultipleAccounts','getAccountInfo','getBlockTime','getSlot','getTransaction','getBalance']);
export class ChainHttp {
  private tail:Promise<unknown>=Promise.resolve();private pending=0;private nextAt=0;private id=0;private stopped=false;
  private controller=new AbortController();
  constructor(private url:string,private fetcher:typeof fetch=fetch,private intervalMs=350,private timeoutMs=10000){
    if(!Number.isFinite(intervalMs)||intervalMs<0||intervalMs>60000||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('CHAIN_HTTP_CONFIG_INVALID');
  }
  request(method:string,params:readonly unknown[]=[],signal?:AbortSignal):Promise<any> {
    if(this.stopped||this.pending>=60)return Promise.reject(new Error(this.stopped?'CHAIN_STOPPED':'CHAIN_HTTP_QUEUE_FULL'));
    let paramsJson:string;
    try {if(!READ_METHODS.has(method)||!Array.isArray(params))fail('CHAIN_HTTP_REQUEST_INVALID');
      paramsJson=JSON.stringify(params);if(Buffer.byteLength(paramsJson)>1024*1024)fail('CHAIN_HTTP_REQUEST_INVALID');
    }catch{return Promise.reject(new Error('CHAIN_HTTP_REQUEST_INVALID'));}
    this.pending++;const requestSignal=signal?AbortSignal.any([this.controller.signal,signal]):this.controller.signal;
    const run=this.tail.catch(()=>{}).then(async()=>{
      let timeout:ReturnType<typeof deadline>|undefined;
      try {
        if(this.stopped)fail('CHAIN_STOPPED');
        await wait(this.nextAt-Date.now(),requestSignal);
        if(this.stopped)fail('CHAIN_STOPPED');this.nextAt=Date.now()+this.intervalMs;
        const id=++this.id;timeout=deadline(requestSignal,this.timeoutMs);
        const response=await abortable(this.fetcher(this.url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},
          body:`{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":${paramsJson}}`,signal:timeout.signal}),timeout.signal,cancel);
        const data=await readJson(response,timeout.signal);
        if(this.stopped)fail('CHAIN_STOPPED');
        if(!object(data)||data.jsonrpc!=='2.0'||data.id!==id||Object.hasOwn(data,'error')||!Object.hasOwn(data,'result'))fail('CHAIN_RPC_REJECTED');
        return data.result;
      }catch(error){
        const reason=this.stopped?'CHAIN_STOPPED':timeout?.timedOut()?'CHAIN_HTTP_TIMEOUT':error instanceof DataError?error.message:'CHAIN_HTTP_FAILED';
        if(error instanceof DataError&&error.message==='CHAIN_HTTP_RATE_LIMITED')this.nextAt=Date.now()+error.retryMs;
        throw new Error(reason);
      }finally{timeout?.close();}
    }).finally(()=>{this.pending--;});
    this.tail=run;return run;
  }
  stop(){this.stopped=true;this.controller.abort();}
}

interface PairSnapshot {fetchedAt:number;until:number;data:Record<string,any>[];}
interface DexOptions {now?:()=>number;intervalMs?:number;timeoutMs?:number;}
function numeric(value:unknown):number|undefined {
  if(typeof value!=='number'&&(typeof value!=='string'||value.length>64||!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)))return;
  const n=Number(value);return Number.isFinite(n)&&n>=0?n:undefined;
}
function quoteAssets(chain:Chain):readonly string[] {
  return chain==='bsc'?[D.wbnb,D.usdtBsc,D.usdcBsc]:chain==='solana'?[D.wsol,D.usdcSol]:[];
}
export class DexPoolData {
  private cache=new Map<string,PairSnapshot>();private inFlight=new Map<string,Promise<PairSnapshot>>();
  private controller=new AbortController();private stopped=false;private nextAt=0;private tail:Promise<unknown>=Promise.resolve();
  private now:()=>number;private intervalMs:number;private timeoutMs:number;
  constructor(private fetcher:typeof fetch=fetch,options:DexOptions={}){
    this.now=options.now??Date.now;this.intervalMs=options.intervalMs??250;this.timeoutMs=options.timeoutMs??10000;
    if(!Number.isFinite(this.intervalMs)||this.intervalMs<0||this.intervalMs>60000||!Number.isFinite(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>60000)fail('CHAIN_HTTP_CONFIG_INVALID');
  }
  private snapshot(chain:Chain,address:string):Promise<PairSnapshot> {
    if(this.stopped)return Promise.reject(new Error('CHAIN_STOPPED'));
    const ca=chainAddress(chain,address);if(!ca)return Promise.reject(new Error('CHAIN_ADDRESS_INVALID'));
    const key=chain+':'+ca,hit=this.cache.get(key),now=this.now();
    if(hit&&now>=hit.fetchedAt&&hit.until>now)return Promise.resolve(hit);
    const pending=this.inFlight.get(key);if(pending)return pending;
    if(this.inFlight.size>=60)return Promise.reject(new Error('CHAIN_HTTP_QUEUE_FULL'));
    const job=this.tail.catch(()=>{}).then(async()=>{
      let timeout:ReturnType<typeof deadline>|undefined;
      try {
        if(this.stopped)fail('CHAIN_STOPPED');
        await wait(this.nextAt-Date.now(),this.controller.signal);
        if(this.stopped)fail('CHAIN_STOPPED');this.nextAt=Date.now()+this.intervalMs;
        // Timestamp the start of this retrieval conservatively; cache reads never advance it.
        const fetchedAt=this.now();timeout=deadline(this.controller.signal,this.timeoutMs);
        const response=await abortable(this.fetcher(`https://api.dexscreener.com/token-pairs/v1/${chain}/${ca}`,{
          redirect:'error',signal:timeout.signal}),timeout.signal,cancel);
        const raw=await readJson(response,timeout.signal);
        if(this.stopped)fail('CHAIN_STOPPED');if(!Array.isArray(raw))fail('CHAIN_MARKET_REFERENCE_UNAVAILABLE');
        const seen=new Set<string>(),data:Record<string,any>[]=[];
        for(const p of raw) {
          if(!object(p)||p.chainId!==chain)continue;
          const pairAddress=chainAddress(chain,p.pairAddress),base=chainAddress(chain,p.baseToken?.address),quote=chainAddress(chain,p.quoteToken?.address);
          if(!pairAddress||!base||!quote||base===quote||(base!==ca&&quote!==ca)||seen.has(pairAddress))continue;
          seen.add(pairAddress);
          const liquidity=numeric(p.liquidity?.usd),price=numeric(p.priceUsd);
          // Retain only the fields used for pool discovery and explicitly labelled vendor references.
          data.push({chainId:chain,pairAddress,baseToken:{address:base},quoteToken:{address:quote},
            ...(liquidity!==undefined?{liquidity:{usd:liquidity}}:{}),...(price!==undefined&&price>0?{priceUsd:price}:{})});
        }
        data.sort((a,b)=>(b.liquidity?.usd??0)-(a.liquidity?.usd??0));
        const snapshot={fetchedAt,until:fetchedAt+45000,data:data.slice(0,20)};
        if(this.cache.size>=300&&!this.cache.has(key))this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key,snapshot);return snapshot;
      }catch(error){
        if(error instanceof DataError&&error.message==='CHAIN_HTTP_RATE_LIMITED')this.nextAt=Date.now()+error.retryMs;
        throw new Error(this.stopped?'CHAIN_STOPPED':timeout?.timedOut()?'CHAIN_HTTP_TIMEOUT':error instanceof DataError?error.message:'CHAIN_MARKET_REFERENCE_UNAVAILABLE');
      }finally{timeout?.close();}
    }).finally(()=>{this.inFlight.delete(key);});
    this.inFlight.set(key,job);this.tail=job;return job;
  }
  async pairs(chain:Chain,address:string):Promise<Record<string,any>[]> {
    const snapshot=await this.snapshot(chain,address);if(this.stopped)throw new Error('CHAIN_STOPPED');
    return structuredClone(snapshot.data);
  }
  async anchor(chain:Chain,address:string){
    if(this.stopped)throw new Error('CHAIN_STOPPED');
    const ca=chainAddress(chain,address),allowed=quoteAssets(chain);
    if(!ca||!allowed.includes(ca))throw new Error('CHAIN_USD_REFERENCE_UNAVAILABLE');
    const snapshot=await this.snapshot(chain,ca);if(this.stopped)throw new Error('CHAIN_STOPPED');
    const values=snapshot.data.filter(p=>p.baseToken.address===ca&&allowed.includes(p.quoteToken.address)&&
      Number.isFinite(p.liquidity?.usd)&&p.liquidity.usd>=10000&&Number.isFinite(p.priceUsd)&&p.priceUsd>0)
      .slice(0,5).map(p=>p.priceUsd as number).sort((a,b)=>a-b);
    if(!values.length)throw new Error('CHAIN_USD_REFERENCE_UNAVAILABLE');
    // A large disagreement is missing evidence, not an invitation to manufacture a USD conversion.
    if(values.at(-1)!/values[0]>1.25)throw new Error('CHAIN_USD_REFERENCE_INCONSISTENT');
    const middle=Math.floor(values.length/2),priceUsd=values.length%2?values[middle]:values[middle-1]/2+values[middle]/2;
    return {chain,address:ca,priceUsd,observedAt:new Date(snapshot.fetchedAt).toISOString(),source:'vendor_reference' as const};
  }
  stop(){this.stopped=true;this.controller.abort();this.cache.clear();}
}
