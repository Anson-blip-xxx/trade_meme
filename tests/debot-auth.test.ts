import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,existsSync,linkSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DebotAuthManager,DebotAuthError,type DebotAuthOptions} from '../src/providers/debot-auth.js';
import {DebotSessionClient} from '../src/providers/debot-session.js';
import type {Fetcher} from '../src/http.js';

const NOW=Date.parse('2026-10-15T10:00:00Z'),email='owner@example.test';
const json=(value:unknown,cookies:string[]=[])=>{
  const headers=new Headers({'content-type':'application/json'});for(const cookie of cookies)headers.append('set-cookie',cookie);
  return new Response(JSON.stringify(value),{headers});
};
const cookie='auth=PRIVATE%2Bcookie%3Dvalue; Path=/; Domain=.debot.ai; HttpOnly; Secure; SameSite=Lax';
const info=()=>json({code:0,data:{inviteCode:'PRIVATE-INVITE',sub_token:'PRIVATE-SUB-TOKEN',email}});
const matches=(reason:string,status?:number)=>(cause:unknown)=>{
  assert.ok(cause instanceof DebotAuthError);assert.equal(cause.reason,`DEBOT_AUTH_${reason}`);
  assert.equal(cause.message,cause.reason);if(status)assert.equal(cause.statusCode,status);
  assert.ok(!`${JSON.stringify(cause)}${cause.stack}`.includes('PRIVATE'));
  return true;
};
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function fixture(overrides:Partial<DebotAuthOptions>={}) {
  const root=mkdtempSync(join(tmpdir(),'debot-auth-')),path=join(root,'private','session.json');
  let now=NOW;
  const calls:{url:URL;init:RequestInit|undefined}[]=[];
  const request:Fetcher=async(input,init)=>{
    const url=new URL(String(input));calls.push({url,init});
    if(url.pathname==='/api/security/login/method')return json({code:0,data:{methods:['totp','email']}});
    if(url.pathname==='/api/login/code/send')return json({code:0});
    if(url.pathname==='/api/login/code/signIn')return json({code:0},[cookie]);
    if(url.pathname==='/api/user/info')return info();
    throw new Error('unexpected endpoint');
  };
  const options={email,sessionPath:path,fetcher:request,now:()=>new Date(now),...overrides};
  const manager=new DebotAuthManager(options);
  const input=()=>({challengeId:manager.getStatus().challengeId!,emailCode:'123456',totpCode:'654321'});
  return {manager,options,root,path,calls,request,input,advance:(milliseconds:number)=>{now+=milliseconds;},
    cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('email and TOTP login uses fixed origins and exact bodies, verifies user info, then atomically stores a private compatible session',async()=>{
  let callback=0;
  const f=fixture({onAuthenticated:()=>{
    callback++;assert.ok(existsSync(f.path));assert.equal(JSON.parse(readFileSync(f.path,'utf8')).subToken,'PRIVATE-SUB-TOKEN');
  }});
  try {
    assert.equal(f.manager.getStatus().state,'required');assert.equal(f.manager.getStatus().requiresTotp,true);
    const challenge=await f.manager.sendCode();assert.match(challenge.challengeId!,/^[0-9a-f-]{36}$/);
    assert.equal(challenge.challengeExpiresAt,new Date(NOW+300000).toISOString());
    assert.equal(challenge.canSendAt,new Date(NOW+60000).toISOString());assert.equal(existsSync(f.path),false);
    const status=await f.manager.login(f.input());assert.equal(status.state,'authenticated');assert.equal(status.challengeId,undefined);
    assert.equal(callback,1);assert.equal(f.calls.length,4);
    assert.deepEqual(f.calls.map(call=>[call.url.pathname,call.init?.method]),[
      ['/api/security/login/method','POST'],['/api/login/code/send','POST'],['/api/login/code/signIn','POST'],['/api/user/info','GET']]);
    assert.equal(new Set(f.calls.map(call=>call.url.searchParams.get('request_id'))).size,4);
    for(const call of f.calls) {
      assert.match(call.url.searchParams.get('request_id')!,/^[0-9a-f-]{36}$/);
      assert.equal(call.url.origin,'https://debot.ai');assert.equal(call.init?.redirect,'error');assert.equal(call.init?.credentials,'omit');
      assert.ok(call.init?.signal instanceof AbortSignal);const headers=new Headers(call.init?.headers);
      assert.equal(headers.get('origin'),'https://debot.ai');assert.equal(headers.get('referer'),'https://debot.ai/');
      assert.equal(headers.get('authorization'),null);
    }
    assert.deepEqual(JSON.parse(String(f.calls[0].init?.body)),{email});assert.deepEqual(JSON.parse(String(f.calls[1].init?.body)),{email,lang:'cn'});
    assert.deepEqual(JSON.parse(String(f.calls[2].init?.body)),{email,invite_code:null,login_code:'123456',totp_code:'654321',notification_lang:'zh-CN',notification_timezone:-480});
    assert.equal(new Headers(f.calls[3].init?.headers).get('cookie'),'auth=PRIVATE%2Bcookie%3Dvalue');
    const saved=JSON.parse(readFileSync(f.path,'utf8'));assert.equal(saved.version,1);assert.equal(saved.email,email);
    assert.equal(saved.createdAt,new Date(NOW).toISOString());assert.equal(saved.cookies[0].httpOnly,true);
    assert.equal(statSync(join(f.root,'private')).mode&0o777,0o700);assert.equal(statSync(f.path).mode&0o777,0o600);
    assert.deepEqual(readdirSync(join(f.root,'private')),['session.json']);
    assert.ok(!JSON.stringify(saved).includes('123456'));assert.ok(!JSON.stringify(saved).includes('654321'));
    for(const value of [status,f.manager.getStatus()])assert.ok(!JSON.stringify(value).includes('PRIVATE'));
    const client=new DebotSessionClient({path:f.path,now:()=>new Date(NOW),fetcher:async()=>info()});
    assert.equal((await client.getSession()).subToken,'PRIVATE-SUB-TOKEN');
  }finally{f.cleanup();}
});

test('status never infers authentication by reading an existing session file',()=>{
  const f=fixture();try {
    writeFileSync(join(f.root,'existing.json'),'PRIVATE CONTENT');
    const manager=new DebotAuthManager({email,sessionPath:join(f.root,'existing.json')});
    assert.equal(manager.getStatus().state,'required');manager.setAuthenticated(true);assert.equal(manager.getStatus().state,'authenticated');
    manager.setAuthenticated(false);assert.equal(manager.getStatus().state,'required');assert.ok(!JSON.stringify(manager.getStatus()).includes('PRIVATE'));
  }finally{f.cleanup();}
});

test('official success codes and numeric inviteCode survive login and subsequent session verification',async t=>{
  for(const [code,inviteCode] of [[0,123456],[200,Number.MAX_SAFE_INTEGER],[200,'PRIVATE-INVITE']] as const) {
    await t.test(`code ${code}, inviteCode type ${typeof inviteCode}`,async()=>{
      const f=fixture();const userInfo=()=>json({code,data:{inviteCode,sub_token:'PRIVATE-SUB-TOKEN',email}});
      const manager=new DebotAuthManager({...f.options,fetcher:async(input,init)=>{
        if(new URL(String(input)).pathname==='/api/user/info')return userInfo();
        const response=await f.request(input,init),payload=await response.json() as Record<string,unknown>;
        return new Response(JSON.stringify({...payload,code}),{headers:response.headers});
      }});
      try {
        const challenge=await manager.sendCode();
        const status=await manager.login({challengeId:challenge.challengeId!,emailCode:'123456',totpCode:'654321'});
        assert.equal(status.state,'authenticated');assert.equal(status.lastError,undefined);
        const client=new DebotSessionClient({path:f.path,fetcher:async()=>userInfo(),now:()=>new Date(NOW)});
        assert.equal((await client.getSession()).subToken,'PRIVATE-SUB-TOKEN');
        assert.ok(!JSON.stringify(status).includes('PRIVATE'));
      }finally{f.cleanup();}
    });
  }
});

test('numeric inviteCode compatibility does not accept invalid IDs, token types or anonymous user info',async()=>{
  const cases:[Record<string,unknown>,string][]=[
    ...[0,-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,'','has space',true,{},[]].map(inviteCode=>[
      {code:0,data:{inviteCode,sub_token:'PRIVATE'}},'INVITE_CODE_INVALID'] as [Record<string,unknown>,string]),
    ...[123456,'',null].map(sub_token=>[{code:0,data:{inviteCode:123456,sub_token}},'SUB_TOKEN_INVALID'] as [Record<string,unknown>,string]),
    [{code:0,data:null},'USER_INFO_INVALID'],
    [{code:101,data:{inviteCode:123456,sub_token:'PRIVATE'}},'VERIFY_FAILED'],
  ];
  for(const [value,expected] of cases) {
    const f=fixture();const manager=new DebotAuthManager({...f.options,fetcher:async(input,init)=>
      new URL(String(input)).pathname==='/api/user/info'?json(value):f.request(input,init)});
    try {
      const challenge=await manager.sendCode();
      await assert.rejects(manager.login({challengeId:challenge.challengeId!,emailCode:'123456',totpCode:'654321'}),matches(expected));
      assert.equal(existsSync(f.path),false);assert.equal(manager.getStatus().lastError,`DEBOT_AUTH_${expected}`);
      assert.ok(!JSON.stringify(manager.getStatus()).includes('PRIVATE'));
    }finally{f.cleanup();}
  }
});

test('cooldown starts before requests, failed sends publish no challenge, and the concurrent request lock prevents duplicate email sends',async()=>{
  const first=deferred<Response>();let requests=0;
  const f=fixture({fetcher:async()=>{requests++;return first.promise;}});
  try {
    const sending=f.manager.sendCode();await assert.rejects(f.manager.sendCode(),matches('BUSY',409));
    await assert.rejects(f.manager.login({challengeId:'x',emailCode:'123456',totpCode:'654321'}),matches('BUSY',409));
    first.resolve(json({code:1,message:'PRIVATE rejected'}));await assert.rejects(sending,matches('METHOD_UNSUPPORTED',502));
    assert.equal(requests,1);assert.equal(f.manager.getStatus().challengeId,undefined);
    await assert.rejects(f.manager.sendCode(),matches('SEND_COOLDOWN',429));assert.equal(requests,1);
    assert.equal(f.manager.getStatus().canSendAt,new Date(NOW+60000).toISOString());
  }finally{first.resolve(json({code:1}));f.cleanup();}
});

test('a new successful challenge invalidates the previous one and expired challenges do not call signIn',async()=>{
  const f=fixture();try {
    const first=await f.manager.sendCode();f.advance(60000);const second=await f.manager.sendCode();
    assert.notEqual(first.challengeId,second.challengeId);const count=f.calls.length;
    await assert.rejects(f.manager.login({...f.input(),challengeId:first.challengeId!}),matches('CHALLENGE_INVALID',409));
    assert.equal(f.calls.length,count);const current=f.input();f.advance(300000);
    await assert.rejects(f.manager.login({...current,challengeId:second.challengeId!}),matches('CHALLENGE_EXPIRED',409));
    assert.equal(f.calls.length,count);assert.equal(f.manager.getStatus().challengeId,undefined);
  }finally{f.cleanup();}
});

test('both codes must be exactly six digits, and unknown challenges never reach upstream',async()=>{
  const f=fixture();try {
    await f.manager.sendCode();const count=f.calls.length;
    for(const value of ['', '12345','1234567','123 45','abcdef',123456,null]) {
      await assert.rejects(f.manager.login({...f.input(),emailCode:value as string}),matches('INVALID_CODE',400));
      await assert.rejects(f.manager.login({...f.input(),totpCode:value as string}),matches('INVALID_CODE',400));
    }
    await assert.rejects(f.manager.login({...f.input(),challengeId:'unknown'}),matches('CHALLENGE_INVALID',409));
    assert.equal(f.calls.length,count);
  }finally{f.cleanup();}
});

test('one challenge permits at most five upstream login attempts and failure does not replace an existing good session',async()=>{
  let attempts=0,callback=0;
  const f=fixture({onAuthenticated:()=>{callback++;}});
  const manager=new DebotAuthManager({...f.options,fetcher:async(input,init)=>{
    if(new URL(String(input)).pathname==='/api/login/code/signIn'){attempts++;return json({code:37,message:'PRIVATE OTP VALUE'});}
    return f.request(input,init);
  }});
  try {
    writeFileSync(join(f.root,'old.json'),'PRIVATE-OLD-SESSION');
    const preserving=new DebotAuthManager({...f.options,sessionPath:join(f.root,'old.json'),fetcher:async(input,init)=>{
      if(new URL(String(input)).pathname==='/api/login/code/signIn'){attempts++;return json({code:37,message:'PRIVATE OTP VALUE'});}
      return f.request(input,init);
    }});
    const status=await preserving.sendCode(),input={challengeId:status.challengeId!,emailCode:'123456',totpCode:'654321'};
    for(let i=0;i<5;i++)await assert.rejects(preserving.login(input),matches('CODE_REJECTED',401));
    await assert.rejects(preserving.login(input),matches('CHALLENGE_INVALID',409));
    assert.equal(attempts,5);assert.equal(readFileSync(join(f.root,'old.json'),'utf8'),'PRIVATE-OLD-SESSION');assert.equal(callback,0);
    assert.equal(preserving.getStatus().challengeId,undefined);assert.ok(!JSON.stringify(preserving.getStatus()).includes('PRIVATE'));
    assert.equal(manager.getStatus().state,'required');
  }finally{f.cleanup();}
});

test('session is retained as authenticated when persistence succeeds but the reconnect callback fails',async()=>{
  const f=fixture({onAuthenticated:()=>{throw new Error('PRIVATE CONNECTION FAILURE');}});
  try {
    await f.manager.sendCode();const status=await f.manager.login(f.input());
    assert.equal(status.state,'authenticated');assert.equal(status.lastError,'DEBOT_AUTH_RECONNECT_FAILED');
    assert.equal(JSON.parse(readFileSync(f.path,'utf8')).subToken,'PRIVATE-SUB-TOKEN');assert.ok(!JSON.stringify(status).includes('PRIVATE'));
  }finally{f.cleanup();}
});

test('unsupported login methods do not send email codes',async()=>{
  let requests=0;const f=fixture({fetcher:async()=>{requests++;return json({code:0,data:{methods:['email']}});}});
  try {await assert.rejects(f.manager.sendCode(),matches('METHOD_UNSUPPORTED',409));assert.equal(requests,1);assert.equal(f.manager.getStatus().challengeId,undefined);}
  finally{f.cleanup();}
});

test('challenge cookies are forwarded only within valid path scope and rotations, Max-Age and deletions are reflected in the saved jar',async()=>{
  const f=fixture();
  const manager=new DebotAuthManager({...f.options,fetcher:async(input,init)=>{
    const url=new URL(String(input)),header=new Headers(init?.headers).get('cookie');
    if(url.pathname==='/api/security/login/method')return json({code:0,data:{methods:['email','totp']}},[
      'challenge=PRIVATE-stage; Path=/api/login; Secure; HttpOnly; SameSite=Strict',
      'scoped=PRIVATE-scoped; Path=/api/security; Secure',
      'remove=PRIVATE-old; Path=/; Secure']);
    if(url.pathname==='/api/login/code/send'){
      assert.ok(header?.includes('challenge=PRIVATE-stage'));assert.ok(!header?.includes('scoped='));return json({code:0});
    }
    if(url.pathname==='/api/login/code/signIn')return json({code:0},[cookie,'remove=; Path=/; Max-Age=0; Secure',
      'expiry=PRIVATE-expiry; Path=/; Max-Age=120; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure']);
    assert.ok(header?.includes('auth=PRIVATE%2Bcookie%3Dvalue'));assert.ok(!header?.includes('challenge='));assert.ok(!header?.includes('remove='));
    return json({code:0,data:{inviteCode:'PRIVATE-INVITE',sub_token:'PRIVATE-TOKEN'}},['auth=PRIVATE-rotated; Path=/; Domain=.debot.ai; Secure; HttpOnly']);
  }});
  try {
    const sent=await manager.sendCode();await manager.login({challengeId:sent.challengeId!,emailCode:'123456',totpCode:'654321'});
    const saved=JSON.parse(readFileSync(f.path,'utf8'));
    assert.equal(saved.cookies.find((value:any)=>value.name==='auth').value,'PRIVATE-rotated');
    assert.equal(saved.cookies.some((value:any)=>value.name==='remove'),false);
    assert.equal(saved.cookies.find((value:any)=>value.name==='expiry').expires,NOW/1000+120);
  }finally{f.cleanup();}
});

test('foreign, injected, invalid prefix or ambiguous cookie fields cannot create a saved session',async t=>{
  for(const invalid of ['auth=value; Domain=evil.test; Path=/','auth=value; Domain=debot.ai.evil.test; Path=/',
    'auth=value; Domain=.debot.ai; Domain=debot.ai; Path=/','auth=bad,value; Path=/',
    '__Host-auth=value; Domain=debot.ai; Path=/; Secure','__Secure-auth=value; Path=/',
    'auth=value; Path=/; SameSite=None','auth=value; Expires=not-a-date','auth=value; Max-Age=not-a-number'])
    await t.test(invalid.split(';')[0],async()=>{
      const f=fixture();const manager=new DebotAuthManager({...f.options,fetcher:async(input,init)=>
        new URL(String(input)).pathname==='/api/login/code/signIn'?json({code:0},[invalid]):f.request(input,init)});
      try {
        const sent=await manager.sendCode();await assert.rejects(manager.login({challengeId:sent.challengeId!,emailCode:'123456',totpCode:'654321'}),matches('COOKIE_INVALID',502));
        assert.equal(existsSync(f.path),false);
      }finally{f.cleanup();}
    });
});

test('user-info verification and surviving authentication cookies are required before saving',async t=>{
  for(const [value,cookies,expected] of [
    [{code:0,data:{inviteCode:'ok'}},[],'SUB_TOKEN_INVALID'],
    [{code:0,data:{inviteCode:'ok',sub_token:'PRIVATE',email:'someone@example.test'}},[],'ACCOUNT_MISMATCH'],
    [{code:0,data:{inviteCode:'ok',sub_token:'PRIVATE'}},['auth=; Path=/; Domain=.debot.ai; Max-Age=0'],'COOKIE_MISSING'],
  ] as const)await t.test(expected,async()=>{
    const f=fixture();const manager=new DebotAuthManager({...f.options,fetcher:async(input,init)=>
      new URL(String(input)).pathname==='/api/user/info'?json(value,[...cookies]):f.request(input,init)});
    try {
      const sent=await manager.sendCode();await assert.rejects(manager.login({challengeId:sent.challengeId!,emailCode:'123456',totpCode:'654321'}),matches(expected));
      assert.equal(existsSync(f.path),false);
    }finally{f.cleanup();}
  });
});

test('redirects, network failures, timeouts, malformed or oversized responses expose only fixed errors',async t=>{
  const cases:[()=>Promise<Response>,string,number][]=[
    [async()=>new Response(null,{status:302,headers:{location:'https://evil.test'}}),'REDIRECT_REJECTED',502],
    [async()=>{throw new Error('PRIVATE NETWORK HEADER');},'REQUEST_FAILED',502],
    [async()=>{throw new DOMException('PRIVATE TIMEOUT','TimeoutError');},'REQUEST_TIMEOUT',504],
    [async()=>new Response('PRIVATE non json'),'RESPONSE_INVALID',502],
    [async()=>new Response('PRIVATE',{headers:{'content-length':String(256*1024+1)}}),'RESPONSE_TOO_LARGE',502],
    [async()=>new Response('x'.repeat(256*1024+1)),'RESPONSE_TOO_LARGE',502],
    [async()=>new Response('PRIVATE upstream',{status:429}),'RATE_LIMITED',429],
    [async()=>new Response('PRIVATE upstream',{status:500}),'HTTP_ERROR',502],
  ];
  for(const [fetcher,reason,status] of cases)await t.test(reason,async()=>{
    const f=fixture({fetcher});try {await assert.rejects(f.manager.sendCode(),matches(reason,status));
      assert.equal(f.manager.getStatus().challengeId,undefined);assert.ok(!JSON.stringify(f.manager.getStatus()).includes('PRIVATE'));
    }finally{f.cleanup();}
  });
});

test('session targets reject symlinks and hardlinks without changing their targets or running the authenticated callback',async t=>{
  for(const kind of ['symlink','hardlink','directory','public_parent'])await t.test(kind,async()=>{
    const f=fixture();const target=join(f.root,'session.json'),other=join(f.root,'other.json');writeFileSync(other,'PRIVATE EXISTING');
    if(kind==='symlink')symlinkSync(other,target);else if(kind==='hardlink')linkSync(other,target);
    else if(kind==='public_parent')chmodSync(f.root,0o755);
    let callback=0;
    const manager=new DebotAuthManager({...f.options,sessionPath:kind==='directory'?f.root:target,onAuthenticated:()=>{callback++;}});
    try {
      const sent=await manager.sendCode();await assert.rejects(manager.login({challengeId:sent.challengeId!,emailCode:'123456',totpCode:'654321'}),matches('SESSION_PATH_UNSAFE',500));
      assert.equal(readFileSync(other,'utf8'),'PRIVATE EXISTING');assert.equal(callback,0);
      assert.ok(readdirSync(f.root).every(name=>!name.startsWith('.debot-session-')));
    }finally{f.cleanup();}
  });
});

test('disabled configuration cannot make network requests',async()=>{
  let calls=0;const manager=new DebotAuthManager({email:'',sessionPath:'',fetcher:async()=>{calls++;return info();}});
  assert.equal(manager.getStatus().enabled,false);assert.equal(manager.getStatus().state,'unavailable');
  await assert.rejects(manager.sendCode(),matches('CONFIG_MISSING',503));assert.equal(calls,0);
});
