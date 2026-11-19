import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WalletFastPersistenceRunner} from '../src/wallet-fast-persistence-runner.js';
import {WalletActivityStore} from '../src/wallet-activity-store.js';
import {WalletHistory} from '../src/wallet-history.js';
import {LauncherCandidates} from '../src/launcher-candidates.js';
import type {WalletActivity} from '../src/wallet-activity.js';

const wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40),txHash='0x'+'3'.repeat(64),at='2026-11-19T01:00:00.000Z';
const activity=(classification:WalletActivity['classification']='buy'):WalletActivity=>({version:1,chain:'bsc',wallet,txHash,
  receivedAt:at,checkedAt:'2026-11-19T01:00:01.000Z',eventAt:at,classification,
  reasons:['SUPPORTED_SWAP_AND_WALLET_FLOW_CONFIRMED'],trades:classification==='buy'||classification==='sell'?
    [{tokenAddress:token,side:classification,amountAtomic:'10',protocol:'four_meme'}]:[],retryable:false,
  confirmation:'included',transferCount:2,tradingEnabled:false});
const waitFor=async(check:()=>boolean,timeoutMs=8000)=>{const deadline=Date.now()+timeoutMs;
  while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(check(),true,'wallet fast persistence worker timed out');};
function fixture(options:Record<string,number>={}){const dir=mkdtempSync(join(tmpdir(),'wallet-fast-persistence-')),
  activityDatabase=join(dir,'activity.sqlite'),historyDatabase=join(dir,'history.sqlite'),runner=new WalletFastPersistenceRunner({
    activityDatabase,activityMaxBytes:8*1024*1024,historyDatabase,historyMaxBytes:8*1024*1024,...options});
  return {dir,activityDatabase,historyDatabase,runner};}
const createProfileDatabase=(path:string)=>{const db=new DatabaseSync(path);db.exec(`
  CREATE TABLE wp_profiles(chain TEXT,address TEXT,computed_at TEXT NOT NULL,fresh_until TEXT NOT NULL,data TEXT NOT NULL,
    source_wallet INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chain,address));
  CREATE TABLE wp_groups(chain TEXT,address TEXT,group_id TEXT,first_at TEXT NOT NULL,PRIMARY KEY(chain,address,group_id));
  CREATE INDEX wp_groups_filter ON wp_groups(group_id,chain,address);`);db.close();};

test('wallet fast persistence leaves classification SQLite writes in the worker and ACKs durable trade history',async t=>{
  const f=fixture();
  t.mock.method(WalletActivityStore.prototype,'record',()=>{throw new Error('MAIN_THREAD_SQLITE_FORBIDDEN');});
  t.mock.method(WalletHistory.prototype,'recordTrades',()=>{throw new Error('MAIN_THREAD_SQLITE_FORBIDDEN');});
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    const pending=f.runner.persist(activity());assert.equal(f.runner.status().accepted,1);assert.equal(await pending,true);
    assert.equal(f.runner.status().completed,1);assert.equal(await f.runner.stop(),true);
    const archived=new DatabaseSync(f.activityDatabase,{readOnly:true}),history=new DatabaseSync(f.historyDatabase,{readOnly:true});
    try {assert.equal(Number(archived.prepare("SELECT count(*) AS n FROM wallet_activity WHERE kind='buy'").get()!.n),1);
      assert.equal(Number(history.prepare("SELECT count(*) AS n FROM wh_events WHERE side='buy'").get()!.n),1);}
    finally {archived.close();history.close();}
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('wallet fast persistence restarts its worker and keeps later classifications writable',async()=>{
  const f=fixture({restartDelayMs:10});
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    const worker=(f.runner as unknown as {worker:{terminate:()=>Promise<number>}}).worker;await worker.terminate();
    await waitFor(()=>f.runner.status().restarts>=1&&f.runner.status().ready);
    assert.equal(await f.runner.persist(activity('sell')),true);assert.equal(f.runner.status().completed,1);
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('wallet fast persistence fails closed when derived trade history rejects capacity',async()=>{
  const f=fixture({historyMaxBytes:16_384});
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    assert.equal(await f.runner.persist(activity()),false);
    assert.equal(f.runner.status().completed,0);assert.equal(f.runner.status().droppedAfterRetries,1);
    assert.equal(f.runner.status().error,'WALLET_FAST_PERSISTENCE_HISTORY_REJECTED');
    assert.equal(await f.runner.stop(),true);
    const history=new DatabaseSync(f.historyDatabase,{readOnly:true});
    try {assert.equal(Number(history.prepare('SELECT count(*) AS n FROM wh_events').get()!.n),0);}finally{history.close();}
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('a retraction is not ACKed when its activity archive succeeds but history rollback throws',async()=>{
  const f=fixture({maxAttempts:1}),history=new WalletHistory(f.historyDatabase,{maxBytes:8*1024*1024});
  try {assert.equal(history.recordTradesDurable([{chain:'bsc',wallet,txHash,tokenAddress:token,side:'buy',amount:'10',
    amountUnit:'atomic',eventAt:at,observedAt:'2026-11-19T01:00:01.000Z',source:'chain_verified_swap'}]),true);}
  finally {history.close();}
  const locked=new DatabaseSync(f.historyDatabase);
  locked.exec(`CREATE TRIGGER wh_test_retraction_failure BEFORE DELETE ON wh_events
    BEGIN SELECT RAISE(ABORT,'forced retraction failure'); END;`);locked.close();
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    assert.equal(await f.runner.persist(activity('retracted')),false);
    assert.equal(f.runner.status().completed,0);assert.equal(f.runner.status().droppedAfterRetries,1);
    assert.equal(f.runner.status().error,'WALLET_FAST_PERSISTENCE_WRITE_FAILED');
    assert.equal(await f.runner.stop(),true);
    const archived=new DatabaseSync(f.activityDatabase,{readOnly:true}),retained=new DatabaseSync(f.historyDatabase,{readOnly:true});
    try {assert.equal(Number(archived.prepare("SELECT count(*) AS n FROM wallet_activity WHERE kind='retracted'").get()!.n),1);
      assert.equal(Number(retained.prepare('SELECT count(*) AS n FROM wh_events').get()!.n),1);}
    finally {archived.close();retained.close();}
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('an idempotent history retraction with no matching trade is still ACKed',async()=>{
  const f=fixture();
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    assert.equal(await f.runner.persist(activity('retracted')),true);
    assert.equal(f.runner.status().completed,1);assert.equal(await f.runner.stop(),true);
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('a transient launcher open failure waits for its cooldown and then ACKs the retraction',async()=>{
  const f=fixture(),profiles=join(f.dir,'profiles.sqlite'),launcherDatabase=join(f.dir,'launcher.sqlite');
  createProfileDatabase(profiles);
  const seed=new LauncherCandidates({database:launcherDatabase,profileDatabase:profiles,cap:100,maxBytes:8*1024*1024});seed.close();
  rmSync(profiles,{force:true});
  const runner=new WalletFastPersistenceRunner({activityDatabase:f.activityDatabase,activityMaxBytes:8*1024*1024,
    historyDatabase:f.historyDatabase,historyMaxBytes:8*1024*1024,maxAttempts:3,launcherRetryMs:50,
    launcher:{database:launcherDatabase,profileDatabase:profiles,cap:100,maxBytes:8*1024*1024}});
  let settled=false;
  try {runner.start();await waitFor(()=>runner.status().ready&&!runner.status().launcherReady);
    const pending=runner.persist(activity('retracted')).finally(()=>{settled=true;});
    await waitFor(()=>runner.status().failedAttempts===1);
    assert.equal(runner.status().droppedAfterRetries,0);assert.equal(settled,false);
    createProfileDatabase(profiles);
    assert.equal(await pending,true);assert.equal(runner.status().completed,1);assert.equal(runner.status().launcherReady,true);
  } finally {await runner.stop();await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('concurrent persistence stops share one final drain result and complete the lifecycle state',async()=>{
  const f=fixture();
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    const first=f.runner.stop(),second=f.runner.stop();assert.strictEqual(second,first);assert.equal(await first,true);
    const status=f.runner.status();assert.equal(status.state,'stopped');assert.equal(status.running,false);
    assert.equal(status.ready,false);assert.equal(status.stopping,false);assert.equal(status.stopped,true);
    assert.strictEqual(f.runner.stop(),first);
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('wallet fast persistence bounds pre-start admission and reports an undrained stop',async()=>{
  const f=fixture({capacity:2}),first=f.runner.persist(activity()),second=f.runner.persist({...activity(),txHash:'0x'+'4'.repeat(64)});
  try {assert.equal(await f.runner.persist({...activity(),txHash:'0x'+'5'.repeat(64)}),false);
    assert.equal(f.runner.status().rejectedCapacity,1);assert.equal(await f.runner.stop(),false);
    assert.deepEqual(await Promise.all([first,second]),[false,false]);assert.equal(f.runner.status().droppedOnStop,2);
    assert.equal(f.runner.status().stopped,true);assert.equal(f.runner.status().stopping,false);assert.equal(await f.runner.stop(),false);
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('a persistence ACK arriving after stop timeout cannot resolve twice or count as complete',async()=>{
  const f=fixture();let resolutions=0,value:boolean|undefined;
  const internal=f.runner as unknown as {running:boolean;ready:boolean;inFlight:unknown;inFlightStartedAt:number;
    handleResult:(message:unknown)=>void};
  internal.running=true;internal.ready=true;internal.inFlight={id:7,result:activity(),attempts:0,enqueuedAt:Date.now()-60_000,
    finish:(persisted:boolean)=>{resolutions++;value=persisted;}};internal.inFlightStartedAt=Date.now();
  try {assert.equal(await f.runner.stop(1),false);assert.equal(value,false);assert.equal(resolutions,1);
    internal.handleResult({type:'result',id:7,persisted:true,elapsedMs:1});
    assert.equal(resolutions,1);assert.equal(f.runner.status().completed,0);
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});
