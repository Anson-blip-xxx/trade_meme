import BN from 'bn.js';
import {Connection,PublicKey,TransactionInstruction,type AccountInfo} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,NATIVE_MINT,TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,
  ExtensionType,MintLayout,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction,getExtensionTypes,
  getAssociatedTokenAddressSync,getTransferHook,getTransferHookAccount,unpackAccount,unpackMint,type Account,type Mint,
} from '@solana/spl-token';
import {PUMP_FEE_PROGRAM_ID,PUMP_PROGRAM_ID,PUMP_SDK,bondingCurvePda} from '@pump-fun/pump-sdk';
import {
  GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,PUMP_AMM_PROGRAM_ID,PUMP_AMM_SDK,
  buyQuoteInput,canonicalPumpPoolPda,pumpPoolAuthorityPda,sellBaseInput,type SwapSolanaState,
} from '@pump-fun/pump-swap-sdk';
import {nativeTokenIdentity,type NativeTokenIdentity} from './identity.js';
import {JupiterBuildClient,JUPITER_SWAP_PROGRAM,type JupiterMainBucketTier,type JupiterRequestPriority} from './jupiter.js';
import type {NativeQuoteCacheOptions,NativeQuoteCacheWarm,NativeSellQuote,NativeStreamQuote,NativeSwapPlan,NativeSwapRequest} from './pump.js';

const U64=(1n<<64n)-1n;
const PUMP_MINT=new PublicKey('pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn');
// Permissionless PumpSwap PUMP/WSOL pool. It is deliberately validated from
// chain on every route load; the address is discovery data, never authority.
const PUMP_WSOL_POOL=new PublicKey('539m4mVWt6iduB6W8rDGPMarzNCMesuqY5eUTiiYHAgR');
const JUPITER_PROTECTION_QUOTE_TIMEOUT_MS=700;
const JUPITER_PROTECTION_HTTP_BUDGET_MS=300;
const eq=(a:PublicKey,b:PublicKey)=>a.equals(b);
const fail=(reason:string):never=>{throw Error(reason);};
const unique=(values:PublicKey[])=>[...new Set(values.map(value=>value.toBase58()))];
const key=(value:string)=>{try{const result=new PublicKey(value);if(result.toBase58()!==value)throw Error();return result;}catch{return fail('NATIVE_ADDRESS_INVALID');}};

export interface NativeRouteCapability {
  /** Curve-only classification. It deliberately makes no claim that a route
   * is executable or monitorable until build/warm performs its full preflight. */
  classification:'route_candidate';
  route:'direct'|'pump_bridge'|'jupiter_bridge';quoteMint:string;
  curveState:'active'|'complete';readiness:'requires_preflight';
}

interface PoolLeg {
  state:SwapSolanaState;
  poolIndex:number;baseVaultIndex:number;quoteVaultIndex:number;baseMintIndex:number;
}
interface RouteState {
  wallet:PublicKey;mint:PublicKey;mintData:Mint;tokenProgram:PublicKey;identity?:NativeTokenIdentity;
  quoteMint:PublicKey;quoteProgram:PublicKey;curveIndex:number;target?:PoolLeg;bridge?:PoolLeg;
  keys:PublicKey[];values:(AccountInfo<Buffer>|null)[];slot:number;receivedAtMs:number;
}
interface CacheEntry {
  state:RouteState;accounts:Map<string,{info:AccountInfo<Buffer>|null;slot:number;receivedAtMs:number}>;
  watched:Set<string>;coherent:{target:Set<string>;bridge:Set<string>};invalid?:string;pending?:string;
}

function mint(address:PublicKey,info:AccountInfo<Buffer>|null):{data:Mint;program:PublicKey} {
  if(!info||info.executable||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(program=>eq(info.owner,program)))fail('NATIVE_MINT_OWNER_INVALID');
  const present=info as AccountInfo<Buffer>;
  try {const data=unpackMint(address,present,present.owner),extensions=getExtensionTypes(data.tlvData),pump=eq(address,PUMP_MINT);
    if(extensions.some(value=>![ExtensionType.MetadataPointer,ExtensionType.TokenMetadata,...(pump?[ExtensionType.TransferHook]:[])].includes(value)))
      fail('NATIVE_TOKEN_EXTENSION_UNSUPPORTED');
    if(pump){const hook=getTransferHook(data);if(!hook||!eq(hook.programId,PublicKey.default))fail('NATIVE_TOKEN_EXTENSION_UNSUPPORTED');}
    if(!data.isInitialized||data.supply<=0n&&!eq(address,NATIVE_MINT))fail('NATIVE_MINT_INVALID');return {data,program:present.owner};}
  catch(error){if(error instanceof Error&&error.message.startsWith('NATIVE_'))throw error;return fail('NATIVE_MINT_INVALID');}
}
function quoteProgram(address:PublicKey,info:AccountInfo<Buffer>|null):PublicKey {
  if(!info||info.executable||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(program=>eq(info.owner,program)))
    fail('NATIVE_MINT_OWNER_INVALID');
  const present=info as AccountInfo<Buffer>;
  try {const data=unpackMint(address,present,present.owner);if(!data.isInitialized||data.supply<=0n)fail('NATIVE_MINT_INVALID');return present.owner;}
  catch(error){if(error instanceof Error&&error.message.startsWith('NATIVE_'))throw error;return fail('NATIVE_MINT_INVALID');}
}
function token(address:PublicKey,info:AccountInfo<Buffer>|null,program:PublicKey,mintKey:PublicKey,authority:PublicKey):Account {
  if(!info||info.executable||!eq(info.owner,program))return fail('NATIVE_ACCOUNT_OWNER_INVALID');
  try {const data=unpackAccount(address,info,program),found=getExtensionTypes(data.tlvData),pump=eq(mintKey,PUMP_MINT);
    if(found.some(value=>value!==ExtensionType.ImmutableOwner&&!(pump&&value===ExtensionType.TransferHookAccount)))
      fail('NATIVE_TOKEN_EXTENSION_UNSUPPORTED');
    if(pump&&found.includes(ExtensionType.TransferHookAccount)&&getTransferHookAccount(data)?.transferring!==false)
      fail('NATIVE_TOKEN_EXTENSION_UNSUPPORTED');
    if(!data.isInitialized||!eq(data.mint,mintKey)||!eq(data.owner,authority))fail('NATIVE_TOKEN_ACCOUNT_IDENTITY_INVALID');return data;}
  catch(error){if(error instanceof Error&&error.message.startsWith('NATIVE_'))throw error;return fail('NATIVE_TOKEN_ACCOUNT_INVALID');}
}
function poolQuote(leg:PoolLeg,side:'buy'|'sell',amount:BN):BN {
  const {state}=leg,{pool}=state;
  const common={slippage:0,baseReserve:state.poolBaseAmount,quoteReserve:state.poolQuoteAmount,
    virtualQuoteReserves:pool.virtualQuoteReserves,feeBucketsTotal:pool.protocolFees.add(pool.creatorFees),
    globalConfig:state.globalConfig,feeConfig:state.feeConfig,baseMint:pool.baseMint,
    baseMintAccount:state.baseMintAccount,coinCreator:pool.coinCreator,creator:pool.creator,
    quoteMint:pool.quoteMint,isMayhemMode:pool.isMayhemMode,creatorFeeBps:pool.creatorFeeBps};
  return side==='buy'?buyQuoteInput({...common,quote:amount}).base:sellBaseInput({...common,base:amount}).uiQuote;
}
function less(value:BN,bps:number){return value.muln(10_000-bps).divn(10_000);}
function split(bps:number){const first=Math.floor(bps/2);return [first,bps-first] as const;}

/** Non-SOL Pump quote routing. Pump state is locally decoded; Jupiter is used
 * only for the external SOL/quote bridge and never as the target-coin oracle. */
export class PumpMultiQuoteRouter {
  private readonly jupiter:JupiterBuildClient;
  private readonly jupiterApiKeyConfigured:boolean;
  private readonly protectionProbeUntil=new Map<string,number>();
  private readonly cache=new Map<string,CacheEntry>();
  private readonly byAccount=new Map<string,Set<string>>();
  constructor(private readonly connection:Connection,private readonly ownerConnection:Connection=connection,
    fetcher:typeof fetch=fetch,apiKey?:string|null,mainBucketTier?:JupiterMainBucketTier,mainBucketRps?:number){
    const configured=apiKey===undefined?process.env.JUPITER_API_KEY?.trim()||undefined:apiKey?.trim()||undefined;
    this.jupiterApiKeyConfigured=!!configured;
    this.jupiter=new JupiterBuildClient({fetcher,apiKey:configured,mainBucketTier,mainBucketRps});
  }

  jupiterStatus(){const bucket=this.jupiter.status(),entryCapacity=this.jupiterApiKeyConfigured?
      this.jupiter.protectionCapacity(JUPITER_PROTECTION_QUOTE_TIMEOUT_MS,1,40,JUPITER_PROTECTION_HTTP_BUDGET_MS):0;
    return {apiKeyConfigured:this.jupiterApiKeyConfigured,nonSolEntryRequiresApiKey:true,entryCapacity,
      mainBucket:bucket,protectionProbeWindowMs:5000,protectionQuoteTimeoutMs:JUPITER_PROTECTION_QUOTE_TIMEOUT_MS,
      protectionQuoteHttpBudgetMs:JUPITER_PROTECTION_HTTP_BUDGET_MS,protectionQuotesPerDecision:1};}

  private async accounts(keys:PublicKey[],minContextSlot?:number){
    // Public RPCs commonly cap getMultipleAccounts at ten. Fetch chunks in
    // parallel, and only accept a snapshot when every chunk has the same
    // context slot; retrying at the newest observed slot avoids mixed states.
    const chunks=Array.from({length:Math.ceil(keys.length/10)},(_,index)=>keys.slice(index*10,index*10+10));
    let floor=minContextSlot;
    for(let attempt=0;attempt<3;attempt++){
      const results=await Promise.all(chunks.map(chunk=>this.connection.getMultipleAccountsInfoAndContext(chunk,
        {commitment:'confirmed',...(floor===undefined?{}:{minContextSlot:floor})})));
      if(results.some((result,index)=>result.value.length!==chunks[index].length||!Number.isSafeInteger(result.context.slot)||
        floor!==undefined&&result.context.slot<floor))fail('NATIVE_RPC_CONTEXT_INVALID');
      const slots=results.map(result=>result.context.slot),newest=Math.max(...slots);
      if(slots.every(slot=>slot===newest))return {context:{slot:newest},value:results.flatMap(result=>result.value)};
      floor=newest;
    }
    return fail('NATIVE_RPC_CONTEXT_INVALID');
  }

  async quoteMint(mintKey:PublicKey):Promise<{quoteMint:PublicKey;complete:boolean}> {
    const snapshot=await this.accounts([bondingCurvePda(mintKey)]),info=snapshot.value[0];
    if(!info||!eq(info.owner,PUMP_PROGRAM_ID))fail('NATIVE_ROUTE_UNAVAILABLE');
    const curve=PUMP_SDK.decodeBondingCurve(info as AccountInfo<Buffer>);
    return {quoteMint:eq(curve.quoteMint,PublicKey.default)?NATIVE_MINT:curve.quoteMint,complete:curve.complete};
  }

  async capability(mintAddress:string):Promise<NativeRouteCapability>{
    const mintKey=key(mintAddress),route=await this.quoteMint(mintKey);
    const common={classification:'route_candidate' as const,quoteMint:route.quoteMint.toBase58(),
      curveState:route.complete?'complete' as const:'active' as const,readiness:'requires_preflight' as const};
    if(eq(route.quoteMint,NATIVE_MINT))return {...common,route:'direct'};
    if(route.complete&&eq(route.quoteMint,PUMP_MINT))return {...common,route:'pump_bridge'};
    return {...common,route:'jupiter_bridge'};
  }

  private makeLeg(state:RouteState,poolIndex:number,baseVaultIndex:number,quoteVaultIndex:number,baseMintIndex:number,
    userBase:PublicKey,userQuote:PublicKey):PoolLeg {
    const poolInfo=state.values[poolIndex];if(!poolInfo||!eq(poolInfo.owner,PUMP_AMM_PROGRAM_ID))fail('NATIVE_POOL_OWNER_INVALID');
    const globalInfo=state.values[3],feeInfo=state.values[4];
    if(!globalInfo||globalInfo.executable||!eq(globalInfo.owner,PUMP_AMM_PROGRAM_ID)||
      feeInfo&&(feeInfo.executable||!eq(feeInfo.owner,PUMP_FEE_PROGRAM_ID)))fail('NATIVE_ACCOUNT_OWNER_INVALID');
    const presentGlobal=globalInfo as AccountInfo<Buffer>;
    const pool=PUMP_AMM_SDK.decodePool(poolInfo as AccountInfo<Buffer>),baseMintInfo=state.values[baseMintIndex];
    const baseMint=mint(pool.baseMint,baseMintInfo),quoteMint=mint(pool.quoteMint,state.values[state.keys.findIndex(value=>eq(value,pool.quoteMint))]);
    if(!eq(pool.poolBaseTokenAccount,state.keys[baseVaultIndex])||!eq(pool.poolQuoteTokenAccount,state.keys[quoteVaultIndex]))fail('NATIVE_POOL_IDENTITY_INVALID');
    const base=token(state.keys[baseVaultIndex],state.values[baseVaultIndex],baseMint.program,pool.baseMint,state.keys[poolIndex]);
    const quote=token(state.keys[quoteVaultIndex],state.values[quoteVaultIndex],quoteMint.program,pool.quoteMint,state.keys[poolIndex]);
    if(base.isFrozen||quote.isFrozen||base.amount===0n||quote.amount===0n)fail('NATIVE_POOL_LIQUIDITY_INVALID');
    const userBaseInfo=state.values[state.keys.findIndex(value=>eq(value,userBase))]??null;
    const userQuoteInfo=state.values[state.keys.findIndex(value=>eq(value,userQuote))]??null;
    return {poolIndex,baseVaultIndex,quoteVaultIndex,baseMintIndex,state:{
      globalConfig:PUMP_AMM_SDK.decodeGlobalConfig(presentGlobal),feeConfig:feeInfo?PUMP_AMM_SDK.decodeFeeConfig(feeInfo):null,
      poolKey:state.keys[poolIndex],poolAccountInfo:poolInfo,pool,poolBaseAmount:new BN(base.amount.toString()),poolQuoteAmount:new BN(quote.amount.toString()),
      baseTokenProgram:baseMint.program,quoteTokenProgram:quoteMint.program,baseMint:pool.baseMint,baseMintAccount:MintLayout.decode(baseMintInfo!.data),
      user:state.wallet,userBaseTokenAccount:userBase,userQuoteTokenAccount:userQuote,userBaseAccountInfo:userBaseInfo,userQuoteAccountInfo:userQuoteInfo,
    }};
  }

  private decode(state:RouteState):RouteState {
    const targetMint=mint(state.mint,state.values[0]),curveInfo=state.values[1];
    if(!curveInfo||!eq(curveInfo.owner,PUMP_PROGRAM_ID))fail('NATIVE_ROUTE_CHANGED');
    const curve=PUMP_SDK.decodeBondingCurve(curveInfo as AccountInfo<Buffer>),normalized=eq(curve.quoteMint,PublicKey.default)?NATIVE_MINT:curve.quoteMint;
    if(!curve.complete||!eq(normalized,state.quoteMint))fail('NATIVE_ROUTE_CHANGED');
    const targetPool=canonicalPumpPoolPda(state.mint,state.quoteMint),target=PUMP_AMM_SDK.decodePool(state.values[5]??fail('NATIVE_POOL_OWNER_INVALID'));
    if(!eq(state.keys[5],targetPool)||target.index!==0||!eq(target.creator,pumpPoolAuthorityPda(state.mint))||
      !eq(target.baseMint,state.mint)||!eq(target.quoteMint,state.quoteMint))fail('NATIVE_POOL_IDENTITY_INVALID');
    state.mintData=targetMint.data;state.tokenProgram=targetMint.program;state.identity=nativeTokenIdentity(state.mint,targetMint.data);
    const targetBase=getAssociatedTokenAddressSync(state.mint,state.wallet,true,targetMint.program);
    const targetQuote=getAssociatedTokenAddressSync(state.quoteMint,state.wallet,true,state.quoteProgram);
    state.target=this.makeLeg(state,5,6,7,0,targetBase,targetQuote);
    if(state.keys.length>10){
      const bridgePool=PUMP_AMM_SDK.decodePool(state.values[10]??fail('NATIVE_POOL_OWNER_INVALID'));
      if(!eq(state.keys[10],PUMP_WSOL_POOL)||!eq(bridgePool.baseMint,state.quoteMint)||!eq(bridgePool.quoteMint,NATIVE_MINT)||
        bridgePool.isMayhemMode||bridgePool.isCashbackCoin)fail('NATIVE_BRIDGE_IDENTITY_INVALID');
      const userWsol=getAssociatedTokenAddressSync(NATIVE_MINT,state.wallet,true,TOKEN_PROGRAM_ID);
      state.bridge=this.makeLeg(state,10,11,12,2,targetQuote,userWsol);
    } else state.bridge=undefined;
    return state;
  }

  private async load(wallet:PublicKey,mintKey:PublicKey,localBridge:boolean,expected:NativeRouteCapability):Promise<RouteState>{
    const first=await this.accounts([mintKey,bondingCurvePda(mintKey)]),targetMint=mint(mintKey,first.value[0]);
    const curve=PUMP_SDK.decodeBondingCurve(first.value[1]!);if(!curve.complete)fail('NATIVE_MULTI_QUOTE_CURVE_UNSUPPORTED');
    const quoteMint=eq(curve.quoteMint,PublicKey.default)?NATIVE_MINT:curve.quoteMint;
    if(expected.curveState!=='complete'||!eq(quoteMint,key(expected.quoteMint)))fail('NATIVE_ROUTE_CHANGED');
    if(eq(quoteMint,NATIVE_MINT))fail('NATIVE_ROUTE_CHANGED');
    const quoteInfo=await this.accounts([quoteMint],first.context.slot),quote=mint(quoteMint,quoteInfo.value[0]);
    const pool=canonicalPumpPoolPda(mintKey,quoteMint),userBase=getAssociatedTokenAddressSync(mintKey,wallet,true,targetMint.program);
    const userQuote=getAssociatedTokenAddressSync(quoteMint,wallet,true,quote.program);
    const keys=[mintKey,bondingCurvePda(mintKey),quoteMint,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,pool,
      getAssociatedTokenAddressSync(mintKey,pool,true,targetMint.program),getAssociatedTokenAddressSync(quoteMint,pool,true,quote.program),userBase,userQuote];
    if(localBridge){
      if(!eq(quoteMint,PUMP_MINT))fail('NATIVE_LOCAL_BRIDGE_UNAVAILABLE');
      keys.push(PUMP_WSOL_POOL,getAssociatedTokenAddressSync(quoteMint,PUMP_WSOL_POOL,true,quote.program),
        getAssociatedTokenAddressSync(NATIVE_MINT,PUMP_WSOL_POOL,true,TOKEN_PROGRAM_ID),getAssociatedTokenAddressSync(NATIVE_MINT,wallet,true,TOKEN_PROGRAM_ID),NATIVE_MINT);
    }
    const snapshot=await this.accounts(keys,quoteInfo.context.slot);
    return this.decode({wallet,mint:mintKey,mintData:targetMint.data,tokenProgram:targetMint.program,identity:nativeTokenIdentity(mintKey,targetMint.data),
      quoteMint,quoteProgram:quote.program,curveIndex:1,target:undefined as never,keys,values:snapshot.value,slot:snapshot.context.slot,receivedAtMs:Date.now()});
  }

  /** Minimal canonical Pump identity for a Jupiter end-to-end route. External
   * quote mints can intentionally use extensions (xStocks do); Jupiter owns
   * those transfer semantics while the target mint remains strictly decoded. */
  private async loadJupiter(wallet:PublicKey,mintKey:PublicKey,expected:NativeRouteCapability):Promise<RouteState>{
    const curveKey=bondingCurvePda(mintKey),first=await this.accounts([mintKey,curveKey]),target=mint(mintKey,first.value[0]);
    const curveInfo=first.value[1];if(!curveInfo||!eq(curveInfo.owner,PUMP_PROGRAM_ID))fail('NATIVE_ROUTE_UNAVAILABLE');
    const curve=PUMP_SDK.decodeBondingCurve(curveInfo as AccountInfo<Buffer>),quoteMint=eq(curve.quoteMint,PublicKey.default)?NATIVE_MINT:curve.quoteMint;
    if((curve.complete?'complete':'active')!==expected.curveState||!eq(quoteMint,key(expected.quoteMint)))fail('NATIVE_ROUTE_CHANGED');
    if(eq(quoteMint,NATIVE_MINT)||eq(quoteMint,mintKey))fail('NATIVE_ROUTE_CHANGED');
    const quote=await this.accounts([quoteMint],first.context.slot),program=quoteProgram(quoteMint,quote.value[0]);
    return {wallet,mint:mintKey,mintData:target.data,tokenProgram:target.program,identity:nativeTokenIdentity(mintKey,target.data),
      quoteMint,quoteProgram:program,curveIndex:1,keys:[mintKey,curveKey,quoteMint],values:[first.value[0],curveInfo,quote.value[0]],
      slot:quote.context.slot,receivedAtMs:Date.now()};
  }

  private routeQuote(state:RouteState,side:'buy'|'sell',amount:BN){
    const bridge=state.bridge??fail('NATIVE_LOCAL_BRIDGE_UNAVAILABLE'),target=state.target??fail('NATIVE_LOCAL_BRIDGE_UNAVAILABLE');
    const first=side==='buy'?poolQuote(bridge,'buy',amount):poolQuote(target,'sell',amount);
    const expected=side==='buy'?poolQuote(target,'buy',first):poolQuote(bridge,'sell',first);
    return {intermediate:first,expected};
  }

  private async consolidate(state:RouteState,amount:BN):Promise<TransactionInstruction[]> {
    const response=await this.ownerConnection.getTokenAccountsByOwner(state.wallet,{mint:state.mint},{commitment:'confirmed',minContextSlot:state.slot});
    if(response.context.slot<state.slot)fail('NATIVE_RPC_CONTEXT_INVALID');
    const rows=response.value.map(row=>({address:row.pubkey,data:token(row.pubkey,row.account,state.tokenProgram,state.mint,state.wallet)}));
    const ata=getAssociatedTokenAddressSync(state.mint,state.wallet,true,state.tokenProgram),own=rows.find(row=>eq(row.address,ata));
    let missing=BigInt(amount.toString())-(own?.data.amount??0n);
    if(rows.filter(row=>!row.data.isFrozen).reduce((sum,row)=>sum+row.data.amount,0n)<BigInt(amount.toString()))fail('NATIVE_HOLDING_INSUFFICIENT');
    if(missing<=0n)return [];
    const result:TransactionInstruction[]=[];if(!own)result.push(createAssociatedTokenAccountIdempotentInstruction(state.wallet,ata,state.wallet,state.mint,state.tokenProgram));
    for(const row of rows){if(missing<=0n)break;if(eq(row.address,ata)||row.data.isFrozen||row.data.amount===0n)continue;
      const moved=row.data.amount<missing?row.data.amount:missing;result.push(createTransferCheckedInstruction(row.address,state.mint,ata,state.wallet,moved,state.mintData.decimals,[],state.tokenProgram));missing-=moved;}
    return result;
  }

  /** Jupiter's route program dynamically carries the amount through every CPI
   * leg. Unlike two ordinary swaps, this leaves no unaccounted intermediate
   * quote balance. Local Pump state is only a chain preflight: a fresh external
   * sample wakes protection and an exact target -> SOL quote makes the decision. */
  private async endToEndPlan(request:NativeSwapRequest,state:RouteState,build:boolean):Promise<NativeSwapPlan>{
    const amount=new BN(request.amount),input=request.side==='buy'?NATIVE_MINT:state.mint,output=request.side==='buy'?state.mint:NATIVE_MINT;
    const route=await this.jupiter.build({user:state.wallet.toBase58(),inputMint:input.toBase58(),outputMint:output.toBase58(),amount:request.amount,
      slippageBps:request.slippageBps,priority:request.side==='sell'?'exit':'entry',...(request.signal?{signal:request.signal}:{})});let instructions=route.instructions;
    if(build&&request.side==='sell'){
      const consolidation=await this.consolidate(state,amount),pivot=instructions.findIndex(ix=>ix.programId.toBase58()===JUPITER_SWAP_PROGRAM);
      instructions=pivot<0?[...consolidation,...instructions]:[...instructions.slice(0,pivot),...consolidation,...instructions.slice(pivot)];
    }
    return {venue:'jupiter',protectionMode:'external_price_stream',mint:request.mint,side:request.side,inputAmount:request.amount,expectedOutputAmount:route.expectedOutputAmount,
      minimumOutputAmount:route.minimumOutputAmount,quotedAt:new Date().toISOString(),instructions,addressLookupTables:route.addressLookupTableAccounts,
      // Route pools and ALTs are one-shot execution details. Keep only durable
      // wallet/mint identity subscribed until inventory tracking installs ATAs.
      subscriptionAccounts:unique([state.wallet,state.mint]),tokenDecimals:state.mintData.decimals,
      ...(state.identity?{tokenIdentity:{...state.identity}}:{})};
  }

  /** A confirmed Jupiter holding already has immutable wallet/mint/decimal
   * identity in the position journal. Its exact target -> SOL exit quote does
   * not need to rediscover the Pump curve or quote mint on every price wake.
   * The executable sell still runs build(), which repeats the complete chain
   * preflight immediately before simulation, signing and broadcast. */
  async quoteKnownSell(request:Omit<NativeSwapRequest,'side'>,tokenDecimals:number,
    protectionMode:'account_stream'|'external_price_stream',priority:JupiterRequestPriority='exit'):Promise<NativeSellQuote>{
    const wallet=key(request.wallet),mintKey=key(request.mint);
    if(!Number.isInteger(tokenDecimals)||tokenDecimals<0||tokenDecimals>255||protectionMode!=='external_price_stream')
      fail('NATIVE_KNOWN_ROUTE_INVALID');
    const route=await this.jupiter.build({user:wallet.toBase58(),inputMint:mintKey.toBase58(),outputMint:NATIVE_MINT.toBase58(),
      amount:request.amount,slippageBps:request.slippageBps,priority,...(request.signal?{signal:request.signal}:{})});
    return {venue:'jupiter',protectionMode:'external_price_stream',mint:request.mint,side:'sell',inputAmount:request.amount,
      expectedOutputAmount:route.expectedOutputAmount,minimumOutputAmount:route.minimumOutputAmount,quotedAt:new Date().toISOString(),
      subscriptionAccounts:[wallet.toBase58(),mintKey.toBase58()],tokenDecimals};
  }

  private async verifyProtectionCapacity(request:NativeSwapRequest,plan:NativeSwapPlan):Promise<void>{
    // Reuse only the exact capacity proof that belongs to this candidate plan.
    // A different fill size, slippage or wake mode needs its own full exit
    // quote even when the wallet and mint are identical. Half-size protection
    // is checked only after the full position has actually crossed +100%.
    const cacheKey=[request.wallet,request.mint,plan.expectedOutputAmount,request.slippageBps,plan.protectionMode].join(':'),now=Date.now();
    if((this.protectionProbeUntil.get(cacheKey)??0)>now)return;
    const full=BigInt(plan.expectedOutputAmount);if(full<=0n)fail('NATIVE_PROTECTION_QUOTE_UNAVAILABLE');
    const controller=new AbortController(),signal=request.signal?AbortSignal.any([request.signal,controller.signal]):controller.signal;
    try{
      await this.quoteKnownSell({...request,amount:full.toString(),signal},plan.tokenDecimals,plan.protectionMode,'entry');
      this.protectionProbeUntil.set(cacheKey,Date.now()+5000);
    }catch(error){controller.abort();throw error;}
  }

  async build(request:NativeSwapRequest):Promise<NativeSwapPlan>{
    if(request.side==='buy'&&this.jupiterStatus().entryCapacity<1)fail('NATIVE_JUPITER_PROTECTION_CAPACITY_REACHED');
    const wallet=key(request.wallet),mintKey=key(request.mint),capability=await this.capability(request.mint);
    if(capability.route==='direct')fail('NATIVE_ROUTE_CHANGED');
    const state=capability.route==='pump_bridge'?await this.load(wallet,mintKey,true,capability):await this.loadJupiter(wallet,mintKey,capability);
    const plan=await this.endToEndPlan(request,state,true);if(request.side==='buy')await this.verifyProtectionCapacity(request,plan);return plan;
  }
  async quoteSell(request:Omit<NativeSwapRequest,'side'>):Promise<NativeSellQuote>{
    const wallet=key(request.wallet),mintKey=key(request.mint),capability=await this.capability(request.mint);
    if(capability.route==='direct')fail('NATIVE_ROUTE_CHANGED');
    const state=capability.route==='pump_bridge'?await this.load(wallet,mintKey,true,capability):await this.loadJupiter(wallet,mintKey,capability);
    const plan=await this.endToEndPlan({...request,side:'sell'},state,false);
    const {instructions:_,addressLookupTables:__,...quote}=plan;return quote;
  }

  async warm(walletAddress:string,mintAddress:string):Promise<NativeQuoteCacheWarm>{
    const capability=await this.capability(mintAddress);if(capability.route!=='pump_bridge')fail('NATIVE_EXTERNAL_BRIDGE_MONITOR_UNSUPPORTED');
    const cacheKey=`${walletAddress}:${mintAddress}`,state=await this.load(key(walletAddress),key(mintAddress),true,capability),accounts=new Map<string,{info:AccountInfo<Buffer>|null;slot:number;receivedAtMs:number}>();
    state.keys.forEach((address,index)=>accounts.set(address.toBase58(),{info:state.values[index],slot:state.slot,receivedAtMs:state.receivedAtMs}));
    const watched=new Set([0,1,2,3,4,5,6,7,10,11,12].map(index=>state.keys[index].toBase58()));
    const entry:CacheEntry={state,accounts,watched,coherent:{target:new Set(),bridge:new Set()}};this.cache.set(cacheKey,entry);
    for(const address of watched){const set=this.byAccount.get(address)??new Set<string>();set.add(cacheKey);this.byAccount.set(address,set);}
    return {venue:'pumpswap',subscriptionAccounts:unique([...state.keys,state.wallet]),priceAccounts:[...watched],slot:state.slot,receivedAtMs:state.receivedAtMs,
      tokenDecimals:state.mintData.decimals,tokenProgram:state.tokenProgram.toBase58(),...(state.identity?{tokenIdentity:{...state.identity}}:{})};
  }

  ingest(address:string,info:AccountInfo<Buffer>|null,slot:number,receivedAtMs:number):string[]{
    const indexed=this.byAccount.get(address);if(!indexed)return [];const affected=new Set<string>();
    for(const cacheKey of indexed){const entry=this.cache.get(cacheKey);if(!entry)continue;affected.add(entry.state.mint.toBase58());
      try{
        const previous=entry.accounts.get(address);if(!previous||slot<previous.slot||receivedAtMs<previous.receivedAtMs)fail('NATIVE_STREAM_SLOT_REGRESSION');
        entry.accounts.set(address,{info,slot,receivedAtMs});const index=entry.state.keys.findIndex(value=>value.toBase58()===address);if(index<0)fail('NATIVE_STREAM_ACCOUNT_INVALID');
        entry.state.values[index]=info;
        if([5,6,7].includes(index))entry.coherent.target.add(address);if([10,11,12].includes(index))entry.coherent.bridge.add(address);
        for(const [leg,set,indexes] of [['target',entry.coherent.target,[5,6,7]],['bridge',entry.coherent.bridge,[10,11,12]]] as const){
          if(!set.size)continue;const slots=indexes.map(i=>entry.accounts.get(entry.state.keys[i].toBase58())!.slot);
          if(set.size<3||slots.some(value=>value!==slots[0])){entry.pending='NATIVE_STREAM_SLOT_INCOMPLETE';continue;}set.clear();
        }
        if(!entry.coherent.target.size&&!entry.coherent.bridge.size){entry.state=this.decode(entry.state);entry.state.slot=Math.max(...[5,6,7,10,11,12].map(i=>entry.accounts.get(entry.state.keys[i].toBase58())!.slot));
          entry.state.receivedAtMs=receivedAtMs;entry.pending=undefined;}
      }catch(error){entry.invalid=error instanceof Error&&error.message.startsWith('NATIVE_')?error.message:'NATIVE_STREAM_ACCOUNT_INVALID';}
    }
    return [...affected];
  }

  quoteCached(request:Omit<NativeSwapRequest,'side'>,options:NativeQuoteCacheOptions={}):NativeStreamQuote {
    const found=this.cache.get(`${request.wallet}:${request.mint}`);if(!found)fail('NATIVE_STREAM_CACHE_COLD');const entry=found as CacheEntry;
    if(entry.invalid)fail(entry.invalid);if(entry.pending)fail(entry.pending);
    const now=options.nowMs??Date.now();if(options.maxStreamAgeMs!==undefined&&now-entry.state.receivedAtMs>options.maxStreamAgeMs)fail('NATIVE_STREAM_QUOTE_STALE');
    if(options.headSlot!==undefined&&entry.state.slot>options.headSlot+2)fail('NATIVE_STREAM_CONTEXT_INVALID');
    const plan=this.localPlanSync({...request,side:'sell'},entry.state);
    return {...plan,slot:entry.state.slot,receivedAtMs:entry.state.receivedAtMs};
  }
  private localPlanSync(request:NativeSwapRequest,state:RouteState):NativeSellQuote {
    const amount=new BN(request.amount),[firstBps,secondBps]=split(request.slippageBps),route=this.routeQuote(state,'sell',amount),intermediate=less(route.intermediate,firstBps);
    const minimum=less(poolQuote(state.bridge!,'sell',intermediate),secondBps);
    return {venue:'pumpswap',protectionMode:'account_stream',mint:request.mint,side:'sell',inputAmount:request.amount,expectedOutputAmount:route.expected.toString(),minimumOutputAmount:minimum.toString(),
      quotedAt:new Date(state.receivedAtMs).toISOString(),subscriptionAccounts:unique([...state.keys,state.wallet]),tokenDecimals:state.mintData.decimals};
  }
  status(wallet:string,mintAddress:string){const entry=this.cache.get(`${wallet}:${mintAddress}`);return entry?{present:true,warm:!entry.invalid,ready:!entry.invalid&&!entry.pending,
    reason:entry.invalid??entry.pending,venue:'pumpswap' as const,slot:entry.state.slot,receivedAtMs:entry.state.receivedAtMs,priceAccounts:[...entry.watched]}:
    {present:false,warm:false,ready:false,reason:'NATIVE_STREAM_CACHE_COLD'};}
  drop(wallet:string,mintAddress:string){const cacheKey=`${wallet}:${mintAddress}`,entry=this.cache.get(cacheKey);this.cache.delete(cacheKey);if(entry)for(const address of entry.watched){const set=this.byAccount.get(address);set?.delete(cacheKey);if(!set?.size)this.byAccount.delete(address);}}
  invalidate(){this.cache.clear();this.byAccount.clear();this.protectionProbeUntil.clear();}
}

