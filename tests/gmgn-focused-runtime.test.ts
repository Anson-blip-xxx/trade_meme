import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {GmgnError} from '../src/providers/gmgn-client.js';
import {normalizeAveSignals} from '../src/providers/ave-signals.js';
import {normalizeDebotSignals} from '../src/providers/debot-signals.js';
import {normalizeGmgnMarketSignals} from '../src/gmgn-market-signal-scanner.js';
import {unknown} from '../src/types.js';

const ca='0x'+'a'.repeat(40),otherCa='0x'+'b'.repeat(40),wallet='0x'+'c'.repeat(40);
const marketToken=bs58.encode(new Uint8Array(32).fill(11)),marketId='market-runtime-retry-0001';
const marketRow=(n=1,extra:Record<string,unknown>={})=>{const trigger=Math.floor(Date.now()/1000)-1,
  address=n===1?marketToken:bs58.encode(new Uint8Array(32).fill(10+n));return {id:n===1?marketId:`market-runtime-retry-${String(n).padStart(4,'0')}`,token_address:address,
  signal_type:13,trigger_at:trigger,trigger_mc:25_000,signal_times:1,
  data:{chain:'sol',address,symbol:`RETRY${n}`,name:`Retry Token ${n}`},...extra};};
async function waitFor(check:()=>boolean,label:string,timeoutMs=8_000){
  const deadline=Date.now()+timeoutMs;
  while(!check()){
    if(Date.now()>=deadline)assert.fail(`${label} timed out`);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
function tableCount(path:string,table:string){
  const db=new DatabaseSync(path,{readOnly:true});
  try{return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);}finally{db.close();}
}
function fixture(extra:Record<string,string>={}){
  const dir=mkdtempSync(join(tmpdir(),'gmgn-focused-'));
  const env={ENTRY_MODE:'off',GMGN_BACKGROUND_RESEARCH_ENABLED:'false',SCANNER_ENABLED:'true',
    GMGN_API_KEY:'focused-runtime-'+dir,SCANNER_CHAINS:'bsc',DASHBOARD_ENABLED:'false',
    DEBOT_SCANNER_ENABLED:'true',DEBOT_TRANSPORT:'anonymous_poll',AVE_SCANNER_ENABLED:'true',
    WATCH_RECHECK_ENABLED:'true',WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'true',
    WALLET_SCREENING_ENABLED:'true',TOKEN_RANK_RESEARCH_ENABLED:'true',MEME_OBSERVER_ENABLED:'true',
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),
    DEBOT_SIGNALS_DATABASE_PATH:join(dir,'debot.sqlite'),DEBOT_SESSION_PATH:join(dir,'debot-session.json'),
    AVE_SIGNALS_DATABASE_PATH:join(dir,'ave.sqlite'),AVE_SESSION_PATH:join(dir,'ave-session.json'),
    SOURCE_EVIDENCE_DATABASE_PATH:join(dir,'sources.sqlite'),MEME_DATABASE_PATH:join(dir,'meme.sqlite'),
    WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),WALLET_PROFILES_DATABASE_PATH:join(dir,'profiles.sqlite'),
    WALLET_SCREENING_DATABASE_PATH:join(dir,'screening.sqlite'),TOKEN_RANK_RESEARCH_DATABASE_PATH:join(dir,'rank.sqlite'),
    CHAIN_STREAM_DATABASE_PATH:join(dir,'chain.sqlite'),WALLET_ACTIVITY_DATABASE_PATH:join(dir,'activity.sqlite'),...extra};
  return {dir,config:readConfig(env)};
}
function pages(){
  const now=new Date(),stamp=Math.floor(now.getTime()/1000)-5;
  return {
    ave:normalizeAveSignals({status:1,data:{list:[{id:1,chain:'bsc',token:ca,symbol:'TEST',
      signal_time:stamp,tag:'smarter_buy',action_type:'buy',action_count:1,
      actions:[{id:1,wallet_address:wallet,action_time:stamp-1,action_type:'buy'}]}]}},now),
    debot:normalizeDebotSignals({code:0,data:{results:[{id:'focused-debot',chain:'bsc',channel_id:2,
      token:ca,create_time:stamp,wallet_stats:[]}]}},'bsc',now),
  };
}

test('GMGN background research defaults to compatible behavior and accepts only explicit booleans',()=>{
  assert.equal(readConfig({}).gmgnBackgroundResearchEnabled,true);
  assert.equal(readConfig({GMGN_BACKGROUND_RESEARCH_ENABLED:'false'}).gmgnBackgroundResearchEnabled,false);
  for(const value of ['0','FALSE','','disabled'])assert.throws(()=>readConfig({GMGN_BACKGROUND_RESEARCH_ENABLED:value}));
});

test('focused startup pauses GMGN discovery and watch polling while retaining source and local evidence workers',async()=>{
  const {dir,config}=fixture(),runtime=createRuntime(config),started:string[]=[];
  try{
    assert.equal(runtime.walletObserver,undefined);
    runtime.scanner.start=()=>{throw Error('GMGN_SCANNER_MUST_REMAIN_PAUSED');};
    runtime.watchRechecker!.start=()=>{throw Error('WATCH_RECHECK_MUST_REMAIN_PAUSED');};
    for(const [name,worker]of [
      ['debot',runtime.debotScanner!],['ave',runtime.aveScanner!],['meme',runtime.memeObserver!],
      ['tracking',runtime.tracking!],['profiles',runtime.walletProfiles!],['rank',runtime.tokenRankResearch!],
    ] as const)worker.start=()=>{started.push(name);};
    runtime.walletScreening!.start=dispatch=>{assert.equal(dispatch,undefined);started.push('screening');};
    runtime.walletHistory!.refreshCoordination=()=>{throw Error('MAIN_THREAD_COORDINATION_FORBIDDEN');};
    runtime.walletHistory!.refreshAssociations=()=>{throw Error('MAIN_THREAD_ASSOCIATION_FORBIDDEN');};
    runtime.start();
    assert.deepEqual(started.sort(),['ave','debot','meme','profiles','rank','screening','tracking']);
    assert.equal(runtime.walletResearchStatus().localIndex.running,true);
    await runtime.watchRechecker!.runOnce();
    assert.equal(runtime.watchRechecker!.getStatus().deferredReason,'GMGN_BACKGROUND_RESEARCH_DISABLED');
    const status=runtime.dashboardOverview();
    assert.equal(status.gmgnUsage.mode,'trade_and_on_demand');
    assert.equal(status.scanner.enabled,false);assert.equal(status.scanner.running,false);
    assert.equal(status.walletResearch.observer.running,false);
    assert.equal(status.watchRecheck.enabled,false);
    assert.equal(status.entryMode,'off');assert.equal(runtime.dashboardOrders().total,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime starts the dedicated Market Signal reader without enabling counting or entry',async()=>{
  const {dir,config}=fixture({GMGN_BACKGROUND_RESEARCH_ENABLED:'true',GMGN_MARKET_SIGNAL_ENABLED:'true',
    GMGN_MARKET_SIGNAL_INTERVAL_MS:'1000',SCANNER_CHAINS:'solana',SCANNER_ENABLED:'false',DEBOT_SCANNER_ENABLED:'false',
    AVE_SCANNER_ENABLED:'false',WALLET_RESEARCH_ENABLED:'false',WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',
    TOKEN_RANK_RESEARCH_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',WATCH_RECHECK_ENABLED:'false'});
  let marketCalls=0;const runtime=createRuntime(config,{gmgnFetcher:async input=>{
    if(new URL(String(input)).pathname==='/v1/market/token_signal')marketCalls++;
    return Response.json({code:0,data:[]});
  }});
  try{
    assert.ok(runtime.gmgnMarketScanner);runtime.start();await waitFor(()=>marketCalls>0,'dedicated GMGN market poll');
    const status=runtime.dashboardOverview().gmgnMarketSignals;
    assert.equal(status.running,true);assert.equal(status.entryPipeline,false);assert.equal(status.countingPipeline,false);
    assert.deepEqual(status.chains,['sol']);assert.equal(runtime.signalCounting.status().running,false);
    assert.equal(runtime.signalCounting.status().events,0);assert.equal(runtime.dashboardOrders().total,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('completed GMGN Market analysis stays outside active signal counting and every entry path',async()=>{
  const {dir,config}=fixture({GMGN_BACKGROUND_RESEARCH_ENABLED:'true',GMGN_MARKET_SIGNAL_ENABLED:'true',
    GMGN_MARKET_SIGNAL_INTERVAL_MS:'1000',SCANNER_CHAINS:'solana',SCANNER_ENABLED:'false',DEBOT_SCANNER_ENABLED:'false',
    AVE_SCANNER_ENABLED:'false',WALLET_RESEARCH_ENABLED:'false',WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',
    TOKEN_RANK_RESEARCH_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',WATCH_RECHECK_ENABLED:'false'});
  let marketPages=0,entryTransportCalls=0,entryConsiderCalls=0;
  const runtime=createRuntime(config,{gmgnFetcher:async input=>Response.json(new URL(String(input)).pathname==='/v1/market/token_signal'?
    {code:0,data:marketPages++===0?[]:[marketRow()]}:{code:0,data:[]}),
    entryFetcher:async()=>{entryTransportCalls++;assert.fail('GMGN Market research must never call the entry transport');}});
  try{
    runtime.providers.provenance=async()=>unknown('TEST_ORIGIN_UNKNOWN');runtime.providers.safety=async()=>unknown('TEST_SAFETY_UNKNOWN');
    runtime.providers.evidence=async()=>[];runtime.providers.narrative=async()=>({...unknown('TEST_NARRATIVE_UNKNOWN'),evidence:[]});
    runtime.providers.vendor=undefined;runtime.providers.research=undefined;runtime.providers.walletScreening=undefined;
    runtime.entry.consider=async()=>{entryConsiderCalls++;assert.fail('GMGN Market research must never enter EntryController.consider');};
    runtime.signalCountingControl('start','web');
    const countBefore=runtime.signalCounting.status();
    assert.equal(countBefore.running,true);assert.equal(countBefore.events,0);assert.equal(countBefore.candidates,0);
    runtime.sourceObservation!.start();await waitFor(()=>runtime.sourceObservation!.status().ready,'source observation worker');

    // Establish the successful-poll boundary, then deliver a live type-13 row
    // which is eligible for and completes the full evaluation callback.
    await runtime.gmgnMarketScanner!.runOnce();await runtime.gmgnMarketScanner!.waitForIdle();
    await runtime.gmgnMarketScanner!.runOnce();await runtime.gmgnMarketScanner!.waitForIdle();

    const marketStatus=runtime.gmgnMarketScanner!.status(),countAfter=runtime.signalCounting.status();
    assert.equal(marketStatus.totals.completed,1);assert.equal(marketStatus.totals.processed,1);
    assert.equal(runtime.store.list().filter(item=>item.signal.sourceEventId===`gmgn:market:sol:${marketId}`&&item.status==='completed').length,1);
    assert.equal(entryConsiderCalls,0);assert.equal(entryTransportCalls,0);
    assert.equal(countAfter.events,countBefore.events);assert.equal(countAfter.candidates,countBefore.candidates);
    assert.equal(runtime.dashboardOrders().total,0);assert.equal(tableCount(config.ordersDatabase,'opening_orders'),0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('GMGN market retry reclaims an interrupted Store entry and completes its evaluation',async()=>{
  const {dir,config}=fixture({GMGN_BACKGROUND_RESEARCH_ENABLED:'true',GMGN_MARKET_SIGNAL_ENABLED:'true',
    GMGN_MARKET_SIGNAL_INTERVAL_MS:'1000',SCANNER_CHAINS:'solana',SCANNER_ENABLED:'false',DEBOT_SCANNER_ENABLED:'false',
    AVE_SCANNER_ENABLED:'false',WALLET_RESEARCH_ENABLED:'false',WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',
    TOKEN_RANK_RESEARCH_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',WATCH_RECHECK_ENABLED:'false'});
  let stableMarketRow=marketRow(),marketPages=0;const runtime=createRuntime(config,{gmgnFetcher:async input=>Response.json(new URL(String(input)).pathname==='/v1/market/token_signal'?
    {code:0,data:marketPages++===0?[]:[stableMarketRow]}:{code:0,data:[]})});
  try{
    runtime.providers.provenance=async()=>unknown('TEST_ORIGIN_UNKNOWN');runtime.providers.safety=async()=>unknown('TEST_SAFETY_UNKNOWN');
    runtime.providers.evidence=async()=>[];runtime.providers.narrative=async()=>({...unknown('TEST_NARRATIVE_UNKNOWN'),evidence:[]});
    runtime.providers.vendor=undefined;runtime.providers.research=undefined;runtime.providers.walletScreening=undefined;
    runtime.sourceObservation!.start();await waitFor(()=>runtime.sourceObservation!.status().ready,'source observation worker');
    const submit=runtime.sourceObservation!.submit.bind(runtime.sourceObservation);let observationAttempts=0;
    runtime.sourceObservation!.submit=async observation=>++observationAttempts===1?{sourceError:'SOURCE_EVIDENCE_CAPTURE_FAILED'}:submit(observation);
    await runtime.gmgnMarketScanner!.runOnce();await runtime.gmgnMarketScanner!.waitForIdle();
    stableMarketRow=marketRow(1,{trigger_at:Math.floor(Date.now()/1000)});
    const signal=normalizeGmgnMarketSignals([stableMarketRow],'sol').observations[0].signal;
    const reserved=runtime.store.reserve(signal);assert.equal(runtime.store.interrupt(reserved.entry.id,reserved.entry.claimId!),true);
    assert.equal(runtime.store.get(reserved.entry.id)?.status,'interrupted');
    await runtime.gmgnMarketScanner!.runOnce();await runtime.gmgnMarketScanner!.waitForIdle();
    assert.equal(runtime.store.get(reserved.entry.id)?.status,'completed');assert.equal(runtime.store.history(reserved.entry.id).length,1);
    assert.equal(runtime.gmgnMarketScanner!.status().totals.completed,1);assert.equal(observationAttempts,2);
    assert.equal(runtime.gmgnMarketScanner!.status().totals.observationErrors,1);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime close establishes the GMGN market stop fence before its first await',async()=>{
  const {dir,config}=fixture({GMGN_BACKGROUND_RESEARCH_ENABLED:'true',GMGN_MARKET_SIGNAL_ENABLED:'true',
    GMGN_MARKET_SIGNAL_INTERVAL_MS:'1000',SCANNER_CHAINS:'solana',SCANNER_ENABLED:'false'}),runtime=createRuntime(config);
  let fenced=false;
  try{
    runtime.gmgnMarketScanner!.stop=async()=>{fenced=true;};
    const closing=runtime.close();assert.equal(fenced,true);await closing;
  }finally{if(!fenced)await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime shutdown completes active GMGN market research and defers queued work without opening entry',async()=>{
  const {dir,config}=fixture({GMGN_BACKGROUND_RESEARCH_ENABLED:'true',GMGN_MARKET_SIGNAL_ENABLED:'true',
    GMGN_MARKET_SIGNAL_INTERVAL_MS:'1000',GMGN_MARKET_SIGNAL_ANALYSIS_CONCURRENCY:'1',SCANNER_CHAINS:'solana',
    SCANNER_ENABLED:'false',DASHBOARD_ENABLED:'true',DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',WALLET_RESEARCH_ENABLED:'false',
    WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',TOKEN_RANK_RESEARCH_ENABLED:'false',
    MEME_OBSERVER_ENABLED:'false',WATCH_RECHECK_ENABLED:'false'});
  let marketPages=0;const runtime=createRuntime(config,{gmgnFetcher:async input=>Response.json(new URL(String(input)).pathname==='/v1/market/token_signal'?
    {code:0,data:marketPages++===0?[]:[marketRow(1),marketRow(2)]}:{code:0,data:[]})});
  let release!:()=>void,started=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  try{
    runtime.providers.provenance=async()=>{started++;await gate;return unknown('TEST_ORIGIN_UNKNOWN');};
    runtime.providers.safety=async()=>unknown('TEST_SAFETY_UNKNOWN');runtime.providers.evidence=async()=>[];
    runtime.providers.narrative=async()=>({...unknown('TEST_NARRATIVE_UNKNOWN'),evidence:[]});
    runtime.providers.vendor=undefined;runtime.providers.research=undefined;runtime.providers.walletScreening=undefined;
    runtime.entry.consider=async()=>{assert.fail('market shutdown drain must never enter the order path');};
    await runtime.gmgnMarketScanner!.runOnce();await runtime.gmgnMarketScanner!.waitForIdle();
    await runtime.gmgnMarketScanner!.runOnce();await waitFor(()=>started===1&&runtime.gmgnMarketScanner!.status().queueDepth===1,'first market analysis');
    const closing=runtime.close();release();await closing;
    const db=new DatabaseSync(config.dashboard.archivePath,{readOnly:true});try{
      assert.equal(Number(db.prepare("SELECT count(*) AS n FROM scan_summaries WHERE status='completed' AND json_extract(record,'$.source')='gmgn'").get()!.n),1);
    }finally{db.close();}
    assert.equal(runtime.gmgnMarketScanner!.status().totals.shutdownDeferred,1);
  }finally{release();rmSync(dir,{recursive:true,force:true});}
});

test('two legacy analyses leave two global admission slots for the dedicated market scanner',async()=>{
  const {dir,config}=fixture({GMGN_BACKGROUND_RESEARCH_ENABLED:'true',GMGN_MARKET_SIGNAL_ENABLED:'true',
    GMGN_MARKET_SIGNAL_INTERVAL_MS:'1000',GMGN_MARKET_SIGNAL_ANALYSIS_CONCURRENCY:'2',SCANNER_CHAINS:'solana',
    SCANNER_ENABLED:'false',DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',WALLET_RESEARCH_ENABLED:'false',
    WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',TOKEN_RANK_RESEARCH_ENABLED:'false',
    MEME_OBSERVER_ENABLED:'false',WATCH_RECHECK_ENABLED:'false'});
  let marketPages=0;const runtime=createRuntime(config,{gmgnFetcher:async input=>Response.json(new URL(String(input)).pathname==='/v1/market/token_signal'?
    {code:0,data:marketPages++===0?[]:[marketRow(1),marketRow(2)]}:{code:0,data:[]})});
  let releaseLegacy!:()=>void,releaseMarket!:()=>void,legacyStarted=0,marketStarted=0,active=0,peak=0;
  const legacyGate=new Promise<void>(resolve=>{releaseLegacy=resolve;}),marketGate=new Promise<void>(resolve=>{releaseMarket=resolve;});
  const stamp=Math.floor(Date.now()/1000)-1,trades=[1,2].map(n=>({side:'buy',base_address:bs58.encode(new Uint8Array(32).fill(20+n)),
    maker:bs58.encode(new Uint8Array(32).fill(30+n)),transaction_hash:bs58.encode(new Uint8Array(64).fill(40+n)),timestamp:stamp}));
  try{
    runtime.client.get=async()=>({list:trades});
    runtime.providers.provenance=async signal=>{active++;peak=Math.max(peak,active);
      if(signal.sourceEventId.startsWith('gmgn:market:')){marketStarted++;await marketGate;}else{legacyStarted++;await legacyGate;}
      active--;return unknown('TEST_ORIGIN_UNKNOWN');};
    runtime.providers.safety=async()=>unknown('TEST_SAFETY_UNKNOWN');runtime.providers.evidence=async()=>[];
    runtime.providers.narrative=async()=>({...unknown('TEST_NARRATIVE_UNKNOWN'),evidence:[]});
    runtime.providers.vendor=undefined;runtime.providers.research=undefined;runtime.providers.walletScreening=undefined;
    await runtime.gmgnMarketScanner!.runOnce();await runtime.gmgnMarketScanner!.waitForIdle();
    const legacy=runtime.scanner.runOnce();await waitFor(()=>legacyStarted===2,'two legacy analyses');
    await runtime.gmgnMarketScanner!.runOnce();await waitFor(()=>marketStarted===2,'two market analyses');
    assert.equal(peak,4);releaseLegacy();releaseMarket();await legacy;await runtime.gmgnMarketScanner!.waitForIdle();
    assert.equal(runtime.gmgnMarketScanner!.status().totals.callbackErrors,0);
  }finally{releaseLegacy();releaseMarket();await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('shutdown Market does not retry analysis attempts blocked by four active legacy evaluations',async()=>{
  const {dir,config}=fixture({GMGN_BACKGROUND_RESEARCH_ENABLED:'true',GMGN_MARKET_SIGNAL_ENABLED:'true',
    GMGN_MARKET_SIGNAL_INTERVAL_MS:'1000',GMGN_MARKET_SIGNAL_ANALYSIS_CONCURRENCY:'2',SCANNER_CHAINS:'solana',
    SCANNER_ENABLED:'false',DASHBOARD_ENABLED:'true',DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',
    WALLET_RESEARCH_ENABLED:'false',WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',
    TOKEN_RANK_RESEARCH_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',WATCH_RECHECK_ENABLED:'false'});
  let marketPages=0;const runtime=createRuntime(config,{gmgnFetcher:async input=>Response.json(new URL(String(input)).pathname==='/v1/market/token_signal'?
    {code:0,data:marketPages++===0?[]:[marketRow(1),marketRow(2)]}:{code:0,data:[]})});
  let releaseLegacy!:()=>void,legacyStarted=0,marketStarted=0,closing:Promise<void>|undefined;
  const legacyGate=new Promise<void>(resolve=>{releaseLegacy=resolve;}),stamp=Math.floor(Date.now()/1000)-1,
    trades=[1,2,3,4].map(n=>({side:'buy',base_address:bs58.encode(new Uint8Array(32).fill(50+n)),
      maker:bs58.encode(new Uint8Array(32).fill(60+n)),transaction_hash:bs58.encode(new Uint8Array(64).fill(70+n)),timestamp:stamp}));
  try{
    // Production keeps this reader at two; four here models the shared active
    // counter being occupied by any mix of legacy, DeBot and Ave evaluations.
    (runtime.scanner as unknown as {signalConcurrency:number}).signalConcurrency=4;
    runtime.client.get=async()=>({list:trades});
    runtime.providers.provenance=async signal=>{if(signal.sourceEventId.startsWith('gmgn:market:'))marketStarted++;
      else {legacyStarted++;await legacyGate;}return unknown('TEST_ORIGIN_UNKNOWN');};
    runtime.providers.safety=async()=>unknown('TEST_SAFETY_UNKNOWN');runtime.providers.evidence=async()=>[];
    runtime.providers.narrative=async()=>({...unknown('TEST_NARRATIVE_UNKNOWN'),evidence:[]});
    runtime.providers.vendor=undefined;runtime.providers.research=undefined;runtime.providers.walletScreening=undefined;
    runtime.entry.consider=async()=>{assert.fail('shutdown research must not enter the order path');};
    await runtime.gmgnMarketScanner!.runOnce();await runtime.gmgnMarketScanner!.waitForIdle();
    const legacy=runtime.scanner.runOnce();await waitFor(()=>legacyStarted===4,'four active legacy analyses');
    await runtime.gmgnMarketScanner!.runOnce();closing=runtime.close();
    await new Promise(resolve=>setTimeout(resolve,350));
    const blockedErrors=runtime.gmgnMarketScanner!.status().totals.callbackErrors;
    await new Promise(resolve=>setTimeout(resolve,600));
    assert.equal(runtime.gmgnMarketScanner!.status().totals.callbackErrors,blockedErrors,'shutdown must not start another analysis attempt');
    assert.equal(marketStarted,0);releaseLegacy();await legacy;await closing;
    const status=runtime.gmgnMarketScanner!.status();assert.equal(status.totals.completed,0);assert.equal(status.totals.processed,0);
    assert.equal(marketStarted,0);const db=new DatabaseSync(config.ordersDatabase,{readOnly:true});
    try{assert.equal(Number(db.prepare('SELECT count(*) AS n FROM opening_orders').get()!.n),0);}finally{db.close();}
  }finally{releaseLegacy();await closing?.catch(()=>{});await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('partial GMGN raw archive acceptance is terminal and disables further archive batches',async()=>{
  const {dir,config}=fixture({GMGN_BACKGROUND_RESEARCH_ENABLED:'true',GMGN_MARKET_SIGNAL_ENABLED:'true',
    GMGN_MARKET_SIGNAL_INTERVAL_MS:'1000',SCANNER_CHAINS:'solana',SCANNER_ENABLED:'false',DEBOT_SCANNER_ENABLED:'false',
    AVE_SCANNER_ENABLED:'false',WALLET_RESEARCH_ENABLED:'false',WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',
    TOKEN_RANK_RESEARCH_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',WATCH_RECHECK_ENABLED:'false'});
  config.gmgnPlusArchive!.enabled=true;config.gmgnPlusArchive!.database=join(dir,'gmgn-plus.sqlite');config.gmgnPlusArchive!.maxBytes=16*1024*1024;
  const partial={...marketRow(1),oversized_raw:'x'.repeat(270_000)};
  const runtime=createRuntime(config,{gmgnFetcher:async input=>Response.json(new URL(String(input)).pathname==='/v1/market/token_signal'?
    {code:0,data:[partial]}:{code:0,data:[]})});
  try{
    runtime.providers.provenance=async()=>unknown('TEST_ORIGIN_UNKNOWN');runtime.providers.safety=async()=>unknown('TEST_SAFETY_UNKNOWN');
    runtime.providers.evidence=async()=>[];runtime.providers.narrative=async()=>({...unknown('TEST_NARRATIVE_UNKNOWN'),evidence:[]});
    runtime.providers.vendor=undefined;runtime.providers.research=undefined;runtime.providers.walletScreening=undefined;
    await runtime.gmgnMarketScanner!.runOnce();await runtime.gmgnMarketScanner!.waitForIdle();
    const status=runtime.gmgnMarketScanner!.status();assert.equal(status.archiveState,'degraded');
    assert.equal(status.archiveDisabledReason,'GMGN_MARKET_ARCHIVE_TERMINAL_PARTIAL_REJECTION');
    assert.equal(status.totals.archiveErrors,1);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('focused runtime sends an RPC-verified wallet buy through on-demand research without enabling trading',async()=>{
  const observedWallet=bs58.encode(new Uint8Array(32).fill(7));
  const token=bs58.encode(new Uint8Array(32).fill(8));
  const txHash=bs58.encode(new Uint8Array(64).fill(9));
  const {dir,config}=fixture({SCANNER_CHAINS:'solana',CHAIN_STREAM_ENABLED:'true',WALLET_FAST_ENABLED:'true',
    SOLANA_STREAM_HTTP_URL:'https://rpc.example.test',SOLANA_STREAM_WS_URL:'wss://rpc.example.test'});
  const runtime=createRuntime(config,{walletActivityVerify:async event=>({version:1,chain:'solana',wallet:event.wallet,txHash:event.txHash,
    receivedAt:event.receivedAt,checkedAt:new Date().toISOString(),eventAt:event.receivedAt,classification:'buy',
    reasons:['SUPPORTED_SWAP_AND_WALLET_FLOW_CONFIRMED'],trades:[{tokenAddress:token,side:'buy',amountAtomic:'1000',protocol:'pump_swap'}],
    retryable:false,confirmation:'confirmed',slot:123,transferCount:2,tradingEnabled:false})});
  try{
    runtime.providers.provenance=async()=>unknown('TEST_ORIGIN_UNKNOWN');
    runtime.providers.safety=async()=>unknown('TEST_SAFETY_UNKNOWN');
    runtime.providers.evidence=async()=>[];
    runtime.providers.narrative=async()=>({...unknown('TEST_NARRATIVE_UNKNOWN'),evidence:[]});
    runtime.providers.research=undefined;runtime.providers.walletScreening=undefined;
    const research=runtime.walletFastResearch!;research.start();
    const receivedAt=new Date().toISOString();
    research.enqueue({id:`solana:${observedWallet}:${txHash}`,chain:'solana',wallet:observedWallet,txHash,slot:123,
      receivedAt,judgedAt:receivedAt,processingMs:0,kind:'wallet_mention',verdict:'priority_review',groups:['forward_validated'],
      profileFresh:true,cachedSafety:'unknown',commitment:'processed',removed:false,buyVerified:false,tradingEnabled:false});
    await research.runOnce();
    const reports=runtime.store.list().filter(item=>item.report?.signal.source==='wallet');
    assert.equal(reports.length,1);assert.equal(reports[0].report!.signal.token.address,token);
    assert.equal(reports[0].report!.executionEnabled,false);assert.equal(reports[0].report!.buyEligible,false);
    assert.equal(runtime.archive!.trackingTokens(20,new Date()).some(item=>item.chain==='solana'&&item.address===token),true);
    assert.equal(research.status().counts.dispatched,1);assert.equal(runtime.dashboardOrders().total,0);
    assert.equal(runtime.signalCounting.status().candidates,0);
    const overview=runtime.dashboardOverview(),stream=overview.chainStream;
    if(!('walletFast' in stream)||!('research' in stream.walletFast))assert.fail('wallet fast status unavailable');
    const fast=stream.walletFast.research;
    assert.equal(overview.gmgnUsage.backgroundResearchEnabled,false);
    assert.equal(overview.gmgnUsage.pausedTasks.includes('wallet_fast_full_research'),false);
    assert.equal(overview.gmgnUsage.retainedTasks.includes('wallet_verified_buy_on_demand_research'),true);
    assert.equal(fast.fullResearchEnabled,false);assert.equal(fast.pausedReason,'GMGN_BACKGROUND_RESEARCH_DISABLED');
    assert.equal(fast.broadBackgroundResearchEnabled,false);
    assert.equal(fast.walletTriggeredOnDemandResearchEnabled,true);
    assert.equal(fast.walletTriggeredOnDemandResearchReady,true);
    runtime.client.recordRateLimit(new Headers({'retry-after':'60'}));
    const cooled=runtime.chainStreamStatus();
    if(!('walletFast' in cooled)||!('research' in cooled.walletFast))assert.fail('wallet fast cooldown status unavailable');
    assert.equal(cooled.walletFast.research.walletTriggeredOnDemandResearchReady,false);
    assert.equal(cooled.walletFast.research.walletTriggeredOnDemandResearchBlockedReason,'GMGN_RATE_LIMITED');
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

for(const failure of ['GMGN_API_KEY_MISSING','GMGN_RATE_LIMITED'] as const)
test(`focused DeBot/Ave still analyze signals during ${failure}, preserving unknown safety and no orders`,async()=>{
  const {dir,config}=fixture(failure==='GMGN_API_KEY_MISSING'?{GMGN_API_KEY:''}:{}),runtime=createRuntime(config);
  try{
    runtime.providers.provenance=async()=>unknown('TEST_ORIGIN_UNKNOWN');
    runtime.providers.safety=async()=>unknown('TEST_SAFETY_UNKNOWN');
    runtime.providers.vendor=undefined;runtime.providers.evidence=async()=>[];
    runtime.providers.narrative=async()=>({...unknown('TEST_NARRATIVE_UNKNOWN'),evidence:[]});
    runtime.client.withSignal=()=>runtime.client;
    const requests:string[]=[];
    runtime.client.get=async path=>{requests.push(path);throw new GmgnError(failure);};
    if(failure==='GMGN_RATE_LIMITED')runtime.client.recordRateLimit(new Headers({'retry-after':'60'}));
    const page=pages();runtime.aveScanner!.acceptPage(page.ave);runtime.debotScanner!.acceptPage(page.debot);
    await waitFor(()=>tableCount(config.ave!.database,'ave_observation_inbox')===0&&
      tableCount(config.debotSignalsDatabase,'debot_observation_inbox')===0,'source observation ACK');
    await runtime.aveScanner!.dispatchOnce();await runtime.debotScanner!.dispatchOnce();
    assert.equal(runtime.archive!.list().total,2);
    assert.deepEqual(new Set(runtime.archive!.list().items.map(item=>item.source)),new Set(['ave','debot']));
    assert.ok(runtime.archive!.list().items.every(item=>item.buyEligible===false&&item.decision==='WATCH'));
    assert.ok(requests.includes('/v1/token/info'));assert.ok(requests.includes('/v1/token/security'));
    assert.ok(!requests.includes('/v1/user/kol')&&!requests.includes('/v1/user/smartmoney'));
    assert.equal(runtime.sourceEvidence!.assess(page.ave.observations[0].signal.token).sources.length,2);
    assert.equal(runtime.dashboardOrders().total,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('focused market sampling cannot fall back to GMGN, but targeted prices can and Dex survives cooldown',async()=>{
  const {dir,config}=fixture(),originalFetch=globalThis.fetch;let dex=false,gmgnCalls=0;
  const fetcher:typeof fetch=async input=>{
    const url=String(input);
    if(!url.startsWith('https://api.dexscreener.com/'))return Response.json([]);
    return Response.json(dex?[{chainId:'bsc',baseToken:{address:otherCa},pairAddress:'0x'+'d'.repeat(40),
      priceUsd:'2',liquidity:{usd:100000}}]:[]);
  };
  globalThis.fetch=fetcher;
  const runtime=createRuntime(config,{priceFetcher:fetcher});
  try{
    runtime.client.withSignal=()=>runtime.client;
    runtime.client.get=async(_path,query)=>{gmgnCalls++;return {address:query.address,price:{price:'2'}};};
    runtime.aveScanner!.acceptPage(pages().ave);
    await runtime.memeObserver!.runOnce();assert.equal(gmgnCalls,0);
    const first=await runtime.priceRouter.read([{chain:'bsc',address:ca}]);
    assert.equal(first.samples[0]?.source,'gmgn_token_info_sample');assert.equal(gmgnCalls,1);
    runtime.client.recordRateLimit(new Headers({'retry-after':'60'}));dex=true;
    const second=await runtime.priceRouter.read([{chain:'bsc',address:otherCa}]);
    assert.equal(second.samples[0]?.source,'dexscreener_token_pairs_sample');assert.equal(gmgnCalls,1);
    assert.equal(runtime.priceRouter.getStatus().sources.gmgn.state,'cooldown');
    assert.equal(runtime.dashboardOrders().total,0);
  }finally{await runtime.close();globalThis.fetch=originalFetch;rmSync(dir,{recursive:true,force:true});}
});
