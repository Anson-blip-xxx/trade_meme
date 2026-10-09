import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNarrative,analyzeNarrative} from '../src/providers/narrative.js';
import {xPostId,gatherEvidence,mentionsAddress} from '../src/providers/evidence.js';
import {signal,config,evidence,analysis,now,fetchJson} from './helpers.js';

test('社区叙事无需名人背书',()=>{
  assert.equal(validateNarrative(analysis(),evidence(),signal(),config(),now).status,'pass');
});
test('模型引用不存在的证据不能放行',()=>{
  assert.equal(validateNarrative({...analysis(),supportingEvidenceIds:['invented']},evidence(),signal(),config(),now).status,'unknown');
});
test('真实平台发行和真实X帖子不能自动证明名人背书',()=>{
  assert.equal(validateNarrative({...analysis(),relation:'official'},evidence(),signal({claim:'official'}),config(),now).status,'unknown');
});
test('无完整合约关联、旧证据均不能买入',()=>{
  const e=evidence();e[0].text='只提到同一个词，没有合约';
  assert.equal(validateNarrative(analysis(),e,signal(),config(),now).status,'unknown');
  e[0]=evidence()[0];e[0].publishedAt='2026-09-01T12:00:00.000Z';
  assert.equal(validateNarrative(analysis(),e,signal(),config(),now).status,'unknown');
});
test('同一作者的多条推文不能算多个独立作者',()=>{
  const e=evidence();e[0].authority='public';e.push({...e[0],id:'x:2'});
  assert.equal(validateNarrative({...analysis(),supportingEvidenceIds:['x:1','x:2']},e,signal(),config(),now).status,'unknown');
});
test('证据URL不能导致SSRF或伪造X域名',()=>{
  assert.equal(xPostId('https://x.com/real/status/123'),'123');
  for(const url of ['http://127.0.0.1/admin','https://x.com.evil.test/a/status/123','https://x.com@evil.test/a/status/123']) assert.equal(xPostId(url),undefined);
});
test('X原帖抓取去重、排除转推，使用API作者身份',async()=>{
  const c=config();c.xBearer='test';
  const posts=[{id:'1',author_id:'101',created_at:now.toISOString(),text:'same'},
    {id:'2',author_id:'102',created_at:now.toISOString(),text:'same'},
    {id:'3',author_id:'103',created_at:now.toISOString(),text:'repost',referenced_tweets:[{type:'retweeted',id:'1'}]}];
  const e=await gatherEvidence(signal({evidenceUrls:posts.map(p=>`https://x.com/a/status/${p.id}`)}),c,fetchJson({data:posts}));
  assert.equal(e.length,1);assert.equal(e[0].authorId,'101');
});
test('未配置模型和拒答都不会伪造叙事',async()=>{
  assert.equal((await analyzeNarrative(signal(),evidence(),config(),now)).status,'unknown');
  const c=config();c.openaiKey='test';c.openaiModel='test';
  assert.equal((await analyzeNarrative(signal(),evidence(),c,now,fetchJson({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]}))).status,'unknown');
});
test('不能把更长字符串的地址前缀当成完整合约',()=>{
  assert.equal(mentionsAddress(signal().token.address+'f',signal()),false);
  assert.equal(mentionsAddress('CA: '+signal().token.address,signal()),true);
});
test('结构化模型成功返回后仍走引用和身份复核',async()=>{
  const c=config();c.openaiKey='test';c.openaiModel='configured-model';
  const f:typeof fetch=async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    const request=JSON.parse(String(init?.body));assert.equal(request.store,false);
    assert.equal(request.text.format.type,'json_schema');assert.equal(request.tools,undefined);
    return new Response(JSON.stringify({status:'completed',id:'response-test',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(analysis())}]}]}));
  };
  const r=await analyzeNarrative(signal(),evidence(),c,now,f);
  assert.equal(r.status,'pass');assert.equal(r.facts.responseId,'response-test');
});
test('只有CA时自动检索原帖，搜索结果仍检查完整地址',async()=>{
  const c=config();c.xBearer='test';
  const f:typeof fetch=async(url)=>{
    assert.equal(new URL(String(url)).pathname,'/2/tweets/search/recent');
    assert.ok(new URL(String(url)).searchParams.get('query')?.includes(signal().token.address));
    return new Response(JSON.stringify({data:[
      {id:'1',author_id:'101',created_at:now.toISOString(),text:'CA: '+signal().token.address},
      {id:'2',author_id:'102',created_at:now.toISOString(),text:'unrelated'}]}));
  };
  assert.equal((await gatherEvidence(signal(),c,f,now)).length,1);
});
