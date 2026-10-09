import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAbiParameters,encodeEventTopics,parseAbiItem,toEventSelector,type AbiEvent} from 'viem';
import {checkProvenance,verifyEvmReceipt,registry} from '../src/provenance/index.js';
import {signal,config,token} from './helpers.js';
import type {Chain} from '../src/types.js';

const tx='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64),otherToken='0x'+'c'.repeat(40);
const genesis=1_700_000_000,createdBlock=500_000n,defaultHead=1_048_576n;
const blockTime=(n:bigint)=>genesis+Number(n)*3;
const hex=(n:bigint|number)=>'0x'+n.toString(16);
const definitions={
  four:'event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)',
  flap:'event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)',
  version:'event TokenVersionSet(address token,uint8 version)',
  extension:'event TokenExtensionEnabled(address token,bytes32 extensionID,address extensionAddress,uint256 version)',
  tax:'event FlapTokenTaxSet(address token,uint256 tax)',
  asymmetricTax:'event FlapTokenAsymmetricTaxSet(address token,uint256 buyTax,uint256 sellTax)',
};
function event(kind:keyof typeof definitions,values:unknown[],emitter=registry.flap.factory) {
  const abi=parseAbiItem(definitions[kind]) as AbiEvent;
  return {address:emitter,transactionHash:tx,blockHash,blockNumber:hex(createdBlock),removed:false,
    topics:encodeEventTopics({abi:[abi]}),data:encodeAbiParameters(abi.inputs,values as any)};
}
function creation(kind:'four'|'flap'='four',emitter=registry[kind].factory,target=token) {
  return kind==='four'?event(kind,[token,target,1n,'TEST','TEST',100n,BigInt(blockTime(createdBlock)),0n],emitter):
    event(kind,[BigInt(blockTime(createdBlock)),token,1n,target,'TEST','TEST','ipfs'],emitter);
}
function receipt(logs:unknown[]=[creation()]) {
  return {status:'0x1',transactionHash:tx,blockHash,blockNumber:hex(createdBlock),logs};
}
interface RpcOptions {
  chain?:Exclude<Chain,'solana'>;head?:bigint;logs?:ReturnType<typeof creation>[];
  receipt?:unknown;
  change?:(method:string,params:any[],result:unknown)=>unknown;
  rpcError?:string;
}
function harness(options:RpcOptions={}) {
  const chain=options.chain??'bsc',head=options.head??defaultHead;
  const calls:{method:string;params:any[]}[]=[];
  const logs=options.logs??[creation()];
  const c=config();c.rpc[chain]='https://configured-rpc.test';c.etherscanKey=undefined;
  const s=signal({token:{chain,address:token}});
  const info={chain,address:token,creation_timestamp:blockTime(createdBlock)};
  const fetcher:typeof fetch=async(url,init)=>{
    assert.equal(String(url),c.rpc[chain]);assert.equal(init?.method,'POST');
    const {method,params}=JSON.parse(String(init?.body));calls.push({method,params});
    if(options.rpcError===method) return new Response(JSON.stringify({error:{code:-32005,message:'provider limit'}}));
    let result:unknown;
    if(method==='eth_chainId') result=chain==='bsc'?'0x38':'0x1237';
    else if(method==='eth_blockNumber') result=hex(head);
    else if(method==='eth_getBlockByNumber') {
      const n=BigInt(params[0]);
      result={number:hex(n),timestamp:hex(blockTime(n)),hash:n===createdBlock?blockHash:'0x'+'d'.repeat(64)};
    } else if(method==='eth_getLogs') {
      const {fromBlock,toBlock}=params[0];
      assert.ok(BigInt(toBlock)-BigInt(fromBlock)<=63n);
      result=logs.filter(log=>BigInt(log.blockNumber)>=BigInt(fromBlock)&&BigInt(log.blockNumber)<=BigInt(toBlock));
    } else if(method==='eth_getTransactionReceipt') {
      assert.equal(params[0],tx);result=options.receipt??receipt(logs);
    } else if(method==='eth_getCode') {assert.deepEqual(params,[token,'latest']);result='0x60006000';}
    else assert.fail(`unexpected RPC method ${method}`);
    if(options.change) result=options.change(method,params,result);
    return new Response(JSON.stringify({result}));
  };
  return {c,s,info,fetcher,calls};
}

test('CA-only以创建时间作有限搜索提示，官方factory日志后仍完整核验receipt、确认、canonical和code',async()=>{
  const h=harness();
  const r=await checkProvenance(h.s,h.c,h.fetcher,h.info);
  assert.equal(r.status,'pass');assert.equal(r.platform,'four');assert.equal(r.facts.creationTx,tx);
  assert.equal(r.method,'official_creation_receipt');assert.match(String(r.facts.runtimeCodeHash),/^[a-f0-9]{64}$/);
  assert.ok(h.calls.length<=52);
  const ranges=h.calls.filter(c=>c.method==='eth_getLogs');assert.ok(ranges.length>=1&&ranges.length<=5);
  const expectedTopics=['four','flap'].map(key=>toEventSelector(parseAbiItem(definitions[key as 'four'|'flap']) as AbiEvent));
  for(const {params} of ranges) {
    assert.deepEqual(params[0].address,[registry.four.factory,registry.flap.factory]);
    assert.deepEqual(params[0].topics,[expectedTopics]);
    assert.ok(BigInt(params[0].fromBlock)>=createdBlock-128n&&BigInt(params[0].toBlock)<=createdBlock+128n);
  }
  assert.deepEqual(h.calls.slice(-4).map(c=>c.method),[
    'eth_getTransactionReceipt','eth_blockNumber','eth_getBlockByNumber','eth_getCode']);
});

test('GMGN提示CA/链不一致、布尔或缺失时间拒绝查询，不会猜成当前时间',async()=>{
  for(const patch of [{address:otherToken},{chain:'robinhood'},{creation_timestamp:undefined},
    {creation_timestamp:true},{creation_timestamp:0},{creation_timestamp:'1e9'}]) {
    const h=harness(),r=await checkProvenance(h.s,h.c,h.fetcher,{...h.info,...patch});
    assert.equal(r.status,'unknown');assert.ok(r.reasons.includes('EVM_CREATION_TX_REQUIRED'));
    assert.deepEqual(h.calls.map(c=>c.method),['eth_chainId']);
  }
});

test('近期创建查询不依赖已裁剪的远古区块，仍完整核验创建回执',async()=>{
  const oldestAvailable=createdBlock-20_000n;
  const h=harness({head:createdBlock+5_000n,change:(method,params,result)=>
    method==='eth_getBlockByNumber'&&BigInt(params[0])<oldestAvailable?null:result});
  const r=await checkProvenance(h.s,h.c,h.fetcher,h.info);
  assert.equal(r.status,'pass');assert.equal(r.facts.creationTx,tx);
  const queried=h.calls.filter(c=>c.method==='eth_getBlockByNumber').map(c=>BigInt(c.params[0]));
  assert.ok(queried.every(n=>n>=oldestAvailable));assert.ok(queried.length<=41);
  assert.equal(h.calls.filter(c=>c.method==='eth_getTransactionReceipt').length,1);
});

test('近期定位仍不能跨越不可用历史或伪造区块字段，无法取得范围保持unknown',async()=>{
  for(const invalid of [null,{number:hex(defaultHead),timestamp:'0xnothex'}]) {
    const h=harness({head:createdBlock+5_000n,change:(method,params,result)=>
      method==='eth_getBlockByNumber'&&BigInt(params[0])<createdBlock?invalid:result});
    const r=await checkProvenance(h.s,h.c,h.fetcher,h.info);
    assert.equal(r.status,'unknown');assert.ok(!h.calls.some(c=>c.method==='eth_getTransactionReceipt'));
  }
});

test('错误时间提示只查有限窗口，没找到不能宣称不是官方或自动扩成全链扫描',async()=>{
  const h=harness();
  const r=await checkProvenance(h.s,h.c,h.fetcher,{...h.info,creation_timestamp:blockTime(createdBlock+1_000n)});
  assert.equal(r.status,'unknown');assert.ok(r.reasons.includes('EVM_CREATION_TX_REQUIRED'));
  assert.equal(h.calls.filter(c=>c.method==='eth_getLogs').length,5);
  assert.ok(!h.calls.some(c=>c.method==='eth_getTransactionReceipt'));
  assert.ok(h.calls.length<=49);
});

test('时间超链头、毫秒值或在genesis之前时不查logs',async()=>{
  for(const value of [blockTime(defaultHead)+31,blockTime(createdBlock)*1_000,genesis-1]) {
    const h=harness(),r=await checkProvenance(h.s,h.c,h.fetcher,{...h.info,creation_timestamp:value});
    assert.equal(r.status,'unknown');assert.equal(h.calls.filter(c=>c.method==='eth_getLogs').length,0);
  }
});

test('异常大链头二分最多40步，RPC拒绝历史block或logs时保守unknown',async()=>{
  const huge=harness({head:2n**44n});
  const bounded=await checkProvenance(huge.s,huge.c,huge.fetcher,huge.info);
  assert.equal(bounded.status,'unknown');assert.ok(huge.calls.length<=44);
  assert.equal(huge.calls.filter(c=>c.method==='eth_getLogs').length,0);
  for(const rpcError of ['eth_getBlockByNumber','eth_getLogs']) {
    const h=harness({rpcError}),r=await checkProvenance(h.s,h.c,h.fetcher,h.info);
    assert.equal(r.status,'unknown');assert.ok(r.reasons.includes('PROVENANCE_RPC_UNAVAILABLE_OR_UNSUPPORTED'));
    assert.equal(h.calls.filter(c=>c.method===rpcError).length,1);
  }
});

test('伪造factory、其他CA、removed和越出请求区间的日志不构成来源',async()=>{
  const candidates=[creation('four',otherToken),creation('four',registry.four.factory,otherToken),
    {...creation(),removed:true},{...creation(),transactionHash:'truncated'},
    {...creation(),blockNumber:hex(createdBlock+1_000n)}];
  for(const log of candidates) {
    const h=harness({change:(method,_params,value)=>method==='eth_getLogs'?[log]:value});
    const r=await checkProvenance(h.s,h.c,h.fetcher,h.info);
    assert.equal(r.status,'unknown');assert.ok(!h.calls.some(c=>c.method==='eth_getTransactionReceipt'));
  }
});

test('供应商提示不会替代完整receipt；无事件/失败交易/错交易hash不能通过',async()=>{
  for(const invalid of [receipt([]),{...receipt(),status:'0x0'},
    {...receipt(),transactionHash:'0x'+'c'.repeat(64)},receipt([creation('four',registry.four.factory,otherToken)])]) {
    const h=harness({receipt:invalid}),r=await checkProvenance(h.s,h.c,h.fetcher,h.info);
    assert.equal(r.status,'unknown');assert.ok(!h.calls.some(c=>c.method==='eth_getCode'));
  }
});

test('确认不足、区块分叉、header高度不符、无/坏runtime code均回unknown',async()=>{
  const cases:[(method:string,params:any[],value:unknown)=>unknown,string][]=[
    [(method,_params,value)=>method==='eth_blockNumber'?hex(createdBlock+11n):value,'CREATION_NOT_SUFFICIENTLY_CONFIRMED'],
    [(method,params,value)=>method==='eth_getBlockByNumber'&&params[0]===hex(createdBlock)?
      {...value as object,hash:'0x'+'e'.repeat(64)}:value,'CREATION_BLOCK_NOT_CANONICAL'],
    [(method,params,value)=>method==='eth_getBlockByNumber'&&params[0]===hex(createdBlock)?
      {...value as object,number:hex(createdBlock+1n)}:value,'CREATION_BLOCK_NOT_CANONICAL'],
    ...['0x','0x0','not-hex'].map(value=>[
      (method:string,_params:any[],original:unknown)=>method==='eth_getCode'?value:original,
      'TOKEN_CODE_MISSING'] as [(method:string,params:any[],value:unknown)=>unknown,string]),
  ];
  for(const [change,reason] of cases) {
    // Explicit tx isolates the final canonical check from timestamp-search block reads.
    const h=harness({change}),r=await checkProvenance({...h.s,creationTx:tx},h.c,h.fetcher,h.info);
    assert.equal(r.status,'unknown');assert.ok(r.reasons.includes(reason));
  }
});

test('receipt日志元数据与交易/header冲突时不能忽略坏日志而按legacy模式放行',()=>{
  for(const patch of [{transactionHash:'0x'+'d'.repeat(64)},{blockHash:'0x'+'d'.repeat(64)},
    {blockNumber:hex(createdBlock+1n)}]) {
    const r=verifyEvmReceipt(signal({creationTx:tx}),receipt([{...creation(),...patch}]));
    assert.equal(r.status,'unknown');assert.ok(r.reasons.includes('CREATION_RECEIPT_LOG_MISMATCH'));
  }
  assert.equal(verifyEvmReceipt(signal({creationTx:tx}),receipt([null])).status,'unknown');
});

test('Robinhood Flap使用本链官方Portal；BSC Portal、Four和错误RPC链不可冒充',async()=>{
  const log=creation('flap',registry.flapRobinhood.factory),h=harness({chain:'robinhood',logs:[log]});
  const r=await checkProvenance(h.s,h.c,h.fetcher,h.info);
  assert.equal(r.status,'pass');assert.equal(r.platform,'flap');assert.equal(r.facts.factory,registry.flapRobinhood.factory);
  for(const c of h.calls.filter(c=>c.method==='eth_getLogs')) assert.deepEqual(c.params[0].address,[registry.flapRobinhood.factory]);
  const robinhood=signal({token:{chain:'robinhood',address:token},creationTx:tx});
  assert.equal(verifyEvmReceipt(robinhood,receipt([creation('flap')])).status,'unknown');
  assert.equal(verifyEvmReceipt(robinhood,receipt([creation('four')])).status,'unknown');
  assert.equal(verifyEvmReceipt({...robinhood,claimedPlatform:'four'},receipt([log])).status,'unknown');
  assert.equal(verifyEvmReceipt(signal({creationTx:tx}),receipt([log])).status,'unknown');
  const bad=harness({chain:'robinhood',change:(method,_params,value)=>method==='eth_chainId'?'0x38':value});
  assert.ok((await checkProvenance(bad.s,bad.c,bad.fetcher,bad.info)).reasons.includes('RPC_CHAIN_MISMATCH'));
  assert.equal(bad.calls.length,1);
});

test('Flap创建来源与模式支持分别记录，已知legacy通过，税版本和其他新版本不冒充已支持',()=>{
  for(const version of [undefined,0,1,2,3,4,5,6,7,99]) {
    const logs=[creation('flap'),...(version===undefined?[]:[event('version',[token,version])])];
    const r=verifyEvmReceipt(signal({creationTx:tx}),receipt(logs));
    assert.equal(r.status,'pass');assert.equal(r.facts.tokenVersion,version??0);
    assert.equal(r.facts.modeSupported,version===undefined||[0,1,2].includes(version));
    if(version!==undefined&&[4,5,6].includes(version)) assert.equal(r.facts.modeUnsupportedReason,'FLAP_TAX_MODE_UNSUPPORTED');
  }
});

test('未知扩展、畸形已知topic和冲突版本都不能按缺省legacy放行',()=>{
  const extension=event('extension',[token,'0x'+'0'.repeat(64),otherToken,1n]);
  const sets=[
    [extension],
    [{...event('version',[token,2]),data:'0x'}],
    [{...extension,data:'0x'}],
    [event('version',[token,99]),event('version',[token,0])],
  ];
  for(const extra of sets) {
    const r=verifyEvmReceipt(signal({creationTx:tx}),receipt([creation('flap'),...extra]));
    assert.equal(r.status,'pass');assert.equal(r.facts.modeSupported,false);
  }
  const unrelated=verifyEvmReceipt(signal({creationTx:tx}),receipt([creation('flap'),event('version',[otherToken,99])]));
  assert.equal(unrelated.facts.modeSupported,true);
});

test('非零税/非对称税实际事件不能被缺版本或低版本隐藏，不把卖税猜成买税',()=>{
  const r=verifyEvmReceipt(signal({creationTx:tx}),receipt([creation('flap'),
    event('tax',[token,1_000n]),event('asymmetricTax',[token,300n,1_000n])]));
  assert.equal(r.status,'pass');assert.equal(r.facts.modeSupported,false);
  assert.equal(r.facts.taxRateBps,'1000');assert.equal(r.facts.buyTaxBps,'300');assert.equal(r.facts.sellTaxBps,'1000');
  assert.equal(r.facts.modeUnsupportedReason,'FLAP_TAX_MODE_UNSUPPORTED');
});

test('CA查找只返回交易线索，最终mode一定读取完整receipt而非单个TokenCreated日志',async()=>{
  const log=creation('flap');
  const h=harness({logs:[log],receipt:receipt([log,event('version',[token,6]),event('tax',[token,500n])])});
  const r=await checkProvenance(h.s,h.c,h.fetcher,h.info);
  assert.equal(r.status,'pass');assert.equal(r.facts.tokenVersion,6);assert.equal(r.facts.modeSupported,false);
  assert.equal(h.calls.filter(c=>c.method==='eth_getTransactionReceipt').length,1);
});

test('可选浏览器解析失败后允许有限RPC回退，仍不信任浏览器声称的平台',async()=>{
  const h=harness();h.c.etherscanKey='dummy-key';let explorerCalls=0;
  const fetcher:typeof fetch=async(url,init)=>{
    if(String(url).startsWith('https://api.etherscan.io/')) {explorerCalls++;throw new Error('unavailable');}
    return h.fetcher(url,init);
  };
  const r=await checkProvenance(h.s,h.c,fetcher,h.info);
  assert.equal(explorerCalls,1);assert.equal(r.status,'pass');
});
