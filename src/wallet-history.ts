import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {WalletAssociations,type WalletAssociationListOptions,type WalletAssociationTarget} from './wallet-associations.js';
export type {WalletAssociationSummary,WalletAssociationDetail,WalletAssociationStats,WalletAssociationTarget} from './wallet-associations.js';
import type {Chain,Report} from './types.js';
import type {WalletAnalysis,WalletRecord} from './research/wallet-types.js';
import type {WalletPressure,WalletPressureTrade,WalletTradeSource} from './adaptive-exit.js';

export interface WalletHistoryToken {chain:Chain;address:string;}
export interface WalletHistoryOptions {maxBytes?:number;now?:()=>Date;}
export interface WalletHistoryContext {source:string;observedAt:string;}
export interface WalletTradeObservation {
  chain:Chain;wallet:string;tokenAddress:string;txHash:string;
  side:'buy'|'sell'|'transferIn'|'transferOut'|'add'|'remove';eventAt:string;observedAt:string;
  amount?:string|null;amountUnit?:'human'|'atomic'|'unknown'|'vendor_quantity';usd?:string|null;
  priceUsd?:string|null;source:string;eventIndex?:number;
}
export interface WalletLeaderObservation {
  address:string;rank?:number;period:'7d';realizedProfitUsd?:string|null;winRate?:number|null;
  labels?:string[];name?:string;twitter?:string;
}
export interface WalletTokenRankObservation {address:string;rank:number;interval:'1h';changeMetric:string|null;changeUnit:'vendor_unspecified';priceUsd?:number;}
export interface WalletTokenTraderObservation {address:string;rank:number;profitUsd:string|null;realizedProfitUsd:string|null;unrealizedProfitUsd:string|null;labels?:string[];
  firstAcquiredAt?:string;exitedAt?:string;buyVolumeUsd?:string|null;sellVolumeUsd?:string|null;balance?:string|null;}
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
  coordination:{score:number;sharedFundingPeers:number;synchronizedPeers:number;evidenceCount:number;ownership:'unknown';scope:'heuristic';
    status:'pending'|'stale'|'current';checkedAt?:string};
}
export interface WalletHistoryDetail {
  wallet:WalletHistorySummary;timeline:WalletHistoryEvent[];holdings:WalletHoldingSnapshot[];fundingEdges:WalletFundingEdge[];
  vendorStats:WalletVendorStats[];gains:WalletGainEvidence[];
  tokenTraderSnapshots:({chain:Chain;wallet:string;tokenAddress:string;source:string;observedAt:string;scope:'token_cumulative';verification:'vendor_claim'}&Omit<WalletTokenTraderObservation,'address'>)[];
  coordinationEvidence:{sharedFunding:{address:string;wallet:string;observedAt:string}[];
    synchronized:{wallet:string;tokenAddress:string;distinctTransactions:number;windowSeconds:120}[]};
  coverage:{sampleOnly:true;exactRealizedPnl:false;eventCount:number;observationCount:number;firstObservedAt:string;lastObservedAt:string};
}
export interface WalletHistoryListOptions {chain?:Chain;sort?:'profit'|'gain'|'coordination'|'recent';search?:string;limit?:number;offset?:number;}
export interface WalletHistoryStats {
  wallets:number;events:number;observations:number;tokens:number;prices:number;snapshots:number;fundingLinks:number;collections:number;coordinationPending:number;
  firstObservedAt?:string;lastObservedAt?:string;bytes:number;maxBytes:number;error?:string;sampleOnly:true;exactRealizedPnl:false;
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

/** Long-lived research evidence. Never uses this data as a trading permission or deletes history to make space. */
export class WalletHistory {
  private readonly db:DatabaseSync;
  private readonly now:()=>Date;
  private readonly maxBytes:number;
  private error?:string;
  private readonly associations:WalletAssociations;
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
        coordination_score INTEGER DEFAULT 0,coordination_data TEXT,coordination_checked_at TEXT,coordination_dirty INTEGER DEFAULT 1,PRIMARY KEY(chain,address));
      CREATE TABLE IF NOT EXISTS wh_wallet_tokens(chain TEXT,wallet TEXT,token_address TEXT,PRIMARY KEY(chain,wallet,token_address));
      CREATE TABLE IF NOT EXISTS wh_report_captures(id TEXT PRIMARY KEY,observed_at TEXT);
      CREATE TABLE IF NOT EXISTS wh_meta(key TEXT PRIMARY KEY,value TEXT);
      INSERT OR IGNORE INTO wh_meta VALUES ('error','');
      INSERT OR IGNORE INTO wh_meta VALUES ('capacity_limit','0');
      CREATE INDEX IF NOT EXISTS wh_events_wallet ON wh_events(chain,wallet,event_at);
      CREATE INDEX IF NOT EXISTS wh_events_token ON wh_events(chain,token_address,side,event_at);
      CREATE INDEX IF NOT EXISTS wh_observations_wallet ON wh_observations(chain,wallet,kind,observed_at);
      CREATE INDEX IF NOT EXISTS wh_observations_event ON wh_observations(event_id);
      CREATE INDEX IF NOT EXISTS wh_exit_evidence ON wh_observations(chain,token_address,kind,observed_at);
      CREATE INDEX IF NOT EXISTS wh_funding_wallet ON wh_funding(chain,wallet,funding_address,observed_at);
      CREATE INDEX IF NOT EXISTS wh_funding_address ON wh_funding(chain,funding_address,observed_at);
      CREATE INDEX IF NOT EXISTS wh_wallets_recent ON wh_wallets(last_at DESC);
      CREATE INDEX IF NOT EXISTS wh_metrics_profit ON wh_metrics(profit_usd DESC);
      CREATE INDEX IF NOT EXISTS wh_metrics_gain ON wh_metrics(gain_pct DESC);
      CREATE INDEX IF NOT EXISTS wh_metrics_coordination ON wh_metrics(coordination_score DESC);
      CREATE INDEX IF NOT EXISTS wh_metrics_dirty ON wh_metrics(coordination_dirty,coordination_checked_at);`);
    if(!this.db.prepare('PRAGMA table_info(wh_funding)').all().some(column=>column.name==='snapshot_at')) {
      this.db.exec("ALTER TABLE wh_funding ADD COLUMN snapshot_at TEXT; UPDATE wh_funding SET snapshot_at=COALESCE(json_extract(data,'$.snapshotAt'),observed_at)");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS wh_funding_asof ON wh_funding(chain,wallet,funding_address,snapshot_at,observed_at)');
    this.error=String(this.db.prepare("SELECT value FROM wh_meta WHERE key='error'").get()?.value??'')||undefined;
    const previousLimit=Number(this.db.prepare("SELECT value FROM wh_meta WHERE key='capacity_limit'").get()?.value??0);
    if(this.error===CAPACITY&&this.maxBytes>previousLimit&&this.bytes()+32_768<this.maxBytes) {
      this.error=undefined;this.db.prepare("UPDATE wh_meta SET value='' WHERE key='error'").run();
    }
    this.associations=new WalletAssociations(this.db,(evidence,write)=>this.append(evidence,write),this.now);
    this.db.exec('CREATE INDEX IF NOT EXISTS wh_assoc_candidate ON wh_assoc_relations(chain,candidate,first_at)');
    if(this.bytes()>=this.maxBytes) this.error=CAPACITY;
  }

  recordTrade(input:WalletTradeObservation):void {this.recordTrades([input]);}
  recordTrades(inputs:WalletTradeObservation[]):void {
    const normalized=Array.isArray(inputs)?inputs.slice(0,2_000).map(value=>this.trade(value)).filter((v):v is WalletTradeObservation=>!!v):[];
    if(!normalized.length) return;
    this.append(normalized,()=>{for(const value of normalized) this.putTrade(value);});
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
      this.putToken(target,observed);
      for(const record of records) {
        this.putWallet(target.chain,record.holding.wallet,observed,{labels:record.holding.labels,name:record.holding.name,twitter:record.holding.twitter});
        this.putWalletToken(target.chain,record.holding.wallet,target.address);
        this.observation('holding',record.holding,record.holding.wallet,target.address);
        if(record.stats) this.observation('stats',record.stats,record.holding.wallet,target.address);
        if(record.funding) this.putFunding(record.funding);
        for(const event of record.events) this.putTrade(event);
      }
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
    this.append(values,()=>{for(const value of values) {
      this.putWallet(chain,value.wallet,observed,value);this.observation('stats',value,value.wallet);
    }});
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
        exitedAt:at(row.exitedAt)&&at(row.exitedAt)!<=observed?at(row.exitedAt):undefined,
        buyVolumeUsd:positiveDecimal(row.buyVolumeUsd),sellVolumeUsd:positiveDecimal(row.sellVolumeUsd),balance:positiveDecimal(row.balance),
        source:context.source,observedAt:observed,scope:'token_cumulative',verification:'vendor_claim'}];
    });
    this.append(values,()=>{this.putToken(target,observed);for(const value of values) {
      this.putWallet(target.chain,value.wallet,observed,value);this.putWalletToken(target.chain,value.wallet,target.address);
      this.observation('token_trader',value,value.wallet,target.address);
    }});
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
    this.append(value,()=>{this.putWallet(target.chain,wallet,observed,{});this.putToken(target,observed);this.putFunding(value);});
  }

  refreshAssociations(limit=3):void {this.associations.refresh(limit);}
  listAssociations(options:WalletAssociationListOptions={}) {return this.associations.list(options);}
  getAssociation(chain:Chain,leader:string,candidate:string) {
    if(!chainValid(chain)) return;const a=addr(leader,chain),b=addr(candidate,chain);return a&&b?this.associations.detail(chain,a,b):undefined;
  }
  associationStats() {return this.associations.stats();}
  associationTargets(chain:Chain,limit=5,mode:'recent'|'known'='recent'):WalletAssociationTarget[] {return chainValid(chain)?this.associations.targets(chain,limit,mode):[];}
  streamWalletTargets(chain:Chain,limit=10):string[] {
    if(!chainValid(chain))return [];
    const cap=Math.max(1,Math.min(30,Math.trunc(limit))),result=new Set<string>();
    const add=(v:unknown)=>{const a=addr(v,chain);if(a&&result.size<cap)result.add(a);};
    // Prioritize observed early-wallet / leader relationships; a relationship remains a hypothesis.
    for(const r of this.db.prepare(`SELECT candidate,leader FROM wh_assoc_relations WHERE chain=? AND token_count>0 AND dirty=0
      ORDER BY token_count DESC,forward_count DESC,updated_at DESC LIMIT ?`).all(chain,cap)) {add(r.candidate);add(r.leader);}
    if(result.size<cap)for(const r of this.db.prepare('SELECT address FROM wh_wallets WHERE chain=? ORDER BY last_at DESC LIMIT ?').all(chain,cap))add(r.address);
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
      const buyers=this.db.prepare("SELECT wallet,MIN(observed_at) AS observed FROM wh_events WHERE chain=? AND token_address=? AND side='buy' GROUP BY wallet")
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
    const target=this.target(value),end=at(sampleAt);if(!target||!end||Date.parse(end)>this.now().getTime())return;
    const start=new Date(Date.parse(end)-600_000).toISOString();
    const allowed=new Set(['gmgn_wallet_activity','gmgn_kol_feed','gmgn_smartmoney_feed',
      'gmgn_association_candidate_activity','gmgn_association_leader_activity','gmgn_association_wallet_activity']);
    const rows=this.db.prepare(`SELECT id,event_id,data FROM wh_observations WHERE chain=? AND token_address=? AND kind='trade'
      AND observed_at>=? AND observed_at<=? ORDER BY observed_at,id LIMIT 501`).all(target.chain,target.address,start,end);
    // A truncated side of a busy window must not be presented as net flow.
    if(rows.length>500)return;
    const known=new Map<string,boolean>();
    type Evidence={trade:WalletPressureTrade;eventAt:string;amount:number;conflict:boolean};
    const groups=new Map<string,Map<string,Evidence>>();
    for(const row of rows) {
      const raw=JSON.parse(String(row.data)) as WalletTradeObservation;
      if(!allowed.has(raw.source)||!['buy','sell'].includes(raw.side)||!raw.usd||!at(raw.eventAt)||
        raw.eventAt<start||raw.eventAt>end||!at(raw.observedAt)||raw.observedAt>end||raw.eventAt>raw.observedAt)continue;
      const usd=Number(raw.usd);if(!Number.isFinite(usd)||usd<=0||usd>1e12)continue;
      if(!known.has(raw.wallet)) {
        const publicEvidence=this.db.prepare(`SELECT 1 FROM wh_observations WHERE chain=? AND wallet=? AND kind='trade'
          AND source IN ('gmgn_kol_feed','gmgn_smartmoney_feed') AND observed_at<=? LIMIT 1`).get(target.chain,raw.wallet,end);
        const relationship=this.db.prepare(`SELECT 1 FROM wh_assoc_relations WHERE chain=? AND candidate=? AND first_at<=?
          AND active_since<=? AND dirty=0 AND token_count>0 LIMIT 1`).get(target.chain,raw.wallet,end,end);
        known.set(raw.wallet,!!publicEvidence||!!relationship);
      }
      if(!known.get(raw.wallet))continue;
      // Keep distinct indexed events, deduplicate equivalent vendor copies, and
      // exclude ambiguous unindexed/indexed groups rather than count either side twice.
      const key=JSON.stringify([raw.txHash,raw.wallet,raw.side]);
      let group=groups.get(key);if(!group){group=new Map();groups.set(key,group);}
      const index=raw.eventIndex===undefined?'unindexed':String(raw.eventIndex);
      const previous=group.get(index);
      if(previous) {if(previous.eventAt!==raw.eventAt||previous.amount!==usd)previous.conflict=true;continue;}
      group.set(index,{eventAt:raw.eventAt,amount:usd,conflict:false,trade:{evidenceId:String(row.id),wallet:raw.wallet,
        side:raw.side as 'buy'|'sell',volumeUsd:usd,eventAt:raw.eventAt,observedAt:raw.observedAt,source:raw.source as WalletTradeSource}});
    }
    const trades:WalletPressureTrade[]=[];
    for(const group of groups.values()) {
      if([...group.values()].some(e=>e.conflict))continue;
      const unindexed=group.get('unindexed'),indexed=[...group.entries()].filter(([key])=>key!=='unindexed').map(([,value])=>value);
      if(unindexed&&indexed.length) {
        if(indexed.length!==1||unindexed.amount!==indexed[0].amount||unindexed.eventAt!==indexed[0].eventAt)continue;
        trades.push(indexed[0].trade);
      }else trades.push(...[...group.values()].map(e=>e.trade));
    }
    if(!trades.length||trades.length>100)return;
    return {chain:target.chain,address:target.address,observedAt:end,windowStartAt:start,windowEndAt:end,trades};
  }

  listWallets(options:WalletHistoryListOptions={}):{items:WalletHistorySummary[];total:number} {
    const clauses:string[]=[],values:string[]=[];
    if(options.chain) {clauses.push('w.chain=?');values.push(options.chain);}
    if(options.search) {clauses.push('(instr(lower(w.address),?)>0 OR instr(lower(w.profile),?)>0)');const search=String(options.search).toLowerCase().slice(0,200);values.push(search,search);}
    const offset=Number.isSafeInteger(options.offset)?Math.max(0,options.offset!):0,limit=Number.isSafeInteger(options.limit)?Math.max(1,Math.min(200,options.limit!)):50;
    const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM wh_wallets w ${where}`).get(...values)!.n);
    const rank=options.sort==='profit'?'m.profit_usd DESC NULLS LAST,':options.sort==='gain'?'m.gain_pct DESC NULLS LAST,':
      options.sort==='coordination'?'m.coordination_score DESC,':'';
    const rows=this.db.prepare(`SELECT w.*,m.* FROM wh_wallets w JOIN wh_metrics m ON m.chain=w.chain AND m.address=w.address
      ${where} ORDER BY ${rank} w.last_at DESC,w.address LIMIT ? OFFSET ?`).all(...values,limit,offset);
    return {items:rows.map(row=>this.summary(row)),total};
  }

  getWallet(chain:Chain,address:string):WalletHistoryDetail|undefined {
    const wallet=addr(address,chain);if(!chainValid(chain)||!wallet) return;
    const row=this.db.prepare('SELECT w.*,m.* FROM wh_wallets w JOIN wh_metrics m ON m.chain=w.chain AND m.address=w.address WHERE w.chain=? AND w.address=?').get(chain,wallet);if(!row) return;
    const summary=this.summary(row);
    const coordinationEvidence=this.coordination(chain,wallet);
    summary.coordination=this.coordinationSummary(coordinationEvidence,'current',this.now().toISOString());
    const timeline=this.db.prepare('SELECT * FROM wh_events WHERE chain=? AND wallet=? ORDER BY event_at DESC LIMIT 100').all(chain,wallet).map(event=>{
      const evidence=this.db.prepare("SELECT data FROM wh_observations WHERE event_id=? AND kind='trade' ORDER BY observed_at LIMIT 20").all(event.id!).map(r=>JSON.parse(String(r.data)) as WalletTradeObservation);
      const first=JSON.parse(String(event.data)) as WalletTradeObservation;
      const contents=new Set(evidence.map(e=>JSON.stringify([e.eventAt,e.amount,e.amountUnit,e.usd,e.priceUsd])));
      return {...first,id:String(event.id),scope:first.eventIndex===undefined?'transaction_wallet_token_side' as const:'indexed_event' as const,
        ambiguous:first.eventIndex===undefined||contents.size>1,evidence};
    });
    const observations=(kind:string,limit=100)=>this.db.prepare('SELECT data FROM wh_observations WHERE chain=? AND wallet=? AND kind=? ORDER BY observed_at DESC LIMIT ?')
      .all(chain,wallet,kind,limit).map(r=>JSON.parse(String(r.data)));
    const observationCount=Number(this.db.prepare('SELECT count(*) AS n FROM wh_observations WHERE chain=? AND wallet=?').get(chain,wallet)!.n);
    return {wallet:summary,timeline,holdings:observations('holding'),vendorStats:observations('stats'),tokenTraderSnapshots:observations('token_trader'),
      fundingEdges:this.db.prepare('SELECT data FROM wh_funding WHERE chain=? AND wallet=? ORDER BY observed_at DESC LIMIT 100').all(chain,wallet).map(r=>JSON.parse(String(r.data))),
      gains:this.gains(chain,wallet),coordinationEvidence,
      coverage:{sampleOnly:true,exactRealizedPnl:false,eventCount:summary.observedEventCount,observationCount,
        firstObservedAt:summary.firstObservedAt,lastObservedAt:summary.lastObservedAt}};
  }

  stats():WalletHistoryStats {
    const n=(table:string,where='')=>Number(this.db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get()!.n);
    const time=this.db.prepare('SELECT MIN(first_at) AS first,MAX(last_at) AS last FROM wh_wallets').get()!;
    return {wallets:n('wh_wallets'),events:n('wh_events'),observations:n('wh_observations'),tokens:n('wh_tokens'),prices:n('wh_prices'),
      snapshots:n('wh_observations',"WHERE kind IN ('holding','stats','token_trader','token_rank')"),fundingLinks:n('wh_funding'),
      collections:n('wh_observations',"WHERE kind='collection'"),
      coordinationPending:n('wh_metrics','WHERE coordination_dirty=1 OR coordination_checked_at IS NULL'),firstObservedAt:time.first?String(time.first):undefined,
      lastObservedAt:time.last?String(time.last):undefined,bytes:this.bytes(),maxBytes:this.maxBytes,error:this.error,
      sampleOnly:true,exactRealizedPnl:false};
  }
  close():void {this.db.close();}

  /** Bounded background refresh; listing wallets never performs graph self-joins. */
  refreshCoordination(limit=10):void {
    const n=Number.isSafeInteger(limit)?Math.max(1,Math.min(20,limit)):10;
    const dirty=this.db.prepare("SELECT chain,address FROM wh_metrics WHERE coordination_dirty=1 ORDER BY COALESCE(coordination_checked_at,''),chain,address LIMIT ?").all(n);
    const updates=dirty.map(row=>({chain:row.chain as Chain,wallet:String(row.address),data:this.coordination(row.chain as Chain,String(row.address))}));
    if(!updates.length) return;
    this.append(updates,()=>{for(const update of updates) {
      const shared=new Set(update.data.sharedFunding.map(item=>item.wallet)).size,synced=new Set(update.data.synchronized.map(item=>item.wallet)).size;
      this.db.prepare('UPDATE wh_metrics SET coordination_score=?,coordination_data=?,coordination_checked_at=?,coordination_dirty=0 WHERE chain=? AND address=?')
        .run(Math.min(100,shared*10+synced*20),JSON.stringify(update.data),this.now().toISOString(),update.chain,update.wallet);
    }});
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
  private putTrade(value:WalletTradeObservation):void {
    const id=digest([value.chain,value.wallet,value.tokenAddress,value.txHash,value.side,value.eventIndex??null]);
    this.putWallet(value.chain,value.wallet,value.observedAt,{});this.putToken({chain:value.chain,address:value.tokenAddress},value.observedAt);
    this.putWalletToken(value.chain,value.wallet,value.tokenAddress);
    const inserted=this.db.prepare('INSERT OR IGNORE INTO wh_events VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,value.chain,value.wallet,value.tokenAddress,value.txHash,value.side,value.eventAt,value.observedAt,JSON.stringify(value));
    if(Number(inserted.changes)) {
      this.db.prepare('UPDATE wh_metrics SET event_count=event_count+1,buy_count=buy_count+?,sell_count=sell_count+?,coordination_dirty=1 WHERE chain=? AND address=?')
        .run(value.side==='buy'?1:0,value.side==='sell'?1:0,value.chain,value.wallet);
      this.db.prepare('UPDATE wh_metrics SET coordination_dirty=1 WHERE chain=? AND address IN (SELECT wallet FROM wh_events WHERE chain=? AND token_address=? AND side=? AND event_at BETWEEN ? AND ?)')
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
  private putWallet(chain:Chain,address:string,observed:string,profile:{labels?:string[];name?:string;twitter?:string}):void {
    const previous=this.db.prepare('SELECT profile,last_at FROM wh_wallets WHERE chain=? AND address=?').get(chain,address);
    const old=previous?JSON.parse(String(previous.profile)):{labels:[]};
    const latest=!previous||observed>=String(previous.last_at);
    const compact={labels:[...new Set([...old.labels,...labels(profile.labels)])].slice(0,16),
      name:latest?clean(profile.name)??old.name:old.name,twitter:latest?twitter(profile.twitter)??old.twitter:old.twitter};
    this.db.prepare('INSERT INTO wh_wallets VALUES (?,?,?,?,?) ON CONFLICT(chain,address) DO UPDATE SET first_at=MIN(first_at,excluded.first_at),last_at=MAX(last_at,excluded.last_at),profile=excluded.profile')
      .run(chain,address,observed,observed,JSON.stringify(compact));
    this.db.prepare('INSERT OR IGNORE INTO wh_metrics(chain,address) VALUES (?,?)').run(chain,address);
    const serviceLabels=['exchange_or_pool','exchange','pool','router','bridge','cex'];
    if(compact.labels.some(label=>serviceLabels.includes(label))&&!old.labels.some((label:string)=>serviceLabels.includes(label)))
      this.associations.publicServiceChanged(chain,address);
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
  private putFunding(value:WalletFundingEdge):void {
    const {observedAt:_,...snapshot}=value;
    const inserted=this.db.prepare('INSERT OR IGNORE INTO wh_funding(id,chain,wallet,funding_address,observed_at,shared,conflict,snapshot_at,data) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(digest(value.snapshotAt?snapshot:value),value.chain,value.wallet,value.fundingAddress,
        value.observedAt,value.sharedService?1:0,value.conflict?1:0,value.snapshotAt??value.observedAt,JSON.stringify(value));
    if(Number(inserted.changes)) {
      this.db.prepare('UPDATE wh_metrics SET coordination_dirty=1 WHERE chain=? AND address IN (SELECT wallet FROM wh_funding WHERE chain=? AND funding_address=?)')
        .run(value.chain,value.chain,value.fundingAddress);
      this.associations.fundingChanged(value.chain,value.wallet);
      // Reclassifying a shared funding service affects all currently associated recipients.
      if(value.sharedService) this.associations.publicServiceChanged(value.chain,value.fundingAddress);
    }
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
  private gains(chain:Chain,wallet:string):WalletGainEvidence[] {
    return this.db.prepare('SELECT data FROM wh_gains WHERE chain=? AND wallet=?').all(chain,wallet).map(row=>JSON.parse(String(row.data)) as WalletGainEvidence)
      .sort((a,b)=>b.maxGainPct-a.maxGainPct).slice(0,100);
  }
  private summary(row:Record<string,any>):WalletHistorySummary {
    const chain=row.chain as Chain,wallet=String(row.address),profile=JSON.parse(String(row.profile));
    const profit=row.profit_data?JSON.parse(String(row.profit_data)) as WalletVendorStats:undefined;
    const evidence=row.coordination_data?JSON.parse(String(row.coordination_data)) as WalletHistoryDetail['coordinationEvidence']:{sharedFunding:[],synchronized:[]};
    const checkedAt=row.coordination_checked_at?String(row.coordination_checked_at):undefined;
    return {chain,address:wallet,firstObservedAt:String(row.first_at),lastObservedAt:String(row.last_at),labels:profile.labels,
      name:profile.name,twitter:profile.twitter,vendorVerification:'vendor_claim',observedEventCount:Number(row.event_count??0),buyEvents:Number(row.buy_count??0),
      sellEvents:Number(row.sell_count??0),tokenCount:Number(row.token_count??0),profit,gain:row.gain_data?JSON.parse(String(row.gain_data)):undefined,
      coordination:this.coordinationSummary(evidence,!checkedAt?'pending':Number(row.coordination_dirty)?'stale':'current',checkedAt)};
  }
  private coordinationSummary(evidence:WalletHistoryDetail['coordinationEvidence'],status:WalletHistorySummary['coordination']['status'],checkedAt?:string):WalletHistorySummary['coordination'] {
    const shared=new Set(evidence.sharedFunding.map(item=>item.wallet)).size,
      synced=new Set(evidence.synchronized.map(item=>item.wallet)).size;
    return {score:Math.min(100,shared*10+synced*20),sharedFundingPeers:shared,synchronizedPeers:synced,
      evidenceCount:evidence.sharedFunding.length+evidence.synchronized.length,ownership:'unknown',scope:'heuristic',status,checkedAt};
  }
  private coordination(chain:Chain,wallet:string):WalletHistoryDetail['coordinationEvidence'] {
    // Keep the target wallet as the outer loop. An ordinary JOIN can start with
    // every funding snapshot on the chain before applying the wallet constraint.
    const sharedFunding=this.db.prepare(`SELECT DISTINCT b.wallet,a.funding_address,MAX(a.observed_at,b.observed_at) AS observed
      FROM wh_funding a CROSS JOIN wh_funding b ON a.chain=b.chain AND a.funding_address=b.funding_address AND a.wallet<>b.wallet
      WHERE a.chain=? AND a.wallet=? AND a.shared=0 AND b.shared=0 AND a.conflict=0 AND b.conflict=0
        AND NOT EXISTS(SELECT 1 FROM wh_funding s WHERE s.chain=a.chain AND s.funding_address=a.funding_address AND s.shared=1)
        AND NOT EXISTS(SELECT 1 FROM wh_funding x WHERE x.chain=a.chain AND x.wallet=a.wallet AND x.funding_address=a.funding_address
          AND (x.snapshot_at>a.snapshot_at OR (x.snapshot_at=a.snapshot_at AND (x.observed_at>a.observed_at OR x.conflict=1))))
        AND NOT EXISTS(SELECT 1 FROM wh_funding x WHERE x.chain=b.chain AND x.wallet=b.wallet AND x.funding_address=b.funding_address
          AND (x.snapshot_at>b.snapshot_at OR (x.snapshot_at=b.snapshot_at AND (x.observed_at>b.observed_at OR x.conflict=1))))
      LIMIT 50`).all(chain,wallet).map(row=>({address:String(row.funding_address),wallet:String(row.wallet),observedAt:String(row.observed)}));
    const synchronized=this.db.prepare(`WITH seeds AS (SELECT * FROM wh_events WHERE chain=? AND wallet=? AND side IN ('buy','sell') ORDER BY event_at DESC LIMIT 200)
      SELECT b.wallet,a.token_address,COUNT(DISTINCT a.tx_hash) AS n FROM seeds a JOIN wh_events b ON b.id IN (
        SELECT x.id FROM wh_events x WHERE x.chain=a.chain AND x.token_address=a.token_address AND x.side=a.side
          AND x.wallet<>a.wallet AND x.tx_hash<>a.tx_hash
          AND x.event_at BETWEEN strftime('%Y-%m-%dT%H:%M:%fZ',a.event_at,'-120 seconds') AND strftime('%Y-%m-%dT%H:%M:%fZ',a.event_at,'+120 seconds')
        ORDER BY x.event_at DESC LIMIT 200) GROUP BY b.wallet,a.token_address
      HAVING COUNT(DISTINCT a.tx_hash)>=2 AND COUNT(DISTINCT b.tx_hash)>=2 LIMIT 50`).all(chain,wallet)
      .map(row=>({wallet:String(row.wallet),tokenAddress:String(row.token_address),distinctTransactions:Number(row.n),windowSeconds:120 as const}));
    return {sharedFunding,synchronized};
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
