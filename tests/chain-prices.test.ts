import {test} from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {address,getProgramDerivedAddress} from '@solana/addresses';
import {decodeFunctionData,encodeFunctionResult,parseAbi,type Hex} from 'viem';
import {CHAIN_PRICE_DEPLOYMENTS as D,discoverPool,readPoolPrice,type ChainRpc,type VerifiedPool,type UsdAnchor} from '../src/chain-prices.js';
const NOW=new Date('2026-10-11T08:00:00Z'),options={now:()=>NOW};
const target='FsjS5gGTv8XfAeUyDhEto6nL2Q6saK6AYV5nk41Cpump';
const account=(data:Buffer,owner:string)=>({data:[data.toString('base64'),'base64'],owner,executable:false});
const bytes=(key:string)=>bs58.decode(key);
async function pda(program:string,seeds:Uint8Array[]) {return getProgramDerivedAddress({programAddress:address(program),seeds});}
function mint(decimals:number,extended=false) {
 const b=Buffer.alloc(extended?234:82);b[44]=decimals;b[45]=1;
 if(extended){b[165]=1;b.writeUInt16LE(18,166);b.writeUInt16LE(64,168);}
 return b;
}
function vault(mint:string,pool:string,amount:bigint,extended=false) {
 const b=Buffer.alloc(extended?170:165);b.set(bytes(mint),0);b.set(bytes(pool),32);b.writeBigUInt64LE(amount,64);b[108]=1;
 if(extended){b[165]=2;b.writeUInt16LE(7,166);}return b;
}
async function solFixture() {
 const [creator]=await pda(D.pump,[Buffer.from('pool-authority'),bytes(target)]);
 const [pool,bump]=await pda(D.pumpAmm,[Buffer.from('pool'),Buffer.alloc(2),bytes(creator),bytes(target),bytes(D.wsol)]);
 const [lp]=await pda(D.pumpAmm,[Buffer.from('pool_lp_mint'),bytes(pool)]);
 const [baseVault]=await pda(D.associatedToken,[bytes(pool),bytes(D.token2022),bytes(target)]);
 const [quoteVault]=await pda(D.associatedToken,[bytes(pool),bytes(D.token),bytes(D.wsol)]);
 const poolData=Buffer.alloc(301);poolData.set([241,154,109,4,17,177,109,188]);poolData[8]=bump;
 for(const [key,offset] of [[creator,11],[target,43],[D.wsol,75],[lp,107],[baseVault,139],[quoteVault,171]] as const)poolData.set(bytes(key),offset);
 poolData.writeBigUInt64LE(10_000_000_000n,245);poolData.writeBigUInt64LE(100_000_000n,271);
 const entries=new Map<string,{data:Buffer,owner:string}>([
  [pool,{data:poolData,owner:D.pumpAmm}],[target,{data:mint(6,true),owner:D.token2022}],
  [D.wsol,{data:mint(9),owner:D.token}],[baseVault,{data:vault(target,pool,1_000_000_000_000n,true),owner:D.token2022}],
  [quoteVault,{data:vault(D.wsol,pool,20_000_000_000n),owner:D.token}],
 ]);
 let blockTime=NOW.getTime()/1000,slot=12345;const methods:string[]=[];
 const rpc:ChainRpc={request:async(method,params)=>{
  methods.push(method);
  if(method==='getGenesisHash')return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  if(method==='getBlockTime')return blockTime;
  if(method==='getMultipleAccounts')return {context:{slot},value:(params[0] as string[]).map(key=>{const a=entries.get(key);return a?account(a.data,a.owner):null;})};
  throw new Error('unexpected method');
 }};
 return {rpc,entries,pool,baseVault,quoteVault,poolData,methods,setTime:(n:number)=>blockTime=n,setSlot:(n:number)=>slot=n};
}
async function supported(f:Awaited<ReturnType<typeof solFixture>>) {
 const d=await discoverPool({chain:'solana',address:target},{poolAddress:f.pool},f.rpc,options);
 assert.equal(d.status,'supported',JSON.stringify(d));if(d.status!=='supported')throw new Error('failed');return d;
}
const solAnchor:UsdAnchor={chain:'solana',address:D.wsol,priceUsd:100,observedAt:NOW.toISOString(),source:'vendor_reference'};

test('canonical graduated PumpSwap + Token2022 metadata prices virtual reserves using one account snapshot',async()=>{
 const f=await solFixture(),d=await supported(f);assert.equal(Object.isFrozen(d.pool),true);
 assert.equal(d.subscriptions.length,3);assert.equal(d.subscriptions[0].subscribeMethod,'accountSubscribe');
 const before=f.methods.length,r=await readPoolPrice(d.pool,f.rpc,solAnchor,options);
 assert.equal(r.status,'sampled');if(r.status!=='sampled')return;
 assert.ok(Math.abs(r.price.priceUsd-0.003)<1e-12); // (20+10 SOL)/1m tokens * $100, not vault-only $0.002.
 assert.equal(r.price.metadata.slot,12345);assert.equal(r.price.metadata.anchorSource,'vendor_reference');
 assert.equal(r.price.metadata.pricing,'spot_before_fees_and_slippage');assert.equal(r.price.source,'chain_pool_sample');
 assert.deepEqual(f.methods.slice(before),['getMultipleAccounts','getBlockTime']);
 assert.ok(f.methods.every(m=>!m.includes('send')&&!m.includes('sign')));
});

test('canonical native mint zero supply remains a valid quote',async()=>{const f=await solFixture();assert.equal(f.entries.get(D.wsol)!.data.readBigUInt64LE(36),0n);await supported(f);});

test('pool owner, full mint, PDA and vault ownership cannot be inferred from suffix/metadata',async()=>{
 for(const mutation of [
  (f:Awaited<ReturnType<typeof solFixture>>)=>f.entries.get(f.pool)!.owner=D.pump,
  (f:Awaited<ReturnType<typeof solFixture>>)=>f.poolData.set(bytes(D.usdcSol),43),
  (f:Awaited<ReturnType<typeof solFixture>>)=>f.poolData[8]^=1,
  (f:Awaited<ReturnType<typeof solFixture>>)=>f.entries.get(f.baseVault)!.data.set(bytes(D.usdcSol),32),
 ]){const f=await solFixture();mutation(f);const r=await discoverPool({chain:'solana',address:target},{poolAddress:f.pool},f.rpc,options);assert.equal(r.status,'unsupported');}
});

test('unsupported Token2022 fee/hook/scaled amount and unreviewed pool modes fail closed',async()=>{
 for(const mutation of [
  (f:Awaited<ReturnType<typeof solFixture>>)=>f.entries.get(target)!.data.writeUInt16LE(1,166),
  (f:Awaited<ReturnType<typeof solFixture>>)=>f.entries.get(target)!.data.writeUInt16LE(25,166),
  (f:Awaited<ReturnType<typeof solFixture>>)=>f.poolData[243]=1,
  (f:Awaited<ReturnType<typeof solFixture>>)=>f.poolData[270]=1,
 ]){const f=await solFixture();mutation(f);assert.equal((await discoverPool({chain:'solana',address:target},{poolAddress:f.pool},f.rpc,options)).status,'unsupported');}
});

test('pool binding and vault frozen state are checked again on every sample',async()=>{
 const f=await solFixture(),d=await supported(f);f.entries.get(f.baseVault)!.data[108]=2;
 assert.deepEqual(await readPoolPrice(d.pool,f.rpc,solAnchor,options),{status:'unavailable',reason:'POOL_VAULT_MISMATCH'});
});

test('negative virtual quote adjustment is signed and accrued fees cannot be counted as liquid',async()=>{
 const f=await solFixture(),d=await supported(f);f.poolData.writeBigUInt64LE(BigInt.asUintN(64,-5_000_000_000n),245);f.poolData.writeBigUInt64LE((1n<<64n)-1n,253);
 const r=await readPoolPrice(d.pool,f.rpc,solAnchor,options);assert.equal(r.status,'sampled');if(r.status==='sampled')assert.ok(Math.abs(r.price.priceUsd-0.0015)<1e-12);
 f.poolData.writeBigUInt64LE(20_000_000_000n,271);
 assert.deepEqual(await readPoolPrice(d.pool,f.rpc,solAnchor,options),{status:'unavailable',reason:'POOL_LIQUIDITY_EMPTY'});
});

test('anchor absent, expired, wrong chain/mint and future anchors never create USD samples',async()=>{
 const f=await solFixture(),d=await supported(f),before=f.methods.length;
 for(const a of [undefined,{...solAnchor,address:D.usdcSol},{...solAnchor,chain:'bsc' as const},{...solAnchor,observedAt:new Date(NOW.getTime()-121000).toISOString()},
  {...solAnchor,observedAt:new Date(NOW.getTime()+6000).toISOString()},{...solAnchor,priceUsd:Infinity}])assert.equal((await readPoolPrice(d.pool,f.rpc,a,options)).status,'unavailable');
 assert.equal(f.methods.length,before);
});

test('stale node, unavailable block time and invalid slot fail without stamping a fresh historical price',async()=>{
 const f=await solFixture(),d=await supported(f);f.setTime(NOW.getTime()/1000-121);
 assert.deepEqual(await readPoolPrice(d.pool,f.rpc,solAnchor,options),{status:'unavailable',reason:'CHAIN_PRICE_DATA_STALE'});
 f.setTime(NaN);assert.equal((await readPoolPrice(d.pool,f.rpc,solAnchor,options)).status,'unavailable');
 f.setSlot(-1);assert.equal((await readPoolPrice(d.pool,f.rpc,solAnchor,options)).status,'unavailable');
});

test('unsupported chains, fabricated verified objects and RPC errors are explicit, never leak credentials',async()=>{
 const f=await solFixture(),d=await supported(f);
 assert.deepEqual(await readPoolPrice({...d.pool},f.rpc,solAnchor,options),{status:'unavailable',reason:'POOL_NOT_VERIFIED'});
 assert.deepEqual(await discoverPool({chain:'robinhood',address:'0x'+'1'.repeat(40)},{poolAddress:'0x'+'2'.repeat(40)},f.rpc,options),{status:'unsupported',reason:'CHAIN_POOL_PROTOCOL_UNSUPPORTED'});
 const rpc={request:async()=>{throw new Error('https://private-rpc/?secret=abc');}};
 assert.deepEqual(await readPoolPrice(d.pool,rpc,solAnchor,options),{status:'unavailable',reason:'CHAIN_PRICE_RPC_FAILED'});
});

const evmAbi=parseAbi([
 'function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)',
 'function decimals() view returns(uint8)','function fee() view returns(uint24)','function getPair(address,address) view returns(address)',
 'function getPool(address,address,uint24) view returns(address)','function getReserves() view returns(uint112,uint112,uint32)',
 'function liquidity() view returns(uint128)','function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)',
]);
function evmFixture(v3=false,inverse=false) {
 const token=inverse?'0xff'+'12'.repeat(19):'0x11'+'12'.repeat(19),pool='0x'+'ab'.repeat(20),hash='0x'+'cd'.repeat(32);
 let factory:string=v3?D.pancakeV3:D.pancakeV2,registered=pool,chain='0x38',changed=false,time=NOW.getTime()/1000,reserves:[bigint,bigint,number]=[1_000_000_000_000n,50_000_000_000_000_000_000n,1],liquidity=1000n;
 const methods:{method:string;params:unknown[]}[]=[];
 const rpc:ChainRpc={request:async(method,params)=>{
  methods.push({method,params});
  if(method==='eth_chainId')return chain;if(method==='eth_blockNumber')return '0x1234';
  if(method==='eth_getBlockByNumber')return {number:'0x1234',hash:changed?'0x'+'ef'.repeat(32):hash,timestamp:'0x'+time.toString(16)};
  if(method==='eth_call'){
   assert.equal(params[1],'0x1234');const request=params[0] as {to:string;data:Hex};const decoded=decodeFunctionData({abi:evmAbi,data:request.data});let result:unknown;
   switch(decoded.functionName){
    case 'factory':result=factory;break;
    case 'token0':result=inverse?D.wbnb:token;break;
    case 'token1':result=inverse?token:D.wbnb;break;
    case 'decimals':result=request.to===token?6:18;break;
    case 'fee':result=2500;break;
    case 'getPair':case 'getPool':result=registered;break;
    case 'getReserves':result=reserves;break;
    case 'liquidity':result=liquidity;break;
    case 'slot0':result=[2n**97n,13863,0,1,1,0,true];break;
   }
   return encodeFunctionResult({abi:evmAbi,functionName:decoded.functionName,result:result as any});
  }
  throw new Error('unexpected method');
 }};
 return {rpc,token,pool,methods,mutate:(values:{factory?:string;registered?:string;chain?:string;changed?:boolean;time?:number;reserves?:typeof reserves;liquidity?:bigint})=>{
  factory=values.factory??factory;registered=values.registered??registered;chain=values.chain??chain;changed=values.changed??changed;time=values.time??time;reserves=values.reserves??reserves;liquidity=values.liquidity??liquidity;
 }};
}
const bscAnchor:UsdAnchor={chain:'bsc',address:D.wbnb,priceUsd:500,observedAt:NOW.toISOString(),source:'vendor_reference'};
async function evmSupported(f:ReturnType<typeof evmFixture>) {
 const d=await discoverPool({chain:'bsc',address:f.token},{poolAddress:f.pool},f.rpc,options);assert.equal(d.status,'supported',JSON.stringify(d));if(d.status!=='supported')throw new Error('failed');return d;
}

test('Pancake V2 factory mapping + full token binding, pinned reserves and quote anchor produce spot price',async()=>{
 const f=evmFixture(),d=await evmSupported(f),r=await readPoolPrice(d.pool,f.rpc,bscAnchor,options);
 assert.equal(r.status,'sampled');if(r.status==='sampled'){assert.ok(Math.abs(r.price.priceUsd-0.025)<1e-12);assert.equal(r.price.metadata.blockNumber,'0x1234');}
 assert.equal(d.subscriptions.length,1);assert.deepEqual(d.subscriptions[0].params,['logs',{address:f.pool}]);
 assert.ok(f.methods.every(v=>['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_call'].includes(v.method)));
});

test('V3 sqrt price converts token decimals in both orientations with live liquidity',async()=>{
 for(const inverse of [false,true]){
  const f=evmFixture(true,inverse),d=await evmSupported(f),r=await readPoolPrice(d.pool,f.rpc,bscAnchor,options);
  assert.equal(r.status,'sampled');if(r.status==='sampled')assert.ok(Math.abs(r.price.priceUsd-(inverse?1.25e-10:2e-9))<1e-20);
  f.mutate({liquidity:0n});assert.deepEqual(await readPoolPrice(d.pool,f.rpc,bscAnchor,options),{status:'unavailable',reason:'POOL_LIQUIDITY_EMPTY'});
 }
});

test('pool claiming factory membership, wrong network, missing pair mapping and empty reserves are rejected',async()=>{
 for(const values of [{factory:'0x'+'9'.repeat(40)},{registered:'0x'+'0'.repeat(40)},{chain:'0x1'},{reserves:[0n,1n,1] as [bigint,bigint,number]}]){
  const f=evmFixture();f.mutate(values);assert.equal((await discoverPool({chain:'bsc',address:f.token},{poolAddress:f.pool},f.rpc,options)).status,'unsupported');
 }
});

test('EVM reorg between pinned reads invalidates the sample',async()=>{
 const f=evmFixture(),d=await evmSupported(f);let blockCalls=0;
 const rpc:ChainRpc={request:async(method,params)=>{if(method==='eth_getBlockByNumber'&&++blockCalls===2)f.mutate({changed:true});return f.rpc.request(method,params);}};
 assert.deepEqual(await readPoolPrice(d.pool,rpc,bscAnchor,options),{status:'unavailable',reason:'POOL_SNAPSHOT_REORG'});
});

test('zero USD, overflowing USD and stale EVM block cannot be used as executable price',async()=>{
 const f=evmFixture(),d=await evmSupported(f);f.mutate({reserves:[1n,(1n<<112n)-1n,1]});
 assert.equal((await readPoolPrice(d.pool,f.rpc,{...bscAnchor,priceUsd:1e308},options)).status,'unavailable');
 f.mutate({time:NOW.getTime()/1000-121});assert.equal((await readPoolPrice(d.pool,f.rpc,bscAnchor,options)).status,'unavailable');
});

test('Solana contexts cannot rewind and unknown nonzero padded pool fields stay unsupported',async()=>{
 const f=await solFixture(),d=await supported(f);f.setSlot(12346);
 assert.equal((await readPoolPrice(d.pool,f.rpc,solAnchor,options)).status,'sampled');f.setSlot(12345);
 assert.deepEqual(await readPoolPrice(d.pool,f.rpc,solAnchor,options),{status:'unavailable',reason:'POOL_SNAPSHOT_INVALID'});
 f.setSlot(12346);f.poolData[287]=1;
 assert.deepEqual(await readPoolPrice(d.pool,f.rpc,solAnchor,options),{status:'unavailable',reason:'POOL_LAYOUT_UNSUPPORTED'});
});

test('anchor is rechecked after slow RPC; token metadata market prices are never an onchain substitute',async()=>{
 const f=await solFixture(),d=await supported(f);let time=NOW.getTime();
 const rpc:ChainRpc={request:async(m,p)=>{const r=await f.rpc.request(m,p);if(m==='getBlockTime')time+=2000;return r;}};
 const anchor={...solAnchor,observedAt:new Date(NOW.getTime()-119000).toISOString()};
 assert.equal((await readPoolPrice(d.pool,rpc,anchor,{now:()=>new Date(time)})).status,'unavailable');
 const metadata={poolAddress:D.pump,priceUsd:999,ath:99999};
 assert.equal((await discoverPool({chain:'solana',address:target},metadata,f.rpc,options)).status,'unsupported');
});

test('short CAIP chain ID is not accepted as the complete Solana mainnet genesis hash',async()=>{
 const f=await solFixture();const rpc:ChainRpc={request:(m,p)=>m==='getGenesisHash'?Promise.resolve('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'):f.rpc.request(m,p)};
 assert.deepEqual(await discoverPool({chain:'solana',address:target},{poolAddress:f.pool},rpc,options),{status:'unsupported',reason:'CHAIN_IDENTITY_MISMATCH'});
});
