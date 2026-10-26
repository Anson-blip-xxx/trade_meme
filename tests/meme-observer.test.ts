import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MemeObserver,type MemeObserverOptions} from '../src/meme-observer.js';
import {assessMeme} from '../src/meme-assessment.js';
import {SourceCorroboration} from '../src/source-corroboration.js';
import {buildReviewSamplingPlan,writeReviewSamplingPlan} from '../src/review-sampling.js';
import type {MemeMarketSample,MemeAssessment,MemeCatalystSnapshot} from '../src/meme-assessment.js';
import type {Signal,Report,Check} from '../src/types.js';

const origin=Date.parse('2026-10-16T09:00:00.000Z'),at=(sec=0)=>new Date(origin+sec*1000).toISOString();
const address=(n=1)=>`0x${n.toString(16).padStart(40,'0')}`,token=(n=1,chain:Signal['token']['chain']='bsc')=>({chain,address:address(n)});
const signal=(n=1,sec=0,chain:Signal['token']['chain']='bsc',id=`event-${n}`):Signal=>({source:'debot',sourceEventId:id,token:token(n,chain),occurredAt:at(sec),text:'research signal',claim:'unspecified',evidenceUrls:[]});
function market(target=token(),sec=0,price=1,overrides:Partial<MemeMarketSample>={}):MemeMarketSample {
  return {version:1,token:target,source:'dexscreener_pair',observedAt:at(sec),priceUsd:price,liquidityUsd:50000,poolAddress:address(1000),
    windows:{'5m':{buys:80,sells:20,volumeUsd:20000}},...overrides};
}
function catalyst(target=token(),sec=0):MemeCatalystSnapshot {
  return {token:target,observedAt:at(sec),expiresAt:at(sec+600),status:'unknown',reasons:['TEST_NO_POSTS'],sourceTweetCount:0,posts:[],
    diffusion:{status:'unknown',coverage:'sampled',windowStart:at(sec-600),windowEnd:at(sec),postCount:0,independentAuthorCount:0,caPostCount:0,caAuthorCount:0,recent5m:{postCount:0,authorCount:0},previous5m:{postCount:0,authorCount:0}},
    celebrities:{status:'unknown',signals:[],endorsementVerified:false,accountIdentityCoverage:'unverified'},
    evidence:{requestedPostCount:0,retrievedPostCount:0,diagnostics:[],narrativeStatus:'unknown',narrativeReasons:[],limitations:[]}};
}
function report(sec=0):Report {
  const check:Check={status:'fail',reasons:['TEST_SAFETY_FAILED'],checkedAt:at(sec),facts:{}};
  return {id:'test-report',policyVersion:'test',mode:'live',signal:signal(1,sec),receivedAt:at(sec),evaluatedAt:at(sec),validUntil:at(sec+30),decision:'REJECT',
    buyEligible:false,executionEnabled:false,reasons:['TEST_SAFETY_FAILED'],safety:check,provenance:check,narrative:{...check,evidence:[]}};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function fixture(overrides:Partial<MemeObserverOptions>={}){
  const directory=mkdtempSync(join(tmpdir(),'meme-observer-')),database=join(directory,'observer.sqlite');let current=0;
  const observers:MemeObserver[]=[],calls:Signal['token'][][]=[];
  const options:MemeObserverOptions={database,now:()=>new Date(at(current)),marketBatch:async(tokens)=>{calls.push(tokens);return tokens.map(t=>market(t,current));},...overrides};
  const create=()=>{const observer=new MemeObserver(options);observers.push(observer);return observer;};
  const rows=(table='meme_snapshots')=>{const db=new DatabaseSync(database,{readOnly:true});try{return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();}finally{db.close();}};
  return {create,options,calls,rows,now:()=>current,advance:(sec:number)=>{current=sec;},close:async()=>{for(const observer of observers)await observer.close();rmSync(directory,{recursive:true,force:true});}};
}

test('SOL-only restart filters research before the active limit and preserves disabled-chain history',async()=>{
  const f=fixture({maxActive:1}),requests:Signal['token'][][]=[],catalysts:Signal['token'][]=[];
  const sol:Signal={...signal(10),token:{chain:'solana',address:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'}};
  try {
    const original=f.create();original.register(sol);original.captureReport(report());
    f.advance(1);original.register(signal(1,1,'bsc','bsc-new'));original.register(signal(2,1,'robinhood'));
    const historical=f.rows('meme_tokens').filter(row=>row.chain!=='solana'),eventCount=f.rows('meme_signals').length;
    await original.close();f.options.allowedChains=['solana'];
    f.options.marketBatch=async tokens=>{requests.push(tokens);return [];};
    f.options.catalyst=async input=>{catalysts.push(input.token);return catalyst(input.token,f.now());};
    const restricted=f.create();f.advance(2);
    assert.equal(restricted.register(signal(1,2,'bsc','blocked-new-bsc')),false);
    assert.equal(restricted.register(signal(2,2,'robinhood','blocked-new-robinhood')),false);
    restricted.captureReport(report(2));
    await restricted.runOnce();await restricted.runCatalystOnce();
    assert.deepEqual(requests.map(batch=>batch.map(({chain,address})=>({chain,address}))),[[sol.token]]);
    assert.deepEqual(catalysts,[sol.token]);
    assert.equal(f.rows('meme_signals').length,eventCount);
    assert.deepEqual(f.rows('meme_tokens').filter(row=>row.chain!=='solana'),historical);
    assert.equal(restricted.list().total,3);assert.ok(restricted.detail(token()).token);
    assert.deepEqual(restricted.status().activeChains,['solana']);
    assert.equal(restricted.status().active,1);assert.equal(restricted.status().waiting,0);
  }finally{await f.close();}
});

test('status recent-window count uses the chain and signal-time covering index',async()=>{
  const f=fixture({allowedChains:['solana']});
  try {
    const observer=f.create();observer.register({...signal(),token:{chain:'solana',address:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'}});
    assert.equal(observer.status().active,1);
    const db=new DatabaseSync(f.options.database,{readOnly:true});try {
      const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT count(*) AS n FROM meme_tokens
        WHERE last_signal_at>=? AND chain IN (?)`).all(at(-7200),'solana').map(row=>String(row.detail)).join(' ');
      assert.match(plan,/USING COVERING INDEX meme_tokens_chain_signal/);
    }finally{db.close();}
  }finally{await f.close();}
});

test('runtime status remains a database-free scalar snapshot for HTTP composition',async()=>{
  const f=fixture();try {
    const observer=f.create();observer.register(signal());await observer.close();
    const status=observer.runtimeStatus();assert.equal(status.enabled,true);assert.equal(status.maxActive,180);
    assert.equal(status.samplingPlan.reason,'DASHBOARD_QUERY_PENDING');
    assert.throws(()=>observer.status());
  }finally{await f.close();}
});

test('list pagination uses first-seen ordering indexes without a temporary sort',async()=>{
  const f=fixture();
  try {
    const observer=f.create();observer.register(signal());
    const db=new DatabaseSync(f.options.database,{readOnly:true});try {
      const plans=[
        db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM meme_tokens WHERE first_seen_at<=?
          ORDER BY first_seen_at DESC,chain,address LIMIT ? OFFSET ?`).all(at(),20,0),
        db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM meme_tokens WHERE first_seen_at<=? AND chain=?
          ORDER BY first_seen_at DESC,chain,address LIMIT ? OFFSET ?`).all(at(),'bsc',20,0),
      ].map(rows=>rows.map(row=>String(row.detail)).join(' '));
      assert.match(plans[0],/meme_tokens_first_seen/);
      assert.match(plans[1],/meme_tokens_chain_first_seen/);
      for(const plan of plans)assert.doesNotMatch(plan,/USE TEMP B-TREE/);
    }finally{db.close();}
  }finally{await f.close();}
});

test('SOL-only fair and priority sampling pools exclude more than 600 disabled-chain candidates before LIMIT',async()=>{
  const f=fixture({maxActive:2}),requests:Signal['token'][][]=[],catalysts:Signal['token'][]=[];
  const sols:Signal[]=['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263','So11111111111111111111111111111111111111112']
    .map((address,i)=>({...signal(1000+i,1),token:{chain:'solana',address}}));
  try {
    const original=f.create();for(let i=1;i<=601;i++)original.register(signal(i));
    original.register(signal(602,0,'robinhood'));f.advance(1);sols.forEach(input=>original.register(input));
    await original.close();f.options.allowedChains=['solana'];f.options.samplingPlanPath=f.options.database+'.sampling.json';
    writeReviewSamplingPlan(f.options.samplingPlanPath,buildReviewSamplingPlan({asOf:at(),windowEndAt:at(-3600),cohorts:[
      {chain:'bsc',source:'debot',total:601,covered:0},{chain:'robinhood',source:'debot',total:1,covered:0},
      {chain:'solana',source:'debot',total:2,covered:1}]}));
    f.options.marketBatch=async tokens=>{requests.push(tokens);return [];};
    f.options.catalyst=async input=>{catalysts.push(input.token);return catalyst(input.token,f.now());};
    const restricted=f.create();await restricted.runOnce();await restricted.runCatalystOnce();
    assert.equal(requests.length,1);assert.deepEqual(new Set(requests[0].map(t=>t.address)),new Set(sols.map(s=>s.token.address)));
    assert.equal(requests[0].every(t=>t.chain==='solana'),true);assert.equal(catalysts.length,1);assert.equal(catalysts[0].chain,'solana');
    assert.equal(restricted.status().active,2);assert.equal(restricted.status().waiting,0);assert.equal(restricted.list().total,604);
    assert.equal(restricted.status().samplingPlan.status,'active');
    const selections=f.rows('meme_sampling_selections');assert.ok(selections.length>=2);
    assert.equal(selections.every(row=>row.chain==='solana'),true);
    assert.ok(selections.some(row=>row.reason==='FAIR_ROTATION'));assert.ok(selections.some(row=>row.reason==='COVERAGE_DEFICIT'));
  }finally{await f.close();}
});

test('market callback receives only committed sanitized new samples and cannot roll back collection',async()=>{
  const seen:MemeMarketSample[]=[];let fail=true;
  const f=fixture();f.options.onMarketSample=sample=>{
    assert.equal(f.rows().length,seen.length+1,'callback sees a committed row through another connection');
    seen.push(structuredClone(sample));sample.priceUsd=999;
    if(fail)throw new Error('secret callback detail');
  };
  try {
    const observer=f.create();observer.register(signal());
    assert.equal(observer.recordMarket(market()),true);assert.equal(observer.list().items[0].sampleCount,1);
    assert.equal(observer.status().marketSampleCallbackError,'MEME_MARKET_SAMPLE_CALLBACK_FAILED');
    assert.equal(JSON.parse(String(f.rows()[0].market)).priceUsd,1);
    assert.equal(observer.recordMarket(market()),false);assert.equal(seen.length,1);
    f.advance(180);assert.equal(observer.recordMarket(market(token(),1)),false);assert.equal(seen.length,1);
    fail=false;assert.equal(observer.recordMarket(market(token(),180,2)),true);assert.equal(seen.length,2);
    assert.equal(observer.status().marketSampleCallbackError,undefined);assert.equal(seen[1].priceUsd,2);
    const db=new DatabaseSync(f.options.database);db.exec("CREATE TRIGGER fail_sample BEFORE INSERT ON meme_snapshots BEGIN SELECT RAISE(ABORT,'test'); END");db.close();
    f.advance(210);assert.throws(()=>observer.recordMarket(market(token(),210,3)));assert.equal(seen.length,2);
  }finally{await f.close();}
});

test('signals enter independent observation before any eligible report; replay freezes first seen and does not renew TTL',async()=>{
  const f=fixture({activeWindowSec:60});try {
    const observer=f.create();assert.equal(observer.register(signal(),at(),{name:'First name'}),true);
    await observer.runOnce();const first=observer.list().items[0];assert.equal(first.firstSeenAt,at());assert.equal(first.sampleCount,1);assert.equal(first.gate,undefined);
    f.advance(40);assert.equal(observer.register(signal(),at(40)),false);assert.equal(observer.list().items[0].lastSignalAt,at());
    f.advance(61);await observer.runOnce();assert.equal(f.calls.length,1);assert.equal(observer.list().items[0].observationState,'expired');
    assert.equal(observer.register(signal(1,61,'bsc','fresh-event'),at(61)),true);await observer.runOnce();
    assert.equal(observer.list().items[0].firstSeenAt,at());assert.equal(observer.list().items[0].lastSignalAt,at(61));assert.equal(f.calls.length,2);
  }finally{await f.close();}
});

test('batch observation covers bounded chain groups fairly and enforces 30 seconds per token',async()=>{
  const f=fixture();try {
    const observer=f.create();for(let i=1;i<=65;i++)observer.register(signal(i));
    await observer.runOnce();await observer.runOnce();await observer.runOnce();await observer.runOnce();
    assert.deepEqual(f.calls.map(c=>c.length),[30,30,5]);assert.equal(new Set(f.calls.flat().map(t=>t.address)).size,65);
    f.advance(29);await observer.runOnce();assert.equal(f.calls.length,3);
    f.advance(30);await observer.runOnce();assert.equal(f.calls.length,4);assert.equal(f.calls[3].length,30);
    assert.equal(observer.status().fresh,65);
  }finally{await f.close();}
});

test('live counting priority keeps registration, samples one token per turn, and pauses only catalyst research',async()=>{
  const catalysts:Signal['token'][]=[];const f=fixture({catalyst:async input=>{catalysts.push(input.token);return catalyst(input.token,f.now());}});
  try {
    const observer=f.create();[1,2,3].forEach(i=>observer.register(signal(i)));
    observer.setLivePriority(true);
    const priority=observer.status();assert.equal(priority.livePriority,true);assert.equal(priority.marketBatchLimit,1);
    assert.equal(priority.catalystPaused,true);assert.equal(priority.signalRegistrationPaused,false);
    await observer.runOnce();await observer.runCatalystOnce();assert.deepEqual(f.calls.map(batch=>batch.length),[1]);assert.equal(catalysts.length,0);
    f.advance(1);assert.equal(observer.register(signal(4,1)),true);assert.equal(observer.list().total,4);
    observer.setLivePriority(false);await observer.runOnce();await observer.runCatalystOnce();
    assert.deepEqual(f.calls.map(batch=>batch.length),[1,3]);assert.equal(catalysts.length,1);
    assert.equal(observer.status().researchMode,'normal');assert.equal(observer.status().catalystPaused,false);
  }finally{await f.close();}
});

test('entering live priority aborts optional in-flight research without reporting a collection failure',async()=>{
  let marketAborted=false,catalystAborted=false;
  const f=fixture({
    marketBatch:async(_tokens,abort)=>new Promise<never>((_resolve,reject)=>abort.addEventListener('abort',()=>{
      marketAborted=true;reject(new DOMException('priority','AbortError'));},{once:true})),
    catalyst:async(_input,abort)=>new Promise<never>((_resolve,reject)=>abort.addEventListener('abort',()=>{
      catalystAborted=true;reject(new DOMException('priority','AbortError'));},{once:true})),
  });
  try {
    const observer=f.create();observer.register(signal());
    const marketWork=observer.runOnce(),catalystWork=observer.runCatalystOnce();observer.setLivePriority(true);
    await Promise.all([marketWork,catalystWork]);
    assert.equal(marketAborted,true);assert.equal(catalystAborted,true);
    assert.equal(observer.status().error,undefined);assert.equal(observer.status().marketInFlight,false);
    assert.equal(observer.status().catalystInFlight,false);
  }finally{await f.close();}
});

test('GMGN fallback is one request per cycle, rotates missing coins, and honors shared cooldown',async()=>{
  const fallback:Signal['token'][]=[];let cooldown=0;const f=fixture({marketBatch:async()=>[],cooldownUntil:()=>cooldown});
  f.options.marketFallback=async token=>{fallback.push(token);return market(token,f.now(),1,{source:'gmgn_token_info'});};
  try {
    const observer=f.create();[1,2,3].forEach(i=>observer.register(signal(i)));
    await observer.runOnce();assert.equal(fallback.length,1);
    f.advance(30);await observer.runOnce();assert.equal(fallback.length,2);assert.notEqual(fallback[0].address,fallback[1].address);
    cooldown=Date.parse(at(100));f.advance(60);await observer.runOnce();assert.equal(fallback.length,2);
    f.advance(100);await observer.runOnce();assert.equal(fallback.length,3);assert.equal(new Set(fallback.map(t=>t.address)).size,3);
  }finally{await f.close();}
});

test('parallel market callers join one in-flight request and foreign batch rows are excluded',async()=>{
  const release=deferred();let calls=0;const f=fixture({marketBatch:async()=>{calls++;await release.promise;return [market(),market(token(2)),market(token(1,'robinhood'))];}});
  try {
    const observer=f.create();observer.register(signal());const a=observer.runOnce(),b=observer.runOnce();assert.equal(a,b);assert.equal(calls,1);
    release.resolve();await a;assert.equal(observer.list().total,1);assert.equal(observer.list().items[0].sampleCount,1);
    assert.equal(f.rows().length,1);
  }finally{release.resolve();await f.close();}
});

test('stale, future, wrong-token and invalid-source snapshots cannot advance the last good observation',async()=>{
  const f=fixture();try {
    const observer=f.create();observer.register(signal());assert.equal(observer.recordMarket(market()),true);f.advance(180);
    const rejected=[market(token(2),180),market(token(1,'robinhood'),180),market(token(),181),market(token(),59),
      market(token(),180,1,{source:'forged_source' as never}),market(token(),180,1,{version:2 as never}),market(token(),180,1,{windows:undefined as never}),
      market(token(),180,NaN),market(token(),180,Infinity)];
    for(const value of rejected)assert.equal(observer.recordMarket(value),false);
    assert.equal(observer.list().items[0].lastSampleAt,at());assert.equal(observer.list().items[0].sampleCount,1);
    assert.equal(observer.recordMarket(market(token(),180)),true);assert.equal(observer.list().items[0].sampleCount,2);
  }finally{await f.close();}
});

test('a frozen assessment stays unchanged while subsequent observed outcomes mature at 5m, 15m and 1h',async()=>{
  const f=fixture();try {
    const observer=f.create();observer.register(signal());observer.recordMarket(market());f.advance(60);observer.recordMarket(market(token(),60,2));
    const frozen=JSON.stringify(f.rows()[0].assessment),before=observer.detail(token(),{asOf:at(60)});
    assert.equal(before.items.at(-1)!.outcomes.items[0].returnPct,null);
    for(const [sec,price] of [[300,2],[900,3],[3600,5]]){f.advance(sec);observer.recordMarket(market(token(),sec,price));}
    const full=observer.detail(token());assert.equal(full.total,5);assert.equal(JSON.stringify(f.rows()[0].assessment),frozen);
    const first=full.items.find(item=>item.observedAt===at())!;
    assert.deepEqual(first.outcomes.items.map(item=>item.returnPct),[100,200,400]);
    assert.equal(first.outcomes.notTradingReturn,true);assert.equal((first.assessment as MemeAssessment).assessedAt,at());
    const historical=observer.detail(token(),{asOf:at(60)});assert.equal(historical.total,2);assert.deepEqual(historical.items.at(-1)!.outcomes.items.map(o=>o.returnPct),[null,null,null]);
  }finally{await f.close();}
});

test('outcomes require matching known pool and source, never price interpolation across absent windows',async()=>{
  const f=fixture();try {
    const observer=f.create();observer.register(signal());observer.recordMarket(market(token(),0,1,{poolAddress:undefined}));
    f.advance(300);observer.recordMarket(market(token(),300,10,{poolAddress:undefined}));
    assert.equal(observer.detail(token()).items.at(-1)!.outcomes.items[0].returnPct,null);
    f.advance(600);observer.recordMarket(market(token(),600,2));f.advance(900);observer.recordMarket(market(token(),900,8,{poolAddress:address(1001)}));
    assert.equal(observer.detail(token()).items.find(item=>item.observedAt===at(600))!.outcomes.items[0].returnPct,null);
    f.advance(1200);observer.recordMarket(market(token(),1200,2));f.advance(1500);observer.recordMarket(market(token(),1500,10,{source:'gmgn_token_info'}));
    assert.equal(observer.detail(token()).items.find(item=>item.observedAt===at(1200))!.outcomes.items[0].returnPct,null);
    f.advance(1800);observer.recordMarket(market(token(),1800,2));f.advance(2300);observer.recordMarket(market(token(),2300,9));
    assert.equal(observer.detail(token()).items.find(item=>item.observedAt===at(1800))!.outcomes.items[0].returnPct,null);
  }finally{await f.close();}
});

test('restart preserves observations, signal deduplication and stable paginated membership as new coins arrive',async()=>{
  const f=fixture();try {
    const observer=f.create();for(let i=1;i<=5;i++){f.advance(i);observer.register(signal(i,i));observer.recordMarket(market(token(i),i));}
    const first=observer.list({limit:2});assert.deepEqual(first.items.map(i=>i.address),[address(5),address(4)]);assert.equal(first.hasMore,true);
    await observer.close();const restarted=f.create();assert.equal(restarted.list().total,5);assert.equal(restarted.list().items[0].sampleCount,1);
    f.advance(10);assert.equal(restarted.register(signal(5,5),at(10)),false);assert.equal(restarted.list().items[0].lastSignalAt,at(5));
    restarted.register(signal(6,10));const second=restarted.list({limit:2,offset:2,asOf:first.asOf});
    assert.equal(second.total,5);assert.deepEqual(second.items.map(i=>i.address),[address(3),address(2)]);assert.equal(restarted.list().total,6);
    assert.throws(()=>restarted.list({limit:0}),/INVALID_FILTER/);assert.throws(()=>restarted.list({offset:-1}),/INVALID_FILTER/);
  }finally{await f.close();}
});

test('catalyst failure and pending retrieval do not block market sampling or overwrite the independent safety gate',async()=>{
  const release=deferred();let fail=true;const f=fixture({catalyst:async input=>{await release.promise;if(fail)throw new Error('secret credential');return catalyst(input.token,f.now());}});
  try {
    const observer=f.create();observer.captureReport(report());const initialGate=observer.list().items[0].gate;
    const social=observer.runCatalystOnce();await observer.runOnce();assert.equal(observer.list().items[0].sampleCount,1);
    release.resolve();await social;assert.equal(observer.status().error,'MEME_CATALYST_UNAVAILABLE');assert.equal(JSON.stringify(observer.status()).includes('credential'),false);
    f.advance(60);await observer.runOnce();assert.equal(observer.list().items[0].sampleCount,2);assert.deepEqual(observer.list().items[0].gate,initialGate);
    assert.equal((observer.list().items[0].gate as {decision:string}).decision,'REJECT');assert.equal(observer.status().tradingEnabled,false);
    fail=false;f.advance(600);await observer.runCatalystOnce();await observer.runOnce();assert.equal((observer.detail(token()).token as any).catalyst.status,'unknown');
    assert.deepEqual(observer.list().items[0].gate,initialGate);
  }finally{release.resolve();await f.close();}
});

test('old, expired and cross-token catalyst results cannot replace a current snapshot',async()=>{
  const f=fixture();try {
    const observer=f.create();observer.register(signal());f.advance(60);observer.recordCatalyst(catalyst(token(),60));
    for(const bad of [catalyst(token(2),60),catalyst(token(),61),catalyst(token(),59),{...catalyst(token(),60),expiresAt:at(60)}])observer.recordCatalyst(bad);
    assert.equal(observer.detail(token()).catalystHistory.length,1);assert.equal((observer.detail(token()).token as any).catalyst.observedAt,at(60));
  }finally{await f.close();}
});

test('as-of history and later-return labels exclude observations not yet evaluated at that cutoff',async()=>{
  const f=fixture();try {
    const observer=f.create();observer.register(signal());f.advance(120);observer.recordMarket(market(token(),0,1));
    assert.equal(observer.detail(token(),{asOf:at(60)}).total,0);
    f.advance(420);observer.recordMarket(market(token(),300,10));
    // Five minutes from the assessment at t=120 is t=420, not the old quote time t=0.
    assert.equal(observer.detail(token(),{asOf:at(420)}).items.at(-1)!.outcomes.items[0].returnPct,null);
    assert.equal(observer.detail(token(),{asOf:at(350)}).total,1);
    f.advance(430);observer.recordMarket(market(token(),430,2));
    const latest=observer.detail(token());assert.equal(latest.items.at(-1)!.outcomes.items[0].returnPct,100);
  }finally{await f.close();}
});

test('catalyst queue database failures are contained and do not terminate market observation',async()=>{
  const f=fixture({catalyst:async signal=>catalyst(signal.token)});try{
    const observer=f.create();observer.register(signal());
    const db=new DatabaseSync(f.options.database);
    db.exec("CREATE TRIGGER fail_catalyst BEFORE UPDATE OF catalyst_attempt_at ON meme_tokens BEGIN SELECT RAISE(FAIL, 'simulated write failure'); END;");
    await assert.doesNotReject(observer.runCatalystOnce());
    assert.equal(observer.status().error,'MEME_CATALYST_UNAVAILABLE');
    await observer.runOnce();assert.equal(observer.list().items[0].sampleCount,1);
    db.exec('DROP TRIGGER fail_catalyst');db.close();
    await observer.runCatalystOnce();assert.equal(observer.detail(token()).catalystHistory.length,1);
  }finally{await f.close();}
});

test('new observer databases persist frozen source corroboration and restart without duplicate migration columns',async()=>{
  const f=fixture(),ledger=new SourceCorroboration(':memory:',{now:()=>new Date(at(f.now()))});
  f.options.corroboration=(target,now)=>ledger.assess(target,now);
  try {
    assert.equal(ledger.record(signal()).accepted,true);
    const observer=f.create();observer.register(signal());assert.equal(observer.recordMarket(market()),true);
    assert.equal(observer.detail(token()).items[0].corroboration?.classification,'single_source');
    const frozen=f.rows()[0].corroboration;assert.equal(JSON.parse(String(frozen)).freshSourceCount,1);
    await observer.close();const restarted=f.create();
    assert.equal(f.rows()[0].corroboration,frozen);assert.equal(restarted.detail(token()).items[0].corroboration?.freshSources[0],'debot');
    const db=new DatabaseSync(f.options.database,{readOnly:true});
    try {assert.equal(db.prepare('PRAGMA table_info(meme_snapshots)').all().filter(row=>row.name==='corroboration').length,1);}finally{db.close();}
  }finally{ledger.close();await f.close();}
});

test('legacy snapshot migration preserves original assessments and does not backfill old history with current source evidence',async()=>{
  const f=fixture(),ledger=new SourceCorroboration(':memory:',{now:()=>new Date(at(f.now()))});
  f.options.corroboration=(target,now)=>ledger.assess(target,now);
  const original=JSON.stringify(assessMeme({token:token(),now:new Date(at()),samples:[market()]}));
  try {
    const db=new DatabaseSync(f.options.database);
    db.exec(`CREATE TABLE meme_snapshots(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,observed_at TEXT NOT NULL,
      source TEXT NOT NULL,fingerprint TEXT UNIQUE,market TEXT,assessment TEXT NOT NULL)`);
    db.prepare('INSERT INTO meme_snapshots VALUES(?,?,?,?,?,?,?,?)').run(1,'bsc',address(),at(),'dexscreener_pair','legacy',JSON.stringify(market()),original);
    db.close();
    f.advance(30);ledger.record(signal(1,30));ledger.record({...signal(1,30,'bsc','ave-current'),source:'ave'});
    const observer=f.create();observer.register(signal(1,30));
    assert.equal(f.rows()[0].assessment,original);assert.equal(f.rows()[0].corroboration,null);
    const migrated=observer.detail(token());assert.equal(migrated.items[0].corroboration,undefined);
    assert.equal('corroboration' in migrated.token&&migrated.token.corroboration?.classification,'cross_source');
    assert.equal(observer.recordMarket(market(token(),30)),true);
    assert.equal(observer.detail(token()).items[0].corroboration?.classification,'cross_source');
    assert.equal(f.rows()[0].assessment,original);assert.equal(f.rows()[0].corroboration,null);
    await observer.close();f.create();assert.equal(f.rows()[0].corroboration,null);assert.equal(f.rows().length,2);
  }finally{ledger.close();await f.close();}
});

test('later cross-source evidence changes current detail while historical snapshots and as-of scores remain frozen',async()=>{
  const f=fixture(),control=fixture(),ledger=new SourceCorroboration(':memory:',{now:()=>new Date(at(f.now()))});
  f.options.corroboration=(target,now)=>ledger.assess(target,now);
  try {
    ledger.record(signal());const observer=f.create(),plain=control.create();
    for(const instance of [observer,plain]){instance.register(signal());instance.recordMarket(market());}
    f.advance(30);control.advance(30);for(const instance of [observer,plain])instance.recordMarket(market(token(),30,1.1));
    const frozen=f.rows().map(row=>({id:row.id,assessment:row.assessment,corroboration:row.corroboration}));
    f.advance(60);control.advance(60);
    // A late ingestion claims an old notification and old receipt time. Only recordedAt is actual arrival.
    assert.equal(ledger.record({...signal(1,10,'bsc','ave-late-ingestion'),source:'ave'},at(10)).accepted,true);
    assert.equal(ledger.assess(token(),new Date(at(30))).classification,'single_source');
    const current=observer.detail(token());
    assert.equal('corroboration' in current.token&&current.token.corroboration?.classification,'cross_source');
    assert.equal('assessment' in current.token&&(current.token.assessment as MemeAssessment).assessedAt,at(30));
    const historical=observer.detail(token(),{asOf:at(30)});
    assert.equal(historical.total,2);assert.ok(historical.items.every(item=>item.corroboration?.classification==='single_source'));
    assert.deepEqual(historical.items.map(item=>item.assessment),plain.detail(token(),{asOf:at(30)}).items.map(item=>item.assessment));
    for(const instance of [observer,plain])instance.recordMarket(market(token(),60,1.2));
    assert.equal(observer.detail(token()).items[0].corroboration?.classification,'cross_source');
    assert.equal(observer.detail(token()).items[0].corroboration?.scoreEffect,0);
    assert.deepEqual(observer.detail(token()).items[0].assessment,plain.detail(token()).items[0].assessment);
    assert.deepEqual(f.rows().slice(0,2).map(row=>({id:row.id,assessment:row.assessment,corroboration:row.corroboration})),frozen);
    assert.equal(observer.detail(token(),{asOf:at(30)}).items[0].corroboration?.freshSourceCount,1);
    f.advance(400);const expired=observer.detail(token());
    assert.equal('corroboration' in expired.token&&expired.token.corroboration?.classification,'none');
    assert.equal(expired.items[0].corroboration?.classification,'cross_source');
  }finally{ledger.close();await f.close();await control.close();}
});

test('one hundred same-provider notices and delivery replays never become independent sources or a score bonus',async()=>{
  const f=fixture(),control=fixture(),ledger=new SourceCorroboration(':memory:',{now:()=>new Date(at(f.now()))});
  f.options.corroboration=(target,now)=>ledger.assess(target,now);
  try {
    ledger.record(signal());const observer=f.create(),plain=control.create();
    for(const instance of [observer,plain]){instance.register(signal());instance.recordMarket(market());}
    const initial=f.rows()[0].corroboration;f.advance(30);control.advance(30);
    for(let i=1;i<=99;i++)assert.equal(ledger.record(signal(1,30,'bsc',`repeat-${i}`)).accepted,true);
    for(let i=0;i<10;i++)assert.equal(ledger.record(signal(),at(30)).duplicate,true);
    for(const instance of [observer,plain])instance.recordMarket(market(token(),30,1.05));
    const latest=observer.detail(token()).items[0],evidence=latest.corroboration!;
    assert.equal(evidence.classification,'single_source');assert.equal(evidence.freshSourceCount,1);
    assert.equal(evidence.sources[0].notificationCount,100);assert.equal(evidence.independentEvidence,'unknown');assert.equal(evidence.scoreEffect,0);
    assert.deepEqual(latest.assessment,plain.detail(token()).items[0].assessment);assert.equal(f.rows()[0].corroboration,initial);
    assert.equal(observer.detail(token(),{asOf:at()}).items[0].corroboration?.sources[0].notificationCount,1);
  }finally{ledger.close();await f.close();await control.close();}
});

test('source-ledger read failures stay optional and cannot stop observation or overwrite a completed safety gate',async()=>{
  const f=fixture({corroboration:()=>{throw new Error('database unavailable');}});
  try {
    const observer=f.create();observer.captureReport(report());const gate=observer.list().items[0].gate;
    await observer.runOnce();assert.equal(observer.detail(token()).items[0].corroboration,undefined);
    assert.equal(f.rows()[0].corroboration,null);assert.deepEqual(observer.list().items[0].gate,gate);
    f.advance(30);await observer.runOnce();assert.equal(observer.list().items[0].sampleCount,2);
    assert.equal(observer.list().items[0].corroboration,undefined);assert.deepEqual(observer.list().items[0].gate,gate);
  }finally{await f.close();}
});
