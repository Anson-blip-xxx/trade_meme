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

// Wallet history is append-only: evidence rows are never deleted or rewritten.
// Its ordinary rowids are therefore contiguous durable high-water marks.  Do
// not COUNT the multi-gigabyte JSON tables whenever an unrelated derived row
// changes; max(rowid) is an indexed lookup and remains the exact row count.
const appendOnlyCount=(table:string)=>Number(db.prepare(`SELECT COALESCE(max(rowid),0) AS n FROM ${table}`).get()!.n);
const OBSERVATION_KINDS=['holding','stats','token_trader','token_rank','collection','vendor_nomination'] as const;
const observationCounts=new Map<string,number>();
let observationCursor=-1;
const refreshObservationCounts=(cursor:number)=>{
  if(observationCursor<0||cursor<observationCursor){
    observationCounts.clear();observationCursor=0;
  }
  if(cursor===observationCursor)return;
  const count=db.prepare(`SELECT count(*) AS n FROM wh_observations INDEXED BY wh_observations_kind
    WHERE kind=? AND rowid>? AND rowid<=?`);
  for(const kind of OBSERVATION_KINDS)
    observationCounts.set(kind,(observationCounts.get(kind)??0)+Number(count.get(kind,observationCursor,cursor)!.n));
  observationCursor=cursor;
};
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
  const wallets=appendOnlyCount('wh_wallets'),events=appendOnlyCount('wh_events'),observations=appendOnlyCount('wh_observations'),
    tokens=appendOnlyCount('wh_tokens'),prices=appendOnlyCount('wh_prices'),fundingLinks=appendOnlyCount('wh_funding');
  refreshObservationCounts(observations);
  // last_at has a covering index. first_at is a narrow 181k-row projection in
  // production; keeping it separate avoids loading profile JSON or the other
  // evidence tables. It is allowed to move earlier on a late observation.
  const first=db.prepare('SELECT first_at FROM wh_wallets ORDER BY first_at LIMIT 1').get()?.first_at,
    last=db.prepare('SELECT last_at FROM wh_wallets INDEXED BY wh_wallets_recent ORDER BY last_at DESC LIMIT 1').get()?.last_at;
  // Every unchecked row is dirty today, but retain the exact historical
  // semantics without the old OR plan that scanned all wh_metrics rows.
  const dirty=Number(db.prepare('SELECT count(*) AS n FROM wh_metrics WHERE coordination_dirty=1').get()!.n),
    uncheckedClean=Number(db.prepare('SELECT count(*) AS n FROM wh_metrics WHERE coordination_dirty=0 AND coordination_checked_at IS NULL').get()!.n);
  const usedBytes=bytes(),persistedError=String(db.prepare("SELECT value FROM wh_meta WHERE key='error'").get()?.value??'')||undefined;
  const error=persistedError??(usedBytes>=options.maxBytes?'WALLET_HISTORY_CAPACITY_REACHED':undefined);
  return {wallets,events,observations,tokens,prices,
    snapshots:['holding','stats','token_trader','token_rank'].reduce((sum,kind)=>sum+(observationCounts.get(kind)??0),0),fundingLinks,
    collections:observationCounts.get('collection')??0,nominations:observationCounts.get('vendor_nomination')??0,
    coordinationPending:dirty+uncheckedClean,
    firstObservedAt:first?String(first):undefined,lastObservedAt:last?String(last):undefined,
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
