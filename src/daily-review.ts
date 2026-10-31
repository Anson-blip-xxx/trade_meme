import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import type {Config} from './config.js';
import {chainAddress} from './chain-stream-store.js';
import type {Chain,Signal} from './types.js';
import type {FollowupRecord} from './signal-followup.js';
import type {ScanRecord} from './scan-archive.js';

type Source=Signal['source'];
type Check={status:string;reasons:string[]};
export interface ReviewDecision {decision:string;at:string;policyVersion:string;buyEligible:boolean;reasons:string[];checks:Record<string,Check>;frozen:boolean;scanId?:string;}
export interface ReviewNotification {chain:Chain;address:string;id:string;source:Source;receivedAt:string;occurredAt:string;name?:string;symbol?:string;state?:string;reason?:string;}
export interface ReviewPrice {chain:Chain;address:string;at:string;price:number;source:string;pool?:string;stage?:string;score?:number;assessedAt?:string;}
export interface ReviewVendorPerformance {source:'ave'|'debot';reportedAt:string;firstSignalAt?:string;maxGainPct?:number;maxGainValue?:number;maxGainUnit?:'fractional_return'|'provider_display_ratio';display?:string;scope:'vendor_reported_retrospective';}
export interface ReviewExecution {chain:Chain;address:string;at:string;mode:string;status:string;reason?:string;scanId?:string;decisionAt?:string;}
export interface ReviewInput {
  date:string;asOf:string;entryMode:string;notifications:ReviewNotification[];
  decisions:Array<ReviewDecision&{chain:Chain;address:string}>;prices:ReviewPrice[];
  vendor:Array<ReviewVendorPerformance&{chain:Chain;address:string}>;
  orders:Array<{chain:Chain;address:string;at:string;status:string;mode:string}>;executions:ReviewExecution[];
  limitations:string[];datasetComplete?:boolean;
}
export interface ReviewItem {
  chain:Chain;address:string;name?:string;symbol?:string;sources:Source[];firstReceivedAt:string;signalCount:number;
  localPerformance?:{maxGainPct:number;currentGainPct:number;baselineAt:string;peakAt:string;lastSampleAt:string;trailingGapSec:number;samples:number;baselineDelayed:boolean;maxGapSec:number;poolAddress?:string;source:string};
  vendorPerformance:ReviewVendorPerformance[];firstDecision?:ReviewDecision;latestDecision?:ReviewDecision;
  eligibility:{observedEligible:boolean;firstEligibleAt?:string;beforeObservedPeak?:boolean};
  highGain:{localObserved:boolean;vendorReported:boolean};
  funnel:{stage:string;reasonCodes:string[];explanation:string;hasOrder:boolean;execution?:Omit<ReviewExecution,'chain'|'address'>&{verified:true}};
  evidence:string[];
}
export interface DailyReview {
  id:string;date:string;generatedAt:string;windowStartAt:string;windowEndAt:string;entryMode:string;
  counts:{signals:number;tokens:number;withPerformance:number;highGainers:number;missedHighGainers:number;entered:number};
  findings:Array<{code:string;count:number;text:string}>;
  learning:{status:'collecting'|'research_plan_applied'|'unavailable';planId?:string;priorities:Array<{chain:Chain;source:Source;total:number;covered:number;missing:number;weight:1|2}>;notes:string[]};
  limitations:string[];datasetComplete:boolean;items:ReviewItem[];
}
const DAY=86400_000,OFFSET=8*3600_000;
const key=(v:{chain:string;address:string})=>`${v.chain}:${v.address}`;
const validTime=(s:unknown):s is string=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT/.test(s)&&Number.isFinite(Date.parse(s));
const safe=(s:unknown,max=160):string|undefined=>typeof s==='string'?s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max)||undefined:undefined;
const codes=(value:unknown):string[]=>Array.isArray(value)?[...new Set(value.filter((v):v is string=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(v)))].slice(0,48):[];
function token(v:{chain:string;address:string}):{chain:Chain;address:string}|undefined {
  if(!['bsc','solana','robinhood'].includes(v.chain))return;
  const address=chainAddress(v.chain as Chain,v.address);if(!address||/^0x0{40}$/.test(address)||address==='11111111111111111111111111111111')return;
  return {chain:v.chain as Chain,address};
}
export function shanghaiDate(now:Date):string {return new Date(now.getTime()+OFFSET).toISOString().slice(0,10);}
export function reviewWindow(date:string):{start:string;end:string} {
  if(!/^\d{4}-\d\d-\d\d$/.test(date))throw new Error('REVIEW_DATE_INVALID');
  const ms=Date.parse(`${date}T00:00:00+08:00`);
  if(!Number.isFinite(ms)||shanghaiDate(new Date(ms))!==date)throw new Error('REVIEW_DATE_INVALID');
  return {start:new Date(ms).toISOString(),end:new Date(ms+DAY).toISOString()};
}
export function reviewSchedule(now=new Date()) {
  let next=Date.parse(`${shanghaiDate(now)}T09:00:00+08:00`);if(next<=now.getTime())next+=DAY;
  return {time:'09:00',timezone:'Asia/Shanghai',nextRunAt:new Date(next).toISOString()};
}
export const reviewDatabasePath=(archivePath:string)=>`${archivePath}.daily-review.sqlite`;
export const reviewSamplingPath=(archivePath:string)=>`${archivePath}.review-sampling.json`;
export const reviewRunId=(date:string,asOf:string)=>createHash('sha256').update(`${date}/${shanghaiDate(new Date(asOf))}`).digest('hex').slice(0,24);

const explanations:Record<string,string>={
  entered:'已进入订单流程；订单记录不等同于确认成交或盈利。',
  signal_filtered:'信号在正式评估前已被过滤或合并，需按接收时间和过滤原因核对。',
  not_evaluated:'本地收到了信号，但没有保留下可核对的完整评估；不能归因为策略拒绝。',
  safety_blocked:'当时合约安全或来源检查明确不通过；事后上涨不能推翻当时的风险证据。',
  safety_incomplete:'当时安全或来源证据不齐，未取得完整通过结果。',
  timeliness:'信号或必需证据当时已过期，或时间异常，未进入有效候选。',
  wallet_support:'安全和来源已通过，但钱包支持或资金流证据未满足候选条件。',
  market_risk:'当时市场风险检查未满足要求。',
  execution_path:'当时的发行阶段或交易路径尚未支持，尚未进入可执行候选。',
  analysis_incomplete:'当时分析超时，所需证据未完整返回；不能把未取得的数据当成明确的否定证据。',
  strategy_watch:'当时仍处于观察或排除状态；具体阻断依据见冻结的检查与原因。',
  execution_disabled:'当次执行审计明确记录开仓关闭；筛选是否通过另列。',
  execution_blocked:'已评估为候选，但后续执行检查阻断，或仅限研究来源。',
  decision_after_peak:'没有峰值前的可用判断快照；后来的检查不能倒推当时为何没有开单。',
  eligible_no_entry_record:'当时已成为候选，但没有订单或完整执行审计；不能推断具体未开单原因。',
};
function funnel(decision:ReviewDecision|undefined,notifications:ReviewNotification[],order:boolean,execution?:ReviewExecution):ReviewItem['funnel'] {
  const reasons=decision?.reasons??codes(notifications.flatMap(n=>n.reason?[n.reason]:[])),checks=decision?.checks??{};
  let stage:string;
  if(order)stage='entered';
  else if(!decision)stage=reasons.length?'signal_filtered':'not_evaluated';
  else if(decision.decision==='BUY_CANDIDATE'&&decision.buyEligible)stage=execution?.reason==='ENTRY_DISABLED'?'execution_disabled':execution&&['blocked','skipped'].includes(execution.status)?'execution_blocked':'eligible_no_entry_record';
  else if(reasons.some(r=>/SIGNAL_STALE|SIGNAL_TIME_IN_FUTURE|REQUIRED_EVIDENCE_STALE/.test(r)))stage='timeliness';
  else if(['safety','provenance'].some(k=>checks[k]?.status==='fail'))stage='safety_blocked';
  else if(['safety','provenance'].some(k=>checks[k]?.status!=='pass'))stage='safety_incomplete';
  else if(reasons.includes('LAUNCHPAD_MODE_NOT_SUPPORTED'))stage='execution_path';
  else if(reasons.includes('ANALYSIS_DEADLINE_EXCEEDED'))stage='analysis_incomplete';
  else if(reasons.includes('MARKET_RISK_NOT_PASSED'))stage='market_risk';
  else if(reasons.some(r=>/WALLET_SUPPORT_NOT_PASSED|WALLET_SETUP_SUPPORT_WITHDRAWN/.test(r)))stage='wallet_support';
  else stage='strategy_watch';
  return {stage,reasonCodes:reasons,explanation:explanations[stage],hasOrder:order,
    ...(execution?{execution:{at:execution.at,mode:execution.mode,status:execution.status,reason:execution.reason,scanId:execution.scanId,decisionAt:execution.decisionAt,verified:true as const}}:{})};
}

/** Complete local signal cohort, not a winners-only backtest. All dates in saved output are UTC. */
export function buildDailyReview(input:ReviewInput):DailyReview {
  const window=reviewWindow(input.date),asOf=Date.parse(input.asOf);
  if(!validTime(input.asOf)||Date.parse(window.end)>asOf)throw new Error('REVIEW_PERIOD_NOT_CLOSED');
  const all=new Map<string,ReviewNotification[]>(),seen=new Set<string>();
  for(const n of input.notifications){const t=token(n);if(!t||!['debot','ave','gmgn','wallet','manual'].includes(n.source)||!validTime(n.receivedAt)||Date.parse(n.receivedAt)>asOf)continue;
    const id=`${n.source}:${n.id}:${key(t)}`;if(seen.has(id))continue;seen.add(id);
    const rows=all.get(key(t))??[];rows.push({...n,...t,receivedAt:new Date(n.receivedAt).toISOString()});all.set(key(t),rows);
  }
  const byPrice=new Map<string,ReviewPrice[]>(),byDecision=new Map<string,ReviewInput['decisions']>();
  for(const p of input.prices){const t=token(p);if(!t||!validTime(p.at)||Date.parse(p.at)>asOf||!Number.isFinite(p.price)||p.price<=0||
    !['gmgn_token_info','dexscreener_pair','trusted_followup'].includes(p.source))continue;
    const k=key(t),rows=byPrice.get(k)??[];rows.push({...p,...t,at:new Date(p.at).toISOString()});byPrice.set(k,rows);
  }
  for(const d of input.decisions){const t=token(d);if(!t||!validTime(d.at)||Date.parse(d.at)>asOf)continue;
    const k=key(t),rows=byDecision.get(k)??[];rows.push({...d,...t,at:new Date(d.at).toISOString(),reasons:codes(d.reasons)});byDecision.set(k,rows);
  }
  const groupTimed=<T extends {chain:Chain;address:string}>(rows:T[],time:(row:T)=>string)=>{
    const grouped=new Map<string,T[]>();for(const row of rows){const t=token(row),at=time(row);if(!t||!validTime(at)||Date.parse(at)>asOf)continue;
      const k=key(t),values=grouped.get(k)??[];values.push({...row,...t});grouped.set(k,values);}return grouped;
  };
  const byVendor=groupTimed(input.vendor,v=>v.reportedAt),byOrder=groupTimed(input.orders,o=>o.at),byExecution=groupTimed(input.executions,e=>e.at);
  const items:ReviewItem[]=[],cohorts=new Map<string,{chain:Chain;source:Source;total:number;covered:number}>();
  let notificationsCount=0;
  for(const [k,events] of all){events.sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)||a.id.localeCompare(b.id));
    const today=events.filter(n=>n.receivedAt>=window.start&&n.receivedAt<window.end);if(!today.length)continue;
    notificationsCount+=today.length;
    const first=today[0],firstReceivedAt=first.receivedAt;
    const decisionCandidates=(byDecision.get(k)??[]).filter(d=>d.at>=firstReceivedAt);
    // An explicitly frozen first evaluation outranks a mutable latest scan snapshot.
    decisionCandidates.sort((a,b)=>Number(b.frozen)-Number(a.frozen)||a.at.localeCompare(b.at));
    const firstDecision=decisionCandidates[0];
    const chronological=[...decisionCandidates].sort((a,b)=>a.at.localeCompare(b.at));
    const latestDecision=chronological.at(-1),firstEligible=chronological.find(d=>d.decision==='BUY_CANDIDATE'&&d.buyEligible);
    const eligiblePrices=(byPrice.get(k)??[]).filter(p=>p.at>=firstReceivedAt&&p.pool).sort((a,b)=>a.at.localeCompare(b.at));
    const baselinePool=eligiblePrices[0]?.pool;
    const prices=baselinePool?eligiblePrices.filter(p=>p.pool===baselinePool):[];
    const distinct=[...new Map(prices.map(p=>[p.at,p])).values()],base=distinct[0],last=distinct.at(-1);
    let localPerformance:ReviewItem['localPerformance'];
    if(base&&last&&distinct.length>=2){const peak=distinct.reduce((a,b)=>b.price>a.price?b:a),maxGainPct=(peak.price/base.price-1)*100,currentGainPct=(last.price/base.price-1)*100;
      if(Number.isFinite(maxGainPct)&&Number.isFinite(currentGainPct))localPerformance={maxGainPct,currentGainPct,baselineAt:base.at,peakAt:peak.at,
        lastSampleAt:last.at,trailingGapSec:Math.max(0,(asOf-Date.parse(last.at))/1000),samples:distinct.length,baselineDelayed:Date.parse(base.at)-Date.parse(firstReceivedAt)>600000,
        maxGapSec:distinct.slice(1).reduce((max,p,i)=>Math.max(max,(Date.parse(p.at)-Date.parse(distinct[i].at))/1000),0),poolAddress:base.pool,source:base.source};}
    const vendorPerformance=[...new Map((byVendor.get(k)??[])
      .sort((a,b)=>a.reportedAt.localeCompare(b.reportedAt)).map(v=>[v.source,{source:v.source,reportedAt:v.reportedAt,firstSignalAt:v.firstSignalAt,
        maxGainPct:Number.isFinite(v.maxGainPct)?v.maxGainPct:undefined,maxGainValue:Number.isFinite(v.maxGainValue)?v.maxGainValue:undefined,maxGainUnit:v.maxGainUnit,display:safe(v.display,80),scope:'vendor_reported_retrospective' as const}])).values()];
    const orders=(byOrder.get(k)??[]).filter(o=>o.at>=firstReceivedAt);
    const peakAt=localPerformance?.peakAt;
    const explainedDecision=firstEligible&&(!peakAt||firstEligible.at<=peakAt)?firstEligible:
      (peakAt?chronological.filter(d=>d.at<=peakAt).at(-1):undefined)??firstDecision;
    const execution=(byExecution.get(k)??[]).filter(e=>!!explainedDecision?.scanId&&e.scanId===explainedDecision.scanId&&(!e.decisionAt||e.decisionAt===explainedDecision.at)&&e.at>=explainedDecision.at)
      .sort((a,b)=>b.at.localeCompare(a.at))[0];
    const evidence:string[]=[];
    if(firstDecision)evidence.push(`${firstDecision.frozen?'已冻结的首次判断':'留存的可用判断快照（不能保证是首次）'}：${firstDecision.decision}，${firstDecision.at}，策略 ${firstDecision.policyVersion}。`);
    if(localPerformance){evidence.push(`本地报价样本 ${localPerformance.samples} 个，基准 ${base!.at}；最长间隔 ${Math.round(localPerformance.maxGapSec)} 秒。`);
      evidence.push(`最后采样 ${localPerformance.lastSampleAt}；距离报告截止时间 ${Math.round(localPerformance.trailingGapSec)} 秒，末端空档不代表价格不变。`);
      if(localPerformance.baselineDelayed)evidence.push('首个有效报价较首次收到信号延迟超过 10 分钟；此涨幅不包含此前行情。');
      const early=distinct.find(p=>p.stage&&validTime(p.assessedAt)&&Date.parse(p.assessedAt)<=Date.parse(localPerformance!.peakAt));if(early)evidence.push(`峰值前已留存的市场阶段：${early.stage}，${early.assessedAt}${early.score!==undefined?`，研究分 ${early.score}`:''}；不是上涨原因的因果证明。`);
    }else evidence.push('缺少至少两个可比较的本地价格样本；收益保持未知，不计作零或漏单成功。');
    if(vendorPerformance.length)evidence.push('平台涨幅为供应商回溯展示；起点可能早于本地接收，不能据此声称当时可买到该收益。');
    if(!execution&&!orders.length)evidence.push('旧版本未记录全部执行跳过原因；当前开仓模式不能代替当时的执行记录。');
    const outcome=funnel(explainedDecision,today,orders.length>0,execution);
    if(!orders.length&&explainedDecision&&peakAt&&explainedDecision.at>peakAt){outcome.stage='decision_after_peak';outcome.explanation=explanations.decision_after_peak;outcome.reasonCodes=[...outcome.reasonCodes,'DECISION_AFTER_OBSERVED_PEAK'];}
    if(firstEligible&&peakAt&&firstEligible.at>peakAt)evidence.push(`可用记录中首次成为候选在 ${firstEligible.at}，晚于本地观测峰值；不能算提前捕获。`);
    const item:ReviewItem={chain:first.chain,address:first.address,name:safe(events.find(n=>n.name)?.name,100),symbol:safe(events.find(n=>n.symbol)?.symbol,40),
      sources:[...new Set(today.map(n=>n.source))],firstReceivedAt,signalCount:today.length,localPerformance,vendorPerformance,firstDecision,latestDecision,
      eligibility:{observedEligible:!!firstEligible,firstEligibleAt:firstEligible?.at,beforeObservedPeak:firstEligible&&peakAt?firstEligible.at<=peakAt:undefined},
      highGain:{localObserved:(localPerformance?.maxGainPct??-Infinity)>=100,vendorReported:vendorPerformance.some(v=>(v.maxGainPct??-Infinity)>=100||v.source==='ave'&&v.maxGainUnit==='provider_display_ratio'&&(v.maxGainValue??0)>=2)},
      funnel:outcome,evidence};items.push(item);
    // A token is one independent sampling unit even when multiple vendors repeat it.
    const cohortKey=`${first.chain}:${today[0].source}`,c=cohorts.get(cohortKey)??{chain:first.chain,source:today[0].source,total:0,covered:0};
    c.total++;if(localPerformance&&!localPerformance.baselineDelayed)c.covered++;cohorts.set(cohortKey,c);
  }
  const gain=(r:ReviewItem)=>Math.max(r.localPerformance?.maxGainPct??-Infinity,...r.vendorPerformance.map(v=>v.maxGainPct??-Infinity));
  const isHigh=(r:ReviewItem)=>r.highGain.localObserved||r.highGain.vendorReported;
  const ratio=(r:ReviewItem)=>Math.max(-Infinity,...r.vendorPerformance.filter(v=>v.source==='ave'&&v.maxGainUnit==='provider_display_ratio').map(v=>v.maxGainValue??-Infinity));
  // Focus high performers first; percentage and unknown-unit vendor multiples are never converted or compared as equivalent returns.
  items.sort((a,b)=>Number(isHigh(b))-Number(isHigh(a))||gain(b)-gain(a)||ratio(b)-ratio(a)||a.chain.localeCompare(b.chain)||a.address.localeCompare(b.address));
  const high=items.filter(isHigh),missed=high.filter(i=>!i.funnel.hasOrder),groups=new Map<string,number>();
  for(const item of missed)groups.set(item.funnel.stage,(groups.get(item.funnel.stage)??0)+1);
  const id=reviewRunId(input.date,input.asOf);
  return {id,date:input.date,generatedAt:input.asOf,windowStartAt:window.start,windowEndAt:window.end,entryMode:input.entryMode,
    counts:{signals:notificationsCount,tokens:items.length,withPerformance:items.filter(i=>i.localPerformance).length,highGainers:high.length,missedHighGainers:missed.length,entered:items.filter(i=>i.funnel.hasOrder).length},
    findings:[...groups].sort((a,b)=>b[1]-a[1]).map(([code,count])=>({code,count,text:explanations[code]})),
    learning:{status:'collecting',priorities:[...cohorts.values()].map(c=>({...c,missing:c.total-c.covered,weight:c.covered<c.total?2:1})),notes:[
      '学习分母包括全部去重信号，含亏损、未选入与缺价；涨幅靠前的案例仅用于定位漏点。',
      '自动调整前向研究采样优先级，保留一半公平采样；不按事后赢家补加开仓分数。',
      '合约安全、来源真实性、仓位上限和实盘开关不由日报放宽。']},
    datasetComplete:input.datasetComplete!==false,limitations:[...new Set([...input.limitations,'只覆盖本机实际接收到并留存的通知，不代表 Ave/DeBot 全站榜单。',
      '本地最高涨幅按同一池或同一类可信采样计算，不是成交收益；缺失与未成熟数据保持未知。',
      '重点案例为本地或平台已知涨幅 ≥100%，或 Ave 展示倍率 ≥2x；倍率保持原单位，重点组内先列百分比、再列只有倍率的案例，不代表收益等值排序。',
      '报告按北京时间自然日接收的信号分组，价格证据截至生成时刻；重复通知不增加独立代币数。'])],items};
}

function parse<T>(value:unknown):T|undefined {try{return value?JSON.parse(String(value)) as T:undefined;}catch{return;}}
function decisionFromScan(r:ScanRecord):ReviewInput['decisions'][number]|undefined {
  if(r.mode!=='live'||!r.decision||!r.evaluatedAt)return;
  return {chain:r.chain,address:r.address,scanId:r.id,decision:r.decision,buyEligible:r.buyEligible===true,at:r.evaluatedAt,
    policyVersion:r.policyVersion??'unknown',reasons:codes(r.reasons),checks:r.checks,frozen:false};
}
/** Source DBs are read-only, each in a short consistent snapshot; no RPC, trading or re-evaluation. */
export function readDailyReviewInput(config:Config,date:string,asOf:string,reviewPath=reviewDatabasePath(config.dashboard.archivePath)):ReviewInput {
  const out:ReviewInput={date,asOf,entryMode:config.entryMode,notifications:[],decisions:[],prices:[],vendor:[],orders:[],executions:[],limitations:[],datasetComplete:true};
  const reportWindow=reviewWindow(date);
  const withDb=(path:string|undefined,label:string,read:(db:DatabaseSync)=>void)=>{
    if(!path||path===':memory:'||!existsSync(path)){out.limitations.push(`${label}未持久化或不可用。`);if(['debot','ave','扫描和后续表现库','独立行情观察库'].includes(label))out.datasetComplete=false;return;}
    const db=new DatabaseSync(path,{readOnly:true});try{db.exec('PRAGMA busy_timeout=1500; BEGIN');read(db);}finally{db.close();}
  };
  const table=(db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const retained=(db:DatabaseSync,name:string,column:string,source:string,capacity:number)=>{
    const pruned=table(db,'review_retention_watermarks')?db.prepare('SELECT pruned_through FROM review_retention_watermarks WHERE source=?').get(source)?.pruned_through:undefined;
    const coverage=db.prepare(`SELECT count(*) n,min(${column}) oldest FROM ${name}`).get()!;
    if(typeof pruned==='string'&&pruned>=reportWindow.start||Number(coverage.n)>=capacity&&typeof coverage.oldest==='string'&&coverage.oldest>reportWindow.start){
      out.datasetComplete=false;out.limitations.push(`${source}源库已修剪或达到容量且缺少日报早段覆盖；暂停以完整分母发布采样计划。`);
    }
  };
  for(const [provider,path] of [['debot',config.debotSignalsDatabase],['ave',config.ave?.database]] as const)withDb(path,provider,db=>{
    const name=provider+'_signals';if(!table(db,name)){out.datasetComplete=false;out.limitations.push(`${provider}通知表不可用。`);return;}
    retained(db,name,'observed_at',provider,10000);
    const rows=db.prepare(`SELECT id,chain,address,occurred_at,observed_at,state,reason,json_extract(payload,'$.name') name,json_extract(payload,'$.symbol') symbol FROM ${name} WHERE observed_at<=? ORDER BY observed_at DESC LIMIT 50001`).all(asOf);
    if(rows.length>50000){out.datasetComplete=false;out.limitations.push(`${provider}通知读取达到上限，报告覆盖不完整。`);}
    for(const r of rows.slice(0,50000))out.notifications.push({chain:r.chain as Chain,address:String(r.address),source:provider,id:String(r.id),receivedAt:String(r.observed_at),occurredAt:String(r.occurred_at),state:String(r.state),reason:safe(r.reason),name:safe(r.name),symbol:safe(r.symbol)});
    if(table(db,'vendor_performance_snapshots'))for(const r of db.prepare('SELECT provider,chain,address,reported_at,data FROM vendor_performance_snapshots WHERE reported_at<=? ORDER BY reported_at,id LIMIT 20001').iterate(asOf)){
      const v=parse<Record<string,any>>(r.data);if(!v)continue;
      out.vendor.push({chain:r.chain as Chain,address:String(r.address),source:provider,reportedAt:String(r.reported_at),scope:'vendor_reported_retrospective',firstSignalAt:v.firstSignalAt,maxGainPct:typeof v.maxGainPct==='number'?v.maxGainPct:undefined,maxGainValue:typeof v.maxGainValue==='number'?v.maxGainValue:undefined,maxGainUnit:v.maxGainUnit,display:safe(v.maxGainDisplay)});
    }
  });
  withDb(config.dashboard.archivePath,'扫描和后续表现库',db=>{
    if(table(db,'scan_summaries'))retained(db,'scan_summaries','received_at','scans',10000);
    const known=new Set(out.notifications.map(n=>`${n.source}:${key(n)}`));
    for(const [name,limit] of [['scan_summaries',20000],['signal_followups',20000]] as const){
      if(!table(db,name)||Number(db.prepare(`SELECT count(*) n FROM ${name}`).get()!.n)>limit){out.datasetComplete=false;out.limitations.push(`${name}覆盖缺失或达到读取上限，暂停更新采样计划。`);}
    }
    if(table(db,'scan_summaries'))for(const row of db.prepare('SELECT record FROM scan_summaries WHERE received_at<=? ORDER BY received_at DESC LIMIT 20001').iterate(asOf)){
      const r=parse<ScanRecord>(row.record);if(!r||r.mode==='demo')continue;
      if(!known.has(`${r.source}:${key(r)}`))out.notifications.push({chain:r.chain,address:r.address,source:r.source,id:r.id,receivedAt:r.receivedAt,occurredAt:r.occurredAt,name:r.name,symbol:r.symbol,state:r.status});
      const d=decisionFromScan(r);if(d)out.decisions.push(d);
    }
    if(table(db,'signal_followups'))for(const row of db.prepare('SELECT record FROM signal_followups WHERE registered_at<=? ORDER BY registered_at DESC LIMIT 20001').iterate(asOf)){
      const r=parse<FollowupRecord>(row.record);if(!r)continue;
      out.decisions.push({chain:r.chain,address:r.address,scanId:r.initial.scanId,decision:r.initial.decision,at:r.initial.evaluatedAt,policyVersion:r.initial.policyVersion,
        reasons:codes(r.initial.reasons),checks:r.initial.checks,buyEligible:r.initial.buyEligible,frozen:true});
      // Old followup chart points do not retain each point's pool; they cannot form a strict same-pool return series.
    }
  });
  withDb(config.meme?.database,'独立行情观察库',db=>{
    if(!table(db,'meme_snapshots')){out.datasetComplete=false;out.limitations.push('独立价格表不可用。');return;}
    const rows=db.prepare(`SELECT chain,address,observed_at,source,json_extract(market,'$.priceUsd') price,json_extract(market,'$.poolAddress') pool,
      json_extract(market,'$.token.chain') market_chain,json_extract(market,'$.token.address') market_address,json_extract(market,'$.observedAt') market_at,
      json_extract(assessment,'$.assessedAt') assessed_at,json_extract(assessment,'$.stage') stage,json_extract(assessment,'$.score') score FROM meme_snapshots
      WHERE observed_at>=? AND observed_at<=? AND market IS NOT NULL ORDER BY observed_at DESC LIMIT 250001`).iterate(reportWindow.start,asOf);
    let priceCount=0;for(const r of rows){if(++priceCount>250000){out.datasetComplete=false;out.limitations.push('独立价格样本达到读取上限，保留覆盖不足标记。');break;}if(r.market_chain!==r.chain||r.market_address!==r.address||r.market_at!==r.observed_at)continue;
      out.prices.push({chain:r.chain as Chain,address:String(r.address),at:String(r.observed_at),price:Number(r.price),source:String(r.source),pool:safe(r.pool,90),assessedAt:validTime(r.assessed_at)&&r.assessed_at<=asOf?r.assessed_at:undefined,stage:validTime(r.assessed_at)&&r.assessed_at<=asOf?safe(r.stage,30):undefined,score:validTime(r.assessed_at)&&r.assessed_at<=asOf&&typeof r.score==='number'?r.score:undefined});}
  });
  withDb(config.ordersDatabase,'订单库',db=>{if(!table(db,'opening_orders')){out.limitations.push('订单表不可用，不能排除已有订单。');return;}
    const rows=db.prepare('SELECT chain,token_address,created_at,status,mode FROM opening_orders WHERE created_at<=? ORDER BY created_at DESC LIMIT 100001').all(asOf);
    if(rows.length>100000){out.datasetComplete=false;out.limitations.push('订单记录读取达到上限，历史开单覆盖不完整。');}
    for(const r of rows.slice(0,100000))out.orders.push({chain:r.chain as Chain,address:String(r.token_address),at:String(r.created_at),status:String(r.status),mode:String(r.mode)});});
  withDb(reviewPath,'执行审计',db=>{
    if(table(db,'vendor_performance_snapshots'))for(const r of db.prepare('SELECT provider,chain,address,reported_at,data FROM vendor_performance_snapshots WHERE reported_at<=? ORDER BY reported_at,id LIMIT 20001').iterate(asOf)){
      const v=parse<Record<string,any>>(r.data);if(!v)continue;
      out.vendor.push({chain:r.chain as Chain,address:String(r.address),source:r.provider as 'ave'|'debot',reportedAt:String(r.reported_at),scope:'vendor_reported_retrospective',firstSignalAt:v.firstSignalAt,maxGainPct:typeof v.maxGainPct==='number'?v.maxGainPct:undefined,maxGainValue:typeof v.maxGainValue==='number'?v.maxGainValue:undefined,maxGainUnit:v.maxGainUnit,display:safe(v.maxGainDisplay)});
    }
    if(table(db,'review_entry_attempts')){const rows=db.prepare('SELECT data FROM review_entry_attempts WHERE at<=? ORDER BY at DESC LIMIT 100001').all(asOf);
      if(rows.length>100000){out.datasetComplete=false;out.limitations.push('执行审计读取达到上限，历史跳过原因覆盖不完整。');}
      for(const r of rows.slice(0,100000)){const v=parse<ReviewExecution>(r.data);if(v)out.executions.push(v);}
    }});
  return out;
}
