import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNotificationOutcomes} from '../src/notification-outcomes.js';
import type {ReviewNotification,ReviewPrice} from '../src/daily-review.js';

const start=Date.parse('2026-10-20T00:00:00.000Z'),at=(seconds:number)=>new Date(start+seconds*1000).toISOString();
const ca='AbCdEf0000000000000000000000000000000001';
const notify=(source:'ave'|'debot',n:number,seconds=n):ReviewNotification=>({chain:'bsc',address:ca,id:`${source}-${n}`,source,receivedAt:at(seconds),occurredAt:at(seconds)});
const price=(seconds:number,value:number,pool='pool-a',patch:Partial<ReviewPrice>={}):ReviewPrice=>({chain:'bsc',address:ca,at:at(seconds),price:value,source:'dexscreener_pair',pool,...patch});

test('sources count independently and a gap of six hours or more starts a new notification session',()=>{
  const notifications=[notify('debot',1,0),notify('ave',1,1),notify('debot',2,2),notify('ave',2,3),notify('debot',3,4),notify('ave',3,5),
    notify('debot',4,21605),notify('debot',5,21605+21601),notify('debot',6,21605+21602),notify('debot',7,21605+21603)];
  const result=buildNotificationOutcomes(notifications,[],{asOf:at(100000),notificationNumbers:[3],horizonsSec:[3600]});
  assert.equal(result.length,3);assert.deepEqual(result.map(row=>[row.source,row.triggerEventId]),[['debot','debot-3'],['ave','ave-3'],['debot','debot-7']]);
  assert.equal(result[0].address,ca.toLowerCase());assert.equal(result[2].sessionFirstReceivedAt,at(43206));
  const exact=[notify('ave',11,0),notify('ave',12,21600),notify('ave',13,21601),notify('ave',14,21602)];
  assert.equal(buildNotificationOutcomes(exact,[],{asOf:at(100000),notificationNumbers:[3],horizonsSec:[3600]}).length,1);
  assert.equal(buildNotificationOutcomes(exact,[],{asOf:at(100000),notificationNumbers:[3],horizonsSec:[3600]})[0].triggerEventId,'ave-14');
});

test('the first post-trigger quote fixes the pool instead of selecting the later pool with more samples',()=>{
  const notifications=[notify('debot',1),notify('debot',2),notify('debot',3,10)];
  const prices=[price(9,.01,'old'),price(11,10,'pool-a'),price(12,100,'pool-b'),price(13,200,'pool-b'),price(14,300,'pool-b'),price(20,20,'pool-a'),price(3610,15,'pool-a')];
  const row=buildNotificationOutcomes(notifications,prices,{asOf:at(4000),notificationNumbers:[3],horizonsSec:[3600]})[0].horizons[0];
  assert.equal(row.status,'covered');assert.equal(row.pool,'pool-a');assert.equal(row.baselinePriceUsd,10);assert.equal(row.maxGainPct,100);
  assert.equal(row.coverage?.baselineDelaySec,1);assert.equal(row.coverage?.samples,3);
});

test('mature outcomes preserve sampled peak drawdown and whether doubling or minus sixty came first',()=>{
  const notifications=[notify('debot',1),notify('debot',2),notify('debot',3,10)];
  const doubleFirst=[price(10,10),price(20,21),price(30,8),price(40,3),price(3610,5)];
  const outcome=buildNotificationOutcomes(notifications,doubleFirst,{asOf:at(90000),notificationNumbers:[3]})[0];
  for(const horizon of outcome.horizons){assert.equal(horizon.status,'covered');assert.equal(horizon.sampledBarrierOrder,'double_first');
    assert.equal(horizon.firstDoubleAt,at(20));assert.equal(horizon.firstStopAt,at(40));assert.ok(Math.abs(horizon.maxGainPct!-110)<1e-9);
    assert.equal(horizon.minGainPct,-70);assert.equal(horizon.troughAt,at(40));assert.equal(horizon.endGainPct,-50);
    assert.ok(Math.abs(horizon.maxDrawdownPct!-85.71428571428572)<1e-9);}
  const stopFirst=buildNotificationOutcomes(notifications,[price(10,10),price(20,3),price(30,25),price(3610,10)],{asOf:at(4000),notificationNumbers:[3],horizonsSec:[3600]})[0].horizons[0];
  assert.equal(stopFirst.sampledBarrierOrder,'stop_first');assert.equal(stopFirst.firstStopAt,at(20));assert.equal(stopFirst.firstDoubleAt,at(30));
});

test('maturity, sparse coverage and edge gaps remain explicit',()=>{
  const notifications=[notify('ave',1),notify('ave',2),notify('ave',3,10)];
  const prices=[price(20,10),price(30,11),price(3600,12)];
  const row=buildNotificationOutcomes(notifications,prices,{asOf:at(4000),notificationNumbers:[3]})[0];
  assert.equal(row.horizons[0].status,'covered');assert.equal(row.horizons[0].coverage?.maxGapSecIncludingEdges,3570);
  assert.equal(row.horizons[0].coverage?.trailingGapSec,10);assert.equal(row.horizons[0].coverage?.dense,false);
  assert.equal(row.horizons[1].status,'immature');assert.equal(row.horizons[1].mature,false);assert.equal(row.horizons[1].maxGainPct,undefined);
});

test('missing prices, duplicate-time trigger ordering and fixed-pool conflicts are unknown rather than losses',()=>{
  const sameTime=[notify('debot',1,1),notify('debot',2,2),notify('debot',3,2)];
  let row=buildNotificationOutcomes(sameTime,[price(2,10),price(3,20)],{asOf:at(4000),notificationNumbers:[2],horizonsSec:[3600]})[0].horizons[0];
  assert.equal(row.status,'unknown');assert.equal(row.unknownReason,'TRIGGER_ORDER_AMBIGUOUS');assert.equal(row.sampledBarrierOrder,undefined);
  const regular=[notify('debot',1),notify('debot',2),notify('debot',3,10)];
  row=buildNotificationOutcomes(regular,[],{asOf:at(4000),notificationNumbers:[3],horizonsSec:[3600]})[0].horizons[0];
  assert.equal(row.status,'unknown');assert.equal(row.unknownReason,'NO_FIXED_POOL_BASELINE');
  row=buildNotificationOutcomes(regular,[price(10,10),price(20,10),price(20,20),price(3610,10)],{asOf:at(4000),notificationNumbers:[3],horizonsSec:[3600]})[0].horizons[0];
  assert.equal(row.status,'unknown');assert.equal(row.unknownReason,'PRICE_CONFLICT_IN_FIXED_POOL');
});

test('an ambiguous first timestamp cannot silently choose a pool and an unobserved tail is not dense coverage',()=>{
  const notifications=[notify('debot',1),notify('debot',2),notify('debot',3,10)];
  let horizon=buildNotificationOutcomes(notifications,[price(11,10,'pool-a'),price(11,10,'pool-b')],{asOf:at(4000),notificationNumbers:[3],horizonsSec:[3600]})[0].horizons[0];
  assert.equal(horizon.unknownReason,'FIXED_POOL_AMBIGUOUS');
  horizon=buildNotificationOutcomes(notifications,[price(11,10),price(12,11)],{asOf:at(4000),notificationNumbers:[3],horizonsSec:[3600]})[0].horizons[0];
  assert.equal(horizon.status,'covered');assert.equal(horizon.coverage?.trailingGapSec,3598);assert.equal(horizon.coverage?.dense,false);
});

test('duplicate notification IDs do not inflate N and invalid options fail closed',()=>{
  const notifications=[notify('debot',1),notify('debot',1),notify('debot',2)];
  assert.equal(buildNotificationOutcomes(notifications,[],{asOf:at(4000),notificationNumbers:[3],horizonsSec:[3600]}).length,0);
  assert.throws(()=>buildNotificationOutcomes([],[],{asOf:'bad'}),/AS_OF_INVALID/);
  assert.throws(()=>buildNotificationOutcomes([],[],{asOf:at(1),notificationNumbers:[]}),/RANGE_INVALID/);
  assert.throws(()=>buildNotificationOutcomes([],[],{asOf:at(1),sessionGapSec:-1}),/OPTIONS_INVALID/);
});
