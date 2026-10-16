import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {OrderStore} from '../src/orders.js';
import {dashboardOrders} from '../src/dashboard-data.js';
import {ExitShadow} from '../src/exit-shadow.js';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';

test('order dashboard pages retain all rows and filter by chain without exposing provider details',()=>{
  const store=new OrderStore(':memory:');
  try {
    for(let n=0;n<45;n++)assert.equal(store.reserve({eventKey:`event-${n}`,chain:n%2?'bsc':'robinhood',
      tokenAddress:`0x${n.toString(16).padStart(40,'0')}`,mode:'paper',wallet:'private-wallet',inputToken:'native',
      inputAmount:'150000000000000000',slippagePct:1,details:{privateProviderPayload:'secret-marker'}},100).created,true);
    const first=dashboardOrders(store,{limit:20,offset:0}),second=dashboardOrders(store,{limit:20,offset:20}),
      third=dashboardOrders(store,{limit:20,offset:40});
    assert.equal(first.total,45);assert.equal(first.hasMore,true);assert.equal(third.hasMore,false);
    assert.equal(new Set([...first.items,...second.items,...third.items].map(row=>row.id)).size,45);
    const bsc=dashboardOrders(store,{limit:20,offset:20,chain:'bsc'});
    assert.equal(bsc.total,22);assert.equal(bsc.items.length,2);assert.ok(bsc.items.every(row=>row.chain==='bsc'));
    assert.doesNotMatch(JSON.stringify(first),/secret-marker|private-wallet|privateProviderPayload/);
    assert.equal(store.list(100).length,45);
  }finally{store.close();}
});

test('exit display metrics migrate history and throttle closed comparison samples without changing policy state',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dashboard-metrics-')),path=join(dir,'shadow.sqlite');
  let at=Date.parse('2026-10-15T00:00:00Z');
  const now=()=>new Date(at),address=`0x${'a'.repeat(40)}`;
  let shadow=new ExitShadow(path,{now});
  const quote=(value:number,chain:'bsc'|'robinhood'='bsc')=>({chain,address,priceUsd:value,observedAt:now().toISOString(),source:'gmgn_token_info_sample'});
  const seed={candidateId:'first',eligibleAt:now().toISOString(),endsAt:new Date(at+86400000).toISOString()};
  try {
    shadow.recordPrice(quote(100),seed);at+=60000;shadow.recordPrice(quote(50),seed);
    at+=60000;shadow.recordPrice(quote(1000),seed);at+=600000;shadow.recordPrice(quote(200),seed);
    const before=shadow.list().items[0];assert.equal(before.phase,'triggered');
    assert.equal(before.peakGainPct,900);assert.equal(before.maxGapSec,600);
    shadow.close();
    const old=new DatabaseSync(path);old.exec('DROP TABLE exit_shadow_metrics');old.close();
    shadow=new ExitShadow(path,{now});
    assert.deepEqual(shadow.list().items[0],before);
    const storedPolicy=()=>{const db=new DatabaseSync(path,{readOnly:true});
      try{return db.prepare('SELECT state FROM exit_shadow_positions WHERE id=?').get(before.id)!.state;}finally{db.close();}};
    const closedPolicy=storedPolicy();
    at+=1000;shadow.recordPrice(quote(3000),seed);
    const throttled=shadow.list().items[0];
    assert.equal(throttled.peakGainPct,900);assert.equal(throttled.latestPriceUsd,200);
    assert.equal(throttled.lastPriceAt,before.lastPriceAt);assert.equal(shadow.detail(before.id)!.sampleCount,4);
    assert.equal(storedPolicy(),closedPolicy);
    at+=59000;shadow.recordPrice(quote(2000),seed);
    const after=shadow.list().items[0];assert.equal(after.peakGainPct,1900);assert.equal(after.maxGapSec,600);
    assert.equal(after.remainingPct,0);assert.equal(after.triggerPeakGainPct,before.triggerPeakGainPct);
    assert.equal(after.phase,'triggered');assert.equal(after.latestPriceUsd,2000);
    assert.equal(shadow.detail(after.id)!.sampleCount,5);assert.equal(storedPolicy(),closedPolicy);
    shadow.recordPrice(quote(1,'robinhood'),{...seed,candidateId:'second'});
    const first=shadow.page({limit:1,offset:0}),second=shadow.page({limit:1,offset:1});
    assert.equal(first.total,2);assert.equal(first.hasMore,true);assert.equal(second.hasMore,false);
    assert.equal('pressure' in first.items[0],false);assert.equal('events' in first.items[0],false);
    assert.ok('events' in shadow.detail(after.id)!.item);
    assert.notEqual(first.items[0].id,second.items[0].id);
    assert.equal(shadow.page({chain:'bsc'}).items[0].id,after.id);
    assert.equal(shadow.page({chain:'bsc'}).total,1);
  }finally{shadow.close();rmSync(dir,{recursive:true,force:true});}
});

test('lightweight home never reads detailed research or protection lists and performs no network requests',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dashboard-home-'));
  const runtime=createRuntime(readConfig({ENTRY_MODE:'off',WATCH_RECHECK_ENABLED:'true',DASHBOARD_ENABLED:'false',
    SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),
    EXIT_SHADOW_ENABLED:'true',EXIT_SHADOW_DATABASE_PATH:join(dir,'exit.sqlite')}));
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_HOME_NETWORK');});
  t.mock.method(runtime.archive!,'stats',()=>{throw new Error('HOME_MUST_NOT_USE_FULL_STATS');});
  t.mock.method(runtime.exitShadow!,'summary',()=>{throw new Error('HOME_MUST_NOT_USE_EXIT_HISTORY');});
  try {
    const home=runtime.dashboardHome();assert.equal(home.entryMode,'off');assert.equal(home.stats?.total,0);
    assert.equal(home.status.scannerRunning,false);assert.ok(JSON.stringify(home).length<1500);
    assert.equal(fetch.mock.callCount(),0);
    assert.equal(runtime.dashboardOrders().total,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
