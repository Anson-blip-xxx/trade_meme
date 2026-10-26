import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WalletHistory} from '../src/wallet-history.js';
import {WalletHistoryStatsRunner} from '../src/wallet-history-stats.js';

const waitFor=async(check:()=>boolean,timeoutMs=8_000)=>{
  const deadline=Date.now()+timeoutMs;
  while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(check(),true,'timed out waiting for wallet-history stats worker');
};

test('wallet-history stats run off-thread and a failed refresh retains the last successful snapshot',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-history-stats-')),database=join(directory,'history.sqlite');
  const history=new WalletHistory(database),expected=history.stats();history.close();
  // Leave enough time after the first snapshot to corrupt the next refresh
  // deterministically, even when the full suite is running under CPU load.
  const runner=new WalletHistoryStatsRunner({database,maxBytes:expected.maxBytes,intervalMs:1_000,staleAfterMs:5_000});
  try {
    runner.start();await waitFor(()=>runner.snapshot().state==='fresh');
    const first=runner.snapshot();
    assert.equal(first.store?.wallets,expected.wallets);assert.equal(first.store?.observations,expected.observations);
    assert.equal(first.stale,false);assert.ok(first.computedAt);

    const db=new DatabaseSync(database);db.exec('DROP TABLE wh_events');db.close();
    await waitFor(()=>runner.snapshot().error==='WALLET_HISTORY_STATS_REFRESH_FAILED');
    const failed=runner.snapshot();
    assert.equal(failed.state,'stale');assert.equal(failed.stale,true);
    assert.equal(failed.computedAt,first.computedAt);assert.deepEqual(failed.store,first.store);
  } finally {await runner.stop();rmSync(directory,{recursive:true,force:true});}
});

test('wallet-history stats advance exact append-only counts without a historical recount',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-history-stats-incremental-')),database=join(directory,'history.sqlite'),
    history=new WalletHistory(database),maxBytes=history.stats().maxBytes;
  const runner=new WalletHistoryStatsRunner({database,maxBytes,intervalMs:100,staleAfterMs:2_000});
  try {
    runner.start();await waitFor(()=>runner.snapshot().state==='fresh');const first=runner.snapshot();
    history.recordTrade({chain:'bsc',wallet:'0x'+'1'.repeat(40),tokenAddress:'0x'+'2'.repeat(40),txHash:'0x'+'3'.repeat(64),
      side:'buy',eventAt:new Date(Date.now()-1000).toISOString(),observedAt:new Date().toISOString(),source:'gmgn_wallet_activity'});
    await waitFor(()=>runner.snapshot().computedAt!==first.computedAt&&runner.snapshot().store?.events===1);
    const next=runner.snapshot().store!;
    assert.equal(next.wallets,1);assert.equal(next.events,1);assert.equal(next.observations,1);assert.equal(next.tokens,1);
    assert.equal(next.firstObservedAt,next.lastObservedAt);assert.equal(next.snapshots,0);
  } finally {await runner.stop();history.close();rmSync(directory,{recursive:true,force:true});}
});
