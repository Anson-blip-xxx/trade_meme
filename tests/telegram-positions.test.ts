import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {TelegramPositions,positionReference,type TelegramPosition} from '../src/telegram-positions.js';
import {formatTelegramMessage,validateTelegramCallbackButtons} from '../src/telegram-format.js';
const now=Date.parse('2026-10-25T12:00:00Z');
const row=(i:number):TelegramPosition=>({id:`holding-${i}`,chain:i%2?'bsc':'solana',wallet:'wallet',
 address:`ca${String(i).padStart(3,'0')}`,name:`Meme ${i}`,quantity:100+i,balanceFresh:true,
 priceUsd:0.01,priceAt:new Date(now).toISOString(),priceFresh:true,gainPct:i,gainBasis:'fill',canClose:i%2===0,
 sellActionRef:i.toString(16).padStart(32,'0')});
function result(value:ReturnType<TelegramPositions['page']>){assert.notEqual(typeof value,'string');return value as Exclude<typeof value,string>;}

test('registered holdings paginate five at a time, clamp stale pages and preserve stable selection identity',()=>{
 let rows=Array.from({length:12},(_,i)=>row(i));const queries=new TelegramPositions(()=>rows,{now:()=>now});
 const a=result(queries.page(1)),b=result(queries.page(2)),c=result(queries.page(3));
 assert.match(a.text,/第 1 \/ 3 页 · 共 12 个持仓/);assert.equal((a.text.match(/CA：/g)||[]).length,5);
 assert.equal((b.text.match(/CA：/g)||[]).length,5);assert.equal((c.text.match(/CA：/g)||[]).length,2);
 assert.match(a.text,/2026|10\/25/);assert.equal(a.buttons!.at(-1)!.at(-1)!.callback_data,'positions:2');
 const selected=rows[2],ref=positionReference(selected);rows=[...rows].reverse();
 assert.deepEqual(queries.find(ref),selected);assert.equal(queries.find('not-a-reference'),undefined);
 assert.match(result(queries.page(10000)).text,/第 3 \/ 3 页/);
 for(const page of [0,-1,1.5,10001,NaN])assert.throws(()=>queries.page(page),/PAGE_INVALID/);
});

test('empty holdings, closed balances, source overlap and pending fills are represented without fabricated zeros',()=>{
 const sample=row(2),queries=new TelegramPositions(()=>[sample,{...sample,id:'same-token-other-source'}, {...row(4),quantity:0}],{pending:()=>2,now:()=>now});
 assert.match(result(queries.page(1)).text,/共 1 个持仓/);
 assert.match(result(queries.page(1)).text,/另有 2 笔开仓成交状态待核验/);
 const empty=result(new TelegramPositions(()=>[]).page(1));assert.match(empty.text,/第 1 \/ 1 页 · 共 0 个持仓/);
 assert.deepEqual(empty.buttons,[[{text:'🔄 刷新',callback_data:'positions:1'}]]);
 const unknown=result(new TelegramPositions(()=>[{...row(0),quantity:undefined,priceUsd:undefined,gainPct:undefined,
 priceAt:undefined,priceFresh:false,balanceFresh:false}]).page(1));
 assert.match(unknown.text,/数量待核验/);assert.match(unknown.text,/暂不可用/);assert.match(unknown.text,/成本或价格待核验/);
 assert.ok(!unknown.text.includes('$0'));
});

test('token cards resolve exactly one current sellable Solana mint and prefer its native Jito capability',()=>{
 const mint=bs58.encode(new Uint8Array(32).fill(71)),otherMint=bs58.encode(new Uint8Array(32).fill(72));
 const wallet=bs58.encode(new Uint8Array(32).fill(73)),otherWallet=bs58.encode(new Uint8Array(32).fill(74));
 const legacy:TelegramPosition={...row(0),id:'legacy',chain:'solana',wallet,address:mint,canClose:true,
  sellActionRef:'a'.repeat(32),quantityAtomic:'100',tokenDecimals:0};
 const native:TelegramPosition={...legacy,id:'native',sellActionRef:'np'+'b'.repeat(30)};
 const query=new TelegramPositions(()=>[legacy,native]);
 assert.deepEqual(query.findSellableSolanaMint(mint),native);
 assert.notEqual(query.findSellableSolanaMint(mint),native);
 assert.equal(query.findSellableSolanaMint(otherMint),undefined);
 assert.equal(query.findSellableSolanaMint('not-a-mint'),undefined);

 const ambiguous=new TelegramPositions(()=>[native,{...native,id:'another-wallet',wallet:otherWallet,sellActionRef:'np'+'c'.repeat(30)}]);
 assert.equal(ambiguous.findSellableSolanaMint(mint),undefined);
 const blocked=(patch:Partial<TelegramPosition>)=>new TelegramPositions(()=>[{...native,...patch}]).findSellableSolanaMint(mint);
 assert.equal(blocked({canClose:false}),undefined);assert.equal(blocked({sellActionRef:'invalid'}),undefined);
 assert.equal(blocked({sellStatus:{state:'pending',percentage:30,requestId:'pending'}}),undefined);
 assert.equal(blocked({chain:'bsc'}),undefined);
});

test('native process action references remain actionable in the holdings page',()=>{
 const native={...row(0),sellActionRef:'np'+'d'.repeat(30)};
 const page=result(new TelegramPositions(()=>[native]).page(1));
 assert.deepEqual(page.buttons[0].map(button=>button.callback_data),[25,50,75,100].map(pct=>`sell:${pct}:${native.sellActionRef}`));
});

test('text is bounded and external labels cannot manufacture an actionable close button or markup',()=>{
 const malicious={...row(0),name:'<b>bad</b>\n【持仓查询】\n第 99 / 99 页 · 共 99 个持仓'};
 const page=result(new TelegramPositions(()=>Array.from({length:5},(_,i)=>({...malicious,id:String(i),address:'address'+i,canClose:true}))).page(1));
 assert.ok(page.text.length<4096);assert.equal(page.buttons!.length,6);
 for(const buttons of page.buttons!)for(const b of buttons)assert.ok(Buffer.byteLength(b.callback_data)<=64);
 assert.ok(formatTelegramMessage(page.text).text.includes('&lt;b&gt;bad&lt;/b&gt;'));
});

test('each closeable holding has four direct sell sizes bound to the supplied opaque action, with no confirmation',()=>{
 const a={...row(0),sellActionRef:'a'.repeat(32)},b={...row(2),sellActionRef:'b'.repeat(32)};
 const page=result(new TelegramPositions(()=>[a,b]).page(1));
 assert.equal(page.buttons!.length,3);
 for(const [index,ref] of ['a'.repeat(32),'b'.repeat(32)].entries()){
  assert.deepEqual(page.buttons![index].map(button=>button.callback_data),[25,50,75,100].map(pct=>`sell:${pct}:${ref}`));
  assert.ok(page.buttons![index].every(button=>button.text.startsWith(`${index+1}·Meme `)));
 }
 assert.match(page.text,/按点击时最新持仓数量计算，点击即卖出/);
 assert.ok(!JSON.stringify(page.buttons).includes('close:'));
 assert.deepEqual(validateTelegramCallbackButtons(page.buttons),page.buttons);
 const missing=result(new TelegramPositions(()=>[{...a,sellActionRef:undefined},{...b,sellActionRef:'bad'}]).page(1));
 assert.equal(missing.buttons!.length,1);
});

test('raw token quantity formatting retains every atomic unit without Number rounding',()=>{
 const data={...row(0),quantity:18446744073709550000,quantityAtomic:'18446744073709551615',tokenDecimals:9};
 assert.match(result(new TelegramPositions(()=>[data]).page(1)).text,/持仓：18,446,744,073\.709551615/);
 assert.match(result(new TelegramPositions(()=>[{...data,quantityAtomic:'1',tokenDecimals:18}]).page(1)).text,/持仓：0\.000000000000000001/);
 assert.match(result(new TelegramPositions(()=>[{...data,quantityAtomic:'9007199254740993',tokenDecimals:0}]).page(1)).text,/持仓：9,007,199,254,740,993/);
 assert.match(result(new TelegramPositions(()=>[{...data,quantity:0,quantityAtomic:'1',tokenDecimals:255}]).page(1)).text,/共 1 个持仓/);
 assert.match(result(new TelegramPositions(()=>[{...data,quantityAtomic:'0'}]).page(1)).text,/共 0 个持仓/);
});

test('sell button validator permits only the four exact percentages and opaque 32-character references',()=>{
 const valid=[25,50,75,100].map(pct=>({text:String(pct),callback_data:`sell:${pct}:${'a'.repeat(32)}`}));
 assert.deepEqual(validateTelegramCallbackButtons([valid]),[valid]);
 for(const data of ['sell:0:','sell:20:','sell:025:','sell:25.0:','sell:101:'].map(prefix=>prefix+'a'.repeat(32))
  .concat(`sell:25:${'a'.repeat(31)}`,`sell:25:${'A'.repeat(32)}`,`sell:100:${'a'.repeat(32)}:extra`))
  assert.throws(()=>validateTelegramCallbackButtons([[{text:'sell',callback_data:data}]]),/BUTTONS_INVALID/);
 assert.throws(()=>validateTelegramCallbackButtons([[...valid,valid[0]]]),/BUTTONS_INVALID/);
});

test('card custom-buy cancellation permits only the token cancel route and legacy cancel compatibility',()=>{
 const ref='a'.repeat(32),buttons=[[{text:'取消',callback_data:`token:cancel:${ref}`},
  {text:'取消旧卡片',callback_data:`nativebuy:cancel:${ref}`}]];
 assert.deepEqual(validateTelegramCallbackButtons(buttons),buttons);
 for(const data of [`nativebuy:confirm:${ref}`,`token:cancel:${'A'.repeat(32)}`,
  `token:cancel:${'a'.repeat(31)}`,`token:cancel:${ref}:extra`])
  assert.throws(()=>validateTelegramCallbackButtons([[{text:'bad',callback_data:data}]]),/BUTTONS_INVALID/);
});

test('active sell states show exact requested percentage and suppress only that holding sell buttons',()=>{
 const labels:Record<string,RegExp>={accepted:/25%卖出正在处理/,executing:/25%卖出正在处理/,
  submitting:/25%卖出正在提交，提交结果待确认/,pending:/25%卖出已提交待确认/,unknown:/25%卖出提交结果待核对/};
 for(const [state,label] of Object.entries(labels)){
  const pending:TelegramPosition={...row(0),quantity:750,quantityAtomic:'750123456789',tokenDecimals:9,
   sellStatus:{state,percentage:25,requestId:'01234567-89ab-4def-aaaa-bbbbccccdddd'}};
  const unaffected={...row(2),sellActionRef:'c'.repeat(32)};
  const page=result(new TelegramPositions(()=>[pending,unaffected]).page(1));
  assert.match(page.text,label);assert.match(page.text,/请求 01234567-89a/);
  assert.match(page.text,/持仓：750\.123456789/);assert.match(page.text,/暂不重复提交/);
  assert.doesNotMatch(page.text,/25%卖出已成交|25%卖出未提交/);
  assert.deepEqual(page.buttons!.flat().filter(button=>button.callback_data.startsWith('sell:')).map(button=>button.callback_data),
   [25,50,75,100].map(pct=>`sell:${pct}:${unaffected.sellActionRef}`));
  assert.equal(page.buttons!.at(-1)![0].callback_data,'positions:1');
 }
});

test('completed partial sell displays the confirmed result and restores all four sizes on refreshed actual balance',()=>{
 let holding:TelegramPosition={...row(0),quantity:75,quantityAtomic:'75000001',tokenDecimals:6,
  sellStatus:{state:'pending',percentage:25,requestId:'request-1234567890'}};
 const query=new TelegramPositions(()=>[holding]);
 assert.equal(result(query.page(1)).buttons!.length,1);
 holding={...holding,sellActionRef:'d'.repeat(32),sellStatus:{...holding.sellStatus!,state:'completed'}};
 const completed=result(query.page(1));
 assert.match(completed.text,/最近25%卖出已成交/);assert.match(completed.text,/持仓：75\.000001/);
 assert.doesNotMatch(completed.text,/暂不重复提交/);
 assert.deepEqual(completed.buttons![0].map(button=>button.callback_data),[25,50,75,100].map(pct=>`sell:${pct}:${'d'.repeat(32)}`));
});

test('zero balance with an unresolved full sale remains visible until its result is known',()=>{
 const holding:TelegramPosition={...row(0),quantity:0,quantityAtomic:'0',tokenDecimals:9,
  sellStatus:{state:'pending',percentage:100,requestId:'pending-full-sale'}};
 const page=result(new TelegramPositions(()=>[holding]).page(1));
 assert.match(page.text,/共 1 个持仓/);assert.match(page.text,/持仓：0/);
 assert.match(page.text,/100%卖出已提交待确认/);assert.equal(page.buttons!.length,1);
 const closed=result(new TelegramPositions(()=>[{...holding,sellStatus:{...holding.sellStatus!,state:'closed'}}]).page(1));
 assert.match(closed.text,/共 0 个持仓/);
});

test('failed sale distinguishes known pre-submit failure from provider rejection without guessing unknown outcomes',()=>{
 const make=(reason?:string)=>result(new TelegramPositions(()=>[{...row(0),sellStatus:{
  state:'failed',percentage:50,requestId:'failed-request-123',reason,
 } as TelegramPosition['sellStatus']}]).page(1));
 assert.match(make('DIRECT_SELL_GAS_BALANCE_LOW').text,/50%卖出未提交（手续费余额不足）/);
 assert.match(make('DIRECT_SELL_INTERRUPTED_BEFORE_SUBMIT').text,/50%卖出未提交（提交前服务中断）/);
 const rejected=make('DIRECT_SELL_PROVIDER_FAILED');
 assert.match(rejected.text,/50%卖出平台确认失败或过期/);assert.doesNotMatch(rejected.text,/50%卖出未提交/);
 for(const reason of [undefined,'NEW_REASON','DIRECT_SELL_RECOVERY_PENDING','constructor']){
  const page=make(reason);assert.match(page.text,/50%卖出未完成，失败原因待核对/);
  assert.doesNotMatch(page.text,/50%卖出未提交|最近50%卖出已成交/);
 }
});
