import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {chmodSync,existsSync,mkdirSync,realpathSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import bs58 from 'bs58';
import {chainAddress} from './chain-stream-store.js';
import {qualifiedRoleEvidence,type WalletRolePeerAnalysis} from './wallet-role-analysis.js';
import type {ActivityKind} from './wallet-activity.js';
import type {WalletProfile} from './wallet-profiles.js';
import type {Chain} from './types.js';
import {configureResearchWal} from './research-sqlite.js';

export type LauncherCandidateProfileRoute='A'|'B';
export type LauncherCandidateState='historical_seed'|'fresh_verified'|'live_seen'|'monitored';

export interface LauncherRealtimeObservation {
  chain:Chain;wallet:string;
  /** A direct feed supplies observedAt. A launcher revalidator supplies checkedAt. */
  observedAt?:string;checkedAt?:string;source?:string;
  latestSignature?:string;blockTime?:number;slot?:number;
  state?:'baseline'|'unchanged'|'changed'|'empty'|'error';newSignature?:boolean;
  classification?:ActivityKind;error?:string;
}

export interface LauncherRevalidationObservation {
  chain:Chain;wallet:string;checkedAt:string;latestSignature?:string;blockTime?:number;slot?:number;
  state:'baseline'|'unchanged'|'changed'|'empty'|'error';newSignature?:boolean;classification?:ActivityKind;error?:string;
}

export interface LauncherActivityObservation {
  chain:Chain;wallet:string;checkedAt:string;eventAt?:string;classification:ActivityKind;
  confirmation:'confirmed'|'included'|'unknown';txHash:string;tokenAddress?:string;
  trades?:readonly {tokenAddress:string;side:'buy'|'sell'}[];
}
export interface LauncherActivityRetraction {chain:Chain;wallet:string;checkedAt:string;txHash:string;}

export interface LauncherRevalidationEvidence {
  checkedAt:string;latestSignature?:string;blockTime?:number;eventAt?:string;slot?:number;
  state?:LauncherRealtimeObservation['state'];classification?:ActivityKind;error?:string;
}

export interface LauncherCandidate {
  version:1;chain:Chain;address:string;route:LauncherCandidateProfileRoute;state:LauncherCandidateState;
  qualifiedAt:string;profileComputedAt:string;lastEvidenceAt?:string;
  verifiedAt?:string;verifiedActivityAt?:string;liveSeenAt?:string;
  lastVerifiedBuyAt?:string;lastVerifiedBuyTx?:string;lastVerifiedBuyToken?:string;
  lastVerifiedSellAt?:string;lastVerifiedSellTx?:string;lastVerifiedSellToken?:string;
  monitored:boolean;coverageAt?:string;revalidation?:LauncherRevalidationEvidence;
  dimensions:{evidenceFresh:boolean;verifiedTradeFresh:boolean;liveSeen:boolean;monitored:boolean;
    realtimeReady:boolean;verifiedTradeMonitored:boolean};
  reasons:string[];sampleOnly:true;tradingEnabled:false;
}

export interface LauncherCandidateStatus {
  ready:boolean;records:number;cap:number;bytes:number;maxBytes:number;capacityReached:boolean;
  chainCounts:Record<Chain,number>;
  routeCounts:Record<LauncherCandidateProfileRoute,number>;
  stateCounts:Record<LauncherCandidateState,number>;lastRefreshAt?:string;error?:string;
  dimensionCounts:{evidenceFresh:number;verifiedTradeFresh:number;liveSeen:number;monitored:number;
    realtimeReady:number;verifiedTradeMonitored:number};
  sampleOnly:true;tradingEnabled:false;
}

export interface LauncherCandidateListOptions {
  chain?:Chain;route?:LauncherCandidateProfileRoute;state?:LauncherCandidateState;limit?:number;offset?:number;
}

export interface LauncherCandidateList {
  items:LauncherCandidate[];total:number;limit:number;offset:number;
}

export interface LauncherCoverageUpdate {chain:Chain;wallets:readonly string[];at:string}
export interface LauncherCoverageBatchResult {
  counts:Partial<Record<Chain,number>>;capacityReached:boolean;
}
export interface LauncherRealtimeBatchResult {changed:number;capacityReached:boolean}

export interface LauncherCandidatesOptions {
  database:string;profileDatabase:string;cap?:number;maxBytes?:number;
  freshAfterSec?:number;liveAfterSec?:number;coverageAfterSec?:number;
  /** Bounds synchronous SQLite writer-lock waits on this connection. */
  busyTimeoutMs?:number;now?:()=>Date;
}

type Row=Record<string,unknown>;
type StoredBase={version:1;reasons:string[];sampleOnly:true;tradingEnabled:false};
type CandidateSeed={chain:Chain;address:string;route:LauncherCandidateProfileRoute;qualifiedAt:string;
  profileComputedAt:string;lastEvidenceAt?:string;base:StoredBase};

const CHAINS:readonly Chain[]=['bsc','solana','robinhood'];
const CAPACITY='LAUNCHER_CANDIDATE_CAPACITY_REACHED';
const DATABASE_SEPARATE='LAUNCHER_CANDIDATE_DATABASE_MUST_BE_SEPARATE';
const DEFAULT_MAX_BYTES=16*1024*1024;
const MIN_DATABASE_BYTES=64*1024;
const RECORD_RESERVE_BYTES=4096;
const REFRESH_RESERVE_BYTES=64*1024;
const QUALIFICATION_MAX_AGE_MS=30*86_400_000;

const parse=(value:unknown):unknown=>{try{return typeof value==='string'?JSON.parse(value):undefined;}catch{return undefined;}};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonicalPath=(path:string):string=>path===':memory:'?path:existsSync(path)?realpathSync(path):resolve(path);
const sameDatabase=(left:string,right:string):boolean=>{
  if(canonicalPath(left)===canonicalPath(right))return true;
  if(left===':memory:'||right===':memory:'||!existsSync(left)||!existsSync(right))return false;
  const a=statSync(left),b=statSync(right);return a.dev===b.dev&&a.ino===b.ino;
};
const fileBytes=(path:string,db:DatabaseSync):number=>path===':memory:'?
  Number((db.prepare('PRAGMA page_count').get() as Row).page_count)*Number((db.prepare('PRAGMA page_size').get() as Row).page_size):
  [path,path+'-wal',path+'-shm'].reduce((total,file)=>{try{return total+statSync(file).size;}catch{return total;}},0);
const time=(value:unknown):number|undefined=>typeof value==='string'&&value.length<=32&&/^\d{4}-\d\d-\d\dT/.test(value)&&
  Number.isFinite(Date.parse(value))?Date.parse(value):undefined;
const iso=(value:number):string=>new Date(value).toISOString();
const later=(...values:(string|undefined)[]):string|undefined=>{
  let selected:string|undefined,selectedAt=-Infinity;
  for(const value of values){const at=time(value);if(at!==undefined&&at>selectedAt){selected=iso(at);selectedAt=at;}}
  return selected;
};
const boundedInteger=(value:number|undefined,fallback:number,min:number,max:number):number=>
  value===undefined?fallback:Number.isSafeInteger(value)&&value>=min&&value<=max?value:(()=>{throw new Error('LAUNCHER_CANDIDATE_CONFIG_INVALID');})();
const chain=(value:unknown):Chain|undefined=>typeof value==='string'&&CHAINS.includes(value as Chain)?value as Chain:undefined;
const transaction=(network:Chain,value:unknown):string|undefined=>{
  if(typeof value!=='string')return;
  if(network!=='solana')return /^0x[\da-f]{64}$/i.test(value)?value.toLowerCase():undefined;
  try{return value.length<=88&&bs58.decode(value).length===64?value:undefined;}catch{return;}
};
const source=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_.:-]{0,79}$/i.test(value);
const natural=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const sqlValue=(value:unknown):string|number|bigint|null=>
  typeof value==='string'||typeof value==='number'||typeof value==='bigint'?value:null;
const sqliteCapacity=(error:unknown):boolean=>error instanceof Error&&(/SQLITE_FULL|database or disk is full/i.test(error.message));

function evidenceTime(value:unknown,now:number):string|undefined {
  const at=time(value);return at!==undefined&&at<=now?iso(at):undefined;
}

function profileEvidence(profile:WalletProfile,route:LauncherCandidateProfileRoute,peers:readonly WalletRolePeerAnalysis[],now:number):string|undefined {
  const values:string[]=[];
  const add=(value:unknown)=>{const valid=evidenceTime(value,now);if(valid)values.push(valid);};
  // Freshness is candidate-wallet trade evidence. Coverage timestamps, market
  // observations, counterparties and unrelated chain transfers never renew it.
  if(route==='A'){
    const analysis=profile.initiatorAnalysis;
    for(const row of [...(analysis?.evidence??[]),...(analysis?.screeningEvidence??[]),...(analysis?.qualification?.evidence??[])]){
      add(row.buy?.eventAt);add(row.buy?.observedAt);add(row.postActivationExit?.eventAt);add(row.postActivationExit?.observedAt);
    }
  }else for(const peer of peers)for(const row of peer.qualification?.evidence??[]){
    add(row.candidateBuy?.eventAt);add(row.candidateBuy?.observedAt);
    add(row.candidateSellAfterLeader?.eventAt);add(row.candidateSellAfterLeader?.observedAt);
  }
  return later(...values);
}

function validProfile(value:unknown,row:Row):WalletProfile|undefined {
  if(!object(value)||value.version!==1)return;
  const network=chain(value.chain),address=network&&chainAddress(network,value.address);
  if(!network||network!==row.chain||!address||address!==row.address||!Array.isArray(value.groups)||!object(value.metrics))return;
  return value as unknown as WalletProfile;
}

function parseBase(value:unknown):StoredBase {
  const parsed=parse(value);
  if(!object(parsed)||parsed.version!==1||!Array.isArray(parsed.reasons))return {version:1,reasons:[],sampleOnly:true,tradingEnabled:false};
  const reasons=parsed.reasons.filter((item):item is string=>typeof item==='string'&&item.length<=160).slice(0,4);
  return {version:1,reasons,sampleOnly:true,tradingEnabled:false};
}

/** A compact, independently persisted pool derived from the indexed profile groups. */
export class LauncherCandidates {
  private readonly db:DatabaseSync;private readonly profiles:DatabaseSync;private readonly now:()=>Date;
  private readonly cap:number;private readonly maxBytes:number;private readonly freshMs:number;private readonly liveMs:number;
  private readonly coverageMs:number;private readonly statements=new Map<string,StatementSync>();
  private closed=false;private capacity=false;

  constructor(private readonly options:LauncherCandidatesOptions){
    if(!options||typeof options.database!=='string'||!options.database||typeof options.profileDatabase!=='string'||!options.profileDatabase||
      sameDatabase(options.database,options.profileDatabase))throw new Error(DATABASE_SEPARATE);
    this.cap=boundedInteger(options.cap,500,1,5000);this.maxBytes=boundedInteger(options.maxBytes,DEFAULT_MAX_BYTES,MIN_DATABASE_BYTES,1024*1024*1024);
    this.freshMs=boundedInteger(options.freshAfterSec,86_400,1,7*86_400)*1000;
    this.liveMs=boundedInteger(options.liveAfterSec,86_400,1,7*86_400)*1000;
    this.coverageMs=boundedInteger(options.coverageAfterSec,120,1,86_400)*1000;
    this.now=options.now??(()=>new Date());this.currentTime();
    this.profiles=new DatabaseSync(options.profileDatabase,{readOnly:true});
    try {
      this.profiles.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');
      const schema=this.profiles.prepare("SELECT name,type FROM sqlite_master WHERE name IN ('wp_profiles','wp_groups','wp_groups_filter')").all() as Row[];
      if(!schema.some(row=>row.name==='wp_profiles'&&row.type==='table')||!schema.some(row=>row.name==='wp_groups'&&row.type==='table')||
        !schema.some(row=>row.name==='wp_groups_filter'&&row.type==='index'))throw new Error('LAUNCHER_PROFILE_DATABASE_INVALID');
      if(options.database!==':memory:')mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
      this.db=new DatabaseSync(options.database);if(options.database!==':memory:')chmodSync(options.database,0o600);
      const busyTimeoutMs=boundedInteger(options.busyTimeoutMs,1000,0,5000);
      configureResearchWal(this.db,{busyTimeoutMs,autoCheckpointPages:32});
      this.db.exec(`CREATE TABLE IF NOT EXISTS lc_candidates(
          chain TEXT NOT NULL,address TEXT NOT NULL,route TEXT NOT NULL,qualified_at TEXT NOT NULL,profile_computed_at TEXT NOT NULL,
          last_evidence_at TEXT,verified_at TEXT,activity_at TEXT,live_seen_at TEXT,live_source TEXT,
          monitored INTEGER NOT NULL DEFAULT 0,coverage_at TEXT,revalidation_checked_at TEXT,latest_signature TEXT,
          block_time INTEGER,slot INTEGER,revalidation_state TEXT,revalidation_classification TEXT,revalidation_error TEXT,
          last_verified_buy_at TEXT,last_verified_buy_tx TEXT,last_verified_buy_token TEXT,
          last_verified_sell_at TEXT,last_verified_sell_tx TEXT,last_verified_sell_token TEXT,
          updated_at TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(chain,address));
        CREATE INDEX IF NOT EXISTS lc_candidates_route ON lc_candidates(route,chain,address);
        CREATE INDEX IF NOT EXISTS lc_candidates_activity ON lc_candidates(activity_at DESC,chain,address);
        CREATE TABLE IF NOT EXISTS lc_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
      const candidateColumns=new Set((this.db.prepare('PRAGMA table_info(lc_candidates)').all() as Row[]).map(row=>String(row.name)));
      for(const column of ['last_verified_buy_at','last_verified_buy_tx','last_verified_buy_token',
        'last_verified_sell_at','last_verified_sell_tx','last_verified_sell_token'])
        if(!candidateColumns.has(column))this.db.exec(`ALTER TABLE lc_candidates ADD COLUMN ${column} TEXT`);
      this.db.exec('CREATE INDEX IF NOT EXISTS lc_candidates_buy ON lc_candidates(last_verified_buy_at DESC,chain,address)');
      const pageSize=Number((this.db.prepare('PRAGMA page_size').get() as Row).page_size);
      if(options.database!==':memory:'&&Number.isSafeInteger(pageSize)&&pageSize>0)this.db.exec(`PRAGMA max_page_count=${Math.max(1,Math.floor(this.maxBytes/pageSize))}`);
      this.setMeta('max_bytes',String(this.maxBytes));this.setMeta('cap',String(this.cap));
      if(!this.meta('rotation_started_at'))this.setMeta('rotation_started_at',iso(this.currentTime()));
      this.capacity=this.meta('error')===CAPACITY;
    }catch(error){this.profiles.close();throw error;}
  }

  private currentTime():number {const value=this.now().getTime();if(!Number.isFinite(value))throw new Error('LAUNCHER_CANDIDATE_TIME_INVALID');return value;}
  private statement(sql:string):StatementSync {let value=this.statements.get(sql);if(!value){value=this.db.prepare(sql);this.statements.set(sql,value);}return value;}
  private meta(key:string):string{return String((this.statement('SELECT value FROM lc_meta WHERE key=?').get(key) as Row|undefined)?.value??'');}
  private setMeta(key:string,value:string):void {this.statement(`INSERT INTO lc_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key,value);}
  private bytes():number{return fileBytes(this.options.database,this.db);}
  private markCapacity():void {this.capacity=true;try{this.setMeta('error',CAPACITY);}catch{/* The in-memory flag remains authoritative if SQLite is already full. */}}
  private clearCapacity():void {this.capacity=false;this.setMeta('error','');}

  private sourceRows(route:LauncherCandidateProfileRoute):Row[]{
    const scan=Math.min(100_000,Math.max(this.cap*20,2000));
    if(route==='A')return this.profiles.prepare(`SELECT p.chain,p.address,p.computed_at,p.data,g.first_at AS qualified_at
      FROM wp_groups AS g INDEXED BY wp_groups_filter JOIN wp_profiles AS p ON p.chain=g.chain AND p.address=g.address
      WHERE g.group_id='market_pre_candidate' ORDER BY g.chain,g.address LIMIT ?`).all(scan) as Row[];
    return this.profiles.prepare(`SELECT p.chain,p.address,p.computed_at,p.data,
        CASE WHEN g.first_at>f.first_at THEN g.first_at ELSE f.first_at END AS qualified_at
      FROM wp_groups AS g INDEXED BY wp_groups_filter
      JOIN wp_groups AS f INDEXED BY wp_groups_filter ON f.group_id='forward_validated' AND f.chain=g.chain AND f.address=g.address
      JOIN wp_profiles AS p ON p.chain=g.chain AND p.address=g.address
      WHERE g.group_id='precursor_pattern' ORDER BY g.chain,g.address LIMIT ?`).all(scan) as Row[];
  }

  private seed(row:Row,route:LauncherCandidateProfileRoute,now:number):CandidateSeed|undefined {
    const profile=validProfile(parse(row.data),row),network=chain(row.chain),address=network&&chainAddress(network,row.address);
    const computed=evidenceTime(row.computed_at,now),qualified=evidenceTime(row.qualified_at,now);
    if(!profile||!network||!address||!computed||!qualified)return;
    let peers:WalletRolePeerAnalysis[]=[];
    if(route==='A'){
      const analysis=profile.initiatorAnalysis,prospective=analysis?.prospectivePreTokens,selected=analysis?.selectedTokens;
      if(analysis?.status!=='current'||analysis.chain!==network||analysis.classification!=='candidate'||
        !natural(prospective)||prospective<1||!natural(selected)||selected<1||prospective/selected<.1||
        chainAddress(network,analysis.wallet)!==address)return;
    }else{
      const analysis=profile.roleAnalysis;if(!analysis||!Array.isArray(analysis.peers))return;
      peers=analysis.peers.filter(peer=>peer?.classification==='precursor_pattern'&&
        peer.forwardObservedTokens>=1&&
        time(peer.qualification?.knownAt)!==undefined&&now-time(peer.qualification!.knownAt)!<=QUALIFICATION_MAX_AGE_MS&&
        !!chainAddress(network,peer.address)&&qualifiedRoleEvidence(peer.qualification,network,address,peer.address,iso(now)));
      if(!peers.length)return;
    }
    const lastEvidenceAt=profileEvidence(profile,route,peers,now),qualificationAt=route==='B'?
      later(qualified,...peers.map(peer=>evidenceTime(peer.qualification?.knownAt,now)))??qualified:qualified;
    return {chain:network,address,route,qualifiedAt:qualificationAt,profileComputedAt:computed,...(lastEvidenceAt?{lastEvidenceAt}:{}),
      base:{version:1,reasons:route==='A'?['PROFILE_MARKET_PRE_CANDIDATE','INITIATOR_ANALYSIS_CURRENT','PROSPECTIVE_PRE_SHARE_10PCT']:
        ['PROFILE_PRECURSOR_PATTERN','PEER_FORWARD_OBSERVED','QUALIFICATION_WITHIN_30D','QUALIFIED_ROLE_EVIDENCE_VALID'],sampleOnly:true,tradingEnabled:false}};
  }

  refresh():LauncherCandidateStatus {
    const now=this.currentTime(),at=iso(now);let sourceOpen=false;
    try {
      this.profiles.exec('BEGIN');sourceOpen=true;
      const selected=new Map<string,CandidateSeed>();
      for(const route of ['A','B'] as const)for(const row of this.sourceRows(route)){
        const value=this.seed(row,route,now);if(!value)continue;
        const key=value.chain+':'+value.address;if(!selected.has(key))selected.set(key,value);
      }
      const seeds=[...selected.values()].sort((a,b)=>(a.route==='A'?0:1)-(b.route==='A'?0:1)||
        (b.lastEvidenceAt??'').localeCompare(a.lastEvidenceAt??'')||a.chain.localeCompare(b.chain)||a.address.localeCompare(b.address)).slice(0,this.cap);
      this.profiles.exec('ROLLBACK');sourceOpen=false;
      const payloadBytes=seeds.reduce((sum,value)=>sum+JSON.stringify(value.base).length*3+RECORD_RESERVE_BYTES,REFRESH_RESERVE_BYTES);
      if(this.bytes()+payloadBytes>this.maxBytes){this.markCapacity();return this.status();}
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const insert=this.statement(`INSERT INTO lc_candidates(chain,address,route,qualified_at,profile_computed_at,last_evidence_at,
          verified_at,activity_at,live_seen_at,live_source,monitored,coverage_at,revalidation_checked_at,latest_signature,block_time,slot,
          revalidation_state,revalidation_classification,revalidation_error,updated_at,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(chain,address) DO UPDATE SET route=excluded.route,qualified_at=excluded.qualified_at,
            profile_computed_at=excluded.profile_computed_at,last_evidence_at=excluded.last_evidence_at,
            updated_at=excluded.updated_at,data=excluded.data`);
        for(const value of seeds){
          insert.run(value.chain,value.address,value.route,value.qualifiedAt,value.profileComputedAt,value.lastEvidenceAt??null,
            null,null,null,null,0,null,null,null,null,null,null,null,null,at,JSON.stringify(value.base));}
        const selectedKeys=new Set(seeds.map(value=>value.chain+':'+value.address)),remove=this.statement('DELETE FROM lc_candidates WHERE chain=? AND address=?');
        for(const row of this.statement('SELECT chain,address FROM lc_candidates').all() as Row[])
          if(!selectedKeys.has(String(row.chain)+':'+String(row.address)))remove.run(sqlValue(row.chain),sqlValue(row.address));
        this.setMeta('last_refresh_at',at);this.setMeta('error','');this.db.exec('COMMIT');this.capacity=false;
      }catch(error){this.db.exec('ROLLBACK');if(sqliteCapacity(error)){this.markCapacity();return this.status();}throw error;}
      return this.status();
    }finally{if(sourceOpen)try{this.profiles.exec('ROLLBACK');}catch{/* read transaction cleanup */}}
  }

  private dimensions(row:Row,now:number):LauncherCandidate['dimensions'] {
    const coverage=time(row.coverage_at),live=time(row.live_seen_at),verified=time(row.last_verified_buy_at),
      evidence=time(later(row.last_evidence_at as string|undefined,row.last_verified_buy_at as string|undefined));
    const monitored=Number(row.monitored)===1&&coverage!==undefined&&coverage<=now&&now-coverage<=this.coverageMs,
      liveSeen=live!==undefined&&live<=now&&now-live<=this.liveMs,
      verifiedTradeFresh=verified!==undefined&&verified<=now&&now-verified<=this.freshMs,
      evidenceFresh=evidence!==undefined&&evidence<=now&&now-evidence<=this.freshMs;
    return {evidenceFresh,verifiedTradeFresh,liveSeen,monitored,realtimeReady:monitored&&(liveSeen||evidenceFresh),
      verifiedTradeMonitored:monitored&&verifiedTradeFresh};
  }

  private state(row:Row,now:number):LauncherCandidateState {
    const dimensions=this.dimensions(row,now);
    if(dimensions.monitored)return 'monitored';
    if(dimensions.liveSeen)return 'live_seen';
    if(dimensions.evidenceFresh)return 'fresh_verified';
    return 'historical_seed';
  }

  private candidate(row:Row,now=this.currentTime()):LauncherCandidate {
    const network=row.chain as Chain,base=parseBase(row.data),revalidationChecked=typeof row.revalidation_checked_at==='string'?row.revalidation_checked_at:undefined;
    const revalidation:LauncherRevalidationEvidence|undefined=revalidationChecked?{checkedAt:revalidationChecked,
      ...(typeof row.latest_signature==='string'?{latestSignature:row.latest_signature}:{}),
      ...(natural(row.block_time)?{blockTime:row.block_time,eventAt:iso(row.block_time*1000)}:{}),...(natural(row.slot)?{slot:row.slot}:{}),
      ...(['baseline','unchanged','changed','empty','error'].includes(String(row.revalidation_state))?{state:row.revalidation_state as LauncherRealtimeObservation['state']}:{}),
      ...(typeof row.revalidation_classification==='string'?{classification:row.revalidation_classification as ActivityKind}:{}),
      ...(typeof row.revalidation_error==='string'?{error:row.revalidation_error}:{})}:undefined;
    const dimensions=this.dimensions(row,now);
    return {...base,chain:network,address:String(row.address),route:row.route as LauncherCandidateProfileRoute,state:this.state(row,now),
      qualifiedAt:String(row.qualified_at),profileComputedAt:String(row.profile_computed_at),
      ...(typeof row.last_evidence_at==='string'?{lastEvidenceAt:row.last_evidence_at}:{}),
      ...(typeof row.verified_at==='string'?{verifiedAt:row.verified_at}:{}),
      ...(typeof row.activity_at==='string'?{verifiedActivityAt:row.activity_at}:{}),
      ...(typeof row.last_verified_buy_at==='string'?{lastVerifiedBuyAt:row.last_verified_buy_at}:{}),
      ...(typeof row.last_verified_buy_tx==='string'?{lastVerifiedBuyTx:row.last_verified_buy_tx}:{}),
      ...(typeof row.last_verified_buy_token==='string'?{lastVerifiedBuyToken:row.last_verified_buy_token}:{}),
      ...(typeof row.last_verified_sell_at==='string'?{lastVerifiedSellAt:row.last_verified_sell_at}:{}),
      ...(typeof row.last_verified_sell_tx==='string'?{lastVerifiedSellTx:row.last_verified_sell_tx}:{}),
      ...(typeof row.last_verified_sell_token==='string'?{lastVerifiedSellToken:row.last_verified_sell_token}:{}),
      ...(typeof row.live_seen_at==='string'?{liveSeenAt:row.live_seen_at}:{}),monitored:dimensions.monitored,dimensions,
      ...(typeof row.coverage_at==='string'?{coverageAt:row.coverage_at}:{}),...(revalidation?{revalidation}:{})};
  }

  observeRealtime(input:LauncherRealtimeObservation):boolean {
    const now=this.currentTime(),network=chain(input?.chain),wallet=network&&chainAddress(network,input.wallet);
    const checked=time(input?.checkedAt),observed=time(input?.observedAt),at=checked??observed;
    if(!network||!wallet||at===undefined||at>now||checked!==undefined&&observed!==undefined&&observed>checked||
      input.source!==undefined&&!source(input.source)||input.latestSignature!==undefined&&!transaction(network,input.latestSignature)||
      input.blockTime!==undefined&&(!natural(input.blockTime)||input.blockTime*1000>at)||input.slot!==undefined&&!natural(input.slot)||
      input.state!==undefined&&!['baseline','unchanged','changed','empty','error'].includes(input.state)||
      input.newSignature!==undefined&&typeof input.newSignature!=='boolean'||input.error!==undefined&&
        (typeof input.error!=='string'||!/^[A-Z][A-Z0-9_]{1,79}$/.test(input.error)))return false;
    const row=this.statement('SELECT * FROM lc_candidates WHERE chain=? AND address=?').get(network,wallet) as Row|undefined;if(!row)return false;
    const isRevalidation=checked!==undefined||input.state!==undefined||input.newSignature!==undefined;
    const live=!isRevalidation||input.newSignature===true||input.state==='changed'||input.state==='baseline'&&input.blockTime!==undefined,
      liveEvidence=input.blockTime===undefined?at:input.blockTime*1000;
    const oldLive=time(row.live_seen_at),liveAt=live&&(oldLive===undefined||liveEvidence>oldLive)?iso(liveEvidence):row.live_seen_at??null;
    const oldChecked=time(row.revalidation_checked_at),replace=isRevalidation&&(oldChecked===undefined||at>=oldChecked);
    try {this.statement(`UPDATE lc_candidates SET live_seen_at=?,live_source=?,revalidation_checked_at=?,latest_signature=?,block_time=?,slot=?,
      revalidation_state=?,revalidation_classification=?,revalidation_error=?,updated_at=? WHERE chain=? AND address=?`).run(
        sqlValue(liveAt),live?(input.source??(isRevalidation?'launcher_revalidator':'realtime')):sqlValue(row.live_source),
        replace?iso(at):sqlValue(row.revalidation_checked_at),replace?(input.latestSignature??sqlValue(row.latest_signature)):sqlValue(row.latest_signature),
        replace?(input.blockTime??sqlValue(row.block_time)):sqlValue(row.block_time),
        replace?(input.slot??sqlValue(row.slot)):sqlValue(row.slot),
        replace?(input.state??null):sqlValue(row.revalidation_state),replace?(input.classification??null):sqlValue(row.revalidation_classification),
        replace?(input.error??null):sqlValue(row.revalidation_error),
        iso(now),network,wallet);return true;
    }catch(error){if(sqliteCapacity(error)){this.markCapacity();return false;}throw error;}
  }

  /**
   * Persist high-volume stream liveness in one transaction. This deliberately
   * accepts only direct observations; revalidation evidence still goes through
   * observeRealtime so its signature and classification fields remain atomic.
   */
  observeRealtimeBatchResult(inputs:readonly LauncherRealtimeObservation[]):LauncherRealtimeBatchResult {
    if(!Array.isArray(inputs)||inputs.length>1000)throw new Error('LAUNCHER_REALTIME_BATCH_INVALID');
    const now=this.currentTime(),latest=new Map<string,{chain:Chain;wallet:string;at:number;source:string}>();
    for(const input of inputs){
      const network=chain(input?.chain),wallet=network&&chainAddress(network,input.wallet),at=time(input?.observedAt),
        origin=input?.source??'realtime';
      if(!network||!wallet||at===undefined||at>now||!source(origin)||input.checkedAt!==undefined||
        input.latestSignature!==undefined||input.blockTime!==undefined||input.slot!==undefined||input.state!==undefined||
        input.newSignature!==undefined||input.classification!==undefined||input.error!==undefined)
        throw new Error('LAUNCHER_REALTIME_BATCH_INVALID');
      const key=`${network}:${wallet}`,prior=latest.get(key);
      if(!prior||at>prior.at)latest.set(key,{chain:network,wallet,at,source:origin});
    }
    if(!latest.size)return {changed:0,capacityReached:false};
    const updatedAt=iso(now),update=this.statement(`UPDATE lc_candidates
      SET live_seen_at=?,live_source=?,updated_at=?
      WHERE chain=? AND address=? AND (live_seen_at IS NULL OR live_seen_at<?)`);
    let changed=0;this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const row of latest.values()){
        const observedAt=iso(row.at);changed+=Number(update.run(observedAt,row.source,updatedAt,row.chain,row.wallet,observedAt).changes);
      }
      this.db.exec('COMMIT');return {changed,capacityReached:false};
    }catch(error){
      this.db.exec('ROLLBACK');if(sqliteCapacity(error)){this.markCapacity();return {changed:0,capacityReached:true};}throw error;
    }
  }

  observeRealtimeBatch(inputs:readonly LauncherRealtimeObservation[]):number {
    return this.observeRealtimeBatchResult(inputs).changed;
  }

  observeActivity(input:LauncherActivityObservation):boolean {
    const now=this.currentTime(),network=chain(input?.chain),wallet=network&&chainAddress(network,input.wallet),hash=network&&transaction(network,input.txHash),
      checked=time(input?.checkedAt),event=time(input?.eventAt);
    if(!network||!wallet||checked===undefined||event===undefined||event>checked||checked>now||!['confirmed','included'].includes(input.confirmation)||
      !['buy','sell'].includes(input.classification)||!hash)return false;
    if(input.tokenAddress!==undefined&&!chainAddress(network,input.tokenAddress)||input.trades!==undefined&&
      (!Array.isArray(input.trades)||input.trades.length>32||input.trades.some(trade=>!trade||!['buy','sell'].includes(trade.side)||!chainAddress(network,trade.tokenAddress))))return false;
    const tokens=[...new Set([...(input.tokenAddress?[chainAddress(network,input.tokenAddress)!]:[]),
      ...(input.trades??[]).filter(trade=>trade.side===input.classification).map(trade=>chainAddress(network,trade.tokenAddress)!)] )];
    const token=tokens.length===1?tokens[0]:undefined;
    const row=this.statement(`SELECT verified_at,activity_at,last_verified_buy_at,last_verified_buy_tx,last_verified_buy_token,
      last_verified_sell_at,last_verified_sell_tx,last_verified_sell_token FROM lc_candidates WHERE chain=? AND address=?`).get(network,wallet) as Row|undefined;if(!row)return false;
    const oldActivity=time(row.activity_at),oldVerified=time(row.verified_at);
    const activityAt=oldActivity===undefined||event>oldActivity?iso(event):row.activity_at;
    const verifiedAt=oldVerified===undefined||checked>oldVerified?iso(checked):row.verified_at;
    const side=input.classification,sideAtKey=side==='buy'?'last_verified_buy_at':'last_verified_sell_at',oldSide=time(row[sideAtKey]),replace=oldSide===undefined||event>oldSide;
    const buy=side==='buy'&&replace,sell=side==='sell'&&replace;
    try {this.statement(`UPDATE lc_candidates SET verified_at=?,activity_at=?,
      last_verified_buy_at=?,last_verified_buy_tx=?,last_verified_buy_token=?,
      last_verified_sell_at=?,last_verified_sell_tx=?,last_verified_sell_token=?,updated_at=? WHERE chain=? AND address=?`).run(
        sqlValue(verifiedAt),sqlValue(activityAt),buy?iso(event):sqlValue(row.last_verified_buy_at),
        buy?hash:sqlValue(row.last_verified_buy_tx),buy?(token??null):sqlValue(row.last_verified_buy_token),
        sell?iso(event):sqlValue(row.last_verified_sell_at),sell?hash:sqlValue(row.last_verified_sell_tx),
        sell?(token??null):sqlValue(row.last_verified_sell_token),iso(now),network,wallet);return true;
    }catch(error){if(sqliteCapacity(error)){this.markCapacity();return false;}throw error;}
  }

  /** Clear only the latest side whose exact transaction was retracted. No
   * older activity is fabricated because this compact store does not retain a
   * transaction ledger. */
  retractActivity(input:LauncherActivityRetraction):boolean {
    const now=this.currentTime(),network=chain(input?.chain),wallet=network&&chainAddress(network,input.wallet),
      hash=network&&transaction(network,input.txHash),checked=time(input?.checkedAt);
    if(!network||!wallet||!hash||checked===undefined||checked>now)return false;
    const row=this.statement(`SELECT verified_at,activity_at,last_verified_buy_at,last_verified_buy_tx,last_verified_buy_token,
      last_verified_sell_at,last_verified_sell_tx,last_verified_sell_token FROM lc_candidates
      WHERE chain=? AND address=?`).get(network,wallet) as Row|undefined;
    if(!row)return false;
    const buy=row.last_verified_buy_tx===hash,sell=row.last_verified_sell_tx===hash;if(!buy&&!sell)return false;
    const buyAt=buy?undefined:typeof row.last_verified_buy_at==='string'?row.last_verified_buy_at:undefined,
      sellAt=sell?undefined:typeof row.last_verified_sell_at==='string'?row.last_verified_sell_at:undefined,
      activityAt=later(buyAt,sellAt)??null;
    try {this.statement(`UPDATE lc_candidates SET verified_at=NULL,activity_at=?,
      last_verified_buy_at=?,last_verified_buy_tx=?,last_verified_buy_token=?,
      last_verified_sell_at=?,last_verified_sell_tx=?,last_verified_sell_token=?,updated_at=?
      WHERE chain=? AND address=?`).run(activityAt,buyAt??null,buy?null:sqlValue(row.last_verified_buy_tx),buy?null:sqlValue(row.last_verified_buy_token),
        sellAt??null,sell?null:sqlValue(row.last_verified_sell_tx),sell?null:sqlValue(row.last_verified_sell_token),iso(now),network,wallet);
      return true;
    }catch(error){if(sqliteCapacity(error)){this.markCapacity();return false;}throw error;}
  }

  replaceCoverageBatchResult(updates:readonly LauncherCoverageUpdate[]):LauncherCoverageBatchResult {
    const now=this.currentTime();
    if(!Array.isArray(updates)||updates.length>CHAINS.length)throw new Error('LAUNCHER_COVERAGE_INVALID');
    const seen=new Set<Chain>(),prepared:{chain:Chain;at:string;wallets:string}[]=[];
    for(const update of updates){
      const validChain=chain(update?.chain),checked=time(update?.at),wallets=update?.wallets;
      if(!validChain||seen.has(validChain)||checked===undefined||checked>now||!Array.isArray(wallets)||wallets.length>this.cap)
        throw new Error('LAUNCHER_COVERAGE_INVALID');
      const selected=[...new Set(wallets.map(wallet=>chainAddress(validChain,wallet)))];
      if(selected.some(wallet=>!wallet))throw new Error('LAUNCHER_COVERAGE_INVALID');
      seen.add(validChain);prepared.push({chain:validChain,at:iso(checked),wallets:JSON.stringify(selected)});
    }
    const counts:Partial<Record<Chain,number>>={};if(!prepared.length)return {counts,capacityReached:false};
    const updatedAt=iso(now),clear=this.statement(`UPDATE lc_candidates SET monitored=0,coverage_at=NULL,updated_at=?
      WHERE chain=? AND monitored=1 AND NOT EXISTS(
        SELECT 1 FROM json_each(?) AS selected WHERE selected.type='text' AND selected.value=lc_candidates.address)`),
      update=this.statement(`UPDATE lc_candidates SET monitored=1,coverage_at=?,updated_at=?
        WHERE chain=? AND address IN (SELECT value FROM json_each(?) WHERE type='text')`);
    this.db.exec('BEGIN IMMEDIATE');try {
      for(const value of prepared){
        clear.run(updatedAt,value.chain,value.wallets);
        counts[value.chain]=Number(update.run(value.at,updatedAt,value.chain,value.wallets).changes);
      }
      this.db.exec('COMMIT');return {counts,capacityReached:false};
    }catch(error){this.db.exec('ROLLBACK');if(sqliteCapacity(error)){
      this.markCapacity();for(const value of prepared)counts[value.chain]=0;return {counts,capacityReached:true};
    }throw error;}
  }

  replaceCoverageBatch(updates:readonly LauncherCoverageUpdate[]):Partial<Record<Chain,number>> {
    return this.replaceCoverageBatchResult(updates).counts;
  }

  replaceCoverage(network:Chain,wallets:readonly string[],at:string):number {
    const counts=this.replaceCoverageBatch([{chain:network,wallets,at}]);return counts[network]??0;
  }

  get(network:Chain,address:string):LauncherCandidate|undefined {
    const validChain=chain(network),wallet=validChain&&chainAddress(validChain,address);if(!validChain||!wallet)return;
    const row=this.statement('SELECT * FROM lc_candidates WHERE chain=? AND address=?').get(validChain,wallet) as Row|undefined;
    return row?this.candidate(row):undefined;
  }

  /** Compact membership snapshot for live target labelling; avoids one SQLite lookup per watched wallet. */
  addresses(network:Chain):string[] {
    if(!chain(network))throw new Error('LAUNCHER_CANDIDATE_QUERY_INVALID');
    return (this.statement('SELECT address FROM lc_candidates WHERE chain=? ORDER BY address').all(network) as Row[]).map(row=>String(row.address));
  }

  list(options:LauncherCandidateListOptions={}):LauncherCandidateList {
    const limit=boundedInteger(options.limit,100,1,5000),offset=boundedInteger(options.offset,0,0,5000);
    if(options.chain!==undefined&&!chain(options.chain)||options.route!==undefined&&!['A','B'].includes(options.route)||
      options.state!==undefined&&!['historical_seed','fresh_verified','live_seen','monitored'].includes(options.state))throw new Error('LAUNCHER_CANDIDATE_QUERY_INVALID');
    const stateRank:Record<LauncherCandidateState,number>={monitored:0,live_seen:1,fresh_verified:2,historical_seed:3};
    let items=(this.statement('SELECT * FROM lc_candidates').all() as Row[]).map(row=>this.candidate(row));
    if(options.chain)items=items.filter(item=>item.chain===options.chain);
    if(options.route)items=items.filter(item=>item.route===options.route);
    if(options.state)items=items.filter(item=>item.state===options.state);
    items.sort((a,b)=>stateRank[a.state]-stateRank[b.state]||(a.route==='A'?0:1)-(b.route==='A'?0:1)||
      (b.lastVerifiedBuyAt??b.liveSeenAt??b.lastEvidenceAt??'').localeCompare(a.lastVerifiedBuyAt??a.liveSeenAt??a.lastEvidenceAt??'')||
      a.chain.localeCompare(b.chain)||a.address.localeCompare(b.address));
    return {items:items.slice(offset,offset+limit),total:items.length,limit,offset};
  }

  streamTargets(network:Chain,limit=this.cap):string[]{
    if(!chain(network))throw new Error('LAUNCHER_CANDIDATE_QUERY_INVALID');
    const size=boundedInteger(limit,this.cap,1,5000),now=this.currentTime(),rows=(this.statement('SELECT * FROM lc_candidates WHERE chain=?').all(network) as Row[]);
    const freshness=(row:Row):{rank:number;at:string}=>{
      const live=time(row.live_seen_at),fresh=later(row.last_evidence_at as string|undefined,row.last_verified_buy_at as string|undefined),freshAt=time(fresh);
      if(live!==undefined&&live<=now&&now-live<=this.liveMs)return {rank:0,at:iso(live)};
      if(freshAt!==undefined&&freshAt<=now&&now-freshAt<=this.freshMs)return {rank:1,at:iso(freshAt)};
      return {rank:2,at:''};
    };
    const ordered=(a:Row,b:Row)=>{const left=freshness(a),right=freshness(b);return left.rank-right.rank||right.at.localeCompare(left.at)||
      (a.route==='A'?0:1)-(b.route==='A'?0:1)||String(a.address).localeCompare(String(b.address));};
    const orderedRows=rows.sort(ordered),strict=rows.filter(row=>{
      const activity=time(row.last_verified_buy_at);return activity!==undefined&&activity<=now&&now-activity<=this.freshMs;
    }).sort((a,b)=>String(b.last_verified_buy_at).localeCompare(String(a.last_verified_buy_at))||ordered(a,b));
    // A small directly-classified BUY core stays hot. Every other candidate,
    // including generic-live overflow, advances through five-minute pages.
    // RPC polling already explores the whole Solana shortlist. Keep most live
    // socket slots on recently verified buys while retaining a 20% discovery lane.
    const reserved=Math.min(strict.length,Math.max(1,Math.floor(size*0.8))),selected=strict.slice(0,reserved),selectedKeys=new Set(selected.map(row=>String(row.address))),
      rotating=orderedRows.filter(row=>!selectedKeys.has(String(row.address))),remaining=size-selected.length;
    if(remaining>0&&rotating.length){
      const rotationStarted=time(this.meta('rotation_started_at'))??now,page=Math.max(0,Math.floor((now-rotationStarted)/(5*60_000))),
        start=page*remaining%rotating.length;
      for(let index=0;index<Math.min(remaining,rotating.length);index++)selected.push(rotating[(start+index)%rotating.length]);
    }
    return selected.map(row=>String(row.address));
  }

  /** Adapter shape consumed by LauncherRevalidator.listCandidates. */
  listRevalidation(network:Chain,limit=this.cap):{wallet:string;latestSignature?:string}[]{
    if(!chain(network))throw new Error('LAUNCHER_CANDIDATE_QUERY_INVALID');
    const size=boundedInteger(limit,this.cap,1,5000),wallets=this.streamTargets(network,size),signatures=new Map(
      (this.statement('SELECT address,latest_signature FROM lc_candidates WHERE chain=?').all(network) as Row[])
        .map(row=>[String(row.address),typeof row.latest_signature==='string'?row.latest_signature:undefined]));
    return wallets.map(wallet=>{const latestSignature=signatures.get(wallet);return {wallet,...(latestSignature?{latestSignature}:{})};});
  }

  /** A signature change is liveness evidence only. Classification is promoted solely by observeActivity. */
  recordRevalidation(input:LauncherRevalidationObservation):boolean|'stale' {
    if(this.observeRealtime({...input,source:'launcher_revalidator'}))return true;
    const network=chain(input?.chain),wallet=network&&chainAddress(network,input.wallet);
    return network&&wallet&&!this.statement('SELECT 1 FROM lc_candidates WHERE chain=? AND address=?').get(network,wallet)?'stale':false;
  }

  status():LauncherCandidateStatus {
    const rows=this.statement('SELECT * FROM lc_candidates').all() as Row[],now=this.currentTime();
    const chainCounts:Record<Chain,number>={bsc:0,solana:0,robinhood:0};
    const routeCounts:Record<LauncherCandidateProfileRoute,number>={A:0,B:0};
    const stateCounts:Record<LauncherCandidateState,number>={historical_seed:0,fresh_verified:0,live_seen:0,monitored:0};
    const dimensionCounts={evidenceFresh:0,verifiedTradeFresh:0,liveSeen:0,monitored:0,realtimeReady:0,verifiedTradeMonitored:0};
    for(const row of rows){chainCounts[row.chain as Chain]++;routeCounts[row.route as LauncherCandidateProfileRoute]++;stateCounts[this.state(row,now)]++;
      const dimensions=this.dimensions(row,now);for(const key of Object.keys(dimensionCounts) as (keyof typeof dimensionCounts)[])
        if(dimensions[key])dimensionCounts[key]++;}
    const error=this.capacity?CAPACITY:this.meta('error')||undefined,lastRefreshAt=this.meta('last_refresh_at')||undefined;
    return {ready:!!lastRefreshAt,records:rows.length,cap:this.cap,bytes:this.bytes(),maxBytes:this.maxBytes,
      capacityReached:error===CAPACITY,chainCounts,routeCounts,stateCounts,dimensionCounts,...(lastRefreshAt?{lastRefreshAt}:{}),
      ...(error?{error}:{}),sampleOnly:true,tradingEnabled:false};
  }

  close():void {if(this.closed)return;this.closed=true;this.profiles.close();this.db.close();}
}
