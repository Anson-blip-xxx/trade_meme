import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {readConfig,type Config} from '../src/config.js';
import type {ExitPolicy} from '../src/exit-policy.js';
import {ENTRY_HOLDER_RISK_MAX_AGE_MS,normalizeStoredEntryHolderRisk,type EntryHolderRiskValues} from '../src/entry-holder-risk.js';
import {ManualNativeTestController,MANUAL_NATIVE_BUY_LAMPORTS,MANUAL_NATIVE_BUY_TTL_MS,
  type ManualNativeBuyOptions} from '../src/manual-native-buy.js';
import {OrderStore,type OpeningOrder} from '../src/orders.js';

const wallet=bs58.encode(new Uint8Array(32).fill(2));
const mint=bs58.encode(new Uint8Array(32).fill(3));
const otherMint=bs58.encode(new Uint8Array(32).fill(5));
const signature=bs58.encode(new Uint8Array(64).fill(4));
const SOL='So11111111111111111111111111111111111111112';
const policy={enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],
  stopLoss:{dropPct:60,sellPct:100}} as unknown as ExitPolicy;

function holderRisk(at:number,address=mint):EntryHolderRiskValues{return {provider:'gmgn',chain:'solana',address,
  checkedAt:new Date(at).toISOString(),completedAt:new Date(at).toISOString(),values:{
    top10:{value:'0.2',sourceField:'info.stat.top_10_holder_rate',coverage:'complete'},
    bundler:{value:'0.1',sourceField:'token_top_holders[tag=bundler].list[].amount_percentage',coverage:'complete'},
    ratTrader:{value:'0.05',sourceField:'token_top_holders[tag=rat_trader].list[].amount_percentage',coverage:'complete'},
  }};}

function fixture(t:{after:(fn:()=>void|Promise<void>)=>void},options:{balance?:(read:number)=>number;
  native?:ManualNativeBuyOptions['native'];holderRisk?:(address:string)=>EntryHolderRiskValues|Promise<EntryHolderRiskValues>}={}){
  const dir=mkdtempSync(join(tmpdir(),'manual-native-buy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const paths={orders:join(dir,'orders.sqlite'),actions:join(dir,'manual.sqlite')};
  const orders=new OrderStore(paths.orders);t.after(()=>orders.close());
  const clock={value:Date.now()+1000};const state={reads:0,execute:0,broadcast:0};
  const config:Config={...readConfig({}),solanaExecutionProvider:'pump_native',scannerChains:['solana'],rpc:{solana:'https://rpc.test'},
    entryWallets:{solana:wallet},entryInputTokens:{solana:SOL},entryFeeReserves:{bsc:'1',solana:'20000000',robinhood:'1'},
    entryMaxOpen:3,entrySlippagePct:5,exitPolicy:policy};
  const fetcher:typeof fetch=async(_input,init)=>{
    const body=JSON.parse(String(init?.body));
    if(body.method==='getGenesisHash')return Response.json({jsonrpc:'2.0',id:body.id,result:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'});
    if(body.method==='getBalance'){
      state.reads++;return Response.json({jsonrpc:'2.0',id:body.id,result:{context:{slot:100+state.reads},value:options.balance?.(state.reads)??1_000_000_000}});
    }
    if(body.method==='getSignatureStatuses')return Response.json({jsonrpc:'2.0',id:body.id,result:{value:[{slot:90,err:null,confirmationStatus:'finalized'}]}});
    throw Error('UNEXPECTED_RPC');
  };
  const native=options.native??{readiness:()=>({ready:true}),execute:async(order:OpeningOrder,guard:()=>Promise<void>)=>{
    state.execute++;await guard();state.broadcast++;
    return orders.update(order.id,['submitting'],{status:'submitted',transactionHash:signature},new Date(clock.value))!;
  }};
  const readHolderRisk=(address:string)=>Promise.resolve(options.holderRisk?.(address)??holderRisk(clock.value,address));
  const make=()=>new ManualNativeTestController(config,orders,{database:paths.actions,native,fetcher,readHolderRisk,now:()=>new Date(clock.value)});
  return {dir,paths,orders,clock,state,config,fetcher,native,readHolderRisk,make};
}

test('prompt has one durable owner-scoped action, canonical mint validation and a five-minute final button',async t=>{
  const f=fixture(t);const controller=f.make();t.after(()=>controller.close());
  const first=controller.begin({scope:'private:1',owner:'1'});assert.equal(first.status,'created');
  assert.match(first.action.ref,/^[0-9a-f]{32}$/);assert.equal(first.action.state,'awaiting_address');
  assert.equal(controller.prepare({scope:'private:1',owner:'1',mint:SOL}).status,'blocked');
  assert.equal(controller.prepare({scope:'private:1',owner:'1',mint:'not-a-mint'}).status,'blocked');
  const second=controller.begin({scope:'private:1',owner:'1'});assert.equal(second.status,'created');
  assert.equal(controller.get(first.action.ref)?.state,'canceled');
  const ready=controller.prepare({scope:'private:1',owner:'1',mint});assert.equal(ready.status,'ready');
  if(ready.status!=='ready')assert.fail();
  assert.equal(ready.action.mint,mint);assert.equal(controller.pending('private:1','1')?.ref,ready.action.ref);
  assert.equal(Date.parse(ready.action.expiresAt)-f.clock.value,MANUAL_NATIVE_BUY_TTL_MS);
  f.clock.value+=MANUAL_NATIVE_BUY_TTL_MS+1;
  const expired=controller.confirm({scope:'private:1',owner:'1',ref:ready.action.ref});assert.equal(expired.status,'blocked');
  assert.equal(controller.get(ready.action.ref)?.state,'expired');assert.equal(f.state.execute,0);
});

test('one final click reserves exactly 0.01 SOL, atomically rechecks funding, claims identity and never repeats broadcast',async t=>{
  const f=fixture(t);const notifications:{key:string;text:string}[]=[];
  const controller=new ManualNativeTestController(f.config,f.orders,{database:f.paths.actions,native:f.native,fetcher:f.fetcher,
    readHolderRisk:f.readHolderRisk,now:()=>new Date(f.clock.value),enqueue:event=>{notifications.push(event);return true;}});t.after(()=>controller.close());
  assert.equal(controller.begin({scope:'private:1',owner:'1'}).status,'created');
  const ready=controller.prepare({scope:'private:1',owner:'1',mint});assert.equal(ready.status,'ready');if(ready.status!=='ready')assert.fail();
  const accepted=controller.confirm({scope:'private:1',owner:'1',ref:ready.action.ref});assert.equal(accepted.status,'accepted');
  // confirm only performs the durable CAS; RPC and signing are background work.
  assert.equal(f.state.reads,0);await controller.settle();
  assert.equal(f.state.reads,1);assert.equal(f.state.execute,1);assert.equal(f.state.broadcast,1);
  const action=controller.get(ready.action.ref)!;assert.equal(action.state,'completed');assert.ok(action.orderId);
  const order=f.orders.get(action.orderId!)!;assert.equal(order.inputAmount,MANUAL_NATIVE_BUY_LAMPORTS);
  assert.equal(order.status,'submitted');assert.equal(order.details.executionStrategy,'manual_native_test_v1');
  assert.equal(order.details.executionProvider,'pump_native');assert.equal(f.orders.hasAttemptedOpening('solana',mint),true);
  const again=controller.confirm({scope:'private:1',owner:'1',ref:ready.action.ref});assert.equal(again.status,'existing');
  await controller.settle();assert.equal(f.state.execute,1);assert.equal(f.state.broadcast,1);
  assert.equal(notifications.length,0,'durable order notifier owns the final result');
});

test('default direct trigger atomically creates a single risk-checked action and starts no second confirmation flow',async t=>{
  const f=fixture(t),controller=f.make();t.after(()=>controller.close());
  const accepted=controller.trigger({scope:'private:1',owner:'1',mint});assert.equal(accepted.status,'accepted');
  if(accepted.status!=='accepted')assert.fail();assert.match(accepted.action.ref,/^[0-9a-f]{32}$/);
  assert.equal(accepted.action.state,'executing');assert.equal(accepted.action.mode,'risk_checked');await controller.settle();
  assert.equal(f.state.execute,1);assert.equal(f.state.broadcast,1);assert.equal(f.orders.list().length,1);
  assert.equal(f.orders.hasAttemptedOpening('solana',mint),true);
  assert.equal(controller.trigger({scope:'private:1',owner:'1',mint}).status,'blocked');
});

test('card-direct trigger never reads or blocks on GMGN holder risk and still attaches exit protection',async t=>{
  let riskReads=0;const notifications:{key:string;text:string}[]=[];
  const f=fixture(t,{holderRisk:()=>{riskReads++;throw Error('GMGN_SHOULD_NOT_BE_CALLED');}});
  const controller=new ManualNativeTestController(f.config,f.orders,{database:f.paths.actions,native:f.native,fetcher:f.fetcher,
    readHolderRisk:f.readHolderRisk,now:()=>new Date(f.clock.value),enqueue:event=>{notifications.push(event);return true;}});t.after(()=>controller.close());
  const amountLamports='125000000';
  const accepted=controller.triggerCard({scope:'private:1',owner:'1',mint,amountLamports});assert.equal(accepted.status,'accepted');
  if(accepted.status!=='accepted')assert.fail();
  assert.equal(accepted.action.amountLamports,amountLamports);
  assert.equal(accepted.action.mode,'card_direct');await controller.settle();
  assert.equal(riskReads,0);assert.equal(f.state.execute,1);assert.equal(f.state.broadcast,1);
  const order=f.orders.list()[0];assert.ok(order);assert.equal(order.status,'submitted');
  assert.equal(order.inputAmount,amountLamports);assert.equal(order.details.entryHolderRisk,undefined);
  assert.equal((order.details.manualTest as Record<string,unknown>).entryMode,'card_direct');
  assert.equal((order.details.manualTest as Record<string,unknown>).requestedAmountLamports,amountLamports);
  assert.ok(order.exit);assert.deepEqual(order.exit.policy,policy);assert.equal(order.exit.state,'awaiting_swap');
  assert.equal(notifications.length,0,'卡片点击已经回复“已接收”；submitted 阶段由统一订单通知层静默等待最终结果');
});

test('卡片买入已有订单结果时不再由控制器重复通知 failed 或 unknown',async t=>{
  for(const status of ['failed','unknown'] as const)await t.test(status,async t=>{
    const notifications:{key:string;text:string}[]=[];
    let f!:ReturnType<typeof fixture>;f=fixture(t,{native:{readiness:()=>({ready:true}),execute:async(order,guard)=>{
      f.state.execute++;await guard();f.state.broadcast++;
      return f.orders.update(order.id,['submitting'],{status,failureReason:status==='failed'?
        'NATIVE_SIMULATION_FAILED':'NATIVE_BROADCAST_UNCERTAIN'},new Date(f.clock.value))!;
    }}});
    const controller=new ManualNativeTestController(f.config,f.orders,{database:f.paths.actions,native:f.native,fetcher:f.fetcher,
      readHolderRisk:f.readHolderRisk,now:()=>new Date(f.clock.value),enqueue:event=>{notifications.push(event);return true;}});t.after(()=>controller.close());
    const accepted=controller.triggerCard({scope:'private:1',owner:'1',mint,amountLamports:'10000000'});
    assert.equal(accepted.status,'accepted');await controller.settle();
    assert.equal(f.orders.list()[0]?.status,status);
    assert.equal(notifications.length,0,'订单订阅者负责唯一最终通知，控制器不应再发一条');
  });
});

test('card preset clicks preserve each exact amount and duplicate clicks never create a second order',async t=>{
  for(const amountLamports of ['100000000','500000000'] as const)await t.test(amountLamports,async t=>{
    let release!:()=>void,entered!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
    const releasePromise=new Promise<void>(resolve=>{release=resolve;});
    let f!:ReturnType<typeof fixture>;f=fixture(t,{native:{readiness:()=>({ready:true}),execute:async(order,guard)=>{
      f.state.execute++;entered();await releasePromise;await guard();f.state.broadcast++;
      return f.orders.update(order.id,['submitting'],{status:'submitted',transactionHash:signature},new Date(f.clock.value))!;
    }}});
    const controller=f.make();t.after(()=>controller.close());
    const first=controller.triggerCard({scope:'private:1',owner:'1',mint,amountLamports});assert.equal(first.status,'accepted');
    if(first.status!=='accepted')assert.fail();await enteredPromise;
    const duplicate=controller.triggerCard({scope:'private:1',owner:'1',mint,amountLamports});assert.equal(duplicate.status,'existing');
    const different=controller.triggerCard({scope:'private:1',owner:'1',mint,amountLamports:'900000000'});
    assert.equal(different.status,'blocked');if(different.status==='blocked')assert.equal(different.reason,'MANUAL_NATIVE_BUY_IN_PROGRESS');
    release();await controller.settle();
    assert.equal(f.state.execute,1);assert.equal(f.state.broadcast,1);assert.equal(f.orders.list().length,1);
    assert.equal(f.orders.list()[0]?.inputAmount,amountLamports);
  });
});

test('custom card amount is durable, expires and atomically submits without holder-risk reads',async t=>{
  let riskReads=0;const f=fixture(t,{holderRisk:()=>{riskReads++;throw Error('GMGN_SHOULD_NOT_BE_CALLED');}});
  const controller=f.make();t.after(()=>controller.close());
  const prompt=controller.beginCardCustom({scope:'private:1',owner:'1',mint});assert.equal(prompt.status,'created');
  if(prompt.status!=='created')assert.fail();
  assert.equal(prompt.action.state,'awaiting_amount');assert.equal(prompt.action.mode,'card_direct');
  assert.equal(prompt.action.mint,mint);assert.equal(prompt.action.amountLamports,undefined);
  assert.equal(controller.pending('private:1','1')?.ref,prompt.action.ref);
  assert.equal(f.state.reads,0);assert.equal(f.state.execute,0);assert.equal(f.orders.list().length,0);
  for(const amountLamports of ['0','01','-1','1.0',' 1','18446744073709551616']){
    const invalid=controller.submitCardCustom({scope:'private:1',owner:'1',amountLamports});assert.equal(invalid.status,'blocked');
    if(invalid.status==='blocked')assert.equal(invalid.reason,'MANUAL_NATIVE_AMOUNT_INVALID');
  }
  const submitted=controller.submitCardCustom({scope:'private:1',owner:'1',amountLamports:'333000000'});
  assert.equal(submitted.status,'accepted');if(submitted.status!=='accepted')assert.fail();
  assert.equal(submitted.action.amountLamports,'333000000');
  const duplicate=controller.submitCardCustom({scope:'private:1',owner:'1',amountLamports:'333000000'});
  assert.equal(duplicate.status,'existing');
  await controller.settle();assert.equal(riskReads,0);assert.equal(f.state.execute,1);assert.equal(f.state.broadcast,1);
  assert.equal(f.orders.list()[0]?.inputAmount,'333000000');

  const expiry=controller.beginCardCustom({scope:'private:2',owner:'2',mint:otherMint});assert.equal(expiry.status,'created');
  if(expiry.status!=='created')assert.fail();f.clock.value+=MANUAL_NATIVE_BUY_TTL_MS+1;
  assert.equal(controller.submitCardCustom({scope:'private:2',owner:'2',amountLamports:'100000000'}).status,'blocked');
  assert.equal(controller.get(expiry.action.ref)?.state,'expired');
});

test('an awaiting custom amount participates in replacement, cancel and the owner pending invariant',async t=>{
  const f=fixture(t),controller=f.make();t.after(()=>controller.close());
  const first=controller.beginCardCustom({scope:'private:1',owner:'1',mint});assert.equal(first.status,'created');
  if(first.status!=='created')assert.fail();
  const duplicate=controller.beginCardCustom({scope:'private:1',owner:'1',mint});assert.equal(duplicate.status,'existing');
  if(duplicate.status!=='existing')assert.fail();assert.equal(duplicate.action.ref,first.action.ref);
  const replacement=controller.begin({scope:'private:1',owner:'1'});assert.equal(replacement.status,'created');
  assert.equal(controller.get(first.action.ref)?.state,'canceled');
  const custom=controller.beginCardCustom({scope:'private:2',owner:'2',mint});assert.equal(custom.status,'created');
  if(custom.status!=='created')assert.fail();
  const canceled=controller.cancel({scope:'private:2',owner:'2'});assert.equal(canceled.status,'canceled');
  assert.equal(controller.get(custom.action.ref)?.state,'canceled');assert.equal(f.state.execute,0);
});

test('card-direct route remains operational without a holder-risk provider while normal routes fail closed',async t=>{
  const f=fixture(t);
  const controller=new ManualNativeTestController(f.config,f.orders,{database:f.paths.actions,native:f.native,
    fetcher:f.fetcher,now:()=>new Date(f.clock.value)});t.after(()=>controller.close());
  assert.deepEqual(controller.readiness(),{ready:false,reason:'ENTRY_HOLDER_RISK_PROVIDER_MISSING'});
  assert.equal(controller.trigger({scope:'private:1',owner:'1',mint}).status,'blocked');
  assert.equal(controller.begin({scope:'private:1',owner:'1'}).status,'created');
  assert.equal(controller.prepare({scope:'private:1',owner:'1',mint}).status,'blocked');
  const card=controller.triggerCard({scope:'private:2',owner:'2',mint,amountLamports:'75000000'});assert.equal(card.status,'accepted');
  await controller.settle();assert.equal(f.state.execute,1);assert.equal(f.state.broadcast,1);
});

test('legacy action databases migrate to risk-checked mode and card mode survives restart',async t=>{
  const f=fixture(t);const legacyRef='a'.repeat(32),created=new Date(f.clock.value).toISOString();
  const legacy=new DatabaseSync(f.paths.actions);legacy.exec(`CREATE TABLE manual_native_buy_actions(
    ref TEXT PRIMARY KEY,scope TEXT NOT NULL,owner TEXT NOT NULL,mint TEXT,state TEXT NOT NULL,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,order_id TEXT,failure_reason TEXT
  );`);
  legacy.prepare(`INSERT INTO manual_native_buy_actions
    (ref,scope,owner,mint,state,created_at,updated_at,expires_at,order_id,failure_reason) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(legacyRef,'private:legacy','legacy',null,'awaiting_address',created,created,new Date(f.clock.value+60_000).toISOString(),null,null);
  legacy.close();
  const first=f.make();assert.equal(first.get(legacyRef)?.mode,'risk_checked');
  assert.equal(first.get(legacyRef)?.amountLamports,MANUAL_NATIVE_BUY_LAMPORTS);
  const card=first.triggerCard({scope:'private:1',owner:'1',mint,amountLamports:'420000000'});assert.equal(card.status,'accepted');
  if(card.status!=='accepted')assert.fail();await first.settle();assert.equal(first.get(card.action.ref)?.mode,'card_direct');await first.close();
  const restarted=f.make();t.after(()=>restarted.close());
  assert.equal(restarted.get(legacyRef)?.mode,'risk_checked');assert.equal(restarted.get(card.action.ref)?.mode,'card_direct');
  assert.equal(restarted.get(card.action.ref)?.amountLamports,'420000000');
  assert.equal(f.orders.byEvent(f.orders.list()[0]!.eventKey)?.status,'submitted');
});

test('the pre-variable card schema safely backfills its historical 0.01 SOL amount',async t=>{
  const f=fixture(t);const ref='b'.repeat(32),created=new Date(f.clock.value).toISOString();
  const legacy=new DatabaseSync(f.paths.actions);legacy.exec(`CREATE TABLE manual_native_buy_actions(
    ref TEXT PRIMARY KEY,scope TEXT NOT NULL,owner TEXT NOT NULL,mint TEXT,state TEXT NOT NULL,
    entry_mode TEXT NOT NULL DEFAULT 'risk_checked' CHECK(entry_mode IN ('risk_checked','card_direct')),
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,order_id TEXT,failure_reason TEXT
  );
  CREATE UNIQUE INDEX manual_native_buy_one_pending ON manual_native_buy_actions(scope,owner)
    WHERE state IN ('awaiting_address','ready','executing');`);
  legacy.prepare(`INSERT INTO manual_native_buy_actions
    (ref,scope,owner,mint,state,entry_mode,created_at,updated_at,expires_at,order_id,failure_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(ref,'private:old-card','old-card',mint,'completed','card_direct',created,created,
      new Date(f.clock.value+60_000).toISOString(),null,null);
  legacy.close();
  const controller=f.make();t.after(()=>controller.close());const action=controller.get(ref);
  assert.equal(action?.mode,'card_direct');assert.equal(action?.amountLamports,MANUAL_NATIVE_BUY_LAMPORTS);
});

test('custom card prompt and mode survive restart before its exact amount is submitted',async t=>{
  const f=fixture(t);const first=f.make();
  const prompt=first.beginCardCustom({scope:'private:1',owner:'1',mint});assert.equal(prompt.status,'created');
  if(prompt.status!=='created')assert.fail();await first.close();
  const restarted=f.make();t.after(()=>restarted.close());
  const restored=restarted.get(prompt.action.ref);assert.equal(restored?.state,'awaiting_amount');
  assert.equal(restored?.mode,'card_direct');assert.equal(restored?.mint,mint);assert.equal(restored?.amountLamports,undefined);
  const accepted=restarted.submitCardCustom({scope:'private:1',owner:'1',amountLamports:'88000000'});
  assert.equal(accepted.status,'accepted');await restarted.settle();
  assert.equal(restarted.get(prompt.action.ref)?.amountLamports,'88000000');assert.equal(f.orders.list()[0]?.inputAmount,'88000000');
});

test('fresh GMGN holder risk is persisted and unknown, incomplete or exceeded evidence blocks before broadcast',async t=>{
  for(const [label,mutate,expected] of [
    ['exceeded',(risk:EntryHolderRiskValues)=>{risk.values.top10.value='0.2500000001';},'ENTRY_HOLDER_RISK_TOP10_EXCEEDED'],
    ['unknown',(risk:EntryHolderRiskValues)=>{risk.values.bundler={value:undefined,
      sourceField:'token_top_holders[tag=bundler].list[].amount_percentage',coverage:'lower_bound',lowerBound:'0.1'};},
    'ENTRY_HOLDER_RISK_BUNDLER_MISSING'],
  ] as const)await t.test(label,async t=>{
    let f!:ReturnType<typeof fixture>;f=fixture(t,{holderRisk:address=>{const risk=holderRisk(f.clock.value,address);mutate(risk);return risk;}});
    const controller=f.make();t.after(()=>controller.close());
    assert.equal(controller.trigger({scope:'private:1',owner:'1',mint}).status,'accepted');await controller.settle();
    assert.equal(f.state.execute,0);assert.equal(f.state.broadcast,0);assert.equal(f.orders.hasAttemptedOpening('solana',mint),false);
    const order=f.orders.list()[0];assert.ok(order);assert.equal(order.status,'failed');assert.equal(order.failureReason,expected);
    const evidence=normalizeStoredEntryHolderRisk(order.details.entryHolderRisk,{chain:'solana',address:mint});assert.ok(evidence);
    assert.notEqual(evidence.status,'pass');assert.ok(evidence.reasons.includes(expected));
  });
});

test('final native guard rejects holder evidence that aged past the shared 30 second entry window',async t=>{
  let f!:ReturnType<typeof fixture>;f=fixture(t,{holderRisk:address=>holderRisk(f.clock.value-ENTRY_HOLDER_RISK_MAX_AGE_MS+1_000,address),
    native:{readiness:()=>({ready:true}),execute:async(order,guard)=>{
    f.state.execute++;f.clock.value+=1_001;await guard();f.state.broadcast++;
    return f.orders.update(order.id,['submitting'],{status:'submitted',transactionHash:signature},new Date(f.clock.value))!;
  }}});const controller=f.make();t.after(()=>controller.close());
  assert.equal(controller.trigger({scope:'private:1',owner:'1',mint}).status,'accepted');await controller.settle();
  assert.equal(f.state.execute,1);assert.equal(f.state.broadcast,0);assert.equal(f.orders.hasAttemptedOpening('solana',mint),false);
  assert.equal(f.orders.list()[0]?.failureReason,'ENTRY_HOLDER_RISK_STALE');
});

test('a fixed buy that reserve must shrink is failed before native execution',async t=>{
  const f=fixture(t,{balance:()=>25_000_000});const controller=f.make();t.after(()=>controller.close());
  controller.begin({scope:'private:1',owner:'1'});const ready=controller.prepare({scope:'private:1',owner:'1',mint});
  assert.equal(ready.status,'ready');if(ready.status!=='ready')assert.fail();
  assert.equal(controller.confirm({scope:'private:1',owner:'1',ref:ready.action.ref}).status,'accepted');await controller.settle();
  assert.equal(f.state.execute,0);assert.equal(f.state.broadcast,0);
  const action=controller.get(ready.action.ref)!;assert.equal(action.state,'failed');
  assert.equal(action.failureReason,'MANUAL_NATIVE_FIXED_AMOUNT_UNAVAILABLE');
  const order=f.orders.get(action.orderId!)!;assert.equal(order.inputAmount,'5000000');assert.equal(order.status,'failed');
  assert.equal(f.orders.hasAttemptedOpening('solana',mint),false);
});

test('a stale funding snapshot during the pre-broadcast guard fails closed without a permanent attempt',async t=>{
  const f=fixture(t,{native:{readiness:()=>({ready:true}),execute:async(order,guard)=>{
    f.state.execute++;f.clock.value+=30_001;await guard();f.state.broadcast++;
    return f.orders.update(order.id,['submitting'],{status:'submitted',transactionHash:signature},new Date(f.clock.value))!;
  }}});const controller=f.make();t.after(()=>controller.close());
  controller.begin({scope:'private:1',owner:'1'});const ready=controller.prepare({scope:'private:1',owner:'1',mint});
  assert.equal(ready.status,'ready');if(ready.status!=='ready')assert.fail();
  controller.confirm({scope:'private:1',owner:'1',ref:ready.action.ref});await controller.settle();
  assert.equal(f.state.execute,1);assert.equal(f.state.broadcast,0);assert.equal(f.state.reads,1);
  const action=controller.get(ready.action.ref)!;assert.equal(action.state,'failed');assert.equal(action.failureReason,'ENTRY_BALANCE_STALE');
  assert.equal(f.orders.get(action.orderId!)?.status,'failed');assert.equal(f.orders.hasAttemptedOpening('solana',mint),false);
});

test('ready actions survive restart, while an interrupted prepared execution is failed and cannot broadcast',async t=>{
  let release!:()=>void,entered!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
  const releasePromise=new Promise<void>(resolve=>{release=resolve;});
  let executeCalls=0,broadcasts=0;
  const f=fixture(t,{native:{readiness:()=>({ready:true}),execute:async(order,guard)=>{
    executeCalls++;entered();await releasePromise;await guard();broadcasts++;
    return f.orders.update(order.id,['submitting'],{status:'submitted',transactionHash:signature},new Date(f.clock.value))!;
  }}});
  const first=f.make();first.begin({scope:'private:1',owner:'1'});const ready=first.prepare({scope:'private:1',owner:'1',mint});
  assert.equal(ready.status,'ready');if(ready.status!=='ready')assert.fail();
  await first.close();
  const restarted=f.make();t.after(()=>restarted.close());assert.equal(restarted.get(ready.action.ref)?.state,'ready');
  restarted.confirm({scope:'private:1',owner:'1',ref:ready.action.ref});await enteredPromise;
  const recovering=f.make();t.after(()=>recovering.close());
  assert.equal(recovering.get(ready.action.ref)?.state,'failed');
  const order=f.orders.byEvent((f.orders.list()[0]?.eventKey)??'')!;assert.equal(order.status,'failed');
  release();await restarted.settle();assert.equal(executeCalls,1);assert.equal(broadcasts,0);
  assert.equal(recovering.confirm({scope:'private:1',owner:'1',ref:ready.action.ref}).status,'blocked');
});

test('permanent identity claim rejects a later manual action for the same CA',async t=>{
  const f=fixture(t);const controller=f.make();t.after(()=>controller.close());
  controller.begin({scope:'private:1',owner:'1'});const first=controller.prepare({scope:'private:1',owner:'1',mint});
  assert.equal(first.status,'ready');if(first.status!=='ready')assert.fail();controller.confirm({scope:'private:1',owner:'1',ref:first.action.ref});await controller.settle();
  controller.begin({scope:'private:1',owner:'1'});const second=controller.prepare({scope:'private:1',owner:'1',mint});
  assert.equal(second.status,'ready');if(second.status!=='ready')assert.fail();controller.confirm({scope:'private:1',owner:'1',ref:second.action.ref});await controller.settle();
  assert.equal(f.state.execute,1);assert.equal(f.state.broadcast,1);
  assert.ok(['ASSET_ALREADY_OPEN','ASSET_REENTRY_BLOCKED'].includes(controller.get(second.action.ref)?.failureReason??''));
  // Another mint remains independently usable.
  controller.begin({scope:'private:1',owner:'1'});assert.equal(controller.prepare({scope:'private:1',owner:'1',mint:otherMint}).status,'ready');
});

test('native failed and unknown outcomes keep truthful durable state without controller duplicate notices',async t=>{
  for(const expected of ['failed','unknown'] as const)await t.test(expected,async t=>{
    const notifications:{key:string;text:string}[]=[];
    const f=fixture(t,{native:{readiness:()=>({ready:true}),execute:async(order,guard)=>{
      f.state.execute++;await guard();f.state.broadcast++;
      return f.orders.update(order.id,['submitting'],{status:expected,failureReason:expected==='failed'?
        'NATIVE_SIMULATION_FAILED':'NATIVE_BROADCAST_UNCERTAIN'},new Date(f.clock.value))!;
    }}});
    const controller=new ManualNativeTestController(f.config,f.orders,{database:f.paths.actions,native:f.native,fetcher:f.fetcher,
      readHolderRisk:f.readHolderRisk,now:()=>new Date(f.clock.value),enqueue:event=>{notifications.push(event);return true;}});t.after(()=>controller.close());
    controller.begin({scope:'private:1',owner:'1'});const ready=controller.prepare({scope:'private:1',owner:'1',mint});
    assert.equal(ready.status,'ready');if(ready.status!=='ready')assert.fail();
    assert.equal(controller.confirm({scope:'private:1',owner:'1',ref:ready.action.ref}).status,'accepted');await controller.settle();
    assert.equal(controller.get(ready.action.ref)?.state,expected==='failed'?'failed':'completed');
    assert.equal(notifications.length,0,'durable order notifier owns the final result');
    assert.equal(f.orders.get(controller.get(ready.action.ref)!.orderId!)?.failureReason,
      expected==='failed'?'NATIVE_SIMULATION_FAILED':'NATIVE_BROADCAST_UNCERTAIN');
  });
});
