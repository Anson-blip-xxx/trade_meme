import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TradeNotifications,type TradeNotificationEvent} from '../src/trade-notifications.js';
import {OrderStore,type OpeningOrder,type ExitTracking} from '../src/orders.js';
import {parseExitPolicy} from '../src/exit-policy.js';
import type {ScanPrice} from '../src/scan-archive.js';
import {assessEntryHolderRiskValues,unavailableEntryHolderRisk} from '../src/entry-holder-risk.js';

const BASE=Date.parse('2026-10-25T08:00:00.000Z');
const iso=(value=BASE)=>new Date(value).toISOString();
const ADDRESS='0x'+'1'.repeat(40);
const fixture=(patch:Partial<OpeningOrder>={}):OpeningOrder=>({
  id:'order-one',eventKey:'event-one',chain:'bsc',tokenAddress:ADDRESS,mode:'live',status:'prepared',
  createdAt:iso(),updatedAt:iso(),wallet:'0x'+'2'.repeat(40),inputToken:'0x'+'0'.repeat(40),
  inputAmount:'150000000000000001',slippagePct:1,details:{secret:'NEVER_SAVE_VENDOR_DETAILS'},...patch,
});
const policy=parseExitPolicy({enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:500,sellPct:20},
  {gainPct:1000,sellPct:10}],stopLoss:{dropPct:40,sellPct:100}})!;
const exit=(patch:Partial<ExitTracking>={}):ExitTracking=>({policy,state:'unverified',reasons:[],checkedAt:iso(),positionClosed:false,...patch});
const assessment=(patch:Record<string,unknown>={})=>({status:'degraded' as const,reasons:[],found:true,policyMatched:true,
  hasLiveStop:false,terminal:false,conditions:[],checkedAt:iso(),...patch});
const sample=(priceUsd=1,observedAt=iso(),patch:Partial<ScanPrice>={}):ScanPrice=>({
  chain:'bsc',address:ADDRESS,priceUsd,observedAt,source:'ave_price_stream_sample',...patch,
});
function setup(options:{path?:string;includePaper?:boolean;summaryIntervalMs?:number;isClosed?:(orderId:string)=>boolean}={}) {
  let now=BASE;const events:TradeNotificationEvent[]=[];
  const notifications=new TradeNotifications(options.path??':memory:',{...options,now:()=>now,
    display:()=>({name:'测试币',symbol:'TEST'}),enqueue:event=>{events.push(event);return true;}});
  return {notifications,events,setNow:(value:number)=>{now=value;}};
}

test('提交不等于成交，通知包含名称链 CA 单号哈希和精确原生币金额，默认完全隔离模拟单',()=>{
  const {notifications:n,events}=setup();
  try {
    n.observeOrder(fixture());n.observeOrder(fixture({status:'submitting'}));
    n.observeOrder(fixture({id:'paper-one',mode:'paper',status:'paper_open'}));assert.equal(events.length,0);
    n.observeOrder(fixture({status:'submitted',providerOrderId:'gmgn-1',transactionHash:'0x'+'a'.repeat(64)}));
    assert.equal(events.length,1);assert.match(events[0].text,/等待成交确认/);assert.doesNotMatch(events[0].text,/买单已确认/);
    for(const text of ['测试币','TEST','BSC',ADDRESS,'order-one','gmgn-1','0.150000000000000001 BNB'])assert.ok(events[0].text.includes(text));
    n.observeOrder(fixture({status:'submitted',providerOrderId:'gmgn-1'}));assert.equal(events.length,1);
    n.observeOrder(fixture({status:'confirmed',actualInputAmount:'140000000000000001',outputAmount:'123'}));
    assert.ok(events.some(event=>event.text.includes('买单已确认')));
    assert.ok(events.some(event=>event.text.includes('GMGN 记录成交输入：0.140000000000000001 BNB')));
    assert.equal(events.some(event=>event.text.includes('退出保护告警')),false);
    assert.equal(n.status().activePositions,1);
    assert.ok(events.every(event=>!event.text.includes('NEVER_SAVE_VENDOR_DETAILS')));
  } finally {n.close();}
});

test('原生订单通知展示可核验执行耗时且不泄露计时对象外字段',()=>{
  const {notifications:n,events}=setup(),mint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const timing={version:1 as const,startedAt:iso(),stagesMs:{plan:12,simulation:34,finalGuard:5,broadcastRpc:21,
    secretKey:'NEVER_SHOW'} as any,broadcastStartedAt:iso(BASE+70),acknowledgedAt:iso(BASE+100),submittedAfterMs:100};
  try{
    n.observeOrder(fixture({id:'native-timing',chain:'solana',tokenAddress:mint,inputToken:'So11111111111111111111111111111111111111112',
      inputAmount:'10000000',status:'submitted',transactionHash:'5'.repeat(64),details:{executionProvider:'pump_native',nativeExecutionTiming:timing}}));
    const submitted=events.find(event=>event.key==='trade:native-timing:submitted')!;
    assert.match(submitted.text,/Jito 回执：100 ms/);
    assert.doesNotMatch(submitted.text,/构建 12 ms · 模拟 34 ms · 最终校验 5 ms · Jito 请求 21 ms/);
    assert.doesNotMatch(submitted.text,/NEVER_SHOW|secretKey/);
    n.observeOrder(fixture({id:'native-timing',chain:'solana',tokenAddress:mint,inputToken:'So11111111111111111111111111111111111111112',
      inputAmount:'10000000',actualInputAmount:'9999000',outputAmount:'123',status:'confirmed',transactionHash:'5'.repeat(64),
      updatedAt:iso(BASE+400),details:{executionProvider:'pump_native',nativeExecutionTiming:{...timing,
        confirmedObservedAt:iso(BASE+300),confirmedAfterMs:300,finalizedObservedAt:iso(BASE+400),finalizedAfterMs:400}}}));
    const confirmed=events.find(event=>event.key==='trade:native-timing:confirmed')!;
    assert.match(confirmed.text,/实际耗时：400 ms（执行开始→链上 finalized 核验）/);
    assert.match(confirmed.text,/链上核验成交输入：0\.009999 SOL/);
  }finally{n.close();}
});

test('卡片原生买入只产生一条最终执行通知，并展示点击到 confirmed 和 finalized 的实际耗时',()=>{
  const {notifications:n,events}=setup(),mint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const manualTest={entryMode:'card_direct',requestedAt:iso(),acceptedAt:iso(),actionRef:'a'.repeat(32)};
  const timing={version:1 as const,startedAt:iso(BASE+25),stagesMs:{plan:12,simulation:34,finalGuard:5,broadcastRpc:21},
    broadcastStartedAt:iso(BASE+90),acknowledgedAt:iso(BASE+125),submittedAfterMs:100};
  const common={id:'card-direct',chain:'solana' as const,tokenAddress:mint,
    inputToken:'So11111111111111111111111111111111111111112',inputAmount:'10000000',transactionHash:'5'.repeat(64),
    details:{executionStrategy:'manual_native_test_v1',executionProvider:'pump_native',manualTest,nativeExecutionTiming:timing}};
  try{
    n.observeOrder(fixture({...common,status:'prepared'}));
    n.observeOrder(fixture({...common,status:'submitting',updatedAt:iso(BASE+90)}));
    n.observeOrder(fixture({...common,status:'submitted',updatedAt:iso(BASE+125)}));
    assert.equal(events.length,0,'卡片点击的已接收回复是第一条消息，Jito submitted 不应再刷一条');
    n.observeOrder(fixture({...common,status:'confirmed',updatedAt:iso(BASE+1425),actualInputAmount:'9999000',outputAmount:'123',
      details:{...common.details,nativeFill:{commitment:'finalized',confirmedAt:iso(BASE+1425)},
        nativeExecutionTiming:{...timing,confirmedObservedAt:iso(BASE+425),confirmedAfterMs:400,
          finalizedObservedAt:iso(BASE+1425),finalizedAfterMs:1400}}}));
    assert.equal(events.length,1,'加上卡片点击时的已接收回复，整个买入过程只有两条用户可见消息');
    const message=events[0]!.text;
    for(const expected of ['买入成交','链上成交已确认','测试币','Solana',mint,'https://solscan.io/tx/'+'5'.repeat(64),
      '金额：0.009999 SOL（链上核验）','实际耗时：1.43 秒（指令接收→链上 finalized 核验）'])assert.ok(message.includes(expected),expected);
    assert.doesNotMatch(message,/构建 \d|模拟 \d|最终校验 \d|Jito 请求 \d|执行启动至 Jito 回执/);
  }finally{n.close();}
});

test('卡片原生买入失败或结果未知时仍只发一条明确的最终结果',()=>{
  const mint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  for(const [status,failureReason,expected] of [
    ['failed','NATIVE_SIMULATION_FAILED','买入失败'],
    ['unknown','NATIVE_BROADCAST_UNCERTAIN','买入待确认'],
  ] as const){
    const {notifications:n,events}=setup();
    try{
      const common={id:`card-${status}`,chain:'solana' as const,tokenAddress:mint,
        inputToken:'So11111111111111111111111111111111111111112',inputAmount:'10000000',
        details:{executionStrategy:'manual_native_test_v1',executionProvider:'pump_native',
          manualTest:{entryMode:'card_direct',requestedAt:iso(),acceptedAt:iso(),actionRef:'b'.repeat(32)}}};
      n.observeOrder(fixture({...common,status:'prepared'}));
      n.observeOrder(fixture({...common,status:'submitting',updatedAt:iso(BASE+25)}));
      n.observeOrder(fixture({...common,status,updatedAt:iso(BASE+250),failureReason}));
      assert.equal(events.length,1,`${status} 必须有且只有一条最终结果`);
      assert.match(events[0]!.text,new RegExp(expected));assert.match(events[0]!.text,new RegExp(failureReason));
      assert.match(events[0]!.text,/实际耗时：250 ms（指令接收→结果判定）/);
    }finally{n.close();}
  }
});

test('显式模拟通知必须带模拟标签，真实金额不猜非原生币单位',()=>{
  const {notifications:n,events}=setup({includePaper:true});
  try {
    n.observeOrder(fixture({mode:'paper',status:'paper_open'}));
    assert.equal(events.length,1);assert.match(events[0].text,/模拟持仓，非实盘/);assert.doesNotMatch(events[0].text,/【实盘订单】/);
    n.observeOrder(fixture({id:'sol-order',chain:'solana',tokenAddress:'So11111111111111111111111111111111111111112',
      inputToken:'So11111111111111111111111111111111111111112',status:'submitted',inputAmount:'1000000001'}));
    assert.match(events.at(-1)!.text,/1\.000000001 SOL/);
    n.observeOrder(fixture({id:'other-input',status:'submitted',inputToken:ADDRESS}));
    assert.match(events.at(-1)!.text,/原生币单位尚未核实/);
  } finally {n.close();}
});

test('失败与未知通知有独立语义，未知不宣称成交，错误文本不泄露上游内容',()=>{
  const {notifications:n,events}=setup();
  try {
    n.observeOrder(fixture({status:'unknown',failureReason:'SUBMISSION_OUTCOME_UNKNOWN'}));
    n.observeOrder(fixture({status:'unknown',failureReason:'SUBMISSION_OUTCOME_UNKNOWN'}));
    assert.equal(events.length,1);assert.match(events[0].text,/不能当作成交或失败/);
    n.observeOrder(fixture({status:'failed',failureReason:'https://secret.invalid?api_key=private'}));
    assert.match(events.at(-1)!.text,/买单失败/);assert.doesNotMatch(events.at(-1)!.text,/private|secret\.invalid/);
  } finally {n.close();}
});

test('持仓风控拦截显示未提交、名称 CA 和精确超限值，缺失数据不伪装为零且重启不重复通知',()=>{
  const dir=mkdtempSync(join(tmpdir(),'trade-holder-risk-')),path=join(dir,'notifications.sqlite');
  const mint='So11111111111111111111111111111111111111112';
  const risk=assessEntryHolderRiskValues({provider:'gmgn',chain:'solana',address:mint,checkedAt:iso(),values:{
    top10:{value:'0.2500000000000000001',sourceField:'security.top_10_holder_rate'},
    bundler:{value:undefined,sourceField:'holders.bundler.holding_ratio',coverage:'lower_bound',lowerBound:'0.2'},
    ratTrader:{value:'0.1',sourceField:'holders.rat_trader.holding_ratio',coverage:'complete'},
  }},new Date(BASE));
  const order=fixture({chain:'solana',tokenAddress:mint,inputToken:mint,inputAmount:'30000000',status:'failed',
    failureReason:'ENTRY_HOLDER_RISK_TOP10_EXCEEDED',details:{entryHolderRisk:{...risk,raw:'NEVER_SAVE_VENDOR_DETAILS'}}});
  const first=setup({path});
  try {
    first.notifications.observeOrder(order);first.notifications.observeOrder(order);assert.equal(first.events.length,1);
    const message=first.events[0].text;
    for(const expected of ['风控拦截，未提交买单','测试币','TEST','Solana',mint,'前10持仓占比：25.00000000000000001% > 25%','捆绑持仓占比：未知','已核实至少 20%','老鼠仓持仓占比：10% ≤ 30%'])assert.ok(message.includes(expected),expected);
    assert.doesNotMatch(message,/买单失败|买单已成交|买单已确认|捆绑持仓占比：0%|NEVER_SAVE/);assert.equal(first.notifications.status().activePositions,0);
    first.notifications.close();const second=setup({path});
    try {second.notifications.observeOrder(order);assert.equal(second.events.length,0);}finally{second.notifications.close();}
    const db=new DatabaseSync(path,{readOnly:true});try{
      assert.doesNotMatch(String(db.prepare('SELECT state FROM trade_notification_positions').get()!.state),/entryHolderRisk|NEVER_SAVE_VENDOR_DETAILS/);
    }finally{db.close();}
  }finally{first.notifications.close();rmSync(dir,{recursive:true,force:true});}
});

test('风控数据不可用或错配显示未知，实际有提交凭证的失败不会声称未提交',()=>{
  const {notifications:n,events}=setup(),mint='So11111111111111111111111111111111111111112';
  const risk=unavailableEntryHolderRisk(mint,iso(),'ENTRY_HOLDER_RISK_READ_FAILED');
  try {
    n.observeOrder(fixture({chain:'solana',tokenAddress:mint,status:'failed',failureReason:'ENTRY_HOLDER_RISK_READ_FAILED',details:{entryHolderRisk:risk}}));
    assert.match(events.at(-1)!.text,/最新持仓数据暂时无法取得/);
    assert.equal((events.at(-1)!.text.match(/占比：未知/g)||[]).length,3);
    n.observeOrder(fixture({id:'wrong-token',chain:'solana',tokenAddress:mint,status:'failed',failureReason:'ENTRY_HOLDER_RISK_TOKEN_MISMATCH',
      details:{entryHolderRisk:{...risk,address:'11111111111111111111111111111111'}}}));
    assert.match(events.at(-1)!.text,/与目标合约不匹配/);assert.doesNotMatch(events.at(-1)!.text,/核验时间/);
    const lower=assessEntryHolderRiskValues({provider:'gmgn',chain:'solana',address:mint,checkedAt:iso(),values:{
      top10:{value:'0.2',sourceField:'security.top_10_holder_rate'},
      bundler:{value:'0.41',sourceField:'holders.bundler.holding_ratio',coverage:'lower_bound',lowerBound:'0.41'},
      ratTrader:{value:'0.1',sourceField:'holders.rat_trader.holding_ratio',coverage:'complete'},
    }},new Date(BASE));
    n.observeOrder(fixture({id:'lower-bound',chain:'solana',tokenAddress:mint,status:'failed',failureReason:'ENTRY_HOLDER_RISK_BUNDLER_EXCEEDED',details:{entryHolderRisk:lower}}));
    assert.match(events.at(-1)!.text,/捆绑持仓占比：至少 41% > 40%（已超限）/);
    assert.doesNotMatch(events.at(-1)!.text,/捆绑持仓占比：41%/);
    n.observeOrder(fixture({id:'already-submitted',status:'failed',failureReason:'ENTRY_HOLDER_RISK_READ_FAILED',providerOrderId:'real-submission'}));
    assert.doesNotMatch(events.at(-1)!.text,/未提交买单/);assert.match(events.at(-1)!.text,/买单失败/);
  }finally{n.close();}
});

test('第三次实盘的服务端保护状态持续更新，但不推送健康和恢复消息',()=>{
  const {notifications:n,events,setNow}=setup();
  const protectedExit=exit({state:'monitoring',assessment:{status:'observed',reasons:[],found:true,
    policyMatched:true,hasLiveStop:false,observedLiveStop:true,terminal:false,conditions:[],checkedAt:iso()}});
  try {
    n.observeOrder(fixture({id:'legacy',status:'confirmed',exit:protectedExit}));
    assert.equal(events.some(e=>e.key.includes(':protection_')),false);
    const real=fixture({id:'third',status:'confirmed',details:{executionStrategy:'third_signal_v1'},exit:protectedExit});
    n.observeOrder(real);
    assert.equal(events.some(e=>e.key.startsWith('trade:third:protection_missing:')),false);
    setNow(BASE+91_000);n.tick();
    assert.equal(events.some(e=>e.key.includes(':protection_')),false);
    n.observeOrder({...real,updatedAt:iso(BASE+91_000),exit:{...protectedExit,checkedAt:iso(BASE+91_000),
      assessment:{...protectedExit.assessment!,checkedAt:iso(BASE+91_000)}}});
    assert.equal(events.some(e=>e.key.includes(':protection_')),false);
    assert.equal(n.status().activePositions,2);
  }finally{n.close();}
});

test('价格基准严格来自确认后的鲜活参考价，拒绝旧价、未来、回退、冲突和未知源',()=>{
  const {notifications:n,events,setNow}=setup();
  try {
    n.observeOrder(fixture({status:'submitted'}));assert.equal(n.observePrice(sample()),false);
    n.observeOrder(fixture({status:'confirmed'}));
    assert.equal(n.observePrice(sample(1,iso(BASE-1))),false);
    assert.equal(n.observePrice(sample(1,iso(BASE+1))),false);
    assert.equal(n.observePrice(sample(1,iso(),{source:'signal_claim'})),false);
    assert.equal(n.observePrice({...sample(),status:'conflict'} as ScanPrice),false);
    assert.equal(n.observePrice(sample(1,iso(),{source:'chain_pool_sample'})),false);
    assert.equal(n.observePrice(sample()),true);
    assert.equal(n.observePrice(sample(2)),false);
    setNow(BASE+10_000);assert.equal(n.observePrice(sample(1.5,iso(BASE+10_000))),true);
    assert.ok(events.some(event=>event.text.includes('相对观察基准：+50.00%')));
    assert.ok(events.some(event=>event.text.includes('观察涨幅不等于实际盈亏')));
    assert.ok(events.every(event=>!event.text.includes('盈利 50')));
    setNow(BASE+200_000);assert.equal(n.observePrice(sample(100,iso(BASE+20_000))),false);
    assert.equal(n.observePrice(sample(100,iso(BASE+201_000))),false);
    assert.equal(n.observePrice(sample(100,iso(BASE+5000))),false);
  } finally {n.close();}
});

test('跨链同 CA 不混入价格，涨幅里程碑去重，回撤只更新状态',()=>{
  const {notifications:n,events,setNow}=setup();
  try {
    n.observeOrder(fixture({status:'confirmed'}));assert.equal(n.observePrice(sample(100,iso(),{chain:'robinhood'})),false);
    n.observePrice(sample());
    setNow(BASE+1000);n.observePrice(sample(2,iso(BASE+1000)));
    setNow(BASE+2000);n.observePrice(sample(1.6,iso(BASE+2000)));
    setNow(BASE+3000);n.observePrice(sample(2,iso(BASE+3000)));
    assert.equal(events.filter(event=>event.key.includes(':milestone:')).length,1);
    setNow(BASE+4000);n.observePrice(sample(.5,iso(BASE+4000)));
    assert.equal(events.filter(event=>event.key.includes(':milestone:')).length,1);
    const position=n.positionViews()[0];assert.equal(position.gainPct,-50);
    const last=events.at(-1)!;assert.match(last.text,/观察峰值：\+100\.00%/);
  } finally {n.close();}
});

test('订单观察通知使用新上涨档位，21倍后按22倍和23倍依次提醒',()=>{
  const {notifications:n,events,setNow}=setup();
  try {
    n.observeOrder(fixture({status:'confirmed'}));n.observePrice(sample(1));
    setNow(BASE+1000);n.observePrice(sample(1.25,iso(BASE+1000)));
    assert.equal(events.filter(event=>event.key.includes(':milestone:')).length,0);
    setNow(BASE+2000);n.observePrice(sample(21,iso(BASE+2000)));
    assert.match(events.at(-1)!.text,/\+1500\.00%、\+2000\.00%/);
    setNow(BASE+3000);n.observePrice(sample(22,iso(BASE+3000)));
    assert.match(events.at(-1)!.text,/越过 \+2100\.00%/);
    setNow(BASE+4000);n.observePrice(sample(23,iso(BASE+4000)));
    assert.match(events.at(-1)!.text,/越过 \+2200\.00%/);
    setNow(BASE+5000);n.observePrice(sample(22,iso(BASE+5000)));
    assert.equal(events.filter(event=>event.key.includes(':milestone:')).length,3);
  }finally {n.close();}
});

test('报价缺失、恢复和周期摘要更新监控状态但保持通知安静',()=>{
  const {notifications:n,events,setNow}=setup();
  try {
    setNow(BASE+900_000);n.tick();assert.equal(events.length,0);
    setNow(BASE);n.observeOrder(fixture({status:'confirmed'}));
    setNow(BASE+60_000);n.tick();assert.equal(events.filter(event=>event.key.includes('quote_stale')).length,0);
    n.recordPriceError({chain:'bsc',address:ADDRESS},'PRICE_NO_FRESH_SOURCE');
    setNow(BASE+61_000);n.tick();n.tick();assert.equal(events.filter(event=>event.key.includes('quote_stale')).length,0);
    assert.equal(n.status().missingPrices,1);
    n.observePrice(sample(1,iso(BASE+61_000)));assert.equal(events.filter(event=>event.key.includes('quote_recovered')).length,0);
    assert.equal(n.status().freshPositions,1);
    setNow(BASE+299_000);n.observePrice(sample(1.1,iso(BASE+299_000)));n.tick();
    assert.equal(events.filter(event=>event.key.includes(':summary:')).length,0);
    setNow(BASE+300_000);n.tick();n.tick();assert.equal(events.filter(event=>event.key.includes(':summary:')).length,0);
    setNow(BASE+600_000);n.tick();
    assert.equal(events.filter(event=>event.key.includes(':summary:')).length,0);
    assert.equal(n.status().missingPrices,1);
  } finally {n.close();}
});

test('重启保持价格基准、峰值、里程碑和已发送状态，并不保存 details 原文',()=>{
  const dir=mkdtempSync(join(tmpdir(),'meme-trade-notifications-')),path=join(dir,'notifications.sqlite');
  let now=BASE;const events:TradeNotificationEvent[]=[];
  const options={now:()=>now,enqueue:(event:TradeNotificationEvent)=>{events.push(event);return true;}};
  let n=new TradeNotifications(path,options);
  try {
    n.observeOrder(fixture({status:'confirmed'}));n.observePrice(sample());
    now+=1000;n.observePrice(sample(2,iso(now)));const count=events.length;n.close();
    n=new TradeNotifications(path,options);n.observeOrder(fixture({status:'confirmed'}));
    now+=1000;n.observePrice(sample(2,iso(now)));assert.equal(events.length,count);
    now+=1000;n.observePrice(sample(.5,iso(now)));assert.match(events.at(-1)!.text,/观察峰值：\+100\.00%/);
    const db=new DatabaseSync(path,{readOnly:true});
    const stored=String(db.prepare('SELECT state FROM trade_notification_positions').get()!.state);
    assert.doesNotMatch(stored,/NEVER_SAVE_VENDOR_DETAILS/);db.close();
  } finally {n.close();rmSync(dir,{recursive:true,force:true});}
});

test('enqueue 失败保留待重试，已存在 key 返回 false 视为成功',()=>{
  let ready=false;const attempts:TradeNotificationEvent[]=[];
  const n=new TradeNotifications(':memory:',{now:()=>BASE,enqueue:event=>{attempts.push(event);if(!ready)throw new Error('private token');return false;}});
  try {
    n.observeOrder(fixture({status:'submitted'}));assert.equal(n.status().pendingEvents,1);
    assert.equal(n.status().lastError,'TRADE_NOTIFICATION_QUEUE_UNAVAILABLE');
    ready=true;n.tick();assert.equal(n.status().pendingEvents,0);n.tick();assert.equal(attempts.length,2);
    assert.equal(attempts[0].key,attempts[1].key);assert.doesNotMatch(JSON.stringify(n.status()),/private token/);
  } finally {n.close();}
});

test('策略子单结果只描述供应商报告，未核实余额不能报清仓',()=>{
  const {notifications:n,events}=setup();
  try {
    const initial=exit({strategyOrderId:'strategy-one'});
    n.observeOrder(fixture({status:'confirmed',exit:initial}));
    assert.equal(events.filter(event=>event.key.endsWith('strategy:strategy-one')).length,0);
    assert.ok(events.every(event=>!event.text.includes('执行成功')));
    const assessed=exit({...initial,assessment:assessment({conditions:[{cid:'tp-1',orderType:'profit_stop',priceScale:'500',sellRatio:'20',status:'success'},
      {cid:'tp-2',orderType:'profit_stop',priceScale:'1000',sellRatio:'10',status:'cancel'},
      {cid:'sl-1',orderType:'loss_stop',priceScale:'40',sellRatio:'100',status:'failed'}]})});
    n.observeOrder(fixture({status:'confirmed',exit:assessed}));n.observeOrder(fixture({status:'confirmed',exit:assessed}));
    assert.equal(events.filter(event=>event.key.includes(':condition:')).length,3);
    assert.ok(events.some(event=>event.text.includes('GMGN 报告止盈单执行成功')));
    assert.ok(events.some(event=>event.text.includes('尚未核实卖出成交价')));
    n.observeOrder(fixture({status:'confirmed',exit:{...assessed,positionClosed:true}}));
    assert.equal(events.filter(event=>event.key.endsWith(':closed')).length,0);
  } finally {n.close();}
});

test('仅策略终态加已核验零余额确认清仓，此后价格和摘要均停止',()=>{
  const {notifications:n,events,setNow}=setup();
  try {
    n.observeOrder(fixture({status:'confirmed'}));n.observePrice(sample());
    const done=exit({state:'closed',positionClosed:true,assessment:assessment({status:'terminal',terminal:true}),
      balance:{status:'verified',amount:'0',checkedAt:iso(),reasons:[]}});
    n.observeOrder(fixture({status:'confirmed',exit:done}));
    assert.equal(events.filter(event=>event.key.endsWith(':closed')).length,1);
    const count=events.length;setNow(BASE+900_000);n.tick();assert.equal(n.observePrice(sample(100,iso(BASE+900_000))),false);
    n.observeOrder(fixture({status:'confirmed'}));assert.equal(events.length,count);assert.equal(n.status().activePositions,0);
  } finally {n.close();}
});

test('权威手动平仓关闭停止摘要及价格告警，保留原订单字段且旧账本回放不再激活',()=>{
  let manuallyClosed=false;
  const {notifications:n,events,setNow}=setup({isClosed:id=>id==='order-one'&&manuallyClosed});
  try {
    const original=fixture({status:'confirmed',actualInputAmount:'140000000000000001',outputAmount:'123'});
    n.observeOrder(original);n.observePrice(sample());assert.equal(n.positionViews().length,1);
    const count=events.length;manuallyClosed=true;
    assert.equal(n.status().activePositions,0);assert.equal(n.status().freshPositions,0);assert.equal(n.status().missingPrices,0);
    assert.deepEqual(n.positionViews(),[]);assert.equal(original.exit,undefined);assert.equal(original.status,'confirmed');
    setNow(BASE+900_000);n.tick();assert.equal(n.observePrice(sample(100,iso(BASE+900_000))),false);
    n.recordPriceError({chain:'bsc',address:ADDRESS},'PRICE_UNAVAILABLE');
    n.observeOrder({...original,updatedAt:iso(BASE+900_000)});
    manuallyClosed=false;n.observeOrder({...original,updatedAt:iso(BASE+900_001)});n.tick();
    assert.equal(n.status().activePositions,0);assert.equal(events.length,count);
    assert.equal(events.some(event=>event.key.endsWith(':closed')),false);
  }finally{n.close();}
});

test('持仓视图入口自身刷新权威关闭，不依赖定时器或状态查询',()=>{
  const closed=new Set<string>(),{notifications:n,events,setNow}=setup({isClosed:id=>closed.has(id)});
  try {
    n.observeOrder(fixture({status:'confirmed'}));n.observePrice(sample());
    n.observeOrder(fixture({id:'order-two',tokenAddress:'0x'+'2'.repeat(40),status:'confirmed'}));
    assert.equal(n.positionViews().length,2);closed.add('order-one');
    assert.deepEqual(n.positionViews().map(row=>row.id),['order-two']);
    const count=events.length;setNow(BASE+1000);assert.equal(n.observePrice(sample(2,iso(BASE+1000))),false);
    assert.equal(events.length,count);assert.equal(n.status().activePositions,1);
  }finally{n.close();}
});

test('已核验手动关闭跨重启保存，回调不可用及新旧 confirmed 回放均不能恢复持仓',()=>{
  const dir=mkdtempSync(join(tmpdir(),'trade-manual-closed-')),path=join(dir,'notifications.sqlite');
  let now=BASE,closed=false;const events:TradeNotificationEvent[]=[];
  const options={now:()=>now,enqueue:(event:TradeNotificationEvent)=>{events.push(event);return true;},isClosed:()=>closed};
  let n=new TradeNotifications(path,options);
  try {
    n.observeOrder(fixture({status:'confirmed',actualInputAmount:'100',outputAmount:'123'}));n.observePrice(sample());
    closed=true;assert.deepEqual(n.positionViews(),[]);const count=events.length;n.close();
    const db=new DatabaseSync(path,{readOnly:true}),row=db.prepare('SELECT state,active FROM trade_notification_positions').get()!;
    const stored=JSON.parse(String(row.state));db.close();
    assert.equal(row.active,0);assert.equal(stored.closedByAuthority,true);assert.equal(stored.order.status,'confirmed');
    assert.equal(stored.order.exit,undefined);assert.equal(stored.order.actualInputAmount,'100');assert.equal(stored.order.outputAmount,'123');
    n=new TradeNotifications(path,{...options,isClosed:()=>{throw Error('PRIVATE_CLOSURE_ERROR');}});
    now+=900000;n.observeOrder(fixture({status:'confirmed',updatedAt:iso(now)}));n.tick();
    assert.equal(n.observePrice(sample(50,iso(now))),false);assert.deepEqual(n.positionViews(),[]);
    assert.equal(n.status().activePositions,0);assert.equal(events.length,count);
  }finally{n.close();rmSync(dir,{recursive:true,force:true});}
});

test('手动关闭在通知服务离线期间发生时，重启第一次报价即停用该持仓',()=>{
  const dir=mkdtempSync(join(tmpdir(),'trade-offline-close-')),path=join(dir,'notifications.sqlite');
  let now=BASE,closed=false;const events:TradeNotificationEvent[]=[];
  const options={now:()=>now,isClosed:()=>closed,enqueue:(e:TradeNotificationEvent)=>{events.push(e);return true;}};
  let n=new TradeNotifications(path,options);
  try {
    n.observeOrder(fixture({status:'confirmed'}));n.observePrice(sample());n.close();const count=events.length;
    closed=true;now+=1000;n=new TradeNotifications(path,options);
    assert.equal(n.observePrice(sample(2,iso(now))),false);assert.equal(n.status().activePositions,0);assert.equal(events.length,count);
  }finally{n.close();rmSync(dir,{recursive:true,force:true});}
});

test('权威关闭回调异常只报告固定错误，不把未知状态当清仓且不会泄漏上游内容',()=>{
  let failed=true;const {notifications:n,setNow}=setup({isClosed:()=>{if(failed)throw Error('private token');return true;}});
  try {
    n.observeOrder(fixture({status:'confirmed'}));assert.equal(n.status().activePositions,1);
    assert.equal(n.status().lastError,'TRADE_NOTIFICATION_CLOSURE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(n.status()),/private token/);
    failed=false;setNow(BASE+1000);n.tick();assert.equal(n.status().activePositions,0);
    assert.equal(n.status().lastError,undefined);
  }finally{n.close();}
});

test('手动关闭丢弃尚未入队的旧持仓提醒，保留买单事实',()=>{
  let now=BASE,closed=false,ready=false;const events:TradeNotificationEvent[]=[];
  const n=new TradeNotifications(':memory:',{now:()=>now,isClosed:()=>closed,summaryIntervalMs:1000,
    enqueue:event=>{if(!ready)throw Error('queue unavailable');events.push(event);return true;}});
  try {
    n.observeOrder(fixture({status:'confirmed'}));n.observePrice(sample());now+=2000;n.observePrice(sample(2,iso(now)));n.tick();
    assert.ok(n.status().pendingEvents!>1);closed=true;ready=true;n.tick();
    assert.deepEqual(events.map(event=>event.key),['trade:order-one:confirmed']);
    assert.equal(n.status().pendingEvents,0);assert.equal(n.status().activePositions,0);
  }finally{n.close();}
});

test('其它订单触发补发队列前也核验已关闭持仓，避免补发旧摘要',()=>{
  let now=BASE,closed=false,ready=false;const events:TradeNotificationEvent[]=[];
  const n=new TradeNotifications(':memory:',{now:()=>now,isClosed:id=>id==='order-one'&&closed,summaryIntervalMs:1000,
    enqueue:event=>{if(!ready)throw Error('queue unavailable');events.push(event);return true;}});
  try {
    n.observeOrder(fixture({status:'confirmed'}));n.observePrice(sample());now+=2000;n.tick();
    closed=true;ready=true;n.observeOrder(fixture({id:'order-two',status:'submitted',tokenAddress:'0x'+'2'.repeat(40)}));
    assert.deepEqual(events.filter(event=>event.key.startsWith('trade:order-one:')).map(event=>event.key),['trade:order-one:confirmed']);
    assert.ok(events.some(event=>event.key==='trade:order-two:submitted'));
  }finally{n.close();}
});

test('保护核验消失、恢复和再次消失仅更新内部状态，不刷 Telegram',()=>{
  const {notifications:n,events,setNow}=setup();
  try {
    n.observeOrder(fixture({status:'confirmed'}));
    n.observeOrder(fixture({status:'confirmed'}));assert.equal(events.filter(event=>event.key.includes('protection_missing')).length,0);
    const verified=exit({state:'monitoring',assessment:assessment({status:'verified',hasLiveStop:true})});
    n.observeOrder(fixture({status:'confirmed',exit:verified}));
    assert.equal(events.filter(event=>event.key.includes('protection_recovered')).length,0);
    setNow(BASE+91_000);n.tick();n.tick();assert.equal(events.filter(event=>event.key.includes('protection_missing')).length,0);
  } finally {n.close();}
});

test('订单提交成功后才通知；监听器异常或修改参数不影响账本及其他监听者',async()=>{
  const store=new OrderStore(':memory:');const seen:OpeningOrder[]=[];
  store.subscribe(()=>{throw new Error('listener fail');});
  store.subscribe(async()=>{throw new Error('async listener fail');});
  store.subscribe(order=>{order.status='failed';});
  const unsub=store.subscribe(order=>{assert.equal(store.get(order.id)?.status,order.status);seen.push(order);});
  try {
    const {id:_id,status:_status,createdAt:_created,updatedAt:_updated,...input}=fixture();
    const reserved=store.reserve(input,1,new Date(BASE));assert.equal(reserved.created,true);const id=reserved.order!.id;
    assert.equal(seen.length,1);assert.equal(reserved.order!.status,'prepared');
    store.reserve(input,1,new Date(BASE));assert.equal(seen.length,1);
    store.beginSubmission(id,new Date(BASE));assert.equal(seen.length,2);
    store.beginSubmission(id,new Date(BASE));assert.equal(seen.length,2);
    store.update(id,['submitting'],{status:'submitted'},new Date(BASE));assert.equal(seen.length,3);
    assert.equal(store.update(id,['prepared'],{status:'failed'},new Date(BASE)),undefined);assert.equal(seen.length,3);
    unsub();store.update(id,['submitted'],{status:'confirmed'},new Date(BASE));assert.equal(seen.length,3);
    await Promise.resolve();assert.equal(store.get(id)?.status,'confirmed');
  } finally {store.close();}
});

test('activePositions 不受页面上限影响，排除 prepared/失败/模拟/已清仓，recover 提交后发事件',()=>{
  const store=new OrderStore(':memory:');const seen:OpeningOrder[]=[];store.subscribe(order=>{seen.push(order);});
  try {
    const {id:_id,status:_status,createdAt:_created,updatedAt:_updated,...input}=fixture();
    const first=store.reserve(input,10,new Date(BASE)).order!;assert.equal(store.activePositions().length,0);
    store.beginSubmission(first.id,new Date(BASE));assert.equal(store.activePositions().length,1);
    store.recover(new Date(BASE+300_001));assert.equal(seen.at(-1)!.status,'unknown');assert.equal(store.activePositions()[0].status,'unknown');
    store.update(first.id,['unknown'],{status:'failed'});assert.equal(store.activePositions().length,0);
    const paper=store.reserve({...input,tokenAddress:'0x'+'3'.repeat(40),eventKey:'paper',mode:'paper'},10,new Date(BASE)).order!;
    store.update(paper.id,['prepared'],{status:'paper_open'});assert.equal(store.activePositions().length,0);
    assert.equal(store.activePositions({includePaper:true}).length,1);
  } finally {store.close();}
});

test('退出 CAS 成功提交后通知，零余额清仓立即离开活跃集合，重复更新不通知',()=>{
  const store=new OrderStore(':memory:');const seen:OpeningOrder[]=[];store.subscribe(order=>{seen.push(order);});
  try {
    const before=exit({strategyOrderId:'strategy-closed'});
    const {id:_id,status:_status,createdAt:_created,updatedAt:_updated,...input}=fixture({exit:before});
    const first=store.reserve(input,10,new Date(BASE)).order!;
    store.update(first.id,['prepared'],{status:'confirmed'},new Date(BASE));assert.equal(store.activePositions().length,1);
    const after=exit({...before,state:'closed',positionClosed:true,assessment:assessment({status:'terminal',terminal:true}),
      balance:{status:'verified',amount:'0',checkedAt:iso(),reasons:[]}});
    const count=seen.length;
    store.updateExit(first.id,before,after,new Date(BASE));assert.equal(seen.length,count+1);
    assert.equal(seen.at(-1)!.exit?.positionClosed,true);assert.equal(store.activePositions().length,0);
    store.updateExit(first.id,before,after,new Date(BASE));assert.equal(seen.length,count+1);
  } finally {store.close();}
});

const solMint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',solNative='So11111111111111111111111111111111111111112';
const solWallet='11111111111111111111111111111111',solHash='1'.repeat(64);
function filledSolOrder(priceUsd=1):OpeningOrder {
  return fixture({id:'filled-sol',chain:'solana',wallet:solWallet,inputToken:solNative,tokenAddress:solMint,status:'confirmed',
    transactionHash:solHash,actualInputAmount:'1000000000',outputAmount:'500000',
    details:{executionStrategy:'third_signal_v1',thirdSignalFill:{source:'solana_finalized',transactionHash:solHash,wallet:solWallet,tokenAddress:solMint,
      inputAmount:'1000000000',outputAmount:'500000',tokenDecimals:5,buySlot:100,confirmedAt:iso(),observedAt:iso(),priceUsd}}});
}
const solSample=(priceUsd:number,observedAt=iso())=>sample(priceUsd,observedAt,{chain:'solana',address:solMint});

test('finalized third-signal fill anchors gains to the actual executed price even when the first market tick is already higher',()=>{
  const {notifications:n,events,setNow}=setup();try {
    n.observeOrder(filledSolOrder(1));assert.equal(n.status().activePositions,1);
    setNow(BASE+1000);n.observePrice(solSample(1.5,iso(BASE+1000)));
    assert.equal(n.positionViews()[0].gainBasis,'fill');assert.equal(n.positionViews()[0].gainPct,50);assert.equal(n.positionViews()[0].entryPriceUsd,1);
    const milestone=events.find(e=>e.key.includes(':milestone:'));assert.ok(milestone);assert.match(milestone.text,/相对买入成交价：\+50\.00%/);
    assert.doesNotMatch(milestone.text,/首个鲜活参考价|观察基准/);
    setNow(BASE+2000);n.observeOrder({...filledSolOrder(.1),updatedAt:iso(BASE+2000)});
    assert.equal(n.positionViews()[0].entryPriceUsd,1,'a later receipt must not rewrite an established verified entry price');
  }finally{n.close();}
});

test('unbound fill metadata cannot become an execution-price baseline',()=>{
  for(const mutation of [
    (o:OpeningOrder)=>{(o.details.thirdSignalFill as any).wallet=solMint;},
    (o:OpeningOrder)=>{(o.details.thirdSignalFill as any).inputAmount='1';},
    (o:OpeningOrder)=>{(o.details.thirdSignalFill as any).outputAmount='1';},
    (o:OpeningOrder)=>{(o.details.thirdSignalFill as any).transactionHash='wrong';},
    (o:OpeningOrder)=>{(o.details.thirdSignalFill as any).priceUsd=NaN;},
  ]){const {notifications:n}=setup();try{const o=filledSolOrder();mutation(o);n.observeOrder(o);n.observePrice(solSample(1.5));
    assert.equal(n.positionViews()[0].gainBasis,'observation');assert.equal(n.positionViews()[0].entryPriceUsd,undefined);
  }finally{n.close();}}
});

test('a delayed fill upgrades the baseline, checks fresh current price immediately and does not repeat prior milestone alerts',()=>{
  const {notifications:n,events,setNow}=setup();try{
    const o=filledSolOrder(),pending={...o,details:{executionStrategy:'third_signal_v1'}};
    n.observeOrder(pending);n.observePrice(solSample(2));setNow(BASE+1000);n.observePrice(solSample(3,iso(BASE+1000)));
    assert.equal(events.filter(e=>e.key.includes(':milestone:')).length,1);
    n.observeOrder({...o,updatedAt:iso(BASE+1000)});
    assert.equal(n.positionViews()[0].gainPct,200);assert.equal(n.positionViews()[0].gainBasis,'fill');
    const milestones=events.filter(e=>e.key.includes(':milestone:'));
    assert.equal(milestones.length,2);assert.match(milestones[1].text,/\+100\.00%、\+200\.00%/);assert.doesNotMatch(milestones[1].text,/越过 \+50/);
    assert.equal(events.some(e=>e.key.endsWith(':fill_price_baseline')),false);
    setNow(BASE+2000);n.observePrice(solSample(3,iso(BASE+2000)));assert.equal(events.filter(e=>e.key.includes(':milestone:')).length,2);
  }finally{n.close();}
});

test('fill baseline and milestone watermarks survive restart with the same exact threshold alerts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'fill-notification-')),path=join(dir,'tg.sqlite');let now=BASE;const events:TradeNotificationEvent[]=[];
  const options={now:()=>now,enqueue:(event:TradeNotificationEvent)=>{events.push(event);return true;}};
  let n=new TradeNotifications(path,options);try{
    n.observeOrder(filledSolOrder());now+=1000;n.observePrice(solSample(2,iso(now)));const count=events.length;n.close();
    n=new TradeNotifications(path,options);n.observeOrder(filledSolOrder());now+=1000;n.observePrice(solSample(2,iso(now)));
    assert.equal(events.length,count);assert.equal(n.positionViews()[0].gainBasis,'fill');assert.equal(n.positionViews()[0].gainPct,100);
  }finally{n.close();rmSync(dir,{recursive:true,force:true});}
});

test('price notifications and milestone state commit atomically so interrupted persistence cannot duplicate thresholds',()=>{
  const dir=mkdtempSync(join(tmpdir(),'atomic-price-alert-')),path=join(dir,'tg.sqlite');const {notifications:n,events,setNow}=setup({path});
  const db=new DatabaseSync(path);try{
    n.observeOrder(fixture({status:'confirmed'}));n.observePrice(sample(1));const count=events.length;
    db.exec("CREATE TRIGGER fail_notification_save BEFORE UPDATE ON trade_notification_positions BEGIN SELECT RAISE(ABORT,'TEST_SAVE_INTERRUPTED'); END;");
    setNow(BASE+1000);assert.throws(()=>n.observePrice(sample(2,iso(BASE+1000))),/TEST_SAVE_INTERRUPTED/);assert.equal(events.length,count);
    assert.equal(db.prepare("SELECT count(*) AS n FROM trade_notification_events WHERE event_key LIKE '%:milestone:%'").get()!.n,0);
    db.exec('DROP TRIGGER fail_notification_save');n.observePrice(sample(2,iso(BASE+1000)));
    assert.equal(events.filter(e=>e.key.includes(':milestone:')).length,1);
    setNow(BASE+2000);n.observePrice(sample(3,iso(BASE+2000)));const latest=events.filter(e=>e.key.includes(':milestone:')).at(-1)!;
    assert.match(latest.text,/越过 \+200\.00%/);assert.doesNotMatch(latest.text,/越过 \+50/);
  }finally{db.close();n.close();rmSync(dir,{recursive:true,force:true});}
});
