import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeAbiParameters,encodeEventTopics,parseAbiItem} from 'viem';
import bs58 from 'bs58';
import {checkProvenance,verifyEvmReceipt,verifyPumpAccount,verifyBonkAccount,registry} from '../src/provenance/index.js';
import {signal,config,token,fetchJson} from './helpers.js';

const tx='0x'+'a'.repeat(64);
function receipt(emitter=registry.four.factory,target=token) {
  const event=parseAbiItem('event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)');
  return {transactionHash:tx,status:'0x1',blockNumber:'0x10',logs:[{address:emitter,
    topics:encodeEventTopics({abi:[event],eventName:'TokenCreate'}),
    data:encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint256'},{type:'string'},{type:'string'},
      {type:'uint256'},{type:'uint256'},{type:'uint256'}],[token as `0x${string}`,target as `0x${string}`,1n,'TEST','TEST',100n,1n,0n])}]};
}
test('Four完整创建事件可以证明来源',()=>{
  assert.equal(verifyEvmReceipt(signal({creationTx:tx}),receipt()).status,'pass');
});
test('4444后缀和仿造事件签名都不能冒充官方工厂',()=>{
  assert.equal(verifyEvmReceipt(signal({creationTx:tx}),receipt(token)).status,'unknown');
  assert.equal(verifyEvmReceipt(signal(),receipt()).status,'unknown');
});
test('官方交易中的其他币和失败交易不能证明目标币来源',()=>{
  assert.equal(verifyEvmReceipt(signal({creationTx:tx}),receipt(registry.four.factory,'0x2222222222222222222222222222222222222222')).status,'unknown');
  assert.equal(verifyEvmReceipt(signal({creationTx:tx}),{...receipt(),status:'0x0'}).status,'unknown');
});
test('RPC返回其他链时立即停止认证',async()=>{
  const c=config();c.rpc.bsc='https://rpc.test';
  const result=await checkProvenance(signal({creationTx:tx}),c,fetchJson({result:'0x1'}));
  assert.ok(result.reasons.includes('RPC_CHAIN_MISMATCH'));
});
test('Pump账户必须由官方程序拥有且有正确布局',()=>{
  const data=Buffer.alloc(81);createHash('sha256').update('account:BondingCurve').digest().copy(data,0,0,8);data.writeBigUInt64LE(100n,40);
  const account={owner:registry.pump.program,data:[data.toString('base64'),'base64']};
  assert.equal(verifyPumpAccount('mint','pda',account).status,'pass');
  assert.equal(verifyPumpAccount('mint','pda',{...account,owner:'attacker'}).status,'unknown');
  assert.equal(verifyPumpAccount('mint','pda',{...account,data:['AA==','base64']}).status,'unknown');
});
test('Pump未知扩展布局保留来源但不支持自动放行',()=>{
  const data=Buffer.alloc(200);createHash('sha256').update('account:BondingCurve').digest().copy(data,0,0,8);data.writeBigUInt64LE(100n,40);
  const r=verifyPumpAccount('mint','pda',{owner:registry.pump.program,data:[data.toString('base64'),'base64']});
  assert.equal(r.status,'pass');assert.equal(r.facts.modeSupported,false);
});
test('LaunchLab官方程序不是Bonk身份的充分证据',()=>{
  const mint=bs58.encode(Buffer.alloc(32,7)),data=Buffer.alloc(429);
  createHash('sha256').update('account:PoolState').digest().copy(data,0,0,8);
  Buffer.from(bs58.decode(mint)).copy(data,205);Buffer.from(bs58.decode(registry.bonk.quoteMint)).copy(data,237);
  const account=()=>({owner:registry.bonk.program,data:[data.toString('base64'),'base64']});
  assert.equal(verifyBonkAccount(mint,'pda',account()).status,'unknown');
  Buffer.from(bs58.decode(registry.bonk.platformConfig)).copy(data,173);
  assert.equal(verifyBonkAccount(mint,'pda',account()).status,'pass');
});
test('Solana完整适配器派生PDA并验证主网状态',async()=>{
  const c=config();c.rpc.solana='https://rpc.test';
  const mint=bs58.encode(Buffer.alloc(32,7));
  const data=Buffer.alloc(81);createHash('sha256').update('account:BondingCurve').digest().copy(data,0,0,8);data.writeBigUInt64LE(100n,40);
  const f:typeof fetch=async(_url,init)=>{
    const request=JSON.parse(String(init?.body));
    if(request.method==='getGenesisHash') return new Response(JSON.stringify({result:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'}));
    assert.equal(request.method,'getAccountInfo');assert.notEqual(request.params[0],mint);
    assert.equal(request.params[1].commitment,'finalized');
    return new Response(JSON.stringify({result:{context:{slot:100},value:{owner:registry.pump.program,data:[data.toString('base64'),'base64']}}}));
  };
  const r=await checkProvenance(signal({token:{chain:'solana',address:mint},claimedPlatform:'pump'}),c,f);
  assert.equal(r.status,'pass');assert.equal(r.platform,'pump');assert.equal(r.facts.slot,100);
});
test('Solana截短CAIP标识不能冒充RPC完整genesis hash',async()=>{
  const c=config();c.rpc.solana='https://rpc.test';
  let calls=0;
  const r=await checkProvenance(signal({token:{chain:'solana',address:bs58.encode(Buffer.alloc(32,7))}}),c,async()=>{
    calls++;return new Response(JSON.stringify({result:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'}));
  });
  assert.equal(calls,1);assert.ok(r.reasons.includes('RPC_CHAIN_MISMATCH'));
});
test('CA-only BSC信号通过浏览器解析交易后仍核验RPC事件和规范区块',async()=>{
  const c=config();c.rpc.bsc='https://rpc.test';c.etherscanKey='test-key';
  const blockHash='0x'+'b'.repeat(64);
  const f:typeof fetch=async(url,init)=>{
    if(String(url).startsWith('https://api.etherscan.io/')) return new Response(JSON.stringify({status:'1',result:[{contractAddress:token,txHash:tx}]}));
    const request=JSON.parse(String(init?.body));
    const results:Record<string,unknown>={eth_chainId:'0x38',eth_getTransactionReceipt:{...receipt(),blockHash},eth_blockNumber:'0x100',eth_getBlockByNumber:{hash:blockHash},eth_getCode:'0x60006000'};
    assert.ok(Object.hasOwn(results,request.method));
    return new Response(JSON.stringify({result:results[request.method]}));
  };
  const r=await checkProvenance(signal(),c,f);assert.equal(r.status,'pass');assert.equal(r.facts.creationTx,tx);
});
