import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import {OrderStore,type OpeningOrder,type ExitTracking} from '../src/orders.js';
import type {DirectSellClosureEvidence} from '../src/direct-sell.js';
import {parseExitPolicy} from '../src/exit-policy.js';
const SOL='So11111111111111111111111111111111111111112',mint=bs58.encode(new Uint8Array(32).fill(3)),wallet=bs58.encode(new Uint8Array(32).fill(7));
const buyHash=bs58.encode(new Uint8Array(64).fill(8)),sellHash=bs58.encode(new Uint8Array(64).fill(9));
const created=new Date('2026-10-25T09:00:00.000Z'),now=new Date('2026-10-25T10:00:00.000Z');
const policy=parseExitPolicy({enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:40,sellPct:100}})!;
const input=(eventKey='first',tokenAddress=mint)=>({eventKey,chain:'solana' as const,mode:'live' as const,tokenAddress,wallet,inputToken:SOL,inputAmount:'10000000',slippagePct:5,details:{},
  exit:{policy,state:'attention',checkedAt:created.toISOString(),positionClosed:false,reasons:['EXIT_STRATEGY_ID_MISSING']} as ExitTracking});
function opening(store:OrderStore,status:'confirmed'|'unknown'='confirmed'):OpeningOrder {
  const r=store.reserve(input(),1,created).order!;
  return store.update(r.id,['prepared'],{status,providerOrderId:'buy-order',transactionHash:buyHash,actualInputAmount:'10000000',outputAmount:'500'},created)!;
}
function evidence(o:OpeningOrder):DirectSellClosureEvidence {return {positionId:o.id,requestId:randomUUID(),percentage:100,amount:'500',
  sell:{signature:sellHash,wallet,mint,side:'sell',slot:105,tokenDelta:'-500',nativeDelta:'9975000',feeLamports:'25000',preTokenAmount:'500',postTokenAmount:'0',
    preNativeLamports:'1000000000',postNativeLamports:'1009975000',decimals:5,checkedAt:now.toISOString()},
  finalSnapshot:{wallet,mint,tokenAmount:'0',nativeLamports:'1009975000',decimals:5,slot:105,nativeSlot:105,mintAuthority:null,freezeAuthority:null,
    tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',extensions:[],checkedAt:now.toISOString()}};}

test('verified direct closure frees risk and the position slot without fabricating strategy terminal proof or changing the buy',()=>{
  const dir=mkdtempSync(join(tmpdir(),'order-direct-close-')),path=join(dir,'orders.sqlite'),store=new OrderStore(path),other=new OrderStore(path);
  try{
    const original=opening(store),proof=evidence(original),next=input('next',bs58.encode(new Uint8Array(32).fill(4)));
    assert.equal(store.reserve(next,1,now).reason,'EXIT_PROTECTION_UNVERIFIED');assert.equal(store.activePositions().length,1);assert.equal(store.pending().length,1);
    const result=store.markDirectSellClosed(original.id,proof,now)!;assert.equal(result.status,'confirmed');assert.equal(result.transactionHash,buyHash);assert.equal(result.outputAmount,'500');
    assert.deepEqual(result.exit,original.exit);assert.equal(result.exit?.positionClosed,false);assert.equal(result.exit?.assessment,undefined);
    assert.equal(other.activePositions().length,0);assert.equal(other.pending().length,0);assert.ok(store.hasAttemptedOpening('solana',mint));
    assert.equal(other.reserve(input('same-ca'),1,now).reason,'ASSET_REENTRY_BLOCKED');
    assert.equal(other.reserve(next,1,now).created,true);assert.equal(store.list().find(o=>o.id===original.id)?.status,'confirmed');
    assert.equal(store.markDirectSellClosed(original.id,proof,now)?.id,original.id);
  }finally{store.close();other.close();rmSync(dir,{recursive:true,force:true});}
});

test('unknown buys, partial balances, wrong identity/precision/signature/times and older zero balances cannot release risk',()=>{
  const cases:Array<(e:DirectSellClosureEvidence)=>void>=[
    e=>{e.positionId='other';},e=>{e.requestId='bad';},e=>{e.sell.wallet=bs58.encode(new Uint8Array(32).fill(6));},e=>{e.finalSnapshot.mint=SOL;},
    e=>{e.sell.signature=buyHash;},e=>{e.sell.signature='invalid';},e=>{e.finalSnapshot.decimals=4;},e=>{e.finalSnapshot.tokenAmount='250';},
    e=>{e.amount='250';e.sell.tokenDelta='-250';e.sell.postTokenAmount='250';e.finalSnapshot.tokenAmount='250';e.percentage=50;},
    e=>{e.finalSnapshot.slot=104;},e=>{e.finalSnapshot.nativeSlot=104;},e=>{e.finalSnapshot.checkedAt=new Date(now.getTime()-1).toISOString();},
    e=>{e.sell.checkedAt='invalid';},e=>{e.finalSnapshot.checkedAt=new Date(now.getTime()+6000).toISOString();},
    e=>{e.sell.tokenDelta='-499';},e=>{e.sell.preTokenAmount='501';},e=>{e.sell.nativeDelta='0';},e=>{e.sell.decimals=1.5;},
  ];
  for(const mutate of cases){const store=new OrderStore(':memory:');try{
    const o=opening(store),proof=evidence(o);mutate(proof);assert.equal(store.markDirectSellClosed(o.id,proof,now),undefined);
    assert.equal(store.activePositions().length,1);assert.equal(store.pending().length,1);assert.equal(store.get(o.id)?.details.authoritativeClose,undefined);
  }finally{store.close();}}
  const store=new OrderStore(':memory:');try{const o=opening(store,'unknown');assert.equal(store.markDirectSellClosed(o.id,evidence(o),now),undefined);assert.equal(store.activePositions().length,1);}finally{store.close();}
});

test('close evidence cannot be supplied through ordinary reservations/updates, erased, replaced, or overwritten by strategy polling',()=>{
  const store=new OrderStore(':memory:');try{
    assert.equal(store.reserve({...input(),details:{authoritativeClose:{kind:'direct_sell'}}},1,created).reason,'OPENING_CLOSE_PROOF_RESERVED');
    const o=opening(store),proof=evidence(o);assert.equal(store.update(o.id,['confirmed'],{details:{authoritativeClose:{kind:'direct_sell'}}},now),undefined);
    store.markDirectSellClosed(o.id,proof,now);const authority=store.get(o.id)!.details.authoritativeClose;
    store.update(o.id,['confirmed'],{details:{other:'kept'}},now);assert.deepEqual(store.get(o.id)!.details.authoritativeClose,authority);
    assert.equal(store.update(o.id,['confirmed'],{details:{authoritativeClose:{kind:'direct_sell',requestId:'forged'}}},now),undefined);
    assert.equal(store.markDirectSellClosed(o.id,{...proof,requestId:randomUUID()},now),undefined);
    store.updateExit(o.id,o.exit,{...o.exit!,state:'monitoring'},now);assert.deepEqual(store.get(o.id)!.exit,o.exit);assert.equal(store.activePositions().length,0);
  }finally{store.close();}
});
