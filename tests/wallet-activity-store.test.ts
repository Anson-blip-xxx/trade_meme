import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WalletActivityStore} from '../src/wallet-activity-store.js';
import type {ActivityKind,WalletActivity} from '../src/wallet-activity.js';

const base=Date.parse('2026-11-18T00:00:00.000Z');
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');

function activity(id:number,classification:ActivityKind,checkedAt=base,padded=false):WalletActivity {
  return {version:1,chain:'bsc',wallet:address(1),txHash:hash(id),receivedAt:new Date(checkedAt-10).toISOString(),
    checkedAt:new Date(checkedAt).toISOString(),classification,reasons:['TEST_EVIDENCE'],trades:[],retryable:false,
    confirmation:'included',transferCount:padded?32:0,tradingEnabled:false,
    ...(padded?{transfers:Array.from({length:32},(_,index)=>({from:address(index+2),to:address(index+100),
      tokenAddress:address(index+200),amountAtomic:'9'.repeat(80)}))}:{})};
}

test('sparse low-value retention uses its partial time index instead of scanning durable history',()=>{
  const store=new WalletActivityStore(':memory:',64*1024*1024,{lowValueTtlMs:60_000,lowValueMaxRows:10});
  try {
    assert.equal(store.record(activity(1,'unknown')),true);
    const db=(store as any).db,prepare=db.prepare.bind(db);let plan='';
    db.exec('BEGIN');const insert=db.prepare('INSERT INTO wallet_activity VALUES (?,?,?,?,?,?,?)');
    for(let id=2;id<=20_001;id++)insert.run(`durable-${id}`,'bsc',address(1),hash(id),'buy',new Date(base-120_000+id).toISOString(),'{}');
    db.exec('COMMIT');
    const indexes=db.prepare("PRAGMA index_list('wallet_activity')").all().map((row:any)=>String(row.name));
    assert.ok(indexes.includes('wallet_activity_recent'));assert.ok(indexes.includes('wallet_activity_kind'));
    assert.ok(indexes.includes('wallet_activity_low_value_recent'));
    db.prepare=(sql:string)=>{if(sql.includes('INDEXED BY wallet_activity_low_value_recent'))plan=prepare(`EXPLAIN QUERY PLAN ${sql}`).all(10)
      .map((row:any)=>String(row.detail)).join('\n');return prepare(sql);};
    try{store.maintain(10);}finally{db.prepare=prepare;}
    assert.match(plan,/SCAN wallet_activity USING INDEX wallet_activity_low_value_recent/);
    assert.doesNotMatch(plan,/USE TEMP B-TREE/);
  } finally {store.close();}
});

test('automatic TTL retention does not run a synchronous checkpoint on the ingestion path',()=>{
  let now=base;const store=new WalletActivityStore(':memory:',1024*1024,{now:()=>now,lowValueTtlMs:1000,
    lowValueMaxRows:10,maintenanceBatchSize:10,maintenanceIntervalMs:1000});
  try {
    assert.equal(store.record(activity(1,'unknown',now)),true);now+=2000;
    const db=(store as any).db,exec=db.exec.bind(db),prepare=db.prepare.bind(db),statements:string[]=[];
    db.exec=(sql:string)=>{statements.push(sql);return exec(sql);};db.prepare=(sql:string)=>{statements.push(sql);return prepare(sql);};
    try{assert.equal(store.record(activity(2,'buy',now)),true);}finally{db.exec=exec;db.prepare=prepare;}
    assert.equal(store.status().retention.lowValueRows,0);
    assert.equal(statements.some(sql=>/wal_checkpoint/i.test(sql)),false);
    assert.equal(Number(db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint),1000);
  } finally {store.close();}
});

test('startup clears a stale capacity marker after retained pages fit below the reserve',()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-activity-capacity-')),path=join(directory,'activity.sqlite');
  let store=new WalletActivityStore(path,256*1024);
  try {
    assert.equal(store.record(activity(1,'buy')),true);store.close();
    const db=new DatabaseSync(path);db.prepare("INSERT INTO wallet_activity_meta VALUES ('error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run('WALLET_ACTIVITY_CAPACITY_REACHED');db.close();
    store=new WalletActivityStore(path,256*1024);
    assert.equal(store.status().error,undefined);
  } finally {try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});}
});

test('capacity recovery counts a reclaimed low-value row upgrade exactly once',()=>{
  const store=new WalletActivityStore(':memory:',1024*1024,{lowValueTtlMs:60_000,lowValueMaxRows:10,
    maintenanceBatchSize:1,maintenanceIntervalMs:60_000});
  try {
    assert.equal(store.record(activity(1,'unknown',base)),true);
    assert.equal(store.record(activity(2,'unknown',base+1)),true);
    const db=(store as any).db,prepare=db.prepare.bind(db);let full=true;
    db.prepare=(sql:string)=>{
      const statement=prepare(sql);
      if(full&&sql.startsWith('INSERT INTO wallet_activity VALUES'))return {run:(...args:unknown[])=>{
        full=false;throw new Error('SQLITE_FULL: database or disk is full');}};
      return statement;
    };
    try{assert.equal(store.record(activity(1,'buy',base+2)),true);}finally{db.prepare=prepare;}

    const status=store.status();
    assert.equal(status.counts.buy,1);assert.equal(status.counts.unknown,1);
    assert.equal(status.retention.lowValueRows,1);assert.equal(status.retention.maintenanceDeleted,1);
    assert.deepEqual(prepare('SELECT tx_hash,kind FROM wallet_activity ORDER BY tx_hash').all()
      .map((row:{tx_hash:unknown;kind:unknown})=>({tx_hash:String(row.tx_hash),kind:String(row.kind)})),[
      {tx_hash:hash(1),kind:'buy'},{tx_hash:hash(2),kind:'unknown'}]);
  } finally {store.close();}
});

test('noise at a small database ceiling cannot block new buy, sell, received-purchase or retraction evidence',()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-activity-store-')),path=join(directory,'activity.sqlite');let now=base;
  const options={now:()=>now,lowValueTtlMs:1000,lowValueMaxRows:1000,maintenanceBatchSize:100,maintenanceIntervalMs:60_000};
  let store=new WalletActivityStore(path,256*1024,options);
  try {
    for(let id=1;id<=160;id++)assert.equal(store.record(activity(id,id%3===0?'no_change':id%2===0?'transfer':'unknown',now,true)),true);
    const noisy=store.status(),shed=Object.values(noisy.retention.shed).reduce((sum,value)=>sum+(value??0),0);
    assert.ok(noisy.retention.maintenanceDeleted+shed>0,'the diagnostic sample should shed or recycle rows at its byte ceiling');
    assert.ok(noisy.storage.usedBytes<=noisy.maxBytes);

    for(const [id,kind] of [[1001,'buy'],[1002,'sell'],[1003,'received_purchase'],[1004,'retracted']] as const)
      assert.equal(store.record(activity(id,kind,now)),true,`${kind} must use capacity reserved from diagnostic noise`);
    let status=store.status();
    assert.equal(status.error,undefined);assert.equal(status.counts.buy,1);assert.equal(status.counts.sell,1);
    assert.equal(status.counts.received_purchase,1);assert.equal(status.counts.retracted,1);
    assert.ok(status.storage.usedBytes<=status.maxBytes);
    assert.equal(status.bytes,status.physicalBytes);
    assert.equal(status.storage.physicalBytes,status.physicalBytes);
    assert.ok(status.storage.walBytes>=0);

    const db=(store as any).db,exec=db.exec.bind(db),statements:string[]=[];
    db.exec=(sql:string)=>{statements.push(sql);return exec(sql);};
    now+=2000;const cleaned=store.maintain(10_000);db.exec=exec;status=store.status();
    assert.ok(cleaned.deleted>0);assert.equal(status.retention.lowValueRows,0);
    assert.ok(statements.some(sql=>/wal_checkpoint\s*\(\s*truncate\s*\)/i.test(sql)));
    assert.equal(statements.some(sql=>/\bvacuum\b/i.test(sql)),false,'online maintenance must never rewrite the database');
    assert.ok(status.storage.allocatedBytes>=status.storage.usedBytes,'DELETE leaves reusable pages instead of requiring VACUUM');
    assert.equal(store.record(activity(1005,'buy',now)),true);
    store.close();

    store=new WalletActivityStore(path,256*1024,options);status=store.status();
    assert.equal(status.counts.buy,2);assert.equal(status.counts.sell,1);
    assert.equal(status.counts.received_purchase,1);assert.equal(status.counts.retracted,1);
    assert.equal(status.retention.lowValueRows,0);
  } finally {try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});}
});
