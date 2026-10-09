import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readConfig} from '../src/config.js';
import {runDoctor,type DoctorReport} from '../src/doctor.js';

const full=(overrides:NodeJS.ProcessEnv={})=>readConfig({INGEST_TOKEN:'test-ingest-token-with-24-characters',
  X_DATA_PROVIDER:'fxembed',NARRATIVE_PROVIDER:'vendor',WALLET_SUPPORT_REQUIRED:'false',
  SOLANA_RPC_URL:'https://sol.rpc.invalid/private-key',...overrides});
const check=(report:DoctorReport,id:string)=>report.checks.find(item=>item.id===id)!;
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
const fxPost={code:200,status:{id:'20',type:'status',provider:'twitter',text:'just setting up my twttr',
  author:{id:'12'},created_at:'Tue Mar 21 20:50:14 +0000 2006'}};
const liveFetcher=(identities:Record<string,unknown>={}):typeof fetch=>async(url,init)=>{
  if(String(url).startsWith('https://api.fxtwitter.com/')) return json(fxPost);
  const method=JSON.parse(String(init?.body)).method;
  return json({jsonrpc:'2.0',id:1,result:identities[String(url)]??(method==='getGenesisHash'
    ?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':'0x38')});
};

test('doctor 默认不联网；单独配齐 Solana 即可研究，但 DeBot/Robinhood/执行边界不变',async()=>{
  let calls=0;
  const report=await runDoctor(full(),{fetcher:async()=>{calls++;throw new Error('must not run');}});
  assert.equal(calls,0);assert.equal(report.mode,'configuration');assert.equal(report.readyForResearch,true);
  assert.deepEqual(report.readyByChain,{bsc:false,solana:true,robinhood:false});assert.equal(report.executionDisabled,true);
  for(const id of ['rpc.bsc','rpc.robinhood','debot']) assert.equal(check(report,id).status,'warn');
  assert.equal(check(report,'robinhood.allowlist').status,'pass');
  assert.equal(check(report,'robinhood.narrative').status,'warn');
  assert.match(check(report,'model').message,/不需要 OPENAI_API_KEY/);
  assert.match(check(report,'model').message,/自动按 CA 读取 DeBot 页面接口/);
  assert.match(check(report,'model').message,/评分和负面意见仅供参考/);
});

test('共同依赖缺失或空白不被当作就绪，Key 只能用于对应渠道',async()=>{
  for(const override of [{INGEST_TOKEN:'short'},{INGEST_TOKEN:' '.repeat(30)},
    {X_DATA_PROVIDER:'x_official',X_BEARER_TOKEN:''},
    {X_DATA_PROVIDER:'twitterapi_io',X_BEARER_TOKEN:'not-the-vendor-key'}]) {
    const report=await runDoctor(full(override));assert.equal(report.readyForResearch,false);
  }
  for(const override of [{X_DATA_PROVIDER:'x_official',X_BEARER_TOKEN:'configured'},
    {X_DATA_PROVIDER:'twitterapi_io',TWITTERAPI_IO_KEY:'configured'}]) assert.equal((await runDoctor(full(override))).readyForResearch,true);
});

test('vendor 默认无需个人模型 Key；仅主动选择 openai 时才要求完整模型配置',async()=>{
  const defaults=readConfig({INGEST_TOKEN:'test-ingest-token-with-24-characters',X_DATA_PROVIDER:'fxembed',
    SOLANA_RPC_URL:'https://sol.rpc.invalid/key',WALLET_SUPPORT_REQUIRED:'false'});
  assert.equal(defaults.narrativeProvider,'vendor');
  assert.equal((await runDoctor(defaults)).readyForResearch,true);
  assert.equal((await runDoctor(full({OPENAI_API_KEY:' ',OPENAI_MODEL:''}))).readyForResearch,true);
  for(const override of [{},{OPENAI_API_KEY:'configured'},{OPENAI_MODEL:'configured'},
    {OPENAI_API_KEY:' ',OPENAI_MODEL:'configured'}]) {
    const report=await runDoctor(full({NARRATIVE_PROVIDER:'openai',...override}));
    assert.equal(report.readyForResearch,false);assert.equal(check(report,'model').status,'fail');
  }
  const report=await runDoctor(full({NARRATIVE_PROVIDER:'openai',OPENAI_API_KEY:'configured',OPENAI_MODEL:'configured'}));
  assert.equal(report.readyForResearch,true);assert.match(check(report,'model').message,/未调用模型/);
});

test('BSC 完整 CA-only 研究需要创建交易查找 Key；不配置不会阻断 Solana',async()=>{
  const c=full({SOLANA_RPC_URL:'',BSC_RPC_URL:'https://bsc.rpc.invalid/secret'});
  const partial=await runDoctor(c);assert.equal(partial.readyForResearch,false);
  assert.match(check(partial,'etherscan').message,/creationTx/);
  c.etherscanKey='secret-explorer-key';
  assert.deepEqual((await runDoctor(c)).readyByChain,{bsc:true,solana:false,robinhood:false});
});

test('默认钱包门槛需要个人GMGN Key，GMGN也可提供BSC创建时间提示；不可能的采样配置报错',async()=>{
  const c=full({WALLET_SUPPORT_REQUIRED:'true',BSC_RPC_URL:'https://bsc.rpc.invalid'});
  assert.equal((await runDoctor(c)).readyForResearch,false);
  c.gmgnApiKey='gmgn_solbscbaseethmonadtron';assert.equal((await runDoctor(c)).readyForResearch,false);
  c.gmgnApiKey='personal-key-not-network-tested';
  assert.deepEqual((await runDoctor(c)).readyByChain,{bsc:true,solana:true,robinhood:false});
  c.walletMaxProfiles=1;
  const insufficient=await runDoctor(c);assert.equal(insufficient.readyForResearch,false);
  assert.equal(check(insufficient,'wallets.policy').status,'fail');
  c.entryMode='paper';assert.equal((await runDoctor(c)).executionDisabled,true);
  c.entryMode='live';assert.equal((await runDoctor(c)).executionDisabled,false);
});

test('RPC URL 无效时不探测，不把测试网 genesis 前缀当主网',async()=>{
  let calls=0;
  const bad=await runDoctor(full({SOLANA_RPC_URL:'wss://rpc.invalid'}),{live:true,fetcher:async()=>{calls++;return json(fxPost);}});
  assert.equal(calls,1);assert.equal(check(bad,'rpc.solana').status,'fail');assert.equal(bad.readyForResearch,false);
  for(const identity of ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','EtWTRABZaYq6iMfeYKouRu166VU2xqa1',null]) {
    const report=await runDoctor(full(),{live:true,fetcher:async(url)=>String(url).includes('fxtwitter')
      ?json(fxPost):json({result:identity})});
    assert.equal(check(report,'rpc.solana.live').status,'fail');assert.equal(report.readyForResearch,false);
  }
});

test('live 只调用已配置 RPC 身份方法和一个公开帖子；不发送模型请求或凭证',async()=>{
  const c=full({BSC_RPC_URL:'https://bsc.rpc.invalid/key',ROBINHOOD_RPC_URL:'https://rh.rpc.invalid/key',ETHERSCAN_API_KEY:'explorer'});
  const calls:{url:string;method?:string}[]=[];
  const f:typeof fetch=async(url,init)=>{
    const target=String(url),method=init?.body?JSON.parse(String(init.body)).method:undefined;
    calls.push({url:target,method});assert.equal(new Headers(init?.headers).get('authorization'),null);
    if(target.includes('fxtwitter')) {assert.equal(target,'https://api.fxtwitter.com/2/status/20');return json(fxPost);}
    return json({result:target===c.rpc.robinhood?'0x1237':method==='eth_chainId'?'0x38':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'});
  };
  const report=await runDoctor(c,{live:true,fetcher:f});
  assert.equal(calls.length,4);assert.deepEqual(calls.map(call=>call.method),['eth_chainId','getGenesisHash','eth_chainId',undefined]);
  assert.deepEqual(report.readyByChain,{bsc:true,solana:true,robinhood:false});assert.equal(check(report,'rpc.robinhood.live').status,'pass');
  assert.match(check(report,'x.fxembed.live').message,/尚未测试搜索/);
});

test('EVM 测试网或 malformed 身份失败，但另一链成功仍可研究',async()=>{
  const c=full({BSC_RPC_URL:'https://bsc.rpc.invalid/secret',ETHERSCAN_API_KEY:'key'});
  for(const result of ['0x61','56',56,{},null]) {
    const report=await runDoctor(c,{live:true,fetcher:async(url,init)=>String(url)===c.rpc.bsc
      ?json({result}):liveFetcher()(url,init)});
    assert.equal(check(report,'rpc.bsc.live').status,'fail');assert.equal(report.readyForResearch,true);
    assert.equal(report.readyByChain.bsc,false);
  }
});

test('网络异常、HTTP错误、坏JSON和伪成功均不会谎报，诊断不泄露秘密或RPC地址',async()=>{
  const c=full({OPENAI_API_KEY:'secret-model-key'});
  const secretError=`${c.rpc.solana} ${c.openaiKey} ${c.ingestToken}`;
  for(const f of [(async()=>{throw new Error(secretError);}) as typeof fetch,
    (async()=>json({error:{message:secretError}},403)) as typeof fetch,
    (async()=>new Response(secretError)) as typeof fetch,
    (async()=>json({code:200,status:{...fxPost.status,id:'999'},result:null})) as typeof fetch]) {
    const report=await runDoctor(c,{live:true,fetcher:f});
    assert.equal(report.readyForResearch,false);assert.equal(check(report,'rpc.solana.live').status,'fail');
    assert.equal(check(report,'x.fxembed.live').status,'fail');
    const output=JSON.stringify(report);
    for(const secret of [c.rpc.solana!,c.openaiKey!,c.ingestToken!]) assert.equal(output.includes(secret),false);
  }
});

test('FxEmbed 内容缺失/删除/非X不算读通；付费X渠道仅检查配置且不会暗中改用FxEmbed',async()=>{
  for(const status of [{...fxPost.status,type:'tombstone'},{...fxPost.status,text:''},
    {...fxPost.status,provider:'bluesky'},{...fxPost.status,created_at:'invalid'}]) {
    const report=await runDoctor(full(),{live:true,fetcher:async(url,init)=>String(url).includes('fxtwitter')
      ?json({code:200,status}):liveFetcher()(url,init)});
    assert.equal(report.readyForResearch,false);assert.equal(check(report,'x.fxembed.live').status,'fail');
  }
  let count=0;
  const report=await runDoctor(full({X_DATA_PROVIDER:'x_official',X_BEARER_TOKEN:'secret'}),{live:true,fetcher:async(url,init)=>{
    count++;assert.equal(String(url).includes('fxtwitter'),false);return liveFetcher()(url,init);
  }});
  assert.equal(count,1);assert.equal(report.readyForResearch,true);assert.equal(check(report,'x.live').status,'warn');
});

test('doctor 可直接作为 CLI 运行；配置报错不回显无效字段或秘密',()=>{
  const args=['--import','tsx',fileURLToPath(new URL('../src/doctor.ts',import.meta.url))];
  const empty=spawnSync(process.execPath,args,{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(empty.status,1);
  assert.equal(JSON.parse(empty.stdout).readyForResearch,false);
  assert.equal(JSON.parse(empty.stdout).mode,'configuration');
  const secret='sensitive-invalid-provider';
  const invalid=spawnSync(process.execPath,args,{encoding:'utf8',env:{PATH:process.env.PATH,X_DATA_PROVIDER:secret}});
  assert.equal(invalid.status,1);assert.equal((invalid.stdout+invalid.stderr).includes(secret),false);
  assert.equal(JSON.parse(invalid.stderr).checks[0].status,'fail');
});
