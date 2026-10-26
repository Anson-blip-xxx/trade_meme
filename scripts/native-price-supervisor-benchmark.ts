import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir, cpus} from 'node:os';
import {join, resolve} from 'node:path';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';
import bs58 from 'bs58';
import {NativePositionSupervisor} from '../src/native-solana/positions.js';

/** Isolated synthetic IO benchmark of the production supervisor. No config, keys,
 * real wallet, network, executor, Telegram, or production databases are imported.
 * Run: node --import tsx scripts/native-price-supervisor-benchmark.ts
 * Optional: BENCH_STAGES='3:150:14,10:150:16' (positions:per-RPC-ms:seconds).
 * Both adapter.balance and adapter.quoteSell currently perform two serial HTTP
 * RPC requests. A normal pre-take-profit check does balance, full quote, half
 * quote sequentially: six RPC waits, not three. The mock reproduces these waits;
 * it does NOT reproduce network variance, SDK decoding, public-node throttling,
 * WS payload parsing, subscriptions, or production notification callbacks.
 */
globalThis.fetch = async () => {throw Error('BENCHMARK_NETWORK_FORBIDDEN');};
const stages = (process.env.BENCH_STAGES ?? '3:150:14,10:150:16,20:150:20,50:150:36,100:150:66,3:100:12,3:300:15,3:800:20')
  .split(',').map(spec => {
    const [positions, rpcMs, seconds] = spec.split(':').map(Number);
    if (![positions,rpcMs,seconds].every(Number.isSafeInteger) || positions < 1 || positions > 200 || rpcMs < 1 || rpcMs > 1500 || seconds < 3 || seconds > 180)
      throw Error('BENCHMARK_STAGES_INVALID');
    return {positions,rpcMs,seconds};
  });
const out = resolve(process.env.BENCH_OUTPUT ?? 'reports/native-price-supervisor-benchmark-20261026.json');
const temporary = mkdtempSync(join(tmpdir(), 'meme-price-benchmark-'));
const iso = () => new Date().toISOString();
const round = (n:number) => Math.round(n * 100) / 100;
function summarize(values:number[]) {
  const sorted = [...values].sort((a,b)=>a-b);
  const p = (fraction:number) => sorted.length ? round(sorted[Math.min(sorted.length-1, Math.ceil(sorted.length * fraction)-1)]!) : null;
  return {samples: sorted.length, min: sorted.length ? round(sorted[0]!) : null,p50:p(.5),p95:p(.95),p99:p(.99),max: sorted.length ? round(sorted.at(-1)!) : null};
}
const key = (n:number,bytes=32) => {const b=new Uint8Array(bytes);new DataView(b.buffer).setUint32(0,n);b[bytes-1]=199;return bs58.encode(b);};
const sleep = (ms:number,signal?:AbortSignal) => new Promise<void>((resolve,reject)=> {
  if(signal?.aborted){reject(Error('BENCHMARK_STOPPED'));return;}
  const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(done,ms);
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(Error('BENCHMARK_STOPPED'));};
  signal?.addEventListener('abort',abort,{once:true});
});
const report:any = {kind:'synthetic_io_real_production_supervisor',startedAt:iso(),environment:{node:process.version,cpuCount:cpus().length,cpuModel:cpus()[0]?.model},
  isolated:true,productionCodeModified:false,networkRequests:0,sellCalls:0,
  sourceFiles:Object.fromEntries(['src/native-solana/positions.ts','src/native-solana/runtime.ts','src/native-solana/pump.ts','src/native-solana/stream.ts']
    .map(path=>[path,{sha256:createHash('sha256').update(readFileSync(path)).digest('hex')} ])),
  measurement:{warmup:'No market-check warmup; registration-only events are flushed with a 5 ms wait before the measured interval.',
    coverage:'First quote and first published snapshot per contract are recorded separately; adjacent intervals require two observations.',
    fullQuote:'Time when mock full-balance quote resolves, before half-balance quote.',
    publishedSnapshot:'Time when the actual supervisor invokes its update callback after half-quote and batch completion.',
    input:'One dirty pulse per contract per second; adjacent refresh intervals are not direct node-to-price latency.'},
  settings:{loopMs:250,minCheckIntervalMs:500,fallbackIntervalMs:3000,batchSize:4,defaultAdmissionMaxPositions:20,dirtyPulseMs:1000,
    modeledRpcRequestsPerBalance:2,modeledRpcRequestsPerQuote:2,normalChecks:'balance -> full quote -> half quote (6 serial RPC waits)',
    higherThan20:'Only the benchmark registration bypasses normal opening admission; production admission maximum is unchanged.'},
  limitations:['Synthetic fixed latency IO is not an internet capacity test.','No websocket, SDK decode, network variance, RPC rate limiting or live notification overhead.',
    'All contracts receive one dirty pulse per second. Snapshots include the supervisor batch barrier and half-position quote.',
    'Mock quotedAt marks quote completion; production quotedAt marks quote request start, so production displayed age additionally includes its full-quote RPC duration.',
    'dueBacklog counts rows eligible by interval; it can include up to four checks currently in flight, and is not a separate queue length.',
    '50 and 100 positions exceed the unchanged production admission ceiling and exercise only scheduling behavior.'],results:[]};
function persist(){mkdirSync(resolve(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
try {
  for (let index=0;index<stages.length;index++) {
    const stage=stages[index]!,wallet=key(1),timestamps=new Map<string,number[]>(),fullTimestamps=new Map<string,number[]>(),checkStarts=new Map<string,number>();
    const fullLatency:number[]=[],snapshotLatency:number[]=[],quoteAge:number[]=[],dirtyLatency:number[]=[],backlogs:number[]=[];
    const firstFull=new Map<string,number>(),firstSnapshot=new Map<string,number>(),lastSeen=new Map<string,string>();
    let balances=0,fullQuotes=0,halfQuotes=0,mockRpcRequests=0,sellCalls=0,events=0,pulses=0,inFlight=0,maxInFlight=0;
    const pair=async(signal:AbortSignal)=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);try{for(let i=0;i<2;i++){mockRpcRequests++;await sleep(stage.rpcMs,signal);}}finally{inFlight--;}};
    let started=0;
    const supervisor=new NativePositionSupervisor(join(temporary,`stage-${index}.sqlite`),{
      loopMs:250,minCheckIntervalMs:500,fallbackIntervalMs:3000,batchSize:4,
      io:{
        balance:async request=>{balances++;checkStarts.set(request.orderId,performance.now());await pair(request.signal);
          return {wallet:request.wallet,mint:request.mint,amount:'1000000',tokenDecimals:6,slot:2,commitment:'confirmed' as const,observedAt:iso()};},
        quote:async request=>{const full=request.amount==='1000000';if(full)fullQuotes++;else halfQuotes++;await pair(request.signal);
          const at=performance.now();if(full){const arr=fullTimestamps.get(request.orderId)??[];arr.push(at);fullTimestamps.set(request.orderId,arr);
            if(!firstFull.has(request.orderId))firstFull.set(request.orderId,at-started);
            const begin=checkStarts.get(request.orderId);if(begin!==undefined)fullLatency.push(at-begin);}
          return {wallet:request.wallet,mint:request.mint,inputAmount:request.amount,outputAmount:request.amount,minimumOutputAmount:request.amount,
            quotedAt:iso(),expiresAt:new Date(Date.now()+9000).toISOString()};},
        sell:async()=>{sellCalls++;throw Error('BENCHMARK_SELL_FORBIDDEN');},
        reconcile:async()=>{throw Error('BENCHMARK_RECONCILE_FORBIDDEN');},
      },onUpdate:event=>{events++;const p=event.position;if(event.type!=='snapshot'||!p.quote||!p.lastCheckAt||lastSeen.get(p.buy.orderId)===p.lastCheckAt)return;
        lastSeen.set(p.buy.orderId,p.lastCheckAt);const now=performance.now(),arr=timestamps.get(p.buy.orderId)??[];arr.push(now);timestamps.set(p.buy.orderId,arr);
        if(!firstSnapshot.has(p.buy.orderId))firstSnapshot.set(p.buy.orderId,now-started);
        const start=checkStarts.get(p.buy.orderId);if(start!==undefined)snapshotLatency.push(now-start);
        quoteAge.push(Date.now()-Date.parse(p.quote.quotedAt));},
    });
    for(let i=0;i<stage.positions;i++)supervisor.register({orderId:`bench-${i}`,wallet,mint:key(i+100),inputAmount:'1000000',outputAmount:'1000000',tokenDecimals:6,
      signature:key(i+1000,64),buySlot:1,subscriptionAccounts:[key(i+10000)]});
    supervisor.setStreamState({connected:true,subscribedAccounts:Array.from({length:stage.positions},(_,i)=>key(i+10000))});
    // Flush registration-only events before timing market checks.
    await sleep(5);
    const delay=monitorEventLoopDelay({resolution:10});delay.enable();const cpu=process.cpuUsage();started=performance.now();
    supervisor.start();
    const dirtyTimer=setInterval(()=>{pulses++;for(let i=0;i<stage.positions;i++){const t=performance.now();supervisor.markDirty(`bench-${i}`,{slot:2});dirtyLatency.push(performance.now()-t);}},1000);
    const sampleTimer=setInterval(()=>{const now=Date.now();backlogs.push(supervisor.list().filter(row=>!row.lastAttemptAt||now-Date.parse(row.lastAttemptAt)>=(row.dirty?500:3000)).length);},500);
    await sleep(stage.seconds*1000);clearInterval(dirtyTimer);clearInterval(sampleTimer);
    const measuredMs=performance.now()-started,usage=process.cpuUsage(cpu),status=supervisor.status();delay.disable();
    const completedBeforeStop=[...timestamps.values()].reduce((n,v)=>n+v.length,0);
    const quoteGaps=[...timestamps.values()].flatMap(v=>v.slice(1).map((at,i)=>at-v[i]!));
    const fullGaps=[...fullTimestamps.values()].flatMap(v=>v.slice(1).map((at,i)=>at-v[i]!));
    const sourceAge=supervisor.list().filter(p=>p.quote).map(p=>Date.now()-Date.parse(p.quote!.quotedAt));
    const errors=supervisor.list().filter(p=>p.lastError).map(p=>p.lastError);
    await supervisor.close();
    const result={...stage,elapsedMs:round(measuredMs),admissionLimit:status.maxPositions,admissionReady:status.ready,admissionReason:status.reason,
      observedContracts:timestamps.size,contractsWithTwoSnapshots:[...timestamps.values()].filter(v=>v.length>=2).length,snapshots:completedBeforeStop,
      snapshotThroughputPerSecond:round(completedBeforeStop/(measuredMs/1000)),balances,fullQuotes,halfQuotes,mockRpcRequests,sellCalls,events,pulses,
      maxConcurrentMockRpcRequests:maxInFlight,firstFullQuoteWaitMs:summarize([...firstFull.values()]),firstPublishedSnapshotWaitMs:summarize([...firstSnapshot.values()]),
      fullQuoteFromCheckStartMs:summarize(fullLatency),snapshotFromCheckStartMs:summarize(snapshotLatency),fullQuoteRefreshIntervalMs:summarize(fullGaps),
      publishedSnapshotRefreshIntervalMs:summarize(quoteGaps),fullQuoteAgeWhenPublishedMs:summarize(quoteAge),latestQuoteAgeAtFinishMs:summarize(sourceAge),
      dirtyHandlerMs:summarize(dirtyLatency),dueBacklog:summarize(backlogs),eventLoopDelayMs:{mean:round(delay.mean/1e6),p95:round(delay.percentile(95)/1e6),p99:round(delay.percentile(99)/1e6),max:round(delay.max/1e6)},
      cpuPercentOfOneCore:round((usage.user+usage.system)/(measuredMs*1000)*100),rssMiB:round(process.memoryUsage().rss/1024/1024),stalePositions:status.stale,errors};
    report.results.push(result);report.sellCalls+=sellCalls;persist();
    console.log(JSON.stringify({stage:stage.positions,rpcMs:stage.rpcMs,snapshots:completedBeforeStop,coverage:timestamps.size,p95IntervalMs:result.publishedSnapshotRefreshIntervalMs.p95,
      firstCoverageMaxMs:result.firstPublishedSnapshotWaitMs.max,cpuPercent:result.cpuPercentOfOneCore,stale:status.stale}));
    if(sellCalls)throw Error('BENCHMARK_UNEXPECTED_EXIT');
  }
  report.finishedAt=iso();persist();console.log(JSON.stringify({report:out,networkRequests:0,sellCalls:report.sellCalls}));
} finally {rmSync(temporary,{recursive:true,force:true});}
