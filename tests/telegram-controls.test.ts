import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TelegramControls,type TelegramControlsOptions,type TelegramCountAction,type TelegramCallbackButtons,
  type TelegramNotificationButtons} from '../src/telegram-controls.js';
import {telegramIpv4Fetch} from '../src/telegram-transport.js';

const token='12345:TEST_CONTROL_SECRET',chatId='321654987',startTime=1792900800000;
const buyMint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',buyRef='b'.repeat(32);
type RecordValue=Record<string,any>;
const result=(data:unknown,status=200)=>new Response(JSON.stringify({ok:true,result:data}),{status});
function message(id:number,text='/count_start',date=startTime/1000):RecordValue {
  return {update_id:id,message:{message_id:id+1,date,text,chat:{id:Number(chatId),type:'private'},from:{id:Number(chatId),is_bot:false}}};
}
function callback(id:number,data='count:status'):RecordValue {
  const value=message(id).message;
  value.from={id:12345,is_bot:true};
  return {update_id:id,callback_query:{id:`callback-${id}`,from:{id:Number(chatId),is_bot:false},data,message:value}};
}
function fixture(t:{after:(fn:()=>Promise<void>)=>void},changes:Partial<TelegramControlsOptions>={}) {
  const directory=mkdtempSync(join(tmpdir(),'meme-tg-controls-')),database=join(directory,'telegram.sqlite');
  let clock=startTime;
  const actions:TelegramCountAction[]=[],notifications:{key:string;text:string;buttons?:TelegramNotificationButtons}[]=[],requests:{url:string;init:RequestInit}[]=[];
  const replies:(Response|((url:string,init:RequestInit)=>Promise<Response>))[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);requests.push({url,init:init!});const next=replies.shift();
    if(typeof next==='function')return next(url,init!);
    return next??result(url.endsWith('answerCallbackQuery')?true:[]);
  };
  const all:TelegramControls[]=[];
  const make=(more:Partial<TelegramControlsOptions>={})=>{
    const controls=new TelegramControls({token,chatId,database,now:()=>clock,fetcher,
      onAction:action=>{actions.push(action);return `【计数控制】\n${action} · 仅模拟，不会买卖`;},
      enqueue:item=>{notifications.push(item);return true;},...changes,...more});all.push(controls);return controls;
  };
  const controls=make();
  t.after(async()=>{await Promise.all(all.map(value=>value.close()));rmSync(directory,{recursive:true,force:true});});
  return {controls,make,actions,notifications,requests,replies,database,
    advance:(ms=1000)=>{clock+=ms;},poll:async(updates:unknown[]=[])=>{clock+=1000;replies.push(result(updates));await controls.pollOnce();}};
}

test('first boot discards history, persists its watermark, and never executes the historical start',async t=>{
  const f=fixture(t);await f.poll([message(100)]);
  assert.deepEqual(f.actions,[]);assert.equal(f.controls.status().initialized,true);assert.equal(f.controls.status().offset,101);
  const initial=JSON.parse(String(f.requests[0].init.body));assert.equal(initial.offset,-1);assert.equal(initial.limit,1);assert.equal(initial.timeout,0);
  assert.deepEqual(initial.allowed_updates,['message','callback_query']);assert.equal(f.requests[0].init.redirect,'error');
  await f.poll([message(100),message(101)]);
  assert.deepEqual(f.actions,['start']);assert.equal(f.notifications.length,1);assert.equal(f.controls.status().offset,102);
  assert.equal(JSON.parse(String(f.requests[1].init.body)).offset,101);
  assert.equal(JSON.parse(String(f.requests[1].init.body)).timeout,20);
});

test('only exact explicit commands and reply keyboard text are actions; /start only reports status',async t=>{
  const f=fixture(t);await f.poll();
  await f.poll(['/count_start','停止计数','计数状态','启动计数','/count_stop','/count_status','/start',
    '▶️ 启动计数','⏹ 停止计数','📊 计数状态'].map((text,id)=>message(id,text)));
  assert.deepEqual(f.actions,['start','stop','status','start','stop','status','status','start','stop','status']);
  assert.match(f.notifications[6].text,/\/start 仅查询状态，不启动计数/);
  assert.match(f.notifications[6].text,/持仓查询 \/positions/);
  await f.poll(['start','stop','/buy','/sell','/count_start now','please /count_start','/start unsafe','/count_stop@otherbot',
    '__proto__','constructor'].map((text,i)=>message(20+i,text)));
  assert.equal(f.actions.length,10);
});

test('removed native test-buy commands are inert and an old confirmation is explicitly acknowledged as removed',async t=>{
  const buys:string[]=[],f=fixture(t,{onTokenBuy:action=>{buys.push(action);return '不应调用';}});await f.poll();
  await f.poll([message(1,'🧪 0.01 SOL 测试买入'),message(2,'/native_buy'),
    message(3,`/native_buy ${buyMint}`),callback(4,`nativebuy:confirm:${buyRef}`)]);
  assert.deepEqual(f.actions,[]);assert.deepEqual(buys,[]);assert.deepEqual(f.notifications,[]);
  const acknowledgement=f.requests.find(request=>request.url.endsWith('/answerCallbackQuery'));assert.ok(acknowledgement);
  assert.match(JSON.parse(String(acknowledgement.init.body)).text,/已移除/);
  assert.equal(f.controls.status().manualBuyEnabled,true);
});

test('configured token cards make bare and explicit lookup addresses read-only while native-buy commands stay removed',async t=>{
  const cards:Array<{address:string;refresh:boolean}>=[],f=fixture(t,{
    onTokenCard:(address,refresh)=>{cards.push({address,refresh});return `【代币详情】\nCA：${address}`;},
  });
  await f.poll();
  await f.poll([message(1,buyMint,startTime/1000-86400),message(2,`/token ${buyMint}`,startTime/1000-86400),
    message(3,`/contract ${buyMint}`,startTime/1000-86400),message(4,`/native_buy ${buyMint}`)]);
  await f.controls.waitForTokenCards();
  assert.deepEqual(cards,Array.from({length:3},()=>({address:buyMint,refresh:false})));
  assert.equal(f.notifications.length,3);assert.deepEqual(f.actions,[]);
  assert.equal(f.notifications.filter(item=>item.text.startsWith('【代币详情】')).length,3);
});

test('token-card replies preserve a four-link official row together with callback controls',async t=>{
  const buttons:TelegramNotificationButtons=[[
    {text:'GMGN',url:`https://gmgn.ai/sol/token/${buyMint}`},
    {text:'Dex',url:`https://dexscreener.com/solana/${buyMint}`},
    {text:'Solscan',url:`https://solscan.io/token/${buyMint}`},
    {text:'Pump',url:`https://pump.fun/coin/${buyMint}`},
  ],[{text:'刷新',callback_data:`token:refresh:${buyMint}`}]];
  const f=fixture(t,{onTokenCard:()=>({text:`【合约详情】Solana\nCA：${buyMint}`,buttons})});
  await f.poll();await f.poll([message(1,buyMint)]);await f.controls.waitForTokenCards();
  assert.deepEqual(f.notifications[0].buttons,buttons);
});

test('token refresh callback accepts an old own-bot card, acknowledges before lookup and rejects forged or malformed callbacks',async t=>{
  const cards:Array<{address:string;refresh:boolean}>=[],f=fixture(t,{onTokenCard:(address,refresh)=>{
    assert.ok(f.requests.at(-1)?.url.endsWith('/answerCallbackQuery'));
    cards.push({address,refresh});return `【代币详情】\nCA：${address}`;
  }});
  await f.poll();
  const refresh=callback(1,`token:refresh:${buyMint}`);refresh.callback_query.message.date=startTime/1000-86400;
  const wrongUser=callback(2,`token:refresh:${buyMint}`);wrongUser.callback_query.from.id=1;
  const forwarded=callback(3,`token:refresh:${buyMint}`);forwarded.callback_query.message.forward_origin={type:'user'};
  await f.poll([refresh,wrongUser,forwarded,callback(4,'token:refresh:11111111111111111111111111111111'),
    callback(5,`token:refresh:${buyMint}:extra`),callback(6,`tok:r:${buyMint}`)]);
  await f.controls.waitForTokenCards();
  assert.deepEqual(cards,[{address:buyMint,refresh:true}]);assert.equal(f.notifications.length,1);assert.deepEqual(f.actions,[]);
  const acknowledgements=f.requests.filter(request=>request.url.endsWith('/answerCallbackQuery'));
  assert.equal(acknowledgements.length,1);
  assert.match(JSON.parse(String(acknowledgements[0].init.body)).text,/代币详情查询/);
});

test('exact owner token-card legacy buy callback maps to 0.01 while forged and malformed callbacks are ignored',async t=>{
  const buys:Array<{action:string;address?:string;value?:string}>=[],f=fixture(t,{onTokenBuy:(action,address,value)=>{
    buys.push({action,address,value});return `【卡片买入】\n已接收\nCA：${address}`;
  }});
  await f.poll();
  const buy=callback(1,`token:buy:${buyMint}`);buy.callback_query.message.date=startTime/1000-86400;
  const wrongUser=callback(2,`token:buy:${buyMint}`);wrongUser.callback_query.from.id=1;
  await f.poll([buy,wrongUser,callback(3,`token:buy:${buyMint}:extra`),callback(4,'token:buy:11111111111111111111111111111111')]);
  assert.deepEqual(buys,[{action:'preset',address:buyMint,value:'legacy'}]);
  assert.equal(f.notifications.length,1);assert.match(f.notifications[0].text,/卡片买入/);
  assert.match(f.notifications[0].text,new RegExp(buyMint));
  const ack=f.requests.find(request=>request.url.endsWith('/answerCallbackQuery'));assert.ok(ack);
  assert.match(JSON.parse(String(ack.init.body)).text,/买入请求已收到/);
});

test('token-card preset and custom callbacks decode only allowlisted codes and canonical mints',async t=>{
  const calls:Array<{action:string;address?:string;value?:string}>=[],f=fixture(t,{onTokenBuy:(action,address,value)=>{
    calls.push({action,address,value});return action==='custom_start'?'【卡片买入】\n请输入 SOL 金额。':'【卡片买入】\n已接收';
  }});
  await f.poll();
  const valid=['a','b','c','d','e'].map((code,index)=>callback(index+1,`token:buy:${code}:${buyMint}`));
  valid.push(callback(6,`token:custom:${buyMint}`));
  const forged=callback(20,`token:buy:a:${buyMint}`);forged.callback_query.from.id=1;
  await f.poll([...valid,forged,
    callback(21,`token:buy:f:${buyMint}`),callback(22,`token:buy:A:${buyMint}`),
    callback(23,`token:buy:0.1:${buyMint}`),callback(24,`token:buy:a:${buyMint}:extra`),
    callback(25,`token:buy:a:11111111111111111111111111111111`),callback(26,`token:custom:${buyMint}:extra`),
    callback(27,'token:custom:11111111111111111111111111111111')]);
  assert.deepEqual(calls,[
    {action:'preset',address:buyMint,value:'a'},{action:'preset',address:buyMint,value:'b'},
    {action:'preset',address:buyMint,value:'c'},{action:'preset',address:buyMint,value:'d'},
    {action:'preset',address:buyMint,value:'e'},{action:'custom_start',address:buyMint,value:undefined},
  ]);
  assert.equal(f.notifications.length,6);
  const acknowledgements=f.requests.filter(request=>request.url.endsWith('/answerCallbackQuery'));
  assert.equal(acknowledgements.length,6);
  assert.match(JSON.parse(String(acknowledgements.at(-1)!.init.body)).text,/自定义 SOL/);
});

test('card custom-buy cancel uses its own route while old delivered cancel buttons remain safe',async t=>{
  const calls:Array<{action:string;address?:string;value?:string}>=[],f=fixture(t,{onTokenBuy:(action,address,value)=>{
    calls.push({action,address,value});return '【自定义买入】\n已取消，没有发送交易。';
  }});
  await f.poll();await f.poll([callback(1,`token:cancel:${buyRef}`),callback(2,`nativebuy:cancel:${buyRef}`)]);
  assert.deepEqual(calls,[{action:'cancel',address:undefined,value:buyRef},{action:'cancel',address:undefined,value:buyRef}]);
  assert.equal(f.requests.filter(request=>request.url.endsWith('/answerCallbackQuery')).length,2);
  assert.equal(f.notifications.length,2);
});

test('fresh exact decimal SOL messages route custom values without normalizing user input',async t=>{
  const calls:Array<{action:string;address?:string;value?:string}>=[],f=fixture(t,{onTokenBuy:(action,address,value)=>{
    calls.push({action,address,value});return '【卡片买入】\n已处理或明确拒绝';
  }});
  await f.poll();
  const valid=['0.000000001','0.1','1','1.0','3.141592653','99999999999999999999999999999999'];
  const invalid=['0','0.0','0.000000000','+1','-1','1e-3','1E3','.1','1.','01','00.1','1,5','1_000',
    ' 1','1 ','1\n','3.1415926535','NaN','Infinity'];
  await f.poll([...valid.map((value,index)=>message(index+1,value)),
    ...invalid.map((value,index)=>message(100+index,value))]);
  assert.deepEqual(calls,valid.map(value=>({action:'custom_value',address:undefined,value})));
  assert.equal(f.notifications.length,valid.length);assert.deepEqual(f.actions,[]);
  await f.poll([message(200,'0.5',Math.floor((startTime-121000)/1000))]);
  assert.equal(calls.length,valid.length);
});

test('token-card sell callbacks route fixed percentages directly and custom percentage exactly once',async t=>{
  const nativeRef=`np${'c'.repeat(30)}`;
  const sells:Array<{ref:string;pct:number}>=[];
  const buys:Array<{action:string;address?:string;value?:string}>=[];
  const f=fixture(t,{
    onSell:(ref,pct)=>{sells.push({ref,pct});return '【卡片卖出】\n已接收';},
    onTokenBuy:(action,address,value)=>{buys.push({action,address,value});return '【卡片买入】\n已接收';},
  });
  await f.poll();
  const valid=['30','50','100'].map((pct,index)=>callback(index+1,`sell:${pct}:${nativeRef}`));
  valid.push(callback(4,`sell:custom:${nativeRef}`));
  const forged=callback(5,`sell:30:${nativeRef}`);forged.callback_query.from.id=1;
  await f.poll([...valid,forged,
    callback(6,`sell:31:${nativeRef}`),callback(7,`sell:30:${nativeRef}:extra`),
    callback(8,`sell:100:np${'d'.repeat(29)}`),callback(9,`sell:Custom:${nativeRef}`)]);
  await f.controls.waitForTradeActions();
  assert.deepEqual(sells,[
    {ref:nativeRef,pct:30},{ref:nativeRef,pct:50},{ref:nativeRef,pct:100},
  ]);
  assert.equal(f.notifications.length,4);
  assert.equal(f.requests.filter(request=>request.url.endsWith('/answerCallbackQuery')).length,4);
  assert.match(JSON.parse(String(f.requests.filter(request=>request.url.endsWith('/answerCallbackQuery')).at(-1)!.init.body)).text,
    /1%-100%/);

  const invalid=['0%','00%','01%','101%','30.0%','+30%','-30%',' 30%','30% ','30％','30 %','1e2%'];
  const wrongOwner=message(40,'36%');wrongOwner.message.from.id=1;
  await f.poll([...invalid.map((value,index)=>message(20+index,value)),wrongOwner]);
  assert.equal(sells.length,3);
  await f.poll([message(50,'37%'),message(51,'38%'),message(52,'30')]);
  await f.controls.waitForTradeActions();
  assert.deepEqual(sells.at(-1),{ref:nativeRef,pct:37});
  assert.equal(sells.length,4);
  assert.deepEqual(buys,[{action:'custom_value',address:undefined,value:'30'}]);
  const db=new DatabaseSync(f.database,{readOnly:true});
  assert.equal(db.prepare('SELECT count(*) n FROM telegram_control_pending_token_sell').get()?.n,0);db.close();
});

test('custom token-card sell prompt survives restart, expires after five minutes, and is owner scoped',async t=>{
  const nativeRef=`np${'d'.repeat(30)}`;
  const f=fixture(t);await f.poll();await f.controls.close();
  const started:string[]=[],first=f.make({onSell:(ref,pct)=>{
    started.push(`${ref}:${pct}`);return '【卡片卖出】\n已处理';
  }});
  f.advance();f.replies.push(result([callback(10,`sell:custom:${nativeRef}`)]));await first.pollOnce();await first.close();
  assert.deepEqual(started,[]);

  const restored:string[]=[],second=f.make({onSell:(ref,pct)=>{
    restored.push(`${ref}:${pct}`);return '【卡片卖出】\n已处理';
  }});
  f.advance();f.replies.push(result([message(11,'42%')]));await second.pollOnce();
  assert.deepEqual(restored,[`${nativeRef}:42`]);await second.close();

  const expired:string[]=[],third=f.make({onSell:(ref,pct)=>{
    expired.push(`${ref}:${pct}`);return '【卡片卖出】\n已处理';
  }});
  f.advance();f.replies.push(result([callback(12,`sell:custom:${nativeRef}`)]));await third.pollOnce();
  f.advance(5*60*1000+1);f.replies.push(result([message(13,'43%',Math.floor((startTime+5*60*1000+3000)/1000))]));
  await third.pollOnce();
  assert.deepEqual(expired,[]);
  const db=new DatabaseSync(f.database,{readOnly:true});
  assert.equal(db.prepare('SELECT count(*) n FROM telegram_control_pending_token_sell').get()?.n,0);db.close();
});

test('preset, custom-start and custom-value are durably claimed before handlers and never replayed',async t=>{
  const f=fixture(t);await f.poll();await f.controls.close();
  const seen:string[]=[];
  const first=f.make({onTokenBuy:(action,address,value)=>{
    const db=new DatabaseSync(f.database,{readOnly:true});
    const rows=db.prepare("SELECT state,action FROM telegram_control_events WHERE action='token_buy' ORDER BY update_id").all();db.close();
    assert.equal(rows.at(-1)?.state,'claimed');
    seen.push([action,address,value].filter(part=>part!==undefined).join(':'));return '【卡片买入】\n已处理';
  }});
  f.advance();f.replies.push(result([
    callback(10,`token:buy:a:${buyMint}`),callback(10,`token:buy:a:${buyMint}`),
    callback(11,`token:custom:${buyMint}`),message(12,'0.25'),message(12,'0.25'),
  ]));
  await first.pollOnce();assert.deepEqual(seen,[`preset:${buyMint}:a`,`custom_start:${buyMint}`,'custom_value:0.25']);
  await first.close();
  const second=f.make({onTokenBuy:()=>{seen.push('replayed');return 'must not run';}});
  f.advance();f.replies.push(result([callback(10,`token:buy:a:${buyMint}`),callback(11,`token:custom:${buyMint}`),message(12,'0.25')]));
  await second.pollOnce();assert.equal(seen.includes('replayed'),false);
});

test('missing token-card handler returns a read-only unavailable response',async t=>{
  const f=fixture(t);
  await f.poll();await f.poll([message(1,`/token ${buyMint}`),message(2,`/contract ${buyMint}`)]);
  await f.controls.waitForTokenCards();
  assert.equal(f.notifications.length,2);
  assert.ok(f.notifications.every(item=>/代币详情查询暂不可用/.test(item.text)));
});

test('slow token-card lookup is low priority and never blocks sell or stop consumption',async t=>{
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const order:string[]=[],f=fixture(t,{
    onTokenCard:async()=>{order.push('card');entered();await gate;return '【代币详情】\n查询完成';},
    onSell:()=>{order.push('sell');return '【平仓操作】\n已接受';},
    onAction:action=>{order.push(action);return `【计数控制】\n${action}`;},
  });
  await f.poll();
  await f.poll([message(1,buyMint),callback(2,`sell:100:${closeRef}`),message(3,'停止计数')]);
  assert.deepEqual(order,['sell','stop']);
  assert.equal(f.notifications.length,2);assert.equal(f.controls.status().pendingTokenCards,1);
  await started;assert.deepEqual(order,['sell','stop','card']);
  release();await f.controls.waitForTokenCards();
  assert.equal(f.controls.status().pendingTokenCards,0);
  assert.equal(f.notifications.length,3);assert.match(f.notifications[2].text,/查询完成/);
});

test('slow token-card callback acknowledgement does not hold a later stop command',async t=>{
  let releaseAck!:(response:Response)=>void;
  const ack=new Promise<Response>(resolve=>{releaseAck=resolve;});
  const f=fixture(t,{onTokenCard:()=>`【代币详情】\nCA：${buyMint}`});await f.poll();
  const refresh=callback(1,`token:refresh:${buyMint}`);
  f.advance();f.replies.push(result([refresh,message(2,'停止计数')]),async()=>ack);
  await f.controls.pollOnce();
  assert.deepEqual(f.actions,['stop']);assert.equal(f.controls.status().pendingTokenCards,1);
  releaseAck(result(true));await f.controls.waitForTokenCards();
  assert.equal(f.notifications.length,2);assert.equal(f.controls.status().pendingTokenCards,0);
});

test('slow native sell receipt never stops later stop, status, or Telegram polling',async t=>{
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const nativeRef=`np${'e'.repeat(30)}`;
  const f=fixture(t,{onSell:async()=>{entered();await gate;return '【持仓卖出】\n已受理';}});
  await f.poll();
  await f.poll([callback(1,`sell:100:${nativeRef}`),message(2,'停止计数')]);
  await started;
  assert.deepEqual(f.actions,['stop']);
  assert.equal(f.controls.status().pendingTradeActions,1);
  assert.equal(f.notifications.length,1);
  await f.poll([message(3,'计数状态')]);
  assert.deepEqual(f.actions,['stop','status']);
  assert.equal(f.notifications.length,2);
  release();await f.controls.waitForTradeActions();
  assert.equal(f.controls.status().pendingTradeActions,0);
  assert.equal(f.notifications.length,3);assert.match(f.notifications[2].text,/已受理/);
});

test('token-card low-priority queue is bounded and excess lookups fail closed without delaying controls',async t=>{
  let release!:()=>void,entered!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const f=fixture(t,{onTokenCard:async()=>{
    calls++;if(calls===1){entered();await gate;}return `【代币详情】\n第 ${calls} 个查询完成`;
  }});
  await f.poll();await f.poll(Array.from({length:17},(_,index)=>message(index+1,buyMint)));
  assert.equal(f.notifications.length,1);assert.match(f.notifications[0].text,/查询队列已满/);
  await started;assert.equal(f.controls.status().pendingTokenCards,16);
  release();await f.controls.waitForTokenCards();
  assert.equal(calls,16);assert.equal(f.notifications.length,17);assert.equal(f.controls.status().pendingTokenCards,0);
});

test('removed native test buy rejects forged and malformed callbacks while acknowledging an exact old confirmation',async t=>{
  const f=fixture(t);
  await f.poll();
  const stale=message(1,buyMint,startTime/1000-121),wrong=callback(2,`nativebuy:confirm:${buyRef}`);
  wrong.callback_query.from.id=1;
  await f.poll([stale,message(3,buyMint+'x'),message(4,'11111111111111111111111111111111'),wrong,
    callback(5,`nativebuy:confirm:${'B'.repeat(32)}`),callback(6,`nativebuy:confirm:${'a'.repeat(31)}`)]);
  assert.equal(f.notifications.length,0);
  const acknowledgements=f.requests.filter(request=>request.url.endsWith('/answerCallbackQuery'));
  assert.equal(acknowledgements.length,0);
});

test('strictly rejects other users/chats, groups, bots, edited, forwarded and stale/future messages',async t=>{
  const f=fixture(t);await f.poll();
  const cases=[
    (u:RecordValue)=>{u.message.chat.id=7;},(u:RecordValue)=>{u.message.from.id=7;},
    (u:RecordValue)=>{u.message.chat.type='group';},(u:RecordValue)=>{u.message.from.is_bot=true;},
    (u:RecordValue)=>{delete u.message.from.is_bot;},(u:RecordValue)=>{u.message.forward_origin={type:'user'};},
    (u:RecordValue)=>{u.message.forward_from={id:Number(chatId)};},(u:RecordValue)=>{u.message.forward_date=startTime/1000;},
    (u:RecordValue)=>{u.message.via_bot={id:12345};},(u:RecordValue)=>{u.message.sender_chat={id:Number(chatId)};},
    (u:RecordValue)=>{u.message.edit_date=startTime/1000;},(u:RecordValue)=>{u.edited_message=u.message;delete u.message;},
    (u:RecordValue)=>{u.message.date=startTime/1000-121;},(u:RecordValue)=>{u.message.date=startTime/1000+60;},
    (u:RecordValue)=>{u.message.date=0;},(u:RecordValue)=>{u.message.business_connection_id='business';},
  ];
  const updates=cases.map((mutate,id)=>{const update=message(id);mutate(update);return update;});
  await f.poll(updates);assert.deepEqual(f.actions,[]);assert.deepEqual(f.notifications,[]);
  assert.equal(f.controls.status().offset,cases.length);
  await f.poll([message(cases.length,'/count_status')]);assert.deepEqual(f.actions,['status']);
});

test('fresh messages at the 120-second limit are accepted and future seconds are rejected',async t=>{
  const f=fixture(t);await f.poll();f.advance(1000);
  f.replies.push(result([message(1,'/count_status',(startTime+2000)/1000-120),message(2,'/count_start',(startTime+2000)/1000+1)]));
  await f.controls.pollOnce();assert.deepEqual(f.actions,['status']);
});

test('duplicate updates do not execute twice in one batch or across a restart',async t=>{
  const f=fixture(t);await f.poll();await f.poll([message(8),message(8)]);assert.deepEqual(f.actions,['start']);
  await f.controls.close();const restarted=f.make();f.advance();f.replies.push(result([message(8),message(9,'/count_stop')]));
  await restarted.pollOnce();assert.deepEqual(f.actions,['start','stop']);assert.equal(f.notifications.length,2);
  assert.equal(JSON.parse(String(f.requests.at(-1)!.init.body)).offset,9);
});

test('the action is durably claimed and offset saved before onAction runs',async t=>{
  const f=fixture(t);await f.poll();await f.controls.close();
  let observed=false;const controls=f.make({onAction:action=>{
    const db=new DatabaseSync(f.database,{readOnly:true});
    assert.equal(db.prepare('SELECT offset FROM telegram_control_state').get()?.offset,11);
    assert.equal(db.prepare('SELECT state FROM telegram_control_events').get()?.state,'claimed');db.close();observed=true;return action;
  }});
  f.advance();f.replies.push(result([message(10)]));await controls.pollOnce();assert.equal(observed,true);
});

test('an interrupted claimed action is never replayed and produces an explicit status-check reply',async t=>{
  const f=fixture(t);await f.poll();await f.controls.close();
  const db=new DatabaseSync(f.database);const scope=String(db.prepare('SELECT scope FROM telegram_control_state').get()?.scope);
  db.prepare("INSERT INTO telegram_control_events(scope,update_id,action,state,created_at,reply,queued) VALUES(?,10,'start','claimed',?,NULL,0)").run(scope,startTime);
  db.prepare('UPDATE telegram_control_state SET offset=11').run();db.close();
  const restored=f.make();f.advance();f.replies.push(result([message(10)]));await restored.pollOnce();
  assert.deepEqual(f.actions,[]);assert.equal(f.notifications.length,1);assert.match(f.notifications[0].text,/不会自动重放/);
  assert.equal(restored.status().interrupted,1);
});

test('reply enqueue failure is retried durably without running the action again',async t=>{
  let attempts=0;const f=fixture(t,{enqueue:()=>{attempts++;throw new Error('private error '+token);}});
  await f.poll();await f.poll([message(1)]);assert.deepEqual(f.actions,['start']);assert.equal(f.controls.status().pendingReplies,1);
  await f.controls.close();const restored=f.make({enqueue:item=>{f.notifications.push(item);return true;}});
  f.advance();await restored.pollOnce();assert.deepEqual(f.actions,['start']);assert.equal(f.notifications.length,1);assert.equal(restored.status().pendingReplies,0);
  assert.ok(attempts>=1);assert.equal(JSON.stringify(restored.status()).includes(token),false);
});

test('action failure is sanitized, replied to once, and never retried automatically',async t=>{
  let attempts=0;const f=fixture(t,{onAction:()=>{attempts++;throw new Error('secret '+token);}});
  await f.poll();await f.poll([message(4)]);await f.poll([message(4)]);
  assert.equal(attempts,1);assert.equal(f.notifications.length,1);assert.match(f.notifications[0].text,/不会自动重放/);
  assert.equal(JSON.stringify(f.notifications).includes(token),false);assert.equal(JSON.stringify(f.controls.status()).includes(token),false);
});

test('callback commands require the authorized actor, private chat, fresh own-bot message, and exact data',async t=>{
  const f=fixture(t);await f.poll();
  const wrongUser=callback(1);wrongUser.callback_query.from.id=42;
  const wrongBot=callback(2);wrongBot.callback_query.message.from.id=999;
  const stale=callback(3,'count:start');stale.callback_query.message.date=startTime/1000-200;
  const inline=callback(4);delete inline.callback_query.message;inline.callback_query.inline_message_id='other';
  const forwarded=callback(5);forwarded.callback_query.message.forward_origin={type:'user'};
  f.advance();f.replies.push(result([wrongUser,wrongBot,stale,inline,forwarded,callback(6,'count:buy'),callback(7,'count:stop')]),result(true));
  await f.controls.pollOnce();assert.deepEqual(f.actions,['stop']);assert.equal(f.notifications.length,1);
  const acknowledgements=f.requests.filter(request=>request.url.endsWith('/answerCallbackQuery'));
  assert.deepEqual(acknowledgements.map(item=>JSON.parse(String(item.init.body)).callback_query_id),['callback-3','callback-7']);
  assert.match(JSON.parse(String(acknowledgements[0].init.body)).text,/过期/);
});

test('holdings commands use a separate read-only handler and bounded one-based pages',async t=>{
  const pages:number[]=[],f=fixture(t,{onPositions:page=>{pages.push(page);return `【持仓查询】\n第 ${page} / 10000 页 · 共 10000 个持仓`;}});
  await f.poll();await f.poll(['持仓查询','/positions','/positions 2','/positions 10000'].map((text,id)=>message(id,text)));
  assert.deepEqual(pages,[1,1,2,10000]);assert.deepEqual(f.actions,[]);assert.equal(f.notifications.length,4);
  await f.poll(['/positions 0','/positions -1','/positions +1','/positions 1.5','/positions 01',
    '/positions 10001','/positions 999999999999999999999','/positions NaN','/positions 2 extra',
    '/positions@otherbot','/positions  2','持仓查询 2'].map((text,id)=>message(id+10,text)));
  assert.deepEqual(pages,[1,1,2,10000]);assert.deepEqual(f.actions,[]);
});

test('holdings typed commands retain private sender authorization and reject future or forwarded messages',async t=>{
  const pages:number[]=[],f=fixture(t,{onPositions:page=>{pages.push(page);return '【持仓查询】\n暂无持仓';}});
  await f.poll();
  const cases=[
    (u:RecordValue)=>{u.message.chat.id=7;},(u:RecordValue)=>{u.message.from.id=7;},
    (u:RecordValue)=>{u.message.chat.type='group';},(u:RecordValue)=>{u.message.from.is_bot=true;},
    (u:RecordValue)=>{u.message.forward_origin={type:'user'};},(u:RecordValue)=>{u.message.edit_date=startTime/1000;},
    (u:RecordValue)=>{u.message.date=0;},(u:RecordValue)=>{u.message.date=startTime/1000+60;},
  ];
  await f.poll(cases.map((mutate,id)=>{const update=message(id,'/positions');mutate(update);return update;}));
  assert.deepEqual(pages,[]);assert.deepEqual(f.actions,[]);
  await f.poll([message(20,'/positions')]);assert.deepEqual(pages,[1]);
});

test('old read-only status and holdings commands plus familiar keyboard labels remain responsive',async t=>{
 const pages:number[]=[],f=fixture(t,{onPositions:page=>{pages.push(page);return '【持仓查询】\n暂无持仓';}});
 await f.poll();
 const statusTexts=['状态','📊 状态','计数状态','📊 计数状态','/count_status','/start'];
 const positionTexts=['持仓','💼 持仓','💼 持仓查询','📊 持仓','📊 持仓查询','持仓查询','/positions','/positions 2'];
 await f.poll([...statusTexts,...positionTexts].map((text,id)=>message(id,text,startTime/1000-86400)));
 assert.deepEqual(f.actions,statusTexts.map(()=>'status'));
 assert.deepEqual(pages,[1,1,1,1,1,1,1,2]);
 const old=callback(100,'count:status');old.callback_query.message.date=startTime/1000-86400;
 await f.poll([old]);assert.equal(f.actions.at(-1),'status');assert.equal(f.actions.length,statusTexts.length+1);
});

test('holdings pagination permits old own-bot messages but rejects other senders, chats, forwards and malformed pages',async t=>{
  const pages:number[]=[],f=fixture(t,{onPositions:page=>{pages.push(page);return `【持仓查询】\n第 ${page} / 3 页 · 共 12 个持仓`;}});
  await f.poll();
  const cases=[
    (u:RecordValue)=>{u.callback_query.from.id=7;},(u:RecordValue)=>{u.callback_query.from.is_bot=true;},
    (u:RecordValue)=>{u.callback_query.message.chat.id=7;},(u:RecordValue)=>{u.callback_query.message.chat.type='group';},
    (u:RecordValue)=>{u.callback_query.message.from.id=99;},(u:RecordValue)=>{u.callback_query.message.from.is_bot=false;},
    (u:RecordValue)=>{u.callback_query.message.forward_origin={type:'user'};},
    (u:RecordValue)=>{u.callback_query.message.date=0;},(u:RecordValue)=>{u.callback_query.message.date=startTime/1000+60;},
    (u:RecordValue)=>{u.callback_query.inline_message_id='inline';},
  ];
  const updates=cases.map((mutate,id)=>{const update=callback(id,'positions:2');mutate(update);return update;});
  for(const data of ['positions:0','positions:-1','positions:01','positions:10001','positions:2:buy','positions:2 extra','positions:1e2'])
    updates.push(callback(updates.length,data));
  const old=callback(100,'positions:2');old.callback_query.message.date=startTime/1000-86400;
  const oldCount=callback(101,'count:start');oldCount.callback_query.message.date=startTime/1000-86400;
  await f.poll([...updates,old,oldCount]);
  assert.deepEqual(pages,[2]);assert.deepEqual(f.actions,[]);assert.equal(f.notifications.length,1);
  const acknowledgements=f.requests.filter(request=>request.url.endsWith('/answerCallbackQuery'));
  assert.equal(acknowledgements.length,2);
  assert.match(JSON.parse(String(acknowledgements[0].init.body)).text,/持仓查询/);
  assert.match(JSON.parse(String(acknowledgements[1].init.body)).text,/过期/);
});

test('holdings query is durably claimed before reading and replay does not enqueue duplicates',async t=>{
  const f=fixture(t);await f.poll();await f.controls.close();let reads=0;
  const restarted=f.make({onPositions:page=>{
    const db=new DatabaseSync(f.database,{readOnly:true});
    const event=db.prepare('SELECT state,action FROM telegram_control_events').get();db.close();
    assert.equal(event?.state,'claimed');assert.equal(event?.action,'positions');
    reads++;return `【持仓查询】\n第 ${page} / 3 页 · 共 12 个持仓`;
  }});
  f.advance();f.replies.push(result([message(10,'/positions 2'),message(10,'/positions 2')]));
  await restarted.pollOnce();assert.equal(reads,1);assert.equal(f.notifications.length,1);
  await restarted.close();const again=f.make({onPositions:()=>{reads++;return 'should not run';}});
  f.advance();f.replies.push(result([message(10,'/positions 2')]));await again.pollOnce();assert.equal(reads,1);
});

test('missing or failed holdings handler returns a sanitized unavailable reply without count actions',async t=>{
  const f=fixture(t);await f.poll();await f.poll([message(1,'/positions')]);
  assert.match(f.notifications[0].text,/持仓查询暂不可用/);assert.deepEqual(f.actions,[]);
  await f.controls.close();const failing=f.make({onPositions:()=>{throw new Error(token);}});
  f.advance();f.replies.push(result([message(2,'/positions')]));await failing.pollOnce();
  assert.match(f.notifications[1].text,/暂时无法读取持仓/);assert.equal(JSON.stringify(f.notifications).includes(token),false);
  assert.deepEqual(f.actions,[]);
});

const closeRef='0123456789abcdef0123456789abcdef',closeId='66d3b567-b6b9-4444-b7f9-33044ae4ccef';
const closeButtons:TelegramCallbackButtons=[[{text:'确认平仓',callback_data:`close:confirm:${closeId}`},{text:'取消',callback_data:`close:cancel:${closeId}`}]];

test('four direct sell sizes route old own-bot callbacks after acknowledgement without any confirm handler',async t=>{
 const sales:{ref:string;pct:number}[]=[];
 let legacy=0;
 const f=fixture(t,{onSell:(ref,pct)=>{
   assert.ok(f.requests.at(-1)!.url.endsWith('/answerCallbackQuery'));
   const db=new DatabaseSync(f.database,{readOnly:true});
   assert.equal(db.prepare('SELECT state FROM telegram_control_events ORDER BY update_id DESC LIMIT 1').get()?.state,'claimed');db.close();
   sales.push({ref,pct});return '【平仓操作】\n请求已接受，成交结果随后通知。';
 },onClose:()=>{legacy++;return 'unused';}});
 await f.poll();
 const values=[25,50,75,100].map((pct,index)=>{
   const item=callback(index,`sell:${pct}:${closeRef}`);item.callback_query.message.date=startTime/1000-86400;return item;
 });
 await f.poll(values);await f.controls.waitForTradeActions();
 assert.deepEqual(sales,[25,50,75,100].map(pct=>({ref:closeRef,pct})));
 assert.equal(legacy,0);assert.equal(f.notifications.length,4);assert.deepEqual(f.actions,[]);
 assert.equal(f.controls.status().manualCloseEnabled,true);
});

test('direct sell rejects unauthorized actors and malformed size/reference without relaxing message provenance',async t=>{
 let calls=0;const f=fixture(t,{onSell:()=>{calls++;return 'unused';}});await f.poll();
 const cases=[
   (u:RecordValue)=>{u.callback_query.from.id=1;},(u:RecordValue)=>{u.callback_query.from.is_bot=true;},
   (u:RecordValue)=>{u.callback_query.message.chat.id=1;},(u:RecordValue)=>{u.callback_query.message.chat.type='group';},
   (u:RecordValue)=>{u.callback_query.message.from.id=1;},(u:RecordValue)=>{u.callback_query.message.from.is_bot=false;},
   (u:RecordValue)=>{u.callback_query.message.forward_origin={type:'user'};},
   (u:RecordValue)=>{u.callback_query.message.date=startTime/1000+60;},
   (u:RecordValue)=>{u.callback_query.message.date=0;},(u:RecordValue)=>{u.callback_query.inline_message_id='inline';},
 ];
 const updates=cases.map((mutate,id)=>{const item=callback(id,`sell:100:${closeRef}`);mutate(item);return item;});
 for(const data of [`sell:0:${closeRef}`,`sell:025:${closeRef}`,`sell:25.0:${closeRef}`,`sell:20:${closeRef}`,`sell:101:${closeRef}`,
   `sell:100:${closeRef.toUpperCase()}`,`sell:100:${closeRef.slice(1)}`,`sell:100:${closeRef}:extra`])updates.push(callback(updates.length,data));
 await f.poll(updates);await f.poll([message(100,`sell:100:${closeRef}`)]);
 assert.equal(calls,0);assert.deepEqual(f.notifications,[]);
});

test('direct sell duplicate updates are never re-executed, including after restart',async t=>{
 let calls=0;const f=fixture(t,{onSell:()=>{calls++;return '【平仓操作】\n已接受';}});await f.poll();
 await f.poll([callback(10,`sell:100:${closeRef}`),callback(10,`sell:100:${closeRef}`)]);
 assert.equal(calls,1);await f.controls.close();
 const restored=f.make();f.advance();f.replies.push(result([callback(10,`sell:100:${closeRef}`)]));await restored.pollOnce();
 assert.equal(calls,1);assert.equal(f.notifications.length,1);
});

test('interrupted sell is reported as uncertain and never replayed on restart',async t=>{
 let calls=0;const f=fixture(t,{onSell:()=>{calls++;return 'unused';}});await f.poll();await f.controls.close();
 const db=new DatabaseSync(f.database);const scope=String(db.prepare('SELECT scope FROM telegram_control_state').get()?.scope);
 db.prepare("INSERT INTO telegram_control_events(scope,update_id,action,state,created_at,queued) VALUES(?,10,'sell','claimed',?,0)").run(scope,startTime);
 db.prepare('UPDATE telegram_control_state SET offset=11').run();db.close();
 const restored=f.make();f.advance();f.replies.push(result([callback(10,`sell:100:${closeRef}`)]));await restored.pollOnce();
 assert.equal(calls,0);assert.match(f.notifications[0].text,/平仓操作/);assert.match(f.notifications[0].text,/不会自动重放/);
});

test('explicit close preview may use an old holdings message; confirm and cancel require fresh bot messages',async t=>{
  const actions:{action:string;ref:string}[]=[],f=fixture(t,{onClose:(action,ref)=>{
    actions.push({action,ref});return {text:'【平仓操作】\n请核对持仓后确认。',buttons:closeButtons};
  }});
  await f.poll();
  const preview=callback(1,`close:preview:${closeRef}`);preview.callback_query.message.date=startTime/1000-86400;
  const stale=callback(2,`close:confirm:${closeId}`);stale.callback_query.message.date=startTime/1000-121;
  const staleCancel=callback(3,`close:cancel:${closeId}`);staleCancel.callback_query.message.date=startTime/1000-121;
  await f.poll([preview,stale,staleCancel,callback(4,`close:confirm:${closeId}`),callback(5,`close:cancel:${closeId}`)]);
  assert.deepEqual(actions,[{action:'preview',ref:closeRef},{action:'confirm',ref:closeId},{action:'cancel',ref:closeId}]);
  assert.deepEqual(f.actions,[]);assert.equal(f.notifications.length,3);
  assert.deepEqual(f.notifications[0].buttons,closeButtons);assert.equal(f.notifications[0].text.includes(closeId),false);
});

test('close callbacks reject unauthorized users, other chats or bots, forwards and malformed references',async t=>{
  let calls=0;const f=fixture(t,{onClose:()=>{calls++;return 'unused';}});await f.poll();
  const cases=[
    (u:RecordValue)=>{u.callback_query.from.id=1;},(u:RecordValue)=>{u.callback_query.from.is_bot=true;},
    (u:RecordValue)=>{u.callback_query.message.chat.id=1;},(u:RecordValue)=>{u.callback_query.message.chat.type='group';},
    (u:RecordValue)=>{u.callback_query.message.from.id=1;},(u:RecordValue)=>{u.callback_query.message.from.is_bot=false;},
    (u:RecordValue)=>{u.callback_query.message.forward_origin={type:'user'};},
    (u:RecordValue)=>{u.callback_query.message.date=startTime/1000+60;},
  ];
  const updates=cases.map((change,id)=>{const value=callback(id,`close:confirm:${closeId}`);change(value);return value;});
  for(const data of [`close:preview:${closeId}`,`close:confirm:${closeRef}`,`close:cancel:${closeId.toUpperCase()}`,
    `close:confirm:${closeId}:extra`,`close:preview:${closeRef.slice(1)}`,'close:confirm:constructor','close:sell:all'])
    updates.push(callback(updates.length,data));
  await f.poll(updates);await f.poll([message(100,`close:confirm:${closeId}`),message(101,`/close ${closeRef}`)]);
  assert.equal(calls,0);assert.deepEqual(f.notifications,[]);assert.deepEqual(f.actions,[]);
});

test('close callback is durably claimed before its handler and replay cannot repeat it across restart',async t=>{
  const f=fixture(t);await f.poll();await f.controls.close();let calls=0;
  const first=f.make({onClose:()=>{
    const db=new DatabaseSync(f.database,{readOnly:true});const row=db.prepare('SELECT state,action FROM telegram_control_events').get();db.close();
    assert.equal(row?.state,'claimed');assert.equal(row?.action,'close');calls++;return '【平仓操作】\n已处理';
  }});
  f.advance();f.replies.push(result([callback(10,`close:confirm:${closeId}`),callback(10,`close:confirm:${closeId}`)]));
  await first.pollOnce();assert.equal(calls,1);await first.close();
  const second=f.make({onClose:()=>{calls++;return 'must not run';}});
  f.advance();f.replies.push(result([callback(10,`close:confirm:${closeId}`)]));await second.pollOnce();assert.equal(calls,1);
});

test('structured buttons survive a failed enqueue and restart without re-running the close handler',async t=>{
  let calls=0;const f=fixture(t,{onClose:()=>{calls++;return {text:'【平仓操作】\n确认后卖出。',buttons:closeButtons};},
    enqueue:()=>{throw new Error('queue unavailable');}});
  await f.poll();await f.poll([callback(1,`close:preview:${closeRef}`)]);
  const db=new DatabaseSync(f.database,{readOnly:true});
  const row=db.prepare('SELECT reply,reply_buttons FROM telegram_control_events').get();db.close();
  assert.equal(String(row?.reply).includes(closeId),false);assert.deepEqual(JSON.parse(String(row?.reply_buttons)),closeButtons);
  await f.controls.close();const restored=f.make({enqueue:item=>{f.notifications.push(item);return true;}});
  f.advance();await restored.pollOnce();assert.equal(calls,1);assert.deepEqual(f.notifications[0].buttons,closeButtons);
  const checked=new DatabaseSync(f.database,{readOnly:true});
  assert.equal(checked.prepare('SELECT reply_buttons FROM telegram_control_events').get()?.reply_buttons,null);checked.close();
});

test('invalid structured reply buttons are rejected before enqueue and close errors do not claim a completed sale',async t=>{
  const f=fixture(t,{onClose:()=>({text:'sensitive',buttons:[[{text:'unsafe',callback_data:'https://evil.example'}]]})});
  await f.poll();await f.poll([callback(1,`close:confirm:${closeId}`)]);
  assert.equal(f.controls.status().lastError,'TELEGRAM_CONTROLS_REPLY_INVALID');assert.equal(f.notifications.length,1);
  assert.match(f.notifications[0].text,/结果待核对/);assert.equal(f.notifications[0].buttons,undefined);
  await f.controls.close();const absent=f.make({onClose:undefined});
  f.advance();f.replies.push(result([callback(2,`close:confirm:${closeId}`)]));await absent.pollOnce();
  assert.match(f.notifications[1].text,/未提交平仓/);assert.deepEqual(f.actions,[]);
});

test('close capability is explicit in status while counting remains simulation only',async t=>{
  const f=fixture(t);assert.equal(f.controls.status().mode,'simulation_only');
  assert.equal(f.controls.status().countingMode,'simulation');assert.equal(f.controls.status().manualCloseEnabled,false);
  await f.controls.close();const enabled=f.make({onClose:()=>''});
  assert.equal(enabled.status().mode,'counting_and_manual_positions');assert.equal(enabled.status().countingMode,'simulation');
  assert.equal(enabled.status().manualCloseEnabled,true);await enabled.close();assert.equal(enabled.status().manualCloseEnabled,true);
});

test('live controls report configured mode and /start only shows help before a fresh start instruction',async t=>{
  const actions:TelegramCountAction[]=[],f=fixture(t,{countingMode:'live',onAction:action=>{actions.push(action);return `【计数控制】\n${action}`;}});
  assert.equal(f.controls.status().mode,'live_counting');assert.equal(f.controls.status().countingMode,'live');
  assert.equal(f.controls.status().manualCloseEnabled,false);
  await f.poll([message(1,'启动计数')]);assert.deepEqual(actions,[]);
  await f.poll([message(2,'/start')]);assert.deepEqual(actions,['status']);
  assert.match(f.notifications[0].text,/计数控制（实盘策略）/);assert.match(f.notifications[0].text,/后续达标自动买入/);
  assert.doesNotMatch(f.notifications[0].text,/仅模拟/);
  await f.poll([message(3,'启动计数'),message(3,'启动计数')]);assert.deepEqual(actions,['status','start']);
  await f.controls.close();assert.equal(f.controls.status().countingMode,'live');
  const withClose=f.make({countingMode:'live',onClose:()=>''});
  assert.equal(withClose.status().mode,'counting_and_manual_positions');assert.equal(withClose.status().countingMode,'live');
  assert.equal(withClose.status().manualCloseEnabled,true);
});

test('legacy command schema migrates and an interrupted close does not replay or retain confirmation buttons',async t=>{
  let calls=0;const f=fixture(t,{onClose:()=>{calls++;return 'should not run';}});await f.poll();await f.controls.close();
  const db=new DatabaseSync(f.database);const scope=String(db.prepare('SELECT scope FROM telegram_control_state').get()?.scope);
  db.exec('ALTER TABLE telegram_control_events DROP COLUMN reply_buttons');
  db.prepare("INSERT INTO telegram_control_events(scope,update_id,action,state,created_at,queued) VALUES(?,10,'close','claimed',?,0)").run(scope,startTime);
  db.prepare('UPDATE telegram_control_state SET offset=11').run();db.close();
  const restored=f.make();f.advance();f.replies.push(result([callback(10,`close:confirm:${closeId}`)]));await restored.pollOnce();
  assert.equal(calls,0);assert.equal(f.notifications.length,1);assert.match(f.notifications[0].text,/结果待核对/);
  assert.equal(f.notifications[0].buttons,undefined);assert.equal(restored.status().interrupted,1);
});

for(const [status,description,error] of [
  [409,'Conflict: webhook is active','TELEGRAM_CONTROLS_WEBHOOK_ACTIVE'],
  [409,'Conflict: another getUpdates request','TELEGRAM_CONTROLS_POLL_CONFLICT'],
  [401,'Unauthorized','TELEGRAM_CONTROLS_AUTH_INVALID'],[403,'Forbidden','TELEGRAM_CONTROLS_FORBIDDEN'],
] as const)test(`${error} stops polling with a fixed safe status, without changing webhook state`,async t=>{
  const f=fixture(t);f.replies.push(new Response(JSON.stringify({ok:false,error_code:status,description:description+' '+token}),{status}));
  await f.controls.pollOnce();assert.equal(f.controls.status().lastError,error);assert.equal(f.controls.status().blocked,true);
  f.advance(60000);await f.controls.pollOnce();assert.equal(f.requests.length,1);assert.deepEqual(f.actions,[]);
  assert.ok(f.requests.every(request=>request.url.endsWith('/getUpdates')));assert.equal(JSON.stringify(f.controls.status()).includes(token),false);
});

test('rate limit cooldown persists across restart and does not advance initialization',async t=>{
  const f=fixture(t);f.replies.push(new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:30}}),{status:429}));
  await f.controls.pollOnce();assert.equal(f.controls.status().initialized,false);assert.equal(f.controls.status().lastError,'TELEGRAM_CONTROLS_RATE_LIMITED');
  await f.controls.close();const restored=f.make();f.advance(29999);await restored.pollOnce();assert.equal(f.requests.length,1);
  f.advance(1);await restored.pollOnce();assert.equal(f.requests.length,2);assert.equal(restored.status().initialized,true);
});

test('network errors and malformed updates expose no secrets and never run actions',async t=>{
  const f=fixture(t);f.replies.push(async()=>{throw new Error('url '+token);});await f.controls.pollOnce();
  assert.equal(f.controls.status().lastError,'TELEGRAM_CONTROLS_NETWORK_ERROR');
  f.advance(5000);f.replies.push(result([{update_id:'not-number',message:message(1).message}]));await f.controls.pollOnce();
  assert.equal(f.controls.status().lastError,'TELEGRAM_CONTROLS_RESPONSE_INVALID');assert.deepEqual(f.actions,[]);
  assert.equal(JSON.stringify(f.controls.status()).includes(token),false);
});

test('non-JSON HTTP failure status stays classified and a failed callback acknowledgement never replays an action',async t=>{
  const f=fixture(t);f.replies.push(new Response('upstream '+token,{status:503}));await f.controls.pollOnce();
  assert.equal(f.controls.status().lastError,'TELEGRAM_CONTROLS_UNAVAILABLE');
  f.advance(10000);await f.controls.pollOnce();
  f.advance();f.replies.push(result([callback(1,'count:start')]),async()=>{throw new Error(token);});await f.controls.pollOnce();
  assert.deepEqual(f.actions,['start']);assert.equal(f.notifications.length,1);
  await f.poll([callback(1,'count:start')]);assert.deepEqual(f.actions,['start']);
  assert.equal(f.requests.filter(item=>item.url.endsWith('/answerCallbackQuery')).length,1);
});

test('stop aborts an active poll, awaits it, and does not process its response or record an error',async t=>{
  const f=fixture(t);let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  f.replies.push(async(_url,init)=>new Promise((_resolve,reject)=>{
    entered();init.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  }));
  const pending=f.controls.pollOnce();await started;await f.controls.stop();await pending;
  assert.equal(f.controls.status().running,false);assert.equal(f.controls.status().lastError,undefined);assert.deepEqual(f.actions,[]);
  await f.controls.close();await f.controls.pollOnce();assert.equal(f.requests.length,1);
});

test('start schedules one receiver, concurrent polls coalesce, and stop cancels future scheduling',async t=>{
  const f=fixture(t);f.controls.start();f.controls.start();
  await Promise.all([f.controls.pollOnce(),f.controls.pollOnce()]);assert.equal(f.requests.length,1);
  await f.controls.stop();await new Promise(resolve=>setTimeout(resolve,70));assert.equal(f.requests.length,1);
});

test('credentials and incoming chat contents are not persisted; private positive Chat ID is required',async t=>{
  const f=fixture(t);await f.poll([message(100,'private ignored history')]);await f.poll([message(101,'not a command')]);
  const db=new DatabaseSync(f.database,{readOnly:true});
  const serialized=JSON.stringify([db.prepare('SELECT * FROM telegram_control_state').all(),db.prepare('SELECT * FROM telegram_control_events').all()]);db.close();
  for(const secret of [token,chatId,'private ignored history','not a command'])assert.equal(serialized.includes(secret),false);
  await f.controls.close();assert.equal(readFileSync(f.database).includes(Buffer.from(token)),false);
  for(const invalid of ['-123','@user','00123','0','9007199254740992'])assert.throws(()=>new TelegramControls({
    token,chatId:invalid,database:':memory:',enqueue:()=>true,onAction:()=>''}),/TELEGRAM_CONTROLS_CONFIG_INVALID/);
});

test('transport keeps unrelated administrative and webhook methods outside its allowlist',async()=>{
  for(const method of ['setWebhook','deleteWebhook','getMe','sendDocument'])await assert.rejects(
    telegramIpv4Fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',body:'{}'}),/TELEGRAM_TRANSPORT_REQUEST_INVALID/);
});
