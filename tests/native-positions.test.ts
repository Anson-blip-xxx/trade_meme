import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {NativePositionSupervisor,type NativeConfirmedPosition,type NativePositionIO,type NativePositionUpdate,type NativePositionExitRequest,type NativePositionExitResult} from '../src/native-solana/positions.js';

const BASE=Date.parse('2026-10-25T00:00:00Z'),address=(n:number)=>bs58.encode(Buffer.alloc(32,n)),signature=(n:number)=>bs58.encode(Buffer.alloc(64,n));
function fixture(path=':memory:',overrides:Partial<NativeConfirmedPosition>={}){
  let now=BASE,amount=overrides.outputAmount??'1000',commitment:'confirmed'|'finalized'='finalized',slot=101,priceN=1n,priceD=1n;
  const buy:NativeConfirmedPosition={orderId:'buy-1',wallet:address(1),mint:address(2),inputAmount:'1000',outputAmount:'1000',tokenDecimals:6,
    signature:signature(3),buySlot:100,confirmedAt:new Date(now).toISOString(),subscriptionAccounts:[address(4),address(5)],...overrides};
  const events:NativePositionUpdate[]=[],sells:NativePositionExitRequest[]=[],quotes:string[]=[];let reconcileCalls=0;
  let saleResult:((request:NativePositionExitRequest)=>Promise<NativePositionExitResult>)|undefined;
  let reconcileResult:NativePositionExitResult={status:'pending'};
  const io:NativePositionIO={
    async balance(){return {wallet:buy.wallet,mint:buy.mint,amount,tokenDecimals:buy.tokenDecimals,slot,commitment,observedAt:new Date(now).toISOString()};},
    async quote(input){quotes.push(input.amount);const output=(BigInt(input.amount)*BigInt(buy.inputAmount)*priceN/(BigInt(buy.outputAmount)*priceD)).toString();
      return {wallet:input.wallet,mint:input.mint,inputAmount:input.amount,outputAmount:output,minimumOutputAmount:output,quotedAt:new Date(now).toISOString(),expiresAt:new Date(now+5000).toISOString()};},
    async sell(request){sells.push(request);if(saleResult)return saleResult(request);
      amount=(BigInt(amount)-BigInt(request.expectedAmount)).toString();slot++;
      return {status:'confirmed',signature:signature(10+sells.length),inputAmount:request.expectedAmount,outputAmount:request.quote.outputAmount,confirmedAt:new Date(now).toISOString(),slot};},
    async reconcile(){reconcileCalls++;return reconcileResult;},
  };
  const options={io,now:()=>now,autoSchedule:false,eventDriven:false,onUpdate:(event:NativePositionUpdate)=>{events.push(event);}};
  const s=new NativePositionSupervisor(path,options);s.register(buy);s.start();
  return {s,buy,io,options,events,sells,quotes,now:()=>now,setNow:(n:number)=>{now=n;},advance:(ms=5000)=>{now+=ms;},
    setAmount:(n:string,c:'confirmed'|'finalized'='finalized',atSlot=slot)=>{amount=n;commitment=c;slot=atSlot;},
    setPrice:(n:bigint,d=1n)=>{priceN=n;priceD=d;},setSale:(fn:typeof saleResult)=>{saleResult=fn;},
    setReconcile:(r:NativePositionExitResult)=>{reconcileResult=r;},reconciles:()=>reconcileCalls};
}

test('exact-size executable quotes trigger one double-out-half, then full -60% stop; finalized zero alone closes',async()=>{
  const f=fixture();try{
    assert.equal(f.s.readiness().ready,false);await f.s.tick();assert.equal(f.s.readiness().ready,true);assert.equal(f.sells.length,0);
    f.advance();f.setPrice(1999n,1000n);await f.s.tick();assert.equal(f.sells.length,0);
    f.advance();f.setPrice(2n);await f.s.tick();assert.equal(f.sells.length,1);assert.equal(f.sells[0].percent,50);
    assert.equal(f.sells[0].expectedAmount,'500');assert.equal(f.sells[0].quote.inputAmount,'500');
    let row=f.s.get(f.buy.orderId)!;assert.equal(row.takeProfitDone,true);assert.equal(row.soldTokenAmount,'500');assert.equal(row.realizedPnlLamports,'500');
    assert.deepEqual(row.costBasis,{solLamports:'1000',tokenAtoms:'1000',excludesNetworkFees:true});
    f.advance();f.setPrice(3n);await f.s.tick();assert.equal(f.sells.length,1);
    f.advance();f.setPrice(2n,5n);await f.s.tick();assert.equal(f.sells.length,2);assert.equal(f.sells[1].percent,100);assert.equal(f.sells[1].expectedAmount,'500');
    row=f.s.get(f.buy.orderId)!;assert.equal(row.state,'active');assert.equal(row.realizedPnlLamports,'200');
    f.setAmount('0','confirmed');f.advance();await f.s.tick();assert.equal(f.s.get(f.buy.orderId)!.state,'active');assert.equal(f.s.get(f.buy.orderId)!.quote,undefined);
    f.setAmount('0','finalized');f.advance();await f.s.tick();row=f.s.get(f.buy.orderId)!;
    assert.equal(row.state,'closed');assert.equal(row.closeReason,'sold');assert.equal(row.finalPnlKnown,true);assert.equal(row.saleProceedsLamports,'1200');
    const count=f.events.length;f.advance();f.s.markDirty(address(4));await f.s.tick();assert.equal(f.events.length,count);assert.deepEqual(f.s.accounts(),[]);
  }finally{await f.s.close();}
});

test('Jupiter TP needs one deadline quote and leaves the exact half route to the executor',async()=>{
  const f=fixture(':memory:',{venue:'jupiter',protectionMode:'external_price_stream'});try{
    f.setPrice(2n);f.setSale(async request=>({status:'confirmed',signature:signature(70),inputAmount:request.expectedAmount,
      outputAmount:'1000',confirmedAt:new Date(f.now()).toISOString(),slot:102}));
    await f.s.tick();assert.deepEqual(f.quotes,['1000']);assert.equal(f.sells.length,1);
    assert.equal(f.sells[0].reason,'take_profit');assert.equal(f.sells[0].expectedAmount,'500');
    assert.equal(f.sells[0].quote.inputAmount,'1000','the full executable quote is durable trigger evidence');
    assert.equal(f.s.get(f.buy.orderId)!.takeProfitDone,true);
  }finally{await f.s.close();}
});

test('uncertain sell is durably pending across restart and reconciled without another submission',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'native-positions-')),path=join(dir,'positions.sqlite'),f=fixture(path);let restarted:NativePositionSupervisor|undefined;
  try{
    f.setPrice(2n);f.setSale(async()=>{throw Error('private upstream response');});await f.s.tick();
    const pending=f.s.get(f.buy.orderId)!.pendingExit!;assert.equal(f.sells.length,1);assert.equal(f.s.get(f.buy.orderId)!.takeProfitDone,false);
    await f.s.close();restarted=new NativePositionSupervisor(path,f.options);restarted.start();
    f.advance();await restarted.tick();assert.equal(f.reconciles(),1);assert.equal(f.sells.length,1);assert.equal(restarted.get(f.buy.orderId)!.pendingExit!.operationId,pending.operationId);
    f.setReconcile({status:'confirmed',signature:signature(9),inputAmount:'500',outputAmount:'1000',confirmedAt:new Date(f.now()).toISOString(),slot:102});
    f.setAmount('500','finalized',102);f.advance();await restarted.tick();assert.equal(restarted.get(f.buy.orderId)!.takeProfitDone,true);
    f.advance();await restarted.tick();assert.equal(f.sells.length,1);assert.equal(restarted.get(f.buy.orderId)!.pendingExit,undefined);
    assert.doesNotMatch(JSON.stringify(restarted.list()),/private upstream/);
  }finally{await f.s.close();await restarted?.close();rmSync(dir,{recursive:true,force:true});}
});

test('Jupiter positions use external prices only as fresh wake-ups and restart without trusting an old quote',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'native-external-price-')),path=join(dir,'positions.sqlite'),f=fixture(path,{venue:'jupiter',protectionMode:'external_price_stream'});
  let restarted:NativePositionSupervisor|undefined;
  try{
    assert.equal(f.s.observeExternalPrice(f.buy.orderId,{priceUsd:1e-8,observedAt:new Date(f.now()).toISOString(),source:'ave_price_stream_sample'}),true);
    assert.equal('externalPriceAnchor' in f.s.get(f.buy.orderId)!,false);
    await f.s.tick();assert.ok(f.s.get(f.buy.orderId)!.quote);
    f.advance(20001);
    assert.equal(f.s.observeExternalPrice(f.buy.orderId,{priceUsd:2e-8,observedAt:new Date(f.now()-20001).toISOString(),source:'ave_price_stream_sample'}),false,
      'a stale sample cannot wake automatic exit work');
    await f.s.close();restarted=new NativePositionSupervisor(path,f.options);
    const restored=restarted.get(f.buy.orderId)!;
    assert.equal(restored.buy.venue,'jupiter');assert.equal(restored.buy.protectionMode,'external_price_stream');
    assert.equal('externalPriceAnchor' in restored,false);
    assert.equal(restored.quote,undefined);assert.equal(restored.lastCheckAt,undefined);
    restarted.start();assert.equal(restarted.readiness().reason,'NATIVE_POSITION_SUPERVISION_STALE');
  }finally{await f.s.close();await restarted?.close();rmSync(dir,{recursive:true,force:true});}
});

test('restart migrates legacy Jupiter account-stream rows and drops persisted route accounts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'native-jupiter-migration-')),path=join(dir,'positions.sqlite');
  const f=fixture(path,{venue:'jupiter',protectionMode:'external_price_stream'});let restarted:NativePositionSupervisor|undefined;
  try{
    await f.s.close();const db=new DatabaseSync(path);
    const stored=db.prepare('SELECT payload FROM native_positions WHERE order_id=?').get(f.buy.orderId) as {payload:string};
    const legacy=JSON.parse(stored.payload);legacy.buy.protectionMode='account_stream';legacy.buy.subscriptionAccounts=[address(4),address(5)];
    db.prepare('UPDATE native_positions SET payload=? WHERE order_id=?').run(JSON.stringify(legacy),f.buy.orderId);db.close();
    restarted=new NativePositionSupervisor(path,f.options);const row=restarted.get(f.buy.orderId)!;
    assert.equal(row.buy.protectionMode,'external_price_stream');assert.deepEqual(row.buy.subscriptionAccounts,[f.buy.wallet,f.buy.mint].sort());
    await restarted.close();restarted=undefined;
    const verify=new DatabaseSync(path);const persisted=JSON.parse((verify.prepare('SELECT payload FROM native_positions WHERE order_id=?').get(f.buy.orderId) as {payload:string}).payload);
    verify.close();assert.equal(persisted.buy.protectionMode,'external_price_stream');assert.deepEqual(persisted.buy.subscriptionAccounts,[f.buy.wallet,f.buy.mint].sort());
  }finally{await f.s.close();await restarted?.close();rmSync(dir,{recursive:true,force:true});}
});

test('external wake bursts coalesce to one in-flight check and one latest follow-up',async()=>{
  const f=fixture(':memory:',{venue:'jupiter',protectionMode:'external_price_stream'});try{
    f.options.eventDriven=true;const original=f.io.quote;let calls=0,active=0,maxActive=0,release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    f.io.quote=async request=>{calls++;active++;maxActive=Math.max(maxActive,active);if(calls===1)await gate;
      try{return await original(request);}finally{active--;}};
    assert.equal(f.s.observeExternalPrice(f.buy.orderId,{priceUsd:1,observedAt:new Date(f.now()).toISOString(),source:'ave_price_stream_sample'}),true);
    const first=f.s.checkNow(f.buy.orderId);while(calls===0)await new Promise(resolve=>setImmediate(resolve));
    const same:Promise<void>[]=[];for(let i=0;i<20;i++){
      f.s.observeExternalPrice(f.buy.orderId,{priceUsd:1+i/100,observedAt:new Date(f.now()).toISOString(),source:'ave_price_stream_sample'});
      same.push(f.s.checkNow(f.buy.orderId));
    }
    release();await Promise.all([first,...same]);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(maxActive,1);assert.equal(calls,2,'one full evaluation plus one coalesced latest full evaluation below +100%');
  }finally{await f.s.close();}
});

test('Jupiter registration normalizes legacy account-stream protection to external wake-ups',async()=>{
  const f=fixture(':memory:',{venue:'jupiter',protectionMode:'account_stream'});try{
    assert.equal(f.s.get(f.buy.orderId)?.buy.protectionMode,'external_price_stream');
    assert.equal(f.s.observeExternalPrice(f.buy.orderId,{priceUsd:1,observedAt:new Date(f.now()).toISOString(),source:'ave_price_stream_sample'}),true);
    await f.s.tick();const row=f.s.get(f.buy.orderId)!;assert.ok(row.quote);assert.equal('externalPriceAnchor' in row,false);
  }finally{await f.s.close();}
});

test('slippage bounds never shift the -60% or +100% expected executable price triggers',async()=>{
  const f=fixture();try{
    const quote=f.io.quote;f.io.quote=async request=>{const q=await quote(request);return {...q,minimumOutputAmount:(BigInt(q.outputAmount)*95n/100n).toString()};};
    f.setPrice(43n,100n);await f.s.tick();assert.equal(f.sells.length,0); // Min output is below -60%; expected output is still -57%.
    f.advance();f.setPrice(2n,5n);await f.s.tick();assert.equal(f.sells[0].reason,'stop_loss');
  }finally{await f.s.close();}
  const g=fixture();try{
    const quote=g.io.quote;g.io.quote=async request=>{const q=await quote(request);return {...q,minimumOutputAmount:(BigInt(q.outputAmount)*95n/100n).toString()};};
    g.setPrice(2n);await g.s.tick();assert.equal(g.sells.length,1);assert.equal(g.sells[0].reason,'take_profit');
    assert.equal(g.sells[0].quote.minimumOutputAmount,'950');assert.equal(g.sells[0].quote.outputAmount,'1000');
  }finally{await g.s.close();}
});

test('manual percentages share durable intent lock, floor huge balances exactly, and never consume TP',async()=>{
  const amount='9007199254740993',f=fixture(':memory:',{outputAmount:amount,inputAmount:'9007199254740993'});
  try{
    const result=f.s.manualSell(f.buy.orderId,25,'manual-25');assert.equal(result.status,'accepted');
    assert.equal(f.s.manualSell(f.buy.orderId,50,'racing-50').status,'blocked');
    await f.s.tick();assert.equal(f.sells.length,1);assert.equal(f.sells[0].expectedAmount,'2251799813685248');
    let row=f.s.get(f.buy.orderId)!;assert.equal(row.takeProfitDone,false);assert.equal(row.expectedBalanceAmount,'6755399441055745');
    assert.equal(f.s.manualSell(f.buy.orderId,25,'manual-25').status,'existing');assert.equal(f.sells.length,1);
    assert.equal(f.s.manualSell(f.buy.orderId,100,'manual-all').status,'accepted');await f.s.tick();
    assert.equal(f.sells[1].expectedAmount,'6755399441055745');assert.equal(f.sells[1].reason,'manual');
    f.advance();await f.s.tick();row=f.s.get(f.buy.orderId)!;assert.equal(row.state,'closed');assert.equal(row.finalPnlKnown,true);
    assert.equal(row.externalReductionAmount,'0');assert.equal(row.realizedPnlLamports,'0');
  }finally{await f.s.close();}
});

test('manual custom whole percentages use the latest verified balance and reject out-of-range values',async()=>{
  const amount='9007199254740993',f=fixture(':memory:',{outputAmount:amount,inputAmount:amount});
  try{
    assert.equal(f.s.manualSell(f.buy.orderId,0,'manual-zero').status,'blocked');
    assert.equal(f.s.manualSell(f.buy.orderId,101,'manual-over').status,'blocked');
    assert.equal(f.s.manualSell(f.buy.orderId,1.5,'manual-fraction').status,'blocked');
    assert.equal(f.s.manualSell(f.buy.orderId,30,'manual-30').status,'accepted');
    await f.s.tick();assert.equal(f.sells.length,1);assert.equal(f.sells[0].expectedAmount,'2702159776422297');
    assert.equal(f.sells[0].percent,30);assert.equal(f.sells[0].reason,'manual');
  }finally{await f.s.close();}
});

test('provisional zero and pre-buy finalized zero cannot close; transfer out is not a realized loss',async()=>{
  const f=fixture();try{
    f.setAmount('0','confirmed',101);await f.s.tick();assert.equal(f.s.get(f.buy.orderId)!.state,'active');assert.equal(f.sells.length,0);assert.equal(f.quotes.length,0);
    const balance=f.io.balance;f.io.balance=async request=>({...await balance(request),amount:'1000',commitment:'finalized',provisionalZero:true});
    f.advance();await f.s.tick();assert.equal(f.s.get(f.buy.orderId)!.state,'active');assert.equal(f.s.get(f.buy.orderId)!.quote,undefined);assert.equal(f.quotes.length,0);f.io.balance=balance;
    f.advance();f.setAmount('0','finalized',99);await f.s.tick();assert.equal(f.s.get(f.buy.orderId)!.state,'active');
    f.advance();f.setAmount('0','finalized',102);await f.s.tick();const row=f.s.get(f.buy.orderId)!;
    assert.equal(row.state,'closed');assert.equal(row.closeReason,'external_zero');assert.equal(row.externalReductionAmount,'1000');
    assert.equal(row.finalPnlKnown,false);assert.equal(row.soldTokenAmount,'0');assert.equal(row.realizedPnlLamports,'0');
    assert.equal(f.events.filter(e=>e.type==='closed').length,1);assert.equal(f.events.some(e=>e.type==='exit_confirmed'),false);
  }finally{await f.s.close();}
});

test('external reductions never latch TP and external additions make realized cost incomplete',async()=>{
  const f=fixture();try{
    f.setAmount('500');await f.s.tick();let row=f.s.get(f.buy.orderId)!;assert.equal(row.externalReductionAmount,'500');assert.equal(row.takeProfitDone,false);
    f.setAmount('700');f.advance();await f.s.tick();row=f.s.get(f.buy.orderId)!;assert.equal(row.externalIncreaseAmount,'200');assert.equal(row.realizedPnlLamports,undefined);
    f.s.manualSell(f.buy.orderId,100,'manual-external');await f.s.tick();f.advance();await f.s.tick();row=f.s.get(f.buy.orderId)!;
    assert.equal(row.state,'closed');assert.equal(row.finalPnlKnown,false);assert.equal(row.realizedPnlLamports,undefined);
  }finally{await f.s.close();}
});

test('confirmed external balance changes affect cost accounting without waiting for a finalized positive read',async()=>{
  const f=fixture();try{
    f.setAmount('800','confirmed',103);await f.s.tick();let row=f.s.get(f.buy.orderId)!;
    assert.equal(row.externalReductionAmount,'200');assert.equal(row.expectedBalanceAmount,'800');assert.equal(row.takeProfitDone,false);
    f.advance();f.setAmount('900','confirmed',104);await f.s.tick();row=f.s.get(f.buy.orderId)!;
    assert.equal(row.externalIncreaseAmount,'100');assert.equal(row.realizedPnlLamports,undefined);
    assert.equal(f.s.manualSell(f.buy.orderId,100,'manual-confirmed-delta').status,'accepted');await f.s.tick();
    row=f.s.get(f.buy.orderId)!;assert.equal(row.soldTokenAmount,'900');assert.equal(row.externalReductionAmount,'200');
    assert.equal(row.expectedBalanceAmount,'0');assert.equal(row.realizedPnlLamports,undefined);
    f.advance();f.setAmount('0','finalized',105);await f.s.tick();row=f.s.get(f.buy.orderId)!;
    assert.equal(row.state,'closed');assert.equal(row.finalPnlKnown,false);assert.equal(row.realizedPnlLamports,undefined);
  }finally{await f.s.close();}
});

test('older confirmed reads and finalized zeros cannot rewind a newer positive aggregate balance',async()=>{
  const f=fixture();try{
    f.setAmount('800','confirmed',110);await f.s.tick();assert.ok(f.s.get(f.buy.orderId)!.quote);
    for(const [amount,commitment] of [['1000','confirmed'],['0','finalized']] as const){
      f.advance(1000);f.s.markDirty(address(4));f.setAmount(amount,commitment,109);await f.s.tick();
      const row=f.s.get(f.buy.orderId)!;assert.equal(row.state,'active');assert.equal(row.balance!.slot,110);
      assert.equal(row.expectedBalanceAmount,'800');assert.equal(row.externalIncreaseAmount,'0');assert.equal(row.quote,undefined);
      assert.equal(row.lastError,'NATIVE_POSITION_BALANCE_INVALID');assert.equal(f.sells.length,0);
    }
    f.advance();f.setAmount('0','finalized',111);await f.s.tick();const row=f.s.get(f.buy.orderId)!;
    assert.equal(row.state,'closed');assert.equal(row.externalReductionAmount,'1000');assert.equal(row.finalPnlKnown,false);
  }finally{await f.s.close();}
});

test('WS dirty frames during async quotes do not invalidate execution and are coalesced behind minimum interval',async()=>{
  const f=fixture();try{
    f.setPrice(2n);const quote=f.io.quote;let injected=false;
    f.io.quote=async request=>{if(!injected){injected=true;f.advance(1);for(let i=0;i<20;i++)f.s.markDirty(address(4),{observedAt:new Date(f.now()).toISOString(),slot:101});}return quote(request);};
    await Promise.all([f.s.tick(),f.s.tick(),f.s.tick()]);assert.equal(f.sells.length,1);assert.equal(f.s.get(f.buy.orderId)!.takeProfitDone,true);
    const calls=f.quotes.length;await f.s.tick();assert.equal(f.quotes.length,calls);
  }finally{await f.s.close();}
});

test('curve-to-pool quotes persist new account subscriptions, ignore replayed buy routes and reject malformed targets',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'native-migration-')),path=join(dir,'positions.sqlite'),f=fixture();await f.s.close();
  const targets:string[][]=[],options={...f.options,onSubscriptions:(accounts:string[])=>{targets.push(accounts);}};
  let s=new NativePositionSupervisor(path,options);
  try{
    s.register(f.buy);s.start();const quote=f.io.quote,newAccounts=[address(6),address(7),address(5)];
    f.io.quote=async input=>({...await quote(input),subscriptionAccounts:newAccounts});await s.tick();
    assert.deepEqual(s.accounts(),[...newAccounts].sort());assert.deepEqual(targets.at(-1),s.accounts());
    assert.deepEqual(s.get(f.buy.orderId)!.buy.subscriptionAccounts,s.accounts());
    const unchangedCount=targets.length;f.advance();s.markDirty(address(6));await s.tick();
    assert.equal(targets.length,unchangedCount,'an unchanged quote route must not resync websocket subscriptions');
    await s.close();s=new NativePositionSupervisor(path,options);s.start();s.register(f.buy);
    assert.deepEqual(s.accounts(),[...newAccounts].sort());
    f.advance();s.markDirty(address(6));assert.equal(s.get(f.buy.orderId)!.dirty,true);await s.tick();
    f.advance();f.io.quote=async input=>({...await quote(input),subscriptionAccounts:['not-a-public-key']});await s.tick();
    assert.equal(s.get(f.buy.orderId)!.lastError,'NATIVE_POSITION_QUOTE_INVALID');assert.deepEqual(s.accounts(),[...newAccounts].sort());assert.equal(f.sells.length,0);
  }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('stale, wrong-size and malformed executable quotes block exits and readiness; fresh fallback restores health',async()=>{
  for(const mode of ['stale','wrong_size','too_long'] as const){const f=fixture();try{
    f.setPrice(2n);const quote=f.io.quote;f.io.quote=async request=>{const q=await quote(request);return mode==='stale'?{...q,quotedAt:new Date(f.now()-11000).toISOString(),expiresAt:new Date(f.now()-1000).toISOString()}:mode==='wrong_size'?{...q,inputAmount:'999'}:{...q,expiresAt:new Date(f.now()+11000).toISOString()};};
    await f.s.tick();assert.equal(f.sells.length,0);assert.equal(f.s.readiness().ready,false);
    f.io.quote=quote;f.setPrice(1n);f.advance();await f.s.tick();assert.equal(f.s.readiness().ready,true);
    f.advance(21000);assert.equal(f.s.readiness().ready,false);await f.s.tick();assert.equal(f.s.readiness().ready,true);
  }finally{await f.s.close();}}
});

test('stopping during preparation cannot submit; never-settling IO times out independently',async()=>{
  const f=fixture();try{
    f.setPrice(2n);let release!:()=>void;const balance=f.io.balance;f.io.balance=async request=>{await new Promise<void>(resolve=>{release=resolve;});return balance(request);};
    const tick=f.s.tick();await Promise.resolve();const stopping=f.s.stop();release();await Promise.all([tick,stopping]);
    assert.equal(f.sells.length,0);assert.equal(f.s.readiness().reason,'NATIVE_POSITION_SUPERVISOR_STOPPED');
  }finally{await f.s.close();}
  const g=fixture();await g.s.close();const s=new NativePositionSupervisor(':memory:',{...g.options,requestTimeoutMs:20,io:{...g.io,quote:async()=>new Promise(()=>{})}});
  try{s.register(g.buy);s.start();await s.tick();assert.equal(s.get(g.buy.orderId)!.lastError,'NATIVE_POSITION_IO_TIMEOUT');assert.equal(s.readiness().ready,false);}
  finally{await s.close();}
});

test('registration is immutable and closed identities cannot be reopened by replaying a confirmed buy',async()=>{
  const f=fixture();try{
    assert.equal(f.s.register(f.buy).revision,0);assert.throws(()=>f.s.register({...f.buy,inputAmount:'1001'}),/IDENTITY_CONFLICT/);
    assert.throws(()=>f.s.register({...f.buy,orderId:'second-buy'}),/DUPLICATE_TOKEN/);
    f.setAmount('0','finalized',103);await f.s.tick();assert.equal(f.s.register(f.buy).state,'closed');
    assert.equal(f.s.manualSell(f.buy.orderId,100,'closed-manual').status,'blocked');
  }finally{await f.s.close();}
});

test('a contract-bound name backfills an already active position and survives restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'native-position-name-')),path=join(dir,'positions.sqlite'),f=fixture(path,{name:'Wrong signal label'});
  let restarted:NativePositionSupervisor|undefined;
  try{
    assert.equal(f.s.setName(f.buy.orderId,'ハッチャン'),true);
    assert.equal(f.s.get(f.buy.orderId)!.buy.name,'ハッチャン');
    await f.s.close();restarted=new NativePositionSupervisor(path,f.options);
    assert.equal(restarted.get(f.buy.orderId)!.buy.name,'ハッチャン');
  }finally{await f.s.close();await restarted?.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed known exits do not latch TP, while mismatched confirmed receipts stay pending without reselling',async()=>{
  const f=fixture();try{
    f.setPrice(2n);f.setSale(async()=>({status:'failed',reason:'NATIVE_EXECUTOR_ROUTE_FAILED'}));await f.s.tick();
    assert.equal(f.s.get(f.buy.orderId)!.takeProfitDone,false);assert.equal(f.s.get(f.buy.orderId)!.pendingExit,undefined);
    f.setSale(async request=>({status:'confirmed',signature:signature(40),inputAmount:(BigInt(request.expectedAmount)-1n).toString(),outputAmount:'1000',confirmedAt:new Date(f.now()).toISOString(),slot:102}));
    f.advance();await f.s.tick();assert.equal(f.sells.length,2);assert.equal(f.s.get(f.buy.orderId)!.pendingExit!.failureReason,'NATIVE_POSITION_EXIT_UNVERIFIED');
    f.advance();await f.s.tick();assert.equal(f.sells.length,2);assert.equal(f.s.get(f.buy.orderId)!.takeProfitDone,false);
  }finally{await f.s.close();}
});
