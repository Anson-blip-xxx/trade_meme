import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {decodeFunctionData,encodeAbiParameters,encodeEventTopics,encodeFunctionResult,parseAbi} from 'viem';
import {classifyEvmActivity,WALLET_ACTIVITY_ABI,loadSwapPools,type ActivityPool} from '../src/wallet-activity-evm.js';
import {classifySolanaActivity} from '../src/wallet-activity-solana.js';
import {WalletActivityVerifier,activityResult} from '../src/wallet-activity.js';
import {WalletActivityStore} from '../src/wallet-activity-store.js';
import {CHAIN_PRICE_DEPLOYMENTS as D} from '../src/chain-prices.js';
import registry from '../config/platforms.json' with {type:'json'};
import type {FastWalletEvent} from '../src/wallet-fast.js';
const at=Date.parse('2026-10-21T01:00:00Z'),a=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),h=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const wallet=a(10),token=a(20),other=a(30),txHash=h(1),blockHash=h(2),pk=(n:number)=>bs58.encode(new Uint8Array(32).fill(n));
function preview(chain:'bsc'|'robinhood'|'solana'='bsc'):FastWalletEvent{return {id:'id',chain,wallet,txHash,receivedAt:new Date(at).toISOString(),judgedAt:new Date(at).toISOString(),processingMs:1,
  kind:'token_inflow',verdict:'priority_review',groups:[],profileFresh:true,cachedSafety:'unknown',commitment:'included',removed:false,buyVerified:false,tradingEnabled:false};}
const transfers=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
function log(name:string,args:Record<string,any>,emitter=token){const event=(name==='Transfer'?transfers:WALLET_ACTIVITY_ABI).find(x=>x.name===name&&x.inputs.every(i=>i.name in args))!;
  return {address:emitter,topics:encodeEventTopics({abi:[event],eventName:name,args} as any),data:encodeAbiParameters(event.inputs.filter(i=>!('indexed' in i&&i.indexed)) as any,event.inputs.filter(i=>!('indexed' in i&&i.indexed)).map(i=>args[i.name]) as any),
    transactionHash:txHash,blockHash,blockNumber:'0x100',logIndex:'0x0',removed:false};}
function evmFixture(chain:'bsc'|'robinhood'='bsc',side:'buy'|'sell'='buy'){
  const event=preview(chain),factory=chain==='bsc'?registry.four.factory:registry.flapRobinhood.factory;
  const receipt={status:'0x1',transactionHash:txHash,blockHash,blockNumber:'0x100',logs:[
    log('Transfer',{from:side==='buy'?factory:wallet,to:side==='buy'?wallet:factory,value:1000n}),
    chain==='bsc'?log(side==='buy'?'TokenPurchase':'TokenSale',{token,account:wallet,price:1n,amount:1000n,cost:100n,fee:1n,offers:1n,funds:1n},factory):
      log(side==='buy'?'TokenBought':'TokenSold',{ts:BigInt(at/1000),token,[side==='buy'?'buyer':'seller']:wallet,amount:1000n,eth:100n,fee:1n,postPrice:1n},factory)
  ].map((l,i)=>({...l,logIndex:'0x'+i.toString(16)}))};
  const bundle={receipt,transaction:{hash:txHash,blockHash,blockNumber:'0x100',from:wallet,to:factory,value:side==='buy'?'0x65':'0x0',input:'0x12345678'},block:{hash:blockHash,number:'0x100',timestamp:'0x'+(at/1000).toString(16)}};
  return {event,bundle};
}
test('official Four / Flap events require matching wallet, successful canonical receipt and real base flow',()=>{
  for(const chain of ['bsc','robinhood'] as const)for(const side of ['buy','sell'] as const){const {event,bundle}=evmFixture(chain,side),r=classifyEvmActivity(event,bundle,at+1000);
    assert.equal(r.classification,side);assert.equal(r.trades[0].amountAtomic,'1000');assert.equal(r.trades[0].tokenAddress,token);assert.equal(r.confirmation,'included');}
});
test('fake event emitters, someone else buying, missing consideration and no net tokens never become a buy',()=>{
  for(const change of [
    (b:any)=>b.receipt.logs[1].address=other,(b:any)=>b.transaction.from=other,
    (b:any)=>b.transaction.value='0x0',(b:any)=>b.receipt.logs[0]=log('Transfer',{from:wallet,to:wallet,value:1000n}),
    (b:any)=>b.receipt.logs[1]=Object.assign(log('TokenPurchase',{token,account:other,price:1n,amount:1000n,cost:100n,fee:1n,offers:1n,funds:1n},registry.four.factory),{logIndex:'0x1'})
  ]){const {event,bundle}=evmFixture();change(bundle);assert.notEqual(classifyEvmActivity(event,bundle,at+1000).classification,'buy');}
});
test('canonical block mismatch, failed receipts, removed and inconsistent logs cannot prove a swap',()=>{
  const checks:[(b:any)=>void,string][]=[[(b:any)=>b.block.hash=h(9),'unknown'],[(b:any)=>b.receipt.status='0x0','failed'],[(b:any)=>b.receipt.logs[0].removed=true,'retracted'],[(b:any)=>b.receipt.logs[0].transactionHash=h(9),'unknown'],[(b:any)=>b.receipt.logs[1].logIndex='0x0','unknown']];
  for(const [change,expected]of checks){const {event,bundle}=evmFixture();change(bundle);assert.equal(classifyEvmActivity(event,bundle,at+1000).classification,expected);}
  const f=evmFixture();f.event.blockHash=h(9);assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'unknown');
});
test('plain token/native transfers, unsolicited distribution, approval and self transfers are separate noise categories',()=>{
  const f=evmFixture();f.bundle.receipt.logs=[log('Transfer',{from:wallet,to:other,value:100n})];f.bundle.transaction.input='0xa9059cbb';
  assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'transfer');
  f.bundle.transaction.from=other;f.bundle.receipt.logs=[log('Transfer',{from:other,to:wallet,value:100n})];
  let r=classifyEvmActivity(f.event,f.bundle,at+1000);assert.equal(r.classification,'transfer');assert.equal(r.reasons[0],'UNSOLICITED_TOKEN_INFLOW');assert.equal(r.transfers![0].from,other);
  f.bundle.receipt.logs=[log('Transfer',{from:wallet,to:wallet,value:100n})];assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'self_transfer');
  f.bundle.receipt.logs=[log('Approval',{owner:wallet,spender:other,value:100n})];assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'approval');
  f.bundle.receipt.logs=[];f.bundle.transaction.input='0x';assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'transfer');
});
test('a real purchase paid by another wallet is a received purchase, not the watched wallet entering',()=>{
  const f=evmFixture();f.bundle.transaction.from=other;f.bundle.transaction.value='0x0';
  const r=classifyEvmActivity(f.event,f.bundle,at+1000);assert.equal(r.classification,'received_purchase');assert.equal(r.trades.length,0);assert.equal(r.initiator,other);
});
test('large airdrop-style batches remain bounded and do not masquerade as smart-wallet purchases',()=>{
  const f=evmFixture();f.bundle.transaction.from=other;
  f.bundle.receipt.logs=Array.from({length:3000},(_,i)=>({...log('Transfer',{from:other,to:i===0?wallet:a(i+100),value:1n}),logIndex:'0x'+i.toString(16)}));
  const r=classifyEvmActivity(f.event,f.bundle,at+1000);assert.equal(r.classification,'distribution');assert.equal(r.transferCount,1);assert.equal(r.trades.length,0);assert.equal(r.transfers!.length,1);
});
test('a Swap-shaped log alone is unknown, and a factory cannot self-assert membership',async()=>{
  const f=evmFixture(),pool=a(40);f.bundle.receipt.logs=[log('Swap',{sender:wallet,to:wallet,amount0In:0n,amount1In:100n,amount0Out:1000n,amount1Out:0n},pool)];
  assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'unknown');
  const pools=await loadSwapPools(f.event,f.bundle,{request:async()=>encodeAbiParameters([{type:'address'}],[other as `0x${string}`])});assert.deepEqual(pools,[]);
});
function pancakeFixture(){
  const f=evmFixture(),pool=a(40);const pools:ActivityPool[]=[{address:pool,token0:token,token1:D.usdtBsc,protocol:'pancake_v2'}];
  f.bundle.receipt.logs=[log('Transfer',{from:pool,to:wallet,value:1000n}),log('Transfer',{from:wallet,to:pool,value:100n},D.usdtBsc),
    log('Swap',{sender:wallet,to:wallet,amount0In:0n,amount1In:100n,amount0Out:1000n,amount1Out:0n},pool)].map((l,i)=>({...l,logIndex:'0x'+i}));
  f.bundle.transaction.value='0x0';return {...f,pool,bundle:{...f.bundle,pools}};
}
test('registered pool swap needs both exact wallet legs; unrelated payments or donations cannot supply missing evidence',()=>{
  const f=pancakeFixture();assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'buy');
  for(const change of [
    (b:any,pool:string)=>b.receipt.logs[0]=log('Transfer',{from:pool,to:wallet,value:1n}),
    (b:any,pool:string)=>b.receipt.logs[1]={...log('Transfer',{from:wallet,to:other,value:100n},D.usdtBsc),logIndex:'0x1'},
    (b:any,pool:string)=>b.receipt.logs[1]={...log('Transfer',{from:other,to:pool,value:100n},D.usdtBsc),logIndex:'0x1'},
    (b:any,pool:string)=>b.receipt.logs[2]={...log('Swap',{sender:wallet,to:other,amount0In:0n,amount1In:100n,amount0Out:1000n,amount1Out:0n},pool),logIndex:'0x2'},
    (b:any,pool:string)=>b.receipt.logs.push({...log('Transfer',{from:other,to:wallet,value:50n}),logIndex:'0x3'}),
    (b:any,pool:string)=>b.receipt.logs.push({...log('Mint',{sender:wallet,amount0:1n,amount1:1n},pool),logIndex:'0x3'})
  ]){const f=pancakeFixture();change(f.bundle,f.pool);assert.notEqual(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'buy');}
});
test('quote routed through the transaction destination still needs matching amounts and no third-party funding',()=>{
  const f=pancakeFixture(),router=a(50);f.bundle.transaction.to=router;
  f.bundle.receipt.logs[1]={...log('Transfer',{from:wallet,to:router,value:100n},D.usdtBsc),logIndex:'0x1'};
  f.bundle.receipt.logs.push({...log('Transfer',{from:router,to:f.pool,value:100n},D.usdtBsc),logIndex:'0x3'});
  assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'buy');
  f.bundle.receipt.logs.push({...log('Transfer',{from:other,to:router,value:100n},D.usdtBsc),logIndex:'0x4'});
  assert.notEqual(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'buy');
});
test('explicit V2 output split preserves net tokens without mistaking unrelated donations for payment',()=>{
  const f=pancakeFixture();f.bundle.receipt.logs[0]=log('Transfer',{from:f.pool,to:wallet,value:980n});
  f.bundle.receipt.logs.push({...log('Transfer',{from:f.pool,to:token,value:20n}),logIndex:'0x3'});
  const r=classifyEvmActivity(f.event,f.bundle,at+1000);assert.equal(r.classification,'buy');assert.equal(r.trades[0].amountAtomic,'980');
  assert.ok(r.reasons.includes('POOL_OUTPUT_SPLIT_NET_AMOUNT'));
  f.bundle.receipt.logs[3]={...log('Transfer',{from:f.pool,to:other,value:20n}),logIndex:'0x3'};
  assert.notEqual(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'buy');
  f.bundle.receipt.logs[3]={...log('Transfer',{from:f.pool,to:token,value:10n}),logIndex:'0x3'};
  assert.notEqual(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'buy');
});
test('opposing transfers without supported swap evidence remain unknown even for delegated transactions',()=>{
  const f=pancakeFixture();f.bundle.transaction.from=other;f.bundle.receipt.logs.pop();
  assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'unknown');
});
test('Pancake V3 uses its actual protocol-fee event fields for buys and sells, and excludes liquidity changes',()=>{
  for(const side of ['buy','sell'] as const){const f=pancakeFixture();f.bundle.pools[0].protocol='pancake_v3' as any;
    f.bundle.receipt.logs=[log('Transfer',{from:side==='buy'?f.pool:wallet,to:side==='buy'?wallet:f.pool,value:1000n}),
      log('Transfer',{from:side==='buy'?wallet:f.pool,to:side==='buy'?f.pool:wallet,value:100n},D.usdtBsc),
      log('Swap',{sender:wallet,recipient:wallet,amount0:side==='buy'?-1000n:1000n,amount1:side==='buy'?100n:-100n,
        sqrtPriceX96:1n,liquidity:1n,tick:0,protocolFeesToken0:0n,protocolFeesToken1:1n},f.pool)].map((l,i)=>({...l,logIndex:'0x'+i}));
    assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,side);
    f.bundle.receipt.logs.push({...log('Mint',{sender:wallet,owner:wallet,tickLower:-1,tickUpper:1,amount:1n,amount0:1n,amount1:1n},f.pool),logIndex:'0x3'});
    assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'unknown');
    f.bundle.receipt.logs=f.bundle.receipt.logs.slice(-1);assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'liquidity');
  }
});
test('native BNB purchase binds the router deposit and exact pool quote transfer',()=>{
  const f=pancakeFixture(),router=a(50);f.bundle.transaction.to=router;f.bundle.transaction.value='0x64';f.bundle.pools[0].token1=D.wbnb;
  f.bundle.receipt.logs[1]={...log('Transfer',{from:router,to:f.pool,value:100n},D.wbnb),logIndex:'0x1'};
  f.bundle.receipt.logs.push({...log('Deposit',{dst:router,wad:100n},D.wbnb),logIndex:'0x3'});
  assert.equal(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'buy');
  f.bundle.receipt.logs[3].address=other;assert.notEqual(classifyEvmActivity(f.event,f.bundle,at+1000).classification,'buy');
});
test('pool membership is proved by the official factory at the receipt block, not the pool claim alone',async()=>{
  const f=pancakeFixture(),abi=parseAbi(['function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)','function getPair(address,address) view returns(address)']);
  let member=f.pool,queries=0;
  const rpc={request:async(method:string,params:any[])=>{assert.equal(method,'eth_call');assert.equal(params[1],f.bundle.receipt.blockNumber);queries++;
    const {functionName}=decodeFunctionData({abi,data:params[0].data}),result=functionName==='factory'?D.pancakeV2:functionName==='token0'?token:functionName==='token1'?D.usdtBsc:member;
    assert.equal(params[0].to,functionName==='getPair'?D.pancakeV2:f.pool);
    return encodeFunctionResult({abi,functionName,result:result as `0x${string}`});}};
  assert.equal((await loadSwapPools(f.event,f.bundle,rpc))[0].address,f.pool);assert.equal(queries,4);
  member=other;assert.deepEqual(await loadSwapPools(f.event,f.bundle,rpc),[]);
});
function solFixture(){
  const user=pk(10),mint=pk(20),userAta=pk(21),vault=pk(22),curve=pk(23),global=pk(24),fee=pk(25),creator=pk(26);
  const keys=[user,mint,userAta,vault,curve,global,fee,system,D.token,D.pump,creator,pk(27)];
  const signature=bs58.encode(new Uint8Array(64).fill(4)),event={...preview('solana'),wallet:user,txHash:signature,kind:'wallet_mention' as const,commitment:'processed' as const,slot:100};
  const preBalances=keys.map(()=>1_000_000_000),postBalances=[...preBalances];postBalances[0]-=100_005_000;postBalances[4]+=100_000_000;
  const bal=(index:number,owner:string,n:string)=>({accountIndex:index,owner,mint,uiTokenAmount:{amount:n,decimals:6}});
  const transferIx={programId:D.token,stackHeight:2,parsed:{type:'transferChecked',info:{source:vault,destination:userAta,authority:curve,mint,tokenAmount:{amount:'1000',decimals:6}}}};
  const ix={programId:D.pump,accounts:[global,fee,mint,curve,vault,userAta,user,system,D.token,creator,pk(27),D.pump],data:bs58.encode(Buffer.from('66063d1201daebea'+'00'.repeat(16),'hex'))};
  const raw:any={slot:100,blockTime:at/1000,transaction:{signatures:[signature],message:{accountKeys:keys.map((pubkey,i)=>({pubkey,signer:i===0,writable:true})),instructions:[ix]}},
    meta:{err:null,fee:5000,preBalances,postBalances,preTokenBalances:[bal(2,user,'0'),bal(3,curve,'100000')],postTokenBalances:[bal(2,user,'1000'),bal(3,curve,'99000')],innerInstructions:[{index:0,instructions:[transferIx]}]}};
  return {event,raw,user,mint,userAta,vault,curve,ix,transferIx};
}
const system='11111111111111111111111111111111';
test('Pump swap requires the real instruction, signer, token balance and program-scoped asset movement',()=>{
  const f=solFixture(),r=classifySolanaActivity(f.event,f.raw,at+1000);assert.equal(r.classification,'buy');assert.equal(r.trades[0].amountAtomic,'1000');assert.equal(r.trades[0].quoteAmountAtomic,'100000000');
  assert.equal(r.trades[0].protocol,'pump');assert.equal(r.confirmation,'confirmed');
});
test('nested supported swap is recognized through instruction scope, not the aggregator log label',()=>{
  const f=solFixture();f.raw.transaction.message.instructions=[{programId:pk(90),accounts:[],data:''}];
  f.raw.meta.innerInstructions[0].instructions=[{...f.ix,stackHeight:2},{...f.transferIx,stackHeight:3}] as any;
  assert.equal(classifySolanaActivity(f.event,f.raw,at+1000).classification,'buy');
  f.raw.meta.innerInstructions[0].instructions[1].stackHeight=2;
  assert.equal(classifySolanaActivity(f.event,f.raw,at+1000).classification,'unknown');
});
test('Solana transfer, fee/rent and ATA creation cannot masquerade as payment for a purchase',()=>{
  const f=solFixture();f.raw.transaction.message.instructions=[f.transferIx as any];f.raw.meta.innerInstructions=[];
  assert.equal(classifySolanaActivity(f.event,f.raw,at+1000).classification,'transfer');
  const feeOnly=solFixture();feeOnly.raw.meta.postBalances=[...feeOnly.raw.meta.preBalances];feeOnly.raw.meta.postBalances[0]-=5000;
  feeOnly.raw.meta.postTokenBalances=structuredClone(feeOnly.raw.meta.preTokenBalances);feeOnly.raw.transaction.message.instructions=[];feeOnly.raw.meta.innerInstructions=[];
  assert.equal(classifySolanaActivity(feeOnly.event,feeOnly.raw,at+1000).classification,'no_change');
  const rent=solFixture();rent.raw.meta.preBalances[2]=0;rent.raw.meta.postBalances[2]=2039280;rent.raw.meta.postBalances[0]-=2039280;
  assert.equal(classifySolanaActivity(rent.event,rent.raw,at+1000).classification,'buy');
});
test('fake program, non-signer wallet, missing token leg, wrong slot and unsafe numeric balances remain unknown',()=>{
  for(const change of [
    (f:any)=>f.ix.programId=pk(99),(f:any)=>f.raw.transaction.message.accountKeys[0].signer=false,
    (f:any)=>f.raw.meta.innerInstructions=[],(f:any)=>f.raw.slot=101,
    (f:any)=>f.raw.meta.preBalances[0]=Number.MAX_SAFE_INTEGER+1,(f:any)=>f.raw.meta.postTokenBalances[0].owner=pk(80),
    (f:any)=>f.raw.meta.postBalances[4]=f.raw.meta.preBalances[4],(f:any)=>delete f.raw.meta.err
  ]){const f=solFixture();change(f);assert.equal(classifySolanaActivity(f.event,f.raw,at+1000).classification,'unknown');}
  const f=solFixture();f.raw.meta.err={InstructionError:[0,1]} as any;assert.equal(classifySolanaActivity(f.event,f.raw,at+1000).classification,'failed');
});
test('Pump sell, same-owner token-account moves, wrapped native and liquidity changes are classified separately',()=>{
  const sell=solFixture();sell.ix.data=bs58.encode(Buffer.from('33e685a4017f83ad'+'00'.repeat(16),'hex'));
  [sell.raw.meta.preTokenBalances,sell.raw.meta.postTokenBalances]=[sell.raw.meta.postTokenBalances,sell.raw.meta.preTokenBalances];
  sell.raw.meta.postBalances[0]=sell.raw.meta.preBalances[0]+99995000;sell.raw.meta.postBalances[4]=sell.raw.meta.preBalances[4]-100000000;
  [sell.transferIx.parsed.info.source,sell.transferIx.parsed.info.destination]=[sell.userAta,sell.vault];
  assert.equal(classifySolanaActivity(sell.event,sell.raw,at+1000).classification,'sell');
  const self=solFixture();self.raw.transaction.message.instructions=[self.transferIx];self.raw.meta.innerInstructions=[];
  self.raw.meta.preTokenBalances[1].owner=self.user;self.raw.meta.postTokenBalances[1].owner=self.user;
  self.raw.meta.postBalances=[...self.raw.meta.preBalances];self.raw.meta.postBalances[0]-=5000;
  assert.equal(classifySolanaActivity(self.event,self.raw,at+1000).classification,'self_transfer');
  const wrap=solFixture();wrap.raw.meta.preTokenBalances=[{...wrap.raw.meta.preTokenBalances[0],mint:D.wsol}];
  wrap.raw.meta.postTokenBalances=[{...wrap.raw.meta.preTokenBalances[0],uiTokenAmount:{amount:'100000000',decimals:6}}];
  wrap.raw.meta.postBalances[4]=wrap.raw.meta.preBalances[4];wrap.raw.meta.postBalances[2]+=100000000;
  wrap.raw.transaction.message.instructions=[{programId:D.token,parsed:{type:'syncNative',info:{account:wrap.userAta}}}];wrap.raw.meta.innerInstructions=[];
  assert.equal(classifySolanaActivity(wrap.event,wrap.raw,at+1000).classification,'wrap');
  const liquidity=solFixture();liquidity.ix.programId=D.pumpAmm as any;liquidity.ix.accounts[2]=liquidity.user;
  liquidity.ix.data=bs58.encode(Buffer.from('f223c68952e1f2b6'+'00'.repeat(16),'hex'));
  assert.equal(classifySolanaActivity(liquidity.event,liquidity.raw,at+1000).classification,'liquidity');
});
test('PumpSwap and LaunchLab require scoped base and quote transfers, not just a program mention',()=>{
  for(const protocol of ['pumpswap','launchlab']){
    const f=solFixture(),quoteAccount=pk(40),quoteVault=pk(41),qmint=D.usdcSol;
    f.raw.transaction.message.accountKeys.push(...[quoteAccount,quoteVault,qmint].map(pubkey=>({pubkey,signer:false,writable:true})));
    f.raw.meta.preBalances.push(1000,1000,1000);f.raw.meta.postBalances.push(1000,1000,1000);
    f.raw.meta.postBalances[0]=f.raw.meta.preBalances[0]-5000;f.raw.meta.postBalances[4]=f.raw.meta.preBalances[4];
    f.raw.meta.preTokenBalances.push({accountIndex:12,owner:f.user,mint:qmint,uiTokenAmount:{amount:'100',decimals:6}});
    f.raw.meta.postTokenBalances.push({accountIndex:12,owner:f.user,mint:qmint,uiTokenAmount:{amount:'0',decimals:6}});
    f.ix.programId=(protocol==='pumpswap'?D.pumpAmm:'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj') as any;
    f.ix.data=bs58.encode(Buffer.from((protocol==='pumpswap'?'66063d1201daebea':'faea0d7bd59c13ec')+'00'.repeat(16),'hex'));
    f.ix.accounts=protocol==='pumpswap'?[f.curve,f.user,pk(42),f.mint,qmint,f.userAta,quoteAccount,f.vault,quoteVault]:
      [f.user,pk(42),pk(43),pk(44),f.curve,f.userAta,quoteAccount,f.vault,quoteVault,f.mint,qmint];
    f.raw.meta.innerInstructions[0].instructions.push({programId:D.token,stackHeight:2,parsed:{type:'transferChecked',info:{source:quoteAccount,destination:quoteVault,mint:qmint,tokenAmount:{amount:'100',decimals:6}}}});
    assert.equal(classifySolanaActivity(f.event,f.raw,at+1000).classification,'buy');
    f.raw.meta.innerInstructions[0].instructions.pop();assert.equal(classifySolanaActivity(f.event,f.raw,at+1000).classification,'unknown');
  }
});
test('classifier archive strips arbitrary payloads, keeps transfer evidence, and retractions cannot be resurrected',()=>{
  const store=new WalletActivityStore(':memory:');try{const f=evmFixture(),r=classifyEvmActivity(f.event,f.bundle,at+1000);
    assert.equal(store.record({...r,Authorization:'secret',rawResponse:'secret'} as any),true);assert.equal(store.status().counts.buy,1);
    assert.equal(JSON.stringify(store.status()).includes('secret'),false);assert.equal(store.status().recent[0].transfers?.length,2);
    assert.equal(store.record({...r,classification:'retracted',trades:[],reasons:['CHAIN_EVENT_RETRACTED']}),true);
    assert.equal(store.record(r),false);assert.equal(store.status().counts.retracted,1);assert.equal(store.status().counts.buy,undefined);
    const db=(store as any).db,prepare=db.prepare.bind(db);db.prepare=(sql:string)=>{
      assert.equal(/GROUP BY kind/i.test(sql),false,'status must use the write-through count cache');return prepare(sql);
    };
    assert.equal(store.status().counts.retracted,1);
  }finally{store.close();}
});
test('RPC verifier checks chain identity, requests confirmed parsed Solana and coalesces transaction fetches',async()=>{
  const f=solFixture(),calls:any[]=[];const verifier=new WalletActivityVerifier({solana:{http:'http://test.invalid'}},()=>at+1000,()=>({request:async(method,params)=>{
    calls.push({method,params});return method==='getGenesisHash'?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':f.raw;}}));
  try{assert.equal((await verifier.verify(f.event)).classification,'buy');await verifier.verify(f.event);
    assert.equal(calls.filter(c=>c.method==='getTransaction').length,1);assert.equal(calls[1].params[1].commitment,'confirmed');assert.equal(calls[1].params[1].encoding,'jsonParsed');
  }finally{verifier.stop();}
  const wrong=new WalletActivityVerifier({bsc:{http:'http://test.invalid'}},()=>at+1000,()=>({request:async()=> '0x1'}));
  assert.equal((await wrong.verify(preview())).reasons[0],'TRANSACTION_CHAIN_MISMATCH');wrong.stop();
});
