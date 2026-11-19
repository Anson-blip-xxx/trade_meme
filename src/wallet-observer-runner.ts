import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import bs58 from 'bs58';
import {GmgnError,type GmgnClient,type GmgnErrorReason} from './providers/gmgn-client.js';
import type {GmgnFeedPage} from './scanner.js';
import type {WalletHistoryToken} from './wallet-history.js';
import type {WalletObserverFeedReport,WalletObserverStatus} from './wallet-observer.js';
import type {Chain} from './types.js';
import type {WalletPriceDurableAdmission} from './wallet-price-writer.js';

const CHAINS:Chain[]=['bsc','solana','robinhood'];
const ERROR_REASONS=new Set<GmgnErrorReason>(['GMGN_API_KEY_MISSING','GMGN_PATH_NOT_ALLOWED','GMGN_QUERY_INVALID',
  'GMGN_SIGNING_KEY_MISSING','GMGN_RATE_LIMITED','GMGN_QUEUE_TIMEOUT','GMGN_REQUEST_TIMEOUT','GMGN_REQUEST_FAILED',
  'GMGN_RESPONSE_TOO_LARGE','GMGN_RESPONSE_INVALID','GMGN_INVALID_JSON','GMGN_REQUEST_ABORTED','GMGN_AUTH_FAILED',
  'GMGN_CURSOR_INVALID','GMGN_HTTP_ERROR','GMGN_API_ERROR']);

export interface WalletObserverRunnerOptions {
  database:string;maxBytes:number;
  client:Pick<GmgnClient,'get'|'cooldownUntil'>&Partial<Pick<GmgnClient,'recordRateLimit'>>;
  priceWriter?:{recordPriceDurable:(target:WalletHistoryToken,priceUsd:number,observedAt:string,provider:string)=>
    Promise<WalletPriceDurableAdmission>};
  chains?:Chain[];intervalMs?:number;maxRequestsPerCycle?:number;
  maxPendingFeeds?:number;maxFeedRetries?:number;maxProxyRequests?:number;requestTimeoutMs?:number;priceAckTimeoutMs?:number;
  restartDelayMs?:number;stopTimeoutMs?:number;
}
export interface WalletObserverFeedAdmission {accepted:boolean;reason?:'WALLET_OBSERVER_NOT_RUNNING'|'WALLET_OBSERVER_FEED_QUEUE_FULL'|'WALLET_OBSERVER_FEED_INVALID';}
export interface WalletObserverRunnerStatus extends Partial<WalletObserverStatus> {
  state:'idle'|'starting'|'ready'|'stopping'|'stopped';running:boolean;inFlight:boolean;ready:boolean;
  worker:{pendingFeeds:number;inFlightFeeds:number;maxPendingFeeds:number;maxFeedRetries:number;maxProxyRequests:number;acceptedFeeds:number;completedFeeds:number;
    rejectedCapacity:number;rejectedClosed:number;replayedAfterRestart:number;networkInFlight:number;networkCompleted:number;
    networkFailed:number;networkTimeouts:number;networkRejectedCapacity:number;pricesForwarded:number;pricesRejected:number;restarts:number;
    priceAckTimeouts:number;priceLateResults:number;priceInputRejected:number;
    retriedFeeds:number;failedFeeds:number;droppedFeeds:number;droppedOnStop:number;
    shutdownDrained?:boolean;error?:string;shutdownError?:string;};
  lastFeedReport?:WalletObserverFeedReport;
}

interface FeedJob {id:number;page:GmgnFeedPage;attempts:number;}
interface NetworkRequest {requestId:number;path:string;query:Record<string,string|number>;weight?:number;}
interface PriceForward {timedOut:boolean;}

const PRICE_PROVIDER=/^[a-z][a-z0-9_.:-]{0,79}$/;
function validPriceTarget(value:unknown):value is WalletHistoryToken {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const target=value as Record<string,unknown>;
  if(typeof target.address!=='string'||!CHAINS.includes(target.chain as Chain))return false;
  if(target.chain!=='solana')return /^0x[0-9a-f]{40}$/i.test(target.address)&&!/^0x0+$/i.test(target.address);
  try {const decoded=bs58.decode(target.address);return decoded.length===32&&decoded.some(byte=>byte!==0);}catch{return false;}
}

/**
 * Keeps every WalletHistory access in a worker. The parent retains ownership of
 * GmgnClient so all readers continue to share one credential scheduler.
 */
export class WalletObserverRunner {
  private readonly intervalMs:number;
  private readonly maxRequestsPerCycle:number;
  private readonly maxPendingFeeds:number;
  private readonly maxFeedRetries:number;
  private readonly maxProxyRequests:number;
  private readonly requestTimeoutMs:number;
  private readonly priceAckTimeoutMs:number;
  private readonly restartDelayMs:number;
  private readonly stopTimeoutMs:number;
  private readonly chains:Chain[];
  private worker?:Worker;
  private retry?:ReturnType<typeof setTimeout>;
  private state:WalletObserverRunnerStatus['state']='idle';
  private active=false;
  private accepting=false;
  private observerStatus?:WalletObserverStatus;
  private workerError?:string;
  private shutdownError?:string;
  private shutdownDrained?:boolean;
  private feedSequence=0;
  private feeds:FeedJob[]=[];
  private feedInFlight?:FeedJob;
  private acceptedFeeds=0;
  private completedFeeds=0;
  private rejectedCapacity=0;
  private rejectedClosed=0;
  private replayedAfterRestart=0;
  private networkInFlight=0;
  private networkCompleted=0;
  private networkFailed=0;
  private networkTimeouts=0;
  private networkRejectedCapacity=0;
  private pricesForwarded=0;
  private pricesRejected=0;
  private restarts=0;
  private droppedOnStop=0;
  private retriedFeeds=0;
  private failedFeeds=0;
  private droppedFeeds=0;
  private lastFeedReport?:WalletObserverFeedReport;
  private drainWaiters=new Set<()=>void>();
  private stopPromise?:Promise<boolean>;
  private priceForwards=new Map<string,PriceForward>();
  private priceAckTimeouts=0;
  private priceLateResults=0;
  private priceInputRejected=0;

  constructor(private readonly options:WalletObserverRunnerOptions){
    this.intervalMs=options.intervalMs??300_000;this.maxRequestsPerCycle=options.maxRequestsPerCycle??9;
    this.maxPendingFeeds=options.maxPendingFeeds??128;this.maxFeedRetries=options.maxFeedRetries??2;this.maxProxyRequests=options.maxProxyRequests??2;
    this.requestTimeoutMs=options.requestTimeoutMs??60_000;
    this.priceAckTimeoutMs=options.priceAckTimeoutMs??5_000;
    this.restartDelayMs=options.restartDelayMs??1_000;this.stopTimeoutMs=options.stopTimeoutMs??65_000;
    const chains=options.chains??CHAINS;this.chains=[...new Set(chains)];
    if(typeof options.database!=='string'||!options.database.trim()||!Number.isSafeInteger(options.maxBytes)||options.maxBytes<16_384||
      !Number.isSafeInteger(this.intervalMs)||this.intervalMs<1||this.intervalMs>3_600_000||
      !Number.isSafeInteger(this.maxRequestsPerCycle)||this.maxRequestsPerCycle<1||this.maxRequestsPerCycle>10||
      !Number.isSafeInteger(this.maxPendingFeeds)||this.maxPendingFeeds<1||this.maxPendingFeeds>1_000||
      !Number.isSafeInteger(this.maxFeedRetries)||this.maxFeedRetries<0||this.maxFeedRetries>10||
      !Number.isSafeInteger(this.maxProxyRequests)||this.maxProxyRequests<1||this.maxProxyRequests>16||
      !Number.isSafeInteger(this.requestTimeoutMs)||this.requestTimeoutMs<1_000||this.requestTimeoutMs>120_000||
      !Number.isSafeInteger(this.priceAckTimeoutMs)||this.priceAckTimeoutMs<10||this.priceAckTimeoutMs>60_000||
      !Number.isSafeInteger(this.restartDelayMs)||this.restartDelayMs<10||this.restartDelayMs>60_000||
      !Number.isSafeInteger(this.stopTimeoutMs)||this.stopTimeoutMs<100||this.stopTimeoutMs>180_000||
      !this.chains.length||this.chains.some(chain=>!CHAINS.includes(chain)))throw new Error('WALLET_OBSERVER_RUNNER_CONFIG_INVALID');
  }

  start():void {if(this.active)return;this.active=true;this.accepting=true;this.shutdownError=undefined;this.shutdownDrained=undefined;
    this.state='starting';this.launch();}

  observeFeed(page:GmgnFeedPage):WalletObserverFeedAdmission {
    if(!this.active||!this.accepting){this.rejectedClosed++;return {accepted:false,reason:'WALLET_OBSERVER_NOT_RUNNING'};}
    let copy:GmgnFeedPage;try {copy=structuredClone(page);}catch {return {accepted:false,reason:'WALLET_OBSERVER_FEED_INVALID'};}
    if(this.feeds.length+(this.feedInFlight?1:0)>=this.maxPendingFeeds){this.rejectedCapacity++;
      return {accepted:false,reason:'WALLET_OBSERVER_FEED_QUEUE_FULL'};}
    this.feeds.push({id:++this.feedSequence,page:copy,attempts:0});this.acceptedFeeds++;this.pumpFeeds();return {accepted:true};
  }

  getStatus():WalletObserverRunnerStatus {
    const observer=this.observerStatus;
    return {...observer,state:this.state,ready:this.state==='ready'&&!!this.worker,
      running:this.active&&this.state==='ready'&&(observer?.running??true),inFlight:observer?.inFlight??false,
      worker:{pendingFeeds:this.feeds.length,inFlightFeeds:this.feedInFlight?1:0,maxPendingFeeds:this.maxPendingFeeds,
        maxFeedRetries:this.maxFeedRetries,maxProxyRequests:this.maxProxyRequests,
        acceptedFeeds:this.acceptedFeeds,completedFeeds:this.completedFeeds,rejectedCapacity:this.rejectedCapacity,
        rejectedClosed:this.rejectedClosed,replayedAfterRestart:this.replayedAfterRestart,networkInFlight:this.networkInFlight,
        networkCompleted:this.networkCompleted,networkFailed:this.networkFailed,networkTimeouts:this.networkTimeouts,
        networkRejectedCapacity:this.networkRejectedCapacity,
        pricesForwarded:this.pricesForwarded,pricesRejected:this.pricesRejected,restarts:this.restarts,
        priceAckTimeouts:this.priceAckTimeouts,priceLateResults:this.priceLateResults,priceInputRejected:this.priceInputRejected,
        retriedFeeds:this.retriedFeeds,failedFeeds:this.failedFeeds,droppedFeeds:this.droppedFeeds,droppedOnStop:this.droppedOnStop,
        ...(this.shutdownDrained!==undefined?{shutdownDrained:this.shutdownDrained}:{}),
        ...(this.workerError?{error:this.workerError}:{}),...(this.shutdownError?{shutdownError:this.shutdownError}:{})},
      ...(this.lastFeedReport?{lastFeedReport:structuredClone(this.lastFeedReport)}:{})};
  }

  async stop(timeoutMs=this.stopTimeoutMs):Promise<boolean>{
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new Error('WALLET_OBSERVER_STOP_TIMEOUT_INVALID');
    if(!this.active&&this.state==='stopped')return this.shutdownDrained!==false;
    if(this.stopPromise)return this.stopPromise;
    this.stopPromise=this.stopInternal(timeoutMs).finally(()=>{this.stopPromise=undefined;});
    return this.stopPromise;
  }

  private async stopInternal(timeoutMs:number):Promise<boolean>{
    this.accepting=false;this.state='stopping';const deadline=Date.now()+timeoutMs;
    const drained=await this.waitForDrain(Math.max(1,deadline-Date.now()));
    if(!drained)return this.abortShutdown(deadline);
    this.active=false;clearTimeout(this.retry);this.retry=undefined;
    const worker=this.worker;
    if(worker){
      const exited=await new Promise<boolean>(resolve=>{
        let settled=false;const finish=(value:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
        const timer=setTimeout(()=>finish(false),Math.max(1,deadline-Date.now()));worker.once('exit',()=>finish(true));
        try{worker.postMessage('stop');}catch{finish(false);}
      });
      if(!exited)return this.abortShutdown(deadline);
    }
    this.worker=undefined;this.state='stopped';this.shutdownDrained=true;this.shutdownError=undefined;return true;
  }

  private launch():void {
    if(!this.active)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-observer-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database,maxBytes:this.options.maxBytes,intervalMs:this.intervalMs,
        maxRequestsPerCycle:this.maxRequestsPerCycle,chains:this.chains,requestTimeoutMs:this.requestTimeoutMs,
        priceAckTimeoutMs:this.priceAckTimeoutMs,
        cooldownUntil:this.safeCooldown(this.options.client.cooldownUntil)},env:{},execArgv:[]});
      this.worker=worker;this.state='starting';
      worker.on('message',message=>this.onMessage(worker,message));
      worker.on('error',()=>{if(this.worker===worker)this.workerError='WALLET_OBSERVER_WORKER_FAILED';});
      worker.on('exit',()=>this.onExit(worker));
    } catch {this.workerError='WALLET_OBSERVER_WORKER_START_FAILED';this.scheduleRestart();}
  }

  private onMessage(worker:Worker,message:any):void {
    if(this.worker!==worker||!message||typeof message!=='object')return;
    if(message.type==='ready'){
      this.observerStatus=message.status;this.workerError=undefined;this.state='ready';worker.postMessage('start');this.pumpFeeds();return;
    }
    if(message.type==='status'){this.observerStatus=message.status;return;}
    if(message.type==='feed-result'){
      if(!this.feedInFlight||message.feedId!==this.feedInFlight.id)return;
      const job=this.feedInFlight;this.feedInFlight=undefined;
      if(message.report)this.lastFeedReport=message.report as WalletObserverFeedReport;
      if(message.report?.persisted===true)this.completedFeeds++;
      else {this.failedFeeds++;const retryable=message.retryable!==false&&message.report?.retryable!==false;
        if(retryable&&job.attempts<=this.maxFeedRetries){this.retriedFeeds++;this.feeds.unshift(job);}
        else {this.droppedFeeds++;this.workerError=message.report?.reason??message.error??'WALLET_OBSERVER_FEED_FAILED';}}
      this.resolveDrain();this.pumpFeeds();return;
    }
    if(message.type==='request'){this.proxyRequest(worker,message as NetworkRequest);return;}
    if(message.type==='request-timeout'){this.networkTimeouts++;return;}
    if(message.type==='rate-limit'){
      try{this.options.client.recordRateLimit?.(new Headers(),message.payload);}catch{}
      try{worker.postMessage({type:'cooldown',cooldownUntil:this.safeCooldown(this.options.client.cooldownUntil)});}catch{}
      return;
    }
    if(message.type==='price'){void this.forwardPrice(worker,message);return;}
    if(message.type==='price-timeout'){
      const priceId=message.priceId;
      if(typeof priceId!=='number'||!Number.isSafeInteger(priceId)||priceId<=0)return;
      const forward=this.priceForwards.get(`${worker.threadId}:${priceId}`);
      if(forward){if(!forward.timedOut){forward.timedOut=true;this.priceAckTimeouts++;}}
      else {this.priceAckTimeouts++;this.priceLateResults++;}
    }
  }

  private proxyRequest(worker:Worker,request:NetworkRequest):void {
    if(!Number.isSafeInteger(request.requestId)||typeof request.path!=='string'||!request.query||typeof request.query!=='object')return;
    if(this.networkInFlight>=this.maxProxyRequests){this.networkRejectedCapacity++;
      this.reply(worker,{type:'request-result',requestId:request.requestId,ok:false,reason:'GMGN_QUEUE_TIMEOUT',
        cooldownUntil:this.safeCooldown(this.options.client.cooldownUntil)});return;}
    this.networkInFlight++;
    void Promise.resolve().then(()=>this.options.client.get(request.path,request.query,request.weight)).then(value=>{
      this.networkCompleted++;this.reply(worker,{type:'request-result',requestId:request.requestId,ok:true,value,
        cooldownUntil:this.safeCooldown(this.options.client.cooldownUntil)});
    },error=>{
      this.networkFailed++;const reason=error instanceof GmgnError&&ERROR_REASONS.has(error.reason)?error.reason:'GMGN_REQUEST_FAILED';
      this.reply(worker,{type:'request-result',requestId:request.requestId,ok:false,reason,
        cooldownUntil:this.safeCooldown(this.options.client.cooldownUntil)});
    }).finally(()=>{this.networkInFlight=Math.max(0,this.networkInFlight-1);});
  }

  private async forwardPrice(worker:Worker,message:any):Promise<void> {
    const priceId=message.priceId;
    if(typeof priceId!=='number'||!Number.isSafeInteger(priceId)||priceId<=0)return;
    const valid=validPriceTarget(message.target)&&typeof message.priceUsd==='number'&&Number.isFinite(message.priceUsd)&&message.priceUsd>0&&
      typeof message.observedAt==='string'&&message.observedAt.length<=40&&Number.isFinite(Date.parse(message.observedAt))&&
      Date.parse(message.observedAt)<=Date.now()&&typeof message.provider==='string'&&PRICE_PROVIDER.test(message.provider);
    if(!valid){this.pricesRejected++;this.priceInputRejected++;
      this.reply(worker,{type:'price-result',priceId,accepted:false,reason:'WALLET_PRICE_INPUT_INVALID',retryable:false});return;}
    const key=`${worker.threadId}:${priceId}`;
    if(this.priceForwards.has(key)){this.pricesRejected++;
      this.reply(worker,{type:'price-result',priceId,accepted:false,reason:'WALLET_PRICE_WRITE_FAILED',retryable:true});return;}
    const forward:PriceForward={timedOut:false};this.priceForwards.set(key,forward);
    let result:WalletPriceDurableAdmission;
    try {result=this.options.priceWriter?await this.options.priceWriter.recordPriceDurable(
        message.target,message.priceUsd,message.observedAt,message.provider):
      {accepted:false,reason:'WALLET_PRICE_WRITER_UNAVAILABLE'};}
    catch {result={accepted:false,reason:'WALLET_PRICE_WRITE_FAILED'};}
    if(result.accepted)this.pricesForwarded++;else this.pricesRejected++;
    if(forward.timedOut||this.worker!==worker)this.priceLateResults++;
    this.priceForwards.delete(key);
    this.reply(worker,result.accepted?{type:'price-result',priceId,accepted:true}:
      {type:'price-result',priceId,accepted:false,reason:result.reason,retryable:result.reason!=='WALLET_PRICE_INPUT_INVALID'});
  }

  private reply(worker:Worker,message:unknown):void {if(this.worker!==worker)return;try{worker.postMessage(message);}catch{}}
  private pumpFeeds():void {if(!['ready','stopping'].includes(this.state)||!this.worker||this.feedInFlight||!this.feeds.length)return;
    this.feedInFlight=this.feeds.shift()!;this.feedInFlight.attempts++;
    try{this.worker.postMessage({type:'feed',feedId:this.feedInFlight.id,page:this.feedInFlight.page});}
    catch {this.feeds.unshift(this.feedInFlight);this.feedInFlight=undefined;this.workerError='WALLET_OBSERVER_FEED_SEND_FAILED';}}
  private onExit(worker:Worker):void {if(this.worker!==worker)return;this.worker=undefined;
    if(this.feedInFlight){const job=this.feedInFlight;this.feedInFlight=undefined;
      if(job.attempts<=this.maxFeedRetries){this.feeds.unshift(job);this.replayedAfterRestart++;this.retriedFeeds++;}
      else {this.droppedFeeds++;this.failedFeeds++;this.workerError='WALLET_OBSERVER_FEED_RETRY_EXHAUSTED';}}
    this.resolveDrain();if(this.active){this.state='starting';this.workerError??='WALLET_OBSERVER_WORKER_EXITED';this.scheduleRestart();}}
  private scheduleRestart():void {if(!this.active||this.retry)return;this.restarts++;this.retry=setTimeout(()=>{
    this.retry=undefined;this.launch();},this.restartDelayMs);this.retry.unref();}
  private safeCooldown(value:unknown):number{return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=8.64e15?value:0;}
  private resolveDrain():void {if(this.feeds.length||this.feedInFlight)return;for(const resolve of this.drainWaiters)resolve();this.drainWaiters.clear();}
  private waitForDrain(timeoutMs:number):Promise<boolean>{if(!this.feeds.length&&!this.feedInFlight)return Promise.resolve(true);
    return new Promise(resolve=>{let settled=false;const finish=(value:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);
      this.drainWaiters.delete(done);resolve(value);};const done=()=>finish(true),timer=setTimeout(()=>finish(false),timeoutMs);this.drainWaiters.add(done);});}
  private async abortShutdown(deadline:number):Promise<false>{this.active=false;clearTimeout(this.retry);this.retry=undefined;
    const worker=this.worker;this.worker=undefined;if(worker){
      const termination=worker.terminate().then(()=>undefined,()=>undefined);
      await new Promise<void>(resolve=>{let settled=false;
        const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);resolve();};
        const timer=setTimeout(finish,Math.max(1,deadline-Date.now()));void termination.then(finish);
      });
    }
    this.droppedOnStop+=this.feeds.length+(this.feedInFlight?1:0);this.feeds=[];this.feedInFlight=undefined;
    this.state='stopped';
    this.shutdownDrained=false;this.shutdownError='WALLET_OBSERVER_SHUTDOWN_UNDRAINED';this.resolveDrain();return false;}
}
