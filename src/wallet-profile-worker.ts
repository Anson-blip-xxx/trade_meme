import {parentPort,workerData} from 'node:worker_threads';
import {WalletProfiles} from './wallet-profiles.js';

// Only normalized local evidence is available to this worker; it has no API
// credentials and never submits transactions or requests vendor pages.
const {intervalSec,batchSize,...options}=workerData;
const engine=new WalletProfiles({...options,cohortMaxAgeSec:Math.max(120,intervalSec*3)});
let stopping=false,timer:ReturnType<typeof setTimeout>|undefined,lastCohortRevision='';
const run=()=>{
  if(stopping)return;
  parentPort!.postMessage({type:'working'});
  try {const status=engine.runBatch(batchSize),profitCohorts=engine.profitCohorts();
    const revision=Object.values(profitCohorts).map(item=>item?.asOf??'').join('|'),changed=revision!==lastCohortRevision;
    if(changed)lastCohortRevision=revision;parentPort!.postMessage({type:'status',status,...(changed?{profitCohorts}:{})});}
  catch {parentPort!.postMessage({type:'failed',error:'WALLET_PROFILE_REFRESH_FAILED'});}
  if(!stopping)timer=setTimeout(run,intervalSec*1000);
};
parentPort!.on('message',message=>{
  if(message!=='stop')return;
  stopping=true;clearTimeout(timer);engine.close();parentPort!.close();
});
run();
