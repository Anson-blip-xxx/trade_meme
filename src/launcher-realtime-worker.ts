import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {LauncherCandidates,type LauncherCandidatesOptions,type LauncherRealtimeObservation} from './launcher-candidates.js';
import type {Chain} from './types.js';

interface Options extends Omit<LauncherCandidatesOptions,'now'> {
  targetLimits:Partial<Record<Chain,number>>;
}
interface BatchMessage {type:'batch';batchId:number;items:LauncherRealtimeObservation[]}

const CHAINS:readonly Chain[]=['bsc','solana','robinhood'];
const options=workerData as Options;
let store:LauncherCandidates;
let stopping=false,working=false,closed=false;

const close=()=>{if(closed)return;closed=true;store.close();parentPort!.close();};
const publishTargets=()=>{
  if(stopping)return;
  try {
    const chains:Partial<Record<Chain,{targets:string[];membership:string[]}>>={};
    for(const chain of CHAINS){const limit=options.targetLimits[chain];if(!limit)continue;
      chains[chain]={targets:store.streamTargets(chain,limit),membership:store.addresses(chain)};}
    parentPort!.postMessage({type:'targets',chains,computedAt:new Date().toISOString()});
  } catch {parentPort!.postMessage({type:'targets-failed',error:'LAUNCHER_REALTIME_TARGET_READ_FAILED'});}
};
const run=(message:BatchMessage)=>{if(working||stopping)return;working=true;const started=performance.now();
  try {const {changed,capacityReached}=store.observeRealtimeBatchResult(message.items);
    parentPort!.postMessage({type:'result',batchId:message.batchId,completed:capacityReached?0:message.items.length,changed,
      elapsedMs:performance.now()-started,...(capacityReached?{error:'LAUNCHER_REALTIME_CAPACITY_REACHED',retryable:false}:{})});}
  catch {parentPort!.postMessage({type:'result',batchId:message.batchId,completed:0,changed:0,
    elapsedMs:performance.now()-started,error:'LAUNCHER_REALTIME_WRITE_FAILED'});}
  finally {working=false;if(stopping)close();}
};

try {
  store=new LauncherCandidates(options);
  parentPort!.on('message',(message:BatchMessage|{type:'targets'}|'stop')=>{
    if(message==='stop'){stopping=true;if(!working)close();return;}
    if(!message||typeof message!=='object')return;
    if(message.type==='batch')run(message);
    else if(message.type==='targets')publishTargets();
  });
  parentPort!.postMessage({type:'ready'});publishTargets();
} catch {
  parentPort!.postMessage({type:'fatal',error:'LAUNCHER_REALTIME_STORE_OPEN_FAILED'});
  parentPort!.close();
}
