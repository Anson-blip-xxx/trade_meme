import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ZodError} from 'zod';
import {normalizeDebotStory} from '../src/providers/debot-story.js';
import type {Signal} from '../src/types.js';

const fixture=()=>JSON.parse(readFileSync(new URL('../fixtures/debot-story-v2.example.json',import.meta.url),'utf8'));
const token:Signal['token']={chain:'bsc',address:'0xc24f42b1e458251e3a128b74c65c4c7fa0c97777'};
const sourceUrl=`https://debot.ai/token/bsc/248286_${token.address}`;
const normalize=(payload:unknown)=>normalizeDebotStory(payload,token,sourceUrl);

test('真实Umi v2样本保留中文全部字段、原评分、38条来源ID，只选择8条抓取引用',()=>{
  const payload=fixture(),before=structuredClone(payload),history=payload.data.history;
  const result=normalize(payload),structured=result.structured!;
  assert.deepEqual(payload,before);
  assert.equal(result.provider,'debot');assert.deepEqual(result.token,token);assert.equal(result.sourceUrl,sourceUrl);
  assert.equal(result.updatedAt,'2026-10-08T06:31:41.032Z');assert.equal(Object.hasOwn(result,'occurredAt'),false);
  assert.equal(structured.format,'debot_story_v2');assert.equal(structured.historyId,history.id);
  assert.equal(structured.projectName,'Umi');assert.equal(structured.narrativeType,'项目类');
  assert.deepEqual(structured.rating,history.story.rating);assert.equal(structured.rating.score,'2');
  assert.equal(structured.sourceTweetIds.length,38);assert.deepEqual(structured.sourceTweetIds,history.source_tweets);
  assert.deepEqual(result.evidenceUrls,history.source_tweets.slice(0,8).map((id:string)=>`https://x.com/i/web/status/${id}`));
  assert.equal(structured.sections.length,13);
  for(const section of structured.sections) {
    const original=section.path.split('.').reduce((value:any,key:string)=>value[key],history.story);
    assert.equal(section.text,typeof original==='object'?original.text:original);
    assert.equal(section.reference,'');
    if(section.text) assert.ok(result.text.includes(section.text));
  }
  assert.match(result.text,/最高浏览量：单条推文最高浏览量约832次/);
  assert.match(result.text,/地址分析：开发者持仓显示为0%/);
  assert.match(result.text,/当前市值：市值波动于6\.5万至12\.9万美元/);
  assert.match(result.text,/未经本服务链上独立核验/);
  assert.ok(result.text.includes(history.story.rating.reason));
  assert.match(result.text,/原始评分：2（评分满分未知，未归一化）/);
  assert.equal('status' in result,false);assert.equal('assessment' in result,false);
});

test('只接受明确成功的v2结构，不从错误响应或翻译回填中文故事',()=>{
  for(const edit of [
    (p:any)=>{p.code=1;},(p:any)=>{p.code='0';},(p:any)=>{p.success=false;},
    (p:any)=>{p.success='true';},(p:any)=>{p.data.version='v3';},(p:any)=>{delete p.data.version;},
    (p:any)=>{p.data.history.story_en=p.data.history.story;delete p.data.history.story;},
    (p:any)=>{p.data.history.story.rating.score=2;},
  ]) {const payload=fixture();edit(payload);assert.throws(()=>normalize(payload),ZodError);}
});

test('history CA和story CA必须分别匹配目标，EVM允许等价大小写',()=>{
  const wrong='0x1111111111111111111111111111111111111111';
  for(const edit of [(p:any)=>{p.data.history.ca_address=wrong;},
    (p:any)=>{p.data.history.story.contract_address=wrong;}]) {
    const payload=fixture();edit(payload);assert.throws(()=>normalize(payload),ZodError);
  }
  const payload=fixture(),upper='0x'+token.address.slice(2).toUpperCase();
  payload.data.history.ca_address=upper;payload.data.history.story.contract_address=upper;
  assert.equal(normalize(payload).structured?.projectName,'Umi');
  assert.throws(()=>normalizeDebotStory(fixture(),{chain:'bsc',address:'truncated'},sourceUrl),ZodError);
  assert.throws(()=>normalizeDebotStory(fixture(),{chain:'eth',address:token.address} as any,sourceUrl),ZodError);
});

test('来源页面验证精确域名、路径链和CA，不接受页面与响应错配',()=>{
  for(const url of [sourceUrl.replace('debot.ai','debot.ai.evil.test'),sourceUrl.replace('debot.ai','debot.ai@evil.test'),
    sourceUrl.replace('https:','http:'),sourceUrl.replace('/bsc/','/robinhood/'),
    sourceUrl.replace(token.address,'0x1111111111111111111111111111111111111111'),
    `https://debot.ai/token/bsc/${token.address}/extra`,'https://debot.ai/',
    sourceUrl.replace('debot.ai','user@debot.ai'),sourceUrl.replace('debot.ai','debot.ai:8443'),'not-a-url']) {
    assert.throws(()=>normalizeDebotStory(fixture(),token,url),ZodError);
  }
  assert.equal(normalizeDebotStory(fixture(),token,`https://www.debot.ai/token/bsc/${token.address}`).provider,'debot');
  assert.throws(()=>normalizeDebotStory(fixture(),{...token,chain:'robinhood'},sourceUrl),ZodError);
});

test('Solana地址和页面CA保留大小写，不跨链猜测',()=>{
  const mint='So11111111111111111111111111111111111111112',payload=fixture();
  payload.data.history.ca_address=mint;payload.data.history.story.contract_address=mint;
  const target:Signal['token']={chain:'solana',address:mint},page=`https://debot.ai/token/solana/${mint}`;
  assert.equal(normalizeDebotStory(payload,target,page).token.address,mint);
  assert.equal(normalizeDebotStory(payload,target,page.replace('/solana/','/sol/')).token.chain,'solana');
  payload.data.history.story.contract_address=mint.toLowerCase();
  assert.throws(()=>normalizeDebotStory(payload,target,page),ZodError);
});

test('缺失或不明确generated_at直接拒绝，原生成时间只用作叙事更新时间',()=>{
  for(const generatedAt of [undefined,'2026-10-08T06:31:41','now','2026-02-30T06:31:41Z']) {
    const payload=fixture();payload.data.history.generated_at=generatedAt;
    assert.throws(()=>normalize(payload),ZodError);
  }
  const payload=fixture();payload.data.history.generated_at='2020-01-01T08:00:00+08:00';
  const result=normalize(payload);
  assert.equal(result.updatedAt,payload.data.history.generated_at);assert.equal('occurredAt' in result,false);
});

test('先选字段ref中的有效原帖，再选source_tweets，去重并限8但完整来源记录不截断',()=>{
  const payload=fixture(),history=payload.data.history,story=history.story;
  story.background.origin.ref='https://twitter.com/user/status/111';
  story.distribution.celebrity_support.ref='https://x.com/other/status/111?s=20';
  story.distribution.negative_incidents.ref='[证据](https://x.com/user/status/222)。';
  story.developer_info.identity.ref='https://x.com.evil.test/user/status/333';
  story.developer_info.address_analysis.ref='https://example.com/report';
  history.source_tweets=[...history.source_tweets,'111',history.source_tweets[0]];
  const result=normalize(payload);
  assert.deepEqual(result.evidenceUrls,['111','222',...history.source_tweets.slice(0,6)].map(id=>`https://x.com/i/web/status/${id}`));
  assert.deepEqual(result.structured?.sourceTweetIds,history.source_tweets);
  assert.equal(result.structured?.sections.find(s=>s.path==='developer_info.identity')?.reference,
    'https://x.com.evil.test/user/status/333');
  assert.ok(!result.evidenceUrls.some(url=>url.endsWith('/333')));
});

test('翻译不算多份叙事，额外服务器状态和成绩标签不变成决策字段',()=>{
  const payload=fixture(),base=normalize(payload);
  payload.data.history.story_en={project_name:'TRANSLATED_COPY',text:'translation-only'};
  payload.data.history.story_ja={text:'second-translation-only'};
  payload.data.history.goldDog=true;payload.data.history.max_gain=100;payload.data.history.status='pass';
  assert.deepEqual(normalize(payload),base);
});

test('原始推文ID保持字符串精度，非法ID和超出完整存储容量的响应拒绝',()=>{
  for(const source_tweets of [['https://x.com/a/status/111'],['not-an-id'],[2108082333513322654],Array(2001).fill('111')]) {
    const payload=fixture();payload.data.history.source_tweets=source_tweets;
    assert.throws(()=>normalize(payload),ZodError);
  }
  const payload=fixture();payload.data.history.source_tweets=[];
  assert.deepEqual(normalize(payload).evidenceUrls,[]);
});

test('非法文本字段和超深层结构拒绝，不悄悄丢弃全文',()=>{
  const invalidText=fixture();invalidText.data.history.story.background.origin.text={status:'pass'};
  assert.throws(()=>normalize(invalidText),ZodError);
  const invalidRef=fixture();invalidRef.data.history.story.background.origin.ref=123;
  assert.throws(()=>normalize(invalidRef),ZodError);
  const deep=fixture();let nested:any='leaf';for(let i=0;i<12;i++) nested={level:nested};
  deep.data.history.story.background.extra=nested;assert.throws(()=>normalize(deep),ZodError);
});
