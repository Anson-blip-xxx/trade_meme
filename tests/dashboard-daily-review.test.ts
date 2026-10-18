import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDashboard,type DashboardServices} from '../src/dashboard.js';
import {ScanArchive} from '../src/scan-archive.js';
import {DailyReviewStore} from '../src/daily-review-store.js';
import {buildDailyReview} from '../src/daily-review.js';
import {config} from './helpers.js';

const password='daily-review-independent-dashboard-password';
const headers={'x-dashboard-access':password};
const report=()=>buildDailyReview({date:'2026-10-15',asOf:'2026-10-16T01:00:00.000Z',entryMode:'off',
  notifications:Array.from({length:25},(_,i)=>({id:String(i),chain:'bsc' as const,
    address:'0x'+(i+1).toString(16).padStart(40,'0'),source:'debot',receivedAt:'2026-10-15T01:00:00.000Z',occurredAt:'2026-10-15T00:59:59.000Z'})),
  decisions:[],prices:[],vendor:[],orders:[],executions:[],limitations:[]});
async function fixture(overrides:Partial<DashboardServices>={}) {
  const directory=mkdtempSync(join(tmpdir(),'dashboard-daily-review-'));
  for(const name of ['index.html','app.js','styles.css'])writeFileSync(join(directory,name),name);
  const cfg=config();cfg.dashboard.token=password;
  const archive=new ScanArchive(':memory:');
  const server=buildDashboard(cfg,{archive,overview:()=>({entryMode:'off'}),orders:()=>{throw new Error('MUST_NOT_TOUCH_ORDERS');},...overrides},directory);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/dashboard/api`;
  return {base,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));archive.close();rmSync(directory,{recursive:true,force:true});}};
}

test('daily review requires dashboard authentication, is read-only, and stays out of home requests',async()=>{
  const calls:unknown[]=[],f=await fixture({home:()=>({compact:true}),dailyReview:options=>{calls.push(options);return {items:[],total:0};}});
  try {
    assert.equal((await fetch(`${f.base}/daily-review`)).status,401);
    assert.equal((await fetch(`${f.base}/daily-review`,{headers:{'x-dashboard-access':'incorrect'}})).status,401);
    for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await fetch(`${f.base}/daily-review`,{method,headers})).status,405);
    assert.deepEqual(await(await fetch(`${f.base}/home`,{headers})).json(),{compact:true});assert.equal(calls.length,0);
    const response=await fetch(`${f.base}/daily-review?date=2026-10-15&runId=${'a'.repeat(24)}&limit=7&offset=14&chain=solana&sort=gain`,{headers});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(calls,[{date:'2026-10-15',runId:'a'.repeat(24),limit:7,offset:14,chain:'solana'}]);
  }finally{await f.close();}
});

test('daily review rejects malformed and impossible dates, run IDs and unbounded filters before service access',async()=>{
  let calls=0;const f=await fixture({dailyReview:()=>{calls++;return {items:[]};}});
  try {
    for(const query of ['date=2026-2-01','date=2026-02-30','date=2025-02-29','date=2026-13-01','date=invalid',
      'runId=bad',`runId=${'A'.repeat(24)}`,`runId=${'a'.repeat(25)}`,'limit=0','limit=101','limit=1.5',
      'offset=-1','offset=1000001','offset=1.5','chain=ethereum','sort=profit']) {
      const response=await fetch(`${f.base}/daily-review?${query}`,{headers});assert.equal(response.status,400,query);
      assert.deepEqual(await response.json(),{error:'INVALID_FILTER'});
    }
    assert.equal(calls,0);
    assert.equal((await fetch(`${f.base}/daily-review?date=2024-02-29`,{headers})).status,200);assert.equal(calls,1);
  }finally{await f.close();}
});

test('daily review pages pin immutable revision and chain filter without confusing full-report denominator',async()=>{
  const store=new DailyReviewStore(':memory:'),initial=report();store.save(initial);
  const f=await fixture({dailyReview:options=>store.page(options,new Date('2026-10-16T03:00:00.000Z'))});
  try {
    const first=await(await fetch(`${f.base}/daily-review?limit=20`,{headers})).json();
    assert.equal(first.report.id,initial.id);assert.equal(first.total,25);assert.equal(first.items.length,20);assert.equal(first.hasMore,true);
    store.save({...initial,id:'b'.repeat(24),generatedAt:'2026-10-17T01:00:00.000Z',items:initial.items.slice(0,1)});
    const pinned=await(await fetch(`${f.base}/daily-review?date=2026-10-15&runId=${initial.id}&offset=20&limit=20&chain=bsc`,{headers})).json();
    assert.equal(pinned.report.id,initial.id);assert.equal(pinned.total,25);assert.equal(pinned.items.length,5);assert.equal(pinned.hasMore,false);
    const empty=await(await fetch(`${f.base}/daily-review?runId=${initial.id}&chain=solana`,{headers})).json();
    assert.equal(empty.total,0);assert.equal(empty.items.length,0);assert.equal(empty.report.counts.tokens,25);
    assert.equal((await fetch(`${f.base}/daily-review?date=2026-10-14&runId=${initial.id}`,{headers})).status,400);
    const unknown=await(await fetch(`${f.base}/daily-review?runId=${'c'.repeat(24)}`,{headers})).json();
    assert.equal(unknown.total,0);assert.equal(unknown.report,undefined);assert.equal(unknown.hasMore,false);
  }finally{await f.close();store.close();}
});

test('unconfigured daily review returns a bounded empty page and still validates calendar dates',async()=>{
  const f=await fixture();
  try {
    const data=await(await fetch(`${f.base}/daily-review?limit=5&offset=10`,{headers})).json();
    assert.deepEqual(data,{enabled:false,dates:[],items:[],total:0,limit:5,offset:10,hasMore:false});
    assert.equal((await fetch(`${f.base}/daily-review?date=2026-02-30`,{headers})).status,400);
  }finally{await f.close();}
});
