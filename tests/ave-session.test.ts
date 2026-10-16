import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,lstatSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {AveSessionClient,AveSessionError,saveAveSession,type AveSessionFile} from '../src/providers/ave-session.js';
import type {Fetcher} from '../src/http.js';
import {fetchAveSignalPage,AveSignalError} from '../src/providers/ave-signals.js';

const NOW=Date.parse('2026-10-16T10:00:00Z'),EMAIL='owner@example.test';
const FEED='https://yiyulu.com/v2api/signals/v2/public/multi_chain/list?pageSize=20&chain=bsc,solana,robinhood';
const WALLETS='/botapi/user/getWalletsAllChain',USER='/botapi/user/getUserInfoByGuid',REFRESH='/botapi/user/refreshNewToken';
const EVM='0x1111111111111111111111111111111111111111',SOL='So11111111111111111111111111111111111111112';
const jwt=(expiry=NOW+3600000,issued=NOW-3600000)=>`unsigned.${Buffer.from(JSON.stringify({exp:expiry/1000,iat:issued/1000,email:'not-authentication-proof@example.test'})).toString('base64url')}.private-signature`;
const session=(patch:Partial<AveSessionFile>={}):AveSessionFile=>({version:1,email:EMAIL,savedAt:new Date(NOW).toISOString(),
  accessToken:jwt(),refreshToken:jwt(NOW+7*86400000),xAuth:'private-x-auth',...patch});
const success=(data:unknown)=>new Response(JSON.stringify({status:0,msg:'Success',data}));
function fixture(value:unknown=session()) {
  const directory=mkdtempSync(join(tmpdir(),'ave-session-')),path=join(directory,'session.json');
  writeFileSync(path,JSON.stringify(value),{mode:0o600});
  return {directory,path,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
function verifiedFetch(calls:{path:string;headers:Headers;query:URLSearchParams}[]=[],feed?:()=>Response):Fetcher {
  return async(input,init)=>{
    const url=new URL(String(input));calls.push({path:url.pathname,headers:new Headers(init?.headers),query:url.searchParams});
    assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');
    assert.ok(init?.signal instanceof AbortSignal);assert.equal(new Headers(init?.headers).get('cookie'),null);
    if(url.pathname===WALLETS){assert.equal(url.searchParams.get('chain'),'bsc,solana,robinhood');
      return success([{tgUid:'bound-user',evmAddress:EVM,risk:false,addresses:[{chain:'bsc',address:EVM},{chain:'solana',address:SOL},{chain:'robinhood',address:EVM}]}]);}
    if(url.pathname===USER){assert.equal(url.searchParams.get('guid'),'bound-user');return success({tgUid:'bound-user',emailAddress:EMAIL});}
    if(url.pathname===REFRESH)return success({accessToken:jwt(NOW+7200000),refreshToken:jwt(NOW+14*86400000)});
    return feed?.()??new Response(JSON.stringify({status:1,msg:'SUCCESS',data:{list:[],page_token:'opaque'}}));
  };
}
const reason=(expected:string)=>(error:unknown)=>{
  assert.ok(error instanceof AveSessionError);assert.equal(error.reason,`AVE_SESSION_${expected}`);assert.equal(error.message,error.reason);
  assert.doesNotMatch(JSON.stringify(error)+error.stack,/private-signature|private-x-auth|secret-upstream/);return true;
};

test('session file stores only minimal token DTO with strict permissions; persistence itself never authenticates',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ave-persist-')),path=join(directory,'nested','session.json');
  try {
    await saveAveSession(path,session());assert.equal(lstatSync(dirname(path)).mode&0o777,0o700);assert.equal(lstatSync(path).mode&0o777,0o600);
    assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),session());
    const client=new AveSessionClient({path,email:EMAIL});assert.equal(client.getStatus().status,'required');assert.equal(client.getStatus().authenticated,false);
    await assert.rejects(saveAveSession(path,{...session(),mnemonic:'must-never-persist'} as never),reason('FILE_INVALID'));
    assert.equal(readFileSync(path,'utf8').includes('must-never-persist'),false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('JWT fields never prove identity: bound owner and exact email are verified before scoped public signal reads',async()=>{
  const f=fixture(),calls:Parameters<typeof verifiedFetch>[0]=[];
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:verifiedFetch(calls)});
    assert.equal(client.getStatus().authenticated,false);
    const response=await client.fetcher(FEED,{headers:{authorization:'Bearer caller-secret',cookie:'caller-cookie',host:'evil.test'}});
    assert.deepEqual(await response.json(),{status:1,msg:'SUCCESS',data:{list:[],page_token:'opaque'}});
    assert.deepEqual(calls.map(c=>c.path),[WALLETS,USER,'/v2api/signals/v2/public/multi_chain/list']);
    for(const call of calls){assert.equal(call.headers.get('authorization'),call.path.startsWith('/botapi/')?`Bearer ${session().accessToken}`:null);
      assert.equal(call.headers.get('x-auth'),'private-x-auth');assert.equal(call.headers.get('host'),null);}
    assert.equal(calls.at(-1)!.query.get('wallet_address'),EVM);assert.equal(calls[0].query.has('wallet_address'),false);
    assert.equal(client.getStatus().status,'authenticated');assert.equal(client.getStatus().email,EMAIL);
    assert.equal(client.getStatus().expiresAt,new Date(NOW+3600000).toISOString());
    assert.equal(JSON.stringify(client.getStatus()).includes('private'),false);
  }finally{f.cleanup();}
});

test('valid verification is cached briefly and different callers join one identity check',async()=>{
  const f=fixture(),calls:Parameters<typeof verifiedFetch>[0]=[];let current=NOW;
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(current),fetcher:verifiedFetch(calls)});
    await Promise.all([client.verify(),client.verify(),client.verify()]);assert.equal(calls.length,2);
    await client.fetcher(FEED);assert.equal(calls.length,3);
    current+=60001;assert.equal(client.getStatus().authenticated,false);await client.verify();assert.equal(calls.length,5);
  }finally{f.cleanup();}
});

test('public signal reads use the first requested chain address and never persist or disclose wallet selection',async()=>{
  const f=fixture(),calls:Parameters<typeof verifiedFetch>[0]=[],before=readFileSync(f.path,'utf8');
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:verifiedFetch(calls)});
    await client.fetcher(FEED.replace('bsc,solana,robinhood','solana,bsc'));
    assert.equal(calls.at(-1)!.query.get('wallet_address'),SOL);assert.equal(calls.at(-1)!.headers.get('authorization'),null);
    await client.fetcher(FEED.replace('bsc,solana,robinhood','robinhood'));
    assert.equal(calls.at(-1)!.query.get('wallet_address'),EVM);assert.equal(calls.filter(c=>c.path===WALLETS).length,1);
    assert.equal(readFileSync(f.path,'utf8'),before);
    for(const address of [EVM,SOL])assert.equal(JSON.stringify(client.getStatus()).includes(address),false);
  }finally{f.cleanup();}
});

test('missing or foreign account wallet addresses cannot be silently used in authenticated signal reads',async()=>{
  for(const mode of ['missing-chain','foreign-owner','malformed-address'] as const) {
    const f=fixture();let feedCalls=0;
    try {
      const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:async input=>{
        const url=new URL(String(input));
        if(url.pathname===WALLETS)return success([
          {tgUid:'bound-user',addresses:[{chain:mode==='missing-chain'?'solana':'bsc',address:mode==='malformed-address'?'invalid':mode==='foreign-owner'?undefined:SOL}]},
          {tgUid:'other-user',risk:false,addresses:[{chain:'bsc',address:EVM}]},
        ]);
        if(url.pathname===USER)return success({tgUid:'bound-user',emailAddress:EMAIL});
        feedCalls++;return success({list:[]});
      }});
      assert.equal((await client.verify()).authenticated,true);
      await assert.rejects(client.fetcher(FEED),reason('WALLET_UNAVAILABLE'));assert.equal(feedCalls,0);
    }finally{f.cleanup();}
  }
});

test('unbound guid, another account email and local email mismatch never become authenticated',async()=>{
  for(const mode of ['missing-wallets','wrong-email','wrong-guid','local-email'] as const) {
    const f=fixture(mode==='local-email'?session({email:'other@example.test'}):session());let calls=0;
    try {
      const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:async input=>{
        calls++;const path=new URL(String(input)).pathname;
        return path===WALLETS?success(mode==='missing-wallets'?[]:[{tgUid:'bound-user'}]):
          success({tgUid:mode==='wrong-guid'?'different-user':'bound-user',emailAddress:mode==='wrong-email'?'other@example.test':EMAIL});
      }});
      const status=await client.verify();assert.equal(status.authenticated,false);assert.equal(status.status,'required');
      if(mode==='local-email')assert.equal(calls,0);
    }finally{f.cleanup();}
  }
});

test('public xAuth-only reads remain explicitly unauthenticated and never invent a bearer token',async()=>{
  const f=fixture(session({accessToken:undefined,refreshToken:undefined})),calls:Parameters<typeof verifiedFetch>[0]=[];
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:verifiedFetch(calls)});
    await client.fetcher(FEED);assert.equal(calls.length,1);assert.equal(calls[0].headers.get('authorization'),null);
    assert.equal(calls[0].headers.get('x-auth'),'private-x-auth');assert.equal(client.getStatus().status,'required');
    assert.equal(calls[0].query.has('wallet_address'),false);
    assert.equal(client.getStatus().reason,'AVE_SESSION_PUBLIC_ONLY');
  }finally{f.cleanup();}
});

test('precise fixed signal URL allowlist forbids trade, mnemonic, login, refresh and identity extraction through public fetcher',async()=>{
  const f=fixture();let calls=0;
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,fetcher:async()=>{calls++;return success({});}});
    const rejected=[FEED.replace('https:','http:'),FEED.replace('yiyulu.com','yiyulu.com.evil.test'),FEED.replace('yiyulu.com','user:password@yiyulu.com'),
      FEED.replace('yiyulu.com','yiyulu.com:444'),`${FEED}#fragment`,`${FEED}&page_token=secret`,`${FEED}&chain=bsc`,`${FEED}&wallet_address=${EVM}`,
      FEED.replace('pageSize=20','pageSize=10000'),FEED.replace('bsc,solana,robinhood','ethereum'),
      `https://yiyulu.com${REFRESH}?type=acc`,`https://yiyulu.com${USER}?guid=other`,
      'https://yiyulu.com/botapi/swap/createSwapEvmTxV2','https://yiyulu.com/botapi/user/emailCodeLogin','https://yiyulu.com/botapi/user/getMnemonic'];
    for(const url of rejected)await assert.rejects(client.fetcher(url),reason('REQUEST_REJECTED'));
    for(const init of [{method:'POST'},{method:'DELETE'},{redirect:'follow'},{body:'secret'}] as RequestInit[])
      await assert.rejects(client.fetcher(FEED,init),reason('REQUEST_REJECTED'));
    await assert.rejects(client.fetcher(new Request(FEED,{method:'POST',body:'secret'})),reason('REQUEST_REJECTED'));assert.equal(calls,0);
  }finally{f.cleanup();}
});

test('near-expiry access token renews via refresh bearer, persists atomically and re-verifies the account',async()=>{
  const initial=session({accessToken:jwt(NOW+30000)}),f=fixture(initial),calls:Parameters<typeof verifiedFetch>[0]=[];
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:verifiedFetch(calls)});
    const status=await client.verify();assert.equal(status.authenticated,true);assert.equal(calls[0].path,REFRESH);
    assert.equal(calls[0].query.get('type'),'acc');assert.equal(calls[0].headers.get('authorization'),`Bearer ${initial.refreshToken}`);
    assert.deepEqual(calls.slice(1).map(c=>c.path),[WALLETS,USER]);
    const saved=JSON.parse(readFileSync(f.path,'utf8'));assert.equal(saved.accessToken,jwt(NOW+7200000));
    assert.equal(saved.refreshToken,jwt(NOW+14*86400000));assert.equal(lstatSync(f.path).mode&0o777,0o600);
  }finally{f.cleanup();}
});

test('refresh-token renewal is supported even before a still-valid access token approaches expiration',async()=>{
  const initial=session({refreshToken:jwt(NOW+12*3600000)}),f=fixture(initial),calls:Parameters<typeof verifiedFetch>[0]=[];
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:verifiedFetch(calls)});
    assert.equal((await client.verify()).authenticated,true);assert.equal(calls[0].path,REFRESH);
    assert.equal(calls[0].query.get('type'),'ref');assert.equal(calls[0].headers.get('authorization'),`Bearer ${initial.refreshToken}`);
  }finally{f.cleanup();}
});

test('401 immediately clears authenticated status; a subsequent read refreshes and verifies before reuse',async()=>{
  const f=fixture(),calls:Parameters<typeof verifiedFetch>[0]=[];let denied=true;
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:verifiedFetch(calls,()=>denied?
      new Response('secret-upstream',{status:401}):new Response('{"status":1,"data":{"list":[]}}'))});
    assert.equal((await client.verify()).authenticated,true);
    await assert.rejects(client.fetcher(FEED),reason('AUTH_REQUIRED'));assert.equal(client.getStatus().authenticated,false);assert.equal(client.getStatus().status,'required');
    denied=false;await client.fetcher(FEED);assert.equal(client.getStatus().authenticated,true);
    assert.equal(calls[3].path,REFRESH);assert.equal(calls[3].query.get('type'),'acc');
    assert.deepEqual(calls.slice(4).map(c=>c.path),[WALLETS,USER,'/v2api/signals/v2/public/multi_chain/list']);
  }finally{f.cleanup();}
});

test('signal 429 passes a safe Retry-After to the scanner and suppresses requests through the whole cooldown',async()=>{
  const f=fixture(),calls:Parameters<typeof verifiedFetch>[0]=[];let current=NOW,limited=true;
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(current),fetcher:verifiedFetch(calls,()=>limited?
      new Response('secret-upstream',{status:429,headers:{'retry-after':'180','authorization':'Bearer private-response'}}):
      new Response('{"status":1,"data":{"list":[]}}'))});
    const request=()=>fetchAveSignalPage(['bsc'],{fetcher:client.fetcher,now:()=>new Date(current)});
    await assert.rejects(request(),error=>{assert.ok(error instanceof AveSignalError);assert.equal(error.reason,'AVE_SIGNAL_HTTP_429');
      assert.equal(error.cooldownUntil,NOW+180000);return true;});
    assert.equal(calls.length,3);assert.equal(client.getStatus().cooldownUntil,new Date(NOW+180000).toISOString());
    current=NOW+61000;const response=await client.fetcher(FEED);assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'119');
    assert.equal(response.headers.get('authorization'),null);assert.equal(await response.text(),'');assert.equal(calls.length,3);
    limited=false;current=NOW+181000;assert.equal((await request()).received,0);assert.equal(calls.length,6);
    assert.equal(client.getStatus().authenticated,true);assert.equal(client.getStatus().cooldownUntil,undefined);
  }finally{f.cleanup();}
});

test('identity and refresh rate limits also honor cooldown instead of reissuing authentication requests',async()=>{
  for(const accessToken of [jwt(),jwt(NOW-1)]) {
    const f=fixture(session({accessToken}));let calls=0,current=NOW;
    try {
      const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(current),fetcher:async()=>{
        calls++;return new Response('secret-upstream',{status:429,headers:{'retry-after':new Date(NOW+300000).toUTCString()}});
      }});
      assert.equal((await client.verify()).reason,'AVE_SESSION_RATE_LIMITED');assert.equal(calls,1);
      current+=60000;assert.equal((await client.verify()).reason,'AVE_SESSION_RATE_LIMITED');assert.equal(calls,1);
      assert.equal((await client.fetcher(FEED)).status,429);assert.equal(calls,1);
      assert.equal(client.getStatus().cooldownUntil,new Date(NOW+300000).toISOString());
    }finally{f.cleanup();}
  }
});

test('Retry-After is bounded to numeric seconds without forwarding provider response secrets',async()=>{
  for(const [header,expected] of [['malformed','60'],['5','60'],['9999999','3600']]) {
    const f=fixture(session({accessToken:undefined,refreshToken:undefined}));
    try {
      const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:async()=>
        new Response('secret-upstream',{status:429,headers:{'retry-after':header,'set-cookie':'private-response'}})});
      const response=await client.fetcher(FEED);assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),expected);
      assert.equal(response.headers.get('set-cookie'),null);assert.equal(await response.text(),'');
    }finally{f.cleanup();}
  }
});

test('failed refresh preserves original file for recovery and marks session required without exposing responses',async()=>{
  const f=fixture(session({accessToken:jwt(NOW-1)})),before=readFileSync(f.path,'utf8');
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:async()=>new Response('secret-upstream',{status:500})});
    const status=await client.verify();assert.equal(status.status,'required');assert.equal(status.reason,'AVE_SESSION_REFRESH_FAILED');
    assert.equal(readFileSync(f.path,'utf8'),before);assert.equal(JSON.stringify(status).includes('secret'),false);
  }finally{f.cleanup();}
});

test('expired or absent refresh tokens cannot revive expired access without a login',async()=>{
  for(const refreshToken of [undefined,jwt(NOW-1000)]) {
    const f=fixture(session({accessToken:jwt(NOW-1),refreshToken}));let calls=0;
    try {
      const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:async()=>{calls++;return success({});}});
      const status=await client.verify();assert.equal(status.status,'required');assert.equal(status.authenticated,false);assert.equal(calls,0);
    }finally{f.cleanup();}
  }
});

test('server-triggered access renewal 401 retries ref once, then verifies only the returned renewed tokens',async()=>{
  const f=fixture(session({accessToken:jwt(NOW-1)})),kinds:string[]=[];let first=true;
  try {
    const base=verifiedFetch(),client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:async(url,init)=>{
      const parsed=new URL(String(url));if(parsed.pathname===REFRESH){kinds.push(parsed.searchParams.get('type')!);
        if(first){first=false;return new Response(null,{status:401});}}
      return base(url,init);
    }});
    assert.equal((await client.verify()).authenticated,true);assert.deepEqual(kinds,['acc','ref','acc']);
  }finally{f.cleanup();}
});

test('session file replacement invalidates cached identity and refresh cannot overwrite a newer login',async()=>{
  const f=fixture(session({accessToken:jwt(NOW-1)})),replacement=session({accessToken:'newer-login-token'});
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:async()=>{
      await saveAveSession(f.path,replacement);return success({accessToken:jwt(NOW+7200000)});
    }});
    const status=await client.verify();assert.equal(status.authenticated,false);assert.equal(status.reason,'AVE_SESSION_FILE_CHANGED');
    assert.deepEqual(JSON.parse(readFileSync(f.path,'utf8')),replacement);
  }finally{f.cleanup();}
});

test('world-readable files/directories and symlinks cannot supply credentials',async()=>{
  for(const mode of ['file','directory','symlink'] as const) {
    const f=fixture();let calls=0;
    try {
      let path=f.path;
      if(mode==='file')chmodSync(path,0o644);
      if(mode==='directory')chmodSync(f.directory,0o755);
      if(mode==='symlink'){path=join(f.directory,'link.json');symlinkSync(f.path,path);}
      const client=new AveSessionClient({path,email:EMAIL,now:()=>new Date(NOW),fetcher:async()=>{calls++;return success({});}});
      assert.equal((await client.verify()).authenticated,false);assert.equal(calls,0);
    }finally{chmodSync(f.directory,0o700);f.cleanup();}
  }
});

test('redirects, oversized replies and x-auth errors fail without returning headers or secret body',async()=>{
  const cases:[()=>Response,string][]=[
    [()=>new Response(null,{status:302,headers:{location:'https://evil.test/steal'}}),'REDIRECT_REJECTED'],
    [()=>new Response('secret-upstream',{headers:{'content-length':'9999999'}}),'RESPONSE_TOO_LARGE'],
    [()=>new Response('secret-upstream',{status:403}),'X_AUTH_REQUIRED'],
    [()=>new Response('{"status":10000,"msg":"secret-upstream"}'),'X_AUTH_REQUIRED'],
  ];
  for(const [response,code] of cases){const f=fixture();try{
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:async()=>response()});
    const status=await client.verify();assert.equal(status.authenticated,false);assert.equal(status.reason,`AVE_SESSION_${code}`);
    assert.equal(JSON.stringify(status).includes('secret'),false);
  }finally{f.cleanup();}}
});

test('caller abort bounds transports that ignore AbortSignal and does not block the next verification',async()=>{
  const f=fixture(),controller=new AbortController();let hanging=true,started!:()=>void;
  const begun=new Promise<void>(resolve=>{started=resolve;});
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:async(url,init)=>{
      if(hanging){started();return new Promise<Response>(()=>{});}return verifiedFetch()(url,init);
    }});
    const pending=client.verify(controller.signal);await begun;controller.abort();assert.equal((await pending).reason,'AVE_SESSION_REQUEST_TIMEOUT');
    await new Promise(resolve=>setImmediate(resolve));hanging=false;assert.equal((await client.verify()).authenticated,true);
  }finally{controller.abort();f.cleanup();}
});

test('eight-second total budget includes identity lookup and hanging response-body reads',async t=>{
  const f=fixture();let begun!:()=>void;const started=new Promise<void>(resolve=>{begun=resolve;});
  t.mock.timers.enable({apis:['setTimeout']});
  try {
    const client=new AveSessionClient({path:f.path,email:EMAIL,now:()=>new Date(NOW),fetcher:async()=>new Response(new ReadableStream<Uint8Array>({
      pull(){begun();return new Promise<void>(()=>{});},
    }))});
    const pending=client.verify();await started;t.mock.timers.tick(8000);const result=await pending;
    assert.equal(result.status,'unavailable');assert.equal(result.reason,'AVE_SESSION_REQUEST_TIMEOUT');
  }finally{f.cleanup();}
});
