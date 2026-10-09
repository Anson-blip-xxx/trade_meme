import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {normalizeDebotImport} from '../src/debot-import.js';
import {fetchDebotNarrative} from '../src/providers/debot-client.js';
import {liveProviders} from '../src/engine.js';
import {buildServer} from '../src/server.js';
import {Store} from '../src/store.js';
import {config,providers} from './helpers.js';

const fixture=()=>JSON.parse(readFileSync(new URL('../fixtures/debot-story-v2.example.json',import.meta.url),'utf8'));
const ca='0xc24f42b1e458251e3a128b74c65c4c7fa0c97777';
const sourceUrl=`https://debot.ai/token/bsc/248286_${ca}`;
const imported=()=>({token:{chain:'bsc',address:ca},sourceUrl,
  occurredAt:'2026-10-08T14:30:00+08:00',payload:fixture()});

test('DeBot 导入要求原始信号时间，生成时间只标记叙事版本，CLI 可离线校验',()=>{
  const input=imported(),s=normalizeDebotImport(input);
  assert.equal(s.occurredAt,'2026-10-08T06:30:00.000Z');
  assert.equal(s.vendorNarrative?.updatedAt,input.payload.data.history.generated_at);
  assert.notEqual(s.occurredAt,s.vendorNarrative?.updatedAt);
  assert.equal(s.vendorNarrative?.structured?.rating.score,'2');
  assert.match(s.vendorNarrative!.structured!.rating.reason,/不建议关注/);
  assert.deepEqual(normalizeDebotImport(input),s);
  const {occurredAt,...missing}=input;
  assert.throws(()=>normalizeDebotImport(missing));
  assert.throws(()=>normalizeDebotImport({...input,occurredAt:'2026-10-08T14:30:00'}));
  assert.throws(()=>normalizeDebotImport({...input,token:{chain:'bsc',address:'0x'+'1'.repeat(40)}}));
  const directory=mkdtempSync(join(tmpdir(),'debot-import-'));
  try {
    const path=join(directory,'response.json');writeFileSync(path,JSON.stringify(input));
    const run=spawnSync(process.execPath,['--import','tsx','src/cli.ts','--debot-story','--normalize-only',path],
      {cwd:new URL('..',import.meta.url),encoding:'utf8',env:{PATH:process.env.PATH,DATABASE_PATH:join(directory,'unused.db')}});
    assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),s);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('HTTP 信号自动取 DeBot 叙事并持久化；低分不否决，安全失败仍拒绝，读取失败可观察',async()=>{
  const c=config(),p=providers();let vendorCalls=0,safetyFails=false,unavailable=false;
  // Synthetic fresh versions are only used in this mocked integration test, not as live alerts.
  const payload=fixture();payload.data.history.generated_at=new Date().toISOString();
  payload.data.history.source_tweets=payload.data.history.source_tweets.slice(0,2);
  p.vendor=s=>fetchDebotNarrative(s,async(url,init)=>{
    vendorCalls++;assert.equal(new URL(String(url)).searchParams.get('ca_address'),ca);
    assert.equal(init?.credentials,'omit');assert.equal(new Headers(init?.headers).has('authorization'),false);
    return new Response(JSON.stringify(payload),{status:unavailable?429:200});
  });
  p.evidence=async s=>({evidence:(s.vendorNarrative?.evidenceUrls??[]).map((url,index)=>({
    id:`x:${url.split('/').at(-1)}`,url,text:`合成证据 ${index}；CA ${ca}`,authorId:String(100+index),
    publishedAt:payload.data.history.generated_at,fetchedAt:new Date().toISOString(),
    provider:'fxembed',verification:'third_party',authority:'public',
  })),diagnostics:[{operation:'lookup',status:'ok',returned:2}]});
  p.narrative=liveProviders(c).narrative;
  p.safety=async()=>({status:safetyFails?'fail':'pass',reasons:safetyFails?['TEST_HONEYPOT']:[],facts:{},checkedAt:new Date().toISOString()});
  const store=new Store(':memory:'),server=buildServer(c,store,p);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const headers={authorization:`Bearer ${c.ingestToken}`,'content-type':'application/json'};
  const post=(path:string,value:unknown)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(value)});
  const input={source:'debot',sourceEventId:'synthetic-auto-1',token:{chain:'bsc',address:ca},
    occurredAt:new Date().toISOString(),text:'仅供集成测试的合成信号',claim:'community'};
  try {
    const response=await post('/v1/signals',input);assert.equal(response.status,201);
    const {id,report}=await response.json();assert.equal(vendorCalls,1);
    assert.equal(report.decision,'BUY_CANDIDATE');assert.equal(report.executionEnabled,false);
    assert.equal(report.narrative.supplier.verification,'vendor_endpoint');
    assert.equal(report.narrative.facts.vendorRating.advisoryOnly,true);
    assert.equal(report.narrative.facts.vendorRating.score,'2');
    assert.deepEqual(report.narrative.facts.vendorResponse,payload);
    assert.equal(report.narrative.model,undefined);
    assert.equal(report.signal.vendorNarrative,undefined); // Retain the unmodified source signal.
    const history=await (await fetch(base+`/v1/signals/${id}/history`,{headers})).json();
    assert.deepEqual(history[0].narrative.facts.vendorResponse,payload);
    safetyFails=true;
    const unsafe=await (await post('/v1/signals',{...input,sourceEventId:'synthetic-auto-2'})).json();
    assert.equal(unsafe.report.decision,'REJECT');assert.equal(unsafe.report.buyEligible,false);
    safetyFails=false;unavailable=true;
    const missing=await (await post('/v1/signals',{...input,sourceEventId:'synthetic-auto-3'})).json();
    assert.equal(missing.report.decision,'WATCH');
    assert.equal(missing.report.narrative.facts.vendorFetch.reason,'DEBOT_HTTP_429');

    // Raw imports use their supplied version and are archived atomically; no extra endpoint fetch.
    const before=vendorCalls,body={...imported(),occurredAt:input.occurredAt,payload};
    const raw=await post('/v1/debot/stories',body);assert.equal(raw.status,201);
    const item=await raw.json();assert.equal(vendorCalls,before);
    assert.equal(item.report.narrative.supplier.verification,'user_supplied');
    const archive=await (await fetch(base+`/v1/signals/${item.id}/imports`,{headers})).json();
    assert.equal(archive[0].channel,'debot_story_response');assert.deepEqual(archive[0].payload,body);
    const duplicate=await (await post('/v1/debot/stories',body)).json();assert.equal(duplicate.duplicate,true);
    const {occurredAt,...invalid}=body;
    assert.equal((await post('/v1/debot/stories',invalid)).status,400);
    assert.equal(store.list().length,4);
  } finally {server.close();await once(server,'close');store.close();}
});
