import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {collectMemeCatalyst} from '../src/meme-catalyst.js';
import {normalizeDebotStory} from '../src/providers/debot-story.js';
import type {Fetcher} from '../src/http.js';
import type {VendorNarrative} from '../src/types.js';
import {config,signal,now,token} from './helpers.js';

const payload=()=>{
  const raw=JSON.parse(readFileSync(new URL('../fixtures/debot-story-v2.example.json',import.meta.url),'utf8'));
  raw.data.history.ca_address=token;raw.data.history.story.contract_address=token;
  raw.data.history.generated_at=now.toISOString();return raw;
};
const vendor=(overrides:Partial<VendorNarrative>={}):VendorNarrative=>({...normalizeDebotStory(payload(),signal().token,
  `https://debot.ai/token/bsc/${token}`),...overrides});
const post=(id='1',author='101',age=60_000,text=`post ${id} CA ${token}`)=>({
  id,author_id:author,created_at:new Date(now.getTime()-age).toISOString(),text,
});
const settings=()=>({...config(),xBearer:'test-public-provider-key'});
function responses(options:{raw?:unknown;lookup?:unknown[];search?:unknown[];lookupStatus?:number;searchStatus?:number}={}):Fetcher {
  return async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==='debot.ai')return new Response(JSON.stringify(options.raw??payload()));
    const lookup=parsed.pathname==='/2/tweets';
    const posts=lookup?options.lookup??[]:options.search??[];
    return new Response(JSON.stringify({data:posts,meta:{result_count:posts.length}}),{status:lookup?options.lookupStatus??200:options.searchStatus??200});
  };
}

test('supplier source inventory and negative opinion are retained as AI material, never fabricated social heat or a gate',async()=>{
  const result=await collectMemeCatalyst(signal(),settings(),{now,fetcher:responses()});
  assert.equal(result.status,'partial');assert.equal(result.sourceTweetCount,38);
  assert.equal(result.supplier?.contentType,'supplier_ai');assert.equal(result.supplier?.verification,'vendor_endpoint');
  assert.equal(result.supplier?.claimsVerified,false);assert.equal(result.supplier?.fresh,true);
  assert.match(result.supplier!.text,/不建议关注/);assert.equal(result.supplier?.generatedAt,now.toISOString());
  assert.equal(result.diffusion.status,'unknown');assert.equal(result.diffusion.postCount,0);assert.equal(result.posts.length,0);
  assert.equal(result.celebrities.endorsementVerified,false);assert.equal(result.celebrities.accountIdentityCoverage,'unverified');
  assert.equal('buyEligible' in result,false);assert.equal('decision' in result,false);assert.equal('sentiment' in result,false);
});

test('real CA posts create distinct-account sampled windows; context references never become CA diffusion',async()=>{
  const supplied=vendor({evidenceUrls:['https://x.com/context/status/3','https://x.com/author/status/1']});
  const result=await collectMemeCatalyst(signal({vendorNarrative:supplied}),settings(),{now,fetcher:responses({
    lookup:[post('3','999',10_000,'A real event that spawned a community meme'),post('1','101',60_000)],
    search:[post('1','101',60_000),post('2','102',360_000),post('4','101',100_000)],
  })});
  assert.equal(result.posts.length,4);assert.equal(result.posts[0].relation,'referenced_context');
  assert.equal(result.posts[0].mentionsExactCa,false);assert.equal(result.posts[1].relation,'ca_mention');
  assert.deepEqual(result.diffusion.recent5m,{postCount:2,authorCount:1});
  assert.deepEqual(result.diffusion.previous5m,{postCount:1,authorCount:1});
  assert.equal(result.diffusion.caPostCount,3);assert.equal(result.diffusion.independentAuthorCount,2);
  assert.equal(result.diffusion.coverage,'sampled');assert.equal(result.evidence.retrievedPostCount,2);
  assert.equal(result.evidence.requestedPostCount,2);assert.equal(result.status,'available');
});

test('copied text, repeated posts and out-of-window observations do not inflate diffusion',async()=>{
  const copied=`same copy ${token}`;
  const result=await collectMemeCatalyst(signal({vendorNarrative:vendor({evidenceUrls:[]})}),settings(),{now,
    fetcher:responses({search:[post('1','101',1_000,copied),post('2','102',2_000,copied),post('1','101',1_000,copied),
      post('3','103',700_000),post('4','104',-1_000),post('5','105',config().maxEvidenceAgeSec*1000+1)]})});
  assert.equal(result.posts.length,2);assert.equal(result.diffusion.caPostCount,1);assert.equal(result.diffusion.caAuthorCount,1);
  assert.equal(result.posts.some(value=>value.id==='x:4'),false);assert.equal(result.posts.some(value=>value.id==='x:5'),false);
});

test('unretrieved reference IDs and supplier maximum views cannot supply counts or infer emotion',async()=>{
  const result=await collectMemeCatalyst(signal({vendorNarrative:vendor()}),settings(),{now,fetcher:responses({lookupStatus:404})});
  assert.equal(result.sourceTweetCount,38);assert.equal(result.evidence.retrievedPostCount,0);
  assert.equal(result.diffusion.caPostCount,0);assert.equal(result.diffusion.recent5m.authorCount,0);
  assert.ok(result.reasons.includes('CATALYST_REFERENCED_POSTS_PARTIALLY_RETRIEVED'));
  assert.ok(result.evidence.limitations.includes('CATALYST_REFERENCE_IDS_NOT_OBSERVED_HEAT'));
});

test('token, chain and source-page mismatches are not attached to this token or used to request vendor evidence',async()=>{
  for(const invalid of [
    vendor({token:{chain:'bsc',address:`0x${'2'.repeat(40)}`}}),
    vendor({token:{chain:'robinhood',address:token}}),
    vendor({sourceUrl:`https://debot.ai/token/bsc/0x${'2'.repeat(40)}`}),
    vendor({sourceUrl:`https://debot.ai.evil.test/token/bsc/${token}`}),
  ]) {
    const requested:string[]=[];
    const result=await collectMemeCatalyst(signal({vendorNarrative:invalid}),settings(),{now,fetcher:async(url,init)=>{
      requested.push(String(url));return responses()(url,init);
    }});
    assert.equal(result.supplier,undefined);assert.equal(result.sourceTweetCount,0);
    assert.equal(result.evidence.requestedPostCount,0);assert.equal(requested.length,1);
    assert.ok(result.reasons.some(reason=>reason.startsWith('CATALYST_SUPPLIER_')));
  }
});

test('mismatched successful vendor response cannot contaminate another CA',async()=>{
  const wrong=payload();wrong.data.history.story.contract_address=`0x${'2'.repeat(40)}`;
  const result=await collectMemeCatalyst(signal(),settings(),{now,fetcher:responses({raw:wrong})});
  assert.equal(result.supplier,undefined);assert.equal(result.sourceTweetCount,0);
  assert.ok(result.reasons.includes('DEBOT_TOKEN_IDENTITY_CONFLICT'));
});

test('future and stale supplier generations stay visibly unconfirmed while fresh retrieved CA evidence can survive',async()=>{
  for(const [age,reason] of [[-1,'CATALYST_SUPPLIER_GENERATED_AT_FUTURE'],
    [config().maxEvidenceAgeSec*1000+1,'CATALYST_SUPPLIER_STALE']] as const) {
    const result=await collectMemeCatalyst(signal({vendorNarrative:vendor({updatedAt:new Date(now.getTime()-age).toISOString(),evidenceUrls:[]})}),
      settings(),{now,fetcher:responses({search:[post()]})});
    assert.equal(result.supplier?.fresh,false);assert.ok(result.reasons.includes(reason));assert.equal(result.status,'partial');
    assert.equal(result.diffusion.caPostCount,1);assert.equal(result.posts.length,1);
  }
});

test('project celebrity links retain weak provenance and a handle-shaped reference does not authenticate an author',async()=>{
  const input=signal({vendorNarrative:vendor({evidenceUrls:['https://x.com/cz_binance/status/1']})});
  const result=await collectMemeCatalyst(input,settings(),{now,fetcher:responses({lookup:[post()]}),
    snapshot:{token:input.token,fetchedAt:now.toISOString(),info:{address:token,chain:'bsc',link:{twitter_username:'cz_binance'}},
      diagnostics:[{section:'info',status:'ok'}]}});
  assert.equal(result.celebrities.signals.length,1);assert.equal(result.celebrities.signals[0].kind,'profile_link');
  assert.equal(result.celebrities.signals[0].relation,'project_link');
  assert.equal(result.celebrities.signals[0].verification,'project_link');
  assert.equal(result.celebrities.signals[0].publishedAt,undefined);assert.equal(result.celebrities.endorsementVerified,false);
  assert.equal(result.celebrities.accountIdentityCoverage,'unverified');assert.equal(result.celebrities.status,'partial');
});

test('vendor failure still retrieves explicit original URLs and sanitizes provider failure details',async()=>{
  const result=await collectMemeCatalyst(signal({evidenceUrls:['https://x.com/original/status/1']}),settings(),{now,fetcher:async(url,init)=>{
    if(new URL(String(url)).hostname==='debot.ai')throw new Error('https://secret.test/?token=private');
    return responses({lookup:[post()]})(url,init);
  }});
  assert.equal(result.posts.length,1);assert.equal(result.posts[0].url,'https://x.com/i/web/status/1');
  assert.ok(result.reasons.includes('DEBOT_REQUEST_FAILED'));assert.equal(JSON.stringify(result).includes('private'),false);
});

test('hanging narrative reserves time for originals and cannot block the next collection task',async()=>{
  let originalCalls=0;
  const started=Date.now();
  const first=await collectMemeCatalyst(signal({evidenceUrls:['https://x.com/original/status/1']}),settings(),{now,timeoutMs:100,
    fetcher:async(url,init)=>{
      if(new URL(String(url)).hostname==='debot.ai')return new Promise<Response>(()=>{});
      originalCalls++;return responses({lookup:[post()]})(url,init);
    }});
  assert.equal(first.posts.length,1);assert.ok(originalCalls>0);assert.ok(Date.now()-started<1_000);
  assert.ok(first.reasons.includes('DEBOT_REQUEST_TIMEOUT'));
  const second=await collectMemeCatalyst(signal({vendorNarrative:vendor({evidenceUrls:[]})}),settings(),{now,timeoutMs:100,
    fetcher:responses({search:[post()]})});
  assert.equal(second.posts.length,1);assert.equal(second.diffusion.caPostCount,1);
});

test('external cancellation bounds transports that ignore AbortSignal without recording their error body',async()=>{
  const controller=new AbortController();
  const pending=collectMemeCatalyst(signal(),settings(),{now,signal:controller.signal,timeoutMs:100,
    fetcher:async()=>new Promise<Response>(()=>{})});
  controller.abort(new Error('sensitive cancel body'));
  const result=await pending;assert.ok(result.reasons.includes('CATALYST_CANCELLED'));
  assert.equal(result.status,'unknown');assert.equal(JSON.stringify(result).includes('sensitive'),false);
});

test('unconfigured X never falls back to a paid provider or interprets signal prose as a narrative',async()=>{
  const requests:string[]=[];
  const result=await collectMemeCatalyst(signal({text:'🚀 CZ强烈买入 bullish'}),config(),{now,fetcher:async url=>{
    requests.push(String(url));return new Response('{}',{status:404});
  }});
  assert.equal(requests.length,1);assert.ok(requests[0].startsWith('https://debot.ai/'));
  assert.equal(result.supplier,undefined);assert.equal(result.posts.length,0);assert.equal(result.status,'unknown');
  assert.ok(result.reasons.includes('X_BEARER_TOKEN_MISSING'));assert.equal(result.celebrities.signals.length,0);
});

test('context-only posts and address substrings never become token diffusion',async()=>{
  const result=await collectMemeCatalyst(signal({vendorNarrative:vendor({evidenceUrls:['https://x.com/a/status/1','https://x.com/b/status/2']})}),
    settings(),{now,fetcher:responses({lookup:[post('1','101',1000,'Famous event with no token'),post('2','102',1000,`${token}garbage`)]})});
  assert.equal(result.posts.length,2);assert.ok(result.posts.every(post=>post.relation==='referenced_context'));
  assert.equal(result.diffusion.status,'unknown');assert.equal(result.diffusion.caPostCount,0);
});

test('original references retain room alongside a large vendor list and request hosts stay fixed',async()=>{
  const requested:string[]=[];
  const result=await collectMemeCatalyst(signal({vendorNarrative:vendor({evidenceUrls:Array.from({length:12},(_,i)=>`https://x.com/vendor/status/${100+i}`)}),
    evidenceUrls:['https://x.com/original/status/1','https://localhost/private']}),settings(),{now,fetcher:async(url,init)=>{
      requested.push(String(url));return responses({lookup:[post()]})(url,init);
    }});
  const lookup=new URL(requested.find(url=>new URL(url).pathname==='/2/tweets')!);
  assert.ok(lookup.searchParams.get('ids')!.split(',').includes('1'));
  assert.ok(lookup.searchParams.get('ids')!.split(',').length<=12);
  assert.ok(requested.every(url=>new URL(url).hostname==='api.x.com'));
  assert.equal(result.evidence.retrievedPostCount,1);
});
