import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DebotSessionClient,DebotSessionError} from '../src/providers/debot-session.js';
import type {Fetcher} from '../src/http.js';

const NOW=Date.parse('2026-10-15T03:00:00Z');
const endpoint='https://debot.ai/api/community/signal/channel/list?chain=bsc';
const cookie=(changes:Record<string,unknown>={})=>({name:'auth',value:'private-cookie',domain:'.debot.ai',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax',...changes});
const session=(cookies=[cookie()])=>({version:1,createdAt:new Date(NOW).toISOString(),email:'private@example.test',cookies,subToken:'file-private-token'});
const info=()=>new Response(JSON.stringify({code:0,data:{inviteCode:'invite-private',sub_token:'verified-private-token'}}));
const reason=(expected:string)=>(error:unknown)=>{
  assert.ok(error instanceof DebotSessionError);assert.equal(error.message,`DEBOT_SESSION_${expected}`);
  assert.equal(error.reason,error.message);assert.equal(error.cause,undefined);
  assert.doesNotMatch(JSON.stringify(error)+error.stack,/private-cookie|verified-private-token|file-private-token|upstream-secret/);
  return true;
};
function fixture(data:unknown=session()) {
  const directory=mkdtempSync(join(tmpdir(),'debot-session-test-')),path=join(directory,'session.json');
  writeFileSync(path,JSON.stringify(data),{mode:0o600});
  return {path,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}

test('the detail request cancellation also bounds its preceding session verification',async()=>{
  const f=fixture(),controller=new AbortController();const calls:string[]=[];
  let started!:()=>void;const verifying=new Promise<void>(resolve=>{started=resolve;});
  const client=new DebotSessionClient({path:f.path,now:()=>new Date(NOW),fetcher:async(input,init)=>{
    calls.push(new URL(String(input)).pathname);started();
    return new Promise<Response>((_resolve,reject)=>{
      const cancel=()=>reject(new DOMException('private-abort-detail','AbortError'));
      if(init?.signal?.aborted)cancel();else init?.signal?.addEventListener('abort',cancel,{once:true});
    });
  }});
  try {
    const request=client.fetcher(endpoint,{signal:controller.signal});
    await verifying;controller.abort();
    await assert.rejects(request,reason('REQUEST_TIMEOUT'));
    assert.deepEqual(calls,['/api/user/info']);
  }finally{controller.abort();f.cleanup();}
});

test('session verifies real user info, sends only fixed read headers, and returns verified subscription token',async()=>{
  const f=fixture();let now=NOW;const calls:string[]=[];
  const request:Fetcher=async(input,init)=>{
    const url=new URL(String(input));calls.push(url.pathname);
    assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.equal(init?.body,undefined);
    assert.ok(init?.signal instanceof AbortSignal);
    const headers=new Headers(init?.headers);assert.deepEqual([...headers.keys()],['accept','cookie','referer']);
    assert.equal(headers.get('cookie'),'auth=private-cookie');assert.equal(headers.get('referer'),'https://debot.ai/');
    return url.pathname==='/api/user/info'?info():new Response('{"code":0,"data":{"results":[]}}');
  };
  try {
    const client=new DebotSessionClient({path:f.path,fetcher:request,now:()=>new Date(now)});
    assert.deepEqual(await client.getSession(),{subToken:'verified-private-token',cookieHeader:'auth=private-cookie'});
    const response=await client.fetcher(endpoint,{headers:{cookie:'evil',authorization:'evil',referer:'https://evil.test'},redirect:'error'});
    assert.deepEqual(await response.json(),{code:0,data:{results:[]}});
    assert.deepEqual(calls,['/api/user/info','/api/community/signal/channel/list']);
    now+=59_999;await client.getSession();assert.equal(calls.length,2);
    now+=1;await client.getSession();assert.equal(calls.length,3);
    assert.equal(JSON.parse(readFileSync(f.path,'utf8')).subToken,'file-private-token');
  } finally {f.cleanup();}
});

test('only exact HTTPS host and allowlisted GET paths can receive cookies; redirects and writes rejected',async()=>{
  const f=fixture();let calls=0;
  const client=new DebotSessionClient({path:f.path,fetcher:async()=>{calls++;return info();},now:()=>new Date(NOW)});
  try {
    for(const url of ['http://debot.ai/api/user/info','https://evil.test/api/user/info','https://debot.ai.evil.test/api/user/info',
      'https://www.debot.ai/api/user/info','https://debot.ai:444/api/user/info','https://user:password@debot.ai/api/user/info',
      'https://debot.ai/api/user/info#fragment','https://debot.ai/api/user/info/','https://debot.ai/api/trade/buy']) {
      await assert.rejects(client.fetcher(url),reason('REQUEST_REJECTED'));
    }
    for(const init of [{method:'POST'},{method:'DELETE'},{method:'GET',body:'secret'},{redirect:'follow'},{redirect:'manual'}] as RequestInit[]) {
      await assert.rejects(client.fetcher(endpoint,init),reason('REQUEST_REJECTED'));
    }
    await assert.rejects(client.fetcher(new Request(endpoint,{method:'POST',body:'secret'})),reason('REQUEST_REJECTED'));
    assert.equal(calls,0);
    const redirected=new DebotSessionClient({path:f.path,fetcher:async()=>new Response(null,{status:302,headers:{location:'https://evil.test'}}),now:()=>new Date(NOW)});
    await assert.rejects(redirected.getSession(),reason('REDIRECT_REJECTED'));
  } finally {f.cleanup();}
});

test('cookie domain, path and expiry are enforced, session cookies work and aliases are never invented',async()=>{
  const f=fixture(session([cookie(),cookie({name:'expired',expires:NOW/1000}),cookie({name:'wrong',domain:'.evil.test'}),
    cookie({name:'parent',domain:'.ai'}),cookie({name:'sibling',domain:'www.debot.ai'}),cookie({name:'boundary',path:'/api/user/inf'}),
    cookie({name:'userOnly',path:'/api/user'}),cookie({name:'feedOnly',path:'/api/community',expires:NOW/1000+120})]));
  const seen:string[]=[];
  try {
    const client=new DebotSessionClient({path:f.path,now:()=>new Date(NOW),fetcher:async(input,init)=>{
      seen.push(new Headers(init?.headers).get('cookie')!);
      return new URL(String(input)).pathname==='/api/user/info'?info():new Response('{"code":0,"data":{}}');
    }});
    await client.fetcher(endpoint);
    assert.deepEqual(seen,['userOnly=private-cookie; auth=private-cookie','feedOnly=private-cookie; auth=private-cookie']);
  } finally {f.cleanup();}
});

test('expired or wrong-domain-only sessions fail locally and never fall back to anonymous requests',async()=>{
  for(const cookies of [[cookie({expires:NOW/1000-1})],[cookie({domain:'evil.test'})],[]]) {
    const f=fixture(session(cookies));let calls=0;
    try {
      const client=new DebotSessionClient({path:f.path,fetcher:async()=>{calls++;return info();},now:()=>new Date(NOW)});
      await assert.rejects(client.getSession(),reason('AUTH_REQUIRED'));await assert.rejects(client.fetcher(endpoint),reason('AUTH_REQUIRED'));
      assert.equal(calls,0);
    } finally {f.cleanup();}
  }
});

test('HTTP 401/403 and application auth code 101 invalidate verification without token or body errors',async()=>{
  for(const makeResponse of [()=>new Response('upstream-secret',{status:401}),()=>new Response('upstream-secret',{status:403}),
    ()=>new Response('{"code":101,"message":"upstream-secret"}')]) {
    const f=fixture();let calls=0;
    try {
      const client=new DebotSessionClient({path:f.path,now:()=>new Date(NOW),fetcher:async()=>{calls++;return calls===1?info():makeResponse();}});
      await client.getSession();
      await assert.rejects(client.fetcher(endpoint),reason('AUTH_REQUIRED'));
      await assert.rejects(client.getSession(),reason('AUTH_REQUIRED'));assert.equal(calls,3);
    } finally {f.cleanup();}
  }
});

test('verification schema, network errors and excessive responses expose only fixed reasons',async()=>{
  const cases:{fetcher:Fetcher;expected:string}[]=[
    {fetcher:async()=>new Response('upstream-secret'),expected:'RESPONSE_INVALID'},
    {fetcher:async()=>new Response('{"code":0,"data":{"sub_token":"upstream-secret"}}'),expected:'AUTH_REQUIRED'},
    {fetcher:async()=>new Response('{"code":0,"data":{"inviteCode":"x","sub_token":""}}'),expected:'AUTH_REQUIRED'},
    {fetcher:async()=>{throw new Error('upstream-secret');},expected:'REQUEST_FAILED'},
    {fetcher:async()=>{throw new DOMException('upstream-secret','TimeoutError');},expected:'REQUEST_TIMEOUT'},
    {fetcher:async()=>new Response('upstream-secret',{status:429}),expected:'RATE_LIMITED'},
    {fetcher:async()=>new Response('upstream-secret',{status:500}),expected:'HTTP_ERROR'},
    {fetcher:async()=>new Response('upstream-secret',{headers:{'content-length':String(1024*1024+1)}}),expected:'RESPONSE_TOO_LARGE'},
    {fetcher:async()=>new Response('a'.repeat(1024*1024+1)),expected:'RESPONSE_TOO_LARGE'},
  ];
  for(const item of cases) {
    const f=fixture();try {
      const client=new DebotSessionClient({path:f.path,fetcher:item.fetcher,now:()=>new Date(NOW)});
      await assert.rejects(client.getSession(),reason(item.expected));
    } finally {f.cleanup();}
  }
});

test('numeric inviteCode and code 200 are valid only with a string subscription token',async()=>{
  const cases:{code:number;inviteCode:unknown;sub_token:unknown;accepted:boolean}[]=[
    {code:0,inviteCode:123456,sub_token:'verified-private-token',accepted:true},
    {code:200,inviteCode:Number.MAX_SAFE_INTEGER,sub_token:'verified-private-token',accepted:true},
    {code:200,inviteCode:'invite-private',sub_token:'verified-private-token',accepted:true},
    ...[0,-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,'','has space',true,{},[]].map(inviteCode=>
      ({code:0,inviteCode,sub_token:'verified-private-token',accepted:false})),
    ...[123456,'',null].map(sub_token=>({code:200,inviteCode:123456,sub_token,accepted:false})),
    {code:101,inviteCode:123456,sub_token:'verified-private-token',accepted:false},
  ];
  for(const {code,inviteCode,sub_token,accepted} of cases) {
    const f=fixture();try {
      const client=new DebotSessionClient({path:f.path,now:()=>new Date(NOW),fetcher:async()=>Response.json({code,data:{inviteCode,sub_token}})});
      if(accepted)assert.equal((await client.getSession()).subToken,'verified-private-token');
      else await assert.rejects(client.getSession(),reason('AUTH_REQUIRED'));
    }finally{f.cleanup();}
  }
});

test('missing, public, oversized, malformed and symlinked session files are rejected before networking',async()=>{
  const f=fixture();let calls=0;
  const client=new DebotSessionClient({path:f.path,fetcher:async()=>{calls++;return info();},now:()=>new Date(NOW)});
  try {
    chmodSync(f.path,0o644);await assert.rejects(client.getSession(),reason('FILE_PERMISSIONS'));
    chmodSync(f.path,0o600);writeFileSync(f.path,'x'.repeat(64*1024+1));await assert.rejects(client.getSession(),reason('FILE_TOO_LARGE'));
    writeFileSync(f.path,'upstream-secret');await assert.rejects(client.getSession(),reason('FILE_INVALID'));
    writeFileSync(f.path,JSON.stringify(session([cookie({value:'private-cookie; injected=yes'})])));await assert.rejects(client.getSession(),reason('FILE_INVALID'));
    rmSync(f.path);await assert.rejects(client.getSession(),reason('FILE_MISSING'));
    const other=join(f.path,'..','other.json');writeFileSync(other,JSON.stringify(session()),{mode:0o600});symlinkSync(other,f.path);
    await assert.rejects(client.getSession(),reason('FILE_UNREADABLE'));assert.equal(calls,0);
  } finally {f.cleanup();}
});

test('file changes force verification and expiry bounds cache independently of the 60-second maximum',async()=>{
  let now=NOW,calls=0;
  const f=fixture(session([cookie({expires:NOW/1000+10})]));
  const client=new DebotSessionClient({path:f.path,now:()=>new Date(now),fetcher:async()=>{calls++;return info();}});
  try {
    await client.getSession();now+=9999;await client.getSession();assert.equal(calls,1);
    now++;await assert.rejects(client.getSession(),reason('AUTH_REQUIRED'));assert.equal(calls,1);
    writeFileSync(f.path,JSON.stringify(session([cookie({value:'new-private-cookie'})])));
    assert.equal((await client.getSession()).cookieHeader,'auth=new-private-cookie');assert.equal(calls,2);
    chmodSync(f.path,0o400);await client.getSession();assert.equal(calls,3);
  } finally {f.cleanup();}
});

test('socket cookies use portal-ws path while API cookies retain their own path boundaries',async()=>{
  const f=fixture(session([cookie(),cookie({name:'apiOnly',path:'/api'}),cookie({name:'userOnly',path:'/api/user'}),
    cookie({name:'portalOnly',path:'/portal-ws/'}),cookie({name:'nearby',path:'/portal-w'})]));
  const seen:{path:string;cookies:string|null}[]=[];
  try {
    const client=new DebotSessionClient({path:f.path,now:()=>new Date(NOW),fetcher:async(input,init)=>{
      const path=new URL(String(input)).pathname;seen.push({path,cookies:new Headers(init?.headers).get('cookie')});
      return path==='/api/user/info'?info():Response.json({code:0,data:{results:[]}});
    }});
    const first=await client.getSession(),cached=await client.getSession();
    assert.equal(first.cookieHeader,'portalOnly=private-cookie; auth=private-cookie');assert.deepEqual(cached,first);
    await client.fetcher(endpoint);
    assert.deepEqual(seen,[{path:'/api/user/info',cookies:'userOnly=private-cookie; apiOnly=private-cookie; auth=private-cookie'},
      {path:'/api/community/signal/channel/list',cookies:'apiOnly=private-cookie; auth=private-cookie'}]);
    writeFileSync(f.path,JSON.stringify(session([cookie({path:'/api'})])));
    assert.equal((await client.getSession()).cookieHeader,'','an API-only login can still authorize the socket with sub_token');
  }finally{f.cleanup();}
});

test('expired authentication notifies once without awaiting stream shutdown and resets after verification succeeds',async()=>{
  const f=fixture();let authenticated=true,dataStatus=401;
  const notifications:string[]=[];
  const client=new DebotSessionClient({path:f.path,now:()=>new Date(NOW),onAuthRequired:reason=>{
    notifications.push(reason);return new Promise(()=>{});
  },fetcher:async input=>{
    if(new URL(String(input)).pathname==='/api/user/info')return authenticated?info():Response.json({code:0,data:{}});
    return new Response('',{status:dataStatus});
  }});
  try {
    await client.getSession();authenticated=false;
    await assert.rejects(client.fetcher(endpoint),reason('AUTH_REQUIRED'));
    await assert.rejects(client.getSession(),reason('AUTH_REQUIRED'));
    assert.deepEqual(notifications,['DEBOT_SESSION_AUTH_REQUIRED']);
    authenticated=true;await client.getSession();dataStatus=403;
    await assert.rejects(client.fetcher(endpoint),reason('AUTH_REQUIRED'));
    assert.equal(notifications.length,2);
  }finally{f.cleanup();}
});

test('local cookie expiry notifies auth loss, callback failure never replaces the typed request error',async()=>{
  const f=fixture(session([cookie({expires:NOW/1000+1})]));let now=NOW,notifications=0,calls=0;
  const client=new DebotSessionClient({path:f.path,now:()=>new Date(now),onAuthRequired:()=>{
    notifications++;throw Error('private callback exception');
  },fetcher:async()=>{calls++;return info();}});
  try {
    await client.getSession();now+=1000;await assert.rejects(client.getSession(),reason('AUTH_REQUIRED'));
    assert.equal(notifications,1);assert.equal(calls,1);
  }finally{f.cleanup();}
});

test('HTTP and application rate limits preserve bounded cooldown without reporting authentication loss',async()=>{
  for(const response of [()=>new Response('',{status:429,headers:{'retry-after':'120'}}),
    ()=>Response.json({code:429,message:'upstream-secret'})]) {
    const f=fixture();let calls=0,notifications=0;
    try {
      const client=new DebotSessionClient({path:f.path,now:()=>new Date(NOW),onAuthRequired:()=>{notifications++;},
        fetcher:async()=>++calls===1?info():response()});
      await client.getSession();
      await assert.rejects(client.fetcher(endpoint),(error:unknown)=>{
        assert.ok(error instanceof DebotSessionError);assert.equal(error.reason,'DEBOT_SESSION_RATE_LIMITED');
        assert.ok(error.cooldownUntil===NOW+120_000||error.cooldownUntil===NOW+60_000);return true;
      });
      assert.equal(notifications,0);
    }finally{f.cleanup();}
  }
});
