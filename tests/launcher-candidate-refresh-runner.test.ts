import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {LauncherCandidateRefreshRunner} from '../src/launcher-candidate-refresh-runner.js';

const wallet=(id:number)=>'0x'+id.toString(16).padStart(40,'0');
const now=()=>new Date().toISOString();
const waitFor=async(check:()=>boolean,timeoutMs=5_000)=>{
  const deadline=Date.now()+timeoutMs;
  while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(check(),true,'launcher refresh worker timed out');
};

function createProfiles(path:string):DatabaseSync {
  const db=new DatabaseSync(path);db.exec(`
    CREATE TABLE wp_profiles(chain TEXT,address TEXT,computed_at TEXT NOT NULL,fresh_until TEXT NOT NULL,data TEXT NOT NULL,source_wallet INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chain,address));
    CREATE TABLE wp_groups(chain TEXT,address TEXT,group_id TEXT,first_at TEXT NOT NULL,PRIMARY KEY(chain,address,group_id));
    CREATE INDEX wp_groups_filter ON wp_groups(group_id,chain,address);
  `);return db;
}
function addProfile(db:DatabaseSync,id:number):void {
  const address=wallet(id),at=now(),profile={version:1,chain:'bsc',address,computedAt:at,groups:[],metrics:{lastEventAt:at},
    initiatorAnalysis:{status:'current',classification:'candidate',chain:'bsc',wallet:address,prospectivePreTokens:1,selectedTokens:1,
      evidence:[],screeningEvidence:[]}};
  db.prepare('INSERT INTO wp_profiles VALUES (?,?,?,?,?,1)').run('bsc',address,at,at,JSON.stringify(profile));
  db.prepare('INSERT INTO wp_groups VALUES (?,?,?,?)').run('bsc',address,'market_pre_candidate',at);
}
function fixture(options:{intervalMs?:number;testDelayMs?:number}={}) {
  const dir=mkdtempSync(join(tmpdir(),'launcher-refresh-runner-')),profiles=join(dir,'profiles.sqlite'),database=join(dir,'candidates.sqlite'),
    writer=createProfiles(profiles);
  const runner=new LauncherCandidateRefreshRunner({database,profileDatabase:profiles,cap:500,maxBytes:8*1024*1024,
    intervalMs:options.intervalMs??1000,testDelayMs:options.testDelayMs});
  return {dir,profiles,database,writer,runner,async close(){writer.close();await runner.stop();rmSync(dir,{recursive:true,force:true});}};
}

test('launcher candidate refresh runs off-thread, coalesces concurrent requests and exposes no paths',async()=>{
  const f=fixture({testDelayMs:150});addProfile(f.writer,1);
  try {
    const started=performance.now(),first=f.runner.refreshNow(),second=f.runner.refreshNow();
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(performance.now()-started<100,'launcher refresh blocked the service event loop');
    const [a,b]=await Promise.all([first,second]);
    assert.equal(a.records,1);assert.equal(b.lastRefreshAt,a.lastRefreshAt);
    const status=f.runner.status();assert.equal(status.ready,true);assert.equal(status.inFlight,false);
    assert.ok((status.durationMs??0)>=130);assert.doesNotMatch(JSON.stringify(status),/launcher-refresh-runner-|\.sqlite|\/tmp\//);
  } finally {await f.close();}
});

test('launcher candidate refresh runs periodically and publishes the latest bounded pool',async()=>{
  const f=fixture({intervalMs:50});addProfile(f.writer,1);
  try {
    f.runner.start();await waitFor(()=>f.runner.status().result?.records===1);
    const first=f.runner.status().completedAt;addProfile(f.writer,2);
    await waitFor(()=>f.runner.status().result?.records===2&&f.runner.status().completedAt!==first);
    assert.equal(f.runner.status().restarts,0);
  } finally {await f.close();}
});

test('launcher candidate refresh stops cleanly while a request is waiting',async()=>{
  const f=fixture({testDelayMs:500});addProfile(f.writer,1);
  try {
    const pending=f.runner.refreshNow();await waitFor(()=>f.runner.status().inFlight);
    const rejected=assert.rejects(pending,/LAUNCHER_CANDIDATE_WORKER_STOPPED/);
    await f.runner.stop();await rejected;
    assert.deepEqual({...f.runner.status(),lastAttemptAt:undefined},
      {running:false,ready:false,inFlight:false,restarts:0,lastAttemptAt:undefined});
  } finally {await f.close();}
});

test('launcher candidate refresh reports fixed diagnostics for an invalid source database',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'launcher-refresh-invalid-')),missing=join(dir,'private-profile-name.sqlite');
  const runner=new LauncherCandidateRefreshRunner({database:join(dir,'candidates.sqlite'),profileDatabase:missing,
    maxBytes:8*1024*1024,intervalMs:1000});
  try {
    runner.start();await waitFor(()=>!!runner.status().error);
    assert.match(runner.status().error??'',/^LAUNCHER_CANDIDATE_(?:WORKER|REFRESH)_/);
    assert.doesNotMatch(JSON.stringify(runner.status()),/private-profile-name|\.sqlite|\/tmp\//);
  } finally {await runner.stop();rmSync(dir,{recursive:true,force:true});}
});
