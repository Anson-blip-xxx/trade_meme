import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {WalletHistoryDetail,WalletHistoryListOptions,WalletHistorySummary} from './wallet-history.js';
import type {WalletAssociationDetail,WalletAssociationListOptions,WalletAssociationSummary} from './wallet-associations.js';
import type {WalletProfile,WalletProfileListOptions} from './wallet-profiles.js';
import type {ScanListOptions} from './scan-archive.js';
import type {TokenRankResearchPage,TokenRankWalletPage,TokenRankResearchReader} from './token-rank-research.js';
import type {Chain} from './types.js';
import type {MemePage} from './meme-observer.js';

export type WalletHistoryDetailErrorCode='WALLET_HISTORY_DETAIL_BUSY'|'WALLET_HISTORY_DETAIL_TIMEOUT'|
  'WALLET_HISTORY_DETAIL_WORKER_FAILED'|'WALLET_HISTORY_DETAIL_STOPPED'|'WALLET_HISTORY_DETAIL_READ_FAILED';

export class WalletHistoryDetailError extends Error {
  constructor(readonly code:WalletHistoryDetailErrorCode){super(code);this.name='WalletHistoryDetailError';}
}

export interface WalletHistoryDetailRunnerOptions {
  database?:string;profileDatabase?:string;scanDatabase?:string;tokenRankDatabase?:string;memeDatabase?:string;
  memeMaxActive?:number;memeActiveWindowSec?:number;memeAllowedChains?:Chain[];corroborationDatabase?:string;corroborationWindowSec?:number;
  memeSamplingPlanPath?:string;
  maxPending?:number;timeoutMs?:number;
}
interface Pending {key:string;resolve:(value:unknown)=>void;reject:(error:WalletHistoryDetailError)=>void;timer:ReturnType<typeof setTimeout>;}

export interface WalletProfilePage {ready:boolean;items:WalletProfile[];total:number;}
export interface WalletHistoryPage {items:WalletHistorySummary[];total:number;}
export interface WalletAssociationPage {items:WalletAssociationSummary[];total:number;}
export type TokenRankTokenPage=ReturnType<TokenRankResearchReader['list']>;
export type TokenRankTokenDetail=ReturnType<TokenRankResearchReader['detail']>;
export type TokenRankWalletPageResult=ReturnType<TokenRankResearchReader['wallets']>;
export type TokenRankWalletDetail=ReturnType<TokenRankResearchReader['wallet']>;

/** Bounded read-only worker for dashboard queries that can scan or deserialize large research stores. */
export class WalletHistoryDetailRunner {
  private readonly maxPending:number;
  private readonly timeoutMs:number;
  private worker?:Worker;
  private running=false;
  private sequence=0;
  private readonly pending=new Map<number,Pending>();
  private readonly requests=new Map<string,Promise<unknown>>();

  constructor(private readonly options:WalletHistoryDetailRunnerOptions){
    this.maxPending=options.maxPending??16;this.timeoutMs=options.timeoutMs??12_000;
    if(![options.database,options.profileDatabase,options.scanDatabase,options.tokenRankDatabase,options.memeDatabase].some(Boolean)||
      !Number.isSafeInteger(this.maxPending)||this.maxPending<1||this.maxPending>64||
      !Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<100||this.timeoutMs>60_000)throw new Error('WALLET_HISTORY_DETAIL_CONFIG_INVALID');
  }

  start():void {if(this.running)return;this.running=true;this.launch();}

  getWallet(chain:Chain,address:string):Promise<WalletHistoryDetail|undefined> {
    return this.request<WalletHistoryDetail|undefined>(`wallet-detail:${chain}:${address}`,{query:'wallet-detail',chain,address});
  }
  listWallets(options:WalletHistoryListOptions={}):Promise<WalletHistoryPage> {
    return this.request<WalletHistoryPage>(`wallet-list:${JSON.stringify(options)}`,{query:'wallet-list',options});
  }
  listProfiles(options:WalletProfileListOptions={}):Promise<WalletProfilePage> {
    return this.request<WalletProfilePage>(`profile-list:${JSON.stringify(options)}`,{query:'profile-list',options});
  }
  getProfile(chain:Chain,address:string):Promise<WalletProfile|undefined> {
    return this.request<WalletProfile|undefined>(`profile-detail:${chain}:${address}`,{query:'profile-detail',chain,address});
  }
  listAssociations(options:WalletAssociationListOptions={}):Promise<WalletAssociationPage> {
    return this.request<WalletAssociationPage>(`association-list:${JSON.stringify(options)}`,{query:'association-list',options});
  }
  getAssociation(chain:Chain,leader:string,candidate:string):Promise<WalletAssociationDetail|undefined> {
    return this.request<WalletAssociationDetail|undefined>(`association-detail:${chain}:${leader}:${candidate}`,
      {query:'association-detail',chain,leader,candidate});
  }
  listScans(options:ScanListOptions={}):Promise<{items:unknown[];total:number}> {
    return this.request(`scan-list:${JSON.stringify(options)}`,{query:'scan-list',options});
  }
  getScan(id:string):Promise<unknown|undefined> {
    return this.request(`scan-detail:${id}`,{query:'scan-detail',scanId:id});
  }
  listTokenRank(options:TokenRankResearchPage={}):Promise<TokenRankTokenPage> {
    return this.request(`token-rank-list:${JSON.stringify(options)}`,{query:'token-rank-list',options});
  }
  getTokenRank(chain:Chain,address:string,options:TokenRankResearchPage={}):Promise<TokenRankTokenDetail> {
    return this.request(`token-rank-detail:${chain}:${address}:${JSON.stringify(options)}`,
      {query:'token-rank-detail',chain,address,options});
  }
  listTokenRankWallets(options:TokenRankWalletPage={}):Promise<TokenRankWalletPageResult> {
    return this.request(`token-rank-wallet-list:${JSON.stringify(options)}`,{query:'token-rank-wallet-list',options});
  }
  getTokenRankWallet(chain:Chain,address:string,options:TokenRankResearchPage={}):Promise<TokenRankWalletDetail> {
    return this.request(`token-rank-wallet-detail:${chain}:${address}:${JSON.stringify(options)}`,
      {query:'token-rank-wallet-detail',chain,address,options});
  }
  listMeme(options:MemePage={},context:{now:string;status:unknown}):Promise<unknown> {
    return this.request(`meme-list:${JSON.stringify(options)}:${context.now}`,{query:'meme-list',options,context});
  }
  getMeme(chain:Chain,address:string,options:MemePage={},context:{now:string}):Promise<unknown> {
    return this.request(`meme-detail:${chain}:${address}:${JSON.stringify(options)}:${context.now}`,
      {query:'meme-detail',chain,address,options,context});
  }
  getMemeStatus(context:{now:string;status:unknown}):Promise<unknown> {
    return this.request(`meme-status:${context.now}`,{query:'meme-status',context});
  }

  private request<T>(key:string,message:Record<string,unknown>):Promise<T> {
    if(!this.running)return Promise.reject(new WalletHistoryDetailError('WALLET_HISTORY_DETAIL_STOPPED'));
    const existing=this.requests.get(key);if(existing)return existing as Promise<T>;
    if(this.pending.size>=this.maxPending)return Promise.reject(new WalletHistoryDetailError('WALLET_HISTORY_DETAIL_BUSY'));
    if(!this.worker)this.launch();
    const id=++this.sequence;
    let resolve!:(value:unknown)=>void,reject!:(error:WalletHistoryDetailError)=>void;
    const request=new Promise<T>((accept,fail)=>{resolve=accept as (value:unknown)=>void;reject=fail;});
    const timer=setTimeout(()=>{
      this.settle(id,undefined,new WalletHistoryDetailError('WALLET_HISTORY_DETAIL_TIMEOUT'));
      this.failWorker('WALLET_HISTORY_DETAIL_WORKER_FAILED');
    },this.timeoutMs);timer.unref();
    this.pending.set(id,{key,resolve,reject,timer});this.requests.set(key,request);
    try {this.worker!.postMessage({type:'query',id,...message});}
    catch {this.settle(id,undefined,new WalletHistoryDetailError('WALLET_HISTORY_DETAIL_WORKER_FAILED'));}
    return request;
  }

  private launch():void {
    if(!this.running||this.worker)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-history-detail-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,profileDatabase:this.options.profileDatabase,
        scanDatabase:this.options.scanDatabase,tokenRankDatabase:this.options.tokenRankDatabase,memeDatabase:this.options.memeDatabase,
        memeMaxActive:this.options.memeMaxActive,memeActiveWindowSec:this.options.memeActiveWindowSec,memeAllowedChains:this.options.memeAllowedChains,
        memeSamplingPlanPath:this.options.memeSamplingPlanPath,corroborationDatabase:this.options.corroborationDatabase,
        corroborationWindowSec:this.options.corroborationWindowSec},env:{},execArgv:[]});this.worker=worker;
      worker.on('message',(message:{type?:string;id?:number;value?:unknown;error?:string})=>{
        if(this.worker!==worker||!Number.isSafeInteger(message?.id))return;
        if(message.type==='result')this.settle(message.id!,message.value);
        else if(message.type==='failed')this.settle(message.id!,undefined,new WalletHistoryDetailError('WALLET_HISTORY_DETAIL_READ_FAILED'));
      });
      worker.on('error',()=>{if(this.worker===worker)this.failWorker('WALLET_HISTORY_DETAIL_WORKER_FAILED');});
      worker.on('exit',()=>{if(this.worker===worker){this.worker=undefined;if(this.running)this.rejectAll('WALLET_HISTORY_DETAIL_WORKER_FAILED');}});
    } catch {this.rejectAll('WALLET_HISTORY_DETAIL_WORKER_FAILED');}
  }

  private settle(id:number,value?:unknown,error?:WalletHistoryDetailError):void {
    const request=this.pending.get(id);if(!request)return;
    clearTimeout(request.timer);this.pending.delete(id);this.requests.delete(request.key);
    if(error)request.reject(error);else request.resolve(value);
  }

  private rejectAll(code:WalletHistoryDetailErrorCode):void {
    for(const id of [...this.pending.keys()])this.settle(id,undefined,new WalletHistoryDetailError(code));
  }

  private failWorker(code:WalletHistoryDetailErrorCode):void {
    const worker=this.worker;this.worker=undefined;this.rejectAll(code);if(worker)void worker.terminate().catch(()=>{});
  }

  async stop():Promise<void> {
    if(!this.running&&!this.worker)return;
    this.running=false;this.rejectAll('WALLET_HISTORY_DETAIL_STOPPED');const worker=this.worker;this.worker=undefined;
    if(!worker)return;
    await new Promise<void>(done=>{
      let settled=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);done();};
      const timer=setTimeout(()=>{void worker.terminate().then(finish,finish);},3_000);timer.unref();worker.once('exit',finish);
      try{worker.postMessage({type:'stop'});}catch{void worker.terminate().then(finish,finish);}
    });
  }
}
