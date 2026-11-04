import {createHash} from 'node:crypto';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {gmgnKlineMomentum,normalizeGmgnKline,type GmgnKlineMomentum,type GmgnKlineWindow} from './gmgn-kline.js';

type Obj=Record<string,unknown>;
const isObject=(value:unknown):value is Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export type GmgnDiscoveryFeed='trending'|'trenches';
export type GmgnTrenchCategory='new_creation'|'near_completion'|'completed';
export type GmgnDiscoveryChangeKind='first_seen'|'updated'|'category_transition';
export type GmgnDiscoveryInterval='1m'|'5m'|'1h'|'6h'|'24h';

export interface GmgnMarketDiscoveryRecord {
  chain:'sol';address:string;feed:GmgnDiscoveryFeed;window:string;category:'trending'|GmgnTrenchCategory;
  name?:string;symbol?:string;launchpadPlatform?:string;exchange?:string;quoteAddress?:string;quoteAddressType?:string;
  createdTimestamp?:number;openTimestamp?:number;completeTimestamp?:number;
  price?:number;marketCap?:number;liquidity?:number;volume?:number;volume1h?:number;volume24h?:number;
  swaps?:number;swaps1m?:number;swaps1h?:number;swaps24h?:number;buys?:number;sells?:number;buys24h?:number;sells24h?:number;
  holderCount?:number;rank?:number;hotLevel?:number;visitingCount?:number;progress?:number;priceChangePercent?:number;
  priceChangePercent1m?:number;priceChangePercent5m?:number;priceChangePercent1h?:number;
  smartDegenCount?:number;renownedCount?:number;botDegenCount?:number;sniperCount?:number;
  top10HolderRate?:number;rugRatio?:number;ratTraderRate?:number;bundlerRate?:number;entrapmentRatio?:number;
  suspectedInsiderHoldRate?:number;devTeamHoldRate?:number;botDegenRate?:number;freshWalletRate?:number;
  privateVaultHoldRate?:number;buyTax?:number;sellTax?:number;
  renouncedMint?:boolean;renouncedFreeze?:boolean;washTrading?:boolean;honeypot?:boolean;openSource?:boolean;ownerRenounced?:boolean;
  creatorTokenStatus?:string;hasSocial?:boolean;cto?:boolean;dexscreenerAd?:boolean;dexscreenerTrending?:boolean;dexscreenerBoostFee?:number;
}

export interface GmgnDiscoveryNormalizedPage {
  feed:GmgnDiscoveryFeed;received:number;accepted:number;deduplicated:number;rejected:number;truncated:number;records:GmgnMarketDiscoveryRecord[];
}

export interface GmgnMarketDiscoveryCandidate {
  id:string;source:'gmgn_market_discovery';chain:'solana';tokenAddress:string;observedAt:string;
  feed:GmgnDiscoveryFeed;window:string;kind:GmgnDiscoveryChangeKind;category:GmgnMarketDiscoveryRecord['category'];
  previousCategory?:GmgnMarketDiscoveryRecord['category'];changedFields:string[];snapshot:GmgnMarketDiscoveryRecord;
  smartDegenDelta:number;renownedDelta:number;walletTrackingRecommended:boolean;sourceObservationRecommended:true;
  researchOnly:true;entryPipeline:false;countingPipeline:false;notificationPipeline:false;
}

/** A scanner callback adds the local polling boundary around this observation.
 * It describes only entry into this process's selected GMGN feed page, never
 * token creation, launch time, or first appearance at GMGN globally. */
export interface GmgnMarketDiscoveryObservedCandidate extends GmgnMarketDiscoveryCandidate {
  previousSuccessfulPollAt?:string;
  /** True on the first successful poll and on a recovery poll after a failed attempt. */
  leftCensored:boolean;
}

export interface GmgnMarketDiscoveryStoreOptions {
  path:string;maxBytes:number;retentionMs?:number;maxObservations?:number;now?:()=>Date;
}

export interface GmgnDiscoveryStoreWrite {
  received:number;inserted:number;unchanged:number;capacityReached:boolean;events:GmgnMarketDiscoveryCandidate[];
  continuityLostFeeds:GmgnDiscoveryFeed[];
}

interface GmgnCandidateDeliveryContext {
  previousSuccessfulPollAt?:string;leftCensored:boolean;
}

export interface GmgnMarketKlineObservation {
  chain:'solana';tokenAddress:string;nominatedAt:string;observedAt:string;reason:string;resolution:'30s';
  fromAt:string;untilAt:string;coverage:GmgnKlineWindow['coverage'];diagnostics:GmgnKlineWindow['diagnostics'];
  momentum?:GmgnKlineMomentum;
  researchOnly:true;priceRouter:false;entryPipeline:false;countingPipeline:false;
}

export type GmgnKlineStoreResult='inserted'|'duplicate';

export interface GmgnDiscoveryScheduling {
  priority:'background';queueTimeoutMs:number;
}

export interface GmgnMarketDiscoveryClient {
  readonly cooldownUntil?:number;
  getMarketTrending(chain:'sol',options:{interval:GmgnDiscoveryInterval;limit:number},scheduling:GmgnDiscoveryScheduling):Promise<unknown>;
  getMarketTrenches(chain:'sol',options:{categories:GmgnTrenchCategory[];limit:number},scheduling:GmgnDiscoveryScheduling):Promise<unknown>;
  getMarketKline?(chain:'sol',address:string,options:{resolution:'30s';from:number;to:number},scheduling:GmgnDiscoveryScheduling):Promise<unknown>;
}

export interface GmgnMarketDiscoveryScannerOptions {
  client:GmgnMarketDiscoveryClient;store:GmgnMarketDiscoveryStore;intervalMs:number;maxCandidates:number;
  klineCooldownMs?:number;trendingInterval?:GmgnDiscoveryInterval;queueTimeoutMs?:number;now?:()=>Date;
  onCandidate?:(candidate:GmgnMarketDiscoveryObservedCandidate)=>unknown|Promise<unknown>;
  onKline?:(observation:GmgnMarketKlineObservation)=>unknown|Promise<unknown>;
}

const MAX_TRENDING_ROWS=100,MAX_TRENCH_ROWS_PER_CATEGORY=80,MAX_DISCOVERY_ROWS=240;
const MIN_TIMESTAMP=1_262_304_000,MAX_TIMESTAMP=4_102_444_800;
const RECORD_KEYS:readonly (keyof GmgnMarketDiscoveryRecord)[]=[
  'chain','address','feed','window','category','name','symbol','launchpadPlatform','exchange','quoteAddress','quoteAddressType',
  'createdTimestamp','openTimestamp','completeTimestamp','price','marketCap','liquidity','volume','volume1h','volume24h',
  'swaps','swaps1m','swaps1h','swaps24h','buys','sells','buys24h','sells24h','holderCount','rank','hotLevel','visitingCount','progress',
  'priceChangePercent','priceChangePercent1m','priceChangePercent5m','priceChangePercent1h','smartDegenCount','renownedCount',
  'botDegenCount','sniperCount','top10HolderRate','rugRatio','ratTraderRate','bundlerRate','entrapmentRatio','suspectedInsiderHoldRate',
  'devTeamHoldRate','botDegenRate','freshWalletRate','privateVaultHoldRate','buyTax','sellTax','renouncedMint','renouncedFreeze',
  'washTrading','honeypot','openSource','ownerRenounced','creatorTokenStatus','hasSocial','cto','dexscreenerAd','dexscreenerTrending',
  'dexscreenerBoostFee',
];
const WALLET_FIELDS=new Set<keyof GmgnMarketDiscoveryRecord>(['smartDegenCount','renownedCount']);
const RISK_FIELDS=new Set<keyof GmgnMarketDiscoveryRecord>([
  'quoteAddress','quoteAddressType','top10HolderRate','rugRatio','ratTraderRate','bundlerRate','entrapmentRatio','suspectedInsiderHoldRate',
  'devTeamHoldRate','botDegenRate','freshWalletRate','privateVaultHoldRate','buyTax','sellTax','renouncedMint','renouncedFreeze',
  'washTrading','honeypot','openSource','ownerRenounced','creatorTokenStatus',
]);

function cleanText(value:unknown,max:number):string|undefined {
  if(typeof value!=='string')return;
  const cleaned=value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  return cleaned?cleaned.slice(0,max):undefined;
}

function numberIn(value:unknown,min:number,max:number,integer=false):number|undefined {
  const parsed=typeof value==='number'?value:typeof value==='string'&&value.trim()!==''?Number(value):NaN;
  if(!Number.isFinite(parsed)||parsed<min||parsed>max)return;
  return integer?Math.floor(parsed):parsed;
}

function bool(value:unknown):boolean|undefined {
  if(value===true||value===1||value==='1'||value==='yes')return true;
  if(value===false||value===0||value==='0'||value==='no')return false;
}

function solAddress(value:unknown):value is string {
  if(typeof value!=='string'||value.length<32||value.length>44)return false;
  try{const decoded=bs58.decode(value);return decoded.length===32&&decoded.some(byte=>byte!==0)&&bs58.encode(decoded)===value;}catch{return false;}
}

function timestamp(value:unknown):number|undefined {
  const parsed=numberIn(value,MIN_TIMESTAMP,MAX_TIMESTAMP,true);return parsed;
}

function ratio(value:unknown):number|undefined {return numberIn(value,0,1);}
function count(value:unknown):number|undefined {return numberIn(value,0,1_000_000_000,true);}
function usd(value:unknown):number|undefined {return numberIn(value,0,1_000_000_000_000_000);}
function percent(value:unknown):number|undefined {return numberIn(value,-1_000_000,1_000_000);}

function firstDefined<T>(...values:(T|undefined)[]):T|undefined {return values.find(value=>value!==undefined);}

function normalizeRow(raw:unknown,feed:GmgnDiscoveryFeed,window:string,category:GmgnMarketDiscoveryRecord['category']):GmgnMarketDiscoveryRecord|undefined {
  if(!isObject(raw)||raw.chain!=='sol'||!solAddress(raw.address))return;
  const quoteValue=raw.quote_address??raw.launch_quote_address;
  if(quoteValue!==undefined&&quoteValue!==null&&quoteValue!==''&&!solAddress(quoteValue))return;
  const quoteAddress=solAddress(quoteValue)?quoteValue:undefined;
  const quoteAddressType=cleanText(raw.quote_address_type??raw.launch_quote_address_type,40)??
    (typeof (raw.quote_address_type??raw.launch_quote_address_type)==='number'?String(raw.quote_address_type??raw.launch_quote_address_type):undefined);
  const social=[raw.twitter,raw.twitter_username,raw.telegram,raw.website,raw.instagram,raw.tiktok].some(value=>cleanText(value,8)!==undefined);
  const record:GmgnMarketDiscoveryRecord={chain:'sol',address:raw.address,feed,window,category,
    name:cleanText(raw.name,160),symbol:cleanText(raw.symbol,64),launchpadPlatform:cleanText(raw.launchpad_platform,80),
    exchange:cleanText(raw.exchange,80),quoteAddress,quoteAddressType,
    createdTimestamp:firstDefined(timestamp(raw.created_timestamp),timestamp(raw.creation_timestamp)),openTimestamp:timestamp(raw.open_timestamp),
    completeTimestamp:timestamp(raw.complete_timestamp),price:usd(raw.price),
    marketCap:firstDefined(usd(raw.market_cap),usd(raw.usd_market_cap)),liquidity:usd(raw.liquidity),volume:usd(raw.volume),
    volume1h:usd(raw.volume_1h),volume24h:usd(raw.volume_24h),swaps:count(raw.swaps),swaps1m:count(raw.swaps_1m),
    swaps1h:count(raw.swaps_1h),swaps24h:count(raw.swaps_24h),buys:count(raw.buys),sells:count(raw.sells),
    buys24h:count(raw.buys_24h),sells24h:count(raw.sells_24h),holderCount:count(raw.holder_count),rank:count(raw.rank),
    hotLevel:numberIn(raw.hot_level,0,1_000_000,true),visitingCount:count(raw.visiting_count),progress:ratio(raw.progress),
    priceChangePercent:percent(raw.price_change_percent),priceChangePercent1m:percent(raw.price_change_percent1m),
    priceChangePercent5m:percent(raw.price_change_percent5m),priceChangePercent1h:percent(raw.price_change_percent1h),
    smartDegenCount:count(raw.smart_degen_count),renownedCount:count(raw.renowned_count),botDegenCount:count(raw.bot_degen_count),
    sniperCount:count(raw.sniper_count),top10HolderRate:ratio(raw.top_10_holder_rate),rugRatio:ratio(raw.rug_ratio),
    ratTraderRate:ratio(raw.rat_trader_amount_rate),bundlerRate:firstDefined(ratio(raw.bundler_rate),ratio(raw.bundler_trader_amount_rate)),
    entrapmentRatio:ratio(raw.entrapment_ratio),suspectedInsiderHoldRate:ratio(raw.suspected_insider_hold_rate),
    devTeamHoldRate:ratio(raw.dev_team_hold_rate),botDegenRate:ratio(raw.bot_degen_rate),freshWalletRate:ratio(raw.fresh_wallet_rate),
    privateVaultHoldRate:ratio(raw.private_vault_hold_rate),buyTax:ratio(raw.buy_tax),sellTax:ratio(raw.sell_tax),
    renouncedMint:bool(raw.renounced_mint),renouncedFreeze:bool(raw.renounced_freeze_account),washTrading:bool(raw.is_wash_trading),
    honeypot:bool(raw.is_honeypot),openSource:firstDefined(bool(raw.is_open_source),bool(raw.open_source)),
    ownerRenounced:firstDefined(bool(raw.is_renounced),bool(raw.owner_renounced)),creatorTokenStatus:cleanText(raw.creator_token_status,40),
    hasSocial:firstDefined(bool(raw.has_at_least_one_social),social||undefined),cto:bool(raw.cto_flag),dexscreenerAd:bool(raw.dexscr_ad),
    dexscreenerTrending:bool(raw.dexscr_trending_bar),dexscreenerBoostFee:usd(raw.dexscr_boost_fee),
  };
  return Object.fromEntries(Object.entries(record).filter(([,value])=>value!==undefined)) as unknown as GmgnMarketDiscoveryRecord;
}

function rankRows(input:unknown):unknown[]|undefined {
  if(Array.isArray(input))return input;
  if(!isObject(input))return;
  if(Array.isArray(input.rank))return input.rank;
  if(isObject(input.data)&&Array.isArray(input.data.rank))return input.data.rank;
}

export function normalizeGmgnMarketTrending(input:unknown,options:{interval?:GmgnDiscoveryInterval;maxRows?:number}={}):GmgnDiscoveryNormalizedPage {
  const rows=rankRows(input),limit=Math.min(MAX_TRENDING_ROWS,Math.max(1,Math.floor(options.maxRows??MAX_TRENDING_ROWS))),records:GmgnMarketDiscoveryRecord[]=[],seen=new Set<string>();
  if(!rows)throw new Error('GMGN_MARKET_TRENDING_SCHEMA_INVALID');
  let deduplicated=0,rejected=0;const bounded=rows.slice(0,limit);
  for(const row of bounded){const normalized=normalizeRow(row,'trending',options.interval??'1m','trending');
    if(!normalized){rejected++;continue;}if(seen.has(normalized.address)){deduplicated++;continue;}seen.add(normalized.address);records.push(normalized);}
  return {feed:'trending',received:rows.length,accepted:records.length,deduplicated,rejected,truncated:Math.max(0,rows.length-bounded.length),records};
}

function trenchRoot(input:unknown):Obj|undefined {
  if(!isObject(input))return;
  if(isObject(input.data))return input.data;
  return input;
}

export function normalizeGmgnMarketTrenches(input:unknown,options:{maxRows?:number;maxRowsPerCategory?:number}={}):GmgnDiscoveryNormalizedPage {
  const root=trenchRoot(input),recordsByAddress=new Map<string,GmgnMarketDiscoveryRecord>();
  const knownKeys=['new_creation','pump','near_completion','completed'] as const;
  if(!root||!knownKeys.some(key=>Object.hasOwn(root,key))||knownKeys.some(key=>Object.hasOwn(root,key)&&!Array.isArray(root[key])))
    throw new Error('GMGN_MARKET_TRENCHES_SCHEMA_INVALID');
  const totalLimit=Math.min(MAX_DISCOVERY_ROWS,Math.max(1,Math.floor(options.maxRows??MAX_DISCOVERY_ROWS))),
    perCategory=Math.min(MAX_TRENCH_ROWS_PER_CATEGORY,Math.max(1,Math.floor(options.maxRowsPerCategory??MAX_TRENCH_ROWS_PER_CATEGORY)));
  const sources:[GmgnTrenchCategory,unknown[]][]=[
    ['new_creation',(root.new_creation??[]) as unknown[]],
    ['near_completion',[...((root.near_completion??[]) as unknown[]),...((root.pump??[]) as unknown[])]],
    ['completed',(root.completed??[]) as unknown[]],
  ];
  let received=0,deduplicated=0,rejected=0,truncated=0;
  for(const key of knownKeys)received+=(root[key] as unknown[]|undefined)?.length??0;
  for(const [category,rows] of sources){
    const bounded=rows.slice(0,perCategory);truncated+=Math.max(0,rows.length-bounded.length);
    for(const row of bounded){const normalized=normalizeRow(row,'trenches','lifecycle',category);if(!normalized){rejected++;continue;}
      // The most advanced lifecycle wins if an inconsistent response repeats a CA in multiple buckets.
      const previous=recordsByAddress.get(normalized.address),stage={new_creation:0,near_completion:1,completed:2} as const;
      if(previous)deduplicated++;
      if(!previous||stage[category]>stage[previous.category as GmgnTrenchCategory])recordsByAddress.set(normalized.address,normalized);
    }
  }
  const stageOrder:GmgnTrenchCategory[]=['completed','near_completion','new_creation'],buckets=new Map(stageOrder.map(category=>
      [category,[...recordsByAddress.values()].filter(record=>record.category===category)] as const)),records:GmgnMarketDiscoveryRecord[]=[];
  // Select one row per active lifecycle in turn. A full early-stage bucket can no longer consume the total limit first.
  for(let offset=0;records.length<totalLimit;offset++){
    let added=false;for(const category of stageOrder){const record=buckets.get(category)?.[offset];if(record&&records.length<totalLimit){records.push(record);added=true;}}
    if(!added)break;
  }
  truncated+=recordsByAddress.size-records.length;
  return {feed:'trenches',received,accepted:records.length,deduplicated,rejected,truncated,records};
}

function stableRecord(record:GmgnMarketDiscoveryRecord):string {
  const ordered:Obj={};for(const key of RECORD_KEYS)if(record[key]!==undefined)ordered[key]=record[key];return JSON.stringify(ordered);
}

function hash(value:string):string {return createHash('sha256').update(value).digest('hex');}

function parseStored(value:unknown):GmgnMarketDiscoveryRecord|undefined {
  if(typeof value!=='string'||value.length>16_384)return;
  try{const parsed=JSON.parse(value);return isObject(parsed)?parsed as unknown as GmgnMarketDiscoveryRecord:undefined;}catch{return;}
}

function changedFields(previous:GmgnMarketDiscoveryRecord,current:GmgnMarketDiscoveryRecord):string[] {
  return RECORD_KEYS.filter(key=>JSON.stringify(previous[key])!==JSON.stringify(current[key])).map(String).slice(0,96);
}

const TRENCH_STAGE:Record<GmgnTrenchCategory,number>={new_creation:0,near_completion:1,completed:2};

function preserveLifecycle(previous:GmgnMarketDiscoveryRecord|undefined,current:GmgnMarketDiscoveryRecord){
  if(!previous||previous.feed!=='trenches'||current.feed!=='trenches')return {record:current,regression:false};
  const oldStage=TRENCH_STAGE[previous.category as GmgnTrenchCategory],newStage=TRENCH_STAGE[current.category as GmgnTrenchCategory];
  if(oldStage===undefined||newStage===undefined||newStage>=oldStage)return {record:current,regression:false};
  return {record:{...current,category:previous.category,
      ...(previous.openTimestamp!==undefined&&current.openTimestamp===undefined?{openTimestamp:previous.openTimestamp}:{}),
      ...(previous.completeTimestamp!==undefined&&current.completeTimestamp===undefined?{completeTimestamp:previous.completeTimestamp}:{})},
    regression:true};
}

function candidate(previous:GmgnMarketDiscoveryRecord|undefined,current:GmgnMarketDiscoveryRecord,observedAt:string,fingerprint:string):GmgnMarketDiscoveryCandidate {
  const fields=previous?changedFields(previous,current):RECORD_KEYS.filter(key=>current[key]!==undefined).map(String),
    smartDelta=(current.smartDegenCount??0)-(previous?.smartDegenCount??0),renownedDelta=(current.renownedCount??0)-(previous?.renownedCount??0),
    categoryChanged=!!previous&&previous.category!==current.category,
    tracking=previous===undefined||categoryChanged||smartDelta>0||renownedDelta>0||fields.some(field=>RISK_FIELDS.has(field as keyof GmgnMarketDiscoveryRecord));
  return {id:`gmgn:discovery:${current.feed}:${current.window}:${current.address}:${fingerprint.slice(0,16)}:${Date.parse(observedAt)}`,
    source:'gmgn_market_discovery',chain:'solana',tokenAddress:current.address,observedAt,feed:current.feed,window:current.window,
    kind:previous===undefined?'first_seen':categoryChanged?'category_transition':'updated',category:current.category,
    ...(categoryChanged?{previousCategory:previous!.category}:{}),changedFields:fields,snapshot:current,smartDegenDelta:smartDelta,
    renownedDelta,walletTrackingRecommended:tracking,sourceObservationRecommended:true,researchOnly:true,entryPipeline:false,
    countingPipeline:false,notificationPipeline:false};
}

export class GmgnMarketDiscoveryStore {
  private readonly db:DatabaseSync;private readonly maxBytes:number;private readonly retentionMs:number;private readonly maxObservations:number;
  private readonly maxCurrent:number;private readonly now:()=>Date;
  constructor(options:GmgnMarketDiscoveryStoreOptions){
    if(!options.path||!Number.isSafeInteger(options.maxBytes)||options.maxBytes<1_048_576||options.maxBytes>20*1024**3||
      options.retentionMs!==undefined&&(!Number.isSafeInteger(options.retentionMs)||options.retentionMs<3_600_000||options.retentionMs>366*86_400_000)||
      options.maxObservations!==undefined&&(!Number.isSafeInteger(options.maxObservations)||options.maxObservations<100||options.maxObservations>1_000_000))
      throw new Error('GMGN_MARKET_DISCOVERY_STORE_CONFIG_INVALID');
    this.maxBytes=options.maxBytes;this.retentionMs=options.retentionMs??30*86_400_000;this.maxObservations=options.maxObservations??50_000;
    this.maxCurrent=Math.max(100,Math.min(50_000,Math.floor(this.maxObservations/4)));this.now=options.now??(()=>new Date());
    if(options.path!==':memory:')mkdirSync(dirname(options.path),{recursive:true});
    this.db=new DatabaseSync(options.path);this.db.exec(`PRAGMA journal_mode=DELETE;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=100;
      PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS gmd_current(
        feed TEXT NOT NULL,window TEXT NOT NULL,chain TEXT NOT NULL,token_address TEXT NOT NULL,category TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,seen_count INTEGER NOT NULL,fingerprint TEXT NOT NULL,data_json TEXT NOT NULL,
        PRIMARY KEY(feed,window,chain,token_address));
      CREATE INDEX IF NOT EXISTS gmd_current_seen ON gmd_current(last_seen_at);
      CREATE TABLE IF NOT EXISTS gmd_observations(
        id INTEGER PRIMARY KEY,feed TEXT NOT NULL,window TEXT NOT NULL,chain TEXT NOT NULL,token_address TEXT NOT NULL,
        category TEXT NOT NULL,observed_at TEXT NOT NULL,fingerprint TEXT NOT NULL,change_kind TEXT NOT NULL,
        changed_fields_json TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gmd_observations_time ON gmd_observations(observed_at);
      CREATE INDEX IF NOT EXISTS gmd_observations_token ON gmd_observations(chain,token_address,observed_at DESC);
      CREATE TABLE IF NOT EXISTS gmd_candidate_outbox(
        id TEXT PRIMARY KEY,observed_at TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gmd_candidate_outbox_time ON gmd_candidate_outbox(observed_at,id);
      CREATE TABLE IF NOT EXISTS gmd_kline(
        id INTEGER PRIMARY KEY,chain TEXT NOT NULL,token_address TEXT NOT NULL,nominated_at TEXT NOT NULL,observed_at TEXT NOT NULL,
        reason TEXT NOT NULL,resolution TEXT NOT NULL,from_at TEXT NOT NULL,until_at TEXT NOT NULL,momentum_json TEXT,
        coverage_json TEXT NOT NULL,diagnostics_json TEXT NOT NULL,
        UNIQUE(chain,token_address,observed_at,resolution));
      CREATE INDEX IF NOT EXISTS gmd_kline_time ON gmd_kline(observed_at);
      CREATE INDEX IF NOT EXISTS gmd_kline_token ON gmd_kline(chain,token_address,observed_at DESC);
      CREATE TABLE IF NOT EXISTS gmd_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.prepare("INSERT OR IGNORE INTO gmd_meta VALUES('continuity_lost_trending','0')").run();
    this.db.prepare("INSERT OR IGNORE INTO gmd_meta VALUES('continuity_lost_trenches','0')").run();
    const pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    this.db.exec(`PRAGMA max_page_count=${Math.max(256,Math.floor(this.maxBytes/pageSize))}`);
    if(options.path!==':memory:')chmodSync(options.path,0o600);
  }
  close(){this.db.close();}
  lastKlineAt(tokenAddress:string):string|undefined {if(!solAddress(tokenAddress))return;
    return this.db.prepare("SELECT observed_at FROM gmd_kline WHERE chain='solana' AND token_address=? ORDER BY observed_at DESC,id DESC LIMIT 1")
      .get(tokenAddress)?.observed_at as string|undefined;}
  private storage(){const pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size),
    pages=Number(this.db.prepare('PRAGMA page_count').get()!.page_count),free=Number(this.db.prepare('PRAGMA freelist_count').get()!.freelist_count);
    return {storageBytes:pages*pageSize,usedBytes:(pages-free)*pageSize};}
  status(){const current=Number(this.db.prepare('SELECT count(*) AS n FROM gmd_current').get()!.n),
    observations=Number(this.db.prepare('SELECT count(*) AS n FROM gmd_observations').get()!.n),
    klineObservations=Number(this.db.prepare('SELECT count(*) AS n FROM gmd_kline').get()!.n),
    pendingCandidateDeliveries=Number(this.db.prepare('SELECT count(*) AS n FROM gmd_candidate_outbox').get()!.n),storage=this.storage();
    return {enabled:true,current,observations,maxCurrent:this.maxCurrent,maxObservations:this.maxObservations,maxBytes:this.maxBytes,
      klineObservations,pendingCandidateDeliveries,...storage,capacityReached:storage.usedBytes+64*1024>=this.maxBytes,retentionMs:this.retentionMs,
      lastWriteAt:this.db.prepare("SELECT value FROM gmd_meta WHERE key='last_write_at'").get()?.value as string|undefined,
      lastKlineAt:this.db.prepare('SELECT observed_at FROM gmd_kline ORDER BY observed_at DESC,id DESC LIMIT 1').get()?.observed_at as string|undefined,
      lifecycleRegressions:Number(this.db.prepare("SELECT value FROM gmd_meta WHERE key='lifecycle_regressions'").get()?.value??0),
      lastLifecycleRegressionAt:this.db.prepare("SELECT value FROM gmd_meta WHERE key='last_lifecycle_regression_at'").get()?.value as string|undefined,
      researchOnly:true,entryPipeline:false,countingPipeline:false,rawPayloadStored:false};
  }
  continuityLost(feed:GmgnDiscoveryFeed):boolean {
    return this.db.prepare('SELECT value FROM gmd_meta WHERE key=?').get(`continuity_lost_${feed}`)?.value==='1';
  }
  markContinuityLost(feed:GmgnDiscoveryFeed):void {
    this.db.prepare('UPDATE gmd_meta SET value=\'1\' WHERE key=?').run(`continuity_lost_${feed}`);
  }
  restoreContinuity(feed:GmgnDiscoveryFeed):void {
    this.db.prepare('UPDATE gmd_meta SET value=\'0\' WHERE key=?').run(`continuity_lost_${feed}`);
  }
  pendingCandidateDeliveries(limit=32):GmgnMarketDiscoveryObservedCandidate[] {
    const bounded=Math.max(1,Math.min(100,Math.trunc(limit)));
    return this.db.prepare('SELECT data_json FROM gmd_candidate_outbox ORDER BY observed_at,id LIMIT ?').all(bounded).map(row=>{
      const value=JSON.parse(String(row.data_json)) as GmgnMarketDiscoveryObservedCandidate;
      if(value?.source!=='gmgn_market_discovery'||value.kind!=='first_seen'||typeof value.id!=='string'||
        typeof value.leftCensored!=='boolean'||!Number.isFinite(Date.parse(value.observedAt)))
        throw new Error('GMGN_MARKET_DISCOVERY_OUTBOX_INVALID');
      return value;
    });
  }
  ackCandidateDelivery(id:string):boolean {
    return Number(this.db.prepare('DELETE FROM gmd_candidate_outbox WHERE id=?').run(id).changes)>0;
  }
  apply(page:GmgnDiscoveryNormalizedPage,observedAt=this.now(),delivery?:GmgnCandidateDeliveryContext):GmgnDiscoveryStoreWrite {
    if(!Number.isFinite(observedAt.getTime())||page.records.length>MAX_DISCOVERY_ROWS)throw new Error('GMGN_MARKET_DISCOVERY_WRITE_INVALID');
    const at=observedAt.toISOString(),previous=delivery?.previousSuccessfulPollAt;
    if(delivery&&(typeof delivery.leftCensored!=='boolean'||previous!==undefined&&
      (!Number.isFinite(Date.parse(previous))||new Date(previous).toISOString()!==previous||previous>at)||!delivery.leftCensored&&!previous))
      throw new Error('GMGN_MARKET_DISCOVERY_DELIVERY_CONTEXT_INVALID');
    const events:GmgnMarketDiscoveryCandidate[]=[];
    const currentGet=this.db.prepare('SELECT fingerprint,data_json FROM gmd_current WHERE feed=? AND window=? AND chain=? AND token_address=?'),
      currentPut=this.db.prepare(`INSERT INTO gmd_current VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(feed,window,chain,token_address) DO UPDATE SET
        category=excluded.category,last_seen_at=excluded.last_seen_at,seen_count=gmd_current.seen_count+1,
        fingerprint=excluded.fingerprint,data_json=excluded.data_json`),
      observationPut=this.db.prepare(`INSERT OR IGNORE INTO gmd_observations(
        feed,window,chain,token_address,category,observed_at,fingerprint,change_kind,changed_fields_json,data_json) VALUES(?,?,?,?,?,?,?,?,?,?)`),
      outboxPut=this.db.prepare('INSERT OR IGNORE INTO gmd_candidate_outbox VALUES (?,?,?)'),
      metaPut=this.db.prepare("INSERT INTO gmd_meta VALUES('last_write_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
      regressionPut=this.db.prepare(`INSERT INTO gmd_meta VALUES('lifecycle_regressions','1') ON CONFLICT(key) DO UPDATE SET
        value=CAST(CAST(gmd_meta.value AS INTEGER)+1 AS TEXT)`),
      regressionAtPut=this.db.prepare("INSERT INTO gmd_meta VALUES('last_lifecycle_regression_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    let inserted=0,unchanged=0;
    try{this.db.exec('BEGIN IMMEDIATE');for(const observed of page.records){const stored=currentGet.get(observed.feed,observed.window,observed.chain,observed.address),
        previous=parseStored(stored?.data_json),preserved=preserveLifecycle(previous,observed),record=preserved.record,
        json=stableRecord(record),fingerprint=hash(json);
      if(preserved.regression){regressionPut.run();regressionAtPut.run(at);}
      if(stored?.fingerprint===fingerprint){currentPut.run(record.feed,record.window,record.chain,record.address,record.category,at,at,1,fingerprint,json);unchanged++;continue;}
      const event=candidate(previous,record,at,fingerprint),result=observationPut.run(record.feed,record.window,record.chain,record.address,
        record.category,at,fingerprint,event.kind,JSON.stringify(event.changedFields),json);
      currentPut.run(record.feed,record.window,record.chain,record.address,record.category,at,at,1,fingerprint,json);
      if(result.changes){inserted++;events.push(event);
        if(delivery&&event.kind==='first_seen')outboxPut.run(event.id,at,JSON.stringify({...event,...delivery}));}}
      const continuityLostFeeds=this.prune(at);metaPut.run(at);this.db.exec('COMMIT');
      return {received:page.records.length,inserted,unchanged,capacityReached:false,events,continuityLostFeeds};
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}if(error instanceof Error&&/(SQLITE_FULL|database or disk is full)/i.test(error.message))
      return {received:page.records.length,inserted:0,unchanged:0,capacityReached:true,events:[],continuityLostFeeds:[]};throw error;}
  }
  private prune(at:string):GmgnDiscoveryFeed[]{const cutoff=new Date(new Date(at).getTime()-this.retentionMs).toISOString(),lost=new Set<GmgnDiscoveryFeed>(),
    mark=(rows:Record<string,unknown>[])=>rows.forEach(row=>{if(row.feed==='trending'||row.feed==='trenches')lost.add(row.feed);});
    this.db.prepare('DELETE FROM gmd_observations WHERE observed_at<?').run(cutoff);
    const observations=Number(this.db.prepare('SELECT count(*) AS n FROM gmd_observations').get()!.n),extra=observations-this.maxObservations;
    if(extra>0)this.db.prepare('DELETE FROM gmd_observations WHERE id IN (SELECT id FROM gmd_observations ORDER BY observed_at,id LIMIT ?)').run(extra);
    mark(this.db.prepare('SELECT DISTINCT feed FROM gmd_current WHERE last_seen_at<?').all(cutoff));
    this.db.prepare('DELETE FROM gmd_current WHERE last_seen_at<?').run(cutoff);
    const current=Number(this.db.prepare('SELECT count(*) AS n FROM gmd_current').get()!.n),currentExtra=current-this.maxCurrent;
    if(currentExtra>0){mark(this.db.prepare(`SELECT DISTINCT feed FROM (SELECT feed FROM gmd_current ORDER BY last_seen_at,feed,window,chain,token_address LIMIT ?)` ).all(currentExtra));
      this.db.prepare(`DELETE FROM gmd_current WHERE (feed,window,chain,token_address) IN (
        SELECT feed,window,chain,token_address FROM gmd_current ORDER BY last_seen_at,feed,window,chain,token_address LIMIT ?)` ).run(currentExtra);}
    for(const feed of lost)this.markContinuityLost(feed);
    this.db.prepare('DELETE FROM gmd_kline WHERE observed_at<?').run(cutoff);
    const klineLimit=Math.max(100,Math.floor(this.maxObservations/10)),klineCount=Number(this.db.prepare('SELECT count(*) AS n FROM gmd_kline').get()!.n);
    if(klineCount>klineLimit)this.db.prepare('DELETE FROM gmd_kline WHERE id IN (SELECT id FROM gmd_kline ORDER BY observed_at,id LIMIT ?)').run(klineCount-klineLimit);
    return [...lost].sort();
  }
  recordKline(observation:GmgnMarketKlineObservation):GmgnKlineStoreResult {
    if(observation.chain!=='solana'||!solAddress(observation.tokenAddress)||observation.resolution!=='30s'||
      ![observation.nominatedAt,observation.observedAt,observation.fromAt,observation.untilAt].every(value=>Number.isFinite(Date.parse(value)))||
      Date.parse(observation.fromAt)>=Date.parse(observation.untilAt)||Date.parse(observation.untilAt)>Date.parse(observation.observedAt))
      throw new Error('GMGN_MARKET_DISCOVERY_KLINE_INVALID');
    const reason=cleanText(observation.reason,80)??'external_signal',momentum=observation.momentum?JSON.stringify(observation.momentum):null,
      coverage=JSON.stringify(observation.coverage),diagnostics=JSON.stringify(observation.diagnostics);
    if((momentum?.length??0)>4096||coverage.length>4096||diagnostics.length>4096)throw new Error('GMGN_MARKET_DISCOVERY_KLINE_INVALID');
    try{const result=this.db.prepare(`INSERT OR IGNORE INTO gmd_kline(chain,token_address,nominated_at,observed_at,reason,resolution,
        from_at,until_at,momentum_json,coverage_json,diagnostics_json) VALUES('solana',?,?,?,?,?,?,?,?,?,?)`).run(
        observation.tokenAddress,observation.nominatedAt,observation.observedAt,reason,observation.resolution,observation.fromAt,
        observation.untilAt,momentum,coverage,diagnostics);
      this.prune(observation.observedAt);return result.changes>0?'inserted':'duplicate';
    }catch(error){if(error instanceof Error&&/(SQLITE_FULL|database or disk is full)/i.test(error.message))
      throw new Error('GMGN_MARKET_DISCOVERY_KLINE_STORE_CAPACITY');throw error;}
  }
  recent(limit=100):GmgnMarketDiscoveryCandidate[]{
    const bounded=Math.min(500,Math.max(1,Math.floor(limit))),rows=this.db.prepare('SELECT * FROM gmd_observations ORDER BY observed_at DESC,id DESC LIMIT ?').all(bounded);
    return rows.flatMap(row=>{const snapshot=parseStored(row.data_json);if(!snapshot)return [];
      const previousCategory=undefined,fields=typeof row.changed_fields_json==='string'?JSON.parse(row.changed_fields_json) as string[]:[];
      return [{id:`gmgn:discovery:${snapshot.feed}:${snapshot.window}:${snapshot.address}:${String(row.fingerprint).slice(0,16)}:${Date.parse(String(row.observed_at))}`,
        source:'gmgn_market_discovery' as const,chain:'solana' as const,tokenAddress:snapshot.address,observedAt:String(row.observed_at),
        feed:snapshot.feed,window:snapshot.window,kind:String(row.change_kind) as GmgnDiscoveryChangeKind,category:snapshot.category,
        ...(previousCategory?{previousCategory}:{}),changedFields:fields,snapshot,smartDegenDelta:0,renownedDelta:0,
        walletTrackingRecommended:fields.some(field=>WALLET_FIELDS.has(field as keyof GmgnMarketDiscoveryRecord)||RISK_FIELDS.has(field as keyof GmgnMarketDiscoveryRecord)),
        sourceObservationRecommended:true as const,researchOnly:true as const,entryPipeline:false as const,countingPipeline:false as const,
        notificationPipeline:false as const}];});
  }
}

interface Nomination {address:string;nominatedAt:string;reason:string;priority:number;attempts:number;nextAttemptAt:number;}
interface FeedState {polls:number;received:number;accepted:number;deduplicated:number;rejected:number;truncated:number;changes:number;unchanged:number;errors:number;
  nextDueAt:number;idleStreak:number;lastSuccessAt?:string;lastError?:string;}

function nominationPriority(reason:string):number {
  if(/^source_(?:debot|ave)$/.test(reason))return 100;
  if(reason==='gmgn_market_priority_analysis'||reason==='source_wallet')return 95;
  if(reason==='gmgn_market_narrative_analysis')return 90;
  if(reason.includes('renowned_delta'))return 85;
  if(reason.includes('category_transition')||reason==='source_gmgn')return 80;
  if(reason.includes('smart_delta'))return 75;
  if(reason==='gmgn_market_conditional_analysis')return 70;
  if(reason.includes('trending_rank'))return 65;
  if(reason.startsWith('discovery_'))return 60;
  return 50;
}

export class GmgnMarketDiscoveryScanner {
  private readonly now:()=>Date;private readonly intervalMs:number;private readonly maxCandidates:number;private readonly klineCooldownMs:number;
  private readonly queueTimeoutMs:number;private readonly trendingInterval:GmgnDiscoveryInterval;private running=false;private generation=0;
  private workCursor=0;
  private timer?:ReturnType<typeof setTimeout>;private active?:Promise<void>;private readonly nominations=new Map<string,Nomination>();
  private readonly remoteMinIntervalMs=30_000;private nextRemoteAt=0;
  private readonly klineMinIntervalMs=30_000;private nextKlineAt=0;private nominationEvictions=0;private nominationRejected=0;
  private readonly lastKlineAt=new Map<string,number>();private candidateErrors=0;private klinePolls=0;private klineSuccesses=0;
  private klineDuplicates=0;private klineErrors=0;private klineStoreCapacityErrors=0;private lastKlineAtIso?:string;private lastKlineError?:string;
  private readonly feeds:Record<GmgnDiscoveryFeed,FeedState>={
    trending:{polls:0,received:0,accepted:0,deduplicated:0,rejected:0,truncated:0,changes:0,unchanged:0,errors:0,nextDueAt:0,idleStreak:0},
    trenches:{polls:0,received:0,accepted:0,deduplicated:0,rejected:0,truncated:0,changes:0,unchanged:0,errors:0,nextDueAt:0,idleStreak:0}};
  private readonly feedPollContinuous:Record<GmgnDiscoveryFeed,boolean>={trending:false,trenches:false};
  constructor(private readonly options:GmgnMarketDiscoveryScannerOptions){
    if(!Number.isSafeInteger(options.intervalMs)||options.intervalMs<1_000||options.intervalMs>600_000||
      !Number.isSafeInteger(options.maxCandidates)||options.maxCandidates<1||options.maxCandidates>MAX_DISCOVERY_ROWS||
      options.klineCooldownMs!==undefined&&(!Number.isSafeInteger(options.klineCooldownMs)||options.klineCooldownMs<30_000||options.klineCooldownMs>86_400_000)||
      options.queueTimeoutMs!==undefined&&(!Number.isSafeInteger(options.queueTimeoutMs)||options.queueTimeoutMs<250||options.queueTimeoutMs>10_000))
      throw new Error('GMGN_MARKET_DISCOVERY_SCANNER_CONFIG_INVALID');
    this.now=options.now??(()=>new Date());this.intervalMs=options.intervalMs;this.maxCandidates=options.maxCandidates;
    // The lane may already be occupied by one bounded Market Signal HTTP read
    // when this job is queued. Waiting here does not delay Signal; it only lets
    // discovery survive that in-flight read long enough to claim its 30 s fair
    // turn. The protected network turn itself remains capped at three seconds
    // in GmgnClient.
    this.klineCooldownMs=options.klineCooldownMs??300_000;this.queueTimeoutMs=options.queueTimeoutMs??10_000;
    this.trendingInterval=options.trendingInterval??'1m';
  }
  start(){if(this.running)return;this.running=true;this.generation++;this.feedPollContinuous.trending=false;this.feedPollContinuous.trenches=false;
    const now=this.now().getTime();this.feeds.trending.nextDueAt=now;this.feeds.trenches.nextDueAt=now;this.schedule(0,this.generation);}
  stop(){this.running=false;this.generation++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
  async drain(){await this.active;}
  nominate(token:{chain:'sol'|'solana';address:string},observedAt:string|Date,reason='external_signal'):boolean {
    if(!['sol','solana'].includes(token.chain)||!solAddress(token.address))return false;
    const at=observedAt instanceof Date?observedAt:new Date(observedAt);if(!Number.isFinite(at.getTime()))return false;
    const now=this.now().getTime(),cleanReason=cleanText(reason,80)??'external_signal',priority=nominationPriority(cleanReason),
      existing=this.nominations.get(token.address);
    if(existing){
      if(at.getTime()<Date.parse(existing.nominatedAt))existing.nominatedAt=at.toISOString();
      if(priority>existing.priority){existing.priority=priority;existing.reason=cleanReason;existing.nextAttemptAt=Math.min(existing.nextAttemptAt,now);}
      return false;
    }
    const stored=Date.parse(this.options.store.lastKlineAt(token.address)??''),
      last=Math.max(this.lastKlineAt.get(token.address)??0,Number.isFinite(stored)?stored:0);if(now-last<this.klineCooldownMs)return false;
    const capacity=Math.min(1_000,this.maxCandidates*4);
    if(this.nominations.size>=capacity){
      const lowest=[...this.nominations.values()].sort((a,b)=>a.priority-b.priority||b.nominatedAt.localeCompare(a.nominatedAt))[0];
      if(!lowest||priority<=lowest.priority){this.nominationRejected++;return false;}
      this.nominations.delete(lowest.address);this.nominationEvictions++;
    }
    this.nominations.set(token.address,{address:token.address,nominatedAt:at.toISOString(),reason:cleanReason,priority,attempts:0,nextAttemptAt:now});return true;
  }
  status(){return {enabled:true,running:this.running,inFlight:!!this.active,intervalMs:this.intervalMs,maxCandidates:this.maxCandidates,
    priority:'background' as const,queueTimeoutMs:this.queueTimeoutMs,feeds:structuredClone(this.feeds),nominations:this.nominations.size,
    nominationCapacity:Math.min(1_000,this.maxCandidates*4),nominationEvictions:this.nominationEvictions,
    nominationRejected:this.nominationRejected,remoteMinIntervalMs:this.remoteMinIntervalMs,
    nextRemoteAt:this.nextRemoteAt?new Date(this.nextRemoteAt).toISOString():undefined,klineMinIntervalMs:this.klineMinIntervalMs,
    klineSupported:typeof this.options.client.getMarketKline==='function',klineCooldownMs:this.klineCooldownMs,klinePolls:this.klinePolls,
    klineSuccesses:this.klineSuccesses,klineDuplicates:this.klineDuplicates,klineErrors:this.klineErrors,klineStoreCapacityErrors:this.klineStoreCapacityErrors,
    lastKlineAt:this.lastKlineAtIso,lastKlineError:this.lastKlineError,candidateErrors:this.candidateErrors,store:this.options.store.status(),
    researchOnly:true,entryPipeline:false,countingPipeline:false,notificationPipeline:false};}
  pollNow():Promise<void>{if(this.active)return this.active;const task=this.runCycle().finally(()=>{if(this.active===task)this.active=undefined;});this.active=task;return task;}
  private schedule(delay:number,generation:number){if(!this.running||generation!==this.generation)return;if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.timer=undefined;void this.pollNow().finally(()=>{if(this.running&&generation===this.generation)this.schedule(this.nextDelay(),generation);});},delay);this.timer.unref?.();}
  private nextDelay(){const now=this.now().getTime(),due=Math.min(this.feeds.trending.nextDueAt,this.feeds.trenches.nextDueAt,
    this.nominations.size?Math.max(this.nextKlineAt,Math.min(...[...this.nominations.values()].map(row=>row.nextAttemptAt))):Number.POSITIVE_INFINITY);
    const readyAt=Number.isFinite(due)?Math.max(due,this.nextRemoteAt):Number.POSITIVE_INFINITY;
    return Math.max(25,Math.min(this.intervalMs,Number.isFinite(readyAt)?readyAt-now:this.intervalMs));}
  private async deliverPendingCandidates():Promise<void> {
    if(!this.options.onCandidate)return;
    let pending:GmgnMarketDiscoveryObservedCandidate[];
    try{pending=this.options.store.pendingCandidateDeliveries(32);}catch{this.candidateErrors++;return;}
    for(const event of pending)try{await this.options.onCandidate(event);this.options.store.ackCandidateDelivery(event.id);}
      catch{this.candidateErrors++;}
  }
  private async deliverCandidate(event:GmgnMarketDiscoveryCandidate,context:GmgnCandidateDeliveryContext):Promise<void> {
    if(!this.options.onCandidate)return;
    try{await this.options.onCandidate({...event,...context});
      if(event.kind==='first_seen')this.options.store.ackCandidateDelivery(event.id);
    }catch{this.candidateErrors++;}
  }
  private async runCycle(){await this.deliverPendingCandidates();const now=this.now().getTime(),cooldown=Math.max(now,this.options.client.cooldownUntil??0);
    if(cooldown>now){this.feeds.trending.nextDueAt=Math.max(this.feeds.trending.nextDueAt,cooldown);this.feeds.trenches.nextDueAt=Math.max(this.feeds.trenches.nextDueAt,cooldown);
      this.nextKlineAt=Math.max(this.nextKlineAt,cooldown);this.nextRemoteAt=Math.max(this.nextRemoteAt,cooldown);return;}
    if(now<this.nextRemoteAt)return;
    // Exactly one remote read per scanner cycle. Rotate the two feeds and Kline
    // work so the client's low-frequency protected slot cannot impose several
    // consecutive Signal delays or permanently favor Trending.
    const work=[
      {due:()=>this.feeds.trending.nextDueAt<=now,run:()=>this.pollFeed('trending')},
      {due:()=>this.feeds.trenches.nextDueAt<=now,run:()=>this.pollFeed('trenches')},
      {due:()=>this.nominationDue(now),run:()=>this.pollNomination()},
    ];
    for(let offset=0;offset<work.length;offset++){
      const index=(this.workCursor+offset)%work.length,item=work[index];
      if(!item.due())continue;
      this.workCursor=(index+1)%work.length;
      this.nextRemoteAt=now+this.remoteMinIntervalMs;
      await item.run();
      return;
    }
  }
  private scheduling():GmgnDiscoveryScheduling{return {priority:'background',queueTimeoutMs:this.queueTimeoutMs};}
  private async pollFeed(feed:GmgnDiscoveryFeed){const state=this.feeds[feed],
    previousSuccessfulPollAt=state.lastSuccessAt,leftCensored=!previousSuccessfulPollAt||!this.feedPollContinuous[feed]||
      this.options.store.continuityLost(feed),delivery={previousSuccessfulPollAt,leftCensored};state.polls++;
    try{const payload=feed==='trending'?await this.options.client.getMarketTrending('sol',{interval:this.trendingInterval,limit:Math.min(MAX_TRENDING_ROWS,this.maxCandidates)},this.scheduling()):
        await this.options.client.getMarketTrenches('sol',{categories:['new_creation','near_completion','completed'],limit:Math.min(MAX_TRENCH_ROWS_PER_CATEGORY,this.maxCandidates)},this.scheduling()),
      observedAt=this.now(),
      page=feed==='trending'?normalizeGmgnMarketTrending(payload,{interval:this.trendingInterval,maxRows:this.maxCandidates}):
        normalizeGmgnMarketTrenches(payload,{maxRows:this.maxCandidates,maxRowsPerCategory:Math.min(MAX_TRENCH_ROWS_PER_CATEGORY,this.maxCandidates)}),
      write=this.options.store.apply(page,observedAt,this.options.onCandidate?delivery:undefined);
      state.received+=page.received;state.accepted+=page.accepted;state.deduplicated+=page.deduplicated;
      state.rejected+=page.rejected;state.truncated+=page.truncated;
      if(write.capacityReached){state.errors++;state.lastError='GMGN_MARKET_DISCOVERY_STORE_CAPACITY';
        state.idleStreak=Math.min(3,state.idleStreak+1);this.feedPollContinuous[feed]=false;
        try{this.options.store.markContinuityLost(feed);}catch{/* The in-memory break still prevents a false bounded interval. */}}
      else {state.lastSuccessAt=observedAt.toISOString();state.lastError=undefined;state.changes+=write.inserted;state.unchanged+=write.unchanged;
        state.idleStreak=write.inserted?0:Math.min(3,state.idleStreak+1);
        for(const lost of write.continuityLostFeeds)this.feedPollContinuous[lost]=false;
        if(!write.continuityLostFeeds.includes(feed)){this.feedPollContinuous[feed]=true;this.options.store.restoreContinuity(feed);}
      }
      for(const event of write.events)await this.deliverCandidate(event,delivery);
    }catch(error){this.feedPollContinuous[feed]=false;state.errors++;state.lastError=error instanceof Error?error.message.slice(0,300):String(error).slice(0,300);state.idleStreak=Math.min(3,state.idleStreak+1);}
    const multiplier=Math.min(4,2**state.idleStreak);state.nextDueAt=this.now().getTime()+this.intervalMs*multiplier;
  }
  private nominationDue(now:number):boolean {
    return typeof this.options.client.getMarketKline==='function'&&now>=this.nextKlineAt&&
      [...this.nominations.values()].some(row=>row.nextAttemptAt<=now);
  }
  private async pollNomination(){if(!this.options.client.getMarketKline||!this.nominations.size)return;const now=this.now().getTime(),
    nomination=[...this.nominations.values()].filter(row=>row.nextAttemptAt<=now).sort((a,b)=>b.priority-a.priority||a.nextAttemptAt-b.nextAttemptAt||a.nominatedAt.localeCompare(b.nominatedAt))[0];
    if(!nomination||now<this.nextKlineAt)return;this.nextKlineAt=now+this.klineMinIntervalMs;this.klinePolls++;
    try{const nominatedAt=new Date(nomination.nominatedAt).getTime(),fromMs=Math.max(nominatedAt-300_000,now-7_200_000),
        from=Math.floor(fromMs/1000),to=Math.floor(now/1000),payload=await this.options.client.getMarketKline('sol',nomination.address,
          {resolution:'30s',from,to},this.scheduling()),receivedAt=this.now().toISOString(),window=normalizeGmgnKline(payload,
          {token:{chain:'solana',address:nomination.address},resolution:'30s',fromAt:new Date(from*1_000).toISOString(),
            untilAt:new Date(to*1_000).toISOString(),receivedAt}),momentum=gmgnKlineMomentum(window,receivedAt,20),
        observation:GmgnMarketKlineObservation={chain:'solana',tokenAddress:nomination.address,nominatedAt:nomination.nominatedAt,
          observedAt:receivedAt,reason:nomination.reason,resolution:'30s',fromAt:window.fromAt,untilAt:window.untilAt,
          coverage:window.coverage,diagnostics:window.diagnostics,...(momentum?{momentum}:{}),researchOnly:true,priceRouter:false,
          entryPipeline:false,countingPipeline:false};
      const stored=this.options.store.recordKline(observation);
      this.lastKlineError=undefined;this.lastKlineAt.set(nomination.address,now);this.lastKlineAtIso=observation.observedAt;
      this.nominations.delete(nomination.address);
      if(stored==='inserted'){
        this.klineSuccesses++;if(this.options.onKline)try{await this.options.onKline(observation);}catch{this.klineErrors++;}
      }else this.klineDuplicates++;
    }catch(error){this.klineErrors++;const message=error instanceof Error?error.message:String(error);this.lastKlineError=message.slice(0,300);
      if(message==='GMGN_MARKET_DISCOVERY_KLINE_STORE_CAPACITY')this.klineStoreCapacityErrors++;
      nomination.attempts++;nomination.nextAttemptAt=now+Math.min(300_000,5_000*2**Math.min(6,nomination.attempts));
      // Storage pressure is recoverable after pruning or operator cleanup, so retain this nomination indefinitely with bounded backoff.
      if(nomination.attempts>=5&&message!=='GMGN_MARKET_DISCOVERY_KLINE_STORE_CAPACITY')this.nominations.delete(nomination.address);}
  }
}
