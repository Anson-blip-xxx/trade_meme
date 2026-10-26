import test from 'node:test';
import assert from 'node:assert/strict';
import {formatTelegramMessage,validateTelegramCallbackButtons,validateTelegramNotificationButtons} from '../src/telegram-format.js';

const mint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ca='0xc24f42b1e458251e3a128b74c65c4c7fa0c97777';
const link=`https://gmgn.ai/sol/token/${mint}`;
const decode=(html:string)=>html.replace(/<\/?(?:b|code)>/g,'')
  .replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const holding=(url=link)=>`【实盘持仓监控】BONK · Solana\n价格越过 +10.00%\n相对买入价：+12.50%\n监控以来采样峰值：+18.00%\n距峰值回撤：4.66%\n\n买入美元价：$0.000008\n最新价格：$0.000009\n剩余数量：336,965.14738\n报价时间：2026-10-25T12:00:00Z\n美元涨跌未扣费用，不等于 SOL 净收益。\n挂单不代表成交；有效保护状态须单独核验。\nCA：${mint}\n${url}`;

test('held milestone has a bold title, gains, readable groups and a matching GMGN button',()=>{
  const rendered=formatTelegramMessage(holding());
  assert.equal(rendered.parse_mode,'HTML');
  assert.deepEqual(rendered.link_preview_options,{is_disabled:true});
  assert.match(rendered.text,/^📊 <b>BONK · Solana<\/b>\n实盘持仓监控\n\n/);
  assert.match(rendered.text,/📈 <b>价格越过 \+10\.00%<\/b>/);
  assert.match(rendered.text,/<b>相对买入价<\/b>：<b>\+12\.50%<\/b>/);
  assert.match(rendered.text,/<b>距峰值回撤<\/b>：<b>4\.66%<\/b>/);
  assert.ok(rendered.text.includes(`\n\nCA：<code>${mint}</code>`));
  assert.deepEqual(rendered.reply_markup,{inline_keyboard:[[{text:'查看 GMGN',url:link}]]});
  assert.equal(rendered.text.includes(link),false);
  const plain=decode(rendered.text);
  for(const line of holding().split('\n').slice(1).filter(line=>line&&line!==link))assert.ok(plain.includes(line),line);
  assert.ok(plain.includes('BONK · Solana'));assert.ok(plain.includes('实盘持仓监控'));
});

test('real and paper order titles remain unmistakable, with copyable IDs and hashes',()=>{
  const original='【实盘订单】\n报价失败：PRICE_UNAVAILABLE\n代币：BONK\n链：Solana\n开仓单：order-123\nGMGN 单号：vendor-123\n策略单：strategy-123\n条件单：condition-123\n开仓交易：signature-123\n成交输入：0.01 SOL\n基准是首个参考价，不等于实际盈亏。';
  const rendered=formatTelegramMessage(original);
  assert.match(rendered.text,/^🧾 <b>实盘订单<\/b>/);
  for(const id of ['order-123','vendor-123','strategy-123','condition-123','signature-123'])assert.ok(rendered.text.includes(`<code>${id}</code>`));
  for(const line of original.split('\n').slice(1))assert.ok(decode(rendered.text).includes(line));
  assert.match(formatTelegramMessage('【模拟持仓，非实盘】\n开仓模拟完成').text,/🧪 <b>模拟持仓，非实盘<\/b>/);
});

test('raw HTML, quotes, entities and token names are always displayed as literal content',()=>{
  const original='【实盘持仓监控】<b>BAD</b> & "BONK" · Solana\n相对买入价：+20% <a href="https://evil.example">假链接</a>\nCA：</code><script>x</script>\n&lt;b&gt;literal';
  const result=formatTelegramMessage(original);
  assert.ok(result.text.includes('&lt;b&gt;BAD&lt;/b&gt; &amp; &quot;BONK&quot;'));
  assert.ok(result.text.includes('&lt;a href=&quot;https://evil.example&quot;&gt;假链接&lt;/a&gt;'));
  assert.ok(result.text.includes('<code>&lt;/code&gt;&lt;script&gt;x&lt;/script&gt;</code>'));
  assert.ok(result.text.includes('&amp;lt;b&amp;gt;literal'));
  assert.equal(/<(?:script|a|img)\b/.test(result.text),false);
  assert.equal(result.reply_markup,undefined);
  for(const line of original.split('\n').slice(1))assert.ok(decode(result.text).includes(line));
  assert.ok(decode(result.text).includes('<b>BAD</b> & "BONK" · Solana'));
});

test('ordinary notifications retain exact text and do not invent trade status or links',()=>{
  const original='连通检查通过 & <尚未买卖>\n普通文本 +20%\nhttps://example.com?a=1&b=2';
  const result=formatTelegramMessage(original);
  assert.equal(decode(result.text),original);assert.equal(result.reply_markup,undefined);
  assert.equal(result.text.includes('<b>'),false);
});

test('token-card amount grid accepts only compact preset/custom callbacks with a canonical Solana mint',()=>{
  const valid=[
    [{text:'0.1 SOL',callback_data:`token:buy:a:${mint}`},{text:'0.5 SOL',callback_data:`token:buy:b:${mint}`},
      {text:'1 SOL',callback_data:`token:buy:c:${mint}`}],
    [{text:'3 SOL',callback_data:`token:buy:d:${mint}`},{text:'5 SOL',callback_data:`token:buy:e:${mint}`},
      {text:'自定义',callback_data:`token:custom:${mint}`}],
    [{text:'刷新代币详情',callback_data:`token:refresh:${mint}`}],
  ];
  assert.deepEqual(validateTelegramCallbackButtons(valid),valid);
  assert.ok(valid.flat().every(button=>Buffer.byteLength(button.callback_data)<=64));
  // Already-sent exact 0.01 SOL cards remain parseable during deployment.
  const legacy=[[{text:'旧买入按钮',callback_data:`token:buy:${mint}`}]];
  assert.deepEqual(validateTelegramCallbackButtons(legacy),legacy);
  for(const data of [
    'token:refresh:11111111111111111111111111111111',
    `token:refresh:${mint}:extra`,`token:refresh:${mint.slice(10)}`,
    `token:refresh:${mint}x`,`tok:r:${mint}`,'token:refresh:',
    'token:buy:11111111111111111111111111111111',`token:buy:${mint}:extra`,
    `token:buy:${mint.slice(10)}`,`token:buy:${mint}x`,'token:buy:',
    `token:buy:f:${mint}`,`token:buy:A:${mint}`,`token:buy:0.1:${mint}`,
    `token:buy:a:${mint}:extra`,`token:buy:a:${mint.slice(10)}`,`token:buy:a:${mint}x`,
    `token:custom:11111111111111111111111111111111`,`token:custom:${mint}:extra`,
    `token:custom:${mint.slice(10)}`,`token:custom:${mint}x`,'token:custom:',
  ])assert.throws(()=>validateTelegramCallbackButtons([[{text:'刷新',callback_data:data}]]),/TELEGRAM_BUTTONS_INVALID/);
});

test('token-card sell row accepts exactly 30, 50, 100 and custom on one opaque capability',()=>{
  const ref=`np${'b'.repeat(30)}`;
  const valid=[[{text:'🔴 卖30%',callback_data:`sell:30:${ref}`},
    {text:'🔴 卖50%',callback_data:`sell:50:${ref}`},
    {text:'🔴 卖100%',callback_data:`sell:100:${ref}`},
    {text:'✏️ 自定义卖出',callback_data:`sell:custom:${ref}`}]];
  assert.deepEqual(validateTelegramCallbackButtons(valid),valid);
  assert.ok(valid[0].every(button=>Buffer.byteLength(button.callback_data)<=64));
  for(const data of [
    `sell:0:${ref}`,`sell:101:${ref}`,`sell:30.0:${ref}`,`sell:30%:${ref}`,
    `sell:Custom:${ref}`,`sell:custom:${ref}:extra`,`sell:30:${ref}x`,
    `sell:30:np${'a'.repeat(29)}`,`sell:custom:np${'a'.repeat(31)}`,
  ])assert.throws(()=>validateTelegramCallbackButtons([[{text:'卖出',callback_data:data}]]),/TELEGRAM_BUTTONS_INVALID/,data);
});

test('direct-sell callbacks accept only legacy hex and the exact native np capability namespace',()=>{
  const refs=['a'.repeat(32),`np${'b'.repeat(30)}`];
  for(const ref of refs)assert.deepEqual(validateTelegramCallbackButtons([[
    {text:'卖 25%',callback_data:`sell:25:${ref}`},{text:'卖 50%',callback_data:`sell:50:${ref}`},
    {text:'卖 75%',callback_data:`sell:75:${ref}`},{text:'卖 100%',callback_data:`sell:100:${ref}`},
  ]]),[[
    {text:'卖 25%',callback_data:`sell:25:${ref}`},{text:'卖 50%',callback_data:`sell:50:${ref}`},
    {text:'卖 75%',callback_data:`sell:75:${ref}`},{text:'卖 100%',callback_data:`sell:100:${ref}`},
  ]]);
  for(const ref of [`np${'a'.repeat(29)}`,`np${'a'.repeat(31)}`,`NP${'a'.repeat(30)}`,
    `xx${'a'.repeat(30)}`,'g'.repeat(32)])
    assert.throws(()=>validateTelegramCallbackButtons([[{text:'卖出',callback_data:`sell:100:${ref}`}]]),/TELEGRAM_BUTTONS_INVALID/);
});

test('four-button sell rows reject mixed capabilities, duplicate sizes and reordered actions',()=>{
  const a=`np${'a'.repeat(30)}`,b=`np${'b'.repeat(30)}`;
  const rows=[
    [`sell:30:${a}`,`sell:50:${a}`,`sell:100:${b}`,`sell:custom:${a}`],
    [`sell:30:${a}`,`sell:50:${a}`,`sell:50:${a}`,`sell:custom:${a}`],
    [`sell:50:${a}`,`sell:30:${a}`,`sell:100:${a}`,`sell:custom:${a}`],
    [`sell:25:${a}`,`sell:50:${a}`,`sell:100:${a}`,`sell:75:${a}`],
  ];
  for(const values of rows)assert.throws(()=>validateTelegramCallbackButtons([
    values.map((callback_data,index)=>({text:String(index),callback_data})),
  ]),/TELEGRAM_BUTTONS_INVALID/);
});

test('notification buttons safely combine callbacks with exact official Solana token links',()=>{
  const buttons=[
    [{text:'买入 0.1 SOL',callback_data:`token:buy:a:${mint}`},{text:'刷新',callback_data:`token:refresh:${mint}`}],
    [{text:'GMGN',url:`https://gmgn.ai/sol/token/${mint}`},{text:'DexScreener',url:`https://dexscreener.com/solana/${mint}`},
      {text:'Solscan',url:`https://solscan.io/token/${mint}`},{text:'Pump',url:`https://pump.fun/coin/${mint}`}],
  ];
  assert.deepEqual(validateTelegramNotificationButtons(buttons),buttons);
  assert.throws(()=>validateTelegramCallbackButtons(buttons),/TELEGRAM_BUTTONS_INVALID/);
});

test('notification URL buttons reject noncanonical mints and deceptive URL variants',()=>{
  const official=[
    `https://gmgn.ai/sol/token/${mint}`,`https://dexscreener.com/solana/${mint}`,
    `https://solscan.io/token/${mint}`,`https://pump.fun/coin/${mint}`,
  ];
  for(const url of official)assert.deepEqual(validateTelegramNotificationButtons([[{text:'详情',url}]]),[[{text:'详情',url}]]);
  for(const url of [
    `http://gmgn.ai/sol/token/${mint}`,`https://www.gmgn.ai/sol/token/${mint}`,
    `https://gmgn.ai.evil.example/sol/token/${mint}`,`https://gmgn.ai@evil.example/sol/token/${mint}`,
    `https://evil.example@gmgn.ai/sol/token/${mint}`,`https://gmgn.ai:443/sol/token/${mint}`,
    `https://gmgn.ai/sol/token/${mint}?from=bot`,`https://gmgn.ai/sol/token/${mint}#chart`,
    `https://gmgn.ai/sol/token/${mint}/`, `https://dexscreener.com/solana/${mint}/extra`,
    `https://solscan.io/token/${'1'.repeat(32)}`,`https://pump.fun/coin/${mint}x`,
    `https://pump.fun/${mint}`,`javascript:alert(1)`,
  ])assert.throws(()=>validateTelegramNotificationButtons([[{text:'详情',url}]]),/TELEGRAM_BUTTONS_INVALID/,url);
  assert.throws(()=>validateTelegramNotificationButtons([[{text:'混合',url:official[0],callback_data:'positions:1'}]]),/TELEGRAM_BUTTONS_INVALID/);
});

test('downward milestones and settings updates use appropriate icons without changing thresholds',()=>{
  const down=formatTelegramMessage('【实盘持仓监控】BONK · Solana\n价格越过 -10.00%、-20.00%');
  assert.ok(down.text.includes('📉 <b>价格越过 -10.00%、-20.00%</b>'));
  const update=formatTelegramMessage('【实盘持仓监控】BONK · Solana\n通知设置更新\n涨幅提醒：+10%、+25%');
  assert.ok(update.text.includes('🔔 <b>通知设置更新</b>'));
  assert.ok(update.text.includes('<b>+10%</b>、<b>+25%</b>'));
});

test('GMGN button rejects deceptive domains, credentials, encoded routes, queries and markup',()=>{
  for(const invalid of [
    `http://gmgn.ai/sol/token/${mint}`,`https://gmgn.ai.evil.example/sol/token/${mint}`,
    `https://gmgn.ai@evil.example/sol/token/${mint}`,`https://evil.example@gmgn.ai/sol/token/${mint}`,
    `https://gmgn.ai:443/sol/token/${mint}`,`${link}?target=https://evil.example`,`${link}#x`,
    `https://gmgn.ai/sol/token/%44ezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`,
    `https://gmgn.ai/bsc/../sol/token/${mint}`,`<a href="${link}">GMGN</a>`,
    `[GMGN](${link})`,`javascript:alert(1)`,`${link} trailing fact`,
  ]) {
    const result=formatTelegramMessage(holding(invalid));
    assert.equal(result.reply_markup,undefined,invalid);
    assert.ok(decode(result.text).includes(invalid));
  }
});

test('GMGN chain and canonical CA must match, and ambiguous identities preserve URLs as text',()=>{
  for(const original of [
    holding(`https://gmgn.ai/bsc/token/${ca}`),
    holding(`https://gmgn.ai/sol/token/So11111111111111111111111111111111111111112`),
    holding().replace(`CA：${mint}`,'CA：'+'1'.repeat(44)),
    holding()+`\n链：BSC`,holding()+`\nCA：So11111111111111111111111111111111111111112`,
    holding().replace(`CA：${mint}\n`,''),holding().replace(' · Solana',''),
    holding().replace(' · Solana',' · unknown'),
  ])assert.equal(formatTelegramMessage(original).reply_markup,undefined);
});

test('BSC and Robinhood matching EVM links become buttons and EVM identity is case insensitive',()=>{
  for(const [chain,title] of [['bsc','BSC'],['robinhood','Robinhood Chain']]) {
    const url=`https://gmgn.ai/${chain}/token/${ca}`;
    const rendered=formatTelegramMessage(`【实盘订单】\n链：${title}\nCA：0x${ca.slice(2).toUpperCase()}\nGMGN：${url}`);
    assert.equal(rendered.reply_markup?.inline_keyboard?.[0][0].url,url);
    assert.equal(rendered.text.includes(url),false);
  }
});

test('repeated safe URLs produce one button without dropping surrounding facts',()=>{
  const result=formatTelegramMessage(holding()+`\n${link}\n保护状态：check，尚未验证触发。`);
  assert.equal(result.reply_markup?.inline_keyboard?.flat().length,1);
  assert.ok(result.text.endsWith('保护状态：check，尚未验证触发。'));
});

test('Telegram limit is decoded text length, so escaping expansion preserves the full message',()=>{
  const original='&<>"'.repeat(1000),result=formatTelegramMessage(original);
  assert.ok(result.text.length>4096);
  assert.equal(decode(result.text),original);
  assert.equal(decode(result.text).length,4000);
});

test('4096-character limit falls back to full escaped original instead of truncating important details',()=>{
  const header='【实盘订单】\n',tail='\n错误：保护尚未核验，不保证成交。';
  const original=header+'&'.repeat(4096-header.length-tail.length)+tail;
  const result=formatTelegramMessage(original);
  assert.equal(decode(result.text),original);assert.equal(result.text.includes('<b>'),false);
  assert.ok(result.text.endsWith(tail));assert.equal(result.reply_markup,undefined);
});

test('emoji near the limit is not split and invalid input is explicitly rejected',()=>{
  const original='🚀'.repeat(2048),result=formatTelegramMessage(original);
  assert.equal(decode(result.text),original);
  for(const invalid of ['','   ','x'.repeat(4097)])assert.throws(()=>formatTelegramMessage(invalid),/TELEGRAM_MESSAGE_LENGTH_INVALID/);
});

test('count controls have persistent text buttons while preserving escaped facts and no inline keyboard',()=>{
  const result=formatTelegramMessage(`【计数控制】\n模拟计数 · 不执行实盘\n状态：<运行中> & 已登记\n链：Solana\nCA：${mint}\n${link}`);
  assert.deepEqual(result.reply_markup,{
    keyboard:[[{text:'启动计数'},{text:'停止计数'}],[{text:'计数状态'},{text:'持仓查询'}],[{text:'🧪 0.01 SOL 测试买入'}]],
    resize_keyboard:true,is_persistent:true,one_time_keyboard:false,input_field_placeholder:'计数 · 持仓 · 0.01 SOL 测试买入',
  });
  assert.match(result.text,/🎛 <b>计数控制<\/b>/);assert.ok(result.text.includes('&lt;运行中&gt; &amp; 已登记'));
  assert.ok(result.text.includes(link));assert.equal(result.reply_markup?.inline_keyboard,undefined);
  assert.equal(formatTelegramMessage('普通消息里提到【计数控制】').reply_markup,undefined);
});

test('count controls retain persistent keyboard when a near-limit message falls back to plain escaped text',()=>{
  const prefix='【计数控制】\n',value=prefix+'&'.repeat(4096-prefix.length);
  const result=formatTelegramMessage(value);assert.equal(decode(result.text),value);
  assert.equal(result.reply_markup?.keyboard?.[0][0].text,'启动计数');assert.ok(result.text.length>4096);
});

test('live control messages never inherit a simulation-only keyboard placeholder',()=>{
  for(const state of ['实盘计数：已停止 · 启动后达标自动实盘买入','实盘计数：运行中 · 达标自动实盘买入']){
    const result=formatTelegramMessage(`【计数控制】\n${state}\n处理链：SOL`);
    assert.ok(result.reply_markup&&'input_field_placeholder' in result.reply_markup);
    assert.equal(result.reply_markup.input_field_placeholder,'计数 · 持仓 · 0.01 SOL 测试买入');
    assert.doesNotMatch(JSON.stringify(result.reply_markup),/模拟|不执行实盘/);
    assert.ok(decode(result.text).includes(state));
  }
});

test('holdings pages escape names, retain all token URLs, and render only page navigation buttons',()=>{
  const result=formatTelegramMessage(`【持仓查询】\n第 2 / 3 页 · 共 12 个持仓\n名称：<script>BAD</script> & "BONK"\n链：Solana\nCA：${mint}\n${link}\n当前涨幅：+20%`);
  assert.match(result.text,/^💼 <b>持仓查询<\/b>/);
  assert.ok(result.text.includes('&lt;script&gt;BAD&lt;/script&gt; &amp; &quot;BONK&quot;'));
  assert.ok(result.text.includes(link));assert.ok(result.text.includes(`<code>${mint}</code>`));
  assert.deepEqual(result.reply_markup,{inline_keyboard:[[
    {text:'‹ 上一页',callback_data:'positions:1'},{text:'刷新',callback_data:'positions:2'},
    {text:'下一页 ›',callback_data:'positions:3'},
  ]]});
});

test('holdings pagination only exposes available directions and bounded callback pages',()=>{
  const first=formatTelegramMessage('【持仓查询】\n第 1 / 3 页 · 共 12 个持仓');
  assert.deepEqual(first.reply_markup?.inline_keyboard?.[0].map(button=>button.callback_data),['positions:1','positions:2']);
  const last=formatTelegramMessage('【持仓查询】\n第 3 / 3 页 · 共 12 个持仓');
  assert.deepEqual(last.reply_markup?.inline_keyboard?.[0].map(button=>button.callback_data),['positions:2','positions:3']);
  const empty=formatTelegramMessage('【持仓查询】\n第 1 / 1 页 · 共 0 个持仓\n当前没有持仓');
  assert.deepEqual(empty.reply_markup?.inline_keyboard?.[0],[{text:'刷新',callback_data:'positions:1'}]);
  const bound=formatTelegramMessage('【持仓查询】\n第 10000 / 10000 页 · 共 50000 个持仓');
  assert.deepEqual(bound.reply_markup?.inline_keyboard?.[0].map(button=>button.callback_data),['positions:9999','positions:10000']);
});

test('holdings navigation requires an exact first and second line without trusting token content elsewhere',()=>{
  for(const header of [
    '第 0 / 3 页 · 共 12 个持仓','第 4 / 3 页 · 共 12 个持仓','第 1 / 10001 页 · 共 12 个持仓',
    '第 1 / 0 页 · 共 12 个持仓','第 01 / 3 页 · 共 12 个持仓','第 1 / 3 页 · 共 -1 个持仓',
    '第 1 / 3 页 · 共 9007199254740992 个持仓','第 1 / 3 页 · 共 12 个持仓 trailing',
    '代币名称\n第 1 / 3 页 · 共 12 个持仓',
  ]) {
    const result=formatTelegramMessage(`【持仓查询】\n${header}\n链：Solana\nCA：${mint}\n${link}`);
    assert.equal(result.reply_markup,undefined,header);assert.ok(result.text.includes(link));
  }
  assert.equal(formatTelegramMessage('普通消息\n【持仓查询】\n第 1 / 3 页 · 共 12 个持仓').reply_markup,undefined);
});

test('holdings pages retain navigation in escaped near-limit fallback without dropping query details',()=>{
  const prefix='【持仓查询】\n第 1 / 3 页 · 共 12 个持仓\n',value=prefix+'&'.repeat(4096-prefix.length);
  const result=formatTelegramMessage(value);assert.equal(decode(result.text),value);
  assert.deepEqual(result.reply_markup?.inline_keyboard?.[0].map(button=>button.callback_data),['positions:1','positions:2']);
});
