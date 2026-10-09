import test from 'node:test';
import assert from 'node:assert/strict';
import {ZodError} from 'zod';
import {normalizeNotification,NotificationError} from '../src/notifications.js';

const evm='0x1234567890abcdef1234567890abcdef12345678';
const otherEvm='0xabcdef1234567890abcdef1234567890abcdef12';
const sol='So11111111111111111111111111111111111111112';
const input=(overrides:Record<string,unknown>={})=>({source:'debot',chain:'bsc',
  occurredAt:'2026-10-08T20:00:00+08:00',text:`原始告警 CA: ${evm}`,...overrides});
const errorCode=(code:string)=>(error:unknown)=>error instanceof NotificationError&&error.code===code;

test('复制告警保留原文和原发生时间，时区规范化且不推断平台或背书',()=>{
  const text=`DeBot 阴谋盘 金狗 Four 官方喊单 ${evm}`;
  const signal=normalizeNotification(input({text}));
  assert.equal(signal.occurredAt,'2026-10-08T12:00:00.000Z');
  assert.equal(signal.text,text);assert.deepEqual(signal.token,{chain:'bsc',address:evm});
  assert.equal(signal.source,'debot');assert.equal(signal.claim,'unspecified');
  assert.equal(signal.claimedPlatform,undefined);assert.equal(signal.creationTx,undefined);
  assert.deepEqual(signal.evidenceUrls,[]);
  assert.match(signal.sourceEventId,/^manual-import:[0-9a-f]{64}$/);
  assert.equal('goldDog' in signal,false);assert.equal('verified' in signal,false);
});

test('输入要求明确来源、链、带时区的原告警时间及原文，拒绝未知字段',()=>{
  for(const field of ['source','chain','occurredAt','text']) {
    const value:Record<string,unknown>=input();delete value[field];
    assert.throws(()=>normalizeNotification(value),ZodError);
  }
  for(const occurredAt of ['2026-10-08T12:00:00','2026-10-08','2026-02-30T12:00:00Z','now']) {
    assert.throws(()=>normalizeNotification(input({occurredAt})),ZodError);
  }
  for(const extra of [{goldDog:true},{maxGain:10},{receivedAt:'2026-10-08T12:00:00Z'},
    {chain:'eth'},{source:'trusted'},{text:'   '}]) assert.throws(()=>normalizeNotification(input(extra)),ZodError);
});

test('保留历史和未来时间供后续时效检查，不把告警改写成导入时间',()=>{
  for(const occurredAt of ['2020-01-01T00:00:00Z','2099-01-01T00:00:00Z']) {
    assert.equal(normalizeNotification(input({occurredAt})).occurredAt,new Date(occurredAt).toISOString());
  }
});

test('同地址大小写与重复出现不造成EVM歧义，BSC和Robinhood始终显式指定',()=>{
  const upper='0x'+evm.slice(2).toUpperCase();
  for(const chain of ['bsc','robinhood']) {
    const signal=normalizeNotification(input({chain,text:`${upper}\n${evm}`,address:upper}));
    assert.deepEqual(signal.token,{chain,address:evm});
  }
});

test('多个地址不静默选择，显式选择必须与正文候选一致',()=>{
  const value=input({text:`买入 ${evm}，支付 ${otherEvm}`});
  assert.throws(()=>normalizeNotification(value),errorCode('ADDRESS_AMBIGUOUS'));
  assert.equal(normalizeNotification({...value,address:otherEvm}).token.address,otherEvm);
  assert.throws(()=>normalizeNotification({...value,address:'0x1111111111111111111111111111111111111111'}),errorCode('ADDRESS_MISMATCH'));
});

test('正文没有CA可显式补充，截断CA和畸形CA不能自动选中',()=>{
  assert.equal(normalizeNotification(input({text:'有独立复制出的完整 CA',address:evm})).token.address,evm);
  for(const text of ['没有地址','0x1234…5678',evm+'f',evm+'g','a'+evm]) {
    assert.throws(()=>normalizeNotification(input({text})),errorCode('ADDRESS_MISSING'));
  }
  for(const address of ['0x1234',sol,evm+'f']) assert.throws(()=>normalizeNotification(input({address})),ZodError);
});

test('Solana保持大小写，检查32字节base58，不接受合法前缀或大小写不同的显式地址',()=>{
  const value=input({chain:'solana',text:`SOL CA: ${sol}`});
  assert.equal(normalizeNotification(value).token.address,sol);
  for(const text of ['1'.repeat(33),sol+'0','0'+sol,evm]) {
    assert.throws(()=>normalizeNotification({...value,text}),errorCode('ADDRESS_MISSING'));
  }
  assert.throws(()=>normalizeNotification({...value,address:'1'.repeat(33)}),ZodError);
  // Lowercasing changes a Solana public key, even if the result still decodes correctly.
  assert.throws(()=>normalizeNotification({...value,address:sol.toLowerCase()}),
    e=>e instanceof ZodError||errorCode('ADDRESS_MISMATCH')(e));
  const zero='1'.repeat(32);
  assert.throws(()=>normalizeNotification({...value,text:`${sol} ${zero}`}),errorCode('ADDRESS_AMBIGUOUS'));
  assert.equal(normalizeNotification({...value,text:`${sol} ${zero}`,address:sol}).token.address,sol);
});

test('提取正文真实X原帖，合并显式链接、移除文末标点并按帖子ID去重',()=>{
  const signal=normalizeNotification(input({
    text:`${evm}\n[原文](https://x.com/alice/status/123?s=20)。\nhttps://twitter.com/bob/status/456，\nhttps://x.com/i/web/status/123`,
    evidenceUrls:['https://www.twitter.com/changed_name/status/123','https://x.com/c/status/789#thread'],
  }));
  assert.deepEqual(signal.evidenceUrls,['123','789','456'].map(id=>`https://x.com/i/web/status/${id}`));
});

test('显式证据拒绝伪X域名、凭证、端口、非HTTPS、非帖子及任意URL',()=>{
  for(const url of ['https://x.com.evil.test/alice/status/123','https://evil.test/x.com/alice/status/123',
    'https://x.com@evil.test/alice/status/123','https://user@x.com/alice/status/123',
    'https://x.com:8443/alice/status/123','http://x.com/alice/status/123',
    'https://x.com/alice','https://debot.ai/token/bsc/'+evm,
    'https://x.com/alice/status/123/photo/1','https://x.com/alice/status/notanid']) {
    assert.throws(()=>normalizeNotification(input({evidenceUrls:[url]})),ZodError);
  }
});

test('正文可含普通链接，但伪域名及任意URL均不会转换为证据',()=>{
  const text=`${evm}\nhttps://x.com.evil.test/a/status/123 https://debot.ai/token/bsc/${evm} https://example.com`;
  const signal=normalizeNotification(input({text}));
  assert.equal(signal.text,text);assert.deepEqual(signal.evidenceUrls,[]);
});

test('合并后的帖子数量仍有上限，不静默截断或接受超量',()=>{
  const evidenceUrls=Array.from({length:12},(_,i)=>`https://x.com/a/status/${i+1}`);
  assert.throws(()=>normalizeNotification(input({evidenceUrls,text:`${evm} https://x.com/a/status/13`})),ZodError);
});

test('本地ID确定性包含原文、来源、链、CA和原时间，已有供应商ID原样保留',()=>{
  const base=normalizeNotification(input());
  assert.equal(normalizeNotification(input()).sourceEventId,base.sourceEventId);
  assert.equal(normalizeNotification(input({occurredAt:'2026-10-08T12:00:00.000Z'})).sourceEventId,base.sourceEventId);
  assert.equal(normalizeNotification(input({address:'0x'+evm.slice(2).toUpperCase()})).sourceEventId,base.sourceEventId);
  for(const changes of [{source:'gmgn'},{chain:'robinhood'},
    {occurredAt:'2026-10-08T12:00:01Z'},{text:`原始告警 CA: ${evm}\n`},
    {text:`原始告警 CA: ${otherEvm}`}]) {
    assert.notEqual(normalizeNotification(input(changes)).sourceEventId,base.sourceEventId);
  }
  const ambiguousText=`${evm} ${otherEvm}`;
  assert.notEqual(normalizeNotification(input({text:ambiguousText,address:evm})).sourceEventId,
    normalizeNotification(input({text:ambiguousText,address:otherEvm})).sourceEventId);
  assert.equal(normalizeNotification(input({sourceEventId:'vendor-original-1'})).sourceEventId,'vendor-original-1');
});

test('显式平台和关系只原样传递且创建交易仍使用核心Signal校验',()=>{
  const creationTx='0x'+'ab'.repeat(32);
  const signal=normalizeNotification(input({claimedPlatform:'four',claim:'community',creationTx}));
  assert.equal(signal.claimedPlatform,'four');assert.equal(signal.claim,'community');assert.equal(signal.creationTx,creationTx);
  assert.throws(()=>normalizeNotification(input({creationTx:'0x123'})),ZodError);
});

const vendorNarrative=(overrides:Record<string,unknown>={})=>({
  provider:'debot',token:{chain:'bsc',address:evm},sourceUrl:`https://debot.ai/token/bsc/${evm}`,
  text:'供应商原始叙事；未经独立核验。',updatedAt:'2026-10-08T20:00:03+08:00',evidenceUrls:[],...overrides,
});

test('供应商叙事保留原文、明确更新时间和来源，原帖引用合并且不修改供应商对象',()=>{
  const vendor=vendorNarrative({evidenceUrls:['https://twitter.com/a/status/123','https://x.com/b/status/456']});
  const before=structuredClone(vendor);
  const signal=normalizeNotification(input({vendorNarrative:vendor,evidenceUrls:['https://x.com/a/status/123']}));
  assert.deepEqual(signal.vendorNarrative,before);assert.deepEqual(vendor,before);
  assert.equal(signal.vendorNarrative?.updatedAt,'2026-10-08T20:00:03+08:00');
  assert.equal(signal.occurredAt,'2026-10-08T12:00:00.000Z');
  assert.deepEqual(signal.evidenceUrls,['123','456'].map(id=>`https://x.com/i/web/status/${id}`));
  const gmgn=vendorNarrative({provider:'gmgn',sourceUrl:`https://gmgn.ai/bsc/token/${evm}`});
  assert.deepEqual(normalizeNotification(input({source:'gmgn',vendorNarrative:gmgn})).vendorNarrative,gmgn);
});

test('供应商叙事错币或错链均拒绝，不用叙事里的CA替换原信号目标',()=>{
  for(const token of [{chain:'bsc',address:otherEvm},{chain:'robinhood',address:evm}]) {
    assert.throws(()=>normalizeNotification(input({vendorNarrative:vendorNarrative({token})})),ZodError);
  }
  const upper='0x'+evm.slice(2).toUpperCase();
  const vendor=vendorNarrative({token:{chain:'bsc',address:upper}});
  assert.equal(normalizeNotification(input({vendorNarrative:vendor})).vendorNarrative?.token.address,upper);
  const solVendor=vendorNarrative({token:{chain:'solana',address:sol.toLowerCase()}});
  assert.throws(()=>normalizeNotification(input({chain:'solana',text:sol,vendorNarrative:solVendor})),ZodError);
});

test('供应商来源链接拒绝伪域、凭证、协议和不匹配的平台',()=>{
  for(const sourceUrl of ['https://debot.ai.evil.test/token','https://debot.ai@evil.test/token',
    'https://user@debot.ai/token','http://debot.ai/token','https://gmgn.ai/token','https://debot.ai:8443/token']) {
    assert.throws(()=>normalizeNotification(input({vendorNarrative:vendorNarrative({sourceUrl})})),ZodError);
  }
});

test('供应商叙事缺更新时间时保持未知，不以告警时间或导入时间补写',()=>{
  const vendor=vendorNarrative();delete (vendor as Record<string,unknown>).updatedAt;
  const signal=normalizeNotification(input({vendorNarrative:vendor}));
  assert.equal(signal.vendorNarrative?.updatedAt,undefined);
  assert.equal(Object.hasOwn(signal.vendorNarrative!,'updatedAt'),false);
  assert.equal(Object.hasOwn(vendor,'updatedAt'),false);
  assert.throws(()=>normalizeNotification(input({vendorNarrative:vendorNarrative({updatedAt:'2026-10-08T20:00:03'})})),ZodError);
});

test('外部输入不能预设供应商叙事的status、pass或核验结论',()=>{
  for(const injected of [{status:'pass'},{pass:true},{verification:'first_party'},{assessment:'favorable'}]) {
    assert.throws(()=>normalizeNotification(input({...injected,vendorNarrative:vendorNarrative()})),ZodError);
    assert.throws(()=>normalizeNotification(input({vendorNarrative:vendorNarrative(injected)})),ZodError);
  }
});

test('供应商引用的非原帖或伪域仍保留原始记录，但不会成为信号社交证据',()=>{
  const vendor=vendorNarrative({evidenceUrls:['https://x.com.evil.test/a/status/123','https://example.com',
    'https://x.com/a','https://x.com/a/status/456']});
  const signal=normalizeNotification(input({vendorNarrative:vendor}));
  assert.deepEqual(signal.vendorNarrative,vendor);
  assert.deepEqual(signal.evidenceUrls,['https://x.com/i/web/status/456']);
});
