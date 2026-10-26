import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import type {Chain} from './types.js';
import {buildExitConditions,type ExitPolicy} from './exit-policy.js';
import {validThirdSignalFill,type ExitAssessment} from './exit-tracking.js';
import type {DirectSellClosureEvidence} from './direct-sell.js';

export interface ExitTracking {
  native?:{provider:'pump_native';healthy:boolean;checkedAt:string;buySignature:string;buySlot:number;balanceSlot:number;
    balanceAmount:string;closed:boolean;closeReason?:'sold'|'external_zero';gainPct?:number;realizedPnlLamports?:string};
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
export type FundingFailureReason='ENTRY_BALANCE_INVALID'|'ENTRY_BALANCE_STALE'|'ENTRY_INSUFFICIENT_BALANCE'|'ENTRY_BALANCE_FRACTION_EXCEEDED';
export type FundingCheck={ok:true}|{ok:false;reason:FundingFailureReason};
type NewOpening=Omit<OpeningOrder,'id'|'status'|'createdAt'|'updatedAt'>;
const active="'prepared','submitting','submitted','confirmed','unknown','paper_open'";
const directClosed="COALESCE(json_extract(details,'$.details.authoritativeClose.kind'),'')='direct_sell'";
const occupies=`status IN (${active}) AND NOT (status='confirmed' AND (COALESCE(json_extract(details,'$.exit.positionClosed'),0)=1 OR (${directClosed})))`;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validBalanceBps=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=10000;
const sameAddress=(a:string,b:string,chain:Chain)=>chain==='solana'?a===b:a.toLowerCase()===b.toLowerCase();
const claimAddress=(chain:Chain,address:string)=>chain==='solana'?address:address.toLowerCase();
const attemptedStatuses=new Set<OpeningStatus>(['submitting','submitted','confirmed','unknown','paper_open']);
const hasExecutionProof=(order:OpeningOrder)=>!!order.providerOrderId||!!order.transactionHash||
  ['ENTRY_ORDER_FAILED','ENTRY_ORDER_EXPIRED','SUBMISSION_OUTCOME_UNKNOWN'].includes(order.failureReason??'');
function atomicAmount(value:unknown,chain:Chain):value is string {
  return typeof value==='string'&&/^(0|[1-9]\d{0,77})$/.test(value)&&
    BigInt(value)<=(chain==='solana'?(1n<<64n)-1n:(1n<<256n)-1n);
}
function validHash(value:unknown,chain:Chain):boolean {
  if(typeof value!=='string') return false;
  if(chain!=='solana') return /^0x[0-9a-fA-F]{64}$/.test(value);
  try {return bs58.decode(value).length===64;} catch {return false;}
}
function validDirectClosure(order:OpeningOrder,evidence:unknown,now:Date):evidence is DirectSellClosureEvidence {
  if(order.mode!=='live'||order.status!=='confirmed'||order.chain!=='solana'||!validHash(order.transactionHash,'solana')||
    !object(evidence)||evidence.positionId!==order.id||typeof evidence.requestId!=='string'||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(evidence.requestId)||typeof evidence.percentage!=='number'||
    !Number.isSafeInteger(evidence.percentage)||evidence.percentage<1||evidence.percentage>100||
    !atomicAmount(evidence.amount,'solana')||evidence.amount==='0'||!object(evidence.sell)||!object(evidence.finalSnapshot))return false;
  const f=evidence.sell,b=evidence.finalSnapshot,current=now.getTime();
  const validAddress=(v:unknown)=>{try{return typeof v==='string'&&bs58.decode(v).length===32&&bs58.encode(bs58.decode(v))===v;}catch{return false;}};
  if(!validAddress(order.wallet)||!validAddress(order.tokenAddress)||!validHash(f.signature,'solana')||f.signature===order.transactionHash||
    f.side!=='sell'||f.wallet!==order.wallet||f.mint!==order.tokenAddress||b.wallet!==order.wallet||b.mint!==order.tokenAddress||
    !Number.isInteger(f.decimals)||Number(f.decimals)<0||Number(f.decimals)>255||b.decimals!==f.decimals||
    !Number.isSafeInteger(f.slot)||Number(f.slot)<0||!Number.isSafeInteger(b.slot)||!Number.isSafeInteger(b.nativeSlot)||
    Number(b.slot)<Number(f.slot)||Number(b.nativeSlot)<Number(f.slot)||b.tokenAmount!=='0'||!atomicAmount(b.nativeLamports,'solana')||
    f.tokenDelta!=='-'+evidence.amount||!atomicAmount(f.preTokenAmount,'solana')||!atomicAmount(f.postTokenAmount,'solana')||
    BigInt(f.preTokenAmount)-BigInt(f.postTokenAmount)!==BigInt(evidence.amount)||
    !atomicAmount(f.feeLamports,'solana')||!atomicAmount(f.preNativeLamports,'solana')||!atomicAmount(f.postNativeLamports,'solana')||
    typeof f.nativeDelta!=='string'||!/^(-?[1-9]\d{0,19}|0)$/.test(f.nativeDelta)||
    BigInt(f.postNativeLamports)-BigInt(f.preNativeLamports)!==BigInt(f.nativeDelta))return false;
  const sold=typeof f.checkedAt==='string'?Date.parse(f.checkedAt):NaN,checked=typeof b.checkedAt==='string'?Date.parse(b.checkedAt):NaN,created=Date.parse(order.createdAt);
  if(![sold,checked,created,current].every(Number.isFinite)||sold<created||checked<sold||sold>current+5000||checked>current+5000)return false;
  const fill=order.details.thirdSignalFill;
  if(object(fill)&&(fill.tokenDecimals!==undefined&&fill.tokenDecimals!==f.decimals||
    fill.buySlot!==undefined&&(!Number.isSafeInteger(fill.buySlot)||Number(fill.buySlot)>Number(f.slot))))return false;
  if(order.details.tokenDecimals!==undefined&&order.details.tokenDecimals!==f.decimals)return false;
  return true;
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
  private readonly listeners=new Set<(order:OpeningOrder)=>void|Promise<void>>();
  constructor(path:string,options:{busyTimeoutMs?:number}={}) {
    const busyTimeoutMs=options.busyTimeoutMs??5000;
    if(!Number.isSafeInteger(busyTimeoutMs)||busyTimeoutMs<0||busyTimeoutMs>5000)throw Error('ORDER_DATABASE_TIMEOUT_INVALID');
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    if(path!==':memory:') chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${busyTimeoutMs};
      CREATE TABLE IF NOT EXISTS opening_orders (
        id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,chain TEXT NOT NULL,token_address TEXT NOT NULL,
        mode TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        details TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS opening_orders_active_lookup ON opening_orders(mode,status,chain);
      CREATE TABLE IF NOT EXISTS opening_identity_claims (
        mode TEXT NOT NULL,chain TEXT NOT NULL,token_address TEXT NOT NULL,record_id TEXT NOT NULL,claimed_at TEXT NOT NULL,
        PRIMARY KEY(mode,chain,token_address)
      );
      INSERT OR IGNORE INTO opening_identity_claims(mode,chain,token_address,record_id,claimed_at)
        SELECT mode,chain,CASE WHEN chain='solana' THEN token_address ELSE lower(token_address) END,id,updated_at
        FROM opening_orders WHERE status IN ('submitting','submitted','confirmed','unknown','paper_open')
          OR COALESCE(json_extract(details,'$.providerOrderId'),'')<>''
          OR COALESCE(json_extract(details,'$.transactionHash'),'')<>''
          OR COALESCE(json_extract(details,'$.failureReason'),'') IN ('ENTRY_ORDER_FAILED','ENTRY_ORDER_EXPIRED','SUBMISSION_OUTCOME_UNKNOWN')
        ORDER BY rowid ASC;`);
  }
  private identityClaim(chain:Chain,address:string,mode:'paper'|'live'):{mode:'paper'|'live';record_id:string}|undefined {
    return this.db.prepare(`SELECT mode,record_id FROM opening_identity_claims WHERE chain=? AND token_address=?
      AND mode IN ('live',?) ORDER BY CASE WHEN mode='live' THEN 0 ELSE 1 END LIMIT 1`)
      .get(chain,claimAddress(chain,address),mode) as {mode:'paper'|'live';record_id:string}|undefined;
  }
  /** Called in the order write transaction: an attempt permanently consumes this token identity. */
  private claimIdentity(order:OpeningOrder):boolean {
    const existing=this.identityClaim(order.chain,order.tokenAddress,order.mode);
    if(existing)return existing.mode===order.mode&&existing.record_id===order.id;
    this.db.prepare('INSERT INTO opening_identity_claims VALUES (?,?,?,?,?)')
      .run(order.mode,order.chain,claimAddress(order.chain,order.tokenAddress),order.id,order.updatedAt);
    return true;
  }
  private validateExternalIdentity(input:{chain:Chain;address:string;recordId:string}):void {
    let validAddress=false;
    if(input.chain==='bsc'||input.chain==='robinhood')validAddress=/^0x[0-9a-fA-F]{40}$/.test(input.address);
    else if(input.chain==='solana')try{const decoded=bs58.decode(input.address);validAddress=decoded.length===32&&bs58.encode(decoded)===input.address;}catch{}
    if(!validAddress||typeof input.recordId!=='string'||!input.recordId||input.recordId.length>512||/[\x00-\x1f\x7f]/.test(input.recordId))
      throw new Error('OPENING_HISTORY_IMPORT_INVALID');
  }
  /** Excludes prepared reservations and paper research; only durable real attempts count. */
  hasAttemptedOpening(chain:Chain,address:string):boolean {
    return !!this.identityClaim(chain,address,'live');
  }
  /** Shared write-ahead identity for an external execution journal. This method never sends a transaction. */
  claimExternalAttempt(input:{chain:Chain;address:string;recordId:string}):boolean {
    this.validateExternalIdentity(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing=this.identityClaim(input.chain,input.address,'live');
      if(existing){this.db.exec('COMMIT');return existing.record_id===input.recordId;}
      this.db.prepare("INSERT OR IGNORE INTO opening_identity_claims VALUES ('live',?,?,?,?)")
        .run(input.chain,claimAddress(input.chain,input.address),input.recordId,new Date().toISOString());
      this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Import an externally journaled real attempt; this never submits or changes an order. */
  markPreviouslyOpened(input:{chain:Chain;address:string;recordId:string}):void {
    this.claimExternalAttempt(input);
  }
  /** Notifications are observers of committed changes and can never fail a trade. */
  subscribe(listener:(order:OpeningOrder)=>void|Promise<void>):()=>void {
    this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};
  }
  private emit(order:OpeningOrder):void {
    for(const listener of this.listeners) {
      try {const result=listener(structuredClone(order));if(result)void Promise.resolve(result).catch(()=>{});}
      catch { /* A broken notification sink must not roll back an already committed order. */ }
    }
  }
  reserve(input:NewOpening,maxOpen:number,now=new Date(),funding?:FundingSnapshot,
    options:{preventReentry?:boolean;balanceBps?:number;balanceBasis?:'available'|'total'}={}):{created:boolean;order?:OpeningOrder;reason?:string} {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(Object.hasOwn(input.details,'authoritativeClose')) {this.db.exec('COMMIT');return {created:false,reason:'OPENING_CLOSE_PROOF_RESERVED'};}
      const previous=this.byEvent(input.eventKey);
      if(previous) {this.db.exec('COMMIT');return {created:false,order:previous};}
      const duplicate=this.db.prepare(`SELECT id FROM opening_orders WHERE chain=? AND token_address=? ${input.chain==='solana'?'':'COLLATE NOCASE'} AND mode=? AND ${occupies} LIMIT 1`)
        .get(input.chain,input.tokenAddress,input.mode);
      if(duplicate) {this.db.exec('COMMIT');return {created:false,reason:'ASSET_ALREADY_OPEN'};}
      if(this.identityClaim(input.chain,input.tokenAddress,input.mode)) {
        this.db.exec('COMMIT');return {created:false,reason:'ASSET_REENTRY_BLOCKED'};
      }
      // A repeat notification can arrive through live scanning or WATCH rechecks.
      // Keep the no-reentry check under this same write lock, including confirmed
      // positions closed while the controller was awaiting its balance request.
      if(options.preventReentry&&this.hasOpeningHistory(input.chain,input.tokenAddress,input.mode)) {
        this.db.exec('COMMIT');return {created:false,reason:'DEBOT_REENTRY_BLOCKED'};
      }
      if(input.mode==='live'&&this.hasUnprotectedOpening(now,'',input.chain==='solana'&&input.details.executionStrategy==='third_signal_v1')) {
        this.db.exec('COMMIT');return {created:false,reason:'EXIT_PROTECTION_UNVERIFIED'};
      }
      const count=Number(this.db.prepare(`SELECT count(*) AS n FROM opening_orders WHERE mode=? AND ${occupies}`).get(input.mode)!.n);
      if(count>=maxOpen) {this.db.exec('COMMIT');return {created:false,reason:'OPENING_LIMIT_REACHED'};}
      let inputAmount=input.inputAmount,details=input.details;
      const balanceBps=options.balanceBps;
      const balanceBasis=options.balanceBasis??'available';
      if((balanceBps!==undefined&&(!validBalanceBps(balanceBps)||funding===undefined))||
        (options.balanceBasis!==undefined&&(balanceBps===undefined||!['available','total'].includes(options.balanceBasis)))) {
        this.db.exec('COMMIT');return {created:false,reason:'ENTRY_BALANCE_INVALID'};
      }
      if(funding!==undefined) {
        const invalid=validateFunding(funding,input.chain,now);
        if(invalid||(balanceBps===undefined&&(!atomicAmount(input.inputAmount,input.chain)||input.inputAmount==='0'))) {
          this.db.exec('COMMIT');return {created:false,reason:invalid??'ENTRY_BALANCE_INVALID'};
        }
        const reservedBefore=this.reservedFunding(input,funding);
        if(reservedBefore===undefined) {this.db.exec('COMMIT');return {created:false,reason:'ENTRY_BALANCE_INVALID'};}
        const available=BigInt(funding.balance)-BigInt(funding.feeReserve)-reservedBefore;
        if(available<=0n) {this.db.exec('COMMIT');return {created:false,reason:'ENTRY_INSUFFICIENT_BALANCE'};}
        // New orders use total native balance for the percentage. Availability
        // still accounts for every reservation under this write lock. The legacy
        // available basis is retained for already recorded policies and callers.
        if(balanceBps!==undefined) {
          const basis=balanceBasis==='total'?BigInt(funding.balance):available;
          const target=basis*BigInt(balanceBps)/10000n;
          inputAmount=(target<available?target:available).toString();
        }
        else {const cap=BigInt(input.inputAmount);inputAmount=(available<cap?available:cap).toString();}
        if(inputAmount==='0') {this.db.exec('COMMIT');return {created:false,reason:'ENTRY_INSUFFICIENT_BALANCE'};}
        details={...input.details,funding:{...(balanceBps===undefined?{cap:input.inputAmount}:
          {sizing:'balance_fraction',balanceBps,balanceBasis,availableBefore:available.toString()}),balance:funding.balance,feeReserve:funding.feeReserve,
          reservedBefore:reservedBefore.toString(),inputAmount,checkedAt:funding.checkedAt,readStartedAt:funding.readStartedAt}};
      }
      const order:OpeningOrder={...input,inputAmount,details,id:randomUUID(),status:'prepared',createdAt:now.toISOString(),updatedAt:now.toISOString()};
      this.db.prepare('INSERT INTO opening_orders VALUES (?,?,?,?,?,?,?,?,?)')
        .run(order.id,order.eventKey,order.chain,order.tokenAddress,order.mode,order.status,order.createdAt,order.updatedAt,JSON.stringify(order));
      this.db.exec('COMMIT');this.emit(order);return {created:true,order};
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
      if(this.identityClaim(previous.chain,previous.tokenAddress,'live')) {
        this.db.exec('COMMIT');return {reason:'ASSET_REENTRY_BLOCKED'};
      }
      if(this.hasUnprotectedOpening(now,id,previous.chain==='solana'&&previous.details.executionStrategy==='third_signal_v1')) {
        this.db.exec('COMMIT');return {reason:'EXIT_PROTECTION_UNVERIFIED'};
      }
      const order:OpeningOrder={...previous,status:'submitting',updatedAt:now.toISOString()};
      if(!this.claimIdentity(order)) {this.db.exec('COMMIT');return {reason:'ASSET_REENTRY_BLOCKED'};}
      this.db.prepare('UPDATE opening_orders SET status=?,updated_at=?,details=? WHERE id=? AND status=\'prepared\'')
        .run(order.status,order.updatedAt,JSON.stringify(order),id);
      this.db.exec('COMMIT');this.emit(order);return {order};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  /** Missing exits and unresolved submissions block new live risk even if exits are disabled now. */
  private hasUnprotectedOpening(now:Date,excludeId='',allowObserved=false):boolean {
    const current=now.getTime();if(!Number.isFinite(current))return true;
    const fresh=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&
      Date.parse(value)>=current-90_000&&Date.parse(value)<=current+5_000;
    const rows=this.db.prepare(`SELECT details FROM opening_orders WHERE mode='live' AND id<>? AND ${occupies}`).all(excludeId);
    return rows.some(row=>{
      const order=JSON.parse(String(row.details)) as OpeningOrder,exit=order.exit,assessment=exit?.assessment;
      if(order.details.executionProvider==='pump_native'){
        const p=exit?.native;
        return order.status!=='confirmed'||exit?.state!=='monitoring'||!p||p.provider!=='pump_native'||!p.healthy||
          p.closed||p.buySignature!==order.transactionHash||!fresh(p.checkedAt)||!fresh(exit.checkedAt)||p.balanceSlot<p.buySlot;
      }
      if(order.status!=='confirmed'||!exit||exit.state!=='monitoring'||!assessment||!assessment.policyMatched||
        !fresh(exit.checkedAt)||!fresh(assessment.checkedAt))return true;
      if(assessment.status==='verified'&&assessment.hasLiveStop===true)return false;
      if(!allowObserved||order.chain!=='solana'||order.details.executionStrategy!=='third_signal_v1'||
        assessment.status!=='observed'||assessment.observedLiveStop!==true||assessment.hasLiveStop!==false||
        assessment.automaticTriggerVerified!==false||!assessment.found||assessment.terminal||
        !exit.strategyOrderId||assessment.strategyOrderId!==exit.strategyOrderId||
        !['transaction_hash','amount_time_match'].includes(assessment.linkage??'')||
        !/^[0-9a-f]{64}$/.test(assessment.parentFingerprint??'')||assessment.parentStatus!=='open'||assessment.strategyStatus!=='running')return true;
      const fill=order.details.thirdSignalFill;
      if(!validThirdSignalFill(fill,{chain:order.chain,wallet:order.wallet,tokenAddress:order.tokenAddress,inputToken:order.inputToken,
        openingTransactionHash:order.transactionHash},now)||fill.inputAmount!==order.actualInputAmount||fill.outputAmount!==order.outputAmount)return true;
      let conditions;try{conditions=buildExitConditions(exit.policy);}catch{return true;}
      const key=(c:{order_type:string;side:string;price_scale:string;sell_ratio:string})=>JSON.stringify([c.order_type,c.side,c.price_scale,c.sell_ratio]);
      const expectedProfit=conditions.find(c=>c.order_type==='profit_stop'),expectedLoss=conditions.find(c=>c.order_type==='loss_stop');
      const expected=conditions.map(key).sort();
      if(exit.policy.sellRatioType!=='hold_amount'||conditions.length!==2||expectedProfit?.price_scale!=='100'||expectedProfit.sell_ratio!=='50'||
        expectedLoss?.sell_ratio!=='100'||assessment.conditions.length!==2||
        JSON.stringify(assessment.conditions.map(c=>JSON.stringify([c.orderType,'sell',c.priceScale,c.sellRatio])).sort())!==JSON.stringify(expected))return true;
      const stop=assessment.conditions.find(c=>c.orderType==='loss_stop'),profit=assessment.conditions.find(c=>c.orderType==='profit_stop');
      return !stop||!profit||!['check','running'].includes(stop.status)||!['check','running','success'].includes(profit.status);
    });
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
      const available=BigInt(funding!.balance)-reservedBefore-effectiveFee;
      const enough=available>=BigInt(order.inputAmount);
      const balanceBps=storedFunding?.balanceBps;
      const balanceBasis=storedFunding?.balanceBasis??'available';
      if((storedFunding?.sizing!==undefined&&storedFunding.sizing!=='balance_fraction')||
        (storedFunding?.sizing==='balance_fraction'&&!validBalanceBps(balanceBps))||
        (balanceBps!==undefined&&storedFunding?.sizing!=='balance_fraction')||
        (storedFunding?.balanceBasis!==undefined&&(storedFunding.sizing!=='balance_fraction'||
          !['available','total'].includes(storedFunding.balanceBasis as string)))) {
        this.db.exec('COMMIT');return {ok:false,reason:'ENTRY_BALANCE_INVALID'};
      }
      // Revalidate the recorded percentage basis. Fee/reservation changes bound
      // spendability without shrinking a total-balance percentage a second time.
      const fractionBasis=balanceBasis==='total'?BigInt(funding!.balance):available;
      if(enough&&validBalanceBps(balanceBps)&&BigInt(order.inputAmount)>fractionBasis*BigInt(balanceBps)/10000n) {
        this.db.exec('COMMIT');return {ok:false,reason:'ENTRY_BALANCE_FRACTION_EXCEEDED'};
      }
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
    if((mode==='paper'||mode==='live')&&this.identityClaim(chain,address,mode)?.mode===mode)return true;
    return !!this.db.prepare(`SELECT 1 FROM opening_orders WHERE chain=? AND token_address=? ${chain==='solana'?'':'COLLATE NOCASE'} AND mode=?
      AND status IN ('prepared','submitting','submitted','confirmed','unknown','paper_open') LIMIT 1`).get(chain,address,mode);
  }
  list(limit=50):OpeningOrder[] {return this.db.prepare('SELECT details FROM opening_orders ORDER BY rowid DESC LIMIT ?').all(limit).map(r=>JSON.parse(String(r.details)));}
  /** Price monitoring covers the complete active ledger, independent of dashboard pagination. */
  activePositions(options:{includePaper?:boolean}={}):OpeningOrder[] {
    return this.db.prepare(`SELECT details FROM opening_orders WHERE
      ((mode='live' AND status IN ('submitting','submitted','confirmed','unknown'))
        ${options.includePaper?"OR (mode='paper' AND status='paper_open')":''})
      AND COALESCE(json_extract(details,'$.exit.positionClosed'),0)<>1 AND NOT (${directClosed}) ORDER BY rowid ASC`)
      .all().map(row=>JSON.parse(String(row.details)) as OpeningOrder);
  }
  /** Native worker recovery only needs its own live execution journal identities. */
  activeNativePositions():OpeningOrder[] {
    return this.db.prepare(`SELECT details FROM opening_orders WHERE mode='live' AND chain='solana'
      AND status IN ('submitting','submitted','confirmed','unknown')
      AND json_extract(details,'$.details.executionProvider')='pump_native'
      AND COALESCE(json_extract(details,'$.exit.positionClosed'),0)<>1 AND NOT (${directClosed}) ORDER BY rowid ASC`)
      .all().map(row=>JSON.parse(String(row.details)) as OpeningOrder);
  }
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
    return this.db.prepare(`SELECT details FROM opening_orders WHERE mode='live' AND status IN ('submitting','submitted','unknown','confirmed') AND NOT (${directClosed}) ORDER BY rowid ASC`)
      .all().map(r=>JSON.parse(String(r.details)) as OpeningOrder).filter(order=>!!order.providerOrderId&&
        (order.status!=='confirmed'||!order.actualInputAmount||!order.outputAmount||!!order.exit&&!order.exit.positionClosed));
  }
  /** A verified owner sale releases the position without inventing a GMGN strategy transition. */
  markDirectSellClosed(positionId:string,evidence:DirectSellClosureEvidence,now=new Date()):OpeningOrder|undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.get(positionId);
      if(!previous||!validDirectClosure(previous,evidence,now)){this.db.exec('COMMIT');return;}
      const existing=previous.details.authoritativeClose;
      if(existing!==undefined){this.db.exec('COMMIT');return object(existing)&&existing.kind==='direct_sell'&&
        existing.requestId===evidence.requestId?previous:undefined;}
      const order:OpeningOrder={...previous,updatedAt:now.toISOString(),details:{...previous.details,
        authoritativeClose:{kind:'direct_sell',...structuredClone(evidence),recordedAt:now.toISOString()}}};
      this.db.prepare('UPDATE opening_orders SET updated_at=?,details=? WHERE id=?').run(order.updatedAt,JSON.stringify(order),positionId);
      this.db.exec('COMMIT');this.emit(order);return order;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Separate compare-and-set keeps exit observations from rewriting immutable buy proof. */
  updateNativeProtection(id:string,native:NonNullable<ExitTracking['native']>,now=new Date()):OpeningOrder|undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.get(id),fill=old?.details.nativeFill;
      const time=Date.parse(native.checkedAt);
      if(!old||old.status!=='confirmed'||old.details.executionProvider!=='pump_native'||!old.exit||old.exit.positionClosed||
        !object(fill)||fill.signature!==old.transactionHash||native.buySignature!==old.transactionHash||fill.slot!==native.buySlot||
        !Number.isSafeInteger(native.buySlot)||!Number.isSafeInteger(native.balanceSlot)||native.balanceSlot<native.buySlot||
        !/^(0|[1-9]\d{0,19})$/.test(native.balanceAmount)||!Number.isFinite(time)||time>now.getTime()+1000||
        time<Date.parse(old.exit.native?.checkedAt??'1970-01-01')||native.closed&&native.balanceAmount!=='0'){
        this.db.exec('COMMIT');return;
      }
      const next:OpeningOrder={...old,updatedAt:now.toISOString(),exit:{...old.exit,native,
        state:native.closed?'closed':native.healthy?'monitoring':'attention',positionClosed:native.closed,
        checkedAt:native.checkedAt,reasons:native.closed?[]:native.healthy?[]:['NATIVE_PROTECTION_UNHEALTHY'],
        balance:{status:'verified',amount:native.balanceAmount,checkedAt:native.checkedAt,reasons:[]}}};
      this.db.prepare('UPDATE opening_orders SET updated_at=?,details=? WHERE id=?').run(next.updatedAt,JSON.stringify(next),id);
      this.db.exec('COMMIT');this.emit(next);return next;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  updateExit(id:string,expected:ExitTracking|undefined,next:ExitTracking,now=new Date()):OpeningOrder|undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.get(id);
      if(!previous||previous.details.authoritativeClose!==undefined||JSON.stringify(previous.exit)!==JSON.stringify(expected)||previous.exit?.positionClosed||
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
      this.db.exec('COMMIT');this.emit(order);return order;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  update(id:string,expected:OpeningStatus[],patch:Partial<Pick<OpeningOrder,'status'|'providerOrderId'|'transactionHash'|'outputAmount'|'actualInputAmount'|'failureReason'|'details'>>,now=new Date()):OpeningOrder|undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.get(id);
      if(!previous||!expected.includes(previous.status)) {this.db.exec('COMMIT');return;}
      if(patch.details&&Object.hasOwn(patch.details,'authoritativeClose')&&
        JSON.stringify(patch.details.authoritativeClose)!==JSON.stringify(previous.details.authoritativeClose)) {
        this.db.exec('COMMIT');return;
      }
      // Keep terminal proof and known fill amounts immutable inside the write transaction,
      // including when two processes reconcile the same previously incomplete receipt.
      if(previous.status==='confirmed'&&(
        Object.hasOwn(patch,'status')&&patch.status!=='confirmed'||
        (['providerOrderId','transactionHash','actualInputAmount','outputAmount'] as const).some(key=>
          previous[key]!==undefined&&Object.hasOwn(patch,key)&&previous[key]!==patch[key]))) {
        this.db.exec('COMMIT');return;
      }
      const order={...previous,...patch,updatedAt:now.toISOString(),...(patch.details&&previous.details.authoritativeClose!==undefined?
        {details:{...patch.details,authoritativeClose:previous.details.authoritativeClose}}:{})};
      const existing=this.identityClaim(order.chain,order.tokenAddress,order.mode);
      if(Object.hasOwn(patch,'status')&&existing&&['prepared','submitting'].includes(order.status)) {
        this.db.exec('COMMIT');return;
      }
      if(attemptedStatuses.has(order.status)||hasExecutionProof(order)) {
        // Legacy ledgers may already contain multiple attempted buys for a token.
        // Their read-only receipt reconciliation must remain possible after the
        // first identity claim wins, while a new prepared buy may never use it.
        const previouslyAttempted=attemptedStatuses.has(previous.status)||hasExecutionProof(previous);
        if(!(existing&&previouslyAttempted)&&!this.claimIdentity(order)) {
          this.db.exec('COMMIT');return;
        }
      }
      this.db.prepare('UPDATE opening_orders SET status=?,updated_at=?,details=? WHERE id=?').run(order.status,order.updatedAt,JSON.stringify(order),id);
      this.db.exec('COMMIT');this.emit(order);return order;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  recover(now=new Date()):void {
    // A crash after sending a swap can leave no order ID. Never automatically send again.
    const cutoff=new Date(now.getTime()-5*60*1000).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows=this.db.prepare("SELECT details FROM opening_orders WHERE status IN ('prepared','submitting') AND updated_at<=?").all(cutoff);
      const changed:OpeningOrder[]=[];
      for(const row of rows) {
        const previous=JSON.parse(String(row.details)) as OpeningOrder;
        const order:OpeningOrder={...previous,status:previous.status==='prepared'?'failed':'unknown',updatedAt:now.toISOString(),
          failureReason:previous.status==='prepared'?'INTERRUPTED_BEFORE_SUBMIT':'SUBMISSION_OUTCOME_UNKNOWN'};
        this.db.prepare("UPDATE opening_orders SET status=?,updated_at=?,details=? WHERE id=? AND status IN ('prepared','submitting') AND updated_at<=?")
          .run(order.status,order.updatedAt,JSON.stringify(order),order.id,cutoff);
        changed.push(order);
      }
      this.db.exec('COMMIT');
      for(const order of changed)this.emit(order);
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  close():void {this.listeners.clear();this.db.close();}
}
