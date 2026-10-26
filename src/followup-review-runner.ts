import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

export interface FollowupReviewRunnerOptions {database:string;intervalMs?:number;}
export interface FollowupReviewRunnerStatus {
  running:boolean;inFlight:boolean;elapsedMs:number;restarts:number;
  lastAttemptAt?:string;completedAt?:string;error?:string;
}

/** Computes the full follow-up learning aggregate outside the HTTP and stream loop. */
export class FollowupReviewRunner {
  private readonly intervalMs:number;
  private worker?:Worker;
  private retry?:ReturnType<typeof setTimeout>;
  private watchdog?:ReturnType<typeof setInterval>;
  private running=false;private inFlight=false;private workingSince=0;private elapsedMs=0;private restarts=0;
  private lastAttemptAt?:string;private completedAt?:string;private error?:string;

  constructor(private readonly options:FollowupReviewRunnerOptions) {
    this.intervalMs=options.intervalMs??60_000;
    if(!options.database||!Number.isSafeInteger(this.intervalMs)||this.intervalMs<10)
      throw new Error('FOLLOWUP_REVIEW_RUNNER_CONFIG_INVALID');
  }

  status():FollowupReviewRunnerStatus {
    return {running:this.running&&!!this.worker,inFlight:this.inFlight,elapsedMs:this.elapsedMs,restarts:this.restarts,
      lastAttemptAt:this.lastAttemptAt,completedAt:this.completedAt,...(this.error?{error:this.error}:{})};
  }

  start():void {
    if(this.running)return;this.running=true;this.launch();
    this.watchdog=setInterval(()=>{
      if(this.worker&&this.inFlight&&Date.now()-this.workingSince>120_000){
        this.error='FOLLOWUP_REVIEW_WORKER_TIMEOUT';void this.worker.terminate().catch(()=>{});
      }
    },10_000);this.watchdog.unref();
  }

  private launch():void {
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./followup-review-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,intervalMs:this.intervalMs},env:{},execArgv:[]});
      this.worker=worker;
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='working'){
          this.inFlight=true;this.workingSince=Date.now();
          this.lastAttemptAt=typeof message.at==='string'?message.at:new Date().toISOString();
        }else if(message?.type==='status'){
          this.inFlight=false;this.elapsedMs=Number.isSafeInteger(message.elapsedMs)&&message.elapsedMs>=0?message.elapsedMs:0;
          this.completedAt=typeof message.completedAt==='string'?message.completedAt:new Date().toISOString();this.error=undefined;
        }else if(message?.type==='failed'){
          this.inFlight=false;this.error='FOLLOWUP_REVIEW_REFRESH_FAILED';
        }
      });
      worker.on('error',()=>{if(this.worker===worker)this.error='FOLLOWUP_REVIEW_WORKER_FAILED';});
      worker.on('exit',()=>{
        if(this.worker!==worker)return;this.worker=undefined;this.inFlight=false;
        if(this.running){this.error??='FOLLOWUP_REVIEW_WORKER_EXITED';this.scheduleRestart();}
      });
    }catch{this.error='FOLLOWUP_REVIEW_WORKER_START_FAILED';this.scheduleRestart();}
  }

  private scheduleRestart():void {
    if(!this.running||this.retry)return;this.restarts++;
    this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},30_000);this.retry.unref();
  }

  async stop():Promise<void> {
    this.running=false;clearTimeout(this.retry);clearInterval(this.watchdog);this.retry=undefined;
    const worker=this.worker;
    if(worker)await new Promise<void>(done=>{
      let settled=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},3_000);
      worker.once('exit',finish);
      try{worker.postMessage('stop');}catch{void worker.terminate().then(finish,finish);}
    });
    this.worker=undefined;this.inFlight=false;
  }
}
