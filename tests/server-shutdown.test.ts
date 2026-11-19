import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,get} from 'node:http';
import type {Socket} from 'node:net';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {Store} from '../src/store.js';
import {ScanArchive} from '../src/scan-archive.js';
import {buildDashboard} from '../src/dashboard.js';
import {SERVICE_SHUTDOWN_DEADLINE_MS,buildServer,shutdownService} from '../src/server.js';
import {config,pass,providers,signal} from './helpers.js';

function deferred<T>() {
  let resolve!:(value:T|PromiseLike<T>)=>void;
  let reject!:(reason?:unknown)=>void;
  const promise=new Promise<T>((accept,fail)=>{resolve=accept;reject=fail;});
  return {promise,resolve,reject};
}

test('shutdown forces an unfinished HTTP request closed after grace and completes before its deadline',async t=>{
  const entered=deferred<void>();
  let activeSocket:Socket|undefined;
  const server=createServer(req=>{activeSocket=req.socket;entered.resolve();});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const request=get(`http://127.0.0.1:${(server.address() as {port:number}).port}/unfinished`);
  request.on('error',()=>{});
  t.after(async()=>{
    request.destroy();server.closeAllConnections();
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  await entered.promise;
  let runtimeFenced=false,runtimeCloseStarted=false;
  const started=performance.now();
  const closing=shutdownService({servers:[server],beginRuntimeClose:()=>{runtimeFenced=true;},closeRuntime:()=>{
    assert.equal(runtimeFenced,true);runtimeCloseStarted=true;
  },graceMs:20,deadlineMs:250});
  assert.equal(runtimeFenced,true);assert.equal(runtimeCloseStarted,false);
  const result=await closing,elapsed=performance.now()-started;
  assert.equal(runtimeCloseStarted,true);
  assert.equal(result.timedOut,false);assert.deepEqual(result.errors,[]);
  assert.equal(activeSocket?.destroyed,true);assert.ok(elapsed<250,`shutdown took ${elapsed}ms`);
});

test('shutdown drains an admitted async handler before runtime closes its store',async t=>{
  const cfg=config(),store=new Store(':memory:'),checks=providers(),entered=deferred<void>(),release=deferred<void>();
  let runtimeClosed=false,finishedBeforeClose=false;
  checks.safety=async()=>{entered.resolve();await release.promise;return pass();};
  const originalFinish=store.finish.bind(store);
  store.finish=(...args)=>{assert.equal(runtimeClosed,false);finishedBeforeClose=true;return originalFinish(...args);};
  const server=buildServer(cfg,store,checks);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const request=fetch(base+'/v1/signals',{method:'POST',headers:{authorization:`Bearer ${cfg.ingestToken}`,
    'content-type':'application/json'},body:JSON.stringify(signal({occurredAt:new Date().toISOString()}))}).catch(()=>undefined);
  t.after(async()=>{
    release.resolve();server.closeAllConnections();
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(!runtimeClosed)store.close();await request;
  });
  await entered.promise;
  const closing=shutdownService({servers:[server],beginRuntimeClose:()=>{},closeRuntime:()=>{
    assert.equal(finishedBeforeClose,true);runtimeClosed=true;store.close();
  },graceMs:10,deadlineMs:500});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(runtimeClosed,false,'destroying the request socket must not close the store under its handler');
  release.resolve();
  const result=await closing;
  assert.equal(result.timedOut,false);assert.deepEqual(result.errors,[]);assert.equal(runtimeClosed,true);
  await request;
});

test('shutdown drains a dashboard overview handler after forcing its socket closed',async t=>{
  const cfg=config(),archive=new ScanArchive(':memory:'),entered=deferred<void>(),release=deferred<void>();
  cfg.dashboard.token='dashboard-shutdown-test-token-123456789';
  let activeSocket:Socket|undefined,overviewFinished=false,runtimeClosed=false;
  const dashboard=buildDashboard(cfg,{archive,overview:async()=>{
    entered.resolve();await release.promise;overviewFinished=true;return {ok:true};
  },orders:()=>({items:[]})});
  dashboard.on('connection',socket=>{activeSocket=socket;});
  dashboard.listen(0,'127.0.0.1');await once(dashboard,'listening');
  const request=fetch(`http://127.0.0.1:${(dashboard.address() as {port:number}).port}/dashboard/api/overview`,
    {headers:{'x-dashboard-access':cfg.dashboard.token}}).catch(()=>undefined);
  t.after(async()=>{
    release.resolve();dashboard.closeAllConnections();
    if(dashboard.listening)await new Promise<void>(resolve=>dashboard.close(()=>resolve()));
    if(!runtimeClosed)archive.close();await request;
  });
  await entered.promise;
  const closing=shutdownService({servers:[dashboard],beginRuntimeClose:()=>{},closeRuntime:()=>{
    assert.equal(overviewFinished,true);runtimeClosed=true;archive.close();
  },graceMs:10,deadlineMs:500});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(activeSocket?.destroyed,true);assert.equal(runtimeClosed,false);
  release.resolve();
  const result=await closing;
  assert.equal(result.timedOut,false);assert.deepEqual(result.errors,[]);assert.equal(runtimeClosed,true);
  await request;
});

test('shutdown has a production deadline below systemd timeout and observes cleanup rejection after timing out',async()=>{
  assert.ok(SERVICE_SHUTDOWN_DEADLINE_MS<120_000);
  const runtime=deferred<void>(),started=performance.now();
  const result=await shutdownService({servers:[],beginRuntimeClose:()=>{},closeRuntime:()=>runtime.promise,
    graceMs:5,deadlineMs:30});
  const elapsed=performance.now()-started;
  assert.equal(result.timedOut,true);assert.ok(elapsed<200,`shutdown took ${elapsed}ms`);
  runtime.reject(new Error('LATE_RUNTIME_CLOSE_FAILURE'));
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal((result.errors[0] as Error).message,'LATE_RUNTIME_CLOSE_FAILURE');
});
