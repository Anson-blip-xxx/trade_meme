import {priceEvidence} from './price-evidence.js';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import {ADAPTIVE_SHADOW_V1,ADAPTIVE_SHADOW_V2,ADAPTIVE_SHADOW_V3,ADAPTIVE_SHADOW_V4,ADAPTIVE_SHADOW_V5,adaptiveExitPolicy,adaptiveExitDeadline,migrateAdaptiveExitToV3,stepAdaptiveExit,type AdaptiveExitState,type WalletPressure} from './adaptive-exit.js';
import type {Chain} from './types.js';
import type {ScanPrice,ScanToken} from './scan-archive.js';
import {shadowReturn} from './exit-shadow-return.js';
import {readPositionExitQuality} from './exit-quality.js';
import {configureResearchWal} from './research-sqlite.js';

export interface ExitObservationSeed {candidateId:string;eligibleAt:string;endsAt:string;symbol?:string;}
export interface ExitShadowOptions {maxBytes?:number;staleAfterSec?:number;maxPositions?:number;now?:()=>Date;}
interface ShadowRow {
  id:string;chain:Chain;address:string;candidate_id:string;eligible_at:string;ends_at:string;symbol:string|null;
  started_at:string;updated_at:string;phase:'tracking'|'triggered'|'ended'|'exit_pending';state:string;
  last_price_at:string;last_price:number;error:string|null;error_at:string|null;
}
export interface ShadowEvent {
  at:string;kind:string;reason:string;observationOnly:true;sellPct?:number;gainPct?:number;
  priceUsd?:number;protectionPriceUsd?:number;remainingPct?:number;peakPriceUsd?:number;
  policyVersion?:string;previousPolicyVersion?:string;effectiveAt?:string;dueAt?:string;
  reasons?:string[];stageGainsPct?:number[];
  source?:string;poolAddress?:string;
}
interface ShadowSampleSnapshot {at:string;priceUsd:number;source:string;poolAddress?:string;}
interface ShadowSampleStatsRow {
  evaluated_samples:number;stored_samples:number;samples_thinned:number;
  retention_started_at:string;last_pruned_at:string;
}
interface ShadowPriceQuarantine {
  basePriceUsd:number;candidatePriceUsd:number;direction:'up'|'down';observedAt:string;source:string;poolAddress?:string;
}
type ShadowQuarantineDecision='accept'|'accept_and_clear'|'quarantined';
export interface ShadowExitIntent {
  requestedAt:string;dueAt:string;reason:string;sellPctRemaining:100;remainingPctOfInitial:number;
  peakPriceUsd:number;policyVersion:string;observedAt?:string;observedPriceUsd?:number;cancelledAt?:string;cancelReason?:string;
}
const continuousPolicy=(version:string)=>version===ADAPTIVE_SHADOW_V2.version||version===ADAPTIVE_SHADOW_V3.version||
  version===ADAPTIVE_SHADOW_V4.version||version===ADAPTIVE_SHADOW_V5.version;
// Exit quality reads the 5/15/60-minute marks and accepts a quote for up to
// 120 seconds after each mark. Quotes after the final window add no evidence.
const CLOSED_COMPARISON_HORIZON_MS=(60*60+120)*1000;
// Raw observations are an audit aid, never policy state. Keep a short exact
// window, then progressively coarsen it. The hard unpinned cap also bounds a
// burst whose quote rate is much higher than the usual stream cadence.
const SAMPLE_RETENTION_VERSION='tiered-v1';
const SAMPLE_PRUNE_INTERVAL_MS=15*60_000;
const SAMPLE_RECENT_WINDOW_MS=15*60_000;
const SAMPLE_MID_WINDOW_MS=6*60*60_000;
const SAMPLE_LONG_WINDOW_MS=24*60*60_000;
const SAMPLE_MID_BUCKET_SEC=5*60;
const SAMPLE_LONG_BUCKET_SEC=30*60;
const SAMPLE_RECENT_MAX=1024;
const SAMPLE_UNPINNED_MAX=2048;
const SAMPLE_PROTECTED_SQL=`(
  s.at=(SELECT p.started_at FROM exit_shadow_positions p WHERE p.id=s.position_id)
  OR EXISTS (SELECT 1 FROM exit_shadow_sample_pins pin WHERE pin.position_id=s.position_id AND pin.at=s.at)
  OR EXISTS (SELECT 1 FROM exit_shadow_events e WHERE e.position_id=s.position_id AND e.at=s.at
    AND json_extract(e.data,'$.kind') IN ('partial_exit','full_exit'))
  OR EXISTS (SELECT 1 FROM exit_shadow_positions p WHERE p.id=s.position_id
    AND json_extract(p.state,'$.shadowClosed')=1 AND (
      CAST(strftime('%s',s.at) AS INTEGER) BETWEEN CAST(strftime('%s',json_extract(p.state,'$.lastObservedAt')) AS INTEGER)+300 AND CAST(strftime('%s',json_extract(p.state,'$.lastObservedAt')) AS INTEGER)+420
      OR CAST(strftime('%s',s.at) AS INTEGER) BETWEEN CAST(strftime('%s',json_extract(p.state,'$.lastObservedAt')) AS INTEGER)+900 AND CAST(strftime('%s',json_extract(p.state,'$.lastObservedAt')) AS INTEGER)+1020
      OR CAST(strftime('%s',s.at) AS INTEGER) BETWEEN CAST(strftime('%s',json_extract(p.state,'$.lastObservedAt')) AS INTEGER)+3600 AND CAST(strftime('%s',json_extract(p.state,'$.lastObservedAt')) AS INTEGER)+3720
    ))
)`;
export const EXIT_SHADOW_SAMPLE_RETENTION=Object.freeze({version:SAMPLE_RETENTION_VERSION,
  pruneIntervalMs:SAMPLE_PRUNE_INTERVAL_MS,recentWindowMs:SAMPLE_RECENT_WINDOW_MS,midWindowMs:SAMPLE_MID_WINDOW_MS,
  longWindowMs:SAMPLE_LONG_WINDOW_MS,midBucketSec:SAMPLE_MID_BUCKET_SEC,longBucketSec:SAMPLE_LONG_BUCKET_SEC,
  recentMax:SAMPLE_RECENT_MAX,unpinnedMax:SAMPLE_UNPINNED_MAX,protectedSql:SAMPLE_PROTECTED_SQL});
const timeExitReason=(reason:string)=>reason==='MAX_HOLDING_TIME_OBSERVED'||reason==='OBSERVATION_WINDOW_END_OBSERVED';
const stamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));
const clean=(value:unknown,max=80)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max):undefined;
const code=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(value)?value:'PRICE_SAMPLE_UNAVAILABLE';
function identity(value:ScanToken):ScanToken|undefined {
  if(!value||!['bsc','solana','robinhood'].includes(value.chain)||typeof value.address!=='string')return;
  if(value.chain==='solana')try {const decoded=bs58.decode(value.address);return decoded.length===32&&decoded.some(x=>x!==0)?{...value}:undefined;}catch{return;}
  return /^0x[0-9a-fA-F]{40}$/.test(value.address)&&!/^0x0{40}$/i.test(value.address)?{chain:value.chain,address:value.address.toLowerCase()}:undefined;
}
function poolAddress(price:ScanPrice):string|undefined {
  const pool=price.metadata?.pool??price.market?.poolAddress;
  if(typeof pool!=='string')return;
  if(price.chain==='solana')try {const bytes=bs58.decode(pool);return bytes.length===32&&bytes.some(byte=>byte!==0)?pool:undefined;}catch{return;}
  return /^0x[0-9a-fA-F]{40}$/.test(pool)&&!/^0x0{40}$/i.test(pool)?pool.toLowerCase():undefined;
}

/** Forward-only research. This class cannot quote, sign, submit, or verify protection for a real holding. */
export class ExitShadow {
  private readonly db:DatabaseSync;
  private readonly now:()=>Date;
  private readonly maxBytes:number;
  private readonly maxPages:number;
  private readonly staleMs:number;
  private readonly maxPositions:number;
  private lastError?:string;
  private persistedFailure?:string;
  private sampleCount=0;
  private evaluatedSampleCount=0;
  private thinnedPositions=0;
  private eventCount=0;
  constructor(private readonly path:string,options:ExitShadowOptions={}) {
    this.now=options.now??(()=>new Date());this.maxBytes=options.maxBytes??128*1024*1024;
    this.staleMs=(options.staleAfterSec??180)*1000;this.maxPositions=options.maxPositions??1000;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<16384||!Number.isSafeInteger(this.staleMs)||this.staleMs<1000||
      !Number.isSafeInteger(this.maxPositions)||this.maxPositions<1||this.maxPositions>10000)throw new Error('EXIT_SHADOW_CONFIG_INVALID');
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    configureResearchWal(this.db,{busyTimeoutMs:5000,autoCheckpointPages:128});
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exit_shadow_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exit_shadow_positions(id TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,
        candidate_id TEXT NOT NULL,eligible_at TEXT NOT NULL,ends_at TEXT NOT NULL,symbol TEXT,started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,phase TEXT NOT NULL,state TEXT NOT NULL,last_price_at TEXT NOT NULL,last_price REAL NOT NULL,error TEXT,error_at TEXT,
        UNIQUE(chain,address,candidate_id));
      CREATE INDEX IF NOT EXISTS exit_shadow_token ON exit_shadow_positions(chain,address,started_at DESC);
      CREATE INDEX IF NOT EXISTS exit_shadow_page ON exit_shadow_positions(started_at DESC,id);
      CREATE INDEX IF NOT EXISTS exit_shadow_chain_page ON exit_shadow_positions(chain,started_at DESC,id);
      CREATE TABLE IF NOT EXISTS exit_shadow_samples(position_id TEXT NOT NULL,at TEXT NOT NULL,price REAL NOT NULL,
        source TEXT NOT NULL,context TEXT NOT NULL,PRIMARY KEY(position_id,at));
      CREATE TABLE IF NOT EXISTS exit_shadow_sample_stats(position_id TEXT PRIMARY KEY,evaluated_samples INTEGER NOT NULL,
        stored_samples INTEGER NOT NULL,samples_thinned INTEGER NOT NULL,retention_started_at TEXT NOT NULL,last_pruned_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exit_shadow_sample_pins(position_id TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL,
        PRIMARY KEY(position_id,reason));
      CREATE INDEX IF NOT EXISTS exit_shadow_sample_pin_time ON exit_shadow_sample_pins(position_id,at);
      CREATE TABLE IF NOT EXISTS exit_shadow_events(id INTEGER PRIMARY KEY,position_id TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS exit_shadow_event_position ON exit_shadow_events(position_id,id DESC);
      CREATE INDEX IF NOT EXISTS exit_shadow_event_return ON exit_shadow_events(position_id,id)
        WHERE json_extract(data,'$.kind') IN ('partial_exit','full_exit');
      CREATE INDEX IF NOT EXISTS exit_shadow_event_return_time ON exit_shadow_events(position_id,at)
        WHERE json_extract(data,'$.kind') IN ('partial_exit','full_exit');
      CREATE TABLE IF NOT EXISTS exit_shadow_event_samples(event_id INTEGER NOT NULL,relation INTEGER NOT NULL,
        position_id TEXT NOT NULL,at TEXT NOT NULL,price REAL NOT NULL,source TEXT NOT NULL,pool_address TEXT,
        PRIMARY KEY(event_id,relation));
      CREATE INDEX IF NOT EXISTS exit_shadow_event_sample_position ON exit_shadow_event_samples(position_id,event_id,relation);
      CREATE TABLE IF NOT EXISTS exit_shadow_metrics(position_id TEXT PRIMARY KEY,peak_price REAL NOT NULL,
        max_gap_sec REAL NOT NULL,last_source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exit_shadow_exit_intents(position_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exit_shadow_policy_history(position_id TEXT NOT NULL,effective_at TEXT NOT NULL,
        previous_policy TEXT NOT NULL,policy TEXT NOT NULL,previous_state TEXT NOT NULL,PRIMARY KEY(position_id,effective_at));
      CREATE TABLE IF NOT EXISTS exit_shadow_price_quarantine(position_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS exit_shadow_open ON exit_shadow_positions(phase,last_price_at,id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS exit_shadow_quality_closed_at
      ON exit_shadow_positions(json_extract(state,'$.lastObservedAt') DESC,id) WHERE phase='triggered';`);
    // Derived display aggregates only: backfill from actual retained observations
    // once, without changing adaptive policy state or replaying exit decisions.
    this.db.exec(`INSERT OR IGNORE INTO exit_shadow_metrics(position_id,peak_price,max_gap_sec,last_source)
      SELECT p.id,COALESCE(MAX(s.price),p.last_price),COALESCE(MAX(json_extract(s.context,'$.gapSec')),0),
        COALESCE((SELECT source FROM exit_shadow_samples WHERE position_id=p.id ORDER BY at DESC LIMIT 1),'')
      FROM exit_shadow_positions p LEFT JOIN exit_shadow_samples s ON s.position_id=p.id
      WHERE NOT EXISTS (SELECT 1 FROM exit_shadow_metrics m WHERE m.position_id=p.id) GROUP BY p.id;`);
    const retentionStartedAt=this.now().toISOString();
    // Existing rows begin in an explicitly unthinned state. Online retention
    // only touches observations accepted after this deployment boundary; the
    // older archive is compacted separately while the service is offline.
    this.db.prepare(`INSERT OR IGNORE INTO exit_shadow_sample_stats
      SELECT p.id,count(s.at),count(s.at),0,?,? FROM exit_shadow_positions p
      LEFT JOIN exit_shadow_samples s ON s.position_id=p.id
      WHERE NOT EXISTS (SELECT 1 FROM exit_shadow_sample_stats x WHERE x.position_id=p.id)
      GROUP BY p.id`).run(retentionStartedAt,retentionStartedAt);
    this.db.prepare('INSERT OR IGNORE INTO exit_shadow_meta VALUES (?,?)').run('started_at',this.now().toISOString());
    this.db.prepare('INSERT OR IGNORE INTO exit_shadow_meta VALUES (?,?)').run('history_complete','true');
    this.db.prepare('INSERT OR REPLACE INTO exit_shadow_meta VALUES (?,?)').run('sample_retention_version',SAMPLE_RETENTION_VERSION);
    const pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    const pageCount=Number(this.db.prepare('PRAGMA page_count').get()!.page_count);
    this.maxPages=Math.max(pageCount,Math.floor(this.maxBytes/pageSize));
    this.db.exec(`PRAGMA max_page_count=${this.maxPages}`);
    // An offline VACUUM/compaction can restore physical headroom without a
    // configuration change. Clear only the capacity alarm; the independent
    // history_complete=false audit marker remains durable.
    if(this.hasLogicalCapacity(16384)&&this.meta('last_error')==='EXIT_SHADOW_CAPACITY_REACHED')
      this.db.prepare("DELETE FROM exit_shadow_meta WHERE key='last_error'").run();
    this.db.prepare('INSERT OR REPLACE INTO exit_shadow_meta VALUES (?,?)').run('max_bytes',String(this.maxBytes));
    const storedFailure=this.meta('last_error');
    if(storedFailure&&this.meta('history_complete')==='false')this.lastError=this.persistedFailure=storedFailure;
    // Historical totals are initialized once. All later writes below update the
    // in-memory counters after COMMIT, so dashboard summary calls never scan the
    // growing sample table on the event-loop thread.
    this.sampleCount=Number(this.db.prepare('SELECT count(*) AS n FROM exit_shadow_samples').get()!.n);
    const sampleStats=this.db.prepare(`SELECT COALESCE(sum(evaluated_samples),0) AS evaluated,
      COALESCE(sum(samples_thinned<>0),0) AS thinned FROM exit_shadow_sample_stats`).get()!;
    this.evaluatedSampleCount=Number(sampleStats.evaluated);this.thinnedPositions=Number(sampleStats.thinned);
    this.eventCount=Number(this.db.prepare('SELECT count(*) AS n FROM exit_shadow_events').get()!.n);
  }

  recordPrice(price:ScanPrice,seed:ExitObservationSeed|undefined,pressure?:WalletPressure):void {
    const target=identity(price),now=this.now();
    if(!target||!Number.isFinite(price.priceUsd)||price.priceUsd<=0||!stamp(price.observedAt)||
      !['gmgn_token_info_sample','chain_pool_sample','dexscreener_token_pairs_sample','ave_price_stream_sample','debot_token_info_sample'].includes(price.source)||Date.parse(price.observedAt)>now.getTime()||
      now.getTime()-Date.parse(price.observedAt)>ADAPTIVE_SHADOW_V1.maxPriceAgeMs||
      Date.parse(price.observedAt)<Date.parse(this.meta('started_at')!))return;
    const evidence=price.source==='chain_pool_sample'?priceEvidence(price):undefined;
    if(price.source==='chain_pool_sample'&&!evidence)return;
    const at=new Date(price.observedAt).toISOString();
    let previous=this.current(target);
    if(previous&&at<=previous.last_price_at)return;
    let state:AdaptiveExitState|undefined;
    if(previous)try{state=JSON.parse(previous.state) as AdaptiveExitState;}catch{this.fail('EXIT_SHADOW_STATE_INVALID');}
    // A closed episode owns this contract's quotes through the complete
    // 5/15/60-minute quality window. Its original signal end may pass shortly
    // after the exit, but rolling then would redirect the remaining comparison
    // quotes to the new episode because current() selects only the latest row.
    const canRollClosed=!!(previous&&state?.shadowClosed&&
      Date.parse(at)>Date.parse(state.lastObservedAt)+CLOSED_COMPARISON_HORIZON_MS);
    const canRollLegacy=!!(previous&&state&&!state.shadowClosed&&!continuousPolicy(state.policyVersion)&&
      Date.parse(previous.ends_at)<=now.getTime());
    if(previous&&(canRollClosed||canRollLegacy)&&seed&&seed.candidateId!==previous.candidate_id&&
      stamp(seed.eligibleAt)&&Date.parse(seed.eligibleAt)>Date.parse(previous.eligible_at)){previous=undefined;state=undefined;}
    if(!previous&&(!seed||!stamp(seed.eligibleAt)||!stamp(seed.endsAt)||Date.parse(seed.eligibleAt)>Date.parse(at)||
      Date.parse(seed.endsAt)<=now.getTime()||typeof seed.candidateId!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(seed.candidateId)))return;
    // A later candidate on the same CA is admitted before the old comparison
    // horizon gate. Only another quote for the already-closed episode stops.
    if(previous&&state?.shadowClosed&&Date.parse(at)>Date.parse(state.lastObservedAt)+CLOSED_COMPARISON_HORIZON_MS)return;
    // A finished observation is not silently reopened for the same old candidate.
    if(previous&&state&&!continuousPolicy(state.policyVersion)&&
      (previous.phase==='ended'||Date.parse(previous.ends_at)<=now.getTime()))return;
    // Preserve all previous samples; only future comparison ticks after simulated closure are capped.
    if(previous&&state?.shadowClosed&&Date.parse(at)-Date.parse(previous.last_price_at)<60_000)return;
    // A failed deployment migration must never resume a retired time-exit policy.
    if(state&&!state.shadowClosed&&state.policyVersion!==ADAPTIVE_SHADOW_V3.version&&state.policyVersion!==ADAPTIVE_SHADOW_V4.version&&
      state.policyVersion!==ADAPTIVE_SHADOW_V5.version)
      this.fail('EXIT_SHADOW_POLICY_MIGRATION_REQUIRED');
    // Version selection is forward-only: existing episodes retain their exact
    // rules, while only newly admitted episodes start on V5.
    const policy=state?adaptiveExitPolicy(state.policyVersion):ADAPTIVE_SHADOW_V5;
    if(!policy)this.fail('EXIT_SHADOW_STATE_INVALID');
    const pool=poolAddress(price);
    const quarantine=previous?this.quarantineExtreme(previous,state!,price.source,pool,evidence,price.priceUsd,at):'accept';
    if(quarantine==='quarantined')return;
    const observation={...target,priceUsd:price.priceUsd,observedAt:at,evaluatedAt:now.toISOString(),source:price.source,
      metadata:evidence,...(pool?{poolAddress:pool}:{}),...(!previous?{observationEndsAt:seed!.endsAt}:{})};
    const result=stepAdaptiveExit(state,observation,pressure,policy);
    if(result.status==='ignored'&&result.ignoredReason!=='SHADOW_CLOSED') {
      if(!['DUPLICATE_SAMPLE','TIME_REGRESSED','PRICE_STALE','PRICE_FROM_FUTURE'].includes(result.ignoredReason??''))
        this.fail('EXIT_SHADOW_STATE_INVALID');
      return;
    }
    const next=result.state??state;if(!next)return;
    // Closed simulations still collect comparison prices. Their arithmetic must
    // remain valid even though the model no longer advances its own state.
    if(!Number.isFinite((price.priceUsd/next.baselinePriceUsd-1)*100))this.fail('EXIT_SHADOW_PRICE_ARITHMETIC_INVALID');
    const context={priceEvidence:evidence,poolAddress:poolAddress(price),policyVersion:next.policyVersion,protectionPriceUsd:next.protectionPriceUsd,
      protectionActive:next.protectionActive,activationGainPct:next.activationGainPct,trailPct:next.drawdownPct,
      remainingPct:next.remainingPctOfInitial,shadowClosed:next.shadowClosed,volatilityPctPerMinute:next.volatilityPctPerMinute,
      gapSec:previous?(Date.parse(at)-Date.parse(previous.last_price_at))/1000:0,
      walletPressure:next.walletPressure,pressureIgnoredReason:result.ignoredPressureReason};
    try {
      const requiredBytes=JSON.stringify(context).length*3+JSON.stringify(next).length*3+16384;
      if(!this.ensureCapacity(previous?.id,at,requiredBytes))
        throw new Error('EXIT_SHADOW_CAPACITY_REACHED');
      if(!previous&&Number(this.db.prepare('SELECT count(*) AS n FROM exit_shadow_positions').get()!.n)>=this.maxPositions)
        throw new Error('EXIT_SHADOW_POSITION_CAPACITY_REACHED');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const id=previous?.id??randomUUID();
        if(!previous){
          this.db.prepare('INSERT INTO exit_shadow_positions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,target.chain,target.address,
            seed!.candidateId,new Date(seed!.eligibleAt).toISOString(),new Date(seed!.endsAt).toISOString(),clean(seed!.symbol)??null,
            at,at,'tracking',JSON.stringify(next),at,price.priceUsd,null,null);
          this.db.prepare('INSERT INTO exit_shadow_sample_stats VALUES (?,?,?,?,?,?)').run(id,0,0,0,at,at);
        }
        const inserted=this.db.prepare('INSERT OR IGNORE INTO exit_shadow_samples VALUES (?,?,?,?,?)')
          .run(id,at,price.priceUsd,price.source,JSON.stringify(context));
        if(!Number(inserted.changes)){this.db.exec('COMMIT');return;}
        this.db.prepare(`UPDATE exit_shadow_sample_stats SET evaluated_samples=evaluated_samples+1,
          stored_samples=stored_samples+1 WHERE position_id=?`).run(id);
        const currentSample:ShadowSampleSnapshot={at,priceUsd:price.priceUsd,source:price.source,...(pool?{poolAddress:pool}:{})};
        this.completeEventNeighbors(id,currentSample);
        if(quarantine==='accept_and_clear')
          this.db.prepare('DELETE FROM exit_shadow_price_quarantine WHERE position_id=?').run(id);
        const priorMetrics=this.db.prepare('SELECT peak_price,max_gap_sec FROM exit_shadow_metrics WHERE position_id=?').get(id);
        const pin=this.db.prepare('INSERT OR REPLACE INTO exit_shadow_sample_pins VALUES (?,?,?)');
        if(!priorMetrics||price.priceUsd>Number(priorMetrics.peak_price))pin.run(id,'peak',at);
        if(!priorMetrics||context.gapSec>Number(priorMetrics.max_gap_sec))pin.run(id,'max_gap',at);
        this.db.prepare(`INSERT INTO exit_shadow_metrics(position_id,peak_price,max_gap_sec,last_source) VALUES (?,?,?,?)
          ON CONFLICT(position_id) DO UPDATE SET peak_price=MAX(peak_price,excluded.peak_price),
          max_gap_sec=MAX(max_gap_sec,excluded.max_gap_sec),last_source=excluded.last_source`)
          .run(id,price.priceUsd,context.gapSec,price.source);
        let eventsAdded=0;
        const emit=(event:ShadowEvent)=>{const insertedEvent=this.db.prepare('INSERT INTO exit_shadow_events(position_id,at,data) VALUES (?,?,?)')
          .run(id,event.at,JSON.stringify(event));eventsAdded+=Number(insertedEvent.changes);
          this.captureEventNeighbors(Number(insertedEvent.lastInsertRowid),id,currentSample);};
        if(!previous)emit({at,kind:'initialized',reason:'SHADOW_STARTED',observationOnly:true,priceUsd:price.priceUsd,gainPct:0,remainingPct:100,policyVersion:next.policyVersion,effectiveAt:next.policyEffectiveAt,dueAt:adaptiveExitDeadline(next)?.dueAt});
        else if(previous.error)emit({at,kind:'price_recovered',reason:'PRICE_SAMPLE_RECOVERED',observationOnly:true,priceUsd:price.priceUsd});
        if(state&&!state.shadowClosed&&next.protectionActive&&(!state.protectionActive||next.protectionPriceUsd>state.protectionPriceUsd))
          emit({at,kind:state.protectionActive?'protection_raised':'protection_armed',
            reason:state.protectionActive?'PROTECTION_LINE_RAISED':'DYNAMIC_PROTECTION_ARMED',observationOnly:true,
            priceUsd:price.priceUsd,protectionPriceUsd:next.protectionPriceUsd,gainPct:(price.priceUsd/next.baselinePriceUsd-1)*100});
        if(result.event) {
          const e=result.event;
          emit({at:e.observedAt,kind:e.kind,reason:e.reasons[0],observationOnly:true,
            sellPct:e.sellPctRemaining,gainPct:e.observedGainPct,priceUsd:e.observedPriceUsd,
            protectionPriceUsd:e.protectionPriceUsd,remainingPct:e.remainingPctOfInitial,peakPriceUsd:e.peakPriceUsd,
            policyVersion:e.policyVersion,reasons:e.reasons,stageGainsPct:e.stageGainsPct});
          const intent=this.activeIntent(id);
          if(e.kind==='full_exit'&&intent&&!intent.observedAt)this.db.prepare('UPDATE exit_shadow_exit_intents SET data=? WHERE position_id=?')
            .run(JSON.stringify({...intent,observedAt:e.observedAt,observedPriceUsd:e.observedPriceUsd}),id);
        }
        this.db.prepare('UPDATE exit_shadow_positions SET updated_at=?,phase=?,state=?,last_price_at=?,last_price=?,error=NULL,error_at=NULL WHERE id=?')
          .run(now.toISOString(),next.shadowClosed?'triggered':this.activeIntent(id)?'exit_pending':'tracking',JSON.stringify(next),at,price.priceUsd,id);
        this.db.prepare('INSERT OR REPLACE INTO exit_shadow_meta VALUES (?,?)').run('last_sample_at',
          [this.meta('last_sample_at')??'',at].sort().at(-1)!);
        this.db.prepare("DELETE FROM exit_shadow_meta WHERE key='last_error'").run();
        const pruned=this.pruneSamples(id,at);
        this.db.exec('COMMIT');this.sampleCount+=Number(inserted.changes)-pruned.deleted;this.evaluatedSampleCount++;
        this.thinnedPositions+=Number(pruned.becameThinned);this.eventCount+=eventsAdded;
        this.lastError=undefined;this.persistedFailure=undefined;
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }catch(error){this.fail(error instanceof Error&&/^EXIT_SHADOW_[A-Z_]+$/.test(error.message)?error.message:'EXIT_SHADOW_WRITE_FAILED');}
  }

  recordError(value:ScanToken,reason:string,now=this.now()):void {
    const target=identity(value);if(!target)return;
    if(!Number.isFinite(now.getTime())||now.getTime()>this.now().getTime())return;
    const row=this.current(target);if(!row||row.phase==='ended')return;
    const state=JSON.parse(row.state) as AdaptiveExitState;
    if(state.shadowClosed||!continuousPolicy(state.policyVersion)&&Date.parse(row.ends_at)<=now.getTime())return;
    if(now.getTime()<Date.parse(row.last_price_at)||row.error_at&&now.getTime()<=Date.parse(row.error_at))return;
    try {
      if(!this.ensureCapacity(row.id,now.toISOString(),16384))this.fail('EXIT_SHADOW_CAPACITY_REACHED');
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('UPDATE exit_shadow_positions SET error=?,error_at=?,updated_at=? WHERE id=?')
        .run(code(reason),now.toISOString(),now.toISOString(),row.id);
      const inserted=!row.error?Number(this.db.prepare('INSERT INTO exit_shadow_events(position_id,at,data) VALUES (?,?,?)').run(row.id,now.toISOString(),
        JSON.stringify({at:now.toISOString(),kind:'price_unavailable',reason:code(reason),observationOnly:true})).changes):0;
      this.db.exec('COMMIT');this.eventCount+=inserted;
    }catch(error) {try {this.db.exec('ROLLBACK');}catch{}
      this.fail(error instanceof Error&&error.message==='EXIT_SHADOW_CAPACITY_REACHED'?error.message:'EXIT_SHADOW_WRITE_FAILED');}
  }

  /** Elapsed time alone never creates an exit intent. Missing prices remain an explicit data gap. */
  tick(now=this.now()):{pending:number;created:number} {
    if(!Number.isFinite(now.getTime())||now.getTime()>this.now().getTime())return {pending:0,created:0};
    return {created:0,pending:Number(this.db.prepare("SELECT count(*) AS n FROM exit_shadow_positions WHERE phase='exit_pending'").get()!.n)};
  }

  /** Prospective deployment migration. Finished history is never reopened or rewritten. */
  migrateActiveToV3(now=this.now()):{migrated:number;cancelled:number} {
    if(!Number.isFinite(now.getTime())||now.getTime()>this.now().getTime())return {migrated:0,cancelled:0};
    const rows=this.db.prepare("SELECT * FROM exit_shadow_positions WHERE phase IN ('tracking','exit_pending') ORDER BY started_at,id LIMIT ?")
      .all(this.maxPositions) as unknown as ShadowRow[];let migrated=0,cancelled=0;
    for(const row of rows){
      const old=JSON.parse(row.state) as AdaptiveExitState;
      if(old.shadowClosed||old.policyVersion===ADAPTIVE_SHADOW_V1.version&&Date.parse(row.ends_at)<=now.getTime())continue;
      // Later policies are forward-only. This legacy migration must never
      // downgrade it when the process restarts.
      if(old.policyVersion===ADAPTIVE_SHADOW_V4.version||old.policyVersion===ADAPTIVE_SHADOW_V5.version)continue;
      const next=migrateAdaptiveExitToV3(old,now.toISOString()),intent=this.activeIntent(row.id);
      const cancel=!!(intent&&!intent.observedAt&&timeExitReason(intent.reason));
      if(!next&&old.policyVersion!==ADAPTIVE_SHADOW_V3.version&&old.policyVersion!==ADAPTIVE_SHADOW_V4.version&&
        old.policyVersion!==ADAPTIVE_SHADOW_V5.version)
        this.fail('EXIT_SHADOW_STATE_INVALID');
      if(!next&&!cancel)continue;
      const state=next??old;
      if(this.bytes()+JSON.stringify(state).length*4+16384>this.maxBytes)this.fail('EXIT_SHADOW_CAPACITY_REACHED');
      this.db.exec('BEGIN IMMEDIATE');try{
        let eventsAdded=0;
        const emit=(event:ShadowEvent)=>{eventsAdded+=Number(this.db.prepare('INSERT INTO exit_shadow_events(position_id,at,data) VALUES(?,?,?)')
          .run(row.id,event.at,JSON.stringify(event)).changes);};
        if(next){
          this.db.prepare('INSERT INTO exit_shadow_policy_history VALUES(?,?,?,?,?)')
            .run(row.id,now.toISOString(),old.policyVersion,next.policyVersion,row.state);
          emit({at:now.toISOString(),kind:'policy_migrated',reason:'POLICY_MIGRATED_PROSPECTIVE',observationOnly:true,
            previousPolicyVersion:old.policyVersion,policyVersion:next.policyVersion,effectiveAt:now.toISOString(),
            remainingPct:next.remainingPctOfInitial,peakPriceUsd:next.peakPriceUsd});
        }
        if(cancel){
          this.db.prepare('UPDATE exit_shadow_exit_intents SET data=? WHERE position_id=?')
            .run(JSON.stringify({...intent,cancelledAt:now.toISOString(),cancelReason:'TIME_EXIT_CANCELLED_BY_POLICY'}),row.id);
          emit({at:now.toISOString(),kind:'time_exit_cancelled',reason:'TIME_EXIT_CANCELLED_BY_POLICY',observationOnly:true,
            previousPolicyVersion:intent!.policyVersion,policyVersion:state.policyVersion,effectiveAt:now.toISOString(),
            dueAt:intent!.dueAt,reasons:[intent!.reason],remainingPct:state.remainingPctOfInitial,peakPriceUsd:state.peakPriceUsd});
        }
        this.db.prepare('UPDATE exit_shadow_positions SET state=?,updated_at=?,phase=? WHERE id=?')
          .run(JSON.stringify(state),now.toISOString(),cancel?'tracking':row.phase,row.id);
        this.db.exec('COMMIT');this.eventCount+=eventsAdded;if(next)migrated++;if(cancel)cancelled++;
      }catch{this.db.exec('ROLLBACK');this.fail('EXIT_SHADOW_WRITE_FAILED');}
    }
    return {migrated,cancelled};
  }

  /** Targets outlive the scan archive window until a new trusted price observes final closure. */
  trackingTokens(limit=200,now=this.now()):ScanToken[] {
    const take=Number.isSafeInteger(limit)?Math.max(1,Math.min(this.maxPositions,limit)):200;
    // Both successful observations and failed attempts yield their turn to unvisited positions.
    const rows=this.db.prepare(`SELECT chain,address,
        MIN(CASE WHEN error_at>last_price_at THEN error_at ELSE last_price_at END) AS oldest
      FROM exit_shadow_positions
      WHERE (phase IN ('tracking','exit_pending') AND json_extract(state,'$.policyVersion') IN (?,?,?,?) AND json_extract(state,'$.shadowClosed')=0)
        OR (phase='tracking' AND ends_at>? AND json_extract(state,'$.policyVersion')=?)
      GROUP BY chain,address ORDER BY oldest,chain,address LIMIT ?`).all(ADAPTIVE_SHADOW_V2.version,ADAPTIVE_SHADOW_V3.version,
        ADAPTIVE_SHADOW_V4.version,ADAPTIVE_SHADOW_V5.version,now.toISOString(),ADAPTIVE_SHADOW_V1.version,take);
    return rows.map(row=>({chain:row.chain as Chain,address:String(row.address)}));
  }

  /** Exact indexed admission check for optional wallet-pressure research. */
  tracks(value:ScanToken,now=this.now()):boolean {
    const target=identity(value);if(!target||!Number.isFinite(now.getTime()))return false;
    const row=this.current(target);if(!row||!['tracking','exit_pending'].includes(row.phase))return false;
    const state=JSON.parse(row.state) as AdaptiveExitState;
    return !state.shadowClosed&&(continuousPolicy(state.policyVersion)||Date.parse(row.ends_at)>now.getTime());
  }

  private activeIntent(id:string):ShadowExitIntent|undefined {
    const intent=this.intent(id);return intent?.cancelledAt?undefined:intent;
  }
  private intent(id:string):ShadowExitIntent|undefined {
    const row=this.db.prepare('SELECT data FROM exit_shadow_exit_intents WHERE position_id=?').get(id);
    return row?JSON.parse(String(row.data)) as ShadowExitIntent:undefined;
  }

  summary(now=this.now()) {
    const at=now.toISOString(),cutoff=new Date(now.getTime()-this.staleMs).toISOString();
    const counts=this.db.prepare(`SELECT count(*) AS positions,SUM(phase IN ('tracking','exit_pending') AND (ends_at>? OR json_extract(state,'$.policyVersion') IN ('adaptive-shadow-v2','adaptive-shadow-v3','adaptive-shadow-v4','adaptive-shadow-v5'))) AS active,
      SUM(phase='triggered') AS triggered,SUM(phase='exit_pending') AS pending,
      SUM(phase IN ('tracking','exit_pending') AND (ends_at>? OR json_extract(state,'$.policyVersion') IN ('adaptive-shadow-v2','adaptive-shadow-v3','adaptive-shadow-v4','adaptive-shadow-v5')) AND (error IS NOT NULL OR last_price_at<?)) AS stale
      FROM exit_shadow_positions`).get(at,at,cutoff)!;
    return {enabled:true,mode:'shadow' as const,liveReady:false,policyVersion:ADAPTIVE_SHADOW_V5.version,
      status:{positions:Number(counts.positions),active:Number(counts.active??0),triggered:Number(counts.triggered??0),
        stale:Number(counts.stale??0),pending:Number(counts.pending??0),
        samples:this.sampleCount,events:this.eventCount,
        evaluatedSamples:this.evaluatedSampleCount,storedSamples:this.sampleCount,
        storedSamplesThinned:this.thinnedPositions>0,thinnedPositions:this.thinnedPositions,
        startedAt:this.meta('started_at'),lastSampleAt:this.meta('last_sample_at'),lastError:this.lastError??this.meta('last_error'),
        maxBytes:this.maxBytes,bytes:this.bytes(),historyComplete:this.meta('history_complete')==='true',
        staleAfterSec:this.staleMs/1000,closedComparisonIntervalSec:60,
        closedComparisonHorizonSec:CLOSED_COMPARISON_HORIZON_MS/1000,
        execution:'observation_only',liveBlockReason:'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED'}};
  }
  list(limit=50,now=this.now()) {
    const take=Number.isSafeInteger(limit)?Math.max(1,Math.min(100,limit)):50;
    const rows=this.db.prepare('SELECT * FROM exit_shadow_positions ORDER BY started_at DESC,id LIMIT ?').all(take) as unknown as ShadowRow[];
    return {...this.summary(now),items:rows.map(row=>this.project(row,now)),limit:take};
  }
  page(options:{limit?:number;offset?:number;chain?:Chain}={},now=this.now()) {
    const limit=Number.isSafeInteger(options.limit)?Math.max(1,Math.min(100,options.limit!)):20;
    const offset=Number.isSafeInteger(options.offset)?Math.max(0,Math.min(1_000_000,options.offset!)):0;
    const where=options.chain?'WHERE chain=?':'',args=options.chain?[options.chain]:[];
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM exit_shadow_positions ${where}`).get(...args)!.n);
    const rows=this.db.prepare(`SELECT * FROM exit_shadow_positions ${where} ORDER BY started_at DESC,id LIMIT ? OFFSET ?`)
      .all(...args,limit,offset) as unknown as ShadowRow[];
    return {...this.summary(now),items:rows.map(row=>this.projectList(row,now)),total,limit,offset,hasMore:offset+rows.length<total};
  }
  detail(id:string,now=this.now()) {
    const row=this.db.prepare('SELECT * FROM exit_shadow_positions WHERE id=?').get(id) as unknown as ShadowRow|undefined;
    if(!row)return;
    const samples=this.db.prepare('SELECT at,price AS priceUsd,source,context FROM exit_shadow_samples WHERE position_id=? ORDER BY at LIMIT 2000').all(id);
    const stats=this.sampleStats(id),count=Number(stats?.stored_samples??
      this.db.prepare('SELECT count(*) AS n FROM exit_shadow_samples WHERE position_id=?').get(id)!.n);
    const evaluated=Number(stats?.evaluated_samples??count),thinned=!!stats?.samples_thinned||evaluated>count;
    const eventSampleCount=Number(this.db.prepare('SELECT count(*) AS n FROM exit_shadow_event_samples WHERE position_id=?').get(id)!.n);
    const eventSamples=this.db.prepare(`SELECT event_id AS eventId,relation,at,price AS priceUsd,source,pool_address AS poolAddress
      FROM exit_shadow_event_samples WHERE position_id=? ORDER BY event_id DESC,relation LIMIT 2000`).all(id);
    const item=this.project(row,now);
    return {item,quality:readPositionExitQuality(this.db,row,now.toISOString(),item.returns),samples:samples.map(r=>({...r,context:JSON.parse(String(r.context))})),sampleCount:count,
      evaluatedSampleCount:evaluated,storedSampleCount:count,responseTruncated:count>samples.length,
      storedSamplesThinned:thinned,sampleRetentionVersion:SAMPLE_RETENTION_VERSION,
      eventSamples,eventSampleCount,eventSamplesTruncated:eventSampleCount>eventSamples.length,mode:'shadow',liveReady:false};
  }
  close():void {this.db.close();}
  private projectList(row:ShadowRow,now:Date) {
    const state=JSON.parse(row.state) as AdaptiveExitState;
    const metrics=this.db.prepare('SELECT peak_price,max_gap_sec,last_source FROM exit_shadow_metrics WHERE position_id=?').get(row.id);
    const rawPeak=Number(metrics?.peak_price??row.last_price),rawGap=metrics?.max_gap_sec;
    const protectionReferencePeakUsd=state.runnerProtection?.cyclePeakPriceUsd??state.peakPriceUsd;
    const deadline=adaptiveExitDeadline(state),intent=this.activeIntent(row.id),closed=state.shadowClosed;
    const health=row.error?'unavailable':now.getTime()-Date.parse(row.last_price_at)>this.staleMs?'stale':'fresh';
    const exits=this.db.prepare("SELECT data FROM exit_shadow_events WHERE position_id=? AND json_extract(data,'$.kind') IN ('partial_exit','full_exit') ORDER BY id LIMIT 33")
      .all(row.id).map(event=>JSON.parse(String(event.data)) as ShadowEvent);
    const returns=shadowReturn(state,exits,{priceUsd:row.last_price,at:row.last_price_at,health});
    const exitPlan={policyVersion:state.policyVersion,effectiveAt:state.policyEffectiveAt,timeExitEnabled:state.policyVersion===ADAPTIVE_SHADOW_V2.version,
      maxHoldingAt:state.policyVersion===ADAPTIVE_SHADOW_V2.version&&state.policyEffectiveAt?new Date(Date.parse(state.policyEffectiveAt)+ADAPTIVE_SHADOW_V2.maxHoldingMs!).toISOString():undefined,
      observationEndsAt:row.ends_at,scheduledExitAt:deadline?.dueAt,
      status:closed?'observed_closed':!continuousPolicy(state.policyVersion)?'legacy_policy':intent?'awaiting_fresh_price':'tracking',
      intent,closedAt:closed?state.lastObservedAt:undefined};
    return {id:row.id,chain:row.chain,address:row.address,symbol:row.symbol??undefined,candidateId:row.candidate_id,
      eligibleAt:row.eligible_at,startedAt:row.started_at,updatedAt:row.updated_at,endsAt:row.ends_at,
      phase:row.phase==='triggered'?'triggered':continuousPolicy(state.policyVersion)?row.phase:Date.parse(row.ends_at)<=now.getTime()?'ended':row.phase,
      policyVersion:state.policyVersion,exitPlan,returns,health,
      lastPriceAt:row.last_price_at,priceSource:metrics?.last_source||undefined,maxGapSec:Number(rawGap??0),baselinePriceUsd:state.baselinePriceUsd,
      latestPriceUsd:row.last_price,peakPriceUsd:rawPeak,gainPct:(row.last_price/state.baselinePriceUsd-1)*100,
      peakGainPct:(rawPeak/state.baselinePriceUsd-1)*100,triggerPeakGainPct:(state.peakPriceUsd/state.baselinePriceUsd-1)*100,
      protectionPriceUsd:state.protectionPriceUsd,
      protectionGainPct:(state.protectionPriceUsd/state.baselinePriceUsd-1)*100,activationGainPct:state.activationGainPct,
      protectionReferencePeakUsd,
      protectionEffectiveDrawdownPct:(1-state.protectionPriceUsd/protectionReferencePeakUsd)*100,
      protectionActive:state.protectionActive,trailPct:state.drawdownPct,remainingPct:state.remainingPctOfInitial,
      lastError:row.error??undefined,mode:'shadow',liveReady:false};
  }
  private project(row:ShadowRow,now:Date) {
    const state=JSON.parse(row.state) as AdaptiveExitState,pressure=state.walletPressure;
    const events=this.db.prepare('SELECT data FROM exit_shadow_events WHERE position_id=? ORDER BY id DESC LIMIT 5').all(row.id).map(x=>JSON.parse(String(x.data)) as ShadowEvent);
    return {...this.projectList(row,now),
      pressure:pressure?{status:'observed',tradeCount:pressure.evidenceCount,netSellRatio:pressure.netSellRatio,
        source:pressure.sources.join(', '),evidenceIds:pressure.evidenceIds,verification:pressure.verification}:{status:'unknown'},
      events,lastEvent:state.shadowClosed?this.lastExitEvent(row.id)??events[0]:events[0],lastError:row.error??undefined,mode:'shadow',liveReady:false};
  }
  private lastExitEvent(id:string):ShadowEvent|undefined {
    const row=this.db.prepare("SELECT data FROM exit_shadow_events WHERE position_id=? AND json_extract(data,'$.kind')='full_exit' ORDER BY id DESC LIMIT 1").get(id);
    return row?JSON.parse(String(row.data)) as ShadowEvent:undefined;
  }
  private current(value:ScanToken):ShadowRow|undefined {
    return this.db.prepare('SELECT * FROM exit_shadow_positions WHERE chain=? AND address=? ORDER BY started_at DESC,id LIMIT 1')
      .get(value.chain,value.address) as unknown as ShadowRow|undefined;
  }
  /** Keep isolated V5 quotes and post-exit archive spikes out of retained state and comparison metrics. */
  private quarantineExtreme(row:ShadowRow,state:AdaptiveExitState,source:string,pool:string|undefined,evidence:ReturnType<typeof priceEvidence>,
    candidatePriceUsd:number,observedAt:string):ShadowQuarantineDecision {
    // V1-V4 active episodes retain their original input semantics. Closed
    // episodes use bidirectional quarantine because both MAX peaks and the
    // first 5/15/60-minute comparison quote feed the archived exit analysis.
    const v5=state.policyVersion===ADAPTIVE_SHADOW_V5.version;
    if(!v5&&!state.shadowClosed)return 'accept';
    const threshold=ADAPTIVE_SHADOW_V5.outlierJumpRatio!,ratio=Math.max(candidatePriceUsd/row.last_price,row.last_price/candidatePriceUsd);
    const stored=this.db.prepare('SELECT data FROM exit_shadow_price_quarantine WHERE position_id=?').get(row.id);
    let pending:ShadowPriceQuarantine|undefined;
    try {pending=stored?JSON.parse(String(stored.data)) as ShadowPriceQuarantine:undefined;}catch{this.fail('EXIT_SHADOW_STATE_INVALID');}
    let clearOnAccept=false;
    if(pending?.basePriceUsd!==row.last_price){pending=undefined;clearOnAccept=true;}
    // A chain-observed pool quote is strong enough to authorize an immediate
    // hard-stop path. Vendor crashes still require persistence so one corrupt
    // point cannot manufacture a simulated rug; a pool-less vendor cannot
    // confirm one by itself.
    if(candidatePriceUsd<=row.last_price/threshold&&source==='chain_pool_sample'&&evidence){
      return pending||clearOnAccept?'accept_and_clear':'accept';
    }
    const extreme=Number.isFinite(ratio)&&ratio>=threshold;
    if(pending){
      const persistent=pending.direction==='up'?candidatePriceUsd>=pending.basePriceUsd*threshold/2:
        candidatePriceUsd<=pending.basePriceUsd*2/threshold;
      const sameSourcePool=!!pool&&!!pending.poolAddress&&source===pending.source&&pool===pending.poolAddress;
      const independentlyVerified=source==='chain_pool_sample'&&!!evidence;
      const confirmationGapMs=Date.parse(observedAt)-Date.parse(pending.observedAt);
      const confirmationInWindow=confirmationGapMs>=ADAPTIVE_SHADOW_V5.protectionConfirmationMinGapMs!&&
        confirmationGapMs<=ADAPTIVE_SHADOW_V5.protectionConfirmationMaxGapMs!;
      if(persistent&&confirmationInWindow&&(sameSourcePool||independentlyVerified)){
        return 'accept_and_clear';
      }
      // Duplicated or out-of-order observations cannot advance evidence. Keep
      // the original candidate so rapid retries cannot slide the time window.
      if(persistent&&confirmationGapMs<ADAPTIVE_SHADOW_V5.protectionConfirmationMinGapMs!)return 'quarantined';
      if(!persistent&&!extreme)return 'accept_and_clear';
    }else if(!extreme)return clearOnAccept?'accept_and_clear':'accept';
    const next:ShadowPriceQuarantine={basePriceUsd:row.last_price,candidatePriceUsd,
      direction:candidatePriceUsd>row.last_price?'up':'down',observedAt,source,...(pool?{poolAddress:pool}:{})};
    try {
      if(!this.ensureCapacity(row.id,observedAt,JSON.stringify(next).length*4+16384))this.fail('EXIT_SHADOW_CAPACITY_REACHED');
      this.db.exec('BEGIN IMMEDIATE');try{
        this.db.prepare('INSERT OR REPLACE INTO exit_shadow_price_quarantine VALUES (?,?)').run(row.id,JSON.stringify(next));
        const event:ShadowEvent={at:observedAt,kind:'price_quarantined',reason:'EXTREME_PRICE_AWAITING_CONFIRMATION',
          observationOnly:true,priceUsd:candidatePriceUsd,policyVersion:state.policyVersion,
          source,...(pool?{poolAddress:pool}:{})};
        const added=Number(this.db.prepare('INSERT INTO exit_shadow_events(position_id,at,data) VALUES (?,?,?)')
          .run(row.id,observedAt,JSON.stringify(event)).changes);
        this.db.exec('COMMIT');this.eventCount+=added;this.lastError=undefined;return 'quarantined';
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }catch(error){this.fail(error instanceof Error&&/^EXIT_SHADOW_[A-Z_]+$/.test(error.message)?error.message:'EXIT_SHADOW_WRITE_FAILED');}
  }
  private sampleSnapshot(id:string,before:string):ShadowSampleSnapshot|undefined {
    const row=this.db.prepare(`SELECT at,price AS priceUsd,source,
      COALESCE(json_extract(context,'$.poolAddress'),json_extract(context,'$.priceEvidence.pool')) AS poolAddress
      FROM exit_shadow_samples WHERE position_id=? AND at<? ORDER BY at DESC LIMIT 1`).get(id,before);
    if(!row)return;
    return {at:String(row.at),priceUsd:Number(row.priceUsd),source:String(row.source),
      ...(typeof row.poolAddress==='string'?{poolAddress:String(row.poolAddress)}:{})};
  }
  private completeEventNeighbors(id:string,current:ShadowSampleSnapshot):void {
    this.db.prepare(`INSERT OR IGNORE INTO exit_shadow_event_samples(event_id,relation,position_id,at,price,source,pool_address)
      SELECT current.event_id,1,current.position_id,?,?,?,? FROM exit_shadow_event_samples current
      JOIN exit_shadow_events event ON event.id=current.event_id
      WHERE current.position_id=? AND current.relation=0 AND event.at<?
        AND NOT EXISTS (SELECT 1 FROM exit_shadow_event_samples following
          WHERE following.event_id=current.event_id AND following.relation=1)`)
      .run(current.at,current.priceUsd,current.source,current.poolAddress??null,id,current.at);
  }
  private captureEventNeighbors(eventId:number,id:string,current:ShadowSampleSnapshot):void {
    const previous=this.sampleSnapshot(id,current.at),insert=this.db.prepare(
      'INSERT OR IGNORE INTO exit_shadow_event_samples VALUES (?,?,?,?,?,?,?)');
    if(previous)insert.run(eventId,-1,id,previous.at,previous.priceUsd,previous.source,previous.poolAddress??null);
    insert.run(eventId,0,id,current.at,current.priceUsd,current.source,current.poolAddress??null);
  }
  private sampleStats(id:string):ShadowSampleStatsRow|undefined {
    return this.db.prepare('SELECT * FROM exit_shadow_sample_stats WHERE position_id=?').get(id) as unknown as ShadowSampleStatsRow|undefined;
  }
  private pruneSamples(id:string,at:string,force=false):{deleted:number;becameThinned:boolean} {
    const stats=this.sampleStats(id);if(!stats)return {deleted:0,becameThinned:false};
    const evaluated=Number(stats.evaluated_samples),due=Date.parse(at)-Date.parse(stats.last_pruned_at)>=SAMPLE_PRUNE_INTERVAL_MS||evaluated%256===0;
    if(!force&&!due)return {deleted:0,becameThinned:false};
    const recent=new Date(Date.parse(at)-SAMPLE_RECENT_WINDOW_MS).toISOString();
    const mid=new Date(Date.parse(at)-SAMPLE_MID_WINDOW_MS).toISOString();
    const long=new Date(Date.parse(at)-SAMPLE_LONG_WINDOW_MS).toISOString();
    const start=stats.retention_started_at,pool="COALESCE(json_extract(s.context,'$.poolAddress'),json_extract(s.context,'$.priceEvidence.pool'),'')";
    let deleted=0;
    const remove=(sql:string,...args:(string|number)[])=>{deleted+=Number(this.db.prepare(sql).run(...args).changes);};
    remove(`DELETE FROM exit_shadow_samples WHERE rowid IN (SELECT s.rowid FROM exit_shadow_samples s
      WHERE s.position_id=? AND s.at>=? AND s.at<? AND NOT ${SAMPLE_PROTECTED_SQL})`,id,start,long);
    for(const [from,to,bucket] of [[long,mid,SAMPLE_LONG_BUCKET_SEC],[mid,recent,SAMPLE_MID_BUCKET_SEC]] as const)
      remove(`DELETE FROM exit_shadow_samples WHERE rowid IN (SELECT rowid FROM (
        SELECT s.rowid,
          row_number() OVER (PARTITION BY CAST(CAST(strftime('%s',s.at) AS INTEGER)/? AS INTEGER),s.source,${pool} ORDER BY s.at) AS first_rank,
          row_number() OVER (PARTITION BY CAST(CAST(strftime('%s',s.at) AS INTEGER)/? AS INTEGER),s.source,${pool} ORDER BY s.at DESC) AS last_rank,
          row_number() OVER (PARTITION BY CAST(CAST(strftime('%s',s.at) AS INTEGER)/? AS INTEGER),s.source,${pool} ORDER BY s.price,s.at) AS min_rank,
          row_number() OVER (PARTITION BY CAST(CAST(strftime('%s',s.at) AS INTEGER)/? AS INTEGER),s.source,${pool} ORDER BY s.price DESC,s.at) AS max_rank
        FROM exit_shadow_samples s WHERE s.position_id=? AND s.at>=? AND s.at<? AND NOT ${SAMPLE_PROTECTED_SQL}
      ) WHERE first_rank>1 AND last_rank>1 AND min_rank>1 AND max_rank>1)`,bucket,bucket,bucket,bucket,id,from,to);
    remove(`DELETE FROM exit_shadow_samples WHERE rowid IN (SELECT s.rowid FROM exit_shadow_samples s
      WHERE s.position_id=? AND s.at>=? AND s.at>=? AND NOT ${SAMPLE_PROTECTED_SQL}
      ORDER BY s.at DESC LIMIT -1 OFFSET ?)`,id,start,recent,SAMPLE_RECENT_MAX);
    remove(`DELETE FROM exit_shadow_samples WHERE rowid IN (SELECT s.rowid FROM exit_shadow_samples s
      WHERE s.position_id=? AND s.at>=? AND NOT ${SAMPLE_PROTECTED_SQL}
      ORDER BY s.at DESC LIMIT -1 OFFSET ?)`,id,start,SAMPLE_UNPINNED_MAX);
    this.db.prepare(`UPDATE exit_shadow_sample_stats SET stored_samples=(SELECT count(*) FROM exit_shadow_samples WHERE position_id=?),
      samples_thinned=CASE WHEN ?>0 THEN 1 ELSE samples_thinned END,last_pruned_at=? WHERE position_id=?`)
      .run(id,deleted,at,id);
    return {deleted,becameThinned:deleted>0&&!Number(stats.samples_thinned)};
  }
  /**
   * Capacity recovery is deliberately limited to one position and one prune
   * pass. The short checkpoint timeout keeps a slow external reader from
   * stalling the quote loop; a busy checkpoint simply leaves the normal
   * durable capacity alarm to stop further writes.
   */
  private ensureCapacity(id:string|undefined,at:string,requiredBytes:number):boolean {
    if(this.bytes()+requiredBytes<=this.maxBytes)return true;
    // A failed attempt already proved that this exact on-disk state has no
    // reclaimable headroom. Do not rewrite prune timestamps or the durable
    // failure marker on every quote; a restart rechecks offline compaction.
    if(this.lastError==='EXIT_SHADOW_CAPACITY_REACHED')return this.hasLogicalCapacity(requiredBytes);
    if(!id)return false;
    this.db.exec('BEGIN IMMEDIATE');let pruned:{deleted:number;becameThinned:boolean};
    try{pruned=this.pruneSamples(id,at,true);this.db.exec('COMMIT');}
    catch(error){this.db.exec('ROLLBACK');throw error;}
    this.sampleCount-=pruned.deleted;this.thinnedPositions+=Number(pruned.becameThinned);
    if(this.bytes()+requiredBytes<=this.maxBytes)return true;
    try {
      this.db.exec('PRAGMA busy_timeout=50');
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } finally {this.db.exec('PRAGMA busy_timeout=5000');}
    return this.hasLogicalCapacity(requiredBytes);
  }
  private hasLogicalCapacity(requiredBytes:number):boolean {
    const pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    const pages=Number(this.db.prepare('PRAGMA page_count').get()!.page_count);
    const free=Number(this.db.prepare('PRAGMA freelist_count').get()!.freelist_count);
    const requiredPages=Math.max(1,Math.ceil(requiredBytes/pageSize));
    const growth=Math.max(0,requiredPages-free);
    const walBytes=this.path===':memory:'?0:(()=>{try{return statSync(this.path+'-wal').size;}catch{return 0;}})();
    return pages+growth<=this.maxPages&&(pages-free)*pageSize+walBytes+requiredBytes<=this.maxBytes;
  }
  private meta(key:string):string|undefined {const row=this.db.prepare('SELECT value FROM exit_shadow_meta WHERE key=?').get(key);return row?String(row.value):undefined;}
  private bytes():number {
    if(this.path===':memory:')return Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    return [this.path,this.path+'-wal'].reduce((sum,path)=>{try{return sum+statSync(path).size;}catch{return sum;}},0);
  }
  private fail(reason:string):never {
    this.lastError=reason;
    if(this.persistedFailure!==reason)try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('INSERT OR REPLACE INTO exit_shadow_meta VALUES (?,?)').run('last_error',reason);
      this.db.prepare('INSERT OR REPLACE INTO exit_shadow_meta VALUES (?,?)').run('history_complete','false');
      this.db.exec('COMMIT');this.persistedFailure=reason;
    }catch{try {this.db.exec('ROLLBACK');}catch{}}
    throw new Error(reason);
  }
}
