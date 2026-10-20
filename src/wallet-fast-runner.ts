import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {Config} from './config.js';
import {LatencyWindow,type FastWalletEvent,type FastWalletSnapshot} from './wallet-fast.js';

export interface WalletFastOptions {
  endpoints:Config['chainStream']['endpoints'];maxWallets:number;
  snapshot:()=>FastWalletSnapshot;onEvent:(event:FastWalletEvent)=>void;
}
/** Socket processing lives in its own thread, isolated from main-thread SQLite and HTTP work. */
export class WalletFastRunner {
  private worker?:Worker;private timer?:ReturnType<typeof setInterval>;private retry?:ReturnType<typeof setTimeout>;
  private running=false;private error?:string;private cached:Record<string,any>={};private restarts=0;
  private recent:FastWalletEvent[]=[];private handoff=new LatencyWindow();private lastStatusAt=0;
  constructor(private readonly options:WalletFastOptions){}
  start(){if(this.running)return;this.running=true;this.launch();this.timer=setInterval(()=>{
    this.refresh();if(this.worker&&this.lastStatusAt&&Date.now()-this.lastStatusAt>45000){this.error='FAST_WALLET_WORKER_TIMEOUT';void this.worker.terminate();}
  },30000);this.timer.unref();}
  private launch(){if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-fast-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(`import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{endpoints:this.options.endpoints,maxWallets:this.options.maxWallets},env:{},execArgv:[]});this.worker=worker;this.lastStatusAt=Date.now();
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='status'){this.cached=message.status;this.lastStatusAt=Date.now();worker.postMessage({type:'status_ack'});}
        else if(message?.type==='events'){
          try {for(const event of message.events as FastWalletEvent[]){this.handoff.add(Date.now()-Date.parse(event.judgedAt));
            this.recent.unshift(event);if(this.recent.length>100)this.recent.pop();
            try{this.options.onEvent(event);}catch{this.error='FAST_WALLET_RESEARCH_ENQUEUE_FAILED';}}}
          finally{worker.postMessage({type:'ack',id:message.id});}
        }else if(message?.type==='failed')this.error='FAST_WALLET_SNAPSHOT_INVALID';
      });
      worker.on('error',()=>{if(this.worker===worker)this.error='FAST_WALLET_WORKER_FAILED';});
      worker.on('exit',()=>{if(this.worker!==worker)return;this.worker=undefined;if(this.running){this.error??='FAST_WALLET_WORKER_EXITED';this.restarts++;
        this.retry=setTimeout(()=>this.launch(),5000);this.retry.unref();}});
      this.refresh();
    }catch{this.error='FAST_WALLET_WORKER_START_FAILED';this.retry=setTimeout(()=>this.launch(),5000);this.retry.unref();}
  }
  private refresh(){if(!this.running||!this.worker)return;try{this.worker.postMessage({type:'snapshot',snapshot:this.options.snapshot()});
    if(this.error==='FAST_WALLET_TARGET_REFRESH_FAILED')this.error=undefined;}catch{this.error='FAST_WALLET_TARGET_REFRESH_FAILED';}}
  status():Record<string,any>{return {...this.cached,enabled:true,running:this.running&&!!this.worker,statusStale:Date.now()-this.lastStatusAt>10000,
    restarts:this.restarts,error:this.error,mainThreadHandoff:{...this.handoff.summary(),basis:'fast_verdict_to_main_thread_receipt'},
    recentEvents:this.recent.slice(0,20),eventRetention:'latest_100_since_worker_service_start',tradingEnabled:false};}
  async stop(){this.running=false;clearTimeout(this.retry);clearInterval(this.timer);const worker=this.worker;
    if(worker)await new Promise<void>(done=>{const t=setTimeout(()=>void worker.terminate(),3000);worker.once('exit',()=>{clearTimeout(t);done();});worker.postMessage('stop');});this.worker=undefined;}
}
