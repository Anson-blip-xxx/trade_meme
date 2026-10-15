import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OrderStore,type OpeningStatus,type ExitTracking} from '../src/orders.js';
import type {ExitPolicy} from '../src/exit-policy.js';

const ca='0x'+'abcdef1234'.repeat(4),other='0x'+'123456abcd'.repeat(4);
const now=new Date('2026-10-15T06:00:00.000Z');
const input=(eventKey='event-1')=>({eventKey,chain:'bsc' as const,tokenAddress:ca,mode:'paper' as const,
  wallet:'0x'+'2'.repeat(40),inputToken:'0x'+'0'.repeat(40),inputAmount:'100000000000000000',slippagePct:5,details:{}});

test('opening history identifies every unresolved or successful opening status but excludes failed attempts',()=>{
  for(const status of ['prepared','submitting','submitted','confirmed','unknown','paper_open','failed'] satisfies OpeningStatus[]){
    const store=new OrderStore(':memory:');try {
      assert.equal(store.hasOpeningHistory('bsc',ca,'paper'),false);
      const order=store.reserve(input(),10,now).order!;
      if(status!=='prepared')assert.equal(store.update(order.id,['prepared'],{status},now)?.status,status);
      assert.equal(store.hasOpeningHistory('bsc',ca,'paper'),status!=='failed',status);
    }finally{store.close();}
  }
});

test('opening history is scoped by chain, exact token identity and paper versus live mode',()=>{
  const store=new OrderStore(':memory:');try {
    store.reserve(input(),10,now);
    assert.equal(store.hasOpeningHistory('bsc',ca,'paper'),true);
    assert.equal(store.hasOpeningHistory('robinhood',ca,'paper'),false);
    assert.equal(store.hasOpeningHistory('bsc',other,'paper'),false);
    assert.equal(store.hasOpeningHistory('bsc',ca,'live'),false);
    assert.equal(store.hasOpeningHistory('bsc',ca,'off'),false);
    store.reserve({...input('live-bsc'),mode:'live'},10,now);
    assert.equal(store.hasOpeningHistory('bsc',ca,'live'),true);
    store.reserve({...input('paper-rh'),chain:'robinhood'},10,now);
    assert.equal(store.hasOpeningHistory('robinhood',ca,'paper'),true);
    assert.equal(store.hasOpeningHistory('robinhood',ca,'live'),false);
  }finally{store.close();}
});

test('confirmed closed positions remain opening history so repeat notifications cannot buy the token again',()=>{
  const store=new OrderStore(':memory:');try {
    const policy:ExitPolicy={enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:500,sellPct:20},{gainPct:1000,sellPct:10}],stopLoss:{dropPct:40,sellPct:100}};
    const initial:ExitTracking={policy,state:'awaiting_swap',reasons:[],checkedAt:now.toISOString(),positionClosed:false};
    const order=store.reserve({...input(),mode:'live',exit:initial},10,now).order!;
    store.update(order.id,['prepared'],{status:'confirmed',transactionHash:'0x'+'a'.repeat(64),actualInputAmount:order.inputAmount,outputAmount:'100'},now);
    const closed=store.updateExit(order.id,initial,{...initial,state:'closed',positionClosed:true,
      balance:{status:'verified',amount:'0',checkedAt:now.toISOString(),reasons:[]},
      assessment:{status:'terminal',reasons:[],found:true,policyMatched:true,hasLiveStop:false,terminal:true,conditions:[],checkedAt:now.toISOString()}},now);
    assert.equal(closed?.exit?.positionClosed,true);assert.equal(closed?.status,'confirmed');
    assert.equal(store.hasOpeningHistory('bsc',ca,'live'),true);assert.equal(store.hasOpeningHistory('bsc',ca,'paper'),false);
  }finally{store.close();}
});

test('failed attempts alone do not block a later signal while an older successful opening is still respected',()=>{
  const store=new OrderStore(':memory:');try {
    const failed=store.reserve(input('failed'),10,now).order!;store.update(failed.id,['prepared'],{status:'failed'},now);
    assert.equal(store.hasOpeningHistory('bsc',ca,'paper'),false);
    const second=store.reserve(input('new-signal'),10,now);assert.equal(second.created,true);
    assert.equal(store.hasOpeningHistory('bsc',ca,'paper'),true);
    store.update(second.order!.id,['prepared'],{status:'paper_open'},now);
    assert.equal(store.hasOpeningHistory('bsc',ca,'paper'),true);
  }finally{store.close();}
});

test('opening history survives process restart and remains available beyond the dashboard page window',()=>{
  const directory=mkdtempSync(join(tmpdir(),'orders-opening-history-')),path=join(directory,'orders.sqlite');let store=new OrderStore(path);
  try {
    const original=store.reserve(input('old-opening'),200,now).order!;store.update(original.id,['prepared'],{status:'paper_open'},now);
    for(let i=1;i<=55;i++)store.reserve({...input(`other-${i}`),tokenAddress:'0x'+i.toString(16).padStart(40,'0')},200,now);
    assert.equal(store.list().some(order=>order.id===original.id),false);
    assert.equal(store.hasOpeningHistory('bsc',ca,'paper'),true);store.close();store=new OrderStore(path);
    assert.equal(store.hasOpeningHistory('bsc',ca,'paper'),true);assert.equal(store.hasOpeningHistory('bsc',ca,'live'),false);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('EVM address casing cannot evade duplicate-opening detection, while Solana identity remains case-sensitive',()=>{
  const store=new OrderStore(':memory:');try {
    store.reserve(input(),10,now);assert.equal(store.hasOpeningHistory('bsc','0x'+ca.slice(2).toUpperCase(),'paper'),true);
    const sol='So11111111111111111111111111111111111111112';
    store.reserve({...input('sol'),chain:'solana',tokenAddress:sol},10,now);
    assert.equal(store.hasOpeningHistory('solana',sol,'paper'),true);
    assert.equal(store.hasOpeningHistory('solana',sol.toLowerCase(),'paper'),false);
  }finally{store.close();}
});
