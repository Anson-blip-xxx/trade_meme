import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Worker} from 'node:worker_threads';
import {WalletHistory} from '../src/wallet-history.js';
import {WalletObserverRunner} from '../src/wallet-observer-runner.js';
import type {GmgnFeedPage} from '../src/scanner.js';

const evm=(value:number)=>'0x'+value.toString(16).padStart(40,'0');
const tx=(value:number)=>'0x'+value.toString(16).padStart(64,'0');
const waitFor=async(check:()=>boolean,timeoutMs=5_000)=>{const deadline=Date.now()+timeoutMs;while(!check()){
  if(Date.now()>=deadline)throw new Error('TEST_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,10));}};
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'wallet-observer-runner-'));return {dir,database:join(dir,'history.sqlite')};};
const page=(id:number):GmgnFeedPage=>{const fetchedAt=new Date().toISOString();return {chain:'bsc',kind:'kol',fetchedAt,payload:{chain:'bsc',list:[{
  chain:'bsc',side:'buy',maker:evm(id),base_address:evm(10_000+id),transaction_hash:tx(id),
  timestamp:Math.floor((Date.parse(fetchedAt)-1_000)/1_000),token_amount:'1',amount_usd:'2',price_usd:'2'}]}};};

test('feed persistence runs in the worker and never invokes WalletHistory writes in the parent isolate',async()=>{
  const f=fixture(),original=WalletHistory.prototype.recordTrades;let parentCalls=0;
  WalletHistory.prototype.recordTrades=function(){parentCalls++;throw new Error('PARENT_HISTORY_WRITE_CALLED');};
  const runner=new WalletObserverRunner({database:f.database,maxBytes:32*1024*1024,chains:['bsc'],intervalMs:60_000,
    maxRequestsPerCycle:1,restartDelayMs:10,client:{cooldownUntil:0,get:async()=>({chain:'bsc',rank:[]})}});
  try {
    runner.start();await waitFor(()=>runner.getStatus().ready);
    assert.deepEqual(runner.observeFeed(page(1)),{accepted:true});
    await waitFor(()=>runner.getStatus().worker.completedFeeds===1);
    assert.equal(await runner.stop(),true);assert.equal(parentCalls,0);
  } finally {WalletHistory.prototype.recordTrades=original;await runner.stop();}
  const history=new WalletHistory(f.database,{maxBytes:32*1024*1024});
  try {assert.equal(history.stats().events,1);assert.ok(history.getWallet('bsc',evm(1)));}
  finally {history.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('GMGN reads stay on the parent client while worker price samples are forwarded to the existing writer',async()=>{
  const f=fixture(),token=evm(20_000),requests:string[]=[],prices:unknown[][]=[];
  const client={cooldownUntil:0,async get(path:string){requests.push(path);
    if(path==='/v1/market/rank')return {chain:'bsc',rank:[{chain:'bsc',address:token,price:'1',price_change_percent1h:'10'}]};
    if(path==='/v1/market/token_top_traders')return {chain:'bsc',token_address:token,list:[]};
    if(path==='/v1/token/info')return {chain:'bsc',address:token,price:{price:'2'}};
    throw new Error('UNEXPECTED_ROUTE');}};
  const runner=new WalletObserverRunner({database:f.database,maxBytes:32*1024*1024,chains:['bsc'],intervalMs:60_000,
    maxRequestsPerCycle:3,restartDelayMs:10,client,priceWriter:{recordPriceDurable:async(...args)=>{prices.push(args);return {accepted:true};}}});
  try {
    runner.start();await waitFor(()=>runner.getStatus().worker.networkCompleted>=3);
    await waitFor(()=>runner.getStatus().worker.pricesForwarded===1);
    assert.deepEqual(requests.slice(0,3),['/v1/market/rank','/v1/market/token_top_traders','/v1/token/info']);
    assert.deepEqual(prices[0]?.slice(0,2),[{chain:'bsc',address:token},2]);
    assert.equal(await runner.stop(),true);
    const status=runner.getStatus();assert.equal(status.worker.networkFailed,0);assert.equal(status.worker.shutdownDrained,true);
  } finally {await runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('a rejected parent price admission is acknowledged back to the observer cycle',async()=>{
  const f=fixture(),token=evm(20_001);
  const client={cooldownUntil:0,async get(path:string){
    if(path==='/v1/market/rank')return {chain:'bsc',rank:[{chain:'bsc',address:token,price:'1',price_change_percent1h:'10'}]};
    if(path==='/v1/market/token_top_traders')return {chain:'bsc',token_address:token,list:[]};
    if(path==='/v1/token/info')return {chain:'bsc',address:token,price:{price:'2'}};
    throw new Error('UNEXPECTED_ROUTE');}};
  const runner=new WalletObserverRunner({database:f.database,maxBytes:32*1024*1024,chains:['bsc'],intervalMs:60_000,
    maxRequestsPerCycle:3,restartDelayMs:10,client,
    priceWriter:{recordPriceDurable:async()=>({accepted:false,reason:'WALLET_PRICE_WRITE_QUEUE_FULL'})}});
  try {
    runner.start();await waitFor(()=>runner.getStatus().lastCycle?.reasons?.includes('WALLET_PRICE_WRITE_QUEUE_FULL')===true);
    const status=runner.getStatus();assert.equal(status.worker.pricesForwarded,0);assert.equal(status.worker.pricesRejected,1);
    assert.equal(status.lastCycle?.status,'partial');assert.equal(await runner.stop(),true);
  } finally {await runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('a durable price ACK timeout retains the target and a late ingress result is observable',async()=>{
  const f=fixture(),token=evm(20_002);let release!:(value:{accepted:true})=>void;
  const durable=new Promise<{accepted:true}>(resolve=>{release=resolve;});
  const client={cooldownUntil:0,async get(path:string){
    if(path==='/v1/market/rank')return {chain:'bsc',rank:[{chain:'bsc',address:token,price:'1',price_change_percent1h:'10'}]};
    if(path==='/v1/market/token_top_traders')return {chain:'bsc',token_address:token,list:[]};
    if(path==='/v1/token/info')return {chain:'bsc',address:token,price:{price:'2'}};
    throw new Error('UNEXPECTED_ROUTE');}};
  const runner=new WalletObserverRunner({database:f.database,maxBytes:32*1024*1024,chains:['bsc'],intervalMs:60_000,
    maxRequestsPerCycle:3,priceAckTimeoutMs:30,restartDelayMs:10,client,
    priceWriter:{recordPriceDurable:()=>durable}});
  try {
    runner.start();
    await waitFor(()=>runner.getStatus().lastCycle?.reasons?.includes('WALLET_PRICE_WRITE_TIMEOUT')===true);
    let status=runner.getStatus();assert.equal(status.worker.priceAckTimeouts,1);
    assert.equal(status.marketSampling?.pendingTargets[0]?.address,token);
    release({accepted:true});await waitFor(()=>runner.getStatus().worker.priceLateResults===1);
    status=runner.getStatus();assert.equal(status.worker.pricesForwarded,1);assert.equal(status.worker.pricesRejected,0);
    assert.equal(await runner.stop(),true);
  } finally {release?.({accepted:true});await runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('worker restart retains a pending price target while an old durable result becomes a late ACK',async()=>{
  const f=fixture(),token=evm(20_003);let calls=0,release!:(value:{accepted:true})=>void;
  const first=new Promise<{accepted:true}>(resolve=>{release=resolve;});
  const client={cooldownUntil:0,async get(path:string){
    if(path==='/v1/market/rank')return {chain:'bsc',rank:[{chain:'bsc',address:token,price:'1',price_change_percent1h:'10'}]};
    if(path==='/v1/market/token_top_traders')return {chain:'bsc',token_address:token,list:[]};
    if(path==='/v1/token/info')return {chain:'bsc',address:token,price:{price:'2'}};
    throw new Error('UNEXPECTED_ROUTE');}};
  const runner=new WalletObserverRunner({database:f.database,maxBytes:32*1024*1024,chains:['bsc'],intervalMs:60_000,
    maxRequestsPerCycle:3,priceAckTimeoutMs:1_000,restartDelayMs:10,client,
    priceWriter:{recordPriceDurable:()=>++calls===1?first:Promise.resolve({accepted:true})}});
  try {
    runner.start();await waitFor(()=>calls===1);
    const worker=(runner as unknown as {worker?:Worker}).worker!;await worker.terminate();release({accepted:true});
    await waitFor(()=>runner.getStatus().ready&&runner.getStatus().worker.restarts===1);
    await waitFor(()=>calls>=2&&runner.getStatus().worker.pricesForwarded>=2);
    const status=runner.getStatus();assert.ok(status.worker.priceLateResults>=1);
    assert.equal(await runner.stop(),true);
  } finally {release?.({accepted:true});await runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('concurrent stop calls share one drain while a durable price ACK is pending',async()=>{
  const f=fixture(),token=evm(20_004);let called=false,release!:(value:{accepted:true})=>void;
  const durable=new Promise<{accepted:true}>(resolve=>{release=resolve;});
  const client={cooldownUntil:0,async get(path:string){
    if(path==='/v1/market/rank')return {chain:'bsc',rank:[{chain:'bsc',address:token,price:'1',price_change_percent1h:'10'}]};
    if(path==='/v1/market/token_top_traders')return {chain:'bsc',token_address:token,list:[]};
    if(path==='/v1/token/info')return {chain:'bsc',address:token,price:{price:'2'}};
    throw new Error('UNEXPECTED_ROUTE');}};
  const runner=new WalletObserverRunner({database:f.database,maxBytes:32*1024*1024,chains:['bsc'],intervalMs:60_000,
    maxRequestsPerCycle:3,priceAckTimeoutMs:1_000,restartDelayMs:10,stopTimeoutMs:2_000,client,
    priceWriter:{recordPriceDurable:()=>{called=true;return durable;}}});
  try {
    runner.start();await waitFor(()=>called);const first=runner.stop(),second=runner.stop();release({accepted:true});
    assert.deepEqual(await Promise.all([first,second]),[true,true]);assert.equal(runner.getStatus().state,'stopped');
    assert.equal((runner as unknown as {priceForwards:Map<string,unknown>}).priceForwards.size,0);
  } finally {release?.({accepted:true});await runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('stop fences new pages and drains all feed acknowledgements before the database closes',async()=>{
  const f=fixture(),runner=new WalletObserverRunner({database:f.database,maxBytes:32*1024*1024,chains:['bsc'],intervalMs:60_000,
    maxRequestsPerCycle:1,maxPendingFeeds:4,restartDelayMs:10,client:{cooldownUntil:0,get:async()=>({chain:'bsc',rank:[]})}});
  try {
    runner.start();await waitFor(()=>runner.getStatus().ready);
    assert.equal(runner.observeFeed(page(2)).accepted,true);assert.equal(runner.observeFeed(page(3)).accepted,true);
    const stopping=runner.stop();assert.equal(runner.observeFeed(page(4)).reason,'WALLET_OBSERVER_NOT_RUNNING');
    assert.equal(await stopping,true);const status=runner.getStatus();
    assert.equal(status.worker.completedFeeds,2);assert.equal(status.worker.pendingFeeds,0);assert.equal(status.worker.shutdownDrained,true);
    const history=new WalletHistory(f.database,{maxBytes:32*1024*1024});
    try {assert.equal(history.stats().events,2);}finally{history.close();}
  } finally {await runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('an unexpected worker exit replays unacknowledged state and restarts with an explicit counter',async()=>{
  const f=fixture(),runner=new WalletObserverRunner({database:f.database,maxBytes:32*1024*1024,chains:['bsc'],intervalMs:60_000,
    maxRequestsPerCycle:1,restartDelayMs:10,client:{cooldownUntil:0,get:async()=>({chain:'bsc',rank:[]})}});
  try {
    runner.start();await waitFor(()=>runner.getStatus().ready);
    const worker=(runner as unknown as {worker?:Worker}).worker!;await worker.terminate();
    await waitFor(()=>runner.getStatus().ready&&runner.getStatus().worker.restarts===1);
    assert.equal(runner.getStatus().worker.error,undefined);assert.equal(await runner.stop(),true);
  } finally {await runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('GMGN proxy concurrency remains global while a crashed worker request is still unresolved',async()=>{
  const f=fixture();let calls=0,active=0,peak=0,release!:()=>void;
  const first=new Promise<unknown>(resolve=>{release=()=>resolve({chain:'bsc',rank:[]});});
  const client={cooldownUntil:0,async get(){calls++;active++;peak=Math.max(peak,active);
    try {if(calls===1)return await first;return {chain:'bsc',rank:[]};}finally{active--;}}};
  const runner=new WalletObserverRunner({database:f.database,maxBytes:32*1024*1024,chains:['bsc'],intervalMs:20,
    maxRequestsPerCycle:1,maxProxyRequests:1,requestTimeoutMs:2_000,restartDelayMs:10,client});
  try {
    runner.start();await waitFor(()=>runner.getStatus().worker.networkInFlight===1&&calls===1);
    const worker=(runner as unknown as {worker?:Worker}).worker!;await worker.terminate();
    await waitFor(()=>runner.getStatus().ready&&runner.getStatus().worker.restarts===1);
    await waitFor(()=>runner.getStatus().worker.networkRejectedCapacity>0);
    assert.equal(calls,1);assert.equal(runner.getStatus().worker.networkInFlight,1);
    release();await waitFor(()=>calls>=2);
    assert.equal(peak,1);assert.ok(runner.getStatus().worker.networkCompleted>=1);
    assert.equal(await runner.stop(),true);
  } finally {release?.();await runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('feed persistence failure is retried finitely and reported as an explicit drop',async()=>{
  const f=fixture(),runner=new WalletObserverRunner({database:f.database,maxBytes:16_384,chains:['bsc'],intervalMs:60_000,
    maxRequestsPerCycle:1,maxFeedRetries:1,restartDelayMs:10,client:{cooldownUntil:0,get:async()=>({chain:'bsc',rank:[]})}});
  try {
    runner.start();await waitFor(()=>runner.getStatus().ready);
    assert.equal(runner.observeFeed(page(9)).accepted,true);
    await waitFor(()=>runner.getStatus().worker.droppedFeeds===1);
    const status=runner.getStatus();
    assert.equal(status.worker.completedFeeds,0);assert.equal(status.worker.failedFeeds,2);
    assert.equal(status.worker.retriedFeeds,1);assert.equal(status.worker.pendingFeeds,0);
    assert.equal(status.worker.error,'WALLET_HISTORY_CAPACITY_REACHED');
    assert.equal(await runner.stop(),true);
  } finally {await runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('a shutdown deadline reports undrained work instead of silently claiming success',async()=>{
  const f=fixture(),runner=new WalletObserverRunner({database:f.database,maxBytes:32*1024*1024,chains:['bsc'],intervalMs:60_000,
    maxRequestsPerCycle:1,restartDelayMs:10,stopTimeoutMs:100,requestTimeoutMs:1_000,
    client:{cooldownUntil:0,get:()=>new Promise(()=>{})}});
  try {
    runner.start();await waitFor(()=>runner.getStatus().worker.networkInFlight===1);
    assert.equal(await runner.stop(),false);const status=runner.getStatus();
    assert.equal(status.state,'stopped');assert.equal(status.worker.shutdownDrained,false);
    assert.equal(status.worker.shutdownError,'WALLET_OBSERVER_SHUTDOWN_UNDRAINED');
  } finally {await runner.stop();rmSync(f.dir,{recursive:true,force:true});}
});
