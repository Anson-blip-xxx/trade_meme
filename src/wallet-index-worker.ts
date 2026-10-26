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
  livePriority:boolean;
}

const options=workerData as Options;
const history=new WalletHistory(options.database,{maxBytes:options.maxBytes});
let stopping=false,timer:ReturnType<typeof setTimeout>|undefined,livePriority=options.livePriority===true;
let work:Promise<void>|undefined,closed=false;
const ASSOCIATION_STATS_INTERVAL_MS=120_000;
const INVALIDATION_CYCLE_BUDGET_MS=2_000,INVALIDATION_MAX_BATCHES=192;
const COORDINATION_CYCLE_BUDGET_MS=1_000,ASSOCIATION_CYCLE_BUDGET_MS=2_000;
const LIVE_INVALIDATION_CYCLE_BUDGET_MS=250,LIVE_INVALIDATION_MAX_BATCHES=24;
const LIVE_COORDINATION_CYCLE_BUDGET_MS=250,LIVE_ASSOCIATION_CYCLE_BUDGET_MS=500;
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
  const invalidationStarted=performance.now(),invalidationDeadline=invalidationStarted+
    (livePriority?LIVE_INVALIDATION_CYCLE_BUDGET_MS:INVALIDATION_CYCLE_BUDGET_MS);
  for(let index=0;index<(livePriority?LIVE_INVALIDATION_MAX_BATCHES:INVALIDATION_MAX_BATCHES)&&
    !stopping&&performance.now()<invalidationDeadline;index++){
    const started=performance.now();
    // Work to a bounded wall-clock budget with a separate batch ceiling. Idle
    // mode drains bursts quickly; live counting shortens the budget. Every
    // 128-item transaction still releases SQLite's writer lock and yields.
    try {const result=history.flushAssociationInvalidations(128);invalidationProcessed+=result.touched;
      invalidationMs+=elapsed(started);if(!result.remaining)break;}
    catch {invalidationError='WALLET_ASSOCIATION_INVALIDATION_FAILED';break;}
    await new Promise<void>(resolve=>setTimeout(resolve,5));
    if(performance.now()>=invalidationStarted+(livePriority?LIVE_INVALIDATION_CYCLE_BUDGET_MS:INVALIDATION_CYCLE_BUDGET_MS))break;
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
    schedule(walletIndexNextDelay(options.intervalMs,{invalidationPending,processed:invalidationProcessed,livePriority}));return;
  }
  // Small transactions run until a wall-clock budget expires. Wallet degrees
  // vary by orders of magnitude, so a large fixed row quota can otherwise turn
  // one maintenance pass into a tens-of-seconds database burst.
  let started=performance.now();
  try {const deadline=started+(livePriority?LIVE_COORDINATION_CYCLE_BUDGET_MS:COORDINATION_CYCLE_BUDGET_MS);for(;;){
    const count=history.refreshCoordination(options.coordinationQuota,false);coordinationProcessed+=count;
    if(count<options.coordinationQuota||performance.now()>=deadline||
      livePriority&&performance.now()>=started+LIVE_COORDINATION_CYCLE_BUDGET_MS)break;
    await new Promise<void>(resolve=>setImmediate(resolve));if(stopping)return;
  }}
  catch {coordinationError='WALLET_COORDINATION_REFRESH_FAILED';}
  coordinationMs=elapsed(started);

  // Give stop messages a boundary between the two independent maintenance jobs.
  await new Promise<void>(resolve=>setImmediate(resolve));
  if(stopping)return;
  started=performance.now();
  try {const deadline=started+(livePriority?LIVE_ASSOCIATION_CYCLE_BUDGET_MS:ASSOCIATION_CYCLE_BUDGET_MS);for(;;){
    const count=history.refreshAssociations(options.associationQuota,false);associationProcessed+=count;
    if(count===0||performance.now()>=deadline||
      livePriority&&performance.now()>=started+LIVE_ASSOCIATION_CYCLE_BUDGET_MS)break;
    await new Promise<void>(resolve=>setImmediate(resolve));if(stopping)return;
  }}
  catch {associationError='WALLET_ASSOCIATION_REFRESH_FAILED';}
  associationMs=elapsed(started);

  // Exact relationship totals scan large derived indexes. Compute them here,
  // never in the dashboard request loop, and retain the previous parent-side
  // snapshot if a transient database error interrupts this refresh.
  await new Promise<void>(resolve=>setImmediate(resolve));
  if(stopping)return;
  if(!livePriority&&(!associationStats||Date.now()-associationStatsAt>=ASSOCIATION_STATS_INTERVAL_MS)){
    const started=performance.now();
    try {associationStats=history.associationStats();associationStatsAt=Date.now();associationStatsMs=elapsed(started);}
    catch {associationError='WALLET_ASSOCIATION_REFRESH_FAILED';}
  }

  parentPort!.postMessage({type:'status',status:{invalidationMs,invalidationProcessed,invalidationPending,invalidationError,
    coordinationMs,coordinationProcessed,associationMs,associationProcessed,associationStats,associationStatsMs,
    ...(associationStatsAt?{associationStatsRefreshedAt:new Date(associationStatsAt).toISOString()}:{}),coordinationError,associationError,
    completedAt:new Date().toISOString()}});
  const processed=invalidationProcessed+coordinationProcessed+associationProcessed;
  // One final short cycle proves the queue is empty before returning to the
  // normal cadence; live counting uses a longer catch-up delay.
  const derivedPending=coordinationProcessed>0||associationProcessed>0;
  schedule(walletIndexNextDelay(options.intervalMs,{invalidationPending,processed,derivedPending,livePriority}));
};

parentPort!.on('message',message=>{
  if(message&&typeof message==='object'&&message.type==='live-priority'&&typeof message.active==='boolean'){
    livePriority=message.active;parentPort!.postMessage({type:'priority',livePriority});return;
  }
  if(message==='stop'){stopping=true;clearTimeout(timer);if(!work)close();}
});

parentPort!.postMessage({type:'priority',livePriority});
start();
