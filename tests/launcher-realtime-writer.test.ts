import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LauncherCandidates} from '../src/launcher-candidates.js';
import {LauncherRealtimeWriterRunner} from '../src/launcher-realtime-writer.js';

const address=(id:number)=>'0x'+id.toString(16).padStart(40,'0');
const waitFor=async(check:()=>boolean,timeoutMs=8000)=>{const deadline=Date.now()+timeoutMs;
  while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(check(),true,'launcher realtime writer timed out');};

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'launcher-realtime-writer-')),profiles=join(dir,'profiles.sqlite'),database=join(dir,'candidates.sqlite');
  const db=new DatabaseSync(profiles),at=new Date().toISOString(),wallet=address(1),profile={version:1,chain:'bsc',address:wallet,
    computedAt:at,groups:[],metrics:{lastEventAt:at},initiatorAnalysis:{status:'current',classification:'candidate',chain:'bsc',wallet,
      prospectivePreTokens:1,selectedTokens:1,evidence:[],screeningEvidence:[]}};
  db.exec(`CREATE TABLE wp_profiles(chain TEXT,address TEXT,computed_at TEXT NOT NULL,fresh_until TEXT NOT NULL,data TEXT NOT NULL,
      source_wallet INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chain,address));
    CREATE TABLE wp_groups(chain TEXT,address TEXT,group_id TEXT,first_at TEXT NOT NULL,PRIMARY KEY(chain,address,group_id));
    CREATE INDEX wp_groups_filter ON wp_groups(group_id,chain,address);`);
  db.prepare('INSERT INTO wp_profiles VALUES (?,?,?,?,?,1)').run('bsc',wallet,at,at,JSON.stringify(profile));
  db.prepare('INSERT INTO wp_groups VALUES (?,?,?,?)').run('bsc',wallet,'market_pre_candidate',at);db.close();
  const seed=new LauncherCandidates({database,profileDatabase:profiles,cap:100,maxBytes:8*1024*1024});
  assert.equal(seed.refresh().records,1);seed.close();
  const runner=new LauncherRealtimeWriterRunner({database,profileDatabase:profiles,cap:100,maxBytes:8*1024*1024,
    targetLimits:{bsc:10},delayMs:0,targetRefreshMs:100});
  return {dir,database,profiles,wallet,runner};
}

test('launcher realtime writer persists liveness and publishes bounded targets without main-thread SQLite',async t=>{
  const f=fixture();
  t.mock.method(LauncherCandidates.prototype,'observeRealtimeBatch',()=>{throw new Error('MAIN_THREAD_SQLITE_FORBIDDEN');});
  t.mock.method(LauncherCandidates.prototype,'streamTargets',()=>{throw new Error('MAIN_THREAD_SQLITE_FORBIDDEN');});
  t.mock.method(LauncherCandidates.prototype,'addresses',()=>{throw new Error('MAIN_THREAD_SQLITE_FORBIDDEN');});
  try {f.runner.start();await waitFor(()=>f.runner.status().ready&&f.runner.status().targetCounts.bsc===1);
    const started=performance.now(),observedAt=new Date().toISOString();
    assert.equal(f.runner.enqueue({chain:'bsc',wallet:f.wallet,observedAt,source:'wallet_fast'}),true);
    assert.ok(performance.now()-started<25);
    await waitFor(()=>f.runner.status().completed===1);
    const snapshot=f.runner.targetSnapshot('bsc',10);assert.deepEqual(snapshot.targets,[f.wallet]);assert.deepEqual(snapshot.priority,[]);
    assert.equal(snapshot.membership.has(f.wallet),true);
    const reader=new LauncherCandidates({database:f.database,profileDatabase:f.profiles,cap:100,maxBytes:8*1024*1024});
    try {assert.equal(reader.get('bsc',f.wallet)?.liveSeenAt,observedAt);}finally{reader.close();}
    assert.equal(await f.runner.stop(),true);assert.equal(f.runner.status().running,false);
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('launcher realtime writer restores its target cache after an unexpected worker exit',async()=>{
  const f=fixture();
  try {f.runner.start();await waitFor(()=>f.runner.status().ready&&f.runner.status().targetCounts.bsc===1);
    const worker=(f.runner as unknown as {worker:{terminate:()=>Promise<number>}}).worker;await worker.terminate();
    await waitFor(()=>f.runner.status().restarts>=1&&f.runner.status().ready&&f.runner.status().targetCounts.bsc===1);
    assert.equal(f.runner.targetSnapshot('bsc').membership.has(f.wallet),true);
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('launcher realtime priority is the mature intersection of selected targets in target order',async()=>{
  const f=fixture(),db=new DatabaseSync(f.database),source=db.prepare('SELECT * FROM lc_candidates LIMIT 1').get() as Record<string,unknown>,
    columns=Object.keys(source),insert=db.prepare(`INSERT INTO lc_candidates(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`),
    now=Date.now();
  for(const [id,liveSeenAt] of [[10,null],[20,new Date(now-1000).toISOString()],[30,new Date(now).toISOString()]] as const){
    const row:Record<string,unknown>={...source,address:address(id),live_seen_at:liveSeenAt,
      data:JSON.stringify({version:1,tier:'direct_precursor',reasons:['TEST_MATURE'],sampleOnly:true,tradingEnabled:false})};
    insert.run(...columns.map(column=>row[column] as never));
  }
  db.close();
  const runner=new LauncherRealtimeWriterRunner({database:f.database,profileDatabase:f.profiles,cap:100,maxBytes:8*1024*1024,
    targetLimits:{bsc:2},delayMs:0,targetRefreshMs:100});
  try {runner.start();await waitFor(()=>runner.status().ready&&runner.status().targetCounts.bsc===2);
    const snapshot=runner.targetSnapshot('bsc',2);
    assert.deepEqual(snapshot.targets,[address(30),address(20)]);
    assert.deepEqual(snapshot.priority,snapshot.targets);
  } finally {await runner.stop();await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('launcher realtime worker completes zero-match batches without a status scan or false capacity error',async()=>{
  const f=fixture();
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    assert.equal(f.runner.enqueue({chain:'bsc',wallet:address(9999),observedAt:new Date().toISOString(),source:'wallet_fast'}),true);
    await waitFor(()=>f.runner.status().completed===1);
    assert.equal(f.runner.status().changed,0);assert.equal(f.runner.status().error,undefined);
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('launcher realtime worker reports capacity without counting the batch complete',async()=>{
  const f=fixture(),db=new DatabaseSync(f.database);
  db.exec(`CREATE TRIGGER lc_test_realtime_capacity BEFORE UPDATE ON lc_candidates
    BEGIN SELECT RAISE(ABORT,'database or disk is full'); END;`);db.close();
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    assert.equal(f.runner.enqueue({chain:'bsc',wallet:f.wallet,observedAt:new Date().toISOString(),source:'wallet_fast'}),true);
    await waitFor(()=>f.runner.status().droppedAfterRetries===1);
    const status=f.runner.status();assert.equal(status.completed,0);assert.equal(status.changed,0);
    assert.equal(status.error,'LAUNCHER_REALTIME_CAPACITY_REACHED');
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('launcher realtime writer coalesces newer observations and rejects a bounded overflow',async()=>{
  const f=fixture(),runner=new LauncherRealtimeWriterRunner({database:f.database,profileDatabase:f.profiles,cap:100,maxBytes:8*1024*1024,
    targetLimits:{bsc:10},capacity:2,batchSize:1,delayMs:60_000});
  try {const older=new Date(Date.now()-2000).toISOString(),newer=new Date(Date.now()-1000).toISOString();
    assert.equal(runner.enqueue({chain:'bsc',wallet:f.wallet,observedAt:older,source:'wallet_fast'}),true);
    assert.equal(runner.enqueue({chain:'bsc',wallet:f.wallet,observedAt:newer,source:'wallet_fast'}),true);
    assert.equal(runner.enqueue({chain:'bsc',wallet:address(2),observedAt:newer,source:'wallet_fast'}),true);
    assert.equal(runner.enqueue({chain:'bsc',wallet:address(3),observedAt:newer,source:'wallet_fast'}),false);
    assert.equal(runner.status().coalesced,1);assert.equal(runner.status().rejectedCapacity,1);
    assert.equal(await runner.stop(),false);assert.equal(runner.status().droppedOnStop,2);
  } finally {await runner.stop();await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('concurrent launcher realtime stops share one final drain result and complete the lifecycle state',async()=>{
  const f=fixture();
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    const first=f.runner.stop(),second=f.runner.stop();assert.strictEqual(second,first);assert.equal(await first,true);
    const status=f.runner.status();assert.equal(status.state,'stopped');assert.equal(status.running,false);
    assert.equal(status.ready,false);assert.equal(status.stopping,false);assert.equal(status.stopped,true);
    assert.strictEqual(f.runner.stop(),first);
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});
