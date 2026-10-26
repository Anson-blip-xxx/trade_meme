import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {JevStatusAggregate} from './jev-shadow.js';

export interface JevStatusRunnerSnapshot {
  aggregate?:JevStatusAggregate;state:'loading'|'fresh'|'stale';stale:boolean;error?:string;
  lastAttemptAt?:string;worker:{running:boolean;inFlight:boolean;restarts:number};
}
export class JevStatusRunner {
  private readonly intervalMs:number;private readonly staleAfterMs:number;
  private worker?:Worker;private retry?:ReturnType<typeof setTimeout>;private watchdog?:ReturnType<typeof setInterval>;
  private running=false;private inFlight=false;private workingSince=0;private restarts=0;
  private aggregate?:JevStatusAggregate;private lastAttemptAt?:string;private error?:string;private failedSinceSuccess=false;
  constructor(private readonly options:{database:string;intervalMs?:number;staleAfterMs?:number}){
    this.intervalMs=options.intervalMs??300_000;this.staleAfterMs=options.staleAfterMs??1_200_000;
    if(!options.database||!Number.isSafeInteger(this.intervalMs)||this.intervalMs<10||
      !Number.isSafeInteger(this.staleAfterMs)||this.staleAfterMs<this.intervalMs)throw new Error('JEV_STATUS_RUNNER_CONFIG_INVALID');
  }
  snapshot():JevStatusRunnerSnapshot {
    const expired=!this.aggregate||Date.now()-Date.parse(this.aggregate.computedAt)>this.staleAfterMs,
      stale=this.failedSinceSuccess||expired;
    return {aggregate:this.aggregate,state:this.aggregate?(stale?'stale':'fresh'):'loading',stale,
      ...(this.error?{error:this.error}:{}),lastAttemptAt:this.lastAttemptAt,
      worker:{running:this.running&&!!this.worker,inFlight:this.inFlight,restarts:this.restarts}};
  }
  start(){if(this.running)return;this.running=true;this.launch();this.watchdog=setInterval(()=>{
    if(this.worker&&this.inFlight&&Date.now()-this.workingSince>120_000){this.fail('JEV_STATUS_WORKER_TIMEOUT');void this.worker.terminate().catch(()=>{});}
  },10_000);this.watchdog.unref();}
  private launch(){
    if(!this.running)return;
    try{
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./jev-status-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,intervalMs:this.intervalMs},env:{},execArgv:[]});this.worker=worker;
      worker.on('message',message=>{if(this.worker!==worker)return;
        if(message?.type==='working'){this.inFlight=true;this.workingSince=Date.now();this.lastAttemptAt=String(message.at??new Date().toISOString());}
        else if(message?.type==='status'&&message.aggregate){this.aggregate=message.aggregate as JevStatusAggregate;this.inFlight=false;this.error=undefined;this.failedSinceSuccess=false;}
        else if(message?.type==='failed')this.fail('JEV_STATUS_REFRESH_FAILED');});
      worker.on('error',()=>{if(this.worker===worker)this.fail('JEV_STATUS_WORKER_FAILED');});
      worker.on('exit',()=>{if(this.worker!==worker)return;this.worker=undefined;this.inFlight=false;
        if(this.running){this.fail(this.error??'JEV_STATUS_WORKER_EXITED');this.restarts++;this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},30_000);this.retry.unref();}});
    }catch{this.fail('JEV_STATUS_WORKER_START_FAILED');this.restarts++;this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},30_000);this.retry.unref();}
  }
  private fail(code:string){this.inFlight=false;this.failedSinceSuccess=true;this.error=code;}
  async stop(){this.running=false;clearTimeout(this.retry);clearInterval(this.watchdog);this.retry=undefined;const worker=this.worker;
    if(worker)await new Promise<void>(done=>{let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},3000);worker.once('exit',finish);
      try{worker.postMessage('stop');}catch{void worker.terminate().then(finish,finish);}});
    this.worker=undefined;this.inFlight=false;
  }
}
