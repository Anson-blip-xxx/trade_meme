import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {WalletActivity} from './wallet-activity.js';
import type {LauncherCandidatesOptions} from './launcher-candidates.js';

export interface WalletFastPersistenceOptions {
  activityDatabase:string;activityMaxBytes:number;historyDatabase:string;historyMaxBytes:number;
  launcher?:Omit<LauncherCandidatesOptions,'now'>;
  capacity?:number;maxAttempts?:number;restartDelayMs?:number;workerTimeoutMs?:number;launcherRetryMs?:number;
}
interface WorkItem {id:number;result:WalletActivity;attempts:number;enqueuedAt:number;dueAt:number;finish:(persisted:boolean)=>void}
interface WorkerResult {type:'result';id:number;persisted:boolean;elapsedMs:number;status?:Record<string,unknown>;
  launcherReady?:boolean;error?:string;retryable?:boolean;retryAfterMs?:number}
interface DrainWaiter {finish:(drained:boolean)=>void;timer:ReturnType<typeof setTimeout>}

/** Bounded worker bridge for verified wallet classifications and derived
 * history. The socket/event loop observes only admission and worker ACKs. */
export class WalletFastPersistenceRunner {
  private readonly capacity:number;private readonly maxAttempts:number;private readonly restartDelayMs:number;private readonly workerTimeoutMs:number;
  private pending:WorkItem[]=[];private inFlight?:WorkItem;private worker?:Worker;private retry?:ReturnType<typeof setTimeout>;
  private inFlightStartedAt=0;
  private watchdog?:ReturnType<typeof setInterval>;private dispatchTimer?:ReturnType<typeof setTimeout>;private dispatchAt=0;
  private drainWaiters=new Set<DrainWaiter>();private sequence=0;private running=false;private ready=false;private accepting=true;private stopping=false;
  private stopped=false;private stopResult=true;private stopPromise?:Promise<boolean>;
  private accepted=0;private rejectedCapacity=0;private rejectedClosed=0;private completed=0;private failedAttempts=0;
  private droppedAfterRetries=0;private droppedOnStop=0;private unconfirmedOnStop=0;private restarts=0;private lastBatchMs=0;private maxBatchMs=0;
  private lastCompletedAt?:string;private error?:string;private activity?:Record<string,unknown>;private launcherReady=false;

  constructor(private readonly options:WalletFastPersistenceOptions){
    this.capacity=options.capacity??64;this.maxAttempts=options.maxAttempts??3;this.restartDelayMs=options.restartDelayMs??1000;
    this.workerTimeoutMs=options.workerTimeoutMs??15_000;
    if(!options.activityDatabase||!options.historyDatabase||!Number.isSafeInteger(options.activityMaxBytes)||options.activityMaxBytes<64*1024||
      !Number.isSafeInteger(options.historyMaxBytes)||options.historyMaxBytes<16_384||!Number.isSafeInteger(this.capacity)||this.capacity<1||this.capacity>1000||
      !Number.isSafeInteger(this.maxAttempts)||this.maxAttempts<1||this.maxAttempts>10||!Number.isSafeInteger(this.restartDelayMs)||this.restartDelayMs<10||
      !Number.isSafeInteger(this.workerTimeoutMs)||this.workerTimeoutMs<100||options.launcherRetryMs!==undefined&&
      (!Number.isSafeInteger(options.launcherRetryMs)||options.launcherRetryMs<10||options.launcherRetryMs>60_000))
      throw new Error('WALLET_FAST_PERSISTENCE_CONFIG_INVALID');
  }
  start():void {if(this.stopped)throw new Error('WALLET_FAST_PERSISTENCE_STOPPED');if(this.running||this.stopping)return;this.running=true;this.launch();this.watchdog=setInterval(()=>{
    if(this.worker&&this.inFlight&&Date.now()-this.inFlightStartedAt>this.workerTimeoutMs){this.error='WALLET_FAST_PERSISTENCE_TIMEOUT';void this.worker.terminate().catch(()=>{});}
  },Math.min(1000,Math.max(100,Math.floor(this.workerTimeoutMs/4))));this.watchdog.unref();}
  persist(result:WalletActivity):Promise<boolean>{
    if(!this.accepting||this.stopping){this.rejectedClosed++;return Promise.resolve(false);}
    let serialized:string;try{serialized=JSON.stringify(result);}catch{return Promise.resolve(false);}
    if(!result||result.version!==1||serialized.length>262_144)return Promise.resolve(false);
    if(this.pending.length+(this.inFlight?1:0)>=this.capacity){this.rejectedCapacity++;return Promise.resolve(false);}
    this.accepted++;return new Promise(resolve=>{const now=Date.now();this.pending.push({id:++this.sequence,result,attempts:0,enqueuedAt:now,dueAt:now,finish:resolve});this.schedule();});
  }
  status(){let oldest=this.inFlight?.enqueuedAt??Infinity;for(const item of this.pending)oldest=Math.min(oldest,item.enqueuedAt);
    const state=this.stopped?'stopped':this.stopping?'stopping':this.ready?'ready':this.running?'starting':'idle';
    return {state,running:this.running&&!!this.worker,ready:this.ready,stopping:this.stopping,stopped:this.stopped,pending:this.pending.length,inFlight:this.inFlight?1:0,
      capacity:this.capacity,accepted:this.accepted,rejectedCapacity:this.rejectedCapacity,rejectedClosed:this.rejectedClosed,completed:this.completed,
      failedAttempts:this.failedAttempts,droppedAfterRetries:this.droppedAfterRetries,droppedOnStop:this.droppedOnStop,restarts:this.restarts,
      unconfirmedOnStop:this.unconfirmedOnStop,
      lastBatchMs:this.lastBatchMs,maxBatchMs:this.maxBatchMs,oldestPendingMs:Number.isFinite(oldest)?Math.max(0,Date.now()-oldest):0,
      lastCompletedAt:this.lastCompletedAt,launcherReady:this.launcherReady,activity:this.activity,...(this.error?{error:this.error}:{})};}
  stop(drainMs=5000):Promise<boolean>{if(this.stopPromise)return this.stopPromise;
    if(this.stopped)return Promise.resolve(this.stopResult);this.stopPromise=this.performStop(drainMs);return this.stopPromise;}
  private async performStop(drainMs:number):Promise<boolean>{this.accepting=false;this.stopping=true;this.schedule();
    const drained=this.running?await this.flush(drainMs):this.drained();clearTimeout(this.retry);clearInterval(this.watchdog);clearTimeout(this.dispatchTimer);
    this.retry=undefined;this.watchdog=undefined;this.dispatchTimer=undefined;this.dispatchAt=0;
    if(!drained){const dropped=[...this.pending,...(this.inFlight?[this.inFlight]:[])];this.droppedOnStop+=this.pending.length;
      this.unconfirmedOnStop+=this.inFlight?1:0;
      this.pending=[];this.inFlight=undefined;this.inFlightStartedAt=0;for(const item of dropped)item.finish(false);}
    const worker=this.worker;if(worker)await new Promise<void>(done=>{let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},3000);worker.once('exit',finish);
      try{worker.postMessage('stop');}catch{void worker.terminate().then(finish,finish);}});
    this.worker=undefined;this.ready=false;this.running=false;this.stopping=false;this.stopped=true;this.stopResult=drained;this.resolveDrainers();return drained;}
  private launch():void {if(!this.running||this.worker||this.stopping)return;try{
    const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-fast-persistence-worker.${source?'ts':'js'}`,import.meta.url);
    const url=source?new URL('data:text/javascript,'+encodeURIComponent(`import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
    const worker=new Worker(url,{workerData:{activityDatabase:this.options.activityDatabase,activityMaxBytes:this.options.activityMaxBytes,
      historyDatabase:this.options.historyDatabase,historyMaxBytes:this.options.historyMaxBytes,launcher:this.options.launcher,
      launcherRetryMs:this.options.launcherRetryMs},env:{},execArgv:[]});
    this.worker=worker;this.ready=false;worker.on('message',message=>{if(this.worker!==worker)return;
      if(message?.type==='ready'){this.ready=true;this.activity=message.status;this.launcherReady=message.launcherReady===true;this.error=undefined;this.schedule();}
      else if(message?.type==='result')this.handleResult(message as WorkerResult);
      else if(message?.type==='fatal')this.error='WALLET_FAST_PERSISTENCE_STORE_OPEN_FAILED';});
    worker.on('error',()=>{if(this.worker===worker)this.error='WALLET_FAST_PERSISTENCE_WORKER_FAILED';});worker.on('exit',()=>this.handleExit(worker));
  }catch{this.error='WALLET_FAST_PERSISTENCE_START_FAILED';this.scheduleRestart();}}
  private schedule():void {if(!this.ready||!this.worker||this.inFlight||!this.pending.length)return;
    const nextAt=this.pending.reduce((earliest,item)=>Math.min(earliest,item.dueAt),Infinity);
    if(this.dispatchTimer&&this.dispatchAt<=nextAt)return;clearTimeout(this.dispatchTimer);this.dispatchAt=nextAt;
    this.dispatchTimer=setTimeout(()=>{this.dispatchTimer=undefined;this.dispatchAt=0;this.dispatch();},Math.max(0,nextAt-Date.now()));}
  private dispatch():void {if(!this.ready||!this.worker||this.inFlight||!this.pending.length)return;const now=Date.now(),index=this.pending.findIndex(item=>item.dueAt<=now);
    if(index<0){this.schedule();return;}const [item]=this.pending.splice(index,1);this.inFlight=item;this.inFlightStartedAt=now;
    try{this.worker.postMessage({type:'persist',id:item.id,result:item.result});}catch{this.inFlight=undefined;this.inFlightStartedAt=0;this.retryItem(item);void this.worker.terminate().catch(()=>{});}}
  private handleResult(message:WorkerResult):void {const item=this.inFlight;if(!item||item.id!==message.id)return;this.inFlight=undefined;
    this.inFlightStartedAt=0;this.lastBatchMs=Math.max(0,Math.round(message.elapsedMs));this.maxBatchMs=Math.max(this.maxBatchMs,this.lastBatchMs);
    if(message.status)this.activity=message.status;if(message.launcherReady!==undefined)this.launcherReady=message.launcherReady;
    if(message.persisted){this.completed++;this.lastCompletedAt=new Date().toISOString();this.error=undefined;item.finish(true);}
    else if(message.retryable!==false){this.failedAttempts++;this.error=message.error??'WALLET_FAST_PERSISTENCE_WRITE_FAILED';this.retryItem(item,message.retryAfterMs);}
    else {this.failedAttempts++;this.error=message.error??'WALLET_FAST_PERSISTENCE_REJECTED';this.droppedAfterRetries++;item.finish(false);}
    this.resolveDrainers();this.schedule();}
  private retryItem(item:WorkItem,retryAfterMs?:number):void {const attempts=item.attempts+1;if(attempts>=this.maxAttempts){this.droppedAfterRetries++;item.finish(false);return;}
    if(this.pending.length+(this.inFlight?1:0)>=this.capacity){this.droppedAfterRetries++;item.finish(false);return;}
    const backoff=Math.min(5000,100*2**item.attempts),requested=Number.isFinite(retryAfterMs)&&(retryAfterMs??-1)>=0?
      Math.min(60_000,Math.ceil(retryAfterMs!)):0;
    this.pending.push({...item,attempts,dueAt:Date.now()+Math.max(backoff,requested)});}
  private handleExit(worker:Worker):void {if(this.worker!==worker)return;this.worker=undefined;this.ready=false;this.launcherReady=false;
    if(this.inFlight){const item=this.inFlight;this.inFlight=undefined;this.inFlightStartedAt=0;this.failedAttempts++;this.retryItem(item);}
    if(this.stopping){this.resolveDrainers();return;}this.error??='WALLET_FAST_PERSISTENCE_WORKER_EXITED';this.scheduleRestart();}
  private scheduleRestart():void {if(!this.running||this.stopping||this.retry)return;this.restarts++;this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},this.restartDelayMs);this.retry.unref();}
  private drained():boolean{return !this.pending.length&&!this.inFlight;}
  private flush(timeoutMs:number):Promise<boolean>{if(this.drained())return Promise.resolve(true);return new Promise(resolve=>{let waiter!:DrainWaiter;
    waiter={finish:value=>{clearTimeout(waiter.timer);this.drainWaiters.delete(waiter);resolve(value);},timer:setTimeout(()=>waiter.finish(false),timeoutMs)};this.drainWaiters.add(waiter);});}
  private resolveDrainers():void {if(this.drained())for(const waiter of [...this.drainWaiters])waiter.finish(true);}
}
