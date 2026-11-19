import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {WalletHistoryToken,WalletMarketCandidateContext} from './wallet-history.js';

export interface WalletMarketCandidateWrite {
  token:WalletHistoryToken;context:WalletMarketCandidateContext;
}

export interface WalletMarketCandidateWriterOptions {
  database:string;maxBytes:number;capacity?:number;requestTimeoutMs?:number;restartDelayMs?:number;
  /** Test-only delay inside the worker. Production leaves this unset. */
  testDelayMs?:number;
}

interface PendingWrite {
  resolve:(accepted:boolean)=>void;timer:ReturnType<typeof setTimeout>;enqueuedAt:number;
}
interface WorkerResult {type:'result';id:number;accepted:boolean;elapsedMs:number;error?:string;}
interface DrainWaiter {finish:(drained:boolean)=>void;timer:ReturnType<typeof setTimeout>;}

/**
 * Bounded bridge for GMGN discovery nominations. The discovery database is
 * the durable outbox; its row is ACKed only after this worker confirms the
 * WalletHistory transaction. A worker failure therefore leaves replayable
 * evidence instead of moving SQLite work back onto the service loop.
 */
export class WalletMarketCandidateWriterRunner {
  private readonly capacity:number;private readonly requestTimeoutMs:number;private readonly restartDelayMs:number;
  private worker?:Worker;private restartTimer?:ReturnType<typeof setTimeout>;private nextId=0;
  private readonly pending=new Map<number,PendingWrite>();private readonly drainWaiters=new Set<DrainWaiter>();
  private accepting=true;private running=false;private ready=false;private stopping=false;private stopped=false;
  private stopResult=true;private stopPromise?:Promise<boolean>;
  private admitted=0;private completed=0;private failed=0;private timedOut=0;private rejectedCapacity=0;private rejectedClosed=0;
  private restarts=0;private lastWriteMs=0;private maxWriteMs=0;private lastCompletedAt?:string;private error?:string;

  constructor(private readonly options:WalletMarketCandidateWriterOptions){
    this.capacity=options.capacity??128;this.requestTimeoutMs=options.requestTimeoutMs??15_000;
    this.restartDelayMs=options.restartDelayMs??1_000;
    if(!options.database||!Number.isSafeInteger(options.maxBytes)||options.maxBytes<16_384||
      !Number.isSafeInteger(this.capacity)||this.capacity<1||this.capacity>1_000||
      !Number.isSafeInteger(this.requestTimeoutMs)||this.requestTimeoutMs<100||this.requestTimeoutMs>60_000||
      !Number.isSafeInteger(this.restartDelayMs)||this.restartDelayMs<10||this.restartDelayMs>60_000||
      options.testDelayMs!==undefined&&(!Number.isSafeInteger(options.testDelayMs)||options.testDelayMs<0||options.testDelayMs>10_000))
      throw new Error('WALLET_MARKET_CANDIDATE_WRITER_CONFIG_INVALID');
  }

  start():void {
    if(this.stopped)throw new Error('WALLET_MARKET_CANDIDATE_WRITER_STOPPED');
    if(this.running||this.stopping)return;this.running=true;this.launch();
  }

  capture(token:WalletHistoryToken,context:WalletMarketCandidateContext):Promise<boolean> {
    if(!this.accepting||this.stopping||this.stopped){this.rejectedClosed++;return Promise.resolve(false);}
    if(!this.running)this.start();
    const worker=this.worker;
    if(!worker){this.failed++;this.error='WALLET_MARKET_CANDIDATE_WORKER_UNAVAILABLE';return Promise.resolve(false);}
    if(this.pending.size>=this.capacity){this.rejectedCapacity++;this.error='WALLET_MARKET_CANDIDATE_QUEUE_FULL';return Promise.resolve(false);}
    const id=++this.nextId,enqueuedAt=Date.now();this.admitted++;
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{
        const pending=this.pending.get(id);if(!pending)return;
        this.pending.delete(id);this.failed++;this.timedOut++;this.error='WALLET_MARKET_CANDIDATE_WORKER_TIMEOUT';pending.resolve(false);
        this.resolveDrainers();if(this.worker===worker)void worker.terminate().catch(()=>{});
      },this.requestTimeoutMs);timer.unref();
      this.pending.set(id,{resolve,timer,enqueuedAt});
      try{worker.postMessage({type:'capture',id,write:{token,context} satisfies WalletMarketCandidateWrite});}
      catch{clearTimeout(timer);this.pending.delete(id);this.failed++;this.error='WALLET_MARKET_CANDIDATE_WORKER_UNAVAILABLE';
        resolve(false);this.resolveDrainers();}
    });
  }

  status(){let oldest=Infinity;for(const pending of this.pending.values())oldest=Math.min(oldest,pending.enqueuedAt);
    const state=this.stopped?'stopped':this.stopping?'stopping':this.ready?'ready':this.running?'starting':'idle';
    return {enabled:true,state,running:this.running&&!!this.worker,ready:this.ready,stopping:this.stopping,stopped:this.stopped,
      pending:this.pending.size,capacity:this.capacity,requestTimeoutMs:this.requestTimeoutMs,admitted:this.admitted,completed:this.completed,
      failed:this.failed,timedOut:this.timedOut,rejectedCapacity:this.rejectedCapacity,rejectedClosed:this.rejectedClosed,restarts:this.restarts,
      oldestPendingMs:Number.isFinite(oldest)?Math.max(0,Date.now()-oldest):0,lastWriteMs:this.lastWriteMs,maxWriteMs:this.maxWriteMs,
      lastCompletedAt:this.lastCompletedAt,...(this.error?{error:this.error}:{})};}

  stop(drainMs=5_000):Promise<boolean> {
    if(this.stopPromise)return this.stopPromise;if(this.stopped)return Promise.resolve(this.stopResult);
    this.stopPromise=this.performStop(drainMs);return this.stopPromise;
  }

  private async performStop(drainMs:number):Promise<boolean> {
    this.accepting=false;this.stopping=true;clearTimeout(this.restartTimer);this.restartTimer=undefined;
    const drained=await this.flush(drainMs);
    if(!drained)this.rejectPending('WALLET_MARKET_CANDIDATE_SHUTDOWN_UNDRAINED');
    const worker=this.worker;
    if(worker)await new Promise<void>(done=>{let settled=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},3_000);timeout.unref();worker.once('exit',finish);
      try{worker.postMessage({type:'stop'});}catch{void worker.terminate().then(finish,finish);}
    });
    this.worker=undefined;this.ready=false;this.running=false;this.stopping=false;this.stopped=true;this.stopResult=drained;
    this.resolveDrainers();return drained;
  }

  private launch():void {
    if(!this.running||this.worker||this.stopping)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-market-candidate-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:this.options,env:{},execArgv:[]});this.worker=worker;this.ready=false;
      worker.on('message',(message:unknown)=>{
        if(this.worker!==worker||!message||typeof message!=='object')return;
        const value=message as {type?:string;id?:number;accepted?:boolean;elapsedMs?:number;error?:string};
        if(value.type==='ready'){this.ready=true;this.error=undefined;return;}
        if(value.type==='fatal'){this.error='WALLET_MARKET_CANDIDATE_STORE_OPEN_FAILED';void worker.terminate().catch(()=>{});return;}
        if(value.type==='result')this.handleResult(value as WorkerResult);
      });
      worker.on('error',()=>{if(this.worker===worker)this.error='WALLET_MARKET_CANDIDATE_WORKER_FAILED';});
      worker.on('exit',()=>this.handleExit(worker));
    }catch{this.error='WALLET_MARKET_CANDIDATE_WORKER_START_FAILED';this.scheduleRestart();}
  }

  private handleResult(message:WorkerResult):void {
    const pending=this.pending.get(message.id);if(!pending)return;
    this.pending.delete(message.id);clearTimeout(pending.timer);this.lastWriteMs=Math.max(0,Math.round(message.elapsedMs));
    this.maxWriteMs=Math.max(this.maxWriteMs,this.lastWriteMs);
    if(message.accepted){this.completed++;this.lastCompletedAt=new Date().toISOString();this.error=undefined;pending.resolve(true);}
    else {this.failed++;this.error=message.error??'WALLET_MARKET_CANDIDATE_WRITE_REJECTED';pending.resolve(false);}
    this.resolveDrainers();
  }

  private handleExit(worker:Worker):void {
    if(this.worker!==worker)return;this.worker=undefined;this.ready=false;
    this.rejectPending('WALLET_MARKET_CANDIDATE_WORKER_UNAVAILABLE');
    if(this.running&&!this.stopping){this.error??='WALLET_MARKET_CANDIDATE_WORKER_EXITED';this.scheduleRestart();}
  }

  private rejectPending(reason:string):void {
    if(this.pending.size)this.error=reason;
    for(const pending of this.pending.values()){clearTimeout(pending.timer);this.failed++;pending.resolve(false);}
    this.pending.clear();this.resolveDrainers();
  }

  private scheduleRestart():void {
    if(!this.running||this.stopping||this.restartTimer)return;this.restarts++;
    this.restartTimer=setTimeout(()=>{this.restartTimer=undefined;this.launch();},this.restartDelayMs);this.restartTimer.unref();
  }

  private flush(timeoutMs:number):Promise<boolean> {
    if(!this.pending.size)return Promise.resolve(true);
    return new Promise(resolve=>{let waiter!:DrainWaiter;waiter={finish:drained=>{clearTimeout(waiter.timer);this.drainWaiters.delete(waiter);resolve(drained);},
      timer:setTimeout(()=>waiter.finish(false),timeoutMs)};waiter.timer.unref();this.drainWaiters.add(waiter);});
  }
  private resolveDrainers():void {if(!this.pending.size)for(const waiter of [...this.drainWaiters])waiter.finish(true);}
}
