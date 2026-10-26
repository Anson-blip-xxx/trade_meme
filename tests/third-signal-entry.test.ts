import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bs58 from 'bs58';
import {readConfig,type Config} from '../src/config.js';
import type {ExitPolicy} from '../src/exit-policy.js';
import {OrderStore} from '../src/orders.js';
import {ThirdSignalEntryController,type ThirdSignalEntryOptions} from '../src/third-signal-entry.js';
import type {ThirdSignalCandidate} from '../src/third-signal-strategy.js';
import {EntryController} from '../src/entry.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import {normalizeStoredEntryHolderRisk,type EntryHolderRiskValues} from '../src/entry-holder-risk.js';
const wallet=bs58.encode(new Uint8Array(32).fill(2)),mint=bs58.encode(new Uint8Array(32).fill(3));
const signature=bs58.encode(new Uint8Array(64).fill(4)),SOL='So11111111111111111111111111111111111111112';
const pem=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString();
const policy={enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}} as unknown as ExitPolicy;
function holdingRisk(at:number,address=mint):EntryHolderRiskValues {
  return {provider:'gmgn',chain:'solana',address,checkedAt:new Date(at).toISOString(),values:{
    top10:{value:'0.25',sourceField:'info.stat.top_10_holder_rate'},
    bundler:{value:'0.4',sourceField:'token_top_holders.bundler.amount_percentage',coverage:'complete'},
    ratTrader:{value:'0.3',sourceField:'token_top_holders.rat_trader.amount_percentage',coverage:'complete'}}};
}
function candidate(at:number,overrides:Record<string,unknown>={}):ThirdSignalCandidate {
  return {id:randomUUID(),runId:randomUUID(),windowId:randomUUID(),source:'debot',chain:'solana',address:mint,eventId:randomUUID(),
    count:3,marketCapUsd:100000,occurredAt:new Date(at-100).toISOString(),receivedAt:new Date(at-50).toISOString(),createdAt:new Date(at).toISOString(),
    mode:'live',executionEnabled:true,phase:'live_candidate',name:'Test Meme',symbol:'TST',...overrides} as unknown as ThirdSignalCandidate;
}
function fixture(t:{after:(fn:()=>void)=>void},options:{store?:OrderStore;config?:Partial<Config>;enabled?:boolean;
  quote?:(body:Record<string,string>)=>unknown|Promise<unknown>;onBalance?:(n:number)=>void;swap?:(body:Record<string,unknown>)=>unknown|Promise<unknown>;
  scheduleRequest?:ThirdSignalEntryOptions['scheduleRequest'];noHolderRisk?:boolean;
  maxConcurrent?:number;
  native?:ThirdSignalEntryOptions['native'];
  holderRisk?:(address:string)=>EntryHolderRiskValues|Promise<EntryHolderRiskValues>}={}) {
  const clock={now:Date.now()+1000},state={active:true,balance:1000000000,balanceReads:0,coverageReads:0,posts:0,quotes:0,riskReads:0},swaps:Record<string,unknown>[]=[];
  const config:Config={...readConfig({}),gmgnApiKey:`test-${randomUUID()}`,gmgnPrivateKey:pem,entryMode:'off',
    scannerChains:['solana'],rpc:{solana:'https://rpc.test'},entryWallets:{solana:wallet},entryInputTokens:{solana:SOL},
    entryBalanceBps:{solana:300},entryFeeReserves:{bsc:'1',solana:'10000000',robinhood:'1'},exitPolicy:policy,...options.config};
  const store=options.store??new OrderStore(':memory:');if(!options.store)t.after(()=>store.close());
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));
    if(url.hostname==='rpc.test'){
      const rpc=JSON.parse(String(init?.body));
      if(rpc.method==='getGenesisHash')return Response.json({jsonrpc:'2.0',id:rpc.id,result:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'});
      if(rpc.method==='getBalance'){state.balanceReads++;options.onBalance?.(state.balanceReads);return Response.json({jsonrpc:'2.0',id:rpc.id,result:{context:{slot:100},value:state.balance}});}
      if(rpc.method==='getSignatureStatuses'){state.coverageReads++;return Response.json({jsonrpc:'2.0',id:rpc.id,result:{value:[{slot:90,err:null,confirmationStatus:'finalized'}]}});}
      throw new Error('UNEXPECTED_RPC');
    }
    assert.equal(url.origin,'https://openapi.gmgn.ai');
    if(url.pathname==='/v1/trade/quote'){
      state.quotes++;const q=Object.fromEntries(url.searchParams);
      const data=options.quote?await options.quote(q):{input_token:SOL,output_token:mint,input_amount:q.input_amount,
        output_amount:'10000000',min_output_amount:'9500000',slippage:5};return Response.json({code:0,data});
    }
    if(url.pathname==='/v1/trade/swap'){
      state.posts++;const body=JSON.parse(String(init?.body));swaps.push(body);
      const row=store.list()[0];assert.equal(row.status,'submitting');assert.equal(store.hasAttemptedOpening('solana',mint),true);
      assert.equal((row.details.submission as {clientId:string}).clientId,url.searchParams.get('client_id'));
      return Response.json({code:0,data:options.swap?await options.swap(body):{order_id:'buy-1',status:'confirmed',state:30,hash:signature,
        strategy_order_id:'protection-1',report:{input_token:SOL,output_token:mint,input_amount:body.input_amount,output_amount:'10000000'}}});
    }
    throw new Error('UNEXPECTED_TRADE_ROUTE');
  };
  const controller=new ThirdSignalEntryController(config,store,{enabled:options.enabled??true,isActive:()=>state.active,
    now:()=>new Date(clock.now),fetcher,scheduleRequest:options.scheduleRequest,
    native:options.native,maxConcurrent:options.maxConcurrent,
    readHolderRisk:options.noHolderRisk?undefined:async address=>{state.riskReads++;return options.holderRisk?options.holderRisk(address):holdingRisk(clock.now,address);}});
  return {controller,store,config,state,clock,swaps,fetcher,candidate:()=>candidate(clock.now)};
}

test('real third source candidate reserves 3% total SOL and attaches +100/50 and -60/100 in the single buy',async t=>{
  const f=fixture(t);const r=await f.controller.consider(f.candidate());
  assert.equal(r.status,'created');assert.equal(r.order?.status,'confirmed');assert.equal(r.order?.inputAmount,'30000000');
  assert.equal(r.order?.outputAmount,'10000000');assert.equal(r.order?.transactionHash,signature);assert.equal(r.order?.exit?.strategyOrderId,'protection-1');
  assert.equal(r.order?.exit?.state,'unverified');assert.equal(f.state.posts,1);assert.equal(f.state.balanceReads,2);
  assert.deepEqual(f.swaps[0].condition_orders,[{order_type:'profit_stop',side:'sell',price_scale:'100',sell_ratio:'50'},
    {order_type:'loss_stop',side:'sell',price_scale:'60',sell_ratio:'100'}]);
  assert.equal(f.swaps[0].sell_ratio_type,'hold_amount');assert.equal(f.config.entryMode,'off');
});

test('disabled, stopped, simulated, wrong chain/source/count/cap and stale candidates never request funds or quote',async t=>{
  for(const patch of [{mode:'simulation',executionEnabled:false,phase:'simulation_candidate'},{source:'wallet'},{chain:'bsc'},
    {count:2},{count:4},{marketCapUsd:100001},{marketCapUsd:0},{marketCapUsd:NaN},{address:SOL},{eventId:''}]){
    const f=fixture(t);const result=await f.controller.consider(candidate(f.clock.now,patch));
    assert.equal(result.status,'blocked');assert.equal(f.state.balanceReads,0);assert.equal(f.state.quotes,0);assert.equal(f.state.posts,0);
  }
  const disabled=fixture(t,{enabled:false});assert.equal((await disabled.controller.consider(disabled.candidate())).reason,'THIRD_ENTRY_DISABLED');
  const stopped=fixture(t);stopped.state.active=false;assert.equal((await stopped.controller.consider(stopped.candidate())).reason,'THIRD_ENTRY_RUN_STOPPED');
  const stale=fixture(t);assert.equal((await stale.controller.consider(candidate(stale.clock.now-120001))).reason,'THIRD_ENTRY_CANDIDATE_EXPIRED');
});

test('pre-reservation admission bounds remote work by local opening slots and the internal job limit',async t=>{
  const slots=fixture(t,{config:{entryMaxOpen:2},maxConcurrent:3});
  const first=slots.controller.consider(candidate(slots.clock.now,{address:bs58.encode(new Uint8Array(32).fill(11))}));
  const second=slots.controller.consider(candidate(slots.clock.now,{address:bs58.encode(new Uint8Array(32).fill(12))}));
  const overflow=await slots.controller.consider(candidate(slots.clock.now,{address:bs58.encode(new Uint8Array(32).fill(13))}));
  assert.equal(overflow.reason,'OPENING_LIMIT_REACHED');
  slots.state.active=false;await Promise.all([first,second]);
  assert.equal(slots.state.balanceReads,2);assert.equal(slots.state.riskReads,0);

  const jobs=fixture(t,{config:{entryMaxOpen:3},maxConcurrent:1});
  const running=jobs.controller.consider(candidate(jobs.clock.now,{address:bs58.encode(new Uint8Array(32).fill(14))}));
  const busy=await jobs.controller.consider(candidate(jobs.clock.now,{address:bs58.encode(new Uint8Array(32).fill(15))}));
  assert.equal(busy.reason,'THIRD_ENTRY_BUSY');jobs.state.active=false;await running;
  assert.equal(jobs.state.balanceReads,1);assert.equal(jobs.state.riskReads,0);
});

test('wrong sizing and missing or legacy exits cannot silently trade the new strategy',async t=>{
  for(const config of [{entryBalanceBps:{solana:1000}},{exitPolicy:undefined},{exitPolicy:{enabled:true,sellRatioType:'hold_amount',
    takeProfit:[{gainPct:500,sellPct:20},{gainPct:1000,sellPct:10}],stopLoss:{dropPct:40,sellPct:100}} as ExitPolicy}]){
    const f=fixture(t,{config});assert.equal((await f.controller.consider(f.candidate())).status,'blocked');assert.equal(f.state.posts,0);
  }
});

test('stop after balance, after quote, and while the signed POST waits in queue prevents a buy',async t=>{
  for(const phase of ['balance','quote','queue'] as const){
    let f:ReturnType<typeof fixture>;let schedules=0;
    f=fixture(t,{onBalance:()=>{if(phase==='balance')f.state.active=false;},quote:q=>{
      if(phase==='quote')f.state.active=false;return {input_token:SOL,output_token:mint,input_amount:q.input_amount,output_amount:'10000000',min_output_amount:'9500000',slippage:5};
    },scheduleRequest:async(_weight,perform)=>{if(++schedules===2&&phase==='queue')f.state.active=false;return perform();}});
    const result=await f.controller.consider(f.candidate());assert.equal(result.reason,'THIRD_ENTRY_RUN_STOPPED');assert.equal(f.state.posts,0);
    assert.equal(f.store.hasAttemptedOpening('solana',mint),false);
  }
});

test('candidate is immutable while an awaited quote resolves',async t=>{
  let f:ReturnType<typeof fixture>,original:ThirdSignalCandidate;
  f=fixture(t,{quote:q=>{original.address=bs58.encode(new Uint8Array(32).fill(9));original.marketCapUsd=9999999;
    return {input_token:SOL,output_token:mint,input_amount:q.input_amount,output_amount:'10000000',min_output_amount:'9500000',slippage:5};}});
  original=f.candidate();const r=await f.controller.consider(original);assert.equal(r.order?.tokenAddress,mint);assert.equal(f.state.posts,1);
});

test('source-separated simultaneous arrivals and restarts cannot duplicate the same chain/CA',async t=>{
  const path=mkdtempSync(join(tmpdir(),'third-entry-test-'));t.after(()=>rmSync(path,{recursive:true,force:true}));
  const first=new OrderStore(join(path,'orders.sqlite')),second=new OrderStore(join(path,'orders.sqlite'));t.after(()=>first.close());t.after(()=>second.close());
  const a=fixture(t,{store:first}),b=fixture(t,{store:second});
  const results=await Promise.all([a.controller.consider(a.candidate()),b.controller.consider(candidate(b.clock.now,{source:'ave'}))]);
  assert.equal(a.state.posts+b.state.posts,1);assert.equal(results.filter(r=>r.order?.status==='confirmed').length,1);
  const later=await b.controller.consider(candidate(b.clock.now,{source:'ave'}));assert.equal(later.status,'blocked');assert.equal(b.state.posts,0);
  assert.equal(first.hasAttemptedOpening('solana',mint),true);
});

test('quote failures and fresh balance reductions do not submit; increased balance never expands frozen quote',async t=>{
  const bad=fixture(t,{quote:()=>({})});assert.equal((await bad.controller.consider(bad.candidate())).reason,'ENTRY_QUOTE_INVALID');assert.equal(bad.state.posts,0);
  let reduced:ReturnType<typeof fixture>;reduced=fixture(t,{onBalance:n=>{if(n===2)reduced.state.balance=500000000;}});
  assert.equal((await reduced.controller.consider(reduced.candidate())).reason,'ENTRY_BALANCE_FRACTION_EXCEEDED');assert.equal(reduced.state.posts,0);
  let increased:ReturnType<typeof fixture>;increased=fixture(t,{onBalance:n=>{if(n===2)increased.state.balance=2000000000;}});
  assert.equal((await increased.controller.consider(increased.candidate())).order?.inputAmount,'30000000');assert.equal(increased.swaps[0].input_amount,'30000000');
  const poor=fixture(t);poor.state.balance=10000000;assert.equal((await poor.controller.consider(poor.candidate())).reason,'ENTRY_INSUFFICIENT_BALANCE');assert.equal(poor.state.quotes,0);
});

test('unavailable quote expiry and stopped final balance read remain unattempted',async t=>{
  let f:ReturnType<typeof fixture>;f=fixture(t,{onBalance:n=>{if(n===2)f.state.active=false;}});
  assert.equal((await f.controller.consider(f.candidate())).reason,'THIRD_ENTRY_RUN_STOPPED');assert.equal(f.state.posts,0);
  let old:ReturnType<typeof fixture>,queued=0;old=fixture(t,{scheduleRequest:async(_weight,perform)=>{if(++queued===2)old.clock.now+=15001;return perform();}});
  assert.equal((await old.controller.consider(old.candidate())).reason,'THIRD_ENTRY_QUOTE_EXPIRED');assert.equal(old.state.posts,0);
});

test('uncertain POST permanently consumes identity and does not retry on either same or different source',async t=>{
  const f=fixture(t,{swap:()=>{throw new Error('UPSTREAM_SECRET');}}),c=f.candidate();
  const result=await f.controller.consider(c);assert.equal(result.status,'created');assert.equal(result.order?.status,'unknown');
  assert.equal(f.state.posts,1);assert.equal(f.store.hasAttemptedOpening('solana',mint),true);
  assert.ok(!JSON.stringify(result).includes('UPSTREAM_SECRET'));
  await f.controller.consider(c);await f.controller.consider(candidate(f.clock.now,{source:'ave'}));assert.equal(f.state.posts,1);
  const reader=new EntryController(f.config,f.store,new GmgnClient({apiKey:'fake',minIntervalMs:0}),{fetcher:()=>{throw new Error('NO_POST_ALLOWED');}});
  assert.equal((await reader.reconcile(result.order!.id)).reason,'ENTRY_ORDER_ID_MISSING_NO_RESUBMIT');
});

test('accepted pending buy is reconciled by existing EntryController using GET only',async t=>{
  const f=fixture(t,{swap:()=>({order_id:'buy-pending',status:'pending'})});const result=await f.controller.consider(f.candidate());assert.equal(result.order?.status,'submitted');
  let queries=0;
  const reader=new EntryController(f.config,f.store,new GmgnClient({apiKey:`reconcile-${randomUUID()}`,minIntervalMs:0}),{fetcher:async(input,init)=>{
    assert.equal(init?.method,'GET');const url=new URL(String(input));assert.equal(url.pathname,'/v1/trade/query_order');queries++;
    return Response.json({code:0,data:{order_id:'buy-pending',status:'confirmed',hash:signature,report:{input_token:SOL,output_token:mint,
      input_amount:'30000000',output_amount:'10000000'}}});
  }});
  const reconciled=await reader.reconcile(result.order!.id);assert.equal(reconciled.order?.status,'confirmed');assert.equal(queries,1);assert.equal(f.state.posts,1);
});

test('controller shutdown and recovery of unsubmitted records never send orders',async t=>{
  const f=fixture(t);await f.controller.stop();assert.equal((await f.controller.consider(f.candidate())).reason,'THIRD_ENTRY_DISABLED');assert.equal(f.state.posts,0);
  const r=f.store.reserve({eventKey:'interrupted',chain:'solana',tokenAddress:mint,mode:'live',wallet,inputToken:SOL,inputAmount:'30000000',
    slippagePct:5,details:{executionStrategy:'third_signal_v1'}},3,new Date(f.clock.now));assert.equal(r.created,true);
  assert.equal(f.controller.recoverPrepared(),1);assert.equal(f.store.get(r.order!.id)?.status,'failed');assert.equal(f.state.posts,0);
});

test('readiness checks exact configuration and key locally without issuing any request',t=>{
  const ready=fixture(t);assert.deepEqual(ready.controller.readiness(),{ready:true});
  assert.equal(ready.state.balanceReads,0);assert.equal(ready.state.quotes,0);assert.equal(ready.state.posts,0);
  const disabled=fixture(t,{enabled:false});assert.deepEqual(disabled.controller.readiness(),{ready:false,reason:'THIRD_ENTRY_DISABLED'});
  const missing=fixture(t,{config:{gmgnPrivateKey:undefined}});assert.equal(missing.controller.readiness().ready,false);
  const invalid=fixture(t,{config:{gmgnPrivateKey:'private-invalid-secret'}});
  assert.deepEqual(invalid.controller.readiness(),{ready:false,reason:'GMGN_TEST_CREDENTIALS_INVALID'});
  assert.equal(invalid.state.balanceReads,0);assert.equal(invalid.state.quotes,0);assert.equal(invalid.state.posts,0);
});

test('submission uncertainty remains permanent across a closed and reopened order database',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'third-entry-restart-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'orders.sqlite'),store=new OrderStore(path),f=fixture(t,{store,swap:()=>{throw new Error('connection lost');}});
  const c=f.candidate(),r=await f.controller.consider(c);assert.equal(r.order?.status,'unknown');await f.controller.stop();store.close();
  const reopened=new OrderStore(path);t.after(()=>reopened.close());const next=fixture(t,{store:reopened});
  assert.equal(next.controller.recoverPrepared(),0);
  const retried=await next.controller.consider(candidate(next.clock.now,{source:'ave'}));
  assert.equal(retried.reason,'ASSET_ALREADY_OPEN');assert.equal(next.state.posts,0);assert.equal(next.state.quotes,0);
});

test('holder hard gate records every actual percentage and checks only at a prepared buy',async t=>{
  for(const [name,value,code] of [['top10','0.250001','TOP10'],['bundler','0.400001','BUNDLER'],['ratTrader','0.300001','RAT_TRADER']] as const){
    let f:ReturnType<typeof fixture>;f=fixture(t,{holderRisk:address=>{const risk=holdingRisk(f.clock.now,address);risk.values[name].value=value;return risk;}});
    assert.equal(f.controller.readiness().ready,true);assert.equal(f.state.riskReads,0);
    const result=await f.controller.consider(f.candidate());assert.equal(result.reason,`ENTRY_HOLDER_RISK_${code}_EXCEEDED`);
    assert.equal(result.status,'blocked');assert.equal(result.order?.status,'failed');
    const evidence=normalizeStoredEntryHolderRisk(result.order?.details.entryHolderRisk);assert.ok(evidence);
    assert.equal(evidence.metrics[name].rateText,value);assert.equal(evidence.status,'blocked');
    assert.equal(f.state.riskReads,1);assert.equal(f.state.quotes,0);assert.equal(f.state.posts,0);assert.equal(f.store.hasAttemptedOpening('solana',mint),false);
  }
  const equality=fixture(t);assert.equal((await equality.controller.consider(equality.candidate())).order?.status,'confirmed');
  assert.equal(equality.state.riskReads,1);await equality.controller.consider(equality.candidate());assert.equal(equality.state.riskReads,1);
});

test('missing, failed, wrong-token and incomplete holding snapshots stop before quote and redact provider errors',async t=>{
  for(const kind of ['missing','throw','wrong','coverage','stale'] as const){
    let f:ReturnType<typeof fixture>;f=fixture(t,{holderRisk:address=>{
      if(kind==='throw')throw new Error('sensitive-upstream-error');const risk=holdingRisk(f.clock.now,address);
      if(kind==='missing')risk.values.ratTrader.value=undefined;
      if(kind==='wrong')risk.address=bs58.encode(new Uint8Array(32).fill(9));
      if(kind==='coverage'){risk.values.bundler.coverage='lower_bound';risk.values.bundler.lowerBound='0.4';}
      if(kind==='stale')risk.checkedAt=new Date(f.clock.now-30001).toISOString();return risk;
    }});
    const result=await f.controller.consider(f.candidate());assert.equal(result.status,'blocked',kind);
    assert.ok(normalizeStoredEntryHolderRisk(result.order?.details.entryHolderRisk));
    assert.ok(!JSON.stringify(result).includes('sensitive-upstream-error'));assert.equal(f.state.quotes,0);assert.equal(f.state.posts,0);
  }
  const absent=fixture(t,{noHolderRisk:true});assert.deepEqual(absent.controller.readiness(),{ready:false,reason:'ENTRY_HOLDER_RISK_PROVIDER_MISSING'});
  assert.equal((await absent.controller.consider(absent.candidate())).reason,'ENTRY_HOLDER_RISK_PROVIDER_MISSING');assert.equal(absent.state.posts,0);
});

test('stopping during the sole holder read prevents buying and keeps the assessment',async t=>{
  let f:ReturnType<typeof fixture>;f=fixture(t,{holderRisk:address=>{f.state.active=false;return holdingRisk(f.clock.now,address);}});
  const result=await f.controller.consider(f.candidate());assert.equal(result.reason,'THIRD_ENTRY_RUN_STOPPED');assert.equal(f.state.posts,0);
  assert.ok(normalizeStoredEntryHolderRisk(result.order?.details.entryHolderRisk));assert.equal(f.state.riskReads,1);
});

test('the holder snapshot ages in the queue or final balance read without a hidden provider refetch',async t=>{
  for(const phase of ['queue','balance'] as const){
    let f:ReturnType<typeof fixture>,queued=0;f=fixture(t,{quote:q=>{f.clock.now+=20000;return {input_token:SOL,output_token:mint,input_amount:q.input_amount,
      output_amount:'10000000',min_output_amount:'9500000',slippage:5};},
      scheduleRequest:async(_weight,perform)=>{if(++queued===2&&phase==='queue')f.clock.now+=10001;return perform();},
      onBalance:n=>{if(n===2&&phase==='balance')f.clock.now+=10001;}});
    const result=await f.controller.consider(f.candidate());assert.equal(result.reason,phase==='queue'?'ENTRY_HOLDER_RISK_STALE':'ENTRY_BALANCE_STALE',phase);
    assert.equal(f.state.posts,0);assert.equal(f.state.riskReads,1);assert.equal(f.store.hasAttemptedOpening('solana',mint),false);
  }
});

test('the fetched holder snapshot is copied and durable evidence cannot be replaced while awaiting quote',async t=>{
  let f:ReturnType<typeof fixture>,source:EntryHolderRiskValues;
  f=fixture(t,{holderRisk:address=>(source=holdingRisk(f.clock.now,address)),quote:q=>{source.values.top10.value=1;return {input_token:SOL,
    output_token:mint,input_amount:q.input_amount,output_amount:'10000000',min_output_amount:'9500000',slippage:5};}});
  const result=await f.controller.consider(f.candidate());assert.equal(result.order?.status,'confirmed');
  assert.equal(normalizeStoredEntryHolderRisk(result.order?.details.entryHolderRisk)?.metrics.top10.percentage,25);
  let changed:ReturnType<typeof fixture>;changed=fixture(t,{quote:q=>{
    const order=changed.store.list()[0];changed.store.update(order.id,['prepared'],{details:{...order.details,entryHolderRisk:undefined}});
    return {input_token:SOL,output_token:mint,input_amount:q.input_amount,output_amount:'10000000',min_output_amount:'9500000',slippage:5};}});
  assert.equal((await changed.controller.consider(changed.candidate())).reason,'ENTRY_HOLDER_RISK_EVIDENCE_INVALID');assert.equal(changed.state.posts,0);
});

test('native entry preserves 3 percent and holder checks without a GMGN quote or swap',async t=>{
  let f:ReturnType<typeof fixture>,calls=0;
  f=fixture(t,{config:{solanaExecutionProvider:'pump_native'},native:{readiness:()=>({ready:true}),execute:async(order,guard)=>{
    calls++;assert.equal(order.inputAmount,'30000000');assert.equal(order.details.executionProvider,'pump_native');
    assert.equal(order.status,'prepared');await guard();assert.equal(f.store.get(order.id)?.status,'submitting');
    return f.store.update(order.id,['submitting'],{status:'submitted',transactionHash:signature},new Date(f.clock.now))!;
  }}});
  const result=await f.controller.consider(f.candidate());assert.equal(result.status,'created');assert.equal(calls,1);
  assert.equal(f.state.riskReads,1);assert.equal(f.state.quotes,0);assert.equal(f.state.posts,0);
  assert.equal(f.store.hasAttemptedOpening('solana',mint),true);
  assert.notEqual((await f.controller.consider(f.candidate())).status,'created');assert.equal(calls,1);
});

test('one entry attempt proves an uncovered active debit once and reuses it at the broadcast balance refresh',async t=>{
  let f:ReturnType<typeof fixture>;
  f=fixture(t,{config:{solanaExecutionProvider:'pump_native',entryMaxOpen:3},native:{readiness:()=>({ready:true}),execute:async(order,guard)=>{
    await guard();return f.store.update(order.id,['submitting'],{status:'submitted',transactionHash:signature},new Date(f.clock.now))!;
  }}});
  const priorMint=bs58.encode(new Uint8Array(32).fill(19)),priorSignature=bs58.encode(new Uint8Array(64).fill(20));
  const prior=f.store.reserve({eventKey:'prior-covered-buy',chain:'solana',tokenAddress:priorMint,mode:'live',wallet,inputToken:SOL,
    inputAmount:'10000000',slippagePct:5,exit:{policy,state:'awaiting_swap',reasons:[],checkedAt:new Date(f.clock.now).toISOString(),positionClosed:false},
    details:{executionProvider:'pump_native',nativeFill:{signature:priorSignature,slot:90},token:{chain:'solana',address:priorMint}}},3,new Date(f.clock.now)).order!;
  f.store.update(prior.id,['prepared'],{status:'confirmed',transactionHash:priorSignature,actualInputAmount:'10000000',outputAmount:'1'},new Date(f.clock.now));
  f.store.updateNativeProtection(prior.id,{provider:'pump_native',healthy:true,checkedAt:new Date(f.clock.now).toISOString(),
    buySignature:priorSignature,buySlot:90,balanceSlot:100,balanceAmount:'1',closed:false},new Date(f.clock.now));
  const result=await f.controller.consider(f.candidate());
  assert.equal(result.status,'created');assert.equal(f.state.balanceReads,2);assert.equal(f.state.coverageReads,1);
  assert.equal((f.store.get(prior.id)?.details.nativeDebitCoverage as {transactionHash:string}).transactionHash,priorSignature);
});
test('native readiness failure cannot silently fall back to GMGN',async t=>{
  const f=fixture(t,{config:{solanaExecutionProvider:'pump_native'},native:{readiness:()=>({ready:false,reason:'NATIVE_SIGNER_UNAVAILABLE'}),
    execute:async()=>{throw Error('MUST_NOT_EXECUTE');}}});
  assert.equal((await f.controller.consider(f.candidate())).reason,'NATIVE_SIGNER_UNAVAILABLE');
  assert.equal(f.state.posts,0);assert.equal(f.state.quotes,0);assert.equal(f.state.balanceReads,0);
});
test('native broadcast guard rechecks stop and stale holder proof after transaction construction',async t=>{
  for(const phase of ['stop','stale'] as const){let f:ReturnType<typeof fixture>;
    f=fixture(t,{config:{solanaExecutionProvider:'pump_native'},native:{readiness:()=>({ready:true}),execute:async(order,guard)=>{
      if(phase==='stop')f.state.active=false;else f.clock.now+=31000;
      await guard();throw Error('MUST_NOT_BROADCAST');
    }}});
    const result=await f.controller.consider(f.candidate());assert.equal(result.status,'blocked');
    assert.equal(result.reason,phase==='stop'?'THIRD_ENTRY_RUN_STOPPED':'ENTRY_HOLDER_RISK_STALE');
    assert.equal(f.store.hasAttemptedOpening('solana',mint),false);assert.equal(f.state.posts,0);
  }
});
