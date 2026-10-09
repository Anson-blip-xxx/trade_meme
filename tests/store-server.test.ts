import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Store,PROCESSING_LEASE_MS} from '../src/store.js';
import {buildServer} from '../src/server.js';
import {evaluate} from '../src/engine.js';
import {signal,config,providers,now} from './helpers.js';

test('同源事件去重，原事件ID修改内容时报冲突',()=>{
  const store=new Store(':memory:');try {
    assert.equal(store.reserve(signal()).created,true);
    assert.equal(store.reserve(signal()).created,false);
    assert.equal(store.reserve(signal({text:'edited'})).conflict,true);
    assert.equal(store.reserve(signal({source:'gmgn'})).created,true);
  } finally {store.close();}
});
test('重启恢复中断状态；重评保留原报告',async()=>{
  const store=new Store(':memory:');try {
    const e=store.reserve(signal()).entry;store.recover(new Date(e.leaseExpiresAt!));
    assert.equal(store.get(e.id)?.status,'interrupted');
    const first=store.retry(e.id)!;assert.ok(first.claimId);
    assert.equal(store.finish(e.id,await evaluate(signal(),config(),providers(),{now:()=>now,id:e.id}),first.claimId!),true);
    const second=store.retry(e.id)!;assert.ok(second.claimId);assert.equal(store.get(e.id)?.report,undefined);
    assert.equal(store.finish(e.id,await evaluate(signal(),config(),providers(),{now:()=>now,id:e.id}),second.claimId!),true);
    assert.equal(store.history(e.id).length,2);
  } finally {store.close();}
});

test('信号和通知原文原子保存，重复原文幂等，冲突不写原文或延长租约',()=>{
  const store=new Store(':memory:');try {
    const raw={source:'debot',text:'原始通知',occurredAt:'2026-10-08T20:00:00+08:00'};
    const first=store.reserve(signal(),raw);
    assert.ok(first.entry.claimId);assert.ok(first.entry.leaseExpiresAt);
    assert.equal(Date.parse(first.entry.leaseExpiresAt!)-Date.parse(first.entry.receivedAt),PROCESSING_LEASE_MS);
    assert.equal(store.imports(first.entry.id).length,1);
    assert.deepEqual(store.imports(first.entry.id)[0].payload,raw);
    assert.equal(store.imports(first.entry.id)[0].verification,'user_supplied');
    const duplicate=store.reserve(signal(),raw);
    assert.equal(duplicate.created,false);assert.deepEqual(duplicate.entry,first.entry);
    assert.equal(store.imports(first.entry.id).length,1);
    store.reserve(signal(),{...raw,occurredAt:'2026-10-08T12:00:00Z'});
    assert.equal(store.imports(first.entry.id).length,2);
    assert.equal(store.reserve(signal({text:'conflicting edit'}),{text:'must not be saved'}).conflict,true);
    assert.equal(store.imports(first.entry.id).length,2);assert.deepEqual(store.get(first.entry.id),first.entry);
  } finally {store.close();}
});

test('通知原文写入异常会回滚新信号和已写原文，不遗留processing',()=>{
  const store=new Store(':memory:');try {
    const original=store.recordImport.bind(store);let attemptedId='';
    store.recordImport=(id,payload,channel)=>{attemptedId=id;original(id,payload,channel);throw new Error('SIMULATED_STORAGE_FAILURE');};
    assert.throws(()=>store.reserve(signal(),{text:'raw'}),/SIMULATED_STORAGE_FAILURE/);
    assert.equal(store.list().length,0);assert.equal(store.imports(attemptedId).length,0);
    store.recordImport=original;
    assert.equal(store.reserve(signal(),{text:'raw'}).created,true);
  } finally {store.close();}
});

test('重复投递的原文写入异常只回滚本次导入，不改变已有信号和原文',()=>{
  const store=new Store(':memory:');try {
    const first=store.reserve(signal(),{text:'original'}).entry;
    const original=store.recordImport.bind(store);
    store.recordImport=(id,payload,channel)=>{original(id,payload,channel);throw new Error('SIMULATED_STORAGE_FAILURE');};
    assert.throws(()=>store.reserve(signal(),{text:'second representation'}),/SIMULATED_STORAGE_FAILURE/);
    assert.deepEqual(store.get(first.id),first);assert.equal(store.imports(first.id).length,1);
    assert.deepEqual(store.imports(first.id)[0].payload,{text:'original'});
  } finally {store.close();}
});

test('恢复不会抢占活跃任务，只有租约过期后才回收',()=>{
  const store=new Store(':memory:');try {
    const entry=store.reserve(signal()).entry;
    const beforeExpiry=new Date(Date.parse(entry.leaseExpiresAt!)-1);
    store.recover(beforeExpiry);assert.deepEqual(store.get(entry.id),entry);
    assert.equal(store.retry(entry.id,beforeExpiry),undefined);
    store.recover(new Date(entry.leaseExpiresAt!));
    assert.equal(store.get(entry.id)?.status,'interrupted');assert.equal(store.get(entry.id)?.claimId,undefined);
    assert.equal(store.interrupt(entry.id,entry.claimId!),false);
    const retried=store.retry(entry.id,new Date(entry.leaseExpiresAt!))!;
    assert.equal(retried.status,'processing');assert.notEqual(retried.claimId,entry.claimId);
  } finally {store.close();}
});

test('过期processing可直接重试，旧任务不能覆盖或中断新任务，完成记录只写一次',async()=>{
  const store=new Store(':memory:');try {
    const entry=store.reserve(signal()).entry;
    const retried=store.retry(entry.id,new Date(entry.leaseExpiresAt!))!;
    assert.ok(retried.claimId);assert.notEqual(retried.claimId,entry.claimId);
    assert.equal(Date.parse(retried.leaseExpiresAt!)-Date.parse(entry.leaseExpiresAt!),PROCESSING_LEASE_MS);
    const report=await evaluate(signal(),config(),providers(),{now:()=>now,id:entry.id});
    assert.equal(store.finish(entry.id,report,entry.claimId!),false);
    assert.equal(store.interrupt(entry.id,entry.claimId!),false);
    assert.deepEqual(store.get(entry.id),retried);assert.equal(store.history(entry.id).length,0);
    assert.equal(store.finish(entry.id,report,retried.claimId!),true);
    assert.equal(store.finish(entry.id,report,retried.claimId!),false);
    assert.equal(store.interrupt(entry.id,retried.claimId!),false);
    assert.equal(store.history(entry.id).length,1);assert.equal(store.get(entry.id)?.status,'completed');
    assert.equal(store.get(entry.id)?.claimId,undefined);
    const newer=store.retry(entry.id)!;
    assert.equal(store.finish(entry.id,report,retried.claimId!),false);
    assert.equal(store.interrupt(entry.id,retried.claimId!),false);
    assert.equal(store.interrupt(entry.id,newer.claimId!),true);
    assert.equal(store.get(entry.id)?.status,'interrupted');assert.equal(store.history(entry.id).length,1);
  } finally {store.close();}
});

test('旧数据库迁移后可回收无租约processing，已完成记录不受影响',()=>{
  const directory=mkdtempSync(join(tmpdir(),'meme-store-migration-')),path=join(directory,'signals.sqlite');
  const legacy=new DatabaseSync(path);
  legacy.exec(`CREATE TABLE signals (id TEXT PRIMARY KEY,source TEXT NOT NULL,event_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,signal TEXT NOT NULL,received_at TEXT NOT NULL,status TEXT NOT NULL,report TEXT,
    UNIQUE(source,event_id));`);
  for(const [id,status] of [['legacy-processing','processing'],['legacy-completed','completed']]) {
    legacy.prepare('INSERT INTO signals VALUES (?,?,?,?,?,?,?,NULL)')
      .run(id,'debot',id,'legacy-hash',JSON.stringify(signal({sourceEventId:id})),now.toISOString(),status);
  }
  legacy.close();
  let store:Store|undefined;
  try {
    store=new Store(path);assert.equal(store.get('legacy-processing')?.claimId,undefined);
    store.recover(now);
    assert.equal(store.get('legacy-processing')?.status,'interrupted');
    assert.equal(store.get('legacy-completed')?.status,'completed');
    const entry=store.retry('legacy-processing',now)!;assert.ok(entry.claimId);
    assert.equal(entry.leaseExpiresAt,new Date(now.getTime()+PROCESSING_LEASE_MS).toISOString());
    store.close();store=new Store(path);store.recover(new Date(now.getTime()+1));
    assert.deepEqual(store.get('legacy-processing'),entry);
  } finally {store?.close();rmSync(directory,{recursive:true,force:true});}
});
test('HTTP认证、真实请求验证、重复投递和冲突',async()=>{
  const c=config(),store=new Store(':memory:'),server=buildServer(c,store,providers());
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const headers={authorization:`Bearer ${c.ingestToken}`,'content-type':'application/json'};
  try {
    assert.equal((await fetch(base+'/v1/signals')).status,401);
    const s=signal({occurredAt:new Date().toISOString()});
    const send=(data:unknown)=>fetch(base+'/v1/signals',{method:'POST',headers,body:JSON.stringify(data)});
    const first=await send(s);assert.equal(first.status,201);
    const value=await first.json();assert.equal(value.report.executionEnabled,false);
    const duplicate=await send(s);assert.equal((await duplicate.json()).duplicate,true);
    assert.equal((await send({...s,text:'changed'})).status,409);
    assert.equal((await send({...s,safety:{status:'pass'}})).status,400);
    assert.equal((await fetch(base+'/v1/orders',{method:'POST',headers})).status,404);
  } finally {server.close();await once(server,'close');store.close();}
});
