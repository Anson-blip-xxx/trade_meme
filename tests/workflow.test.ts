import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Store} from '../src/store.js';
import {buildServer} from '../src/server.js';
import {liveProviders,evaluate} from '../src/engine.js';
import {renderReport} from '../src/report.js';
import {signal,config,providers,evidence,token,now} from './helpers.js';

test('通知→供应商原文→证据诊断→持久化→查询/重试完整流程无需模型API',async t=>{
  t.mock.timers.enable({apis:['Date'],now:now.getTime()});
  const c=config();c.openaiKey='must-not-appear-in-status';
  const p=providers();let lookups=0;
  p.evidence=async()=>{lookups++;return {evidence:evidence(),diagnostics:[{operation:'search',status:'empty',reason:'NO_VALID_EVIDENCE',returned:0}]};};
  p.narrative=liveProviders(c).narrative;
  const store=new Store(':memory:'),server=buildServer(c,store,p);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const headers={authorization:`Bearer ${c.ingestToken}`,'content-type':'application/json'};
  const original={source:'debot',chain:'bsc',occurredAt:new Date().toISOString(),text:`实际通知格式的合成测试 CA ${token}`,
    vendorNarrative:{provider:'debot',token:{chain:'bsc',address:token},sourceUrl:'https://debot.ai/',
      text:'平台叙事原文的合成测试，不能当作平台的真实判断。',updatedAt:new Date().toISOString(),evidenceUrls:[]}};
  const post=(path:string,data:unknown)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(data)});
  try {
    assert.equal((await fetch(base+'/v1/notifications',{method:'POST',body:JSON.stringify(original)})).status,401);
    const response=await post('/v1/notifications',original);assert.equal(response.status,201);
    const r=await response.json(),id=r.id;
    assert.equal(r.report.decision,'BUY_CANDIDATE');assert.equal(r.report.executionEnabled,false);
    assert.equal(r.report.narrative.status,'unknown');assert.ok(!r.report.reasons.includes('NARRATIVE_NOT_PASSED'));
    assert.equal(r.report.narrative.supplier.text,original.vendorNarrative.text);
    assert.equal(r.report.narrative.supplier.verification,'user_supplied');assert.equal(r.report.narrative.model,undefined);
    assert.equal(r.report.narrative.facts.evidenceDiagnostics[0].reason,'NO_VALID_EVIDENCE');
    const dup=await post('/v1/notifications',original);assert.equal((await dup.json()).duplicate,true);assert.equal(lookups,1);
    const imports=await (await fetch(base+`/v1/signals/${id}/imports`,{headers})).json();
    assert.equal(imports.length,1);assert.deepEqual(imports[0].payload,original);
    assert.equal(imports[0].verification,'user_supplied');
    const text=await (await fetch(base+`/v1/signals/${id}/report`,{headers})).text();
    assert.ok(text.includes(original.vendorNarrative.text));assert.ok(text.includes('实际开单状态以开单明细为准'));
    assert.equal((await post(`/v1/signals/${id}/retry`,{})).status,201);assert.equal(lookups,2);
    const history=await (await fetch(base+`/v1/signals/${id}/history`,{headers})).json();assert.equal(history.length,2);
    const status=await (await fetch(base+'/v1/status',{headers})).text();
    assert.ok(!status.includes(c.openaiKey));assert.ok(status.includes('不需要 OPENAI_API_KEY'));
    assert.equal((await post(`/v1/signals/${id}/history`,{})).status,404);
    const bad=await post('/v1/notifications',{...original,vendorNarrative:{...original.vendorNarrative,sourceUrl:'not-a-url'}});
    assert.equal(bad.status,400);assert.equal(store.list().length,1);
  } finally {server.close();await once(server,'close');store.close();}
});

test('历史候选查询保留当时结论，但当前买入标志失效且不修改存档',async t=>{
  // The proof is fresh at evaluation; only the later report read is expired.
  t.mock.timers.enable({apis:['Date'],now:now.getTime()+120000});
  const c=config(),past=now,s=signal({occurredAt:past.toISOString()});
  const r=await evaluate(s,c,providers(),{now:()=>past});
  assert.equal(r.decision,'BUY_CANDIDATE');
  const output=renderReport(r);
  assert.ok(output.includes('结果：观察'));assert.ok(output.includes('评估时历史结论：买入研究候选'));
  assert.equal(r.decision,'BUY_CANDIDATE');assert.equal(r.decisionAtEvaluation,undefined);
});

test('文本报告中的供应商内容不能输出ANSI控制序列',async()=>{
  const r=await evaluate(signal(),config(),providers());
  r.narrative.supplier={provider:'gmgn',text:'\u001b[31m测试\u0000',sourceUrl:'https://gmgn.ai/',verification:'user_supplied',contentType:'vendor_ai_narrative'};
  assert.ok(!renderReport(r).includes('\u001b'));assert.ok(!renderReport(r).includes('\u0000'));
});
