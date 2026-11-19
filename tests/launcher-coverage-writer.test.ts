import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {LauncherCandidates} from '../src/launcher-candidates.js';
import {LauncherCoverageWriterRunner,type LauncherCoverageWriterOptions} from '../src/launcher-coverage-writer.js';

const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const iso=(offset:number)=>new Date(Date.now()+offset).toISOString();
async function until(check:()=>boolean,timeout=5_000){const end=Date.now()+timeout;while(!check()){
  if(Date.now()>end)throw new Error('TEST_WAIT_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,10));}}

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'launcher-coverage-writer-')),profiles=join(dir,'profiles.sqlite'),database=join(dir,'launchers.sqlite');
  const profileDb=new DatabaseSync(profiles);profileDb.exec(`CREATE TABLE wp_profiles(chain TEXT,address TEXT,computed_at TEXT,data TEXT);
    CREATE TABLE wp_groups(group_id TEXT,chain TEXT,address TEXT,first_at TEXT);
    CREATE INDEX wp_groups_filter ON wp_groups(group_id,chain,address);`);profileDb.close();
  const options:LauncherCoverageWriterOptions={database,profileDatabase:profiles,cap:100,maxBytes:8*1024*1024,
    freshAfterSec:60,liveAfterSec:60,coverageAfterSec:60,restartDelayMs:10};
  const store=new LauncherCandidates(options);store.close();
  const db=new DatabaseSync(database),now=iso(-10_000),base=JSON.stringify({version:1,reasons:[],sampleOnly:true,tradingEnabled:false});
  const insert=db.prepare(`INSERT INTO lc_candidates(chain,address,route,qualified_at,profile_computed_at,updated_at,data)
    VALUES (?,?,?,?,?,?,?)`);
  for(const [chain,wallet] of [['bsc',address(1)],['bsc',address(2)],['robinhood',address(3)]] as const)
    insert.run(chain,wallet,'A',now,now,now,base);
  db.close();return {dir,database,profiles,options};
}

test('coverage writer coalesces pending snapshots to the newest value per chain',async()=>{
  const f=fixture(),writer=new LauncherCoverageWriterRunner(f.options),firstAt=iso(-2_000),latestAt=iso(-1_000);
  try {
    assert.equal(writer.enqueue([{chain:'bsc',wallets:[address(1)],at:firstAt}]),true);
    assert.equal(writer.enqueue([{chain:'bsc',wallets:[address(2)],at:latestAt}]),true);
    assert.deepEqual({pending:writer.status().pendingChains,accepted:writer.status().acceptedUpdates,
      coalesced:writer.status().coalesced},{pending:1,accepted:2,coalesced:1});
    writer.start();assert.equal(await writer.flush(10_000),true);assert.equal(await writer.stop(),true);
    const db=new DatabaseSync(f.database,{readOnly:true});try {
      const rows=db.prepare("SELECT address,monitored,coverage_at FROM lc_candidates WHERE chain='bsc' ORDER BY address").all() as any[];
      assert.deepEqual(rows.map(row=>[row.address,row.monitored,row.coverage_at]),[[address(1),0,null],[address(2),1,latestAt]]);
    }finally{db.close();}
    assert.equal(writer.status().completedUpdates,1);assert.equal(writer.status().droppedOnStop,0);
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('stop starts the worker when needed, drains all pending chains, then rejects new coverage',async()=>{
  const f=fixture(),writer=new LauncherCoverageWriterRunner(f.options),at=iso(-1_000);
  try {
    assert.equal(writer.enqueue([{chain:'bsc',wallets:[address(1)],at},{chain:'robinhood',wallets:[address(3)],at}]),true);
    assert.equal(writer.status().state,'idle');assert.equal(await writer.stop(10_000),true);
    const status=writer.status();assert.equal(status.state,'stopped');assert.equal(status.completedUpdates,2);
    assert.equal(status.pendingChains,0);assert.equal(status.inFlight,0);
    const db=new DatabaseSync(f.database,{readOnly:true});try {
      assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM lc_candidates WHERE monitored=1').get() as any).n),2);
    }finally{db.close();}
    assert.equal(writer.enqueue([{chain:'bsc',wallets:[],at}]),false);assert.equal(writer.status().rejectedClosed,1);
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('concurrent coverage-writer stop calls share one final drain',async()=>{
  const f=fixture(),writer=new LauncherCoverageWriterRunner(f.options),at=iso(-1_000);
  try {
    assert.equal(writer.enqueue([{chain:'bsc',wallets:[address(1)],at}]),true);
    const first=writer.stop(10_000),second=writer.stop(1);
    assert.strictEqual(first,second);assert.deepEqual(await Promise.all([first,second]),[true,true]);
    assert.equal(writer.status().completedUpdates,1);assert.equal(writer.status().state,'stopped');
  } finally {await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('coverage queue is bounded by chain while same-chain replacements remain admissible',async()=>{
  const f=fixture(),writer=new LauncherCoverageWriterRunner({...f.options,maxPendingChains:1}),at=iso(-1_000);
  try {
    assert.equal(writer.enqueue([{chain:'bsc',wallets:[address(1)],at}]),true);
    assert.equal(writer.enqueue([{chain:'robinhood',wallets:[address(3)],at}]),false);
    assert.equal(writer.enqueue([{chain:'bsc',wallets:[address(2)],at}]),true);
    assert.deepEqual({pending:writer.status().pendingChains,rejected:writer.status().rejectedCapacity,
      coalesced:writer.status().coalesced},{pending:1,rejected:1,coalesced:1});
    assert.equal(await writer.stop(10_000),true);
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('capacity failure is retried, never counted complete, and remains explicit at shutdown',async()=>{
  const f=fixture();new DatabaseSync(f.database).close();
  const db=new DatabaseSync(f.database);db.exec(`CREATE TRIGGER lc_test_capacity BEFORE UPDATE ON lc_candidates
    BEGIN SELECT RAISE(ABORT,'database or disk is full'); END;`);db.close();
  const writer=new LauncherCoverageWriterRunner({...f.options,maxAttempts:2});
  try {
    assert.equal(writer.enqueue([{chain:'bsc',wallets:[address(1)],at:iso(-1_000)}]),true);writer.start();
    await until(()=>writer.status().droppedAfterRetries===1,10_000);
    assert.equal(writer.status().completedUpdates,0);assert.equal(writer.status().error,'LAUNCHER_COVERAGE_CAPACITY_REACHED');
    assert.equal(await writer.stop(),false);const status=writer.status();
    assert.equal(status.shutdownDrained,false);assert.equal(status.shutdownError,'LAUNCHER_COVERAGE_SHUTDOWN_UNDRAINED');
    assert.deepEqual(status.unpersistedChains,['bsc']);assert.equal(status.error,'LAUNCHER_COVERAGE_SHUTDOWN_UNDRAINED');
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('unexpected worker exit transitions to starting with ready and running both false',async()=>{
  const f=fixture(),writer=new LauncherCoverageWriterRunner({...f.options,restartDelayMs:1_000});
  try {
    writer.start();await until(()=>writer.status().ready);const worker=(writer as unknown as {worker:{terminate:()=>Promise<number>}}).worker;
    await worker.terminate();await until(()=>writer.status().restarts>=1);
    assert.deepEqual({state:writer.status().state,ready:writer.status().ready,running:writer.status().running},
      {state:'starting',ready:false,running:false});
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('shutdown timeout retains the unpersisted final coverage instead of reporting success',async()=>{
  const f=fixture(),writer=new LauncherCoverageWriterRunner(f.options);
  try {
    assert.equal(writer.enqueue([{chain:'bsc',wallets:[],at:iso(-1_000)}]),true);
    assert.equal(await writer.stop(1),false);const status=writer.status();
    assert.equal(status.state,'stopped');assert.equal(status.shutdownDrained,false);
    assert.deepEqual(status.unpersistedChains,['bsc']);assert.equal(status.droppedOnStop,1);
    assert.equal(await writer.stop(),false,'subsequent stop calls preserve the failed shutdown result');
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});
