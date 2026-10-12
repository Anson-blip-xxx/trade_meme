import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {WalletProfileReader,type WalletProfileStatus} from './wallet-profiles.js';

export interface WalletProfileRunnerOptions {
  database:string;historyDatabase:string;chainDatabase?:string;
  maxBytes:number;intervalSec:number;batchSize:number;
}
/** Own the worker lifecycle independently of HTTP requests and vendor limits. */
export class WalletProfileRunner {
  readonly reader:WalletProfileReader;
  private worker?:Worker;
  private timer?:ReturnType<typeof setTimeout>;
  private watchdog?:ReturnType<typeof setInterval>;
  private running=false;
  private inFlight=false;
  private workingSince=0;
  private error?:string;
  private restarts=0;
  private cached:Partial<WalletProfileStatus>={ready:false,profiles:0,sourceWallets:0,initialComplete:false,groupCounts:{}};
  constructor(private readonly options:WalletProfileRunnerOptions) {
    if([options.historyDatabase,options.chainDatabase].some(path=>path&&resolve(path)===resolve(options.database)))
      throw new Error('WALLET_PROFILE_DATABASE_MUST_BE_SEPARATE');
    this.reader=new WalletProfileReader(options.database);
  }
  status() {
    return {...this.cached,enabled:true,running:this.running&&!!this.worker,inFlight:this.inFlight,
      intervalSec:this.options.intervalSec,batchSize:this.options.batchSize,restarts:this.restarts,
      ...(this.error?{error:this.error}:{}),sampleOnly:true,ownership:'unknown',tradingEnabled:false};
  }
  start() {
    if(this.running)return;this.running=true;this.launch();
    this.watchdog=setInterval(()=>{
      if(this.worker&&this.inFlight&&Date.now()-this.workingSince>120000) {
        this.error='WALLET_PROFILE_WORKER_TIMEOUT';void this.worker.terminate();
      }
    },10000);this.watchdog.unref();
  }
  private launch() {
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-profile-worker.${source?'ts':'js'}`,import.meta.url);
      // The compiled service has no tsx dependency. Source-mode tests/development
      // register tsx inside the worker before loading TypeScript imports.
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:this.options,env:{},execArgv:[]});
      this.worker=worker;
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='working') {this.inFlight=true;this.workingSince=Date.now();}
        else if(message?.type==='status') {this.cached=message.status;this.inFlight=false;this.error=undefined;}
        else if(message?.type==='failed') {this.inFlight=false;this.error='WALLET_PROFILE_REFRESH_FAILED';}
      });
      worker.on('error',()=>{if(this.worker===worker)this.error='WALLET_PROFILE_WORKER_FAILED';});
      worker.on('exit',()=>{
        if(this.worker!==worker)return;
        this.worker=undefined;this.inFlight=false;
        if(this.running) {this.error??='WALLET_PROFILE_WORKER_EXITED';this.scheduleRestart();}
      });
    } catch {this.error='WALLET_PROFILE_WORKER_START_FAILED';this.scheduleRestart();}
  }
  private scheduleRestart() {
    if(!this.running||this.timer)return;
    this.restarts++;
    this.timer=setTimeout(()=>{this.timer=undefined;this.launch();},30000);this.timer.unref();
  }
  async stop() {
    this.running=false;clearTimeout(this.timer);clearInterval(this.watchdog);this.timer=undefined;
    const worker=this.worker;
    if(worker)await new Promise<void>(done=>{
      const timeout=setTimeout(()=>{void worker.terminate();},3000);
      worker.once('exit',()=>{clearTimeout(timeout);done();});worker.postMessage('stop');
    });
    this.worker=undefined;this.inFlight=false;this.reader.close();
  }
}
