import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import bs58 from 'bs58';
import {chainAddress} from './chain-stream-store.js';
import {tokenDisplayText} from './token-display.js';
import type {Signal} from './types.js';

type Token=Signal['token'];
export type CorroborationSource='ave'|'debot'|'gmgn';
export interface SourceTransactionReference {txHash:string;wallet?:string;side?:'buy'|'sell';}
export interface SourceNotificationEvidence {
  source:CorroborationSource;eventId:string;token:Token;occurredAt:string;firstObservedAt:string;recordedAt:string;
  lastDeliveryAt:string;lastRecordedAt:string;deliveryCount:number;conflictAt?:string;
  name?:string;sourceUrl?:string;txRefs:SourceTransactionReference[];
}
export type CorroborationFreshness='fresh'|'stale'|'late'|'future'|'conflict';
export interface SourceNotificationActivity {
  asOf:string;scope:'retained_valid_provider_events';counting:'exact_retained_events';bucketBy:'occurredAt';maxArrivalDelaySec:120;
  windows:Record<'last1m'|'last5m'|'previous5m',{startExclusive:string;endInclusive:string}>;
  sources:{source:CorroborationSource;last1m:number;last5m:number;previous5m:number;change5m:number}[];
  historyComplete:false;retainedFrom:string;referenceSampleTruncated:boolean;limitations:string[];
}
export interface SourceCorroborationAssessment {
  version:1;token:Token;assessedAt:string;windowStart:string;windowSec:number;
  classification:'cross_source'|'single_source'|'none';freshSourceCount:number;freshSources:CorroborationSource[];
  sources:{source:CorroborationSource;status:CorroborationFreshness;eventId:string;occurredAt:string;
    firstObservedAt:string;recordedAt:string;lastDeliveryAt?:string;notificationCount:number;
    deliveryCount:number|null;sourceUrl?:string;txReferenceCount:number}[];
  sharedTransactions:{txHash:string;sources:CorroborationSource[];wallets:string[];sides:('buy'|'sell')[];
    verification:'vendor_reference';}[];
  independentEvidence:'unknown';researchOnly:true;scoreEffect:0;
  scope:'same_chain_contract_recent_notifications';limitations:string[];
  /** Local event-ID activity only. A count is never an independent-wallet or trade count. */
  activity?:SourceNotificationActivity;
}
interface AssessmentInput {
  token:Token;now:Date;windowSec?:number;observations:readonly SourceNotificationEvidence[];
  /** Optional exact first-observation counts from the same bounded database query, not trust/quality weights. */
  notificationCounts?:Partial<Record<CorroborationSource,number>>;truncated?:boolean;
}
export interface SourceCorroborationOptions {now?:()=>Date;windowSec?:number;maxBytes?:number;maxEvents?:number;}
export interface SourceCorroborationMetadata {name?:string;txRefs?:SourceTransactionReference[];sourceUrl?:string;}
type Row=Record<string,any>;
const SOURCES:readonly CorroborationSource[]=['ave','debot','gmgn'];
const RETENTION_DAYS=30,DEFAULT_MAX_EVENTS=100000,MAX_REFS=20,ASSESS_EVENTS_PER_SOURCE=64;
const RETENTION_MS=RETENTION_DAYS*86400000;
const STATUS_META_VERSION='1';
const STATUS_META_KEYS={version:'status_version',events:'events',deliveries:'deliveries',latest:'latest_observed_at'} as const;
const iso=(n:number)=>new Date(n).toISOString();
function millis(value:unknown):number {
  return typeof value==='string'&&value.length<=40&&/^\d{4}-\d\d-\d\dT/.test(value)?Date.parse(value):NaN;
}
function normalizedToken(token:Token):Token|undefined {
  if(!token||!['bsc','solana','robinhood'].includes(token.chain))return;
  const address=chainAddress(token.chain,token.address);
  if(!address||/^0x0{40}$/.test(address)||address==='11111111111111111111111111111111')return;
  return {chain:token.chain,address};
}
function sameToken(left:Token,right:Token):boolean {
  const a=normalizedToken(left),b=normalizedToken(right);return !!a&&!!b&&a.chain===b.chain&&a.address===b.address;
}
function eventId(value:unknown):value is string {return typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value);}
function windowSeconds(value=300):number {
  if(!Number.isInteger(value)||value<1||value>3600)throw new Error('SOURCE_WINDOW_INVALID');return value;
}
function txHash(value:unknown,token:Token):string|undefined {
  if(typeof value!=='string')return;
  if(token.chain!=='solana')return /^0x[0-9a-f]{64}$/i.test(value)&&!/^0x0{64}$/i.test(value)?value.toLowerCase():undefined;
  try {const bytes=bs58.decode(value);if(value.length<=88&&bytes.length===64&&bytes.some(byte=>byte!==0))return value;}catch {/* Invalid reference. */}
}
function references(input:unknown,token:Token):SourceTransactionReference[] {
  if(!Array.isArray(input))return [];
  const unique=new Map<string,SourceTransactionReference>();
  for(const value of input.slice(0,MAX_REFS)){
    if(!value||typeof value!=='object')continue;
    const hash=txHash(value.txHash,token);if(!hash)continue;
    const wallet=value.wallet===undefined?undefined:normalizedToken({chain:token.chain,address:value.wallet})?.address;
    if(value.wallet!==undefined&&!wallet||value.side!==undefined&&!['buy','sell'].includes(value.side))continue;
    const ref:SourceTransactionReference={txHash:hash,...(wallet?{wallet}:{}),...(value.side?{side:value.side}:{})};
    unique.set(JSON.stringify(ref),ref);
  }
  return [...unique.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function publicUrl(value:unknown,source:CorroborationSource):string|undefined {
  if(typeof value!=='string'||value.length>2000)return;
  try {
    const url=new URL(value),host=source==='ave'?'ave.ai':`${source}.ai`;
    if(url.protocol!=='https:'||url.username||url.password||url.port||![host,`www.${host}`].includes(url.hostname))return;
    // Public page locations only; query strings can carry credentials or account identifiers.
    url.search='';url.hash='';return url.toString().length<=500?url.toString():undefined;
  }catch{return;}
}
function cleanEvidence(raw:SourceNotificationEvidence,token:Token,now:number):SourceNotificationEvidence|undefined {
  if(!raw||!SOURCES.includes(raw.source)||!eventId(raw.eventId)||!sameToken(raw.token,token))return;
  const occurred=millis(raw.occurredAt),received=millis(raw.firstObservedAt),recorded=millis(raw.recordedAt),
    last=millis(raw.lastDeliveryAt),lastRecorded=millis(raw.lastRecordedAt),conflict=millis(raw.conflictAt);
  if(![occurred,received,recorded,last,lastRecorded].every(Number.isFinite)||received>recorded||recorded>now||
    last<received||lastRecorded<recorded||last>lastRecorded||!Number.isSafeInteger(raw.deliveryCount)||raw.deliveryCount<1||
    raw.conflictAt!==undefined&&(!Number.isFinite(conflict)||conflict<recorded))return;
  return {...raw,token,occurredAt:iso(occurred),firstObservedAt:iso(received),recordedAt:iso(recorded),
    lastDeliveryAt:iso(last),lastRecordedAt:iso(lastRecorded),...(Number.isFinite(conflict)?{conflictAt:iso(conflict)}:{}),
    name:tokenDisplayText(raw.name,100),sourceUrl:publicUrl(raw.sourceUrl,raw.source),txRefs:references(raw.txRefs,token)};
}
function freshness(value:SourceNotificationEvidence,now:number,windowMs:number):CorroborationFreshness {
  if(value.conflictAt&&millis(value.conflictAt)<=now)return 'conflict';
  const occurred=millis(value.occurredAt),received=millis(value.firstObservedAt);
  // A future-dated notification never becomes fresh merely because the clock catches up.
  if(occurred>received)return 'future';
  if(received-occurred>windowMs)return 'late';
  return now-occurred<=windowMs&&now-received<=windowMs?'fresh':'stale';
}

/** Pure descriptive cross-source comparison. Two websites are never treated as two independent owners. */
export function assessSourceCorroboration(input:AssessmentInput):SourceCorroborationAssessment {
  const token=normalizedToken(input.token),now=input.now.getTime(),windowSec=windowSeconds(input.windowSec),windowMs=windowSec*1000;
  if(!token||!Number.isFinite(now))throw new Error('SOURCE_ASSESSMENT_INVALID');
  const unique=new Map<string,SourceNotificationEvidence>();
  let invalid=0;
  for(const raw of input.observations){
    const value=cleanEvidence(raw,token,now);if(!value){invalid++;continue;}
    const key=JSON.stringify([value.source,value.eventId]),previous=unique.get(key);
    if(!previous){unique.set(key,value);continue;}
    // Repeated copies cannot inflate evidence. Contradictory copies are ineligible from their first known conflict.
    const earliest=millis(previous.recordedAt)<=millis(value.recordedAt)?previous:value;
    const later=earliest===previous?value:previous;
    if(previous.occurredAt!==value.occurredAt||previous.firstObservedAt!==value.firstObservedAt){
      unique.set(key,{...earliest,conflictAt:iso(Math.min(millis(earliest.conflictAt)||Infinity,millis(later.recordedAt)))});
    }
  }
  const observations=[...unique.values()],sources:SourceCorroborationAssessment['sources']=[],freshSources:CorroborationSource[]=[];
  for(const source of SOURCES){
    const rows=observations.filter(value=>value.source===source),fresh=rows.filter(value=>freshness(value,now,windowMs)==='fresh');
    const candidates=fresh.length?fresh:rows;
    const latest=[...candidates].sort((a,b)=>b.firstObservedAt.localeCompare(a.firstObservedAt)||b.eventId.localeCompare(a.eventId))[0];
    if(!latest)continue;
    const status=freshness(latest,now,windowMs);if(status==='fresh')freshSources.push(source);
    const supplied=input.notificationCounts?.[source],notificationCount=Number.isSafeInteger(supplied)&&supplied!>=0?supplied!:
      rows.filter(value=>millis(value.firstObservedAt)>=now-windowMs).length;
    sources.push({source,status,eventId:latest.eventId,occurredAt:latest.occurredAt,firstObservedAt:latest.firstObservedAt,recordedAt:latest.recordedAt,
      ...(millis(latest.lastRecordedAt)<=now?{lastDeliveryAt:latest.lastDeliveryAt}:{}),notificationCount,
      deliveryCount:millis(latest.lastRecordedAt)<=now?latest.deliveryCount:null,sourceUrl:latest.sourceUrl,txReferenceCount:latest.txRefs.length});
  }
  const transactions=new Map<string,{sources:Set<CorroborationSource>;wallets:Set<string>;sides:Set<'buy'|'sell'>}>();
  for(const notification of observations.filter(value=>freshness(value,now,windowMs)==='fresh'))for(const ref of notification.txRefs){
    const item=transactions.get(ref.txHash)??{sources:new Set(),wallets:new Set(),sides:new Set()};
    item.sources.add(notification.source);if(ref.wallet)item.wallets.add(ref.wallet);if(ref.side)item.sides.add(ref.side);
    transactions.set(ref.txHash,item);
  }
  const sharedTransactions=[...transactions].filter(([,value])=>value.sources.size>1).sort(([a],[b])=>a.localeCompare(b)).slice(0,40)
    .map(([hash,value])=>({txHash:hash,sources:[...value.sources].sort(),wallets:[...value.wallets].sort(),sides:[...value.sides].sort(),verification:'vendor_reference' as const}));
  const limitations=['RETAINED_NOTIFICATIONS_ONLY','PLATFORM_NOTIFICATIONS_NOT_INDEPENDENT_WALLETS','VENDOR_REFERENCES_NOT_CHAIN_VERIFIED',
    'SOURCE_COUNT_DOES_NOT_CHANGE_SCORE','OBSERVED_STREAM_SAMPLE_NOT_FULL_PROVIDER_HISTORY','FIRST_NOTIFICATION_METADATA_FROZEN'];
  if(invalid)limitations.push('INVALID_OR_NOT_YET_KNOWN_EVIDENCE_EXCLUDED');
  if(input.truncated)limitations.push('SHARED_REFERENCE_COMPARISON_BOUNDED_SAMPLE');
  if(sources.some(value=>value.deliveryCount===null))limitations.push('HISTORICAL_DELIVERY_COUNT_UNKNOWN');
  return {version:1,token,assessedAt:iso(now),windowStart:iso(now-windowMs),windowSec,
    classification:freshSources.length>=2?'cross_source':freshSources.length===1?'single_source':'none',
    freshSourceCount:freshSources.length,freshSources,sources,sharedTransactions,independentEvidence:'unknown',researchOnly:true,scoreEffect:0,
    scope:'same_chain_contract_recent_notifications',limitations};
}

/** Durable provider-notification ledger. No trading client, account credentials or order methods are accepted. */
export class SourceCorroboration {
  private readonly db:DatabaseSync;private readonly now:()=>Date;private readonly windowSec:number;private readonly maxBytes:number;private readonly maxEvents:number;
  private readonly pageSize:number;
  private closed=false;private error?:string;private rejected=0;private nextPrune=0;
  constructor(private readonly database:string,options:SourceCorroborationOptions={}){
    this.now=options.now??(()=>new Date());this.windowSec=windowSeconds(options.windowSec);this.maxBytes=options.maxBytes??256*1024*1024;
    this.maxEvents=options.maxEvents===undefined?DEFAULT_MAX_EVENTS:options.maxEvents;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1024*1024||!Number.isSafeInteger(this.maxEvents)||this.maxEvents<1||this.maxEvents>1000000)
      throw new Error('SOURCE_LEDGER_CONFIG_INVALID');
    if(database!==':memory:')mkdirSync(dirname(database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(database);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1500; PRAGMA wal_autocheckpoint=128; PRAGMA journal_size_limit=4194304;
      CREATE TABLE IF NOT EXISTS source_notifications (
        source TEXT NOT NULL,event_id TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,
        occurred_at TEXT NOT NULL,first_observed_at TEXT NOT NULL,recorded_at TEXT NOT NULL,
        last_delivery_at TEXT NOT NULL,last_recorded_at TEXT NOT NULL,delivery_count INTEGER NOT NULL,
        conflict_at TEXT,name TEXT,source_url TEXT,tx_refs TEXT NOT NULL,
        PRIMARY KEY(source,event_id));
      CREATE INDEX IF NOT EXISTS source_notifications_token ON source_notifications(chain,address,source,first_observed_at DESC,event_id DESC);
      CREATE INDEX IF NOT EXISTS source_notifications_recorded ON source_notifications(recorded_at);
      CREATE INDEX IF NOT EXISTS source_notifications_history ON source_notifications(chain,address,recorded_at DESC,source,event_id);
      CREATE INDEX IF NOT EXISTS source_notifications_first_observed ON source_notifications(first_observed_at DESC);
      CREATE TABLE IF NOT EXISTS source_corroboration_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO source_corroboration_meta VALUES('pruned_events','0');`);
    this.initializeStatusMetadata();
    this.pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    this.db.exec(`PRAGMA max_page_count=${Math.floor(this.maxBytes/this.pageSize)}`);
    if(database!==':memory:')chmodSync(database,0o600);
    this.prune();
  }
  record(signal:Signal,receivedAt=this.now().toISOString(),metadata:SourceCorroborationMetadata={}):{accepted:boolean;duplicate?:boolean;reason?:string}{
    const reject=(reason:string)=>{this.rejected++;return {accepted:false,reason};};
    if(this.closed)return reject('SOURCE_LEDGER_CLOSED');
    const token=normalizedToken(signal?.token),source=signal?.source as CorroborationSource,now=this.now().getTime(),received=millis(receivedAt),occurred=millis(signal?.occurredAt);
    if(!token||!SOURCES.includes(source)||!eventId(signal?.sourceEventId)||!Number.isFinite(now)||!Number.isFinite(received)||
      !Number.isFinite(occurred)||received>now)return reject('SOURCE_NOTIFICATION_INVALID');
    if(received<now-RETENTION_MS)return reject('SOURCE_NOTIFICATION_OUTSIDE_RETENTION');
    try {
      this.prune();
      this.db.exec('SAVEPOINT source_notification_record');
      try {
        const prior=this.db.prepare('SELECT * FROM source_notifications WHERE source=? AND event_id=?').get(source,signal.sourceEventId);
        if(prior){
          if(prior.chain!==token.chain||prior.address!==token.address){this.db.exec('RELEASE source_notification_record');return reject('SOURCE_EVENT_ID_CONFLICT');}
          if(received<millis(prior.first_observed_at)||now<millis(prior.last_recorded_at)){
            this.db.exec('RELEASE source_notification_record');return reject('SOURCE_DELIVERY_TIME_REGRESSION');
          }
          this.db.prepare(`UPDATE source_notifications SET delivery_count=MIN(delivery_count+1,9007199254740991),
            last_delivery_at=MAX(last_delivery_at,?),last_recorded_at=?,conflict_at=CASE WHEN occurred_at!=? THEN COALESCE(conflict_at,?) ELSE conflict_at END
            WHERE source=? AND event_id=?`).run(iso(received),iso(now),iso(occurred),iso(now),source,signal.sourceEventId);
          this.db.exec('RELEASE source_notification_record');
          // Updating an existing row does not prove there is capacity for a new event.
          if(this.error!=='SOURCE_LEDGER_CAPACITY_REACHED')this.error=undefined;
          return {accepted:true,duplicate:true};
        }
        if(this.metaNumber(STATUS_META_KEYS.events)>=this.maxEvents){
          this.db.exec('RELEASE source_notification_record');this.error='SOURCE_LEDGER_CAPACITY_REACHED';return reject(this.error);
        }
        const refs=references(metadata.txRefs,token);
        this.db.prepare('INSERT INTO source_notifications VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)').run(source,signal.sourceEventId,token.chain,token.address,
          iso(occurred),iso(received),iso(now),iso(received),iso(now),1,tokenDisplayText(metadata.name,100)??null,
          publicUrl(metadata.sourceUrl,source)??null,JSON.stringify(refs));
        this.db.exec('RELEASE source_notification_record');this.error=undefined;return {accepted:true,duplicate:false};
      }catch(error){
        // SQLITE_FULL may already have rolled the transaction back; preserve the original failure code.
        try{this.db.exec('ROLLBACK TO source_notification_record; RELEASE source_notification_record');}catch {/* Already rolled back. */}
        throw error;
      }
    }catch(error){
      this.error=error instanceof Error&&/database or disk is full/i.test(error.message)?'SOURCE_LEDGER_CAPACITY_REACHED':'SOURCE_LEDGER_WRITE_FAILED';
      return reject(this.error);
    }
  }
  private decode(row:Row):SourceNotificationEvidence {
    return {source:row.source,eventId:row.event_id,token:{chain:row.chain,address:row.address},occurredAt:row.occurred_at,
      firstObservedAt:row.first_observed_at,recordedAt:row.recorded_at,lastDeliveryAt:row.last_delivery_at,lastRecordedAt:row.last_recorded_at,
      deliveryCount:Number(row.delivery_count),conflictAt:row.conflict_at??undefined,name:row.name??undefined,
      sourceUrl:row.source_url??undefined,txRefs:JSON.parse(row.tx_refs)};
  }
  assess(value:Token,now=this.now()):SourceCorroborationAssessment {
    if(this.closed)throw new Error('SOURCE_LEDGER_CLOSED');
    const token=normalizedToken(value),at=now.getTime();
    if(!token||!Number.isFinite(at)||at>this.now().getTime())throw new Error('SOURCE_ASSESSMENT_INVALID');
    const end=iso(at),start=iso(at-this.windowSec*1000),retention=iso(this.now().getTime()-RETENTION_MS);
    const observations:SourceNotificationEvidence[]=[],notificationCounts:Partial<Record<CorroborationSource,number>>={};let truncated=false;
    for(const source of SOURCES){
      // Prefer fresh candidates before limiting reference comparisons. A burst of stale/future copies cannot hide a fresh source.
      const rows=this.db.prepare(`SELECT * FROM source_notifications WHERE chain=? AND address=? AND source=? AND recorded_at<=? AND recorded_at>=?
        ORDER BY CASE WHEN occurred_at>=? AND occurred_at<=? AND first_observed_at>=? AND occurred_at<=first_observed_at
          AND (conflict_at IS NULL OR conflict_at>?) THEN 0 ELSE 1 END,first_observed_at DESC,event_id DESC LIMIT ?`)
        .all(token.chain,token.address,source,end,retention,start,end,start,end,ASSESS_EVENTS_PER_SOURCE+1);
      truncated=truncated||rows.length>ASSESS_EVENTS_PER_SOURCE;
      observations.push(...rows.slice(0,ASSESS_EVENTS_PER_SOURCE).map(row=>this.decode(row)));
      notificationCounts[source]=Number(this.db.prepare(`SELECT count(*) AS n FROM source_notifications WHERE chain=? AND address=? AND source=?
        AND first_observed_at>=? AND first_observed_at<=? AND recorded_at<=? AND recorded_at>=?`)
        .get(token.chain,token.address,source,start,end,end,retention)!.n);
    }
    return {...assessSourceCorroboration({token,now,windowSec:this.windowSec,observations,notificationCounts,truncated}),
      activity:this.activity(token,at,retention,truncated)};
  }
  private activity(token:Token,at:number,retainedFrom:string,referenceSampleTruncated:boolean):SourceNotificationActivity {
    const end=iso(at),minute=iso(at-60000),five=iso(at-300000),ten=iso(at-600000);
    const sources=SOURCES.map(source=>{
      // The existing index bounds this query to one chain, full CA, source and ten minutes of first arrivals.
      // Bucket by immutable event time: later delivery/recording cannot move an event into a newer bucket.
      // Every eligible event has first_observed_at >= occurred_at, so this arrival range covers all buckets.
      const row=this.db.prepare(`SELECT
        COALESCE(sum(CASE WHEN occurred_at>? THEN 1 ELSE 0 END),0) AS last_1m,
        COALESCE(sum(CASE WHEN occurred_at>? THEN 1 ELSE 0 END),0) AS last_5m,
        COALESCE(sum(CASE WHEN occurred_at<=? THEN 1 ELSE 0 END),0) AS previous_5m
        FROM source_notifications INDEXED BY source_notifications_token
        WHERE chain=? AND address=? AND source=? AND first_observed_at>? AND first_observed_at<=?
          AND occurred_at>? AND occurred_at<=first_observed_at
          AND occurred_at>=strftime('%Y-%m-%dT%H:%M:%fZ',first_observed_at,'-120 seconds')
          AND recorded_at<=? AND recorded_at>=? AND (conflict_at IS NULL OR conflict_at>?)`)
        .get(minute,five,five,token.chain,token.address,source,ten,end,ten,end,retainedFrom,end)!;
      const last1m=Number(row.last_1m),last5m=Number(row.last_5m),previous5m=Number(row.previous_5m);
      return {source,last1m,last5m,previous5m,change5m:last5m-previous5m};
    });
    return {asOf:end,scope:'retained_valid_provider_events',counting:'exact_retained_events',bucketBy:'occurredAt',maxArrivalDelaySec:120,
      windows:{last1m:{startExclusive:minute,endInclusive:end},last5m:{startExclusive:five,endInclusive:end},
        previous5m:{startExclusive:ten,endInclusive:five}},sources,historyComplete:false,retainedFrom,referenceSampleTruncated,
      limitations:['RETAINED_NOTIFICATIONS_ONLY','OBSERVED_STREAM_SAMPLE_NOT_FULL_PROVIDER_HISTORY',
        'EVENT_IDS_NOT_INDEPENDENT_WALLETS_OR_TRADES','ZERO_COUNT_DOES_NOT_PROVE_SOURCE_INACTIVE',
        'COLLECTION_GAPS_UNKNOWN','SOURCE_COUNT_DOES_NOT_CHANGE_SCORE',
        ...(ten<retainedFrom?['ACTIVITY_WINDOW_OUTSIDE_RETENTION']:[]),
        ...(referenceSampleTruncated?['REFERENCE_SAMPLE_LIMIT_DOES_NOT_TRUNCATE_ACTIVITY_COUNTS']:[])]};
  }
  history(value:Token,options:{limit?:number;offset?:number;asOf?:string}={}){
    if(this.closed)throw new Error('SOURCE_LEDGER_CLOSED');
    const token=normalizedToken(value),limit=options.limit??20,offset=options.offset??0,now=this.now().getTime(),asOf=options.asOf??iso(now),at=millis(asOf);
    if(!token||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000||
      !Number.isFinite(at)||iso(at)!==asOf||at>now)throw new Error('INVALID_FILTER');
    const earliest=iso(now-RETENTION_MS),where='chain=? AND address=? AND recorded_at<=? AND recorded_at>=?',args=[token.chain,token.address,asOf,earliest];
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM source_notifications WHERE ${where}`).get(...args)!.n);
    const rows=this.db.prepare(`SELECT * FROM source_notifications WHERE ${where} ORDER BY recorded_at DESC,source,event_id LIMIT ? OFFSET ?`).all(...args,limit,offset);
    const items=rows.map(row=>{
      const value=this.decode(row),current=millis(value.lastRecordedAt)<=at;
      return {source:value.source,eventId:value.eventId,occurredAt:value.occurredAt,firstObservedAt:value.firstObservedAt,recordedAt:value.recordedAt,
        status:freshness(value,at,this.windowSec*1000),...(current?{lastDeliveryAt:value.lastDeliveryAt}:{}),
        deliveryCount:current?value.deliveryCount:null,name:value.name,sourceUrl:value.sourceUrl,txRefs:value.txRefs,
        ...(value.conflictAt&&millis(value.conflictAt)<=at?{conflictAt:value.conflictAt}:{})};
    });
    return {token,asOf,total,limit,offset,hasMore:offset+items.length<total,items,retentionDays:RETENTION_DAYS,maxEvents:this.maxEvents,
      retainedFrom:earliest,scope:'source_notifications_not_independent_wallets' as const,
      limitations:['RETAINED_NOTIFICATIONS_ONLY','FIRST_NOTIFICATION_METADATA_FROZEN',
        ...(items.some(item=>item.deliveryCount===null)?['HISTORICAL_DELIVERY_COUNT_UNKNOWN']:[])]};
  }
  status(){
    if(this.closed)return {enabled:false,closed:true,researchOnly:true,error:'SOURCE_LEDGER_CLOSED'};
    const rows=this.db.prepare(`SELECT key,value FROM source_corroboration_meta WHERE key IN (?,?,?,?,?)`).all(
      STATUS_META_KEYS.events,STATUS_META_KEYS.deliveries,STATUS_META_KEYS.latest,'pruned_events',STATUS_META_KEYS.version);
    const meta=new Map(rows.map(row=>[String(row.key),String(row.value)]));
    const pages=Number(this.db.prepare('PRAGMA page_count').get()!.page_count),latest=meta.get(STATUS_META_KEYS.latest);
    return {enabled:true,researchOnly:true,scoreEffect:0,windowSec:this.windowSec,
      events:Number(meta.get(STATUS_META_KEYS.events)),deliveries:Number(meta.get(STATUS_META_KEYS.deliveries)),
      latestObservedAt:latest||undefined,retentionDays:RETENTION_DAYS,maxEvents:this.maxEvents,maxBytes:this.maxBytes,bytes:pages*this.pageSize,
      prunedEvents:Number(meta.get('pruned_events')),
      rejected:this.rejected,error:this.error,scope:'source_notifications_not_independent_wallets'};
  }
  private metaNumber(key:string):number {
    return Number(this.db.prepare('SELECT value FROM source_corroboration_meta WHERE key=?').get(key)!.value);
  }
  /**
   * Backfill old databases once during schema migration. Dashboard/status reads
   * never aggregate the notification table; all later changes maintain these
   * rows in the same transaction as the notification mutation.
   */
  private initializeStatusMetadata():void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version=this.db.prepare('SELECT value FROM source_corroboration_meta WHERE key=?').get(STATUS_META_KEYS.version)?.value;
      if(version!==STATUS_META_VERSION){
        const row=this.db.prepare(`SELECT count(*) AS events,COALESCE(sum(delivery_count),0) AS deliveries,
          COALESCE(max(first_observed_at),'') AS latest FROM source_notifications`).get()!;
        const upsert=this.db.prepare('INSERT OR REPLACE INTO source_corroboration_meta(key,value) VALUES(?,?)');
        upsert.run(STATUS_META_KEYS.events,String(row.events));
        upsert.run(STATUS_META_KEYS.deliveries,String(row.deliveries));
        upsert.run(STATUS_META_KEYS.latest,String(row.latest));
        upsert.run(STATUS_META_KEYS.version,STATUS_META_VERSION);
      }
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS source_notifications_status_insert AFTER INSERT ON source_notifications BEGIN
          UPDATE source_corroboration_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='${STATUS_META_KEYS.events}';
          UPDATE source_corroboration_meta SET value=CAST(CAST(value AS INTEGER)+NEW.delivery_count AS TEXT) WHERE key='${STATUS_META_KEYS.deliveries}';
          UPDATE source_corroboration_meta SET value=CASE WHEN value='' OR NEW.first_observed_at>value THEN NEW.first_observed_at ELSE value END
            WHERE key='${STATUS_META_KEYS.latest}';
        END;
        CREATE TRIGGER IF NOT EXISTS source_notifications_status_update AFTER UPDATE OF delivery_count,first_observed_at ON source_notifications BEGIN
          UPDATE source_corroboration_meta SET value=CAST(MAX(0,CAST(value AS INTEGER)+NEW.delivery_count-OLD.delivery_count) AS TEXT)
            WHERE key='${STATUS_META_KEYS.deliveries}';
          UPDATE source_corroboration_meta SET value=CASE
            WHEN NEW.first_observed_at>=value THEN NEW.first_observed_at
            WHEN OLD.first_observed_at=value THEN COALESCE((SELECT max(first_observed_at) FROM source_notifications),'')
            ELSE value END WHERE key='${STATUS_META_KEYS.latest}';
        END;
        CREATE TRIGGER IF NOT EXISTS source_notifications_status_delete AFTER DELETE ON source_notifications BEGIN
          UPDATE source_corroboration_meta SET value=CAST(MAX(0,CAST(value AS INTEGER)-1) AS TEXT) WHERE key='${STATUS_META_KEYS.events}';
          UPDATE source_corroboration_meta SET value=CAST(MAX(0,CAST(value AS INTEGER)-OLD.delivery_count) AS TEXT)
            WHERE key='${STATUS_META_KEYS.deliveries}';
          UPDATE source_corroboration_meta SET value=CASE WHEN OLD.first_observed_at=value
            THEN COALESCE((SELECT max(first_observed_at) FROM source_notifications),'') ELSE value END WHERE key='${STATUS_META_KEYS.latest}';
        END;`);
      this.db.exec('COMMIT');
    }catch(error){
      try{this.db.exec('ROLLBACK');}catch{/* Already rolled back. */}
      throw error;
    }
  }
  private prune():void {
    const now=this.now().getTime();if(!Number.isFinite(now))throw new Error('SOURCE_LEDGER_CLOCK_INVALID');if(now<this.nextPrune)return;
    this.db.exec('SAVEPOINT source_notification_prune');
    try {
      const result=this.db.prepare('DELETE FROM source_notifications WHERE recorded_at<?').run(iso(now-RETENTION_MS));
      if(result.changes)this.db.prepare("UPDATE source_corroboration_meta SET value=CAST(value AS INTEGER)+? WHERE key='pruned_events'").run(Number(result.changes));
      this.db.exec('RELEASE source_notification_prune');this.nextPrune=now+60000;
    }catch(error){
      try{this.db.exec('ROLLBACK TO source_notification_prune; RELEASE source_notification_prune');}catch {/* Already rolled back. */}
      throw error;
    }
  }
  close():void {if(this.closed)return;this.closed=true;this.db.close();}
}
