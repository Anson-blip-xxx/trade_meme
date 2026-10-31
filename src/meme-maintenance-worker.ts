import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {maintainMemePriceArchive,MEME_FULL_SNAPSHOT_MAX_ROWS,memePriceArchiveDeletionCeiling,
  type MemePriceArchiveMaintenance} from './meme-price-archive.js';

const options=workerData as {database:string;maxBytes:number;reclaimedSnapshots:number};
const db=new DatabaseSync(options.database);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=NORMAL');
const pageSize=Number(db.prepare('PRAGMA page_size').get()!.page_size);
const DELETE_BATCH=10,FULL_SNAPSHOT_DELETE_BATCH=250,PRICE_ARCHIVE_BATCH=100;
let stopping=false,timer:ReturnType<typeof setTimeout>|undefined,reclaimed=options.reclaimedSnapshots;
let maxWriteLockMs=0;
const measure=()=>Math.max(0,Number(db.prepare('PRAGMA page_count').get()!.page_count)-Number(db.prepare('PRAGMA freelist_count').get()!.freelist_count))*pageSize;
const safeArchiveError=(error:unknown)=>{
  const message=error instanceof Error?error.message:'';
  if(/locked|busy/i.test(message))return 'MEME_PRICE_ARCHIVE_BUSY';
  if(/full|maximum database size/i.test(message))return 'MEME_PRICE_ARCHIVE_CAPACITY_REACHED';
  if(/no such table|no such column|malformed|corrupt|schema/i.test(message))return 'MEME_PRICE_ARCHIVE_SCHEMA_INVALID';
  return 'MEME_PRICE_ARCHIVE_MAINTENANCE_FAILED';
};
const boundedDelete=(table:'meme_snapshots'|'meme_catalysts',where:string,order:string,args:(string|number|null)[],batch=DELETE_BATCH)=>{
  const started=performance.now();
  db.exec('BEGIN IMMEDIATE');try {
    const changed=Number(db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${batch})`).run(...args).changes);
    db.exec('COMMIT');return changed;
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
  finally{maxWriteLockMs=Math.max(maxWriteLockMs,performance.now()-started);}
};
const boundedRowidDelete=(table:'meme_signals'|'meme_tokens'|'meme_sampling_selections'|'meme_sampling_plans'|'meme_forward_targets',where:string,order:string,args:(string|number|null)[])=>{const started=performance.now();db.exec('BEGIN IMMEDIATE');try{
  const changed=Number(db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${DELETE_BATCH})`).run(...args).changes);
  db.exec('COMMIT');return changed;}
  catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
  finally{maxWriteLockMs=Math.max(maxWriteLockMs,performance.now()-started);}};
const run=()=>{
  if(stopping)return;const started=performance.now(),checkedAt=new Date().toISOString(),cutoff=new Date(Date.now()-30*86400000).toISOString();
  let backlog=false;maxWriteLockMs=0;
  try {
    // Copy legacy JSON rows faster than they are retired. Current observations
    // are already dual-written by MemeObserver in the sample savepoint.
    const archiveStarted=performance.now();let archiveError:string|undefined;
    let prices:MemePriceArchiveMaintenance={deleted:0,backfilled:0,backfillPending:true,retentionBacklog:false};
    try {prices=maintainMemePriceArchive(db,Date.now(),PRICE_ARCHIVE_BATCH,PRICE_ARCHIVE_BATCH);}
    catch(error){archiveError=safeArchiveError(error);backlog=true;}
    const archiveDurationMs=performance.now()-archiveStarted;
    backlog=prices.backfillPending||prices.retentionBacklog||backlog;
    // A failed archive pass cannot prove that a full snapshot is safely copied.
    // Keep those source rows, but continue unrelated retention and checkpointing.
    if(!archiveError){
      const ceiling=memePriceArchiveDeletionCeiling(db),suffix=ceiling===undefined?'':' AND id<=?';
      const ageArgs:(string|number)[]=ceiling===undefined?[cutoff]:[cutoff,ceiling];
      backlog=boundedDelete('meme_snapshots',`observed_at<?${suffix}`,'observed_at,id',ageArgs,FULL_SNAPSHOT_DELETE_BATCH)===FULL_SNAPSHOT_DELETE_BATCH||backlog;
      const snapshots=Number(db.prepare('SELECT count(*) AS n FROM meme_snapshots').get()!.n);
      if(snapshots>MEME_FULL_SNAPSHOT_MAX_ROWS){
        const capArgs:number[]=ceiling===undefined?[]:[ceiling];
        const removed=boundedDelete('meme_snapshots',ceiling===undefined?'1=1':'id<=?','id',capArgs,FULL_SNAPSHOT_DELETE_BATCH);
        reclaimed+=removed;backlog=removed>0||backlog;
      }
    }
    backlog=boundedDelete('meme_catalysts','observed_at<?','observed_at,id',[cutoff])===DELETE_BATCH||backlog;
    const catalysts=Number(db.prepare('SELECT count(*) AS n FROM meme_catalysts').get()!.n);
    if(catalysts>20000)backlog=boundedDelete('meme_catalysts','1=1','id',[])>0||backlog;
    backlog=boundedRowidDelete('meme_signals','observed_at<?','observed_at,rowid',[cutoff])===DELETE_BATCH||backlog;
    backlog=boundedRowidDelete('meme_tokens','last_signal_at<?','last_signal_at,rowid',[cutoff])===DELETE_BATCH||backlog;
    backlog=boundedRowidDelete('meme_sampling_selections','last_selected_at<?','last_selected_at,rowid',[cutoff])===DELETE_BATCH||backlog;
    backlog=boundedRowidDelete('meme_sampling_plans','first_applied_at<? AND plan_id NOT IN (SELECT plan_id FROM meme_sampling_selections)','first_applied_at,rowid',[cutoff])===DELETE_BATCH||backlog;
    const forwardCutoff=new Date(Date.now()-7*86400000).toISOString();
    backlog=boundedRowidDelete('meme_forward_targets','until_at<?','until_at,rowid',[forwardCutoff])===DELETE_BATCH||backlog;
    let usedBytes=measure(),pressure=usedBytes>=options.maxBytes*0.8;
    if(pressure&&!archiveError){
      const ceiling=memePriceArchiveDeletionCeiling(db),args:number[]=ceiling===undefined?[]:[ceiling];
      const removed=boundedDelete('meme_snapshots',ceiling===undefined?'1=1':'id<=?','id',args,FULL_SNAPSHOT_DELETE_BATCH);
      reclaimed+=removed;backlog=removed>0||backlog;usedBytes=measure();pressure=usedBytes>options.maxBytes*0.7;
    }
    const checkpoint=db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()!;
    parentPort!.postMessage({type:'status',value:{usedBytes,checkedAt,pressure,reclaimedSnapshots:reclaimed,
      lastDurationMs:performance.now()-started,maxWriteLockMs,checkpointedPages:Number(checkpoint.checkpointed??0),
      priceArchive:{backfilled:prices.backfilled,deleted:prices.deleted,backfillPending:prices.backfillPending,
        retentionBacklog:prices.retentionBacklog,stage:'maintain',durationMs:archiveDurationMs,...(archiveError?{error:archiveError}:{})},
      ...(pressure?{error:'MEME_OBSERVATION_STORAGE_PRESSURE'}:archiveError?{error:archiveError}:{})}});
    if(!stopping){const retry=archiveError?(archiveError==='MEME_PRICE_ARCHIVE_BUSY'?1000:5000):backlog||pressure?1000:60_000;
      timer=setTimeout(run,retry);timer.unref();}
  }catch(error){
    const message=error instanceof Error?error.message:'';
    if(!/locked|busy/i.test(message))parentPort!.postMessage({type:'failed',at:checkedAt});
    if(!stopping){timer=setTimeout(run,/locked|busy/i.test(message)?1000:5000);timer.unref();}
  }
};
parentPort!.on('message',message=>{
  if(message==='run'&&!stopping){clearTimeout(timer);timer=setTimeout(run,0);timer.unref();return;}
  if(message!=='stop')return;stopping=true;clearTimeout(timer);db.close();parentPort!.close();
});
run();
