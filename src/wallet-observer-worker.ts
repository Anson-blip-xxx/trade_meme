import {parentPort,workerData} from 'node:worker_threads';
import {WalletHistory,type WalletHistoryToken} from './wallet-history.js';
import {WalletObserver,type WalletObserverPriceWriteResult,type WalletObserverStatus} from './wallet-observer.js';
import {GmgnError,type GmgnErrorReason} from './providers/gmgn-client.js';
import type {GmgnFeedPage} from './scanner.js';
import type {Chain} from './types.js';

interface WorkerOptions {
  database:string;
  maxBytes:number;
  intervalMs:number;
  maxRequestsPerCycle:number;
  chains:Chain[];
  requestTimeoutMs:number;
  priceAckTimeoutMs:number;
  cooldownUntil:number;
}
interface PendingRequest {resolve:(value:unknown)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>;}
interface PendingPrice {resolve:(result:WalletObserverPriceWriteResult)=>void;timer:ReturnType<typeof setTimeout>;}
interface RequestResult {
  type:'request-result';requestId:number;ok:boolean;value?:unknown;reason?:GmgnErrorReason;cooldownUntil?:number;
}

const options=workerData as WorkerOptions;
const port=parentPort!;
const history=new WalletHistory(options.database,{maxBytes:options.maxBytes});
const pending=new Map<number,PendingRequest>();
const pendingPrices=new Map<number,PendingPrice>();
let requestId=0,priceId=0,cooldownUntil=Number.isFinite(options.cooldownUntil)?options.cooldownUntil:0;
let closing=false,closed=false,started=false;

const safeCooldown=(value:unknown):number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=8.64e15?value:0;
const proxyClient={
  get(path:string,query:Record<string,string|number>,weight?:number):Promise<unknown>{
    if(closing)return Promise.reject(new GmgnError('GMGN_REQUEST_ABORTED'));
    const id=++requestId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        if(!pending.delete(id))return;
        port.postMessage({type:'request-timeout',requestId:id});
        reject(new GmgnError('GMGN_REQUEST_TIMEOUT'));
      },options.requestTimeoutMs);
      pending.set(id,{resolve,reject,timer});
      port.postMessage({type:'request',requestId:id,path,query,weight});
    });
  },
  get cooldownUntil(){return cooldownUntil;},
  recordRateLimit(_headers:Headers,payload?:unknown):void {port.postMessage({type:'rate-limit',payload});},
};
const priceWriter={recordPrice(target:WalletHistoryToken,priceUsd:number,observedAt:string,provider:string):Promise<WalletObserverPriceWriteResult>{
  if(closing)return Promise.resolve({accepted:false,reason:'WALLET_PRICE_WRITER_UNAVAILABLE',retryable:true});
  const id=++priceId;
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{if(!pendingPrices.delete(id))return;
      port.postMessage({type:'price-timeout',priceId:id});
      resolve({accepted:false,reason:'WALLET_PRICE_WRITE_TIMEOUT',retryable:true});},options.priceAckTimeoutMs);
    pendingPrices.set(id,{resolve,timer});
    try {port.postMessage({type:'price',priceId:id,target,priceUsd,observedAt,provider});}
    catch {pendingPrices.delete(id);clearTimeout(timer);
      resolve({accepted:false,reason:'WALLET_PRICE_WRITE_FAILED',retryable:true});}
  });
}};
const observer=new WalletObserver({history,client:proxyClient,priceWriter,chains:options.chains,
  intervalMs:options.intervalMs,maxRequestsPerCycle:options.maxRequestsPerCycle});
let statusTimer:ReturnType<typeof setInterval>|undefined,lastStatus='';

const publishStatus=(force=false)=>{
  const status=observer.getStatus(),encoded=JSON.stringify(status);
  if(force||encoded!==lastStatus){lastStatus=encoded;port.postMessage({type:'status',status});}
};
const close=()=>{if(closed)return;closed=true;clearInterval(statusTimer);for(const request of pending.values()){
  clearTimeout(request.timer);request.reject(new GmgnError('GMGN_REQUEST_ABORTED'));}pending.clear();
  for(const price of pendingPrices.values()){clearTimeout(price.timer);
    price.resolve({accepted:false,reason:'WALLET_PRICE_WRITER_UNAVAILABLE',retryable:true});}pendingPrices.clear();history.close();port.close();};
const stop=async()=>{if(closing)return;closing=true;clearInterval(statusTimer);
  await observer.stop().catch(()=>{});publishStatus(true);close();};

port.on('message',(message:unknown)=>{
  if(message==='start'){
    if(closing||started)return;started=true;observer.start();
    const heartbeat=Math.max(100,Math.min(1_000,Math.trunc(options.intervalMs/2)));
    statusTimer=setInterval(()=>publishStatus(),heartbeat);statusTimer.unref();publishStatus(true);return;
  }
  if(message==='stop'){void stop();return;}
  if(!message||typeof message!=='object')return;
  const value=message as Record<string,unknown>;
  if(value.type==='request-result'){
    const result=value as unknown as RequestResult,request=pending.get(result.requestId);if(!request)return;
    pending.delete(result.requestId);clearTimeout(request.timer);
    cooldownUntil=Math.max(cooldownUntil,safeCooldown(result.cooldownUntil));
    if(result.ok)request.resolve(result.value);
    else request.reject(new GmgnError(result.reason??'GMGN_REQUEST_FAILED',cooldownUntil||undefined));
    return;
  }
  if(value.type==='cooldown'){
    cooldownUntil=Math.max(cooldownUntil,safeCooldown(value.cooldownUntil));return;
  }
  if(value.type==='price-result'){
    const id=value.priceId;if(typeof id!=='number'||!Number.isSafeInteger(id)||id<=0)return;
    const price=pendingPrices.get(id);if(!price)return;
    pendingPrices.delete(id);clearTimeout(price.timer);
    if(value.accepted===true)price.resolve({accepted:true});
    else {const validReason=typeof value.reason==='string'&&['WALLET_PRICE_WRITE_QUEUE_FULL','WALLET_PRICE_WRITE_TIMEOUT',
        'WALLET_PRICE_WRITE_FAILED','WALLET_PRICE_WRITER_UNAVAILABLE','WALLET_PRICE_INPUT_INVALID'].includes(value.reason);
      price.resolve({accepted:false,reason:validReason?value.reason as WalletObserverPriceWriteResult['reason']:
        'WALLET_PRICE_WRITE_FAILED',retryable:value.retryable!==false});}
    return;
  }
  if(value.type==='feed'){
    const feedId=Number(value.feedId);
    if(!Number.isSafeInteger(feedId)||closing)return;
    try {const report=observer.observeFeed(value.page as GmgnFeedPage);
      port.postMessage({type:'feed-result',feedId,report});publishStatus(true);
    } catch {port.postMessage({type:'feed-result',feedId,persisted:false,retryable:true,error:'WALLET_OBSERVER_FEED_FAILED'});}
  }
});

port.postMessage({type:'ready',status:observer.getStatus() satisfies WalletObserverStatus});
