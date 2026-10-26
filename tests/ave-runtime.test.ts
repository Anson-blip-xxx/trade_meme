import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {normalizeAveSignals} from '../src/providers/ave-signals.js';
import {normalizeDebotSignals} from '../src/providers/debot-signals.js';
import {unknown,type Signal} from '../src/types.js';
import type {MemeMarketSample} from '../src/meme-assessment.js';

const ca='0x610a36f996650be0561f5d74d36b7e73520a7777',wallet='0xb2374d152cf495383421355f8672a668af6f8dc6';
function fixture(extra:Record<string,string>={}){
  const dir=mkdtempSync(join(tmpdir(),'ave-runtime-'));
  const env={ENTRY_MODE:'off',AVE_SCANNER_ENABLED:'true',DEBOT_SCANNER_ENABLED:'true',DEBOT_TRANSPORT:'anonymous_poll',
    MEME_OBSERVER_ENABLED:'true',DASHBOARD_ENABLED:'true',GMGN_API_KEY:'test-ave-no-network',SCANNER_CHAINS:'bsc',
    AVE_SIGNALS_DATABASE_PATH:join(dir,'ave.sqlite'),AVE_SESSION_PATH:join(dir,'ave-session','session.json'),
    SOURCE_EVIDENCE_DATABASE_PATH:join(dir,'sources.sqlite'),MEME_DATABASE_PATH:join(dir,'meme.sqlite'),
    DEBOT_SIGNALS_DATABASE_PATH:join(dir,'debot.sqlite'),DEBOT_SESSION_PATH:join(dir,'debot-session','session.json'),
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),...extra};
  return {dir,env,config:readConfig(env)};
}
function ave(at=new Date()){
  return normalizeAveSignals({status:1,data:{list:[{id:1,chain:'bsc',token:ca,symbol:'TEST',
    signal_time:Math.floor(at.getTime()/1000)-5,tag:'smarter_buy',action_type:'buy',action_count:1,
    actions:[{id:1,wallet_address:wallet,action_time:Math.floor(at.getTime()/1000)-6,action_type:'buy'}]}]}},at);
}
function debot(at=new Date()){
  return normalizeDebotSignals({code:0,data:{results:[{id:'debot-cross-test',chain:'bsc',channel_id:2,
    token:ca,create_time:Math.floor(at.getTime()/1000)-8,wallet_stats:[]}]}},'bsc',at);
}
function localProviders(runtime:ReturnType<typeof createRuntime>){
  runtime.providers.provenance=async()=>unknown('TEST_ORIGIN_UNKNOWN');
  runtime.providers.safety=async()=>unknown('TEST_SAFETY_UNKNOWN');
  runtime.providers.research=undefined;runtime.providers.vendor=undefined;
  runtime.providers.evidence=async()=>[];runtime.providers.narrative=async()=>({...unknown('TEST_NO_NARRATIVE'),evidence:[]});
}

test('Ave runtime immediately feeds cross-source evidence and Meme observation, then archives safety research without orders',async()=>{
  const {dir,config}=fixture({SOURCE_EVIDENCE_MAX_EVENTS:'300000',SOURCE_EVIDENCE_MAX_MB:'512',DEBOT_SIGNALS_MAX_MB:'256'}),original=globalThis.fetch;let network=0;
  globalThis.fetch=async()=>{network++;throw Error('unexpected external request');};
  let runtime=createRuntime(config);
  try{
    localProviders(runtime);const page=ave(),signal=page.observations[0].signal;
    assert.equal(runtime.sourceEvidence!.status().maxEvents,300000);
    assert.equal(runtime.sourceEvidence!.status().maxBytes,512*1024*1024);
    assert.equal(runtime.debotScanner!.getStatus().maxBytes,256*1024*1024);
    runtime.aveScanner!.acceptPage(page);
    assert.equal(runtime.archive!.list().total,0);assert.equal(runtime.memeObserver!.list().total,1);
    assert.equal(runtime.memeObserver!.list().items[0].firstSeenAt,page.observations[0].observedAt);
    assert.deepEqual(runtime.sourceEvidence!.assess(signal.token).freshSources,['ave']);
    assert.deepEqual(runtime.aveScanner!.vendorWalletTargets(signal)?.addresses,[wallet]);
    await runtime.aveScanner!.dispatchOnce();
    const item=runtime.archive!.list().items[0];assert.equal(item.source,'ave');assert.equal(item.address,ca);
    assert.equal(item.receivedAt,page.observations[0].observedAt);assert.equal(item.occurredAt,signal.occurredAt);
    assert.equal(item.buyEligible,false);assert.equal(runtime.aveScanner!.list().items[0].decision,'WATCH');
    const status=runtime.dashboardOverview().ave;assert.ok('mode' in status);assert.equal(status.mode,'public_signal_stream');
    assert.equal(runtime.dashboardOrders().items.length,0);
    assert.equal(runtime.sourceEvidence!.assess(signal.token).sources[0].deliveryCount,1);
    runtime.debotScanner!.acceptPage(debot());
    const cross=runtime.sourceEvidence!.assess(signal.token);assert.equal(cross.classification,'cross_source');
    assert.deepEqual(cross.freshSources,['ave','debot']);assert.equal(cross.scoreEffect,0);assert.equal(cross.independentEvidence,'unknown');
    runtime.aveScanner!.acceptPage(page);assert.equal(runtime.sourceEvidence!.assess(signal.token).sources[0].deliveryCount,1);
    await runtime.close();runtime=createRuntime(config);localProviders(runtime);
    runtime.aveScanner!.acceptPage(page);await runtime.aveScanner!.dispatchOnce();
    assert.equal(runtime.archive!.list().total,1);assert.equal(runtime.aveScanner!.getStatus().completed,1);
    assert.equal(runtime.sourceEvidence!.assess(signal.token).freshSourceCount,2);assert.equal(runtime.dashboardOrders().total,0);
    assert.equal(network,0);
  }finally{await runtime.close();globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
});

test('collector storage budgets keep bounded defaults and reject invalid configuration',()=>{
  const defaults=readConfig({});
  assert.equal(defaults.corroboration?.maxEvents,100000);
  assert.equal(defaults.debotSignalsMaxBytes,64*1024*1024);
  for(const key of ['DEBOT_SIGNALS_MAX_MB','SOURCE_EVIDENCE_MAX_MB','SOURCE_EVIDENCE_MAX_EVENTS'])
    for(const value of ['0','-1','Infinity','NaN','1.5','1000001'])
      assert.throws(()=>readConfig({[key]:value}));
  assert.equal(readConfig({TOKEN_RANK_RESEARCH_MAX_MB:'4096'}).tokenRankResearch?.maxBytes,4*1024**3);
  assert.equal(readConfig({TOKEN_RANK_RESEARCH_MAX_MB:'8192'}).tokenRankResearch?.maxBytes,8*1024**3);
});

test('Ave wallet nominations survive safety rejection independently of research limits and never fabricate trades',async()=>{
  const {dir,env}=fixture(),config=readConfig({...env,WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
    WALLET_SCREENING_ENABLED:'false',WALLET_HISTORY_DATABASE_PATH:join(dir,'wallets.sqlite')}),runtime=createRuntime(config);
  try{
    localProviders(runtime);runtime.providers.safety=async()=>({...unknown('TEST_SAFETY_REJECTED'),status:'fail'});
    const page=ave(),observation=page.observations[0];
    observation.vendorWallets=Array.from({length:5},(_,i)=>({source:'ave',verification:'vendor_report',
      address:'0x'+String(i+1).repeat(40),alias:'vendor KOL',side:'buy',lastTradeAt:observation.signal.occurredAt}));
    runtime.aveScanner!.acceptPage(page);
    assert.equal(runtime.walletHistory!.stats().nominations,5);assert.equal(runtime.walletHistory!.stats().events,0);
    await runtime.aveScanner!.dispatchOnce();assert.equal(runtime.archive!.list().items[0].decision,'REJECT');
    assert.equal(runtime.walletHistory!.stats().nominations,5);assert.equal(runtime.walletHistory!.stats().events,0);
    assert.equal(runtime.walletHistory!.stats().tokens,0);
    for(const nominee of observation.vendorWallets){
      const detail=runtime.walletHistory!.getWallet('bsc',nominee.address)!;
      assert.equal(detail.vendorNominations!.length,1);assert.equal(detail.wallet.tokenCount,0);
      assert.deepEqual(detail.wallet.labels,[]);assert.equal(detail.wallet.name,undefined);assert.equal(detail.timeline.length,0);
    }
    assert.equal(runtime.dashboardOrders().items.length,0);
    // Failure of the durable nomination sink remains visible and cannot suppress cross-source observation.
    runtime.walletHistory!.captureVendorNominations=()=>{throw Error('private-nomination-error');};
    const second=structuredClone(page);second.observations[0].id='2';second.observations[0].signal.sourceEventId='ave:signal:'+'b'.repeat(64);
    runtime.aveScanner!.acceptPage(second);
    const status=runtime.dashboardOverview().ave;assert.ok('nominationCaptureError' in status);
    assert.equal(status.nominationCaptureError,'WALLET_NOMINATION_CAPTURE_FAILED');
    assert.equal(runtime.sourceEvidence!.assess(observation.signal.token).sources[0].notificationCount,2);
    assert.equal(JSON.stringify(runtime.dashboardOverview()).includes('private-nomination-error'),false);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('Meme history freezes source coverage at assessment while latest source display evolves',async()=>{
  const {dir,config}=fixture(),runtime=createRuntime(config);
  try{
    const page=ave(),token=page.observations[0].signal.token;runtime.aveScanner!.acceptPage(page);
    const market:MemeMarketSample={version:1,token,source:'dexscreener_pair',observedAt:new Date().toISOString(),
      priceUsd:1,liquidityUsd:50000,poolAddress:'0x'+'2'.repeat(40),windows:{'5m':{buys:5,sells:2,volumeUsd:1000}}};
    assert.equal(runtime.memeObserver!.recordMarket(market),true);
    runtime.debotScanner!.acceptPage(debot());
    assert.equal(runtime.memeObserver!.list().items[0].corroboration!.freshSourceCount,2);
    const detail=runtime.memeObserver!.detail(token)!;
    assert.equal(detail.items[0].corroboration!.freshSourceCount,1);
    assert.deepEqual(detail.items[0].corroboration!.freshSources,['ave']);
    assert.equal(runtime.dashboardOrders().items.length,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('startup restoration of saved DeBot observations does not count as a new provider delivery',async()=>{
  const {dir,config}=fixture({DASHBOARD_ENABLED:'false',GMGN_API_KEY:''});let runtime=createRuntime(config);
  try{
    const page=debot(),token=page.observations[0].signal.token;runtime.debotScanner!.acceptPage(page);
    const first=runtime.sourceEvidence!.assess(token).sources[0];assert.equal(first.deliveryCount,1);
    await runtime.close();runtime=createRuntime(config);
    // Exercise actual runtime startup/seed wiring while disabling external collectors.
    runtime.aveScanner!.start=()=>{};runtime.debotScanner!.start=()=>{};runtime.memeObserver!.start=()=>{};
    runtime.start();runtime.start();
    const restored=runtime.sourceEvidence!.assess(token).sources[0];
    assert.equal(restored.deliveryCount,1);assert.equal(restored.notificationCount,1);
    assert.equal(restored.firstObservedAt,first.firstObservedAt);assert.equal(restored.recordedAt,first.recordedAt);
    assert.equal(restored.lastDeliveryAt,first.lastDeliveryAt);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('failure of one research archive cannot suppress the independent observation sink or leak an upstream exception',async()=>{
  const {dir,config}=fixture(),runtime=createRuntime(config);
  try{
    runtime.sourceEvidence!.record=()=>{throw Error('private-token-must-not-leak');};
    runtime.aveScanner!.acceptPage(ave());assert.equal(runtime.memeObserver!.list().total,1);
    const status=runtime.dashboardOverview().corroboration;assert.ok('captureError' in status);
    assert.equal(status.captureError,'SOURCE_EVIDENCE_CAPTURE_FAILED');
    assert.equal(JSON.stringify(runtime.dashboardOverview()).includes('private-token'),false);
    assert.equal(runtime.aveScanner!.getStatus().pending,1);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('real GMGN feed coverage is independent of research cap and local wallet research cannot manufacture GMGN confirmation',async()=>{
  const {dir,config}=fixture({SCANNER_MAX_SIGNALS:'1'}),runtime=createRuntime(config);
  try{
    localProviders(runtime);const page=ave(),signal=page.observations[0].signal;
    runtime.aveScanner!.acceptPage(page);
    // All discovery sources share this callback. Invoke the callback supplied to
    // the scanner to represent the local profile runner without starting timers.
    const dispatch=Reflect.get(runtime.scanner,'onSignal') as (signal:Signal)=>Promise<void>;
    await dispatch({...signal,source:'gmgn',sourceEventId:'wallet-setup:trade:local-observation'});
    assert.deepEqual(runtime.sourceEvidence!.assess(signal.token).freshSources,['ave']);
    const tokens=Array.from({length:5},(_,i)=>i===4?ca:'0x'+String(i+1).repeat(40));
    const timestamp=Math.floor(Date.now()/1000)-1;
    runtime.client.get=async path=>{
      assert.match(path,/^\/v1\/user\/(kol|smartmoney)$/);
      return {chain:'bsc',list:tokens.map((base_address,i)=>({chain:'bsc',base_address,maker:wallet,side:'buy',timestamp,
        transaction_hash:'0x'+String(i+1).repeat(64)}))};
    };
    const cycle=await runtime.scanner.runOnce();assert.equal(cycle.emitted,1);
    for(const address of tokens){const coverage=runtime.sourceEvidence!.assess({chain:'bsc',address});
      assert.ok(coverage.freshSources.includes('gmgn'));assert.equal(coverage.sources.find(s=>s.source==='gmgn')?.notificationCount,1);
      assert.equal(coverage.sources.find(s=>s.source==='gmgn')?.txReferenceCount,1);
    }
    assert.deepEqual(runtime.sourceEvidence!.assess(signal.token).freshSources,['ave','gmgn']);
    assert.equal(runtime.dashboardOrders().items.length,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('Ave and corroboration paths reject existing database/session aliases before modifying business data',()=>{
  for(const invalid of [':memory:','file:memory?mode=memory',''])for(const key of ['AVE_SIGNALS_DATABASE_PATH','AVE_SESSION_PATH','SOURCE_EVIDENCE_DATABASE_PATH'])
    assert.throws(()=>readConfig({[key]:invalid}));
  const {dir,env}=fixture();
  try{
    for(const field of ['AVE_SIGNALS_DATABASE_PATH','AVE_SESSION_PATH','SOURCE_EVIDENCE_DATABASE_PATH'])
      assert.throws(()=>createRuntime(readConfig({...env,[field]:env.ORDERS_DATABASE_PATH})),/SOURCE_DATABASE_CONFLICT/);
    const file=join(dir,'protected.txt');writeFileSync(file,'preserve business bytes');
    for(const [name,link] of [['symlink',symlinkSync],['hardlink',linkSync]] as const){
      const alias=join(dir,name);link(file,alias);
      assert.throws(()=>createRuntime(readConfig({...env,ORDERS_DATABASE_PATH:file,AVE_SIGNALS_DATABASE_PATH:alias})),/SOURCE_DATABASE_CONFLICT/);
      assert.equal(readFileSync(file,'utf8'),'preserve business bytes');
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
