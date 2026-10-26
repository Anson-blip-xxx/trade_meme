import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import type {ManualClosePosition} from '../src/manual-close.js';
import type {SolanaSnapshot,VerifiedSolanaTransaction} from '../src/controlled-test/types.js';
import {readControlledManualPositions,ManualCloseSolanaHistory} from '../src/manual-close-source.js';
const wallet=bs58.encode(new Uint8Array(32).fill(3)),other=bs58.encode(new Uint8Array(32).fill(4));
const signature=bs58.encode(new Uint8Array(64).fill(5)),mint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const at='2026-10-25T10:00:00.000Z',SOL='So11111111111111111111111111111111111111112';
const conditions=[{order_type:'profit_stop',side:'sell',price_scale:'100',sell_ratio:'50'},{order_type:'loss_stop',side:'sell',price_scale:'40',sell_ratio:'100'}];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'manual-source-')),path=join(dir,'journal.sqlite');
  const run:any={id:'run-1',wallet,mint,amountLamports:'10000000',phase:'needs_attention',createdAt:at,updatedAt:at,
    buy:{signature,wallet,mint,side:'buy',slot:100,tokenDelta:'500000000',nativeDelta:'-10025000',feeLamports:'25000',
      preTokenAmount:'0',postTokenAmount:'500000000',preNativeLamports:'100000000',postNativeLamports:'89975000',decimals:5,checkedAt:at}};
  const op:any={runId:'run-1',key:'buy',state:'acknowledged',body:{chain:'sol',from_address:wallet,input_token:SOL,output_token:mint,
    input_amount:'10000000',swap_mode:'ExactIn',sell_ratio_type:'hold_amount',condition_orders:conditions},response:{order_id:'buy-order',hash:signature}};
  const save=()=>{const db=new DatabaseSync(path);try{db.exec('CREATE TABLE IF NOT EXISTS controlled_test_runs(id TEXT,wallet TEXT,created_at TEXT,payload TEXT);CREATE TABLE IF NOT EXISTS controlled_test_operations(run_id TEXT,operation_key TEXT,payload TEXT);DELETE FROM controlled_test_runs;DELETE FROM controlled_test_operations;');
    db.prepare('INSERT INTO controlled_test_runs VALUES (?,?,?,?)').run(run.id,run.wallet,at,JSON.stringify(run));db.prepare('INSERT INTO controlled_test_operations VALUES (?,?,?)').run(run.id,'buy',JSON.stringify(op));}finally{db.close();}};
  return {path,dir,run,op,save,close:()=>rmSync(dir,{recursive:true,force:true})};}

test('manual close source derives exact protection request from verified existing holding without modifying the journal',()=>{
  const f=fixture();try{f.save();const before=readFileSync(f.path),positions=readControlledManualPositions(f.path,wallet);
    assert.equal(positions.length,1);const p=positions[0];assert.equal(p.openingTransactionHash,signature);assert.equal(p.openingOutputAmount,'500000000');
    assert.equal(p.providerOrderId,'buy-order');assert.deepEqual(p.strategyOrderIds,[]);assert.deepEqual(p.protectionEvidence?.conditions,conditions);
    assert.equal(p.protectionEvidence?.inputAmount,'10000000');assert.equal(p.protectionEvidence?.confirmedAt,at);
    assert.deepEqual(readFileSync(f.path),before);assert.deepEqual(readControlledManualPositions(f.path,other),[]);
  }finally{f.close();}
});
test('source retains saved exact strategy ID but rejects conflicting IDs or malformed appended conditions',()=>{
  for(const kind of ['saved','conflict','missing','wrong-side'] as const){const f=fixture();try {
    f.run.strategyId='saved-parent';if(kind==='conflict')f.op.response.strategy_order_id='other-parent';
    if(kind==='missing')delete f.op.body.condition_orders;
    if(kind==='wrong-side')f.op.body.condition_orders=[{...conditions[0],side:'buy'},conditions[1]];f.save();
    if(kind==='saved')assert.deepEqual(readControlledManualPositions(f.path,wallet)[0].strategyOrderIds,['saved-parent']);
    else assert.throws(()=>readControlledManualPositions(f.path,wallet),/^Error: MANUAL_CLOSE_SOURCE_UNAVAILABLE$/);
  }finally{f.close();}}
});
test('missing file stays missing; invalid buy proof and failed reads never manufacture closable positions',()=>{
  const f=fixture();try{assert.deepEqual(readControlledManualPositions(f.path,wallet),[]);assert.equal(existsSync(f.path),false);
    f.run.buy.tokenDelta='1';f.save();assert.throws(()=>readControlledManualPositions(f.path,wallet),/MANUAL_CLOSE_SOURCE_UNAVAILABLE/);
  }finally{f.close();}
});

function historyFixture(kind:'sell'|'transfer'|'unknown'|'pending'|'truncated'|'pages'|'transactions'='sell') {
  const userAta=bs58.encode(new Uint8Array(32).fill(20)),vault=bs58.encode(new Uint8Array(32).fill(21));
  const curve=bs58.encode(new Uint8Array(32).fill(22)),global=bs58.encode(new Uint8Array(32).fill(23)),fee=bs58.encode(new Uint8Array(32).fill(24));
  const system='11111111111111111111111111111111',token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const pump='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',partial=bs58.encode(new Uint8Array(64).fill(9));
  const keys=[wallet,mint,userAta,vault,curve,global,fee,system,token,pump],pre=keys.map(()=>1_000_000_000),post=[...pre];
  post[0]+=99_995_000;post[4]-=100_000_000;
  const bal=(index:number,owner:string,n:string)=>({accountIndex:index,owner,mint,programId:token,uiTokenAmount:{amount:n,decimals:5}});
  const transfer={programId:token,stackHeight:2,parsed:{type:'transferChecked',info:{source:userAta,destination:vault,authority:wallet,mint,tokenAmount:{amount:'250000000',decimals:5}}}};
  const instruction={programId:pump,accounts:[global,fee,mint,curve,vault,userAta,wallet,system,token],data:bs58.encode(Buffer.from('33e685a4017f83ad'+'00'.repeat(16),'hex'))};
  const raw:any={slot:101,blockTime:Date.parse(at)/1000,transaction:{signatures:[partial],message:{accountKeys:keys.map((pubkey,i)=>({pubkey,signer:i===0,writable:true})),instructions:[instruction]}},
    meta:{err:null,fee:5000,preBalances:pre,postBalances:post,preTokenBalances:[bal(2,wallet,'500000000'),bal(3,curve,'1000000000')],
      postTokenBalances:[bal(2,wallet,'250000000'),bal(3,curve,'1250000000')],innerInstructions:[{index:0,instructions:[transfer]}]}};
  if(kind==='transfer'){raw.transaction.message.instructions=[transfer];raw.meta.innerInstructions=[];}
  if(kind==='unknown')raw.transaction.message.instructions[0].programId=other;
  const p:ManualClosePosition={id:'position',chain:'solana',wallet,tokenAddress:mint,openingTransactionHash:signature};
  const opening:VerifiedSolanaTransaction={signature,wallet,mint,side:'buy',slot:100,tokenDelta:'500000000',nativeDelta:'-10000000',feeLamports:'5000',
    preTokenAmount:'0',postTokenAmount:'500000000',preNativeLamports:'1010000000',postNativeLamports:'1000000000',decimals:5,checkedAt:at};
  const snapshot:SolanaSnapshot={wallet,mint,tokenAmount:'250000000',nativeLamports:'1000000000',decimals:5,slot:102,nativeSlot:102,
    mintAuthority:null,freezeAuthority:null,tokenProgram:token,extensions:[],checkedAt:at};
  const calls:string[]=[],signatureInfo=(s:string,slot:number)=>({signature:s,slot,err:null,confirmationStatus:'finalized'});
  let page=0;
  const unique=(n:number)=>{const b=new Uint8Array(64).fill(31);b[0]=n>>8;b[1]=n&255;return bs58.encode(b);};
  const fetcher:typeof fetch=async (_input,init)=>{
    assert.equal(init?.method,'POST');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
    const req=JSON.parse(String(init?.body));calls.push(req.method);let result:unknown;
    if(req.method==='getGenesisHash')result='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    else if(req.method==='getSignaturesForAddress'){
      assert.equal(req.params[0],wallet);assert.equal(req.params[1].commitment,'finalized');assert.equal(req.params[1].limit,100);
      if(kind==='pages'){result=Array.from({length:100},(_,i)=>signatureInfo(unique(page*100+i+1),1000-page*100-i));page++;}
      else if(kind==='transactions')result=[...Array.from({length:61},(_,i)=>signatureInfo(unique(i+1),200-i)),signatureInfo(signature,100)];
      else result=[{...signatureInfo(partial,101),...kind==='pending'?{confirmationStatus:'confirmed'}:{}},...kind==='truncated'?[]:[signatureInfo(signature,100)]];
    }else if(req.method==='getTransaction'){assert.equal(req.params[0],partial);assert.equal(req.params[1].commitment,'finalized');result=raw;}
    else assert.fail('Unexpected RPC method: '+req.method);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result}),{status:200,headers:{'content-type':'application/json'}});
  };
  return {p,opening,snapshot,partial,calls,history:new ManualCloseSolanaHistory('https://rpc.invalid',{fetcher,now:()=>Date.parse(at)})};
}

test('bounded history finds finalized supported swap and uses program-scoped transfer evidence, caching immutable transactions only',async()=>{
  const f=historyFixture();assert.deepEqual(await f.history.signatures(f.p,f.opening,f.snapshot),[f.partial]);
  assert.deepEqual(await f.history.signatures(f.p,f.opening,f.snapshot),[f.partial]);
  assert.equal(f.calls.filter(m=>m==='getTransaction').length,1);assert.equal(f.calls.filter(m=>m==='getSignaturesForAddress').length,2);
  assert.ok(f.calls.every(m=>['getGenesisHash','getSignaturesForAddress','getTransaction'].includes(m)));
});

test('partial history refuses ordinary transfer, unsupported protocol, pending signature and truncated coverage',async()=>{
  for(const kind of ['transfer','unknown','pending','truncated'] as const){const f=historyFixture(kind);
    await assert.rejects(()=>f.history.signatures(f.p,f.opening,f.snapshot),/^Error: MANUAL_CLOSE_PARTIAL_HISTORY_UNVERIFIED$/,kind);}
});

test('history pagination and transaction work are bounded and never infer completion from an exhausted budget',async()=>{
  const pages=historyFixture('pages');await assert.rejects(()=>pages.history.signatures(pages.p,pages.opening,pages.snapshot),/PARTIAL_HISTORY_UNVERIFIED/);
  assert.equal(pages.calls.filter(m=>m==='getSignaturesForAddress').length,3);assert.equal(pages.calls.filter(m=>m==='getTransaction').length,0);
  const many=historyFixture('transactions');many.snapshot.slot=300;many.snapshot.nativeSlot=300;await assert.rejects(()=>many.history.signatures(many.p,many.opening,many.snapshot),/PARTIAL_HISTORY_UNVERIFIED/);
  assert.equal(many.calls.filter(m=>m==='getTransaction').length,0);
});
