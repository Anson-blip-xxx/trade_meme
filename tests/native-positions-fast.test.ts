import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import bs58 from 'bs58';
import {NativePositionSupervisor,type NativeConfirmedPosition,type NativePositionIO,type NativePositionExitRequest,type NativePositionExitResult} from '../src/native-solana/positions.js';

const BASE=Date.parse('2026-10-26T00:00:00Z');
function address(n:number){const b=Buffer.alloc(32);b.writeUInt32LE(n);return bs58.encode(b);}
const signature=(n:number)=>bs58.encode(Buffer.alloc(64,n));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const sleep=(ms=1)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(condition:()=>boolean){const until=Date.now()+2000;while(!condition()){if(Date.now()>until)throw Error('test observation timed out');await sleep();}}
function fixture(count=2,path=':memory:'){
  let now=BASE;
  const buys:NativeConfirmedPosition[]=Array.from({length:count},(_,i)=>({orderId:`buy-${i}`,wallet:address(1),mint:address(1000+i),inputAmount:'1000',outputAmount:'1000',
    tokenDecimals:6,signature:signature((i%250)+1),buySlot:100,confirmedAt:new Date(now).toISOString(),subscriptionAccounts:[address(10000+i)]}));
  const prices=new Map(buys.map(b=>[b.orderId,{n:1n,d:1n}])),amounts=new Map(buys.map(b=>[b.orderId,'1000']));
  const balances:string[]=[],quotes:{orderId:string;amount:string}[]=[],sales:NativePositionExitRequest[]=[];
  let balanceHook:((orderId:string)=>Promise<void>)|undefined,quoteHook:((orderId:string,amount:string)=>Promise<void>)|undefined;
  let saleHook:((input:NativePositionExitRequest)=>Promise<NativePositionExitResult>)|undefined,reconcileHook:(()=>Promise<NativePositionExitResult>)|undefined;
  const io:NativePositionIO={
    async balance(input){balances.push(input.orderId);await balanceHook?.(input.orderId);return {wallet:input.wallet,mint:input.mint,amount:amounts.get(input.orderId)!,
      tokenDecimals:6,slot:101,commitment:'confirmed',observedAt:new Date(now).toISOString()};},
    async quote(input){quotes.push({orderId:input.orderId,amount:input.amount});const p=prices.get(input.orderId)!,output=(BigInt(input.amount)*p.n/p.d).toString();await quoteHook?.(input.orderId,input.amount);
      return {wallet:input.wallet,mint:input.mint,inputAmount:input.amount,outputAmount:output,minimumOutputAmount:output,quotedAt:new Date(now).toISOString(),expiresAt:new Date(now+1000).toISOString()};},
    async sell(input){sales.push(input);return saleHook?await saleHook(input):{status:'pending'};},
    async reconcile(){return reconcileHook?await reconcileHook():{status:'pending'};},
  };
  const s=new NativePositionSupervisor(path,{io,now:()=>now,autoSchedule:false,eventDriven:true,minCheckIntervalMs:0,loopMs:50,
    requestTimeoutMs:1000,maxPositions:Math.max(20,count+1),batchSize:20});
  for(const buy of buys)s.register(buy);s.start();
  return {s,buys,prices,amounts,balances,quotes,sales,now:()=>now,advance:(ms=1)=>{now+=ms;},
    onBalance:(fn:typeof balanceHook)=>{balanceHook=fn;},onQuote:(fn:typeof quoteHook)=>{quoteHook=fn;},
    onSale:(fn:typeof saleHook)=>{saleHook=fn;},onReconcile:(fn:typeof reconcileHook)=>{reconcileHook=fn;}};
}

test('a slow quote on one mint cannot block another mint stream check',async()=>{
  const f=fixture(),gate=deferred<void>();try{
    f.onQuote(async orderId=>{if(orderId==='buy-0')await gate.promise;});
    const first=f.s.checkNow('buy-0');await until(()=>f.quotes.some(q=>q.orderId==='buy-0'));
    await f.s.checkNow('buy-1');
    assert.equal(f.s.get('buy-1')!.quote?.outputAmount,'1000');assert.equal(f.s.get('buy-0')!.quote,undefined);
    gate.resolve();await first;
  }finally{gate.resolve();await f.s.close();}
});

test('a pending sell or slow exit reconciliation cannot block another mint updates',async()=>{
  const f=fixture(),sale=deferred<NativePositionExitResult>(),reconcile=deferred<NativePositionExitResult>();try{
    f.prices.set('buy-0',{n:2n,d:1n});f.onSale(async()=>sale.promise);
    const first=f.s.checkNow('buy-0');await until(()=>f.sales.length===1);
    f.prices.set('buy-1',{n:3n,d:2n});await f.s.checkNow('buy-1');
    assert.equal(f.s.get('buy-1')!.quote?.outputAmount,'1500');assert.equal(f.sales.length,1);
    sale.resolve({status:'pending'});await first;
    f.onReconcile(async()=>reconcile.promise);f.advance(5000);const tick=f.s.tick();await sleep(5);
    f.prices.set('buy-1',{n:6n,d:5n});await f.s.checkNow('buy-1');
    assert.equal(f.s.get('buy-1')!.quote?.outputAmount,'1200');assert.equal(f.sales.length,1);
    reconcile.resolve({status:'pending'});await tick;
  }finally{sale.resolve({status:'pending'});reconcile.resolve({status:'pending'});await f.s.close();}
});

test('two dirty notifications in the same millisecond still cause fresh evaluations',async()=>{
  const f=fixture(1);try{
    await f.s.checkNow('buy-0');const before=f.quotes.length;
    f.prices.set('buy-0',{n:6n,d:5n});f.s.markDirty(f.buys[0].subscriptionAccounts[0],{slot:101,observedAt:new Date(f.now()).toISOString()});
    await until(()=>f.s.get('buy-0')!.quote?.outputAmount==='1200');assert.ok(f.quotes.length>before);
    f.prices.set('buy-0',{n:3n,d:2n});f.s.markDirty(f.buys[0].subscriptionAccounts[0],{slot:101,observedAt:new Date(f.now()).toISOString()});
    await until(()=>f.s.get('buy-0')!.quote?.outputAmount==='1500');assert.equal(f.s.get('buy-0')!.lastCheckAt,new Date(BASE).toISOString());
  }finally{await f.s.close();}
});

test('a dirty notification during an in-flight check schedules a second evaluation after completion',async()=>{
  const f=fixture(1),gate=deferred<void>();let held=false;try{
    f.onQuote(async(_id,amount)=>{if(amount==='1000'&&!held){held=true;await gate.promise;}});
    const first=f.s.checkNow('buy-0');await until(()=>held);
    f.prices.set('buy-0',{n:3n,d:2n});f.s.markDirty('buy-0',{slot:101,observedAt:new Date(f.now()).toISOString()});
    gate.resolve();await first;
    await until(()=>f.s.get('buy-0')!.quote?.outputAmount==='1500');assert.ok(f.balances.length>=2);assert.equal(f.sales.length,0);
  }finally{gate.resolve();await f.s.close();}
});

test('slow durable notification delivery cannot delay a newer protection evaluation',async t=>{
  let now=BASE,price=1n,evaluations=0;
  const delivery=deferred<void>(),buy:NativeConfirmedPosition={orderId:'buy-notify',wallet:address(1),mint:address(2),inputAmount:'1000',
    outputAmount:'1000',tokenDecimals:6,signature:signature(3),buySlot:100,confirmedAt:new Date(now).toISOString(),subscriptionAccounts:[address(4)]};
  const io:NativePositionIO={
    balance:async input=>({wallet:input.wallet,mint:input.mint,amount:'1000',tokenDecimals:6,slot:101,commitment:'confirmed',observedAt:new Date(now).toISOString()}),
    quote:async input=>({wallet:input.wallet,mint:input.mint,inputAmount:input.amount,outputAmount:(BigInt(input.amount)*price).toString(),
      minimumOutputAmount:(BigInt(input.amount)*price).toString(),quotedAt:new Date(now).toISOString(),expiresAt:new Date(now+1000).toISOString()}),
    sell:async()=>({status:'pending'}),reconcile:async()=>({status:'pending'}),
  };
  const s=new NativePositionSupervisor(':memory:',{io,now:()=>now,autoSchedule:false,eventDriven:true,minCheckIntervalMs:0,
    onUpdate:()=>delivery.promise,onEvaluation:()=>{evaluations++;}});
  try{
    s.register(buy);s.start();
    await s.checkNow(buy.orderId);assert.equal(evaluations,1);
    const started=performance.now();price=3n;now++;s.markDirty(buy.orderId,{slot:101,observedAt:new Date(now).toISOString()});
    await until(()=>evaluations===2);
    t.diagnostic(JSON.stringify({type:'slow-notification',deliveryStillBlocked:true,evaluationMs:performance.now()-started}));
    assert.equal(s.get(buy.orderId)!.quote?.outputAmount,'3000');
  }finally{delivery.resolve();await s.close();}
});

test('30 and 100 positions evaluate independently while every quote source is slow',async t=>{
  for(const count of [30,100]){
    const f=fixture(count);try{
      f.onQuote(async()=>sleep(25));const started=performance.now();
      await Promise.all(f.buys.map(buy=>f.s.checkNow(buy.orderId)));
      const elapsed=performance.now()-started;
      t.diagnostic(JSON.stringify({type:'slow-quote',positions:count,delayPerQuoteMs:25,elapsedMs:elapsed,evaluated:f.s.list().filter(p=>p.quote).length}));
      assert.equal(f.s.list().filter(p=>p.quote).length,count);assert.ok(elapsed<500);
    }finally{await f.s.close();}
  }
});

test('bursts while an exit is in flight never create a second sell',async()=>{
  const f=fixture(1),gate=deferred<NativePositionExitResult>();try{
    f.prices.set('buy-0',{n:2n,d:1n});f.onSale(async()=>gate.promise);
    const first=f.s.checkNow('buy-0');await until(()=>f.sales.length===1);
    for(let i=0;i<100;i++)f.s.markDirty('buy-0',{slot:101,observedAt:new Date(f.now()).toISOString()});
    await Promise.all(Array.from({length:10},()=>f.s.checkNow('buy-0')));assert.equal(f.sales.length,1);
    gate.resolve({status:'pending'});await first;await sleep(15);
    assert.equal(f.sales.length,1);assert.ok(f.s.get('buy-0')!.pendingExit);
  }finally{gate.resolve({status:'pending'});await f.s.close();}
});

test('50ms fallback ticks use the due index and only evaluate the expired batch',async()=>{
  const f=fixture(60);try{
    await Promise.all(f.buys.map(buy=>f.s.checkNow(buy.orderId)));
    const internal=f.s as any;assert.equal(internal.dueByOrder.size,60);
    f.balances.length=0;
    await f.s.tick();assert.equal(f.balances.length,0,'same-time wake-up must not revisit every active position');
    f.advance(4999);await f.s.tick();assert.equal(f.balances.length,0);
    f.advance(1);await f.s.tick();assert.equal(f.balances.length,20,'only one configured batch becomes due');
    assert.equal(internal.dueByOrder.size,60,'every active position retains one authoritative due entry');
  }finally{await f.s.close();}
});

test('a popped stale due item is requeued at the authoritative future deadline',async()=>{
  const f=fixture(1);try{
    const internal=f.s as any,row=internal.rows.get('buy-0');
    row.lastAttemptAt=new Date(f.now()).toISOString();row.dirty=false;
    await f.s.tick();assert.equal(f.balances.length,0);
    assert.equal(internal.dueByOrder.size,1);assert.equal(internal.dueByOrder.get('buy-0').at,BASE+5000);
    f.advance(5000);await f.s.tick();assert.equal(f.balances.length,1);
  }finally{await f.s.close();}
});

test('stopping rejects late balance failures and late sell results without state writes or new submissions',async()=>{
  for(const stage of ['balance','sell','reconcile'] as const){
    const f=fixture(1),balance=deferred<void>(),exit=deferred<NativePositionExitResult>();let job:Promise<void>|undefined;
    try{
      if(stage==='balance'){f.onBalance(async()=>balance.promise);job=f.s.checkNow('buy-0');await until(()=>f.balances.length===1);}
      else {
        f.prices.set('buy-0',{n:2n,d:1n});
        if(stage==='sell'){f.onSale(async()=>exit.promise);job=f.s.checkNow('buy-0');await until(()=>f.sales.length===1);}
        else {await f.s.checkNow('buy-0');f.onReconcile(async()=>exit.promise);f.advance(5000);job=f.s.tick();await sleep(5);}
      }
      const before=JSON.stringify(f.s.get('buy-0')),stop=f.s.stop();
      if(stage==='balance')balance.reject(Error('LATE_BALANCE_ERROR'));
      else exit.resolve({status:'confirmed',signature:signature(199),inputAmount:'500',outputAmount:'1000',confirmedAt:new Date(f.now()).toISOString(),slot:102});
      await Promise.all([job,stop]);assert.equal(JSON.stringify(f.s.get('buy-0')),before,stage);
      assert.equal(f.sales.length,stage==='balance'?0:1);
      f.s.markDirty('buy-0');await f.s.checkNow('buy-0');await sleep(5);assert.equal(f.sales.length,stage==='balance'?0:1);
    }finally{balance.resolve();exit.resolve({status:'pending'});await f.s.close();}
  }
});

test('graduated local replay measures dirty-to-valuation work without network or trading',async(t)=>{
  for(const count of [3,10,20,30,50,100,200]){
    const dir=mkdtempSync(join(tmpdir(),'native-stream-replay-')),f=fixture(count,join(dir,'positions.sqlite'));
    try{
      await Promise.all(f.buys.map(b=>f.s.checkNow(b.orderId)));f.advance();
      const started=performance.now(),finished:number[]=[];
      f.prices.clear();for(const b of f.buys)f.prices.set(b.orderId,{n:3n,d:2n});
      for(const buy of f.buys){f.s.markDirty(buy.subscriptionAccounts[0]);}
      await Promise.all(f.buys.map(async buy=>{await until(()=>f.s.get(buy.orderId)!.quote?.outputAmount==='1500');finished.push(performance.now()-started);}));
      finished.sort((a,b)=>a-b);
      t.diagnostic(JSON.stringify({type:'local-replay-only',positions:count,updates:count,p50Ms:finished[Math.floor(count*.5)],p95Ms:finished[Math.floor(count*.95)],maxMs:finished.at(-1),sells:f.sales.length}));
      assert.equal(f.sales.length,0);assert.equal(finished.length,count);
    }finally{await f.s.close();rmSync(dir,{recursive:true,force:true});}
  }
});
