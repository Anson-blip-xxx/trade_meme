import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import {ComputeBudgetProgram,Connection,Keypair,PublicKey,SystemProgram,type AccountInfo} from '@solana/web3.js';
import {
  AccountLayout,ExtensionType,MintLayout,NATIVE_MINT,TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,getMintLen,getTypeLen,
} from '@solana/spl-token';
import {PUMP_PROGRAM_ID,bondingCurvePda,getPumpProgram} from '@pump-fun/pump-sdk';
import {
  GLOBAL_CONFIG_PDA,PUMP_AMM_PROGRAM_ID,canonicalPumpPoolPda,getPumpAmmProgram,pumpPoolAuthorityPda,
} from '@pump-fun/pump-swap-sdk';
import {PumpNativeAdapter} from '../src/native-solana/pump.js';
import {JUPITER_SWAP_PROGRAM} from '../src/native-solana/jupiter.js';
import type {JupiterMainBucketTier} from '../src/native-solana/jupiter.js';

const wallet=Keypair.fromSeed(Buffer.alloc(32,81)).publicKey;
const target=Keypair.fromSeed(Buffer.alloc(32,82)).publicKey;
const otherQuote=Keypair.fromSeed(Buffer.alloc(32,83)).publicKey;
const creator=Keypair.fromSeed(Buffer.alloc(32,84)).publicKey;
const routePoolA=Keypair.fromSeed(Buffer.alloc(32,85)).publicKey;
const routePoolB=Keypair.fromSeed(Buffer.alloc(32,86)).publicKey;
const PUMP_MINT=new PublicKey('pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn');
const PUMP_WSOL_POOL=new PublicKey('539m4mVWt6iduB6W8rDGPMarzNCMesuqY5eUTiiYHAgR');
const JUPITER_EVENT_AUTHORITY='D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
const disconnected=new Connection('https://example.invalid');
const pumpProgram=getPumpProgram(disconnected),ammProgram=getPumpAmmProgram(disconnected);
const account=(data:Buffer,owner:PublicKey):AccountInfo<Buffer>=>({data,owner,lamports:2_039_280,executable:false,rentEpoch:0});

function defaults(program:any,name:string):any {
  const fields=program.idl.types.find((entry:any)=>entry.name===name).type.fields;
  const value=(type:any):any=>{
    if(type==='pubkey')return PublicKey.default;if(type==='bool')return false;
    if(['u8','u16','u32','i8','i16','i32'].includes(type))return 0;
    if(typeof type==='string'&&/^[ui]\d+$/.test(type))return new BN(0);
    if(type.array)return Array.from({length:type.array[1]},()=>value(type.array[0]));
    if(type.vec)return [];if(type.defined)return defaults(program,type.defined.name);
    throw Error('unsupported fixture field');
  };
  return Object.fromEntries(fields.map((field:any)=>[field.name,value(field.type)]));
}
function encoded(program:any,name:string,data:any):Buffer {
  const layout=program.coder.accounts.accountLayouts.get(name),body=Buffer.alloc(16_384),length=layout.layout.encode(data,body);
  return Buffer.concat([Buffer.from(layout.discriminator),body.subarray(0,length)]);
}
function mintAccount(program=TOKEN_PROGRAM_ID,extension?:ExtensionType,supply=1_000_000_000_000n):AccountInfo<Buffer> {
  const data=Buffer.alloc(extension===undefined?82:getMintLen([extension]));
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply,decimals:6,isInitialized:true,
    freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  if(extension!==undefined){data[165]=1;data.writeUInt16LE(extension,166);data.writeUInt16LE(getTypeLen(extension),168);}
  return account(data,program);
}
function tokenAccount(mint:PublicKey,authority:PublicKey,amount:bigint,program=TOKEN_PROGRAM_ID):AccountInfo<Buffer> {
  const data=Buffer.alloc(165);AccountLayout.encode({mint,owner:authority,amount,delegateOption:0,delegate:PublicKey.default,
    state:1,isNativeOption:mint.equals(NATIVE_MINT)?1:0,isNative:mint.equals(NATIVE_MINT)?2_039_280n:0n,
    delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  return account(data,program);
}
function curve(quoteMint:PublicKey,complete:boolean) {
  return {...defaults(pumpProgram,'bondingCurve'),virtualTokenReserves:new BN('1073000000000000'),
    virtualQuoteReserves:new BN('30000000000'),realTokenReserves:new BN('793100000000000'),
    realQuoteReserves:new BN('10000000000'),tokenTotalSupply:new BN('1000000000000000'),creator,complete,quoteMint};
}
function curveAccount(quoteMint:PublicKey,complete:boolean){return account(encoded(pumpProgram,'bondingCurve',curve(quoteMint,complete)),PUMP_PROGRAM_ID);}

const rawAccount=(pubkey:string,isSigner=false,isWritable=false)=>({pubkey,isSigner,isWritable});
const b64=(data:Buffer|number[])=>Buffer.from(data).toString('base64');
function u64(value:bigint){const data=Buffer.alloc(8);data.writeBigUInt64LE(value);return data;}
function jupiterResponse(url:URL,quoteMint:PublicKey) {
  const inputMint=url.searchParams.get('inputMint')!,outputMint=url.searchParams.get('outputMint')!,user=url.searchParams.get('taker')!;
  const amount=url.searchParams.get('amount')!,slippage=Number(url.searchParams.get('slippageBps')),
    output=(BigInt(amount)/5n).toString();
  const userKey=new PublicKey(user),inputProgram=inputMint===NATIVE_MINT.toBase58()?TOKEN_PROGRAM_ID:TOKEN_PROGRAM_ID;
  const outputProgram=outputMint===NATIVE_MINT.toBase58()?TOKEN_PROGRAM_ID:TOKEN_PROGRAM_ID;
  const inputAta=getAssociatedTokenAddressSync(new PublicKey(inputMint),userKey,false,inputProgram);
  const outputAta=getAssociatedTokenAddressSync(new PublicKey(outputMint),userKey,false,outputProgram);
  const wsolAta=getAssociatedTokenAddressSync(NATIVE_MINT,userKey);
  const ata=(mint:PublicKey,program:PublicKey)=>({programId:'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    accounts:[rawAccount(user,true,true),rawAccount(getAssociatedTokenAddressSync(mint,userKey,false,program).toBase58(),false,true),rawAccount(user),
      rawAccount(mint.toBase58()),rawAccount(SystemProgram.programId.toBase58()),rawAccount(program.toBase58())],data:b64([1])});
  const setup:any[]=[ata(NATIVE_MINT,TOKEN_PROGRAM_ID),ata(target,TOKEN_PROGRAM_ID)];
  if(inputMint===NATIVE_MINT.toBase58()){
    setup.splice(1,0,{programId:SystemProgram.programId.toBase58(),accounts:[rawAccount(user,true,true),rawAccount(wsolAta.toBase58(),false,true)],
      data:b64(Buffer.concat([Buffer.from([2,0,0,0]),u64(BigInt(amount))]))},
    {programId:TOKEN_PROGRAM_ID.toBase58(),accounts:[rawAccount(wsolAta.toBase58(),false,true)],data:b64([17])});
  }
  const swapData=Buffer.alloc(44);Buffer.from([187,100,250,204,49,196,175,20]).copy(swapData);
  swapData.writeBigUInt64LE(BigInt(amount),8);swapData.writeBigUInt64LE(BigInt(output),16);swapData.writeUInt16LE(slippage,24);
  swapData.writeUInt32LE(2,30);
  Buffer.from([72,0x10,0x27,0,1,73,0x10,0x27,1,2]).copy(swapData,34);
  const intermediate='1500000',forward=inputMint===NATIVE_MINT.toBase58();
  const routePlan=[
    {percent:100,bps:10000,swapInfo:{ammKey:routePoolA.toBase58(),label:'Fixture first',inputMint,
      outputMint:quoteMint.toBase58(),inAmount:amount,outAmount:intermediate}},
    {percent:100,bps:10000,swapInfo:{ammKey:routePoolB.toBase58(),label:'Fixture second',inputMint:quoteMint.toBase58(),
      outputMint,outAmount:output,inAmount:intermediate}},
  ];
  if(!forward)routePlan.reverse();
  return {inputMint,outputMint,inAmount:amount,outAmount:output,otherAmountThreshold:String(BigInt(output)*BigInt(10_000-slippage)/10_000n),
    swapMode:'ExactIn',slippageBps:slippage,transactionVersion:0,routePlan,
    computeBudgetInstructions:[{programId:ComputeBudgetProgram.programId.toBase58(),accounts:[],
      data:b64(ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000n}).data)}],setupInstructions:setup,
    swapInstruction:{programId:JUPITER_SWAP_PROGRAM,accounts:[rawAccount(user,true),rawAccount(inputAta.toBase58(),false,true),
      rawAccount(outputAta.toBase58(),false,true),rawAccount(inputMint),rawAccount(outputMint),rawAccount(inputProgram.toBase58()),
      rawAccount(outputProgram.toBase58()),rawAccount(JUPITER_SWAP_PROGRAM),rawAccount(JUPITER_EVENT_AUTHORITY),
      rawAccount(JUPITER_SWAP_PROGRAM),rawAccount(routePoolA.toBase58(),false,true)],data:b64(swapData)},
    cleanupInstruction:{programId:TOKEN_PROGRAM_ID.toBase58(),accounts:[rawAccount(wsolAta.toBase58(),false,true),rawAccount(user,false,true),
      rawAccount(user,true)],data:b64([9])},otherInstructions:[],tipInstruction:null,addressesByLookupTableAddress:{},
    blockhashWithMetadata:{blockhash:Array.from({length:32},(_,index)=>index+1),lastValidBlockHeight:12345}};
}

interface FixtureOptions {
  quoteMint?:PublicKey;complete?:boolean;localPumpBridge?:boolean;unroutable?:boolean;
  onMultiple?:(keys:PublicKey[])=>void;fetcher?:typeof fetch;jupiterApiKey?:string|null;
  jupiterMainBucketTier?:JupiterMainBucketTier;jupiterMainBucketRps?:number;
}
function fixture(options:FixtureOptions={}) {
  const quoteMint=options.quoteMint??otherQuote,complete=options.complete??false,curveKey=bondingCurvePda(target);
  const map=new Map<string,AccountInfo<Buffer>>([[target.toBase58(),mintAccount()],[curveKey.toBase58(),curveAccount(quoteMint,complete)]]);
  // External quote extensions must not be mistaken for target-token economics.
  map.set(quoteMint.toBase58(),quoteMint.equals(PUMP_MINT)?mintAccount(TOKEN_2022_PROGRAM_ID,ExtensionType.TransferHook):
    mintAccount(TOKEN_2022_PROGRAM_ID,ExtensionType.TransferFeeConfig));
  if(options.localPumpBridge){
    map.set(NATIVE_MINT.toBase58(),mintAccount(TOKEN_PROGRAM_ID,undefined,0n));
    const global={...defaults(ammProgram,'globalConfig')};map.set(GLOBAL_CONFIG_PDA.toBase58(),account(encoded(ammProgram,'globalConfig',global),PUMP_AMM_PROGRAM_ID));
    const addPool=(poolKey:PublicKey,baseMint:PublicKey,baseProgram:PublicKey,quote:PublicKey,quoteProgram:PublicKey,canonical:boolean)=>{
      const baseVault=getAssociatedTokenAddressSync(baseMint,poolKey,true,baseProgram),quoteVault=getAssociatedTokenAddressSync(quote,poolKey,true,quoteProgram);
      const pool={...defaults(ammProgram,'pool'),index:0,creator:canonical?pumpPoolAuthorityPda(baseMint):creator,baseMint,quoteMint:quote,
        poolBaseTokenAccount:baseVault,poolQuoteTokenAccount:quoteVault,coinCreator:creator,lpMint:creator};
      map.set(poolKey.toBase58(),account(encoded(ammProgram,'pool',pool),PUMP_AMM_PROGRAM_ID));
      map.set(baseVault.toBase58(),tokenAccount(baseMint,poolKey,9_000_000_000n,baseProgram));
      map.set(quoteVault.toBase58(),tokenAccount(quote,poolKey,8_000_000_000n,quoteProgram));
    };
    addPool(canonicalPumpPoolPda(target,PUMP_MINT),target,TOKEN_PROGRAM_ID,PUMP_MINT,TOKEN_2022_PROGRAM_ID,true);
    addPool(PUMP_WSOL_POOL,PUMP_MINT,TOKEN_2022_PROGRAM_ID,NATIVE_MINT,TOKEN_PROGRAM_ID,false);
  }
  const rpcCalls:PublicKey[][]=[],fetchUrls:URL[]=[];
  const connection={
    async getMultipleAccountsInfoAndContext(keys:PublicKey[]){rpcCalls.push(keys);options.onMultiple?.(keys);
      return {context:{slot:100},value:keys.map(key=>map.get(key.toBase58())??null)};},
    async getTokenAccountsByOwner(){return {context:{slot:101},value:[]};},
  } as unknown as Connection;
  const fetcher:typeof fetch=async(input,init)=>{const url=new URL(String(input));fetchUrls.push(url);
    if(options.fetcher)return options.fetcher(input,init);
    if(options.unroutable)return new Response('{}',{status:503,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify(jupiterResponse(url,quoteMint)),{status:200,headers:{'content-type':'application/json'}});
  };
  const adapter=new PumpNativeAdapter({connection,fetcher,
    jupiterApiKey:options.jupiterApiKey===undefined?'fixture-jupiter-key':options.jupiterApiKey,
    jupiterMainBucketTier:options.jupiterMainBucketTier??(options.jupiterApiKey===null?'keyless':'pro'),
    jupiterMainBucketRps:options.jupiterMainBucketRps??(options.jupiterApiKey===null?0.5:150)});
  return {adapter,map,curveKey,quoteMint,rpcCalls,fetchUrls,request:(side:'buy'|'sell')=>({wallet:wallet.toBase58(),mint:target.toBase58(),side,amount:side==='buy'?'10000000':'100000000',slippageBps:100})};
}

test('routeCapability only classifies active xStock-like and completed token quotes without claiming readiness or calling Jupiter',async()=>{
  for(const complete of [false,true]){
    const f=fixture({complete}),found=await f.adapter.routeCapability(target.toBase58());
    assert.deepEqual(found,{classification:'route_candidate',route:'jupiter_bridge',quoteMint:otherQuote.toBase58(),
      curveState:complete?'complete':'active',readiness:'requires_preflight'});
    assert.equal(f.fetchUrls.length,0);assert.equal(f.rpcCalls.length,1);
    assert.equal('executable' in found,false);assert.equal('monitorable' in found,false);
  }
});

test('an unreserved external-quote buy stops before Jupiter build and protection-probe HTTP',async()=>{
  const f=fixture();
  await assert.rejects(f.adapter.build(f.request('buy'),{jupiterEntryAuthorized:false}),
    /NATIVE_JUPITER_PROTECTION_CAPACITY_REACHED/);
  assert.equal(f.fetchUrls.length,0,'capacity rejection must not consume the Jupiter rate-limit bucket');
});

test('active xStock-like and completed other-token curves use end-to-end Jupiter builds and fresh sell quotes',async()=>{
  for(const complete of [false,true]){
    const f=fixture({complete}),buy=await f.adapter.build(f.request('buy'));
    assert.equal(buy.venue,'jupiter');assert.equal(buy.protectionMode,'external_price_stream');assert.equal(buy.side,'buy');
    assert.equal(buy.inputAmount,'10000000');assert.ok(buy.instructions.some(ix=>ix.programId.toBase58()===JUPITER_SWAP_PROGRAM));
    const sell=await f.adapter.quoteSell(f.request('sell'));
    assert.equal(sell.venue,'jupiter');assert.equal(sell.protectionMode,'external_price_stream');assert.equal(sell.side,'sell');
    assert.equal(sell.inputAmount,'100000000');assert.equal('instructions' in sell,false);assert.equal('signal' in sell,false);assert.equal(f.fetchUrls.length,3);
    assert.equal(f.fetchUrls[0].searchParams.get('inputMint'),NATIVE_MINT.toBase58());
    assert.ok(f.fetchUrls.slice(1).every(url=>url.searchParams.get('outputMint')===NATIVE_MINT.toBase58()));
  }
});

test('an external-position quote deadline aborts the Jupiter HTTP request through every adapter layer',async()=>{
  let active=0,aborted=0,completed=0;
  const f=fixture({fetcher:async(_input,init)=>{
    const signal=init?.signal;if(!(signal instanceof AbortSignal))throw Error('missing signal');active++;
    return await new Promise<Response>((resolve,reject)=>{
      const timer=setTimeout(()=>{active--;completed++;resolve(new Response('{}',{status:503,headers:{'content-type':'application/json'}}));},1_000);
      const stop=()=>{clearTimeout(timer);active--;aborted++;reject(signal.reason??new DOMException('aborted','AbortError'));};
      if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});
    });
  }}),controller=new AbortController();
  const before=f.rpcCalls.length;
  const pending=f.adapter.quoteJupiterSell({...f.request('sell'),signal:controller.signal},6,'external_price_stream');
  for(let attempt=0;attempt<20&&active===0;attempt++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(active,1);controller.abort(Error('700ms position quote timeout'));
  await assert.rejects(pending,/JUPITER_BUILD_UNAVAILABLE/);
  assert.equal(f.rpcCalls.length,before,'confirmed Jupiter holdings skip Pump route rediscovery');
  assert.deepEqual({active,aborted,completed},{active:0,aborted:1,completed:0});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual({active,aborted,completed},{active:0,aborted:1,completed:0});
});

test('confirmed Jupiter holdings quote target to SOL directly without Pump RPC discovery',async()=>{
  const f=fixture(),before=f.rpcCalls.length;
  const quote=await f.adapter.quoteJupiterSell(f.request('sell'),6,'external_price_stream');
  assert.equal(quote.venue,'jupiter');assert.equal(quote.side,'sell');assert.equal(quote.inputAmount,'100000000');
  assert.equal(quote.protectionMode,'external_price_stream');assert.equal(f.rpcCalls.length,before);assert.equal(f.fetchUrls.length,1);
  assert.equal(f.fetchUrls[0].searchParams.get('inputMint'),target.toBase58());
  assert.equal(f.fetchUrls[0].searchParams.get('outputMint'),NATIVE_MINT.toBase58());
});

test('keyless Jupiter has zero new-position capacity while existing exits remain available',async()=>{
  const f=fixture({jupiterApiKey:null});
  assert.deepEqual(f.adapter.jupiterStatus(),{apiKeyConfigured:false,nonSolEntryRequiresApiKey:true,entryCapacity:0,
    mainBucket:{tier:'keyless',rps:0.5,rpm:30,blockedUntil:undefined},protectionProbeWindowMs:5000,
    protectionQuoteTimeoutMs:700,protectionQuoteHttpBudgetMs:300,protectionQuotesPerDecision:1});
  await assert.rejects(f.adapter.build(f.request('buy')),/NATIVE_JUPITER_PROTECTION_CAPACITY_REACHED/);
  assert.equal(f.fetchUrls.length,0);
  const quote=await f.adapter.quoteJupiterSell(f.request('sell'),6,'external_price_stream');
  assert.equal(quote.venue,'jupiter');assert.equal(f.fetchUrls.length,1,'an existing holding retains a throttled exact keyless exit quote');
});

test('API-key tiers expose an auditable external-position capacity and cannot exceed their official bucket',()=>{
  const free=fixture({jupiterMainBucketTier:'free',jupiterMainBucketRps:1}).adapter.jupiterStatus();
  assert.equal(free.entryCapacity,0,'a prior permit can make Free wait one second, beyond the 700ms quote deadline');
  assert.deepEqual(free.mainBucket,{tier:'free',rps:1,rpm:60,blockedUntil:undefined});
  const developer=fixture({jupiterMainBucketTier:'developer',jupiterMainBucketRps:10}).adapter.jupiterStatus();
  assert.equal(developer.entryCapacity,3);assert.equal(developer.mainBucket.rpm,600);
  const reduced=fixture({jupiterMainBucketTier:'developer',jupiterMainBucketRps:2}).adapter.jupiterStatus();
  assert.equal(reduced.entryCapacity,0,'500ms pacing leaves less than the reserved 300ms HTTP budget');
  const launch=fixture({jupiterMainBucketTier:'launch',jupiterMainBucketRps:50}).adapter.jupiterStatus();
  assert.equal(launch.entryCapacity,19);
  const pro=fixture({jupiterMainBucketTier:'pro',jupiterMainBucketRps:150}).adapter.jupiterStatus();
  assert.equal(pro.entryCapacity,40);
  assert.throws(()=>fixture({jupiterMainBucketTier:'free',jupiterMainBucketRps:10}),/JUPITER_BUILD_OPTIONS_INVALID/);
  assert.throws(()=>fixture({jupiterApiKey:null,jupiterMainBucketTier:'developer',jupiterMainBucketRps:10}),/JUPITER_BUILD_OPTIONS_INVALID/);
});

test('protection capacity proof is bound to each candidate fill size',async()=>{
  const f=fixture();
  const first=await f.adapter.build(f.request('buy'));
  assert.equal(first.expectedOutputAmount,'2000000');assert.equal(f.fetchUrls.length,2);
  const second=await f.adapter.build({...f.request('buy'),amount:'20000000'});
  assert.equal(second.expectedOutputAmount,'4000000');assert.equal(f.fetchUrls.length,4,
    'a different expected holding must receive a new full exit probe');
  assert.deepEqual(f.fetchUrls.slice(3).map(url=>url.searchParams.get('amount')),['4000000']);
});

test('an entry protection-probe 429 cannot poison a confirmed holding exit quote',async()=>{
  let calls=0;
  const f=fixture({fetcher:async input=>{
    calls++;const url=new URL(String(input));
    if(calls===2)return new Response('{}',{status:429,headers:{'retry-after':'60'}});
    return new Response(JSON.stringify(jupiterResponse(url,otherQuote)),{status:200,headers:{'content-type':'application/json'}});
  }});
  await assert.rejects(f.adapter.build(f.request('buy')),/JUPITER_BUILD_RATE_LIMITED/);
  assert.equal(calls,2,'the buy route succeeds before its entry-class full-exit probe is rate limited');
  const started=Date.now(),quote=await f.adapter.quoteJupiterSell(f.request('sell'),6,'external_price_stream');
  assert.equal(quote.venue,'jupiter');assert.equal(calls,3);
  assert.ok(Date.now()-started<100,'a confirmed holding exit must bypass entry-only Retry-After');
});

test('completed PUMP quote preflights canonical pools but persists only external-price protection identity',async()=>{
  const f=fixture({quoteMint:PUMP_MINT,complete:true,localPumpBridge:true});
  assert.deepEqual(await f.adapter.routeCapability(target.toBase58()),{classification:'route_candidate',route:'pump_bridge',
    quoteMint:PUMP_MINT.toBase58(),curveState:'complete',readiness:'requires_preflight'});
  const buy=await f.adapter.build(f.request('buy')),sell=await f.adapter.quoteSell(f.request('sell'));
  assert.equal(buy.venue,'jupiter');assert.equal(buy.protectionMode,'external_price_stream');
  assert.equal(sell.venue,'jupiter');assert.equal(sell.protectionMode,'external_price_stream');
  assert.ok(f.rpcCalls.flat().some(key=>key.equals(canonicalPumpPoolPda(target,PUMP_MINT))));
  assert.ok(f.rpcCalls.flat().some(key=>key.equals(PUMP_WSOL_POOL)),'local bridge remains a build-time chain preflight');
  assert.deepEqual(buy.subscriptionAccounts,[wallet,target].map(key=>key.toBase58()));
  assert.ok(!buy.subscriptionAccounts.includes(routePoolA.toBase58()));
  assert.ok(!buy.subscriptionAccounts.includes(PUMP_WSOL_POOL.toBase58()),'local bridge cannot become the durable wake feed');
});

test('candidate classification does not authorize an unavailable Jupiter route',async()=>{
  const f=fixture({unroutable:true});
  assert.equal((await f.adapter.routeCapability(target.toBase58())).readiness,'requires_preflight');
  await assert.rejects(f.adapter.build(f.request('buy')),/JUPITER_BUILD_HTTP_ERROR/);
  await assert.rejects(f.adapter.quoteSell(f.request('sell')),/JUPITER_BUILD_HTTP_ERROR/);
});

test('curve migration between classification and route load fails closed before Jupiter',async()=>{
  let migrated=false;const f=fixture({onMultiple:keys=>{
    if(!migrated&&keys.length===2&&keys.some(key=>key.equals(target))&&keys.some(key=>key.equals(bondingCurvePda(target)))){
      migrated=true;f.map.set(f.curveKey.toBase58(),curveAccount(PublicKey.default,false));
    }
  }});
  await assert.rejects(f.adapter.build(f.request('buy')),/NATIVE_ROUTE_CHANGED/);
  assert.equal(migrated,true);assert.equal(f.fetchUrls.length,0);
});
