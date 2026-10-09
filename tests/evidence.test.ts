import test from 'node:test';
import assert from 'node:assert/strict';
import {readConfig} from '../src/config.js';
import {gatherEvidence,gatherEvidenceReport} from '../src/providers/evidence.js';
import {validateNarrative} from '../src/providers/narrative.js';
import {signal,config,evidence,analysis,now,fetchJson} from './helpers.js';

const fxPost=(overrides:Record<string,unknown>={})=>({type:'status',provider:'twitter',id:'10',
  text:`叙事 CA: ${signal().token.address}`,author:{id:'101',screen_name:'imitated_celebrity',verification:{verified:true}},
  created_at:now.toUTCString(),reposted_by:null,...overrides});
const thirdParty=()=>evidence().map(e=>({...e,provider:'fxembed' as const,verification:'third_party' as const}));

test('FxEmbed免Key搜索，固定主机、单页、保留引用和第三方来源',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'fxembed',TRACKED_X_IDS:'101'});
  let calls=0;
  const f:typeof fetch=async(url,init)=>{
    calls++;
    const u=new URL(String(url));
    assert.equal(u.origin,'https://api.fxtwitter.com');assert.equal(u.pathname,'/2/search');
    assert.equal(u.searchParams.get('feed'),'latest');assert.equal(u.searchParams.get('count'),'20');
    assert.ok(u.searchParams.get('q')?.includes(signal().token.address));
    assert.ok(u.searchParams.get('q')?.includes('since_time:'));assert.equal(init?.headers,undefined);
    return new Response(JSON.stringify({code:200,results:[fxPost()],cursor:{bottom:'do-not-follow'}}));
  };
  const e=await gatherEvidence(signal(),c,f,now);
  assert.equal(calls,1);assert.equal(e.length,1);
  assert.equal(e[0].url,'https://x.com/i/web/status/10');assert.equal(e[0].authorId,'101');
  assert.equal(e[0].authority,'tracked');assert.equal(e[0].verification,'third_party');
  assert.equal(e[0].provider,'fxembed');assert.equal(e[0].publishedAt,now.toISOString());
});

test('FxEmbed不依赖展示名或蓝标，原始文本优先于展示文本',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'fxembed',TRUSTED_ISSUER_X_IDS:'102'});
  const e=await gatherEvidence(signal(),c,fetchJson({code:200,results:[
    fxPost({text:'已展开的展示内容',raw_text:{text:`CA: ${signal().token.address}`}})]}),now);
  assert.equal(e.length,1);assert.equal(e[0].authority,'public');
  assert.equal(e[0].text,`CA: ${signal().token.address}`);
});

test('搜索拒绝过期、未来、截断CA、重复、转推、非X及身份缺失的结果',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'fxembed'});
  const e=await gatherEvidence(signal(),c,fetchJson({code:200,results:[
    fxPost(),fxPost({id:'11'}),fxPost({id:'10',text:`different ${signal().token.address}`}),
    fxPost({id:'12',created_at:'2026-09-01T00:00:00Z'}),
    fxPost({id:'13',created_at:new Date(now.getTime()+60000).toISOString()}),
    fxPost({id:'14',text:signal().token.address+'f'}),
    fxPost({id:'15',reposted_by:{id:'104'}}),fxPost({id:'16',author:{screen_name:'trusted'}}),
    fxPost({id:'17',provider:'bluesky'}),fxPost({id:'18',author:{id:101}}),
    fxPost({id:'19',author:{id:'101',protected:true}}),fxPost({id:'20',type:'tombstone'}),
  ]}),now);
  assert.equal(e.length,1);assert.equal(e[0].id,'x:10');
});

test('免Key按链接读取，部分失败可保留其他帖子，返回ID必须匹配请求',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'fxembed'});
  const f:typeof fetch=async(url)=>{
    const id=new URL(String(url)).pathname.split('/').at(-1);
    if(id==='10') return new Response('{}',{status:404});
    return new Response(JSON.stringify({code:200,status:fxPost({id:id==='11'?'11':'999'})}));
  };
  const e=await gatherEvidence(signal({evidenceUrls:['10','11','12'].map(id=>`https://x.com/forged_handle/status/${id}`)}),c,f,now);
  assert.equal(e.length,1);assert.equal(e[0].id,'x:11');assert.equal(e[0].authorId,'101');
});

test('第三方付费接口使用自身Key和正确lookup参数，不接收不相符的帖子',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'twitterapi_io',TWITTERAPI_IO_KEY:'vendor-test',X_BEARER_TOKEN:'must-not-send'});
  const paths:string[]=[];
  const f:typeof fetch=async(url,init)=>{
    const u=new URL(String(url));assert.equal(u.origin,'https://api.twitterapi.io');
    paths.push(u.pathname);
    const headers=new Headers(init?.headers);assert.equal(headers.get('x-api-key'),'vendor-test');
    assert.equal(headers.get('authorization'),null);
    if(u.pathname==='/twitter/tweet/advanced_search') {
      assert.ok(u.searchParams.get('query')?.includes(signal().token.address));
      return new Response(JSON.stringify({status:'success',tweets:[]}));
    }
    assert.equal(u.pathname,'/twitter/tweets');assert.equal(u.searchParams.get('tweet_ids'),'10');
    return new Response(JSON.stringify({status:'success',tweets:[
      {id:'10',author:{id:'101'},text:'可引用原帖',createdAt:now.toUTCString()},
      {id:'11',author:{id:'102'},text:'不应返回',createdAt:now.toUTCString()}]}));
  };
  const e=await gatherEvidence(signal({evidenceUrls:['https://x.com/user/status/10']}),c,f,now);
  assert.deepEqual(paths,['/twitter/tweets','/twitter/tweet/advanced_search']);
  assert.equal(e.length,1);assert.equal(e[0].provider,'twitterapi_io');assert.equal(e[0].verification,'third_party');
});

test('输入热点原帖仍按完整CA搜索，原帖优先保留且两路去重后最多12条',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'fxembed'});
  const paths:string[]=[];
  const s=signal({evidenceUrls:['https://x.com/celebrity/status/10','https://twitter.com/duplicate/status/10']});
  const f:typeof fetch=async(url)=>{
    const u=new URL(String(url));paths.push(u.pathname);
    if(u.pathname==='/2/status/10') {
      // Search finishes first; its results must not consume the slot reserved for the original.
      await new Promise(resolve=>setTimeout(resolve,10));
      return new Response(JSON.stringify({code:200,status:fxPost({text:'名人的热点原帖没有提及任何合约'})}));
    }
    assert.equal(u.pathname,'/2/search');
    assert.ok(u.searchParams.get('q')?.includes(s.token.address));
    const posts=[fxPost({id:'10',text:`搜索返回了相同ID ${s.token.address}`}),
      ...Array.from({length:15},(_,i)=>fxPost({id:String(i+20),text:`独立文本 ${i}: ${s.token.address}`})),
      fxPost({id:'99',text:`独立文本 0: ${s.token.address}`}),fxPost({id:'98',text:'仅仅同名不能关联'})];
    return new Response(JSON.stringify({code:200,results:posts,cursor:{bottom:'never-follow'}}));
  };
  const report=await gatherEvidenceReport(s,c,f,now);
  assert.deepEqual(paths,['/2/status/10','/2/search']);
  assert.equal(report.evidence.length,12);
  assert.equal(report.evidence[0].id,'x:10');assert.equal(report.evidence[0].text,'名人的热点原帖没有提及任何合约');
  assert.equal(new Set(report.evidence.map(p=>p.id)).size,12);
  assert.deepEqual(report.diagnostics,[{operation:'lookup',status:'ok',returned:1},{operation:'search',status:'ok',returned:16}]);
});

test('官方X接口同时读原帖和搜CA，搜索命中不受输入ID名单限制',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'x_official',X_BEARER_TOKEN:'test'});
  const calls:{path:string;ids:string|null;query:string|null;authorization:string|null}[]=[];
  const f:typeof fetch=async(url,init)=>{
    const u=new URL(String(url));
    calls.push({path:u.pathname,ids:u.searchParams.get('ids'),query:u.searchParams.get('query'),
      authorization:new Headers(init?.headers).get('authorization')});
    const p=u.pathname==='/2/tweets'
      ?{id:'10',author_id:'101',text:'原始热点',created_at:now.toISOString()}
      :{id:'11',author_id:'102',text:`社区关联 ${signal().token.address}`,created_at:now.toISOString()};
    return new Response(JSON.stringify({data:[p],meta:{next_token:'never-follow'}}));
  };
  const r=await gatherEvidenceReport(signal({evidenceUrls:['https://x.com/a/status/10']}),c,f,now);
  assert.deepEqual(r.evidence.map(p=>p.id),['x:10','x:11']);
  assert.deepEqual(calls.map(c=>c.path),['/2/tweets','/2/tweets/search/recent']);
  assert.equal(calls[0].ids,'10');assert.ok(calls[1].query?.includes(signal().token.address));
  assert.ok(calls.every(c=>c.authorization==='Bearer test'));
  assert.deepEqual(r.diagnostics,[{operation:'lookup',status:'ok',returned:1},{operation:'search',status:'ok',returned:1}]);
});

test('读帖或搜索单独失败不抹掉另一操作的证据，并报告限流',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'fxembed'});
  for(const failedOperation of ['lookup','search'] as const) {
    const f:typeof fetch=async(url)=>{
      const operation=new URL(String(url)).pathname==='/2/search'?'search':'lookup';
      if(operation===failedOperation) return new Response('{}',{status:429});
      return new Response(JSON.stringify(operation==='lookup'?{code:200,status:fxPost({text:'原帖'})}
        :{code:200,results:[fxPost({id:'11'})]}));
    };
    const r=await gatherEvidenceReport(signal({evidenceUrls:['https://x.com/a/status/10']}),c,f,now);
    assert.equal(r.evidence.length,1);
    assert.equal(r.evidence[0].id,failedOperation==='lookup'?'x:11':'x:10');
    assert.deepEqual(r.diagnostics.find(d=>d.operation===failedOperation),
      {operation:failedOperation,status:'unavailable',reason:'UPSTREAM_HTTP_429',returned:0});
    assert.equal(r.diagnostics.find(d=>d.operation!==failedOperation)?.status,'ok');
  }
});

test('部分原帖不可用时保留有效原帖，诊断记录缺失和返回数',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'fxembed'});
  const f:typeof fetch=async(url)=>{
    const path=new URL(String(url)).pathname;
    if(path==='/2/search') return new Response(JSON.stringify({code:200,results:[]}));
    if(path==='/2/status/10') return new Response(JSON.stringify({code:200,status:fxPost({text:'有效原帖'})}));
    return new Response('{}',{status:404});
  };
  const r=await gatherEvidenceReport(signal({evidenceUrls:['10','11'].map(id=>`https://x.com/a/status/${id}`)}),c,f,now);
  assert.equal(r.evidence.length,1);
  assert.deepEqual(r.diagnostics,[{operation:'lookup',status:'unavailable',reason:'UPSTREAM_HTTP_404',returned:1},
    {operation:'search',status:'empty',reason:'NO_RESULTS',returned:0}]);
});

test('两种付费源缺Key各有诊断且不调用任何接口，不自动切换',async()=>{
  for(const provider of ['x_official','twitterapi_io'] as const) {
    const c=readConfig({X_DATA_PROVIDER:provider,X_BEARER_TOKEN:' ',TWITTERAPI_IO_KEY:' '});
    let calls=0;
    const r=await gatherEvidenceReport(signal({evidenceUrls:['https://x.com/a/status/10']}),c,async()=>{calls++;throw new Error();},now);
    assert.equal(calls,0);assert.deepEqual(r.evidence,[]);
    assert.deepEqual(r.diagnostics,['lookup','search'].map(operation=>({operation,status:'not_configured',returned:0,
      reason:provider==='x_official'?'X_BEARER_TOKEN_MISSING':'TWITTERAPI_IO_KEY_MISSING'})));
  }
});

test('诊断区分无结果、无有效证据、服务拒绝、坏响应且不泄露异常内容',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'fxembed'});
  const cases:{fetcher:typeof fetch;status:string;reason:string}[]=[
    {fetcher:fetchJson({code:200,results:[]}),status:'empty',reason:'NO_RESULTS'},
    {fetcher:fetchJson({code:200,results:[fxPost({text:'同名但没有完整CA'})]}),status:'empty',reason:'NO_VALID_EVIDENCE'},
    {fetcher:fetchJson({},401),status:'unavailable',reason:'UPSTREAM_HTTP_401'},
    {fetcher:fetchJson({code:429}),status:'unavailable',reason:'UPSTREAM_CODE_429'},
    {fetcher:fetchJson({code:200,results:{}}),status:'unavailable',reason:'INVALID_RESPONSE'},
    {fetcher:async()=>new Response('invalid json'),status:'unavailable',reason:'INVALID_JSON'},
    {fetcher:async()=>{throw new Error('https://private.invalid/?key=secret');},status:'unavailable',reason:'UPSTREAM_UNAVAILABLE'},
  ];
  for(const entry of cases) {
    const r=await gatherEvidenceReport(signal(),c,entry.fetcher,now);
    assert.deepEqual(r.evidence,[]);
    assert.deepEqual(r.diagnostics,[{operation:'search',status:entry.status,reason:entry.reason,returned:0}]);
  }
  const official=readConfig({X_DATA_PROVIDER:'x_official',X_BEARER_TOKEN:'test'});
  const r=await gatherEvidenceReport(signal(),official,fetchJson({meta:{result_count:0}}),now);
  assert.deepEqual(r.diagnostics,[{operation:'search',status:'empty',reason:'NO_RESULTS',returned:0}]);
});

test('第三方搜索明确选Latest，排除转推，并保留Solana地址大小写',async()=>{
  const c=readConfig({X_DATA_PROVIDER:'twitterapi_io',TWITTERAPI_IO_KEY:'test'});
  const s=signal({token:{chain:'solana',address:'So11111111111111111111111111111111111111112'}});
  const f:typeof fetch=async(url)=>{
    const u=new URL(String(url));assert.equal(u.pathname,'/twitter/tweet/advanced_search');
    assert.equal(u.searchParams.get('queryType'),'Latest');assert.ok(u.searchParams.get('query')?.includes(s.token.address));
    const p={id:'10',author:{id:'101'},text:s.token.address,createdAt:now.toUTCString()};
    return new Response(JSON.stringify({tweets:[p,{...p,id:'11',text:p.text.toLowerCase()},
      {...p,id:'12',retweeted_tweet:{id:'100'}}],has_next_page:true,next_cursor:'do-not-follow'}));
  };
  assert.equal((await gatherEvidence(s,c,f,now)).length,1);
});

test('Key缺失不会自动换渠道；错误、限流、坏JSON和伪成功均无证据',async()=>{
  for(const provider of ['x_official','twitterapi_io'] as const) {
    const c=readConfig({X_DATA_PROVIDER:provider});
    let calls=0;
    assert.deepEqual(await gatherEvidence(signal(),c,async()=>{calls++;throw new Error();},now),[]);
    assert.equal(calls,0);
  }
  const c=readConfig({X_DATA_PROVIDER:'fxembed'});
  for(const f of [fetchJson({code:500,results:[fxPost()]}),fetchJson({},429),fetchJson({code:200,results:{}}),
    (async()=>new Response('not json')) as typeof fetch]) assert.deepEqual(await gatherEvidence(signal(),c,f,now),[]);
  assert.throws(()=>readConfig({X_DATA_PROVIDER:'typo'}));
});

test('第三方可支持社区叙事，报告明确来源但不伪装原站核验',()=>{
  const r=validateNarrative(analysis(),thirdParty(),signal(),config(),now);
  assert.equal(r.status,'pass');assert.deepEqual(r.facts.evidenceProviders,['fxembed']);
  assert.equal(r.facts.hasThirdPartyEvidence,true);
  assert.ok(r.reasons.includes('THIRD_PARTY_EVIDENCE_NOT_INDEPENDENTLY_VERIFIED'));
});

test('第三方副本即使作者在发行者白名单也不能单独确认官方背书',()=>{
  const e=thirdParty();e[0].authority='issuer';
  const official={...analysis(),relation:'official' as const};
  const r=validateNarrative(official,e,signal({claim:'official'}),config(),now);
  assert.equal(r.status,'unknown');assert.deepEqual(r.reasons,['OFFICIAL_ENDORSEMENT_UNVERIFIED']);
  const original=evidence();original[0].authority='issuer';
  assert.equal(validateNarrative(official,original,signal({claim:'official'}),config(),now).status,'pass');
});

test('第三方不会放宽作者覆盖门槛，伪造核验级别和非法日期不放行',()=>{
  const e=thirdParty();e[0].authority='public';
  assert.equal(validateNarrative(analysis(),e,signal(),config(),now).status,'unknown');
  e.push({...e[0],id:'x:2',authorId:'102',text:`不同公开作者的帖子 ${signal().token.address}`});
  const a={...analysis(),supportingEvidenceIds:['x:1','x:2']};
  assert.equal(validateNarrative(a,e,signal(),config(),now).status,'pass');
  e[0].verification='first_party' as any;
  assert.equal(validateNarrative(a,e,signal(),config(),now).status,'unknown');
  const invalid=evidence();invalid[0].publishedAt='not-a-date';
  assert.equal(validateNarrative(analysis(),invalid,signal(),config(),now).status,'unknown');
});
