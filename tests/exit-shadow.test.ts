import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ExitShadow,type ExitShadowOptions,type ExitObservationSeed} from '../src/exit-shadow.js';
import type {ScanPrice,ScanToken} from '../src/scan-archive.js';
import type {WalletPressure} from '../src/adaptive-exit.js';

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
  assert.equal(summary.mode,'shadow');assert.equal(summary.liveReady,false);
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

test('expired episodes retain history and require a different later candidate to start a new baseline',t=>{
  const ctx=setup(t),store=ctx.store,oldSeed=seed({endsAt:iso(start+300_000)});
  store.recordPrice(price(start),oldSeed);const oldId=store.list().items[0].id;
  ctx.clock.time=start+300_000;store.recordPrice(price(ctx.clock.time,200),oldSeed);
  assert.equal(store.detail(oldId)?.sampleCount,1);assert.equal(store.detail(oldId)?.item.phase,'ended');
  store.recordPrice(price(ctx.clock.time,200),seed({endsAt:iso(start+600_000)}));
  assert.equal(store.summary().status.positions,1);
  const later=seed({candidateId:'candidate-2',eligibleAt:iso(ctx.clock.time),endsAt:iso(start+600_000)});
  store.recordPrice(price(ctx.clock.time,200),later);
  const newItem=store.list().items.find(item=>item.id!==oldId)!;
  assert.equal(store.summary().status.positions,2);assert.equal(newItem.baselinePriceUsd,200);
  assert.equal(newItem.gainPct,0);assert.equal(newItem.candidateId,'candidate-2');assert.equal(store.detail(oldId)?.sampleCount,1);
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
  assert.equal(store.summary().status.lastError,'EXIT_SHADOW_CAPACITY_REACHED');
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
