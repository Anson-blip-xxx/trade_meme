import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {WalletHistory} from './wallet-history.js';
import {walletIndexNextDelay} from './wallet-index-policy.js';

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
let work:Promise<void>|undefined,closed=false;
const ASSOCIATION_STATS_INTERVAL_MS=120_000;
let associationStats:ReturnType<WalletHistory['associationStats']>|undefined,associationStatsAt=0,associationStatsMs=0;

const close=()=>{if(closed)return;closed=true;history.close();parentPort!.close();};
const schedule=(delay:number)=>{if(stopping)return;timer=setTimeout(start,delay);};
const start=()=>{if(stopping||work)return;work=run().finally(()=>{work=undefined;if(stopping)close();});};

const elapsed=(started:number)=>Math.max(0,Math.round(performance.now()-started));
const run=async()=>{
  if(stopping)return;
  const attemptedAt=new Date().toISOString();
  parentPort!.postMessage({type:'working',at:attemptedAt});

  let invalidationError:string|undefined,coordinationError:string|undefined,associationError:string|undefined;
  let invalidationMs=0,invalidationProcessed=0,coordinationMs=0,coordinationProcessed=0,associationMs=0,associationProcessed=0;
  // Short transactions release SQLite's single writer lock between batches,
  // giving live evidence capture a chance to commit without a long busy wait.
  for(let index=0;index<16&&!stopping;index++){
    const started=performance.now();
    try {const result=history.flushAssociationInvalidations(64);invalidationProcessed+=result.touched;
      invalidationMs+=elapsed(started);if(!result.remaining)break;}
    catch {invalidationError='WALLET_ASSOCIATION_INVALIDATION_FAILED';break;}
    await new Promise<void>(resolve=>setTimeout(resolve,5));
  }
  const invalidationPending=history.associationInvalidationStatus().pending;
  await new Promise<void>(resolve=>setImmediate(resolve));
  if(stopping)return;
  // Never refresh a subset of derived rows while another invalidation stage is
  // still durable. This keeps every previously touched row stale until the
  // whole coalesced queue has drained.
  if(invalidationPending>0) {
    parentPort!.postMessage({type:'status',status:{invalidationMs,invalidationProcessed,invalidationPending,invalidationError,
      coordinationMs,coordinationProcessed,associationMs,associationProcessed,coordinationError,associationError,completedAt:new Date().toISOString()}});
    schedule(walletIndexNextDelay(options.intervalMs,{invalidationPending,processed:invalidationProcessed}));return;
  }
  // Commit the complete quota together. The former one-row loop repeatedly
  // checkpointed the same large wallet indexes during every worker cycle.
  let started=performance.now();
  try {coordinationProcessed=history.refreshCoordination(options.coordinationQuota,false);}
  catch {coordinationError='WALLET_COORDINATION_REFRESH_FAILED';}
  coordinationMs=elapsed(started);

  // Give stop messages a boundary between the two independent maintenance jobs.
  await new Promise<void>(resolve=>setImmediate(resolve));
  if(stopping)return;
  started=performance.now();
  try {associationProcessed=history.refreshAssociations(options.associationQuota,false);}
  catch {associationError='WALLET_ASSOCIATION_REFRESH_FAILED';}
  associationMs=elapsed(started);

  // Exact relationship totals scan large derived indexes. Compute them here,
  // never in the dashboard request loop, and retain the previous parent-side
  // snapshot if a transient database error interrupts this refresh.
  if(!associationStats||Date.now()-associationStatsAt>=ASSOCIATION_STATS_INTERVAL_MS){
    const started=performance.now();
    try {associationStats=history.associationStats();associationStatsAt=Date.now();associationStatsMs=elapsed(started);}
    catch {associationError='WALLET_ASSOCIATION_REFRESH_FAILED';}
  }

  parentPort!.postMessage({type:'status',status:{invalidationMs,invalidationProcessed,invalidationPending,invalidationError,
    coordinationMs,coordinationProcessed,associationMs,associationProcessed,associationStats,associationStatsMs,
    ...(associationStatsAt?{associationStatsRefreshedAt:new Date(associationStatsAt).toISOString()}:{}),coordinationError,associationError,
    completedAt:new Date().toISOString()}});
  const processed=invalidationProcessed+coordinationProcessed+associationProcessed;
  schedule(walletIndexNextDelay(options.intervalMs,{invalidationPending,processed}));
};

parentPort!.on('message',message=>{
  if(message!=='stop')return;
  stopping=true;clearTimeout(timer);if(!work)close();
});

start();
