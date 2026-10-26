import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {WalletHistory} from './wallet-history.js';

interface Options {
  database:string;
  maxBytes:number;
  intervalMs:number;
  coordinationQuota:number;
  associationQuota:number;
}

const options=workerData as Options;
const history=new WalletHistory(options.database,{maxBytes:options.maxBytes});
let stopping=false,timer:ReturnType<typeof setTimeout>|undefined;

const elapsed=(started:number)=>Math.max(0,Math.round(performance.now()-started));
const run=async()=>{
  if(stopping)return;
  const attemptedAt=new Date().toISOString();
  parentPort!.postMessage({type:'working',at:attemptedAt});

  let coordinationError:string|undefined,associationError:string|undefined;
  let coordinationMs=0,associationMs=0;
  for(let index=0;index<options.coordinationQuota;index++){
    const started=performance.now();
    try {history.refreshCoordination(1);}
    catch {coordinationError='WALLET_COORDINATION_REFRESH_FAILED';}
    coordinationMs=elapsed(started);
  }

  // Give stop messages a boundary between the two independent maintenance jobs.
  await new Promise<void>(resolve=>setImmediate(resolve));
  if(stopping)return;
  for(let index=0;index<options.associationQuota;index++){
    const started=performance.now();
    try {history.refreshAssociations(1);}
    catch {associationError='WALLET_ASSOCIATION_REFRESH_FAILED';}
    associationMs=elapsed(started);
  }

  parentPort!.postMessage({type:'status',status:{coordinationMs,associationMs,coordinationError,associationError,
    completedAt:new Date().toISOString()}});
  if(!stopping)timer=setTimeout(()=>void run(),options.intervalMs);
};

parentPort!.on('message',message=>{
  if(message!=='stop')return;
  stopping=true;clearTimeout(timer);history.close();parentPort!.close();
});

void run();
