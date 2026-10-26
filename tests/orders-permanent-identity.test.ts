import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {OrderStore,type OpeningOrder,type ExitTracking} from '../src/orders.js';

const ca='0x'+'abcdef1234'.repeat(4),other='0x'+'123456abcd'.repeat(4),now=new Date('2026-10-25T10:00:00.000Z');
const input=(eventKey='event-1',mode:'live'|'paper'='live')=>({eventKey,chain:'bsc' as const,tokenAddress:ca,mode,
  wallet:'0x'+'2'.repeat(40),inputToken:'0x'+'0'.repeat(40),inputAmount:'100000000000000000',slippagePct:5,details:{source:'debot'}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'orders-permanent-')),path=join(dir,'orders.sqlite'),stores:OrderStore[]=[];
  return {path,open:()=>{const s=new OrderStore(path);stores.push(s);return s;},close:()=>{for(const s of stores)try{s.close();}catch{}rmSync(dir,{recursive:true,force:true});}};}

test('a committed live attempt permanently blocks every source and wallet even after failure and restart',()=>{
  const f=fixture();try {
    let a=f.open(),b=f.open();const order=a.reserve(input(),10,now).order!;
    assert.equal(b.beginSubmission(order.id,now).order?.status,'submitting');
    a.update(order.id,['submitting'],{status:'failed',failureReason:'ENTRY_ORDER_FAILED'},now);
    assert.equal(a.hasOpeningHistory('bsc',ca,'live'),true);
    for(const mode of ['live','paper'] as const)assert.equal(b.reserve({...input('other-'+mode,mode),wallet:'0x'+'3'.repeat(40),
      tokenAddress:'0x'+ca.slice(2).toUpperCase(),details:{source:'ave'}},10,now).reason,'ASSET_REENTRY_BLOCKED');
    assert.equal(a.update(order.id,['failed'],{status:'prepared'},now),undefined);
    assert.equal(a.update(order.id,['failed'],{status:'submitting'},now),undefined);
    a.close();b.close();a=f.open();
    assert.equal(a.reserve(input('restart'),10,now).reason,'ASSET_REENTRY_BLOCKED');
    assert.equal(a.reserve({...input('another-chain'),chain:'robinhood'},10,now).created,true);
  }finally{f.close();}
});

test('confirmed closed positions never reenter and an existing event remains idempotent',()=>{
  const f=fixture();try {
    const s=f.open();const exit:ExitTracking={policy:{enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:500,sellPct:20},{gainPct:1000,sellPct:10}],stopLoss:{dropPct:40,sellPct:100}},
      state:'awaiting_swap',reasons:[],checkedAt:now.toISOString(),positionClosed:false};
    const order=s.reserve({...input(),exit},10,now).order!;
    s.update(order.id,['prepared'],{status:'confirmed',transactionHash:'0x'+'a'.repeat(64)},now);
    s.updateExit(order.id,exit,{...exit,state:'closed',positionClosed:true,
      balance:{status:'verified',amount:'0',checkedAt:now.toISOString(),reasons:[]},
      assessment:{status:'terminal',reasons:[],found:true,policyMatched:true,hasLiveStop:false,terminal:true,conditions:[],checkedAt:now.toISOString()}},now);
    assert.equal(s.get(order.id)?.exit?.positionClosed,true);
    assert.equal(s.reserve(input('after-close'),10,now).reason,'ASSET_REENTRY_BLOCKED');
    assert.equal(s.reserve(input(),10,now).order?.id,order.id);
    assert.equal(s.list().length,1);
  }finally{f.close();}
});

test('paper claims are permanent for paper but never prevent live; preflight-only failures remain retryable',()=>{
  const f=fixture();try {
    const s=f.open();const rejected=s.reserve(input('no-send'),10,now).order!;
    s.update(rejected.id,['prepared'],{status:'failed',failureReason:'ENTRY_BALANCE_STALE'},now);
    const paper=s.reserve(input('paper','paper'),10,now).order!;
    s.update(paper.id,['prepared'],{status:'paper_open'},now);
    s.update(paper.id,['paper_open'],{status:'failed'},now);
    assert.equal(s.reserve(input('again-paper','paper'),10,now).reason,'ASSET_REENTRY_BLOCKED');
    const live=s.reserve(input('live'),10,now);assert.equal(live.created,true);
    assert.equal(s.beginSubmission(live.order!.id,now).order?.status,'submitting');
  }finally{f.close();}
});

test('external historical import is permanent, idempotent and checked again before an already prepared order can submit',()=>{
  const f=fixture();try {
    const a=f.open(),b=f.open(),order=a.reserve(input(),10,now).order!;
    b.markPreviouslyOpened({chain:'bsc',address:'0x'+ca.slice(2).toUpperCase(),recordId:'controlled:buy-1'});
    b.markPreviouslyOpened({chain:'bsc',address:ca,recordId:'controlled:buy-2'});
    assert.equal(a.beginSubmission(order.id,now).reason,'ASSET_REENTRY_BLOCKED');
    assert.equal(a.update(order.id,['prepared'],{status:'submitting'},now),undefined);
    assert.equal(a.update(order.id,['prepared'],{status:'unknown'},now),undefined);
    assert.equal(a.get(order.id)?.status,'prepared');
    a.update(order.id,['prepared'],{status:'failed'},now);
    assert.equal(b.reserve(input('new'),10,now).reason,'ASSET_REENTRY_BLOCKED');
    const db=new DatabaseSync(f.path,{readOnly:true});try {
      assert.deepEqual({...db.prepare('SELECT mode,chain,token_address,record_id FROM opening_identity_claims').get()!},
        {mode:'live',chain:'bsc',token_address:ca,record_id:'controlled:buy-1'});
    }finally{db.close();}
    assert.throws(()=>a.markPreviouslyOpened({chain:'bsc',address:'invalid',recordId:'secret'}),/^Error: OPENING_HISTORY_IMPORT_INVALID$/);
  }finally{f.close();}
});

test('cross-connection casing changes cannot create a second prepared order and only one submission wins',()=>{
  const f=fixture();try {
    const a=f.open(),b=f.open(),first=a.reserve(input(),10,now).order!;
    assert.equal(b.reserve({...input('second'),tokenAddress:'0x'+ca.slice(2).toUpperCase()},10,now).reason,'ASSET_ALREADY_OPEN');
    assert.equal(a.beginSubmission(first.id,now).order?.status,'submitting');
    assert.equal(b.beginSubmission(first.id,now).reason,'ENTRY_ALREADY_HANDLED');
    a.update(first.id,['submitting'],{status:'unknown'},now);
    assert.equal(b.update(first.id,['unknown'],{status:'submitting'},now),undefined);
  }finally{f.close();}
});

test('legacy closed, unresolved and failed provider attempts are migrated without importing paper into live',()=>{
  const f=fixture();try {
    f.open().close();const db=new DatabaseSync(f.path);try {
      db.exec('DROP TABLE opening_identity_claims');
      const rows:Array<Partial<OpeningOrder>>=[{status:'confirmed',exit:{positionClosed:true} as ExitTracking},
        {status:'unknown'},{status:'failed',providerOrderId:'provider-failed'},{status:'failed',failureReason:'ENTRY_ORDER_EXPIRED'},
        {status:'failed',failureReason:'INTERRUPTED_BEFORE_SUBMIT'},{status:'paper_open',mode:'paper'}];
      rows.forEach((patch,index)=>{const order:OpeningOrder={...input('old-'+index),id:'id-'+index,tokenAddress:'0x'+String(index+1).repeat(40),status:'failed',
        createdAt:now.toISOString(),updatedAt:now.toISOString(),...patch};
        db.prepare('INSERT INTO opening_orders VALUES (?,?,?,?,?,?,?,?,?)').run(order.id,order.eventKey,order.chain,order.tokenAddress,
          order.mode,order.status,order.createdAt,order.updatedAt,JSON.stringify(order));});
    }finally{db.close();}
    const s=f.open(),read=new DatabaseSync(f.path,{readOnly:true});try {
      const claims=read.prepare('SELECT mode,record_id FROM opening_identity_claims ORDER BY record_id').all();
      assert.deepEqual(claims.map(r=>[r.mode,r.record_id]),[['live','id-0'],['live','id-1'],['live','id-2'],['live','id-3'],['paper','id-5']]);
      assert.equal(s.reserve({...input('closed'),tokenAddress:'0x'+'1'.repeat(40)},100,now).reason,'ASSET_REENTRY_BLOCKED');
      assert.equal(s.reserve({...input('legacy-failed'),tokenAddress:'0x'+'3'.repeat(40)},100,now).reason,'ASSET_REENTRY_BLOCKED');
    }finally{read.close();}
  }finally{f.close();}
});

test('Solana claims preserve case and remain separate from an unrelated EVM identity',()=>{
  const f=fixture();try {
    const s=f.open(),sol='So11111111111111111111111111111111111111112';
    s.markPreviouslyOpened({chain:'solana',address:sol,recordId:'controlled-sol'});
    assert.equal(s.reserve({...input(),chain:'solana',tokenAddress:sol},10,now).reason,'ASSET_REENTRY_BLOCKED');
    assert.equal(s.hasOpeningHistory('solana',sol,'live'),true);
    assert.equal(s.hasOpeningHistory('solana',sol.toLowerCase(),'live'),false);
    assert.equal(s.reserve({...input('evm'),tokenAddress:other},10,now).created,true);
  }finally{f.close();}
});

test('attempt lookup excludes preflight failures and a newer prepared reservation for the same token',()=>{
  const f=fixture();try {
    const s=f.open(),old=s.reserve(input('preflight'),10,now).order!;
    s.update(old.id,['prepared'],{status:'failed'},now);
    const fresh=s.reserve(input('fresh'),10,now).order!;
    assert.equal(s.hasOpeningHistory('bsc',ca,'live'),true);
    assert.equal(s.hasAttemptedOpening('bsc',ca),false);
    assert.equal(s.beginSubmission(fresh.id,now).order?.status,'submitting');
    assert.equal(s.hasAttemptedOpening('bsc','0x'+ca.slice(2).toUpperCase()),true);
    s.update(fresh.id,['submitting'],{status:'failed'},now);
    assert.equal(s.hasAttemptedOpening('bsc',ca),true);
  }finally{f.close();}
});

test('external claims atomically share the same live exclusion with ordinary submissions and preserve owner recovery',()=>{
  const f=fixture();try {
    const a=f.open(),b=f.open(),external={chain:'bsc' as const,address:ca,recordId:'controlled-test:run-a'};
    const prepared=a.reserve(input(),10,now).order!;
    assert.equal(b.claimExternalAttempt(external),true);
    assert.equal(a.claimExternalAttempt({...external,address:'0x'+ca.slice(2).toUpperCase()}),true);
    assert.equal(a.claimExternalAttempt({...external,recordId:'controlled-test:run-b'}),false);
    assert.equal(a.beginSubmission(prepared.id,now).reason,'ASSET_REENTRY_BLOCKED');
    a.update(prepared.id,['prepared'],{status:'failed'},now);
    const normal=a.reserve({...input('normal-wins'),tokenAddress:other},10,now).order!;
    assert.equal(a.beginSubmission(normal.id,now).order?.status,'submitting');
    assert.equal(b.claimExternalAttempt({...external,address:other,recordId:'controlled-test:run-c'}),false);
    assert.equal(b.hasAttemptedOpening('bsc',other),true);
  }finally{f.close();}
});

test('multiple legacy attempted buys retain GET receipt reconciliation without allowing resubmission',()=>{
  const f=fixture();try {
    const first=f.open(),one=first.reserve(input(),10,now).order!;
    first.update(one.id,['prepared'],{status:'unknown'},now);first.close();
    const db=new DatabaseSync(f.path);try {
      const two:OpeningOrder={...one,id:'legacy-second-buy',eventKey:'legacy-second',status:'submitted',providerOrderId:'provider-2'};
      db.prepare('INSERT INTO opening_orders VALUES (?,?,?,?,?,?,?,?,?)').run(two.id,two.eventKey,two.chain,two.tokenAddress,two.mode,two.status,
        two.createdAt,two.updatedAt,JSON.stringify(two));
    }finally{db.close();}
    const s=f.open();const confirmed=s.update('legacy-second-buy',['submitted'],{status:'confirmed',transactionHash:'0x'+'b'.repeat(64),
      actualInputAmount:'100',outputAmount:'200'},now);
    assert.equal(confirmed?.status,'confirmed');assert.equal(confirmed?.outputAmount,'200');
    assert.equal(s.update(one.id,['unknown'],{status:'submitting'},now),undefined);
    assert.equal(s.update('legacy-second-buy',['confirmed'],{status:'submitting'},now),undefined);
  }finally{f.close();}
});
