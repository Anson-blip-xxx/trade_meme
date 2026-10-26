import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import {BorshInstructionCoder} from '@coral-xyz/anchor';
import {ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo} from '@solana/web3.js';
import {MintLayout, AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  ExtensionType, getMintLen, getTypeLen, getAssociatedTokenAddressSync, decodeTransferCheckedInstruction} from '@solana/spl-token';
import {getPumpProgram, PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_FEE_CONFIG_PDA, GLOBAL_PDA,
  bondingCurvePda} from '@pump-fun/pump-sdk';
import {getPumpAmmProgram, PUMP_AMM_PROGRAM_ID, PUMP_AMM_FEE_CONFIG_PDA, GLOBAL_CONFIG_PDA,
  canonicalPumpPoolPda,pumpPoolAuthorityPda} from '@pump-fun/pump-swap-sdk';
import {PumpNativeAdapter, type NativeSwapPlan} from '../src/native-solana/pump.js';
import {jitoTipInstruction} from '../src/native-solana/jito.js';
import {pack} from '@solana/spl-token-metadata';

const wallet=Keypair.fromSeed(Buffer.alloc(32,41)).publicKey;
const mint=Keypair.fromSeed(Buffer.alloc(32,42)).publicKey;
const creator=Keypair.fromSeed(Buffer.alloc(32,43)).publicKey;
const feeRecipient=Keypair.fromSeed(Buffer.alloc(32,46)).publicKey;
const buybackRecipient=Keypair.fromSeed(Buffer.alloc(32,47)).publicKey;
const tipRecipient=Keypair.fromSeed(Buffer.alloc(32,48)).publicKey;
const curveKey=bondingCurvePda(mint),poolKey=canonicalPumpPoolPda(mint,NATIVE_MINT);
const disconnected=new Connection('https://example.invalid');
const pumpProgram=getPumpProgram(disconnected),ammProgram=getPumpAmmProgram(disconnected);
const account=(data:Buffer,owner:PublicKey):AccountInfo<Buffer>=>({data,owner,lamports:1_000_000_000,executable:false,rentEpoch:0});
function defaults(program:any,name:string):any {
  const fields=program.idl.types.find((entry:any)=>entry.name===name).type.fields;
  function value(type:any):any {
    if(type==='pubkey')return PublicKey.default;
    if(type==='bool')return false;
    if(['u8','u16','u32','i8','i16','i32'].includes(type))return 0;
    if(typeof type==='string'&&/^[ui]\d+$/.test(type))return new BN(0);
    if(type.array)return Array.from({length:type.array[1]},()=>value(type.array[0]));
    if(type.vec)return [];
    if(type.defined)return defaults(program,type.defined.name);
    throw Error('Unsupported fixture field');
  }
  return Object.fromEntries(fields.map((field:any)=>[field.name,value(field.type)]));
}
function encoded(program:any,name:string,data:any,minimumSize=0):Buffer {
  // The real IDL layout is used, with a larger buffer than Anchor's 1,000-byte
  // encode helper, because the current Pump Global is 1,088 bytes.
  const layout=program.coder.accounts.accountLayouts.get(name);
  const body=Buffer.alloc(16_384),length=layout.layout.encode(data,body);
  const raw=Buffer.concat([Buffer.from(layout.discriminator),body.subarray(0,length)]);
  return raw.length>=minimumSize?raw:Buffer.concat([raw,Buffer.alloc(minimumSize-raw.length)]);
}
function mintAccount(program=TOKEN_PROGRAM_ID,decimals=6,extension?:ExtensionType):AccountInfo<Buffer> {
  const data=Buffer.alloc(extension===undefined?82:getMintLen([extension]));
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1_000_000_000_000_000n,
    decimals,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  if(extension!==undefined){data[165]=1;data.writeUInt16LE(extension,166);data.writeUInt16LE(getTypeLen(extension),168);}
  return account(data,program);
}
function metadataMintAccount(name:string,symbol:string):AccountInfo<Buffer> {
  const metadata=Buffer.from(pack({mint,updateAuthority:undefined,name,symbol,uri:'https://example.invalid/meta.json',additionalMetadata:[]}));
  const data=Buffer.alloc(170+metadata.length);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1_000_000_000_000_000n,
    decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  data[165]=1;data.writeUInt16LE(ExtensionType.TokenMetadata,166);data.writeUInt16LE(metadata.length,168);metadata.copy(data,170);
  return account(data,TOKEN_2022_PROGRAM_ID);
}
function tokenAccount(authority:PublicKey,amount:bigint,program=TOKEN_PROGRAM_ID,tokenMint=mint,state=1):AccountInfo<Buffer> {
  const data=Buffer.alloc(165);
  AccountLayout.encode({mint:tokenMint,owner:authority,amount,delegateOption:0,delegate:PublicKey.default,state,
    isNativeOption:tokenMint.equals(NATIVE_MINT)?1:0,isNative:tokenMint.equals(NATIVE_MINT)?2_039_280n:0n,
    delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  return account(data,program);
}
const defaultMint=mint;
interface Options {venue?:'pump'|'pumpswap';cashback?:boolean;decimals?:number;token2022?:boolean;extension?:ExtensionType;virtualQuote?:string;mintKey?:PublicKey;}
function fixture(options:Options={}) {
  const mint=options.mintKey??defaultMint,curveKey=bondingCurvePda(mint),poolKey=canonicalPumpPoolPda(mint,NATIVE_MINT);
  const program=options.token2022?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
  const userAta=getAssociatedTokenAddressSync(mint,wallet,true,program);
  const curveVault=getAssociatedTokenAddressSync(mint,curveKey,true,program);
  const poolBase=getAssociatedTokenAddressSync(mint,poolKey,true,program),poolQuote=getAssociatedTokenAddressSync(NATIVE_MINT,poolKey,true);
  const map=new Map<string,AccountInfo<Buffer>>();
  map.set(mint.toBase58(),mintAccount(program,options.decimals??6,options.extension));
  const curve={...defaults(pumpProgram,'bondingCurve'),virtualTokenReserves:new BN('1073000000000000'),
    virtualQuoteReserves:new BN('30000000000'),realTokenReserves:new BN('793100000000000'),
    realQuoteReserves:new BN('10000000000'),tokenTotalSupply:new BN('1000000000000000'),creator,
    complete:options.venue==='pumpswap',isCashbackCoin:options.cashback??false};
  const global={...defaults(pumpProgram,'global'),initialized:true,feeRecipient,feeRecipients:Array(7).fill(feeRecipient),
    buybackFeeRecipients:Array(8).fill(buybackRecipient),creatorFeeBasisPoints:new BN(50),feeBasisPoints:new BN(100),poolMigrationFee:new BN(15_000_001)};
  const fees={lpFeeBps:new BN(20),protocolFeeBps:new BN(100),creatorFeeBps:new BN(50)};
  const feeConfig={...defaults(pumpProgram,'feeConfig'),flatFees:fees,feeTiers:[{marketCapLamportsThreshold:new BN(0),fees}]};
  map.set(curveKey.toBase58(),account(encoded(pumpProgram,'bondingCurve',curve),PUMP_PROGRAM_ID));
  map.set(GLOBAL_PDA.toBase58(),account(encoded(pumpProgram,'global',global),PUMP_PROGRAM_ID));
  map.set(PUMP_FEE_CONFIG_PDA.toBase58(),account(encoded(pumpProgram,'feeConfig',feeConfig,4097),PUMP_FEE_PROGRAM_ID));
  map.set(curveVault.toBase58(),tokenAccount(curveKey,1_000_000_000_000_000n,program,mint));
  map.set(userAta.toBase58(),tokenAccount(wallet,100_000_000n,program,mint));
  const pool={...defaults(ammProgram,'pool'),index:0,creator:pumpPoolAuthorityPda(mint),baseMint:mint,quoteMint:NATIVE_MINT,
    poolBaseTokenAccount:poolBase,poolQuoteTokenAccount:poolQuote,coinCreator:creator,lpMint:creator,
    virtualQuoteReserves:new BN(options.virtualQuote??'0'),isCashbackCoin:options.cashback??false};
  const ammGlobal={...defaults(ammProgram,'globalConfig'),protocolFeeRecipients:Array(8).fill(feeRecipient),
    buybackFeeRecipients:Array(8).fill(buybackRecipient),lpFeeBasisPoints:new BN(20),protocolFeeBasisPoints:new BN(100),coinCreatorFeeBasisPoints:new BN(50)};
  map.set(poolKey.toBase58(),account(encoded(ammProgram,'pool',pool),PUMP_AMM_PROGRAM_ID));
  map.set(GLOBAL_CONFIG_PDA.toBase58(),account(encoded(ammProgram,'globalConfig',ammGlobal),PUMP_AMM_PROGRAM_ID));
  map.set(PUMP_AMM_FEE_CONFIG_PDA.toBase58(),account(encoded(ammProgram,'feeConfig',feeConfig,4097),PUMP_FEE_PROGRAM_ID));
  map.set(poolBase.toBase58(),tokenAccount(poolKey,100_000_000_000_000n,program,mint));
  map.set(poolQuote.toBase58(),tokenAccount(poolKey,50_000_000_000n,TOKEN_PROGRAM_ID,NATIVE_MINT));
  const owned=[userAta];const calls:{method:string;config:any}[]=[];
  const connection={
    async getMultipleAccountsInfoAndContext(keys:PublicKey[],config:any){calls.push({method:'multiple',config});
      return {context:{slot:100},value:keys.map(key=>map.get(key.toBase58())??null)};},
    async getTokenAccountsByOwner(_wallet:PublicKey,filter:any,config:any){calls.push({method:'owner',config});assert.equal(filter.mint.toBase58(),mint.toBase58());
      return {context:{slot:101},value:owned.filter(key=>map.has(key.toBase58())).map(pubkey=>({pubkey,account:map.get(pubkey.toBase58())!}))};},
  } as unknown as Connection;
  const adapter=new PumpNativeAdapter({connection});
  const request=(side:'buy'|'sell',amount=side==='buy'?'10000000':'100000000',slippageBps=100)=>({wallet:wallet.toBase58(),mint:mint.toBase58(),side,amount,slippageBps});
  return {adapter,map,owned,calls,request,program,userAta,curveVault,poolBase,poolQuote,curve,pool,global,ammGlobal,mint,curveKey,poolKey};
}
function decoded(plan:NativeSwapPlan) {
  const program=plan.venue==='pump'?pumpProgram:ammProgram,coder=new BorshInstructionCoder(program.idl);
  return plan.instructions.filter(ix=>ix.programId.equals(program.programId)).map(ix=>coder.decode(ix.data)!);
}

test('real Pump SDK builds exact SOL input with integer minimum once, never increases spend by slippage',async()=>{
  const f=fixture();const plan=await f.adapter.build(f.request('buy','10000000',137));
  assert.equal(plan.venue,'pump');assert.equal(plan.tokenDecimals,6);
  const trade=decoded(plan).find(ix=>ix.name==='buyExactQuoteInV3')!;assert.ok(trade);
  const data=trade.data as any;
  assert.equal(data.spendableQuoteIn.toString(),'10000000');
  assert.equal(data.minTokensOut.toString(),plan.minimumOutputAmount);
  assert.equal(BigInt(plan.minimumOutputAmount),BigInt(plan.expectedOutputAmount)*9863n/10000n);
  assert.equal(data.partialFill[0],false);
  assert.ok(plan.subscriptionAccounts.includes(curveKey.toBase58()));
  assert.ok(plan.subscriptionAccounts.includes(f.userAta.toBase58()));
  assert.ok(f.calls.every(call=>call.config.commitment==='confirmed'));
});

test('real Pump sell sets exact token quantity and net SOL minOut without a second slippage adjustment',async()=>{
  const f=fixture();const plan=await f.adapter.build(f.request('sell','99999999',1));
  const trade=decoded(plan).find(ix=>ix.name==='sellV3')!,data=trade.data as any;
  assert.equal(data.amount.toString(),'99999999');assert.equal(data.minSolOutput.toString(),plan.minimumOutputAmount);
  assert.equal(BigInt(plan.minimumOutputAmount),BigInt(plan.expectedOutputAmount)*9999n/10000n);
});

test('canonical migrated PumpSwap uses SDK exact-in-v2 and exact token sell instructions',async()=>{
  for(const side of ['buy','sell'] as const){const f=fixture({venue:'pumpswap'}),plan=await f.adapter.build(f.request(side));
    const name=side==='buy'?'buyExactQuoteInV2':'sellV2';const trade=decoded(plan).find(ix=>ix.name===name)!;assert.ok(trade);
    const data=trade.data as any;
    assert.equal((side==='buy'?data.spendableQuoteIn:data.baseAmountIn).toString(),plan.inputAmount);
    assert.equal((side==='buy'?data.minBaseAmountOut:data.minQuoteAmountOut).toString(),plan.minimumOutputAmount);
    assert.ok(plan.subscriptionAccounts.includes(poolKey.toBase58()));assert.ok(plan.subscriptionAccounts.includes(f.poolQuote.toBase58()));
    assert.ok(plan.instructions.every(ix=>ix.keys.every(k=>!k.isSigner||k.pubkey.equals(wallet))));
  }
});

test('cashback curves and pools fall back to official compatible exact-input instructions',async()=>{
  for(const venue of ['pump','pumpswap'] as const)for(const side of ['buy','sell'] as const){
    const f=fixture({venue,cashback:true});const plan=await f.adapter.build(f.request(side));
    const name=venue==='pump'?(side==='buy'?'buyExactQuoteInV2':'sellV2'):(side==='buy'?'buyExactQuoteIn':'sell');
    const trade=decoded(plan).find(ix=>ix.name===name)!;assert.ok(trade,`${venue} ${side}`);
    const data=trade.data as any;
    if(side==='buy')assert.equal(data.spendableQuoteIn.toString(),plan.inputAmount);
    else assert.equal((venue==='pump'?data.amount:data.baseAmountIn).toString(),plan.inputAmount);
  }
});

test('native protocol transactions include the executor envelope within the v0 packet size',async(t)=>{
  for(const venue of ['pump','pumpswap'] as const)for(const cashback of [false,true])for(const token2022 of [false,true])for(const side of ['buy','sell'] as const){
    const f=fixture({venue,cashback,token2022});
    if(side==='buy')f.map.delete(f.userAta.toBase58());
    const plan=await f.adapter.build(f.request(side));
    const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),
      ComputeBudgetProgram.setComputeUnitPrice({microLamports:50_000n}),...plan.instructions,
      jitoTipInstruction(wallet.toBase58(),tipRecipient.toBase58(),'10000')];
    const message=new TransactionMessage({payerKey:wallet,recentBlockhash:creator.toBase58(),instructions}).compileToV0Message();
    const size=new VersionedTransaction(message).serialize().length;
    t.diagnostic(`${venue} cashback=${cashback} token2022=${token2022} ${side}: ${size} bytes, ${message.staticAccountKeys.length} accounts`);
    assert.ok(size<=1232,`${venue} cashback=${cashback} ${side}: ${size} bytes`);
  }
});

test('signed negative virtual reserves reduce executable pool quotes instead of being ignored or unsigned',async()=>{
  const normal=fixture({venue:'pumpswap'}),negative=fixture({venue:'pumpswap',virtualQuote:'-1000000000'});
  const a=await normal.adapter.quoteSell(normal.request('sell')),b=await negative.adapter.quoteSell(negative.request('sell'));
  assert.ok(BigInt(b.expectedOutputAmount)>0n);assert.ok(BigInt(b.expectedOutputAmount)<BigInt(a.expectedOutputAmount));
  const invalid=fixture({venue:'pumpswap',virtualQuote:'-50000000001'});
  await assert.rejects(invalid.adapter.build(invalid.request('sell')),/NATIVE_POOL_LIQUIDITY_INVALID/);
});

test('quoteSell never needs a signer, ownership inventory, or an existing user ATA',async()=>{
  const f=fixture();f.map.delete(f.userAta.toBase58());
  const quote=await f.adapter.quoteSell(f.request('sell'));
  assert.ok(BigInt(quote.expectedOutputAmount)>0n);assert.equal('instructions' in quote,false);
  assert.ok(f.calls.every(call=>call.method!=='owner'));
});

test('balance aggregates atomic integer amounts and defaults to finalized with an explicit confirmed option',async()=>{
  const f=fixture({decimals:9});const second=Keypair.fromSeed(Buffer.alloc(32,44)).publicKey;
  f.map.set(f.userAta.toBase58(),tokenAccount(wallet,9007199254740993n));
  f.map.set(second.toBase58(),tokenAccount(wallet,9007199254740995n));f.owned.push(second);
  const result=await f.adapter.balance(wallet.toBase58(),mint.toBase58());
  assert.equal(result.amount,'18014398509481988');assert.equal(result.decimals,9);assert.equal(result.slot,101);
  assert.deepEqual(result.accounts,[f.userAta.toBase58(),second.toBase58()]);
  assert.equal(result.commitment,'finalized');assert.ok(f.calls.every(call=>call.config.commitment==='finalized'));
  f.calls.length=0;
  assert.equal((await f.adapter.balance(wallet.toBase58(),mint.toBase58(),'confirmed')).commitment,'confirmed');
  assert.ok(f.calls.every(call=>call.config.commitment==='confirmed'));
});

test('sell consolidates exactly the missing atomic quantity from a non-ATA in the same transaction',async()=>{
  const f=fixture({token2022:true});const second=Keypair.fromSeed(Buffer.alloc(32,44)).publicKey;
  f.map.set(f.userAta.toBase58(),tokenAccount(wallet,30_000_001n,f.program));
  f.map.set(second.toBase58(),tokenAccount(wallet,80_000_000n,f.program));f.owned.push(second);
  const plan=await f.adapter.build(f.request('sell','100000000'));
  const transfers=plan.instructions.filter(ix=>ix.programId.equals(TOKEN_2022_PROGRAM_ID)&&ix.data[0]===12);
  assert.equal(transfers.length,1);
  const transfer=decodeTransferCheckedInstruction(transfers[0],TOKEN_2022_PROGRAM_ID);
  assert.equal(transfer.data.amount,69_999_999n);assert.equal(transfer.data.decimals,6);
  assert.ok(transfer.keys.source.pubkey.equals(second));assert.ok(transfer.keys.destination.pubkey.equals(f.userAta));
  assert.ok(plan.subscriptionAccounts.includes(second.toBase58()));
});

test('Token-2022 metadata is allowed while transfer fees/hooks/unknown economics are rejected',async()=>{
  const supported=fixture({token2022:true,extension:ExtensionType.MetadataPointer});
  assert.equal((await supported.adapter.build(supported.request('buy'))).tokenDecimals,6);
  for(const extension of [ExtensionType.TransferFeeConfig,ExtensionType.TransferHook,ExtensionType.PermanentDelegate,ExtensionType.ScaledUiAmountConfig]){
    const f=fixture({token2022:true,extension});
    await assert.rejects(f.adapter.build(f.request('buy')),/NATIVE_TOKEN_EXTENSION_UNSUPPORTED/);
  }
});

test('build and warm bind Token-2022 display identity to the exact transaction mint without another RPC',async()=>{
  const f=fixture({token2022:true});f.map.set(mint.toBase58(),metadataMintAccount('ハッチャン','Hatchan'));
  const plan=await f.adapter.build(f.request('buy'));
  assert.deepEqual(plan.tokenIdentity,{source:'token_2022_mint_extension',name:'ハッチャン',symbol:'Hatchan'});
  const before=f.calls.length,warm=await f.adapter.warmQuoteCache(f.request('buy').wallet,mint.toBase58());
  assert.deepEqual(warm.tokenIdentity,plan.tokenIdentity);
  assert.equal(f.calls.length,before+2,'identity reuses the two existing route snapshot calls');
});

test('owner, canonical pool identity, SOL quote and migration state are verified before building',async()=>{
  const fake=fixture();fake.map.get(curveKey.toBase58())!.owner=SystemProgram.programId;
  await assert.rejects(fake.adapter.build(fake.request('buy')),/NATIVE_ACCOUNT_OWNER_INVALID/);
  const badPool=fixture({venue:'pumpswap'});badPool.pool.creator=creator;
  badPool.map.set(poolKey.toBase58(),account(encoded(ammProgram,'pool',badPool.pool),PUMP_AMM_PROGRAM_ID));
  await assert.rejects(badPool.adapter.build(badPool.request('buy')),/NATIVE_POOL_IDENTITY_INVALID/);
  const nonSol=fixture();nonSol.curve.quoteMint=creator;
  nonSol.map.set(curveKey.toBase58(),account(encoded(pumpProgram,'bondingCurve',nonSol.curve),PUMP_PROGRAM_ID));
  await assert.rejects(nonSol.adapter.build(nonSol.request('buy')),/NATIVE_QUOTE_MINT_UNSUPPORTED/);
  const migrating=fixture({venue:'pumpswap'});migrating.map.delete(poolKey.toBase58());
  await assert.rejects(migrating.adapter.build(migrating.request('sell')),/NATIVE_ACCOUNT_OWNER_INVALID/);
});

test('invalid inputs, dust outputs and insufficient token balances fail closed',async()=>{
  const f=fixture();
  for(const amount of ['0','-1','1.2','01','18446744073709551616'])
    await assert.rejects(f.adapter.build(f.request('buy',amount)),/NATIVE_AMOUNT_INVALID/);
  await assert.rejects(f.adapter.build({...f.request('buy'),amount:10_000_000 as unknown as string}),/NATIVE_AMOUNT_INVALID/);
  for(const bps of [-1,1.5,10000,NaN])await assert.rejects(f.adapter.build(f.request('buy','10000000',bps)),/NATIVE_SLIPPAGE_INVALID/);
  await assert.rejects(f.adapter.build(f.request('buy','1')),/NATIVE_QUOTE_UNAVAILABLE/);
  await assert.rejects(f.adapter.build(f.request('sell','100000001')),/NATIVE_HOLDING_INSUFFICIENT/);
  for(const decimals of [0,9,18,255]) {
    const exact=fixture({decimals});const plan=await exact.adapter.build(exact.request('buy'));
    assert.equal(plan.inputAmount,'10000000');assert.equal(plan.tokenDecimals,decimals);
  }
});

test('WS quote cache reuses the validated SDK formula with zero RPC on every quote and update',async()=>{
  for(const venue of ['pump','pumpswap'] as const){
    const f=fixture({venue}),request=f.request('sell');
    const expected=await f.adapter.quoteSell(request),warm=await f.adapter.warmQuoteCache(request.wallet,request.mint);
    const calls=f.calls.length;
    for(let i=0;i<100;i++){
      const quote=f.adapter.quoteSellCached(request,{headSlot:100+i});
      assert.equal(quote.expectedOutputAmount,expected.expectedOutputAmount);
      assert.equal(quote.minimumOutputAmount,expected.minimumOutputAmount);
      assert.equal(quote.quotedAt,new Date(warm.receivedAtMs).toISOString());
    }
    assert.equal(f.calls.length,calls);assert.equal(warm.tokenDecimals,6);assert.equal(warm.tokenProgram,f.program.toBase58());
    assert.ok(!warm.priceAccounts.includes(f.userAta.toBase58()));
  }
});

test('Pump curve updates calculate the new sell price in memory without inventing a new timestamp when idle',async()=>{
  const f=fixture(),request=f.request('sell'),warm=await f.adapter.warmQuoteCache(request.wallet,request.mint);
  const initial=f.adapter.quoteSellCached(request),received=warm.receivedAtMs+1;
  f.curve.virtualQuoteReserves=new BN('60000000000');
  const updated=account(encoded(pumpProgram,'bondingCurve',f.curve),PUMP_PROGRAM_ID);
  f.map.set(curveKey.toBase58(),updated);
  const calls=f.calls.length;
  assert.deepEqual(f.adapter.ingestAccount(curveKey.toBase58(),updated,101,received),[mint.toBase58()]);
  const quote=f.adapter.quoteSellCached(request,{nowMs:received,headSlot:101});
  assert.ok(BigInt(quote.expectedOutputAmount)>BigInt(initial.expectedOutputAmount));
  assert.equal(quote.slot,101);assert.equal(quote.receivedAtMs,received);assert.equal(f.calls.length,calls);
  const fresh=await f.adapter.quoteSell(request);assert.equal(quote.expectedOutputAmount,fresh.expectedOutputAmount);
  assert.equal(f.adapter.quoteSellCached(request,{nowMs:received+60_000,headSlot:999}).quotedAt,quote.quotedAt);
  assert.throws(()=>f.adapter.quoteSellCached(request,{nowMs:received+1001,maxStreamAgeMs:1000}),/NATIVE_STREAM_QUOTE_STALE/);
  assert.equal(f.adapter.ingestAccount(f.userAta.toBase58(),null,102,received+2).length,0);
  assert.equal(f.adapter.quoteSellCached(request,{nowMs:received+60_000}).quotedAt,quote.quotedAt);
});

test('PumpSwap refuses every partial or cross-slot pool/vault update until all three match',async()=>{
  const f=fixture({venue:'pumpswap'}),request=f.request('sell'),warm=await f.adapter.warmQuoteCache(request.wallet,request.mint);
  const received=warm.receivedAtMs+1,calls=f.calls.length;
  const base=tokenAccount(poolKey,90_000_000_000_000n),quote=tokenAccount(poolKey,60_000_000_000n,TOKEN_PROGRAM_ID,NATIVE_MINT);
  f.adapter.ingestAccount(f.poolBase.toBase58(),base,101,received);
  assert.throws(()=>f.adapter.quoteSellCached(request,{nowMs:received}),/NATIVE_STREAM_SLOT_INCOMPLETE/);
  f.adapter.ingestAccount(f.poolQuote.toBase58(),quote,102,received+1);
  f.adapter.ingestAccount(poolKey.toBase58(),f.map.get(poolKey.toBase58())!,102,received+1);
  assert.throws(()=>f.adapter.quoteSellCached(request,{nowMs:received+1}),/NATIVE_STREAM_SLOT_INCOMPLETE/);
  f.adapter.ingestAccount(f.poolBase.toBase58(),base,102,received+2);
  const result=f.adapter.quoteSellCached(request,{nowMs:received+2});
  assert.equal(result.slot,102);assert.equal(result.receivedAtMs,received+2);assert.equal(f.calls.length,calls);
  f.map.set(f.poolBase.toBase58(),base);f.map.set(f.poolQuote.toBase58(),quote);
  assert.equal(result.expectedOutputAmount,(await f.adapter.quoteSell(request)).expectedOutputAmount);
});

test('migration invalidates the old venue until a fresh canonical snapshot is warmed',async()=>{
  const f=fixture(),request=f.request('sell'),warm=await f.adapter.warmQuoteCache(request.wallet,request.mint);
  f.curve.complete=true;const migrated=account(encoded(pumpProgram,'bondingCurve',f.curve),PUMP_PROGRAM_ID);
  f.map.set(curveKey.toBase58(),migrated);
  f.adapter.ingestAccount(curveKey.toBase58(),migrated,100,warm.receivedAtMs);
  assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_ROUTE_CHANGED/);
  const refreshed=await f.adapter.warmQuoteCache(request.wallet,request.mint);
  assert.equal(refreshed.venue,'pumpswap');assert.equal(f.adapter.quoteSellCached(request).venue,'pumpswap');
});

test('cache cloning, malformed account updates, regressions and reconnect invalidation fail closed',async()=>{
  for(const kind of ['owner','deleted','truncated','slot','receipt','future'] as const){
    const f=fixture(),request=f.request('sell'),warm=await f.adapter.warmQuoteCache(request.wallet,request.mint);
    const original=f.map.get(curveKey.toBase58())!;
    const updated=kind==='deleted'?null:kind==='truncated'?{...original,data:Buffer.alloc(2)}:
      {...original,owner:kind==='owner'?SystemProgram.programId:original.owner};
    f.adapter.ingestAccount(curveKey.toBase58(),updated,kind==='slot'?99:101,
      kind==='receipt'?warm.receivedAtMs-1:kind==='future'?Date.now()+10_000:warm.receivedAtMs);
    assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_/);
    assert.equal(f.adapter.cacheStatus(request.wallet,request.mint).ready,false);
  }
  const f=fixture(),request=f.request('sell');await f.adapter.warmQuoteCache(request.wallet,request.mint);
  const expected=f.adapter.quoteSellCached(request).expectedOutputAmount;
  f.map.get(curveKey.toBase58())!.data.fill(0);
  assert.equal(f.adapter.quoteSellCached(request).expectedOutputAmount,expected,'external Buffer mutation cannot change cached state');
  f.adapter.invalidateCache();assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_STREAM_CACHE_COLD/);
  assert.deepEqual(f.adapter.ingestAccount(curveKey.toBase58(),null,101,Date.now()),[]);
});

test('global fees and mint changes are validated and included in cache economics',async()=>{
  const f=fixture(),request=f.request('sell'),warm=await f.adapter.warmQuoteCache(request.wallet,request.mint);
  f.global.creatorFeeBasisPoints=new BN(5000);
  const global=account(encoded(pumpProgram,'global',f.global),PUMP_PROGRAM_ID);
  f.map.set(GLOBAL_PDA.toBase58(),global);
  f.adapter.ingestAccount(GLOBAL_PDA.toBase58(),global,101,warm.receivedAtMs);
  assert.equal(f.adapter.quoteSellCached(request).expectedOutputAmount,(await f.adapter.quoteSell(request)).expectedOutputAmount);
  f.adapter.ingestAccount(mint.toBase58(),mintAccount(TOKEN_2022_PROGRAM_ID,6,ExtensionType.TransferFeeConfig),102,Date.now());
  assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_TOKEN_EXTENSION_UNSUPPORTED/);
});

test('owner inventory can use an explicit separate RPC while market snapshots stay on primary',async()=>{
  const f=fixture(),original=(f.adapter as any).connection;
  let ownerCalls=0;
  const primary={getMultipleAccountsInfoAndContext:original.getMultipleAccountsInfoAndContext,
    getTokenAccountsByOwner:()=>{throw Error('must not use primary inventory');}} as unknown as Connection;
  const ownerConnection={getTokenAccountsByOwner:async(...args:any[])=>{ownerCalls++;return original.getTokenAccountsByOwner(...args);}} as unknown as Connection;
  const adapter=new PumpNativeAdapter({connection:primary,ownerConnection});
  const result=await adapter.balance(wallet.toBase58(),mint.toBase58());
  assert.equal(result.amount,'100000000');assert.equal(ownerCalls,1);
});

test('a snapshot completing after disconnect cannot repopulate the invalidated WS generation',async()=>{
  const f=fixture(),connection=(f.adapter as any).connection;
  const original=connection.getMultipleAccountsInfoAndContext.bind(connection);
  let release!:()=>void,arrived!:()=>void;
  const reached=new Promise<void>(resolve=>{arrived=resolve;});
  const barrier=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  connection.getMultipleAccountsInfoAndContext=async(...args:any[])=>{
    const result=await original(...args);if(++calls===2){arrived();await barrier;}return result;
  };
  const request=f.request('sell'),warming=f.adapter.warmQuoteCache(request.wallet,request.mint);
  await reached;f.adapter.invalidateCache();release();
  await assert.rejects(warming,/NATIVE_STREAM_CACHE_RESET/);
  assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_STREAM_CACHE_COLD/);
});

function delayNextWarmSnapshot(f:ReturnType<typeof fixture>) {
  const connection=(f.adapter as any).connection,original=connection.getMultipleAccountsInfoAndContext.bind(connection);
  let release!:()=>void,arrived!:()=>void,calls=0;
  const reached=new Promise<void>(resolve=>{arrived=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
  connection.getMultipleAccountsInfoAndContext=async(...args:any[])=>{
    const result=await original(...args);
    const captured={context:{...result.context},value:result.value.map((value:AccountInfo<Buffer>|null)=>value?{...value,data:Buffer.from(value.data)}:null)};
    if(++calls===2){arrived();await barrier;}return captured;
  };
  return {reached,release:()=>release()};
}

test('first warm overlays newer and same-slot WS frames received before account indexing',async()=>{
  for(const slot of [100,101]){
    const f=fixture(),request=f.request('sell'),initial=await f.adapter.quoteSell(request),held=delayNextWarmSnapshot(f);
    const warming=f.adapter.warmQuoteCache(request.wallet,request.mint);await held.reached;
    f.curve.virtualQuoteReserves=new BN('60000000000');
    const update=account(encoded(pumpProgram,'bondingCurve',f.curve),PUMP_PROGRAM_ID),at=Date.now();
    assert.deepEqual(f.adapter.ingestAccount(curveKey.toBase58(),update,slot,at),[],'unindexed frames have no affected mint yet');
    update.data.fill(0);held.release();await warming;
    const cached=f.adapter.quoteSellCached(request);
    assert.equal(cached.slot,slot);assert.ok(BigInt(cached.expectedOutputAmount)>BigInt(initial.expectedOutputAmount));
    assert.equal(cached.receivedAtMs,at,'HTTP completion must not relabel an older stream observation as a newly received price');
    const freshCurve=account(encoded(pumpProgram,'bondingCurve',f.curve),PUMP_PROGRAM_ID);f.map.set(curveKey.toBase58(),freshCurve);
    assert.equal(cached.expectedOutputAmount,(await f.adapter.quoteSell(request)).expectedOutputAmount,'the late snapshot cannot replace observed WS economics');
  }
});

test('initial AMM warm cannot publish a partial same-slot overlay as a coherent fresh quote',async()=>{
  const f=fixture({venue:'pumpswap'}),request=f.request('sell'),held=delayNextWarmSnapshot(f);
  const warming=f.adapter.warmQuoteCache(request.wallet,request.mint);await held.reached;
  const base=tokenAccount(poolKey,90_000_000_000_000n),quote=tokenAccount(poolKey,60_000_000_000n,TOKEN_PROGRAM_ID,NATIVE_MINT);
  f.adapter.ingestAccount(f.poolBase.toBase58(),base,100,Date.now());held.release();await warming;
  assert.equal(f.adapter.cacheStatus(request.wallet,request.mint).ready,false);
  assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_STREAM_SLOT_INCOMPLETE/);
  await f.adapter.warmQuoteCache(request.wallet,request.mint);
  assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_STREAM_SLOT_INCOMPLETE/,'a refresh cannot turn old snapshot members into missing WS updates');
  f.adapter.ingestAccount(GLOBAL_CONFIG_PDA.toBase58(),f.map.get(GLOBAL_CONFIG_PDA.toBase58())!,100,Date.now());
  assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_STREAM_SLOT_INCOMPLETE/,'an unrelated update cannot clear the partial overlay');
  f.adapter.ingestAccount(f.poolQuote.toBase58(),quote,100,Date.now());
  assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_STREAM_SLOT_INCOMPLETE/);
  f.adapter.ingestAccount(poolKey.toBase58(),f.map.get(poolKey.toBase58())!,100,Date.now());
  const cached=f.adapter.quoteSellCached(request);f.map.set(f.poolBase.toBase58(),base);f.map.set(f.poolQuote.toBase58(),quote);
  assert.equal(cached.expectedOutputAmount,(await f.adapter.quoteSell(request)).expectedOutputAmount);
});

test('subsequent AMM trades in the same slot wait for a new full pool and vault update cycle',async()=>{
  const f=fixture({venue:'pumpswap'}),request=f.request('sell');await f.adapter.warmQuoteCache(request.wallet,request.mint);
  for(const amount of [90_000_000_000_000n,80_000_000_000_000n]){
    const at=Date.now();f.adapter.ingestAccount(f.poolBase.toBase58(),tokenAccount(poolKey,amount),101,at);
    assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_STREAM_SLOT_INCOMPLETE/);
    await f.adapter.warmQuoteCache(request.wallet,request.mint);
    assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_STREAM_SLOT_INCOMPLETE/,'refresh retains an unfinished same-slot update cycle');
    f.adapter.ingestAccount(f.poolQuote.toBase58(),tokenAccount(poolKey,60_000_000_000n,TOKEN_PROGRAM_ID,NATIVE_MINT),101,Date.now());
    assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_STREAM_SLOT_INCOMPLETE/);
    f.adapter.ingestAccount(poolKey.toBase58(),f.map.get(poolKey.toBase58())!,101,Date.now());
    assert.equal(f.adapter.quoteSellCached(request).slot,101);
  }
});

test('snapshot refresh preserves the existing observed same-slot state instead of reverting the quote',async()=>{
  const f=fixture(),request=f.request('sell');await f.adapter.warmQuoteCache(request.wallet,request.mint);
  f.curve.virtualQuoteReserves=new BN('60000000000');
  f.adapter.ingestAccount(curveKey.toBase58(),account(encoded(pumpProgram,'bondingCurve',f.curve),PUMP_PROGRAM_ID),100,Date.now());
  const latest=f.adapter.quoteSellCached(request).expectedOutputAmount;
  await f.adapter.warmQuoteCache(request.wallet,request.mint);
  assert.equal(f.adapter.quoteSellCached(request).expectedOutputAmount,latest);
});

test('bounded pre-index WS buffer validates frames and a reconnect discards the entire old generation',async()=>{
  const f=fixture(),request=f.request('sell');
  f.adapter.ingestAccount('invalid-address',f.map.get(curveKey.toBase58())!,101,Date.now());
  f.adapter.ingestAccount(curveKey.toBase58(),{...f.map.get(curveKey.toBase58())!,data:Buffer.alloc(65_537)},101,Date.now());
  f.adapter.ingestAccount(curveKey.toBase58(),null,NaN,Date.now());
  assert.equal((f.adapter as any).latestStreamAccounts.size,0);
  for(let index=0;index<600;index++){
    const bytes=Buffer.alloc(32);bytes.writeUInt32LE(index);const address=new PublicKey(bytes).toBase58();
    f.adapter.ingestAccount(address,null,101,Date.now());
  }
  assert.equal((f.adapter as any).latestStreamAccounts.size,512);
  f.curve.virtualQuoteReserves=new BN('60000000000');
  f.adapter.ingestAccount(curveKey.toBase58(),account(encoded(pumpProgram,'bondingCurve',f.curve),PUMP_PROGRAM_ID),101,Date.now());
  f.adapter.invalidateCache();assert.equal((f.adapter as any).latestStreamAccounts.size,0);
  await f.adapter.warmQuoteCache(request.wallet,request.mint);
  assert.equal(f.adapter.quoteSellCached(request).expectedOutputAmount,(await f.adapter.quoteSell(request)).expectedOutputAmount);
});

test('buffer eviction while HTTP warm is in flight rejects the snapshot instead of losing an unseen update',async()=>{
  const f=fixture(),request=f.request('sell'),held=delayNextWarmSnapshot(f);
  const warming=f.adapter.warmQuoteCache(request.wallet,request.mint);await held.reached;
  for(let index=0;index<513;index++){
    const bytes=Buffer.alloc(32);bytes.writeUInt32LE(index);f.adapter.ingestAccount(new PublicKey(bytes).toBase58(),null,101,Date.now());
  }
  held.release();await assert.rejects(warming,/NATIVE_STREAM_BUFFER_OVERFLOW/);
  assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_STREAM_CACHE_COLD/);
});

test('incremental stream quotes reuse unchanged parameters without full snapshot decoding or RPC',async()=>{
  for(const venue of ['pump','pumpswap'] as const){
    const f=fixture({venue}),request=f.request('sell');await f.adapter.warmQuoteCache(request.wallet,request.mint);
    const adapter=f.adapter as any,entry=adapter.quoteCache.get(`${request.wallet}:${request.mint}`),initialMint=entry.state.mint;
    const initialGlobal=venue==='pump'?entry.state.pump.global:entry.state.amm.globalConfig;
    const initialFee=venue==='pump'?entry.state.pump.fee:entry.state.amm.feeConfig;
    const decode=adapter.decodeSnapshot,calls=f.calls.length;
    adapter.decodeSnapshot=()=>{throw Error('full snapshot decoding must not run for an indexed frame');};
    if(venue==='pump'){
      f.curve.virtualQuoteReserves=new BN('31000000000');
      f.map.set(curveKey.toBase58(),account(encoded(pumpProgram,'bondingCurve',f.curve),PUMP_PROGRAM_ID));
      f.adapter.ingestAccount(curveKey.toBase58(),f.map.get(curveKey.toBase58())!,101,Date.now());
    }else{
      f.map.set(f.poolBase.toBase58(),tokenAccount(poolKey,99_000_000_000_000n));
      f.map.set(f.poolQuote.toBase58(),tokenAccount(poolKey,51_000_000_000n,TOKEN_PROGRAM_ID,NATIVE_MINT));
      for(const address of [poolKey,f.poolBase,f.poolQuote])f.adapter.ingestAccount(address.toBase58(),f.map.get(address.toBase58())!,101,Date.now());
    }
    const quoted=f.adapter.quoteSellCached(request);
    assert.equal(f.calls.length,calls);assert.strictEqual(entry.state.mint,initialMint);
    assert.strictEqual(venue==='pump'?entry.state.pump.global:entry.state.amm.globalConfig,initialGlobal);
    assert.strictEqual(venue==='pump'?entry.state.pump.fee:entry.state.amm.feeConfig,initialFee);
    adapter.decodeSnapshot=decode;
    assert.equal(quoted.expectedOutputAmount,(await f.adapter.quoteSell(request)).expectedOutputAmount);
  }
});

test('AMM incremental globals, fee tiers, mint supply and signed virtual reserve changes match fresh SDK valuation',async()=>{
  const f=fixture({venue:'pumpswap'}),request=f.request('sell');await f.adapter.warmQuoteCache(request.wallet,request.mint);
  const fees={lpFeeBps:new BN(21),protocolFeeBps:new BN(110),creatorFeeBps:new BN(60)};
  const fee={...defaults(ammProgram,'feeConfig'),flatFees:fees,feeTiers:[{marketCapLamportsThreshold:new BN(0),fees}]};
  f.ammGlobal.protocolFeeBasisPoints=new BN(110);
  const updatedMint=mintAccount();const decodedMint=MintLayout.decode(updatedMint.data);
  MintLayout.encode({...decodedMint,supply:900_000_000_000_000n},updatedMint.data);
  for(const [address,info] of [[GLOBAL_CONFIG_PDA,account(encoded(ammProgram,'globalConfig',f.ammGlobal),PUMP_AMM_PROGRAM_ID)],
    [PUMP_AMM_FEE_CONFIG_PDA,account(encoded(ammProgram,'feeConfig',fee,4097),PUMP_FEE_PROGRAM_ID)],
    [mint,updatedMint]] as const){
    f.map.set(address.toBase58(),info);f.adapter.ingestAccount(address.toBase58(),info,101,Date.now());
    assert.equal(f.adapter.quoteSellCached(request).expectedOutputAmount,(await f.adapter.quoteSell(request)).expectedOutputAmount);
  }
  f.pool.virtualQuoteReserves=new BN('-1000000000');
  f.pool.protocolFees=new BN(1000);f.pool.creatorFees=new BN(500);
  f.map.set(poolKey.toBase58(),account(encoded(ammProgram,'pool',f.pool),PUMP_AMM_PROGRAM_ID));
  for(const address of [poolKey,f.poolBase,f.poolQuote])f.adapter.ingestAccount(address.toBase58(),f.map.get(address.toBase58())!,102,Date.now());
  assert.equal(f.adapter.quoteSellCached(request).expectedOutputAmount,(await f.adapter.quoteSell(request)).expectedOutputAmount);
});

test('incremental AMM updates still reject forged identities, frozen vaults and inconsistent fee reserves',async()=>{
  for(const kind of ['pool_authority','base_mint','base_authority','quote_mint','frozen','fee_reserves','virtual_reserves','empty_base'] as const){
    const f=fixture({venue:'pumpswap'}),request=f.request('sell');await f.adapter.warmQuoteCache(request.wallet,request.mint);
    if(kind==='pool_authority')f.pool.creator=creator;
    if(kind==='fee_reserves')f.pool.protocolFees=new BN('50000000001');
    if(kind==='virtual_reserves')f.pool.virtualQuoteReserves=new BN('-50000000001');
    const pool=account(encoded(ammProgram,'pool',f.pool),PUMP_AMM_PROGRAM_ID);
    const base=tokenAccount(kind==='base_authority'?creator:poolKey,kind==='empty_base'?0n:100_000_000_000_000n,
      TOKEN_PROGRAM_ID,kind==='base_mint'?creator:mint,kind==='frozen'?2:1);
    const quote=tokenAccount(poolKey,50_000_000_000n,TOKEN_PROGRAM_ID,kind==='quote_mint'?mint:NATIVE_MINT);
    f.adapter.ingestAccount(poolKey.toBase58(),pool,101,Date.now());
    f.adapter.ingestAccount(f.poolBase.toBase58(),base,101,Date.now());
    f.adapter.ingestAccount(f.poolQuote.toBase58(),quote,101,Date.now());
    assert.equal(f.adapter.cacheStatus(request.wallet,request.mint).ready,false,kind);
    assert.throws(()=>f.adapter.quoteSellCached(request),/NATIVE_/,kind);
  }
});

test('dropping a closed mint releases its cache and indexes while retaining another mint and shared globals',async()=>{
  const f=fixture(),other=fixture({mintKey:new PublicKey(Buffer.alloc(32,92))});
  for(const [address,info] of other.map)f.map.set(address,info);
  const a=f.request('sell'),b=other.request('sell');
  await f.adapter.warmQuoteCache(a.wallet,a.mint);await f.adapter.warmQuoteCache(b.wallet,b.mint);
  const at=Date.now();
  f.adapter.ingestAccount(GLOBAL_PDA.toBase58(),f.map.get(GLOBAL_PDA.toBase58())!,101,at);
  f.adapter.ingestAccount(curveKey.toBase58(),f.map.get(curveKey.toBase58())!,101,at);
  f.adapter.dropQuoteCache(a.wallet,a.mint);
  const adapter=f.adapter as any;
  assert.equal(adapter.quoteCache.size,1);assert.equal(adapter.quoteEpochs.size,1);
  assert.equal(adapter.quoteCacheAccounts.has(curveKey.toBase58()),false);
  assert.equal(adapter.latestStreamAccounts.has(curveKey.toBase58()),false);
  assert.equal(adapter.latestStreamAccounts.has(GLOBAL_PDA.toBase58()),true);
  assert.throws(()=>f.adapter.quoteSellCached(a),/NATIVE_STREAM_CACHE_COLD/);
  assert.equal(f.adapter.cacheStatus(b.wallet,b.mint).ready,true);
  f.global.creatorFeeBasisPoints=new BN(250);
  const update=account(encoded(pumpProgram,'global',f.global),PUMP_PROGRAM_ID);f.map.set(GLOBAL_PDA.toBase58(),update);
  assert.deepEqual(f.adapter.ingestAccount(GLOBAL_PDA.toBase58(),update,102,Date.now()),[b.mint]);
  assert.equal(f.adapter.quoteSellCached(b).expectedOutputAmount,(await f.adapter.quoteSell(b)).expectedOutputAmount);
  assert.deepEqual(f.adapter.ingestAccount(curveKey.toBase58(),null,103,Date.now()),[],'released token frames cannot affect the surviving token');
  f.adapter.dropQuoteCache(b.wallet,b.mint);f.adapter.dropQuoteCache(b.wallet,b.mint);
  assert.equal(adapter.quoteCache.size,0);assert.equal(adapter.quoteCacheAccounts.size,0);assert.equal(adapter.quoteEpochs.size,0);
});

test('dropping a mint cancels its late warm without invalidating another mint or a later explicit warm',async()=>{
  const f=fixture(),other=fixture({mintKey:new PublicKey(Buffer.alloc(32,93))});
  for(const [address,info] of other.map)f.map.set(address,info);
  const a=f.request('sell'),b=other.request('sell');await f.adapter.warmQuoteCache(b.wallet,b.mint);
  const held=delayNextWarmSnapshot(f),warming=f.adapter.warmQuoteCache(a.wallet,a.mint);await held.reached;
  f.adapter.dropQuoteCache(a.wallet,a.mint);
  assert.equal(f.adapter.cacheStatus(b.wallet,b.mint).ready,true);
  const replacement=await f.adapter.warmQuoteCache(a.wallet,a.mint);
  held.release();await assert.rejects(warming,/NATIVE_STREAM_CACHE_RESET/);
  assert.equal(f.adapter.cacheStatus(a.wallet,a.mint).ready,true);
  assert.equal(f.adapter.quoteSellCached(a).slot,replacement.slot);
  assert.equal(f.adapter.cacheStatus(b.wallet,b.mint).ready,true);
});

test('a late refresh cannot resurrect a cache removed after confirmed liquidation',async()=>{
  const f=fixture(),request=f.request('sell');await f.adapter.warmQuoteCache(request.wallet,request.mint);
  const held=delayNextWarmSnapshot(f),refresh=f.adapter.warmQuoteCache(request.wallet,request.mint);await held.reached;
  f.adapter.dropQuoteCache(request.wallet,request.mint);
  held.release();await assert.rejects(refresh,/NATIVE_STREAM_CACHE_RESET/);
  assert.equal(f.adapter.cacheStatus(request.wallet,request.mint).warm,false);
  assert.equal((f.adapter as any).quoteCache.size,0);
  assert.equal((f.adapter as any).quoteCacheAccounts.size,0);
  assert.equal((f.adapter as any).quoteEpochs.size,0);
});
