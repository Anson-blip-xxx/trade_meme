import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {LauncherCandidateStatus,LauncherCandidatesOptions} from './launcher-candidates.js';

export interface LauncherCandidateRefreshRunnerOptions extends Omit<LauncherCandidatesOptions,'now'> {
  intervalMs:number;
  timeoutMs?:number;
  /** Test-only latency injection, executed inside the worker. */
  testDelayMs?:number;
}

export interface LauncherCandidateRefreshRunnerStatus {
  running:boolean;ready:boolean;inFlight:boolean;restarts:number;
  lastAttemptAt?:string;completedAt?:string;durationMs?:number;
  result?:LauncherCandidateStatus;error?:string;
}

type Waiter={resolve:(status:LauncherCandidateStatus)=>void;reject:(error:Error)=>void};

/** Keeps the full profile scan off the service event loop. */
export class LauncherCandidateRefreshRunner {
  private readonly timeoutMs:number;
  private worker?:Worker;private interval?:ReturnType<typeof setInterval>;private retry?:ReturnType<typeof setTimeout>;
  private watchdog?:ReturnType<typeof setInterval>;private running=false;private ready=false;private inFlight=false;
  private workingSince=0;private sequence=0;private restarts=0;private lastAttemptAt?:string;private completedAt?:string;
  private durationMs?:number;private result?:LauncherCandidateStatus;private error?:string;private waiters:Waiter[]=[];

  constructor(private readonly options:LauncherCandidateRefreshRunnerOptions){
    this.timeoutMs=options.timeoutMs??120_000;
    if(!options.database||!options.profileDatabase||!Number.isSafeInteger(options.intervalMs)||options.intervalMs<10||
      !Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<100||this.timeoutMs>600_000||
      options.testDelayMs!==undefined&&(!Number.isSafeInteger(options.testDelayMs)||options.testDelayMs<0||options.testDelayMs>10_000))
      throw new Error('LAUNCHER_CANDIDATE_REFRESH_RUNNER_CONFIG_INVALID');
  }

  status():LauncherCandidateRefreshRunnerStatus {
    return {running:this.running&&!!this.worker,ready:this.ready,inFlight:this.inFlight,restarts:this.restarts,
      ...(this.lastAttemptAt?{lastAttemptAt:this.lastAttemptAt}:{}),...(this.completedAt?{completedAt:this.completedAt}:{}),
      ...(this.durationMs!==undefined?{durationMs:this.durationMs}:{}),...(this.result?{result:this.result}:{}),
      ...(this.error?{error:this.error}:{})};
  }

  start():void {
    if(this.running)return;this.running=true;this.launch();
    this.interval=setInterval(()=>this.dispatch(),this.options.intervalMs);this.interval.unref();
    this.watchdog=setInterval(()=>{
      if(this.worker&&this.inFlight&&Date.now()-this.workingSince>this.timeoutMs){
        this.fail('LAUNCHER_CANDIDATE_WORKER_TIMEOUT');void this.worker.terminate().catch(()=>{});
      }
    },Math.min(10_000,Math.max(100,Math.floor(this.timeoutMs/4))));this.watchdog.unref();
  }

  refreshNow():Promise<LauncherCandidateStatus> {
    if(!this.running)this.start();
    const promise=new Promise<LauncherCandidateStatus>((resolve,reject)=>this.waiters.push({resolve,reject}));
    this.dispatch();return promise;
  }

  private dispatch():void {
    if(!this.running||!this.ready||!this.worker||this.inFlight)return;
    this.inFlight=true;this.workingSince=Date.now();this.lastAttemptAt=new Date().toISOString();
    try{this.worker.postMessage({type:'refresh',id:++this.sequence});}
    catch{this.fail('LAUNCHER_CANDIDATE_WORKER_SEND_FAILED');}
  }

  private launch():void {
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./launcher-candidate-refresh-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const {intervalMs:_,timeoutMs:__,...workerOptions}=this.options;
      const worker=new Worker(url,{workerData:workerOptions,env:{},execArgv:[]});this.worker=worker;this.ready=false;
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='ready'){this.ready=true;this.error=undefined;this.dispatch();}
        else if(message?.type==='working'){
          this.inFlight=true;this.workingSince=Date.now();
          if(typeof message.at==='string')this.lastAttemptAt=message.at;
        } else if(message?.type==='status'&&message.status){
          this.inFlight=false;this.result=message.status as LauncherCandidateStatus;
          this.completedAt=typeof message.completedAt==='string'?message.completedAt:new Date().toISOString();
          this.durationMs=Number.isSafeInteger(message.durationMs)&&message.durationMs>=0?message.durationMs:undefined;
          this.error=undefined;const waiters=this.waiters.splice(0);for(const waiter of waiters)waiter.resolve(this.result);
        } else if(message?.type==='failed')this.fail('LAUNCHER_CANDIDATE_REFRESH_FAILED');
        else if(message?.type==='fatal')this.fail('LAUNCHER_CANDIDATE_WORKER_INIT_FAILED');
      });
      worker.on('error',()=>{if(this.worker===worker)this.fail('LAUNCHER_CANDIDATE_WORKER_FAILED');});
      worker.on('exit',()=>{
        if(this.worker!==worker)return;
        this.worker=undefined;this.ready=false;this.inFlight=false;
        if(this.running){this.error??='LAUNCHER_CANDIDATE_WORKER_EXITED';this.rejectWaiters(this.error);this.scheduleRestart();}
      });
    } catch {this.fail('LAUNCHER_CANDIDATE_WORKER_START_FAILED');this.scheduleRestart();}
  }

  private fail(code:string):void {
    this.inFlight=false;this.error=code;this.rejectWaiters(code);
  }
  private rejectWaiters(code:string):void {
    const waiters=this.waiters.splice(0),error=new Error(code);for(const waiter of waiters)waiter.reject(error);
  }
  private scheduleRestart():void {
    if(!this.running||this.retry)return;this.restarts++;
    this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},30_000);this.retry.unref();
  }

  async stop():Promise<void> {
    this.running=false;clearInterval(this.interval);clearInterval(this.watchdog);clearTimeout(this.retry);
    this.interval=undefined;this.watchdog=undefined;this.retry=undefined;this.rejectWaiters('LAUNCHER_CANDIDATE_WORKER_STOPPED');
    const worker=this.worker;
    if(worker)await new Promise<void>(done=>{
      let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},Math.min(this.timeoutMs,30_000));
      worker.once('exit',finish);
      try{worker.postMessage('stop');}catch{void worker.terminate().then(finish,finish);}
    });
    this.worker=undefined;this.ready=false;this.inFlight=false;
  }
}
