import {abortable,type Fetcher} from './http.js';
import {normalizePriceToken,normalizeDexPoolIdentity,createDexSpotNormalizer,priceFromInfo,GMGN_PRICE_CHAINS,
  type DexPoolIdentity,type DexSpotNormalizer,type DexSpotSample} from './market-price-normalizers.js';
import {fetchDebotPrice,DebotPriceError} from './providers/debot-price.js';
import {GmgnError,type GmgnClient} from './providers/gmgn-client.js';
import type {ScanPrice,ScanToken} from './scan-archive.js';

export type MarketPriceSource='dexscreener'|'gmgn'|'ave'|'debot'|'chain_pool';
export interface MarketPriceSample extends ScanPrice {
  receivedAt:string;validUntil:string;scope:'observed_spot_not_executable_quote';
  timeBasis:'provider_update'|'http_response'|'chain_sample';
}
export interface MarketPriceRoute {
  status:'available'|'unavailable'|'conflict';reason?:string;sample?:MarketPriceSample;
  sources:{source:MarketPriceSource;priceUsd:number;observedAt:string;validUntil:string}[];
}
export interface MarketPriceSourceStatus {
  state:'available'|'cooldown'|'unavailable';lastSuccessAt?:string;lastError?:string;cooldownUntil?:string;
}
export interface MarketPriceRouterStatus {
  scope:'observed_spot_not_executable_quote';running:boolean;
  sources:Record<MarketPriceSource,MarketPriceSourceStatus>;
  cachedTokens:number;freshTokens:number;conflictedTokens:number;
  lastBatch?:{startedAt:string;completedAt:string;requested:number;available:number;unavailable:number;conflicted:number};
}
export interface MarketPriceRouterOptions {
  client?:Pick<GmgnClient,'get'|'cooldownUntil'>&Partial<Pick<GmgnClient,'withSignal'>>;
  fetcher?:Fetcher;debotFetcher?:Fetcher;maxDebotPerBatch?:number;now?:()=>Date;httpTimeoutMs?:number;gmgnTimeoutMs?:number;maxGmgnPerBatch?:number;
  maxAgeMs?:number;maxSpreadPct?:number;
  preferStreams?:boolean;minHttpIntervalMs?:number;
}
export interface MarketPriceBatch {
  samples:MarketPriceSample[];gaps:{token:ScanToken;reason:string}[];
  requests:{dexscreener:number;gmgn:number;debot:number};sourceErrors:Partial<Record<MarketPriceSource,string>>;
}
export interface StreamPriceObservation {
  source:'ave'|'debot';token:ScanToken;priceUsd:number;eventAt:string;receivedAt:string;
  kind:'current_price_update';market?:ScanPrice['market'];
}
const SCOPE='observed_spot_not_executable_quote' as const;
const SOURCES:MarketPriceSource[]=['dexscreener','gmgn','ave','debot','chain_pool'];
const SOURCE_NAMES:Record<MarketPriceSource,string>={dexscreener:'dexscreener_token_pairs_sample',gmgn:'gmgn_token_info_sample',
  ave:'ave_price_stream_sample',debot:'debot_price_stream_sample',chain_pool:'chain_pool_sample'};
const MAX_DEX_TOKENS=30;
const MAX_DEX_ROWS=10_000;
// A response beyond either per-token ceiling is rejected as a whole. Never
// truncate pools: a discarded later row could contain a price conflict.
const MAX_DEX_ROWS_PER_TOKEN=2_048;
const MAX_DEX_POOLS_PER_TOKEN=512;
const MAX_DEX_POOLS_TOTAL=10_000;
const DEX_ROUTE_YIELD_ROWS=512;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const key=(t:ScanToken)=>`${t.chain}:${t.address}`;
const instant=(v:unknown):number|undefined=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):undefined;
const positive=(v:unknown):number|undefined=>typeof v==='number'&&Number.isFinite(v)&&v>0?v:undefined;
const bounded=(v:number,low:number,high:number)=>Number.isSafeInteger(v)&&v>=low&&v<=high;

/** Read-only spot observations. No route, signer, order endpoint, historical price or market-cap conversion. */
export class MarketPriceRouter {
  private readonly options:MarketPriceRouterOptions;
  private readonly now:()=>Date;
  private readonly fetcher:Fetcher;
  private readonly maxAge:number;
  private readonly spread:number;
  private readonly httpTimeout:number;
  private readonly gmgnTimeout:number;
  private readonly gmgnLimit:number;
  private readonly cache=new Map<string,Map<MarketPriceSource,MarketPriceSample>>();
  private readonly blocks=new Map<string,{source:MarketPriceSource;reason:string;until:number}>();
  private readonly published=new Map<string,number>();
  private readonly httpAttempts=new Map<string,number>();
  private readonly sourceState=new Map<MarketPriceSource,{lastSuccessAt?:string;lastError?:string;until:number}>();
  private readonly controllers=new Set<AbortController>();
  private closed=false;
  private gmgnCursor=0;
  private debotCursor=0;
  private lastBatch?:MarketPriceRouterStatus['lastBatch'];

  constructor(options:MarketPriceRouterOptions={}) {
    this.options=options;this.now=options.now??(()=>new Date());this.fetcher=options.fetcher??fetch;
    this.maxAge=options.maxAgeMs??30_000;this.spread=options.maxSpreadPct??20;
    this.httpTimeout=options.httpTimeoutMs??3500;this.gmgnTimeout=options.gmgnTimeoutMs??1500;
    this.gmgnLimit=options.maxGmgnPerBatch??1;
    if(!bounded(this.maxAge,1000,120_000)||!bounded(this.httpTimeout,1,15_000)||!bounded(this.gmgnTimeout,1,10_000)||
       !bounded(this.gmgnLimit,0,1)||!bounded(options.maxDebotPerBatch??2,0,3)||!bounded(options.minHttpIntervalMs??0,0,300000)||!Number.isFinite(this.spread)||this.spread<1||this.spread>100)
      throw new Error('PRICE_ROUTER_CONFIG_INVALID');
    for(const source of SOURCES)this.sourceState.set(source,{until:0});
  }

  close():void {this.closed=true;for(const controller of this.controllers)controller.abort();this.controllers.clear();}

  getStatus():MarketPriceRouterStatus {
    const now=this.now().getTime(),sources={} as Record<MarketPriceSource,MarketPriceSourceStatus>;
    for(const source of SOURCES) {
      const state=this.sourceState.get(source)!;
      const until=source==='gmgn'?Math.max(state.until,this.options.client?.cooldownUntil??0):state.until;
      sources[source]={state:until>now?'cooldown':state.lastSuccessAt&&now-Date.parse(state.lastSuccessAt)<this.maxAge&&now>=Date.parse(state.lastSuccessAt)&&!state.lastError?'available':'unavailable',
        ...(state.lastSuccessAt?{lastSuccessAt:state.lastSuccessAt}:{}),...(state.lastError?{lastError:state.lastError}:{}),
        ...(until>now?{cooldownUntil:new Date(until).toISOString()}:{} )};
    }
    let freshTokens=0,conflictedTokens=0;
    for(const entries of this.cache.values()) {
      const sample=entries.values().next().value;if(!sample)continue;
      const route=this.latest(sample);if(route.status==='available')freshTokens++;else if(route.status==='conflict')conflictedTokens++;
    }
    return {scope:SCOPE,running:!this.closed,sources,cachedTokens:this.cache.size,freshTokens,conflictedTokens,
      ...(this.lastBatch?{lastBatch:{...this.lastBatch}}:{})};
  }

  latest(raw:ScanToken):MarketPriceRoute {
    const token=normalizePriceToken(raw),now=this.now().getTime();
    if(!token||this.closed)return {status:'unavailable',reason:this.closed?'PRICE_ROUTER_STOPPED':'PRICE_TOKEN_INVALID',sources:[]};
    const entries=[...(this.cache.get(key(token))?.entries()??[])].filter(([,s])=>Date.parse(s.observedAt)<=now&&Date.parse(s.validUntil)>now);
    const sources=entries.map(([source,s])=>({source,priceUsd:s.priceUsd,observedAt:s.observedAt,validUntil:s.validUntil}));
    const blocked=this.blocks.get(key(token));
    if(blocked&&blocked.until>now)return {status:'conflict',reason:blocked.reason,sources};
    if(!entries.length)return {status:'unavailable',reason:'PRICE_NO_FRESH_SOURCE',sources};
    // Meme moves over tens of seconds are real time differences, not cross-source disagreements.
    // Compare only near-simultaneous prices; retain all fresh source timestamps for inspection.
    const newest=Math.max(...entries.map(([,s])=>Date.parse(s.observedAt)));
    const prices=entries.filter(([,s])=>newest-Date.parse(s.observedAt)<=5000).map(([,s])=>s.priceUsd);
    if((Math.max(...prices)/Math.min(...prices)-1)*100>this.spread)return {status:'conflict',reason:'PRICE_SOURCE_CONFLICT',sources};
    // Prefer the newest actual observation. Priority only breaks ties; a cache hit never receives a new timestamp.
    entries.sort((a,b)=>Date.parse(b[1].observedAt)-Date.parse(a[1].observedAt)||SOURCES.indexOf(a[0])-SOURCES.indexOf(b[0]));
    return {status:'available',sample:structuredClone(entries[0][1]),sources};
  }

  observeStream(input:StreamPriceObservation):boolean {
    if(!object(input)||!['ave','debot'].includes(input.source)||input.kind!=='current_price_update')return false;
    return this.accept(input.source,input.token,input.priceUsd,input.eventAt,input.receivedAt,'provider_update',input.market);
  }

  /** Preserve the actual provider timestamp, including when it becomes stale.
   * HTTP observations can never make a silent websocket appear recovered. */
  latestStream(raw:ScanToken):MarketPriceSample|undefined {
    const token=normalizePriceToken(raw);if(!token||this.closed)return;
    const samples=[...(this.cache.get(key(token))?.values()??[])].filter(sample=>
      sample.timeBasis==='provider_update'&&['ave_price_stream_sample','debot_price_stream_sample'].includes(sample.source));
    samples.sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
    return samples[0]?structuredClone(samples[0]):undefined;
  }

  observeChainSample(input:ScanPrice):boolean {
    if(!object(input)||input.source!=='chain_pool_sample')return false;
    return this.accept('chain_pool',input,input.priceUsd,input.observedAt,this.now().toISOString(),'chain_sample',input.market,input.metadata);
  }

  /** Verified against public ave.ai's PRICEV2 subscriber and live ws frames on 2026-10-16.
   * uprice is current USD; last_price is NOT substituted. time is provider Unix seconds. */
  ingestAvePriceFrame(payload:unknown,receivedAt=this.now().toISOString(),onSample?:(sample:MarketPriceSample)=>void):number {
    if(typeof payload==='string') {if(payload.length>2_000_000)return 0;try {payload=JSON.parse(payload);}catch{return 0;}}
    if(!object(payload)||!object(payload.result)||payload.result.status!=='ok'||!object(payload.result.data)||
      payload.result.data.event!=='pricev2'||!Array.isArray(payload.result.data.prices))return 0;
    let accepted=0;const changed=new Map<string,ScanToken>();
    for(const row of payload.result.data.prices.slice(0,200)) {
      if(!object(row)||row.is_main_pair!==true||!['bsc','solana','robinhood'].includes(String(row.chain)))continue;
      const token=normalizePriceToken({chain:row.chain,address:row.token}),target=normalizePriceToken({chain:row.chain,address:row.target_token});
      if(!token||!target||key(token)!==key(target)||!Number.isSafeInteger(row.time)||Number(row.time)<=0||Number(row.time)>8.64e12)continue;
      const price=positive(row.uprice);if(price===undefined)continue;
      const pool=normalizePriceToken({chain:token.chain,address:row.pair});
      const market={...(pool&&pool.address!==token.address?{poolAddress:pool.address}:{})};
      if(this.observeStream({source:'ave',token,priceUsd:price,eventAt:new Date(Number(row.time)*1000).toISOString(),receivedAt,
        kind:'current_price_update',...(Object.keys(market).length?{market}:{})})) {accepted++;changed.set(key(token),token);}
    }
    // Finish this entire frame first: conflicting duplicate rows must never publish the first price.
    for(const token of changed.values())this.publish(token,onSample);
    return accepted;
  }

  async read(rawTokens:ScanToken[],options:{signal?:AbortSignal;onSample?:(sample:MarketPriceSample)=>void}={}):Promise<MarketPriceBatch> {
    this.prune();
    const startedAt=this.now().toISOString(),result:MarketPriceBatch={samples:[],gaps:[],requests:{dexscreener:0,gmgn:0,debot:0},sourceErrors:{}};
    const tokens=[...new Map(rawTokens.slice(0,200).map(normalizePriceToken).filter((t):t is ScanToken=>!!t).map(t=>[key(t),t])).values()];
    if(this.closed||options.signal?.aborted)return {...result,gaps:tokens.map(token=>({token,reason:'PRICE_REQUEST_CANCELLED'}))};
    const controller=new AbortController();this.controllers.add(controller);
    const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
    const publish=(token:ScanToken)=>this.publish(token,options.onSample,signal);
    try {
      // Existing genuinely fresh stream/chain observations are useful even during slow HTTP requests.
      for(const token of tokens)publish(token);
      const now=this.now().getTime();
      const httpTokens=tokens.filter(token=>{
        const route=this.latest(token),stream=this.latestStream(token);
        if(this.options.preferStreams&&route.status==='available'&&
          ((stream&&Date.parse(stream.validUntil)>now)||route.sample?.timeBasis==='chain_sample'))return false;
        return now-(this.httpAttempts.get(key(token))??-Infinity)>=(this.options.minHttpIntervalMs??0);
      });
      // Reserve before awaiting network work, so independent monitoring loops
      // cannot duplicate fallback requests for the same holding.
      for(const token of httpTokens)this.httpAttempts.set(key(token),now);
      if(this.httpAttempts.size>2000)for(const [id,at] of this.httpAttempts)
        if(now-at>300000)this.httpAttempts.delete(id);
      await Promise.all(['bsc','solana','robinhood'].map(async chain=>{
        const chainTokens=httpTokens.filter(token=>token.chain===chain);
        for(let start=0;start<chainTokens.length&&!signal.aborted;start+=30) {
          const batch=chainTokens.slice(start,start+30);
          if(this.cooling('dexscreener')) {result.sourceErrors.dexscreener='PRICE_SOURCE_COOLDOWN';break;}
          result.requests.dexscreener++;
          try {
            await this.deadline(signal,this.httpTimeout,scope=>this.readDex(batch,scope));
            for(const token of batch)publish(token);
          } catch(error) {
            if(signal.aborted)break;
            const code=this.code(error,'DEX_PRICE_UNAVAILABLE');result.sourceErrors.dexscreener=code;
            this.failure('dexscreener',code);break;
          }
        }
      }));
      const missing=httpTokens.filter(token=>this.latest(token).status==='unavailable');
      const debotCandidates=missing;
      const debotLimit=Math.min(this.options.maxDebotPerBatch??2,debotCandidates.length);
      const debotTokens=Array.from({length:debotLimit},(_,i)=>debotCandidates[(this.debotCursor+i)%debotCandidates.length]);
      this.debotCursor+=debotLimit;
      const assigned=new Set(debotTokens.map(key));
      const runGmgn=async(candidates:ScanToken[])=>{
        if(!signal.aborted&&candidates.length&&this.gmgnLimit&&this.options.client&&!this.cooling('gmgn')) {
          const token=candidates[this.gmgnCursor++%candidates.length];result.requests.gmgn++;
          try {await this.deadline(signal,this.gmgnTimeout,scope=>this.readGmgn(token,scope));publish(token);}
          catch(error) {if(!signal.aborted) {const code=this.code(error,'GMGN_PRICE_UNAVAILABLE');result.sourceErrors.gmgn=code;this.failure('gmgn',code,error);}}
        } else if(candidates.length&&this.cooling('gmgn'))result.sourceErrors.gmgn='GMGN_RATE_LIMITED';
      };
      // A slow/limited fallback never holds up another source's successful onSample callback.
      await Promise.all([
        ...debotTokens.map(async token=>{
          if(signal.aborted)return;
          if(this.cooling('debot')) {result.sourceErrors.debot='PRICE_SOURCE_COOLDOWN';return;}
          result.requests.debot++;
          try {
            await this.deadline(signal,this.httpTimeout,async scope=>{
              const began=this.now().getTime();
              const sample=await fetchDebotPrice(token,{fetcher:this.options.debotFetcher??this.fetcher,signal:scope,now:this.now});
              scope.throwIfAborted();if(this.now().getTime()<began)throw new Error('PRICE_CLOCK_REGRESSED');
              if(!sample||!this.accept('debot',token,sample.priceUsd,sample.observedAt,this.now().toISOString(),'http_response',sample.market,undefined,'debot_token_info_sample'))
                throw new Error('PRICE_SAMPLE_REJECTED');
            });publish(token);
          }catch(error) {if(!signal.aborted) {const code=this.code(error,'DEBOT_PRICE_UNAVAILABLE');result.sourceErrors.debot=code;this.failure('debot',code,error);}}
        }),
        runGmgn(missing.filter(token=>!assigned.has(key(token)))),
      ]);
      if(!result.requests.gmgn)await runGmgn(missing.filter(token=>this.latest(token).status==='unavailable'));
      for(const token of tokens) {
        const route=this.latest(token);
        if(signal.aborted)result.gaps.push({token,reason:'PRICE_REQUEST_CANCELLED'});
        else if(route.sample)result.samples.push(route.sample);
        else result.gaps.push({token,reason:route.reason??'PRICE_NO_FRESH_SOURCE'});
      }
    } finally {
      this.controllers.delete(controller);
      this.lastBatch={startedAt,completedAt:this.now().toISOString(),requested:tokens.length,available:result.samples.length,
        unavailable:result.gaps.filter(g=>!g.reason.includes('CONFLICT')).length,conflicted:result.gaps.filter(g=>g.reason.includes('CONFLICT')).length};
    }
    return result;
  }

  private publish(token:ScanToken,onSample?:((sample:MarketPriceSample)=>void),signal?:AbortSignal):boolean {
    if(signal?.aborted||this.closed||!onSample)return false;
    const route=this.latest(token),sample=route.sample;if(route.status!=='available'||!sample)return false;
    const at=Date.parse(sample.observedAt);if(at<=(this.published.get(key(token))??-Infinity))return false;
    onSample(sample);this.published.set(key(token),at);return true;
  }

  private accept(source:MarketPriceSource,rawToken:ScanToken,priceUsd:number,eventAt:string,receivedAt:string,
    timeBasis:MarketPriceSample['timeBasis'],market?:ScanPrice['market'],metadata?:ScanPrice['metadata'],sampleSource=SOURCE_NAMES[source]):boolean {
    const token=normalizePriceToken(rawToken),at=instant(eventAt),received=instant(receivedAt),now=this.now().getTime();
    if(this.closed||!token||positive(priceUsd)===undefined||at===undefined||received===undefined||
       at>received||received>now||now-at>=this.maxAge||now-received>=this.maxAge)return false;
    const id=key(token),entries=this.cache.get(id)??new Map<MarketPriceSource,MarketPriceSample>(),prior=entries.get(source);
    if(prior&&at<Date.parse(prior.observedAt))return false;
    if(prior&&at===Date.parse(prior.observedAt)) {
      if(priceUsd!==prior.priceUsd)this.blocks.set(id,{source,reason:'PRICE_SAME_TIME_CONFLICT',until:at+this.maxAge});
      return false;
    }
    const sample:MarketPriceSample={...token,priceUsd,observedAt:new Date(at).toISOString(),receivedAt:new Date(received).toISOString(),
      validUntil:new Date(at+this.maxAge).toISOString(),scope:SCOPE,source:sampleSource,timeBasis,
      ...(market?{market:structuredClone(market)}:{}),...(metadata?{metadata:structuredClone(metadata)}:{})};
    entries.set(source,sample);this.cache.delete(id);this.cache.set(id,entries);
    if(this.blocks.get(id)?.source===source)this.blocks.delete(id);
    const state=this.sourceState.get(source)!;state.lastSuccessAt=new Date(received).toISOString();delete state.lastError;state.until=0;
    while(this.cache.size>2000) {const oldest=this.cache.keys().next().value!;this.cache.delete(oldest);this.blocks.delete(oldest);this.published.delete(oldest);}
    return true;
  }

  private prune():void {
    const now=this.now().getTime();
    for(const [id,block]of this.blocks)if(block.until<=now)this.blocks.delete(id);
    while(this.blocks.size>2000)this.blocks.delete(this.blocks.keys().next().value!);
  }
  private cooling(source:MarketPriceSource):boolean {
    return Math.max(this.sourceState.get(source)!.until,source==='gmgn'?(this.options.client?.cooldownUntil??0):0)>this.now().getTime();
  }
  private code(error:unknown,fallback:string):string {
    if(error instanceof GmgnError||error instanceof DebotPriceError)return error.reason;
    return error instanceof Error&&/^(?:PRICE|DEX_PRICE|GMGN_PRICE)_[A-Z_]+$/.test(error.message)?error.message:fallback;
  }
  private failure(source:MarketPriceSource,code:string,error?:unknown):void {
    const state=this.sourceState.get(source)!;state.lastError=code;
    const now=this.now().getTime(),rate=code.includes('RATE_LIMITED');
    const advertised=error instanceof GmgnError&&error.cooldownUntil?Date.parse(error.cooldownUntil):error instanceof DebotPriceError?(error.cooldownUntil??0):0;
    state.until=Math.max(state.until,now+(rate?60_000:5_000),Number.isFinite(advertised)?Math.min(advertised,now+300_000):0);
  }
  private async deadline<T>(parent:AbortSignal,ms:number,work:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('PRICE_SOURCE_TIMEOUT')),ms);
    const signal=AbortSignal.any([parent,controller.signal]);
    try {signal.throwIfAborted();return await abortable(work(signal),signal);}finally{clearTimeout(timer);}
  }
  private async readGmgn(token:ScanToken,signal:AbortSignal):Promise<void> {
    signal.throwIfAborted();const began=this.now().getTime();
    const client=this.options.client!.withSignal?.(signal)??this.options.client!;
    const raw=await abortable(client.get('/v1/token/info',{chain:GMGN_PRICE_CHAINS[token.chain],address:token.address},1),signal);
    signal.throwIfAborted();const price=priceFromInfo(raw,token);if('reason' in price)throw new Error(price.reason);
    if(this.now().getTime()<began)throw new Error('PRICE_CLOCK_REGRESSED');
    const at=this.now().toISOString();if(!this.accept('gmgn',token,price.priceUsd,at,at,'http_response',price.market))throw new Error('PRICE_SAMPLE_REJECTED');
  }
  private async readDex(tokens:ScanToken[],signal:AbortSignal):Promise<void> {
    const began=this.now().getTime(),chain=tokens[0]?.chain;
    if(!chain||tokens.length>MAX_DEX_TOKENS||tokens.some(token=>token.chain!==chain))throw new Error('DEX_PRICE_INPUT_INVALID');
    // Official DEX Screener GET /tokens/v1/{chainId}/{tokenAddresses}, at most 30 full addresses.
    const response=await abortable(this.fetcher(`https://api.dexscreener.com/tokens/v1/${chain}/${tokens.map(t=>t.address).join(',')}`,
      {method:'GET',redirect:'error',credentials:'omit',headers:{accept:'application/json'},signal}),signal);
    if(response.status===429) {
      const retry=response.headers.get('retry-after'),seconds=retry&&/^\d+$/.test(retry)?Number(retry):undefined;
      const until=seconds!==undefined?began+Math.min(300,seconds)*1000:retry?Date.parse(retry):NaN;
      if(Number.isFinite(until))this.sourceState.get('dexscreener')!.until=Math.min(began+300_000,until);
      void response.body?.cancel().catch(()=>{});throw new Error('DEX_PRICE_RATE_LIMITED');
    }
    if(!response.ok) {void response.body?.cancel().catch(()=>{});throw new Error('DEX_PRICE_HTTP_ERROR');}
    const age=response.headers.get('age');
    if(age!==null&&(!/^\d+$/.test(age)||Number(age)*1000>=this.maxAge)) {void response.body?.cancel().catch(()=>{});throw new Error('DEX_PRICE_STALE_RESPONSE');}
    const raw=await this.readJson(response,signal);signal.throwIfAborted();
    if(!Array.isArray(raw)||raw.length>MAX_DEX_ROWS)throw new Error('DEX_PRICE_SCHEMA_INVALID');
    const completed=this.now().getTime();if(completed<began)throw new Error('PRICE_CLOCK_REGRESSED');
    const receivedAt=new Date(completed).toISOString(),atMs=completed-Number(age??0)*1000,at=new Date(atMs).toISOString();let accepted=0;
    const requested=new Map<string,{token:ScanToken;normalize:DexSpotNormalizer}>();
    for(const token of tokens) {const normalize=createDexSpotNormalizer(token,at);if(normalize)requested.set(token.address,{token,normalize});}
    const indexed=new Map<string,Map<string,DexSpotSample|null>>();
    const poolIdentities=new Map<string,DexPoolIdentity|null>();
    const matchedRows=new Map<string,number>();
    // A token-address index turns the provider's bounded response into one pass.
    // Looking up the base address before normalization also avoids expensive
    // Solana decoding for unrelated or malformed rows.
    for(let index=0;index<raw.length;index++) {
      if(index&&index%DEX_ROUTE_YIELD_ROWS===0) {await new Promise<void>(resolve=>setImmediate(resolve));signal.throwIfAborted();}
      const row=raw[index];
      if(!object(row)||row.chainId!==chain||!object(row.baseToken)||typeof row.baseToken.address!=='string')continue;
      if(chain==='solana'?(row.baseToken.address.length<32||row.baseToken.address.length>44):row.baseToken.address.length!==42)continue;
      const address=chain==='solana'?row.baseToken.address:row.baseToken.address.toLowerCase();
      const target=requested.get(address);if(!target)continue;const {token,normalize}=target;
      const count=(matchedRows.get(token.address)??0)+1;matchedRows.set(token.address,count);
      if(count>MAX_DEX_ROWS_PER_TOKEN)throw new Error('DEX_PRICE_TOKEN_ROWS_EXCEEDED');
      if(typeof row.pairAddress!=='string')continue;
      if(chain==='solana'?(row.pairAddress.length<32||row.pairAddress.length>44):row.pairAddress.length!==42&&row.pairAddress.length!==66)continue;
      let pool=poolIdentities.get(row.pairAddress);
      if(pool===undefined&&!poolIdentities.has(row.pairAddress)) {
        if(poolIdentities.size>=MAX_DEX_POOLS_TOTAL)throw new Error('DEX_PRICE_POOL_LIMIT_EXCEEDED');
        pool=normalizeDexPoolIdentity(chain,row.pairAddress)??null;poolIdentities.set(row.pairAddress,pool);
      }
      const sample=normalize(row,pool);if(!sample)continue;
      let pools=indexed.get(token.address);if(!pools){pools=new Map();indexed.set(token.address,pools);}
      const prior=pools.get(sample.poolKey);
      if(prior===undefined) {
        if(pools.size>=MAX_DEX_POOLS_PER_TOKEN)throw new Error('DEX_PRICE_TOKEN_POOL_LIMIT_EXCEEDED');
        pools.set(sample.poolKey,sample);
      }
      else if(prior&&prior.priceUsd!==sample.priceUsd)pools.set(sample.poolKey,null);
    }
    for(const token of tokens) {
      const pools=indexed.get(token.address);if(!pools)continue;
      let best:DexSpotSample|undefined,poolConflict=false;
      for(const candidate of pools.values()) {
        if(!candidate){poolConflict=true;break;}
        const liquidity=candidate.liquidityUsd??-1,bestLiquidity=best?.liquidityUsd??-1;
        if(!best||liquidity>bestLiquidity||liquidity===bestLiquidity&&candidate.poolKey.localeCompare(best.poolKey)<0)best=candidate;
      }
      if(poolConflict) {this.blocks.set(key(token),{source:'dexscreener',reason:'PRICE_POOL_CONFLICT',until:atMs+this.maxAge});continue;}
      if(!best)continue;
      // Disagreement between substantial pools is a real ambiguity, never a manufactured gain.
      const threshold=Math.max(100,(best.liquidityUsd??0)*0.1);let relevant=0,min=Infinity,max=-Infinity;
      for(const candidate of pools.values())if(candidate&&(candidate.liquidityUsd??0)>=threshold) {
        relevant++;min=Math.min(min,candidate.priceUsd);max=Math.max(max,candidate.priceUsd);
      }
      if(relevant>1&&(max/min-1)*100>this.spread) {
        this.blocks.set(key(token),{source:'dexscreener',reason:'PRICE_POOL_CONFLICT',until:atMs+this.maxAge});continue;
      }
      if(this.accept('dexscreener',token,best.priceUsd!,at,receivedAt,'http_response',{
        ...(best.poolAddress?{poolAddress:best.poolAddress}:{}),...(best.liquidityUsd!==undefined?{liquidityUsd:best.liquidityUsd}:{})}))accepted++;
    }
    if(accepted) {const state=this.sourceState.get('dexscreener')!;state.lastSuccessAt=receivedAt;delete state.lastError;state.until=0;}
    else this.sourceState.get('dexscreener')!.lastError='DEX_PRICE_NO_MATCHING_CURRENT_PRICE';
  }
  private async readJson(response:Response,signal:AbortSignal):Promise<unknown> {
    const declared=response.headers.get('content-length');
    if(declared&&/^\d+$/.test(declared)&&Number(declared)>2_000_000) {void response.body?.cancel().catch(()=>{});throw new Error('DEX_PRICE_TOO_LARGE');}
    const reader=response.body?.getReader();if(!reader)throw new Error('DEX_PRICE_SCHEMA_INVALID');
    const chunks:Uint8Array[]=[];let length=0,done=false;
    try {
      while(true) {const next=await abortable(reader.read(),signal);if(next.done){done=true;break;}
        length+=next.value.byteLength;if(length>2_000_000||chunks.length>=65_536)throw new Error('DEX_PRICE_TOO_LARGE');chunks.push(next.value);}
      const body=new Uint8Array(length);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
      try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(body));}catch{throw new Error('DEX_PRICE_SCHEMA_INVALID');}
    } finally {if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
  }
}
