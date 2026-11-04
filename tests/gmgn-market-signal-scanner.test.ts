import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {GmgnMarketArchiveError,GmgnMarketSignalScanner,normalizeGmgnMarketSignals,
  type GmgnMarketChain,type GmgnMarketSignalClient} from '../src/gmgn-market-signal-scanner.js';

const token=(n:number)=>bs58.encode(Buffer.alloc(32,n));
const base=Date.parse('2026-11-04T04:00:00.000Z');
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row=(n:number,at=base-1000,overrides:Record<string,unknown>={})=>{const type=Number(overrides.signal_type??12),key=type===20?'kol_wallets':'smart_degen_wallets';
  const wallets=[1,2,3].map(offset=>({address:token(100+n*3+offset),buy_timestamp:at/1000-offset,buy_amount:1}));
  return {id:id(n),token_address:token(n+1),signal_type:type,trigger_at:at/1000,trigger_mc:10_000,signal_times:1,
    data:{chain:'sol',address:token(n+1),symbol:`T${n}`,name:`Token ${n}`,...(type===12||type===20?{[key]:wallets}:{})},...overrides};};
const deferred=<T=void>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const client=(payload:unknown|(()=>Promise<unknown>)):GmgnMarketSignalClient=>({cooldownUntil:0,
  getMemeMarketSignals:()=>typeof payload==='function'?payload():Promise.resolve(payload)});
const liveClient=(payload:unknown|(()=>Promise<unknown>)):GmgnMarketSignalClient=>{let first=true;return client(async()=>{
  if(first){first=false;return [];}
  return typeof payload==='function'?payload():payload;
});};
const prime=async(scanner:GmgnMarketSignalScanner)=>{const cycle=await scanner.runOnce();await scanner.waitForIdle();
  assert.equal(cycle.accepted,0);};
const options=(extra:Partial<ConstructorParameters<typeof GmgnMarketSignalScanner>[0]>={})=>({client:client([row(1)]),
  chains:['sol'] as GmgnMarketChain[],intervalMs:1000,maxAgeSec:600,now:()=>new Date(base),onSignal:async()=>{},...extra});

test('strict normalization rejects wrong identity, timestamp, chain and malformed payloads',()=>{
  assert.equal(normalizeGmgnMarketSignals({},'sol').rejected,1);
  const result=normalizeGmgnMarketSignals([row(1),row(2,base,{id:'short'}),row(3,base,{token_address:'bad'}),
    row(4,base,{trigger_at:1}),row(5,base,{data:{chain:'bsc'}}),row(6,base,{signal_type:0}),
    row(7,base,{data:{chain:'sol',address:token(99)}})],'sol');
  assert.equal(result.received,7);assert.equal(result.observations.length,1);assert.equal(result.rejected,6);
  assert.equal(result.observations[0].signal.sourceEventId,`gmgn:market:sol:${id(1)}`);
  assert.equal(result.observations[0].signal.token.address,token(2));
});

test('route policy reserves full analysis for strong wallet buys and narrative events',async()=>{
  const rows=[row(1,base,{signal_type:12}),row(2,base,{signal_type:20}),row(3,base,{signal_type:6,signal_times:1}),
    row(4,base,{signal_type:6,signal_times:2}),row(5,base,{signal_type:10}),row(6,base,{signal_type:7}),
    row(7,base,{signal_type:13}),row(8,base,{signal_type:99}),row(9,base,{signal_type:11}),
    row(10,base,{signal_type:19}),row(11,base,{signal_type:17})],observed:string[]=[],analyzed:string[]=[];
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient(rows),onObservation:s=>{observed.push(s.sourceEventId);},
    onSignal:s=>{analyzed.push(s.sourceEventId);}}));
  await prime(scanner);
  const cycle=await scanner.runOnce();await scanner.waitForIdle();
  assert.equal(observed.length,11);assert.deepEqual(analyzed.map(value=>value.split(':').at(-1)),
    [id(1),id(2),id(7),id(9),id(10)]);
  assert.deepEqual(cycle.routes,{priority_analysis:2,narrative_analysis:3,conditional_analysis:2,negative_analysis:1,
    observation_only:2,unknown_research:1});
  assert.equal(cycle.queued,5);assert.equal(scanner.status().entryPipeline,false);assert.equal(scanner.status().countingPipeline,false);
});

test('price spikes and bundler sells keep their route and fast evidence but never enter full analysis',()=>{
  const observations=normalizeGmgnMarketSignals([
    row(1,base,{signal_type:6,signal_times:1}),row(2,base,{signal_type:6,signal_times:99}),
    row(3,base,{signal_type:10})],'sol').observations;
  assert.deepEqual(observations.map(item=>[item.route,item.analysisEligible]),[
    ['conditional_analysis',false],['conditional_analysis',false],['negative_analysis',false]]);
  assert.match(observations[1].signal.text,/price_spike/);
  assert.match(observations[2].signal.text,/bundler_sell/);
});

test('meme heat mechanics are retained as observation-only evidence',()=>{
  const observations=normalizeGmgnMarketSignals([1,2,3,4,5,8,9].map((signalType,index)=>
    row(index+1,base,{signal_type:signalType})),'sol').observations;
  assert.equal(observations.length,7);
  assert.ok(observations.every(item=>item.route==='observation_only'&&item.analysisEligible===false));
  assert.match(observations[1].signal.text,/dex_ad/);
  assert.match(observations[5].signal.text,/market_cap_level/);
});

test('wallet-labelled signals require three distinct recent positive vendor references before full analysis',async()=>{
  const weak=row(1,base,{data:{chain:'sol',address:token(2),smart_degen_wallets:[
    {address:token(90),buy_timestamp:base/1000,buy_amount:1},{address:token(90),buy_timestamp:base/1000,buy_amount:1},
    {address:token(91),buy_timestamp:base/1000-31,buy_amount:1},{address:token(92),buy_timestamp:base/1000,buy_amount:0}]}}),analyzed:string[]=[];
  const scanner=new GmgnMarketSignalScanner(options({client:client([weak]),onSignal:s=>{analyzed.push(s.sourceEventId);}}));
  const cycle=await scanner.runOnce();await scanner.waitForIdle();assert.equal(cycle.routes.priority_analysis,1);
  assert.equal(cycle.queued,0);assert.deepEqual(analyzed,[]);
  assert.match(normalizeGmgnMarketSignals([weak],'sol').observations[0].signal.text,/GMGN 标记聪明钱包引用 1/);
});

test('same-page IDs are deduplicated before observation, archive and analysis, using the dedicated poll lane with a bounded queue budget',async()=>{
  let schedule:unknown,observed=0,analyzed=0,archived=0;
  let first=true;const scanner=new GmgnMarketSignalScanner(options({client:{cooldownUntil:0,getMemeMarketSignals:async(_chain,value)=>{
    schedule=value;if(first){first=false;return [];}return [row(1),row(1)];}},onObservation:()=>{observed++;},onSignal:()=>{analyzed++;},
    onArchive:(_chain,rows)=>{archived+=rows.length;}}));
  await prime(scanner);
  const cycle=await scanner.runOnce();await scanner.waitForIdle();
  assert.deepEqual(schedule,{priority:'signal_poll',queueTimeoutMs:15000});assert.equal(cycle.duplicates,1);
  assert.equal(cycle.newEvents,1);assert.equal(observed,1);assert.equal(analyzed,1);assert.equal(archived,1);
});

test('raw-archived but unprocessed rows still enter observation and analysis while only new raw rows are archived',async()=>{
  const observed:string[]=[],analyzed:string[]=[],archived:unknown[][]=[];
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient([row(1),row(2,base-601_000),row(3)]),
    knownIds:()=>new Set([id(3)]),onObservation:s=>{observed.push(s.sourceEventId);},onSignal:s=>{analyzed.push(s.sourceEventId);},
    onArchive:(_chain,rows)=>{archived.push([...rows]);}}));
  await prime(scanner);const cycle=await scanner.runOnce();await scanner.waitForIdle();
  assert.deepEqual(observed,[`gmgn:market:sol:${id(1)}`,`gmgn:market:sol:${id(3)}`]);assert.deepEqual(analyzed,observed);
  assert.equal(cycle.stale,1);assert.equal(cycle.duplicates,1);assert.equal(cycle.newEvents,2);
  assert.equal(archived.length,1);assert.equal(archived[0].length,2);
  assert.equal(scanner.status().entryPipeline,false);assert.equal(scanner.status().countingPipeline,false);
});

test('durable processing checkpoint suppresses replay after a process restart',async()=>{
  const archived=new Set<string>(),processed=new Set<string>();let first=0,second=0;
  const make=(onSignal:()=>void)=>new GmgnMarketSignalScanner(options({client:liveClient([row(1)]),
    knownIds:(_chain,ids)=>new Set(ids.filter(value=>archived.has(value))),
    knownProcessedIds:(_chain,ids)=>new Set(ids.filter(value=>processed.has(value))),
    markProcessed:(_chain,value)=>{processed.add(value);},
    onArchive:(_chain,rows)=>{for(const value of rows as Record<string,unknown>[])archived.add(String(value.id));},onSignal}));
  const a=make(()=>{first++;});await prime(a);await a.runOnce();await a.waitForIdle();
  const b=make(()=>{second++;});await prime(b);await b.runOnce();await b.waitForIdle();
  assert.equal(first,1);assert.equal(second,0);assert.deepEqual([...archived],[id(1)]);assert.deepEqual([...processed],[id(1)]);
});

test('raw archive membership alone never suppresses recovery delivery after restart',async()=>{
  let observed=0,analyzed=0,archived=0;
  const scanner=new GmgnMarketSignalScanner(options({knownIds:()=>new Set([id(1)]),knownProcessedIds:()=>new Set(),
    onArchive:()=>{archived++;},onObservation:()=>{observed++;},onSignal:()=>{analyzed++;}}));
  const cycle=await scanner.runOnce();await scanner.waitForIdle();
  assert.equal(cycle.newEvents,0);assert.equal(cycle.duplicates,1);assert.equal(archived,0);
  assert.equal(observed,1);assert.equal(analyzed,1);assert.equal(scanner.status().totals.processed,1);
});

test('analysis queue is bounded and runs callbacks concurrently up to its configured limit',async()=>{
  const gate=deferred(),started:number[]=[];let active=0,peak=0;
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient(Array.from({length:20},(_,i)=>row(i+1))),dispatchConcurrency:2,
    dispatchCapacity:4,onSignal:async signal=>{started.push(Number(signal.text.match(/Token (\d+)/)?.[1]));peak=Math.max(peak,++active);await gate.promise;active--;}}));
  await prime(scanner);const cycle=await scanner.runOnce();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(scanner.status().activeDispatch,2);assert.equal(scanner.status().queueDepth,2);assert.equal(cycle.queueDropped,16);assert.equal(peak,2);
  gate.resolve();await scanner.waitForIdle();assert.equal(started.length,4);assert.equal(scanner.status().totals.completed,4);
});

test('fast observation lane remains responsive while the slow analysis lane is blocked',async()=>{
  const gate=deferred(),targetObserved=deferred<number>(),started=performance.now();
  const rows=[...Array.from({length:8},(_,index)=>row(index+1)),row(20,base,{signal_type:7})];
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient(rows),dispatchConcurrency:1,observationConcurrency:8,
    onObservation:signal=>{if(signal.sourceEventId.endsWith(id(20)))targetObserved.resolve(performance.now()-started);},
    onSignal:async()=>{await gate.promise;}}));
  await prime(scanner);const cycle=await scanner.runOnce();
  const elapsed=await Promise.race([targetObserved.promise,new Promise<never>((_,reject)=>
    setTimeout(()=>reject(new Error('observation blocked behind analysis')),250))]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(elapsed<150,`observation took ${elapsed}ms`);assert.equal(cycle.queued,8);
  const status=scanner.status();assert.equal(status.activeAnalysis,1);assert.equal(status.analysisQueueDepth,7);
  assert.equal(status.observationQueueDepth,0);assert.equal(status.totals.observationCompleted,9);
  gate.resolve();await scanner.waitForIdle();
});

test('checkpoint waits for both lanes and stale queued analysis is explicitly skipped and checkpointed',async()=>{
  let now=base;const first=deferred(),checkpoints:string[]=[],analyzed:string[]=[];
  const scanner=new GmgnMarketSignalScanner(options({now:()=>new Date(now),client:liveClient([row(1),row(2)]),dispatchConcurrency:1,
    markProcessed:(_chain,value)=>{checkpoints.push(value);},onSignal:async signal=>{
      analyzed.push(signal.sourceEventId);if(analyzed.length===1)await first.promise;}}));
  await prime(scanner);await scanner.runOnce();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(checkpoints,[],'analysis must complete before checkpoint');
  now=base+601_000;first.resolve();await scanner.waitForIdle();
  assert.equal(analyzed.length,1);assert.deepEqual(new Set(checkpoints),new Set([id(1),id(2)]));
  assert.equal(scanner.status().totals.analysisSkippedStale,1);
});

test('failed analysis is retried without requiring another vendor poll',async()=>{
  let attempts=0;
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient([row(1)]),onSignal:async()=>{if(++attempts===1)throw new Error('busy');}}));
  await prime(scanner);await scanner.runOnce();await scanner.waitForIdle();
  assert.equal(attempts,2);assert.equal(scanner.status().totals.callbackErrors,1);assert.equal(scanner.status().totals.completed,1);
});

test('failed observation is retried before the durable completion checkpoint',async()=>{
  let observationAttempts=0,analysisAttempts=0,checkpoints=0;
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient([row(1)]),onObservation:async()=>{if(++observationAttempts===1)throw new Error('busy');},
    onSignal:()=>{analysisAttempts++;},markProcessed:()=>{checkpoints++;}}));
  await prime(scanner);await scanner.runOnce();await scanner.waitForIdle();
  assert.equal(observationAttempts,2);assert.equal(analysisAttempts,1);assert.equal(checkpoints,1);
  assert.equal(scanner.status().totals.observationErrors,1);assert.equal(scanner.status().totals.processed,1);
});

test('archive work cannot delay observation, analysis handoff or the polling response',async()=>{
  const archive=deferred(),events:string[]=[];
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient([row(1)]),onObservation:()=>{events.push('observed');},onSignal:()=>{events.push('analysis');},
    onArchive:async()=>{events.push('archive');await archive.promise;}}));
  await prime(scanner);const cycle=await scanner.runOnce();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cycle.status,'ok');assert.deepEqual(events.slice(0,2),['observed','analysis']);assert.ok(events.includes('archive'));
  archive.resolve();await scanner.waitForIdle();
});

test('slow observation persistence does not delay analysis handoff or runOnce',async()=>{
  const observation=deferred(),analysis=deferred(),events:string[]=[];
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient([row(1)]),onObservation:async()=>{events.push('observation');await observation.promise;},
    onSignal:()=>{events.push('analysis');analysis.resolve();}}));
  await prime(scanner);const run=scanner.runOnce();
  const cycle=await Promise.race([run,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('runOnce blocked on observation')),100))]);
  await Promise.race([analysis.promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('analysis handoff blocked')),100))]);
  assert.equal(cycle.status,'ok');assert.deepEqual(events,['observation','analysis']);
  assert.equal(scanner.status().activeDispatch,1);
  observation.resolve();await scanner.waitForIdle();
  const latency=scanner.status().latencyMs;
  assert.equal(latency.receiveToObservation.count,1,'the post-baseline event is a live-new latency sample');
  assert.equal(latency.allReceiveToObservation.count,1);
});

test('all-work receive-to-observation latency is measured at successful completion, not queue start',async()=>{
  const scanner=new GmgnMarketSignalScanner(options({onObservation:async()=>{await new Promise(resolve=>setTimeout(resolve,50));}}));
  await scanner.runOnce();await scanner.waitForIdle();
  const status=scanner.status();assert.ok((status.latencyMs.allReceiveToObservation.p50??0)>=40,
    JSON.stringify(status.latencyMs.allReceiveToObservation));
  assert.equal(status.latencyMs.receiveToObservation.count,0);
  assert.ok((status.lastCycle?.responseToObservationMs??0)>=40,JSON.stringify(status.lastCycle));
});

test('startup pages, late backfills and replays never contaminate live-new latency',async()=>{
  let now=base,call=0;const pages=[[row(1,base-1_000)],[row(2,base-5_000)],[row(3,base+3_000)]];
  const scanner=new GmgnMarketSignalScanner(options({now:()=>new Date(now),client:client(async()=>pages[call++]!)}));
  const baseline=await scanner.runOnce();await scanner.waitForIdle();
  now=base+2_000;const backfill=await scanner.runOnce();await scanner.waitForIdle();
  now=base+4_000;const live=await scanner.runOnce();await scanner.waitForIdle();
  const status=scanner.status(),latency=status.latencyMs;
  assert.deepEqual([baseline.baselineEvents,baseline.liveNewEvents,backfill.lateBackfillEvents,live.liveNewEvents],[1,0,1,1]);
  assert.equal(status.totals.baselineEvents,1);assert.equal(status.totals.lateBackfillEvents,1);
  assert.equal(status.totals.liveNewEvents,1);assert.equal(latency.allSourceToReceive.count,3);
  assert.equal(latency.backlogSourceToReceive.count,2);assert.equal(latency.liveNewSourceToReceive.count,1);
  assert.deepEqual(latency.sourceToReceive,latency.liveNewSourceToReceive);
  assert.equal(latency.allReceiveToObservation.count,3);assert.equal(latency.backlogReceiveToObservation.count,2);
  assert.equal(latency.liveNewReceiveToObservation.count,1);assert.equal(status.metricScope,'live_new_only');
});

test('raw-archived missing-checkpoint work has explicit replay candidate, admission and latency counters',async()=>{
  const scanner=new GmgnMarketSignalScanner(options({knownIds:()=>new Set([id(1)]),knownProcessedIds:()=>new Set()}));
  const cycle=await scanner.runOnce();await scanner.waitForIdle();const status=scanner.status();
  assert.equal(cycle.replayCandidates,1);assert.equal(cycle.replayed,1);
  assert.equal(status.totals.replayCandidates,1);assert.equal(status.totals.replayed,1);
  assert.equal(status.latencyMs.replaySourceToReceive.count,1);assert.equal(status.latencyMs.replayReceiveToObservation.count,1);
  assert.equal(status.latencyMs.sourceToReceive.count,0);assert.equal(status.latencyMs.receiveToObservation.count,0);
});

test('startup backlog and old replay are resource-bounded, checkpoint only admitted observations, and never start slow analysis',async()=>{
  const rows=Array.from({length:123},(_,index)=>row(index+1,base-60_000)),archived=new Set(rows.slice(0,66).map(value=>String(value.id)));
  const observed:string[]=[],processed:string[]=[];let analyzed=0;
  const scanner=new GmgnMarketSignalScanner(options({client:client(rows),observationConcurrency:8,dispatchCapacity:256,
    knownIds:(_chain,ids)=>new Set(ids.filter(value=>archived.has(value))),knownProcessedIds:()=>new Set(),
    onObservation:signal=>{observed.push(signal.sourceEventId);},onSignal:()=>{analyzed++;},
    markProcessed:(_chain,value)=>{processed.push(value);}}));
  const cycle=await scanner.runOnce();await scanner.waitForIdle();const status=scanner.status();
  assert.equal(cycle.replayCandidates,66);assert.equal(cycle.baselineEvents,57);assert.equal(cycle.replayed,4);
  assert.equal(cycle.deferredBacklog,115);assert.equal(cycle.queued,0);assert.equal(cycle.analysisSuppressed,8);
  assert.equal(observed.length,8);assert.equal(processed.length,8);assert.equal(analyzed,0);
  assert.equal(status.totals.deferredBacklog,115);assert.equal(status.totals.completed,0);
  assert.equal(status.observationConcurrency,8);assert.equal(status.analysisQueueDepth,0);
});

test('startup baseline and old-replay admission budgets are independent for every chain',async()=>{
  const evmToken=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
  const chainRows=(chain:GmgnMarketChain)=>Array.from({length:10},(_,index)=>{
    const n=index+1;
    if(chain==='sol')return row(n,base-60_000,{signal_type:7});
    const address=evmToken(n);
    return row(n,base-60_000,{signal_type:7,token_address:address,
      data:{chain,address,symbol:`T${n}`,name:`Token ${n}`}});
  });
  const pages:Record<GmgnMarketChain,unknown>={sol:chainRows('sol'),bsc:chainRows('bsc'),robinhood:[]};
  const archived=new Set(Array.from({length:5},(_,index)=>id(index+1))),observed:{solana:number;bsc:number;robinhood:number}={
    solana:0,bsc:0,robinhood:0};
  const scanner=new GmgnMarketSignalScanner(options({chains:['sol','bsc'],client:{cooldownUntil:0,
    getMemeMarketSignals:async chain=>pages[chain]},knownIds:(_chain,ids)=>new Set(ids.filter(value=>archived.has(value))),
    knownProcessedIds:()=>new Set(),onObservation:signal=>{observed[signal.token.chain]++;}}));
  const solCycle=await scanner.runOnce();await scanner.waitForIdle();
  const bscCycle=await scanner.runOnce();await scanner.waitForIdle();
  for(const cycle of [solCycle,bscCycle]){
    assert.equal(cycle.replayCandidates,5);assert.equal(cycle.replayed,4);
    assert.equal(cycle.baselineEvents,5);assert.equal(cycle.deferredBacklog,2);
  }
  assert.deepEqual(observed,{solana:8,bsc:8,robinhood:0});
});

test('a replay no older than thirty seconds restores slow analysis while old replay only receives fast observation',async()=>{
  const fresh=row(1,base-30_000),old=row(2,base-31_000),analyzed:string[]=[],observed:string[]=[];
  const scanner=new GmgnMarketSignalScanner(options({client:client([fresh,old]),knownIds:()=>new Set([id(1),id(2)]),
    knownProcessedIds:()=>new Set(),onObservation:signal=>{observed.push(signal.sourceEventId);},
    onSignal:signal=>{analyzed.push(signal.sourceEventId);}}));
  const cycle=await scanner.runOnce();await scanner.waitForIdle();
  assert.equal(cycle.replayed,2);assert.equal(cycle.queued,1);assert.equal(cycle.analysisSuppressed,1);
  assert.deepEqual(observed.map(value=>value.split(':').at(-1)),[id(1),id(2)]);
  assert.deepEqual(analyzed.map(value=>value.split(':').at(-1)),[id(1)]);
});

test('live-new work is admitted ahead of a saturated startup page and does not spend backlog reserve',async()=>{
  let call=0;const old=Array.from({length:20},(_,index)=>row(index+1,base-60_000)),live=row(100,base+1_000);
  const scanner=new GmgnMarketSignalScanner(options({now:()=>new Date(base+2_000),dispatchCapacity:4,observationConcurrency:4,
    client:client(async()=>call++===0?[]:[...old,live]),onSignal:()=>{}}));
  await prime(scanner);const cycle=await scanner.runOnce();await scanner.waitForIdle();
  assert.equal(cycle.liveNewEvents,1);assert.equal(cycle.queued,1);assert.equal(cycle.deferredBacklog,20);
  assert.equal(cycle.queueDropped,0);assert.equal(scanner.status().totals.completed,1);
});

test('completed counts full analysis callbacks while processed counts completion checkpoints',async()=>{
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient([row(1,base,{signal_type:7}),row(2)]),markProcessed:()=>{}}));
  await prime(scanner);await scanner.runOnce();await scanner.waitForIdle();const totals=scanner.status().totals;
  assert.equal(totals.observationCompleted,2);assert.equal(totals.completed,1);assert.equal(totals.processed,2);
  assert.match(scanner.status().metricDefinitions.completed,/full-analysis/);
  assert.match(scanner.status().metricDefinitions.processed,/completion fence/);
});

test('observation and detached archive errors remain visible instead of being cleared by a successful HTTP cycle',async()=>{
  let now=base;const observation=new GmgnMarketSignalScanner(options({now:()=>new Date(now),onObservation:()=>{now=base+601_000;throw new Error('write');}}));
  await observation.runOnce();await observation.waitForIdle();assert.equal(observation.status().lastError,'GMGN_MARKET_SIGNAL_OBSERVATION_FAILED');
  let attempts=0;const archive=new GmgnMarketSignalScanner(options({onArchive:()=>{if(++attempts===1)throw new Error('full');}}));
  await archive.runOnce();await archive.waitForIdle();assert.equal(attempts,2);assert.equal(archive.status().totals.archiveErrors,1);
  assert.equal(archive.status().lastError,'GMGN_MARKET_SIGNAL_ARCHIVE_FAILED');
});

test('terminal archive errors disable archive delivery immediately without delaying research or shutdown',async()=>{
  let page=1,archiveCalls=0,analyzed=0;
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient(async()=>[row(page++)]),
    onSignal:()=>{analyzed++;},onArchive:()=>{archiveCalls++;throw new GmgnMarketArchiveError('GMGN_MARKET_ARCHIVE_TERMINAL_CAPACITY');}}));
  await prime(scanner);await scanner.runOnce();await scanner.waitForIdle();
  assert.equal(archiveCalls,1);assert.equal(analyzed,1);assert.equal(scanner.status().archiveState,'degraded');
  assert.equal(scanner.status().archiveDisabledReason,'GMGN_MARKET_ARCHIVE_TERMINAL_CAPACITY');
  await scanner.runOnce();await scanner.stop();
  assert.equal(archiveCalls,1);assert.equal(analyzed,2);assert.equal(scanner.status().archiveQueueDepth,0);
  assert.equal(scanner.status().totals.archiveRejected,2);
  assert.equal(scanner.status().lastError,'GMGN_MARKET_ARCHIVE_TERMINAL_CAPACITY');
});

test('stop fences an in-flight response and emits no late observation or analysis',async()=>{
  const request=deferred<unknown>(),events:string[]=[];
  const scanner=new GmgnMarketSignalScanner(options({client:client(()=>request.promise),onObservation:()=>{events.push('observation');},
    onSignal:()=>{events.push('analysis');}}));
  scanner.start();await new Promise(resolve=>setTimeout(resolve,20));const stopped=scanner.stop();request.resolve([row(1)]);await stopped;
  assert.deepEqual(events,[]);assert.equal(scanner.status().running,false);assert.equal(scanner.status().lastCycle?.status,'stopped');
});

test('stop also fences the async durable-dedup gap before callbacks are admitted',async()=>{
  const dedupStarted=deferred(),dedup=deferred<ReadonlySet<string>>(),events:string[]=[];
  const scanner=new GmgnMarketSignalScanner(options({knownIds:()=>{dedupStarted.resolve();return dedup.promise;},
    onObservation:()=>{events.push('observation');},onSignal:()=>{events.push('analysis');},onArchive:()=>{events.push('archive');}}));
  const running=scanner.runOnce();await dedupStarted.promise;const stopped=scanner.stop();dedup.resolve(new Set());
  const [cycle]=await Promise.all([running,stopped]);assert.equal(cycle.status,'stopped');assert.deepEqual(events,[]);
});

test('stop drains fast observations but only active slow analysis and leaves queued research replayable',async()=>{
  const rows=Array.from({length:12},(_,index)=>row(index+1)),gate=deferred(),started:string[]=[];
  const archived=new Set<string>(),processed=new Set<string>();
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient(rows),dispatchConcurrency:1,
    knownIds:(_chain,ids)=>new Set(ids.filter(value=>archived.has(value))),
    knownProcessedIds:(_chain,ids)=>new Set(ids.filter(value=>processed.has(value))),
    markProcessed:(_chain,value)=>{processed.add(value);},
    onArchive:(_chain,values)=>{for(const value of values as Record<string,unknown>[])archived.add(String(value.id));},
    onSignal:async signal=>{started.push(signal.sourceEventId);await gate.promise;}}));
  await prime(scanner);await scanner.runOnce();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(started.length,1);assert.equal(scanner.status().analysisQueueDepth,11);
  const stopping=scanner.stop();
  assert.equal(scanner.status().analysisQueueDepth,0);assert.equal(scanner.status().totals.shutdownDeferred,11);
  gate.resolve();await stopping;
  assert.equal(started.length,1);assert.equal(processed.size,1);assert.equal(archived.size,12);
  assert.equal(scanner.status().totals.observationCompleted,12);

  let replayedAnalysis=0;
  const replay=new GmgnMarketSignalScanner(options({client:client(rows),dispatchConcurrency:2,
    knownIds:(_chain,ids)=>new Set(ids.filter(value=>archived.has(value))),
    knownProcessedIds:(_chain,ids)=>new Set(ids.filter(value=>processed.has(value))),
    markProcessed:(_chain,value)=>{processed.add(value);},onSignal:()=>{replayedAnalysis++;}}));
  await replay.runOnce();await replay.waitForIdle();
  assert.equal(replayedAnalysis,11);assert.equal(replay.status().totals.replayed,11);assert.equal(processed.size,12);
});

test('stop does not retry an active analysis attempt that fails after the stop fence',async()=>{
  const entered=deferred(),fail=deferred();let attempts=0;
  const scanner=new GmgnMarketSignalScanner(options({client:liveClient([row(1)]),onSignal:async()=>{attempts++;entered.resolve();await fail.promise;throw new Error('failed');}}));
  await prime(scanner);await scanner.runOnce();await entered.promise;const stopping=scanner.stop();fail.resolve();await stopping;
  assert.equal(attempts,1);assert.equal(scanner.status().totals.processed,0);assert.equal(scanner.status().totals.workFailures,1);
});

test('poll cadence is measured from cycle start and status exposes receive, queue and completion latency',async()=>{
  const starts:number[]=[];let now=base;
  const scanner=new GmgnMarketSignalScanner(options({now:()=>new Date(now),client:{cooldownUntil:0,getMemeMarketSignals:async()=>{
    starts.push(performance.now());await new Promise(resolve=>setTimeout(resolve,300));now+=1000;return [row(starts.length,now-1000)];}},
    onObservation:()=>{},onSignal:async()=>{await new Promise(resolve=>setTimeout(resolve,10));}}));
  scanner.start();await new Promise(resolve=>setTimeout(resolve,2450));await scanner.stop();
  assert.ok(starts.length>=3,`starts=${starts.length}`);assert.ok(starts[1]-starts[0]<1150,`delta=${starts[1]-starts[0]}`);
  const status=scanner.status();assert.ok(status.latencyMs.sourceToReceive.count>0);assert.ok(status.latencyMs.receiveToObservation.count>0);
  assert.ok(status.latencyMs.request.count>0);assert.ok((status.latencyMs.request.p50??0)>=250);
  assert.ok(status.latencyMs.queueWait.count>0);assert.ok(status.latencyMs.analysis.count>0);assert.ok(status.latencyMs.sourceToComplete.count>0);
  assert.ok((status.lastCycle?.requestMs??0)>=250);assert.equal(status.entryPipeline,false);assert.equal(status.countingPipeline,false);
});
