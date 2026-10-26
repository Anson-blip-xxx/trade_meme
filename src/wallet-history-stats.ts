import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {WalletHistoryStats} from './wallet-history.js';

export interface WalletHistoryStatsRunnerOptions {
  database:string;
  maxBytes:number;
  intervalMs?:number;
  staleAfterMs?:number;
}

export interface WalletHistoryStatsSnapshot {
  store?:WalletHistoryStats;
  computedAt?:string;
  lastAttemptAt?:string;
  stale:boolean;
  state:'loading'|'fresh'|'stale';
  error?:string;
  worker:{running:boolean;inFlight:boolean;restarts:number};
}

/**
 * Keeps large wallet-history COUNT queries out of the HTTP / stream event loop.
 * The last successful immutable snapshot remains available across refresh and
 * worker failures; callers only perform an in-memory read.
 */
export class WalletHistoryStatsRunner {
  private readonly intervalMs:number;
  private readonly staleAfterMs:number;
  private worker?:Worker;
  private retry?:ReturnType<typeof setTimeout>;
  private watchdog?:ReturnType<typeof setInterval>;
  private running=false;
  private inFlight=false;
  private workingSince=0;
  private restarts=0;
  private store?:WalletHistoryStats;
  private computedAt?:string;
  private lastAttemptAt?:string;
  private error?:string;
  private failedSinceSuccess=false;

  constructor(private readonly options:WalletHistoryStatsRunnerOptions) {
    this.intervalMs=options.intervalMs??300_000;
    this.staleAfterMs=options.staleAfterMs??Math.max(1_200_000,this.intervalMs*4);
    if(!Number.isSafeInteger(options.maxBytes)||options.maxBytes<16_384||
      !Number.isSafeInteger(this.intervalMs)||this.intervalMs<10||
      !Number.isSafeInteger(this.staleAfterMs)||this.staleAfterMs<this.intervalMs)
      throw new Error('WALLET_HISTORY_STATS_CONFIG_INVALID');
  }

  snapshot():WalletHistoryStatsSnapshot {
    const expired=!this.computedAt||Date.now()-Date.parse(this.computedAt)>this.staleAfterMs;
    const stale=this.failedSinceSuccess||expired;
    return {store:this.store,computedAt:this.computedAt,lastAttemptAt:this.lastAttemptAt,stale,
      state:this.store?(stale?'stale':'fresh'):'loading',...(this.error?{error:this.error}:{}),
      worker:{running:this.running&&!!this.worker,inFlight:this.inFlight,restarts:this.restarts}};
  }

  start():void {
    if(this.running)return;
    this.running=true;this.launch();
    this.watchdog=setInterval(()=>{
      if(this.worker&&this.inFlight&&Date.now()-this.workingSince>120_000){
        this.fail('WALLET_HISTORY_STATS_WORKER_TIMEOUT');void this.worker.terminate().catch(()=>{});
      }
    },10_000);this.watchdog.unref();
  }

  private launch():void {
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-history-stats-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,maxBytes:this.options.maxBytes,intervalMs:this.intervalMs},env:{},execArgv:[]});
      this.worker=worker;
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='working'){
          this.inFlight=true;this.workingSince=Date.now();this.lastAttemptAt=typeof message.at==='string'?message.at:new Date().toISOString();
        } else if(message?.type==='status'&&message.status&&typeof message.computedAt==='string'){
          this.store=message.status as WalletHistoryStats;this.computedAt=message.computedAt;
          this.lastAttemptAt=message.computedAt;this.inFlight=false;this.error=undefined;this.failedSinceSuccess=false;
        } else if(message?.type==='failed')this.fail('WALLET_HISTORY_STATS_REFRESH_FAILED');
      });
      worker.on('error',()=>{if(this.worker===worker)this.fail('WALLET_HISTORY_STATS_WORKER_FAILED');});
      worker.on('exit',()=>{
        if(this.worker!==worker)return;
        this.worker=undefined;this.inFlight=false;
        if(this.running){this.fail(this.error??'WALLET_HISTORY_STATS_WORKER_EXITED');this.scheduleRestart();}
      });
    } catch {this.fail('WALLET_HISTORY_STATS_WORKER_START_FAILED');this.scheduleRestart();}
  }

  private fail(code:string):void {
    this.inFlight=false;this.failedSinceSuccess=true;this.error=code;
  }

  private scheduleRestart():void {
    if(!this.running||this.retry)return;
    this.restarts++;
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
