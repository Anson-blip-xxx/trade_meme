import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Signal} from './types.js';
import {normalizePriceToken} from './market-price-normalizers.js';
import {normalizeAvePerformance,normalizeDebotPerformance,type VendorSignalPerformance} from './providers/vendor-performance.js';

type Observation={signal:Signal;observedAt:string;vendorPerformance?:VendorSignalPerformance};
const DAYS_30=30*86400_000;
const iso=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&
  Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;

/** Retrospective supplier statistics are stored outside notification identity,
 * event counts, research scheduling and local-price history. A later correction
 * is a new snapshot; neither the old value nor its receipt time is rewritten. */
export class VendorPerformanceLedger {
  private lastPruned=0;
  constructor(private readonly db:DatabaseSync,private readonly now:()=>Date=()=>new Date()) {
    db.exec(`CREATE TABLE IF NOT EXISTS vendor_performance_snapshots (
      id INTEGER PRIMARY KEY,provider TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,
      event_id TEXT NOT NULL,reported_at TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,
      UNIQUE(provider,chain,address,reported_at,fingerprint));
      CREATE INDEX IF NOT EXISTS vendor_performance_token ON vendor_performance_snapshots(provider,chain,address,reported_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS vendor_performance_time ON vendor_performance_snapshots(reported_at DESC,id DESC);`);
  }
  record(observation:Observation):boolean {
    const input=observation.vendorPerformance;if(!input)return false;
    const source=observation.signal?.source,token=normalizePriceToken(observation.signal?.token),now=this.now().getTime();
    if(!token||(source!=='ave'&&source!=='debot')||input.provider!==source||input.scope!=='vendor_reported_retrospective'||
      !new RegExp(`^${source}:signal:[a-f0-9]{64}$`).test(observation.signal.sourceEventId)||
      !iso(observation.observedAt)||input.reportedAt!==observation.observedAt||!Number.isFinite(now)||
      Date.parse(input.reportedAt)>now||now-Date.parse(input.reportedAt)>DAYS_30)return false;
    if(input.firstSignalAt!==undefined&&!iso(input.firstSignalAt))return false;
    const first=input.firstSignalAt===undefined?undefined:Date.parse(input.firstSignalAt)/1000;
    // Rebuild from a fixed schema; no arbitrary provider payload, URL or secret
    // may enter the durable snapshot, and inconsistent units/derived values fail.
    const value=source==='debot'?normalizeDebotPerformance({max_price_gain:input.maxGainRaw,
      first_time:first,first_price:input.firstPriceUsd,max_price:input.maxPriceUsd},new Date(input.reportedAt)):
      normalizeAvePerformance({max_price_change:input.maxGainRaw,first_signal_time:first,
        day_high_price:input.dayHighPriceUsd},new Date(input.reportedAt));
    if(!value)return false;
    const fields:(keyof VendorSignalPerformance)[]=['provider','reportedAt','scope','maxGainRaw','maxGainValue','maxGainUnit',
      'maxGainPct','maxGainDisplay','firstSignalAt','firstPriceUsd','maxPriceUsd','dayHighPriceUsd'];
    if(fields.some(key=>input[key]!==value[key]))return false;
    const {reportedAt,...content}=value;
    const fingerprint=createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const latest=this.db.prepare(`SELECT reported_at,fingerprint FROM vendor_performance_snapshots
      WHERE provider=? AND chain=? AND address=? ORDER BY reported_at DESC,id DESC LIMIT 1`).get(source,token.chain,token.address);
    if(latest&&(String(latest.reported_at)>reportedAt||latest.fingerprint===fingerprint))return false;
    const prune=!this.lastPruned||now-this.lastPruned>=60_000;
    this.db.exec('SAVEPOINT vendor_performance_record');
    try {
      if(prune)this.db.prepare('DELETE FROM vendor_performance_snapshots WHERE reported_at<?')
        .run(new Date(now-DAYS_30).toISOString());
      const result=this.db.prepare(`INSERT OR IGNORE INTO vendor_performance_snapshots
        (provider,chain,address,event_id,reported_at,fingerprint,data) VALUES(?,?,?,?,?,?,?)`)
        .run(source,token.chain,token.address,observation.signal.sourceEventId,reportedAt,fingerprint,JSON.stringify(value));
      this.db.exec(`DELETE FROM vendor_performance_snapshots WHERE id IN
        (SELECT id FROM vendor_performance_snapshots ORDER BY reported_at DESC,id DESC LIMIT -1 OFFSET 20000)`);
      this.db.exec('RELEASE vendor_performance_record');if(prune)this.lastPruned=now;
      return Number(result.changes)>0;
    }catch(error){this.db.exec('ROLLBACK TO vendor_performance_record; RELEASE vendor_performance_record');throw error;}
  }
}
