import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMeme,normalizeMemeMarket,normalizeDexMemeMarket,type MemeMarketSample,type MemeCatalystSnapshot} from '../src/meme-assessment.js';
import type {FollowupWalletEvidence} from '../src/wallet-history.js';

const origin=Date.parse('2026-10-16T08:00:00.000Z'),date=(sec=0)=>new Date(origin+sec*1000),at=(sec=0)=>date(sec).toISOString();
const address=(n=1)=>`0x${n.toString(16).padStart(40,'0')}`,tx=(n=1)=>`0x${n.toString(16).padStart(64,'0')}`;
const token={chain:'bsc' as const,address:address()},pool=address(50);
function sample(sec=0,overrides:Partial<MemeMarketSample>={}):MemeMarketSample {
  return {version:1,token,source:'gmgn_token_info',observedAt:at(sec),priceUsd:1,liquidityUsd:50_000,holderCount:100,
    top10HolderRate:0.2,poolAddress:pool,windows:{'1m':{buys:30,sells:10,buyVolumeUsd:8000,sellVolumeUsd:2000,volumeUsd:10_000},
      '5m':{buys:70,sells:30,buyVolumeUsd:16000,sellVolumeUsd:10000,volumeUsd:26_000}},...overrides};
}
function evidence(sec=60,side:'buy'|'sell'='buy',count=5):FollowupWalletEvidence {
  return {chain:token.chain,address:token.address,fromAt:at(sec-120),untilAt:at(sec),coverage:'sampled',trades:Array.from({length:count},(_,i)=>({
    evidenceId:`e${i}`,txHash:tx(i+1),wallet:address(i+5),side,volumeUsd:1000,eventAt:at(sec-10),observedAt:at(sec-5),source:'gmgn'})),
    buyUsd:9e10,sellUsd:9e10,netBuyUsd:9e10,buyerCount:10000,sellerCount:10000,evidenceCount:count,excludedCount:0,limitations:[]};
}
function catalyst(sec=60):MemeCatalystSnapshot {
  return {token,observedAt:at(sec),expiresAt:at(sec+600),status:'partial',reasons:[],sourceTweetCount:100,
    posts:[1,2,3].map(i=>({id:`x:${i}`,url:`https://x.com/i/web/status/${i}`,text:`Token ${token.address} ${i}`,authorId:String(i),publishedAt:at(sec-10),fetchedAt:at(sec-1),
      provider:'fxembed',verification:'third_party',authority:'public',mentionsExactCa:true,relation:'ca_mention'})),
    diffusion:{status:'partial',coverage:'sampled',windowStart:at(sec-600),windowEnd:at(sec),postCount:100,independentAuthorCount:100,caPostCount:100,caAuthorCount:100,
      recent5m:{postCount:100,authorCount:100},previous5m:{postCount:0,authorCount:0}},
    celebrities:{status:'unknown',signals:[],endorsementVerified:false,accountIdentityCoverage:'unverified'},
    evidence:{requestedPostCount:12,retrievedPostCount:3,diagnostics:[],narrativeStatus:'unknown',narrativeReasons:[],limitations:[]}};
}

// Actual independent observations, not supplier ATH or the number of repeated signal deliveries.
test('price acceleration and wallet support reverse into fading when sampled sellers take over',()=>{
  const initial=sample(0),high=sample(60,{priceUsd:2,holderCount:120,liquidityUsd:60_000});
  const rising=assessMeme({token,now:date(60),samples:[initial,high],walletEvidence:evidence(),catalyst:catalyst()});
  assert.equal(rising.stage,'accelerating');assert.ok(rising.score!>=65);assert.equal(rising.metrics.sampledGainPct,100);
  assert.equal(rising.metrics.walletBuyUsd,5000);assert.equal(rising.metrics.walletBuyerCount,5); // Never supplier totals.
  const pullback=sample(120,{priceUsd:1.15,holderCount:110,liquidityUsd:40_000,windows:{
    '1m':{buys:5,sells:35,buyVolumeUsd:1000,sellVolumeUsd:9000,volumeUsd:10_000},'5m':{volumeUsd:100_000}}});
  const falling=assessMeme({token,now:date(120),samples:[initial,high,pullback],walletEvidence:evidence(120,'sell'),catalyst:catalyst(120),previous:rising});
  assert.equal(falling.stage,'fading');assert.ok(falling.score!<rising.score!);assert.ok(falling.scoreDelta!<0);
  assert.equal(falling.metrics.sampledDrawdownPct,42.5);assert.ok(falling.reasons.includes('BUY_FLOW_DETERIORATING'));
  assert.ok(falling.changeReasons.includes('STAGE_ACCELERATING_TO_FADING'));assert.ok(falling.changeReasons.includes('WALLET_RELAY_WEAKENED'));
});

test('a repeated identical sample never creates time coverage, heat points, or a second observation',()=>{
  const one=sample();const result=assessMeme({token,now:date(),samples:Array(100).fill(one)});
  assert.equal(result.coverage.samples,1);assert.equal(result.score,null);assert.equal(result.stage,'insufficient');
  const first=sample(),second=sample(60,{priceUsd:1.1,holderCount:102});
  assert.deepEqual(assessMeme({token,now:date(60),samples:[first,second]}),assessMeme({token,now:date(60),samples:[first,second,...Array(80).fill(second)]}));
});

test('stale, future, malformed and cross-chain samples do not become current opportunities',()=>{
  const good=sample(0),last=sample(60);
  for(const samples of [[good,last],[sample(240),sample(300)],[sample(150,{token:{...token,chain:'robinhood'}}),sample(180,{token:{...token,chain:'robinhood'}})],
    [sample(150,{observedAt:'invalid'}),sample(180,{token:{...token,address:address(2)}})]]){
    const result=assessMeme({token,now:date(181),samples});assert.equal(result.score,null);assert.equal(result.stage,'insufficient');
  }
});

test('same-time contradictions fail that observation instead of choosing the most favorable price',()=>{
  const result=assessMeme({token,now:date(60),samples:[sample(),sample(60,{priceUsd:1}),sample(60,{priceUsd:100})]});
  assert.equal(result.coverage.samples,1);assert.equal(result.score,null);assert.ok(result.limitations.includes('CONFLICTING_SAME_TIME_MARKET_SAMPLE'));
});

test('missing quantities remain absent and missing components do not get normalized to 100',()=>{
  const priceOnly=[sample(0,{windows:{},liquidityUsd:undefined,holderCount:undefined}),sample(60,{priceUsd:2,windows:{},liquidityUsd:undefined,holderCount:undefined})];
  const result=assessMeme({token,now:date(60),samples:priceOnly});
  assert.equal(result.score,null);assert.equal(result.coverage.knownPoints,9);assert.equal(result.metrics.walletBuyerCount,undefined);
  assert.equal(result.components.find(c=>c.id==='wallet_relay')!.score,null);assert.equal(result.metrics.buys1m,undefined);
  assert.ok(result.limitations.includes('MISSING_DIMENSIONS_ARE_NOT_RENORMALIZED'));
});

test('local 1/5/15-minute coverage requires observed anchors and no sampling gaps',()=>{
  const rows=Array.from({length:16},(_,i)=>sample(i*60,{priceUsd:i+1,holderCount:100+i}));
  const result=assessMeme({token,now:date(900),samples:rows});
  assert.deepEqual(Object.values(result.coverage.windows).map(v=>v.covered),[true,true,true]);
  assert.equal(result.metrics.priceChange15mPct,1500);assert.equal(result.metrics.priceChange5mPct,45.45);
  const sparse=assessMeme({token,now:date(900),samples:[rows[0],rows[15]]});
  assert.equal(sparse.coverage.windows['15m'].covered,false);assert.equal(sparse.metrics.priceChange15mPct,undefined);
  const short=assessMeme({token,now:date(60),samples:rows.slice(0,2)});
  assert.equal(short.coverage.windows['5m'].covered,false);assert.equal(short.metrics.priceChange5mPct,undefined);
});

test('pool migrations and source changes reset comparable price and liquidity history',()=>{
  const migrated=assessMeme({token,now:date(60),samples:[sample(),sample(60,{priceUsd:100,liquidityUsd:1_000_000,poolAddress:address(51)})]});
  assert.equal(migrated.metrics.sampledGainPct,undefined);assert.equal(migrated.metrics.sampledDrawdownPct,undefined);
  assert.equal(migrated.metrics.liquidityChangePct,undefined);assert.equal(migrated.metrics.priceChange1mPct,undefined);
  assert.ok(migrated.limitations.includes('POOL_OR_SOURCE_CHANGE_COMPARISONS_RESET'));
  const sourceChanged=assessMeme({token,now:date(60),samples:[sample(),sample(60,{source:'dexscreener_pair',priceUsd:100})]});
  assert.equal(sourceChanged.metrics.sampledGainPct,undefined);assert.equal(sourceChanged.metrics.liquidityChangePct,undefined);
  const returned=assessMeme({token,now:date(120),samples:[sample(),sample(60,{poolAddress:address(51)}),sample(120,{priceUsd:100})]});
  assert.equal(returned.metrics.priceChange1mPct,undefined);assert.equal(returned.metrics.sampledGainPct,undefined);
});

test('sampled recovery requires an observed peak, trough and rebound',()=>{
  const rows=[sample(0,{priceUsd:1}),sample(30,{priceUsd:2}),sample(60,{priceUsd:1.2}),sample(90,{priceUsd:1.8})];
  const result=assessMeme({token,now:date(90),samples:rows});assert.equal(result.metrics.sampledRecoveryPct,75);
  assert.ok(result.components.find(c=>c.id==='trading_emotion')!.reasons.includes('PULLBACK_RECOVERY_OBSERVED'));
  assert.equal(assessMeme({token,now:date(30),samples:rows.slice(0,2)}).metrics.sampledRecoveryPct,undefined);
});

test('tiny, missing liquidity and extreme concentration cannot produce a strong opportunity display',()=>{
  for(const [liquidity,top,cap,reason] of [[4000,0.1,29,'THIN_LIQUIDITY_SCORE_CAPPED'],[undefined,0.1,39,'LIQUIDITY_UNKNOWN_SCORE_CAPPED'],[100_000,0.9,39,'EXTREME_CONCENTRATION_SCORE_CAPPED']] as const){
    const result=assessMeme({token,now:date(60),samples:[sample(0,{liquidityUsd:liquidity,top10HolderRate:top}),sample(60,{liquidityUsd:liquidity,top10HolderRate:top,holderCount:120,priceUsd:2})],walletEvidence:evidence(),catalyst:catalyst()});
    assert.ok(result.score!==null&&result.score<=cap);assert.ok([...result.reasons,...result.limitations].includes(reason));
  }
});

test('wallet transaction duplicates and cross-source side conflicts cannot manufacture support',()=>{
  const wallet=evidence(),same=wallet.trades[0];wallet.trades=[same,{...same,evidenceId:'copy',source:'another'},{...same,evidenceId:'conflict',side:'sell'}];
  const result=assessMeme({token,now:date(60),samples:[sample(),sample(60)],walletEvidence:wallet});
  assert.equal(result.components.find(c=>c.id==='wallet_relay')!.score,null);assert.equal(result.metrics.walletBuyUsd,undefined);
});

test('wallet evidence binds token, observation cutoff and actual event times',()=>{
  const variants=[{...evidence(),chain:'robinhood' as const},{...evidence(),address:address(9)},
    {...evidence(),untilAt:at(61)}, {...evidence(),trades:evidence().trades.map(t=>({...t,eventAt:at(61)}))},
    {...evidence(),trades:evidence().trades.map(t=>({...t,observedAt:at(61)}))},
    {...evidence(),trades:evidence().trades.map(t=>({...t,eventAt:at(-100)}))},
    {...evidence(),fromAt:at(59)}];
  for(const walletEvidence of variants){const result=assessMeme({token,now:date(60),samples:[sample(),sample(60)],walletEvidence});
    assert.equal(result.components.find(c=>c.id==='wallet_relay')!.score,null);}
});

test('supplier tweet inventories and unchecked summary counts do not become measured social heat',()=>{
  const report=catalyst();report.posts=[];
  const result=assessMeme({token,now:date(60),samples:[sample(),sample(60)],catalyst:report});
  assert.equal(result.components.find(c=>c.id==='catalyst')!.score,null);assert.equal(result.metrics.socialAuthors5m,undefined);
  report.posts=catalyst().posts;const actual=assessMeme({token,now:date(60),samples:[sample(),sample(60)],catalyst:report});
  assert.equal(actual.metrics.socialAuthors5m,3);assert.equal(actual.components.find(c=>c.id==='catalyst')!.score,7);
});

test('real event age decays social evidence; refetch timestamps cannot renew celebrity impact',()=>{
  const report=catalyst();report.celebrities.signals=[{person:'test',kind:'ca_post',weight:1,sourceUrl:report.posts[0].url,verification:'third_party',evidenceId:report.posts[0].id,publishedAt:report.posts[0].publishedAt,relation:'ca_mention'}];
  report.celebrities.accountIdentityCoverage='verified';report.expiresAt=at(2000);
  const early=assessMeme({token,now:date(60),samples:[sample(),sample(60)],catalyst:report});
  const later=assessMeme({token,now:date(960),samples:[sample(900),sample(960)],catalyst:{...report,observedAt:at(960)}});
  assert.ok(early.components.find(c=>c.id==='catalyst')!.score!>later.components.find(c=>c.id==='catalyst')!.score!);
  assert.equal(later.metrics.socialAuthors5m,0);assert.ok(early.limitations.includes('CA_MENTION_IS_NOT_ENDORSEMENT'));
});

test('bound project profile links get only weak research weight and cannot manufacture celebrity support',()=>{
  const report=catalyst();report.posts=[];report.celebrities.signals=[{person:'elon',kind:'profile_link',weight:1,sourceUrl:'https://x.com/elonmusk',verification:'project_link',relation:'project_link'}];
  const linked=assessMeme({token,now:date(60),samples:[sample(),sample(60)],catalyst:report});
  assert.equal(linked.components.find(c=>c.id==='catalyst')!.score,1);assert.equal(linked.components.find(c=>c.id==='catalyst')!.knownPoints,2);assert.ok(linked.limitations.includes('CELEBRITY_PROFILE_LINK_NOT_BACKING'));
  report.celebrities.signals.push({...report.celebrities.signals[0],person:'cz'});
  assert.equal(assessMeme({token,now:date(60),samples:[sample(),sample(60)],catalyst:report}).components.find(c=>c.id==='catalyst')!.score,1);
  for(const bad of [{...catalyst(),token:{...token,chain:'robinhood' as const}},{...catalyst(),observedAt:at(61)},{...catalyst(),expiresAt:at(59)}]){
    assert.equal(assessMeme({token,now:date(60),samples:[sample(),sample(60)],catalyst:bad}).components.find(c=>c.id==='catalyst')!.score,null);
  }
});

test('score deltas are only comparable for the same token, rule and previous as-of time',()=>{
  const base=assessMeme({token,now:date(60),samples:[sample(),sample(60)]});
  for(const previous of [{...base,token:{...token,address:address(2)}},{...base,ruleVersion:'other' as never},{...base,assessedAt:at(61)}]){
    const result=assessMeme({token,now:date(60),samples:[sample(),sample(60)],previous});assert.equal(result.scoreDelta,null);assert.deepEqual(result.changeReasons,[]);
  }
});

test('GMGN normalization requires scoped current nested price and preserves zero versus missing',()=>{
  const raw={address:token.address,chain:'bsc',price:{price:'0.0001',price_1m:'0.00001',buys_1m:'0',sells_1m:1,buy_volume_1m:'0',sell_volume_1m:'1',volume_1m:'1'},
    liquidity:'0',holder_count:0,stat:{top_10_holder_rate:'0'},biggest_pool_address:pool,ath_price:1000};
  const result=normalizeMemeMarket(raw,token,at())!;assert.equal(result.priceUsd,0.0001);assert.equal(result.windows['1m']!.startPriceUsd,0.00001);
  assert.equal(result.windows['1m']!.buys,0);assert.equal(result.liquidityUsd,0);assert.equal(result.holderCount,0);assert.equal(result.top10HolderRate,0);
  for(const price of [{price:1},{price_1m:'1'},{price:'0'},{price:'-1'},{price:'Infinity'},{price:' 1'},{price:'01'}, {price:'1',address:address(2)}, {price:'1',chain:'sol'}])
    assert.equal(normalizeMemeMarket({...raw,price},token,at()),undefined);
  for(const value of [{...raw,address:address(2)},{...raw,chain:'sol'}, {...raw,address:undefined}])assert.equal(normalizeMemeMarket(value,token,at()),undefined);
  const missing=normalizeMemeMarket({...raw,price:{price:'1',buys_1m:-1,sells_1m:'',volume_1m:null},liquidity:null,holder_count:'',stat:{top_10_holder_rate:50},biggest_pool_address:token.address},token,at())!;
  assert.deepEqual(missing.windows,{});assert.equal(missing.liquidityUsd,undefined);assert.equal(missing.poolAddress,undefined);
});

test('DEX normalization uses base-token USD and only documented 5-minute fields, with no fabricated USD flow',()=>{
  const raw={chainId:'bsc',baseToken:{address:token.address},quoteToken:{address:address(2)},pairAddress:pool,priceUsd:'2',liquidity:{usd:50_000},
    txns:{m5:{buys:80,sells:20}},volume:{m5:20_000},priceChange:{m5:999},boosts:{active:300}};
  const result=normalizeDexMemeMarket(raw,token,at())!;assert.equal(result.priceUsd,2);assert.deepEqual(result.windows,{'5m':{buys:80,sells:20,volumeUsd:20_000}});
  assert.equal(result.paidBoostActive,300);assert.equal(result.holderCount,undefined);assert.equal((result.windows['5m'] as {buyVolumeUsd?:number}).buyVolumeUsd,undefined);
  for(const value of [{...raw,chainId:'solana'},{...raw,baseToken:{address:address(2)},quoteToken:{address:token.address}},{...raw,pairAddress:token.address},{...raw,priceUsd:2}])assert.equal(normalizeDexMemeMarket(value,token,at()),undefined);
});

test('DEX observed changes can update the stage while exposing limited measured coverage',()=>{
  const pair=(sec:number,price:string,buys:number,sells:number,volume:number)=>normalizeDexMemeMarket({chainId:'bsc',baseToken:{address:token.address},pairAddress:pool,
    priceUsd:price,liquidity:{usd:50_000},txns:{m5:{buys,sells}},volume:{m5:volume},boosts:{active:10}},token,at(sec))!;
  const initial=pair(0,'1',50,30,10000),high=pair(60,'2',200,30,30000);
  const rising=assessMeme({token,now:date(60),samples:[initial,high]});assert.equal(rising.stage,'accelerating');assert.ok(rising.score!==null);
  assert.equal(rising.metrics.buyShare1m,undefined);assert.equal(rising.coverage.knownPoints,39);assert.equal(rising.metrics.buyCountShare5m,0.87);
  assert.ok(rising.limitations.includes('PAID_BOOST_NOT_ORGANIC_PROPAGATION'));assert.ok(rising.limitations.includes('TRADE_COUNT_IMBALANCE_NOT_DOLLAR_FLOW'));
  const down=pair(120,'1.2',20,100,10000),falling=assessMeme({token,now:date(120),samples:[initial,high,down],previous:rising});
  assert.equal(falling.stage,'fading');assert.ok(falling.score!<rising.score!);
});

test('paid DEX boosts and supplier historical prices never manufacture organic heat or forward returns',()=>{
  const raw=(boost:number)=>({chainId:'bsc',baseToken:{address:token.address},pairAddress:pool,priceUsd:'1',liquidity:{usd:50_000},txns:{m5:{buys:80,sells:20}},volume:{m5:20000},boosts:{active:boost}});
  const runs=[0,1000].map(boost=>assessMeme({token,now:date(60),samples:[normalizeDexMemeMarket(raw(boost),token,at())!,normalizeDexMemeMarket(raw(boost),token,at(60))!]}));
  assert.equal(runs[0].score,runs[1].score);assert.deepEqual(runs[0].components,runs[1].components);
  const historical=sample(0,{windows:{'1m':{startPriceUsd:0.00001},'5m':{startPriceUsd:0.000001}}});
  const result=assessMeme({token,now:date(),samples:[historical]});assert.equal(result.score,null);assert.equal(result.metrics.sampledGainPct,undefined);
  assert.equal(result.metrics.priceChange1mPct,undefined);assert.equal(result.metrics.priceChange5mPct,undefined);
});

test('Solana case-sensitive mint identity and chain aliases are bound before normalization',()=>{
  const sol={chain:'solana' as const,address:'So11111111111111111111111111111111111111112'};
  const raw={address:sol.address,chain:'sol',price:{price:'1'}};
  assert.ok(normalizeMemeMarket(raw,sol,at()));assert.equal(normalizeMemeMarket({...raw,address:sol.address.toLowerCase()},sol,at()),undefined);
  assert.equal(normalizeMemeMarket({...raw,chain:'bsc'},sol,at()),undefined);
});

test('qualified precursor withdrawal changes relay evaluation, while low-quality labels alone do not',()=>{
  const setup={id:'setup',route:'precursor' as const,wallet:address(5),leader:address(8),trigger:{chain:token.chain,wallet:address(5),tokenAddress:token.address,
    txHash:tx(5),side:'buy' as const,eventAt:at(50),observedAt:at(55),usd:'1000',source:'gmgn'},
    status:'supported' as 'supported'|'withdrawn',stage:'public_entry_observed' as const,priorityScore:99,reasons:[],counterEvidence:[],followers:4,ownership:'unknown' as const,
    profit:{realizedProfitUsd:10000,percentile:90,cohortSize:20,observedAt:at(50),verification:'vendor_claim' as const}};
  const report={version:1 as const,token,checkedAt:at(60),validUntil:at(180),status:'supported' as const,priorityScore:99,scope:'research_priority' as const,ownership:'unknown' as const,sampleOnly:true as const,setups:[setup],reasons:[]};
  const initial=assessMeme({token,now:date(60),samples:[sample(),sample(60,{priceUsd:1.2,holderCount:110})],walletSetups:report});
  assert.equal(initial.metrics.supportedWalletSetups,1);assert.equal(initial.components.find(c=>c.id==='wallet_relay')!.score,8);
  const withdrawn=assessMeme({token,now:date(60),samples:[sample(),sample(60,{priceUsd:1.2,holderCount:110})],walletSetups:{...report,setups:[{...setup,status:'withdrawn'}]},previous:initial});
  assert.equal(withdrawn.metrics.withdrawnWalletSetups,1);assert.equal(withdrawn.stage,'contested');assert.ok(withdrawn.score!<initial.score!);
  const unqualified=assessMeme({token,now:date(60),samples:[sample(),sample(60,{priceUsd:1.2,holderCount:110})],walletSetups:{...report,setups:[{...setup,status:'withdrawn',profit:undefined}]}});
  assert.equal(unqualified.metrics.withdrawnWalletSetups,0);assert.equal(unqualified.stage,'accelerating');
});
