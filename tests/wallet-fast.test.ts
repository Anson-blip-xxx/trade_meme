import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {WalletFastJudge,WalletFastTargets,LatencyWindow,type FastWalletEvent} from '../src/wallet-fast.js';
import {WalletFastResearch} from '../src/wallet-fast-research.js';
import {TRANSFER_TOPIC} from '../src/chain-stream-store.js';
import type {Signal} from '../src/types.js';

const at=Date.parse('2026-10-20T01:00:00.000Z'),wallet='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40),token='0x'+'3'.repeat(40),hash='0x'+'4'.repeat(64);
const sol=bs58.encode(new Uint8Array(32).fill(3)),sig=bs58.encode(new Uint8Array(64).fill(4));
test('target residence prevents profile refresh churn, fills vacancies and rotates within the chain cap',()=>{
  const picker=new WalletFastTargets();
  assert.deepEqual(picker.select('bsc',[wallet,wallet,'invalid'],2,at),[wallet]);
  assert.deepEqual(picker.select('bsc',[other,token],2,at+30000),[wallet,other]);
  assert.deepEqual(picker.select('bsc',[token],2,at+60000),[wallet,other]);
  assert.deepEqual(picker.select('robinhood',[token],2,at+60000),[token]);
  assert.deepEqual(picker.select('bsc',[token,other,wallet],2,at+300000),[token,other]);
  assert.deepEqual(picker.select('bsc',[wallet],1,at+330000),[token]);
});
function fixture(){const clock={now:at,mono:10},judge=new WalletFastJudge(()=>clock.now,()=>clock.mono);
  const snapshot={at:new Date(at).toISOString(),validUntil:new Date(at+120000).toISOString(),targets:[
    {chain:'bsc' as const,wallet,groups:['forward_validated'],profileUntil:new Date(at+60000).toISOString()},
    {chain:'solana' as const,wallet:sol,groups:['public_kol'],profileUntil:new Date(at+60000).toISOString()}],tokens:[]};
  judge.update(snapshot);return {judge,clock,snapshot};}
const meta=(time=at)=>({receivedAt:time,receivedMonoAt:5,generation:1,subscriptionId:1});
function log(extra:Record<string,unknown>={}){return {address:token,topics:[TRANSFER_TOPIC,'0x'+other.slice(2).padStart(64,'0'),'0x'+wallet.slice(2).padStart(64,'0')],
  data:'0x'+(100n).toString(16).padStart(64,'0'),transactionHash:hash,blockHash:'0x'+'5'.repeat(64),blockNumber:'0x100',logIndex:'0x0',removed:false,...extra};}
test('EVM preview matches full wallet/chain and never labels a transfer as a verified buy',()=>{
  const {judge}=fixture(),event=judge.judge('bsc','wallet:in',log(),meta())[0];
  assert.equal(event.verdict,'priority_review');assert.equal(event.kind,'token_inflow');assert.equal(event.cachedSafety,'unknown');assert.equal(event.processingMs,5);
  assert.equal(event.buyVerified,false);assert.equal(event.tradingEnabled,false);
  assert.equal(judge.judge('robinhood','wallet:in',log(),meta()).length,0);
  assert.equal(judge.judge('bsc','wallet:in',log({topics:[TRANSFER_TOPIC,'0x'+other.slice(2).padStart(64,'0'),'0x'+other.slice(2).padStart(64,'0')]}),meta()).length,0);
});
test('duplicate notifications deduplicate but a reorg removal is delivered independently',()=>{
  const {judge}=fixture();assert.equal(judge.judge('bsc','wallet:in',log(),meta()).length,1);
  assert.equal(judge.judge('bsc','wallet:in',log(),meta()).length,0);
  assert.equal(judge.judge('bsc','wallet:in',log({removed:true}),meta())[0].verdict,'retracted');
  assert.equal(judge.status().counts.duplicates,1);assert.equal(judge.status().latency.samples,3);
});
test('expired snapshots, malformed events and failed Solana transactions cannot be research triggers',()=>{
  const {judge,clock}=fixture();
  assert.equal(judge.judge('solana','wallet:'+sol,{context:{slot:1},value:{signature:sig,err:{InstructionError:[0,1]}}},meta()).length,0);
  assert.equal(judge.judge('solana','wallet:'+sol,{context:{slot:1},value:{signature:'wrong',err:null}},meta()).length,0);
  assert.equal(judge.judge('bsc','wallet:in',log(),meta(at+1)).length,0);
  clock.now+=120000;assert.equal(judge.judge('bsc','wallet:in',log(),meta(clock.now)).length,0);
  assert.equal(judge.status().counts.failedTransactions,1);assert.equal(judge.status().counts.staleSnapshot,1);
});
test('Solana preview records processed mention only and stale profiles lose priority',()=>{
  const {judge,clock}=fixture();clock.now+=60001;
  const e=judge.judge('solana','wallet:'+sol,{context:{slot:123},value:{signature:sig,err:null,logs:[]}},meta(clock.now))[0];
  assert.equal(e.verdict,'refresh_profile');assert.equal(e.kind,'wallet_mention');assert.equal(e.tokenAddress,undefined);assert.equal(e.commitment,'processed');
});
test('only fresh cached risk blocks; expired pass cannot grant approval and NFT transfers are excluded',()=>{
  const {judge,snapshot,clock}=fixture();judge.update({...snapshot,tokens:[{chain:'bsc',address:token,state:'fail',validUntil:new Date(at+1000).toISOString()}]});
  assert.equal(judge.judge('bsc','wallet:in',log(),meta())[0].verdict,'blocked_cached_risk');
  clock.now+=1001;const later=judge.judge('bsc','wallet:in',log({logIndex:'0x1'}),meta(clock.now))[0];assert.equal(later.cachedSafety,'expired');
  assert.notEqual(later.verdict,'blocked_cached_risk');assert.equal(later.buyVerified,false);
  assert.equal(judge.judge('bsc','wallet:in',log({topics:[...log().topics,'0x'+'0'.repeat(64)],data:'0x'}),meta(clock.now)).length,0);
});
test('latency distribution counts all notices, bounds window and retains lifetime breaches',()=>{
  const latency=new LatencyWindow();latency.add(110);for(let i=0;i<3000;i++)latency.add(2);
  const s=latency.summary();assert.equal(s.samples,3001);assert.equal(s.windowSamples,2048);assert.equal(s.p99Ms,2);assert.equal(s.maxMs,110);assert.equal(s.over100Ms,1);
});
function preview():FastWalletEvent {return fixture().judge.judge('bsc','wallet:in',log(),meta())[0];}
function activity(side='buy',tx=hash){return {activities:[{event_type:side,tx_hash:tx,timestamp:at/1000,token:{address:token},token_amount:'1',cost_usd:'2',price_usd:'2'}]};}
test('slow research requires exact hash/CA match and dispatches a separately labelled wallet signal',async t=>{
  const signals:Signal[]=[],trades:unknown[]=[];const worker=new WalletFastResearch({now:()=>at+1000,ready:()=>true,activity:async()=>activity(),
    onTrades:rows=>trades.push(...rows),onSignal:async s=>{signals.push(s);}});t.after(()=>worker.stop());worker.start();worker.enqueue(preview());await worker.runOnce();
  assert.equal(signals.length,1);assert.equal(signals[0].source,'wallet');assert.equal(signals[0].token.address,token);assert.equal(trades.length,1);
  worker.enqueue(preview());await worker.runOnce();assert.equal(signals.length,1);
});
test('unrelated buys and transfers never create a buy signal; retries use the same observed transaction',async t=>{
  for(const raw of [activity('transferIn'),activity('buy','0x'+'9'.repeat(64))]){
    let signals=0,now=at+1000,calls=0;const worker=new WalletFastResearch({now:()=>now,ready:()=>true,activity:async()=>{calls++;return raw;},onTrades:()=>{},onSignal:async()=>{signals++;}});
    t.after(()=>worker.stop());worker.start();worker.enqueue(preview());await worker.runOnce();now+=16000;await worker.runOnce();
    assert.equal(signals,0);assert.equal(calls,2);assert.equal(worker.status().queued,0);
  }
});
test('retraction during asynchronous enrichment prevents dispatch; queue and request budgets remain bounded',async t=>{
  let release!:(value:unknown)=>void,signals=0;const worker=new WalletFastResearch({now:()=>at+1000,ready:()=>true,activity:()=>new Promise(done=>{release=done;}),onTrades:()=>{},onSignal:async()=>{signals++;}});
  t.after(()=>worker.stop());worker.start();const e=preview();worker.enqueue(e);const done=worker.runOnce();worker.enqueue({...e,removed:true,verdict:'retracted'});release(activity());await done;assert.equal(signals,0);
  for(let i=0;i<50;i++)worker.enqueue({...e,txHash:'0x'+(i+10).toString(16).padStart(64,'0')});
  assert.equal(worker.status().queued,32);assert.equal(worker.status().counts.dropped,18);
});
