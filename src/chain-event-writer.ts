import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {ChainStreamStore,type ChainEvent} from './chain-stream-store.js';
import type {Chain} from './types.js';

const CHAINS:readonly Chain[]=['bsc','solana','robinhood'];
const chainCounts=():Record<Chain,number>=>({bsc:0,solana:0,robinhood:0});

export interface ChainEventWriterStatus {
  state:'idle'|'starting'|'ready'|'stopping'|'stopped';running:boolean;ready:boolean;
  countOwnership:'external'|'shared';
  pending:number;inFlight:number;capacity:number;accepted:number;coalesced:number;
  rejectedInvalid:number;rejectedCapacity:number;rejectedClosed:number;completed:number;inserted:number;
  insertedByChain:Record<Chain,number>;failedAttempts:number;droppedAfterRetries:number;
  droppedOnStop:number;unconfirmedOnStop:number;unpersistedEvents:number;restarts:number;
  pendingIncompleteReasons:string[];unpersistedIncompleteReasons:string[];lastBatchMs:number;maxBatchMs:number;oldestPendingMs:number;
  lastCompletedAt?:string;shutdownDrained?:boolean;error?:string;shutdownError?:string;
  authoritativeLiveEvents?:number;authoritativeLiveByChain?:Record<Chain,number>;
}

export interface ChainEventWriter {
  start():void;
  enqueue(event:ChainEvent):boolean;
  markIncomplete(reason:string):void;
  status():ChainEventWriterStatus;
  stop(timeoutMs?:number):Promise<boolean>;
}

export interface ChainEventWriterOptions {
  database:string;maxBytes:number;capacity?:number;batchSize?:number;maxAttempts?:number;
  restartDelayMs?:number;workerTimeoutMs?:number;stopTimeoutMs?:number;busyTimeoutMs?:number;
}

interface WorkItem {event:ChainEvent;attempts:number;enqueuedAt:number}
interface MarkerItem {reason:string;attempts:number}
interface WorkerFailure {index:number;reason:string;retryable:boolean}
interface WorkerTotals {liveEvents:number;liveEventsByChain:Record<Chain,number>}
interface WorkerResult {type:'result';batchId:number;completed:number;inserted:number;insertedByChain:Partial<Record<Chain,number>>;
  failed:WorkerFailure[];markerFailures:string[];elapsedMs:number;totals?:WorkerTotals}
interface DrainWaiter {finish:(drained:boolean)=>void;timer:ReturnType<typeof setTimeout>}

/**
 * Bounded bridge for live ChainMonitor events. The websocket callback performs
 * validation and map admission only; ChainStreamStore and all SQLite work live
 * in the worker.
 */
export class ChainEventWriterRunner implements ChainEventWriter {
  private readonly capacity:number;private readonly batchSize:number;private readonly maxAttempts:number;
  private readonly restartDelayMs:number;private readonly workerTimeoutMs:number;private readonly stopTimeoutMs:number;private readonly busyTimeoutMs:number;
  private pending=new Map<string,WorkItem>();private incompleteReasons=new Map<string,MarkerItem>();private failedIncompleteReasons=new Set<string>();
  private inFlight?:{id:number;items:WorkItem[];markers:MarkerItem[];startedAt:number};
  private worker?:Worker;private retry?:ReturnType<typeof setTimeout>;private watchdog?:ReturnType<typeof setInterval>;
  private dispatchTimer?:ReturnType<typeof setImmediate>;private drainWaiters=new Set<DrainWaiter>();
  private state:ChainEventWriterStatus['state']='idle';private accepting=true;private ready=false;private batchId=0;
  private accepted=0;private coalesced=0;private rejectedInvalid=0;private rejectedCapacity=0;private rejectedClosed=0;
  private completed=0;private inserted=0;private insertedByChain:Record<Chain,number>={bsc:0,solana:0,robinhood:0};
  private failedAttempts=0;private droppedAfterRetries=0;private droppedOnStop=0;private unconfirmedOnStop=0;
  private unpersistedEvents=0;private restarts=0;private lastBatchMs=0;private maxBatchMs=0;private lastCompletedAt?:string;
  private baselineLiveEvents?:number;private baselineLiveByChain?:Record<Chain,number>;private authoritativeLiveEvents?:number;
  private authoritativeLiveByChain?:Record<Chain,number>;
  private shutdownDrained?:boolean;private error?:string;private shutdownError?:string;private stopPromise?:Promise<boolean>;

  constructor(private readonly options:ChainEventWriterOptions){
    this.capacity=options.capacity??1_024;this.batchSize=options.batchSize??32;this.maxAttempts=options.maxAttempts??3;
    this.restartDelayMs=options.restartDelayMs??1_000;this.workerTimeoutMs=options.workerTimeoutMs??10_000;
    this.stopTimeoutMs=options.stopTimeoutMs??5_000;this.busyTimeoutMs=options.busyTimeoutMs??100;
    if(!options.database||!Number.isSafeInteger(options.maxBytes)||options.maxBytes<64*1024||
      !Number.isSafeInteger(this.capacity)||this.capacity<1||this.capacity>20_000||
      !Number.isSafeInteger(this.batchSize)||this.batchSize<1||this.batchSize>Math.min(1_000,this.capacity)||
      !Number.isSafeInteger(this.maxAttempts)||this.maxAttempts<1||this.maxAttempts>10||
      !Number.isSafeInteger(this.restartDelayMs)||this.restartDelayMs<10||
      !Number.isSafeInteger(this.workerTimeoutMs)||this.workerTimeoutMs<100||
      !Number.isSafeInteger(this.stopTimeoutMs)||this.stopTimeoutMs<100||
      !Number.isSafeInteger(this.busyTimeoutMs)||this.busyTimeoutMs<0||this.busyTimeoutMs>1_000)throw new Error('CHAIN_EVENT_WRITER_CONFIG_INVALID');
  }

  start():void {
    if(this.state==='stopped')throw new Error('CHAIN_EVENT_WRITER_STOPPED');
    if(this.worker||this.state==='starting'||this.state==='ready')return;
    this.state='starting';this.launch();
    this.watchdog=setInterval(()=>{if(this.worker&&this.inFlight&&Date.now()-this.inFlight.startedAt>this.workerTimeoutMs){
      this.error='CHAIN_EVENT_WRITER_TIMEOUT';void this.worker.terminate().catch(()=>{});}},
    Math.min(1_000,Math.max(100,Math.floor(this.workerTimeoutMs/4))));this.watchdog.unref();
  }

  enqueue(event:ChainEvent):boolean {
    if(!this.accepting||this.state==='stopping'||this.state==='stopped'){this.rejectedClosed++;return false;}
    if(!this.valid(event)){this.rejectedInvalid++;return false;}
    const flying=this.inFlight?.items.find(item=>item.event.id===event.id);
    if(flying&&(!event.removed||flying.event.removed)){this.accepted++;this.coalesced++;return true;}
    const current=this.pending.get(event.id);
    if(current){this.accepted++;this.coalesced++;
      if(event.removed&&!current.event.removed){this.pending.delete(event.id);this.pending.set(event.id,{event,attempts:current.attempts,enqueuedAt:current.enqueuedAt});}
      return true;
    }
    // A reorg tombstone is a bounded successor to the same in-flight event.
    // Admitting it cannot grow beyond one extra row per in-flight key and
    // prevents the nominal capacity limit from resurrecting a removed log.
    if(flying&&event.removed&&!flying.event.removed){this.accepted++;this.pending.set(event.id,{event,attempts:0,enqueuedAt:Date.now()});this.schedule();return true;}
    if(this.pending.size+(this.inFlight?.items.length??0)>=this.capacity){this.rejectedCapacity++;this.unpersistedEvents++;
      this.markIncomplete('CHAIN_LIVE_EVENT_QUEUE_FULL');return false;}
    this.accepted++;this.pending.set(event.id,{event,attempts:0,enqueuedAt:Date.now()});this.schedule();return true;
  }

  markIncomplete(reason:string):void {
    if(!/^CHAIN_[A-Z_]{1,70}$/.test(reason))return;
    if(this.incompleteReasons.has(reason)||this.inFlight?.markers.some(marker=>marker.reason===reason))return;
    this.failedIncompleteReasons.delete(reason);this.incompleteReasons.set(reason,{reason,attempts:0});this.schedule();
  }

  status():ChainEventWriterStatus {
    let oldest=Infinity;for(const item of this.pending.values())oldest=Math.min(oldest,item.enqueuedAt);
    if(this.inFlight)for(const item of this.inFlight.items)oldest=Math.min(oldest,item.enqueuedAt);
    return {state:this.state,running:this.state==='ready'&&this.ready&&!!this.worker,ready:this.ready,countOwnership:'external',
      pending:this.pending.size,inFlight:this.inFlight?.items.length??0,capacity:this.capacity,accepted:this.accepted,
      coalesced:this.coalesced,rejectedInvalid:this.rejectedInvalid,rejectedCapacity:this.rejectedCapacity,
      rejectedClosed:this.rejectedClosed,completed:this.completed,inserted:this.inserted,insertedByChain:{...this.insertedByChain},
      failedAttempts:this.failedAttempts,droppedAfterRetries:this.droppedAfterRetries,droppedOnStop:this.droppedOnStop,
      unconfirmedOnStop:this.unconfirmedOnStop,unpersistedEvents:this.unpersistedEvents,restarts:this.restarts,
      pendingIncompleteReasons:[...this.incompleteReasons.keys(),...(this.inFlight?.markers.map(marker=>marker.reason)??[])],
      unpersistedIncompleteReasons:[...this.failedIncompleteReasons],lastBatchMs:this.lastBatchMs,
      maxBatchMs:this.maxBatchMs,oldestPendingMs:Number.isFinite(oldest)?Math.max(0,Date.now()-oldest):0,
      lastCompletedAt:this.lastCompletedAt,shutdownDrained:this.shutdownDrained,...(this.error?{error:this.error}:{}),
      ...(this.shutdownError?{shutdownError:this.shutdownError}:{}),...(this.authoritativeLiveEvents!==undefined?{
        authoritativeLiveEvents:this.authoritativeLiveEvents,authoritativeLiveByChain:{...this.authoritativeLiveByChain!}}:{})};
  }

  stop(timeoutMs=this.stopTimeoutMs):Promise<boolean> {
    if(this.stopPromise)return this.stopPromise;
    if(this.state==='stopped')return Promise.resolve(this.shutdownDrained!==false);
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new Error('CHAIN_EVENT_WRITER_STOP_TIMEOUT_INVALID');
    this.stopPromise=this.performStop(timeoutMs);return this.stopPromise;
  }

  private async performStop(timeoutMs:number):Promise<boolean> {
    this.accepting=false;this.state='stopping';if(!this.worker&&(this.pending.size||this.incompleteReasons.size))this.launch();this.schedule();
    const queueDrained=await this.flush(timeoutMs),drained=queueDrained&&!this.failedIncompleteReasons.size;
    clearTimeout(this.retry);clearInterval(this.watchdog);clearImmediate(this.dispatchTimer);
    this.retry=undefined;this.watchdog=undefined;this.dispatchTimer=undefined;
    if(!drained){this.droppedOnStop+=this.pending.size;this.unconfirmedOnStop+=this.inFlight?.items.length??0;
      this.unpersistedEvents+=this.pending.size+(this.inFlight?.items.length??0);this.pending.clear();this.incompleteReasons.clear();this.inFlight=undefined;
      this.shutdownError='CHAIN_EVENT_WRITER_SHUTDOWN_UNDRAINED';this.error=this.shutdownError;}
    const worker=this.worker;if(worker)await new Promise<void>(done=>{let settled=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);done();};
      const timer=setTimeout(()=>{void worker.terminate().then(finish,finish);},3_000);worker.once('exit',finish);
      try{worker.postMessage('stop');}catch{void worker.terminate().then(finish,finish);}});
    this.worker=undefined;this.ready=false;this.state='stopped';this.shutdownDrained=drained;this.resolveDrainers();return drained;
  }

  private valid(event:ChainEvent):boolean {
    return validEvent(event);
  }
  private launch():void {
    if(this.state==='stopped'||this.worker)return;
    try {const source=import.meta.url.endsWith('.ts'),entry=new URL(`./chain-event-writer-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,maxBytes:this.options.maxBytes,busyTimeoutMs:this.busyTimeoutMs},env:{},execArgv:[]});
      this.worker=worker;this.ready=false;worker.on('message',message=>{if(this.worker!==worker)return;
        if(message?.type==='ready'){this.reconcileTotals(message.totals);this.ready=true;if(this.state!=='stopping')this.state='ready';this.error=undefined;this.schedule();}
        else if(message?.type==='result')this.handleResult(message as WorkerResult);
        else if(message?.type==='fatal')this.error='CHAIN_EVENT_WRITER_STORE_OPEN_FAILED';});
      worker.on('error',()=>{if(this.worker===worker)this.error='CHAIN_EVENT_WRITER_WORKER_FAILED';});
      worker.on('exit',()=>this.handleExit(worker));
    }catch{this.error='CHAIN_EVENT_WRITER_START_FAILED';this.scheduleRestart();}
  }
  private schedule():void {
    if(this.dispatchTimer||!this.ready||!this.worker||this.inFlight||(!this.pending.size&&!this.incompleteReasons.size))return;
    this.dispatchTimer=setImmediate(()=>{this.dispatchTimer=undefined;this.dispatch();});
  }
  private dispatch():void {
    if(!this.ready||!this.worker||this.inFlight||(!this.pending.size&&!this.incompleteReasons.size))return;
    const items=[...this.pending.values()].slice(0,this.batchSize);for(const item of items)this.pending.delete(item.event.id);
    const markers=[...this.incompleteReasons.values()];this.incompleteReasons.clear();const id=++this.batchId;
    this.inFlight={id,items,markers,startedAt:Date.now()};
    try{this.worker.postMessage({type:'batch',batchId:id,events:items.map(item=>item.event),incompleteReasons:markers.map(marker=>marker.reason)});}
    catch{const batch=this.inFlight;this.inFlight=undefined;if(batch){for(const item of batch.items)this.retryItem(item);for(const marker of batch.markers)this.retryMarker(marker);}
      void this.worker.terminate().catch(()=>{});}
  }
  private handleResult(message:WorkerResult):void {
    const batch=this.inFlight;if(!batch||message.batchId!==batch.id)return;this.inFlight=undefined;
    this.lastBatchMs=Math.max(0,Math.round(message.elapsedMs));this.maxBatchMs=Math.max(this.maxBatchMs,this.lastBatchMs);
    this.completed+=Math.max(0,message.completed);if(!this.reconcileTotals(message.totals)){
      this.inserted+=Math.max(0,message.inserted);
      for(const chain of CHAINS)this.insertedByChain[chain]+=Math.max(0,Number(message.insertedByChain?.[chain])||0);
    }
    const failed=new Set<number>();for(const failure of message.failed){const item=batch.items[failure.index];if(!item||failed.has(failure.index))continue;
      failed.add(failure.index);this.failedAttempts++;this.error=failure.reason;
      if(failure.retryable)this.retryItem(item);else {this.droppedAfterRetries++;this.unpersistedEvents++;this.markIncomplete('CHAIN_LIVE_EVENT_PERSIST_FAILED');}}
    for(let index=0;index<batch.items.length;index++)if(!failed.has(index)&&index>=message.completed+message.failed.length){
      this.failedAttempts++;this.retryItem(batch.items[index]);}
    const markerFailures=new Set(message.markerFailures);
    for(const marker of batch.markers)if(markerFailures.has(marker.reason))this.retryMarker(marker);else this.failedIncompleteReasons.delete(marker.reason);
    if(!message.failed.length&&!message.markerFailures.length)this.error=undefined;
    this.lastCompletedAt=new Date().toISOString();this.resolveDrainers();this.schedule();
  }
  private retryItem(item:WorkItem):void {
    const retried={...item,attempts:item.attempts+1};if(retried.attempts>=this.maxAttempts){this.droppedAfterRetries++;this.unpersistedEvents++;
      this.markIncomplete('CHAIN_LIVE_EVENT_RETRY_EXHAUSTED');return;}
    const current=this.pending.get(item.event.id);if(current){this.coalesced++;if(item.event.removed&&!current.event.removed)this.pending.set(item.event.id,retried);return;}
    if(this.pending.size>=this.capacity){this.droppedAfterRetries++;this.unpersistedEvents++;this.markIncomplete('CHAIN_LIVE_EVENT_QUEUE_FULL');return;}
    this.pending.set(item.event.id,retried);
  }
  private reconcileTotals(value:unknown):boolean {
    if(!value||typeof value!=='object')return false;const totals=value as Partial<WorkerTotals>,liveEvents=Number(totals.liveEvents),byChain=totals.liveEventsByChain;
    if(!Number.isSafeInteger(liveEvents)||liveEvents<0||!byChain||typeof byChain!=='object')return false;
    const normalized=chainCounts();for(const chain of CHAINS){const count=Number(byChain[chain]);if(!Number.isSafeInteger(count)||count<0)return false;normalized[chain]=count;}
    this.authoritativeLiveEvents=liveEvents;this.authoritativeLiveByChain=normalized;
    if(this.baselineLiveEvents===undefined){this.baselineLiveEvents=liveEvents;this.baselineLiveByChain={...normalized};return true;}
    this.inserted=Math.max(0,liveEvents-this.baselineLiveEvents);
    for(const chain of CHAINS)this.insertedByChain[chain]=Math.max(0,normalized[chain]-(this.baselineLiveByChain?.[chain]??normalized[chain]));
    return true;
  }
  private retryMarker(item:MarkerItem):void {const retried={...item,attempts:item.attempts+1};
    if(retried.attempts>=this.maxAttempts){this.failedIncompleteReasons.add(item.reason);this.error='CHAIN_EVENT_WRITER_INCOMPLETE_MARKER_FAILED';return;}
    this.incompleteReasons.set(item.reason,retried);}
  private handleExit(worker:Worker):void {
    if(this.worker!==worker)return;this.worker=undefined;this.ready=false;
    if(this.inFlight){const batch=this.inFlight;this.inFlight=undefined;this.failedAttempts+=batch.items.length;
      for(const item of batch.items)this.retryItem(item);for(const marker of batch.markers)this.retryMarker(marker);}
    if(this.state==='stopped')return;if(this.state==='stopping'&&this.drained()){this.resolveDrainers();return;}
    if(this.state!=='stopping')this.state='starting';this.error??='CHAIN_EVENT_WRITER_WORKER_EXITED';this.scheduleRestart();
  }
  private scheduleRestart():void {if(this.state==='stopped'||this.retry)return;this.restarts++;
    this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},this.restartDelayMs);this.retry.unref();}
  private drained():boolean {return this.pending.size===0&&!this.inFlight&&this.incompleteReasons.size===0;}
  private flush(timeoutMs:number):Promise<boolean> {if(this.drained())return Promise.resolve(true);
    return new Promise(resolve=>{let waiter!:DrainWaiter;waiter={finish:value=>{clearTimeout(waiter.timer);this.drainWaiters.delete(waiter);resolve(value);},
      timer:setTimeout(()=>waiter.finish(false),timeoutMs)};this.drainWaiters.add(waiter);});}
  private resolveDrainers():void {if(this.drained())for(const waiter of [...this.drainWaiters])waiter.finish(true);}
}

/** Shared-store fallback for an in-memory database. It preserves one SQLite
 * identity while deferring every write beyond the websocket callback.
 * Persistent databases always use ChainEventWriterRunner and a worker. */
export class DeferredChainEventWriter implements ChainEventWriter {
  private readonly pending=new Map<string,ChainEvent>();private readonly markers=new Set<string>();
  private readonly insertedByChain:Record<Chain,number>={bsc:0,solana:0,robinhood:0};
  private state:ChainEventWriterStatus['state']='idle';private accepting=true;private scheduled?:ReturnType<typeof setImmediate>;
  private accepted=0;private coalesced=0;private rejectedInvalid=0;private rejectedCapacity=0;private rejectedClosed=0;
  private completed=0;private inserted=0;private failedAttempts=0;private droppedAfterRetries=0;private unpersistedEvents=0;
  private lastBatchMs=0;private maxBatchMs=0;private lastCompletedAt?:string;private error?:string;private shutdownError?:string;
  private shutdownDrained?:boolean;private stopPromise?:Promise<boolean>;private drainWaiters=new Set<DrainWaiter>();

  constructor(private readonly store:ChainStreamStore,private readonly capacity=1_024,private readonly batchSize=32){
    if(!Number.isSafeInteger(capacity)||capacity<1||capacity>20_000||
      !Number.isSafeInteger(batchSize)||batchSize<1||batchSize>capacity)throw new Error('CHAIN_EVENT_WRITER_CONFIG_INVALID');
  }

  start():void {if(this.state==='stopped')throw new Error('CHAIN_EVENT_WRITER_STOPPED');if(this.state==='idle')this.state='ready';this.schedule();}
  enqueue(event:ChainEvent):boolean {
    if(!this.accepting||this.state==='stopping'||this.state==='stopped'){this.rejectedClosed++;return false;}
    if(!validEvent(event)){this.rejectedInvalid++;return false;}
    const current=this.pending.get(event.id);if(current){this.accepted++;this.coalesced++;
      if(event.removed&&!current.removed){this.pending.delete(event.id);this.pending.set(event.id,event);}return true;}
    if(this.pending.size>=this.capacity){this.rejectedCapacity++;this.unpersistedEvents++;
      this.markIncomplete('CHAIN_LIVE_EVENT_QUEUE_FULL');return false;}
    this.accepted++;this.pending.set(event.id,event);this.schedule();return true;
  }
  markIncomplete(reason:string):void {if(/^CHAIN_[A-Z_]{1,70}$/.test(reason)){this.markers.add(reason);this.schedule();}}
  status():ChainEventWriterStatus {return {state:this.state,running:this.state==='ready',ready:this.state==='ready',countOwnership:'shared',
    pending:this.pending.size,inFlight:0,capacity:this.capacity,accepted:this.accepted,coalesced:this.coalesced,rejectedInvalid:this.rejectedInvalid,
    rejectedCapacity:this.rejectedCapacity,rejectedClosed:this.rejectedClosed,completed:this.completed,inserted:this.inserted,
    insertedByChain:{...this.insertedByChain},failedAttempts:this.failedAttempts,droppedAfterRetries:this.droppedAfterRetries,
    droppedOnStop:0,unconfirmedOnStop:0,unpersistedEvents:this.unpersistedEvents,restarts:0,pendingIncompleteReasons:[...this.markers],
    unpersistedIncompleteReasons:[],lastBatchMs:this.lastBatchMs,maxBatchMs:this.maxBatchMs,oldestPendingMs:0,lastCompletedAt:this.lastCompletedAt,
    shutdownDrained:this.shutdownDrained,...(this.error?{error:this.error}:{}),...(this.shutdownError?{shutdownError:this.shutdownError}:{})};}
  stop(timeoutMs=5_000):Promise<boolean>{if(this.stopPromise)return this.stopPromise;
    if(this.state==='stopped')return Promise.resolve(this.shutdownDrained!==false);
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new Error('CHAIN_EVENT_WRITER_STOP_TIMEOUT_INVALID');
    this.stopPromise=this.performStop(timeoutMs);return this.stopPromise;}
  private async performStop(timeoutMs:number):Promise<boolean>{this.accepting=false;this.state='stopping';this.schedule();
    const drained=await this.flush(timeoutMs);if(!drained){this.shutdownError='CHAIN_EVENT_WRITER_SHUTDOWN_UNDRAINED';this.error=this.shutdownError;}
    clearImmediate(this.scheduled);this.scheduled=undefined;this.state='stopped';this.shutdownDrained=drained;return drained;}
  private schedule():void {if(this.scheduled||this.state==='idle'||this.state==='stopped'||(!this.pending.size&&!this.markers.size))return;
    this.scheduled=setImmediate(()=>{this.scheduled=undefined;this.drain();});}
  private drain():void {const started=performance.now();for(const reason of [...this.markers])try{this.store.markIncomplete(reason);this.markers.delete(reason);}
    catch{this.failedAttempts++;this.error='CHAIN_EVENT_WRITER_INCOMPLETE_MARKER_FAILED';}
    for(const [id,event] of [...this.pending].slice(0,this.batchSize)){this.pending.delete(id);try{const changed=this.store.record(event);this.completed++;
      if(changed){this.inserted++;this.insertedByChain[event.chain]++;}}
      catch{this.failedAttempts++;this.droppedAfterRetries++;this.unpersistedEvents++;this.error='CHAIN_EVENT_WRITER_WRITE_FAILED';
        this.markers.add('CHAIN_LIVE_EVENT_PERSIST_FAILED');}}
    this.lastBatchMs=Math.max(0,Math.round(performance.now()-started));this.maxBatchMs=Math.max(this.maxBatchMs,this.lastBatchMs);
    this.lastCompletedAt=new Date().toISOString();this.resolveDrainers();this.schedule();}
  private drained():boolean{return !this.pending.size&&!this.markers.size;}
  private flush(timeoutMs:number):Promise<boolean>{if(this.drained())return Promise.resolve(true);return new Promise(resolve=>{let waiter!:DrainWaiter;
    waiter={finish:value=>{clearTimeout(waiter.timer);this.drainWaiters.delete(waiter);resolve(value);},timer:setTimeout(()=>waiter.finish(false),timeoutMs)};
    this.drainWaiters.add(waiter);});}
  private resolveDrainers():void {if(this.drained())for(const waiter of [...this.drainWaiters])waiter.finish(true);}
}

function validEvent(event:ChainEvent):boolean {if(!event||!CHAINS.includes(event.chain)||typeof event.id!=='string'||!/^[a-f\d]{64}$/.test(event.id)||
  typeof event.observedAt!=='string'||event.observedAt.length>40)return false;try{return JSON.stringify(event).length<=65_536;}catch{return false;}}
