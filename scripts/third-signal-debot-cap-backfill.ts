/** Bounded historical GET research only. Never imports an execution/trade client.
 * Usage: node --import tsx scripts/third-signal-debot-cap-backfill.ts <report.json> <snapshot.inputs.json.gz> <out.json> [maxRequests=180]
 * Official DeBot SignalCardList-CCyGgbJL.js calls channel/list with repeated
 * tokens, page_size, chain, channel_ids, next; next is returned verbatim.
 * Results are newly fetched historical vendor evidence, NOT available-at-entry
 * evidence. Only exact vendor id + chain + CA + occurredAt matches are retained.
 */
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import {DebotSessionClient,DebotSessionError} from '../src/providers/debot-session.js';

const [reportPath,inputPath,outputPath,limitRaw='180']=process.argv.slice(2);
if(!reportPath||!inputPath||!outputPath)throw new Error('EXPECTED_REPORT_INPUT_OUTPUT_PATHS');
const limit=Number(limitRaw);
if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error('MAX_REQUESTS_MUST_BE_1_TO_200');
const report=JSON.parse(readFileSync(reportPath,'utf8'));
const input=JSON.parse(gunzipSync(readFileSync(inputPath)).toString('utf8'));
type Target={eventId:string;providerId:string;chain:string;address:string;occurredAt:string;receivedAt:string};
const thirds=new Set<string>(report.thirdNotifications.filter((r:any)=>r.source==='debot').map((r:any)=>r.thirdEventId));
const targets=new Map<string,Target>();
for(const e of input.events){
  if(e.source!=='debot'||!thirds.has(e.eventId)||typeof e.providerId!=='string'||
    !/^[A-Za-z0-9_-]{1,128}$/.test(e.providerId))continue;
  targets.set(e.eventId,{eventId:e.eventId,providerId:e.providerId,chain:e.chain,address:e.address,
    occurredAt:e.occurredAt,receivedAt:e.receivedAt});
}
const channels:Record<string,number>={bsc:2,solana:1,robinhood:83};
type Work={chain:string;tokens:string[];next:string;seen:Set<string>};
const queue:Work[]=[];
for(const chain of Object.keys(channels)){
  const tokens=[...new Set([...targets.values()].filter(t=>t.chain===chain)
    .sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt)).map(t=>t.address))];
  for(let i=0;i<tokens.length;i+=5)queue.push({chain,tokens:tokens.slice(i,i+5),next:'',seen:new Set()});
}
const session=new DebotSessionClient({path:'data/debot/session.json'});
const result:{version:number;startedAt:string;finishedAt?:string;classification:string;maxRequests:number;requests:number;
  targetEvents:number;matchedEvents:number;validCaps:number;stopReason?:string;facts:any[];requestLog:any[];inputs:any}={
  version:1,startedAt:new Date().toISOString(),classification:'newly_fetched_historical_vendor_snapshot_not_known_at_original_receipt',
  maxRequests:limit,requests:0,targetEvents:targets.size,matchedEvents:0,validCaps:0,facts:[],requestLog:[],
  inputs:{reportPath,inputPath,inputSha256:createHash('sha256').update(readFileSync(inputPath)).digest('hex'),
    paginationEvidence:'official SignalCardList-CCyGgbJL.js: Fe({page_size:e,tokens:j?[j]:[],start_time:l,channel_ids:i,next:g,chain:d})'}};
const matched=new Set<string>();
const numeric=(v:unknown)=>{if(typeof v!=='number'&&typeof v!=='string')return;const n=Number(v);return Number.isFinite(n)&&n>0?n:undefined;};
function save(){result.finishedAt=new Date().toISOString();result.matchedEvents=matched.size;result.validCaps=result.facts.filter(x=>x.valid).length;
  writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n',{mode:0o600});}
while(queue.length&&result.requests<limit){
  const job=queue.shift()!;
  if(![...targets.values()].some(t=>t.chain===job.chain&&job.tokens.includes(t.address)&&!matched.has(t.eventId)))continue;
  const url=new URL('https://debot.ai/api/community/signal/channel/list');
  url.searchParams.set('request_id',randomUUID());url.searchParams.set('chain',job.chain);
  url.searchParams.set('channel_ids',String(channels[job.chain]));url.searchParams.set('page_size','50');
  for(const token of job.tokens)url.searchParams.append('tokens',token);
  if(job.next)url.searchParams.set('next',job.next);
  result.requests++;
  const started=Date.now();
  try{
    const response=await session.fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(12_000)});
    const payload:any=await response.json();
    if(![0,200].includes(payload?.code)||(!Array.isArray(payload?.data?.results)&&payload?.data?.results!==null)){
      result.requestLog.push({chain:job.chain,tokenFilters:job.tokens.length,next:job.next,
        httpStatus:response.status,providerCode:typeof payload?.code==='number'?payload.code:null,
        hasData:payload?.data!==undefined,hasResults:Array.isArray(payload?.data?.results)});
      result.stopReason='RESPONSE_INVALID';break;
    }
    const fetchedAt=new Date().toISOString();
    let accepted=0;
    const rows=payload.data.results??[];
    for(const row of rows){
      if(row?.chain!==job.chain||row.channel_id!==channels[job.chain]||typeof row.id!=='string')continue;
      const eventId='debot:signal:'+createHash('sha256').update(JSON.stringify([job.chain,channels[job.chain],row.id])).digest('hex');
      const target=targets.get(eventId);if(!target||matched.has(eventId))continue;
      if(target.providerId!==row.id||target.address!==row.token)continue;
      const seconds=numeric(row.create_time),stat=row.token_trading_stat;
      if(seconds===undefined||!Number.isSafeInteger(seconds)||new Date(seconds*1000).toISOString()!==target.occurredAt)continue;
      const statSeconds=numeric(stat?.lastUpdateTime),cap=numeric(stat?.mkt_cap),price=numeric(stat?.price);
      const ageSec=statSeconds===undefined?undefined:seconds-statSeconds;
      const valid=cap!==undefined&&statSeconds!==undefined&&Number.isSafeInteger(statSeconds)&&ageSec!==undefined&&ageSec>=0&&ageSec<=120;
      result.facts.push({...target,fetchedAt,marketCapUsd:cap??null,priceUsd:price??null,
        statAt:statSeconds===undefined?null:new Date(statSeconds*1000).toISOString(),statAgeBeforeSignalSec:ageSec??null,
        valid,reason:valid?'EXACT_EVENT_HISTORICAL_STAT_WITHIN_120S':'MISSING_OR_FUTURE_OR_OLD_STAT',
        capField:'results[].token_trading_stat.mkt_cap',statTimeField:'results[].token_trading_stat.lastUpdateTime',
        availableAt:fetchedAt,originalReceivedAt:target.receivedAt});
      matched.add(eventId);accepted++;
    }
    result.requestLog.push({chain:job.chain,tokenFilters:job.tokens.length,next:job.next,rows:rows.length,
      matched:accepted,elapsedMs:Date.now()-started,at:fetchedAt});
    const next=payload.data.next;
    if(typeof next==='string'&&next.trim()&&/^[A-Za-z0-9:_-]{1,200}$/.test(next)&&!job.seen.has(next)){
      job.seen.add(next);job.next=next;queue.push(job);
    }
    save();
    if(result.requests%10===0)console.log(JSON.stringify({requests:result.requests,matched:matched.size,validCaps:result.validCaps,pendingPages:queue.length}));
  }catch(error){
    const reason=error instanceof DebotSessionError?error.reason:'READ_FAILED';
    result.requestLog.push({chain:job.chain,tokenFilters:job.tokens.length,next:job.next,error:reason});
    if(reason==='DEBOT_SESSION_RESPONSE_TOO_LARGE'&&job.tokens.length>1){
      const midpoint=Math.ceil(job.tokens.length/2);
      queue.push({chain:job.chain,tokens:job.tokens.slice(0,midpoint),next:'',seen:new Set()},
        {chain:job.chain,tokens:job.tokens.slice(midpoint),next:'',seen:new Set()});save();
    }else{result.stopReason=reason;save();break;}
  }
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,1200-(Date.now()-started))));
}
result.stopReason??=queue.length?'REQUEST_LIMIT_REACHED':'TARGETS_FOUND_OR_AVAILABLE_PAGES_EXHAUSTED';
save();
console.log(JSON.stringify({outputPath,requests:result.requests,matched:result.matchedEvents,validCaps:result.validCaps,stopReason:result.stopReason}));
