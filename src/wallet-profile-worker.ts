import {parentPort,workerData} from 'node:worker_threads';
import {WalletProfiles} from './wallet-profiles.js';

// Only normalized local evidence is available to this worker; it has no API
// credentials and never submits transactions or requests vendor pages.
const {intervalSec,batchSize,livePriority:initialLivePriority,...options}=workerData;
const engine=new WalletProfiles({...options,cohortMaxAgeSec:Math.max(120,intervalSec*3)});
let stopping=false,livePriority=initialLivePriority===true,timer:ReturnType<typeof setTimeout>|undefined,lastCohortRevision='';
const schedule=(delay=intervalSec*1000)=>{
  clearTimeout(timer);timer=undefined;
  if(!stopping&&!livePriority)timer=setTimeout(()=>{timer=undefined;run();},delay);
};
const run=()=>{
  if(stopping||livePriority)return;
  parentPort!.postMessage({type:'working'});
  try {const status=engine.runBatch(batchSize),profitCohorts=engine.profitCohorts();
    const revision=Object.values(profitCohorts).map(item=>item?.asOf??'').join('|'),changed=revision!==lastCohortRevision;
    if(changed)lastCohortRevision=revision;parentPort!.postMessage({type:'status',status,...(changed?{profitCohorts}:{})});}
  catch {parentPort!.postMessage({type:'failed',error:'WALLET_PROFILE_REFRESH_FAILED'});}
  schedule();
};
parentPort!.on('message',message=>{
  if(message==='stop'){
    stopping=true;clearTimeout(timer);timer=undefined;engine.close();parentPort!.close();return;
  }
  if(message?.type==='live-priority'&&typeof message.active==='boolean'){
    livePriority=message.active;clearTimeout(timer);timer=undefined;
    parentPort!.postMessage({type:'priority',livePriority});
    if(!livePriority)schedule(0);
  }
});
parentPort!.postMessage({type:'priority',livePriority});
if(!livePriority)run();
