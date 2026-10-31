import {DatabaseSync} from 'node:sqlite';
import type {MemeMarketSample} from './meme-assessment.js';

const DAY_MS=86_400_000;
export const MEME_PRICE_ARCHIVE_SOURCE='meme_price_archive' as const;
export const MEME_PRICE_ARCHIVE_RETENTION_DAYS=7;
export const MEME_FULL_SNAPSHOT_MAX_ROWS=50_000;
export const MEME_PRICE_ARCHIVE_SAMPLE_INTERVAL_SEC=30;
export const MEME_PRICE_ARCHIVE_ESTIMATED_BYTES_PER_ROW=384;
export const MEME_PRICE_ARCHIVE_MIN_NON_ARCHIVE_BYTES=512*1024*1024;

export interface MemePriceArchiveCapacity {
  plannedRows:number;estimatedArchiveBytes:number;nonArchiveReserveBytes:number;
  estimatedRequiredBytes:number;headroomBytes:number;status:'ready'|'insufficient';
}

/** Worst-case retained size for the configured active set. The archive keeps
 * the entire seven-day window, so capacity must be admitted before production
 * starts rather than silently deleting recent evidence. */
export function memePriceArchiveCapacity(maxActive:number,maxBytes:number):MemePriceArchiveCapacity {
  if(!Number.isInteger(maxActive)||maxActive<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)
    throw new Error('MEME_PRICE_ARCHIVE_CAPACITY_INPUT_INVALID');
  const plannedRows=maxActive*Math.ceil(MEME_PRICE_ARCHIVE_RETENTION_DAYS*DAY_MS/(MEME_PRICE_ARCHIVE_SAMPLE_INTERVAL_SEC*1000));
  const estimatedArchiveBytes=plannedRows*MEME_PRICE_ARCHIVE_ESTIMATED_BYTES_PER_ROW;
  const nonArchiveReserveBytes=Math.max(MEME_PRICE_ARCHIVE_MIN_NON_ARCHIVE_BYTES,Math.ceil(maxBytes*.25));
  const estimatedRequiredBytes=estimatedArchiveBytes+nonArchiveReserveBytes,headroomBytes=maxBytes-estimatedRequiredBytes;
  return {plannedRows,estimatedArchiveBytes,nonArchiveReserveBytes,estimatedRequiredBytes,headroomBytes,
    status:headroomBytes>=0?'ready':'insufficient'};
}

export function assertMemePriceArchiveCapacity(maxActive:number,maxBytes:number):MemePriceArchiveCapacity {
  const plan=memePriceArchiveCapacity(maxActive,maxBytes);
  if(plan.status!=='ready')throw new Error('MEME_PRICE_ARCHIVE_CAPACITY_INSUFFICIENT');
  return plan;
}

export interface MemePriceArchiveMaintenance {
  deleted:number;backfilled:number;backfillPending:boolean;retentionBacklog:boolean;
}

const table=(db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const validIso=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));

/** Install the compact price ledger and freeze the point from which new
 * observer writes are known to be continuous. Existing snapshots may be
 * backfilled later, but never move this conservative boundary backwards. */
export function initializeMemePriceArchive(db:DatabaseSync,enabledAt:string):void {
  if(!validIso(enabledAt))throw new Error('MEME_PRICE_ARCHIVE_TIME_INVALID');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meme_price_archive(
      id INTEGER PRIMARY KEY,
      chain TEXT NOT NULL,
      address TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      source TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      price_usd REAL NOT NULL CHECK(price_usd>0)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS meme_price_archive_token_time
      ON meme_price_archive(chain,address,observed_at,source);
    CREATE INDEX IF NOT EXISTS meme_price_archive_time
      ON meme_price_archive(observed_at,id);
    CREATE TABLE IF NOT EXISTS meme_price_archive_state(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      enabled_at TEXT NOT NULL,
      continuous_from_at TEXT NOT NULL,
      initial_snapshot_oldest_at TEXT,
      backfill_cursor_id INTEGER NOT NULL,
      backfill_upper_id INTEGER NOT NULL,
      earliest_observed_at TEXT,
      backfill_completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS review_retention_watermarks(
      source TEXT PRIMARY KEY,
      pruned_through TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS meme_price_archive_review_retention
    AFTER DELETE ON meme_price_archive BEGIN
      INSERT INTO review_retention_watermarks(source,pruned_through)
      VALUES('${MEME_PRICE_ARCHIVE_SOURCE}',OLD.observed_at)
      ON CONFLICT(source) DO UPDATE SET pruned_through=MAX(pruned_through,excluded.pruned_through);
    END;
  `);
  if(db.prepare('SELECT 1 FROM meme_price_archive_state WHERE singleton=1').get())return;
  // Freeze the legacy upper id under the same writer lock that installs the
  // state row. A concurrently shutting-down old writer cannot land between the
  // boundary read and the migration marker.
  db.exec('BEGIN IMMEDIATE');
  try {
    if(db.prepare('SELECT 1 FROM meme_price_archive_state WHERE singleton=1').get()){db.exec('COMMIT');return;}
    const snapshot=table(db,'meme_snapshots')
      ?db.prepare('SELECT COALESCE(MAX(id),0) upper_id,MIN(observed_at) oldest FROM meme_snapshots').get() as Record<string,unknown>
      :{upper_id:0,oldest:null};
    const upper=Math.max(0,Number(snapshot.upper_id)||0),oldest=validIso(snapshot.oldest)?snapshot.oldest:null;
    db.prepare(`INSERT INTO meme_price_archive_state(singleton,enabled_at,continuous_from_at,initial_snapshot_oldest_at,
      backfill_cursor_id,backfill_upper_id,earliest_observed_at,backfill_completed_at) VALUES(1,?,?,?,?,?,?,?)`)
      .run(enabledAt,enabledAt,oldest,0,upper,null,upper===0?enabledAt:null);
    // This is an explicit historical-coverage boundary, not evidence that a
    // deletion happened. It prevents pre-enable gaps from appearing complete.
    db.prepare(`INSERT INTO review_retention_watermarks(source,pruned_through) VALUES(?,?)
      ON CONFLICT(source) DO UPDATE SET pruned_through=MAX(pruned_through,excluded.pruned_through)`)
      .run(MEME_PRICE_ARCHIVE_SOURCE,enabledAt);
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}

/** While migration is pending, full JSON rows above this id are the only copy
 * and must never be reclaimed. Undefined means the frozen range is complete. */
export function memePriceArchiveDeletionCeiling(db:DatabaseSync):number|undefined {
  const state=db.prepare(`SELECT backfill_cursor_id cursor,backfill_completed_at completed
    FROM meme_price_archive_state WHERE singleton=1`).get() as Record<string,unknown>|undefined;
  if(state?.completed)return;
  return Math.max(0,Number(state?.cursor)||0);
}

/** Called inside the same savepoint as meme_snapshots and meme_tokens. */
export function archiveMemePrice(db:DatabaseSync,sample:MemeMarketSample):boolean {
  if(!sample.poolAddress||!Number.isFinite(sample.priceUsd)||(sample.priceUsd??0)<=0)return false;
  const result=db.prepare(`INSERT OR IGNORE INTO meme_price_archive(chain,address,observed_at,source,pool_address,price_usd)
    VALUES(?,?,?,?,?,?)`).run(sample.token.chain,sample.token.address,sample.observedAt,sample.source,sample.poolAddress,sample.priceUsd!);
  if(result.changes)db.prepare(`UPDATE meme_price_archive_state SET earliest_observed_at=?
    WHERE singleton=1 AND (earliest_observed_at IS NULL OR earliest_observed_at>?)`).run(sample.observedAt,sample.observedAt);
  return result.changes>0;
}

/** Copy a bounded id range from the legacy JSON ledger. New samples are
 * already dual-written, so the frozen upper id makes this pass finite. */
export function backfillMemePriceArchive(db:DatabaseSync,completedAt:string,batch=500):{inserted:number;pending:boolean} {
  if(!Number.isInteger(batch)||batch<1||batch>10_000)throw new Error('MEME_PRICE_ARCHIVE_BACKFILL_BATCH_INVALID');
  const state=db.prepare(`SELECT backfill_cursor_id cursor,backfill_upper_id upper_id,backfill_completed_at completed
    FROM meme_price_archive_state WHERE singleton=1`).get() as Record<string,unknown>|undefined;
  if(!state||state.completed)return {inserted:0,pending:false};
  const cursor=Number(state.cursor)||0,upper=Number(state.upper_id)||0;
  if(cursor>=upper){
    db.prepare('UPDATE meme_price_archive_state SET backfill_completed_at=? WHERE singleton=1 AND backfill_completed_at IS NULL').run(completedAt);
    return {inserted:0,pending:false};
  }
  const ids=db.prepare('SELECT id FROM meme_snapshots WHERE id>? AND id<=? ORDER BY id LIMIT ?').all(cursor,upper,batch);
  const last=ids.length?Number(ids.at(-1)!.id):upper;
  const earliest=db.prepare(`SELECT MIN(observed_at) oldest FROM meme_snapshots
    WHERE id>? AND id<=? AND market IS NOT NULL
      AND json_extract(market,'$.token.chain')=chain
      AND json_extract(market,'$.token.address')=address
      AND json_extract(market,'$.observedAt')=observed_at
      AND json_extract(market,'$.source')=source
      AND typeof(json_extract(market,'$.poolAddress'))='text'
      AND length(json_extract(market,'$.poolAddress'))>0
      AND typeof(json_extract(market,'$.priceUsd')) IN ('integer','real')
      AND json_extract(market,'$.priceUsd')>0`).get(cursor,last) as Record<string,unknown>;
  const oldest=validIso(earliest.oldest)?earliest.oldest:null;
  db.exec('SAVEPOINT meme_price_archive_backfill');
  try {
    const inserted=Number(db.prepare(`INSERT OR IGNORE INTO meme_price_archive(chain,address,observed_at,source,pool_address,price_usd)
      SELECT chain,address,observed_at,source,json_extract(market,'$.poolAddress'),json_extract(market,'$.priceUsd')
      FROM meme_snapshots
      WHERE id>? AND id<=? AND market IS NOT NULL
        AND json_extract(market,'$.token.chain')=chain
        AND json_extract(market,'$.token.address')=address
        AND json_extract(market,'$.observedAt')=observed_at
        AND json_extract(market,'$.source')=source
        AND typeof(json_extract(market,'$.poolAddress'))='text'
        AND length(json_extract(market,'$.poolAddress'))>0
        AND typeof(json_extract(market,'$.priceUsd')) IN ('integer','real')
        AND json_extract(market,'$.priceUsd')>0
      ORDER BY id`).run(cursor,last).changes);
    const pending=last<upper;
    db.prepare(`UPDATE meme_price_archive_state SET backfill_cursor_id=?,
      earliest_observed_at=CASE WHEN ? IS NOT NULL AND (earliest_observed_at IS NULL OR earliest_observed_at>?) THEN ? ELSE earliest_observed_at END,
      backfill_completed_at=? WHERE singleton=1`).run(last,oldest,oldest,oldest,pending?null:completedAt);
    db.exec('RELEASE meme_price_archive_backfill');
    return {inserted,pending};
  }catch(error){db.exec('ROLLBACK TO meme_price_archive_backfill; RELEASE meme_price_archive_backfill');throw error;}
}

/** Delete only data older than the guaranteed window. Both age and soft-cap
 * maintenance are bounded so the observer write lock is released quickly. */
export function pruneMemePriceArchive(db:DatabaseSync,now:number,batch=500):{deleted:number;backlog:boolean} {
  if(!Number.isFinite(now)||!Number.isInteger(batch)||batch<1||batch>10_000)throw new Error('MEME_PRICE_ARCHIVE_PRUNE_INVALID');
  const cutoff=new Date(now-MEME_PRICE_ARCHIVE_RETENTION_DAYS*DAY_MS).toISOString();
  // Probe only one bounded index range; COUNT(*) on a multi-million-row
  // archive every maintenance second would compete with live collection.
  const eligible=db.prepare(`SELECT id FROM meme_price_archive WHERE observed_at<?
    ORDER BY observed_at,id LIMIT ?`).all(cutoff,batch+1);
  if(!eligible.length)return {deleted:0,backlog:false};
  const ids=eligible.slice(0,batch).map(row=>Number(row.id));
  db.exec('SAVEPOINT meme_price_archive_prune');
  try {
    const deleted=Number(db.prepare(`DELETE FROM meme_price_archive WHERE id IN (${ids.map(()=>'?').join(',')})`).run(...ids).changes);
    db.exec('RELEASE meme_price_archive_prune');
    return {deleted,backlog:eligible.length>batch};
  }catch(error){db.exec('ROLLBACK TO meme_price_archive_prune; RELEASE meme_price_archive_prune');throw error;}
}

export function maintainMemePriceArchive(db:DatabaseSync,now:number,deleteBatch=500,backfillBatch=500):MemePriceArchiveMaintenance {
  const pruned=pruneMemePriceArchive(db,now,deleteBatch);
  const filled=backfillMemePriceArchive(db,new Date(now).toISOString(),backfillBatch);
  return {deleted:pruned.deleted,backfilled:filled.inserted,backfillPending:filled.pending,retentionBacklog:pruned.backlog};
}
