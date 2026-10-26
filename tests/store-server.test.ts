import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Store,PROCESSING_LEASE_MS} from '../src/store.js';
import {OrderStore} from '../src/orders.js';
import {buildServer} from '../src/server.js';
import {GmgnScanner} from '../src/scanner.js';
import {evaluate} from '../src/engine.js';
import {signal,config,providers,now} from './helpers.js';

test('health and exit views report live counting separately from disabled research entry without implying proved protection',async()=>{
  const c=config(),store=new Store(':memory:'),orders=new OrderStore(':memory:');
  c.entryMode='off';c.thirdSignalExecutionMode='live';let countingRunning=false;
  const server=buildServer(c,store,providers(),{orders,executionStatus:()=>({configuredEntryMode:c.entryMode,
    configuredThirdSignalMode:c.thirdSignalExecutionMode,executionEnabled:countingRunning,countingRunning,executionReady:true})});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,headers={authorization:`Bearer ${c.ingestToken}`};
  try {
    assert.equal((await fetch(base+'/v1/exits')).status,401);
    for(const running of [false,true,false]){
      countingRunning=running;
      for(const route of ['/health','/v1/exits']){
        const value=await(await fetch(base+route,{headers})).json();
        assert.equal(value.configuredEntryMode,'off');assert.equal(value.configuredThirdSignalMode,'live');
        assert.equal(value.executionEnabled,running);assert.equal(value.countingRunning,running);
        assert.equal(value.executionReady,true);assert.equal(value.executionStatusAvailable,true);
        assert.equal(value.unattendedProtectionReady,false);
        if(route==='/v1/exits'){assert.equal(value.execution,running?'live':'off');assert.deepEqual(value.orders,[]);}
      }
    }
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));orders.close();store.close();}
});

test('health without runtime status does not infer active execution from live configuration',async()=>{
  const c=config(),store=new Store(':memory:');c.entryMode='live';c.thirdSignalExecutionMode='live';
  const server=buildServer(c,store,providers());server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const value=await(await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/health`)).json();
    assert.equal(value.configuredEntryMode,'live');assert.equal(value.configuredThirdSignalMode,'live');
    assert.equal(value.executionEnabled,false);assert.equal(value.executionStatusAvailable,false);
    assert.equal(value.executionReady,false);assert.equal(value.unattendedProtectionReady,false);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});

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

test('SOL-only API rejects paused-chain imports and retries without changing retained historical reports',async()=>{
  const c=config(),store=new Store(':memory:');c.scannerChains=['solana'];
  const prior=store.reserve(signal()).entry;
  store.finish(prior.id,await evaluate(prior.signal,config(),providers(),{now:()=>now,id:prior.id}),prior.claimId!);
  const before=store.get(prior.id),p=providers();let calls=0;
  p.safety=async()=>{calls++;throw Error('disabled chain must not query');};
  const server=buildServer(c,store,p);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,
    headers={authorization:`Bearer ${c.ingestToken}`,'content-type':'application/json'};
  try {
    for(const chain of ['bsc','robinhood'] as const) {
      const s=signal({sourceEventId:'new-'+chain,token:{chain,address:signal().token.address},occurredAt:new Date().toISOString()});
      for(const [path,body] of [['/v1/signals',s],['/v1/notifications',{source:s.source,chain,occurredAt:s.occurredAt,address:s.token.address,text:'CA '+s.token.address}]] as const) {
        const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
        assert.equal(response.status,409);assert.equal((await response.json()).error,'SIGNAL_CHAIN_DISABLED');
      }
    }
    const retry=await fetch(base+`/v1/signals/${prior.id}/retry`,{method:'POST',headers});
    assert.equal(retry.status,409);assert.equal((await retry.json()).error,'SIGNAL_CHAIN_DISABLED');
    assert.deepEqual(store.get(prior.id),before);assert.equal(store.list().length,1);assert.equal(calls,0);
    assert.equal((await fetch(base+`/v1/signals/${prior.id}`,{headers})).status,200);
    const sol=signal({sourceEventId:'allowed-sol',token:{chain:'solana',address:'So11111111111111111111111111111111111111112'},
      occurredAt:new Date().toISOString()});
    const accepted=await fetch(base+'/v1/signals',{method:'POST',headers,body:JSON.stringify(sol)});
    assert.equal(accepted.status,201);assert.equal(calls,1);assert.equal(store.list().length,2);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});

test('focused GMGN mode blocks authenticated manual market scans without issuing requests',async()=>{
  for(const enabled of [false,true]){
    const c=config();c.gmgnBackgroundResearchEnabled=enabled;
    const store=new Store(':memory:');let requests=0;
    const scanner=new GmgnScanner({client:{get:async()=>{requests++;return {list:[]};}},chains:['bsc'],
      intervalMs:60000,maxAgeSec:600,onSignal:()=>{throw Error('UNEXPECTED_SIGNAL');}});
    const server=buildServer(c,store,providers(),{scanner});server.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,headers={authorization:`Bearer ${c.ingestToken}`};
    try{
      assert.equal((await fetch(base+'/v1/scanner/run',{method:'POST'})).status,401);
      assert.equal(requests,0);
      const response=await fetch(base+'/v1/scanner/run',{method:'POST',headers}),body=await response.json();
      const status=await(await fetch(base+'/v1/scanner',{headers})).json();
      if(!enabled){
        assert.equal(response.status,409);assert.equal(body.error,'GMGN_BACKGROUND_RESEARCH_DISABLED');
        assert.equal(status.enabled,false);assert.equal(status.pausedReason,'GMGN_BACKGROUND_RESEARCH_DISABLED');
        assert.equal(requests,0);
      }else{
        assert.equal(response.status,200);assert.equal(body.status,'ok');assert.equal(requests,2);
        assert.equal(status.pausedReason,undefined);
      }
    }finally{scanner.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
  }
});
