import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdirSync,openSync,closeSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import bs58 from 'bs58';
import type {ManualClosePosition,ManualCloseReply} from './manual-close.js';
import type {TestTradeClient,TestChainReader,SolanaSnapshot,VerifiedSolanaTransaction} from './controlled-test/types.js';
import {inspectTestQuote} from './trade-interface-check.js';

/** Whole percentage of the latest verified token balance, inclusive 1..100. */
export type SellPercentage=number;
export const validSellPercentage=(value:unknown):value is SellPercentage=>
  typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=100;
export interface DirectSellOptions {
  positions:()=>ManualClosePosition[];client:TestTradeClient;chain:TestChainReader;
  enqueue:(event:{key:string;text:string})=>boolean;now?:()=>number;sleep?:(ms:number)=>Promise<void>;
  slippagePct?:number;gasReserveLamports?:string;pollAttempts?:number;actionTtlMs?:number;
  isLegacySalePending?:(positionId:string)=>boolean;
}
export interface DirectSellClosureEvidence {
  positionId:string;requestId:string;percentage:SellPercentage;amount:string;
  sell:VerifiedSolanaTransaction;finalSnapshot:SolanaSnapshot;
}
type State='accepted'|'executing'|'submitting'|'pending'|'unknown'|'failed'|'completed'|'closed';
interface Sale {
  id:string;identity:string;position:ManualClosePosition;percentage:SellPercentage;state:State;
  createdAt:number;updatedAt:number;reason?:string;beforeSell?:SolanaSnapshot;
  amount?:string;body?:Record<string,unknown>;clientId?:string;response?:unknown;
  providerConfirmed?:{orderId:string;hash:string;outputAmount:string;checkedAt:string};
  sell?:VerifiedSolanaTransaction;finalSnapshot?:SolanaSnapshot;
}
const SOL='So11111111111111111111111111111111111111112';
const ACTIVE="'accepted','executing','submitting','pending','unknown'";
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const atomic=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d{0,19})$/.test(v)&&BigInt(v)<=(1n<<64n)-1n;
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
const base58=(v:unknown,size:number)=>{try{return typeof v==='string'&&bs58.decode(v).length===size&&bs58.encode(bs58.decode(v))===v;}catch{return false;}};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const identity=(p:ManualClosePosition)=>`${p.chain}:${p.wallet}:${p.tokenAddress}`;
const clean=(v:string)=>v.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,100);
const messages:Record<string,string>={
  DIRECT_SELL_ACTION_INVALID:'卖出按钮已失效，请刷新持仓列表。',DIRECT_SELL_ACTION_EXPIRED:'卖出按钮已过期，请刷新持仓列表。',
  DIRECT_SELL_POSITION_UNAVAILABLE:'这笔持仓当前不可用，请刷新持仓列表。',DIRECT_SELL_CHAIN_UNSUPPORTED:'当前仅支持 SOL 持仓卖出。',
    DIRECT_SELL_PERCENTAGE_INVALID:'卖出比例必须是 1% 至 100% 的整数。',DIRECT_SELL_POSITION_INVALID:'持仓地址无效，未提交卖单。',
  DIRECT_SELL_IDENTITY_CHANGED:'持仓地址已改变，未提交卖单，请刷新持仓列表。',DIRECT_SELL_BUSY:'这笔持仓已有卖出请求正在处理，不会重复提交。',
  DIRECT_SELL_CLOSED:'这笔持仓已核验清仓。',DIRECT_SELL_NO_BALANCE:'链上持仓余额为 0，未提交卖单。',
  DIRECT_SELL_DUST:'按所选比例计算的卖出数量小于最小单位，未提交卖单。',DIRECT_SELL_BALANCE_UNVERIFIED:'暂未取得最新链上余额，未提交卖单。',
  DIRECT_SELL_GAS_BALANCE_LOW:'SOL 手续费余额不足，未提交卖单。',DIRECT_SELL_QUOTE_UNAVAILABLE:'暂时没有有效卖出报价，未提交卖单。',
  DIRECT_SELL_BALANCE_CHANGED:'持仓在报价期间连续变化，本次未提交卖单，请刷新后重试。',DIRECT_SELL_QUOTE_STALE:'报价已过期，未提交卖单。',
  DIRECT_SELL_STOPPED:'服务正在重启，本次尚未提交卖单，请刷新后重试。',DIRECT_SELL_INTERRUPTED_BEFORE_SUBMIT:'服务重启前未提交卖单，请刷新后重试。',
  DIRECT_SELL_UNKNOWN:'卖出提交结果未知，不会重复提交；后台仅继续查询。',DIRECT_SELL_PENDING:'卖单已提交，正在等待平台与链上确认。',
  DIRECT_SELL_PROVIDER_FAILED:'平台返回卖出失败或过期，本次不会自动重试。',DIRECT_SELL_RECEIPT_UNVERIFIED:'卖单回执尚未核验，后台继续查询，不重复提交。',
  DIRECT_SELL_CHAIN_RECEIPT_UNVERIFIED:'链上成交尚未核验，后台继续查询，不重复提交。',DIRECT_SELL_FINAL_BALANCE_UNVERIFIED:'成交后的持仓余额尚未核验，后台继续查询。',
  DIRECT_SELL_READ_UNAVAILABLE:'行情或链上读取失败，本次尚未提交卖单。',DIRECT_SELL_RECOVERY_PENDING:'卖单状态查询暂不可用，后台继续查询。',
};
class SellError extends Error {constructor(readonly reason:string){super(reason);}}
function fail(reason:string):never {throw new SellError(reason);}
const explain=(reason:string)=>messages[reason]??'暂无法处理这次卖出，请刷新持仓列表。';
export function sellAtomicAmount(balance:string,percentage:SellPercentage):string {
  if(!atomic(balance)||!validSellPercentage(percentage))fail('DIRECT_SELL_PERCENTAGE_INVALID');
  return (BigInt(balance)*BigInt(percentage)/100n).toString();
}
export function formatTokenUnits(amount:string,decimals:number):string {
  if(!atomic(amount)||!Number.isInteger(decimals)||decimals<0||decimals>255)throw Error('DIRECT_SELL_UNITS_INVALID');
  if(decimals===0)return amount;
  const text=amount.padStart(decimals+1,'0'),fraction=text.slice(-decimals).replace(/0+$/,'');
  return text.slice(0,-decimals)+(fraction?'.'+fraction:'');
}

/** Owner button actions authorize one direct swap. Protection orders are never queried or changed here. */
export class DirectSellService {
  private readonly db:DatabaseSync;private readonly now:()=>number;private readonly sleep:(ms:number)=>Promise<void>;
  private readonly slippage:number;private readonly gas:bigint;private readonly attempts:number;private readonly ttl:number;
  private readonly pending=new Set<Promise<unknown>>();private stopping=false;private closed=false;
  constructor(path:string,private readonly options:DirectSellOptions){
    this.now=options.now??Date.now;this.sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    this.slippage=options.slippagePct??5;this.attempts=options.pollAttempts??3;this.ttl=options.actionTtlMs??86400000;
    const gas=options.gasReserveLamports??'1000000';
    if(!Number.isInteger(this.slippage)||this.slippage<0||this.slippage>50||!atomic(gas)||!Number.isInteger(this.attempts)||this.attempts<1||this.attempts>10||
      !Number.isSafeInteger(this.ttl)||this.ttl<1000||this.ttl>86400000||!path||path.startsWith('file:'))throw Error('DIRECT_SELL_OPTIONS_INVALID');
    this.gas=BigInt(gas);
    if(path!==':memory:'){mkdirSync(dirname(path),{recursive:true,mode:0o700});const fd=openSync(path,'a',0o600);closeSync(fd);chmodSync(path,0o600);}
    this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS direct_sell_actions(hash TEXT PRIMARY KEY,position_id TEXT NOT NULL,identity TEXT NOT NULL,expires_at INTEGER NOT NULL,request_id TEXT);
      CREATE TABLE IF NOT EXISTS direct_sell_requests(id TEXT PRIMARY KEY,identity TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS direct_sell_active_identity ON direct_sell_requests(identity) WHERE state IN (${ACTIVE});
      CREATE TABLE IF NOT EXISTS direct_sell_leases(request_id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS direct_sell_events(key TEXT PRIMARY KEY,text TEXT NOT NULL,queued INTEGER NOT NULL DEFAULT 0);`);
  }
  private tx<T>(fn:()=>T):T {if(this.closed)throw Error('DIRECT_SELL_CLOSED_DATABASE');this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  private get(requestId:string):Sale|undefined {const r=this.db.prepare('SELECT payload FROM direct_sell_requests WHERE id=?').get(requestId);return r?JSON.parse(String(r.payload)):undefined;}
  private save(r:Sale){r.updatedAt=this.now();this.db.prepare('UPDATE direct_sell_requests SET state=?,payload=? WHERE id=?').run(r.state,JSON.stringify(r),r.id);}
  private acquire(requestId:string,owner:string){const old=this.db.prepare('SELECT expires_at FROM direct_sell_leases WHERE request_id=?').get(requestId);
    if(old&&Number(old.expires_at)>this.now())fail('DIRECT_SELL_BUSY');
    this.db.prepare('INSERT INTO direct_sell_leases VALUES(?,?,?) ON CONFLICT(request_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(requestId,owner,this.now()+60000);}
  private own(requestId:string,owner:string){const row=this.db.prepare('SELECT owner,expires_at FROM direct_sell_leases WHERE request_id=?').get(requestId);
    if(!row||row.owner!==owner||Number(row.expires_at)<=this.now())fail('DIRECT_SELL_LEASE_LOST');}
  private commit(r:Sale,owner:string,stage?:string){this.tx(()=>{this.own(r.id,owner);this.save(r);if(stage)this.event(r,stage);});this.flush();}
  private summary(r:Sale):string {
    if(r.state==='accepted'||r.state==='executing')return `已接受卖出 ${r.percentage}% 的请求，正在读取当前持仓与报价。`;
    if(r.state==='submitting')return `正在提交 ${r.percentage}% 卖出，等待平台受理。`;
    if(r.state==='closed'||r.state==='completed')return `${r.state==='closed'?'✅ 已清仓':'✅ 卖出已成交'} · ${r.percentage}%\n`+
      `成交数量：${formatTokenUnits(r.amount!,r.beforeSell!.decimals)} ${clean(r.position.symbol??r.position.name??'代币')}\n`+
      `当前剩余：${formatTokenUnits(r.finalSnapshot!.tokenAmount,r.finalSnapshot!.decimals)}\nhttps://solscan.io/tx/${r.sell!.signature}`;
    if(r.clientId&&r.state==='pending'){
      const receipt=r.providerConfirmed,providerId=receipt?.orderId??(object(r.response)?r.response.order_id:undefined);
      return `⏳ 卖出 ${r.percentage}% ${receipt?'平台已确认，正在核验链上成交与剩余持仓':'已提交，正在核验成交与剩余持仓'}。\n`+
        '后台会继续查询，不会重复提交。'+
        (identifier(providerId)?`\nGMGN 单号：${providerId}`:'')+(receipt&&base58(receipt.hash,64)?`\nhttps://solscan.io/tx/${receipt.hash}`:'');
    }
    if(r.clientId&&r.state==='unknown')return `⏳ 卖出 ${r.percentage}% 的提交结果待核实，不会重复提交；后台仅继续查询。`;
    return explain(r.reason??(r.state==='pending'?'DIRECT_SELL_PENDING':'DIRECT_SELL_UNKNOWN'));
  }
  private heading(r:Sale){return `${clean(r.position.name??r.position.symbol??r.position.tokenAddress.slice(0,8))} · ${r.percentage}% · #${r.id.slice(0,8)}`;}
  private reply(r:Sale):ManualCloseReply{return {text:this.heading(r)+'\n'+this.summary(r),requestId:r.id,state:r.state};}
  private event(r:Sale,stage:string){const text=`【持仓卖出】${this.heading(r)} · SOL\n`+
    `${this.summary(r)}\nCA：${r.position.tokenAddress}`;
    this.db.prepare('INSERT OR IGNORE INTO direct_sell_events VALUES(?,?,0)').run(`direct-sell:${r.id}:${stage}`,text);}
  private flush(){if(this.closed)return;for(const row of this.db.prepare('SELECT key,text FROM direct_sell_events WHERE queued=0 LIMIT 100').all())try{
    this.options.enqueue({key:String(row.key),text:String(row.text)});this.db.prepare('UPDATE direct_sell_events SET queued=1 WHERE key=?').run(row.key);
  }catch{break;}}
  private position(positionId:string):ManualClosePosition {
    const matches=this.options.positions().filter(p=>p.id===positionId);if(matches.length!==1)fail('DIRECT_SELL_POSITION_UNAVAILABLE');
    const p=structuredClone(matches[0]);if(p.chain!=='solana')fail('DIRECT_SELL_CHAIN_UNSUPPORTED');
    if(!base58(p.wallet,32)||!base58(p.tokenAddress,32)||p.wallet===p.tokenAddress||p.tokenAddress===SOL||
      p.tokenDecimals!==undefined&&(!Number.isInteger(p.tokenDecimals)||p.tokenDecimals<0||p.tokenDecimals>255))fail('DIRECT_SELL_POSITION_INVALID');
    return p;
  }
  private current(r:Sale){const p=this.position(r.position.id);if(identity(p)!==r.identity)fail('DIRECT_SELL_IDENTITY_CHANGED');return p;}
  createAction(positionId:string):string {
    if(this.stopping)fail('DIRECT_SELL_STOPPED');const p=this.position(positionId),ref=randomBytes(16).toString('hex');
    if(this.db.prepare("SELECT 1 FROM direct_sell_requests WHERE identity=? AND state='closed'").get(identity(p)))fail('DIRECT_SELL_CLOSED');
    this.db.prepare('INSERT INTO direct_sell_actions VALUES(?,?,?,?,NULL)').run(hash(ref),p.id,identity(p),this.now()+this.ttl);return ref;
  }
  async submit(actionRef:string,percentage:SellPercentage):Promise<ManualCloseReply> {
    try {
      if(this.stopping)fail('DIRECT_SELL_STOPPED');if(!validSellPercentage(percentage))fail('DIRECT_SELL_PERCENTAGE_INVALID');
      if(typeof actionRef!=='string'||!/^[a-f0-9]{32}$/.test(actionRef))fail('DIRECT_SELL_ACTION_INVALID');
      const owner=randomUUID();let accepted=false;
      const r=this.tx(()=>{
        const action=this.db.prepare('SELECT * FROM direct_sell_actions WHERE hash=?').get(hash(actionRef));if(!action)fail('DIRECT_SELL_ACTION_INVALID');
        if(action.request_id){const old=this.get(String(action.request_id));if(!old)fail('DIRECT_SELL_ACTION_INVALID');return old;}
        if(Number(action.expires_at)<=this.now())fail('DIRECT_SELL_ACTION_EXPIRED');
        const p=this.position(String(action.position_id));if(identity(p)!==action.identity)fail('DIRECT_SELL_IDENTITY_CHANGED');
        if(this.options.isLegacySalePending?.(p.id))fail('DIRECT_SELL_BUSY');
        if(this.db.prepare("SELECT 1 FROM direct_sell_requests WHERE identity=? AND state='closed'").get(identity(p)))fail('DIRECT_SELL_CLOSED');
        const busy=this.db.prepare(`SELECT payload FROM direct_sell_requests WHERE identity=? AND state IN (${ACTIVE})`).get(identity(p));
        if(busy){const old=JSON.parse(String(busy.payload)) as Sale;this.db.prepare('UPDATE direct_sell_actions SET request_id=? WHERE hash=?').run(old.id,hash(actionRef));return old;}
        const value:Sale={id:randomUUID(),identity:identity(p),position:p,percentage,state:'accepted',createdAt:this.now(),updatedAt:this.now()};
        this.db.prepare('INSERT INTO direct_sell_requests VALUES(?,?,?,?)').run(value.id,value.identity,value.state,JSON.stringify(value));
        this.db.prepare('UPDATE direct_sell_actions SET request_id=? WHERE hash=?').run(value.id,hash(actionRef));this.acquire(value.id,owner);accepted=true;return value;
      });
      const reply=accepted?this.reply(r):{...this.reply(r),text:
        this.heading(r)+'\n'+(['accepted','executing','submitting','pending','unknown'].includes(r.state)?
          `上一笔 ${r.percentage}% 卖出正在确认，本次 ${percentage}% 未提交。\n请等待确认后刷新持仓。`:
          `这组按钮对应的 ${r.percentage}% 卖出请求已处理，本次 ${percentage}% 未提交。\n请刷新持仓获取新的卖出按钮。\n${this.summary(r)}`)};
      if(accepted)this.track(this.execute(r,owner));return reply;
    }catch(e){return {text:explain(e instanceof SellError?e.reason:'DIRECT_SELL_READ_UNAVAILABLE')};}
  }
  private track<T>(work:Promise<T>){this.pending.add(work);void work.finally(()=>this.pending.delete(work)).catch(()=>{});}
  private async balance(p:ManualClosePosition):Promise<SolanaSnapshot>{const b=await this.options.chain.snapshot(p.wallet,p.tokenAddress),at=Date.parse(b.checkedAt);
    if(b.wallet!==p.wallet||b.mint!==p.tokenAddress||p.tokenDecimals!==undefined&&b.decimals!==p.tokenDecimals||
      !Number.isInteger(b.decimals)||b.decimals<0||b.decimals>255||!atomic(b.tokenAmount)||!atomic(b.nativeLamports)||
      !Number.isSafeInteger(b.slot)||b.slot<0||!Number.isSafeInteger(b.nativeSlot)||b.nativeSlot<0||!Number.isFinite(at)||at>this.now()+1000||this.now()-at>15000)
      fail('DIRECT_SELL_BALANCE_UNVERIFIED');return b;}
  private heartbeat(r:Sale,owner:string){const timer=setInterval(()=>{try{this.tx(()=>{this.own(r.id,owner);this.db.prepare('UPDATE direct_sell_leases SET expires_at=? WHERE request_id=? AND owner=?').run(this.now()+60000,r.id,owner);});}catch{}},10000);timer.unref();return timer;}
  private release(r:Sale,owner:string){try{this.tx(()=>this.db.prepare('DELETE FROM direct_sell_leases WHERE request_id=? AND owner=?').run(r.id,owner));}catch{}}
  private async execute(r:Sale,owner:string):Promise<void>{
    const timer=this.heartbeat(r,owner);
    try {
      if(this.stopping)fail('DIRECT_SELL_STOPPED');r.state='executing';this.commit(r,owner);
      const p=this.current(r);let snapshot=await this.balance(p),body:Record<string,unknown>|undefined;
      for(let attempt=0;attempt<2;attempt++){
        if(snapshot.tokenAmount==='0')fail('DIRECT_SELL_NO_BALANCE');if(BigInt(snapshot.nativeLamports)<this.gas)fail('DIRECT_SELL_GAS_BALANCE_LOW');
        const amount=sellAtomicAmount(snapshot.tokenAmount,r.percentage);if(amount==='0')fail('DIRECT_SELL_DUST');
        const quotedAt=this.now(),raw=await this.options.client.quote({wallet:p.wallet,inputToken:p.tokenAddress,outputToken:SOL,inputAmount:amount,slippagePct:this.slippage});
        const quote=inspectTestQuote(raw,{input:p.tokenAddress,output:SOL,amount,slippage:this.slippage});if(quote.status!=='available')fail('DIRECT_SELL_QUOTE_UNAVAILABLE');
        this.current(r);const fresh=await this.balance(p);this.own(r.id,owner);if(this.stopping)fail('DIRECT_SELL_STOPPED');
        if(this.options.isLegacySalePending?.(p.id))fail('DIRECT_SELL_BUSY');
        if(fresh.decimals!==snapshot.decimals||fresh.slot<snapshot.slot||fresh.nativeSlot<snapshot.nativeSlot)fail('DIRECT_SELL_BALANCE_UNVERIFIED');
        if(fresh.tokenAmount!==snapshot.tokenAmount){if(attempt===1)fail('DIRECT_SELL_BALANCE_CHANGED');snapshot=fresh;continue;}
        if(BigInt(fresh.nativeLamports)<this.gas)fail('DIRECT_SELL_GAS_BALANCE_LOW');if(this.now()-quotedAt>15000)fail('DIRECT_SELL_QUOTE_STALE');
        r.beforeSell=fresh;r.amount=amount;
        body={chain:'sol',from_address:p.wallet,input_token:p.tokenAddress,output_token:SOL,input_amount:amount,swap_mode:'ExactIn',
          min_output_amount:quote.minimumOutputAmount,slippage:this.slippage,priority_fee:'0.00001',tip_fee:'0.00001',is_anti_mev:true};break;
      }
      if(!body)fail('DIRECT_SELL_BALANCE_CHANGED');
      // This durable transition precedes the only financial POST. Recovery never replays it.
      r.body=body;r.clientId=randomUUID();r.state='submitting';this.commit(r,owner);
      try {r.response=await this.options.client.swap(body,r.clientId);r.state=object(r.response)&&identifier(r.response.order_id)?'pending':'unknown';}
      catch {r.state='unknown';}
      r.reason=r.state==='unknown'?'DIRECT_SELL_UNKNOWN':'DIRECT_SELL_PENDING';this.commit(r,owner,r.state==='unknown'?'awaiting':undefined);
      if(r.state==='unknown')return;
      await this.poll(()=>this.reconcile(r,owner));
    }catch(e){this.failure(r,owner,e);}
    finally{clearInterval(timer);this.release(r,owner);}
  }
  private failure(r:Sale,owner:string,e:unknown){try{
    const diagnostic=object(e)&&typeof e.reason==='string'&&/^(?:TEST_SOLANA|GMGN_TEST)_[A-Z0-9_]{1,90}$/.test(e.reason)?e.reason:undefined;
    r.reason=e instanceof SellError?e.reason:diagnostic??(r.clientId?'DIRECT_SELL_RECOVERY_PENDING':'DIRECT_SELL_READ_UNAVAILABLE');
    if(r.reason==='DIRECT_SELL_PROVIDER_FAILED')r.state='failed';else r.state=r.clientId?(object(r.response)&&identifier(r.response.order_id)?'pending':'unknown'):'failed';
    this.commit(r,owner,r.state==='pending'||r.state==='unknown'?'awaiting':r.state+':'+r.reason);
  }catch{}}
  private async reconcile(r:Sale,owner:string):Promise<void>{
    if(!object(r.response)||!identifier(r.response.order_id))fail('DIRECT_SELL_UNKNOWN');
    const raw=await this.options.client.query(r.response.order_id);this.own(r.id,owner);
    if(!object(raw)||raw.order_id!==r.response.order_id||raw.chain!==undefined&&raw.chain!=='sol'||raw.wallet_address!==undefined&&raw.wallet_address!==r.position.wallet)
      fail('DIRECT_SELL_RECEIPT_UNVERIFIED');
    if(['failed','expired'].includes(String(raw.status))&&raw.state!==30)fail('DIRECT_SELL_PROVIDER_FAILED');
    const confirmed=raw.status==='confirmed'&&(raw.state===undefined||raw.state===30)||raw.status==='successful'&&raw.state===30;
    if(!confirmed||!base58(raw.hash,64))fail('DIRECT_SELL_PENDING');
    const report=raw.report;
    if(!object(report)||report.input_token!==r.position.tokenAddress||report.output_token!==SOL||report.input_amount!==r.amount||
      !atomic(report.output_amount)||BigInt(report.output_amount)<BigInt(String(r.body!.min_output_amount))||
      report.input_token_decimals!==undefined&&report.input_token_decimals!==r.beforeSell!.decimals||report.output_token_decimals!==undefined&&report.output_token_decimals!==9)
      fail('DIRECT_SELL_RECEIPT_UNVERIFIED');
    r.providerConfirmed={orderId:r.response.order_id,hash:String(raw.hash),outputAmount:report.output_amount,checkedAt:new Date(this.now()).toISOString()};
    const fact=await this.options.chain.verifyTransaction({signature:String(raw.hash),wallet:r.position.wallet,mint:r.position.tokenAddress,side:'sell',expectedTokenAmount:r.amount,maxNativeDebitLamports:this.gas.toString()});this.own(r.id,owner);
    if(fact.signature!==raw.hash||fact.wallet!==r.position.wallet||fact.mint!==r.position.tokenAddress||fact.side!=='sell'||fact.decimals!==r.beforeSell!.decimals||
      fact.tokenDelta!=='-'+r.amount||!atomic(fact.preTokenAmount)||!atomic(fact.postTokenAmount)||BigInt(fact.preTokenAmount)-BigInt(fact.postTokenAmount)!==BigInt(r.amount!)||
      !Number.isSafeInteger(fact.slot)||fact.slot<r.beforeSell!.slot)fail('DIRECT_SELL_CHAIN_RECEIPT_UNVERIFIED');
    const final=await this.balance(r.position);if(final.slot<fact.slot||final.nativeSlot<fact.slot)fail('DIRECT_SELL_FINAL_BALANCE_UNVERIFIED');
    r.sell=fact;r.finalSnapshot=final;r.state=final.tokenAmount==='0'?'closed':'completed';delete r.reason;this.commit(r,owner,r.state);
  }
  private async poll(work:()=>Promise<void>){let error:unknown;for(let i=0;i<this.attempts;i++)try{await work();return;}catch(e){error=e;if(e instanceof SellError&&e.reason==='DIRECT_SELL_PROVIDER_FAILED')break;if(i+1<this.attempts)await this.sleep(1000);}throw error;}
  /** Startup/periodic recovery performs provider and RPC reads only. */
  async resume():Promise<void>{
    if(this.closed||this.stopping)return;const work=this.recover();this.track(work);await work;
  }
  private async recover(){
    for(const row of this.db.prepare(`SELECT payload FROM direct_sell_requests WHERE state IN (${ACTIVE}) ORDER BY rowid LIMIT 100`).all()){
      if(this.stopping)return;let r=JSON.parse(String(row.payload)) as Sale;const owner=randomUUID();
      try{this.tx(()=>{this.acquire(r.id,owner);r=this.get(r.id)!;});}catch{continue;}
      if(!['accepted','executing','submitting','pending','unknown'].includes(r.state)){this.release(r,owner);continue;}
      const timer=this.heartbeat(r,owner);
      try {if(!r.clientId){r.state='failed';r.reason='DIRECT_SELL_INTERRUPTED_BEFORE_SUBMIT';this.commit(r,owner,'failed:interrupted');}
        else await this.reconcile(r,owner);
      }catch(e){this.failure(r,owner,e);}finally{clearInterval(timer);this.release(r,owner);}
    }this.flush();
  }
  status(){return {supportedChains:['solana'],requests:this.db.prepare('SELECT payload FROM direct_sell_requests ORDER BY rowid DESC LIMIT 100').all().map(row=>{
    const r=JSON.parse(String(row.payload)) as Sale;return {id:r.id,positionId:r.position.id,state:r.state,percentage:r.percentage,amount:r.amount,reason:r.reason,updatedAt:r.updatedAt,
      remainingAmount:r.finalSnapshot?.tokenAmount,decimals:r.beforeSell?.decimals,transactionHash:r.sell?.signature};})};}
  isClosed(positionId:string):boolean{return !!this.db.prepare("SELECT 1 FROM direct_sell_requests WHERE state='closed' AND json_extract(payload,'$.position.id')=? LIMIT 1").get(positionId);}
  latestBalance(positionId:string):SolanaSnapshot|undefined {
    const row=this.db.prepare("SELECT payload FROM direct_sell_requests WHERE state IN ('completed','closed') AND json_extract(payload,'$.position.id')=? ORDER BY rowid DESC LIMIT 1").get(positionId);
    return row?(JSON.parse(String(row.payload)) as Sale).finalSnapshot:undefined;
  }
  positionState(positionId:string){
    const row=this.db.prepare("SELECT payload FROM direct_sell_requests WHERE json_extract(payload,'$.position.id')=? ORDER BY rowid DESC LIMIT 1").get(positionId);
    if(!row)return;const r=JSON.parse(String(row.payload)) as Sale;
    return {requestId:r.id,state:r.state,percentage:r.percentage,amount:r.amount,reason:r.reason};
  }
  closureEvidence(positionId:string):DirectSellClosureEvidence|undefined {
    const row=this.db.prepare("SELECT payload FROM direct_sell_requests WHERE state='closed' AND json_extract(payload,'$.position.id')=? ORDER BY rowid DESC LIMIT 1").get(positionId);
    if(!row)return;const r=JSON.parse(String(row.payload)) as Sale,f=r.sell,b=r.finalSnapshot;
    if(!f||!b||!r.beforeSell||!r.amount||!atomic(r.amount)||r.amount==='0'||!base58(f.signature,64)||
      f.wallet!==r.position.wallet||f.mint!==r.position.tokenAddress||f.side!=='sell'||f.decimals!==r.beforeSell.decimals||
      f.tokenDelta!=='-'+r.amount||!atomic(f.preTokenAmount)||!atomic(f.postTokenAmount)||BigInt(f.preTokenAmount)-BigInt(f.postTokenAmount)!==BigInt(r.amount)||
      !Number.isSafeInteger(f.slot)||f.slot<r.beforeSell.slot||b.wallet!==f.wallet||b.mint!==f.mint||b.decimals!==f.decimals||b.tokenAmount!=='0'||
      !Number.isSafeInteger(b.slot)||!Number.isSafeInteger(b.nativeSlot)||b.slot<f.slot||b.nativeSlot<f.slot||
      !Number.isFinite(Date.parse(f.checkedAt))||!Number.isFinite(Date.parse(b.checkedAt))||
      Date.parse(f.checkedAt)<Date.parse(r.beforeSell.checkedAt)||Date.parse(b.checkedAt)<Date.parse(f.checkedAt)||Date.parse(b.checkedAt)>this.now()+1000)return;
    return {positionId:r.position.id,requestId:r.id,percentage:r.percentage,amount:r.amount,sell:f,finalSnapshot:b};
  }
  async waitForPending(){await Promise.allSettled([...this.pending]);}
  async stop(){this.stopping=true;await Promise.allSettled([...this.pending]);}
  close(){if(!this.closed){if(this.pending.size)throw Error('DIRECT_SELL_WORK_IN_PROGRESS');this.db.close();this.closed=true;}}
}
