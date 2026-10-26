import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bs58 from 'bs58';
import {NativePositionSupervisor,type NativePositionIO,type NativePositionState,type NativePositionUpdate} from '../src/native-solana/positions.js';

const address=(n:number)=>bs58.encode(Buffer.alloc(32,n)),signature=(n:number)=>bs58.encode(Buffer.alloc(64,n));
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function until(predicate:()=>boolean){const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw Error('test timeout');await sleep(2);}}
function fixture(snapshotIntervalMs=1000){
  const dir=mkdtempSync(join(tmpdir(),'native-coalesced-')),path=join(dir,'positions.sqlite');
  let now=Date.now(),amount='1000',output='1000',slot=101,quoteGate:ReturnType<typeof deferred>|undefined;
  const events:NativePositionUpdate[]=[],evaluations:NativePositionState[]=[],sales:string[]=[];
  const buy={orderId:'buy-coalesced',wallet:address(1),mint:address(2),inputAmount:'1000',outputAmount:'1000',tokenDecimals:6,
    signature:signature(3),buySlot:100,confirmedAt:new Date(now).toISOString(),subscriptionAccounts:[address(4)]};
  const reader=new DatabaseSync(path); // A second connection sees only committed snapshots.
  const raw=()=>JSON.parse(String(reader.prepare('SELECT payload FROM native_positions WHERE order_id=?').get(buy.orderId)!.payload)) as NativePositionState;
  const io:NativePositionIO={
    balance:async()=>({wallet:buy.wallet,mint:buy.mint,amount,tokenDecimals:6,slot,commitment:'finalized',observedAt:new Date(now).toISOString()}),
    quote:async request=>{await quoteGate?.promise;const value=(BigInt(request.amount)*BigInt(output)/1000n).toString();
      return {wallet:request.wallet,mint:request.mint,inputAmount:request.amount,outputAmount:value,minimumOutputAmount:value,
        quotedAt:new Date(now).toISOString(),expiresAt:new Date(now+5000).toISOString()};},
    sell:async request=>{
      const persisted=raw();assert.equal(persisted.pendingExit?.operationId,request.operationId);
      assert.equal(persisted.pendingExit?.expectedAmount,request.expectedAmount);
      assert.ok(reader.prepare('SELECT 1 FROM native_position_intents WHERE operation_id=?').get(request.operationId));
      sales.push(request.operationId);return {status:'pending'};
    },reconcile:async()=>({status:'pending'}),
  };
  const options={io,now:()=>now,autoSchedule:false,eventDriven:true,minCheckIntervalMs:0,snapshotIntervalMs,
    onUpdate:(event:NativePositionUpdate)=>{events.push(event);},onEvaluation:(position:NativePositionState)=>{evaluations.push(position);}};
  const s=new NativePositionSupervisor(path,options);s.register(buy);s.start();
  return {s,options,path,buy,raw,reader,events,evaluations,sales,setPrice:(v:string)=>{output=v;now++;},setAmount:(v:string)=>{amount=v;slot++;now++;},
    setGate:(gate:ReturnType<typeof deferred>|undefined)=>{quoteGate=gate;},async close(){quoteGate?.resolve();await s.close();reader.close();rmSync(dir,{recursive:true,force:true});}};
}

test('dirty bursts and ordinary checks update memory immediately without per-frame durable snapshots',async()=>{
  const f=fixture(5000);try{
    await f.s.checkNow(f.buy.orderId);const committed=f.raw();assert.equal(committed.quote?.outputAmount,'1000');
    for(let i=0;i<100;i++)f.s.markDirty(f.buy.orderId,{slot:101});
    f.setPrice('1500');await f.s.checkNow(f.buy.orderId);
    assert.equal(f.s.get(f.buy.orderId)!.quote?.outputAmount,'1500');assert.equal(f.s.list()[0].quote?.outputAmount,'1500');
    assert.equal(f.raw().revision,committed.revision);assert.equal(f.raw().quote?.outputAmount,'1000');
    assert.ok(f.evaluations.some(p=>p.quote?.outputAmount==='1500'));assert.equal(f.s.status().pendingSnapshots,1);
    const copy=f.s.get(f.buy.orderId)!;copy.expectedBalanceAmount='0';assert.equal(f.s.get(f.buy.orderId)!.expectedBalanceAmount,'1000');
  }finally{await f.close();}
});

test('scheduled observation persistence emits the newest snapshot once for a burst',async()=>{
  const f=fixture(80);try{
    await f.s.checkNow(f.buy.orderId);const snapshots=f.events.filter(e=>e.type==='snapshot').length;
    for(const value of ['1100','1200','1500']){f.setPrice(value);await f.s.checkNow(f.buy.orderId);}
    assert.equal(f.raw().quote?.outputAmount,'1000');
    await until(()=>f.raw().quote?.outputAmount==='1500'&&f.events.filter(e=>e.type==='snapshot').length===snapshots+1);
    assert.equal(f.events.at(-1)?.position.quote?.outputAmount,'1500');assert.equal(f.s.status().pendingSnapshots,0);
  }finally{await f.close();}
});

test('restart clears old observations even when the saved price has not expired',async()=>{
  const f=fixture(5000);let restarted:NativePositionSupervisor|undefined;try{
    await f.s.checkNow(f.buy.orderId);assert.ok(f.raw().quote);
    restarted=new NativePositionSupervisor(f.path,{...f.options,onUpdate:undefined});
    const row=restarted.get(f.buy.orderId)!;assert.equal(row.quote,undefined);assert.equal(row.lastCheckAt,undefined);assert.equal(row.lastAttemptAt,undefined);
    assert.equal(row.dirty,true);assert.equal(row.expectedBalanceAmount,'1000');restarted.start();assert.equal(restarted.readiness().ready,false);
  }finally{await restarted?.close();await f.close();}
});

test('external balance accounting commits before waiting for a quote and exit intent commits before sell',async()=>{
  const f=fixture(5000),gate=deferred();try{
    await f.s.checkNow(f.buy.orderId);f.setAmount('800');f.setGate(gate);const check=f.s.checkNow(f.buy.orderId);
    await until(()=>f.raw().expectedBalanceAmount==='800');assert.equal(f.raw().externalReductionAmount,'200');
    gate.resolve();f.setGate(undefined);await check;
    f.setPrice('2000');await f.s.checkNow(f.buy.orderId);assert.equal(f.sales.length,1);assert.equal(f.raw().pendingExit?.expectedAmount,'400');
    await sleep(100);assert.equal(f.s.get(f.buy.orderId)!.pendingExit?.operationId,f.raw().pendingExit?.operationId);
  }finally{gate.resolve();await f.close();}
});

test('closing cancels queued observations and releases subscriptions without resurrecting the position',async()=>{
  const f=fixture(80);try{
    await f.s.checkNow(f.buy.orderId);f.setPrice('1500');await f.s.checkNow(f.buy.orderId);assert.equal(f.s.status().pendingSnapshots,1);
    f.setAmount('0');await f.s.checkNow(f.buy.orderId);assert.equal(f.raw().state,'closed');assert.deepEqual(f.s.accounts(),[]);
    const closedIndex=f.events.findIndex(e=>e.type==='closed');assert.ok(closedIndex>=0);
    await sleep(120);assert.equal(f.raw().state,'closed');assert.equal(f.s.get(f.buy.orderId)!.state,'closed');assert.equal(f.s.status().pendingSnapshots,0);
    assert.equal(f.events.slice(closedIndex+1).some(e=>e.type==='snapshot'),false);
  }finally{await f.close();}
});

test('an observation callback failure cannot prevent a durably recorded exit',async()=>{
  const f=fixture(5000);await f.s.close();
  const s=new NativePositionSupervisor(f.path,{...f.options,onEvaluation:()=>{throw Error('observer unavailable');}});
  try{s.start();f.setPrice('2000');await s.checkNow(f.buy.orderId);assert.equal(f.sales.length,1);assert.ok(f.raw().pendingExit);}
  finally{await s.close();await f.close();}
});
