/** Read-only network benchmark. No signer, executor, order store, or Telegram imports. */
import {Connection} from '@solana/web3.js';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {readConfig} from '../dist/src/config.js';
import {PumpNativeAdapter} from '../dist/src/native-solana/pump.js';

const cfg=readConfig(),startedAt=new Date().toISOString();
const quoteOnly=process.argv.includes('--quote-only');
const official=process.argv.includes('--official');
const rpcUrl=official?'https://api.mainnet-beta.solana.com':cfg.nativeSolana.rpcUrl;
const output=process.argv.find(a=>a.startsWith('--output='))?.slice('--output='.length)??'reports/native-price-network-benchmark-20261026.json';
const wallet=readFileSync('data/native-solana/public-key.txt','utf8').trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const metrics=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b);return {n:v.length,p50Ms:v[Math.floor((v.length-1)*.5)]??null,p95Ms:v[Math.ceil((v.length-1)*.95)]??null,maxMs:v.at(-1)??null};};
let requests=0,abort=false;const rpc=[],failures=[];
const connection=new Connection(rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:async(url,options)=>{
  const method=JSON.parse(String(options?.body)).method;
  if(!['getMultipleAccounts','getTokenAccountsByOwner'].includes(method))throw Error('BENCH_READ_ONLY_METHOD_DENIED');
  if(abort||requests>=500)throw Error('BENCH_REQUEST_BUDGET_EXHAUSTED');requests++;
  const t=performance.now();let status=0,rpcError;
  try{const r=await fetch(url,{...options,signal:AbortSignal.timeout(5000)});status=r.status;
    if(status===429){abort=true;throw Error('BENCH_RATE_LIMIT_STOP');}
    const body=await r.clone().json().catch(()=>undefined);if(body?.error)rpcError={code:body.error.code,message:String(body.error.message).slice(0,200)};
    return r;
  }finally{rpc.push({method,status,rpcError,durationMs:performance.now()-t});}
}});
const adapter=new PumpNativeAdapter({connection});
const db=new DatabaseSync('data/ave-signals.sqlite',{readOnly:true});
const candidates=db.prepare("SELECT address,MAX(observed_at) lastAt FROM ave_signals WHERE chain='solana' GROUP BY address ORDER BY lastAt DESC LIMIT 40").all();db.close();
const tokens=[];
for(const row of candidates){
  if(abort||tokens.length>=(official?3:20))break;
  try{const q=await adapter.quoteSell({wallet,mint:row.address,amount:'1000000000',slippageBps:500});tokens.push({mint:row.address,venue:q.venue,accounts:q.subscriptionAccounts});}
  catch(e){failures.push({phase:'selection',mint:row.address,reason:e.reason??e.message});}
  await sleep(150);
}
console.log(JSON.stringify({phase:'selected',count:tokens.length,venues:tokens.reduce((a,t)=>(a[t.venue]=(a[t.venue]??0)+1,a),{}),requests,abort}));
const stages=[];
for(const count of [3,10,20]){
  if(abort||tokens.length<count)break;
  const selected=tokens.slice(0,count),records=[],lastReady=new Map(),intervals=[],t0=performance.now(),rpcStart=rpc.length;
  const lag=monitorEventLoopDelay({resolution:10});lag.enable();const cpuStart=process.cpuUsage();
  // Three sweeps, exactly the production maximum of four concurrent positions.
  // Actual balance is measured, but zero balances do not suppress read-only hypothetical quotes.
  for(let round=0;round<3&&!abort;round++){
    for(let i=0;i<count&&!abort;i+=4){
      await Promise.all(selected.slice(i,i+4).map(async token=>{
        const t=performance.now();let bDone,fullDone;
        try{
          const balance=quoteOnly?undefined:await adapter.balance(wallet,token.mint,'confirmed');bDone=performance.now();
          const q=await adapter.quoteSell({wallet,mint:token.mint,amount:'1000000000',slippageBps:500});fullDone=performance.now();
          if(lastReady.has(token.mint))intervals.push(fullDone-lastReady.get(token.mint));lastReady.set(token.mint,fullDone);
          await adapter.quoteSell({wallet,mint:token.mint,amount:'500000000',slippageBps:500});
          records.push({mint:token.mint,round,ok:true,balanceMs:bDone-t,fullQuoteMs:fullDone-bDone,fullReadyMs:fullDone-t,cycleMs:performance.now()-t,balanceWasZero:balance?.amount==='0',quoteStartedAt:q.quotedAt});
        }catch(e){records.push({mint:token.mint,round,ok:false,cycleMs:performance.now()-t,reason:e.reason??e.message});}
      }));
      await sleep(250);
    }
  }
  const durationMs=performance.now()-t0,cpu=process.cpuUsage(cpuStart);lag.disable();
  const ownRpc=rpc.slice(rpcStart),ok=records.filter(r=>r.ok);
  const result={count,durationMs,cycles:records.length,success:ok.length,failed:records.length-ok.length,
    rpcCalls:ownRpc.length,rpcPerSec:ownRpc.length/(durationMs/1000),rpcLatency:metrics(ownRpc.map(x=>x.durationMs)),
    balance:metrics(ok.map(r=>r.balanceMs)),fullQuote:metrics(ok.map(r=>r.fullQuoteMs)),fullReady:metrics(ok.map(r=>r.fullReadyMs)),
    completeCycle:metrics(ok.map(r=>r.cycleMs)),perTokenQuoteInterval:metrics(intervals),
    uniqueRequiredAccounts:new Set(selected.flatMap(t=>t.accounts)).size,streamAccountLimit:120,
    eventLoopP95Ms:lag.percentile(95)/1e6,cpuMs:(cpu.user+cpu.system)/1000,rssMiB:process.memoryUsage().rss/2**20,
    failures:records.filter(r=>!r.ok),records};
  stages.push(result);console.log(JSON.stringify({...result,records:undefined}));
  if(result.failed/Math.max(1,result.cycles)>.1)break;
  await sleep(1000);
}
mkdirSync('reports',{recursive:true});
const report={startedAt,finishedAt:new Date().toISOString(),rpcHost:new URL(rpcUrl).host,quoteOnly,
  method:`Real mainnet read-only RPC; ${quoteOnly?'balance skipped -> full quote -> half quote':'production balance -> full quote -> half quote'} order, batch=4, between-batch delay=250ms, 3 sweeps. Hypothetical quotes with fixed 1000-token quantity (for 6 decimals); no actual positions or transactions. Zero balances deliberately do not skip quotes. No WS reception or order execution latency measured here.`,
  caveats:['All selected tokens assumed continuously dirty: results measure loaded queue throughput, not quiet fallback cadence.',
    'No minCheck=500ms enforcement in this harness: if a measured per-token interval is below 500ms it overstates production speed.',
    'Three sweeps are a bounded load test, not a long-term service guarantee.',
    'Source timestamp in quote is load-start time, not actual block creation time.'],
  tokens,requests,rpcHttpStatus:rpc.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{}),rpcErrors:rpc.filter(r=>r.rpcError),abort,failures,stages};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
