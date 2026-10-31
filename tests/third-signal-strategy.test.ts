import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ThirdSignalStrategy,type ThirdSignalInput} from '../src/third-signal-strategy.js';
import {assessEntryHolderRiskValues} from '../src/entry-holder-risk.js';

const epoch=Date.parse('2026-10-25T10:00:00.000Z'),hour=3600000,ca='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40);
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'third-signal-')),path=join(dir,'simulation.sqlite');
  let now=epoch,sequence=0;const stores:ThirdSignalStrategy[]=[];
  const open=()=>{const store=new ThirdSignalStrategy(path,{now:()=>now});stores.push(store);return store;};
  const event=(changes:Partial<ThirdSignalInput>={}):ThirdSignalInput=>({source:'debot',chain:'bsc',address:ca,
    eventId:String(++sequence),occurredAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),marketCapUsd:100000,...changes});
  return {path,open,event,advance:(ms:number)=>{now+=ms;},set:(at:number)=>{now=at;},now:()=>now,
    close:()=>{for(const store of stores)store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('explicit start begins at zero; only the third independent event creates a simulation candidate',()=>{
  const f=fixture();try {
    const s=f.open();assert.equal(s.status().running,false);
    assert.equal(s.observe(f.event()).reason,'STRATEGY_STOPPED');
    const started=s.start('web');assert.equal(started.events,0);assert.equal(started.mode,'simulation');assert.equal(started.executionEnabled,false);
    assert.equal(s.observe(f.event()).count,1);assert.equal(s.observe(f.event()).count,2);
    const third=s.observe(f.event({name:'Example',symbol:'EX'}));
    assert.equal(third.status,'candidate');assert.equal(third.count,3);assert.equal(third.candidate?.marketCapUsd,100000);
    assert.equal(third.candidate?.phase,'simulation_candidate');assert.equal(third.candidate?.executionEnabled,false);
    assert.equal(s.observe(f.event()).reason,'AFTER_THIRD_NOTIFICATION');assert.equal(s.candidates().total,1);
    assert.equal(s.status().globalClaims,1);assert.equal(s.list().items[0].count,4);
    assert.equal(statSync(f.path).mode&0o777,0o600);
  }finally{f.close();}
});

test('duplicate delivery is atomically deduplicated across connections and never extends the idle TTL',()=>{
  const f=fixture();try {
    const a=f.open(),b=f.open();a.start();const first=f.event();a.observe(first);
    const expires=a.list().items[0].expiresAt;
    f.advance(5*hour);assert.equal(b.observe({...first,receivedAt:new Date(f.now()).toISOString()}).reason,'DUPLICATE_EVENT');
    assert.equal(a.status().events,1);assert.equal(a.list().items[0].expiresAt,expires);
    f.advance(hour);const result=b.observe(f.event());assert.equal(result.count,1);
    assert.equal(a.list().items[0].firstReceivedAt,new Date(f.now()).toISOString());
  }finally{f.close();}
});

test('independent events renew a six-hour idle window and an exact six-hour gap starts a new count',()=>{
  const f=fixture();try {
    const s=f.open();s.start();s.observe(f.event());f.advance(5*hour);assert.equal(s.observe(f.event()).count,2);
    f.advance(5*hour);assert.equal(s.observe(f.event()).status,'candidate');
    const prior=s.list().items[0];assert.equal(prior.firstReceivedAt,new Date(epoch).toISOString());
    assert.equal(prior.expiresAt,new Date(epoch+16*hour).toISOString());
    f.advance(6*hour);assert.equal(s.list().items[0].expired,true);
    assert.equal(s.observe(f.event()).count,1);assert.notEqual(s.list().items[0].windowId,prior.windowId);
    assert.equal(s.status().globalClaims,1);
  }finally{f.close();}
});

test('source, chain and full CA count separately while candidate claims span both sources',()=>{
  const f=fixture();try {
    const s=f.open();s.start();
    for(const source of ['debot','ave'] as const)for(let i=0;i<2;i++)assert.equal(s.observe(f.event({source})).count,i+1);
    assert.equal(s.observe(f.event({source:'debot',address:ca.toUpperCase().replace('0X','0x')})).status,'candidate');
    const blocked=s.observe(f.event({source:'ave'}));assert.equal(blocked.reason,'GLOBAL_TOKEN_ALREADY_CLAIMED');assert.equal(blocked.repeatBlocked,true);
    for(let i=0;i<2;i++)assert.equal(s.observe(f.event({chain:'robinhood'})).count,i+1);
    assert.equal(s.observe(f.event({chain:'robinhood'})).status,'candidate');
    assert.equal(s.observe(f.event({address:other})).count,1);assert.equal(s.list().total,4);
    assert.equal(s.candidates().total,2);
  }finally{f.close();}
});

test('missing or excessive market cap rejects that third event and a fourth valid cap does not repair it',()=>{
  for(const marketCapUsd of [undefined,NaN,Infinity,-1,0,100000.01]) {
    const f=fixture();try {
      const s=f.open();s.start();s.observe(f.event());s.observe(f.event());
      const third=s.observe(f.event({marketCapUsd}));assert.equal(third.status,marketCapUsd===100000.01?'rejected':'unknown');
      assert.equal(s.observe(f.event({marketCapUsd:1000})).reason,'AFTER_THIRD_NOTIFICATION');
      assert.equal(s.candidates().total,0);assert.equal(s.status().globalClaims,0);
      assert.equal(s.list().items[0].decision,third.status);
    }finally{f.close();}
  }
});

test('stop immediately rejects late asynchronous work; a new start clears counts but not permanent claims',()=>{
  const f=fixture();try {
    const s=f.open(),first=s.start('tg');s.observe(f.event());const late=f.event({runId:first.runId});
    s.stop('web');assert.equal(s.observe(late).reason,'STRATEGY_STOPPED');assert.equal(s.status().events,1);
    const restarted=s.start('tg');assert.notEqual(restarted.runId,first.runId);assert.equal(s.list().total,0);
    assert.equal(s.observe(late).reason,'RUN_MISMATCH');
    for(let i=0;i<3;i++)s.observe(f.event({runId:restarted.runId}));
    s.stop();f.advance(1);s.start();for(let i=0;i<2;i++)s.observe(f.event());
    assert.equal(s.observe(f.event()).reason,'GLOBAL_TOKEN_ALREADY_CLAIMED');
    assert.equal(s.status().globalClaims,1);assert.equal(s.candidates().total,0);
  }finally{f.close();}
});

test('restart persists run, events, windows and global claims without replaying historical notifications',()=>{
  const f=fixture();try {
    let s=f.open();const run=s.start(),one=f.event();s.observe(one);s.observe(f.event());s.close();
    s=f.open();assert.equal(s.status().runId,run.runId);assert.equal(s.status().running,true);
    assert.equal(s.observe(one).reason,'DUPLICATE_EVENT');assert.equal(s.observe(f.event()).status,'candidate');s.close();
    s=f.open();assert.equal(s.status().globalClaims,1);assert.equal(s.observe(f.event()).count,4);
    assert.equal(s.candidates().total,1);
  }finally{f.close();}
});

test('notification ordinals two through four freeze source evidence without changing entry decisions',()=>{
  const f=fixture();try {
    let s=f.open();const run=s.start();
    assert.equal(s.observe(f.event()).count,1);assert.equal(s.notificationSnapshots().total,0);
    const second=f.event({notificationEvidence:{priceUsd:0.01,marketCapUsd:90000,liquidityUsd:12000,
      poolAddress:'pool-public-id',marketObservedAt:new Date(f.now()).toISOString(),marketTiming:'event_snapshot',claimedPlatform:'four',
      reportedWalletCount:2,identifiedWalletCount:1,wallets:[{address:other,alias:'early',side:'buy',volumeUsd:50,priceUsd:0.009},
        {address:'invalid',alias:'anonymous'},{address:other,alias:'early',side:'buy',volumeUsd:50,priceUsd:0.009}]}});
    assert.equal(s.observe(second).count,2);
    const frozen=s.notificationSnapshots().items[0];assert.equal(frozen.ordinal,2);
    assert.deepEqual(frozen.market.price,{status:'observed',value:0.01,observedAt:new Date(f.now()).toISOString(),
      timing:'event_snapshot',sourceField:'token_trading_stat.price'});
    assert.equal(frozen.market.liquidity.status,'observed');assert.equal(frozen.market.pool.status,'observed');
    assert.deepEqual(frozen.safety,{status:'unavailable',reason:'NOT_AVAILABLE_ON_NOTIFICATION_FAST_PATH'});
    assert.equal(frozen.wallets.verification,'vendor_report');assert.equal(frozen.wallets.observations.length,2);
    assert.equal(frozen.wallets.observations[0].address,other);assert.equal(frozen.token.claimedPlatform,'four');
    assert.equal(s.observe({...second,notificationEvidence:{priceUsd:999}}).reason,'DUPLICATE_EVENT');
    assert.deepEqual(s.notificationSnapshots().items[0],frozen,'duplicate delivery cannot rewrite frozen evidence');
    assert.equal(s.observe(f.event({notificationEvidence:{marketCapUsd:100000,marketTiming:'receipt_snapshot'}})).status,'candidate');
    assert.equal(s.observe(f.event()).count,4);assert.equal(s.observe(f.event()).count,5);
    assert.deepEqual(s.notificationSnapshots().items.map(item=>item.ordinal),[2,3,4]);
    assert.equal(s.notificationSnapshots({ordinal:3}).items[0].market.marketCap.status,'observed');
    s.stop();s.start();assert.equal(s.notificationSnapshots().total,0);
    assert.equal(s.notificationSnapshots({runId:run.runId}).total,3);
    s.close();s=f.open();assert.equal(s.notificationSnapshots({runId:run.runId,source:'debot',chain:'bsc',address:ca}).total,3);
    assert.throws(()=>s.notificationSnapshots({address:ca}),/THIRD_SIGNAL_SNAPSHOT_FILTER_INVALID/);
  }finally{f.close();}
});

test('events before start, delayed receipt, stale source time, future time and out-of-order delivery do not count',()=>{
  const f=fixture();try {
    const s=f.open();f.advance(hour);s.start();const start=f.now();
    assert.equal(s.observe(f.event({occurredAt:new Date(start-1).toISOString()})).reason,'BEFORE_RUN_START');
    assert.equal(s.observe(f.event({receivedAt:new Date(start-1).toISOString()})).reason,'BEFORE_RUN_START');
    f.advance(121000);
    assert.equal(s.observe(f.event({receivedAt:new Date(start).toISOString(),occurredAt:new Date(start).toISOString()})).reason,'SIGNAL_STALE');
    assert.equal(s.observe(f.event({occurredAt:new Date(start).toISOString()})).reason,'SIGNAL_STALE');
    assert.equal(s.observe(f.event({occurredAt:new Date(f.now()+1).toISOString()})).reason,'SIGNAL_TIME_INVALID');
    assert.equal(s.observe(f.event({receivedAt:new Date(f.now()+1).toISOString()})).reason,'SIGNAL_TIME_INVALID');
    assert.equal(s.observe(f.event()).count,1);
    assert.equal(s.observe(f.event({receivedAt:new Date(f.now()-1).toISOString(),occurredAt:new Date(f.now()-1).toISOString()})).reason,'OUT_OF_ORDER_EVENT');
    assert.equal(s.status().events,1);
  }finally{f.close();}
});

test('exactly 120 seconds of freshness is accepted and malformed addresses or actors are rejected safely',()=>{
  const f=fixture();try {
    const s=f.open();s.start();f.advance(120000);
    assert.equal(s.observe(f.event({occurredAt:new Date(epoch).toISOString()})).count,1);
    assert.equal(s.observe(f.event({address:'0xabc'})).reason,'SIGNAL_INVALID');
    assert.throws(()=>s.start('private-user-text' as 'web'),/^Error: THIRD_SIGNAL_ACTOR_INVALID$/);
    assert.throws(()=>s.stop('private-user-text' as 'tg'),/^Error: THIRD_SIGNAL_ACTOR_INVALID$/);
    assert.equal(s.status().running,true);
  }finally{f.close();}
});

test('historical execution imports permanently block candidates across runs, TTLs and restarts',()=>{
  const f=fixture();try {
    let s=f.open();assert.equal(s.markOpened({chain:'bsc',address:ca,recordId:'submitted-record',source:'order_store'}).created,true);
    assert.equal(s.markOpened({chain:'bsc',address:ca,recordId:'another-record'}).created,false);
    s.start();for(let i=0;i<2;i++)s.observe(f.event());
    assert.equal(s.observe(f.event({marketCapUsd:undefined})).reason,'GLOBAL_TOKEN_ALREADY_CLAIMED');
    assert.equal(s.list().items[0].claimPhase,'actual_opened_imported');s.close();
    s=f.open();s.stop();s.start();f.advance(7*hour);
    for(let i=0;i<2;i++)s.observe(f.event({source:'ave'}));
    assert.equal(s.observe(f.event({source:'ave'})).reason,'GLOBAL_TOKEN_ALREADY_CLAIMED');
    assert.equal(s.candidates().total,0);
  }finally{f.close();}
});

test('a real-history import upgrades a simulation claim without representing the candidate as an executed order',()=>{
  const f=fixture();try {
    const s=f.open();s.start();for(let i=0;i<3;i++)s.observe(f.event());
    const candidate=s.candidates().items[0];assert.equal(s.list().items[0].claimPhase,'simulation_candidate');
    assert.equal(s.markOpened({chain:'bsc',address:ca,recordId:'confirmed-order'}).created,false);
    assert.equal(s.list().items[0].claimPhase,'actual_opened_imported');
    assert.equal(s.candidates().items[0].phase,'simulation_candidate');assert.deepEqual(s.candidates().items[0],candidate);
  }finally{f.close();}
});

test('competing source third events serialize to exactly one global claim and candidate',()=>{
  const f=fixture();try {
    const a=f.open(),b=f.open();a.start();
    for(const source of ['debot','ave'] as const)for(let i=0;i<2;i++)a.observe(f.event({source}));
    const results=[a.observe(f.event()),b.observe(f.event({source:'ave'}))];
    assert.equal(results.filter(r=>r.status==='candidate').length,1);assert.equal(results.filter(r=>r.repeatBlocked).length,1);
    assert.equal(a.candidates().total,1);assert.equal(b.status().globalClaims,1);
    const db=new DatabaseSync(f.path,{readOnly:true});try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM third_signal_claims').get()!.n,1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM third_signal_events').get()!.n,6);
    }finally{db.close();}
  }finally{f.close();}
});

test('window and candidate pages are bounded and a restarted run has an empty current queue',()=>{
  const f=fixture();try {
    const s=f.open();s.start();for(const address of [ca,other])for(let i=0;i<3;i++)s.observe(f.event({address}));
    assert.equal(s.list({limit:1,offset:0}).hasMore,true);assert.equal(s.list({limit:1,offset:1}).hasMore,false);
    assert.equal(s.candidates({limit:1}).items.length,1);assert.equal(s.candidates({limit:1,offset:1}).total,2);
    assert.throws(()=>s.list({limit:201}),/THIRD_SIGNAL_PAGE_INVALID/);
    s.stop();s.start();assert.equal(s.list().total,0);assert.equal(s.candidates().total,0);assert.equal(s.status().globalClaims,2);
  }finally{f.close();}
});

test('repeated start from web or Telegram is idempotent across connections and preserves counters and TTL',()=>{
  const f=fixture();try {
    const a=f.open(),b=f.open(),started=a.start('web');a.observe(f.event());
    const before=a.list();f.advance(hour);
    for(const store of [a,b]) {
      const repeated=store.start('tg');assert.equal(repeated.runId,started.runId);
      assert.equal(repeated.startedAt,started.startedAt);assert.equal(repeated.startActor,'web');
      assert.equal(repeated.events,1);assert.deepEqual(store.list(),before);
    }
    assert.equal(b.observe(f.event()).count,2);assert.equal(a.observe(f.event()).status,'candidate');
    assert.equal(b.start('web').candidates,1);
    b.stop('tg');const next=a.start('web');assert.notEqual(next.runId,started.runId);assert.equal(next.events,0);
  }finally{f.close();}
});

test('live starts count from zero, ignore simulated-only claims, and persist one live claim across sources and restarts',()=>{
  const f=fixture();try {
    let s=f.open();const simulated=s.start();for(let i=0;i<3;i++)s.observe(f.event());
    const sim=s.candidates().items[0];assert.equal(sim.mode,'simulation');
    const live=s.start('tg','live');assert.notEqual(live.runId,simulated.runId);
    assert.equal(live.events,0);assert.equal(live.globalClaims,0);assert.equal(live.executionEnabled,true);
    for(let i=0;i<2;i++){s.observe(f.event());s.observe(f.event({source:'ave'}));}
    const candidate=s.observe(f.event()).candidate!;assert.equal(candidate.mode,'live');
    assert.equal(candidate.phase,'live_candidate');assert.equal(s.claimDispatch(candidate),true);
    assert.equal(s.claimDispatch(candidate),false);assert.equal(s.isActive(candidate),true);
    assert.equal(s.observe(f.event({source:'ave'})).reason,'GLOBAL_TOKEN_ALREADY_CLAIMED');
    s.recordExecution(candidate,{status:'submitted',orderId:'real-order'});
    assert.equal(s.list().items.find(x=>x.source==='debot')?.executionStatus,'submitted');
    s.close();s=f.open();assert.equal(s.status().mode,'live');assert.equal(s.status().globalClaims,1);
    assert.equal(s.claimDispatch(candidate),false);s.stop();assert.equal(s.isActive(candidate),false);
    s.start('web','live');for(let i=0;i<2;i++)s.observe(f.event());
    assert.equal(s.observe(f.event()).reason,'GLOBAL_TOKEN_ALREADY_CLAIMED');
  }finally{f.close();}
});

test('entry holder-risk evidence survives restart and later status updates without storing raw data or another token',()=>{
  const f=fixture(),mint='So11111111111111111111111111111111111111112';
  try {
    let s=f.open();s.start('tg','live');
    for(let i=0;i<2;i++)s.observe(f.event({chain:'solana',address:mint}));
    const candidate=s.observe(f.event({chain:'solana',address:mint})).candidate!;
    assert.equal(s.claimDispatch(candidate),true);
    const risk=assessEntryHolderRiskValues({provider:'gmgn',chain:'solana',address:mint,checkedAt:new Date(epoch).toISOString(),values:{
      top10:{value:'0.2500000000000000001',sourceField:'security.top_10_holder_rate'},
      bundler:{value:undefined,sourceField:'holders.bundler.holding_ratio',coverage:'lower_bound',lowerBound:'0.2'},
      ratTrader:{value:'0.1',sourceField:'holders.rat_trader.holding_ratio',coverage:'complete'},
    }},new Date(epoch));
    s.recordExecution(candidate,{status:'failed',orderId:'risk-blocked-order',reason:'ENTRY_HOLDER_RISK_TOP10_EXCEEDED',
      holderRisk:{...risk,raw:{cookie:'DO_NOT_PERSIST_RAW'},metrics:{...risk.metrics,top10:{...risk.metrics.top10,secret:'DO_NOT_PERSIST_METRIC'}}}});
    assert.deepEqual(s.list().items[0].holderRisk,risk);
    s.close();s=f.open();assert.deepEqual(s.list().items[0].holderRisk,risk);
    // Subsequent callbacks need not resend the snapshot, and cannot replace it with a different CA.
    s.recordExecution(candidate,{status:'failed',reason:'ENTRY_HOLDER_RISK_TOP10_EXCEEDED'});
    s.recordExecution(candidate,{status:'failed',holderRisk:{...risk,address:'11111111111111111111111111111111'}});
    assert.deepEqual(s.list().items[0].holderRisk,risk);assert.equal(s.list().items[0].executionOrderId,'risk-blocked-order');
    const db=new DatabaseSync(f.path,{readOnly:true});
    try {const stored=db.prepare('SELECT execution_holder_risk FROM third_signal_dispatch').get()!.execution_holder_risk;
      assert.doesNotMatch(String(stored),/DO_NOT_PERSIST|cookie|secret/);
      assert.equal(JSON.parse(String(stored)).metrics.top10.percentageText,'25.00000000000000001');
      assert.equal(JSON.parse(String(stored)).metrics.bundler.status,'missing');
    }finally{db.close();}
    assert.equal(s.status().globalClaims,1);assert.equal(s.claimDispatch(candidate),false);
  }finally{f.close();}
});

test('identical execution snapshots are no-op commits while status changes still persist',()=>{
  const f=fixture(),mint='So11111111111111111111111111111111111111112';try {
    const s=f.open();s.start('tg','live');for(let i=0;i<3;i++)s.observe(f.event({chain:'solana',address:mint}));
    const candidate=s.candidates().items[0];assert.equal(s.claimDispatch(candidate),true);
    const risk=assessEntryHolderRiskValues({provider:'gmgn',chain:'solana',address:mint,checkedAt:new Date(epoch).toISOString(),values:{
      top10:{value:'0.1',sourceField:'security.top_10_holder_rate'},
      bundler:{value:'0.2',sourceField:'holders.bundler.holding_ratio',coverage:'complete'},
      ratTrader:{value:'0.15',sourceField:'holders.rat_trader.holding_ratio',coverage:'complete'},
    }},new Date(epoch));
    s.recordExecution(candidate,{status:'submitted',orderId:'order-1',holderRisk:risk});
    const observer=new DatabaseSync(f.path,{readOnly:true});try {
      const row=()=>observer.prepare('SELECT updated_at,execution_status,execution_holder_risk FROM third_signal_dispatch WHERE candidate_id=?')
        .get(candidate.id)!;
      const before=row(),version=Number(observer.prepare('PRAGMA data_version').get()!.data_version);f.advance(1000);
      s.recordExecution(candidate,{status:'submitted',orderId:'order-1',holderRisk:{metrics:risk.metrics,reasons:risk.reasons,
        status:risk.status,checkedAt:risk.checkedAt,address:risk.address,chain:risk.chain,provider:risk.provider}});
      assert.deepEqual(row(),before);assert.equal(Number(observer.prepare('PRAGMA data_version').get()!.data_version),version);
      f.advance(1000);s.recordExecution(candidate,{status:'confirmed',orderId:'order-1',holderRisk:risk});
      const changed=row();assert.equal(changed.execution_status,'confirmed');assert.equal(changed.updated_at,f.now());
      assert.notEqual(changed.updated_at,before.updated_at);
      assert.ok(Number(observer.prepare('PRAGMA data_version').get()!.data_version)>version);
    }finally{observer.close();}
  }finally{f.close();}
});

test('legacy runs are migrated as simulation without upgrading or treating their claims as real buys',()=>{
  const f=fixture();try {
    let s=f.open();s.start();for(let i=0;i<3;i++)s.observe(f.event());s.close();
    const db=new DatabaseSync(f.path);db.exec('ALTER TABLE third_signal_runs DROP COLUMN mode');db.close();
    s=f.open();assert.equal(s.status().mode,'simulation');assert.equal(s.status().executionEnabled,false);
    assert.equal(s.candidates().items[0].phase,'simulation_candidate');
    s.start('web','live');assert.equal(s.status().globalClaims,0);
    for(let i=0;i<2;i++)s.observe(f.event());assert.equal(s.observe(f.event()).status,'candidate');
  }finally{f.close();}
});

test('actual historical opening blocks first live attempt even if a simulation claim existed',()=>{
  const f=fixture();try {
    const s=f.open();s.start();for(let i=0;i<3;i++)s.observe(f.event());
    s.markOpened({chain:'bsc',address:ca,recordId:'confirmed-live-history'});s.start('tg','live');
    for(let i=0;i<2;i++)s.observe(f.event());
    assert.equal(s.observe(f.event()).reason,'GLOBAL_TOKEN_ALREADY_CLAIMED');assert.equal(s.candidates().total,0);
  }finally{f.close();}
});
