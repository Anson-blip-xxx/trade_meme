import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync,openSync,closeSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import bs58 from 'bs58';
import {CURRENT_STOP_LOSS_DROP_PCT,stopLossPricePct,type StopLossDropPct} from '../exit-policy.js';

export interface NativeConfirmedPosition {
  orderId:string;wallet:string;mint:string;inputAmount:string;outputAmount:string;tokenDecimals:number;
  signature:string;buySlot:number;subscriptionAccounts:string[];confirmedAt?:string;name?:string;
}
/** Aggregate every token account for this wallet/mint; a single ATA is insufficient. */
export interface NativePositionBalance {
  amount:string;tokenDecimals:number;slot:number;commitment:'confirmed'|'finalized';observedAt:string;
  wallet:string;mint:string;
  /** A current confirmed zero is waiting for an older finalized snapshot to catch up. */
  provisionalZero?:boolean;
}
export interface NativePositionQuote {
  wallet:string;mint:string;inputAmount:string;outputAmount:string;minimumOutputAmount:string;
  quotedAt:string;expiresAt:string;subscriptionAccounts?:string[];
  source?:'solana_account_stream';marketObservedAt?:string;marketSlot?:number;
}
export type NativeExitReason='take_profit'|'stop_loss'|'manual';
export type NativeSellPercentage=number;
const validSellPercentage=(value:unknown):value is NativeSellPercentage=>
  typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=100;
export type NativePositionExitResult=
  | {status:'pending';signature?:string;reason?:string}
  | {status:'failed';reason?:string}
  | {status:'confirmed';signature:string;inputAmount:string;outputAmount:string;confirmedAt:string;slot:number};
export interface NativePositionExitRequest {
  orderId:string;wallet:string;mint:string;operationId:string;percent:NativeSellPercentage;reason:NativeExitReason;
  /** The executor must verify this amount again under its shared manual/automatic sell lock. */
  expectedAmount:string;quote:NativePositionQuote;
}
export interface NativePositionIO {
  balance(input:{orderId:string;wallet:string;mint:string;signal:AbortSignal}):Promise<NativePositionBalance>;
  quote(input:{orderId:string;wallet:string;mint:string;amount:string;signal:AbortSignal}):Promise<NativePositionQuote>;
  /** operationId is an executor intentId, durably idempotent across crashes. */
  sell(input:NativePositionExitRequest):Promise<NativePositionExitResult>;
  /** Look up this intent without a replacement trade; only proved non-submission/failure may fail it. */
  reconcile(input:{orderId:string;wallet:string;mint:string;operationId:string;signature?:string;signal:AbortSignal}):Promise<NativePositionExitResult>;
}
export interface NativePositionExit {
  operationId:string;percent:NativeSellPercentage;reason:NativeExitReason;expectedAmount:string;
  state:'preparing'|'pending'|'confirmed'|'failed';createdAt:string;updatedAt:string;signature?:string;failureReason?:string;
  inputAmount?:string;outputAmount?:string;confirmedAt?:string;slot?:number;
}
export interface NativePositionState {
  buy:NativeConfirmedPosition;state:'active'|'closed';registeredAt:string;updatedAt:string;revision:number;
  /** These exact ratios describe swap-only SOL cost, excluding network fees and tips. */
  costBasis:{solLamports:string;tokenAtoms:string;excludesNetworkFees:true};
  balance?:NativePositionBalance;quote?:NativePositionQuote;lastCheckAt?:string;lastAttemptAt?:string;
  lastStreamAt?:string;dirty:boolean;takeProfitDone:boolean;pendingExit?:NativePositionExit;lastExit?:NativePositionExit;
  soldTokenAmount:string;saleProceedsLamports:string;realizedCostLamports:string;realizedPnlLamports?:string;
  externalReductionAmount:string;externalIncreaseAmount:string;expectedBalanceAmount:string;
  closedAt?:string;closeReason?:'sold'|'external_zero';finalPnlKnown:boolean;lastError?:string;
}
export interface NativePositionUpdate {
  key:string;type:'registered'|'snapshot'|'exit_pending'|'exit_confirmed'|'exit_failed'|'closed';position:NativePositionState;
}
interface NativePositionDue {orderId:string;at:number;sequence:number;}
export interface NativePositionSupervisorOptions {
  io:NativePositionIO;onUpdate?:(event:NativePositionUpdate)=>void|boolean|Promise<void|boolean>;now?:()=>number;
  /** Root owns accountSubscribe and feeds markDirty / setStreamState. */
  onSubscriptions?:(accounts:string[])=>void;
  loopMs?:number;fallbackIntervalMs?:number;minCheckIntervalMs?:number;requestTimeoutMs?:number;
  staleAfterMs?:number;maxPositions?:number;batchSize?:number;autoSchedule?:boolean;
  /** Evaluate dirty positions independently; slow exit RPC for one mint cannot block another. */
  eventDriven?:boolean;
  /** Local decision timing, before awaiting execution or notification delivery. */
  onEvaluation?:(position:NativePositionState)=>void;
  /** Ordinary observations are coalesced; financial changes always commit immediately. */
  snapshotIntervalMs?:number;
  stopLossDropPct?:StopLossDropPct;
}

export function nativeStopLossTriggered(output:bigint,bought:bigint,cost:bigint,amount:bigint,dropPct:StopLossDropPct):boolean {
  return output*bought*100n<=cost*amount*BigInt(stopLossPricePct(dropPct));
}

const atomic=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d{0,19})$/.test(v)&&BigInt(v)<=(1n<<64n)-1n;
const slot=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const base58=(v:unknown,length:number)=>{try{return typeof v==='string'&&bs58.decode(v).length===length&&bs58.encode(bs58.decode(v))===v;}catch{return false;}};
const iso=(n:number)=>new Date(n).toISOString();
const timestamp=(v:unknown)=>typeof v==='string'&&v.length<=40?Date.parse(v):NaN;
const safeCode=(v:unknown,fallback:string)=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,119}$/.test(v)?v:fallback;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
function bounded(v:number|undefined,fallback:number,min:number,max:number):number {
  if(v!==undefined&&(!Number.isSafeInteger(v)||v<min||v>max))throw Error('NATIVE_POSITION_OPTIONS_INVALID');return v??fallback;
}

/** Durable, independent supervision of confirmed native SOL buys; all RPC and signing stay in injected IO. */
export class NativePositionSupervisor {
  private readonly db:DatabaseSync;private readonly now:()=>number;
  private readonly loopMs:number;private readonly fallbackMs:number;private readonly minCheckMs:number;
  private readonly timeoutMs:number;private readonly staleMs:number;private readonly maxPositions:number;private readonly batchSize:number;
  private readonly stopLossDropPct:StopLossDropPct;
  private running=false;private closed=false;private timer?:ReturnType<typeof setTimeout>;private flight?:Promise<void>;
  private generation=0;private controllers=new Set<AbortController>();private flushFlight?:Promise<void>;
  private connected=false;private subscribed=new Set<string>();private lastTickAt?:string;private lastError?:string;
  private accountOrders=new Map<string,Set<string>>();private positionAccounts=new Map<string,string[]>();
  private checks=new Map<string,Promise<void>>();private dirtySequence=new Map<string,number>();
  private immediate=new Map<string,ReturnType<typeof setTimeout>>();
  private readonly snapshotMs:number;
  private rows=new Map<string,NativePositionState>();
  private durableRevisions=new Map<string,number>();
  private pendingSnapshots=new Set<string>();
  private snapshotTimer?:ReturnType<typeof setTimeout>;
  private transactionUpdates?:Map<string,NativePositionState>;
  private checkSequences=new Map<string,number>();
  private pendingDelivery=false;
  /** Lazy min-heap: a 50ms wake-up only touches positions whose fallback is due. */
  private dueHeap:NativePositionDue[]=[];
  private dueByOrder=new Map<string,NativePositionDue>();
  private dueSequence=0;
  constructor(path:string,private readonly options:NativePositionSupervisorOptions){
    if(!path||path.startsWith('file:')||!options.io||['balance','quote','sell','reconcile'].some(k=>typeof options.io[k as keyof NativePositionIO]!=='function'))throw Error('NATIVE_POSITION_OPTIONS_INVALID');
    this.now=options.now??Date.now;this.loopMs=bounded(options.loopMs,1000,50,10000);
    this.fallbackMs=bounded(options.fallbackIntervalMs,5000,1000,30000);this.minCheckMs=bounded(options.minCheckIntervalMs,1000,0,10000);
    this.timeoutMs=bounded(options.requestTimeoutMs,5000,20,10000);this.staleMs=bounded(options.staleAfterMs,20000,1000,60000);
    this.maxPositions=bounded(options.maxPositions,20,1,2000);this.batchSize=bounded(options.batchSize,4,1,20);
    this.snapshotMs=bounded(options.snapshotIntervalMs,1000,50,5000);
    this.stopLossDropPct=options.stopLossDropPct??CURRENT_STOP_LOSS_DROP_PCT;
    if(this.fallbackMs>this.staleMs||this.minCheckMs>this.fallbackMs)throw Error('NATIVE_POSITION_OPTIONS_INVALID');
    if(path!==':memory:'){mkdirSync(dirname(path),{recursive:true,mode:0o700});const fd=openSync(path,'a',0o600);closeSync(fd);chmodSync(path,0o600);}
    this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS native_positions(order_id TEXT PRIMARY KEY,wallet TEXT NOT NULL,mint TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(wallet,mint));
      CREATE TABLE IF NOT EXISTS native_position_events(key TEXT PRIMARY KEY,payload TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS native_position_streams(order_id TEXT PRIMARY KEY,observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_position_intents(operation_id TEXT PRIMARY KEY,order_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_position_fills(signature TEXT PRIMARY KEY,operation_id TEXT NOT NULL,order_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS native_position_active ON native_positions(state);
      CREATE INDEX IF NOT EXISTS native_position_events_pending ON native_position_events(delivered);`);
    for(const raw of this.db.prepare("SELECT payload FROM native_positions WHERE state='active' ORDER BY rowid").all()){
      const row=this.decode(raw.payload);this.durableRevisions.set(row.buy.orderId,row.revision);
      // Restored market observations never authorize a trade or make supervision healthy.
      delete row.quote;delete row.lastCheckAt;delete row.lastAttemptAt;delete row.lastStreamAt;row.dirty=true;
      this.rows.set(row.buy.orderId,row);this.index(row);this.scheduleDue(row);
    }
    this.pendingDelivery=!!this.db.prepare('SELECT 1 FROM native_position_events WHERE delivered=0 LIMIT 1').get();
  }
  private clock():number {const n=this.now();if(!Number.isSafeInteger(n)||n<0||n>8.64e15)throw Error('NATIVE_POSITION_CLOCK_INVALID');return n;}
  private open(){if(this.closed)throw Error('NATIVE_POSITION_CLOSED');}
  private tx<T>(fn:()=>T):T{this.open();if(this.transactionUpdates)throw Error('NATIVE_POSITION_NESTED_TRANSACTION');
    this.db.exec('BEGIN IMMEDIATE');this.transactionUpdates=new Map();try{
      const r=fn();this.db.exec('COMMIT');const updates=this.transactionUpdates;this.transactionUpdates=undefined;
      for(const row of updates.values())this.install(row,true);return r;
    }catch(e){this.transactionUpdates=undefined;this.db.exec('ROLLBACK');throw e;}
  }
  private decode(payload:unknown):NativePositionState {return JSON.parse(String(payload)) as NativePositionState;}
  get(orderId:string):NativePositionState|undefined{this.open();const row=this.rows.get(orderId);if(row)return structuredClone(row);
    const r=this.db.prepare('SELECT payload FROM native_positions WHERE order_id=?').get(orderId);return r?this.decode(r.payload):undefined;}
  list():NativePositionState[]{this.open();return this.db.prepare('SELECT payload FROM native_positions ORDER BY rowid').all().map(r=>{
    const row=this.decode(r.payload);return structuredClone(this.rows.get(row.buy.orderId)??row);
  });}
  /** Contract-bound display metadata may arrive after financial registration. */
  setName(orderId:string,name:string):boolean {
    this.open();const value=typeof name==='string'?name.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,80):'';
    const row=this.get(orderId);if(!row||row.state!=='active'||!value)return false;
    if(row.buy.name===value)return true;
    row.buy.name=value;return this.save(row);
  }
  private nextDue(row:NativePositionState):number {
    const last=row.lastAttemptAt?timestamp(row.lastAttemptAt):NaN;
    if(!Number.isFinite(last))return 0;
    return last+(row.pendingExit?this.fallbackMs:row.dirty?this.minCheckMs:this.fallbackMs);
  }
  private heapPush(value:NativePositionDue){
    const heap=this.dueHeap;heap.push(value);let i=heap.length-1;
    while(i){const parent=(i-1)>>1;if(heap[parent].at<value.at||heap[parent].at===value.at&&heap[parent].sequence<=value.sequence)break;
      heap[i]=heap[parent];i=parent;}heap[i]=value;
  }
  private heapPop():NativePositionDue|undefined {
    const heap=this.dueHeap,root=heap[0],last=heap.pop();if(!root||!last||!heap.length)return root;
    let i=0;while(true){const left=i*2+1;if(left>=heap.length)break;const right=left+1;
      let child=right<heap.length&&(heap[right].at<heap[left].at||heap[right].at===heap[left].at&&heap[right].sequence<heap[left].sequence)?right:left;
      if(heap[child].at>last.at||heap[child].at===last.at&&heap[child].sequence>=last.sequence)break;
      heap[i]=heap[child];i=child;}heap[i]=last;return root;
  }
  private scheduleDue(row:NativePositionState){
    const orderId=row.buy.orderId;
    if(row.state!=='active'){this.dueByOrder.delete(orderId);return;}
    const at=this.nextDue(row),existing=this.dueByOrder.get(orderId);if(existing?.at===at)return;
    const item={orderId,at,sequence:++this.dueSequence};this.dueByOrder.set(orderId,item);this.heapPush(item);
  }
  private takeDue(now:number):NativePositionState[]{
    const rows:NativePositionState[]=[];
    while(rows.length<this.batchSize){
      const head=this.dueHeap[0];if(!head||head.at>now)break;this.heapPop();
      if(this.dueByOrder.get(head.orderId)!==head)continue;
      const row=this.rows.get(head.orderId);if(!row||row.state!=='active'){this.dueByOrder.delete(head.orderId);continue;}
      this.dueByOrder.delete(head.orderId);
      const at=this.nextDue(row);if(at>now){this.scheduleDue(row);continue;}
      rows.push(structuredClone(row));
    }
    return rows;
  }
  private install(row:NativePositionState,durable=false){
    const orderId=row.buy.orderId;this.index(row);
    if(row.state==='closed'){
      this.rows.delete(orderId);this.durableRevisions.delete(orderId);this.pendingSnapshots.delete(orderId);
      this.dueByOrder.delete(orderId);
      const timer=this.immediate.get(orderId);if(timer)clearTimeout(timer);this.immediate.delete(orderId);
    }else{
      this.rows.set(orderId,structuredClone(row));
      this.scheduleDue(row);
      if(durable){this.durableRevisions.set(orderId,row.revision);this.pendingSnapshots.delete(orderId);}
      else{this.pendingSnapshots.add(orderId);this.scheduleSnapshots();}
    }
    if(!this.pendingSnapshots.size){clearTimeout(this.snapshotTimer);this.snapshotTimer=undefined;}
  }
  private mergeStream(row:NativePositionState,current:NativePositionState){
    if(current.lastStreamAt&&(!row.lastStreamAt||timestamp(current.lastStreamAt)>timestamp(row.lastStreamAt)))row.lastStreamAt=current.lastStreamAt;
    const started=this.checkSequences.get(row.buy.orderId);
    if(started!==undefined&&(this.dirtySequence.get(row.buy.orderId)??0)>started)row.dirty=true;
  }
  private financialState(row:NativePositionState){return JSON.stringify([row.state,row.pendingExit,row.lastExit,row.takeProfitDone,
    row.costBasis,row.soldTokenAmount,row.saleProceedsLamports,row.realizedCostLamports,row.realizedPnlLamports,
    row.externalReductionAmount,row.externalIncreaseAmount,row.expectedBalanceAmount,row.closedAt,row.closeReason,row.finalPnlKnown]);}
  private scheduleSnapshots(){
    if(!this.running||this.closed||this.snapshotTimer||!this.pendingSnapshots.size)return;
    this.snapshotTimer=setTimeout(()=>{this.snapshotTimer=undefined;
      try{this.persistSnapshots();void this.flush();}catch{this.lastError='NATIVE_POSITION_SNAPSHOT_FAILED';}
      this.scheduleSnapshots();
    },this.snapshotMs);this.snapshotTimer.unref();
  }
  private persistSnapshots(){
    if(!this.pendingSnapshots.size)return;
    this.tx(()=>{for(const orderId of this.pendingSnapshots){const row=this.rows.get(orderId);if(!row||row.state!=='active')continue;
      const expected=this.durableRevisions.get(orderId);
      if(expected===undefined||this.db.prepare('UPDATE native_positions SET revision=?,payload=? WHERE order_id=? AND revision=? AND state=\'active\'')
        .run(row.revision,JSON.stringify(row),orderId,expected).changes!==1)throw Error('NATIVE_POSITION_SNAPSHOT_CONFLICT');
      this.transactionUpdates!.set(orderId,structuredClone(row));this.event(row,'snapshot');
    }});
    if(this.lastError==='NATIVE_POSITION_SNAPSHOT_FAILED')this.lastError=undefined;
  }
  private index(row:NativePositionState){
    const orderId=row.buy.orderId,next=row.state==='active'?row.buy.subscriptionAccounts:[],old=this.positionAccounts.get(orderId)??[];
    if(JSON.stringify(old)===JSON.stringify(next)&&(row.state==='active'?this.positionAccounts.has(orderId):!this.positionAccounts.has(orderId)))return;
    for(const a of old){const ids=this.accountOrders.get(a);ids?.delete(orderId);if(!ids?.size)this.accountOrders.delete(a);}
    if(row.state==='closed'){this.positionAccounts.delete(orderId);this.dirtySequence.delete(orderId);return;}
    this.positionAccounts.set(orderId,[...next]);for(const a of next){const ids=this.accountOrders.get(a)??new Set<string>();ids.add(orderId);this.accountOrders.set(a,ids);}
  }
  private save(row:NativePositionState,type:NativePositionUpdate['type']='snapshot'):boolean {
    const current=this.rows.get(row.buy.orderId);
    if(type==='snapshot'&&current&&!(row.quote&&row.lastCheckAt&&!current.lastCheckAt)&&this.financialState(current)===this.financialState(row)){
      if(current.revision!==row.revision)return false;
      this.mergeStream(row,current);row.revision++;row.updatedAt=iso(this.clock());this.install(row);return true;
    }
    return this.tx(()=>this.saveInside(row,type));
  }
  private saveInside(row:NativePositionState,type:NativePositionUpdate['type']):boolean {
      const current=this.rows.get(row.buy.orderId),expected=this.durableRevisions.get(row.buy.orderId);
      if(!current||current.revision!==row.revision||expected===undefined)return false;
      this.mergeStream(row,current);row.revision++;row.updatedAt=iso(this.clock());
      const changed=this.db.prepare('UPDATE native_positions SET state=?,revision=?,payload=? WHERE order_id=? AND revision=?')
        .run(row.state,row.revision,JSON.stringify(row),row.buy.orderId,expected).changes===1;
      if(!changed){row.revision=current.revision;return false;}
      this.transactionUpdates!.set(row.buy.orderId,structuredClone(row));this.event(row,type);return true;
  }
  private event(row:NativePositionState,type:NativePositionUpdate['type']){
    this.pendingDelivery=true;
    const suffix=type.startsWith('exit_')?(row.pendingExit??row.lastExit)?.operationId:type;
    const key=`native-position:${row.buy.orderId}:${type}:${suffix??row.revision}`;
    const event:NativePositionUpdate={key,type,position:row};
    if(type==='snapshot')this.db.prepare('INSERT INTO native_position_events VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,delivered=0').run(key,JSON.stringify(event));
    else this.db.prepare('INSERT OR IGNORE INTO native_position_events VALUES(?,?,0)').run(key,JSON.stringify(event));
    if(type==='closed')this.db.prepare("DELETE FROM native_position_events WHERE key=? AND delivered=0").run(`native-position:${row.buy.orderId}:snapshot:snapshot`);
  }
  register(input:NativeConfirmedPosition):NativePositionState {
    this.open();const now=this.clock();
    if(!input||!id(input.orderId)||!base58(input.wallet,32)||!base58(input.mint,32)||!base58(input.signature,64)||!slot(input.buySlot)||
      !atomic(input.inputAmount)||input.inputAmount==='0'||!atomic(input.outputAmount)||input.outputAmount==='0'||
      !Number.isInteger(input.tokenDecimals)||input.tokenDecimals<0||input.tokenDecimals>255||
      !Array.isArray(input.subscriptionAccounts)||input.subscriptionAccounts.length>100||input.subscriptionAccounts.some(a=>!base58(a,32))||
      input.confirmedAt!==undefined&&(!Number.isFinite(timestamp(input.confirmedAt))||timestamp(input.confirmedAt)>now))throw Error('NATIVE_POSITION_INPUT_INVALID');
    const buy:NativeConfirmedPosition={orderId:input.orderId,wallet:input.wallet,mint:input.mint,inputAmount:input.inputAmount,outputAmount:input.outputAmount,
      tokenDecimals:input.tokenDecimals,signature:input.signature,buySlot:input.buySlot,subscriptionAccounts:[...new Set(input.subscriptionAccounts)].sort(),
      confirmedAt:input.confirmedAt??iso(now),...(typeof input.name==='string'?{name:input.name.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,80)}:{})};
    const old=this.get(buy.orderId);
    if(old){if(['wallet','mint','inputAmount','outputAmount','tokenDecimals','signature','buySlot'].some(k=>old.buy[k as keyof NativeConfirmedPosition]!==buy[k as keyof NativeConfirmedPosition]))throw Error('NATIVE_POSITION_IDENTITY_CONFLICT');return old;}
    const row:NativePositionState={buy,state:'active',registeredAt:iso(now),updatedAt:iso(now),revision:0,
      costBasis:{solLamports:buy.inputAmount,tokenAtoms:buy.outputAmount,excludesNetworkFees:true},dirty:true,takeProfitDone:false,
      soldTokenAmount:'0',saleProceedsLamports:'0',realizedCostLamports:'0',realizedPnlLamports:'0',
      externalReductionAmount:'0',externalIncreaseAmount:'0',expectedBalanceAmount:buy.outputAmount,finalPnlKnown:false};
    this.tx(()=>{if(this.db.prepare('SELECT 1 FROM native_positions WHERE wallet=? AND mint=?').get(buy.wallet,buy.mint))throw Error('NATIVE_POSITION_DUPLICATE_TOKEN');
      this.db.prepare('INSERT INTO native_positions VALUES(?,?,?,?,?,?)').run(buy.orderId,buy.wallet,buy.mint,row.state,row.revision,JSON.stringify(row));
      this.transactionUpdates!.set(buy.orderId,structuredClone(row));this.event(row,'registered');});
    this.syncSubscriptions();void this.flush();return structuredClone(row);
  }
  accounts():string[]{return [...this.accountOrders.keys()].sort();}
  replaceSubscriptions(orderId:string,accounts:string[]):void {
    if(!accounts.length||accounts.length>100||accounts.some(a=>!base58(a,32)))throw Error('NATIVE_POSITION_STREAM_INVALID');
    const row=this.get(orderId);if(!row||row.state!=='active')return;
    const next=[...new Set(accounts)].sort();if(JSON.stringify(row.buy.subscriptionAccounts)===JSON.stringify(next))return;
    row.buy.subscriptionAccounts=next;if(this.save(row))this.syncSubscriptions();
  }
  private syncSubscriptions(){try{this.options.onSubscriptions?.(this.accounts());if(this.lastError==='NATIVE_POSITION_SUBSCRIPTION_FAILED')this.lastError=undefined;}catch{this.lastError='NATIVE_POSITION_SUBSCRIPTION_FAILED';}}
  setStreamState(input:{connected:boolean;subscribedAccounts:string[]}):void {
    this.open();if(typeof input?.connected!=='boolean'||!Array.isArray(input.subscribedAccounts)||input.subscribedAccounts.some(a=>!base58(a,32)))throw Error('NATIVE_POSITION_STREAM_INVALID');
    this.connected=input.connected;this.subscribed=new Set(input.subscribedAccounts);
  }
  markDirty(accountOrOrderId:string,input:{slot?:number;observedAt?:string}={}):void {
    this.open();const now=this.clock(),at=input.observedAt===undefined?now:timestamp(input.observedAt);
    if(!Number.isFinite(at)||at>now||now-at>this.staleMs||input.slot!==undefined&&!slot(input.slot))return;
    const ids=this.positionAccounts.has(accountOrOrderId)?[accountOrOrderId]:[...(this.accountOrders.get(accountOrOrderId)??[])];
    for(const orderId of ids){const row=this.rows.get(orderId);if(row?.state==='active'&&
      (input.slot===undefined||input.slot>=row.buy.buySlot)){
      if(!row.lastStreamAt||at>timestamp(row.lastStreamAt))row.lastStreamAt=iso(at);
      row.dirty=true;
      this.scheduleDue(row);
      this.dirtySequence.set(orderId,(this.dirtySequence.get(orderId)??0)+1);
      if(this.options.eventDriven&&this.running&&!this.immediate.has(orderId)){
        const timer=setTimeout(()=>{this.immediate.delete(orderId);void this.checkNow(orderId);},5);timer.unref();this.immediate.set(orderId,timer);
      }
    }}
  }
  start():void {this.open();if(this.running)return;this.running=true;this.generation++;this.syncSubscriptions();this.scheduleSnapshots();if(this.options.autoSchedule!==false)this.schedule(0);}
  manualSell(orderId:string,percent:NativeSellPercentage,operationId:string):{status:'accepted'|'existing'|'blocked';operationId:string;reason?:string}{
    this.open();if(!id(operationId)||!validSellPercentage(percent))return {status:'blocked',operationId,reason:'NATIVE_POSITION_MANUAL_INVALID'};
    if(!this.running)return {status:'blocked',operationId,reason:'NATIVE_POSITION_SUPERVISOR_STOPPED'};
    const result=this.tx(()=>{
      const existing=this.db.prepare('SELECT order_id FROM native_position_intents WHERE operation_id=?').get(operationId);
      if(existing)return {status:existing.order_id===orderId?'existing' as const:'blocked' as const,operationId,...(existing.order_id===orderId?{}:{reason:'NATIVE_POSITION_INTENT_CONFLICT'})};
      const row=this.get(orderId);if(!row||row.state!=='active')return {status:'blocked' as const,operationId,reason:'NATIVE_POSITION_NOT_ACTIVE'};
      if(row.pendingExit)return {status:'blocked' as const,operationId,reason:'NATIVE_POSITION_EXIT_PENDING'};
      const now=iso(this.clock());row.pendingExit={operationId,percent,reason:'manual',expectedAmount:'0',state:'preparing',createdAt:now,updatedAt:now};
      row.dirty=true;delete row.lastAttemptAt;
      this.db.prepare('INSERT INTO native_position_intents VALUES(?,?)').run(operationId,orderId);
      if(!this.saveInside(row,'exit_pending'))throw Error('NATIVE_POSITION_STATE_CONFLICT');
      return {status:'accepted' as const,operationId};
    });
    if(result.status==='accepted')void this.tick();return result;
  }
  private schedule(delay=this.loopMs){if(!this.running||this.closed)return;this.timer=setTimeout(()=>{this.timer=undefined;void this.tick().finally(()=>this.schedule());},delay);this.timer.unref();}
  async stop():Promise<void>{this.running=false;this.generation++;clearTimeout(this.timer);this.timer=undefined;
    clearTimeout(this.snapshotTimer);this.snapshotTimer=undefined;for(const t of this.immediate.values())clearTimeout(t);this.immediate.clear();
    for(const c of this.controllers)c.abort();await this.flight;await Promise.allSettled([...this.checks.values()]);await this.flushFlight;
    if(!this.closed)this.persistSnapshots();
  }
  async close():Promise<void>{if(this.closed)return;await this.stop();this.closed=true;this.db.close();}
  readiness():{ready:boolean;reason?:string}{
    if(this.closed||!this.running)return {ready:false,reason:'NATIVE_POSITION_SUPERVISOR_STOPPED'};
    if(this.lastError)return {ready:false,reason:this.lastError};
    const now=this.clock();
    if(this.rows.size>=this.maxPositions)return {ready:false,reason:'NATIVE_POSITION_CAPACITY_REACHED'};
    for(const row of this.rows.values())if(!row.lastCheckAt||timestamp(row.lastCheckAt)>now||now-timestamp(row.lastCheckAt)>this.staleMs||!!row.lastError)
      return {ready:false,reason:'NATIVE_POSITION_SUPERVISION_STALE'};
    return {ready:true};
  }
  status(){const now=this.clock();let pendingExits=0,stale=0;for(const row of this.rows.values()){
    if(row.pendingExit)pendingExits++;if(!row.lastCheckAt||now-timestamp(row.lastCheckAt)>this.staleMs||!!row.lastError)stale++;
  }return {...this.readiness(),running:this.running,active:this.rows.size,
    pendingExits,stale,
    streamConnected:this.connected,subscriptionAccounts:this.accounts().length,subscribedAccounts:this.accounts().filter(a=>this.subscribed.has(a)).length,
    lastTickAt:this.lastTickAt,lastError:this.lastError,fallbackIntervalMs:this.fallbackMs,maxPositions:this.maxPositions,
    snapshotIntervalMs:this.snapshotMs,pendingSnapshots:this.pendingSnapshots.size};}
  /** Health checks use the authoritative in-memory active set; position history must never be scanned on the price loop. */
  hasUnhealthyActive(staleMs=15000,pendingGraceMs=30000):boolean {
    if(!Number.isSafeInteger(staleMs)||staleMs<0||!Number.isSafeInteger(pendingGraceMs)||pendingGraceMs<0)
      throw Error('NATIVE_POSITION_HEALTH_OPTIONS_INVALID');
    const now=this.clock();
    for(const row of this.rows.values())if(!(row.pendingExit&&now-timestamp(row.pendingExit.createdAt)<pendingGraceMs)&&
      (!row.lastCheckAt||now-timestamp(row.lastCheckAt)>staleMs||!!row.lastError))return true;
    return false;
  }
  tick():Promise<void>{
    this.open();if(!this.running)return Promise.resolve();if(this.flight)return this.flight;
    this.flight=this.runTick(this.generation).catch(()=>{this.lastError='NATIVE_POSITION_TICK_FAILED';}).finally(()=>{this.flight=undefined;});return this.flight;
  }
  /** Stream path is keyed by position, independent of the fallback tick's slowest IO. */
  checkNow(orderId:string):Promise<void>{
    if(!this.running||this.closed)return Promise.resolve();const row=this.get(orderId);
    if(!row||row.state!=='active'||row.pendingExit&&row.pendingExit.state!=='preparing')return Promise.resolve();
    return this.runCheck(row,this.generation);
  }
  private runCheck(row:NativePositionState,generation:number):Promise<void>{
    const id=row.buy.orderId,existing=this.checks.get(id);if(existing)return existing;
    const sequence=this.dirtySequence.get(id)??0;
    this.checkSequences.set(id,sequence);
    const work=this.check(row,generation).finally(()=>{
      this.checks.delete(id);this.checkSequences.delete(id);
      if(this.options.eventDriven&&this.enabled(generation)&&(this.dirtySequence.get(id)??0)>sequence)
        queueMicrotask(()=>{void this.checkNow(id);});
      // Delivery is durable and retried from native_position_events. A slow
      // order/Telegram projection must never keep this position's protection
      // check in flight or delay a newer account-stream observation.
      void this.flush().catch(()=>{this.lastError='NATIVE_POSITION_CALLBACK_UNAVAILABLE';});
    });this.checks.set(id,work);return work;
  }
  private async runTick(generation:number){
    const now=this.clock();this.lastTickAt=iso(now);const due=this.takeDue(now);
    await Promise.allSettled(due.map(row=>this.runCheck(row,generation)));
    void this.flush().catch(()=>{this.lastError='NATIVE_POSITION_CALLBACK_UNAVAILABLE';});
    if(this.lastError==='NATIVE_POSITION_TICK_FAILED')this.lastError=undefined;
  }
  private async call<T>(fn:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    const controller=new AbortController();this.controllers.add(controller);let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([fn(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('NATIVE_POSITION_IO_TIMEOUT'));},this.timeoutMs);})]);}
    finally{clearTimeout(timer);this.controllers.delete(controller);}
  }
  private enabled(generation:number){return this.running&&!this.closed&&generation===this.generation;}
  private validBalance(row:NativePositionState,b:NativePositionBalance):boolean {
    const at=timestamp(b?.observedAt),now=this.clock(),floor=Math.max(row.buy.buySlot,row.lastExit?.slot??0,row.balance?.slot??0);
    return !!b&&b.wallet===row.buy.wallet&&b.mint===row.buy.mint&&atomic(b.amount)&&b.tokenDecimals===row.buy.tokenDecimals&&
      slot(b.slot)&&b.slot>=floor&&['confirmed','finalized'].includes(b.commitment)&&Number.isFinite(at)&&at<=now&&now-at<=10000&&at>=timestamp(row.buy.confirmedAt);
  }
  private validQuote(row:NativePositionState,q:NativePositionQuote,amount:string):boolean {
    const at=timestamp(q?.quotedAt),expires=timestamp(q?.expiresAt),now=this.clock();
    return !!q&&q.wallet===row.buy.wallet&&q.mint===row.buy.mint&&q.inputAmount===amount&&atomic(q.outputAmount)&&q.outputAmount!=='0'&&
      atomic(q.minimumOutputAmount)&&q.minimumOutputAmount!=='0'&&BigInt(q.minimumOutputAmount)<=BigInt(q.outputAmount)&&
      (q.subscriptionAccounts===undefined||Array.isArray(q.subscriptionAccounts)&&q.subscriptionAccounts.length>0&&q.subscriptionAccounts.length<=100&&q.subscriptionAccounts.every(a=>base58(a,32)))&&
      Number.isFinite(at)&&Number.isFinite(expires)&&at<=now&&now-at<=10000&&expires>now&&expires-at<=10000;
  }
  private balanceView(b:NativePositionBalance):NativePositionBalance {return {wallet:b.wallet,mint:b.mint,amount:b.amount,tokenDecimals:b.tokenDecimals,
    slot:b.slot,commitment:b.commitment,observedAt:b.observedAt,...(b.provisionalZero===true?{provisionalZero:true}:{})};}
  private quoteView(q:NativePositionQuote):NativePositionQuote {return {wallet:q.wallet,mint:q.mint,inputAmount:q.inputAmount,outputAmount:q.outputAmount,
    minimumOutputAmount:q.minimumOutputAmount,quotedAt:q.quotedAt,expiresAt:q.expiresAt,
    ...(q.source?{source:q.source,marketObservedAt:q.marketObservedAt,marketSlot:q.marketSlot}:{}),
    ...(q.subscriptionAccounts?{subscriptionAccounts:[...new Set(q.subscriptionAccounts)].sort()}:{})};}
  private adoptQuoteRoute(row:NativePositionState,q:NativePositionQuote):boolean {
    if(!q.subscriptionAccounts)return false;
    const next=[...new Set(q.subscriptionAccounts)].sort();
    if(next.length===row.buy.subscriptionAccounts.length&&next.every((value,index)=>value===row.buy.subscriptionAccounts[index]))return false;
    row.buy.subscriptionAccounts=next;return true;
  }
  private async check(row:NativePositionState,generation:number):Promise<void>{
    try{
      if(!this.enabled(generation))return;row.lastAttemptAt=iso(this.clock());row.dirty=false;if(!this.save(row))return;
      if(row.pendingExit?.state==='preparing'){await this.prepareManual(row,generation);return;}
      if(row.pendingExit){const result=await this.call(signal=>this.options.io.reconcile({orderId:row.buy.orderId,wallet:row.buy.wallet,mint:row.buy.mint,
        operationId:row.pendingExit!.operationId,signature:row.pendingExit!.signature,signal}));if(this.enabled(generation))this.applyExit(row,result);return;}
      const balance=await this.call(signal=>this.options.io.balance({orderId:row.buy.orderId,wallet:row.buy.wallet,mint:row.buy.mint,signal}));
      if(!this.enabled(generation))return;if(!this.validBalance(row,balance))throw Error('NATIVE_POSITION_BALANCE_INVALID');
      row.balance=this.balanceView(balance);delete row.lastError;
      if(balance.provisionalZero===true){delete row.quote;row.lastError='NATIVE_POSITION_ZERO_UNFINALIZED';this.save(row);return;}
      if(balance.amount==='0'){
        delete row.quote;
        if(balance.commitment!=='finalized'){row.lastError='NATIVE_POSITION_ZERO_UNFINALIZED';this.save(row);return;}
        this.observeExternalBalance(row,balance);row.state='closed';row.closedAt=iso(this.clock());
        row.closeReason=BigInt(row.externalReductionAmount)>0n?'external_zero':'sold';
        row.finalPnlKnown=row.closeReason==='sold'&&row.externalIncreaseAmount==='0'&&row.soldTokenAmount===row.buy.outputAmount;
        this.save(row,'closed');this.syncSubscriptions();return;
      }
      // Confirmed positive balances drive execution, so their external deltas must
      // also affect accounting. A later reversal makes cost uncertain, never profit.
      if(this.observeExternalBalance(row,balance)&&!this.save(row))return;
      const full=await this.call(signal=>this.options.io.quote({orderId:row.buy.orderId,wallet:row.buy.wallet,mint:row.buy.mint,amount:balance.amount,signal}));
      if(!this.enabled(generation))return;if(!this.validQuote(row,full,balance.amount))throw Error('NATIVE_POSITION_QUOTE_INVALID');
      row.quote=this.quoteView(full);row.lastCheckAt=iso(this.clock());let routeChanged=this.adoptQuoteRoute(row,full);
      const cost=BigInt(row.buy.inputAmount),bought=BigInt(row.buy.outputAmount),current=BigInt(balance.amount);
      let action:{percent:50|100;reason:NativeExitReason;amount:string;quote:NativePositionQuote}|undefined;
      if(nativeStopLossTriggered(BigInt(full.outputAmount),bought,cost,current,this.stopLossDropPct))
        action={percent:100,reason:'stop_loss',amount:balance.amount,quote:full};
      else if(!row.takeProfitDone&&current/2n>0n){
        const amount=(current/2n).toString();const half=await this.call(signal=>this.options.io.quote({orderId:row.buy.orderId,wallet:row.buy.wallet,mint:row.buy.mint,amount,signal}));
        if(!this.enabled(generation))return;if(!this.validQuote(row,half,amount))throw Error('NATIVE_POSITION_QUOTE_INVALID');
        routeChanged=this.adoptQuoteRoute(row,half)||routeChanged;
        if(BigInt(half.outputAmount)*bought>=cost*BigInt(amount)*2n)action={percent:50,reason:'take_profit',amount,quote:half};
      }
      if(!this.enabled(generation))return;if(!this.save(row))return;if(routeChanged)this.syncSubscriptions();
      try{this.options.onEvaluation?.(structuredClone(row));if(this.lastError==='NATIVE_POSITION_EVALUATION_CALLBACK_UNAVAILABLE')this.lastError=undefined;}
      catch{this.lastError='NATIVE_POSITION_EVALUATION_CALLBACK_UNAVAILABLE';}
      if(action&&this.validQuote(row,action.quote,action.amount))await this.submit(row,action);
    }catch(error){
      if(!this.enabled(generation))return;
      const current=this.get(row.buy.orderId);if(!current||current.state!=='active'||current.revision!==row.revision)return;
      current.lastError=safeCode(error instanceof Error?error.message:undefined,'NATIVE_POSITION_IO_UNAVAILABLE');delete current.quote;this.save(current);
    }
  }
  private observeExternalBalance(row:NativePositionState,balance:NativePositionBalance){
    const expected=BigInt(row.expectedBalanceAmount),amount=BigInt(balance.amount);
    if(amount<expected)row.externalReductionAmount=(BigInt(row.externalReductionAmount)+expected-amount).toString();
    if(amount>expected){row.externalIncreaseAmount=(BigInt(row.externalIncreaseAmount)+amount-expected).toString();delete row.realizedPnlLamports;}
    row.expectedBalanceAmount=balance.amount;
    return amount!==expected;
  }
  private async submit(row:NativePositionState,action:{percent:50|100;reason:NativeExitReason;amount:string;quote:NativePositionQuote}){
    const operationId=randomUUID(),now=iso(this.clock());
    row.pendingExit={operationId,percent:action.percent,reason:action.reason,expectedAmount:action.amount,state:'pending',createdAt:now,updatedAt:now};
    if(!this.tx(()=>{if(!this.saveInside(row,'exit_pending'))return false;this.db.prepare('INSERT INTO native_position_intents VALUES(?,?)').run(operationId,row.buy.orderId);return true;}))return;
    await this.execute(row,action.quote);
  }
  private async prepareManual(row:NativePositionState,generation:number){
    const pending=row.pendingExit!;
    const balance=await this.call(signal=>this.options.io.balance({orderId:row.buy.orderId,wallet:row.buy.wallet,mint:row.buy.mint,signal}));
    if(!this.enabled(generation))return;if(!this.validBalance(row,balance))throw Error('NATIVE_POSITION_BALANCE_INVALID');
    row.balance=this.balanceView(balance);if(balance.provisionalZero===true){delete row.quote;throw Error('NATIVE_POSITION_ZERO_UNFINALIZED');}
    const amount=BigInt(balance.amount)*BigInt(pending.percent)/100n;
    if(amount===0n){this.applyExit(row,{status:'failed',reason:'NATIVE_POSITION_SELL_AMOUNT_ZERO'});return;}
    if(this.observeExternalBalance(row,balance)&&!this.save(row))return;
    const quote=await this.call(signal=>this.options.io.quote({orderId:row.buy.orderId,wallet:row.buy.wallet,mint:row.buy.mint,amount:amount.toString(),signal}));
    if(!this.enabled(generation))return;if(!this.validQuote(row,quote,amount.toString()))throw Error('NATIVE_POSITION_QUOTE_INVALID');
    pending.expectedAmount=amount.toString();pending.state='pending';pending.updatedAt=iso(this.clock());
    const routeChanged=this.adoptQuoteRoute(row,quote);delete row.lastError;if(!this.save(row))return;if(routeChanged)this.syncSubscriptions();await this.execute(row,quote);
  }
  private async execute(row:NativePositionState,quote:NativePositionQuote){
    const generation=this.generation;
    const pending=row.pendingExit!;
    let result:NativePositionExitResult;
    try{result=await this.call(()=>this.options.io.sell({orderId:row.buy.orderId,wallet:row.buy.wallet,mint:row.buy.mint,operationId:pending.operationId,
      percent:pending.percent,reason:pending.reason,expectedAmount:pending.expectedAmount,quote}));}
    catch{result={status:'pending',reason:'NATIVE_POSITION_SUBMISSION_UNKNOWN'};}
    if(this.enabled(generation))this.applyExit(row,result);
  }
  private applyExit(row:NativePositionState,result:NativePositionExitResult){
    const pending=row.pendingExit;if(!pending)return;
    pending.updatedAt=iso(this.clock());
    if(!result||!['pending','confirmed','failed'].includes(result.status))result={status:'pending',reason:'NATIVE_POSITION_EXIT_UNVERIFIED'};
    if(result.status==='confirmed'&&(!base58(result.signature,64)||result.inputAmount!==pending.expectedAmount||!atomic(result.outputAmount)||result.outputAmount==='0'||
      !slot(result.slot)||result.slot<row.buy.buySlot||!Number.isFinite(timestamp(result.confirmedAt))||timestamp(result.confirmedAt)>this.clock()||timestamp(result.confirmedAt)<timestamp(pending.createdAt)))
      result={status:'pending',reason:'NATIVE_POSITION_EXIT_UNVERIFIED'};
    if(result.status==='confirmed'&&this.db.prepare('SELECT 1 FROM native_position_fills WHERE signature=?').get(result.signature))
      result={status:'pending',reason:'NATIVE_POSITION_FILL_ALREADY_RECORDED'};
    if(result.status==='pending'){
      if(base58(result.signature,64))pending.signature=result.signature;
      pending.failureReason=safeCode(result.reason,'NATIVE_POSITION_EXIT_PENDING');row.lastError=pending.failureReason;this.save(row);return;
    }
    if(result.status==='failed'){
      pending.state='failed';pending.failureReason=safeCode(result.reason,'NATIVE_POSITION_EXIT_FAILED');row.lastError=pending.failureReason;
      row.lastExit=pending;delete row.pendingExit;this.save(row,'exit_failed');return;
    }
    pending.state='confirmed';pending.signature=result.signature;pending.inputAmount=result.inputAmount;pending.outputAmount=result.outputAmount;
    pending.confirmedAt=result.confirmedAt;pending.slot=result.slot;delete pending.failureReason;
    row.soldTokenAmount=(BigInt(row.soldTokenAmount)+BigInt(result.inputAmount)).toString();row.saleProceedsLamports=(BigInt(row.saleProceedsLamports)+BigInt(result.outputAmount)).toString();
    const sold=BigInt(row.soldTokenAmount),bought=BigInt(row.buy.outputAmount),basis=BigInt(row.buy.inputAmount)*(sold>bought?bought:sold)/bought;
    row.realizedCostLamports=basis.toString();
    if(row.externalIncreaseAmount==='0'&&sold<=bought)row.realizedPnlLamports=(BigInt(row.saleProceedsLamports)-basis).toString();else delete row.realizedPnlLamports;
    const remaining=BigInt(row.expectedBalanceAmount)-BigInt(result.inputAmount);row.expectedBalanceAmount=(remaining>0n?remaining:0n).toString();
    if(pending.reason==='take_profit')row.takeProfitDone=true;
    row.lastExit=pending;delete row.pendingExit;delete row.lastError;delete row.quote;row.dirty=true;
    this.tx(()=>{if(!this.saveInside(row,'exit_confirmed'))return;this.db.prepare('INSERT INTO native_position_fills VALUES(?,?,?)').run(pending.signature!,pending.operationId,row.buy.orderId);});
  }
  private flush():Promise<void>{
    if(this.flushFlight)return this.flushFlight;if(!this.pendingDelivery||!this.options.onUpdate||this.closed)return Promise.resolve();
    this.flushFlight=(async()=>{for(const raw of this.db.prepare('SELECT key,payload FROM native_position_events WHERE delivered=0 ORDER BY rowid LIMIT 100').all()){
      try{const event=JSON.parse(String(raw.payload)) as NativePositionUpdate;
        const current=event.type==='snapshot'?this.get(event.position.buy.orderId):undefined;
        // A queued observation cannot resurrect a closed position or old restored quotes.
        if(event.type!=='snapshot'||current?.state==='active'){
          if(current)event.position=current;
          await this.call(()=>Promise.resolve(this.options.onUpdate!(event)));
        }
        this.db.prepare('UPDATE native_position_events SET delivered=1 WHERE key=? AND payload=?').run(raw.key,raw.payload);
      }catch{this.lastError='NATIVE_POSITION_CALLBACK_UNAVAILABLE';return;}
    }this.pendingDelivery=!!this.db.prepare('SELECT 1 FROM native_position_events WHERE delivered=0 LIMIT 1').get();
    if(this.lastError==='NATIVE_POSITION_CALLBACK_UNAVAILABLE')this.lastError=undefined;})().finally(()=>{this.flushFlight=undefined;});return this.flushFlight;
  }
}
