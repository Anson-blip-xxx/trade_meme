import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import bs58 from 'bs58';
import type {OpeningOrder,OrderStore} from './orders.js';
import type {Signal} from './types.js';
import {ThirdSignalStrategy,type ThirdSignalActor,type ThirdSignalCandidate,type ThirdSignalPageOptions,type ThirdSignalMode,type ThirdSignalExecution} from './third-signal-strategy.js';

type Identity={chain:Signal['token']['chain'];address:string;recordId:string};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const validSol=(v:unknown):v is string=>{try{return typeof v==='string'&&bs58.decode(v).length===32;}catch{return false;}};
function controlledOpeningIdentities(db:DatabaseSync):Identity[] {
  return db.prepare(`SELECT r.id,r.wallet,r.payload AS run,o.payload AS operation FROM controlled_test_runs r
    JOIN controlled_test_operations o ON o.run_id=r.id AND o.operation_key='buy'`).all().map(row=>{
    const run:unknown=JSON.parse(String(row.run)),op:unknown=JSON.parse(String(row.operation));
    if(!object(run)||!object(op)||!object(op.body)||run.id!==row.id||op.runId!==row.id||op.key!=='buy'||
      run.wallet!==row.wallet||!validSol(run.wallet)||!validSol(run.mint)||op.body.chain!=='sol'||
      op.body.from_address!==run.wallet||op.body.output_token!==run.mint||
      !['submitting','acknowledged','unknown'].includes(String(op.state)))throw Error('HISTORY_INVALID');
    return {chain:'solana' as const,address:run.mint,recordId:`controlled-test:${String(row.id)}`};
  });
}
/** Historical buys include closed positions and uncertain submissions. This never modifies the journal. */
export function readControlledOpeningIdentities(path:string):Identity[] {
  if(!existsSync(path))return [];
  let db:DatabaseSync|undefined;
  try {
    db=new DatabaseSync(path,{readOnly:true});
    return controlledOpeningIdentities(db);
  } catch {throw Error('SIGNAL_COUNTING_OPENING_HISTORY_UNAVAILABLE');}
  finally {db?.close();}
}

interface Observation {signal:Signal;observedAt:string;alertMarketCapUsd?:number;
  marketCapTiming?:'event_snapshot'|'unverified';name?:string;symbol?:string;}
interface Options {
  database:string;controlledJournal:string;orders:OrderStore;
  allowedChains?:readonly Signal['token']['chain'][];
  executionMode?:ThirdSignalMode;
  onCandidate?:(candidate:ThirdSignalCandidate)=>Promise<void>|void;
  executionReady?:()=>{ready:boolean;reason?:string};
  enqueue?:(message:{key:string;text:string})=>boolean;
  /** Total active plus queued candidate callbacks. Production defaults to one worker and a bounded burst. */
  dispatchConcurrency?:number;
  dispatchCapacity?:number;
}
interface QueuedDispatch {candidate:ThirdSignalCandidate;complete:()=>void;}
/** Counts fresh source events; only new live candidates invoke the configured execution callback. */
export class SignalCounting {
  readonly strategy:ThirdSignalStrategy;
  private captureError?:string;
  private historyError?:string;
  private readonly imported=new Set<string>();
  private sentCandidateKeys=new Set<string>();
  private readonly dispatches=new Set<Promise<void>>();
  private readonly dispatchQueue:QueuedDispatch[]=[];
  private readonly dispatchConcurrency:number;
  private readonly dispatchCapacity:number;
  private activeDispatches=0;
  private controlledDb?:DatabaseSync;
  private controlledDataVersion=-1;
  private closed=false;
  constructor(private readonly options:Options) {
    this.dispatchConcurrency=options.dispatchConcurrency??1;
    this.dispatchCapacity=options.dispatchCapacity??32;
    if(!Number.isSafeInteger(this.dispatchConcurrency)||this.dispatchConcurrency<1||this.dispatchConcurrency>16||
      !Number.isSafeInteger(this.dispatchCapacity)||this.dispatchCapacity<this.dispatchConcurrency||this.dispatchCapacity>1000)
      throw Error('SIGNAL_COUNTING_DISPATCH_OPTIONS_INVALID');
    this.strategy=new ThirdSignalStrategy(options.database);
    try{this.importHistory();}catch{this.historyError='SIGNAL_COUNTING_OPENING_HISTORY_UNAVAILABLE';}
  }
  private mark(identity:Identity) {
    const address=identity.chain==='solana'?identity.address:identity.address.toLowerCase();
    const key=`${identity.chain}:${address}:${identity.recordId}`;
    if(this.imported.has(key))return;
    this.strategy.markOpened({...identity,address});
    // The execution journal has its own atomic permanent deny record too.
    this.options.orders.markPreviouslyOpened({...identity,address});
    this.imported.add(key);
  }
  captureOrder(order:OpeningOrder) {
    if(order.mode!=='live'||order.status==='prepared'||order.status==='paper_open'||
      order.status==='failed'&&!this.options.orders.hasAttemptedOpening(order.chain,order.tokenAddress))return;
    this.mark({chain:order.chain,address:order.tokenAddress,recordId:`order:${order.id}`});
  }
  private importHistory() {
    for(let offset=0;;offset+=100){
      const page=this.options.orders.page({limit:100,offset});
      for(const order of page.items)this.captureOrder(order);
      if(!page.hasMore)break;
    }
    this.importControlled(true);
  }
  private importControlled(force=false) {
    if(!existsSync(this.options.controlledJournal))return;
    try {
      this.controlledDb??=new DatabaseSync(this.options.controlledJournal,{readOnly:true});
      const row=this.controlledDb.prepare('PRAGMA data_version').get(),version=Number(row?.data_version);
      if(!Number.isSafeInteger(version))throw Error('SIGNAL_COUNTING_OPENING_HISTORY_UNAVAILABLE');
      if(!force&&version===this.controlledDataVersion)return;
      for(const identity of controlledOpeningIdentities(this.controlledDb))this.mark(identity);
      this.controlledDataVersion=version;this.historyError=undefined;
    }catch{
      try{this.controlledDb?.close();}catch{}
      this.controlledDb=undefined;this.controlledDataVersion=-1;
      this.historyError='SIGNAL_COUNTING_OPENING_HISTORY_UNAVAILABLE';throw Error(this.historyError);
    }
  }
  private readiness():{ready:boolean;reason?:string} {
    if(this.options.executionMode!=='live')return {ready:false};
    if(!this.options.onCandidate)return {ready:false,reason:'THIRD_SIGNAL_EXECUTION_UNAVAILABLE'};
    if(this.historyError)return {ready:false,reason:this.historyError};
    try {
      const result=this.options.executionReady?.()??{ready:true};
      return result.ready?{ready:true}:{ready:false,reason:result.reason&&/^[A-Z][A-Z0-9_]{1,100}$/.test(result.reason)?result.reason:'THIRD_SIGNAL_EXECUTION_UNAVAILABLE'};
    }catch{return {ready:false,reason:'THIRD_SIGNAL_EXECUTION_UNAVAILABLE'};}
  }
  status() {const status=this.strategy.status(),ready=this.readiness();return {...status,
    configuredExecutionMode:this.options.executionMode??'simulation',executionReady:ready.ready,readinessReason:ready.reason,
    executionEnabled:status.executionEnabled&&ready.ready,activeChains:[...this.options.allowedChains??['bsc','solana','robinhood']],
    captureError:this.captureError,historyError:this.historyError};}
  page(options:ThirdSignalPageOptions={}) {return {...this.strategy.list(options),status:this.status()};}
  control(action:'start'|'stop',actor:ThirdSignalActor) {
    if(action==='start'){
      try{this.importHistory();}catch{this.historyError='SIGNAL_COUNTING_OPENING_HISTORY_UNAVAILABLE';throw Error(this.historyError);}
      const readiness=this.readiness();if(this.options.executionMode==='live'&&!readiness.ready)throw Error(readiness.reason??'THIRD_SIGNAL_EXECUTION_UNAVAILABLE');
      this.strategy.start(actor,this.options.executionMode??'simulation');
    } else if(action==='stop')this.strategy.stop(actor);
    else throw Error('SIGNAL_COUNTING_ACTION_INVALID');
    return this.status();
  }
  controlText() {
    const s=this.status();
    const live=s.running?s.mode==='live':s.configuredExecutionMode==='live';
    return `【计数控制】\n${live?'实盘计数':'模拟计数'}：${s.running?'运行中':'已停止'} · ${s.executionEnabled?'达标自动实盘买入':live?'启动后达标自动实盘买入':'不执行实盘'}\n`+
      `处理链：${s.activeChains.map(c=>c==='solana'?'SOL':c==='bsc'?'BSC':'Robinhood').join(' / ')}\n`+
      `DeBot / Ave 分别累计；同一链＋CA 第 3 次市值 ≤ $100,000。\n`+
      `每条新通知续期 6 小时；停止后重新启动从零计数。\n`+
      `已收 ${s.events} 条 · ${s.groups} 组 · ${s.mode==='live'?'实盘候选':'模拟达标'} ${s.candidates} 个\n`+
      `永久防重 ${s.globalClaims} 个；已有开仓不会再次触发。\n`+
      `停止计数不影响现有持仓监控。`+(live&&!s.executionReady?`\n实盘未就绪：${s.readinessReason??'THIRD_SIGNAL_EXECUTION_UNAVAILABLE'}`:'')+
      (s.captureError||s.historyError?'\n状态异常，请查看 Web 系统状态。':'');
  }
  observe(observation:Observation) {
    const signal=observation.signal;if(signal.source!=='ave'&&signal.source!=='debot')return;
    if(this.options.allowedChains&&!this.options.allowedChains.includes(signal.token.chain))return;
    try {
      // Check newly submitted external controlled tests before evaluating another candidate.
      this.importControlled();
      const result=this.strategy.observe({source:signal.source,chain:signal.token.chain,address:signal.token.address,
        eventId:signal.sourceEventId,occurredAt:signal.occurredAt,receivedAt:observation.observedAt,
        name:observation.name,symbol:observation.symbol,
        marketCapUsd:signal.source==='debot'&&observation.marketCapTiming!=='event_snapshot'?undefined:observation.alertMarketCapUsd});
      this.captureError=undefined;
      if(result.candidate){
        if(result.candidate.mode==='live')this.dispatchCandidate(result.candidate);
        try{this.notifyCandidate(result.candidate);}catch{this.captureError='SIGNAL_COUNTING_NOTIFICATION_FAILED';}
      }
      return result;
    } catch {this.captureError='SIGNAL_COUNTING_CAPTURE_FAILED';return;}
  }
  private notifyCandidate(candidate:ThirdSignalCandidate) {
    if(this.options.allowedChains&&!this.options.allowedChains.includes(candidate.chain))return;
    const key=`third-signal:candidate:${candidate.id}`;
    if(!this.options.enqueue||this.sentCandidateKeys.has(key))return;
    const name=(candidate.name??candidate.symbol??'未命名').replace(/[\r\n]/g,' ');
    this.options.enqueue({key,text:`【${candidate.mode==='live'?'实盘信号达标':'信号模拟达标'}】\n${name} · ${candidate.chain==='solana'?'SOL':candidate.chain==='bsc'?'BSC':'Robinhood'}\n`+
      `来源：${candidate.source==='debot'?'DeBot':'Ave'} · 本轮第 3 次\nCA：${candidate.address}\n`+
      `第三次市值：$${candidate.marketCapUsd.toLocaleString('en-US',{maximumFractionDigits:2})}\n`+
      `接收时间：${new Date(candidate.receivedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}\n`+
      (candidate.mode==='live'?`结果：已交给实盘开仓流程，成交结果另行通知。\n同一链＋CA 已锁定，避免重复提交。`:
        `结果：模拟达标；未下实盘单。\n同一链＋CA 已进入模拟防重；不影响首次实盘。`)});
    this.sentCandidateKeys.add(key);
  }
  tick() {
    if(this.options.executionMode==='live')return;
    try {
      for(let offset=0;;offset+=200){
        const page=this.strategy.candidates({limit:200,offset});
        for(const candidate of page.items)if(candidate.mode==='simulation')this.notifyCandidate(candidate);
        if(!page.hasMore)break;
      }
    }catch{this.captureError='SIGNAL_COUNTING_NOTIFICATION_FAILED';}
  }
  isActive(candidate:ThirdSignalCandidate):boolean {
    return !this.closed&&this.readiness().ready&&
      (!this.options.allowedChains||this.options.allowedChains.includes(candidate.chain))&&this.strategy.isActive(candidate);
  }
  private dispatchCandidate(candidate:ThirdSignalCandidate):void {
    if(!this.options.onCandidate||!this.strategy.claimDispatch(candidate))return;
    if(this.activeDispatches+this.dispatchQueue.length>=this.dispatchCapacity){
      this.failDispatch(candidate,'THIRD_SIGNAL_DISPATCH_QUEUE_FULL');return;
    }
    let resolve!:()=>void;
    const completion=new Promise<void>(done=>{resolve=done;});
    const complete=()=>{this.dispatches.delete(completion);resolve();};
    this.dispatches.add(completion);this.dispatchQueue.push({candidate,complete});
    // Deliberately synchronous: the first free handler reaches its first await
    // before the source callback continues into slower research observers.
    this.drainDispatches();
  }
  private failDispatch(candidate:ThirdSignalCandidate,why:unknown):void {
    const reason=why instanceof Error&&/^[A-Z][A-Z0-9_]{1,100}$/.test(why.message)?why.message:
      typeof why==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(why)?why:'THIRD_SIGNAL_ENTRY_CALLBACK_FAILED';
    if(this.closed)return;
    try{this.strategy.finishDispatch(candidate,reason);}catch{this.captureError='SIGNAL_COUNTING_CAPTURE_FAILED';}
    try{this.options.enqueue?.({key:`third-signal:dispatch-failed:${candidate.id}`,text:
      `【开仓未完成】\n${candidate.name??candidate.symbol??'未命名'} · ${candidate.chain==='solana'?'SOL':candidate.chain}\nCA：${candidate.address}\n原因：${reason}\n本次不自动重复提交；如已有提交记录，以订单查询结果为准。`});}catch{}
  }
  private drainDispatches():void {
    while(!this.closed&&this.activeDispatches<this.dispatchConcurrency&&this.dispatchQueue.length){
      const item=this.dispatchQueue.shift()!;this.activeDispatches++;
      let operation:Promise<void>;
      try {
        if(!this.isActive(item.candidate))throw Error('THIRD_SIGNAL_RUN_STOPPED');
        // Calling before Promise.resolve is intentional: async handlers execute
        // synchronously through their first await in this same source-event stack.
        operation=Promise.resolve(this.options.onCandidate!(item.candidate)).then(()=>{
          if(!this.closed)this.strategy.finishDispatch(item.candidate);
        });
      }catch(error){operation=Promise.reject(error);}
      void operation.catch(error=>this.failDispatch(item.candidate,error)).finally(()=>{
        this.activeDispatches--;item.complete();this.drainDispatches();
      });
    }
  }
  recordExecution(candidate:ThirdSignalCandidate,execution:ThirdSignalExecution):void {this.strategy.recordExecution(candidate,execution);}
  async waitForDispatches():Promise<void> {
    // Work can be enqueued while an active callback is settling. A one-time
    // snapshot can therefore return while the newly started callback is still
    // running. Keep observing the live set until both workers and queue drain.
    for(;;){
      const pending=[...this.dispatches];
      if(!pending.length&&this.activeDispatches===0&&!this.dispatchQueue.length)return;
      if(pending.length)await Promise.allSettled(pending);
      else await new Promise<void>(resolve=>setImmediate(resolve));
    }
  }
  close(){
    if(this.closed)return;
    // Normal runtime shutdown waits before close. Direct callers still get a
    // durable terminal outcome for queued callbacks and no unresolved promise.
    while(this.dispatchQueue.length){
      const item=this.dispatchQueue.shift()!;
      this.failDispatch(item.candidate,'THIRD_SIGNAL_SERVICE_CLOSED');item.complete();
    }
    this.closed=true;this.controlledDb?.close();this.strategy.close();
  }
}
