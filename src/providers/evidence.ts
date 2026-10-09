import {createHash} from 'node:crypto';
import type {Signal,Evidence} from '../types.js';
import type {Config} from '../config.js';
import {jsonRequest,type Fetcher} from '../http.js';
import type {EvidenceDiagnostic,EvidenceReport} from './evidence-types.js';

export function xPostId(url:string):string|undefined {
  try { const u=new URL(url);
    if(u.protocol!=='https:'||u.username||u.password||u.port||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname)) return;
    return u.pathname.match(/^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/(\d{1,20})\/?$/)?.[1];
  } catch { return; }
}
export function mentionsAddress(text:string,signal:Signal):boolean {
  const addresses=signal.token.chain==='solana'
    ?text.match(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g)
    :text.match(/(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g);
  return (addresses??[]).some(a=>signal.token.chain==='solana'?a===signal.token.address:a.toLowerCase()===signal.token.address);
}
type Operation=EvidenceDiagnostic['operation'];
interface PostResult { posts:any[]; errors:string[]; }

function failureReason(error:unknown):string {
  if(error instanceof Error) {
    if(/^UPSTREAM_HTTP_\d{3}$/.test(error.message)||error.message==='UPSTREAM_TOO_LARGE') return error.message;
    if(error.name==='SyntaxError') return 'INVALID_JSON';
    if(error.name==='TimeoutError'||error.name==='AbortError') return 'UPSTREAM_TIMEOUT';
  }
  // Never expose arbitrary upstream text, URLs, or request credentials in diagnostics.
  return 'UPSTREAM_UNAVAILABLE';
}
function providerCodeReason(code:unknown):string {
  return typeof code==='number'&&Number.isInteger(code)&&code>=100&&code<=599
    ?`UPSTREAM_CODE_${code}`:'INVALID_RESPONSE';
}

// One search page per signal; never crawl, paginate, or silently switch to a paid provider.
async function readPosts(operation:Operation,signal:Signal,ids:string[],config:Config,now:Date,fetcher:Fetcher):Promise<PostResult> {
  const since=Math.floor(now.getTime()/1000)-config.maxEvidenceAgeSec;
  if(config.xDataProvider==='x_official') {
    const fields='created_at,author_id,referenced_tweets';
    const query=new URLSearchParams({query:`${signal.token.address} -is:retweet`,'tweet.fields':fields,max_results:'10',
      start_time:new Date(since*1000).toISOString()});
    const endpoint=operation==='lookup'?`https://api.x.com/2/tweets?ids=${ids.join(',')}&tweet.fields=${fields}`
      :`https://api.x.com/2/tweets/search/recent?${query}`;
    const response=await jsonRequest(endpoint,{headers:{authorization:`Bearer ${config.xBearer}`}},fetcher);
    const errors=Array.isArray(response?.errors)&&response.errors.length?['UPSTREAM_ERROR']:[];
    if(Array.isArray(response?.data)) return {posts:response.data,errors};
    if(operation==='search'&&response?.meta?.result_count===0&&!errors.length) return {posts:[],errors:[]};
    return {posts:[],errors:errors.length?errors:['INVALID_RESPONSE']};
  }
  if(config.xDataProvider==='twitterapi_io') {
    const query=new URLSearchParams(operation==='lookup'?{tweet_ids:ids.join(',')}
      :{query:`${signal.token.address} -filter:retweets since_time:${since}`,queryType:'Latest'});
    const endpoint=operation==='lookup'?'twitter/tweets':'twitter/tweet/advanced_search';
    const response=await jsonRequest(`https://api.twitterapi.io/${endpoint}?${query}`,
      {headers:{'X-API-Key':config.twitterApiIoKey!}},fetcher);
    if(response?.status!==undefined&&response.status!=='success') return {posts:[],errors:['UPSTREAM_ERROR']};
    return Array.isArray(response?.tweets)?{posts:response.tweets,errors:[]}:{posts:[],errors:['INVALID_RESPONSE']};
  }
  if(config.xDataProvider==='fxembed') {
    if(operation==='search') {
      const query=new URLSearchParams({q:`${signal.token.address} -filter:retweets since_time:${since}`,feed:'latest',count:'20'});
      const response=await jsonRequest(`https://api.fxtwitter.com/2/search?${query}`,{},fetcher);
      if(response?.code!==200) return {posts:[],errors:[providerCodeReason(response?.code)]};
      return Array.isArray(response.results)?{posts:response.results,errors:[]}:{posts:[],errors:['INVALID_RESPONSE']};
    }
    const posts:any[]=[],errors:string[]=[];
    // Bound concurrent public-service requests. A missing/deleted post does not erase other evidence.
    for(let i=0;i<ids.length;i+=3) {
      const batch=ids.slice(i,i+3);
      const responses=await Promise.allSettled(batch.map(id=>jsonRequest(`https://api.fxtwitter.com/2/status/${id}`,{},fetcher)));
      for(const [index,r] of responses.entries()) {
        if(r.status==='rejected') errors.push(failureReason(r.reason));
        else if(r.value?.code!==200) errors.push(providerCodeReason(r.value?.code));
        else if(r.value.status?.id!==batch[index]) errors.push('POST_ID_MISMATCH');
        else posts.push(r.value.status);
      }
    }
    return {posts,errors};
  }
  return {posts:[],errors:['PROVIDER_UNSUPPORTED']};
}

function normalizePosts(posts:any[],operation:Operation,ids:string[],signal:Signal,config:Config,now:Date):Evidence[] {
    const seenText=new Set<string>(),seenIds=new Set<string>(),result:Evidence[]=[];
    for(const post of posts.slice(0,20)) {
      if(!post||typeof post!=='object') continue;
      const provider=config.xDataProvider;
      const text=provider==='fxembed'?(post.raw_text?.text??post.text):post.text;
      const authorId=provider==='x_official'?post.author_id:post.author?.id;
      const publishedAt=provider==='twitterapi_io'?post.createdAt:post.created_at;
      if(typeof post.id!=='string'||!/^\d{1,20}$/.test(post.id)||(operation==='lookup'&&!ids.includes(post.id))) continue;
      if(typeof authorId!=='string'||!/^\d{1,20}$/.test(authorId)||typeof text!=='string'||!text.trim()||text.length>25000) continue;
      if(typeof publishedAt!=='string'||!Number.isFinite(Date.parse(publishedAt))) continue;
      if(post.author?.protected===true||post.author?.unavailable===true||post.isRetweet===true||post.retweeted_tweet!=null||post.reposted_by!=null) continue;
      if(provider==='fxembed'&&(post.type!=='status'||post.provider!=='twitter')) continue;
      if(provider==='x_official'&&Array.isArray(post.referenced_tweets)&&post.referenced_tweets.some((r:any)=>r?.type==='retweeted')) continue;
      if(/^RT\s+@/i.test(text)) continue;
      // A vendor's search hit is not evidence that the full CA appears in the post.
      // Filter dates locally too: providers can ignore or incompletely apply search operators.
      const age=now.getTime()-Date.parse(publishedAt);
      if(operation==='search'&&(!mentionsAddress(text,signal)||age< -30000||age>config.maxEvidenceAgeSec*1000)) continue;
      const hash=createHash('sha256').update(text.trim()).digest('hex');
      if(seenIds.has(post.id)||seenText.has(hash)) continue;
      seenIds.add(post.id);seenText.add(hash);
      result.push({id:`x:${post.id}`,url:`https://x.com/i/web/status/${post.id}`,text,
        authorId,publishedAt:new Date(publishedAt).toISOString(),fetchedAt:now.toISOString(),provider,
        verification:provider==='x_official'?'first_party':'third_party',
        authority:config.issuerIds.includes(authorId)?'issuer':config.trackedIds.includes(authorId)?'tracked':'public'});
    }
    return result;
}

async function gatherOperation(operation:Operation,signal:Signal,ids:string[],config:Config,now:Date,fetcher:Fetcher)
  :Promise<{evidence:Evidence[];diagnostic:EvidenceDiagnostic}> {
  const missingKey=config.xDataProvider==='x_official'&&!config.xBearer?.trim()?'X_BEARER_TOKEN_MISSING'
    :config.xDataProvider==='twitterapi_io'&&!config.twitterApiIoKey?.trim()?'TWITTERAPI_IO_KEY_MISSING':undefined;
  if(missingKey) return {evidence:[],diagnostic:{operation,status:'not_configured',reason:missingKey,returned:0}};
  let result:PostResult;
  try { result=await readPosts(operation,signal,ids,config,now,fetcher); }
  catch(error) { result={posts:[],errors:[failureReason(error)]}; }
  const evidence=normalizePosts(result.posts,operation,ids,signal,config,now);
  // A partial lookup remains unavailable for completeness, while retaining its valid evidence.
  if(result.errors.length) return {evidence,diagnostic:{operation,status:'unavailable',
    reason:[...new Set(result.errors)].join(','),returned:evidence.length}};
  return {evidence,diagnostic:{operation,status:evidence.length?'ok':'empty',returned:evidence.length,
    ...(!evidence.length?{reason:result.posts.length?'NO_VALID_EVIDENCE':'NO_RESULTS'}:{})}};
}

export async function gatherEvidenceReport(signal:Signal,config:Config,fetcher:Fetcher=fetch,now=new Date()):Promise<EvidenceReport> {
  const ids=[...new Set(signal.evidenceUrls.map(xPostId).filter((v):v is string=>!!v))].slice(0,12);
  const operations:Operation[]=ids.length?['lookup','search']:['search'];
  const results=await Promise.all(operations.map(operation=>gatherOperation(operation,signal,ids,config,now,fetcher)));
  const evidence:Evidence[]=[],seenIds=new Set<string>(),seenText=new Set<string>();
  // Lookup is merged first regardless of completion order, so search can never displace input posts.
  for(const result of results) for(const post of result.evidence) {
    const hash=createHash('sha256').update(post.text.trim()).digest('hex');
    if(evidence.length===12||seenIds.has(post.id)||seenText.has(hash)) continue;
    seenIds.add(post.id);seenText.add(hash);evidence.push(post);
  }
  return {evidence,diagnostics:results.map(result=>result.diagnostic)};
}

export async function gatherEvidence(signal:Signal,config:Config,fetcher:Fetcher=fetch,now=new Date()):Promise<Evidence[]> {
  return (await gatherEvidenceReport(signal,config,fetcher,now)).evidence;
}
