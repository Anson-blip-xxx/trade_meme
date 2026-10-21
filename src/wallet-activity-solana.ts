import bs58 from 'bs58';
import {CHAIN_PRICE_DEPLOYMENTS as D} from './chain-prices.js';
import {chainAddress,object} from './chain-stream-store.js';
import {activityResult,type WalletActivity,type ActivityTrade,type ActivityTransfer} from './wallet-activity.js';
import type {FastWalletEvent} from './wallet-fast.js';

const system='11111111111111111111111111111111',compute='ComputeBudget111111111111111111111111111111';
const launchlab='LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const amount=(v:unknown):bigint|undefined=>typeof v==='string'&&/^\d{1,80}$/.test(v)?BigInt(v):undefined;
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
interface Instruction {raw:any;children:any[];}
interface Balance {mint:string;owner:string;amount:bigint;decimals:number;}
interface Rule {protocol:string;side:'buy'|'sell';user:number;base:number;quote?:number;baseAccount:number;quoteAccount?:number;vault:number;quoteVault?:number;nativeVault?:number;}
// Account indexes / discriminators from pinned official Pump and Raydium IDLs, not log text or token suffixes.
const rules=new Map<string,Rule>();
function rule(program:string,discriminators:string[],value:Rule){for(const d of discriminators)rules.set(program+':'+d,value);}
rule(D.pump,['66063d1201daebea','38fc74089edfcd5f'],{protocol:'pump',side:'buy',user:6,base:2,baseAccount:5,vault:4,nativeVault:3});
rule(D.pump,['33e685a4017f83ad'],{protocol:'pump',side:'sell',user:6,base:2,baseAccount:5,vault:4,nativeVault:3});
for(const side of ['buy','sell'] as const){
  rule(D.pumpAmm,side==='buy'?['66063d1201daebea','c62e1552b4d9e870']:['33e685a4017f83ad'],
    {protocol:'pumpswap',side,user:1,base:3,quote:4,baseAccount:5,quoteAccount:6,vault:7,quoteVault:8});
  rule(launchlab,side==='buy'?['faea0d7bd59c13ec','18d3742869039938']:['9527de9bd37c981a','5fc8472208090ba6'],
    {protocol:'raydium_launchlab',side,user:0,base:9,quote:10,baseAccount:5,quoteAccount:6,vault:7,quoteVault:8});
}
function discriminator(raw:any):string|undefined {try{return typeof raw.data==='string'&&raw.data.length<=8192?Buffer.from(bs58.decode(raw.data)).subarray(0,8).toString('hex'):undefined;}catch{return;}}
export function classifySolanaActivity(e:FastWalletEvent,raw:any,now:number):WalletActivity {
  const result=(kind:WalletActivity['classification'],reasons:string[],extra:Partial<WalletActivity>={})=>activityResult(e,now,kind,reasons,extra);
  if(!raw)return result('unknown',['TRANSACTION_NOT_CONFIRMED'],{retryable:true});
  const meta=raw.meta,message=raw.transaction?.message;
  if(!object(meta)||!object(message)||raw.transaction?.signatures?.[0]!==e.txHash||!safe(raw.slot)||e.slot!==undefined&&e.slot!==raw.slot)
    return result('unknown',['TRANSACTION_IDENTITY_MISMATCH']);
  if(!safe(raw.blockTime)||raw.blockTime*1000>now+5000)return result('unknown',['TRANSACTION_TIME_INVALID']);
  const facts={confirmation:'confirmed' as const,slot:raw.slot,eventAt:new Date(raw.blockTime*1000).toISOString()};
  if(!Object.hasOwn(meta,'err'))return result('unknown',['TRANSACTION_RECEIPT_INCOMPLETE'],facts);
  if(meta.err!==null)return result('failed',['TRANSACTION_EXECUTION_FAILED'],facts);
  const keys=message.accountKeys;
  if(!Array.isArray(keys)||keys.length>256||keys.some(k=>!object(k)||!chainAddress('solana',k.pubkey)||typeof k.signer!=='boolean')||
    new Set(keys.map(k=>k.pubkey)).size!==keys.length||!Array.isArray(meta.preBalances)||!Array.isArray(meta.postBalances)||
    meta.preBalances.length!==keys.length||meta.postBalances.length!==keys.length||!meta.preBalances.every(safe)||!meta.postBalances.every(safe)||!safe(meta.fee)||
    !Array.isArray(meta.preTokenBalances)||!Array.isArray(meta.postTokenBalances)||meta.preTokenBalances.length>256||meta.postTokenBalances.length>256)
    return result('unknown',['TRANSACTION_BALANCES_INCOMPLETE'],facts);
  const walletIndex=keys.findIndex(k=>k.pubkey===e.wallet);if(walletIndex<0)return result('unknown',['WALLET_NOT_IN_TRANSACTION'],facts);
  const parseBalances=(rows:any[])=>{const map=new Map<number,Balance>();for(const r of rows){const n=amount(r?.uiTokenAmount?.amount);
    if(!safe(r?.accountIndex)||r.accountIndex>=keys.length||map.has(r.accountIndex)||!chainAddress('solana',r.mint)||!chainAddress('solana',r.owner)||
      n===undefined||!safe(r.uiTokenAmount?.decimals)||r.uiTokenAmount.decimals>36)throw new Error();
    map.set(r.accountIndex,{mint:r.mint,owner:r.owner,amount:n,decimals:r.uiTokenAmount.decimals});}return map;};
  let pre:Map<number,Balance>,post:Map<number,Balance>;
  try{pre=parseBalances(meta.preTokenBalances);post=parseBalances(meta.postTokenBalances);}catch{return result('unknown',['TRANSACTION_BALANCES_INCOMPLETE'],facts);}
  const net=new Map<string,bigint>(),owned=new Set<number>();
  for(const i of new Set([...pre.keys(),...post.keys()])){
    const a=pre.get(i),b=post.get(i),owner=b?.owner??a!.owner,mint=b?.mint??a!.mint;
    if(a&&b&&(a.owner!==b.owner||a.mint!==b.mint||a.decimals!==b.decimals))return result('unknown',['TOKEN_ACCOUNT_IDENTITY_CHANGED'],facts);
    if(owner===e.wallet){owned.add(i);net.set(mint,(net.get(mint)??0n)+(b?.amount??0n)-(a?.amount??0n));}
  }
  // Include owned token-account lamports to cancel rent creation/closure; include the fee only for this wallet's fee payer.
  let native=BigInt(meta.postBalances[walletIndex])-BigInt(meta.preBalances[walletIndex])+(walletIndex===0?BigInt(meta.fee):0n);
  for(const i of owned)native+=BigInt(meta.postBalances[i])-BigInt(meta.preBalances[i]);
  if(!Array.isArray(message.instructions)||message.instructions.length>128||!Array.isArray(meta.innerInstructions)||meta.innerInstructions.length>128)
    return result('unknown',['TRANSACTION_INSTRUCTIONS_INCOMPLETE'],facts);
  const inner=new Map<number,any[]>();let count=message.instructions.length;
  for(const group of meta.innerInstructions){if(!safe(group?.index)||group.index>=message.instructions.length||inner.has(group.index)||!Array.isArray(group.instructions))
      return result('unknown',['TRANSACTION_INSTRUCTIONS_INCOMPLETE'],facts);count+=group.instructions.length;inner.set(group.index,group.instructions);}
  if(count>2048)return result('unknown',['TRANSACTION_INSTRUCTIONS_LIMIT'],facts);
  const instructions:Instruction[]=[],all:any[]=[];
  for(let i=0;i<message.instructions.length;i++){
    const children=inner.get(i)??[];instructions.push({raw:message.instructions[i],children});all.push(message.instructions[i],...children);
    for(let j=0;j<children.length;j++){const ix=children[j];if(!safe(ix?.stackHeight)||ix.stackHeight<2)continue;
      let end=j+1;while(end<children.length&&safe(children[end]?.stackHeight)&&children[end].stackHeight>ix.stackHeight)end++;
      instructions.push({raw:ix,children:children.slice(j+1,end)});}
  }
  if(all.some(ix=>!object(ix)||!chainAddress('solana',ix.programId)))return result('unknown',['TRANSACTION_INSTRUCTIONS_INCOMPLETE'],facts);
  let transferCount=0;const transfers:ActivityTransfer[]=[],ownedKeys=new Set([...owned].map(i=>keys[i].pubkey));ownedKeys.add(e.wallet);
  for(const ix of all)if([D.token,D.token2022,system].includes(ix.programId)&&['transfer','transferChecked','transferWithSeed'].includes(ix.parsed?.type)){
    const info=ix.parsed.info;if(!info||!ownedKeys.has(info.source)&&!ownedKeys.has(info.destination))continue;transferCount++;
    const n=ix.programId===system&&safe(info.lamports)?BigInt(info.lamports):amount(info.amount??info.tokenAmount?.amount);
    const index=keys.findIndex(k=>k.pubkey===info.source),mint=info.mint??pre.get(index)?.mint??post.get(index)?.mint;
    if(n!==undefined&&chainAddress('solana',info.source)&&chainAddress('solana',info.destination)&&transfers.length<32)
      transfers.push({from:info.source,to:info.destination,amountAtomic:n.toString(),...(chainAddress('solana',mint)?{tokenAddress:mint}:{})});
  }
  const details={...facts,transferCount,transfers},trades:ActivityTrade[]=[];let liquidity=false,matchedRule=false;
  const tokenFlow=(children:any[],source:string,destination:string,mint:string)=>children.reduce((sum,ix)=>{
    if(![D.token,D.token2022].includes(ix.programId)||!['transfer','transferChecked'].includes(ix.parsed?.type))return sum;
    const info=ix.parsed.info;if(info?.source!==source||info.destination!==destination||info.mint!==undefined&&info.mint!==mint)return sum;
    return sum+(amount(info.amount??info.tokenAmount?.amount)??0n);
  },0n);
  for(const {raw:ix,children} of instructions){
    const disc=discriminator(ix),accounts=ix.accounts;
    if(ix.programId===D.pumpAmm&&['f223c68952e1f2b6','b712469c946da122'].includes(disc??'')&&accounts?.[2]===e.wallet)liquidity=true;
    const spec=rules.get(ix.programId+':'+disc);if(!spec||!Array.isArray(accounts)||accounts.length>64||accounts.some((a:any)=>!chainAddress('solana',a))||accounts[spec.user]!==e.wallet)continue;
    matchedRule=true;if(!keys[walletIndex].signer)continue;
    const base=accounts[spec.base],baseAccount=accounts[spec.baseAccount],vault=accounts[spec.vault],baseNet=net.get(base)??0n;
    if(!base||!baseAccount||!vault||(spec.side==='buy'?baseNet<=0n:baseNet>=0n))continue;
    const ownerRecord=post.get(keys.findIndex(k=>k.pubkey===baseAccount))??pre.get(keys.findIndex(k=>k.pubkey===baseAccount));
    if(ownerRecord?.owner!==e.wallet||ownerRecord?.mint!==base)continue;
    const moved=tokenFlow(children,spec.side==='buy'?vault:baseAccount,spec.side==='buy'?baseAccount:vault,base);
    if(moved<=0n||(baseNet<0n?-baseNet:baseNet)>moved)continue;
    let quoteAmount=0n,quoteAddress:string|undefined;
    if(spec.nativeVault!==undefined){
      const index=keys.findIndex(k=>k.pubkey===accounts[spec.nativeVault!]);if(index<0)continue;
      const curve=BigInt(meta.postBalances[index])-BigInt(meta.preBalances[index]);
      if(spec.side==='buy'?native>=0n||curve<=0n:native<=0n||curve>=0n)continue;
      quoteAmount=curve<0n?-curve:curve;quoteAddress=D.wsol;
    }else{
      quoteAddress=accounts[spec.quote!];const userQuote=accounts[spec.quoteAccount!],quoteVault=accounts[spec.quoteVault!];
      if(!quoteAddress||!userQuote||!quoteVault)continue;
      quoteAmount=tokenFlow(children,spec.side==='buy'?userQuote:quoteVault,spec.side==='buy'?quoteVault:userQuote,quoteAddress);
      if(quoteAmount<=0n)continue;
      const q=quoteAddress===D.wsol?native:net.get(quoteAddress)??0n;
      if(spec.side==='buy'?q>=0n:q<=0n)continue;
    }
    trades.push({tokenAddress:base,side:spec.side,amountAtomic:(baseNet<0n?-baseNet:baseNet).toString(),protocol:spec.protocol,quoteAddress,quoteAmountAtomic:quoteAmount.toString()});
  }
  const unique=new Map(trades.map(t=>[t.tokenAddress+':'+t.side,t]));
  if(unique.size===1&&!liquidity){const trade=[...unique.values()][0];return result(trade.side,['SUPPORTED_SWAP_AND_WALLET_FLOW_CONFIRMED'],{...details,trades:[trade]});}
  if(unique.size>1||liquidity&&unique.size)return result('unknown',['MULTI_ACTION_TRANSACTION'],details);
  if(liquidity)return result('liquidity',['LIQUIDITY_CHANGE_NOT_BUY'],details);
  if(matchedRule)return result('unknown',['SWAP_BALANCE_OR_TRANSFER_MISMATCH'],details);
  const simple=all.every(ix=>[system,D.token,D.token2022,D.associatedToken,compute].includes(ix.programId));
  if(!simple)return result('unknown',['UNSUPPORTED_PROGRAM_OR_ACTION'],details);
  const types=all.map(ix=>ix.parsed?.type).filter(Boolean);
  if(types.some(t=>['approve','approveChecked','revoke','setAuthority'].includes(t))&&transferCount===0)return result('approval',['ALLOWANCE_CHANGE_ONLY'],details);
  const changed=[...net].filter(([,n])=>n!==0n);
  if(changed.length===1&&changed[0][0]===D.wsol&&types.some(t=>['syncNative','closeAccount'].includes(t))&&native===0n)
    return result('wrap',['WRAPPED_NATIVE_CONVERSION'],details);
  if(!changed.length&&native===0n)return result(transferCount?'self_transfer':'no_change',[transferCount?'ZERO_OR_SELF_TRANSFER':'FEE_OR_RENT_ONLY'],details);
  if(transferCount)return result('transfer',[keys[walletIndex].signer?'TOKEN_TRANSFER_ONLY':'UNSOLICITED_TOKEN_INFLOW'],details);
  return result('unknown',['SWAP_EVIDENCE_INSUFFICIENT'],details);
}
