import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import {PROCESSING_LEASE_MS,type Stored} from './store.js';
import type {Chain,Report,Signal,Status,Narrative} from './types.js';
import type {WalletAnalysis} from './research/wallet-types.js';

export interface ScanToken {chain:Chain;address:string;}
export interface ScanCheck {status:Status;reasons:string[];}
export interface ScanPricePoint {at:string;priceUsd:number;}
export interface ScanObservation {
  state:'scheduled'|'processing'|'ended';firstReceivedAt:string;endsAt:string;
  nextCheckAt?:string;lastCheckAt?:string;attempts:number;endReason?:string;
}
export interface WatchOptions {windowSec:number;intervalSec:number;maxSignalAgeSec:number;}
export interface WatchClaim {id:string;claimId:string;signal:Signal;receivedAt:string;endsAt:string;attempts:number;}
export interface WatchQueueStatus {scheduled:number;processing:number;ended:number;due:number;nextCheckAt?:string;}
export interface ScanPerformance {
  eligibleAt:string;
  baselineAt?:string;baselinePriceUsd?:number;
  latestPriceUsd?:number;latestAt?:string;peakPriceUsd?:number;peakAt?:string;
  maxGainPct?:number;currentGainPct?:number;samples:number;source?:string;
  status:'waiting'|'tracking'|'ended'|'unavailable';error?:string;
  errorCount?:number;lastErrorAt?:string;lastError?:string;maxSampleGapSec?:number;points:ScanPricePoint[];
}
type WalletCountKey='uniqueWalletCount'|'enrichedWalletCount'|'currentHolderCount'|'smartCurrentHolderCount'|
  'smartFundingClusterCount'|'eligibleSmartWalletCount'|'qualifiedSmartWalletCount'|
  'qualifiedSmartFundingClusterCount'|'recentWindowSeconds'|'cumulativeCoverageWalletCount';
export type ScanWalletSummary=Partial<Record<WalletCountKey,number>>&{
  recentNetBuyUsd?:string|null;hasRecentAccumulation?:boolean|null;sampledHoldingRatio?:number|null;
  cumulativeBuyUsd?:string|null;cumulativeSellUsd?:string|null;
};
export interface ScanWalletGroup {
  id:string;walletCount:number;smartCurrentHolders:number;developerLinked:boolean;basis:string[];wallets:string[];
}
export interface ScanWalletProfile {
  address:string;labels:string[];vendorName?:string;vendorTwitter?:string;vendorVerification:'vendor_claim';
  attribution:{status:'unknown'|'operator_supplied';label?:string;category?:'exchange'|'public_entity'|'operator_defined'|'unknown';verification:'unverified'};
  funding:{address?:string;label?:string;source?:'native_transfer'|'wallet_stats'|'both'|'unknown';
    sharedService:boolean;conflict:boolean;verification:'vendor_claim'};
  risks:string[];
}
export interface ScanRecord extends ScanToken {
  id:string;source:'debot'|'gmgn'|'manual';status:Stored['status'];mode?:Report['mode'];
  receivedAt:string;occurredAt:string;evaluatedAt?:string;decision?:Report['decision'];buyEligible?:boolean;validUntil?:string;
  name?:string;symbol?:string;reasons:string[];advisoryReasons?:string[];
  checks:{provenance:ScanCheck;safety:ScanCheck;narrative:ScanCheck;wallets:ScanCheck;flow:ScanCheck};
  narrative?:{thesis?:string;stage?:Narrative['stage'];assessment?:Narrative['assessment'];supplier?:'gmgn'|'debot';sourceUrl?:string;
    text?:string;textTruncated?:boolean;updatedAt?:string;retained?:boolean};
  social?:Report['social'];
  wallets?:{sampleOnly:true;smartIndependenceProven:false;summary:ScanWalletSummary;groups:ScanWalletGroup[];profiles?:ScanWalletProfile[]};
  performance?:ScanPerformance;
  observation?:ScanObservation;
}
export interface ScanArchiveOptions {retentionDays?:number;maxEntries?:number;trackingHours?:number;now?:()=>Date;}
export interface ScanListOptions {limit?:number;offset?:number;chain?:Chain;decision?:Report['decision'];search?:string;eligible?:boolean;}
export interface ScanArchiveStats {
  total:number;eligible:number;tracking:number;maxGainPct?:number;
  byStatus:Record<Stored['status'],number>;byDecision:Record<Report['decision']|'PENDING',number>;
}
export interface ScanPrice extends ScanToken {priceUsd:number;observedAt:string;source:string;}

const MAX_POINTS=256;
interface WatchRow {
  id:string;chain:Chain;address:string;state:ScanObservation['state'];first_received_at:string;occurred_at:string;
  ends_at:string;next_check_at:string|null;last_check_at:string|null;attempts:number;end_reason:string|null;
  claim_id:string|null;lease_until:string|null;signal:string|null;expiry_reason:string;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,limit:number):string|undefined=>typeof v==='string'
  ?v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,limit)||undefined:undefined;
const reasonCodes=(v:unknown,limit=16):string[]=>Array.isArray(v)
  ?[...new Set(v.filter((s):s is string=>typeof s==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(s)))].slice(0,limit):[];
function timestamp(v:unknown):string|undefined {
  if(typeof v!=='string'||v.length>40||!/^\d{4}-\d{2}-\d{2}T/.test(v)||!Number.isFinite(Date.parse(v))) return;
  return new Date(v).toISOString();
}
function token(value:ScanToken):ScanToken|undefined {
  if(!value||!['bsc','solana','robinhood'].includes(value.chain)||typeof value.address!=='string') return;
  try {
    if(value.chain==='solana') return bs58.decode(value.address).length===32?{chain:value.chain,address:value.address}:undefined;
    if(/^0x[0-9a-fA-F]{40}$/.test(value.address)) return {chain:value.chain,address:value.address.toLowerCase()};
  } catch { /* Malformed input cannot become a partial token identity. */ }
}
/** Retain only public identifiers needed to repeat the original investigation. */
function watchSignal(signal:Signal):Signal|undefined {
  const identity=token(signal.token),occurredAt=timestamp(signal.occurredAt);
  if(!identity||!occurredAt||!['debot','gmgn','manual'].includes(signal.source)||
    !/^[A-Za-z0-9:_-]{1,160}$/.test(signal.sourceEventId)) return;
  const evidenceUrls:string[]=[];
  for(const value of signal.evidenceUrls??[]) {
    try {
      const url=new URL(value);
      if(url.protocol!=='https:'||url.username||url.password||url.port||
        !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)) continue;
      const match=url.pathname.match(/^\/(?:[A-Za-z0-9_]{1,30}|i\/web)\/status\/(\d{1,20})\/?$/);
      if(match) evidenceUrls.push(`https://x.com/i/web/status/${match[1]}`);
    } catch { /* Arbitrary URLs and copied credentials are never durable inputs. */ }
  }
  const result:Signal={source:signal.source,sourceEventId:signal.sourceEventId,occurredAt,token:identity,text:'',
    evidenceUrls:[...new Set(evidenceUrls)].slice(0,12),claim:['community','official','unspecified'].includes(signal.claim)?signal.claim:'unspecified'};
  if(signal.claimedPlatform&&['pump','bonk','four','flap'].includes(signal.claimedPlatform))result.claimedPlatform=signal.claimedPlatform;
  if(signal.creationTx&&(/^0x[0-9a-fA-F]{64}$/.test(signal.creationTx)||/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signal.creationTx)))
    result.creationTx=signal.creationTx;
  if(signal.platformState&&token({chain:identity.chain,address:signal.platformState}))result.platformState=signal.platformState;
  return result;
}
function compactCheck(value:unknown):ScanCheck {
  return object(value)?{status:['pass','fail','unknown'].includes(String(value.status))?value.status as Status:'unknown',
    reasons:reasonCodes(value.reasons)}:{status:'unknown',reasons:[]};
}
function sourceUrl(value:unknown,provider:string):string|undefined {
  if(typeof value!=='string'||value.length>2_000) return;
  try {
    const url=new URL(value),domain=provider==='gmgn'?'gmgn.ai':provider==='debot'?'debot.ai':undefined;
    if(url.protocol!=='https:'||url.username||url.password||url.port||!domain||![domain,`www.${domain}`].includes(url.hostname)) return;
    // Query strings may contain credentials or copied session material. The compact
    // archive keeps only the public origin/path; it is not a raw source archive.
    url.search='';url.hash='';return url.toString().length<=500?url.toString():undefined;
  } catch {return;}
}
function compactSocial(value:Report['social']):Report['social'] {
  if(!object(value)||value.scope!=='research_priority'||!Array.isArray(value.signals))return;
  const signals:NonNullable<Report['social']>['signals']=[];
  const seen=new Set<string>();
  for(const item of value.signals.slice(0,12)) {
    if(!object(item)||!['profile_link','ca_post'].includes(String(item.kind))||
      !['project_link','first_party','third_party'].includes(String(item.verification)))continue;
    const person=text(item.person,80),label=text(item.label,80);if(!person||seen.has(person))continue;
    let url:URL;
    try {url=new URL(String(item.sourceUrl));if(url.protocol!=='https:'||url.username||url.password||url.port||
      !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)||url.pathname.length>200)continue;
      url.search='';url.hash='';}catch{continue;}
    const weight=Number(item.weight);if(weight!==(item.kind==='profile_link'?5:20))continue;
    seen.add(person);signals.push({person,...(label?{label}:{}),kind:item.kind as 'profile_link'|'ca_post',weight,sourceUrl:url.toString(),
      verification:item.verification as 'project_link'|'first_party'|'third_party',
      ...(typeof item.evidenceId==='string'&&/^x:\d{1,20}$/.test(item.evidenceId)?{evidenceId:item.evidenceId}:{})});
  }
  const profileScore=Math.min(10,signals.filter(item=>item.kind==='profile_link').reduce((sum,item)=>sum+item.weight,0));
  const postScore=signals.filter(item=>item.kind==='ca_post').reduce((sum,item)=>sum+item.weight,0);
  return {score:Math.min(30,profileScore+postScore),scope:'research_priority',signals,endorsementVerified:false};
}
function compactWallets(value:WalletAnalysis|undefined,chain:Chain):ScanRecord['wallets'] {
  if(!value||!object(value.summary)||!Array.isArray(value.clusters)) return;
  const summary:ScanWalletSummary={};
  const counts:WalletCountKey[]=['uniqueWalletCount','enrichedWalletCount','currentHolderCount','smartCurrentHolderCount',
    'smartFundingClusterCount','eligibleSmartWalletCount','qualifiedSmartWalletCount','qualifiedSmartFundingClusterCount',
    'recentWindowSeconds','cumulativeCoverageWalletCount'];
  for(const key of counts) {
    const n=value.summary[key];if(Number.isSafeInteger(n)&&n>=0) summary[key]=n;
  }
  for(const key of ['recentNetBuyUsd','cumulativeBuyUsd','cumulativeSellUsd'] as const) {
    const n=value.summary[key];
    if(n===null||typeof n==='string'&&n.length<=80&&/^-?(0|[1-9]\d*)(\.\d+)?$/.test(n)) summary[key]=n;
  }
  const ratio=value.summary.sampledHoldingRatio,accumulation=value.summary.hasRecentAccumulation;
  if(ratio===null||typeof ratio==='number'&&Number.isFinite(ratio)&&ratio>=0&&ratio<=1) summary.sampledHoldingRatio=ratio;
  if(accumulation===null||typeof accumulation==='boolean') summary.hasRecentAccumulation=accumulation;
  const groups:ScanWalletGroup[]=value.clusters.slice(0,12).flatMap(group=>{
    if(!object(group)||group.chain!==chain||!Array.isArray(group.wallets)||!Array.isArray(group.basis)||
      !Number.isSafeInteger(group.smartCurrentHolders)||group.smartCurrentHolders<0||typeof group.developerLinked!=='boolean') return [];
    const id=text(group.id,100);if(!id) return [];
    return [{id,walletCount:group.wallets.length,smartCurrentHolders:group.smartCurrentHolders,developerLinked:group.developerLinked,
      basis:group.basis.filter(v=>['shared_funding','funding_link','operator_entity','single_wallet'].includes(v)).slice(0,4),
      wallets:[...new Set(group.wallets.flatMap(address=>token({chain,address})?.address??[]))].slice(0,8)}];
  });
  const profiles:ScanWalletProfile[]=[],seen=new Set<string>();
  for(const wallet of Array.isArray(value.wallets)?value.wallets:[]) {
    if(profiles.length>=12) break;
    if(!object(wallet)||wallet.chain!==chain) continue;
    const address=token({chain,address:wallet.address})?.address;
    if(!address||seen.has(address)) continue;
    seen.add(address);
    const attribution:ScanWalletProfile['attribution']={status:'unknown',verification:'unverified'};
    const identity=wallet.attribution?.identity;
    if(wallet.attribution?.status==='operator_supplied'&&identity?.chain===chain&&
      token({chain,address:identity.address})?.address===address) {
      attribution.status='operator_supplied';attribution.label=text(identity.label,100);
      if(['exchange','public_entity','operator_defined','unknown'].includes(identity.category)) attribution.category=identity.category;
    }
    const funding=wallet.funding;
    const fundingAddress=funding&&typeof funding.address==='string'?token({chain,address:funding.address})?.address:undefined;
    const twitter=text(wallet.vendorIdentity?.twitterUsername,100)?.replace(/^@/,'');
    profiles.push({address,
      labels:[...new Set((Array.isArray(wallet.recognizedLabels)?wallet.recognizedLabels:[])
        .filter(label=>['smart','kol','bundler','rat_trader','developer','exchange_or_pool'].includes(label)))].slice(0,6),
      vendorName:text(wallet.vendorIdentity?.name,100),
      vendorTwitter:twitter&&/^[A-Za-z0-9_]{1,100}$/.test(twitter)?twitter:undefined,vendorVerification:'vendor_claim',attribution,
      funding:{address:fundingAddress,label:fundingAddress?text(funding?.label,100):undefined,
        source:funding&&['native_transfer','wallet_stats','both','unknown'].includes(funding.source)?funding.source:undefined,
        sharedService:funding?.sharedService===true,conflict:funding?.conflict===true,verification:'vendor_claim'},
      risks:reasonCodes(wallet.risks,12)});
  }
  return {sampleOnly:true,smartIndependenceProven:false,summary,groups,profiles};
}
function thinPoints(points:ScanPricePoint[],peakAt:string):ScanPricePoint[] {
  if(points.length<=MAX_POINTS) return points;
  // Downsample actual observations only, preserving first baseline, global peak,
  // and last point. Neither interpolation nor a historical high is introduced.
  return points.filter((point,index)=>index===0||index===points.length-1||index%2===0||point.at===peakAt);
}

/** Bounded research history and retry scheduling; execution still requires its own entry guards. */
export class ScanArchive {
  private readonly db:DatabaseSync;
  private readonly now:()=>Date;
  private readonly retentionDays:number;
  private readonly maxEntries:number;
  private readonly trackingMs:number;
  private watch?:WatchOptions;
  constructor(path:string,options:ScanArchiveOptions={}) {
    this.retentionDays=options.retentionDays??30;this.maxEntries=options.maxEntries??10_000;
    const hours=options.trackingHours??24;
    if(!Number.isFinite(this.retentionDays)||this.retentionDays<=0||this.retentionDays>365||
      !Number.isSafeInteger(this.maxEntries)||this.maxEntries<1||this.maxEntries>100_000||
      !Number.isFinite(hours)||hours<=0||hours>168) throw new Error('SCAN_ARCHIVE_CONFIG_INVALID');
    this.trackingMs=hours*3_600_000;this.now=options.now??(()=>new Date());
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:') chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scan_summaries (
        id TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,status TEXT NOT NULL,
        received_at TEXT NOT NULL,decision TEXT,eligible_at TEXT,last_price_attempt_at TEXT,lease_expires_at TEXT,
        performance_status TEXT,max_gain_pct REAL,record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scan_summaries_token ON scan_summaries(chain,address);
      CREATE INDEX IF NOT EXISTS scan_summaries_received ON scan_summaries(received_at);
      CREATE INDEX IF NOT EXISTS scan_summaries_eligible ON scan_summaries(eligible_at);
      CREATE TABLE IF NOT EXISTS watch_jobs (
        id TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,state TEXT NOT NULL,
        first_received_at TEXT NOT NULL,occurred_at TEXT NOT NULL,ends_at TEXT NOT NULL,
        next_check_at TEXT,last_check_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,end_reason TEXT,
        claim_id TEXT,lease_until TEXT,signal TEXT,expiry_reason TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS watch_one_active_token ON watch_jobs(chain,address) WHERE state<>'ended';
      CREATE INDEX IF NOT EXISTS watch_jobs_due ON watch_jobs(state,next_check_at);
      CREATE TABLE IF NOT EXISTS watch_heads (chain TEXT NOT NULL,address TEXT NOT NULL,id TEXT NOT NULL,
        received_at TEXT NOT NULL,occurred_at TEXT NOT NULL,PRIMARY KEY(chain,address));`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns=this.db.prepare('PRAGMA table_info(scan_summaries)').all();
      if(!this.db.prepare('PRAGMA table_info(watch_heads)').all().some(column=>column.name==='occurred_at'))
        this.db.exec("ALTER TABLE watch_heads ADD COLUMN occurred_at TEXT; UPDATE watch_heads SET occurred_at=(SELECT json_extract(record,'$.occurredAt') FROM scan_summaries WHERE id=watch_heads.id)");
      if(!columns.some(column=>column.name==='lease_expires_at')) this.db.exec('ALTER TABLE scan_summaries ADD COLUMN lease_expires_at TEXT');
      if(!columns.some(column=>column.name==='performance_status')) {
        this.db.exec("ALTER TABLE scan_summaries ADD COLUMN performance_status TEXT; UPDATE scan_summaries SET performance_status=json_extract(record,'$.performance.status')");
      }
      if(!columns.some(column=>column.name==='max_gain_pct')) {
        this.db.exec("ALTER TABLE scan_summaries ADD COLUMN max_gain_pct REAL; UPDATE scan_summaries SET max_gain_pct=json_extract(record,'$.performance.maxGainPct')");
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');this.db.close();throw error;}
    this.prune();
  }

  capture(entry:Stored):void {this.captureRecord(entry);}

  private captureRecord(entry:Stored,insideTransaction=false):void {
    const identity=token(entry?.signal?.token),received=timestamp(entry?.receivedAt),occurred=timestamp(entry?.signal?.occurredAt);
    if(!identity||!received||!occurred||typeof entry.id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(entry.id)||
      !['processing','completed','interrupted'].includes(entry.status)||!['debot','gmgn','manual'].includes(entry.signal.source)) return;
    const current=this.now(),nowMs=current.getTime();if(!Number.isFinite(nowMs)) return;
    if(!insideTransaction)this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.read(entry.id);
      if(previous&&(previous.chain!==identity.chain||previous.address!==identity.address||previous.source!==entry.signal.source)) {
        if(!insideTransaction)this.db.exec('COMMIT');return;
      }
      const blank=()=>compactCheck(undefined);
      let result:ScanRecord=previous?{...previous,status:entry.status}:{id:entry.id,...identity,source:entry.signal.source,
        status:entry.status,receivedAt:received,occurredAt:occurred,reasons:[],
        checks:{provenance:blank(),safety:blank(),narrative:blank(),wallets:blank(),flow:blank()}};
      const report=entry.status==='completed'?entry.report:undefined;
      const reportToken=report&&token(report.signal?.token),evaluated=timestamp(report?.evaluatedAt);
      const reportMatches=report&&report.id===entry.id&&reportToken?.chain===identity.chain&&reportToken.address===identity.address;
      if(reportMatches&&evaluated&&Date.parse(evaluated)<=nowMs&&Date.parse(evaluated)>=Date.parse(result.receivedAt)&&
        (!result.evaluatedAt||evaluated>=result.evaluatedAt)) {
        result={...result,mode:report.mode,evaluatedAt:evaluated,decision:report.decision,buyEligible:report.buyEligible===true,
          validUntil:timestamp(report.validUntil),reasons:reasonCodes(report.reasons,24),advisoryReasons:reasonCodes(report.advisoryReasons,24),
          checks:{provenance:compactCheck(report.provenance),safety:compactCheck(report.safety),narrative:compactCheck(report.narrative),
            wallets:compactCheck(report.wallets),flow:compactCheck(report.flow)}};
        const narrative=report.narrative;
        if(narrative) {
          const supplier=narrative.supplier?.provider;
          const mismatch=narrative.reasons.some(reason=>reason==='VENDOR_NARRATIVE_TOKEN_MISMATCH');
          const body=mismatch?undefined:narrative.supplier?.text??narrative.analysis?.thesis;
          const fullText=typeof body==='string'?body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim():undefined;
          result.narrative={thesis:text(narrative.analysis?.thesis,500),stage:narrative.analysis?.stage,
            ...(fullText?{text:fullText.slice(0,12000),textTruncated:fullText.length>12000}:{}),
            updatedAt:timestamp(narrative.supplier?.updatedAt),
            assessment:narrative.analysis?.assessment,...(supplier==='gmgn'||supplier==='debot'?{supplier,
              sourceUrl:sourceUrl(narrative.supplier?.sourceUrl,supplier)}:{})};
          // A transient narrative read failure must not erase a previous public
          // reference for this same immutable chain/CA. Keep its original time.
          if(!fullText&&!mismatch&&previous?.narrative?.text)
            result.narrative={...previous.narrative,retained:true};
        }
        result.social=compactSocial(report.social);
        result.wallets=compactWallets(report.wallets,identity.chain);
        const snapshot=report.gmgn,info=snapshot?.info,snapshotToken=snapshot&&token(snapshot.token);
        const infoToken=object(info)&&typeof info.address==='string'?token({chain:identity.chain,address:info.address}):undefined;
        if(snapshotToken?.chain===identity.chain&&snapshotToken.address===identity.address&&infoToken?.address===identity.address&&object(info)) {
          result.name=text(info.name,100)??result.name;result.symbol=text(info.symbol,32)??result.symbol;
        }
        if(!result.performance&&report.mode==='live'&&report.decision==='BUY_CANDIDATE'&&report.buyEligible===true)
          result.performance={eligibleAt:evaluated,samples:0,status:'waiting',points:[]};
      }
      const lease=entry.status==='processing'?(timestamp(entry.leaseExpiresAt)??
        new Date(Date.parse(result.receivedAt)+PROCESSING_LEASE_MS).toISOString()):null;
      this.write(result,undefined,lease);
      if(this.watch&&!insideTransaction)this.captureWatch(entry,result,!previous,current);
      this.pruneInside(current);
      if(!insideTransaction)this.db.exec('COMMIT');
    } catch(error) {if(!insideTransaction)this.db.exec('ROLLBACK');throw error;}
  }

  /** Called once before new Store observations. Legacy rows cannot invent a source event. */
  configureWatch(options:WatchOptions):void {
    if(![options.windowSec,options.intervalSec,options.maxSignalAgeSec].every(value=>Number.isSafeInteger(value)&&value>0&&value<=86_400))
      throw new Error('WATCH_CONFIG_INVALID');
    this.watch={...options};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const row of this.db.prepare('SELECT record FROM scan_summaries ORDER BY received_at DESC,rowid DESC').all()) {
        const record=JSON.parse(String(row.record)) as ScanRecord;
        this.setWatchHead(record);
        if(record.mode!=='live'||record.decision!=='WATCH'||this.watchRow(record.id))continue;
        const ends=this.watchDeadline(record),endReason=this.futureWatch(record)?'SIGNAL_TIME_IN_FUTURE':
          this.deadlineReason(record.occurredAt,ends,this.now())??'LEGACY_SIGNAL_UNAVAILABLE';
        this.insertWatch(record,undefined,ends,'ended',endReason);
      }
      this.pruneInside(this.now());this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  watchStatus(now=this.now()):WatchQueueStatus {
    this.prune(now);
    const result:WatchQueueStatus={scheduled:0,processing:0,ended:0,due:0};
    for(const row of this.db.prepare('SELECT state,count(*) AS n FROM watch_jobs GROUP BY state').all())
      result[row.state as 'scheduled'|'processing'|'ended']=Number(row.n);
    const due=this.db.prepare("SELECT count(*) AS n,MIN(next_check_at) AS next FROM watch_jobs WHERE state='scheduled' AND next_check_at<=?").get(now.toISOString())!;
    result.due=Number(due.n);
    const next=this.db.prepare("SELECT MIN(next_check_at) AS next FROM watch_jobs WHERE state='scheduled'").get()!.next;
    if(typeof next==='string')result.nextCheckAt=next;
    return result;
  }

  claimWatch(now=this.now()):WatchClaim|undefined {
    if(!this.watch)return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.pruneInside(now);
      // The bounded social boost only orders tasks already due. An older task
      // cannot be starved by a stream of higher-scoring new arrivals.
      const row=this.db.prepare(`SELECT j.* FROM watch_jobs j JOIN scan_summaries s ON s.id=j.id
        JOIN watch_heads h ON h.chain=j.chain AND h.address=j.address AND h.id=j.id
        WHERE j.state='scheduled' AND j.next_check_at<=? AND j.ends_at>? AND j.signal IS NOT NULL
        ORDER BY (julianday(j.next_check_at)*86400000-MIN(30,MAX(0,COALESCE(json_extract(s.record,'$.social.score'),0)))*1000),
        j.next_check_at,j.first_received_at,j.id LIMIT 1`).get(now.toISOString(),now.toISOString()) as unknown as WatchRow|undefined;
      if(!row){this.db.exec('COMMIT');return;}
      const claimId=randomUUID(),lease=new Date(Math.min(now.getTime()+PROCESSING_LEASE_MS,Date.parse(row.ends_at))).toISOString();
      this.db.prepare("UPDATE watch_jobs SET state='processing',claim_id=?,lease_until=?,last_check_at=?,next_check_at=NULL,attempts=attempts+1 WHERE id=?")
        .run(claimId,lease,now.toISOString(),row.id);
      this.db.exec('COMMIT');
      return {id:row.id,claimId,signal:JSON.parse(row.signal!),receivedAt:row.first_received_at,endsAt:row.ends_at,attempts:row.attempts+1};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  finishWatch(id:string,claimId:string,report:Report,now=this.now()):{accepted:boolean;report?:Report} {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.pruneInside(now);
      const row=this.activeWatchClaim(id,claimId,now);
      if(!row){this.db.exec('COMMIT');return {accepted:false};}
      const signal=JSON.parse(row.signal!) as Signal,identity=token(report.signal?.token),evaluated=timestamp(report.evaluatedAt);
      const valid=report.id===id&&report.mode==='live'&&report.receivedAt===row.first_received_at&&
        report.signal.source===signal.source&&report.signal.sourceEventId===signal.sourceEventId&&
        timestamp(report.signal.occurredAt)===signal.occurredAt&&identity?.chain===row.chain&&identity.address===row.address&&
        evaluated!==undefined&&evaluated>=row.last_check_at!&&evaluated<=now.toISOString();
      if(!valid){this.rescheduleWatch(row,'INVALID_RECHECK_REPORT',now);this.db.exec('COMMIT');return {accepted:false};}
      const checked=report.buyEligible&&(!timestamp(report.validUntil)||Date.parse(report.validUntil)<=now.getTime())
        ?{...report,decision:'WATCH' as const,buyEligible:false,reasons:[...report.reasons,'DECISION_EXPIRED']}:report;
      this.captureRecord({id,status:'completed',signal,receivedAt:row.first_received_at,report:checked},true);
      if(checked.decision==='WATCH')this.rescheduleWatch(row,undefined,now);
      else this.endWatch(row.id,checked.decision==='REJECT'?'REJECTED':'BUY_CANDIDATE',false);
      this.db.exec('COMMIT');return {accepted:true,report:checked};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  failWatch(id:string,claimId:string,reason='RECHECK_FAILED',now=this.now()):void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.pruneInside(now);const row=this.activeWatchClaim(id,claimId,now);
      if(row)this.rescheduleWatch(row,reason,now);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  /** Revalidated immediately before the injected entry controller is called. */
  canEnterWatch(id:string,claimId:string,report:Report,now=this.now()):boolean {
    const row=this.watchRow(id);
    return !!row&&row.state==='ended'&&row.end_reason==='BUY_CANDIDATE'&&row.claim_id===claimId&&
      this.isWatchHead(row)&&Date.parse(row.ends_at)>now.getTime()&&report.id===id&&report.mode==='live'&&
      report.decision==='BUY_CANDIDATE'&&report.buyEligible===true&&Date.parse(report.validUntil)>now.getTime();
  }

  list(options:ScanListOptions={}):{items:ScanRecord[];total:number} {
    this.prune();
    const limit=Number.isSafeInteger(options.limit)?Math.max(1,Math.min(200,options.limit!)):50;
    const offset=Number.isSafeInteger(options.offset)?Math.max(0,options.offset!):0;
    const clauses:string[]=[],values:(string|number)[]=[];
    if(options.chain) {clauses.push('chain=?');values.push(options.chain);}
    if(options.decision) {clauses.push('decision=?');values.push(options.decision);}
    if(options.eligible!==undefined) clauses.push(`eligible_at IS ${options.eligible?'NOT ':''}NULL`);
    const search=text(options.search,200)?.toLowerCase();
    if(search) {
      clauses.push("(instr(lower(address),?)>0 OR instr(lower(COALESCE(json_extract(record,'$.name'),'')),?)>0 OR instr(lower(COALESCE(json_extract(record,'$.symbol'),'')),?)>0)");
      values.push(search,search,search);
    }
    const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM scan_summaries ${where}`).get(...values)!.n);
    const rows=this.db.prepare(`SELECT record FROM scan_summaries ${where} ORDER BY received_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...values,limit,offset);
    return {items:rows.map(row=>this.withObservation(JSON.parse(String(row.record)) as ScanRecord)),total};
  }

  get(id:string):ScanRecord|undefined {this.prune();const record=this.read(id);return record&&this.withObservation(record);}

  stats():ScanArchiveStats {
    this.prune();
    const result:ScanArchiveStats={total:0,eligible:0,tracking:0,
      byStatus:{processing:0,completed:0,interrupted:0},byDecision:{BUY_CANDIDATE:0,WATCH:0,REJECT:0,PENDING:0}};
    // Aggregate scalar columns; dashboard polling must not deserialize every
    // historical sparkline just to count records or find the largest sampled gain.
    const aggregate=this.db.prepare(`SELECT count(*) AS total,SUM(eligible_at IS NOT NULL) AS eligible,
      SUM(eligible_at IS NOT NULL AND performance_status<>'ended') AS tracking,MAX(max_gain_pct) AS gain FROM scan_summaries`).get()!;
    result.total=Number(aggregate.total);result.eligible=Number(aggregate.eligible??0);result.tracking=Number(aggregate.tracking??0);
    if(typeof aggregate.gain==='number'&&Number.isFinite(aggregate.gain)) result.maxGainPct=aggregate.gain;
    for(const row of this.db.prepare('SELECT status,count(*) AS n FROM scan_summaries GROUP BY status').all())
      if(Object.hasOwn(result.byStatus,String(row.status))) result.byStatus[row.status as Stored['status']]=Number(row.n);
    for(const row of this.db.prepare('SELECT decision,count(*) AS n FROM scan_summaries GROUP BY decision').all()) {
      const decision=row.decision===null?'PENDING':String(row.decision);
      if(Object.hasOwn(result.byDecision,decision)) result.byDecision[decision as keyof ScanArchiveStats['byDecision']]=Number(row.n);
    }
    return result;
  }

  pendingTokens(limit=20,now=this.now()):ScanToken[] {
    this.prune(now);
    const take=Number.isSafeInteger(limit)?Math.max(1,Math.min(200,limit)):20;
    return this.db.prepare(`SELECT chain,address,MIN(COALESCE(last_price_attempt_at,'')) AS attempted FROM scan_summaries
      WHERE eligible_at>? AND eligible_at<=? GROUP BY chain,address ORDER BY attempted ASC,MIN(eligible_at) ASC,chain,address LIMIT ?`)
      .all(new Date(now.getTime()-this.trackingMs).toISOString(),now.toISOString(),take)
      .map(row=>({chain:row.chain as Chain,address:String(row.address)}));
  }

  recordPrice(price:ScanPrice):void {
    const identity=token(price),at=timestamp(price?.observedAt),now=this.now();
    if(!identity||!at||Date.parse(at)>now.getTime()||!Number.isFinite(price.priceUsd)||price.priceUsd<=0||
      typeof price.source!=='string'||!/^[a-z][a-z0-9_.:-]{0,63}$/.test(price.source)) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.pruneInside(now);
      for(const row of this.db.prepare('SELECT record,last_price_attempt_at FROM scan_summaries WHERE chain=? AND address=? AND eligible_at IS NOT NULL')
        .all(identity.chain,identity.address)) {
        const record=JSON.parse(String(row.record)) as ScanRecord,p=record.performance!;
        const eligible=Date.parse(p.eligibleAt),observed=Date.parse(at);
        if(p.status==='ended'||observed<=eligible||observed>=eligible+this.trackingMs||p.latestAt&&at<=p.latestAt||
          row.last_price_attempt_at&&at<String(row.last_price_attempt_at)) continue;
        const baseline=p.baselinePriceUsd??price.priceUsd;
        const gain=(price.priceUsd/baseline-1)*100;if(!Number.isFinite(gain)) continue;
        const isPeak=p.peakPriceUsd===undefined||price.priceUsd>p.peakPriceUsd;
        const peak=isPeak?price.priceUsd:p.peakPriceUsd!,peakAt=isPeak?at:p.peakAt!;
        const gap=p.latestAt?(observed-Date.parse(p.latestAt))/1_000:undefined;
        record.performance={...p,baselineAt:p.baselineAt??at,baselinePriceUsd:baseline,latestAt:at,latestPriceUsd:price.priceUsd,
          peakPriceUsd:peak,peakAt,maxGainPct:Math.max(0,(peak/baseline-1)*100),currentGainPct:gain,samples:p.samples+1,
          source:price.source,status:'tracking',error:undefined,
          ...(gap===undefined?{}:{maxSampleGapSec:Math.max(p.maxSampleGapSec??0,gap)}),
          points:thinPoints([...p.points,{at,priceUsd:price.priceUsd}],peakAt)};
        this.write(record,at);
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  recordPriceError(value:ScanToken,reason:string,now=this.now()):void {
    const identity=token(value);if(!identity||!Number.isFinite(now.getTime())) return;
    const error=reasonCodes([reason])[0]??'PRICE_SAMPLE_UNAVAILABLE';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.pruneInside(now);
      for(const row of this.db.prepare('SELECT record,last_price_attempt_at FROM scan_summaries WHERE chain=? AND address=? AND eligible_at IS NOT NULL')
        .all(identity.chain,identity.address)) {
        const record=JSON.parse(String(row.record)) as ScanRecord,p=record.performance!;
        if(p.status==='ended'||Date.parse(p.eligibleAt)>now.getTime()||
          row.last_price_attempt_at&&String(row.last_price_attempt_at)>now.toISOString()) continue;
        record.performance={...p,status:'unavailable',error,errorCount:Math.min(1_000_000_000,(p.errorCount??0)+1),
          lastErrorAt:now.toISOString(),lastError:error};this.write(record,now.toISOString());
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  prune(now=this.now()):void {
    if(!Number.isFinite(now.getTime())) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {this.pruneInside(now);this.db.exec('COMMIT');} catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  close():void {this.db.close();}
  private watchRow(id:string):WatchRow|undefined {
    return this.db.prepare('SELECT * FROM watch_jobs WHERE id=?').get(id) as unknown as WatchRow|undefined;
  }
  private withObservation(record:ScanRecord):ScanRecord {
    const row=this.watchRow(record.id);if(!row)return record;
    return {...record,observation:{state:row.state,firstReceivedAt:row.first_received_at,endsAt:row.ends_at,
      ...(row.next_check_at?{nextCheckAt:row.next_check_at}:{}),...(row.last_check_at?{lastCheckAt:row.last_check_at}:{}),
      attempts:row.attempts,...(row.end_reason?{endReason:row.end_reason}:{})}};
  }
  private watchDeadline(record:ScanRecord):string {
    return new Date(Math.min(Date.parse(record.receivedAt)+this.watch!.windowSec*1000,
      Date.parse(record.occurredAt)+this.watch!.maxSignalAgeSec*1000)).toISOString();
  }
  private deadlineReason(occurredAt:string,endsAt:string,now:Date):string|undefined {
    if(Date.parse(endsAt)>now.getTime())return;
    return Date.parse(endsAt)===Date.parse(occurredAt)+this.watch!.maxSignalAgeSec*1000?'SIGNAL_EXPIRED':'WINDOW_EXPIRED';
  }
  private insertWatch(record:ScanRecord,signal:Signal|undefined,ends:string,state:ScanObservation['state'],reason?:string):void {
    const next=new Date(Math.min(Date.parse(ends),Date.parse(record.evaluatedAt??record.receivedAt)+this.watch!.intervalSec*1000)).toISOString();
    const expiry=Date.parse(ends)===Date.parse(record.occurredAt)+this.watch!.maxSignalAgeSec*1000?'SIGNAL_EXPIRED':'WINDOW_EXPIRED';
    this.db.prepare(`INSERT INTO watch_jobs(id,chain,address,state,first_received_at,occurred_at,ends_at,next_check_at,end_reason,signal,expiry_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(record.id,record.chain,record.address,state,record.receivedAt,record.occurredAt,ends,
        state==='scheduled'?next:null,reason??null,signal?JSON.stringify(signal):null,expiry);
  }
  private isWatchHead(record:{id:string;chain:Chain;address:string}):boolean {
    return this.db.prepare('SELECT id FROM watch_heads WHERE chain=? AND address=?').get(record.chain,record.address)?.id===record.id;
  }
  private futureWatch(record:ScanRecord):boolean {return Date.parse(record.occurredAt)>Date.parse(record.receivedAt)+30_000;}
  private setWatchHead(record:ScanRecord,newSignal=false):void {
    // Bad clocks cannot pin a token's head to a far-future event for the entire
    // retention period, even when the first capture is still processing.
    if(this.futureWatch(record))return;
    const current=this.db.prepare('SELECT id,received_at,occurred_at FROM watch_heads WHERE chain=? AND address=?').get(record.chain,record.address);
    if(current&&(current.id===record.id||String(current.occurred_at)>record.occurredAt||
      String(current.occurred_at)===record.occurredAt&&(String(current.received_at)>record.receivedAt||
        String(current.received_at)===record.receivedAt&&!newSignal)))return;
    this.db.prepare("UPDATE watch_jobs SET state='ended',end_reason='SUPERSEDED',next_check_at=NULL,lease_until=NULL,claim_id=NULL WHERE chain=? AND address=? AND state<>'ended'")
      .run(record.chain,record.address);
    this.db.prepare(`INSERT INTO watch_heads(chain,address,id,received_at,occurred_at) VALUES (?,?,?,?,?)
      ON CONFLICT(chain,address) DO UPDATE SET id=excluded.id,received_at=excluded.received_at,occurred_at=excluded.occurred_at`)
      .run(record.chain,record.address,record.id,record.receivedAt,record.occurredAt);
  }
  private captureWatch(entry:Stored,record:ScanRecord,isNew:boolean,now:Date):void {
    if(isNew)this.setWatchHead(record,true);
    const old=this.watchRow(record.id);
    if(old) {
      // A duplicate capture never resets attempts, lifetime, or a terminal job.
      if(old.state!=='ended'&&record.status==='completed'&&record.decision&&record.decision!=='WATCH')
        this.endWatch(old.id,record.decision==='REJECT'?'REJECTED':'BUY_CANDIDATE');
      return;
    }
    if(record.status!=='completed'||record.mode!=='live'||record.decision!=='WATCH')return;
    const ends=this.watchDeadline(record),signal=watchSignal({...entry.signal,occurredAt:record.occurredAt});
    const endReason=this.futureWatch(record)?'SIGNAL_TIME_IN_FUTURE':!this.isWatchHead(record)?'SUPERSEDED':
      this.deadlineReason(record.occurredAt,ends,now)??(!signal?'SIGNAL_UNSAFE':undefined);
    this.insertWatch(record,signal,ends,endReason?'ended':'scheduled',endReason);
  }
  private activeWatchClaim(id:string,claimId:string,now:Date):WatchRow|undefined {
    const row=this.watchRow(id);
    return row&&row.state==='processing'&&row.claim_id===claimId&&Date.parse(row.ends_at)>now.getTime()&&
      Date.parse(row.lease_until!)>now.getTime()&&this.isWatchHead(row)?row:undefined;
  }
  private endWatch(id:string,reason:string,clearClaim=true):void {
    this.db.prepare("UPDATE watch_jobs SET state='ended',end_reason=?,next_check_at=NULL,lease_until=NULL,claim_id=CASE WHEN ? THEN NULL ELSE claim_id END WHERE id=?")
      .run(reason,clearClaim?1:0,id);
  }
  private rescheduleWatch(row:WatchRow,_reason:string|undefined,now:Date):void {
    if(Date.parse(row.ends_at)<=now.getTime()){this.endWatch(row.id,row.expiry_reason);return;}
    const next=new Date(Math.min(Date.parse(row.ends_at),now.getTime()+this.watch!.intervalSec*1000)).toISOString();
    this.db.prepare("UPDATE watch_jobs SET state='scheduled',next_check_at=?,end_reason=NULL,lease_until=NULL,claim_id=NULL WHERE id=?")
      .run(next,row.id);
  }
  private read(id:string):ScanRecord|undefined {
    const row=this.db.prepare('SELECT record FROM scan_summaries WHERE id=?').get(id);
    return row?JSON.parse(String(row.record)) as ScanRecord:undefined;
  }
  private write(record:ScanRecord,lastAttempt?:string,lease?:string|null):void {
    this.db.prepare(`INSERT INTO scan_summaries(id,chain,address,status,received_at,decision,eligible_at,last_price_attempt_at,lease_expires_at,performance_status,max_gain_pct,record)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,decision=excluded.decision,
      eligible_at=excluded.eligible_at,last_price_attempt_at=COALESCE(excluded.last_price_attempt_at,scan_summaries.last_price_attempt_at),
      lease_expires_at=CASE WHEN excluded.status<>'processing' THEN NULL
        ELSE COALESCE(excluded.lease_expires_at,scan_summaries.lease_expires_at) END,
      performance_status=excluded.performance_status,max_gain_pct=excluded.max_gain_pct,record=excluded.record`)
      .run(record.id,record.chain,record.address,record.status,record.receivedAt,record.decision??null,
        record.performance?.eligibleAt??null,lastAttempt??null,lease??null,record.performance?.status??null,
        record.performance?.maxGainPct??null,JSON.stringify(record));
  }
  private pruneInside(now:Date):void {
    const cutoff=new Date(now.getTime()-this.retentionDays*86_400_000).toISOString();
    this.db.prepare('DELETE FROM scan_summaries WHERE received_at<?').run(cutoff);
    if(Number(this.db.prepare('SELECT count(*) AS n FROM scan_summaries').get()!.n)>this.maxEntries)
      this.db.prepare('DELETE FROM scan_summaries WHERE id NOT IN (SELECT id FROM scan_summaries ORDER BY received_at DESC,rowid DESC LIMIT ?)').run(this.maxEntries);
    this.db.exec('DELETE FROM watch_jobs WHERE id NOT IN (SELECT id FROM scan_summaries); DELETE FROM watch_heads WHERE id NOT IN (SELECT id FROM scan_summaries)');
    this.db.prepare("UPDATE watch_jobs SET state='ended',end_reason=expiry_reason,next_check_at=NULL,lease_until=NULL,claim_id=NULL WHERE state<>'ended' AND ends_at<=?")
      .run(now.toISOString());
    this.db.prepare("UPDATE watch_jobs SET state='scheduled',next_check_at=?,lease_until=NULL,claim_id=NULL WHERE state='processing' AND lease_until<=?")
      .run(now.toISOString(),now.toISOString());
    for(const row of this.db.prepare("SELECT record FROM scan_summaries WHERE status='processing' AND (lease_expires_at IS NULL OR lease_expires_at<=?)").all(now.toISOString())) {
      const record=JSON.parse(String(row.record)) as ScanRecord;
      record.status='interrupted';this.write(record);
    }
    const ended=new Date(now.getTime()-this.trackingMs).toISOString();
    for(const row of this.db.prepare("SELECT record FROM scan_summaries WHERE eligible_at<=? AND performance_status<>'ended'").all(ended)) {
      const record=JSON.parse(String(row.record)) as ScanRecord;
      record.performance={...record.performance!,status:'ended'};this.write(record);
    }
  }
}
