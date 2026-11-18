import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {chainAddress} from './chain-stream-store.js';
import type {Chain} from './types.js';
import {WalletProfileReader,type WalletFastProfileMetadata,type WalletProfileStatus} from './wallet-profiles.js';

const FAST_METADATA_CACHE_MAX=1000,FAST_METADATA_CACHE_TTL_MS=600_000,FAST_METADATA_REFRESH_MS=300_000;

export interface WalletProfileRunnerOptions {
  database:string;historyDatabase:string;chainDatabase?:string;launcherDatabase?:string;
  maxBytes:number;intervalSec:number;batchSize:number;refreshAfterSec?:number;coldRefreshAfterSec?:number;
  fastTargetLimits?:Partial<Record<Chain,number>>;
}
/** Own the worker lifecycle independently of HTTP requests and vendor limits. */
export class WalletProfileRunner {
  readonly reader:WalletProfileReader;
  private worker?:Worker;
  private timer?:ReturnType<typeof setTimeout>;
  private watchdog?:ReturnType<typeof setInterval>;
  private running=false;
  private inFlight=false;
  private livePriority=false;
  private workerLivePriority?:boolean;
  private workingSince=0;
  private error?:string;
  private fastError?:string;
  private restarts=0;
  private fastTargets:Partial<Record<Chain,string[]>>={};
  private fastTargetsAt?:string;
  private fastMetadataCache=new Map<string,{loadedAt:number;value?:WalletFastProfileMetadata}>();
  private fastMetadataRequests=new Map<number,string[]>();
  private fastMetadataInFlight=new Set<string>();
  private fastMetadataSequence=0;
  private cached:Partial<WalletProfileStatus>={ready:false,profiles:0,sourceWallets:0,initialComplete:false,groupCounts:{}};
  constructor(private readonly options:WalletProfileRunnerOptions) {
    if([options.historyDatabase,options.chainDatabase,options.launcherDatabase].some(path=>path&&resolve(path)===resolve(options.database)))
      throw new Error('WALLET_PROFILE_DATABASE_MUST_BE_SEPARATE');
    // Use the configured window immediately. The reader can be opened by the
    // screening service before the worker has persisted the same value.
    this.reader=new WalletProfileReader(options.database,()=>new Date(),options.refreshAfterSec??21600);
  }
  status() {
    return {...this.cached,enabled:true,running:this.running&&!!this.worker,inFlight:this.inFlight,
      livePriority:this.livePriority,workerLivePriority:this.workerLivePriority,
      intervalSec:this.options.intervalSec,batchSize:this.options.batchSize,refreshAfterSec:this.options.refreshAfterSec??21600,
      liveMaintenanceIntervalSec:this.options.intervalSec,liveMaintenanceBatchSize:1,
      coldRefreshAfterSec:this.options.coldRefreshAfterSec??604800,restarts:this.restarts,
      ...(this.error?{error:this.error}:{}),fastTargetsAt:this.fastTargetsAt,
      fastTargetCounts:Object.fromEntries(Object.entries(this.fastTargets).map(([chain,addresses])=>[chain,addresses?.length??0])),
      fastMetadataCacheEntries:this.fastMetadataCache.size,fastMetadataCacheMax:FAST_METADATA_CACHE_MAX,
      ...(this.fastError?{fastError:this.fastError}:{}),sampleOnly:true,ownership:'unknown',tradingEnabled:false};
  }
  /** Worker-produced cohort; reading it never touches the multi-gigabyte profile database on the main thread. */
  fastTargetAddresses(chain:Chain,limit=this.fastTargetLimit(chain)):string[] {
    return (this.fastTargets[chain]??[]).slice(0,Math.max(1,Math.min(this.fastTargetLimit(chain),Math.trunc(limit))));
  }
  private fastTargetLimit(chain:Chain):number {const value=this.options.fastTargetLimits?.[chain]??30;
    return Math.max(1,Math.min(chain==='solana'?30:200,Math.trunc(value)));}
  /** Return cached compact metadata and asynchronously fill misses in the profile worker. */
  fastMetadata(targets:readonly {chain:Chain;address:string}[]):WalletFastProfileMetadata[] {
    const now=Date.now(),normalized=new Map<string,{chain:Chain;address:string}>();this.pruneFastMetadata(now);
    for(const target of targets.slice(0,500)){const address=chainAddress(target.chain,target.address);
      if(address)normalized.set(`${target.chain}:${address}`,{chain:target.chain,address});}
    const missing:{chain:Chain;address:string}[]=[];
    for(const [key,target] of normalized){const cached=this.fastMetadataCache.get(key);
      if(cached){
        // Keep serving the last valid compact row while its asynchronous
        // refresh is in flight. pruneFastMetadata already removed entries past
        // the hard TTL, so this cannot extend metadata beyond ten minutes.
        this.fastMetadataCache.delete(key);this.fastMetadataCache.set(key,cached);
        if(now-cached.loadedAt>=FAST_METADATA_REFRESH_MS&&!this.fastMetadataInFlight.has(key))missing.push(target);
      }else if(!this.fastMetadataInFlight.has(key))missing.push(target);}
    if(missing.length&&this.worker){const id=++this.fastMetadataSequence,keys=missing.map(row=>`${row.chain}:${row.address}`);
      for(const key of keys)this.fastMetadataInFlight.add(key);this.fastMetadataRequests.set(id,keys);
      try {this.worker.postMessage({type:'fast-metadata',id,targets:missing});}
      catch {this.fastMetadataRequests.delete(id);for(const key of keys)this.fastMetadataInFlight.delete(key);this.fastError='WALLET_PROFILE_FAST_METADATA_FAILED';}}
    return [...normalized.keys()].flatMap(key=>{const value=this.fastMetadataCache.get(key)?.value;return value?[value]:[];});
  }
  private pruneFastMetadata(now:number):void {
    for(const [key,row] of this.fastMetadataCache)if(now-row.loadedAt>=FAST_METADATA_CACHE_TTL_MS)this.fastMetadataCache.delete(key);
    while(this.fastMetadataCache.size>FAST_METADATA_CACHE_MAX)this.fastMetadataCache.delete(this.fastMetadataCache.keys().next().value!);
  }
  start() {
    if(this.running)return;this.running=true;this.launch();
    this.watchdog=setInterval(()=>{
      if(this.worker&&this.inFlight&&Date.now()-this.workingSince>120000) {
        this.error='WALLET_PROFILE_WORKER_TIMEOUT';void this.worker.terminate();
      }
    },10000);this.watchdog.unref();
  }
  /** Reduce research writes to one profile per configured interval while live signals own latency priority. */
  setLivePriority(active:boolean) {
    this.livePriority=active;
    try{this.worker?.postMessage({type:'live-priority',active});}catch{}
  }
  private launch() {
    if(!this.running)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-profile-worker.${source?'ts':'js'}`,import.meta.url);
      // The compiled service has no tsx dependency. Source-mode tests/development
      // register tsx inside the worker before loading TypeScript imports.
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{...this.options,livePriority:this.livePriority},env:{},execArgv:[]});
      this.worker=worker;
      this.workerLivePriority=undefined;
      worker.on('message',message=>{
        if(this.worker!==worker)return;
        if(message?.type==='priority'&&typeof message.livePriority==='boolean')this.workerLivePriority=message.livePriority;
        else if(message?.type==='fast-targets'&&message.targets&&typeof message.targets==='object'){
          const next:Partial<Record<Chain,string[]>>={};
          for(const chain of ['bsc','solana','robinhood'] as Chain[]){const values=message.targets[chain];if(!Array.isArray(values))continue;
            next[chain]=[...new Set(values.map((value:unknown)=>chainAddress(chain,value)).filter((value:unknown):value is string=>typeof value==='string'))]
              .slice(0,this.fastTargetLimit(chain));}
          this.fastTargets=next;this.fastTargetsAt=typeof message.computedAt==='string'&&Number.isFinite(Date.parse(message.computedAt))?message.computedAt:new Date().toISOString();
          this.pruneFastMetadata(Date.now());
          this.fastError=undefined;
        }
        else if(message?.type==='fast-targets-failed')this.fastError='WALLET_PROFILE_FAST_TARGETS_FAILED';
        else if((message?.type==='fast-metadata'||message?.type==='fast-metadata-failed')&&Number.isSafeInteger(message.id)){
          const keys=this.fastMetadataRequests.get(message.id)??[];this.fastMetadataRequests.delete(message.id);
          for(const key of keys)this.fastMetadataInFlight.delete(key);
          if(message.type==='fast-metadata'){
            const values=new Map<string,WalletFastProfileMetadata>();
            if(Array.isArray(message.items))for(const item of message.items){const chain=item?.chain as Chain,address=chainAddress(chain,item?.address);
              if(!address||!Array.isArray(item.groups)||typeof item.freshUntil!=='string'||!Number.isFinite(Date.parse(item.freshUntil)))continue;
              values.set(`${chain}:${address}`,{chain,address,groups:item.groups.filter((group:unknown):group is string=>typeof group==='string').slice(0,32),freshUntil:item.freshUntil});}
            const loadedAt=Date.now();for(const key of keys){this.fastMetadataCache.delete(key);this.fastMetadataCache.set(key,{loadedAt,value:values.get(key)});}
            this.pruneFastMetadata(loadedAt);this.fastError=undefined;
          }else this.fastError='WALLET_PROFILE_FAST_METADATA_FAILED';
        }
        else if(message?.type==='working') {this.inFlight=true;this.workingSince=Date.now();}
        else if(message?.type==='status') {this.cached=message.status;this.reader.replaceProfitCohorts(message.profitCohorts);this.inFlight=false;this.error=undefined;}
        else if(message?.type==='failed') {this.inFlight=false;this.error='WALLET_PROFILE_REFRESH_FAILED';}
      });
      worker.on('error',()=>{if(this.worker===worker)this.error='WALLET_PROFILE_WORKER_FAILED';});
      worker.on('exit',()=>{
        if(this.worker!==worker)return;
        this.worker=undefined;this.inFlight=false;this.workerLivePriority=undefined;this.fastMetadataRequests.clear();this.fastMetadataInFlight.clear();
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
    this.worker=undefined;this.inFlight=false;this.workerLivePriority=undefined;this.reader.close();
    this.fastMetadataRequests.clear();this.fastMetadataInFlight.clear();this.fastMetadataCache.clear();
  }
}
