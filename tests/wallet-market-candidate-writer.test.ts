import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import bs58 from 'bs58';
import {WalletHistory} from '../src/wallet-history.js';
import {WalletMarketCandidateWriterRunner} from '../src/wallet-market-candidate-writer.js';
import {GmgnMarketDiscoveryScanner,GmgnMarketDiscoveryStore,type GmgnMarketDiscoveryObservedCandidate} from '../src/gmgn-market-discovery.js';

const token=bs58.encode(new Uint8Array(32).fill(43)),observedAt='2026-11-19T01:00:00.000Z';
const context={source:'gmgn_market_discovery',observedAt,kind:'trending' as const,reason:'first_seen:trending',window:'1m',
  changeKind:'first_seen' as const,category:'trending' as const,firstSeenUpperBound:observedAt,leftCensored:true,rank:1,
  smartDegenCount:3,renownedCount:1,smartDegenDelta:3,renownedDelta:1};
const waitFor=async(check:()=>boolean,timeoutMs=8_000)=>{const deadline=Date.now()+timeoutMs;
  while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(check(),true,'wallet market candidate worker timed out');};
function fixture(options:Record<string,number>={}){const dir=mkdtempSync(join(tmpdir(),'wallet-market-candidate-')),
  database=join(dir,'wallet.sqlite'),runner=new WalletMarketCandidateWriterRunner({database,maxBytes:8*1024*1024,...options});
  return {dir,database,runner};}
const submit=(runner:WalletMarketCandidateWriterRunner,candidate:GmgnMarketDiscoveryObservedCandidate)=>runner.capture(
  {chain:'solana',address:candidate.tokenAddress},{source:candidate.source,observedAt:candidate.observedAt,kind:candidate.feed,
    reason:`${candidate.kind}:${candidate.category}`,window:candidate.window,changeKind:candidate.kind,category:candidate.category,
    previousCategory:candidate.previousCategory,...(candidate.kind==='first_seen'?{firstSeenLowerBound:candidate.previousSuccessfulPollAt,
      firstSeenUpperBound:candidate.observedAt,leftCensored:candidate.leftCensored}:{}),rank:candidate.snapshot.rank,
    smartDegenCount:candidate.snapshot.smartDegenCount,renownedCount:candidate.snapshot.renownedCount,
    smartDegenDelta:candidate.smartDegenDelta,renownedDelta:candidate.renownedDelta});

test('market candidate SQLite work stays off the event loop and ACKs only after the durable write',async t=>{
  const f=fixture({testDelayMs:150});
  t.mock.method(WalletHistory.prototype,'captureMarketCandidate',()=>{throw new Error('MAIN_THREAD_SQLITE_FORBIDDEN');});
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    const started=performance.now(),write=f.runner.capture({chain:'solana',address:token},context);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(performance.now()-started<100,'candidate write blocked the main event loop');
    assert.equal(f.runner.status().pending,1);assert.equal(await write,true);assert.ok(performance.now()-started>=130);
    const status=f.runner.status();assert.equal(status.completed,1);assert.equal(status.pending,0);assert.ok(status.lastWriteMs>=130);
    assert.equal(await f.runner.stop(),true);
    const db=new DatabaseSync(f.database,{readOnly:true});
    try {const row=db.prepare("SELECT data FROM wh_observations WHERE kind='market_candidate'").get();assert.ok(row);
      const value=JSON.parse(String(row.data));assert.equal(value.scope,'research_nomination_only');
      assert.equal(value.entryPermission,false);assert.equal(value.countingEvent,false);}
    finally {db.close();}
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('market candidate writer bounds admission, exposes backlog, and drains admitted work on stop',async()=>{
  const f=fixture({capacity:1,testDelayMs:150});
  try {f.runner.start();await waitFor(()=>f.runner.status().ready);
    const first=f.runner.capture({chain:'solana',address:token},context);
    assert.equal(await f.runner.capture({chain:'solana',address:bs58.encode(new Uint8Array(32).fill(44))},context),false);
    let status=f.runner.status();assert.equal(status.pending,1);assert.equal(status.rejectedCapacity,1);
    assert.equal(status.error,'WALLET_MARKET_CANDIDATE_QUEUE_FULL');
    const stop=f.runner.stop(2_000);assert.equal(await first,true);assert.equal(await stop,true);
    status=f.runner.status();assert.equal(status.state,'stopped');assert.equal(status.pending,0);assert.equal(status.completed,1);
  } finally {await f.runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('an unavailable candidate worker leaves the discovery outbox durable for restart replay',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-market-candidate-outbox-')),database=join(dir,'wallet.sqlite'),
    discovery=join(dir,'discovery.sqlite'),now={value:new Date(observedAt)};
  const client={async getMarketTrending(){return {rank:[{chain:'sol',address:token,rank:1,smart_degen_count:3}]};},
    async getMarketTrenches(){return {new_creation:[],near_completion:[],completed:[]};}};
  let writer=new WalletMarketCandidateWriterRunner({database,maxBytes:8*1024*1024}),
    store=new GmgnMarketDiscoveryStore({path:discovery,maxBytes:8*1024*1024,maxObservations:100,now:()=>now.value}),
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:7,now:()=>now.value,
      onCandidate:async candidate=>{if(!await submit(writer,candidate))throw new Error('candidate unavailable');}});
  try {await writer.stop();await scanner.pollNow();
    assert.equal(scanner.status().candidateErrors,1);assert.equal(store.status().pendingCandidateDeliveries,1);
    assert.equal(writer.status().rejectedClosed,1);
    scanner.stop();store.close();now.value=new Date(now.value.getTime()+30_001);
    writer=new WalletMarketCandidateWriterRunner({database,maxBytes:8*1024*1024});
    store=new GmgnMarketDiscoveryStore({path:discovery,maxBytes:8*1024*1024,maxObservations:100,now:()=>now.value});
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:7,now:()=>now.value,
      onCandidate:async candidate=>{if(!await submit(writer,candidate))throw new Error('candidate unavailable');}});
    writer.start();await waitFor(()=>writer.status().ready);
    await scanner.pollNow();assert.equal(store.status().pendingCandidateDeliveries,0);assert.equal(writer.status().completed,1);
    const db=new DatabaseSync(database,{readOnly:true});
    try {assert.equal(Number(db.prepare("SELECT count(*) AS n FROM wh_observations WHERE kind='market_candidate'").get()!.n),1);}
    finally {db.close();}
  } finally {scanner.stop();await writer.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('an updated wallet signal survives worker failure and replays after restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-market-candidate-update-outbox-')),database=join(dir,'wallet.sqlite'),
    discovery=join(dir,'discovery.sqlite'),now={value:new Date(observedAt)},market={smartDegenCount:3};
  const client={async getMarketTrending(){return {rank:[{chain:'sol',address:token,rank:1,
      smart_degen_count:market.smartDegenCount}]};},
    async getMarketTrenches(){return {new_creation:[],near_completion:[],completed:[]};}};
  let writer=new WalletMarketCandidateWriterRunner({database,maxBytes:8*1024*1024}),
    store=new GmgnMarketDiscoveryStore({path:discovery,maxBytes:8*1024*1024,maxObservations:100,now:()=>now.value}),
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:7,now:()=>now.value,
      onCandidate:async candidate=>{if(!await submit(writer,candidate))throw new Error('candidate unavailable');}});
  try {
    writer.start();await waitFor(()=>writer.status().ready);await scanner.pollNow();
    assert.equal(store.status().pendingCandidateDeliveries,0);assert.equal(writer.status().completed,1);
    // The scanner rotates Trending, Trenches, and Kline work. Consume the empty
    // Trenches turn before producing a changed Trending wallet count.
    now.value=new Date(now.value.getTime()+30_001);await scanner.pollNow();
    market.smartDegenCount=4;now.value=new Date(now.value.getTime()+30_001);await writer.stop();await scanner.pollNow();
    assert.equal(scanner.status().candidateErrors,1);assert.equal(store.status().pendingCandidateDeliveries,1,
      'a failed updated delivery must stay durable');

    scanner.stop();store.close();now.value=new Date(now.value.getTime()+30_001);
    writer=new WalletMarketCandidateWriterRunner({database,maxBytes:8*1024*1024});
    store=new GmgnMarketDiscoveryStore({path:discovery,maxBytes:8*1024*1024,maxObservations:100,now:()=>now.value});
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:7,now:()=>now.value,
      onCandidate:async candidate=>{if(!await submit(writer,candidate))throw new Error('candidate unavailable');}});
    writer.start();await waitFor(()=>writer.status().ready);await scanner.pollNow();
    assert.equal(store.status().pendingCandidateDeliveries,0);assert.equal(writer.status().completed,1);
    const db=new DatabaseSync(database,{readOnly:true});
    try {const observations=db.prepare("SELECT data FROM wh_observations WHERE kind='market_candidate' ORDER BY rowid").all()
        .map(row=>JSON.parse(String(row.data)));
      assert.equal(observations.length,2);assert.equal(observations[1].changeKind,'updated');
      assert.equal(observations[1].smartDegenDelta,1);}
    finally {db.close();}
  } finally {scanner.stop();await writer.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});
