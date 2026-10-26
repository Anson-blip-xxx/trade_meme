import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {OrderStore} from '../src/orders.js';

const requested=Number(process.argv.find(arg=>arg.startsWith('--rows='))?.slice(7)??50_000);
if(!Number.isSafeInteger(requested)||requested<1||requested>1_000_000)throw Error('BENCHMARK_ROWS_INVALID');
const dir=mkdtempSync(join(tmpdir(),'native-hotpath-bench-')),path=join(dir,'orders.sqlite');
const store=new OrderStore(path),writer=new DatabaseSync(path);
try{
  writer.exec('PRAGMA synchronous=OFF;BEGIN IMMEDIATE');
  const insert=writer.prepare(`INSERT INTO opening_orders
    (id,event_key,chain,token_address,mode,status,created_at,updated_at,details) VALUES(?,?,?,?,?,?,?,?,?)`);
  const at='2026-10-26T00:00:00.000Z';
  for(let i=0;i<requested;i++){
    const id=`history-${i}`,address=`history-mint-${i}`;
    insert.run(id,id,'solana',address,'live','failed',at,at,JSON.stringify({id,chain:'solana',tokenAddress:address,mode:'live',status:'failed',details:{executionProvider:'pump_native'}}));
  }
  for(let i=0;i<2_000;i++){
    const id=`other-active-${i}`,address=`other-mint-${i}`;
    insert.run(id,id,'solana',address,'live','submitted',at,at,JSON.stringify({id,chain:'solana',tokenAddress:address,mode:'live',status:'submitted',details:{executionProvider:'gmgn'}}));
  }
  for(let i=0;i<30;i++){
    const id=`native-active-${i}`,address=`native-mint-${i}`;
    insert.run(id,id,'solana',address,'live','submitted',at,at,JSON.stringify({id,chain:'solana',tokenAddress:address,mode:'live',status:'submitted',details:{executionProvider:'pump_native'}}));
  }
  writer.exec('COMMIT');
  store.activeNativePositions();
  const samples:number[]=[];
  for(let i=0;i<200;i++){const start=performance.now();const rows=store.activeNativePositions();samples.push(performance.now()-start);if(rows.length!==30)throw Error('BENCHMARK_RESULT_INVALID');}
  samples.sort((a,b)=>a-b);
  const plan=writer.prepare(`EXPLAIN QUERY PLAN SELECT details FROM opening_orders WHERE mode='live' AND chain='solana'
    AND status IN ('submitting','submitted','confirmed','unknown')
    AND json_extract(details,'$.details.executionProvider')='pump_native'
    AND COALESCE(json_extract(details,'$.exit.positionClosed'),0)<>1
    AND NOT (COALESCE(json_extract(details,'$.details.authoritativeClose.kind'),'')='direct_sell') ORDER BY rowid ASC`).all();
  console.log(JSON.stringify({historicalRows:requested,unrelatedActiveRows:2_000,nativeActiveRows:30,samples:samples.length,
    p50Ms:samples[Math.floor(samples.length*.5)],p95Ms:samples[Math.floor(samples.length*.95)],maxMs:samples.at(-1),
    queryPlan:plan.map(row=>String(row.detail))},null,2));
}finally{
  try{writer.exec('ROLLBACK');}catch{}
  writer.close();store.close();rmSync(dir,{recursive:true,force:true});
}
