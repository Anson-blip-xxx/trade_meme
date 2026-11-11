import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import bs58 from 'bs58';
import type {OpeningOrder,OrderStore} from './orders.js';
import type {Signal} from './types.js';
import {ThirdSignalStrategy,type ThirdSignalActor,type ThirdSignalCandidate,type ThirdSignalPageOptions,type ThirdSignalMode,
  type ThirdSignalExecution,type ThirdSignalNotificationSnapshot,type ThirdSignalStatus} from './third-signal-strategy.js';

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

export interface SignalCountingObservation {signal:Signal;observedAt:string;alertMarketCapUsd?:number;
  marketCapTiming?:'event_snapshot'|'unverified';marketSnapshotAt?:string;alertPriceUsd?:number;currentPriceUsd?:number;
  liquidityUsd?:number;poolAddress?:string;name?:string;symbol?:string;
  walletCount?:number;addressCount?:number;vendorWalletCount?:number;
  vendorWallets?:readonly {address?:string;alias?:string;side?:'buy'|'sell';lastTradeAt?:string;volumeUsd?:number;priceUsd?:number;}[];}
interface Options {
  database:string;controlledJournal:string;orders:OrderStore;
  allowedChains?:readonly Signal['token']['chain'][];
  executionMode?:ThirdSignalMode;
  onCandidate?:(candidate:ThirdSignalCandidate)=>Promise<void>|void;
  /** Project immutable live N3/N4 snapshots into the independent quote store.
   * Delivery is post-commit, idempotent and retried from the counting ledger. */
  onForwardTarget?:(snapshot:Readonly<ThirdSignalNotificationSnapshot>)=>Promise<void>|void;
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
  private storageUnavailable=false;
  private captureError?:string;
  /** In-memory gate for the source fast path.  A stopped counter never opens
   * SQLite for an incoming source event; a failed best-effort capture latches
   * this gate shut so a later event cannot trade from an incomplete run. */
  private acceptingObservations=false;
  private activeRunMode:ThirdSignalMode='simulation';
  private captureDegraded=false;
  private historyError?:string;
  private readonly imported=new Set<string>();
  private sentCandidateKeys=new Set<string>();
  private readonly dispatches=new Set<Promise<void>>();
  private readonly dispatchQueue:QueuedDispatch[]=[];
  private readonly dispatchConcurrency:number;
  private readonly dispatchCapacity:number;
  private activeDispatches=0;
  private readonly postCommitWork:(()=>void)[]=[];
  private readonly postCommitFailures:ThirdSignalCandidate[]=[];
  private postCommitImmediate?:ReturnType<typeof setImmediate>;
  private readonly forwardTargetSynced=new Set<string>();
  private readonly forwardTargetPending=new Set<string>();
  private readonly forwardTargetWork=new Set<Promise<void>>();
  private forwardTargetReconcileQueued=false;private forwardTargetOffset=0;private forwardTargetError?:string;
  private controlledDb?:DatabaseSync;
  private controlledDataVersion=-1;
  private closed=false;
  constructor(private readonly options:Options) {
    this.dispatchConcurrency=options.dispatchConcurrency??1;
    this.dispatchCapacity=options.dispatchCapacity??32;
    if(!Number.isSafeInteger(this.dispatchConcurrency)||this.dispatchConcurrency<1||this.dispatchConcurrency>16||
      !Number.isSafeInteger(this.dispatchCapacity)||this.dispatchCapacity<this.dispatchConcurrency||this.dispatchCapacity>1000)
      throw Error('SIGNAL_COUNTING_DISPATCH_OPTIONS_INVALID');
    try{this.strategy=new ThirdSignalStrategy(options.database);}
    catch{
      // Counting is an optional execution gate.  A corrupt or unwritable count
      // database must leave source collection alive, while trading stays closed.
      this.strategy=new ThirdSignalStrategy(':memory:');this.storageUnavailable=true;
      this.captureError='SIGNAL_COUNTING_STORAGE_UNAVAILABLE';this.captureDegraded=true;
      return;
    }
    const restored=this.strategy.status();
    this.acceptingObservations=restored.running;this.activeRunMode=restored.mode;
    try{this.importHistory();}catch{this.historyError='SIGNAL_COUNTING_OPENING_HISTORY_UNAVAILABLE';}
    this.scheduleForwardTargetReconciliation();
  }
  private mark(identity:Identity) {
    const address=identity.chain==='solana'?identity.address:identity.address.toLowerCase();
    const key=`${identity.chain}:${address}:${identity.recordId}`;
    if(this.imported.has(key))return;
    if(!this.storageUnavailable)this.strategy.markOpened({...identity,address});
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
    if(this.storageUnavailable)return {ready:false,reason:'SIGNAL_COUNTING_STORAGE_UNAVAILABLE'};
    if(this.options.executionMode!=='live')return {ready:false};
    if(!this.options.onCandidate)return {ready:false,reason:'THIRD_SIGNAL_EXECUTION_UNAVAILABLE'};
    if(this.historyError)return {ready:false,reason:this.historyError};
    try {
      const result=this.options.executionReady?.()??{ready:true};
      return result.ready?{ready:true}:{ready:false,reason:result.reason&&/^[A-Z][A-Z0-9_]{1,100}$/.test(result.reason)?result.reason:'THIRD_SIGNAL_EXECUTION_UNAVAILABLE'};
    }catch{return {ready:false,reason:'THIRD_SIGNAL_EXECUTION_UNAVAILABLE'};}
  }
  /** Constant-time execution gate for health checks and runtime scheduling.
   * Exact run counters remain available through status()/page(). */
  executionState() {
    const captureReady=!this.captureDegraded,ready=this.readiness();
    const running=!this.storageUnavailable&&captureReady&&this.acceptingObservations;
    return {running,executionEnabled:running&&this.activeRunMode==='live'&&ready.ready,
      executionReady:ready.ready&&captureReady,
      ...(this.captureDegraded?{readinessReason:'SIGNAL_COUNTING_CAPTURE_FAILED'}:
        ready.reason?{readinessReason:ready.reason}:{})};
  }
  status() {const status:ThirdSignalStatus=this.storageUnavailable?{mode:'simulation',executionEnabled:false,running:false,
      ttlMs:6*60*60*1000,maxSignalAgeMs:120000,triggerCount:3 as const,maxMarketCapUsd:100000,
      groups:0,events:0,candidates:0,repeatBlocked:0,globalClaims:0}:this.strategy.status(),
    ready=this.readiness(),captureReady=!this.captureDegraded;return {...status,
    storageRunning:status.running,running:status.running&&captureReady&&this.acceptingObservations,
    configuredExecutionMode:this.options.executionMode??'simulation',executionReady:ready.ready&&captureReady,
    readinessReason:this.captureDegraded?'SIGNAL_COUNTING_CAPTURE_FAILED':ready.reason,
    executionEnabled:status.executionEnabled&&ready.ready&&captureReady&&this.acceptingObservations,
    activeChains:[...this.options.allowedChains??['bsc','solana','robinhood']],
    captureError:this.captureError,captureDegraded:this.captureDegraded,historyError:this.historyError,forwardTargetError:this.forwardTargetError,
    forwardTargetSync:{synced:this.forwardTargetSynced.size,pending:this.forwardTargetPending.size}};}
  page(options:ThirdSignalPageOptions={}) {
    if(!this.storageUnavailable)return {...this.strategy.list(options),status:this.status()};
    const limit=options.limit??20,offset=options.offset??0;
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0)throw Error('THIRD_SIGNAL_PAGE_INVALID');
    return {mode:'simulation' as const,executionEnabled:false,runId:undefined,items:[],total:0,limit,offset,hasMore:false,status:this.status()};
  }
  control(action:'start'|'stop',actor:ThirdSignalActor) {
    if(action!=='start'&&action!=='stop')throw Error('SIGNAL_COUNTING_ACTION_INVALID');
    if(this.storageUnavailable){this.acceptingObservations=false;
      if(action==='start')throw Error('SIGNAL_COUNTING_STORAGE_UNAVAILABLE');
      return this.status();
    }
    if(action==='start'){
      try{this.importHistory();}catch{
        this.acceptingObservations=false;this.historyError='SIGNAL_COUNTING_OPENING_HISTORY_UNAVAILABLE';throw Error(this.historyError);
      }
      const readiness=this.readiness();if(this.options.executionMode==='live'&&!readiness.ready)throw Error(readiness.reason??'THIRD_SIGNAL_EXECUTION_UNAVAILABLE');
      // A degraded run has missed at least one source event.  Never resume it:
      // an explicit start creates a fresh run only after SQLite is writable.
      this.acceptingObservations=false;
      try {
        if(this.captureDegraded)this.strategy.stop(actor);
        const started=this.strategy.start(actor,this.options.executionMode??'simulation');
        this.acceptingObservations=started.running;this.activeRunMode=started.mode;
        this.captureDegraded=false;this.captureError=undefined;
      } catch(error) {
        this.captureError='SIGNAL_COUNTING_CAPTURE_FAILED';this.captureDegraded=true;this.acceptingObservations=false;throw error;
      }
    } else if(action==='stop'){
      // Revoke permission before touching SQLite so a busy stop transaction is
      // still fail-closed for every subsequently arriving source event.
      this.acceptingObservations=false;
      try{const stopped=this.strategy.stop(actor);this.activeRunMode=stopped.mode;}
      catch(error){this.captureError='SIGNAL_COUNTING_CAPTURE_FAILED';this.captureDegraded=true;throw error;}
    }
    else throw Error('SIGNAL_COUNTING_ACTION_INVALID');
    this.scheduleForwardTargetReconciliation();return this.status();
  }
  controlText() {
    const s=this.status();
    const live=s.running?s.mode==='live':s.configuredExecutionMode==='live';
    return `【计数控制】\n${live?'自动交易许可':'模拟计数'}：${s.running?(live?'已开启':'运行中'):(live?'已关闭':'已停止')} · ${s.executionEnabled?'第 3 次达标自动实盘买入':live?'信号照常采集；不开仓':'不执行实盘'}\n`+
      `处理链：${s.activeChains.map(c=>c==='solana'?'SOL':c==='bsc'?'BSC':'Robinhood').join(' / ')}\n`+
      `DeBot / Ave 分别累计；同一链＋CA 第 3 次市值 ≤ $100,000。\n`+
      `每条新通知续期 6 小时；停止后重新启动从零计数。\n`+
      `已收 ${s.events} 条 · ${s.groups} 组 · ${s.mode==='live'?'实盘候选':'模拟达标'} ${s.candidates} 个\n`+
      `永久防重 ${s.globalClaims} 个；已有开仓不会再次触发。\n`+
      `DeBot / Ave 的采集、去重、详情、报价跟踪和复盘始终运行；本开关只是自动交易许可，并控制本轮第 3 次计数。\n`+
      `停止计数不影响信号采集或现有持仓监控。`+(live&&!s.executionReady?`\n实盘未就绪：${s.readinessReason??'THIRD_SIGNAL_EXECUTION_UNAVAILABLE'}`:'')+
      (s.captureError||s.historyError?'\n状态异常，请查看 Web 系统状态。':'');
  }
  private input(observation:SignalCountingObservation) {
    const signal=observation.signal;
    const source=signal.source as 'debot'|'ave',debot=source==='debot';
    return {source:signal.source as 'debot'|'ave',chain:signal.token.chain,address:signal.token.address,
      eventId:signal.sourceEventId,occurredAt:signal.occurredAt,receivedAt:observation.observedAt,
      name:observation.name,symbol:observation.symbol,
      marketCapUsd:debot&&observation.marketCapTiming!=='event_snapshot'?undefined:observation.alertMarketCapUsd,
      notificationEvidence:{
        ...(debot?observation.alertPriceUsd!==undefined?{priceUsd:observation.alertPriceUsd}:{}:
          observation.currentPriceUsd!==undefined?{priceUsd:observation.currentPriceUsd}:{}),
        ...(observation.alertMarketCapUsd!==undefined?{marketCapUsd:observation.alertMarketCapUsd}:{}),
        ...(observation.liquidityUsd!==undefined?{liquidityUsd:observation.liquidityUsd}:{}),
        ...(observation.poolAddress?{poolAddress:observation.poolAddress}:{}),
        marketObservedAt:debot?observation.marketSnapshotAt??observation.observedAt:observation.observedAt,
        marketTiming:debot?observation.marketCapTiming??'unverified':'receipt_snapshot' as const,
        ...(signal.claimedPlatform?{claimedPlatform:signal.claimedPlatform}:{}),
        ...((debot?observation.walletCount:observation.vendorWalletCount)!==undefined?
          {reportedWalletCount:debot?observation.walletCount:observation.vendorWalletCount}:{}),
        ...(debot&&observation.addressCount!==undefined?{identifiedWalletCount:observation.addressCount}:{}),
        ...(observation.vendorWallets?.length?{wallets:observation.vendorWallets}:{}),
      }};
  }
  private observeInternal(observation:SignalCountingObservation,strict:boolean) {
    const signal=observation.signal;if(signal.source!=='ave'&&signal.source!=='debot')return;
    if(this.options.allowedChains&&!this.options.allowedChains.includes(signal.token.chain))return;
    // Collection is independent from this optional run.  In particular, do
    // not even read the counting database while the user has stopped counting
    // or after a capture failure has made the current run incomplete.
    if(!this.acceptingObservations)return;
    let result:ReturnType<ThirdSignalStrategy['observe']>;
    try {
      // Check newly submitted external controlled tests before evaluating another candidate.
      this.importControlled();
      result=this.strategy.observe(this.input(observation));
      this.captureError=undefined;
    } catch(error) {
      this.captureError='SIGNAL_COUNTING_CAPTURE_FAILED';
      this.captureDegraded=true;this.acceptingObservations=false;
      if(strict)throw error;
      return;
    }
    // The source inbox may acknowledge this observation after strategy.observe
    // commits it. Failures in execution dispatch or notification must not replay
    // the already-counted source event.
    if(result.count===3||result.count===4)this.scheduleForwardTargetReconciliation();
    if(result.candidate){
      if(result.candidate.mode==='live')try{this.dispatchCandidate(result.candidate);}
      catch{this.captureError='SIGNAL_COUNTING_CAPTURE_FAILED';}
      try{this.notifyCandidate(result.candidate);}catch{this.captureError='SIGNAL_COUNTING_NOTIFICATION_FAILED';}
    }
    return result;
  }
  observe(observation:SignalCountingObservation) {return this.observeInternal(observation,false);}
  /** Strict source-inbox handoff: throws until the observation is durably counted. */
  observePriority(observation:SignalCountingObservation) {return this.observeInternal(observation,true);}
  /** Strict page handoff. The entire accepted page commits atomically; execution
   * and notifications begin only after that commit and can never replay it. */
  observePriorityBatch(observations:readonly SignalCountingObservation[]) {
    if(!Array.isArray(observations)||observations.length>100)throw Error('SIGNAL_COUNTING_BATCH_INVALID');
    const accepted=observations.filter(observation=>(observation.signal.source==='ave'||observation.signal.source==='debot')&&
      (!this.options.allowedChains||this.options.allowedChains.includes(observation.signal.token.chain)));
    if(!accepted.length)return [];
    if(!this.acceptingObservations)return [];
    let results:ReturnType<ThirdSignalStrategy['observeBatch']>;
    try {
      this.importControlled();results=this.strategy.observeBatch(accepted.map(observation=>this.input(observation)));
      this.captureError=undefined;
    }catch(error){this.captureError='SIGNAL_COUNTING_CAPTURE_FAILED';this.captureDegraded=true;this.acceptingObservations=false;throw error;}
    if(results.some(result=>result.count===3||result.count===4))this.scheduleForwardTargetReconciliation();
    const candidates=results.flatMap(result=>result.candidate?[result.candidate]:[]);
    const live=candidates.filter(candidate=>candidate.mode==='live');
    if(live.length&&this.options.onCandidate)try {
      const claimed=this.strategy.claimDispatchBatch(live);
      for(let index=0;index<live.length;index++)if(claimed[index])this.queueClaimedCandidate(live[index],false);
      // Preserve the original crash window: available execution workers reach
      // their first await before the source inbox marks this page forwarded.
      this.drainDispatches();
    }catch{this.captureError='SIGNAL_COUNTING_CAPTURE_FAILED';}
    // Telegram persistence is not part of the source ACK and may be much slower
    // than local entry preflight, so run only notifications on the next turn.
    this.schedulePostCommit(()=>{
      for(const candidate of candidates)try{this.notifyCandidate(candidate);}
      catch{this.captureError='SIGNAL_COUNTING_NOTIFICATION_FAILED';}
    });
    return results;
  }
  /** Source-facing page capture.  Counting storage is deliberately
   * best-effort: the source scanner may ACK its own durable inbox even when the
   * separate counter is busy/full/corrupt.  Any failure latches execution off
   * for the rest of this run; an explicit start is required to create a clean
   * run. */
  observeBatch(observations:readonly SignalCountingObservation[]) {
    if(!this.acceptingObservations)return [];
    try{return this.observePriorityBatch(observations);}
    catch{this.captureError='SIGNAL_COUNTING_CAPTURE_FAILED';this.captureDegraded=true;this.acceptingObservations=false;return [];}
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
    if(this.storageUnavailable)return;
    this.scheduleForwardTargetReconciliation();
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
    return !this.storageUnavailable&&!this.closed&&!this.captureDegraded&&this.acceptingObservations&&this.readiness().ready&&
      (!this.options.allowedChains||this.options.allowedChains.includes(candidate.chain))&&this.strategy.isActive(candidate);
  }
  private dispatchCandidate(candidate:ThirdSignalCandidate):void {
    if(!this.options.onCandidate||!this.strategy.claimDispatch(candidate))return;
    this.queueClaimedCandidate(candidate);
  }
  private forwardTargetKey(snapshot:ThirdSignalNotificationSnapshot):string {
    return `${snapshot.runId}:${snapshot.source}:${snapshot.chain}:${snapshot.address}:${snapshot.windowId}:${snapshot.ordinal}`;
  }
  private deliverForwardTarget(snapshot:ThirdSignalNotificationSnapshot):void {
    const callback=this.options.onForwardTarget;if(!callback||this.closed)return;
    const key=this.forwardTargetKey(snapshot);if(this.forwardTargetSynced.has(key)||this.forwardTargetPending.has(key))return;
    this.forwardTargetPending.add(key);
    let result:Promise<void>|void;
    try {result=callback(snapshot);}
    catch {this.forwardTargetPending.delete(key);this.forwardTargetError='SIGNAL_FORWARD_TARGET_SYNC_FAILED';return;}
    let work!:Promise<void>;
    work=Promise.resolve(result).then(()=>{if(!this.closed)this.forwardTargetSynced.add(key);this.forwardTargetError=undefined;},
      ()=>{this.forwardTargetError='SIGNAL_FORWARD_TARGET_SYNC_FAILED';}).finally(()=>{
      this.forwardTargetPending.delete(key);this.forwardTargetWork.delete(work);
    });
    this.forwardTargetWork.add(work);
  }
  private scheduleForwardTargetReconciliation():void {
    if(this.storageUnavailable||this.closed||!this.options.onForwardTarget||this.forwardTargetReconcileQueued)return;
    this.forwardTargetReconcileQueued=true;
    this.schedulePostCommit(()=>{
      this.forwardTargetReconcileQueued=false;if(this.closed)return;
      let page:ReturnType<ThirdSignalStrategy['forwardTargetSnapshots']>;
      try {page=this.strategy.forwardTargetSnapshots({limit:100,offset:this.forwardTargetOffset});}
      catch {this.forwardTargetOffset=0;this.forwardTargetError='SIGNAL_FORWARD_TARGET_RECONCILE_FAILED';return;}
      for(const snapshot of page.items)this.deliverForwardTarget(snapshot);
      if(page.hasMore){this.forwardTargetOffset+=page.items.length;this.scheduleForwardTargetReconciliation();}
      else this.forwardTargetOffset=0;
    });
  }
  private schedulePostCommit(work:()=>void):void {
    if(this.closed)return;this.postCommitWork.push(work);this.armPostCommit();
  }
  private armPostCommit():void {
    if(this.closed||this.postCommitImmediate||!this.postCommitWork.length)return;
    this.postCommitImmediate=setImmediate(()=>{
      this.postCommitImmediate=undefined;
      const queued=this.postCommitWork.splice(0);
      for(const task of queued)try{task();}catch{this.captureError='SIGNAL_COUNTING_CAPTURE_FAILED';}
      this.armPostCommit();
    });
    this.postCommitImmediate.unref?.();
  }
  private queueClaimedCandidate(candidate:ThirdSignalCandidate,start=true):void {
    if(this.activeDispatches+this.dispatchQueue.length>=this.dispatchCapacity){
      if(start)this.failDispatch(candidate,'THIRD_SIGNAL_DISPATCH_QUEUE_FULL');
      else {
        this.postCommitFailures.push(candidate);this.schedulePostCommit(()=>{
          const index=this.postCommitFailures.findIndex(item=>item.id===candidate.id);if(index>=0)this.postCommitFailures.splice(index,1);
          this.failDispatch(candidate,'THIRD_SIGNAL_DISPATCH_QUEUE_FULL');
        });
      }
      return;
    }
    let resolve!:()=>void;
    const completion=new Promise<void>(done=>{resolve=done;});
    const complete=()=>{this.dispatches.delete(completion);resolve();};
    this.dispatches.add(completion);this.dispatchQueue.push({candidate,complete});
    // Deliberately synchronous: the first free handler reaches its first await
    // before the source callback continues into slower research observers.
    if(start)this.drainDispatches();
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
  recordExecution(candidate:ThirdSignalCandidate,execution:ThirdSignalExecution):void {
    if(!this.storageUnavailable)this.strategy.recordExecution(candidate,execution);
  }
  async waitForDispatches():Promise<void> {
    // Work can be enqueued while an active callback is settling. A one-time
    // snapshot can therefore return while the newly started callback is still
    // running. Keep observing the live set until both workers and queue drain.
    for(;;){
      if(this.postCommitImmediate||this.postCommitWork.length){
        await new Promise<void>(resolve=>setImmediate(resolve));continue;
      }
      const pending=[...this.dispatches,...this.forwardTargetWork];
      if(!pending.length&&this.activeDispatches===0&&!this.dispatchQueue.length&&!this.forwardTargetReconcileQueued)return;
      if(pending.length)await Promise.allSettled(pending);
      else await new Promise<void>(resolve=>setImmediate(resolve));
    }
  }
  close(){
    if(this.closed)return;
    if(this.postCommitImmediate)clearImmediate(this.postCommitImmediate);
    this.postCommitImmediate=undefined;this.postCommitWork.length=0;this.forwardTargetReconcileQueued=false;
    while(this.postCommitFailures.length)this.failDispatch(this.postCommitFailures.shift()!,'THIRD_SIGNAL_DISPATCH_QUEUE_FULL');
    // Normal runtime shutdown waits before close. Direct callers still get a
    // durable terminal outcome for queued callbacks and no unresolved promise.
    while(this.dispatchQueue.length){
      const item=this.dispatchQueue.shift()!;
      this.failDispatch(item.candidate,'THIRD_SIGNAL_SERVICE_CLOSED');item.complete();
    }
    this.closed=true;this.controlledDb?.close();this.strategy.close();
  }
}
