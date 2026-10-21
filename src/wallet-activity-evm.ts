import {decodeEventLog,decodeFunctionResult,encodeFunctionData,parseAbi,toEventSelector,type Hex} from 'viem';
import {CHAIN_PRICE_DEPLOYMENTS as D} from './chain-prices.js';
import registry from '../config/platforms.json' with {type:'json'};
import {chainAddress,object,TRANSFER_TOPIC} from './chain-stream-store.js';
import {activityResult,type WalletActivity,type ActivityRpc,type ActivityTrade} from './wallet-activity.js';
import type {FastWalletEvent} from './wallet-fast.js';

// Official interfaces pinned in README. Emitter identity is checked before decoding.
export const WALLET_ACTIVITY_ABI=parseAbi([
  'event TokenPurchase(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)',
  'event TokenSale(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)',
  'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
  'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)',
  'event Mint(address indexed sender,uint256 amount0,uint256 amount1)',
  'event Burn(address indexed sender,uint256 amount0,uint256 amount1,address indexed to)',
  'event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
  'event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event Deposit(address indexed dst,uint256 wad)','event Withdrawal(address indexed src,uint256 wad)',
]);
const swapTopics=new Set(WALLET_ACTIVITY_ABI.filter(i=>i.name==='Swap').map(toEventSelector));
const poolTopics=new Set(WALLET_ACTIVITY_ABI.filter(i=>['Swap','Mint','Burn'].includes(i.name)).map(toEventSelector));
const approvalTopic=toEventSelector(WALLET_ACTIVITY_ABI.find(i=>i.name==='Approval')!);
const poolAbi=parseAbi(['function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)',
  'function fee() view returns(uint24)','function getPair(address,address) view returns(address)','function getPool(address,address,uint24) view returns(address)']);
export interface ActivityPool {address:string;token0:string;token1:string;protocol:'pancake_v2'|'pancake_v3';}
export interface EvmActivityBundle {transaction:any;receipt:any;block:any;pools?:ActivityPool[];}
const hash=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
const quantity=(v:unknown):bigint|undefined=>typeof v==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(v)?BigInt(v):undefined;
const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const topicAddress=(v:unknown)=>typeof v==='string'&&/^0x0{24}[0-9a-f]{40}$/i.test(v)?'0x'+v.slice(-40).toLowerCase():undefined;
const zero='0x'+'0'.repeat(40);
interface Move {token:string;from:string;to:string;amount:bigint;}
function transfer(log:any):Move|undefined {
  if(!Array.isArray(log.topics)||log.topics.length!==3||!same(log.topics[0],TRANSFER_TOPIC)||!/^0x[0-9a-f]{64}$/i.test(log.data??''))return;
  const token=chainAddress('bsc',log.address),from=topicAddress(log.topics[1]),to=topicAddress(log.topics[2]);
  if(token&&from&&to)return {token,from,to,amount:BigInt(log.data)};
}
/** Pair self-report is insufficient: ask the official factory for this exact pair at the transaction block. */
export async function loadSwapPools(event:FastWalletEvent,b:EvmActivityBundle,rpc:ActivityRpc):Promise<ActivityPool[]>{
  if(event.chain!=='bsc'||!Array.isArray(b.receipt?.logs)||b.receipt.logs.length>4096||quantity(b.receipt.blockNumber)===undefined)return [];
  const candidates=[...new Set<string>(b.receipt.logs.filter((l:any)=>poolTopics.has(l?.topics?.[0])).map((l:any)=>chainAddress('bsc',l.address)).filter(Boolean))];
  if(candidates.length>4)return [];
  const pools:ActivityPool[]=[];
  const call=async(to:string,name:string,args:unknown[]=[])=>decodeFunctionResult({abi:poolAbi,functionName:name as any,
    data:await rpc.request('eth_call',[{to,data:encodeFunctionData({abi:poolAbi,functionName:name as any,args:args as any})},b.receipt.blockNumber]) as Hex});
  for(const pool of candidates)try{
    const factory=String(await call(pool,'factory')).toLowerCase();if(factory!==D.pancakeV2&&factory!==D.pancakeV3)continue;
    const token0=String(await call(pool,'token0')).toLowerCase(),token1=String(await call(pool,'token1')).toLowerCase();
    if(!chainAddress('bsc',token0)||!chainAddress('bsc',token1)||BigInt(token0)>=BigInt(token1))continue;
    const fee=factory===D.pancakeV3?Number(await call(pool,'fee')):undefined;
    const registered=await call(factory,fee===undefined?'getPair':'getPool',fee===undefined?[token0,token1]:[token0,token1,fee]);
    if(same(registered,pool))pools.push({address:pool,token0,token1,protocol:fee===undefined?'pancake_v2':'pancake_v3'});
  }catch{/* Unknown pool or unsupported block reads do not establish a swap. */}
  return pools;
}
export function classifyEvmActivity(e:FastWalletEvent,b:EvmActivityBundle|null,now:number):WalletActivity {
  const result=(kind:WalletActivity['classification'],reasons:string[],extra:Partial<WalletActivity>={})=>activityResult(e,now,kind,reasons,extra);
  if(!b?.receipt||!b.transaction)return result('unknown',['TRANSACTION_NOT_CONFIRMED'],{retryable:true});
  const r=b.receipt,t=b.transaction,block=b.block;
  if(!same(r.transactionHash,e.txHash)||!same(t.hash,e.txHash)||!hash(r.blockHash)||!same(r.blockHash,t.blockHash)||
    !same(r.blockNumber,t.blockNumber)||!object(block)||!same(block.hash,r.blockHash)||!same(block.number,r.blockNumber)||
    e.blockHash&&!same(e.blockHash,r.blockHash))return result('unknown',['TRANSACTION_IDENTITY_MISMATCH']);
  const blockTime=quantity(block.timestamp);if(blockTime===undefined||blockTime>BigInt(Math.floor(now/1000)+5)||blockTime>8640000000000n)return result('unknown',['TRANSACTION_TIME_INVALID']);
  const facts={confirmation:'included' as const,blockHash:r.blockHash,eventAt:new Date(Number(blockTime)*1000).toISOString()};
  if(r.status==='0x0')return result('failed',['TRANSACTION_EXECUTION_FAILED'],facts);
  if(r.status!=='0x1'||!Array.isArray(r.logs)||r.logs.length>4096)return result('unknown',['TRANSACTION_RECEIPT_INCOMPLETE'],facts);
  const seen=new Set<string>();
  for(const l of r.logs){if(!object(l)||l.removed||!same(l.transactionHash,e.txHash)||!same(l.blockHash,r.blockHash)||!same(l.blockNumber,r.blockNumber)||
      quantity(l.logIndex)===undefined||seen.has(l.logIndex)||!chainAddress(e.chain,l.address)||!Array.isArray(l.topics)||l.topics.length>4||l.topics.some((v:unknown)=>!hash(v)))
      return result(l?.removed?'retracted':'unknown',['TRANSACTION_LOGS_INCONSISTENT'],facts);seen.add(l.logIndex);}
  const moves=r.logs.map(transfer).filter((v:Move|undefined):v is Move=>!!v),walletMoves=moves.filter((m:Move)=>m.from===e.wallet||m.to===e.wallet);
  if(e.tokenAddress&&!walletMoves.some((m:Move)=>m.token===e.tokenAddress))return result('unknown',['OBSERVED_TRANSFER_NOT_IN_RECEIPT'],facts);
  const net=(token:string)=>walletMoves.filter((m:Move)=>m.token===token).reduce((n:bigint,m:Move)=>n+(m.to===e.wallet?m.amount:0n)-(m.from===e.wallet?m.amount:0n),0n);
  const from=chainAddress(e.chain,t.from),to=chainAddress(e.chain,t.to),value=quantity(t.value),initiated=from===e.wallet;
  const nativeMoves=from&&to&&value!==undefined&&value>0n&&(from===e.wallet||to===e.wallet)?[{from,to,amountAtomic:value.toString()}]:[];
  const details={...facts,initiator:from,transferCount:walletMoves.length+nativeMoves.length,
    transfers:[...nativeMoves,...walletMoves.map((m:Move)=>({from:m.from,to:m.to,tokenAddress:m.token,amountAtomic:m.amount.toString()}))].slice(0,32)},trades:ActivityTrade[]=[];
  const hasLiquidity=r.logs.some((l:any)=>{if(!(b.pools??[]).some(p=>same(p.address,l.address)))return false;
    try{const d=decodeEventLog({abi:WALLET_ACTIVITY_ABI,data:l.data,topics:l.topics,strict:true});return ['Mint','Burn'].includes(d.eventName);}catch{return false;}});
  let receivedPurchase=false,splitOutput=false;
  const quoteTokens:string[]=e.chain==='bsc'?[D.wbnb,D.usdtBsc,D.usdcBsc]:[];
  for(const l of r.logs)try{
    const emitter=String(l.address).toLowerCase(),four=e.chain==='bsc'&&same(emitter,registry.four.factory),
      flap=same(emitter,e.chain==='bsc'?registry.flap.factory:registry.flapRobinhood.factory);
    if(!four&&!flap)continue;
    const d=decodeEventLog({abi:WALLET_ACTIVITY_ABI,data:l.data,topics:l.topics,strict:true}),a=d.args as any;
    if(!(four?['TokenPurchase','TokenSale']:['TokenBought','TokenSold']).includes(d.eventName))continue;
    const side=d.eventName==='TokenPurchase'||d.eventName==='TokenBought'?'buy':'sell',wallet=a.account??a.buyer??a.seller,token=chainAddress(e.chain,a.token);
    if(!same(wallet,e.wallet)||!token||a.amount<=0n||(a.cost??a.eth)<=0n)continue;
    const n=net(token);if(side==='buy'?n<=0n:n>=0n)continue;
    if((n<0n?-n:n)>a.amount)continue;
    if(!initiated){if(side==='buy'&&!quoteTokens.some(q=>net(q)<0n))receivedPurchase=true;continue;}
    // Official event binds trader, base amount and paid consideration. A log copied by a token cannot pass emitter matching.
    if(side==='buy'&&!(value!==undefined&&value>0n||quoteTokens.some(q=>net(q)<0n)))continue;
    trades.push({tokenAddress:token,side,amountAtomic:(n<0n?-n:n).toString(),protocol:four?'four_meme':'flap',quoteAmountAtomic:(a.cost??a.eth).toString()});
  }catch{/* Unknown event or malformed amount. */}
  for(const pool of b.pools??[])for(const l of r.logs)try{
    if(!same(l.address,pool.address)||!swapTopics.has(l.topics[0]))continue;
    const d=decodeEventLog({abi:WALLET_ACTIVITY_ABI,data:l.data,topics:l.topics,strict:true}),a=d.args as any;
    let delta0:bigint,delta1:bigint;
    if(a.amount0!==undefined){delta0=a.amount0;delta1=a.amount1;}else{delta0=BigInt(a.amount0In)-BigInt(a.amount0Out);delta1=BigInt(a.amount1In)-BigInt(a.amount1Out);}
    if(delta0===0n||delta1===0n||(delta0>0n)===(delta1>0n))continue;
    const base=quoteTokens.includes(pool.token0)?pool.token1:pool.token0,quote=base===pool.token0?pool.token1:pool.token0;
    if(!quoteTokens.includes(quote)||quoteTokens.includes(base)||!initiated)continue;
    const baseDelta=base===pool.token0?delta0:delta1,quoteDelta=base===pool.token0?delta1:delta0,side=baseDelta<0n?'buy':'sell',baseNet=net(base),quoteNet=net(quote);
    const basePath=moves.filter((m:Move)=>m.token===base&&(side==='buy'?m.from===pool.address&&m.to===e.wallet:m.from===e.wallet&&m.to===pool.address)).reduce((n:bigint,m:Move)=>n+m.amount,0n);
    // Bind the pool's exact swap amounts to this wallet. Unrelated donations, fee-on-transfer ambiguity
    // or someone else's swap in the same transaction must not fill a missing leg.
    const baseAmount=baseDelta<0n?-baseDelta:baseDelta,quoteAmount=quoteDelta<0n?-quoteDelta:quoteDelta;
    const poolOutputs=moves.filter((m:Move)=>m.token===base&&m.from===pool.address&&m.to!==pool.address);
    const split=side==='buy'&&pool.protocol==='pancake_v2'&&basePath>0n&&basePath<baseAmount&&
      poolOutputs.every((m:Move)=>m.to===e.wallet||m.to===base||m.to===zero)&&poolOutputs.reduce((n:bigint,m:Move)=>n+m.amount,0n)===baseAmount;
    if(basePath!==baseAmount&&!split||(baseNet<0n?-baseNet:baseNet)!==basePath||(side==='buy'?baseNet<=0n:baseNet>=0n))continue;
    if(side==='buy'&&!same(a.recipient??a.to,e.wallet))continue;
    const leg=(sender:string,recipient:string)=>moves.filter((m:Move)=>m.token===quote&&m.from===sender&&m.to===recipient).reduce((n:bigint,m:Move)=>n+m.amount,0n);
    let paid=(side==='buy'?quoteNet===-quoteAmount:quoteNet===quoteAmount)&&
      (side==='buy'?leg(e.wallet,pool.address):leg(pool.address,e.wallet))===quoteAmount;
    if(!paid&&to&&to!==pool.address&&to!==e.wallet&&(side==='buy'?quoteNet===-quoteAmount:quoteNet===quoteAmount)){
      const sender=side==='buy'?e.wallet:pool.address,recipient=side==='buy'?pool.address:e.wallet;
      paid=leg(sender,to)===quoteAmount&&leg(to,recipient)===quoteAmount&&
        !moves.some((m:Move)=>m.token===quote&&m.to===to&&m.from!==sender&&m.amount>0n);
    }
    if(!paid&&side==='buy'&&quote===D.wbnb&&value!==undefined&&value>=quoteDelta&&to){
      const deposited=r.logs.some((x:any)=>{try{if(!same(x.address,D.wbnb))return false;const v=decodeEventLog({abi:WALLET_ACTIVITY_ABI,data:x.data,topics:x.topics,strict:true});
        return v.eventName==='Deposit'&&same(v.args.dst,to)&&v.args.wad>=quoteDelta&&v.args.wad<=value!;}catch{return false;}});
      paid=deposited&&moves.some((m:Move)=>m.token===quote&&m.from===to&&m.to===pool.address&&m.amount===quoteDelta);
    }
    if(!paid)continue;
    splitOutput||=split;
    trades.push({tokenAddress:base,side,amountAtomic:(baseNet<0n?-baseNet:baseNet).toString(),protocol:pool.protocol,quoteAddress:quote,quoteAmountAtomic:quoteAmount.toString()});
  }catch{/* Only complete supported swaps count. */}
  const unique=new Map(trades.map(v=>[v.tokenAddress+':'+v.side,v]));
  if(unique.size===1&&!hasLiquidity){const trade=[...unique.values()][0];return result(trade.side,['SUPPORTED_SWAP_AND_WALLET_FLOW_CONFIRMED',...(splitOutput?['POOL_OUTPUT_SPLIT_NET_AMOUNT']:[])],{...details,trades:[trade]});}
  if(unique.size>1||unique.size&&hasLiquidity)return result('unknown',['MULTI_ACTION_TRANSACTION'],details);
  if(receivedPurchase)return result('received_purchase',['PURCHASE_FUNDED_BY_OTHER_WALLET'],details);
  if(!initiated&&walletMoves.some((m:Move)=>m.to===e.wallet&&m.amount>0n)&&walletMoves.every((m:Move)=>m.from!==e.wallet||m.from===m.to)&&
    new Set(moves.filter((m:Move)=>m.to!==zero&&m.amount>0n).map((m:Move)=>m.to)).size>=20)
    return result('distribution',['MANY_RECIPIENTS_NO_WALLET_PAYMENT'],details);
  const standardOnly=r.logs.every((l:any)=>same(l.topics[0],TRANSFER_TOPIC)||same(l.topics[0],approvalTopic));
  if(standardOnly&&walletMoves.length){
    if(walletMoves.every((m:Move)=>m.amount===0n||m.from===m.to))return result('self_transfer',['ZERO_OR_SELF_TRANSFER'],details);
    if([...new Set(walletMoves.map((m:Move)=>m.token))].every(token=>net(String(token))===0n))return result('no_change',['NO_NET_ASSET_CHANGE'],details);
    const directions=[...new Set(walletMoves.map((m:Move)=>m.token))].map(t=>net(String(t)));
    if(directions.some(n=>n>0n)&&directions.some(n=>n<0n))return result('unknown',['SWAP_EVIDENCE_INSUFFICIENT'],details);
    if(!initiated||/^(0xa9059cbb|0x23b872dd)/i.test(t.input??'')||walletMoves.every((m:Move)=>m.from===zero||m.to===zero))
      return result('transfer',[initiated?'TOKEN_TRANSFER_ONLY':'UNSOLICITED_TOKEN_INFLOW'],details);
  }
  if(!walletMoves.length&&r.logs.length&&r.logs.every((l:any)=>same(l.topics[0],approvalTopic)))return result('approval',['ALLOWANCE_CHANGE_ONLY'],details);
  if(!walletMoves.length&&r.logs.length===0&&['0x','0x0',''].includes(t.input??'')&&value!==undefined)
    return result(value>0n?'transfer':'no_change',[value>0n?'NATIVE_TRANSFER_ONLY':'NO_ASSET_CHANGE'],details);
  for(const l of r.logs)try{const d=decodeEventLog({abi:WALLET_ACTIVITY_ABI,data:l.data,topics:l.topics,strict:true});
    if(['Mint','Burn'].includes(d.eventName)&&(b.pools??[]).some(p=>same(p.address,l.address)))return result('liquidity',['LIQUIDITY_CHANGE_NOT_BUY'],details);
    if(['Deposit','Withdrawal'].includes(d.eventName)&&same(l.address,D.wbnb)&&to===D.wbnb&&walletMoves.every((m:Move)=>m.token===D.wbnb))return result('wrap',['WRAPPED_NATIVE_CONVERSION'],details);
  }catch{}
  return result('unknown',['SWAP_EVIDENCE_INSUFFICIENT'],details);
}
