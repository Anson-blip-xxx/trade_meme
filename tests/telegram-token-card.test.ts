import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {GmgnError} from '../src/providers/gmgn-client.js';
import {TelegramTokenCardService} from '../src/telegram-token-card.js';

const address=(value:number)=>bs58.encode(new Uint8Array(32).fill(value));
const TOKEN=address(31),POOL=address(32),QUOTE=address(33),WALLET=address(34);
const info=()=>({address:TOKEN,chain:'sol',name:'Save Bow',symbol:'Bow',decimals:6,circulating_supply:'1000000000',holder_count:23,
  creation_timestamp:1792980367,launchpad:'pump',launchpad_status:1,launchpad_progress:'0.3373344',
  price:{address:TOKEN,chain:'sol',price:'0.0000051258066'},biggest_pool_address:POOL,
  pool:{base_address:TOKEN,pool_address:POOL,quote_address:QUOTE,quote_symbol:'WSOL',exchange:'pump_amm',
    base_reserve_value:'3754.448699',quote_reserve_value:'1004.797424'},
  stat:{top_10_holder_rate:'0.23',top_bundler_trader_percentage:'0.0771',top_rat_trader_percentage:'0'}});
const security=()=>({address:TOKEN,chain:'sol',renounced_mint:true,renounced_freeze_account:true,burn_status:'burn',burn_ratio:'1'});
const holders=()=>({list:[
  {address:POOL,amount_percentage:'0.73246',balance:'732460000',addr_type:2},
  ...['0.031','0.0277','0.0265','0.0264','0.0251','0.01'].map((amount,index)=>({address:address(40+index),amount_percentage:amount,balance:'100',addr_type:0})),
]});

interface TestTokenPosition {
  amountAtomic:string;
  decimals:number;
  sellQuote?:{inputAmount:string;outputAmount:string;quotedAt:string;expiresAt:string};
  costBasis?:{solLamports:string;tokenAtoms:string;excludesNetworkFees:true};
}

function setup(overrides:Partial<Record<'info'|'security'|'holders',unknown>>={},includeHolders?:()=>boolean,
  tokenPosition:TestTokenPosition|false={amountAtomic:'123450000',decimals:6}){
  const calls:Array<{path:string;query:Record<string,string|number>;weight?:number}>=[];
  const client={async get(path:string,query:Record<string,string|number>,weight?:number){
    calls.push({path,query,weight});
    const key=path.endsWith('/info')?'info':path.endsWith('/security')?'security':'holders';
    const defaults={info:info(),security:security(),holders:holders()};
    const result=Object.hasOwn(overrides,key)?overrides[key as keyof typeof overrides]:defaults[key as keyof typeof defaults];
    if(result instanceof Error)throw result;return result;
  }};
  const service=new TelegramTokenCardService({client,wallet:WALLET,
    ...(includeHolders?{includeHolders}:{}),
    readBalance:async()=>({status:'verified',amount:'5350000000',checkedAt:new Date().toISOString(),readStartedAt:new Date().toISOString(),reasons:[]}),
    position:mint=>mint===TOKEN&&tokenPosition?tokenPosition:undefined,
    now:()=>new Date('2026-10-26T04:00:00.000Z')});
  return {service,calls};
}

test('live entry priority skips only the weighted holder list and marks Top5 unknown',async()=>{
  const {service,calls}=setup({},()=>false);const result=await service.get(TOKEN);
  assert.equal(result.gmgnAvailable,true);assert.equal(result.partial,true);
  assert.deepEqual(calls.map(call=>[call.path,call.weight]),[
    ['/v1/token/info',1],['/v1/token/security',1],
  ]);
  assert.match(result.text,/Top5 钱包持仓：未取得/);assert.match(result.text,/部分 GMGN 数据暂未返回/);
});

test('renders a compact GMGN card with grouped market, account and safety facts',async()=>{
  const {service,calls}=setup();const result=await service.get(TOKEN);
  assert.equal(result.gmgnAvailable,true);assert.equal(result.partial,false);
  assert.equal(result.text,[`【合约详情】Save Bow / Bow · Solana`,`CA：${TOKEN}`,'',
    '💼 账户','SOL 余额：5.35 SOL ｜ 本币持仓：123.45 Bow','持仓盈亏：暂不可用（报价待核验）','',
    '📊 行情','价格：$0.0000051258066','估算市值：$5.13K ｜ 池子储备：$4.76K（市值占比 92.85%）',
    '持有人：23 ｜ 币龄：1 小时','内盘进度：33.73%','',
    '🛡 安全','权限：铸币 ✅ 已放弃 ｜ 冻结 ✅ 已放弃','流动性：曲线阶段',
    'Top10 持仓：23.00% ｜ 捆绑：7.71% ｜ 老鼠仓：0.00%',
    'Top5 钱包持仓：3.10% · 2.77% · 2.65% · 2.64% · 2.51%'].join('\n'));
  assert.ok(!result.text.includes('73.246%'));assert.ok(!result.text.includes(WALLET));
  assert.doesNotMatch(result.text,/https:\/\//);assert.doesNotMatch(result.text,/钱包：/);
  assert.deepEqual(calls.map(call=>[call.path,call.weight]),[
    ['/v1/token/info',1],['/v1/token/security',1],['/v1/market/token_top_holders',5],
  ]);
  assert.deepEqual(calls[2].query,{chain:'sol',address:TOKEN,limit:10,order_by:'amount_percentage',direction:'desc'});
});

test('renders executable native position PnL only from a fresh exact-balance sell quote',async()=>{
  const basis={solLamports:'10000000',tokenAtoms:'123450000',excludesNetworkFees:true as const};
  const fresh={inputAmount:'123450000',outputAmount:'11914000',quotedAt:'2026-10-26T03:59:59.000Z',
    expiresAt:'2026-10-26T04:00:01.000Z'};
  const {service}=setup({},undefined,{amountAtomic:'123450000',decimals:6,costBasis:basis,sellQuote:fresh});
  const result=await service.get(TOKEN);
  assert.match(result.text,/本币持仓：123\.45 Bow/);
  assert.match(result.text,/持仓盈亏：\+19\.14%/);

  for(const sellQuote of [
    {...fresh,inputAmount:'123449999'},
    {...fresh,expiresAt:'2026-10-26T04:00:00.000Z'},
  ]){
    const unknown=await setup({},undefined,{amountAtomic:'123450000',decimals:6,costBasis:basis,sellQuote}).service.get(TOKEN);
    assert.match(unknown.text,/持仓盈亏：暂不可用/);
    assert.doesNotMatch(unknown.text,/持仓盈亏：[+-]\d/);
  }
});

test('does not show position or PnL fields when the wallet has no holding for the mint',async()=>{
  const result=await setup({},undefined,false).service.get(TOKEN);
  assert.doesNotMatch(result.text,/本币持仓|持仓盈亏/);
});

test('GMGN info fallback keeps native holding amount and executable PnL visible',async()=>{
  const result=await setup({info:new GmgnError('GMGN_RATE_LIMITED')},undefined,{
    amountAtomic:'123450000',decimals:6,
    costBasis:{solLamports:'10000000',tokenAtoms:'123450000',excludesNetworkFees:true},
    sellQuote:{inputAmount:'123450000',outputAmount:'11914000',quotedAt:'2026-10-26T03:59:59.000Z',
      expiresAt:'2026-10-26T04:00:01.000Z'},
  }).service.get(TOKEN);
  assert.equal(result.gmgnAvailable,false);
  assert.match(result.text,/GMGN 详情暂未返回/);
  assert.match(result.text,/本币持仓：123\.45/);
  assert.match(result.text,/持仓盈亏：\+19\.14%/);
});

test('partial endpoint failures preserve verified info and mark unknown fields',async()=>{
  const {service}=setup({security:new GmgnError('GMGN_RATE_LIMITED'),holders:new GmgnError('GMGN_RATE_LIMITED')});
  const result=await service.get(TOKEN);assert.equal(result.gmgnAvailable,true);assert.equal(result.partial,true);
  assert.match(result.text,/权限：铸币 未取得 ｜ 冻结 未取得/);assert.match(result.text,/Top5 钱包持仓：未取得/);
  assert.match(result.text,/部分 GMGN 数据暂未返回/);assert.match(result.text,/估算市值：\$5\.13K/);
});

test('an unavailable or identity-invalid info response produces a bounded read-only fallback',async()=>{
  const sources=[new GmgnError('GMGN_RATE_LIMITED'),{...info(),address:address(80)},{...info(),name:'forged\nname'}];
  for(const [index,source] of sources.entries()){
    const {service}=setup({info:source},undefined,false);const result=await service.get(TOKEN);
    assert.equal(result.gmgnAvailable,false);assert.equal(result.partial,true);
    assert.match(result.text,/⚠️ GMGN 详情暂未返回/);assert.match(result.text,/可点击刷新重试/);
    assert.ok(!result.text.includes('forged\nname'));assert.ok(!result.text.includes(WALLET));
    assert.doesNotMatch(result.text,/https:\/\//);assert.ok(result.text.length<4096);
    if(index===0)assert.equal(result.text,[`【合约详情】Solana`,`CA：${TOKEN}`,'',
      '💼 SOL 余额：5.35 SOL','','⚠️ GMGN 详情暂未返回','状态码：GMGN_RATE_LIMITED','可点击刷新重试。'].join('\n'));
  }
});

test('omits launch progress after a launchpad token has migrated',async()=>{
  const {service}=setup({info:{...info(),launchpad_status:2}});const result=await service.get(TOKEN);
  assert.equal(result.gmgnAvailable,true);assert.doesNotMatch(result.text,/内盘进度/);
  assert.match(result.text,/流动性：✅ 已燃烧/);
});

test('coalesces concurrent reads, caches briefly and a refresh bypasses that cache',async()=>{
  const {service,calls}=setup();
  const [first,second]=await Promise.all([service.get(TOKEN),service.get(TOKEN)]);assert.deepEqual(first,second);assert.equal(calls.length,3);
  await service.get(TOKEN);assert.equal(calls.length,3);
  await service.get(TOKEN,true);assert.equal(calls.length,6);
});

test('rejects noncanonical mints and native/system program identifiers before any request',async()=>{
  const {service,calls}=setup();
  for(const value of ['not-a-ca','So11111111111111111111111111111111111111112','11111111111111111111111111111111'])
    await assert.rejects(service.get(value),/TELEGRAM_TOKEN_CARD_ADDRESS_INVALID/);
  assert.equal(calls.length,0);
});
