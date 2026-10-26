import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {assessObservedExitStrategy,type ObservedExitExpectation,type ThirdSignalFill} from '../src/exit-tracking.js';
import {OrderStore,type OpeningOrder} from '../src/orders.js';
import {parseExitPolicy,buildExitConditions} from '../src/exit-policy.js';
import {EntryController} from '../src/entry.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import {readConfig,type Config} from '../src/config.js';
const a=(n:number)=>bs58.encode(new Uint8Array(32).fill(n)),wallet=a(1),mint=a(2),account=a(3),other=a(4);
const signature=bs58.encode(new Uint8Array(64).fill(5)),SOL='So11111111111111111111111111111111111111112';
const now=new Date('2026-10-24T12:00:00.000Z'),SPL='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const policy=parseExitPolicy({enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}})!;
const fill:ThirdSignalFill={source:'solana_finalized',transactionHash:signature,wallet,tokenAddress:mint,inputAmount:'10000000',outputAmount:'1000000',
  tokenDecimals:6,buySlot:100,confirmedAt:now.toISOString(),observedAt:now.toISOString()};
const expected:ObservedExitExpectation={chain:'solana',wallet,tokenAddress:mint,inputToken:SOL,openingTransactionHash:signature,
  sellRatioType:'hold_amount',policyConditions:buildExitConditions(policy),fill};
function parent():Record<string,any>{return {order_id:'parent-1',chain:'sol',wallet_address:wallet,base_token:mint,quote_token:SOL,
  open_sign_hash:'',create_time:now.getTime(),quote_investment:'10000000',open_amount:'1000000',base_decimal:6,quote_decimal:9,
  order_type:'smart_trade',sub_order_type:'mix_trade',sell_ratio_type:'hold_amount',status:'open',strategy_status:'running',
  order_statistic:{buy_amount:'1000000',sell_num:0,success_sell_num:0},
  condition_orders:buildExitConditions(policy).map((c,i)=>({...c,cid:`child-${i}`,status:'check'}))};}
const page=(rows:unknown[])=>({list:rows,total:rows.length,next_page_token:''});

test('strict provider observation binds a unique amount/time parent without inventing execution verification',()=>{
  for(const hash of ['',signature]){
    const p=parent();p.open_sign_hash=hash;const r=assessObservedExitStrategy(page([p]),expected,now);
    assert.equal(r.status,'observed');assert.equal(r.observedLiveStop,true);assert.equal(r.hasLiveStop,false);assert.equal(r.automaticTriggerVerified,false);
    assert.equal(r.strategyOrderId,'parent-1');assert.equal(r.linkage,hash?'transaction_hash':'amount_time_match');assert.match(r.parentFingerprint!,/^[0-9a-f]{64}$/);
  }
  const profit=parent();profit.condition_orders[0].status='success';profit.order_statistic.sell_num=1;profit.order_statistic.success_sell_num=1;
  assert.equal(assessObservedExitStrategy(page([profit]),expected,now).observedLiveStop,true);
});

test('conflicting identity/amount/time, ambiguity, incomplete pagination, wrong policy and unsettled children never authorize',()=>{
  const mutations=[(p:any)=>{p.wallet_address=other;},(p:any)=>{p.base_token=other;},(p:any)=>{p.quote_token=other;},
    (p:any)=>{p.open_sign_hash=bs58.encode(new Uint8Array(64).fill(9));},(p:any)=>{p.create_time=now.getTime()-120001;},
    (p:any)=>{p.base_decimal=5;},(p:any)=>{p.quote_investment='9999999';},(p:any)=>{p.open_amount='999999';},
    (p:any)=>{p.condition_orders[0].sell_ratio='60';},(p:any)=>{p.condition_orders[1].status='cancel';},
    (p:any)=>{p.condition_orders[1].status='unknown';},(p:any)=>{p.condition_orders[1].cid='child-0';},
    (p:any)=>{p.order_statistic.sell_num=1;},(p:any)=>{p.status='closed';},(p:any)=>{p.strategy_status='stopped';}];
  for(const change of mutations){const p=parent();change(p);const r=assessObservedExitStrategy(page([p]),expected,now);
    assert.equal(r.observedLiveStop,false);assert.equal(r.hasLiveStop,false);}
  for(const payload of [{...page([parent()]),next_page_token:'more'},{...page([parent()]),total:2},page([parent(),{...parent(),order_id:'other-parent'}])])
    assert.equal(assessObservedExitStrategy(payload,expected,now).observedLiveStop,false);
  const known={...expected,strategyOrderId:'parent-1'},p=parent();p.open_amount='7';
  assert.deepEqual(assessObservedExitStrategy(page([p]),known,now).reasons,['EXIT_OBSERVATION_PARENT_BINDING_CHANGED']);
});

test('cancelled GMGN parent with a failed stop only authorizes a balance check, never a successful sale',()=>{
  const p=parent();p.status='canceled';p.strategy_status='canceled';
  p.condition_orders[0].status='cancel';p.condition_orders[1].status='failed';
  p.order_statistic.sell_num=1;p.order_statistic.success_sell_num=0;
  const r=assessObservedExitStrategy(page([p]),expected,now);
  assert.equal(r.terminal,true);assert.equal(r.observedLiveStop,false);assert.equal(r.reportedSuccessfulSellCount,0);
  assert.deepEqual(r.reasons,['EXIT_STRATEGY_CANCELED_BALANCE_CHECK_REQUIRED']);
  for(const change of [(v:any)=>{v.condition_orders[1].status='running';},(v:any)=>{v.order_statistic.success_sell_num=1;},
    (v:any)=>{v.wallet_address=other;},(v:any)=>{v.strategy_status='running';}]){
    const changed=structuredClone(p);change(changed);assert.equal(assessObservedExitStrategy(page([changed]),expected,now).terminal,false);
  }
});

function storeOrder(store:OrderStore,details:Record<string,unknown>={executionStrategy:'third_signal_v1'},withFill=true):OpeningOrder {
  const r=store.reserve({eventKey:randomUUID(),chain:'solana',tokenAddress:mint,mode:'live',wallet,inputToken:SOL,inputAmount:'10000000',slippagePct:5,
    details:{...details,funding:{feeReserve:'10000000'},...(withFill?{thirdSignalFill:fill}:{})},
    exit:{policy,state:'awaiting_swap',reasons:[],checkedAt:now.toISOString(),positionClosed:false}},10,now).order!;
  return store.update(r.id,['prepared'],{status:'confirmed',providerOrderId:'buy-1',transactionHash:signature,actualInputAmount:'10000000',outputAmount:'1000000'},now)!;
}
function observe(store:OrderStore,order:OpeningOrder,patch:Partial<ReturnType<typeof assessObservedExitStrategy>>={}){
  const assessment={...assessObservedExitStrategy(page([parent()]),expected,now),...patch};
  return store.updateExit(order.id,order.exit,{...order.exit!,strategyOrderId:'parent-1',state:'monitoring',assessment,checkedAt:now.toISOString()},now)!;
}
function nextOrder(store:OrderStore,details:Record<string,unknown>={executionStrategy:'third_signal_v1'}){
  return store.reserve({eventKey:randomUUID(),chain:'solana',tokenAddress:other,mode:'live',wallet,inputToken:SOL,inputAmount:'10000000',slippagePct:5,
    details,exit:{policy,state:'awaiting_swap',reasons:[],checkedAt:now.toISOString(),positionClosed:false}},10,now);
}

test('only the new third-notification path accepts exact observed stop; legacy and stale/malformed evidence stay blocked',()=>{
  for(const mode of ['allow','legacy-new','legacy-existing','stale','not-observed','trigger-claimed','wrong-parent','wrong-conditions'] as const){
    const store=new OrderStore(':memory:');try{
      const order=storeOrder(store,mode==='legacy-existing'?{}:{executionStrategy:'third_signal_v1'});
      const patch:Partial<ReturnType<typeof assessObservedExitStrategy>>={};
      if(mode==='stale')patch.checkedAt=new Date(now.getTime()-90001).toISOString();
      if(mode==='not-observed')patch.observedLiveStop=false;
      if(mode==='trigger-claimed')patch.hasLiveStop=true;
      if(mode==='wrong-parent')patch.strategyOrderId='wrong';
      if(mode==='wrong-conditions')patch.conditions=[];
      observe(store,order,patch);const next=nextOrder(store,mode==='legacy-new'?{}:{executionStrategy:'third_signal_v1'});
      assert.equal(next.created,mode==='allow',mode);
      if(mode==='allow')assert.equal(store.beginSubmission(next.order!.id,now).order?.status,'submitting');
      else assert.equal(next.reason,'EXIT_PROTECTION_UNVERIFIED',mode);
    }finally{store.close();}
  }
});

const pem=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString();
function setup(t:{after:(fn:()=>void)=>void},options:{change?:(p:Record<string,any>,pass:number)=>void;blockTime?:unknown;partial?:boolean;ambiguous?:boolean;badReceipt?:boolean;badTx?:boolean;closed?:boolean;paged?:boolean}={}){
  const store=new OrderStore(':memory:');t.after(()=>store.close());const order=storeOrder(store,undefined,false);
  const config:Config={...readConfig({}),entryMode:'off',gmgnApiKey:`observe-${randomUUID()}`,gmgnPrivateKey:pem,rpc:{solana:'https://rpc.invalid'},exitPolicy:policy};
  const calls:string[]=[],state={opens:0};
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));
    if(url.hostname==='rpc.invalid'){
      const rpc=JSON.parse(String(init?.body));calls.push(rpc.method);
      const balance=(amount:string)=>({accountIndex:1,mint,owner:wallet,programId:SPL,uiTokenAmount:{amount,decimals:6}});
      const values:Record<string,unknown>={getGenesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getSignatureStatuses:{context:{slot:110},value:[{slot:100,err:null,confirmationStatus:options.badTx?'confirmed':'finalized',status:{Ok:null}}]},
        getBlockTime:options.blockTime===undefined?now.getTime()/1000:options.blockTime,
        getTransaction:{slot:100,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:wallet,signer:true,writable:true},{pubkey:account,signer:false,writable:true}]}},
          meta:{err:null,fee:5000,preBalances:[100000000,2039280],postBalances:[89995000,2039280],preTokenBalances:[balance('0')],postTokenBalances:[balance('1000000')]}},
        getTokenAccountsByOwner:{context:{slot:110},value:options.closed?[]:[{pubkey:account,account:{owner:SPL,executable:false,data:{parsed:{type:'account',info:{owner:wallet,mint,
          tokenAmount:{amount:'1000000',decimals:6}}}}}}]}};
      assert.ok(Object.hasOwn(values,rpc.method));return Response.json({jsonrpc:'2.0',id:rpc.id,result:values[rpc.method]});
    }
    assert.equal(init?.method,'GET');assert.equal(url.hostname,'openapi.gmgn.ai');calls.push(url.pathname);
    if(url.pathname==='/v1/trade/query_order')return Response.json({code:0,data:{order_id:'buy-1',strategy_order_id:null,status:'successful',state:30,hash:signature,
      report:{input_token:SOL,output_token:mint,input_amount:'10000000',output_amount:'1000000',input_token_decimals:9,
        output_token_decimals:options.badReceipt?5:6,height:100,swap_mode:'ExactIn',price:'0.01',price_usd:'1'}}});
    assert.equal(url.pathname,'/v1/trade/strategy/orders');
    if(url.searchParams.get('type')==='history')return Response.json({code:0,data:page([])});
    if(options.paged&&!url.searchParams.get('page_token'))return Response.json({code:0,data:{list:[{...parent(),order_id:'old-parent',create_time:now.getTime()-600000}],total:2,next_page_token:'second'}});
    const p=parent();if(options.closed){p.status='closed';p.strategy_status='stopped';p.condition_orders[0].status='cancel';p.condition_orders[1].status='success';p.order_statistic.sell_num=1;p.order_statistic.success_sell_num=1;}state.opens++;options.change?.(p,state.opens);const rows=options.ambiguous?[p,{...p,order_id:'second-parent'}]:[p];
    return Response.json({code:0,data:{...page(rows),...(options.partial?{total:rows.length+1}:options.paged?{total:2}:{})}});
  };
  const controller=new EntryController(config,store,new GmgnClient({apiKey:config.gmgnApiKey,minIntervalMs:0}),{fetcher,now:()=>now});
  return {store,order,controller,calls,state};
}

test('null strategy ID reads exact finalized fill/time then uniquely resolves and re-reads active parent using only reads',async t=>{
  const f=setup(t),result=await f.controller.reconcile(f.order.id),order=result.order!;
  assert.equal(order.exit?.state,'monitoring');assert.equal(order.exit?.strategyOrderId,'parent-1');assert.equal(order.exit?.assessment?.status,'observed');
  assert.equal(order.exit?.assessment?.hasLiveStop,false);assert.equal(order.exit?.assessment?.observedLiveStop,true);
  assert.equal(f.state.opens,2);assert.ok(f.calls.includes('getTransaction'));assert.ok(f.calls.includes('getBlockTime'));
  const evidence=order.details.thirdSignalFill as ThirdSignalFill;assert.equal(evidence.tokenDecimals,6);assert.equal(evidence.confirmedAt,now.toISOString());assert.equal(evidence.priceUsd,1);
  assert.equal(nextOrder(f.store).created,true);
  const before=f.calls.filter(c=>c==='getTransaction').length;await f.controller.reconcile(f.order.id);
  assert.equal(f.calls.filter(c=>c==='getTransaction').length,before,'finalized immutable fill is cached');
});

test('readback rejects ambiguity, incomplete pages, parent changes, bad finalized data and missing real block time',async t=>{
  for(const options of [{ambiguous:true},{partial:true},{blockTime:null},{badReceipt:true},{badTx:true},
    {change:(p:Record<string,any>,pass:number)=>{if(pass===2)p.order_id='replaced';}},
    {change:(p:Record<string,any>,pass:number)=>{if(pass===2)p.condition_orders[0].sell_ratio='55';}}]){
    const f=setup(t,options),r=await f.controller.reconcile(f.order.id);assert.notEqual(r.order?.exit?.state,'monitoring');
    assert.equal(nextOrder(f.store).reason,'EXIT_PROTECTION_UNVERIFIED');
    assert.equal(r.order?.status,'confirmed');assert.equal(f.calls.some(c=>c.includes('/swap')||c.includes('/cancel')),false);
  }
});

test('the observed BONK provider shape with numeric zero statistics and string atomic amounts is supported',()=>{
  const realFill:ThirdSignalFill={source:'solana_finalized',transactionHash:'38QX9uviXmvbupeRfdtLBGziNFhjXEX6AZVqJxGEPwzVYUa5tcE819UDew9Ev7QN3dGWb6SNu4PSf9nZbSkfXUh3',
    wallet:'whihCFMAG28yFv9ZijWroHz4opEkBfsXHPrTFdTzBhK',tokenAddress:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    inputAmount:'10000000',outputAmount:'33696514738',tokenDecimals:5,buySlot:461200851,confirmedAt:'2026-10-25T09:08:46.197Z',observedAt:'2026-10-25T09:13:25.646Z'};
  const row={...parent(),order_id:'73920fa5-d438-448b-b236-962da2ed26b4',wallet_address:realFill.wallet,base_token:realFill.tokenAddress,
    base_decimal:5,create_time:1792919325387,open_amount:realFill.outputAmount,order_statistic:{buy_amount:realFill.outputAmount,sell_num:0,success_sell_num:0}};
  const r=assessObservedExitStrategy(page([row]),{...expected,wallet:realFill.wallet,tokenAddress:realFill.tokenAddress,
    openingTransactionHash:realFill.transactionHash,fill:realFill},new Date(realFill.observedAt));
  assert.equal(r.status,'observed');assert.equal(r.observedLiveStop,true);assert.equal(r.hasLiveStop,false);
});

test('complete pagination finds the unique later parent and terminal plus finalized zero closes without releasing CA',async t=>{
  const paged=setup(t,{paged:true});assert.equal((await paged.controller.reconcile(paged.order.id)).order?.exit?.state,'monitoring');
  const closed=setup(t,{closed:true}),r=await closed.controller.reconcile(closed.order.id);
  assert.equal(r.order?.exit?.state,'closed');assert.equal(r.order?.exit?.positionClosed,true);assert.equal(r.order?.exit?.assessment?.terminal,true);
  assert.equal(closed.store.hasAttemptedOpening('solana',mint),true);assert.equal(r.order?.status,'confirmed');
});

test('cancelled protection closes only after verified zero holdings and retains nonzero positions for attention',async t=>{
  for(const closed of [false,true]){
    const f=setup(t,{closed,change:p=>{
      p.status='canceled';p.strategy_status='canceled';p.condition_orders[0].status='cancel';p.condition_orders[1].status='failed';
      p.order_statistic.sell_num=1;p.order_statistic.success_sell_num=0;
    }}),r=await f.controller.reconcile(f.order.id);
    assert.equal(r.order?.exit?.positionClosed,closed);assert.equal(r.order?.exit?.state,closed?'closed':'attention');
    assert.equal(r.order?.exit?.assessment?.reportedSuccessfulSellCount,0);
    assert.equal(f.store.hasAttemptedOpening('solana',mint),true);
    assert.equal(f.calls.some(c=>c.includes('/swap')||c.includes('/cancel')),false);
  }
});

test('a later parent fingerprint change withdraws observation without overwriting the original parent identity',async t=>{
  let changed=false;const f=setup(t,{change:p=>{if(changed)p.condition_orders[0].cid='new-child';}});
  assert.equal((await f.controller.reconcile(f.order.id)).order?.exit?.state,'monitoring');changed=true;
  const r=await f.controller.reconcile(f.order.id);assert.equal(r.order?.exit?.state,'unverified');
  assert.deepEqual(r.order?.exit?.reasons,['EXIT_OBSERVATION_PARENT_FIELDS_CHANGED']);assert.equal(nextOrder(f.store).reason,'EXIT_PROTECTION_UNVERIFIED');
  assert.deepEqual((await f.controller.reconcile(f.order.id)).order?.exit?.reasons,['EXIT_OBSERVATION_PARENT_FIELDS_CHANGED']);
});
