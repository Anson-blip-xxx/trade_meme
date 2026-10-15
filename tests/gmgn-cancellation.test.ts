import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GmgnClient,GmgnError} from '../src/providers/gmgn-client.js';
import {jsonRequest,scopedFetcher} from '../src/http.js';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const route='/v1/token/info',query={chain:'bsc',address:`0x${'1'.repeat(40)}`};
const aborted=(error:unknown)=>error instanceof GmgnError&&error.reason==='GMGN_REQUEST_ABORTED';

test('aborting a queued GMGN scope never sends its request after the preceding request finishes',async()=>{
  const entered=deferred<void>(),release=deferred<Response>();let calls=0;
  const client=new GmgnClient({apiKey:randomUUID(),minIntervalMs:0,fetcher:async()=>{calls++;entered.resolve();return release.promise;}});
  const first=client.get(route,query);await entered.promise;
  const controller=new AbortController(),queued=client.withSignal(controller.signal).get(route,query),rejected=assert.rejects(queued,aborted);
  controller.abort();await rejected;assert.equal(calls,1);release.resolve(Response.json({code:0,data:{}}));await first;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});

test('aborting an in-flight ignored signal releases the queue without accepting the late response',async()=>{
  const entered=deferred<void>(),release=deferred<Response>();let calls=0;let passedSignal:AbortSignal|undefined;
  const client=new GmgnClient({apiKey:randomUUID(),minIntervalMs:0,fetcher:async(_input,init)=>{
    calls++;if(calls===1){passedSignal=init?.signal??undefined;entered.resolve();return release.promise;}
    return Response.json({code:0,data:'next'});
  }});
  const controller=new AbortController(),first=client.withSignal(controller.signal).get(route,query),rejected=assert.rejects(first,aborted);
  await entered.promise;controller.abort();await rejected;assert.equal(passedSignal?.aborted,true);
  assert.equal(await client.get(route,query),'next');release.resolve(Response.json({code:0,data:'late'}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
});

test('a scoped GMGN client retains the original cooldown',async()=>{
  let calls=0;const client=new GmgnClient({apiKey:randomUUID(),minIntervalMs:0,fetcher:async()=>{
    calls++;return Response.json({code:429},{status:429,headers:{'retry-after':'60'}});
  }});
  await assert.rejects(client.get(route,query));
  await assert.rejects(client.withSignal(new AbortController().signal).get(route,query),error=>error instanceof GmgnError&&error.reason==='GMGN_RATE_LIMITED');
  assert.equal(calls,1);
});

test('HTTP scope cancellation bounds response bodies and never fetches when already aborted',async()=>{
  const controller=new AbortController(),entered=deferred<void>();let calls=0,bodyController:ReadableStreamDefaultController<Uint8Array>|undefined;
  const fetcher:typeof fetch=async()=>{calls++;entered.resolve();return new Response(new ReadableStream<Uint8Array>({start(c){bodyController=c;}}));};
  const work=jsonRequest('https://example.test/',{},scopedFetcher(fetcher,controller.signal)),rejected=assert.rejects(work);
  await entered.promise;await new Promise(resolve=>setImmediate(resolve));controller.abort();await rejected;
  bodyController?.close();await assert.rejects(jsonRequest('https://example.test/',{signal:controller.signal},fetcher));assert.equal(calls,1);
});
