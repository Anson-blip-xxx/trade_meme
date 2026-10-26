import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {WalletHistory,type WalletTradeObservation} from '../src/wallet-history.js';
import {WalletIndexRunner} from '../src/wallet-index-runner.js';
import {walletIndexNextDelay} from '../src/wallet-index-policy.js';

const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const waitFor=async(check:()=>boolean,timeoutMs=8_000)=>{
  const deadline=Date.now()+timeoutMs;
  while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(check(),true,'timed out waiting for wallet-index worker');
};

test('wallet-index backlog uses a bounded catch-up cadence and only an idle cycle backs off',()=>{
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:50_000,processed:1024}),5_000);
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:50_000,processed:1024,livePriority:true}),10_000);
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:1,processed:0}),5_000);
  assert.equal(walletIndexNextDelay(1_000,{invalidationPending:1,processed:1}),1_000);
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:0,processed:300,derivedPending:true}),5_000);
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:0,processed:300,derivedPending:true,livePriority:true}),10_000);
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:0,processed:13}),30_000);
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:0,processed:0}),60_000);
  assert.equal(walletIndexNextDelay(1_000,{invalidationPending:0,processed:0}),6_000);
});

test('wallet-index worker drains above current production ingress across bounded catch-up cycles',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-index-backlog-')),database=join(directory,'history.sqlite');
  const history=new WalletHistory(database),db=(history as unknown as {db:DatabaseSync}).db;
  const insert=db.prepare(`INSERT INTO wh_association_invalidations(kind,chain,address,enqueued_at)
    VALUES ('funding_wallet','bsc',?,?)`);
  db.exec('BEGIN');for(let index=0;index<5_000;index++)insert.run(address(10_000+index),new Date().toISOString());db.exec('COMMIT');
  history.close();const runner=new WalletIndexRunner({database,maxBytes:512*1024*1024,intervalMs:10});
  try {
    runner.start();await waitFor(()=>runner.snapshot().invalidationPending===0);
    assert.equal(runner.snapshot().invalidationPending,0);
  } finally {await runner.stop();rmSync(directory,{recursive:true,force:true});}
});

test('live priority caps one invalidation cycle and switching it off resumes catch-up',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-index-live-priority-')),database=join(directory,'history.sqlite');
  const history=new WalletHistory(database),db=(history as unknown as {db:DatabaseSync}).db;
  const insert=db.prepare(`INSERT INTO wh_association_invalidations(kind,chain,address,enqueued_at)
    VALUES ('funding_wallet','bsc',?,?)`);
  db.exec('BEGIN');for(let index=0;index<5_000;index++)insert.run(address(20_000+index),new Date().toISOString());db.exec('COMMIT');
  history.close();const runner=new WalletIndexRunner({database,maxBytes:512*1024*1024,intervalMs:10});
  try {
    runner.setLivePriority(true);runner.start();await waitFor(()=>runner.snapshot().workerLivePriority===true);
    await waitFor(()=>!!runner.snapshot().completedAt);
    const limited=runner.snapshot();assert.equal(limited.livePriority,true);assert.equal(limited.workerLivePriority,true);
    const removed=5_000-limited.invalidationPending;
    assert.ok(removed>0&&removed<=24*128);assert.ok(limited.invalidationPending>0);
    runner.setLivePriority(false);assert.equal(runner.snapshot().livePriority,false);
    await waitFor(()=>runner.snapshot().workerLivePriority===false);
    await waitFor(()=>runner.snapshot().invalidationPending===0);
  } finally {await runner.stop();rmSync(directory,{recursive:true,force:true});}
});

test('live priority skips exact association totals and refreshes them after counting stops',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-index-live-stats-')),database=join(directory,'history.sqlite');
  const history=new WalletHistory(database);history.close();
  const runner=new WalletIndexRunner({database,maxBytes:512*1024*1024,intervalMs:10});
  try {
    runner.setLivePriority(true);runner.start();await waitFor(()=>!!runner.snapshot().completedAt);
    const limited=runner.snapshot();assert.equal(limited.workerLivePriority,true);assert.equal(limited.associationStats,undefined);
    const completedAt=limited.completedAt;runner.setLivePriority(false);
    await waitFor(()=>runner.snapshot().workerLivePriority===false&&runner.snapshot().completedAt!==completedAt);
    assert.ok(runner.snapshot().associationStats);
  } finally {await runner.stop();rmSync(directory,{recursive:true,force:true});}
});

test('a running worker acknowledges false to true priority before its next bounded cycle',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-index-priority-switch-')),database=join(directory,'history.sqlite');
  const history=new WalletHistory(database);history.close();
  const runner=new WalletIndexRunner({database,maxBytes:512*1024*1024,intervalMs:100});
  try {
    runner.start();await waitFor(()=>!!runner.snapshot().completedAt&&runner.snapshot().workerLivePriority===false);
    const statsAt=runner.snapshot().associationStatsRefreshedAt;assert.ok(statsAt);
    runner.setLivePriority(true);await waitFor(()=>runner.snapshot().workerLivePriority===true);
    const db=new DatabaseSync(database),insert=db.prepare(`INSERT INTO wh_association_invalidations(kind,chain,address,enqueued_at)
      VALUES ('funding_wallet','bsc',?,?)`);
    db.exec('BEGIN');for(let index=0;index<5_000;index++)insert.run(address(30_000+index),new Date().toISOString());db.exec('COMMIT');db.close();
    const completedAt=runner.snapshot().completedAt;
    await waitFor(()=>runner.snapshot().completedAt!==completedAt&&runner.snapshot().invalidationPending>0);
    const limited=runner.snapshot(),removed=5_000-limited.invalidationPending;
    assert.ok(removed>0&&removed<=24*128);assert.equal(limited.workerLivePriority,true);
    assert.equal(limited.associationStatsRefreshedAt,statsAt);
  } finally {await runner.stop();rmSync(directory,{recursive:true,force:true});}
});

test('wallet-index worker uses its cycle budget to process beyond the default coordination quota',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-index-coordination-budget-')),database=join(directory,'history.sqlite');
  const now=Date.now(),token=address(100),history=new WalletHistory(database);
  history.recordTrades(Array.from({length:11},(_,index)=>({
    chain:'bsc' as const,wallet:address(index+1),tokenAddress:token,txHash:hash(index+1),side:'buy' as const,
    eventAt:new Date(now-2_000).toISOString(),observedAt:new Date(now-1_000).toISOString(),source:'gmgn_smartmoney_feed'
  })));
  assert.equal(history.stats().coordinationPending,11);
  history.close();

  const runner=new WalletIndexRunner({database,maxBytes:512*1024*1024,intervalMs:30_000});
  try {
    runner.start();await waitFor(()=>!!runner.snapshot().completedAt);
    const status=runner.snapshot();
    assert.equal(status.coordinationError,undefined);
    assert.equal(status.coordinationProcessed,11);
  } finally {await runner.stop();rmSync(directory,{recursive:true,force:true});}
});

test('wallet-index worker completes the coordination and association quotas on a small database',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-index-worker-')),database=join(directory,'history.sqlite');
  const now=Date.now(),iso=(offset:number)=>new Date(now+offset).toISOString();
  const candidate=address(1),leader=address(2),token=address(100);
  const base:WalletTradeObservation={chain:'bsc',wallet:candidate,tokenAddress:token,txHash:hash(1),side:'buy',
    eventAt:iso(-60_000),observedAt:iso(-50_000),source:'gmgn_smartmoney_feed'};
  let history=new WalletHistory(database);
  history.recordTrade(base);
  history.recordTrade({...base,wallet:leader,txHash:hash(2),eventAt:iso(-20_000),observedAt:iso(-10_000),source:'gmgn_kol_feed'});
  history.captureFunding({chain:'bsc',address:token},candidate,{address:address(500),timestamp:iso(-70_000),txHash:hash(500)},
    {source:'gmgn_funding',observedAt:iso(-5_000),snapshotAt:iso(-5_000)});
  assert.ok(history.stats().coordinationPending>0);assert.ok(history.associationStats().pending>0);history.close();

  const runner=new WalletIndexRunner({database,maxBytes:512*1024*1024,intervalMs:1_000});
  try {
    runner.start();await waitFor(()=>!!runner.snapshot().completedAt);
    const status=runner.snapshot();
    assert.equal(status.coordinationError,undefined);assert.equal(status.associationError,undefined);
    assert.ok(status.coordinationMs>=0);assert.ok(status.associationMs>=0);
    assert.ok(status.coordinationProcessed>=1);assert.ok(status.associationProcessed>=1);
    assert.equal(status.associationStats?.pending,0);assert.equal(status.associationStats?.relations,1);
    const firstCompleted=status.completedAt,firstStatsAt=status.associationStatsRefreshedAt;
    assert.ok(firstStatsAt);await waitFor(()=>runner.snapshot().completedAt!==firstCompleted);
    assert.equal(runner.snapshot().associationStatsRefreshedAt,firstStatsAt);
  } finally {await runner.stop();}

  history=new WalletHistory(database);
  try {
    assert.equal(history.stats().coordinationPending,0);
    assert.equal(history.associationInvalidationStatus().pending,0);
    assert.equal(history.associationStats().pending,0);
    assert.equal(history.listAssociations().total,1);
  } finally {history.close();rmSync(directory,{recursive:true,force:true});}
});
