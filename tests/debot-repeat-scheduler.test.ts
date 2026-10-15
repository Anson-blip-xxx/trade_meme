import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promoteDebotRiskUpdates} from '../src/debot-repeat-scheduler.js';
import type {DebotRepeatEvidence} from '../src/debot-repeat-evidence.js';

const base=Date.parse('2026-10-15T00:00:00Z'),iso=(seconds:number)=>new Date(base+seconds*1000).toISOString();
const now=(seconds=100)=>new Date(iso(seconds)),address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const outcome=(priority:DebotRepeatEvidence['priority']='normal',material=false):DebotRepeatEvidence=>({material,priority,reasons:[],
  evidence:{fromAt:iso(0),untilAt:iso(100),status:material?'changed':'unchanged',coverage:'sampled',vendorChanges:[],
    observedTrades:[],researchTargets:[],limitations:[]}});
function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE debot_signals(id TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,state TEXT NOT NULL,
    observed_at TEXT,dispatched_at TEXT,evidence_cutoff_at TEXT,analyzed INTEGER DEFAULT 0,
    review_after TEXT,review_priority INTEGER DEFAULT 0,risk_checked_at TEXT,payload TEXT,details TEXT);
    CREATE INDEX debot_signals_token ON debot_signals(chain,address);`);
  const insert=(id:string,n:number,patch:Record<string,unknown>={})=>{
    const row={id,chain:'bsc',address:address(n),state:'pending',observed_at:iso(90),dispatched_at:null,
      evidence_cutoff_at:null,analyzed:0,review_after:iso(130),review_priority:0,risk_checked_at:null,payload:'{}',details:null,...patch};
    db.prepare(`INSERT INTO debot_signals(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`)
      .run(...Object.values(row) as (string|number|null)[]);
  };
  const pair=(n:number,patch:Record<string,unknown>={})=>{
    insert('prior:'+n,n,{state:'completed',observed_at:iso(1),dispatched_at:iso(10),evidence_cutoff_at:iso(15),analyzed:1,review_after:null});
    insert('pending:'+n,n,patch);
  };
  const get=(id:string)=>db.prepare('SELECT * FROM debot_signals WHERE id=?').get(id)!;
  return {db,insert,pair,get};
}

test('local risk wakes a repeated token already in cooldown without changing analysis state or timestamps',()=>{
  const {db,pair,get}=fixture();
  try {
    pair(1);const before=get('pending:1');
    const result=promoteDebotRiskUpdates(db,{now:now(),assess:(row,previous)=>{
      assert.equal(row.id,'pending:1');assert.equal(previous.evidence_cutoff_at,iso(15));return outcome('risk',true);
    }});
    const after=get('pending:1');
    assert.deepEqual(result,{checked:1,promoted:1,failed:0});assert.equal(after.review_priority,100);assert.equal(after.review_after,null);
    assert.equal(after.risk_checked_at,iso(100));
    for(const key of ['state','observed_at','dispatched_at','evidence_cutoff_at','analyzed','payload','details'])assert.equal(after[key],before[key]);
  }finally{db.close();}
});

test('only material risk is promoted and it ranks ahead of a new token and ordinary wallet activity',()=>{
  const {db,pair,insert}=fixture();
  try {
    pair(1);pair(2);pair(3);insert('fresh',4,{review_after:null,observed_at:iso(99)});
    const result=promoteDebotRiskUpdates(db,{now:now(),assess:row=>row.id==='pending:1'?outcome('risk',true):
      row.id==='pending:2'?outcome('wallet',true):outcome('risk',false)});
    assert.equal(result.promoted,1);
    const order=db.prepare("SELECT id FROM debot_signals WHERE state='pending' AND (review_after IS NULL OR review_after<=?) ORDER BY review_priority DESC,observed_at DESC").all(iso(100));
    assert.deepEqual(order.map(row=>row.id),['pending:1','fresh']);
  }finally{db.close();}
});

test('non-risk reassessment clears stale priority but preserves its cooldown and existing details',()=>{
  const {db,pair,get}=fixture();
  try {
    pair(1,{review_priority:100,details:'{"immutable":"detail"}'});
    promoteDebotRiskUpdates(db,{now:now(),assess:()=>outcome('wallet',true)});
    const row=get('pending:1');assert.equal(row.review_priority,0);assert.equal(row.review_after,iso(130));
    assert.equal(row.details,'{"immutable":"detail"}');
  }finally{db.close();}
});

test('the scheduler checks at most eight tokens and rotates to previously unreviewed tasks',()=>{
  const {db,pair}=fixture();
  try {
    for(let i=1;i<=12;i++)pair(i);
    const first:string[]=[],second:string[]=[];
    const a=promoteDebotRiskUpdates(db,{now:now(),max:100,assess:row=>{first.push(row.id);return outcome();}});
    const b=promoteDebotRiskUpdates(db,{now:now(101),max:4,assess:row=>{second.push(row.id);return outcome();}});
    assert.equal(a.checked,8);assert.equal(b.checked,4);assert.equal(new Set([...first,...second]).size,12);
    const third:string[]=[];promoteDebotRiskUpdates(db,{now:now(102),max:4,assess:row=>{third.push(row.id);return outcome();}});
    assert.deepEqual(third,first.slice(0,4));
  }finally{db.close();}
});

test('one token cannot consume the bounded candidate budget through several pending rows',()=>{
  const {db,pair,insert}=fixture();
  try {
    pair(1);pair(2);insert('repeat:1',1,{observed_at:iso(80)});insert('repeat:2',1,{observed_at:iso(85)});
    const seen:string[]=[];promoteDebotRiskUpdates(db,{now:now(),assess:row=>{seen.push(row.address);return outcome();}});
    assert.deepEqual(seen.sort(),[address(1),address(2)]);
  }finally{db.close();}
});

test('first observations, other chains and an active same-token analysis cannot supply a repeat baseline',()=>{
  const {db,pair,insert}=fixture();
  try {
    insert('first',1);insert('different-chain-prior',1,{chain:'robinhood',analyzed:1,state:'completed'});
    pair(2);insert('active',2,{state:'dispatching'});pair(3);
    const seen:string[]=[];const result=promoteDebotRiskUpdates(db,{now:now(),assess:row=>{seen.push(row.id);return outcome('risk',true);}});
    assert.deepEqual(seen,['pending:3']);assert.equal(result.promoted,1);
  }finally{db.close();}
});

test('the most recent analyzed baseline is selected using evidence cutoff and then dispatch time',()=>{
  const {db,pair,insert}=fixture();
  try {
    pair(1);insert('newest:1',1,{state:'completed',analyzed:1,dispatched_at:iso(50),evidence_cutoff_at:iso(55)});
    insert('failed:1',1,{state:'failed',dispatched_at:iso(90)});
    pair(2);insert('newest:2',2,{state:'completed',analyzed:1,dispatched_at:iso(60)});
    const seen:string[]=[];promoteDebotRiskUpdates(db,{now:now(),assess:(_row,prior)=>{seen.push(prior.id);return outcome();}});
    assert.deepEqual(seen,['newest:1','newest:2']);
  }finally{db.close();}
});

test('assessment exceptions produce a fixed reason, retain cooldown and do not prevent the next task',()=>{
  const {db,pair,get}=fixture();
  try {
    pair(1,{review_priority:100});pair(2);
    const result=promoteDebotRiskUpdates(db,{now:now(),assess:row=>{if(row.id==='pending:1')throw new Error('secret credential');return outcome('risk',true);}});
    assert.deepEqual(result,{checked:2,promoted:1,failed:1,reason:'DEBOT_REPEAT_RISK_EVIDENCE_UNAVAILABLE'});
    assert.equal(get('pending:1').review_priority,0);assert.equal(get('pending:1').review_after,iso(130));
    assert.equal(get('pending:1').risk_checked_at,iso(100));assert.equal(JSON.stringify(result).includes('secret'),false);
  }finally{db.close();}
});

test('invalid windows, malformed callback output and unavailable storage return fixed diagnostics',()=>{
  const {db,pair}=fixture();
  pair(1);
  try {
    for(const patch of [{now:new Date('invalid')},{max:-1},{max:NaN}]) {
      const result=promoteDebotRiskUpdates(db,{now:now(),assess:()=>{throw new Error('must not run');},...patch});
      assert.equal(result.checked,0);assert.equal(result.reason,'DEBOT_REPEAT_RISK_REVIEW_UNAVAILABLE');
    }
    assert.deepEqual(promoteDebotRiskUpdates(db,{now:now(),max:0,assess:()=>{throw new Error('must not run');}}),{checked:0,promoted:0,failed:0});
    const malformed=promoteDebotRiskUpdates(db,{now:now(),assess:()=>({priority:'risk'} as DebotRepeatEvidence)});
    assert.equal(malformed.promoted,0);assert.equal(malformed.reason,'DEBOT_REPEAT_RISK_EVIDENCE_UNAVAILABLE');
  }finally{db.close();}
  const closed=promoteDebotRiskUpdates(db,{now:now(),assess:()=>outcome()});
  assert.deepEqual(closed,{checked:0,promoted:0,failed:1,reason:'DEBOT_REPEAT_RISK_REVIEW_UNAVAILABLE'});
});

test('a candidate removed during a local callback is never resurrected or marked as dispatched',()=>{
  const {db,pair,get}=fixture();
  try {
    pair(1);
    const result=promoteDebotRiskUpdates(db,{now:now(),assess:row=>{
      db.prepare("UPDATE debot_signals SET state='ignored' WHERE id=?").run(row.id);return outcome('risk',true);
    }});
    assert.equal(result.promoted,0);assert.equal(get('pending:1').state,'ignored');assert.equal(get('pending:1').review_priority,0);
  }finally{db.close();}
});
