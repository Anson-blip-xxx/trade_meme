import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {chainAddress} from './chain-stream-store.js';
import type {LauncherCandidatesOptions,LauncherRealtimeObservation} from './launcher-candidates.js';
import type {Chain} from './types.js';

export interface LauncherRealtimeWriterOptions extends Omit<LauncherCandidatesOptions,'now'> {
  targetLimits:Partial<Record<Chain,number>>;
  capacity?:number;batchSize?:number;delayMs?:number;maxAttempts?:number;
  restartDelayMs?:number;workerTimeoutMs?:number;targetRefreshMs?:number;
}
interface WorkItem {key:string;observation:LauncherRealtimeObservation;attempts:number;enqueuedAt:number}
interface WorkerResult {type:'result';batchId:number;completed:number;changed:number;elapsedMs:number;error?:string;retryable?:boolean}
interface DrainWaiter {finish:(drained:boolean)=>void;timer:ReturnType<typeof setTimeout>}

const CHAINS:readonly Chain[]=['bsc','solana','robinhood'];

/**
 * Bounded latest-per-wallet bridge for socket liveness. SQLite reads and
 * writes live exclusively in the worker; the service loop only validates,
 * coalesces and reads compact target DTOs.
 */
export class LauncherRealtimeWriterRunner {
  private readonly capacity:number;private readonly batchSize:number;private readonly delayMs:number;
  private readonly maxAttempts:number;private readonly restartDelayMs:number;private readonly workerTimeoutMs:number;
  private readonly targetRefreshMs:number;
  private pending=new Map<string,WorkItem>();private inFlight?:{id:number;items:WorkItem[];startedAt:number};
  private targets:Partial<Record<Chain,{targets:string[];priority:string[];membership:string[]}>>={};private targetsAt?:string;
  private worker?:Worker;private dispatchTimer?:ReturnType<typeof setTimeout>;private targetTimer?:ReturnType<typeof setInterval>;
  private retry?:ReturnType<typeof setTimeout>;private watchdog?:ReturnType<typeof setInterval>;
  private drainWaiters=new Set<DrainWaiter>();private accepting=true;private running=false;private ready=false;private stopping=false;
  private stopped=false;private stopResult=true;private stopPromise?:Promise<boolean>;
  private batchId=0;private enqueued=0;private coalesced=0;private staleIgnored=0;private rejectedCapacity=0;private rejectedClosed=0;
  private completed=0;private changed=0;private failures=0;private droppedAfterRetries=0;private droppedOnStop=0;private restarts=0;
  private lastBatchMs=0;private maxBatchMs=0;private lastCompletedAt?:string;private error?:string;private targetError?:string;

  constructor(private readonly options:LauncherRealtimeWriterOptions){
    this.capacity=options.capacity??1000;this.batchSize=options.batchSize??500;this.delayMs=options.delayMs??25;
    this.maxAttempts=options.maxAttempts??3;this.restartDelayMs=options.restartDelayMs??1000;
    this.workerTimeoutMs=options.workerTimeoutMs??10_000;this.targetRefreshMs=options.targetRefreshMs??30_000;
    const limits=Object.values(options.targetLimits);
    if(!options.database||!options.profileDatabase||!Number.isSafeInteger(this.capacity)||this.capacity<1||this.capacity>10_000||
      !Number.isSafeInteger(this.batchSize)||this.batchSize<1||this.batchSize>this.capacity||
      !Number.isSafeInteger(this.delayMs)||this.delayMs<0||this.delayMs>60_000||
      !Number.isSafeInteger(this.maxAttempts)||this.maxAttempts<1||this.maxAttempts>10||
      !Number.isSafeInteger(this.restartDelayMs)||this.restartDelayMs<10||
      !Number.isSafeInteger(this.workerTimeoutMs)||this.workerTimeoutMs<100||
      !Number.isSafeInteger(this.targetRefreshMs)||this.targetRefreshMs<100||
      !limits.length||limits.some(limit=>!Number.isSafeInteger(limit)||limit!<1||limit!>5000))
      throw new Error('LAUNCHER_REALTIME_WRITER_CONFIG_INVALID');
  }

  start():void {if(this.stopped)throw new Error('LAUNCHER_REALTIME_WRITER_STOPPED');if(this.running||this.stopping)return;this.running=true;this.launch();
    this.targetTimer=setInterval(()=>this.requestTargets(),this.targetRefreshMs);this.targetTimer.unref();
    this.watchdog=setInterval(()=>{if(this.worker&&this.inFlight&&Date.now()-this.inFlight.startedAt>this.workerTimeoutMs){
      this.error='LAUNCHER_REALTIME_WRITER_TIMEOUT';void this.worker.terminate().catch(()=>{});}},
    Math.min(1000,Math.max(100,Math.floor(this.workerTimeoutMs/4))));this.watchdog.unref();}

  enqueue(observation:LauncherRealtimeObservation):boolean {
    if(!this.accepting||this.stopping){this.rejectedClosed++;return false;}
    const prepared=this.validate(observation);if(!prepared){this.failures++;return false;}
    const current=this.pending.get(prepared.key),incomingAt=Date.parse(prepared.observation.observedAt!);
    if(current){this.enqueued++;const currentAt=Date.parse(current.observation.observedAt!);
      if(incomingAt<=currentAt){this.staleIgnored++;return true;}
      this.pending.delete(prepared.key);this.pending.set(prepared.key,prepared);this.coalesced++;this.schedule();return true;}
    if(this.pending.size+(this.inFlight?.items.length??0)>=this.capacity){this.rejectedCapacity++;return false;}
    this.pending.set(prepared.key,prepared);this.enqueued++;this.schedule();return true;
  }

  targetSnapshot(chain:Chain,limit=this.options.targetLimits[chain]??30):{targets:string[];priority:string[];membership:Set<string>;computedAt?:string}{
    const cached=this.targets[chain],size=Math.max(1,Math.min(5000,Math.trunc(limit)));
    return {targets:(cached?.targets??[]).slice(0,size),priority:(cached?.priority??[]).slice(0,size),
      membership:new Set(cached?.membership??[]),computedAt:this.targetsAt};
  }

  status(){let oldest=Infinity;for(const item of this.pending.values())oldest=Math.min(oldest,item.enqueuedAt);
    if(this.inFlight)for(const item of this.inFlight.items)oldest=Math.min(oldest,item.enqueuedAt);
    const state=this.stopped?'stopped':this.stopping?'stopping':this.ready?'ready':this.running?'starting':'idle';
    return {state,running:this.running&&!!this.worker,ready:this.ready,stopping:this.stopping,stopped:this.stopped,pending:this.pending.size,
      inFlight:this.inFlight?.items.length??0,capacity:this.capacity,batchSize:this.batchSize,delayMs:this.delayMs,
      enqueued:this.enqueued,coalesced:this.coalesced,staleIgnored:this.staleIgnored,rejectedCapacity:this.rejectedCapacity,
      rejectedClosed:this.rejectedClosed,completed:this.completed,changed:this.changed,failures:this.failures,
      droppedAfterRetries:this.droppedAfterRetries,droppedOnStop:this.droppedOnStop,restarts:this.restarts,
      lastBatchMs:this.lastBatchMs,maxBatchMs:this.maxBatchMs,oldestPendingMs:Number.isFinite(oldest)?Math.max(0,Date.now()-oldest):0,
      lastCompletedAt:this.lastCompletedAt,targetsAt:this.targetsAt,
      targetCounts:Object.fromEntries(CHAINS.map(chain=>[chain,this.targets[chain]?.targets.length??0])),
      priorityTargetCounts:Object.fromEntries(CHAINS.map(chain=>[chain,this.targets[chain]?.priority.length??0])),
      membershipCounts:Object.fromEntries(CHAINS.map(chain=>[chain,this.targets[chain]?.membership.length??0])),
      ...(this.error?{error:this.error}:{}),...(this.targetError?{targetError:this.targetError}:{})};}

  stop(drainMs=5000):Promise<boolean> {if(this.stopPromise)return this.stopPromise;
    if(this.stopped)return Promise.resolve(this.stopResult);this.stopPromise=this.performStop(drainMs);return this.stopPromise;}
  private async performStop(drainMs:number):Promise<boolean> {
    this.accepting=false;this.stopping=true;clearInterval(this.targetTimer);this.targetTimer=undefined;
    if(!this.running){const drained=this.pending.size===0;this.droppedOnStop+=this.pending.size;this.pending.clear();
      this.ready=false;this.stopping=false;this.stopped=true;this.stopResult=drained;this.resolveDrainers();return drained;}
    this.schedule(0);const drained=await this.flush(drainMs);clearTimeout(this.retry);clearTimeout(this.dispatchTimer);clearInterval(this.watchdog);
    this.retry=undefined;this.dispatchTimer=undefined;this.watchdog=undefined;
    if(!drained){this.droppedOnStop+=this.pending.size+(this.inFlight?.items.length??0);this.pending.clear();this.inFlight=undefined;}
    const worker=this.worker;if(worker)await new Promise<void>(done=>{let settled=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},3000);worker.once('exit',finish);
      try{worker.postMessage('stop');}catch{void worker.terminate().then(finish,finish);}});
    this.worker=undefined;this.ready=false;this.running=false;this.stopping=false;this.stopped=true;this.stopResult=drained;this.resolveDrainers();return drained;}

  private validate(value:LauncherRealtimeObservation):WorkItem|undefined {const chain=value?.chain,wallet=CHAINS.includes(chain)?chainAddress(chain,value.wallet):undefined,
      at=typeof value?.observedAt==='string'?Date.parse(value.observedAt):NaN,now=Date.now();
    if(!wallet||!Number.isFinite(at)||at>now||now-at>86_400_000||value.checkedAt!==undefined||value.latestSignature!==undefined||
      value.blockTime!==undefined||value.slot!==undefined||value.state!==undefined||value.newSignature!==undefined||
      value.classification!==undefined||value.error!==undefined||value.source!==undefined&&value.source!=='wallet_fast')return;
    const observation:LauncherRealtimeObservation={chain,wallet,observedAt:new Date(at).toISOString(),source:value.source??'wallet_fast'};
    return {key:`${chain}:${wallet}`,observation,attempts:0,enqueuedAt:Date.now()};}
  private launch():void {if(!this.running||this.worker||this.stopping||this.stopped)return;
    try {const source=import.meta.url.endsWith('.ts'),entry=new URL(`./launcher-realtime-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,profileDatabase:this.options.profileDatabase,
        cap:this.options.cap,maxBytes:this.options.maxBytes,freshAfterSec:this.options.freshAfterSec,liveAfterSec:this.options.liveAfterSec,
        coverageAfterSec:this.options.coverageAfterSec,busyTimeoutMs:this.options.busyTimeoutMs??100,targetLimits:this.options.targetLimits},env:{},execArgv:[]});
      this.worker=worker;this.ready=false;worker.on('message',message=>{if(this.worker!==worker)return;
        if(message?.type==='ready'){this.ready=true;this.error=undefined;this.requestTargets();this.schedule(0);}
        else if(message?.type==='result')this.handleResult(message as WorkerResult);
        else if(message?.type==='targets')this.acceptTargets(message);
        else if(message?.type==='targets-failed')this.targetError='LAUNCHER_REALTIME_TARGET_READ_FAILED';
        else if(message?.type==='fatal')this.error='LAUNCHER_REALTIME_STORE_OPEN_FAILED';});
      worker.on('error',()=>{if(this.worker===worker)this.error='LAUNCHER_REALTIME_WRITER_WORKER_FAILED';});
      worker.on('exit',()=>this.handleExit(worker));
    } catch {this.error='LAUNCHER_REALTIME_WRITER_START_FAILED';this.scheduleRestart();}}
  private acceptTargets(message:any):void {if(!message?.chains||typeof message.chains!=='object'||typeof message.computedAt!=='string'||!Number.isFinite(Date.parse(message.computedAt)))return;
    const next:Partial<Record<Chain,{targets:string[];priority:string[];membership:string[]}>>={};
    for(const chain of CHAINS){const row=message.chains[chain];if(!row)continue;const limit=this.options.targetLimits[chain]??0;
      if(!Array.isArray(row.targets)||!Array.isArray(row.priority)||!Array.isArray(row.membership)||row.targets.length>limit||
        row.priority.length>limit||row.membership.length>(this.options.cap??5000))continue;
      const targets:string[]=row.targets.flatMap((v:unknown)=>{const value=chainAddress(chain,v);return value?[value]:[];}),
        priority:string[]=row.priority.flatMap((v:unknown)=>{const value=chainAddress(chain,v);return value?[value]:[];}),
        membership:string[]=row.membership.flatMap((v:unknown)=>{const value=chainAddress(chain,v);return value?[value]:[];});
      if(targets.length!==row.targets.length||priority.length!==row.priority.length||membership.length!==row.membership.length||
        priority.some((wallet:string)=>!targets.includes(wallet)||!membership.includes(wallet)))continue;
      next[chain]={targets:[...new Set(targets)],priority:[...new Set(priority)],membership:[...new Set(membership)]};}
    this.targets=next;this.targetsAt=message.computedAt;this.targetError=undefined;}
  private requestTargets():void {if(!this.ready||!this.worker)return;try{this.worker.postMessage({type:'targets'});}catch{this.targetError='LAUNCHER_REALTIME_TARGET_READ_FAILED';}}
  private schedule(delay=this.delayMs):void {if(this.dispatchTimer||!this.ready||!this.worker||this.inFlight||!this.pending.size)return;
    this.dispatchTimer=setTimeout(()=>{this.dispatchTimer=undefined;this.dispatch();},delay);this.dispatchTimer.unref();}
  private dispatch():void {if(!this.ready||!this.worker||this.inFlight||!this.pending.size)return;
    const items=[...this.pending.values()].slice(0,this.batchSize);for(const item of items)this.pending.delete(item.key);
    const id=++this.batchId;this.inFlight={id,items,startedAt:Date.now()};
    try{this.worker.postMessage({type:'batch',batchId:id,items:items.map(item=>item.observation)});}
    catch{this.inFlight=undefined;for(const item of items)this.retryItem(item);void this.worker.terminate().catch(()=>{});}}
  private handleResult(message:WorkerResult):void {const batch=this.inFlight;if(!batch||batch.id!==message.batchId)return;
    this.inFlight=undefined;this.lastBatchMs=Math.max(0,Math.round(message.elapsedMs));this.maxBatchMs=Math.max(this.maxBatchMs,this.lastBatchMs);
    if(message.error){this.error=message.error;this.failures+=batch.items.length;
      if(message.retryable===false)this.droppedAfterRetries+=batch.items.length;else for(const item of batch.items)this.retryItem(item);}
    else {this.error=undefined;this.completed+=Math.max(0,message.completed);this.changed+=Math.max(0,message.changed);this.lastCompletedAt=new Date().toISOString();}
    this.resolveDrainers();this.schedule();}
  private retryItem(item:WorkItem):void {const attempts=item.attempts+1;if(attempts>=this.maxAttempts){this.droppedAfterRetries++;return;}
    const current=this.pending.get(item.key);if(current&&Date.parse(current.observation.observedAt!)>=Date.parse(item.observation.observedAt!)){this.coalesced++;return;}
    if(!current&&this.pending.size+(this.inFlight?.items.length??0)>=this.capacity){this.droppedAfterRetries++;return;}
    if(current)this.pending.delete(item.key);this.pending.set(item.key,{...item,attempts});}
  private handleExit(worker:Worker):void {if(this.worker!==worker)return;this.worker=undefined;this.ready=false;
    if(this.inFlight){const batch=this.inFlight;this.inFlight=undefined;this.failures+=batch.items.length;for(const item of batch.items)this.retryItem(item);}
    if(this.stopping){this.resolveDrainers();return;}this.error??='LAUNCHER_REALTIME_WRITER_WORKER_EXITED';this.scheduleRestart();}
  private scheduleRestart():void {if(!this.running||this.stopping||this.retry)return;this.restarts++;
    this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},this.restartDelayMs);this.retry.unref();}
  private drained():boolean{return this.pending.size===0&&!this.inFlight;}
  private flush(timeoutMs:number):Promise<boolean>{if(this.drained())return Promise.resolve(true);return new Promise(resolve=>{let waiter!:DrainWaiter;
    waiter={finish:value=>{clearTimeout(waiter.timer);this.drainWaiters.delete(waiter);resolve(value);},timer:setTimeout(()=>waiter.finish(false),timeoutMs)};this.drainWaiters.add(waiter);});}
  private resolveDrainers():void {if(this.drained())for(const waiter of [...this.drainWaiters])waiter.finish(true);}
}
