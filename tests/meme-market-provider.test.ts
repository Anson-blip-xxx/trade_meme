import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {fetchMemeMarkets} from '../src/meme-market-provider.js';
import type {Fetcher} from '../src/http.js';
import {now,token} from './helpers.js';

const poolA=`0x${'2'.repeat(40)}`,poolB=`0x${'3'.repeat(40)}`,other=`0x${'4'.repeat(40)}`;
const target={chain:'bsc' as const,address:token};
const pair=(patch:Record<string,unknown>={})=>({chainId:'bsc',pairAddress:poolA,baseToken:{address:token},
  quoteToken:{address:other},priceUsd:'0.001',liquidity:{usd:10_000},txns:{m5:{buys:20,sells:10}},volume:{m5:800},...patch});
const request=(payload:unknown,status=200):Fetcher=>async()=>new Response(JSON.stringify(payload),{status});
const fetchMarkets=(payload:unknown,targets=[target])=>fetchMemeMarkets(targets,new AbortController().signal,{now:()=>now,fetcher:request(payload)});

test('one fixed-host GET batches up to 30 normalized addresses and returns exact base-token samples',async()=>{
  const targets=Array.from({length:30},(_,index)=>({chain:'bsc' as const,address:`0x${(index+1000).toString(16).padStart(40,'0')}`}));
  let calls=0;
  const result=await fetchMemeMarkets(targets,new AbortController().signal,{now:()=>now,fetcher:async(url,init)=>{
    calls++;const parsed=new URL(String(url));assert.equal(parsed.origin,'https://api.dexscreener.com');
    assert.equal(parsed.pathname,`/tokens/v1/bsc/${targets.map(t=>t.address).join(',')}`);
    assert.equal(parsed.search,'');assert.equal(init?.method,'GET');assert.equal(init?.credentials,'omit');
    assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('authorization'),null);
    assert.equal(new Headers(init?.headers).get('cookie'),null);assert.ok(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify(targets.map(t=>pair({baseToken:{address:t.address}}))));
  }});
  assert.equal(calls,1);assert.equal(result.length,30);assert.deepEqual(result[0].token,targets[0]);
  assert.equal(result[0].source,'dexscreener_pair');assert.equal(result[0].observedAt,now.toISOString());
  assert.equal(result[0].holderCount,undefined);assert.equal(result[0].windows['1m'],undefined);
  assert.deepEqual(result[0].windows,{'5m':{buys:20,sells:10,volumeUsd:800}});
});

test('batch limit, mixed chains and malformed addresses reject before any transport call',async()=>{
  let calls=0;const fetcher:Fetcher=async()=>{calls++;return new Response('[]');};
  await assert.rejects(fetchMemeMarkets(Array.from({length:31},()=>target),new AbortController().signal,{fetcher}),/MEME_MARKET_BATCH_TOO_LARGE/);
  await assert.rejects(fetchMemeMarkets([target,{chain:'solana',address:bs58.encode(new Uint8Array(32).fill(7))}],new AbortController().signal,{fetcher}),/MEME_MARKET_MIXED_CHAINS/);
  for(const address of ['https://evil.test/key','0x1234',`0x${'0'.repeat(40)}`,`${token},${other}`])
    await assert.rejects(fetchMemeMarkets([{...target,address}],new AbortController().signal,{fetcher}),/MEME_MARKET_TOKEN_INVALID/);
  assert.equal(calls,0);
});

test('Robinhood and empty batches return no invented fallback chain data',async()=>{
  let calls=0;const fetcher:Fetcher=async()=>{calls++;throw new Error('not requested');};
  assert.deepEqual(await fetchMemeMarkets([],new AbortController().signal,{fetcher}),[]);
  assert.deepEqual(await fetchMemeMarkets([{chain:'robinhood',address:token}],new AbortController().signal,{fetcher}),[]);
  assert.equal(calls,0);
});

test('preferred valid pool wins; missing or invalid preferred pool falls back to deepest valid liquidity',async()=>{
  const rows=[pair({liquidity:{usd:1_000}}),pair({pairAddress:poolB,liquidity:{usd:90_000}})];
  const preferred=await fetchMemeMarkets([{...target,poolAddress:poolA}],new AbortController().signal,{now:()=>now,fetcher:request(rows)});
  assert.equal(preferred[0].poolAddress,poolA);assert.equal(preferred[0].liquidityUsd,1_000);
  for(const poolAddress of [other,'invalid']) {
    const fallback=await fetchMemeMarkets([{...target,poolAddress}],new AbortController().signal,{now:()=>now,fetcher:request(rows)});
    assert.equal(fallback[0].poolAddress,poolB);
  }
  const badPreferred=await fetchMemeMarkets([{...target,poolAddress:poolA}],new AbortController().signal,{now:()=>now,
    fetcher:request([pair({priceUsd:'NaN'}),rows[1]])});
  assert.equal(badPreferred[0].poolAddress,poolB);
});

test('pool tie-breaking is deterministic under response reordering and duplicate equivalent rows collapse',async()=>{
  const rows=[pair({pairAddress:poolB}),pair(),pair()];
  for(const values of [rows,[...rows].reverse()]) {
    const result=await fetchMarkets(values);assert.equal(result.length,1);assert.equal(result[0].poolAddress,poolA);
  }
});

test('conflicting same-pool snapshots are not arbitrarily selected over a consistent pool',async()=>{
  const rows=[pair(),pair({priceUsd:'0.002'}),pair({pairAddress:poolB,liquidity:{usd:100}})];
  for(const values of [rows,[...rows].reverse()]) {
    const result=await fetchMarkets(values);assert.equal(result.length,1);assert.equal(result[0].poolAddress,poolB);
  }
  assert.deepEqual(await fetchMarkets(rows.slice(0,2)),[]);
});

test('quote-token matches, wrong chain, other CA, missing pool and invalid price cannot leak into this token',async()=>{
  const result=await fetchMarkets([
    pair({baseToken:{address:other},quoteToken:{address:token}}),pair({chainId:'ethereum'}),
    pair({baseToken:{address:other}}),pair({pairAddress:undefined}),pair({pairAddress:token}),
    pair({priceUsd:'0'}),pair({priceUsd:'-1'}),pair({priceUsd:1}),pair({priceUsd:'Infinity'}),
  ]);
  assert.deepEqual(result,[]);
});

test('optional unknown values stay absent rather than fabricated zeros or historical observations',async()=>{
  const result=await fetchMarkets([pair({liquidity:{usd:'unknown'},txns:{m5:{buys:-1,sells:'bad'}},
    volume:{m5:'NaN'},priceChange:{m5:900},boosts:{active:99},holders:10000})]);
  assert.equal(result.length,1);assert.equal(result[0].liquidityUsd,undefined);assert.equal(result[0].holderCount,undefined);
  assert.equal(result[0].paidBoostActive,99);assert.deepEqual(result[0].windows,{});
  assert.equal('priceChange5mPct' in result[0],false);
});

test('EVM addresses normalize case and duplicate requested tokens make one URL entry',async()=>{
  const mixed=`0x${'aBcD'.repeat(10)}`;let calls=0;
  const result=await fetchMemeMarkets([{...target,address:mixed},{...target,address:mixed.toLowerCase()}],new AbortController().signal,
    {now:()=>now,fetcher:async url=>{
      calls++;assert.equal(new URL(String(url)).pathname,`/tokens/v1/bsc/${mixed.toLowerCase()}`);
      return new Response(JSON.stringify([pair({baseToken:{address:mixed}})]));
    }});
  assert.equal(calls,1);assert.equal(result.length,1);assert.equal(result[0].token.address,mixed.toLowerCase());
});

test('Solana uses its exact base58 address and chain path',async()=>{
  const mint=bs58.encode(new Uint8Array(32).fill(7)),pool=bs58.encode(new Uint8Array(32).fill(8));
  const result=await fetchMemeMarkets([{chain:'solana',address:mint}],new AbortController().signal,{now:()=>now,fetcher:async url=>{
    assert.equal(new URL(String(url)).pathname,`/tokens/v1/solana/${mint}`);
    return new Response(JSON.stringify([pair({chainId:'solana',baseToken:{address:mint},pairAddress:pool}),
      pair({chainId:'solana',baseToken:{address:mint.toLowerCase()},pairAddress:pool})]));
  }});
  assert.equal(result.length,1);assert.equal(result[0].token.address,mint);assert.equal(result[0].poolAddress,pool);
});

test('429 has a stable backoff signal; errors do not expose upstream bodies or exception secrets',async()=>{
  await assert.rejects(fetchMemeMarkets([target],new AbortController().signal,{fetcher:request({secret:'private'},429)}),
    {message:'MEME_MARKET_RATE_LIMITED'});
  await assert.rejects(fetchMemeMarkets([target],new AbortController().signal,{fetcher:request({secret:'private'},500)}),
    {message:'MEME_MARKET_HTTP_ERROR'});
  await assert.rejects(fetchMemeMarkets([target],new AbortController().signal,{fetcher:async()=>{throw new Error('key=private');}}),
    {message:'MEME_MARKET_UNAVAILABLE'});
});

test('response size is bounded by UTF-8 bytes even with omitted or dishonest Content-Length',async()=>{
  for(const response of [new Response('[]',{headers:{'content-length':'2000001'}}),
    new Response(JSON.stringify(['中'.repeat(700_000)])),
    new Response(' '.repeat(2_000_001),{headers:{'content-length':'2'}})]) {
    await assert.rejects(fetchMemeMarkets([target],new AbortController().signal,{fetcher:async()=>response}),
      {message:'MEME_MARKET_RESPONSE_TOO_LARGE'});
  }
});

test('malformed JSON, unexpected wrappers and invalid clock are explicit failures',async()=>{
  await assert.rejects(fetchMemeMarkets([target],new AbortController().signal,{fetcher:async()=>new Response('secret invalid JSON')}),
    {message:'MEME_MARKET_INVALID_JSON'});
  await assert.rejects(fetchMemeMarkets([target],new AbortController().signal,{fetcher:request({pairs:[]})}),
    {message:'MEME_MARKET_RESPONSE_INVALID'});
  await assert.rejects(fetchMemeMarkets([target],new AbortController().signal,{fetcher:request([]),now:()=>new Date(NaN)}),
    {message:'MEME_MARKET_TIME_INVALID'});
});

test('caller cancellation bounds a fetcher that ignores AbortSignal',async()=>{
  const controller=new AbortController();
  const pending=fetchMemeMarkets([target],controller.signal,{fetcher:async()=>new Promise<Response>(()=>{})});
  controller.abort(new Error('secret cancellation reason'));
  await assert.rejects(pending,{message:'MEME_MARKET_CANCELLED'});
});

test('eight-second deadline also bounds a transport that ignores AbortSignal',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=fetchMemeMarkets([target],new AbortController().signal,{fetcher:async()=>new Promise<Response>(()=>{})});
  t.mock.timers.tick(7_999);
  let completed=false;void pending.catch(()=>{completed=true;});await Promise.resolve();assert.equal(completed,false);
  t.mock.timers.tick(1);
  await assert.rejects(pending,{message:'MEME_MARKET_TIMEOUT'});
});

test('deadline includes a hanging body stream and the next request still completes',async()=>{
  const controller=new AbortController();let started=false;
  const pending=fetchMemeMarkets([target],controller.signal,{fetcher:async()=>new Response(new ReadableStream<Uint8Array>({
    pull(){started=true;return new Promise<void>(()=>{});},
  }))});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(started,true);controller.abort();
  await assert.rejects(pending,{message:'MEME_MARKET_CANCELLED'});
  const next=await fetchMarkets([pair()]);assert.equal(next.length,1);
});
