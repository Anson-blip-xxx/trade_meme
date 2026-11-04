import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';

const mint=bs58.encode(new Uint8Array(32).fill(41));
const response=(data:unknown)=>new Response(JSON.stringify({code:0,data}),{status:200,
  headers:{'content-type':'application/json'}});

test('Market Discovery 配置默认关闭并严格限制容量、频率和 Kline 冷却',()=>{
  assert.equal(readConfig({}).gmgnMarketDiscovery?.enabled,false);
  const configured=readConfig({GMGN_MARKET_DISCOVERY_ENABLED:'true',GMGN_MARKET_DISCOVERY_DATABASE_PATH:'/tmp/discovery.sqlite',
    GMGN_MARKET_DISCOVERY_MAX_MB:'64',GMGN_MARKET_DISCOVERY_INTERVAL_SEC:'45',GMGN_MARKET_DISCOVERY_MAX_CANDIDATES:'12',
    GMGN_MARKET_KLINE_COOLDOWN_SEC:'600'}).gmgnMarketDiscovery!;
  assert.deepEqual(configured,{enabled:true,database:'/tmp/discovery.sqlite',maxBytes:64*1024*1024,intervalSec:45,
    maxCandidates:12,klineCooldownSec:600});
  for(const env of [{GMGN_MARKET_DISCOVERY_ENABLED:'yes'},{GMGN_MARKET_DISCOVERY_MAX_MB:'1'},
    {GMGN_MARKET_DISCOVERY_INTERVAL_SEC:'1'},{GMGN_MARKET_DISCOVERY_MAX_CANDIDATES:'101'},
    {GMGN_MARKET_KLINE_COOLDOWN_SEC:'10'}])assert.throws(()=>readConfig(env));
});

test('runtime wires Trending, Trenches and compact Kline research without enabling entry or counting',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'gmgn-discovery-runtime-')),orders=join(directory,'orders.sqlite'),
    discovery=join(directory,'discovery.sqlite');
  const now=Math.floor(Date.now()/30_000)*30_000;
  const fetcher:typeof fetch=async input=>{
    const url=new URL(String(input));
    if(url.pathname==='/v1/market/rank')return response([{chain:'sol',address:mint,name:'Candidate',symbol:'CAN',rank:1,
      price:'0.00001',market_cap:'10000',smart_degen_count:2,renowned_count:1,creation_timestamp:Math.floor(now/1000)-60}]);
    if(url.pathname==='/v1/trenches')return response({new_creation:[{chain:'sol',address:mint,name:'Candidate',symbol:'CAN',
      price:'0.00001',market_cap:'10000',smart_degen_count:2,creation_timestamp:Math.floor(now/1000)-60}]});
    if(url.pathname==='/v1/market/token_kline'){
      const from=Number(url.searchParams.get('from')),first=Math.ceil(from/30_000)*30_000;
      return response({list:Array.from({length:3},(_,index)=>({time:first+index*30_000,open:'1',high:'1.2',low:'0.9',
        close:String(1+index/20),volume:'100',amount:'5000'}))});
    }
    throw new Error(`unexpected path ${url.pathname}`);
  };
  const config=readConfig({ENTRY_MODE:'off',THIRD_SIGNAL_EXECUTION_MODE:'simulation',GMGN_API_KEY:`discovery-${randomUUID()}`,
    GMGN_MIN_INTERVAL_MS:'100',SCANNER_CHAINS:'solana',SCANNER_ENABLED:'false',DASHBOARD_ENABLED:'false',
    WALLET_RESEARCH_ENABLED:'true',WALLET_HISTORY_DATABASE_PATH:join(directory,'wallet-history.sqlite'),
    WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',TOKEN_RANK_RESEARCH_ENABLED:'false',
    GMGN_MARKET_DISCOVERY_ENABLED:'true',GMGN_MARKET_DISCOVERY_DATABASE_PATH:discovery,
    GMGN_MARKET_DISCOVERY_INTERVAL_SEC:'30',GMGN_MARKET_DISCOVERY_MAX_CANDIDATES:'10',
    ORDERS_DATABASE_PATH:orders});
  const runtime=createRuntime(config,{gmgnFetcher:fetcher});
  try {
    assert.ok(runtime.gmgnMarketDiscovery);await runtime.gmgnMarketDiscovery.pollNow();
    // Scanner unit tests cover the production 30 s cadence. Reset only its
    // local slot clock here so this runtime wiring test can exercise the three
    // round-robin work classes without sleeping for a minute.
    (runtime.gmgnMarketDiscovery as unknown as {nextRemoteAt:number}).nextRemoteAt=0;
    await runtime.gmgnMarketDiscovery.pollNow();
    (runtime.gmgnMarketDiscovery as unknown as {nextRemoteAt:number}).nextRemoteAt=0;
    await runtime.gmgnMarketDiscovery.pollNow();
    const status=runtime.dashboardOverview().gmgnMarketDiscovery;
    assert.equal(status.enabled,true);assert.equal(status.researchOnly,true);assert.equal(status.entryPipeline,false);
    assert.equal(status.countingPipeline,false);assert.equal(status.notificationPipeline,false);
    assert.equal(status.feeds.trending.polls,1);assert.equal(status.feeds.trenches.polls,1);
    assert.deepEqual({received:status.feeds.trending.received,accepted:status.feeds.trending.accepted,
      rejected:status.feeds.trending.rejected,truncated:status.feeds.trending.truncated},{received:1,accepted:1,rejected:0,truncated:0});
    assert.deepEqual({received:status.feeds.trenches.received,accepted:status.feeds.trenches.accepted,
      rejected:status.feeds.trenches.rejected,truncated:status.feeds.trenches.truncated},{received:1,accepted:1,rejected:0,truncated:0});
    assert.equal(status.store.current,2);assert.equal(status.store.observations,2);
    assert.equal(status.store.lifecycleRegressions,0);
    assert.equal(status.store.klineObservations,1);assert.equal(status.klinePolls,1);
    assert.ok(runtime.walletHistory);assert.equal(runtime.walletHistory.stats().events,0);assert.equal(runtime.walletHistory.stats().prices,0);
    assert.deepEqual(runtime.walletHistory.watchTargets(1,new Date(now+1_000),'solana'),[{chain:'solana',address:mint}]);
    assert.equal(runtime.executionStatus().executionEnabled,false);
  } finally {await runtime.close();rmSync(directory,{recursive:true,force:true});}
});

test('runtime rejects a discovery database aliasing an execution database',()=>{
  const directory=mkdtempSync(join(tmpdir(),'gmgn-discovery-conflict-')),path=join(directory,'orders.sqlite');
  try {assert.throws(()=>createRuntime(readConfig({ORDERS_DATABASE_PATH:path,GMGN_MARKET_DISCOVERY_ENABLED:'true',
    GMGN_MARKET_DISCOVERY_DATABASE_PATH:path})),/GMGN_MARKET_DISCOVERY_DATABASE_MUST_BE_SEPARATE/);}
  finally {rmSync(directory,{recursive:true,force:true});}
});
