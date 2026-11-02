import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import {getAssociatedTokenAddressSync} from '@solana/spl-token';
import bs58 from 'bs58';

export const JUPITER_BUILD_ENDPOINT='https://api.jup.ag/swap/v2/build';
export const JUPITER_SWAP_PROGRAM='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const COMPUTE_BUDGET_PROGRAM='ComputeBudget111111111111111111111111111111';
const SYSTEM_PROGRAM='11111111111111111111111111111111';
const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WSOL='So11111111111111111111111111111111111111112';
// Jupiter v2 currently emits either a direct RouteV2 or a shared-account
// RouteV2. Their account order and fixed argument offsets are different; do
// not infer one layout from the other.
const ROUTE_V2=Buffer.from([187,100,250,204,49,196,175,20]);
const SHARED_ACCOUNTS_ROUTE_V2=Buffer.from([209,152,83,147,124,254,216,233]);
const JUPITER_EVENT_AUTHORITY='D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
const ALLOWED_ENVELOPE_PROGRAMS=new Set([
  JUPITER_SWAP_PROGRAM,COMPUTE_BUDGET_PROGRAM,SYSTEM_PROGRAM,TOKEN_PROGRAM,TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
]);
const U64_MAX=(1n<<64n)-1n;
const MAX_RESPONSE_BYTES=1_000_000;
const MAX_ROUTE_STEPS=64;
const MAX_INSTRUCTIONS=16;
const MAX_ACCOUNTS_PER_INSTRUCTION=128;
const MAX_INSTRUCTION_DATA_BYTES=4096;
const MAX_LOOKUP_TABLES=4;
const MAX_LOOKUP_ADDRESSES=256;

export interface JupiterBuildRequest {
  user:string;
  inputMint:string;
  outputMint:string;
  amount:string;
  slippageBps:number;
  /** Exit traffic always runs ahead of entry construction/probes. */
  priority?:JupiterRequestPriority;
  signal?:AbortSignal;
}

export interface JupiterSwapInfo {
  ammKey:string;
  label:string;
  inputMint:string;
  outputMint:string;
  inAmount:string;
  outAmount:string;
}

export interface JupiterRoutePlanStep {
  percent:number;
  bps:number;
  swapInfo:JupiterSwapInfo;
  usdValue?:number;
}

export interface JupiterBuildResult {
  instructions:TransactionInstruction[];
  addressLookupTableAccounts:AddressLookupTableAccount[];
  blockhash:string;
  lastValidBlockHeight:number;
  expectedOutputAmount:string;
  minimumOutputAmount:string;
  routePlan:JupiterRoutePlanStep[];
  /** Pool/AMM accounts from routePlan. Callers may subscribe to these as price-change hints. */
  subscriptionCandidates:string[];
}

export interface JupiterBuildClientOptions {
  fetcher?:typeof fetch;
  /** Pass process.env.JUPITER_API_KEY here if the caller has one. */
  apiKey?:string;
  mainBucketTier?:JupiterMainBucketTier;
  /** Reserved main-bucket rate. It may only reduce the selected official tier. */
  mainBucketRps?:number;
  timeoutMs?:number;
  /** Reject unexpectedly expensive SetComputeUnitPrice instructions. */
  maxComputeUnitPriceMicroLamports?:bigint;
}

export type JupiterMainBucketTier='keyless'|'free'|'developer'|'launch'|'pro';
export type JupiterRequestPriority='entry'|'exit';
const JUPITER_TIER_RPS:Readonly<Record<JupiterMainBucketTier,number>>={keyless:0.5,free:1,developer:10,launch:50,pro:150};

interface JupiterBucketWaiter {
  priority:JupiterRequestPriority;signal:AbortSignal;resolve:()=>void;reject:(reason:unknown)=>void;
  abort:()=>void;queued:boolean;
}

class JupiterMainBucket {
  private readonly windowLimit:number;private readonly spacingMs:number;
  private timestamps:number[]=[];private nextAt=0;private entryBlockedUntil=0;private exitBlockedUntil=0;
  private queues:Record<JupiterRequestPriority,JupiterBucketWaiter[]>={entry:[],exit:[]};
  private timer?:ReturnType<typeof setTimeout>;
  constructor(readonly tier:JupiterMainBucketTier,readonly rps:number){
    const max=JUPITER_TIER_RPS[tier];
    if(!Number.isFinite(rps)||rps<=0||rps>max||Math.round(rps*2)!==rps*2)fail('JUPITER_BUILD_OPTIONS_INVALID');
    this.windowLimit=Math.floor(rps*60);this.spacingMs=Math.ceil(1000/rps);
  }
  status(){const now=Date.now(),blockedUntil=Math.max(this.entryBlockedUntil>now?this.entryBlockedUntil:0,this.exitBlockedUntil>now?this.exitBlockedUntil:0);
    return {tier:this.tier,rps:this.rps,rpm:this.windowLimit,blockedUntil:blockedUntil||undefined};}
  protectionCapacity(timeoutMs:number,callsPerDecision=1,max=40,httpBudgetMs=300):number {
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(callsPerDecision)||callsPerDecision<1||
      !Number.isSafeInteger(max)||max<1||!Number.isSafeInteger(httpBudgetMs)||httpBudgetMs<1||httpBudgetMs>=timeoutMs)return 0;
    if(this.entryBlockedUntil>Date.now())return 0;
    // Assume the previous bucket permit was consumed immediately before a
    // price wake. This worst-phase budget keeps every admitted position's
    // single trigger quote inside its deadline; the exact partial execution
    // route is built later under the durable exit intent.
    const permits=Math.floor((timeoutMs-httpBudgetMs-1)/this.spacingMs);
    return Math.min(max,Math.floor(permits/callsPerDecision));
  }
  private remove(waiter:JupiterBucketWaiter):boolean {
    if(!waiter.queued)return false;const queue=this.queues[waiter.priority],index=queue.indexOf(waiter);
    if(index<0)return false;queue.splice(index,1);waiter.queued=false;waiter.signal.removeEventListener('abort',waiter.abort);return true;
  }
  private next():JupiterBucketWaiter|undefined{return this.queues.exit[0]??this.queues.entry[0];}
  private pump():void {
    clearTimeout(this.timer);this.timer=undefined;
    for(;;){
      const waiter=this.next();if(!waiter)return;
      if(waiter.signal.aborted){if(this.remove(waiter))waiter.reject(waiter.signal.reason??Error('JUPITER_BUILD_ABORTED'));continue;}
      const now=Date.now(),blockedUntil=waiter.priority==='exit'?this.exitBlockedUntil:this.entryBlockedUntil;
      // A provider cooldown is not a 60-second synchronous exit operation.
      // Reject it immediately so the position loop remains responsive and can
      // retry on its next wake. Entry work cannot poison the exit lane.
      if(blockedUntil>now){this.remove(waiter);waiter.reject(new JupiterBuildError('JUPITER_BUILD_RATE_LIMITED'));continue;}
      this.timestamps=this.timestamps.filter(at=>now-at<60_000);
      const windowAt=this.timestamps.length>=this.windowLimit?this.timestamps[0]+60_000:now;
      const allowedAt=Math.max(now,this.nextAt,windowAt);
      if(allowedAt>now){this.timer=setTimeout(()=>this.pump(),allowedAt-now);return;}
      this.remove(waiter);this.timestamps.push(now);this.nextAt=now+this.spacingMs;waiter.resolve();
      // Re-evaluate the queues before assigning the next permit: an exit that
      // arrives during the spacing interval must jump every queued entry.
    }
  }
  acquire(priority:JupiterRequestPriority,signal:AbortSignal):Promise<void>{
    if(signal.aborted)return Promise.reject(signal.reason??Error('JUPITER_BUILD_ABORTED'));
    return new Promise((resolve,reject)=>{const waiter={} as JupiterBucketWaiter;
      waiter.priority=priority;waiter.signal=signal;waiter.resolve=resolve;waiter.reject=reject;waiter.queued=true;
      waiter.abort=()=>{if(this.remove(waiter)){reject(signal.reason??Error('JUPITER_BUILD_ABORTED'));this.pump();}};
      signal.addEventListener('abort',waiter.abort,{once:true});this.queues[priority].push(waiter);this.pump();});
  }
  rateLimited(response:Response,priority:JupiterRequestPriority):void {
    const now=Date.now(),retry=response.headers.get('retry-after'),reset=response.headers.get('x-ratelimit-reset');let until=now+this.spacingMs;
    if(retry&&/^\d+(?:\.\d+)?$/.test(retry))until=Math.max(until,now+Math.ceil(Number(retry)*1000));
    if(reset&&/^\d+$/.test(reset)){const value=Number(reset),absolute=value>1e12?value:value>1e9?value*1000:now+value*1000;until=Math.max(until,absolute);}
    until=Math.min(now+60_000,until);this.entryBlockedUntil=Math.max(this.entryBlockedUntil,until);
    if(priority==='exit')this.exitBlockedUntil=Math.max(this.exitBlockedUntil,until);
    this.pump();
  }
}

export class JupiterBuildError extends Error {
  readonly reason:string;
  constructor(reason:string){super(reason);this.name='JupiterBuildError';this.reason=reason;}
}

type ObjectValue=Record<string,unknown>;
type InstructionKind='compute'|'setup'|'swap'|'cleanup'|'other';

const isObject=(value:unknown):value is ObjectValue=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(reason:string):never=>{throw new JupiterBuildError(reason);};

function publicKey(value:unknown,reason:string):PublicKey {
  if(typeof value!=='string')return fail(reason);
  try {const result=new PublicKey(value);if(result.toBase58()!==value)fail(reason);return result;}
  catch(error){if(error instanceof JupiterBuildError)throw error;return fail(reason);}
}

function atomic(value:unknown,allowZero=false):value is string {
  return typeof value==='string'&&/^(0|[1-9]\d{0,19})$/.test(value)&&BigInt(value)<=U64_MAX&&(allowZero||value!=='0');
}

function uint(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
}

function canonicalBase64(value:unknown):Buffer {
  if(typeof value!=='string'||value.length>Math.ceil(MAX_INSTRUCTION_DATA_BYTES/3)*4||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  const data=Buffer.from(value,'base64');
  if(data.length>MAX_INSTRUCTION_DATA_BYTES||data.toString('base64')!==value)return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  return data;
}

function validatedRequest(request:JupiterBuildRequest):JupiterBuildRequest {
  if(!isObject(request))return fail('JUPITER_BUILD_INPUT_INVALID');
  const user=publicKey(request.user,'JUPITER_BUILD_INPUT_INVALID');
  const inputMint=publicKey(request.inputMint,'JUPITER_BUILD_INPUT_INVALID');
  const outputMint=publicKey(request.outputMint,'JUPITER_BUILD_INPUT_INVALID');
  if(!PublicKey.isOnCurve(user.toBytes())||user.equals(PublicKey.default)||inputMint.equals(outputMint)||
    (request.inputMint===WSOL)===(request.outputMint===WSOL)||
    !atomic(request.amount)||!uint(request.slippageBps,0,9999)||
    request.priority!==undefined&&!['entry','exit'].includes(request.priority)||
    request.signal!==undefined&&!(request.signal instanceof AbortSignal))return fail('JUPITER_BUILD_INPUT_INVALID');
  return {...request};
}

function instruction(value:unknown,kind:InstructionKind,user:string,maxComputePrice:bigint):TransactionInstruction {
  if(!isObject(value)||!Array.isArray(value.accounts)||value.accounts.length>(kind==='compute'?0:MAX_ACCOUNTS_PER_INSTRUCTION))
    return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  const programId=publicKey(value.programId,'JUPITER_BUILD_INSTRUCTION_INVALID');
  const program=programId.toBase58();
  if(kind==='compute'&&program!==COMPUTE_BUDGET_PROGRAM||kind==='swap'&&program!==JUPITER_SWAP_PROGRAM||
    kind!=='compute'&&kind!=='swap'&&!ALLOWED_ENVELOPE_PROGRAMS.has(program))return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  const data=canonicalBase64(value.data);
  if(data.length===0)return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  if(kind==='compute'){
    // Swap v2 promises CU price only; accepting a server-supplied CU limit changes caller policy.
    if(data.length!==9||data[0]!==3||data.readBigUInt64LE(1)>maxComputePrice)return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  }
  const keys=value.accounts.map(account=>{
    if(!isObject(account)||typeof account.isSigner!=='boolean'||typeof account.isWritable!=='boolean')
      return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
    const pubkey=publicKey(account.pubkey,'JUPITER_BUILD_INSTRUCTION_INVALID');
    if(account.isSigner&&pubkey.toBase58()!==user)return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
    return {pubkey,isSigner:account.isSigner,isWritable:account.isWritable};
  });
  if(kind!=='compute'&&keys.length===0||kind==='swap'&&!keys.some(key=>key.isSigner&&key.pubkey.toBase58()===user))
    return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  return new TransactionInstruction({programId,keys,data});
}

const same=(a:PublicKey,b:string)=>a.toBase58()===b;
const exactData=(value:Buffer,bytes:number[])=>value.length===bytes.length&&bytes.every((byte,index)=>value[index]===byte);

function validRoutePlanTail(data:Buffer,offset:number,routeSteps:number):boolean {
  // Borsh Vec<RoutePlanStepV2>: u32 length followed by steps. Every step has
  // at least a u8 SwapType tag, u16 bps and two u8 token indexes. SwapType
  // payloads are deliberately left to the audited Jupiter program because
  // the enum grows independently of this client.
  return data.length>=offset+4+routeSteps*5&&data.readUInt32LE(offset)===routeSteps;
}

function exactMeta(key:{isSigner:boolean;isWritable:boolean},isSigner:boolean,isWritable:boolean):boolean {
  return key.isSigner===isSigner&&key.isWritable===isWritable;
}

function routeV2Instruction(ix:TransactionInstruction,request:JupiterBuildRequest,expected:string,routeSteps:number):TransactionInstruction {
  const keys=ix.keys,data=ix.data;
  if(keys.length<10||!same(keys[0].pubkey,request.user)||!exactMeta(keys[0],true,false)||
    ![TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(keys[5]?.pubkey.toBase58())||
    ![TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(keys[6]?.pubkey.toBase58())||
    !same(keys[3].pubkey,request.inputMint)||!exactMeta(keys[3],false,false)||
    !same(keys[4].pubkey,request.outputMint)||!exactMeta(keys[4],false,false)||
    !same(keys[7].pubkey,JUPITER_SWAP_PROGRAM)||!exactMeta(keys[7],false,false)||
    !same(keys[8].pubkey,JUPITER_EVENT_AUTHORITY)||!exactMeta(keys[8],false,false)||
    !same(keys[9].pubkey,JUPITER_SWAP_PROGRAM)||!exactMeta(keys[9],false,false))
    return fail('JUPITER_BUILD_SWAP_IDENTITY_INVALID');
  const inputProgram=keys[5].pubkey,outputProgram=keys[6].pubkey;
  const expectedInputAta=getAssociatedTokenAddressSync(new PublicKey(request.inputMint),new PublicKey(request.user),false,inputProgram);
  const expectedOutputAta=getAssociatedTokenAddressSync(new PublicKey(request.outputMint),new PublicKey(request.user),false,outputProgram);
  if(!keys[1].pubkey.equals(expectedInputAta)||!exactMeta(keys[1],false,true)||
    !keys[2].pubkey.equals(expectedOutputAta)||!exactMeta(keys[2],false,true)||
    !exactMeta(keys[5],false,false)||!exactMeta(keys[6],false,false)||
    data.length<34||!data.subarray(0,8).equals(ROUTE_V2)||data.readBigUInt64LE(8)!==BigInt(request.amount)||
    data.readBigUInt64LE(16)!==BigInt(expected)||data.readUInt16LE(24)!==request.slippageBps||
    !data.subarray(26,30).equals(Buffer.alloc(4))||!validRoutePlanTail(data,30,routeSteps))
    return fail('JUPITER_BUILD_SWAP_IDENTITY_INVALID');
  return ix;
}

function sharedAccountsRouteV2Instruction(ix:TransactionInstruction,request:JupiterBuildRequest,expected:string,routeSteps:number):TransactionInstruction {
  const keys=ix.keys,data=ix.data;
  if(keys.length<12||data.length<35||!data.subarray(0,8).equals(SHARED_ACCOUNTS_ROUTE_V2))
    return fail('JUPITER_BUILD_SWAP_IDENTITY_INVALID');
  const inputProgram=keys[8]?.pubkey,outputProgram=keys[9]?.pubkey;
  if(!inputProgram||!outputProgram||![TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(inputProgram.toBase58())||
    ![TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(outputProgram.toBase58()))
    return fail('JUPITER_BUILD_SWAP_IDENTITY_INVALID');
  const user=new PublicKey(request.user),inputMint=new PublicKey(request.inputMint),outputMint=new PublicKey(request.outputMint);
  const expectedAuthority=PublicKey.findProgramAddressSync([Buffer.from('authority'),data.subarray(8,9)],new PublicKey(JUPITER_SWAP_PROGRAM))[0];
  const expectedInputAta=getAssociatedTokenAddressSync(inputMint,user,false,inputProgram);
  const expectedOutputAta=getAssociatedTokenAddressSync(outputMint,user,false,outputProgram);
  if(!keys[0].pubkey.equals(expectedAuthority)||!exactMeta(keys[0],false,false)||
    !same(keys[1].pubkey,request.user)||!exactMeta(keys[1],true,false)||
    !keys[2].pubkey.equals(expectedInputAta)||!exactMeta(keys[2],false,true)||
    !exactMeta(keys[3],false,true)||!exactMeta(keys[4],false,true)||
    !keys[5].pubkey.equals(expectedOutputAta)||!exactMeta(keys[5],false,true)||
    !keys[6].pubkey.equals(inputMint)||!exactMeta(keys[6],false,false)||
    !keys[7].pubkey.equals(outputMint)||!exactMeta(keys[7],false,false)||
    !exactMeta(keys[8],false,false)||!exactMeta(keys[9],false,false)||
    !same(keys[10].pubkey,JUPITER_EVENT_AUTHORITY)||!exactMeta(keys[10],false,false)||
    !same(keys[11].pubkey,JUPITER_SWAP_PROGRAM)||!exactMeta(keys[11],false,false)||
    data.readBigUInt64LE(9)!==BigInt(request.amount)||data.readBigUInt64LE(17)!==BigInt(expected)||
    data.readUInt16LE(25)!==request.slippageBps||!data.subarray(27,31).equals(Buffer.alloc(4))||
    !validRoutePlanTail(data,31,routeSteps))return fail('JUPITER_BUILD_SWAP_IDENTITY_INVALID');
  return ix;
}

function swapInstruction(value:unknown,request:JupiterBuildRequest,expected:string,routeSteps:number,maxComputePrice:bigint):TransactionInstruction {
  const ix=instruction(value,'swap',request.user,maxComputePrice),keys=ix.keys,data=ix.data;
  if(data.subarray(0,8).equals(ROUTE_V2))return routeV2Instruction(ix,request,expected,routeSteps);
  if(data.subarray(0,8).equals(SHARED_ACCOUNTS_ROUTE_V2))return sharedAccountsRouteV2Instruction(ix,request,expected,routeSteps);
  return fail('JUPITER_BUILD_SWAP_IDENTITY_INVALID');
}

function envelopeInstructions(value:unknown,cleanupValue:unknown,request:JupiterBuildRequest,routeMints:Set<string>,maxComputePrice:bigint):TransactionInstruction[] {
  if(!Array.isArray(value)||value.length>12)return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  const user=new PublicKey(request.user),wsol=new PublicKey(WSOL);
  const wsolAta=getAssociatedTokenAddressSync(wsol,user,false,new PublicKey(TOKEN_PROGRAM));
  let transfer=0,sync=0,wsolAtaCreates=0;const atas=new Set<string>(),setup:TransactionInstruction[]=[];
  for(const raw of value){
    const ix=instruction(raw,'setup',request.user,maxComputePrice),program=ix.programId.toBase58(),keys=ix.keys;
    if(program===ASSOCIATED_TOKEN_PROGRAM){
      if(keys.length!==6||!exactData(ix.data,[1])||!same(keys[0].pubkey,request.user)||!keys[0].isSigner||!keys[0].isWritable||
        !same(keys[2].pubkey,request.user)||keys[2].isSigner||!routeMints.has(keys[3].pubkey.toBase58())||
        !same(keys[4].pubkey,SYSTEM_PROGRAM)||![TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(keys[5].pubkey.toBase58()))
        return fail('JUPITER_BUILD_SETUP_INVALID');
      const expectedAta=getAssociatedTokenAddressSync(keys[3].pubkey,user,false,keys[5].pubkey),encoded=expectedAta.toBase58();
      if(!keys[1].pubkey.equals(expectedAta)||!keys[1].isWritable||atas.has(encoded))return fail('JUPITER_BUILD_SETUP_INVALID');
      atas.add(encoded);if(expectedAta.equals(wsolAta))wsolAtaCreates++;
    }else if(program===SYSTEM_PROGRAM){
      if(request.inputMint!==WSOL||++transfer!==1||keys.length!==2||ix.data.length!==12||ix.data.readUInt32LE(0)!==2||
        ix.data.readBigUInt64LE(4)!==BigInt(request.amount)||!same(keys[0].pubkey,request.user)||!keys[0].isSigner||!keys[0].isWritable||
        !keys[1].pubkey.equals(wsolAta)||keys[1].isSigner||!keys[1].isWritable)return fail('JUPITER_BUILD_SETUP_INVALID');
    }else if(program===TOKEN_PROGRAM){
      if(request.inputMint!==WSOL||++sync!==1||keys.length!==1||!exactData(ix.data,[17])||!keys[0].pubkey.equals(wsolAta)||
        keys[0].isSigner||!keys[0].isWritable)return fail('JUPITER_BUILD_SETUP_INVALID');
    }else return fail('JUPITER_BUILD_SETUP_INVALID');
    setup.push(ix);
  }
  if(wsolAtaCreates!==1||request.inputMint===WSOL&&(transfer!==1||sync!==1)||request.outputMint===WSOL&&(transfer!==0||sync!==0))
    return fail('JUPITER_BUILD_SETUP_INVALID');
  const cleanup=instruction(cleanupValue,'cleanup',request.user,maxComputePrice),keys=cleanup.keys;
  if(cleanup.programId.toBase58()!==TOKEN_PROGRAM||keys.length!==3||!exactData(cleanup.data,[9])||
    !keys[0].pubkey.equals(wsolAta)||!keys[0].isWritable||!same(keys[1].pubkey,request.user)||!keys[1].isWritable||
    !same(keys[2].pubkey,request.user)||!keys[2].isSigner)return fail('JUPITER_BUILD_CLEANUP_INVALID');
  return [...setup,cleanup];
}

function routePlan(value:unknown,request:JupiterBuildRequest,expected:string):JupiterRoutePlanStep[] {
  if(!Array.isArray(value)||value.length<1||value.length>MAX_ROUTE_STEPS)return fail('JUPITER_BUILD_ROUTE_INVALID');
  const result=value.map((step):JupiterRoutePlanStep=>{
    if(!isObject(step)||!uint(step.bps,1,10_000)||typeof step.percent!=='number'||!Number.isFinite(step.percent)||step.percent<0||step.percent>100||
      !isObject(step.swapInfo))return fail('JUPITER_BUILD_ROUTE_INVALID');
    const info=step.swapInfo;
    const ammKey=publicKey(info.ammKey,'JUPITER_BUILD_ROUTE_INVALID').toBase58();
    const inputMint=publicKey(info.inputMint,'JUPITER_BUILD_ROUTE_INVALID').toBase58();
    const outputMint=publicKey(info.outputMint,'JUPITER_BUILD_ROUTE_INVALID').toBase58();
    if(inputMint===outputMint||typeof info.label!=='string'||info.label.length<1||info.label.length>120||
      info.label.trim()!==info.label||/[\u0000-\u001f\u007f]/.test(info.label)||!atomic(info.inAmount)||!atomic(info.outAmount))
      return fail('JUPITER_BUILD_ROUTE_INVALID');
    if(step.usdValue!==undefined&&(typeof step.usdValue!=='number'||!Number.isFinite(step.usdValue)||step.usdValue<0||step.usdValue>1e15))
      return fail('JUPITER_BUILD_ROUTE_INVALID');
    return {percent:step.percent,bps:step.bps,swapInfo:{ammKey,label:info.label,inputMint,outputMint,inAmount:info.inAmount,outAmount:info.outAmount},
      ...(step.usdValue===undefined?{}:{usdValue:step.usdValue})};
  });
  const source=result.filter(step=>step.swapInfo.inputMint===request.inputMint);
  const destination=result.filter(step=>step.swapInfo.outputMint===request.outputMint);
  if(source.length===0||destination.length===0||source.reduce((sum,step)=>sum+BigInt(step.swapInfo.inAmount),0n)!==BigInt(request.amount)||
    source.reduce((sum,step)=>sum+step.bps,0)!==10_000||destination.reduce((sum,step)=>sum+BigInt(step.swapInfo.outAmount),0n)!==BigInt(expected))
    return fail('JUPITER_BUILD_ROUTE_INVALID');
  const consumed=new Map<string,bigint>(),produced=new Map<string,bigint>();
  for(const step of result){
    consumed.set(step.swapInfo.inputMint,(consumed.get(step.swapInfo.inputMint)??0n)+BigInt(step.swapInfo.inAmount));
    produced.set(step.swapInfo.outputMint,(produced.get(step.swapInfo.outputMint)??0n)+BigInt(step.swapInfo.outAmount));
  }
  if((produced.get(request.inputMint)??0n)!==0n||(consumed.get(request.outputMint)??0n)!==0n||
    [...new Set([...consumed.keys(),...produced.keys()])].some(mint=>mint!==request.inputMint&&mint!==request.outputMint&&
      (consumed.get(mint)??0n)!==(produced.get(mint)??0n)))return fail('JUPITER_BUILD_ROUTE_INVALID');
  const reachable=new Set([request.inputMint]);
  let changed=true;
  while(changed){changed=false;for(const step of result)if(reachable.has(step.swapInfo.inputMint)&&!reachable.has(step.swapInfo.outputMint)){
    reachable.add(step.swapInfo.outputMint);changed=true;
  }}
  if(!reachable.has(request.outputMint)||result.some(step=>!reachable.has(step.swapInfo.inputMint)))return fail('JUPITER_BUILD_ROUTE_INVALID');
  return result;
}

function lookupTables(value:unknown):AddressLookupTableAccount[] {
  if(value===null)return [];
  if(!isObject(value))return fail('JUPITER_BUILD_LOOKUP_TABLE_INVALID');
  const entries=Object.entries(value);
  if(entries.length>MAX_LOOKUP_TABLES)return fail('JUPITER_BUILD_LOOKUP_TABLE_INVALID');
  return entries.map(([key,rawAddresses])=>{
    const tableKey=publicKey(key,'JUPITER_BUILD_LOOKUP_TABLE_INVALID');
    if(!Array.isArray(rawAddresses)||rawAddresses.length<1||rawAddresses.length>MAX_LOOKUP_ADDRESSES)
      return fail('JUPITER_BUILD_LOOKUP_TABLE_INVALID');
    // ALT indexes are positional and on-chain tables may legitimately contain
    // repeated addresses. The executor compares this complete ordered array
    // with the RPC-fetched table before compilation.
    const addresses=rawAddresses.map(value=>publicKey(value,'JUPITER_BUILD_LOOKUP_TABLE_INVALID'));
    return new AddressLookupTableAccount({key:tableKey,state:{deactivationSlot:U64_MAX,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,addresses}});
  });
}

function blockhash(value:unknown):{blockhash:string;lastValidBlockHeight:number} {
  if(!isObject(value)||!Array.isArray(value.blockhash)||value.blockhash.length!==32||
    value.blockhash.some(byte=>!uint(byte,0,255))||value.blockhash.every(byte=>byte===0)||!uint(value.lastValidBlockHeight,1))
    return fail('JUPITER_BUILD_BLOCKHASH_INVALID');
  if(value.fetchedAt!==undefined){
    if(!isObject(value.fetchedAt)||!uint(value.fetchedAt.secs_since_epoch,1)||!uint(value.fetchedAt.nanos_since_epoch,0,999_999_999))
      return fail('JUPITER_BUILD_BLOCKHASH_INVALID');
  }
  return {blockhash:bs58.encode(Uint8Array.from(value.blockhash as number[])),lastValidBlockHeight:value.lastValidBlockHeight};
}

async function boundedText(response:Response):Promise<string> {
  const header=response.headers.get('content-length');
  if(header!==null&&(!/^\d+$/.test(header)||Number(header)>MAX_RESPONSE_BYTES))return fail('JUPITER_BUILD_RESPONSE_INVALID');
  if(!response.body)return '';
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;if(!value)continue;total+=value.byteLength;
    if(total>MAX_RESPONSE_BYTES){await reader.cancel();return fail('JUPITER_BUILD_RESPONSE_INVALID');}chunks.push(value);
  }
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return fail('JUPITER_BUILD_RESPONSE_INVALID');}
}

function parseResponse(raw:unknown,request:JupiterBuildRequest,maxComputePrice:bigint):JupiterBuildResult {
  if(!isObject(raw)||raw.error!==undefined||raw.errorCode!==undefined||raw.inputMint!==request.inputMint||raw.outputMint!==request.outputMint||
    raw.inAmount!==request.amount||raw.swapMode!=='ExactIn'||raw.slippageBps!==request.slippageBps||
    raw.taker!==undefined&&raw.taker!==request.user||raw.transactionVersion!==undefined&&raw.transactionVersion!==0||
    raw.platformFee!==undefined&&raw.platformFee!==null)
    return fail('JUPITER_BUILD_IDENTITY_MISMATCH');
  if(!atomic(raw.outAmount)||!atomic(raw.otherAmountThreshold,true))return fail('JUPITER_BUILD_QUOTE_INVALID');
  const expected=BigInt(raw.outAmount),minimum=BigInt(raw.otherAmountThreshold);
  const requestedFloor=expected*BigInt(10_000-request.slippageBps)/10_000n;
  if(minimum>expected||minimum<requestedFloor||request.slippageBps<10_000&&minimum===0n)return fail('JUPITER_BUILD_QUOTE_INVALID');
  const parsedRoute=routePlan(raw.routePlan,request,raw.outAmount);
  // Validate Jupiter's suggested priority price, but the local executor owns
  // compute limit/price policy and deliberately does not include this instruction.
  if(!Array.isArray(raw.computeBudgetInstructions)||raw.computeBudgetInstructions.length!==1)
    return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  instruction(raw.computeBudgetInstructions[0],'compute',request.user,maxComputePrice);
  if(!Array.isArray(raw.otherInstructions)||raw.otherInstructions.length!==0||raw.tipInstruction!==undefined&&raw.tipInstruction!==null)
    return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  const routeMints=new Set(parsedRoute.flatMap(step=>[step.swapInfo.inputMint,step.swapInfo.outputMint]));
  const envelope=envelopeInstructions(raw.setupInstructions,raw.cleanupInstruction,request,routeMints,maxComputePrice);
  const cleanup=envelope.pop()!;
  const swap=swapInstruction(raw.swapInstruction,request,raw.outAmount,parsedRoute.length,maxComputePrice);
  const instructions=[...envelope,swap,cleanup];
  if(instructions.length<1||instructions.length>MAX_INSTRUCTIONS)return fail('JUPITER_BUILD_INSTRUCTION_INVALID');
  const lifetime=blockhash(raw.blockhashWithMetadata),tables=lookupTables(raw.addressesByLookupTableAddress);
  return {instructions,addressLookupTableAccounts:tables,...lifetime,expectedOutputAmount:raw.outAmount,
    minimumOutputAmount:raw.otherAmountThreshold,routePlan:parsedRoute,
    subscriptionCandidates:[...new Set(parsedRoute.map(step=>step.swapInfo.ammKey))]};
}

/** Fetches and validates instructions only. It never signs, simulates, or submits a transaction. */
export class JupiterBuildClient {
  private readonly fetcher:typeof fetch;
  private readonly apiKey?:string;
  private readonly timeoutMs:number;
  private readonly maxComputePrice:bigint;
  private readonly bucket:JupiterMainBucket;
  constructor(options:JupiterBuildClientOptions={}){
    this.fetcher=options.fetcher??fetch;this.apiKey=options.apiKey;this.timeoutMs=options.timeoutMs??12_000;
    this.maxComputePrice=options.maxComputeUnitPriceMicroLamports??10_000_000n;
    const tier=options.mainBucketTier??(this.apiKey?'free':'keyless'),rps=options.mainBucketRps??JUPITER_TIER_RPS[tier];
    if(typeof this.fetcher!=='function'||this.apiKey!==undefined&&(!/^[\x21-\x7e]{1,512}$/.test(this.apiKey))||
      !uint(this.timeoutMs,100,30_000)||typeof this.maxComputePrice!=='bigint'||this.maxComputePrice<0n||this.maxComputePrice>U64_MAX||
      !(tier in JUPITER_TIER_RPS)||!this.apiKey&&tier!=='keyless')
      fail('JUPITER_BUILD_OPTIONS_INVALID');
    this.bucket=new JupiterMainBucket(tier,rps);
  }
  status(){return this.bucket.status();}
  protectionCapacity(timeoutMs:number,callsPerDecision=1,max=40,httpBudgetMs=300){
    return this.bucket.protectionCapacity(timeoutMs,callsPerDecision,max,httpBudgetMs);
  }
  async build(input:JupiterBuildRequest):Promise<JupiterBuildResult>{
    const request=validatedRequest(input);
    const priority=request.priority??'entry';
    const url=new URL(JUPITER_BUILD_ENDPOINT);url.search=new URLSearchParams({inputMint:request.inputMint,outputMint:request.outputMint,
      amount:request.amount,taker:request.user,slippageBps:String(request.slippageBps),mode:'fast',forJitoBundle:'true',transactionVersion:'0'}).toString();
    const headers=new Headers({accept:'application/json'});if(this.apiKey)headers.set('x-api-key',this.apiKey);
    const timeout=AbortSignal.timeout(this.timeoutMs),signal=request.signal?AbortSignal.any([request.signal,timeout]):timeout;
    try{
      await this.bucket.acquire(priority,signal);
      const response=await this.fetcher(url,{method:'GET',headers,redirect:'error',credentials:'omit',signal});
      if(response.redirected||response.type==='opaqueredirect'||response.url&&response.url!==url.href)return fail('JUPITER_BUILD_REDIRECT_REJECTED');
      if(response.status===429){this.bucket.rateLimited(response,priority);return fail('JUPITER_BUILD_RATE_LIMITED');}
      if(!response.ok||response.status!==200)return fail('JUPITER_BUILD_HTTP_ERROR');
      const contentType=response.headers.get('content-type');
      if(!contentType||!/^application\/json(?:\s*;|$)/i.test(contentType))return fail('JUPITER_BUILD_RESPONSE_INVALID');
      const text=await boundedText(response);let raw:unknown;
      try{raw=JSON.parse(text);}catch{return fail('JUPITER_BUILD_RESPONSE_INVALID');}
      return parseResponse(raw,request,this.maxComputePrice);
    }catch(error){if(error instanceof JupiterBuildError)throw error;return fail('JUPITER_BUILD_UNAVAILABLE');}
  }
}
