import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {SourceObservationRunner} from '../src/source-observation-runner.js';
import {SourceCorroboration} from '../src/source-corroboration.js';
import {MemeObserver} from '../src/meme-observer.js';
import type {AveSignalObservation} from '../src/providers/ave-signals.js';

const address='0x610a36f996650be0561f5d74d36b7e73520a7777';
function observation():AveSignalObservation {
  const now=new Date(),observedAt=now.toISOString();
  return {id:'1',observedAt,name:'Worker Token',symbol:'WORK',signal:{source:'ave',sourceEventId:`ave:signal:${'a'.repeat(64)}`,
    token:{chain:'bsc',address},occurredAt:new Date(now.getTime()-1000).toISOString(),text:'worker isolation',evidenceUrls:[],claim:'unspecified'}};
}
async function waitFor(check:()=>boolean,timeout=3000){
  const until=Date.now()+timeout;while(!check()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(check(),true);
}

test('source observation worker keeps a 150ms research write off the event loop',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'source-observation-worker-')),
    sourcePath=join(dir,'source.sqlite'),memePath=join(dir,'meme.sqlite');
  const source=new SourceCorroboration(sourcePath,{maxBytes:8*1024*1024,maxEvents:100});
  const meme=new MemeObserver({database:memePath,maxBytes:8*1024*1024,activeWindowSec:7200,
    marketBatch:async()=>[]});
  const runner=new SourceObservationRunner({source:{database:sourcePath,maxBytes:8*1024*1024,maxEvents:100},
    meme:{database:memePath,activeWindowSec:7200,chains:['bsc']},testDelayMs:150,requestTimeoutMs:2000});
  try {
    runner.start();await waitFor(()=>runner.status().ready);
    const started=performance.now(),work=runner.submit(observation());
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(performance.now()-started<100,'worker research blocked the main event loop');
    assert.deepEqual(await work,{});assert.ok(performance.now()-started>=130);
    assert.deepEqual(source.assess({chain:'bsc',address}).freshSources,['ave']);
    assert.equal(meme.list().total,1);
  }finally{await runner.stop();source.close();await meme.close();rmSync(dir,{recursive:true,force:true});}
});

test('a timed-out source observation terminates the worker and rejects its pending request',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'source-observation-timeout-')),sourcePath=join(dir,'source.sqlite');
  const source=new SourceCorroboration(sourcePath,{maxBytes:8*1024*1024,maxEvents:100});
  const runner=new SourceObservationRunner({source:{database:sourcePath,maxBytes:8*1024*1024,maxEvents:100},
    testDelayMs:500,requestTimeoutMs:100});
  try {
    runner.start();await waitFor(()=>runner.status().ready);
    await assert.rejects(runner.submit(observation()),/SOURCE_OBSERVATION_WORKER_TIMEOUT/);
    assert.equal(runner.status().inFlight,0);assert.equal(runner.status().error,'SOURCE_OBSERVATION_WORKER_TIMEOUT');
  }finally{await runner.stop();source.close();rmSync(dir,{recursive:true,force:true});}
});
