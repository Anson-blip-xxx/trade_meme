import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ExitShadow} from '../src/exit-shadow.js';
import {ADAPTIVE_SHADOW_V4,stepAdaptiveExit} from '../src/adaptive-exit.js';
import type {PriceEvidence} from '../src/price-evidence.js';
import type {ScanPrice} from '../src/scan-archive.js';

const origin=Date.parse('2026-11-11T00:00:00.000Z');
const at=(seconds:number)=>new Date(origin+seconds*1000).toISOString();
const token={chain:'bsc' as const,address:'0x1111111111111111111111111111111111111111'};
const poolA='0x2222222222222222222222222222222222222222';
const poolB='0x3333333333333333333333333333333333333333';
const seed={candidateId:'v5-case',eligibleAt:at(0),endsAt:at(86_400)};
const quote=(priceUsd:number,seconds:number,source='gmgn_token_info_sample',poolAddress=poolA):ScanPrice=>({
  ...token,priceUsd,observedAt:at(seconds),source,market:{poolAddress},
});
const chainEvidence=(seconds:number,pool=poolB):PriceEvidence=>({pool,protocol:'pancake_v2',
  quoteAddress:'0x4444444444444444444444444444444444444444',quotePriceUsd:1,anchorAt:at(seconds),
  anchorSource:'vendor_reference',confirmation:'rpc_observed',blockNumber:'0x123',blockHash:`0x${'a'.repeat(64)}`,
  blockTime:at(seconds),pricing:'spot_before_fees_and_slippage'});
type Cleanup={after:(fn:()=>void)=>void};
function setup(t:Cleanup){
  const directory=mkdtempSync(join(tmpdir(),'exit-shadow-v5-')),path=join(directory,'shadow.sqlite'),clock={seconds:0};
  const store=new ExitShadow(path,{now:()=>new Date(origin+clock.seconds*1000)});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const rows=(sql:string,...args:(string|number)[])=>{const db=new DatabaseSync(path,{readOnly:true});
    try{return db.prepare(sql).all(...args);}finally{db.close();}};
  return {clock,store,rows,path};
}

test('a post-exit one-point extreme quote cannot pollute samples, metrics, or frozen adaptive state',t=>{
  const ctx=setup(t);
  ctx.store.recordPrice(quote(0.00001,0),seed);
  ctx.clock.seconds=3;ctx.store.recordPrice(quote(0.000003,3),undefined);
  const id=ctx.store.list().items[0].id;
  const before=String(ctx.rows('SELECT state FROM exit_shadow_positions WHERE id=?',id)[0].state);
  ctx.clock.seconds=63;ctx.store.recordPrice(quote(43.12,63),undefined);
  const quarantined=ctx.store.detail(id)!;
  assert.equal(quarantined.sampleCount,2);
  assert.equal(quarantined.item.latestPriceUsd,0.000003);
  assert.equal(quarantined.item.peakPriceUsd,0.00001);
  assert.equal(String(ctx.rows('SELECT state FROM exit_shadow_positions WHERE id=?',id)[0].state),before);
  assert.equal(ctx.rows("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='price_quarantined'").length,1);

  ctx.clock.seconds=123;ctx.store.recordPrice(quote(0.000004,123),undefined);
  const recovered=ctx.store.detail(id)!;
  assert.equal(recovered.sampleCount,3);
  assert.equal(recovered.item.latestPriceUsd,0.000004);
  assert.equal(recovered.item.peakPriceUsd,0.00001);
  assert.equal(ctx.rows('SELECT * FROM exit_shadow_price_quarantine').length,0);
});

test('a sustained extreme move is admitted after a same-source same-pool follow-up',t=>{
  const ctx=setup(t);ctx.store.recordPrice(quote(0.000001,0),seed);const id=ctx.store.list().items[0].id;
  ctx.clock.seconds=3;ctx.store.recordPrice(quote(1,3),undefined);
  assert.equal(ctx.store.detail(id)?.sampleCount,1);
  ctx.clock.seconds=6;ctx.store.recordPrice(quote(0.9,6),undefined);
  const accepted=ctx.store.detail(id)!;
  assert.equal(accepted.sampleCount,2);
  assert.equal(accepted.item.latestPriceUsd,0.9);
  assert.equal(accepted.item.peakPriceUsd,0.9);
  assert.equal(accepted.item.policyVersion,'adaptive-shadow-v5');
});

test('vendor extremes with different source or pool need a new matching follow-up',t=>{
  const ctx=setup(t);ctx.store.recordPrice(quote(0.000001,0),seed);const id=ctx.store.list().items[0].id;
  ctx.clock.seconds=3;ctx.store.recordPrice(quote(1,3,'gmgn_token_info_sample',poolA),undefined);
  ctx.clock.seconds=6;ctx.store.recordPrice(quote(0.9,6,'ave_price_stream_sample',poolB),undefined);
  assert.equal(ctx.store.detail(id)?.sampleCount,1);
  ctx.clock.seconds=9;ctx.store.recordPrice(quote(0.8,9,'ave_price_stream_sample',poolB),undefined);
  assert.equal(ctx.store.detail(id)?.sampleCount,2);
  assert.equal(ctx.store.detail(id)?.item.latestPriceUsd,0.8);
  assert.equal(ctx.rows("SELECT id FROM exit_shadow_events WHERE json_extract(data,'$.kind')='price_quarantined'").length,2);
});

test('duplicate, older, and over-window extreme follow-ups cannot confirm a quarantined point',t=>{
  const ctx=setup(t);ctx.store.recordPrice(quote(1,0),seed);const id=ctx.store.list().items[0].id;
  ctx.clock.seconds=3;ctx.store.recordPrice(quote(100,3),undefined);
  ctx.clock.seconds=4;ctx.store.recordPrice(quote(90,3),undefined);
  ctx.store.recordPrice(quote(80,2),undefined);
  assert.equal(ctx.store.detail(id)?.sampleCount,1);
  let pending=JSON.parse(String(ctx.rows('SELECT data FROM exit_shadow_price_quarantine WHERE position_id=?',id)[0].data));
  assert.equal(pending.observedAt,at(3));

  ctx.clock.seconds=94;ctx.store.recordPrice(quote(70,94),undefined);
  assert.equal(ctx.store.detail(id)?.sampleCount,1);
  pending=JSON.parse(String(ctx.rows('SELECT data FROM exit_shadow_price_quarantine WHERE position_id=?',id)[0].data));
  assert.equal(pending.observedAt,at(94));
  ctx.clock.seconds=96;ctx.store.recordPrice(quote(60,96),undefined);
  assert.equal(ctx.store.detail(id)?.sampleCount,2);
  assert.equal(ctx.store.detail(id)?.item.latestPriceUsd,60);
});

test('a confirmed quote clears quarantine atomically with the retained sample',t=>{
  const directory=mkdtempSync(join(tmpdir(),'exit-shadow-v5-atomic-')),path=join(directory,'shadow.sqlite'),clock={seconds:0};
  let store=new ExitShadow(path,{now:()=>new Date(origin+clock.seconds*1000)});
  t.after(()=>{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});});
  store.recordPrice(quote(1,0),seed);clock.seconds=3;store.recordPrice(quote(100,3),undefined);
  store.close();store=new ExitShadow(path,{now:()=>new Date(origin+clock.seconds*1000),maxBytes:16_384});
  clock.seconds=6;
  assert.throws(()=>store.recordPrice(quote(90,6),undefined),/EXIT_SHADOW_CAPACITY_REACHED/);
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM exit_shadow_price_quarantine').get()!.n),1);
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM exit_shadow_samples').get()!.n),1);
  }finally{db.close();}
});

test('only independently verified chain evidence may immediately authorize an extreme downward hard stop',t=>{
  const ctx=setup(t);ctx.store.recordPrice(quote(1,0),seed);const id=ctx.store.list().items[0].id;
  ctx.clock.seconds=3;ctx.store.recordPrice({...quote(0.01,3,'debot_token_info_sample'),market:undefined},undefined);
  ctx.clock.seconds=6;ctx.store.recordPrice({...quote(0.009,6,'debot_token_info_sample'),market:undefined},undefined);
  assert.equal(ctx.store.detail(id)?.sampleCount,1);
  assert.equal(ctx.store.detail(id)?.item.remainingPct,100);

  const evidence=chainEvidence(9);
  ctx.clock.seconds=9;ctx.store.recordPrice({...token,priceUsd:0.008,observedAt:at(9),source:'chain_pool_sample',
    metadata:evidence,market:{poolAddress:poolB}},undefined);
  const stopped=ctx.store.detail(id)!;
  assert.equal(stopped.sampleCount,2);assert.equal(stopped.item.remainingPct,0);
  assert.equal(stopped.item.lastEvent?.reason,'HARD_STOP_OBSERVED');
});

test('active V4 keeps its one-quote hard stop while its closed archive quarantines an upward spike',t=>{
  const ctx=setup(t);ctx.store.recordPrice(quote(1,0),seed);const id=ctx.store.list().items[0].id;
  const old=stepAdaptiveExit(undefined,{...token,priceUsd:1,observedAt:at(0),evaluatedAt:at(0),
    source:'gmgn_token_info_sample',poolAddress:poolA},undefined,ADAPTIVE_SHADOW_V4).state!;
  const db=new DatabaseSync(ctx.path);
  try {db.prepare('UPDATE exit_shadow_positions SET state=? WHERE id=?').run(JSON.stringify(old),id);}finally{db.close();}
  ctx.clock.seconds=3;ctx.store.recordPrice(quote(0.01,3),undefined);
  const stopped=ctx.store.detail(id)!;
  assert.equal(stopped.sampleCount,2);assert.equal(stopped.item.remainingPct,0);
  assert.equal(stopped.item.lastEvent?.reason,'HARD_STOP_OBSERVED');
  assert.equal(ctx.rows('SELECT * FROM exit_shadow_price_quarantine').length,0);
  ctx.clock.seconds=63;ctx.store.recordPrice(quote(43.12,63),undefined);
  const archived=ctx.store.detail(id)!;
  assert.equal(archived.sampleCount,2);assert.equal(archived.item.latestPriceUsd,0.01);
  assert.equal(archived.item.peakPriceUsd,1);
  assert.equal(ctx.rows('SELECT * FROM exit_shadow_price_quarantine').length,1);
});

test('a closed V4 archive also quarantines a downward spike before exit-quality horizons can retain it',t=>{
  const ctx=setup(t);ctx.store.recordPrice(quote(1,0),seed);const id=ctx.store.list().items[0].id;
  const old=stepAdaptiveExit(undefined,{...token,priceUsd:1,observedAt:at(0),evaluatedAt:at(0),
    source:'gmgn_token_info_sample',poolAddress:poolA},undefined,ADAPTIVE_SHADOW_V4).state!;
  const db=new DatabaseSync(ctx.path);
  try {db.prepare('UPDATE exit_shadow_positions SET state=? WHERE id=?').run(JSON.stringify(old),id);}finally{db.close();}
  ctx.clock.seconds=3;ctx.store.recordPrice(quote(0.01,3),undefined);
  assert.equal(ctx.store.detail(id)?.sampleCount,2);
  ctx.clock.seconds=303;ctx.store.recordPrice(quote(0.0001,303),undefined);
  const archived=ctx.store.detail(id)!;
  assert.equal(archived.sampleCount,2);assert.equal(archived.item.latestPriceUsd,0.01);
  assert.equal(ctx.rows('SELECT * FROM exit_shadow_price_quarantine').length,1);
});

test('independently verified chain evidence may confirm a persistent extreme across vendor provenance',t=>{
  const ctx=setup(t);ctx.store.recordPrice(quote(0.000001,0),seed);const id=ctx.store.list().items[0].id;
  ctx.clock.seconds=3;ctx.store.recordPrice(quote(1,3,'gmgn_token_info_sample',poolA),undefined);
  const evidence=chainEvidence(6);
  ctx.clock.seconds=6;ctx.store.recordPrice({...token,priceUsd:0.9,observedAt:at(6),source:'chain_pool_sample',metadata:evidence,
    market:{poolAddress:poolB}},undefined);
  const accepted=ctx.store.detail(id)!;
  assert.equal(accepted.sampleCount,2);
  assert.equal(accepted.item.latestPriceUsd,0.9);
});
