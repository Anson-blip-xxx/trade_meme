import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {statSync} from 'node:fs';
import type {WalletHistoryStats} from './wallet-history.js';
import type {WalletResearchSeedStatus} from './wallet-research-seeds.js';

const options=workerData as {database:string;maxBytes:number;intervalMs:number};
const db=new DatabaseSync(options.database,{readOnly:true});
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
let stopping=false,timer:ReturnType<typeof setTimeout>|undefined;
let cached:WalletHistoryStats|undefined,cachedDataVersion=-1;

const count=(table:string,where='')=>Number(db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get()!.n);
const bytes=()=>{
  let total=0;
  for(const path of [options.database,`${options.database}-wal`,`${options.database}-shm`])try{total+=statSync(path).size;}catch{/* inactive WAL */}
  return total;
};
const seedStatus=():WalletResearchSeedStatus=>{
  const sources=db.prepare('SELECT * FROM wh_research_seed_sources').all().map(row=>({...JSON.parse(String(row.data)),importedAt:String(row.imported_at),
    addresses:Number(db.prepare('SELECT count(*) AS n FROM wh_research_seeds WHERE source_id=?').get(row.source_id!)!.n)}));
  const chains=(['bsc','robinhood'] as const).map(chain=>{
    const rows=db.prepare(`SELECT m.event_count,m.buy_count,m.sell_count,m.profit_usd,m.gain_pct FROM (SELECT DISTINCT address FROM wh_research_seeds) e
      CROSS JOIN wh_metrics m ON m.chain=? AND m.address=e.address`).all(chain);
    const last=db.prepare('SELECT * FROM wh_research_seed_checks WHERE chain=? ORDER BY checked_at DESC LIMIT 1').get(chain);
    return {chain,observedWallets:rows.length,withTrades:rows.filter(v=>Number(v.buy_count)+Number(v.sell_count)>0).length,
      withBuys:rows.filter(v=>Number(v.buy_count)>0).length,withVendorProfit:rows.filter(v=>v.profit_usd!==null).length,
      withSampledGain:rows.filter(v=>v.gain_pct!==null).length,
      checkedWallets:Number(db.prepare('SELECT count(*) AS n FROM wh_research_seed_checks WHERE chain=?').get(chain)!.n),
      ...(last?{lastCheckedAt:String(last.checked_at),lastResult:{status:String(last.status),accepted:Number(last.accepted),
        ...(last.reason?{reason:String(last.reason)}:{})}}:{})};
  });
  return {scope:'research_hint_only',verification:'unverified_external_list',ownershipProven:false,qualifiesAsSmart:false,
    totalAddresses:Number(db.prepare('SELECT count(DISTINCT address) AS n FROM wh_research_seeds').get()!.n),sources,chains,
    sampling:{maxRequestsPerTurn:1,minChainIntervalSec:1800,eligibleEveryChainTurns:4,withinExistingObserverBudget:true,robinhoodRequiresObservedTrades:true}};
};
const read=():WalletHistoryStats=>{
  const time=db.prepare('SELECT MIN(first_at) AS first,MAX(last_at) AS last FROM wh_wallets').get()!;
  const usedBytes=bytes(),persistedError=String(db.prepare("SELECT value FROM wh_meta WHERE key='error'").get()?.value??'')||undefined;
  const error=persistedError??(usedBytes>=options.maxBytes?'WALLET_HISTORY_CAPACITY_REACHED':undefined);
  return {wallets:count('wh_wallets'),events:count('wh_events'),observations:count('wh_observations'),tokens:count('wh_tokens'),prices:count('wh_prices'),
    snapshots:count('wh_observations',"WHERE kind IN ('holding','stats','token_trader','token_rank')"),fundingLinks:count('wh_funding'),
    collections:count('wh_observations',"WHERE kind='collection'"),nominations:count('wh_observations',"WHERE kind='vendor_nomination'"),
    coordinationPending:count('wh_metrics','WHERE coordination_dirty=1 OR coordination_checked_at IS NULL'),
    firstObservedAt:time.first?String(time.first):undefined,lastObservedAt:time.last?String(time.last):undefined,
    bytes:usedBytes,maxBytes:options.maxBytes,error,sampleOnly:true,exactRealizedPnl:false,researchSeeds:seedStatus()};
};
const run=()=>{
  if(stopping)return;
  const attemptedAt=new Date().toISOString();parentPort!.postMessage({type:'working',at:attemptedAt});
  try {
    const dataVersion=Number(db.prepare('PRAGMA data_version').get()!.data_version);
    const unchanged=cached&&dataVersion===cachedDataVersion,status=unchanged?cached!:read();
    const after=Number(db.prepare('PRAGMA data_version').get()!.data_version);
    cached=status;cachedDataVersion=dataVersion===after?after:-1;
    const computedAt=new Date().toISOString();parentPort!.postMessage({type:'status',status,computedAt});
  }
  catch {parentPort!.postMessage({type:'failed',at:attemptedAt});}
  if(!stopping)timer=setTimeout(run,options.intervalMs);
};
parentPort!.on('message',message=>{
  if(message!=='stop')return;
  stopping=true;clearTimeout(timer);db.close();parentPort!.close();
});
run();
