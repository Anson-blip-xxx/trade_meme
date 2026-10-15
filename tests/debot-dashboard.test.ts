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

const password='debot-dashboard-test-private-token-independent';
const status={enabled:true,email:'test@example.com',state:'required' as const,requiresTotp:true as const};
async function fixture(auth?:DashboardServices['debotAuth']) {
  const directory=mkdtempSync(join(tmpdir(),'debot-dashboard-'));
  for(const name of ['index.html','app.js','styles.css'])writeFileSync(join(directory,name),name);
  const cfg=config();cfg.dashboard.token=password;cfg.dashboard.origin='https://dashboard.example';
  const archive=new ScanArchive(':memory:');
  const server=buildDashboard(cfg,{archive,overview:()=>({entryMode:'off'}),orders:()=>({items:[]}),debotAuth:auth},directory);
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
