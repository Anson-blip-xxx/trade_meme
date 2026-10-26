/** OFFLINE: real native SDK pricing + real supervisor/SQLite, synthetic accounts and balances.
 * node --import tsx scripts/native-holdings-capacity-benchmark.mjs
 * No production configuration, signer, socket, orders database or Telegram is loaded.
 */
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {NativePositionSupervisor} from '../src/native-solana/positions.ts';
import {createMarket} from './fixtures/native-capacity-market.mjs';

globalThis.fetch=async()=>{throw Error('BENCH_NETWORK_FORBIDDEN');};
const counts=[3,30,50,100],rounds=5;
const output=resolve(process.argv.find(v=>v.startsWith('--output='))?.slice(9)??'reports/native-holdings-capacity-20261026.json');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const summary=values=>{const a=[...values].sort((x,y)=>x-y),at=p=>a.length?Math.round(a[Math.ceil((a.length-1)*p)]*100)/100:null;
  return {count:a.length,p50:at(.5),p95:at(.95),p99:at(.99),max:at(1)};};
const report={startedAt:new Date().toISOString(),mode:'OFFLINE_SYNCHRONIZED_BURST_REAL_SDK_AND_SUPERVISOR',networkRequests:0,realTrades:0,
  environment:{node:process.version,cpuCount:cpus().length,cpu:cpus()[0]?.model},roundsPerStage:rounds,
  sourceHashes:Object.fromEntries(['src/native-solana/pump.ts','src/native-solana/positions.ts','scripts/fixtures/native-capacity-market.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')])),
  configuration:{eventDriven:true,loopMs:50,fallbackIntervalMs:1000,minCheckIntervalMs:0,staleAfterMs:1500,batchSize:20,
    normalAdmissionLimit:3,supervisorAdmissionLimit:20,accountSubscriptionLimit:120,benchmarkAdmissionOverride:true},
  method:{input:'Five synchronized bursts: every contract changes once in each burst; 1/3 Pump and 2/3 PumpSwap. Three required AMM frames arrive contiguously without network delay.',
    completion:'NativePositionSupervisor.onEvaluation after full-size/half-size SDK quotes and trigger decisions. Ordinary snapshots may be batched; trade intents remain durable before execution. See source hashes and supervisor configuration.',
    burstClock:'Common burst start through each completed decision, including queueing behind preceding contracts in that burst.',
    processingClock:'Per-contract local delivery start through its completed decision. This excludes time before its local callback starts.',
    sqlite:'Disposable on-disk database, production WAL + synchronous FULL settings; actual event queue callback acknowledged with no application work.'},
  limitations:['Not a mainnet capacity measurement. Production admission and 120-account subscription limits are deliberately not applied to isolated registration.',
    'Excludes node delivery/confirmation, gaps between AMM account frames, real inventory decoding, runtime order-ledger synchronization, IPC snapshots and Telegram.',
    'Bursts drain before the next burst; this does not prove a sustainable external arrival rate or continuous refresh cadence.',
    'Results are optimistic for the omitted stages and cannot be added linearly to the separate 3-contract live benchmark.',
    'No restart/reconnect snapshot storm or upstream rate limit is modeled.'],stages:[]};
function persist(){mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
const temporary=mkdtempSync(join(tmpdir(),'native-capacity-'));
try{
 for(const count of counts){
  const market=await createMarket(count),byMint=new Map(market.tokens.map((t,i)=>[t.mint,{...t,id:`bench-${i}`}]))
    ,pending=new Map(),latencies=[],local=[],results=[],failures=[],decodeTimes=[];
  let supervisor,sells=0,checks=0,phase='warmup';
  const observedSubscriptions=new Set();
  supervisor=new NativePositionSupervisor(join(temporary,`${count}.sqlite`),{
   eventDriven:true,loopMs:50,fallbackIntervalMs:1000,minCheckIntervalMs:0,staleAfterMs:1500,maxPositions:count+1,batchSize:20,
   io:{balance:async request=>({wallet:request.wallet,mint:request.mint,amount:byMint.get(request.mint).amount,tokenDecimals:6,
      slot:1000,commitment:'confirmed',observedAt:new Date().toISOString()}),
    quote:async request=>{const q=market.adapter.quoteSellCached({wallet:market.wallet,mint:request.mint,amount:request.amount,slippageBps:100});
      const now=Date.now();return {wallet:request.wallet,mint:request.mint,inputAmount:request.amount,outputAmount:q.expectedOutputAmount,
        minimumOutputAmount:q.minimumOutputAmount,quotedAt:new Date(now).toISOString(),expiresAt:new Date(now+1000).toISOString(),
        subscriptionAccounts:q.subscriptionAccounts,source:'solana_account_stream',marketObservedAt:q.quotedAt,marketSlot:q.slot};},
    sell:async()=>{sells++;throw Error('BENCH_SELL_FORBIDDEN');},reconcile:async()=>{throw Error('BENCH_RECONCILE_FORBIDDEN');}},
   onSubscriptions:accounts=>{for(const a of accounts)observedSubscriptions.add(a);},onUpdate:()=>{},
   onEvaluation:p=>{checks++;const task=pending.get(p.buy.mint);if(!task||p.quote?.marketSlot!==task.slot)return;
    const done=performance.now(),total=done-task.burstAt,processing=done-task.callbackAt;
    pending.delete(p.buy.mint);latencies.push(total);local.push(processing);results.push({round:task.round,contract:p.buy.orderId,burstToDecisionMs:total,callbackToDecisionMs:processing});},
  });
  try{
   for(const token of byMint.values())supervisor.register({orderId:token.id,wallet:market.wallet,mint:token.mint,
    inputAmount:token.baselineOutput,outputAmount:token.amount,tokenDecimals:6,signature:bs58.encode(createHash('sha512').update(token.id).digest()),
    buySlot:100,subscriptionAccounts:token.subscriptionAccounts,confirmedAt:new Date().toISOString()});
   supervisor.start();
   for(const token of byMint.values())await supervisor.checkNow(token.id);
   await delay(50);
   if(supervisor.list().some(p=>p.lastError))throw Error('BENCH_WARMUP_FAILED');
   const reads=market.mockReadCount(),lag=monitorEventLoopDelay({resolution:1});lag.enable();
   const cpu=process.cpuUsage(),stageAt=performance.now();phase='measure';
   for(let round=0;round<rounds;round++){
    const updates=[...byMint.values()].map(token=>({token,frames:token.frames(round+1)}));
    const burstAt=performance.now();
    for(const {token,frames} of updates){
     const callbackAt=performance.now();pending.set(token.mint,{round,slot:frames[0].slot,burstAt,callbackAt});
     for(const frame of frames){const receivedAtMs=Date.now(),begin=performance.now();
      const affected=market.adapter.ingestAccount(frame.address,frame.info,frame.slot,receivedAtMs);decodeTimes.push(performance.now()-begin);
      if(!affected.includes(token.mint))throw Error('BENCH_FRAME_NOT_INDEXED');
      supervisor.markDirty(token.id,{slot:frame.slot,observedAt:new Date(receivedAtMs).toISOString()});
     }
    }
    const deadline=performance.now()+20000;
    while(pending.size&&performance.now()<deadline)await delay(10);
    if(pending.size){failures.push({round,unresolved:[...pending.keys()],errors:supervisor.list().filter(p=>p.lastError).map(p=>p.lastError)});break;}
    await delay(200);
   }
   const measuredMs=performance.now()-stageAt,usage=process.cpuUsage(cpu);lag.disable();
   const result={positions:count,curveContracts:market.tokens.filter(t=>t.venue==='pump').length,poolContracts:market.tokens.filter(t=>t.venue==='pumpswap').length,
    expectedEvaluations:rounds*count,evaluations:results.length,coverage:new Set(results.map(r=>r.contract)).size,
    subscriptionAccounts:observedSubscriptions.size,exceedsProductionSubscriptions:observedSubscriptions.size>120,
    burstToDecisionMs:summary(latencies),callbackToDecisionMs:summary(local),accountDecodeAndCacheMs:summary(decodeTimes),
    eventLoopDelayMs:{p95:lag.percentile(95)/1e6,max:lag.max/1e6},cpuPercentOfOneCore:(usage.user+usage.system)/measuredMs/10,
    elapsedMs:measuredMs,checks,sellAttempts:sells,hotPathMockReads:market.mockReadCount()-reads,failures,
    over100ms:latencies.filter(n=>n>100).length,over1000ms:latencies.filter(n=>n>1000).length,over2000ms:latencies.filter(n=>n>2000).length,
    perRound:Array.from({length:rounds},(_,round)=>({round,...summary(results.filter(r=>r.round===round).map(r=>r.burstToDecisionMs))}))};
   report.stages.push(result);persist();console.log(JSON.stringify(result));
   if(sells||result.hotPathMockReads||failures.length)throw Error('BENCHMARK_UNEXPECTED_ACTIVITY_OR_FAILURE');
  }finally{phase='cleanup';await supervisor.close();}
 }
 report.finishedAt=new Date().toISOString();persist();
}finally{rmSync(temporary,{recursive:true,force:true});}
