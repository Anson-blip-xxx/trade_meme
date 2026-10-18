import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {recordDailyReviewServiceResult} from '../scripts/daily-review-status.js';
import {DailyReviewStore} from '../src/daily-review-store.js';
import {buildDailyReview,reviewDatabasePath} from '../src/daily-review.js';

const at='2026-10-18T01:00:00.000Z',script=new URL('../scripts/daily-review-status.ts',import.meta.url);
function fixture(t:{after:(fn:()=>void)=>void}) {
  const dir=mkdtempSync(join(tmpdir(),'meme-review-status-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {dir,path:join(dir,'review.sqlite')};
}
function child(args:string[],env:NodeJS.ProcessEnv) {
  return spawnSync(process.execPath,['--import','tsx',...args],{encoding:'utf8',timeout:10000,
    env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_NO_WARNINGS:'1',...env}});
}

test('systemd success causes no file operation, clock call or configuration read',t=>{
  const {path}=fixture(t);
  recordDailyReviewServiceResult({result:'success',path,now:()=>{throw new Error('MUST_NOT_READ_CLOCK');}});
  assert.equal(existsSync(path),false);
  const run=child([fileURLToPath(script)],{SERVICE_RESULT:'success',SCAN_DATABASE_PATH:':memory:'});
  assert.equal(run.status,0);assert.equal(run.stdout,'');assert.equal(run.stderr,'');
});

test('abnormal and unknown systemd results persist only the fixed failure marker',t=>{
  const {path}=fixture(t);
  for(const result of ['core-dump','signal','timeout','oom-kill','exit-code',undefined]) {
    recordDailyReviewServiceResult({result,path,now:()=>new Date(at)});
    const store=new DailyReviewStore(path);
    try {assert.deepEqual(store.page().status,{last_error:'DAILY_REVIEW_FAILED',last_attempt_at:at});}
    finally {store.close();}
  }
});

test('successful whole-run acknowledgment clears stale failure without replacing preserved report timestamps',t=>{
  const {path}=fixture(t),store=new DailyReviewStore(path);t.after(()=>store.close());
  const report=buildDailyReview({date:'2026-10-17',asOf:at,entryMode:'off',notifications:[],decisions:[],prices:[],vendor:[],orders:[],executions:[],limitations:[]});
  store.save(report);store.failure(at);
  const completedAt='2026-10-18T01:05:00.000Z';store.markRunSucceeded(completedAt);
  assert.equal(store.page().status.last_error,undefined);assert.equal(store.page().status.last_attempt_at,completedAt);
  assert.equal(store.page().status.last_success_at,at);assert.equal(store.page().report?.id,report.id);
});

test('status module import is inert and direct abnormal service invocation records failure',t=>{
  const {dir}=fixture(t),archive=join(dir,'scans.sqlite'),path=reviewDatabasePath(archive);
  const env={SERVICE_RESULT:'core-dump',SCAN_DATABASE_PATH:archive};
  const imported=child(['--input-type=module','-e',`await import(${JSON.stringify(script.href)})`],env);
  assert.equal(imported.status,0);assert.equal(imported.stdout,'');assert.equal(imported.stderr,'');assert.equal(existsSync(path),false);
  const run=child([fileURLToPath(script)],env);
  assert.equal(run.status,0);assert.equal(run.stdout,'');assert.equal(run.stderr,'');assert.equal(existsSync(path),true);
  const store=new DailyReviewStore(path);
  try {assert.equal(store.page().status.last_error,'DAILY_REVIEW_FAILED');assert.ok(Number.isFinite(Date.parse(String(store.page().status.last_attempt_at))));}
  finally {store.close();}
});

test('status recording failure emits one fixed code with nonzero exit and no configuration or path details',t=>{
  const {dir}=fixture(t),blocked=join(dir,'private-blocked-parent');writeFileSync(blocked,'file');
  const run=child([fileURLToPath(script)],{SERVICE_RESULT:'core-dump',SCAN_DATABASE_PATH:join(blocked,'private-scans.sqlite')});
  assert.equal(run.status,1);assert.equal(run.stdout,'');assert.equal(run.stderr,'DAILY_REVIEW_STATUS_FAILED\n');
});
