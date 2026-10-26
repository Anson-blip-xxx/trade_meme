import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {Chain} from './types.js';
import type {AveSignalObservation} from './providers/ave-signals.js';
import type {DebotSignalObservation} from './providers/debot-signals.js';

export type SourceResearchObservation=AveSignalObservation|DebotSignalObservation;
export interface SourceObservationResult {
  sourceError?:string;memeError?:string;nominationError?:string;
}
export interface SourceObservationRunnerOptions {
  source?:{database:string;maxBytes:number;maxEvents?:number};
  meme?:{database:string;activeWindowSec:number;chains:Chain[]};
  wallet?:{database:string;maxBytes:number};
  capacity?:number;
  requestTimeoutMs?:number;
  /** Test-only worker delay; production leaves this unset. */
  testDelayMs?:number;
}
interface Pending {resolve:(result:SourceObservationResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;}

/** Executes optional source research writes away from websocket, HTTP and
 * counting callbacks. Scanner inboxes remain the durable queue and retry any
 * request rejected by a worker exit. */
export class SourceObservationRunner {
  private worker?:Worker;private running=false;private ready=false;private nextId=1;private restarts=0;
  private restartTimer?:ReturnType<typeof setTimeout>;private readonly pending=new Map<number,Pending>();
  private readonly capacity:number;private error?:string;
  private readonly requestTimeoutMs:number;
  constructor(private readonly options:SourceObservationRunnerOptions){
    this.capacity=options.capacity??8;this.requestTimeoutMs=options.requestTimeoutMs??12_000;
    if(!Number.isSafeInteger(this.capacity)||this.capacity<1||this.capacity>100||
      !Number.isSafeInteger(this.requestTimeoutMs)||this.requestTimeoutMs<100||this.requestTimeoutMs>60_000||
      options.testDelayMs!==undefined&&(!Number.isSafeInteger(options.testDelayMs)||options.testDelayMs<0||options.testDelayMs>10_000))
      throw new Error('SOURCE_OBSERVATION_RUNNER_CONFIG_INVALID');
  }
  status(){return {enabled:true,running:this.running,ready:this.ready,inFlight:this.pending.size,
    capacity:this.capacity,requestTimeoutMs:this.requestTimeoutMs,restarts:this.restarts,...(this.error?{error:this.error}:{})};}
  start(){if(this.running)return;this.running=true;this.launch();}
  submit(observation:SourceResearchObservation):Promise<SourceObservationResult>{
    if(!this.running||!this.worker)return Promise.reject(new Error('SOURCE_OBSERVATION_WORKER_UNAVAILABLE'));
    if(this.pending.size>=this.capacity)return Promise.reject(new Error('SOURCE_OBSERVATION_QUEUE_FULL'));
    const id=this.nextId++;
    return new Promise<SourceObservationResult>((resolve,reject)=>{
      const worker=this.worker!,timer=setTimeout(()=>{
        if(!this.pending.has(id))return;
        this.error='SOURCE_OBSERVATION_WORKER_TIMEOUT';this.rejectPending(new Error(this.error));
        if(this.worker===worker)void worker.terminate();
      },this.requestTimeoutMs);timer.unref();
      this.pending.set(id,{resolve,reject,timer});
      try{this.worker!.postMessage({type:'observe',id,observation});}
      catch{clearTimeout(timer);this.pending.delete(id);reject(new Error('SOURCE_OBSERVATION_WORKER_UNAVAILABLE'));}
    });
  }
  private launch(){
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./source-observation-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:this.options,env:{},execArgv:[]});this.worker=worker;this.ready=false;
      worker.on('message',(message:unknown)=>{
        if(this.worker!==worker||!message||typeof message!=='object')return;
        const value=message as {type?:string;id?:number;result?:SourceObservationResult};
        if(value.type==='ready'){this.ready=true;this.error=undefined;return;}
        if(!Number.isSafeInteger(value.id))return;
        const pending=this.pending.get(value.id!);if(!pending)return;this.pending.delete(value.id!);clearTimeout(pending.timer);
        if(value.type==='done'){this.error=undefined;pending.resolve(value.result??{});}
        else {this.error='SOURCE_OBSERVATION_WRITE_FAILED';pending.reject(new Error(this.error));}
      });
      worker.on('error',()=>{if(this.worker===worker)this.error='SOURCE_OBSERVATION_WORKER_FAILED';});
      worker.on('exit',()=>{
        if(this.worker!==worker)return;this.worker=undefined;this.ready=false;
        this.rejectPending(new Error('SOURCE_OBSERVATION_WORKER_UNAVAILABLE'));
        if(this.running){this.error??='SOURCE_OBSERVATION_WORKER_EXITED';this.scheduleRestart();}
      });
    }catch{this.error='SOURCE_OBSERVATION_WORKER_START_FAILED';this.scheduleRestart();}
  }
  private rejectPending(error:Error){
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();
  }
  private scheduleRestart(){
    if(!this.running||this.restartTimer)return;this.restarts++;
    this.restartTimer=setTimeout(()=>{this.restartTimer=undefined;this.launch();},1000);this.restartTimer.unref();
  }
  async stop(){
    if(!this.running&&!this.worker)return;this.running=false;clearTimeout(this.restartTimer);this.restartTimer=undefined;
    const worker=this.worker;if(!worker)return;
    await new Promise<void>(done=>{
      const timeout=setTimeout(()=>{void worker.terminate();},5000);timeout.unref();
      worker.once('exit',()=>{clearTimeout(timeout);done();});
      try{worker.postMessage({type:'stop'});}catch{void worker.terminate();}
    });
    if(this.worker===worker)this.worker=undefined;this.ready=false;
  }
}
