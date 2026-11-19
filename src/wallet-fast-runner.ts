import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {Config} from './config.js';
import {LatencyWindow,type FastWalletEvent,type FastWalletSnapshot} from './wallet-fast.js';
import type {Chain} from './types.js';

export interface WalletFastCoverageUpdate {chain:Chain;wallets:string[];at:string}

export type WalletFastSnapshotPhase='launcherTargets'|'walletHistoryTargets'|'profileMetadata'|'targetAssembly'|'storeTokens';
export interface WalletFastSnapshotTiming {measure<T>(phase:WalletFastSnapshotPhase,work:()=>T):T}

export interface WalletFastOptions {
  endpoints:Config['chainStream']['endpoints'];maxWallets:number;
  maxWalletsByChain?:Partial<Record<Chain,number>>;
  snapshot:(timing?:WalletFastSnapshotTiming)=>FastWalletSnapshot;onEvent:(event:FastWalletEvent)=>void;
  onCoverage?:(chain:Chain,wallets:string[],at:string)=>void;
  onCoverageBatch?:(updates:readonly WalletFastCoverageUpdate[])=>void;
}
const SNAPSHOT_REFRESH_MS=30_000,SNAPSHOT_REFRESH_OFFSET_MS=7_500,SNAPSHOT_EARLY_REFRESH_MS=1_000,HEALTH_CHECK_MS=5_000;
const snapshotPhaseBasis:Record<WalletFastSnapshotPhase|'postMessage',string>={
  launcherTargets:'launcher_target_selection_and_membership',walletHistoryTargets:'wallet_history_target_selection',
  profileMetadata:'profile_target_and_metadata_cache',targetAssembly:'target_merge_and_snapshot_rows',
  storeTokens:'store_token_risk_cache_assembly',postMessage:'worker_snapshot_post_message',
};
/** Socket processing lives in its own thread, isolated from main-thread SQLite and HTTP work. */
export class WalletFastRunner {
  private worker?:Worker;private refreshTimer?:ReturnType<typeof setTimeout>;private earlyRefreshTimer?:ReturnType<typeof setTimeout>;
  private watchdog?:ReturnType<typeof setInterval>;
  private retry?:ReturnType<typeof setTimeout>;
  private running=false;private error?:string;private cached:Record<string,any>={};private restarts=0;
  private lastError?:string;private lastErrorAt?:string;
  private recent:(FastWalletEvent&{handoffMs:number;mainThreadReceivedAt:string})[]=[];
  private handoff=new LatencyWindow();private eventCallback=new LatencyWindow();private workerAck=new LatencyWindow();
  private snapshotBuild=new LatencyWindow();private lastStatusAt=0;
  private snapshotPhases=new Map<WalletFastSnapshotPhase|'postMessage',LatencyWindow>(
    [...Object.keys(snapshotPhaseBasis) as (WalletFastSnapshotPhase|'postMessage')[]].map(phase=>[phase,new LatencyWindow()]));
  private coverage=new Map<Chain,{fingerprint:string;sentAt:number}>();
  private snapshotHealthy=false;
  constructor(private readonly options:WalletFastOptions){}
  private setError(code:string){this.error=code;this.lastError=code;this.lastErrorAt=new Date().toISOString();}
  private clearError(...codes:string[]){if(this.error&&codes.includes(this.error))this.error=undefined;}
  private publishCoverage(updates:readonly WalletFastCoverageUpdate[]):boolean {
    if(!updates.length)return true;
    try {
      if(this.options.onCoverageBatch){
        this.options.onCoverageBatch(updates);const sentAt=Date.now();
        for(const update of updates)this.coverage.set(update.chain,{fingerprint:update.wallets.join('\0'),sentAt});
      }else for(const update of updates){
        this.options.onCoverage?.(update.chain,update.wallets,update.at);
        this.coverage.set(update.chain,{fingerprint:update.wallets.join('\0'),sentAt:Date.now()});
      }
      return true;
    }catch{this.setError('FAST_WALLET_COVERAGE_CALLBACK_FAILED');return false;}
  }
  private revokeCoverage(chain:Chain,at=new Date().toISOString()):boolean {
    const prior=this.coverage.get(chain);if(prior?.fingerprint==='')return true;
    return this.publishCoverage([{chain,wallets:[],at}]);
  }
  private revokeAllCoverage(at=new Date().toISOString()):boolean {
    const updates=(Object.keys(this.options.endpoints) as Chain[]).filter(chain=>this.coverage.get(chain)?.fingerprint!=='')
      .map(chain=>({chain,wallets:[],at}));
    const ok=this.publishCoverage(updates);
    if(Array.isArray(this.cached.chains))this.cached={...this.cached,chains:this.cached.chains.map((row:Record<string,unknown>)=>
      ({...row,identityVerified:false,activeWallets:[],state:row.state==='stopped'?'stopped':'unavailable'}))};
    return ok;
  }
  private acceptCoverageStatus(status:Record<string,any>):boolean {
    const at=status?.asOf;
    if(this.snapshotHealthy&&status?.snapshotFresh===true&&typeof at==='string'&&Number.isFinite(Date.parse(at))&&Array.isArray(status?.chains)){
      const updates:WalletFastCoverageUpdate[]=[],now=Date.now();
      for(const row of status.chains){
        const chain=row?.chain;if(!['bsc','solana','robinhood'].includes(chain)||!Array.isArray(row.activeWallets)||
          row.activeWallets.some((wallet:unknown)=>typeof wallet!=='string'))continue;
        const network=chain as Chain,wallets=[...row.activeWallets] as string[],fingerprint=wallets.join('\0'),prior=this.coverage.get(network);
        if(!prior||prior.fingerprint!==fingerprint||now-prior.sentAt>=30_000)updates.push({chain:network,wallets,at});
      }
      return this.publishCoverage(updates);
    }
    return this.revokeAllCoverage(typeof at==='string'&&Number.isFinite(Date.parse(at))?at:new Date().toISOString());
  }
  start(){if(this.running)return;this.running=true;this.launch();
    // The launch snapshot can precede launcher/index workers publishing their
    // first cache. Retry once quickly to avoid a 7.5-second empty watchlist.
    this.earlyRefreshTimer=setTimeout(()=>{this.earlyRefreshTimer=undefined;if(this.running)this.refresh();},SNAPSHOT_EARLY_REFRESH_MS);
    this.earlyRefreshTimer.unref();
    // Order reconciliation starts on the runtime's zero-second boundary and
    // repeats every 30 seconds. Offset the recurring snapshot read so their
    // bounded SQLite/cache work does not routinely share the same event-loop turn.
    this.scheduleRefresh(SNAPSHOT_REFRESH_OFFSET_MS);
    // Health supervision is deliberately independent of the staggered refresh.
    // It runs more often than before, so moving the snapshot cannot hide a dead worker.
    this.watchdog=setInterval(()=>this.checkHealth(),HEALTH_CHECK_MS);this.watchdog.unref();}
  private scheduleRefresh(delay=SNAPSHOT_REFRESH_MS){clearTimeout(this.refreshTimer);if(!this.running)return;
    this.refreshTimer=setTimeout(()=>{this.refreshTimer=undefined;if(!this.running)return;this.refresh();this.scheduleRefresh();},delay);
    this.refreshTimer.unref();}
  private checkHealth(){if(this.worker&&this.lastStatusAt&&Date.now()-this.lastStatusAt>45000){
    this.revokeAllCoverage();this.setError('FAST_WALLET_WORKER_TIMEOUT');void this.worker.terminate();}}
  private launch(){if(!this.running)return;this.snapshotHealthy=false;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-fast-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(`import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{endpoints:this.options.endpoints,maxWallets:this.options.maxWallets,
        maxWalletsByChain:this.options.maxWalletsByChain},env:{},execArgv:[]});this.worker=worker;this.lastStatusAt=Date.now();
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='status'){this.cached=message.status;this.lastStatusAt=Date.now();
          this.clearError('FAST_WALLET_WORKER_TIMEOUT','FAST_WALLET_WORKER_FAILED','FAST_WALLET_WORKER_EXITED','FAST_WALLET_WORKER_START_FAILED');
          // Coverage persistence is an asynchronous enqueue. Return the worker's
          // status credit before any optional callback so subscription progress
          // never waits behind main-thread integration work.
          worker.postMessage({type:'status_ack'});
          const coverageOk=this.acceptCoverageStatus(message.status);
          if(coverageOk)this.clearError('FAST_WALLET_COVERAGE_CALLBACK_FAILED');
        }
        else if(message?.type==='snapshot_applied'){
          this.snapshotHealthy=true;this.clearError('FAST_WALLET_TARGET_REFRESH_FAILED','FAST_WALLET_SNAPSHOT_INVALID');
        }
        else if(message?.type==='coverage_lost'){
          const chain=message.chain as Chain;if(['bsc','solana','robinhood'].includes(chain))
            this.revokeCoverage(chain,typeof message.at==='string'&&Number.isFinite(Date.parse(message.at))?message.at:new Date().toISOString());
        }
        else if(message?.type==='events'){
          const ackStarted=performance.now();let delivered=true;try {for(const event of message.events as FastWalletEvent[]){const receivedAt=Date.now(),handoffMs=Math.max(0,receivedAt-Date.parse(event.judgedAt));this.handoff.add(handoffMs);
            this.recent.unshift({...event,handoffMs,mainThreadReceivedAt:new Date(receivedAt).toISOString()});if(this.recent.length>100)this.recent.pop();
            const callbackStarted=performance.now();try{this.options.onEvent(event);}catch{delivered=false;this.setError('FAST_WALLET_RESEARCH_ENQUEUE_FAILED');}
            finally{this.eventCallback.add(performance.now()-callbackStarted);}}}
          finally{try{worker.postMessage({type:'ack',id:message.id});}finally{this.workerAck.add(performance.now()-ackStarted);}}
          if(delivered)this.clearError('FAST_WALLET_RESEARCH_ENQUEUE_FAILED');
        }else if(message?.type==='failed'){this.snapshotHealthy=false;this.revokeAllCoverage();this.setError('FAST_WALLET_SNAPSHOT_INVALID');}
      });
      worker.on('error',()=>{if(this.worker===worker){this.revokeAllCoverage();this.setError('FAST_WALLET_WORKER_FAILED');}});
      worker.on('exit',()=>{if(this.worker!==worker)return;this.revokeAllCoverage();this.worker=undefined;if(this.running){
        if(!this.error)this.setError('FAST_WALLET_WORKER_EXITED');this.restarts++;
        this.retry=setTimeout(()=>this.launch(),5000);this.retry.unref();}});
      this.refresh();
    }catch{this.revokeAllCoverage();this.setError('FAST_WALLET_WORKER_START_FAILED');this.retry=setTimeout(()=>this.launch(),5000);this.retry.unref();}
  }
  private refresh(){if(!this.running||!this.worker)return;const started=performance.now(),durations=new Map<WalletFastSnapshotPhase,number>();
    const timing:WalletFastSnapshotTiming={measure:<T>(phase:WalletFastSnapshotPhase,work:()=>T):T=>{const phaseStarted=performance.now();
      try{return work();}finally{durations.set(phase,(durations.get(phase)??0)+Math.max(0,performance.now()-phaseStarted));}}};
    try{const snapshot=this.options.snapshot(timing),postStarted=performance.now();
      try{this.worker.postMessage({type:'snapshot',snapshot});}
      finally{this.snapshotPhases.get('postMessage')!.add(performance.now()-postStarted);}}
    catch{this.snapshotHealthy=false;this.revokeAllCoverage();this.setError('FAST_WALLET_TARGET_REFRESH_FAILED');}
    finally{for(const [phase,ms] of durations)this.snapshotPhases.get(phase)!.add(ms);this.snapshotBuild.add(performance.now()-started);}}
  status():Record<string,any>{return {...this.cached,enabled:true,running:this.running&&!!this.worker,statusStale:Date.now()-this.lastStatusAt>10000,
    restarts:this.restarts,error:this.error,lastError:this.lastError,lastErrorAt:this.lastErrorAt,
    snapshotBuild:{...this.snapshotBuild.summary(),basis:'main_thread_snapshot_build_and_handoff',
      phases:Object.fromEntries([...this.snapshotPhases].map(([phase,window])=>[phase,{...window.summary(),basis:snapshotPhaseBasis[phase]}])),
      schedule:{intervalMs:SNAPSHOT_REFRESH_MS,offsetMs:SNAPSHOT_REFRESH_OFFSET_MS,earlyRefreshMs:SNAPSHOT_EARLY_REFRESH_MS,
        healthCheckMs:HEALTH_CHECK_MS}},
    mainThreadHandoff:{...this.handoff.summary(),basis:'fast_verdict_to_main_thread_receipt'},
    mainThreadCallback:{...this.eventCallback.summary(),basis:'main_thread_event_callback'},
    workerAck:{...this.workerAck.summary(),basis:'main_thread_event_batch_receipt_to_worker_ack_post'},
    recentEvents:this.recent.slice(0,20),eventRetention:'latest_100_since_worker_service_start',tradingEnabled:false};}
  async stop(){this.running=false;this.snapshotHealthy=false;clearTimeout(this.retry);clearTimeout(this.refreshTimer);clearTimeout(this.earlyRefreshTimer);clearInterval(this.watchdog);
    this.refreshTimer=undefined;this.earlyRefreshTimer=undefined;this.watchdog=undefined;this.revokeAllCoverage();const worker=this.worker;
    if(worker)await new Promise<void>(done=>{let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);done();},
      timer=setTimeout(()=>{void worker.terminate().then(finish,finish);},3000);worker.once('exit',finish);
      try{worker.postMessage('stop');}catch{void worker.terminate().then(finish,finish);}});this.worker=undefined;}
}
