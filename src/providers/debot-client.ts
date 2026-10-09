import {randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import {ZodError} from 'zod';
import {jsonRequest,type Fetcher} from '../http.js';
import type {Signal,VendorNarrative} from '../types.js';
import {normalizeDebotStory} from './debot-story.js';

export interface DebotNarrativeFetchResult {
  status:'ok'|'unavailable'|'unsupported';reason?:string;snapshot?:VendorNarrative;
  sourceUrl?:string;fetchedAt:string;rawResponse?:unknown;
}

function failureReason(error:unknown):string {
  if(error instanceof ZodError) return 'DEBOT_RESPONSE_INVALID';
  if(error instanceof Error) {
    if(error.name==='TimeoutError'||error.name==='AbortError') return 'DEBOT_REQUEST_TIMEOUT';
    if(error.name==='SyntaxError') return 'DEBOT_INVALID_JSON';
    if(error.message==='UPSTREAM_TOO_LARGE') return 'DEBOT_RESPONSE_TOO_LARGE';
    for(const code of [401,403,404,429]) if(error.message===`UPSTREAM_HTTP_${code}`) return `DEBOT_HTTP_${code}`;
    if(/^UPSTREAM_HTTP_\d{3}$/.test(error.message)) return 'DEBOT_HTTP_ERROR';
  }
  // Do not echo exception strings, URLs or any upstream credentials into reports.
  return 'DEBOT_REQUEST_FAILED';
}

/** One anonymous request to the observed DeBot endpoint, without retries or login state. */
export async function fetchDebotNarrative(signal:Signal,fetcher:Fetcher=fetch):Promise<DebotNarrativeFetchResult> {
  const {chain,address}=signal.token;
  if(chain!=='bsc'&&chain!=='solana') {
    return {status:'unsupported',reason:'DEBOT_CHAIN_SCOPE_UNKNOWN',fetchedAt:new Date().toISOString()};
  }
  let valid=false;
  try {valid=chain==='solana'?bs58.decode(address).length===32:/^0x[0-9a-fA-F]{40}$/.test(address);}
  catch {valid=false;}
  if(!valid) return {status:'unavailable',reason:'DEBOT_TOKEN_INVALID',fetchedAt:new Date().toISOString()};
  const url=new URL('https://debot.ai/api/v1/nitter/story/latest');
  url.searchParams.set('request_id',randomUUID());
  url.searchParams.set('ca_address',address);
  const sourceUrl=url.toString();
  let rawResponse:unknown;
  try {
    rawResponse=await jsonRequest(sourceUrl,{method:'GET',credentials:'omit',headers:{accept:'application/json'}},fetcher,12000);
    const snapshot=normalizeDebotStory(rawResponse,signal.token,sourceUrl);
    return {status:'ok',snapshot,sourceUrl,fetchedAt:new Date().toISOString(),rawResponse};
  } catch(error) {
    return {status:'unavailable',reason:failureReason(error),sourceUrl,fetchedAt:new Date().toISOString(),
      ...(rawResponse!==undefined?{rawResponse}:{})};
  }
}
