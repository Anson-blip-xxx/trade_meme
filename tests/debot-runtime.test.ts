import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {Store,PROCESSING_LEASE_MS} from '../src/store.js';
import {unknown,type Signal} from '../src/types.js';

test('DeBot collection reaches existing research and dashboard with original receipt time, no wallet claim or order',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'debot-runtime-'));
  const config=readConfig({DEBOT_SCANNER_ENABLED:'true',DEBOT_TRANSPORT:'anonymous_poll',DEBOT_SIGNALS_DATABASE_PATH:join(directory,'debot.sqlite'),
    ORDERS_DATABASE_PATH:join(directory,'orders.sqlite'),DASHBOARD_ENABLED:'true',SCAN_DATABASE_PATH:join(directory,'scans.sqlite'),
    SCANNER_CHAINS:'bsc',GMGN_API_KEY:'test-key-no-network',ENTRY_MODE:'off'});
  const originalFetch=globalThis.fetch;
  const token='0x'+'a'.repeat(40),created=Math.floor(Date.now()/1000)-120;
  let requests=0;
  globalThis.fetch=async(input,init)=>{
    requests++;assert.equal(new URL(String(input)).pathname,'/api/community/signal/channel/list');
    assert.equal(init?.credentials,'omit');
    return Response.json({code:0,data:{results:[{id:'test-event',chain:'bsc',channel_id:2,token,create_time:created,
      wallet_stats:[{token,wallet:'',alias:'SW-anonymous',last_trade_time:created,volume:'123'}]}]}});
  };
  let runtime=createRuntime(config);
  const useLocalProviders=()=>{
    runtime.providers.provenance=async()=>unknown('TEST_ORIGIN_UNKNOWN');
    runtime.providers.safety=async()=>unknown('TEST_SAFETY_UNKNOWN');
    runtime.providers.research=undefined;runtime.providers.vendor=undefined;
    runtime.providers.evidence=async()=>[];
    runtime.providers.narrative=async()=>({...unknown('NO_NARRATIVE'),evidence:[]});
  };
  try {
    useLocalProviders();await runtime.debotScanner!.runOnce();
    const db=new DatabaseSync(config.debotSignalsDatabase,{readOnly:true});
    const observed=String(db.prepare('SELECT observed_at FROM debot_signals').get()!.observed_at);db.close();
    await new Promise(resolve=>setTimeout(resolve,15));
    await runtime.debotScanner!.dispatchOnce();
    assert.equal(requests,1);assert.equal(runtime.debotScanner!.getStatus().dispatched,1);
    const scan=runtime.archive!.list().items[0];
    assert.equal(scan.source,'debot');assert.equal(scan.address,token);assert.equal(scan.receivedAt,observed);
    assert.equal(scan.occurredAt,new Date(created*1000).toISOString());
    assert.equal(scan.buyEligible,false);assert.equal(scan.wallets,undefined);
    assert.equal(runtime.dashboardOrders().items.length,0);
    assert.equal(runtime.dashboardOverview().debotScanner.enabled,true);
    await runtime.close();runtime=createRuntime(config);useLocalProviders();
    await runtime.debotScanner!.runOnce();await runtime.debotScanner!.dispatchOnce();
    assert.equal(runtime.archive!.list().total,1);assert.equal(runtime.store.list().length,0);
    assert.equal(runtime.debotScanner!.getStatus().dispatched,1);
    assert.equal(runtime.dashboardOverview().entryMode,'off');
  } finally {await runtime.close();globalThis.fetch=originalFetch;rmSync(directory,{recursive:true,force:true});}
});

test('durable collector paths cannot be in-memory or share an existing business database',()=>{
  for(const path of [':memory:','file:temporary?mode=memory',''])
    assert.throws(()=>readConfig({DEBOT_SIGNALS_DATABASE_PATH:path}));
  const config=readConfig({DEBOT_SCANNER_ENABLED:'true',ORDERS_DATABASE_PATH:'/tmp/collision.sqlite',DEBOT_SIGNALS_DATABASE_PATH:'/tmp/./collision.sqlite'});
  assert.throws(()=>createRuntime(config),/DEBOT_SIGNAL_DATABASE_CONFLICT/);
  assert.throws(()=>createRuntime(readConfig({DEBOT_SCANNER_ENABLED:'true',ORDERS_DATABASE_PATH:'/tmp/collision.sqlite',
    DEBOT_SESSION_PATH:'/tmp/./collision.sqlite'})),/DEBOT_SESSION_PATH_CONFLICT/);
  const directory=mkdtempSync(join(tmpdir(),'debot-path-'));
  try {
    const original=join(directory,'business.sqlite');writeFileSync(original,'do not modify');
    for(const [name,link] of [['symbolic',symlinkSync],['hard',linkSync]] as const) {
      const target=join(directory,name);link(original,target);
      const cfg=readConfig({DEBOT_SCANNER_ENABLED:'true',ORDERS_DATABASE_PATH:original,DEBOT_SIGNALS_DATABASE_PATH:target});
      assert.throws(()=>createRuntime(cfg),/DEBOT_SIGNAL_DATABASE_CONFLICT/);
    }
  }finally {rmSync(directory,{recursive:true,force:true});}
  assert.equal(readConfig({}).debotScannerEnabled,false);
  assert.throws(()=>readConfig({DEBOT_SCANNER_INTERVAL_SEC:'0'}));
});

test('queued first-receipt time does not backdate processing leases or refresh duplicate receipt times',()=>{
  const store=new Store(':memory:'),before=Date.now();
  const receivedAt=new Date(before-300_000).toISOString();
  const signal:Signal={source:'debot',sourceEventId:'queued',occurredAt:receivedAt,token:{chain:'bsc',address:'0x'+'b'.repeat(40)},
    text:'',evidenceUrls:[],claim:'unspecified'};
  try {
    const reserved=store.reserve(signal,undefined,'notification_copy',receivedAt);
    assert.equal(reserved.entry.receivedAt,receivedAt);
    assert.ok(Date.parse(reserved.entry.leaseExpiresAt!)>=before+PROCESSING_LEASE_MS);
    assert.equal(store.reserve(signal).entry.receivedAt,receivedAt);
    assert.throws(()=>store.reserve({...signal,sourceEventId:'bad'},undefined,'notification_copy','invalid'),/SIGNAL_RECEIVED_TIME_INVALID/);
    assert.throws(()=>store.reserve({...signal,sourceEventId:'future'},undefined,'notification_copy',new Date(Date.now()+120000).toISOString()),/SIGNAL_RECEIVED_TIME_INVALID/);
  }finally {store.close();}
});
