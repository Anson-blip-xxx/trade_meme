import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {WalletSetupLedger} from './wallet-setup-ledger.js';
import type {WalletTradeObservation} from './wallet-history.js';

interface Options {database:string;historyDatabase:string;maxBytes:number}
interface RunMessage {type:'run';id:number;at:string}

const options=workerData as Options;
let clock=new Date();
// Outcomes are derived from immutable history rows and are retried from the
// durable setup registration after a crash, so NORMAL avoids an fsync per
// refresh batch without weakening source evidence or admission durability.
const ledger=new WalletSetupLedger(options.database,{maxBytes:options.maxBytes,now:()=>clock,synchronous:'normal'});
const history=new DatabaseSync(options.historyDatabase,{readOnly:true});
history.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
const evidence=history.prepare(`SELECT data FROM wh_observations INDEXED BY wh_exit_evidence
  WHERE chain=? AND token_address=? AND kind='trade' AND observed_at>=? AND observed_at<=?
  ORDER BY observed_at DESC LIMIT 501`);
let stopping=false,working=false;

const run=(message:RunMessage)=>{
  if(stopping||working)return;
  working=true;const started=performance.now();
  try {
    const at=new Date(message.at);if(!Number.isFinite(at.getTime()))throw new Error('WALLET_SCREENING_OBSERVATION_TIME_INVALID');
    clock=at;let processedTokens=0;
    for(const token of ledger.pending(10)){
      if(stopping)break;
      const end=at.toISOString(),start=new Date(at.getTime()-3_600_000).toISOString(),rows=evidence.all(token.chain,token.address,start,end);
      const trades=rows.slice(0,500).flatMap(row=>{try{return [JSON.parse(String(row.data)) as WalletTradeObservation];}catch{return [];}});
      ledger.observe(token,trades,at,{truncated:rows.length>500});processedTokens++;
    }
    parentPort!.postMessage({type:'result',id:message.id,ok:true,processedTokens,
      elapsedMs:performance.now()-started,completedAt:new Date().toISOString()});
  }catch{parentPort!.postMessage({type:'result',id:message.id,ok:false});}
  finally{working=false;if(stopping)close();}
};

const close=()=>{try{history.close();}catch{}try{ledger.close();}catch{}parentPort!.close();};
parentPort!.on('message',(message:RunMessage|{type:'stop'})=>{
  if(message?.type==='stop'){stopping=true;if(!working)close();return;}
  if(message?.type==='run'&&Number.isSafeInteger(message.id))run(message);
});
