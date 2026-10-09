import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,effectiveReport,liveProviders} from '../src/engine.js';
import {unknown,parseSignal,type VendorNarrative} from '../src/types.js';
import {analyzeVendorNarrative} from '../src/providers/vendor-narrative.js';
import {signal,config,providers,now,pass} from './helpers.js';

test('信号驱动：不要求买在底部，不设币龄或上涨幅度门槛',async()=>{
  const r=await evaluate(signal({text:'已经上涨，但有新的可验证催化'}),config(),providers(),{now:()=>now});
  assert.equal(r.decision,'BUY_CANDIDATE');assert.equal(r.buyEligible,true);assert.equal(r.executionEnabled,false);
});
test('安全未知不能被有利叙事覆盖',async()=>{
  const p=providers();p.safety=async()=>unknown('API_TIMEOUT');
  const r=await evaluate(signal(),config(),p,{now:()=>now});assert.equal(r.decision,'WATCH');assert.equal(r.buyEligible,false);
});
test('安全拒绝不调用模型',async()=>{
  const p=providers();p.safety=async()=>({...pass(),status:'fail'});p.narrative=async()=>{throw new Error('must not call');};
  const r=await evaluate(signal(),config(),p,{now:()=>now});assert.equal(r.decision,'REJECT');assert.ok(r.reasons.includes('SKIPPED_BLOCKED_ASSET'));
});
test('未知发行模式不放行',async()=>{
  const p=providers();p.provenance=async()=>({...pass(),platform:'flap',facts:{modeSupported:false}});
  assert.equal((await evaluate(signal(),config(),p,{now:()=>now})).decision,'WATCH');
});
test('过期信号不调用外部供应商',async()=>{
  const p=providers();p.safety=async()=>{throw new Error('called');};
  const r=await evaluate(signal({occurredAt:'2026-10-07T12:00:00.000Z'}),config(),p,{now:()=>now});
  assert.ok(r.reasons.includes('SIGNAL_STALE'));assert.ok(r.reasons.includes('SKIPPED_STALE_SIGNAL'));
});
test('模型/RPC耗时导致过期时再次阻断',async()=>{
  let calls=0;
  const r=await evaluate(signal(),config(),providers(),{now:()=>calls++?new Date(now.getTime()+700_000):now});
  assert.equal(r.buyEligible,false);assert.ok(r.reasons.includes('SIGNAL_STALE'));
});
test('历史通过结果到期不能被重复投递当成当前许可',async()=>{
  const r=await evaluate(signal(),config(),providers(),{now:()=>now});
  const expired=effectiveReport(r,new Date(now.getTime()+61_000));
  assert.equal(expired.buyEligible,false);assert.equal(expired.decision,'WATCH');assert.equal(r.decision,'BUY_CANDIDATE');
});
test('演示报告永远不能授权买入',async()=>{
  const r=await evaluate(signal(),config(),providers(),{now:()=>now,mode:'demo'});
  assert.equal(r.decision,'BUY_CANDIDATE');assert.equal(r.buyEligible,false);
});
test('输入不能注入安全通过、未来收益或模型结果',()=>{
  assert.throws(()=>parseSignal({...signal(),safety:{status:'pass'}}));
  assert.throws(()=>parseSignal({...signal(),maxReturn24h:100}));
  assert.throws(()=>parseSignal({...signal(),token:{chain:'solana',address:signal().token.address}}));
});

test('自动获取的错误原响应保留审计，失败不能伪装成已获取或已鉴权',async()=>{
  const raw={code:0,success:true,data:{history:{ca_address:'wrong-address',name:'same-name'}}};
  const p=providers();
  p.vendor=async()=>({status:'unavailable',reason:'DEBOT_RESPONSE_INVALID',rawResponse:raw,
    sourceUrl:'https://debot.ai/api/v1/nitter/story/latest',fetchedAt:now.toISOString()});
  p.narrative=async(s,e,n)=>analyzeVendorNarrative(s,e,config(),n);
  const report=await evaluate(signal(),config(),p,{now:()=>now});
  assert.deepEqual(report.narrative.facts.vendorResponse,raw);
  assert.equal((report.narrative.facts.vendorFetch as any).reason,'DEBOT_RESPONSE_INVALID');
  assert.equal(report.narrative.facts.providerApiAuthenticated,false);
  assert.equal(report.narrative.facts.providerEndpointRetrieved,undefined);
  assert.equal(report.narrative.facts.nativeNarrativeApiStatus,'unconfirmed');
  assert.equal(report.decision,'WATCH');assert.equal(report.narrative.supplier,undefined);
});

test('自动取得叙事记录已观察网页接口但保持未鉴权，原信号和生成时间不改写',async()=>{
  const input=signal(),snapshot:VendorNarrative={provider:'debot',token:input.token,
    sourceUrl:'https://debot.ai/api/v1/nitter/story/latest',text:'供应商原文，不建议关注。',
    updatedAt:new Date(now.getTime()-1000).toISOString(),evidenceUrls:[]};
  const raw={response:'original'};const p=providers();
  p.vendor=async()=>({status:'ok',snapshot,rawResponse:raw,sourceUrl:snapshot.sourceUrl,fetchedAt:now.toISOString()});
  p.narrative=async(s,e,n)=>analyzeVendorNarrative(s,e,config(),n);
  const report=await evaluate(input,config(),p,{now:()=>now});
  assert.equal(report.narrative.facts.nativeNarrativeApiStatus,'observed_web_endpoint');
  assert.equal(report.narrative.facts.providerApiAuthenticated,false);
  assert.equal(report.narrative.facts.providerEndpointRetrieved,true);
  assert.equal(report.narrative.supplier?.verification,'vendor_endpoint');
  assert.equal(report.narrative.supplier?.updatedAt,snapshot.updatedAt);
  assert.deepEqual(report.narrative.facts.vendorResponse,raw);
  assert.equal(input.vendorNarrative,undefined);assert.equal(report.signal.vendorNarrative,undefined);
  assert.equal(report.signal.occurredAt,now.toISOString());
});

test('原输入已有12条帖子时供应商8条优先采集，并给CA搜索保留4个结果槽',async()=>{
  const input=signal(),c=config();c.xDataProvider='x_official';c.xBearer='test-bearer';
  const vendorIds=Array.from({length:8},(_,i)=>String(i+100));
  const sourceUrls=Array.from({length:12},(_,i)=>`https://x.com/original/status/${i+1}`);
  const snapshot:VendorNarrative={provider:'debot',token:input.token,sourceUrl:'https://debot.ai/',
    text:'原始叙事',updatedAt:now.toISOString(),evidenceUrls:vendorIds.map(id=>`https://twitter.com/vendor/status/${id}`)};
  const withVendor={...input,evidenceUrls:sourceUrls,vendorNarrative:snapshot};
  const original=structuredClone(withVendor),oldFetch=globalThis.fetch;let lookupIds:string[]=[];
  const timestamp=new Date().toISOString();
  const post=(id:string)=>({id,author_id:id,created_at:timestamp,text:`帖子 ${id} 的 CA ${input.token.address}`});
  globalThis.fetch=async(url)=>{
    const parsed=new URL(String(url));assert.equal(parsed.origin,'https://api.x.com');
    if(parsed.pathname==='/2/tweets') {
      lookupIds=parsed.searchParams.get('ids')!.split(',');
      return new Response(JSON.stringify({data:lookupIds.map(post)}));
    }
    assert.equal(parsed.pathname,'/2/tweets/search/recent');
    return new Response(JSON.stringify({data:['201','202','203','204','205'].map(post)}));
  };
  try {
    const result=await liveProviders(c).evidence(withVendor);
    const posts=Array.isArray(result)?result:result.evidence;
    assert.deepEqual(lookupIds,vendorIds);
    assert.deepEqual(posts.map(p=>p.id),[...vendorIds,'201','202','203','204'].map(id=>`x:${id}`));
    assert.deepEqual(withVendor,original);
  } finally {globalThis.fetch=oldFetch;}
});
