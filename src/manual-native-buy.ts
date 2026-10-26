import {createHash,randomBytes} from 'node:crypto';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import type {Config} from './config.js';
import {assessEntryHolderRiskValues,normalizeStoredEntryHolderRisk,unavailableEntryHolderRisk,
  ENTRY_HOLDER_RISK_MAX_AGE_MS,type EntryHolderRiskAssessment,type EntryHolderRiskValues} from './entry-holder-risk.js';
import {parseExitPolicy} from './exit-policy.js';
import {NATIVE_INPUT_TOKENS,nativeBalanceCoversOrder,readNativeBalance} from './native-balance.js';
import {OrderStore,type ExitTracking,type FundingSnapshot,type OpeningOrder} from './orders.js';

const SOL=NATIVE_INPUT_TOKENS.solana;
const SYSTEM_PROGRAM='11111111111111111111111111111111';
export const MANUAL_NATIVE_BUY_LAMPORTS='10000000';
export const MANUAL_NATIVE_BUY_TTL_MS=5*60*1000;
const MAX_U64=(1n<<64n)-1n;

type ActionState='awaiting_address'|'awaiting_amount'|'ready'|'executing'|'completed'|'failed'|'canceled'|'expired';
export type ManualNativeBuyMode='risk_checked'|'card_direct';
export interface ManualNativeBuyAction {
  ref:string;scope:string;owner:string;mint?:string;state:ActionState;
  mode:ManualNativeBuyMode;amountLamports?:string;
  createdAt:string;updatedAt:string;expiresAt:string;orderId?:string;failureReason?:string;
}
export type ManualNativeBuyResult=
  |{status:'created'|'ready'|'accepted'|'existing'|'canceled';action:ManualNativeBuyAction;order?:OpeningOrder}
  |{status:'blocked';reason:string;action?:ManualNativeBuyAction;order?:OpeningOrder};

export interface ManualNativeBuyOptions {
  database:string;
  native:{readiness:()=>{ready:boolean;reason?:string};
    execute:(order:OpeningOrder,beforeBroadcast:()=>Promise<void>)=>Promise<OpeningOrder>};
  fetcher?:typeof fetch;
  /** GMGN holding-risk reader used by the prompted/default routes. Card-direct clicks deliberately do not read it. */
  readHolderRisk?:(address:string)=>Promise<EntryHolderRiskValues>;
  enqueue?:(event:{key:string;text:string})=>boolean;
  now?:()=>Date;
}

interface ActionRow {
  ref:string;scope:string;owner:string;mint:string|null;state:ActionState;
  entry_mode:string;input_amount:string|null;
  created_at:string;updated_at:string;expires_at:string;order_id:string|null;failure_reason:string|null;
}

class ManualBuyFailure extends Error {constructor(readonly reason:string){super(reason);}}
const fail=(reason:string):never=>{throw new ManualBuyFailure(reason);};
const reason=(error:unknown)=>error instanceof ManualBuyFailure?error.reason:
  error instanceof Error&&/^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)?error.message:'MANUAL_NATIVE_BUY_FAILED';
const cleanIdentity=(value:unknown):value is string=>typeof value==='string'&&value.length>=1&&value.length<=200&&
  !/[\x00-\x1f\x7f]/.test(value);
function canonicalAddress(value:unknown):value is string {
  try {
    if(typeof value!=='string'||value.length<32||value.length>44)return false;
    const decoded=bs58.decode(value);
    return decoded.length===32&&decoded.some(byte=>byte!==0)&&bs58.encode(decoded)===value;
  }catch{return false;}
}
const canonicalLamports=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)&&BigInt(value)<=MAX_U64;
function solAmount(lamports:string):string {
  const value=BigInt(lamports),whole=value/1_000_000_000n,fraction=(value%1_000_000_000n).toString().padStart(9,'0').replace(/0+$/,'');
  return `${whole}${fraction?`.${fraction}`:''} SOL`;
}
const eventKey=(ref:string)=>createHash('sha256').update(JSON.stringify(['manual_native_test_v1',ref])).digest('hex');

/** Durable manual routes: /native_buy stays fixed at 0.01 SOL; card actions persist their exact requested amount. */
export class ManualNativeTestController {
  private readonly db:DatabaseSync;
  private readonly now:()=>Date;
  private readonly fetcher:typeof fetch;
  private readonly jobs=new Set<Promise<void>>();
  private closed=false;
  constructor(private readonly config:Config,private readonly orders:OrderStore,private readonly options:ManualNativeBuyOptions){
    if(!options.database||options.database===':memory:'||/^file:/i.test(options.database)||options.database.includes('\0')||
      typeof options.native?.readiness!=='function'||typeof options.native?.execute!=='function')
      throw Error('MANUAL_NATIVE_BUY_CONFIG_INVALID');
    this.now=options.now??(()=>new Date());this.fetcher=options.fetcher??fetch;
    mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.database);chmodSync(options.database,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS manual_native_buy_actions(
        ref TEXT PRIMARY KEY,scope TEXT NOT NULL,owner TEXT NOT NULL,mint TEXT,state TEXT NOT NULL,
        entry_mode TEXT NOT NULL DEFAULT 'risk_checked' CHECK(entry_mode IN ('risk_checked','card_direct')),
        input_amount TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,order_id TEXT,failure_reason TEXT
      );`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns=this.db.prepare('PRAGMA table_info(manual_native_buy_actions)').all() as unknown as {name:string}[];
      if(!columns.some(column=>column.name==='entry_mode'))this.db.exec(
        "ALTER TABLE manual_native_buy_actions ADD COLUMN entry_mode TEXT NOT NULL DEFAULT 'risk_checked' CHECK(entry_mode IN ('risk_checked','card_direct'))");
      if(!columns.some(column=>column.name==='input_amount'))this.db.exec(
        'ALTER TABLE manual_native_buy_actions ADD COLUMN input_amount TEXT');
      // Every pre-variable action was an exact 0.01 SOL action. Only the new
      // awaiting_amount state is intentionally allowed to have no amount yet.
      this.db.prepare("UPDATE manual_native_buy_actions SET input_amount=? WHERE input_amount IS NULL AND state!='awaiting_amount'")
        .run(MANUAL_NATIVE_BUY_LAMPORTS);
      // Recreate the partial index so an awaiting custom amount participates in
      // the same owner-scoped single-pending invariant as every other flow.
      this.db.exec(`DROP INDEX IF EXISTS manual_native_buy_one_pending;
        CREATE UNIQUE INDEX manual_native_buy_one_pending ON manual_native_buy_actions(scope,owner)
        WHERE state IN ('awaiting_address','awaiting_amount','ready','executing');`);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.recoverInterrupted();
  }

  readiness():{ready:boolean;reason?:string}{
    try{if(!this.options.readHolderRisk)fail('ENTRY_HOLDER_RISK_PROVIDER_MISSING');return this.executionReadiness();}
    catch(error){return {ready:false,reason:reason(error)};}
  }

  /** Opens a five-minute address prompt, replacing only an older unconfirmed prompt. */
  begin(input:{scope:string;owner:string}):ManualNativeBuyResult {
    if(this.closed)return {status:'blocked',reason:'MANUAL_NATIVE_BUY_STOPPED'};
    if(!cleanIdentity(input.scope)||!cleanIdentity(input.owner))return {status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTOR_INVALID'};
    const now=this.now(),expires=new Date(now.getTime()+MANUAL_NATIVE_BUY_TTL_MS);
    if(!Number.isFinite(now.getTime()))return {status:'blocked',reason:'MANUAL_NATIVE_BUY_CLOCK_INVALID'};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expire(now);
      const active=this.pendingRow(input.scope,input.owner);
      if(active?.state==='executing') {this.db.exec('COMMIT');return {status:'existing',action:this.action(active),order:this.order(active)};}
      if(active)this.db.prepare("UPDATE manual_native_buy_actions SET state='canceled',updated_at=?,failure_reason='MANUAL_NATIVE_BUY_REPLACED' WHERE ref=?")
        .run(now.toISOString(),active.ref);
      let ref='';do{ref=randomBytes(16).toString('hex');}while(this.row(ref));
      this.db.prepare(`INSERT INTO manual_native_buy_actions
        (ref,scope,owner,mint,state,entry_mode,input_amount,created_at,updated_at,expires_at,order_id,failure_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(ref,input.scope,input.owner,null,'awaiting_address','risk_checked',MANUAL_NATIVE_BUY_LAMPORTS,
        now.toISOString(),now.toISOString(),expires.toISOString(),null,null);
      const action=this.action(this.row(ref)!);this.db.exec('COMMIT');return {status:'created',action};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  /** Validates and binds the one pending prompt to an exact canonical mint. */
  prepare(input:{scope:string;owner:string;mint:string}):ManualNativeBuyResult {
    if(this.closed)return {status:'blocked',reason:'MANUAL_NATIVE_BUY_STOPPED'};
    if(!cleanIdentity(input.scope)||!cleanIdentity(input.owner))return {status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTOR_INVALID'};
    if(!canonicalAddress(input.mint)||input.mint===SOL||input.mint===SYSTEM_PROGRAM)
      return {status:'blocked',reason:'MANUAL_NATIVE_MINT_INVALID'};
    const ready=this.readiness();if(!ready.ready)return {status:'blocked',reason:ready.reason??'NATIVE_EXECUTOR_UNAVAILABLE'};
    const now=this.now(),expires=new Date(now.getTime()+MANUAL_NATIVE_BUY_TTL_MS);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expire(now);const row=this.pendingRow(input.scope,input.owner);
      if(!row||row.state!=='awaiting_address'){this.db.exec('COMMIT');return {status:'blocked',reason:'MANUAL_NATIVE_PROMPT_MISSING'};}
      const changed=this.db.prepare(`UPDATE manual_native_buy_actions SET mint=?,state='ready',updated_at=?,expires_at=?,failure_reason=NULL
        WHERE ref=? AND state='awaiting_address'`).run(input.mint,now.toISOString(),expires.toISOString(),row.ref);
      const next=this.row(row.ref);this.db.exec('COMMIT');
      return changed.changes===1&&next?{status:'ready',action:this.action(next)}:{status:'blocked',reason:'MANUAL_NATIVE_PROMPT_CHANGED'};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  /** A successful compare-and-set is the only path that starts a background buy job. */
  confirm(input:{scope:string;owner:string;ref:string}):ManualNativeBuyResult {
    if(this.closed)return {status:'blocked',reason:'MANUAL_NATIVE_BUY_STOPPED'};
    if(!cleanIdentity(input.scope)||!cleanIdentity(input.owner)||!/^[0-9a-f]{32}$/.test(input.ref))
      return {status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTION_INVALID'};
    const now=this.now();let action:ManualNativeBuyAction;let shouldRun=false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expire(now);const row=this.row(input.ref);
      if(!row||row.scope!==input.scope||row.owner!==input.owner){this.db.exec('COMMIT');return {status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTION_INVALID'};}
      if(row.state==='executing'||row.state==='completed'){
        action=this.action(row);const order=this.order(row);this.db.exec('COMMIT');return {status:'existing',action,order};
      }
      if(row.state!=='ready'||!row.mint){this.db.exec('COMMIT');return {status:'blocked',reason:row.failure_reason??`MANUAL_NATIVE_BUY_${row.state.toUpperCase()}`,
        action:this.action(row),order:this.order(row)};}
      const changed=this.db.prepare("UPDATE manual_native_buy_actions SET state='executing',updated_at=? WHERE ref=? AND state='ready' AND expires_at>?")
        .run(now.toISOString(),row.ref,now.toISOString());
      const next=this.row(row.ref);if(changed.changes!==1||!next){this.db.exec('COMMIT');return {status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTION_EXPIRED'};}
      action=this.action(next);shouldRun=true;this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    if(shouldRun){const job=Promise.resolve().then(()=>this.execute(action.ref));this.jobs.add(job);void job.finally(()=>this.jobs.delete(job)).catch(()=>{});}
    return {status:'accepted',action};
  }

  /** One explicit owner click creates and consumes a short-lived action in one transaction. */
  trigger(input:{scope:string;owner:string;mint:string}):ManualNativeBuyResult {
    return this.triggerWithMode({...input,amountLamports:MANUAL_NATIVE_BUY_LAMPORTS},'risk_checked');
  }

  /** A card preset is an exact requested order and intentionally bypasses token/holder risk assessment. */
  triggerCard(input:{scope:string;owner:string;mint:string;amountLamports:string}):ManualNativeBuyResult {
    return this.triggerWithMode(input,'card_direct');
  }

  /** Opens a durable five-minute card amount prompt without reserving or submitting a trade. */
  beginCardCustom(input:{scope:string;owner:string;mint:string}):ManualNativeBuyResult {
    if(this.closed)return {status:'blocked',reason:'MANUAL_NATIVE_BUY_STOPPED'};
    if(!cleanIdentity(input.scope)||!cleanIdentity(input.owner))return {status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTOR_INVALID'};
    if(!canonicalAddress(input.mint)||input.mint===SOL||input.mint===SYSTEM_PROGRAM)
      return {status:'blocked',reason:'MANUAL_NATIVE_MINT_INVALID'};
    const now=this.now(),expires=new Date(now.getTime()+MANUAL_NATIVE_BUY_TTL_MS);
    if(!Number.isFinite(now.getTime()))return {status:'blocked',reason:'MANUAL_NATIVE_BUY_CLOCK_INVALID'};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expire(now);const active=this.pendingRow(input.scope,input.owner);
      if(active?.state==='awaiting_amount'&&active.mint===input.mint&&this.mode(active)==='card_direct'){
        const action=this.action(active),order=this.order(active);this.db.exec('COMMIT');return {status:'existing',action,order};
      }
      if(active?.state==='executing'){
        this.db.exec('COMMIT');return {status:'blocked',reason:'MANUAL_NATIVE_BUY_IN_PROGRESS',action:this.action(active),order:this.order(active)};
      }
      const ready=this.executionReadiness();
      if(!ready.ready){this.db.exec('COMMIT');return {status:'blocked',reason:ready.reason??'NATIVE_EXECUTOR_UNAVAILABLE'};}
      if(this.orders.hasAttemptedOpening('solana',input.mint)){
        this.db.exec('COMMIT');return {status:'blocked',reason:'ASSET_REENTRY_BLOCKED'};
      }
      if(active)this.db.prepare("UPDATE manual_native_buy_actions SET state='canceled',updated_at=?,failure_reason='MANUAL_NATIVE_BUY_REPLACED' WHERE ref=?")
        .run(now.toISOString(),active.ref);
      let ref='';do{ref=randomBytes(16).toString('hex');}while(this.row(ref));
      this.db.prepare(`INSERT INTO manual_native_buy_actions
        (ref,scope,owner,mint,state,entry_mode,input_amount,created_at,updated_at,expires_at,order_id,failure_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(ref,input.scope,input.owner,input.mint,'awaiting_amount','card_direct',null,
        now.toISOString(),now.toISOString(),expires.toISOString(),null,null);
      const action=this.action(this.row(ref)!);this.db.exec('COMMIT');return {status:'created',action};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  /** Atomically binds the custom amount and starts the exact same card-direct execution path. */
  submitCardCustom(input:{scope:string;owner:string;amountLamports:string}):ManualNativeBuyResult {
    if(this.closed)return {status:'blocked',reason:'MANUAL_NATIVE_BUY_STOPPED'};
    if(!cleanIdentity(input.scope)||!cleanIdentity(input.owner))return {status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTOR_INVALID'};
    if(!canonicalLamports(input.amountLamports))return {status:'blocked',reason:'MANUAL_NATIVE_AMOUNT_INVALID'};
    const now=this.now();let action:ManualNativeBuyAction;let shouldRun=false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expire(now);const row=this.pendingRow(input.scope,input.owner);
      if(row?.state==='executing'){
        const existing=this.action(row),order=this.order(row);this.db.exec('COMMIT');
        return this.mode(row)==='card_direct'&&row.input_amount===input.amountLamports?
          {status:'existing',action:existing,order}:{status:'blocked',reason:'MANUAL_NATIVE_BUY_IN_PROGRESS',action:existing,order};
      }
      if(!row||row.state!=='awaiting_amount'||this.mode(row)!=='card_direct'||!row.mint){
        this.db.exec('COMMIT');return {status:'blocked',reason:row?.failure_reason??'MANUAL_NATIVE_AMOUNT_PROMPT_MISSING',
          ...(row?{action:this.action(row),order:this.order(row)}:{})};
      }
      const ready=this.executionReadiness();
      if(!ready.ready){this.db.exec('COMMIT');return {status:'blocked',reason:ready.reason??'NATIVE_EXECUTOR_UNAVAILABLE',action:this.action(row)};}
      if(this.orders.hasAttemptedOpening('solana',row.mint)){
        this.db.exec('COMMIT');return {status:'blocked',reason:'ASSET_REENTRY_BLOCKED',action:this.action(row)};
      }
      const changed=this.db.prepare(`UPDATE manual_native_buy_actions SET input_amount=?,state='executing',updated_at=?,failure_reason=NULL
        WHERE ref=? AND state='awaiting_amount' AND expires_at>?`).run(input.amountLamports,now.toISOString(),row.ref,now.toISOString());
      const next=this.row(row.ref);
      if(changed.changes!==1||!next){this.db.exec('COMMIT');return {status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTION_EXPIRED'};}
      action=this.action(next);shouldRun=true;this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    if(shouldRun){const job=Promise.resolve().then(()=>this.execute(action.ref));this.jobs.add(job);void job.finally(()=>this.jobs.delete(job)).catch(()=>{});}
    return {status:'accepted',action};
  }

  private triggerWithMode(input:{scope:string;owner:string;mint:string;amountLamports:string},mode:ManualNativeBuyMode):ManualNativeBuyResult {
    if(this.closed)return {status:'blocked',reason:'MANUAL_NATIVE_BUY_STOPPED'};
    if(!cleanIdentity(input.scope)||!cleanIdentity(input.owner))return {status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTOR_INVALID'};
    if(!canonicalAddress(input.mint)||input.mint===SOL||input.mint===SYSTEM_PROGRAM)
      return {status:'blocked',reason:'MANUAL_NATIVE_MINT_INVALID'};
    if(!canonicalLamports(input.amountLamports))return {status:'blocked',reason:'MANUAL_NATIVE_AMOUNT_INVALID'};
    const now=this.now(),expires=new Date(now.getTime()+MANUAL_NATIVE_BUY_TTL_MS);
    if(!Number.isFinite(now.getTime()))return {status:'blocked',reason:'MANUAL_NATIVE_BUY_CLOCK_INVALID'};
    let action:ManualNativeBuyAction;this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expire(now);const active=this.pendingRow(input.scope,input.owner);
      if(active?.state==='executing'){
        action=this.action(active);const order=this.order(active);this.db.exec('COMMIT');
        return active.mint===input.mint&&active.input_amount===input.amountLamports&&this.mode(active)===mode?
          {status:'existing',action,order}:{status:'blocked',reason:'MANUAL_NATIVE_BUY_IN_PROGRESS',action,order};
      }
      const ready=mode==='card_direct'?this.executionReadiness():this.readiness();
      if(!ready.ready){this.db.exec('COMMIT');return {status:'blocked',reason:ready.reason??'NATIVE_EXECUTOR_UNAVAILABLE'};}
      if(this.orders.hasAttemptedOpening('solana',input.mint)){
        this.db.exec('COMMIT');return {status:'blocked',reason:'ASSET_REENTRY_BLOCKED'};
      }
      if(active)this.db.prepare("UPDATE manual_native_buy_actions SET state='canceled',updated_at=?,failure_reason='MANUAL_NATIVE_BUY_REPLACED' WHERE ref=?")
        .run(now.toISOString(),active.ref);
      let ref='';do{ref=randomBytes(16).toString('hex');}while(this.row(ref));
      this.db.prepare(`INSERT INTO manual_native_buy_actions
        (ref,scope,owner,mint,state,entry_mode,input_amount,created_at,updated_at,expires_at,order_id,failure_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(ref,input.scope,input.owner,input.mint,'executing',mode,input.amountLamports,
        now.toISOString(),now.toISOString(),expires.toISOString(),null,null);
      action=this.action(this.row(ref)!);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    const job=Promise.resolve().then(()=>this.execute(action.ref));this.jobs.add(job);void job.finally(()=>this.jobs.delete(job)).catch(()=>{});
    return {status:'accepted',action};
  }

  cancel(input:{scope:string;owner:string;ref?:string}):ManualNativeBuyResult {
    if(!cleanIdentity(input.scope)||!cleanIdentity(input.owner)||input.ref!==undefined&&!/^[0-9a-f]{32}$/.test(input.ref))
      return {status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTION_INVALID'};
    const now=this.now();this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expire(now);const row=input.ref?this.row(input.ref):this.pendingRow(input.scope,input.owner);
      if(!row||row.scope!==input.scope||row.owner!==input.owner){this.db.exec('COMMIT');return {status:'blocked',reason:'MANUAL_NATIVE_PROMPT_MISSING'};}
      if(row.state==='executing'||row.state==='completed'){this.db.exec('COMMIT');return {status:'existing',action:this.action(row),order:this.order(row)};}
      if(!['awaiting_address','awaiting_amount','ready'].includes(row.state)){this.db.exec('COMMIT');return {status:'blocked',reason:row.failure_reason??'MANUAL_NATIVE_BUY_NOT_PENDING',action:this.action(row)};}
      this.db.prepare("UPDATE manual_native_buy_actions SET state='canceled',updated_at=?,failure_reason='MANUAL_NATIVE_BUY_CANCELED' WHERE ref=?")
        .run(now.toISOString(),row.ref);const next=this.row(row.ref)!;this.db.exec('COMMIT');return {status:'canceled',action:this.action(next)};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  pending(scope:string,owner:string):ManualNativeBuyAction|undefined {
    if(!cleanIdentity(scope)||!cleanIdentity(owner))return;
    this.expire(this.now());const row=this.pendingRow(scope,owner);return row?this.action(row):undefined;
  }
  get(ref:string):ManualNativeBuyAction|undefined {const row=/^[0-9a-f]{32}$/.test(ref)?this.row(ref):undefined;return row?this.action(row):undefined;}
  async settle():Promise<void>{await Promise.allSettled([...this.jobs]);}
  async close():Promise<void>{this.closed=true;await this.settle();this.db.close();}

  /** Prepared means no permanent identity was claimed and no broadcast was authorized. */
  recoverInterrupted():number {
    const now=this.now();let changed=0;this.expire(now);
    for(const row of this.db.prepare("SELECT * FROM manual_native_buy_actions WHERE state='executing'").all() as unknown as ActionRow[]){
      const order=this.order(row);
      if(!order){this.setState(row.ref,'failed','MANUAL_NATIVE_INTERRUPTED_BEFORE_RESERVE',undefined,now);changed++;continue;}
      if(order.status==='prepared'){
        this.orders.update(order.id,['prepared'],{status:'failed',failureReason:'MANUAL_NATIVE_INTERRUPTED_BEFORE_BROADCAST'},now);
        this.setState(row.ref,'failed','MANUAL_NATIVE_INTERRUPTED_BEFORE_BROADCAST',order.id,now);changed++;continue;
      }
      if(order.status==='failed')this.setState(row.ref,'failed',order.failureReason??'MANUAL_NATIVE_BUY_FAILED',order.id,now);
      else this.setState(row.ref,'completed',undefined,order.id,now);
      changed++;
    }
    return changed;
  }

  private configuration():{wallet:string;exit:ExitTracking}{
    if(this.config.solanaExecutionProvider!=='pump_native')fail('NATIVE_EXECUTOR_UNAVAILABLE');
    const wallet=this.config.entryWallets.solana;
    if(!canonicalAddress(wallet)||wallet===SYSTEM_PROGRAM||!this.config.rpc.solana||this.config.entryInputTokens.solana!==SOL||
      !Number.isInteger(this.config.entrySlippagePct)||this.config.entrySlippagePct<0||this.config.entrySlippagePct>50||
      !Number.isInteger(this.config.entryMaxOpen)||this.config.entryMaxOpen<1)throw new ManualBuyFailure('MANUAL_NATIVE_BUY_CONFIG_INVALID');
    let policy;try{policy=parseExitPolicy(this.config.exitPolicy);}catch{fail('EXIT_POLICY_INVALID');}
    if(!policy)throw new ManualBuyFailure('EXIT_POLICY_REQUIRED');
    return {wallet,exit:{policy,state:'awaiting_swap',reasons:[],checkedAt:this.now().toISOString(),positionClosed:false}};
  }

  private executionReadiness():{ready:boolean;reason?:string}{
    try{this.configuration();const ready=this.options.native.readiness();
      return ready.ready?{ready:true}:{ready:false,reason:ready.reason??'NATIVE_EXECUTOR_UNAVAILABLE'};}
    catch(error){return {ready:false,reason:reason(error)};}
  }

  private async fundingSnapshot(wallet:string):Promise<FundingSnapshot>{
    const balance=await readNativeBalance('solana',wallet,this.config,this.fetcher);
    if(balance.status!=='verified'||balance.amount===undefined)throw new ManualBuyFailure('ENTRY_BALANCE_UNAVAILABLE');
    const balanceAmount=balance.amount;
    const coveredOrderIds:string[]=[];
    for(const previous of this.orders.fundingOrders({chain:'solana',mode:'live',wallet,inputToken:SOL})){
      if(!previous.transactionHash)continue;
      const cache=previous.details.nativeDebitCoverage;
      const cached=cache!==null&&typeof cache==='object'&&!Array.isArray(cache)&&
        (cache as Record<string,unknown>).transactionHash===previous.transactionHash&&
        Number.isSafeInteger((cache as Record<string,unknown>).slot)&&Number((cache as Record<string,unknown>).slot)>=0&&
        typeof balance.slot==='number'&&balance.slot>=Number((cache as Record<string,unknown>).slot);
      if(cached){coveredOrderIds.push(previous.id);continue;}
      if(await nativeBalanceCoversOrder(previous,balance,this.config,this.fetcher)){
        coveredOrderIds.push(previous.id);const current=this.orders.get(previous.id);
        if(current?.status==='confirmed')this.orders.update(previous.id,['confirmed'],{details:{...current.details,
          nativeDebitCoverage:{transactionHash:current.transactionHash,slot:balance.slot,checkedAt:balance.checkedAt}}},this.now());
      }
      if(this.now().getTime()-Date.parse(balance.readStartedAt)>25_000)break;
    }
    return {...balance,balance:balanceAmount,feeReserve:this.config.entryFeeReserves.solana,coveredOrderIds};
  }

  private async holderRisk(address:string):Promise<EntryHolderRiskAssessment>{
    const unavailable=(why:string)=>unavailableEntryHolderRisk(address,this.now().toISOString(),why);
    if(!this.options.readHolderRisk)return unavailable('ENTRY_HOLDER_RISK_PROVIDER_MISSING');
    try{
      const raw=await this.options.readHolderRisk(address);
      if(!raw||typeof raw!=='object'||raw.provider!=='gmgn'||raw.chain!=='solana'||raw.address!==address)
        return unavailable('ENTRY_HOLDER_RISK_TOKEN_MISMATCH');
      const assessed=assessEntryHolderRiskValues(structuredClone(raw),this.now());
      return normalizeStoredEntryHolderRisk(assessed,{chain:'solana',address})??unavailable('ENTRY_HOLDER_RISK_RESPONSE_INVALID');
    }catch{return unavailable('ENTRY_HOLDER_RISK_READ_FAILED');}
  }

  private requireHolderRisk(order:OpeningOrder,expected:EntryHolderRiskAssessment):void{
    const saved=normalizeStoredEntryHolderRisk(order.details.entryHolderRisk,{chain:order.chain,address:order.tokenAddress});
    if(!saved)throw new ManualBuyFailure('ENTRY_HOLDER_RISK_EVIDENCE_INVALID');
    if(saved.status!=='pass'||JSON.stringify(saved)!==JSON.stringify(expected))fail('ENTRY_HOLDER_RISK_EVIDENCE_INVALID');
    const age=this.now().getTime()-Date.parse(saved.checkedAt);
    if(age<0||age>ENTRY_HOLDER_RISK_MAX_AGE_MS)fail('ENTRY_HOLDER_RISK_STALE');
  }

  private async execute(ref:string):Promise<void>{
    let order:OpeningOrder|undefined,attempted=false,executionMode:ManualNativeBuyMode='risk_checked',requestedAmount=MANUAL_NATIVE_BUY_LAMPORTS;
    try{
      const row=this.row(ref);if(!row||row.state!=='executing'||!row.mint)throw new ManualBuyFailure('MANUAL_NATIVE_BUY_ACTION_CHANGED');
      const mint=row.mint,mode=this.mode(row);
      if(!canonicalLamports(row.input_amount))throw new ManualBuyFailure('MANUAL_NATIVE_AMOUNT_INVALID');
      requestedAmount=row.input_amount;
      executionMode=mode;
      const {wallet,exit}=this.configuration();const readiness=this.options.native.readiness();
      if(!readiness.ready)fail(readiness.reason??'NATIVE_EXECUTOR_UNAVAILABLE');
      const funding=await this.fundingSnapshot(wallet);
      const current=this.row(ref);if(!current||current.state!=='executing'||current.mint!==mint)throw new ManualBuyFailure('MANUAL_NATIVE_BUY_ACTION_CHANGED');
      const reserved=this.orders.reserve({eventKey:eventKey(ref),chain:'solana',tokenAddress:mint,mode:'live',wallet,inputToken:SOL,
        inputAmount:requestedAmount,slippagePct:this.config.entrySlippagePct,exit,
        details:{executionStrategy:'manual_native_test_v1',policyVersion:'manual_native_test_v1',executionProvider:'pump_native',
          manualTest:{actionRef:ref,scope:row.scope,requestedAt:row.created_at,acceptedAt:row.updated_at,
            // Retain the historical field for old readers; both values are the
            // instant the final owner instruction was durably accepted.
            confirmedAt:row.updated_at,entryMode:mode,
            requestedAmountLamports:requestedAmount},
          token:{chain:'solana',address:mint}}},this.config.entryMaxOpen,this.now(),funding,{preventReentry:true});
      if(!reserved.created){
        if(reserved.order){this.setState(ref,'completed',undefined,reserved.order.id,this.now());return;}
        fail(reserved.reason??'MANUAL_NATIVE_RESERVATION_FAILED');
      }
      order=reserved.order!;this.setOrder(ref,order.id,this.now());
      if(order.inputAmount!==requestedAmount){
        this.orders.update(order.id,['prepared'],{status:'failed',failureReason:'MANUAL_NATIVE_FIXED_AMOUNT_UNAVAILABLE'},this.now());
        fail('MANUAL_NATIVE_FIXED_AMOUNT_UNAVAILABLE');
      }
      let holderRisk:EntryHolderRiskAssessment|undefined;
      let guardedOrder:OpeningOrder=order;
      if(mode==='risk_checked'){
        // Read immediately before building the executable swap. The final guard below
        // checks that this exact evidence is still complete, unchanged and <=30s old.
        holderRisk=await this.holderRisk(mint);
        const riskOrder=this.orders.update(order.id,['prepared'],{details:{...order.details,entryHolderRisk:holderRisk}},this.now());
        if(!riskOrder)throw new ManualBuyFailure('ENTRY_HOLDER_RISK_EVIDENCE_INVALID');
        order=riskOrder;guardedOrder=riskOrder;
        if(holderRisk.status!=='pass')fail(holderRisk.reasons[0]??'ENTRY_HOLDER_RISK_UNAVAILABLE');
        this.requireHolderRisk(guardedOrder,holderRisk);
      }
      const result=await this.options.native.execute(guardedOrder,async()=>{
        const action=this.row(ref);if(!action||action.state!=='executing'||action.order_id!==guardedOrder.id)fail('MANUAL_NATIVE_BUY_ACTION_CHANGED');
        // The native executor has already checked the current on-chain balance immediately
        // before this callback. Reuse the chain-verified reservation snapshot here so the
        // shared order ledger can atomically include any newer local reservations without
        // putting an 8s RPC retry loop inside the worker's 5s broadcast guard.
        const checked=this.orders.checkFunding(guardedOrder.id,funding,this.now());if(!checked.ok)fail(checked.reason);
        if(mode==='risk_checked')this.requireHolderRisk(this.orders.get(guardedOrder.id)??guardedOrder,holderRisk!);
        const ready=this.options.native.readiness();if(!ready.ready)fail(ready.reason??'NATIVE_EXECUTOR_UNAVAILABLE');
        const begun=this.orders.beginSubmission(guardedOrder.id,this.now());if(!begun.order)fail(begun.reason??'ENTRY_ALREADY_HANDLED');
        attempted=true;
      });
      const failed=result.status==='failed';
      this.setState(ref,failed?'failed':'completed',result.failureReason,result.id,this.now());
      // The durable order observer owns submitted/confirmed/failed notices.
      // Emitting another controller-stage notice here produced three or four
      // Telegram messages for one click and could race the authoritative order.
    }catch(error){
      const failure=reason(error);
      if(order){
        const current=this.orders.get(order.id);
        if(current?.status==='prepared')this.orders.update(order.id,['prepared'],{status:'failed',failureReason:failure},this.now());
        else if(attempted&&current?.status==='submitting')this.orders.update(order.id,['submitting'],{status:'unknown',failureReason:failure},this.now());
      }
      this.setState(ref,attempted?'completed':'failed',failure,order?.id,this.now());
      // Before an order exists there is no order event to report the terminal
      // failure. Once reserved, OrderStore/TradeNotifications is the only
      // notification owner, including uncertain broadcast recovery.
      if(!order){
        const action=executionMode==='card_direct'?`卡片 ${solAmount(requestedAmount)} 买入`:'0.01 SOL 测试买入';
        this.notify(ref,`【买入失败】\n${action}未发送\n原因：${failure}`);
      }
    }
  }

  private notify(ref:string,text:string):void {try{this.options.enqueue?.({key:`manual-native-buy:${ref}`,text});}catch{/* trade state never depends on notifications */}}
  private row(ref:string):ActionRow|undefined{return this.db.prepare('SELECT * FROM manual_native_buy_actions WHERE ref=?').get(ref) as unknown as ActionRow|undefined;}
  private pendingRow(scope:string,owner:string):ActionRow|undefined{return this.db.prepare(`SELECT * FROM manual_native_buy_actions
    WHERE scope=? AND owner=? AND state IN ('awaiting_address','awaiting_amount','ready','executing') LIMIT 1`).get(scope,owner) as unknown as ActionRow|undefined;}
  private order(row:ActionRow):OpeningOrder|undefined{return row.order_id?this.orders.get(row.order_id):this.orders.byEvent(eventKey(row.ref));}
  private mode(row:ActionRow):ManualNativeBuyMode{return row.entry_mode==='card_direct'?'card_direct':'risk_checked';}
  private action(row:ActionRow):ManualNativeBuyAction{return {ref:row.ref,scope:row.scope,owner:row.owner,...(row.mint?{mint:row.mint}:{}),state:row.state,
    mode:this.mode(row),...(canonicalLamports(row.input_amount)?{amountLamports:row.input_amount}:{}),
    createdAt:row.created_at,updatedAt:row.updated_at,expiresAt:row.expires_at,...(row.order_id?{orderId:row.order_id}:{}),
    ...(row.failure_reason?{failureReason:row.failure_reason}:{})};}
  private expire(now:Date):void {this.db.prepare(`UPDATE manual_native_buy_actions SET state='expired',updated_at=?,failure_reason='MANUAL_NATIVE_BUY_ACTION_EXPIRED'
    WHERE state IN ('awaiting_address','awaiting_amount','ready') AND expires_at<=?`).run(now.toISOString(),now.toISOString());}
  private setOrder(ref:string,orderId:string,now:Date):void {this.db.prepare("UPDATE manual_native_buy_actions SET order_id=?,updated_at=? WHERE ref=? AND state='executing'")
    .run(orderId,now.toISOString(),ref);}
  private setState(ref:string,state:'completed'|'failed',failureReason:string|undefined,orderId:string|undefined,now:Date):void {
    this.db.prepare(`UPDATE manual_native_buy_actions SET state=?,failure_reason=?,order_id=COALESCE(?,order_id),updated_at=?
      WHERE ref=? AND state='executing'`).run(state,failureReason??null,orderId??null,now.toISOString(),ref);
  }
}
