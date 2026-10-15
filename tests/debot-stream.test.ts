import test from 'node:test';
import assert from 'node:assert/strict';
import {DebotStream,type DebotSocket,type DebotSocketFactory,type DebotStreamOptions} from '../src/debot-stream.js';
import type {NormalizedDebotSignals} from '../src/providers/debot-signals.js';
import {DebotSessionError} from '../src/providers/debot-session.js';

const epoch=Date.parse('2026-10-15T10:00:00Z');
function deferred<T=void>() {
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
class Socket implements DebotSocket {
  readonly listeners=new Map<string,((...args:any[])=>void)[]>();
  readonly sent:{event:string;args:unknown[]}[]=[];
  connections=0;disconnections=0;
  on(event:string,listener:(...args:any[])=>void){this.listeners.set(event,[...(this.listeners.get(event)??[]),listener]);return this;}
  emit(event:string,...args:unknown[]){this.sent.push({event,args});return this;}
  connect(){this.connections++;return this;}
  disconnect(){this.disconnections++;this.receive('disconnect','io client disconnect');return this;}
  removeAllListeners(){this.listeners.clear();return this;}
  receive(event:string,...args:unknown[]){for(const listener of [...(this.listeners.get(event)??[])])listener(...args);}
}
function fixture(overrides:Partial<DebotStreamOptions>={}) {
  let time=epoch,sessions=0;
  const sockets:Socket[]=[],factoryCalls:{url:string;options:Parameters<DebotSocketFactory>[1]}[]=[],pages:NormalizedDebotSignals[]=[];
  const options:DebotStreamOptions={chains:['bsc','solana','robinhood'],now:()=>new Date(time),
    getSession:async()=>({subToken:`TEST-TOKEN-${++sessions}`,cookieHeader:'TEST-COOKIE=value'}),
    onPage:page=>{pages.push(page);},socketFactory:(url,options)=>{
      factoryCalls.push({url,options});const socket=new Socket();sockets.push(socket);return socket;
    },...overrides};
  const stream=new DebotStream(options);
  const notification=(chain='bsc',id='one')=>({chain,data:JSON.stringify({results:[{id,chain,channel_id:chain==='bsc'?2:chain==='robinhood'?83:1,
    token:chain==='solana'?'11111111111111111111111111111111':'0x'+'1'.repeat(40),create_time:Math.floor(time/1000)}]})});
  const authorize=(socket=sockets.at(-1)!)=>{socket.receive('connect');socket.receive('authorization','success');};
  return {stream,sockets,pages,factoryCalls,notification,authorize,sessions:()=>sessions,advance:(ms:number)=>{time+=ms;}};
}

test('authenticated stream uses only the verified WebSocket path and subscribes after exact authorization success',async()=>{
  let authorized=0;
  const f=fixture({onAuthorized:()=>{authorized++;}});
  try {
    await f.stream.start();await f.stream.start();assert.equal(f.sockets.length,1);
    const call=f.factoryCalls[0],socket=f.sockets[0];
    assert.equal(call.url,'wss://debot.ai');assert.equal(call.options.path,'/portal-ws');
    assert.deepEqual(call.options.transports,['websocket']);assert.equal(call.options.timeout,5000);
    assert.equal(call.options.reconnection,false);assert.equal(call.options.autoConnect,false);
    assert.equal(call.options.forceNew,true);assert.match(String(call.options.query?.bid),/^\d{6}$/);
    assert.deepEqual(call.options.extraHeaders,{Cookie:'TEST-COOKIE=value'});assert.equal(socket.connections,1);
    socket.receive('community-signal-channel-new-notification',f.notification());await flush();assert.equal(f.pages.length,0);
    socket.receive('connect');assert.equal(f.stream.getStatus().state,'authorizing');
    assert.deepEqual(socket.sent,[{event:'authorization',args:['TEST-TOKEN-1']}]);
    socket.receive('community-signal-channel-new-notification',f.notification());await flush();assert.equal(f.pages.length,0);
    socket.receive('authorization','success');await flush();
    assert.deepEqual(socket.sent[1],{event:'subscribe',args:['community-signal-channel:2','community-signal-channel:1','community-signal-channel:83']});
    assert.equal(authorized,1);assert.equal(f.stream.getStatus().state,'live');assert.equal(f.stream.getStatus().authorized,true);
    socket.receive('authorization','success');await flush();assert.equal(socket.sent.length,2);assert.equal(authorized,1);
    assert.equal(f.stream.getStatus().lastAuthorizedAt,new Date(epoch).toISOString());
    assert.ok(!JSON.stringify(f.stream.getStatus()).includes('TEST-TOKEN'));assert.ok(!JSON.stringify(f.stream.getStatus()).includes('TEST-COOKIE'));
  }finally{await f.stream.stop();}
});

test('accepted push pages keep the original timestamp and token, while unsubscribed chains and malformed frames never enter collection',async()=>{
  const f=fixture({chains:['bsc']});
  try {
    await f.stream.start();f.authorize();const socket=f.sockets[0];
    socket.receive('community-signal-channel-new-notification',f.notification());await flush();
    assert.equal(f.pages.length,1);assert.equal(f.pages[0].observations[0].signal.source,'debot');
    assert.equal(f.pages[0].observations[0].signal.occurredAt,new Date(epoch).toISOString());
    assert.equal(f.stream.getStatus().received,1);assert.equal(f.stream.getStatus().lastSignalAt,new Date(epoch).toISOString());
    socket.receive('community-signal-channel-new-notification',f.notification('robinhood'));await flush();
    assert.equal(f.pages.length,1);assert.equal(f.stream.getStatus().lastError,'DEBOT_STREAM_CHAIN_NOT_SUBSCRIBED');
    socket.receive('community-signal-channel-new-notification',{data:'PRIVATE INVALID FRAME'});await flush();
    assert.equal(f.pages.length,1);assert.equal(f.stream.getStatus().lastError,'DEBOT_STREAM_MESSAGE_INVALID');
    assert.ok(!JSON.stringify(f.stream.getStatus()).includes('PRIVATE'));
    f.advance(1000);socket.receive('community-signal-channel-new-notification',f.notification('bsc','two'));await flush();
    assert.equal(f.stream.getStatus().state,'live');assert.equal(f.stream.getStatus().received,2);
  }finally{await f.stream.stop();}
});

test('every reconnect loads a fresh session and repeats authorization before subscribing',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();
  try {
    await f.stream.start();f.authorize();const first=f.sockets[0];
    first.receive('disconnect','transport close');assert.equal(f.stream.getStatus().state,'disconnected');
    assert.equal(f.stream.getStatus().authorized,false);assert.equal(f.stream.getStatus().connected,false);
    f.advance(999);t.mock.timers.tick(999);await flush();assert.equal(f.sockets.length,1);
    f.advance(1);t.mock.timers.tick(1);await flush();assert.equal(f.sockets.length,2);assert.equal(f.sessions(),2);
    const next=f.sockets[1];assert.equal(next.sent.length,0);next.receive('connect');
    assert.deepEqual(next.sent,[{event:'authorization',args:['TEST-TOKEN-2']}]);
    next.receive('authorization','success');await flush();assert.equal(next.sent[1].event,'subscribe');
    assert.equal(f.stream.getStatus().reconnects,1);
    first.receive('authorization','failed');assert.equal(f.stream.getStatus().state,'live');
  }finally{await f.stream.stop();}
});

test('HTTP session expiration invalidates a live stream and prevents background reconnects',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();
  try{
    await f.stream.start();f.authorize();const old=f.sockets[0];
    assert.equal(f.stream.getStatus().authorized,true);
    f.stream.invalidateSession();
    assert.equal(f.stream.getStatus().state,'auth_required');
    assert.equal(f.stream.getStatus().authorized,false);assert.equal(f.stream.getStatus().running,false);
    assert.equal(f.stream.getStatus().lastError,'DEBOT_SESSION_AUTH_REQUIRED');
    old.receive('community-signal-channel-new-notification',f.notification());
    t.mock.timers.tick(60000);await flush();assert.equal(f.pages.length,0);assert.equal(f.sockets.length,1);
    await f.stream.start();f.authorize();assert.equal(f.sockets.length,2);assert.equal(f.stream.getStatus().authorized,true);
  }finally{await f.stream.stop();}
});

test('transport errors use exponential backoff and never expose upstream exception text or retry with anonymous polling',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();
  try {
    await f.stream.start();
    for(const delay of [1000,2000,4000,8000]) {
      const count=f.sockets.length;
      f.sockets.at(-1)!.receive('connect_error',new Error('PRIVATE TOKEN AND COOKIE'));
      assert.equal(f.stream.getStatus().lastError,'DEBOT_STREAM_CONNECT_FAILED');
      f.advance(delay-1);t.mock.timers.tick(delay-1);await flush();assert.equal(f.sockets.length,count);
      f.advance(1);t.mock.timers.tick(1);await flush();assert.equal(f.sockets.length,count+1);
    }
    assert.equal(f.sessions(),5);assert.equal(f.stream.getStatus().reconnects,4);
    assert.ok(!JSON.stringify(f.stream.getStatus()).includes('PRIVATE'));
    assert.ok(f.factoryCalls.every(call=>JSON.stringify(call.options.transports)==='["websocket"]'));
  }finally{await f.stream.stop();}
});

test('authorization rejection halts reconnecting, ignores later success and requires an explicit restart',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();
  try {
    await f.stream.start();const socket=f.sockets[0];socket.receive('connect');
    socket.receive('authorization',{error:'PRIVATE REJECTED TOKEN'});
    assert.equal(f.stream.getStatus().state,'auth_required');assert.equal(f.stream.getStatus().running,false);
    assert.equal(f.stream.getStatus().lastError,'DEBOT_STREAM_AUTH_REJECTED');
    socket.receive('authorization','success');f.advance(120000);t.mock.timers.tick(120000);await flush();
    assert.equal(f.sockets.length,1);assert.equal(socket.sent.length,1);
    assert.ok(!JSON.stringify(f.stream.getStatus()).includes('PRIVATE'));
    await f.stream.start();assert.equal(f.sockets.length,2);assert.equal(f.sessions(),2);
    f.authorize();assert.equal(f.stream.getStatus().state,'live');
  }finally{await f.stream.stop();}
});

test('authorization acknowledgement must arrive within ten seconds and a timeout reconnects with a new session',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();
  try {
    await f.stream.start();f.sockets[0].receive('connect');
    f.advance(9999);t.mock.timers.tick(9999);await flush();assert.equal(f.stream.getStatus().state,'authorizing');
    f.advance(1);t.mock.timers.tick(1);await flush();assert.equal(f.stream.getStatus().lastError,'DEBOT_STREAM_AUTH_TIMEOUT');
    assert.equal(f.stream.getStatus().authorized,false);assert.equal(f.sockets[0].disconnections,1);
    f.advance(1000);t.mock.timers.tick(1000);await flush();assert.equal(f.sockets.length,2);
    f.authorize();f.advance(10000);t.mock.timers.tick(10000);await flush();assert.equal(f.stream.getStatus().state,'live');
  }finally{await f.stream.stop();}
});

test('missing or invalid sessions produce a fixed authentication error without creating a socket',async t=>{
  for(const getSession of [async()=>{throw new DebotSessionError('DEBOT_SESSION_FILE_MISSING');},async()=>({subToken:''}),
    async()=>({subToken:'ok',cookieHeader:'bad\r\nheader'})])await t.test('session',async()=>{
      const f=fixture({getSession});try {
        await f.stream.start();assert.equal(f.sockets.length,0);assert.equal(f.stream.getStatus().state,'auth_required');
        assert.ok(['DEBOT_SESSION_FILE_MISSING','DEBOT_SESSION_FILE_INVALID'].includes(f.stream.getStatus().lastError!));
        assert.ok(!JSON.stringify(f.stream.getStatus()).includes('PRIVATE'));
      }finally{await f.stream.stop();}
    });
});

test('temporary session failures retry with backoff and rate limits wait at least sixty seconds',async t=>{
  for(const reason of ['DEBOT_SESSION_REQUEST_TIMEOUT','DEBOT_SESSION_REQUEST_FAILED','DEBOT_SESSION_HTTP_ERROR',
    'DEBOT_SESSION_RATE_LIMITED','DEBOT_SESSION_FILE_CHANGED','DEBOT_SESSION_RESPONSE_INVALID','private unknown error'])
    await t.test(reason,async sub=>{
      sub.mock.timers.enable({apis:['setTimeout']});let requests=0;
      const f=fixture({getSession:async()=>{
        if(++requests===1)throw reason==='private unknown error'?new Error('PRIVATE ERROR CONTENT'):new DebotSessionError(reason);
        return {subToken:'TEST-RECOVERED'};
      }});
      try {
        await f.stream.start();assert.equal(f.stream.getStatus().running,true);assert.equal(f.stream.getStatus().state,'error');
        assert.equal(f.stream.getStatus().lastError,reason==='private unknown error'?'DEBOT_STREAM_SESSION_FAILED':reason);
        const delay=reason==='DEBOT_SESSION_RATE_LIMITED'?60000:1000;
        f.advance(delay-1);sub.mock.timers.tick(delay-1);await flush();assert.equal(requests,1);
        f.advance(1);sub.mock.timers.tick(1);await flush();assert.equal(requests,2);assert.equal(f.sockets.length,1);
        f.authorize();assert.equal(f.stream.getStatus().state,'live');
        assert.ok(!JSON.stringify(f.stream.getStatus()).includes('PRIVATE'));
      }finally{await f.stream.stop();}
    });
});

test('session permission and authentication failures stop retrying instead of treating them as temporary network errors',async t=>{
  for(const reason of ['DEBOT_SESSION_FILE_PERMISSIONS','DEBOT_SESSION_AUTH_REQUIRED'])await t.test(reason,async sub=>{
    sub.mock.timers.enable({apis:['setTimeout']});let requests=0;
    const f=fixture({getSession:async()=>{requests++;throw new DebotSessionError(reason);}});
    try {
      await f.stream.start();assert.equal(f.stream.getStatus().state,'auth_required');assert.equal(f.stream.getStatus().lastError,reason);
      f.advance(600000);sub.mock.timers.tick(600000);await flush();assert.equal(requests,1);assert.equal(f.sockets.length,0);
    }finally{await f.stream.stop();}
  });
});

test('push delay reports newest and oldest event ages at receipt and warns without disconnecting or disguising old data',async()=>{
  const capture=deferred();const f=fixture({onPage:()=>capture.promise});
  try {
    await f.stream.start();f.authorize();const socket=f.sockets[0];
    const notification=f.notification();const data=JSON.parse(notification.data);
    data.results[0].create_time-=30;
    data.results.push({...data.results[0],id:'older',create_time:data.results[0].create_time-570});
    socket.receive('community-signal-channel-new-notification',{...notification,data:JSON.stringify(data)});await flush();
    assert.equal(f.stream.getStatus().lastSignalDelayMs,30000);assert.equal(f.stream.getStatus().maxSignalDelayMs,600000);
    assert.equal(f.stream.getStatus().lastError,'DEBOT_STREAM_DELAYED');assert.equal(socket.disconnections,0);
    assert.equal(f.stream.getStatus().authorized,true);
    f.advance(50000);capture.resolve();await flush();
    assert.equal(f.stream.getStatus().lastSignalDelayMs,30000);assert.equal(f.stream.getStatus().maxSignalDelayMs,600000);
    assert.equal(f.stream.getStatus().state,'live');assert.equal(f.stream.getStatus().received,2);
    socket.receive('community-signal-channel-new-notification',f.notification('bsc','fresh'));await flush();
    assert.equal(f.stream.getStatus().lastSignalDelayMs,0);assert.equal(f.stream.getStatus().maxSignalDelayMs,0);
    assert.equal(f.stream.getStatus().lastError,undefined);assert.equal(socket.disconnections,0);
  }finally{capture.resolve();await f.stream.stop();}
});

test('stop drains accepted persistence and authorization callbacks, while rejecting new frames and cancelling reconnects',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const capture=deferred(),sync=deferred();let captures=0;
  const f=fixture({onPage:async()=>{captures++;await capture.promise;},onAuthorized:()=>sync.promise});
  try {
    await f.stream.start();f.authorize();f.sockets[0].receive('community-signal-channel-new-notification',f.notification());await flush();
    assert.equal(captures,1);let stopped=false;
    const stopping=f.stream.stop().then(()=>{stopped=true;});await flush();assert.equal(stopped,false);
    f.sockets[0].receive('community-signal-channel-new-notification',f.notification('bsc','late'));assert.equal(captures,1);
    capture.resolve();await flush();assert.equal(stopped,false);sync.resolve();await stopping;
    assert.equal(f.stream.getStatus().state,'stopped');assert.equal(f.stream.getStatus().received,1);
    f.advance(120000);t.mock.timers.tick(120000);await flush();assert.equal(f.sockets.length,1);
  }finally{capture.resolve();sync.resolve();await f.stream.stop();}
});

test('stop while fetching a session discards its late result and waits for the connection setup to settle',async()=>{
  const session=deferred<{subToken:string}>();const f=fixture({getSession:()=>session.promise});
  try {
    const starting=f.stream.start();let stopped=false;const stopping=f.stream.stop().then(()=>{stopped=true;});
    await flush();assert.equal(stopped,false);session.resolve({subToken:'TEST-LATE'});await Promise.all([starting,stopping]);
    assert.equal(f.sockets.length,0);assert.equal(f.stream.getStatus().state,'stopped');
  }finally{session.resolve({subToken:'TEST-LATE'});await f.stream.stop();}
});

test('callback failures stay observable, do not leak errors and do not count failed captures as received',async()=>{
  const f=fixture({onPage:async()=>{throw new Error('PRIVATE DATABASE CONTENT');},onAuthorized:async()=>{throw new Error('PRIVATE SESSION');}});
  try {
    await f.stream.start();f.authorize();await flush();assert.equal(f.stream.getStatus().lastError,'DEBOT_STREAM_SYNC_FAILED');
    f.sockets[0].receive('community-signal-channel-new-notification',f.notification());await flush();
    assert.equal(f.stream.getStatus().lastError,'DEBOT_STREAM_CAPTURE_FAILED');assert.equal(f.stream.getStatus().received,0);
    assert.ok(!JSON.stringify(f.stream.getStatus()).includes('PRIVATE'));
  }finally{await f.stream.stop();}
});

test('authorization reconciliation does not block immediate live signal persistence',async()=>{
  const sync=deferred();const f=fixture({onAuthorized:()=>sync.promise});
  try {
    await f.stream.start();f.authorize();f.sockets[0].receive('community-signal-channel-new-notification',f.notification());await flush();
    assert.equal(f.pages.length,1);assert.equal(f.stream.getStatus().received,1);
  }finally{sync.resolve();await f.stream.stop();}
});

test('out-of-order persistence completion cannot move the latest signal receipt time backwards',async()=>{
  const first=deferred();let captures=0;
  const f=fixture({onPage:async()=>{if(++captures===1)await first.promise;}});
  try {
    await f.stream.start();f.authorize();const socket=f.sockets[0];
    socket.receive('community-signal-channel-new-notification',f.notification('bsc','first'));await flush();
    f.advance(1000);socket.receive('community-signal-channel-new-notification',f.notification('bsc','second'));await flush();
    assert.equal(f.stream.getStatus().lastSignalAt,new Date(epoch+1000).toISOString());
    first.resolve();await flush();assert.equal(f.stream.getStatus().received,2);
    assert.equal(f.stream.getStatus().lastSignalAt,new Date(epoch+1000).toISOString());
  }finally{first.resolve();await f.stream.stop();}
});

test('persistence callback backlog is bounded and exposed before disconnecting for recovery',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const writes=deferred();let captures=0;
  const f=fixture({onPage:async()=>{captures++;await writes.promise;}});
  try {
    await f.stream.start();f.authorize();const socket=f.sockets[0];
    for(let i=0;i<65;i++)socket.receive('community-signal-channel-new-notification',f.notification('bsc',`event-${i}`));
    assert.equal(captures,64);assert.equal(f.stream.getStatus().lastError,'DEBOT_STREAM_CAPTURE_BACKLOG');
    assert.equal(f.stream.getStatus().connected,false);assert.equal(socket.disconnections,1);
    writes.resolve();await flush();assert.equal(f.stream.getStatus().received,64);
  }finally{writes.resolve();await f.stream.stop();}
});
