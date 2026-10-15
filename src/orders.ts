import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import type {Chain} from './types.js';
import type {ExitPolicy} from './exit-policy.js';
import type {ExitAssessment} from './exit-tracking.js';

export interface ExitTracking {
  policy:ExitPolicy;
  state:'awaiting_swap'|'paper'|'unverified'|'monitoring'|'attention'|'closed';
  strategyOrderId?:string;
  assessment?:ExitAssessment;
  balance?:{status:'verified'|'unknown';amount?:string;checkedAt:string;reasons:string[]};
  reasons:string[];checkedAt:string;positionClosed:boolean;
}

export type OpeningStatus='prepared'|'submitting'|'submitted'|'confirmed'|'unknown'|'failed'|'paper_open';
export interface OpeningOrder {
  id:string;eventKey:string;chain:Chain;tokenAddress:string;mode:'paper'|'live';status:OpeningStatus;
  createdAt:string;updatedAt:string;wallet:string;inputToken:string;inputAmount:string;slippagePct:number;
  providerOrderId?:string;transactionHash?:string;outputAmount?:string;actualInputAmount?:string;
  failureReason?:string;details:Record<string,unknown>;
  exit?:ExitTracking;
}
export interface FundingSnapshot {
  balance:string;
  feeReserve:string;
  readStartedAt:string;
  checkedAt:string;
  /** Controller-proven confirmed buys already included in this balance snapshot. */
  coveredOrderIds:string[];
  blockNumber?:string;
  slot?:number;
}
export type FundingFailureReason='ENTRY_BALANCE_INVALID'|'ENTRY_BALANCE_STALE'|'ENTRY_INSUFFICIENT_BALANCE';
export type FundingCheck={ok:true}|{ok:false;reason:FundingFailureReason};
type NewOpening=Omit<OpeningOrder,'id'|'status'|'createdAt'|'updatedAt'>;
const active="'prepared','submitting','submitted','confirmed','unknown','paper_open'";
const occupies=`status IN (${active}) AND NOT (status='confirmed' AND COALESCE(json_extract(details,'$.exit.positionClosed'),0)=1)`;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sameAddress=(a:string,b:string,chain:Chain)=>chain==='solana'?a===b:a.toLowerCase()===b.toLowerCase();
function atomicAmount(value:unknown,chain:Chain):value is string {
  return typeof value==='string'&&/^(0|[1-9]\d{0,77})$/.test(value)&&
    BigInt(value)<=(chain==='solana'?(1n<<64n)-1n:(1n<<256n)-1n);
}
function validHash(value:unknown,chain:Chain):boolean {
  if(typeof value!=='string') return false;
  if(chain!=='solana') return /^0x[0-9a-fA-F]{64}$/.test(value);
  try {return bs58.decode(value).length===64;} catch {return false;}
}
function validateFunding(funding:FundingSnapshot|undefined,chain:Chain,now:Date):FundingFailureReason|undefined {
  if(!object(funding)||!atomicAmount(funding.balance,chain)||!atomicAmount(funding.feeReserve,chain)||
    typeof funding.readStartedAt!=='string'||typeof funding.checkedAt!=='string'||
    !Array.isArray(funding.coveredOrderIds)||funding.coveredOrderIds.length>100_000||
    funding.coveredOrderIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id))) return 'ENTRY_BALANCE_INVALID';
  const started=Date.parse(funding.readStartedAt),checked=Date.parse(funding.checkedAt),current=now.getTime();
  if(![started,checked,current].every(Number.isFinite)||started>checked) return 'ENTRY_BALANCE_INVALID';
  if(current-started>30_000||current-checked>30_000||started-current>5_000||checked-current>5_000)
    return 'ENTRY_BALANCE_STALE';
  return undefined;
}

/** Durable storage contains opening orders only. Research/raw vendor payloads never enter here. */
export class OrderStore {
  private db:DatabaseSync;
  constructor(path:string) {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    if(path!==':memory:') chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS opening_orders (
        id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,chain TEXT NOT NULL,token_address TEXT NOT NULL,
        mode TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        details TEXT NOT NULL
      );`);
  }
  reserve(input:NewOpening,maxOpen:number,now=new Date(),funding?:FundingSnapshot,
    options:{preventReentry?:boolean}={}):{created:boolean;order?:OpeningOrder;reason?:string} {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.byEvent(input.eventKey);
      if(previous) {this.db.exec('COMMIT');return {created:false,order:previous};}
      const duplicate=this.db.prepare(`SELECT id FROM opening_orders WHERE chain=? AND token_address=? AND mode=? AND ${occupies} LIMIT 1`)
        .get(input.chain,input.tokenAddress,input.mode);
      if(duplicate) {this.db.exec('COMMIT');return {created:false,reason:'ASSET_ALREADY_OPEN'};}
      // A repeat notification can arrive through live scanning or WATCH rechecks.
      // Keep the no-reentry check under this same write lock, including confirmed
      // positions closed while the controller was awaiting its balance request.
      if(options.preventReentry&&this.hasOpeningHistory(input.chain,input.tokenAddress,input.mode)) {
        this.db.exec('COMMIT');return {created:false,reason:'DEBOT_REENTRY_BLOCKED'};
      }
      if(input.mode==='live'&&this.hasUnprotectedOpening(now)) {
        this.db.exec('COMMIT');return {created:false,reason:'EXIT_PROTECTION_UNVERIFIED'};
      }
      const count=Number(this.db.prepare(`SELECT count(*) AS n FROM opening_orders WHERE mode=? AND ${occupies}`).get(input.mode)!.n);
      if(count>=maxOpen) {this.db.exec('COMMIT');return {created:false,reason:'OPENING_LIMIT_REACHED'};}
      let inputAmount=input.inputAmount,details=input.details;
      if(funding!==undefined) {
        const invalid=validateFunding(funding,input.chain,now);
        if(invalid||!atomicAmount(input.inputAmount,input.chain)||input.inputAmount==='0') {
          this.db.exec('COMMIT');return {created:false,reason:invalid??'ENTRY_BALANCE_INVALID'};
        }
        const reservedBefore=this.reservedFunding(input,funding);
        if(reservedBefore===undefined) {this.db.exec('COMMIT');return {created:false,reason:'ENTRY_BALANCE_INVALID'};}
        const available=BigInt(funding.balance)-BigInt(funding.feeReserve)-reservedBefore;
        if(available<=0n) {this.db.exec('COMMIT');return {created:false,reason:'ENTRY_INSUFFICIENT_BALANCE'};}
        const cap=BigInt(input.inputAmount);
        inputAmount=(available<cap?available:cap).toString();
        details={...input.details,funding:{cap:input.inputAmount,balance:funding.balance,feeReserve:funding.feeReserve,
          reservedBefore:reservedBefore.toString(),inputAmount,checkedAt:funding.checkedAt,readStartedAt:funding.readStartedAt}};
      }
      const order:OpeningOrder={...input,inputAmount,details,id:randomUUID(),status:'prepared',createdAt:now.toISOString(),updatedAt:now.toISOString()};
      this.db.prepare('INSERT INTO opening_orders VALUES (?,?,?,?,?,?,?,?,?)')
        .run(order.id,order.eventKey,order.chain,order.tokenAddress,order.mode,order.status,order.createdAt,order.updatedAt,JSON.stringify(order));
      this.db.exec('COMMIT');return {created:true,order};
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  /** Recheck all other live positions atomically with the last pre-send transition. */
  beginSubmission(id:string,now=new Date()):{order?:OpeningOrder;reason?:string} {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.get(id);
      if(!previous||previous.mode!=='live'||previous.status!=='prepared') {
        this.db.exec('COMMIT');return {reason:'ENTRY_ALREADY_HANDLED'};
      }
      if(this.hasUnprotectedOpening(now,id)) {
        this.db.exec('COMMIT');return {reason:'EXIT_PROTECTION_UNVERIFIED'};
      }
      const order:OpeningOrder={...previous,status:'submitting',updatedAt:now.toISOString()};
      this.db.prepare('UPDATE opening_orders SET status=?,updated_at=?,details=? WHERE id=? AND status=\'prepared\'')
        .run(order.status,order.updatedAt,JSON.stringify(order),id);
      this.db.exec('COMMIT');return {order};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  /** Missing exits and unresolved submissions block new live risk even if exits are disabled now. */
  private hasUnprotectedOpening(now:Date,excludeId=''):boolean {
    const current=now.getTime();
    if(!Number.isFinite(current)) return true;
    return !!this.db.prepare(`SELECT id FROM opening_orders WHERE mode='live' AND id<>? AND ${occupies}
      AND (status<>'confirmed'
        OR COALESCE(json_extract(details,'$.exit.assessment.hasLiveStop'),0)<>1
        OR COALESCE(json_extract(details,'$.exit.assessment.status'),'')<>'verified'
        OR COALESCE(json_extract(details,'$.exit.assessment.policyMatched'),0)<>1
        OR COALESCE(json_extract(details,'$.exit.state'),'')<>'monitoring'
        OR julianday(json_extract(details,'$.exit.checkedAt')) IS NULL
        OR julianday(json_extract(details,'$.exit.assessment.checkedAt')) IS NULL
        OR julianday(json_extract(details,'$.exit.checkedAt'))<julianday(?)
        OR julianday(json_extract(details,'$.exit.assessment.checkedAt'))<julianday(?)
        OR julianday(json_extract(details,'$.exit.checkedAt'))>julianday(?)
        OR julianday(json_extract(details,'$.exit.assessment.checkedAt'))>julianday(?)) LIMIT 1`)
      .get(excludeId,new Date(current-90_000).toISOString(),new Date(current-90_000).toISOString(),
        new Date(current+5_000).toISOString(),new Date(current+5_000).toISOString());
  }
  /** Recheck the fixed, already quoted principal. Never resize or double-count this order. */
  checkFunding(id:string,funding:FundingSnapshot|undefined,now=new Date()):FundingCheck {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const order=this.get(id);
      if(!order||!['prepared','submitting'].includes(order.status)) {
        this.db.exec('COMMIT');return {ok:false,reason:'ENTRY_BALANCE_INVALID'};
      }
      const invalid=validateFunding(funding,order.chain,now);
      if(invalid||!atomicAmount(order.inputAmount,order.chain)||order.inputAmount==='0') {
        this.db.exec('COMMIT');return {ok:false,reason:invalid??'ENTRY_BALANCE_INVALID'};
      }
      const reservedBefore=this.reservedFunding(order,funding!,order.id);
      if(reservedBefore===undefined) {this.db.exec('COMMIT');return {ok:false,reason:'ENTRY_BALANCE_INVALID'};}
      const storedFunding=object(order.details.funding)?order.details.funding:undefined;
      const storedFee=storedFunding?.feeReserve;
      if(storedFee!==undefined&&!atomicAmount(storedFee,order.chain)) {
        this.db.exec('COMMIT');return {ok:false,reason:'ENTRY_BALANCE_INVALID'};
      }
      const previousFee=storedFee===undefined?0n:BigInt(storedFee as string);
      const currentFee=BigInt(funding!.feeReserve),effectiveFee=previousFee>currentFee?previousFee:currentFee;
      const enough=BigInt(funding!.balance)-reservedBefore>=BigInt(order.inputAmount)+effectiveFee;
      // Raising the fee buffer in this same transaction keeps subsequent
      // reservations from consuming funds this fixed order will still need.
      if(enough&&(storedFee===undefined||currentFee>previousFee)) {
        const updated={...order,updatedAt:now.toISOString(),details:{...order.details,
          funding:{...storedFunding,feeReserve:effectiveFee.toString()}}};
        this.db.prepare('UPDATE opening_orders SET updated_at=?,details=? WHERE id=?')
          .run(updated.updatedAt,JSON.stringify(updated),order.id);
      }
      this.db.exec('COMMIT');return enough?{ok:true}:{ok:false,reason:'ENTRY_INSUFFICIENT_BALANCE'};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  /** Called under BEGIN IMMEDIATE, so reservations from other connections are visible and serialized. */
  private reservedFunding(scope:Pick<OpeningOrder,'chain'|'mode'|'wallet'|'inputToken'>,funding:FundingSnapshot,excludeId?:string):bigint|undefined {
    const covered=new Set(funding.coveredOrderIds);
    const rows=this.db.prepare(`SELECT details FROM opening_orders WHERE mode=? AND chain=? AND status IN (${active})`)
      .all(scope.mode,scope.chain);
    let reserved=0n;
    for(const row of rows) {
      const order=JSON.parse(String(row.details)) as OpeningOrder;
      if(order.id===excludeId||!sameAddress(order.wallet,scope.wallet,scope.chain)||!sameAddress(order.inputToken,scope.inputToken,scope.chain)) continue;
      // An exit can close after a snapshot taken before this buy. Until the
      // controller proves inclusion, even closed confirmed buys retain their debit.
      if(order.status==='confirmed'&&covered.has(order.id)&&validHash(order.transactionHash,order.chain)) continue;
      if(!atomicAmount(order.inputAmount,scope.chain)||order.inputAmount==='0') return;
      const stored=object(order.details.funding)?order.details.funding.feeReserve:undefined;
      if(stored!==undefined&&!atomicAmount(stored,scope.chain)) return;
      const fee=stored===undefined?funding.feeReserve:stored as string;
      reserved+=BigInt(order.inputAmount)+BigInt(fee);
    }
    return reserved;
  }
  get(id:string):OpeningOrder|undefined {const row=this.db.prepare('SELECT details FROM opening_orders WHERE id=?').get(id);return row?JSON.parse(String(row.details)):undefined;}
  byEvent(key:string):OpeningOrder|undefined {const row=this.db.prepare('SELECT details FROM opening_orders WHERE event_key=?').get(key);return row?JSON.parse(String(row.details)):undefined;}
  hasOpeningHistory(chain:Chain,address:string,mode:string):boolean {
    return !!this.db.prepare(`SELECT 1 FROM opening_orders WHERE chain=? AND token_address=? ${chain==='solana'?'':'COLLATE NOCASE'} AND mode=?
      AND status IN ('prepared','submitting','submitted','confirmed','unknown','paper_open') LIMIT 1`).get(chain,address,mode);
  }
  list(limit=50):OpeningOrder[] {return this.db.prepare('SELECT details FROM opening_orders ORDER BY rowid DESC LIMIT ?').all(limit).map(r=>JSON.parse(String(r.details)));}
  /** Dashboard pagination is separate from funding/reconciliation coverage. */
  page(options:{limit?:number;offset?:number;chain?:Chain}={}) {
    const limit=Number.isSafeInteger(options.limit)?Math.max(1,Math.min(100,options.limit!)):20;
    const offset=Number.isSafeInteger(options.offset)?Math.max(0,Math.min(1_000_000,options.offset!)):0;
    const where=options.chain?'WHERE chain=?':'',args=options.chain?[options.chain]:[];
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM opening_orders ${where}`).get(...args)!.n);
    const items=this.db.prepare(`SELECT details FROM opening_orders ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(...args,limit,offset).map(row=>JSON.parse(String(row.details)) as OpeningOrder);
    return {items,total,limit,offset,hasMore:offset+items.length<total};
  }
  /** All confirmed debits in a funding scope; UI pagination must never limit coverage checks. */
  fundingOrders(scope:Pick<OpeningOrder,'chain'|'mode'|'wallet'|'inputToken'>):OpeningOrder[] {
    return this.db.prepare("SELECT details FROM opening_orders WHERE mode=? AND chain=? AND status='confirmed' ORDER BY rowid ASC")
      .all(scope.mode,scope.chain).map(row=>JSON.parse(String(row.details)) as OpeningOrder)
      .filter(order=>sameAddress(order.wallet,scope.wallet,scope.chain)&&sameAddress(order.inputToken,scope.inputToken,scope.chain));
  }
  pending():OpeningOrder[] {
    return this.db.prepare("SELECT details FROM opening_orders WHERE mode='live' AND status IN ('submitting','submitted','unknown','confirmed') ORDER BY rowid ASC")
      .all().map(r=>JSON.parse(String(r.details)) as OpeningOrder).filter(order=>!!order.providerOrderId&&
        (order.status!=='confirmed'||!order.actualInputAmount||!order.outputAmount||!!order.exit&&!order.exit.positionClosed));
  }
  /** Separate compare-and-set keeps exit observations from rewriting immutable buy proof. */
  updateExit(id:string,expected:ExitTracking|undefined,next:ExitTracking,now=new Date()):OpeningOrder|undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.get(id);
      if(!previous||JSON.stringify(previous.exit)!==JSON.stringify(expected)||previous.exit?.positionClosed||
        !previous.exit||JSON.stringify(previous.exit.policy)!==JSON.stringify(next.policy)||
        (previous.exit.strategyOrderId&&next.strategyOrderId!==previous.exit.strategyOrderId)||
        (next.positionClosed&&(previous.status!=='confirmed'||!next.assessment?.terminal||
          next.balance?.status!=='verified'||next.balance.amount!=='0'||
          Date.parse(next.balance.checkedAt)<Date.parse(next.assessment.checkedAt)||
          !Number.isFinite(Date.parse(next.balance.checkedAt))||!Number.isFinite(Date.parse(next.assessment.checkedAt))))) {
        this.db.exec('COMMIT');return previous;
      }
      const order={...previous,exit:next,updatedAt:now.toISOString()};
      this.db.prepare('UPDATE opening_orders SET updated_at=?,details=? WHERE id=?').run(order.updatedAt,JSON.stringify(order),id);
      this.db.exec('COMMIT');return order;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  update(id:string,expected:OpeningStatus[],patch:Partial<Pick<OpeningOrder,'status'|'providerOrderId'|'transactionHash'|'outputAmount'|'actualInputAmount'|'failureReason'|'details'>>,now=new Date()):OpeningOrder|undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.get(id);
      if(!previous||!expected.includes(previous.status)) {this.db.exec('COMMIT');return;}
      // Keep terminal proof and known fill amounts immutable inside the write transaction,
      // including when two processes reconcile the same previously incomplete receipt.
      if(previous.status==='confirmed'&&(
        Object.hasOwn(patch,'status')&&patch.status!=='confirmed'||
        (['providerOrderId','transactionHash','actualInputAmount','outputAmount'] as const).some(key=>
          previous[key]!==undefined&&Object.hasOwn(patch,key)&&previous[key]!==patch[key]))) {
        this.db.exec('COMMIT');return;
      }
      const order={...previous,...patch,updatedAt:now.toISOString()};
      this.db.prepare('UPDATE opening_orders SET status=?,updated_at=?,details=? WHERE id=?').run(order.status,order.updatedAt,JSON.stringify(order),id);
      this.db.exec('COMMIT');return order;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  recover(now=new Date()):void {
    // A crash after sending a swap can leave no order ID. Never automatically send again.
    const cutoff=new Date(now.getTime()-5*60*1000).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows=this.db.prepare("SELECT details FROM opening_orders WHERE status IN ('prepared','submitting') AND updated_at<=?").all(cutoff);
      for(const row of rows) {
        const previous=JSON.parse(String(row.details)) as OpeningOrder;
        const order:OpeningOrder={...previous,status:previous.status==='prepared'?'failed':'unknown',updatedAt:now.toISOString(),
          failureReason:previous.status==='prepared'?'INTERRUPTED_BEFORE_SUBMIT':'SUBMISSION_OUTCOME_UNKNOWN'};
        this.db.prepare("UPDATE opening_orders SET status=?,updated_at=?,details=? WHERE id=? AND status IN ('prepared','submitting') AND updated_at<=?")
          .run(order.status,order.updatedAt,JSON.stringify(order),order.id,cutoff);
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  close():void {this.db.close();}
}
