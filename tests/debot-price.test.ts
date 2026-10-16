import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchDebotPrice,DebotPriceError} from '../src/providers/debot-price.js';
import type {Fetcher} from '../src/http.js';

const token={chain:'bsc' as const,address:'0x1111111111111111111111111111111111111111'};
const at=new Date('2026-10-16T03:00:00.000Z');
const body=()=>({code:0,data:{meta:{...token},market:{price:0.003,market_cap:30_000,max_price:99}}});
test('DeBot spot adapter binds full CA and chain; receipt clock does not reuse alert maxima',async()=>{
  const calls:{url:URL;init?:RequestInit}[]=[];
  const sample=await fetchDebotPrice(token,{now:()=>at,fetcher:async(input,init)=>{
    calls.push({url:new URL(String(input)),init});return Response.json(body());}});
  assert.equal(sample?.source,'debot_token_info_sample');assert.equal(sample?.priceUsd,0.003);
  assert.equal(sample?.observedAt,at.toISOString());assert.deepEqual(sample&&{chain:sample.chain,address:sample.address},token);
  assert.equal(calls[0].url.origin,'https://debot.ai');assert.equal(calls[0].url.pathname,'/api/market/token/info');
  assert.equal(calls[0].url.searchParams.get('token'),token.address);assert.equal(calls[0].init?.method,'GET');
  assert.equal(calls[0].init?.redirect,'error');assert.equal(calls[0].init?.body,undefined);
});
test('DeBot snapshots reject mismatched identities, old HTTP cache, invalid price and oversized body',async()=>{
  const examples:unknown[]=[{...body(),code:101},{code:0,data:{...body().data,meta:{...token,chain:'robinhood'}}},
    {code:0,data:{...body().data,meta:{...token,address:'0x2222222222222222222222222222222222222222'}}},
    ...[0,-1,'0.003',null].map(price=>({code:0,data:{...body().data,market:{price,max_price:10}}}))];
  for(const raw of examples)await assert.rejects(fetchDebotPrice(token,{fetcher:async()=>Response.json(raw)}));
  await assert.rejects(fetchDebotPrice(token,{fetcher:async()=>Response.json(body(),{headers:{age:'31'}})}),/PRICE_STALE/);
  await assert.rejects(fetchDebotPrice(token,{fetcher:async()=>new Response(' '.repeat(1024*1024+1))}),/RESPONSE_TOO_LARGE/);
});
test('DeBot throttling stays machine readable and external abort bounds a hung fetcher',async()=>{
  await assert.rejects(fetchDebotPrice(token,{now:()=>at,fetcher:async()=>new Response('private',{status:429,headers:{'retry-after':'90'}})}),e=>{
    assert.ok(e instanceof DebotPriceError);assert.equal(e.cooldownUntil,at.getTime()+90_000);assert.doesNotMatch(e.message,/private/);return true;});
  const abort=new AbortController();const hanging:Fetcher=async()=>new Promise(()=>{});
  const work=fetchDebotPrice(token,{fetcher:hanging,signal:abort.signal});abort.abort();await assert.rejects(work);
});

test('HTTP cache age reduces freshness and a backwards request clock is rejected',async()=>{
  const result=await fetchDebotPrice(token,{now:()=>at,fetcher:async()=>Response.json(body(),{headers:{age:'20'}})});
  assert.equal(result?.observedAt,new Date(at.getTime()-20_000).toISOString());
  let calls=0;
  await assert.rejects(fetchDebotPrice(token,{now:()=>new Date(at.getTime()-(calls++?1:0)),fetcher:async()=>Response.json(body())}),/CLOCK_REGRESSED/);
});
