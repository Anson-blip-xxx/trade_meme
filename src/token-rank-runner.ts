import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {existsSync,realpathSync,statSync} from 'node:fs';
import {TokenRankResearchReader} from './token-rank-research.js';

export interface TokenRankResearchRunnerOptions {
  database:string;historyDatabase:string;memeDatabase?:string;sourceDatabase?:string;
  maxBytes:number;intervalSec:number;batchSize:number;
}
const samePath=(left:string,right:string)=>{
  if(resolve(left)===resolve(right))return true;
  if(!existsSync(left)||!existsSync(right))return false;
  const a=statSync(left),b=statSync(right);
  return realpathSync(left)===realpathSync(right)||a.dev===b.dev&&a.ino===b.ino;
};
/** Local evidence joins run off the HTTP / streaming thread and receive no API keys. */
export class TokenRankResearchRunner {
  readonly reader:TokenRankResearchReader;
  private worker?:Worker;
  private timer?:ReturnType<typeof setTimeout>;
  private watchdog?:ReturnType<typeof setInterval>;
  private running=false;private inFlight=false;private workingSince=0;private restarts=0;
  private livePriority=false;private workerLivePriority?:boolean;
  private error?:string;private cached:Record<string,unknown>={ready:false,tokens:0,wallets:0};
  constructor(private readonly options:TokenRankResearchRunnerOptions){
    if([options.historyDatabase,options.memeDatabase,options.sourceDatabase].some(path=>path&&samePath(path,options.database)))
      throw new Error('TOKEN_RANK_DATABASE_MUST_BE_SEPARATE');
    if(!Number.isInteger(options.intervalSec)||options.intervalSec<1||options.intervalSec>300||
      !Number.isInteger(options.batchSize)||options.batchSize<1||options.batchSize>2000)
      throw new Error('TOKEN_RANK_RUNNER_CONFIG_INVALID');
    this.reader=new TokenRankResearchReader(options.database);
  }
  status(){return {...this.cached,ready:this.cached.ready===true,enabled:true,running:this.running&&!!this.worker,inFlight:this.inFlight,
    livePriority:this.livePriority,workerLivePriority:this.workerLivePriority,
    intervalSec:this.options.intervalSec,batchSize:this.options.batchSize,restarts:this.restarts,
    ...(this.error?{error:this.error}:{}),researchOnly:true,tradingEnabled:false};}
  start(){
    if(this.running)return;this.running=true;this.launch();
    this.watchdog=setInterval(()=>{
      if(this.worker&&this.inFlight&&Date.now()-this.workingSince>120000){
        this.error='TOKEN_RANK_WORKER_TIMEOUT';void this.worker.terminate();
      }
    },10000);this.watchdog.unref();
  }
  /** Pause research-only writes while live signal counting owns latency priority. */
  setLivePriority(active:boolean){
    this.livePriority=active;
    try{this.worker?.postMessage({type:'live-priority',active});}catch{}
  }
  private launch(){
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./token-rank-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{...this.options,livePriority:this.livePriority},env:{},execArgv:[]});this.worker=worker;
      this.workerLivePriority=undefined;
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='priority'&&typeof message.livePriority==='boolean')this.workerLivePriority=message.livePriority;
        else if(message?.type==='working'){this.inFlight=true;this.workingSince=Date.now();}
        else if(message?.type==='status'){this.cached=message.status;this.inFlight=false;this.error=undefined;}
        else if(message?.type==='failed'){this.inFlight=false;this.error='TOKEN_RANK_REFRESH_FAILED';}
      });
      worker.on('error',()=>{if(this.worker===worker)this.error='TOKEN_RANK_WORKER_FAILED';});
      worker.on('exit',()=>{
        if(this.worker!==worker)return;this.worker=undefined;this.inFlight=false;this.workerLivePriority=undefined;
        if(this.running){this.error??='TOKEN_RANK_WORKER_EXITED';this.scheduleRestart();}
      });
    }catch{this.error='TOKEN_RANK_WORKER_START_FAILED';this.scheduleRestart();}
  }
  private scheduleRestart(){
    if(!this.running||this.timer)return;this.restarts++;
    this.timer=setTimeout(()=>{this.timer=undefined;this.launch();},30000);this.timer.unref();
  }
  async stop(){
    this.running=false;clearTimeout(this.timer);clearInterval(this.watchdog);this.timer=undefined;
    const worker=this.worker;
    if(worker)await new Promise<void>(done=>{
      const timeout=setTimeout(()=>{void worker.terminate();},3000);
      worker.once('exit',()=>{clearTimeout(timeout);done();});worker.postMessage('stop');
    });
    this.worker=undefined;this.inFlight=false;this.workerLivePriority=undefined;this.reader.close();
  }
}
