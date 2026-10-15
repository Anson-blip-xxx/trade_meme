import test from 'node:test';
import assert from 'node:assert/strict';
import {DebotSignalError,fetchDebotSignalPage,fetchDebotWalletDetails,normalizeDebotSignalPush,normalizeDebotSignals} from '../src/providers/debot-signals.js';
import type {Chain} from '../src/types.js';
import {DebotSessionError} from '../src/providers/debot-session.js';

const now=new Date('2026-10-15T03:00:00.000Z');
const ca='0x34b658a2815f2a34c752a051a7c84bbc39b07777';
const other='0x1111111111111111111111111111111111111111';
const sol='DLjxHm4YUs13fiT9Hy2LFQ527swmig4kZ59xb72Ypump';
function sample(chain:Chain='bsc') {
  const token=chain==='solana'?sol:ca,channel={bsc:2,solana:1,robinhood:83}[chain];
  return {code:0,description:'success',data:{next:'2',meta:{
    tokens:{[token]:{chain,address:token,launchpad:chain==='solana'?'pump':'flap',symbol:'测试'}},
    channel_info:{[String(channel)]:{id:channel,chain}},
    social_info:{[token]:{description:'项目自述不是 AI 叙事'}}},results:[{
      id:'e2d3c97b869e40a08570dad583362181',chain,channel_id:channel,token,
      create_time:Math.floor(now.getTime()/1000)-60,group_name:'SmartMoney#300#3分#3钱#150K',
      avg_wallet_volume:'218.09909066114542',token_trading_stat:{price:0.0005780034870331805},
      wallet_stats:[{alias:'SW-b164',wallet:'',token},{alias:'SW-e82e',wallet:'',token},
        {alias:'SW-cc5b',wallet:'',token}],
    }]}};
}

test('真实响应格式保留告警时间、统计及别名，空钱包不成为链上买入证据',()=>{
  const result=normalizeDebotSignals(sample(),'bsc',now);
  assert.equal(result.received,1);assert.equal(result.rejected,0);assert.equal(result.next,'2');
  assert.equal(result.reason,undefined);assert.equal(result.observations.length,1);
  const observation=result.observations[0];
  assert.equal(observation.walletCount,3);assert.equal(observation.addressCount,0);
  assert.deepEqual(observation.aliases,['SW-b164','SW-e82e','SW-cc5b']);
  assert.equal(observation.averageWalletVolumeUsd,218.09909066114542);
  assert.equal(observation.alertPriceUsd,0.0005780034870331805);
  assert.equal(observation.observedAt,now.toISOString());
  assert.equal(observation.signal.occurredAt,'2026-10-15T02:59:00.000Z');
  assert.equal(observation.signal.source,'debot');assert.equal(observation.signal.claim,'unspecified');
  assert.equal(observation.signal.claimedPlatform,'flap');assert.equal(observation.signal.vendorNarrative,undefined);
  assert.deepEqual(observation.signal.evidenceUrls,[]);
  assert.equal(observation.signal.text.includes('SW-'),false);
  assert.equal(observation.signal.text.includes('项目自述'),false);
  assert.equal('wallets' in observation,false);assert.equal('transaction' in observation,false);
});

test('官方成功码 200 与 0 均可读取信号和钱包详情，未登录业务码仍拒绝',async()=>{
  for(const code of [0,200]){
    const payload={...sample(),code};
    const page=await fetchDebotSignalPage('bsc',{now:()=>now,fetcher:async()=>Response.json(payload)});
    assert.equal(page.observations.length,1);assert.equal(page.reason,undefined);
    const details=await fetchDebotWalletDetails(page.observations[0],{now:()=>now,
      fetcher:async()=>Response.json({code,data:[{wallet_stats:{wallet:other,alias:'test'}}]})});
    assert.equal(details.vendorWallets.length,1);assert.equal(details.vendorWallets[0].address,other);
  }
  const invalid=normalizeDebotSignals({...sample(),code:101},'bsc',now);
  assert.equal(invalid.observations.length,0);assert.ok(invalid.reason);
});

test('三个链和官方频道严格对应，Solana CA 大小写保留',()=>{
  for(const chain of ['bsc','solana','robinhood'] as const) {
    const result=normalizeDebotSignals(sample(chain),chain,now);
    assert.equal(result.observations.length,1);assert.equal(result.observations[0].signal.token.chain,chain);
    assert.equal(result.observations[0].signal.token.address,chain==='solana'?sol:ca);
    const wrong=sample(chain);wrong.data.results[0].channel_id++;
    assert.equal(normalizeDebotSignals(wrong,chain,now).rejected,1);
  }
  assert.equal(normalizeDebotSignals(sample('bsc'),'robinhood',now).observations.length,0);
});

test('价格、金额、分组和别名刷新不改变持久信号身份或内容',()=>{
  const first=normalizeDebotSignals(sample(),'bsc',now).observations[0];
  const changed=sample(),row=changed.data.results[0];
  row.token_trading_stat.price=0.1;row.avg_wallet_volume='9999';row.group_name='new';
  row.wallet_stats.push({alias:'later',wallet:other,token:ca});
  const second=normalizeDebotSignals(changed,'bsc',new Date(now.getTime()+60_000)).observations[0];
  assert.deepEqual(first.signal,second.signal);assert.notEqual(first.alertPriceUsd,second.alertPriceUsd);
  assert.equal(second.addressCount,1);assert.notEqual(first.observedAt,second.observedAt);
});

test('缺失身份、缩略地址、错误链、毫秒或未来时间均拒绝，不用采样时间补齐',()=>{
  const edits:((row:any)=>void)[]=[row=>{delete row.id;},row=>{row.id='';},row=>{row.id=123;},
    row=>{row.id='x\nprivate';},row=>{delete row.token;},row=>{row.token='0x34...7777';},
    row=>{row.token=sol;},row=>{row.chain='sol';},row=>{delete row.chain;},row=>{delete row.channel_id;},
    row=>{row.channel_id='2';},row=>{delete row.create_time;},row=>{row.create_time=now.getTime();},
    row=>{row.create_time=String(now.getTime());},row=>{row.create_time=now.getTime()/1000+31;},
    row=>{row.create_time=0;},row=>{row.create_time=123.45;},row=>{row.create_time='2026-10-15';}];
  for(const edit of edits) {
    const raw=sample();edit(raw.data.results[0]);
    const result=normalizeDebotSignals(raw,'bsc',now);
    assert.equal(result.observations.length,0);assert.equal(result.rejected,1);
  }
});

test('接受秒字符串和 30 秒容差，历史告警保持原始时间交由采集器筛选',()=>{
  for(const value of [String(now.getTime()/1000-60),now.getTime()/1000+30,1_700_000_000]) {
    const raw:any=sample();raw.data.results[0].create_time=value;
    const result=normalizeDebotSignals(raw,'bsc',now);
    assert.equal(result.observations.length,1);
    assert.equal(result.observations[0].signal.occurredAt,new Date(Number(value)*1000).toISOString());
  }
});

test('CA 元数据或频道身份冲突拒收，不能借同名、相同尾号或平台声明通过',()=>{
  const edits:((raw:any)=>void)[]=[raw=>{raw.data.meta.tokens[ca].chain='robinhood';},
    raw=>{raw.data.meta.tokens[ca].address=other;},raw=>{delete raw.data.meta.tokens[ca].address;},
    raw=>{raw.data.meta.channel_info['2'].chain='solana';},raw=>{raw.data.meta.channel_info['2'].id=1;}];
  for(const edit of edits) {
    const raw=sample();edit(raw);const result=normalizeDebotSignals(raw,'bsc',now);
    assert.equal(result.observations.length,0);assert.equal(result.rejected,1);
  }
  const raw:any=sample();delete raw.data.meta;
  const signal=normalizeDebotSignals(raw,'bsc',now).observations[0].signal;
  assert.equal(signal.claimedPlatform,undefined);assert.equal(signal.claim,'unspecified');
});

test('不凭 7777 或 pump 尾号猜平台，未知元数据平台不扩大声明范围',()=>{
  const raw=sample();raw.data.meta.tokens[ca].launchpad='unknown_launchpad';
  assert.equal(normalizeDebotSignals(raw,'bsc',now).observations[0].signal.claimedPlatform,undefined);
  const noMeta:any=sample('solana');delete noMeta.data.meta.tokens;
  assert.equal(normalizeDebotSignals(noMeta,'solana',now).observations[0].signal.claimedPlatform,undefined);
});

test('别名不能当钱包地址，非目标钱包条目剔除，真实地址只统计不生成交易',()=>{
  const raw=sample();raw.data.results[0].wallet_stats=[{alias:other,wallet:'',token:ca},
    {alias:'SW-real',wallet:other,token:ca},{alias:'repeat',wallet:other.toUpperCase().replace('0X','0x'),token:ca},
    {alias:'wrong-token',wallet:ca,token:other},{alias:'fake',wallet:'0x11...11',token:ca}];
  const observation=normalizeDebotSignals(raw,'bsc',now).observations[0];
  assert.equal(observation.walletCount,4);assert.equal(observation.addressCount,1);
  assert.equal(observation.aliases.includes('wrong-token'),false);
  assert.equal(observation.signal.text.includes(other),false);
});

test('匿名钱包保留供应商报告的时间金额精度，真实地址只在完整公开时保留',()=>{
  const raw:any=sample();raw.data.results[0].wallet_stats=[
    {alias:'SW-anonymous',wallet:'',token:ca,last_trade_time:now.getTime()/1000-90,
      amount:'761177.041941208800000000001',price:'0.00057800348703318051264',volume:'439.96298449162015'},
    {alias:'SW-public',wallet:other,token:ca,last_trade_time:String(now.getTime()/1000-120),
      amount:'0.000000000000000000000000001',price:0.5,volume:20}];
  const observation=normalizeDebotSignals(raw,'bsc',now).observations[0];
  assert.equal(observation.vendorWallets?.length,2);assert.equal(observation.addressCount,1);
  assert.deepEqual(observation.vendorWallets?.[0],{alias:'SW-anonymous',lastTradeAt:'2026-10-15T02:58:30.000Z',
    amount:'761177.041941208800000000001',priceUsd:0.0005780034870331805,volumeUsd:439.96298449162015});
  assert.deepEqual(observation.vendorWallets?.[1],{alias:'SW-public',address:other,lastTradeAt:'2026-10-15T02:58:00.000Z',
    amount:'0.000000000000000000000000001',priceUsd:0.5,volumeUsd:20});
  assert.equal('address' in observation.vendorWallets![0],false);
  for(const snapshot of observation.vendorWallets!) {
    assert.equal('transaction' in snapshot,false);assert.equal('side' in snapshot,false);assert.equal('verified' in snapshot,false);
  }
  raw.data.results[0].wallet_stats[0].amount='2';raw.data.results[0].wallet_stats[0].last_trade_time++;
  assert.deepEqual(normalizeDebotSignals(raw,'bsc',now).observations[0].signal,observation.signal);
});

test('钱包快照字段严格限制，错误值舍弃，最多 20 个快照及 20×80 字别名',()=>{
  const raw:any=sample();raw.data.results[0].wallet_stats=[
    {alias:'a'.repeat(80),wallet:'0x111...111',token:ca,last_trade_time:now.getTime(),amount:'1e18',volume:Infinity,price:-1},
    {alias:'future',wallet:'',token:ca,last_trade_time:now.getTime()/1000+31,amount:'1'.repeat(101),volume:'1e30',price:'1'.repeat(101)},
    {alias:'bad\nalias',wallet:other,token:ca,last_trade_time:0,amount:-1,volume:'NaN',price:0},
    {alias:'b'.repeat(81),wallet:'',token:ca,amount:'10'},
    {alias:'wrong-token',wallet:other,token:other,amount:'10'}];
  const observation=normalizeDebotSignals(raw,'bsc',now).observations[0];
  assert.deepEqual(observation.vendorWallets,[{alias:'a'.repeat(80)},{alias:'future'},{address:other}]);
  assert.deepEqual(observation.aliases,['a'.repeat(80),'future']);
  raw.data.results[0].wallet_stats=Array.from({length:100},(_,i)=>({alias:`SW-${i}`,wallet:'',token:ca,amount:'12'}));
  const bounded=normalizeDebotSignals(raw,'bsc',now).observations[0];
  assert.equal(bounded.walletCount,100);assert.equal(bounded.vendorWallets?.length,20);assert.equal(bounded.aliases.length,20);
});

test('无效价格金额不进入观察值，非零 code、错误结构和无效上下文不接受',()=>{
  for(const value of [NaN,Infinity,-1,0,'NaN','',{},null]) {
    const raw:any=sample();raw.data.results[0].token_trading_stat.price=value;raw.data.results[0].avg_wallet_volume=value;
    const observation=normalizeDebotSignals(raw,'bsc',now).observations[0];
    assert.equal(observation.alertPriceUsd,undefined);assert.equal(observation.averageWalletVolumeUsd,undefined);
  }
  for(const payload of [{code:1,data:sample().data},{code:'0',data:sample().data},{data:sample().data},
    {code:0,data:{results:{}}},null,[]]) {
    assert.equal(normalizeDebotSignals(payload,'bsc',now).reason,'DEBOT_SIGNAL_RESPONSE_INVALID');
  }
  assert.equal(normalizeDebotSignals(sample(),'bsc',new Date(NaN)).reason,'DEBOT_SIGNAL_INPUT_INVALID');
  assert.equal(normalizeDebotSignals(sample(),'invalid' as Chain,now).reason,'DEBOT_SIGNAL_INPUT_INVALID');
});

test('每页最多处理 20 条，拒绝重复事件，next 仅返回不跟随',()=>{
  const raw=sample(),row=raw.data.results[0];
  raw.data.results=Array.from({length:30},(_,i)=>({...row,id:`event-${i}`}));
  const result=normalizeDebotSignals(raw,'bsc',now);
  assert.equal(result.received,30);assert.equal(result.observations.length,20);assert.equal(result.rejected,10);
  raw.data.results=[row,{...row}];
  assert.equal(normalizeDebotSignals(raw,'bsc',now).rejected,1);
  raw.data.next='https://private.invalid/token';
  assert.equal(normalizeDebotSignals(raw,'bsc',now).next,undefined);
});

test('WS 外层链严格绑定内层列表，可复用 HTTP 信号身份且不补造缺失链',()=>{
  for(const chain of ['bsc','solana','robinhood'] as const) {
    const raw=sample(chain),push={chain,data:JSON.stringify(raw.data)};
    assert.deepEqual(normalizeDebotSignalPush(push,now),normalizeDebotSignals(raw,chain,now));
  }
  const wrong:any=sample();wrong.data.results[0].chain='robinhood';
  assert.equal(normalizeDebotSignalPush({chain:'bsc',data:JSON.stringify(wrong.data)},now).observations.length,0);
  delete wrong.data.results[0].chain;
  assert.equal(normalizeDebotSignalPush({chain:'bsc',data:JSON.stringify(wrong.data)},now).rejected,1);
  for(const envelope of [{chain:'sol',data:'{}'},{chain:'bsc',data:{}},{data:JSON.stringify(sample().data)},
    {chain:'bsc',data:JSON.stringify(sample())}]) {
    assert.equal(normalizeDebotSignalPush(envelope,now).reason,'DEBOT_SIGNAL_PUSH_INVALID');
  }
  assert.equal(normalizeDebotSignalPush({chain:'bsc',data:'private invalid json'},now).reason,'DEBOT_SIGNAL_INVALID_JSON');
  assert.equal(normalizeDebotSignalPush({chain:'bsc',data:'汉'.repeat(700_000)},now).reason,'DEBOT_SIGNAL_RESPONSE_TOO_LARGE');
});

test('元数据支持 chain:CA，但所有提供的键都要身份一致，不能藏起冲突',()=>{
  const raw:any=sample(),metadata=raw.data.meta.tokens[ca];
  raw.data.meta.tokens={[`bsc:${ca}`]:metadata};
  assert.equal(normalizeDebotSignalPush({chain:'bsc',data:JSON.stringify(raw.data)},now)
    .observations[0].signal.claimedPlatform,'flap');
  raw.data.meta.tokens[ca]={...metadata};
  assert.equal(normalizeDebotSignals(raw,'bsc',now).observations.length,1);
  for(const conflict of [{...metadata,address:other},{...metadata,chain:'robinhood'},
    {...metadata,launchpad:'four'},null]) {
    raw.data.meta.tokens[ca]=conflict;
    assert.equal(normalizeDebotSignals(raw,'bsc',now).rejected,1);
  }
});

test('固定端点匿名单次 GET、20 条、10 秒信号，不接受用户 URL 或透传凭证',async()=>{
  let calls=0;
  const result=await fetchDebotSignalPage('bsc',{now:()=>now,fetcher:async(url,init)=>{
    calls++;const parsed=new URL(String(url));
    assert.equal(parsed.origin,'https://debot.ai');assert.equal(parsed.pathname,'/api/community/signal/channel/list');
    assert.deepEqual([...parsed.searchParams.keys()].sort(),['chain','channel_ids','page_size','request_id']);
    assert.equal(parsed.searchParams.get('chain'),'bsc');assert.equal(parsed.searchParams.get('channel_ids'),'2');
    assert.equal(parsed.searchParams.get('page_size'),'20');
    assert.match(parsed.searchParams.get('request_id')!,/^[0-9a-f-]{36}$/);
    assert.equal(init?.method,'GET');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
    assert.ok(init?.signal instanceof AbortSignal);assert.equal(init?.body,undefined);
    assert.deepEqual([...new Headers(init?.headers).entries()],[['accept','application/json']]);
    return Response.json(sample());
  }});
  assert.equal(calls,1);assert.equal(result.observations.length,1);
});

test('各链请求使用正确官方频道，响应完成时间是观察时间',async()=>{
  for(const chain of ['solana','robinhood'] as const) {
    const responseTime=new Date(now.getTime()+5_000);
    const result=await fetchDebotSignalPage(chain,{now:()=>responseTime,fetcher:async(url)=>{
      const parsed=new URL(String(url));assert.equal(parsed.searchParams.get('chain'),chain);
      assert.equal(parsed.searchParams.get('channel_ids'),chain==='solana'?'1':'83');
      return Response.json(sample(chain));
    }});
    assert.equal(result.observations[0].observedAt,responseTime.toISOString());
  }
});

test('认证失败和限流仅返回固定错误码，不输出正文或尝试登录重试',async()=>{
  for(const status of [401,403,429,500]) {
    let calls=0;
    await assert.rejects(fetchDebotSignalPage('bsc',{now:()=>now,fetcher:async()=>{
      calls++;return new Response('private secret',{status,headers:{'retry-after':'120'}});
    }}),(error:unknown)=>{
      assert.ok(error instanceof DebotSignalError);
      assert.equal(error.reason,status===500?'DEBOT_SIGNAL_HTTP_ERROR':`DEBOT_SIGNAL_HTTP_${status}`);
      assert.equal(error.cooldownUntil,status===429?now.getTime()+120_000:undefined);
      assert.equal(error.message.includes('private'),false);return true;
    });
    assert.equal(calls,1);
  }
});

test('429 冷却支持秒和日期，设上下限且不传播任意头内容',async()=>{
  for(const [retry,delay] of [['0',60_000],['9999999',3_600_000],['nonsense',60_000],
    [new Date(now.getTime()+300_000).toUTCString(),300_000]] as const) {
    await assert.rejects(fetchDebotSignalPage('bsc',{now:()=>now,fetcher:async()=>new Response('',
      {status:429,headers:{'retry-after':retry}})}),(error:unknown)=>{
      assert.ok(error instanceof DebotSignalError);assert.equal(error.cooldownUntil,now.getTime()+delay);return true;
    });
  }
});

test('2 MiB 响应上限涵盖 Content-Length 和实际流大小，停止读取并取消流',async()=>{
  let cancelled=false;
  await assert.rejects(fetchDebotSignalPage('bsc',{fetcher:async()=>new Response(new ReadableStream({
    cancel(){cancelled=true;}}),{headers:{'content-length':String(2*1024*1024+1)}})}),
  (error:unknown)=>error instanceof DebotSignalError&&error.reason==='DEBOT_SIGNAL_RESPONSE_TOO_LARGE');
  assert.equal(cancelled,true);cancelled=false;
  await assert.rejects(fetchDebotSignalPage('bsc',{fetcher:async()=>new Response(new ReadableStream({
    pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}}))}),
  (error:unknown)=>error instanceof DebotSignalError&&error.reason==='DEBOT_SIGNAL_RESPONSE_TOO_LARGE');
  assert.equal(cancelled,true);
});

test('JSON、超时和网络错误分类固定，不泄露 URL 或异常正文',async()=>{
  const cases:[()=>Promise<Response>,string][]=[
    [async()=>new Response('private invalid json'),'DEBOT_SIGNAL_INVALID_JSON'],
    [async()=>{throw new DOMException('private token','TimeoutError');},'DEBOT_SIGNAL_REQUEST_TIMEOUT'],
    [async()=>{throw new DOMException('private token','AbortError');},'DEBOT_SIGNAL_REQUEST_TIMEOUT'],
    [async()=>{throw new Error('https://private.invalid?token=secret');},'DEBOT_SIGNAL_REQUEST_FAILED']];
  for(const [fetcher,reason] of cases)await assert.rejects(fetchDebotSignalPage('bsc',{fetcher}),
    (error:unknown)=>{assert.ok(error instanceof DebotSignalError);assert.equal(error.reason,reason);
      assert.equal(error.message.includes('private'),false);return true;});
});

test('详情只读请求固定绑定信号，保留匿名钱包及有限盈亏摘要并明确供应商来源',async()=>{
  const observation=normalizeDebotSignals(sample(),'bsc',now).observations[0];let calls=0;
  const result=await fetchDebotWalletDetails(observation,{now:()=>now,fetcher:async(url,init)=>{
    calls++;const parsed=new URL(String(url));
    assert.equal(parsed.origin,'https://debot.ai');assert.equal(parsed.pathname,'/api/community/signal/channel/wallets/profit');
    assert.deepEqual([...parsed.searchParams.keys()].sort(),['chain','channel_id','notification_id','request_id','token']);
    assert.equal(parsed.searchParams.get('token'),ca);assert.equal(parsed.searchParams.get('notification_id'),observation.id);
    assert.equal(parsed.searchParams.get('channel_id'),'2');assert.equal(parsed.searchParams.get('chain'),'bsc');
    assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);assert.equal(init?.redirect,'error');
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({code:0,data:[{wallet_stats:{alias:'SW-a',wallet:'',last_trade_time:now.getTime()/1000-5,
      amount:'123.456789012345678901',price:'0.002',volume:'12.34'},profit:{buy_volume:'12.34',buy_amount:'123.456789012345678901',
      actual_buy_amount:100,actual_buy_cost:'10',hold_amount:'100',realized_profit:'-3.2',unrealized_profit:'0.12345678901234567890',
      unexpected_secret:'must-not-pass'}}]});
  }});
  assert.equal(calls,1);assert.equal(result.fetchedAt,now.toISOString());assert.equal(result.rejected,0);
  assert.deepEqual(result.vendorWallets,[{alias:'SW-a',lastTradeAt:'2026-10-15T02:59:55.000Z',amount:'123.456789012345678901',
    priceUsd:0.002,volumeUsd:12.34,source:'debot',verification:'vendor_report',profit:{buyVolumeUsd:'12.34',buyAmount:'123.456789012345678901',
      actualBuyAmount:'100',actualBuyCostUsd:'10',holdAmount:'100',realizedProfitUsd:'-3.2',unrealizedProfitUsd:'0.12345678901234567890'}}]);
  assert.equal(JSON.stringify(result).includes('must-not-pass'),false);
});

test('详情必须提供会话 fetcher，身份冲突舍弃，字段和条数限制不受远端绕过',async()=>{
  const observation=normalizeDebotSignals(sample(),'bsc',now).observations[0];
  await assert.rejects(fetchDebotWalletDetails(observation,{} as never),
    (error:unknown)=>error instanceof DebotSignalError&&error.reason==='DEBOT_SIGNAL_AUTH_REQUIRED');
  let calls=0;
  await assert.rejects(fetchDebotWalletDetails({...observation,id:'bad&token=other'}, {fetcher:async()=>{calls++;return Response.json({});}}),
    (error:unknown)=>error instanceof DebotSignalError&&error.reason==='DEBOT_SIGNAL_INPUT_INVALID');
  assert.equal(calls,0);
  const wallet_stats={alias:'SW-a',wallet:other,token:ca};
  const rows=[{wallet_stats:{...wallet_stats,token:other}}, {chain:'robinhood',wallet_stats},
    {notification_id:'wrong',wallet_stats},{channel_id:83,wallet_stats}, {wallet_stats,profit:{
      buy_volume:'1e200',buy_amount:'1'.repeat(101),realized_profit:'NaN',unrealized_profit:'-1.5'}}];
  const result=await fetchDebotWalletDetails(observation,{now:()=>now,fetcher:async()=>Response.json({code:0,data:rows})});
  assert.equal(result.rejected,4);assert.equal(result.vendorWallets.length,1);
  assert.deepEqual(result.vendorWallets[0].profit,{unrealizedProfitUsd:'-1.5'});
  assert.equal(result.vendorWallets[0].address,other);
  const bounded=await fetchDebotWalletDetails(observation,{now:()=>now,fetcher:async()=>Response.json({code:0,
    data:Array.from({length:30},()=>({wallet_stats}))})});
  assert.equal(bounded.vendorWallets.length,20);assert.equal(bounded.received,30);assert.equal(bounded.rejected,10);
});

test('详情认证失败、限流与错误结构不匿名重试，也不生成已验证交易事件',async()=>{
  const observation=normalizeDebotSignals(sample(),'bsc',now).observations[0];
  for(const status of [401,403,429]) {
    let calls=0;
    await assert.rejects(fetchDebotWalletDetails(observation,{now:()=>now,fetcher:async()=>{
      calls++;return new Response('private error',{status});
    }}),(error:unknown)=>error instanceof DebotSignalError&&error.reason===`DEBOT_SIGNAL_HTTP_${status}`);
    assert.equal(calls,1);
  }
  const result=await fetchDebotWalletDetails(observation,{now:()=>now,fetcher:async()=>Response.json({code:102,data:[]})});
  assert.equal(result.reason,'DEBOT_SIGNAL_RESPONSE_INVALID');assert.deepEqual(result.vendorWallets,[]);
});

test('登录客户端的认证与限流错误跨列表和详情适配保留分类及冷却，不能退化成普通网络失败',async()=>{
  const observation=normalizeDebotSignals(sample(),'bsc',now).observations[0],until=now.getTime()+180_000;
  const cases=[['DEBOT_SESSION_AUTH_REQUIRED','DEBOT_SIGNAL_HTTP_401'],
    ['DEBOT_SESSION_RATE_LIMITED','DEBOT_SIGNAL_HTTP_429'],['DEBOT_SESSION_REQUEST_TIMEOUT','DEBOT_SIGNAL_REQUEST_TIMEOUT'],
    ['DEBOT_SESSION_RESPONSE_TOO_LARGE','DEBOT_SIGNAL_RESPONSE_TOO_LARGE'],
    ['DEBOT_SESSION_RESPONSE_INVALID','DEBOT_SIGNAL_RESPONSE_INVALID']] as const;
  for(const [source,target] of cases) {
    let calls=0;const fetcher=async()=>{calls++;throw new DebotSessionError(source,source==='DEBOT_SESSION_RATE_LIMITED'?until:undefined);};
    for(const operation of [()=>fetchDebotSignalPage('bsc',{fetcher}),()=>fetchDebotWalletDetails(observation,{fetcher})]) {
      await assert.rejects(operation(),(error:unknown)=>{
        assert.ok(error instanceof DebotSignalError);assert.equal(error.reason,target);
        assert.equal(error.cooldownUntil,source==='DEBOT_SESSION_RATE_LIMITED'?until:undefined);return true;
      });
    }
    assert.equal(calls,2);
  }
});
