import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
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

test('wallet-index backlog uses the configured cadence and only an idle cycle backs off',()=>{
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:50_000,processed:1024}),30_000);
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:1,processed:0}),30_000);
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:0,processed:13}),30_000);
  assert.equal(walletIndexNextDelay(30_000,{invalidationPending:0,processed:0}),60_000);
  assert.equal(walletIndexNextDelay(1_000,{invalidationPending:0,processed:0}),6_000);
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
