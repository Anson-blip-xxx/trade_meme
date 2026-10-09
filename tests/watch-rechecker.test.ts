import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ScanArchive} from '../src/scan-archive.js';
import {WatchRechecker} from '../src/watch-rechecker.js';
import type {Signal,Report} from '../src/types.js';
import type {Stored} from '../src/store.js';

const start=Date.parse('2026-10-09T00:00:00.000Z'),iso=(n:number)=>new Date(start+n).toISOString();
const address='0x'+'a'.repeat(40),second='0x'+'b'.repeat(40);
const config={windowSec:600,intervalSec:120,maxSignalAgeSec:600};
function signal(id='one',patch:Partial<Signal>={}):Signal {
  return {source:'gmgn',sourceEventId:id,occurredAt:iso(0),token:{chain:'bsc',address},
    text:'PRIVATE_RAW_BODY',evidenceUrls:[],claim:'community',...patch};
}
function report(s:Signal,id:string,receivedAt=iso(0),evaluatedAt=iso(1000),patch:Partial<Report>={}):Report {
  const check={status:'unknown' as const,reasons:['NOT_PROVEN'],facts:{},checkedAt:evaluatedAt};
  return {id,signal:s,receivedAt,evaluatedAt,validUntil:new Date(Date.parse(evaluatedAt)+60000).toISOString(),mode:'live',
    policyVersion:'test',decision:'WATCH',buyEligible:false,executionEnabled:false,reasons:['NOT_PROVEN'],
    provenance:check,safety:check,narrative:{...check,evidence:[]},...patch};
}
function capture(archive:ScanArchive,s=signal(),id=s.sourceEventId,receivedAt=iso(0),evaluatedAt=iso(1000),patch:Partial<Report>={}):Stored {
  const entry:Stored={id,signal:s,receivedAt,status:'completed',report:report(s,id,receivedAt,evaluatedAt,patch)};
  archive.capture(entry);return entry;
}
function fixture(options:Partial<typeof config>={},path=':memory:') {
  let time=1000;
  const now=()=>new Date(start+time),archive=new ScanArchive(path,{now});
  archive.configureWatch({...config,...options});
  return {archive,now,set:(n:number)=>{time=n;}};
}

test('WATCH recheck updates the original row without renewing occurrence or first receipt',async()=>{
  const f=fixture();let evaluated=0;
  try {
    capture(f.archive);f.set(121000);
    const worker=new WatchRechecker({archive:f.archive,now:f.now,evaluate:async(s,id)=>{
      evaluated++;assert.equal(s.occurredAt,iso(0));assert.equal(id.receivedAt,iso(0));
      assert.equal(s.text,'');return report(s,id.id,id.receivedAt,f.now().toISOString());
    }});
    await worker.runOnce();
    const item=f.archive.get('one')!;
    assert.equal(evaluated,1);assert.equal(f.archive.list().total,1);assert.equal(item.receivedAt,iso(0));
    assert.equal(item.occurredAt,iso(0));assert.equal(item.evaluatedAt,iso(121000));
    assert.deepEqual(item.observation,{state:'scheduled',firstReceivedAt:iso(0),endsAt:iso(600000),
      nextCheckAt:iso(241000),lastCheckAt:iso(121000),attempts:1});
    await worker.runOnce();assert.equal(evaluated,1);
    f.set(600000);assert.equal(f.archive.get('one')!.observation!.endReason,'SIGNAL_EXPIRED');
    await worker.runOnce();assert.equal(evaluated,1);
  } finally {f.archive.close();}
});

test('deadline is the lesser of original signal age and reception window, including legacy rows',()=>{
  const f=fixture({windowSec:300,maxSignalAgeSec:600});
  try {
    capture(f.archive);assert.equal(f.archive.get('one')!.observation!.endsAt,iso(300000));
    f.set(300000);assert.equal(f.archive.get('one')!.observation!.endReason,'WINDOW_EXPIRED');
    f.set(401000);capture(f.archive,signal('late'),undefined,iso(400000),iso(401000));
    assert.equal(f.archive.get('late')!.observation!.endsAt,iso(600000));
    f.archive.capture(capture(f.archive,signal('late'),undefined,iso(400000),iso(401000)));
    assert.equal(f.archive.get('late')!.observation!.endsAt,iso(600000));
  } finally {f.archive.close();}
  let time=1000;
  const archive=new ScanArchive(':memory:',{now:()=>new Date(start+time)});
  try {
    capture(archive);archive.configureWatch(config);
    assert.equal(archive.get('one')!.observation!.endReason,'LEGACY_SIGNAL_UNAVAILABLE');
    time=700000;capture(archive,signal('expired'),undefined,iso(0),iso(1000));
    assert.equal(archive.get('expired')!.observation!.endReason,'SIGNAL_EXPIRED');
    assert.equal(archive.watchStatus().scheduled,0);
  } finally {archive.close();}
});

test('new same-CA signals supersede older jobs across sources; stale completion cannot enter',async()=>{
  const f=fixture();let finish!:(r:Report)=>void,entryCount=0;
  try {
    capture(f.archive);f.set(121000);
    const worker=new WatchRechecker({archive:f.archive,now:f.now,
      evaluate:async(s,id)=>new Promise(resolve=>{finish=resolve;}),entry:async()=>{entryCount++;}});
    const run=worker.runOnce();await new Promise(resolve=>setImmediate(resolve));
    const next=signal('two',{source:'debot',occurredAt:iso(121000)});
    f.set(122000);capture(f.archive,next,'two',iso(121000),iso(122000));
    finish(report(signal(),'one',iso(0),iso(122000),{decision:'BUY_CANDIDATE',buyEligible:true}));await run;
    assert.equal(entryCount,0);assert.equal(f.archive.get('one')!.decision,'WATCH');
    assert.equal(f.archive.get('one')!.observation!.endReason,'SUPERSEDED');
    assert.equal(f.archive.watchStatus().scheduled,1);
    // Replaying the old completed source event cannot promote it back to the head.
    capture(f.archive);assert.equal(f.archive.get('one')!.observation!.endReason,'SUPERSEDED');
    f.set(242000);assert.equal(f.archive.claimWatch()?.id,'two');
  } finally {f.archive.close();}
});

test('a later received older-completing signal cannot replace the actual newest signal head',()=>{
  const f=fixture();
  try {
    f.set(101000);capture(f.archive,signal('new',{occurredAt:iso(100000)}),'new',iso(100000),iso(101000));
    capture(f.archive,signal('old'),'old',iso(0),iso(1000));
    assert.equal(f.archive.get('old')!.observation!.endReason,'SUPERSEDED');
    assert.equal(f.archive.get('new')!.observation!.state,'scheduled');
  } finally {f.archive.close();}
});

test('late arrival with an older occurrence cannot cancel the newer event or its in-flight lease',()=>{
  const f=fixture();
  try {
    f.set(101000);capture(f.archive,signal('new',{occurredAt:iso(100000)}),'new',iso(100000),iso(101000));
    f.set(221000);const claim=f.archive.claimWatch()!;assert.equal(claim.id,'new');
    f.set(222000);capture(f.archive,signal('late',{occurredAt:iso(0)}),'late',iso(221000),iso(222000));
    assert.equal(f.archive.get('late')!.observation!.endReason,'SUPERSEDED');
    assert.equal(f.archive.get('new')!.observation!.state,'processing');
    const result=f.archive.finishWatch(claim.id,claim.claimId,report(claim.signal,claim.id,claim.receivedAt,iso(222000)));
    assert.equal(result.accepted,true);assert.equal(f.archive.get('new')!.observation!.endsAt,iso(700000));
  } finally {f.archive.close();}
});

test('queue identity includes the chain and retention removes the associated job',()=>{
  let time=1000;
  const archive=new ScanArchive(':memory:',{retentionDays:1,maxEntries:2,now:()=>new Date(start+time)});
  archive.configureWatch(config);
  try {
    capture(archive);
    capture(archive,signal('other-chain',{token:{chain:'robinhood',address}}));
    assert.equal(archive.watchStatus().scheduled,2);
    time=2000;capture(archive,signal('new-token',{token:{chain:'bsc',address:second}}),undefined,iso(1000),iso(2000));
    assert.equal(archive.watchStatus().scheduled,2);assert.equal(archive.get('one'),undefined);
    time=86402000;assert.equal(archive.list().total,0);
    assert.deepEqual(archive.watchStatus(),{scheduled:0,processing:0,ended:0,due:0});
  } finally {archive.close();}
});

test('a far-future processing signal cannot pin the token head or suppress later valid WATCH events',()=>{
  const f=fixture();
  try {
    const future=signal('future',{occurredAt:iso(86400000)});
    f.archive.capture({id:'future',signal:future,receivedAt:iso(0),status:'processing'});
    capture(f.archive,future);
    assert.equal(f.archive.get('future')!.observation!.endReason,'SIGNAL_TIME_IN_FUTURE');
    f.set(602000);
    capture(f.archive,signal('valid',{occurredAt:iso(600000)}),'valid',iso(601000),iso(602000));
    assert.equal(f.archive.get('valid')!.observation!.state,'scheduled');
    f.archive.configureWatch(config);
    assert.equal(f.archive.get('valid')!.observation!.state,'scheduled');
    f.set(722000);assert.equal(f.archive.claimWatch()?.id,'valid');
  } finally {f.archive.close();}
});

test('failure keeps a bounded retry; cooldown and repeated dashboard reads make no provider calls',async()=>{
  const f=fixture();let calls=0,defer=true;
  try {
    capture(f.archive);f.set(121000);
    const worker=new WatchRechecker({archive:f.archive,now:f.now,shouldDefer:()=>defer?'GMGN_RATE_LIMITED':undefined,
      evaluate:async()=>{calls++;throw new Error('api_key=DO_NOT_PERSIST');}});
    await worker.runOnce();assert.equal(worker.getStatus().deferredReason,'GMGN_RATE_LIMITED');
    assert.equal(f.archive.get('one')!.observation!.attempts,0);
    for(let i=0;i<5;i++){f.archive.list();f.archive.get('one');worker.getStatus();}
    assert.equal(calls,0);defer=false;await worker.runOnce();
    assert.equal(calls,1);assert.equal(worker.getStatus().lastError,'RECHECK_FAILED');
    assert.equal(f.archive.get('one')!.observation!.nextCheckAt,iso(241000));
    f.set(241000);await worker.runOnce();assert.equal(calls,2);
    f.set(600000);await worker.runOnce();assert.equal(calls,2);
    assert.equal(f.archive.get('one')!.observation!.state,'ended');
  } finally {f.archive.close();}
});

test('only one global evaluation runs; stop waits and cancels entry from the in-flight evaluation',async()=>{
  const f=fixture();let resolve!:(value:Report)=>void,calls=0,entries=0;
  try {
    capture(f.archive);f.set(121000);
    const worker=new WatchRechecker({archive:f.archive,now:f.now,evaluate:async()=>{calls++;return new Promise(done=>{resolve=done;});},
      entry:async()=>{entries++;}});
    const first=worker.runOnce(),second=worker.runOnce();assert.equal(first,second);
    await new Promise(done=>setImmediate(done));let stopped=false;
    const stop=worker.stop().then(()=>{stopped=true;});await new Promise(done=>setImmediate(done));
    assert.equal(stopped,false);resolve(report(signal(),'one',iso(0),iso(121000),{decision:'BUY_CANDIDATE',buyEligible:true}));
    await stop;assert.equal(calls,1);assert.equal(entries,0);assert.equal(f.archive.get('one')!.decision,'WATCH');
    assert.equal(f.archive.get('one')!.observation!.state,'scheduled');
  } finally {f.archive.close();}
});

test('expired evaluation cannot promote or enter; expired decision remains WATCH; fresh eligible can enter once',async()=>{
  for(const scenario of ['window','decision','eligible'] as const) {
    const f=fixture();let entries=0;
    try {
      capture(f.archive);f.set(121000);
      const worker=new WatchRechecker({archive:f.archive,now:f.now,evaluate:async(s,id)=>{
        if(scenario==='window')f.set(600000);
        return report(s,id.id,id.receivedAt,f.now().toISOString(),{decision:'BUY_CANDIDATE',buyEligible:true,
          ...(scenario==='decision'?{validUntil:iso(121000)}:{})});
      },entry:async()=>{entries++;}});
      await worker.runOnce();await worker.runOnce();
      assert.equal(entries,scenario==='eligible'?1:0);
      assert.equal(f.archive.get('one')!.performance!==undefined,scenario==='eligible');
      assert.equal(f.archive.get('one')!.decision,scenario==='eligible'?'BUY_CANDIDATE':'WATCH');
    } finally {f.archive.close();}
  }
});

test('persistent leases survive restart, then recover without extending the original cutoff',()=>{
  const dir=mkdtempSync(join(tmpdir(),'watch-queue-')),path=join(dir,'scans.sqlite');let time=1000;
  const open=()=>{const archive=new ScanArchive(path,{now:()=>new Date(start+time)});archive.configureWatch(config);return archive;};
  let archive=open();
  try {
    capture(archive);time=121000;const first=archive.claimWatch()!;assert.equal(first.id,'one');archive.close();
    time=122000;archive=open();assert.equal(archive.claimWatch(),undefined);
    assert.equal(archive.get('one')!.observation!.state,'processing');
    time=421000;const next=archive.claimWatch()!;assert.equal(next.id,'one');assert.notEqual(next.claimId,first.claimId);
    assert.equal(next.attempts,2);assert.equal(next.endsAt,iso(600000));
    const stale=archive.finishWatch(first.id,first.claimId,report(first.signal,first.id,first.receivedAt,iso(time)));
    assert.equal(stale.accepted,false);
    archive.close();time=600000;archive=open();assert.equal(archive.get('one')!.observation!.endReason,'SIGNAL_EXPIRED');
    assert.equal(archive.claimWatch(),undefined);
  } finally {archive.close();rmSync(dir,{recursive:true,force:true});}
});

test('social score only prioritizes due tasks with bounded boost and one task per cycle',async()=>{
  const f=fixture();const seen:string[]=[];
  try {
    capture(f.archive);f.set(10000);
    const s=signal('boost',{token:{chain:'bsc',address:second},occurredAt:iso(9000)});
    capture(f.archive,s,'boost',iso(9000),iso(10000),{social:{score:20,scope:'research_priority',endorsementVerified:false,
      signals:[{person:'synthetic',kind:'ca_post',weight:20,sourceUrl:'https://x.com/i/web/status/1',verification:'first_party'}]}});
    const worker=new WatchRechecker({archive:f.archive,now:f.now,evaluate:async(s,id)=>{
      seen.push(id.id);return report(s,id.id,id.receivedAt,f.now().toISOString());}});
    f.set(121000);await worker.runOnce();assert.deepEqual(seen,['one']); // boosted task is not due yet
    f.set(130000);await worker.runOnce();assert.deepEqual(seen,['one','boost']);
  } finally {f.archive.close();}
  const other=fixture();
  try {
    capture(other.archive);other.set(10000);
    capture(other.archive,signal('boost',{token:{chain:'bsc',address:second}}),'boost',iso(9000),iso(10000),
      {social:{score:20,scope:'research_priority',endorsementVerified:false,
        signals:[{person:'synthetic',kind:'ca_post',weight:20,sourceUrl:'https://x.com/i/web/status/1',verification:'first_party'}]}});
    other.set(130000);assert.equal(other.archive.claimWatch()?.id,'boost');
  } finally {other.archive.close();}
});

test('durable recheck signals exclude raw text, narrative bodies, copied credentials and arbitrary URLs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'watch-minimal-')),path=join(dir,'scans.sqlite'),f=fixture({},path);
  try {
    const s=signal('public-id',{evidenceUrls:['https://x.com/name/status/123?api_key=PRIVATE_QUERY#SECRET',
      'https://evil.example/api?key=PRIVATE_QUERY','https://user:PRIVATE_PASSWORD@x.com/name/status/44'],
      creationTx:'0x'+'c'.repeat(64)});
    capture(f.archive,s);f.set(121000);const claim=f.archive.claimWatch()!;
    assert.equal(claim.signal.text,'');assert.deepEqual(claim.signal.evidenceUrls,['https://x.com/i/web/status/123']);
    assert.equal(claim.signal.creationTx,s.creationTx);assert.equal(claim.signal.vendorNarrative,undefined);
    f.archive.close();
    const body=readFileSync(path).toString();
    for(const secret of ['PRIVATE_RAW_BODY','PRIVATE_QUERY','PRIVATE_PASSWORD'])assert.equal(body.includes(secret),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

// Drain promises between fake timer steps: the worker deliberately serializes
// local defer checks, archive claims and evaluation before scheduling again.
async function flushWorker():Promise<void> {for(let index=0;index<20;index++)await Promise.resolve();}
function timedArchive():ScanArchive {
  const archive=new ScanArchive(':memory:');archive.configureWatch(config);capture(archive);return archive;
}

for(const busyReason of ['SCANNER_BUSY','RESEARCH_BUSY'])test(`${busyReason} retries local availability inside the current round and keeps a full interval after actual work`,async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:start+121000});
  const archive=timedArchive();let checks=0,evaluations=0;
  const worker=new WatchRechecker({archive,intervalMs:120000,maxPerCycle:1,
    shouldDefer:()=>{checks++;return Date.now()<start+150000?busyReason:undefined;},
    evaluate:async(s,id)=>{evaluations++;return report(s,id.id,id.receivedAt,new Date().toISOString());}});
  try {
    worker.start();await flushWorker();assert.equal(checks,1);assert.equal(evaluations,0);
    assert.equal(archive.get('one')!.observation!.attempts,0);
    t.mock.timers.tick(9999);await flushWorker();assert.equal(checks,1);
    t.mock.timers.tick(1);await flushWorker();assert.equal(checks,2);assert.equal(evaluations,0);
    t.mock.timers.tick(10000);await flushWorker();assert.equal(checks,3);
    t.mock.timers.tick(10000);await flushWorker();assert.equal(checks,4);assert.equal(evaluations,1);
    assert.equal(archive.get('one')!.evaluatedAt,iso(151000));
    assert.equal(archive.get('one')!.occurredAt,iso(0));assert.equal(archive.get('one')!.receivedAt,iso(0));
    assert.equal(worker.getStatus().running,true);assert.equal(worker.getStatus().deferredReason,undefined);
    t.mock.timers.tick(119999);await flushWorker();assert.equal(evaluations,1);assert.equal(checks,4);
    t.mock.timers.tick(1);await flushWorker();assert.equal(evaluations,2);assert.equal(checks,5);
    await worker.stop();t.mock.timers.tick(120000);await flushWorker();assert.equal(checks,5);
  } finally {await worker.stop();archive.close();}
});

test('provider cooldown and busy workers with no due jobs retain normal polling instead of short retries',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:start+121000});
  const archive=timedArchive();let checks=0,evaluations=0;
  const worker=new WatchRechecker({archive,intervalMs:120000,shouldDefer:()=>{checks++;return 'GMGN_RATE_LIMITED';},
    evaluate:async(s,id)=>{evaluations++;return report(s,id.id,id.receivedAt,new Date().toISOString());}});
  try {
    worker.start();await flushWorker();t.mock.timers.tick(119999);await flushWorker();
    assert.equal(checks,1);assert.equal(evaluations,0);
    t.mock.timers.tick(1);await flushWorker();assert.equal(checks,2);assert.equal(evaluations,0);
    assert.equal(archive.get('one')!.observation!.attempts,0);
  } finally {await worker.stop();archive.close();}
  const empty=new ScanArchive(':memory:');empty.configureWatch(config);let emptyChecks=0;
  const emptyWorker=new WatchRechecker({archive:empty,intervalMs:120000,shouldDefer:()=>{emptyChecks++;return 'SCANNER_BUSY';},
    evaluate:async()=>{throw new Error('No job should be claimed');}});
  try {
    emptyWorker.start();await flushWorker();t.mock.timers.tick(119999);await flushWorker();assert.equal(emptyChecks,1);
    t.mock.timers.tick(1);await flushWorker();assert.equal(emptyChecks,2);
  } finally {await emptyWorker.stop();empty.close();}
});

test('automatic scheduling waits a full interval after slow evaluation completion, including stop and restart',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:start+121000});
  const archive=timedArchive();let evaluations=0,resolve!:(value:Report)=>void;
  const worker=new WatchRechecker({archive,intervalMs:120000,evaluate:async(s,id)=>{
    evaluations++;if(evaluations===1)return new Promise(done=>{resolve=done;});
    return report(s,id.id,id.receivedAt,new Date().toISOString());
  }});
  try {
    worker.start();await flushWorker();assert.equal(evaluations,1);assert.equal(worker.getStatus().running,true);
    t.mock.timers.tick(50000);await flushWorker();assert.equal(evaluations,1);
    resolve(report(signal(),'one',iso(0),iso(171000)));await flushWorker();
    t.mock.timers.tick(10000);await flushWorker();await worker.stop();
    worker.start();worker.start();await flushWorker();assert.equal(evaluations,1);
    t.mock.timers.tick(109999);await flushWorker();assert.equal(evaluations,1);
    t.mock.timers.tick(1);await flushWorker();assert.equal(evaluations,2);
    assert.equal(archive.get('one')!.evaluatedAt,iso(291000));
  } finally {await worker.stop();archive.close();}
});

test('stopping a short busy retry cancels it, and restarting during old evaluation cannot apply stale results or create duplicate timers',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:start+121000});
  const archive=timedArchive();let busy=true,checks=0,evaluations=0,entries=0,resolve!:(value:Report)=>void;
  const worker=new WatchRechecker({archive,intervalMs:120000,shouldDefer:()=>{checks++;return busy?'SCANNER_BUSY':undefined;},
    evaluate:async(s,id)=>{evaluations++;if(evaluations===1)return new Promise(done=>{resolve=done;});
      return report(s,id.id,id.receivedAt,new Date().toISOString());},entry:async()=>{entries++;}});
  try {
    worker.start();await flushWorker();assert.equal(checks,1);await worker.stop();
    t.mock.timers.tick(10000);await flushWorker();assert.equal(checks,1);
    busy=false;worker.start();await flushWorker();assert.equal(evaluations,1);
    const stopping=worker.stop();worker.start();worker.start();
    resolve(report(signal(),'one',iso(0),iso(131000),{decision:'BUY_CANDIDATE',buyEligible:true}));
    await stopping;await flushWorker();assert.equal(entries,0);assert.equal(archive.get('one')!.decision,'WATCH');
    t.mock.timers.tick(119999);await flushWorker();assert.equal(evaluations,1);
    t.mock.timers.tick(1);await flushWorker();assert.equal(evaluations,2);assert.equal(checks,3);
    await worker.stop();t.mock.timers.tick(120000);await flushWorker();assert.equal(evaluations,2);
  } finally {await worker.stop();archive.close();}
});
