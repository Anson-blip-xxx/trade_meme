import {DatabaseSync, type StatementSync} from 'node:sqlite';
import {chmodSync,existsSync,mkdirSync,realpathSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chainAddress} from './chain-stream-store.js';
import type {Chain} from './types.js';
import {analyzeWalletRoles,type WalletRoleAnalysis,type WalletRoleEvent,type WalletRoleEventReference,type WalletRolePeerInput} from './wallet-role-analysis.js';
import {analyzeWalletInitiator,type GmgnMarketFirstSeen,type WalletInitiatorAnalysis} from './wallet-initiator-analysis.js';
import {analyzeWalletVisibleStart,type WalletVisibleStartAnalysis,type WalletVisibleStartFollowupInput} from './wallet-visible-start-analysis.js';

export const WALLET_PROFILE_GROUPS=['public_kol','early_candidate','repeated_early','forward_validated','shared_funding','synchronized','follower_pattern','precursor_pattern','mixed_pattern','market_pre_candidate','market_precursor_pattern','market_visible_start','market_follower_pattern','market_mixed_pattern','market_repeated_exit','vendor_profit_positive','observed_runner','insufficient_evidence','inactive_observed'] as const;
export type WalletProfileGroupId=typeof WALLET_PROFILE_GROUPS[number];
export interface WalletProfileGroup {id:WalletProfileGroupId;firstObservedAt:string;evidenceCount:number;reason:string;}
export interface WalletProfile {
  chain:Chain;address:string;version:1;computedAt:string;evidenceThroughAt?:string;freshUntil:string;status:'current'|'partial'|'stale';
  source:'wallet_history'|'chain_only';sampleOnly:true;ownership:'unknown';groups:WalletProfileGroup[];
  metrics:{observedEvents:number;buyEvents:number;sellEvents:number;distinctTokens:number;lastEventAt?:string;
    vendorProfit?:{realizedProfitUsd:string;period:'7d';observedAt:string;snapshotAt:string;verification:'vendor_claim'};
    observedGain?:{maxGainPct:number;tokenAddress:string;baselineAt:string;peakAt:string;source:string};
    associations:{leaders:number;distinctTokens:number;forwardTokens:number};chain:{transactions:number;transfers:number;lastObservedAt?:string}};
  counterparties:{address:string;kind:'leader'|'shared_funding'|'synchronized';evidenceCount:number}[];
  roleAnalysis?:WalletRoleAnalysis;
  initiatorAnalysis?:WalletInitiatorAnalysis;
  visibleStartAnalysis?:WalletVisibleStartAnalysis;
  limitations:string[];changes?:{at:string;added:WalletProfileGroupId[];removed:WalletProfileGroupId[]}[];
}
export interface WalletProfileStatus {ready:boolean;profiles:number;sourceWallets:number;profiledSourceWallets:number;initialComplete:boolean;processed:number;lastRunAt?:string;
  roleProfiles:number;rolePending:number;roleLastRunAt?:string;
  groupCounts:Partial<Record<WalletProfileGroupId,number>>;bytes:number;maxBytes:number;capacityReached:boolean;error?:string;sampleOnly:true;staleProfiles:number;aggregatedAt?:string;}
export interface WalletProfileListOptions {chain?:Chain;group?:string;search?:string;limit?:number;offset?:number;}
export interface WalletProfitCohortSnapshot {asOf:string;validUntil:string;values:number[];}
export type WalletProfitCohorts=Partial<Record<Chain,WalletProfitCohortSnapshot>>;
export interface WalletProfilesOptions {database:string;historyDatabase:string;chainDatabase?:string;maxBytes?:number;now?:()=>Date;refreshAfterSec?:number;cohortMaxAgeSec?:number;}
type Row=Record<string,any>;
const DAY=86_400_000,CAPACITY='WALLET_PROFILES_CAPACITY_REACHED',CHAINS:Chain[]=['bsc','solana','robinhood'];
const SERVICES=new Set(['exchange_or_pool','exchange','pool','router','bridge','cex']);
const parse=(value:unknown):any=>{try{return typeof value==='string'?JSON.parse(value):undefined;}catch{return undefined;}};
const stamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));
const validTime=(value:unknown,now:string):value is string=>stamp(value)&&value<=now;
const num=(value:unknown):number=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
const bounded=(value:unknown,fallback:number,max:number)=>typeof value==='number'&&Number.isSafeInteger(value)?Math.max(1,Math.min(max,value)):fallback;
const canonicalPath=(path:string)=>path===':memory:'?path:existsSync(path)?realpathSync(path):resolve(path);
const filesBytes=(path:string,db?:DatabaseSync)=>path===':memory:'&&db?Number(db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.prepare('PRAGMA page_size').get()!.page_size):
  [path,path+'-wal',path+'-shm'].reduce((n,p)=>{try{return n+statSync(p).size;}catch{return n;}},0);
const emptyStatus=():WalletProfileStatus=>({ready:false,profiles:0,sourceWallets:0,profiledSourceWallets:0,initialComplete:false,processed:0,roleProfiles:0,rolePending:0,groupCounts:{},bytes:0,maxBytes:0,capacityReached:false,sampleOnly:true,staleProfiles:0});

/** Independently persisted research classifications. Every source database is opened read-only. */
export class WalletProfiles {
  private readonly history:DatabaseSync;private chain?:DatabaseSync;private readonly db:DatabaseSync;
  private readonly now:()=>Date;private readonly maxBytes:number;private readonly refreshMs:number;
  private readonly sourceStatements=new Map<string,StatementSync>();private readonly outputStatements=new Map<string,StatementSync>();
  private sourceCount=0;private countedAt=0;
  private readonly roleKeys=new Map<string,string>();
  private readonly funderCache=new Map<string,boolean>();
  private readonly initiatorNominations=new Map<string,{tokenAddress:string;marketAt:string}[]>();
  private readonly newQualifications=new Map<string,{profile:WalletProfile;peers:Set<string>;initiator:boolean;visibleStart:boolean}>();
  private cachedStatus?:WalletProfileStatus;private statusAt=0;
  private cachedProfitCohorts:WalletProfitCohorts={};private cohortsAt=0;
  constructor(private readonly options:WalletProfilesOptions) {
    this.now=options.now??(()=>new Date());this.maxBytes=options.maxBytes??256*1024*1024;this.refreshMs=(options.refreshAfterSec??21600)*1000;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<16_384||!Number.isFinite(this.refreshMs)||this.refreshMs<1000||canonicalPath(options.database)===canonicalPath(options.historyDatabase)||
      options.chainDatabase&&canonicalPath(options.database)===canonicalPath(options.chainDatabase))throw new Error('WALLET_PROFILES_CONFIG_INVALID');
    this.history=new DatabaseSync(options.historyDatabase,{readOnly:true});this.history.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');
    if(options.chainDatabase&&existsSync(options.chainDatabase)){this.chain=new DatabaseSync(options.chainDatabase,{readOnly:true});this.chain.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');}
    if(options.database!==':memory:')mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.database);if(options.database!==':memory:')chmodSync(options.database,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA wal_autocheckpoint=64;
      CREATE TABLE IF NOT EXISTS wp_profiles(chain TEXT,address TEXT,computed_at TEXT NOT NULL,fresh_until TEXT NOT NULL,data TEXT NOT NULL,source_wallet INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS wp_profiles_due ON wp_profiles(fresh_until);
      CREATE INDEX IF NOT EXISTS wp_profiles_recent ON wp_profiles(computed_at DESC,chain,address);
      CREATE TABLE IF NOT EXISTS wp_groups(chain TEXT,address TEXT,group_id TEXT,first_at TEXT NOT NULL,PRIMARY KEY(chain,address,group_id));
      CREATE INDEX IF NOT EXISTS wp_groups_filter ON wp_groups(group_id,chain,address);
      CREATE TABLE IF NOT EXISTS wp_group_first(chain TEXT,address TEXT,group_id TEXT,first_at TEXT NOT NULL,PRIMARY KEY(chain,address,group_id));
      CREATE TABLE IF NOT EXISTS wp_changes(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,observed_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS wp_changes_wallet ON wp_changes(chain,address,id DESC);
      CREATE TABLE IF NOT EXISTS wp_initiator_tokens(chain TEXT,address TEXT,token_address TEXT,market_at TEXT NOT NULL,
        PRIMARY KEY(chain,address,token_address));
      CREATE INDEX IF NOT EXISTS wp_initiator_tokens_recent ON wp_initiator_tokens(chain,address,market_at DESC,token_address);
      CREATE TABLE IF NOT EXISTS wp_snapshots(key TEXT PRIMARY KEY,updated_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wp_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(wp_profiles)').all().some(column=>column.name==='source_wallet'))this.db.exec('ALTER TABLE wp_profiles ADD COLUMN source_wallet INTEGER NOT NULL DEFAULT 0');
    for(const column of ['role_computed_at','role_input_key'])if(!this.db.prepare('PRAGMA table_info(wp_profiles)').all().some(row=>row.name===column))this.db.exec(`ALTER TABLE wp_profiles ADD COLUMN ${column} TEXT`);
    this.db.exec('CREATE INDEX IF NOT EXISTS wp_profiles_source ON wp_profiles(source_wallet)');
    this.db.exec('CREATE INDEX IF NOT EXISTS wp_profiles_roles ON wp_profiles(role_computed_at)');
    this.setMeta('refresh_after_sec',String(this.refreshMs/1000));
    const oldLimit=Number(this.meta('max_bytes'));this.setMeta('max_bytes',String(this.maxBytes));
    if(this.meta('error')===CAPACITY&&this.maxBytes>oldLimit&&filesBytes(options.database,this.db)+32768<this.maxBytes)this.setMeta('error','');
    // Historical coverage belongs to the rowid pass. Start update watermarks at
    // worker creation so live changes never queue behind the entire old corpus.
    if(!this.meta('changed_at'))this.setMeta('changed_at',this.now().toISOString());
    if(!this.meta('coordination_at'))this.setMeta('coordination_at',this.now().toISOString());
    if(!this.meta('relation_changed_at')){this.setMeta('relation_changed_at',this.now().toISOString());this.setMeta('relation_changed_row','0');}
    // Timing claims start prospectively. Legacy market observations do not
    // contain polling intervals, so a new derived database must not replay
    // them as if this model had observed the opportunity at the time.
    if(!this.meta('market_started_at'))this.setMeta('market_started_at',this.now().toISOString());
    if(!this.meta('market_cursor')){const cursor=Number(this.hs('SELECT COALESCE(MAX(rowid),0) AS n FROM wh_observations').get()!.n);
      this.setMeta('market_cursor',String(cursor));this.setMeta('market_wallet','');}
    if(!this.meta('initiator_event_cursor'))this.setMeta('initiator_event_cursor',String(
      Number(this.hs('SELECT COALESCE(MAX(rowid),0) AS n FROM wh_events').get()!.n)));
    const now=this.now().toISOString(),cohorts=this.snapshot('profit_cohorts');
    // One worker-side reconciliation at startup repairs a snapshot left behind
    // by a crash. Subsequent batches update these counters incrementally.
    this.cachedStatus=aggregateStatus(this.db,this.options.database,now,this.refreshMs/1000);this.statusAt=Date.parse(now);
    this.saveSnapshot('profile_status',now,this.cachedStatus);
    if(validProfitCohorts(cohorts?.data)){this.cachedProfitCohorts=cohorts.data;this.cohortsAt=Date.parse(cohorts.updatedAt);}
  }
  private hs(sql:string):StatementSync {let statement=this.sourceStatements.get(sql);if(!statement){statement=this.history.prepare(sql);this.sourceStatements.set(sql,statement);}return statement;}
  private os(sql:string):StatementSync {let statement=this.outputStatements.get(sql);if(!statement){statement=this.db.prepare(sql);this.outputStatements.set(sql,statement);}return statement;}
  private meta(key:string):string{return String(this.os('SELECT value FROM wp_meta WHERE key=?').get(key)?.value??'');}
  private setMeta(key:string,value:string):void {this.os('INSERT INTO wp_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  private snapshot(key:string):{updatedAt:string;data:unknown}|undefined {const row=this.os('SELECT updated_at,data FROM wp_snapshots WHERE key=?').get(key);if(!row)return;
    return {updatedAt:String(row.updated_at),data:parse(row.data)};}
  private saveSnapshot(key:string,updatedAt:string,data:unknown):void {this.os(`INSERT INTO wp_snapshots VALUES (?,?,?) ON CONFLICT(key)
    DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data`).run(key,updatedAt,JSON.stringify(data));}
  /**
   * Read one prospective market observation at a time, then page only that
   * token's observed buyers. This keeps the source cursor durable without a
   * DISTINCT/ORDER BY over every unprocessed observation-wallet pair.
   */
  private marketBatch(now:string,limit:number):{rows:Row[];cursor:number;wallet:string;changed:boolean} {
    const startCursor=Number(this.meta('market_cursor')||0),startWallet=this.meta('market_wallet');
    let cursor=Number.isSafeInteger(startCursor)&&startCursor>=0?startCursor:0,wallet=startWallet,changed=false,scanned=0;
    const rows:Row[]=[],scanLimit=Math.max(16,limit*8);
    const current=this.hs(`SELECT rowid AS cursor,chain,token_address,observed_at FROM wh_observations INDEXED BY wh_observations_kind
      WHERE kind='market_candidate' AND rowid=? AND observed_at<=?
        AND json_extract(data,'$.changeKind')='first_seen' AND json_extract(data,'$.firstSeenUpperBound') IS NOT NULL
        AND json_extract(data,'$.leftCensored')=0 LIMIT 1`);
    const next=this.hs(`SELECT rowid AS cursor,chain,token_address,observed_at FROM wh_observations INDEXED BY wh_observations_kind
      WHERE kind='market_candidate' AND rowid>? AND observed_at<=?
        AND json_extract(data,'$.changeKind')='first_seen' AND json_extract(data,'$.firstSeenUpperBound') IS NOT NULL
        AND json_extract(data,'$.leftCensored')=0 ORDER BY rowid LIMIT 1`);
    const buyers=this.hs(`SELECT DISTINCT wallet FROM wh_events INDEXED BY wh_events_token
      WHERE chain=? AND token_address=? AND side='buy' AND observed_at<=? AND wallet>?
      ORDER BY wallet LIMIT ?`);
    const canonical=this.hs(`SELECT MIN(COALESCE(json_extract(data,'$.firstSeenUpperBound'),observed_at)) AS market_at
      FROM wh_observations INDEXED BY wh_exit_evidence WHERE chain=? AND token_address=? AND kind='market_candidate'
        AND observed_at<=? AND json_extract(data,'$.changeKind')='first_seen'`);
    while(rows.length<limit&&scanned<scanLimit){
      let observation=wallet?current.get(cursor,now):undefined;
      if(wallet&&!observation){wallet='';changed=true;}
      observation??=next.get(cursor,now);if(!observation)break;
      scanned++;
      const chain=observation.chain as Chain,token=chainAddress(chain,observation.token_address),remaining=limit-rows.length;
      if(!token){cursor=Number(observation.cursor);wallet='';changed=true;continue;}
      const page=buyers.all(chain,token,observation.observed_at,wallet,remaining);
      const marketAt=String(canonical.get(chain,token,now)?.market_at??observation.observed_at);
      for(const item of page)rows.push({cursor:Number(observation.cursor),chain,wallet:item.wallet,token_address:token,market_at:marketAt});
      cursor=Number(observation.cursor);changed=true;
      if(page.length===remaining){wallet=String(page.at(-1)!.wallet);break;}
      // Fewer rows than requested proves this observation's wallet page is
      // exhausted. Continue to the next observation in the same bounded pass.
      wallet='';
    }
    return {rows,cursor,wallet,changed:changed&&(cursor!==startCursor||wallet!==startWallet)};
  }
  /** Resolve only the supplied contracts against prospective market evidence.
   * Legacy first-seen rows remain in the MIN so a later feed cannot make an
   * old contract look newly discovered. */
  private marketFrames(chain:Chain,tokens:string[],now:string):Map<string,string> {
    const selected=[...new Set(tokens.map(token=>chainAddress(chain,token)).filter((value):value is string=>!!value))];
    if(!selected.length)return new Map();
    const placeholders=selected.map(()=>'?').join(','),rows=this.hs(`SELECT token_address,
        MIN(COALESCE(json_extract(data,'$.firstSeenUpperBound'),observed_at)) AS market_at,
        MAX(CASE WHEN json_extract(data,'$.firstSeenUpperBound') IS NOT NULL AND json_extract(data,'$.leftCensored')=0 THEN 1 ELSE 0 END) AS eligible
      FROM wh_observations INDEXED BY wh_exit_evidence WHERE chain=? AND token_address IN (${placeholders})
        AND kind='market_candidate' AND observed_at<=? AND json_extract(data,'$.changeKind')='first_seen'
      GROUP BY token_address HAVING eligible=1`).all(chain,...selected,now),result=new Map<string,string>();
    for(const row of rows){const token=chainAddress(chain,row.token_address),marketAt=String(row.market_at??'');
      if(token&&stamp(marketAt))result.set(token,marketAt);}
    return result;
  }
  runBatch(limit=100):WalletProfileStatus {
    if(this.meta('error')===CAPACITY)return this.status();
    if(!this.chain&&this.options.chainDatabase&&existsSync(this.options.chainDatabase)){this.chain=new DatabaseSync(this.options.chainDatabase,{readOnly:true});this.chain.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');}
    let historyTransaction=false,chainTransaction=false;
    try {
      this.history.exec('BEGIN');historyTransaction=true;
      if(this.chain){this.chain.exec('BEGIN');chainTransaction=true;}
      return this.runSnapshot(limit);
    }finally{
      // Read snapshots must close even when malformed evidence, capacity or an
      // output failure interrupts a batch. The sources are never mutated.
      try{if(chainTransaction)this.chain!.exec('ROLLBACK');}finally{if(historyTransaction)this.history.exec('ROLLBACK');}
    }
  }
  private runSnapshot(limit:number):WalletProfileStatus {
    this.roleKeys.clear();this.funderCache.clear();this.initiatorNominations.clear();this.newQualifications.clear();
    const now=this.now().toISOString(),n=bounded(limit,100,1000),targets=new Map<string,{chain:Chain;address:string;discover:boolean;nominations:Map<string,string>}>();
    if(this.meta('error')===CAPACITY)return this.status();
    const add=(row:Row,discover=false,nominate=false)=>{const chain=row.chain as Chain,address=chainAddress(chain,row.address??row.wallet);if(!address)return;
      const key=chain+':'+address,old=targets.get(key),nominations=old?.nominations??new Map<string,string>();
      if(nominate){const token=chainAddress(chain,row.token_address),marketAt=stamp(row.market_at)?String(row.market_at):undefined,prior=token&&nominations.get(token);
        if(token&&marketAt&&(!prior||marketAt<prior))nominations.set(token,marketAt);}
      targets.set(key,{chain,address,discover:discover||old?.discover===true,nominations});};
    const initialCursor=Number(this.meta('initial_cursor')||0),initialLimit=Math.max(1,Math.ceil(n*0.6));
    const initial=this.hs('SELECT rowid AS cursor,chain,address FROM wh_wallets WHERE rowid>? ORDER BY rowid LIMIT ?').all(initialCursor,initialLimit);
    initial.forEach(row=>add(row,true));
    // Stable timestamp/rowid cursor consumes changed wallets fairly; new rows have an independent cursor.
    const changedAt=this.meta('changed_at'),changedRow=Number(this.meta('changed_row')||0),changedLimit=Math.max(1,Math.ceil(n*0.1));
    const changed=this.hs('SELECT rowid AS cursor,chain,address,last_at FROM wh_wallets WHERE last_at>=? AND last_at<=? AND (last_at>? OR (last_at=? AND rowid>?)) ORDER BY last_at,rowid LIMIT ?').all(changedAt,now,changedAt,changedAt,changedRow,changedLimit);
    changed.forEach(row=>add(row,true));
    const coordinationAt=this.meta('coordination_at'),coordinationRow=Number(this.meta('coordination_row')||0);
    const coordination=this.hs(`SELECT rowid AS cursor,chain,address,coordination_checked_at FROM wh_metrics WHERE coordination_dirty=0
      AND coordination_checked_at>=? AND coordination_checked_at<=? AND (coordination_checked_at>? OR (coordination_checked_at=? AND rowid>?))
      ORDER BY coordination_checked_at,rowid LIMIT ?`).all(coordinationAt,now,coordinationAt,coordinationAt,coordinationRow,changedLimit);
    coordination.forEach(row=>add(row));
    // Association refreshes often follow a public-wallet buy, while only that
    // public wallet receives a trade event. Recompute the candidate through a
    // separate durable cursor instead of waiting for the periodic profile pass.
    const relationAt=this.meta('relation_changed_at'),relationRow=Number(this.meta('relation_changed_row')||0);
    const relationChanged=this.hs(`SELECT rowid AS cursor,chain,candidate AS address,updated_at FROM wh_assoc_relations INDEXED BY wh_assoc_relation_updated
      WHERE updated_at>=? AND updated_at<=? AND (updated_at>? OR (updated_at=? AND rowid>?))
      ORDER BY updated_at,rowid LIMIT ?`).all(relationAt,now,relationAt,relationAt,relationRow,changedLimit);
    relationChanged.forEach(row=>add(row));
    // A new local market first-seen can change an already profiled wallet even
    // when that wallet has no new trade. Page one observation's buyers at a
    // time so a popular token cannot force a global DISTINCT/sort.
    const market=this.marketBatch(now,Math.max(1,Math.ceil(n*0.2)));market.rows.forEach(row=>add(row,false,true));
    // The per-wallet frame below intentionally keeps only 500 recent events.
    // Consume every newly archived event with a separate durable cursor so an
    // older post-market buy from a busy wallet cannot fall out of that frame
    // before it is copied into the compact initiator ledger.
    const eventStart=Number(this.meta('initiator_event_cursor')||0),eventLimit=Math.max(1,Math.ceil(n*0.2));
    const eventCeiling=Number(this.hs('SELECT COALESCE(MAX(rowid),0) AS n FROM wh_events').get()!.n),eventRows=this.hs(`SELECT rowid AS cursor,chain,wallet,token_address,side,event_at,observed_at
      FROM wh_events WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`).all(eventStart,eventCeiling,eventLimit);
    const eventCandidates=new Map<Chain,Row[]>();
    for(const row of eventRows){const chain=row.chain as Chain,wallet=chainAddress(chain,row.wallet),token=chainAddress(chain,row.token_address);
      if(!wallet||!token||row.side!=='buy'||!validTime(row.event_at,now)||!validTime(row.observed_at,now)||row.event_at>row.observed_at)continue;
      const values=eventCandidates.get(chain)??[];values.push({...row,wallet,token_address:token});eventCandidates.set(chain,values);}
    for(const [chain,rows] of eventCandidates){const frames=this.marketFrames(chain,rows.map(row=>row.token_address),now);
      for(const row of rows){const marketAt=frames.get(row.token_address);if(marketAt)add({...row,market_at:marketAt},false,true);}}
    const eventCursor=eventRows.length?Number(eventRows.at(-1)!.cursor):eventStart;
    const eventCoverageComplete=eventCursor>=eventCeiling;
    // Existing profiles also receive the new model, independent of new events
    // or the original history cursor. The NULL index makes this bounded.
    this.os('SELECT chain,address FROM wp_profiles WHERE role_computed_at IS NULL LIMIT ?').all(Math.max(1,Math.ceil(n*0.2))).forEach(row=>add(row));
    // Source cursors refresh changed wallets immediately. The periodic pass is
    // only reconciliation, so key it by computed_at and the configured window
    // instead of perpetually rewriting the whole corpus every 30 minutes.
    const dueAt=new Date(Date.parse(now)-this.refreshMs).toISOString();
    const due=this.os('SELECT chain,address FROM wp_profiles INDEXED BY wp_profiles_recent WHERE computed_at<=? ORDER BY computed_at,chain,address LIMIT ?')
      .all(dueAt,Math.max(1,n-targets.size));due.forEach(row=>add(row));
    const chainCursor=Number(this.meta('chain_cursor')||0);
    const chainRows=this.chain?.prepare('SELECT rowid AS cursor,chain,wallet FROM chain_events WHERE rowid>? ORDER BY rowid LIMIT ?').all(chainCursor,Math.max(1,Math.min(200,Math.floor(n*0.2))))??[];
    chainRows.forEach(row=>add(row));
    const statusBefore=this.cachedStatus&&structuredClone(this.cachedStatus);this.db.exec('BEGIN');
    let processed=0,full=false;
    try {
      for(const target of targets.values()){
        const profile=this.compute(target.chain,target.address,now,target.discover,[...target.nominations].map(([tokenAddress,marketAt])=>({tokenAddress,marketAt})),eventCoverageComplete);
        if(!profile)continue;
        const size=Buffer.byteLength(JSON.stringify(profile));
        const logical=Number(this.os('PRAGMA page_count').get()!.page_count)*Number(this.os('PRAGMA page_size').get()!.page_size);
        if(Math.max(logical,filesBytes(this.options.database,this.db))+size*4+32768>this.maxBytes){full=true;break;}
        this.save(profile);processed++;
      }
      // Never advance input cursors over a capacity-truncated batch.
      if(!full){if(initial.length)this.setMeta('initial_cursor',String(initial.at(-1)!.cursor));
        this.setMeta('initial_complete',initial.length<initialLimit?'1':'0');
        if(changed.length){this.setMeta('changed_at',String(changed.at(-1)!.last_at));this.setMeta('changed_row',String(changed.at(-1)!.cursor));}
        if(coordination.length){this.setMeta('coordination_at',String(coordination.at(-1)!.coordination_checked_at));this.setMeta('coordination_row',String(coordination.at(-1)!.cursor));}
        if(relationChanged.length){this.setMeta('relation_changed_at',String(relationChanged.at(-1)!.updated_at));this.setMeta('relation_changed_row',String(relationChanged.at(-1)!.cursor));}
        if(market.changed){this.setMeta('market_cursor',String(market.cursor));this.setMeta('market_wallet',market.wallet);}
        if(eventCursor!==eventStart)this.setMeta('initiator_event_cursor',String(eventCursor));
        if(chainRows.length)this.setMeta('chain_cursor',String(chainRows.at(-1)!.cursor));}
      // No reader can see any row until this transaction commits. Newly formed
      // peer qualifications therefore start at batch completion, never at the
      // earlier read-snapshot time or an intermediate per-wallet calculation.
      const registeredAt=this.now().toISOString();
      if(!validTime(now,registeredAt))throw new Error('WALLET_PROFILE_REGISTRATION_CLOCK_INVALID');
      for(const {profile,peers,initiator,visibleStart} of this.newQualifications.values()){
        profile.computedAt=registeredAt;
        if(peers.size&&profile.roleAnalysis){profile.roleAnalysis.computedAt=registeredAt;
          for(const peer of profile.roleAnalysis.peers)if(peers.has(peer.address))peer.qualification!.knownAt=registeredAt;}
        if(initiator&&profile.initiatorAnalysis?.qualification){profile.initiatorAnalysis.computedAt=registeredAt;
          profile.initiatorAnalysis.qualification.knownAt=registeredAt;}
        if(visibleStart&&profile.visibleStartAnalysis?.qualification){profile.visibleStartAnalysis.computedAt=registeredAt;
          profile.visibleStartAnalysis.qualification.knownAt=registeredAt;
          if(initiator){profile.visibleStartAnalysis.prerequisite.knownAt=registeredAt;
            profile.visibleStartAnalysis.qualification.prerequisiteKnownAt=registeredAt;}}
        this.os('UPDATE wp_profiles SET computed_at=?,role_computed_at=?,data=? WHERE chain=? AND address=?')
          .run(registeredAt,profile.roleAnalysis?.computedAt??null,JSON.stringify(profile),profile.chain,profile.address);
      }
      if([...this.newQualifications.values()].some(value=>value.peers.size)&&this.cachedStatus&&(!this.cachedStatus.roleLastRunAt||registeredAt>this.cachedStatus.roleLastRunAt))
        this.cachedStatus.roleLastRunAt=registeredAt;
      this.setMeta('processed',String(Number(this.meta('processed')||0)+processed));this.setMeta('last_run_at',registeredAt);
      if(full)this.setMeta('error',CAPACITY);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');this.cachedStatus=statusBefore;throw error;}
    if(!this.countedAt||this.now().getTime()-this.countedAt>=60_000){this.sourceCount=Number(this.hs('SELECT count(*) AS n FROM wh_wallets').get()!.n);this.countedAt=this.now().getTime();this.setMeta('source_wallets',String(this.sourceCount));}
    this.refreshProfitCohorts(now,processed>0);
    return this.status();
  }
  private compute(chain:Chain,address:string,now:string,discoverInitiator=false,
    marketNominations:{tokenAddress:string;marketAt:string}[]=[],initiatorCoverageComplete=true):WalletProfile|undefined {
    const wallet=this.hs('SELECT * FROM wh_wallets WHERE chain=? AND address=?').get(chain,address);
    const rawMetrics=this.hs('SELECT * FROM wh_metrics WHERE chain=? AND address=?').get(chain,address);
    const chainRows=this.chain?.prepare('SELECT data FROM chain_events WHERE chain=? AND wallet=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 501').all(chain,address,now)??[];
    if(!wallet&&!chainRows.length)return;
    const limitations=['SAMPLED_OBSERVATIONS_NOT_COMPLETE_HISTORY','ASSOCIATIONS_DO_NOT_PROVE_COMMON_OWNERSHIP','VENDOR_PROFIT_IS_NOT_LOCAL_REALIZED_PNL'];
    const profile:WalletProfile={chain,address,version:1,computedAt:now,freshUntil:new Date(Date.parse(now)+this.refreshMs).toISOString(),status:'current',source:wallet?'wallet_history':'chain_only',sampleOnly:true,ownership:'unknown',groups:[],
      metrics:{observedEvents:0,buyEvents:0,sellEvents:0,distinctTokens:0,associations:{leaders:0,distinctTokens:0,forwardTokens:0},chain:{transactions:0,transfers:0}},counterparties:[],limitations};
    const group=(id:WalletProfileGroupId,evidenceCount:number,reason:string)=>{if(!profile.groups.some(g=>g.id===id))profile.groups.push({id,firstObservedAt:now,evidenceCount,reason});};
    const seen=(value:unknown)=>{if(validTime(value,now)&&(!profile.evidenceThroughAt||value>profile.evidenceThroughAt))profile.evidenceThroughAt=value;};
    const partial=(reason:string)=>{profile.status='partial';if(!limitations.includes(reason))limitations.push(reason);};
    const addCounterparty=(other:unknown,kind:WalletProfile['counterparties'][number]['kind'],evidenceCount:number)=>{const value=chainAddress(chain,other);if(value&&value!==address&&profile.counterparties.length<50&&!profile.counterparties.some(p=>p.address===value&&p.kind===kind))profile.counterparties.push({address:value,kind,evidenceCount});};
    if(validTime(wallet?.last_at,now))seen(wallet!.last_at);
    const events=this.hs('SELECT data FROM wh_events WHERE chain=? AND wallet=? AND event_at<=? AND observed_at<=? ORDER BY event_at DESC LIMIT 501').all(chain,address,now,now);
    if(events.length>500)partial('EVENT_SAMPLE_LIMIT_500');
    const tokens=new Set<string>();
    for(const row of events.slice(0,500)){
      const event=parse(row.data);if(!event||!validTime(event.eventAt,now)||!validTime(event.observedAt,now)||event.eventAt>event.observedAt||event.chain!==chain||event.wallet!==address)continue;
      profile.metrics.observedEvents++;if(event.side==='buy')profile.metrics.buyEvents++;if(event.side==='sell')profile.metrics.sellEvents++;
      const token=chainAddress(chain,event.tokenAddress);if(token)tokens.add(token);seen(event.observedAt);
      if(!profile.metrics.lastEventAt||event.eventAt>profile.metrics.lastEventAt)profile.metrics.lastEventAt=event.eventAt;
    }
    profile.metrics.distinctTokens=tokens.size;
    const anchors=this.hs('SELECT public_observed_at FROM wh_assoc_anchors WHERE chain=? AND leader=? AND public_observed_at<=? LIMIT 101').all(chain,address,now);
    if(anchors.length)group('public_kol',Math.min(100,anchors.length),'供应商 KOL 信号曾公开标记此钱包；标签不等于身份已验证');
    anchors.forEach(a=>seen(a.public_observed_at));if(anchors.length>100)partial('PUBLIC_ANCHOR_SAMPLE_LIMIT_100');
    const relations=this.hs('SELECT * FROM wh_assoc_relations INDEXED BY wh_assoc_relation_candidate_leader WHERE chain=? AND candidate=? AND token_count>0 LIMIT 21').all(chain,address);
    const earlyTokens=new Set<string>(),forwardTokens=new Set<string>();let leaders=0;
    if(relations.length>20)partial('RELATION_SAMPLE_LIMIT_20');
    for(const relation of relations.slice(0,20)){
      if(Number(relation.dirty)!==0||!validTime(relation.updated_at,now)){partial('RELATION_CACHE_PENDING_OR_STALE');continue;}
      if(Date.parse(now)-Date.parse(String(relation.updated_at))>DAY&&!limitations.includes('HISTORICAL_ASSOCIATION_EVIDENCE'))limitations.push('HISTORICAL_ASSOCIATION_EVIDENCE');
      const episodes=this.hs('SELECT data FROM wh_assoc_episodes WHERE chain=? AND leader=? AND candidate=? AND active=1 ORDER BY updated_at DESC LIMIT 101').all(chain,relation.leader!,address);
      let evidence=0;if(episodes.length>100)partial('EPISODE_SAMPLE_LIMIT_100');
      for(const row of episodes.slice(0,100)){
        const e=parse(row.data),token=e&&chainAddress(chain,e.tokenAddress);
        if(!token||!validTime(e.updatedAt,now)||!validTime(e.firstDiscoveredAt,now)||!validTime(e.leaderPublicObservedAt,now)||
          !e.candidateBuy||!e.leaderBuy||e.candidateBuy.wallet!==address||e.leaderBuy.wallet!==relation.leader||
          !validTime(e.candidateBuy.eventAt,now)||!validTime(e.candidateBuy.observedAt,now)||!validTime(e.leaderBuy.eventAt,now)||!validTime(e.leaderBuy.observedAt,now)||
          e.candidateBuy.eventAt>=e.leaderBuy.eventAt||e.candidateBuy.eventAt>e.candidateBuy.observedAt||e.leaderBuy.eventAt>e.leaderBuy.observedAt)continue;
        earlyTokens.add(token);evidence++;seen(e.candidateBuy.observedAt);seen(e.leaderBuy.observedAt);
        if(e.forwardValidated===true&&e.candidateBuy.observedAt<e.leaderBuy.eventAt&&validTime(relation.active_since,now)&&String(relation.active_since)<e.candidateBuy.eventAt)forwardTokens.add(token);
      }
      if(evidence){leaders++;addCounterparty(relation.leader,'leader',evidence);}
      const funding=parse(relation.funding_data);
      for(const evidence of (Array.isArray(funding)?funding:[]).slice(0,10)){
        if(evidence.kind!=='common'||!validTime(evidence.observedAt,now)||!Array.isArray(evidence.edges)||evidence.edges.length<2||!this.funderUsable(chain,evidence.address,now))continue;
        if(!evidence.edges.every((e:any)=>!e.sharedService&&!e.conflict&&validTime(e.observedAt,now)&&(!e.snapshotAt||validTime(e.snapshotAt,e.observedAt))))continue;
        group('shared_funding',1,'关联钱包存在共同资金来源线索，已排除已知交易所、桥、路由及公共池；不能据此认定同一控制人');addCounterparty(evidence.address,'shared_funding',1);seen(evidence.observedAt);
      }
    }
    profile.metrics.associations={leaders,distinctTokens:earlyTokens.size,forwardTokens:forwardTokens.size};
    if(earlyTokens.size)group('early_candidate',earlyTokens.size,'在采样交易中早于公开 KOL 钱包买入；历史回看与前向验证分开');
    if(earlyTokens.size>=2)group('repeated_early',earlyTokens.size,'历史上至少两个不同合约出现提前线索，可来自不同公开钱包；是否反复提前须看逐对行为判别及晚买反例');
    if(forwardTokens.size)group('forward_validated',forwardTokens.size,'关系先被记录，再观察到候选钱包买入，随后公开 KOL 买入');
    if(rawMetrics){
      const profit=parse(rawMetrics.profit_data),profitAt=profit?.snapshotAt??profit?.observedAt;
      if(profit?.period==='7d'&&profit.scope==='entire_wallet'&&profit.verification==='vendor_claim'&&profit.chain===chain&&profit.wallet===address&&
        typeof profit.realizedProfitUsd==='string'&&/^-?(0|[1-9]\d*)(\.\d+)?$/.test(profit.realizedProfitUsd)&&Number.isFinite(Number(profit.realizedProfitUsd))&&
        validTime(profit.observedAt,now)&&validTime(profitAt,profit.observedAt)&&Date.parse(now)-Date.parse(profitAt)<=DAY){
        profile.metrics.vendorProfit={realizedProfitUsd:profit.realizedProfitUsd,period:'7d',observedAt:profit.observedAt,snapshotAt:profitAt,verification:'vendor_claim'};seen(profit.observedAt);
        if(Number(profit.realizedProfitUsd)>0)group('vendor_profit_positive',1,'最近 24 小时内供应商报告的全钱包 7 日已实现利润为正；非本系统核算');
        profile.freshUntil=new Date(Math.min(Date.parse(profile.freshUntil),Date.parse(profitAt)+DAY+1)).toISOString();
      }else if(profit)limitations.push('VENDOR_PROFIT_MISSING_STALE_OR_INVALID');
      const gain=parse(rawMetrics.gain_data);
      if(gain?.kind==='first_post_observed_buy_quote'&&chainAddress(chain,gain.tokenAddress)&&typeof gain.maxGainPct==='number'&&Number.isFinite(gain.maxGainPct)&&gain.maxGainPct>=0&&
        validTime(gain.baselineAt,now)&&validTime(gain.peakAt,now)&&validTime(gain.latestAt,now)&&gain.baselineAt<=gain.peakAt&&gain.peakAt<=gain.latestAt&&
        typeof gain.source==='string'&&/^[a-z][a-z0-9_.:-]{0,79}$/.test(gain.source)){
        profile.metrics.observedGain={maxGainPct:gain.maxGainPct,tokenAddress:gain.tokenAddress,baselineAt:gain.baselineAt,peakAt:gain.peakAt,source:gain.source};seen(gain.latestAt);
        if(gain.maxGainPct>=100)group('observed_runner',1,'钱包买入被观察后，该币本地采样报价曾上涨至少 100%；不是该钱包实际盈利');
      }
      const coordination=parse(rawMetrics.coordination_data);
      if(coordination&&Number(rawMetrics.coordination_dirty)===0&&validTime(rawMetrics.coordination_checked_at,now)){
        if(Date.parse(now)-Date.parse(String(rawMetrics.coordination_checked_at))>DAY)limitations.push('HISTORICAL_COORDINATION_EVIDENCE');
        const shared=(Array.isArray(coordination.sharedFunding)?coordination.sharedFunding:[]).slice(0,50).filter((e:any)=>validTime(e.observedAt,now)&&this.funderUsable(chain,e.address,now));
        if(shared.length){group('shared_funding',shared.length,'采样资金来源重合，已排除已知公共服务；仅为关联线索');shared.forEach((e:any)=>{addCounterparty(e.address,'shared_funding',1);seen(e.observedAt);});}
        const sync=(Array.isArray(coordination.synchronized)?coordination.synchronized:[]).slice(0,50).filter((e:any)=>chainAddress(chain,e.wallet)&&chainAddress(chain,e.tokenAddress)&&Number.isSafeInteger(e.distinctTransactions)&&e.distinctTransactions>=2&&e.windowSeconds===120);
        if(sync.length){group('synchronized',sync.length,'相同代币、同方向的 120 秒窗口内重复出现；普通跟单也会产生这种现象，不证明共同控制');sync.forEach((e:any)=>addCounterparty(e.wallet,'synchronized',e.distinctTransactions));}
      }else if(coordination)partial('COORDINATION_CACHE_PENDING_OR_STALE');
    }
    if(chainRows.length>500)partial('CHAIN_EVENT_SAMPLE_LIMIT_500');
    let unknownChainEventTime=false;const txs=new Set<string>();
    for(const row of chainRows.slice(0,500)){
      const event=parse(row.data);if(!event||event.removed===true||event.chain!==chain||event.wallet!==address||!validTime(event.observedAt,now)||!['rpc_confirmed','rpc_observed'].includes(event.verification)||!['wallet_transaction','token_transfer','native_transfer'].includes(event.kind))continue;
      if(event.eventAt&&!validTime(event.eventAt,now))continue;
      txs.add(event.txHash);if(event.kind==='token_transfer'||event.kind==='native_transfer')profile.metrics.chain.transfers++;
      seen(event.observedAt);if(!profile.metrics.chain.lastObservedAt||event.observedAt>profile.metrics.chain.lastObservedAt)profile.metrics.chain.lastObservedAt=event.observedAt;
      if(event.eventAt){if(!profile.metrics.lastEventAt||event.eventAt>profile.metrics.lastEventAt)profile.metrics.lastEventAt=event.eventAt;}else if(Date.parse(now)-Date.parse(event.observedAt)<7*DAY)unknownChainEventTime=true;
    }
    profile.metrics.chain.transactions=txs.size;
    const tradeEvents=events.slice(0,500).map(row=>parse(row.data)).filter(Boolean);
    profile.roleAnalysis=this.roles(chain,address,tradeEvents,events.length>500,relations,now);
    profile.freshUntil=new Date(Math.min(Date.parse(profile.freshUntil),Date.parse(profile.roleAnalysis.computedAt)+this.refreshMs)).toISOString();
    for(const peer of profile.roleAnalysis.peers)if(peer.classification!=='insufficient')
      group(peer.classification,peer.matchedTokens,`${peer.classification==='follower_pattern'?'跟随':peer.classification==='precursor_pattern'?'提前':'方向混合'}模式样本；按同一对钱包比较，详情保留所有共同合约及反例，不证明身份或预测能力`);
    const nominations=new Map<string,string>();
    for(const row of [...marketNominations,...(discoverInitiator?this.discoverInitiatorTokens(chain,address,tradeEvents,now):[])]){
      const token=chainAddress(chain,row.tokenAddress),prior=token&&nominations.get(token);
      if(token&&stamp(row.marketAt)&&(!prior||row.marketAt<prior))nominations.set(token,row.marketAt);
    }
    const nominated=[...nominations].map(([tokenAddress,marketAt])=>({tokenAddress,marketAt}));
    if(nominated.length)this.initiatorNominations.set(chain+':'+address,nominated);
    const hasInitiator=!!this.os('SELECT 1 FROM wp_initiator_tokens WHERE chain=? AND address=? LIMIT 1').get(chain,address);
    if(nominated.length||hasInitiator)profile.initiatorAnalysis=this.initiator(chain,address,now,nominated,
      events.length>500&&!initiatorCoverageComplete);
    const initiator=profile.initiatorAnalysis;
    if(initiator){
      if(initiator.classification==='candidate')group('market_pre_candidate',initiator.directionalTokens.pre,'至少一个采样买入早于本地 GMGN 榜单首次发现区间；尚未形成跨币稳定模式');
      else if(initiator.classification==='precursor'&&initiator.status==='current'&&initiator.prospectivePreTokens>=3&&
        initiator.prospectivePreTokens/Math.max(1,initiator.matchedTokens)>=0.75)
        group('market_precursor_pattern',initiator.directionalTokens.pre,'至少 3 个合约在本地 GMGN 榜单发现前已由本机取得买入证据，且占可比较样本至少 75%；不是发币方或收益证明');
      else if(initiator.classification==='precursor')group('market_pre_candidate',initiator.directionalTokens.pre,'历史事件时间反复早于本地榜单发现，但买入证据取得较晚；只保留为回看候选');
      else if(initiator.classification==='follower')group('market_follower_pattern',initiator.directionalTokens.post,'至少 3 个合约晚于本地 GMGN 榜单首次发现区间，且占可比较样本至少 75%');
      else if(initiator.classification==='mixed')group('market_mixed_pattern',initiator.directionalTokens.pre+initiator.directionalTokens.post,'相对本地 GMGN 榜单首次发现既有至少 2 个前置样本，也有至少 2 个后置样本');
      if(initiator.postActivationExitTokens>=3&&initiator.matchedTokens>0&&initiator.postActivationExitTokens/initiator.matchedTokens>=0.6)
        group('market_repeated_exit',initiator.postActivationExitTokens,'至少 3 个采样合约在本地榜单发现后出现本钱包卖单；缺少完整仓位与价格冲击，不能据此认定砸盘');
      if(initiator.status==='partial'&&!limitations.includes('MARKET_INITIATOR_SAMPLE_PARTIAL'))limitations.push('MARKET_INITIATOR_SAMPLE_PARTIAL');
      if(initiator.qualification){
        const relationPartial=relations.length>20||relations.slice(0,20).some(row=>Number(row.dirty)!==0||
          !validTime(row.updated_at,now)||!validTime(row.active_since,now));
        profile.visibleStartAnalysis=this.visibleStart(chain,address,now,initiator.qualification,relations,
          relationPartial||initiator.status!=='current');
        const visible=profile.visibleStartAnalysis;
        if(visible.classification==='visible_start_candidate'&&visible.status==='current')
          group('market_visible_start',visible.directionalTokens.followed,
            '榜单前置资格成立后，至少 3 个不同合约又出现预先登记的公开钱包后续买入，且占可比较样本至少 75%；只证明本机可见时序，不证明身份或因果');
        if(visible.status==='partial'&&!limitations.includes('VISIBLE_START_SAMPLE_PARTIAL'))limitations.push('VISIBLE_START_SAMPLE_PARTIAL');
      }
    }
    if(txs.size)limitations.push('CHAIN_PARTICIPATION_OR_TRANSFER_IS_NOT_A_BUY_SELL_OR_HOLDING');
    if(unknownChainEventTime)limitations.push('CHAIN_EVENT_TIME_UNKNOWN');
    if(profile.metrics.lastEventAt&&Date.parse(now)-Date.parse(profile.metrics.lastEventAt)>=7*DAY&&!unknownChainEventTime)group('inactive_observed',1,'已采样交易的最后事件距今至少 7 天；数据覆盖不完整，不能认定钱包实际停止活动');
    if(!profile.groups.some(g=>g.id!=='inactive_observed'))group('insufficient_evidence',profile.metrics.observedEvents+profile.metrics.chain.transactions,'当前采样尚不足以归入行为分组；不会把链上参与或供应商标签当作收益证明');
    profile.groups.sort((a,b)=>WALLET_PROFILE_GROUPS.indexOf(a.id)-WALLET_PROFILE_GROUPS.indexOf(b.id));
    // Full current frames are needed while computing/rechecking, not as a
    // second durable copy. Persist UI examples plus qualified frozen proofs.
    for(const peer of profile.roleAnalysis.peers)delete peer.screeningEvidence;
    if(profile.initiatorAnalysis)delete (profile.initiatorAnalysis as Partial<WalletInitiatorAnalysis>).screeningEvidence;
    if(profile.visibleStartAnalysis)delete (profile.visibleStartAnalysis as Partial<WalletVisibleStartAnalysis>).screeningEvidence;
    return profile;
  }

  private visibleStart(chain:Chain,address:string,now:string,qualification:NonNullable<WalletInitiatorAnalysis['qualification']>,
    relations:Row[],truncated:boolean):WalletVisibleStartAnalysis {
    const tokens=[...new Set(qualification.evidence.filter(row=>row.direction==='pre'&&row.prospective)
      .map(row=>chainAddress(chain,row.tokenAddress)).filter((value):value is string=>!!value))],followups:WalletVisibleStartFollowupInput[]=[];
    for(const relation of relations.slice(0,20)){
      const peer=chainAddress(chain,relation.leader),knownAt=String(relation.active_since??'');
      if(!peer||peer===address||Number(relation.dirty)!==0||!validTime(relation.updated_at,now)||!validTime(knownAt,now))continue;
      const relationId=createHash('sha256').update(JSON.stringify([chain,address,peer,knownAt])).digest('hex');
      for(const event of this.firstBuys(chain,peer,tokens,now)){
        const token=chainAddress(chain,event?.tokenAddress);
        if(event?.side!=='buy'||!token)continue;
        followups.push({tokenAddress:token,relation:{id:relationId,candidateWallet:address,peerWallet:peer,peerClass:'public',
          basis:'prior_pair_history',knownAt,source:'wallet_association_store'},peerBuy:{chain,wallet:peer,tokenAddress:token,
          txHash:event.txHash,side:'buy',eventAt:event.eventAt,observedAt:event.observedAt,source:event.source,
          ...(event.eventIndex===undefined?{}:{eventIndex:event.eventIndex})}});
      }
    }
    const old=parse(this.os('SELECT data FROM wp_profiles WHERE chain=? AND address=?').get(chain,address)?.data)?.visibleStartAnalysis as WalletVisibleStartAnalysis|undefined;
    return analyzeWalletVisibleStart({chain,wallet:address,asOf:now,prospectiveMarketPreQualification:qualification,
      followups,previous:old,truncated});
  }
  private roles(chain:Chain,address:string,events:WalletRoleEvent[],truncated:boolean,relations:Row[],now:string):WalletRoleAnalysis {
    const key=chain+':'+address;
    const inputKey=createHash('sha256').update(JSON.stringify([events,relations.map(r=>[r.leader,r.updated_at,r.dirty,r.active_since])])).digest('hex');
    this.roleKeys.set(key,inputKey);
    const cached=this.os('SELECT role_input_key,data FROM wp_profiles WHERE chain=? AND address=?').get(chain,address);
    const old=parse(cached?.data)?.roleAnalysis as WalletRoleAnalysis|undefined;
    if(cached?.role_input_key===inputKey&&old?.version===1&&old.method?.screeningEvidenceLimitPerPeer===30&&
      !old.peers.some(peer=>peer.qualification)&&validTime(old.computedAt,now)&&
      Date.parse(now)-Date.parse(old.computedAt)<Math.min(600000,this.refreshMs))return old;
    // Choose recent candidate contracts before looking at the other wallet's
    // direction. The sampling frame cannot cherry-pick winning early trades.
    const tokens=[...new Set(events.filter(e=>e.side==='buy'&&e.chain===chain&&e.wallet===address&&
      validTime(e.eventAt,now)&&validTime(e.observedAt,now)&&e.eventAt<=e.observedAt).map(e=>chainAddress(chain,e.tokenAddress)).filter((v):v is string=>!!v))];
    if(tokens.length<3){const result=analyzeWalletRoles({chain,wallet:address,asOf:now,walletEvents:events,peers:[],truncated});
      result.limitations.push('候选买入合约少于 3 个，本轮不展开角色比较；不能据此认定没有关联。');return result;}
    const selected=tokens.slice(0,30),placeholders=selected.map(()=>'?').join(',');
    const discovery=this.hs(`SELECT leader,MIN(public_observed_at) AS public_at,COUNT(DISTINCT token_address) AS shared_tokens
      FROM wh_assoc_anchors WHERE chain=? AND token_address IN (${placeholders}) AND public_observed_at<=? AND leader<>?
      GROUP BY leader ORDER BY shared_tokens DESC,leader LIMIT 5`).all(chain,...selected,now,address);
    const peers:WalletRolePeerInput[]=discovery.slice(0,4).flatMap(row=>{
      const peer=chainAddress(chain,row.leader);if(!peer)return [];
      const relation=relations.find(r=>r.leader===peer)??this.hs('SELECT * FROM wh_assoc_relations WHERE chain=? AND leader=? AND candidate=?').get(chain,peer,address);
      const validRelation=relation&&Number(relation.dirty)===0&&validTime(relation.updated_at,now);
      const funding=validRelation?parse(relation!.funding_data):[];
      return [{address:peer,publicObservedAt:String(row.public_at),events:this.firstBuys(chain,peer,selected,now),
        ...(validRelation&&validTime(relation!.active_since,now)?{relationshipKnownAt:String(relation!.active_since)}:{}),
        fundingEvidence:(Array.isArray(funding)?funding:[]).slice(0,10).filter(e=>['direct','common'].includes(e.kind)&&validTime(e.observedAt,now)).map(e=>({
          kind:e.kind,address:e.address,observedAt:e.observedAt,verification:'vendor_claim' as const,
          sharedService:!this.funderUsable(chain,e.address,now)||e.edges?.some((v:any)=>v.sharedService===true),
          conflict:!Array.isArray(e.edges)||!e.edges.length||e.edges.some((v:any)=>v.conflict===true||!validTime(v.observedAt,now)||
            v.snapshotAt&&!validTime(v.snapshotAt,v.observedAt)||v.eventAt&&!validTime(v.eventAt,v.snapshotAt??v.observedAt))}))}];
    });
    const previous=old?structuredClone(old):undefined;
    // Frozen proofs can outlive the moving 30-token comparison frame. Re-read
    // only those old leading contracts, so a newly discovered contradiction
    // cannot survive merely because that contract fell outside the UI sample.
    for(const peer of previous?.peers??[]){
      if(!peer.qualification||!peers.some(row=>row.address===peer.address))continue;
      const outside=peer.qualification.evidence.filter(row=>row.direction==='lead'&&!selected.includes(row.tokenAddress));
      const oldTokens=[...new Set(outside.map(row=>chainAddress(chain,row.tokenAddress)).filter((value):value is string=>!!value))].slice(0,30);
      if(!oldTokens.length)continue;
      const rechecked=analyzeWalletRoles({chain,wallet:address,asOf:now,walletEvents:this.firstBuys(chain,address,oldTokens,now),
        peers:[{address:peer.address,events:this.firstBuys(chain,peer.address,oldTokens,now)}]}).peers[0]?.screeningEvidence??[];
      const same=(a:WalletRoleEventReference|undefined,b:WalletRoleEventReference|undefined)=>!!a&&!!b&&
        a.wallet===b.wallet&&a.txHash===b.txHash&&a.eventAt===b.eventAt&&a.eventIndex===b.eventIndex;
      if(outside.some(prior=>{const current=rechecked.find(row=>row.tokenAddress===prior.tokenAddress);
        return !current||current.direction!=='lead'||!same(current.candidateBuy,prior.candidateBuy)||!same(current.leaderBuy,prior.leaderBuy);}))delete peer.qualification;
    }
    const own=[...this.firstBuys(chain,address,selected,now),...events.filter(e=>e.side==='sell'&&selected.includes(e.tokenAddress))];
    const result=analyzeWalletRoles({chain,wallet:address,asOf:now,walletEvents:own,peers,previous,truncated:truncated||tokens.length>30||discovery.length>4});
    result.limitations.push('先按本钱包最近采样买入选取最多 30 个合约，再按共同合约数选取最多 4 个公开标记钱包；双方最早买入从本地档案重新读取，不按提前结果筛选。');
    result.limitations.push('方向门槛是研究筛选参数，未校准为置信概率；真实预测能力仍需独立登记未来机会及覆盖缺口。');
    if(!peers.length)result.limitations.push('当前采样合约未找到可比较的公开标记钱包，不表示没有上游来源。');
    return result;
  }
  private firstBuys(chain:Chain,wallet:string,selection:string[],now:string):WalletRoleEvent[] {
    if(!selection.length)return [];
    const rows=this.hs(`WITH tokens(token) AS (VALUES ${selection.map(()=>'(?)').join(',')})
      SELECT e.data,(SELECT o.data FROM wh_observations o INDEXED BY wh_observations_event WHERE o.event_id=e.id AND o.kind='trade'
        AND o.observed_at<=? AND json_extract(o.data,'$.eventAt')<>e.event_at LIMIT 1) AS conflict_data,
        (SELECT c.data FROM wh_events c INDEXED BY wh_assoc_wallet_buy
          WHERE c.chain=e.chain AND c.wallet=e.wallet AND c.token_address=e.token_address AND c.side='buy'
            AND c.tx_hash=e.tx_hash AND c.event_at<>e.event_at AND c.event_at<=? AND c.observed_at<=? LIMIT 1) AS canonical_conflict_data
      FROM tokens t CROSS JOIN wh_events e ON e.id=(SELECT x.id FROM wh_events x INDEXED BY wh_assoc_wallet_buy WHERE x.chain=? AND x.wallet=?
        AND x.token_address=t.token AND x.side='buy' AND x.event_at<=? AND x.observed_at<=? ORDER BY x.event_at,x.id LIMIT 1)`)
      .all(...selection,now,now,now,chain,wallet,now,now);
    // Event indexes produce separate canonical IDs. Pass one contradictory
    // row from the same wallet/token/transaction too, so an earlier canonical
    // row cannot hide an incompatible timestamp from either timing model.
    return rows.flatMap(row=>[parse(row.data),parse(row.conflict_data),parse(row.canonical_conflict_data)].filter(Boolean));
  }
  private firstSells(chain:Chain,wallet:string,frames:{token:string;activation:string;buyTx:string}[],now:string):WalletRoleEvent[] {
    if(!frames.length)return [];
    const rows=this.hs(`WITH frames(token,activation,buy_tx) AS (VALUES ${frames.map(()=>'(?,?,?)').join(',')})
      SELECT e.data,(SELECT o.data FROM wh_observations o INDEXED BY wh_observations_event WHERE o.event_id=e.id AND o.kind='trade'
        AND o.observed_at<=? AND json_extract(o.data,'$.eventAt')<>e.event_at LIMIT 1) AS conflict_data,
        (SELECT c.data FROM wh_events c INDEXED BY wh_assoc_wallet_buy
          WHERE c.chain=e.chain AND c.wallet=e.wallet AND c.token_address=e.token_address AND c.side='sell'
            AND c.tx_hash=e.tx_hash AND c.event_at<>e.event_at AND c.event_at<=? AND c.observed_at<=? LIMIT 1) AS canonical_conflict_data
      FROM frames f CROSS JOIN wh_events e ON e.id=(SELECT x.id FROM wh_events x INDEXED BY wh_assoc_wallet_buy WHERE x.chain=? AND x.wallet=?
        AND x.token_address=f.token AND x.side='sell' AND x.tx_hash<>f.buy_tx AND x.event_at>f.activation
        AND x.event_at<=? AND x.observed_at<=? ORDER BY x.event_at,x.id LIMIT 1)`)
      .all(...frames.flatMap(frame=>[frame.token,frame.activation,frame.buyTx]),now,now,now,chain,wallet,now,now);
    return rows.flatMap(row=>[parse(row.data),parse(row.conflict_data),parse(row.canonical_conflict_data)].filter(Boolean));
  }
  private discoverInitiatorTokens(chain:Chain,address:string,events:WalletRoleEvent[],now:string):{tokenAddress:string;marketAt:string}[] {
    const startedAt=this.meta('market_started_at');if(!stamp(startedAt))return [];
    const tokens=[...new Set(events.filter(event=>event?.chain===chain&&event.wallet===address&&event.side==='buy'&&
      validTime(event.observedAt,now)&&event.observedAt>=startedAt).map(event=>chainAddress(chain,event.tokenAddress))
      .filter((value):value is string=>!!value))];
    return [...this.marketFrames(chain,tokens,now)].map(([tokenAddress,marketAt])=>({tokenAddress,marketAt}));
  }
  private initiator(chain:Chain,address:string,now:string,nominations:{tokenAddress:string;marketAt:string}[],coveragePartial=false):WalletInitiatorAnalysis|undefined {
    // The compact output-side ledger is updated only by prospective market
    // nominations or later wallet buys. Periodic profile refreshes therefore
    // never rescan a wallet's full lifetime token set.
    const fetchLimit=Math.min(1000,31+nominations.length),existing=this.os(`SELECT token_address,market_at FROM wp_initiator_tokens
      WHERE chain=? AND address=? ORDER BY market_at DESC,token_address LIMIT ?`).all(chain,address,fetchLimit),candidates=new Map<string,string>();
    for(const row of existing){const token=chainAddress(chain,row.token_address),marketAt=String(row.market_at??''),prior=token&&candidates.get(token);
      if(token&&stamp(marketAt)&&marketAt<=now&&(!prior||marketAt<prior))candidates.set(token,marketAt);}
    for(const row of nominations){const token=chainAddress(chain,row.tokenAddress),marketAt=row.marketAt,prior=token&&candidates.get(token);
      if(token&&stamp(marketAt)&&marketAt<=now&&(!prior||marketAt<prior))candidates.set(token,marketAt);}
    const tokenRows=[...candidates].map(([token_address,market_at])=>({token_address,market_at}))
      .sort((a,b)=>b.market_at.localeCompare(a.market_at)||a.token_address.localeCompare(b.token_address));
    const tokens=tokenRows.slice(0,30).map(row=>row.token_address);if(!tokens.length)return;
    const placeholders=tokens.map(()=>'?').join(','),rows=this.hs(`SELECT id,data FROM wh_observations INDEXED BY wh_exit_evidence
      WHERE chain=? AND token_address IN (${placeholders}) AND kind='market_candidate' AND observed_at<=?
        AND json_extract(data,'$.changeKind')='first_seen'
      ORDER BY observed_at,id LIMIT 121`).all(chain,...tokens,now);
    if(!rows.length)return;
    const firstSeen:GmgnMarketFirstSeen[]=rows.slice(0,120).flatMap(row=>{const data=parse(row.data),token=chainAddress(chain,data?.address);
      if(!data||data.source!=='gmgn_market_discovery'||!token||!['trending','trenches'].includes(data.feed)||!validTime(data.observedAt,now))return [];
      return [{id:String(row.id),source:'gmgn_market_discovery' as const,kind:'first_seen' as const,chain,tokenAddress:token,
        ...(stamp(data.firstSeenLowerBound)?{firstSeenLowerBound:data.firstSeenLowerBound}:{}),
        firstSeenUpperBound:stamp(data.firstSeenUpperBound)?data.firstSeenUpperBound:data.observedAt,
        feed:data.feed as 'trending'|'trenches',window:typeof data.window==='string'&&data.window?data.window:'unknown',
        leftCensored:data.leftCensored===false&&stamp(data.firstSeenLowerBound)?false:true}];});
    if(!firstSeen.length)return;
    const buys=this.firstBuys(chain,address,tokens,now),firstBuy=new Map<string,WalletRoleEvent>();
    for(const event of buys){const token=chainAddress(chain,event?.tokenAddress);if(event?.side==='buy'&&token&&!firstBuy.has(token))firstBuy.set(token,event);}
    const upper=new Map<string,string>();for(const market of firstSeen){const old=upper.get(market.tokenAddress);
      if(!old||market.firstSeenUpperBound<old)upper.set(market.tokenAddress,market.firstSeenUpperBound);}
    const frames=tokens.flatMap(token=>{const buy=firstBuy.get(token),marketAt=upper.get(token);
      if(!buy||!marketAt||!validTime(buy.eventAt,now))return [];
      return [{token,activation:buy.eventAt>marketAt?buy.eventAt:marketAt,buyTx:buy.txHash}];});
    const trades=[...buys,...this.firstSells(chain,address,frames,now)];
    const old=parse(this.os('SELECT data FROM wp_profiles WHERE chain=? AND address=?').get(chain,address)?.data)?.initiatorAnalysis as WalletInitiatorAnalysis|undefined;
    return analyzeWalletInitiator({chain,wallet:address,asOf:now,trades,marketFirstSeen:firstSeen,previous:old,
      truncated:coveragePartial||tokenRows.length>30||rows.length>120});
  }
  private funderUsable(chain:Chain,address:unknown,now:string):boolean {
    const value=chainAddress(chain,address);if(!value)return false;
    const key=chain+':'+value,cached=this.funderCache.get(key);if(cached!==undefined)return cached;
    const wallet=this.hs('SELECT profile FROM wh_wallets WHERE chain=? AND address=?').get(chain,value),labels=parse(wallet?.profile)?.labels;
    let usable=!(Array.isArray(labels)&&labels.some((v:unknown)=>SERVICES.has(String(v))))&&
      !this.hs('SELECT 1 FROM wh_funding WHERE chain=? AND funding_address=? AND shared=1 AND observed_at<=? LIMIT 1').get(chain,value,now);
    if(usable)usable=this.hs('SELECT DISTINCT wallet FROM wh_funding WHERE chain=? AND funding_address=? AND observed_at<=? LIMIT 21').all(chain,value,now).length<=20;
    this.funderCache.set(key,usable);return usable;
  }
  private save(profile:WalletProfile):void {
    const oldRow=this.os('SELECT data,source_wallet,role_computed_at FROM wp_profiles WHERE chain=? AND address=?').get(profile.chain,profile.address);
    const old=parse(oldRow?.data) as WalletProfile|undefined;
    const peers=new Set((profile.roleAnalysis?.peers??[]).filter(peer=>peer.qualification&&
      JSON.stringify(peer.qualification)!==JSON.stringify(old?.roleAnalysis?.peers.find(previous=>previous.address===peer.address)?.qualification)).map(peer=>peer.address));
    const initiator=!!profile.initiatorAnalysis?.qualification&&
      JSON.stringify(profile.initiatorAnalysis.qualification)!==JSON.stringify(old?.initiatorAnalysis?.qualification);
    const visibleStart=!!profile.visibleStartAnalysis?.qualification&&
      JSON.stringify(profile.visibleStartAnalysis.qualification)!==JSON.stringify(old?.visibleStartAnalysis?.qualification);
    if(peers.size||initiator||visibleStart)this.newQualifications.set(profile.chain+':'+profile.address,{profile,peers,initiator,visibleStart});
    const previous=new Set(old?.groups.map(g=>g.id)??[]),current=new Set(profile.groups.map(g=>g.id));
    for(const group of profile.groups){this.os('INSERT OR IGNORE INTO wp_group_first VALUES (?,?,?,?)').run(profile.chain,profile.address,group.id,profile.computedAt);
      group.firstObservedAt=String(this.os('SELECT first_at FROM wp_group_first WHERE chain=? AND address=? AND group_id=?').get(profile.chain,profile.address,group.id)!.first_at);}
    const added=profile.groups.map(g=>g.id).filter(id=>!previous.has(id)),removed=(old?.groups.map(g=>g.id)??[]).filter(id=>!current.has(id));
    if(added.length||removed.length)this.os('INSERT INTO wp_changes(chain,address,observed_at,data) VALUES (?,?,?,?)').run(profile.chain,profile.address,profile.computedAt,JSON.stringify({at:profile.computedAt,added,removed}));
    this.os(`INSERT INTO wp_profiles(chain,address,computed_at,fresh_until,data,source_wallet,role_computed_at,role_input_key) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(chain,address)
      DO UPDATE SET computed_at=excluded.computed_at,fresh_until=excluded.fresh_until,data=excluded.data,source_wallet=excluded.source_wallet,
        role_computed_at=excluded.role_computed_at,role_input_key=excluded.role_input_key`)
      .run(profile.chain,profile.address,profile.computedAt,profile.freshUntil,JSON.stringify(profile),profile.source==='wallet_history'?1:0,
        profile.roleAnalysis?.computedAt??null,this.roleKeys.get(profile.chain+':'+profile.address)??null);
    for(const nomination of this.initiatorNominations.get(profile.chain+':'+profile.address)??[])
      this.os(`INSERT INTO wp_initiator_tokens VALUES (?,?,?,?) ON CONFLICT(chain,address,token_address)
        DO UPDATE SET market_at=MIN(wp_initiator_tokens.market_at,excluded.market_at)`)
        .run(profile.chain,profile.address,nomination.tokenAddress,nomination.marketAt);
    this.os('DELETE FROM wp_groups WHERE chain=? AND address=?').run(profile.chain,profile.address);
    for(const group of profile.groups)this.os('INSERT INTO wp_groups VALUES (?,?,?,?)').run(profile.chain,profile.address,group.id,group.firstObservedAt);
    const status=this.cachedStatus;if(!status)return;
    const wasSource=Number(oldRow?.source_wallet)===1,isSource=profile.source==='wallet_history',hadRole=!!oldRow?.role_computed_at,hasRole=!!profile.roleAnalysis?.computedAt;
    if(!oldRow){status.profiles++;if(hasRole)status.roleProfiles++;else status.rolePending++;}
    else if(hadRole!==hasRole){status.roleProfiles+=hasRole?1:-1;status.rolePending+=hasRole?-1:1;}
    if(wasSource!==isSource)status.profiledSourceWallets+=isSource?1:-1;
    if(hasRole&&(!status.roleLastRunAt||profile.roleAnalysis!.computedAt>status.roleLastRunAt))status.roleLastRunAt=profile.roleAnalysis!.computedAt;
    for(const id of previous)if(!current.has(id))status.groupCounts[id]=Math.max(0,(status.groupCounts[id]??0)-1);
    for(const id of current)if(!previous.has(id))status.groupCounts[id]=(status.groupCounts[id]??0)+1;
  }
  private refreshProfitCohorts(now:string,dirty:boolean):void {
    const nowMs=Date.parse(now),complete=CHAINS.every(chain=>!!this.cachedProfitCohorts[chain]);
    const expired=Object.values(this.cachedProfitCohorts).some(snapshot=>Date.parse(snapshot!.validUntil)<=nowMs);
    if(complete&&nowMs>=this.cohortsAt&&!expired&&nowMs-this.cohortsAt<60_000&&(!dirty||nowMs-this.cohortsAt<10_000))return;
    const configured=Number(this.options.cohortMaxAgeSec),maxAgeMs=(Number.isFinite(configured)?Math.max(120,Math.min(1800,configured)):300)*1000;
    const cohorts:WalletProfitCohorts={};
    for(const chain of CHAINS){
      let validUntil=nowMs+maxAgeMs;
      const values=this.os(`SELECT json_extract(p.data,'$.chain') AS chain,json_extract(p.data,'$.metrics.vendorProfit') AS profit
        FROM wp_groups g INDEXED BY wp_groups_filter CROSS JOIN wp_profiles p ON p.chain=g.chain AND p.address=g.address
        WHERE g.group_id='public_kol' AND g.chain=? ORDER BY p.computed_at DESC LIMIT 2000`).all(chain).flatMap(row=>{
        const v=parse(row.profit) as WalletProfile['metrics']['vendorProfit'],n=Number(v?.realizedProfitUsd);
        if(row.chain!==chain||v?.verification!=='vendor_claim'||v.period!=='7d'||!Number.isFinite(n)||n<=0||n>1e12||
          !stamp(v.snapshotAt)||!stamp(v.observedAt)||v.snapshotAt>v.observedAt)return [];
        const observedAt=Date.parse(v.observedAt),expiresAt=Date.parse(v.snapshotAt)+DAY+1;
        if(observedAt>nowMs){validUntil=Math.min(validUntil,observedAt);return [];}
        if(expiresAt<=nowMs)return [];
        validUntil=Math.min(validUntil,expiresAt);return [n];
      });
      cohorts[chain]={asOf:now,validUntil:new Date(validUntil).toISOString(),values};
    }
    this.cachedProfitCohorts=cohorts;this.cohortsAt=nowMs;this.saveSnapshot('profit_cohorts',now,cohorts);
  }
  profitCohorts():WalletProfitCohorts {return structuredClone(this.cachedProfitCohorts);}
  status():WalletProfileStatus {
    const now=this.now().toISOString(),nowMs=Date.parse(now);
    if(!this.cachedStatus||nowMs<this.statusAt||nowMs-this.statusAt>=600_000){
      this.cachedStatus=aggregateStatus(this.db,this.options.database,now,this.refreshMs/1000);this.statusAt=nowMs;
    }else this.cachedStatus=updateStatus(this.cachedStatus,this.db,this.options.database,now,this.refreshMs/1000);
    this.saveSnapshot('profile_status',now,this.cachedStatus);return structuredClone(this.cachedStatus);
  }
  close():void {this.chain?.close();this.history.close();this.db.close();}
}
function aggregateStatus(db:DatabaseSync,path:string,now:string,refreshAfterSec?:number):WalletProfileStatus {
  const meta=Object.fromEntries(db.prepare('SELECT key,value FROM wp_meta').all().map(r=>[String(r.key),String(r.value)]));
  const groupCounts:WalletProfileStatus['groupCounts']={};for(const row of db.prepare('SELECT group_id,count(*) AS n FROM wp_groups GROUP BY group_id').all())groupCounts[row.group_id as WalletProfileGroupId]=Number(row.n);
  const roles=db.prepare('SELECT COUNT(role_computed_at) AS n,MAX(role_computed_at) AS latest,COUNT(*)-COUNT(role_computed_at) AS pending FROM wp_profiles').get()!;
  return {ready:true,profiles:Number(db.prepare('SELECT count(*) AS n FROM wp_profiles').get()!.n),sourceWallets:Number(meta.source_wallets||0),
    roleProfiles:Number(roles.n),rolePending:Number(roles.pending),roleLastRunAt:roles.latest?String(roles.latest):undefined,
    profiledSourceWallets:Number(db.prepare('SELECT count(*) AS n FROM wp_profiles WHERE source_wallet=1').get()!.n),initialComplete:meta.initial_complete==='1',processed:Number(meta.processed||0),
    lastRunAt:meta.last_run_at||undefined,groupCounts,bytes:filesBytes(path,db),maxBytes:Number(meta.max_bytes||0),capacityReached:meta.error===CAPACITY,error:meta.error||undefined,sampleOnly:true,aggregatedAt:now,
    staleProfiles:Number(db.prepare('SELECT count(*) AS n FROM wp_profiles WHERE computed_at<=?').get(
      new Date(Date.parse(now)-Math.max(1,refreshAfterSec??Number(meta.refresh_after_sec||21600))*1000).toISOString())!.n)};
}
function updateStatus(base:WalletProfileStatus,db:DatabaseSync,path:string,now:string,refreshAfterSec?:number):WalletProfileStatus {
  const meta=Object.fromEntries(db.prepare('SELECT key,value FROM wp_meta').all().map(r=>[String(r.key),String(r.value)]));
  return {...base,sourceWallets:Number(meta.source_wallets||0),initialComplete:meta.initial_complete==='1',processed:Number(meta.processed||0),
    lastRunAt:meta.last_run_at||undefined,bytes:filesBytes(path,db),maxBytes:Number(meta.max_bytes||0),capacityReached:meta.error===CAPACITY,
    error:meta.error||undefined,staleProfiles:Number(db.prepare('SELECT count(*) AS n FROM wp_profiles WHERE computed_at<=?').get(
      new Date(Date.parse(now)-Math.max(1,refreshAfterSec??Number(meta.refresh_after_sec||21600))*1000).toISOString())!.n)};
}
function validStatus(value:unknown):value is WalletProfileStatus {if(!value||typeof value!=='object')return false;const status=value as Partial<WalletProfileStatus>;
  return status.ready===true&&Number.isSafeInteger(status.profiles)&&status.profiles!>=0&&Number.isSafeInteger(status.profiledSourceWallets)&&status.profiledSourceWallets!>=0&&
    Number.isSafeInteger(status.roleProfiles)&&status.roleProfiles!>=0&&Number.isSafeInteger(status.rolePending)&&status.rolePending!>=0&&!!status.groupCounts&&typeof status.groupCounts==='object';}
function validProfitCohorts(value:unknown):value is WalletProfitCohorts {if(!value||typeof value!=='object')return false;
  return CHAINS.every(chain=>{const item=(value as WalletProfitCohorts)[chain];return !!item&&stamp(item.asOf)&&stamp(item.validUntil)&&item.asOf<=item.validUntil&&
    Array.isArray(item.values)&&item.values.length<=2000&&item.values.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1e12);});}
/** The web process reads only this compact derived database, never the full research graph. */
export class WalletProfileReader {
  private db?:DatabaseSync;
  private refreshMs:number;
  private profitCohorts?:WalletProfitCohorts;
  constructor(private readonly database:string,private readonly now:()=>Date=()=>new Date(),private readonly refreshAfterSec?:number){
    this.refreshMs=Math.max(1,refreshAfterSec??21600)*1000;
  }
  private open():DatabaseSync|undefined {
    if(this.db)return this.db;if(!existsSync(this.database))return;
    try {const db=new DatabaseSync(this.database,{readOnly:true});db.exec('PRAGMA busy_timeout=500; PRAGMA query_only=ON');
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wp_profiles'").get()){db.close();return;}
      if(this.refreshAfterSec===undefined)
        this.refreshMs=Math.max(1,Number(db.prepare("SELECT value FROM wp_meta WHERE key='refresh_after_sec'").get()?.value??21600))*1000;
      this.db=db;this.loadProfitCohorts(db);return db;
    }catch{return;}
  }
  private loadProfitCohorts(db:DatabaseSync):void {try {const row=db.prepare("SELECT data FROM wp_snapshots WHERE key='profit_cohorts'").get(),value=parse(row?.data);
    if(validProfitCohorts(value))this.profitCohorts=value;}catch{/* The worker may still be creating the snapshot table. */}}
  replaceProfitCohorts(value:unknown):void {if(validProfitCohorts(value))this.profitCohorts=structuredClone(value);}
  status():WalletProfileStatus {const db=this.open();if(!db)return emptyStatus();try {const row=db.prepare("SELECT data FROM wp_snapshots WHERE key='profile_status'").get(),value=parse(row?.data);
    return validStatus(value)?updateStatus(value,db,this.database,this.now().toISOString(),this.refreshMs/1000):{...emptyStatus(),ready:true};
    }catch{return {...emptyStatus(),ready:true};}}
  /** The cohort is local sampled public wallets, never a global profit leaderboard. */
  profitCohort(chain:Chain,now=new Date()):number[] {
    this.open();const snapshot=this.profitCohorts?.[chain],at=now.toISOString();
    return snapshot&&snapshot.asOf<=at&&at<snapshot.validUntil?snapshot.values.slice():[];
  }
  private profile(data:unknown):WalletProfile {const profile=parse(data) as WalletProfile;
    // The configured recomputation window may extend legacy rows that were
    // written with the old 30-minute cadence, but it must never extend time
    // bounded evidence such as a vendor-profit snapshot past its own 24-hour
    // validity boundary.
    let untilMs=Date.parse(profile.computedAt)+this.refreshMs;
    const profit=profile.metrics?.vendorProfit;
    if(profit&&stamp(profit.snapshotAt))untilMs=Math.min(untilMs,Date.parse(profit.snapshotAt)+DAY+1);
    const until=new Date(untilMs).toISOString();profile.freshUntil=until;
    if(until<=this.now().toISOString())profile.status='stale';return profile;}
  list(options:WalletProfileListOptions={}):{ready:boolean;items:WalletProfile[];total:number} {
    const db=this.open();if(!db)return {ready:false,items:[],total:0};const where:string[]=[],args:(string|number)[]=[];
    if(options.chain){where.push('p.chain=?');args.push(options.chain);}if(options.group){where.push('EXISTS(SELECT 1 FROM wp_groups g WHERE g.chain=p.chain AND g.address=p.address AND g.group_id=?)');args.push(options.group);}
    if(options.search){where.push('instr(lower(p.address),?)>0');args.push(String(options.search).toLowerCase().slice(0,160));}
    const sql=where.length?' WHERE '+where.join(' AND '):'',limit=bounded(options.limit,50,200),offset=typeof options.offset==='number'&&Number.isSafeInteger(options.offset)?Math.max(0,options.offset):0;
    const total=Number(db.prepare('SELECT count(*) AS n FROM wp_profiles p'+sql).get(...args)!.n);
    const rows=db.prepare('SELECT p.data FROM wp_profiles p'+sql+' ORDER BY p.computed_at DESC,p.chain,p.address LIMIT ? OFFSET ?').all(...args,limit,offset);
    return {ready:true,items:rows.map(row=>this.profile(row.data)),total};
  }
  get(chain:Chain,address:string):WalletProfile|undefined {const db=this.open(),wallet=chainAddress(chain,address);if(!db||!wallet)return;const row=db.prepare('SELECT data FROM wp_profiles WHERE chain=? AND address=?').get(chain,wallet);if(!row)return;
    return {...this.profile(row.data),changes:db.prepare('SELECT data FROM wp_changes WHERE chain=? AND address=? ORDER BY id DESC LIMIT 20').all(chain,wallet).map(r=>parse(r.data))};}
  getMany(targets:{chain:Chain;address:string}[]):WalletProfile[]{const db=this.open();if(!db)return [];const statement=db.prepare('SELECT data FROM wp_profiles WHERE chain=? AND address=?');return targets.slice(0,200).flatMap(t=>{const wallet=chainAddress(t.chain,t.address);if(!wallet)return [];const row=statement.get(t.chain,wallet);return row?[this.profile(row.data)]:[];});}
  /** Indexed, bounded snapshot for the live watcher; no full-profile COUNT or historical detail reads. */
  streamTargets(chain:Chain,limit=10):WalletProfile[]{
    const db=this.open();if(!db)return [];const cap=Math.max(1,Math.min(30,Math.trunc(limit))),groups=['market_visible_start','market_precursor_pattern','forward_validated','repeated_early','public_kol'],
      quota=Math.max(1,Math.ceil(cap/groups.length)),result=new Map<string,WalletProfile>();
    for(const group of groups){
      const rows=db.prepare(`SELECT p.data FROM wp_groups g INDEXED BY wp_groups_filter CROSS JOIN wp_profiles p ON p.chain=g.chain AND p.address=g.address
        WHERE g.group_id=? AND g.chain=? AND p.computed_at>? ORDER BY p.computed_at DESC,p.address LIMIT ?`)
        .all(group,chain,new Date(this.now().getTime()-this.refreshMs).toISOString(),quota);
      for(const row of rows){const profile=this.profile(row.data);result.set(profile.address,profile);}
    }
    return [...result.values()].slice(0,cap);
  }
  close():void {this.db?.close();this.db=undefined;this.profitCohorts=undefined;this.refreshMs=Math.max(1,this.refreshAfterSec??21600)*1000;}
}
