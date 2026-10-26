import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Keypair,PublicKey,TransactionInstruction,VersionedTransaction} from '@solana/web3.js';import bs58 from 'bs58';
import {NativeExecutor,verifyNativeFill,type NativeExecuteRequest} from '../src/native-solana/executor.js';import {NativeJournal,type NativeJournalRecord} from '../src/native-solana/journal.js';
import {NativeSigner} from '../src/native-solana/signer.js';
import {NATIVE_EXECUTION_STAGES,type NativeExecutionTiming} from '../src/native-solana/timing.js';
import type {NativeSwapPlan} from '../src/native-solana/pump.js';
import {ed25519} from '@noble/curves/ed25519';
import {userVolumeAccumulatorPda as pumpSwapUserVolumeAccumulatorPda} from '@pump-fun/pump-swap-sdk';
const kp=Keypair.fromSeed(new Uint8Array(32).fill(1)),wallet=kp.publicKey.toBase58(),mint=Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const ata=Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58(),tip=Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
const blockhash=Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58(),pump='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL='So11111111111111111111111111111111111111112';
function fixture(t:any,options:{sendError?:boolean;badSimulation?:boolean;badPlan?:boolean;side?:'buy'|'sell';monotonicNow?:()=>number}={}){
 const dir=mkdtempSync(join(tmpdir(),'native-executor-')),keyfile=join(dir,'key.json'),journal=join(dir,'state.sqlite');
 writeFileSync(keyfile,JSON.stringify([...kp.secretKey]),{mode:0o600});
 const state={now:Date.now(),sends:0,plans:0,calls:[] as string[],sent:[] as string[],status:null as any,height:100,transaction:undefined as any};
 const request:NativeExecuteRequest={intentId:'intent',orderId:'order',wallet,mint,side:options.side??'buy',amount:options.side==='sell'?'1000':'10000000',slippageBps:500};
 const plan=async(r:any):Promise<NativeSwapPlan>=>{state.plans++;return {venue:'pump',mint:r.mint,side:r.side,inputAmount:r.amount,expectedOutputAmount:r.side==='buy'?'1000':'10000000',minimumOutputAmount:r.side==='buy'?'950':'9500000',
  quotedAt:new Date(state.now).toISOString(),tokenDecimals:6,subscriptionAccounts:[ata],instructions:[new TransactionInstruction({programId:new PublicKey(options.badPlan?tip:pump),
   keys:[{pubkey:kp.publicKey,isSigner:true,isWritable:true},{pubkey:new PublicKey(mint),isSigner:false,isWritable:false},{pubkey:new PublicKey(ata),isSigner:false,isWritable:true}],data:Buffer.from([1])})]};};
 const fetcher:typeof fetch=async(input,init)=>{const url=new URL(String(input)),body=JSON.parse(String(init?.body));state.calls.push(body.method);let result:any;
  if(url.hostname.endsWith('jito.wtf')){
   if(body.method==='getTipAccounts')result=[tip];else {assert.equal(body.method,'sendTransaction');assert.equal(url.search,'?bundleOnly=true');state.sends++;state.sent.push(body.params[0]);
    const signed=VersionedTransaction.deserialize(Buffer.from(body.params[0],'base64'));const sig=bs58.encode(signed.signatures[0]);
    const db=new NativeJournal(journal);try{const stored=db.get(request.intentId);assert.equal(stored?.rawTransaction,body.params[0]);assert.equal(stored?.signature,sig);assert.equal(stored?.armed,true);}finally{db.close();}
    if(options.sendError)throw Error('network-sensitive-detail');result=sig;
   }
  }else {assert.equal(url.hostname,'rpc.test');switch(body.method){
   case 'getGenesisHash':result='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';break;
   case 'getLatestBlockhash':result={context:{slot:100},value:{blockhash,lastValidBlockHeight:250}};break;
   case 'getFeeForMessage':result={context:{slot:100},value:10000};break;
   case 'getBalance':result={context:{slot:100},value:1000000000};break;
   case 'simulateTransaction':{
    const unsigned=VersionedTransaction.deserialize(Buffer.from(body.params[0],'base64'));assert.equal(body.params[1].sigVerify,false);
    assert.ok(unsigned.signatures.every(signature=>signature.every(byte=>byte===0)),'public RPC must never receive executable signed bytes');
    result={context:{slot:100},value:{err:options.badSimulation?{InstructionError:[0,'bad']}:null}};break;}
   case 'getSignatureStatuses':result={context:{slot:300},value:[state.status]};break;
   case 'getBlockHeight':result=state.height;break;
   case 'getTransaction':result=state.transaction;break;
   default:throw Error('unexpected '+body.method);
  }}return Response.json({jsonrpc:'2.0',id:body.id,result});
 };
 const opts={rpcUrl:'https://rpc.test',jitoUrl:'https://mainnet.block-engine.jito.wtf',keypairFile:keyfile,wallet,journalPath:journal,
  tipLamports:'1000',priorityFeeLamports:'5000',jitoPacingMs:0,fetcher,now:()=>new Date(state.now),plan,monotonicNow:options.monotonicNow};
 let executor=new NativeExecutor(opts);t.after(async()=>{await executor.stop();executor.close();rmSync(dir,{recursive:true,force:true});});
 const restart=async()=>{await executor.stop();executor.close();executor=new NativeExecutor(opts);return executor;};
 return {executor,state,request,journal,restart};
}
function txProof(signature:string,side:'buy'|'sell',options:{rent?:boolean;small?:boolean;wsol?:boolean}={}){
 const fee=10000,tipAmount=1000,nativeAmount=options.small?500:10000000,tokenAmount=1000,rent=2039280;
 const keys=[{pubkey:wallet,signer:true,writable:true},{pubkey:ata,signer:false,writable:true}];
 const pre=[1000000000,side==='buy'&&options.rent?0:rent],post=[1000000000+(side==='buy'?-nativeAmount:nativeAmount)-fee-tipAmount, rent];
 if(side==='buy'&&options.rent)post[0]-=rent;
 const balance=(amount:number,index=1,m=mint)=>({accountIndex:index,mint:m,owner:wallet,programId:TOKEN,uiTokenAmount:{amount:String(amount),decimals:m===SOL?9:6}});
 const preToken=side==='buy'?[]:[balance(tokenAmount)],postToken=[balance(side==='buy'?tokenAmount:0)];
 if(options.wsol){keys.push({pubkey:new PublicKey(new Uint8Array(32).fill(9)).toBase58(),signer:false,writable:true});pre.push(rent);post.push(rent+nativeAmount);post[0]-=nativeAmount;
  preToken.push(balance(0,2,SOL));postToken.push(balance(nativeAmount,2,SOL));}
 return {version:0,slot:105,transaction:{signatures:[signature],message:{accountKeys:keys}},meta:{err:null,fee,preBalances:pre,postBalances:post,preTokenBalances:preToken,postTokenBalances:postToken}};
}
test('native sends one signed protected transaction, journals before send and exposes no bytes',async t=>{const f=fixture(t);assert.deepEqual(f.executor.readiness(),{ready:true});assert.equal(f.state.calls.length,0);
 let guards=0;const result=await f.executor.execute({...f.request,beforeBroadcast:async()=>{guards++;assert.equal(f.state.sends,0);assert.ok(f.state.calls.includes('simulateTransaction'));}});
 assert.equal(result.status,'submitted');assert.equal(guards,1);assert.equal(f.state.sends,1);assert.equal(f.state.calls.filter(m=>m==='sendTransaction').length,1);
 assert.ok(result.signature);assert.ok(!JSON.stringify(result).includes('rawTransaction'));assert.ok(!JSON.stringify(f.executor.listPending()).includes(f.state.sent[0]));
 const signed=VersionedTransaction.deserialize(Buffer.from(f.state.sent[0],'base64'));assert.ok(signed.message.staticAccountKeys.some(k=>k.toBase58().startsWith('jitodontfront')));
 assert.equal(ed25519.verify(signed.signatures[0],signed.message.serialize(),kp.publicKey.toBytes()),true);
 const again=await f.executor.execute(f.request);assert.equal(again.signature,result.signature);assert.equal(f.state.sends,1);assert.equal(f.state.plans,1);
});
test('simulation failure, invalid plan, failed final guard and shutdown never send',async t=>{
 for(const opts of [{badSimulation:true},{badPlan:true}]){const f=fixture(t,opts);const r=await f.executor.execute(f.request);assert.equal(r.status,'failed');assert.equal(f.state.sends,0);}
 const f=fixture(t);const rejected=await f.executor.execute({...f.request,beforeBroadcast:async()=>{throw Error('ENTRY_HOLDER_RISK_STALE');}});assert.equal(rejected.failureReason,'ENTRY_HOLDER_RISK_STALE');assert.equal(f.state.sends,0);
 const restarted=await f.restart();await restarted.reconcile(f.request.intentId);assert.equal(f.state.sends,0);
 const stopped=fixture(t);await stopped.executor.stop();assert.equal((await stopped.executor.execute(stopped.request)).failureReason,'NATIVE_EXECUTOR_STOPPED');
});
test('unknown send recovers using exactly the original bytes and signature; never re-plans',async t=>{const f=fixture(t,{sendError:true});const result=await f.executor.execute(f.request);
 assert.equal(result.status,'unknown');assert.ok(result.signature);assert.ok(!JSON.stringify(result).includes('sensitive'));f.state.now+=3000;
 const restart=await f.restart();const recovered=await restart.reconcile(f.request.intentId);assert.equal(recovered.status,'unknown');assert.equal(f.state.sends,2);
 assert.equal(f.state.sent[0],f.state.sent[1]);assert.equal(f.state.plans,1);assert.equal(recovered.signature,result.signature);
});
test('definitive expiration stops rebroadcast and never creates a replacement buy',async t=>{const f=fixture(t);await f.executor.execute(f.request);f.state.now+=3000;f.state.height=251;
 const result=await f.executor.reconcile(f.request.intentId);assert.equal(result.status,'failed');assert.equal(result.failureReason,'NATIVE_TRANSACTION_EXPIRED');
 await f.executor.execute(f.request);await f.executor.reconcile(f.request.intentId);assert.equal(f.state.sends,1);assert.equal(f.state.plans,1);
});
test('confirmed provisional fill is distinct from finalized completion and refunds rent in actual cost',async t=>{const f=fixture(t),result=await f.executor.execute(f.request);
 f.state.transaction=txProof(result.signature!,'buy',{rent:true});f.state.status={slot:105,err:null,confirmationStatus:'confirmed'};
 const provisional=await f.executor.reconcile(f.request.intentId);assert.equal(provisional.status,'submitted');assert.equal(provisional.inputAmount,undefined);
 assert.equal(provisional.provisional?.inputAmount,'10000000');assert.equal(provisional.provisional?.outputAmount,'1000');
 f.state.status.confirmationStatus='finalized';const final=await f.executor.reconcile(f.request.intentId);assert.equal(final.status,'confirmed');assert.equal(final.inputAmount,'10000000');
 assert.equal(final.outputAmount,'1000');assert.equal(final.provisional,undefined);assert.equal(final.networkFeeLamports,'10000');assert.equal(f.executor.listPending().length,0);
});
test('finalized failure and malformed fill do not report sale completion',async t=>{
 const a=fixture(t);await a.executor.execute(a.request);a.state.status={slot:105,err:{InstructionError:[1,'bad']},confirmationStatus:'finalized'};
 assert.equal((await a.executor.reconcile(a.request.intentId)).failureReason,'NATIVE_TRANSACTION_FAILED');
 const b=fixture(t);const sent=await b.executor.execute(b.request);b.state.status={slot:105,err:null,confirmationStatus:'finalized'};b.state.transaction=txProof(sent.signature!,'buy');
 b.state.transaction.meta.postTokenBalances[0].owner=tip;assert.equal((await b.executor.reconcile(b.request.intentId)).status,'unknown');
});
test('concurrent sells share one unresolved lock across executor handles',async t=>{const f=fixture(t,{side:'sell'});
 const results=await Promise.all([f.executor.execute(f.request),f.executor.execute({...f.request,intentId:'other'})]);
 assert.equal(f.state.sends,1);assert.ok(results.some(r=>r.failureReason==='NATIVE_SELL_IN_PROGRESS'));
});
test('fill accounting supports negative net SOL small sales, WSOL receipts and exact bigint token precision',()=>{
 const signature=bs58.encode(new Uint8Array(64).fill(6));const r:NativeJournalRecord={intentId:'i',orderId:'o',wallet,mint,side:'sell',amount:'1000',slippageBps:500,status:'submitted',
 createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),signature,tokenDecimals:6,tipLamports:'1000',priorityFeeLamports:'5000',minimumOutputAmount:'400'};
 const small=verifyNativeFill(txProof(signature,'sell',{small:true}),r,105,new Date());assert.equal(small.actualNativeAmount,'500');assert.equal((small.trade as any).nativeDelta,'-10500');
 r.minimumOutputAmount='9500000';assert.equal(verifyNativeFill(txProof(signature,'sell',{wsol:true}),r,105,new Date()).outputAmount,'10000000');
 const large=txProof(signature,'sell');large.meta.preTokenBalances[0].uiTokenAmount.amount='9007199254740993';r.amount='9007199254740993';
 assert.equal(verifyNativeFill(large,r,105,new Date()).inputAmount,'9007199254740993');
});
test('fill accounting cancels only the official first-created PumpSwap volume PDA rent',()=>{
 const signature=bs58.encode(new Uint8Array(64).fill(6));
 const r:NativeJournalRecord={intentId:'i',orderId:'o',wallet,mint,side:'buy',amount:'10000000',slippageBps:500,status:'submitted',
  createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),signature,venue:'pumpswap',tokenDecimals:6,tipLamports:'1000',
  priorityFeeLamports:'5000',minimumOutputAmount:'950'};
 const proof=txProof(signature,'buy',{rent:true}),volume=pumpSwapUserVolumeAccumulatorPda(new PublicKey(wallet)).toBase58(),pdaRent=1346200;
 proof.transaction.message.accountKeys.push({pubkey:volume,signer:false,writable:true});proof.meta.preBalances.push(0);proof.meta.postBalances.push(pdaRent);
 proof.meta.postBalances[0]-=pdaRent;
 assert.equal(verifyNativeFill(proof,r,105,new Date()).inputAmount,'10000000');
 const unrelated=structuredClone(proof);unrelated.transaction.message.accountKeys.at(-1)!.pubkey=tip;
 assert.throws(()=>verifyNativeFill(unrelated,r,105,new Date()),/NATIVE_FILL_AMOUNTS_UNVERIFIED/);
 const last=proof.meta.preBalances.length-1;proof.meta.preBalances[last]=pdaRent;proof.meta.postBalances[last]=pdaRent;proof.meta.postBalances[0]+=pdaRent;
 assert.equal(verifyNativeFill(proof,r,105,new Date()).inputAmount,'10000000');
});
test('restart cannot broadcast signed bytes that were never armed by final entry guard',async t=>{const f=fixture(t);const db=new NativeJournal(f.journal),stamp=new Date(f.state.now).toISOString();
 db.reserve({...f.request,status:'unknown',createdAt:stamp,updatedAt:stamp,rawTransaction:'AQID',signature:bs58.encode(new Uint8Array(64).fill(6))},'owner',f.state.now);
 db.release(f.request.intentId,'owner');db.close();const result=await f.executor.reconcile(f.request.intentId);assert.equal(result.failureReason,'NATIVE_INTERRUPTED_BEFORE_BROADCAST');assert.equal(f.state.sends,0);
});
test('signing occurs only after simulation and the last guard have passed',async t=>{
 const original=NativeSigner.prototype.sign;let signs=0;
 NativeSigner.prototype.sign=function(tx){signs++;return original.call(this,tx);};
 try{const bad=fixture(t,{badSimulation:true});await bad.executor.execute(bad.request);assert.equal(signs,0);
  const stopped=fixture(t);await stopped.executor.execute({...stopped.request,beforeBroadcast:async()=>{assert.equal(signs,0);throw Error('ENTRY_HOLDER_RISK_STALE');}});assert.equal(signs,0);
  const good=fixture(t);await good.executor.execute({...good.request,beforeBroadcast:async()=>{assert.equal(signs,0);}});assert.equal(signs,1);
 }finally{NativeSigner.prototype.sign=original;}
});
test('last guard receives the executable quote and cannot mutate the submitted plan',async t=>{
 const f=fixture(t,{side:'sell'});let guards=0,prepared=0;
 const result=await f.executor.execute({...f.request,onPlanReady:plan=>{
  prepared++;assert.equal(f.state.calls.includes('simulateTransaction'),false);
  plan.instructions[0].data[0]=88;plan.instructions.length=0;plan.subscriptionAccounts.push(tip);
 },beforeBroadcast:async plan=>{
  guards++;assert.equal(f.state.sends,0);assert.ok(f.state.calls.includes('simulateTransaction'));assert.ok(Object.isFrozen(plan));
  assert.deepEqual({venue:plan.venue,mint:plan.mint,side:plan.side,inputAmount:plan.inputAmount,expectedOutputAmount:plan.expectedOutputAmount,
   minimumOutputAmount:plan.minimumOutputAmount,quotedAt:plan.quotedAt,tokenDecimals:plan.tokenDecimals,subscriptionAccounts:plan.subscriptionAccounts},
   {venue:'pump',mint,side:'sell',inputAmount:'1000',expectedOutputAmount:'10000000',minimumOutputAmount:'9500000',
    quotedAt:new Date(f.state.now).toISOString(),tokenDecimals:6,subscriptionAccounts:[ata]});
  plan.instructions[0].data[0]=99;plan.instructions[0].keys[0].isSigner=false;plan.instructions.length=0;plan.subscriptionAccounts.push(tip);
 }});
 assert.equal(prepared,1);assert.equal(guards,1);assert.equal(result.status,'submitted');assert.deepEqual(result.subscriptionAccounts,[ata]);
 const signed=VersionedTransaction.deserialize(Buffer.from(f.state.sent[0],'base64'));
 const swap=signed.message.compiledInstructions.find(ix=>signed.message.staticAccountKeys[ix.programIdIndex].toBase58()===pump);
 assert.ok(swap);assert.deepEqual([...swap.data],[1]);assert.equal(signed.message.header.numRequiredSignatures,1);
});

test('startup warmup gates readiness, verifies chain and consumes Jito tip lookup before execution',async t=>{
 const f=fixture(t);assert.deepEqual(f.executor.readiness(),{ready:true});
 const warming=f.executor.warmup();assert.deepEqual(f.executor.readiness(),{ready:false,reason:'NATIVE_EXECUTOR_WARMING'});
 await warming;assert.deepEqual(f.executor.readiness(),{ready:true});
 const before=[...f.state.calls];assert.deepEqual(before.sort(),['getGenesisHash','getTipAccounts'].sort());
 const result=await f.executor.execute(f.request);assert.equal(result.status,'submitted');
 assert.equal(f.state.calls.filter(method=>method==='getGenesisHash').length,1);
 assert.equal(f.state.calls.filter(method=>method==='getTipAccounts').length,1);
});

test('timing measures every stage monotonically without additional RPCs or durable writes',async t=>{
 let monotonic=0;const f=fixture(t,{monotonicNow:()=>++monotonic}),startedAt=new Date(f.state.now).toISOString();
 const writes=t.mock.method((f.executor as any).journal,'save');
 const result=await f.executor.execute({...f.request,beforeBroadcast:async()=>{f.state.now+=45;}});
 assert.equal(result.status,'submitted');assert.equal(result.timing?.version,1);assert.equal(result.timing.startedAt,startedAt);
 assert.deepEqual(Object.keys(result.timing.stagesMs).sort(),[...NATIVE_EXECUTION_STAGES].sort());
 for(const stage of NATIVE_EXECUTION_STAGES)assert.ok(result.timing.stagesMs[stage]!>=1&&result.timing.stagesMs[stage]!<=3,stage);
 assert.equal(result.timing.submittedAfterMs,45);assert.equal(result.timing.broadcastStartedAt,new Date(f.state.now).toISOString());
 assert.equal(result.timing.acknowledgedAt,result.timing.broadcastStartedAt);
 assert.equal(result.timing.confirmedObservedAt,undefined);assert.equal(result.timing.finalizedObservedAt,undefined);
 const expected=['getGenesisHash','getTipAccounts','getLatestBlockhash','getFeeForMessage','getBalance','simulateTransaction','sendTransaction'];
 assert.deepEqual([...f.state.calls].sort(),expected.sort());assert.equal(f.state.calls.at(-1),'sendTransaction');
 assert.equal(writes.mock.callCount(),2,'timing uses the existing pre-send and post-send journal writes');
 const stored=f.executor.get(f.request.intentId)!;assert.deepEqual(stored.timing,result.timing);
 result.timing.stagesMs.plan=999;assert.equal(f.executor.get(f.request.intentId)!.timing!.stagesMs.plan,1,'public timing is a detached projection');
 const repeat=await f.executor.execute(f.request);assert.deepEqual(repeat.timing,stored.timing);assert.equal(f.state.sends,1);
});

test('failed simulation and failed final guard retain completed or attempted stages without inventing broadcast times',async t=>{
 let mono=0;const a=fixture(t,{badSimulation:true,monotonicNow:()=>mono+=2});const failed=await a.executor.execute(a.request);
 const failedTiming=failed.timing!;assert.equal(failed.status,'failed');assert.ok(failedTiming.stagesMs.simulation!>=2&&failedTiming.stagesMs.simulation!<=6);
 assert.equal(failedTiming.stagesMs.broadcastQueue,undefined);assert.equal(failedTiming.stagesMs.sign,undefined);
 assert.equal(failedTiming.broadcastStartedAt,undefined);assert.equal(failedTiming.submittedAfterMs,undefined);
 assert.equal(a.state.sends,0);
 const b=fixture(t,{monotonicNow:()=>mono+=3});const guarded=await b.executor.execute({...b.request,beforeBroadcast:async()=>{throw Error('ENTRY_TIMING_TEST_REJECTED');}});
 assert.equal(guarded.timing?.stagesMs.finalGuard,3);assert.equal(guarded.timing.stagesMs.sign,undefined);
 assert.equal(guarded.timing.broadcastStartedAt,undefined);assert.equal(b.state.sends,0);
});

test('restart preserves original attempt timings and first verified observations through rebroadcast and finalization',async t=>{
 let mono=0;const opts={sendError:true,monotonicNow:()=>++mono},f=fixture(t,opts),started=f.state.now;
 const unknown=await f.executor.execute(f.request),first=structuredClone(unknown.timing)!;
 assert.equal(unknown.status,'unknown');assert.ok(first.broadcastStartedAt);assert.equal(first.acknowledgedAt,undefined);
 opts.sendError=false;f.state.now+=3000;const executor=await f.restart();
 const accepted=await executor.reconcile(f.request.intentId);
 assert.deepEqual(accepted.timing?.stagesMs,first.stagesMs);assert.equal(accepted.timing?.broadcastStartedAt,first.broadcastStartedAt);
 assert.equal(accepted.timing?.startedAt,first.startedAt);assert.equal(accepted.timing?.submittedAfterMs,3000);
 assert.equal(f.state.plans,1);assert.equal(f.state.sends,2);assert.equal(f.state.sent[0],f.state.sent[1]);
 f.state.now=started+5000;f.state.status={slot:105,err:null,confirmationStatus:'confirmed'};f.state.transaction=txProof(unknown.signature!,'buy');
 const confirmed=await executor.reconcile(f.request.intentId);
 assert.equal(confirmed.timing?.confirmedObservedAt,new Date(started+5000).toISOString());assert.equal(confirmed.timing?.confirmedAfterMs,5000);
 assert.equal(confirmed.timing?.finalizedObservedAt,undefined);assert.ok(confirmed.provisional);
 f.state.now=started+6000;const repeated=await executor.reconcile(f.request.intentId);
 assert.equal(repeated.timing?.confirmedObservedAt,confirmed.timing?.confirmedObservedAt);assert.equal(repeated.timing?.confirmedAfterMs,5000);
 f.state.now=started+8000;f.state.status.confirmationStatus='finalized';const final=await executor.reconcile(f.request.intentId);
 assert.equal(final.status,'confirmed');assert.equal(final.timing?.finalizedAfterMs,8000);
 assert.equal(final.timing?.confirmedAfterMs,5000);assert.deepEqual(final.timing?.stagesMs,first.stagesMs);
 f.state.now+=5000;assert.deepEqual((await executor.reconcile(f.request.intentId)).timing,final.timing);
});

test('only verified fill receipts add observed timings and direct finalized receipts set both observations',async t=>{
 const f=fixture(t),sent=await f.executor.execute(f.request);f.state.now+=1200;
 f.state.status={slot:105,err:null,confirmationStatus:'finalized'};f.state.transaction=txProof(sent.signature!,'buy');
 f.state.transaction.meta.postTokenBalances[0].owner=tip;
 const invalid=await f.executor.reconcile(f.request.intentId);assert.equal(invalid.status,'unknown');
 assert.equal(invalid.timing?.confirmedObservedAt,undefined);assert.equal(invalid.timing?.finalizedObservedAt,undefined);
 f.state.transaction=txProof(sent.signature!,'buy');f.state.now+=800;
 const valid=await f.executor.reconcile(f.request.intentId);
 assert.equal(valid.timing?.confirmedAfterMs,2000);assert.equal(valid.timing?.finalizedAfterMs,2000);
 assert.equal(valid.timing?.confirmedObservedAt,valid.timing?.finalizedObservedAt);
});

test('backwards wall time is explicit and never produces a negative confirmation duration',async t=>{
 const f=fixture(t),sent=await f.executor.execute(f.request);f.state.now-=50;
 f.state.status={slot:105,err:null,confirmationStatus:'confirmed'};f.state.transaction=txProof(sent.signature!,'buy');
 const observed=await f.executor.reconcile(f.request.intentId);
 assert.ok(observed.provisional);assert.equal(observed.timing?.clockInvalid,true);
 assert.equal(observed.timing?.confirmedObservedAt,new Date(f.state.now).toISOString());assert.equal(observed.timing?.confirmedAfterMs,undefined);
 f.state.now+=1000;const repeated=await f.executor.reconcile(f.request.intentId);
 assert.equal(repeated.timing?.confirmedObservedAt,observed.timing?.confirmedObservedAt);assert.equal(repeated.timing?.confirmedAfterMs,undefined);
 assert.ok(Object.values(repeated.timing!.stagesMs).every(value=>Number.isFinite(value)&&value!>=0));
});

test('a faulty injected monotonic clock cannot interrupt execution or create invalid stage durations',async t=>{
 let mono=1000;const f=fixture(t,{monotonicNow:()=>--mono}),result=await f.executor.execute(f.request);
 assert.equal(result.status,'submitted');assert.equal(result.timing?.clockInvalid,true);assert.deepEqual(result.timing?.stagesMs,{});
 assert.equal(f.state.sends,1);
});

test('legacy records remain untimed through recovery and timing projection excludes arbitrary journal fields',async t=>{
 const f=fixture(t),db=new NativeJournal(f.journal),stamp=new Date(f.state.now).toISOString(),signature=bs58.encode(new Uint8Array(64).fill(6));
 const legacy:NativeJournalRecord={...f.request,status:'submitted',createdAt:stamp,updatedAt:stamp,armed:true,rawTransaction:'AQID',signature,
  tokenDecimals:6,tipLamports:'1000',priorityFeeLamports:'5000',minimumOutputAmount:'950',contextSlot:100,lastValidBlockHeight:250};
 db.reserve(legacy,'owner',f.state.now);db.release(legacy.intentId,'owner');
 const timing={version:1,startedAt:stamp,stagesMs:{plan:12,rawTransaction:'hidden-raw',secretKey:'hidden-key'},
  rawTransaction:'hidden-raw',secretKey:'hidden-key'} as unknown as NativeExecutionTiming;
 db.reserve({...legacy,intentId:'extra',orderId:'extra-order',timing},'owner',f.state.now);db.release('extra','owner');db.close();
 assert.equal(f.executor.get(legacy.intentId)?.timing,undefined);
 assert.deepEqual(f.executor.get('extra')?.timing,{version:1,startedAt:stamp,stagesMs:{plan:12}});
 assert.doesNotMatch(JSON.stringify(f.executor.listPending()),/hidden-raw|hidden-key|AQID/);
 f.state.status={slot:105,err:null,confirmationStatus:'finalized'};f.state.transaction=txProof(signature,'buy');
 const result=await f.executor.reconcile(legacy.intentId);assert.equal(result.status,'confirmed');assert.equal(result.timing,undefined);assert.equal(f.state.sends,0);
});
