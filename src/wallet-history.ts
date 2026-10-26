import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {mkdirSync,chmodSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {WalletAssociations,type WalletAssociationListOptions,type WalletAssociationTarget} from './wallet-associations.js';
import {parseWalletObserverCursor,type WalletObserverCursorState} from './wallet-observer-state.js';
export type {WalletAssociationSummary,WalletAssociationDetail,WalletAssociationStats,WalletAssociationTarget} from './wallet-associations.js';
import type {Chain,Report} from './types.js';
import type {WalletAnalysis,WalletRecord} from './research/wallet-types.js';
import type {WalletPressure} from './adaptive-exit.js';
import {readRecentExitPressure} from './wallet-exit-pressure.js';
import {WalletResearchSeeds,type WalletResearchSeedSnapshot,type WalletResearchSeedHint,type WalletResearchSeedCheck,type WalletResearchSeedStatus} from './wallet-research-seeds.js';

export interface WalletHistoryToken {chain:Chain;address:string;}
export interface WalletHistoryOptions {maxBytes?:number;now?:()=>Date;}
export interface WalletHistoryContext {source:string;observedAt:string;}
export interface WalletVendorNominationInput {
  source:'ave';eventId:string;occurredAt:string;observedAt:string;
  wallets:{address:string;alias?:string;side?:'buy'|'sell';lastTradeAt?:string;chain?:Chain;tokenAddress?:string}[];
}
/** A durable provider nomination, separate from trades, performance, labels and ownership. */
export interface WalletVendorNomination {
  chain:Chain;wallet:string;tokenAddress:string;source:'ave';eventId:string;occurredAt:string;observedAt:string;
  alias?:string;side?:'buy'|'sell';lastTradeAt?:string;
  verification:'vendor_report';scope:'research_nomination_only';ownershipProven:false;buyEvidence:false;qualifiesAsSmart:false;
}
export interface WalletTradeObservation {
  chain:Chain;wallet:string;tokenAddress:string;txHash:string;
  side:'buy'|'sell'|'transferIn'|'transferOut'|'add'|'remove';eventAt:string;observedAt:string;
  amount?:string|null;amountUnit?:'human'|'atomic'|'unknown'|'vendor_quantity';usd?:string|null;
  priceUsd?:string|null;source:string;eventIndex?:number;
}
/** Observed vendor trades within one forward review window; never whole-market flow or ownership proof. */
export interface FollowupWalletEvidence {
  chain?:Chain;address?:string;
  fromAt:string;untilAt:string;coverage:'sampled'|'truncated'|'unavailable';
  trades:{evidenceId:string;txHash:string;wallet:string;side:'buy'|'sell';volumeUsd:number;
    eventAt:string;observedAt:string;source:string}[];
  buyUsd:number|null;sellUsd:number|null;netBuyUsd:number|null;buyerCount:number|null;sellerCount:number|null;
  evidenceCount:number;excludedCount:number;limitations:string[];
}
export interface WalletLeaderObservation {
  address:string;rank?:number;period:'7d';realizedProfitUsd?:string|null;winRate?:number|null;
  labels?:string[];name?:string;twitter?:string;
}
export interface WalletTokenRankObservation {address:string;rank:number;interval:'1h';changeMetric:string|null;changeUnit:'vendor_unspecified';priceUsd?:number;}
export interface WalletTokenTraderObservation {address:string;rank:number;profitUsd:string|null;realizedProfitUsd:string|null;unrealizedProfitUsd:string|null;labels?:string[];
  firstAcquiredAt?:string;lastActiveAt?:string;exitedAt?:string;buyVolumeUsd?:string|null;sellVolumeUsd?:string|null;balance?:string|null;
  rankScope?:'vendor_profit_order'|'vendor_unrealized_profit_order'|'vendor_buy_volume_order'|'vendor_sell_volume_order';sampleLimit?:20|100;}
export interface WalletCollectionObservation {
  source:string;chain?:Chain;startedAt:string;completedAt:string;status:'ok'|'partial'|'cooldown'|'stopped';
  requests:number;accepted:number;rejected?:number;coverage:'one_page_sample';hasMore?:boolean|null;reason?:string;
}
export interface WalletGainEvidence {
  tokenAddress:string;baselineAt:string;baselinePriceUsd:number;peakAt:string;peakPriceUsd:number;
  maxGainPct:number;latestAt:string;latestPriceUsd:number;source:string;kind:'first_post_observed_buy_quote';
}
export interface WalletVendorStats {
  chain:Chain;wallet:string;realizedProfitUsd:string|null;period:'7d';scope:'entire_wallet';source:string;
  observedAt:string;snapshotAt?:string;winRate?:number|null;verification:'vendor_claim';rank?:number;
}
export interface WalletFundingEdge {
  chain:Chain;wallet:string;fundingAddress:string;label?:string;source:string;observedAt:string;snapshotAt?:string;
  eventAt?:string;txHash?:string;amount?:string|null;sharedService:boolean;conflict:boolean;verification:'vendor_claim';
}
export interface WalletHoldingSnapshot {
  chain:Chain;wallet:string;tokenAddress:string;source:string;observedAt:string;snapshotAt?:string;
  holding:{amount:string|null;usd:string|null;supplyRatio:number|null;currentlyHolding:boolean|null};
  cumulative:{scope:'vendor_token_cumulative';recentInflow:false;buyVolumeUsd:string|null;sellVolumeUsd:string|null;
    buyCount:number|null;sellCount:number|null;firstAcquiredAt:string|null;lastActiveAt:string|null;exitedAt:string|null};
  labels:string[];name?:string;twitter?:string;risks:string[];developerLinks:string[];verification:'vendor_claim';
}
export interface WalletHistoryEvent extends WalletTradeObservation {
  id:string;scope:'indexed_event'|'transaction_wallet_token_side';ambiguous:boolean;
  evidence:WalletTradeObservation[];
}
export interface WalletHistorySummary {
  chain:Chain;address:string;firstObservedAt:string;lastObservedAt:string;labels:string[];name?:string;twitter?:string;
  vendorVerification:'vendor_claim';observedEventCount:number;buyEvents:number;sellEvents:number;tokenCount:number;
  profit?:WalletVendorStats;gain?:WalletGainEvidence;
  researchSeeds?:WalletResearchSeedHint[];
  coordination:{score:number;sharedFundingPeers:number;synchronizedPeers:number;evidenceCount:number;ownership:'unknown';scope:'heuristic';
    status:'pending'|'stale'|'current';checkedAt?:string};
}
export interface WalletHistoryDetail {
  wallet:WalletHistorySummary;timeline:WalletHistoryEvent[];holdings:WalletHoldingSnapshot[];fundingEdges:WalletFundingEdge[];
  vendorStats:WalletVendorStats[];gains:WalletGainEvidence[];
  vendorNominations?:WalletVendorNomination[];
  tokenTraderSnapshots:({chain:Chain;wallet:string;tokenAddress:string;source:string;observedAt:string;scope:'token_cumulative';verification:'vendor_claim'}&Omit<WalletTokenTraderObservation,'address'>)[];
  coordinationEvidence:{sharedFunding:{address:string;wallet:string;observedAt:string}[];
    synchronized:{wallet:string;tokenAddress:string;distinctTransactions:number;windowSeconds:120}[]};
  coverage:{sampleOnly:true;exactRealizedPnl:false;eventCount:number;observationCount:number;nominationCount?:number;firstObservedAt:string;lastObservedAt:string};
}
export interface WalletHistoryListOptions {chain?:Chain;sort?:'profit'|'gain'|'coordination'|'recent';search?:string;limit?:number;offset?:number;}
export interface WalletHistoryStats {
  wallets:number;events:number;observations:number;tokens:number;prices:number;snapshots:number;fundingLinks:number;collections:number;nominations?:number;coordinationPending:number;
  firstObservedAt?:string;lastObservedAt?:string;bytes:number;maxBytes:number;error?:string;sampleOnly:true;exactRealizedPnl:false;
  researchSeeds?:WalletResearchSeedStatus;
}

const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const clean=(v:unknown,n=100):string|undefined=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,n)||undefined:undefined;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const source=(v:unknown):v is string=>typeof v==='string'&&/^[a-z][a-z0-9_.:-]{0,79}$/.test(v);
const chainValid=(v:unknown):v is Chain=>['bsc','solana','robinhood'].includes(String(v));
const count=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const decimal=(v:unknown):string|null=>typeof v==='string'&&v.length<=100&&/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)?v:null;
const positiveDecimal=(v:unknown):string|null=>decimal(v)!==null&&!String(v).startsWith('-')?String(v):null;
const ratio=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1?v:null;
function at(v:unknown):string|undefined {
  if(typeof v!=='string'||v.length>40||!/^\d{4}-\d{2}-\d{2}T/.test(v)||!Number.isFinite(Date.parse(v))) return;
  return new Date(v).toISOString();
}
function addr(v:unknown,chain:Chain,hash=false):string|undefined {
  if(typeof v!=='string') return;
  if(chain!=='solana') return new RegExp(`^0x[0-9a-fA-F]{${hash?64:40}}$`).test(v)?v.toLowerCase():undefined;
  try {return v.length<=88&&bs58.decode(v).length===(hash?64:32)?v:undefined;} catch {return;}
}
const labels=(v:unknown):string[]=>Array.isArray(v)?[...new Set(v.filter((x):x is string=>typeof x==='string'&&/^[a-z][a-z0-9_-]{0,39}$/.test(x)))].slice(0,16):[];
const twitter=(v:unknown):string|undefined=>typeof v==='string'&&/^@?[A-Za-z0-9_]{1,100}$/.test(v)?v.replace(/^@/,''):undefined;
const code=(v:unknown):string|undefined=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(v)?v:undefined;
const CAPACITY='WALLET_HISTORY_CAPACITY_REACHED';

function walletCoordinationSummary(evidence:WalletHistoryDetail['coordinationEvidence'],status:WalletHistorySummary['coordination']['status'],
  checkedAt?:string):WalletHistorySummary['coordination'] {
  const shared=new Set(evidence.sharedFunding.map(item=>item.wallet)).size,
    synced=new Set(evidence.synchronized.map(item=>item.wallet)).size;
  return {score:Math.min(100,shared*10+synced*20),sharedFundingPeers:shared,synchronizedPeers:synced,
    evidenceCount:evidence.sharedFunding.length+evidence.synchronized.length,ownership:'unknown',scope:'heuristic',status,checkedAt};
}

function readWalletCoordination(db:DatabaseSync,chain:Chain,wallet:string):WalletHistoryDetail['coordinationEvidence'] {
  // Keep the target wallet as the outer loop. An ordinary JOIN can start with
  // every funding snapshot on the chain before applying the wallet constraint.
  const sharedFunding=db.prepare(`SELECT DISTINCT b.wallet,a.funding_address,MAX(a.observed_at,b.observed_at) AS observed
    FROM wh_funding a INDEXED BY wh_funding_coord_wallet CROSS JOIN wh_funding b INDEXED BY wh_funding_coord_address ON a.chain=b.chain AND a.funding_address=b.funding_address AND a.wallet<>b.wallet
    WHERE a.chain=? AND a.wallet=? AND a.shared=0 AND b.shared=0 AND a.conflict=0 AND b.conflict=0
      AND NOT EXISTS(SELECT 1 FROM wh_funding s INDEXED BY wh_funding_coord_address WHERE s.chain=a.chain AND s.funding_address=a.funding_address AND s.shared=1)
      AND NOT EXISTS(SELECT 1 FROM wh_funding x INDEXED BY wh_funding_coord_wallet WHERE x.chain=a.chain AND x.wallet=a.wallet AND x.funding_address=a.funding_address
        AND (x.snapshot_at>a.snapshot_at OR (x.snapshot_at=a.snapshot_at AND (x.observed_at>a.observed_at OR x.conflict=1))))
      AND NOT EXISTS(SELECT 1 FROM wh_funding x INDEXED BY wh_funding_coord_wallet WHERE x.chain=b.chain AND x.wallet=b.wallet AND x.funding_address=b.funding_address
        AND (x.snapshot_at>b.snapshot_at OR (x.snapshot_at=b.snapshot_at AND (x.observed_at>b.observed_at OR x.conflict=1))))
    LIMIT 50`).all(chain,wallet).map(row=>({address:String(row.funding_address),wallet:String(row.wallet),observedAt:String(row.observed)}));
  const synchronized=db.prepare(`WITH seeds AS (SELECT * FROM wh_events WHERE chain=? AND wallet=? AND side IN ('buy','sell') ORDER BY event_at DESC LIMIT 200)
    SELECT b.wallet,a.token_address,COUNT(DISTINCT a.tx_hash) AS n FROM seeds a JOIN wh_events b ON b.id IN (
      SELECT x.id FROM wh_events x WHERE x.chain=a.chain AND x.token_address=a.token_address AND x.side=a.side
        AND x.wallet<>a.wallet AND x.tx_hash<>a.tx_hash
        AND x.event_at BETWEEN strftime('%Y-%m-%dT%H:%M:%fZ',a.event_at,'-120 seconds') AND strftime('%Y-%m-%dT%H:%M:%fZ',a.event_at,'+120 seconds')
      ORDER BY x.event_at DESC LIMIT 200) GROUP BY b.wallet,a.token_address
    HAVING COUNT(DISTINCT a.tx_hash)>=2 AND COUNT(DISTINCT b.tx_hash)>=2 LIMIT 50`).all(chain,wallet)
    .map(row=>({wallet:String(row.wallet),tokenAddress:String(row.token_address),distinctTransactions:Number(row.n),windowSeconds:120 as const}));
  return {sharedFunding,synchronized};
}

export function readWalletResearchSeedHints(db:DatabaseSync,chain:Chain,address:string):WalletResearchSeedHint[] {
  if(!['bsc','robinhood'].includes(chain)||!/^0x[0-9a-fA-F]{40}$/.test(address))return [];
  return db.prepare(`SELECT s.data AS source,e.data AS entry FROM wh_research_seeds e JOIN wh_research_seed_sources s ON s.source_id=e.source_id
    WHERE e.address=? LIMIT 10`).all(address.toLowerCase()).map(row=>{
    const source=JSON.parse(String(row.source)),entry=JSON.parse(String(row.entry));
    return {sourceId:source.sourceId,sourceUrl:source.sourceUrl,commit:source.commit,sha256:source.sha256,labels:entry.labels,groups:entry.groups,
      verification:'unverified_external_list',scope:'research_hint_only',ownershipProven:false,qualifiesAsSmart:false};
  });
}

/** Read-only wallet page shared by the live store and the dashboard query worker. */
export function readWalletHistoryList(db:DatabaseSync,options:WalletHistoryListOptions={}):{items:WalletHistorySummary[];total:number} {
  const chain=options.chain,search=options.search?String(options.search).toLowerCase().slice(0,200):undefined;
  const offset=Number.isSafeInteger(options.offset)?Math.max(0,options.offset!):0,limit=Number.isSafeInteger(options.limit)?Math.max(1,Math.min(200,options.limit!)):50;
  const metric=options.sort==='profit'?'profit_usd':options.sort==='gain'?'gain_pct':options.sort==='coordination'?'coordination_score':undefined;
  const nulls=metric&&metric!=='coordination_score'?' NULLS LAST':'',sort=metric?`m.${metric} DESC${nulls},m.last_at DESC,m.address,m.chain`:
    'w.last_at DESC,w.address,w.chain';
  const fts=!!search&&![...search].includes('\u0000')&&[...search].length>=3,
    phrase=fts?`"${search!.replaceAll('"','""')}"`:undefined;
  let total:number,rows:Record<string,any>[];
  if(search) {
    const exact='(instr(lower(w.address),?)>0 OR instr(lower(w.profile),?)>0)',chainClause=chain?' AND w.chain=?':'';
    if(fts) {
      const values:SQLInputValue[]=[phrase!,search,search,...(chain?[chain]:[])];
      total=Number(db.prepare(`SELECT count(*) AS n FROM wh_wallet_search s CROSS JOIN wh_wallets w ON w.rowid=s.rowid
        WHERE wh_wallet_search MATCH ? AND ${exact}${chainClause}`).get(...values)!.n);
      rows=db.prepare(`SELECT w.*,m.* FROM wh_wallet_search s CROSS JOIN wh_wallets w ON w.rowid=s.rowid
        CROSS JOIN wh_metrics m INDEXED BY sqlite_autoindex_wh_metrics_1 ON m.chain=w.chain AND m.address=w.address
        WHERE wh_wallet_search MATCH ? AND ${exact}${chainClause} ORDER BY ${sort} LIMIT ? OFFSET ?`)
        .all(...values,limit,offset);
    } else {
      const values:SQLInputValue[]=[...(chain?[chain]:[]),search,search],where=`WHERE ${chain?'w.chain=? AND ':''}${exact}`;
      total=Number(db.prepare(`SELECT count(*) AS n FROM wh_wallets w ${where}`).get(...values)!.n);
      const driver=metric?`wh_metrics m INDEXED BY wh_metrics_${options.sort}_page
        JOIN wh_wallets w INDEXED BY sqlite_autoindex_wh_wallets_1 ON w.chain=m.chain AND w.address=m.address`:
        `wh_wallets w INDEXED BY ${chain?'wh_stream_recent_wallets':'wh_wallets_recent_page'}
        JOIN wh_metrics m INDEXED BY sqlite_autoindex_wh_metrics_1 ON m.chain=w.chain AND m.address=w.address`;
      rows=db.prepare(`SELECT w.*,m.* FROM ${driver} ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...values,limit,offset);
    }
  } else {
    const totalWhere=chain?'WHERE w.chain=?':'',values:SQLInputValue[]=chain?[chain]:[];
    total=Number(db.prepare(`SELECT count(*) AS n FROM wh_wallets w ${totalWhere}`).get(...values)!.n);
    if(metric) {
      const index=`wh_metrics_${options.sort}_page`,where=chain?'WHERE chain=?':'';
      rows=db.prepare(`WITH page AS MATERIALIZED (
          SELECT chain,address FROM wh_metrics INDEXED BY ${index} ${where}
          ORDER BY ${metric} DESC${nulls},last_at DESC,address,chain LIMIT ? OFFSET ?)
        SELECT w.*,m.* FROM page p
        JOIN wh_metrics m INDEXED BY sqlite_autoindex_wh_metrics_1 ON m.chain=p.chain AND m.address=p.address
        JOIN wh_wallets w INDEXED BY sqlite_autoindex_wh_wallets_1 ON w.chain=p.chain AND w.address=p.address
        ORDER BY ${sort}`).all(...values,limit,offset);
    } else {
      const index=chain?'wh_stream_recent_wallets':'wh_wallets_recent_page',where=chain?'WHERE chain=?':'';
      rows=db.prepare(`WITH page AS MATERIALIZED (
          SELECT chain,address FROM wh_wallets INDEXED BY ${index} ${where}
          ORDER BY last_at DESC,address,chain LIMIT ? OFFSET ?)
        SELECT w.*,m.* FROM page p
        JOIN wh_wallets w INDEXED BY sqlite_autoindex_wh_wallets_1 ON w.chain=p.chain AND w.address=p.address
        JOIN wh_metrics m INDEXED BY sqlite_autoindex_wh_metrics_1 ON m.chain=p.chain AND m.address=p.address
        ORDER BY ${sort}`).all(...values,limit,offset);
    }
  }
  return {items:rows.map(row=>readWalletSummary(db,row)),total};
}

function readWalletSummary(db:DatabaseSync,row:Record<string,any>):WalletHistorySummary {
  const chain=row.chain as Chain,wallet=String(row.address),profile=JSON.parse(String(row.profile));
  const profit=row.profit_data?JSON.parse(String(row.profit_data)) as WalletVendorStats:undefined;
  const evidence=row.coordination_data?JSON.parse(String(row.coordination_data)) as WalletHistoryDetail['coordinationEvidence']:{sharedFunding:[],synchronized:[]};
  const checkedAt=row.coordination_checked_at?String(row.coordination_checked_at):undefined;
  return {chain,address:wallet,firstObservedAt:String(row.first_at),lastObservedAt:String(row.last_at),labels:profile.labels,
    name:profile.name,twitter:profile.twitter,vendorVerification:'vendor_claim',observedEventCount:Number(row.event_count??0),buyEvents:Number(row.buy_count??0),
    sellEvents:Number(row.sell_count??0),tokenCount:Number(row.token_count??0),profit,gain:row.gain_data?JSON.parse(String(row.gain_data)):undefined,
    researchSeeds:readWalletResearchSeedHints(db,chain,wallet),
    coordination:walletCoordinationSummary(evidence,!checkedAt?'pending':Number(row.coordination_dirty)?'stale':'current',checkedAt)};
}

/** Exact wallet detail reader shared by the live store and the dashboard's read-only worker. */
export function readWalletHistoryDetail(db:DatabaseSync,chain:Chain,address:string,now=new Date()):WalletHistoryDetail|undefined {
  if(!chainValid(chain))return;
  const wallet=addr(address,chain);if(!wallet)return;
  const row=db.prepare('SELECT w.*,m.* FROM wh_wallets w JOIN wh_metrics m ON m.chain=w.chain AND m.address=w.address WHERE w.chain=? AND w.address=?').get(chain,wallet);if(!row)return;
  const summary=readWalletSummary(db,row),coordinationEvidence=readWalletCoordination(db,chain,wallet);
  summary.coordination=walletCoordinationSummary(coordinationEvidence,'current',now.toISOString());
  const events=db.prepare('SELECT * FROM wh_events WHERE chain=? AND wallet=? ORDER BY event_at DESC LIMIT 100').all(chain,wallet),
    evidenceByEvent=new Map<string,WalletTradeObservation[]>();
  if(events.length){
    const eventIds=events.map(event=>String(event.id)),placeholders=eventIds.map(()=>'?').join(',');
    const rows=db.prepare(`SELECT event_id,data FROM (
      SELECT event_id,data,row_number() OVER (PARTITION BY event_id ORDER BY observed_at) AS position
      FROM wh_observations INDEXED BY wh_observations_event WHERE event_id IN (${placeholders}) AND kind='trade')
      WHERE position<=20 ORDER BY event_id,position`).all(...eventIds);
    for(const row of rows){const id=String(row.event_id),list=evidenceByEvent.get(id)??[];
      list.push(JSON.parse(String(row.data)) as WalletTradeObservation);evidenceByEvent.set(id,list);}
  }
  const timeline=events.map(event=>{
    const evidence=evidenceByEvent.get(String(event.id))??[];
    const first=JSON.parse(String(event.data)) as WalletTradeObservation;
    const contents=new Set(evidence.map(e=>JSON.stringify([e.eventAt,e.amount,e.amountUnit,e.usd,e.priceUsd])));
    return {...first,id:String(event.id),scope:first.eventIndex===undefined?'transaction_wallet_token_side' as const:'indexed_event' as const,
      ambiguous:first.eventIndex===undefined||contents.size>1,evidence};
  });
  const observations=(kind:string,limit=100)=>db.prepare('SELECT data FROM wh_observations WHERE chain=? AND wallet=? AND kind=? ORDER BY observed_at DESC LIMIT ?')
    .all(chain,wallet,kind,limit).map(r=>JSON.parse(String(r.data)));
  const observationCount=Number(db.prepare('SELECT count(*) AS n FROM wh_observations WHERE chain=? AND wallet=?').get(chain,wallet)!.n);
  const nominationCount=Number(db.prepare("SELECT count(*) AS n FROM wh_observations WHERE chain=? AND wallet=? AND kind='vendor_nomination'").get(chain,wallet)!.n);
  const gains=db.prepare('SELECT data FROM wh_gains WHERE chain=? AND wallet=?').all(chain,wallet).map(row=>JSON.parse(String(row.data)) as WalletGainEvidence)
    .sort((a,b)=>b.maxGainPct-a.maxGainPct).slice(0,100);
  return {wallet:summary,timeline,holdings:observations('holding'),vendorStats:observations('stats'),tokenTraderSnapshots:observations('token_trader'),
    vendorNominations:observations('vendor_nomination'),
    fundingEdges:db.prepare('SELECT data FROM wh_funding WHERE chain=? AND wallet=? ORDER BY observed_at DESC LIMIT 100').all(chain,wallet).map(r=>JSON.parse(String(r.data))),
    gains,coordinationEvidence,
    coverage:{sampleOnly:true,exactRealizedPnl:false,eventCount:summary.observedEventCount,observationCount,nominationCount,
      firstObservedAt:summary.firstObservedAt,lastObservedAt:summary.lastObservedAt}};
}

interface AssociationChanges {
  fundingWallets:Map<Chain,Set<string>>;
  fundingAddresses:Map<Chain,Set<string>>;
  publicServices:Map<Chain,Set<string>>;
}
type AssociationInvalidationKind='funding_wallet'|'funding_address'|'public_service';

export const WALLET_COORDINATION_INVALIDATION_SQL=`UPDATE wh_metrics SET coordination_dirty=1 WHERE coordination_dirty<>1 AND rowid IN (
  SELECT m.rowid
  FROM json_each(?) a
  CROSS JOIN wh_funding f INDEXED BY wh_funding_address
  CROSS JOIN wh_metrics m INDEXED BY sqlite_autoindex_wh_metrics_1
  WHERE f.chain=? AND f.funding_address=a.value
    AND m.chain=f.chain AND m.address=f.wallet)`;

/** Long-lived research evidence. Never uses this data as a trading permission or deletes history to make space. */
export class WalletHistory {
  private readonly db:DatabaseSync;
  private readonly now:()=>Date;
  private readonly maxBytes:number;
  private error?:string;
  private readonly associations:WalletAssociations;
  private readonly researchSeeds:WalletResearchSeeds;
  constructor(private readonly path:string,options:WalletHistoryOptions={}) {
    this.maxBytes=options.maxBytes??512*1024*1024;this.now=options.now??(()=>new Date());
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<16_384) throw new Error('WALLET_HISTORY_CONFIG_INVALID');
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:') chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=128;
      CREATE TABLE IF NOT EXISTS wh_wallets(chain TEXT,address TEXT,first_at TEXT,last_at TEXT,profile TEXT NOT NULL,PRIMARY KEY(chain,address));
      CREATE TABLE IF NOT EXISTS wh_tokens(chain TEXT,address TEXT,first_at TEXT,last_at TEXT,last_checked_at TEXT,PRIMARY KEY(chain,address));
      CREATE TABLE IF NOT EXISTS wh_events(id TEXT PRIMARY KEY,chain TEXT,wallet TEXT,token_address TEXT,tx_hash TEXT,side TEXT,event_at TEXT,observed_at TEXT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wh_observations(id TEXT PRIMARY KEY,kind TEXT,chain TEXT,wallet TEXT,token_address TEXT,event_id TEXT,source TEXT,observed_at TEXT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wh_funding(id TEXT PRIMARY KEY,chain TEXT,wallet TEXT,funding_address TEXT,observed_at TEXT,shared INTEGER,conflict INTEGER,snapshot_at TEXT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wh_prices(id TEXT PRIMARY KEY,chain TEXT,token_address TEXT,observed_at TEXT,price REAL,source TEXT);
      CREATE TABLE IF NOT EXISTS wh_gains(chain TEXT,wallet TEXT,token_address TEXT,data TEXT NOT NULL,PRIMARY KEY(chain,wallet,token_address));
      CREATE TABLE IF NOT EXISTS wh_metrics(chain TEXT,address TEXT,event_count INTEGER DEFAULT 0,buy_count INTEGER DEFAULT 0,sell_count INTEGER DEFAULT 0,
        token_count INTEGER DEFAULT 0,profit_usd REAL,profit_at TEXT,profit_observed_at TEXT,profit_data TEXT,gain_pct REAL,gain_data TEXT,
        coordination_score INTEGER DEFAULT 0,coordination_data TEXT,coordination_checked_at TEXT,coordination_dirty INTEGER DEFAULT 1,last_at TEXT,PRIMARY KEY(chain,address));
      CREATE TABLE IF NOT EXISTS wh_wallet_tokens(chain TEXT,wallet TEXT,token_address TEXT,PRIMARY KEY(chain,wallet,token_address));
      CREATE TABLE IF NOT EXISTS wh_report_captures(id TEXT PRIMARY KEY,observed_at TEXT);
      CREATE TABLE IF NOT EXISTS wh_association_invalidations(
        kind TEXT NOT NULL CHECK(kind IN ('funding_wallet','funding_address','public_service')),
        chain TEXT NOT NULL,address TEXT NOT NULL,enqueued_at TEXT NOT NULL,
        stage INTEGER NOT NULL DEFAULT 0,cursor TEXT,
        PRIMARY KEY(kind,chain,address));
      CREATE TABLE IF NOT EXISTS wh_meta(key TEXT PRIMARY KEY,value TEXT);
      INSERT OR IGNORE INTO wh_meta VALUES ('error','');
      INSERT OR IGNORE INTO wh_meta VALUES ('capacity_limit','0');
      CREATE INDEX IF NOT EXISTS wh_events_wallet ON wh_events(chain,wallet,event_at);
      CREATE INDEX IF NOT EXISTS wh_events_token ON wh_events(chain,token_address,side,event_at);
      -- Compact covering indexes keep status counts from scanning long hashes and event IDs.
      CREATE INDEX IF NOT EXISTS wh_events_side ON wh_events(side);
      CREATE INDEX IF NOT EXISTS wh_observations_wallet ON wh_observations(chain,wallet,kind,observed_at);
      CREATE INDEX IF NOT EXISTS wh_observations_event ON wh_observations(event_id);
      CREATE INDEX IF NOT EXISTS wh_observations_kind ON wh_observations(kind);
      CREATE INDEX IF NOT EXISTS wh_exit_evidence ON wh_observations(chain,token_address,kind,observed_at);
      CREATE INDEX IF NOT EXISTS wh_funding_wallet ON wh_funding(chain,wallet,funding_address,observed_at);
      CREATE INDEX IF NOT EXISTS wh_funding_address ON wh_funding(chain,funding_address,observed_at);
      CREATE INDEX IF NOT EXISTS wh_wallets_recent ON wh_wallets(last_at DESC);
      CREATE INDEX IF NOT EXISTS wh_metrics_dirty ON wh_metrics(coordination_dirty,coordination_checked_at);`);
    const invalidationColumns=new Set(this.db.prepare('PRAGMA table_info(wh_association_invalidations)').all().map(column=>String(column.name)));
    if(!invalidationColumns.has('stage'))this.db.exec('ALTER TABLE wh_association_invalidations ADD COLUMN stage INTEGER NOT NULL DEFAULT 0');
    if(!invalidationColumns.has('cursor'))this.db.exec('ALTER TABLE wh_association_invalidations ADD COLUMN cursor TEXT');
    const metricColumns=new Set(this.db.prepare('PRAGMA table_info(wh_metrics)').all().map(column=>String(column.name)));
    const listSchemaVersion=String(this.db.prepare("SELECT value FROM wh_meta WHERE key='wallet_list_schema_v1'").get()?.value??'');
    if(!metricColumns.has('last_at')||listSchemaVersion!=='1') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if(!metricColumns.has('last_at'))this.db.exec('ALTER TABLE wh_metrics ADD COLUMN last_at TEXT');
        this.db.exec(`UPDATE wh_metrics SET last_at=(SELECT w.last_at FROM wh_wallets w
          WHERE w.chain=wh_metrics.chain AND w.address=wh_metrics.address) WHERE last_at IS NULL;
          INSERT INTO wh_meta(key,value) VALUES('wallet_list_schema_v1','1') ON CONFLICT(key) DO UPDATE SET value='1';
          COMMIT`);
      } catch(error) {this.db.exec('ROLLBACK');throw error;}
    }
    // List pages are read on the HTTP thread.  Keep every ordering term in the
    // driving index so equal coordination scores and the large NULL profit/gain
    // tails never spill all wallets into a temporary sort.
    this.db.exec(`CREATE INDEX IF NOT EXISTS wh_metrics_profit_page ON wh_metrics(profit_usd DESC,last_at DESC,address,chain);
      CREATE INDEX IF NOT EXISTS wh_metrics_gain_page ON wh_metrics(gain_pct DESC,last_at DESC,address,chain);
      CREATE INDEX IF NOT EXISTS wh_metrics_coordination_page ON wh_metrics(coordination_score DESC,last_at DESC,address,chain);
      CREATE INDEX IF NOT EXISTS wh_wallets_recent_page ON wh_wallets(last_at DESC,address,chain);
      CREATE VIRTUAL TABLE IF NOT EXISTS wh_wallet_search USING fts5(value,tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS wh_wallet_search_insert AFTER INSERT ON wh_wallets BEGIN
        INSERT INTO wh_wallet_search(rowid,value) VALUES(new.rowid,lower(new.address)||char(10)||lower(new.profile));
      END;
      CREATE TRIGGER IF NOT EXISTS wh_wallet_search_update AFTER UPDATE OF address,profile ON wh_wallets
      WHEN old.address IS NOT new.address OR old.profile IS NOT new.profile BEGIN
        DELETE FROM wh_wallet_search WHERE rowid=old.rowid;
        INSERT INTO wh_wallet_search(rowid,value) VALUES(new.rowid,lower(new.address)||char(10)||lower(new.profile));
      END;
      CREATE TRIGGER IF NOT EXISTS wh_wallet_search_delete AFTER DELETE ON wh_wallets BEGIN
        DELETE FROM wh_wallet_search WHERE rowid=old.rowid;
      END;
      DROP INDEX IF EXISTS wh_metrics_profit;
      DROP INDEX IF EXISTS wh_metrics_gain;
      DROP INDEX IF EXISTS wh_metrics_coordination;`);
    if(String(this.db.prepare("SELECT value FROM wh_meta WHERE key='wallet_search_schema_v1'").get()?.value??'')!=='1') {
      this.db.exec('BEGIN IMMEDIATE');
      try {this.db.exec(`DELETE FROM wh_wallet_search;
          INSERT INTO wh_wallet_search(rowid,value) SELECT rowid,lower(address)||char(10)||lower(profile) FROM wh_wallets;
          INSERT INTO wh_meta(key,value) VALUES('wallet_search_schema_v1','1') ON CONFLICT(key) DO UPDATE SET value='1';
          COMMIT`);
      } catch(error) {this.db.exec('ROLLBACK');throw error;}
    }
    if(!this.db.prepare('PRAGMA table_info(wh_funding)').all().some(column=>column.name==='snapshot_at')) {
      this.db.exec("ALTER TABLE wh_funding ADD COLUMN snapshot_at TEXT; UPDATE wh_funding SET snapshot_at=COALESCE(json_extract(data,'$.snapshotAt'),observed_at)");
    }
    // Coordination needs only these scalar fields. Keep its nested evidence
    // checks off the growing raw funding JSON table, including contrary copies.
    this.db.exec(`CREATE INDEX IF NOT EXISTS wh_funding_coord_wallet ON wh_funding(chain,wallet,funding_address,snapshot_at,observed_at,conflict,shared);
      CREATE INDEX IF NOT EXISTS wh_funding_coord_address ON wh_funding(chain,funding_address,shared,conflict,wallet,snapshot_at,observed_at);
      CREATE INDEX IF NOT EXISTS wh_funding_recipients ON wh_funding(chain,funding_address,wallet);
      CREATE INDEX IF NOT EXISTS wh_metrics_coord_queue ON wh_metrics(coordination_dirty,COALESCE(coordination_checked_at,''),chain,address);`);
    this.db.exec('CREATE INDEX IF NOT EXISTS wh_funding_asof ON wh_funding(chain,wallet,funding_address,snapshot_at,observed_at)');
    this.error=String(this.db.prepare("SELECT value FROM wh_meta WHERE key='error'").get()?.value??'')||undefined;
    const previousLimit=Number(this.db.prepare("SELECT value FROM wh_meta WHERE key='capacity_limit'").get()?.value??0);
    if(this.error===CAPACITY&&this.maxBytes>previousLimit&&this.bytes()+32_768<this.maxBytes) {
      this.error=undefined;this.db.prepare("UPDATE wh_meta SET value='' WHERE key='error'").run();
    }
    this.associations=new WalletAssociations(this.db,(evidence,write)=>this.append(evidence,write),this.now);
    this.researchSeeds=new WalletResearchSeeds(this.db,(evidence,write)=>this.append(evidence,write),this.now);
    this.db.exec('CREATE INDEX IF NOT EXISTS wh_assoc_candidate ON wh_assoc_relations(chain,candidate,first_at)');
    this.db.exec(`CREATE INDEX IF NOT EXISTS wh_stream_relations ON wh_assoc_relations(chain,token_count DESC,forward_count DESC,updated_at DESC,candidate,leader) WHERE token_count>0 AND dirty=0;
      CREATE INDEX IF NOT EXISTS wh_stream_recent_wallets ON wh_wallets(chain,last_at DESC,address);`);
    if(this.bytes()>=this.maxBytes) this.error=CAPACITY;
  }

  recordTrade(input:WalletTradeObservation):void {this.recordTrades([input]);}

  importResearchSeeds(snapshot:WalletResearchSeedSnapshot):void {this.researchSeeds.import(snapshot);}
  researchSeedHints(chain:Chain,address:string):WalletResearchSeedHint[] {return this.researchSeeds.hints(chain,address);}
  researchSeedStatus():WalletResearchSeedStatus {return this.researchSeeds.status();}
  researchSeedTarget(chain:Chain):{chain:Chain;address:string}|undefined {
    // If evidence/checkpoints cannot be retained, do not keep querying a lead
    // whose persistent cooldown could not be saved.
    return this.error===CAPACITY?undefined:this.researchSeeds.target(chain);
  }
  markResearchSeedChecked(check:WalletResearchSeedCheck):void {this.researchSeeds.checked(check);}

  /** Bounded collector scheduling state, separate from all observed evidence. */
  getWalletObserverCursor():WalletObserverCursorState|undefined {
    const value=this.db.prepare("SELECT value FROM wh_meta WHERE key='wallet_observer_cursor_v1'").get()?.value;
    if(typeof value!=='string'||Buffer.byteLength(value)>400_000)return;
    try{return parseWalletObserverCursor(JSON.parse(value));}catch{return;}
  }
  setWalletObserverCursor(input:WalletObserverCursorState):boolean {
    const value=parseWalletObserverCursor(input);if(!value)return false;
    const serialized=JSON.stringify(value);
    if(this.db.prepare("SELECT value FROM wh_meta WHERE key='wallet_observer_cursor_v1'").get()?.value===serialized)return this.error!==CAPACITY;
    this.append(value,()=>this.db.prepare("INSERT INTO wh_meta(key,value) VALUES('wallet_observer_cursor_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(serialized));
    return this.error!==CAPACITY&&this.db.prepare("SELECT value FROM wh_meta WHERE key='wallet_observer_cursor_v1'").get()?.value===serialized;
  }
  recordTrades(inputs:WalletTradeObservation[]):void {
    const normalized=Array.isArray(inputs)?inputs.slice(0,2_000).map(value=>this.trade(value)).filter((v):v is WalletTradeObservation=>!!v):[];
    if(!normalized.length) return;
    this.append(normalized,()=>{const changes=this.associationChanges();for(const value of normalized)this.putTrade(value,changes);
      this.flushAssociationChanges(changes);});
  }

  /** Save all bounded full-address nominees before optional/early-vetoed research.
   * Repeated deliveries never rewrite their first evidence or refresh wallet time.
   * No trading token relation, trade, profit, funding or identity is inferred. */
  captureVendorNominations(token:WalletHistoryToken,input:WalletVendorNominationInput):
    {received:number;accepted:number;duplicates:number;rejected:number;reason?:string} {
    const result={received:Array.isArray(input?.wallets)?input.wallets.length:0,accepted:0,duplicates:0,rejected:0} as
      {received:number;accepted:number;duplicates:number;rejected:number;reason?:string};
    const strictAt=(value:unknown):string|undefined=>typeof value==='string'&&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&at(value)===value?value:undefined;
    const target=this.target(token),observed=strictAt(input?.observedAt),occurred=strictAt(input?.occurredAt);
    if(!target||/^0x0{40}$/.test(target.address)||target.address==='11111111111111111111111111111111'||
      input?.source!=='ave'||typeof input?.eventId!=='string'||!/^ave:signal:[a-f0-9]{64}$/.test(input.eventId)||
      !Array.isArray(input.wallets)||!observed||!occurred||occurred>observed||Date.parse(observed)>this.now().getTime()) {
      result.rejected=result.received;result.reason='WALLET_NOMINATION_INPUT_INVALID';return result;
    }
    // A new Ave event id normally has no row yet.  Without the explicit index,
    // SQLite can choose the low-cardinality `kind` index and scan every prior
    // nomination before proving absence (tens of milliseconds on the live DB).
    const bound=this.db.prepare("SELECT chain,token_address,data FROM wh_observations INDEXED BY wh_observations_event WHERE event_id=? AND kind='vendor_nomination' LIMIT 1").get(input.eventId);
    if(bound&&(bound.chain!==target.chain||bound.token_address!==target.address||
      (JSON.parse(String(bound.data)) as WalletVendorNomination).occurredAt!==occurred)) {
      result.rejected=result.received;result.reason='WALLET_NOMINATION_EVENT_SCOPE_CONFLICT';return result;
    }
    const values:{id:string;data:WalletVendorNomination}[]=[],seen=new Set<string>();
    for(const raw of input.wallets.slice(0,100)) {
      const wallet=object(raw)?addr(raw.address,target.chain):undefined;
      const tradeAt=object(raw)&&raw.lastTradeAt!==undefined?strictAt(raw.lastTradeAt):undefined;
      if(!object(raw)||!wallet||wallet===target.address||/^0x0{40}$/.test(wallet)||wallet==='11111111111111111111111111111111'||
        raw.chain!==undefined&&raw.chain!==target.chain||raw.tokenAddress!==undefined&&addr(raw.tokenAddress,target.chain)!==target.address||
        raw.side!==undefined&&!['buy','sell'].includes(raw.side)||
        raw.alias!==undefined&&(typeof raw.alias!=='string'||raw.alias.length>2000)||
        raw.lastTradeAt!==undefined&&(!tradeAt||tradeAt>observed)) {result.rejected++;continue;}
      const id=digest(['vendor_nomination',input.source,input.eventId,target.chain,target.address,wallet]);
      if(seen.has(id)||this.db.prepare('SELECT 1 FROM wh_observations WHERE id=?').get(id)){result.duplicates++;continue;}
      seen.add(id);
      const alias=clean(raw.alias,80);
      values.push({id,data:{chain:target.chain,wallet,tokenAddress:target.address,source:'ave',eventId:input.eventId,
        occurredAt:occurred,observedAt:observed,...(alias?{alias}:{}),...(raw.side?{side:raw.side}:{}),...(tradeAt?{lastTradeAt:tradeAt}:{}),
        verification:'vendor_report',scope:'research_nomination_only',ownershipProven:false,buyEvidence:false,qualifiesAsSmart:false}});
    }
    result.rejected+=Math.max(0,input.wallets.length-100);
    if(values.length)this.append(values,()=>{const changes=this.associationChanges();
      const current=this.db.prepare("SELECT chain,token_address,data FROM wh_observations INDEXED BY wh_observations_event WHERE event_id=? AND kind='vendor_nomination' LIMIT 1").get(input.eventId);
      if(current&&(current.chain!==target.chain||current.token_address!==target.address||
        (JSON.parse(String(current.data)) as WalletVendorNomination).occurredAt!==occurred)) {
        result.rejected+=values.length;result.reason='WALLET_NOMINATION_EVENT_SCOPE_CONFLICT';return;
      }
      for(const {id,data} of values){
      // Recheck under the write transaction so a second process cannot refresh a duplicate wallet's time.
      if(this.db.prepare('SELECT 1 FROM wh_observations WHERE id=?').get(id)){result.duplicates++;continue;}
      this.putWallet(data.chain,data.wallet,data.observedAt,{},changes);
      this.observation('vendor_nomination',data,data.wallet,data.tokenAddress,data.eventId,id);result.accepted++;
    }this.flushAssociationChanges(changes);});
    if(values.length&&this.error===CAPACITY){result.accepted=0;result.reason=CAPACITY;}
    else if(result.rejected&&!result.reason)result.reason='WALLET_NOMINATION_RECORDS_REJECTED';
    return result;
  }

  captureReport(report:Report):void {
    if(report?.mode!=='live'||!report.wallets||!chainValid(report.signal?.token?.chain)) return;
    const stamp=at(report.evaluatedAt);if(!stamp||!clean(report.id,200)) return;
    const key=digest([report.id,stamp]);if(this.db.prepare('SELECT 1 FROM wh_report_captures WHERE id=?').get(key)) return;
    this.captureAnalysis(report.signal.token,report.wallets,{source:'analysis_report',observedAt:this.now().toISOString()},key);
  }

  captureAnalysis(token:WalletHistoryToken,analysis:WalletAnalysis,context:{source:string;observedAt?:string},reportKey?:string):void {
    const target=this.target(token),observed=this.observed(context.observedAt??this.now().toISOString());
    const analysisTarget=analysis&&this.target(analysis.summary?.token),snapshotAt=at(analysis?.checkedAt);
    if(!target||!observed||!source(context.source)||!analysis||!Array.isArray(analysis.wallets)||
      analysisTarget?.chain!==target.chain||analysisTarget.address!==target.address||!snapshotAt||snapshotAt>observed) return;
    const records=analysis.wallets.slice(0,200).flatMap(wallet=>this.snapshot(target,wallet,context.source,observed,snapshotAt)??[]);
    this.append(records,()=>{
      if(reportKey&&!Number(this.db.prepare('INSERT OR IGNORE INTO wh_report_captures VALUES (?,?)').run(reportKey,observed).changes)) return;
      const changes=this.associationChanges();
      this.putToken(target,observed);
      for(const record of records) {
        this.putWallet(target.chain,record.holding.wallet,observed,{labels:record.holding.labels,name:record.holding.name,twitter:record.holding.twitter},changes);
        this.putWalletToken(target.chain,record.holding.wallet,target.address);
        this.observation('holding',record.holding,record.holding.wallet,target.address);
        if(record.stats) this.observation('stats',record.stats,record.holding.wallet,target.address);
        if(record.funding) this.putFunding(record.funding,changes);
        for(const event of record.events) this.putTrade(event,changes);
      }
      this.flushAssociationChanges(changes);
      this.db.prepare('UPDATE wh_tokens SET last_checked_at=? WHERE chain=? AND address=?').run(observed,target.chain,target.address);
    });
  }

  captureLeaders(chain:Chain,rows:WalletLeaderObservation[],context:WalletHistoryContext):void {
    const observed=this.observed(context.observedAt);if(!chainValid(chain)||!observed||!source(context.source)||!Array.isArray(rows)) return;
    const values=rows.slice(0,200).flatMap(row=>{
      const wallet=addr(row?.address,chain);if(!wallet||row.period!=='7d') return [];
      return [{chain,wallet,period:'7d' as const,scope:'entire_wallet' as const,source:context.source,observedAt:observed,
        realizedProfitUsd:decimal(row.realizedProfitUsd),winRate:ratio(row.winRate),verification:'vendor_claim' as const,
        rank:count(row.rank)??undefined,labels:labels(row.labels),name:clean(row.name),twitter:twitter(row.twitter)}];
    });
    this.append(values,()=>{const changes=this.associationChanges();for(const value of values) {
      this.putWallet(chain,value.wallet,observed,value,changes);this.observation('stats',value,value.wallet);
    }this.flushAssociationChanges(changes);});
  }

  captureTokenRanks(chain:Chain,rows:WalletTokenRankObservation[],context:WalletHistoryContext):void {
    const observed=this.observed(context.observedAt);if(!chainValid(chain)||!observed||!source(context.source)||!Array.isArray(rows)) return;
    const values=rows.slice(0,200).flatMap(row=>{
      const address=addr(row?.address,chain);if(!address||count(row.rank)===null||row.interval!=='1h'||row.changeUnit!=='vendor_unspecified') return [];
      return [{chain,address,rank:row.rank,interval:'1h',changeMetric:decimal(row.changeMetric),changeUnit:'vendor_unspecified',
        priceUsd:typeof row.priceUsd==='number'&&Number.isFinite(row.priceUsd)&&row.priceUsd>0?row.priceUsd:undefined,
        observedAt:observed,source:context.source}];
    });
    this.append(values,()=>{for(const value of values) {this.putToken(value,observed);this.observation('token_rank',value,undefined,value.address);}});
  }

  captureTokenTraders(token:WalletHistoryToken,rows:WalletTokenTraderObservation[],context:WalletHistoryContext):void {
    const target=this.target(token),observed=this.observed(context.observedAt);
    if(!target||!observed||!source(context.source)||!Array.isArray(rows)) return;
    const values=rows.slice(0,200).flatMap(row=>{
      const wallet=addr(row?.address,target.chain);if(!wallet||count(row.rank)===null) return [];
      return [{chain:target.chain,wallet,tokenAddress:target.address,rank:row.rank,profitUsd:decimal(row.profitUsd),
        realizedProfitUsd:decimal(row.realizedProfitUsd),unrealizedProfitUsd:decimal(row.unrealizedProfitUsd),labels:labels(row.labels),
        firstAcquiredAt:at(row.firstAcquiredAt)&&at(row.firstAcquiredAt)!<=observed?at(row.firstAcquiredAt):undefined,
        lastActiveAt:at(row.lastActiveAt)&&at(row.lastActiveAt)!<=observed?at(row.lastActiveAt):undefined,
        exitedAt:at(row.exitedAt)&&at(row.exitedAt)!<=observed?at(row.exitedAt):undefined,
        buyVolumeUsd:positiveDecimal(row.buyVolumeUsd),sellVolumeUsd:positiveDecimal(row.sellVolumeUsd),balance:positiveDecimal(row.balance),
        rankScope:['vendor_profit_order','vendor_unrealized_profit_order','vendor_buy_volume_order','vendor_sell_volume_order'].includes(row.rankScope??'')?row.rankScope:undefined,
        sampleLimit:row.sampleLimit===20||row.sampleLimit===100?row.sampleLimit:undefined,
        source:context.source,observedAt:observed,scope:'token_cumulative',verification:'vendor_claim'}];
    });
    this.append(values,()=>{const changes=this.associationChanges();this.putToken(target,observed);for(const value of values) {
      this.putWallet(target.chain,value.wallet,observed,value,changes);this.putWalletToken(target.chain,value.wallet,target.address);
      this.observation('token_trader',value,value.wallet,target.address);
    }this.flushAssociationChanges(changes);});
  }

  /** A funding snapshot has its own provenance; no fabricated holding is required. */
  captureFunding(token:WalletHistoryToken,walletAddress:string,funding:{address:string;label?:string|null;sharedService?:boolean;conflict?:boolean;
    timestamp?:string|null;txHash?:string|null;amount?:string|null},context:WalletHistoryContext&{snapshotAt?:string}):void {
    const target=this.target(token),observed=this.observed(context.observedAt);if(!target||!observed||!source(context.source)||!funding) return;
    const wallet=addr(walletAddress,target.chain),fundingAddress=addr(funding.address,target.chain),snapshotAt=at(context.snapshotAt??observed),eventAt=funding.timestamp?at(funding.timestamp):undefined;
    if(!wallet||!fundingAddress||!snapshotAt||snapshotAt>observed||funding.timestamp&&(!eventAt||eventAt>snapshotAt)||
      funding.txHash&&!addr(funding.txHash,target.chain,true)) return;
    const value:WalletFundingEdge={chain:target.chain,wallet,fundingAddress,source:context.source,observedAt:observed,snapshotAt,
      eventAt,txHash:funding.txHash?addr(funding.txHash,target.chain,true):undefined,amount:positiveDecimal(funding.amount),label:clean(funding.label),
      sharedService:funding.sharedService===true,conflict:funding.conflict===true,verification:'vendor_claim'};
    this.append(value,()=>{const changes=this.associationChanges();this.putWallet(target.chain,wallet,observed,{},changes);
      this.putToken(target,observed);this.putFunding(value,changes);this.flushAssociationChanges(changes);});
  }

  refreshAssociations(limit=3,flushInvalidations=true):number {
    if(flushInvalidations&&!this.prepareAssociationRefresh())return 0;
    const result=this.associations.refresh(limit);return result.indexed+result.refreshed;
  }
  listAssociations(options:WalletAssociationListOptions={}) {return this.associations.list(options);}
  /** Bounded raw observations preserve contrary vendor copies for the screening model. */
  screeningEvidence(value:WalletHistoryToken,now=new Date()):{trades:WalletTradeObservation[];truncated:boolean} {
    const target=this.target(value),end=this.observed(now.toISOString());if(!target||!end)return {trades:[],truncated:true};
    const start=new Date(Date.parse(end)-3_600_000).toISOString();
    const rows=this.db.prepare(`SELECT data FROM wh_observations INDEXED BY wh_exit_evidence
      WHERE chain=? AND token_address=? AND kind='trade' AND observed_at>=? AND observed_at<=?
      ORDER BY observed_at DESC LIMIT 501`).all(target.chain,target.address,start,end);
    return {trades:rows.slice(0,500).flatMap(row=>{try{return [JSON.parse(String(row.data)) as WalletTradeObservation];}catch{return [];}}),truncated:rows.length>500};
  }

  /** Read-only event evidence known by this quote time; later wallet labels are deliberately not consulted. */
  followupEvidence(value:WalletHistoryToken,fromAt:string,untilAt:string):FollowupWalletEvidence {
    const target=this.target(value),start=at(fromAt),end=at(untilAt);
    const result:FollowupWalletEvidence={fromAt:start??'',untilAt:end??'',coverage:'unavailable',trades:[],
      buyUsd:null,sellUsd:null,netBuyUsd:null,buyerCount:null,sellerCount:null,evidenceCount:0,excludedCount:0,
      limitations:['MONITORED_WALLET_SAMPLE_NOT_WHOLE_MARKET','NO_OBSERVATION_DOES_NOT_MEAN_NO_TRADE','VENDOR_REPORTED_NOT_OWNERSHIP_PROOF']};
    if(!target||!start||!end||start>end||Date.parse(end)>this.now().getTime()||
      (target.chain==='solana'?!bs58.decode(target.address).some(byte=>byte!==0):/^0x0{40}$/.test(target.address))) {
      result.limitations.push('WALLET_REVIEW_WINDOW_INVALID');return result;
    }
    result.chain=target.chain;result.address=target.address;
    try {
      const rows=this.db.prepare(`SELECT id,chain,wallet,token_address,source,observed_at,data
        FROM wh_observations INDEXED BY wh_exit_evidence
        WHERE chain=? AND token_address=? AND kind='trade' AND observed_at>=? AND observed_at<=?
        ORDER BY observed_at,id LIMIT 501`).all(target.chain,target.address,start,end);
      if(rows.length>500) {
        result.coverage='truncated';result.limitations.push('WALLET_OBSERVATIONS_LIMIT_500');return result;
      }
      type Evidence={trade:FollowupWalletEvidence['trades'][number];raw:WalletTradeObservation;copies:number;conflict:boolean};
      const groups=new Map<string,Map<string,Evidence>>(),outsideWindow=new Set<string>();
      for(const row of rows) {
        let raw:WalletTradeObservation|undefined;
        try {raw=this.trade(JSON.parse(String(row.data)) as WalletTradeObservation);}catch {raw=undefined;}
        if(!raw||raw.chain!==target.chain||raw.tokenAddress!==target.address||raw.wallet!==row.wallet||
          raw.source!==row.source||raw.observedAt!==row.observed_at||!['buy','sell'].includes(raw.side)||
          raw.observedAt<start||raw.observedAt>end) {
          result.excludedCount++;continue;
        }
        const groupKey=JSON.stringify([raw.txHash,raw.wallet,raw.side]);
        if(raw.eventAt<start||raw.eventAt>end) {
          // A contrary timestamp already observed in this window cannot be hidden by the event-time filter.
          outsideWindow.add(groupKey);result.excludedCount++;continue;
        }
        if(!raw.usd) {result.excludedCount++;continue;}
        const amount=Number(raw.usd);
        if(!Number.isFinite(amount)||amount<=0||amount>1e12) {result.excludedCount++;continue;}
        let group=groups.get(groupKey);if(!group) {group=new Map();groups.set(groupKey,group);}
        const index=raw.eventIndex===undefined?'unindexed':String(raw.eventIndex),previous=group.get(index);
        if(previous) {
          previous.copies++;
          if(previous.raw.eventAt!==raw.eventAt||previous.trade.volumeUsd!==amount)previous.conflict=true;
          continue;
        }
        group.set(index,{copies:1,conflict:false,raw,trade:{evidenceId:String(row.id),txHash:raw.txHash,wallet:raw.wallet,
          side:raw.side as 'buy'|'sell',volumeUsd:amount,eventAt:raw.eventAt,observedAt:raw.observedAt,source:raw.source}});
      }
      const trades:FollowupWalletEvidence['trades']=[];
      for(const [groupKey,group] of groups) {
        const entries=[...group.values()],unindexed=group.get('unindexed'),indexed=[...group.entries()]
          .filter(([index])=>index!=='unindexed').map(([,entry])=>entry);
        if(outsideWindow.has(groupKey)||entries.some(entry=>entry.conflict)||unindexed&&indexed.length&&
          (indexed.length!==1||unindexed.trade.volumeUsd!==indexed[0].trade.volumeUsd||unindexed.raw.eventAt!==indexed[0].raw.eventAt)) {
          result.excludedCount+=entries.reduce((n,entry)=>n+entry.copies,0);continue;
        }
        // A later indexed copy retains its own observation time; it does not backdate index knowledge.
        trades.push(...(unindexed&&indexed.length?indexed:entries).map(entry=>entry.trade));
      }
      trades.sort((a,b)=>a.observedAt.localeCompare(b.observedAt)||a.evidenceId.localeCompare(b.evidenceId));
      result.coverage='sampled';result.evidenceCount=trades.length;result.trades=trades.slice(0,40);
      result.buyUsd=trades.filter(trade=>trade.side==='buy').reduce((sum,trade)=>sum+trade.volumeUsd,0);
      result.sellUsd=trades.filter(trade=>trade.side==='sell').reduce((sum,trade)=>sum+trade.volumeUsd,0);
      result.netBuyUsd=result.buyUsd-result.sellUsd;
      result.buyerCount=new Set(trades.filter(trade=>trade.side==='buy').map(trade=>trade.wallet)).size;
      result.sellerCount=new Set(trades.filter(trade=>trade.side==='sell').map(trade=>trade.wallet)).size;
      if(result.excludedCount)result.limitations.push('INVALID_OR_AMBIGUOUS_OBSERVATIONS_EXCLUDED');
      if(trades.length>40)result.limitations.push('EVIDENCE_EXAMPLES_LIMIT_40');
      return result;
    } catch {result.limitations.push('WALLET_REVIEW_READ_FAILED');return result;}
  }
  screeningWalletCandidates(now=new Date(),offset=0):WalletTradeObservation[] {
    const end=now.toISOString(),start=new Date(now.getTime()-600000).toISOString();
    const wallets=this.db.prepare('SELECT chain,address FROM wh_wallets INDEXED BY wh_wallets_recent WHERE last_at>=? AND last_at<=? ORDER BY last_at DESC LIMIT 40 OFFSET ?').all(start,end,Math.max(0,Math.min(2000,offset)));
    const buy=this.db.prepare(`SELECT data FROM wh_events INDEXED BY wh_events_wallet WHERE chain=? AND wallet=? AND side='buy'
      AND event_at>=? AND event_at<=? AND observed_at<=? ORDER BY event_at DESC LIMIT 2`);
    return wallets.flatMap(w=>buy.all(w.chain!,w.address!,start,end,end).flatMap(row=>{try{return [JSON.parse(String(row.data)) as WalletTradeObservation];}catch{return [];}}));
  }
  getAssociation(chain:Chain,leader:string,candidate:string) {
    if(!chainValid(chain)) return;const a=addr(leader,chain),b=addr(candidate,chain);return a&&b?this.associations.detail(chain,a,b):undefined;
  }
  associationStats() {return this.associations.stats();}
  associationInvalidationStatus():{pending:number} {
    return {pending:Number(this.db.prepare('SELECT count(*) AS n FROM wh_association_invalidations').get()!.n)};
  }

  /**
   * Apply a small durable batch away from the stream/HTTP loop. The queue row
   * and every derived dirty bit share one transaction, so a crash either keeps
   * the work for a retry or commits it completely.
   */
  flushAssociationInvalidations(limit=64):{touched:number;completed:number;remaining:boolean} {
    // A job can legitimately touch no derived row. Keep both touched rows and
    // completed zero-work jobs within the caller's batch ceiling so a queue of
    // new wallets cannot grow behind an unrelated fixed 32-job limit.
    const take=Number.isSafeInteger(limit)?Math.max(1,Math.min(128,limit)):64,jobLimit=take;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows=this.db.prepare(`SELECT kind,chain,address,stage,cursor FROM wh_association_invalidations
        ORDER BY CASE kind WHEN 'public_service' THEN 0 WHEN 'funding_address' THEN 1 ELSE 2 END,enqueued_at,rowid LIMIT ?`)
        .all(jobLimit) as {kind:AssociationInvalidationKind;chain:Chain;address:string;stage:number;cursor:string|null}[];
      if(!rows.length){this.db.exec('COMMIT');return {touched:0,completed:0,remaining:false};}
      let budget=take,touched=0,completed=0;
      const remove=this.db.prepare('DELETE FROM wh_association_invalidations WHERE kind=? AND chain=? AND address=?'),
        progress=this.db.prepare('UPDATE wh_association_invalidations SET stage=?,cursor=? WHERE kind=? AND chain=? AND address=?'),
        recipientPage=this.db.prepare(`SELECT DISTINCT wallet FROM wh_funding INDEXED BY wh_funding_recipients
          WHERE chain=? AND funding_address=? AND wallet>? ORDER BY wallet LIMIT ?`),
        dirtyMetric=this.db.prepare('UPDATE wh_metrics SET coordination_dirty=1 WHERE chain=? AND address=? AND coordination_dirty<>1'),
        enqueueWallet=this.db.prepare(`INSERT OR IGNORE INTO wh_association_invalidations(kind,chain,address,enqueued_at)
          VALUES ('funding_wallet',?,?,?)`),
        dirtyAnchor=this.db.prepare('UPDATE wh_assoc_anchors SET dirty=1 WHERE chain=? AND leader=? AND token_address=? AND dirty<>1'),
        dirtyRelation=this.db.prepare('UPDATE wh_assoc_relations SET dirty=1 WHERE chain=? AND leader=? AND candidate=? AND dirty<>1');
      for(const row of rows) {
        if(budget<=0)break;
        if(row.kind==='funding_address'||row.kind==='public_service') {
          const pageSize=budget,page=recipientPage.all(row.chain,row.address,row.cursor??'',pageSize).map(item=>String(item.wallet));
          for(const wallet of page) {
            if(row.kind==='funding_address')dirtyMetric.run(row.chain,wallet);
            else enqueueWallet.run(row.chain,wallet,this.now().toISOString());
          }
          touched+=page.length;budget-=page.length;
          if(page.length<pageSize){remove.run(row.kind,row.chain,row.address);completed++;}
          else progress.run(0,page.at(-1)!,row.kind,row.chain,row.address);
          continue;
        }
        if(row.kind!=='funding_wallet')throw new Error('WALLET_ASSOCIATION_INVALIDATION_INVALID');
        let stage=Number(row.stage),cursor=row.cursor;
        while(stage<4&&budget>0) {
          const pageSize=budget;
          if(stage===0) {
            const page=this.db.prepare(`SELECT token_address FROM wh_assoc_anchors INDEXED BY sqlite_autoindex_wh_assoc_anchors_1
              WHERE chain=? AND leader=? AND token_address>? ORDER BY token_address LIMIT ?`)
              .all(row.chain,row.address,cursor??'',pageSize).map(item=>String(item.token_address));
            for(const token of page)dirtyAnchor.run(row.chain,row.address,token);
            touched+=page.length;budget-=page.length;
            if(page.length===pageSize){cursor=page.at(-1)!;progress.run(stage,cursor,row.kind,row.chain,row.address);break;}
          } else if(stage===1) {
            let pair=['',''];try {const parsed=cursor&&JSON.parse(cursor);if(Array.isArray(parsed)&&parsed.length===2)pair=parsed.map(String);}catch{/* Restart phase from a safe lower cursor. */}
            const page=this.db.prepare(`SELECT DISTINCT leader,token_address FROM wh_assoc_episodes INDEXED BY wh_assoc_episode_candidate
              WHERE chain=? AND candidate=? AND active=1 AND (leader>? OR (leader=? AND token_address>?))
              ORDER BY leader,token_address LIMIT ?`).all(row.chain,row.address,pair[0],pair[0],pair[1],pageSize)
              .map(item=>[String(item.leader),String(item.token_address)] as const);
            for(const [leader,token] of page)dirtyAnchor.run(row.chain,leader,token);
            touched+=page.length;budget-=page.length;
            if(page.length===pageSize){cursor=JSON.stringify(page.at(-1)!);progress.run(stage,cursor,row.kind,row.chain,row.address);break;}
          } else if(stage===2) {
            const page=this.db.prepare(`SELECT candidate FROM wh_assoc_relations INDEXED BY sqlite_autoindex_wh_assoc_relations_1
              WHERE chain=? AND leader=? AND candidate>? ORDER BY candidate LIMIT ?`)
              .all(row.chain,row.address,cursor??'',pageSize).map(item=>String(item.candidate));
            for(const candidate of page)dirtyRelation.run(row.chain,row.address,candidate);
            touched+=page.length;budget-=page.length;
            if(page.length===pageSize){cursor=page.at(-1)!;progress.run(stage,cursor,row.kind,row.chain,row.address);break;}
          } else {
            const page=this.db.prepare(`SELECT leader FROM wh_assoc_relations INDEXED BY wh_assoc_relation_candidate_leader
              WHERE chain=? AND candidate=? AND leader>? ORDER BY leader LIMIT ?`)
              .all(row.chain,row.address,cursor??'',pageSize).map(item=>String(item.leader));
            for(const leader of page)dirtyRelation.run(row.chain,leader,row.address);
            touched+=page.length;budget-=page.length;
            if(page.length===pageSize){cursor=page.at(-1)!;progress.run(stage,cursor,row.kind,row.chain,row.address);break;}
          }
          stage++;cursor=null;
          if(stage<4)progress.run(stage,null,row.kind,row.chain,row.address);
        }
        if(stage>=4){remove.run(row.kind,row.chain,row.address);completed++;}
      }
      const remaining=!!this.db.prepare('SELECT 1 FROM wh_association_invalidations LIMIT 1').get();
      this.db.exec('COMMIT');return {touched,completed,remaining};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  associationTargets(chain:Chain,limit=5,mode:'recent'|'known'='recent'):WalletAssociationTarget[] {return chainValid(chain)?this.associations.targets(chain,limit,mode):[];}
  streamWalletTargets(chain:Chain,limit=10):string[] {
    if(!chainValid(chain))return [];
    const cap=Math.max(1,Math.min(30,Math.trunc(limit))),result=new Set<string>();
    const add=(v:unknown)=>{const a=addr(v,chain);if(a&&result.size<cap)result.add(a);};
    // Prioritize observed early-wallet / leader relationships; a relationship remains a hypothesis.
    for(const r of this.db.prepare(`SELECT candidate,leader FROM wh_assoc_relations INDEXED BY wh_stream_relations WHERE chain=? AND token_count>0 AND dirty=0
      ORDER BY token_count DESC,forward_count DESC,updated_at DESC LIMIT ?`).all(chain,cap)) {add(r.candidate);add(r.leader);}
    if(result.size<cap)for(const r of this.db.prepare('SELECT address FROM wh_wallets INDEXED BY wh_stream_recent_wallets WHERE chain=? ORDER BY last_at DESC LIMIT ?').all(chain,cap))add(r.address);
    return [...result];
  }
  markAssociationTargetChecked(target:Pick<WalletAssociationTarget,'chain'|'address'|'anchorWallet'|'candidateWallet'|'historicalRelationship'>,observedAt=this.now().toISOString()):void {
    const token=this.target(target),observed=this.observed(observedAt),leader=token&&addr(target.anchorWallet,token.chain);
    if(token&&observed&&leader) this.associations.markTarget({...token,anchorWallet:leader,
      candidateWallet:target.candidateWallet?addr(target.candidateWallet,token.chain):undefined,historicalRelationship:target.historicalRelationship===true},observed);
  }

  recordCollection(value:WalletCollectionObservation):void {
    const completed=this.observed(value?.completedAt),started=at(value?.startedAt);
    if(!completed||!started||started>completed||!source(value.source)||value.chain!==undefined&&!chainValid(value.chain)||
      !['ok','partial','cooldown','stopped'].includes(value.status)||count(value.requests)===null||count(value.accepted)===null||value.coverage!=='one_page_sample') return;
    const data={source:value.source,chain:value.chain,startedAt:started,completedAt:completed,observedAt:completed,
      status:value.status,requests:value.requests,accepted:value.accepted,rejected:count(value.rejected)??undefined,
      coverage:'one_page_sample',hasMore:typeof value.hasMore==='boolean'?value.hasMore:null,reason:code(value.reason)};
    this.append(data,()=>this.observation('collection',data));
  }

  watchTargets(limit=20,_now=this.now(),chain?:Chain):WalletHistoryToken[] {
    const n=Number.isSafeInteger(limit)?Math.max(1,Math.min(200,limit)):20;
    return this.db.prepare(`SELECT chain,address FROM wh_tokens ${chain?'WHERE chain=?':''} ORDER BY COALESCE(last_checked_at,''),first_at,chain,address LIMIT ?`)
      .all(...(chain?[chain,n]:[n])).map(row=>({chain:row.chain as Chain,address:String(row.address)}));
  }
  markTargetChecked(value:WalletHistoryToken,observedAt=this.now().toISOString()):void {
    const target=this.target(value),observed=this.observed(observedAt);if(!target||!observed) return;
    this.append({target,observed},()=>this.db.prepare('UPDATE wh_tokens SET last_checked_at=MAX(COALESCE(last_checked_at,?),?) WHERE chain=? AND address=?')
      .run(observed,observed,target.chain,target.address));
  }

  recordPrice(value:WalletHistoryToken,priceUsd:number,observedAt:string,provider:string):void {
    const target=this.target(value),observed=this.observed(observedAt);
    if(!target||!observed||!source(provider)||!Number.isFinite(priceUsd)||priceUsd<=0) return;
    this.append({target,priceUsd,observed,provider},()=>{
      this.putToken(target,observed);
      const id=digest([target.chain,target.address,observed,provider,priceUsd]);
      const inserted=this.db.prepare('INSERT OR IGNORE INTO wh_prices VALUES (?,?,?,?,?,?)').run(id,target.chain,target.address,observed,priceUsd,provider);
      if(!Number(inserted.changes)) return;
      const buyers=this.db.prepare("SELECT wallet,MIN(observed_at) AS observed FROM wh_events INDEXED BY wh_events_token WHERE chain=? AND token_address=? AND side='buy' GROUP BY wallet")
        .all(target.chain,target.address);
      for(const buyer of buyers) {
        if(observed<=String(buyer.observed)) continue;
        const prior=this.db.prepare('SELECT data FROM wh_gains WHERE chain=? AND wallet=? AND token_address=?').get(target.chain,buyer.wallet!,target.address);
        const old=prior?JSON.parse(String(prior.data)) as WalletGainEvidence:undefined;
        if(old&&observed<=old.latestAt) continue;
        const baseline=old?.baselinePriceUsd??priceUsd,gain=(priceUsd/baseline-1)*100;if(!Number.isFinite(gain)) continue;
        const peak=!old||priceUsd>old.peakPriceUsd;
        const data:WalletGainEvidence={tokenAddress:target.address,baselineAt:old?.baselineAt??observed,baselinePriceUsd:baseline,
          peakAt:peak?observed:old!.peakAt,peakPriceUsd:peak?priceUsd:old!.peakPriceUsd,maxGainPct:Math.max(old?.maxGainPct??0,gain),
          latestAt:observed,latestPriceUsd:priceUsd,source:provider,kind:'first_post_observed_buy_quote'};
        this.db.prepare('INSERT INTO wh_gains VALUES (?,?,?,?) ON CONFLICT(chain,wallet,token_address) DO UPDATE SET data=excluded.data')
          .run(target.chain,buyer.wallet!,target.address,JSON.stringify(data));
        this.db.prepare('UPDATE wh_metrics SET gain_pct=?,gain_data=? WHERE chain=? AND address=? AND (gain_pct IS NULL OR gain_pct<=?)')
          .run(data.maxGainPct,JSON.stringify(data),target.chain,buyer.wallet!,data.maxGainPct);
      }
    });
  }

  /** Only evidence already locally observed at the price sample's time can influence research. */
  recentExitPressure(value:WalletHistoryToken,sampleAt:string):WalletPressure|undefined {
    return readRecentExitPressure(this.db,value,sampleAt,this.now().getTime());
  }

  listWallets(options:WalletHistoryListOptions={}):{items:WalletHistorySummary[];total:number} {
    return readWalletHistoryList(this.db,options);
  }

  getWallet(chain:Chain,address:string):WalletHistoryDetail|undefined {
    return readWalletHistoryDetail(this.db,chain,address,this.now());
  }

  stats():WalletHistoryStats {
    const n=(table:string,where='')=>Number(this.db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get()!.n);
    const time=this.db.prepare('SELECT MIN(first_at) AS first,MAX(last_at) AS last FROM wh_wallets').get()!;
    return {wallets:n('wh_wallets'),events:n('wh_events'),observations:n('wh_observations'),tokens:n('wh_tokens'),prices:n('wh_prices'),
      snapshots:n('wh_observations',"WHERE kind IN ('holding','stats','token_trader','token_rank')"),fundingLinks:n('wh_funding'),
      collections:n('wh_observations',"WHERE kind='collection'"),
      nominations:n('wh_observations',"WHERE kind='vendor_nomination'"),
      coordinationPending:n('wh_metrics','WHERE coordination_dirty=1 OR coordination_checked_at IS NULL'),firstObservedAt:time.first?String(time.first):undefined,
      lastObservedAt:time.last?String(time.last):undefined,bytes:this.bytes(),maxBytes:this.maxBytes,error:this.error,
      sampleOnly:true,exactRealizedPnl:false,researchSeeds:this.researchSeeds.status()};
  }
  close():void {this.db.close();}

  /** Bounded background refresh; listing wallets never performs graph self-joins. */
  refreshCoordination(limit=10,flushInvalidations=true):number {
    if(flushInvalidations&&!this.prepareAssociationRefresh())return 0;
    const n=Number.isSafeInteger(limit)?Math.max(1,Math.min(20,limit)):10;
    const dirty=this.db.prepare("SELECT chain,address FROM wh_metrics INDEXED BY wh_metrics_coord_queue WHERE coordination_dirty=1 ORDER BY COALESCE(coordination_checked_at,''),chain,address LIMIT ?").all(n);
    const updates=dirty.map(row=>({chain:row.chain as Chain,wallet:String(row.address),data:this.coordination(row.chain as Chain,String(row.address))}));
    if(!updates.length) return 0;
    this.append(updates,()=>{for(const update of updates) {
      const shared=new Set(update.data.sharedFunding.map(item=>item.wallet)).size,synced=new Set(update.data.synchronized.map(item=>item.wallet)).size;
      this.db.prepare('UPDATE wh_metrics SET coordination_score=?,coordination_data=?,coordination_checked_at=?,coordination_dirty=0 WHERE chain=? AND address=?')
        .run(Math.min(100,shared*10+synced*20),JSON.stringify(update.data),this.now().toISOString(),update.chain,update.wallet);
    }});
    return updates.length;
  }

  private observed(value:string):string|undefined {const stamp=at(value);return stamp&&Date.parse(stamp)<=this.now().getTime()?stamp:undefined;}
  private target(value:WalletHistoryToken):WalletHistoryToken|undefined {
    if(!value||!chainValid(value.chain)) return;const address=addr(value.address,value.chain);return address?{chain:value.chain,address}:undefined;
  }
  private trade(value:WalletTradeObservation):WalletTradeObservation|undefined {
    if(!value||!chainValid(value.chain)||!source(value.source)) return;
    const wallet=addr(value.wallet,value.chain),tokenAddress=addr(value.tokenAddress,value.chain),txHash=addr(value.txHash,value.chain,true);
    const eventAt=at(value.eventAt),observedAt=this.observed(value.observedAt);
    if(!wallet||!tokenAddress||!txHash||!eventAt||!observedAt||eventAt>observedAt||
      !['buy','sell','transferIn','transferOut','add','remove'].includes(value.side)||
      value.eventIndex!==undefined&&count(value.eventIndex)===null) return;
    return {chain:value.chain,wallet,tokenAddress,txHash,side:value.side,eventAt,observedAt,source:value.source,
      amount:positiveDecimal(value.amount),amountUnit:['human','atomic','vendor_quantity'].includes(String(value.amountUnit))?value.amountUnit:'unknown',
      usd:positiveDecimal(value.usd),priceUsd:positiveDecimal(value.priceUsd),...(value.eventIndex===undefined?{}:{eventIndex:value.eventIndex})};
  }
  private putTrade(value:WalletTradeObservation,changes:AssociationChanges):void {
    const id=digest([value.chain,value.wallet,value.tokenAddress,value.txHash,value.side,value.eventIndex??null]);
    this.putWallet(value.chain,value.wallet,value.observedAt,{},changes);this.putToken({chain:value.chain,address:value.tokenAddress},value.observedAt);
    this.putWalletToken(value.chain,value.wallet,value.tokenAddress);
    const inserted=this.db.prepare('INSERT OR IGNORE INTO wh_events VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,value.chain,value.wallet,value.tokenAddress,value.txHash,value.side,value.eventAt,value.observedAt,JSON.stringify(value));
    if(Number(inserted.changes)) {
      this.db.prepare('UPDATE wh_metrics SET event_count=event_count+1,buy_count=buy_count+?,sell_count=sell_count+?,coordination_dirty=1 WHERE chain=? AND address=?')
        .run(value.side==='buy'?1:0,value.side==='sell'?1:0,value.chain,value.wallet);
      this.db.prepare('UPDATE wh_metrics SET coordination_dirty=1 WHERE chain=? AND coordination_dirty<>1 AND address IN (SELECT wallet FROM wh_events WHERE chain=? AND token_address=? AND side=? AND event_at BETWEEN ? AND ?)')
        .run(value.chain,value.chain,value.tokenAddress,value.side,new Date(Date.parse(value.eventAt)-120_000).toISOString(),new Date(Date.parse(value.eventAt)+120_000).toISOString());
    }
    // Repeated polling from one source is one observation; a second source or
    // conflicting normalized content remains separate evidence, never a second trade.
    const {observedAt:_,...content}=value;
    const evidenceId=digest(['trade',id,content]);
    const newEvidence=!this.db.prepare('SELECT 1 FROM wh_observations WHERE id=?').get(evidenceId);
    this.observation('trade',value,value.wallet,value.tokenAddress,id,evidenceId);
    if(Number(inserted.changes)||newEvidence) this.associations.recordTrade(value);
  }
  private putWallet(chain:Chain,address:string,observed:string,profile:{labels?:string[];name?:string;twitter?:string},changes:AssociationChanges):void {
    const previous=this.db.prepare('SELECT profile,last_at FROM wh_wallets WHERE chain=? AND address=?').get(chain,address);
    const old=previous?JSON.parse(String(previous.profile)):{labels:[]};
    const latest=!previous||observed>=String(previous.last_at);
    const compact={labels:[...new Set([...old.labels,...labels(profile.labels)])].slice(0,16),
      name:latest?clean(profile.name)??old.name:old.name,twitter:latest?twitter(profile.twitter)??old.twitter:old.twitter};
    this.db.prepare('INSERT INTO wh_wallets VALUES (?,?,?,?,?) ON CONFLICT(chain,address) DO UPDATE SET first_at=MIN(first_at,excluded.first_at),last_at=MAX(last_at,excluded.last_at),profile=excluded.profile')
      .run(chain,address,observed,observed,JSON.stringify(compact));
    this.db.prepare(`INSERT INTO wh_metrics(chain,address,last_at) VALUES (?,?,?)
      ON CONFLICT(chain,address) DO UPDATE SET last_at=excluded.last_at
      WHERE wh_metrics.last_at IS NULL OR wh_metrics.last_at<excluded.last_at`).run(chain,address,observed);
    const serviceLabels=['exchange_or_pool','exchange','pool','router','bridge','cex'];
    if(compact.labels.some(label=>serviceLabels.includes(label))&&!old.labels.some((label:string)=>serviceLabels.includes(label)))
      this.change(changes.publicServices,chain,address);
  }
  private putWalletToken(chain:Chain,wallet:string,tokenAddress:string):void {
    if(Number(this.db.prepare('INSERT OR IGNORE INTO wh_wallet_tokens VALUES (?,?,?)').run(chain,wallet,tokenAddress).changes))
      this.db.prepare('UPDATE wh_metrics SET token_count=token_count+1 WHERE chain=? AND address=?').run(chain,wallet);
  }
  private putToken(token:WalletHistoryToken,observed:string):void {
    this.db.prepare('INSERT INTO wh_tokens VALUES (?,?,?,?,NULL) ON CONFLICT(chain,address) DO UPDATE SET first_at=MIN(first_at,excluded.first_at),last_at=MAX(last_at,excluded.last_at)')
      .run(token.chain,token.address,observed,observed);
  }
  private observation(kind:string,data:any,wallet?:string,token?:string,eventId?:string,id?:string):void {
    const {observedAt:_,...snapshot}=data;
    id??=digest([kind,data.snapshotAt?snapshot:data]);
    const inserted=this.db.prepare('INSERT OR IGNORE INTO wh_observations VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,kind,data.chain??null,wallet??null,token??null,eventId??null,data.source,data.observedAt,JSON.stringify(data));
    if(kind==='stats'&&wallet&&Number(inserted.changes)) {
      const numeric=data.realizedProfitUsd===null?NaN:Number(data.realizedProfitUsd),snapshotAt=data.snapshotAt??data.observedAt;
      this.db.prepare(`UPDATE wh_metrics SET profit_usd=?,profit_at=?,profit_observed_at=?,profit_data=? WHERE chain=? AND address=?
        AND (profit_at IS NULL OR profit_at<? OR (profit_at=? AND profit_observed_at<=?))`)
        .run(Number.isFinite(numeric)?numeric:null,snapshotAt,data.observedAt,JSON.stringify(data),data.chain,wallet,snapshotAt,snapshotAt,data.observedAt);
    }
  }
  private putFunding(value:WalletFundingEdge,changes:AssociationChanges):void {
    const {observedAt:_,...snapshot}=value;
    // A shared-service snapshot is repeated on every vendor refresh. Expanding
    // its recipients is only necessary when the funder first becomes public;
    // repeating the full invalidation can otherwise block the main event loop
    // for seconds on a widely used exchange/router address.
    const sharedAlreadyKnown=value.sharedService&&!!this.db.prepare(`SELECT 1 FROM wh_funding INDEXED BY wh_funding_coord_address
      WHERE chain=? AND funding_address=? AND shared=1 LIMIT 1`).get(value.chain,value.fundingAddress);
    const inserted=this.db.prepare('INSERT OR IGNORE INTO wh_funding(id,chain,wallet,funding_address,observed_at,shared,conflict,snapshot_at,data) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(digest(value.snapshotAt?snapshot:value),value.chain,value.wallet,value.fundingAddress,
        value.observedAt,value.sharedService?1:0,value.conflict?1:0,value.snapshotAt??value.observedAt,JSON.stringify(value));
    if(Number(inserted.changes)) {
      this.change(changes.fundingWallets,value.chain,value.wallet);this.change(changes.fundingAddresses,value.chain,value.fundingAddress);
      if(value.sharedService&&!sharedAlreadyKnown) this.change(changes.publicServices,value.chain,value.fundingAddress);
    }
  }
  private associationChanges():AssociationChanges {
    return {fundingWallets:new Map(),fundingAddresses:new Map(),publicServices:new Map()};
  }
  private change(values:Map<Chain,Set<string>>,chain:Chain,value:string):void {
    const group=values.get(chain)??new Set<string>();group.add(value);values.set(chain,group);
  }
  private flushAssociationChanges(changes:AssociationChanges):void {
    const insert=this.db.prepare('INSERT OR IGNORE INTO wh_association_invalidations(kind,chain,address,enqueued_at) VALUES (?,?,?,?)'),
      now=this.now().toISOString();
    for(const [chain,addresses] of changes.fundingWallets)for(const address of addresses)insert.run('funding_wallet',chain,address,now);
    for(const [chain,addresses] of changes.fundingAddresses)for(const address of addresses)insert.run('funding_address',chain,address,now);
    for(const [chain,addresses] of changes.publicServices)for(const address of addresses)insert.run('public_service',chain,address,now);
  }
  private prepareAssociationRefresh():boolean {
    for(let batch=0;batch<16;batch++)if(!this.flushAssociationInvalidations(64).remaining)return true;
    return false;
  }
  private snapshot(target:WalletHistoryToken,wallet:WalletRecord,provider:string,observedAt:string,snapshotAt?:string):
    {holding:WalletHoldingSnapshot;stats?:WalletVendorStats;funding?:WalletFundingEdge;events:WalletTradeObservation[]}|undefined {
    if(!wallet||wallet.chain!==target.chain) return;const address=addr(wallet.address,target.chain);if(!address) return;
    const h=wallet.holding,c=wallet.cumulative;
    const holding:WalletHoldingSnapshot={chain:target.chain,wallet:address,tokenAddress:target.address,source:provider,observedAt,snapshotAt,
      holding:{amount:positiveDecimal(h?.amount),usd:positiveDecimal(h?.usd),supplyRatio:ratio(h?.supplyRatio),currentlyHolding:typeof h?.currentlyHolding==='boolean'?h.currentlyHolding:null},
      cumulative:{scope:'vendor_token_cumulative',recentInflow:false,buyVolumeUsd:positiveDecimal(c?.buyVolumeUsd),sellVolumeUsd:positiveDecimal(c?.sellVolumeUsd),
        buyCount:count(c?.buyCount),sellCount:count(c?.sellCount),firstAcquiredAt:at(c?.firstAcquiredAt)??null,lastActiveAt:at(c?.lastActiveAt)??null,exitedAt:at(c?.exitedAt)??null},
      labels:labels(wallet.recognizedLabels),name:clean(wallet.vendorIdentity?.name),twitter:twitter(wallet.vendorIdentity?.twitterUsername),
      risks:[...new Set((wallet.risks??[]).flatMap(item=>code(item)??[]))].slice(0,20),
      developerLinks:[...new Set((wallet.developerLinks??[]).flatMap(item=>code(item)??[]))].slice(0,12),verification:'vendor_claim'};
    const s=wallet.enrichment?.stats;
    const stats:WalletVendorStats|undefined=s?.period==='7d'&&s.scope==='entire_wallet'?{chain:target.chain,wallet:address,source:provider,observedAt,snapshotAt,
      period:'7d',scope:'entire_wallet',realizedProfitUsd:decimal(s.realizedProfitUsd),winRate:ratio(s.winRate),verification:'vendor_claim'}:undefined;
    const f=wallet.funding,fundingAddress=f&&addr(f.address,target.chain);
    const funding:WalletFundingEdge|undefined=fundingAddress?{chain:target.chain,wallet:address,fundingAddress,source:provider,observedAt,snapshotAt,
      label:clean(f.label),eventAt:at(f.timestamp),txHash:addr(f.txHash,target.chain,true),amount:positiveDecimal(f.amount),
      sharedService:f.sharedService===true,conflict:f.conflict===true,verification:'vendor_claim'}:undefined;
    const events=(wallet.enrichment?.activity?.events??[]).slice(0,200).flatMap(event=>this.trade({chain:target.chain,wallet:address,
      tokenAddress:target.address,txHash:event.txHash,side:event.type,eventAt:event.timestamp,observedAt,source:provider,
      amount:event.amount,amountUnit:'vendor_quantity',usd:event.usd})??[]);
    return {holding,stats,funding,events};
  }
  private summary(row:Record<string,any>):WalletHistorySummary {
    return readWalletSummary(this.db,row);
  }
  private coordination(chain:Chain,wallet:string):WalletHistoryDetail['coordinationEvidence'] {
    return readWalletCoordination(this.db,chain,wallet);
  }
  private bytes():number {
    if(this.path===':memory:') return Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    let total=0;for(const path of [this.path,`${this.path}-wal`,`${this.path}-shm`]) {try {total+=statSync(path).size;} catch { /* An inactive WAL may not exist. */ }}
    return total;
  }
  private append(evidence:unknown,write:()=>unknown):void {
    // Reserve growth for indexes/WAL rather than filling the configured budget to
    // its last byte. Capacity errors are observable and never evict old research.
    if(this.error===CAPACITY) return;
    const estimate=Buffer.byteLength(JSON.stringify(evidence)??'')*3+32_768;
    if(this.bytes()+estimate>this.maxBytes) {this.capacity();return;}
    this.db.exec('BEGIN IMMEDIATE');
    try {
      write();
      const pages=Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
      if(Math.max(pages,this.bytes())+16_384>this.maxBytes) {this.db.exec('ROLLBACK');this.capacity();return;}
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  private capacity():void {
    this.error=CAPACITY;
    // One persistent marker only; repeated blocked polls must not grow the WAL.
    if(this.db.prepare("SELECT value FROM wh_meta WHERE key='error'").get()?.value!==CAPACITY)
      {this.db.prepare("UPDATE wh_meta SET value=? WHERE key='error'").run(CAPACITY);
        this.db.prepare("UPDATE wh_meta SET value=? WHERE key='capacity_limit'").run(String(this.maxBytes));}
  }
}
