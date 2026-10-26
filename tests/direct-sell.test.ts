import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {DirectSellService,sellAtomicAmount,formatTokenUnits,type DirectSellOptions,type SellPercentage} from '../src/direct-sell.js';
import type {ManualClosePosition} from '../src/manual-close.js';
import type {TestTradeClient,TestChainReader,SolanaSnapshot,VerifiedSolanaTransaction} from '../src/controlled-test/types.js';

const SOL='So11111111111111111111111111111111111111112',mint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const wallet=bs58.encode(new Uint8Array(32).fill(7)),sellHash=bs58.encode(new Uint8Array(64).fill(9));
const epoch=Date.parse('2026-10-25T10:00:00.000Z');
interface Changes {balance?:string;decimals?:number;unknown?:boolean;pending?:boolean;failed?:boolean;balancesAfterQuote?:string[];quoteWait?:Promise<void>;snapshotWait?:Promise<void>;}
function fixture(changes:Changes={}){
  const dir=mkdtempSync(join(tmpdir(),'direct-sell-')),path=join(dir,'sell.sqlite');let now=epoch,balance=changes.balance??'500000003',slot=103,quotes=0;
  const p:ManualClosePosition={id:'controlled-test:known',chain:'solana',wallet,tokenAddress:mint,tokenDecimals:changes.decimals??5,
    openingTransactionHash:'',name:'BONK',symbol:'BONK',protectionExpected:true};
  const state={pending:changes.pending??false,failed:changes.failed??false,badReceipt:false,badChain:false,gas:'1000000000'};
  const writes:{body:Record<string,unknown>;nonce:string;before:string;after:string}[]=[],reads:string[]=[],messages:{key:string;text:string}[]=[],instances:DirectSellService[]=[];
  const chain:TestChainReader={snapshot:async()=>{reads.push('snapshot');if(changes.snapshotWait)await changes.snapshotWait;
    return {wallet,mint,tokenAmount:balance,nativeLamports:state.gas,decimals:p.tokenDecimals!,slot,nativeSlot:slot,mintAuthority:null,freezeAuthority:null,
      tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',extensions:[],checkedAt:new Date(now).toISOString()} as SolanaSnapshot;},
    verifyTransaction:async r=>{reads.push('verify');const sale=writes.find(w=>w.body.input_amount===r.expectedTokenAmount)!;
      assert.equal(r.side,'sell');assert.equal(r.wallet,wallet);assert.equal(r.mint,mint);assert.ok(sale);
      return {signature:sellHash,wallet,mint,side:'sell',slot,tokenDelta:'-'+(state.badChain?'1':sale.body.input_amount),nativeDelta:'9975000',feeLamports:'25000',
        preTokenAmount:sale.before,postTokenAmount:sale.after,preNativeLamports:'1000000000',postNativeLamports:'1009975000',decimals:p.tokenDecimals!,checkedAt:new Date(now).toISOString()} as VerifiedSolanaTransaction;
    }};
  const client:TestTradeClient={quote:async r=>{reads.push('quote');if(changes.quoteWait)await changes.quoteWait;
    if(changes.balancesAfterQuote?.[quotes]!==undefined)balance=changes.balancesAfterQuote[quotes];quotes++;
    return {input_token:r.inputToken,output_token:r.outputToken,input_amount:r.inputAmount,output_amount:'10000000',min_output_amount:'9500000',slippage:5};},
    swap:async(body,nonce)=>{const db=new DatabaseSync(path,{readOnly:true});try{
      const row=db.prepare('SELECT payload FROM direct_sell_requests WHERE json_extract(payload,\'$.clientId\')=?').get(nonce);assert.ok(row);
      const saved=JSON.parse(String(row.payload));assert.equal(saved.state,'submitting');assert.deepEqual(saved.body,body);
    }finally{db.close();}
    assert.equal(body.condition_orders,undefined);assert.equal(body.input_token,mint);assert.equal(body.output_token,SOL);
    const before=balance;balance=(BigInt(balance)-BigInt(String(body.input_amount))).toString();slot++;
    writes.push({body:structuredClone(body),nonce,before,after:balance});if(changes.unknown)throw Error('SECRET_UPSTREAM_DATA');return {order_id:'sell-'+writes.length};},
    query:async orderId=>{reads.push('query');const sale=writes[Number(orderId.slice(5))-1];assert.ok(sale);
      if(state.failed)return {order_id:orderId,status:'failed',state:40};if(state.pending)return {order_id:orderId,status:'pending'};
      return {order_id:orderId,status:'successful',state:30,hash:sellHash,report:{input_token:mint,output_token:SOL,
        input_amount:state.badReceipt?'1':sale.body.input_amount,output_amount:'10000000',input_token_decimals:p.tokenDecimals,output_token_decimals:9}};},
    strategies:async()=>{assert.fail('direct sell must not read protection orders');},cancel:async()=>{assert.fail('direct sell must not cancel protection orders');}
  };
  const open=(extra:Partial<DirectSellOptions>={})=>{const service=new DirectSellService(path,{positions:()=>[p],client,chain,enqueue:e=>{messages.push(e);return true;},now:()=>now,sleep:async()=>{},pollAttempts:1,...extra});instances.push(service);return service;};
  return {p,path,state,writes,reads,messages,client,chain,open,setBalance:(next:string)=>{balance=next;},advance:(ms:number)=>{now+=ms;},
    close:async()=>{for(const s of instances){await s.stop();s.close();}rmSync(dir,{recursive:true,force:true});}};
}

test('atomic percentages use integer floor without floating point, including values above 2^53 and zero decimals',()=>{
  for(const p of [1,17,25,30,50,75,99,100] as SellPercentage[])assert.equal(sellAtomicAmount('18446744073709551615',p),(18446744073709551615n*BigInt(p)/100n).toString());
  assert.equal(sellAtomicAmount('3',25),'0');assert.equal(sellAtomicAmount('101',75),'75');assert.equal(sellAtomicAmount('101',100),'101');
  for(const invalid of [0,101,1.5,NaN])assert.throws(()=>sellAtomicAmount('101',invalid),/DIRECT_SELL_PERCENTAGE_INVALID/);
  assert.equal(formatTokenUnits('100',0),'100');assert.equal(formatTokenUnits('1000',5),'0.01');assert.equal(formatTokenUnits('0',5),'0');
  assert.equal(formatTokenUnits('18446744073709551615',9),'18446744073.709551615');
});

test('one click directly sells preset and custom percentages of the latest balance, with no protection or opening-proof dependencies',async()=>{
  for(const percentage of [17,25,30,50,75,100] as SellPercentage[]){const f=fixture({balance:'18446744073709551615',decimals:0});try{
    const service=f.open(),ref=service.createAction(f.p.id);assert.match(ref,/^[0-9a-f]{32}$/);assert.equal(f.reads.length,0);
    const accepted=await service.submit(ref,percentage);assert.equal(accepted.state,'accepted');await service.waitForPending();
    assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.input_amount,sellAtomicAmount('18446744073709551615',percentage));
    assert.equal(service.status().requests[0].state,percentage===100?'closed':'completed');assert.equal(service.isClosed(f.p.id),percentage===100);
    assert.equal(!!service.closureEvidence(f.p.id),percentage===100);
    assert.equal(f.writes[0].body.min_output_amount,'9500000');assert.equal(f.writes[0].body.condition_orders,undefined);
    assert.ok(f.messages.some(e=>e.text.includes(percentage===100?'已清仓':'卖出已成交')));assert.equal(statSync(f.path).mode&0o777,0o600);
    if(percentage===100)assert.throws(()=>service.createAction(f.p.id),/DIRECT_SELL_CLOSED/);
  }finally{await f.close();}}
});

test('acceptance is immediate while provider reads are pending; duplicate buttons and processes never double sell',async()=>{
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});const f=fixture({snapshotWait:wait});try{
    const a=f.open(),b=f.open(),ref=a.createAction(f.p.id),other=b.createAction(f.p.id);
    const accepted=await a.submit(ref,25);assert.equal(accepted.state,'accepted');assert.equal(f.writes.length,0);
    const repeated=await b.submit(ref,100),separate=await b.submit(other,75);
    assert.equal(repeated.requestId,accepted.requestId);assert.equal(separate.requestId,accepted.requestId);
    await b.resume();assert.equal(f.writes.length,0);release();await a.waitForPending();assert.equal(f.writes.length,1);
    assert.equal(f.writes[0].body.input_amount,sellAtomicAmount('500000003',25));await b.submit(ref,50);assert.equal(f.writes.length,1);
  }finally{release();await f.close();}
});

test('a fresh action after completed partial sale calculates from the new remaining quantity',async()=>{
  const f=fixture({balance:'101',decimals:0});try{
    const s=f.open();await s.submit(s.createAction(f.p.id),25);await s.waitForPending();assert.equal(f.writes[0].body.input_amount,'25');
    await s.submit(s.createAction(f.p.id),50);await s.waitForPending();assert.equal(f.writes[1].body.input_amount,'38');
    await s.submit(s.createAction(f.p.id),100);await s.waitForPending();assert.equal(f.writes[2].body.input_amount,'38');assert.equal(s.isClosed(f.p.id),true);
  }finally{await f.close();}
});

test('dust does not submit or quote and a new 100% action can sell the smallest whole token unit',async()=>{
  const f=fixture({balance:'1',decimals:0});try{
    const s=f.open();await s.submit(s.createAction(f.p.id),25);await s.waitForPending();assert.equal(s.status().requests[0].reason,'DIRECT_SELL_DUST');
    assert.equal(f.writes.length,0);assert.equal(f.reads.includes('quote'),false);
    await s.submit(s.createAction(f.p.id),100);await s.waitForPending();assert.equal(f.writes[0].body.input_amount,'1');assert.equal(s.isClosed(f.p.id),true);
  }finally{await f.close();}
});

test('a changing balance is requoted once; continuously changing balances do not submit',async()=>{
  const f=fixture({balance:'100',balancesAfterQuote:['80'],decimals:0});try{
    const s=f.open();await s.submit(s.createAction(f.p.id),50);await s.waitForPending();assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.input_amount,'40');assert.equal(f.reads.filter(x=>x==='quote').length,2);
  }finally{await f.close();}
  const g=fixture({balance:'100',balancesAfterQuote:['80','60'],decimals:0});try{
    const s=g.open();await s.submit(s.createAction(g.p.id),50);await s.waitForPending();assert.equal(g.writes.length,0);assert.equal(s.status().requests[0].reason,'DIRECT_SELL_BALANCE_CHANGED');
  }finally{await g.close();}
});

test('unknown submission retains the asset lock across tokens and restarts without a second POST',async()=>{
  const f=fixture({unknown:true});try{
    const s=f.open(),ref=s.createAction(f.p.id);await s.submit(ref,50);await s.waitForPending();assert.equal(s.status().requests[0].state,'unknown');
    assert.equal(s.closureEvidence(f.p.id),undefined);
    const reopened=f.open();await reopened.resume();await reopened.submit(reopened.createAction(f.p.id),100);await reopened.waitForPending();
    assert.equal(f.writes.length,1);assert.equal(reopened.status().requests.length,1);assert.equal(f.messages.some(e=>e.text.includes('SECRET_UPSTREAM_DATA')),false);
  }finally{await f.close();}
});

test('pending partial sale recovery uses GETs and verified exact chain delta, without requiring zero balance',async()=>{
  const f=fixture({pending:true});try{
    const s=f.open();await s.submit(s.createAction(f.p.id),75);await s.waitForPending();assert.equal(s.status().requests[0].state,'pending');
    f.state.pending=false;const reopened=f.open();await reopened.resume();assert.equal(f.writes.length,1);assert.equal(reopened.status().requests[0].state,'completed');
    assert.equal(reopened.isClosed(f.p.id),false);assert.equal(reopened.status().requests[0].remainingAmount,'125000001');
    assert.equal(reopened.latestBalance(f.p.id)?.tokenAmount,'125000001');assert.equal(reopened.latestBalance('missing'),undefined);
  }finally{await f.close();}
});

test('a 100% order is not labelled closed when the verified latest wallet balance is positive',async()=>{
  const f=fixture({pending:true});try{
    const s=f.open();await s.submit(s.createAction(f.p.id),100);await s.waitForPending();
    f.setBalance('7');f.state.pending=false;await s.resume();assert.equal(f.writes.length,1);
    assert.equal(s.status().requests[0].state,'completed');assert.equal(s.isClosed(f.p.id),false);assert.equal(s.latestBalance(f.p.id)?.tokenAmount,'7');
  }finally{await f.close();}
});

test('mismatched provider and chain receipts never mark a sale completed or release its pending lock',async()=>{
  for(const field of ['badReceipt','badChain'] as const){const f=fixture();try{
    f.state[field]=true;const s=f.open();await s.submit(s.createAction(f.p.id),50);await s.waitForPending();assert.equal(s.status().requests[0].state,'pending');
    await s.submit(s.createAction(f.p.id),100);await s.waitForPending();assert.equal(f.writes.length,1);
  }finally{await f.close();}}
});

test('an interrupted pre-submit request recovers as unsubmitted and never sends a POST',async()=>{
  const f=fixture();try{
    const s=f.open(),db=new DatabaseSync(f.path);const r={id:'crashed',identity:`solana:${wallet}:${mint}`,position:f.p,percentage:100,state:'executing',createdAt:epoch,updatedAt:epoch};
    db.prepare('INSERT INTO direct_sell_requests VALUES(?,?,?,?)').run(r.id,r.identity,r.state,JSON.stringify(r));db.close();
    await s.resume();assert.equal(f.writes.length,0);assert.equal(s.status().requests[0].state,'failed');assert.equal(s.status().requests[0].reason,'DIRECT_SELL_INTERRUPTED_BEFORE_SUBMIT');
  }finally{await f.close();}
});

test('legacy pending sell blocks new submission, while cancellation-only legacy work does not block',async()=>{
  const f=fixture();try{
    let pending=true;const s=f.open({isLegacySalePending:()=>pending}),ref=s.createAction(f.p.id);
    assert.match((await s.submit(ref,100)).text,/正在处理/);assert.equal(f.reads.length,0);pending=false;
    await s.submit(ref,100);await s.waitForPending();assert.equal(f.writes.length,1);assert.equal(s.isClosed(f.p.id),true);
  }finally{await f.close();}
});

test('expired or invalid capabilities, unsupported chain, changed wallet and low fee balance cannot submit',async()=>{
  const f=fixture();try{
    const s=f.open({actionTtlMs:1000}),ref=s.createAction(f.p.id);f.advance(1000);assert.match((await s.submit(ref,100)).text,/过期/);
    assert.match((await s.submit('x',100)).text,/失效/);assert.equal(f.writes.length,0);
    f.p.chain='bsc';assert.throws(()=>s.createAction(f.p.id),/DIRECT_SELL_CHAIN_UNSUPPORTED/);f.p.chain='solana';
    const next=s.createAction(f.p.id);f.p.wallet=bs58.encode(new Uint8Array(32).fill(6));assert.match((await s.submit(next,100)).text,/改变/);f.p.wallet=wallet;
    f.state.gas='0';await s.submit(s.createAction(f.p.id),100);await s.waitForPending();assert.equal(f.writes.length,0);assert.equal(s.status().requests[0].reason,'DIRECT_SELL_GAS_BALANCE_LOW');
  }finally{await f.close();}
});

test('submitted read failures retain exact safe diagnostics, never claim unsubmitted, and waiting notifications are emitted once',async()=>{
  const f=fixture();try{
    let unavailable=true;const chain:TestChainReader={...f.chain,verifyTransaction:async request=>{
      if(unavailable)throw Object.assign(new Error('SECRET_PROVIDER_BODY'),{reason:'TEST_SOLANA_TRANSACTION_VERSION_UNSUPPORTED'});
      return f.chain.verifyTransaction(request);
    }};
    const s=f.open({chain}),ref=s.createAction(f.p.id),reply=await s.submit(ref,25);
    assert.match(reply.text,/BONK · 25% · #[0-9a-f]{8}/);await s.waitForPending();
    assert.equal(s.positionState(f.p.id)?.reason,'TEST_SOLANA_TRANSACTION_VERSION_UNSUPPORTED');assert.equal(s.positionState(f.p.id)?.percentage,25);
    assert.equal(f.messages.length,1);assert.match(f.messages[0].text,/平台已确认/);assert.match(f.messages[0].text,/solscan.io\/tx\//);
    assert.match(f.messages[0].text,/GMGN 单号：sell-1/);assert.doesNotMatch(f.messages[0].text,/未提交|卖出失败|SECRET_PROVIDER_BODY|TEST_SOLANA|DIRECT_SELL/);
    await s.resume();assert.equal(f.messages.length,1);
    const again=await s.submit(s.createAction(f.p.id),50);assert.match(again.text,/上一笔 25% 卖出正在确认，本次 50% 未提交/);assert.equal(f.writes.length,1);
    unavailable=false;await s.resume();assert.equal(f.messages.length,2);assert.match(f.messages[1].text,/卖出已成交/);assert.equal(s.positionState(f.p.id)?.state,'completed');
  }finally{await f.close();}
});

test('a balance-read failure after a submitted sell is shown as awaiting verification, never as an unsubmitted order',async()=>{
  const f=fixture();try{
    let snapshots=0;const chain:TestChainReader={...f.chain,snapshot:async(w,m)=>{const b=await f.chain.snapshot(w,m);snapshots++;return snapshots>=3?{...b,checkedAt:new Date(epoch-20000).toISOString()}:b;}};
    const s=f.open({chain});await s.submit(s.createAction(f.p.id),25);await s.waitForPending();
    assert.equal(s.positionState(f.p.id)?.reason,'DIRECT_SELL_BALANCE_UNVERIFIED');assert.equal(f.writes.length,1);
    assert.equal(f.messages.length,1);assert.match(f.messages[0].text,/平台已确认/);assert.doesNotMatch(f.messages[0].text,/未提交|卖出失败/);
  }finally{await f.close();}
});

test('a promptly finalized sale emits only the terminal background notification',async()=>{
  const f=fixture();try{const s=f.open();await s.submit(s.createAction(f.p.id),25);await s.waitForPending();
    assert.equal(f.messages.length,1);assert.match(f.messages[0].text,/卖出已成交/);assert.doesNotMatch(f.messages[0].text,/正在等待|已提交/);
  }finally{await f.close();}
});
