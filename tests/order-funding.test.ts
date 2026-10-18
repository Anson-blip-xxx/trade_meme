import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bs58 from 'bs58';
import {OrderStore,type FundingSnapshot,type OpeningStatus,type ExitTracking} from '../src/orders.js';

const now=new Date('2026-10-09T02:00:00Z');
const hash='0x'+'c'.repeat(64);
// Pure budget tests use paper reservations; live admission additionally requires proven exits.
const input=(id=1)=>({eventKey:`funding-${id}`,chain:'bsc' as const,tokenAddress:`0x${String(id).padStart(40,'0')}`,
  mode:'paper' as const,wallet:'0x'+'a'.repeat(40),inputToken:'0x'+'0'.repeat(40),inputAmount:'100',slippagePct:5,details:{}});
const snapshot=(patch:Partial<FundingSnapshot>={}):FundingSnapshot=>({balance:'100',feeReserve:'10',
  readStartedAt:new Date(now.getTime()-1_000).toISOString(),checkedAt:now.toISOString(),coveredOrderIds:[],...patch});

test('余额上限按BigInt精确缩小并仅持久化受限资金摘要，报价前本金固定',()=>{
  const store=new OrderStore(':memory:');
  try {
    const balance='100000000000000000001',feeReserve='10000000000000000000';
    const cap='999999999999999999999';
    const funding={...snapshot({balance,feeReserve}),vendorRaw:'must not persist'};
    const result=store.reserve({...input(),inputAmount:cap},5,now,funding);
    assert.equal(result.created,true);assert.equal(result.order?.inputAmount,'90000000000000000001');
    assert.deepEqual(result.order?.details.funding,{cap,balance,feeReserve,reservedBefore:'0',
      inputAmount:'90000000000000000001',checkedAt:funding.checkedAt,readStartedAt:funding.readStartedAt});
    assert.equal(JSON.stringify(store.list()).includes('must not persist'),false);
    const retry=store.reserve({...input(),inputAmount:'1'},5,now,snapshot({balance:'0'}));
    assert.equal(retry.created,false);assert.equal(retry.order?.id,result.order?.id);
    assert.equal(retry.order?.inputAmount,'90000000000000000001');
  } finally {store.close();}
});

test('连续多连接预留在事务内扣除其他订单本金与其持久化手续费缓冲',()=>{
  const dir=mkdtempSync(join(tmpdir(),'meme-funding-')),path=join(dir,'orders.sqlite');
  const a=new OrderStore(path),b=new OrderStore(path);
  try {
    assert.equal(a.reserve({...input(),inputAmount:'60'},10,now,snapshot()).order?.inputAmount,'60');
    const second=b.reserve(input(2),10,now,snapshot({feeReserve:'5'}));
    assert.equal(second.order?.inputAmount,'25');
    assert.equal((second.order?.details.funding as {reservedBefore:string}).reservedBefore,'70');
    assert.equal(a.reserve(input(3),10,now,snapshot()).reason,'ENTRY_INSUFFICIENT_BALANCE');
    assert.equal(a.list().length,2);
  } finally {a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('所有未确定开单状态都保留资金，covered IDs不能释放未知交易或纸仓',()=>{
  const statuses:OpeningStatus[]=['prepared','submitting','submitted','unknown','confirmed','paper_open'];
  for(const status of statuses) {
    const store=new OrderStore(':memory:');
    try {
      const mode=status==='paper_open'?'paper' as const:'live' as const;
      const old=store.reserve({...input(),mode,inputAmount:'60'},10,now,snapshot()).order!;
      // Seed a legacy concurrent ledger while the earlier row is temporarily failed.
      // Once both rows exist, the original unresolved state must still reserve funds.
      store.update(old.id,['prepared'],{status:'failed'},now);
      const own=store.reserve({...input(3),mode,inputAmount:'20'},10,now,snapshot()).order!;
      store.update(old.id,['failed'],{status,...(status==='confirmed'?{}:{transactionHash:hash})},now);
      assert.deepEqual(store.checkFunding(own.id,snapshot({coveredOrderIds:[old.id]}),now),{ok:true},status);
      assert.deepEqual(store.checkFunding(own.id,snapshot({balance:'99',coveredOrderIds:[old.id]}),now),
        {ok:false,reason:'ENTRY_INSUFFICIENT_BALANCE'},status);
      store.update(own.id,['prepared'],{status:'failed'},now);
      const result=store.reserve({...input(2),mode},10,now,snapshot({coveredOrderIds:[old.id]}));
      if(mode==='live') assert.equal(result.reason,'EXIT_PROTECTION_UNVERIFIED',status);
      else assert.equal(result.order?.inputAmount,'20',status);
    } finally {store.close();}
  }
});

test('仅有确证交易哈希的confirmed订单可以被覆盖，failed不占用',()=>{
  for(const state of ['covered','uncovered','bad-hash','failed'] as const) {
    const store=new OrderStore(':memory:');
    try {
      const old=store.reserve({...input(),inputAmount:'60'},10,now,snapshot()).order!;
      store.update(old.id,['prepared'],{status:state==='failed'?'failed':'confirmed',
        transactionHash:state==='bad-hash'?'not-a-hash':hash},now);
      const result=store.reserve(input(2),10,now,snapshot({coveredOrderIds:state==='uncovered'?[]:[old.id]}));
      assert.equal(result.order?.inputAmount,state==='covered'||state==='failed'?'90':'20',state);
    } finally {store.close();}
  }
});

test('已关闭持仓的买入仍需snapshot覆盖证明，防止使用买入前旧余额重复花费',()=>{
  const store=new OrderStore(':memory:');
  const exit:ExitTracking={policy:{enabled:true,sellRatioType:'hold_amount',
    takeProfit:[{gainPct:500,sellPct:20},{gainPct:1000,sellPct:10}],stopLoss:{dropPct:40,sellPct:100}},
    state:'unverified',reasons:[],checkedAt:now.toISOString(),positionClosed:false};
  try {
    const old=store.reserve({...input(),inputAmount:'60',exit},10,now,snapshot()).order!;
    store.update(old.id,['prepared'],{status:'confirmed',transactionHash:hash},now);
    store.updateExit(old.id,exit,{...exit,state:'closed',positionClosed:true,
      assessment:{status:'terminal',reasons:[],found:true,policyMatched:true,hasLiveStop:false,terminal:true,
        conditions:[],checkedAt:now.toISOString()},balance:{status:'verified',amount:'0',checkedAt:now.toISOString(),reasons:[]}},now);
    assert.equal(store.get(old.id)?.exit?.positionClosed,true);
    const next=store.reserve(input(2),10,now,snapshot()).order!;
    assert.equal(next.inputAmount,'20');
    store.update(next.id,['prepared'],{status:'failed'},now);
    assert.equal(store.reserve(input(3),10,now,snapshot({coveredOrderIds:[old.id]})).order?.inputAmount,'90');
  } finally {store.close();}
});

test('按mode/chain/wallet/inputToken隔离预留，EVM地址忽略大小写',()=>{
  for(const patch of [{mode:'live' as const},{chain:'robinhood' as const},
    {wallet:'0x'+'b'.repeat(40)},{inputToken:'0x'+'d'.repeat(40)}]) {
    const store=new OrderStore(':memory:');
    try {
      store.reserve({...input(),...patch,inputAmount:'60'},10,now,snapshot());
      assert.equal(store.reserve(input(2),10,now,snapshot()).order?.inputAmount,'90');
    } finally {store.close();}
  }
  const store=new OrderStore(':memory:');
  try {
    store.reserve({...input(),wallet:'0x'+'A'.repeat(40),inputAmount:'60'},10,now,snapshot());
    assert.equal(store.reserve(input(2),10,now,snapshot()).order?.inputAmount,'20');
  } finally {store.close();}
});

test('Solana地址区分大小写且已覆盖确认单必须具备64字节交易签名',()=>{
  const store=new OrderStore(':memory:');
  const wallet=bs58.encode(new Uint8Array(32).fill(1)),otherWallet=wallet.replace('v','V');
  const token=bs58.encode(new Uint8Array(32).fill(2)),token2=bs58.encode(new Uint8Array(32).fill(3));
  try {
    const old=store.reserve({...input(),chain:'solana',wallet,inputToken:token,tokenAddress:token2,inputAmount:'60'},10,now,snapshot()).order!;
    const distinct=store.reserve({...input(2),chain:'solana',wallet:otherWallet,inputToken:token,tokenAddress:token},10,now,snapshot());
    assert.equal(distinct.order?.inputAmount,'90');
    store.update(old.id,['prepared'],{status:'confirmed',transactionHash:bs58.encode(new Uint8Array(64).fill(4))},now);
    const next=store.reserve({...input(3),chain:'solana',wallet,inputToken:token,tokenAddress:wallet},10,now,snapshot({coveredOrderIds:[old.id]}));
    assert.equal(next.order?.inputAmount,'90');
  } finally {store.close();}
});

test('旧记录没有feeReserve时保守使用本次缓冲，错误已存缓冲阻止新预留',()=>{
  for(const details of [{},{funding:{feeReserve:'wrong'}}]) {
    const store=new OrderStore(':memory:');
    try {
      store.reserve({...input(),inputAmount:'60',details},10,now);
      const result=store.reserve(input(2),10,now,snapshot());
      if('funding' in details) assert.equal(result.reason,'ENTRY_BALANCE_INVALID');
      else assert.equal(result.order?.inputAmount,'20');
    } finally {store.close();}
  }
});

test('非法、过期、远期及跨越长读区间的snapshot不落库；零余额不能开单',()=>{
  const invalid:unknown[]=[null,{},snapshot({balance:'-1'}),snapshot({balance:'1.1'}),snapshot({balance:'1e3'}),
    snapshot({feeReserve:'-1'}),snapshot({balance:((1n<<256n)).toString()}),snapshot({coveredOrderIds:['\n']}),
    snapshot({checkedAt:'bad'}),snapshot({readStartedAt:new Date(now.getTime()+1_000).toISOString()})];
  const stale=[snapshot({readStartedAt:new Date(now.getTime()-30_001).toISOString()}),
    snapshot({readStartedAt:new Date(now.getTime()-40_000).toISOString(),checkedAt:new Date(now.getTime()-35_000).toISOString()}),
    snapshot({readStartedAt:new Date(now.getTime()+6_000).toISOString(),checkedAt:new Date(now.getTime()+6_000).toISOString()})];
  for(const [funding,reason] of [...invalid.map(value=>[value,'ENTRY_BALANCE_INVALID'] as const),
    ...stale.map(value=>[value,'ENTRY_BALANCE_STALE'] as const),
    [snapshot({balance:'0'}),'ENTRY_INSUFFICIENT_BALANCE'] as const,
    [snapshot({balance:'10'}),'ENTRY_INSUFFICIENT_BALANCE'] as const]) {
    const store=new OrderStore(':memory:');
    try {
      assert.equal(store.reserve(input(),10,now,funding as FundingSnapshot).reason,reason);
      assert.equal(store.list().length,0);
    } finally {store.close();}
  }
});

test('提交前checkFunding排除自身但扣其它预留，不重新缩小已报价本金',()=>{
  const store=new OrderStore(':memory:');
  try {
    const own=store.reserve({...input(),inputAmount:'60'},10,now,snapshot()).order!;
    assert.deepEqual(store.checkFunding(own.id,snapshot({balance:'70'}),now),{ok:true});
    assert.deepEqual(store.checkFunding(own.id,snapshot({balance:'69'}),now),{ok:false,reason:'ENTRY_INSUFFICIENT_BALANCE'});
    const other=store.reserve(input(2),10,now,snapshot()).order!;
    assert.equal(other.inputAmount,'20');
    assert.deepEqual(store.checkFunding(own.id,snapshot(),now),{ok:true});
    assert.deepEqual(store.checkFunding(own.id,snapshot({balance:'99'}),now),{ok:false,reason:'ENTRY_INSUFFICIENT_BALANCE'});
    assert.deepEqual(store.checkFunding(own.id,undefined,now),{ok:false,reason:'ENTRY_BALANCE_INVALID'});
    assert.deepEqual(store.checkFunding('not-found',snapshot(),now),{ok:false,reason:'ENTRY_BALANCE_INVALID'});
    assert.equal(store.get(own.id)?.inputAmount,'60');
    store.update(own.id,['prepared'],{status:'submitted'},now);
    assert.deepEqual(store.checkFunding(own.id,snapshot(),now),{ok:false,reason:'ENTRY_BALANCE_INVALID'});
  } finally {store.close();}
});

test('checkFunding只能原子提高已存手续费缓冲，余额不足不改记录，也不会降低旧缓冲',()=>{
  const store=new OrderStore(':memory:');
  try {
    const own=store.reserve({...input(),inputAmount:'60'},10,now,snapshot()).order!;
    assert.deepEqual(store.checkFunding(own.id,snapshot({balance:'79',feeReserve:'20'}),now),
      {ok:false,reason:'ENTRY_INSUFFICIENT_BALANCE'});
    assert.equal((store.get(own.id)?.details.funding as {feeReserve:string}).feeReserve,'10');
    assert.deepEqual(store.checkFunding(own.id,snapshot({feeReserve:'20'}),now),{ok:true});
    assert.equal((store.get(own.id)?.details.funding as {feeReserve:string}).feeReserve,'20');
    assert.deepEqual(store.checkFunding(own.id,snapshot({feeReserve:'5'}),now),{ok:true});
    assert.equal((store.get(own.id)?.details.funding as {feeReserve:string}).feeReserve,'20');
    assert.equal(store.reserve(input(2),10,now,snapshot({feeReserve:'5'})).order?.inputAmount,'15');
    assert.equal(store.get(own.id)?.inputAmount,'60');
  } finally {store.close();}
});

test('资金覆盖查询不受列表50条分页限制，只返回同资金范围内全部confirmed',()=>{
  const store=new OrderStore(':memory:');
  try {
    const ids:string[]=[];
    for(let id=1;id<=65;id++) {
      const order=store.reserve({...input(id),...(id===1?{wallet:'0x'+'A'.repeat(40)}:{})},100,now).order!;
      store.update(order.id,['prepared'],{status:'confirmed',transactionHash:hash},now);ids.push(order.id);
    }
    store.reserve(input(66),100,now);
    const foreign=store.reserve({...input(67),wallet:'0x'+'f'.repeat(40)},100,now).order!;
    store.update(foreign.id,['prepared'],{status:'confirmed',transactionHash:hash},now);
    assert.equal(store.list().length,50);
    const all=store.fundingOrders(input());
    assert.equal(all.length,65);assert.deepEqual(all.map(order=>order.id),ids);
    assert.equal(store.fundingOrders({...input(),mode:'live'}).length,0);
    assert.equal(store.fundingOrders({...input(),chain:'robinhood'}).length,0);
    assert.equal(store.fundingOrders({...input(),inputToken:'0x'+'e'.repeat(40)}).length,0);
  } finally {store.close();}
});

test('fraction reserves floor lamports exactly across uint64 range and ignore retired fixed cap',()=>{
  for(const balance of ['20020000009',((1n<<64n)-1n).toString()]) {
    const store=new OrderStore(':memory:');
    try {
      const feeReserve='20000000',available=BigInt(balance)-BigInt(feeReserve);
      const result=store.reserve({...input(),chain:'solana',inputAmount:'1000000000'},10,now,
        snapshot({balance,feeReserve}),{balanceBps:1000});
      assert.equal(result.order?.inputAmount,(available/10n).toString());
      assert.ok(BigInt(result.order!.inputAmount)>1_000_000_000n);
      assert.equal((result.order!.details.funding as Record<string,unknown>).balanceBps,1000);
      assert.equal((result.order!.details.funding as Record<string,unknown>).cap,undefined);
      assert.equal(BigInt(result.order!.inputAmount)*10n<=available,true);
    } finally {store.close();}
  }
});

test('fraction two-connection reservations use remaining amount, and failed reservations release capacity',()=>{
  const dir=mkdtempSync(join(tmpdir(),'meme-fraction-')),path=join(dir,'orders.sqlite');
  const a=new OrderStore(path),b=new OrderStore(path),funding=snapshot({balance:'1010'});
  try {
    const first=a.reserve({...input(),inputAmount:'0'},10,now,funding,{balanceBps:1000}).order!;
    assert.equal(first.inputAmount,'100');
    a.update(first.id,['prepared'],{status:'paper_open'},now);
    const second=b.reserve({...input(2),inputAmount:'0'},10,now,funding,{balanceBps:1000}).order!;
    assert.equal(second.inputAmount,'89');
    assert.equal((second.details.funding as Record<string,unknown>).reservedBefore,'110');
    assert.deepEqual(a.checkFunding(second.id,funding,now),{ok:true});
    b.update(second.id,['prepared'],{status:'failed'},now);
    assert.equal(a.reserve(input(3),10,now,funding,{balanceBps:1000}).order?.inputAmount,'89');
  } finally {a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('fraction preflight rejects still-affordable quote after balance, fee or other reservation reduces the limit',()=>{
  for(const change of ['balance','fee','reservation'] as const) {
    const store=new OrderStore(':memory:');
    try {
      const funding=snapshot({balance:'1010'});
      const own=store.reserve(input(),10,now,funding,{balanceBps:1000}).order!;
      assert.equal(own.inputAmount,'100');
      if(change==='reservation')store.reserve({...input(2),inputAmount:'1'},10,now,funding);
      const latest=change==='balance'?snapshot({balance:'1009'}):change==='fee'?snapshot({balance:'1010',feeReserve:'11'}):funding;
      assert.deepEqual(store.checkFunding(own.id,latest,now),{ok:false,reason:'ENTRY_BALANCE_FRACTION_EXCEEDED'},change);
      assert.equal(store.get(own.id)?.inputAmount,'100');
    } finally {store.close();}
  }
});

test('fraction preflight excludes itself, never raises quoted principal, and fails closed for invalid policy',()=>{
  const store=new OrderStore(':memory:');
  try {
    const own=store.reserve(input(),10,now,snapshot({balance:'1010'}),{balanceBps:1000}).order!;
    assert.deepEqual(store.checkFunding(own.id,snapshot({balance:'1010'}),now),{ok:true});
    assert.deepEqual(store.checkFunding(own.id,snapshot({balance:'2010'}),now),{ok:true});
    assert.equal(store.get(own.id)?.inputAmount,'100');
    for(const patch of [{balanceBps:undefined},{balanceBps:0},{balanceBps:10001},{balanceBps:NaN},{balanceBps:'1000'},{sizing:'unknown'}]) {
      const original=own.details.funding as Record<string,unknown>;
      store.update(own.id,['prepared'],{details:{...own.details,funding:{...original,...patch}}},now);
      assert.deepEqual(store.checkFunding(own.id,snapshot({balance:'2010'}),now),{ok:false,reason:'ENTRY_BALANCE_INVALID'});
    }
  } finally {store.close();}
});

test('fraction below one lamport, absent funding and invalid bps cannot create a reservation',()=>{
  for(const balanceBps of [0,-1,1.5,10001,NaN]) {
    const store=new OrderStore(':memory:');
    try {assert.equal(store.reserve(input(),10,now,snapshot(),{balanceBps}).reason,'ENTRY_BALANCE_INVALID');
      assert.equal(store.list().length,0);}finally {store.close();}
  }
  const store=new OrderStore(':memory:');
  try {
    assert.equal(store.reserve(input(),10,now,undefined,{balanceBps:1000}).reason,'ENTRY_BALANCE_INVALID');
    assert.equal(store.reserve(input(),10,now,snapshot({balance:'19'}),{balanceBps:1000}).reason,'ENTRY_INSUFFICIENT_BALANCE');
    assert.equal(store.list().length,0);
    assert.equal(store.reserve(input(),10,now,snapshot({balance:'20'}),{balanceBps:1000}).order?.inputAmount,'1');
  } finally {store.close();}
});
