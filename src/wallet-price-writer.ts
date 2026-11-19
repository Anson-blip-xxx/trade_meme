import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {WalletHistoryToken} from './wallet-history.js';

export interface WalletPriceWriterOptions {
  database:string;
  maxBytes:number;
  maxPendingTargets?:number;
  batchSize?:number;
  buyerBatchSize?:number;
  maxAttempts?:number;
  restartDelayMs?:number;
  workerTimeoutMs?:number;
}

export interface WalletPriceWriterStatus {
  state:'idle'|'starting'|'ready'|'stopping'|'stopped';
  running:boolean;ready:boolean;recovering:boolean;pendingTargets:number;inFlight:number;maxPendingTargets:number;
  accepted:number;coalesced:number;rejectedCapacity:number;rejectedClosed:number;
  completed:number;failedAttempts:number;terminalFailures:number;droppedAfterRetries:number;retryCapacityDrops:number;droppedOnStop:number;
  durabilityBoundary:'worker_ack';durableIngressAccepted:number;durablePendingJobs:number;retainedRecoverableOnStop:number;
  unconfirmedOnStop:number;durableInventoryUnconfirmedOnStop:boolean;
  priceRowsStored:number;buyerEventsScanned:number;buyerWalletsProjected:number;
  restarts:number;lastBatchMs:number;maxBatchMs:number;oldestPendingMs:number;
  lastEnqueuedAt?:string;lastCompletedAt?:string;error?:string;closeError?:'WALLET_PRICE_WRITER_STOP_TIMEOUT';
}

export interface WalletPriceWorkItem {
  key:string;sequence:number;target:WalletHistoryToken;priceUsd:number;observedAt:string;provider:string;
  attempts:number;enqueuedAt:number;
}

export type WalletPriceDurableFailureReason =
  'WALLET_PRICE_INPUT_INVALID'|'WALLET_PRICE_WRITE_QUEUE_FULL'|'WALLET_PRICE_WRITE_FAILED'|'WALLET_PRICE_WRITER_UNAVAILABLE';
export type WalletPriceDurableAdmission = {accepted:true}|{accepted:false;reason:WalletPriceDurableFailureReason};

interface WorkerFailure {index:number;reason:string;retryable:boolean;}
interface WorkerIngressResult {
  type:'ingress_result';batchId:number;completed:number;failed:WorkerFailure[];elapsedMs:number;
  priceRowsStored:number;pendingAccepted:number;pendingJobs:number;
}
interface WorkerProjectionResult {
  type:'projection';jobsCompleted:number;buyerEventsScanned:number;buyerWalletsProjected:number;
  batches:number;pending:boolean;pendingJobs:number;elapsedMs:number;capacityReached:boolean;
}
interface DrainWaiter {finish:(drained:boolean)=>void;timer:ReturnType<typeof setTimeout>;}
type DurableWaiter=(result:WalletPriceDurableAdmission)=>void;

const CHAINS=new Set(['bsc','solana','robinhood']);
const SOURCE=/^[a-z][a-z0-9_.:-]{0,79}$/;

/**
 * A bounded quote FIFO to the wallet-history worker. Distinct samples from one
 * token are never overwritten: the worker durably admits every quote before a
 * separate short-transaction projector consumes historical buyer pages.
 */
export class WalletPriceWriterRunner {
  private readonly maxPendingTargets:number;
  private readonly batchSize:number;
  private readonly buyerBatchSize:number;
  private readonly maxAttempts:number;
  private readonly restartDelayMs:number;
  private readonly workerTimeoutMs:number;
  private readonly pending=new Map<string,WalletPriceWorkItem>();
  private readonly drainWaiters=new Set<DrainWaiter>();
  private readonly durableWaiters=new Map<string,Set<DurableWaiter>>();
  private worker?:Worker;
  private retry?:ReturnType<typeof setTimeout>;
  private watchdog?:ReturnType<typeof setInterval>;
  private dispatchTimer?:ReturnType<typeof setImmediate>;
  private inFlight?:{id:number;items:WalletPriceWorkItem[];startedAt:number};
  private shutdownBatchId?:number;
  private sequence=0;
  private batchId=0;
  private state:WalletPriceWriterStatus['state']='idle';
  private accepting=true;
  private ready=false;
  private recovering=false;
  private projectionIdle=false;
  private accepted=0;
  private coalesced=0;
  private rejectedCapacity=0;
  private rejectedClosed=0;
  private completed=0;
  private failedAttempts=0;
  private terminalFailures=0;
  private droppedAfterRetries=0;
  private retryCapacityDrops=0;
  private droppedOnStop=0;
  private durableIngressAccepted=0;
  private durablePendingJobs=0;
  private retainedRecoverableOnStop=0;
  private unconfirmedOnStop=0;
  private durableInventoryUnconfirmedOnStop=false;
  private priceRowsStored=0;
  private buyerEventsScanned=0;
  private buyerWalletsProjected=0;
  private restarts=0;
  private lastBatchMs=0;
  private maxBatchMs=0;
  private lastEnqueuedAt?:string;
  private lastCompletedAt?:string;
  private error?:string;
  private closeError?:'WALLET_PRICE_WRITER_STOP_TIMEOUT';
  private stopPromise?:Promise<boolean>;

  constructor(private readonly options:WalletPriceWriterOptions) {
    this.maxPendingTargets=options.maxPendingTargets??1_024;
    // Admission does no historical scan; a modest batch commits bursts quickly
    // while the projector remains isolated behind durable jobs.
    this.batchSize=options.batchSize??32;
    this.buyerBatchSize=options.buyerBatchSize??32;
    this.maxAttempts=options.maxAttempts??3;
    this.restartDelayMs=options.restartDelayMs??1_000;
    this.workerTimeoutMs=options.workerTimeoutMs??120_000;
    if(typeof options.database!=='string'||!options.database||!Number.isSafeInteger(options.maxBytes)||options.maxBytes<16_384||
      !Number.isSafeInteger(this.maxPendingTargets)||this.maxPendingTargets<1||this.maxPendingTargets>10_000||
      !Number.isSafeInteger(this.batchSize)||this.batchSize<1||this.batchSize>32||
      !Number.isSafeInteger(this.buyerBatchSize)||this.buyerBatchSize<1||this.buyerBatchSize>256||
      !Number.isSafeInteger(this.maxAttempts)||this.maxAttempts<1||this.maxAttempts>10||
      !Number.isSafeInteger(this.restartDelayMs)||this.restartDelayMs<10||
      !Number.isSafeInteger(this.workerTimeoutMs)||this.workerTimeoutMs<100)
      throw new Error('WALLET_PRICE_WRITER_CONFIG_INVALID');
  }

  status():WalletPriceWriterStatus {
    let oldest=Infinity;
    for(const item of this.pending.values())oldest=Math.min(oldest,item.enqueuedAt);
    if(this.inFlight)for(const item of this.inFlight.items)oldest=Math.min(oldest,item.enqueuedAt);
    return {state:this.state,running:!!this.worker&&this.state!=='stopped',ready:this.ready,recovering:this.recovering,
      pendingTargets:this.pending.size,inFlight:this.inFlight?.items.length??0,maxPendingTargets:this.maxPendingTargets,
      accepted:this.accepted,coalesced:this.coalesced,rejectedCapacity:this.rejectedCapacity,rejectedClosed:this.rejectedClosed,
      completed:this.completed,failedAttempts:this.failedAttempts,terminalFailures:this.terminalFailures,
      droppedAfterRetries:this.droppedAfterRetries,retryCapacityDrops:this.retryCapacityDrops,droppedOnStop:this.droppedOnStop,
      durabilityBoundary:'worker_ack',durableIngressAccepted:this.durableIngressAccepted,durablePendingJobs:this.durablePendingJobs,
      retainedRecoverableOnStop:this.retainedRecoverableOnStop,unconfirmedOnStop:this.unconfirmedOnStop,
      durableInventoryUnconfirmedOnStop:this.durableInventoryUnconfirmedOnStop,
      priceRowsStored:this.priceRowsStored,buyerEventsScanned:this.buyerEventsScanned,
      buyerWalletsProjected:this.buyerWalletsProjected,restarts:this.restarts,lastBatchMs:this.lastBatchMs,maxBatchMs:this.maxBatchMs,
      oldestPendingMs:Number.isFinite(oldest)?Math.max(0,Date.now()-oldest):0,lastEnqueuedAt:this.lastEnqueuedAt,
      lastCompletedAt:this.lastCompletedAt,...(this.error?{error:this.error}:{}),...(this.closeError?{closeError:this.closeError}:{})};
  }

  start():void {
    if(this.state==='stopped')throw new Error('WALLET_PRICE_WRITER_STOPPED');
    if(this.worker||this.state==='starting'||this.state==='ready')return;
    this.state='starting';this.launch();
    this.watchdog=setInterval(()=>{
      if(this.worker&&this.inFlight&&Date.now()-this.inFlight.startedAt>this.workerTimeoutMs){
        this.error='WALLET_PRICE_WRITER_TIMEOUT';void this.worker.terminate().catch(()=>{});
      }
    },Math.min(10_000,Math.max(100,Math.floor(this.workerTimeoutMs/4))));
    this.watchdog.unref();
  }

  /** Matches WalletHistory.recordPrice's arguments, but never performs IO here.
   * A true return means bounded in-memory admission. Durability begins only
   * when durableIngressAccepted advances after the worker's SQLite commit. */
  recordPrice(target:WalletHistoryToken,priceUsd:number,observedAt:string,provider:string):boolean {
    return this.admitPrice(target,priceUsd,observedAt,provider).accepted;
  }

  /** Resolve only after the ingress worker has committed the exact quote and
   * its durable projection job. Projection itself may continue asynchronously. */
  recordPriceDurable(target:WalletHistoryToken,priceUsd:number,observedAt:string,provider:string):Promise<WalletPriceDurableAdmission> {
    const admission=this.admitPrice(target,priceUsd,observedAt,provider);
    if(!admission.accepted)return Promise.resolve(admission);
    const promise=new Promise<WalletPriceDurableAdmission>(resolve=>{
      const waiters=this.durableWaiters.get(admission.key)??new Set<DurableWaiter>();
      waiters.add(resolve);this.durableWaiters.set(admission.key,waiters);
    });
    if(this.state==='idle')this.start();
    return promise;
  }

  private admitPrice(target:WalletHistoryToken,priceUsd:number,observedAt:string,provider:string):
    ({accepted:true;key:string}|{accepted:false;reason:WalletPriceDurableFailureReason}) {
    if(!this.accepting||this.state==='stopped'||this.state==='stopping'){this.rejectedClosed++;
      return {accepted:false,reason:'WALLET_PRICE_WRITER_UNAVAILABLE'};}
    const timestamp=typeof observedAt==='string'&&observedAt.length<=40?Date.parse(observedAt):NaN;
    if(!target||!CHAINS.has(target.chain)||typeof target.address!=='string'||target.address.length<20||target.address.length>100||
      !Number.isFinite(priceUsd)||priceUsd<=0||!Number.isFinite(timestamp)||timestamp>Date.now()||!SOURCE.test(provider))
      return {accepted:false,reason:'WALLET_PRICE_INPUT_INVALID'};
    const normalizedTarget={chain:target.chain,address:target.chain==='solana'?target.address:target.address.toLowerCase()} as WalletHistoryToken,
      normalizedObservedAt=new Date(timestamp).toISOString(),key=JSON.stringify([normalizedTarget.chain,normalizedTarget.address,
        normalizedObservedAt,provider,priceUsd]);
    const item:WalletPriceWorkItem={key,sequence:++this.sequence,target:normalizedTarget,priceUsd,
      observedAt:normalizedObservedAt,provider,attempts:0,enqueuedAt:Date.now()};
    if(this.pending.has(key)||this.inFlight?.items.some(current=>current.key===key)){
      this.accepted++;this.coalesced++;return {accepted:true,key};}
    if(this.pending.size+(this.inFlight?.items.length??0)>=this.maxPendingTargets){this.rejectedCapacity++;
      return {accepted:false,reason:'WALLET_PRICE_WRITE_QUEUE_FULL'};}
    this.accepted++;this.lastEnqueuedAt=new Date().toISOString();this.pending.set(key,item);this.scheduleDispatch();
    return {accepted:true,key};
  }

  async flush(timeoutMs=10_000):Promise<boolean> {
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new Error('WALLET_PRICE_WRITER_FLUSH_INVALID');
    if(this.drained())return true;
    return new Promise<boolean>(resolve=>{
      let waiter!:DrainWaiter;
      waiter={finish:drained=>{clearTimeout(waiter.timer);this.drainWaiters.delete(waiter);resolve(drained);},
        timer:setTimeout(()=>waiter.finish(false),timeoutMs)};
      this.drainWaiters.add(waiter);
    });
  }

  stop(drainMs=5_000):Promise<boolean> {
    if(this.stopPromise)return this.stopPromise;
    if(this.state==='stopped')return Promise.resolve(!this.closeError);
    this.stopPromise=this.performStop(drainMs);return this.stopPromise;
  }

  private async performStop(drainMs:number):Promise<boolean> {
    this.accepting=false;this.state='stopping';
    // Even an otherwise idle runner may have durable jobs left by a prior
    // process. Start the worker once so shutdown verifies and drains that
    // inventory instead of either hanging or silently skipping recovery.
    if(!this.worker)this.launch();
    this.scheduleDispatch();
    const drained=await this.flush(drainMs);
    clearTimeout(this.retry);clearInterval(this.watchdog);clearImmediate(this.dispatchTimer);
    this.retry=undefined;this.watchdog=undefined;this.dispatchTimer=undefined;
    if(!drained){
      this.droppedOnStop+=this.pending.size;this.unconfirmedOnStop+=this.inFlight?.items.length??0;
      this.shutdownBatchId=this.inFlight?.id;
      this.retainedRecoverableOnStop=this.durablePendingJobs;this.closeError='WALLET_PRICE_WRITER_STOP_TIMEOUT';
      this.durableInventoryUnconfirmedOnStop=!this.ready;
      // Pending quotes were never sent; acknowledged durable jobs remain in the
      // database for the next worker. An unacknowledged batch is explicitly
      // reported as uncertain because it may have committed before termination.
      for(const item of this.pending.values())this.settleDurable(item.key,{accepted:false,reason:'WALLET_PRICE_WRITER_UNAVAILABLE'});
      if(this.inFlight)for(const item of this.inFlight.items)
        this.settleDurable(item.key,{accepted:false,reason:'WALLET_PRICE_WRITER_UNAVAILABLE'});
      this.pending.clear();this.inFlight=undefined;this.recovering=false;this.projectionIdle=true;
    }
    const worker=this.worker;
    if(worker)await new Promise<void>(done=>{
      let settled=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},3_000);
      worker.once('exit',finish);
      try{worker.postMessage('stop');}catch{void worker.terminate().then(finish,finish);}
    });
    this.worker=undefined;this.ready=false;this.recovering=false;this.projectionIdle=true;
    this.inFlight=undefined;this.state='stopped';this.resolveDrainers();return drained;
  }

  private launch():void {
    if(this.state==='stopped'||this.worker)return;
    this.recovering=true;this.projectionIdle=false;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-price-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,maxBytes:this.options.maxBytes,
        buyerBatchSize:this.buyerBatchSize},env:{},execArgv:[]});
      this.worker=worker;this.ready=false;
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='ready'){this.ready=true;this.durablePendingJobs=Math.max(0,Number(message.pendingJobs)||0);
          this.recovering=this.durablePendingJobs>0;this.projectionIdle=this.durablePendingJobs===0;
          if(this.closeError){this.retainedRecoverableOnStop=this.durablePendingJobs;this.durableInventoryUnconfirmedOnStop=false;}
          if(this.state!=='stopping')this.state='ready';this.error=undefined;this.resolveDrainers();this.scheduleDispatch();return;}
        if(message?.type==='recovery_wait'&&message.reason==='WALLET_PRICE_RECOVERY_CAPACITY'){
          this.durablePendingJobs=Math.max(0,Number(message.pendingJobs)||this.durablePendingJobs);
          this.recovering=true;this.projectionIdle=false;this.error='WALLET_PRICE_RECOVERY_CAPACITY';return;}
        if(message?.type==='ingress_result'){this.handleIngressResult(message as WorkerIngressResult);return;}
        if(message?.type==='projection'){this.handleProjectionResult(message as WorkerProjectionResult);return;}
        if(message?.type==='idle'){this.durablePendingJobs=0;this.recovering=false;this.projectionIdle=true;
          if(this.closeError)this.retainedRecoverableOnStop=0;
          this.resolveDrainers();return;}
        if(message?.type==='projection_error'){this.durablePendingJobs=Math.max(0,Number(message.pendingJobs)||this.durablePendingJobs);
          this.recovering=this.durablePendingJobs>0;this.projectionIdle=false;this.error='WALLET_PRICE_PROJECTION_FAILED';}
      });
      worker.on('error',()=>{if(this.worker===worker)this.error='WALLET_PRICE_WRITER_WORKER_FAILED';});
      worker.on('exit',()=>this.handleExit(worker));
    }catch{this.error='WALLET_PRICE_WRITER_START_FAILED';this.scheduleRestart();}
  }

  private scheduleDispatch():void {
    if(this.dispatchTimer||!this.ready||!this.worker||this.inFlight||!this.pending.size)return;
    this.dispatchTimer=setImmediate(()=>{this.dispatchTimer=undefined;this.dispatch();});
  }

  private dispatch():void {
    if(!this.ready||!this.worker||this.inFlight||!this.pending.size)return;
    const items=[...this.pending.values()].slice(0,this.batchSize);
    for(const item of items)this.pending.delete(item.key);
    const id=++this.batchId;this.inFlight={id,items,startedAt:Date.now()};
    try{this.worker.postMessage({type:'batch',batchId:id,items});}
    catch{const batch=this.inFlight;this.inFlight=undefined;if(batch)for(const item of batch.items)this.retryItem(item);void this.worker.terminate().catch(()=>{});}
  }

  private handleIngressResult(message:WorkerIngressResult):void {
    const batch=this.inFlight;
    if(!batch||message.batchId!==batch.id){
      if(this.closeError&&message.batchId===this.shutdownBatchId){
        const confirmed=Math.max(0,message.completed)+message.failed.length;
        this.unconfirmedOnStop=Math.max(0,this.unconfirmedOnStop-confirmed);this.droppedOnStop+=message.failed.length;
        this.durableIngressAccepted+=Math.max(0,message.completed);this.priceRowsStored+=Math.max(0,message.priceRowsStored);
        this.durablePendingJobs=Math.max(0,Number(message.pendingJobs)||0);
        this.retainedRecoverableOnStop=this.durablePendingJobs;this.durableInventoryUnconfirmedOnStop=false;
        this.shutdownBatchId=undefined;
      }
      return;
    }
    this.inFlight=undefined;this.lastBatchMs=Math.max(0,Math.round(message.elapsedMs));
    this.maxBatchMs=Math.max(this.maxBatchMs,this.lastBatchMs);this.failedAttempts+=message.failed.length;
    this.durableIngressAccepted+=Math.max(0,message.completed);this.priceRowsStored+=Math.max(0,message.priceRowsStored);
    this.durablePendingJobs=Math.max(0,Number(message.pendingJobs)||0);
    if(this.durablePendingJobs){this.recovering=true;this.projectionIdle=false;}
    const failed=new Set(message.failed.map(value=>value.index));
    for(let index=0;index<batch.items.length;index++)if(!failed.has(index))
      this.settleDurable(batch.items[index].key,{accepted:true});
    for(const failure of message.failed){const item=batch.items[failure.index];if(!item)continue;this.error=failure.reason;
      if(failure.retryable)this.retryItem(item);
      else {this.terminalFailures++;this.settleDurable(item.key,{accepted:false,reason:'WALLET_PRICE_WRITE_FAILED'});}}
    if(!message.failed.length&&this.error?.startsWith('WALLET_PRICE_INGRESS'))this.error=undefined;
    this.resolveDrainers();this.scheduleDispatch();
  }

  private handleProjectionResult(message:WorkerProjectionResult):void {
    this.completed+=Math.max(0,message.jobsCompleted);this.buyerEventsScanned+=Math.max(0,message.buyerEventsScanned);
    this.buyerWalletsProjected+=Math.max(0,message.buyerWalletsProjected);
    this.durablePendingJobs=Math.max(0,Number(message.pendingJobs)||0);this.recovering=this.durablePendingJobs>0;
    this.projectionIdle=this.durablePendingJobs===0;
    if(this.closeError)this.retainedRecoverableOnStop=this.durablePendingJobs;
    if(message.jobsCompleted>0)this.lastCompletedAt=new Date().toISOString();
    if(message.capacityReached)this.error='WALLET_PRICE_RECOVERY_CAPACITY';
    this.resolveDrainers();
  }

  private retryItem(item:WalletPriceWorkItem):void {
    const retried={...item,attempts:item.attempts+1};
    if(retried.attempts>=this.maxAttempts){this.droppedAfterRetries++;
      this.settleDurable(item.key,{accepted:false,reason:'WALLET_PRICE_WRITE_FAILED'});return;}
    const current=this.pending.get(item.key);
    if(current){this.coalesced++;return;}
    if(!current&&this.pending.size>=this.maxPendingTargets){this.retryCapacityDrops++;
      this.settleDurable(item.key,{accepted:false,reason:'WALLET_PRICE_WRITE_QUEUE_FULL'});return;}
    this.pending.set(item.key,retried);
  }

  private settleDurable(key:string,result:WalletPriceDurableAdmission):void {
    const waiters=this.durableWaiters.get(key);if(!waiters)return;
    this.durableWaiters.delete(key);for(const resolve of waiters)resolve(result);
  }

  private handleExit(worker:Worker):void {
    if(this.worker!==worker)return;
    const cleanStopping=this.state==='stopping'&&this.drained();
    this.worker=undefined;this.ready=false;
    if(this.inFlight){const batch=this.inFlight;this.inFlight=undefined;this.failedAttempts+=batch.items.length;
      for(const item of batch.items)this.retryItem(item);}
    if(this.state==='stopped'){this.recovering=false;return;}
    if(cleanStopping||this.state==='stopping'&&!!this.closeError){this.recovering=false;this.projectionIdle=true;this.resolveDrainers();return;}
    this.recovering=true;this.projectionIdle=false;if(this.state!=='stopping')this.state='starting';
    this.error??='WALLET_PRICE_WRITER_WORKER_EXITED';this.scheduleRestart();
  }

  private scheduleRestart():void {
    if(this.state==='stopped'||this.retry)return;
    this.restarts++;this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},this.restartDelayMs);this.retry.unref();
  }

  private drained():boolean {
    if(this.state==='idle'&&!this.worker)return this.pending.size===0;
    return this.pending.size===0&&!this.inFlight&&this.ready&&this.projectionIdle&&!this.recovering;
  }
  private resolveDrainers():void {if(this.drained())for(const waiter of [...this.drainWaiters])waiter.finish(true);}
}
