import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ExitShadow} from '../src/exit-shadow.js';
import {ADAPTIVE_SHADOW_V5,stepAdaptiveExit,type AdaptiveExitState} from '../src/adaptive-exit.js';
import {compactExitShadowOffline,compactExitShadowTransaction,inspectExitShadowCompaction} from '../scripts/compact-exit-shadow.js';

const origin=Date.parse('2026-11-01T00:00:00.000Z');
const token={chain:'bsc' as const,address:'0x1111111111111111111111111111111111111111'};
const pool='0x2222222222222222222222222222222222222222';
const at=(ms:number)=>new Date(origin+ms).toISOString();
type Cleanup={after:(fn:()=>void)=>void};
function fixture(t:Cleanup,options:{maxBytes?:number}={}){
  const dir=mkdtempSync(join(tmpdir(),'exit-shadow-retention-')),path=join(dir,'shadow.sqlite'),clock={ms:0};
  let store=new ExitShadow(path,{now:()=>new Date(origin+clock.ms),...options});
  t.after(()=>{try{store.close();}catch{}rmSync(dir,{recursive:true,force:true});});
  return {dir,path,clock,get store(){return store;},reopen(next=options){try{store.close();}catch{}store=new ExitShadow(path,{now:()=>new Date(origin+clock.ms),...next});return store;}};
}

function fillThenReleasePages(path:string):number {
  const db=new DatabaseSync(path);try{
    db.exec('CREATE TABLE exit_shadow_capacity_filler(id INTEGER PRIMARY KEY,payload BLOB NOT NULL); BEGIN IMMEDIATE');
    const insert=db.prepare('INSERT INTO exit_shadow_capacity_filler(payload) VALUES (zeroblob(4096))');
    for(let index=0;index<256;index++)insert.run();
    db.exec('COMMIT');db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    db.exec('DROP TABLE exit_shadow_capacity_filler');db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.ok(Number(db.prepare('PRAGMA freelist_count').get()!.freelist_count)>4);
  }finally{db.close();}
  return statSync(path).size;
}

test('tiered storage advances every quote, preserves the exact policy state, and survives restart',t=>{
  const f=fixture(t),seed={candidateId:'retention',eligibleAt:at(0),endsAt:at(86_400_000)};
  let expected:AdaptiveExitState|undefined;
  for(let index=0;index<1300;index++){
    f.clock.ms=index*1000;const observedAt=at(f.clock.ms);
    f.store.recordPrice({...token,priceUsd:100,observedAt,source:'gmgn_token_info_sample'},index?undefined:seed);
    expected=stepAdaptiveExit(expected,{...token,priceUsd:100,observedAt,evaluatedAt:observedAt,
      source:'gmgn_token_info_sample',...(index?{}:{observationEndsAt:seed.endsAt})},undefined,ADAPTIVE_SHADOW_V5).state;
  }
  const id=f.store.list().items[0].id,db=new DatabaseSync(f.path,{readOnly:true});let persisted:AdaptiveExitState;
  try{persisted=JSON.parse(String(db.prepare('SELECT state FROM exit_shadow_positions WHERE id=?').get(id)!.state));}finally{db.close();}
  assert.deepEqual(persisted,JSON.parse(JSON.stringify(expected)));
  let detail=f.store.detail(id)!;
  assert.equal(detail.evaluatedSampleCount,1300);assert.ok(detail.storedSampleCount<detail.evaluatedSampleCount);
  assert.equal(detail.storedSamplesThinned,true);assert.equal(detail.sampleRetentionVersion,'tiered-v1');
  assert.equal(detail.eventSampleCount,2);assert.deepEqual(detail.eventSamples.map(row=>Number(row.relation)).sort(),[0,1]);
  f.reopen();detail=f.store.detail(id)!;
  assert.equal(detail.evaluatedSampleCount,1300);assert.equal(detail.storedSamplesThinned,true);
  f.clock.ms=1_300_000;f.store.recordPrice({...token,priceUsd:100,observedAt:at(f.clock.ms),source:'gmgn_token_info_sample'},undefined);
  assert.equal(f.store.detail(id)?.evaluatedSampleCount,1301);
});

test('detail exposes previous, current, and following provenance for every price-driven strategy event',t=>{
  const f=fixture(t),seed={candidateId:'events',eligibleAt:at(0),endsAt:at(86_400_000)};
  const send=(ms:number,priceUsd:number)=>{f.clock.ms=ms;f.store.recordPrice({...token,priceUsd,observedAt:at(ms),
    source:'gmgn_token_info_sample',market:{poolAddress:pool}},ms?undefined:seed);};
  send(0,100);send(3000,600);send(6000,610);
  const detail=f.store.detail(f.store.list().items[0].id)!;
  const eventIds=new Map<number,Set<number>>();
  for(const sample of detail.eventSamples){
    assert.equal(sample.source,'gmgn_token_info_sample');assert.equal(sample.poolAddress,pool);
    const relations=eventIds.get(Number(sample.eventId))??new Set<number>();relations.add(Number(sample.relation));eventIds.set(Number(sample.eventId),relations);
  }
  assert.ok([...eventIds.values()].some(relations=>[-1,0,1].every(value=>relations.has(value))));
});

test('offline compaction removes post-horizon rows and repairs every derived latest-price aggregate',t=>{
  const f=fixture(t),seed={candidateId:'closed',eligibleAt:at(0),endsAt:at(86_400_000)};
  f.store.recordPrice({...token,priceUsd:100,observedAt:at(0),source:'gmgn_token_info_sample',market:{poolAddress:pool}},seed);
  f.clock.ms=1000;f.store.recordPrice({...token,priceUsd:30,observedAt:at(1000),source:'gmgn_token_info_sample',market:{poolAddress:pool}},undefined);
  const id=f.store.list().items[0].id;f.store.close();
  const db=new DatabaseSync(f.path);try{
    const late=at(1000+70*60_000),context=JSON.stringify({gapSec:4200,poolAddress:pool});
    db.prepare('INSERT INTO exit_shadow_samples VALUES (?,?,?,?,?)').run(id,late,999,'gmgn_token_info_sample',context);
    db.prepare('UPDATE exit_shadow_positions SET last_price_at=?,last_price=? WHERE id=?').run(late,999,id);
    db.prepare('UPDATE exit_shadow_metrics SET peak_price=?,max_gap_sec=?,last_source=? WHERE position_id=?').run(999,4200,'gmgn_token_info_sample',id);
    db.prepare("INSERT OR REPLACE INTO exit_shadow_meta VALUES ('last_sample_at',?)").run(late);
    db.prepare("INSERT OR REPLACE INTO exit_shadow_meta VALUES ('history_complete','false')").run();
    db.prepare("INSERT OR REPLACE INTO exit_shadow_meta VALUES ('last_error','EXIT_SHADOW_CAPACITY_REACHED')").run();
    db.exec('BEGIN EXCLUSIVE');const result=compactExitShadowTransaction(db);db.exec('COMMIT');
    assert.equal(result.closedSamplesPastHorizonDeleted,1);
    const position=db.prepare('SELECT last_price_at,last_price FROM exit_shadow_positions WHERE id=?').get(id)!;
    assert.equal(position.last_price_at,at(1000));assert.equal(Number(position.last_price),30);
    const metrics=db.prepare('SELECT peak_price,max_gap_sec,last_source FROM exit_shadow_metrics WHERE position_id=?').get(id)!;
    assert.equal(Number(metrics.peak_price),100);assert.equal(Number(metrics.max_gap_sec),1);
    assert.equal(db.prepare("SELECT value FROM exit_shadow_meta WHERE key='last_sample_at'").get()!.value,at(1000));
    assert.equal(db.prepare("SELECT value FROM exit_shadow_meta WHERE key='history_complete'").get()!.value,'false');
    const stats=db.prepare('SELECT evaluated_samples,stored_samples,samples_thinned FROM exit_shadow_sample_stats WHERE position_id=?').get(id)!;
    assert.deepEqual([Number(stats.evaluated_samples),Number(stats.stored_samples),Number(stats.samples_thinned)],[3,2,1]);
  }finally{db.close();}
  f.reopen();
  assert.equal(f.store.summary().status.lastError,undefined,'physical headroom clears a stale capacity alarm without changing maxBytes');
  assert.equal(f.store.summary().status.historyComplete,false);
  const detail=f.store.detail(id)!;
  assert.equal(detail.evaluatedSampleCount,3);assert.equal(detail.storedSampleCount,2);assert.equal(detail.storedSamplesThinned,true);
});

test('dry-run is byte-for-byte read only and the offline backup is private',t=>{
  const f=fixture(t),seed={candidateId:'dry-run',eligibleAt:at(0),endsAt:at(86_400_000)};
  f.store.recordPrice({...token,priceUsd:100,observedAt:at(0),source:'gmgn_token_info_sample'},seed);
  f.store.close();
  const before=readFileSync(f.path),inspection=inspectExitShadowCompaction(f.path);
  assert.equal(inspection.mode,'dry_run');assert.equal(inspection.samples,1);
  assert.deepEqual(readFileSync(f.path),before);
  const backup=join(f.dir,'shadow.backup.sqlite');
  const result=compactExitShadowOffline(f.path,backup);
  assert.equal(result.samplesBefore,1);assert.equal(statSync(backup).mode&0o777,0o600);
  f.reopen();assert.equal(f.store.summary().status.samples,1);
});

test('offline tiers retain first, last, minimum, and maximum for each source-pool bucket',t=>{
  const f=fixture(t),seed={candidateId:'bucket',eligibleAt:at(0),endsAt:at(86_400_000)};
  f.store.recordPrice({...token,priceUsd:100,observedAt:at(0),source:'gmgn_token_info_sample',market:{poolAddress:pool}},seed);
  const id=f.store.list().items[0].id;f.store.close();const db=new DatabaseSync(f.path);
  try{
    const insert=db.prepare('INSERT INTO exit_shadow_samples VALUES (?,?,?,?,?)'),context=JSON.stringify({gapSec:60,poolAddress:pool});
    const rows=[[10*3600_000,100],[10*3600_000+60_000,80],[10*3600_000+120_000,90],
      [10*3600_000+180_000,120],[10*3600_000+240_000,110],[30*3600_000,105]] as const;
    for(const [ms,price] of rows)insert.run(id,at(ms),price,'gmgn_token_info_sample',context);
    db.prepare('UPDATE exit_shadow_positions SET last_price_at=?,last_price=? WHERE id=?').run(at(30*3600_000),105,id);
    db.exec('BEGIN EXCLUSIVE');compactExitShadowTransaction(db);db.exec('COMMIT');
    const retained=db.prepare(`SELECT at,price FROM exit_shadow_samples WHERE position_id=? AND at>=? AND at<? ORDER BY at`)
      .all(id,at(10*3600_000),at(10*3600_000+30*60_000));
    assert.deepEqual(retained.map(row=>Number(row.price)),[100,80,120,110]);
  }finally{db.close();}
});

test('a later candidate starts a new episode after the closed quality horizon',t=>{
  const f=fixture(t),first={candidateId:'first',eligibleAt:at(0),endsAt:at(24*3600_000)};
  f.store.recordPrice({...token,priceUsd:100,observedAt:at(0),source:'gmgn_token_info_sample'},first);
  f.clock.ms=1000;f.store.recordPrice({...token,priceUsd:30,observedAt:at(1000),source:'gmgn_token_info_sample'},undefined);
  assert.equal(f.store.list().items[0].exitPlan.status,'observed_closed');
  f.clock.ms=1000+3720_000+1;
  const second={candidateId:'second',eligibleAt:at(f.clock.ms),endsAt(future:number){return at(future);}};
  f.store.recordPrice({...token,priceUsd:40,observedAt:at(f.clock.ms),source:'gmgn_token_info_sample'},
    {candidateId:second.candidateId,eligibleAt:second.eligibleAt,endsAt:second.endsAt(f.clock.ms+24*3600_000)});
  const items=f.store.list().items;
  assert.equal(items.length,2);assert.equal(items[0].candidateId,'second');assert.equal(items[0].exitPlan.status,'tracking');
  assert.equal(items[1].candidateId,'first');assert.equal(items[1].exitPlan.status,'observed_closed');
});

test('a signal end cannot redirect quotes before the closed quality horizon completes',t=>{
  const f=fixture(t),first={candidateId:'first',eligibleAt:at(0),endsAt:at(10*60_000)};
  f.store.recordPrice({...token,priceUsd:100,observedAt:at(0),source:'gmgn_token_info_sample'},first);
  f.clock.ms=9*60_000;f.store.recordPrice({...token,priceUsd:30,observedAt:at(f.clock.ms),source:'gmgn_token_info_sample'},undefined);
  const closedAt=f.clock.ms;
  assert.equal(f.store.list().items[0].exitPlan.status,'observed_closed');

  // The original signal has ended, but its 5/15/60-minute exit comparisons
  // still belong to the closed episode. A new candidate must wait.
  f.clock.ms=11*60_000;f.store.recordPrice({...token,priceUsd:40,observedAt:at(f.clock.ms),source:'gmgn_token_info_sample'},
    {candidateId:'too-early',eligibleAt:at(f.clock.ms),endsAt:at(f.clock.ms+24*3600_000)});
  let items=f.store.list().items;
  assert.equal(items.length,1);assert.equal(items[0].candidateId,'first');
  assert.equal(items[0].latestPriceUsd,40,'the quote remains attributed to the closed comparison window');

  f.clock.ms=closedAt+3720_000+1;f.store.recordPrice({...token,priceUsd:50,observedAt:at(f.clock.ms),source:'gmgn_token_info_sample'},
    {candidateId:'after-horizon',eligibleAt:at(f.clock.ms),endsAt:at(f.clock.ms+24*3600_000)});
  items=f.store.list().items;
  assert.equal(items.length,2);assert.equal(items[0].candidateId,'after-horizon');assert.equal(items[0].exitPlan.status,'tracking');
});

test('capacity recovery reuses pages freed by bounded pruning before latching failure',t=>{
  const f=fixture(t),seed={candidateId:'capacity',eligibleAt:at(0),endsAt:at(72*3600_000)};
  f.store.recordPrice({...token,priceUsd:100,observedAt:at(0),source:'gmgn_token_info_sample'},seed);
  const id=f.store.list().items[0].id;f.store.close();
  const db=new DatabaseSync(f.path);try{
    const insert=db.prepare('INSERT INTO exit_shadow_samples VALUES (?,?,?,?,?)');
    const context=JSON.stringify({gapSec:1,padding:'x'.repeat(512)});
    db.exec('BEGIN');for(let index=1;index<=4000;index++)insert.run(id,at(index*1000),100,'gmgn_token_info_sample',context);db.exec('COMMIT');
    db.prepare(`UPDATE exit_shadow_sample_stats SET evaluated_samples=4001,stored_samples=4001,
      retention_started_at=?,last_pruned_at=? WHERE position_id=?`).run(at(0),at(0),id);
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  }finally{db.close();}
  const maxBytes=statSync(f.path).size;f.clock.ms=30*3600_000;f.reopen({maxBytes});
  assert.equal(f.store.summary().status.historyComplete,true);
  f.store.recordPrice({...token,priceUsd:101,observedAt:at(f.clock.ms),source:'gmgn_token_info_sample'},undefined);
  const detail=f.store.detail(id)!;
  assert.equal(detail.evaluatedSampleCount,4002);assert.equal(detail.storedSamplesThinned,true);
  assert.equal(f.store.summary().status.lastError,undefined);assert.equal(f.store.summary().status.historyComplete,true);
  const verify=new DatabaseSync(f.path,{readOnly:true});try{
    assert.ok(Number(verify.prepare('PRAGMA freelist_count').get()!.freelist_count)>0);
  }finally{verify.close();}
});

test('price-unavailable evidence reuses freelist pages when the database file is at its byte limit',t=>{
  const f=fixture(t),seed={candidateId:'error-capacity',eligibleAt:at(0),endsAt:at(86_400_000)};
  f.store.recordPrice({...token,priceUsd:100,observedAt:at(0),source:'gmgn_token_info_sample'},seed);
  const id=f.store.list().items[0].id;f.store.close();
  const maxBytes=fillThenReleasePages(f.path);f.reopen({maxBytes});f.clock.ms=1000;

  f.store.recordError(token,'ALL_PRICE_SOURCES_UNAVAILABLE');

  const detail=f.store.detail(id)!;
  assert.equal(detail.item.lastError,'ALL_PRICE_SOURCES_UNAVAILABLE');
  assert.equal(detail.item.events.filter(event=>event.kind==='price_unavailable').length,1);
  assert.equal(f.store.summary().status.lastError,undefined);
  assert.equal(f.store.summary().status.historyComplete,true);
});

test('extreme-price quarantine reuses freelist pages when the database file is at its byte limit',t=>{
  const f=fixture(t),seed={candidateId:'quarantine-capacity',eligibleAt:at(0),endsAt:at(86_400_000)};
  f.store.recordPrice({...token,priceUsd:1,observedAt:at(0),source:'gmgn_token_info_sample',market:{poolAddress:pool}},seed);
  const id=f.store.list().items[0].id;f.store.close();
  const maxBytes=fillThenReleasePages(f.path);f.reopen({maxBytes});f.clock.ms=3000;

  f.store.recordPrice({...token,priceUsd:100,observedAt:at(f.clock.ms),source:'gmgn_token_info_sample',market:{poolAddress:pool}},undefined);

  const detail=f.store.detail(id)!;
  assert.equal(detail.sampleCount,1);
  assert.equal(detail.item.events.filter(event=>event.kind==='price_quarantined').length,1);
  const verify=new DatabaseSync(f.path,{readOnly:true});try{
    assert.equal(Number(verify.prepare('SELECT count(*) AS n FROM exit_shadow_price_quarantine').get()!.n),1);
  }finally{verify.close();}
  assert.equal(f.store.summary().status.lastError,undefined);
  assert.equal(f.store.summary().status.historyComplete,true);
});
