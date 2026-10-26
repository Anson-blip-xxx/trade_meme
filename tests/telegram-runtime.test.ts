import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync} from 'node:crypto';
import bs58 from 'bs58';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {parseSignal} from '../src/types.js';

const ca='0x'+'a'.repeat(40),wallet='0x'+'b'.repeat(40),native='0x'+'0'.repeat(40);
const botToken='123456:'+ 'A'.repeat(35);
function fixture(extra:Record<string,string>={}) {
  const dir=mkdtempSync(join(tmpdir(),'telegram-runtime-'));
  const config=readConfig({ENTRY_MODE:'off',GMGN_BACKGROUND_RESEARCH_ENABLED:'false',
    DASHBOARD_ENABLED:'true',WATCH_RECHECK_ENABLED:'false',EXIT_SHADOW_ENABLED:'false',
    CHAIN_STREAM_ENABLED:'false',WALLET_RESEARCH_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),
    TELEGRAM_DATABASE_PATH:join(dir,'telegram.sqlite'),TELEGRAM_BOT_TOKEN:botToken,TELEGRAM_CHAT_ID:'123456789',...extra});
  return {dir,config};
}

test('Telegram credential errors never contain supplied secret values and incomplete config does not enable sending',async()=>{
  assert.throws(()=>readConfig({TELEGRAM_BOT_TOKEN:'PRIVATE BAD TOKEN'}),error=>error instanceof Error&&error.message==='TELEGRAM_TOKEN_INVALID');
  assert.throws(()=>readConfig({TELEGRAM_CHAT_ID:'private-wrong-chat'}),error=>error instanceof Error&&error.message==='TELEGRAM_CHAT_ID_INVALID');
  const {dir,config}=fixture({TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:''});
  const runtime=createRuntime(config,{telegramFetcher:async()=>{throw Error('MUST_NOT_SEND');}});
  try {
    assert.equal(runtime.telegram,undefined);
    assert.equal(runtime.telegramStatus().state,'awaiting_configuration');
    assert.equal(runtime.dashboardOverview().entryMode,'off');
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('live order outside the scan archive receives priority prices and durable order notifications; no actual trade is sent',async()=>{
  const {dir,config}=fixture(),messages:string[]=[],queried:string[]=[];
  const runtime=createRuntime(config,{telegramFetcher:async(_url,init)=>{
    messages.push(JSON.parse(String(init?.body)).text);return Response.json({ok:true,result:{message_id:1}});
  }});
  try {
    const created=runtime.orders.reserve({eventKey:'synthetic-test-only',chain:'bsc',tokenAddress:ca,mode:'live',wallet,
      inputToken:native,inputAmount:'1000000000000000',slippagePct:5,details:{}},3).order!;
    runtime.orders.update(created.id,['prepared'],{status:'confirmed',providerOrderId:'synthetic-order',transactionHash:'0x'+'c'.repeat(64)});
    assert.equal(runtime.archive!.list().total,0);
    runtime.priceRouter.read=async(tokens,options)=>{
      queried.push(...tokens.map(token=>token.address));
      const at=new Date().toISOString();
      const samples=tokens.map(token=>({...token,priceUsd:1,observedAt:at,receivedAt:at,validUntil:new Date(Date.now()+30000).toISOString(),
        scope:'observed_spot_not_executable_quote' as const,timeBasis:'http_response' as const,source:'dexscreener_token_pairs_sample'}));
      for(const sample of samples)options?.onSample?.(sample);
      return {samples,gaps:[],requests:{dexscreener:1,gmgn:0,debot:0},sourceErrors:{}};
    };
    const cycle=await runtime.tracking!.runOnce();
    assert.ok(queried.includes(ca));assert.equal(cycle.recorded,1);
    assert.equal(runtime.dashboardOverview().priceCapacity.activeOrderTokens,1);
    assert.ok(runtime.telegram!.status().pending>0);
    await runtime.telegram!.flush();
    assert.equal(messages.length,1);assert.ok(messages[0].includes(ca));
    assert.equal(runtime.dashboardOverview().entryMode,'off');
    const status=JSON.stringify(runtime.telegramStatus());assert.ok(!status.includes(botToken));assert.ok(!status.includes('123456789'));
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('Telegram outbox cannot share the execution database',()=>{
  const {dir,config}=fixture();config.telegram!.database=config.ordersDatabase;
  try{assert.throws(()=>createRuntime(config),/TELEGRAM_DATABASE_CONFLICT/);}
  finally{rmSync(dir,{recursive:true,force:true});}
});

test('notification storage failure does not prevent the trading service from starting',async()=>{
  const {dir,config}=fixture();config.telegram!.database=dir;
  const runtime=createRuntime(config);
  try {
    assert.equal(runtime.telegramStatus().captureError,'TELEGRAM_STORAGE_UNAVAILABLE');
    runtime.tracking!.start=()=>{};
    assert.doesNotThrow(()=>runtime.start());
    assert.equal(runtime.dashboardOverview().entryMode,'off');
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('a failing startup notification cannot stop price tracking',async()=>{
  const {dir,config}=fixture(),runtime=createRuntime(config);
  try {
    let trackingStarted=false;
    runtime.tracking!.start=()=>{trackingStarted=true;};
    runtime.telegram!.enqueue=()=>{throw Error('SYNTHETIC_STORAGE_FAILURE');};
    assert.doesNotThrow(()=>runtime.start());
    assert.equal(trackingStarted,true);
    assert.equal(runtime.telegramStatus().captureError,'TELEGRAM_START_FAILED');
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

type SentMessage={text:string;reply_markup?:{inline_keyboard?:Array<Array<{text:string;callback_data?:string;url?:string}>>}};
function privateMessage(id:number,text:string) {
  return {update_id:id,message:{message_id:id+1,date:Math.floor(Date.now()/1000),text,
    chat:{id:123456789,type:'private'},from:{id:123456789,is_bot:false}}};
}
function privateCallback(id:number,data:string,age=0) {
  return {update_id:id,callback_query:{id:'runtime-callback-'+id,data,from:{id:123456789,is_bot:false},
    message:{message_id:id+1,date:Math.floor(Date.now()/1000)-age,
      chat:{id:123456789,type:'private'},from:{id:123456,is_bot:true}}}};
}
function telegramHarness() {
  let updates:unknown[]=[];const messages:SentMessage[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://api.telegram.org');assert.equal(init?.method,'POST');
    if(url.pathname.endsWith('/getUpdates')){const result=updates;updates=[];return Response.json({ok:true,result});}
    if(url.pathname.endsWith('/answerCallbackQuery'))return Response.json({ok:true,result:true});
    assert.ok(url.pathname.endsWith('/sendMessage'));
    const payload=JSON.parse(String(init?.body));assert.equal(payload.chat_id,'123456789');messages.push(payload);
    return Response.json({ok:true,result:{message_id:messages.length}});
  };
  return {fetcher,messages,supply:(values:unknown[])=>{updates=values;}};
}
async function pollTelegram(runtime:ReturnType<typeof createRuntime>,path:string,harness:ReturnType<typeof telegramHarness>,updates:unknown[]=[]) {
  assert.ok(runtime.telegramControls);assert.ok(runtime.telegram);
  const first=harness.messages.length;harness.supply(updates);
  const db=new DatabaseSync(path);
  try {
    // Reset only this temporary test database's pacing clocks; production defaults stay unchanged.
    db.exec('UPDATE telegram_control_state SET next_poll_at=0');await runtime.telegramControls.pollOnce();
    await runtime.telegramControls.waitForTokenCards();
    for(let sent=0;runtime.telegram.status().pending>0&&sent<100;sent++){
      db.exec("DELETE FROM telegram_meta WHERE key='next_attempt_at'; UPDATE telegram_outbox SET next_at=0 WHERE state='pending'");
      await runtime.telegram.flush();
    }
    assert.equal(runtime.telegram.status().pending,0);
  }finally{db.close();}
  return harness.messages.slice(first);
}

test('runtime TG positions command and pagination callbacks use registered holdings while start/stop remain simulated',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const {dir,config}=fixture({DASHBOARD_ENABLED:'false'}),tg=telegramHarness();
  const runtime=createRuntime(config,{telegramFetcher:tg.fetcher,heldFetcher:async()=>{throw Error('HELD_NETWORK_FORBIDDEN');}});
  try {
    for(let i=1;i<=7;i++){
      const address='0x'+i.toString(16).padStart(40,'0');
      const checkedAt=new Date().toISOString();
      const order=runtime.orders.reserve({eventKey:'paging:'+i,chain:'bsc',tokenAddress:address,mode:'live',wallet,
        inputToken:native,inputAmount:'1000000000000000',slippagePct:5,details:{},
        exit:{policy:{enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:500,sellPct:20},{gainPct:1000,sellPct:10}],
          stopLoss:{dropPct:60,sellPct:100}},state:'monitoring',reasons:[],checkedAt,positionClosed:false,
          assessment:{status:'verified',reasons:[],found:true,policyMatched:true,hasLiveStop:true,terminal:false,conditions:[],checkedAt}}},20).order!;
      assert.ok(order);
      runtime.orders.update(order.id,['prepared'],{status:'confirmed',transactionHash:'0x'+i.toString(16).padStart(64,'0')});
    }
    await pollTelegram(runtime,config.telegram!.database,tg);
    const query=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(1,'持仓查询')]);
    const page1=query.find(m=>m.text.includes('第 1 / 2 页'));assert.ok(page1);assert.match(page1.text,/共 7 个持仓/);
    assert.equal((page1.text.match(/CA：/g)??[]).length,5);
    assert.ok(page1.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='positions:2'));
    const next=await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(2,'positions:2',86400)]);
    const page2=next.find(m=>m.text.includes('第 2 / 2 页'));assert.ok(page2);
    assert.equal((page2.text.match(/CA：/g)??[]).length,2);
    assert.deepEqual(page2.reply_markup?.inline_keyboard?.flat().map(b=>b.callback_data),['positions:1','positions:2']);
    assert.equal(runtime.signalCounting.status().running,false);assert.equal(runtime.manualClose,undefined);
    await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(3,'启动计数')]);
    assert.equal(runtime.signalCounting.status().running,true);assert.equal(runtime.signalCounting.status().mode,'simulation');
    assert.equal(runtime.signalCounting.status().executionEnabled,false);assert.equal(runtime.dashboardHome().entryMode,'off');
    await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(4,'停止计数')]);
    assert.equal(runtime.signalCounting.status().running,false);assert.equal(runtime.orders.list(100).length,7);
    assert.equal(runtime.telegramControls!.status().countingMode,'simulation');
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime TG native test-buy menu binds an exact CA and cancel never creates an order',async t=>{
  const globalNetwork=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const solWallet=bs58.encode(Buffer.alloc(32,91)),mint=bs58.encode(Buffer.alloc(32,92));
  const sol='So11111111111111111111111111111111111111112';
  const {dir,config}=fixture({DASHBOARD_ENABLED:'false',ENTRY_WALLET_SOLANA:solWallet,ENTRY_INPUT_TOKEN_SOLANA:sol,
    SOLANA_RPC_URL:'https://manual-buy-rpc.invalid',SOLANA_EXECUTION_PROVIDER:'pump_native',
    SOLANA_NATIVE_RPC_URL:'https://manual-buy-rpc.invalid',SOLANA_NATIVE_WS_URL:'wss://manual-buy-rpc.invalid'});
  Object.assign(config.nativeSolana!,{keypairFile:join(dir,'missing-test-key.json'),journalPath:join(dir,'native-journal.sqlite'),
    positionsPath:join(dir,'native-positions.sqlite')});
  config.exitPolicy={enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}};
  const tg=telegramHarness(),runtime=createRuntime(config,{telegramFetcher:tg.fetcher,entryFetcher:async()=>{throw Error('TRADE_NETWORK_FORBIDDEN');}});
  try{
    assert.ok(runtime.manualNativeBuy);assert.equal(runtime.telegramControls!.status().manualBuyEnabled,true);
    (runtime.manualNativeBuy as any).options.native.readiness=()=>({ready:true});
    await pollTelegram(runtime,config.telegram!.database,tg);
    const prompt=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(1,'🧪 0.01 SOL 测试买入')]);
    assert.ok(prompt.some(message=>message.text.includes('固定金额：0.01 SOL')));assert.equal(runtime.orders.list().length,0);
    const preview=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(2,`/native_buy ${mint}`)]);
    const message=preview.find(item=>item.text.includes(mint));assert.ok(message);assert.match(message.text,/点击即触发实盘/);
    const buttons=message.reply_markup?.inline_keyboard?.flat()??[];
    const confirm=buttons.find(button=>button.callback_data?.startsWith('nativebuy:confirm:'));
    const cancel=buttons.find(button=>button.callback_data?.startsWith('nativebuy:cancel:'));
    assert.ok(confirm?.callback_data);assert.ok(cancel?.callback_data);assert.equal(confirm.callback_data.split(':')[2],cancel.callback_data.split(':')[2]);
    const canceled=await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(3,cancel.callback_data)]);
    assert.ok(canceled.some(item=>item.text.includes('已取消，没有发送交易')));assert.equal(runtime.orders.list().length,0);
    assert.equal(globalNetwork.mock.callCount(),0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime TG contract card shows GMGN details and routes only an explicit buy click to the manual card executor',async t=>{
  const globalNetwork=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const solWallet=bs58.encode(Buffer.alloc(32,101)),mint=bs58.encode(Buffer.alloc(32,102));
  const pool=bs58.encode(Buffer.alloc(32,103)),quote=bs58.encode(Buffer.alloc(32,104));
  const holder=(value:number)=>bs58.encode(Buffer.alloc(32,value));
  const sol='So11111111111111111111111111111111111111112';
  const {dir,config}=fixture({DASHBOARD_ENABLED:'false',GMGN_API_KEY:'synthetic-card-key',GMGN_MIN_INTERVAL_MS:'100',
    ENTRY_WALLET_SOLANA:solWallet,ENTRY_INPUT_TOKEN_SOLANA:sol,SOLANA_RPC_URL:'https://card-rpc.invalid',
    SOLANA_EXECUTION_PROVIDER:'pump_native',SOLANA_NATIVE_RPC_URL:'https://card-rpc.invalid',SOLANA_NATIVE_WS_URL:'wss://card-rpc.invalid'});
  Object.assign(config.nativeSolana!,{keypairFile:join(dir,'missing-card-key.json'),journalPath:join(dir,'native-card-journal.sqlite'),
    positionsPath:join(dir,'native-card-positions.sqlite')});
  config.exitPolicy={enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}};
  const tg=telegramHarness(),gmgnPaths:string[]=[],rpcMethods:string[]=[];
  const gmgnFetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://openapi.gmgn.ai');assert.equal(init?.method,'GET');
    assert.equal(url.searchParams.get('address'),mint);gmgnPaths.push(url.pathname);
    const created=Math.floor(Date.now()/1000)-60;
    const data=url.pathname==='/v1/token/info'?{address:mint,chain:'sol',name:'Contract Card',symbol:'CARD',decimals:6,
      circulating_supply:'1000000000',holder_count:88,creation_timestamp:created,launchpad:'pump',launchpad_status:2,
      launchpad_progress:'1',price:{address:mint,chain:'sol',price:'0.0000123'},biggest_pool_address:pool,
      pool:{base_address:mint,pool_address:pool,quote_address:quote,quote_symbol:'WSOL',exchange:'pump_amm',
        base_reserve_value:'6000',quote_reserve_value:'6000'},
      stat:{top_10_holder_rate:'0.2',top_bundler_trader_percentage:'0.04',top_rat_trader_percentage:'0.01'}}:
      url.pathname==='/v1/token/security'?{address:mint,chain:'sol',renounced_mint:true,renounced_freeze_account:true,
        burn_status:'burn',burn_ratio:'1'}:
      url.searchParams.get('tag')==='bundler'?{list:[{address:holder(120),amount_percentage:'0.04',balance:'100',amount_cur:'100',
        maker_token_tags:['bundler'],addr_type:0}]}:
      url.searchParams.get('tag')==='rat_trader'?{list:[{address:holder(121),amount_percentage:'0.01',balance:'100',amount_cur:'100',
        maker_token_tags:['rat_trader'],addr_type:0}]}:
      {list:[{address:pool,amount_percentage:'0.7',balance:'700',amount_cur:'700',addr_type:2},
        ...['0.05','0.04','0.03','0.02','0.01'].map((amount,index)=>({address:holder(110+index),amount_percentage:amount,
          balance:'100',amount_cur:'100',addr_type:0}))]};
    return Response.json({code:0,data});
  };
  const entryFetcher:typeof fetch=async(_input,init)=>{
    const payload=JSON.parse(String(init?.body));rpcMethods.push(payload.method);
    const result=payload.method==='getGenesisHash'?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':
      payload.method==='getBalance'?{context:{slot:123},value:5_350_000_000}:null;
    return Response.json({jsonrpc:'2.0',id:payload.id,result});
  };
  const runtime=createRuntime(config,{telegramFetcher:tg.fetcher,gmgnFetcher,entryFetcher});
  try{
    assert.ok(runtime.telegramTokenCard);assert.ok(runtime.manualNativeBuy);
    await pollTelegram(runtime,config.telegram!.database,tg);
    const response=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(1,mint)]);
    const card=response.find(message=>message.text.includes('Contract Card'));assert.ok(card);
    assert.match(card.text,/SOL 余额：5\.35 SOL/);assert.match(card.text,/估算市值：\$12\.3K/);
    assert.match(card.text,/池子储备：\$12K/);assert.match(card.text,/Top5 钱包持仓：5\.00% · 4\.00% · 3\.00% · 2\.00% · 1\.00%/);
    const cardButtons=card.reply_markup?.inline_keyboard?.flat()??[];
    const expectedCardButtons=['a','b','c','d','e'].map(code=>`token:buy:${code}:${mint}`)
      .concat([`token:custom:${mint}`,`token:refresh:${mint}`]);
    const expectedLinks=[`https://gmgn.ai/sol/token/${mint}`,`https://dexscreener.com/solana/${mint}`,`https://solscan.io/token/${mint}`];
    assert.deepEqual(cardButtons.flatMap(button=>button.callback_data??[]),expectedCardButtons);
    assert.deepEqual(cardButtons.flatMap(button=>button.url??[]),expectedLinks);
    assert.equal(cardButtons.some(button=>button.callback_data?.startsWith('sell:')),false);
    assert.deepEqual(card.reply_markup?.inline_keyboard?.map(row=>row.map(button=>button.text)),[
      ['🟣 0.1','🟣 0.5','🟣 1'],['🟣 3','🟣 5','✏️ 自定义'],['GMGN','Dex','Solscan'],['🔄 刷新详情']]);
    assert.doesNotMatch(card.text,/买入状态|开仓状态|点击金额按钮|本币持仓|持仓盈亏/);assert.equal(runtime.orders.list().length,0);
    const actionCount=()=>{const db=new DatabaseSync(config.telegram!.database+'.manual-native-buy.sqlite',{readOnly:true});
      try{return Number(db.prepare('SELECT count(*) n FROM manual_native_buy_actions').get()?.n??-1);}finally{db.close();}};
    assert.equal(actionCount(),0);
    assert.deepEqual(gmgnPaths,['/v1/token/info','/v1/token/security','/v1/market/token_top_holders']);
    assert.deepEqual(rpcMethods,['getGenesisHash','getBalance']);
    const cardBuys:Array<{mint:string;owner:string;amountLamports:string}>=[];
    t.mock.method(runtime.manualNativeBuy!,'triggerCard',(input:{mint:string;owner:string;scope:string;amountLamports:string})=>{
      cardBuys.push({mint:input.mint,owner:input.owner,amountLamports:input.amountLamports});const at=new Date().toISOString();
      return {status:'accepted' as const,action:{ref:'a'.repeat(32),scope:input.scope,owner:input.owner,mint:input.mint,
        amountLamports:input.amountLamports,state:'executing' as const,mode:'card_direct' as const,createdAt:at,updatedAt:at,expiresAt:at}};
    });
    const presetCodes=['a','b','c','d','e'] as const;
    const bought=await pollTelegram(runtime,config.telegram!.database,tg,presetCodes.map((code,index)=>
      privateCallback(2+index,`token:buy:${code}:${mint}`,86400)));
    assert.deepEqual(cardBuys,presetCodes.map((_,index)=>({mint,owner:config.telegram!.chatId!,
      amountLamports:['100000000','500000000','1000000000','3000000000','5000000000'][index]})));
    assert.equal(bought.filter(message=>message.text.includes('买入已接收')).length,5);assert.equal(runtime.orders.list().length,0);
    const at=new Date().toISOString(),customRef='b'.repeat(32);let submittedCustom:string|undefined;
    t.mock.method(runtime.manualNativeBuy!,'beginCardCustom',(input:{mint:string;owner:string;scope:string})=>
      ({status:'created' as const,action:{ref:customRef,scope:input.scope,owner:input.owner,mint:input.mint,
        state:'awaiting_amount' as const,mode:'card_direct' as const,createdAt:at,updatedAt:at,expiresAt:at}}));
    t.mock.method(runtime.manualNativeBuy!,'submitCardCustom',(input:{owner:string;scope:string;amountLamports:string})=>{
      submittedCustom=input.amountLamports;return {status:'accepted' as const,action:{ref:customRef,scope:input.scope,owner:input.owner,mint,
        amountLamports:input.amountLamports,state:'executing' as const,mode:'card_direct' as const,createdAt:at,updatedAt:at,expiresAt:at}};
    });
    const customPrompt=await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(7,`token:custom:${mint}`,86400)]);
    assert.ok(customPrompt.some(message=>message.text.includes('请在 5 分钟内直接发送 SOL 数量')));
    assert.ok(customPrompt.some(message=>message.reply_markup?.inline_keyboard?.flat()
      .some(button=>button.callback_data===`nativebuy:cancel:${customRef}`)));
    const customBuy=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(8,'0.25')]);
    assert.equal(submittedCustom,'250000000');assert.ok(customBuy.some(message=>
      message.text.includes('买入已接收')&&message.text.includes('0.25 SOL')));
    const refreshed=await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(9,`token:refresh:${mint}`,86400)]);
    const refreshedCard=refreshed.find(message=>message.text.includes('Contract Card'));assert.ok(refreshedCard);assert.equal(gmgnPaths.length,6);
    assert.deepEqual(refreshedCard.reply_markup?.inline_keyboard?.flat().flatMap(button=>button.callback_data??[]),expectedCardButtons);
    assert.deepEqual(refreshedCard.reply_markup?.inline_keyboard?.flat().flatMap(button=>button.url??[]),expectedLinks);
    assert.doesNotMatch(refreshedCard.text,/本币持仓|持仓盈亏/);
    assert.equal(runtime.orders.list().length,0);assert.equal(actionCount(),0);assert.equal(globalNetwork.mock.callCount(),0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime refreshes native holding PnL and keeps direct sell controls on the token card',async t=>{
  const globalNetwork=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const solWallet=bs58.encode(Buffer.alloc(32,108)),mint=bs58.encode(Buffer.alloc(32,109));
  const {dir,config}=fixture({DASHBOARD_ENABLED:'false',ENTRY_WALLET_SOLANA:solWallet});
  const tg=telegramHarness(),runtime=createRuntime(config,{telegramFetcher:tg.fetcher,
    heldFetcher:async()=>{throw Error('HELD_NETWORK_FORBIDDEN');}});
  try{
    assert.ok(runtime.telegramTokenCard);
    const reads:Array<{address:string;refresh:boolean}>=[];let capability=0;
    t.mock.method(runtime.telegramTokenCard,'get',async(address:string,refresh=false)=>{
      reads.push({address,refresh});return {address,gmgnAvailable:true,partial:false,
        text:`【合约详情】Native Card · Solana\nCA：${address}\n\n💼 账户\n本币持仓：123.45 NATIVE ｜ 持仓盈亏：${refresh?'+19.14%':'+12.50%'}`};
    });
    t.mock.method(runtime.telegramPositions,'findSellableSolanaMint',(address:string)=>address===mint?{
      id:'native-active',chain:'solana' as const,wallet:solWallet,address,name:'Native Card',symbol:'NATIVE',
      quantityAtomic:'123450000',tokenDecimals:6,canClose:true,sellActionRef:`np${String(++capability).padStart(30,'0')}`,
    }:undefined);
    await pollTelegram(runtime,config.telegram!.database,tg);

    const opened=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(1,mint)]);
    const initial=opened.find(message=>message.text.includes('Native Card'));assert.ok(initial);
    assert.match(initial.text,/持仓盈亏：\+12\.50%/);
    const initialSell=initial.reply_markup?.inline_keyboard?.find(row=>row.some(button=>button.callback_data?.startsWith('sell:')));
    assert.ok(initialSell);assert.deepEqual(initialSell.map(button=>button.text),['🔴 卖30%','🔴 卖50%','🔴 卖100%','🔴 卖X%']);
    assert.ok(initialSell.every(button=>/^sell:(?:30|50|100|custom):np[0-9a-f]{30}$/.test(button.callback_data!)));

    const refreshed=await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(2,`token:refresh:${mint}`,86400)]);
    const updated=refreshed.find(message=>message.text.includes('Native Card'));assert.ok(updated);
    assert.match(updated.text,/持仓盈亏：\+19\.14%/);
    const updatedSell=updated.reply_markup?.inline_keyboard?.find(row=>row.some(button=>button.callback_data?.startsWith('sell:')));
    assert.ok(updatedSell);assert.deepEqual(updatedSell.map(button=>button.text),['🔴 卖30%','🔴 卖50%','🔴 卖100%','🔴 卖X%']);
    assert.notEqual(updatedSell[0].callback_data,initialSell[0].callback_data);
    assert.deepEqual(reads,[{address:mint,refresh:false},{address:mint,refresh:true}]);
    assert.equal(globalNetwork.mock.callCount(),0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime TG contract card keeps manual buy available when GMGN display data is unavailable or partial',async t=>{
  const globalNetwork=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const solWallet=bs58.encode(Buffer.alloc(32,106)),mint=bs58.encode(Buffer.alloc(32,107));
  const sol='So11111111111111111111111111111111111111112';
  const {dir,config}=fixture({DASHBOARD_ENABLED:'false',GMGN_API_KEY:'synthetic-card-fallback-key',
    ENTRY_WALLET_SOLANA:solWallet,ENTRY_INPUT_TOKEN_SOLANA:sol,SOLANA_RPC_URL:'https://card-fallback-rpc.invalid',
    SOLANA_EXECUTION_PROVIDER:'pump_native',SOLANA_NATIVE_RPC_URL:'https://card-fallback-rpc.invalid',
    SOLANA_NATIVE_WS_URL:'wss://card-fallback-rpc.invalid'});
  Object.assign(config.nativeSolana!,{keypairFile:join(dir,'missing-card-fallback-key.json'),
    journalPath:join(dir,'native-card-fallback-journal.sqlite'),positionsPath:join(dir,'native-card-fallback-positions.sqlite')});
  config.exitPolicy={enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}};
  const tg=telegramHarness();
  const runtime=createRuntime(config,{telegramFetcher:tg.fetcher,entryFetcher:async()=>{throw Error('RPC_UNAVAILABLE');},
    gmgnFetcher:async()=>{throw Error('DISPLAY_GMGN_UNAVAILABLE');}});
  try{
    assert.ok(runtime.telegramTokenCard);assert.ok(runtime.manualNativeBuy);
    let partial=false;
    t.mock.method(runtime.telegramTokenCard,'get',async(address:string)=>({address,
      text:partial?'【合约详情】Partial Card · Solana':'【合约详情】Solana\nGMGN 数据：暂不可用',
      gmgnAvailable:partial,partial:true}));
    await pollTelegram(runtime,config.telegram!.database,tg);

    const unavailable=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(1,mint)]);
    const unavailableCard=unavailable.find(message=>message.text.includes('GMGN 数据：暂不可用'));assert.ok(unavailableCard);
    const expectedCardButtons=['a','b','c','d','e'].map(code=>`token:buy:${code}:${mint}`)
      .concat([`token:custom:${mint}`,`token:refresh:${mint}`]);
    const expectedLinks=[`https://gmgn.ai/sol/token/${mint}`,`https://dexscreener.com/solana/${mint}`,`https://solscan.io/token/${mint}`];
    assert.deepEqual(unavailableCard.reply_markup?.inline_keyboard?.flat().flatMap(button=>button.callback_data??[]),expectedCardButtons);
    assert.deepEqual(unavailableCard.reply_markup?.inline_keyboard?.flat().flatMap(button=>button.url??[]),expectedLinks);
    assert.equal(unavailableCard.reply_markup?.inline_keyboard?.flat()
      .some(button=>button.callback_data?.startsWith('sell:')),false);
    assert.doesNotMatch(unavailableCard.text,/买入|开仓|活跃持仓|本币持仓|持仓盈亏/);
    assert.equal(runtime.orders.list().length,0);

    partial=true;
    const refreshed=await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(2,`token:refresh:${mint}`,86400)]);
    const partialCard=refreshed.find(message=>message.text.includes('Partial Card'));assert.ok(partialCard);
    assert.deepEqual(partialCard.reply_markup?.inline_keyboard?.flat().flatMap(button=>button.callback_data??[]),expectedCardButtons);
    assert.deepEqual(partialCard.reply_markup?.inline_keyboard?.flat().flatMap(button=>button.url??[]),expectedLinks);
    assert.equal(partialCard.reply_markup?.inline_keyboard?.flat()
      .some(button=>button.callback_data?.startsWith('sell:')),false);
    assert.doesNotMatch(partialCard.text,/买入|开仓|活跃持仓|本币持仓|持仓盈亏/);
    assert.equal(runtime.orders.list().length,0);
    assert.equal(globalNetwork.mock.callCount(),0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime owner selects any of four sell percentages in one click; holdings, status and legacy buttons never submit sells',async t=>{
  const globalNetwork=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const solWallet=bs58.encode(new Uint8Array(32).fill(41)),mint=bs58.encode(new Uint8Array(32).fill(42));
  const signature=bs58.encode(new Uint8Array(64).fill(43)),sol='So11111111111111111111111111111111111111112';
  const pem=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const {dir,config}=fixture({DASHBOARD_ENABLED:'false',GMGN_API_KEY:'synthetic-test-key',GMGN_PRIVATE_KEY:pem,
    ENTRY_WALLET_SOLANA:solWallet,SOLANA_RPC_URL:'https://synthetic-rpc.invalid'});
  const tg=telegramHarness(),networkRequests:string[]=[];
  const runtime=createRuntime(config,{telegramFetcher:tg.fetcher,heldFetcher:async(input)=>{
    networkRequests.push(String(input));throw Error('FINANCIAL_NETWORK_FORBIDDEN');
  }});
  try {
    assert.ok(runtime.directSell);assert.ok(runtime.heldMonitor);assert.ok(runtime.heldTracking);
    const order=runtime.orders.reserve({eventKey:'manual-wiring',chain:'solana',tokenAddress:mint,mode:'live',wallet:solWallet,
      inputToken:sol,inputAmount:'10000000',slippagePct:1,details:{}},3).order!;
    assert.ok(order);runtime.orders.update(order.id,['prepared'],{status:'confirmed',transactionHash:signature,outputAmount:'1000000'});
    // The integration test exercises startup routing without starting unrelated price/RPC observers.
    t.mock.method(runtime.heldMonitor,'start',()=>{});t.mock.method(runtime.heldTracking,'start',()=>{});
    runtime.start();runtime.telegram!.stop();await runtime.telegramControls!.stop();
    await pollTelegram(runtime,config.telegram!.database,tg);
    assert.equal(networkRequests.length,0);assert.equal(runtime.directSell.status().requests.length,0);
    assert.equal(runtime.telegramControls!.status().manualCloseEnabled,true);
    const routed:Array<{ref:string;pct:number}>=[];
    const submit=t.mock.method(runtime.directSell,'submit',async(ref:string,pct:number)=>{
      routed.push({ref,pct});return {text:`【持仓卖出】\n已接受卖出 ${pct}% 的请求。`,state:'accepted'};
    });
    const legacyPreview=runtime.manualClose?t.mock.method(runtime.manualClose,'preview',async()=>{throw Error('LEGACY_PREVIEW_FORBIDDEN');}):undefined;
    const legacyConfirm=runtime.manualClose?t.mock.method(runtime.manualClose,'confirm',async()=>{throw Error('LEGACY_CONFIRM_FORBIDDEN');}):undefined;
    assert.ok(runtime.telegramTokenCard);
    t.mock.method(runtime.telegramTokenCard,'get',async(address:string)=>({address,
      text:`【合约详情】Solana\nCA：${address}\n\n⚠️ GMGN 详情暂未返回`,gmgnAvailable:false,partial:true}));

    // A display-data failure must not hide owner-operated exits for a uniquely
    // registered real holding. All four buttons share one server capability;
    // the first accepted percentage consumes it in production.
    const cardReply=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(1,mint)]);
    const card=cardReply.find(message=>message.text.includes('GMGN 详情暂未返回'));assert.ok(card);
    const sellRow=card.reply_markup?.inline_keyboard?.find(row=>row.some(button=>button.callback_data?.startsWith('sell:')));
    assert.ok(sellRow);assert.deepEqual(sellRow.map(button=>button.text),['🔴 卖30%','🔴 卖50%','🔴 卖100%','🔴 卖X%']);
    assert.deepEqual(sellRow.map(button=>button.callback_data?.split(':').slice(0,2).join(':')),
      ['sell:30','sell:50','sell:100','sell:custom']);
    const cardRefs=sellRow.map(button=>button.callback_data!.split(':')[2]);
    assert.equal(new Set(cardRefs).size,1);assert.match(cardRefs[0],/^(?:[0-9a-f]{32}|np[0-9a-f]{30})$/);
    assert.ok(sellRow.every(button=>Buffer.byteLength(button.callback_data!)<=64));
    const thirty=sellRow[0].callback_data!;
    await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(2,thirty,86400),privateCallback(2,thirty,86400)]);
    assert.deepEqual(routed,[{ref:cardRefs[0],pct:30}]);assert.equal(submit.mock.callCount(),1);

    // Refreshing produces a new capability for a later action. Custom input is
    // an exact percent token, keeping it disjoint from custom SOL buy amounts.
    const refreshedCardReply=await pollTelegram(runtime,config.telegram!.database,tg,
      [privateCallback(3,`token:refresh:${mint}`,86400)]);
    const refreshedCard=refreshedCardReply.find(message=>message.text.includes('GMGN 详情暂未返回'));assert.ok(refreshedCard);
    const custom=refreshedCard.reply_markup?.inline_keyboard?.flat()
      .find(button=>button.callback_data?.startsWith('sell:custom:'));assert.ok(custom?.callback_data);
    const customRef=custom.callback_data.split(':')[2];assert.notEqual(customRef,cardRefs[0]);
    const customPrompt=await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(4,custom.callback_data,86400)]);
    assert.ok(customPrompt.some(message=>/卡片卖出/.test(message.text)&&/1%-100%/.test(message.text)));
    assert.equal(submit.mock.callCount(),1);
    const customResult=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(5,'37%')]);
    assert.deepEqual(routed.at(-1),{ref:customRef,pct:37});assert.equal(submit.mock.callCount(),2);
    assert.ok(customResult.some(message=>message.text.includes('卖出 37%')));
    await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(5,'37%')]);assert.equal(submit.mock.callCount(),2);

    const queried=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(6,'/positions')]);
    const page=queried.find(m=>m.text.includes('第 1 / 1 页'));assert.ok(page);
    const firstButtons=page.reply_markup?.inline_keyboard?.flat().filter(b=>b.callback_data?.startsWith('sell:'))??[];
    assert.equal(firstButtons.length,4);
    assert.deepEqual(firstButtons.map(b=>Number(b.callback_data!.split(':')[1])),[25,50,75,100]);
    assert.equal(new Set(firstButtons.map(b=>b.callback_data!.split(':')[2])).size,1);
    assert.ok(firstButtons.every(b=>/^sell:(25|50|75|100):[0-9a-f]{32}$/.test(b.callback_data!)));
    assert.match(page.text,/点击即卖出/);assert.match(page.text,/无需再次确认/);
    assert.equal(submit.mock.callCount(),2);assert.equal(networkRequests.length,0);
    const state=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(7,'状态'),privateCallback(8,'count:status',86400)]);
    assert.equal(state.length,2);assert.equal(submit.mock.callCount(),2);
    const oldRef='f'.repeat(32),oldToken='66d3b567-b6b9-4444-b7f9-33044ae4ccef';
    const oldReplies=await pollTelegram(runtime,config.telegram!.database,tg,[
      privateCallback(9,`close:preview:${oldRef}`,86400),privateCallback(10,`close:confirm:${oldToken}`),privateCallback(11,`close:cancel:${oldToken}`),
    ]);
    assert.equal(oldReplies.length,3);assert.ok(oldReplies.every(m=>/刷新/.test(m.text)));
    assert.equal(submit.mock.callCount(),2);assert.equal(legacyPreview?.mock.callCount()??0,0);assert.equal(legacyConfirm?.mock.callCount()??0,0);

    // Runtime routing is isolated here; direct-sell tests cover atomic rounding,
    // action consumption, write-ahead submission and read-only recovery.
    let nextId=20;
    for(const pct of [25,50,75,100] as const){
      const refreshed=await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(nextId++,'positions:1',86400)]);
      const choice=refreshed.flatMap(m=>m.reply_markup?.inline_keyboard?.flat()??[])
        .find(b=>b.callback_data?.startsWith(`sell:${pct}:`));assert.ok(choice?.callback_data);
      const ref=choice.callback_data.split(':')[2];assert.notEqual(ref,firstButtons[0].callback_data!.split(':')[2]);
      const selected=privateCallback(nextId++,choice.callback_data,86400);
      const replies=await pollTelegram(runtime,config.telegram!.database,tg,[selected,selected]);
      assert.deepEqual(routed.at(-1),{ref,pct});assert.ok(replies.some(m=>m.text.includes(`卖出 ${pct}%`)));
      assert.ok(replies.every(m=>!m.text.includes('确认平仓')));
      assert.ok(replies.every(m=>!m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data?.startsWith('close:confirm:'))));
      const calls=submit.mock.callCount();await pollTelegram(runtime,config.telegram!.database,tg,[selected]);assert.equal(submit.mock.callCount(),calls);
    }
    assert.deepEqual(routed.map(r=>r.pct),[30,37,25,50,75,100]);assert.equal(submit.mock.callCount(),6);
    assert.equal(networkRequests.length,0);assert.equal(globalNetwork.mock.callCount(),0);
    assert.equal(runtime.dashboardHome().entryMode,'off');assert.equal(runtime.signalCounting.status().executionEnabled,false);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('TG pending sell stays explicit through lookup failure, blocks duplicate sizes, recovers exact fills and restores sell buttons',async t=>{
  const globalNetwork=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
  const solWallet=bs58.encode(Buffer.alloc(32,81)),mint=bs58.encode(Buffer.alloc(32,82)),tokenAccount=bs58.encode(Buffer.alloc(32,83));
  const openingHash=bs58.encode(Buffer.alloc(64,84)),sol='So11111111111111111111111111111111111111112';
  const spl='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',system='11111111111111111111111111111111';
  const pem=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const {dir,config}=fixture({DASHBOARD_ENABLED:'false',GMGN_API_KEY:'synthetic-direct-sell-key',GMGN_PRIVATE_KEY:pem,
    ENTRY_WALLET_SOLANA:solWallet,SOLANA_RPC_URL:'https://sell-runtime-rpc.invalid',ENTRY_SLIPPAGE_PCT:'5'});
  const tg=telegramHarness(),requests:string[]=[];
  const sales:Array<{amount:string;before:string;after:string;signature:string;slot:number}>=[];
  let balance='9007199254740993',reconciliationReady=false;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));requests.push(url.origin==='https://openapi.gmgn.ai'?`${init?.method} ${url.pathname}`:'rpc');
    if(url.origin==='https://sell-runtime-rpc.invalid'){
      const rpc=JSON.parse(String(init?.body)),slot=100+sales.length;
      const balanceEntry=(amount:string)=>({accountIndex:1,mint,owner:solWallet,programId:spl,uiTokenAmount:{amount,decimals:6}});
      let result:unknown;
      switch(rpc.method){
        case 'getGenesisHash':result='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';break;
        case 'getMultipleAccounts':
          assert.deepEqual(rpc.params[0],[solWallet,mint]);
          result={context:{slot},value:[{owner:system,executable:false,lamports:1000000000},
            {owner:spl,executable:false,data:{parsed:{type:'mint',info:{isInitialized:true,decimals:6,
              supply:'18446744073709551615',mintAuthority:null,freezeAuthority:null}}}}]};break;
        case 'getTokenAccountsByOwner':
          assert.equal(rpc.params[0],solWallet);assert.deepEqual(rpc.params[1],{mint});
          result={context:{slot},value:[{pubkey:tokenAccount,account:{owner:spl,executable:false,data:{parsed:{type:'account',info:{
            owner:solWallet,mint,state:'initialized',tokenAmount:{amount:balance,decimals:6}}}}}}]};break;
        case 'getSignatureStatuses':{
          if(!reconciliationReady)return Response.json({jsonrpc:'2.0',id:rpc.id,error:{code:-32005,message:'SYNTHETIC_RPC_BUSY'}},{status:503});
          const sale=sales.find(s=>s.signature===rpc.params[0][0]);assert.ok(sale);
          result={context:{slot},value:[{slot:sale.slot,err:null,confirmationStatus:'finalized',status:{Ok:null}}]};break;
        }
        case 'getTransaction':{
          const sale=sales.find(s=>s.signature===rpc.params[0]);assert.ok(sale);
          result={slot:sale.slot,transaction:{signatures:[sale.signature],message:{accountKeys:[
            {pubkey:solWallet,signer:true,writable:true},{pubkey:tokenAccount,signer:false,writable:true}]}},
            meta:{err:null,fee:5000,preBalances:[1000000000,2039280],postBalances:[1009995000,2039280],
              preTokenBalances:[balanceEntry(sale.before)],postTokenBalances:[balanceEntry(sale.after)]}};break;
        }
        default:assert.fail('Unexpected RPC method');
      }
      return Response.json({jsonrpc:'2.0',id:rpc.id,result});
    }
    assert.equal(url.origin,'https://openapi.gmgn.ai');
    if(url.pathname==='/v1/trade/quote'){
      assert.equal(init?.method,'GET');assert.equal(url.searchParams.get('input_token'),mint);
      assert.equal(url.searchParams.get('output_token'),sol);
      return Response.json({code:0,data:{input_token:mint,output_token:sol,input_amount:url.searchParams.get('input_amount'),
        output_amount:'10000000',min_output_amount:'9500000',slippage:5}});
    }
    if(url.pathname==='/v1/trade/swap'){
      assert.equal(init?.method,'POST');const body=JSON.parse(String(init?.body));
      assert.equal(body.from_address,solWallet);assert.equal(body.input_token,mint);assert.equal(body.output_token,sol);
      assert.equal(body.condition_orders,undefined);assert.equal(body.sell_ratio_type,undefined);
      const before=balance;balance=(BigInt(balance)-BigInt(body.input_amount)).toString();
      sales.push({amount:body.input_amount,before,after:balance,signature:bs58.encode(Buffer.alloc(64,85+sales.length)),slot:101+sales.length});
      return Response.json({code:0,data:{order_id:'runtime-sale-'+sales.length,status:'submitted',hash:sales.at(-1)!.signature}});
    }
    assert.equal(url.pathname,'/v1/trade/query_order','Direct sells must never query/cancel protection orders');
    assert.equal(init?.method,'GET');const orderId=url.searchParams.get('order_id')!,sale=sales[Number(orderId.split('-').at(-1))-1];assert.ok(sale);
    if(!reconciliationReady)return Response.json({code:503,data:null},{status:503});
    return Response.json({code:0,data:{order_id:orderId,status:'successful',state:30,hash:sale.signature,
      report:{input_token:mint,output_token:sol,input_amount:sale.amount,output_amount:'10000000',input_token_decimals:6,output_token_decimals:9}}});
  };
  const runtime=createRuntime(config,{telegramFetcher:tg.fetcher,heldFetcher:fetcher});
  try {
    assert.ok(runtime.directSell);
    const filledAt=new Date().toISOString(),openingAmount=balance;
    const order=runtime.orders.reserve({eventKey:'direct-exact-units',chain:'solana',tokenAddress:mint,mode:'live',wallet:solWallet,
      inputToken:sol,inputAmount:'10000000',slippagePct:5,
      details:{name:'Exact Units',executionStrategy:'third_signal_v1',tokenDecimals:6,thirdSignalFill:{
        source:'solana_finalized',transactionHash:openingHash,wallet:solWallet,tokenAddress:mint,inputAmount:'10000000',
        outputAmount:openingAmount,tokenDecimals:6,buySlot:99,confirmedAt:filledAt,observedAt:filledAt}},
      exit:{policy:{enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}},
        state:'attention',reasons:['EXIT_STRATEGY_ID_MISSING'],checkedAt:filledAt,positionClosed:false}},3).order!;
    assert.ok(order);runtime.orders.update(order.id,['prepared'],{status:'confirmed',providerOrderId:'opening-exact-units',
      transactionHash:openingHash,actualInputAmount:'10000000',outputAmount:openingAmount});
    assert.deepEqual(runtime.orders.activePositions().map(p=>p.id),[order.id]);
    assert.deepEqual(runtime.orders.pending().map(p=>p.id),[order.id]);
    assert.equal(runtime.orders.hasAttemptedOpening('solana',mint),true);
    await pollTelegram(runtime,config.telegram!.database,tg);
    const firstPage=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(1,'持仓')]);
    const choices=firstPage.flatMap(m=>m.reply_markup?.inline_keyboard?.flat()??[]).filter(b=>b.callback_data?.startsWith('sell:'));
    assert.equal(choices.length,4);assert.equal(requests.length,0);assert.equal(sales.length,0);
    await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(2,choices[0].callback_data!,86400)]);
    await runtime.directSell.waitForPending();
    assert.equal(sales.length,1);assert.equal(sales[0].amount,'2251799813685248');assert.equal(balance,'6755399441055745');
    assert.equal(runtime.directSell.status().requests[0].state,'pending');
    assert.equal(runtime.directSell.status().requests[0].percentage,25);
    assert.deepEqual(runtime.orders.activePositions().map(p=>p.id),[order.id]);
    assert.deepEqual(runtime.orders.pending().map(p=>p.id),[order.id]);
    assert.equal(runtime.orders.get(order.id)!.details.authoritativeClose,undefined);
    const waiting=await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(3,'positions:1',86400)]);
    const waitingPage=waiting.find(m=>m.text.includes('持仓查询'));assert.ok(waitingPage);
    assert.match(waitingPage.text,/25%卖出已提交待确认/);assert.doesNotMatch(waitingPage.text,/卖出失败|未提交卖单/);
    assert.equal(waitingPage.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data?.startsWith('sell:')),false);
    assert.equal(tg.messages.some(m=>m.text.includes('卖出已成交')),false);
    // The user can still click a different size on an older message. It must
    // explain that the existing 25% sale is pending and no 50% sale was sent.
    const fifty=choices.find(b=>b.callback_data?.startsWith('sell:50:'));assert.ok(fifty?.callback_data);
    const fiftyClick=privateCallback(4,fifty.callback_data,86400);
    const blocked=await pollTelegram(runtime,config.telegram!.database,tg,[fiftyClick]);
    assert.ok(blocked.some(m=>/本次\s*50%\s*未提交/.test(m.text)&&/25%/.test(m.text)));
    await runtime.directSell.waitForPending();assert.equal(sales.length,1);
    assert.equal(requests.filter(p=>p==='POST /v1/trade/swap').length,1);
    assert.equal(runtime.directSell.status().requests.length,1);
    reconciliationReady=true;await runtime.directSell.resume();
    assert.equal(runtime.directSell.status().requests[0].state,'completed');assert.equal(sales.length,1);
    const recovered=await pollTelegram(runtime,config.telegram!.database,tg);
    const filled=recovered.find(m=>m.text.includes('卖出已成交'));assert.ok(filled);
    assert.ok(filled.reply_markup?.inline_keyboard?.flat().some(b=>b.text==='查看最新持仓 / 卖出状态'&&b.callback_data==='positions:1'));
    // Another percentage on the same row refers to the consumed action, even as a new Telegram update.
    await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(5,choices[3].callback_data!)]);
    await runtime.directSell.waitForPending();assert.equal(sales.length,1);
    const refreshed=await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(6,'positions:1',86400)]);
    const restoredChoices=refreshed.flatMap(m=>m.reply_markup?.inline_keyboard?.flat()??[]).filter(b=>b.callback_data?.startsWith('sell:'));
    assert.equal(restoredChoices.length,4);
    const all=restoredChoices.find(b=>b.callback_data?.startsWith('sell:100:'));assert.ok(all?.callback_data);
    assert.notEqual(all.callback_data,choices[3].callback_data);
    await pollTelegram(runtime,config.telegram!.database,tg,[privateCallback(7,all.callback_data)]);await runtime.directSell.waitForPending();
    assert.equal(sales.length,2);assert.equal(sales[1].amount,'6755399441055745');assert.equal(balance,'0');assert.equal(runtime.directSell.isClosed(order.id),true);
    // The completion event must release the order's active/reconciliation slots
    // immediately, without waiting for a periodic observer or a protection API.
    assert.equal(runtime.orders.activePositions().length,0);assert.equal(runtime.orders.pending().length,0);
    const closed=runtime.orders.get(order.id)!,authority=closed.details.authoritativeClose as Record<string,unknown>;
    assert.ok(authority);assert.equal(authority.kind,'direct_sell');assert.equal(authority.percentage,100);
    assert.equal(authority.amount,sales[1].amount);assert.equal(authority.positionId,order.id);
    assert.equal(closed.status,'confirmed');assert.equal(closed.transactionHash,openingHash);
    assert.equal(closed.actualInputAmount,'10000000');assert.equal(closed.outputAmount,openingAmount);
    assert.equal(closed.exit?.positionClosed,false);assert.equal(closed.exit?.assessment,undefined);
    assert.equal(runtime.orders.hasAttemptedOpening('solana',mint),true);
    const reopen=runtime.orders.reserve({eventKey:'direct-exact-units-reentry',chain:'solana',tokenAddress:mint,mode:'live',wallet:solWallet,
      inputToken:sol,inputAmount:'10000000',slippagePct:5,details:{}},3);
    assert.equal(reopen.created,false);assert.equal(reopen.reason,'ASSET_REENTRY_BLOCKED');
    await pollTelegram(runtime,config.telegram!.database,tg);
    assert.ok(tg.messages.some(m=>m.text.includes('已清仓')));
    const empty=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(8,'/positions')]);assert.ok(empty.some(m=>m.text.includes('暂无已登记的实盘持仓')));
    assert.equal(requests.filter(p=>p==='POST /v1/trade/swap').length,2);assert.equal(requests.some(p=>p.includes('/strategy/')),false);
    assert.equal(globalNetwork.mock.callCount(),0);assert.equal(runtime.signalCounting.status().executionEnabled,false);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('owner TG start enables SOL third-signal live entry with attached exits, durable confirmation and TG notification; stop disables new buys',async t=>{
 const globalNetwork=t.mock.method(globalThis,'fetch',async()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
 const solWallet=bs58.encode(Buffer.alloc(32,71)),mint=bs58.encode(Buffer.alloc(32,72)),otherMint=bs58.encode(Buffer.alloc(32,73));
 const signature=bs58.encode(Buffer.alloc(64,74)),sol='So11111111111111111111111111111111111111112';
 const pem=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const {dir,config}=fixture({DASHBOARD_ENABLED:'false',GMGN_API_KEY:'synthetic-live-runtime-key',GMGN_PRIVATE_KEY:pem,
   ENTRY_WALLET_SOLANA:solWallet,SOLANA_RPC_URL:'https://runtime-rpc.invalid',SCANNER_CHAINS:'solana',
   THIRD_SIGNAL_EXECUTION_MODE:'live',ENTRY_BALANCE_BPS_SOLANA:'300',ENTRY_INPUT_TOKEN_SOLANA:sol});
 config.exitPolicy={enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}};
 const tg=telegramHarness(),state={posts:0,quotes:0,balanceReads:0};let runtime:ReturnType<typeof createRuntime>;
 const entryFetcher:typeof fetch=async(input,init)=>{
   const url=new URL(String(input));
   if(url.origin==='https://runtime-rpc.invalid'){
     const rpc=JSON.parse(String(init?.body));
     if(rpc.method==='getGenesisHash')return Response.json({jsonrpc:'2.0',id:rpc.id,result:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'});
     if(rpc.method==='getBalance'){state.balanceReads++;return Response.json({jsonrpc:'2.0',id:rpc.id,result:{context:{slot:45678},value:1000000000}});}
     // This test verifies buy submission and attached protection, not strategy activation or chain balances.
     throw Error('POSITION_BALANCE_NOT_IN_THIS_MOCK');
   }
   assert.equal(url.origin,'https://openapi.gmgn.ai');
   if(url.pathname==='/v1/trade/quote'){
     assert.equal(init?.method,'GET');state.quotes++;
     return Response.json({code:0,data:{input_token:sol,output_token:mint,input_amount:url.searchParams.get('input_amount'),
       output_amount:'10000000',min_output_amount:'9500000',slippage:5}});
   }
   if(url.pathname==='/v1/trade/strategy/orders'){
     assert.equal(init?.method,'GET');return Response.json({code:0,data:{list:[],next_page_token:''}});
   }
   assert.equal(url.pathname,'/v1/trade/swap');assert.equal(init?.method,'POST');state.posts++;
   const body=JSON.parse(String(init?.body));
   assert.equal(runtime.orders.list()[0].status,'submitting');assert.equal(body.input_amount,'30000000');
   assert.deepEqual(body.condition_orders,[{order_type:'profit_stop',side:'sell',price_scale:'100',sell_ratio:'50'},
     {order_type:'loss_stop',side:'sell',price_scale:'60',sell_ratio:'100'}]);
   assert.equal(body.sell_ratio_type,'hold_amount');assert.equal(body.output_token,mint);
   return Response.json({code:0,data:{order_id:'runtime-buy-1',status:'confirmed',state:30,hash:signature,strategy_order_id:'runtime-exits-1',
     report:{input_token:sol,output_token:mint,input_amount:body.input_amount,output_amount:'10000000'}}});
 };
 runtime=createRuntime(config,{telegramFetcher:tg.fetcher,entryFetcher,heldFetcher:async()=>{throw Error('HELD_NETWORK_FORBIDDEN');}});
 t.mock.method(runtime.client,'scheduleRequest',async<T>(_weight:number,execute:()=>Promise<T>)=>execute());
 t.mock.method(runtime.client,'get',async(path:string,query:Record<string,string|number>)=>{
   assert.equal(query.chain,'sol');assert.equal(query.address,mint);
   if(path==='/v1/token/info')return {address:mint,stat:{top_10_holder_rate:'0.25'}};
   assert.equal(path,'/v1/market/token_top_holders');return {list:[]};
 });
 let sequence=0;
 const observe=(source:'debot'|'ave',address=mint)=>{
   const at=new Date().toISOString(),eventId=`${source}:runtime:${++sequence}`;
   return runtime.signalCounting.observe({signal:parseSignal({source,sourceEventId:eventId,token:{chain:'solana',address},
     occurredAt:at,text:'source signal',claim:'unspecified',evidenceUrls:[]}),observedAt:at,alertMarketCapUsd:95000,
     marketCapTiming:'event_snapshot',name:'Runtime SOL Meme',symbol:'RSM'});
 };
 try {
   assert.equal(runtime.signalCounting.status().executionReady,true,JSON.stringify(runtime.signalCounting.status()));assert.equal(state.posts,0);
   assert.equal(runtime.signalCounting.status().running,false);
   await pollTelegram(runtime,config.telegram!.database,tg); // Initial backlog checkpoint, no command replay.
   const started=await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(11,'启动计数')]);
   assert.ok(started.some(message=>message.text.includes('达标自动实盘买入')));
   assert.equal(runtime.signalCounting.status().executionEnabled,true);assert.equal(runtime.telegramControls!.status().countingMode,'live');
   for(let n=0;n<3;n++){observe('debot');observe('ave');}
   await runtime.signalCounting.waitForDispatches();
   assert.equal(state.posts,1);assert.equal(state.quotes,1);assert.equal(state.balanceReads,2);
   const order=runtime.orders.list()[0];assert.equal(order.status,'confirmed');assert.equal(order.inputAmount,'30000000');
   assert.equal(order.exit?.strategyOrderId,'runtime-exits-1');
   const candidate=runtime.signalCountingPage().items.find(item=>item.source==='debot')!;
   assert.equal(candidate.executionStatus,'confirmed');assert.equal(candidate.executionOrderId,order.id);
   const notified=await pollTelegram(runtime,config.telegram!.database,tg);
   const confirmed=notified.find(message=>message.text.includes('买单已确认'));
   assert.ok(confirmed);assert.match(confirmed.text,/Runtime SOL Meme/);assert.ok(confirmed.text.includes(mint));
   assert.ok(notified.some(message=>message.text.includes('实盘信号达标')));
   await pollTelegram(runtime,config.telegram!.database,tg,[privateMessage(12,'停止计数')]);
   const events=runtime.signalCounting.status().events;
   for(let n=0;n<3;n++)observe('debot',otherMint);
   await runtime.signalCounting.waitForDispatches();assert.equal(state.posts,1);assert.equal(runtime.signalCounting.status().events,events);
   assert.equal(runtime.signalCounting.status().executionEnabled,false);assert.equal(runtime.orders.list().length,1);
   assert.equal(globalNetwork.mock.callCount(),0);
 }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
