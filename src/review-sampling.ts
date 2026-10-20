import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,fstatSync,fsyncSync,mkdirSync,openSync,readSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,basename} from 'node:path';
import type {Chain} from './types.js';

export type ReviewSamplingSource='debot'|'ave'|'gmgn'|'wallet'|'manual';
export interface ReviewSamplingCohort {chain:Chain;source:ReviewSamplingSource;total:number;covered:number;}
export interface ReviewSamplingPlan {
  version:1;policyVersion:'review-coverage-v1';id:string;scope:'research_sampling_only';
  asOf:string;windowEndAt:string;effectiveAt:string;expiresAt:string;fairShare:0.5;
  cohorts:Array<ReviewSamplingCohort&{missing:number;weight:1|2}>;
}
export interface ReviewSamplingPlanState {
  status:'disabled'|'active'|'missing'|'invalid'|'future'|'expired'|'unavailable';
  reason?:string;plan?:ReviewSamplingPlan;
}
const TTL=48*60*60*1000,MAX_BYTES=64*1024;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const stamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(key=>Object.hasOwn(v,key));
/** Uses the complete observed cohort counts only. Price, scores and outcomes are not inputs. */
export function buildReviewSamplingPlan(input:{asOf:string;windowEndAt:string;cohorts:ReviewSamplingCohort[]}):ReviewSamplingPlan {
  if(!stamp(input.asOf)||!stamp(input.windowEndAt)||input.windowEndAt>input.asOf||!Array.isArray(input.cohorts)||input.cohorts.length>15)
    throw new Error('REVIEW_SAMPLING_PLAN_INVALID');
  const seen=new Set<string>();
  const cohorts=input.cohorts.map(row=>{
    if(!row||!['bsc','solana','robinhood'].includes(row.chain)||!['debot','ave','gmgn','wallet','manual'].includes(row.source)||
      !Number.isSafeInteger(row.total)||row.total<0||row.total>1e9||!Number.isSafeInteger(row.covered)||row.covered<0||row.covered>row.total)
      throw new Error('REVIEW_SAMPLING_PLAN_INVALID');
    const key=`${row.chain}:${row.source}`;if(seen.has(key))throw new Error('REVIEW_SAMPLING_PLAN_INVALID');seen.add(key);
    return {chain:row.chain,source:row.source,total:row.total,covered:row.covered,missing:row.total-row.covered,weight:(row.covered<row.total?2:1) as 1|2};
  }).sort((a,b)=>a.chain.localeCompare(b.chain)||a.source.localeCompare(b.source));
  const body={version:1 as const,policyVersion:'review-coverage-v1' as const,scope:'research_sampling_only' as const,
    asOf:input.asOf,windowEndAt:input.windowEndAt,effectiveAt:input.asOf,expiresAt:new Date(Date.parse(input.asOf)+TTL).toISOString(),fairShare:0.5 as const,cohorts};
  return {...body,id:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
}
export function validateReviewSamplingPlan(value:unknown):ReviewSamplingPlan|undefined {
  if(!object(value)||!exact(value,['version','policyVersion','scope','asOf','windowEndAt','effectiveAt','expiresAt','fairShare','cohorts','id'])||
    !Array.isArray(value.cohorts)||value.cohorts.some(row=>!object(row)||!exact(row,['chain','source','total','covered','missing','weight'])))return;
  try {
    const plan=buildReviewSamplingPlan(value as unknown as Parameters<typeof buildReviewSamplingPlan>[0]);
    if(value.version!==plan.version||value.policyVersion!==plan.policyVersion||value.scope!==plan.scope||value.id!==plan.id||
      value.effectiveAt!==plan.effectiveAt||value.expiresAt!==plan.expiresAt||value.fairShare!==plan.fairShare)return;
    const sorted=[...value.cohorts].sort((a,b)=>a.chain.localeCompare(b.chain)||a.source.localeCompare(b.source));
    if(sorted.some((row,i)=>row.missing!==plan.cohorts[i].missing||row.weight!==plan.cohorts[i].weight))return;
    return plan;
  }catch{return;}
}
/** Atomic replacement prevents the running observer from reading a partial daily publication. */
export function writeReviewSamplingPlan(path:string,input:ReviewSamplingPlan):void {
  const plan=validateReviewSamplingPlan(input);if(!plan||!path||path.includes('\0'))throw new Error('REVIEW_SAMPLING_PLAN_INVALID');
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const temporary=join(dirname(path),`.${basename(path)}.${randomUUID()}.tmp`);let fd:number|undefined;
  try {
    fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    writeFileSync(fd,JSON.stringify(plan)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,path);
  }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{/* Already atomically installed. */}}
}
export class ReviewSamplingPlanReader {
  private cached?:ReviewSamplingPlanState;private cachedAt=-Infinity;
  private readonly now:()=>Date;private readonly cacheMs:number;
  constructor(private readonly path?:string,options:{now?:()=>Date;cacheMs?:number}={}) {
    this.now=options.now??(()=>new Date());this.cacheMs=options.cacheMs??30000;
    if(!Number.isFinite(this.cacheMs)||this.cacheMs<0||this.cacheMs>60000)throw new Error('REVIEW_SAMPLING_CACHE_INVALID');
  }
  read():ReviewSamplingPlanState {
    if(!this.path)return {status:'disabled'};
    const now=this.now().getTime();if(!Number.isFinite(now))return {status:'unavailable',reason:'REVIEW_SAMPLING_CLOCK_INVALID'};
    if(!this.cached||now<this.cachedAt||now-this.cachedAt>=this.cacheMs){
      this.cachedAt=now;let fd:number|undefined;
      try {
        fd=openSync(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);
        if(!stat.isFile()||stat.size>MAX_BYTES)throw new Error('REVIEW_SAMPLING_PLAN_INVALID');
        const buffer=Buffer.alloc(MAX_BYTES+1);let size=0,n=0;
        while(size<buffer.length&&(n=readSync(fd,buffer,size,buffer.length-size,null))>0)size+=n;
        const plan=size<=MAX_BYTES?validateReviewSamplingPlan(JSON.parse(buffer.subarray(0,size).toString('utf8'))):undefined;
        this.cached=plan?{status:'active',plan}:{status:'invalid',reason:'REVIEW_SAMPLING_PLAN_INVALID'};
      }catch(error){
        const code=(error as NodeJS.ErrnoException).code;
        this.cached=code==='ENOENT'?{status:'missing',reason:'REVIEW_SAMPLING_PLAN_MISSING'}:
          error instanceof SyntaxError||(error as Error).message==='REVIEW_SAMPLING_PLAN_INVALID'?{status:'invalid',reason:'REVIEW_SAMPLING_PLAN_INVALID'}:
          {status:'unavailable',reason:'REVIEW_SAMPLING_PLAN_UNAVAILABLE'};
      }finally{if(fd!==undefined)closeSync(fd);}
    }
    const result=this.cached,plan=result.plan;
    if(plan&&Date.parse(plan.effectiveAt)>now)return {status:'future',reason:'REVIEW_SAMPLING_PLAN_NOT_EFFECTIVE'};
    if(plan&&Date.parse(plan.expiresAt)<=now)return {status:'expired',reason:'REVIEW_SAMPLING_PLAN_EXPIRED'};
    return structuredClone(result);
  }
}
