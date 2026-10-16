import type {DatabaseSync} from 'node:sqlite';
import type {Report} from './types.js';
import type {ScanPrice,ScanToken,ScanPerformance,ScanRecord} from './scan-archive.js';

export type ComparisonGroup='one_smart_group'|'profile_pending'|'no_confirmed_group';
interface Comparison extends ScanToken {
  scanId:string;registeredAt:string;endsAt:string;group:ComparisonGroup;policyVersion:string;
  basis:{reasons:string[];qualifiedGroups:number;walletStatus:string;profileStatus?:string};
  performance:Omit<ScanPerformance,'eligibleAt'>;horizons:Record<string,{at:string;gainPct:number;delaySec:number}>;
  peakDrawdownPct:number;
}
const GROUPS:ComparisonGroup[]=['one_smart_group','profile_pending','no_confirmed_group'];
const HORIZONS=[3600,21600,86400];

/** Forward control observations, never an entry authorization or a simulated fill. */
export class StrategyObservation {
  constructor(private readonly db:DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS strategy_comparisons(
      chain TEXT NOT NULL,address TEXT NOT NULL,registered_at TEXT NOT NULL,ends_at TEXT NOT NULL,
      cohort TEXT NOT NULL,last_attempt_at TEXT,record TEXT NOT NULL,samples INTEGER NOT NULL DEFAULT 0,
      gain_1h REAL,gain_6h REAL,gain_24h REAL,PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS strategy_comparisons_active ON strategy_comparisons(ends_at,cohort);`);
  }
  capture(report:Report,record:ScanRecord,now:Date):void {
    const evaluated=Date.parse(report.evaluatedAt),at=now.toISOString();
    if(report.mode!=='live'||report.decision!=='WATCH'||report.buyEligible||report.provenance.status!=='pass'||
      report.provenance.facts.modeSupported===false||report.safety.status!=='pass'||report.flow?.status!=='unknown'||
      !report.reasons.includes('WALLET_SUPPORT_NOT_PASSED')||
      report.reasons.some(r=>['SIGNAL_STALE','SIGNAL_TIME_IN_FUTURE','NARRATIVE_TOKEN_IDENTITY_CONFLICT',
        'WALLET_SETUP_SUPPORT_WITHDRAWN','LAUNCHPAD_MODE_NOT_SUPPORTED'].includes(r))||
      !Number.isFinite(evaluated)||evaluated>now.getTime()||now.getTime()-evaluated>60000||
      !(Date.parse(report.validUntil)>now.getTime()))return;
    if(this.db.prepare('SELECT 1 FROM strategy_comparisons WHERE chain=? AND address=?').get(record.chain,record.address)||
      this.db.prepare('SELECT 1 FROM scan_summaries WHERE chain=? AND address=? AND eligible_at IS NOT NULL LIMIT 1').get(record.chain,record.address))return;
    const n=record.wallets?.summary.qualifiedSmartFundingClusterCount??0;
    const group:ComparisonGroup=n===1?'one_smart_group':record.walletScreening?.setups.some(s=>s.status==='watch'&&s.priorityScore>0)?'profile_pending':'no_confirmed_group';
    // First arrivals per group, two concurrent tokens each. At one quote/minute this
    // leaves room inside the ten-minute horizon tolerance; outages remain missing.
    if(Number(this.db.prepare('SELECT count(*) AS n FROM strategy_comparisons WHERE cohort=? AND ends_at>?').get(group,at)!.n)>=2)return;
    const value:Comparison={chain:record.chain,address:record.address,scanId:record.id,registeredAt:at,
      endsAt:new Date(now.getTime()+86400000+600000).toISOString(),group,policyVersion:report.policyVersion,
      basis:{reasons:record.reasons,qualifiedGroups:n,walletStatus:record.checks.wallets.status,profileStatus:record.walletScreening?.status},
      performance:{samples:0,status:'waiting',points:[]},horizons:{},peakDrawdownPct:0};
    this.db.prepare('INSERT INTO strategy_comparisons(chain,address,registered_at,ends_at,cohort,last_attempt_at,record) VALUES (?,?,?,?,?,?,?)')
      .run(value.chain,value.address,at,value.endsAt,group,null,JSON.stringify(value));
  }
  pending(now:Date,limit=12):ScanToken[] {
    return this.db.prepare(`SELECT chain,address FROM strategy_comparisons WHERE ends_at>?
      ORDER BY COALESCE(last_attempt_at,''),registered_at,chain,address LIMIT ?`).all(now.toISOString(),limit)
      .map(r=>({chain:r.chain as ScanToken['chain'],address:String(r.address)}));
  }
  scheduled(now:Date):Array<ScanToken&{lastAttemptAt?:string}> {
    return this.db.prepare('SELECT chain,address,last_attempt_at FROM strategy_comparisons WHERE ends_at>? ORDER BY COALESCE(last_attempt_at,\'\'),registered_at LIMIT 12')
      .all(now.toISOString()).map(r=>({chain:r.chain as ScanToken['chain'],address:String(r.address),
        ...(typeof r.last_attempt_at==='string'?{lastAttemptAt:r.last_attempt_at}:{})}));
  }
  price(price:ScanPrice,now:Date):void {
    if(!['gmgn_token_info_sample','chain_pool_sample','dexscreener_token_pairs_sample','ave_price_stream_sample','debot_token_info_sample'].includes(price.source)||now.getTime()-Date.parse(price.observedAt)>120000)return;
    const row=this.db.prepare('SELECT record,last_attempt_at FROM strategy_comparisons WHERE chain=? AND address=? AND ends_at>?')
      .get(price.chain,price.address,now.toISOString());if(!row)return;
    const value=JSON.parse(String(row.record)) as Comparison,p=value.performance,at=price.observedAt,ms=Date.parse(at);
    if(ms<=Date.parse(value.registeredAt)||p.latestAt&&at<=p.latestAt||row.last_attempt_at&&at<String(row.last_attempt_at))return;
    // Preserve bounded sampling even when a later eligible token receives frequent pool updates.
    if(p.latestAt&&ms-Date.parse(p.latestAt)<30000)return;
    const base=p.baselinePriceUsd??price.priceUsd,gain=(price.priceUsd/base-1)*100;
    const peak=Math.max(p.peakPriceUsd??price.priceUsd,price.priceUsd),peakAt=peak===price.priceUsd?at:p.peakAt!;
    if(!Number.isFinite(gain)||!Number.isFinite((peak/base-1)*100))return;
    const points=[...p.points,{at,priceUsd:price.priceUsd}];
    value.performance={...p,baselineAt:p.baselineAt??at,baselinePriceUsd:base,latestAt:at,latestPriceUsd:price.priceUsd,
      peakPriceUsd:peak,peakAt,maxGainPct:(peak/base-1)*100,currentGainPct:gain,samples:p.samples+1,source:price.source,
      status:'tracking',error:undefined,maxSampleGapSec:Math.max(p.maxSampleGapSec??0,p.latestAt?(ms-Date.parse(p.latestAt))/1000:0),
      points:points.length<=256?points:points.filter((x,i)=>i===0||i===points.length-1||i%2===0||x.at===peakAt)};
    value.peakDrawdownPct=Math.max(value.peakDrawdownPct,(1-price.priceUsd/peak)*100);
    // Fixed horizons start at registration, not at the potentially delayed first price.
    for(const seconds of HORIZONS) {
      const delay=(ms-Date.parse(value.registeredAt))/1000-seconds;
      if(!value.horizons[String(seconds)]&&delay>=0&&delay<=600&&
        Date.parse(value.performance.baselineAt!)-Date.parse(value.registeredAt)<=600000)
        value.horizons[String(seconds)]={at,gainPct:gain,delaySec:delay};
    }
    this.db.prepare('UPDATE strategy_comparisons SET record=?,last_attempt_at=?,samples=?,gain_1h=?,gain_6h=?,gain_24h=? WHERE chain=? AND address=?')
      .run(JSON.stringify(value),at,value.performance.samples,...HORIZONS.map(seconds=>value.horizons[String(seconds)]?.gainPct??null),price.chain,price.address);
  }
  error(token:ScanToken,reason:string,now:Date):void {
    const at=now.toISOString(),row=this.db.prepare('SELECT record FROM strategy_comparisons WHERE chain=? AND address=? AND ends_at>? AND COALESCE(last_attempt_at,\'\')<=?')
      .get(token.chain,token.address,at,at);if(!row)return;
    const value=JSON.parse(String(row.record)) as Comparison;
    value.performance={...value.performance,status:'unavailable',error:reason,lastError:reason,lastErrorAt:at,
      errorCount:Math.min(1000000000,(value.performance.errorCount??0)+1)};
    this.db.prepare('UPDATE strategy_comparisons SET record=?,last_attempt_at=? WHERE chain=? AND address=?')
      .run(JSON.stringify(value),at,token.chain,token.address);
  }
  prune(now:Date):void {
    this.db.prepare('DELETE FROM strategy_comparisons WHERE registered_at<?').run(new Date(now.getTime()-30*86400000).toISOString());
    this.db.exec('DELETE FROM strategy_comparisons WHERE rowid NOT IN (SELECT rowid FROM strategy_comparisons ORDER BY registered_at DESC LIMIT 1000)');
  }
  summary(now:Date) {
    const totals=this.db.prepare(`SELECT count(*) AS registered,SUM(ends_at>?) AS active,
      SUM(samples>0) AS sampled FROM strategy_comparisons`).get(now.toISOString())!;
    const metrics=this.db.prepare('SELECT cohort,gain_1h,gain_6h,gain_24h FROM strategy_comparisons').all();
    const rows=this.db.prepare('SELECT record FROM strategy_comparisons ORDER BY registered_at DESC LIMIT 12').all()
      .map(r=>JSON.parse(String(r.record)) as Comparison);
    return {mode:'observation_only',selection:'first_arrivals_per_group_with_capacity_limit',maxActive:6,
      registered:Number(totals.registered),active:Number(totals.active??0),sampled:Number(totals.sampled??0),
      groups:GROUPS.map(group=>({group,registered:metrics.filter(r=>r.cohort===group).length,
        horizons:HORIZONS.map((seconds,i)=>{
          const column=['gain_1h','gain_6h','gain_24h'][i];
          const values=metrics.filter(r=>r.cohort===group&&r[column]!==null).map(r=>Number(r[column])).sort((a,b)=>a-b);
          return {seconds,covered:values.length,medianGainPct:values.length?(values[Math.floor(values.length/2)]+values[Math.floor((values.length-1)/2)])/2:null};
        })})),
      items:rows.slice(0,12).map(r=>({...r,performance:{...r.performance,points:undefined,
        status:r.endsAt<=now.toISOString()?'ended':r.performance.status}}))};
  }
}
