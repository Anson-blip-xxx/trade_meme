import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDashboard,type DashboardServices} from '../src/dashboard.js';
import {ScanArchive} from '../src/scan-archive.js';
import {config} from './helpers.js';
import {DebotAuthError} from '../src/providers/debot-auth.js';
import {DebotScanner} from '../src/debot-scanner.js';
import type {DebotSignalObservation} from '../src/providers/debot-signals.js';
import type {Check,Report} from '../src/types.js';

const password='debot-dashboard-test-private-token-independent';
const status={enabled:true,email:'test@example.com',state:'required' as const,requiresTotp:true as const};
async function fixture(auth?:DashboardServices['debotAuth'],debotSignals?:DashboardServices['debotSignals']) {
  const directory=mkdtempSync(join(tmpdir(),'debot-dashboard-'));
  for(const name of ['index.html','app.js','styles.css'])writeFileSync(join(directory,name),name);
  const cfg=config();cfg.dashboard.token=password;cfg.dashboard.origin='https://dashboard.example';
  const archive=new ScanArchive(':memory:');
  const server=buildDashboard(cfg,{archive,overview:()=>({entryMode:'off'}),orders:()=>({items:[]}),debotAuth:auth,debotSignals},directory);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/dashboard/api`;
  const headers={'x-dashboard-access':password,'content-type':'application/json',origin:cfg.dashboard.origin};
  return {base,headers,post:(path:string,body:unknown,extra={})=>fetch(`${base}/debot/auth${path}`,{
    method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)}),
    async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));archive.close();rmSync(directory,{recursive:true,force:true});}};
}

test('DeBot login is private, same-origin and cannot change the configured account',async()=>{
  let calls=0;
  const f=await fixture({getStatus:()=>status,sendCode:async()=>{calls++;return status;},login:async()=>{calls++;return status;}});
  try {
    for(const path of ['/debot/auth','/debot/auth/code','/debot/auth/login']){
      const r=await fetch(f.base+path,{method:path.endsWith('/auth')?'GET':'POST',headers:{'content-type':'application/json'},body:path.endsWith('/auth')?undefined:'{}'});
      assert.equal(r.status,401);
    }
    assert.equal((await f.post('/code',{}, {origin:'https://evil.example'})).status,403);
    assert.equal((await f.post('/code',{}, {'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await f.post('/code',{email:'someone-else@example.com'})).status,400);
    assert.equal((await f.post('/login',{challengeId:'x',emailCode:'123456',totpCode:'654321',email:'someone-else@example.com'})).status,400);
    assert.equal(calls,0);
    assert.deepEqual(await (await fetch(f.base+'/debot/auth',{headers:f.headers})).json(),status);
    assert.equal((await f.post('/code',{})).status,200);assert.equal(calls,1);
    assert.equal((await fetch(f.base+'/orders',{method:'POST',headers:f.headers,body:'{}'})).status,405);
  }finally {await f.close();}
});

test('DeBot login accepts only bounded JSON with two string codes and returns safe status',async()=>{
  const seen:unknown[]=[];
  const f=await fixture({getStatus:()=>status,sendCode:async()=>status,login:async input=>{seen.push(input);return {...status,state:'authenticated'};}});
  try {
    assert.equal((await f.post('/login',null)).status,400);
    assert.equal((await f.post('/login',[])).status,400);
    assert.equal((await f.post('/login',{challengeId:'x',emailCode:123456,totpCode:'123456'})).status,400);
    assert.equal((await f.post('/login',{x:'a'.repeat(1200)})).status,413);
    assert.equal((await f.post('/code',{}, {'content-type':'text/plain'})).status,415);
    assert.equal(seen.length,0);
    const input={challengeId:'challenge',emailCode:'123456',totpCode:'654321'};
    const response=await f.post('/login',input);
    assert.equal(response.status,200);assert.deepEqual(seen,[input]);
    const text=await response.text();assert.match(text,/authenticated/);assert.doesNotMatch(text,/123456|654321|subToken|cookie/i);
    assert.equal(response.headers.get('cache-control'),'no-store');
  }finally {await f.close();}
});

test('DeBot errors are fixed codes without upstream response or credentials',async()=>{
  const f=await fixture({getStatus:()=>status,sendCode:async()=>{throw new Error('Cookie=secret emailCode=123456');},
    login:async()=>{throw new DebotAuthError('DEBOT_AUTH_CHALLENGE_EXPIRED',409);}});
  try {
    const unavailable=await f.post('/code',{});assert.equal(unavailable.status,503);
    assert.deepEqual(await unavailable.json(),{error:'DEBOT_AUTH_UNAVAILABLE'});
    const expired=await f.post('/login',{challengeId:'x',emailCode:'123456',totpCode:'123456'});
    assert.equal(expired.status,409);assert.deepEqual(await expired.json(),{error:'DEBOT_AUTH_CHALLENGE_EXPIRED'});
  }finally {await f.close();}
});

test('disabled DeBot login remains visible as unavailable and cannot send codes',async()=>{
  const f=await fixture();try {
    assert.deepEqual(await (await fetch(f.base+'/debot/auth',{headers:f.headers})).json(),{enabled:false,state:'unavailable',requiresTotp:true});
    assert.equal((await f.post('/code',{})).status,503);
  }finally {await f.close();}
});

test('vendor authentication errors never challenge or invalidate the dashboard login',async t=>{
  for(const code of [401,403])await t.test(`vendor ${code}`,async()=>{
    const f=await fixture({getStatus:()=>status,
      sendCode:async()=>{throw new DebotAuthError('DEBOT_AUTH_LOGIN_REJECTED',code);},
      login:async()=>{throw new DebotAuthError('DEBOT_AUTH_VERIFY_FAILED',code);}});
    try{
      // Exercise the dashboard cookie login as well as the production proxy path.
      const login=await fetch(f.base+'/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
      assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
      for(const headers of [f.headers,{'content-type':'application/json',cookie}]){
        for(const path of ['code','login']){
          const body=path==='code'?{}:{challengeId:'current',emailCode:'123456',totpCode:'654321'};
          const response=await fetch(`${f.base}/debot/auth/${path}`,{method:'POST',headers,body:JSON.stringify(body)});
          assert.equal(response.status,422);
          assert.equal(response.headers.get('www-authenticate'),null);assert.equal(response.headers.get('set-cookie'),null);
          assert.deepEqual(await response.json(),{error:path==='code'?'DEBOT_AUTH_LOGIN_REJECTED':'DEBOT_AUTH_VERIFY_FAILED'});
          const session=await fetch(f.base+'/session',{headers});
          assert.equal(session.status,200);assert.equal((await session.json()).authenticated,true);
          assert.equal((await fetch(f.base+'/debot/auth',{headers})).status,200);
        }
      }
      assert.equal((await fetch(f.base+'/session')).status,401);
    }finally{await f.close();}
  });
});

test('real-time DeBot risk records require the dashboard session and remain read-only',async()=>{
  let reads=0;
  const projected={now:new Date().toISOString(),items:[]};
  const f=await fixture(undefined,()=>{reads++;return projected;});
  try {
    const unauthorizedHeaders:Record<string,string>[]=[{},{'x-dashboard-access':'incorrect'}];
    for(const headers of unauthorizedHeaders) {
      const response=await fetch(f.base+'/debot/signals',{headers});assert.equal(response.status,401);
      assert.deepEqual(await response.json(),{error:'UNAUTHORIZED'});assert.equal(response.headers.get('set-cookie'),null);
    }
    assert.equal(reads,0);
    const login=await fetch(f.base+'/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
    for(const headers of [f.headers,{cookie}]) {
      const response=await fetch(f.base+'/debot/signals',{headers});assert.equal(response.status,200);
      assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('www-authenticate'),null);
      assert.deepEqual(await response.json(),projected);
      for(const method of ['POST','PUT','DELETE','PATCH']) {
        const denied=await fetch(f.base+'/debot/signals',{method,headers});assert.equal(denied.status,405);
        assert.deepEqual(await denied.json(),{error:'READ_ONLY'});
      }
    }
    assert.equal(reads,2);
    assert.equal((await fetch(f.base+'/debot/signals',{method:'POST',headers:{...f.headers,origin:'https://other.example'}})).status,403);
    assert.equal(reads,2);
    assert.equal((await fetch(f.base+'/logout',{method:'POST',headers:{cookie}})).status,200);
    assert.equal((await fetch(f.base+'/debot/signals',{headers:{cookie}})).status,401);
    assert.equal(reads,2);
  }finally{await f.close();}
});

test('disabled real-time DeBot risk feed returns an empty current result without a login challenge',async()=>{
  const f=await fixture();try {
    const before=Date.now(),response=await fetch(f.base+'/debot/signals',{headers:f.headers});
    assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.items,[]);
    assert.ok(Date.parse(result.now)>=before&&Date.parse(result.now)<=Date.now());
    assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('www-authenticate'),null);
  }finally{await f.close();}
});

test('DeBot risk feed failures never invalidate the dashboard or leak an upstream authentication challenge',async()=>{
  const f=await fixture({getStatus:()=>status,sendCode:async()=>status,login:async()=>status},()=>{
    throw Object.assign(new Error('Cookie=private-session subToken=private-token emailCode=123456'),{status:401});
  });
  try {
    const login=await fetch(f.base+'/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    for(const headers of [f.headers,{cookie}]) {
      const response=await fetch(f.base+'/debot/signals',{headers});assert.equal(response.status,500);
      assert.deepEqual(await response.json(),{error:'DASHBOARD_UNAVAILABLE'});
      assert.equal(response.headers.get('www-authenticate'),null);assert.equal(response.headers.get('set-cookie'),null);
      // The 15-second refresh continues using the same valid workbench session.
      for(const route of ['/session','/overview','/scans','/debot/auth']) {
        const unaffected=await fetch(f.base+route,{headers});assert.equal(unaffected.status,200,route);
        assert.equal(unaffected.headers.get('set-cookie'),null);
      }
    }
  }finally{await f.close();}
});

test('real-time dashboard projects bounded risk evidence without raw signal, wallet or session material',async()=>{
  const epoch=Date.parse('2026-10-15T05:00:00Z');let now=epoch;
  const at=(offset=0)=>new Date(epoch+offset).toISOString();
  const reportId='11111111-1111-4111-8111-111111111111';
  const privateValue='private-session-material-never-display';
  const observation:DebotSignalObservation={id:'sample',observedAt:at(-1000),walletCount:3,addressCount:0,aliases:[privateValue],
    signal:{source:'debot',sourceEventId:'debot:signal:private-test',token:{chain:'bsc',address:'0x1111111111111111111111111111111111111111'},
      occurredAt:at(-2000),text:privateValue,evidenceUrls:[`https://example.com/${privateValue}`],claim:'unspecified'}};
  const check:Check={status:'pass',checkedAt:at(),reasons:['SECURITY_FIELDS_VERIFIED',`Cookie=${privateValue}`],
    facts:{cookie:privateValue,subToken:privateValue,rawResponse:{wallets:[privateValue]}}};
  let finish!:()=>void,started!:()=>void;
  const waiting=new Promise<void>(resolve=>{finish=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
  const scanner=new DebotScanner({database:':memory:',chains:['bsc'],mode:'authenticated_stream',maxAgeSec:120,now:()=>new Date(now),
    fetchPage:async()=>({observations:[observation],received:1,rejected:0}),
    fetchDetails:async()=>({fetchedAt:at(),received:1,rejected:0,vendorWallets:[{alias:privateValue,source:'debot',verification:'vendor_report'}]}),
    onSignal:async signal=>{
      scanner.bindReport(signal.sourceEventId,reportId);
      const report:Report={id:reportId,policyVersion:'test-policy',mode:'live',signal,receivedAt:observation.observedAt,
        evaluatedAt:at(),validUntil:at(30000),decision:'BUY_CANDIDATE',buyEligible:true,executionEnabled:false,
        reasons:['RESEARCH_COMPLETE',privateValue],provenance:check,safety:check,marketRisk:check,flow:check,narrative:{...check,evidence:[]}};
      scanner.recordReport(signal.sourceEventId,report);started();await waiting;
    }});
  const f=await fixture(undefined,()=>scanner.recent());let dispatch:Promise<unknown>|undefined;
  try {
    await scanner.runOnce();
    const pending=await(await fetch(f.base+'/debot/signals',{headers:f.headers})).json();
    assert.equal(pending.items[0].state,'pending');assert.equal(pending.items[0].buyEligible,false);
    assert.deepEqual(pending.items[0].checks,{});
    dispatch=scanner.dispatchOnce();await began;
    const duringResponse=await fetch(f.base+'/debot/signals',{headers:f.headers}),duringText=await duringResponse.text(),during=JSON.parse(duringText);
    assert.doesNotMatch(duringText,/private-session-material|Cookie=|subToken|rawResponse|vendorWallets|evidenceUrls/);
    const progress=during.items[0];assert.equal(progress.state,'dispatching');assert.equal(progress.reportId,reportId);
    assert.equal(progress.buyEligible,false,'a report cannot enable a candidate while dispatch is unfinished');
    assert.equal(progress.signalDelayMs,1000);assert.equal(progress.queueMs,1000);
    assert.deepEqual(progress.reasons,['RESEARCH_COMPLETE']);
    assert.deepEqual(Object.keys(progress.checks).sort(),['market','narrative','provenance','safety','wallets']);
    for(const value of Object.values(progress.checks) as Record<string,unknown>[]) {
      assert.deepEqual(Object.keys(value).sort(),['checkedAt','elapsedMs','firstResultMs','reasons','status']);
      assert.equal(value.firstResultMs,0);
      assert.deepEqual(value.reasons,['SECURITY_FIELDS_VERIFIED']);
    }
    finish();await dispatch;
    const completed=await(await fetch(f.base+'/debot/signals',{headers:f.headers})).json();
    assert.equal(completed.items[0].state,'completed');assert.equal(completed.items[0].buyEligible,true);
    now+=31000;
    const expired=await(await fetch(f.base+'/debot/signals',{headers:f.headers})).json();
    assert.equal(expired.items[0].decision,'BUY_CANDIDATE');assert.equal(expired.items[0].buyEligible,false);
  }finally{finish();await dispatch;await f.close();await scanner.close();}
});
