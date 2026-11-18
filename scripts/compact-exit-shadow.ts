import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EXIT_SHADOW_SAMPLE_RETENTION as retention} from '../src/exit-shadow.js';

const CLOSED_HORIZON_SEC=3720;
const pool="COALESCE(json_extract(s.context,'$.poolAddress'),json_extract(s.context,'$.priceEvidence.pool'),'')";
const iso=(value:number)=>new Date(value).toISOString();
const literal=(value:string)=>`'${value.replaceAll("'","''")}'`;

export interface ExitShadowCompactionResult {
  positions:number;samplesBefore:number;samplesAfter:number;samplesDeleted:number;
  closedSamplesPastHorizonDeleted:number;eventEvidenceRows:number;
}
export interface ExitShadowCompactionInspection {
  mode:'dry_run';database:string;bytes:number;samples:number;closedSamplesPastHorizon:number;
}

/** Read-only inspection used by the CLI dry run and regression tests. */
export function inspectExitShadowCompaction(database:string):ExitShadowCompactionInspection {
  const path=resolve(database),db=new DatabaseSync(path,{readOnly:true});
  try{
    const samples=Number(db.prepare('SELECT count(*) AS n FROM exit_shadow_samples').get()!.n);
    const past=Number(db.prepare(`SELECT count(*) AS n FROM exit_shadow_samples s JOIN exit_shadow_positions p ON p.id=s.position_id
      WHERE json_extract(p.state,'$.shadowClosed')=1 AND CAST(strftime('%s',s.at) AS INTEGER)>
      CAST(strftime('%s',json_extract(p.state,'$.lastObservedAt')) AS INTEGER)+?`).get(CLOSED_HORIZON_SEC)!.n);
    return {mode:'dry_run',database:path,bytes:statSync(path).size,samples,closedSamplesPastHorizon:past};
  }finally{db.close();}
}

/** Caller must hold an exclusive transaction. This function performs no VACUUM and no service control. */
export function compactExitShadowTransaction(db:DatabaseSync):ExitShadowCompactionResult {
  const samplesBefore=Number(db.prepare('SELECT count(*) AS n FROM exit_shadow_samples').get()!.n);
  db.exec(`CREATE TABLE IF NOT EXISTS exit_shadow_sample_stats(position_id TEXT PRIMARY KEY,evaluated_samples INTEGER NOT NULL,
      stored_samples INTEGER NOT NULL,samples_thinned INTEGER NOT NULL,retention_started_at TEXT NOT NULL,last_pruned_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS exit_shadow_sample_pins(position_id TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL,
      PRIMARY KEY(position_id,reason));
    CREATE INDEX IF NOT EXISTS exit_shadow_sample_pin_time ON exit_shadow_sample_pins(position_id,at);
    CREATE INDEX IF NOT EXISTS exit_shadow_event_return_time ON exit_shadow_events(position_id,at)
      WHERE json_extract(data,'$.kind') IN ('partial_exit','full_exit');
    CREATE TABLE IF NOT EXISTS exit_shadow_event_samples(event_id INTEGER NOT NULL,relation INTEGER NOT NULL,
      position_id TEXT NOT NULL,at TEXT NOT NULL,price REAL NOT NULL,source TEXT NOT NULL,pool_address TEXT,
      PRIMARY KEY(event_id,relation));
    CREATE INDEX IF NOT EXISTS exit_shadow_event_sample_position ON exit_shadow_event_samples(position_id,event_id,relation);`);
  db.exec(`INSERT OR IGNORE INTO exit_shadow_sample_stats
    SELECT p.id,count(s.at),count(s.at),0,p.started_at,p.last_price_at FROM exit_shadow_positions p
    LEFT JOIN exit_shadow_samples s ON s.position_id=p.id GROUP BY p.id;
    UPDATE exit_shadow_sample_stats SET
      evaluated_samples=MAX(evaluated_samples,(SELECT count(*) FROM exit_shadow_samples s WHERE s.position_id=exit_shadow_sample_stats.position_id)),
      stored_samples=(SELECT count(*) FROM exit_shadow_samples s WHERE s.position_id=exit_shadow_sample_stats.position_id);`);
  const evidenceBefore=Number(db.prepare('SELECT count(*) AS n FROM exit_shadow_event_samples').get()!.n);
  db.exec(`INSERT OR IGNORE INTO exit_shadow_event_samples(event_id,relation,position_id,at,price,source,pool_address)
    SELECT e.id,0,e.position_id,s.at,s.price,s.source,NULLIF(${pool},'') FROM exit_shadow_events e
    JOIN exit_shadow_samples s ON s.position_id=e.position_id AND s.at=e.at;
    INSERT OR IGNORE INTO exit_shadow_event_samples(event_id,relation,position_id,at,price,source,pool_address)
    SELECT e.id,-1,e.position_id,s.at,s.price,s.source,
      NULLIF(COALESCE(json_extract(s.context,'$.poolAddress'),json_extract(s.context,'$.priceEvidence.pool'),''),'')
    FROM exit_shadow_events e JOIN exit_shadow_samples s ON s.rowid=(SELECT prior.rowid FROM exit_shadow_samples prior
      WHERE prior.position_id=e.position_id AND prior.at<e.at ORDER BY prior.at DESC LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM exit_shadow_event_samples current WHERE current.event_id=e.id AND current.relation=0);
    INSERT OR IGNORE INTO exit_shadow_event_samples(event_id,relation,position_id,at,price,source,pool_address)
    SELECT e.id,1,e.position_id,s.at,s.price,s.source,
      NULLIF(COALESCE(json_extract(s.context,'$.poolAddress'),json_extract(s.context,'$.priceEvidence.pool'),''),'')
    FROM exit_shadow_events e JOIN exit_shadow_samples s ON s.rowid=(SELECT following.rowid FROM exit_shadow_samples following
      WHERE following.position_id=e.position_id AND following.at>e.at ORDER BY following.at LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM exit_shadow_event_samples current WHERE current.event_id=e.id AND current.relation=0);`);
  // Post-close quotes beyond the final 60m+120s quality window are explicitly
  // outside the retained record. Delete them before rebuilding peak/gap pins
  // and metrics so those derived values cannot include out-of-scope extrema.
  const closedDeleted=Number(db.prepare(`DELETE FROM exit_shadow_samples WHERE rowid IN (
    SELECT s.rowid FROM exit_shadow_samples s JOIN exit_shadow_positions p ON p.id=s.position_id
    WHERE json_extract(p.state,'$.shadowClosed')=1
      AND CAST(strftime('%s',s.at) AS INTEGER)>CAST(strftime('%s',json_extract(p.state,'$.lastObservedAt')) AS INTEGER)+?)`)
    .run(CLOSED_HORIZON_SEC).changes);
  db.exec(`DELETE FROM exit_shadow_sample_pins WHERE reason IN ('peak','max_gap');
    INSERT OR REPLACE INTO exit_shadow_sample_pins(position_id,reason,at)
      SELECT p.id,'peak',(SELECT s.at FROM exit_shadow_samples s WHERE s.position_id=p.id ORDER BY s.price DESC,s.at LIMIT 1)
      FROM exit_shadow_positions p WHERE EXISTS (SELECT 1 FROM exit_shadow_samples s WHERE s.position_id=p.id);
    INSERT OR REPLACE INTO exit_shadow_sample_pins(position_id,reason,at)
      SELECT p.id,'max_gap',(SELECT s.at FROM exit_shadow_samples s WHERE s.position_id=p.id
        ORDER BY COALESCE(json_extract(s.context,'$.gapSec'),0) DESC,s.at LIMIT 1)
      FROM exit_shadow_positions p WHERE EXISTS (SELECT 1 FROM exit_shadow_samples s WHERE s.position_id=p.id);`);
  const positions=db.prepare('SELECT id,started_at,last_price_at FROM exit_shadow_positions ORDER BY id').all();
  for(const position of positions){
    const id=String(position.id),start=String(position.started_at);
    const latest=db.prepare('SELECT max(at) AS at FROM exit_shadow_samples WHERE position_id=?').get(id)?.at;
    if(typeof latest!=='string')continue;
    const at=Date.parse(latest),recent=iso(at-retention.recentWindowMs),mid=iso(at-retention.midWindowMs),long=iso(at-retention.longWindowMs);
    const remove=(sql:string,...args:(string|number)[])=>db.prepare(sql).run(...args);
    remove(`DELETE FROM exit_shadow_samples WHERE rowid IN (SELECT s.rowid FROM exit_shadow_samples s
      WHERE s.position_id=? AND s.at>=? AND s.at<? AND NOT ${retention.protectedSql})`,id,start,long);
    for(const [from,to,bucket] of [[long,mid,retention.longBucketSec],[mid,recent,retention.midBucketSec]] as const)
      remove(`DELETE FROM exit_shadow_samples WHERE rowid IN (SELECT rowid FROM (
        SELECT s.rowid,
          row_number() OVER (PARTITION BY CAST(CAST(strftime('%s',s.at) AS INTEGER)/? AS INTEGER),s.source,${pool} ORDER BY s.at) first_rank,
          row_number() OVER (PARTITION BY CAST(CAST(strftime('%s',s.at) AS INTEGER)/? AS INTEGER),s.source,${pool} ORDER BY s.at DESC) last_rank,
          row_number() OVER (PARTITION BY CAST(CAST(strftime('%s',s.at) AS INTEGER)/? AS INTEGER),s.source,${pool} ORDER BY s.price,s.at) min_rank,
          row_number() OVER (PARTITION BY CAST(CAST(strftime('%s',s.at) AS INTEGER)/? AS INTEGER),s.source,${pool} ORDER BY s.price DESC,s.at) max_rank
        FROM exit_shadow_samples s WHERE s.position_id=? AND s.at>=? AND s.at<? AND NOT ${retention.protectedSql})
        WHERE first_rank>1 AND last_rank>1 AND min_rank>1 AND max_rank>1)`,bucket,bucket,bucket,bucket,id,from,to);
    remove(`DELETE FROM exit_shadow_samples WHERE rowid IN (SELECT s.rowid FROM exit_shadow_samples s
      WHERE s.position_id=? AND s.at>=? AND s.at>=? AND NOT ${retention.protectedSql}
      ORDER BY s.at DESC LIMIT -1 OFFSET ?)`,id,start,recent,retention.recentMax);
    remove(`DELETE FROM exit_shadow_samples WHERE rowid IN (SELECT s.rowid FROM exit_shadow_samples s
      WHERE s.position_id=? AND s.at>=? AND NOT ${retention.protectedSql}
      ORDER BY s.at DESC LIMIT -1 OFFSET ?)`,id,start,retention.unpinnedMax);
    const stored=Number(db.prepare('SELECT count(*) AS n FROM exit_shadow_samples WHERE position_id=?').get(id)!.n);
    db.prepare(`UPDATE exit_shadow_sample_stats SET evaluated_samples=MAX(evaluated_samples,?),stored_samples=?,
      samples_thinned=CASE WHEN stored_samples>? THEN 1 ELSE samples_thinned END,
      retention_started_at=?,last_pruned_at=? WHERE position_id=?`).run(stored,stored,stored,start,latest,id);
  }
  db.exec(`UPDATE exit_shadow_positions SET
      last_price_at=(SELECT s.at FROM exit_shadow_samples s WHERE s.position_id=exit_shadow_positions.id ORDER BY s.at DESC LIMIT 1),
      last_price=(SELECT s.price FROM exit_shadow_samples s WHERE s.position_id=exit_shadow_positions.id ORDER BY s.at DESC LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM exit_shadow_samples s WHERE s.position_id=exit_shadow_positions.id);
    DELETE FROM exit_shadow_metrics;
    INSERT INTO exit_shadow_metrics(position_id,peak_price,max_gap_sec,last_source)
      SELECT p.id,COALESCE(MAX(s.price),p.last_price),COALESCE(MAX(json_extract(s.context,'$.gapSec')),0),
        COALESCE((SELECT latest.source FROM exit_shadow_samples latest WHERE latest.position_id=p.id ORDER BY latest.at DESC LIMIT 1),'')
      FROM exit_shadow_positions p LEFT JOIN exit_shadow_samples s ON s.position_id=p.id GROUP BY p.id;
    INSERT OR REPLACE INTO exit_shadow_meta(key,value)
      SELECT 'last_sample_at',COALESCE(MAX(last_price_at),'') FROM exit_shadow_positions;
    INSERT OR REPLACE INTO exit_shadow_meta VALUES ('history_complete','false');
    INSERT OR REPLACE INTO exit_shadow_meta VALUES ('sample_retention_version','tiered-v1');`);
  const samplesAfter=Number(db.prepare('SELECT count(*) AS n FROM exit_shadow_samples').get()!.n);
  return {positions:positions.length,samplesBefore,samplesAfter,samplesDeleted:samplesBefore-samplesAfter,
    closedSamplesPastHorizonDeleted:closedDeleted,eventEvidenceRows:Number(db.prepare('SELECT count(*) AS n FROM exit_shadow_event_samples').get()!.n)-evidenceBefore};
}

export function compactExitShadowOffline(database:string,backup:string):ExitShadowCompactionResult {
  if(existsSync(backup))throw new Error('EXIT_SHADOW_BACKUP_EXISTS');
  const db=new DatabaseSync(database);try{
    db.exec('PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if(Number(checkpoint?.busy))throw new Error('EXIT_SHADOW_DATABASE_BUSY');
    db.exec(`VACUUM INTO ${literal(backup)}`);
    chmodSync(backup,0o600);
    db.exec('BEGIN EXCLUSIVE');let result:ExitShadowCompactionResult;
    try{result=compactExitShadowTransaction(db);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    db.exec('VACUUM');return result;
  }finally{db.close();}
}

if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
  const database=resolve(value('--database')??'data/exit-shadow.sqlite');
  if(!args.includes('--apply')){
    console.log(JSON.stringify(inspectExitShadowCompaction(database)));
  }else{
    if(!args.includes('--confirm-service-stopped'))throw new Error('EXIT_SHADOW_OFFLINE_CONFIRMATION_REQUIRED');
    const backup=value('--backup');if(!backup)throw new Error('EXIT_SHADOW_BACKUP_REQUIRED');
    console.log(JSON.stringify({mode:'applied',database,backup:resolve(backup),...compactExitShadowOffline(database,resolve(backup))}));
  }
}
