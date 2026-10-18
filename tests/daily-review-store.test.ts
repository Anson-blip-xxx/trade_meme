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

const address='0x'+'a'.repeat(40),at='2026-10-16T01:00:00.000Z';
const input:ReviewInput={date:'2026-10-15',asOf:at,entryMode:'off',notifications:[],decisions:[],prices:[],vendor:[],orders:[],executions:[],limitations:[]};
function fixture(t:{after:(fn:()=>void)=>void},options:{maxItems?:number}={}){
  const dir=mkdtempSync(join(tmpdir(),'meme-review-store-')),path=join(dir,'review.sqlite'),store=new DailyReviewStore(path,options);
  t.after(()=>{try{store.close();}catch{}rmSync(dir,{recursive:true,force:true});});return {store,path};
}
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
