import BN from 'bn.js';
import {Connection, PublicKey, SystemProgram, TransactionInstruction, type AccountInfo} from '@solana/web3.js';
import {ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  MintLayout, ExtensionType, getExtensionTypes, unpackMint, unpackAccount, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, type Mint, type Account} from '@solana/spl-token';
import {PUMP_SDK, PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_FEE_CONFIG_PDA, GLOBAL_PDA,
  bondingCurvePda, getPumpProgram, getBuyV3TokenAmountFromQuoteAmount, getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount, getFeeRecipient, type BondingCurve, type Global, type FeeConfig} from '@pump-fun/pump-sdk';
import {PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, PUMP_AMM_FEE_CONFIG_PDA, GLOBAL_CONFIG_PDA,
  canonicalPumpPoolPda, pumpPoolAuthorityPda, getPumpAmmProgram, buyQuoteInput, sellBaseInput,
  type SwapSolanaState} from '@pump-fun/pump-swap-sdk';
import {nativeTokenIdentity,type NativeTokenIdentity} from './identity.js';

export interface NativeSwapRequest {wallet:string;mint:string;side:'buy'|'sell';amount:string;slippageBps:number;}
export interface NativeSwapPlan {
  venue:'pump'|'pumpswap';mint:string;side:'buy'|'sell';inputAmount:string;
  expectedOutputAmount:string;minimumOutputAmount:string;quotedAt:string;
  instructions:TransactionInstruction[];subscriptionAccounts:string[];tokenDecimals:number;tokenIdentity?:NativeTokenIdentity;
}
export interface NativeTokenBalance {amount:string;decimals:number;slot:number;accounts:string[];commitment:'confirmed'|'finalized';}
export type NativeSellQuote = Omit<NativeSwapPlan,'instructions'>;
export interface NativeStreamQuote extends NativeSellQuote {slot:number;receivedAtMs:number;}
export interface NativeQuoteCacheWarm {
  venue:'pump'|'pumpswap';subscriptionAccounts:string[];priceAccounts:string[];slot:number;receivedAtMs:number;tokenDecimals:number;tokenProgram:string;
  tokenIdentity?:NativeTokenIdentity;
}
export interface NativeQuoteCacheOptions {nowMs?:number;maxStreamAgeMs?:number;headSlot?:number;}

export class NativePumpError extends Error {
  readonly reason:string;
  constructor(reason:string) {super(reason);this.name='NativePumpError';this.reason=reason;}
}
const fail=(reason:string):never=>{throw new NativePumpError(reason);};
const U64=(1n<<64n)-1n;
const COMMITMENT='confirmed' as const;
const unique=(values:PublicKey[])=>[...new Set(values.map(value=>value.toBase58()))];
const eq=(a:PublicKey,b:PublicKey)=>a.equals(b);
function key(value:string):PublicKey {
  try {const parsed=new PublicKey(value);if(parsed.toBase58()!==value)fail('NATIVE_ADDRESS_INVALID');return parsed;}
  catch {return fail('NATIVE_ADDRESS_INVALID');}
}
function inputAmount(request:NativeSwapRequest):BN {
  if(!['buy','sell'].includes(request.side)||typeof request.amount!=='string'||!/^[1-9]\d{0,19}$/.test(request.amount)||BigInt(request.amount)>U64)
    fail('NATIVE_AMOUNT_INVALID');
  if(!Number.isSafeInteger(request.slippageBps)||request.slippageBps<0||request.slippageBps>=10_000)fail('NATIVE_SLIPPAGE_INVALID');
  return new BN(request.amount);
}
function input(request:NativeSwapRequest) {
  const amount=inputAmount(request);
  const wallet=key(request.wallet),mint=key(request.mint);
  if(!PublicKey.isOnCurve(wallet.toBytes()))fail('NATIVE_WALLET_NOT_SIGNABLE');
  if(eq(mint,NATIVE_MINT)||eq(mint,PublicKey.default))fail('NATIVE_MINT_UNSUPPORTED');
  return {wallet,mint,amount};
}
function owner(info:AccountInfo<Buffer>|null,program:PublicKey):AccountInfo<Buffer> {
  if(!info||info.executable||!eq(info.owner,program))return fail('NATIVE_ACCOUNT_OWNER_INVALID');return info;
}
function extensions(data:Buffer,allowed:ExtensionType[]) {
  let found:ExtensionType[];
  try {found=getExtensionTypes(data);}catch {return fail('NATIVE_TOKEN_EXTENSION_INVALID');}
  if(found.some(value=>!allowed.includes(value)))fail('NATIVE_TOKEN_EXTENSION_UNSUPPORTED');
}
function mintData(address:PublicKey,info:AccountInfo<Buffer>|null):{mint:Mint;program:PublicKey;info:AccountInfo<Buffer>} {
  if(!info||info.executable||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(program=>eq(info.owner,program)))
    return fail('NATIVE_MINT_OWNER_INVALID');
  let mint:Mint;try {mint=unpackMint(address,info,info.owner);}catch {return fail('NATIVE_MINT_INVALID');}
  if(!mint.isInitialized||mint.supply<=0n)fail('NATIVE_MINT_INVALID');
  extensions(mint.tlvData,[ExtensionType.MetadataPointer,ExtensionType.TokenMetadata]);
  return {mint,program:info.owner,info};
}
function tokenData(address:PublicKey,info:AccountInfo<Buffer>|null,program:PublicKey,mint:PublicKey,authority:PublicKey):Account {
  let account:Account;try {account=unpackAccount(address,owner(info,program),program);}catch(error) {
    if(error instanceof NativePumpError)throw error;return fail('NATIVE_TOKEN_ACCOUNT_INVALID');
  }
  if(!eq(account.mint,mint)||!eq(account.owner,authority)||!account.isInitialized)fail('NATIVE_TOKEN_ACCOUNT_IDENTITY_INVALID');
  extensions(account.tlvData,[ExtensionType.ImmutableOwner]);
  return account;
}
interface Loaded {
  wallet:PublicKey;mintKey:PublicKey;tokenProgram:PublicKey;mint:Mint;slot:number;
  tokenIdentity?:NativeTokenIdentity;
  curve:BondingCurve;curveInfo:AccountInfo<Buffer>;userAta:PublicKey;userInfo:AccountInfo<Buffer>|null;
  subscriptions:PublicKey[];snapshot:{keys:PublicKey[];values:(AccountInfo<Buffer>|null)[]};
  pump?:{global:Global;fee:FeeConfig;curveBase:BN};amm?:SwapSolanaState;
}

interface StreamAccount {info:AccountInfo<Buffer>|null;slot:number;receivedAtMs:number;streamSequence?:number;}
interface QuoteCacheEntry {
  wallet:PublicKey;mint:PublicKey;tokenProgram:PublicKey;venue:'pump'|'pumpswap';
  keys:PublicKey[];accounts:Map<string,StreamAccount>;watched:string[];priceAccounts:string[];coherentAccounts:string[];
  state:Loaded;slot:number;receivedAtMs:number;invalidReason?:string;pendingReason?:string;
  coherentUpdates:Set<string>;
  accountIndex:Map<string,number>;subscriptionAddresses:string[];poolAuthority?:PublicKey;
  walletSignable:boolean;mintSupported:boolean;mintAddress:string;
}
interface DecodedStreamUpdate {
  mint?:Mint;curve?:BondingCurve;curveInfo?:AccountInfo<Buffer>;
  pump?:Partial<NonNullable<Loaded['pump']>>;amm?:Partial<SwapSolanaState>;
}
function cloneInfo(info:AccountInfo<Buffer>|null):AccountInfo<Buffer>|null {
  if(info===null)return null;
  if(!info||!Buffer.isBuffer(info.data)||info.data.length>65_536||!(info.owner instanceof PublicKey)||
    typeof info.executable!=='boolean'||!Number.isSafeInteger(info.lamports)||info.lamports<0)
    return fail('NATIVE_STREAM_ACCOUNT_INVALID');
  return {...info,data:Buffer.from(info.data),owner:new PublicKey(info.owner.toBytes())};
}

/** Official protocol builders only. No signer, broadcast, custody API or polling is owned here. */
export class PumpNativeAdapter {
  private readonly connection:Connection;
  private readonly ownerConnection:Connection;
  private readonly quoteCache=new Map<string,QuoteCacheEntry>();
  private readonly quoteCacheAccounts=new Map<string,Set<string>>();
  // Deleting a token also retires its epoch, including any HTTP warm still in flight.
  // A new explicit warm receives a new object; closed-token tombstones need not grow forever.
  private readonly quoteEpochs=new Map<string,object>();
  private activeWarmLoads=0;
  private readonly retiredStreamAccounts=new Set<string>();
  // Only validated subscription frames enter here. In particular, first-warm frames
  // must survive until HTTP has discovered and indexed the route's account set.
  private readonly latestStreamAccounts=new Map<string,StreamAccount>();
  private streamBufferEvictions=0;
  private streamSequence=0;
  private cacheGeneration=0;
  constructor(options:{connection:Connection;ownerConnection?:Connection}) {this.connection=options.connection;this.ownerConnection=options.ownerConnection??options.connection;}

  private async accounts(keys:PublicKey[],minContextSlot?:number,commitment:'confirmed'|'finalized'=COMMITMENT) {
    const response=await this.connection.getMultipleAccountsInfoAndContext(keys,{commitment,...(minContextSlot===undefined?{}:{minContextSlot})});
    if(response.value.length!==keys.length||!Number.isSafeInteger(response.context.slot)||response.context.slot<0||
      minContextSlot!==undefined&&response.context.slot<minContextSlot)fail('NATIVE_RPC_CONTEXT_INVALID');
    return response;
  }

  private async load(wallet:PublicKey,mintKey:PublicKey):Promise<Loaded> {
    const curveKey=bondingCurvePda(mintKey),poolKey=canonicalPumpPoolPda(mintKey,NATIVE_MINT);
    const initial=await this.accounts([mintKey,curveKey,poolKey]);
    const initialMint=mintData(mintKey,initial.value[0]);
    const firstCurve=PUMP_SDK.decodeBondingCurve(owner(initial.value[1],PUMP_PROGRAM_ID));
    if(!eq(firstCurve.quoteMint,PublicKey.default)&&!eq(firstCurve.quoteMint,NATIVE_MINT))fail('NATIVE_QUOTE_MINT_UNSUPPORTED');
    const tokenProgram=initialMint.program,userAta=getAssociatedTokenAddressSync(mintKey,wallet,true,tokenProgram);
    const keys=firstCurve.complete?
      [mintKey,curveKey,poolKey,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,
        getAssociatedTokenAddressSync(mintKey,poolKey,true,tokenProgram),
        getAssociatedTokenAddressSync(NATIVE_MINT,poolKey,true,TOKEN_PROGRAM_ID),userAta,
        getAssociatedTokenAddressSync(NATIVE_MINT,wallet,true,TOKEN_PROGRAM_ID)]:
      [mintKey,curveKey,GLOBAL_PDA,PUMP_FEE_CONFIG_PDA,
        getAssociatedTokenAddressSync(mintKey,curveKey,true,tokenProgram),userAta];
    const snapshot=await this.accounts(keys,initial.context.slot);
    return this.decodeSnapshot(wallet,mintKey,tokenProgram,firstCurve.complete?'pumpswap':'pump',
      snapshot.context.slot,keys,snapshot.value);
  }

  /** One validation path is shared by HTTP transaction preparation and local WS valuation. */
  private decodeSnapshot(wallet:PublicKey,mintKey:PublicKey,tokenProgram:PublicKey,venue:'pump'|'pumpswap',slot:number,
    keys:PublicKey[],values:(AccountInfo<Buffer>|null)[]):Loaded {
    const curveKey=bondingCurvePda(mintKey),poolKey=canonicalPumpPoolPda(mintKey,NATIVE_MINT);
    const [mintInfo,curveInfo]=values,fresh=mintData(mintKey,mintInfo);
    const curve=PUMP_SDK.decodeBondingCurve(owner(curveInfo,PUMP_PROGRAM_ID));
    if(!eq(fresh.program,tokenProgram)||curve.complete!==(venue==='pumpswap'))fail('NATIVE_ROUTE_CHANGED');
    if(!eq(curve.quoteMint,PublicKey.default)&&!eq(curve.quoteMint,NATIVE_MINT))fail('NATIVE_QUOTE_MINT_UNSUPPORTED');
    const userAta=getAssociatedTokenAddressSync(mintKey,wallet,true,tokenProgram);
    if(venue==='pump') {
      const [, ,globalInfo,feeInfo,vaultInfo,userInfo]=values;
      const vault=getAssociatedTokenAddressSync(mintKey,curveKey,true,tokenProgram);
      const vaultData=tokenData(vault,vaultInfo,tokenProgram,mintKey,curveKey);
      if(vaultData.isFrozen)fail('NATIVE_POOL_FROZEN');
      if(userInfo)tokenData(userAta,userInfo,tokenProgram,mintKey,wallet);
      return {wallet,mintKey,tokenProgram,mint:fresh.mint,tokenIdentity:nativeTokenIdentity(mintKey,fresh.mint),slot,curve,curveInfo:curveInfo!,userAta,userInfo,
        snapshot:{keys,values},subscriptions:[...keys,wallet],
        pump:{global:PUMP_SDK.decodeGlobal(owner(globalInfo,PUMP_PROGRAM_ID)),
          fee:PUMP_SDK.decodeFeeConfig(owner(feeInfo,PUMP_FEE_PROGRAM_ID)),curveBase:new BN(vaultData.amount.toString())}};
    }
    const [, ,poolInfo,globalInfo,feeInfo,baseInfo,quoteInfo,userInfo,userQuoteInfo]=values;
    const pool=PUMP_AMM_SDK.decodePool(owner(poolInfo,PUMP_AMM_PROGRAM_ID));
    const baseVault=getAssociatedTokenAddressSync(mintKey,poolKey,true,tokenProgram);
    const quoteVault=getAssociatedTokenAddressSync(NATIVE_MINT,poolKey,true,TOKEN_PROGRAM_ID);
    const quoteAta=getAssociatedTokenAddressSync(NATIVE_MINT,wallet,true,TOKEN_PROGRAM_ID);
    if(!eq(pool.quoteMint,NATIVE_MINT))fail('NATIVE_QUOTE_MINT_UNSUPPORTED');
    if(pool.index!==0||!eq(pool.baseMint,mintKey)||!eq(pool.creator,pumpPoolAuthorityPda(mintKey))||
      !eq(pool.poolBaseTokenAccount,baseVault)||!eq(pool.poolQuoteTokenAccount,quoteVault))fail('NATIVE_POOL_IDENTITY_INVALID');
    const base=tokenData(baseVault,baseInfo,tokenProgram,mintKey,poolKey),quote=tokenData(quoteVault,quoteInfo,TOKEN_PROGRAM_ID,NATIVE_MINT,poolKey);
    if(base.isFrozen||quote.isFrozen)fail('NATIVE_POOL_FROZEN');
    if(userInfo)tokenData(userAta,userInfo,tokenProgram,mintKey,wallet);
    if(userQuoteInfo)tokenData(quoteAta,userQuoteInfo,TOKEN_PROGRAM_ID,NATIVE_MINT,wallet);
    const effectiveQuote=new BN(quote.amount.toString()).add(pool.virtualQuoteReserves);
    if(base.amount===0n||effectiveQuote.lten(0)||pool.protocolFees.isNeg()||pool.creatorFees.isNeg()||
      pool.protocolFees.add(pool.creatorFees).gt(new BN(quote.amount.toString())))fail('NATIVE_POOL_LIQUIDITY_INVALID');
    const amm:SwapSolanaState={globalConfig:PUMP_AMM_SDK.decodeGlobalConfig(owner(globalInfo,PUMP_AMM_PROGRAM_ID)),
      feeConfig:PUMP_AMM_SDK.decodeFeeConfig(owner(feeInfo,PUMP_FEE_PROGRAM_ID)),poolKey,poolAccountInfo:poolInfo,pool,
      poolBaseAmount:new BN(base.amount.toString()),poolQuoteAmount:new BN(quote.amount.toString()),baseTokenProgram:tokenProgram,
      quoteTokenProgram:TOKEN_PROGRAM_ID,baseMint:mintKey,baseMintAccount:MintLayout.decode(mintInfo!.data),user:wallet,
      userBaseTokenAccount:userAta,userQuoteTokenAccount:quoteAta,userBaseAccountInfo:userInfo,userQuoteAccountInfo:userQuoteInfo};
    return {wallet,mintKey,tokenProgram,mint:fresh.mint,tokenIdentity:nativeTokenIdentity(mintKey,fresh.mint),slot,curve,curveInfo:curveInfo!,userAta,userInfo,
      snapshot:{keys,values},subscriptions:[...keys,wallet],amm};
  }

  private quote(state:Loaded,side:'buy'|'sell',amount:BN):BN {
    if(state.pump) {
      const common={global:state.pump.global,feeConfig:state.pump.fee,mintSupply:new BN(state.mint.supply.toString()),bondingCurve:state.curve,amount};
      if(side==='sell')return getSellSolAmountFromTokenAmount(common);
      if(state.curve.isCashbackCoin)return getBuyTokenAmountFromSolAmount({...common,quoteMint:NATIVE_MINT});
      return getBuyV3TokenAmountFromQuoteAmount({...common,curveBaseTokenBalance:state.pump.curveBase});
    }
    const amm=state.amm!,pool=amm.pool;
    const common={slippage:0,baseReserve:amm.poolBaseAmount,quoteReserve:amm.poolQuoteAmount,virtualQuoteReserves:pool.virtualQuoteReserves,
      feeBucketsTotal:pool.protocolFees.add(pool.creatorFees),globalConfig:amm.globalConfig,feeConfig:amm.feeConfig,
      baseMint:state.mintKey,baseMintAccount:amm.baseMintAccount,coinCreator:pool.coinCreator,creator:pool.creator,
      quoteMint:NATIVE_MINT,isMayhemMode:pool.isMayhemMode,creatorFeeBps:pool.creatorFeeBps};
    return side==='buy'?buyQuoteInput({...common,quote:amount}).base:sellBaseInput({...common,base:amount}).uiQuote;
  }

  /** An HTTP snapshot seeds the cache once; WS continuity must be enforced by the caller. */
  async warmQuoteCache(wallet:string,mint:string):Promise<NativeQuoteCacheWarm> {
    const generation=this.cacheGeneration,evictions=this.streamBufferEvictions,startSequence=this.streamSequence,parsed={wallet:key(wallet),mint:key(mint)},cacheKey=`${wallet}:${mint}`;
    const epoch=this.quoteEpochs.get(cacheKey)??{};this.quoteEpochs.set(cacheKey,epoch);this.activeWarmLoads++;
    try {
    const state=await this.load(parsed.wallet,parsed.mint),receivedAtMs=Date.now();
    if(generation!==this.cacheGeneration||this.quoteEpochs.get(cacheKey)!==epoch)fail('NATIVE_STREAM_CACHE_RESET');
    if(evictions!==this.streamBufferEvictions)fail('NATIVE_STREAM_BUFFER_OVERFLOW');
    const old=this.quoteCache.get(cacheKey);
    const venue=state.pump?'pump':'pumpswap',keys=state.snapshot.keys;
    // User ATAs/wallet are balance subscriptions, never inputs to market-price freshness.
    const watched=keys.slice(0,venue==='pump'?5:7).map(value=>value.toBase58());
    const priceAccounts=venue==='pump'?watched.slice(0,4):[...watched];
    const coherentAccounts=venue==='pump'?[keys[1].toBase58()]:[keys[2],keys[5],keys[6]].map(value=>value.toBase58());
    const accounts=new Map(keys.map((address,index)=>[address.toBase58(),
      {info:cloneInfo(state.snapshot.values[index]),slot:state.slot,receivedAtMs}]));
    const entry:QuoteCacheEntry={wallet:parsed.wallet,mint:parsed.mint,tokenProgram:state.tokenProgram,
      venue,keys,accounts,watched,priceAccounts,coherentAccounts,state,slot:state.slot,receivedAtMs,coherentUpdates:new Set(),
      accountIndex:new Map(keys.map((address,index)=>[address.toBase58(),index])),subscriptionAddresses:unique(state.subscriptions),
      poolAuthority:state.amm?.pool.creator,walletSignable:PublicKey.isOnCurve(parsed.wallet.toBytes()),
      mintSupported:!eq(parsed.mint,NATIVE_MINT)&&!eq(parsed.mint,PublicKey.default),mintAddress:mint};
    // Clone once, then validate the same snapshot that subsequent WS updates will replace.
    entry.state=this.decodeSnapshot(entry.wallet,entry.mint,entry.tokenProgram,venue,state.slot,keys,
      keys.map(address=>accounts.get(address.toBase58())!.info));
    // HTTP can complete after a newer (including same-slot) account frame. Never
    // let the late snapshot silently replace the last state observed on the wire.
    const coherentDuringWarm=new Set<string>();
    for(const address of watched){
      const buffered=this.latestStreamAccounts.get(address),previous=old?.accounts.get(address);
      const latest=!buffered?previous:!previous?buffered:
        buffered.slot>previous.slot||buffered.slot===previous.slot&&buffered.receivedAtMs>=previous.receivedAtMs?buffered:previous;
      if(!latest||latest.slot<state.slot||latest.slot===state.slot&&latest.streamSequence===undefined)continue;
      try{
        const copied=cloneInfo(latest.info),decoded=this.decodeStreamAccount(entry,address,copied);
        this.applyStreamUpdate(entry,decoded);
        entry.accounts.set(address,{...latest,info:copied});
        if(coherentAccounts.includes(address)&&latest.streamSequence!==undefined){entry.coherentUpdates.add(address);
          if(latest.streamSequence>startSequence)coherentDuringWarm.add(address);}
      }catch(error){entry.invalidReason=error instanceof NativePumpError?error.reason:'NATIVE_STREAM_ACCOUNT_INVALID';}
    }
    if(old?.venue===venue&&old.pendingReason&&old.coherentUpdates.size&&
      Math.max(...old.coherentAccounts.map(address=>old.accounts.get(address)!.slot))>=state.slot)
      entry.coherentUpdates=new Set(old.coherentUpdates);
    else if(old?.venue!==venue&&coherentDuringWarm.size>0&&coherentDuringWarm.size<coherentAccounts.length)
      entry.coherentUpdates=coherentDuringWarm;
    this.refreshCachedState(entry);
    if(old)for(const address of old.watched){const indexed=this.quoteCacheAccounts.get(address);indexed?.delete(cacheKey);if(indexed?.size===0)this.quoteCacheAccounts.delete(address);}
    this.quoteCache.set(cacheKey,entry);
    for(const address of watched){const indexed=this.quoteCacheAccounts.get(address)??new Set<string>();indexed.add(cacheKey);this.quoteCacheAccounts.set(address,indexed);}
    return {venue,subscriptionAccounts:[...entry.subscriptionAddresses],priceAccounts,slot:entry.slot,receivedAtMs:entry.receivedAtMs,tokenDecimals:entry.state.mint.decimals,
      tokenProgram:state.tokenProgram.toBase58(),...(entry.state.tokenIdentity?{tokenIdentity:{...entry.state.tokenIdentity}}:{})};
    } finally {this.activeWarmLoads--;this.releaseRetiredAccounts();}
  }

  /** Decode complete public WS account frames. No network, signer, or disk I/O occurs here. */
  ingestAccount(address:string,info:AccountInfo<Buffer>|null,slot:number,receivedAtMs:number):string[] {
    const indexed=this.quoteCacheAccounts.get(address);let copied:AccountInfo<Buffer>|null;
    try{
      if(!indexed)key(address); // Indexed strings were canonicalized when the route was warmed.
      if(!Number.isSafeInteger(slot)||slot<0||!Number.isFinite(receivedAtMs)||receivedAtMs<0||receivedAtMs>Date.now()+1000)
        fail('NATIVE_STREAM_CONTEXT_INVALID');
      copied=cloneInfo(info);
      const prior=this.latestStreamAccounts.get(address);
      if(prior&&(slot<prior.slot||receivedAtMs<prior.receivedAtMs))fail('NATIVE_STREAM_SLOT_REGRESSION');
      this.latestStreamAccounts.delete(address);this.latestStreamAccounts.set(address,{info:copied,slot,receivedAtMs,streamSequence:++this.streamSequence});
      if(this.latestStreamAccounts.size>512){this.latestStreamAccounts.delete(this.latestStreamAccounts.keys().next().value!);this.streamBufferEvictions++;}
    }catch(error){
      const reason=error instanceof NativePumpError?error.reason:'NATIVE_STREAM_ACCOUNT_INVALID';
      for(const cacheKey of indexed??[]){const entry=this.quoteCache.get(cacheKey);if(entry)entry.invalidReason=reason;}
      return [...new Set([...(indexed??[])].map(cacheKey=>this.quoteCache.get(cacheKey)?.mintAddress).filter((value):value is string=>!!value))];
    }
    if(!indexed)return [];
    const affected=new Set<string>();
    for(const cacheKey of indexed) {
      const entry=this.quoteCache.get(cacheKey);if(!entry)continue;affected.add(entry.mintAddress);
      if(entry.invalidReason)continue;
      try {
        const prior=entry.accounts.get(address)!;
        if(slot<prior.slot||receivedAtMs<prior.receivedAtMs)fail('NATIVE_STREAM_SLOT_REGRESSION');
        // Validate the updated account independently even while an AMM slot is incomplete.
        const decoded=this.decodeStreamAccount(entry,address,copied);
        this.applyStreamUpdate(entry,decoded);
        entry.accounts.set(address,{info:copied,slot,receivedAtMs,streamSequence:this.streamSequence});
        if(entry.coherentAccounts.includes(address))entry.coherentUpdates.add(address);
        this.refreshCachedState(entry);
      }catch(error){entry.invalidReason=error instanceof NativePumpError?error.reason:'NATIVE_STREAM_ACCOUNT_INVALID';}
    }
    return [...affected];
  }

  private refreshCachedState(entry:QuoteCacheEntry):void {
    if(entry.invalidReason)return;
    try{
      const coherent=entry.coherentAccounts.map(key=>entry.accounts.get(key)!.slot);
      if(coherent.some(value=>value!==coherent[0])||entry.coherentUpdates.size>0&&entry.coherentUpdates.size<entry.coherentAccounts.length){
        entry.pendingReason='NATIVE_STREAM_SLOT_INCOMPLETE';return;
      }
      const inputs=entry.priceAccounts.map(key=>entry.accounts.get(key)!),quoteSlot=Math.max(...inputs.map(row=>row.slot));
      // Every changed member has already passed its owner/identity/extension checks.
      // Reuse unchanged decoded globals and mint data; only cross-member economics
      // need rechecking once the current pool/vault update round is complete.
      if(entry.state.amm){
        const {pool,poolBaseAmount:base,poolQuoteAmount:quote}=entry.state.amm;
        if(base.lten(0)||quote.add(pool.virtualQuoteReserves).lten(0)||pool.protocolFees.isNeg()||pool.creatorFees.isNeg()||
          pool.protocolFees.add(pool.creatorFees).gt(quote))fail('NATIVE_POOL_LIQUIDITY_INVALID');
      }
      entry.state.slot=quoteSlot;
      const streamInputs=inputs.filter(row=>row.slot===quoteSlot&&row.streamSequence!==undefined);
      entry.slot=quoteSlot;entry.receivedAtMs=Math.max(...(streamInputs.length?streamInputs:inputs.filter(row=>row.slot===quoteSlot)).map(row=>row.receivedAtMs));
      entry.pendingReason=undefined;entry.coherentUpdates.clear();
      // Matching slots are only an indicative valuation. Multiple transactions may
      // share a slot: execution still builds and checks a fresh canonical RPC plan.
    }catch(error){entry.invalidReason=error instanceof NativePumpError?error.reason:'NATIVE_STREAM_ACCOUNT_INVALID';}
  }

  private applyStreamUpdate(entry:QuoteCacheEntry,update:DecodedStreamUpdate):void {
    if(update.mint){entry.state.mint=update.mint;entry.state.tokenIdentity=nativeTokenIdentity(entry.mint,update.mint);}
    if(update.curve)entry.state.curve=update.curve;
    if(update.curveInfo)entry.state.curveInfo=update.curveInfo;
    if(update.pump)Object.assign(entry.state.pump!,update.pump);
    if(update.amm)Object.assign(entry.state.amm!,update.amm);
  }

  /** Decode only the changed account. Addresses and authorities were derived and
   * validated at warm time; no PDA derivation or unrelated account decoding occurs. */
  private decodeStreamAccount(entry:QuoteCacheEntry,address:string,info:AccountInfo<Buffer>|null):DecodedStreamUpdate {
    const index=entry.accountIndex.get(address);
    if(index===undefined) return fail('NATIVE_STREAM_ACCOUNT_INVALID');
    if(index===0){const mint=mintData(entry.mint,info);if(!eq(mint.program,entry.tokenProgram))fail('NATIVE_ROUTE_CHANGED');
      return {mint:mint.mint,...(entry.venue==='pumpswap'?{amm:{baseMintAccount:MintLayout.decode(info!.data)}}:{})};}
    if(index===1){const curve=PUMP_SDK.decodeBondingCurve(owner(info,PUMP_PROGRAM_ID));
      if(curve.complete!==(entry.venue==='pumpswap'))fail('NATIVE_ROUTE_CHANGED');
      if(!eq(curve.quoteMint,PublicKey.default)&&!eq(curve.quoteMint,NATIVE_MINT))fail('NATIVE_QUOTE_MINT_UNSUPPORTED');
      return {curve,curveInfo:info!};}
    if(entry.venue==='pump') {
      if(index===2)return {pump:{global:PUMP_SDK.decodeGlobal(owner(info,PUMP_PROGRAM_ID))}};
      if(index===3)return {pump:{fee:PUMP_SDK.decodeFeeConfig(owner(info,PUMP_FEE_PROGRAM_ID))}};
      const vault=tokenData(entry.keys[index],info,entry.tokenProgram,entry.mint,entry.keys[1]);
      if(vault.isFrozen)fail('NATIVE_POOL_FROZEN');return {pump:{curveBase:new BN(vault.amount.toString())}};
    }
    const poolKey=entry.keys[2];
    if(index===2){const pool=PUMP_AMM_SDK.decodePool(owner(info,PUMP_AMM_PROGRAM_ID));
      if(pool.index!==0||!eq(pool.baseMint,entry.mint)||!eq(pool.quoteMint,NATIVE_MINT)||!eq(pool.creator,entry.poolAuthority!)||
        !eq(pool.poolBaseTokenAccount,entry.keys[5])||!eq(pool.poolQuoteTokenAccount,entry.keys[6]))fail('NATIVE_POOL_IDENTITY_INVALID');
      return {amm:{pool,poolAccountInfo:info}};}
    if(index===3)return {amm:{globalConfig:PUMP_AMM_SDK.decodeGlobalConfig(owner(info,PUMP_AMM_PROGRAM_ID))}};
    if(index===4)return {amm:{feeConfig:PUMP_AMM_SDK.decodeFeeConfig(owner(info,PUMP_FEE_PROGRAM_ID))}};
    const token=tokenData(entry.keys[index],info,index===5?entry.tokenProgram:TOKEN_PROGRAM_ID,index===5?entry.mint:NATIVE_MINT,poolKey);
    if(token.isFrozen)fail('NATIVE_POOL_FROZEN');
    return {amm:index===5?{poolBaseAmount:new BN(token.amount.toString())}:{poolQuoteAmount:new BN(token.amount.toString())}};
  }

  /** WS health is a separate clock: a healthy idle pool must not invent new market timestamps. */
  quoteSellCached(request:Omit<NativeSwapRequest,'side'>,options:NativeQuoteCacheOptions={}):NativeStreamQuote {
    if(typeof request.wallet!=='string'||typeof request.mint!=='string')fail('NATIVE_ADDRESS_INVALID');
    const amount=inputAmount({...request,side:'sell'}),entry=this.quoteCache.get(`${request.wallet}:${request.mint}`);
    if(!entry){input({...request,side:'sell'});return fail('NATIVE_STREAM_CACHE_COLD');}
    if(!entry.walletSignable)fail('NATIVE_WALLET_NOT_SIGNABLE');
    if(!entry.mintSupported)fail('NATIVE_MINT_UNSUPPORTED');
    if(entry.invalidReason)fail(entry.invalidReason);
    if(entry.pendingReason)fail(entry.pendingReason);
    const now=options.nowMs??Date.now();
    if(!Number.isFinite(now)||now<entry.receivedAtMs)fail('NATIVE_STREAM_CONTEXT_INVALID');
    if(options.maxStreamAgeMs!==undefined&&(!Number.isFinite(options.maxStreamAgeMs)||options.maxStreamAgeMs<0||
      now-entry.receivedAtMs>options.maxStreamAgeMs))fail('NATIVE_STREAM_QUOTE_STALE');
    if(options.headSlot!==undefined&&(!Number.isSafeInteger(options.headSlot)||options.headSlot<0||entry.slot>options.headSlot+2))
      fail('NATIVE_STREAM_CONTEXT_INVALID');
    const expected=this.quote(entry.state,'sell',amount),minimum=expected.muln(10_000-request.slippageBps).divn(10_000);
    if(expected.lten(0)||minimum.lten(0)||BigInt(expected.toString())>U64)fail('NATIVE_QUOTE_UNAVAILABLE');
    return {venue:entry.venue,mint:request.mint,side:'sell',inputAmount:request.amount,
      expectedOutputAmount:expected.toString(),minimumOutputAmount:minimum.toString(),
      quotedAt:new Date(entry.receivedAtMs).toISOString(),slot:entry.slot,receivedAtMs:entry.receivedAtMs,
      subscriptionAccounts:[...entry.subscriptionAddresses],tokenDecimals:entry.state.mint.decimals};
  }

  cacheStatus(wallet:string,mint:string) {
    const entry=this.quoteCache.get(`${wallet}:${mint}`);
    return entry?{warm:!entry.invalidReason,ready:!entry.invalidReason&&!entry.pendingReason,
      reason:entry.invalidReason??entry.pendingReason,venue:entry.venue,slot:entry.slot,receivedAtMs:entry.receivedAtMs,
      priceAccounts:[...entry.priceAccounts]}:{warm:false,ready:false,reason:'NATIVE_STREAM_CACHE_COLD'};
  }

  /** Release a closed position's decoded market and indexes. Shared global/pool
   * accounts stay buffered while another cache references them. In-flight warms
   * from the removed epoch cannot recreate the position's cache. */
  dropQuoteCache(wallet:string,mint:string):void {
    const cacheKey=`${wallet}:${mint}`,entry=this.quoteCache.get(cacheKey);
    this.quoteEpochs.delete(cacheKey);this.quoteCache.delete(cacheKey);
    if(entry)for(const address of entry.watched){
      const indexed=this.quoteCacheAccounts.get(address);indexed?.delete(cacheKey);
      if(indexed?.size===0)this.quoteCacheAccounts.delete(address);
      this.retiredStreamAccounts.add(address);
    }
    this.releaseRetiredAccounts();
  }

  private releaseRetiredAccounts():void {
    // Another initial warm may still need a pre-index frame. Let it consume the
    // buffer before reclaiming addresses that are no longer watched by anyone.
    if(this.activeWarmLoads)return;
    for(const address of this.retiredStreamAccounts)if(!this.quoteCacheAccounts.has(address))this.latestStreamAccounts.delete(address);
    this.retiredStreamAccounts.clear();
  }

  /** Every reconnect invalidates the previous subscription generation, including in-flight snapshots. */
  invalidateCache():void {this.cacheGeneration++;this.quoteCache.clear();this.quoteCacheAccounts.clear();this.quoteEpochs.clear();this.retiredStreamAccounts.clear();
    this.latestStreamAccounts.clear();this.streamBufferEvictions=0;this.streamSequence=0;}

  private async walletAccounts(wallet:PublicKey,mint:PublicKey,program:PublicKey,minContextSlot:number,commitment:'confirmed'|'finalized'=COMMITMENT) {
    const response=await this.ownerConnection.getTokenAccountsByOwner(wallet,{mint},{commitment,minContextSlot});
    if(!Number.isSafeInteger(response.context.slot)||response.context.slot<minContextSlot)fail('NATIVE_RPC_CONTEXT_INVALID');
    const seen=new Set<string>();
    const accounts=response.value.map(item=>{
      const address=item.pubkey.toBase58();if(seen.has(address))fail('NATIVE_DUPLICATE_TOKEN_ACCOUNT');seen.add(address);
      return {address:item.pubkey,info:item.account,data:tokenData(item.pubkey,item.account,program,mint,wallet)};
    });
    return {slot:response.context.slot,accounts};
  }

  async balance(wallet:string,mint:string,commitment:'confirmed'|'finalized'='finalized'):Promise<NativeTokenBalance> {
    try {
      if(commitment!=='confirmed'&&commitment!=='finalized')fail('NATIVE_COMMITMENT_INVALID');
      const walletKey=key(wallet),mintKey=key(mint),snapshot=await this.accounts([mintKey],undefined,commitment);
      const decoded=mintData(mintKey,snapshot.value[0]);
      const result=await this.walletAccounts(walletKey,mintKey,decoded.program,snapshot.context.slot,commitment);
      return {amount:result.accounts.reduce((total,row)=>total+row.data.amount,0n).toString(),decimals:decoded.mint.decimals,
        slot:result.slot,accounts:result.accounts.map(row=>row.address.toBase58()),commitment};
    } catch(error) {if(error instanceof NativePumpError)throw error;return fail('NATIVE_BALANCE_UNAVAILABLE');}
  }

  private async consolidate(state:Loaded,amount:BN):Promise<TransactionInstruction[]> {
    const result=await this.walletAccounts(state.wallet,state.mintKey,state.tokenProgram,state.slot);
    state.subscriptions.push(...result.accounts.map(row=>row.address));
    const ownAta=result.accounts.find(row=>eq(row.address,state.userAta));
    if(ownAta?.data.isFrozen)fail('NATIVE_HOLDING_FROZEN');
    let missing=BigInt(amount.toString())-(ownAta?.data.amount??0n);
    const available=result.accounts.filter(row=>!row.data.isFrozen).reduce((total,row)=>total+row.data.amount,0n);
    if(available<BigInt(amount.toString()))fail('NATIVE_HOLDING_INSUFFICIENT');
    if(missing<=0n)return [];
    const instructions:TransactionInstruction[]=[];
    if(!ownAta)instructions.push(createAssociatedTokenAccountIdempotentInstruction(state.wallet,state.userAta,state.wallet,state.mintKey,state.tokenProgram));
    for(const row of result.accounts) {
      if(missing<=0n)break;
      if(eq(row.address,state.userAta)||row.data.isFrozen||row.data.amount===0n)continue;
      const transfer=row.data.amount<missing?row.data.amount:missing;
      instructions.push(createTransferCheckedInstruction(row.address,state.mintKey,state.userAta,state.wallet,transfer,state.mint.decimals,[],state.tokenProgram));
      missing-=transfer;
    }
    return instructions;
  }

  /** Exact-in variants share the SDK template's account layout; verify the official IDL before reuse. */
  private exactInstruction(template:TransactionInstruction,venue:'pump'|'pumpswap',from:string,to:string,args:Record<string,unknown>) {
    const program=venue==='pump'?getPumpProgram(this.connection):getPumpAmmProgram(this.connection);
    const baseline=program.idl.instructions.find(ix=>ix.name===from),exact=program.idl.instructions.find(ix=>ix.name===to);
    if(!baseline||!exact||JSON.stringify(baseline.accounts)!==JSON.stringify(exact.accounts))fail('NATIVE_IDL_ACCOUNT_LAYOUT_CHANGED');
    return new TransactionInstruction({programId:template.programId,keys:template.keys,data:program.coder.instruction.encode(to,args)});
  }

  private async instructions(state:Loaded,side:'buy'|'sell',amount:BN,minimum:BN):Promise<TransactionInstruction[]> {
    if(state.pump) {
      const common={bondingCurve:state.curve,mint:state.mintKey,user:state.wallet,tokenProgram:state.tokenProgram,
        quoteTokenProgram:TOKEN_PROGRAM_ID,slippage:0};
      const buyback=state.pump.global.buybackFeeRecipients.find(value=>!eq(value,PublicKey.default));
      if(!buyback)fail('NATIVE_BUYBACK_RECIPIENT_UNAVAILABLE');
      if(!state.curve.isCashbackCoin) return side==='buy'?
        PUMP_SDK.buyExactQuoteInV3Instructions({...common,associatedUserAccountInfo:state.userInfo,amount:minimum,quoteAmount:amount,buybackFeeRecipient:buyback,partialFill:false}):
        PUMP_SDK.sellV3Instructions({...common,amount,quoteAmount:minimum,buybackFeeRecipient:buyback});
      if(side==='sell')return [await PUMP_SDK.getSellV2InstructionRaw({user:state.wallet,mint:state.mintKey,creator:state.curve.creator,
        amount,quoteAmount:minimum,tokenProgram:state.tokenProgram,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID,
        feeRecipient:getFeeRecipient(state.pump.global,state.curve.isMayhemMode),buybackFeeRecipient:buyback})];
      const template=await PUMP_SDK.getBuyV2InstructionRaw({user:state.wallet,mint:state.mintKey,creator:state.curve.creator,
        amount:minimum,quoteAmount:amount,tokenProgram:state.tokenProgram,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID,
        feeRecipient:getFeeRecipient(state.pump.global,state.curve.isMayhemMode),buybackFeeRecipient:buyback});
      return [createAssociatedTokenAccountIdempotentInstruction(state.wallet,state.userAta,state.wallet,state.mintKey,state.tokenProgram),
        this.exactInstruction(template,'pump','buyV2','buyExactQuoteInV2',{spendableQuoteIn:amount,minTokensOut:minimum,partialFill:{0:false}})];
    }
    const amm=state.amm!;
    if(!amm.pool.isCashbackCoin) return side==='buy'?PUMP_AMM_SDK.buyExactQuoteInV2Instructions(amm,amount,minimum):PUMP_AMM_SDK.sellV2Instructions(amm,amount,minimum);
    if(side==='sell')return PUMP_AMM_SDK.sellInstructions(amm,amount,minimum);
    const instructions=await PUMP_AMM_SDK.buyInstructions(amm,minimum,amount);
    const program=getPumpAmmProgram(this.connection);
    const discriminator=Buffer.from(program.idl.instructions.find(ix=>ix.name==='buy')!.discriminator);
    let replaced=0;
    const result=instructions.map(ix=>{
      if(!eq(ix.programId,PUMP_AMM_PROGRAM_ID)||!ix.data.subarray(0,8).equals(discriminator))return ix;
      replaced++;
      return this.exactInstruction(ix,'pumpswap','buy','buyExactQuoteIn',{spendableQuoteIn:amount,minBaseAmountOut:minimum,trackVolume:{0:true}});
    });
    if(replaced!==1)fail('NATIVE_SWAP_INSTRUCTION_UNAVAILABLE');return result;
  }

  private async prepare(request:NativeSwapRequest,build:boolean):Promise<NativeSwapPlan> {
    const parsed=input(request),quotedAt=new Date().toISOString();
    const state=await this.load(parsed.wallet,parsed.mint),expected=this.quote(state,request.side,parsed.amount);
    const minimum=expected.muln(10_000-request.slippageBps).divn(10_000);
    if(expected.lten(0)||minimum.lten(0)||BigInt(expected.toString())>U64)fail('NATIVE_QUOTE_UNAVAILABLE');
    let instructions:TransactionInstruction[]=[];
    if(build) {
      const consolidate=request.side==='sell'?await this.consolidate(state,parsed.amount):[];
      instructions=[...consolidate,...await this.instructions(state,request.side,parsed.amount,minimum)];
      const allowed=[PUMP_PROGRAM_ID,PUMP_AMM_PROGRAM_ID,SystemProgram.programId,ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID];
      if(instructions.some(ix=>!allowed.some(program=>eq(ix.programId,program))||ix.keys.some(meta=>meta.isSigner&&!eq(meta.pubkey,parsed.wallet))))
        fail('NATIVE_INSTRUCTION_NOT_ALLOWED');
    }
    return {venue:state.pump?'pump':'pumpswap',mint:request.mint,side:request.side,inputAmount:request.amount,
      expectedOutputAmount:expected.toString(),minimumOutputAmount:minimum.toString(),quotedAt,instructions,
      subscriptionAccounts:unique(state.subscriptions),tokenDecimals:state.mint.decimals,
      ...(state.tokenIdentity?{tokenIdentity:{...state.tokenIdentity}}:{})};
  }

  async build(request:NativeSwapRequest):Promise<NativeSwapPlan> {
    try {return await this.prepare(request,true);}catch(error) {if(error instanceof NativePumpError)throw error;return fail('NATIVE_BUILD_UNAVAILABLE');}
  }
  async quoteSell(request:Omit<NativeSwapRequest,'side'>):Promise<NativeSellQuote> {
    try {const {instructions:_,...quote}=await this.prepare({...request,side:'sell'},false);return quote;}
    catch(error) {if(error instanceof NativePumpError)throw error;return fail('NATIVE_QUOTE_UNAVAILABLE');}
  }
}
