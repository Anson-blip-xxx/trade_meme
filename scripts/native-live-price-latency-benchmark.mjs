/** Mainnet READ ONLY. Uses no signer, executor, secrets, order store or Telegram.
 * node --env-file-if-exists=.env --import tsx scripts/native-live-price-latency-benchmark.mjs --seconds=90 --count=3
 * Owner balances and buy fills below are explicitly simulated in a disposable DB. */
import {Connection} from '@solana/web3.js';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import bs58 from 'bs58';
import {readConfig} from '../src/config.ts';
import {PumpNativeAdapter} from '../src/native-solana/pump.ts';
import {NativeAccountStream} from '../src/native-solana/stream.ts';
import {NativePositionSupervisor} from '../src/native-solana/positions.ts';

const arg=(name,fallback)=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const seconds=Number(arg('seconds','90')),count=Number(arg('count','3')),probeSeconds=Number(arg('probe-seconds','20'));
if(!Number.isInteger(seconds)||seconds<30||seconds>180||!Number.isInteger(count)||count<1||count>10||!Number.isInteger(probeSeconds)||probeSeconds<10||probeSeconds>40)throw Error('BENCH_OPTIONS_INVALID');
const cfg=readConfig(),wallet=readFileSync('data/native-solana/public-key.txt','utf8').trim();
const rpcUrl=cfg.nativeSolana.rpcUrl,wsUrl=cfg.nativeSolana.wsUrl;
const output=resolve(arg('output','reports/native-live-price-latency-20261026-dual-timing.json'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const summary=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b);return {count:v.length,p50:v[Math.floor((v.length-1)*.5)]??null,p95:v[Math.ceil((v.length-1)*.95)]??null,p99:v[Math.ceil((v.length-1)*.99)]??null,max:v.at(-1)??null};};
const code=e=>/^[A-Z][A-Z0-9_]+$/.test(e?.reason??e?.message??'')?(e.reason??e.message):'BENCH_EXTERNAL_FAILURE';
const report={startedAt:new Date().toISOString(),rpcHost:new URL(rpcUrl).hostname,wsHost:new URL(wsUrl).hostname,requestedPositions:count,requestedSeconds:seconds,
  mode:'READ_ONLY_MAINNET_WS_SIMULATED_HOLDINGS',simulation:{balances:'fixed positive atomic quantity; not actual wallet holdings',fills:'synthetic registration only',sell:'stub returns pending; never broadcasts',telegram:false,signing:false},
  method:'One native account WebSocket; validated pool snapshots at setup only. Actual stream bytes drive cached official-SDK quotes, full and half simulated position valuation and native supervisor threshold decisions in a mode-600 disposable SQLite database.',
  limitations:['Measured receive-to-valuation latency begins at account WS frame arrival in this process. It excludes on-chain-to-provider propagation and order submission/landing.',
    'No market activity is not a fast update; per-mint frame/evaluation coverage is mandatory.',
    'A confirmed Solana account subscription has chain confirmation and provider latency. Slot lag is reported without inventing sub-second block timestamps.',
    'Three matching PumpSwap account slots and update rounds reduce mixed snapshots but do not prove same-transaction write versions. Actual execution still requires fresh independent transaction validation.',
    'This isolated process measures native monitoring independently of other process stalls. A 90-second run is not an availability guarantee.'],
  candidates:[],selection:[],http:[],resets:[],errors:[],states:[],priceErrors:{},simulatedExitIntents:[],wire:{sent:[],acks:[],errors:[],heads:0}};
let phase='bootstrap',aborted=false,stopReason,requestCount=0,lastRequestAt=0,gate=Promise.resolve(),supervisor,stream,selected=[],liveStarted=0,measurementRpcStart=0;
const clockRows=[],lag=monitorEventLoopDelay({resolution:1});
const probe=new Map(),stats=new Map(),eventTimes=new Map(),seenEvaluations=new Set(),latestExpected=new Map();
const pendingFrames=new Map(),quoteMetadata=new Map();let frameSequence=0;
const bump=(map,key)=>{map[key]=(map[key]??0)+1;};
const connection=new Connection(rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:async(url,options)=>{
  const method=JSON.parse(String(options?.body)).method;
  if(!['getGenesisHash','getMultipleAccounts'].includes(method))throw Error('BENCH_READ_ONLY_METHOD_DENIED');
  if(phase==='measure'){aborted=true;stopReason='BENCH_HOT_PATH_HTTP_ATTEMPT';throw Error(stopReason);}
  let release;const previous=gate;gate=new Promise(r=>{release=r;});await previous;
  try {
    if(aborted||requestCount>=65)throw Error('BENCH_HTTP_BUDGET_EXHAUSTED');
    await delay(Math.max(0,220-(performance.now()-lastRequestAt)));lastRequestAt=performance.now();requestCount++;
    const started=performance.now();let status=0,rpcErrorCode;
    try{
      const response=await fetch(url,{...options,signal:AbortSignal.timeout(8000)});status=response.status;
      if(status===429){aborted=true;stopReason='BENCH_RATE_LIMIT_STOP';throw Error(stopReason);}
      const body=await response.clone().json().catch(()=>undefined);rpcErrorCode=body?.error?.code;
      if(rpcErrorCode===429||rpcErrorCode===-32429){aborted=true;stopReason='BENCH_RATE_LIMIT_STOP';throw Error(stopReason);}
      return response;
    }finally{report.http.push({phase,method,status,rpcErrorCode,latencyMs:performance.now()-started});}
  }finally{release();}
}});
const adapter=new PumpNativeAdapter({connection});
const dir=mkdtempSync(join(tmpdir(),'native-live-price-'));chmodSync(dir,0o700);
const tpath=join(dir,'positions.sqlite');
const mintMap=new Map();
function recordEvaluation(p){
  if(phase!=='measure'||!p.quote)return;
  const q=p.quote,row=stats.get(p.buy.mint);
  if(!row||q.source!=='solana_account_stream'||!q.marketObservedAt)return;
  const timestamp=Date.parse(q.marketObservedAt),quoteKey=`${p.buy.mint}:${q.marketSlot}:${q.marketObservedAt}:${q.outputAmount}`;
  const meta=quoteMetadata.get(quoteKey);if(!meta)return;
  const eventKey=`${p.buy.mint}:${meta.throughSequence}`;
  if(timestamp<liveStarted||seenEvaluations.has(eventKey))return;
  seenEvaluations.add(eventKey);const completedAt=Date.now(),lastRequiredMs=completedAt-timestamp,firstPendingMs=completedAt-meta.firstPendingAt;
  row.evaluations++;row.receiveToEvaluationMs.push(firstPendingMs);row.firstPendingFrameToEvaluationMs.push(firstPendingMs);
  row.lastRequiredFrameToEvaluationMs.push(lastRequiredMs);row.waitForCompleteAccountsMs.push(timestamp-meta.firstPendingAt);row.marketSlots.add(q.marketSlot);
  if(row.lastEvaluatedMarketAt!==undefined)row.marketUpdateIntervalsMs.push(timestamp-row.lastEvaluatedMarketAt);
  row.lastEvaluatedMarketAt=timestamp;
  if(latestExpected.get(p.buy.mint)!==q.outputAmount){row.changedQuotes++;latestExpected.set(p.buy.mint,q.outputAmount);}
  // Successful completed valuation consumes only frames incorporated into its full quote.
  // Any frames received during subsequent half-quote / persistence remain pending for the next evaluation.
  pendingFrames.set(p.buy.mint,(pendingFrames.get(p.buy.mint)??[]).filter(f=>f.sequence>meta.throughSequence));
  quoteMetadata.delete(quoteKey);
  clockRows.push({mint:p.buy.mint,slot:q.marketSlot,firstPendingFrameAt:new Date(meta.firstPendingAt).toISOString(),
    lastRequiredFrameAt:new Date(timestamp).toISOString(),completedAt:new Date(completedAt).toISOString(),
    firstPendingFrameToEvaluationMs:firstPendingMs,lastRequiredFrameToEvaluationMs:lastRequiredMs,
    waitForCompleteAccountsMs:timestamp-meta.firstPendingAt,outputAmount:q.outputAmount});
}

try {
  if(await connection.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error('BENCH_WRONG_CHAIN');
  const db=new DatabaseSync('data/ave-signals.sqlite',{readOnly:true});
  const candidates=db.prepare("SELECT address,MAX(observed_at) latestSignalAt,COUNT(*) signalCount FROM ave_signals WHERE chain='solana' GROUP BY address ORDER BY latestSignalAt DESC LIMIT 24").all();db.close();
  const pool=[];
  for(const candidate of candidates){
    if(aborted||pool.length>=Math.max(count,8)||requestCount>=49)break;
    try {
      const warmed=await adapter.warmQuoteCache(wallet,candidate.address);
      const full=adapter.quoteSellCached({wallet,mint:candidate.address,amount:'1000000000',slippageBps:100});
      adapter.quoteSellCached({wallet,mint:candidate.address,amount:'500000000',slippageBps:100});
      pool.push({...candidate,...warmed,mint:candidate.address,amount:'1000000000',discoveryOutput:full.expectedOutputAmount});
      report.candidates.push({mint:candidate.address,latestSignalAt:candidate.latestSignalAt,signalCount:candidate.signalCount,accepted:true,venue:warmed.venue});
    }catch(e){report.candidates.push({mint:candidate.address,latestSignalAt:candidate.latestSignalAt,accepted:false,reason:code(e)});}
  }
  if(aborted||pool.length<count)throw Error(stopReason??'BENCH_INSUFFICIENT_VALIDATED_CANDIDATES');
  for(const item of pool){mintMap.set(item.mint,item);probe.set(item.mint,{frames:0,priceFrames:0});}
  stream=new NativeAccountStream(wsUrl,wallet,{
    dirty:()=>{},
    state:s=>{report.states.push({at:new Date().toISOString(),phase,connected:s.connected,subscribedAccounts:s.subscribedAccounts.length});supervisor?.setStreamState(s);},
    reset:r=>{
      report.resets.push({phase,at:new Date().toISOString(),reason:r.reason,generation:r.generation});
      if(r.reason==='accounts_removed')return;
      adapter.invalidateCache();
      if(phase==='measure'){aborted=true;stopReason=`BENCH_STREAM_${r.reason.toUpperCase()}`;}
    },
    head:()=>{},
    account:event=>{
      if(event.kind!=='account')return;
      const started=performance.now();const affected=adapter.ingestAccount(event.address,event.info,event.slot,event.receivedAtMs);
      const elapsed=performance.now()-started;
      for(const token of pool){if(!token.subscriptionAccounts.includes(event.address))continue;
        const p=probe.get(token.mint);p.frames++;if(token.priceAccounts.includes(event.address))p.priceFrames++;
      }
      if(phase!=='measure'||aborted)return;
      for(const mint of affected){const row=stats.get(mint),token=mintMap.get(mint);if(!row||!token?.priceAccounts.includes(event.address))continue;
        row.marketFrames++;row.decodeAndCacheMs.push(elapsed);row.wireSlots.add(event.slot);
        const pending=pendingFrames.get(mint)??[];pending.push({sequence:++frameSequence,receivedAtMs:event.receivedAtMs});pendingFrames.set(mint,pending);
        const head=stream.status().lastHeadSlot;if(head!==undefined)row.headSlotLag.push(head-event.slot);
        const prior=eventTimes.get(mint);if(prior!==undefined)row.rawFrameIntervalsMs.push(event.receivedAtMs-prior);eventTimes.set(mint,event.receivedAtMs);
        supervisor.markDirty(`bench-${mint}`,{slot:event.slot,observedAt:new Date(event.receivedAtMs).toISOString()});
      }
    },
  },url=>{const ws=new WebSocket(url),send=ws.send.bind(ws);ws.send=data=>{const q=JSON.parse(data);report.wire.sent.push({id:q.id,method:q.method});send(data);};
    ws.addEventListener('message',event=>{try{const m=JSON.parse(event.data);if(m.id!==undefined){report.wire.acks.push(m.id);if(m.error)report.wire.errors.push({id:m.id,code:m.error.code});}if(m.method==='slotNotification')report.wire.heads++;}catch{}});return ws;});
  stream.setAccounts([...new Set(pool.flatMap(t=>t.subscriptionAccounts))]);phase='probe';stream.start();
  const connecting=Date.now();while(!stream.status().connected&&!aborted){if(Date.now()-connecting>15000){
      report.probeIncompleteStatus=stream.status();const missing=[...new Set(pool.flatMap(t=>t.subscriptionAccounts))].filter(a=>!report.probeIncompleteStatus.subscribedAccounts.includes(a));
      const unavailable=pool.filter(t=>t.subscriptionAccounts.some(a=>missing.includes(a)));
      report.unsubscribableCandidates=unavailable.map(t=>({mint:t.mint,venue:t.venue,missingAccounts:t.subscriptionAccounts.filter(a=>missing.includes(a)),reason:'BENCH_WS_ACK_TIMEOUT'}));
      if(!report.probeIncompleteStatus.transportHealthy||unavailable.length===0||pool.length-unavailable.length<count)throw Error('BENCH_WS_ACK_TIMEOUT');
      for(const t of unavailable)pool.splice(pool.indexOf(t),1);
      stream.setAccounts([...new Set(pool.flatMap(t=>t.subscriptionAccounts))]);
      if(!stream.status().connected)throw Error('BENCH_WS_ACK_TIMEOUT');
    }await delay(100);}
  console.log(JSON.stringify({phase:'probe',validatedCandidates:pool.length,accounts:stream.status().requestedAccounts,seconds:probeSeconds}));
  await delay(probeSeconds*1000);
  const ranked=pool.toSorted((a,b)=>probe.get(b.mint).priceFrames-probe.get(a.mint).priceFrames);
  // When active examples exist, cover both protocol paths rather than assuming the suffix reveals the venue.
  for(const venue of ['pump','pumpswap']){const token=ranked.find(x=>x.venue===venue&&probe.get(x.mint).priceFrames>0);if(token&&selected.length<count)selected.push(token);}
  for(const token of ranked)if(selected.length<count&&!selected.includes(token))selected.push(token);
  stream.setAccounts([...new Set(selected.flatMap(t=>t.subscriptionAccounts))]);phase='warm';
  const ack=Date.now();while(!stream.status().connected){if(Date.now()-ack>15000)throw Error('BENCH_SELECTED_WS_ACK_TIMEOUT');await delay(50);}
  for(const token of selected){
    const q=await adapter.warmQuoteCache(wallet,token.mint);Object.assign(token,q);
    // WS frames during the warm have already been buffered and merged inside PumpNativeAdapter.
    let quote;const coherentDeadline=Date.now()+5000;
    while(!quote){try{quote=adapter.quoteSellCached({wallet,mint:token.mint,amount:token.amount,slippageBps:100});}catch(e){if(!['NATIVE_STREAM_SLOT_INCOMPLETE','NATIVE_STREAM_ROUND_INCOMPLETE'].includes(code(e))||Date.now()>coherentDeadline)throw e;await delay(20);}}
    token.entryCost=quote.expectedOutputAmount;
    report.selection.push({mint:token.mint,venue:token.venue,latestSignalAt:token.latestSignalAt,signalCount:token.signalCount,probe:probe.get(token.mint),tokenDecimals:token.tokenDecimals,subscriptionAccounts:token.subscriptionAccounts.length,priceAccounts:token.priceAccounts.length});
  }
  supervisor=new NativePositionSupervisor(tpath,{eventDriven:true,autoSchedule:false,minCheckIntervalMs:0,fallbackIntervalMs:3000,loopMs:50,requestTimeoutMs:1000,maxPositions:count+1,batchSize:Math.min(20,count),onEvaluation:recordEvaluation,
    io:{
      async balance(request){const token=mintMap.get(request.mint);return {wallet,mint:request.mint,amount:token.amount,tokenDecimals:token.tokenDecimals,slot:Math.max(token.slot,stream.status().lastHeadSlot??0),commitment:'confirmed',observedAt:new Date().toISOString()};},
      async quote(request){
        if(!stream.status().connected)throw Error('BENCH_STREAM_NOT_LIVE');
        try{const q=adapter.quoteSellCached({wallet,mint:request.mint,amount:request.amount,slippageBps:100},{headSlot:stream.status().lastHeadSlot});
          const evaluated=Date.now(),pending=pendingFrames.get(request.mint)??[];
          if(phase==='measure'&&request.amount===mintMap.get(request.mint).amount&&pending.length){
            const quoteKey=`${request.mint}:${q.slot}:${q.quotedAt}:${q.expectedOutputAmount}`;
            quoteMetadata.set(quoteKey,{firstPendingAt:pending[0].receivedAtMs,throughSequence:pending.at(-1).sequence});
          }
          return {wallet,mint:request.mint,inputAmount:request.amount,outputAmount:q.expectedOutputAmount,minimumOutputAmount:q.minimumOutputAmount,
            quotedAt:new Date(evaluated).toISOString(),expiresAt:new Date(evaluated+1000).toISOString(),source:'solana_account_stream',marketObservedAt:q.quotedAt,marketSlot:q.slot};
        }catch(e){bump(report.priceErrors,code(e));throw e;}
      },
      async sell(request){report.simulatedExitIntents.push({at:new Date().toISOString(),mint:request.mint,reason:request.reason,percent:request.percent,amount:request.expectedAmount});return {status:'pending',reason:'BENCH_READ_ONLY_NO_BROADCAST'};},
      async reconcile(){return {status:'pending',reason:'BENCH_READ_ONLY_NO_BROADCAST'};},
    }});
  for(let i=0;i<selected.length;i++){
    const token=selected[i];stats.set(token.mint,{mint:token.mint,venue:token.venue,marketFrames:0,evaluations:0,changedQuotes:0,receiveToEvaluationMs:[],firstPendingFrameToEvaluationMs:[],lastRequiredFrameToEvaluationMs:[],waitForCompleteAccountsMs:[],decodeAndCacheMs:[],headSlotLag:[],marketUpdateIntervalsMs:[],rawFrameIntervalsMs:[],marketSlots:new Set(),wireSlots:new Set()});
    supervisor.register({orderId:`bench-${token.mint}`,wallet,mint:token.mint,inputAmount:token.entryCost,outputAmount:token.amount,tokenDecimals:token.tokenDecimals,
      signature:bs58.encode(Buffer.alloc(64,i+1)),buySlot:token.slot,subscriptionAccounts:token.subscriptionAccounts});
  }
  supervisor.start();supervisor.setStreamState(stream.status());await Promise.all(selected.map(t=>supervisor.checkNow(`bench-${t.mint}`)));
  measurementRpcStart=requestCount;phase='measure';liveStarted=Date.now();report.measurementStartedAt=new Date(liveStarted).toISOString();lag.enable();const cpuStart=process.cpuUsage();
  console.log(JSON.stringify({phase:'measure',positions:count,venues:selected.map(t=>t.venue),seconds,bootstrapHttp:requestCount,subscribedAccounts:stream.status().subscribedAccounts.length}));
  let nextProgress=Date.now()+15000;
  while(Date.now()-liveStarted<seconds*1000&&!aborted){
    await delay(100);
    if(Date.now()>=nextProgress){console.log(JSON.stringify({phase:'progress',seconds:Math.round((Date.now()-liveStarted)/1000),frames:[...stats.values()].map(r=>r.marketFrames),evaluations:[...stats.values()].map(r=>r.evaluations),priceErrors:report.priceErrors}));nextProgress+=15000;}
  }
  report.durationMs=Date.now()-liveStarted;report.httpCallsDuringMeasurement=requestCount-measurementRpcStart;
  const cpu=process.cpuUsage(cpuStart);lag.disable();report.eventLoopDelayMs={p50:lag.percentile(50)/1e6,p95:lag.percentile(95)/1e6,max:lag.max/1e6};report.cpuMs=(cpu.user+cpu.system)/1000;report.rssMiB=process.memoryUsage().rss/2**20;
  report.positionRows=supervisor.list().map(p=>({mint:p.buy.mint,state:p.state,lastError:p.lastError,pendingExit:p.pendingExit?.reason,lastCheckAt:p.lastCheckAt}));
  report.perMint=[...stats.values()].map(r=>({...r,receiveToEvaluationMs:summary(r.receiveToEvaluationMs),firstPendingFrameToEvaluationMs:summary(r.firstPendingFrameToEvaluationMs),lastRequiredFrameToEvaluationMs:summary(r.lastRequiredFrameToEvaluationMs),waitForCompleteAccountsMs:summary(r.waitForCompleteAccountsMs),decodeAndCacheMs:summary(r.decodeAndCacheMs),headSlotLag:summary(r.headSlotLag),marketUpdateIntervalsMs:summary(r.marketUpdateIntervalsMs),rawFrameIntervalsMs:summary(r.rawFrameIntervalsMs),marketSlots:[...r.marketSlots],wireSlots:[...r.wireSlots]}));
  report.firstPendingFrameToEvaluationMs=summary(clockRows.map(r=>r.firstPendingFrameToEvaluationMs));
  report.lastRequiredFrameToEvaluationMs=summary(clockRows.map(r=>r.lastRequiredFrameToEvaluationMs));
  report.waitForCompleteAccountsMs=summary(clockRows.map(r=>r.waitForCompleteAccountsMs));
  report.aggregateReceiveToEvaluationMs=report.firstPendingFrameToEvaluationMs;
  report.pendingUnconsumedFrames=[...pendingFrames].map(([mint,frames])=>({mint,count:frames.length,oldestAgeMs:frames.length?Date.now()-frames[0].receivedAtMs:null}));
  report.timingDefinitions={firstPendingFrameToEvaluation:'First not-yet-evaluated affected market frame arrival through successful complete threshold decision and local persistence. Includes wait for coherent PumpSwap accounts. Failed / incomplete checks do not clear this clock.',lastRequiredFrameToEvaluation:'Latest required account frame incorporated in the full-size quote through successful threshold decision and local persistence.',evaluationHook:'NativePositionSupervisor.onEvaluation, before any sell or notification wait',pendingConsumption:'Sequence bounded: only frames incorporated into the successful full quote are removed; newly arrived frames during the check remain pending.'};report.actualUpdateMintCoverage=report.perMint.filter(r=>r.marketFrames>0).length;report.evaluatedMintCoverage=report.perMint.filter(r=>r.evaluations>0).length;
  report.acceptance={timingSamplesNonnegative:clockRows.every(r=>r.firstPendingFrameToEvaluationMs>=r.lastRequiredFrameToEvaluationMs&&r.lastRequiredFrameToEvaluationMs>=0),allRequestedMintsActuallyEvaluated:report.evaluatedMintCoverage===count,minimum10EvaluationsEach:report.perMint.every(r=>r.evaluations>=10),zeroHotPathHttp:report.httpCallsDuringMeasurement===0,
    fullDuration:report.durationMs>=seconds*1000,noStreamReset:!aborted,p95LocalUnder100ms:report.aggregateReceiveToEvaluationMs.p95!==null&&report.aggregateReceiveToEvaluationMs.p95<100,eachMintP95Under100ms:report.perMint.every(r=>r.receiveToEvaluationMs.p95!==null&&r.receiveToEvaluationMs.p95<100),
    note:'First pending frame p95 (including coherent-account wait) is qualified only with all requested mints covered, at least 10 evaluations each, no stream loss, zero hot-path HTTP and full requested duration.'};
  report.acceptance.passed=Object.entries(report.acceptance).filter(([k])=>k!=='note').every(([,v])=>v===true);
  report.quoteSamples=clockRows.slice(0,1000);
}catch(e){report.errors.push({phase,reason:code(e)});stopReason??=code(e);}
finally {
  phase='cleanup';stream?.stop();await supervisor?.close();lag.disable();rmSync(dir,{recursive:true,force:true});
  report.finishedAt=new Date().toISOString();report.stopReason=stopReason;report.aborted=aborted;report.totalHttpCalls=requestCount;
  mkdirSync('reports',{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});chmodSync(output,0o600);
  process.exitCode=report.acceptance?.passed===true&&report.errors.length===0&&!aborted?0:1;
  console.log(JSON.stringify({report:output,stopReason,aborted,totalHttpCalls:requestCount,actualUpdateMintCoverage:report.actualUpdateMintCoverage,evaluatedMintCoverage:report.evaluatedMintCoverage,receiveToEvaluationMs:report.aggregateReceiveToEvaluationMs,acceptance:report.acceptance,errors:report.errors}));
}
