import {Connection,PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,unpackMint} from '@solana/spl-token';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Config} from '../config.js';
import {OrderStore,type OpeningOrder} from '../orders.js';
import type {TradeNotificationEvent} from '../trade-notifications.js';
import {crossedPriceMilestones,crossedMilestoneLabel} from '../price-milestones.js';
import {formatTokenUnits,type SellPercentage} from '../direct-sell.js';
import {PumpNativeAdapter} from './pump.js';
import {NativeExecutor,type NativeExecutionResult} from './executor.js';
import {NativePositionSupervisor,nativeStopLossTriggered,type NativeExternalPrice,type NativePositionState,type NativePositionUpdate,type NativePositionExitResult,type NativePositionBalance,type NativePositionQuote} from './positions.js';
import {CURRENT_STOP_LOSS_DROP_PCT} from '../exit-policy.js';
import {NativeAccountStream,type NativeStreamAccountUpdate} from './stream.js';
import {NativeInventoryCache} from './inventory.js';
import {validNativeTokenIdentity,type NativeTokenIdentity} from './identity.js';

const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const clean=(s:unknown)=>typeof s==='string'?s.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,80):'';
const SOL=(amount:string)=>formatTokenUnits(amount,9);
const EXTERNAL_PRICE_MAX_AGE_MS=1500;
const JUPITER_EXACT_QUOTE_TTL_MS=1000;
const JUPITER_AUTOMATIC_QUOTE_TIMEOUT_MS=700;
interface ExternalPrice extends NativeExternalPrice {receivedAt:number;}
const gain=(p:NativePositionState)=>p.quote&&BigInt(p.quote.inputAmount)>0n?
  Number(BigInt(p.quote.outputAmount)*BigInt(p.costBasis.tokenAtoms)*10000n/
    (BigInt(p.quote.inputAmount)*BigInt(p.costBasis.solLamports)))/100-100:undefined;

/** One owner of native buy recovery, holding subscriptions and manual/automatic exits. */
export class NativeTradingRuntime {
  private executor:NativeExecutor;private adapter:PumpNativeAdapter;private positions:NativePositionSupervisor;
  private stream:NativeAccountStream;private db:DatabaseSync;private running=false;private busy=false;
  private timer?:ReturnType<typeof setInterval>;private work?:Promise<void>;private chainVerified=false;private error?:string;
  private startedAt=0;
  private readonly tasks=new Set<Promise<unknown>>();
  private readonly selling=new Set<string>();
  private readonly ownerConnection:Connection;private inventory:NativeInventoryCache;
  private cacheGeneration=0;private inventoryWork?:Promise<void>;private inventoryRetryAt=0;private inventoryError?:string;private ownerVerified=false;
  private warming=new Map<string,Promise<void>>();private warmRetryAt=new Map<string,number>();
  private mintOrders=new Map<string,string>();private finalizedZero=new Map<string,NativePositionBalance>();
  private zeroWork=new Map<string,Promise<void>>();private zeroRetryAt=new Map<string,number>();
  private eventAt=new Map<string,number>();private eventLatencies:number[]=[];private marketError?:string;
  private incompleteSince=new Map<string,number>();
  private externalPrices=new Map<string,ExternalPrice>();
  private externalWarming=new Map<string,Promise<void>>();private externalWarmRetryAt=new Map<string,number>();
  private externalTokenPrograms=new Map<string,PublicKey>();
  private entryWatches=new Map<string,string[]>();
  private orderSyncPending=new Set<string>();
  private buySyncPending=new Map<string,NativeExecutionResult>();
  private recoveryLoaded=false;private initialRecoveryComplete=false;private recoveryOrders=new Set<string>();
  private milestoneSeen=new Map<string,number[]>();
  private pendingMilestones=new Map<string,{position:NativePositionState;crossed:number[]}>();
  private monitorReady=new Set<string>();
  private milestoneRetryAt=new Map<string,number>();private milestoneTimer?:ReturnType<typeof setTimeout>;private milestoneTimerAt=0;
  private accountWatchKey?:string;
  private jupiterEntryReservations=new Map<string,number>();
  constructor(private config:Config,private orders:OrderStore,private enqueue:(event:TradeNotificationEvent)=>boolean){
    const n=config.nativeSolana,wallet=config.entryWallets.solana;
    if(!n?.rpcUrl||!n.wsUrl||!wallet)throw Error('NATIVE_CONFIG_INCOMPLETE');
    if(n.journalPath===n.positionsPath||[n.journalPath,n.positionsPath].includes(config.ordersDatabase))throw Error('NATIVE_DATABASE_CONFLICT');
    const connection=new Connection(n.rpcUrl,{commitment:'confirmed',wsEndpoint:n.wsUrl,disableRetryOnRateLimit:true,
      fetch:async(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(8000),redirect:'error'})});
    this.ownerConnection=new Connection(n.inventoryRpcUrl??'https://api.mainnet-beta.solana.com',{commitment:'confirmed',disableRetryOnRateLimit:true,
      fetch:async(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(5000),redirect:'error'})});
    this.inventory=new NativeInventoryCache(wallet);
    this.adapter=new PumpNativeAdapter({connection,ownerConnection:this.ownerConnection,jupiterApiKey:n.jupiterApiKey,
      jupiterMainBucketTier:n.jupiterMainBucketTier,jupiterMainBucketRps:n.jupiterMainBucketRps});
    this.executor=new NativeExecutor({rpcUrl:n.rpcUrl,jitoUrl:n.jitoUrl,keypairFile:n.keypairFile??'',wallet,
      journalPath:n.journalPath,tipLamports:n.tipLamports,priorityFeeLamports:n.priorityFeeLamports,
      maxQuoteAgeMs:10000,plan:(request,context)=>this.adapter.build(request,{jupiterEntryAuthorized:
        request.side==='sell'||this.jupiterEntryReservations.has(context.orderId)})});
    const actionsPath=n.positionsPath+'.actions.sqlite';mkdirSync(dirname(actionsPath),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(actionsPath);chmodSync(actionsPath,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5;
      CREATE TABLE IF NOT EXISTS native_actions(ref TEXT PRIMARY KEY,order_id TEXT NOT NULL,expires INTEGER NOT NULL,intent_id TEXT,percentage INTEGER);
      CREATE TABLE IF NOT EXISTS native_reminders(order_id TEXT PRIMARY KEY,seen TEXT NOT NULL DEFAULT '[]',summary_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS native_notice_outbox(key TEXT PRIMARY KEY,text TEXT NOT NULL,queued INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS native_notice_outbox_pending ON native_notice_outbox(queued) WHERE queued=0;`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS native_health(id INTEGER PRIMARY KEY,active INTEGER NOT NULL,episode INTEGER NOT NULL);
      INSERT OR IGNORE INTO native_health VALUES(1,0,0);`);
    if(!this.db.prepare('PRAGMA table_info(native_actions)').all().some(r=>r.name==='dispatched'))
      this.db.exec('ALTER TABLE native_actions ADD COLUMN dispatched INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS native_actions_pending ON native_actions(dispatched) WHERE dispatched=0 AND intent_id IS NOT NULL');
    this.stream=new NativeAccountStream(n.wsUrl,wallet,{dirty:()=>{/* account callback owns the indexed fast path */},
      account:event=>this.onAccount(event),head:()=>{if(this.running&&this.transportHealthy())void this.bootstrap();},
      reset:event=>{if(event.reason==='accounts_removed')return;this.cacheGeneration++;this.adapter.invalidateCache();this.inventory.invalidate();this.finalizedZero.clear();this.incompleteSince.clear();},
      state:state=>{this.positions?.setStreamState(state);if(this.running&&this.transportHealthy()){
        void this.bootstrap();for(const id of this.mintOrders.values())if(this.positionStreamHealthy(id))this.positions.markDirty(id);
      }}},undefined,{maxAccounts:300});
    const stopLossDropPct=config.exitPolicy?.stopLoss.dropPct??CURRENT_STOP_LOSS_DROP_PCT;
    this.positions=new NativePositionSupervisor(n.positionsPath,{fallbackIntervalMs:1000,minCheckIntervalMs:0,loopMs:50,batchSize:20,maxPositions:40,
      eventDriven:true,staleAfterMs:1500,quoteRequestTimeoutMs:JUPITER_AUTOMATIC_QUOTE_TIMEOUT_MS,
      stopLossDropPct,
      io:{balance:async request=>{
          if(!this.positionStreamHealthy(request.orderId))throw Error('NATIVE_WEBSOCKET_UNAVAILABLE');
          const p=this.positions.get(request.orderId);if(!p)throw Error('NATIVE_POSITION_UNAVAILABLE');
          const floor=Math.max(p.buy.buySlot,p.lastExit?.slot??0,p.balance?.slot??0);
          let b:NativePositionBalance;
          try{b=this.inventory.read(request.mint,floor,Date.now());}
          catch(error){void this.refreshInventory();throw error;}
          if(b.amount!=='0'){this.finalizedZero.delete(request.mint);return b;}
          const zero=this.finalizedZero.get(request.mint);
          if(zero&&zero.slot>=b.slot)return {...zero,observedAt:new Date().toISOString()};
          this.confirmZero(p);return b;
        },
        quote:async request=>{
          if(!this.positionStreamHealthy(request.orderId))throw Error('NATIVE_WEBSOCKET_UNAVAILABLE');
          const position=this.positions.get(request.orderId);if(!position)throw Error('NATIVE_POSITION_UNAVAILABLE');
          if(position.buy.venue==='jupiter'){
            return this.exactJupiterQuote(position,request.amount,request.purpose==='manual',request.signal);
          }
          const q=this.adapter.quoteSellCached({wallet:request.wallet,mint:request.mint,amount:request.amount,slippageBps:config.entrySlippagePct*100},
            {headSlot:this.stream.headSlot()});
          const now=Date.now();
          return {wallet:request.wallet,mint:request.mint,inputAmount:request.amount,outputAmount:q.expectedOutputAmount,
            minimumOutputAmount:q.minimumOutputAmount,quotedAt:new Date(now).toISOString(),expiresAt:new Date(now+1000).toISOString(),
            subscriptionAccounts:[...new Set([...q.subscriptionAccounts,...this.inventory.addresses(request.mint)])],
            source:'solana_account_stream' as const,marketObservedAt:q.quotedAt,marketSlot:q.slot};
        },
        sell:async request=>{
          this.selling.add(request.operationId);
          try {
          const result=await this.executor.execute({intentId:request.operationId,orderId:request.orderId,wallet:request.wallet,
            mint:request.mint,side:'sell',amount:request.expectedAmount,slippageBps:config.entrySlippagePct*100,reason:request.reason,
            beforeBroadcast:async plan=>{
              if(!this.running)throw Error('NATIVE_EXECUTOR_STOPPED');
              const latest=await this.adapter.balance(request.wallet,request.mint,'confirmed');
              if((BigInt(latest.amount)*BigInt(request.percent)/100n).toString()!==request.expectedAmount)throw Error('NATIVE_BALANCE_CHANGED');
              const p=this.positions.get(request.orderId);if(!p||p.state==='closed')throw Error('NATIVE_POSITION_NOT_ACTIVE');
              const output=BigInt(plan.expectedOutputAmount),bought=BigInt(p.buy.outputAmount),cost=BigInt(p.buy.inputAmount),amount=BigInt(request.expectedAmount);
              if(request.reason==='take_profit'&&output*bought<cost*amount*2n||
                request.reason==='stop_loss'&&!nativeStopLossTriggered(output,bought,cost,amount,stopLossDropPct))
                throw Error('NATIVE_EXIT_TRIGGER_CHANGED');
            }});
          return this.exitResult(result);
          }finally{this.selling.delete(request.operationId);}
        },
        reconcile:async request=>{
          if(!this.executor.get(request.operationId))return this.selling.has(request.operationId)?
            {status:'pending',reason:'NATIVE_PREPARATION_IN_PROGRESS'}:{status:'failed',reason:'NATIVE_INTERRUPTED_BEFORE_BROADCAST'};
          return this.exitResult(await this.executor.reconcile(request.operationId));
        }},
      onSubscriptions:accounts=>this.syncAccountWatches(accounts),onEvaluation:position=>this.recordEvaluation(position),onUpdate:event=>this.onPosition(event)});
    // Inventory is rebuilt from active positions only. Closed mints have no
    // subscriptions to suppress, and durable no-reentry/position uniqueness
    // prevents them from being tracked again, so historical positions stay cold.
  }
  readiness():{ready:boolean;reason?:string}{
    if(!this.running)return {ready:false,reason:'NATIVE_PROTECTION_STOPPED'};
    const signer=this.executor.readiness();if(!signer.ready)return signer;
    if(this.error)return {ready:false,reason:this.error};
    if(!this.initialRecoveryComplete)return {ready:false,reason:'NATIVE_INITIAL_RECOVERY_PENDING'};
    if(this.orderSyncPending.size||this.buySyncPending.size)return {ready:false,reason:'NATIVE_ORDER_SYNC_UNAVAILABLE'};
    if(!this.chainVerified)return {ready:false,reason:'NATIVE_CHAIN_NOT_VERIFIED'};
    if(!this.stream.status().connected)return {ready:false,reason:'NATIVE_WEBSOCKET_UNAVAILABLE'};
    if(!this.inventory.status().ready)return {ready:false,reason:this.inventoryError??'NATIVE_INVENTORY_NOT_READY'};
    return this.positions.readiness();
  }
  status(){return {provider:'pump_native',antiMev:{provider:'jito',bundleOnly:true,dontFront:true,publicFallback:false},
    readiness:this.readiness(),running:this.running,chainVerified:this.chainVerified,error:this.error,
    stream:this.stream.status(),protection:this.positions.status(),orderSyncPending:this.orderSyncPending.size+this.buySyncPending.size,inventory:{...this.inventory.status(),error:this.inventoryError},
    prices:{mode:'external_price_wake_with_exact_jupiter_quote',activeMarkets:this.mintOrders.size,jupiter:{...this.adapter.jupiterStatus(),
      activePositions:this.positions.activeVenueCount('jupiter'),
      entryReservations:this.jupiterEntryReservations.size},
      warming:this.warming.size+this.externalWarming.size,externalFresh:[...this.externalPrices.keys()].filter(mint=>!!this.freshExternal(mint)).length,error:this.marketError,
      receiveToEvaluationMs:this.latencyStatus(),marketTimestamp:'last_fresh_external_observation',quoteTimestamp:'exact_jupiter_quote_time'}};}
  private latencyStatus(){const values=[...this.eventLatencies].sort((a,b)=>a-b);return {samples:values.length,
    p50:values.length?values[Math.floor((values.length-1)*.5)]:undefined,
    p95:values.length?values[Math.ceil((values.length-1)*.95)]:undefined,max:values.at(-1)};}
  private freshExternal(mint:string,now=Date.now()):ExternalPrice|undefined {
    const sample=this.externalPrices.get(mint),observed=sample?Date.parse(sample.observedAt):NaN;
    return sample&&Number.isFinite(observed)&&observed<=now+250&&now-observed<=EXTERNAL_PRICE_MAX_AGE_MS&&
      now-sample.receivedAt<=EXTERNAL_PRICE_MAX_AGE_MS?sample:undefined;
  }
  /** Feed only fresh, identity-bound market observations. They wake Jupiter
   * protection but never provide a financial valuation or authorize an exit. */
  observePrice(input:{mint:string;priceUsd:number;observedAt:string;source:string}):boolean {
    if(!this.running||typeof input?.mint!=='string'||typeof input.priceUsd!=='number'||!Number.isFinite(input.priceUsd)||input.priceUsd<=0||
      typeof input.source!=='string'||!/^[a-z0-9_:-]{1,80}$/i.test(input.source))return false;
    try{if(new PublicKey(input.mint).toBase58()!==input.mint)return false;}catch{return false;}
    const now=Date.now(),observed=Date.parse(input.observedAt);
    if(!Number.isFinite(observed)||observed>now+250||now-observed>EXTERNAL_PRICE_MAX_AGE_MS)return false;
    const prior=this.externalPrices.get(input.mint);if(prior&&Date.parse(prior.observedAt)>=observed)return false;
    const sample:ExternalPrice={priceUsd:input.priceUsd,observedAt:new Date(observed).toISOString(),source:input.source,receivedAt:now};
    this.externalPrices.set(input.mint,sample);
    const orderId=this.mintOrders.get(input.mint),position=orderId?this.positions.get(orderId):undefined;
    if(orderId&&position?.buy.protectionMode==='external_price_stream'){
      if(!this.eventAt.has(orderId))this.eventAt.set(orderId,now);
      this.positions.observeExternalPrice(orderId,sample);
    }
    return true;
  }
  private async exactJupiterQuote(position:NativePositionState,amount:string,manual:boolean,signal:AbortSignal):Promise<NativePositionQuote> {
    const protectionMode=position.buy.protectionMode;
    if(protectionMode!=='external_price_stream')throw Error('NATIVE_JUPITER_PROTECTION_MODE_UNAVAILABLE');
    if(!manual&&!this.freshExternal(position.buy.mint))throw Error('NATIVE_EXTERNAL_PRICE_STALE');
    const q=await this.adapter.quoteJupiterSell({wallet:position.buy.wallet,mint:position.buy.mint,amount,
      slippageBps:this.config.entrySlippagePct*100,signal},position.buy.tokenDecimals,protectionMode);
    const now=Date.now(),quotedAt=Date.parse(q.quotedAt);
    const marketObservedAt=manual?undefined:this.freshExternal(position.buy.mint,now)?.observedAt;
    if(!manual&&!marketObservedAt)throw Error('NATIVE_EXTERNAL_PRICE_STALE');
    const atomic=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)&&BigInt(value)<=(1n<<64n)-1n;
    const validOutput=atomic(q.expectedOutputAmount)&&atomic(q.minimumOutputAmount)&&BigInt(q.minimumOutputAmount)<=BigInt(q.expectedOutputAmount);
    if(q.venue!=='jupiter'||q.protectionMode!=='external_price_stream'||q.mint!==position.buy.mint||
      q.side!=='sell'||q.inputAmount!==amount||q.tokenDecimals!==position.buy.tokenDecimals||!validOutput||
      !Number.isFinite(quotedAt)||quotedAt>now+250||now-quotedAt>JUPITER_EXACT_QUOTE_TTL_MS)
      throw Error('NATIVE_JUPITER_QUOTE_INVALID');
    return {wallet:position.buy.wallet,mint:position.buy.mint,inputAmount:amount,outputAmount:q.expectedOutputAmount,
      minimumOutputAmount:q.minimumOutputAmount,quotedAt:q.quotedAt,expiresAt:new Date(quotedAt+JUPITER_EXACT_QUOTE_TTL_MS).toISOString(),
      // Jupiter route accounts are one-shot execution details. Durable entry
      // subscriptions remain authoritative and must not churn on exact quotes.
      source:'jupiter_exact_sell',...(marketObservedAt?{marketObservedAt}:{})};
  }
  private transportHealthy(){return this.stream.transportReady();}
  private positionStreamHealthy(orderId:string){
    const p=this.positions?.get(orderId);return !!p&&this.stream.isSubscribed(p.buy.subscriptionAccounts);
  }
  private syncAccountWatches(accounts=this.positions.accounts()){
    const wanted=[...new Set([...accounts,...[...this.entryWatches.values()].flat()])].sort(),key=wanted.join(',');
    if(key===this.accountWatchKey)return;
    for(const [mint,id] of this.mintOrders)if(this.positions.get(id)?.state==='closed')this.releaseMarket(mint,id);
    const next=[...new Set([...accounts,...[...this.entryWatches.values()].flat()])].sort();
    this.stream.setAccounts(next);this.accountWatchKey=next.join(',');
  }
  private releaseMarket(mint:string,orderId:string){
    if(this.mintOrders.get(mint)!==orderId)return;
    this.mintOrders.delete(mint);this.entryWatches.delete(orderId);this.eventAt.delete(orderId);
    this.milestoneSeen.delete(orderId);this.pendingMilestones.delete(orderId);this.milestoneRetryAt.delete(orderId);
    if(!this.pendingMilestones.size){clearTimeout(this.milestoneTimer);this.milestoneTimer=undefined;this.milestoneTimerAt=0;}
    this.warmRetryAt.delete(mint);this.incompleteSince.delete(mint);this.finalizedZero.delete(mint);this.zeroRetryAt.delete(mint);
    this.externalPrices.delete(mint);this.externalWarmRetryAt.delete(mint);this.externalTokenPrograms.delete(mint);
    this.adapter.dropQuoteCache(this.config.entryWallets.solana!,mint);this.inventory.retire(mint);
  }
  private activeMarket(mint:string,orderId:string){return this.running&&this.mintOrders.get(mint)===orderId&&this.positions.get(orderId)?.state==='active';}
  private onAccount(event:NativeStreamAccountUpdate){
    if(!this.running)return;
    const market=event.kind==='account'?this.adapter.ingestAccount(event.address,event.info,event.slot,event.receivedAtMs):[];
    const held=this.inventory.ingest(event.address,event.info,event.slot,event.receivedAtMs);
    for(const mint of new Set([...market,...held])){const id=this.mintOrders.get(mint);if(!id)continue;
      // Include the wait for other pool accounts, not just the final frame of a burst.
      if(!this.eventAt.has(id))this.eventAt.set(id,event.receivedAtMs);
      this.positions.markDirty(id,{slot:event.slot,observedAt:new Date(event.receivedAtMs).toISOString()});
      if(held.includes(mint))this.finalizedZero.delete(mint);
      const position=this.positions.get(id);
      if(position?.buy.protectionMode==='external_price_stream'){
        const program=this.externalTokenPrograms.get(mint),accounts=program?this.externalAccounts(mint,program):this.inventory.addresses(mint);
        if(accounts.length)this.positions.replaceSubscriptions(id,accounts);
        continue;
      }
      const status=this.adapter.cacheStatus(this.config.entryWallets.solana!,mint);
      if(status.ready)this.incompleteSince.delete(mint);
      else if(!this.incompleteSince.has(mint))this.incompleteSince.set(mint,Date.now());
      if(!status.warm)void this.warm(mint,id);
    }
  }
  private async bootstrap(){
    if(!this.running||!this.transportHealthy())return;
    if(!this.inventory.status().ready)void this.refreshInventory();
    for(const [mint,id] of this.mintOrders){const position=this.positions.get(id);
      if(position?.buy.protectionMode==='external_price_stream'){
        if(!this.externalTokenPrograms.has(mint))void this.warmExternal(mint,id);
        continue;
      }
      const status=this.adapter.cacheStatus(this.config.entryWallets.solana!,mint);
      if(!status.warm||!status.ready&&Date.now()-(this.incompleteSince.get(mint)??Date.now())>=750)void this.warm(mint,id);
    }
  }
  private externalAccounts(mint:string,program:PublicKey):string[]{
    const ata=getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(this.config.entryWallets.solana!),true,program).toBase58();
    return [...new Set([...this.inventory.addresses(mint),ata])];
  }
  private warmExternal(mint:string,orderId:string):Promise<void>{
    const existing=this.externalWarming.get(mint);if(existing)return existing;
    if(!this.activeMarket(mint,orderId)||!this.transportHealthy()||Date.now()<(this.externalWarmRetryAt.get(mint)??0))return Promise.resolve();
    this.externalWarmRetryAt.set(mint,Date.now()+2000);const generation=this.cacheGeneration;
    const work=(async()=>{
      const address=new PublicKey(mint),snapshot=await this.ownerConnection.getAccountInfoAndContext(address,{commitment:'confirmed'}),info=snapshot.value;
      if(!info||info.executable||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(program=>info.owner.equals(program)))throw Error('NATIVE_MINT_OWNER_INVALID');
      const data=unpackMint(address,info,info.owner),position=this.positions.get(orderId);
      if(!position||position.buy.protectionMode!=='external_price_stream'||data.decimals!==position.buy.tokenDecimals)throw Error('NATIVE_MINT_IDENTITY_INVALID');
      if(!this.activeMarket(mint,orderId)||generation!==this.cacheGeneration)return;
      this.externalTokenPrograms.set(mint,info.owner);this.inventory.track(mint,data.decimals,info.owner.toBase58());
      this.positions.replaceSubscriptions(orderId,this.externalAccounts(mint,info.owner));
      const sample=this.freshExternal(mint);if(sample)this.positions.observeExternalPrice(orderId,sample);
      try{this.inventory.read(mint,position.buy.buySlot,Date.now());}catch{void this.refreshInventory();}
      this.positions.markDirty(orderId);this.marketError=undefined;
    })().catch(error=>{if(this.activeMarket(mint,orderId))this.marketError=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'NATIVE_EXTERNAL_BOOTSTRAP_FAILED';})
      .finally(()=>{this.externalWarming.delete(mint);});
    this.externalWarming.set(mint,work);return work;
  }
  private warm(mint:string,orderId:string):Promise<void>{
    const existing=this.warming.get(mint);if(existing)return existing;
    if(!this.activeMarket(mint,orderId)||!this.transportHealthy()||Date.now()<(this.warmRetryAt.get(mint)??0))return Promise.resolve();
    this.warmRetryAt.set(mint,Date.now()+2000);const generation=this.cacheGeneration;
    const work=(async()=>{
      const q=await this.adapter.warmQuoteCache(this.config.entryWallets.solana!,mint);
      if(!this.activeMarket(mint,orderId)||generation!==this.cacheGeneration)return;
      if(q.tokenIdentity)this.applyTokenIdentity(orderId,q.tokenIdentity);
      this.inventory.track(mint,q.tokenDecimals,q.tokenProgram);
      this.positions.replaceSubscriptions(orderId,[...new Set([...q.subscriptionAccounts,...this.inventory.addresses(mint)])]);
      const p=this.positions.get(orderId);
      try{this.inventory.read(mint,p?.buy.buySlot??0,Date.now());}catch{void this.refreshInventory();}
      this.positions.markDirty(orderId);this.marketError=undefined;
      if(this.adapter.cacheStatus(this.config.entryWallets.solana!,mint).ready)this.incompleteSince.delete(mint);
    })().catch(error=>{if(this.activeMarket(mint,orderId))this.marketError=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'NATIVE_STREAM_BOOTSTRAP_FAILED';})
      .finally(()=>{this.warming.delete(mint);});
    this.warming.set(mint,work);return work;
  }
  private refreshInventory():Promise<void>{
    if(this.inventoryWork)return this.inventoryWork;
    if(!this.running||!this.transportHealthy()||Date.now()<this.inventoryRetryAt)return Promise.resolve();
    this.inventoryRetryAt=Date.now()+5000;const generation=this.cacheGeneration;
    this.inventoryWork=(async()=>{
      if(!this.ownerVerified){if(await this.ownerConnection.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error('NATIVE_INVENTORY_WRONG_CHAIN');this.ownerVerified=true;}
      const wallet=new PublicKey(this.config.entryWallets.solana!);
      const floor=Math.max(0,...[...this.mintOrders.values()].map(id=>this.positions.get(id)?.buy.buySlot??0));
      const programs=this.inventory.programsNeedingRefresh().map(program=>new PublicKey(program));
      const snapshots=await Promise.allSettled(programs.map(programId=>
        this.ownerConnection.getTokenAccountsByOwner(wallet,{programId},{commitment:'confirmed',minContextSlot:floor})));
      if(!this.running||generation!==this.cacheGeneration)return;
      let failed=false;
      for(let i=0;i<snapshots.length;i++){
        const snapshot=snapshots[i];if(snapshot.status==='rejected'){failed=true;continue;}
        this.inventory.install(programs[i].toBase58(),snapshot.value.context.slot,snapshot.value.value,Date.now());
      }
      if(failed||this.inventory.programsNeedingRefresh().length)throw Error('NATIVE_INVENTORY_RPC_UNAVAILABLE');
      this.inventoryError=undefined;
      for(const [mint,id] of this.mintOrders){const position=this.positions.get(id),program=this.externalTokenPrograms.get(mint);
        if(position?.buy.protectionMode==='external_price_stream'&&program)this.positions.replaceSubscriptions(id,this.externalAccounts(mint,program));
        this.positions.markDirty(id);
      }
    })().catch(()=>{this.inventoryError='NATIVE_INVENTORY_RPC_UNAVAILABLE';})
      .finally(()=>{this.inventoryWork=undefined;});return this.inventoryWork;
  }
  private confirmZero(p:NativePositionState){
    const mint=p.buy.mint;if(this.zeroWork.has(mint)||!this.running||Date.now()<(this.zeroRetryAt.get(mint)??0))return;
    this.zeroRetryAt.set(mint,Date.now()+1000);const generation=this.cacheGeneration;
    const work=(async()=>{const b=await this.adapter.balance(p.buy.wallet,mint,'finalized');
      if(!this.activeMarket(mint,p.buy.orderId)||generation!==this.cacheGeneration||b.amount!=='0')return;
      const current=this.inventory.read(mint,p.buy.buySlot,Date.now());if(current.amount!=='0'||b.slot<current.slot)return;
      this.finalizedZero.set(mint,{...current,slot:b.slot,commitment:'finalized',observedAt:new Date().toISOString()});this.positions.markDirty(p.buy.orderId);
    })().catch(()=>{/* Never clear a position on an unavailable/older finalized snapshot. */}).finally(()=>{this.zeroWork.delete(mint);});
    this.zeroWork.set(mint,work);
  }
  async execute(order:OpeningOrder,beforeBroadcast:()=>Promise<void>):Promise<OpeningOrder>{
    if(!this.initialRecoveryComplete)throw Error('NATIVE_INITIAL_RECOVERY_PENDING');
    let releaseJupiter:(()=>void)|undefined;
    try{
      const capability=await this.adapter.routeCapability(order.tokenAddress);
      if(capability.route!=='direct')releaseJupiter=this.reserveJupiterEntry(order.id);
      let entryGeneration:number|undefined,entryProtectionMode:'account_stream'|'external_price_stream'='account_stream',tokenIdentity:NativeTokenIdentity|undefined;
      const prepare=(plan:Readonly<import('./pump.js').NativeSwapPlan>)=>{
        if(plan.venue==='jupiter'&&!this.jupiterEntryReservations.has(order.id))throw Error('NATIVE_JUPITER_PROTECTION_CAPACITY_REACHED');
        if(plan.tokenIdentity&&validNativeTokenIdentity(plan.tokenIdentity))tokenIdentity={...plan.tokenIdentity};
        entryProtectionMode=plan.protectionMode;
        if(entryGeneration!==undefined)return;
        entryGeneration=this.cacheGeneration;this.entryWatches.set(order.id,[...plan.subscriptionAccounts]);this.syncAccountWatches();
      };
      const result=await this.executor.execute({intentId:'buy-'+order.id,orderId:order.id,wallet:order.wallet,mint:order.tokenAddress,
        side:'buy',amount:order.inputAmount,slippageBps:order.slippagePct*100,onPlanReady:prepare,beforeBroadcast:async plan=>{
          prepare(plan);const generation=entryGeneration!,deadline=Date.now()+1500;
          while(this.running&&generation===this.cacheGeneration&&
            (!this.stream.isSubscribed(plan.subscriptionAccounts)||entryProtectionMode==='external_price_stream'&&!this.freshExternal(order.tokenAddress))&&Date.now()<deadline)
            await new Promise(resolve=>setTimeout(resolve,20));
          if(!this.running||generation!==this.cacheGeneration||!this.stream.isSubscribed(plan.subscriptionAccounts))
            throw Error('NATIVE_ENTRY_PRICE_STREAM_UNAVAILABLE');
          if(entryProtectionMode==='external_price_stream'&&!this.freshExternal(order.tokenAddress))throw Error('NATIVE_ENTRY_EXTERNAL_PRICE_STALE');
          await beforeBroadcast();
          if(!this.running||generation!==this.cacheGeneration||!this.stream.isSubscribed(plan.subscriptionAccounts))
            throw Error('NATIVE_ENTRY_PRICE_STREAM_UNAVAILABLE');
          if(entryProtectionMode==='external_price_stream'&&!this.freshExternal(order.tokenAddress))throw Error('NATIVE_ENTRY_EXTERNAL_PRICE_STALE');
        }});
      if(tokenIdentity)this.applyTokenIdentity(order.id,tokenIdentity);
      return this.applyBuy(order.id,result);
    }finally{releaseJupiter?.();this.entryWatches.delete(order.id);this.syncAccountWatches();}
  }
  private jupiterCapacityOrderIds():Set<string>{
    return new Set([...this.positions.activeVenueOrderIds('jupiter'),...this.executor.pendingBuyVenueOrderIds('jupiter'),
      ...this.durableJupiterFillOrderIds(),...this.pendingJupiterSyncOrderIds(),...this.jupiterEntryReservations.keys()]);
  }
  private durableJupiterFillOrderIds():string[]{
    const result:string[]=[];
    for(const order of this.orders.activeNativePositions()){
      const fill=order.details.nativeFill;if(object(fill)&&fill.venue==='jupiter')result.push(order.id);
    }
    return result;
  }
  private pendingJupiterSyncOrderIds():string[]{
    const result:string[]=[];
    for(const [orderId,execution] of this.buySyncPending)if(execution.venue==='jupiter'&&execution.status!=='failed')result.push(orderId);
    return result;
  }
  private reserveJupiterEntry(orderId:string):()=>void {
    const current=this.jupiterEntryReservations.get(orderId);
    if(current!==undefined){this.jupiterEntryReservations.set(orderId,current+1);return ()=>this.releaseJupiterEntry(orderId);}
    const occupied=this.jupiterCapacityOrderIds();
    // Re-entering an already journaled intent cannot build or send a second
    // transaction; NativeExecutor returns the durable record. Do not charge it twice.
    if(occupied.has(orderId))return ()=>{};
    const capacity=this.adapter.jupiterStatus().entryCapacity;
    if(capacity<1||occupied.size>=capacity)throw Error('NATIVE_JUPITER_PROTECTION_CAPACITY_REACHED');
    this.jupiterEntryReservations.set(orderId,1);return ()=>this.releaseJupiterEntry(orderId);
  }
  private releaseJupiterEntry(orderId:string):void {
    const current=this.jupiterEntryReservations.get(orderId);if(current===undefined)return;
    if(current>1)this.jupiterEntryReservations.set(orderId,current-1);else this.jupiterEntryReservations.delete(orderId);
  }
  private applyTokenIdentity(orderId:string,identity:NativeTokenIdentity):void {
    if(!validNativeTokenIdentity(identity))return;
    const order=this.orders.get(orderId);if(!order||order.chain!=='solana')return;
    const current=object(order.details.nativeTokenIdentity)?order.details.nativeTokenIdentity:undefined;
    const unchanged=current&&current.name===identity.name&&current.symbol===identity.symbol&&current.source===identity.source;
    if(!unchanged){
      const oldToken=object(order.details.token)?order.details.token:{};
      const token={...oldToken,chain:'solana',address:order.tokenAddress,
        ...(identity.name?{name:identity.name}:{}),...(identity.symbol?{symbol:identity.symbol}:{})};
      try{this.orders.update(order.id,[order.status],{details:{...order.details,token,nativeTokenIdentity:{...identity}}});}catch{/* Display metadata never gates execution or protection. */}
    }
    const name=identity.name??identity.symbol;if(name)try{this.positions.setName(orderId,name);}catch{/* Retried by the next cache warm. */}
  }
  private applyBuy(orderId:string,result:NativeExecutionResult):OpeningOrder{
    const old=this.orders.get(orderId);if(!old)throw Error('NATIVE_ORDER_MISSING');
    const status=result.status==='prepared'?'unknown':result.status;
    const fill=result.status==='confirmed'?result:result.provisional?{...result,...result.provisional}:undefined;
    const patch={
      status,...(result.signature?{transactionHash:result.signature}:{}),failureReason:result.failureReason,
      ...(status==='confirmed'?{actualInputAmount:result.inputAmount,outputAmount:result.outputAmount}:{}),
      details:{...old.details,nativeIntentId:result.intentId,
        ...(result.timing?{nativeExecutionTiming:result.timing}:{}),
        ...(fill?{nativeFill:{signature:result.signature,slot:fill.slot,inputAmount:fill.inputAmount,
          outputAmount:fill.outputAmount,tokenDecimals:result.tokenDecimals,venue:result.venue,confirmedAt:fill.checkedAt,
          protectionMode:result.protectionMode,
          commitment:result.status==='confirmed'?'finalized':'confirmed',subscriptionAccounts:result.subscriptionAccounts??[]}}:{})}};
    let next:OpeningOrder;
    try{next=this.orders.update(orderId,['prepared','submitting','submitted','unknown','confirmed'],patch)??old;}
    catch{
      // The execution journal already owns this verified fill. A busy shared ledger
      // must not postpone durable registration in the independent position database.
      this.buySyncPending.set(orderId,result);
      this.recoveryOrders.add(orderId);
      if(fill)this.register({...old,...patch});
      return old;
    }
    this.buySyncPending.delete(orderId);
    if(['submitting','submitted','unknown','confirmed'].includes(next.status))this.recoveryOrders.add(orderId);else this.recoveryOrders.delete(orderId);
    if(fill)this.register(next);
    return next;
  }
  private register(order:OpeningOrder){
    const fill=order.details.nativeFill;
    if(!object(fill)||typeof fill.signature!=='string'||typeof fill.inputAmount!=='string'||typeof fill.outputAmount!=='string'||
      !Number.isSafeInteger(fill.slot)||!Number.isInteger(fill.tokenDecimals)||!Array.isArray(fill.subscriptionAccounts))throw Error('NATIVE_FILL_UNVERIFIED');
    const token=object(order.details.token)?order.details.token:{};
    const venue=fill.venue==='jupiter'||fill.venue==='pumpswap'||fill.venue==='pump'?fill.venue:'pump';
    const protectionMode=venue==='jupiter'||fill.protectionMode==='external_price_stream'?'external_price_stream':'account_stream';
    const newlyTracked=!this.mintOrders.has(order.tokenAddress);
    const registered=this.positions.register({orderId:order.id,wallet:order.wallet,mint:order.tokenAddress,inputAmount:fill.inputAmount,
      outputAmount:fill.outputAmount,tokenDecimals:Number(fill.tokenDecimals),signature:fill.signature,buySlot:Number(fill.slot),
      subscriptionAccounts:fill.subscriptionAccounts as string[],confirmedAt:String(fill.confirmedAt),name:clean(token.name??token.symbol),venue,protectionMode});
    if(registered.state==='active'){
      this.mintOrders.set(order.tokenAddress,order.id);
      // Recovery replays confirmed buys every pulse. They must not become HTTP price polling.
      if(registered.buy.protectionMode==='external_price_stream'){
        const sample=this.freshExternal(order.tokenAddress);if(sample)this.positions.observeExternalPrice(order.id,sample);
        if(newlyTracked||!this.externalTokenPrograms.has(order.tokenAddress))void this.warmExternal(order.tokenAddress,order.id);
      }else if(newlyTracked||!this.adapter.cacheStatus(order.wallet,order.tokenAddress).warm)void this.warm(order.tokenAddress,order.id);
    }
    // A provisional holding may have closed before its buy reached finalized.
    // Reconcile its authoritative state again now that the opening ledger can accept it.
    if(order.status==='confirmed'&&this.syncPosition(registered))this.recoveryOrders.delete(order.id);
  }
  private exitResult(result:NativeExecutionResult):NativePositionExitResult{
    if(result.status==='confirmed'&&result.signature&&result.inputAmount&&result.outputAmount)
      return {status:'confirmed',signature:result.signature,inputAmount:result.inputAmount,outputAmount:result.outputAmount,
        slot:result.slot!,confirmedAt:result.checkedAt??new Date().toISOString()};
    if(result.status==='failed')return {status:'failed',reason:result.failureReason};
    return {status:'pending',signature:result.signature,reason:result.failureReason};
  }
  private recordEvaluation(p:NativePositionState){
    const at=this.eventAt.get(p.buy.orderId);
    if(at!==undefined&&(p.quote?.source==='solana_account_stream'||p.quote?.source==='jupiter_exact_sell')&&!p.lastError&&
      !!p.lastCheckAt&&Date.parse(p.lastCheckAt)>=at&&Date.parse(p.quote.quotedAt)>=at){
      this.eventLatencies.push(Math.max(0,Date.now()-at));if(this.eventLatencies.length>1000)this.eventLatencies.shift();this.eventAt.delete(p.buy.orderId);
    }
    // Snapshot batching must not lose a brief crossing before the price falls back.
    this.captureMilestones(p);
  }
  private positionSummary(p:NativePositionState,g:number){
    const market=p.quote?.source==='jupiter_exact_sell'?(p.buy.protectionMode==='external_price_stream'?
      `外部实时价格唤醒 · ${p.quote.marketObservedAt??'手动查询'} · Jupiter 精确可卖报价`:
      `链上账户推送 · ${p.quote.marketObservedAt??'手动查询'} · Jupiter 精确可卖报价`):
      `链上账户推送 · 槽位 ${p.quote?.marketSlot??'未知'}`;
    return `${p.buy.name||p.buy.mint.slice(0,8)} · SOL\nCA：${p.buy.mint}\n当前可卖报价涨幅：${g>=0?'+':''}${g.toFixed(2)}%\n`+
      `剩余数量：${formatTokenUnits(p.balance!.amount,p.buy.tokenDecimals)}\n预计卖出所得：${SOL(p.quote!.outputAmount)} SOL\n`+
      `行情：${market}\n按链上成交成本和整仓卖出报价计算，未扣网络费和小费。`;
  }
  private captureMilestones(p:NativePositionState){
    if(p.state!=='active'||!p.balance||p.balance.amount==='0'||p.balance.provisionalZero||!p.quote||p.lastError||Date.parse(p.quote.expiresAt)<=Date.now())return;
    const g=gain(p);if(g===undefined||!Number.isFinite(g))return;
    const id=p.buy.orderId;
    try{
      const seen=this.milestoneSeen.get(id)??[];
      const crossed=crossedPriceMilestones(g,[...seen,...(this.pendingMilestones.get(id)?.crossed??[])]);
      if(crossed.length)this.pendingMilestones.set(id,{position:structuredClone(p),crossed:[...(this.pendingMilestones.get(id)?.crossed??[]),...crossed]});
      this.scheduleMilestones();
    }catch{/* Notification storage failure cannot prevent a protective exit. Retain the crossing for retry. */}
  }
  private scheduleMilestones(){
    if(!this.running||!this.pendingMilestones.size)return;
    const earliest=Math.min(...[...this.pendingMilestones.keys()].map(id=>this.milestoneRetryAt.get(id)??0));
    if(this.milestoneTimer&&this.milestoneTimerAt<=earliest)return;
    clearTimeout(this.milestoneTimer);this.milestoneTimerAt=earliest;
    this.milestoneTimer=setTimeout(()=>{this.milestoneTimer=undefined;this.milestoneTimerAt=0;this.flushPendingMilestones();this.scheduleMilestones();},Math.max(0,earliest-Date.now()));
    this.milestoneTimer.unref();
  }
  private flushPendingMilestones(){
    for(const id of this.pendingMilestones.keys())if(Date.now()>=(this.milestoneRetryAt.get(id)??0)){
      try{this.flushMilestones(id);this.milestoneRetryAt.delete(id);}catch{this.milestoneRetryAt.set(id,Date.now()+1000);}
    }
  }
  private flushMilestones(orderId:string){
    const pending=this.pendingMilestones.get(orderId);if(!pending)return;
    const {position:p}=pending;
    let seen:number[],crossed:number[];
    this.db.exec('BEGIN IMMEDIATE');try{
      const row=this.db.prepare('SELECT seen FROM native_reminders WHERE order_id=?').get(orderId);
      seen=row?JSON.parse(String(row.seen)):[];
      const watermark=Math.max(2000,...seen.filter(n=>n>=2100));
      crossed=pending.crossed.filter(n=>!seen.includes(n)&&(n<2100||n>watermark));
      if(crossed.length){
        this.queue(`native-milestone:${orderId}:${createHash('sha256').update(JSON.stringify(crossed)).digest('hex')}`,
          `【持仓涨跌提醒】\n越过 ${crossedMilestoneLabel(crossed)}\n${this.positionSummary(p,gain(p)!)}`);
        this.db.prepare('INSERT INTO native_reminders(order_id,seen) VALUES(?,?) ON CONFLICT(order_id) DO UPDATE SET seen=excluded.seen')
          .run(orderId,JSON.stringify([...seen,...crossed]));
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.milestoneSeen.set(orderId,[...seen,...crossed]);this.pendingMilestones.delete(orderId);this.flush();
  }
  private onPosition(event:NativePositionUpdate){
    const p=event.position,b=p.balance,current=this.positions.get(p.buy.orderId)??p;
    if(current.state==='closed')this.releaseMarket(current.buy.mint,current.buy.orderId);
    const order=this.orders.get(p.buy.orderId);
    if(!order)return;
    this.syncPosition(current);
    if(current.state==='closed'&&['snapshot','registered','exit_pending'].includes(event.type))return;
    const now=Date.now(),quoteFresh=!!p.quote&&Date.parse(p.quote.expiresAt)>now;
    const derivedCurrent=current.revision===p.revision&&current.state==='active'&&!current.balance?.provisionalZero;
    // A finalized zero is necessary to close; positive confirmed balances may still drive protection.
    const name=p.buy.name||p.buy.mint.slice(0,8),header=`${name} · SOL\nCA：${p.buy.mint}\n`;
    if(event.type==='exit_pending'||event.type==='exit_confirmed'||event.type==='exit_failed'){
      const x=p.pendingExit??p.lastExit;
      if(x){const kind=x.reason==='take_profit'?'止盈':x.reason==='stop_loss'?'止损':'手动卖出';
        this.notice(event.key,`【原生${kind}】\n${header}${event.type==='exit_pending'?'⏳ 已提交执行任务，等待链上确认':
          event.type==='exit_confirmed'?'✅ 链上成交已确认':'⚠️ 本次未成交'} · ${x.percent}%\n`+
          (x.inputAmount?`成交数量：${formatTokenUnits(x.inputAmount,p.buy.tokenDecimals)}\n`:'')+
          (x.outputAmount?`收到：${SOL(x.outputAmount)} SOL（未扣网络费用）\n`:'')+
          (x.failureReason?`原因：${x.failureReason}\n`:'')+(x.signature?`https://solscan.io/tx/${x.signature}`:''));
      }
    }
    if(event.type==='closed')this.notice(event.key,`【原生持仓已清空】\n${header}`+
      (p.closeReason==='sold'&&p.finalPnlKnown&&p.realizedPnlLamports!==undefined?`已实现兑换盈亏：${Number(p.realizedPnlLamports)/1e9} SOL（未扣网络费和小费）`:
        '链上余额已确认归零。包含外部资产变动，最终盈亏不能据此推算。')+'\n已停止该持仓的涨跌提醒。');
    if(derivedCurrent&&p.state==='active'&&b?.amount!=='0'&&quoteFresh){
      if(!this.monitorReady.has(order.id))this.monitorReady.add(order.id);
      this.captureMilestones(p);
      this.flushPendingMilestones();
      this.db.prepare('INSERT OR IGNORE INTO native_reminders(order_id) VALUES(?)').run(order.id);
      // Quotes and protection keep updating continuously. Periodic summaries
      // stay on the dashboard; Telegram is reserved for positive milestones
      // and actual exit operations.
    }
    this.flush();
  }
  private syncPosition(p:NativePositionState):boolean{
    try{this.persistPosition(p);this.orderSyncPending.delete(p.buy.orderId);return true;}
    catch{this.orderSyncPending.add(p.buy.orderId);return false;}
  }
  private persistPosition(p:NativePositionState){
    const order=this.orders.get(p.buy.orderId),b=p.balance,fill=order?.details.nativeFill;
    if(!order||order.exit?.positionClosed||!b||!object(fill))return;
    this.orders.updateNativeProtection(order.id,{provider:'pump_native',
      healthy:p.state==='active'&&!p.lastError&&!b.provisionalZero&&!!p.quote&&Date.parse(p.quote.expiresAt)>Date.now()&&this.positionStreamHealthy(p.buy.orderId),
      checkedAt:b.observedAt,buySignature:p.buy.signature,buySlot:Number(fill.slot),balanceSlot:b.slot,balanceAmount:b.amount,
      closed:p.state==='closed'&&b.commitment==='finalized',closeReason:p.closeReason,gainPct:gain(p),realizedPnlLamports:p.realizedPnlLamports});
  }
  private queue(key:string,text:string){this.db.prepare('INSERT OR IGNORE INTO native_notice_outbox(key,text) VALUES(?,?)').run(key,text);}
  private notice(key:string,text:string){this.queue(key,text);this.flush();}
  private flush(){for(const row of this.db.prepare('SELECT key,text FROM native_notice_outbox WHERE queued=0 LIMIT 100').all()){
    try{this.enqueue({key:String(row.key),text:String(row.text)});this.db.prepare('UPDATE native_notice_outbox SET queued=1 WHERE key=?').run(row.key);}catch{break;}
  }}
  isClosed(orderId:string){return this.positions.get(orderId)?.state==='closed';}
  get(orderId:string){return this.positions.get(orderId);}
  ownsAction(ref:string){return !!this.db.prepare('SELECT 1 FROM native_actions WHERE ref=?').get(ref);}
  createAction(orderId:string){const p=this.positions.get(orderId);if(!p||p.state==='closed'||p.pendingExit)throw Error('NATIVE_POSITION_UNAVAILABLE');
    const ref=randomBytes(16).toString('hex');this.db.prepare('INSERT INTO native_actions(ref,order_id,expires) VALUES(?,?,?)').run(ref,orderId,Date.now()+86400000);return ref;}
  async submit(ref:string,percent:SellPercentage){
    this.db.exec('BEGIN IMMEDIATE');let row:Record<string,unknown>|undefined;
    try{row=this.db.prepare('SELECT * FROM native_actions WHERE ref=?').get(ref);
      if(!row||Number(row.expires)<Date.now()||!Number.isSafeInteger(percent)||percent<1||percent>100)throw Error('NATIVE_SELL_BUTTON_EXPIRED');
      if(row.intent_id){this.db.exec('COMMIT');return {text:'该按钮的卖出请求已受理，请刷新持仓查看成交状态。'};}
      const p=this.positions.get(String(row.order_id));if(!p||p.state==='closed'||p.pendingExit)throw Error('NATIVE_POSITION_BUSY');
      const intent='manual-'+randomUUID();this.db.prepare('UPDATE native_actions SET intent_id=?,percentage=? WHERE ref=?').run(intent,percent,ref);
      row.intent_id=intent;this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');return {text:error instanceof Error?error.message:'NATIVE_SELL_UNAVAILABLE'};}
    return this.dispatchManual(String(row.order_id),percent,String(row.intent_id));
  }
  private dispatchManual(orderId:string,percent:SellPercentage,intentId:string){
    const result=this.positions.manualSell(orderId,percent,intentId);
    this.db.prepare('UPDATE native_actions SET dispatched=1 WHERE intent_id=?').run(intentId);
    if(result.status==='blocked')return {text:`卖出未提交：${result.reason??'NATIVE_POSITION_UNAVAILABLE'}`};
    return {text:`⏳ 已接受卖出剩余持仓 ${percent}% 的请求，完成后通知。防夹通道：Jito。`};
  }
  start(){if(this.running)return;this.running=true;this.startedAt=Date.now();void this.executor.warmup().catch(()=>{});this.stream.start();this.positions.start();void this.pulse();
    this.timer=setInterval(()=>{void this.pulse();},2000);this.timer.unref();}
  private async pulse(){if(!this.running||this.busy)return;this.busy=true;
    this.work=(async()=>{
      await this.executor.warmup();this.chainVerified=true;
      for(const [id,result] of [...this.buySyncPending])this.applyBuy(id,result);
      if(!this.recoveryLoaded){for(const order of this.orders.activeNativePositions())this.recoveryOrders.add(order.id);
        this.recoveryLoaded=true;}
      for(const id of [...this.recoveryOrders]){const order=this.orders.get(id);
        if(!order||order.details.executionProvider!=='pump_native'||!['submitting','submitted','confirmed','unknown'].includes(order.status)){
          this.recoveryOrders.delete(id);continue;}
        if(order.status==='confirmed')this.register(order);
        else this.applyBuy(order.id,await this.executor.reconcile('buy-'+order.id));
      }
      this.initialRecoveryComplete=true;
      for(const row of this.db.prepare('SELECT * FROM native_actions WHERE intent_id IS NOT NULL AND dispatched=0 LIMIT 20').all())
        this.dispatchManual(String(row.order_id),Number(row.percentage) as SellPercentage,String(row.intent_id));
      for(const id of this.orderSyncPending){const p=this.positions.get(id);if(p)this.syncPosition(p);else this.orderSyncPending.delete(id);}
      this.flushPendingMilestones();
      void this.bootstrap();
      this.flush();this.error=undefined;
    })().catch(()=>{this.error='NATIVE_RECOVERY_UNAVAILABLE';}).finally(()=>{this.busy=false;this.healthNotice();});
    await this.work;
  }
  private healthNotice(){
    if(!this.running||Date.now()-this.startedAt<15000)return;
    const s=this.positions.status(),old=this.db.prepare('SELECT * FROM native_health WHERE id=1').get()!;
    const unhealthyPosition=this.positions.hasUnhealthyActive();
    const unhealthy=s.active>0&&(!this.transportHealthy()||unhealthyPosition||!!this.error);
    if(unhealthy&&!old.active){const episode=Number(old.episode)+1;
      this.db.prepare('UPDATE native_health SET active=1,episode=? WHERE id=1').run(episode);
    }else if(!unhealthy&&old.active){
      this.db.prepare('UPDATE native_health SET active=0 WHERE id=1').run();
    }
  }
  async stop(){this.running=false;clearInterval(this.timer);this.stream.stop();const stopping=this.executor.stop();await this.positions.stop();
    await this.work;await Promise.allSettled([...this.tasks,this.inventoryWork,...this.warming.values(),...this.zeroWork.values()].filter((p):p is Promise<unknown>=>!!p));
    await stopping;await this.positions.close();clearTimeout(this.milestoneTimer);this.flushPendingMilestones();this.executor.close();this.db.close();}
}
