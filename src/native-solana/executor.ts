import {randomUUID} from 'node:crypto';
import {PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,TransactionInstruction} from '@solana/web3.js';
import {userVolumeAccumulatorPda as pumpUserVolumeAccumulatorPda} from '@pump-fun/pump-sdk';
import {userVolumeAccumulatorPda as pumpSwapUserVolumeAccumulatorPda} from '@pump-fun/pump-swap-sdk';
import bs58 from 'bs58';
import {NativeSigner} from './signer.js';
import {NativeJournal,type NativeJournalRecord,type NativeStatus} from './journal.js';
import {JitoSender,jitoTipInstruction} from './jito.js';
import type {NativeSwapPlan,NativeSwapRequest} from './pump.js';
import type {VerifiedSolanaTransaction} from '../controlled-test/types.js';
import {createNativeTiming,recordNativeStage,observeNativeTiming,publicNativeTiming,type NativeExecutionTiming,type NativeExecutionStage} from './timing.js';
export type {NativeExecutionTiming} from './timing.js';
export type NativeTradePlan=NativeSwapPlan;
export type NativePlanRequest=NativeSwapRequest;
export interface NativeExecuteRequest {
  intentId:string;orderId:string;wallet:string;mint:string;side:'buy'|'sell';amount:string;slippageBps:number;reason?:string;
  /** Starts non-authoritative stream preparation while read-only preflight runs.
   * The final beforeBroadcast guard still rechecks the resulting subscription. */
  onPlanReady?:(plan:Readonly<NativeSwapPlan>)=>void;
  beforeBroadcast?:(plan:Readonly<NativeSwapPlan>)=>Promise<void>;
}
export interface NativeExecutionResult {
  intentId:string;orderId:string;wallet:string;mint:string;side:'buy'|'sell';status:NativeStatus;
  signature?:string;inputAmount?:string;outputAmount?:string;actualNativeAmount?:string;networkFeeLamports?:string;tipLamports?:string;
  failureReason?:string;venue?:string;tokenDecimals?:number;slot?:number;checkedAt:string;subscriptionAccounts?:string[];
  trade?:VerifiedSolanaTransaction;
  provisional?:{trade:VerifiedSolanaTransaction;inputAmount:string;outputAmount:string;actualNativeAmount:string;networkFeeLamports:string;slot:number;checkedAt:string};
  timing?:NativeExecutionTiming;
}
export interface NativeExecutorOptions {
  rpcUrl:string;jitoUrl:string;keypairFile:string;wallet:string;journalPath:string;tipLamports:string;priorityFeeLamports:string;
  computeUnitLimit?:number;maxQuoteAgeMs?:number;plan:(request:NativeSwapRequest)=>Promise<NativeSwapPlan>;
  fetcher?:typeof fetch;now?:()=>Date;jitoPacingMs?:number;monotonicNow?:()=>number;
}
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',SOL='So11111111111111111111111111111111111111112';
const SYSTEM='11111111111111111111111111111111',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',TOKEN2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const DEX=new Set(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P','pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA']);
const PROGRAMS=new Set([...DEX,SYSTEM,TOKEN,TOKEN2022,'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL']);
const METHODS=new Set(['getGenesisHash','getLatestBlockhash','getBalance','getFeeForMessage','simulateTransaction','getSignatureStatuses','getTransaction','getBlockHeight']);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uint=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const atom=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d{0,19})$/.test(v)&&BigInt(v)<=(1n<<64n)-1n;
const pub=(v:unknown):v is string=>{try{return typeof v==='string'&&new PublicKey(v).toBase58()===v;}catch{return false;}};
const ident=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_:-]{1,200}$/.test(v);
const diagnostic=(e:unknown,fallback='NATIVE_EXECUTION_UNAVAILABLE')=>e instanceof Error&&/^(?:NATIVE|ENTRY|THIRD_ENTRY)_[A-Z0-9_]{1,90}$/.test(e.message)?e.message:fallback;
function fail(code:string):never {throw Error(code);}
/** One native intent, one signed transaction. No public RPC sends or automatic replacement signatures. */
export class NativeExecutor {
  private readonly journal:NativeJournal;private signer?:NativeSigner;private setupFailure?:string;
  private readonly jito:JitoSender;private readonly fetcher:typeof fetch;private readonly now:()=>Date;private readonly rpcUrl:string;
  private readonly compute:number;private readonly maxAge:number;private id=0;private stopping=false;private closed=false;
  private chainVerified=false;private chainWork?:Promise<void>;
  private warmState:'cold'|'warming'|'ready'|'failed'='cold';private warmFailure?:string;private warmWork?:Promise<void>;
  private readonly jobs=new Set<Promise<NativeExecutionResult>>();
  private monotonic():number {try{return (this.options.monotonicNow??(()=>performance.now()))();}catch{return NaN;}}
  private async stage<T>(r:NativeJournalRecord,name:NativeExecutionStage,work:()=>Promise<T>):Promise<T>{
    const start=this.monotonic();try{return await work();}finally{recordNativeStage(r.timing,name,start,this.monotonic());}
  }
  private stageSync<T>(r:NativeJournalRecord,name:NativeExecutionStage,work:()=>T):T{
    const start=this.monotonic();try{return work();}finally{recordNativeStage(r.timing,name,start,this.monotonic());}
  }
  constructor(private readonly options:NativeExecutorOptions){
    this.fetcher=options.fetcher??fetch;this.now=options.now??(()=>new Date());this.compute=options.computeUnitLimit??400000;this.maxAge=options.maxQuoteAgeMs??15000;
    try{const url=new URL(options.rpcUrl);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw Error();this.rpcUrl=url.href;}
    catch{throw Error('NATIVE_RPC_URL_INVALID');}
    if(!pub(options.wallet)||options.wallet===SYSTEM||!atom(options.tipLamports)||BigInt(options.tipLamports)<1000n||BigInt(options.tipLamports)>10000000n||
      !atom(options.priorityFeeLamports)||BigInt(options.priorityFeeLamports)>10000000n||!uint(this.compute)||this.compute<10000||this.compute>1400000||
      !uint(this.maxAge)||this.maxAge<1000||this.maxAge>15000)throw Error('NATIVE_EXECUTOR_OPTIONS_INVALID');
    this.jito=new JitoSender(options.jitoUrl,this.fetcher,options.jitoPacingMs);this.journal=new NativeJournal(options.journalPath);
    try{this.signer=new NativeSigner(options.keypairFile,options.wallet);}catch{this.setupFailure='NATIVE_SIGNER_UNAVAILABLE';}
  }
  readiness():{ready:boolean;reason?:string}{return this.stopping||this.closed?{ready:false,reason:'NATIVE_EXECUTOR_STOPPED'}:
    this.setupFailure?{ready:false,reason:this.setupFailure}:this.warmState==='warming'?{ready:false,reason:'NATIVE_EXECUTOR_WARMING'}:
    this.warmState==='failed'?{ready:false,reason:this.warmFailure??'NATIVE_EXECUTOR_WARMUP_FAILED'}:{ready:true};}
  /** Runtime startup calls this before accepting entries. It performs only
   * read-only chain/Jito preparation and waits out Jito's official pacing window. */
  warmup():Promise<void>{
    if(this.warmState==='ready')return Promise.resolve();
    if(this.warmWork)return this.warmWork;
    this.warmState='warming';delete this.warmFailure;
    const work=Promise.all([this.ensureChain(),this.jito.warmup()]).then(()=>{this.warmState='ready';},error=>{
      this.warmState='failed';this.warmFailure=diagnostic(error,'NATIVE_EXECUTOR_WARMUP_FAILED');throw error;
    }).finally(()=>{if(this.warmWork===work)this.warmWork=undefined;});
    this.warmWork=work;return work;
  }
  private view(r:NativeJournalRecord):NativeExecutionResult {
    const timing=publicNativeTiming(r.timing);
    return {intentId:r.intentId,orderId:r.orderId,wallet:r.wallet,mint:r.mint,side:r.side,status:r.status,checkedAt:r.updatedAt,
      ...(r.signature?{signature:r.signature}:{}),...(r.inputAmount?{inputAmount:r.inputAmount}:{}),...(r.outputAmount?{outputAmount:r.outputAmount}:{}),
      ...(r.actualNativeAmount?{actualNativeAmount:r.actualNativeAmount}:{}),...(r.networkFeeLamports?{networkFeeLamports:r.networkFeeLamports}:{}),
      ...(r.tipLamports?{tipLamports:r.tipLamports}:{}),...(r.failureReason?{failureReason:r.failureReason}:{}),...(r.venue?{venue:r.venue}:{}),
      ...(r.tokenDecimals!==undefined?{tokenDecimals:r.tokenDecimals}:{}),...(r.slot!==undefined?{slot:r.slot}:{}),
      ...(r.subscriptionAccounts?{subscriptionAccounts:[...r.subscriptionAccounts]}:{}),...(r.trade?{trade:structuredClone(r.trade) as VerifiedSolanaTransaction}:{}),
      ...(r.provisional?{provisional:structuredClone(r.provisional) as NativeExecutionResult['provisional']}:{}),...(timing?{timing}:{})};
  }
  get(intentId:string):NativeExecutionResult|undefined {const record=this.journal.get(intentId);return record?this.view(record):undefined;}
  listPending():NativeExecutionResult[]{return this.journal.listPending().map(r=>this.view(r));}
  private track(p:Promise<NativeExecutionResult>):Promise<NativeExecutionResult>{this.jobs.add(p);void p.finally(()=>this.jobs.delete(p)).catch(()=>{});return p;}
  execute(request:NativeExecuteRequest):Promise<NativeExecutionResult>{const copied={...request};return this.track(this.run(copied));}
  reconcile(intentId:string):Promise<NativeExecutionResult>{return this.track(this.recover(intentId));}
  private async rpc(method:string,params:unknown[]):Promise<unknown>{
    if(!METHODS.has(method))fail('NATIVE_RPC_METHOD_DENIED');const id=++this.id;
    try{const response=await this.fetcher(this.rpcUrl,{method:'POST',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(12000),
      headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
      if(!response.ok||Number(response.headers.get('content-length'))>2000000)fail('NATIVE_RPC_UNAVAILABLE');
      const text=await response.text();if(text.length>2000000)fail('NATIVE_RPC_RESPONSE_INVALID');const raw:unknown=JSON.parse(text);
      if(!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==id||raw.error!==undefined||!Object.hasOwn(raw,'result'))fail('NATIVE_RPC_RESPONSE_INVALID');return raw.result;
    }catch(error){fail(diagnostic(error,'NATIVE_RPC_UNAVAILABLE'));}
  }
  private ensureChain():Promise<void>{
    if(this.chainVerified)return Promise.resolve();
    if(this.chainWork)return this.chainWork;
    const work=(async()=>{if(await this.rpc('getGenesisHash',[])!==GENESIS)fail('NATIVE_CHAIN_MISMATCH');this.chainVerified=true;})()
      .finally(()=>{if(this.chainWork===work)this.chainWork=undefined;});
    this.chainWork=work;return work;
  }
  private readonlyPlan(plan:NativeSwapPlan):Readonly<NativeSwapPlan>{
    return Object.freeze({...plan,subscriptionAccounts:[...plan.subscriptionAccounts],instructions:plan.instructions.map(ix=>
      new TransactionInstruction({programId:new PublicKey(ix.programId.toBytes()),data:Buffer.from(ix.data),
        keys:ix.keys.map(key=>({...key,pubkey:new PublicKey(key.pubkey.toBytes())}))}))});
  }
  private valid(request:NativeExecuteRequest):void{
    if(!ident(request.intentId)||!ident(request.orderId)||request.wallet!==this.options.wallet||!pub(request.mint)||request.mint===SOL||request.mint===SYSTEM||
      !['buy','sell'].includes(request.side)||!atom(request.amount)||request.amount==='0'||!uint(request.slippageBps)||request.slippageBps>5000)
      fail('NATIVE_REQUEST_INVALID');
  }
  private validatePlan(plan:NativeSwapPlan,r:NativeJournalRecord):void{
    const at=Date.parse(plan.quotedAt),now=this.now().getTime();
    if(plan.mint!==r.mint||plan.side!==r.side||plan.inputAmount!==r.amount||!atom(plan.expectedOutputAmount)||plan.expectedOutputAmount==='0'||
      !atom(plan.minimumOutputAmount)||plan.minimumOutputAmount==='0'||BigInt(plan.minimumOutputAmount)>BigInt(plan.expectedOutputAmount)||
      BigInt(plan.minimumOutputAmount)<BigInt(plan.expectedOutputAmount)*BigInt(10000-r.slippageBps)/10000n||
      !uint(plan.tokenDecimals)||plan.tokenDecimals>255||!Number.isFinite(at)||at>now||now-at>this.maxAge||
      !Array.isArray(plan.instructions)||!plan.instructions.length||plan.instructions.length>20||
      !Array.isArray(plan.subscriptionAccounts)||plan.subscriptionAccounts.length>20||plan.subscriptionAccounts.some(a=>!pub(a)))fail('NATIVE_PLAN_INVALID');
    let dex=0;
    for(const ix of plan.instructions){
      if(!ix||!PROGRAMS.has(ix.programId?.toBase58())||!Buffer.isBuffer(ix.data)||!Array.isArray(ix.keys)||
        ix.keys.some(k=>!pub(k.pubkey?.toBase58())||k.isSigner&&k.pubkey.toBase58()!==r.wallet))fail('NATIVE_PLAN_INSTRUCTIONS_INVALID');
      if(DEX.has(ix.programId.toBase58()))dex++;
    }
    if(!dex)fail('NATIVE_PLAN_INSTRUCTIONS_INVALID');
  }
  private async run(request:NativeExecuteRequest):Promise<NativeExecutionResult>{
    const owner=randomUUID();let r:NativeJournalRecord|undefined,broadcastStarted=false,turn:Awaited<ReturnType<JitoSender['reserveBroadcast']>>|undefined;
    try{
      this.valid(request);const ready=this.readiness();if(!ready.ready)fail(ready.reason!);
      const stamp=this.now().toISOString(),reserved=this.journal.reserve({...request,onPlanReady:undefined,beforeBroadcast:undefined,reason:undefined,status:'prepared',createdAt:stamp,updatedAt:stamp,
        timing:createNativeTiming(stamp)} as NativeJournalRecord,owner,this.now().getTime());
      r=reserved.record;if(!reserved.created)return this.view(r);
      // Stable preparation may run before the Jito pacing lane. Anything whose
      // freshness authorizes the transaction (route quote and blockhash) is
      // intentionally created only after this intent owns that lane. Otherwise
      // a burst of exits can prebuild twenty plans and let the later ones expire
      // while they wait behind the endpoint's one-request-per-second limit.
      const [,tip]=await Promise.all([this.stage(r,'chainCheck',()=>this.ensureChain()),
        this.stage(r,'tipAccount',()=>this.jito.tipAccount())]);
      turn=await this.stage(r,'broadcastQueue',()=>this.jito.reserveBroadcast());
      if(this.stopping)fail('NATIVE_EXECUTOR_STOPPED');
      const [supplied,latest]=await Promise.all([
        this.stage(r,'plan',()=>this.options.plan({wallet:r!.wallet,mint:r!.mint,side:r!.side,amount:r!.amount,slippageBps:r!.slippageBps})),
        this.stage(r,'blockhash',()=>this.rpc('getLatestBlockhash',[{commitment:'confirmed'}])),
      ]);this.validatePlan(supplied,r);
      const plan:NativeSwapPlan={...supplied,subscriptionAccounts:[...supplied.subscriptionAccounts],instructions:supplied.instructions.map(ix=>
        new TransactionInstruction({programId:new PublicKey(ix.programId.toBytes()),data:Buffer.from(ix.data),
          keys:ix.keys.map(key=>({...key,pubkey:new PublicKey(key.pubkey.toBytes())}))}))};
      r.venue=plan.venue;r.tokenDecimals=plan.tokenDecimals;r.subscriptionAccounts=[...plan.subscriptionAccounts];r.quotedAt=plan.quotedAt;
      r.expectedOutputAmount=plan.expectedOutputAmount;r.minimumOutputAmount=plan.minimumOutputAmount;
      request.onPlanReady?.(this.readonlyPlan(plan));
      if(!object(latest)||!object(latest.context)||!uint(latest.context.slot)||!object(latest.value)||!pub(latest.value.blockhash)||!uint(latest.value.lastValidBlockHeight))fail('NATIVE_BLOCKHASH_INVALID');
      const blockhash=latest.value.blockhash;
      const {message,tx,unsigned}=this.stageSync(r,'compile',()=>{
        const micro=BigInt(this.options.priorityFeeLamports)*1000000n/BigInt(this.compute);
        const ixs:TransactionInstruction[]=[ComputeBudgetProgram.setComputeUnitLimit({units:this.compute}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:micro}),
          ...plan.instructions,jitoTipInstruction(r!.wallet,tip,this.options.tipLamports)];
        const message=new TransactionMessage({payerKey:new PublicKey(r!.wallet),recentBlockhash:blockhash,instructions:ixs}).compileToV0Message();
        const tx=new VersionedTransaction(message),unsigned=tx.serialize();if(unsigned.length>1232)fail('NATIVE_TRANSACTION_TOO_LARGE');
        return {message,tx,unsigned};
      });
      // Public RPC sees zero-signature simulation bytes only; it cannot broadcast an executable trade.
      const contextSlot=latest.context.slot;
      const [fee,balance,simulation]=await Promise.all([
        this.stage(r,'feeCheck',()=>this.rpc('getFeeForMessage',[Buffer.from(message.serialize()).toString('base64'),{commitment:'confirmed'}])),
        this.stage(r,'balanceCheck',()=>this.rpc('getBalance',[r!.wallet,{commitment:'confirmed',minContextSlot:contextSlot}])),
        this.stage(r,'simulation',()=>this.rpc('simulateTransaction',[Buffer.from(unsigned).toString('base64'),
          {encoding:'base64',sigVerify:false,commitment:'confirmed',minContextSlot:contextSlot}]))]);
      if(!object(fee)||!uint(fee.value)||BigInt(fee.value)>BigInt(this.options.priorityFeeLamports)+10000n)fail('NATIVE_FEE_INVALID');
      if(!object(balance)||!object(balance.context)||!uint(balance.context.slot)||balance.context.slot<latest.context.slot||!uint(balance.value)||
        BigInt(balance.value)<(r.side==='buy'?BigInt(r.amount):0n)+BigInt(fee.value)+BigInt(this.options.tipLamports))fail('NATIVE_FEE_BALANCE_LOW');
      if(!object(simulation)||!object(simulation.context)||!uint(simulation.context.slot)||simulation.context.slot<latest.context.slot||!object(simulation.value)||simulation.value.err!==null)
        fail('NATIVE_SIMULATION_FAILED');
      if(this.stopping)fail('NATIVE_EXECUTOR_STOPPED');this.validatePlan(plan,r);
      // The final guard may inspect the executable quote without mutating its compiled plan.
      await this.stage(r,'finalGuard',async()=>{await request.beforeBroadcast?.(this.readonlyPlan(plan));});
      // Last asynchronous precondition has completed. Commit signed bytes before the only send.
      if(this.stopping)fail('NATIVE_EXECUTOR_STOPPED');this.validatePlan(plan,r);
      const encoded=this.stageSync(r,'sign',()=>{this.signer!.sign(tx);return Buffer.from(tx.serialize()).toString('base64');});
      Object.assign(r,{signature:bs58.encode(tx.signatures[0]),rawTransaction:encoded,blockhash:latest.value.blockhash,
        lastValidBlockHeight:latest.value.lastValidBlockHeight,contextSlot:latest.context.slot,tipLamports:this.options.tipLamports,tipAccount:tip,
        priorityFeeLamports:this.options.priorityFeeLamports,computeUnitLimit:this.compute,armed:true,status:'unknown',failureReason:'NATIVE_BROADCAST_UNCERTAIN',
        lastBroadcastAt:this.now().toISOString(),broadcastCount:1});
      this.stageSync(r,'journalBeforeSend',()=>this.journal.save(r!,owner,this.now().getTime()));broadcastStarted=true;
      observeNativeTiming(r.timing,'broadcast',this.now());
      await this.stage(r,'broadcastRpc',()=>turn!.broadcast(encoded,r!.signature!));observeNativeTiming(r.timing,'acknowledged',this.now());
      r.status='submitted';delete r.failureReason;this.journal.save(r,owner,this.now().getTime());return this.view(r);
    }catch(error){
      if(r){r.status=broadcastStarted||r.rawTransaction?'unknown':'failed';r.failureReason=diagnostic(error);
        try{this.journal.save(r,owner,this.now().getTime());}catch{}return this.view(this.journal.get(r.intentId)??r);}
      return {intentId:request.intentId,orderId:request.orderId,wallet:request.wallet,mint:request.mint,side:request.side,status:'failed',failureReason:diagnostic(error),checkedAt:this.now().toISOString()};
    }finally{turn?.release();if(r)this.journal.release(r.intentId,owner);}
  }
  private async recover(intentId:string):Promise<NativeExecutionResult>{
    let r=this.journal.get(intentId);if(!r)fail('NATIVE_INTENT_MISSING');
    if(['confirmed','failed'].includes(r.status)||this.stopping)return this.view(r);const owner=randomUUID();
    if(!this.journal.acquire(intentId,owner,this.now().getTime()))return this.view(r);
    try{
      r=this.journal.get(intentId)!;
      if(r.wallet!==this.options.wallet)fail('NATIVE_RECOVERY_WALLET_MISMATCH');
      if(!r.rawTransaction||!r.signature||r.armed!==true){r.status='failed';r.failureReason='NATIVE_INTERRUPTED_BEFORE_BROADCAST';this.journal.save(r,owner,this.now().getTime());return this.view(r);}
      await this.ensureChain();
      const raw=await this.rpc('getSignatureStatuses',[[r.signature],{searchTransactionHistory:true}]);
      if(!object(raw)||!object(raw.context)||!uint(raw.context.slot)||!Array.isArray(raw.value)||raw.value.length!==1)fail('NATIVE_STATUS_UNAVAILABLE');
      const status=raw.value[0];
      if(status!==null){
        if(!object(status)||!uint(status.slot)||status.slot>raw.context.slot||!Object.hasOwn(status,'err')||
          status.err!==null&&!object(status.err)&&typeof status.err!=='string'||
          !['processed','confirmed','finalized'].includes(String(status.confirmationStatus)))fail('NATIVE_STATUS_UNAVAILABLE');
        if(status.confirmationStatus==='finalized'){
          if(status.err!==null){r.status='failed';r.failureReason='NATIVE_TRANSACTION_FAILED';delete r.provisional;}
          else {
            const tx=await this.rpc('getTransaction',[r.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:1}]);
            const observed=this.now(),fact=verifyNativeFill(tx,r,status.slot,observed);
            observeNativeTiming(r.timing,'confirmed',observed);observeNativeTiming(r.timing,'finalized',observed);
            Object.assign(r,fact,{status:'confirmed'});delete r.failureReason;delete r.provisional;
          }
        }else {
          r.status='submitted';r.failureReason='NATIVE_FINALITY_PENDING';
          if(status.confirmationStatus==='confirmed'&&status.err===null){
            const tx=await this.rpc('getTransaction',[r.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:1}]);
            const observed=this.now(),fact=verifyNativeFill(tx,r,status.slot,observed);
            observeNativeTiming(r.timing,'confirmed',observed);r.provisional={...fact,checkedAt:observed.toISOString()};
          }
        }
      }else{
        const height=await this.rpc('getBlockHeight',[{commitment:'finalized',minContextSlot:r.contextSlot}]);if(!uint(height)||!uint(r.lastValidBlockHeight))fail('NATIVE_EXPIRY_UNAVAILABLE');
        if(height>r.lastValidBlockHeight){
          // Query again after the finalized expiry observation; null before expiry is not non-execution proof.
          const after=await this.rpc('getSignatureStatuses',[[r.signature],{searchTransactionHistory:true}]);
          if(!object(after)||!object(after.context)||!uint(after.context.slot)||after.context.slot<raw.context.slot||!Array.isArray(after.value)||after.value.length!==1||after.value[0]!==null)
            fail('NATIVE_EXPIRY_UNVERIFIED');
          r.status='failed';r.failureReason='NATIVE_TRANSACTION_EXPIRED';delete r.provisional;
        }else if(!this.stopping&&this.now().getTime()-Date.parse(r.lastBroadcastAt??r.createdAt)>=2000){
          r.lastBroadcastAt=this.now().toISOString();r.broadcastCount=(r.broadcastCount??0)+1;r.status='unknown';r.failureReason='NATIVE_BROADCAST_UNCERTAIN';
          this.journal.save(r,owner,this.now().getTime());await this.jito.broadcast(r.rawTransaction,r.signature);
          // A recovered acknowledgement is still observable, but a missing original
          // send timestamp must not be reconstructed from the retry or journal time.
          observeNativeTiming(r.timing,'acknowledged',this.now());r.status='submitted';r.failureReason='NATIVE_FINALITY_PENDING';
        }
      }
      this.journal.save(r,owner,this.now().getTime());return this.view(r);
    }catch(error){r.status='unknown';r.failureReason=diagnostic(error);try{this.journal.save(r,owner,this.now().getTime());}catch{}return this.view(r);}
    finally{this.journal.release(intentId,owner);}
  }
  async stop(){this.stopping=true;await Promise.allSettled([...this.jobs]);}
  close(){if(this.jobs.size)throw Error('NATIVE_EXECUTOR_BUSY');if(!this.closed){this.closed=true;this.journal.close();}}
}

/** Account-owned lamport accounting cancels ATA rent, WSOL wrapping and the
 * official Pump/PumpSwap per-user volume PDA rent before calculating swap
 * consideration. The PDA exception is deliberately derived from the SDK and
 * only applies to its first creation; arbitrary new program accounts remain
 * part of the wallet debit. */
export function verifyNativeFill(raw:unknown,r:NativeJournalRecord,slot:number,now:Date):Pick<NativeJournalRecord,'inputAmount'|'outputAmount'|'actualNativeAmount'|'networkFeeLamports'|'slot'|'trade'> {
  if(!uint(slot)||r.contextSlot!==undefined&&slot<r.contextSlot||!object(raw)||raw.slot!==slot||raw.version!==undefined&&!['legacy',0,1].includes(raw.version as any)||!object(raw.meta)||raw.meta.err!==null||
    !object(raw.transaction)||!Array.isArray(raw.transaction.signatures)||raw.transaction.signatures[0]!==r.signature||!object(raw.transaction.message)||
    !Array.isArray(raw.transaction.message.accountKeys))fail('NATIVE_FILL_UNVERIFIED');
  const keys=raw.transaction.message.accountKeys,meta=raw.meta;
  if(!keys.length||keys.some(k=>!object(k)||!pub(k.pubkey)||typeof k.signer!=='boolean'||typeof k.writable!=='boolean')||
    new Set(keys.map(k=>k.pubkey)).size!==keys.length||keys[0].pubkey!==r.wallet||keys[0].signer!==true||keys[0].writable!==true||
    !uint(meta.fee)||!Array.isArray(meta.preBalances)||!Array.isArray(meta.postBalances)||meta.preBalances.length!==keys.length||
    meta.postBalances.length!==keys.length||!meta.preBalances.every(uint)||!meta.postBalances.every(uint)||!Array.isArray(meta.preTokenBalances)||!Array.isArray(meta.postTokenBalances))fail('NATIVE_FILL_UNVERIFIED');
  const owned=new Set<number>([0]),mintBefore=new Map<number,bigint>(),mintAfter=new Map<number,bigint>(),owners=new Map<number,string>();
  for(const [rows,target] of [[meta.preTokenBalances,mintBefore],[meta.postTokenBalances,mintAfter]] as const){
    const seen=new Set<number>();
    for(const row of rows){if(!object(row)||!uint(row.accountIndex)||row.accountIndex>=keys.length||seen.has(row.accountIndex)||!pub(row.mint)||!pub(row.owner)||
        ![TOKEN,TOKEN2022].includes(String(row.programId))||!object(row.uiTokenAmount)||!atom(row.uiTokenAmount.amount)||!uint(row.uiTokenAmount.decimals)||row.uiTokenAmount.decimals>255)fail('NATIVE_FILL_UNVERIFIED');
      seen.add(row.accountIndex);const old=owners.get(row.accountIndex);if(old!==undefined&&old!==row.owner)fail('NATIVE_FILL_OWNER_CHANGED');owners.set(row.accountIndex,row.owner);
      if(row.owner===r.wallet){owned.add(row.accountIndex);if(row.mint===r.mint){if(row.uiTokenAmount.decimals!==r.tokenDecimals)fail('NATIVE_FILL_DECIMALS_MISMATCH');target.set(row.accountIndex,BigInt(row.uiTokenAmount.amount));}}
    }
  }
  const volumePda=r.venue==='pump'?pumpUserVolumeAccumulatorPda(new PublicKey(r.wallet)):
    r.venue==='pumpswap'?pumpSwapUserVolumeAccumulatorPda(new PublicKey(r.wallet)):undefined;
  if(volumePda){
    const index=keys.findIndex(row=>row.pubkey===volumePda.toBase58());
    if(index>=0&&meta.preBalances[index]===0&&meta.postBalances[index]>0)owned.add(index);
  }
  const before=[...mintBefore.values()].reduce((a,b)=>a+b,0n),after=[...mintAfter.values()].reduce((a,b)=>a+b,0n),tokenDelta=after-before;
  // Newly created and closed same-transaction token accounts have zero pre/post lamports; their ownership cannot alter this sum.
  let economicDelta=0n;for(const index of owned)economicDelta+=BigInt(meta.postBalances[index])-BigInt(meta.preBalances[index]);
  if(!atom(r.tipLamports)||!atom(r.minimumOutputAmount)||!atom(r.priorityFeeLamports)||BigInt(meta.fee)>BigInt(r.priorityFeeLamports)+10000n)fail('NATIVE_FILL_FEE_UNVERIFIED');
  const nativeTrade=economicDelta+BigInt(meta.fee)+BigInt(r.tipLamports);
  const nativeAmount=r.side==='buy'?-nativeTrade:nativeTrade,tokenAmount=r.side==='buy'?tokenDelta:-tokenDelta;
  if(nativeAmount<=0n||tokenAmount<=0n||r.side==='buy'&&(nativeAmount>BigInt(r.amount)||tokenAmount<BigInt(r.minimumOutputAmount))||
    r.side==='sell'&&(tokenAmount!==BigInt(r.amount)||nativeAmount<BigInt(r.minimumOutputAmount)))fail('NATIVE_FILL_AMOUNTS_UNVERIFIED');
  const nativeDelta=BigInt(meta.postBalances[0])-BigInt(meta.preBalances[0]);
  const trade:VerifiedSolanaTransaction={signature:r.signature!,wallet:r.wallet,mint:r.mint,side:r.side,slot,tokenDelta:tokenDelta.toString(),nativeDelta:nativeDelta.toString(),
    feeLamports:String(meta.fee),preTokenAmount:before.toString(),postTokenAmount:after.toString(),preNativeLamports:String(meta.preBalances[0]),postNativeLamports:String(meta.postBalances[0]),
    decimals:r.tokenDecimals!,checkedAt:now.toISOString()};
  return {inputAmount:(r.side==='buy'?nativeAmount:tokenAmount).toString(),outputAmount:(r.side==='buy'?tokenAmount:nativeAmount).toString(),
    actualNativeAmount:nativeAmount.toString(),networkFeeLamports:String(meta.fee),slot,trade};
}
