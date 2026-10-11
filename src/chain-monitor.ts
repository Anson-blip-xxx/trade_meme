import bs58 from 'bs58';
import type {Config} from './config.js';
import type {Chain} from './types.js';
import type {ScanPrice,ScanToken} from './scan-archive.js';
import {RpcStream,type RpcSubscription,type RpcStreamStatus} from './rpc-stream.js';
import {ChainHttp,DexPoolData} from './chain-data.js';
import {ChainStreamStore,chainAddress,evmTransfers,solWalletEvent,object,hexNumber,TRANSFER_TOPIC} from './chain-stream-store.js';
import {discoverPool,readPoolPrice,type VerifiedPool} from './chain-prices.js';

interface WatchedPool {token:ScanToken;pool:VerifiedPool;subscriptions:RpcSubscription[];sampledAt?:number;validUntil?:number;sampledGeneration?:number;dirty:boolean;lastError?:string;}
type MonitorRpc=Pick<ChainHttp,'request'|'stop'>;
type MonitorStream=Pick<RpcStream,'start'|'stop'|'getStatus'|'request'|'setSubscriptions'|'forceReconnect'>;
interface Context {
  chain:Chain;rpc:MonitorRpc;stream:MonitorStream;wallets:Set<string>;pools:Map<string,WatchedPool>;unsupported:Map<string,{retryAt:number;reason:string}>;
  targets:ScanToken[];identityGeneration?:number;checkingGeneration?:number;lastHeadAt?:string;head?:number;
  events:number;poolPriceSamples:number;lastError?:string;busy:boolean;walletIndex:number;lastTargetsAt?:number;backfilled:Set<string>;
  gap:{pending:boolean;incomplete:boolean;lastCompletedAt?:string};
}
export interface ChainMonitorClock {now():number;setInterval(callback:()=>void,ms:number):unknown;clearInterval(handle:unknown):void;}
export interface ChainMonitorOptions {
  config:Config['chainStream'];tokens:()=>ScanToken[];wallets:(chain:Chain,limit:number)=>string[];onPrice:(price:ScanPrice)=>void;
  store?:ChainStreamStore;market?:Pick<DexPoolData,'pairs'|'anchor'|'stop'>;httpFactory?:(url:string)=>MonitorRpc;
  streamFactory?:(options:ConstructorParameters<typeof RpcStream>[0])=>MonitorStream;
  clock?:ChainMonitorClock;discoverPool?:typeof discoverPool;readPoolPrice?:typeof readPoolPrice;
}
const CHAINS:Chain[]=['bsc','solana','robinhood'];
// Full mainnet-beta getGenesisHash value, not the shortened CAIP chain reference.
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const safeCode=(error:unknown,fallback:string)=>error instanceof Error&&/^(CHAIN|POOL|RPC)_[A-Z_]+$/.test(error.message)?error.message:fallback;
const topic=(wallet:string)=>'0x'+wallet.slice(2).padStart(64,'0');
const qty=(n:number)=>'0x'+n.toString(16);
const signature=(value:unknown):value is string=>{try{return typeof value==='string'&&value.length>=64&&value.length<=88&&bs58.decode(value).length===64;}catch{return false;}};
/** ERC721 shares Transfer's signature but indexes the token ID; it is not a fungible transfer. */
function canonicalNftTransfer(chain:Chain,log:unknown,wallet:string,direction:'from'|'to',start:number,end:number):boolean {
  if(!object(log)||!Array.isArray(log.topics)||log.topics.length!==4||log.topics[0]!==TRANSFER_TOPIC||log.data!=='0x'||
    !log.topics.slice(1,3).every((value:unknown)=>typeof value==='string'&&/^0x0{24}[\da-f]{40}$/i.test(value))||
    typeof log.topics[3]!=='string'||!/^0x[\da-f]{64}$/i.test(log.topics[3])||!chainAddress(chain,log.address)||
    typeof log.transactionHash!=='string'||!/^0x[\da-f]{64}$/i.test(log.transactionHash)||
    typeof log.blockHash!=='string'||!/^0x[\da-f]{64}$/i.test(log.blockHash)||log.removed===true)return false;
  const block=hexNumber(log.blockNumber),index=hexNumber(log.logIndex);
  return block!==undefined&&block>=start&&block<=end&&index!==undefined&&
    '0x'+log.topics[direction==='from'?1:2].slice(-40).toLowerCase()===wallet;
}
const nativeClock:ChainMonitorClock={now:()=>Date.now(),setInterval:(callback,ms)=>{const timer=setInterval(callback,ms);timer.unref();return timer;},
  clearInterval:handle=>clearInterval(handle as ReturnType<typeof setInterval>)};
/** Targeted read-only chain observations. No signing, order submission, ownership conclusions, or historical price replay. */
export class ChainMonitor {
  private readonly store:ChainStreamStore;private readonly market:NonNullable<ChainMonitorOptions['market']>;private readonly clock:ChainMonitorClock;
  private contexts=new Map<Chain,Context>();private running=false;private timer?:unknown;private jobs=new Set<Promise<unknown>>();private closed=false;
  constructor(private options:ChainMonitorOptions) {
    this.store=options.store??new ChainStreamStore(options.config.database,options.config.maxBytes);this.market=options.market??new DexPoolData();this.clock=options.clock??nativeClock;
    if(!options.config.enabled)return;
    for(const chain of CHAINS) {
      const endpoint=options.config.endpoints[chain];if(!endpoint)continue;
      const rpc=options.httpFactory?.(endpoint.http)??new ChainHttp(endpoint.http);
      const context={} as Context;
      const stream=(options.streamFactory??(o=>new RpcStream(o)))({url:endpoint.ws,maxSubscriptions:Math.max(80,1+options.config.maxWallets+3*options.config.maxPools),
        heartbeat:chain==='solana'?{mode:'message_idle',intervalMs:15000,timeoutMs:45000}:
          {method:'eth_chainId',intervalMs:15000,timeoutMs:10000},
        onNotification:(key,data,meta)=>{if(this.current(context,meta.generation))this.notification(context,key,data);},
        onStatus:status=>this.connection(context,status)});
      Object.assign(context,{chain,rpc,stream,wallets:new Set(),pools:new Map(),unsupported:new Map(),targets:[],backfilled:new Set(),
        events:0,poolPriceSamples:0,busy:false,walletIndex:0,gap:{pending:true,incomplete:false}});
      this.contexts.set(chain,context);
    }
  }
  start(){if(this.running||this.closed||!this.options.config.enabled)return;this.running=true;
    for(const c of this.contexts.values()){this.subscriptions(c);c.stream.start();}
    this.timer=this.clock.setInterval(()=>this.tick(),5000);this.tick();}
  async stop(){if(this.closed)return;this.running=false;this.closed=true;if(this.timer!==undefined)this.clock.clearInterval(this.timer);this.timer=undefined;
    for(const c of this.contexts.values()){c.identityGeneration=undefined;c.stream.stop();c.rpc.stop();}this.market.stop();
    await Promise.allSettled([...this.jobs]);this.store.close();}
  private fresh(at:number|undefined,maxAge:number):boolean {const age=this.clock.now()-(at??NaN);return Number.isFinite(age)&&age>=0&&age<maxAge;}
  private current(c:Context,generation:number):boolean {
    if(!this.running||!c.stream)return false;const status=c.stream.getStatus();
    return status.state==='open'&&status.generation===generation&&c.identityGeneration===generation;
  }
  covers(token:ScanToken):boolean {
    const c=this.contexts.get(token.chain),address=chainAddress(token.chain,token.address),p=address?c?.pools.get(address):undefined;if(!c||!p)return false;
    const status=c.stream.getStatus();return this.current(c,status.generation)&&p.sampledGeneration===status.generation&&
      this.fresh(Date.parse(c.lastHeadAt??''),45000)&&this.fresh(p.sampledAt,90000)&&this.clock.now()<(p.validUntil??0)&&!p.lastError&&status.activeKeys.includes('head')&&
      p.subscriptions.length>0&&p.subscriptions.every(s=>status.activeKeys.includes(s.key));
  }
  getStatus(){return {enabled:this.options.config.enabled,running:this.running,mode:'observation_only',coverage:'targeted_observation',
    scope:'evm_erc20_transfers_and_solana_wallet_mentions',chains:CHAINS.map(chain=>{
      const c=this.contexts.get(chain);if(!c)return {chain,state:'disabled',identityVerified:false,watchedWallets:0,watchedPools:0};
      const s=c.stream.getStatus(),verified=this.current(c,s.generation);
      const live=verified&&this.fresh(Date.parse(c.lastHeadAt??''),45000)&&s.activeSubscriptions===s.desiredSubscriptions;
      const covered=c.targets.filter(t=>this.covers(t)).length,latest=Math.max(0,...[...c.pools.values()].map(p=>p.sampledAt??0));
      return {chain,state:!this.running?'disabled':s.state==='connecting'?'connecting':s.state==='backoff'?'reconnecting':live?'live':'degraded',
        identityVerified:verified,identityScope:chain==='solana'?'paired_http_rpc':'http_rpc_and_evm_ws',
        activeSubscriptions:s.activeSubscriptions,desiredSubscriptions:s.desiredSubscriptions,reconnects:s.reconnects,
        lastMessageAt:s.lastMessageAt?new Date(s.lastMessageAt).toISOString():undefined,lastHeadAt:c.lastHeadAt,
        watchedWallets:c.wallets.size,watchedPools:c.pools.size,coveredPrices:covered,unsupportedPools:c.unsupported.size,
        fallbackTokens:Math.max(0,c.targets.length-covered),latestPriceAt:latest?new Date(latest).toISOString():undefined,
        lastError:c.lastError??s.lastError,gap:{...c.gap},events:c.events,poolPriceSamples:c.poolPriceSamples};}),
      store:this.store.stats(),recentEvents:this.store.recent()};}
  private run(work:Promise<unknown>){this.jobs.add(work);void work.catch(()=>{}).finally(()=>this.jobs.delete(work));}
  private connection(c:Context,status:RpcStreamStatus){
    if(!this.running||!c.stream)return;
    if(status.state!=='open'){c.identityGeneration=undefined;c.lastHeadAt=undefined;c.head=undefined;c.backfilled.clear();c.gap.pending=true;return;}
    if(c.checkingGeneration===status.generation||c.identityGeneration===status.generation)return;
    c.checkingGeneration=status.generation;const generation=status.generation;
    this.run((async()=>{
      try {
        if(c.chain==='solana') {if(await c.rpc.request('getGenesisHash')!==GENESIS)throw new Error('CHAIN_IDENTITY_MISMATCH');}
        else {const expected=c.chain==='bsc'?56:4663;
          const [http,ws]=await Promise.all([c.rpc.request('eth_chainId'),c.stream.request('eth_chainId')]);
          if(hexNumber(http)!==expected||hexNumber(ws)!==expected)throw new Error('CHAIN_IDENTITY_MISMATCH');}
        const status=c.stream.getStatus();if(!this.running||status.generation!==generation||status.state!=='open')return;
        c.identityGeneration=generation;c.lastError=undefined;c.gap.pending=true;c.lastTargetsAt=undefined;this.tick();
      }catch(error){const status=c.stream.getStatus();if(this.running&&status.generation===generation&&status.state==='open'){
        c.lastError=safeCode(error,'CHAIN_IDENTITY_CHECK_FAILED');c.stream.forceReconnect('RPC_CHAIN_IDENTITY_MISMATCH');}}
      finally{if(c.checkingGeneration===generation)c.checkingGeneration=undefined;}
    })());
  }
  private tick(){if(!this.running)return;for(const c of this.contexts.values()){
    const generation=c.stream.getStatus().generation;
    if(c.busy||!this.current(c,generation))continue;c.busy=true;
    this.run(this.cycle(c,generation).catch(e=>{if(this.current(c,generation)){c.lastError=safeCode(e,'CHAIN_COLLECTION_FAILED');c.gap.pending=true;c.backfilled.clear();}})
      .finally(()=>{c.busy=false;}));}}
  private async cycle(c:Context,generation:number){
    if(!this.current(c,generation))return;
    if(c.lastTargetsAt===undefined||this.clock.now()-c.lastTargetsAt>=60000){
      const wallets=new Set(this.options.wallets(c.chain,this.options.config.maxWallets).map(a=>chainAddress(c.chain,a)).filter((a):a is string=>!!a).slice(0,this.options.config.maxWallets));
      if(wallets.size!==c.wallets.size||[...wallets].some(w=>!c.wallets.has(w))){c.backfilled.clear();c.gap.pending=true;c.walletIndex=0;}
      c.wallets=wallets;
      const targets=new Map<string,ScanToken>();
      for(const token of this.options.tokens())if(token.chain===c.chain){const address=chainAddress(c.chain,token.address);if(address)targets.set(address,{...token,address});}
      c.targets=[...targets.values()];
      // Ranking changes do not evict a still-watched pool. Unsupported candidates use no pool slot.
      for(const address of c.pools.keys())if(!targets.has(address))c.pools.delete(address);
      for(const address of c.unsupported.keys())if(!targets.has(address))c.unsupported.delete(address);
      c.lastTargetsAt=this.clock.now();this.subscriptions(c);
    }
    if(!this.current(c,generation))return;
    // At most one discovery per cycle; unsuccessful protocols retry after ten minutes.
    const candidate=c.pools.size<this.options.config.maxPools?c.targets.find(t=>!c.pools.has(t.address)&&
      (!c.unsupported.has(t.address)||this.clock.now()>=c.unsupported.get(t.address)!.retryAt)):undefined;
    if(candidate){
      let supported=false,reason='POOL_PROTOCOL_UNSUPPORTED',temporary=false;
      try {
        const pairs=await this.market.pairs(c.chain,candidate.address);if(!this.current(c,generation))return;
        for(const pair of pairs.slice(0,3)){
          const result=await (this.options.discoverPool??discoverPool)(candidate,{poolAddress:String(pair.pairAddress)},c.rpc,{now:()=>new Date(this.clock.now()),maxAgeSec:90});
          if(!this.current(c,generation))return;
          if(result.status==='supported'&&result.pool.chain===c.chain&&chainAddress(c.chain,result.pool.address)===candidate.address&&result.subscriptions.length){
            c.pools.set(candidate.address,{token:candidate,pool:result.pool,subscriptions:result.subscriptions,dirty:true});supported=true;break;
          }
          reason=result.status==='unsupported'?safeCode(new Error(result.reason),'POOL_PROTOCOL_UNSUPPORTED'):'POOL_BINDING_INVALID';
          temporary ||= /^(RPC_|CHAIN_)/.test(reason)&&reason!=='CHAIN_POOL_PROTOCOL_UNSUPPORTED'||/(UNAVAILABLE|STALE|REORG)$/.test(reason);
        }
      }catch(error){if(!this.current(c,generation))return;reason=safeCode(error,'CHAIN_POOL_DISCOVERY_FAILED');temporary=true;}
      if(!supported){
        c.lastError=reason;
        if(!c.unsupported.has(candidate.address)&&c.unsupported.size>=200)c.unsupported.delete(c.unsupported.keys().next().value!);
        c.unsupported.set(candidate.address,{retryAt:this.clock.now()+(temporary?30000:600000),reason});
      }else {if(c.lastError===c.unsupported.get(candidate.address)?.reason)c.lastError=undefined;c.unsupported.delete(candidate.address);}this.subscriptions(c);
    }
    // Price reads revalidate pool binding. Freshness never comes from merely receiving a log.
    const due=[...c.pools.values()].filter(p=>p.sampledGeneration!==generation||
      this.clock.now()-(p.sampledAt??0)>20000&&(p.dirty||this.clock.now()-(p.sampledAt??0)>45000))
      .sort((a,b)=>(a.sampledAt??0)-(b.sampledAt??0)).slice(0,2);
    for(const p of due){
      if(!this.current(c,generation))return;
      if(!p.subscriptions.every(sub=>c.stream.getStatus().activeKeys.includes(sub.key)))continue;
      try {
        const anchor=await this.market.anchor(c.chain,p.pool.quoteAddress);if(!this.current(c,generation))return;
        const result=await (this.options.readPoolPrice??readPoolPrice)(p.pool,c.rpc,anchor,{now:()=>new Date(this.clock.now()),maxAgeSec:90});
        if(!this.current(c,generation))return;
        if(result.status!=='sampled')throw new Error(result.reason);
        const price=result.price;
        if(price.chain!==c.chain||chainAddress(c.chain,price.address)!==p.token.address||price.source!=='chain_pool_sample'||
          !Number.isFinite(price.priceUsd)||price.priceUsd<=0||!this.fresh(Date.parse(price.observedAt),90000)||
          !this.fresh(Date.parse(price.metadata.blockTime),90000)||!this.fresh(Date.parse(price.metadata.anchorAt),90000))throw new Error('CHAIN_PRICE_INVALID');
        this.options.onPrice(price);if(!this.current(c,generation))return;
        p.sampledAt=Date.parse(price.observedAt);p.validUntil=Math.min(p.sampledAt,Date.parse(price.metadata.blockTime),Date.parse(price.metadata.anchorAt))+90000;
        p.sampledGeneration=generation;p.dirty=false;p.lastError=undefined;c.poolPriceSamples++;
      }catch(error){if(!this.current(c,generation))return;p.lastError=safeCode(error,'CHAIN_PRICE_UNAVAILABLE');c.lastError=p.lastError;}
    }
    if(!this.current(c,generation))return;
    const wallets=[...c.wallets];if(wallets.length){const wallet=wallets[c.walletIndex++%wallets.length];
      c.gap.pending=true;c.backfilled.delete(wallet);
      const complete=c.chain==='solana'?await this.backfillSol(c,wallet,generation):await this.backfillEvm(c,wallet,generation);
      if(!this.current(c,generation))return;if(complete)c.backfilled.add(wallet);
      if(wallets.every(w=>c.backfilled.has(w))){c.gap.pending=false;c.gap.lastCompletedAt=new Date(this.clock.now()).toISOString();}
    }else {c.gap.pending=false;c.gap.lastCompletedAt=new Date(this.clock.now()).toISOString();}
  }
  private subscriptions(c:Context){
    const specs:RpcSubscription[]=[c.chain==='solana'?{key:'head',subscribeMethod:'slotSubscribe',params:[],unsubscribeMethod:'slotUnsubscribe',notificationMethod:'slotNotification'}:
      {key:'head',subscribeMethod:'eth_subscribe',params:['newHeads'],unsubscribeMethod:'eth_unsubscribe',notificationMethod:'eth_subscription'}];
    if(c.wallets.size){if(c.chain==='solana')for(const wallet of c.wallets)specs.push({key:'wallet:'+wallet,subscribeMethod:'logsSubscribe',
      params:[{mentions:[wallet]},{commitment:'finalized'}],unsubscribeMethod:'logsUnsubscribe',notificationMethod:'logsNotification'});
      else for(const direction of ['from','to'])specs.push({key:'wallet:'+direction,subscribeMethod:'eth_subscribe',params:['logs',
        {topics:direction==='from'?[TRANSFER_TOPIC,[...c.wallets].map(topic)]:[TRANSFER_TOPIC,null,[...c.wallets].map(topic)]}],
        unsubscribeMethod:'eth_unsubscribe',notificationMethod:'eth_subscription'});}
    for(const p of c.pools.values())specs.push(...p.subscriptions);c.stream.setSubscriptions(specs);
  }
  private notification(c:Context,key:string,data:unknown){try{
    if(key==='head'){
      const number=c.chain==='solana'&&object(data)?data.slot:object(data)?hexNumber(data.number):undefined;
      if(Number.isSafeInteger(number)&&number>=0&&(c.head===undefined||number>=c.head)){c.head=number;c.lastHeadAt=new Date(this.clock.now()).toISOString();}return;
    }
    if(key.startsWith('wallet:')){
      if(c.chain==='solana'){
        if(!object(data)||!object(data.value)||data.value.err!==null||!object(data.context)||!signature(data.value.signature)||
          !Number.isSafeInteger(data.context.slot)||data.context.slot<0||!c.wallets.has(key.slice(7)))return;
        // Solana WS offers subscriptions, not getGenesisHash. A notification only marks work
        // pending; the next bounded HTTP pass verifies wallet membership on the known chain.
        c.gap.pending=true;c.backfilled.delete(key.slice(7));
      }else for(const event of evmTransfers(c.chain,data,c.wallets,'live',new Date(this.clock.now())))if(this.store.record(event))c.events++;
    }else for(const p of c.pools.values())if(p.subscriptions.some(sub=>sub.key===key))p.dirty=true;
  }catch(error){c.lastError=safeCode(error,'CHAIN_EVENT_WRITE_FAILED');c.gap.pending=true;c.gap.incomplete=true;}}
  private incomplete(c:Context,code:string){c.gap.incomplete=true;c.gap.pending=true;c.lastError=code;this.store.markIncomplete(code);}
  private async backfillEvm(c:Context,wallet:string,generation:number):Promise<boolean>{
    const key=c.chain+':'+wallet,head=hexNumber(await c.rpc.request('eth_blockNumber'));if(!this.current(c,generation))return false;
    if(head===undefined)throw new Error('CHAIN_HEAD_INVALID');
    const end=Math.max(0,head-3),raw=this.store.cursor(key);
    if(raw!==undefined&&(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))))throw new Error('CHAIN_CURSOR_INVALID');
    const start=raw!==undefined?Number(raw)+1:Math.max(0,end-16);
    if(!Number.isSafeInteger(start)||start<0||start>end+1)throw new Error('CHAIN_CURSOR_INVALID');
    if(end-start>2000)this.incomplete(c,'CHAIN_BACKFILL_RANGE_EXCEEDED');
    if(start>end)return true;const finish=Math.min(end,start+511),set=new Set([wallet]);
    for(const [direction,topics] of [['from',[TRANSFER_TOPIC,[topic(wallet)]]],['to',[TRANSFER_TOPIC,null,[topic(wallet)]]]] as const){
      const logs=await c.rpc.request('eth_getLogs',[{fromBlock:qty(start),toBlock:qty(finish),topics}]);if(!this.current(c,generation))return false;
      if(!Array.isArray(logs))throw new Error('CHAIN_BACKFILL_INVALID');
      if(logs.length>=1000){this.incomplete(c,'CHAIN_BACKFILL_TRUNCATED');return false;}
      const events=logs.flatMap(log=>{
        if(canonicalNftTransfer(c.chain,log,wallet,direction,start,finish))return [];
        const found=evmTransfers(c.chain as 'bsc'|'robinhood',log,set,'backfill',new Date(this.clock.now()));
        if(!found.length||found.some(event=>event.blockNumber!<start||event.blockNumber!>finish||event.removed||event[direction]!==wallet))
          throw new Error('CHAIN_BACKFILL_INVALID');
        return found;
      });
      for(const event of events)if(this.store.record(event))c.events++;
    }
    if(!this.current(c,generation))return false;this.store.checkpoint(key,String(finish));return finish===end;
  }
  private async backfillSol(c:Context,wallet:string,generation:number):Promise<boolean>{
    const key=c.chain+':'+wallet,previous=this.store.cursor(key);if(previous!==undefined&&!signature(previous))throw new Error('CHAIN_CURSOR_INVALID');
    let before:string|undefined,latest:string|undefined,complete=false,previousSlot=Infinity;const seen=new Set<string>();
    for(let page=0;page<3;page++){
      const rows=await c.rpc.request('getSignaturesForAddress',[wallet,{commitment:'finalized',limit:50,...(previous?{until:previous}:{}),...(before?{before}:{})}]);
      if(!this.current(c,generation))return false;
      if(!Array.isArray(rows)||rows.length>50)throw new Error('CHAIN_BACKFILL_INVALID');
      for(const row of rows){if(!object(row)||!signature(row.signature)||row.signature===previous||seen.has(row.signature)||
          !Number.isSafeInteger(row.slot)||row.slot<0||row.slot>previousSlot||row.confirmationStatus!=='finalized'||
          !(row.err===null||typeof row.err==='string'||object(row.err)))throw new Error('CHAIN_BACKFILL_INVALID');
        seen.add(row.signature);previousSlot=row.slot;
      }
      latest??=rows[0]?.signature;
      for(const row of rows)if(row.err===null&&this.store.record(solWalletEvent(wallet,row.signature,row.slot,'backfill',new Date(this.clock.now()))))c.events++;
      if(!previous){
        // Initial enrollment has a bounded baseline, not an assertion of complete wallet history.
        if(rows.length===50)this.incomplete(c,'CHAIN_INITIAL_HISTORY_WINDOW');complete=true;break;
      }
      if(rows.length<50){complete=true;break;}before=rows.at(-1)?.signature;
    }
    if(!complete){this.incomplete(c,'CHAIN_BACKFILL_TRUNCATED');return false;}
    if(!this.current(c,generation))return false;if(latest)this.store.checkpoint(key,latest);return true;
  }
}
