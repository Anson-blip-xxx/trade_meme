import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {
  GmgnMarketDiscoveryScanner,GmgnMarketDiscoveryStore,normalizeGmgnMarketTrenches,normalizeGmgnMarketTrending,
  type GmgnMarketDiscoveryCandidate,type GmgnMarketDiscoveryClient,type GmgnMarketDiscoveryObservedCandidate,
  type GmgnMarketKlineObservation,
} from '../src/gmgn-market-discovery.js';

const address=(seed:number)=>bs58.encode(Uint8Array.from({length:32},(_,index)=>(seed+index*17)%256));
const token=address(1),quote=address(2);
const at=new Date('2026-11-04T04:00:00.000Z');

function trendingRow(overrides:Record<string,unknown>={}):Record<string,unknown>{return {chain:'sol',address:token,name:' Alpha ',symbol:'ALPHA',
  launchpad_platform:'Pump.fun',quote_address:quote,quote_address_type:5,market_cap:'12345.5',price:'0.001',liquidity:'5000',
  smart_degen_count:'2',renowned_count:1,rank:3,hot_level:2,top_10_holder_rate:'0.21',rug_ratio:'0.1',is_wash_trading:false,
  creation_timestamp:1_793_782_000,...overrides};}

function trenchRow(overrides:Record<string,unknown>={}):Record<string,unknown>{return {chain:'sol',address:token,name:'Alpha',symbol:'ALPHA',
  quote_address:quote,quote_address_type:5,usd_market_cap:'22222',created_timestamp:1_793_782_000,progress:'0.8',
  smart_degen_count:3,renowned_count:2,bundler_trader_amount_rate:'0.12',has_at_least_one_social:true,...overrides};}

test('normalizes documented and live Trending envelopes with exact SOL identity',()=>{
  const page=normalizeGmgnMarketTrending({code:0,data:{rank:[trendingRow(),trendingRow({address:'0x1111111111111111111111111111111111111111'}),
    trendingRow({chain:'bsc'}),trendingRow({quote_address:'not-a-mint'})]}},{interval:'5m'});
  assert.equal(page.received,4);assert.equal(page.accepted,1);assert.equal(page.rejected,3);
  assert.deepEqual(page.records[0],{
    chain:'sol',address:token,feed:'trending',window:'5m',category:'trending',name:'Alpha',symbol:'ALPHA',
    launchpadPlatform:'Pump.fun',quoteAddress:quote,quoteAddressType:'5',createdTimestamp:1_793_782_000,price:.001,
    marketCap:12345.5,liquidity:5000,rank:3,hotLevel:2,smartDegenCount:2,renownedCount:1,top10HolderRate:.21,
    rugRatio:.1,washTrading:false,
  });
  assert.equal(normalizeGmgnMarketTrending({rank:[trendingRow()]}).accepted,1);
  assert.equal(normalizeGmgnMarketTrending([trendingRow()]).accepted,1);
  const duplicate=normalizeGmgnMarketTrending({data:{rank:[trendingRow(),trendingRow({rank:99})]}});
  assert.equal(duplicate.accepted,1);assert.equal(duplicate.deduplicated,1);assert.equal(duplicate.rejected,0);
  assert.equal(duplicate.records[0].rank,3);
});

test('bounds Trending rows, text, numbers and rejects deceptive quote addresses',()=>{
  const rows=Array.from({length:12},(_,index)=>trendingRow({address:address(index+20),name:`${'x'.repeat(200)}\u0000`,
    rug_ratio:index===0?'Infinity':'0.2',holder_count:index===0?1e20:'10'}));
  const page=normalizeGmgnMarketTrending({data:{rank:rows}},{maxRows:5});
  assert.equal(page.received,12);assert.equal(page.accepted,5);assert.equal(page.truncated,7);
  assert.equal(page.records[0].name?.length,160);assert.equal(page.records[0].rugRatio,undefined);assert.equal(page.records[0].holderCount,undefined);
});

test('accepts explicit empty market pages but rejects fixed invalid schemas',()=>{
  assert.equal(normalizeGmgnMarketTrending({data:{rank:[]}}).received,0);
  assert.equal(normalizeGmgnMarketTrenches({data:{new_creation:[],pump:[],completed:[]}}).received,0);
  for(const payload of [{},{data:{}},{code:500,message:'error'},{data:{rank:null}},null])
    assert.throws(()=>normalizeGmgnMarketTrending(payload),/^Error: GMGN_MARKET_TRENDING_SCHEMA_INVALID$/);
  for(const payload of [{},{data:{}},{code:500,message:'error'},{data:{new_creation:null}},null])
    assert.throws(()=>normalizeGmgnMarketTrenches(payload),/^Error: GMGN_MARKET_TRENCHES_SCHEMA_INVALID$/);
});

test('normalizes actual near_completion and documented pump/data.pump Trenches variants',()=>{
  const actual=normalizeGmgnMarketTrenches({completed:[],near_completion:[trenchRow()],new_creation:[]});
  const documented=normalizeGmgnMarketTrenches({data:{new_creation:[],pump:[trenchRow()],completed:[]}});
  const directPump=normalizeGmgnMarketTrenches({pump:[trenchRow()]});
  for(const page of [actual,documented,directPump]){
    assert.equal(page.accepted,1);assert.equal(page.records[0].category,'near_completion');assert.equal(page.records[0].marketCap,22222);
    assert.equal(page.records[0].bundlerRate,.12);assert.equal(page.records[0].quoteAddress,quote);assert.equal(page.records[0].quoteAddressType,'5');
  }
});

test('Trenches hard-limits every category and selects the most advanced duplicate lifecycle',()=>{
  const many=Array.from({length:95},(_,index)=>trenchRow({address:address(index+40)}));
  const page=normalizeGmgnMarketTrenches({new_creation:[trenchRow(),...many],pump:[trenchRow()],completed:[trenchRow()]},
    {maxRows:12,maxRowsPerCategory:10});
  assert.ok(page.received>90);assert.ok(page.truncated>80);assert.ok(page.records.length<=12);
  assert.ok(page.deduplicated>=2);
  assert.equal(page.received,page.accepted+page.deduplicated+page.rejected+page.truncated);
  assert.equal(page.records.find(row=>row.address===token)?.category,'completed');
});

test('Trenches total limit reserves capacity fairly across active lifecycle stages',()=>{
  const rows=(seed:number)=>Array.from({length:8},(_,index)=>trenchRow({address:address(seed+index)}));
  const page=normalizeGmgnMarketTrenches({new_creation:rows(40),near_completion:rows(80),completed:rows(120)},
    {maxRows:6,maxRowsPerCategory:8});
  assert.equal(page.records.length,6);
  assert.deepEqual(Object.fromEntries(['new_creation','near_completion','completed'].map(category=>
    [category,page.records.filter(record=>record.category===category).length])),{new_creation:2,near_completion:2,completed:2});
  assert.equal(page.truncated,18);
});

test('store deduplicates compact snapshots and emits research-only transitions',()=>{
  const directory=mkdtempSync(join(tmpdir(),'gmd-store-')),path=join(directory,'nested','discovery.sqlite'),
    store=new GmgnMarketDiscoveryStore({path,maxBytes:4*1024*1024,now:()=>at,maxObservations:100});
  try{
    const first=store.apply(normalizeGmgnMarketTrenches({new_creation:[trenchRow()]}),at);
    assert.equal(first.inserted,1);assert.equal(first.events[0].kind,'first_seen');assert.equal(first.events[0].entryPipeline,false);
    assert.deepEqual(first.continuityLostFeeds,[]);assert.equal(store.status().pendingCandidateDeliveries,0);
    assert.equal(first.events[0].countingPipeline,false);assert.equal(first.events[0].notificationPipeline,false);
    const duplicate=store.apply(normalizeGmgnMarketTrenches({new_creation:[trenchRow()]}),new Date(at.getTime()+1_000));
    assert.deepEqual({inserted:duplicate.inserted,unchanged:duplicate.unchanged,events:duplicate.events.length},{inserted:0,unchanged:1,events:0});
    const smart=store.apply(normalizeGmgnMarketTrenches({new_creation:[trenchRow({smart_degen_count:7})]}),new Date(at.getTime()+2_000));
    assert.equal(smart.events[0].kind,'updated');assert.equal(smart.events[0].smartDegenDelta,4);assert.equal(smart.events[0].walletTrackingRecommended,true);
    const transition=store.apply(normalizeGmgnMarketTrenches({data:{pump:[trenchRow({smart_degen_count:7})]}}),new Date(at.getTime()+3_000));
    assert.equal(transition.events[0].kind,'category_transition');assert.equal(transition.events[0].previousCategory,'new_creation');
    assert.equal(transition.events[0].category,'near_completion');
    const completed=store.apply(normalizeGmgnMarketTrenches({completed:[trenchRow({smart_degen_count:7})]}),new Date(at.getTime()+4_000));
    assert.equal(completed.events[0].kind,'category_transition');assert.equal(completed.events[0].category,'completed');
    const recurrence=store.apply(normalizeGmgnMarketTrenches({new_creation:[trenchRow({smart_degen_count:7})]}),new Date(at.getTime()+5_000));
    assert.equal(recurrence.inserted,0);assert.equal(recurrence.unchanged,1);assert.equal(recurrence.events.length,0);
    const status=store.status();assert.equal(status.current,1);assert.equal(status.observations,4);assert.equal(status.rawPayloadStored,false);
    assert.equal(status.lifecycleRegressions,1);assert.equal(status.lastLifecycleRegressionAt,new Date(at.getTime()+5_000).toISOString());
    assert.equal(statSync(path).mode&0o777,0o600);
    const db=new DatabaseSync(path,{readOnly:true});try{
      assert.equal(db.prepare('SELECT category FROM gmd_current WHERE token_address=?').get(token)!.category,'completed');
      const schema=db.prepare("SELECT group_concat(sql,' ') AS sql FROM sqlite_master WHERE name LIKE 'gmd_%'").get()!.sql;
      assert.doesNotMatch(String(schema),/raw_(?:json|payload)/i);
      assert.doesNotMatch(String(db.prepare('SELECT data_json FROM gmd_observations LIMIT 1').get()!.data_json),/secret|apikey|cookie/i);
    }finally{db.close();}
  }finally{store.close();}
});

test('store persists only compact Kline momentum and diagnostics, never candles or raw payload',()=>{
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:2*1024*1024,maxObservations:100,now:()=>at});
  try{
    const observation:GmgnMarketKlineObservation={chain:'solana',tokenAddress:token,nominatedAt:'2026-11-04T03:50:00.000Z',
      observedAt:at.toISOString(),reason:'debot',resolution:'30s',fromAt:'2026-11-04T03:50:00.000Z',untilAt:'2026-11-04T03:59:30.000Z',
      coverage:{leadingGapSec:0,trailingGapSec:0,dense:true},diagnostics:{inputRows:20,invalidRows:0,outsideRows:0,openRows:1,
        duplicateRows:0,conflictRows:0},momentum:{asOf:at.toISOString(),candles:19,fromAt:'2026-11-04T03:50:00.000Z',
        untilAt:'2026-11-04T03:59:30.000Z',changePct:23,drawdownFromHighPct:4,meanRangePct:5,dense:true},
      researchOnly:true,priceRouter:false,entryPipeline:false,countingPipeline:false};
    assert.equal(store.recordKline(observation),'inserted');assert.equal(store.recordKline(observation),'duplicate');
    const status=store.status();assert.equal(status.klineObservations,1);assert.equal(status.lastKlineAt,at.toISOString());
  }finally{store.close();}
});

test('scanner uses bounded background scheduling, persists candidates and keeps callbacks out of signal pipelines',async()=>{
  let now=new Date(at),trendingCalls=0,trenchesCalls=0;const schedules:unknown[]=[],events:GmgnMarketDiscoveryCandidate[]=[];
  const client:GmgnMarketDiscoveryClient={
    async getMarketTrending(_chain,options,scheduling){trendingCalls++;assert.deepEqual(options,{interval:'1m',limit:7});schedules.push(scheduling);
      return {data:{rank:[trendingRow()]}};},
    async getMarketTrenches(_chain,options,scheduling){trenchesCalls++;assert.deepEqual(options,{categories:['new_creation','near_completion','completed'],limit:7});
      schedules.push(scheduling);return {near_completion:[trenchRow()]};},
  };
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:2*1024*1024,maxObservations:100,now:()=>now}),
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:7,now:()=>now,onCandidate:event=>events.push(event)});
  try{
    await scanner.pollNow();assert.equal(trendingCalls,1);assert.equal(trenchesCalls,0);assert.equal(events.length,1);
    // A second due feed cannot create another remote request in the same
    // controlled 30-second slot.
    await scanner.pollNow();assert.equal(trendingCalls,1);assert.equal(trenchesCalls,0);
    now=new Date(now.getTime()+30_001);await scanner.pollNow();
    assert.equal(trendingCalls,1);assert.equal(trenchesCalls,1);assert.equal(events.length,2);
    assert.ok(events.every(event=>event.entryPipeline===false&&event.countingPipeline===false&&event.notificationPipeline===false));
    now=new Date(now.getTime()+30_001);await scanner.pollNow();
    now=new Date(now.getTime()+30_001);await scanner.pollNow();
    assert.equal(trendingCalls,2);assert.equal(trenchesCalls,2);
    assert.deepEqual(schedules,Array.from({length:4},()=>({priority:'background',queueTimeoutMs:10_000})));
    const status=scanner.status();assert.equal(status.store.observations,2);
    assert.equal(status.remoteMinIntervalMs,30_000);assert.equal(status.nextRemoteAt,new Date(now.getTime()+30_000).toISOString());
    assert.deepEqual({received:status.feeds.trending.received,accepted:status.feeds.trending.accepted,deduplicated:status.feeds.trending.deduplicated,
      rejected:status.feeds.trending.rejected,truncated:status.feeds.trending.truncated},
      {received:2,accepted:2,deduplicated:0,rejected:0,truncated:0});
  }finally{scanner.stop();store.close();}
});

test('scanner marks first and interrupted successful feed observations as left-censored, then restores a bounded interval',async()=>{
  let now=new Date(at),trendingCalls=0;const events:GmgnMarketDiscoveryObservedCandidate[]=[];
  const second=address(30),third=address(31),client:GmgnMarketDiscoveryClient={
    async getMarketTrending(){trendingCalls++;now=new Date(now.getTime()+2_000);
      if(trendingCalls===2)throw new Error('temporary feed failure');
      const rows=[trendingRow()];if(trendingCalls>=3)rows.push(trendingRow({address:second}));
      if(trendingCalls>=4)rows.push(trendingRow({address:third}));return {rank:rows};},
    async getMarketTrenches(){return {new_creation:[],near_completion:[],completed:[]};},
  };
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:2*1024*1024,maxObservations:100,now:()=>now}),
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:7,now:()=>now,onCandidate:event=>events.push(event)});
  const poll=async()=>{await scanner.pollNow();now=new Date(now.getTime()+30_001);};
  try{
    await poll(); // first Trending success
    await poll(); // Trenches
    await poll(); // failed Trending
    await poll(); // Trenches
    await poll(); // recovered Trending
    await poll(); // Trenches
    await poll(); // consecutive Trending success
    assert.equal(events.length,3);
    assert.equal(events[0].observedAt,new Date(at.getTime()+2_000).toISOString(),'upper bound uses response receipt, not request start');
    assert.deepEqual({token:events[0].tokenAddress,previous:events[0].previousSuccessfulPollAt,leftCensored:events[0].leftCensored},
      {token,previous:undefined,leftCensored:true});
    assert.deepEqual({token:events[1].tokenAddress,previous:events[1].previousSuccessfulPollAt,leftCensored:events[1].leftCensored},
      {token:second,previous:events[0].observedAt,leftCensored:true});
    assert.deepEqual({token:events[2].tokenAddress,previous:events[2].previousSuccessfulPollAt,leftCensored:events[2].leftCensored},
      {token:third,previous:events[1].observedAt,leftCensored:false});
  }finally{scanner.stop();store.close();}
});

test('capacity rollback breaks feed continuity and recovery first-seen observations remain left-censored',async()=>{
  let now=new Date(at),trendingCalls=0;const events:GmgnMarketDiscoveryObservedCandidate[]=[],second=address(32),third=address(33);
  const client:GmgnMarketDiscoveryClient={
    async getMarketTrending(){trendingCalls++;const rows=[trendingRow()];if(trendingCalls>=2)rows.push(trendingRow({address:second}));
      if(trendingCalls>=3)rows.push(trendingRow({address:third}));return {rank:rows};},
    async getMarketTrenches(){return {new_creation:[],near_completion:[],completed:[]};},
  };
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:2*1024*1024,maxObservations:100,now:()=>now}),
    apply=store.apply.bind(store);let rejectNextTrending=true;
  store.apply=((page,observedAt,delivery)=>{
    if(page.feed==='trending'&&trendingCalls===2&&rejectNextTrending){rejectNextTrending=false;
      return {received:page.records.length,inserted:0,unchanged:0,capacityReached:true,events:[],continuityLostFeeds:[]};}
    return apply(page,observedAt,delivery);
  }) as typeof store.apply;
  const scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:7,now:()=>now,onCandidate:event=>events.push(event)}),
    poll=async()=>{await scanner.pollNow();now=new Date(now.getTime()+30_001);};
  try{
    await poll();await poll();await poll();
    const capacityStatus=scanner.status().feeds.trending;
    assert.equal(capacityStatus.errors,1);
    assert.equal(capacityStatus.lastError,'GMGN_MARKET_DISCOVERY_STORE_CAPACITY');
    assert.equal(capacityStatus.lastSuccessAt,at.toISOString(),'a rejected store write is not a successful feed boundary');
    assert.equal(store.continuityLost('trending'),true);
    await poll();await poll();
    assert.equal(trendingCalls,3);assert.equal(events.filter(event=>event.feed==='trending').length,3);
    const recovered=events.filter(event=>[second,third].includes(event.tokenAddress));
    assert.equal(recovered.length,2);assert.ok(recovered.every(event=>event.leftCensored));
    assert.equal(store.continuityLost('trending'),false);
  }finally{scanner.stop();store.close();}
});

test('current snapshot eviction durably breaks only the affected feed continuity before the next baseline',async()=>{
  let now=new Date(at),trendingCalls=0;const events:GmgnMarketDiscoveryObservedCandidate[]=[],second=address(34),
    rows=(seed:number)=>Array.from({length:50},(_,index)=>trenchRow({address:address(seed+index)}));
  const client:GmgnMarketDiscoveryClient={
    async getMarketTrending(){trendingCalls++;return {rank:[trendingRow(),...(trendingCalls>=2?[trendingRow({address:second})]:[])]};},
    async getMarketTrenches(){return {new_creation:rows(50),near_completion:rows(110),completed:rows(170)};},
  };
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:4*1024*1024,maxObservations:100,now:()=>now}),
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:120,now:()=>now,onCandidate:event=>events.push(event)}),
    poll=async()=>{await scanner.pollNow();now=new Date(now.getTime()+30_001);};
  try{
    await poll();await poll();
    assert.equal(store.continuityLost('trending'),true);assert.equal(store.continuityLost('trenches'),true);
    await poll();
    const recovered=events.filter(event=>event.feed==='trending'&&[token,second].includes(event.tokenAddress)&&event.observedAt>at.toISOString());
    assert.equal(recovered.length,2);assert.ok(recovered.every(event=>event.leftCensored));
    assert.equal(store.continuityLost('trending'),false);
  }finally{scanner.stop();store.close();}
});

test('first-seen callback failures remain in a durable outbox and replay exactly after restart',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'gmd-outbox-')),path=join(directory,'discovery.sqlite');let now=new Date(at);
  const client:GmgnMarketDiscoveryClient={async getMarketTrending(){return {rank:[trendingRow()]};},
    async getMarketTrenches(){return {new_creation:[],near_completion:[],completed:[]};}};
  let store=new GmgnMarketDiscoveryStore({path,maxBytes:4*1024*1024,maxObservations:100,now:()=>now}),
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:7,now:()=>now,
      onCandidate(){assert.equal(store.status().pendingCandidateDeliveries,1,'the relay must remain pending while its callback runs');
        throw new Error('downstream unavailable');}});
  try{
    await scanner.pollNow();assert.equal(scanner.status().candidateErrors,1);assert.equal(store.status().pendingCandidateDeliveries,1);
    scanner.stop();store.close();now=new Date(now.getTime()+30_001);
    const replayed:GmgnMarketDiscoveryObservedCandidate[]=[];store=new GmgnMarketDiscoveryStore({path,maxBytes:4*1024*1024,maxObservations:100,now:()=>now});
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:7,now:()=>now,onCandidate:event=>{
      assert.equal(store.status().pendingCandidateDeliveries,1,'ack follows callback success');replayed.push(event);}});
    await scanner.pollNow();assert.equal(replayed.length,1);assert.equal(replayed[0].tokenAddress,token);
    assert.equal(replayed[0].kind,'first_seen');assert.equal(replayed[0].leftCensored,true);
    assert.equal(store.status().pendingCandidateDeliveries,0);
  }finally{scanner.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('scanner records invalid feed schemas as errors rather than successful empty polls',async()=>{
  const client:GmgnMarketDiscoveryClient={
    async getMarketTrending(){return {code:0,data:{}};},
    async getMarketTrenches(){return {new_creation:[],near_completion:[],completed:[]};},
  };
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:2*1024*1024,maxObservations:100,now:()=>at}),
    scannerNow={value:new Date(at)},scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:5,
      now:()=>scannerNow.value});
  try{
    await scanner.pollNow();let status=scanner.status();
    assert.equal(status.feeds.trending.errors,1);assert.equal(status.feeds.trending.lastSuccessAt,undefined);
    assert.equal(status.feeds.trending.lastError,'GMGN_MARKET_TRENDING_SCHEMA_INVALID');
    assert.equal(status.feeds.trenches.polls,0);
    scannerNow.value=new Date(scannerNow.value.getTime()+30_001);await scanner.pollNow();status=scanner.status();
    assert.equal(status.feeds.trenches.errors,0);assert.equal(status.feeds.trenches.lastSuccessAt,scannerNow.value.toISOString());
  }finally{scanner.stop();store.close();}
});

test('nominate queues a closed-candle Kline research pass with cooldown and no live price route',async()=>{
  let now=new Date(at);const klines:GmgnMarketKlineObservation[]=[];
  const client:GmgnMarketDiscoveryClient={
    async getMarketTrending(){return {rank:[]};},async getMarketTrenches(){return {new_creation:[]};},
    async getMarketKline(_chain,_address,options,scheduling){assert.equal(scheduling.priority,'background');
      const first=Math.ceil(options.from/30)*30,rows=[] as Record<string,unknown>[];
      for(let time=first;time+30<=options.to;time+=30)rows.push({time:time*1_000,open:'1',high:'1.2',low:'0.9',close:'1.1',volume:'20',amount:'22'});
      // This open candle must be rejected by normalizeGmgnKline.
      rows.push({time:(options.to-15)*1_000,open:'1.1',high:'9',low:'0.1',close:'2',volume:'99',amount:'99'});return {list:rows};},
  };
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:2*1024*1024,maxObservations:100,now:()=>now}),
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:10,klineCooldownMs:30_000,now:()=>now,onKline:value=>klines.push(value)});
  try{
    assert.equal(scanner.nominate({chain:'solana',address:token},new Date(now.getTime()-10*60_000),'debot'),true);
    assert.equal(scanner.nominate({chain:'solana',address:token},now,'duplicate'),false);
    await scanner.pollNow();now=new Date(now.getTime()+30_001);await scanner.pollNow();
    now=new Date(now.getTime()+30_001);await scanner.pollNow();
    assert.equal(klines.length,1);assert.equal(klines[0].priceRouter,false);assert.ok(klines[0].momentum);
    assert.equal(klines[0].diagnostics.openRows,1);assert.equal('candles' in klines[0],false);assert.equal(store.status().klineObservations,1);
    assert.equal(scanner.nominate({chain:'sol',address:token},now,'too soon'),false);
    now=new Date(now.getTime()+30_001);assert.equal(scanner.nominate({chain:'sol',address:token},now,'market_signal'),true);
  }finally{scanner.stop();store.close();}
});

test('Kline store rejection is exposed as capacity failure and retains nomination for retry',async()=>{
  let now=new Date(at),callbacks=0;
  const client:GmgnMarketDiscoveryClient={
    async getMarketTrending(){return {rank:[]};},async getMarketTrenches(){return {new_creation:[]};},
    async getMarketKline(_chain,_address,options){return {list:[
      {time:options.from*1_000,open:'1',high:'1.1',low:'0.9',close:'1'},
    ]};},
  };
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:2*1024*1024,maxObservations:100,now:()=>now});
  (store as unknown as {recordKline:()=>never}).recordKline=()=>{throw new Error('GMGN_MARKET_DISCOVERY_KLINE_STORE_CAPACITY');};
  const scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:5,now:()=>now,onKline:()=>{callbacks++;}});
  try{
    assert.equal(scanner.nominate({chain:'solana',address:token},new Date(now.getTime()-60_000),'capacity-test'),true);
    await scanner.pollNow();now=new Date(now.getTime()+30_001);await scanner.pollNow();
    now=new Date(now.getTime()+30_001);await scanner.pollNow();let status=scanner.status();
    assert.equal(status.klinePolls,1);assert.equal(status.klineSuccesses,0);assert.equal(status.klineErrors,1);
    assert.equal(status.klineStoreCapacityErrors,1);assert.equal(status.lastKlineError,'GMGN_MARKET_DISCOVERY_KLINE_STORE_CAPACITY');
    assert.equal(status.lastKlineAt,undefined);assert.equal(status.nominations,1);assert.equal(callbacks,0);
    // Trending and Trenches each receive their next round-robin slot before
    // the retained Kline nomination is retried.
    for(let index=0;index<3;index++){now=new Date(now.getTime()+30_001);await scanner.pollNow();}
    status=scanner.status();
    assert.equal(status.klinePolls,2);assert.equal(status.klineSuccesses,0);assert.equal(status.nominations,1);
  }finally{scanner.stop();store.close();}
});

test('Kline queue prioritizes source signals, evicts lower research work and starts at most once per 30 seconds',async()=>{
  let now=new Date(at);const requested:string[]=[];
  const client:GmgnMarketDiscoveryClient={
    async getMarketTrending(){return {rank:[]};},async getMarketTrenches(){return {new_creation:[]};},
    async getMarketKline(_chain,tokenAddress){requested.push(tokenAddress);return {list:[]};},
  };
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:2*1024*1024,maxObservations:100,now:()=>now}),
    scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:1,now:()=>now});
  try {
    const low=[address(20),address(21),address(22),address(23)];
    for(const value of low)assert.equal(scanner.nominate({chain:'sol',address:value},new Date(now.getTime()-60_000),'discovery_trending_first_seen_wallets'),true);
    const high=address(24);assert.equal(scanner.nominate({chain:'sol',address:high},new Date(now.getTime()-60_000),'source_debot'),true);
    assert.equal(scanner.nominate({chain:'sol',address:address(25)},new Date(now.getTime()-60_000),'external_signal'),false);
    let status=scanner.status();assert.equal(status.nominations,4);assert.equal(status.nominationEvictions,1);assert.equal(status.nominationRejected,1);
    await scanner.pollNow();now=new Date(now.getTime()+30_001);await scanner.pollNow();
    now=new Date(now.getTime()+30_001);await scanner.pollNow();assert.deepEqual(requested,[high]);
    await scanner.pollNow();assert.deepEqual(requested,[high]);
    for(let index=0;index<3;index++){now=new Date(now.getTime()+30_001);await scanner.pollNow();}
    assert.equal(requested.length,2);
    status=scanner.status();assert.equal(status.klinePolls,2);assert.equal(status.klineMinIntervalMs,30_000);
  } finally {scanner.stop();store.close();}
});

test('duplicate Kline persistence completes nomination idempotently without callback or capacity error',async()=>{
  let now=new Date(at);
  const client:GmgnMarketDiscoveryClient={
    async getMarketTrending(){return {rank:[]};},async getMarketTrenches(){return {new_creation:[]};},
    async getMarketKline(_chain,_address,options){return {list:[
      {time:options.from*1_000,open:'1',high:'1.1',low:'0.9',close:'1'},
    ]};},
  };
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:2*1024*1024,maxObservations:100,now:()=>now});
  (store as unknown as {recordKline:()=>string}).recordKline=()=> 'duplicate';
  let callbacks=0;const scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:5,now:()=>now,onKline:()=>{callbacks++;}});
  try{
    assert.equal(scanner.nominate({chain:'sol',address:token},new Date(at.getTime()-60_000),'duplicate-test'),true);
    await scanner.pollNow();
    now=new Date(at.getTime()+30_001);await scanner.pollNow();
    now=new Date(now.getTime()+30_001);await scanner.pollNow();const status=scanner.status();
    assert.equal(status.nominations,0);assert.equal(status.klinePolls,1);assert.equal(status.klineSuccesses,0);
    assert.equal(status.klineDuplicates,1);assert.equal(status.klineErrors,0);assert.equal(status.klineStoreCapacityErrors,0);
    assert.equal(callbacks,0);
  }finally{scanner.stop();store.close();}
});

test('invalid scanner configuration and nominations fail closed',()=>{
  const store=new GmgnMarketDiscoveryStore({path:':memory:',maxBytes:2*1024*1024,maxObservations:100});
  const client:GmgnMarketDiscoveryClient={async getMarketTrending(){return [];},async getMarketTrenches(){return {};}};
  try{
    assert.throws(()=>new GmgnMarketDiscoveryScanner({client,store,intervalMs:999,maxCandidates:1}),/CONFIG_INVALID/);
    const scanner=new GmgnMarketDiscoveryScanner({client,store,intervalMs:1_000,maxCandidates:1});
    assert.equal(scanner.nominate({chain:'sol',address:'not-an-address'},at,'x'),false);
    assert.equal(scanner.nominate({chain:'sol',address:token},'bad-date','x'),false);
  }finally{store.close();}
});
