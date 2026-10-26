import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

export interface WalletScreeningObservationRunnerOptions {
  database:string;
  historyDatabase:string;
  maxBytes:number;
}

export interface WalletScreeningObservationRunnerStatus {
  running:boolean;
  inFlight:boolean;
  processedTokens:number;
  elapsedMs:number;
  restarts:number;
  lastAttemptAt?:string;
  completedAt?:string;
  error?:string;
}

type Pending={resolve:()=>void;reject:(error:Error)=>void;timeout:ReturnType<typeof setTimeout>};

/**
 * Owns the write-heavy forward-outcome refresh outside the stream/HTTP loop.
 * The durable ledger remains the queue: a failed worker leaves last_checked_at
 * unchanged, so the next run safely retries the same opportunity.
 */
export class WalletScreeningObservationRunner {
  private worker?:Worker;
  private retry?:ReturnType<typeof setTimeout>;
  private running=false;
  private inFlight=false;
  private sequence=0;
  private restarts=0;
  private processedTokens=0;
  private elapsedMs=0;
  private lastAttemptAt?:string;
  private completedAt?:string;
  private error?:string;
  private readonly pending=new Map<number,Pending>();

  constructor(private readonly options:WalletScreeningObservationRunnerOptions) {
    if(!options.database||!options.historyDatabase||!Number.isSafeInteger(options.maxBytes)||options.maxBytes<65_536)
      throw new Error('WALLET_SCREENING_OBSERVATION_RUNNER_CONFIG_INVALID');
  }

  status():WalletScreeningObservationRunnerStatus {
    return {running:this.running&&!!this.worker,inFlight:this.inFlight,processedTokens:this.processedTokens,
      elapsedMs:this.elapsedMs,restarts:this.restarts,lastAttemptAt:this.lastAttemptAt,completedAt:this.completedAt,
      ...(this.error?{error:this.error}:{})};
  }

  start():void {
    if(this.running)return;
    this.running=true;this.launch();
  }

  run(at:Date):Promise<void> {
    if(!this.running||!this.worker)return Promise.reject(new Error('WALLET_SCREENING_OBSERVATION_WORKER_UNAVAILABLE'));
    if(this.inFlight)return Promise.reject(new Error('WALLET_SCREENING_OBSERVATION_WORKER_BUSY'));
    if(!Number.isFinite(at.getTime()))return Promise.reject(new Error('WALLET_SCREENING_OBSERVATION_TIME_INVALID'));
    const timestamp=at.toISOString();
    this.inFlight=true;this.lastAttemptAt=timestamp;
    const id=++this.sequence,worker=this.worker;
    return new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>{
        const request=this.pending.get(id);if(!request)return;
        this.pending.delete(id);this.inFlight=false;this.error='WALLET_SCREENING_OBSERVATION_WORKER_TIMEOUT';
        request.reject(new Error(this.error));void worker.terminate().catch(()=>{});
      },30_000);timeout.unref();
      this.pending.set(id,{resolve,reject,timeout});
      try{worker.postMessage({type:'run',id,at:timestamp});}
      catch{clearTimeout(timeout);this.pending.delete(id);this.inFlight=false;reject(new Error('WALLET_SCREENING_OBSERVATION_WORKER_UNAVAILABLE'));}
    });
  }

  private launch():void {
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-screening-observation-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:this.options,env:{},execArgv:[]});this.worker=worker;
      worker.on('message',message=>{
        if(this.worker!==worker||message?.type!=='result'||!Number.isSafeInteger(message.id))return;
        const request=this.pending.get(message.id);if(!request)return;
        clearTimeout(request.timeout);this.pending.delete(message.id);this.inFlight=false;
        if(message.ok===true){
          this.processedTokens=Number.isSafeInteger(message.processedTokens)&&message.processedTokens>=0?message.processedTokens:0;
          this.elapsedMs=typeof message.elapsedMs==='number'&&Number.isFinite(message.elapsedMs)&&message.elapsedMs>=0?message.elapsedMs:0;
          this.completedAt=typeof message.completedAt==='string'?message.completedAt:new Date().toISOString();this.error=undefined;request.resolve();
        }else{
          this.error='WALLET_SETUP_OBSERVATION_FAILED';request.reject(new Error(this.error));
        }
      });
      worker.on('error',()=>{if(this.worker===worker)this.error='WALLET_SCREENING_OBSERVATION_WORKER_FAILED';});
      worker.on('exit',()=>{
        if(this.worker!==worker)return;
        this.worker=undefined;this.inFlight=false;
        this.rejectPending('WALLET_SCREENING_OBSERVATION_WORKER_EXITED');
        if(this.running){this.error??='WALLET_SCREENING_OBSERVATION_WORKER_EXITED';this.scheduleRestart();}
      });
    }catch{this.error='WALLET_SCREENING_OBSERVATION_WORKER_START_FAILED';this.scheduleRestart();}
  }

  private rejectPending(code:string):void {
    for(const [id,request] of this.pending){clearTimeout(request.timeout);request.reject(new Error(code));this.pending.delete(id);}
  }

  private scheduleRestart():void {
    if(!this.running||this.retry)return;
    this.restarts++;this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},1_000);this.retry.unref();
  }

  async stop():Promise<void> {
    this.running=false;clearTimeout(this.retry);this.retry=undefined;
    const worker=this.worker;this.worker=undefined;this.inFlight=false;
    this.rejectPending('WALLET_SCREENING_OBSERVATION_WORKER_STOPPED');
    if(worker)await new Promise<void>(done=>{
      let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},3_000);
      worker.once('exit',finish);
      try{worker.postMessage({type:'stop'});}catch{void worker.terminate().then(finish,finish);}
    });
  }
}
