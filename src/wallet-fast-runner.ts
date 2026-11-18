import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {Config} from './config.js';
import {LatencyWindow,type FastWalletEvent,type FastWalletSnapshot} from './wallet-fast.js';
import type {Chain} from './types.js';

export interface WalletFastCoverageUpdate {chain:Chain;wallets:string[];at:string}

export interface WalletFastOptions {
  endpoints:Config['chainStream']['endpoints'];maxWallets:number;
  maxWalletsByChain?:Partial<Record<Chain,number>>;
  snapshot:()=>FastWalletSnapshot;onEvent:(event:FastWalletEvent)=>void;
  onCoverage?:(chain:Chain,wallets:string[],at:string)=>void;
  onCoverageBatch?:(updates:readonly WalletFastCoverageUpdate[])=>void;
}
/** Socket processing lives in its own thread, isolated from main-thread SQLite and HTTP work. */
export class WalletFastRunner {
  private worker?:Worker;private timer?:ReturnType<typeof setInterval>;private retry?:ReturnType<typeof setTimeout>;
  private running=false;private error?:string;private cached:Record<string,any>={};private restarts=0;
  private lastError?:string;private lastErrorAt?:string;
  private recent:(FastWalletEvent&{handoffMs:number;mainThreadReceivedAt:string})[]=[];
  private handoff=new LatencyWindow();private snapshotBuild=new LatencyWindow();private lastStatusAt=0;
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
  start(){if(this.running)return;this.running=true;this.launch();this.timer=setInterval(()=>{
    this.refresh();if(this.worker&&this.lastStatusAt&&Date.now()-this.lastStatusAt>45000){
      this.revokeAllCoverage();this.setError('FAST_WALLET_WORKER_TIMEOUT');void this.worker.terminate();}
  },30000);this.timer.unref();}
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
          const coverageOk=this.acceptCoverageStatus(message.status);
          if(coverageOk)this.clearError('FAST_WALLET_COVERAGE_CALLBACK_FAILED');
          worker.postMessage({type:'status_ack'});}
        else if(message?.type==='snapshot_applied'){
          this.snapshotHealthy=true;this.clearError('FAST_WALLET_TARGET_REFRESH_FAILED','FAST_WALLET_SNAPSHOT_INVALID');
        }
        else if(message?.type==='coverage_lost'){
          const chain=message.chain as Chain;if(['bsc','solana','robinhood'].includes(chain))
            this.revokeCoverage(chain,typeof message.at==='string'&&Number.isFinite(Date.parse(message.at))?message.at:new Date().toISOString());
        }
        else if(message?.type==='events'){
          let delivered=true;try {for(const event of message.events as FastWalletEvent[]){const receivedAt=Date.now(),handoffMs=Math.max(0,receivedAt-Date.parse(event.judgedAt));this.handoff.add(handoffMs);
            this.recent.unshift({...event,handoffMs,mainThreadReceivedAt:new Date(receivedAt).toISOString()});if(this.recent.length>100)this.recent.pop();
            try{this.options.onEvent(event);}catch{delivered=false;this.setError('FAST_WALLET_RESEARCH_ENQUEUE_FAILED');}}}
          finally{worker.postMessage({type:'ack',id:message.id});}
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
  private refresh(){if(!this.running||!this.worker)return;const started=performance.now();try{this.worker.postMessage({type:'snapshot',snapshot:this.options.snapshot()});}
    catch{this.snapshotHealthy=false;this.revokeAllCoverage();this.setError('FAST_WALLET_TARGET_REFRESH_FAILED');}
    finally{this.snapshotBuild.add(performance.now()-started);}}
  status():Record<string,any>{return {...this.cached,enabled:true,running:this.running&&!!this.worker,statusStale:Date.now()-this.lastStatusAt>10000,
    restarts:this.restarts,error:this.error,lastError:this.lastError,lastErrorAt:this.lastErrorAt,
    snapshotBuild:{...this.snapshotBuild.summary(),basis:'main_thread_snapshot_build_and_handoff'},
    mainThreadHandoff:{...this.handoff.summary(),basis:'fast_verdict_to_main_thread_receipt'},
    recentEvents:this.recent.slice(0,20),eventRetention:'latest_100_since_worker_service_start',tradingEnabled:false};}
  async stop(){this.running=false;this.snapshotHealthy=false;clearTimeout(this.retry);clearInterval(this.timer);this.revokeAllCoverage();const worker=this.worker;
    if(worker)await new Promise<void>(done=>{const t=setTimeout(()=>void worker.terminate(),3000);worker.once('exit',()=>{clearTimeout(t);done();});worker.postMessage('stop');});this.worker=undefined;}
}
