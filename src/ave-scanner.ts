import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {abortable,type Fetcher} from './http.js';
import {parseSignal,type Chain,type Report,type Signal} from './types.js';
import {scoreDebotRisk} from './debot-risk-score.js';
import {fetchAveSignalPage,normalizeAveSignalPush,AveSignalError,type AveSignalObservation,type NormalizedAveSignals} from './providers/ave-signals.js';
import {normalizePriceToken} from './market-price-normalizers.js';
import type {ScanToken} from './scan-archive.js';
import {VendorPerformanceLedger} from './vendor-performance-ledger.js';

export interface AveSocket {
  readyState:number;send(data:string):void;close(code?:number,reason?:string):void;
  addEventListener(type:string,listener:(event:any)=>void):void;
  removeEventListener(type:string,listener:(event:any)=>void):void;
}
export interface AveScannerOptions {
  database:string;chains:Chain[];fetcher?:Fetcher;now?:()=>Date;
  onObservation:(observation:AveSignalObservation)=>void;
  onSignal:(signal:Signal,firstObservedAt:string)=>Promise<unknown>;
  shouldDefer?:()=>string|undefined;socketFactory?:(url:string)=>AveSocket;
  onPriceFrame?:(payload:unknown,receivedAt:string)=>void;
}
export interface AveSignalListOptions {limit?:number;offset?:number;chain?:Chain;asOf?:string;}
type Row={id:string;chain:Chain;address:string;occurred_at:string;observed_at:string;payload:string;
  state:string;reason:string|null;dispatched_at:string|null;completed_at:string|null;report:string|null};
const safeReasons=(value:unknown)=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(v)).slice(0,24):[];
const parseDate=(value:string)=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const MAX_AGE_MS=120_000,PER_TOKEN_MS=60_000,MAX_FRAME_BYTES=2*1024*1024;
const MAX_PRICE_TOPICS=200,PRICE_FRESH_MS=30_000,PRICE_RECOVERY_MIN_MS=60_000,PRICE_RECOVERY_MAX_MS=600_000;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const priceTopic=(raw:ScanToken)=>{const token=normalizePriceToken(raw);return token?`${token.address}-${token.chain}`:undefined;};

/** A public signal stream and durable read-only research queue. Account login is
 * deliberately separate: an open public websocket does not prove authentication. */
export class AveScanner {
  private readonly db:DatabaseSync;private readonly now:()=>Date;private readonly chains:Chain[];
  private running=false;private stopped=false;private closed=false;private generation=0;
  private controller=new AbortController();private socket?:AveSocket;
  private socketListeners:[string,(event:any)=>void][]=[];
  private reconnectTimer?:ReturnType<typeof setTimeout>;private pollTimer?:ReturnType<typeof setTimeout>;
  private dispatchTimer?:ReturnType<typeof setTimeout>;private heartbeatTimer?:ReturnType<typeof setTimeout>;
  private collecting?:Promise<void>;private dispatching?:Promise<void>;
  private connectionState:'stopped'|'connecting'|'connected'|'backoff'='stopped';
  private lastConnectedAt?:string;private lastMessageAt?:string;private lastSignalAt?:string;private lastPollAt?:string;
  private lastError?:string;private deferredReason?:string;private reconnects=0;private reconnectAttempt=0;
  private cooldownUntil=0;private nextDispatchAt=0;private lastPruned=0;private connectedAtMs=0;
  private priceTokens:string[]=[];private subscribedPriceTokens:string[]=[];private priceRequestId=10;
  private priorityPriceTokens:string[]=[];private desiredPriceTokens=0;private desiredPriorityTokens=0;
  private readonly priceRequests=new Map<number,'subscribe'|'unsubscribe'>();
  private readonly topicSubscribedAt=new Map<string,number>();
  private readonly topicPrices=new Map<string,{priceAt:number;receivedAt:number;lastFreshReceivedAt?:number}>();
  private readonly topicRecovery=new Map<string,{at:number;attempt:number}>();
  private lastPriceFrameAt?:string;private lastPriceAt?:string;private lastPriceReceivedAt?:string;
  private lastPriceSubscribeAt?:string;private lastPriceRecoveryAt?:string;private priceRecoveries=0;private priceError?:string;
  private readonly performance:VendorPerformanceLedger;private vendorPerformanceError?:string;

  constructor(private readonly options:AveScannerOptions){
    this.now=options.now??(()=>new Date());this.chains=[...new Set(options.chains)];
    if(!this.chains.length||this.chains.some(c=>!['bsc','solana','robinhood'].includes(c)))throw new Error('AVE_SCANNER_CONFIG_INVALID');
    if(options.database!==':memory:')mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.database);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1500;
      CREATE TABLE IF NOT EXISTS ave_signals (
        id TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,
        dispatched_at TEXT,completed_at TEXT,report TEXT
      );
      CREATE INDEX IF NOT EXISTS ave_signals_queue ON ave_signals(state,occurred_at);
      CREATE INDEX IF NOT EXISTS ave_signals_observed ON ave_signals(observed_at,id);
      CREATE INDEX IF NOT EXISTS ave_signals_token ON ave_signals(chain,address,dispatched_at);
      CREATE TABLE IF NOT EXISTS review_retention_watermarks(source TEXT PRIMARY KEY,pruned_through TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS ave_review_retention AFTER DELETE ON ave_signals BEGIN
        INSERT INTO review_retention_watermarks(source,pruned_through) VALUES('ave',OLD.observed_at)
          ON CONFLICT(source) DO UPDATE SET pruned_through=MAX(pruned_through,excluded.pruned_through);
      END;
      UPDATE ave_signals SET state='interrupted',reason='AVE_SIGNAL_INTERRUPTED' WHERE state='dispatching';`);
    const size=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    this.db.exec(`PRAGMA max_page_count=${Math.floor(64*1024*1024/size)}`);
    this.performance=new VendorPerformanceLedger(this.db,this.now);
    if(options.database!==':memory:')chmodSync(options.database,0o600);
    const at=this.db.prepare('SELECT max(dispatched_at) AS at FROM ave_signals').get()?.at;
    if(typeof at==='string')this.nextDispatchAt=Date.parse(at)+1000;
    this.prune();
  }
  private alive(generation:number){return !this.closed&&!this.stopped&&generation===this.generation;}
  /** Bounded current-price topics share the already-open public socket. Explicit
   * holdings take precedence over research, including when their signal chain is paused. */
  setPriceTokens(tokens:ScanToken[],priorityTokens:ScanToken[]=[]):void {
    if(this.closed)return;
    const priorities=[...new Set(priorityTokens.map(priceTopic).filter((key):key is string=>!!key))];
    const all=[...new Set([...priorities,...tokens.map(priceTopic).filter((key):key is string=>!!key)])];
    this.desiredPriceTokens=all.length;this.desiredPriorityTokens=priorities.length;
    this.priceTokens=all.slice(0,MAX_PRICE_TOPICS);
    this.priorityPriceTokens=priorities.filter(key=>this.priceTokens.includes(key));
    for(const key of this.topicRecovery.keys())if(!this.priorityPriceTokens.includes(key))this.topicRecovery.delete(key);
    this.syncPriceTopics();
  }
  /** True means this live socket sent the topic subscription, not that Ave
   * acknowledged it or that a fresh executable price exists. */
  hasPriceSubscription(token:ScanToken):boolean {
    const key=priceTopic(token);
    return !this.closed&&!this.stopped&&this.socket?.readyState===1&&!!key&&this.subscribedPriceTokens.includes(key);
  }
  private sendPriceTopics(method:'subscribe'|'unsubscribe',topics:string[]):void {
    const id=++this.priceRequestId;
    this.socket!.send(JSON.stringify({jsonrpc:'2.0',method,params:['pricev2',topics],id}));
    this.priceRequests.set(id,method);
    // Track standard JSON-RPC errors without inventing an unobserved acknowledgement schema.
    while(this.priceRequests.size>128)this.priceRequests.delete(this.priceRequests.keys().next().value!);
  }
  private syncPriceTopics():void {
    if(this.socket?.readyState!==1)return;
    const add=this.priceTokens.filter(t=>!this.subscribedPriceTokens.includes(t));
    const remove=this.subscribedPriceTokens.filter(t=>!this.priceTokens.includes(t));
    if(!add.length&&!remove.length)return;
    try {
      if(remove.length)this.sendPriceTopics('unsubscribe',remove);
      // Live A -> B -> A+B control on 2026-10-26 proved pricev2 subscribe
      // replaces this socket's topic set. An add-only request silently drops
      // existing holdings; remove-only changes must also restore the full set.
      if(this.priceTokens.length){this.sendPriceTopics('subscribe',this.priceTokens);this.lastPriceSubscribeAt=this.now().toISOString();
        for(const key of add)this.topicSubscribedAt.set(key,this.now().getTime());}
      for(const key of remove){this.topicSubscribedAt.delete(key);this.topicPrices.delete(key);this.topicRecovery.delete(key);}
      this.subscribedPriceTokens=[...this.priceTokens];
    }catch{this.priceError='AVE_PRICE_SUBSCRIBE_FAILED';this.reconnect(this.priceError);}
  }
  /** A transport pong is not a quote. Only validated current main-pair updates
   * for the exact requested chain/CA advance a topic's price clock. */
  private observePriceFrame(value:unknown,receivedAt:string):boolean {
    if(!object(value)||!object(value.result)||value.result.status!=='ok'||!object(value.result.data)||
      value.result.data.event!=='pricev2'||!Array.isArray(value.result.data.prices))return false;
    this.lastPriceFrameAt=receivedAt;const received=Date.parse(receivedAt);
    for(const row of value.result.data.prices.slice(0,MAX_PRICE_TOPICS)){
      if(!object(row)||row.is_main_pair!==true||!Number.isSafeInteger(row.time)||Number(row.time)<=0||Number(row.time)>8.64e12||
        typeof row.uprice!=='number'||!Number.isFinite(row.uprice)||row.uprice<=0)continue;
      const token=normalizePriceToken({chain:row.chain,address:row.token}),target=normalizePriceToken({chain:row.chain,address:row.target_token});
      if(!token||!target||token.chain!==target.chain||token.address!==target.address)continue;
      const key=priceTopic(token)!,at=Number(row.time)*1000;
      if(!this.subscribedPriceTokens.includes(key)||at>received)continue;
      const previous=this.topicPrices.get(key);if(previous&&at<=previous.priceAt)continue;
      const fresh=received-at<=PRICE_FRESH_MS;
      this.topicPrices.set(key,{priceAt:at,receivedAt:received,
        lastFreshReceivedAt:fresh?received:previous?.lastFreshReceivedAt});
      if(!this.lastPriceAt||at>Date.parse(this.lastPriceAt)){this.lastPriceAt=new Date(at).toISOString();this.lastPriceReceivedAt=receivedAt;}
      if(fresh){this.topicRecovery.delete(key);this.priceError=undefined;}
    }
    return true;
  }
  /** An illiquid token may be quiet legitimately. A stalled holding triggers
   * full-set websocket resubscription; backoff is tracked per stalled holding
   * at 60s/120s/240s/... (capped at 10m), never HTTP. */
  private recoverPriceTopics():void {
    if(this.socket?.readyState!==1)return;
    const now=this.now().getTime(),topics=this.priorityPriceTokens.filter(key=>{
      if(!this.subscribedPriceTokens.includes(key))return false;
      const price=this.topicPrices.get(key);if(price&&price.priceAt<=now&&now-price.priceAt<=PRICE_FRESH_MS)return false;
      const recovery=this.topicRecovery.get(key),baseline=Math.max(this.topicSubscribedAt.get(key)??now,
        price?.lastFreshReceivedAt??0,recovery?.at??0);
      const delay=Math.min(PRICE_RECOVERY_MAX_MS,PRICE_RECOVERY_MIN_MS*2**Math.min(recovery?.attempt??0,4));
      return now-baseline>=delay;
    });
    if(!topics.length)return;
    try{
      // A recovery subscribe also replaces the set: preserve healthy holdings
      // and research subscriptions, without advancing any existing price clock.
      this.sendPriceTopics('unsubscribe',topics);this.sendPriceTopics('subscribe',this.priceTokens);
      for(const key of topics)this.topicRecovery.set(key,{at:now,attempt:(this.topicRecovery.get(key)?.attempt??0)+1});
      this.lastPriceSubscribeAt=this.lastPriceRecoveryAt=new Date(now).toISOString();this.priceRecoveries++;
      this.priceError='AVE_PRICE_UPDATES_STALE';
    }catch{this.priceError='AVE_PRICE_SUBSCRIBE_FAILED';this.reconnect(this.priceError);}
  }
  private priceStatus(){
    const now=this.now().getTime(),fresh=(key:string)=>{const price=this.topicPrices.get(key);
      return !!price&&price.priceAt<=now&&now-price.priceAt<=PRICE_FRESH_MS;};
    const freshTokens=this.subscribedPriceTokens.filter(fresh).length,priorityFreshTokens=this.priorityPriceTokens.filter(fresh).length;
    const observedTokens=this.subscribedPriceTokens.filter(key=>this.topicPrices.has(key)).length;
    const focus=this.priorityPriceTokens.length?this.priorityPriceTokens:this.priceTokens;
    const freshFocus=this.priorityPriceTokens.length?priorityFreshTokens:freshTokens;
    const waiting=focus.some(key=>now-(this.topicSubscribedAt.get(key)??now)<PRICE_RECOVERY_MIN_MS);
    const state=!this.priceTokens.length?'inactive':this.connectionState!=='connected'?'disconnected':
      freshFocus===focus.length?'live':freshFocus>0?'partial':waiting?'waiting':'stale';
    return {topic:'pricev2' as const,transport:'websocket' as const,state,capacity:MAX_PRICE_TOPICS,
      desiredTokens:this.desiredPriceTokens,requestedTokens:this.priceTokens.length,sentTokens:this.subscribedPriceTokens.length,
      priorityTokens:this.priorityPriceTokens.length,desiredPriorityTokens:this.desiredPriorityTokens,
      overflowTokens:Math.max(0,this.desiredPriceTokens-MAX_PRICE_TOPICS),
      subscriptionBasis:'request_sent' as const,subscriptionAcknowledged:false,observedTokens,freshTokens,priorityFreshTokens,
      lastFrameAt:this.lastPriceFrameAt,lastPriceAt:this.lastPriceAt,lastPriceReceivedAt:this.lastPriceReceivedAt,
      lastSubscribeAt:this.lastPriceSubscribeAt,lastRecoveryAt:this.lastPriceRecoveryAt,recoveries:this.priceRecoveries,
      lastError:this.priceError,freshForSec:PRICE_FRESH_MS/1000,recoveryMinSec:PRICE_RECOVERY_MIN_MS/1000,recoveryMaxSec:PRICE_RECOVERY_MAX_MS/1000};
  }
  private prune(){
    const now=this.now().getTime();if(this.lastPruned&&now-this.lastPruned<60_000)return;
    this.db.prepare('DELETE FROM ave_signals WHERE observed_at<?').run(new Date(now-30*86400_000).toISOString());
    this.db.exec(`DELETE FROM ave_signals WHERE id IN (SELECT id FROM ave_signals ORDER BY observed_at DESC,id DESC LIMIT -1 OFFSET 10000)`);
    this.lastPruned=now;
  }
  /** Persist and publish observation before enqueueing slow safety/wallet research. */
  acceptPage(page:NormalizedAveSignals):void {
    if(this.closed||this.stopped)return;
    if(page.reason&&page.reason!=='AVE_SIGNAL_RECORDS_REJECTED'){this.lastError='AVE_SIGNAL_RESPONSE_INVALID';return;}
    for(const observation of page.observations.slice(0,20).sort((a,b)=>a.signal.occurredAt.localeCompare(b.signal.occurredAt)||a.id.localeCompare(b.id))){
      if(this.closed||this.stopped)break;
      try {this.record(observation);}catch(error){
        this.lastError=error instanceof Error&&'errcode' in error&&error.errcode===13?'AVE_SIGNAL_STORE_FULL':'AVE_SIGNAL_PERSIST_FAILED';
      }
    }
    try {this.prune();}catch {this.lastError='AVE_SIGNAL_PERSIST_FAILED';}
  }
  acceptPush(payload:unknown):void {
    if(this.closed||this.stopped)return;
    const page=normalizeAveSignalPush(payload,this.now(),this.chains);
    // Other public socket channels, subscription acknowledgements and pongs are not errors.
    if(page.reason==='AVE_SIGNAL_PUSH_INVALID')return;
    this.acceptPage(page);
  }
  private record(observation:AveSignalObservation){
    const signal=parseSignal(observation.signal),now=this.now().getTime();
    if(signal.source!=='ave'||!this.chains.includes(signal.token.chain)||!/^ave:signal:[a-f0-9]{64}$/.test(signal.sourceEventId)||
      !parseDate(observation.observedAt)||Date.parse(observation.observedAt)>now+30_000||
      Date.parse(signal.occurredAt)>now+30_000||!/^\d{1,16}$/.test(observation.id))throw new Error('AVE_SIGNAL_INPUT_INVALID');
    const serialized=JSON.stringify(observation);if(Buffer.byteLength(serialized)>64_000)throw new Error('AVE_SIGNAL_INPUT_INVALID');
    const existing=this.db.prepare('SELECT chain,address FROM ave_signals WHERE id=?').get(signal.sourceEventId);
    if(existing&&(existing.chain!==signal.token.chain||existing.address!==signal.token.address))return;
    // Display-only peak changes survive duplicate suppression without becoming
    // another notification, price sample, callback or research task.
    if(observation.vendorPerformance)try {this.performance.record(observation);this.vendorPerformanceError=undefined;}
    catch {this.vendorPerformanceError='VENDOR_PERFORMANCE_PERSIST_FAILED';}
    if(existing)return;
    const stale=now-Date.parse(signal.occurredAt)>MAX_AGE_MS;
    this.db.exec('SAVEPOINT ave_record');
    try {
      this.db.prepare(`INSERT INTO ave_signals(id,chain,address,occurred_at,observed_at,payload,state,reason)
        VALUES(?,?,?,?,?,?,?,?)`).run(signal.sourceEventId,signal.token.chain,signal.token.address,signal.occurredAt,
        observation.observedAt,serialized,stale?'ignored':'pending',stale?'AVE_SIGNAL_STALE':null);
      if(!stale)this.db.prepare(`UPDATE ave_signals SET state='ignored',reason='AVE_SIGNAL_TOKEN_COALESCED'
        WHERE chain=? AND address=? AND state='pending' AND id<>? AND occurred_at<=?`).run(
          signal.token.chain,signal.token.address,signal.sourceEventId,signal.occurredAt);
      // Late older alarms remain history; do not replace a newer pending observation.
      const newer=this.db.prepare(`SELECT 1 FROM ave_signals WHERE chain=? AND address=? AND state='pending' AND occurred_at>? LIMIT 1`)
        .get(signal.token.chain,signal.token.address,signal.occurredAt);
      if(newer)this.db.prepare("UPDATE ave_signals SET state='ignored',reason='AVE_SIGNAL_TOKEN_COALESCED' WHERE id=?").run(signal.sourceEventId);
      this.db.exec('RELEASE ave_record');
    }catch(error){this.db.exec('ROLLBACK TO ave_record; RELEASE ave_record');throw error;}
    this.lastSignalAt=observation.observedAt;
    try {this.options.onObservation(structuredClone(observation));}catch {this.lastError='AVE_SIGNAL_OBSERVATION_CALLBACK_FAILED';}
  }
  runOnce():Promise<void>{
    if(this.collecting)return this.collecting;if(this.closed||this.stopped)return Promise.resolve();
    const generation=this.generation;
    const work=Promise.resolve().then(async()=>{
      if(this.now().getTime()<this.cooldownUntil)return;
      try {const page=await fetchAveSignalPage(this.chains,{fetcher:this.options.fetcher,now:this.now,signal:this.controller.signal});
        if(!this.alive(generation))return;
        this.lastPollAt=this.now().toISOString();
        if(!page.reason||page.reason==='AVE_SIGNAL_RECORDS_REJECTED')this.lastError=undefined;
        this.acceptPage(page);
      }catch(error){if(!this.alive(generation))return;
        this.lastError=error instanceof AveSignalError?error.reason:'AVE_SIGNAL_REQUEST_FAILED';
        if(error instanceof AveSignalError&&error.cooldownUntil)this.cooldownUntil=error.cooldownUntil;
      }
    }).finally(()=>{if(this.collecting===work)this.collecting=undefined;});
    this.collecting=work;return work;
  }
  dispatchOnce():Promise<void>{
    if(this.dispatching)return this.dispatching;if(this.closed||this.stopped)return Promise.resolve();
    const generation=this.generation,work=Promise.resolve().then(async()=>{
      const now=this.now();
      this.db.prepare(`UPDATE ave_signals SET state='ignored',reason='AVE_SIGNAL_STALE' WHERE state='pending' AND occurred_at<?`)
        .run(new Date(now.getTime()-MAX_AGE_MS).toISOString());
      if(now.getTime()<this.nextDispatchAt)return;
      const defer=this.options.shouldDefer?.();this.deferredReason=defer&&/^[A-Z][A-Z0-9_]{0,99}$/.test(defer)?defer:defer?'AVE_RESEARCH_DEFERRED':undefined;
      if(defer)return;
      const row=this.db.prepare(`SELECT a.* FROM ave_signals a WHERE a.state='pending' AND a.chain IN (${this.chains.map(()=>'?').join(',')}) AND NOT EXISTS
        (SELECT 1 FROM ave_signals b WHERE b.chain=a.chain AND b.address=a.address AND b.dispatched_at>?)
        ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1`).get(...this.chains,new Date(now.getTime()-PER_TOKEN_MS).toISOString()) as Row|undefined;
      if(!row||!this.alive(generation))return;
      this.nextDispatchAt=now.getTime()+1000;
      this.db.prepare("UPDATE ave_signals SET state='dispatching',dispatched_at=? WHERE id=?").run(now.toISOString(),row.id);
      try {
        const observation=JSON.parse(row.payload) as AveSignalObservation;
        await abortable(Promise.resolve().then(()=>{
          if(!this.alive(generation))return;
          return this.options.onSignal(observation.signal,row.observed_at);
        }),this.controller.signal);
        if(this.alive(generation))this.db.prepare("UPDATE ave_signals SET state='completed',completed_at=? WHERE id=? AND state='dispatching'")
          .run(this.now().toISOString(),row.id);
      }catch {if(this.alive(generation)){this.lastError='AVE_SIGNAL_ANALYSIS_FAILED';
        this.db.prepare("UPDATE ave_signals SET state='failed',reason='AVE_SIGNAL_ANALYSIS_FAILED',completed_at=? WHERE id=?")
          .run(this.now().toISOString(),row.id);}}
    }).catch(()=>{if(this.alive(generation))this.lastError='AVE_SIGNAL_DISPATCH_FAILED';})
      .finally(()=>{if(this.dispatching===work)this.dispatching=undefined;});
    this.dispatching=work;return work;
  }
  vendorWalletTargets(signal:Signal){
    if(this.closed||signal.source!=='ave')return;
    const row=this.db.prepare('SELECT * FROM ave_signals WHERE id=?').get(signal.sourceEventId) as Row|undefined;
    if(!row||row.chain!==signal.token.chain||row.address!==signal.token.address)return;
    const at=Date.parse(row.observed_at),now=this.now().getTime();if(at>now||now-at>MAX_AGE_MS||now-Date.parse(row.occurred_at)>MAX_AGE_MS)return;
    const observation=JSON.parse(row.payload) as AveSignalObservation;
    const addresses=[...new Set((observation.vendorWallets??[]).filter(w=>w.source==='ave'&&w.verification==='vendor_report')
      .flatMap(w=>{try{return [parseSignal({...signal,token:{chain:row.chain,address:w.address}}).token.address];}catch{return [];}})
      .filter(address=>address!==signal.token.address&&!/^0x0{40}$/i.test(address)&&address!=='11111111111111111111111111111111'))].slice(0,3);
    if(!addresses.length)return;
    return {provider:'ave' as const,token:signal.token,checkedAt:row.observed_at,addresses};
  }
  recordReport(signalId:string,report:Report):void {
    if(this.closed||report.signal.source!=='ave'||report.signal.sourceEventId!==signalId)return;
    const row=this.db.prepare("SELECT * FROM ave_signals WHERE id=? AND state IN ('dispatching','completed')").get(signalId) as Row|undefined;
    if(!row||row.chain!==report.signal.token.chain||row.address!==report.signal.token.address||report.mode!=='live')return;
    const check=(value:Report['safety']|undefined)=>value?{status:value.status,checkedAt:value.checkedAt,reasons:safeReasons(value.reasons)}:undefined;
    const summary={reportId:report.id,decision:report.decision,buyEligible:report.buyEligible,evaluatedAt:report.evaluatedAt,
      validUntil:report.validUntil,reasons:safeReasons(report.reasons),checks:{safety:check(report.safety),
        provenance:check(report.provenance),market:check(report.marketRisk),wallets:check(report.flow)}};
    this.db.prepare('UPDATE ave_signals SET report=? WHERE id=?').run(JSON.stringify(summary),signalId);
  }
  list(options:AveSignalListOptions={}){
    const limit=options.limit??20,offset=options.offset??0,now=this.now(),asOf=options.asOf??now.toISOString();
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1_000_000||
      options.chain&&!['bsc','solana','robinhood'].includes(options.chain)||!parseDate(asOf))throw new Error('INVALID_FILTER');
    const where=`observed_at<=?${options.chain?' AND chain=?':''}`,params=options.chain?[asOf,options.chain]:[asOf];
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM ave_signals WHERE ${where}`).get(...params)!.n);
    const rows=this.db.prepare(`SELECT * FROM ave_signals WHERE ${where} ORDER BY observed_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset) as Row[];
    const items=rows.map(row=>{
      const o=JSON.parse(row.payload) as AveSignalObservation,report=row.report?JSON.parse(row.report):undefined;
      return {id:row.id,vendorId:o.id,chain:row.chain,address:row.address,name:o.name,symbol:o.symbol,kind:o.kind,
        occurredAt:row.occurred_at,observedAt:row.observed_at,firstObservedAt:row.observed_at,state:row.state,reason:row.reason??undefined,
        vendorWalletCount:o.vendorWalletCount,vendorWallets:o.vendorWallets,headline:o.headline,socialUrl:o.socialUrl,
        dispatchedAt:row.dispatched_at??undefined,completedAt:row.completed_at??undefined,
        ...(report?{...report,riskScore:scoreDebotRisk({state:row.state,...report},now)}:{})};
    });return {now:now.toISOString(),asOf,total,limit,offset,hasMore:offset+items.length<total,items};
  }
  getStatus(){
    if(this.closed)return {enabled:true,running:false,mode:'public_signal_stream' as const,connected:false,connectionState:'stopped',researchOnly:true,tradingEnabled:false,
      priceStream:this.priceStatus()};
    const rows=this.db.prepare('SELECT state,count(*) AS n FROM ave_signals GROUP BY state').all();
    const count=Object.fromEntries(rows.map(r=>[r.state,Number(r.n)]));
    const oldest=this.db.prepare("SELECT min(observed_at) AS at FROM ave_signals WHERE state='pending'").get()?.at;
    return {enabled:true,running:this.running,mode:'public_signal_stream' as const,connected:this.connectionState==='connected',
      connectionState:this.connectionState,lastConnectedAt:this.lastConnectedAt,lastMessageAt:this.lastMessageAt,
      priceStream:this.priceStatus(),
      lastSignalAt:this.lastSignalAt,lastPollAt:this.lastPollAt,lastError:this.lastError,deferredReason:this.deferredReason,
      vendorPerformanceError:this.vendorPerformanceError,
      reconnects:this.reconnects,cooldownUntil:this.cooldownUntil>this.now().getTime()?new Date(this.cooldownUntil).toISOString():undefined,
      stored:rows.reduce((sum,r)=>sum+Number(r.n),0),pending:(count.pending??0)+(count.dispatching??0),completed:count.completed??0,
      ignored:count.ignored??0,failed:count.failed??0,interrupted:count.interrupted??0,inFlight:!!this.dispatching||!!this.collecting,
      queueAgeSec:typeof oldest==='string'?Math.max(0,(this.now().getTime()-Date.parse(oldest))/1000):undefined,
      researchOnly:true,tradingEnabled:false,intervalSec:60};
  }
  private disconnect(){
    clearTimeout(this.heartbeatTimer);this.heartbeatTimer=undefined;
    const socket=this.socket;this.socket=undefined;
    this.subscribedPriceTokens=[];
    this.priceRequests.clear();this.topicSubscribedAt.clear();this.topicPrices.clear();
    if(socket){for(const [type,listener] of this.socketListeners)socket.removeEventListener(type,listener);
      try {socket.close(1000,'observer stopped');}catch {/* Transport already closed. */}}
    this.socketListeners=[];
  }
  private reconnect(reason:string){
    if(!this.running||this.closed||this.stopped)return;
    this.disconnect();this.lastError=reason;this.connectionState='backoff';clearTimeout(this.reconnectTimer);
    const delay=Math.min(60_000,1000*2**Math.min(this.reconnectAttempt++,6))*(.8+Math.random()*.4);
    this.reconnectTimer=setTimeout(()=>{this.reconnects++;this.connect();},Math.round(delay));this.reconnectTimer.unref?.();
  }
  private connect(){
    if(!this.running||this.closed||this.stopped)return;
    const generation=this.generation;this.connectionState='connecting';
    let socket:AveSocket;
    try {socket=(this.options.socketFactory??(url=>new WebSocket(url)))('wss://yiyulu.com/ws');}
    catch {this.reconnect('AVE_STREAM_CONNECT_FAILED');return;}
    this.socket=socket;this.connectedAtMs=this.now().getTime();
    const on=(type:string,listener:(event:any)=>void)=>{this.socketListeners.push([type,listener]);socket.addEventListener(type,listener);};
    const current=()=>this.alive(generation)&&this.socket===socket;
    on('open',()=>{if(!current())return;
      this.connectionState='connected';this.lastConnectedAt=this.now().toISOString();this.connectedAtMs=this.now().getTime();
      try {socket.send(JSON.stringify({jsonrpc:'2.0',method:'subscribe',params:['signalsv2_public_monitor',this.chains.join(',')],id:1}));}
      catch {this.reconnect('AVE_STREAM_SUBSCRIBE_FAILED');return;}
      this.syncPriceTopics();
    });
    on('message',(event:{data:unknown})=>{if(!current())return;
      if(typeof event.data!=='string'||Buffer.byteLength(event.data)>MAX_FRAME_BYTES){this.reconnect('AVE_STREAM_FRAME_INVALID');return;}
      // The observed public /ws endpoint answers JSON-RPC ping with plain text.
      if(event.data==='pong'){this.lastMessageAt=this.now().toISOString();this.reconnectAttempt=0;return;}
      let value:unknown;try {value=JSON.parse(event.data);}catch {this.lastError='AVE_STREAM_JSON_INVALID';return;}
      this.lastMessageAt=this.now().toISOString();this.reconnectAttempt=0;
      if(object(value)&&typeof value.id==='number'&&this.priceRequests.has(value.id)){
        this.priceRequests.delete(value.id);
        if(value.error!==undefined&&value.error!==null){this.priceError='AVE_PRICE_SUBSCRIBE_REJECTED';this.reconnect(this.priceError);return;}
      }
      if(this.observePriceFrame(value,this.lastMessageAt))try {this.options.onPriceFrame?.(value,this.lastMessageAt);}
      catch{this.lastError=this.priceError='AVE_PRICE_CALLBACK_FAILED';}
      this.acceptPush(value);
    });
    on('error',()=>{if(current())this.reconnect('AVE_STREAM_TRANSPORT_ERROR');});
    on('close',()=>{if(current())this.reconnect('AVE_STREAM_DISCONNECTED');});
    const heartbeat=()=>{if(!current())return;
      const last=this.lastMessageAt?Date.parse(this.lastMessageAt):this.connectedAtMs;
      if(this.now().getTime()-Math.max(last,this.connectedAtMs)>=45_000){this.reconnect('AVE_STREAM_HEARTBEAT_TIMEOUT');return;}
      try {if(socket.readyState===1)socket.send('{"jsonrpc":"2.0","method":"ping","id":1}');}
      catch {this.reconnect('AVE_STREAM_PING_FAILED');return;}
      this.recoverPriceTopics();if(!current())return;
      this.heartbeatTimer=setTimeout(heartbeat,15_000);this.heartbeatTimer.unref?.();
    };
    this.heartbeatTimer=setTimeout(heartbeat,15_000);this.heartbeatTimer.unref?.();
  }
  start(){
    if(this.running||this.closed)return;
    this.running=true;this.stopped=false;this.controller=new AbortController();this.connect();
    const generation=this.generation;
    const poll=async()=>{if(!this.alive(generation)||!this.running)return;await this.runOnce();
      if(this.alive(generation)&&this.running){this.pollTimer=setTimeout(()=>void poll(),60_000);this.pollTimer.unref?.();}};
    const dispatch=async()=>{if(!this.alive(generation)||!this.running)return;await this.dispatchOnce();
      if(this.alive(generation)&&this.running){this.dispatchTimer=setTimeout(()=>void dispatch(),1000);this.dispatchTimer.unref?.();}};
    void poll();void dispatch();
  }
  async stop(){
    if(this.closed)return;
    this.running=false;this.stopped=true;this.generation++;this.controller.abort();
    clearTimeout(this.pollTimer);clearTimeout(this.dispatchTimer);clearTimeout(this.reconnectTimer);this.disconnect();this.connectionState='stopped';
    this.db.exec("UPDATE ave_signals SET state='interrupted',reason='AVE_SIGNAL_INTERRUPTED' WHERE state='dispatching'");
    await Promise.allSettled([this.collecting,this.dispatching].filter((p):p is Promise<void>=>!!p));
  }
  async close(){if(this.closed)return;await this.stop();this.closed=true;this.db.close();}
}
