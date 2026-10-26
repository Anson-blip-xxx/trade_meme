import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {WalletHistory} from '../src/wallet-history.js';
import type {Report} from '../src/types.js';
import type {WalletAnalysis,WalletRecord} from '../src/research/wallet-types.js';
import {signal,pass,narrative,now} from './helpers.js';

const walletAddress='0x2222222222222222222222222222222222222222';
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
