import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {WalletHistory} from '../src/wallet-history.js';
import {LauncherCandidates} from '../src/launcher-candidates.js';
import {WalletFastRunner} from '../src/wallet-fast-runner.js';
import {WalletFastPersistenceRunner} from '../src/wallet-fast-persistence-runner.js';
import {WalletFastResearch} from '../src/wallet-fast-research.js';
import {LauncherRevalidator} from '../src/launcher-revalidator.js';
import {GmgnPlusArchiveRunner} from '../src/gmgn-plus-archive.js';
import type {FastWalletEvent} from '../src/wallet-fast.js';
import type {WalletActivity} from '../src/wallet-activity.js';
import type {Report} from '../src/types.js';
import type {WalletAnalysis,WalletRecord} from '../src/research/wallet-types.js';
import {signal,pass,narrative,now} from './helpers.js';

const walletAddress='0x2222222222222222222222222222222222222222';
const launcherActivity:WalletActivity={version:1,chain:'solana',wallet:'11111111111111111111111111111111',
  txHash:'2'.repeat(64),receivedAt:'2026-11-20T01:00:00.000Z',checkedAt:'2026-11-20T01:00:01.000Z',
  eventAt:'2026-11-20T01:00:00.000Z',classification:'transfer',reasons:['TOKEN_TRANSFER_ONLY'],trades:[],retryable:false,
  confirmation:'confirmed',transferCount:1,tradingEnabled:false};
const createProfileDatabase=(path:string)=>{const db=new DatabaseSync(path);db.exec(`
  CREATE TABLE wp_profiles(chain TEXT,address TEXT,computed_at TEXT NOT NULL,fresh_until TEXT NOT NULL,data TEXT NOT NULL,
    source_wallet INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chain,address));
  CREATE TABLE wp_groups(chain TEXT,address TEXT,group_id TEXT,first_at TEXT NOT NULL,PRIMARY KEY(chain,address,group_id));
  CREATE INDEX wp_groups_filter ON wp_groups(group_id,chain,address);`);db.close();};
function report(id:string,decision:'WATCH'|'REJECT'):Report {
  const s=signal({sourceEventId:id});
  const wallet:WalletRecord={chain:'bsc',address:walletAddress,sources:['top_holders'],
    vendorLabels:{provider:'gmgn',verification:'vendor_claim',platform:[],token:[]},recognizedLabels:[],
    vendorIdentity:{verification:'vendor_claim'},attribution:{status:'unknown',verification:'unverified'},
    holding:{amount:'10',usd:'2',supplyRatio:0.01,currentlyHolding:true},
    cumulative:{scope:'vendor_token_cumulative',recentInflow:false,buyVolumeUsd:'2',sellVolumeUsd:'0',buyCount:1,sellCount:0,
      firstAcquiredAt:now.toISOString(),lastActiveAt:now.toISOString(),exitedAt:null},
    funding:{address:null,label:null,verification:'vendor_claim',source:'unknown',amount:null,timestamp:null,txHash:null,sharedService:false,conflict:false},
    developerLinks:[],risks:[],clusterId:'sample',enrichment:{status:'not_requested',reasons:[]}};
  const wallets:WalletAnalysis={status:'pass',checkedAt:now.toISOString(),reasons:[],facts:{rawResponses:'DO_NOT_PERSIST'},wallets:[wallet],clusters:[],
    summary:{token:s.token,sampleOnly:true,uniqueWalletCount:1,enrichedWalletCount:0,currentHolderCount:1,smartCurrentHolderCount:0,
      smartFundingClusterCount:0,smartIndependenceProven:false,eligibleSmartWalletCount:0,qualifiedSmartWalletCount:0,qualifiedSmartFundingClusterCount:0,
      recentWindowSeconds:3600,recentNetBuyUsd:null,hasRecentAccumulation:null,sampledHoldingRatio:0.01,cumulativeBuyUsd:'2',cumulativeSellUsd:'0',
      cumulativeCoverageWalletCount:1,cumulativeIsRecentInflow:false}};
  return {id,mode:'live',policyVersion:'runtime-test',signal:s,receivedAt:now.toISOString(),evaluatedAt:now.toISOString(),
    validUntil:now.toISOString(),decision,buyEligible:false,executionEnabled:false,reasons:[],provenance:pass(),safety:pass(),narrative:narrative(),wallets};
}

test('wallet evidence persists for WATCH and REJECT independently of dashboard and survives cache eviction/restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-runtime-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'false',WALLET_RESEARCH_ENABLED:'true',WALLET_HISTORY_DATABASE_PATH:join(dir,'wallets.sqlite'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  const runtime=createRuntime(cfg);
  try {
    for(const decision of ['WATCH','REJECT'] as const) {
      const r=report(decision,decision),reservation=runtime.store.reserve(r.signal);r.id=reservation.entry.id;
      assert.equal(runtime.store.finish(r.id,r,reservation.entry.claimId!),true);
    }
    assert.equal(runtime.archive,undefined);
    assert.equal(runtime.walletHistory!.stats().wallets,1);
    assert.ok(runtime.walletHistory!.getWallet('bsc',walletAddress)!.holdings.length>0);
    runtime.store.prune(1,1,new Date(Date.now()+86_400_000));assert.equal(runtime.store.list().length,0);
    assert.equal(runtime.walletHistory!.stats().wallets,1);
    assert.equal(runtime.dashboardOverview().entryMode,'off');
    assert.equal(runtime.dashboardOrders().items.length,0);
  } finally {await runtime.close();}
  const restored=new WalletHistory(cfg.walletResearch.database);
  try {assert.equal(restored.stats().wallets,1);assert.ok(restored.getWallet('bsc',walletAddress)!.holdings.length>0);}
  finally {restored.close();rmSync(dir,{recursive:true,force:true});}
});

test('a scan archive failure does not suppress durable wallet evidence or alter research completion',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-runtime-failure-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'true',DASHBOARD_ACCESS_TOKEN:'wallet-test-access-token-with-32-characters',SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),
    WALLET_RESEARCH_ENABLED:'true',WALLET_HISTORY_DATABASE_PATH:join(dir,'wallets.sqlite'),ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  const runtime=createRuntime(cfg);
  try {
    runtime.archive!.capture=()=>{throw new Error('SIMULATED_ARCHIVE_FAILURE');};
    const r=report('archive-failure','WATCH'),reservation=runtime.store.reserve(r.signal);r.id=reservation.entry.id;
    assert.equal(runtime.store.finish(r.id,r,reservation.entry.claimId!),true);
    assert.equal(runtime.store.get(r.id)!.status,'completed');assert.equal(runtime.walletHistory!.stats().wallets,1);
    assert.equal(runtime.dashboardOverview().archiveError,'SCAN_ARCHIVE_WRITE_FAILED');
    assert.equal(runtime.walletResearchStatus().captureError,undefined);assert.equal(runtime.dashboardOrders().items.length,0);
  } finally {await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('completed wallet research archives only after the entry decision',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-runtime-entry-order-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'false',WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'wallets.sqlite'),ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  const runtime=createRuntime(cfg),order:string[]=[];
  try {
    runtime.providers.provenance=async()=>pass();runtime.providers.safety=async()=>pass();
    runtime.providers.evidence=async()=>[];runtime.providers.narrative=async()=>narrative();
    runtime.providers.research=undefined;runtime.providers.vendor=undefined;
    runtime.entry.consider=async()=>{order.push('entry');return {status:'skipped',reason:'ENTRY_DISABLED'};};
    runtime.walletHistory!.captureReport=()=>{order.push('wallet_archive');};
    const dispatch=Reflect.get(runtime.scanner,'onSignal') as (value:ReturnType<typeof signal>)=>Promise<void>;
    await dispatch(signal({sourceEventId:'wallet-entry-before-research'}));
    assert.deepEqual(order,['entry','wallet_archive']);
  } finally {await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('persistent watch queue operates without dashboard and retains original expiry across runtime restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'watch-runtime-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'false',WATCH_RECHECK_ENABLED:'true',SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  let runtime=createRuntime(cfg);let id='';
  try {
    const stamp=new Date().toISOString();const r=report('watch-runtime','WATCH');r.signal.occurredAt=stamp;r.receivedAt=stamp;r.evaluatedAt=stamp;r.validUntil=new Date(Date.now()+60000).toISOString();
    const reservation=runtime.store.reserve(r.signal);r.id=reservation.entry.id;r.receivedAt=reservation.entry.receivedAt;id=r.id;
    r.evaluatedAt=new Date().toISOString();assert.equal(runtime.store.finish(id,r,reservation.entry.claimId!),true);
    const before=runtime.archive!.get(id)!.observation!;assert.equal(before.state,'scheduled');assert.ok(Date.parse(before.endsAt)<=Date.parse(stamp)+600000);
    await runtime.close();runtime=createRuntime(cfg);
    const after=runtime.archive!.get(id)!.observation!;assert.equal(after.endsAt,before.endsAt);assert.equal(after.nextCheckAt,before.nextCheckAt);
    await runtime.watchRechecker!.runOnce();assert.equal(runtime.watchRechecker!.getStatus().deferredReason,'GMGN_API_KEY_MISSING');
    assert.equal(runtime.dashboardOverview().entryMode,'off');assert.equal(runtime.dashboardOrders().items.length,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('dashboard and status never run wallet stats or graph maintenance on the main thread',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-maintenance-'));
  const cfg=readConfig({WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),ORDERS_DATABASE_PATH:join(dir,'orders.sqlite')});
  const runtime=createRuntime(cfg);let counts=0;
  runtime.walletHistory!.refreshCoordination=()=>{throw new Error('MAIN_THREAD_COORDINATION_FORBIDDEN');};
  runtime.walletHistory!.refreshAssociations=()=>{throw new Error('MAIN_THREAD_ASSOCIATION_FORBIDDEN');};
  runtime.walletHistory!.stats=()=>{counts++;throw new Error('MAIN_THREAD_STATS_FORBIDDEN');};
  try {
    runtime.start();
    runtime.walletResearchStatus();runtime.dashboardOverview();runtime.walletResearchStatus();assert.equal(counts,0);
    assert.equal(runtime.walletResearchStatus().localIndex.running,true);
  } finally {await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('wallet price writer exposes an explicit pause reason when background research cannot start',async()=>{
  for(const [environment,reason] of [
    [{GMGN_BACKGROUND_RESEARCH_ENABLED:'true'},'GMGN_API_KEY_MISSING'],
    [{GMGN_BACKGROUND_RESEARCH_ENABLED:'false'},'GMGN_BACKGROUND_RESEARCH_DISABLED'],
  ] as const){
    const dir=mkdtempSync(join(tmpdir(),'wallet-price-runtime-'));
    const cfg=readConfig({...environment,WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
      WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),ORDERS_DATABASE_PATH:join(dir,'orders.sqlite')});
    const runtime=createRuntime(cfg);
    try{
      const status=runtime.walletResearchStatus();
      assert.equal(status.observer.running,false);assert.equal(status.observer.pausedReason,reason);
      assert.equal(status.priceWriter.running,false);assert.equal(status.priceWriter.ready,false);
      assert.equal(status.priceWriter.pausedReason,reason);
    }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
  }
});

test('runtime reports a fixed wallet price shutdown error only after closing the remaining stores',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-price-shutdown-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'false',WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  const runtime=createRuntime(cfg);let laterStoreClosed=false;
  runtime.walletPriceWriter!.stop=async()=>false;
  const originalClose=runtime.store.close.bind(runtime.store);
  runtime.store.close=()=>{laterStoreClosed=true;originalClose();};
  try {
    await assert.rejects(runtime.close(),{message:'WALLET_PRICE_WRITER_STOP_TIMEOUT'});
    assert.equal(laterStoreClosed,true,'shutdown must finish later cleanup before exposing the price-writer error');
    await assert.rejects(runtime.close(),{message:'WALLET_PRICE_WRITER_STOP_TIMEOUT'});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('an early scanner stop rejection is reported only after the remaining stores close',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runtime-early-stop-failure-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'false',TELEGRAM_ENABLED:'false',DEBOT_SCANNER_ENABLED:'true',
    DEBOT_TRANSPORT:'anonymous_poll',DEBOT_SIGNALS_DATABASE_PATH:join(dir,'debot.sqlite'),
    MEME_OBSERVER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',GMGN_MARKET_SIGNAL_ENABLED:'false',
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  const runtime=createRuntime(cfg),scanner=runtime.debotScanner!;let storeClosed=false,calls=0;
  const originalStop=scanner.stop.bind(scanner),originalStoreClose=runtime.store.close.bind(runtime.store);
  scanner.stop=async()=>{if(++calls===1)throw new Error('EARLY_SCANNER_STOP_FAILED');await originalStop();};
  runtime.store.close=()=>{storeClosed=true;originalStoreClose();};
  try {
    await assert.rejects(runtime.close(),{message:'EARLY_SCANNER_STOP_FAILED'});
    assert.equal(storeClosed,true);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('runtime waits for every grouped stop before closing stores when a sibling rejects',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runtime-grouped-stop-failure-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'true',DASHBOARD_ACCESS_TOKEN:'grouped-stop-access-token-with-32-characters',
    SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),WATCH_RECHECK_ENABLED:'true',TELEGRAM_ENABLED:'false',
    DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',GMGN_MARKET_SIGNAL_ENABLED:'false',
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  const runtime=createRuntime(cfg);let releaseDelayed!:(value:void)=>void,delayedStopped=false,storeClosed=false;
  runtime.tracking!.stop=async()=>{throw new Error('PASSIVE_FIRST_STOP_FAILED');};
  runtime.watchRechecker!.stop=()=>new Promise<void>(resolve=>{releaseDelayed=()=>{delayedStopped=true;resolve();};});
  const originalStoreClose=runtime.store.close.bind(runtime.store);
  runtime.store.close=()=>{assert.equal(delayedStopped,true,'store closed before every grouped stop settled');
    storeClosed=true;originalStoreClose();};
  const closing=runtime.close();
  try {
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(storeClosed,false);releaseDelayed();
    await assert.rejects(closing,{message:'PASSIVE_FIRST_STOP_FAILED'});assert.equal(storeClosed,true);
  } finally {if(releaseDelayed)releaseDelayed();await closing.catch(()=>{});rmSync(dir,{recursive:true,force:true});}
});

test('runtime abandons late cleanup before it can enter synchronous store closes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runtime-shutdown-deadline-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'false',TELEGRAM_ENABLED:'false',WALLET_RESEARCH_ENABLED:'true',
    WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',TOKEN_RANK_RESEARCH_ENABLED:'false',
    LAUNCHER_CANDIDATES_ENABLED:'false',DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',
    MEME_OBSERVER_ENABLED:'false',GMGN_MARKET_SIGNAL_ENABLED:'false',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  const runtime=createRuntime(cfg,{shutdownTimeoutMs:40});let releaseObserver!:(value:boolean)=>void,storeClosed=false;
  runtime.walletObserver!.stop=()=>new Promise<boolean>(resolve=>{releaseObserver=resolve;});
  const originalClose=runtime.store.close.bind(runtime.store);
  runtime.store.close=()=>{storeClosed=true;originalClose();};
  try {
    const started=Date.now();
    await assert.rejects(runtime.close(),{message:'RUNTIME_SHUTDOWN_TIMEOUT'});
    assert.ok(Date.now()-started<2000,'runtime deadline should reject well before the service stop deadline');
    assert.equal(storeClosed,false,'the timed-out drain must not close stores underneath active work');
    releaseObserver(true);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(storeClosed,false,'expired background cleanup must not enter blocking SQLite closes');
    await assert.rejects(runtime.close(),{message:'RUNTIME_SHUTDOWN_TIMEOUT'});
  } finally {
    if(releaseObserver)releaseObserver(true);
    try{runtime.walletHistory?.close();}catch{}
    try{runtime.orders.close();}catch{}
    if(!storeClosed)try{originalClose();}catch{}
    rmSync(dir,{recursive:true,force:true});
  }
});

test('runtime begins wallet observer drain before waiting for wallet-fast shutdown',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'runtime-shutdown-overlap-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'false',TELEGRAM_ENABLED:'false',WALLET_RESEARCH_ENABLED:'true',
    WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',TOKEN_RANK_RESEARCH_ENABLED:'false',
    LAUNCHER_CANDIDATES_ENABLED:'false',DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',
    MEME_OBSERVER_ENABLED:'false',GMGN_MARKET_SIGNAL_ENABLED:'false',CHAIN_STREAM_ENABLED:'true',WALLET_FAST_ENABLED:'true',
    SOLANA_STREAM_HTTP_URL:'https://rpc.invalid',SOLANA_STREAM_WS_URL:'wss://rpc.invalid',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),WALLET_ACTIVITY_DATABASE_PATH:join(dir,'activity.sqlite'),
    SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),CHAIN_STREAM_DATABASE_PATH:join(dir,'stream.sqlite'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  let releaseFast!:(value:void)=>void,releaseObserver!:(value:boolean)=>void,fastStarted=false,observerStarted=false;
  t.mock.method(WalletFastRunner.prototype,'stop',()=>{fastStarted=true;return new Promise<void>(resolve=>{releaseFast=resolve;});});
  const runtime=createRuntime(cfg);runtime.walletObserver!.stop=timeoutMs=>{
    observerStarted=true;assert.equal(timeoutMs,15_000);return new Promise<boolean>(resolve=>{releaseObserver=resolve;});
  };
  const closing=runtime.close();
  try {
    const fastBy=Date.now()+2000;
    while(!fastStarted&&Date.now()<fastBy)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(fastStarted,true);assert.equal(observerStarted,true,
      'observer drain must already be running while wallet-fast stop is pending');
    releaseFast();releaseObserver(true);await closing;
  } finally {if(releaseFast)releaseFast();if(releaseObserver)releaseObserver(true);await closing.catch(()=>{});rmSync(dir,{recursive:true,force:true});}
});

test('runtime fences GMGN Plus scheduling synchronously before its archive drain',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'runtime-gmgn-plus-fence-')),events:string[]=[];
  const cfg=readConfig({DASHBOARD_ENABLED:'false',TELEGRAM_ENABLED:'false',GMGN_API_KEY:'gmgn-test-key',
    GMGN_PLUS_ARCHIVE_ENABLED:'true',GMGN_PLUS_ARCHIVE_MARKET_ENABLED:'false',GMGN_PLUS_ARCHIVE_CHAINS:'sol',
    GMGN_PLUS_ARCHIVE_DATABASE_PATH:join(dir,'gmgn-plus.sqlite'),GMGN_MARKET_SIGNAL_ENABLED:'false',
    DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  const originalBegin=GmgnPlusArchiveRunner.prototype.beginStop,originalStop=GmgnPlusArchiveRunner.prototype.stop;
  t.mock.method(GmgnPlusArchiveRunner.prototype,'beginStop',function(this:GmgnPlusArchiveRunner){
    events.push('fence');return originalBegin.call(this);
  });
  t.mock.method(GmgnPlusArchiveRunner.prototype,'stop',async function(this:GmgnPlusArchiveRunner){
    events.push('drain');return originalStop.call(this);
  });
  const runtime=createRuntime(cfg);let storeClosed=false;const originalStoreClose=runtime.store.close.bind(runtime.store);
  runtime.store.close=()=>{storeClosed=true;originalStoreClose();};
  try {
    runtime.beginClose();runtime.beginClose();
    assert.deepEqual(events,['fence'],'the scheduling fence must run before close yields');
    assert.equal(storeClosed,false,'beginClose must leave shared stores open for draining HTTP handlers');
    const closing=runtime.close();
    await closing;assert.deepEqual(events,['fence','drain','fence']);
    assert.equal(storeClosed,true);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('runtime reports an undrained chain-event writer only after closing the remaining stores',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'chain-event-shutdown-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'false',CHAIN_STREAM_ENABLED:'true',
    SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),CHAIN_STREAM_DATABASE_PATH:join(dir,'stream.sqlite'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  const runtime=createRuntime(cfg),chainMonitor=runtime.chainMonitor!;let laterStoreClosed=false;
  const originalStop=chainMonitor.stop.bind(chainMonitor),originalClose=runtime.store.close.bind(runtime.store);
  chainMonitor.stop=async()=>false;
  runtime.store.close=()=>{laterStoreClosed=true;originalClose();};
  try {
    await assert.rejects(runtime.close(),{message:'CHAIN_EVENT_WRITER_SHUTDOWN_UNDRAINED'});
    assert.equal(laterStoreClosed,true,'shutdown must finish later cleanup before exposing the chain writer error');
    await assert.rejects(runtime.close(),{message:'CHAIN_EVENT_WRITER_SHUTDOWN_UNDRAINED'});
  } finally {await originalStop();rmSync(dir,{recursive:true,force:true});}
});

test('runtime surfaces an undrained wallet-fast persistence worker after completing later cleanup',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-fast-persistence-shutdown-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'false',WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
    LAUNCHER_CANDIDATES_ENABLED:'false',CHAIN_STREAM_ENABLED:'true',WALLET_FAST_ENABLED:'true',
    SOLANA_STREAM_HTTP_URL:'https://rpc.invalid',SOLANA_STREAM_WS_URL:'wss://rpc.invalid',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),WALLET_ACTIVITY_DATABASE_PATH:join(dir,'activity.sqlite'),
    SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),CHAIN_STREAM_DATABASE_PATH:join(dir,'stream.sqlite'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  t.mock.method(WalletFastPersistenceRunner.prototype,'stop',async()=>false);
  const runtime=createRuntime(cfg);let laterStoreClosed=false,originalClose=runtime.store.close.bind(runtime.store);
  runtime.store.close=()=>{laterStoreClosed=true;originalClose();};
  try {await assert.rejects(runtime.close(),{message:'WALLET_FAST_PERSISTENCE_SHUTDOWN_UNDRAINED'});
    assert.equal(laterStoreClosed,true);await assert.rejects(runtime.close(),{message:'WALLET_FAST_PERSISTENCE_SHUTDOWN_UNDRAINED'});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('runtime drains wallet-fast research before persistence and reports failure after later cleanup',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-fast-research-shutdown-'));
  const cfg=readConfig({DASHBOARD_ENABLED:'false',WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
    LAUNCHER_CANDIDATES_ENABLED:'false',CHAIN_STREAM_ENABLED:'true',WALLET_FAST_ENABLED:'true',
    SOLANA_STREAM_HTTP_URL:'https://rpc.invalid',SOLANA_STREAM_WS_URL:'wss://rpc.invalid',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),WALLET_ACTIVITY_DATABASE_PATH:join(dir,'activity.sqlite'),
    SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),CHAIN_STREAM_DATABASE_PATH:join(dir,'stream.sqlite'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  const order:string[]=[];t.mock.method(WalletFastResearch.prototype,'stop',async()=>{order.push('research');return false;});
  t.mock.method(WalletFastPersistenceRunner.prototype,'stop',async()=>{order.push('persistence');return true;});
  const runtime=createRuntime(cfg);let laterStoreClosed=false,originalClose=runtime.store.close.bind(runtime.store);
  runtime.store.close=()=>{laterStoreClosed=true;originalClose();};
  try {await assert.rejects(runtime.close(),{message:'WALLET_FAST_RESEARCH_SHUTDOWN_UNDRAINED'});
    assert.deepEqual(order,['research','persistence']);assert.equal(laterStoreClosed,true);
    await assert.rejects(runtime.close(),{message:'WALLET_FAST_RESEARCH_SHUTDOWN_UNDRAINED'});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a retraction accepted while the socket runner stops enters the research drain synchronously',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-fast-retraction-shutdown-')),stamp=new Date().toISOString();
  const event:FastWalletEvent={id:'shutdown-retraction',chain:'solana',wallet:'11111111111111111111111111111111',
    txHash:'shutdown-retraction-signature',receivedAt:stamp,judgedAt:stamp,processingMs:0,kind:'wallet_mention',verdict:'retracted',
    groups:['launcher_candidate'],profileFresh:true,cachedSafety:'unknown',commitment:'processed',removed:true,buyVerified:false,tradingEnabled:false};
  const cfg=readConfig({DASHBOARD_ENABLED:'false',WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
    LAUNCHER_CANDIDATES_ENABLED:'false',CHAIN_STREAM_ENABLED:'true',WALLET_FAST_ENABLED:'true',
    SOLANA_STREAM_HTTP_URL:'https://rpc.invalid',SOLANA_STREAM_WS_URL:'wss://rpc.invalid',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),WALLET_ACTIVITY_DATABASE_PATH:join(dir,'activity.sqlite'),
    SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),CHAIN_STREAM_DATABASE_PATH:join(dir,'stream.sqlite'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  let onEvent:((value:FastWalletEvent)=>void)|undefined;const admitted:FastWalletEvent[]=[];
  t.mock.method(WalletFastRunner.prototype,'start',function(this:WalletFastRunner){onEvent=(this as unknown as {options:{onEvent:(value:FastWalletEvent)=>void}}).options.onEvent;});
  t.mock.method(WalletFastRunner.prototype,'stop',async()=>{assert.ok(onEvent);onEvent(event);});
  t.mock.method(WalletFastResearch.prototype,'start',()=>{});
  t.mock.method(WalletFastResearch.prototype,'enqueue',(value:FastWalletEvent)=>{admitted.push(value);});
  t.mock.method(WalletFastResearch.prototype,'stop',async()=>true);
  t.mock.method(WalletFastPersistenceRunner.prototype,'start',()=>{});
  t.mock.method(WalletFastPersistenceRunner.prototype,'stop',async()=>true);
  const runtime=createRuntime(cfg);
  try {runtime.start();await runtime.close();assert.deepEqual(admitted,[event]);}
  finally {rmSync(dir,{recursive:true,force:true});}
});

test('launcher revalidation uses the unified persistence bridge before advancing its classified activity',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'launcher-persistence-runtime-')),profiles=join(dir,'profiles.sqlite');createProfileDatabase(profiles);
  const cfg=readConfig({DASHBOARD_ENABLED:'false',TELEGRAM_ENABLED:'false',WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
    WALLET_SCREENING_ENABLED:'false',TOKEN_RANK_RESEARCH_ENABLED:'false',LAUNCHER_CANDIDATES_ENABLED:'true',
    CHAIN_STREAM_ENABLED:'true',WALLET_FAST_ENABLED:'true',SOLANA_STREAM_HTTP_URL:'https://rpc.invalid',SOLANA_STREAM_WS_URL:'wss://rpc.invalid',
    DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',GMGN_MARKET_SIGNAL_ENABLED:'false',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),WALLET_ACTIVITY_DATABASE_PATH:join(dir,'activity.sqlite'),
    WALLET_PROFILES_DATABASE_PATH:profiles,LAUNCHER_CANDIDATES_DATABASE_PATH:join(dir,'launcher.sqlite'),
    SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),CHAIN_STREAM_DATABASE_PATH:join(dir,'stream.sqlite'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  let callback:((activity:WalletActivity)=>Promise<void>)|undefined,attempts=0;const lifecycle:string[]=[],persisted:WalletActivity[]=[];
  t.mock.method(WalletFastPersistenceRunner.prototype,'start',()=>{lifecycle.push('persistence');});
  t.mock.method(WalletFastPersistenceRunner.prototype,'persist',async(activity:WalletActivity)=>{persisted.push(activity);return ++attempts>1;});
  t.mock.method(WalletFastPersistenceRunner.prototype,'stop',async()=>true);
  t.mock.method(LauncherRevalidator.prototype,'start',function(this:LauncherRevalidator){lifecycle.push('revalidator');
    callback=(this as unknown as {options:{source:{onActivity?:(activity:WalletActivity)=>Promise<void>}}}).options.source.onActivity;});
  t.mock.method(LauncherRevalidator.prototype,'stop',async()=>{});
  t.mock.method(LauncherCandidates.prototype,'observeActivity',()=>{throw new Error('MAIN_THREAD_LAUNCHER_ACTIVITY_WRITE_FORBIDDEN');});
  t.mock.method(WalletFastRunner.prototype,'start',()=>{});t.mock.method(WalletFastRunner.prototype,'stop',async()=>{});
  t.mock.method(WalletFastResearch.prototype,'start',()=>{});t.mock.method(WalletFastResearch.prototype,'stop',async()=>true);
  const runtime=createRuntime(cfg);
  try {runtime.start();assert.ok(callback);assert.ok(lifecycle.indexOf('persistence')<lifecycle.indexOf('revalidator'));
    await assert.rejects(callback!(launcherActivity),/LAUNCHER_ACTIVITY_PERSISTENCE_REJECTED/);
    await callback!(launcherActivity);assert.deepEqual(persisted,[launcherActivity,launcherActivity]);
  } finally {await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('launcher revalidation rejects classified activity when unified persistence is not configured',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'launcher-persistence-missing-')),profiles=join(dir,'profiles.sqlite');createProfileDatabase(profiles);
  const cfg=readConfig({DASHBOARD_ENABLED:'false',TELEGRAM_ENABLED:'false',WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
    WALLET_SCREENING_ENABLED:'false',TOKEN_RANK_RESEARCH_ENABLED:'false',LAUNCHER_CANDIDATES_ENABLED:'true',
    CHAIN_STREAM_ENABLED:'false',WALLET_FAST_ENABLED:'false',SOLANA_STREAM_HTTP_URL:'https://rpc.invalid',SOLANA_STREAM_WS_URL:'wss://rpc.invalid',
    DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',GMGN_MARKET_SIGNAL_ENABLED:'false',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),WALLET_PROFILES_DATABASE_PATH:profiles,
    LAUNCHER_CANDIDATES_DATABASE_PATH:join(dir,'launcher.sqlite'),SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_MODE:'off'});
  let callback:((activity:WalletActivity)=>Promise<void>)|undefined;
  t.mock.method(LauncherRevalidator.prototype,'start',function(this:LauncherRevalidator){
    callback=(this as unknown as {options:{source:{onActivity?:(activity:WalletActivity)=>Promise<void>}}}).options.source.onActivity;});
  t.mock.method(LauncherRevalidator.prototype,'stop',async()=>{});
  const runtime=createRuntime(cfg);
  try {runtime.start();assert.ok(callback);await assert.rejects(callback!(launcherActivity),/LAUNCHER_ACTIVITY_PERSISTENCE_UNAVAILABLE/);}
  finally {await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('dashboard launcher summary uses the worker cache instead of a main-thread candidate scan',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'launcher-dashboard-cache-')),profiles=join(dir,'profiles.sqlite');
  const db=new DatabaseSync(profiles);db.exec(`
    CREATE TABLE wp_profiles(chain TEXT,address TEXT,computed_at TEXT NOT NULL,fresh_until TEXT NOT NULL,data TEXT NOT NULL,
      source_wallet INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chain,address));
    CREATE TABLE wp_groups(chain TEXT,address TEXT,group_id TEXT,first_at TEXT NOT NULL,PRIMARY KEY(chain,address,group_id));
    CREATE INDEX wp_groups_filter ON wp_groups(group_id,chain,address);
  `);db.close();
  const cfg=readConfig({WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',LAUNCHER_CANDIDATES_ENABLED:'true',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),WALLET_PROFILES_DATABASE_PATH:profiles,
    LAUNCHER_CANDIDATES_DATABASE_PATH:join(dir,'launcher.sqlite'),ORDERS_DATABASE_PATH:join(dir,'orders.sqlite')});
  const runtime=createRuntime(cfg);
  try {runtime.start();const deadline=Date.now()+5000;
    while(!runtime.launcherCandidatesStatus().refresh?.result&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(runtime.launcherCandidatesStatus().refresh?.result);
    t.mock.method(LauncherCandidates.prototype,'status',()=>{throw new Error('MAIN_THREAD_LAUNCHER_STATUS_FORBIDDEN');});
    assert.equal(runtime.dashboardOverview().launcherCandidates.records,0);
    assert.equal(runtime.launcherCandidatesStatus().records,0);
  } finally {await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
