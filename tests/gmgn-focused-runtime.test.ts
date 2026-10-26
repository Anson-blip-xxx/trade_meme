import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {GmgnError} from '../src/providers/gmgn-client.js';
import {normalizeAveSignals} from '../src/providers/ave-signals.js';
import {normalizeDebotSignals} from '../src/providers/debot-signals.js';
import {unknown} from '../src/types.js';

const ca='0x'+'a'.repeat(40),otherCa='0x'+'b'.repeat(40),wallet='0x'+'c'.repeat(40);
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
    WALLET_SCREENING_DATABASE_PATH:join(dir,'screening.sqlite'),TOKEN_RANK_RESEARCH_DATABASE_PATH:join(dir,'rank.sqlite'),...extra};
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
