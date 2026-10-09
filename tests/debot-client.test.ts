import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ZodError} from 'zod';
import {fetchDebotNarrative} from '../src/providers/debot-client.js';
import {normalizeDebotStory} from '../src/providers/debot-story.js';
import type {Fetcher} from '../src/http.js';
import {signal} from './helpers.js';

const fixture=()=>JSON.parse(readFileSync(new URL('../fixtures/debot-story-v2.example.json',import.meta.url),'utf8'));
const address='0xc24f42b1e458251e3a128b74c65c4c7fa0c97777';
const sample=()=>signal({token:{chain:'bsc',address}});
const apiUrl=`https://debot.ai/api/v1/nitter/story/latest?request_id=12345678-1234-4234-9234-123456789abc&ca_address=${address}`;

test('DeBot固定端点匿名单次GET，不接收外部源URL，保留真实响应及生成时间',async()=>{
  let calls=0,requested='';const raw=fixture();
  const request:Fetcher=async(url,init)=>{
    calls++;requested=String(url);const parsed=new URL(requested);
    assert.equal(parsed.origin,'https://debot.ai');assert.equal(parsed.pathname,'/api/v1/nitter/story/latest');
    assert.deepEqual([...parsed.searchParams.keys()].sort(),['ca_address','request_id']);
    assert.equal(parsed.searchParams.get('ca_address'),address);
    assert.match(parsed.searchParams.get('request_id')!,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(init?.method,'GET');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
    assert.ok(init?.signal instanceof AbortSignal);assert.equal(init?.signal?.aborted,false);assert.equal(init?.body,undefined);
    const headers=new Headers(init?.headers);
    assert.equal(headers.get('cookie'),null);assert.equal(headers.get('authorization'),null);
    assert.deepEqual([...headers.keys()],['accept']);
    return new Response(JSON.stringify(raw));
  };
  const input={...sample(),sourceUrl:'https://evil.test/collect',evidenceUrls:['https://evil.test/ignored']};
  const result=await fetchDebotNarrative(input,request);
  assert.equal(calls,1);assert.equal(result.status,'ok');assert.equal(result.reason,undefined);
  assert.equal(result.sourceUrl,requested);assert.equal(result.snapshot?.sourceUrl,requested);
  assert.equal(result.snapshot?.updatedAt,'2026-10-08T06:31:41.032Z');
  assert.notEqual(result.fetchedAt,result.snapshot?.updatedAt);assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.deepEqual(result.rawResponse,raw);assert.equal(result.snapshot?.structured?.sourceTweetIds.length,38);
  assert.equal(result.snapshot?.structured?.rating.score,'2');assert.match(result.snapshot!.text,/不建议关注/);
  assert.equal('decision' in result,false);assert.equal('assessment' in result,false);
});

test('每次调用使用不同request_id，Solana CA保持大小写且不增加链参数',async()=>{
  const requestIds:string[]=[],mint='So11111111111111111111111111111111111111112';
  const raw=fixture();raw.data.history.ca_address=mint;raw.data.history.story.contract_address=mint;
  const request:Fetcher=async(url)=>{
    const parsed=new URL(String(url));requestIds.push(parsed.searchParams.get('request_id')!);
    assert.equal(parsed.searchParams.get('ca_address'),mint);assert.equal(parsed.searchParams.has('chain'),false);
    return new Response(JSON.stringify(raw));
  };
  const input=signal({token:{chain:'solana',address:mint}});
  for(let i=0;i<2;i++) assert.equal((await fetchDebotNarrative(input,request)).status,'ok');
  assert.notEqual(requestIds[0],requestIds[1]);
});

test('Robinhood缺链归属依据及非法CA均不发网络请求',async()=>{
  let calls=0;const request:Fetcher=async()=>{calls++;throw new Error('must not run');};
  const unsupported=await fetchDebotNarrative(signal({token:{chain:'robinhood',address}}),request);
  assert.equal(unsupported.status,'unsupported');assert.equal(unsupported.reason,'DEBOT_CHAIN_SCOPE_UNKNOWN');
  assert.equal(unsupported.sourceUrl,undefined);assert.equal(unsupported.snapshot,undefined);
  for(const token of [{chain:'bsc',address:'not-a-CA'},{chain:'solana',address:'1'.repeat(33)}] as const) {
    const invalid=await fetchDebotNarrative(signal({token}),request);
    assert.equal(invalid.status,'unavailable');assert.equal(invalid.reason,'DEBOT_TOKEN_INVALID');
  }
  assert.equal(calls,0);
});

test('HTTP401、403、404、429及其他错误单次失败，原因码固定且无错误正文回显',async()=>{
  for(const status of [401,403,404,429,500]) {
    let calls=0;
    const result=await fetchDebotNarrative(sample(),async()=>{calls++;return new Response('secret upstream body',{status});});
    assert.equal(calls,1);assert.equal(result.status,'unavailable');assert.equal(result.snapshot,undefined);
    assert.equal(result.reason,status===500?'DEBOT_HTTP_ERROR':`DEBOT_HTTP_${status}`);
    assert.equal(JSON.stringify(result).includes('secret upstream body'),false);
  }
});

test('无效JSON、超时、断网及任意异常不重试且不暴露异常里的URL或凭证',async()=>{
  const cases:{request:Fetcher;reason:string}[]=[
    {request:async()=>new Response('invalid JSON secret'),reason:'DEBOT_INVALID_JSON'},
    {request:async()=>{throw new DOMException('token=secret','TimeoutError');},reason:'DEBOT_REQUEST_TIMEOUT'},
    {request:async()=>{throw new DOMException('token=secret','AbortError');},reason:'DEBOT_REQUEST_TIMEOUT'},
    {request:async()=>{throw new Error('https://private.invalid/?token=secret');},reason:'DEBOT_REQUEST_FAILED'},
  ];
  for(const entry of cases) {
    let calls=0;
    const result=await fetchDebotNarrative(sample(),async(...args)=>{calls++;return entry.request(...args);});
    assert.equal(calls,1);assert.equal(result.status,'unavailable');assert.equal(result.reason,entry.reason);
    assert.equal(result.snapshot,undefined);assert.equal(JSON.stringify(result).includes('secret'),false);
  }
});

test('错误响应、缺字段和其他CA结果只留原响应审计，不因同名或成功状态放行',async()=>{
  for(const [index,modify] of [(p:any)=>{p.data.history.ca_address='0x1111111111111111111111111111111111111111';},
    (p:any)=>{p.data.history.story.contract_address='0x1111111111111111111111111111111111111111';},
    (p:any)=>{delete p.data.history.generated_at;},(p:any)=>{p.data.version='v3';},
    (p:any)=>{p.code=404;p.success=false;},(p:any)=>{p.data.history={name:'Umi'};}].entries()) {
    const raw=fixture();modify(raw);let calls=0;
    const result=await fetchDebotNarrative(sample(),async()=>{calls++;return new Response(JSON.stringify(raw));});
    assert.equal(calls,1);assert.equal(result.status,'unavailable');assert.equal(result.reason,index<2?'DEBOT_TOKEN_IDENTITY_CONFLICT':'DEBOT_RESPONSE_INVALID');
    assert.equal(result.identityConflict!==undefined,index<2);
    assert.equal(result.snapshot,undefined);assert.deepEqual(result.rawResponse,raw);
  }
});

test('API源地址仅接受精确路径和唯一CA/request_id，拒绝伪域、额外参数、重复CA和错币',()=>{
  assert.equal(normalizeDebotStory(fixture(),sample().token,apiUrl).sourceUrl,apiUrl);
  for(const url of [apiUrl.replace('debot.ai','debot.ai.evil.test'),apiUrl.replace('debot.ai','www.debot.ai'),
    apiUrl.replace('/latest?','/latest/?'),apiUrl.replace('/latest?','/list?'),
    apiUrl.replace(address,'0x1111111111111111111111111111111111111111'),`${apiUrl}&ca_address=${address}`,
    `${apiUrl}&request_id=12345678-1234-4234-9234-123456789abc`,`${apiUrl}&chain=bsc`,`${apiUrl}#fragment`,
    apiUrl.replace('request_id=12345678-1234-4234-9234-123456789abc&',''),apiUrl.replace('debot.ai','user@debot.ai')]) {
    assert.throws(()=>normalizeDebotStory(fixture(),sample().token,url),ZodError);
  }
  assert.throws(()=>normalizeDebotStory(fixture(),{chain:'robinhood',address},apiUrl),ZodError);
});
