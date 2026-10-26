import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {assessEntryHolderRiskValues,normalizeStoredEntryHolderRisk,unavailableEntryHolderRisk,
  type EntryHolderRiskValues,type EntryHolderRiskName} from '../src/entry-holder-risk.js';
const mint=bs58.encode(new Uint8Array(32).fill(3)),other=bs58.encode(new Uint8Array(32).fill(4)),now=new Date('2026-10-25T00:00:00Z');
function fixture():EntryHolderRiskValues {
  return {provider:'gmgn',chain:'solana',address:mint,checkedAt:now.toISOString(),values:{
    top10:{value:'0.25',sourceField:'info.stat.top_10_holder_rate'},
    bundler:{value:'0.4',sourceField:'token_top_holders.bundler.amount_percentage',coverage:'complete'},
    ratTrader:{value:'0.3',sourceField:'token_top_holders.rat_trader.amount_percentage',coverage:'complete'}}};
}
const assess=(input:EntryHolderRiskValues)=>assessEntryHolderRiskValues(input,now);
test('strict thresholds use exact decimal holding ratios; equality passes, any one excess blocks',()=>{
  assert.equal(assess(fixture()).status,'pass');
  for(const [name,value,percentage] of [['top10','0.2500000000000000001','25.00000000000000001'],
    ['bundler','0.4000000000000000001','40.00000000000000001'],['ratTrader','0.3000000000000000001','30.00000000000000001']] as const){
    const input=fixture();input.values[name].value=value;const result=assess(input);
    assert.equal(result.status,'blocked');assert.equal(result.metrics[name].percentageText,percentage);assert.equal(result.metrics[name].exceeded,true);
    assert.ok(normalizeStoredEntryHolderRisk(result));
  }
  const input=fixture();input.values.top10.value=0.26;input.values.ratTrader.value=undefined;
  assert.equal(assess(input).status,'blocked');assert.equal(assess(input).reasons[0],'ENTRY_HOLDER_RISK_TOP10_EXCEEDED');
});
test('zero, one, and small scientific rates retain correct percentages',()=>{
  for(const [value,text] of [[0,'0'],[1,'100'],['1e-7','0.00001'],['2.5e-1','25'],['0.000000000000000000000000000001','0.0000000000000000000000000001']] as const){
    const input=fixture();input.values.top10.value=value;const metric=assess(input).metrics.top10;
    assert.equal(metric.status,'available');assert.equal(metric.percentageText,text);
  }
});
test('absent or malformed values cannot silently become zero',()=>{
  for(const value of [undefined,null,'',' ',false,[],{},NaN,Infinity,-0.1,'-0.01','25%','25','1.01','01','0x0','0.2\n']){
    const input=fixture();input.values.bundler.value=value;const result=assess(input);
    assert.equal(result.status,'unavailable',String(value));assert.equal(result.metrics.bundler.rate,undefined);
    assert.ok(normalizeStoredEntryHolderRisk(result));
  }
});
test('partial holder coverage can block on a lower bound but never prove a passing total',()=>{
  const input=fixture();input.values.bundler.coverage='lower_bound';input.values.bundler.lowerBound='0.4';
  assert.equal(assess(input).status,'unavailable');
  input.values.bundler.value=undefined;const unknown=assess(input);
  assert.equal(unknown.metrics.bundler.lowerBoundPercentageText,'40');assert.ok(normalizeStoredEntryHolderRisk(unknown));
  input.values.bundler.value='0.4001';input.values.bundler.lowerBound='0.4001';assert.equal(assess(input).status,'blocked');
  input.values.bundler.value='0.2';delete input.values.bundler.coverage;assert.equal(assess(input).status,'unavailable');
});
test('30-second age, identity and complete time are checked without refreshing the original timestamp',()=>{
  const fresh=fixture();fresh.checkedAt=new Date(+now-30000).toISOString();assert.equal(assess(fresh).status,'pass');
  for(const patch of [{checkedAt:new Date(+now-30001).toISOString()},{checkedAt:new Date(+now+1).toISOString()},
    {checkedAt:'bad'},{completedAt:new Date(+now+1).toISOString()},{completedAt:new Date(+now-1).toISOString()},
    {provider:'other'},{chain:'bsc'},{address:'invalid'}]){
    assert.equal(assess({...fixture(),...patch} as EntryHolderRiskValues).status,'unavailable');
  }
});
test('persisted projection validates token, thresholds, exact rates and status rather than trusting a pass flag',()=>{
  const good=assess(fixture());assert.deepEqual(normalizeStoredEntryHolderRisk(good,{chain:'solana',address:mint}),good);
  assert.equal(normalizeStoredEntryHolderRisk(good,{chain:'solana',address:other}),undefined);
  assert.equal(normalizeStoredEntryHolderRisk(good,{chain:'bsc',address:mint}),undefined);
  for(const key of ['rate','rateText','percentage','percentageText','exceeded','limitPct'] as const){
    const changed=structuredClone(good) as any;changed.metrics.top10[key]=key==='exceeded'?true:'secret';
    assert.equal(normalizeStoredEntryHolderRisk(changed),undefined,key);
  }
  const tooHigh=fixture();tooHigh.values.top10.value=0.5;const forged={...assess(tooHigh),status:'pass',reasons:[]};
  assert.equal(normalizeStoredEntryHolderRisk(forged),undefined);
  const missing=unavailableEntryHolderRisk(mint,now.toISOString(),'ENTRY_HOLDER_RISK_READ_FAILED');
  assert.ok(normalizeStoredEntryHolderRisk(missing));(missing.metrics.top10 as any).rate=0;
  assert.equal(normalizeStoredEntryHolderRisk(missing),undefined);
});
test('stored projection keeps bounded audit metadata but drops raw vendor payloads and invalid wallet records',()=>{
  const input=fixture();input.evidence={requestedLimit:100,top10Source:'info.stat.top_10_holder_rate',
    identity:{status:'verified',reasons:[],authorization:'secret'},top10:{status:'available',reasons:[]},
    topHolders:{status:'available',scope:'visible_top10_not_aggregate',rows:10,reasons:[],list:[{address:other,balance:'secret'}]},
    bundler:{rows:100,distinctWallets:100,positiveWallets:0,matchedWallets:0,coverage:'complete',completionBasis:'zero_tail',lowerBound:'0',reasons:[],cookie:'secret'},
    entrapment:{status:'unsupported',documentedHoldingTag:false,volumeRatio:'0.9',sourceField:'info.stat.top_entrapment_trader_percentage',scope:'vendor_trading_metric_not_holdings'},
    raw:{authorization:'secret'}};
  const result=normalizeStoredEntryHolderRisk({...assess(input),raw:'secret'});assert.ok(result);
  assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes(other));
  assert.deepEqual(result.evidence?.topHolders,{status:'available',reasons:[],scope:'visible_top10_not_aggregate',rows:10,list:[]});
  assert.equal((result.evidence?.entrapment as any).volumeRatio,'0.9');
  assert.equal(result.status,'pass');
});
test('visible Top10 audit retains at most ten minimal public holding records, without altering aggregate risk',()=>{
  const input=fixture();input.evidence={topHolders:{status:'available',scope:'visible_top10_not_aggregate',rows:100,reasons:[],
    list:Array.from({length:12},()=>({address:other,amountPercentage:'0.5',balance:'123.456',kind:'pool',addrType:2,cookie:'secret'}))}};
  const result=assess(input),audit=result.evidence?.topHolders as any;
  assert.equal(result.status,'pass');assert.equal(audit.rows,100);assert.equal(audit.list.length,10);
  assert.deepEqual(audit.list[0],{address:other,amountPercentage:'0.5',balance:'123.456',kind:'pool',addrType:2});
  assert.ok(!JSON.stringify(result).includes('secret'));assert.deepEqual(normalizeStoredEntryHolderRisk(result),result);
});
