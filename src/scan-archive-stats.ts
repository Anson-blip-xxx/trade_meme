import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {ScanArchiveStatsValues} from './scan-archive-stats-query.js';

export interface ScanArchiveStatsRefresh {
  state:'loading'|'fresh'|'stale';stale:boolean;computedAt?:string;lastAttemptAt?:string;error?:string;
  worker:{running:boolean;inFlight:boolean;restarts:number};
}

export interface ScanArchiveStatsRunnerSnapshot {
  values?:ScanArchiveStatsValues;
  refresh:ScanArchiveStatsRefresh;
}

interface Options {database:string;trackingMs:number;now:()=>Date;refreshMs?:number;}

/** Keeps archive-wide aggregates off the HTTP and stream event loop. */
export class ScanArchiveStatsRunner {
  private readonly refreshMs:number;
  private worker?:Worker;
  private refreshTimer?:ReturnType<typeof setTimeout>;
  private retryTimer?:ReturnType<typeof setTimeout>;
  private watchdog?:ReturnType<typeof setInterval>;
  private running=false;private ready=false;private inFlight=false;private workingSince=0;private restarts=0;
  private values?:ScanArchiveStatsValues;private computedAt?:string;private receivedAt=0;private lastAttemptAt?:string;
  private error?:string;private failedSinceSuccess=false;private changeVersion=0;private requestedVersion=0;

  constructor(private readonly options:Options) {
    this.refreshMs=options.refreshMs??15_000;
    if(!options.database||!Number.isFinite(options.trackingMs)||options.trackingMs<=0||
      !Number.isSafeInteger(this.refreshMs)||this.refreshMs<10)throw new Error('SCAN_ARCHIVE_STATS_RUNNER_CONFIG_INVALID');
  }

  start():void {
    if(this.running)return;
    this.running=true;this.launch();
    this.watchdog=setInterval(()=>{
      if(this.worker&&this.inFlight&&Date.now()-this.workingSince>120_000){
        this.fail('SCAN_ARCHIVE_STATS_WORKER_TIMEOUT');void this.worker.terminate().catch(()=>{});
      }
    },10_000);this.watchdog.unref();
  }

  snapshot():ScanArchiveStatsRunnerSnapshot {
    const expired=!!this.values&&Date.now()-this.receivedAt>Math.max(60_000,this.refreshMs*4),
      stale=!!this.values&&(this.failedSinceSuccess||expired),state=this.values?(stale?'stale':'fresh'):'loading';
    return {values:this.values?structuredClone(this.values):undefined,
      refresh:{state,stale,computedAt:this.computedAt,lastAttemptAt:this.lastAttemptAt,
        ...(this.error?{error:this.error}:{}),worker:{running:this.running&&!!this.worker,inFlight:this.inFlight,restarts:this.restarts}}};
  }

  /** Mark writes observed while the first snapshot is running for an immediate catch-up pass. */
  invalidate():void {
    this.changeVersion++;
    if(!this.values&&this.ready&&!this.inFlight)this.scheduleRefresh(0);
  }

  private launch():void {
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./scan-archive-stats-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,trackingMs:this.options.trackingMs},env:{},execArgv:[]});
      worker.unref();this.worker=worker;this.ready=false;
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='ready'){this.ready=true;this.request();}
        else if(message?.type==='status'&&message.values&&typeof message.computedAt==='string'){
          const catchUp=!this.values&&this.changeVersion!==this.requestedVersion;
          this.values=message.values as ScanArchiveStatsValues;this.computedAt=message.computedAt;this.receivedAt=Date.now();
          this.inFlight=false;this.error=undefined;this.failedSinceSuccess=false;
          this.scheduleRefresh(catchUp?0:this.refreshMs);
        } else if(message?.type==='failed'){
          this.fail('SCAN_ARCHIVE_STATS_REFRESH_FAILED');this.scheduleRefresh(this.refreshMs);
        }
      });
      worker.on('error',()=>{if(this.worker===worker)this.fail('SCAN_ARCHIVE_STATS_WORKER_FAILED');});
      worker.on('exit',()=>{
        if(this.worker!==worker)return;
        this.worker=undefined;this.ready=false;this.inFlight=false;
        if(this.running){this.fail(this.error??'SCAN_ARCHIVE_STATS_WORKER_EXITED');this.scheduleRestart();}
      });
    } catch {this.fail('SCAN_ARCHIVE_STATS_WORKER_START_FAILED');this.scheduleRestart();}
  }

  private request():void {
    if(!this.running||!this.worker||!this.ready||this.inFlight)return;
    clearTimeout(this.refreshTimer);this.refreshTimer=undefined;
    const now=this.options.now();
    if(!Number.isFinite(now.getTime())){this.fail('SCAN_ARCHIVE_STATS_TIME_INVALID');this.scheduleRefresh(this.refreshMs);return;}
    this.requestedVersion=this.changeVersion;this.inFlight=true;this.workingSince=Date.now();this.lastAttemptAt=now.toISOString();
    try{this.worker.postMessage({type:'refresh',now:this.lastAttemptAt});}
    catch{this.fail('SCAN_ARCHIVE_STATS_WORKER_FAILED');void this.worker.terminate().catch(()=>{});}
  }

  private scheduleRefresh(delay:number):void {
    if(!this.running)return;
    if(this.refreshTimer){if(delay>0)return;clearTimeout(this.refreshTimer);this.refreshTimer=undefined;}
    this.refreshTimer=setTimeout(()=>{this.refreshTimer=undefined;this.request();},delay);this.refreshTimer.unref();
  }

  private fail(code:string):void {this.inFlight=false;this.failedSinceSuccess=true;this.error=code;}
  private scheduleRestart():void {
    if(!this.running||this.retryTimer)return;
    this.restarts++;this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;this.launch();},30_000);this.retryTimer.unref();
  }

  stop():void {
    this.running=false;clearTimeout(this.refreshTimer);clearTimeout(this.retryTimer);clearInterval(this.watchdog);
    this.refreshTimer=undefined;this.retryTimer=undefined;this.ready=false;this.inFlight=false;
    const worker=this.worker;this.worker=undefined;
    if(worker){worker.removeAllListeners();worker.unref();void worker.terminate().catch(()=>{});}
  }
}
