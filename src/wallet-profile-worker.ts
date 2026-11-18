import {parentPort,workerData} from 'node:worker_threads';
import {WalletProfiles} from './wallet-profiles.js';

// Only normalized local evidence is available to this worker; it has no API
// credentials and never submits transactions or requests vendor pages.
const {intervalSec,batchSize,livePriority:initialLivePriority,fastTargetLimits,...options}=workerData;
const engine=new WalletProfiles({...options,cohortMaxAgeSec:Math.max(120,intervalSec*3)});
let stopping=false,livePriority=initialLivePriority===true,timer:ReturnType<typeof setTimeout>|undefined,lastCohortRevision='',
  fastTargetsAt=0,fastTargets:ReturnType<WalletProfiles['fastWalletTargets']>={},fastTargetRevision='';
const publishFastTargets=(force=false)=>{
  try {if(force||Date.now()-fastTargetsAt>=300_000){fastTargets=engine.fastWalletTargets(fastTargetLimits);fastTargetsAt=Date.now();}
    parentPort!.postMessage({type:'fast-targets',targets:fastTargets,computedAt:new Date(fastTargetsAt).toISOString()});}
  catch {parentPort!.postMessage({type:'fast-targets-failed'});}
};
const schedule=(delay=intervalSec*1000)=>{
  clearTimeout(timer);timer=undefined;
  if(!stopping)timer=setTimeout(()=>{timer=undefined;run();},delay);
};
const run=()=>{
  if(stopping)return;
  parentPort!.postMessage({type:'working'});
  try {const status=engine.runBatch(livePriority?1:batchSize),profitCohorts=engine.profitCohorts();
    const revision=Object.values(profitCohorts).map(item=>item?.asOf??'').join('|'),changed=revision!==lastCohortRevision;
    if(changed)lastCohortRevision=revision;
    const targetRevision=`${status.profiles}|${JSON.stringify(status.groupCounts)}`,targetsChanged=targetRevision!==fastTargetRevision;
    fastTargetRevision=targetRevision;publishFastTargets(targetsChanged);parentPort!.postMessage({type:'status',status,...(changed?{profitCohorts}:{})});}
  catch {parentPort!.postMessage({type:'failed',error:'WALLET_PROFILE_REFRESH_FAILED'});}
  schedule();
};
parentPort!.on('message',message=>{
  if(message==='stop'){
    stopping=true;clearTimeout(timer);timer=undefined;engine.close();parentPort!.close();return;
  }
  if(message?.type==='live-priority'&&typeof message.active==='boolean'){
    if(livePriority===message.active){parentPort!.postMessage({type:'priority',livePriority});return;}
    livePriority=message.active;clearTimeout(timer);timer=undefined;
    parentPort!.postMessage({type:'priority',livePriority});
    schedule(livePriority?intervalSec*1000:0);
    return;
  }
  if(message?.type==='fast-metadata'&&Number.isSafeInteger(message.id)&&Array.isArray(message.targets)){
    try {parentPort!.postMessage({type:'fast-metadata',id:message.id,items:engine.fastWalletMetadata(message.targets)});}
    catch {parentPort!.postMessage({type:'fast-metadata-failed',id:message.id});}
  }
});
parentPort!.postMessage({type:'priority',livePriority});
publishFastTargets(true);
if(livePriority)schedule();else run();
