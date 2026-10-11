import bs58 from 'bs58';
import {address, getProgramDerivedAddress} from '@solana/addresses';
import {decodeFunctionResult, encodeFunctionData, parseAbi, type Hex} from 'viem';
import type {Chain} from './types.js';

/** Read-only RPC. Transport rate limits, credentials and reconnects belong to the caller. */
export interface ChainRpc {request(method:string, params:unknown[]):Promise<unknown>;}
export interface PoolSubscription {key:string;subscribeMethod:string;params:unknown[];unsubscribeMethod:string;notificationMethod:string;}
export interface PriceToken {chain:Chain;address:string;}
export interface UsdAnchor extends PriceToken {priceUsd:number;observedAt:string;source:'vendor_reference';}
export interface PoolReadOptions {now?:()=>Date;maxAgeSec?:number;}
export interface VerifiedPool extends PriceToken {
  readonly poolAddress:string;readonly protocol:'pumpswap'|'pancake_v2'|'pancake_v3';
  readonly quoteAddress:string;readonly baseDecimals:number;readonly quoteDecimals:number;
  readonly baseVault?:string;readonly quoteVault?:string;readonly token0?:string;readonly token1?:string;readonly fee?:number;
}
export interface ChainPoolPrice extends PriceToken {
  priceUsd:number;observedAt:string;source:'chain_pool_sample';
  metadata:{pool:string;protocol:VerifiedPool['protocol'];quoteAddress:string;quotePriceUsd:number;anchorAt:string;
    anchorSource:'vendor_reference';confirmation?:'confirmed'|'rpc_observed';blockNumber?:string;blockHash?:string;slot?:number;blockTime:string;pricing:'spot_before_fees_and_slippage'};
}
export type PoolDiscovery={status:'supported';pool:VerifiedPool;subscriptions:PoolSubscription[]}|{status:'unsupported';reason:string};
export type PoolPriceResult={status:'sampled';price:ChainPoolPrice}|{status:'unavailable';reason:string};

// Primary specifications: pump-fun/pump-public-docs @2293f9a66c654e9fe82dc5e8f4618538f24bb35f
// and @pump-fun/pump-swap-sdk 2.1.0 src/types/sdk.ts, offlinePumpAmm.ts, buy.ts/sell.ts.
export const CHAIN_PRICE_DEPLOYMENTS=Object.freeze({
  pumpAmm:'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',pump:'6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  token:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',token2022:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associatedToken:'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  wsol:'So11111111111111111111111111111111111111112',usdcSol:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  // @pancakeswap/v2-sdk 1.2.3 and @pancakeswap/v3-sdk 3.10.3 factory constants.
  pancakeV2:'0xca143ce32fe78f1f7019d7d551a6402fc5350c73',pancakeV3:'0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  wbnb:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',usdtBsc:'0x55d398326f99059ff775485246999027b3197955',
  usdcBsc:'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
});
const D=CHAIN_PRICE_DEPLOYMENTS;
const verified=new WeakSet<VerifiedPool>();
const contexts=new WeakMap<VerifiedPool,{slot?:number;block?:bigint}>();
const abi=parseAbi([
  'function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)',
  'function decimals() view returns(uint8)','function fee() view returns(uint24)',
  'function getPair(address,address) view returns(address)','function getPool(address,address,uint24) view returns(address)',
  'function getReserves() view returns(uint112,uint112,uint32)','function liquidity() view returns(uint128)',
  'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)',
]);
class PriceError extends Error {}
function fail(code:string):never {throw new PriceError(code);}
function reason(error:unknown):string {return error instanceof PriceError?error.message:'CHAIN_PRICE_RPC_FAILED';}
function obj(v:unknown):Record<string,any> {if(!v||typeof v!=='object'||Array.isArray(v))fail('CHAIN_PRICE_RESPONSE_INVALID');return v as Record<string,any>;}
function evm(v:unknown):string {if(typeof v!=='string'||!/^0x[\da-f]{40}$/i.test(v))fail('POOL_ADDRESS_INVALID');return v.toLowerCase();}
function sol(v:unknown):string {if(typeof v!=='string')fail('POOL_ADDRESS_INVALID');try {if(bs58.decode(v).length!==32)fail('POOL_ADDRESS_INVALID');return v;}catch {return fail('POOL_ADDRESS_INVALID');}}
function same(chain:Chain,a:string,b:string):boolean {return chain==='solana'?a===b:a.toLowerCase()===b.toLowerCase();}
function current(options:PoolReadOptions):number {const n=(options.now?.()??new Date()).getTime();if(!Number.isFinite(n))fail('CHAIN_PRICE_CLOCK_INVALID');return n;}
function fresh(at:number,options:PoolReadOptions):void {
  const maxAge=options.maxAgeSec??120;
  if(!Number.isFinite(maxAge)||maxAge<=0||maxAge>120)fail('CHAIN_PRICE_MAX_AGE_INVALID');
  const age=current(options)-at;
  if(!Number.isFinite(at)||age < -5_000||age>maxAge*1_000)fail('CHAIN_PRICE_DATA_STALE');
}
function positive(n:number):number {if(!Number.isFinite(n)||n<=0)fail('CHAIN_PRICE_VALUE_INVALID');return n;}
function decimals(n:unknown):number {if(typeof n!=='number'||!Number.isInteger(n)||n<0||n>36)fail('POOL_DECIMALS_UNSUPPORTED');return n;}
function quoteAllowed(chain:Chain,q:string):void {
  const allowed:readonly string[]=chain==='solana'?[D.wsol,D.usdcSol]:[D.wbnb,D.usdtBsc,D.usdcBsc];
  if(!allowed.includes(q))fail('POOL_QUOTE_UNSUPPORTED');
}
async function derive(program:string,seeds:Uint8Array[]):Promise<readonly [string,number]> {
  return getProgramDerivedAddress({programAddress:address(program),seeds});
}
function pubkey(bytes:Buffer,offset:number):string {return bs58.encode(bytes.subarray(offset,offset+32));}
function account(raw:unknown):{owner:string;data:Buffer} {
  const a=obj(raw);if(a.executable!==false||typeof a.owner!=='string'||!Array.isArray(a.data)||a.data.length!==2||a.data[1]!=='base64'||typeof a.data[0]!=='string')fail('POOL_ACCOUNT_INVALID');
  if(a.data[0].length>32_768||!/^[A-Za-z\d+/]*={0,2}$/.test(a.data[0]))fail('POOL_ACCOUNT_INVALID');
  return {owner:a.owner,data:Buffer.from(a.data[0],'base64')};
}
function tokenLayout(a:{owner:string;data:Buffer},kind:'mint'|'vault'):void {
  const size=kind==='mint'?82:165;
  if(a.owner!==D.token&&a.owner!==D.token2022)fail('POOL_TOKEN_PROGRAM_UNSUPPORTED');
  if(a.data.length<size)fail('POOL_TOKEN_LAYOUT_INVALID');
  if(a.owner===D.token) {if(a.data.length!==size)fail('POOL_TOKEN_LAYOUT_INVALID');return;}
  if(a.data.length===size)return;
  if(a.data.length<166||a.data[165] !== (kind==='mint'?1:2))fail('POOL_TOKEN_LAYOUT_INVALID');
  if(kind==='mint'&&a.data.subarray(82,165).some(x=>x!==0))fail('POOL_TOKEN_LAYOUT_INVALID');
  // Metadata and immutable owner have no effect on price units. Transfer fees/hooks,
  // confidential balances, interest/scaled UI amounts and unknown extensions need adapters.
  const seen=new Set<number>();
  for(let i=166;i<a.data.length;) {
    if(a.data.subarray(i).every(x=>x===0))break;
    if(i+4>a.data.length)fail('POOL_TOKEN_LAYOUT_INVALID');
    const type=a.data.readUInt16LE(i),len=a.data.readUInt16LE(i+2);i+=4;
    if(i+len>a.data.length||seen.has(type))fail('POOL_TOKEN_LAYOUT_INVALID');seen.add(type);
    if(kind==='mint'?!(type===18&&len===64||type===19&&len>=80):!(type===7&&len===0))fail('POOL_TOKEN_EXTENSION_UNSUPPORTED');
    i+=len;
  }
}
function mint(raw:unknown):{owner:string;decimals:number} {
  const a=account(raw);tokenLayout(a,'mint');
  // The canonical wrapped-native mint has zero recorded supply.
  if(a.data[45]!==1)fail('POOL_MINT_UNINITIALIZED');
  return {owner:a.owner,decimals:decimals(a.data[44])};
}
function vault(raw:unknown,mintAddress:string,authority:string,program:string):bigint {
  const a=account(raw);tokenLayout(a,'vault');
  if(a.owner!==program||pubkey(a.data,0)!==mintAddress||pubkey(a.data,32)!==authority||a.data[108]!==1)fail('POOL_VAULT_MISMATCH');
  return a.data.readBigUInt64LE(64);
}
function pumpState(raw:unknown) {
  const a=account(raw);
  if(a.owner!==D.pumpAmm)fail('POOL_PROGRAM_UNSUPPORTED');
  if(!([211,243,244,245,261,270,271,287,301].includes(a.data.length))||!a.data.subarray(0,8).equals(Buffer.from([241,154,109,4,17,177,109,188])))fail('POOL_LAYOUT_UNSUPPORTED');
  if(a.data.length>287&&a.data.subarray(287).some(x=>x!==0))fail('POOL_LAYOUT_UNSUPPORTED');
  const b=Buffer.alloc(Math.max(287,a.data.length));a.data.copy(b);
  if(b.readUInt16LE(9)!==0)fail('POOL_NOT_CANONICAL_PUMP');
  if(b[243]!==0||b[244]>1||b[269]>1||b[270]!==0)fail('POOL_MODE_UNSUPPORTED');
  // i128 is signed: collected fees can make virtual quote reserves negative.
  const virtual=BigInt.asIntN(128,b.readBigUInt64LE(245)|(b.readBigUInt64LE(253)<<64n));
  return {bump:b[8],creator:pubkey(b,11),base:pubkey(b,43),quote:pubkey(b,75),lp:pubkey(b,107),
    baseVault:pubkey(b,139),quoteVault:pubkey(b,171),virtual,fees:b.readBigUInt64LE(271)+b.readBigUInt64LE(279)};
}
async function validatePumpAddress(poolAddress:string,p:ReturnType<typeof pumpState>):Promise<void> {
  const [creator]=await derive(D.pump,[Buffer.from('pool-authority'),bs58.decode(p.base)]);
  const [pool,bump]=await derive(D.pumpAmm,[Buffer.from('pool'),Buffer.alloc(2),bs58.decode(creator),bs58.decode(p.base),bs58.decode(p.quote)]);
  const [lp]=await derive(D.pumpAmm,[Buffer.from('pool_lp_mint'),bs58.decode(poolAddress)]);
  if(creator!==p.creator||pool!==poolAddress||bump!==p.bump||lp!==p.lp)fail('POOL_NOT_CANONICAL_PUMP');
}
async function solAccounts(rpc:ChainRpc,keys:string[],minContextSlot?:number) {
  const r=obj(await rpc.request('getMultipleAccounts',[keys,{encoding:'base64',commitment:'confirmed',...(minContextSlot===undefined?{}:{minContextSlot})}]));
  const slot=obj(r.context).slot;
  if(!Number.isSafeInteger(slot)||slot<0||minContextSlot!==undefined&&slot<minContextSlot||!Array.isArray(r.value)||r.value.length!==keys.length)fail('POOL_SNAPSHOT_INVALID');
  return {slot:slot as number,values:r.value as unknown[]};
}
async function solSnapshot(pool:VerifiedPool,rpc:ChainRpc,options:PoolReadOptions) {
  const s=await solAccounts(rpc,[pool.poolAddress,pool.address,pool.quoteAddress,pool.baseVault!,pool.quoteVault!],contexts.get(pool)?.slot);
  const p=pumpState(s.values[0]);await validatePumpAddress(pool.poolAddress,p);
  if(p.base!==pool.address||p.quote!==pool.quoteAddress||p.baseVault!==pool.baseVault||p.quoteVault!==pool.quoteVault)fail('POOL_BINDING_CHANGED');
  const base=mint(s.values[1]),quote=mint(s.values[2]);
  if(base.decimals!==pool.baseDecimals||quote.decimals!==pool.quoteDecimals)fail('POOL_BINDING_CHANGED');
  for(const [mintAddress,program,key] of [[p.base,base.owner,p.baseVault],[p.quote,quote.owner,p.quoteVault]]) {
    const [ata]=await derive(D.associatedToken,[bs58.decode(pool.poolAddress),bs58.decode(program),bs58.decode(mintAddress)]);
    if(ata!==key)fail('POOL_VAULT_MISMATCH');
  }
  const baseAmount=vault(s.values[3],p.base,pool.poolAddress,base.owner),quoteAmount=vault(s.values[4],p.quote,pool.poolAddress,quote.owner);
  // SDK: vault+virtual prices the pool; vault-fee buckets is available liquidity.
  if(baseAmount<=0n||quoteAmount-p.fees<=0n||quoteAmount+p.virtual<=0n)fail('POOL_LIQUIDITY_EMPTY');
  const time=await rpc.request('getBlockTime',[s.slot]);
  if(typeof time!=='number'||!Number.isSafeInteger(time))fail('POOL_BLOCK_TIME_UNAVAILABLE');
  fresh(time*1000,options);
  return {ratio:positive(Number(quoteAmount+p.virtual)/Number(baseAmount)*10**(base.decimals-quote.decimals)),slot:s.slot,blockTime:new Date(time*1000).toISOString()};
}
function hexQuantity(v:unknown):Hex {if(typeof v!=='string'||!/^0x(?:0|[1-9a-f][\da-f]*)$/i.test(v))fail('POOL_BLOCK_INVALID');return v as Hex;}
async function block(rpc:ChainRpc,options:PoolReadOptions) {
  const number=hexQuantity(await rpc.request('eth_blockNumber',[])),b=obj(await rpc.request('eth_getBlockByNumber',[number,false]));
  if(hexQuantity(b.number).toLowerCase()!==number.toLowerCase()||typeof b.hash!=='string'||!/^0x[\da-f]{64}$/i.test(b.hash))fail('POOL_BLOCK_INVALID');
  const time=Number(BigInt(hexQuantity(b.timestamp)))*1000;fresh(time,options);
  return {number,hash:b.hash as string,blockTime:new Date(time).toISOString()};
}
async function call(rpc:ChainRpc,to:string,name:string,args:unknown[],at:Hex):Promise<any> {
  const data=encodeFunctionData({abi,functionName:name as any,args:args as any});
  const result=await rpc.request('eth_call',[{to,data},at]);
  if(typeof result!=='string'||!/^0x[\da-f]+$/i.test(result))fail('POOL_CONTRACT_RESPONSE_INVALID');
  return decodeFunctionResult({abi,functionName:name as any,data:result as Hex});
}
async function evmBinding(poolAddress:string,token:PriceToken,rpc:ChainRpc,at:Hex) {
  const factory=evm(await call(rpc,poolAddress,'factory',[],at));
  if(factory!==D.pancakeV2&&factory!==D.pancakeV3)fail('POOL_FACTORY_UNSUPPORTED');
  const token0=evm(await call(rpc,poolAddress,'token0',[],at)),token1=evm(await call(rpc,poolAddress,'token1',[],at));
  if(token0===token1||BigInt(token0)>=BigInt(token1)||token0!==token.address&&token1!==token.address)fail('POOL_TOKEN_MISMATCH');
  const quoteAddress=token0===token.address?token1:token0;quoteAllowed(token.chain,quoteAddress);
  const fee=factory===D.pancakeV3?Number(await call(rpc,poolAddress,'fee',[],at)):undefined;
  if(fee!==undefined&&(!Number.isInteger(fee)||fee<=0||fee>=1_000_000))fail('POOL_FEE_INVALID');
  const registered=evm(await call(rpc,factory,fee===undefined?'getPair':'getPool',fee===undefined?[token0,token1]:[token0,token1,fee],at));
  if(registered!==poolAddress)fail('POOL_FACTORY_BINDING_MISMATCH');
  const baseDecimals=decimals(Number(await call(rpc,token.address,'decimals',[],at))),quoteDecimals=decimals(Number(await call(rpc,quoteAddress,'decimals',[],at)));
  return {token0,token1,quoteAddress,baseDecimals,quoteDecimals,fee,protocol:fee===undefined?'pancake_v2' as const:'pancake_v3' as const};
}
async function evmSnapshot(pool:VerifiedPool,rpc:ChainRpc,options:PoolReadOptions) {
  const b=await block(rpc,options);
  if(BigInt(b.number)<(contexts.get(pool)?.block??0n))fail('POOL_SNAPSHOT_REGRESSED');
  const binding=await evmBinding(pool.poolAddress,pool,rpc,b.number);
  for(const key of ['protocol','token0','token1','quoteAddress','baseDecimals','quoteDecimals','fee'] as const)if(binding[key]!==pool[key])fail('POOL_BINDING_CHANGED');
  let ratio:number;
  if(pool.protocol==='pancake_v2') {
    const [r0,r1]=await call(rpc,pool.poolAddress,'getReserves',[],b.number) as [bigint,bigint,number];
    if(r0<=0n||r1<=0n)fail('POOL_LIQUIDITY_EMPTY');
    ratio=pool.token0===pool.address?Number(r1)/Number(r0):Number(r0)/Number(r1);
  } else {
    const liquidity=await call(rpc,pool.poolAddress,'liquidity',[],b.number) as bigint;
    const [sqrt,tick,,,,,unlocked]=await call(rpc,pool.poolAddress,'slot0',[],b.number) as [bigint,number,number,number,number,number,boolean];
    if(liquidity<=0n||!unlocked)fail('POOL_LIQUIDITY_EMPTY');
    if(sqrt<4295128739n||sqrt>=1461446703485210103287273052203988822378723970342n||tick < -887272||tick>887272)fail('POOL_SQRT_PRICE_INVALID');
    const direct=(Number(sqrt)/2**96)**2;ratio=pool.token0===pool.address?direct:1/direct;
  }
  // Reorg during a multi-call snapshot must not mix values under two block hashes.
  const finalBlock=obj(await rpc.request('eth_getBlockByNumber',[b.number,false]));
  if(finalBlock.hash!==b.hash)fail('POOL_SNAPSHOT_REORG');fresh(Date.parse(b.blockTime),options);
  return {ratio:positive(ratio*10**(pool.baseDecimals-pool.quoteDecimals)),blockNumber:b.number,blockHash:b.hash,blockTime:b.blockTime};
}
function subscriptions(pool:VerifiedPool):PoolSubscription[] {
  if(pool.chain==='solana')return [pool.poolAddress,pool.baseVault!,pool.quoteVault!].map(key=>({key:`solana:pool:${pool.poolAddress}:${key}`,
    subscribeMethod:'accountSubscribe',params:[key,{encoding:'base64',commitment:'confirmed'}],unsubscribeMethod:'accountUnsubscribe',notificationMethod:'accountNotification'}));
  return [{key:`bsc:pool:${pool.poolAddress}`,subscribeMethod:'eth_subscribe',params:['logs',{address:pool.poolAddress}],unsubscribeMethod:'eth_unsubscribe',notificationMethod:'eth_subscription'}];
}

/** Metadata locates a candidate only; official program/factory membership is proven on chain. */
export async function discoverPool(token:PriceToken,metadata:{poolAddress:string},rpc:ChainRpc,options:PoolReadOptions={}):Promise<PoolDiscovery> {
  try {
    if(token.chain!=='solana'&&token.chain!=='bsc')fail('CHAIN_POOL_PROTOCOL_UNSUPPORTED');
    const normalized={chain:token.chain,address:token.chain==='solana'?sol(token.address):evm(token.address)};
    let pool:VerifiedPool;
    if(token.chain==='solana') {
      if(await rpc.request('getGenesisHash',[])!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')fail('CHAIN_IDENTITY_MISMATCH');
      const poolAddress=sol(metadata.poolAddress),s=await solAccounts(rpc,[poolAddress]),p=pumpState(s.values[0]);
      if(p.base!==normalized.address)fail('POOL_TOKEN_MISMATCH');quoteAllowed(token.chain,p.quote);await validatePumpAddress(poolAddress,p);
      const m=await solAccounts(rpc,[p.base,p.quote],s.slot),base=mint(m.values[0]),quote=mint(m.values[1]);
      pool={...normalized,poolAddress,protocol:'pumpswap',quoteAddress:p.quote,baseDecimals:base.decimals,quoteDecimals:quote.decimals,baseVault:p.baseVault,quoteVault:p.quoteVault};
      contexts.set(pool,{slot:m.slot});const snapshot=await solSnapshot(pool,rpc,options);contexts.set(pool,{slot:snapshot.slot});
    } else {
      if(BigInt(hexQuantity(await rpc.request('eth_chainId',[])))!==56n)fail('CHAIN_IDENTITY_MISMATCH');
      const poolAddress=evm(metadata.poolAddress),b=await block(rpc,options);
      pool={...normalized,poolAddress,...await evmBinding(poolAddress,normalized,rpc,b.number)};
      contexts.set(pool,{block:BigInt(b.number)});const snapshot=await evmSnapshot(pool,rpc,options);contexts.set(pool,{block:BigInt(snapshot.blockNumber)});
    }
    Object.freeze(pool);verified.add(pool);return {status:'supported',pool,subscriptions:subscriptions(pool)};
  } catch(error) {return {status:'unsupported',reason:reason(error)};}
}

/** A fresh pool spot ratio is not an executable quote or a promise about sale proceeds. */
export async function readPoolPrice(pool:VerifiedPool,rpc:ChainRpc,anchor?:UsdAnchor,options:PoolReadOptions={}):Promise<PoolPriceResult> {
  try {
    if(!verified.has(pool))fail('POOL_NOT_VERIFIED');
    if(!anchor||anchor.source!=='vendor_reference'||anchor.chain!==pool.chain||!same(pool.chain,anchor.address,pool.quoteAddress))fail('POOL_USD_ANCHOR_MISSING_OR_MISMATCH');
    positive(anchor.priceUsd);fresh(Date.parse(anchor.observedAt),options);
    const snapshot=pool.chain==='solana'?await solSnapshot(pool,rpc,options):await evmSnapshot(pool,rpc,options);
    fresh(Date.parse(anchor.observedAt),options);
    const priceUsd=positive(snapshot.ratio*anchor.priceUsd),{ratio:_,...context}=snapshot;
    // Late concurrent reads must never rewind the last accepted chain context.
    const previous=contexts.get(pool);
    if('slot' in snapshot) {
      if(snapshot.slot<(previous?.slot??0))fail('POOL_SNAPSHOT_REGRESSED');contexts.set(pool,{slot:snapshot.slot});
    } else {
      if(BigInt(snapshot.blockNumber)<(previous?.block??0n))fail('POOL_SNAPSHOT_REGRESSED');contexts.set(pool,{block:BigInt(snapshot.blockNumber)});
    }
    return {status:'sampled',price:{chain:pool.chain,address:pool.address,priceUsd,observedAt:new Date(current(options)).toISOString(),source:'chain_pool_sample',
      metadata:{pool:pool.poolAddress,protocol:pool.protocol,quoteAddress:pool.quoteAddress,quotePriceUsd:anchor.priceUsd,anchorAt:anchor.observedAt,anchorSource:anchor.source,confirmation:pool.chain==='solana'?'confirmed':'rpc_observed',...context,pricing:'spot_before_fees_and_slippage'}}};
  } catch(error) {return {status:'unavailable',reason:reason(error)};}
}
