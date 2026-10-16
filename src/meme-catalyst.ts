import {createHash} from 'node:crypto';
import type {Config} from './config.js';
import {scopedFetcher,type Fetcher} from './http.js';
import {VendorNarrativeSchema,type Evidence,type Signal,type SocialSignal,type VendorNarrative} from './types.js';
import {fetchDebotNarrative} from './providers/debot-client.js';
import {gatherEvidenceReport,mentionsAddress,xPostId} from './providers/evidence.js';
import type {EvidenceDiagnostic} from './providers/evidence-types.js';
import type {GmgnTokenSnapshot} from './providers/gmgn-safety.js';
import {analyzeVendorNarrative} from './providers/vendor-narrative.js';
import {assessSocialSignals,DEFAULT_SOCIAL_PROFILES} from './social-signals.js';

export type MemeCatalystStatus='unknown'|'partial'|'available';
export interface MemeCatalystPost extends Evidence {
  mentionsExactCa:boolean;
  relation:'ca_mention'|'referenced_context';
}
export interface MemeCatalystSnapshot {
  token:Signal['token'];observedAt:string;expiresAt:string;
  status:MemeCatalystStatus;reasons:string[];
  supplier?:{
    provider:'debot'|'gmgn';sourceUrl:string;text:string;summary:string;narrativeType?:string;generatedAt?:string;
    contentType:'supplier_ai';verification:'user_supplied'|'vendor_endpoint';claimsVerified:false;identityMatches:true;fresh:boolean;
  };
  /** Reference inventory only. Neither these IDs nor supplier engagement claims count as observed heat. */
  sourceTweetCount:number;
  posts:MemeCatalystPost[];
  diffusion:{
    status:MemeCatalystStatus;coverage:'sampled';windowStart:string;windowEnd:string;
    postCount:number;independentAuthorCount:number;caPostCount:number;caAuthorCount:number;
    recent5m:{postCount:number;authorCount:number};previous5m:{postCount:number;authorCount:number};
  };
  celebrities:{
    status:MemeCatalystStatus;
    signals:(SocialSignal&{publishedAt?:string;relation:'project_link'|'ca_mention'})[];
    endorsementVerified:false;accountIdentityCoverage:'unverified'|'partial'|'verified';
  };
  evidence:{requestedPostCount:number;retrievedPostCount:number;diagnostics:EvidenceDiagnostic[];
    narrativeStatus:'pass'|'fail'|'unknown';narrativeReasons:string[];limitations:string[]};
}
export interface MemeCatalystOptions {
  now?:Date;fetcher?:Fetcher;signal?:AbortSignal;snapshot?:GmgnTokenSnapshot;
  /** A caller may shorten this budget, never extend it beyond twelve seconds. */
  timeoutMs?:number;
}

const sameToken=(left:Signal['token'],right:Signal['token'])=>left.chain===right.chain&&
  (left.chain==='solana'?left.address===right.address:left.address.toLowerCase()===right.address.toLowerCase());

function sourceMatches(vendor:VendorNarrative):boolean {
  const page=new URL(vendor.sourceUrl),{chain,address}=vendor.token;
  if(vendor.provider==='debot') {
    if(page.pathname==='/api/v1/nitter/story/latest') {
      return ['bsc','solana'].includes(chain)&&page.hostname==='debot.ai'&&
        page.searchParams.getAll('ca_address').length===1&&
        sameToken({chain,address:page.searchParams.get('ca_address')??''},vendor.token);
    }
    const match=page.pathname.match(/^\/token\/(bsc|solana|sol|robinhood)\/(?:\d+_)?([^/]+)\/?$/);
    return !!match&&sameToken({chain:match[1]==='sol'?'solana':match[1] as Signal['token']['chain'],address:match[2]},vendor.token);
  }
  const match=page.pathname.match(/^\/(bsc|sol|solana|robinhood)\/token\/(?:[^/_]+_)?([^/]+)\/?$/);
  return !!match&&sameToken({chain:match[1]==='sol'?'solana':match[1] as Signal['token']['chain'],address:match[2]},vendor.token);
}

/** Same bounded vendor-first ordering as the engine; no arbitrary URL is fetched directly. */
function evidenceSignal(input:Signal,vendor:VendorNarrative|undefined):Signal {
  const vendorIds=[...new Set((vendor?.evidenceUrls??[]).map(xPostId).filter((id):id is string=>!!id))];
  const inputIds=input.evidenceUrls.map(xPostId).filter((id):id is string=>!!id);
  // Reserve original-link slots when supplied. A large vendor inventory must not hide the user's original posts.
  const reserve=Math.min(4,new Set(inputIds).size),vendorLimit=Math.min(8,12-reserve);
  const ids=[...new Set([...vendorIds.slice(0,vendorLimit),...inputIds])].slice(0,12);
  return {...input,vendorNarrative:vendor,evidenceUrls:ids.map(id=>`https://x.com/i/web/status/${id}`)};
}

function freshEvidence(posts:Evidence[],input:Signal,now:Date,maxAgeSec:number):MemeCatalystPost[] {
  const result:MemeCatalystPost[]=[],ids=new Set<string>(),texts=new Set<string>();
  for(const post of posts.slice(0,12)) {
    const published=Date.parse(post.publishedAt),fetched=Date.parse(post.fetchedAt),current=now.getTime();
    const accepted=post.provider==='x_official'?post.verification==='first_party':
      ['fxembed','twitterapi_io'].includes(post.provider)&&post.verification==='third_party';
    if(!accepted||!/^\d{1,20}$/.test(post.authorId)||post.id!==`x:${xPostId(post.url)}`||
      !Number.isFinite(published)||!Number.isFinite(fetched)||published>current||fetched>current||published>fetched||
      current-published>maxAgeSec*1000||!post.text.trim()||post.text.length>25_000)continue;
    const hash=createHash('sha256').update(post.text.trim()).digest('hex');
    if(ids.has(post.id)||texts.has(hash))continue;
    ids.add(post.id);texts.add(hash);
    const mentionsExactCa=mentionsAddress(post.text,{...input,token:{...input.token,
      address:input.token.chain==='solana'?input.token.address:input.token.address.toLowerCase()}})&&
      new RegExp(`(?<![A-Za-z0-9])${input.token.address}(?![A-Za-z0-9])`,input.token.chain==='solana'?'':'i').test(post.text);
    result.push({...post,mentionsExactCa,relation:mentionsExactCa?'ca_mention':'referenced_context'});
  }
  return result;
}

/** A separate research task: no orders, model calls, sentiment labels, or changes to safety decisions. */
export async function collectMemeCatalyst(input:Signal,config:Config,options:MemeCatalystOptions={}):Promise<MemeCatalystSnapshot> {
  const now=options.now??new Date();
  if(!Number.isFinite(now.getTime()))throw new Error('CATALYST_TIME_INVALID');
  const timeoutMs=Math.max(1,Math.min(12_000,Number.isFinite(options.timeoutMs)?Math.floor(options.timeoutMs!):12_000));
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DOMException('Catalyst budget','TimeoutError')),timeoutMs);
  const scope=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
  const fetcher=scopedFetcher(options.fetcher??fetch,scope),reasons:string[]=[];
  let vendor:VendorNarrative|undefined,origin:'user_supplied'|'vendor_endpoint'='user_supplied';
  try {
    if(input.vendorNarrative) {
      const parsed=VendorNarrativeSchema.safeParse(input.vendorNarrative);
      if(!parsed.success)reasons.push('CATALYST_SUPPLIER_INVALID');
      else if(!sameToken(parsed.data.token,input.token))reasons.push('CATALYST_SUPPLIER_TOKEN_MISMATCH');
      else if(!sourceMatches(parsed.data))reasons.push('CATALYST_SUPPLIER_SOURCE_MISMATCH');
      else vendor=parsed.data;
    } else {
      // Keep half of the job budget for real post retrieval even when the narrative endpoint hangs.
      const vendorController=new AbortController();
      const vendorTimer=setTimeout(()=>vendorController.abort(new DOMException('Narrative budget','TimeoutError')),Math.max(1,Math.floor(timeoutMs/2)));
      try {
        const response=await fetchDebotNarrative(input,scopedFetcher(fetcher,vendorController.signal));
        if(response.status==='ok'&&response.snapshot) {vendor=response.snapshot;origin='vendor_endpoint';}
        else reasons.push(response.reason??'CATALYST_SUPPLIER_UNAVAILABLE');
      } finally {clearTimeout(vendorTimer);}
    }

    let supplier:MemeCatalystSnapshot['supplier'];
    if(vendor) {
      const generated=vendor.updatedAt?Date.parse(vendor.updatedAt):NaN;
      const fresh=Number.isFinite(generated)&&generated<=now.getTime()&&now.getTime()-generated<=config.maxEvidenceAgeSec*1000;
      if(!Number.isFinite(generated))reasons.push('CATALYST_SUPPLIER_GENERATED_AT_UNKNOWN');
      else if(generated>now.getTime())reasons.push('CATALYST_SUPPLIER_GENERATED_AT_FUTURE');
      else if(!fresh)reasons.push('CATALYST_SUPPLIER_STALE');
      const originText=vendor.structured?.sections.find(section=>/^background\.origin(?:\.text)?$/.test(section.path))?.text;
      supplier={provider:vendor.provider,sourceUrl:vendor.sourceUrl,text:vendor.text.slice(0,12_000),
        summary:(originText?.trim()||vendor.text).slice(0,240),
        ...(vendor.structured?{narrativeType:vendor.structured.narrativeType.slice(0,160)}:{}),
        ...(vendor.updatedAt?{generatedAt:vendor.updatedAt}:{}),contentType:'supplier_ai',verification:origin,
        claimsVerified:false,identityMatches:true,fresh};
    }
    const target=evidenceSignal(input,vendor);
    const gathered=await gatherEvidenceReport(target,config,fetcher,now);
    const posts=freshEvidence(gathered.evidence,input,now,config.maxEvidenceAgeSec);
    const caPosts=posts.filter(post=>post.mentionsExactCa);
    const latest=now.getTime(),windowStart=new Date(latest-Math.min(config.maxEvidenceAgeSec,600)*1000).toISOString();
    const count=(from:number,until:number)=>{
      const included=caPosts.filter(post=>Date.parse(post.publishedAt)>from&&Date.parse(post.publishedAt)<=until);
      return {postCount:included.length,authorCount:new Set(included.map(post=>post.authorId)).size};
    };
    const allOperationsOk=gathered.diagnostics.length>0&&gathered.diagnostics.every(item=>item.status==='ok'||item.status==='empty');
    const requestedPostCount=target.evidenceUrls.length;
    const requestedIds=new Set(target.evidenceUrls.map(xPostId));
    const retrievedPostCount=posts.filter(post=>requestedIds.has(xPostId(post.url))).length;
    const diffusionStatus:MemeCatalystStatus=!caPosts.length?'unknown':allOperationsOk?'available':'partial';
    const sampled=caPosts.filter(post=>Date.parse(post.publishedAt)>Date.parse(windowStart));
    const profiles=DEFAULT_SOCIAL_PROFILES.filter(profile=>profile.chains.includes(input.token.chain));
    const primaryProfiles=profiles.filter(profile=>profile.accountId&&profile.accountIdVerification==='primary');
    const accountIdentityCoverage=primaryProfiles.length===0?'unverified':primaryProfiles.length===profiles.length?'verified':'partial';
    const social=assessSocialSignals(input,posts,{snapshot:options.snapshot,now,maxAgeSec:config.maxEvidenceAgeSec});
    const celebritySignals:MemeCatalystSnapshot['celebrities']['signals']=social.signals.map(item=>{
      const post=posts.find(post=>post.id===item.evidenceId);
      return {...item,relation:item.kind==='ca_post'?'ca_mention':'project_link',...(post?{publishedAt:post.publishedAt}:{})};
    });
    const narrative=analyzeVendorNarrative(target,posts,config,now);
    if(origin==='vendor_endpoint'&&narrative.supplier)narrative.supplier.verification='vendor_endpoint';
    const sourceTweetCount=new Set(vendor?.structured?.sourceTweetIds??[]).size;
    const limitations=['CATALYST_SOCIAL_SAMPLE_NOT_NETWORK_TOTAL','CATALYST_AUTHORS_NOT_VERIFIED_INDEPENDENT_PEOPLE',
      'CATALYST_REFERENCE_IDS_NOT_OBSERVED_HEAT','CATALYST_SUPPLIER_OPINIONS_NOT_FACTS',
      'CATALYST_NO_SENTIMENT_OR_ENDORSEMENT_INFERENCE','CATALYST_POST_CA_DOES_NOT_PROVE_CHAIN'];
    if(accountIdentityCoverage!=='verified')limitations.push('CATALYST_CELEBRITY_ACCOUNT_IDS_UNVERIFIED');
    if(posts.some(post=>post.verification==='third_party'))limitations.push('CATALYST_THIRD_PARTY_POST_COPIES');
    if(retrievedPostCount<requestedPostCount)reasons.push('CATALYST_REFERENCED_POSTS_PARTIALLY_RETRIEVED');
    if(!posts.length)reasons.push('CATALYST_ORIGINAL_POSTS_UNAVAILABLE');
    if(scope.aborted)reasons.push(options.signal?.aborted?'CATALYST_CANCELLED':'CATALYST_BUDGET_EXHAUSTED');
    for(const diagnostic of gathered.diagnostics)if(diagnostic.reason)reasons.push(diagnostic.reason);
    const status:MemeCatalystStatus=posts.length&&supplier?.fresh&&allOperationsOk&&retrievedPostCount===requestedPostCount
      ?'available':posts.length||supplier?'partial':'unknown';
    return {token:{...input.token,address:input.token.chain==='solana'?input.token.address:input.token.address.toLowerCase()},
      observedAt:now.toISOString(),expiresAt:new Date(latest+Math.min(config.maxEvidenceAgeSec,600)*1000).toISOString(),status,
      reasons:[...new Set(reasons)],...(supplier?{supplier}:{}),sourceTweetCount,posts,
      diffusion:{status:diffusionStatus,coverage:'sampled',windowStart,windowEnd:now.toISOString(),
        postCount:sampled.length,independentAuthorCount:new Set(sampled.map(post=>post.authorId)).size,
        caPostCount:sampled.length,caAuthorCount:new Set(sampled.map(post=>post.authorId)).size,
        recent5m:count(latest-300_000,latest),previous5m:count(latest-600_000,latest-300_000)},
      celebrities:{status:celebritySignals.length?'partial':'unknown',signals:celebritySignals,endorsementVerified:false,accountIdentityCoverage},
      evidence:{requestedPostCount,retrievedPostCount,diagnostics:gathered.diagnostics,narrativeStatus:narrative.status,
        narrativeReasons:narrative.reasons,limitations}};
  } finally {clearTimeout(timer);}
}
