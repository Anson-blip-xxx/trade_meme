import test from 'node:test';
import assert from 'node:assert/strict';
import {ComputeBudgetProgram,Keypair,PublicKey,SystemProgram} from '@solana/web3.js';
import {getAssociatedTokenAddressSync} from '@solana/spl-token';
import bs58 from 'bs58';
import {
  JUPITER_BUILD_ENDPOINT,
  JUPITER_SWAP_PROGRAM,
  JupiterBuildClient,
  type JupiterBuildRequest,
} from '../src/native-solana/jupiter.js';
import {readConfig} from '../src/config.js';

const COMPUTE_BUDGET_PROGRAM=ComputeBudgetProgram.programId.toBase58();
const ASSOCIATED_TOKEN_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL='So11111111111111111111111111111111111111112';
const ROUTE_V2=[187,100,250,204,49,196,175,20];
const SHARED_ACCOUNTS_ROUTE_V2=[209,152,83,147,124,254,216,233];
const EVENT_AUTHORITY='D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
const user=Keypair.fromSeed(Buffer.alloc(32,1)).publicKey.toBase58();
const inputMint=WSOL;
const outputMint=Keypair.fromSeed(Buffer.alloc(32,3)).publicKey.toBase58();
const pool=Keypair.fromSeed(Buffer.alloc(32,4)).publicKey.toBase58();
const wsolAta=getAssociatedTokenAddressSync(new PublicKey(WSOL),new PublicKey(user)).toBase58();
const userToken=getAssociatedTokenAddressSync(new PublicKey(outputMint),new PublicKey(user)).toBase58();
const lookupTable=Keypair.fromSeed(Buffer.alloc(32,6)).publicKey.toBase58();
const other=Keypair.fromSeed(Buffer.alloc(32,7)).publicKey.toBase58();
const request:JupiterBuildRequest={user,inputMint,outputMint,amount:'1000000',slippageBps:100};

test('Jupiter main-bucket config defaults to keyless/Free and rejects unauthenticated or overstated tiers',()=>{
  const bucket=(env:NodeJS.ProcessEnv)=>{const {jupiterMainBucketTier,jupiterMainBucketRps}=readConfig(env).nativeSolana!;
    return {jupiterMainBucketTier,jupiterMainBucketRps};};
  assert.deepEqual(bucket({}),{jupiterMainBucketTier:'keyless',jupiterMainBucketRps:0.5});
  assert.deepEqual(bucket({JUPITER_API_KEY:'key'}),{jupiterMainBucketTier:'free',jupiterMainBucketRps:1});
  assert.equal(readConfig({JUPITER_API_KEY:'key',JUPITER_MAIN_BUCKET_TIER:'developer',JUPITER_MAIN_BUCKET_RPS:'5'}).nativeSolana!.jupiterMainBucketRps,5);
  assert.throws(()=>readConfig({JUPITER_MAIN_BUCKET_TIER:'developer'}),/JUPITER_MAIN_BUCKET_CONFIG_INVALID/);
  assert.throws(()=>readConfig({JUPITER_API_KEY:'key',JUPITER_MAIN_BUCKET_TIER:'free',JUPITER_MAIN_BUCKET_RPS:'2'}),/JUPITER_MAIN_BUCKET_CONFIG_INVALID/);
});
const sharedAuthorityId=3;
const sharedAuthority=PublicKey.findProgramAddressSync(
  [Buffer.from('authority'),Buffer.from([sharedAuthorityId])],new PublicKey(JUPITER_SWAP_PROGRAM),
)[0];
const programSource=getAssociatedTokenAddressSync(new PublicKey(inputMint),sharedAuthority,true).toBase58();
const programDestination=getAssociatedTokenAddressSync(new PublicKey(outputMint),sharedAuthority,true).toBase58();

const account=(pubkey:string,isSigner=false,isWritable=false)=>({pubkey,isSigner,isWritable});
const encoded=(bytes:number[])=>Buffer.from(bytes).toString('base64');
const priceData=(microLamports=1_000n)=>Buffer.from(ComputeBudgetProgram.setComputeUnitPrice({microLamports}).data).toString('base64');
const u64=(value:bigint)=>[...new Uint8Array(new BigUint64Array([value]).buffer)];
const u16=(value:number)=>[value&255,value>>>8&255];
const u32=(value:number)=>[value&255,value>>>8&255,value>>>16&255,value>>>24&255];
const transferData=(amount:bigint)=>encoded([2,0,0,0,...u64(amount)]);
const routeStep=[72,...u16(10_000),0,1];
const swapData=()=>encoded([...ROUTE_V2,...u64(1_000_000n),...u64(2_000_000n),...u16(100),...u16(0),...u16(0),...u32(1),...routeStep]);
const sharedSwapData=()=>encoded([...SHARED_ACCOUNTS_ROUTE_V2,sharedAuthorityId,...u64(1_000_000n),...u64(2_000_000n),
  ...u16(100),...u16(0),...u16(0),...u32(1),...routeStep]);

function body():any {
  return {
    inputMint,outputMint,inAmount:'1000000',outAmount:'2000000',otherAmountThreshold:'1980000',swapMode:'ExactIn',slippageBps:100,
    transactionVersion:0,
    routePlan:[{percent:100,bps:10000,swapInfo:{ammKey:pool,label:'Test AMM',inputMint,outputMint,inAmount:'1000000',outAmount:'2000000'}}],
    computeBudgetInstructions:[{programId:COMPUTE_BUDGET_PROGRAM,accounts:[],data:priceData()}],
    setupInstructions:[
      {programId:ASSOCIATED_TOKEN_PROGRAM,accounts:[account(user,true,true),account(wsolAta,false,true),account(user),account(WSOL),
        account(SystemProgram.programId.toBase58()),account(TOKEN_PROGRAM)],data:encoded([1])},
      {programId:SystemProgram.programId.toBase58(),accounts:[account(user,true,true),account(wsolAta,false,true)],data:transferData(1_000_000n)},
      {programId:TOKEN_PROGRAM,accounts:[account(wsolAta,false,true)],data:encoded([17])},
      {programId:ASSOCIATED_TOKEN_PROGRAM,accounts:[account(user,true,true),account(userToken,false,true),account(user),account(outputMint),
        account(SystemProgram.programId.toBase58()),account(TOKEN_PROGRAM)],data:encoded([1])},
    ],
    swapInstruction:{programId:JUPITER_SWAP_PROGRAM,accounts:[account(user,true,false),account(wsolAta,false,true),account(userToken,false,true),
      account(inputMint),account(outputMint),account(TOKEN_PROGRAM),account(TOKEN_PROGRAM),account(JUPITER_SWAP_PROGRAM),
      account(EVENT_AUTHORITY),account(JUPITER_SWAP_PROGRAM),account(pool,false,true)],data:swapData()},
    cleanupInstruction:{programId:TOKEN_PROGRAM,accounts:[account(wsolAta,false,true),account(user,false,true),account(user,true,false)],data:encoded([9])},
    otherInstructions:[],tipInstruction:null,
    addressesByLookupTableAddress:{[lookupTable]:[pool,userToken]},
    blockhashWithMetadata:{blockhash:Array.from({length:32},(_,index)=>index+1),lastValidBlockHeight:400000000,
      fetchedAt:{secs_since_epoch:1800000000,nanos_since_epoch:123}},
  };
}

function sharedBody():any {
  const value=body();
  value.swapInstruction={programId:JUPITER_SWAP_PROGRAM,accounts:[
    account(sharedAuthority.toBase58()),account(user,true,false),account(wsolAta,false,true),account(programSource,false,true),
    account(programDestination,false,true),account(userToken,false,true),account(inputMint),account(outputMint),
    account(TOKEN_PROGRAM),account(TOKEN_PROGRAM),account(EVENT_AUTHORITY),account(JUPITER_SWAP_PROGRAM),account(pool,false,true),
  ],data:sharedSwapData()};
  return value;
}

const clone=()=>structuredClone(body());
const json=(value:unknown,init:ResponseInit={})=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json',...init.headers},...init});
const clientFor=(value:unknown,inspect?:(input:RequestInfo|URL,init?:RequestInit)=>void,options:Record<string,unknown>={})=>
  new JupiterBuildClient({...options,fetcher:async(input,init)=>{inspect?.(input,init);return json(value);}});

test('build requests the fixed fast Jito-compatible v0 route and returns validated web3 objects',async()=>{
  let calls=0;
  const client=clientFor(body(),(input,init)=>{
    calls++;const url=new URL(String(input)),headers=new Headers(init?.headers);
    assert.equal(url.origin+url.pathname,JUPITER_BUILD_ENDPOINT);
    assert.deepEqual(Object.fromEntries(url.searchParams),{inputMint,outputMint,amount:'1000000',taker:user,slippageBps:'100',mode:'fast',forJitoBundle:'true',transactionVersion:'0'});
    assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.equal(init?.body,undefined);
    assert.ok(init?.signal instanceof AbortSignal);assert.equal(headers.get('accept'),'application/json');assert.equal(headers.get('x-api-key'),'secret-key');
  },{apiKey:'secret-key'});
  const result=await client.build(request);
  assert.equal(calls,1);assert.equal(result.expectedOutputAmount,'2000000');assert.equal(result.minimumOutputAmount,'1980000');
  assert.equal(result.blockhash,bs58.encode(Uint8Array.from({length:32},(_,index)=>index+1)));assert.equal(result.lastValidBlockHeight,400000000);
  assert.deepEqual(result.instructions.map(ix=>ix.programId.toBase58()),[
    ASSOCIATED_TOKEN_PROGRAM,SystemProgram.programId.toBase58(),TOKEN_PROGRAM,ASSOCIATED_TOKEN_PROGRAM,JUPITER_SWAP_PROGRAM,TOKEN_PROGRAM]);
  assert.equal(result.instructions[4].keys[0].pubkey.toBase58(),user);
  assert.equal(result.addressLookupTableAccounts.length,1);assert.equal(result.addressLookupTableAccounts[0].key.toBase58(),lookupTable);
  assert.deepEqual(result.addressLookupTableAccounts[0].state.addresses.map(key=>key.toBase58()),[pool,userToken]);
  assert.equal(result.addressLookupTableAccounts[0].state.deactivationSlot,(1n<<64n)-1n);
  assert.deepEqual(result.subscriptionCandidates,[pool]);assert.equal(result.routePlan[0].swapInfo.label,'Test AMM');
});

test('current SharedAccountsRouteV2 response is accepted with its 12 fixed accounts and offset-9 arguments',async()=>{
  const result=await clientFor(sharedBody()).build(request);
  const swap=result.instructions[4],data=swap.data;
  assert.equal(swap.programId.toBase58(),JUPITER_SWAP_PROGRAM);
  assert.deepEqual(swap.keys.slice(0,12).map(key=>key.pubkey.toBase58()),[
    sharedAuthority.toBase58(),user,wsolAta,programSource,programDestination,userToken,inputMint,outputMint,
    TOKEN_PROGRAM,TOKEN_PROGRAM,EVENT_AUTHORITY,JUPITER_SWAP_PROGRAM,
  ]);
  assert.equal(data.subarray(0,8).toString('hex'),'d19853937cfed8e9');
  assert.equal(data[8],sharedAuthorityId);
  assert.equal(data.readBigUInt64LE(9),1_000_000n);
  assert.equal(data.readBigUInt64LE(17),2_000_000n);
  assert.equal(data.readUInt16LE(25),100);
  assert.deepEqual([...data.subarray(27,31)],[0,0,0,0]);
  assert.equal(data.readUInt32LE(31),1);
});

test('API key is caller-supplied and omitted cleanly when absent',async()=>{
  let header:string|null='unseen';
  await clientFor(body(),(_input,init)=>{header=new Headers(init?.headers).get('x-api-key');}).build(request);
  assert.equal(header,null);
  assert.throws(()=>new JupiterBuildClient({apiKey:'bad\nkey'}),/JUPITER_BUILD_OPTIONS_INVALID/);
});

test('the shared main bucket serializes bursts and fails entry fast during a 429 cooldown',async()=>{
  const called:number[]=[];let attempt=0;
  const client=new JupiterBuildClient({apiKey:'secret-key',mainBucketTier:'pro',mainBucketRps:150,fetcher:async()=>{
    called.push(Date.now());attempt++;
    return attempt===1?new Response('{}',{status:429,headers:{'content-type':'application/json','retry-after':'0.02'}}):json(body());
  }});
  await assert.rejects(client.build(request),/JUPITER_BUILD_RATE_LIMITED/);
  const started=Date.now();await assert.rejects(client.build(request),/JUPITER_BUILD_RATE_LIMITED/);
  assert.ok(Date.now()-started<15,'a known cooldown must not become a synchronous 20ms queue wait');assert.equal(called.length,1);
  await new Promise(resolve=>setTimeout(resolve,25));
  await client.build(request);
  assert.equal(called.length,2);assert.ok(called[1]-called[0]>=15,`429 retry gap was ${called[1]-called[0]}ms`);
  assert.ok((client.status().blockedUntil??0)<=Date.now());
});

test('exit requests jump queued entry work without bypassing the official bucket',async()=>{
  const order:number[]=[];
  const client=new JupiterBuildClient({apiKey:'secret-key',mainBucketTier:'developer',mainBucketRps:10,fetcher:async input=>{
    order.push(Number(new URL(String(input)).searchParams.get('slippageBps')));return new Response('{}',{status:503,headers:{'content-type':'application/json'}});
  }});
  const work=[
    client.build({...request,slippageBps:100,priority:'entry'}),
    client.build({...request,slippageBps:101,priority:'entry'}),
    client.build({...request,slippageBps:102,priority:'exit'}),
  ];
  const results=await Promise.allSettled(work);assert.ok(results.every(result=>result.status==='rejected'));
  assert.deepEqual(order,[100,102,101]);
});

test('Developer protection capacity leaves 300ms for delayed HTTP after worst-phase pacing',async()=>{
  let calls=0;
  const client=new JupiterBuildClient({apiKey:'secret-key',mainBucketTier:'developer',mainBucketRps:10,fetcher:async()=>{
    calls++;if(calls>1)await new Promise(resolve=>setTimeout(resolve,300));return json(body());
  }});
  assert.equal(client.protectionCapacity(700,1,40,300),3);
  await client.build({...request,priority:'entry'});const started=Date.now();
  const results=await Promise.all(Array.from({length:3},()=>client.build({...request,priority:'exit',signal:AbortSignal.timeout(700)})));
  assert.equal(results.length,3);assert.equal(calls,4);assert.ok(Date.now()-started<700,
    'all admitted protection quotes retain their HTTP/parse budget inside the 700ms deadline');
});

test('aborting a queued request removes it immediately instead of retaining a bucket tail',async()=>{
  let calls=0;
  const client=new JupiterBuildClient({mainBucketTier:'keyless',mainBucketRps:0.5,timeoutMs:5000,fetcher:async()=>{
    calls++;return new Response('{}',{status:503,headers:{'content-type':'application/json'}});
  }});
  await assert.rejects(client.build(request),/JUPITER_BUILD_HTTP_ERROR/);
  const controller=new AbortController(),started=Date.now(),pending=client.build({...request,priority:'exit',signal:controller.signal});
  await new Promise<void>(resolve=>setImmediate(resolve));controller.abort(Error('position quote deadline'));
  await assert.rejects(pending,/JUPITER_BUILD_UNAVAILABLE/);
  assert.ok(Date.now()-started<100,'abort must not wait for the two-second keyless spacing window');assert.equal(calls,1);
});

test('an entry 429 never poisons the exit lane, while its own cooldown fails fast',async()=>{
  let calls=0;
  const client=new JupiterBuildClient({apiKey:'secret-key',mainBucketTier:'pro',mainBucketRps:150,fetcher:async()=>{
    calls++;return calls===1?new Response('{}',{status:429,headers:{'retry-after':'60'}}):
      new Response('{}',{status:503,headers:{'content-type':'application/json'}});
  }});
  await assert.rejects(client.build({...request,priority:'entry'}),/JUPITER_BUILD_RATE_LIMITED/);
  const exitStarted=Date.now();await assert.rejects(client.build({...request,priority:'exit'}),/JUPITER_BUILD_HTTP_ERROR/);
  assert.ok(Date.now()-exitStarted<100,'exit must not inherit an entry Retry-After');assert.equal(calls,2);
  const entryStarted=Date.now();await assert.rejects(client.build({...request,priority:'entry'}),/JUPITER_BUILD_RATE_LIMITED/);
  assert.ok(Date.now()-entryStarted<30);assert.equal(calls,2);
});

test('an exit 429 is reported immediately to later exits instead of blocking them for Retry-After',async()=>{
  let calls=0;
  const client=new JupiterBuildClient({apiKey:'secret-key',mainBucketTier:'pro',mainBucketRps:150,fetcher:async()=>{
    calls++;return new Response('{}',{status:429,headers:{'retry-after':'60'}});
  }});
  await assert.rejects(client.build({...request,priority:'exit'}),/JUPITER_BUILD_RATE_LIMITED/);
  const started=Date.now();await assert.rejects(client.build({...request,priority:'exit'}),/JUPITER_BUILD_RATE_LIMITED/);
  assert.ok(Date.now()-started<30);assert.equal(calls,1);
});

test('invalid request identities, amounts, and slippage fail before fetch',async()=>{
  let calls=0;const client=new JupiterBuildClient({fetcher:async()=>{calls++;return json(body());}});
  for(const invalid of [
    {...request,user:'invalid'},
    {...request,outputMint:inputMint},
    {...request,amount:'0'},
    {...request,amount:'01'},
    {...request,amount:(1n<<64n).toString()},
    {...request,slippageBps:10000},
    {...request,priority:'urgent' as never},
  ])await assert.rejects(client.build(invalid),/JUPITER_BUILD_INPUT_INVALID/);
  assert.equal(calls,0);
});

test('response identity, exact input, and min-out floor are bound to the request',async()=>{
  const mutations=[
    (raw:any)=>{raw.inputMint=other;},
    (raw:any)=>{raw.outputMint=other;},
    (raw:any)=>{raw.inAmount='999999';},
    (raw:any)=>{raw.slippageBps=101;},
    (raw:any)=>{raw.swapMode='ExactOut';},
    (raw:any)=>{raw.transactionVersion=1;},
  ];
  for(const mutate of mutations){const raw=clone();mutate(raw);await assert.rejects(clientFor(raw).build(request),/JUPITER_BUILD_IDENTITY_MISMATCH/);}
  for(const threshold of ['2000001','1979999','0']){const raw=clone();raw.otherAmountThreshold=threshold;
    await assert.rejects(clientFor(raw).build(request),/JUPITER_BUILD_QUOTE_INVALID/);
  }
  const fee=clone();fee.platformFee={amount:'1',feeBps:1};
  await assert.rejects(clientFor(fee).build(request),/JUPITER_BUILD_IDENTITY_MISMATCH/);
});

test('route plans must be bounded, connected, and reconcile both endpoint amounts',async()=>{
  const badSource=clone();badSource.routePlan[0].swapInfo.inAmount='999999';
  await assert.rejects(clientFor(badSource).build(request),/JUPITER_BUILD_ROUTE_INVALID/);
  const badDestination=clone();badDestination.routePlan[0].swapInfo.outAmount='1999999';
  await assert.rejects(clientFor(badDestination).build(request),/JUPITER_BUILD_ROUTE_INVALID/);
  const disconnected=clone();disconnected.routePlan.push({percent:1,bps:1,swapInfo:{ammKey:other,label:'Detached',inputMint:other,
    outputMint:Keypair.fromSeed(Buffer.alloc(32,8)).publicKey.toBase58(),inAmount:'1',outAmount:'1'}});
  await assert.rejects(clientFor(disconnected).build(request),/JUPITER_BUILD_ROUTE_INVALID/);
  const oversized=clone();oversized.routePlan=Array.from({length:65},()=>oversized.routePlan[0]);
  await assert.rejects(clientFor(oversized).build(request),/JUPITER_BUILD_ROUTE_INVALID/);
  const middle=Keypair.fromSeed(Buffer.alloc(32,9)).publicKey.toBase58(),unbalanced=clone();
  unbalanced.routePlan=[
    {percent:100,bps:10000,swapInfo:{ammKey:pool,label:'First',inputMint,outputMint:middle,inAmount:'1000000',outAmount:'1500000'}},
    {percent:100,bps:10000,swapInfo:{ammKey:other,label:'Second',inputMint:middle,outputMint,inAmount:'1499999',outAmount:'2000000'}},
  ];
  await assert.rejects(clientFor(unbalanced).build(request),/JUPITER_BUILD_ROUTE_INVALID/);
});

test('instructions reject unknown programs, foreign signers, loose base64, surprise tips, and excessive CU price',async()=>{
  const cases:any[]=[];
  const unknown=clone();unknown.setupInstructions[0].programId=other;cases.push(unknown);
  const signer=clone();signer.swapInstruction.accounts.push(account(other,true));cases.push(signer);
  const loose=clone();loose.swapInstruction.data='AQ';cases.push(loose);
  const wrongSwap=clone();wrongSwap.swapInstruction.programId=TOKEN_PROGRAM;cases.push(wrongSwap);
  const tip=clone();tip.tipInstruction={programId:'11111111111111111111111111111111',accounts:[account(user,true,true),account(other,false,true)],data:encoded([2,0,0,0,1,0,0,0,0,0,0,0])};cases.push(tip);
  const price=clone();price.computeBudgetInstructions[0].data=priceData(10_000_001n);cases.push(price);
  for(const raw of cases)await assert.rejects(clientFor(raw).build(request),/JUPITER_BUILD_INSTRUCTION_INVALID/);
});

test('envelope and opaque swap bytes are bound to SOL endpoints, wallet ATAs, exact input, output and slippage',async()=>{
  const setupTransfer=clone();setupTransfer.setupInstructions[1].accounts[1].pubkey=other;
  await assert.rejects(clientFor(setupTransfer).build(request),/JUPITER_BUILD_SETUP_INVALID/);
  const setupAmount=clone();setupAmount.setupInstructions[1].data=transferData(999999n);
  await assert.rejects(clientFor(setupAmount).build(request),/JUPITER_BUILD_SETUP_INVALID/);
  const foreignAta=clone();foreignAta.setupInstructions[3].accounts[2].pubkey=other;
  await assert.rejects(clientFor(foreignAta).build(request),/JUPITER_BUILD_SETUP_INVALID/);
  const badCleanup=clone();badCleanup.cleanupInstruction.accounts[1].pubkey=other;
  await assert.rejects(clientFor(badCleanup).build(request),/JUPITER_BUILD_CLEANUP_INVALID/);
  for(const mutate of [
    (raw:any)=>{raw.swapInstruction.accounts[1].pubkey=other;},
    (raw:any)=>{raw.swapInstruction.accounts[3].pubkey=other;},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data.writeBigUInt64LE(999999n,8);raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data.writeBigUInt64LE(1999999n,16);raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data.writeUInt16LE(99,24);raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data[26]=1;raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data.writeUInt32LE(2,30);raw.swapInstruction.data=data.toString('base64');},
  ]){const raw=clone();mutate(raw);await assert.rejects(clientFor(raw).build(request),/JUPITER_BUILD_SWAP_IDENTITY_INVALID/);}
});

test('SharedAccountsRouteV2 binds authority, wallet ATAs, mints, token programs, amounts, slippage and zero fees',async()=>{
  const mutations=[
    (raw:any)=>{raw.swapInstruction.accounts[0].pubkey=other;},
    (raw:any)=>{raw.swapInstruction.accounts[2].pubkey=other;},
    (raw:any)=>{raw.swapInstruction.accounts[3].isWritable=false;},
    (raw:any)=>{raw.swapInstruction.accounts[5].pubkey=other;},
    (raw:any)=>{raw.swapInstruction.accounts[6].pubkey=other;},
    (raw:any)=>{raw.swapInstruction.accounts[7].pubkey=other;},
    (raw:any)=>{raw.swapInstruction.accounts[8].pubkey=other;},
    (raw:any)=>{raw.swapInstruction.accounts[10].pubkey=other;},
    (raw:any)=>{raw.swapInstruction.accounts[11].pubkey=other;},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data[0]^=1;raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data[8]=4;raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data.writeBigUInt64LE(999999n,9);raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data.writeBigUInt64LE(1999999n,17);raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data.writeUInt16LE(99,25);raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data[27]=1;raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data[29]=1;raw.swapInstruction.data=data.toString('base64');},
    (raw:any)=>{const data=Buffer.from(raw.swapInstruction.data,'base64');data.writeUInt32LE(2,31);raw.swapInstruction.data=data.toString('base64');},
  ];
  for(const mutate of mutations){const raw=sharedBody();mutate(raw);
    await assert.rejects(clientFor(raw).build(request),/JUPITER_BUILD_SWAP_IDENTITY_INVALID/);
  }
});

test('blockhash and ALT mappings require canonical bounded byte/address arrays while retaining positional duplicates',async()=>{
  const shortHash=clone();shortHash.blockhashWithMetadata.blockhash.pop();
  await assert.rejects(clientFor(shortHash).build(request),/JUPITER_BUILD_BLOCKHASH_INVALID/);
  const zeroHash=clone();zeroHash.blockhashWithMetadata.blockhash=Array(32).fill(0);
  await assert.rejects(clientFor(zeroHash).build(request),/JUPITER_BUILD_BLOCKHASH_INVALID/);
  const duplicate=clone();duplicate.addressesByLookupTableAddress[lookupTable]=[pool,pool];
  assert.deepEqual((await clientFor(duplicate).build(request)).addressLookupTableAccounts[0].state.addresses.map(key=>key.toBase58()),[pool,pool]);
  const invalid=clone();invalid.addressesByLookupTableAddress[lookupTable]=[pool,'invalid'];
  await assert.rejects(clientFor(invalid).build(request),/JUPITER_BUILD_LOOKUP_TABLE_INVALID/);
  const tooMany=clone();tooMany.addressesByLookupTableAddress[lookupTable]=Array.from({length:257},(_,index)=>
    new PublicKey(Buffer.from(Uint8Array.from({length:32},(_value,byte)=>byte===0?index%256:byte))).toBase58());
  await assert.rejects(clientFor(tooMany).build(request),/JUPITER_BUILD_LOOKUP_TABLE_INVALID/);
});

test('HTTP redirects, non-JSON, oversized bodies, and upstream failures are rejected without parsing',async()=>{
  const redirected=json(body());Object.defineProperty(redirected,'redirected',{value:true});
  await assert.rejects(new JupiterBuildClient({fetcher:async()=>redirected}).build(request),/JUPITER_BUILD_REDIRECT_REJECTED/);
  await assert.rejects(new JupiterBuildClient({fetcher:async()=>new Response('{}',{headers:{'content-type':'text/plain'}})}).build(request),/JUPITER_BUILD_RESPONSE_INVALID/);
  await assert.rejects(new JupiterBuildClient({fetcher:async()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'1000001'}})}).build(request),/JUPITER_BUILD_RESPONSE_INVALID/);
  await assert.rejects(new JupiterBuildClient({fetcher:async()=>new Response('{}',{status:503,headers:{'content-type':'application/json'}})}).build(request),/JUPITER_BUILD_HTTP_ERROR/);
  await assert.rejects(new JupiterBuildClient({fetcher:async()=>{throw Error('network details');}}).build(request),/JUPITER_BUILD_UNAVAILABLE/);
});

test('a caller abort reaches the underlying fetch and leaves no request running in the background',async()=>{
  const controller=new AbortController();let active=0,aborted=0,completed=0;
  const client=new JupiterBuildClient({timeoutMs:5_000,fetcher:async(_input,init)=>{
    const signal=init?.signal;if(!(signal instanceof AbortSignal))throw Error('missing signal');active++;
    return await new Promise<Response>((resolve,reject)=>{
      const timer=setTimeout(()=>{active--;completed++;resolve(json(body()));},1_000);
      const stop=()=>{clearTimeout(timer);active--;aborted++;reject(signal.reason??new DOMException('aborted','AbortError'));};
      if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});
    });
  }});
  const pending=client.build({...request,signal:controller.signal});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(active,1);controller.abort(Error('position quote deadline'));
  await assert.rejects(pending,/JUPITER_BUILD_UNAVAILABLE/);
  assert.deepEqual({active,aborted,completed},{active:0,aborted:1,completed:0});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual({active,aborted,completed},{active:0,aborted:1,completed:0});
});
