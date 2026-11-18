import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {LauncherCandidates,type LauncherCandidateStatus,type LauncherCandidatesOptions} from './launcher-candidates.js';

interface WorkerOptions extends Omit<LauncherCandidatesOptions,'now'> {testDelayMs?:number;}
type RefreshMessage={type:'refresh';id:number};

const options=workerData as WorkerOptions;
let store:LauncherCandidates|undefined,stopping=false,working=false,closed=false;

const close=()=>{
  if(closed)return;closed=true;
  try{store?.close();}catch{/* The worker is already leaving; never expose database errors. */}
  parentPort!.close();
};
const failed=(id:number,code:string)=>parentPort!.postMessage({type:'failed',id,error:code});

async function refresh(message:RefreshMessage):Promise<void> {
  if(stopping||working||!store)return;
  working=true;const started=performance.now();
  parentPort!.postMessage({type:'working',id:message.id,at:new Date().toISOString()});
  try {
    if(options.testDelayMs)await new Promise<void>(resolve=>setTimeout(resolve,options.testDelayMs));
    if(stopping)return;
    const status:LauncherCandidateStatus=store.refresh();
    if(!stopping)parentPort!.postMessage({type:'status',id:message.id,status,
      durationMs:Math.max(0,Math.round(performance.now()-started)),completedAt:new Date().toISOString()});
  } catch {if(!stopping)failed(message.id,'LAUNCHER_CANDIDATE_REFRESH_FAILED');}
  finally {working=false;if(stopping)close();}
}

try {
  store=new LauncherCandidates(options);
  parentPort!.on('message',(message:RefreshMessage|'stop')=>{
    if(message==='stop'){stopping=true;if(!working)close();return;}
    if(!message||message.type!=='refresh'||!Number.isSafeInteger(message.id)||message.id<1)return;
    // The parent sends at most one request at a time. This guard also protects
    // the database if a malformed caller posts duplicate work directly.
    if(!working)void refresh(message);
  });
  parentPort!.postMessage({type:'ready'});
} catch {
  parentPort!.postMessage({type:'fatal',error:'LAUNCHER_CANDIDATE_WORKER_INIT_FAILED'});
  close();
}
