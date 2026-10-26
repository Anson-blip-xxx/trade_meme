/** Read-only live Ave pricev2 benchmark. No login, HTTP, signer or transaction code.
 * Run: node --import tsx scripts/ave-price-benchmark.mjs [--seconds=60] [--steps=10,50,100,200] [--subscription-mode=full]
 * One socket, maximum 200 token topics, maximum 120 seconds/stage. Production DB is read-only.
 * Event time has one-second precision; source age is NOT precise wire latency.
 */
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {MarketPriceRouter} from '../src/market-price-router.ts';

const arg=(key,fallback)=>process.argv.find(v=>v.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
const seconds=Number(arg('seconds','60'));
const steps=arg('steps','10,50,100,200').split(',').map(Number);
const subscriptionMode=arg('subscription-mode','full');
if(!Number.isInteger(seconds)||seconds<15||seconds>120||steps.length>6||
  !['full','incremental'].includes(subscriptionMode)||
  steps.some((v,i)=>!Number.isInteger(v)||v<1||v>200||(i>0&&v<=steps[i-1])))throw Error('BOUND_INVALID');
const output=resolve(arg('output','reports/ave-price-benchmark-20261026.json'));
const db=new DatabaseSync(resolve(arg('database','data/ave-signals.sqlite')),{readOnly:true});
const candidates=db.prepare(`SELECT address,max(observed_at) latestSignalAt,count(*) signalCount
  FROM ave_signals WHERE chain='solana' GROUP BY address ORDER BY latestSignalAt DESC LIMIT 200`).all();
db.close();
if(candidates.length<steps.at(-1))throw Error('INSUFFICIENT_LOCAL_TOKENS');
const quantiles=values=>{
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y),q=p=>a.length?a[Math.min(a.length-1,Math.ceil(a.length*p)-1)]:null;
  return {n:a.length,p50:q(.5),p95:q(.95),p99:q(.99),max:a.at(-1)??null};
};
const round=value=>Number.isFinite(value)?Math.round(value*1000)/1000:null;
const report={startedAt:new Date().toISOString(),endpoint:'wss://yiyulu.com/ws',topic:'pricev2',
  subscriptionMode,
  boundaries:{network:'One read-only public WebSocket; no HTTP requests; no reconnect; no account authentication.',
    maxTokens:200,stageSeconds:seconds,productionDatabaseReadOnly:true,noSignerOrTradeImports:true,noProductionConfigChanges:true},
  semantics:{price:'Ave main-pair USD spot, not executable quote.',
    sourceAge:'Local receive time minus Ave Unix-second event time; contains up to 999 ms timestamp quantization, not precise network latency.',
    interarrival:'Time between accepted new provider timestamps for each token during that stage.',
    coverage:'Token topics with at least one validated new update during this stage. Quiet tokens do not prove dropped updates.',
    acknowledgements:'A subscription send is not a successful acknowledgement; actual price frames are independent evidence.',
    acceptance:'Same production MarketPriceRouter.ingestAvePriceFrame parser/cache; callbacks are in-memory, no production database/outbox.'},
  candidates,candidateSelection:'Latest 200 distinct SOL token addresses from local Ave signals, ordered by latest observed signal.',
  stages:[],errors:[],acks:[],frames:0,pongs:0,bytes:0,connectionOpens:0,unexpectedCloses:0};
const router=new MarketPriceRouter({maxGmgnPerBatch:0,maxDebotPerBatch:0,fetcher:async()=>{throw Error('HTTP_FORBIDDEN');}});
const socket=new WebSocket(report.endpoint),allSubscribed=new Set();
const histogram=monitorEventLoopDelay({resolution:10});histogram.enable();
let current,stopped=false,phase=0,pingTimer,finished=false;
const error=code=>{report.errors.push({at:new Date().toISOString(),code});stopped=true;};
socket.addEventListener('error',()=>error('WEBSOCKET_ERROR'));
socket.addEventListener('close',event=>{if(!finished){report.unexpectedCloses++;error(`UNEXPECTED_CLOSE_${event.code}`);}});
socket.addEventListener('message',event=>{
  const t0=performance.now(),received=Date.now();
  if(typeof event.data!=='string'||Buffer.byteLength(event.data)>2*1024*1024){error('INVALID_FRAME');return;}
  report.frames++;report.bytes+=Buffer.byteLength(event.data);
  if(event.data==='pong'){report.pongs++;return;}
  let value;try{value=JSON.parse(event.data);}catch{error('JSON_INVALID');return;}
  if(value.error){error(`JSON_RPC_ERROR_${Number(value.error.code)||'UNKNOWN'}`);return;}
  if(typeof value.id==='number'&&value.id>=100&&value.id<200){
    report.acks.push({id:value.id,at:new Date(received).toISOString(),resultType:typeof value.result,
      status:typeof value.result?.status==='string'?value.result.status.slice(0,32):undefined});
  }
  if(!current||value?.result?.status!=='ok'||value?.result?.data?.event!=='pricev2'||!Array.isArray(value.result.data.prices))return;
  const stage=current;stage.priceFrames++;
  const eligible=[];
  for(const row of value.result.data.prices){
    stage.rawPriceRows++;
    if(row?.chain!=='solana'||row.is_main_pair!==true||row.token!==row.target_token||!stage.tokenData.has(row.token)||
      !Number.isSafeInteger(row.time)||row.time<=0||row.time*1000>received||!Number.isFinite(row.uprice)||row.uprice<=0)continue;
    const data=stage.tokenData.get(row.token),at=row.time*1000;
    data.validRawRows++;eligible.push(row);
    if(at<=data.lastProviderAt){data.duplicateOrOldTimestamps++;continue;}
    data.lastProviderAt=at;data.newProviderTimestamps++;
    data.latestSourceAgeMs=received-at;data.sourceAgeMs.push(received-at);
    stage.sourceAgeMs.push(received-at);
    if(data.lastReceivedAt){data.interarrivalMs.push(received-data.lastReceivedAt);stage.interarrivalMs.push(received-data.lastReceivedAt);}
    if(!data.firstReceivedAt)data.firstReceivedAt=received;
    data.lastReceivedAt=received;
  }
  // Production parser is called with the same live payload shape, restricted to requested topics.
  const accepted=router.ingestAvePriceFrame({result:{status:'ok',data:{event:'pricev2',prices:eligible}}},new Date(received).toISOString(),()=>{stage.callbacks++;});
  stage.routerAccepted+=accepted;
  stage.processingMs.push(performance.now()-t0);
});
try {
  await Promise.race([new Promise((ok,no)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',()=>no(Error('CONNECT_FAILED')),{once:true});}),
    new Promise((_,no)=>setTimeout(()=>no(Error('CONNECT_TIMEOUT')),15000))]);
  report.connectionOpens++;
  pingTimer=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send('{"jsonrpc":"2.0","method":"ping","id":1}');},15000);
  for(const count of steps){
    if(stopped)break;
    histogram.reset();
    const list=candidates.slice(0,count),started=Date.now(),cpuStart=process.cpuUsage();
    const stage=current={subscriptionsRequested:count,startedAt:new Date(started).toISOString(),
      priceFrames:0,rawPriceRows:0,routerAccepted:0,callbacks:0,sourceAgeMs:[],interarrivalMs:[],processingMs:[],
      tokenData:new Map(list.map(token=>[token.address,{address:token.address,latestSignalAt:token.latestSignalAt,
        validRawRows:0,newProviderTimestamps:0,duplicateOrOldTimestamps:0,lastProviderAt:0,firstReceivedAt:0,lastReceivedAt:0,
        sourceAgeMs:[],interarrivalMs:[],latestSourceAgeMs:null}]))};
    const allTopics=list.map(t=>`${t.address}-solana`),adds=allTopics.filter(t=>!allSubscribed.has(t));
    socket.send(JSON.stringify({jsonrpc:'2.0',method:'subscribe',params:['pricev2',subscriptionMode==='full'?allTopics:adds],id:100+phase++}));
    for(const topic of adds)allSubscribed.add(topic);
    while(!stopped&&Date.now()-started<seconds*1000)await new Promise(ok=>setTimeout(ok,250));
    current=undefined;const end=Date.now(),wallMs=end-started,cpu=process.cpuUsage(cpuStart);
    const tokens=[...stage.tokenData.values()].map(d=>({address:d.address,latestSignalAt:d.latestSignalAt,
      validRawRows:d.validRawRows,newProviderTimestamps:d.newProviderTimestamps,duplicateOrOldTimestamps:d.duplicateOrOldTimestamps,
      firstUpdateWaitMs:d.firstReceivedAt?d.firstReceivedAt-started:null,lastSourceAt:d.lastProviderAt?new Date(d.lastProviderAt).toISOString():null,
      endSourceAgeMs:d.lastProviderAt?end-d.lastProviderAt:null,sourceAgeMs:quantiles(d.sourceAgeMs),interarrivalMs:quantiles(d.interarrivalMs)}));
    const active=tokens.filter(t=>t.newProviderTimestamps>0),sustained=tokens.filter(t=>t.newProviderTimestamps>=3);
    const summary={subscriptionsRequested:count,subscriptionsSent:allSubscribed.size,startedAt:stage.startedAt,endedAt:new Date(end).toISOString(),wallMs,
      tokensWithAnyNewUpdate:active.length,tokensWithAtLeast3NewUpdates:sustained.length,tokensWithoutNewUpdate:count-active.length,
      tokensWithEndSourceAgeUnder1s:tokens.filter(t=>t.endSourceAgeMs!==null&&t.endSourceAgeMs<=1000).length,
      tokensWithEndSourceAgeUnder3s:tokens.filter(t=>t.endSourceAgeMs!==null&&t.endSourceAgeMs<=3000).length,
      tokensWithEndSourceAgeUnder30s:tokens.filter(t=>t.endSourceAgeMs!==null&&t.endSourceAgeMs<=30000).length,
      priceFrames:stage.priceFrames,rawPriceRows:stage.rawPriceRows,routerAccepted:stage.routerAccepted,callbacks:stage.callbacks,
      acceptedUpdatesPerSec:round(stage.routerAccepted/(wallMs/1000)),sourceAgeMs:quantiles(stage.sourceAgeMs),
      perTokenInterarrivalMs:quantiles(stage.interarrivalMs),parseAndRouterMs:quantiles(stage.processingMs),
      eventLoopDelayMs:{p95:round(histogram.percentile(95)/1e6),max:round(histogram.max/1e6)},
      processCpuMs:round((cpu.user+cpu.system)/1000),processCpuPercentOfOneCore:round((cpu.user+cpu.system)/1000/wallMs*100),
      rssBytes:process.memoryUsage().rss,tokens};
    report.stages.push(summary);
    console.log(JSON.stringify({...summary,tokens:undefined}));
  }
} catch(e){error(e instanceof Error?e.message:'BENCHMARK_FAILED');}
finally {
  finished=true;current=undefined;clearInterval(pingTimer);histogram.disable();router.close();socket.close(1000,'read-only benchmark complete');
  report.finishedAt=new Date().toISOString();report.completedStages=report.stages.length;
  report.completed=!report.errors.length&&report.stages.length===steps.length;
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({report:output,completed:report.completed,stages:report.completedStages,errors:report.errors,frames:report.frames,acks:report.acks.length}));
}
