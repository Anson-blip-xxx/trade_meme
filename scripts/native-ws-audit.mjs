/** Read-only native stream audit: no signer, executor, trade requests or state changes. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {PublicKey} from '@solana/web3.js';
import {bondingCurvePda} from '@pump-fun/pump-sdk';
import {readConfig} from '../dist/src/config.js';

const config=readConfig(),durationMs=Math.min(120_000,Math.max(15_000,Number(process.env.AUDIT_DURATION_MS||45_000)));
const wallet=readFileSync('data/native-solana/public-key.txt','utf8').trim();
const mint='CHxkeLQ2Mc95vvk13vjRwwnNphCYZ83a8wtvM6tzpump';
const accounts=[mint,bondingCurvePda(new PublicKey(mint)).toBase58()];
const programs=['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const startedAt=new Date().toISOString(), started=performance.now();
const host=url=>new URL(url).hostname;
const q=(v,p)=>v.length?[...v].sort((a,b)=>a-b)[Math.max(0,Math.min(v.length-1,Math.ceil(v.length*p)-1))]:null;
const stats=v=>({count:v.length,min:q(v,0),p50:q(v,.5),p95:q(v,.95),p99:q(v,.99),max:q(v,1)});
const loop=monitorEventLoopDelay({resolution:20});loop.enable();
function audit(url){return new Promise(resolve=>{
  const begin=performance.now(),ws=new WebSocket(url),requests=new Map(),subscriptions=new Map();
  const report={host:host(url),connected:false,openMs:null,acks:[],errors:[],close:null,frames:0,bytes:0,slots:0,slotFirst:null,slotLast:null,accountNotifications:0,programNotifications:0,slotGapsMs:null,unanswered:[],lastSlotAgeMs:null};
  const gaps=[];let lastSlotAt=0,done=false;
  const finish=()=>{if(done)return;done=true;report.closedByAudit=!report.close;report.unanswered=[...requests.values()].map(r=>({method:r.method,label:r.label}));report.slotGapsMs=stats(gaps);report.lastSlotAgeMs=lastSlotAt?performance.now()-lastSlotAt:null;try{ws.close();}catch{}resolve(report);};
  setTimeout(finish,durationMs);
  ws.addEventListener('open',()=>{report.connected=true;report.openMs=performance.now()-begin;
    const send=(method,params,label)=>{const id=requests.size+1;requests.set(id,{method,label,sent:performance.now()});ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));};
    send('slotSubscribe',[],'slots');
    for(const account of accounts)send('accountSubscribe',[account,{encoding:'base64',commitment:'confirmed'}],account);
    for(const program of programs)send('programSubscribe',[program,{encoding:'base64',commitment:'confirmed',filters:[{memcmp:{offset:32,bytes:wallet}}]}],program);
  });
  ws.addEventListener('message',event=>{
    if(done||typeof event.data!=='string')return;report.frames++;report.bytes+=Buffer.byteLength(event.data);
    let frame;try{frame=JSON.parse(event.data);}catch{return;}
    if(frame.id!==undefined){const request=requests.get(frame.id);if(!request)return;requests.delete(frame.id);
      if(frame.error){report.errors.push({method:request.method,label:request.label,code:frame.error.code,message:String(frame.error.message).slice(0,240),elapsedMs:performance.now()-request.sent});}
      else{report.acks.push({method:request.method,label:request.label,validSubscription:Number.isSafeInteger(frame.result),elapsedMs:performance.now()-request.sent});subscriptions.set(frame.result,request);}
      return;
    }
    if(frame.method==='slotNotification'){const now=performance.now();if(lastSlotAt)gaps.push(now-lastSlotAt);lastSlotAt=now;report.slots++;const slot=frame.params?.result?.slot;report.slotFirst??=slot;report.slotLast=slot;}
    else if(frame.method==='accountNotification')report.accountNotifications++;
    else if(frame.method==='programNotification')report.programNotifications++;
  });
  ws.addEventListener('error',()=>{report.errors.push({method:'websocket',message:'Transport error',elapsedMs:performance.now()-begin});});
  ws.addEventListener('close',event=>{if(done)return;report.close={code:event.code,reason:event.reason,elapsedMs:performance.now()-begin};finish();});
});}
const health=[],home=[];
let polling=false;
async function poll(){if(polling)return;polling=true;try{
  const begin=performance.now();try{const response=await fetch('http://127.0.0.1:8787/health',{signal:AbortSignal.timeout(6000)});const body=await response.json();health.push({at:new Date().toISOString(),durationMs:performance.now()-begin,httpStatus:response.status,status:body.status,executionReady:body.executionReady,countingRunning:body.countingRunning});}catch(error){health.push({at:new Date().toISOString(),durationMs:performance.now()-begin,error:error.name});}
  if(home.length===0||performance.now()-home.at(-1).relativeMs>=9000){const begin=performance.now();try{const response=await fetch(`http://127.0.0.1:${config.dashboard.port}/dashboard/api/home`,{headers:{'x-dashboard-access':config.dashboard.token},signal:AbortSignal.timeout(6000)});const body=await response.json();home.push({at:new Date().toISOString(),relativeMs:performance.now()-started,durationMs:performance.now()-begin,httpStatus:response.status,nativeExecution:body.status?.nativeExecution??body.nativeExecution});}catch(error){home.push({at:new Date().toISOString(),relativeMs:performance.now()-started,durationMs:performance.now()-begin,error:error.name});}}
}finally{polling=false;}}
const pollTimer=setInterval(()=>void poll(),2000);void poll();
const endpoints=[...new Set([config.nativeSolana.wsUrl,'wss://api.mainnet-beta.solana.com'])];
const streams=await Promise.all(endpoints.map(audit));clearInterval(pollTimer);while(polling)await new Promise(r=>setTimeout(r,20));loop.disable();
const indexRequests=await Promise.all([...new Set([config.nativeSolana.rpcUrl,'https://api.mainnet-beta.solana.com'])].map(async url=>{const begin=performance.now();try{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTokenAccountsByOwner',params:[wallet,{programId:programs[0]},{encoding:'base64',commitment:'confirmed'}]}),signal:AbortSignal.timeout(6000)});const body=await response.json();return {host:host(url),method:'getTokenAccountsByOwner',httpStatus:response.status,durationMs:performance.now()-begin,error:body.error,accountCount:body.result?.value?.length,slot:body.result?.context?.slot};}catch(error){return {host:host(url),method:'getTokenAccountsByOwner',durationMs:performance.now()-begin,error:{message:error.name}};}}));
const result={kind:'readonly_native_websocket_audit',startedAt,finishedAt:new Date().toISOString(),durationMs:performance.now()-started,wallet,accounts,subscriptionMethodsPerEndpoint:{slotSubscribe:1,accountSubscribe:accounts.length,programSubscribe:programs.length},streams,indexRequests,production:{health,healthTimeoutCount:health.filter(x=>x.error==='TimeoutError').length,healthErrorCount:health.filter(x=>x.error).length,healthSuccessfulLatencyMs:stats(health.filter(x=>x.httpStatus).map(x=>x.durationMs)),healthLatencyIncludingTimeoutsLowerBoundMs:stats(health.map(x=>x.durationMs)),home},auditProcessEventLoopDelayMs:{mean:loop.mean/1e6,p95:loop.percentile(95)/1e6,max:loop.max/1e6},limitations:['Production health latency includes HTTP scheduling and server handling; it is not a direct measurement of production event-loop delay.','Timeouts are included in total latency distribution as elapsed lower bounds; actual response delay can be greater.','This tests WebSocket subscription health and heartbeat, not real-time price computation capacity.','No signer is loaded and no transaction is built, simulated, signed or sent.']};
mkdirSync('reports',{recursive:true});const output=process.env.AUDIT_OUTPUT||'reports/native-ws-audit-20261026.json';writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({output,streams,indexRequests,healthAttempts:health.length,healthTimeoutCount:result.production.healthTimeoutCount,healthLatencyIncludingTimeoutsLowerBoundMs:result.production.healthLatencyIncludingTimeoutsLowerBoundMs,productionNative:home.map(x=>({at:x.at,httpStatus:x.httpStatus,nativeExecution:x.nativeExecution})),auditProcessEventLoopDelayMs:result.auditProcessEventLoopDelayMs},null,2));
