import {createHash, randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import type {Config} from './config.js';
import type {EntryResult} from './entry.js';
import {OrderStore, type ExitTracking, type FundingSnapshot, type OpeningOrder} from './orders.js';
import {buildExitConditions,isCurrentExitPolicy,parseExitPolicy} from './exit-policy.js';
import {GmgnTestClient, GmgnTestError} from './controlled-test/gmgn.js';
import {readNativeBalance, nativeBalanceCoversOrder, NATIVE_INPUT_TOKENS} from './native-balance.js';
import {inspectTestQuote} from './trade-interface-check.js';
import type {ThirdSignalCandidate} from './third-signal-strategy.js';
import {assessEntryHolderRiskValues,unavailableEntryHolderRisk,normalizeStoredEntryHolderRisk,
  ENTRY_HOLDER_RISK_MAX_AGE_MS,type EntryHolderRiskValues,type EntryHolderRiskAssessment} from './entry-holder-risk.js';

const SOL=NATIVE_INPUT_TOKENS.solana, MAX_AGE_MS=120_000, QUOTE_MAX_AGE_MS=15_000;
const FUNDING_COVERAGE_BUDGET_MS=6_000,FUNDING_REFRESH_BUDGET_MS=4_000,FUNDING_COVERAGE_CONCURRENCY=4;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
const atomic=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v)&&BigInt(v)<=(1n<<64n)-1n;
function address(v:unknown):v is string {try {return typeof v==='string'&&bs58.decode(v).length===32&&bs58.encode(bs58.decode(v))===v;}catch{return false;}}
function hash(v:unknown):v is string {try{return typeof v==='string'&&bs58.decode(v).length===64;}catch{return false;}}
class EntryFailure extends Error {constructor(readonly reason:string){super(reason);}}
function fail(reason:string):never {throw new EntryFailure(reason);}
const reason=(error:unknown)=>error instanceof EntryFailure||error instanceof GmgnTestError?error.reason:'THIRD_ENTRY_REQUEST_FAILED';
export interface ThirdSignalEntryOptions {
  /** Must be enabled by runtime policy; constructing the controller defaults to no execution. */
  enabled?:boolean;
  /** Validates the currently running owner-started run and its exact committed candidate. */
  isActive:(candidate:Readonly<ThirdSignalCandidate>)=>boolean;
  fetcher?:typeof fetch;
  now?:()=>Date;
  /** Shares the existing credential's pacing with all other GMGN users. */
  scheduleRequest?:<T>(weight:number,execute:()=>Promise<T>)=>Promise<T>;
  recordRateLimit?:(headers:Headers,payload?:unknown)=>void;
  /** Trusted normalized holding ratios, fetched through the shared GMGN read client. */
  readHolderRisk?:(address:string)=>Promise<EntryHolderRiskValues>;
  /** Native executor owns durable signed transactions; this guard is called immediately before broadcasting. */
  native?:{readiness:()=>{ready:boolean;reason?:string};
    execute:(order:OpeningOrder,beforeBroadcast:()=>Promise<void>)=>Promise<OpeningOrder>};
  /** Defense in depth around all pre-reservation and submitted entry work. */
  maxConcurrent?:number;
}
interface Submission {
  candidate:Readonly<ThirdSignalCandidate>;orderId:string;clientId:string;bodyText:string;quotedAt:number;
  attempted:boolean;failureReason?:string;
  holderRisk:EntryHolderRiskAssessment;
  funding:FundingSnapshot;
}

/** Internal owner-started third-notification route. It does not create or bypass research Reports. */
export class ThirdSignalEntryController {
  private readonly now:()=>Date;
  private readonly fetcher:typeof fetch;
  private client?:GmgnTestClient;
  private readonly submissions=new Map<string,Submission>();
  private readonly jobs=new Set<Promise<EntryResult>>();
  private readonly maxJobs:number;
  private admissions=0;
  private stopping=false;
  constructor(private readonly config:Config,private readonly orders:OrderStore,private readonly options:ThirdSignalEntryOptions) {
    this.now=options.now??(()=>new Date());this.fetcher=options.fetcher??fetch;
    this.maxJobs=options.maxConcurrent??config.entryMaxOpen;
    if(!Number.isSafeInteger(this.maxJobs)||this.maxJobs<1||this.maxJobs>100)throw Error('THIRD_ENTRY_CONCURRENCY_INVALID');
  }
  readiness():{ready:boolean;reason?:string} {
    try {
      if(this.stopping||this.options.enabled!==true)fail('THIRD_ENTRY_DISABLED');
      if(!this.config.scannerChains.includes('solana'))fail('SIGNAL_CHAIN_DISABLED');
      if(!this.options.readHolderRisk)fail('ENTRY_HOLDER_RISK_PROVIDER_MISSING');
      this.configuration();
      if(this.config.solanaExecutionProvider==='pump_native'){
        const ready=this.options.native?.readiness();if(!ready?.ready)fail(ready?.reason??'NATIVE_EXECUTOR_UNAVAILABLE');
      }else this.transport();return {ready:true};
    }catch(error){return {ready:false,reason:reason(error)};}
  }
  consider(input:ThirdSignalCandidate):Promise<EntryResult> {
    let candidate:Readonly<ThirdSignalCandidate>,wallet:string,exit:ExitTracking;
    try{candidate=Object.freeze(structuredClone(input));this.active(candidate);({wallet,exit}=this.configuration());
      const readiness=this.readiness();if(!readiness.ready)fail(readiness.reason??'THIRD_ENTRY_DISABLED');}
    catch(error){return Promise.resolve({status:'blocked',reason:reason(error)});}
    if(this.jobs.size>=this.maxJobs)return Promise.resolve({status:'blocked',reason:'THIRD_ENTRY_BUSY'});
    let capacity:ReturnType<OrderStore['openingCapacity']>;
    try {capacity=this.orders.openingCapacity('live',this.config.entryMaxOpen,this.now(),true,
      {chain:'solana',address:candidate.address,preventReentry:true});}
    catch(error){return Promise.resolve({status:'blocked',reason:reason(error)});}
    if(capacity.reason)return Promise.resolve({status:'blocked',reason:capacity.reason});
    // An admitted task has not written its prepared row yet. Counting it beside
    // durable occupied rows prevents bursts from all doing remote RPC work first.
    if(this.admissions>=capacity.available)return Promise.resolve({status:'blocked',reason:'OPENING_LIMIT_REACHED'});
    this.admissions++;let released=false;
    const releaseAdmission=()=>{if(!released){released=true;this.admissions--;}};
    const job=this.considerInternal(candidate,wallet,exit,releaseAdmission);this.jobs.add(job);
    void job.finally(()=>this.jobs.delete(job)).catch(()=>{});return job;
  }
  /** Shutdown prevents new submissions, then waits for any already-sent response to be journaled. */
  async stop():Promise<void> {this.stopping=true;await Promise.allSettled([...this.jobs]);}
  /** Startup cleanup only: prepared records have never reached the signed POST transport. */
  recoverPrepared():number {
    let changed=0,offset=0;
    for(;;){const page=this.orders.page({limit:100,offset});
      for(const order of page.items)if(order.mode==='live'&&order.status==='prepared'&&order.details.executionStrategy==='third_signal_v1') {
        if(this.orders.update(order.id,['prepared'],{status:'failed',failureReason:'THIRD_ENTRY_INTERRUPTED_BEFORE_SUBMIT'},this.now()))changed++;
      }
      if(!page.hasMore)break;offset+=page.limit;
    }
    return changed;
  }
  private active(candidate:Readonly<ThirdSignalCandidate>):void {
    if(this.stopping||this.options.enabled!==true)fail('THIRD_ENTRY_DISABLED');
    const c=candidate as unknown as Record<string,unknown>;
    if(c.mode!=='live'||c.executionEnabled!==true||c.phase!=='live_candidate'||
      !['debot','ave'].includes(String(c.source))||c.chain!=='solana'||c.count!==3||
      !address(c.address)||c.address===SOL||!identifier(c.id)||!identifier(c.runId)||!identifier(c.windowId)||
      typeof c.eventId!=='string'||!c.eventId||c.eventId.length>512||/[\x00-\x1f\x7f]/.test(c.eventId)||
      typeof c.marketCapUsd!=='number'||!Number.isFinite(c.marketCapUsd)||c.marketCapUsd<=0||c.marketCapUsd>100000)
      fail('THIRD_ENTRY_CANDIDATE_INVALID');
    if(!this.config.scannerChains.includes('solana'))fail('SIGNAL_CHAIN_DISABLED');
    const now=this.now().getTime(),occurred=Date.parse(String(c.occurredAt)),received=Date.parse(String(c.receivedAt)),created=Date.parse(String(c.createdAt));
    if(![now,occurred,received,created].every(Number.isFinite)||occurred>received||received>created||created>now||
      now-occurred>MAX_AGE_MS||now-received>MAX_AGE_MS||now-created>MAX_AGE_MS)fail('THIRD_ENTRY_CANDIDATE_EXPIRED');
    let active=false;try{active=this.options.isActive(candidate)===true;}catch{}
    if(!active)fail('THIRD_ENTRY_RUN_STOPPED');
  }
  private configuration():{wallet:string;exit:ExitTracking} {
    const wallet=this.config.entryWallets.solana;
    if(!this.config.gmgnApiKey||!this.config.gmgnPrivateKey||!this.config.rpc.solana||!wallet)
      fail('ENTRY_CONFIG_MISSING');
    if(!address(wallet)||wallet==='11111111111111111111111111111111'||this.config.entryInputTokens.solana!==SOL||
      this.config.entryBalanceBps?.solana!==300||!Number.isInteger(this.config.entrySlippagePct)||this.config.entrySlippagePct<0||
      this.config.entrySlippagePct>50||!Number.isInteger(this.config.entryMaxOpen)||this.config.entryMaxOpen<1||
      !/^0\.\d{1,9}$/.test(this.config.entryPriorityFeeSolana)||!/^0\.\d{1,9}$/.test(this.config.entryTipFeeSolana)||
      Number(this.config.entryPriorityFeeSolana)<0.00001||Number(this.config.entryPriorityFeeSolana)>0.01||
      Number(this.config.entryTipFeeSolana)<0.00001||Number(this.config.entryTipFeeSolana)>0.01)
      fail('ENTRY_CONFIG_INVALID');
    let policy;try{policy=parseExitPolicy(this.config.exitPolicy);}catch{fail('EXIT_POLICY_INVALID');}
    if(!policy)fail('EXIT_POLICY_REQUIRED');
    if(!isCurrentExitPolicy(policy))fail('THIRD_ENTRY_EXIT_POLICY_MISMATCH');
    return {wallet,exit:{policy,state:'awaiting_swap',reasons:[],checkedAt:this.now().toISOString(),positionClosed:false}};
  }
  private transport():GmgnTestClient {
    if(this.config.solanaExecutionProvider==='pump_native')fail('NATIVE_GMGN_EXECUTION_DISABLED');
    if(!this.client)this.client=new GmgnTestClient({apiKey:this.config.gmgnApiKey!,privateKeyPem:this.config.gmgnPrivateKey!.replace(/\\n/g,'\n'),
      minIntervalMs:0,fetcher:async(input,init)=>{
        const url=new URL(input instanceof Request?input.url:String(input)),method=(init?.method??'GET').toUpperCase();
        if(url.origin!=='https://openapi.gmgn.ai'||url.username||url.password||
          !(method==='GET'&&url.pathname==='/v1/trade/quote'||method==='POST'&&url.pathname==='/v1/trade/swap'))fail('THIRD_ENTRY_TRANSPORT_DENIED');
        const perform=async()=>{
          if(init?.signal?.aborted)fail('THIRD_ENTRY_REQUEST_ABORTED');
          if(method==='POST'){
            const submission=this.submissions.get(url.searchParams.get('client_id')??'');
            if(!submission||submission.attempted||init?.body!==submission.bodyText)fail('THIRD_ENTRY_SUBMISSION_DENIED');
            try {
              this.active(submission.candidate);
              const order=this.orders.get(submission.orderId);if(!order||order.status!=='prepared')fail('ENTRY_ALREADY_HANDLED');
              this.requireHolderRisk(this.orders.get(order.id)??order,submission.holderRisk);
              const latest=await this.refreshFundingSnapshot(order.wallet,submission.funding);
              this.active(submission.candidate);
              if(init?.signal?.aborted)fail('THIRD_ENTRY_REQUEST_ABORTED');
              if(this.now().getTime()-submission.quotedAt>QUOTE_MAX_AGE_MS)fail('THIRD_ENTRY_QUOTE_EXPIRED');
              const check=this.orders.checkFunding(order.id,latest,this.now());if(!check.ok)fail(check.reason);
              this.requireHolderRisk(this.orders.get(order.id)??order,submission.holderRisk);
              // No asynchronous operation is allowed between this committed claim and fetch.
              this.active(submission.candidate);
              const begun=this.orders.beginSubmission(order.id,this.now());if(!begun.order)fail(begun.reason??'ENTRY_ALREADY_HANDLED');
              submission.attempted=true;
            }catch(error){submission.failureReason=reason(error);throw error;}
          }
          const response=await this.fetcher(input,init);
          if(response.status===429)this.options.recordRateLimit?.(response.headers);
          return response;
        };
        return this.options.scheduleRequest?this.options.scheduleRequest(10,perform):perform();
      }});
    return this.client;
  }
  private async fundingSnapshot(wallet:string):Promise<FundingSnapshot> {
    const deadline=AbortSignal.timeout(FUNDING_COVERAGE_BUDGET_MS);
    const balance=await readNativeBalance('solana',wallet,this.config,this.fetcher,deadline);
    if(balance.status!=='verified'||balance.amount===undefined)fail('ENTRY_BALANCE_UNAVAILABLE');
    const coveredOrderIds:string[]=[];
    const pending:OpeningOrder[]=[];
    for(const previous of this.orders.fundingOrders({chain:'solana',mode:'live',wallet,inputToken:SOL},balance)) {
      if(!previous.transactionHash)continue;
      const cache=previous.details.nativeDebitCoverage;
      const cached=object(cache)&&cache.transactionHash===previous.transactionHash&&Number.isSafeInteger(cache.slot)&&
        Number(cache.slot)>=0&&typeof balance.slot==='number'&&balance.slot>=Number(cache.slot);
      if(cached){coveredOrderIds.push(previous.id);continue;}
      pending.push(previous);
    }
    let cursor=0;
    const worker=async()=>{for(;;){
      const previous=pending[cursor++];if(!previous||deadline.aborted)return;
      if(!await nativeBalanceCoversOrder(previous,balance,this.config,this.fetcher,deadline))continue;
      coveredOrderIds.push(previous.id);
      const current=this.orders.get(previous.id);
      if(current?.status==='confirmed')this.orders.update(previous.id,['confirmed'],{details:{...current.details,
        nativeDebitCoverage:{transactionHash:current.transactionHash,slot:balance.slot,checkedAt:balance.checkedAt}}},this.now());
    }};
    await Promise.all(Array.from({length:Math.min(FUNDING_COVERAGE_CONCURRENCY,pending.length)},worker));
    return {...balance,balance:balance.amount,feeReserve:this.config.entryFeeReserves.solana,coveredOrderIds};
  }
  private async refreshFundingSnapshot(wallet:string,verified:FundingSnapshot):Promise<FundingSnapshot>{
    // The native process gives its final host callback five seconds. Leave a
    // full second for the local funding CAS/readiness checks after this read.
    const balance=await readNativeBalance('solana',wallet,this.config,this.fetcher,AbortSignal.timeout(FUNDING_REFRESH_BUDGET_MS));
    if(balance.status!=='verified'||balance.amount===undefined||typeof balance.slot!=='number'||
      typeof verified.slot!=='number'||balance.slot<verified.slot)fail('ENTRY_BALANCE_UNAVAILABLE');
    return {...balance,balance:balance.amount,feeReserve:this.config.entryFeeReserves.solana,
      coveredOrderIds:[...verified.coveredOrderIds]};
  }
  private requireHolderRisk(order:OpeningOrder,expected:EntryHolderRiskAssessment):void {
    const saved=normalizeStoredEntryHolderRisk(order.details.entryHolderRisk,{chain:order.chain,address:order.tokenAddress});
    if(!saved||saved.status!=='pass'||JSON.stringify(saved)!==JSON.stringify(expected))fail('ENTRY_HOLDER_RISK_EVIDENCE_INVALID');
    const age=this.now().getTime()-Date.parse(saved.checkedAt);
    if(age<0||age>ENTRY_HOLDER_RISK_MAX_AGE_MS)fail('ENTRY_HOLDER_RISK_STALE');
  }
  private async holderRisk(address:string):Promise<EntryHolderRiskAssessment> {
    const unavailable=(why:string)=>unavailableEntryHolderRisk(address,this.now().toISOString(),why);
    if(!this.options.readHolderRisk)return unavailable('ENTRY_HOLDER_RISK_PROVIDER_MISSING');
    try {
      const raw=await this.options.readHolderRisk(address);
      if(!object(raw)||raw.provider!=='gmgn'||raw.chain!=='solana'||raw.address!==address)return unavailable('ENTRY_HOLDER_RISK_TOKEN_MISMATCH');
      const assessed=assessEntryHolderRiskValues(structuredClone(raw),this.now());
      return normalizeStoredEntryHolderRisk(assessed,{chain:'solana',address})??unavailable('ENTRY_HOLDER_RISK_RESPONSE_INVALID');
    }catch {return unavailable('ENTRY_HOLDER_RISK_READ_FAILED');}
  }
  private async considerInternal(candidate:Readonly<ThirdSignalCandidate>,wallet:string,exit:ExitTracking,
    releaseAdmission:()=>void):Promise<EntryResult> {
    let reservation:ReturnType<OrderStore['reserve']>,funding:FundingSnapshot;
    try {
      this.active(candidate);funding=await this.fundingSnapshot(wallet);this.active(candidate);
      const eventKey=createHash('sha256').update(JSON.stringify(['third_signal_v1',candidate.runId,candidate.id])).digest('hex');
      reservation=this.orders.reserve({eventKey,chain:'solana',tokenAddress:candidate.address,mode:'live',wallet,inputToken:SOL,inputAmount:'0',
        slippagePct:this.config.entrySlippagePct,exit,details:{executionStrategy:'third_signal_v1',policyVersion:'third_signal_v1',candidate,
          ...(this.config.solanaExecutionProvider==='pump_native'?{executionProvider:'pump_native'}:{}),
          signal:{source:candidate.source,eventId:candidate.eventId,occurredAt:candidate.occurredAt},
          token:{chain:'solana',address:candidate.address,name:candidate.name,symbol:candidate.symbol}}},this.config.entryMaxOpen,this.now(),funding,
        {preventReentry:true,balanceBps:300,balanceBasis:'total'});
    }catch(error){return {status:'blocked',reason:reason(error)};}
    finally{releaseAdmission();}
    if(!reservation.created)return reservation.order?{status:'existing',order:reservation.order}:{status:'blocked',reason:reservation.reason};
    let order=reservation.order!,submission:Submission|undefined;
    try {
      this.active(candidate);
      const holderRisk=await this.holderRisk(candidate.address);
      const checked=this.orders.update(order.id,['prepared'],{details:{...order.details,entryHolderRisk:holderRisk}},this.now());
      if(!checked)return {status:'existing',order:this.orders.get(order.id)};order=checked;
      this.active(candidate);
      if(holderRisk.status!=='pass')fail(holderRisk.reasons[0]??'ENTRY_HOLDER_RISK_UNAVAILABLE');
      this.requireHolderRisk(order,holderRisk);
      if(this.config.solanaExecutionProvider==='pump_native'){
        if(!this.options.native)fail('NATIVE_EXECUTOR_UNAVAILABLE');
        let attempted=false;
        try {
          const next=await this.options.native.execute(order,async()=>{
            this.active(candidate);
            this.requireHolderRisk(this.orders.get(order.id)??order,holderRisk);
            const fresh=await this.refreshFundingSnapshot(wallet,funding);this.active(candidate);
            const fundingCheck=this.orders.checkFunding(order.id,fresh,this.now());if(!fundingCheck.ok)fail(fundingCheck.reason);
            this.requireHolderRisk(this.orders.get(order.id)??order,holderRisk);
            const readiness=this.options.native!.readiness();if(!readiness.ready)fail(readiness.reason??'NATIVE_EXECUTOR_UNAVAILABLE');
            this.active(candidate);
            const begun=this.orders.beginSubmission(order.id,this.now());if(!begun.order)fail(begun.reason??'ENTRY_ALREADY_HANDLED');
            attempted=true;
          });
          return {status:attempted?'created':'blocked',order:next,reason:next.failureReason};
        }catch(error){
          const failureReason=reason(error);
          const next=this.orders.update(order.id,[attempted?'submitting':'prepared'],{status:attempted?'unknown':'failed',failureReason},this.now());
          return {status:attempted?'created':'blocked',reason:failureReason,order:next??this.orders.get(order.id)};
        }
      }
      const raw=await this.transport().quote({wallet,inputToken:SOL,outputToken:candidate.address,inputAmount:order.inputAmount,slippagePct:order.slippagePct});
      const quote=inspectTestQuote(raw,{input:SOL,output:candidate.address,amount:order.inputAmount,slippage:order.slippagePct});
      if(quote.status!=='available')fail('ENTRY_QUOTE_INVALID');
      this.active(candidate);
      const quotedAt=this.now().getTime(),clientId=randomUUID();
      const current=this.orders.get(order.id);if(!current||current.status!=='prepared')fail('ENTRY_ALREADY_HANDLED');
      this.requireHolderRisk(current,holderRisk);order=current;
      const body={chain:'sol',from_address:wallet,input_token:SOL,output_token:candidate.address,input_amount:order.inputAmount,
        swap_mode:'ExactIn',slippage:order.slippagePct,min_output_amount:quote.minimumOutputAmount,is_anti_mev:true,
        priority_fee:this.config.entryPriorityFeeSolana,tip_fee:this.config.entryTipFeeSolana,
        condition_orders:buildExitConditions(exit.policy),sell_ratio_type:exit.policy.sellRatioType};
      const bodyText=JSON.stringify(body);
      const saved=this.orders.update(order.id,['prepared'],{details:{...order.details,quote:{...quote,quotedAt:new Date(quotedAt).toISOString()},
        submission:{clientId,bodyHash:createHash('sha256').update(bodyText).digest('hex'),body,createdAt:this.now().toISOString()}}},this.now());
      if(!saved)return {status:'existing',order:this.orders.get(order.id)};order=saved;
      submission={candidate,orderId:order.id,clientId,bodyText,quotedAt,attempted:false,holderRisk,funding};this.submissions.set(clientId,submission);
      const result=await this.transport().swap(body,clientId);
      if(!submission.attempted)fail('THIRD_ENTRY_SUBMISSION_DENIED');
      return {status:'created',order:this.applyExecution(order,result)};
    }catch(error){
      const failureReason=submission?.failureReason??reason(error),attempted=submission?.attempted===true;
      const updated=this.orders.update(order.id,[attempted?'submitting':'prepared'],{status:attempted?'unknown':'failed',failureReason},this.now())??this.orders.get(order.id);
      return {status:attempted?'created':'blocked',reason:failureReason,order:updated};
    }finally{if(submission)this.submissions.delete(submission.clientId);}
  }
  private applyExecution(order:OpeningOrder,raw:unknown):OpeningOrder {
    type Patch=Parameters<OrderStore['update']>[2];
    const patch:Patch={status:'unknown',failureReason:'ENTRY_EXECUTION_UNVERIFIED'};
    if(object(raw)&&identifier(raw.order_id)){
      patch.providerOrderId=raw.order_id;if(hash(raw.hash))patch.transactionHash=raw.hash;
      const r=raw.report,receipt=object(r)&&r.input_token===SOL&&r.output_token===order.tokenAddress&&atomic(r.input_amount)&&
        atomic(r.output_amount)&&BigInt(r.input_amount)<=BigInt(order.inputAmount);
      const success=raw.status==='confirmed'&&(raw.state===undefined||raw.state===30)||raw.status==='successful'&&raw.state===30&&receipt;
      if(success&&patch.transactionHash&&(r===undefined||receipt)){
        patch.status='confirmed';patch.failureReason=undefined;
        if(receipt&&object(r)){patch.actualInputAmount=r.input_amount as string;patch.outputAmount=r.output_amount as string;}
      }else if((raw.status==='failed'||raw.status==='expired')&&raw.state!==30&&!receipt){
        patch.status='failed';patch.failureReason=raw.status==='expired'?'ENTRY_ORDER_EXPIRED':'ENTRY_ORDER_FAILED';
      }else if((raw.status==='pending'||raw.status==='processed')&&raw.state!==30&&!receipt){patch.status='submitted';patch.failureReason=undefined;}
      const stored=this.orders.get(order.id);
      if(stored?.exit&&identifier(raw.strategy_order_id))this.orders.updateExit(order.id,stored.exit,{...stored.exit,strategyOrderId:raw.strategy_order_id,
        state:'unverified',reasons:['EXIT_STRATEGY_NOT_YET_VERIFIED'],checkedAt:this.now().toISOString()},this.now());
    }
    return this.orders.update(order.id,['submitting'],patch,this.now())??this.orders.get(order.id)!;
  }
}
