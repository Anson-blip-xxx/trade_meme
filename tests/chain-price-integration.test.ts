import test from 'node:test';
import assert from 'node:assert/strict';
import {priceEvidence} from '../src/price-evidence.js';
import {ExitShadow} from '../src/exit-shadow.js';
import {stepAdaptiveExit} from '../src/adaptive-exit.js';
import {readConfig} from '../src/config.js';
import type {ScanPrice} from '../src/scan-archive.js';
const at='2026-10-11T10:00:00.000Z';
const sample:ScanPrice={chain:'bsc',address:'0x'+'a'.repeat(40),priceUsd:1,observedAt:at,source:'chain_pool_sample',
  metadata:{pool:'0x'+'b'.repeat(40),protocol:'pancake_v2',quoteAddress:'0x'+'c'.repeat(40),quotePriceUsd:100,
    anchorAt:at,anchorSource:'vendor_reference',blockNumber:'0x1234',blockHash:'0x'+'d'.repeat(64),blockTime:at,pricing:'spot_before_fees_and_slippage'}};
test('chain price evidence preserves provenance and rejects missing, stale or cross-protocol proof',()=>{
  assert.equal(priceEvidence(sample)?.quotePriceUsd,100);
  assert.equal(priceEvidence({...sample,metadata:undefined}),undefined);
  for(const patch of [{anchorAt:'2026-10-11T09:57:59Z'},{blockTime:'invalid'},{quotePriceUsd:Infinity},{quotePriceUsd:0},
    {protocol:'pumpswap'},{blockNumber:'PRIVATE_KEY'},{pool:'fakepump'},{pricing:'execution_quote'}])
    assert.equal(priceEvidence({...sample,metadata:{...sample.metadata,...patch}}),undefined);
  const normalized=priceEvidence({...sample,metadata:{...sample.metadata,secret:'do-not-retain'}});
  assert.doesNotMatch(JSON.stringify(normalized),/do-not-retain|secret/);
  assert.equal(stepAdaptiveExit(undefined,{...sample,evaluatedAt:at,metadata:undefined}).ignoredReason,'PRICE_INVALID');
  assert.equal(stepAdaptiveExit(undefined,{...sample,evaluatedAt:at}).status,'initialized');
});
test('shadow retains chain price source and audit metadata; fallback neither resets baseline nor invents fills',()=>{
  let now=Date.parse(at);const store=new ExitShadow(':memory:',{now:()=>new Date(now)});
  try {
    const seed={candidateId:'chain-test',eligibleAt:new Date(now-1000).toISOString(),endsAt:new Date(now+86400000).toISOString()};
    store.recordPrice({...sample,metadata:undefined},seed);assert.equal(store.list().items.length,0);
    store.recordPrice(sample,seed);let p=store.list().items[0];assert.ok(p);
    assert.equal(p.priceSource,'chain_pool_sample');assert.equal(p.baselinePriceUsd,1);assert.equal(p.liveReady,false);
    assert.equal(store.detail(p.id)!.samples[0].context.priceEvidence.pool,sample.metadata!.pool);
    now+=1000;store.recordPrice({...sample,priceUsd:1.01,observedAt:new Date(now).toISOString(),source:'gmgn_token_info_sample',metadata:undefined},seed);
    p=store.list().items[0];assert.equal(p.priceSource,'gmgn_token_info_sample');assert.equal(p.baselinePriceUsd,1);
    assert.equal(store.detail(p.id)!.sampleCount,2);assert.equal(store.summary().status.execution,'observation_only');
  }finally{store.close();}
});
test('stream endpoints require paired secure HTTP/WS and never echo credentials in configuration errors',()=>{
  const defaults=readConfig({});assert.equal(defaults.chainStream.enabled,false);
  const safe=readConfig({CHAIN_STREAM_ENABLED:'true',BSC_STREAM_HTTP_URL:'https://rpc.test',BSC_STREAM_WS_URL:'wss://rpc.test'});
  assert.equal(safe.chainStream.maxWallets,10);assert.equal(safe.chainStream.endpoints.bsc?.ws,'wss://rpc.test/');
  assert.throws(()=>readConfig({SOLANA_STREAM_HTTP_URL:'https://rpc.test',SOLANA_STREAM_WS_URL:'wss://different.test/SECRET'}),/CHAIN_STREAM_ENDPOINT_INVALID/);
  assert.equal(readConfig({BSC_STREAM_HTTP_URL:'https://other.test',BSC_STREAM_WS_URL:'wss://rpc.test'}).chainStream.endpoints.bsc?.http,'https://other.test/');
  for(const ws of ['ws://rpc.test','wss://user:SECRET@rpc.test'])
    assert.throws(()=>readConfig({BSC_STREAM_HTTP_URL:'https://rpc.test',BSC_STREAM_WS_URL:ws}),e=>e instanceof Error&&e.message==='CHAIN_STREAM_ENDPOINT_INVALID');
});
