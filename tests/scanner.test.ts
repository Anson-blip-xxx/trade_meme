import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {GmgnError} from '../src/providers/gmgn-client.js';
import {GmgnScanner,normalizeGmgnTrades,type GmgnScannerClient} from '../src/scanner.js';
import type {Chain,Signal} from '../src/types.js';

const now=new Date('2026-10-08T12:00:00.000Z');
const timestamp=now.getTime()/1_000-20;
const token='0x'+ 'a'.repeat(40),maker='0x'+ 'b'.repeat(40),hash='0x'+ 'c'.repeat(64);
const trade=(overrides:Record<string,unknown>={})=>({transaction_hash:hash,maker,base_address:token,
  quote_address:'0x'+'d'.repeat(40),side:'buy',timestamp,...overrides});
const sequence=(i:number)=>trade({transaction_hash:'0x'+i.toString(16).padStart(64,'0')});
const norm=(list:unknown[])=>normalizeGmgnTrades({list},'bsc','kol',{now,maxAgeSec:600});
const options=(client:GmgnScannerClient,onSignal:(s:Signal)=>unknown|Promise<unknown>=()=>{})=>({
  client,chains:['bsc'] as Chain[],intervalMs:1_000,
  maxAgeSec:600,onSignal,now:()=>now,
});
const deferred=()=>{
  let resolve!:()=>void;
  const promise=new Promise<void>(r=>{resolve=r;});
  return {promise,resolve};
};

test('GMGN真实交易保留原timestamp与base CA；两种标签同事件幂等，不接收事后收益或发币来源标签',()=>{
  const payload={list:[trade({price_change:100,price_now:999,base_token:{symbol:'FAKE',launchpad:'pump'},
    maker_info:{twitter_username:'celebrity',tags:['kol','smart_degen']}})]};
  const [s]=normalizeGmgnTrades(payload,'bsc','kol',{now});
  assert.equal(s.token.address,token);assert.equal(s.occurredAt,new Date(timestamp*1_000).toISOString());
  assert.equal(s.source,'gmgn');assert.equal(s.claim,'unspecified');assert.deepEqual(s.evidenceUrls,[]);
  assert.equal(s.claimedPlatform,undefined);assert.equal(s.creationTx,undefined);
  assert.equal(s.vendorNarrative,undefined);assert.ok(s.sourceEventId.length<=160);
  assert.ok(s.text.includes(maker));assert.ok(s.text.includes(hash));
  for(const word of ['100','999','FAKE','celebrity','pump','price_change']) assert.ok(!s.text.includes(word));
  assert.deepEqual(normalizeGmgnTrades(payload,'bsc','smartmoney',{now}),[s]);
});

test('用tx+maker+CA+side组合去重；EVM大小写规范化，不把同交易的其他钱包或代币吞掉',()=>{
  const values=norm([trade(),trade({transaction_hash:hash.toUpperCase().replace('0X','0x'),
    maker:maker.toUpperCase().replace('0X','0x'),base_address:token.toUpperCase().replace('0X','0x')}),
    trade({maker:'0x'+'d'.repeat(40)}),trade({base_address:'0x'+'e'.repeat(40)}),sequence(1),trade({side:'sell'})]);
  assert.equal(values.length,4);assert.equal(new Set(values.map(s=>s.sourceEventId)).size,4);
  assert.deepEqual(values[0],norm([trade()])[0]);
});

test('缺失原交易字段、别名、旧事件、未来事件、毫秒时间和错误链均不能伪造新买入',()=>{
  const bad:Record<string,unknown>[]=[{side:'sell'},{side:'BUY'},{side:undefined},{timestamp:undefined},
    {timestamp:null},{timestamp:'not-time'},{timestamp:timestamp*1_000},{timestamp:timestamp+0.5},
    {timestamp:now.getTime()/1_000+31},{timestamp:now.getTime()/1_000-601},
    {transaction_hash:undefined,tx_hash:hash},{transaction_hash:hash.slice(0,-1)},
    {maker:undefined},{maker:maker.slice(0,-1)},{base_address:undefined,address:token},
    {base_address:token.slice(0,10)+'...4444'},{base_address:maker+'0'},
    {chain:'eth'},{chain:null},{chain:'solana'},{base_token:{chain:'eth'}}];
  assert.deepEqual(norm([null,[],{},...bad.map(v=>trade(v))]),[]);
  assert.equal(norm([trade({timestamp:String(timestamp),chain:'bsc'})]).length,1);
  assert.deepEqual(normalizeGmgnTrades({chain:'eth',list:[trade()]},'bsc','kol',{now}),[]);
});

test('Solana按完整base58字节长度校验，链参数使用sol，Robinhood保留本链身份',()=>{
  const solToken=bs58.encode(new Uint8Array(32).fill(11)),solMaker=bs58.encode(new Uint8Array(32).fill(12));
  const solHash=bs58.encode(new Uint8Array(64).fill(13));
  const sol=trade({chain:'sol',base_address:solToken,maker:solMaker,transaction_hash:solHash});
  const [s]=normalizeGmgnTrades({chain:'sol',list:[sol]},'solana','smartmoney',{now});
  assert.equal(s.token.chain,'solana');assert.equal(s.token.address,solToken);
  assert.ok(s.text.includes(solHash));
  assert.deepEqual(normalizeGmgnTrades({list:[{...sol,transaction_hash:solToken}]},'solana','kol',{now}),[]);
  assert.deepEqual(normalizeGmgnTrades({list:[sol]},'bsc','kol',{now}),[]);
  const [r]=normalizeGmgnTrades({list:[trade({chain:'robinhood'})]},'robinhood','kol',{now});
  assert.equal(r.token.chain,'robinhood');assert.notEqual(r.sourceEventId,norm([trade()])[0].sourceEventId);
});

test('只接受解包后的list；缺列表不猜替代结构；即使供应商超量也只处理一页上限',()=>{
  for(const payload of [undefined,null,[],[trade()],{data:{list:[trade()]}},{trades:[trade()]},{list:'wrong'}]) {
    assert.deepEqual(normalizeGmgnTrades(payload,'bsc','kol',{now}),[]);
  }
  assert.equal(norm(Array.from({length:201},(_,i)=>sequence(i))).length,200);
  assert.deepEqual(normalizeGmgnTrades({list:[trade()]},'bsc','kol',{now:new Date(NaN)}),[]);
});

test('轮询三链两种官方GET，正确参数且没有side过滤或并行请求，回调也顺序执行',async()=>{
  const calls:{path:string;query:Record<string,string|number>;weight?:number}[]=[];
  let requesting=0,callbacks=0,callbackPeak=0;
  const seen:Signal[]=[];
  const client:GmgnScannerClient={get:async(path,query,weight)=>{
    assert.equal(++requesting,1);await Promise.resolve();requesting--;
    calls.push({path,query,weight});
    if(query.chain==='sol') return {list:[]};
    return {list:[trade({chain:query.chain})],next_page_token:'never-follow'};
  }};
  const scanner=new GmgnScanner({...options(client,async s=>{
    callbackPeak=Math.max(callbackPeak,++callbacks);await Promise.resolve();seen.push(s);callbacks--;
  }),chains:['bsc','solana','robinhood'],maxSignalsPerCycle:10});
  const report=await scanner.runOnce();
  assert.deepEqual(calls.map(c=>[c.path,c.query.chain]),[
    ['/v1/user/kol','bsc'],['/v1/user/smartmoney','bsc'],['/v1/user/kol','sol'],
    ['/v1/user/smartmoney','sol'],['/v1/user/kol','robinhood'],['/v1/user/smartmoney','robinhood']]);
  assert.ok(calls.every(c=>c.query.limit===100&&c.weight===1&&Object.keys(c.query).length===2));
  assert.equal(report.requests,6);assert.equal(report.emitted,2);assert.equal(report.duplicates,2);
  assert.equal(report.errors,0);assert.equal(callbackPeak,1);assert.equal(seen.length,2);
  assert.equal(scanner.getStatus().inFlight,false);
  assert.equal((await scanner.runOnce()).emitted,0);
});

test('本轮回调数量有界，未处理事件下轮可继续；跨轮和跨feed均去重',async()=>{
  const seen:Signal[]=[];
  const scanner=new GmgnScanner({...options({get:async()=>({list:[sequence(1),sequence(2),sequence(3)]})},
    s=>{seen.push(s);}),maxSignalsPerCycle:2});
  const first=await scanner.runOnce();assert.equal(first.emitted,2);assert.equal(first.deferred,1);
  const second=await scanner.runOnce();assert.equal(second.emitted,1);
  assert.equal((await scanner.runOnce()).emitted,0);assert.equal(seen.length,3);
});

test('单个回调失败不会永久吞掉信号，同轮不重复重试且失败也计入数量上限',async()=>{
  let attempts=0;
  const scanner=new GmgnScanner({...options({get:async()=>({list:[trade(),sequence(1)]})},()=>{
    if(++attempts===1) throw new Error('private api key must never appear');
  }),maxSignalsPerCycle:1});
  const failed=await scanner.runOnce();
  assert.equal(failed.status,'partial');assert.equal(failed.errors,1);assert.equal(failed.emitted,0);
  assert.equal(attempts,1);assert.ok(failed.reasons.includes('GMGN_SIGNAL_CALLBACK_FAILED'));
  assert.ok(!JSON.stringify(failed).includes('private api key'));
  assert.equal((await scanner.runOnce()).emitted,1);assert.equal(attempts,2);
});

test('重入runOnce共享执行，不重复请求或回调',async()=>{
  const gate=deferred();let calls=0,emitted=0;
  const scanner=new GmgnScanner(options({get:async()=>{calls++;await gate.promise;return {list:[trade()]};}},()=>{emitted++;}));
  const first=scanner.runOnce(),second=scanner.runOnce();
  assert.equal(first,second);assert.equal(scanner.getStatus().inFlight,true);assert.equal(calls,1);
  gate.resolve();await Promise.all([first,second]);
  assert.equal(calls,2);assert.equal(emitted,1);assert.equal(scanner.getStatus().inFlight,false);
});

test('429即停止本轮，不在冷却期请求或触发下游；到期后可恢复',async()=>{
  let clock=now.getTime(),calls=0,emitted=0;
  const scanner=new GmgnScanner({...options({get:async()=>{
    if(++calls===2) throw new GmgnError('GMGN_RATE_LIMITED',clock+90_000,clock);
    return {list:[trade()]};
  }},()=>{emitted++;}),chains:['bsc','robinhood'],now:()=>new Date(clock)});
  const limited=await scanner.runOnce();
  assert.equal(limited.status,'cooldown');assert.equal(limited.requests,2);assert.equal(limited.deferred,1);
  assert.equal(emitted,0);assert.equal(limited.cooldownUntil,new Date(clock+90_000).toISOString());
  assert.equal((await scanner.runOnce()).requests,0);assert.equal(calls,2);
  clock+=90_001;
  assert.equal((await scanner.runOnce()).status,'ok');assert.equal(calls,6);assert.equal(emitted,2);
});

test('Key缺失或认证失败仅尝试一次；任意错误信息和上游内容不泄露进诊断',async()=>{
  for(const reason of ['GMGN_API_KEY_MISSING','GMGN_AUTH_FAILED'] as const) {
    let calls=0;
    const scanner=new GmgnScanner(options({get:async()=>{calls++;throw new GmgnError(reason);}}));
    const r=await scanner.runOnce();assert.equal(calls,1);assert.equal(r.diagnostics[0].reason,reason);
  }
  const scanner=new GmgnScanner(options({get:async()=>{throw new Error('secret key in upstream URL');}}));
  const r=await scanner.runOnce();assert.equal(r.errors,2);assert.equal(r.status,'partial');
  assert.ok(!JSON.stringify(r).includes('secret'));assert.equal(r.diagnostics[0].reason,'GMGN_REQUEST_FAILED');
});

test('尊重其他同Key调用建立的共享冷却，回调之间新出现限流时也停止后续研究',async()=>{
  let clock=now.getTime(),cooldownUntil=clock+20_000,calls=0,emitted=0;
  const client:GmgnScannerClient={get cooldownUntil(){return cooldownUntil;},get:async()=>{
    calls++;return {list:[sequence(1),sequence(2)]};
  }};
  const scanner=new GmgnScanner({...options(client,()=>{emitted++;cooldownUntil=clock+30_000;}),
    now:()=>new Date(clock)});
  assert.equal((await scanner.runOnce()).status,'cooldown');assert.equal(calls,0);
  clock+=20_001;
  const report=await scanner.runOnce();
  assert.equal(calls,2);assert.equal(emitted,1);assert.equal(report.status,'cooldown');assert.equal(report.deferred,1);
  assert.equal(scanner.getStatus().cooldownUntil,new Date(cooldownUntil).toISOString());
});

test('空结果、结构漂移和链不符分别诊断，不能当作合法买入',async()=>{
  const responses=[{list:[]},{trades:[trade()]},{chain:'eth',list:[trade()]}];
  const scanner=new GmgnScanner({...options({get:async()=>responses.shift()??{list:[]}}),chains:['bsc','robinhood']});
  const r=await scanner.runOnce();assert.equal(r.emitted,0);assert.equal(r.status,'partial');
  assert.equal(r.diagnostics[0].status,'empty');
  assert.equal(r.diagnostics[1].reason,'GMGN_FEED_SCHEMA_INVALID');
  assert.equal(r.diagnostics[2].reason,'GMGN_FEED_CHAIN_MISMATCH');
});

test('GET或排队回调期间事件过期时重新核验，不用抓取时间续命',async()=>{
  let clock=now.getTime(),calls=0;
  const scanner=new GmgnScanner({...options({get:async()=>{
    if(++calls===2) clock+=601_000;
    return {list:[trade()]};
  }},()=>assert.fail('stale event must not dispatch')),now:()=>new Date(clock)});
  const report=await scanner.runOnce();assert.equal(report.emitted,0);assert.ok(report.rejected>=1);
});

test('TTL按事件到期释放；相同旧记录不会由于缓存清理重新触发',async()=>{
  let clock=now.getTime();
  const scanner=new GmgnScanner({...options({get:async()=>({list:[trade()]})}),now:()=>new Date(clock)});
  assert.equal((await scanner.runOnce()).emitted,1);assert.equal(scanner.getStatus().seenEntries,1);
  clock+=601_000;
  assert.equal((await scanner.runOnce()).emitted,0);assert.equal(scanner.getStatus().seenEntries,0);
});

test('高流量去重内存有界且不驱逐仍新鲜的记录造成重复回调',async()=>{
  let counter=0;
  const scanner=new GmgnScanner({...options({get:async()=>({list:Array.from({length:200},()=>sequence(++counter))})}),
    maxSignalsPerCycle:200});
  for(let i=0;i<25;i++) assert.equal((await scanner.runOnce()).emitted,200);
  const report=await scanner.runOnce();
  assert.equal(scanner.getStatus().seenEntries,5_000);assert.equal(report.emitted,0);
  assert.equal(report.deferred,400);assert.ok(report.reasons.includes('GMGN_DEDUP_CAPACITY'));
});

test('stop抑制尚未返回的GET结果及后续请求，start/stop不会重叠定时任务',async t=>{
  const gate=deferred();let calls=0,emitted=0;
  const scanner=new GmgnScanner(options({get:async()=>{calls++;await gate.promise;return {list:[trade()]};}},()=>{emitted++;}));
  scanner.start();scanner.start();assert.equal(calls,1);
  const flight=scanner.runOnce();scanner.stop();gate.resolve();
  assert.equal((await flight).status,'stopped');assert.equal(calls,1);assert.equal(emitted,0);
  assert.equal(scanner.getStatus().running,false);

  t.mock.timers.enable({apis:['setTimeout']});
  const polling=new GmgnScanner({...options({get:async()=>{calls++;return {list:[]};}}),intervalMs:1_000});
  t.after(()=>polling.stop());
  polling.start();await polling.runOnce();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(calls,3);
  t.mock.timers.tick(999);assert.equal(calls,3);
  t.mock.timers.tick(1);await polling.runOnce();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(calls,5);
  polling.stop();t.mock.timers.tick(100_000);assert.equal(calls,5);
});
