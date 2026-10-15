import type {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import type {Report,Status} from './types.js';
import type {ScanPrice,ScanToken,ScanRecord,ScanPricePoint} from './scan-archive.js';
import type {FollowupWalletEvidence} from './wallet-history.js';

export type FollowupFeature='two_wallet_groups'|'positive_net_buy'|'social_link'|'precursor_setup'|'public_entry_setup';
type FeatureValue=true|false|null;
export interface FollowupInitial {
  scanId:string;source:ScanRecord['source'];receivedAt:string;occurredAt:string;evaluatedAt:string;
  decision:Report['decision'];buyEligible:boolean;policyVersion:string;reasons:string[];
  checks:Record<'safety'|'provenance'|'market'|'wallets'|'flow'|'narrative',{status:Status;reasons:string[]}>;
  qualifiedGroups:number|null;recentNetBuyUsd:number|null;
  walletGroups:NonNullable<ScanRecord['wallets']>['groups'];
  setups:Array<{route:'precursor'|'public_entry';status:string;stage:string;wallet:string;leader:string}>;
  socialSignals:NonNullable<Report['social']>['signals'];
  features:Record<FollowupFeature,FeatureValue>;
}
export interface FollowupPerformance {
  status:'waiting'|'tracking'|'unavailable'|'ended'|'not_selected';samples:number;
  baselineAt?:string;baselinePriceUsd?:number;baselineDelayed?:boolean;
  latestAt?:string;latestPriceUsd?:number;peakAt?:string;peakPriceUsd?:number;
  currentGainPct?:number;maxGainPct?:number;maxDrawdownPct?:number;maxSampleGapSec?:number;
  source?:string;error?:string;errorCount?:number;lastErrorAt?:string;points:ScanPricePoint[];
  baselineMarket?:ScanPrice['market'];latestMarket?:ScanPrice['market'];liquidityChangePct?:number;holderChangePct?:number;
  baselineMarketAt?:string;latestMarketAt?:string;
  marketLimitations?:string[];
}
export interface FollowupHorizon {at:string;gainPct:number;delaySec:number;}
export interface FollowupTimeline {
  kind:'baseline'|'gain_50'|'gain_100'|'drawdown_30'|'horizon_1h'|'horizon_6h'|'horizon_24h'|'wallet_sample';
  at:string;priceUsd:number;gainPct:number;drawdownPct:number;
  walletEvidence?:FollowupWalletEvidence;market?:ScanPrice['market'];
}
export interface FollowupRecord extends ScanToken {
  name?:string;symbol?:string;registeredAt:string;endsAt:string;
  selected:boolean;selection:'candidate'|'comparison'|'capacity_skipped';
  initial:FollowupInitial;performance:FollowupPerformance;horizons:Record<string,FollowupHorizon>;timeline:FollowupTimeline[];
}
export interface FollowupHorizonStats {
  seconds:number;count:number;mature:number;covered:number;missing:number;medianGainPct:number|null;upRatePct:number|null;
}
export interface FollowupGroup {
  chain:ScanToken['chain'];decision:Report['decision'];policyVersion:string;count:number;selected:number;horizons:FollowupHorizonStats[];
}
interface FeatureStats {count:number;covered:number;missing:number;medianGainPct:number|null;upRatePct:number|null;}
interface LearningSplit {count:number;covered:number;present:FeatureStats;absent:FeatureStats;unknown:FeatureStats;medianDifferencePct:number|null;}
export interface FollowupLearning {
  chain:ScanToken['chain'];decision:Report['decision'];policyVersion:string;seconds:number;feature:FollowupFeature;
  status:'collecting'|'needs_validation'|'consistent_association'|'not_replicated';
  train:LearningSplit;validation:LearningSplit;splitAt?:string;
  purgedTrainingCount:number;minimumPerFeatureGroup:number;scope:'observational_correlation';
}
export interface FollowupListOptions {
  limit?:number;offset?:number;chain?:ScanToken['chain'];decision?:Report['decision'];selected?:boolean;asOf?:string;
  status?:FollowupLearning['status'];
}
export type FollowupListRecord=Omit<FollowupRecord,'initial'|'performance'|'timeline'>&{
  initial:Pick<FollowupInitial,'decision'|'policyVersion'|'source'|'reasons'>;
  performance:Omit<FollowupPerformance,'points'|'baselineMarket'|'latestMarket'|'marketLimitations'>;
};
interface OutcomeRecord {
  chain:ScanToken['chain'];registeredAt:string;endsAt:string;selected:boolean;
  initial:Pick<FollowupInitial,'decision'|'policyVersion'|'features'>;
  performance:Pick<FollowupPerformance,'samples'|'latestAt'>;horizons:FollowupRecord['horizons'];
}

const HORIZONS=[3600,21600,86400];
const FEATURES:FollowupFeature[]=['two_wallet_groups','positive_net_buy','social_link','precursor_setup','public_entry_setup'];
const DAY=86_400_000,TOLERANCE=600_000,MAX_POINTS=256,MAX_TIMELINE=32;
const time=(s:unknown):number|undefined=>typeof s==='string'&&s.length<=40&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s))?Date.parse(s):undefined;
const text=(s:unknown,n:number):string|undefined=>typeof s==='string'?s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,n)||undefined:undefined;
const reasons=(v:unknown):string[]=>Array.isArray(v)?[...new Set(v.filter((s):s is string=>typeof s==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(s)))].slice(0,24):[];
function identity(v:ScanToken):ScanToken|undefined {
  if(!v||!['bsc','solana','robinhood'].includes(v.chain)||typeof v.address!=='string')return;
  if(v.chain!=='solana')return /^0x[0-9a-f]{40}$/i.test(v.address)&&!/^0x0{40}$/i.test(v.address)?{chain:v.chain,address:v.address.toLowerCase()}:undefined;
  try {const b=bs58.decode(v.address);if(b.length===32&&b.some(x=>x!==0))return {chain:v.chain,address:v.address};}catch{/* Invalid input is not an identity. */}
}
function numeric(v:unknown):number|null {
  if(typeof v==='string'&&(v.length>100||!/^[-+]?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(v)))return null;
  if(typeof v!=='number'&&typeof v!=='string')return null;
  const n=Number(v);return Number.isFinite(n)?n:null;
}
function median(values:number[]):number|null {
  if(!values.length)return null;const a=values.slice().sort((x,y)=>x-y);
  return a[Math.floor((a.length-1)/2)]/2+a[Math.floor(a.length/2)]/2;
}
function stats(rows:OutcomeRecord[],seconds:number):FeatureStats {
  const values:number[]=[],key=String(seconds);for(const r of rows){const horizon=r.horizons[key];if(horizon)values.push(horizon.gainPct);}
  return {count:rows.length,covered:values.length,missing:rows.length-values.length,
    medianGainPct:median(values),upRatePct:values.length?values.filter(x=>x>0).length/values.length*100:null};
}
function splitStats(rows:OutcomeRecord[],feature:FollowupFeature,seconds:number):LearningSplit {
  const buckets=[{count:0,values:[] as number[]},{count:0,values:[] as number[]},{count:0,values:[] as number[]}],key=String(seconds);
  for(const r of rows) {
    const v=r.initial.features[feature],bucket=buckets[v===true?0:v===false?1:2];bucket.count++;
    if(r.horizons[key])bucket.values.push(r.horizons[key].gainPct);
  }
  const [present,absent,unknown]=buckets.map(({count,values}):FeatureStats=>({count,covered:values.length,missing:count-values.length,
    medianGainPct:median(values),upRatePct:values.length?values.filter(x=>x>0).length/values.length*100:null}));
  return {count:rows.length,covered:present.covered+absent.covered+unknown.covered,present,absent,unknown,
    medianDifferencePct:present.medianGainPct!==null&&absent.medianGainPct!==null?present.medianGainPct-absent.medianGainPct:null};
}

/** Forward observations only. Neither a simulated fill nor a permission to change trading policy. */
export class SignalFollowup {
  private cachedSummary?:{at:number;value:ReturnType<SignalFollowup['buildSummary']>};
  private lastPruneAt?:number;
  constructor(private readonly db:DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS signal_followups (
      chain TEXT NOT NULL,address TEXT NOT NULL,registered_at TEXT NOT NULL,ends_at TEXT NOT NULL,
      decision TEXT NOT NULL,policy_version TEXT NOT NULL,selected INTEGER NOT NULL,last_attempt_at TEXT,
      record TEXT NOT NULL,summary_record TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS signal_followups_active ON signal_followups(selected,ends_at,decision);
      CREATE INDEX IF NOT EXISTS signal_followups_registered ON signal_followups(registered_at,chain,address);
      CREATE INDEX IF NOT EXISTS signal_followups_retention ON signal_followups(selected,registered_at,chain,address);
      CREATE TABLE IF NOT EXISTS signal_followup_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const columns=db.prepare('PRAGMA table_info(signal_followups)').all();
    if(!columns.some(c=>c.name==='summary_record'))db.exec("ALTER TABLE signal_followups ADD COLUMN summary_record TEXT NOT NULL DEFAULT '{}'");
    db.exec('CREATE INDEX IF NOT EXISTS signal_followups_summary ON signal_followups(registered_at,chain,address,summary_record)');
    // Compatibility only for an interrupted initial rollout. Full records never
    // enter routine aggregate reads; timeline evidence stays in detail storage.
    for(const row of db.prepare("SELECT rowid,record FROM signal_followups WHERE summary_record='{}'").all()) {
      const record=JSON.parse(String(row.record)) as FollowupRecord;
      db.prepare('UPDATE signal_followups SET summary_record=? WHERE rowid=?').run(this.metric(record),row.rowid!);
    }
  }
  private metric(r:FollowupRecord):string {
    const value:OutcomeRecord={chain:r.chain,registeredAt:r.registeredAt,endsAt:r.endsAt,selected:r.selected,
      initial:{decision:r.initial.decision,policyVersion:r.initial.policyVersion,features:r.initial.features},
      performance:{samples:r.performance.samples,latestAt:r.performance.latestAt},horizons:r.horizons};
    return JSON.stringify(value);
  }
  capture(report:Report,record:ScanRecord,now:Date):void {
    const token=identity(record),reported=identity(report.signal.token),evaluated=time(report.evaluatedAt),ms=now.getTime();
    if(!token||!reported||reported.chain!==token.chain||reported.address!==token.address||report.id!==record.id||
      report.mode!=='live'||record.status!=='completed'||!['BUY_CANDIDATE','WATCH','REJECT'].includes(report.decision)||
      evaluated===undefined||evaluated>ms||ms-evaluated>120000||time(record.receivedAt)===undefined||time(record.occurredAt)===undefined)return;
    const existing=this.db.prepare('SELECT record FROM signal_followups WHERE chain=? AND address=?').get(token.chain,token.address);
    if(existing) {
      const saved=JSON.parse(String(existing.record)) as FollowupRecord,name=text(record.name,100),symbol=text(record.symbol,40);
      if(!saved.name&&name||!saved.symbol&&symbol) {
        saved.name??=name;saved.symbol??=symbol;
        this.db.prepare('UPDATE signal_followups SET record=? WHERE chain=? AND address=?').run(JSON.stringify(saved),token.chain,token.address);
      }
      return;
    }
    const at=now.toISOString(),candidate=report.decision==='BUY_CANDIDATE'&&report.buyEligible===true;
    const active=Number(this.db.prepare('SELECT count(*) AS n FROM signal_followups WHERE selected=1 AND decision=? AND ends_at>?')
      .get(report.decision,at)!.n);
    const selected=candidate||report.decision!=='BUY_CANDIDATE'&&active<3;
    const summary=record.wallets?.summary,n=summary?.qualifiedSmartFundingClusterCount;
    const qualifiedGroups=typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:null;
    const recentNetBuyUsd=numeric(summary?.recentNetBuyUsd);
    const screen=record.walletScreening,screenKnown=!!screen&&screen.status!=='unavailable'&&
      time(screen.checkedAt)!==undefined&&time(screen.checkedAt)!<=evaluated&&evaluated-time(screen.checkedAt)!<=120000&&
      time(screen.validUntil)!==undefined&&time(screen.validUntil)!>=evaluated;
    const setups=(screenKnown?screen!.setups:[]).slice(0,8).flatMap(s=>{
      const wallet=identity({chain:token.chain,address:s.wallet}),leader=identity({chain:token.chain,address:s.leader});
      return wallet&&leader?[{route:s.route,status:s.status,stage:s.stage,wallet:wallet.address,leader:leader.address}]:[];
    });
    const socialSignals=(record.social?.signals??[]).slice(0,12).filter(s=>{
      try {const u=new URL(s.sourceUrl);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname);}catch{return false;}
    }).map(s=>({...s,person:text(s.person,80)??'',label:text(s.label,80)}));
    const checks={} as FollowupInitial['checks'];
    for(const key of ['safety','provenance','market','wallets','flow','narrative'] as const) {
      const check=record.checks[key];checks[key]={status:check?.status??'unknown',reasons:reasons(check?.reasons)};
    }
    const value:FollowupRecord={...token,name:text(record.name,100),symbol:text(record.symbol,40),registeredAt:at,
      endsAt:new Date(ms+DAY+TOLERANCE).toISOString(),selected,
      selection:candidate?'candidate':selected?'comparison':'capacity_skipped',
      initial:{scanId:record.id,source:record.source,receivedAt:record.receivedAt,occurredAt:record.occurredAt,
        evaluatedAt:report.evaluatedAt,decision:report.decision,buyEligible:report.buyEligible,policyVersion:text(report.policyVersion,100)??'unknown',
        reasons:reasons(report.reasons),checks,qualifiedGroups,recentNetBuyUsd,
        walletGroups:(record.wallets?.groups??[]).slice(0,12).map(g=>({...g,id:text(g.id,100)??'unknown',
          basis:g.basis.slice(0,4).map(v=>text(v,50)??'unknown'),wallets:g.wallets.slice(0,8).flatMap(a=>identity({chain:token.chain,address:a})?.address??[])})),setups,socialSignals,
        features:{two_wallet_groups:qualifiedGroups===null?null:qualifiedGroups>=2,
          positive_net_buy:recentNetBuyUsd===null?null:recentNetBuyUsd>0,
          social_link:record.social?socialSignals.some(s=>s.kind==='profile_link'||s.kind==='ca_post'):null,
          precursor_setup:screenKnown?setups.some(s=>s.route==='precursor'&&s.status==='supported'):null,
          public_entry_setup:screenKnown?setups.some(s=>s.route==='public_entry'&&s.status==='supported'):null}},
      performance:{status:selected?'waiting':'not_selected',samples:0,points:[]},horizons:{},timeline:[]};
    this.db.prepare('INSERT INTO signal_followups(chain,address,registered_at,ends_at,decision,policy_version,selected,record,summary_record) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(token.chain,token.address,at,value.endsAt,report.decision,value.initial.policyVersion,selected?1:0,JSON.stringify(value),this.metric(value));
    this.db.prepare("INSERT OR IGNORE INTO signal_followup_meta(key,value) VALUES ('started_at',?)").run(at);
    this.trimCapacity();
  }
  pending(now:Date,limit=12):Array<ScanToken&{lastAttemptAt?:string}> {
    const bounded=Math.max(0,Math.min(200,Number.isSafeInteger(limit)?limit:12));
    return this.db.prepare(`SELECT chain,address,last_attempt_at FROM signal_followups WHERE selected=1 AND ends_at>?
      ORDER BY COALESCE(last_attempt_at,''),registered_at,chain,address LIMIT ?`).all(now.toISOString(),bounded)
      .map(r=>({chain:r.chain as ScanToken['chain'],address:String(r.address),...(r.last_attempt_at?{lastAttemptAt:String(r.last_attempt_at)}:{})}));
  }
  observationStart(token:ScanToken,now=new Date()):string|undefined {
    const t=identity(token);if(!t)return;
    const row=this.db.prepare('SELECT registered_at FROM signal_followups WHERE chain=? AND address=? AND selected=1 AND ends_at>?')
      .get(t.chain,t.address,now.toISOString());return row?String(row.registered_at):undefined;
  }
  evidenceWindow(price:ScanPrice,observedAt:string):{fromAt:string;untilAt:string}|undefined {
    const token=identity(price),ms=time(observedAt);if(!token||ms===undefined||ms>Date.now()||observedAt!==price.observedAt||
      !Number.isFinite(price.priceUsd)||price.priceUsd<=0||!['gmgn_token_info_sample','chain_pool_sample'].includes(price.source))return;
    const row=this.db.prepare('SELECT record,last_attempt_at FROM signal_followups WHERE chain=? AND address=? AND selected=1 AND ends_at>?')
      .get(token.chain,token.address,new Date(ms).toISOString());if(!row)return;
    const value=JSON.parse(String(row.record)) as FollowupRecord,registered=Date.parse(value.registeredAt);
    if(ms<=registered||value.performance.latestAt&&ms-Date.parse(value.performance.latestAt)<30000||
      row.last_attempt_at&&ms<Date.parse(String(row.last_attempt_at)))return;
    return {fromAt:new Date(Math.max(registered,ms-600000)).toISOString(),untilAt:new Date(ms).toISOString()};
  }
  price(price:ScanPrice,now:Date,walletEvidence?:FollowupWalletEvidence):void {
    const token=identity(price),ms=time(price.observedAt),nowMs=now.getTime();
    if(!token||ms===undefined||ms>nowMs||nowMs-ms>120000||!Number.isFinite(price.priceUsd)||price.priceUsd<=0||
      !['gmgn_token_info_sample','chain_pool_sample'].includes(price.source))return;
    const row=this.db.prepare('SELECT record,last_attempt_at FROM signal_followups WHERE chain=? AND address=? AND selected=1 AND ends_at>?')
      .get(token.chain,token.address,now.toISOString());if(!row)return;
    const value=JSON.parse(String(row.record)) as FollowupRecord,p=value.performance,registered=Date.parse(value.registeredAt);
    if(ms<=registered||p.latestAt&&ms<=Date.parse(p.latestAt)||row.last_attempt_at&&ms<Date.parse(String(row.last_attempt_at)))return;
    if(p.latestAt&&ms-Date.parse(p.latestAt)<30000)return;
    const at=new Date(ms).toISOString(),base=p.baselinePriceUsd??price.priceUsd;
    const peak=Math.max(p.peakPriceUsd??price.priceUsd,price.priceUsd),gain=(price.priceUsd/base-1)*100,maxGain=(peak/base-1)*100;
    if(!Number.isFinite(gain)||!Number.isFinite(maxGain))return;
    const drawdown=(1-price.priceUsd/peak)*100,peakAt=price.priceUsd>=(p.peakPriceUsd??price.priceUsd)?at:p.peakAt!;
    const points=[...p.points,{at,priceUsd:price.priceUsd}],market=this.market(price.market,token);
    const baselineMarket=p.baselineMarket??(!p.baselineAt?market:undefined);
    const samePool=!!market?.poolAddress&&market.poolAddress===baselineMarket?.poolAddress;
    const liquidityComparable=samePool&&market?.liquidityUsd!==undefined&&!!baselineMarket?.liquidityUsd;
    value.performance={...p,status:'tracking',samples:p.samples+1,baselineAt:p.baselineAt??at,baselinePriceUsd:base,
      baselineDelayed:p.baselineDelayed??ms-registered>TOLERANCE,latestAt:at,latestPriceUsd:price.priceUsd,
      peakAt,peakPriceUsd:peak,currentGainPct:gain,maxGainPct:maxGain,maxDrawdownPct:Math.max(p.maxDrawdownPct??0,drawdown),
      maxSampleGapSec:Math.max(p.maxSampleGapSec??0,p.latestAt?(ms-Date.parse(p.latestAt))/1000:(ms-registered)/1000),
      source:price.source,error:undefined,baselineMarket,latestMarket:market??p.latestMarket,
      baselineMarketAt:p.baselineMarketAt??(!p.baselineAt&&market?at:undefined),latestMarketAt:market?at:p.latestMarketAt,
      liquidityChangePct:liquidityComparable&&Number.isFinite((market!.liquidityUsd!/baselineMarket!.liquidityUsd!-1)*100)
        ?(market!.liquidityUsd!/baselineMarket!.liquidityUsd!-1)*100:market?undefined:p.liquidityChangePct,
      marketLimitations:market?market.liquidityUsd!==undefined&&!samePool?
        [market.poolAddress&&baselineMarket?.poolAddress?'POOL_CHANGED_LIQUIDITY_NOT_COMPARABLE':'POOL_IDENTITY_MISSING_LIQUIDITY_NOT_COMPARABLE']:[]:p.marketLimitations,
      holderChangePct:market?.holderCount!==undefined&&baselineMarket?.holderCount&&Number.isFinite((market.holderCount/baselineMarket.holderCount-1)*100)
        ?(market.holderCount/baselineMarket.holderCount-1)*100:market?undefined:p.holderChangePct,
      points:points.length<=MAX_POINTS?points:points.filter((x,i)=>i===0||i===points.length-1||i%2===0||x.at===peakAt)};
    const events:FollowupTimeline['kind'][]=[];
    if(!p.baselineAt)events.push('baseline');
    for(const [threshold,kind] of [[50,'gain_50'],[100,'gain_100']] as const)
      if(gain>=threshold&&!value.timeline.some(t=>t.kind===kind))events.push(kind);
    if(drawdown>=30&&!value.timeline.some(t=>t.kind==='drawdown_30'))events.push('drawdown_30');
    for(const seconds of HORIZONS) {
      const delay=(ms-registered)/1000-seconds;
      if(!value.horizons[String(seconds)]&&delay>=0&&delay<=TOLERANCE/1000&&!value.performance.baselineDelayed) {
        value.horizons[String(seconds)]={at,gainPct:gain,delaySec:delay};
        events.push(`horizon_${seconds/3600}h` as FollowupTimeline['kind']);
      }
    }
    const evidence=this.walletEvidence(walletEvidence,token,value.registeredAt,at);
    const lastContext=value.timeline.at(-1);
    if((evidence||market)&&(!lastContext||ms-Date.parse(lastContext.at)>=600000)&&!events.length)events.push('wallet_sample');
    for(const kind of events) {
      // Milestones survive the bounded hourly wallet context, even in a full timeline.
      if(value.timeline.length>=MAX_TIMELINE) {
        const index=value.timeline.findIndex(t=>t.kind==='wallet_sample');
        if(index>=0)value.timeline.splice(index,1);else break;
      }
      value.timeline.push({kind,at,priceUsd:price.priceUsd,gainPct:gain,drawdownPct:drawdown,
        ...(evidence?{walletEvidence:evidence}:{}),...(market?{market}:{})});
    }
    this.db.prepare('UPDATE signal_followups SET record=?,summary_record=?,last_attempt_at=? WHERE chain=? AND address=?')
      .run(JSON.stringify(value),this.metric(value),at,token.chain,token.address);
  }
  private market(raw:ScanPrice['market'],token:ScanToken):ScanPrice['market'] {
    if(!raw)return;
    const result:NonNullable<ScanPrice['market']>={};
    if(typeof raw.liquidityUsd==='number'&&Number.isFinite(raw.liquidityUsd)&&raw.liquidityUsd>=0)result.liquidityUsd=raw.liquidityUsd;
    if(typeof raw.holderCount==='number'&&Number.isSafeInteger(raw.holderCount)&&raw.holderCount>=0)result.holderCount=raw.holderCount;
    if(typeof raw.top10HolderRate==='number'&&Number.isFinite(raw.top10HolderRate)&&raw.top10HolderRate>=0&&raw.top10HolderRate<=1)result.top10HolderRate=raw.top10HolderRate;
    if(raw.poolAddress){const pool=identity({chain:token.chain,address:raw.poolAddress});if(pool)result.poolAddress=pool.address;}
    return Object.keys(result).length?result:undefined;
  }
  private walletEvidence(raw:FollowupWalletEvidence|undefined,token:ScanToken,registeredAt:string,at:string):FollowupWalletEvidence|undefined {
    if(!raw||raw.chain!==token.chain||raw.address!==token.address||time(raw.fromAt)===undefined||time(raw.untilAt)===undefined||Date.parse(raw.fromAt)<Date.parse(registeredAt)||
      Date.parse(raw.untilAt)>Date.parse(at)||Date.parse(raw.fromAt)>Date.parse(raw.untilAt)||!Array.isArray(raw.trades)||
      !['sampled','truncated','unavailable'].includes(raw.coverage)||!Array.isArray(raw.limitations)||raw.trades.length>40)return;
    for(const key of ['buyUsd','sellUsd','netBuyUsd','buyerCount','sellerCount'] as const) {
      const v=raw[key];if(v!==null&&(typeof v!=='number'||!Number.isFinite(v)||key!=='netBuyUsd'&&v<0))return;
      if((key==='buyerCount'||key==='sellerCount')&&v!==null&&!Number.isSafeInteger(v))return;
      if(raw.coverage!=='sampled'&&v!==null)return;
    }
    if(!Number.isSafeInteger(raw.evidenceCount)||raw.evidenceCount<0||!Number.isSafeInteger(raw.excludedCount)||raw.excludedCount<0)return;
    // The history reader is authoritative for deduplication. Recheck temporal bounds
    // here so a future caller cannot leak later discoveries into a recorded milestone.
    const trades=raw.trades.filter(t=>time(t.eventAt)!==undefined&&time(t.observedAt)!==undefined&&
      typeof t.volumeUsd==='number'&&Number.isFinite(t.volumeUsd)&&t.volumeUsd>0&&['buy','sell'].includes(t.side)&&
      identity({chain:token.chain,address:t.wallet})?.address===t.wallet&&typeof t.evidenceId==='string'&&t.evidenceId.length<=200&&
      typeof t.txHash==='string'&&t.txHash.length<=100&&typeof t.source==='string'&&/^[a-z][a-z0-9_.:-]{0,79}$/.test(t.source)&&
      Date.parse(t.eventAt)>=Date.parse(raw.fromAt)&&Date.parse(t.eventAt)<=Date.parse(raw.untilAt)&&
      Date.parse(t.observedAt)>=Date.parse(t.eventAt)&&Date.parse(t.observedAt)<=Date.parse(raw.untilAt));
    if(trades.length!==raw.trades.length)return;
    return {...structuredClone(raw),trades:trades.slice(0,6),limitations:[...new Set([...raw.limitations.map(v=>text(v,160)??'UNKNOWN_LIMITATION'),
      ...(trades.length>6?['TIMELINE_TRADE_EXAMPLES_TRUNCATED']:[])])].slice(0,12)};
  }
  error(token:ScanToken,reason:string,now:Date):void {
    const t=identity(token),at=now.toISOString();if(!t)return;
    const row=this.db.prepare("SELECT record FROM signal_followups WHERE chain=? AND address=? AND selected=1 AND ends_at>? AND COALESCE(last_attempt_at,'')<=?")
      .get(t.chain,t.address,at,at);if(!row)return;
    const r=JSON.parse(String(row.record)) as FollowupRecord;
    r.performance={...r.performance,status:'unavailable',error:reasons([reason])[0]??'PRICE_UNAVAILABLE',
      errorCount:Math.min(1e9,(r.performance.errorCount??0)+1),lastErrorAt:at};
    this.db.prepare('UPDATE signal_followups SET record=?,last_attempt_at=? WHERE chain=? AND address=?').run(JSON.stringify(r),at,t.chain,t.address);
  }
  prune(now:Date):void {
    if(this.lastPruneAt!==undefined&&now.getTime()>=this.lastPruneAt&&now.getTime()-this.lastPruneAt<3600000)return;
    this.lastPruneAt=now.getTime();
    this.db.prepare('DELETE FROM signal_followups WHERE registered_at<?').run(new Date(now.getTime()-90*DAY).toISOString());
    this.trimCapacity();
  }
  private trimCapacity():void {
    const excess=Number(this.db.prepare('SELECT count(*) AS n FROM signal_followups').get()!.n)-20000;
    if(excess>0)this.db.prepare('DELETE FROM signal_followups WHERE rowid IN (SELECT rowid FROM signal_followups ORDER BY selected,registered_at,chain,address LIMIT ?)').run(excess);
  }
  detail(chain:ScanToken['chain'],address:string,now:Date):FollowupRecord|undefined {
    const token=identity({chain,address});if(!token)return;
    const row=this.db.prepare('SELECT record FROM signal_followups WHERE chain=? AND address=?').get(token.chain,token.address);
    if(!row)return;return this.withStatus(JSON.parse(String(row.record)) as FollowupRecord,now);
  }
  private withStatus(row:FollowupRecord,now:Date):FollowupRecord {
    return {...row,performance:{...row.performance,...(row.selected&&row.endsAt<=now.toISOString()?{status:'ended' as const}:{})}};
  }
  private aggregate(now:Date):ReturnType<SignalFollowup['buildSummary']> {
    if(this.cachedSummary&&now.getTime()>=this.cachedSummary.at&&now.getTime()-this.cachedSummary.at<60000)return this.cachedSummary.value;
    const value=this.buildSummary(now);this.cachedSummary={at:now.getTime(),value};return value;
  }
  /** Legacy internal summary. Dashboard lists use separate bounded SQL pages. */
  summary(now:Date) {
    const rows=this.db.prepare(`SELECT record FROM signal_followups ORDER BY
      CASE WHEN selected=1 AND ends_at>? THEN 0 WHEN selected=1 THEN 1 ELSE 2 END,registered_at DESC,chain,address LIMIT 30`).all(now.toISOString());
    return {...structuredClone(this.aggregate(now)),items:rows.map(row=>{
      const r=this.withStatus(JSON.parse(String(row.record)) as FollowupRecord,now);return {...r,performance:{...r.performance,points:undefined}};
    })};
  }
  dashboardSummary(now:Date) {
    const {groups,learning,...summary}=this.aggregate(now);
    return {...structuredClone(summary),groupsTotal:groups.length,learningTotal:learning.length};
  }
  private page(options:FollowupListOptions,now:Date) {
    const limit=options.limit??20,offset=options.offset??0,asOf=options.asOf??now.toISOString();
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000||
      options.chain&&!['bsc','solana','robinhood'].includes(options.chain)||
      options.decision&&!['BUY_CANDIDATE','WATCH','REJECT'].includes(options.decision)||
      options.selected!==undefined&&typeof options.selected!=='boolean'||
      options.status&&!['collecting','needs_validation','consistent_association','not_replicated'].includes(options.status)||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(asOf)||!Number.isFinite(Date.parse(asOf))||new Date(asOf).toISOString()!==asOf)throw new Error('INVALID_FILTER');
    return {limit,offset,asOf};
  }
  list(options:FollowupListOptions={},now=new Date()) {
    const {limit,offset,asOf}=this.page(options,now),clauses=['registered_at<=?'],values:(string|number)[]=[asOf];
    if(options.chain){clauses.push('chain=?');values.push(options.chain);}
    if(options.decision){clauses.push('decision=?');values.push(options.decision);}
    if(options.selected!==undefined){clauses.push('selected=?');values.push(options.selected?1:0);}
    const where=clauses.join(' AND '),total=Number(this.db.prepare(`SELECT count(*) AS n FROM signal_followups WHERE ${where}`).get(...values)!.n);
    // Project only the row fields in SQLite: timelines, wallet evidence and charts
    // never cross the database boundary until the user opens a token detail.
    const rows=this.db.prepare(`SELECT json_object(
      'chain',chain,'address',address,'name',json_extract(record,'$.name'),'symbol',json_extract(record,'$.symbol'),
      'registeredAt',registered_at,'endsAt',ends_at,'selected',json(CASE WHEN selected=1 THEN 'true' ELSE 'false' END),
      'selection',json_extract(record,'$.selection'),
      'initial',json_object('decision',decision,'policyVersion',policy_version,'source',json_extract(record,'$.initial.source'),
        'reasons',json_extract(record,'$.initial.reasons')),
      'performance',json_remove(json_extract(record,'$.performance'),'$.points','$.baselineMarket','$.latestMarket','$.marketLimitations'),
      'horizons',json_extract(record,'$.horizons')) AS item
      FROM signal_followups WHERE ${where} ORDER BY registered_at DESC,chain,address LIMIT ? OFFSET ?`).all(...values,limit,offset);
    const items=rows.map(row=>{const item=JSON.parse(String(row.item)) as FollowupListRecord;
      if(item.selected&&item.endsAt<=now.toISOString())item.performance.status='ended';return item;});
    return {now:now.toISOString(),asOf,total,limit,offset,hasMore:offset+items.length<total,items};
  }
  groups(options:FollowupListOptions={},now=new Date()) {
    const {limit,offset}=this.page(options,now),summary=this.aggregate(now);
    const rows=summary.groups.filter(r=>(!options.chain||r.chain===options.chain)&&(!options.decision||r.decision===options.decision));
    return {now:now.toISOString(),computedAt:summary.computedAt,total:rows.length,limit,offset,hasMore:offset+limit<rows.length,
      items:structuredClone(rows.slice(offset,offset+limit))};
  }
  learning(options:FollowupListOptions={},now=new Date()) {
    const {limit,offset}=this.page(options,now),summary=this.aggregate(now);
    const rank={consistent_association:0,needs_validation:1,not_replicated:2,collecting:3};
    const rows=summary.learning.filter(r=>(!options.chain||r.chain===options.chain)&&(!options.decision||r.decision===options.decision)&&
      (!options.status||r.status===options.status)).sort((a,b)=>rank[a.status]-rank[b.status]||a.chain.localeCompare(b.chain)||
      a.decision.localeCompare(b.decision)||a.policyVersion.localeCompare(b.policyVersion)||a.seconds-b.seconds||a.feature.localeCompare(b.feature));
    return {now:now.toISOString(),computedAt:summary.computedAt,total:rows.length,limit,offset,hasMore:offset+limit<rows.length,
      items:structuredClone(rows.slice(offset,offset+limit))};
  }
  /** Called by existing maintenance work, independent of dashboard visitors. */
  refresh(now:Date):void {
    const summary=this.aggregate(now);
    const previous=this.db.prepare("SELECT value FROM signal_followup_meta WHERE key='last_review_at'").get()?.value;
    if(previous===summary.computedAt)return;
    const review={version:summary.version,computedAt:summary.computedAt,total:summary.total,selected:summary.selected,
      sampled:summary.sampled,capacitySkipped:summary.capacitySkipped,active:summary.active,
      groups:summary.groups,learning:summary.learning,limitations:summary.limitations};
    this.db.prepare("INSERT INTO signal_followup_meta(key,value) VALUES ('last_review',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(review));
    this.db.prepare("INSERT INTO signal_followup_meta(key,value) VALUES ('last_review_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(summary.computedAt);
  }
  private buildSummary(now:Date) {
    const rows=this.db.prepare('SELECT summary_record FROM signal_followups ORDER BY registered_at,chain,address').all()
      .map(r=>JSON.parse(String(r.summary_record)) as OutcomeRecord);
    const grouped=new Map<string,OutcomeRecord[]>();
    for(const row of rows) {
      const key=JSON.stringify([row.chain,row.initial.decision,row.initial.policyVersion]);
      const list=grouped.get(key)??[];list.push(row);grouped.set(key,list);
    }
    const groups:FollowupGroup[]=[],learning:FollowupLearning[]=[];
    for(const list of grouped.values()) {
      const head=list[0],identity={chain:head.chain,decision:head.initial.decision,policyVersion:head.initial.policyVersion};
      const selected=list.filter(r=>r.selected);
      groups.push({...identity,count:list.length,selected:selected.length,horizons:HORIZONS.map(seconds=>{
        // Coverage is finalized only once the whole observation tolerance has elapsed.
        const mature=selected.filter(r=>Date.parse(r.registeredAt)+seconds*1000+TOLERANCE<=now.getTime());
        const metric=stats(mature,seconds);return {seconds,count:selected.length,mature:mature.length,
          covered:metric.covered,missing:metric.missing,medianGainPct:metric.medianGainPct,upRatePct:metric.upRatePct};
      })});
      for(const seconds of HORIZONS) {
        const mature=selected.filter(r=>Date.parse(r.registeredAt)+seconds*1000+TOLERANCE<=now.getTime());
        let split=Math.floor(mature.length*0.7);
        // Tied registration timestamps belong to the same temporal partition.
        while(split>0&&mature[split]&&mature[split-1].registeredAt===mature[split].registeredAt)split--;
        const validationRows=mature.slice(split),splitAt=validationRows[0]?.registeredAt;
        const earlyRows=mature.slice(0,split);
        // Validation tokens must arrive after every training outcome was knowable,
        // including the quote tolerance. Purge overlapping horizons, not just tokens.
        const trainRows=splitAt?earlyRows.filter(r=>Date.parse(r.registeredAt)+seconds*1000+TOLERANCE<=Date.parse(splitAt)):[];
        for(const feature of FEATURES) {
          const train=splitStats(trainRows,feature,seconds),validation=splitStats(validationRows,feature,seconds);
          const enough=train.present.covered>=20&&train.absent.covered>=20;
          const validated=validation.present.covered>=20&&validation.absent.covered>=20;
          let status:FollowupLearning['status']='collecting';
          if(enough)status=!validated?'needs_validation':train.medianDifferencePct!==0&&validation.medianDifferencePct!==0&&
            Math.sign(train.medianDifferencePct!)===Math.sign(validation.medianDifferencePct!)?'consistent_association':'not_replicated';
          learning.push({...identity,seconds,feature,status,train,validation,
            ...(splitAt?{splitAt}:{}),purgedTrainingCount:earlyRows.length-trainRows.length,minimumPerFeatureGroup:20,scope:'observational_correlation'});
        }
      }
    }
    const sampleTimes=rows.flatMap(r=>r.performance.latestAt?[r.performance.latestAt]:[]).sort();
    return {enabled:true,version:'signal-followup-v1',now:now.toISOString(),computedAt:now.toISOString(),updatedAt:now.toISOString(),
      refreshIntervalSec:60,scope:'observational_correlation',mode:'observation_only',selection:'first_arrivals_per_decision_with_capacity_limit',
      startedAt:this.db.prepare("SELECT value FROM signal_followup_meta WHERE key='started_at'").get()?.value??null,
      retentionDays:90,maxRecords:20000,maxActiveComparisonsPerDecision:3,
      total:rows.length,selected:rows.filter(r=>r.selected).length,
      active:rows.filter(r=>r.selected&&r.endsAt>now.toISOString()).length,
      sampled:rows.filter(r=>r.performance.samples>0).length,capacitySkipped:rows.filter(r=>!r.selected).length,
      lastSampleAt:sampleTimes.at(-1)??null,groups,learning,
      limitations:['SAMPLED_QUOTES_NOT_REALIZED_RETURNS','CAPACITY_LIMITED_NON_RANDOM_COHORT','CORRELATION_NOT_CAUSATION',
        'WALLET_IDENTITY_AND_SOCIAL_ENDORSEMENT_UNPROVEN','MISSING_HORIZONS_ARE_NOT_ZERO','NO_AUTOMATIC_POLICY_CHANGE']};
  }
}
