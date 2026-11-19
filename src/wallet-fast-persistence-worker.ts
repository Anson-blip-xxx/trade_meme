import {parentPort,workerData} from 'node:worker_threads';
import {existsSync} from 'node:fs';
import {WalletActivityStore} from './wallet-activity-store.js';
import {WalletHistory,type WalletTradeObservation} from './wallet-history.js';
import {LauncherCandidates,type LauncherCandidatesOptions} from './launcher-candidates.js';
import type {WalletActivity} from './wallet-activity.js';

interface Options {
  activityDatabase:string;activityMaxBytes:number;historyDatabase:string;historyMaxBytes:number;
  launcher?:Omit<LauncherCandidatesOptions,'now'>;
  launcherRetryMs?:number;
}
interface PersistMessage {type:'persist';id:number;result:WalletActivity}

const options=workerData as Options;
let activity:WalletActivityStore|undefined,history:WalletHistory|undefined,launcher:LauncherCandidates|undefined;
let launcherRetryAt=0,working=false,stopping=false;
const launcherRetryMs=options.launcherRetryMs??30_000;

const activityStatus=()=>{try{return activity?.status();}catch{return undefined;}};
const ensureLauncher=():LauncherCandidates|undefined=>{
  if(launcher||!options.launcher||Date.now()<launcherRetryAt)return launcher;
  try {launcher=new LauncherCandidates(options.launcher);launcherRetryAt=0;}
  catch {launcherRetryAt=Date.now()+launcherRetryMs;}
  return launcher;
};
const close=()=>{
  try{launcher?.close();}catch{}try{history?.close();}catch{}try{activity?.close();}catch{}
  launcher=undefined;history=undefined;activity=undefined;parentPort!.close();
};
const trades=(result:WalletActivity):WalletTradeObservation[]=>
  result.eventAt&&['buy','sell'].includes(result.classification)?result.trades.filter(trade=>trade.side===result.classification)
    .map(trade=>({chain:result.chain,wallet:result.wallet,txHash:result.txHash,tokenAddress:trade.tokenAddress,side:trade.side,
      amount:trade.amountAtomic,amountUnit:'atomic',eventAt:result.eventAt!,observedAt:result.checkedAt,source:'chain_verified_swap'})):[];

const persist=(message:PersistMessage)=>{if(working||stopping)return;working=true;const started=performance.now();
  let archived=false,launcherChanged=false,historyChanged=false,tradeRequired=false,tradeStored=true,historyRejected=false,failures=0,
    historyRetractionFailed=false,launcherRetractionFailed=false;
  try {
    try {archived=activity!.record(message.result);}catch{failures++;}
    if(message.result.classification==='retracted'){
      try {historyChanged=history!.retractVerifiedTrade({chain:message.result.chain,wallet:message.result.wallet,
        txHash:message.result.txHash,checkedAt:message.result.checkedAt});}catch{failures++;historyRetractionFailed=true;}
      if(options.launcher)try {const store=ensureLauncher();
        // If the candidate database has never existed, there is no launcher
        // state to retract (this also keeps isolated research probes usable
        // before the profile service is started). An existing database is
        // potentially authoritative, so inability to open it remains fail-closed.
        if(!store&&options.launcher.database!==':memory:'&&existsSync(options.launcher.database)){
          failures++;launcherRetractionFailed=true;
        } else if(store)launcherChanged=store.retractActivity({chain:message.result.chain,wallet:message.result.wallet,
          txHash:message.result.txHash,checkedAt:message.result.checkedAt})===true;
      }catch{failures++;launcherRetractionFailed=true;}
    } else if(message.result.eventAt){
      try {launcherChanged=ensureLauncher()?.observeActivity(message.result)===true;}catch{failures++;}
      if(['buy','sell'].includes(message.result.classification)&&['included','confirmed'].includes(message.result.confirmation)){
        const observations=trades(message.result);tradeRequired=observations.length>0;
        if(tradeRequired)try {tradeStored=history!.recordTradesDurable(observations);historyRejected=!tradeStored;}
        catch{tradeStored=false;failures++;}
      }
    }
    // Preserve the old durability boundary: one classification archive (or a
    // derived retraction/candidate write) must succeed, and verified trade
    // history must also accept the matching observations before signal dispatch.
    // A retraction ACK means the classification archive is durable and every
    // configured derived store completed without an exception. A false
    // retraction result is an idempotent no-match, while an exception leaves
    // the prior fact uncertain and must be retried.
    const persisted=message.result.classification==='retracted'?
      archived&&!historyRetractionFailed&&!launcherRetractionFailed:
      (archived||launcherChanged||historyChanged)&&(!tradeRequired||tradeStored);
    const status=activityStatus(),capacity=status?.error==='WALLET_ACTIVITY_CAPACITY_REACHED';
    const launcherRetryAfterMs=launcherRetractionFailed&&launcherRetryAt>Date.now()?launcherRetryAt-Date.now():undefined;
    parentPort!.postMessage({type:'result',id:message.id,persisted,elapsedMs:performance.now()-started,status,launcherReady:!!launcher,
      ...(!persisted&&historyRejected?{error:'WALLET_FAST_PERSISTENCE_HISTORY_REJECTED',retryable:false}:{}),
      ...(!persisted&&!historyRejected&&failures?{error:capacity?'WALLET_FAST_PERSISTENCE_CAPACITY':'WALLET_FAST_PERSISTENCE_WRITE_FAILED',retryable:!capacity,
        ...(launcherRetryAfterMs!==undefined?{retryAfterMs:launcherRetryAfterMs}:{})}:{}),
      ...(!persisted&&!historyRejected&&!failures?{error:'WALLET_FAST_PERSISTENCE_REJECTED',retryable:false}:{})});
  } catch {
    parentPort!.postMessage({type:'result',id:message.id,persisted:false,elapsedMs:performance.now()-started,
      status:activityStatus(),launcherReady:!!launcher,error:'WALLET_FAST_PERSISTENCE_WRITE_FAILED',retryable:true});
  } finally {working=false;if(stopping)close();}
};

try {
  activity=new WalletActivityStore(options.activityDatabase,options.activityMaxBytes);
  history=new WalletHistory(options.historyDatabase,{maxBytes:options.historyMaxBytes});
  ensureLauncher();
  parentPort!.on('message',(message:PersistMessage|'stop')=>{
    if(message==='stop'){stopping=true;if(!working)close();return;}
    if(message?.type==='persist')persist(message);
  });
  parentPort!.postMessage({type:'ready',status:activityStatus(),launcherReady:!!launcher});
} catch {
  try{history?.close();}catch{}try{activity?.close();}catch{}
  parentPort!.postMessage({type:'fatal',error:'WALLET_FAST_PERSISTENCE_STORE_OPEN_FAILED'});parentPort!.close();
}
