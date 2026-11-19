import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {WalletFastJudge,WalletFastTargets,LatencyWindow,type FastWalletEvent} from '../src/wallet-fast.js';
import {WalletFastResearch} from '../src/wallet-fast-research.js';
import {activityResult,type WalletActivity} from '../src/wallet-activity.js';
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
  const many=Array.from({length:135},(_,index)=>'0x'+(index+10).toString(16).padStart(40,'0'));
  assert.equal(new WalletFastTargets().select('bsc',many,135,at).length,135);
  const judge=new WalletFastJudge(()=>at,()=>0);judge.update({at:new Date(at).toISOString(),validUntil:new Date(at+120000).toISOString(),
    targets:many.map(wallet=>({chain:'bsc' as const,wallet,groups:['launcher_candidate']})),tokens:[]});
  assert.equal(judge.status().targets,135);
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
function verified(e=preview(),kind:WalletActivity['classification']='buy'){return activityResult(e,at+1000,kind,['SUPPORTED_SWAP_AND_WALLET_FLOW_CONFIRMED'],{
  eventAt:new Date(at).toISOString(),confirmation:'included',trades:kind==='buy'||kind==='sell'?[{side:kind,tokenAddress:token,amountAtomic:'10',protocol:'four_meme'}]:[]});}
test('chain-verified buys persist before dispatch; quote-token notification does not hide the actual meme purchase',async t=>{
  const signals:Signal[]=[],trades:unknown[]=[];const worker=new WalletFastResearch({now:()=>at+1000,ready:()=>true,verify:async e=>verified(e),onClassification:()=>true,
    onTrades:rows=>trades.push(...rows),onSignal:async s=>{signals.push(s);}});t.after(()=>worker.stop());worker.start();worker.enqueue({...preview(),tokenAddress:other});await worker.runOnce();
  assert.equal(signals.length,1);assert.equal(signals[0].source,'wallet');assert.equal(signals[0].token.address,token);assert.equal(trades.length,1);
  worker.enqueue(preview());await worker.runOnce();assert.equal(signals.length,1);
});

test('paused-chain wallet events never consume receipt requests or record new classifications',async t=>{
  let calls=0,signals=0,records=0;
  const worker=new WalletFastResearch({allowedChains:['solana'],now:()=>at+1000,ready:()=>true,
    verify:async e=>{calls++;return verified(e);},onClassification:()=>{records++;return true;},onTrades:()=>{records++;},
    onSignal:async()=>{signals++;}});
  t.after(()=>worker.stop());worker.start();worker.enqueue(preview());worker.enqueue({...preview(),chain:'robinhood'});
  await worker.runOnce();assert.equal(worker.status().queued,0);assert.equal(calls,0);assert.equal(signals,0);assert.equal(records,0);
});
test('research-only chains persist verified trades without entering signal analysis',async t=>{
  let calls=0,signals=0,records=0;
  const worker=new WalletFastResearch({allowedChains:['solana','bsc'],analysisChains:['solana'],now:()=>at+1000,ready:()=>true,
    verify:async e=>{calls++;return verified(e);},onClassification:()=>true,onTrades:rows=>{records+=rows.length;},
    onSignal:async()=>{signals++;}});
  t.after(()=>worker.stop());worker.start();worker.enqueue(preview());await worker.runOnce();
  assert.equal(calls,1);assert.equal(records,1);assert.equal(signals,0);assert.equal(worker.status().analysisQueued,0);
});
test('bounded receipt queue reserves capacity for Solana, priority profiles and an underrepresented EVM chain',async t=>{
  const worker=new WalletFastResearch({allowedChains:['solana','bsc','robinhood'],analysisChains:['solana'],now:()=>at+1000,ready:()=>false,
    verify:async e=>verified(e),onClassification:()=>true,onTrades:()=>{},onSignal:async()=>{}});
  t.after(()=>worker.stop());worker.start();const base=preview();
  const event=(chain:'bsc'|'solana'|'robinhood',index:number,verdict:FastWalletEvent['verdict']='review_activity'):FastWalletEvent=>({
    ...base,chain,verdict,wallet:'0x'+(index+100).toString(16).padStart(40,'0'),txHash:'0x'+(index+1000).toString(16).padStart(64,'0')});
  for(let index=0;index<64;index++)worker.enqueue(event('bsc',index));
  assert.equal(worker.status().queued,64);assert.deepEqual(worker.status().admission.queuedByChain,{solana:0,bsc:64,robinhood:0});
  worker.enqueue(event('robinhood',100));
  worker.enqueue(event('robinhood',101,'priority_review'));
  worker.enqueue(event('solana',102));
  worker.enqueue(event('bsc',103));
  const status=worker.status();
  assert.equal(status.queued,64);assert.deepEqual(status.admission.queuedByChain,{solana:1,bsc:61,robinhood:2});
  assert.equal(status.counts.evicted,3);assert.equal(status.counts.fairShareEvicted,1);assert.equal(status.counts.priorityEvicted,2);
  assert.equal(status.counts.dropped,1);assert.equal(status.admission.rejectedByChain.bsc,1);
  assert.deepEqual(status.admission.evictedByChain,{solana:0,bsc:3,robinhood:0});
});
test('prospective market profile groups retain priority and evict ordinary burst work',async t=>{
  const worker=new WalletFastResearch({allowedChains:['bsc'],analysisChains:['solana'],now:()=>at+1000,ready:()=>false,
    verify:async e=>verified(e),onClassification:()=>true,onTrades:()=>{},onSignal:async()=>{}});
  t.after(()=>worker.stop());worker.start();const ordinary=preview();
  for(let index=0;index<64;index++)worker.enqueue({...ordinary,verdict:'review_activity',wallet:'0x'+(index+100).toString(16).padStart(40,'0'),
    txHash:'0x'+(index+1000).toString(16).padStart(64,'0')});
  const marketEvent=(group:'market_visible_start'|'market_precursor_pattern',index:number)=>{const judge=new WalletFastJudge(()=>at,()=>5);
    judge.update({at:new Date(at).toISOString(),validUntil:new Date(at+120000).toISOString(),targets:[
      {chain:'bsc',wallet,groups:[group],profileUntil:new Date(at+60000).toISOString()}],tokens:[]});
    return {...judge.judge('bsc','wallet:ignored',log({transactionHash:'0x'+index.toString(16).padStart(64,'0')}),meta())[0],
      txHash:'0x'+index.toString(16).padStart(64,'0')};};
  const visible=marketEvent('market_visible_start',9001),precursor=marketEvent('market_precursor_pattern',9002);
  assert.equal(visible.verdict,'priority_review');assert.equal(precursor.verdict,'priority_review');
  worker.enqueue(visible);worker.enqueue(precursor);const status=worker.status();
  assert.equal(status.queued,64);assert.equal(status.counts.priorityEvicted,2);assert.equal(status.counts.evicted,2);
});
test('Solana receipt verification runs before an older high-profile EVM event',async t=>{
  const order:string[]=[];const worker=new WalletFastResearch({allowedChains:['solana','bsc'],analysisChains:['solana'],now:()=>at+1000,ready:()=>false,
    verify:async e=>{order.push(e.chain);return verified(e,'transfer');},onClassification:()=>true,onTrades:()=>{},onSignal:async()=>{}});
  t.after(()=>worker.stop());worker.start();const base=preview();
  worker.enqueue({...base,verdict:'priority_review'});
  worker.enqueue({...base,chain:'solana',wallet:sol,txHash:sig,verdict:'review_activity'});
  await worker.runOnce();assert.deepEqual(order,['solana']);
});
test('transfers, failures and unknown unsupported actions do not enter trade metrics or repeat vendor queries',async t=>{
  for(const kind of ['received_purchase','distribution','transfer','self_transfer','approval','liquidity','wrap','failed','no_change','unknown'] as const){
    let signals=0,now=at+1000,calls=0,records=0;const worker=new WalletFastResearch({now:()=>now,ready:()=>true,verify:async e=>{calls++;return verified(e,kind);},onClassification:()=>true,onTrades:()=>{records++;},onSignal:async()=>{signals++;}});
    t.after(()=>worker.stop());worker.start();worker.enqueue(preview());await worker.runOnce();now+=16000;await worker.runOnce();
    assert.equal(signals,0);assert.equal(records,0);assert.equal(calls,1);assert.equal(worker.status().queued,0);
  }
});
test('retraction during asynchronous enrichment prevents dispatch; queue and request budgets remain bounded',async t=>{
  let release!:(value:WalletActivity)=>void,signals=0;const worker=new WalletFastResearch({now:()=>at+1000,ready:()=>true,verify:()=>new Promise(done=>{release=done;}),onClassification:()=>true,onTrades:()=>{},onSignal:async()=>{signals++;}});
  t.after(()=>worker.stop(10));worker.start();const e=preview();worker.enqueue(e);const done=worker.runOnce();worker.enqueue({...e,removed:true,verdict:'retracted'});release(verified());await done;assert.equal(signals,0);
  for(let i=0;i<50;i++)worker.enqueue({...e,txHash:'0x'+(i+10).toString(16).padStart(64,'0')});
  assert.equal(worker.status().queued,4);assert.equal(worker.status().counts.perWalletDropped,46);
});
test('retraction while the original classification waits for durable ACK blocks trades and dispatch',async()=>{
  let entered!:()=>void,release!:()=>void,trades=0,signals=0;
  const began=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const worker=new WalletFastResearch({now:()=>at+1000,ready:()=>true,verify:async e=>verified(e),
    onClassification:async result=>{if(result.classification==='buy'){entered();await gate;}return true;},
    onTrades:()=>{trades++;},onSignal:async()=>{signals++;}});
  worker.start();const event=preview();worker.enqueue(event);const running=worker.runOnce();await began;
  worker.enqueue({...event,removed:true,verdict:'retracted'});release();await running;
  assert.equal(trades,0);assert.equal(signals,0);assert.equal(worker.status().analysisQueued,0);
  assert.equal(worker.status().counts.retracted,1);assert.equal(await worker.stop(),true);
});
test('chain classification proceeds while screening is busy; sell evidence is recorded without buy dispatch',async t=>{
  let ready=false,now=at+1000,calls=0,signals=0,records=0;
  const worker=new WalletFastResearch({now:()=>now,ready:()=>ready,verify:async e=>{calls++;return verified(e,calls===1?'buy':'sell');},onClassification:()=>true,onTrades:()=>{records++;},onSignal:async()=>{signals++;}});
  t.after(()=>worker.stop());worker.start();worker.enqueue(preview());await worker.runOnce();assert.equal(calls,1);assert.equal(signals,0);
  now+=1100;worker.enqueue({...preview(),txHash:'0x'+'a'.repeat(64)});await worker.runOnce();assert.equal(calls,2);assert.equal(records,2);assert.equal(worker.status().counts.verifiedSells,1);
  ready=true;await worker.runOnce();assert.equal(signals,1);
});
test('retry pending chain confirmation at most three times; unavailable persistence and mismatched identities cannot dispatch',async t=>{
  let now=at+1000,calls=0,signals=0;const w=new WalletFastResearch({now:()=>now,ready:()=>true,verify:async e=>{calls++;return {...verified(e,'unknown'),retryable:true};},onClassification:()=>true,onTrades:()=>{},onSignal:async()=>{signals++;}});
  t.after(()=>w.stop());w.start();w.enqueue(preview());for(let i=0;i<4;i++){await w.runOnce();now+=4000;}assert.equal(calls,3);assert.equal(signals,0);
  for(const mode of ['persistence','identity']){const worker=new WalletFastResearch({now:()=>at+1000,ready:()=>true,verify:async e=>({...verified(e),...(mode==='identity'?{wallet:other}:{})}),onClassification:()=>false,onTrades:()=>{throw new Error('must not record');},onSignal:async()=>{signals++;}});
    t.after(()=>worker.stop());worker.start();worker.enqueue(preview());await worker.runOnce();assert.equal(signals,0);}
});
test('shutdown drains an in-flight verification and every queued classification through persistence ACK',async()=>{
  let releaseVerify!:()=>void,releasePersistence!:()=>void,verifyCalls=0;
  const verifyGate=new Promise<void>(resolve=>{releaseVerify=resolve;}),persistenceGate=new Promise<void>(resolve=>{releasePersistence=resolve;});
  const persisted:string[]=[];
  const worker=new WalletFastResearch({now:()=>at+1000,ready:()=>false,verify:async e=>{
    verifyCalls++;if(verifyCalls===1)await verifyGate;return verified(e,'transfer');
  },onClassification:async result=>{persisted.push(result.txHash);if(persisted.length===2)await persistenceGate;return true;},onTrades:()=>{},onSignal:async()=>{}});
  worker.start();const first=preview(),second={...first,txHash:'0x'+'b'.repeat(64)};
  worker.enqueue(first);worker.enqueue(second);void worker.runOnce();
  while(verifyCalls<1)await new Promise<void>(resolve=>setImmediate(resolve));
  const stopped=worker.stop(1000);releaseVerify();
  while(persisted.length<2)await new Promise<void>(resolve=>setImmediate(resolve));
  let settled=false;void stopped.then(()=>{settled=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);
  releasePersistence();assert.equal(await stopped,true);assert.deepEqual(persisted,[first.txHash,second.txHash]);
  const status=worker.status();assert.equal(status.queued,0);assert.equal(status.persistenceInFlight,0);
  assert.equal(status.counts.droppedOnStop,0);assert.equal(status.counts.unconfirmedOnStop,0);
});
test('bounded shutdown reports queued drops and an unconfirmed active verification',async()=>{
  let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
  const worker=new WalletFastResearch({now:()=>at+1000,ready:()=>false,verify:async()=>{started();return new Promise<WalletActivity>(()=>{});},
    onClassification:()=>true,onTrades:()=>{},onSignal:async()=>{}});
  worker.start();const first=preview();worker.enqueue(first);worker.enqueue({...first,txHash:'0x'+'c'.repeat(64)});void worker.runOnce();await began;
  assert.equal(await worker.stop(10),false);const status=worker.status();assert.equal(status.stopped,true);assert.equal(status.counts.droppedOnStop,1);
  assert.equal(status.counts.unconfirmedOnStop,1);assert.equal(status.queued,0);
});
test('a persistence ACK arriving after shutdown timeout cannot continue into trade or signal dispatch',async()=>{
  let entered!:()=>void,release!:()=>void,trades=0,signals=0;const began=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const worker=new WalletFastResearch({now:()=>at+1000,ready:()=>true,verify:async e=>verified(e),
    onClassification:async()=>{entered();await gate;return true;},onTrades:()=>{trades++;},onSignal:async()=>{signals++;}});
  worker.start();worker.enqueue(preview());const running=worker.runOnce();await began;
  assert.equal(await worker.stop(10),false);const before=worker.status().counts.unconfirmedOnStop;release();await running;
  const status=worker.status();assert.equal(trades,0);assert.equal(signals,0);assert.equal(status.analysisQueued,0);
  assert.equal(status.counts.unconfirmedOnStop,before);
});
