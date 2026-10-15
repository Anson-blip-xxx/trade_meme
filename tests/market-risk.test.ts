import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {assessMarketRisk} from '../src/market-risk.js';
import type {GmgnTokenSnapshot} from '../src/providers/gmgn-safety.js';
import type {Signal} from '../src/types.js';

const now=new Date('2026-10-15T02:00:00.000Z');
const token=`0x${'1'.repeat(40)}`,poolAddress=`0x${'2'.repeat(40)}`,quote=`0x${'3'.repeat(40)}`;
const signal:Signal={source:'debot',sourceEventId:'test',occurredAt:now.toISOString(),token:{chain:'bsc',address:token},text:'',evidenceUrls:[],claim:'unspecified'};
function snapshot():GmgnTokenSnapshot{return {token:signal.token,fetchedAt:new Date(now.getTime()-1000).toISOString(),
  info:{address:token,price:{address:token,price:'0.000002'},liquidity:'10000',
    pool:{address:token,base_address:token,pool_address:poolAddress,quote_address:quote,liquidity:'10000',exchange:'pancakeswap'}},
  pool:{address:token,base_address:token,quote_address:quote,liquidity:'10010',price:'0.0000021',exchange:'pancakeswap'},
  diagnostics:[{section:'info',status:'ok'},{section:'pool',status:'ok'}]};}
const run=(value=snapshot(),policy={})=>assessMarketRisk(signal,value,now,policy);
const info=(s:GmgnTokenSnapshot)=>s.info as any;
const pool=(s:GmgnTokenSnapshot)=>s.pool as any;
function security(s:GmgnTokenSnapshot,fields:Record<string,unknown>={}){
  s.security={address:token,is_honeypot:false,open_source:true,owner_renounced:true,buy_tax:0,sell_tax:0,...fields};
  s.diagnostics.push({section:'security',status:'ok'});return s;
}

test('fresh explicitly identified pool passes the limited market-data scope, using the lower observed USD liquidity',()=>{
  const result=run();assert.equal(result.status,'pass');
  assert.equal(result.checkedAt,snapshot().fetchedAt);
  assert.equal(result.facts.sellabilityVerified,false);assert.equal(result.facts.executionVerified,false);
  assert.equal(result.facts.scope,'reported_pool_liquidity_and_market_data');
  assert.equal((result.facts.normalized as any).minimumObservedLiquidityUsd,10000);
  assert.deepEqual((result.facts.normalized as any).priceRangeUsd,{minimum:0.000002,maximum:0.0000021});
});

test('live pool.address token alias is not mistaken for the AMM pool address',()=>{
  const s=snapshot();info(s).biggest_pool_address=poolAddress;pool(s).pool_address=poolAddress;
  assert.equal(run(s).status,'pass');
  pool(s).address=`0x${'4'.repeat(40)}`;
  // The ambiguous address field is never used to certify either pool or token identity.
  assert.equal(run(s).status,'pass');
  delete info(s).pool.pool_address;delete info(s).biggest_pool_address;delete pool(s).pool_address;
  assert.equal(run(s).status,'unknown');
});

test('actual Pump AMM shape remains valid even when launchpad_status says 1',()=>{
  const mint=bs58.encode(Buffer.alloc(32,7)),state=bs58.encode(Buffer.alloc(32,8)),wsol='So11111111111111111111111111111111111111112';
  const sol:Signal={...signal,token:{chain:'solana',address:mint}};
  const s:GmgnTokenSnapshot={token:sol.token,fetchedAt:now.toISOString(),
    info:{address:mint,price:{address:mint,price:'0.000017319023'},liquidity:'7637.1178723308',launchpad:'pump',launchpad_status:1,
      pool:{address:mint,base_address:mint,pool_address:state,quote_address:wsol,liquidity:'7637.1178723308',exchange:'pump_amm'}},
    pool:{address:mint,base_address:mint,quote_address:wsol,liquidity:'7905.59980071064',exchange:'pump_amm'},
    diagnostics:[{section:'info',status:'ok'},{section:'pool',status:'ok'}]};
  assert.equal(assessMarketRisk(sol,s,now).status,'pass');
  info(s).launchpad_status=0;
  assert.equal(assessMarketRisk(sol,s,now).status,'pass');
});

test('missing curve AMM fields remain unknown rather than a fabricated rug rejection',()=>{
  const s=snapshot();delete s.pool;delete info(s).pool;info(s).launchpad='four';info(s).launchpad_status=1;
  const result=run(s);assert.equal(result.status,'unknown');
  assert.ok(result.reasons.includes('MARKET_CURVE_POOL_UNVERIFIED'));
});

test('missing snapshots and wrong top-level CA or chain never pass',()=>{
  assert.equal(assessMarketRisk(signal,undefined,now).status,'unknown');
  for(const identity of [{chain:'robinhood',address:token},{chain:'bsc',address:quote}]){
    const s=snapshot();s.token=identity as Signal['token'];assert.equal(run(s).status,'unknown');
  }
});

test('info, nested price, pool and security are independently bound to the full token and chain',()=>{
  const mutations=[
    (s:GmgnTokenSnapshot)=>{info(s).address=quote;},(s:GmgnTokenSnapshot)=>{info(s).chain='solana';},
    (s:GmgnTokenSnapshot)=>{info(s).price.address=quote;},(s:GmgnTokenSnapshot)=>{info(s).price.chain='robinhood';},
    (s:GmgnTokenSnapshot)=>{pool(s).base_address=quote;},(s:GmgnTokenSnapshot)=>{pool(s).chain='robinhood';},
    (s:GmgnTokenSnapshot)=>{info(s).pool.base_address=quote;},
    (s:GmgnTokenSnapshot)=>{security(s,{address:quote,is_honeypot:true});},
    (s:GmgnTokenSnapshot)=>{security(s,{chain:'robinhood'});},
  ];
  for(const mutate of mutations){const s=snapshot();mutate(s);assert.equal(run(s).status,'unknown');}
});

test('missing scope fields or unavailable section diagnostics cannot be silently accepted',()=>{
  const mutations=[(s:GmgnTokenSnapshot)=>{delete info(s).address;},(s:GmgnTokenSnapshot)=>{delete pool(s).base_address;},
    (s:GmgnTokenSnapshot)=>{s.diagnostics=[];},
    (s:GmgnTokenSnapshot)=>{s.diagnostics.push({section:'pool',status:'unavailable',reason:'GMGN_TOKEN_MISMATCH'});},
    (s:GmgnTokenSnapshot)=>{security(s);s.diagnostics.push({section:'security',status:'unavailable'});}];
  for(const mutate of mutations){const s=snapshot();mutate(s);assert.equal(run(s).status,'unknown');}
});

test('stale, invalid and future collection times are unknown and do not refresh old evidence',()=>{
  for(const fetchedAt of ['bad',new Date(now.getTime()-120001).toISOString(),new Date(now.getTime()+1).toISOString()]){
    const s=snapshot();s.fetchedAt=fetchedAt;assert.equal(run(s).status,'unknown');
  }
  const s=snapshot();s.fetchedAt=new Date(now.getTime()-120000).toISOString();assert.equal(run(s).status,'pass');
  assert.equal(run(s,{maxAgeSec:60}).status,'unknown');
});

test('explicit zero USD liquidity blocks and positive native token reserves cannot replace it',()=>{
  const s=snapshot();info(s).liquidity='0';info(s).pool.liquidity=0;pool(s).liquidity='0';pool(s).quote_reserve='99999';
  const result=run(s);assert.equal(result.status,'fail');assert.ok(result.reasons.includes('MARKET_LIQUIDITY_ZERO'));
});

test('liquidity minimum is configurable in USD; default imposes no arbitrary dollar cutoff',()=>{
  const s=snapshot();info(s).liquidity='0.001';info(s).pool.liquidity='0.001';pool(s).liquidity='0.001';
  assert.equal(run(s).status,'pass');assert.equal(run(s,{minLiquidityUsd:0.001}).status,'pass');
  assert.ok(run(s,{minLiquidityUsd:0.01}).reasons.includes('MARKET_LIQUIDITY_BELOW_POLICY'));
});

test('zero vs positive liquidity or prices conflict and cannot be accepted from the convenient field',()=>{
  for(const mutate of [(s:GmgnTokenSnapshot)=>{pool(s).liquidity='0';},(s:GmgnTokenSnapshot)=>{pool(s).price=0;}]){
    const s=snapshot();mutate(s);const result=run(s);assert.equal(result.status,'unknown');assert.deepEqual(result.reasons,['MARKET_DATA_CONFLICT']);
  }
});

test('pool and quote identity aliases must agree',()=>{
  const a=snapshot();pool(a).pool_address=quote;assert.deepEqual(run(a).reasons,['MARKET_DATA_CONFLICT']);
  const b=snapshot();pool(b).quote_address=poolAddress;assert.deepEqual(run(b).reasons,['MARKET_DATA_CONFLICT']);
});

test('zero pool address and same-token pair are explicit market failures',()=>{
  const s=snapshot();info(s).pool.pool_address=`0x${'0'.repeat(40)}`;
  assert.ok(run(s).reasons.includes('MARKET_POOL_ADDRESS_ZERO'));
  const pair=snapshot();info(pair).pool.quote_address=token;pool(pair).quote_address=token;
  assert.ok(run(pair).reasons.includes('MARKET_POOL_TOKEN_PAIR_INVALID'));
});

test('invalid or empty numbers, absent positive price and absent quote metadata remain unknown',()=>{
  const changes=[(s:GmgnTokenSnapshot)=>{info(s).liquidity=true;},(s:GmgnTokenSnapshot)=>{info(s).liquidity='';},
    (s:GmgnTokenSnapshot)=>{pool(s).liquidity='1e1000';},(s:GmgnTokenSnapshot)=>{pool(s).liquidity=-1;},
    (s:GmgnTokenSnapshot)=>{delete info(s).price;delete pool(s).price;},
    (s:GmgnTokenSnapshot)=>{info(s).price.price=0;pool(s).price=0;},
    (s:GmgnTokenSnapshot)=>{delete info(s).pool.quote_address;delete pool(s).quote_address;}];
  for(const change of changes){const s=snapshot();change(s);assert.equal(run(s).status,'unknown');}
});

test('fresh matching technical danger vetoes even when market fields are incomplete',()=>{
  for(const fields of [{is_honeypot:true},{is_honeypot:false,honeypot:true},{buy_tax:0.5},{sell_tax:0.5}]){
    const s=security(snapshot(),fields);delete s.pool;const result=run(s);assert.equal(result.status,'fail');
    assert.ok(result.reasons.some(r=>r.startsWith('GMGN_')));
  }
});

test('missing supplemental security does not pretend to replace the separate technical safety gate',()=>{
  assert.equal(run().status,'pass');
  const s=security(snapshot(),{is_honeypot:undefined});assert.equal(run(s).status,'pass');
  assert.equal((run(s).facts.supplementalSafety as any).status,'unknown');
});

test('documented holder, insider and bundled volume ratios retain distinct units and do not alone allege a scam',()=>{
  const s=security(snapshot(),{top_10_holder_rate:0.99,dev_team_hold_rate:0.8,suspected_insider_hold_rate:0.9,
    bundler_trader_amount_rate:0.99,rat_trader_amount_rate:0.7,rug_ratio:1,is_wash_trading:true});
  const result=run(s);assert.equal(result.status,'pass');
  const observations=result.facts.riskObservations as any;
  assert.equal(observations.top10HolderRate.unit,'supply_ratio');assert.equal(observations.insiderHoldRate.unit,'supply_ratio');
  assert.equal(observations.bundlerVolumeRate.unit,'volume_ratio');assert.equal(observations.rugScore.unit,'vendor_model_score');
  assert.equal(result.facts.concentrationExcludesPools,false);
  assert.ok((result.facts.warnings as string[]).includes('MARKET_WASH_TRADING_REPORTED'));
});

test('optional risk caps use the conservative observed ratio and require the corresponding data',()=>{
  const s=security(snapshot(),{dev_team_hold_rate:0.2,suspected_insider_hold_rate:0.3,bundler_trader_amount_rate:0.4});
  info(s).stat={dev_team_hold_rate:0.25};
  assert.equal(run(s,{maxDevTeamHoldRate:0.3,maxInsiderHoldRate:0.4,maxBundlerVolumeRate:0.5}).status,'pass');
  assert.equal(run(s,{maxDevTeamHoldRate:0.2}).status,'fail');
  assert.equal(run(s,{maxInsiderHoldRate:0.2}).status,'fail');
  assert.equal(run(s,{maxBundlerVolumeRate:0.3}).status,'fail');
  assert.equal(run(snapshot(),{maxDevTeamHoldRate:0.3}).status,'unknown');
});

test('unknown units and malformed risk flags are not normalized into reassuring zeros',()=>{
  for(const fields of [{top_10_holder_rate:'99%'},{bundler_trader_amount_rate:80},{is_wash_trading:'false'},{rug_ratio:true}])
    assert.equal(run(security(snapshot(),fields)).status,'unknown');
});

test('policy errors fail closed',()=>{
  for(const policy of [{minLiquidityUsd:-1},{minLiquidityUsd:NaN},{maxAgeSec:121},{maxAgeSec:0},{maxTaxRate:NaN},
    {maxDevTeamHoldRate:2},{maxInsiderHoldRate:-1},{maxBundlerVolumeRate:NaN}])
    assert.deepEqual(run(snapshot(),policy).reasons,['MARKET_RISK_POLICY_INVALID']);
});
