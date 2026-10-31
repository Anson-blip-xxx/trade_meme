import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DailyReviewStore} from '../src/daily-review-store.js';
import {buildDailyReview,type ReviewInput} from '../src/daily-review.js';
import {EntryController} from '../src/entry.js';
import {readConfig} from '../src/config.js';
import {OrderStore} from '../src/orders.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import type {Report} from '../src/types.js';
import {summarizeExitQuality,type ExitQualityReview} from '../src/exit-quality.js';
import type {NotificationTriggerOutcome} from '../src/notification-outcomes.js';

const address='0x'+'a'.repeat(40),at='2026-10-16T01:00:00.000Z';
const input:ReviewInput={date:'2026-10-15',asOf:at,entryMode:'off',notifications:[],decisions:[],prices:[],vendor:[],orders:[],executions:[],limitations:[]};
function fixture(t:{after:(fn:()=>void)=>void},options:{maxItems?:number}={}){
  const dir=mkdtempSync(join(tmpdir(),'meme-review-store-')),path=join(dir,'review.sqlite'),store=new DailyReviewStore(path,options);
  t.after(()=>{try{store.close();}catch{}rmSync(dir,{recursive:true,force:true});});return {store,path};
}
function qualitySnapshot(asOf=at):ExitQualityReview {
  return JSON.parse(JSON.stringify({version:'exit-quality-review-v1',asOf,sinceAt:new Date(Date.parse(asOf)-7*86400_000).toISOString(),
    scope:'closed_shadow_positions',total:0,reviewed:0,limit:1000,truncated:false,historyComplete:false,
    summaryBasis:'equal_weight_per_position_gross_simulation',summary:summarizeExitQuality([]),byPolicy:[],cases:[]})) as ExitQualityReview;
}
test('exit-quality snapshots publish independently, once per Shanghai day, without rewriting signal reports',t=>{
  const {store}=fixture(t),report=buildDailyReview(input),snapshot=qualitySnapshot();store.save(report);
  assert.equal(store.hasExitQuality('2026-10-16'),false);assert.equal(store.saveExitQuality(snapshot),true);
  assert.equal(store.hasExitQuality('2026-10-16'),true);
  assert.equal(store.saveExitQuality({...snapshot,asOf:'2026-10-16T15:59:59.999Z',historyComplete:true}),false);
  assert.deepEqual(store.page({date:report.date}).exitQuality,snapshot);
  assert.equal(store.page().report?.generatedAt,report.generatedAt);
  const next=qualitySnapshot('2026-10-16T16:00:00.000Z');assert.equal(store.saveExitQuality(next),true);
  assert.deepEqual(store.page({runId:report.id}).exitQuality,next);
  assert.deepEqual(store.page({date:'2026-10-13'}).exitQuality,next);
  assert.equal(store.page({date:'2026-10-13'}).report,undefined);
});
test('exit-quality retention removes expired snapshots and invalid attempts preserve existing data',t=>{
  const {store}=fixture(t),old=qualitySnapshot('2026-06-01T01:00:00.000Z'),latest=qualitySnapshot();
  store.saveExitQuality(old);store.saveExitQuality(latest);
  assert.throws(()=>store.saveExitQuality({...latest,asOf:'invalid'}),/EXIT_QUALITY_SNAPSHOT_INVALID/);
  assert.throws(()=>store.saveExitQuality({...latest,sinceAt:'2026-10-17T01:00:00.000Z'}),/EXIT_QUALITY_SNAPSHOT_INVALID/);
  store.prune(new Date('2026-10-18T01:00:00.000Z'));
  assert.equal(store.hasExitQuality('2026-06-01'),false);assert.deepEqual(store.page().exitQuality,latest);
  store.prune(new Date('2027-02-01T01:00:00.000Z'));assert.equal(store.page().exitQuality,undefined);
});
test('exit-quality failure is separate from signal report success and preserves last successful snapshot',t=>{
  const {store}=fixture(t),snapshot=qualitySnapshot();store.saveExitQuality(snapshot);store.exitQualityFailure(at);
  store.save(buildDailyReview(input));store.markRunSucceeded(at);
  assert.equal(store.page().status.last_error,undefined);
  assert.equal(store.page().status.exit_quality_error,'EXIT_QUALITY_REVIEW_FAILED');
  assert.deepEqual(store.page().exitQuality,snapshot);
  store.saveExitQuality(qualitySnapshot('2026-10-17T01:00:00.000Z'));
  assert.equal(store.page().status.exit_quality_error,undefined);
});
test('daily report publication is immutable and pinned pagination survives another revision',t=>{
  const {store,path}=fixture(t),report=buildDailyReview({...input,notifications:Array.from({length:25},(_,i)=>({id:String(i),chain:'bsc',address:'0x'+(i+1).toString(16).padStart(40,'0'),source:'debot',receivedAt:'2026-10-15T01:00:00.000Z',occurredAt:'2026-10-15T00:59:59.000Z'}))});
  assert.equal(store.save(report),true);assert.equal(store.save({...report,counts:{...report.counts,tokens:999}}),false);
  const page=store.page();assert.equal(page.total,25);assert.equal(page.items.length,20);assert.equal(page.hasMore,true);assert.equal(page.report?.counts.tokens,25);
  const newer={...report,id:'b'.repeat(24),generatedAt:'2026-10-17T01:00:00.000Z',items:report.items.slice(0,1)};store.save(newer);
  assert.equal(store.page().report?.id,newer.id);
  const pinned=store.page({runId:report.id,date:report.date,offset:20});assert.equal(pinned.items.length,5);assert.equal(pinned.hasMore,false);
  assert.equal(pinned.report?.id,report.id);assert.equal(store.page({chain:'solana'}).total,0);
  assert.throws(()=>store.page({date:'2026-02-30'}),/REVIEW_DATE_INVALID/);
  assert.throws(()=>store.page({runId:report.id,date:'2026-10-14'}),/REVIEW_DATE_INVALID/);
  assert.equal(statSync(path).mode&0o777,0o600);
});
test('notification learning uses only the latest revision and an incomplete correction invalidates earlier evidence',t=>{
  const {store}=fixture(t),outcome=(event:string,gain:number):NotificationTriggerOutcome=>({source:'debot',chain:'bsc',address,
    sessionFirstReceivedAt:'2026-10-15T01:00:00.000Z',sessionExpiresAt:'2026-10-15T07:00:00.000Z',notificationNumber:3,
    triggerEventId:event,triggerAt:'2026-10-15T01:02:00.000Z',triggerOrderAmbiguous:false,horizons:[{seconds:21600,
      endsAt:'2026-10-15T07:02:00.000Z',mature:true,status:'covered',maxGainPct:gain,sampledBarrierOrder:'neither'}]});
  const base=buildDailyReview({...input,notifications:[{id:'n',chain:'bsc',address,source:'debot',receivedAt:'2026-10-15T01:00:00.000Z',occurredAt:'2026-10-15T01:00:00.000Z'}]});
  const complete={...base,id:'d'.repeat(24),generatedAt:'2026-10-16T02:00:00.000Z',items:base.items.map(item=>({...item,notificationOutcomes:[outcome('complete',25)]}))};
  const incomplete={...base,id:'e'.repeat(24),generatedAt:'2026-10-16T03:00:00.000Z',datasetComplete:false,items:base.items.map(item=>({...item,notificationOutcomes:[outcome('incomplete',999)]}))};
  store.save(complete);store.save(incomplete);
  assert.deepEqual(store.notificationOutcomes(),[]);
});
test('notification outcome expansion fails explicitly instead of truncating inside a report item',t=>{
  const {store}=fixture(t),base=buildDailyReview({...input,notifications:[{id:'n',chain:'bsc',address,source:'debot',receivedAt:'2026-10-15T01:00:00.000Z',occurredAt:'2026-10-15T01:00:00.000Z'}]});
  const common={source:'debot' as const,chain:'bsc' as const,address,sessionFirstReceivedAt:'2026-10-15T01:00:00.000Z',
    sessionExpiresAt:'2026-10-15T07:00:00.000Z',triggerOrderAmbiguous:false,horizons:[]};
  const outcomes:NotificationTriggerOutcome[]=[{...common,notificationNumber:3,triggerEventId:'three',triggerAt:'2026-10-15T01:02:00.000Z'},
    {...common,notificationNumber:4,triggerEventId:'four',triggerAt:'2026-10-15T01:03:00.000Z'}];
  store.save({...base,id:'f'.repeat(24),items:base.items.map(item=>({...item,notificationOutcomes:outcomes}))});
  assert.throws(()=>store.notificationOutcomes(1),/REVIEW_NOTIFICATION_OUTCOME_LIMIT_EXCEEDED/);
  assert.equal(store.notificationOutcomes(2).length,2);
});
test('dashboard page exposes only the newest global revision for each candidate scope and parameter',t=>{
  const {store,path}=fixture(t),older={id:'older',generatorVersion:'notification-trigger-shadow-v2',generatedAt:'2026-10-16T01:00:00.000Z',
    scope:{source:'debot',chain:'solana'},change:{parameter:'signal.trigger_count'},status:'collecting'},
    candidate={...older,id:'candidate',generatedAt:'2026-10-16T02:00:00.000Z',status:'shadow_ready'},
    legacy={id:'legacy',generatorVersion:'daily-shadow-policy-v1',generatedAt:'2026-10-16T03:00:00.000Z',
      scope:{source:'debot',chain:'solana',basePolicyVersion:'entry-v1'},change:{parameter:'entry.require_social_link'},status:'shadow_ready'};
  const writer=new DatabaseSync(path);try{
    writer.exec(`CREATE TABLE review_shadow_policy_candidates(id TEXT PRIMARY KEY,generated_at TEXT,chain TEXT,base_policy_version TEXT,parameter TEXT,status TEXT,data TEXT);
      CREATE TABLE review_shadow_policy_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
    const insert=writer.prepare('INSERT INTO review_shadow_policy_candidates VALUES(?,?,?,?,?,?,?)');
    for(const value of [older,candidate,legacy])insert.run(value.id,value.generatedAt,'solana','scope',value.change.parameter,value.status,JSON.stringify(value));
    writer.prepare('INSERT INTO review_shadow_policy_meta VALUES(?,?)').run('last_generated_at','2026-10-16T02:00:00.000Z');
  }finally{writer.close();}
  const page=store.page();assert.deepEqual(page.shadowPolicies.items,[candidate]);
  assert.equal(page.shadowPolicies.status.last_generated_at,'2026-10-16T02:00:00.000Z');
});
test('entry-off result is audited without network or raw report secrets; sink failure does not alter execution',async t=>{
  const {store,path}=fixture(t),orders=new OrderStore(':memory:');t.after(()=>orders.close());
  const client=new GmgnClient({apiKey:'test',minIntervalMs:350});
  const report={id:'report-1',evaluatedAt:at,signal:{token:{chain:'bsc',address}},privateKey:'SHOULD_NOT_PERSIST',gmgn:{raw:'SHOULD_NOT_PERSIST'}} as unknown as Report;
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw new Error('MUST_NOT_ACCESS_NETWORK');});
  const entry=new EntryController(readConfig({ENTRY_MODE:'off'}),orders,client,{now:()=>new Date(at),onDecision:(r,result,time)=>store.recordEntry(r,result,'off',time)});
  assert.deepEqual(await entry.consider(report),{status:'skipped',reason:'ENTRY_DISABLED'});assert.equal(fetchMock.mock.callCount(),0);
  const db=new DatabaseSync(path,{readOnly:true});const rows=db.prepare('SELECT data FROM review_entry_attempts').all();db.close();
  assert.equal(rows.length,1);const serialized=String(rows[0].data);assert.equal(serialized.includes('SHOULD_NOT_PERSIST'),false);
  assert.deepEqual(JSON.parse(serialized),{chain:'bsc',address,at,mode:'off',status:'skipped',reason:'ENTRY_DISABLED',scanId:'report-1',decisionAt:at});
  const broken=new EntryController(readConfig({ENTRY_MODE:'off'}),orders,client,{onDecision:()=>{throw new Error('AUDIT_FAILURE');}});
  assert.deepEqual(await broken.consider(report),{status:'skipped',reason:'ENTRY_DISABLED'});
});
test('failed daily run keeps previous report and exposes a safe error marker; later successful run clears it',t=>{
  const {store}=fixture(t),report=buildDailyReview(input);store.save(report);store.failure(at);
  assert.equal(store.page().status.last_error,'DAILY_REVIEW_FAILED');assert.equal(store.page().report?.id,report.id);
  store.save({...report,id:'c'.repeat(24),generatedAt:'2026-10-17T01:00:00.000Z'});assert.equal(store.page().status.last_error,undefined);
});
test('daily review publishes related state once after SQL writes and before the report becomes visible to other readers',t=>{
  const {store,path}=fixture(t),report=buildDailyReview(input),reader=new DatabaseSync(path,{readOnly:true});
  t.after(()=>reader.close());let publications=0;
  const publish=()=>{
    publications++;
    assert.equal(store.page().report?.id,report.id);
    assert.equal(store.page().status.last_success_at,report.generatedAt);
    assert.equal(reader.prepare('SELECT count(*) n FROM review_runs').get()!.n,0);
  };
  assert.equal(store.save(report,publish),true);assert.equal(publications,1);
  assert.equal(reader.prepare('SELECT count(*) n FROM review_runs').get()!.n,1);
  assert.equal(store.save(report,publish),false);assert.equal(publications,1);
});
test('failed SQL or an unavailable write lock never invokes the publication callback',t=>{
  const {store,path}=fixture(t),report=buildDailyReview(input),writer=new DatabaseSync(path);t.after(()=>writer.close());let publications=0;
  writer.exec("CREATE TRIGGER fail_review_meta BEFORE INSERT ON review_meta BEGIN SELECT RAISE(ABORT,'TEST_META_WRITE_FAILED'); END");
  assert.throws(()=>store.save(report,()=>{publications++;}),/TEST_META_WRITE_FAILED/);
  assert.equal(publications,0);assert.equal(store.exists(report.id),false);assert.equal(store.page().status.last_success_at,undefined);
  writer.exec('DROP TRIGGER fail_review_meta; BEGIN IMMEDIATE');
  try {assert.throws(()=>store.save(report,()=>{publications++;}),/database is locked/);}
  finally {writer.exec('ROLLBACK');}
  assert.equal(publications,0);assert.equal(store.exists(report.id),false);
});
test('publication callback failure rolls back report, items and success metadata while preserving earlier report',t=>{
  const {store,path}=fixture(t),previous=buildDailyReview(input);store.save(previous);store.failure(at);
  const report=buildDailyReview({...input,asOf:'2026-10-17T01:00:00.000Z',notifications:[{id:'notification',chain:'bsc',address,source:'debot',
    receivedAt:'2026-10-15T01:00:00.000Z',occurredAt:'2026-10-15T00:59:59.000Z'}]});
  let publications=0;
  assert.throws(()=>store.save(report,()=>{publications++;throw new Error('TEST_PUBLICATION_FAILED');}),/TEST_PUBLICATION_FAILED/);
  assert.equal(publications,1);assert.equal(store.exists(report.id),false);assert.equal(store.page().report?.id,previous.id);
  assert.equal(store.page().status.last_success_at,previous.generatedAt);assert.equal(store.page().status.last_error,'DAILY_REVIEW_FAILED');
  const reader=new DatabaseSync(path,{readOnly:true});
  try {assert.equal(reader.prepare('SELECT count(*) n FROM review_items WHERE run_id=?').get(report.id)!.n,0);}
  finally {reader.close();}
  assert.equal(store.save(report,()=>{publications++;}),true);assert.equal(publications,2);
  assert.equal(store.page().report?.id,report.id);assert.equal(store.page().total,1);assert.equal(store.page().status.last_error,undefined);
});

function capacityReport(date:string,asOf:string,count:number) {
  return buildDailyReview({...input,date,asOf,notifications:Array.from({length:count},(_,i)=>({id:String(i),chain:'bsc',
    address:'0x'+(i+1).toString(16).padStart(40,'0'),source:'debot',receivedAt:`${date}T01:00:00.000Z`,occurredAt:`${date}T00:59:59.000Z`}))});
}
test('capacity pruning removes whole oldest reports and their dates; duplicate reports cannot trigger pruning',t=>{
  const {store,path}=fixture(t,{maxItems:5});
  const first=capacityReport('2026-10-13','2026-10-14T01:00:00.000Z',3),second=capacityReport('2026-10-14','2026-10-15T01:00:00.000Z',2),
    latest=capacityReport('2026-10-15','2026-10-16T01:00:00.000Z',2);
  store.save(first);store.save(second);
  assert.equal(store.save({...second,items:[...second.items,...first.items,...first.items]},()=>{throw new Error('DUPLICATE_MUST_NOT_PUBLISH');}),false);
  assert.equal(store.page({runId:first.id}).total,3);assert.equal(store.page({runId:second.id}).total,2);
  store.save(latest);
  assert.equal(store.exists(first.id),false);assert.equal(store.page({runId:first.id}).total,0);
  assert.equal(store.page({runId:second.id}).total,2);assert.equal(store.page({runId:latest.id}).total,2);
  assert.deepEqual(store.page().dates.map(row=>row.date),['2026-10-15','2026-10-14']);
  const reader=new DatabaseSync(path,{readOnly:true});
  try {
    assert.equal(reader.prepare('SELECT count(*) n FROM review_items').get()!.n,4);
    assert.equal(reader.prepare('SELECT count(*) n FROM review_items WHERE run_id=?').get(first.id)!.n,0);
  }finally{reader.close();}
});
test('capacity pruning rolls back with failed publication and rejects a report exceeding its own capacity',t=>{
  const {store,path}=fixture(t,{maxItems:5});
  const first=capacityReport('2026-10-13','2026-10-14T01:00:00.000Z',3),second=capacityReport('2026-10-14','2026-10-15T01:00:00.000Z',2),
    latest=capacityReport('2026-10-15','2026-10-16T01:00:00.000Z',3),oversized=capacityReport('2026-10-16','2026-10-17T01:00:00.000Z',6);
  store.save(first);store.save(second);
  assert.throws(()=>store.save(latest,()=>{throw new Error('PUBLICATION_FAILED_AFTER_PRUNING');}),/PUBLICATION_FAILED_AFTER_PRUNING/);
  assert.equal(store.exists(latest.id),false);assert.equal(store.page({runId:first.id}).total,3);assert.equal(store.page({runId:second.id}).total,2);
  assert.throws(()=>store.save(oversized,()=>{throw new Error('MUST_NOT_PUBLISH');}),/REVIEW_ITEM_LIMIT_EXCEEDED/);
  assert.equal(store.exists(oversized.id),false);assert.deepEqual(store.page().dates.map(row=>row.date),['2026-10-14','2026-10-13']);
  const reader=new DatabaseSync(path,{readOnly:true});
  try {assert.equal(reader.prepare('SELECT count(*) n FROM review_items').get()!.n,5);}
  finally{reader.close();}
});
