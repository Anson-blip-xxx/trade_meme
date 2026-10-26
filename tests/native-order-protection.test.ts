import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import bs58 from 'bs58';
import {OrderStore,type ExitTracking,type OpeningOrder} from '../src/orders.js';
import {parseExitPolicy} from '../src/exit-policy.js';

const now=new Date('2026-10-25T10:00:00Z');
const wallet=bs58.encode(Buffer.alloc(32,3)),mint=bs58.encode(Buffer.alloc(32,4)),otherMint=bs58.encode(Buffer.alloc(32,5));
const signature=bs58.encode(Buffer.alloc(64,6));
const policy=parseExitPolicy({enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}})!;
const newOrder=(eventKey='original',tokenAddress=mint)=>({eventKey,chain:'solana' as const,tokenAddress,mode:'live' as const,wallet,
  inputToken:'So11111111111111111111111111111111111111112',inputAmount:'30000000',slippagePct:5,
  exit:{policy,state:'awaiting_swap' as const,reasons:[],checkedAt:now.toISOString(),positionClosed:false},
  details:{executionStrategy:'third_signal_v1',executionProvider:'pump_native'}});
function opened(store:OrderStore):OpeningOrder {
  const reserved=store.reserve(newOrder(),10,now);assert.equal(reserved.created,true);
  const order=store.beginSubmission(reserved.order!.id,now).order!;assert.ok(order);
  return store.update(order.id,['submitting'],{status:'confirmed',transactionHash:signature,actualInputAmount:'30000000',outputAmount:'1000000000',
    details:{...order.details,nativeFill:{signature,slot:100,inputAmount:'30000000',outputAmount:'1000000000',tokenDecimals:6,
      venue:'pump',commitment:'finalized',confirmedAt:now.toISOString(),subscriptionAccounts:[]}}},now)!;
}
function protection(patch:Partial<NonNullable<ExitTracking['native']>>={}):NonNullable<ExitTracking['native']> {
  return {provider:'pump_native',healthy:true,checkedAt:now.toISOString(),buySignature:signature,buySlot:100,balanceSlot:101,
    balanceAmount:'1000000000',closed:false,...patch};
}

test('native entry remains blocked until matching fresh protection is recorded; degraded or stale health blocks again',()=>{
  const store=new OrderStore(':memory:');
  try {
    const order=opened(store);
    const attempt=(key:string,at=now)=>store.reserve(newOrder(key,otherMint),10,at);
    assert.equal(attempt('missing').reason,'EXIT_PROTECTION_UNVERIFIED');
    assert.equal(store.updateNativeProtection(order.id,protection(),now)?.exit?.state,'monitoring');
    const allowed=attempt('fresh');assert.equal(allowed.created,true);
    store.update(allowed.order!.id,['prepared'],{status:'failed'},now);
    store.updateNativeProtection(order.id,protection({healthy:false}),now);
    assert.equal(attempt('unhealthy').reason,'EXIT_PROTECTION_UNVERIFIED');
    store.updateNativeProtection(order.id,protection(),now);
    assert.equal(attempt('stale',new Date(now.getTime()+90_001)).reason,'EXIT_PROTECTION_UNVERIFIED');
  }finally{store.close();}
});

test('native observations reject wrong buy identity, pre-buy slots, time reversal and nonzero closure',()=>{
  const store=new OrderStore(':memory:');
  try {
    const order=opened(store);store.updateNativeProtection(order.id,protection(),now);
    const saved=store.get(order.id);
    for(const patch of [{buySignature:bs58.encode(Buffer.alloc(64,7))},{buySlot:99},{balanceSlot:99},
      {balanceSlot:NaN},{checkedAt:new Date(now.getTime()-1).toISOString()},
      {checkedAt:new Date(now.getTime()+1001).toISOString()},{closed:true,balanceAmount:'1'}]) {
      assert.equal(store.updateNativeProtection(order.id,protection(patch),now),undefined);
      assert.deepEqual(store.get(order.id),saved);
    }
  }finally{store.close();}
});

test('partial sales keep native positions active and immutable buy fill intact',()=>{
  const store=new OrderStore(':memory:');
  try {
    const original=opened(store);
    const updated=store.updateNativeProtection(original.id,protection({balanceAmount:'750000000',gainPct:80,realizedPnlLamports:'6000000'}),now)!;
    assert.equal(updated.exit?.positionClosed,false);assert.equal(updated.exit?.state,'monitoring');
    assert.equal(updated.outputAmount,'1000000000');assert.equal(updated.actualInputAmount,'30000000');
    assert.deepEqual(updated.details.nativeFill,original.details.nativeFill);
    assert.deepEqual(store.activePositions().map(order=>order.id),[original.id]);
    assert.equal(store.reserve(newOrder('capacity',otherMint),1,now).reason,'OPENING_LIMIT_REACHED');
    assert.equal(store.reserve(newOrder('duplicate'),10,now).reason,'ASSET_ALREADY_OPEN');
  }finally{store.close();}
});

test('native closure releases capacity and remains terminal with permanent no-reentry across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'native-order-protection-')),path=join(dir,'orders.sqlite');
  let store=new OrderStore(path);
  try {
    const original=opened(store);
    const closed=store.updateNativeProtection(original.id,protection({healthy:false,balanceAmount:'0',closed:true,closeReason:'sold'}),now)!;
    assert.equal(closed.exit?.positionClosed,true);assert.equal(closed.exit?.state,'closed');
    assert.deepEqual(store.activePositions(),[]);
    assert.equal(store.updateNativeProtection(original.id,protection(),now),undefined);
    store.close();store=new OrderStore(path);
    assert.equal(store.reserve(newOrder('new-event-same-mint'),1,now).reason,'ASSET_REENTRY_BLOCKED');
    assert.equal(store.hasOpeningHistory('solana',mint,'live'),true);
    assert.equal(store.reserve(newOrder('other-after-close',otherMint),1,now).created,true);
    assert.equal(store.get(original.id)?.exit?.positionClosed,true);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('unresolved native buys cannot acquire healthy or closed order-store protection prematurely',()=>{
  for(const status of ['submitting','submitted','unknown'] as const){
    const store=new OrderStore(':memory:');
    try {
      const reserved=store.reserve(newOrder(),10,now).order!;
      store.beginSubmission(reserved.id,now);
      if(status!=='submitting')store.update(reserved.id,['submitting'],{status},now);
      assert.equal(store.updateNativeProtection(reserved.id,protection(),now),undefined);
      assert.equal(store.updateNativeProtection(reserved.id,protection({balanceAmount:'0',closed:true}),now),undefined);
      assert.equal(store.reserve(newOrder('other',otherMint),10,now).reason,'EXIT_PROTECTION_UNVERIFIED');
    }finally{store.close();}
  }
});
