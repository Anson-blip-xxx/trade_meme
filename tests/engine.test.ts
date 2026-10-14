import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,effectiveReport,liveProviders,decide} from '../src/engine.js';
import {unknown,parseSignal,type VendorNarrative} from '../src/types.js';
import {analyzeVendorNarrative} from '../src/providers/vendor-narrative.js';
import {signal,config,providers,now,pass,narrative} from './helpers.js';

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
  const r=await evaluate(signal(),config(),p,{now:()=>now});assert.equal(r.decision,'REJECT');assert.ok(r.advisoryReasons?.includes('SKIPPED_BLOCKED_ASSET'));
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
  assert.equal(report.decision,'BUY_CANDIDATE');assert.equal(report.narrative.supplier,undefined);
  assert.ok(report.advisoryReasons?.includes('VENDOR_NARRATIVE_MISSING'));
  assert.equal(report.reasons.includes('VENDOR_NARRATIVE_MISSING'),false);
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

test('missing, unknown, stale or adverse AI narrative is advisory and does not veto otherwise eligible signals',()=>{
  for(const report of [
    {...narrative(),status:'unknown' as const,reasons:['VENDOR_NARRATIVE_MISSING'],evidence:[]},
    {...narrative(),status:'unknown' as const,reasons:['MODEL_CITATION_INVALID']},
    {...narrative(),status:'fail' as const,reasons:['NARRATIVE_CONFLICT_OR_ADVERSE'],analysis:{...narrative().analysis!,assessment:'adverse' as const,relation:'conflict' as const}},
    {...narrative(),status:'unknown' as const,reasons:['VENDOR_NARRATIVE_STALE'],checkedAt:'2020-01-01T00:00:00.000Z'},
  ]) {
    const result=decide(signal(),now.toISOString(),config(),pass(),pass(),report,now);
    assert.equal(result.decision,'BUY_CANDIDATE'); assert.equal(result.buyEligible,true);
    assert.equal(result.policyVersion,'entry-gate-v8');
    assert.ok(report.reasons.every(reason=>result.advisoryReasons?.includes(reason)&&!result.reasons.includes(reason)));
  }
});

test('concrete complete-CA or chain mismatch still rejects independently of supplier sentiment',()=>{
  for(const supplierToken of [{chain:'bsc',address:`0x${'f'.repeat(40)}`},{chain:'robinhood',address:signal().token.address}]) {
    const result=decide(signal(),now.toISOString(),config(),pass(),pass(),{...narrative(),facts:{supplierToken}},now);
    assert.equal(result.decision,'REJECT'); assert.equal(result.buyEligible,false);
    assert.ok(result.reasons.includes('NARRATIVE_TOKEN_IDENTITY_CONFLICT'));
  }
  const malformed=decide(signal(),now.toISOString(),config(),pass(),pass(),{...narrative(),status:'unknown',
    facts:{supplierToken:{chain:'bsc',address:'missing'},supplierTokenMatches:false},reasons:['VENDOR_NARRATIVE_INVALID']},now);
  assert.equal(malformed.decision,'BUY_CANDIDATE');
});

test('celebrity metadata adds research priority without changing safety, provenance or wallet gates',()=>{
  const research={snapshot:{token:signal().token,fetchedAt:now.toISOString(),info:{address:signal().token.address,
    link:{twitter_username:'cz_binance',website:'https://x.com/heyibinance'}},diagnostics:[{section:'info',status:'ok'}]},
    flow:pass(),safety:pass()} as any;
  const settings={...config(),walletSupportRequired:true};
  const result=decide(signal(),now.toISOString(),settings,pass(),pass(),narrative(),now,'live',undefined,research);
  assert.equal(result.social?.score,10); assert.equal(result.social?.scope,'research_priority');
  assert.equal(result.social?.endorsementVerified,false); assert.equal(result.decision,'BUY_CANDIDATE');
  for(const field of ['provenance','safety','flow']) {
    const result=decide(signal(),now.toISOString(),settings,field==='provenance'?unknown('TEST_MISSING'):pass(),
      field==='safety'?unknown('TEST_MISSING'):pass(),narrative(),now,'live',undefined,
      field==='flow'?{...research,flow:unknown('TEST_MISSING')}:research);
    assert.equal(result.social?.score,10); assert.equal(result.decision,'WATCH'); assert.equal(result.buyEligible,false);
  }
});
