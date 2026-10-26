import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WalletHistory} from '../src/wallet-history.js';
import {WalletHistoryDetailRunner} from '../src/wallet-history-detail.js';
import {MemeObserver} from '../src/meme-observer.js';
import {SourceCorroboration} from '../src/source-corroboration.js';
import type {Signal} from '../src/types.js';

const memeAt='2026-10-26T01:00:00.000Z';

test('wallet detail worker reads the exact persisted evidence through a separate read-only connection',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-detail-worker-')),database=join(directory,'history.sqlite');
  const history=new WalletHistory(database),wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40);
  history.recordTrade({chain:'bsc',wallet,tokenAddress:token,txHash:'0x'+'3'.repeat(64),side:'buy',
    eventAt:'2026-10-26T01:00:00.000Z',observedAt:'2026-10-26T01:00:01.000Z',source:'gmgn_wallet_activity',usd:'25'});
  const runner=new WalletHistoryDetailRunner({database,timeoutMs:5_000});
  try {
    runner.start();const detail=await runner.getWallet('bsc',wallet);
    assert.equal(detail?.wallet.address,wallet);assert.equal(detail?.timeline.length,1);
    assert.equal(detail?.timeline[0].txHash,'0x'+'3'.repeat(64));assert.equal(detail?.coverage.observationCount,1);
  } finally {await runner.stop();history.close();rmSync(directory,{recursive:true,force:true});}
});

test('dashboard query worker preserves MemeObserver list and detail projections',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'meme-query-worker-')),database=join(directory,'meme.sqlite'),sourceDatabase=join(directory,'source.sqlite'),
    address='0x'+'a'.repeat(40),now=()=>new Date(memeAt),source=new SourceCorroboration(sourceDatabase,{now}),
    observer=new MemeObserver({database,now,maxActive:10,activeWindowSec:7200,allowedChains:['bsc'],marketBatch:async()=>[],
      corroboration:(token,at)=>source.assess(token,at)});
  const signal:Signal={source:'debot',sourceEventId:'meme-worker-1',token:{chain:'bsc',address},occurredAt:memeAt,text:'worker equality',claim:'unspecified',evidenceUrls:[]};
  observer.register(signal,memeAt,{name:'Worker Meme',symbol:'WORK'});
  assert.equal(source.record(signal,memeAt).accepted,true);
  const status=observer.status(),runner=new WalletHistoryDetailRunner({memeDatabase:database,memeMaxActive:10,memeActiveWindowSec:7200,
    memeAllowedChains:['bsc'],corroborationDatabase:sourceDatabase,timeoutMs:5_000});
  try {
    runner.start();
    assert.deepEqual(await runner.listMeme({limit:20,offset:0,asOf:memeAt},{now:memeAt,status}),observer.list({limit:20,offset:0,asOf:memeAt}));
    assert.deepEqual(await runner.getMeme('bsc',address,{limit:20,offset:0,asOf:memeAt},{now:memeAt}),
      observer.detail({chain:'bsc',address},{limit:20,offset:0,asOf:memeAt}));
    assert.deepEqual(await runner.getMemeStatus({now:memeAt,status:observer.runtimeStatus()}),observer.status());
  } finally {await runner.stop();await observer.close();source.close();rmSync(directory,{recursive:true,force:true});}
});

test('wallet detail runner coalesces identical reads and bounds unrelated pending work',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-detail-bounds-')),database=join(directory,'history.sqlite'),history=new WalletHistory(database);
  const runner=new WalletHistoryDetailRunner({database,maxPending:1,timeoutMs:5_000});
  try {
    runner.start();const first=runner.getWallet('bsc','0x'+'1'.repeat(40)),same=runner.getWallet('bsc','0x'+'1'.repeat(40));
    assert.equal(first,same);
    await assert.rejects(runner.getWallet('bsc','0x'+'2'.repeat(40)),error=>(error as Error).message==='WALLET_HISTORY_DETAIL_BUSY');
    assert.equal(await first,undefined);
  } finally {await runner.stop();history.close();rmSync(directory,{recursive:true,force:true});}
});

test('dashboard query worker serves wallet, profile and association pages from read-only databases',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-query-worker-')),database=join(directory,'history.sqlite'),
    profileDatabase=join(directory,'profiles.sqlite'),history=new WalletHistory(database),wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40),
    leader='0x'+'3'.repeat(40);
  history.recordTrade({chain:'bsc',wallet,tokenAddress:token,txHash:'0x'+'4'.repeat(64),side:'buy',
    eventAt:'2026-10-26T01:00:00.000Z',observedAt:'2026-10-26T01:00:01.000Z',source:'gmgn_wallet_activity',usd:'25'});
  const association={chain:'bsc',leader,candidate:wallet,firstDiscoveredAt:'2026-10-26T01:00:00.000Z',updatedAt:'2026-10-26T01:01:00.000Z',
    distinctTokens:1,prospectiveTokens:1,retrospectiveTokens:0,forwardValidatedTokens:1,exitAfterLeaderTokens:0,medianLeadSeconds:30,
    fundingKinds:[],grade:'timing_only',candidatePublic:false,verification:'vendor_claim',ownership:'unknown',status:'current'};
  const research=new DatabaseSync(database);research.prepare(`INSERT INTO wh_assoc_relations
    (chain,leader,candidate,first_at,updated_at,token_count,forward_count,funding_count,dirty,data,funding_data,active_since)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('bsc',leader,wallet,association.firstDiscoveredAt,association.updatedAt,1,1,0,0,JSON.stringify(association),'[]',association.firstDiscoveredAt);
  research.close();
  const profile={chain:'bsc',address:wallet,version:1,computedAt:'2026-10-26T01:02:00.000Z',freshUntil:'2026-10-26T07:02:00.000Z',
    status:'current',source:'wallet_history',sampleOnly:true,ownership:'unknown',groups:[],metrics:{observedEvents:1,buyEvents:1,sellEvents:0,
      distinctTokens:1,associations:{leaders:0,distinctTokens:0,forwardTokens:0},chain:{transactions:0,transfers:0}},counterparties:[],limitations:[]};
  const profileDb=new DatabaseSync(profileDatabase);profileDb.exec(`CREATE TABLE wp_profiles(chain TEXT,address TEXT,computed_at TEXT,data TEXT,PRIMARY KEY(chain,address));
    CREATE TABLE wp_groups(chain TEXT,address TEXT,group_id TEXT,PRIMARY KEY(chain,address,group_id));
    CREATE TABLE wp_changes(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,data TEXT);
    CREATE TABLE wp_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE wp_snapshots(key TEXT PRIMARY KEY,data TEXT);`);
  profileDb.prepare('INSERT INTO wp_profiles VALUES (?,?,?,?)').run('bsc',wallet,profile.computedAt,JSON.stringify(profile));profileDb.close();
  const runner=new WalletHistoryDetailRunner({database,profileDatabase,timeoutMs:5_000});
  try {
    runner.start();
    const wallets=await runner.listWallets({chain:'bsc',search:'0x',limit:10});
    assert.equal(wallets.total,1);assert.equal(wallets.items[0].address,wallet);
    const profiles=await runner.listProfiles({chain:'bsc',limit:10});
    assert.equal(profiles.ready,true);assert.equal(profiles.total,1);assert.equal(profiles.items[0].address,wallet);
    assert.equal((await runner.getProfile('bsc',wallet))?.address,wallet);
    const associations=await runner.listAssociations({chain:'bsc',limit:10});
    assert.equal(associations.total,1);assert.equal(associations.items[0].candidate,wallet);
    assert.equal((await runner.getAssociation('bsc',leader,wallet))?.association.leader,leader);
  } finally {await runner.stop();history.close();rmSync(directory,{recursive:true,force:true});}
});

test('dashboard query worker isolates scan and token-rank list and detail reads',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'dashboard-query-worker-')),scanDatabase=join(directory,'scans.sqlite'),
    rankDatabase=join(directory,'rank.sqlite'),address='0x'+'1'.repeat(40),wallet='0x'+'2'.repeat(40),
    id='11111111-1111-4111-8111-111111111111',at='2026-10-26T01:00:00.000Z';
  const scans=new DatabaseSync(scanDatabase);scans.exec(`CREATE TABLE scan_summaries(
      id TEXT PRIMARY KEY,chain TEXT,address TEXT,status TEXT,received_at TEXT,decision TEXT,eligible_at TEXT,
      last_price_attempt_at TEXT,lease_expires_at TEXT,performance_status TEXT,max_gain_pct REAL,record TEXT);
    CREATE TABLE watch_jobs(id TEXT PRIMARY KEY,chain TEXT,address TEXT,state TEXT,first_received_at TEXT,occurred_at TEXT,
      ends_at TEXT,next_check_at TEXT,last_check_at TEXT,attempts INTEGER,end_reason TEXT,claim_id TEXT,lease_until TEXT,signal TEXT,expiry_reason TEXT);`);
  const record={id,chain:'bsc',address,status:'completed',decision:'WATCH',receivedAt:at,occurredAt:at,source:'debot',
    reasons:[],checks:{provenance:{status:'unknown',reasons:[]},safety:{status:'unknown',reasons:[]},narrative:{status:'unknown',reasons:[]},
      wallets:{status:'unknown',reasons:[]},flow:{status:'unknown',reasons:[]}}};
  scans.prepare('INSERT INTO scan_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'bsc',address,'completed',at,'WATCH',null,null,null,null,null,JSON.stringify(record));
  scans.prepare('INSERT INTO watch_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'bsc',address,'scheduled',at,at,
    '2026-10-26T07:00:00.000Z','2026-10-26T01:01:00.000Z',null,2,null,null,null,null,'WINDOW_EXPIRED');scans.close();

  const rank=new DatabaseSync(rankDatabase);rank.exec(`CREATE TABLE tr_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE tr_tokens(chain TEXT,address TEXT,registered_at TEXT);
    CREATE TABLE tr_token_versions(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,computed_at TEXT,data TEXT,wallets TEXT);
    CREATE TABLE tr_wallets(chain TEXT,address TEXT,registered_at TEXT);
    CREATE TABLE tr_wallet_versions(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,computed_at TEXT,early_count INTEGER,realized REAL,data TEXT);
    CREATE TABLE tr_wallet_tokens(chain TEXT,address TEXT,token_address TEXT,registered_at TEXT);
    CREATE TABLE tr_wallet_token_versions(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,token_address TEXT,computed_at TEXT,present INTEGER,data TEXT);`);
  const token={chain:'bsc',address,registeredAt:at,computedAt:at,firstRank:{observedAt:at,rank:1,source:'test',evidenceId:'1'},
    latestRank:{observedAt:at,rank:1,source:'test',evidenceId:'1'},walletCount:1,entryCount:1,
    coverage:{rankSnapshots:1,traderRows:1,traderWallets:1,tradeRows:1,tradeWallets:1,postCount:0,truncated:false,limitations:[]},researchOnly:true,scoreEffect:0};
  const walletSummary={chain:'bsc',address:wallet,computedAt:at,tokenCount:1,entryTokenCount:1,earlyTokenCount:1,
    observedEarlyTokenCount:1,retrospectiveEarlyTokenCount:0,realizedCoverage:1,positiveRealizedTokens:1,negativeRealizedTokens:0,
    zeroRealizedTokens:0,unknownRealizedTokens:0,earlyPositiveRealizedTokens:1,realizedProfitUsd:10,unrealizedProfitUsd:0,
    totalProfitUsd:10,roiPct:null,largestPositiveRealizedShare:1,pnlWindow:{oldestAt:at,newestAt:at},researchOnly:true,scoreEffect:0,limitations:[]};
  const walletToken={chain:'bsc',address:wallet,tokenAddress:address,comparisons:{rank:{position:'before',knowledge:'observed_before_anchor',deltaSec:-1},
    signal:{position:'unknown',knowledge:'unknown',deltaSec:null},caPost:{position:'unknown',knowledge:'unknown',deltaSec:null}},limitations:[]};
  rank.prepare('INSERT INTO tr_meta VALUES (?,?)').run('last_run_at',at);
  rank.prepare('INSERT INTO tr_tokens VALUES (?,?,?)').run('bsc',address,at);
  rank.prepare('INSERT INTO tr_token_versions VALUES (?,?,?,?,?,?)').run(1,'bsc',address,at,JSON.stringify(token),JSON.stringify([walletToken]));
  rank.prepare('INSERT INTO tr_wallets VALUES (?,?,?)').run('bsc',wallet,at);
  rank.prepare('INSERT INTO tr_wallet_versions VALUES (?,?,?,?,?,?,?)').run(1,'bsc',wallet,at,1,10,JSON.stringify(walletSummary));
  rank.prepare('INSERT INTO tr_wallet_tokens VALUES (?,?,?,?)').run('bsc',wallet,address,at);
  rank.prepare('INSERT INTO tr_wallet_token_versions VALUES (?,?,?,?,?,?,?)').run(1,'bsc',wallet,address,at,1,JSON.stringify(walletToken));rank.close();

  const runner=new WalletHistoryDetailRunner({scanDatabase,tokenRankDatabase:rankDatabase,timeoutMs:5_000});
  try {
    runner.start();
    const page=await runner.listScans({search:'0x1',limit:20});assert.equal(page.total,1);assert.equal((page.items[0] as any).observation.attempts,2);
    assert.equal((await runner.getScan(id) as any).id,id);
    const tokens=await runner.listTokenRank({chain:'bsc',asOf:at});assert.equal(tokens.total,1);assert.equal(tokens.items[0].address,address);
    const tokenDetail=await runner.getTokenRank('bsc',address,{asOf:at});assert.equal(tokenDetail.total,1);assert.equal(tokenDetail.items[0].address,wallet);
    const wallets=await runner.listTokenRankWallets({chain:'bsc',asOf:at,sort:'realized'});assert.equal(wallets.total,1);assert.equal(wallets.items[0].address,wallet);
    const walletDetail=await runner.getTokenRankWallet('bsc',wallet,{asOf:at});assert.equal(walletDetail.total,1);assert.equal(walletDetail.items[0].tokenAddress,address);
  } finally {await runner.stop();rmSync(directory,{recursive:true,force:true});}
});

test('a synchronous worker send failure does not poison the address request cache',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-detail-send-')),database=join(directory,'history.sqlite'),history=new WalletHistory(database);
  const runner=new WalletHistoryDetailRunner({database,timeoutMs:5_000});runner.start();
  const internal=runner as unknown as {worker:{postMessage:(message:unknown)=>void}},worker=internal.worker,
    postMessage=worker.postMessage.bind(worker),address='0x'+'1'.repeat(40);
  try {
    worker.postMessage=()=>{throw new Error('SYNCHRONOUS_SEND_FAILURE');};
    await assert.rejects(runner.getWallet('bsc',address),error=>(error as Error).message==='WALLET_HISTORY_DETAIL_WORKER_FAILED');
    worker.postMessage=postMessage;
    assert.equal(await runner.getWallet('bsc',address),undefined);
  } finally {worker.postMessage=postMessage;await runner.stop();history.close();rmSync(directory,{recursive:true,force:true});}
});

test('an unexpectedly exited detail worker is relaunched for the next request',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-detail-restart-')),database=join(directory,'history.sqlite'),history=new WalletHistory(database);
  const runner=new WalletHistoryDetailRunner({database,timeoutMs:5_000});runner.start();
  try {
    assert.equal(await runner.getWallet('bsc','0x'+'1'.repeat(40)),undefined);
    const internal=runner as unknown as {worker:import('node:worker_threads').Worker|undefined},previous=internal.worker!;
    await previous.terminate();
    assert.deepEqual(await runner.listWallets({limit:1}),{items:[],total:0});assert.notEqual(internal.worker,previous);
  } finally {await runner.stop();history.close();rmSync(directory,{recursive:true,force:true});}
});
