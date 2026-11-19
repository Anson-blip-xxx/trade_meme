import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ChainEventWriterRunner} from '../src/chain-event-writer.js';
import {ChainStreamStore,type ChainEvent} from '../src/chain-stream-store.js';

const wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40),peer='0x'+'3'.repeat(40);
const event=(n:number):ChainEvent=>({id:n.toString(16).padStart(64,'0'),chain:'bsc',kind:'token_transfer',wallet,tokenAddress:token,
  from:wallet,to:peer,amountAtomic:'5',txHash:'0x'+n.toString(16).padStart(64,'0'),blockNumber:n,blockHash:'0x'+'4'.repeat(63)+(n%16).toString(16),
  eventIndex:0,observedAt:new Date().toISOString(),source:'live',verification:'rpc_observed',removed:false});
const waitFor=async(test:()=>boolean,timeoutMs=5_000)=>{const deadline=Date.now()+timeoutMs;while(!test()){
  if(Date.now()>=deadline)throw new Error('WAIT_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,10));}};

test('live chain writer persists events in its worker and reports durable counts',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'chain-event-writer-')),database=join(directory,'events.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const writer=new ChainEventWriterRunner({database,maxBytes:16*1024*1024,capacity:8,batchSize:4});writer.start();
  assert.equal(writer.enqueue(event(1)),true);assert.equal(writer.enqueue(event(1)),true);
  await waitFor(()=>writer.status().completed===1);const before=writer.status();
  assert.equal(before.inserted,1);assert.equal(before.insertedByChain.bsc,1);assert.equal(before.coalesced,1);
  assert.equal(await writer.stop(),true);
  assert.equal(writer.status().state,'stopped');assert.equal(writer.status().shutdownDrained,true);
  const store=new ChainStreamStore(database,16*1024*1024);t.after(()=>store.close());
  assert.equal(store.stats().events,1);assert.equal(store.recent()[0].txHash,event(1).txHash);
});

test('live chain writer bounds admission and durably marks a collection gap',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'chain-event-writer-cap-')),database=join(directory,'events.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const writer=new ChainEventWriterRunner({database,maxBytes:16*1024*1024,capacity:1,batchSize:1});
  assert.equal(writer.enqueue(event(1)),true);assert.equal(writer.enqueue(event(2)),false);
  assert.equal(writer.status().rejectedCapacity,1);assert.equal(writer.status().unpersistedEvents,1);
  writer.start();await waitFor(()=>writer.status().completed===1&&writer.status().pendingIncompleteReasons.length===0);
  assert.equal(await writer.stop(),true);
  const store=new ChainStreamStore(database,16*1024*1024);t.after(()=>store.close());
  assert.equal(store.stats().events,1);assert.equal(store.stats().incomplete,true);
});

test('live chain writer exposes accepted work abandoned by an unavailable worker on stop',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'chain-event-writer-stop-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const writer=new ChainEventWriterRunner({database:directory,maxBytes:16*1024*1024,capacity:2,batchSize:1,
    restartDelayMs:1_000,stopTimeoutMs:100});writer.start();assert.equal(writer.enqueue(event(1)),true);
  assert.equal(await writer.stop(),false);const status=writer.status();
  assert.equal(status.state,'stopped');assert.equal(status.shutdownDrained,false);assert.equal(status.droppedOnStop,1);
  assert.equal(status.unpersistedEvents,1);assert.equal(status.shutdownError,'CHAIN_EVENT_WRITER_SHUTDOWN_UNDRAINED');
});

test('live chain writer stop is idempotent while drain is in progress',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'chain-event-writer-idempotent-')),database=join(directory,'events.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const writer=new ChainEventWriterRunner({database,maxBytes:16*1024*1024,capacity:4,batchSize:1});writer.start();
  assert.equal(writer.enqueue(event(1)),true);const first=writer.stop(),second=writer.stop();
  assert.strictEqual(first,second);assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal(writer.status().shutdownDrained,true);assert.equal(writer.status().inserted,1);
});

test('worker restart reconciles a live row committed before its acknowledgement',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'chain-event-writer-reconcile-')),database=join(directory,'events.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const writer=new ChainEventWriterRunner({database,maxBytes:16*1024*1024,capacity:4,batchSize:1,restartDelayMs:10});writer.start();
  await waitFor(()=>writer.status().ready);const committed=new ChainStreamStore(database,16*1024*1024);
  try {assert.equal(committed.record(event(7)),true);}finally{committed.close();}
  const worker=(writer as unknown as {worker:{terminate:()=>Promise<number>}}).worker;await worker.terminate();
  await waitFor(()=>writer.status().ready&&writer.status().restarts>=1&&writer.status().inserted===1);
  const status=writer.status();assert.equal(status.insertedByChain.bsc,1);assert.equal(status.authoritativeLiveEvents,1);
  assert.deepEqual(status.authoritativeLiveByChain,{bsc:1,solana:0,robinhood:0});assert.equal(await writer.stop(),true);
});

test('live chain writer bounds SQLite busy waits and retries after a competing writer releases WAL',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'chain-event-writer-busy-')),database=join(directory,'events.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const owner=new ChainStreamStore(database,16*1024*1024);t.after(()=>owner.close());
  const writer=new ChainEventWriterRunner({database,maxBytes:16*1024*1024,capacity:4,batchSize:1,busyTimeoutMs:50});writer.start();
  await waitFor(()=>writer.status().ready);const locker=new DatabaseSync(database);t.after(()=>locker.close());
  locker.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;');assert.equal(writer.enqueue(event(2)),true);
  await new Promise(resolve=>setTimeout(resolve,90));locker.exec('COMMIT;');
  await waitFor(()=>writer.status().completed===1);const status=writer.status();
  assert.ok(status.failedAttempts>=1);assert.equal(status.inserted,1);assert.equal(status.droppedAfterRetries,0);
  assert.equal(await writer.stop(),true);
});
