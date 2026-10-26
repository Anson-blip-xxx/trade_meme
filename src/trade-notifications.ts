import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {OpeningOrder} from './orders.js';
import type {ScanPrice,ScanToken} from './scan-archive.js';
import {normalizePriceToken} from './market-price-normalizers.js';
import {NATIVE_CURRENCIES,NATIVE_INPUT_TOKENS} from './native-balance.js';
import {priceEvidence} from './price-evidence.js';
import {crossedPriceMilestones,crossedMilestoneLabel} from './price-milestones.js';
import {createHash} from 'node:crypto';
import {validThirdSignalFill} from './exit-tracking.js';
import {normalizeStoredEntryHolderRisk,type EntryHolderRiskAssessment} from './entry-holder-risk.js';
import {publicNativeTiming,type NativeExecutionTiming} from './native-solana/timing.js';

export interface TradeNotificationEvent {key:string;text:string;}
export interface TradeNotificationsOptions {
  /** Both true (new) and false (already queued) mean success; throw to retry later. */
  enqueue:(event:TradeNotificationEvent)=>boolean;
  now?:()=>number;
  summaryIntervalMs?:number;
  display?:(order:OpeningOrder)=>{name?:string;symbol?:string}|undefined;
  /** Authoritative, verified closure only. A true result is durably latched without rewriting order facts. */
  isClosed?:(orderId:string)=>boolean;
  includePaper?:boolean;
}
export interface TradeNotificationsStatus {
  enabled:boolean;closed:boolean;trackedOrders?:number;activePositions?:number;freshPositions?:number;
  missingPrices?:number;summaryIntervalMs?:number;priceAlertAfterMs?:number;maxAcceptedPriceAgeMs?:number;
  pendingEvents?:number;lastError?:string;
}
interface PricePoint {at:string;usd:number;source:string;}
interface Tracking {
  order:OpeningOrder;name?:string;symbol?:string;confirmedAt?:string;
  nativeManaged?:boolean;
  manualNative?:boolean;
  instructionAcceptedAt?:string;
  nativeFinalizedAt?:string;
  nativeTiming?:NativeExecutionTiming;
  baseline?:PricePoint;latest?:PricePoint;peak?:PricePoint;milestones:number[];
  baselineKind?:'fill'|'observation';
  closedByAuthority?:true;
}
const PRICE_SOURCES=new Set(['dexscreener_token_pairs_sample','gmgn_token_info_sample',
  'ave_price_stream_sample','debot_price_stream_sample','debot_token_info_sample','chain_pool_sample']);
const MAX_PRICE_AGE=90_000,QUOTE_ALERT_AFTER=60_000;
const CHAIN_NAMES={bsc:'BSC',solana:'Solana',robinhood:'Robinhood Chain'} as const;
const HOLDER_RISK_LABELS={top10:'前10持仓占比',bundler:'捆绑持仓占比',ratTrader:'老鼠仓持仓占比'} as const;
const HOLDER_RISK_REASONS:Record<string,string>={
  ENTRY_HOLDER_RISK_TOP10_EXCEEDED:'前10持仓占比超过上限',ENTRY_HOLDER_RISK_BUNDLER_EXCEEDED:'捆绑持仓占比超过上限',
  ENTRY_HOLDER_RISK_RAT_TRADER_EXCEEDED:'老鼠仓持仓占比超过上限',
  ENTRY_HOLDER_RISK_TOP10_MISSING:'前10持仓占比未知',ENTRY_HOLDER_RISK_BUNDLER_MISSING:'捆绑持仓占比未知',ENTRY_HOLDER_RISK_RAT_TRADER_MISSING:'老鼠仓持仓占比未知',
  ENTRY_HOLDER_RISK_TOP10_INVALID:'前10持仓数据无效',ENTRY_HOLDER_RISK_BUNDLER_INVALID:'捆绑持仓数据无效',ENTRY_HOLDER_RISK_RAT_TRADER_INVALID:'老鼠仓持仓数据无效',
  ENTRY_HOLDER_RISK_READ_FAILED:'最新持仓数据暂时无法取得',ENTRY_HOLDER_RISK_PROVIDER_MISSING:'最新持仓数据服务未就绪',
  ENTRY_HOLDER_RISK_TOKEN_MISMATCH:'持仓数据与目标合约不匹配',ENTRY_HOLDER_RISK_TOKEN_INVALID:'目标合约无法核验',
  ENTRY_HOLDER_RISK_TIME_INVALID:'持仓数据时间无法核验',ENTRY_HOLDER_RISK_STALE:'持仓数据已过期',
  ENTRY_HOLDER_RISK_EVIDENCE_INVALID:'持仓核验证据无效',ENTRY_HOLDER_RISK_UNAVAILABLE:'持仓数据尚未完整核验',
  ENTRY_HOLDER_RISK_RESPONSE_INVALID:'持仓数据格式无法核验',
};
function holderRiskReason(reason:string):string {
  const label=/^ENTRY_HOLDER_RISK_(TOP10|BUNDLER|RAT_TRADER)_(COVERAGE_INCOMPLETE|COVERAGE_UNVERIFIED|SOURCE_INVALID)$/.exec(reason);
  return HOLDER_RISK_REASONS[reason]??(label?`${({TOP10:'前10',BUNDLER:'捆绑',RAT_TRADER:'老鼠仓'})[label[1]]}持仓${label[2]==='SOURCE_INVALID'?'数据来源无法核验':'覆盖不完整，完整占比未知'}`:'持仓数据尚未完整核验');
}
function holderRiskBlockText(risk:EntryHolderRiskAssessment|undefined,failureReason:string|undefined):string {
  const reasons=[...new Set([...(risk?.reasons??[]),...(failureReason?[failureReason]:[])])];
  return ['风控拦截，未提交买单。',...Object.entries(HOLDER_RISK_LABELS).map(([key,label])=>{
    const metric=risk?.metrics[key as keyof typeof HOLDER_RISK_LABELS];
    if(!metric)return `${label}：未知（未取得可核验数据）`;
    if(metric.status!=='available')return `${label}：未知（${metric.status==='missing'?'数据缺失':'数据无效'}；${metric.lowerBoundPercentageText?`已核实至少 ${metric.lowerBoundPercentageText}%；`:''}上限 ${metric.limitPct}%）`;
    if(metric.coverage==='lower_bound')return `${label}：至少 ${metric.percentageText}%${metric.exceeded?` > ${metric.limitPct}%（已超限）`:`，完整占比未知（上限 ${metric.limitPct}%）`}`;
    return `${label}：${metric.percentageText}% ${metric.exceeded?'>':'≤'} ${metric.limitPct}%${metric.exceeded?'（超限）':'（通过）'}`;
  }),`原因：${reasons.map(holderRiskReason).join('；')||'持仓数据尚未完整核验'}`,
  ...(risk?[`核验时间：${stamp(risk.checkedAt)}`]:[])].join('\n');
}
const clean=(value:unknown,limit=160)=>typeof value==='string'
  ?value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,limit):'';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const code=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(value)?value:'DETAILS_UNAVAILABLE';
const at=(value:unknown)=>typeof value==='string'&&value.length<=40?Date.parse(value):NaN;
const pct=(value:number)=>`${value>=0?'+':''}${value.toFixed(2)}%`;
const stamp=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' 北京时间';
const same=(a:ScanToken,b:ScanToken)=>a.chain===b.chain&&(a.chain==='solana'?a.address===b.address:a.address.toLowerCase()===b.address.toLowerCase());
const active=(state:Tracking)=>state.order.status==='confirmed'&&!state.order.exit?.positionClosed&&!state.closedByAuthority;
const decimals=(value:string,places:number):string|undefined=>{
  if(!/^(0|[1-9]\d{0,77})$/.test(value))return;
  const padded=value.padStart(places+1,'0'),whole=padded.slice(0,-places),fraction=padded.slice(-places).replace(/0+$/,'');
  return whole+(fraction?'.'+fraction:'');
};
const duration=(value:number)=>value<1000?`${Math.round(value)} ms`:`${(value/1000).toFixed(2)} 秒`;
function nativeTimingText(timing:NativeExecutionTiming|undefined,acceptedAt?:string,finalizedAt?:string):string {
  const accepted=at(acceptedAt),finalized=at(finalizedAt);
  if(Number.isFinite(accepted)&&Number.isFinite(finalized)&&finalized>=accepted)
    return `实际耗时：${duration(finalized-accepted)}（指令接收→链上 finalized 核验）`;
  if(!timing)return '';
  if(timing.finalizedAfterMs!==undefined)return `实际耗时：${duration(timing.finalizedAfterMs)}（执行开始→链上 finalized 核验）`;
  if(timing.confirmedAfterMs!==undefined)return `实际耗时：${duration(timing.confirmedAfterMs)}（执行开始→链上 confirmed 核验）`;
  if(timing.submittedAfterMs!==undefined)return `Jito 回执：${duration(timing.submittedAfterMs)}`;
  return timing.clockInvalid?'实际耗时暂不可核验。':'';
}

/** Converts durable order facts and current observed prices into a durable notification outbox.
 * Never places orders, infers fills from price touches, or calls a network service. */
export class TradeNotifications {
  private readonly db:DatabaseSync;
  private readonly now:()=>number;
  private readonly summaryInterval:number;
  private closed=false;
  private lastQueueError?:string;
  private closureError?:string;
  constructor(path:string,private readonly options:TradeNotificationsOptions) {
    this.now=options.now??Date.now;this.summaryInterval=options.summaryIntervalMs??300_000;
    if(!Number.isSafeInteger(this.summaryInterval)||this.summaryInterval<1_000)
      throw new Error('TRADE_NOTIFICATION_INTERVAL_INVALID');
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS trade_notification_positions (
        order_id TEXT PRIMARY KEY, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trade_notification_events (
        event_key TEXT PRIMARY KEY, text TEXT NOT NULL, queued INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );`);
    // A small indexed active set keeps per-price work independent of historical order count.
    const columns=new Set(this.db.prepare('PRAGMA table_info(trade_notification_positions)').all().map(row=>String(row.name)));
    const migrate=!columns.has('active')||!columns.has('latest_at_ms');
    if(!columns.has('active'))this.db.exec('ALTER TABLE trade_notification_positions ADD COLUMN active INTEGER NOT NULL DEFAULT 0');
    if(!columns.has('latest_at_ms'))this.db.exec('ALTER TABLE trade_notification_positions ADD COLUMN latest_at_ms INTEGER');
    if(migrate)for(const state of this.states())this.save(state);
    this.db.exec(`CREATE INDEX IF NOT EXISTS trade_notification_active ON trade_notification_positions(active,latest_at_ms);
      CREATE INDEX IF NOT EXISTS trade_notification_pending ON trade_notification_events(queued,created_at,event_key);`);
  }
  private states(activeOnly=false):Tracking[] {
    const states=this.db.prepare(`SELECT state FROM trade_notification_positions${activeOnly?' WHERE active=1':''}`)
      .all().map(row=>JSON.parse(String(row.state)) as Tracking);
    if(!activeOnly)return states;
    this.closureError=undefined;
    return states.filter(state=>!this.authoritativelyClosed(state)&&active(state));
  }
  private authoritativelyClosed(state:Tracking):boolean {
    if(state.closedByAuthority)return true;
    let verified=false;
    try {verified=this.options.isClosed?.(state.order.id)===true;}
    catch {this.closureError='TRADE_NOTIFICATION_CLOSURE_UNAVAILABLE';}
    if(!verified)return false;
    state.closedByAuthority=true;
    // Remove only derived reminders still owned by this outbox. Opening/execution
    // facts remain intact; already handed-off Telegram messages cannot be recalled here.
    const prefix=`trade:${state.order.id}:`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.save(state);
      for(const row of this.db.prepare('SELECT event_key FROM trade_notification_events WHERE queued=0 AND substr(event_key,1,?)=?')
        .all(prefix.length,prefix)) {
        const key=String(row.event_key),suffix=key.slice(prefix.length);
        if(/^(?:price_baseline$|fill_price_baseline$|milestone:|summary:|quote_stale:|quote_recovered:|protection_missing:|protection_recovered:)/.test(suffix))
          this.db.prepare('DELETE FROM trade_notification_events WHERE event_key=? AND queued=0').run(key);
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return true;
  }
  /** Read-only display facts; no wallet keys, raw provider bodies, or financial operations. */
  positionViews() {
    return this.states(true).map(state=>({id:state.order.id,name:state.name,symbol:state.symbol,
      latest:state.latest,gainPct:state.baseline&&state.latest?(state.latest.usd/state.baseline.usd-1)*100:undefined,
      gainBasis:state.baselineKind==='fill'?'fill' as const:'observation' as const,
      entryPriceUsd:state.baselineKind==='fill'?state.baseline?.usd:undefined}));
  }
  private save(state:Tracking):void {
    this.db.prepare(`INSERT INTO trade_notification_positions (order_id,state,active,latest_at_ms) VALUES (?,?,?,?)
      ON CONFLICT(order_id) DO UPDATE SET state=excluded.state,active=excluded.active,latest_at_ms=excluded.latest_at_ms`)
      .run(state.order.id,JSON.stringify(state),active(state)?1:0,state.latest?at(state.latest.at):null);
  }
  private event(state:Tracking,suffix:string,body:string):void {
    const eventKey=`trade:${state.order.id}:${suffix}`;
    const title=state.name||state.symbol||'未命名代币';
    const timing=state.nativeManaged?nativeTimingText(state.nativeTiming,state.instructionAcceptedAt,state.nativeFinalizedAt):'';
    if(state.manualNative&&['confirmed','failed','unknown'].includes(suffix)){
      const status=suffix==='confirmed'?'✅ 链上成交已确认':suffix==='failed'?`❌ 买入失败 · ${code(state.order.failureReason)}`:
        `⚠️ 结果待链上核验，不会重复下单 · ${code(state.order.failureReason)}`;
      const text=[suffix==='confirmed'?'【买入成交】':suffix==='failed'?'【买入失败】':'【买入待确认】',
        `${status}\n${title} · ${CHAIN_NAMES[state.order.chain]}`,
        this.compactInputAmount(state.order),...(timing?[timing]:Number.isFinite(at(state.instructionAcceptedAt))&&
          Number.isFinite(at(state.order.updatedAt))&&at(state.order.updatedAt)>=at(state.instructionAcceptedAt)
          ?[`实际耗时：${duration(at(state.order.updatedAt)-at(state.instructionAcceptedAt))}（指令接收→${suffix==='confirmed'?'成交确认':'结果判定'}）`]:[]),
        `CA：${clean(state.order.tokenAddress,120)}`,
        ...(state.order.transactionHash?[`https://solscan.io/tx/${clean(state.order.transactionHash,200)}`]:[])].join('\n');
      this.db.prepare('INSERT OR IGNORE INTO trade_notification_events VALUES (?,?,0,?)')
        .run(eventKey,text,this.now());
      return;
    }
    const text=[state.order.mode==='paper'?'【模拟持仓，非实盘】':'【实盘订单】',body,...(timing?[timing]:[]),
      `代币：${title}${state.symbol&&state.symbol!==title?` (${state.symbol})`:''}`,
      `链：${CHAIN_NAMES[state.order.chain]}`,`CA：${clean(state.order.tokenAddress,120)}`,
      `开仓单：${clean(state.order.id,200)}`,
      ...(state.order.providerOrderId?[`GMGN 单号：${clean(state.order.providerOrderId,200)}`]:[]),
      ...(state.order.transactionHash?[`开仓交易：${clean(state.order.transactionHash,200)}`]:[]),
      this.inputAmount(state.order,state.nativeManaged)].join('\n');
    this.db.prepare('INSERT OR IGNORE INTO trade_notification_events VALUES (?,?,0,?)')
      .run(eventKey,text,this.now());
  }
  private compactInputAmount(order:OpeningOrder):string {
    const raw=order.actualInputAmount??order.inputAmount,currency=NATIVE_CURRENCIES[order.chain];
    const native=same({chain:order.chain,address:order.inputToken},{chain:order.chain,address:NATIVE_INPUT_TOKENS[order.chain]});
    const exact=native?decimals(raw,currency.decimals):undefined;
    return exact===undefined?'金额：待核验':`金额：${exact} ${currency.symbol}${order.actualInputAmount?'（链上核验）':''}`;
  }
  private inputAmount(order:OpeningOrder,nativeManaged=false):string {
    const actual=order.actualInputAmount,raw=actual??order.inputAmount,currency=NATIVE_CURRENCIES[order.chain];
    const native=same({chain:order.chain,address:order.inputToken},{chain:order.chain,address:NATIVE_INPUT_TOKENS[order.chain]});
    const exact=native?decimals(raw,currency.decimals):undefined;
    if(exact===undefined)return '输入金额：原生币单位尚未核实';
    const actualLabel=nativeManaged?'链上核验成交输入':'GMGN 记录成交输入';
    return `${actual?actualLabel:'委托输入'}：${exact} ${currency.symbol}${actual?'（未核算总费用）':'（不代表已成交）'}`;
  }
  private flush():void {
    this.states(true);
    for(const row of this.db.prepare('SELECT event_key,text FROM trade_notification_events WHERE queued=0 ORDER BY created_at,event_key LIMIT 100').all()) {
      try {
        this.options.enqueue({key:String(row.event_key),text:String(row.text)});
        this.db.prepare('UPDATE trade_notification_events SET queued=1 WHERE event_key=?').run(row.event_key);
        this.lastQueueError=undefined;
      } catch {this.lastQueueError='TRADE_NOTIFICATION_QUEUE_UNAVAILABLE';break;}
    }
  }
  observeOrder(input:OpeningOrder):void {
    if(this.closed||!input||!['live','paper'].includes(input.mode)||input.mode==='paper'&&!this.options.includePaper||
      !normalizePriceToken({chain:input.chain,address:input.tokenAddress})||!clean(input.id,200))return;
    const row=this.db.prepare('SELECT state FROM trade_notification_positions WHERE order_id=?').get(input.id);
    const previous=row?JSON.parse(String(row.state)) as Tracking:undefined;
    if(previous&&this.authoritativelyClosed(previous)){this.flush();return;}
    // A delayed callback must not restore a closed position or regress its immutable identity.
    if(previous&&(previous.order.chain!==input.chain||previous.order.tokenAddress!==input.tokenAddress||
      previous.order.mode!==input.mode||at(input.updatedAt)<at(previous.order.updatedAt)||
      previous.order.exit?.positionClosed&&!input.exit?.positionClosed||
      previous.order.status==='confirmed'&&input.status!=='confirmed'))return;
    const order=structuredClone(input);
    const manualTest=object(input.details.manualTest)?input.details.manualTest:undefined;
    const nativeFill=object(input.details.nativeFill)?input.details.nativeFill:undefined;
    const holderRiskBlocked=order.status==='failed'&&/^ENTRY_HOLDER_RISK_[A-Z0-9_]+$/.test(order.failureReason??'')&&
      !order.providerOrderId&&!order.transactionHash&&!['submitting','submitted','unknown'].includes(previous?.order.status??'');
    const holderRisk=normalizeStoredEntryHolderRisk(input.details.entryHolderRisk,{chain:input.chain,address:input.tokenAddress});
    // Raw vendor payloads, signer details and funding snapshots are not notification state.
    order.details={};order.wallet='';order.eventKey='';
    const state:Tracking=previous??{order,milestones:[]};
    state.nativeManaged=input.details.executionProvider==='pump_native';
    state.manualNative=state.nativeManaged&&input.details.executionStrategy==='manual_native_test_v1';
    const accepted=manualTest?.acceptedAt??manualTest?.confirmedAt;
    if(state.manualNative&&typeof accepted==='string'&&Number.isFinite(at(accepted))&&at(accepted)<=this.now()+5000)
      state.instructionAcceptedAt=accepted;
    if(state.manualNative&&nativeFill?.commitment==='finalized'&&typeof nativeFill.confirmedAt==='string'&&
      Number.isFinite(at(nativeFill.confirmedAt))&&at(nativeFill.confirmedAt)<=this.now()+5000)
      state.nativeFinalizedAt=nativeFill.confirmedAt;
    state.nativeTiming=publicNativeTiming(input.details.nativeExecutionTiming)??state.nativeTiming;
    state.order=order;
    try {const display=this.options.display?.(input);state.name=clean(display?.name,80)||state.name;
      state.symbol=clean(display?.symbol,40)||state.symbol;} catch { /* Display metadata is optional. */ }
    if(this.authoritativelyClosed(state)){this.flush();return;}
    this.db.exec('BEGIN IMMEDIATE');
    try {
    if(order.status==='confirmed'&&!state.confirmedAt) {
      state.confirmedAt=new Date(Number.isFinite(at(order.updatedAt))&&at(order.updatedAt)<=this.now()?at(order.updatedAt):this.now()).toISOString();
    }
    if(order.status==='submitted'&&!state.manualNative)this.event(state,'submitted','买单已提交，等待成交确认。');
    else if(order.status==='confirmed')this.event(state,'confirmed',
      `买单已确认。${!order.actualInputAmount||!order.outputAmount?'成交数量明细仍待补齐。':''}`);
    else if(order.status==='failed')this.event(state,'failed',holderRiskBlocked?holderRiskBlockText(holderRisk,order.failureReason):`买单失败。原因：${code(order.failureReason)}`);
    else if(order.status==='unknown')this.event(state,'unknown',
      `买单结果未知，不能当作成交或失败，也不会自动重复下单。原因：${code(order.failureReason)}`);
    else if(order.mode==='paper'&&order.status==='paper_open')this.event(state,'paper_open','模拟开仓记录，不是实盘成交。');
    this.applyFillBaseline(state,input);
    this.observeExit(state);
    this.save(state);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.flush();
  }
  private applyFillBaseline(state:Tracking,input:OpeningOrder):void {
    if(input.status!=='confirmed'||input.mode!=='live'||input.details.executionStrategy!=='third_signal_v1'||state.baselineKind==='fill')return;
    const fill=input.details.thirdSignalFill;
    if(!validThirdSignalFill(fill,{chain:input.chain,wallet:input.wallet,tokenAddress:input.tokenAddress,inputToken:input.inputToken,
      openingTransactionHash:input.transactionHash},new Date(this.now()))||fill.inputAmount!==input.actualInputAmount||
      fill.outputAmount!==input.outputAmount||fill.priceUsd===undefined)return;
    state.baseline={at:fill.confirmedAt,usd:fill.priceUsd,source:'gmgn_fill_price_usd'};
    state.baselineKind='fill';state.confirmedAt=fill.confirmedAt;
    if(!state.peak||state.peak.usd<fill.priceUsd)state.peak=state.baseline;
    // Baseline changes stay available to the dashboard and milestone engine;
    // they are not actionable Telegram events by themselves.
    // A late fill receipt may arrive after the latest market tick. Account for
    // that already-observed fresh price immediately without treating it as new.
    if(state.latest&&this.now()-at(state.latest.at)<=QUOTE_ALERT_AFTER&&at(state.latest.at)>=at(fill.confirmedAt))this.emitMilestones(state);
  }
  private emitMilestones(state:Tracking):void {
    if(!state.latest||!state.baseline)return;
    const gain=(state.latest.usd/state.baseline.usd-1)*100,crossed=crossedPriceMilestones(gain,state.milestones);
    if(!crossed.length)return;
    state.milestones.push(...crossed);
    const key=crossed.join(',');
    this.event(state,`milestone:${key.length<=160?key:createHash('sha256').update(key).digest('hex')}`,
      `${state.baselineKind==='fill'?'持仓价格涨幅':'价格涨跌观察'}：越过 ${crossedMilestoneLabel(crossed)}\n\n${this.priceSummary(state)}`);
  }
  private observeExit(state:Tracking):void {
    const order=state.order,exit=order.exit;
    if(!exit)return;
    if(exit.strategyOrderId) {
      if(exit.assessment?.found&&exit.assessment.policyMatched)for(const condition of exit.assessment.conditions) {
        if(!['success','cancel','failed'].includes(condition.status))continue;
        const what=condition.orderType==='profit_stop'?'止盈':'止损';
        const status=condition.status==='success'?'执行成功':condition.status==='cancel'?'已取消':'执行失败';
        this.event(state,`strategy:${exit.strategyOrderId}:condition:${condition.cid}:${condition.status}`,
          `GMGN 报告${what}单${status}。\n策略单：${clean(exit.strategyOrderId,200)}\n条件单：${clean(condition.cid,200)}\n`+
          `触发幅度：${clean(condition.priceScale,40)}%；卖出剩余仓位：${clean(condition.sellRatio,40)}%`+
          (condition.status==='success'?'\n尚未核实卖出成交价、总费用和实际净收益。':''));
      }
    }
    if(exit.positionClosed&&order.status==='confirmed'&&exit.assessment?.terminal&&
      exit.balance?.status==='verified'&&exit.balance.amount==='0'&&
      Number.isFinite(at(exit.balance.checkedAt))&&Number.isFinite(at(exit.assessment.checkedAt))&&
      at(exit.balance.checkedAt)>=at(exit.assessment.checkedAt)&&at(exit.balance.checkedAt)<=this.now()) {
      this.event(state,'closed',`持仓余额已核验为 0，清仓确认。\n余额核验：${stamp(exit.balance.checkedAt)}`+
        (exit.assessment.closeTransactionHash?`\n平仓交易：${clean(exit.assessment.closeTransactionHash,200)}`:'')+
        '\n最终净收益尚待完整成交与费用核算，不能用价格涨幅代替。');
    }
  }
  observePrice(input:ScanPrice):boolean {
    if(this.closed||!input)return false;
    const token=normalizePriceToken(input),time=at(input.observedAt),now=this.now();
    const extra=input as ScanPrice&{status?:string;conflict?:boolean};
    if(!token||!Number.isFinite(input.priceUsd)||input.priceUsd<=0||!Number.isFinite(time)||time>now||now-time>MAX_PRICE_AGE||
      !PRICE_SOURCES.has(input.source)||extra.conflict||extra.status==='conflict'||
      input.source==='chain_pool_sample'&&!priceEvidence(input))return false;
    let accepted=false;
    for(const target of this.states(true)) {
      if(target.nativeManaged)continue;
      if(!same(token,{chain:target.order.chain,address:target.order.tokenAddress}))continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
      const row=this.db.prepare('SELECT state FROM trade_notification_positions WHERE order_id=?').get(target.order.id);
      const state=row?JSON.parse(String(row.state)) as Tracking:undefined;
      if(!state||!active(state)||!state.confirmedAt||time<at(state.confirmedAt)||state.latest&&time<=at(state.latest.at)){
        this.db.exec('COMMIT');continue;
      }
      const point={at:new Date(time).toISOString(),usd:input.priceUsd,source:input.source};
      if(!state.baseline) {
        state.baseline=point;state.peak=point;state.baselineKind='observation';
      }
      state.latest=point;
      if(!state.peak||point.usd>state.peak.usd)state.peak=point;
      this.emitMilestones(state);
      this.save(state);this.db.exec('COMMIT');accepted=true;
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    this.flush();return accepted;
  }
  recordPriceError(token:ScanToken,_reason:string):void {if(this.closed||!normalizePriceToken(token))return;}
  private priceSummary(state:Tracking):string {
    if(!state.latest||!state.baseline||!state.peak)return '尚未获得成交确认后的鲜活参考价。';
    const current=(state.latest.usd/state.baseline.usd-1)*100,peak=(state.peak.usd/state.baseline.usd-1)*100;
    const drawdown=(1-state.latest.usd/state.peak.usd)*100,ageMs=Math.max(0,this.now()-at(state.latest.at)),age=Math.floor(ageMs/1000);
    return [`当前参考价：$${state.latest.usd}${ageMs>QUOTE_ALERT_AFTER?'（已过时，不是当前可执行价）':''}`,
      `${state.baselineKind==='fill'?'相对买入成交价':'相对观察基准'}：${pct(current)}\n${state.baselineKind==='fill'?'持仓价格峰值':'观察峰值'}：${pct(peak)}\n从峰值回撤：${drawdown.toFixed(2)}%`,
      `报价时间：${stamp(state.latest.at)}；价龄：${age} 秒；来源：${state.latest.source}`,
      state.baselineKind==='fill'?'涨跌幅按已核验成交单价计算；未计费用及已卖出部分，不代表净收益。':
        '基准是成交确认后首个鲜活参考价；观察涨幅不等于实际盈亏，未计费用或滑点。'].join('\n');
  }
  tick():void {
    if(this.closed)return;
    this.states(true);this.flush();
  }
  status():TradeNotificationsStatus {
    if(this.closed)return {enabled:false,closed:true};
    this.states(true);
    const now=this.now(),tracked=Number(this.db.prepare('SELECT count(*) AS n FROM trade_notification_positions').get()!.n),
      positions=Number(this.db.prepare('SELECT count(*) AS n FROM trade_notification_positions WHERE active=1').get()!.n),
      fresh=Number(this.db.prepare('SELECT count(*) AS n FROM trade_notification_positions WHERE active=1 AND latest_at_ms>=? AND latest_at_ms<=?')
        .get(now-QUOTE_ALERT_AFTER,now)!.n);
    return {enabled:true,closed:false,trackedOrders:tracked,activePositions:positions,
      freshPositions:fresh,missingPrices:positions-fresh,
      summaryIntervalMs:this.summaryInterval,priceAlertAfterMs:QUOTE_ALERT_AFTER,maxAcceptedPriceAgeMs:MAX_PRICE_AGE,
      pendingEvents:Number(this.db.prepare('SELECT count(*) AS n FROM trade_notification_events WHERE queued=0').get()!.n),
      ...(this.lastQueueError||this.closureError?{lastError:this.lastQueueError??this.closureError}:{})};
  }
  close():void {if(!this.closed){this.closed=true;this.db.close();}}
}
