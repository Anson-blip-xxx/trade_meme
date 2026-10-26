import test from 'node:test';
import assert from 'node:assert/strict';
import {LatestWorkQueue} from '../src/latest-work-queue.js';

const fixture=(capacity=4,batchSize=2)=>{
  const scheduled:(()=>void)[]=[],values:number[]=[];
  const queue=new LatestWorkQueue<number>({capacity,batchSize,consume:value=>values.push(value),schedule:run=>scheduled.push(run)});
  const turn=()=>scheduled.shift()?.();
  return {queue,scheduled,values,turn};
};

test('latest work replaces a token in place and yields between bounded batches',()=>{
  const f=fixture();
  f.queue.enqueue('a',1);f.queue.enqueue('b',2);f.queue.enqueue('a',3);f.queue.enqueue('c',4);
  assert.equal(f.scheduled.length,1);assert.deepEqual(f.queue.status(),{pending:3,priorityPending:0,processed:0,replaced:1,
    dropped:0,priorityDropped:0,normalDropped:0,normalEvicted:0,errors:0});
  f.turn();assert.deepEqual(f.values,[2,3]);assert.equal(f.queue.status().pending,1);assert.equal(f.scheduled.length,1);
  f.turn();assert.deepEqual(f.values,[2,3,4]);assert.equal(f.queue.status().pending,0);
});

test('priority work overtakes normal work and evicts only normal work at capacity',()=>{
  const f=fixture(3,1);
  f.queue.enqueue('a',1);f.queue.enqueue('b',2);f.queue.enqueue('c',3);
  assert.equal(f.queue.enqueue('urgent',9,true),true);
  assert.equal(f.queue.enqueue('overflow',10),false);
  f.turn();assert.deepEqual(f.values,[9]);
  f.turn();f.turn();assert.deepEqual(f.values,[9,2,3]);
  assert.deepEqual(f.queue.status(),{pending:0,priorityPending:0,processed:3,replaced:0,dropped:2,
    priorityDropped:0,normalDropped:2,normalEvicted:1,errors:0});
});

test('priority frames for one token preserve a peak followed by a pullback in arrival order',()=>{
  const f=fixture();
  f.queue.enqueue('a',1);f.queue.enqueue('a',200,true);f.queue.enqueue('a',80,true);
  assert.equal(f.queue.status().priorityPending,2);
  f.turn();assert.deepEqual(f.values,[200,80]);
  f.queue.enqueue('b',4);f.queue.close();f.turn();
  assert.deepEqual(f.values,[200,80]);assert.equal(f.queue.enqueue('c',5),false);
});

test('priority overflow is explicit and never exceeds capacity',()=>{
  const f=fixture(2,1);
  assert.equal(f.queue.enqueue('a',1,true),true);
  assert.equal(f.queue.enqueue('a',2,true),true);
  assert.equal(f.queue.enqueue('a',3,true),false);
  assert.deepEqual(f.queue.status(),{pending:2,priorityPending:2,processed:0,replaced:0,dropped:1,
    priorityDropped:1,normalDropped:0,normalEvicted:0,errors:0});
  f.turn();f.turn();assert.deepEqual(f.values,[1,2]);
});

test('consumer and error-reporter failures do not strand later batches',()=>{
  const scheduled:(()=>void)[]=[],values:number[]=[];
  const queue=new LatestWorkQueue<number>({capacity:4,batchSize:1,schedule:run=>scheduled.push(run),
    consume:value=>{if(value===1)throw new Error('consumer failed');values.push(value);},onError:()=>{throw new Error('reporter failed');}});
  queue.enqueue('a',1);queue.enqueue('b',2);
  assert.doesNotThrow(()=>scheduled.shift()!());assert.equal(scheduled.length,1);
  scheduled.shift()!();assert.deepEqual(values,[2]);assert.deepEqual(queue.status(),
    {pending:0,priorityPending:0,processed:2,replaced:0,dropped:0,priorityDropped:0,normalDropped:0,normalEvicted:0,errors:1});
});
