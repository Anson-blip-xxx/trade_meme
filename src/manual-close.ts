import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,openSync,closeSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import bs58 from 'bs58';
import type {Chain} from './types.js';
import type {TestTradeClient,TestChainReader,SolanaSnapshot,VerifiedSolanaTransaction} from './controlled-test/types.js';
import {inspectTestQuote} from './trade-interface-check.js';

export interface ManualClosePosition {
  id:string;chain:Chain;wallet:string;tokenAddress:string;tokenDecimals?:number;openingTransactionHash:string;
  providerOrderId?:string;strategyOrderIds?:string[];name?:string;symbol?:string;protectionExpected?:boolean;
  openingOutputAmount?:string;
  protectionEvidence?:{inputAmount:string;outputAmount:string;tokenDecimals:number;confirmedAt:string;
    conditions:Array<{order_type:string;side:string;price_scale:string;sell_ratio:string}>;sellRatioType:'hold_amount'};
}
export interface ManualCloseReply {text:string;token?:string;requestId?:string;state?:string;}
export interface ManualCloseOptions {
  positions:()=>ManualClosePosition[];client:TestTradeClient;chain:TestChainReader;
  enqueue:(event:{key:string;text:string})=>boolean;now?:()=>number;sleep?:(ms:number)=>Promise<void>;
  partialSellSignatures?:(position:ManualClosePosition,opening:VerifiedSolanaTransaction,snapshot:SolanaSnapshot)=>Promise<string[]>;
  previewTtlMs?:number;pollAttempts?:number;
}
type State='preview'|'executing'|'attention'|'awaiting_confirmation'|'closed'|'canceled';
interface Request {
  id:string;position:ManualClosePosition;identity:string;state:State;createdAt:number;updatedAt:number;
  previewAmount:string;reason?:string;strategies:Array<{id:string;fingerprint:string;linkage:'transaction_hash'|'saved_strategy_id'|'amount_time_match'}>;
  beforeSell?:SolanaSnapshot;sell?:VerifiedSolanaTransaction;finalSnapshot?:SolanaSnapshot;
  partialProof?:{transactions:VerifiedSolanaTransaction[];remainingAmount:string;decimals:number};
  protectionCanceledAt?:number;
}
interface Operation {key:string;clientId:string;body:Record<string,unknown>;state:'submitting'|'acknowledged'|'unknown';response?:unknown;}
const SOL='So11111111111111111111111111111111111111112';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
const atom=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d{0,19})$/.test(v)&&BigInt(v)<=(1n<<64n)-1n;
const base58=(v:unknown,size:number)=>{try{return typeof v==='string'&&bs58.decode(v).length===size&&bs58.encode(bs58.decode(v))===v;}catch{return false;}};
const clean=(v:string)=>v.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,100);
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const explanations:Record<string,string>={
  MANUAL_CLOSE_POSITION_UNAVAILABLE:'这笔持仓当前不可用，请刷新持仓列表。',MANUAL_CLOSE_CHAIN_UNSUPPORTED:'这条链的 TG 平仓暂未完成核验，当前仅支持 SOL。',
  MANUAL_CLOSE_TOKEN_INVALID:'确认已失效，请重新打开持仓预览。',MANUAL_CLOSE_TOKEN_EXPIRED:'预览已过期，请重新查看并确认。',
  MANUAL_CLOSE_BUSY:'另一笔平仓正在处理，请稍后再确认。',MANUAL_CLOSE_STRATEGY_OWNERSHIP_UNVERIFIED:'无法可靠匹配这笔持仓的保护单，尚未撤单或卖出。',
  MANUAL_CLOSE_FOREIGN_STRATEGY:'发现不属于本次预览的保护单，已暂停操作。',MANUAL_CLOSE_GAS_BALANCE_LOW:'SOL 手续费余额不足，尚未提交卖单。',
  MANUAL_CLOSE_QUOTE_UNAVAILABLE:'暂时没有通过校验的卖出报价，请稍后重新预览。',MANUAL_CLOSE_SELL_UNKNOWN_NO_RETRY:'卖出提交结果未知，不能确认是否成交，不会重复提交。',
  MANUAL_CLOSE_SELL_PENDING:'卖出已提交，仍在等待成交与链上确认。',MANUAL_CLOSE_SELL_FAILED_NO_RETRY:'平台返回卖出失败或过期，本次请求不会重复提交。',
  MANUAL_CLOSE_BALANCE_CHANGED:'持仓数量发生变化，请重新预览；本次未提交卖单。',MANUAL_CLOSE_PREFLIGHT_CHANGED:'余额或报价发生变化，已暂停提交，请重新预览。',
  MANUAL_CLOSE_NO_BALANCE:'链上当前余额为 0，无需卖出。',MANUAL_CLOSE_CANCEL_PENDING:'保护单撤销尚未核验完成，暂不提交卖单。',
  MANUAL_CLOSE_PROTECTION_TRIGGERED_OR_UNKNOWN:'保护单可能已触发或状态不明，正在等待核实，暂不提交卖单。',
  MANUAL_CLOSE_STRATEGY_CHANGED:'保护单与预览不一致，已暂停操作，请重新预览。',MANUAL_CLOSE_BALANCE_UNVERIFIED:'尚未取得可信的最新余额，暂不提交卖单。',
  MANUAL_CLOSE_PARTIAL_SELL_UNVERIFIED:'已有部分卖出，但历史交易、交易协议或剩余余额尚不能完整核验；暂不提交卖单。',
};
const explain=(reason:string)=>explanations[reason]??`暂无法继续平仓（${reason}）。`;
function units(amount:string,decimals:number){const padded=amount.padStart(decimals+1,'0');return decimals?`${padded.slice(0,-decimals)}.${padded.slice(-decimals)}`.replace(/\.?0+$/,''):amount;}
class CloseError extends Error {constructor(readonly reason:string){super(reason);}}
function fail(reason:string):never {throw new CloseError(reason);}
const identity=(p:ManualClosePosition)=>`${p.chain}:${p.wallet}:${p.tokenAddress}`;
const proof=(p:ManualClosePosition)=>JSON.stringify([p.id,p.chain,p.wallet,p.tokenAddress,p.tokenDecimals,p.openingTransactionHash,p.providerOrderId??null,
  [...(p.strategyOrderIds??[])].sort(),p.protectionExpected!==false,p.openingOutputAmount??null,p.protectionEvidence??null]);
const immutableProof=(p:ManualClosePosition)=>JSON.stringify([p.id,p.chain,p.wallet,p.tokenAddress,p.openingTransactionHash]);

/** Explicit owner confirmations are the only entry point that can send a cancel or sell. */
export class ManualCloseService {
  private readonly db:DatabaseSync;private readonly now:()=>number;private readonly sleep:(ms:number)=>Promise<void>;
  private readonly ttl:number;private readonly attempts:number;private closed=false;private pending=new Set<Promise<unknown>>();
  constructor(path:string,private readonly options:ManualCloseOptions) {
    this.now=options.now??Date.now;this.sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    this.ttl=options.previewTtlMs??120000;this.attempts=options.pollAttempts??3;
    if(!Number.isSafeInteger(this.ttl)||this.ttl<1000||this.ttl>120000||!Number.isInteger(this.attempts)||this.attempts<1||this.attempts>10)
      fail('MANUAL_CLOSE_OPTIONS_INVALID');
    if(!path||path.startsWith('file:'))fail('MANUAL_CLOSE_DATABASE_INVALID');
    if(path!==':memory:'){mkdirSync(dirname(path),{recursive:true,mode:0o700});const fd=openSync(path,'a',0o600);closeSync(fd);chmodSync(path,0o600);}
    this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS manual_close_requests(id TEXT PRIMARY KEY,identity TEXT NOT NULL UNIQUE,state TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manual_close_tokens(hash TEXT PRIMARY KEY,request_id TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS manual_close_operations(request_id TEXT NOT NULL,operation_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(request_id,operation_key));
      CREATE TABLE IF NOT EXISTS manual_close_lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manual_close_events(key TEXT PRIMARY KEY,text TEXT NOT NULL,queued INTEGER NOT NULL DEFAULT 0);`);
  }
  private tx<T>(work:()=>T):T {if(this.closed)fail('MANUAL_CLOSE_CLOSED');this.db.exec('BEGIN IMMEDIATE');try{const r=work();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  private get(requestId:string):Request|undefined {const r=this.db.prepare('SELECT payload FROM manual_close_requests WHERE id=?').get(requestId);return r?JSON.parse(String(r.payload)):undefined;}
  private save(r:Request){r.updatedAt=this.now();this.db.prepare('UPDATE manual_close_requests SET state=?,payload=? WHERE id=?').run(r.state,JSON.stringify(r),r.id);}
  private op(requestId:string,key:string):Operation|undefined {const r=this.db.prepare('SELECT payload FROM manual_close_operations WHERE request_id=? AND operation_key=?').get(requestId,key);return r?JSON.parse(String(r.payload)):undefined;}
  private own(owner:string){const lease=this.db.prepare('SELECT owner,expires_at FROM manual_close_lease WHERE id=1').get();
    if(!lease||lease.owner!==owner||Number(lease.expires_at)<=this.now())fail('MANUAL_CLOSE_LEASE_LOST');}
  private acquire(owner:string){const lease=this.db.prepare('SELECT expires_at FROM manual_close_lease WHERE id=1').get();
    if(lease&&Number(lease.expires_at)>this.now())fail('MANUAL_CLOSE_BUSY');
    this.db.prepare('INSERT INTO manual_close_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(owner,this.now()+60000);}
  private commit(r:Request,owner:string,stage?:string){this.tx(()=>{this.own(owner);this.save(r);if(stage)this.event(r,stage);});this.flush();}
  private event(r:Request,stage:string){const detail=stage==='submitting:sell'?'卖出请求已登记，提交及成交结果待核验。':
    stage.startsWith('submitting:cancel:')?'对应保护单的撤销请求已登记，正在核验结果。':stage==='protection-canceled'?'对应保护单已核验撤销，正在复核余额和卖出报价。':this.summary(r);
    const text=`【手动平仓】${clean(r.position.name??r.position.symbol??r.position.tokenAddress.slice(0,8))} · SOL\n`+
    `${detail}\nCA：${r.position.tokenAddress}\n钱包：${r.position.wallet}`;
    this.db.prepare('INSERT OR IGNORE INTO manual_close_events VALUES (?,?,0)').run(`manual-close:${r.id}:${stage}`,text);}
  private flush(){for(const row of this.db.prepare('SELECT key,text FROM manual_close_events WHERE queued=0 LIMIT 100').all())try{
    this.options.enqueue({key:String(row.key),text:String(row.text)});this.db.prepare('UPDATE manual_close_events SET queued=1 WHERE key=?').run(row.key);
  }catch{break;}}
  private summary(r:Request):string {
    if(r.state==='closed')return `平仓已由 finalized 交易及链上余额为 0 核验。\nhttps://solscan.io/tx/${r.sell!.signature}`;
    if(r.state==='canceled')return '本次平仓预览已取消；未撤销平台保护单，未提交卖单。';
    if(r.state==='executing')return '已接受确认，正在核验保护单、撤单及剩余余额；重复确认不会重发订单。';
    if(r.state==='awaiting_confirmation')return '保护单撤销已核验；尚未提交卖单，请重新预览并确认。';
    if(r.state==='attention')return `平仓尚未确认：${explain(r.reason??'MANUAL_CLOSE_PENDING')}\n`+
      (r.protectionCanceledAt&&!this.op(r.id,'sell')?'保护单已核验撤销，尚未提交卖单；当前剩余持仓没有这些保护单，请重新预览并确认后再继续。\n':'')+
      '结果未知的提交不会重发；后台仅继续查询。';
    return '等待确认；尚未提交撤单或卖单。';
  }
  private reply(r:Request):ManualCloseReply{return {text:this.summary(r),requestId:r.id,state:r.state};}
  private position(positionId:string):ManualClosePosition {
    const matches=this.options.positions().filter(p=>p.id===positionId);if(matches.length!==1)fail('MANUAL_CLOSE_POSITION_UNAVAILABLE');
    const p=structuredClone(matches[0]);if(p.chain!=='solana')fail('MANUAL_CLOSE_CHAIN_UNSUPPORTED');
    if(!base58(p.wallet,32)||!base58(p.tokenAddress,32)||p.tokenAddress===SOL||p.wallet===p.tokenAddress||!base58(p.openingTransactionHash,64)||
      p.tokenDecimals!==undefined&&(!Number.isInteger(p.tokenDecimals)||p.tokenDecimals<0||p.tokenDecimals>255)||p.providerOrderId!==undefined&&!id(p.providerOrderId)||
      p.strategyOrderIds!==undefined&&(!Array.isArray(p.strategyOrderIds)||p.strategyOrderIds.length>20||p.strategyOrderIds.some(s=>!id(s))))fail('MANUAL_CLOSE_POSITION_INVALID');
    return p;
  }
  private current(r:Request){const p=this.position(r.position.id);if(proof(p)!==proof(r.position))fail('MANUAL_CLOSE_IDENTITY_CHANGED');return p;}
  private async balance(p:ManualClosePosition):Promise<SolanaSnapshot>{const b=await this.options.chain.snapshot(p.wallet,p.tokenAddress),t=Date.parse(b.checkedAt);
    if(b.wallet!==p.wallet||b.mint!==p.tokenAddress||p.tokenDecimals!==undefined&&b.decimals!==p.tokenDecimals||
      !Number.isInteger(b.decimals)||b.decimals<0||b.decimals>255||!atom(b.tokenAmount)||!atom(b.nativeLamports)||
      !Number.isSafeInteger(b.slot)||b.slot<0||!Number.isSafeInteger(b.nativeSlot)||b.nativeSlot<0||!Number.isFinite(t)||t>this.now()+1000||this.now()-t>15000)
      fail('MANUAL_CLOSE_BALANCE_UNVERIFIED');return b;}
  async preview(positionId:string):Promise<ManualCloseReply> {
    try {
      const p=this.position(positionId),row=this.db.prepare('SELECT payload FROM manual_close_requests WHERE identity=?').get(identity(p));
      let request:Request|undefined=row?JSON.parse(String(row.payload)):undefined;
      if(request&&(request.state==='closed'||request.state==='executing'||this.op(request.id,'sell')))return this.reply(request);
      const b=await this.balance(p);if(b.tokenAmount==='0')fail('MANUAL_CLOSE_NO_BALANCE');
      const provisional:Request=request??{id:randomUUID(),position:p,identity:identity(p),state:'preview',createdAt:this.now(),updatedAt:this.now(),previewAmount:b.tokenAmount,strategies:[]};
      if(immutableProof(provisional.position)!==immutableProof(p))fail('MANUAL_CLOSE_IDENTITY_CHANGED');
      // A new user preview may refresh trusted receipt metadata after reconciliation.
      // Old confirmations remain invalid and previously journaled operations stay intact.
      provisional.position=p;
      const opening=await this.verifyBuy(p,b.decimals,b.slot),parents=await this.discover(provisional);
      await this.verifyPartialSells(provisional,parents,opening,b);
      const token=randomUUID();
      this.tx(()=>{
        const latest=this.db.prepare('SELECT payload FROM manual_close_requests WHERE identity=?').get(identity(p));request=latest?JSON.parse(String(latest.payload)):undefined;
        if(request&&(request.state==='executing'||request.state==='closed'||this.op(request.id,'sell')))fail('MANUAL_CLOSE_ALREADY_PENDING');
        if(request&&immutableProof(request.position)!==immutableProof(p))fail('MANUAL_CLOSE_IDENTITY_CHANGED');
        request??=provisional;request.strategies=provisional.strategies;request.partialProof=provisional.partialProof;
        request.position=p;
        request.state='preview';request.previewAmount=b.tokenAmount;delete request.reason;
        this.db.prepare('INSERT OR IGNORE INTO manual_close_requests VALUES (?,?,?,?)').run(request.id,request.identity,request.state,JSON.stringify(request));this.save(request);
        this.db.prepare('UPDATE manual_close_tokens SET consumed=1 WHERE request_id=?').run(request.id);
        this.db.prepare('INSERT INTO manual_close_tokens VALUES (?,?,?,0)').run(digest(token),request.id,this.now()+this.ttl);
      });
      return {token,requestId:request!.id,state:'preview',text:`【确认手动平仓】${clean(p.name??p.symbol??p.tokenAddress.slice(0,8))} · SOL\n`+
        `CA：${p.tokenAddress}\n钱包：${p.wallet}\n当前剩余：${units(b.tokenAmount,b.decimals)} ${clean(p.symbol??p.name??'代币')}\n`+
        `将撤销/核验以下保护单：${request!.strategies.map(s=>s.id).join('、')||'无（可信记录明确未附加保护）'}。\n`+
        (request!.strategies.some(s=>s.linkage==='amount_time_match')?'归属依据：钱包、CA、投入与收到数量、精度、时间及所有附加条件唯一匹配；平台未提供关联交易哈希。确认即授权撤销上列保护单。\n':'')+
        (request!.partialProof?`已逐笔核验历史部分卖出 ${request!.partialProof.transactions.length} 笔；本次只关闭链上剩余数量。\n`:'')+
        `卖出确认时仍持有的 100%，最大不超过本次预览数量。滑点上限 1%。\n先核验并撤销本机器人对应的保护单，确认无进行中卖单后再卖出。\n${this.ttl/1000} 秒内确认有效；取消仅作废这次预览。`};
    }catch(e){return {text:explain(e instanceof CloseError?e.reason:'MANUAL_CLOSE_PREVIEW_UNAVAILABLE')};}
  }
  async cancel(token:string):Promise<ManualCloseReply> {
    try{return this.tx(()=>{const row=this.token(token);const r=this.get(String(row.request_id))!;
      if(row.consumed||r.state!=='preview')return this.reply(r);
      this.db.prepare('UPDATE manual_close_tokens SET consumed=1 WHERE request_id=?').run(r.id);r.state='canceled';this.save(r);return this.reply(r);});
    }catch(e){return {text:explain(e instanceof CloseError?e.reason:'MANUAL_CLOSE_CANCEL_UNAVAILABLE')};}
  }
  private token(token:string){if(typeof token!=='string'||!/^[-0-9a-f]{36}$/.test(token))fail('MANUAL_CLOSE_TOKEN_INVALID');
    const row=this.db.prepare('SELECT * FROM manual_close_tokens WHERE hash=?').get(digest(token));if(!row)fail('MANUAL_CLOSE_TOKEN_INVALID');return row;}
  async confirm(token:string):Promise<ManualCloseReply> {
    let owner:string|undefined,r:Request|undefined;
    try {
      const accepted=this.tx(()=>{const row=this.token(token);r=this.get(String(row.request_id));if(!r)fail('MANUAL_CLOSE_TOKEN_INVALID');
        if(row.consumed||r.state!=='preview')return false;if(Number(row.expires_at)<=this.now())fail('MANUAL_CLOSE_TOKEN_EXPIRED');
        owner=randomUUID();this.acquire(owner);this.db.prepare('UPDATE manual_close_tokens SET consumed=1 WHERE request_id=?').run(r.id);
        r.state='executing';this.save(r);this.event(r,'accepted:'+digest(token).slice(0,12));return true;});
      if(!accepted)return this.reply(r!);this.flush();
      const work=this.execute(r!,owner!);this.pending.add(work);try{await work;}finally{this.pending.delete(work);}
      return this.reply(this.get(r!.id)!);
    }catch(e){return {text:explain(e instanceof CloseError?e.reason:'MANUAL_CLOSE_CONFIRM_UNAVAILABLE')};}
  }
  private async pages(p:ManualClosePosition,type:'open'|'history'):Promise<Record<string,unknown>[]> {
    const rows:Record<string,unknown>[]=[],seen=new Set<string>();let pageToken:string|undefined;
    for(let page=0;page<5;page++){
      const raw=await this.options.client.strategies(p.wallet,p.tokenAddress,type,pageToken);
      if(!object(raw)||!Array.isArray(raw.list)||raw.list.length>100||raw.total!==undefined&&(!Number.isSafeInteger(raw.total)||Number(raw.total)<0))fail('MANUAL_CLOSE_STRATEGY_PAGE_INVALID');
      for(const row of raw.list){if(!object(row)||row.chain!=='sol'||row.wallet_address!==p.wallet||row.base_token!==p.tokenAddress||!id(row.order_id)||seen.has(row.order_id))fail('MANUAL_CLOSE_STRATEGY_IDENTITY_INVALID');
        seen.add(row.order_id);rows.push(row);}
      if(raw.next_page_token===undefined||raw.next_page_token===''||raw.next_page_token===null){if(typeof raw.total==='number'&&raw.total>rows.length)fail('MANUAL_CLOSE_STRATEGY_PAGE_INCOMPLETE');return rows;}
      if(typeof raw.next_page_token!=='string'||raw.next_page_token.length>4096||raw.next_page_token===pageToken)fail('MANUAL_CLOSE_STRATEGY_PAGE_INVALID');pageToken=raw.next_page_token;
    }return fail('MANUAL_CLOSE_STRATEGY_PAGE_INCOMPLETE');
  }
  private fingerprint(row:Record<string,unknown>):string {
    if(row.quote_token!==SOL||row.order_type!=='smart_trade'||row.sub_order_type!=='mix_trade'||row.sell_ratio_type!=='hold_amount'||
      !Array.isArray(row.condition_orders)||!row.condition_orders.length||row.condition_orders.length>20)fail('MANUAL_CLOSE_STRATEGY_INVALID');
    const cids=new Set<string>();const values=row.condition_orders.map(c=>{
      if(!object(c)||!id(c.cid)||cids.has(c.cid)||c.side!=='sell'||!['profit_stop','loss_stop'].includes(String(c.order_type))||
        !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(c.price_scale))||Number(c.price_scale)<=0||
        !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(c.sell_ratio))||Number(c.sell_ratio)<=0||Number(c.sell_ratio)>100)fail('MANUAL_CLOSE_STRATEGY_INVALID');
      cids.add(c.cid);return {cid:c.cid,order_type:c.order_type,side:c.side,price_scale:String(c.price_scale),sell_ratio:String(c.sell_ratio)};
    });return digest(JSON.stringify(values.sort((a,b)=>a.cid.localeCompare(b.cid))));
  }
  private settledCount(row:Record<string,unknown>,terminal=false):number {
    const statistic=row.order_statistic,children=row.condition_orders as Record<string,unknown>[];
    const count=object(statistic)?statistic.success_sell_num:undefined;
    if(!Number.isSafeInteger(count)||Number(count)<0||Number(count)>20||
      children.filter(c=>c.status==='success').length!==count||
      !children.every(c=>terminal?['cancel','success'].includes(String(c.status)):['check','running','cancel','success'].includes(String(c.status)))||
      (Number(count)>0&&(!object(statistic)||statistic.sell_num!==count))||
      (count===0&&!!row.close_sign_hash))
      fail('MANUAL_CLOSE_PROTECTION_TRIGGERED_OR_UNKNOWN');
    if(terminal&&(row.status!=='closed'||row.strategy_status!=='stopped'))fail('MANUAL_CLOSE_CANCEL_PENDING');
    return Number(count);
  }
  private checkPartialParents(r:Request,rows:Record<string,unknown>[]) {
    const count=rows.reduce((sum,row)=>sum+this.settledCount(row,row.status==='closed'),0),proofs=r.partialProof?.transactions??[];
    if(count!==proofs.length||rows.some(row=>row.close_sign_hash&&!proofs.some(f=>f.signature===row.close_sign_hash)))
      fail('MANUAL_CLOSE_PARTIAL_SELL_UNVERIFIED');
  }
  private async verifyPartialSells(r:Request,rows:Record<string,unknown>[],opening:VerifiedSolanaTransaction,snapshot:SolanaSnapshot){
    const count=rows.reduce((sum,row)=>sum+this.settledCount(row,row.status==='closed'),0);
    if(!count){if(r.partialProof?.transactions.length)fail('MANUAL_CLOSE_PARTIAL_SELL_UNVERIFIED');return;}
    if(count>20||!this.options.partialSellSignatures)fail('MANUAL_CLOSE_PARTIAL_SELL_UNVERIFIED');
    try {
      const signatures=await this.options.partialSellSignatures(r.position,opening,snapshot);
      if(!Array.isArray(signatures)||signatures.length!==count||new Set(signatures).size!==count||
        signatures.some(s=>!base58(s,64)||s===opening.signature))fail('MANUAL_CLOSE_PARTIAL_SELL_UNVERIFIED');
      const facts:VerifiedSolanaTransaction[]=[];
      for(const signature of signatures){const f=await this.options.chain.verifyTransaction({signature,wallet:r.position.wallet,mint:r.position.tokenAddress,side:'sell'});
        if(f.signature!==signature||f.wallet!==r.position.wallet||f.mint!==r.position.tokenAddress||f.side!=='sell'||f.decimals!==snapshot.decimals||
          !Number.isSafeInteger(f.slot)||f.slot<opening.slot||f.slot>snapshot.slot||!atom(f.preTokenAmount)||!atom(f.postTokenAmount)||
          !/^-[1-9]\d{0,19}$/.test(f.tokenDelta)||!atom(f.tokenDelta.slice(1))||!atom(f.nativeDelta)||f.nativeDelta==='0'||
          BigInt(f.preTokenAmount)-BigInt(f.postTokenAmount)!==-BigInt(f.tokenDelta))fail('MANUAL_CLOSE_PARTIAL_SELL_UNVERIFIED');facts.push(f);}
      let amount=opening.postTokenAmount,slot=opening.slot;const ordered:VerifiedSolanaTransaction[]=[],remaining=[...facts];
      while(remaining.length){const matches=remaining.filter(f=>f.preTokenAmount===amount&&f.slot>=slot);
        if(matches.length!==1)fail('MANUAL_CLOSE_PARTIAL_SELL_UNVERIFIED');const f=matches[0];remaining.splice(remaining.indexOf(f),1);
        amount=f.postTokenAmount;slot=f.slot;ordered.push(f);}
      if(amount!==snapshot.tokenAmount||amount==='0')fail('MANUAL_CLOSE_PARTIAL_SELL_UNVERIFIED');
      await this.sleep(500);const stable=await this.balance(r.position);
      if(stable.tokenAmount!==amount||stable.slot<snapshot.slot||stable.slot<slot)fail('MANUAL_CLOSE_PARTIAL_SELL_UNVERIFIED');
      r.partialProof={transactions:ordered,remainingAmount:amount,decimals:snapshot.decimals};this.checkPartialParents(r,rows);
    }catch{fail('MANUAL_CLOSE_PARTIAL_SELL_UNVERIFIED');}
  }
  private async verifyBuy(p:ManualClosePosition,decimals:number,observedSlot:number){
    const expected=p.openingOutputAmount??p.protectionEvidence?.outputAmount;
    if(expected!==undefined&&(!atom(expected)||expected==='0'))fail('MANUAL_CLOSE_BUY_IDENTITY_UNVERIFIED');
    const fact=await this.options.chain.verifyTransaction({signature:p.openingTransactionHash,wallet:p.wallet,mint:p.tokenAddress,side:'buy',
      ...(expected?{expectedTokenAmount:expected}:{})});
    if(fact.signature!==p.openingTransactionHash||fact.wallet!==p.wallet||fact.mint!==p.tokenAddress||fact.side!=='buy'||fact.decimals!==decimals||
      !Number.isSafeInteger(fact.slot)||fact.slot<1||fact.slot>observedSlot||!atom(fact.tokenDelta)||fact.tokenDelta==='0'||
      expected!==undefined&&fact.tokenDelta!==expected||!atom(fact.preTokenAmount)||!atom(fact.postTokenAmount)||
      BigInt(fact.postTokenAmount)-BigInt(fact.preTokenAmount)!==BigInt(fact.tokenDelta))fail('MANUAL_CLOSE_BUY_IDENTITY_UNVERIFIED');
    return fact;
  }
  private exactOpeningMatch(p:ManualClosePosition,row:Record<string,unknown>):boolean {
    const e=p.protectionEvidence;if(!e||!atom(e.inputAmount)||!atom(e.outputAmount)||e.inputAmount==='0'||e.outputAmount==='0'||
      e.sellRatioType!=='hold_amount'||!Number.isInteger(e.tokenDecimals)||e.tokenDecimals<0||e.tokenDecimals>255||
      !Number.isFinite(Date.parse(e.confirmedAt))||!Array.isArray(e.conditions)||!e.conditions.length)return false;
    const created=typeof row.create_time==='number'?row.create_time:typeof row.create_time==='string'&&/^\d{13,16}$/.test(row.create_time)?Number(row.create_time):NaN;
    if(!Number.isSafeInteger(created)||Math.abs(created-Date.parse(e.confirmedAt))>120000||created>this.now()+5000||
      row.quote_investment!==e.inputAmount||row.open_amount!==e.outputAmount||row.base_decimal!==e.tokenDecimals||row.quote_decimal!==9||
      row.sell_ratio_type!==e.sellRatioType||object(row.order_statistic)&&row.order_statistic.buy_amount!==undefined&&row.order_statistic.buy_amount!==e.outputAmount||
      !Array.isArray(row.condition_orders)||row.condition_orders.length!==e.conditions.length)return false;
    const rules=(items:unknown[])=>items.map(c=>{if(!object(c))return '';return JSON.stringify([c.order_type,c.side,String(c.price_scale),String(c.sell_ratio)]);}).sort();
    return JSON.stringify(rules(row.condition_orders))===JSON.stringify(rules(e.conditions));
  }
  private async discover(r:Request,lockSelection=false):Promise<Record<string,unknown>[]> {
    const p=r.position,known=new Set(p.strategyOrderIds??[]);let buyReportVerified=false;
    if(p.providerOrderId){const raw=await this.options.client.query(p.providerOrderId);
      if(!object(raw)||raw.order_id!==p.providerOrderId||raw.hash!==p.openingTransactionHash)fail('MANUAL_CLOSE_BUY_IDENTITY_UNVERIFIED');
      if(raw.report!==undefined&&(!object(raw.report)||raw.report.input_token!==SOL||raw.report.output_token!==p.tokenAddress||
        p.openingOutputAmount!==undefined&&raw.report.output_amount!==p.openingOutputAmount||
        p.tokenDecimals!==undefined&&raw.report.output_token_decimals!==undefined&&raw.report.output_token_decimals!==p.tokenDecimals))
        fail('MANUAL_CLOSE_BUY_IDENTITY_UNVERIFIED');
      if(id(raw.strategy_order_id)){
        if(known.size&&!known.has(raw.strategy_order_id))fail('MANUAL_CLOSE_STRATEGY_OWNERSHIP_UNVERIFIED');known.add(raw.strategy_order_id);
      }
      const e=p.protectionEvidence,report=raw.report;
      buyReportVerified=!!e&&object(report)&&report.input_token===SOL&&report.output_token===p.tokenAddress&&report.input_amount===e.inputAmount&&
        report.output_amount===e.outputAmount&&report.input_token_decimals===9&&report.output_token_decimals===e.tokenDecimals&&
        (raw.status==='confirmed'&&(raw.state===undefined||raw.state===30)||raw.status==='successful'&&raw.state===30);
    }
    const open=await this.pages(p,'open'),history=await this.pages(p,'history');
    const all=[...open,...history];let owned=all.filter(row=>known.has(String(row.order_id))||row.open_sign_hash===p.openingTransactionHash);
    let fallback=false;
    if(!owned.length&&!known.size&&buyReportVerified){
      const matches=all.filter(row=>!row.open_sign_hash&&this.exactOpeningMatch(p,row));
      if(matches.length>1)fail('MANUAL_CLOSE_STRATEGY_AMBIGUOUS');if(matches.length===1){owned=matches;fallback=true;}
    }
    if(open.some(row=>!owned.includes(row)))fail('MANUAL_CLOSE_FOREIGN_STRATEGY');
    if(known.size&&[...known].some(key=>!owned.some(row=>row.order_id===key)))fail('MANUAL_CLOSE_STRATEGY_NOT_OBSERVED');
    if(!owned.length&&p.protectionExpected!==false)fail('MANUAL_CLOSE_STRATEGY_OWNERSHIP_UNVERIFIED');
    if(new Set(owned.map(row=>row.order_id)).size!==owned.length)fail('MANUAL_CLOSE_STRATEGY_AMBIGUOUS');
    const strategies=owned.map(row=>{
      if(row.open_sign_hash&&row.open_sign_hash!==p.openingTransactionHash)fail('MANUAL_CLOSE_STRATEGY_OWNERSHIP_UNVERIFIED');
      const fingerprint=this.fingerprint(row);this.settledCount(row,!open.includes(row));
      const previous=r.strategies.find(s=>s.id===row.order_id);if(previous&&previous.fingerprint!==fingerprint)fail('MANUAL_CLOSE_STRATEGY_CHANGED');
      const linkage=fallback?'amount_time_match' as const:row.open_sign_hash===p.openingTransactionHash?'transaction_hash' as const:'saved_strategy_id' as const;
      return {id:String(row.order_id),fingerprint,linkage};});
    if(r.strategies.some(s=>!strategies.some(next=>next.id===s.id)))fail('MANUAL_CLOSE_STRATEGY_NOT_OBSERVED');
    if(lockSelection&&(r.strategies.length!==strategies.length||r.strategies.some(s=>!strategies.some(next=>next.id===s.id&&next.fingerprint===s.fingerprint&&next.linkage===s.linkage))))
      fail('MANUAL_CLOSE_STRATEGY_CHANGED');
    r.strategies=strategies;return owned;
  }
  private async verifyCanceled(r:Request):Promise<void>{
    if((await this.pages(r.position,'open')).length)fail('MANUAL_CLOSE_CANCEL_PENDING');
    const history=await this.pages(r.position,'history');
    const owned:Record<string,unknown>[]=[];
    for(const saved of r.strategies){const matches=history.filter(row=>row.order_id===saved.id);if(matches.length!==1)fail('MANUAL_CLOSE_CANCEL_PENDING');
      const row=matches[0];if(row.open_sign_hash&&row.open_sign_hash!==r.position.openingTransactionHash||this.fingerprint(row)!==saved.fingerprint)fail('MANUAL_CLOSE_STRATEGY_CHANGED');this.settledCount(row,true);owned.push(row);}
    this.checkPartialParents(r,owned);
  }
  private async submit(r:Request,key:string,body:Record<string,unknown>,owner:string):Promise<Operation>{
    const op=this.tx(()=>{this.own(owner);const old=this.op(r.id,key);if(old)return undefined;
      const value:Operation={key,clientId:randomUUID(),body:structuredClone(body),state:'submitting'};
      this.db.prepare('INSERT INTO manual_close_operations VALUES (?,?,?)').run(r.id,key,JSON.stringify(value));this.event(r,'submitting:'+key);return value;});
    this.flush();if(!op)return this.op(r.id,key)!;
    try {this.own(owner);op.response=key==='sell'?await this.options.client.swap(body,op.clientId):await this.options.client.cancel(r.position.wallet,String(body.order_id),op.clientId);op.state='acknowledged';}
    catch{op.state='unknown';}
    this.tx(()=>{this.own(owner);this.db.prepare('UPDATE manual_close_operations SET payload=? WHERE request_id=? AND operation_key=?').run(JSON.stringify(op),r.id,key);});return op;
  }
  private async confirmSell(r:Request,owner:string):Promise<void>{
    const op=this.op(r.id,'sell');if(!op||!object(op.response)||!id(op.response.order_id))fail('MANUAL_CLOSE_SELL_UNKNOWN_NO_RETRY');
    const raw=await this.options.client.query(op.response.order_id);this.own(owner);
    if(!object(raw)||raw.order_id!==op.response.order_id)fail('MANUAL_CLOSE_SELL_IDENTITY_UNVERIFIED');
    if(['failed','expired'].includes(String(raw.status))&&raw.state!==30)fail('MANUAL_CLOSE_SELL_FAILED_NO_RETRY');
    const report=raw.report,confirmed=raw.status==='confirmed'&&(raw.state===undefined||raw.state===30)||raw.status==='successful'&&raw.state===30;
    if(!confirmed||!base58(raw.hash,64))fail('MANUAL_CLOSE_SELL_PENDING');
    if(!object(report)||report.input_token!==r.position.tokenAddress||report.output_token!==SOL||report.input_amount!==op.body.input_amount||
      !atom(report.output_amount)||BigInt(report.output_amount)<BigInt(String(op.body.min_output_amount)))fail('MANUAL_CLOSE_RECEIPT_UNVERIFIED');
    const fact=await this.options.chain.verifyTransaction({signature:String(raw.hash),wallet:r.position.wallet,mint:r.position.tokenAddress,side:'sell',
      expectedTokenAmount:String(op.body.input_amount),maxNativeDebitLamports:'1000000'});this.own(owner);
    if(fact.signature!==raw.hash||fact.wallet!==r.position.wallet||fact.mint!==r.position.tokenAddress||fact.side!=='sell'||
      fact.decimals!==r.beforeSell?.decimals||fact.tokenDelta!=='-'+op.body.input_amount||fact.preTokenAmount!==op.body.input_amount||fact.postTokenAmount!=='0'||
      !Number.isSafeInteger(fact.slot)||!r.beforeSell||fact.slot<r.beforeSell.slot)fail('MANUAL_CLOSE_CHAIN_RECEIPT_UNVERIFIED');
    const final=await this.balance(r.position);if(final.tokenAmount!=='0'||final.slot<fact.slot||final.nativeSlot<fact.slot)fail('MANUAL_CLOSE_FINAL_BALANCE_UNVERIFIED');
    await this.verifyCanceled(r);r.sell=fact;r.finalSnapshot=final;r.state='closed';delete r.reason;this.commit(r,owner,'closed');
  }
  private async execute(r:Request,owner:string):Promise<void> {
    const heartbeat=setInterval(()=>{try{this.tx(()=>{this.own(owner);this.db.prepare('UPDATE manual_close_lease SET expires_at=? WHERE id=1 AND owner=?').run(this.now()+60000,owner);});}catch{}},10000);heartbeat.unref();
    try {
      const p=this.current(r),initial=await this.balance(p);this.own(owner);
      if(initial.tokenAmount==='0'||BigInt(initial.tokenAmount)>BigInt(r.previewAmount))fail('MANUAL_CLOSE_BALANCE_CHANGED');
      if(BigInt(initial.nativeLamports)<1000000n)fail('MANUAL_CLOSE_GAS_BALANCE_LOW');
      const opening=await this.verifyBuy(p,initial.decimals,initial.slot);
      const parents=await this.discover(r,true);await this.verifyPartialSells(r,parents,opening,initial);this.commit(r,owner);
      for(const row of parents.filter(row=>row.status==='open')){this.own(owner);await this.submit(r,'cancel:'+row.order_id,{chain:'sol',from_address:p.wallet,order_id:row.order_id},owner);}
      await this.poll(()=>this.verifyCanceled(r));r.protectionCanceledAt=this.now();this.commit(r,owner,'protection-canceled');
      const first=await this.balance(p);await this.sleep(500);const second=await this.balance(p);
      if(first.tokenAmount!==second.tokenAmount||first.tokenAmount==='0'||BigInt(second.tokenAmount)>BigInt(r.previewAmount)||second.slot<first.slot||
        r.partialProof&&second.tokenAmount!==r.partialProof.remainingAmount)fail('MANUAL_CLOSE_BALANCE_CHANGED');
      const quotedAt=this.now(),raw=await this.options.client.quote({wallet:p.wallet,inputToken:p.tokenAddress,outputToken:SOL,inputAmount:second.tokenAmount,slippagePct:1});
      const quote=inspectTestQuote(raw,{input:p.tokenAddress,output:SOL,amount:second.tokenAmount,slippage:1});if(quote.status!=='available')fail('MANUAL_CLOSE_QUOTE_UNAVAILABLE');
      await this.verifyCanceled(r);this.current(r);const fresh=await this.balance(p);this.own(owner);
      if(fresh.tokenAmount!==second.tokenAmount||fresh.slot<second.slot||BigInt(fresh.nativeLamports)<1000000n||this.now()-quotedAt>15000)fail('MANUAL_CLOSE_PREFLIGHT_CHANGED');
      r.beforeSell=fresh;this.commit(r,owner);
      await this.submit(r,'sell',{chain:'sol',from_address:p.wallet,input_token:p.tokenAddress,output_token:SOL,input_amount:fresh.tokenAmount,
        swap_mode:'ExactIn',min_output_amount:quote.minimumOutputAmount,slippage:1,priority_fee:'0.00001',tip_fee:'0.00001',is_anti_mev:true},owner);
      await this.poll(()=>this.confirmSell(r,owner));
    }catch(e){try{r.state='attention';r.reason=e instanceof CloseError?e.reason:'MANUAL_CLOSE_READ_OR_STORAGE_UNAVAILABLE';this.commit(r,owner,'attention:'+r.reason);}catch{}}
    finally{clearInterval(heartbeat);try{this.tx(()=>{this.own(owner);this.db.prepare('DELETE FROM manual_close_lease WHERE id=1 AND owner=?').run(owner);});}catch{}}
  }
  private async poll(work:()=>Promise<void>){let error:unknown;for(let i=0;i<this.attempts;i++)try{await work();return;}catch(e){error=e;if(i+1<this.attempts)await this.sleep(1000);}throw error;}
  /** Recovery performs provider/RPC reads only, even after a crash between cancellation and sale. */
  async resume(options:{onlySubmittedSells?:boolean}={}):Promise<void> {
    if(this.closed)return;
    for(const row of this.db.prepare("SELECT payload FROM manual_close_requests WHERE state IN ('executing','attention')").all()){
      const r=JSON.parse(String(row.payload)) as Request,owner=randomUUID();
      if(options.onlySubmittedSells&&!this.op(r.id,'sell'))continue;
      try{this.tx(()=>this.acquire(owner));}catch{break;}
      try {
        if(this.op(r.id,'sell'))await this.confirmSell(r,owner);
        else {await this.verifyCanceled(r);r.protectionCanceledAt=this.now();r.state='awaiting_confirmation';delete r.reason;this.commit(r,owner,'awaiting-confirmation');}
      }catch(e){try{r.state='attention';r.reason=e instanceof CloseError?e.reason:'MANUAL_CLOSE_RECOVERY_PENDING';this.commit(r,owner,'attention:'+r.reason);}catch{}}
      finally{try{this.tx(()=>{this.own(owner);this.db.prepare('DELETE FROM manual_close_lease WHERE id=1 AND owner=?').run(owner);});}catch{}}
    }this.flush();
  }
  status(){return {supportedChains:['solana'],requests:this.db.prepare('SELECT payload FROM manual_close_requests ORDER BY rowid DESC LIMIT 100').all().map(row=>{
    const r=JSON.parse(String(row.payload)) as Request;return {id:r.id,positionId:r.position.id,state:r.state,reason:r.reason,updatedAt:r.updatedAt};})};}
  isClosed(positionId:string):boolean{return !!this.db.prepare("SELECT 1 FROM manual_close_requests WHERE state='closed' AND json_extract(payload,'$.position.id')=? LIMIT 1").get(positionId);}
  hasPendingSale(positionId:string):boolean{return !!this.db.prepare(`SELECT 1 FROM manual_close_requests r
    JOIN manual_close_operations o ON o.request_id=r.id AND o.operation_key='sell'
    WHERE r.state<>'closed' AND json_extract(r.payload,'$.position.id')=? LIMIT 1`).get(positionId);}
  async stop(){await Promise.allSettled([...this.pending]);}
  close(){if(!this.closed){if(this.pending.size)fail('MANUAL_CLOSE_WORK_IN_PROGRESS');this.db.close();this.closed=true;}}
}
