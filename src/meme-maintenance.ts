import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

export interface MemeMaintenanceSnapshot {
  usedBytes:number;checkedAt:string;pressure:boolean;reclaimedSnapshots:number;
  lastDurationMs:number;maxWriteLockMs:number;checkpointedPages:number;error?:string;
}

/** Runs retention deletes and WAL checkpoints away from the signal event loop. */
export class MemeMaintenanceRunner {
  private worker?:Worker;private running=false;private retry?:ReturnType<typeof setTimeout>;private restarts=0;
  private value?:MemeMaintenanceSnapshot;private error?:string;
  constructor(private readonly options:{database:string;maxBytes:number;reclaimedSnapshots:number}){}
  start():void {if(this.running)return;this.running=true;this.launch();}
  snapshot(){return {value:this.value,error:this.error,running:this.running&&!!this.worker,restarts:this.restarts};}
  private launch():void {
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./meme-maintenance-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:this.options,env:{},execArgv:[]});this.worker=worker;
      worker.on('message',message=>{if(this.worker!==worker)return;
        if(message?.type==='status'&&message.value){this.value=message.value as MemeMaintenanceSnapshot;this.error=undefined;}
        else if(message?.type==='failed')this.error='MEME_MAINTENANCE_FAILED';});
      worker.on('error',()=>{if(this.worker===worker)this.error='MEME_MAINTENANCE_WORKER_FAILED';});
      worker.on('exit',()=>{if(this.worker!==worker)return;this.worker=undefined;
        if(this.running){this.error=this.error??'MEME_MAINTENANCE_WORKER_EXITED';this.schedule();}});
    }catch{this.error='MEME_MAINTENANCE_WORKER_START_FAILED';this.schedule();}
  }
  private schedule(){if(!this.running||this.retry)return;this.restarts++;this.retry=setTimeout(()=>{this.retry=undefined;this.launch();},30_000);this.retry.unref();}
  async stop():Promise<void>{
    this.running=false;clearTimeout(this.retry);this.retry=undefined;const worker=this.worker;if(!worker)return;
    await new Promise<void>(done=>{let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},3_000);worker.once('exit',finish);
      try{worker.postMessage('stop');}catch{void worker.terminate().then(finish,finish);}});this.worker=undefined;
  }
}
