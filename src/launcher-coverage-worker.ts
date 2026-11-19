import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {LauncherCandidates,type LauncherCandidatesOptions} from './launcher-candidates.js';
import type {LauncherCoverageWorkItem} from './launcher-coverage-writer.js';

interface BatchMessage {type:'batch';batchId:number;items:LauncherCoverageWorkItem[]}

let store:LauncherCandidates;
try {store=new LauncherCandidates(workerData as LauncherCandidatesOptions);}
catch {throw new Error('LAUNCHER_COVERAGE_STORE_OPEN_FAILED');}
let stopping=false,working=false,closed=false;
const close=()=>{if(closed)return;closed=true;store.close();parentPort!.close();};

const run=(message:BatchMessage)=>{if(working||stopping)return;working=true;const started=performance.now();
  try {const result=store.replaceCoverageBatchResult(message.items.map(({chain,wallets,at})=>({chain,wallets,at})));
    parentPort!.postMessage(result.capacityReached?
      {type:'result',batchId:message.batchId,completed:0,elapsedMs:performance.now()-started,
        error:'LAUNCHER_COVERAGE_CAPACITY_REACHED',retryable:true}:
      {type:'result',batchId:message.batchId,completed:message.items.length,elapsedMs:performance.now()-started});}
  catch {parentPort!.postMessage({type:'result',batchId:message.batchId,completed:0,elapsedMs:performance.now()-started,
    error:'LAUNCHER_COVERAGE_WRITE_FAILED',retryable:true});}
  finally {working=false;if(stopping)close();}
};

parentPort!.on('message',message=>{if(message==='stop'){stopping=true;if(!working)close();return;}
  if(message?.type==='batch')run(message as BatchMessage);});
parentPort!.postMessage({type:'ready'});
