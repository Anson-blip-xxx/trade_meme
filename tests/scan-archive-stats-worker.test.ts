import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ScanArchive} from '../src/scan-archive.js';
import {SCAN_ARCHIVE_AGGREGATE_SQL} from '../src/scan-archive-stats-query.js';
import type {Stored} from '../src/store.js';

const now=Date.parse('2026-11-19T06:00:00.000Z'),address='0x'+'a'.repeat(40);
const entry=():Stored=>{const signal={source:'manual' as const,sourceEventId:'worker-test',occurredAt:new Date(now-1_000).toISOString(),
  token:{chain:'bsc' as const,address},text:'',evidenceUrls:[],claim:'unspecified' as const};return {id:'worker-test',status:'completed',
  signal,receivedAt:new Date(now-1_000).toISOString(),report:{id:'worker-test',mode:'live',policyVersion:'test',signal,
    receivedAt:new Date(now-1_000).toISOString(),evaluatedAt:new Date(now).toISOString(),validUntil:new Date(now+60_000).toISOString(),
    decision:'REJECT',buyEligible:false,executionEnabled:false,reasons:[],provenance:{status:'pass',reasons:[],facts:{},checkedAt:new Date(now).toISOString()},
    safety:{status:'fail',reasons:[],facts:{},checkedAt:new Date(now).toISOString()},
    narrative:{status:'unknown',reasons:[],facts:{},checkedAt:new Date(now).toISOString(),evidence:[]}}};};

const waitFor=async(check:()=>boolean,timeoutMs=5_000)=>{
  const deadline=Date.now()+timeoutMs;while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(check(),true,'timed out waiting for scan archive stats worker');
};

test('file archive aggregates never query SQLite on the caller thread and preserve the last snapshot on worker failure',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'scan-archive-stats-worker-')),database=join(directory,'scans.sqlite');
  let seed:ScanArchive|undefined=new ScanArchive(database,{now:()=>new Date(now),statsRefreshMs:20});
  seed.capture(entry());seed.close();seed=undefined;
  const archive=new ScanArchive(database,{now:()=>new Date(now),statsRefreshMs:20});
  try {
    const internal=archive as unknown as {db:DatabaseSync},original=internal.db.prepare.bind(internal.db);
    internal.db.prepare=(()=>{throw new Error('CALLER_THREAD_SQL_FORBIDDEN');}) as typeof internal.db.prepare;
    try {
      assert.doesNotThrow(()=>archive.stats());assert.doesNotThrow(()=>archive.overviewStats());
    } finally {internal.db.prepare=original;}

    await waitFor(()=>archive.stats().refresh?.state==='fresh'&&archive.stats().total===1);
    const fresh=archive.stats();assert.equal(fresh.byDecision.REJECT,1);assert.equal(archive.overviewStats().total,1);

    const plan=internal.db.prepare(`EXPLAIN QUERY PLAN ${SCAN_ARCHIVE_AGGREGATE_SQL}`)
      .all(new Date(now-86_400_000).toISOString(),new Date(now).toISOString()).map(row=>String(row.detail));
    assert.ok(plan.some(detail=>detail.includes('COVERING INDEX scan_summaries_stats_cover')));

    internal.db.exec('DROP INDEX scan_summaries_stats_cover');
    await waitFor(()=>archive.stats().refresh?.error==='SCAN_ARCHIVE_STATS_REFRESH_FAILED');
    const stale=archive.stats();assert.equal(stale.refresh?.state,'stale');assert.equal(stale.total,1);
    assert.equal(stale.byDecision.REJECT,1,'a failed refresh keeps the last successful immutable snapshot');
  } finally {archive.close();rmSync(directory,{recursive:true,force:true});}
});
