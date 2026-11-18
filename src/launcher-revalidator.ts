import bs58 from 'bs58';
import {ChainHttp} from './chain-data.js';
import {chainAddress,object} from './chain-stream-store.js';
import {WalletActivityVerifier,type ActivityRpc,type WalletActivity} from './wallet-activity.js';
import type {FastWalletEvent} from './wallet-fast.js';

type MaybePromise<T>=T|Promise<T>;
export interface LauncherRevalidationCandidate {wallet:string;latestSignature?:string;}
export type LauncherRevalidationState='baseline'|'unchanged'|'changed'|'empty'|'error';
export interface LauncherRevalidationObservation {
  signature:string;slot:number;blockTime?:number;classification:WalletActivity['classification'];eventAt?:string;
}
export interface LauncherRevalidationResult {
  chain:'solana';wallet:string;checkedAt:string;state:LauncherRevalidationState;newSignature:boolean;
  latestSignature?:string;blockTime?:number;slot?:number;classification?:WalletActivity['classification'];
  observations?:LauncherRevalidationObservation[];error?:LauncherRevalidationError;
}
export type LauncherRevalidationError=
  'LAUNCHER_CANDIDATE_INVALID'|'LAUNCHER_SIGNATURE_INVALID'|'LAUNCHER_RPC_UNAVAILABLE'|'LAUNCHER_RPC_RESPONSE_INVALID'|
  'LAUNCHER_ACTIVITY_VERIFY_FAILED'|'LAUNCHER_ACTIVITY_RESULT_INVALID'|'LAUNCHER_ACTIVITY_CALLBACK_FAILED'|'LAUNCHER_RESULT_PERSIST_FAILED'|
  'LAUNCHER_SOURCE_UNAVAILABLE'|'LAUNCHER_REVALIDATOR_STOPPED';
export interface LauncherRevalidationSource {
  listCandidates(limit:number):MaybePromise<readonly LauncherRevalidationCandidate[]>;
  recordResult(result:LauncherRevalidationResult):MaybePromise<boolean|void>;
  onActivity?(activity:WalletActivity):MaybePromise<void>;
}
interface ActivityVerifier {verify(event:FastWalletEvent):Promise<WalletActivity>;stop?():void;}
export interface LauncherRevalidatorOptions {
  endpoint:string;source:LauncherRevalidationSource;maxCandidates?:number;concurrency?:number;
  requestIntervalMs?:number;pollIntervalMs?:number;now?:()=>number;
  rpcFactory?:(url:string)=>ActivityRpc;verifier?:ActivityVerifier;
}
export interface LauncherRevalidationRun {accepted:number;checked:number;changed:number;classified:number;errors:number;}

class RevalidationFailure extends Error {constructor(readonly code:LauncherRevalidationError){super(code);}}
const signature=(value:unknown):value is string=>{try{return typeof value==='string'&&value.length<=88&&bs58.decode(value).length===64;}catch{return false;}};
const safeInteger=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

/**
 * Rechecks a bounded launcher shortlist against Solana RPC. It records freshness
 * evidence only; neither a recent signature nor a classified buy authorizes a trade.
 */
export class LauncherRevalidator {
  private readonly rpc:ActivityRpc;private readonly verifier:ActivityVerifier;private readonly ownsVerifier:boolean;
  private readonly maxCandidates:number;private readonly concurrency:number;private readonly requestIntervalMs:number;
  private readonly pollIntervalMs:number;private readonly now:()=>number;
  private timer?:ReturnType<typeof setTimeout>;private current?:Promise<LauncherRevalidationRun>;private stopped=false;private started=false;
  private gate:Promise<void>=Promise.resolve();private nextRequestAt=0;
  private counts={runs:0,accepted:0,checked:0,changed:0,classified:0,errors:0};private error?:LauncherRevalidationError;
  private recent:LauncherRevalidationResult[]=[];
  constructor(private readonly options:LauncherRevalidatorOptions){
    this.maxCandidates=Math.max(1,Math.min(1000,Math.trunc(options.maxCandidates??400)));
    this.concurrency=Math.max(1,Math.min(8,Math.trunc(options.concurrency??2)));
    this.requestIntervalMs=Math.max(1,Math.min(60_000,Math.trunc(options.requestIntervalMs??350)));
    this.pollIntervalMs=Math.max(1_000,Math.min(3_600_000,Math.trunc(options.pollIntervalMs??60_000)));
    this.now=options.now??Date.now;
    let endpoint:URL;try{endpoint=new URL(options.endpoint);}catch{throw new RevalidationFailure('LAUNCHER_RPC_UNAVAILABLE');}
    if(!['http:','https:'].includes(endpoint.protocol))throw new RevalidationFailure('LAUNCHER_RPC_UNAVAILABLE');
    this.rpc=options.rpcFactory?.(options.endpoint)??new ChainHttp(options.endpoint,fetch,this.requestIntervalMs,10_000);
    this.ownsVerifier=!options.verifier;
    this.verifier=options.verifier??new WalletActivityVerifier({solana:{http:options.endpoint}},this.now);
  }
  private async throttle(){
    const work=this.gate.catch(()=>{}).then(async()=>{
      const delay=this.nextRequestAt-Date.now();if(delay>0)await wait(delay);
      this.nextRequestAt=Date.now()+this.requestIntervalMs;
    });
    this.gate=work;await work;
  }
  private parseRows(raw:unknown){
    if(!Array.isArray(raw)||raw.length>3)throw new RevalidationFailure('LAUNCHER_RPC_RESPONSE_INVALID');
    return raw.map(row=>{
      if(!object(row)||!signature(row.signature)||!safeInteger(row.slot)||!(row.blockTime===null||safeInteger(row.blockTime)))
        throw new RevalidationFailure('LAUNCHER_RPC_RESPONSE_INVALID');
      return {signature:row.signature as string,slot:row.slot as number,...(typeof row.blockTime==='number'?{blockTime:row.blockTime}:{})};
    });
  }
  private event(wallet:string,latest:{signature:string;slot:number},checkedAt:string):FastWalletEvent {
    return {id:`launcher-revalidation:${wallet}:${latest.signature}`,chain:'solana',wallet,txHash:latest.signature,slot:latest.slot,
      receivedAt:checkedAt,judgedAt:checkedAt,processingMs:0,kind:'wallet_mention',verdict:'priority_review',groups:['launcher_candidate'],
      profileFresh:true,cachedSafety:'unknown',commitment:'included',removed:false,buyVerified:false,tradingEnabled:false};
  }
  private async persist(result:LauncherRevalidationResult,run:LauncherRevalidationRun){
    try {if(await this.options.source.recordResult(result)===false)throw new Error();}
    catch {run.errors++;this.counts.errors++;this.error='LAUNCHER_RESULT_PERSIST_FAILED';return;}
    this.recent.unshift(result);this.recent=this.recent.slice(0,20);
  }
  private async check(candidate:LauncherRevalidationCandidate,run:LauncherRevalidationRun){
    const wallet=chainAddress('solana',candidate.wallet);if(!wallet){run.errors++;this.counts.errors++;this.error='LAUNCHER_CANDIDATE_INVALID';return;}
    if(candidate.latestSignature!==undefined&&!signature(candidate.latestSignature)){
      const result:LauncherRevalidationResult={chain:'solana',wallet,checkedAt:new Date(this.now()).toISOString(),state:'error',newSignature:false,error:'LAUNCHER_SIGNATURE_INVALID'};
      run.errors++;this.counts.errors++;this.error=result.error;await this.persist(result,run);return;
    }
    let rows:ReturnType<LauncherRevalidator['parseRows']>;
    try {await this.throttle();if(this.stopped)return;
      rows=this.parseRows(await this.rpc.request('getSignaturesForAddress',[wallet,{commitment:'finalized',limit:3}]));if(this.stopped)return;}
    catch(error){
      if(this.stopped)return;
      const code=error instanceof RevalidationFailure?error.code:'LAUNCHER_RPC_UNAVAILABLE';
      const result:LauncherRevalidationResult={chain:'solana',wallet,checkedAt:new Date(this.now()).toISOString(),state:'error',newSignature:false,error:code};
      run.errors++;this.counts.errors++;this.error=code;await this.persist(result,run);return;
    }
    const checkedAt=new Date(this.now()).toISOString(),latest=rows[0];run.checked++;this.counts.checked++;
    if(!latest){await this.persist({chain:'solana',wallet,checkedAt,state:'empty',newSignature:false},run);return;}
    const changed=!!candidate.latestSignature&&candidate.latestSignature!==latest.signature;
    const result:LauncherRevalidationResult={chain:'solana',wallet,checkedAt,state:changed?'changed':candidate.latestSignature?'unchanged':'baseline',newSignature:changed,
      latestSignature:latest.signature,slot:latest.slot,...(latest.blockTime!==undefined?{blockTime:latest.blockTime}:{})};
    if(changed){run.changed++;this.counts.changed++;}
    const previousIndex=candidate.latestSignature?rows.findIndex(row=>row.signature===candidate.latestSignature):-1;
    // Establish a classified baseline once. Later checks replay every signature
    // before the saved cursor (up to the bounded RPC page), so a trailing
    // transfer cannot hide a buy immediately behind it.
    const observations=candidate.latestSignature?(changed?rows.slice(0,previousIndex<0?rows.length:previousIndex).reverse():[]):[latest];
    for(const row of observations){
      if(this.stopped)return;
      try {
        const activity=await this.verifier.verify(this.event(wallet,row,checkedAt));
        if(activity.chain!=='solana'||activity.wallet!==wallet||activity.txHash!==row.signature)throw new RevalidationFailure('LAUNCHER_ACTIVITY_RESULT_INVALID');
        const observation:LauncherRevalidationObservation={signature:row.signature,slot:row.slot,classification:activity.classification,
          ...(row.blockTime!==undefined?{blockTime:row.blockTime}:{}),...(activity.eventAt?{eventAt:activity.eventAt}:{})};
        (result.observations??=[]).push(observation);if(row.signature===latest.signature)result.classification=activity.classification;
        run.classified++;this.counts.classified++;
        try {await this.options.source.onActivity?.(activity);}catch{result.error='LAUNCHER_ACTIVITY_CALLBACK_FAILED';run.errors++;this.counts.errors++;this.error=result.error;}
      }catch(error){if(this.stopped)return;result.error=error instanceof RevalidationFailure?error.code:'LAUNCHER_ACTIVITY_VERIFY_FAILED';
        run.errors++;this.counts.errors++;this.error=result.error;}
    }
    await this.persist(result,run);
  }
  private async execute():Promise<LauncherRevalidationRun>{
    const run:LauncherRevalidationRun={accepted:0,checked:0,changed:0,classified:0,errors:0};this.counts.runs++;this.error=undefined;
    let raw:readonly LauncherRevalidationCandidate[];
    try {raw=await this.options.source.listCandidates(this.maxCandidates);if(!Array.isArray(raw))throw new Error();}
    catch {run.errors++;this.counts.errors++;this.error='LAUNCHER_SOURCE_UNAVAILABLE';return run;}
    const candidates:LauncherRevalidationCandidate[]=[],seen=new Set<string>();
    for(const row of raw.slice(0,this.maxCandidates)){
      const wallet=chainAddress('solana',row?.wallet);if(!wallet||seen.has(wallet)){if(!wallet){run.errors++;this.counts.errors++;this.error='LAUNCHER_CANDIDATE_INVALID';}continue;}
      seen.add(wallet);candidates.push({...row,wallet});
    }
    run.accepted=candidates.length;this.counts.accepted+=candidates.length;let cursor=0;
    const workers=Array.from({length:Math.min(this.concurrency,candidates.length)},async()=>{for(;;){if(this.stopped)return;
      const index=cursor++;if(index>=candidates.length)return;await this.check(candidates[index],run);}});
    await Promise.all(workers);return run;
  }
  runOnce():Promise<LauncherRevalidationRun>{
    if(this.stopped)return Promise.reject(new RevalidationFailure('LAUNCHER_REVALIDATOR_STOPPED'));
    if(this.current)return this.current;
    const work=this.execute().finally(()=>{if(this.current===work)this.current=undefined;});this.current=work;return work;
  }
  private schedule(){if(this.stopped||!this.started)return;this.timer=setTimeout(()=>{
    this.timer=undefined;void this.runOnce().catch(()=>{}).finally(()=>this.schedule());
  },this.pollIntervalMs);this.timer.unref();}
  start(){if(this.started||this.stopped)return;this.started=true;void this.runOnce().catch(()=>{}).finally(()=>this.schedule());}
  status(){return {running:this.started&&!this.stopped,inFlight:!!this.current,maxCandidates:this.maxCandidates,concurrency:this.concurrency,
    requestIntervalMs:this.requestIntervalMs,pollIntervalMs:this.pollIntervalMs,counts:{...this.counts},error:this.error,recent:[...this.recent],
    scope:'solana_signature_freshness_and_transaction_classification',tradingEnabled:false};}
  async stop(){
    if(this.stopped){await this.current;return;}this.stopped=true;this.started=false;clearTimeout(this.timer);
    this.rpc.stop?.();if(this.ownsVerifier)this.verifier.stop?.();await this.current;await this.gate.catch(()=>{});
  }
}
