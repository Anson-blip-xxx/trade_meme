import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JevStatusRunner} from '../src/jev-status.js';

const waitFor=async(check:()=>boolean,timeoutMs=5000)=>{const end=Date.now()+timeoutMs;
  while(!check()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(check(),true,'status worker timed out');};
const comparison=(patch:Record<string,unknown>={})=>JSON.stringify({eligible:true,selected:true,baselineAt:new Date().toISOString(),
  horizons:{'5':{status:'complete',grossReturnPct:100},'15':{status:'pending'},'60':{status:'pending'}},...patch});

test('JEV dashboard aggregates are refreshed off-thread and remain available between refreshes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jev-status-')),database=join(dir,'jev.sqlite'),db=new DatabaseSync(database);
  db.exec('CREATE TABLE jev_results(status TEXT,completed_at TEXT,comparison TEXT)');
  const put=db.prepare('INSERT INTO jev_results VALUES(?,?,?)'),now=Date.now();
  put.run('available',new Date(now-1000).toISOString(),comparison());
  put.run('available',new Date(now-1000).toISOString(),comparison({selected:false,horizons:{'5':{status:'complete',grossReturnPct:-50},'15':{status:'pending'},'60':{status:'pending'}}}));
  put.run('unavailable',new Date(now-1000).toISOString(),comparison({selected:null,excludedReason:'JEV_UNAVAILABLE'}));
  put.run('pending',null,comparison({selected:null,baselineAt:undefined}));
  put.run('available',new Date(now-180_000).toISOString(),comparison({baselineAt:undefined}));
  db.close();
  const runner=new JevStatusRunner({database,intervalMs:100,staleAfterMs:1000});
  try{
    runner.start();await waitFor(()=>runner.snapshot().state==='fresh');const first=runner.snapshot().aggregate!;
    assert.deepEqual(first.counts,{total:5,available:3,unavailable:1,pending:1});
    assert.equal(first.comparison.eligible,5);assert.equal(first.comparison.selected,1);assert.equal(first.comparison.rejected,1);
    assert.equal(first.comparison.excluded,2);assert.equal(first.comparison.priced,3);
    assert.deepEqual(first.comparison.horizons[0],{minutes:5,pairs:2,baselineMeanGrossPct:25,
      jevSelectedMeanGrossPct:100,selectedCount:1,rejectedCount:1});
    const updated=new DatabaseSync(database);updated.prepare("UPDATE jev_results SET status='unavailable',comparison=? WHERE rowid=1")
      .run(comparison({selected:null,excludedReason:'JEV_TEST'}));updated.close();
    await waitFor(()=>runner.snapshot().aggregate?.computedAt!==first.computedAt&&runner.snapshot().aggregate?.counts.unavailable===2);
    assert.equal(runner.snapshot().aggregate?.comparison.selected,0);
  }finally{await runner.stop();rmSync(dir,{recursive:true,force:true});}
});

test('JEV status refresh yields between keyset pages so DELETE-journal writes do not time out',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jev-status-lock-')),database=join(dir,'jev.sqlite'),db=new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=50; CREATE TABLE jev_results(status TEXT,completed_at TEXT,comparison TEXT)');
  const put=db.prepare('INSERT INTO jev_results VALUES(?,?,?)'),value=comparison({padding:'x'.repeat(2048)});
  db.exec('BEGIN');for(let i=0;i<10_000;i++)put.run('available',new Date().toISOString(),value);db.exec('COMMIT');db.close();
  const runner=new JevStatusRunner({database,intervalMs:1000,staleAfterMs:5000}),writer=new DatabaseSync(database);
  writer.exec('PRAGMA busy_timeout=50');const update=writer.prepare('UPDATE jev_results SET status=? WHERE rowid=?');let busy=0;
  try{
    runner.start();await waitFor(()=>runner.snapshot().worker.inFlight);
    for(let i=0;i<500;i++)try{update.run(i%2?'available':'unavailable',i%10_000+1);}catch(error){
      if(String(error).includes('SQLITE_BUSY'))busy++;else throw error;
    }
    await waitFor(()=>runner.snapshot().state==='fresh',10_000);assert.equal(busy,0);
  }finally{writer.close();await runner.stop();rmSync(dir,{recursive:true,force:true});}
});

test('JEV status worker can stop immediately without closing its database under an active scan',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jev-status-stop-')),database=join(dir,'jev.sqlite'),db=new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE jev_results(status TEXT,completed_at TEXT,comparison TEXT)');
  const put=db.prepare('INSERT INTO jev_results VALUES(?,?,?)'),value=comparison({padding:'x'.repeat(1024)});
  db.exec('BEGIN');for(let i=0;i<2000;i++)put.run('available',new Date().toISOString(),value);db.exec('COMMIT');db.close();
  const runner=new JevStatusRunner({database,intervalMs:1000,staleAfterMs:5000});
  try{runner.start();await runner.stop();assert.equal(runner.snapshot().worker.running,false);}
  finally{await runner.stop();rmSync(dir,{recursive:true,force:true});}
});
