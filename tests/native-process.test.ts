import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,type ChildProcess} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {readConfig} from '../src/config.js';
import {OrderStore} from '../src/orders.js';
import {ProcessNativeTradingRuntime,type NativeProcessOptions} from '../src/native-solana/process-host.js';
import {NativeProcessStore} from '../src/native-solana/process-store.js';
import {runNativeProcessWorker,type NativeWorkerRuntime} from '../src/native-solana/process-worker-core.js';
import type {NativeParentMessage,NativeWorkerMessage} from '../src/native-solana/process-protocol.js';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition:()=>boolean,timeout=6000){const end=Date.now()+timeout;while(!condition()){if(Date.now()>end)throw Error('TEST_TIMEOUT');await pause(20);}}
function fixture(t:TestContext,options:NativeProcessOptions={},enqueue:(event:{key:string;text:string})=>boolean=()=>true,
  controls:{failSpawns?:number;submitDelayMs?:number;writeProbe?:boolean}={}){
  const dir=mkdtempSync(join(tmpdir(),'native-process-'));
  const config=readConfig({ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),ENTRY_WALLET_SOLANA:'11111111111111111111111111111111',
    SOLANA_EXECUTION_PROVIDER:'pump_native',SOLANA_NATIVE_RPC_URL:'https://never-called.invalid',SOLANA_NATIVE_WS_URL:'wss://never-called.invalid',
    SOLANA_NATIVE_KEYPAIR_FILE:join(dir,'does-not-exist'),SOLANA_NATIVE_JOURNAL_PATH:join(dir,'journal.sqlite'),SOLANA_NATIVE_POSITIONS_PATH:join(dir,'positions.sqlite')});
  const orders=new OrderStore(config.ordersDatabase),children:ChildProcess[]=[];let spawnAttempts=0;
  const spawnWorker=(lockPath:string)=>{
    if(spawnAttempts++<(controls.failSpawns??0))throw Error('TEST_INITIAL_SPAWN_FAILURE');
    const source=fileURLToPath(new URL('./fixtures/native-process-child.ts',import.meta.url));
    const worker=import.meta.url.endsWith('.ts')?['--import','tsx',source]:[source.replace(/\.ts$/,'.js')];
    const child=spawn('/usr/bin/flock',['--nonblock','--no-fork',lockPath,process.execPath,...worker],
      {stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,NATIVE_PROCESS_TEST_ONLY:'1',
        NATIVE_PROCESS_FAKE_SUBMIT_DELAY_MS:String(controls.submitDelayMs??0),NATIVE_PROCESS_FAKE_WRITE_PROBE:controls.writeProbe?'1':'0'},serialization:'advanced'});
    children.push(child);return child;
  };
  const host=new ProcessNativeTradingRuntime(config,orders,enqueue,{guardTimeoutMs:100,requestTimeoutMs:5000,restartDelayMs:50,...options,spawnWorker});
  const reserve=()=>orders.reserve({eventKey:'fixture-'+Math.random(),chain:'solana',tokenAddress:'So11111111111111111111111111111111111111112',
    mode:'live',wallet:'11111111111111111111111111111111',inputToken:'So11111111111111111111111111111111111111112',inputAmount:'10000',slippagePct:5,
    details:{executionProvider:'pump_native'}},3).order!;
  t.after(async()=>{for(const child of children)child.kill('SIGCONT');await host.stop();orders.close();rmSync(dir,{recursive:true,force:true});});
  return {host,dir,config,orders,children,spawnWorker,reserve};
}

test('separate process keeps ticking while parent is synchronously blocked for 2 seconds',async t=>{
  const f=fixture(t);f.host.start();await until(()=>f.host.readiness().ready);await until(()=>existsSync(join(f.dir,'ticks')));
  const start=Date.now();while(Date.now()-start<2000){/* deliberate parent event-loop stall */}
  const ticks=readFileSync(join(f.dir,'ticks'),'utf8').trim().split('\n').map(Number).filter(n=>n>=start&&n<=Date.now());
  assert.ok(ticks.length>=60,`child ticks during parent stall: ${ticks.length}`);
  const gaps=ticks.slice(1).map((n,i)=>n-ticks[i]);assert.ok(Math.max(...gaps)<250,`largest child tick gap: ${Math.max(...gaps)}ms`);
  assert.equal(f.host.readiness().reason,'NATIVE_WORKER_SNAPSHOT_STALE');await until(()=>f.host.readiness().ready);
});

test('parent holding the shared orders write lock for 2 seconds cannot stall child monitoring',async t=>{
  const f=fixture(t,{},()=>true,{writeProbe:true});f.reserve();f.host.start();await until(()=>f.host.readiness().ready);
  await until(()=>existsSync(join(f.dir,'ticks')));const locker=new DatabaseSync(f.config.ordersDatabase);
  let start=0;try{
    locker.exec('PRAGMA busy_timeout=5000;BEGIN IMMEDIATE');start=Date.now();
    while(Date.now()-start<2000){/* parent holds both its event loop and the actual shared SQLite writer lock */}
  }finally{locker.exec('ROLLBACK');locker.close();}
  const ticks=readFileSync(join(f.dir,'ticks'),'utf8').trim().split('\n').map(Number).filter(n=>n>=start&&n<=start+2000);
  assert.ok(ticks.length>=50,`child monitoring ticks while shared writer locked: ${ticks.length}`);
  assert.ok(Math.max(...ticks.slice(1).map((n,i)=>n-ticks[i]))<250);
  const waits=readFileSync(join(f.dir,'write-busy'),'utf8').trim().split('\n').map(Number).sort((a,b)=>a-b);
  assert.ok(waits.length>=40);assert.ok(waits[Math.floor(waits.length*.95)]<100,`write-lock wait p95: ${waits[Math.floor(waits.length*.95)]}ms`);
  await until(()=>f.host.readiness().ready);
});

test('stale child blocks entries without killing it; actual crash restarts under the same exclusive lock',async t=>{
  const f=fixture(t,{snapshotStaleMs:100});f.host.start();await until(()=>f.host.readiness().ready);
  const initiallyReady=f.host.status().process;
  assert.ok(initiallyReady.lastRecoveredAt);assert.ok(initiallyReady.readinessTransitions>=2);
  const child=f.children[0];child.kill('SIGSTOP');await pause(200);
  assert.equal(f.host.readiness().reason,'NATIVE_WORKER_SNAPSHOT_STALE');assert.equal(f.children.length,1);
  const stale=f.host.status().process;
  assert.equal(stale.lastFalseReason,'NATIVE_WORKER_SNAPSHOT_STALE');assert.ok(stale.lastFalseAt);
  assert.ok(stale.maxSnapshotAgeMs>=100);assert.equal(stale.lastRecoveredAt,initiallyReady.lastRecoveredAt);
  child.kill('SIGCONT');await until(()=>f.host.readiness().ready);
  const recovered=f.host.status().process;
  assert.ok(recovered.lastRecoveredAt!>stale.lastFalseAt!);assert.ok(recovered.lastFalseDurationMs!>=0);
  assert.equal(recovered.lastFalseReason,'NATIVE_WORKER_SNAPSHOT_STALE');assert.ok(recovered.readinessTransitions>stale.readinessTransitions);
  child.kill('SIGKILL');
  await until(()=>f.children.length>=2);await until(()=>f.host.readiness().ready);assert.notEqual(f.host.status().process.pid,child.pid);
});

test('a brief stale worker snapshot does not hide sell controls for an already active holding',async t=>{
  const f=fixture(t,{snapshotStaleMs:100});f.host.start();await until(()=>f.host.readiness().ready);
  const order=f.reserve();await f.host.execute(order,async()=>{});await until(()=>!!f.host.get(order.id));
  const child=f.children[0];child.kill('SIGSTOP');await pause(200);
  assert.equal(f.host.readiness().reason,'NATIVE_WORKER_SNAPSHOT_STALE');
  const ref=f.host.createAction(order.id);
  assert.match(ref,/^np[0-9a-f]{30}$/);assert.equal(f.host.ownsAction(ref),true);
  // Rendering an inert capability must not dispatch a sell to the paused child.
  assert.equal(existsSync(join(f.dir,'actions')),false);
});

test('late guard completion never reaches the fake executor; normal guard does exactly once',async t=>{
  const f=fixture(t);f.host.start();await until(()=>f.host.readiness().ready);const order=f.reserve();
  await assert.rejects(f.host.execute(order,async()=>{await pause(250);}),/NATIVE_GUARD_TIMEOUT/);
  await pause(300);assert.equal(existsSync(join(f.dir,'executions')),false);
  await f.host.execute(order,async()=>{});
  assert.equal(readFileSync(join(f.dir,'executions'),'utf8').trim().split('\n').length,1);
  await until(()=>!!f.host.get(order.id));const ref=f.host.createAction(order.id);assert.equal(f.host.ownsAction(ref),true);
  assert.match((await f.host.submit(ref,30)).text,/accepted:/);assert.match((await f.host.submit(ref,30)).text,/accepted:/);
  assert.equal(readFileSync(join(f.dir,'actions'),'utf8').trim().split('\n').length,1,'public ref maps durably to only one native ref');
});

test('notification stays durably queued when parent rejects delivery, then replays after worker restart',async t=>{
  let accept=false,received=0;const f=fixture(t,{},()=>{if(!accept)throw Error('TG_TEMPORARILY_DOWN');received++;return false;});
  f.host.start();await until(()=>f.host.readiness().ready);await pause(100);
  const store=new NativeProcessStore(f.config.nativeSolana!.positionsPath+'.process.sqlite');t.after(()=>store.close());
  assert.equal(store.notices().length,1);f.children[0].kill('SIGKILL');accept=true;
  await until(()=>received>0);await until(()=>store.notices().length===0);
});

test('kernel lock rejects a duplicate worker while the first worker keeps running',async t=>{
  const f=fixture(t);f.host.start();await until(()=>f.host.readiness().ready);
  const duplicate=f.spawnWorker(f.config.nativeSolana!.positionsPath+'.process.sqlite.lock');
  const code=await new Promise<number|null>(resolve=>duplicate.once('exit',resolve));assert.equal(code,1);
  assert.equal(f.host.readiness().ready,true);
});

test('synchronous worker spawn failure retries instead of leaving protection stopped indefinitely',async t=>{
  const f=fixture(t,{},()=>true,{failSpawns:1});f.host.start();
  assert.equal(f.host.readiness().reason,'NATIVE_WORKER_START_FAILED');await until(()=>f.host.readiness().ready);
  assert.equal(f.children.length,1);
});

test('manual sell IPC timeout reports unknown outcome and preserves the original durable action',async t=>{
  const f=fixture(t,{requestTimeoutMs:100},()=>true,{submitDelayMs:250});f.host.start();await until(()=>f.host.readiness().ready);
  const order=f.reserve();await f.host.execute(order,async()=>{});await until(()=>!!f.host.get(order.id));
  const ref=f.host.createAction(order.id),reply=await f.host.submit(ref,25);
  assert.match(reply.text,/状态待确认/);assert.doesNotMatch(reply.text,/卖出失败/);assert.equal(f.host.ownsAction(ref),true);
  await pause(300);assert.equal(readFileSync(join(f.dir,'actions'),'utf8').trim().split('\n').length,1);
});

test('parent IPC request backlog is bounded and rejects overflow before it reaches the worker',async t=>{
  const f=fixture(t,{maxPendingRequests:1},()=>true,{submitDelayMs:250});f.host.start();await until(()=>f.host.readiness().ready);
  const order=f.reserve();await f.host.execute(order,async()=>{});await until(()=>!!f.host.get(order.id));
  const ref=f.host.createAction(order.id),first=f.host.submit(ref,25);
  const overflow=await f.host.submit(ref,50);assert.match(overflow.text,/请求繁忙/);assert.match(overflow.text,/未提交/);
  assert.match((await first).text,/accepted:/);
  assert.equal(readFileSync(join(f.dir,'actions'),'utf8').trim().split('\n').length,1,'overflow never reaches the child');
});

test('manual action mapping survives worker restart and retries keep the same native action',async t=>{
  const f=fixture(t);f.host.start();await until(()=>f.host.readiness().ready);
  const order=f.reserve();await f.host.execute(order,async()=>{});await until(()=>!!f.host.get(order.id));
  const ref=f.host.createAction(order.id),reply=await f.host.submit(ref,50);assert.match(reply.text,/accepted:/);
  f.children[0].kill('SIGKILL');await until(()=>f.children.length>=2);await until(()=>f.host.readiness().ready);
  assert.equal((await f.host.submit(ref,50)).text,reply.text);
  assert.equal(readFileSync(join(f.dir,'actions'),'utf8').trim().split('\n').length,1);
});

test('an old order acknowledgement cannot delete a newer durable order update',t=>{
  const dir=mkdtempSync(join(tmpdir(),'native-store-')),path=join(dir,'bridge.sqlite');
  const store=new NativeProcessStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.changed('order-1');const old=store.changedOrders()[0];store.changed('order-1');const newer=store.changedOrders()[0];
  assert.notEqual(old.version,newer.version);store.ackOrder(old.orderId,old.version);
  assert.deepEqual(store.changedOrders(),[newer]);store.ackOrder(newer.orderId,newer.version);assert.deepEqual(store.changedOrders(),[]);
});

test('process notice replay scans only its partial pending index',t=>{
  const dir=mkdtempSync(join(tmpdir(),'native-process-index-')),path=join(dir,'bridge.sqlite');
  const store=new NativeProcessStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const db=new DatabaseSync(path,{readOnly:true});
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT key,text FROM process_notices WHERE delivered=0 ORDER BY rowid LIMIT 20').all();db.close();
  assert.match(plan.map(row=>String(row.detail)).join('\n'),/process_notices_pending/);
});

test('native sell capabilities are reused until consumed and expired cleanup is bounded',t=>{
  const dir=mkdtempSync(join(tmpdir(),'native-process-actions-')),path=join(dir,'bridge.sqlite');
  const store=new NativeProcessStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const first=store.createAction('order-1',0);
  assert.equal(store.createAction('order-1',1),first,'refresh reuses the unconsumed capability');
  store.mapAction(first,'worker-action');
  assert.notEqual(store.createAction('order-1',2),first,'a consumed capability is never reused for a new sell');
  for(let i=0;i<140;i++)store.createAction(`expired-${i}`,0);
  store.createAction('fresh',86_400_001);
  const db=new DatabaseSync(path,{readOnly:true});
  const plan=db.prepare(`EXPLAIN QUERY PLAN DELETE FROM process_actions WHERE rowid IN
    (SELECT rowid FROM process_actions WHERE expires<=? LIMIT 128)`).all(86_400_001);
  assert.match(plan.map(row=>String(row.detail)).join('\n'),/process_actions_expired/);
  const remaining=Number((db.prepare('SELECT count(*) AS n FROM process_actions WHERE expires<=?').get(86_400_001) as {n:number}).n);
  db.close();assert.equal(remaining,13,'one call deletes at most 128 expired rows');
});

test('duplicate execute IPC while a guard is pending invokes only one runtime execution',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'native-worker-duplicate-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let incoming!:(message:unknown)=>void;const sent:NativeWorkerMessage[]=[];let invoked=0,executed=0;
  const order={id:'test-order',details:{executionProvider:'pump_native'}} as any;
  const runtime={start(){},async stop(){},readiness:()=>({ready:true}),status:()=>({readiness:{ready:true}}),get:()=>undefined,
    async execute(o:any,guard:()=>Promise<void>){invoked++;await guard();executed++;return o;}} as unknown as NativeWorkerRuntime;
  const worker=runNativeProcessWorker({onMessage:l=>incoming=l,onDisconnect:()=>{},send:m=>{sent.push(m);return true;},exit:()=>{}},()=>({runtime,
    orders:{get:()=>order,activePositions:()=>[],subscribe:()=>()=>{},close:()=>{}}}));
  t.after(()=>worker.stop());incoming({kind:'init',storePath:join(dir,'bridge.sqlite'),guardTimeoutMs:1000,config:{}});
  const call={kind:'call',id:'duplicate-1',method:'execute',orderId:order.id};incoming(call);incoming(call);
  const guard=sent.find(m=>m.kind==='guard') as Extract<NativeWorkerMessage,{kind:'guard'}>;
  assert.equal(invoked,1);incoming({kind:'guard_result',id:guard.id,ok:true});
  await until(()=>sent.filter(m=>m.kind==='result').length===2);assert.equal(executed,1);
});

test('repeated identical initialization neither starts a second runtime nor stops the first',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'native-worker-init-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let incoming!:(message:unknown)=>void;let created=0,started=0,stopped=0;
  const runtime={start(){started++;},async stop(){stopped++;},readiness:()=>({ready:true}),status:()=>({readiness:{ready:true}}),get:()=>undefined} as unknown as NativeWorkerRuntime;
  const worker=runNativeProcessWorker({onMessage:l=>incoming=l,onDisconnect:()=>{},send:()=>true,exit:()=>{}},()=>{
    created++;return {runtime,orders:{get:()=>undefined,activePositions:()=>[],subscribe:()=>()=>{},close:()=>{}}};
  });
  t.after(()=>worker.stop());const init={kind:'init',storePath:join(dir,'bridge.sqlite'),guardTimeoutMs:1000,config:{}};
  incoming(init);incoming(structuredClone(init));assert.equal(created,1);assert.equal(started,1);assert.equal(stopped,0);
});

test('outbox failure remains entry-blocking across snapshots and recovers only after the durable store works',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'native-worker-spool-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let incoming!:(message:unknown)=>void;const sent:NativeWorkerMessage[]=[];let unavailable=true;
  const original=NativeProcessStore.prototype.notices;
  t.mock.method(NativeProcessStore.prototype,'notices',function(this:NativeProcessStore,limit?:number){
    if(unavailable)throw Error('TEST_DATABASE_BUSY');return original.call(this,limit);
  });
  const runtime={start(){},async stop(){},readiness:()=>({ready:true}),status:()=>({readiness:{ready:true}}),get:()=>undefined} as unknown as NativeWorkerRuntime;
  const worker=runNativeProcessWorker({onMessage:l=>incoming=l,onDisconnect:()=>{},send:m=>{sent.push(m);return true;},exit:()=>{}},()=>({runtime,
    orders:{get:()=>undefined,activePositions:()=>[],subscribe:()=>()=>{},close:()=>{}}}));
  t.after(()=>worker.stop());incoming({kind:'init',storePath:join(dir,'bridge.sqlite'),guardTimeoutMs:1000,config:{}});
  const first=sent.find(m=>m.kind==='snapshot') as Extract<NativeWorkerMessage,{kind:'snapshot'}>;
  incoming({kind:'snapshot_ack',sequence:first.value.sequence});worker.snapshot();
  const blocked=sent.filter(m=>m.kind==='snapshot').at(-1) as Extract<NativeWorkerMessage,{kind:'snapshot'}>;
  assert.equal(blocked.value.status.readiness.reason,'NATIVE_WORKER_OUTBOX_UNAVAILABLE');
  unavailable=false;worker.pump();incoming({kind:'snapshot_ack',sequence:blocked.value.sequence});worker.snapshot();
  const recovered=sent.filter(m=>m.kind==='snapshot').at(-1) as Extract<NativeWorkerMessage,{kind:'snapshot'}>;
  assert.equal(recovered.value.status.readiness.ready,true);
});

test('temporary acknowledgement write failure never stops the independent position runtime or drops the notice',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'native-worker-ack-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let incoming!:(message:unknown)=>void;const sent:NativeWorkerMessage[]=[];let unavailable=true,stops=0,exits=0;
  const original=NativeProcessStore.prototype.ackNotice;
  t.mock.method(NativeProcessStore.prototype,'ackNotice',function(this:NativeProcessStore,key:string){
    if(unavailable)throw Error('TEST_DATABASE_BUSY');return original.call(this,key);
  });
  const runtime={start(){},async stop(){stops++;},readiness:()=>({ready:true}),status:()=>({readiness:{ready:true}}),get:()=>undefined} as unknown as NativeWorkerRuntime;
  const worker=runNativeProcessWorker({onMessage:l=>incoming=l,onDisconnect:()=>{},send:m=>{sent.push(m);return true;},exit:()=>{exits++;}},(_config,enqueue)=>{
    enqueue({key:'ack-test',text:'test'});return {runtime,orders:{get:()=>undefined,activePositions:()=>[],subscribe:()=>()=>{},close:()=>{}}};
  });
  t.after(()=>worker.stop());const path=join(dir,'bridge.sqlite');
  incoming({kind:'init',storePath:path,guardTimeoutMs:1000,config:{}});incoming({kind:'notice_ack',key:'ack-test'});
  assert.equal(stops,0);assert.equal(exits,0);
  const store=new NativeProcessStore(path);assert.equal(store.notices().length,1);
  unavailable=false;incoming({kind:'notice_ack',key:'ack-test'});worker.pump();assert.equal(store.notices().length,0);store.close();
});

test('worker guard deadline rejects delayed messages and ignores a late positive response',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'native-worker-core-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let incoming!:(message:unknown)=>void;const sent:NativeWorkerMessage[]=[];let executed=0;
  const order={id:'test-order',details:{executionProvider:'pump_native'}} as any;
  const runtime={start(){},async stop(){},readiness:()=>({ready:true}),status:()=>({readiness:{ready:true}}),get:()=>undefined,
    async execute(o:any,guard:()=>Promise<void>){await guard();executed++;return o;}} as unknown as NativeWorkerRuntime;
  const worker=runNativeProcessWorker({onMessage:l=>incoming=l,onDisconnect:()=>{},send:m=>{sent.push(m);return true;},exit:()=>{}},()=>({runtime,
    orders:{get:()=>order,activePositions:()=>[],subscribe:()=>()=>{},close:()=>{}}}));
  t.after(()=>worker.stop());
  incoming({kind:'init',storePath:join(dir,'bridge.sqlite'),guardTimeoutMs:50,config:{}} as NativeParentMessage);
  incoming({kind:'call',id:'call-1',method:'execute',orderId:order.id});await until(()=>sent.some(m=>m.kind==='guard'));
  const guard=sent.find(m=>m.kind==='guard') as Extract<NativeWorkerMessage,{kind:'guard'}>;await pause(80);
  incoming({kind:'guard_result',id:guard.id,ok:true});await pause(20);assert.equal(executed,0);
  assert.ok(sent.some(m=>m.kind==='result'&&!m.ok&&m.error==='NATIVE_GUARD_TIMEOUT'));
});
