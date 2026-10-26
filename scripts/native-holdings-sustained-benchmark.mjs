/** OFFLINE sustained native holdings benchmark. Do not load .env.
 * node --import tsx scripts/native-holdings-sustained-benchmark.mjs
 * Optional: --counts=30,50,100 --duration-ms=6000 --interval-ms=250 --drain-ms=2000 --output=reports/example.json
 * The independent source worker never waits for a prior burst's decisions.
 * All wallets, mint state and token balances are deterministic public fixtures.
 */
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,readFileSync,existsSync,chmodSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import bs58 from 'bs58';
import {NativePositionSupervisor} from '../src/native-solana/positions.ts';
import {createMarket} from './fixtures/native-capacity-market.mjs';

let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw Error('BENCH_NETWORK_FORBIDDEN');};
globalThis.WebSocket=class {constructor(){networkAttempts++;throw Error('BENCH_WEBSOCKET_FORBIDDEN');}};
const clock=()=>Number(process.hrtime.bigint())/1e6;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const args=new Map(process.argv.slice(2).map(arg=>{const match=/^--([a-z-]+)=(.+)$/.exec(arg);if(!match)throw Error('BENCH_ARGUMENT_INVALID');return [match[1],match[2]];}));
for(const key of args.keys())if(!['counts','duration-ms','interval-ms','drain-ms','output'].includes(key))throw Error('BENCH_ARGUMENT_UNKNOWN');
function integer(value,fallback,min,max){const n=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('BENCH_ARGUMENT_RANGE');return n;}
const counts=(args.get('counts')??'30,50,100').split(',').map(value=>integer(value,0,1,1000));
if(new Set(counts).size!==counts.length||counts.length>5)throw Error('BENCH_COUNTS_INVALID');
const durationMs=integer(args.get('duration-ms'),6000,1000,10000),intervalMs=integer(args.get('interval-ms'),250,50,2000);
const drainMs=integer(args.get('drain-ms'),2000,0,10000),rounds=Math.ceil(durationMs/intervalMs);
const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+$/,'Z');
const output=resolve(args.get('output')??`reports/native-holdings-sustained-${stamp}.json`);
if(existsSync(output))throw Error('BENCH_OUTPUT_ALREADY_EXISTS');
const round=value=>Number.isFinite(value)?Math.round(value*1000)/1000:null;
function distribution(values){const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b),at=p=>sorted.length?round(sorted[Math.ceil((sorted.length-1)*p)]):null;
  return {count:sorted.length,p50:at(.5),p95:at(.95),p99:at(.99),max:at(1)};}
function reason(error){return error instanceof Error?error.message.slice(0,160):'BENCH_UNKNOWN_FAILURE';}
const report={startedAt:new Date().toISOString(),mode:'OFFLINE_FIXED_EXTERNAL_SCHEDULE_REAL_SDK_ON_DISK_SUPERVISOR',
  networkRequests:0,realTrades:0,configuration:{counts,durationMs,intervalMs,drainMs,rounds,burstSchedule:'absolute independent worker clock',
    eventDriven:true,loopMs:50,fallbackIntervalMs:1000,minCheckIntervalMs:0,staleAfterMs:1500,batchSize:20,
    productionAdmissionBypassed:true,productionAccountSubscriptionLimit:120},
  environment:{node:process.version,cpuCount:cpus().length,cpu:cpus()[0]?.model},
  sourceHashes:Object.fromEntries(['src/native-solana/pump.ts','src/native-solana/positions.ts','scripts/fixtures/native-capacity-market.mjs',
    'scripts/native-holdings-sustained-benchmark.mjs'].map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')])),
  timing:{clock:'process.hrtime.bigint shared monotonic origin across the source worker and consumer; report values are relative to source start',
    source:'Each contract changes at each predeclared absolute 250ms burst by default; producer work does not wait for consumer ingestion or evaluation.',
    producerEmission:'Worker writes its actual emission timestamp to shared atomic memory before posting each burst marker. This remains readable even when consumer messages are queued.',
    localReceive:'First account-frame processing starts for that contract in the main process; burst IPC receipt is recorded separately. Earlier contracts within the burst are part of the receive delay.',
    exactDecision:'onEvaluation for the exact delivered market slot after the SDK full/half position quotes and threshold decision. No execution or Telegram.',
    coverage:'A later evaluated slot may cover an earlier pending event. Its delay is measured from that earlier event\'s own planned/received time, never from the newer event.',
    deadline:'The source stops after durationMs; consumer gets a separately reported drainMs. Decisions after the absolute drain deadline are logged but never credited to deadline coverage.',
    persistence:'Disposable on-disk SQLite using the production supervisor WAL/FULL settings and its current persistence policy. Update callbacks acknowledge immediately; production runtime ledger/IPC work is excluded.'},
  limitations:[
    'Offline capacity evidence, not mainnet capacity or guaranteed fill latency. No RPC connection, production configuration, signer, executor, orders database or Telegram is loaded.',
    'The normal opening-position limit and 120-account WebSocket subscription limit are deliberately bypassed for isolated supervisor registration; account totals and limit violations are reported.',
    'An independent worker posts small schedule markers; full JSON/base64 WebSocket payload parsing, transport bandwidth and remote node delivery are not modeled.',
    'Real SDK account buffers are prebuilt before the timed stage; 1/3 of contracts are Pump and 2/3 PumpSwap. An AMM update supplies its three account frames contiguously, with no network gap.',
    'Inventory is an injected constant synthetic balance. Actual wallet account decoding, runtime synchronization, IPC snapshot delivery and Telegram work are excluded.',
    'Reserve movements are deliberately bounded to avoid triggering exits; this measures monitoring decisions, not executable transaction construction, simulation, broadcast or confirmation.',
    'Node event-loop and independent producer scheduling delays are recorded separately. CPU numbers include the worker and consumer within this benchmark process.',
    'Latest-slot coalescing is reported as skipped exact events plus later-slot coverage; it does not prove transient price thresholds were seen.'
  ],stages:[],failures:[]};
let outputCreated=false;
function persist(){mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:outputCreated?'w':'wx'});outputCreated=true;}
const workerSource=`
const {parentPort,workerData}=require('node:worker_threads');
const progress=new Int32Array(workerData.progress),times=new BigInt64Array(workerData.times);let timers=[],started=false;
const now=()=>process.hrtime.bigint();
parentPort.on('message',message=>{
 if(message.type==='stop'){for(const timer of timers)clearTimeout(timer);Atomics.store(progress,2,1);parentPort.postMessage({type:'stopped'});return;}
 if(message.type!=='start'||started)return;started=true;const start=BigInt(message.startNs);
 for(let index=0;index<workerData.rounds;index++){
  const planned=start+BigInt(index*workerData.intervalMs)*1000000n;
  timers.push(setTimeout(()=>{if(Atomics.load(progress,2))return;const emitted=now();Atomics.store(times,index,emitted);
   Atomics.add(progress,0,1);parentPort.postMessage({type:'burst',index});},Math.max(0,Number(planned-now())/1e6)));
 }
 const end=start+BigInt(workerData.durationMs)*1000000n;
 timers.push(setTimeout(()=>{Atomics.store(progress,1,1);parentPort.postMessage({type:'source_done'});},Math.max(0,Number(end-now())/1e6)));
});parentPort.postMessage({type:'ready'});
`;
const temporary=mkdtempSync(join(tmpdir(),'native-holdings-sustained-'));chmodSync(temporary,0o700);

async function stage(count){
 const setupStarted=clock(),market=await createMarket(count);
 const byMint=new Map(market.tokens.map((token,index)=>[token.mint,{...token,id:`sustained-${count}-${index}`} ]));
 const tokens=[...byMint.values()];
 const planned=Array.from({length:rounds},(_,index)=>tokens.map(token=>({token,frames:token.frames(index+1)})));
 const records=planned.flatMap((burst,index)=>burst.map(({token,frames})=>({round:index,contract:token.id,mint:token.mint,venue:token.venue,
   slot:frames[0].slot,frameCount:frames.length,plannedAtMs:index*intervalMs,errors:[]})));
 const byMintSlot=new Map(records.map(record=>[`${record.mint}:${record.slot}`,record]));
 const recordsByMint=new Map(tokens.map(token=>[token.mint,records.filter(record=>record.mint===token.mint)]));
 const latestReceived=new Map(),uncovered=new Set(),subscriptions=new Set(),evaluations=[],warmupEvaluations=[],samples=[],burstReceipts=[],failures=[],quoteFailures=[],positionErrorUpdates=[];
 const counters={receivedBursts:0,ingestedContractEvents:0,acceptedFrames:0,attemptedFrames:0,exactDecisions:0,decisionCallbacks:0,
   sellAttempts:0,reconcileAttempts:0,updateCallbacks:0};
 let supervisor,worker,sampleTimer,phase='warmup',sourceStart,sourceEnd,deadline,stopping=false,sourceDoneReceived=false;
 let stageStarted,measuredReads,cpuStart,eventLag,peakRss=process.memoryUsage().rss,peakQueuedBursts=0,peakUncovered=0,maxIngestionOverrunMs=0;
 const progressBuffer=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT*3),timesBuffer=new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT*rounds);
 const progress=new Int32Array(progressBuffer),sourceTimes=new BigInt64Array(timesBuffer),decodeMs=[],dirtyMs=[];
 const relative=at=>round(at-sourceStart);
 const capture=()=>{if(sourceStart===undefined)return;const at=clock(),generated=Atomics.load(progress,0),queued=Math.max(0,generated-counters.receivedBursts);
   const rss=process.memoryUsage().rss;peakRss=Math.max(peakRss,rss);peakQueuedBursts=Math.max(peakQueuedBursts,queued);peakUncovered=Math.max(peakUncovered,uncovered.size);
   samples.push({atMs:relative(at),phase,sourceGeneratedBursts:generated,locallyReceivedBursts:counters.receivedBursts,queuedBurstMarkers:queued,
     scheduledBurstsDue:Math.max(0,Math.min(rounds,Math.floor((at-sourceStart)/intervalMs)+1)),
     ingestedContractEvents:counters.ingestedContractEvents,uncoveredReceivedEvents:uncovered.size,exactDecisions:counters.exactDecisions,
     decisionCallbacks:counters.decisionCallbacks,rssBytes:rss});};
 supervisor=new NativePositionSupervisor(join(temporary,`${count}.sqlite`),{
   eventDriven:true,loopMs:50,fallbackIntervalMs:1000,minCheckIntervalMs:0,staleAfterMs:1500,maxPositions:count+1,batchSize:20,
   io:{
     balance:async request=>{const token=byMint.get(request.mint);return {wallet:request.wallet,mint:request.mint,amount:token.amount,tokenDecimals:6,
       slot:Math.max(100,latestReceived.get(request.mint)?.slot??100),commitment:'confirmed',observedAt:new Date().toISOString()};},
     quote:async request=>{let quote;try{quote=market.adapter.quoteSellCached({wallet:market.wallet,mint:request.mint,amount:request.amount,slippageBps:100});}
       catch(error){quoteFailures.push({phase,contract:request.orderId,mint:request.mint,amount:request.amount,
         atMs:sourceStart===undefined?null:relative(clock()),reason:reason(error)});throw error;}
       const at=Date.now();return {wallet:request.wallet,mint:request.mint,inputAmount:request.amount,outputAmount:quote.expectedOutputAmount,
         minimumOutputAmount:quote.minimumOutputAmount,quotedAt:new Date(at).toISOString(),expiresAt:new Date(at+1000).toISOString(),
         subscriptionAccounts:quote.subscriptionAccounts,source:'solana_account_stream',marketObservedAt:quote.quotedAt,marketSlot:quote.slot};},
     sell:async()=>{counters.sellAttempts++;throw Error('BENCH_SELL_FORBIDDEN');},
     reconcile:async()=>{counters.reconcileAttempts++;throw Error('BENCH_RECONCILE_FORBIDDEN');}
   },
   onSubscriptions:accounts=>{for(const address of accounts)subscriptions.add(address);},
   onUpdate:event=>{counters.updateCallbacks++;if(event.position.lastError)positionErrorUpdates.push({phase,contract:event.position.buy.orderId,
     atMs:sourceStart===undefined?null:relative(clock()),reason:event.position.lastError});},
   onEvaluation:position=>{
     const completed=clock(),marketSlot=position.quote?.marketSlot,mint=position.buy.mint;
     if(sourceStart===undefined){warmupEvaluations.push({contract:position.buy.orderId,mint,marketSlot,at:new Date().toISOString()});return;}
     counters.decisionCallbacks++;const exact=byMintSlot.get(`${mint}:${marketSlot}`),latest=latestReceived.get(mint);
     const older=(recordsByMint.get(mint)??[]).filter(record=>record.firstFrameReceivedAtMs!==undefined&&record.coveredAtMs===undefined&&record.slot<=marketSlot);
     const entry={index:evaluations.length,phase,contract:position.buy.orderId,mint,marketSlot,completedAtMs:relative(completed),
       beforeDeadline:completed<=deadline,latestReceivedSlot:latest?.slot,slotBehindLatestReceived:latest?latest.slot-marketSlot:null,
       exactEventRound:exact?.round,exactPlannedToDecisionMs:exact?round(completed-sourceStart-exact.plannedAtMs):null,
       exactFirstFrameToDecisionMs:exact?.firstFrameReceivedAtMs!==undefined?round(completed-sourceStart-exact.firstFrameReceivedAtMs):null,
       oldestUncoveredPlannedToDecisionMs:older.length?round(completed-sourceStart-older[0].plannedAtMs):null,
       oldestUncoveredFirstFrameToDecisionMs:older.length?round(completed-sourceStart-Math.min(...older.map(record=>record.firstFrameReceivedAtMs))):null,
       newlyCoveredEvents:completed<=deadline?older.length:0};
     evaluations.push(entry);
     if(completed>deadline)return;
     if(exact?.firstFrameReceivedAtMs!==undefined&&exact.firstDecisionAtMs===undefined){exact.firstDecisionAtMs=relative(completed);counters.exactDecisions++;}
     for(const record of older){record.coveredAtMs=relative(completed);record.coveredBySlot=marketSlot;record.coveredByEvaluation=entry.index;uncovered.delete(`${mint}:${record.slot}`);}
   }
 });
 try{
   for(const token of tokens)supervisor.register({orderId:token.id,wallet:market.wallet,mint:token.mint,inputAmount:token.baselineOutput,
     outputAmount:token.amount,tokenDecimals:6,signature:bs58.encode(createHash('sha512').update(token.id).digest()),buySlot:100,
     subscriptionAccounts:token.subscriptionAccounts,confirmedAt:new Date().toISOString()});
   supervisor.start();supervisor.setStreamState({connected:true,subscribedAccounts:[...subscriptions]});
   for(const token of tokens)await supervisor.checkNow(token.id);
   await delay(50);const warmupErrors=supervisor.list().filter(row=>row.lastError).map(row=>({contract:row.buy.orderId,reason:row.lastError}));
   if(warmupErrors.length)throw Error(`BENCH_WARMUP_FAILED:${JSON.stringify(warmupErrors)}`);
   worker=new Worker(workerSource,{eval:true,workerData:{rounds,intervalMs,durationMs,progress:progressBuffer,times:timesBuffer}});
   await new Promise((resolveReady,rejectReady)=>{const timeout=setTimeout(()=>rejectReady(Error('BENCH_PRODUCER_START_TIMEOUT')),5000);
     worker.once('error',error=>{clearTimeout(timeout);rejectReady(error);});worker.once('message',message=>{clearTimeout(timeout);if(message.type!=='ready')rejectReady(Error('BENCH_PRODUCER_PROTOCOL'));else resolveReady();});});
   worker.on('error',error=>failures.push({phase,reason:reason(error)}));
   worker.on('message',message=>{
     if(message.type==='source_done'){sourceDoneReceived=true;return;}
     if(message.type!=='burst')return;
     const received=clock(),index=message.index;counters.receivedBursts++;
     const receipt={round:index,plannedAtMs:index*intervalMs,receivedAtMs:relative(received),accepted:!stopping&&received<deadline};burstReceipts.push(receipt);
     if(!receipt.accepted)return;
     if(received>=sourceEnd)phase='drain';
     capture();
     for(const {token,frames} of planned[index]){
       const at=clock();if(stopping||at>=deadline){maxIngestionOverrunMs=Math.max(maxIngestionOverrunMs,at-deadline);break;}
       const record=byMintSlot.get(`${token.mint}:${frames[0].slot}`);record.firstFrameReceivedAtMs=relative(at);
       const previous=latestReceived.get(token.mint);
       if(previous&&previous.firstDecisionAtMs===undefined&&previous.supersededBySlot===undefined){previous.supersededBySlot=record.slot;previous.supersededAtMs=relative(at);}
       latestReceived.set(token.mint,record);uncovered.add(`${token.mint}:${record.slot}`);
       for(const frame of frames){counters.attemptedFrames++;const observedAt=Date.now(),begin=clock();
         try{
           const affected=market.adapter.ingestAccount(frame.address,frame.info,frame.slot,observedAt);decodeMs.push(clock()-begin);
           if(!affected.includes(token.mint))throw Error('BENCH_FRAME_NOT_INDEXED');counters.acceptedFrames++;
           const dirtyStart=clock();supervisor.markDirty(token.id,{slot:frame.slot,observedAt:new Date(observedAt).toISOString()});dirtyMs.push(clock()-dirtyStart);
         }catch(error){record.errors.push(reason(error));}
       }
       const cache=market.adapter.cacheStatus(market.wallet,token.mint);if(!cache.ready)record.errors.push(cache.reason??'BENCH_CACHE_NOT_READY');
       record.lastFrameProcessedAtMs=relative(clock());record.fullyIngested=record.errors.length===0;counters.ingestedContractEvents++;
       peakUncovered=Math.max(peakUncovered,uncovered.size);
     }
     capture();
   });
   measuredReads=market.mockReadCount();cpuStart=process.cpuUsage();eventLag=monitorEventLoopDelay({resolution:1});eventLag.enable();
   stageStarted=clock();sourceStart=stageStarted+100;sourceEnd=sourceStart+durationMs;deadline=sourceEnd+drainMs;phase='source_active';
   sampleTimer=setInterval(capture,100);worker.postMessage({type:'start',startNs:String(BigInt(Math.round(sourceStart*1e6)))});
   await delay(Math.max(0,deadline-clock()));stopping=true;phase='stop';capture();clearInterval(sampleTimer);
   const stoppedAt=clock(),usage=process.cpuUsage(cpuStart);eventLag.disable();
   worker.postMessage({type:'stop'});await worker.terminate();worker=undefined;
   await supervisor.stop();phase='finished';
   const sourceEmissions=Array.from({length:rounds},(_,index)=>{const ns=Atomics.load(sourceTimes,index),emitted=ns===0n?undefined:Number(ns)/1e6;
     const local=burstReceipts.find(receipt=>receipt.round===index);
     return {round:index,plannedAtMs:index*intervalMs,emittedAtMs:emitted===undefined?null:relative(emitted),
       producerScheduleDelayMs:emitted===undefined?null:round(emitted-sourceStart-index*intervalMs),
       receivedAtMs:local?.receivedAtMs??null,ipcQueueDelayMs:emitted!==undefined&&local?round(local.receivedAtMs-relative(emitted)):null};});
   for(const record of records){const emitted=sourceEmissions[record.round];record.emittedAtMs=emitted.emittedAtMs;
     record.status=emitted.emittedAtMs===null?'not_emitted':record.firstFrameReceivedAtMs===undefined?'emitted_not_ingested':record.errors.length?'ingestion_failed':
       record.firstDecisionAtMs!==undefined?'exactly_evaluated':record.coveredAtMs!==undefined?'coalesced_to_newer_evaluated_slot':'received_without_decision_coverage';
     record.plannedToFirstFrameMs=record.firstFrameReceivedAtMs===undefined?null:round(record.firstFrameReceivedAtMs-record.plannedAtMs);
     record.plannedToExactDecisionMs=record.firstDecisionAtMs===undefined?null:round(record.firstDecisionAtMs-record.plannedAtMs);
     record.firstFrameToExactDecisionMs=record.firstDecisionAtMs===undefined?null:round(record.firstDecisionAtMs-record.firstFrameReceivedAtMs);
     record.plannedToCoverageMs=record.coveredAtMs===undefined?null:round(record.coveredAtMs-record.plannedAtMs);
     record.firstFrameToCoverageMs=record.coveredAtMs===undefined?null:round(record.coveredAtMs-record.firstFrameReceivedAtMs);
   }
   const finalRows=supervisor.list(),statusCounts=Object.fromEntries([...new Set(records.map(record=>record.status))].map(status=>[status,records.filter(record=>record.status===status).length]));
   const finalContractCoverage=tokens.map(token=>{const own=recordsByMint.get(token.mint),last=own.at(-1),seen=own.filter(record=>record.firstFrameReceivedAtMs!==undefined),exact=own.filter(record=>record.firstDecisionAtMs!==undefined);
     return {contract:token.id,mint:token.mint,venue:token.venue,expectedEvents:own.length,receivedEvents:seen.length,exactEvaluatedEvents:exact.length,
       coveredEvents:own.filter(record=>record.coveredAtMs!==undefined).length,latestScheduledSlot:last.slot,
       latestScheduledSlotEvaluated:last.firstDecisionAtMs!==undefined,latestReceivedSlot:seen.at(-1)?.slot??null,
       latestEvaluatedSlot:exact.at(-1)?.slot??null,lastError:finalRows.find(row=>row.buy.orderId===token.id)?.lastError??null};});
   const actualSourceSpan=sourceEmissions.at(-1)?.emittedAtMs!==null&&sourceEmissions[0]?.emittedAtMs!==null?
     sourceEmissions.at(-1).emittedAtMs-sourceEmissions[0].emittedAtMs:null;
   const exact=records.filter(record=>record.firstDecisionAtMs!==undefined),covered=records.filter(record=>record.coveredAtMs!==undefined);
   const result={positions:count,curveContracts:tokens.filter(token=>token.venue==='pump').length,poolContracts:tokens.filter(token=>token.venue==='pumpswap').length,
     expectedContractEvents:records.length,expectedAccountFrames:records.reduce((sum,record)=>sum+record.frameCount,0),sourceGeneratedBursts:Atomics.load(progress,0),
     sourceDoneFlag:Atomics.load(progress,1)===1,sourceDoneMessageReceived:sourceDoneReceived,statusCounts,
     subscriptionAccounts:subscriptions.size,exceedsProductionAccountLimit:subscriptions.size>120,
     sourceRate:{requestedBurstsPerSecond:1000/intervalMs,requestedContractEventsPerSecond:count*1000/intervalMs,
       actualEmissionSpanMs:round(actualSourceSpan),actualBurstFrequencyHz:actualSourceSpan>0?round((sourceEmissions.filter(item=>item.emittedAtMs!==null).length-1)*1000/actualSourceSpan):null,
       receivedContractEventsPerSourceSecond:round(counters.ingestedContractEvents/(durationMs/1000)),
       receivedDuringActiveSource:records.filter(record=>record.firstFrameReceivedAtMs!==undefined&&record.firstFrameReceivedAtMs<durationMs).length,
       receivedDuringDrain:records.filter(record=>record.firstFrameReceivedAtMs>=durationMs).length},
     plannedToFirstFrameMs:distribution(records.map(record=>record.plannedToFirstFrameMs)),
     plannedToExactDecisionMs:distribution(exact.map(record=>record.plannedToExactDecisionMs)),
     firstFrameToExactDecisionMs:distribution(exact.map(record=>record.firstFrameToExactDecisionMs)),
     plannedToCoverageIncludingCoalescedMs:distribution(covered.map(record=>record.plannedToCoverageMs)),
     firstFrameToCoverageIncludingCoalescedMs:distribution(covered.map(record=>record.firstFrameToCoverageMs)),
     oldestPendingPlannedToDecisionMs:distribution(evaluations.map(entry=>entry.oldestUncoveredPlannedToDecisionMs)),
     producerScheduleDelayMs:distribution(sourceEmissions.map(item=>item.producerScheduleDelayMs)),ipcQueueDelayMs:distribution(sourceEmissions.map(item=>item.ipcQueueDelayMs)),
     accountDecodeAndCacheMs:distribution(decodeMs),markDirtyMs:distribution(dirtyMs),
     backlog:{peakQueuedBurstMarkers:peakQueuedBursts,peakReceivedUncoveredEvents:peakUncovered,uncoveredReceivedEventsAtStop:uncovered.size,
       contractsWithNoExactEvaluation:finalContractCoverage.filter(item=>item.exactEvaluatedEvents===0).length,
       contractsMissingLatestScheduledDecision:finalContractCoverage.filter(item=>!item.latestScheduledSlotEvaluated).length},
     slo:{exactEvaluatedWithin100ms:exact.filter(record=>record.plannedToExactDecisionMs<=100).length,
       exactEvaluatedWithin250ms:exact.filter(record=>record.plannedToExactDecisionMs<=250).length,
       exactEvaluatedWithin1000ms:exact.filter(record=>record.plannedToExactDecisionMs<=1000).length,
       expectedEventsDenominator:records.length,missingExactDecisions:records.length-exact.length,
       note:'These counts use all planned events as denominator. Latency percentiles alone exclude missing decisions and must not be read as full coverage.'},
     elapsed:{setupMs:round(stageStarted-setupStarted),sourceMs:durationMs,allowedDrainMs:drainMs,measuredMs:round(stoppedAt-stageStarted),
       actualDrainDeadlineOverrunMs:round(Math.max(0,stoppedAt-deadline)),maxIngestionDeadlineOverrunMs:round(Math.max(0,maxIngestionOverrunMs))},
     cpu:{userMs:usage.user/1000,systemMs:usage.system/1000,percentOfOneCore:round((usage.user+usage.system)/(stoppedAt-stageStarted)/10),
       denominator:'measurement elapsed includes the 100ms producer arming interval and the separately reported drain period'},
     eventLoopDelayMs:{p50:eventLag.percentile(50)/1e6,p95:eventLag.percentile(95)/1e6,p99:eventLag.percentile(99)/1e6,max:eventLag.max/1e6},
     peakRssBytes:peakRss,counters,hotPathMockReads:market.mockReadCount()-measuredReads,networkAttempts,
     failures,quoteFailures,positionErrorUpdates,finalPositionErrors:finalRows.filter(row=>row.lastError).map(row=>({contract:row.buy.orderId,reason:row.lastError})),
     finalContractCoverage,sourceEmissions,burstReceipts,backlogSamples:samples,warmupEvaluations,evaluations,events:records};
   result.integrityPassed=result.hotPathMockReads===0&&networkAttempts===0&&counters.sellAttempts===0&&counters.reconcileAttempts===0&&failures.length===0;
   result.coveragePassed=records.every(record=>record.fullyIngested)&&finalContractCoverage.every(item=>item.latestScheduledSlotEvaluated)&&result.finalPositionErrors.length===0;
   result.strictArrivalIntervalSloPassed=records.every(record=>record.firstDecisionAtMs!==undefined&&record.plannedToExactDecisionMs<=intervalMs);
   return result;
 }finally{
   stopping=true;clearInterval(sampleTimer);eventLag?.disable();if(worker)await worker.terminate();await supervisor.close();
 }
}

try{
 persist();
 for(const count of counts){
   try{const result=await stage(count);report.stages.push(result);persist();
     console.log(JSON.stringify({positions:count,integrityPassed:result.integrityPassed,coveragePassed:result.coveragePassed,statusCounts:result.statusCounts,
       plannedToExactDecisionMs:result.plannedToExactDecisionMs,plannedToCoverageIncludingCoalescedMs:result.plannedToCoverageIncludingCoalescedMs,
       backlog:result.backlog,cpu:result.cpu,output}));
     if(!result.integrityPassed)throw Error('BENCH_UNEXPECTED_SIDE_EFFECT_OR_SOURCE_FAILURE');
   }catch(error){report.failures.push({positions:count,reason:reason(error)});persist();throw error;}
 }
 report.finishedAt=new Date().toISOString();report.networkRequests=networkAttempts;persist();
}finally{rmSync(temporary,{recursive:true,force:true});}
