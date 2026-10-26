import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Keypair} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import bs58 from 'bs58';
import {readConfig} from '../src/config.js';
import {OrderStore} from '../src/orders.js';
import {parseExitPolicy} from '../src/exit-policy.js';
import {NativeTradingRuntime} from '../src/native-solana/runtime.js';
import type {NativeExecutionResult,NativeExecuteRequest} from '../src/native-solana/executor.js';
import {NativePositionSupervisor,type NativePositionIO,type NativePositionState,type NativePositionBalance} from '../src/native-solana/positions.js';
import type {NativeSwapPlan} from '../src/native-solana/pump.js';
import type {TradeNotificationEvent} from '../src/trade-notifications.js';

const wallet=Keypair.fromSeed(Buffer.alloc(32,61)).publicKey.toBase58();
const mint=Keypair.fromSeed(Buffer.alloc(32,62)).publicKey.toBase58();
const curve=Keypair.fromSeed(Buffer.alloc(32,63)).publicKey.toBase58();
const pool=Keypair.fromSeed(Buffer.alloc(32,64)).publicKey.toBase58();
const vault=Keypair.fromSeed(Buffer.alloc(32,65)).publicKey.toBase58();
const signature=bs58.encode(Buffer.alloc(64,66));
const policy=parseExitPolicy({enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}})!;

/** Real persistence and runtime wiring; no signer, socket, RPC, or send is permitted. */
function fixture(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),'native-runtime-'));
  const config=readConfig({ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_WALLET_SOLANA:wallet,
    SOLANA_EXECUTION_PROVIDER:'pump_native',SOLANA_NATIVE_KEYPAIR_FILE:join(dir,'missing-test-key.json'),
    SOLANA_NATIVE_RPC_URL:'https://rpc.invalid',SOLANA_NATIVE_WS_URL:'wss://rpc.invalid',
    SOLANA_NATIVE_JOURNAL_PATH:join(dir,'journal.sqlite'),SOLANA_NATIVE_POSITIONS_PATH:join(dir,'positions.sqlite')});
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('TEST_FORBIDS_NETWORK');});
  const orders=new OrderStore(config.ordersDatabase),events:TradeNotificationEvent[]=[];
  const runtime=new NativeTradingRuntime(config,orders,event=>{events.push(event);return true;});
  // Access only module boundaries; the runtime and position state machines remain real.
  const internal=runtime as any,positions=internal.positions;
  const io=positions.options.io as NativePositionIO,subscriptions:string[][]=[];
  positions.options.autoSchedule=false;positions.options.eventDriven=false;
  t.mock.method(internal.stream,'setAccounts',(accounts:string[])=>{subscriptions.push([...accounts]);});
  t.mock.method(internal.stream,'status',()=>({connected:true,subscribedAccounts:[],lastHeadSlot:110}));
  const balances=new Map<string,{amount:string;slot:number}>(),tracked:{mint:string;decimals:number;program:string}[]=[];
  t.mock.method(internal.inventory,'status',()=>({ready:true,accounts:balances.size,trackedMints:tracked.length,snapshotSlots:[102,102]}));
  t.mock.method(internal.inventory,'track',(tokenMint:string,decimals:number,program:string)=>{tracked.push({mint:tokenMint,decimals,program});});
  t.mock.method(internal.inventory,'read',(tokenMint:string,floor:number,now:number):NativePositionBalance=>{
    const b=balances.get(tokenMint);if(!b)throw Error('NATIVE_INVENTORY_NOT_READY');if(b.slot<floor)throw Error('NATIVE_INVENTORY_BEFORE_FILL');
    return {wallet,mint:tokenMint,amount:b.amount,slot:b.slot,tokenDecimals:6,commitment:'confirmed',observedAt:new Date(now).toISOString()};
  });
  const rpcBalance=t.mock.method(internal.adapter,'balance',async(_wallet:string,tokenMint:string,commitment:string)=>{
    const b=balances.get(tokenMint);if(!b)throw Error('TEST_BALANCE_NOT_STUBBED');return {...b,decimals:6,accounts:[vault],commitment};
  });
  const httpQuote=t.mock.method(internal.adapter,'quoteSell',async()=>{throw Error('TEST_FORBIDS_HTTP_PRICE_POLL');});
  t.mock.method(internal.adapter,'quoteSellCached',()=>{throw Error('TEST_QUOTE_NOT_STUBBED');});
  const warm=t.mock.method(internal.adapter,'warmQuoteCache',async()=>({venue:'pump',subscriptionAccounts:[wallet,curve],priceAccounts:[curve],
    slot:102,receivedAtMs:Date.now(),tokenDecimals:6,tokenProgram:TOKEN_PROGRAM_ID.toBase58()}));
  t.mock.method(internal.adapter,'cacheStatus',()=>({warm:true,ready:true}));
  t.mock.method(internal.ownerConnection,'getGenesisHash',async()=>{throw Error('TEST_INVENTORY_RPC_NOT_STUBBED');});
  t.mock.method(internal.ownerConnection,'getTokenAccountsByOwner',async()=>{throw Error('TEST_INVENTORY_RPC_NOT_STUBBED');});
  t.mock.method(internal.executor,'execute',async()=>{throw Error('TEST_EXECUTION_NOT_STUBBED');});
  t.mock.method(internal.executor,'reconcile',async()=>{throw Error('TEST_RECONCILE_NOT_STUBBED');});
  t.after(async()=>{await runtime.stop();orders.close();rmSync(dir,{recursive:true,force:true});assert.equal(network.mock.callCount(),0);});
  function activate(){internal.running=true;internal.chainVerified=true;positions.start();}
  function reserve(){
    const at=new Date(Date.now()-1000);
    const order=orders.reserve({eventKey:'native-fixture',chain:'solana',tokenAddress:mint,mode:'live',wallet,
      inputToken:'So11111111111111111111111111111111111111112',inputAmount:'10000000',slippagePct:5,
      exit:{policy,state:'awaiting_swap',reasons:[],checkedAt:at.toISOString(),positionClosed:false},
      details:{executionProvider:'pump_native',executionStrategy:'third_signal_v1',token:{name:'Test mint'}}},10,at).order!;
    assert.ok(order);orders.beginSubmission(order.id,at);return order;
  }
  function result(orderId:string,status:'submitted'|'confirmed'='confirmed'):NativeExecutionResult {
    const checkedAt=new Date(Date.now()-500).toISOString();
    const base:NativeExecutionResult={intentId:'buy-'+orderId,orderId,wallet,mint,side:'buy',status,signature,venue:'pump',
      tokenDecimals:6,subscriptionAccounts:[wallet,curve],checkedAt};
    return status==='confirmed'?{...base,inputAmount:'10000000',outputAmount:'1000',slot:100}:
      {...base,provisional:{trade:{} as never,inputAmount:'10000000',outputAmount:'1000',actualNativeAmount:'10000000',
        networkFeeLamports:'10000',slot:100,checkedAt}};
  }
  function buy(status:'submitted'|'confirmed'='confirmed'){
    const order=reserve();internal.applyBuy(order.id,result(order.id,status));return orders.get(order.id)!;
  }
  function balance(amount:string,slot=102,tokenMint=mint){balances.set(tokenMint,{amount,slot});}
  function quote(multiplier=15000n,subscriptionAccounts=[wallet,curve],marketAt=Date.now()-200){
    internal.adapter.quoteSellCached=(request:{amount:string})=>({expectedOutputAmount:(BigInt(request.amount)*multiplier).toString(),
      minimumOutputAmount:(BigInt(request.amount)*multiplier*95n/100n).toString(),quotedAt:new Date(marketAt).toISOString(),
      subscriptionAccounts,slot:102,receivedAtMs:marketAt});
  }
  async function clear(orderId:string){await positions.checkNow(orderId);await Promise.all([...internal.zeroWork.values()]);await positions.checkNow(orderId);}
  return {dir,config,runtime,internal,orders,positions,io,events,subscriptions,activate,reserve,result,buy,balance,quote,clear,rpcBalance,httpQuote,warm,tracked};
}

test('runtime construction never scans closed position history to seed an empty inventory cache',t=>{
  const list=t.mock.method(NativePositionSupervisor.prototype,'list',()=>{throw Error('FULL_HISTORY_SCAN_FORBIDDEN');});
  fixture(t);assert.equal(list.mock.callCount(),0);
});

test('native recovery loads the indexed active set once and then reconciles only remembered order ids',async t=>{
  const f=fixture(t),order=f.reserve();let scans=0,reconciles=0;
  const active=f.orders.activeNativePositions.bind(f.orders);
  t.mock.method(f.orders,'activeNativePositions',()=>{scans++;return active();});
  f.internal.executor.warmup=async()=>{};
  f.internal.executor.reconcile=async()=>{reconciles++;return {intentId:'buy-'+order.id,orderId:order.id,wallet,mint,side:'buy',
    status:'submitted',checkedAt:new Date().toISOString()};};
  f.internal.running=true;
  await f.internal.pulse();await f.internal.pulse();
  assert.equal(scans,1);assert.equal(reconciles,2);assert.equal(f.orders.get(order.id)?.status,'submitted');
});

test('native recovery and action outboxes use targeted sqlite indexes',t=>{
  const f=fixture(t),ordersDb=new DatabaseSync(f.config.ordersDatabase,{readOnly:true});
  const nativePlan=ordersDb.prepare(`EXPLAIN QUERY PLAN SELECT details FROM opening_orders WHERE mode='live' AND chain='solana'
    AND status IN ('submitting','submitted','confirmed','unknown')
    AND json_extract(details,'$.details.executionProvider')='pump_native'
    AND COALESCE(json_extract(details,'$.exit.positionClosed'),0)<>1
    AND NOT (COALESCE(json_extract(details,'$.details.authoritativeClose.kind'),'')='direct_sell') ORDER BY rowid ASC`).all();
  assert.match(nativePlan.map(row=>String(row.detail)).join('\n'),/opening_orders_active_lookup/);ordersDb.close();
  const actionsDb=new DatabaseSync(f.config.nativeSolana!.positionsPath+'.actions.sqlite',{readOnly:true});
  const actionPlan=actionsDb.prepare('EXPLAIN QUERY PLAN SELECT * FROM native_actions WHERE intent_id IS NOT NULL AND dispatched=0 LIMIT 20').all();
  const noticePlan=actionsDb.prepare('EXPLAIN QUERY PLAN SELECT key,text FROM native_notice_outbox WHERE queued=0 LIMIT 100').all();
  assert.match(actionPlan.map(row=>String(row.detail)).join('\n'),/native_actions_pending/);
  assert.match(noticePlan.map(row=>String(row.detail)).join('\n'),/native_notice_outbox_pending/);actionsDb.close();
});

test('runtime public readiness blocks absent signer, recovery errors, unknown chain, disconnected stream and incomplete inventory',async t=>{
  const f=fixture(t);
  assert.equal(f.runtime.status().readiness.reason,'NATIVE_PROTECTION_STOPPED');
  f.activate();assert.equal(f.runtime.readiness().reason,'NATIVE_SIGNER_UNAVAILABLE');
  f.internal.executor.readiness=()=>({ready:true});assert.deepEqual(f.runtime.readiness(),{ready:true});
  f.internal.error='NATIVE_RECOVERY_UNAVAILABLE';
  assert.deepEqual(f.runtime.status().readiness,{ready:false,reason:'NATIVE_RECOVERY_UNAVAILABLE'});
  assert.equal(f.runtime.status().antiMev.publicFallback,false);
  f.internal.error=undefined;f.internal.chainVerified=false;
  assert.equal(f.runtime.readiness().reason,'NATIVE_CHAIN_NOT_VERIFIED');
  f.internal.chainVerified=true;f.internal.stream.status=()=>({connected:false,subscribedAccounts:[]});
  assert.equal(f.runtime.readiness().reason,'NATIVE_WEBSOCKET_UNAVAILABLE');
  f.internal.stream.status=()=>({connected:true,subscribedAccounts:[]});f.internal.inventory.status=()=>({ready:false});
  assert.equal(f.runtime.readiness().reason,'NATIVE_INVENTORY_NOT_READY');
});

test('curve-to-pool quotes update actual supervisor subscriptions through runtime IO',async t=>{
  const f=fixture(t),order=f.buy();f.balance('1000');
  f.quote(15000n,[wallet,pool,vault]);
  f.activate();await f.positions.tick();
  assert.deepEqual(f.runtime.get(order.id)!.buy.subscriptionAccounts,[wallet,pool,vault].sort());
  assert.deepEqual(f.subscriptions.at(-1),[wallet,pool,vault].sort());
  assert.ok(!f.subscriptions.at(-1)!.includes(curve));
  assert.equal(f.runtime.get(order.id)!.pendingExit,undefined);
});

test('cache warm backfills an existing active order and position from mint-bound metadata',async t=>{
  const f=fixture(t),order=f.buy();
  assert.equal(f.runtime.get(order.id)!.buy.name,'Test mint');
  f.internal.adapter.warmQuoteCache=async()=>({venue:'pump',subscriptionAccounts:[wallet,curve],priceAccounts:[curve],
    slot:102,receivedAtMs:Date.now(),tokenDecimals:6,tokenProgram:TOKEN_PROGRAM_ID.toBase58(),
    tokenIdentity:{source:'token_2022_mint_extension',name:'ハッチャン',symbol:'Hatchan'}});
  f.activate();await f.internal.warm(mint,order.id);
  const updated=f.orders.get(order.id)!;
  assert.deepEqual(updated.details.nativeTokenIdentity,
    {source:'token_2022_mint_extension',name:'ハッチャン',symbol:'Hatchan'});
  assert.deepEqual(updated.details.token,{name:'ハッチャン',chain:'solana',address:mint,symbol:'Hatchan'});
  assert.equal(f.runtime.get(order.id)!.buy.name,'ハッチャン');
});

test('provisional holding closed before finalized buy syncs terminal state into the opening ledger',async t=>{
  const f=fixture(t),order=f.buy('submitted');
  assert.equal(f.runtime.get(order.id)?.state,'active');assert.equal(f.orders.get(order.id)?.status,'submitted');
  f.balance('0');f.activate();await f.clear(order.id);
  assert.equal(f.runtime.isClosed(order.id),true);assert.equal(f.orders.get(order.id)?.exit?.positionClosed,false);
  f.internal.applyBuy(order.id,f.result(order.id,'confirmed'));
  const final=f.orders.get(order.id)!;
  assert.equal(final.status,'confirmed');assert.equal(final.exit?.positionClosed,true);assert.equal(final.exit?.state,'closed');
  assert.equal(final.exit?.native?.balanceAmount,'0');assert.deepEqual(f.orders.activePositions(),[]);
  assert.equal(f.orders.hasOpeningHistory('solana',mint,'live'),true);
});

test('late active callbacks cannot reopen or emit stale milestones after authoritative closure',async t=>{
  const f=fixture(t),order=f.buy();const stale=structuredClone(f.runtime.get(order.id)!) as NativePositionState;
  stale.balance={wallet,mint,amount:'1000',tokenDecimals:6,slot:101,commitment:'confirmed',observedAt:new Date().toISOString()};
  stale.quote={wallet,mint,inputAmount:'1000',outputAmount:'30000000',minimumOutputAmount:'28500000',
    quotedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+10000).toISOString()};
  stale.pendingExit={operationId:'stale-pending',percent:50,reason:'take_profit',expectedAmount:'500',state:'pending',
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  f.balance('0');f.activate();await f.clear(order.id);
  const count=f.events.length;assert.ok(f.events.some(event=>event.text.includes('原生持仓已清空')));
  for(const type of ['snapshot','registered','exit_pending'])f.internal.onPosition({key:'late-'+type,type,position:stale});
  assert.equal(f.events.length,count);assert.equal(f.orders.get(order.id)?.exit?.positionClosed,true);
});

test('missing executor intent stays pending only while runtime is still preparing that exact sell',async t=>{
  const f=fixture(t);f.activate();let resolveBalance!:(value:unknown)=>void;
  f.internal.adapter.balance=()=>new Promise(resolve=>{resolveBalance=resolve;});
  f.internal.executor.execute=async(request:NativeExecuteRequest)=>{
    await request.beforeBroadcast!({expectedOutputAmount:'1000000'} as NativeSwapPlan);
    throw Error('TEST_MUST_NOT_BROADCAST');
  };
  const request={orderId:'order',wallet,mint,operationId:'preparing-sell',percent:50 as const,reason:'manual' as const,
    expectedAmount:'500',quote:{} as never};
  const work=f.io.sell(request);
  const reconcile={orderId:'order',wallet,mint,operationId:request.operationId,signal:new AbortController().signal};
  assert.deepEqual(await f.io.reconcile(reconcile),{status:'pending',reason:'NATIVE_PREPARATION_IN_PROGRESS'});
  assert.deepEqual(await f.io.reconcile({...reconcile,operationId:'other-intent'}),{status:'failed',reason:'NATIVE_INTERRUPTED_BEFORE_BROADCAST'});
  resolveBalance({amount:'0'});await assert.rejects(work,/NATIVE_BALANCE_CHANGED/);
  assert.deepEqual(await f.io.reconcile(reconcile),{status:'failed',reason:'NATIVE_INTERRUPTED_BEFORE_BROADCAST'});
});

test('existing sell journal intent is reconciled instead of being declared missing or resubmitted',async t=>{
  const f=fixture(t);let reconciled=0;
  f.internal.executor.get=()=>({intentId:'existing'});
  f.internal.executor.reconcile=async()=>{reconciled++;return {status:'submitted',signature};};
  const result=await f.io.reconcile({orderId:'order',wallet,mint,operationId:'existing',signal:new AbortController().signal});
  assert.deepEqual(result,{status:'pending',signature,reason:undefined});assert.equal(reconciled,1);
});

test('final native sell plan rechecks exact take-profit and stop-loss boundaries before broadcast',async t=>{
  const f=fixture(t),order=f.buy();f.balance('1000');f.activate();let sent=0,output='9999999';
  f.internal.executor.execute=async(request:NativeExecuteRequest)=>{
    await request.beforeBroadcast!({expectedOutputAmount:output} as NativeSwapPlan);sent++;
    return {status:'submitted',signature};
  };
  const sell=(reason:'take_profit'|'stop_loss'|'manual',percent:50|100)=>f.io.sell({orderId:order.id,wallet,mint,operationId:'boundary-'+sent,
    percent,reason,expectedAmount:percent===50?'500':'1000',quote:{} as never});
  await assert.rejects(sell('take_profit',50),/NATIVE_EXIT_TRIGGER_CHANGED/);assert.equal(sent,0);
  output='10000000';assert.equal((await sell('take_profit',50)).status,'pending');assert.equal(sent,1);
  output='4000001';await assert.rejects(sell('stop_loss',100),/NATIVE_EXIT_TRIGGER_CHANGED/);assert.equal(sent,1);
  output='4000000';assert.equal((await sell('stop_loss',100)).status,'pending');assert.equal(sent,2);
  output='1000000';assert.equal((await sell('manual',50)).status,'pending');assert.equal(sent,3);
  f.internal.running=false;await assert.rejects(sell('manual',50),/NATIVE_EXECUTOR_STOPPED/);assert.equal(sent,3);
});

test('runtime reads positive inventory locally and asynchronously finalizes zero without returning a stale positive balance',async t=>{
  const f=fixture(t),order=f.buy(),calls:string[]=[];let resolveFinalized!:(b:unknown)=>void;f.activate();f.balance('1000');
  f.internal.adapter.balance=async(_wallet:string,_mint:string,commitment:string)=>{calls.push(commitment);return new Promise(resolve=>{resolveFinalized=resolve;});};
  const request={orderId:order.id,wallet,mint,signal:new AbortController().signal};
  const positive=await f.io.balance(request);assert.equal(positive.commitment,'confirmed');assert.deepEqual(calls,[]);
  f.balance('0');const waiting=await f.io.balance(request);
  assert.equal(waiting.amount,'0');assert.equal(waiting.commitment,'confirmed');assert.deepEqual(calls,['finalized']);
  assert.equal(f.runtime.isClosed(order.id),false);resolveFinalized({amount:'0',decimals:6,slot:102});
  await Promise.all([...f.internal.zeroWork.values()]);const empty=await f.io.balance(request);
  assert.equal(empty.amount,'0');assert.equal(empty.commitment,'finalized');
});

test('live quote uses only stream cache, preserves actual market timestamp and never polls HTTP price or balance',async t=>{
  const f=fixture(t),order=f.buy(),marketAt=Date.now()-300;f.balance('1000');f.quote(15000n,[wallet,curve],marketAt);f.activate();
  await f.positions.tick();const p=f.runtime.get(order.id)!;
  assert.equal(p.quote?.source,'solana_account_stream');assert.equal(p.quote?.marketObservedAt,new Date(marketAt).toISOString());
  assert.equal(p.quote?.marketSlot,102);assert.ok(Date.parse(p.quote!.quotedAt)>=marketAt+250);
  assert.equal(f.httpQuote.mock.callCount(),0);assert.equal(f.rpcBalance.mock.callCount(),0);
  f.internal.stream.status=()=>({connected:false,subscribedAccounts:[],lastHeadSlot:110});
  await assert.rejects(f.io.quote({orderId:order.id,wallet,mint,amount:'1000',signal:new AbortController().signal}),/NATIVE_WEBSOCKET_UNAVAILABLE/);
  await assert.rejects(f.io.balance({orderId:order.id,wallet,mint,signal:new AbortController().signal}),/NATIVE_WEBSOCKET_UNAVAILABLE/);
  await f.positions.checkNow(order.id);assert.equal(f.runtime.get(order.id)?.quote,undefined);
  assert.equal(f.runtime.get(order.id)?.lastError,'NATIVE_WEBSOCKET_UNAVAILABLE');assert.equal(f.httpQuote.mock.callCount(),0);
});

test('newly bought mint warms subscriptions and inventory identity without a separate monitor-ready notification',async t=>{
  const f=fixture(t);f.balance('1000');f.quote();f.activate();f.internal.executor.readiness=()=>({ready:true});
  const order=f.buy();assert.equal(f.runtime.readiness().reason,'NATIVE_POSITION_SUPERVISION_STALE');
  await Promise.all([...f.internal.warming.values()]);assert.equal(f.warm.mock.callCount(),1);
  assert.deepEqual(f.tracked,[{mint,decimals:6,program:TOKEN_PROGRAM_ID.toBase58()}]);
  await f.positions.tick();assert.equal(f.runtime.get(order.id)?.quote?.source,'solana_account_stream');
  assert.equal(f.events.filter(event=>event.key===`native-monitor-ready:${order.id}`).length,0);
  await f.positions.tick();assert.equal(f.events.filter(event=>event.key===`native-monitor-ready:${order.id}`).length,0);
  assert.equal(f.events.some(event=>event.text.includes('持仓定时摘要')),false);
  assert.deepEqual(f.runtime.readiness(),{ready:true});
});

test('replaying a confirmed buy never polls HTTP once its quote cache is warm',async t=>{
  const f=fixture(t);f.balance('1000');f.quote();f.activate();
  const order=f.buy();await Promise.all([...f.internal.warming.values()]);
  assert.equal(f.warm.mock.callCount(),1);
  f.internal.warmRetryAt.clear();
  f.internal.register(f.orders.get(order.id)!);await Promise.all([...f.internal.warming.values()]);
  assert.equal(f.warm.mock.callCount(),1);assert.equal(f.httpQuote.mock.callCount(),0);
});

test('pending subscriptions for another mint do not suspend an already acknowledged holding',async t=>{
  const f=fixture(t),order=f.buy();f.balance('1000');f.quote();f.activate();
  f.internal.stream.status=()=>({connected:false,transportHealthy:true,subscribedAccounts:[wallet,curve],lastHeadSlot:105});
  await f.positions.checkNow(order.id);
  assert.equal(f.runtime.get(order.id)?.lastError,undefined);
  assert.equal(f.runtime.get(order.id)?.quote?.source,'solana_account_stream');
  f.internal.stream.status=()=>({connected:false,transportHealthy:true,subscribedAccounts:[wallet],lastHeadSlot:105});
  await f.positions.checkNow(order.id);assert.equal(f.runtime.get(order.id)?.lastError,'NATIVE_WEBSOCKET_UNAVAILABLE');
});

test('native buy verifies its own price subscriptions before broadcast and keeps them through registration',async t=>{
  const f=fixture(t);f.activate();const order=f.reserve();let guarded=0;
  f.internal.stream.isSubscribed=(accounts:string[])=>accounts.every(a=>f.subscriptions.at(-1)?.includes(a));
  f.internal.executor.execute=async(request:NativeExecuteRequest)=>{
    request.onPlanReady!({subscriptionAccounts:[wallet,curve]} as NativeSwapPlan);
    assert.deepEqual(f.subscriptions.at(-1),[wallet,curve].sort());
    await request.beforeBroadcast!({subscriptionAccounts:[wallet,curve]} as NativeSwapPlan);
    assert.equal(guarded,1);return f.result(order.id);
  };
  await f.runtime.execute(order,async()=>{guarded++;});
  assert.deepEqual(f.subscriptions.at(-1),[wallet,curve].sort());
  assert.equal(f.internal.entryWatches.size,0);
});

test('a busy shared opening ledger cannot stop local price decisions and routine summaries stay silent',async t=>{
  const f=fixture(t),order=f.buy();f.balance('1000');f.quote();f.activate();f.internal.executor.readiness=()=>({ready:true});
  const write=t.mock.method(f.orders,'updateNativeProtection',()=>{throw Error('database is locked');});
  await f.positions.checkNow(order.id);
  assert.equal(f.runtime.get(order.id)?.lastError,undefined);assert.ok(f.runtime.get(order.id)?.quote);
  assert.equal(f.runtime.status().orderSyncPending,1);assert.equal(f.runtime.readiness().reason,'NATIVE_ORDER_SYNC_UNAVAILABLE');
  assert.equal(f.events.some(e=>e.text.includes('持仓定时摘要')),false);
  write.mock.restore();f.internal.syncPosition(f.runtime.get(order.id));
  assert.equal(f.runtime.status().orderSyncPending,0);assert.equal(f.runtime.readiness().ready,true);
});

test('a verified new fill starts independent protection even while its opening ledger update is locked',async t=>{
  const f=fixture(t);f.activate();f.balance('1000');f.quote();f.internal.executor.readiness=()=>({ready:true});
  const order=f.reserve(),fill=f.result(order.id);
  const write=t.mock.method(f.orders,'update',()=>{throw Error('database is locked');});
  f.internal.applyBuy(order.id,fill);
  assert.equal(f.runtime.get(order.id)?.state,'active');assert.equal(f.internal.buySyncPending.size,1);
  await Promise.all([...f.internal.warming.values()]);await f.positions.checkNow(order.id);
  assert.equal(f.runtime.get(order.id)?.quote?.source,'solana_account_stream');
  assert.equal(f.runtime.readiness().reason,'NATIVE_ORDER_SYNC_UNAVAILABLE');
  write.mock.restore();f.internal.applyBuy(order.id,fill);
  assert.equal(f.internal.buySyncPending.size,0);assert.equal(f.orders.get(order.id)?.status,'confirmed');
  assert.equal(f.runtime.get(order.id)?.buy.outputAmount,'1000');
});

test('stream loss during the final buy guard rejects broadcast and releases only the pending entry subscriptions',async t=>{
  const f=fixture(t);f.activate();const order=f.reserve();let healthy=true,guarded=0;
  f.internal.stream.isSubscribed=()=>healthy;
  f.internal.executor.execute=async(request:NativeExecuteRequest)=>{
    await request.beforeBroadcast!({subscriptionAccounts:[wallet,curve]} as NativeSwapPlan);
    throw Error('TEST_MUST_NOT_BROADCAST');
  };
  await assert.rejects(f.runtime.execute(order,async()=>{guarded++;healthy=false;}),/NATIVE_ENTRY_PRICE_STREAM_UNAVAILABLE/);
  assert.equal(guarded,1);assert.equal(f.internal.entryWatches.size,0);assert.deepEqual(f.subscriptions.at(-1),[]);
});

test('missing subscription ACK blocks native buy before its last guard rather than opening blind',async t=>{
  const f=fixture(t);f.activate();const order=f.reserve();let guarded=0;
  f.internal.stream.isSubscribed=()=>false;
  f.internal.executor.execute=async(request:NativeExecuteRequest)=>{
    await request.beforeBroadcast!({subscriptionAccounts:[wallet,curve]} as NativeSwapPlan);
    throw Error('TEST_MUST_NOT_BROADCAST');
  };
  await assert.rejects(f.runtime.execute(order,async()=>{guarded++;}),/NATIVE_ENTRY_PRICE_STREAM_UNAVAILABLE/);
  assert.equal(guarded,0);assert.equal(f.internal.entryWatches.size,0);
});

test('inventory bootstrap RPC failure fails readiness without substituting market prices for wallet inventory',async t=>{
  const f=fixture(t);f.activate();f.internal.executor.readiness=()=>({ready:true});f.internal.inventory.status=()=>({ready:false});
  await f.internal.refreshInventory();assert.equal(f.runtime.readiness().reason,'NATIVE_INVENTORY_RPC_UNAVAILABLE');
  assert.equal(f.runtime.status().inventory.error,'NATIVE_INVENTORY_RPC_UNAVAILABLE');assert.equal(f.httpQuote.mock.callCount(),0);
});

test('slow finalized-zero reconciliation never blocks another holding from receiving a stream-cache quote',async t=>{
  const f=fixture(t),zeroOrder=f.buy(),otherMint=Keypair.fromSeed(Buffer.alloc(32,75)).publicKey.toBase58();
  f.positions.register({orderId:'other-order',wallet,mint:otherMint,inputAmount:'10000000',outputAmount:'1000',tokenDecimals:6,
    signature:bs58.encode(Buffer.alloc(64,76)),buySlot:100,subscriptionAccounts:[wallet,pool],confirmedAt:new Date(Date.now()-500).toISOString()});
  f.balance('0');f.balance('1000',102,otherMint);f.quote();f.activate();let finish!:(b:unknown)=>void;
  f.internal.adapter.balance=async()=>new Promise(resolve=>{finish=resolve;});
  let completed=false;const work=f.positions.tick().then(()=>{completed=true;});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(completed,true);await work;
  assert.equal(f.runtime.get(zeroOrder.id)?.lastError,'NATIVE_POSITION_ZERO_UNFINALIZED');
  assert.equal(f.runtime.get('other-order')?.quote?.source,'solana_account_stream');assert.equal(f.internal.zeroWork.size,1);
  finish({amount:'0',decimals:6,slot:102});await Promise.all([...f.internal.zeroWork.values()]);
  await f.positions.checkNow(zeroOrder.id);assert.equal(f.runtime.isClosed(zeroOrder.id),true);
});

test('account frame directly schedules its position evaluation and records receive-to-evaluation latency',async t=>{
  const f=fixture(t),order=f.buy();f.balance('1000');f.quote();f.activate();f.positions.options.eventDriven=true;
  const ingested=t.mock.method(f.internal.adapter,'ingestAccount',()=>[mint]);
  t.mock.method(f.internal.inventory,'ingest',()=>[]);
  const receivedAtMs=Date.now();f.internal.onAccount({address:curve,info:null,slot:105,receivedAtMs,kind:'account',generation:1});
  const deadline=Date.now()+1000;
  while(!f.runtime.get(order.id)?.quote&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(ingested.mock.callCount(),1);assert.equal(f.runtime.get(order.id)?.quote?.source,'solana_account_stream');
  const latency=f.runtime.status().prices.receiveToEvaluationMs;
  assert.equal(latency.samples,1);assert.ok(latency.max!==undefined&&latency.max<1000);
  assert.equal(f.httpQuote.mock.callCount(),0);assert.equal(f.rpcBalance.mock.callCount(),0);
});

test('disconnect invalidates an in-flight warm snapshot before it can restore old-generation subscriptions',async t=>{
  const f=fixture(t);f.activate();f.balance('1000');let finish!:(q:unknown)=>void;
  f.internal.adapter.warmQuoteCache=()=>new Promise(resolve=>{finish=resolve;});
  f.buy();const work=[...f.internal.warming.values()];assert.equal(work.length,1);
  const generation=f.internal.cacheGeneration;
  f.internal.stream.callbacks.reset({generation:2,reason:'disconnect'});
  assert.equal(f.internal.cacheGeneration,generation+1);
  finish({venue:'pumpswap',subscriptionAccounts:[wallet,pool,vault],tokenDecimals:6,tokenProgram:TOKEN_PROGRAM_ID.toBase58()});
  await Promise.all(work);assert.equal(f.tracked.length,0);assert.ok(!f.subscriptions.at(-1)?.includes(pool));
});

test('authoritative closure releases quote and inventory work before a delayed bootstrap can finish',async t=>{
  const f=fixture(t),order=f.buy(),dropped:string[]=[];f.activate();f.balance('0');
  f.internal.adapter.dropQuoteCache=(_wallet:string,token:string)=>dropped.push(token);
  const retired=t.mock.method(f.internal.inventory,'retire',()=>{});
  f.internal.eventAt.set(order.id,Date.now());f.internal.incompleteSince.set(mint,Date.now());
  let finishWarm!:(value:unknown)=>void;
  f.internal.adapter.warmQuoteCache=()=>new Promise(resolve=>{finishWarm=resolve;});
  const warm=f.internal.warm(mint,order.id);
  await f.clear(order.id);
  assert.equal(f.runtime.isClosed(order.id),true);assert.deepEqual(dropped,[mint]);
  assert.equal(retired.mock.callCount(),1);assert.deepEqual(f.subscriptions.at(-1),[]);
  assert.equal(f.internal.mintOrders.has(mint),false);assert.equal(f.internal.eventAt.has(order.id),false);
  assert.equal(f.internal.incompleteSince.has(mint),false);assert.equal(f.internal.warmRetryAt.has(mint),false);
  finishWarm({subscriptionAccounts:[wallet,curve],tokenDecimals:6,tokenProgram:TOKEN_PROGRAM_ID.toBase58()});await warm;
  assert.deepEqual(f.tracked,[]);assert.deepEqual(f.subscriptions.at(-1),[]);
  assert.equal(f.internal.warming.size,0);assert.equal(f.orders.hasOpeningHistory('solana',mint,'live'),true);
  f.internal.register(f.orders.get(order.id)!);await f.internal.bootstrap();
  assert.equal(f.internal.mintOrders.size,0);assert.deepEqual(f.subscriptions.at(-1),[]);
});

test('partial holdings retain their stream and quote cache',async t=>{
  const f=fixture(t),order=f.buy();f.activate();f.balance('500');f.quote();
  const dropped=t.mock.fn();f.internal.adapter.dropQuoteCache=dropped;
  await f.positions.checkNow(order.id);
  assert.equal(f.runtime.get(order.id)?.state,'active');assert.equal(f.internal.mintOrders.get(mint),order.id);
  assert.equal(dropped.mock.callCount(),0);assert.deepEqual(f.subscriptions.at(-1),[wallet,curve].sort());
});

test('native protection health changes update internal state without Telegram alert or recovery messages',async t=>{
  const f=fixture(t),order=f.buy();f.activate();f.balance('1000');f.quote();
  await f.positions.checkNow(order.id);f.internal.startedAt=Date.now()-20_000;
  f.internal.stream.status=()=>({connected:false,transportHealthy:false,subscribedAccounts:[],lastHeadSlot:110});
  f.internal.healthNotice();
  assert.equal(f.events.some(event=>event.key.startsWith('native-health:')),false);
  assert.equal(Number(f.internal.db.prepare('SELECT active FROM native_health WHERE id=1').get().active),1);
  f.internal.stream.status=()=>({connected:true,transportHealthy:true,subscribedAccounts:[wallet,curve],lastHeadSlot:110});
  f.internal.healthNotice();
  assert.equal(f.events.some(event=>event.key.startsWith('native-health:')),false);
  assert.equal(Number(f.internal.db.prepare('SELECT active FROM native_health WHERE id=1').get().active),0);
});

test('native loss milestones stay silent while gain milestones and confirmed exits remain visible',async t=>{
  const f=fixture(t),order=f.buy();f.activate();f.balance('1000');f.quote(10000n);
  await f.positions.checkNow(order.id);
  const evaluated=structuredClone(f.runtime.get(order.id)!) as NativePositionState;
  evaluated.quote!.outputAmount='5000000';evaluated.quote!.minimumOutputAmount='4750000';
  evaluated.quote!.quotedAt=new Date().toISOString();evaluated.quote!.expiresAt=new Date(Date.now()+10_000).toISOString();
  f.internal.recordEvaluation(evaluated);f.internal.flushPendingMilestones();
  assert.equal(f.events.some(event=>event.key.startsWith(`native-milestone:${order.id}:`)),false,
    '负涨幅只用于本地止损决策，不另发 Telegram 档位通知');

  evaluated.quote!.outputAmount='15000000';evaluated.quote!.minimumOutputAmount='14250000';
  f.internal.recordEvaluation(evaluated);f.internal.flushPendingMilestones();
  assert.equal(f.events.filter(event=>event.text.includes('持仓涨跌提醒')&&event.text.includes('+50.00%')).length,1);

  for(const [reason,label,index] of [
    ['take_profit','原生止盈',1],['stop_loss','原生止损',2],['manual','原生手动卖出',3],
  ] as const){
    const position=structuredClone(f.runtime.get(order.id)!) as NativePositionState;
    position.lastExit={operationId:`confirmed-${reason}`,percent:reason==='stop_loss'?100:50,reason,expectedAmount:'500',
      state:'confirmed',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),signature,
      inputAmount:'500',outputAmount:'6000000',confirmedAt:new Date().toISOString(),slot:110};
    f.internal.onPosition({key:`exit-${index}`,type:'exit_confirmed',position});
    assert.equal(f.events.filter(event=>event.text.includes(label)).length,1,`${label} 成交必须保留通知`);
  }
});

test('a brief gain milestone is captured immediately even when ordinary snapshot delivery is deferred',async t=>{
  const f=fixture(t),order=f.buy();f.activate();f.balance('1000');f.quote(10000n);
  await f.positions.checkNow(order.id);
  f.positions.options.onUpdate=()=>{};
  f.quote(15000n);await f.positions.checkNow(order.id);
  await new Promise(resolve=>setTimeout(resolve,30));
  const notices=()=>f.events.filter(e=>e.text.includes('持仓涨跌提醒')&&e.text.includes('+50.00%'));
  assert.equal(notices().length,1);
  f.quote(10000n);await f.positions.checkNow(order.id);
  f.quote(15000n);await f.positions.checkNow(order.id);
  assert.equal(notices().length,1);
});

test('fast evaluation retains a crossing without reading notification storage and retries a failed write',async t=>{
  const f=fixture(t),order=f.buy();f.activate();f.balance('1000');f.quote(10000n);
  await f.positions.checkNow(order.id);
  const p=structuredClone(f.runtime.get(order.id)!) as NativePositionState;
  p.quote!.outputAmount='15000000';p.quote!.minimumOutputAmount='14250000';
  p.quote!.expiresAt=new Date(Date.now()+10000).toISOString();
  const unavailable=t.mock.method(f.internal.db,'prepare',()=>{throw Error('database is locked');});
  f.internal.recordEvaluation(p);
  assert.equal(unavailable.mock.callCount(),0,'the price decision callback must do no notification DB reads or writes');
  assert.deepEqual(f.internal.pendingMilestones.get(order.id)?.crossed,[50]);
  f.internal.flushPendingMilestones();assert.ok(unavailable.mock.callCount()>0);
  assert.deepEqual(f.internal.pendingMilestones.get(order.id)?.crossed,[50]);
  unavailable.mock.restore();f.internal.milestoneRetryAt.clear();f.internal.flushPendingMilestones();
  assert.equal(f.internal.pendingMilestones.size,0);
  assert.equal(f.events.filter(e=>e.text.includes('持仓涨跌提醒')&&e.text.includes('+50.00%')).length,1);
  assert.equal(Number(f.internal.db.prepare('PRAGMA busy_timeout').get().timeout),5);
});
