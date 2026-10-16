import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ExitShadow,type ExitShadowOptions,type ExitObservationSeed} from '../src/exit-shadow.js';
import type {ScanPrice,ScanToken} from '../src/scan-archive.js';
import {ADAPTIVE_SHADOW_V2,stepAdaptiveExit,type WalletPressure} from '../src/adaptive-exit.js';

const start=Date.parse('2026-10-11T00:00:00.000Z');
const token:ScanToken={chain:'bsc',address:`0x${'a'.repeat(40)}`};
const other:ScanToken={chain:'bsc',address:`0x${'b'.repeat(40)}`};
const iso=(time:number)=>new Date(time).toISOString();
const seed=(patch:Partial<ExitObservationSeed>={}):ExitObservationSeed=>({candidateId:'candidate-1',
  eligibleAt:iso(start-60_000),endsAt:iso(start+86_400_000),symbol:'TEST',...patch});
const price=(at:number,value=100,target:ScanToken=token):ScanPrice=>({...target,priceUsd:value,observedAt:iso(at),source:'gmgn_token_info_sample'});
type Cleanup={after:(fn:()=>void)=>void};
function setup(t:Cleanup,options:ExitShadowOptions={}) {
  const directory=mkdtempSync(join(tmpdir(),'meme-exit-shadow-test-')),path=join(directory,'shadow.sqlite');
  const clock={time:start},opened:ExitShadow[]=[];
  const open=(extra:ExitShadowOptions={})=>{
    const store=new ExitShadow(path,{...options,...extra,now:()=>new Date(clock.time)});opened.push(store);return store;
  };
  t.after(()=>{for(const store of opened)try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});});
  const query=(sql:string,...params:(string|number)[])=>{
    const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare(sql).all(...params);}finally{db.close();}
  };
  return {clock,path,open,query,store:open()};
}

test('shadow validates capacity settings and marks its persistent database private',t=>{
  for(const options of [{maxBytes:1},{maxBytes:NaN},{staleAfterSec:0},{maxPositions:0},{maxPositions:10001}])
    assert.throws(()=>new ExitShadow(':memory:',options),/EXIT_SHADOW_CONFIG_INVALID/);
  const ctx=setup(t);
  assert.equal(statSync(ctx.path).mode&0o777,0o600);
  const summary=ctx.store.summary();
  assert.equal(summary.policyVersion,'adaptive-shadow-v3');assert.equal(summary.mode,'shadow');assert.equal(summary.liveReady,false);
  assert.equal(summary.status.execution,'observation_only');
  assert.equal(summary.status.liveBlockReason,'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED');
});

test('baseline is a fresh post-enable observation; pre-enable, stale, future and invalid prices cannot backfill it',t=>{
  const ctx=setup(t),store=ctx.store;
  store.recordPrice(price(start-1,999),seed());
  store.recordPrice(price(start+1,999),seed());
  store.recordPrice({...price(start),source:'historical_ath'},seed());
  for(const value of [0,-1,NaN,Infinity]) store.recordPrice(price(start,value),seed());
  store.recordPrice(price(start,100,{chain:'bsc',address:'pumpfake'}),seed());
  store.recordPrice(price(start),undefined);
  store.recordPrice(price(start),seed({eligibleAt:iso(start+1)}));
  store.recordPrice(price(start),seed({endsAt:iso(start)}));
  store.recordPrice(price(start),seed({candidateId:'not/an/id'}));
  ctx.clock.time=start+200_000;store.recordPrice(price(start+1,999),seed());
  assert.equal(store.summary().status.samples,0);assert.equal(store.list().items.length,0);
  store.recordPrice(price(ctx.clock.time,3),seed());
  const first=store.list().items[0];
  assert.equal(first.baselinePriceUsd,3);assert.equal(first.startedAt,iso(ctx.clock.time));
  assert.equal(first.eligibleAt,seed().eligibleAt);assert.equal(first.gainPct,0);
  assert.equal(store.summary().status.samples,1);
});

test('same-token candidates share an episode, and duplicate or out-of-order samples never replace the first observation',t=>{
  const ctx=setup(t),store=ctx.store;
  store.recordPrice(price(start),seed());const id=store.list().items[0].id;
  store.recordPrice(price(start,1000),seed({candidateId:'other-candidate'}));
  ctx.clock.time+=1000;
  store.recordPrice(price(ctx.clock.time,101,{chain:'bsc',address:token.address.toUpperCase().replace('0X','0x')}),seed({candidateId:'other-candidate'}));
  store.recordPrice(price(start,5000),undefined);
  assert.equal(store.list().items.length,1);
  const detail=store.detail(id)!;
  assert.equal(detail.sampleCount,2);assert.equal(detail.item.baselinePriceUsd,100);
  assert.equal(detail.item.latestPriceUsd,101);assert.equal(detail.item.candidateId,'candidate-1');
  store.recordPrice(price(ctx.clock.time,7,{...token,chain:'robinhood'}),seed());
  assert.equal(store.list().items.length,2);assert.equal(store.summary().status.samples,3);
});

test('restart preserves baseline, raised protection and partial stages without replaying suggestions',t=>{
  const ctx=setup(t);let store=ctx.store;
  store.recordPrice(price(start),seed());ctx.clock.time+=60_000;store.recordPrice(price(ctx.clock.time,600),undefined);
  const first=store.list().items[0],id=first.id;
  assert.equal(first.remainingPct,80);assert.equal(first.protectionActive,true);
  store.close();store=ctx.open();
  assert.equal(store.summary().status.startedAt,iso(start));assert.equal(store.detail(id)?.item.protectionPriceUsd,first.protectionPriceUsd);
  store.recordPrice(price(ctx.clock.time,600),seed());
  ctx.clock.time+=60_000;store.recordPrice(price(ctx.clock.time,1100),undefined);
  assert.equal(store.detail(id)?.sampleCount,3);assert.equal(store.detail(id)?.item.remainingPct,72);
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='initialized'").length,1);
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='partial_exit'").length,2);
});

test('every observation survives beyond the scan chart limit, with no thinning or invented fill',t=>{
  const ctx=setup(t),store=ctx.store;
  for(let n=0;n<310;n++) {ctx.clock.time=start+n*1000;store.recordPrice(price(ctx.clock.time),seed());}
  const detail=store.detail(store.list().items[0].id)!;
  assert.equal(detail.sampleCount,310);assert.equal(detail.samples.length,310);assert.equal(detail.storedSamplesThinned,false);
  assert.equal(detail.responseTruncated,false);assert.equal(Reflect.get(detail.samples[0],'at'),iso(start));
  assert.equal(Reflect.get(detail.samples.at(-1)!,'at'),iso(ctx.clock.time));
  assert.equal(detail.mode,'shadow');assert.equal(detail.liveReady,false);assert.equal(detail.item.remainingPct,100);
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind') IN ('full_exit','partial_exit')").length,0);
});

test('unavailable prices create an explicit gap and one recovery event, never synthesized prices or continuous coverage',t=>{
  const ctx=setup(t),store=ctx.store;
  store.recordPrice(price(start),seed());const id=store.list().items[0].id;
  ctx.clock.time+=60_000;store.recordError(token,'secret bearer=DO_NOT_STORE');
  assert.equal(store.detail(id)?.item.health,'unavailable');assert.equal(store.detail(id)?.item.lastError,'PRICE_SAMPLE_UNAVAILABLE');
  ctx.clock.time+=60_000;store.recordError(token,'GMGN_REQUEST_FAILED');
  assert.equal(store.detail(id)?.sampleCount,1);
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='price_unavailable'").length,1);
  ctx.clock.time=start+600_000;store.recordPrice(price(ctx.clock.time,110),undefined);
  const recovered=store.detail(id)!;
  assert.equal(recovered.sampleCount,2);assert.equal(recovered.item.health,'fresh');assert.equal(recovered.item.lastError,undefined);
  assert.equal(recovered.item.maxGapSec,600);assert.equal(recovered.samples[1].context.gapSec,600);
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='price_recovered'").length,1);
  ctx.clock.time+=180_001;assert.equal(store.detail(id)?.item.health,'stale');assert.equal(store.summary().status.stale,1);
});

test('delayed, future or invalid error observations cannot overwrite newer healthy prices',t=>{
  const ctx=setup(t),store=ctx.store;
  store.recordPrice(price(start),seed());ctx.clock.time+=60_000;store.recordPrice(price(ctx.clock.time,105),undefined);
  const id=store.list().items[0].id;
  for(const errorAt of [new Date(start),new Date(ctx.clock.time+60_000),new Date(NaN)])
    assert.doesNotThrow(()=>store.recordError(token,'GMGN_REQUEST_FAILED',errorAt));
  assert.equal(store.detail(id)?.item.health,'fresh');assert.equal(store.detail(id)?.item.lastError,undefined);
  assert.equal(store.detail(id)?.item.updatedAt,iso(ctx.clock.time));
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='price_unavailable'").length,0);
});

test('the global last sample time is monotonic across tokens whose observed times differ',t=>{
  const ctx=setup(t),store=ctx.store;
  store.recordPrice(price(start),seed());ctx.clock.time=start+60_000;
  store.recordPrice(price(ctx.clock.time,110),undefined);
  ctx.clock.time+=1000;store.recordPrice(price(start+30_000,3,other),seed({candidateId:'different-token'}));
  assert.equal(store.summary().status.samples,3);
  assert.equal(store.summary().status.lastSampleAt,iso(start+60_000));
});

test('observation expiry never closes an open position or resets it to a new candidate baseline',t=>{
  const ctx=setup(t),store=ctx.store,oldSeed=seed({endsAt:iso(start+300_000)});
  store.recordPrice(price(start),oldSeed);const oldId=store.list().items[0].id;
  ctx.clock.time=start+300_000;store.recordPrice(price(ctx.clock.time,200),oldSeed);
  assert.equal(store.detail(oldId)?.sampleCount,2);assert.equal(store.detail(oldId)?.item.phase,'tracking');
  assert.equal(store.detail(oldId)?.item.remainingPct,100);assert.equal(store.detail(oldId)?.item.exitPlan.scheduledExitAt,undefined);
  ctx.clock.time+=1000;
  const later=seed({candidateId:'candidate-2',eligibleAt:iso(ctx.clock.time),endsAt:iso(start+600_000)});
  store.recordPrice(price(ctx.clock.time,210),later);
  assert.equal(store.summary().status.positions,1);assert.equal(store.detail(oldId)?.item.baselinePriceUsd,100);
  ctx.clock.time+=1000;store.recordPrice(price(ctx.clock.time,50),later);
  assert.equal(store.detail(oldId)?.item.phase,'triggered');assert.equal(store.detail(oldId)?.item.lastEvent?.reason,'HARD_STOP_OBSERVED');
  ctx.clock.time+=1000;store.recordPrice(price(ctx.clock.time,60),later);
  const newItem=store.list().items.find(item=>item.id!==oldId)!;
  assert.equal(store.summary().status.positions,2);assert.equal(newItem.baselinePriceUsd,60);
  assert.equal(newItem.gainPct,0);assert.equal(newItem.candidateId,'candidate-2');assert.equal(store.detail(oldId)?.sampleCount,4);
});

test('a triggered shadow episode keeps comparison samples after restart but never emits a second full exit',t=>{
  const ctx=setup(t);let store=ctx.store;
  store.recordPrice(price(start),seed());ctx.clock.time+=60_000;store.recordPrice(price(ctx.clock.time,50),undefined);
  const id=store.list().items[0].id;
  assert.equal(store.detail(id)?.item.phase,'triggered');assert.equal(store.detail(id)?.item.remainingPct,0);
  ctx.clock.time+=60_000;store.recordPrice(price(ctx.clock.time,1000),undefined);
  store.close();store=ctx.open();ctx.clock.time+=60_000;store.recordPrice(price(ctx.clock.time,2),seed());
  const detail=store.detail(id)!;
  assert.equal(detail.sampleCount,4);assert.equal(detail.item.latestPriceUsd,2);assert.equal(detail.item.remainingPct,0);
  assert.equal(detail.item.peakGainPct,900);assert.equal(detail.item.triggerPeakGainPct,0);
  assert.equal(detail.item.lastEvent?.kind,'full_exit');assert.equal(detail.item.lastEvent?.priceUsd,50);
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='full_exit'").length,1);
  ctx.clock.time+=600_000;store.recordPrice(price(ctx.clock.time,3),undefined);
  assert.equal(store.detail(id)?.item.maxGapSec,600);assert.equal(store.detail(id)?.sampleCount,5);
});

test('capacity failures retain existing observations and persist incomplete-history status across restart',t=>{
  const ctx=setup(t);ctx.store.recordPrice(price(start),seed());const id=ctx.store.list().items[0].id;
  ctx.store.close();let store=ctx.open({maxBytes:16384});ctx.clock.time+=60_000;
  assert.throws(()=>store.recordPrice(price(ctx.clock.time,105),undefined),/EXIT_SHADOW_CAPACITY_REACHED/);
  assert.equal(store.detail(id)?.sampleCount,1);assert.equal(store.detail(id)?.item.latestPriceUsd,100);
  assert.equal(store.summary().status.historyComplete,false);assert.equal(store.summary().status.lastError,'EXIT_SHADOW_CAPACITY_REACHED');
  store.close();store=ctx.open();
  assert.equal(store.detail(id)?.sampleCount,1);assert.equal(store.summary().status.historyComplete,false);
  assert.equal(store.summary().status.lastError,undefined);
  ctx.clock.time+=60_000;store.recordPrice(price(ctx.clock.time,110),undefined);
  assert.equal(store.detail(id)?.sampleCount,2);assert.equal(store.summary().status.lastError,undefined);
  assert.equal(store.summary().status.historyComplete,false);
});

test('closed simulations reject finite prices whose baseline return overflows instead of storing Infinity',t=>{
  const ctx=setup(t),store=ctx.store;
  store.recordPrice(price(start,1e-200),seed());ctx.clock.time+=60_000;
  store.recordPrice(price(ctx.clock.time,4e-201),undefined);const id=store.list().items[0].id;
  assert.equal(store.detail(id)?.item.phase,'triggered');ctx.clock.time+=60_000;
  assert.throws(()=>store.recordPrice(price(ctx.clock.time,1e308),undefined),/EXIT_SHADOW_PRICE_ARITHMETIC_INVALID/);
  const detail=store.detail(id)!;assert.equal(detail.sampleCount,2);assert.equal(detail.item.latestPriceUsd,4e-201);
  assert.ok(Number.isFinite(detail.item.gainPct));assert.ok(Number.isFinite(detail.item.peakGainPct));
  assert.equal(store.summary().status.historyComplete,false);
});

test('price-error events cannot bypass an exhausted disk quota',t=>{
  const ctx=setup(t);ctx.store.recordPrice(price(start),seed());const id=ctx.store.list().items[0].id;
  ctx.store.close();const store=ctx.open({maxBytes:16384});ctx.clock.time+=1000;
  assert.throws(()=>store.recordError(token,'GMGN_REQUEST_FAILED'),/EXIT_SHADOW_CAPACITY_REACHED/);
  assert.equal(store.detail(id)?.sampleCount,1);assert.equal(store.detail(id)?.item.lastError,undefined);
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='price_unavailable'").length,0);
});

test('position capacity never evicts old episodes or reuses their baseline for another token',t=>{
  const ctx=setup(t,{maxPositions:1}),store=ctx.store;
  store.recordPrice(price(start),seed());const id=store.list().items[0].id;
  ctx.clock.time+=1000;
  assert.throws(()=>store.recordPrice(price(ctx.clock.time,200,other),seed({candidateId:'candidate-2'})),/EXIT_SHADOW_POSITION_CAPACITY_REACHED/);
  assert.equal(store.summary().status.positions,1);assert.equal(store.detail(id)?.sampleCount,1);
  assert.equal(store.summary().status.historyComplete,false);
});

test('invalid wallet-pressure identity is retained as an ignored-input reason without blocking the independent price sample',t=>{
  const ctx=setup(t),store=ctx.store;ctx.clock.time+=1000;
  const pressure:WalletPressure={...other,observedAt:iso(ctx.clock.time),windowStartAt:iso(start),windowEndAt:iso(ctx.clock.time),
    trades:[{evidenceId:'different-token:1',wallet:other.address,side:'sell',volumeUsd:500,eventAt:iso(start),
      observedAt:iso(ctx.clock.time),source:'gmgn_wallet_activity'}]};
  store.recordPrice(price(ctx.clock.time),seed(),pressure);
  const detail=store.detail(store.list().items[0].id)!;
  assert.equal(detail.sampleCount,1);assert.equal(detail.item.pressure.status,'unknown');
  assert.equal(detail.samples[0].context.pressureIgnoredReason,'WALLET_PRESSURE_IDENTITY_MISMATCH');
  assert.equal(detail.item.protectionActive,false);assert.equal(detail.item.remainingPct,100);
});

test('shadow performs zero network/order operations and persists normalized evidence without raw vendor reports',t=>{
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw new Error('SHADOW_MUST_NOT_ACCESS_NETWORK');});
  const ctx=setup(t),store=ctx.store,marker='RAW_VENDOR_AND_SIGNING_SECRET_DO_NOT_PERSIST';
  ctx.clock.time+=1000;
  const pressure:WalletPressure={...token,observedAt:iso(ctx.clock.time),windowStartAt:iso(start),windowEndAt:iso(ctx.clock.time),
    trades:[{evidenceId:'trade:123',wallet:other.address,side:'sell',volumeUsd:250,eventAt:iso(start),
      observedAt:iso(ctx.clock.time),source:'gmgn_wallet_activity'}]};
  const quote={...price(ctx.clock.time),rawReport:marker,apiKey:marker};
  const candidate={...seed(),rawReport:marker,privateKey:marker};
  store.recordPrice(quote,candidate,Object.assign(pressure,{rawResponse:marker}));
  const item=store.list().items[0];
  assert.equal(fetchMock.mock.callCount(),0);assert.equal(item.pressure.status,'observed');
  assert.deepEqual(item.pressure.evidenceIds,['trade:123']);assert.equal(item.liveReady,false);
  const tables=ctx.query("SELECT name FROM sqlite_master WHERE type='table'").map(row=>String(row.name));
  assert.ok(tables.every(name=>name.startsWith('exit_shadow_')));
  const serialized=tables.map(name=>JSON.stringify(ctx.query(`SELECT * FROM ${name}`))).join('\n');
  assert.equal(serialized.includes(marker),false);
  assert.equal(serialized.includes('privateKey'),false);assert.equal(serialized.includes('rawResponse'),false);
});


test('elapsed days and missing quotes never liquidate the 72 percent remainder, including across restart',t=>{
  const ctx=setup(t);let store=ctx.store;
  store.recordPrice(price(start,1),seed());ctx.clock.time+=60_000;store.recordPrice(price(ctx.clock.time,6),undefined);
  ctx.clock.time+=60_000;store.recordPrice(price(ctx.clock.time,11),undefined);const id=store.list().items[0].id;
  ctx.clock.time=start+6*3600_000;assert.deepEqual(store.tick(),{created:0,pending:0});store.recordError(token,'ALL_PRICE_SOURCES_UNAVAILABLE');
  const waiting=store.detail(id)!;assert.equal(waiting.item.phase,'tracking');assert.equal(waiting.item.remainingPct,72);
  assert.equal(waiting.item.health,'unavailable');assert.equal(waiting.item.exitPlan.status,'tracking');
  assert.equal(waiting.item.exitPlan.intent,undefined);assert.equal(waiting.item.exitPlan.timeExitEnabled,false);
  assert.equal(waiting.item.exitPlan.maxHoldingAt,undefined);assert.equal(waiting.item.exitPlan.scheduledExitAt,undefined);
  assert.equal(store.trackingTokens().length,1);
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='full_exit'").length,0);
  store.close();store=ctx.open();ctx.clock.time+=86400_000;assert.deepEqual(store.tick(),{created:0,pending:0});
  assert.equal(store.trackingTokens().length,1);assert.equal(store.summary().status.active,1);assert.equal(store.summary().status.stale,1);
  store.recordPrice(price(ctx.clock.time-300_000,500),undefined);store.recordPrice({...price(ctx.clock.time,500),source:'historical_ath'},undefined);
  assert.equal(store.detail(id)?.item.remainingPct,72);
  store.recordPrice(price(ctx.clock.time,12),undefined);assert.equal(store.detail(id)?.item.remainingPct,72);
  assert.equal(store.detail(id)?.item.phase,'tracking');assert.equal(store.summary().status.stale,0);
  ctx.clock.time+=60_000;store.recordPrice(price(ctx.clock.time,0.5),undefined);const closed=store.detail(id)!;
  assert.equal(closed.item.remainingPct,0);assert.equal(closed.item.phase,'triggered');assert.equal(closed.item.exitPlan.status,'observed_closed');
  assert.equal(closed.item.exitPlan.intent,undefined);assert.equal(closed.item.lastEvent?.reason,'HARD_STOP_OBSERVED');
  assert.equal(closed.item.lastEvent?.priceUsd,0.5);assert.equal(closed.item.lastEvent?.sellPct,100);assert.equal(store.trackingTokens().length,0);
  store.recordPrice(price(ctx.clock.time,0.5),undefined);assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='full_exit'").length,1);
});

test('explicit active v1 migration records prior state and only applies future policy; expired legacy remainder is never falsely closed',t=>{
  const ctx=setup(t),store=ctx.store;
  store.recordPrice(price(start),seed());const active=store.list().items[0].id;
  store.recordPrice(price(start,100,other),seed({candidateId:'ended',endsAt:iso(start+30_000)}));const ended=store.list().items.find(i=>i.id!==active)!.id;
  const db=new DatabaseSync(ctx.path);
  for(const [id,target] of [[active,token],[ended,other]] as const){
    const old=stepAdaptiveExit(undefined,{...target,priceUsd:100,observedAt:iso(start),evaluatedAt:iso(start),source:'gmgn_token_info_sample'}).state!;
    db.prepare('UPDATE exit_shadow_positions SET state=? WHERE id=?').run(JSON.stringify(old),id);
  }
  ctx.clock.time+=60_000;assert.equal(store.migrateActiveToV3().migrated,1);assert.equal(store.migrateActiveToV3().migrated,0);
  const migrated=store.detail(active)!;assert.equal(migrated.item.policyVersion,'adaptive-shadow-v3');assert.equal(migrated.item.exitPlan.effectiveAt,iso(ctx.clock.time));
  assert.equal(migrated.item.remainingPct,100);assert.equal(migrated.sampleCount,1);
  assert.equal(store.detail(ended)?.item.phase,'ended');assert.equal(store.detail(ended)?.item.remainingPct,100);
  assert.equal(store.detail(ended)?.item.exitPlan.status,'legacy_policy');
  assert.equal(ctx.query('SELECT * FROM exit_shadow_policy_history').length,1);
  assert.equal(JSON.parse(String(ctx.query('SELECT previous_state FROM exit_shadow_policy_history')[0].previous_state)).policyVersion,'adaptive-shadow-v1');
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='policy_migrated'").length,1);
  store.recordPrice(price(ctx.clock.time-1000,200),undefined);assert.equal(store.detail(active)?.sampleCount,1);
  db.close();
});

for(const reason of ['OBSERVATION_WINDOW_END_OBSERVED','MAX_HOLDING_TIME_OBSERVED'])
test(`V2 ${reason} is cancelled prospectively with 72 percent remainder and prior evidence preserved`,t=>{
  const ctx=setup(t);let store=ctx.store;
  const endsAt=iso(start+(reason==='MAX_HOLDING_TIME_OBSERVED'?86400_000:300_000));
  store.recordPrice(price(start,1),seed({endsAt}));const id=store.list().items[0].id;
  let old=stepAdaptiveExit(undefined,{...price(start,1),evaluatedAt:iso(start),observationEndsAt:endsAt},undefined,ADAPTIVE_SHADOW_V2).state!;
  for(const [at,value] of [[start+60000,6],[start+120000,11]])
    old=stepAdaptiveExit(old,{...price(at,value),evaluatedAt:iso(at)},undefined,ADAPTIVE_SHADOW_V2).state!;
  assert.equal(old.remainingPctOfInitial,72);
  const db=new DatabaseSync(ctx.path);
  db.prepare("UPDATE exit_shadow_positions SET state=?,phase='exit_pending',last_price_at=?,last_price=? WHERE id=?")
    .run(JSON.stringify(old),old.lastObservedAt,old.lastPriceUsd,id);
  const dueAt=iso(start+(reason==='MAX_HOLDING_TIME_OBSERVED'?6*3600_000:300_000));
  const intent={requestedAt:dueAt,dueAt,reason,
    sellPctRemaining:100,remainingPctOfInitial:72,peakPriceUsd:11,policyVersion:ADAPTIVE_SHADOW_V2.version};
  db.prepare('INSERT INTO exit_shadow_exit_intents VALUES(?,?)').run(id,JSON.stringify(intent));
  ctx.clock.time=start+7*3600_000;
  assert.throws(()=>store.recordPrice(price(ctx.clock.time,12),undefined),/EXIT_SHADOW_POLICY_MIGRATION_REQUIRED/);
  assert.equal(store.detail(id)?.item.remainingPct,72);assert.equal(store.detail(id)?.sampleCount,1);
  assert.deepEqual(store.migrateActiveToV3(),{migrated:1,cancelled:1});
  assert.deepEqual(store.migrateActiveToV3(),{migrated:0,cancelled:0});
  const migrated=store.detail(id)!;
  assert.equal(migrated.item.phase,'tracking');assert.equal(migrated.item.remainingPct,72);assert.equal(migrated.sampleCount,1);
  assert.equal(migrated.item.protectionPriceUsd,old.protectionPriceUsd);assert.equal(migrated.item.exitPlan.intent,undefined);
  assert.equal(migrated.item.exitPlan.timeExitEnabled,false);assert.equal(migrated.item.exitPlan.scheduledExitAt,undefined);
  const next=JSON.parse(String(ctx.query('SELECT state FROM exit_shadow_positions WHERE id=?',id)[0].state));
  assert.deepEqual(next.momentumObservations,old.momentumObservations);assert.deepEqual(next.suggestedStages,old.suggestedStages);
  assert.equal(next.momentumEffectiveAt,old.policyEffectiveAt);assert.equal(next.policyEffectiveAt,iso(ctx.clock.time));
  assert.deepEqual(JSON.parse(String(ctx.query('SELECT previous_state FROM exit_shadow_policy_history')[0].previous_state)),JSON.parse(JSON.stringify(old)));
  const cancelled=JSON.parse(String(ctx.query('SELECT data FROM exit_shadow_exit_intents')[0].data));
  assert.equal(cancelled.cancelledAt,iso(ctx.clock.time));assert.equal(cancelled.dueAt,intent.dueAt);
  assert.equal(cancelled.observedAt,undefined);assert.equal(cancelled.observedPriceUsd,undefined);
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='time_exit_cancelled'").length,1);
  db.close();store.close();store=ctx.open();assert.deepEqual(store.tick(),{created:0,pending:0});
  store.recordPrice(price(ctx.clock.time,12),undefined);assert.equal(store.detail(id)?.item.remainingPct,72);
  ctx.clock.time+=60000;store.recordPrice(price(ctx.clock.time,0.5),undefined);assert.equal(store.detail(id)?.item.remainingPct,0);
  const audit=JSON.parse(String(ctx.query('SELECT data FROM exit_shadow_exit_intents')[0].data));
  assert.equal(audit.observedAt,undefined);assert.equal(audit.observedPriceUsd,undefined);
});

test('migration leaves a previously closed V2 time-exit episode and its observed intent unchanged',t=>{
  const ctx=setup(t),store=ctx.store;store.recordPrice(price(start),seed());const id=store.list().items[0].id;
  let old=stepAdaptiveExit(undefined,{...price(start),evaluatedAt:iso(start)},undefined,ADAPTIVE_SHADOW_V2).state!;
  const due=start+6*3600_000;
  old=stepAdaptiveExit(old,{...price(due,110),evaluatedAt:iso(due)},undefined,ADAPTIVE_SHADOW_V2).state!;
  assert.equal(old.shadowClosed,true);
  const db=new DatabaseSync(ctx.path),state=JSON.stringify(old);
  db.prepare("UPDATE exit_shadow_positions SET state=?,phase='triggered',last_price_at=?,last_price=? WHERE id=?")
    .run(state,old.lastObservedAt,old.lastPriceUsd,id);
  const intent=JSON.stringify({requestedAt:iso(due),dueAt:iso(due),reason:'MAX_HOLDING_TIME_OBSERVED',sellPctRemaining:100,
    remainingPctOfInitial:100,peakPriceUsd:110,policyVersion:ADAPTIVE_SHADOW_V2.version,observedAt:iso(due),observedPriceUsd:110});
  db.prepare('INSERT INTO exit_shadow_exit_intents VALUES(?,?)').run(id,intent);db.close();
  ctx.clock.time=due+60000;assert.deepEqual(store.migrateActiveToV3(),{migrated:0,cancelled:0});
  assert.equal(ctx.query('SELECT state FROM exit_shadow_positions WHERE id=?',id)[0].state,state);
  assert.equal(ctx.query('SELECT data FROM exit_shadow_exit_intents WHERE position_id=?',id)[0].data,intent);
  assert.equal(store.detail(id)?.item.policyVersion,ADAPTIVE_SHADOW_V2.version);assert.equal(store.detail(id)?.item.remainingPct,0);
  assert.equal(ctx.query('SELECT * FROM exit_shadow_policy_history').length,0);
});

test('closed comparison capture is sampled at most once per minute without deleting old observations',t=>{
  const ctx=setup(t),store=ctx.store;store.recordPrice(price(start),seed());ctx.clock.time+=1000;
  store.recordPrice(price(ctx.clock.time,50),undefined);const id=store.list().items[0].id;
  for(let n=1;n<=59;n++){ctx.clock.time=start+1000+n*1000;store.recordPrice(price(ctx.clock.time,100+n),undefined);}
  assert.equal(store.detail(id)?.sampleCount,2);ctx.clock.time=start+61_000;store.recordPrice(price(ctx.clock.time,200),undefined);
  assert.equal(store.detail(id)?.sampleCount,3);assert.equal(Reflect.get(store.detail(id)!.samples[0],'priceUsd'),100);
  assert.equal(store.summary().status.closedComparisonIntervalSec,60);
});


test('validated current spot source names are accepted while old DeBot signal-stream prices remain rejected',t=>{
  const ctx=setup(t),store=ctx.store;
  store.recordPrice({...price(start),source:'debot_price_stream_sample'},seed());assert.equal(store.list().items.length,0);
  for(const [i,source] of ['dexscreener_token_pairs_sample','ave_price_stream_sample','debot_token_info_sample'].entries()){
    ctx.clock.time=start+i*1000;store.recordPrice({...price(ctx.clock.time),source},seed());
  }
  assert.equal(store.summary().status.samples,3);assert.equal(store.list().items[0].priceSource,'debot_token_info_sample');
});


test('more than 200 protected targets rotate after failed and successful attempts, including across restart',t=>{
  const ctx=setup(t);let store=ctx.store;
  const targets:ScanToken[]=Array.from({length:201},(_,i)=>({chain:'bsc',address:'0x'+(i+1).toString(16).padStart(40,'0')}));
  for(const target of targets)store.recordPrice(price(start,100,target),seed());
  const initial=store.trackingTokens(200);assert.equal(initial.length,200);
  assert.equal(initial[0].address,targets[0].address);assert.equal(initial.some(t=>t.address===targets[200].address),false);
  ctx.clock.time+=1000;store.recordError(targets[0],'PRICE_NO_FRESH_SOURCE');
  const afterFailure=store.trackingTokens(200);assert.equal(afterFailure[0].address,targets[1].address);
  assert.equal(afterFailure.some(t=>t.address===targets[200].address),true);assert.equal(afterFailure.some(t=>t.address===targets[0].address),false);
  ctx.clock.time+=1000;store.recordPrice(price(ctx.clock.time,105,targets[1]),undefined);
  const afterSuccess=store.trackingTokens(200);assert.equal(afterSuccess[0].address,targets[2].address);
  assert.equal(afterSuccess.some(t=>t.address===targets[0].address),true);assert.equal(afterSuccess.some(t=>t.address===targets[1].address),false);
  assert.deepEqual(store.trackingTokens(2),targets.slice(2,4));
  ctx.clock.time+=1000;store.recordError(targets[2],'PRICE_NO_FRESH_SOURCE');assert.deepEqual(store.trackingTokens(2),targets.slice(3,5));
  store.close();store=ctx.open();assert.deepEqual(store.trackingTokens(2),targets.slice(3,5));
  assert.equal(store.summary().status.positions,201);assert.equal(store.summary().status.triggered,0);
  assert.equal(ctx.query("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='full_exit'").length,0);
});
