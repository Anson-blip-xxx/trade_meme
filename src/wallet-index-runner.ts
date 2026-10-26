import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {WalletAssociationStats} from './wallet-associations.js';

export interface WalletIndexRunnerOptions {
  database:string;
  maxBytes:number;
  intervalMs?:number;
  coordinationQuota?:number;
  associationQuota?:number;
}

export interface WalletIndexSnapshot {
  running:boolean;
  inFlight:boolean;
  invalidationMs:number;
  invalidationProcessed:number;
  invalidationPending:number;
  invalidationError?:string;
  coordinationMs:number;
  associationMs:number;
  associationStats?:WalletAssociationStats;
  associationStatsMs:number;
  associationStatsRefreshedAt?:string;
  coordinationError?:string;
  associationError?:string;
  workerError?:string;
  lastAttemptAt?:string;
  completedAt?:string;
  restarts:number;
}

/** Runs the two derived wallet graph indexes away from the HTTP and stream loop. */
export class WalletIndexRunner {
  private readonly intervalMs:number;
  private readonly coordinationQuota:number;
  private readonly associationQuota:number;
  private worker?:Worker;
  private retry?:ReturnType<typeof setTimeout>;
  private watchdog?:ReturnType<typeof setInterval>;
  private running=false;
  private inFlight=false;
  private workingSince=0;
  private restarts=0;
  private invalidationMs=0;
  private invalidationProcessed=0;
  private invalidationPending=0;
  private invalidationError?:string;
  private coordinationMs=0;
  private associationMs=0;
  private coordinationError?:string;
  private associationError?:string;
  private associationStats?:WalletAssociationStats;
  private associationStatsMs=0;
  private associationStatsRefreshedAt?:string;
  private workerError?:string;
  private lastAttemptAt?:string;
  private completedAt?:string;

  constructor(private readonly options:WalletIndexRunnerOptions) {
    this.intervalMs=options.intervalMs??10_000;
    this.coordinationQuota=options.coordinationQuota??10;
    this.associationQuota=options.associationQuota??3;
    if(!Number.isSafeInteger(options.maxBytes)||options.maxBytes<16_384||
      !Number.isSafeInteger(this.intervalMs)||this.intervalMs<10||
      !Number.isSafeInteger(this.coordinationQuota)||this.coordinationQuota<1||this.coordinationQuota>20||
      !Number.isSafeInteger(this.associationQuota)||this.associationQuota<1||this.associationQuota>5)
      throw new Error('WALLET_INDEX_RUNNER_CONFIG_INVALID');
  }

  snapshot():WalletIndexSnapshot {
    return {running:this.running&&!!this.worker,inFlight:this.inFlight,
      invalidationMs:this.invalidationMs,invalidationProcessed:this.invalidationProcessed,
      invalidationPending:this.invalidationPending,
      ...(this.invalidationError?{invalidationError:this.invalidationError}:{}),
      coordinationMs:this.coordinationMs,associationMs:this.associationMs,associationStats:this.associationStats,
      associationStatsMs:this.associationStatsMs,associationStatsRefreshedAt:this.associationStatsRefreshedAt,
      ...(this.coordinationError?{coordinationError:this.coordinationError}:{}),
      ...(this.associationError?{associationError:this.associationError}:{}),
      ...(this.workerError?{workerError:this.workerError}:{}),
      lastAttemptAt:this.lastAttemptAt,completedAt:this.completedAt,restarts:this.restarts};
  }

  start():void {
    if(this.running)return;
    this.running=true;this.launch();
    this.watchdog=setInterval(()=>{
      if(this.worker&&this.inFlight&&Date.now()-this.workingSince>120_000){
        this.workerError='WALLET_INDEX_WORKER_TIMEOUT';void this.worker.terminate().catch(()=>{});
      }
    },10_000);this.watchdog.unref();
  }

  private launch():void {
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-index-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,maxBytes:this.options.maxBytes,
        intervalMs:this.intervalMs,coordinationQuota:this.coordinationQuota,associationQuota:this.associationQuota},env:{},execArgv:[]});
      this.worker=worker;
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='working'){
          this.inFlight=true;this.workingSince=Date.now();
          this.lastAttemptAt=typeof message.at==='string'?message.at:new Date().toISOString();
        } else if(message?.type==='status'&&message.status) {
          const status=message.status as Partial<WalletIndexSnapshot>;
          this.invalidationMs=Number.isSafeInteger(status.invalidationMs)&&status.invalidationMs!>=0?status.invalidationMs!:0;
          this.invalidationProcessed=Number.isSafeInteger(status.invalidationProcessed)&&status.invalidationProcessed!>=0?status.invalidationProcessed!:0;
          this.invalidationPending=Number.isSafeInteger(status.invalidationPending)&&status.invalidationPending!>=0?status.invalidationPending!:0;
          this.invalidationError=status.invalidationError==='WALLET_ASSOCIATION_INVALIDATION_FAILED'?status.invalidationError:undefined;
          this.coordinationMs=Number.isSafeInteger(status.coordinationMs)&&status.coordinationMs!>=0?status.coordinationMs!:0;
          this.associationMs=Number.isSafeInteger(status.associationMs)&&status.associationMs!>=0?status.associationMs!:0;
          if(status.associationStats)this.associationStats=status.associationStats;
          this.associationStatsMs=Number.isSafeInteger(status.associationStatsMs)&&status.associationStatsMs!>=0?status.associationStatsMs!:0;
          if(typeof status.associationStatsRefreshedAt==='string')this.associationStatsRefreshedAt=status.associationStatsRefreshedAt;
          this.coordinationError=status.coordinationError==='WALLET_COORDINATION_REFRESH_FAILED'?status.coordinationError:undefined;
          this.associationError=status.associationError==='WALLET_ASSOCIATION_REFRESH_FAILED'?status.associationError:undefined;
          this.completedAt=typeof status.completedAt==='string'?status.completedAt:new Date().toISOString();
          this.inFlight=false;this.workerError=undefined;
        }
      });
      worker.on('error',()=>{if(this.worker===worker)this.workerError='WALLET_INDEX_WORKER_FAILED';});
      worker.on('exit',()=>{
        if(this.worker!==worker)return;
        this.worker=undefined;this.inFlight=false;
        if(this.running){this.workerError??='WALLET_INDEX_WORKER_EXITED';this.scheduleRestart();}
      });
    } catch {this.workerError='WALLET_INDEX_WORKER_START_FAILED';this.scheduleRestart();}
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
