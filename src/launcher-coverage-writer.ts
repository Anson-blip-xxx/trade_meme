import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {chainAddress} from './chain-stream-store.js';
import type {LauncherCandidatesOptions,LauncherCoverageUpdate} from './launcher-candidates.js';
import type {Chain} from './types.js';

export interface LauncherCoverageWriterOptions extends LauncherCandidatesOptions {
  cap:number;maxBytes:number;
  maxPendingChains?:number;maxAttempts?:number;restartDelayMs?:number;workerTimeoutMs?:number;
}

export interface LauncherCoverageWorkItem extends LauncherCoverageUpdate {
  sequence:number;attempts:number;enqueuedAt:number;
}

export interface LauncherCoverageWriterStatus {
  state:'idle'|'starting'|'ready'|'stopping'|'stopped';running:boolean;ready:boolean;
  pendingChains:number;inFlight:number;maxPendingChains:number;
  acceptedUpdates:number;coalesced:number;staleIgnored:number;invalidBatches:number;
  rejectedCapacity:number;rejectedClosed:number;completedUpdates:number;failedAttempts:number;
  droppedAfterRetries:number;droppedOnStop:number;restarts:number;lastBatchMs:number;maxBatchMs:number;
  oldestPendingMs:number;unpersistedChains:Chain[];shutdownDrained?:boolean;
  lastEnqueuedAt?:string;lastCompletedAt?:string;shutdownError?:string;error?:string;
}

interface WorkerResult {type:'result';batchId:number;completed:number;elapsedMs:number;error?:string;retryable?:boolean}
interface DrainWaiter {finish:(drained:boolean)=>void;timer:ReturnType<typeof setTimeout>}

const CHAINS:readonly Chain[]=['bsc','solana','robinhood'];

/**
 * A bounded latest-per-chain bridge for wallet-fast coverage heartbeats.
 * Validation and map replacement are the only work performed on the main
 * thread; LauncherCandidates and its SQLite transaction live in the worker.
 */
export class LauncherCoverageWriterRunner {
  private readonly maxPendingChains:number;private readonly maxAttempts:number;
  private readonly restartDelayMs:number;private readonly workerTimeoutMs:number;
  private readonly pending=new Map<Chain,LauncherCoverageWorkItem>();
  private readonly unpersisted=new Map<Chain,{sequence:number;at:string}>();
  private readonly drainWaiters=new Set<DrainWaiter>();
  private worker?:Worker;private retry?:ReturnType<typeof setTimeout>;private watchdog?:ReturnType<typeof setInterval>;
  private dispatchTimer?:ReturnType<typeof setImmediate>;
  private inFlight?:{id:number;items:LauncherCoverageWorkItem[];startedAt:number};
  private sequence=0;private batchId=0;private accepting=true;private ready=false;
  private state:LauncherCoverageWriterStatus['state']='idle';
  private acceptedUpdates=0;private coalesced=0;private staleIgnored=0;private invalidBatches=0;
  private rejectedCapacity=0;private rejectedClosed=0;private completedUpdates=0;private failedAttempts=0;
  private droppedAfterRetries=0;private droppedOnStop=0;private restarts=0;
  private lastBatchMs=0;private maxBatchMs=0;private lastEnqueuedAt?:string;private lastCompletedAt?:string;private error?:string;
  private shutdownDrained?:boolean;private shutdownError?:string;
  private stopPromise?:Promise<boolean>;

  constructor(private readonly options:LauncherCoverageWriterOptions){
    this.maxPendingChains=options.maxPendingChains??CHAINS.length;this.maxAttempts=options.maxAttempts??3;
    this.restartDelayMs=options.restartDelayMs??1_000;this.workerTimeoutMs=options.workerTimeoutMs??10_000;
    if(typeof options.database!=='string'||!options.database||typeof options.profileDatabase!=='string'||!options.profileDatabase||
      !Number.isSafeInteger(options.cap)||options.cap<1||options.cap>5_000||
      !Number.isSafeInteger(options.maxBytes)||options.maxBytes<64*1024||
      !Number.isSafeInteger(this.maxPendingChains)||this.maxPendingChains<1||this.maxPendingChains>CHAINS.length||
      !Number.isSafeInteger(this.maxAttempts)||this.maxAttempts<1||this.maxAttempts>10||
      !Number.isSafeInteger(this.restartDelayMs)||this.restartDelayMs<10||
      !Number.isSafeInteger(this.workerTimeoutMs)||this.workerTimeoutMs<100)
      throw new Error('LAUNCHER_COVERAGE_WRITER_CONFIG_INVALID');
  }

  status():LauncherCoverageWriterStatus {
    let oldest=Infinity;for(const item of this.pending.values())oldest=Math.min(oldest,item.enqueuedAt);
    if(this.inFlight)for(const item of this.inFlight.items)oldest=Math.min(oldest,item.enqueuedAt);
    return {state:this.state,running:this.state==='ready'&&this.ready&&!!this.worker,ready:this.state==='ready'&&this.ready,
      pendingChains:this.pending.size,inFlight:this.inFlight?.items.length??0,maxPendingChains:this.maxPendingChains,
      acceptedUpdates:this.acceptedUpdates,coalesced:this.coalesced,staleIgnored:this.staleIgnored,invalidBatches:this.invalidBatches,
      rejectedCapacity:this.rejectedCapacity,rejectedClosed:this.rejectedClosed,completedUpdates:this.completedUpdates,
      failedAttempts:this.failedAttempts,droppedAfterRetries:this.droppedAfterRetries,droppedOnStop:this.droppedOnStop,
      restarts:this.restarts,lastBatchMs:this.lastBatchMs,maxBatchMs:this.maxBatchMs,
      oldestPendingMs:Number.isFinite(oldest)?Math.max(0,Date.now()-oldest):0,
      unpersistedChains:[...this.unpersisted.keys()].sort(),shutdownDrained:this.shutdownDrained,
      lastEnqueuedAt:this.lastEnqueuedAt,lastCompletedAt:this.lastCompletedAt,
      ...(this.shutdownError?{shutdownError:this.shutdownError}:{}),...(this.error?{error:this.error}:{})};
  }

  start():void {
    if(this.state==='stopped')throw new Error('LAUNCHER_COVERAGE_WRITER_STOPPED');
    if(this.worker||this.state==='starting'||this.state==='ready')return;
    this.state='starting';this.launch();
    this.watchdog=setInterval(()=>{if(this.worker&&this.inFlight&&Date.now()-this.inFlight.startedAt>this.workerTimeoutMs){
      this.error='LAUNCHER_COVERAGE_WRITER_TIMEOUT';void this.worker.terminate().catch(()=>{});}},
    Math.min(1_000,Math.max(100,Math.floor(this.workerTimeoutMs/4))));this.watchdog.unref();
  }

  enqueue(updates:readonly LauncherCoverageUpdate[]):boolean {
    if(!this.accepting||this.state==='stopped'||this.state==='stopping'){this.rejectedClosed+=Array.isArray(updates)?updates.length:1;return false;}
    const prepared=this.validate(updates);if(!prepared){this.invalidBatches++;return false;}
    const newChains=prepared.reduce((total,item)=>total+(this.pending.has(item.chain)?0:1),0);
    if(this.pending.size+newChains>this.maxPendingChains){this.rejectedCapacity+=prepared.length;return false;}
    const enqueuedAt=Date.now();this.lastEnqueuedAt=new Date(enqueuedAt).toISOString();
    for(const update of prepared){const current=this.pending.get(update.chain);this.acceptedUpdates++;
      const item:LauncherCoverageWorkItem={...update,sequence:++this.sequence,attempts:0,enqueuedAt};
      if(current){this.coalesced++;if(current.at>item.at){this.staleIgnored++;continue;}this.pending.delete(update.chain);}
      this.pending.set(update.chain,item);
    }
    this.scheduleDispatch();return true;
  }

  async flush(timeoutMs=5_000):Promise<boolean> {
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new Error('LAUNCHER_COVERAGE_WRITER_FLUSH_INVALID');
    if(this.drained())return true;
    return new Promise<boolean>(resolve=>{let waiter!:DrainWaiter;waiter={finish:drained=>{
      clearTimeout(waiter.timer);this.drainWaiters.delete(waiter);resolve(drained);},timer:setTimeout(()=>waiter.finish(false),timeoutMs)};
      this.drainWaiters.add(waiter);});
  }

  stop(drainMs=5_000):Promise<boolean> {
    if(this.stopPromise)return this.stopPromise;
    if(this.state==='stopped')return Promise.resolve(this.shutdownDrained??(this.drained()&&!this.unpersisted.size));
    this.stopPromise=this.performStop(drainMs);return this.stopPromise;
  }

  private async performStop(drainMs:number):Promise<boolean> {
    this.accepting=false;this.state='stopping';if(!this.worker&&this.pending.size)this.launch();this.scheduleDispatch();
    const queueDrained=await this.flush(drainMs);clearTimeout(this.retry);clearInterval(this.watchdog);clearImmediate(this.dispatchTimer);
    this.retry=undefined;this.watchdog=undefined;this.dispatchTimer=undefined;
    if(!queueDrained){const abandoned=[...this.pending.values(),...(this.inFlight?.items??[])];this.droppedOnStop+=abandoned.length;
      for(const item of abandoned)this.markUnpersisted(item);this.pending.clear();this.inFlight=undefined;}
    const worker=this.worker;if(worker)await new Promise<void>(done=>{let settled=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},3_000);worker.once('exit',finish);
      try{worker.postMessage('stop');}catch{void worker.terminate().then(finish,finish);}});
    this.worker=undefined;this.ready=false;this.inFlight=undefined;this.state='stopped';
    this.shutdownDrained=queueDrained&&!this.unpersisted.size;
    if(!this.shutdownDrained){this.shutdownError='LAUNCHER_COVERAGE_SHUTDOWN_UNDRAINED';this.error=this.shutdownError;}
    this.resolveDrainers();return this.shutdownDrained;
  }

  private validate(updates:readonly LauncherCoverageUpdate[]):LauncherCoverageUpdate[]|undefined {
    if(!Array.isArray(updates)||updates.length>CHAINS.length)return;
    const seen=new Set<Chain>(),now=Date.now(),prepared:LauncherCoverageUpdate[]=[];
    for(const update of updates){const network=update?.chain,at=typeof update?.at==='string'&&update.at.length<=40?Date.parse(update.at):NaN;
      if(!CHAINS.includes(network)||seen.has(network)||!Number.isFinite(at)||at>now||!Array.isArray(update.wallets)||update.wallets.length>this.options.cap)return;
      const wallets=[...new Set(update.wallets.map((wallet:string)=>chainAddress(network,wallet)))];
      if(wallets.some(wallet=>!wallet))return;seen.add(network);
      prepared.push({chain:network,wallets:wallets as string[],at:new Date(at).toISOString()});
    }
    return prepared;
  }

  private launch():void {
    if(this.state==='stopped'||this.worker)return;
    try {const source=import.meta.url.endsWith('.ts'),entry=new URL(`./launcher-coverage-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,profileDatabase:this.options.profileDatabase,
        cap:this.options.cap,maxBytes:this.options.maxBytes,freshAfterSec:this.options.freshAfterSec,
        liveAfterSec:this.options.liveAfterSec,coverageAfterSec:this.options.coverageAfterSec,busyTimeoutMs:this.options.busyTimeoutMs??100},env:{},execArgv:[]});
      this.worker=worker;this.ready=false;if(this.state!=='stopping')this.state='starting';worker.on('message',message=>{if(this.worker!==worker)return;
        if(message?.type==='ready'){this.ready=true;if(this.state!=='stopping')this.state='ready';this.error=undefined;this.scheduleDispatch();return;}
        if(message?.type==='result')this.handleResult(message as WorkerResult);});
      worker.on('error',()=>{if(this.worker===worker){this.ready=false;if(this.state!=='stopping'&&this.state!=='stopped')this.state='starting';
        this.error='LAUNCHER_COVERAGE_WRITER_WORKER_FAILED';}});
      worker.on('exit',()=>this.handleExit(worker));
    }catch{this.error='LAUNCHER_COVERAGE_WRITER_START_FAILED';this.scheduleRestart();}
  }

  private scheduleDispatch():void {if(this.dispatchTimer||!this.ready||!this.worker||this.inFlight||!this.pending.size)return;
    this.dispatchTimer=setImmediate(()=>{this.dispatchTimer=undefined;this.dispatch();});}
  private dispatch():void {if(!this.ready||!this.worker||this.inFlight||!this.pending.size)return;
    const items=[...this.pending.values()];this.pending.clear();const id=++this.batchId;this.inFlight={id,items,startedAt:Date.now()};
    try{this.worker.postMessage({type:'batch',batchId:id,items});}catch{const batch=this.inFlight;this.inFlight=undefined;
      if(batch)for(const item of batch.items)this.retryItem(item);void this.worker.terminate().catch(()=>{});}}
  private handleResult(message:WorkerResult):void {const batch=this.inFlight;if(!batch||message.batchId!==batch.id)return;
    this.inFlight=undefined;this.lastBatchMs=Math.max(0,Math.round(message.elapsedMs));this.maxBatchMs=Math.max(this.maxBatchMs,this.lastBatchMs);
    if(message.error){this.error=message.error;this.failedAttempts+=batch.items.length;if(message.retryable!==false)for(const item of batch.items)this.retryItem(item);
      else for(const item of batch.items){this.droppedAfterRetries++;this.markUnpersisted(item);}
    }else if(message.completed!==batch.items.length){this.error='LAUNCHER_COVERAGE_WRITE_INCOMPLETE';this.failedAttempts+=batch.items.length;
      for(const item of batch.items)this.retryItem(item);
    }else{this.error=undefined;this.completedUpdates+=message.completed;this.lastCompletedAt=new Date().toISOString();
      for(const item of batch.items){const missing=this.unpersisted.get(item.chain);if(missing&&missing.sequence<=item.sequence)this.unpersisted.delete(item.chain);}}
    this.resolveDrainers();this.scheduleDispatch();}
  private retryItem(item:LauncherCoverageWorkItem):void {const retried={...item,attempts:item.attempts+1};
    if(retried.attempts>=this.maxAttempts){this.droppedAfterRetries++;this.markUnpersisted(item);return;}const current=this.pending.get(item.chain);
    if(current&&current.at>=retried.at){this.coalesced++;return;}if(current)this.pending.delete(item.chain);
    if(!current&&this.pending.size>=this.maxPendingChains){this.droppedAfterRetries++;this.markUnpersisted(item);return;}this.pending.set(item.chain,retried);}
  private handleExit(worker:Worker):void {if(this.worker!==worker)return;this.worker=undefined;this.ready=false;
    if(this.inFlight){const batch=this.inFlight;this.inFlight=undefined;this.failedAttempts+=batch.items.length;for(const item of batch.items)this.retryItem(item);}
    if(this.state==='stopped')return;if(this.state==='stopping'&&this.drained()){this.resolveDrainers();return;}
    if(this.state!=='stopping')this.state='starting';
    this.error??='LAUNCHER_COVERAGE_WRITER_WORKER_EXITED';this.scheduleRestart();}
  private scheduleRestart():void {if(this.state==='stopped'||this.retry)return;this.restarts++;
    this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},this.restartDelayMs);this.retry.unref();}
  private drained():boolean {return this.pending.size===0&&!this.inFlight;}
  private markUnpersisted(item:LauncherCoverageWorkItem):void {const current=this.unpersisted.get(item.chain);
    if(!current||item.sequence>=current.sequence)this.unpersisted.set(item.chain,{sequence:item.sequence,at:item.at});}
  private resolveDrainers():void {if(this.drained())for(const waiter of [...this.drainWaiters])waiter.finish(true);}
}
