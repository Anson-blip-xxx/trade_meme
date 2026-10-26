import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import type {JevComparison,JevStatusAggregate} from './jev-shadow.js';

const options=workerData as {database:string;intervalMs:number};
const db=new DatabaseSync(options.database,{readOnly:true});
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
let stopping=false,working=false,closed=false,timer:ReturnType<typeof setTimeout>|undefined;
const WAIT_MS=120_000,BATCH=8;
const parse=(value:unknown):JevComparison=>{try{return JSON.parse(String(value)) as JevComparison;}catch{return {
  eligible:false,selected:null,sampleCount:0,method:'observed_price_gross',horizons:{'5':{status:'pending'},'15':{status:'pending'},'60':{status:'pending'}}};}};
const pause=()=>new Promise<void>(resolve=>setImmediate(resolve));
const scan=db.prepare(`SELECT rowid AS cursor,status,completed_at,comparison FROM jev_results
  WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`);

/**
 * DELETE-journal readers hold a shared lock for the duration of one statement.
 * Keyset batches deliberately keep each statement tiny, then yield so the
 * writer's 50 ms busy timeout is never exposed to a multi-second table scan.
 */
async function read():Promise<JevStatusAggregate|undefined> {
  const now=Date.now(),counts={total:0,available:0,unavailable:0,pending:0};
  const comparison:JevStatusAggregate['comparison']={eligible:0,selected:0,rejected:0,excluded:0,priced:0,horizons:[]};
  const horizons=Object.fromEntries(['5','15','60'].map(minutes=>[minutes,{pairs:0,sum:0,selectedCount:0,selectedSum:0,rejectedCount:0}])) as
    Record<'5'|'15'|'60',{pairs:number;sum:number;selectedCount:number;selectedSum:number;rejectedCount:number}>;
  const ceiling=Number(db.prepare('SELECT max(rowid) AS n FROM jev_results').get()!.n??0);let cursor=0;
  while(cursor<ceiling){
    const rows=scan.all(cursor,ceiling,BATCH);if(!rows.length)break;
    for(const row of rows){
      counts.total++;const status=String(row.status);
      if(status==='available'||status==='unavailable'||status==='pending')counts[status]++;
      const value=parse(row.comparison),completed=typeof row.completed_at==='string'?Date.parse(row.completed_at):NaN;
      // JevShadow.item() makes a missing baseline ineligible after the same
      // bounded wait. Complete horizons are immutable, so pending->missed time
      // transitions do not alter any paired-return aggregate below.
      const timedOut=value.eligible&&!value.baselineAt&&!value.excludedReason&&Number.isFinite(completed)&&now>completed+WAIT_MS;
      const excluded=!!value.excludedReason||timedOut;
      comparison.eligible+=value.eligible?1:0;comparison.excluded+=excluded?1:0;comparison.priced+=value.baselineAt?1:0;
      if(value.eligible&&!excluded&&value.selected===true)comparison.selected++;
      if(value.eligible&&!excluded&&value.selected===false)comparison.rejected++;
      if(value.eligible&&!excluded&&value.selected!==null)for(const minutes of ['5','15','60'] as const){
        const horizon=value.horizons?.[minutes];if(horizon?.status!=='complete'||!Number.isFinite(horizon.grossReturnPct))continue;
        const target=horizons[minutes],gain=horizon.grossReturnPct!;target.pairs++;target.sum+=gain;
        if(value.selected){target.selectedCount++;target.selectedSum+=gain;}else target.rejectedCount++;
      }
    }
    cursor=Number(rows.at(-1)!.cursor);await pause();if(stopping)return;
  }
  for(const minutes of ['5','15','60'] as const){const value=horizons[minutes];
    comparison.horizons.push({minutes:Number(minutes),pairs:value.pairs,baselineMeanGrossPct:value.pairs?value.sum/value.pairs:null,
      jevSelectedMeanGrossPct:value.selectedCount?value.selectedSum/value.selectedCount:null,
      selectedCount:value.selectedCount,rejectedCount:value.rejectedCount});
  }
  const usedBytes=Number(db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.prepare('PRAGMA page_size').get()!.page_size);
  return {counts,comparison,usedBytes,computedAt:new Date(now).toISOString()};
}

const close=()=>{if(closed)return;closed=true;db.close();parentPort!.close();};
const run=async()=>{
  if(stopping){close();return;}working=true;parentPort!.postMessage({type:'working',at:new Date().toISOString()});
  try{const aggregate=await read();if(aggregate&&!stopping)parentPort!.postMessage({type:'status',aggregate});}
  catch{if(!stopping)parentPort!.postMessage({type:'failed'});}
  finally{working=false;}
  if(stopping)close();else timer=setTimeout(()=>void run(),options.intervalMs);
};
parentPort!.on('message',message=>{if(message!=='stop')return;stopping=true;clearTimeout(timer);if(!working)close();});
void run();
