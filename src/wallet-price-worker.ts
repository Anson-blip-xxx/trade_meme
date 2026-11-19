import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {WalletHistory} from './wallet-history.js';
import type {WalletPriceWorkItem} from './wallet-price-writer.js';

interface Options {database:string;maxBytes:number;buyerBatchSize:number;}
interface BatchMessage {type:'batch';batchId:number;items:WalletPriceWorkItem[];}

const options=workerData as Options,history=new WalletHistory(options.database,{maxBytes:options.maxBytes});
let stopping=false,projecting=false,projectionRequested=false,closed=false,
  projectionTimer:ReturnType<typeof setTimeout>|undefined,projectionImmediate:ReturnType<typeof setImmediate>|undefined;
const cancelProjection=()=>{clearTimeout(projectionTimer);clearImmediate(projectionImmediate);
  projectionTimer=undefined;projectionImmediate=undefined;};
const close=()=>{if(closed)return;closed=true;cancelProjection();
  history.close();parentPort!.close();};

const scheduleProjection=(delay=0)=>{
  if(stopping)return;
  // Admission can race the asynchronous recovery slice after it has counted
  // pending jobs but before it publishes that count. Remember that edge so the
  // newly admitted job cannot remain stranded until another quote arrives.
  if(projecting){projectionRequested=true;return;}
  if(projectionTimer||projectionImmediate)return;
  if(delay>0)projectionTimer=setTimeout(()=>{projectionTimer=undefined;void project();},delay);
  else projectionImmediate=setImmediate(()=>{projectionImmediate=undefined;void project();});
  // Keep the worker alive until durable projection work reaches an idle state.
  // An unref'ed final immediate can otherwise be skipped when no further quote
  // message arrives, leaving the last acknowledged job stranded.
};

const project=async()=>{
  if(stopping||projecting)return;
  projecting=true;projectionRequested=false;const started=performance.now();let nextDelay:number|undefined;
  try {
    const result=await history.recoverPriceProjectionJobs({batchSize:options.buyerBatchSize,maxJobs:8,maxBatches:8,
      shouldContinue:()=>!stopping,yieldBetweenBatches:()=>new Promise<void>(resolve=>setImmediate(resolve))});
    parentPort!.postMessage({type:'projection',elapsedMs:Math.max(0,performance.now()-started),...result});
    if(stopping)return;
    if(result.capacityReached){parentPort!.postMessage({type:'recovery_wait',reason:'WALLET_PRICE_RECOVERY_CAPACITY',pendingJobs:result.pendingJobs});
      nextDelay=1_000;}
    else if(result.pending)nextDelay=0;
    else parentPort!.postMessage({type:'idle',pendingJobs:0});
  } catch {
    parentPort!.postMessage({type:'projection_error',reason:'WALLET_PRICE_PROJECTION_FAILED',pendingJobs:history.pendingPriceProjectionJobs()});
    if(!stopping)nextDelay=1_000;
  } finally {const requested=projectionRequested;projecting=false;projectionRequested=false;
    if(stopping)close();else if(requested)scheduleProjection();else if(nextDelay!==undefined)scheduleProjection(nextDelay);}
};

const admit=(message:BatchMessage)=>{
  const started=performance.now(),failed:{index:number;reason:string;retryable:boolean}[]=[];
  let completed=0,priceRowsStored=0,pendingAccepted=0;
  for(let index=0;index<message.items.length;index++){
    const item=message.items[index];
    try {
      const result=history.admitPriceProjection(item.target,item.priceUsd,item.observedAt,item.provider);
      if(!result.accepted)failed.push({index,reason:'WALLET_PRICE_INPUT_INVALID',retryable:false});
      else if(result.capacityReached)failed.push({index,reason:'WALLET_HISTORY_CAPACITY_REACHED',retryable:false});
      else {completed++;if(result.priceStored)priceRowsStored++;if(result.pending)pendingAccepted++;}
    } catch {failed.push({index,reason:'WALLET_PRICE_INGRESS_FAILED',retryable:true});}
  }
  const pendingJobs=history.pendingPriceProjectionJobs();
  parentPort!.postMessage({type:'ingress_result',batchId:message.batchId,completed,failed,priceRowsStored,pendingAccepted,pendingJobs,
    elapsedMs:Math.max(0,performance.now()-started)});
  if(pendingJobs)scheduleProjection();else parentPort!.postMessage({type:'idle',pendingJobs:0});
};

parentPort!.on('message',message=>{
  if(message==='stop'){stopping=true;cancelProjection();
    if(!projecting)close();return;}
  if(message?.type==='batch'){
    if(stopping){parentPort!.postMessage({type:'ingress_result',batchId:message.batchId,completed:0,priceRowsStored:0,
      pendingAccepted:0,pendingJobs:history.pendingPriceProjectionJobs(),elapsedMs:0,
      failed:(message.items as WalletPriceWorkItem[]).map((_:unknown,index:number)=>({index,reason:'WALLET_PRICE_WRITER_STOPPED',retryable:true}))});return;}
    admit(message as BatchMessage);
  }
});

const pendingJobs=history.pendingPriceProjectionJobs();
parentPort!.postMessage({type:'ready',pendingJobs});
if(pendingJobs)scheduleProjection();else parentPort!.postMessage({type:'idle',pendingJobs:0});
