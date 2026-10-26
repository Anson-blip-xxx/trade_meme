import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import type {ClientRequest,IncomingMessage} from 'node:http';
import {telegramIpv4Fetch} from '../src/telegram-transport.js';
import {TelegramNotifier,type TelegramNotifierOptions} from '../src/telegram-notifier.js';

const token='12345:TEST_SECRET',chatId='-123456789';
const ok=()=>new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200});
function fixture(t:{after:(fn:()=>Promise<void>)=>void},options:Partial<TelegramNotifierOptions>={}) {
  const dir=mkdtempSync(join(tmpdir(),'meme-telegram-')),path=join(dir,'outbox.sqlite');
  let clock=100000,calls:{url:string;init:RequestInit|undefined}[]=[];
  const request:typeof fetch=async(url,init)=>{calls.push({url:String(url),init});return ok();};
  const all:TelegramNotifier[]=[];
  const make=(changes:Partial<TelegramNotifierOptions>={})=>{
    const notifier=new TelegramNotifier(path,{token,chatId,now:()=>clock,fetch:request,...options,...changes});all.push(notifier);return notifier;
  };
  const notifier=make();
  t.after(async()=>{await Promise.all(all.map(n=>n.close()));rmSync(dir,{recursive:true,force:true});});
  return {notifier,make,path,calls,advance:(ms:number)=>{clock+=ms;}};
}

test('durable keys deduplicate queued and acknowledged events across restarts without persisting credentials',async t=>{
  const {notifier,make,path,calls,advance}=fixture(t);
  assert.equal(notifier.enqueue({key:'order:a:filled',text:'<b>代币 X</b> +20%'}),true);
  assert.equal(notifier.enqueue({key:'order:a:filled',text:'duplicate'}),false);
  await notifier.close();const restored=make();await restored.flush();
  assert.equal(calls.length,1);assert.equal(restored.status().sent,1);
  const payload=JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(payload,{chat_id:chatId,text:'&lt;b&gt;代币 X&lt;/b&gt; +20%',parse_mode:'HTML',link_preview_options:{is_disabled:true}});
  assert.equal(calls[0].init?.redirect,'error');
  await restored.close();advance(1000);const again=make();
  assert.equal(again.enqueue({key:'order:a:filled',text:'should not send'}),false);await again.flush();assert.equal(calls.length,1);
  const db=new DatabaseSync(path,{readOnly:true});
  assert.equal(db.prepare('SELECT text FROM telegram_outbox').get()?.text,'');
  const stored=JSON.stringify(db.prepare('SELECT * FROM telegram_meta').all());db.close();
  assert.equal(stored.includes(token),false);assert.equal(stored.includes(chatId),false);assert.equal(statSync(path).mode&0o777,0o600);
});

test('concurrent flush and restarts respect persistent one message per second pacing',async t=>{
  const {notifier,calls,advance,make}=fixture(t,{intervalMs:1});
  notifier.enqueue({key:'a',text:'one'});notifier.enqueue({key:'b',text:'two'});
  await Promise.all([notifier.flush(),notifier.flush(),notifier.flush()]);assert.equal(calls.length,1);
  await notifier.close();const restarted=make({intervalMs:1});await restarted.flush();assert.equal(calls.length,1);
  advance(999);await restarted.flush();assert.equal(calls.length,1);advance(1);await restarted.flush();assert.equal(calls.length,2);
});

test('plaintext outbox delivers styled holdings and matching token buttons without a schema migration',async t=>{
  const {notifier,path,calls}=fixture(t);
  const mint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',url=`https://gmgn.ai/sol/token/${mint}`;
  const text=`【实盘持仓监控】BONK · Solana\n相对买入价：+12.50%\nCA：${mint}\n${url}`;
  notifier.enqueue({key:'holding:style',text});
  const db=new DatabaseSync(path,{readOnly:true});
  assert.equal(db.prepare('SELECT text FROM telegram_outbox').get()?.text,text);db.close();
  await notifier.flush();
  const payload=JSON.parse(String(calls[0].init?.body));
  assert.equal(payload.parse_mode,'HTML');assert.match(payload.text,/<b>BONK · Solana<\/b>/);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].url,url);assert.equal(notifier.status().sent,1);
});

test('callback buttons persist separately from visible text through restart and override automatic page navigation',async t=>{
  const {notifier,make,path,calls}=fixture(t);
  const ref='0123456789abcdef0123456789abcdef',buttons=[
    [{text:'平仓 BONK',callback_data:`close:preview:${ref}`}],
    [{text:'刷新',callback_data:'positions:1'},{text:'下一页',callback_data:'positions:2'}],
  ];
  const text='【持仓查询】\n第 1 / 2 页 · 共 8 个持仓\n名称：BONK';
  notifier.enqueue({key:'positions:page:1',text,buttons});
  const db=new DatabaseSync(path,{readOnly:true});const row=db.prepare('SELECT text,buttons FROM telegram_outbox').get();db.close();
  assert.equal(row?.text,text);assert.equal(String(row?.text).includes(ref),false);assert.deepEqual(JSON.parse(String(row?.buttons)),buttons);
  await notifier.close();const restored=make();await restored.flush();
  const body=JSON.parse(String(calls[0].init?.body));assert.deepEqual(body.reply_markup,{inline_keyboard:buttons});
  assert.equal(body.text.includes(ref),false);assert.equal(restored.status().sent,1);
  const check=new DatabaseSync(path,{readOnly:true});assert.equal(check.prepare('SELECT buttons FROM telegram_outbox').get()?.buttons,null);check.close();
});

test('mixed callback and official token URL buttons survive the durable outbox',async t=>{
  const {notifier,make,path,calls}=fixture(t);
  const mint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const buttons=[
    [{text:'买入 0.1 SOL',callback_data:`token:buy:a:${mint}`},{text:'刷新',callback_data:`token:refresh:${mint}`}],
    [{text:'GMGN',url:`https://gmgn.ai/sol/token/${mint}`},{text:'DexScreener',url:`https://dexscreener.com/solana/${mint}`},
      {text:'Solscan',url:`https://solscan.io/token/${mint}`},{text:'Pump',url:`https://pump.fun/coin/${mint}`}],
  ];
  notifier.enqueue({key:'token:structured',text:'【合约详情】BONK · Solana',buttons});
  const db=new DatabaseSync(path,{readOnly:true});
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT buttons FROM telegram_outbox').get()?.buttons)),buttons);db.close();
  await notifier.close();const restored=make();await restored.flush();
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)).reply_markup,{inline_keyboard:buttons});
  assert.equal(restored.status().sent,1);
});

test('old outbox schema migrates pending plaintext without losing content or creating buttons',async t=>{
  const {notifier,make,path,calls}=fixture(t);notifier.enqueue({key:'legacy',text:'legacy pending'});await notifier.close();
  const db=new DatabaseSync(path);db.exec('ALTER TABLE telegram_outbox DROP COLUMN buttons');db.close();
  const restored=make();await restored.flush();assert.equal(calls.length,1);assert.equal(restored.status().sent,1);
  assert.equal(JSON.parse(String(calls[0].init?.body)).reply_markup,undefined);
});

test('button metadata rejects arbitrary destinations, malformed references and oversized rows before networking',async t=>{
  const {notifier,calls}=fixture(t);
  const uuid='66d3b567-b6b9-4444-b7f9-33044ae4ccef';
  const invalid:unknown[]=[null,[],[[]],[[{text:'URL',url:'https://evil.example'}]],
    [[{text:'fake GMGN',url:'https://gmgn.ai.evil.example/sol/token/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'}]],
    [[{text:'extra',callback_data:'positions:1',url:'https://evil.example'}]],
    [[{text:'unknown',callback_data:'buy:all'}]],[[{text:'out of range',callback_data:'positions:10001'}]],
    [[{text:'invalid id',callback_data:'close:confirm:123'}]],[[{text:'invalid ref',callback_data:'close:preview:'+uuid}]],
    [[{text:'oversized',callback_data:'a'.repeat(65)}]],[[{text:'a'.repeat(65),callback_data:'positions:1'}]],
    [[{text:'line\nbreak',callback_data:'positions:1'}]],Array.from({length:11},()=>[{text:'a',callback_data:'positions:1'}]),
    [Array.from({length:4},()=>({text:'a',callback_data:'positions:1'}))],
  ];
  for(const [index,buttons] of invalid.entries())assert.throws(()=>notifier.enqueue({key:'invalid:'+index,text:'body',buttons:buttons as any}),/TELEGRAM_BUTTONS_INVALID/);
  assert.equal(calls.length,0);assert.equal(notifier.status().pending,0);
  notifier.enqueue({key:'valid:confirm',text:'confirmation',buttons:[[
    {text:'确认平仓',callback_data:`close:confirm:${uuid}`},{text:'取消',callback_data:`close:cancel:${uuid}`},
  ]]});await notifier.flush();assert.equal(calls.length,1);
});

test('corrupted stored metadata is rejected without a request and does not block valid following messages',async t=>{
  const {notifier,path,calls,advance}=fixture(t);notifier.enqueue({key:'bad',text:'bad'});notifier.enqueue({key:'good',text:'good'});
  const db=new DatabaseSync(path);db.prepare('UPDATE telegram_outbox SET buttons=? WHERE key=?').run('{invalid','bad');db.close();
  await notifier.flush();assert.equal(calls.length,0);assert.equal(notifier.status().failed,1);
  assert.equal(notifier.status().lastError,'TELEGRAM_REQUEST_REJECTED');advance(1000);await notifier.flush();assert.equal(calls.length,1);
});

test('429 retry_after blocks the whole queue and survives restart',async t=>{
  let attempts=0;const request:typeof fetch=async()=>++attempts===1?
    new Response(JSON.stringify({ok:false,error_code:429,description:token,parameters:{retry_after:30}}),{status:429}):ok();
  const {notifier,make,advance}=fixture(t,{fetch:request});
  notifier.enqueue({key:'a',text:'first'});notifier.enqueue({key:'b',text:'second'});await notifier.flush();
  assert.equal(notifier.status().lastError,'TELEGRAM_RATE_LIMITED');assert.equal(JSON.stringify(notifier.status()).includes(token),false);
  await notifier.close();const restarted=make();advance(29999);await restarted.flush();assert.equal(attempts,1);
  advance(1);await restarted.flush();assert.equal(attempts,2);assert.equal(restarted.status().pending,1);
});

test('temporary network and 5xx failures back off exponentially without discarding pending events',async t=>{
  let attempts=0;const request:typeof fetch=async()=>{attempts++;if(attempts===1)throw new Error('secret URL '+token);if(attempts===2)return new Response('private server description',{status:503});return ok();};
  const {notifier,advance}=fixture(t,{fetch:request,retryBaseMs:2000});
  notifier.enqueue({key:'a',text:'entry'});await notifier.flush();assert.equal(notifier.status().lastError,'TELEGRAM_NETWORK_ERROR');
  advance(1999);await notifier.flush();assert.equal(attempts,1);advance(1);await notifier.flush();assert.equal(attempts,2);
  advance(3999);await notifier.flush();assert.equal(attempts,2);advance(1);await notifier.flush();
  assert.equal(attempts,3);assert.equal(notifier.status().pending,0);assert.equal(notifier.status().sent,1);assert.equal(notifier.status().lastError,undefined);
});

test('service outages back off the entire queue instead of hammering the provider with other events',async t=>{
  let attempts=0;const {notifier,advance}=fixture(t,{fetch:async()=>{attempts++;return new Response('',{status:503});},retryBaseMs:5000});
  for(let i=0;i<10;i++)notifier.enqueue({key:String(i),text:'pending trade'});
  await notifier.flush();advance(1000);await notifier.flush();assert.equal(attempts,1);
  advance(4000);await notifier.flush();assert.equal(attempts,2);assert.equal(notifier.status().pending,10);
});

test('HTTP 200 with ok=false never acknowledges a failed message',async t=>{
  const {notifier}=fixture(t,{fetch:async()=>new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:10}}))});
  notifier.enqueue({key:'a',text:'pending'});await notifier.flush();assert.equal(notifier.status().sent,0);
  assert.equal(notifier.status().pending,1);assert.equal(notifier.status().lastError,'TELEGRAM_RATE_LIMITED');
});

for(const [status,error] of [[401,'TELEGRAM_AUTH_INVALID'],[403,'TELEGRAM_CHAT_FORBIDDEN']] as const) {
  test(`${status} pauses persistently until credentials or chat are corrected`,async t=>{
    let attempts=0;const request:typeof fetch=async()=>{attempts++;return new Response(JSON.stringify({ok:false,description:token+' '+chatId}),{status});};
    const {notifier,make,advance}=fixture(t,{fetch:request});notifier.enqueue({key:'a',text:'buy'});await notifier.flush();
    assert.equal(notifier.status().blocked,true);assert.equal(notifier.status().lastError,error);
    await notifier.close();advance(600000);const restarted=make();restarted.enqueue({key:'b',text:'sell'});
    await restarted.flush();assert.equal(attempts,1);assert.equal(restarted.status().pending,2);
    const serialized=JSON.stringify(restarted.status());assert.equal(serialized.includes(token),false);assert.equal(serialized.includes(chatId),false);
    await restarted.close();const corrected=make({token:'12345:NEW_SECRET',fetch:async()=>{attempts++;return ok();}});
    assert.equal(corrected.status().blocked,false);await corrected.flush();assert.equal(attempts,2);
  });
}

test('permanent rejected messages remain visible without blocking later valid messages',async t=>{
  let attempts=0;const {notifier,advance}=fixture(t,{fetch:async()=>++attempts===1?new Response(JSON.stringify({ok:false,error_code:400,description:'private'}),{status:400}):ok()});
  notifier.enqueue({key:'a',text:'rejected'});notifier.enqueue({key:'b',text:'good'});await notifier.flush();
  assert.equal(notifier.status().failed,1);assert.equal(notifier.status().pending,1);advance(1000);await notifier.flush();assert.equal(notifier.status().sent,1);
});

test('invalid configuration and oversized messages are rejected before networking',async t=>{
  assert.throws(()=>new TelegramNotifier(':memory:',{token:'',chatId}),/TELEGRAM_CONFIG_INVALID/);
  const {notifier,calls}=fixture(t);assert.throws(()=>notifier.enqueue({key:'a',text:'x'.repeat(4097)}),/TELEGRAM_MESSAGE_LENGTH_INVALID/);
  assert.throws(()=>notifier.enqueue({key:'a',text:' '}),/TELEGRAM_MESSAGE_LENGTH_INVALID/);
  assert.throws(()=>notifier.enqueue({key:'',text:'okay'}),/TELEGRAM_EVENT_KEY_INVALID/);
  notifier.enqueue({key:'boundary',text:'x'.repeat(4096)});await notifier.flush();assert.equal(calls.length,1);
});

test('request timeout is sanitized and preserves the event for retry',async t=>{
  const {notifier}=fixture(t,{requestTimeoutMs:10,fetch:async(_url,init)=>new Promise((_resolve,reject)=>{
    init?.signal?.addEventListener('abort',()=>reject(new Error('private URL '+token)),{once:true});
  })});
  notifier.enqueue({key:'a',text:'trade'});await notifier.flush();assert.equal(notifier.status().lastError,'TELEGRAM_REQUEST_TIMEOUT');assert.equal(notifier.status().pending,1);
});

test('close waits for in-flight acknowledgement and prevents new messages while closing',async t=>{
  let resolve!:(response:Response)=>void;
  const {notifier,make}=fixture(t,{fetch:async()=>new Promise<Response>(done=>{resolve=done;})});
  notifier.enqueue({key:'a',text:'filled'});const sending=notifier.flush(),closing=notifier.close();
  assert.throws(()=>notifier.enqueue({key:'b',text:'later'}),/TELEGRAM_NOTIFIER_CLOSED/);
  resolve(ok());await Promise.all([sending,closing]);const restarted=make({fetch:async()=>{throw new Error('must not send');}});
  await restarted.flush();assert.equal(restarted.status().sent,1);assert.equal(restarted.status().pending,0);
});

test('start schedules due work and stop cancels future scheduling',async t=>{
  const {notifier,calls}=fixture(t);notifier.enqueue({key:'a',text:'live start'});notifier.start();
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls.length,1);
  notifier.stop();notifier.enqueue({key:'b',text:'after stop'});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls.length,1);
});

function httpsFixture(t:{mock:{method:(object:typeof https,key:'request',implementation:any)=>any}},
  reply?:{status:number;body?:string;headers?:Record<string,string>;chunks?:Buffer[];abort?:boolean}) {
  const requests:{options:https.RequestOptions;body?:string;destroyed:boolean}[]=[];
  t.mock.method(https,'request',(options:https.RequestOptions,callback:(response:IncomingMessage)=>void)=>{
    const call={options,body:undefined as string|undefined,destroyed:false};requests.push(call);
    const request=new EventEmitter() as ClientRequest;
    request.destroy=()=>{call.destroyed=true;return request;};
    request.end=((body:string)=>{
      call.body=body;
      if(reply)queueMicrotask(()=>{
        const response=new EventEmitter() as IncomingMessage;
        response.statusCode=reply.status;response.headers=reply.headers??{};response.complete=false;
        response.destroy=()=>{response.destroyed=true;return response;};
        callback(response);
        if(response.destroyed)return;
        if(reply.abort){response.emit('aborted');return;}
        for(const chunk of reply.chunks??[Buffer.from(reply.body??'')]) {
          response.emit('data',chunk);if(response.destroyed)return;
        }
        response.complete=true;response.emit('end');response.emit('close');
      });
      return request;
    }) as typeof request.end;
    return request;
  });
  return requests;
}

test('default notifier transport uses verified TLS over IPv4 without changing global fetch',async t=>{
  const globalFetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('GLOBAL_FETCH_MUST_NOT_RUN');});
  const requests=httpsFixture(t,{status:200,body:JSON.stringify({ok:true,result:{message_id:1}})});
  const {notifier}=fixture(t,{fetch:undefined});notifier.enqueue({key:'ipv4',text:'IPv4 delivery'});await notifier.flush();
  assert.equal(notifier.status().sent,1);assert.equal(globalFetch.mock.callCount(),0);assert.equal(requests.length,1);
  const {options,body}=requests[0];
  assert.equal(options.hostname,'api.telegram.org');assert.equal(options.port,443);assert.equal(options.protocol,'https:');
  assert.equal(options.family,4);assert.equal(options.rejectUnauthorized,true);
  assert.equal(options.agent,false);assert.equal(options.method,'POST');assert.equal(options.path,`/bot${token}/sendMessage`);
  assert.equal(JSON.parse(body!).text,'IPv4 delivery');assert.equal(JSON.parse(body!).chat_id,chatId);
});

test('default IPv4 request timeout aborts the socket and retains the pending event',async t=>{
  const requests=httpsFixture(t);
  const {notifier}=fixture(t,{fetch:undefined,requestTimeoutMs:10});notifier.enqueue({key:'timeout',text:'trade'});
  await notifier.flush();assert.equal(requests.length,1);assert.equal(requests[0].destroyed,true);
  assert.equal(notifier.status().pending,1);assert.equal(notifier.status().lastError,'TELEGRAM_REQUEST_TIMEOUT');
});

test('IPv4 transport rejects redirects rather than forwarding bot credentials',async t=>{
  const requests=httpsFixture(t,{status:302,headers:{location:'https://example.com/secret'},body:'redirect'});
  const {notifier}=fixture(t,{fetch:undefined});notifier.enqueue({key:'redirect',text:'trade'});await notifier.flush();
  assert.equal(requests.length,1);assert.equal(requests[0].destroyed,true);
  assert.equal(notifier.status().sent,0);assert.equal(notifier.status().lastError,'TELEGRAM_NETWORK_ERROR');
});

for(const announced of [true,false])test(`IPv4 transport bounds ${announced?'declared':'streamed'} response bodies to 256 KiB`,async t=>{
  const requests=httpsFixture(t,{status:200,...(announced?{headers:{'content-length':String(256*1024+1)}}:
    {chunks:[Buffer.alloc(128*1024),Buffer.alloc(128*1024+1)]})});
  const {notifier}=fixture(t,{fetch:undefined});notifier.enqueue({key:'oversized',text:'trade'});await notifier.flush();
  assert.equal(requests[0].destroyed,true);assert.equal(notifier.status().pending,1);
  assert.equal(notifier.status().lastError,'TELEGRAM_NETWORK_ERROR');
});

test('IPv4 transport preserves 429 response and retry-after for durable cooldown handling',async t=>{
  const requests=httpsFixture(t,{status:429,headers:{'retry-after':'30'},body:JSON.stringify({ok:false,error_code:429})});
  const {notifier,advance}=fixture(t,{fetch:undefined});notifier.enqueue({key:'limited',text:'trade'});await notifier.flush();
  assert.equal(notifier.status().lastError,'TELEGRAM_RATE_LIMITED');advance(29999);await notifier.flush();assert.equal(requests.length,1);
});

test('IPv4 transport rejects incomplete responses and external destinations',async t=>{
  const requests=httpsFixture(t,{status:200,abort:true});
  await assert.rejects(telegramIpv4Fetch('https://example.com/bot123:secret/sendMessage',{method:'POST',body:'{}'}),/TELEGRAM_TRANSPORT_REQUEST_INVALID/);
  assert.equal(requests.length,0);
  const {notifier}=fixture(t,{fetch:undefined});notifier.enqueue({key:'aborted',text:'trade'});await notifier.flush();
  assert.equal(notifier.status().sent,0);assert.equal(notifier.status().pending,1);assert.equal(requests[0].destroyed,true);
});
