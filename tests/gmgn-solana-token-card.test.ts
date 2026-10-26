import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {normalizeGmgnSolanaTokenCard,type GmgnSolanaTokenCardInput} from '../src/providers/gmgn-solana-token-card.js';

const mint=(value:number)=>bs58.encode(new Uint8Array(32).fill(value));
const TOKEN=mint(1),POOL=mint(2),QUOTE=mint(3);
const wallet=(value:number)=>mint(value+10);
const AT='2026-10-26T04:00:00.000Z';

function input():GmgnSolanaTokenCardInput {
  return {token:{chain:'solana',address:TOKEN},fetchedAt:AT,
    info:{address:TOKEN,chain:'sol',name:'ハッチャン',symbol:'Hatchan',decimals:6,circulating_supply:'1000000000',
      price:{address:TOKEN,chain:'sol',price:'0.00001230'},liquidity:'4700.50',holder_count:321,
      creation_timestamp:'1792983600',open_timestamp:1792983660,biggest_pool_address:POOL,
      launchpad:'pump',launchpad_status:2,launchpad_progress:'0.934',
      pool:{base_address:TOKEN,pool_address:POOL,quote_address:QUOTE,quote_symbol:'WSOL',exchange:'pump_amm',liquidity:'999999',
        base_reserve_value:'2350.1',quote_reserve_value:'2349.9'},
      stat:{holder_count:'321',top_10_holder_rate:'0.2187',creator_hold_rate:'0.01',dev_team_hold_rate:'0.02',
        top_rat_trader_percentage:'0.3292',top_bundler_trader_percentage:'0.04',top_entrapment_trader_percentage:'0.01',
        private_vault_hold_rate:'0.005',top70_sniper_hold_rate:'0.03'}},
    security:{address:TOKEN,chain:'solana',renounced_mint:true,renounced_freeze_account:1,burn_status:'burn',burn_ratio:'1',
      buy_tax:'0',sell_tax:'0',top_10_holder_rate:'0.2187',creator_balance_rate:'0.01',dev_team_hold_rate:'0.02',
      suspected_insider_hold_rate:'0.05',rat_trader_amount_rate:'0.3292',bundler_trader_amount_rate:'0.04'},
    pool:{base_address:TOKEN,chain:'sol',pool_address:POOL,quote_address:QUOTE,exchange:'pump_amm',
      liquidity:'4699.75',creation_timestamp:1792983660},
    topHolders:{chain:'sol',address:TOKEN,data:{list:Array.from({length:7},(_,index)=>({address:wallet(index),
      amount_percentage:String((7-index)/100),addr_type:index===0?2:0,private_label:'RAW_HOLDER_SECRET'}))}}};
}
const run=(value=input())=>normalizeGmgnSolanaTokenCard(value);

test('normalizes a chain-bound GMGN Solana card with exact values and a bounded top five',()=>{
  const result=run();assert.equal(result.ok,true);if(!result.ok)return;
  assert.deepEqual(result.card,{version:1,provider:'gmgn',chain:'solana',address:TOKEN,observedAt:AT,
    token:{name:'ハッチャン',symbol:'Hatchan',decimals:6},
    market:{priceUsd:'0.0000123',circulatingSupply:'1000000000',marketCapUsd:'12300',reportedLiquidityUsd:'4700.5',holderCount:321,
      createdAt:'2026-10-26T03:00:00.000Z',ageSeconds:3600,openedAt:'2026-10-26T03:01:00.000Z',mainPoolAddress:POOL,
      launchpad:'pump',launchpadStatus:'migrated',launchpadProgressPercent:'93.4'},
    pool:{address:POOL,quoteAddress:QUOTE,quoteSymbol:'WSOL',venue:'pump_amm',liquidityUsd:'4700',
      createdAt:'2026-10-26T03:01:00.000Z',ageSeconds:3540},
    safety:{coverage:'available',mintAuthorityRenounced:'yes',freezeAuthorityRenounced:'yes',liquidityBurned:'yes',
      buyTaxPercent:'0',sellTaxPercent:'0'},
    holderRisk:{top10HoldingPercent:'21.87',creatorHoldingPercent:'1',developerTeamHoldingPercent:'2',
      suspectedInsiderHoldingPercent:'5',ratTraderVolumePercent:'32.92',bundlerVolumePercent:'4',
      entrapmentVolumePercent:'1',privateVaultHoldingPercent:'0.5',sniperHoldingPercent:'3'},
    holders:{coverage:'provided',topFive:Array.from({length:5},(_,index)=>({rank:index+1,address:wallet(index+1),
      holdingPercent:String(6-index),kind:'wallet'}))}});
});

test('binds every endpoint and holder request scope to the full Solana address and chain',()=>{
  const other=mint(9);
  const mutations:Array<(value:GmgnSolanaTokenCardInput)=>void>=[
    value=>{(value.token as any).chain='bsc';},value=>{(value.token as any).address=other;},
    value=>{(value.info as any).address=other;},value=>{(value.info as any).chain='bsc';},
    value=>{(value.info as any).price.address=other;},value=>{(value.info as any).price.chain='bsc';},
    value=>{(value.info as any).pool.base_address=other;},value=>{(value.security as any).address=other;},
    value=>{(value.security as any).chain='bsc';},value=>{(value.pool as any).base_address=other;},
    value=>{value.topHolders!.address=other;},value=>{value.topHolders!.chain='bsc';},
  ];
  for(const mutate of mutations){const value=input();mutate(value);const result=run(value);assert.equal(result.ok,false);}
});

test('rejects malformed, unit-ambiguous and conflicting numbers instead of coercing them',()=>{
  const mutations:Array<(value:GmgnSolanaTokenCardInput)=>void>=[
    value=>{(value.info as any).price.price=' 0.1';},value=>{(value.info as any).price.price='01';},
    value=>{(value.info as any).price.price='0';},value=>{(value.info as any).circulating_supply=Number.MAX_SAFE_INTEGER+1;},
    value=>{(value.info as any).launchpad_progress='93.4%';},
    value=>{(value.security as any).top_10_holder_rate='21.87';},
    value=>{(value.security as any).top_10_holder_rate='0.25';},
    value=>{(value.info as any).creation_timestamp=1792983600000;},
    value=>{(value.info as any).launchpad_status=1.5;},
  ];
  for(const mutate of mutations){const value=input();mutate(value);const result=run(value);assert.equal(result.ok,false);}
});

test('keeps the bound card usable but omits a holder count built from drifting GMGN snapshots',()=>{
  const value=input();(value.info as any).holder_count=320;
  const result=run(value);assert.equal(result.ok,true);if(!result.ok)return;
  assert.equal(result.card.address,TOKEN);
  assert.equal(result.card.market.holderCount,undefined);
  assert.equal(result.card.holderRisk.top10HoldingPercent,'21.87');
});

test('derives market cap with exact decimal arithmetic and ignores forged market-cap aliases',()=>{
  const value=input();const info=value.info as any;
  info.price.price='0.00000000000123';info.circulating_supply='1000000000000';
  info.market_cap='999999999999999999';info.price.market_cap='888888888888888888';
  const result=run(value);assert.equal(result.ok,true);if(!result.ok)return;
  assert.equal(result.card.market.marketCapUsd,'1.23');
  assert.ok(!JSON.stringify(result).includes('999999999999999999'));
  assert.ok(!JSON.stringify(result).includes('888888888888888888'));
});

test('does not turn missing security or numeric fields into reassuring zeroes',()=>{
  const value=input();delete value.security;delete value.pool;delete value.topHolders;
  const info=value.info as any;delete info.circulating_supply;delete info.liquidity;delete info.holder_count;
  delete info.stat;delete info.pool;delete info.biggest_pool_address;delete info.launchpad_progress;
  const result=run(value);assert.equal(result.ok,true);if(!result.ok)return;
  assert.deepEqual(result.card.safety,{coverage:'unavailable',mintAuthorityRenounced:'unknown',
    freezeAuthorityRenounced:'unknown',liquidityBurned:'unknown'});
  assert.deepEqual(result.card.holderRisk,{});assert.deepEqual(result.card.holders,{coverage:'unavailable',topFive:[]});
  assert.equal(result.card.market.marketCapUsd,undefined);assert.equal(result.card.pool,undefined);
});

test('returns only whitelisted DTO fields and never forwards descriptions, URLs, labels or provider errors',()=>{
  const marker='RAW_UPSTREAM_SECRET_9f8a';const value=input();const info=value.info as any;
  info.link={description:marker,website:`https://${marker}.invalid`};info.logo=marker;info.raw=marker;
  (value.security as any).provider_message=marker;(value.pool as any).private_note=marker;
  (value.topHolders!.data as any).error=marker;
  const result=run(value);assert.equal(result.ok,true);assert.ok(!JSON.stringify(result).includes(marker));
  const bad=input();(bad.info as any).name=`safe\n${marker}`;const rejected=run(bad);
  assert.deepEqual(rejected,{ok:false,reason:'GMGN_SOL_CARD_TEXT_INVALID'});
  assert.ok(!JSON.stringify(rejected).includes(marker));
});

test('top-holder projection rejects duplicates, wrong order, impossible totals and unscoped data',()=>{
  const changes:Array<(value:GmgnSolanaTokenCardInput)=>void>=[
    value=>{const list=(value.topHolders!.data as any).list;list[1].address=list[0].address;},
    value=>{const list=(value.topHolders!.data as any).list;list[1].amount_percentage='0.5';},
    value=>{(value.topHolders!.data as any).list=[{address:wallet(1),amount_percentage:'0.8'},{address:wallet(2),amount_percentage:'0.3'}];},
    value=>{value.topHolders={chain:'sol',address:TOKEN,data:{list:[{address:'not-a-wallet',amount_percentage:'0.1'}]}};},
    value=>{(value.topHolders!.data as any).address=mint(8);},
  ];
  for(const change of changes){const value=input();change(value);assert.equal(run(value).ok,false);}
});

test('unknown venue and launchpad text is omitted instead of leaking arbitrary upstream strings',()=>{
  const marker='RAW_VENDOR_ENUM_SECRET';const value=input();(value.info as any).launchpad=marker;
  (value.pool as any).exchange=marker;(value.info as any).pool.exchange=marker;
  const result=run(value);assert.equal(result.ok,true);if(!result.ok)return;
  assert.equal(result.card.market.launchpad,undefined);assert.equal(result.card.pool?.venue,undefined);
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('pool reserve USD sum wins, incomplete reserve pairs fall back, and malformed reserve numbers reject',()=>{
  const complete=run();assert.equal(complete.ok,true);if(complete.ok)assert.equal(complete.card.pool?.liquidityUsd,'4700');
  const fallback=input();delete (fallback.info as any).pool.quote_reserve_value;
  const fallbackResult=run(fallback);assert.equal(fallbackResult.ok,true);
  if(fallbackResult.ok)assert.equal(fallbackResult.card.pool?.liquidityUsd,'4699.75');
  const malformed=input();(malformed.info as any).pool.base_reserve_value='USD 2350';
  assert.deepEqual(run(malformed),{ok:false,reason:'GMGN_SOL_CARD_NUMBER_INVALID'});
});

test('known launchpad_platform values are normalized, while contradictory platform evidence rejects',()=>{
  const platform=input();delete (platform.info as any).launchpad;(platform.info as any).launchpad_platform='pumpfun';
  const result=run(platform);assert.equal(result.ok,true);if(result.ok)assert.equal(result.card.market.launchpad,'pump');
  const conflict=input();(conflict.info as any).launchpad_platform='moonshot';
  assert.deepEqual(run(conflict),{ok:false,reason:'GMGN_SOL_CARD_INPUT_INVALID'});
});

test('burn state needs a full burn ratio and remains unknown on an unmigrated Pump curve',()=>{
  const missing=input();delete (missing.security as any).burn_ratio;
  const missingResult=run(missing);assert.equal(missingResult.ok,true);
  if(missingResult.ok)assert.equal(missingResult.card.safety.liquidityBurned,'unknown');
  const partial=input();(partial.security as any).burn_ratio='0.99';
  const partialResult=run(partial);assert.equal(partialResult.ok,true);
  if(partialResult.ok)assert.equal(partialResult.card.safety.liquidityBurned,'no');
  const curve=input();(curve.info as any).launchpad_status=1;
  const curveResult=run(curve);assert.equal(curveResult.ok,true);
  if(curveResult.ok)assert.equal(curveResult.card.safety.liquidityBurned,'unknown');
});

test('top five excludes classified pools and exact Solana burn accounts before reranking',()=>{
  const value=input();const list=(value.topHolders!.data as any).list;
  list[1].address='1nc1nerator11111111111111111111111111111111';
  const result=run(value);assert.equal(result.ok,true);if(!result.ok)return;
  assert.equal(result.card.holders.topFive.length,5);
  assert.deepEqual(result.card.holders.topFive.map(row=>row.rank),[1,2,3,4,5]);
  assert.ok(result.card.holders.topFive.every(row=>row.kind!=='pool'&&!row.address.startsWith('1nc1nerator')));
  assert.deepEqual(result.card.holders.topFive.map(row=>row.holdingPercent),['5','4','3','2','1']);
});

test('holder input is already-unwrapped endpoint data, never the outer GMGN envelope',()=>{
  const value=input();value.topHolders!.data={code:0,data:value.topHolders!.data};
  assert.deepEqual(run(value),{ok:false,reason:'GMGN_SOL_CARD_HOLDERS_INVALID'});
});
