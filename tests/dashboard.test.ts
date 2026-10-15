import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDashboard,type DashboardServices} from '../src/dashboard.js';
import {DashboardBalances,dashboardSettings,dashboardOrders} from '../src/dashboard-data.js';
import {ScanArchive} from '../src/scan-archive.js';
import {Store} from '../src/store.js';
import {OrderStore} from '../src/orders.js';
import {evaluate} from '../src/engine.js';
import {config,signal,providers,now} from './helpers.js';

const password='test-dashboard-password-independent-12345678';
async function fixture(overrides:Partial<DashboardServices>={}) {
  const directory=mkdtempSync(join(tmpdir(),'dashboard-test-'));
  for(const name of ['index.html','app.js','styles.css'])writeFileSync(join(directory,name),name);
  const cfg=config();cfg.dashboard.token=password;
  const archive=new ScanArchive(':memory:');
  const server=buildDashboard(cfg,{archive,overview:()=>({entryMode:'off'}),orders:()=>({items:[]}),...overrides},directory);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  return {cfg,archive,base,server,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));archive.close();rmSync(directory,{recursive:true,force:true});}};
}
const login=(base:string,value=password,origin?:string)=>fetch(`${base}/dashboard/api/login`,{
  method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify({password:value})});

test('dashboard page routes enforce authentication, validate filters and pass bounded options to read-only services',async()=>{
  const calls:unknown[]=[];
  const service=(options:unknown)=>{calls.push(options);return {items:[],total:0};};
  const f=await fixture({home:()=>({entryMode:'off',compact:true}),debotSignals:service,orders:service,protection:service});
  try {
    const headers={'x-dashboard-access':password};
    for(const route of ['home','debot/signals','followup/records','followup/groups','followup/learning','orders','protection','wallet-screening']) {
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}`)).status,401,route);
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}`,{method:'POST',headers})).status,405,route);
    }
    assert.deepEqual(await (await fetch(`${f.base}/dashboard/api/home`,{headers})).json(),{entryMode:'off',compact:true});
    for(const route of ['debot/signals','followup/records','followup/groups','followup/learning','orders','protection','wallet-screening'])
      for(const query of ['limit=0','limit=101','offset=-1','offset=1000001','offset=1.5','chain=eth'])
        assert.equal((await fetch(`${f.base}/dashboard/api/${route}?${query}`,{headers})).status,400,`${route}: ${query}`);
    for(const query of ['decision=BUY','selected=yes','status=any','asOf=2026-10-15'])
      assert.equal((await fetch(`${f.base}/dashboard/api/followup/records?${query}`,{headers})).status,400,query);
    for(const query of ['state=any','asOf=invalid','asOf=2026-02-31T00:00:00.000Z'])
      assert.equal((await fetch(`${f.base}/dashboard/api/debot/signals?${query}`,{headers})).status,400,query);
    assert.equal(calls.length,0);
    for(const route of ['orders','protection','debot/signals'])
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}?limit=7&offset=21&chain=solana`,{headers})).status,200);
    assert.deepEqual(calls,[{limit:7,offset:21,chain:'solana'},{limit:7,offset:21,chain:'solana'},{limit:7,offset:21,chain:'solana'}]);
    const page=await (await fetch(`${f.base}/dashboard/api/followup/records?limit=7&offset=21`,{headers})).json();
    assert.equal(page.total,0);assert.equal(page.limit,7);assert.equal(page.offset,21);assert.equal(page.hasMore,false);assert.deepEqual(page.items,[]);
  } finally {await f.close();}
});

test('dashboard exposes assets but protects private data and serves strict CSP',async()=>{
  const f=await fixture();try {
    const page=await fetch(f.base+'/');assert.equal(page.status,200);
    assert.equal(await page.text(),'index.html');assert.match(page.headers.get('content-security-policy')!,/script-src 'self'/);
    assert.equal(page.headers.get('referrer-policy'),'no-referrer');
    for(const route of ['session','overview','scans','orders','chain-stream','followup','followup/bsc/0x0000000000000000000000000000000000000001'])assert.equal((await fetch(`${f.base}/dashboard/api/${route}`)).status,401);
    for(const path of ['/v1/signals','/.env','/config/exit-policy.json','/dashboard/../.env','/dashboard/%2e%2e/.env'])
      assert.equal((await fetch(f.base+path)).status,404);
  } finally {await f.close();}
});
test('separate dashboard credential yields HttpOnly session and logout invalidates it',async()=>{
  const f=await fixture();try {
    assert.equal((await login(f.base,f.cfg.ingestToken!)).status,401);
    const response=await login(f.base);assert.equal(response.status,200);
    const header=response.headers.get('set-cookie')!;assert.match(header,/HttpOnly/);assert.match(header,/SameSite=Strict/);
    const cookie=header.split(';')[0];
    const overview=await fetch(f.base+'/dashboard/api/overview',{headers:{cookie}});
    assert.deepEqual(await overview.json(),{entryMode:'off'});
    assert.equal((await fetch(f.base+'/dashboard/api/orders',{method:'POST',headers:{cookie}})).status,405);
    assert.equal((await fetch(f.base+'/dashboard/api/logout',{method:'POST',headers:{cookie}})).status,200);
    assert.equal((await fetch(f.base+'/dashboard/api/session',{headers:{cookie}})).status,401);
  } finally {await f.close();}
});
test('login rejects cross origin, bounds payload and rate limits failures',async()=>{
  const f=await fixture();try {
    assert.equal((await login(f.base,password,'https://evil.example')).status,403);
    assert.equal((await login(f.base,'x'.repeat(1100))).status,413);
    for(let i=0;i<10;i++)assert.equal((await login(f.base,'wrong')).status,401);
    assert.equal((await login(f.base)).status,429);
  } finally {await f.close();}
});
test('local authenticated proxy reaches only read-only whitelist and valid filters',async()=>{
  const f=await fixture();try {
    const headers={'x-dashboard-access':password};
    assert.equal((await fetch(f.base+'/dashboard/api/session',{headers})).status,200);
    for(const query of ['limit=-1','limit=0','limit=201','offset=nan','chain=eth','decision=EXECUTE','eligible=yes'])
      assert.equal((await fetch(f.base+'/dashboard/api/scans?'+query,{headers})).status,400,query);
    assert.deepEqual(await (await fetch(f.base+'/dashboard/api/scans?eligible=true',{headers})).json(),{items:[],total:0});
    assert.deepEqual(await (await fetch(f.base+'/dashboard/api/chain-stream',{headers})).json(),{enabled:false,running:false,chains:[],recentEvents:[]});
    assert.deepEqual(await (await fetch(f.base+'/dashboard/api/followup',{headers})).json(),{enabled:false});
    for(const suffix of ['eth/0x0000000000000000000000000000000000000001','bsc/not-address','solana/short','bsc/%E0%A4%A'])
      assert.equal((await fetch(f.base+'/dashboard/api/followup/'+suffix,{headers})).status,400,suffix);
    assert.equal((await fetch(f.base+'/dashboard/api/followup/bsc/0x0000000000000000000000000000000000000001',{headers})).status,404);
    assert.equal((await fetch(f.base+'/dashboard/api/followup',{method:'POST',headers})).status,405);
    assert.equal((await fetch(f.base+'/dashboard/api/chain-stream',{method:'POST',headers})).status,405);
    assert.equal((await fetch(f.base+'/v1/scanner/run',{method:'POST',headers})).status,404);
    assert.equal((await fetch(f.base+'/dashboard/api/scans',{method:'DELETE',headers})).status,405);
    assert.equal((await fetch(f.base+'/dashboard/api/session',{headers:{'x-dashboard-access':'wrong'}})).status,401);
  } finally {await f.close();}
});
test('dashboard credentials must not reuse the trading API or ingest credentials',async()=>{
  const f=await fixture();try {
    for(const value of [undefined,'short',f.cfg.ingestToken]) {
      f.cfg.dashboard.token=value;
      assert.throws(()=>buildDashboard(f.cfg,{archive:f.archive,overview:()=>null,orders:()=>null}),/DASHBOARD_SEPARATE_TOKEN_REQUIRED/);
    }
  } finally {await f.close();}
});
test('store change observer receives actual processing and completed reports, not duplicates',async t=>{
  // Provider fixtures and the observer clock must describe the same fresh evaluation.
  t.mock.timers.enable({apis:['Date'],now:now.getTime()});
  const archive=new ScanArchive(':memory:'),store=new Store(':memory:',item=>archive.capture(item));
  try {
    const current=signal({occurredAt:new Date().toISOString()});
    const reserved=store.reserve(current);assert.equal(archive.get(reserved.entry.id)?.status,'processing');
    store.reserve(current);assert.equal(archive.stats().total,1);
    const report=await evaluate(current,config(),providers(),{id:reserved.entry.id,receivedAt:reserved.entry.receivedAt});
    assert.equal(store.finish(reserved.entry.id,report,reserved.entry.claimId!),true);
    assert.equal(archive.get(report.id)?.decision,'BUY_CANDIDATE');assert.ok(archive.get(report.id)?.performance);
    const next=store.retry(report.id)!;assert.equal(archive.get(report.id)?.status,'processing');
    store.interrupt(report.id,next.claimId!);assert.equal(archive.get(report.id)?.status,'interrupted');
  } finally {store.close();archive.close();}
});
test('observational storage failure cannot roll back a committed signal or duplicate a trade',()=>{
  const store=new Store(':memory:',()=>{throw new Error('database full');});
  try {const first=store.reserve(signal());assert.equal(first.created,true);assert.equal(store.observationError,'SCAN_ARCHIVE_WRITE_FAILED');
    assert.equal(store.reserve(signal()).created,false);assert.equal(store.get(first.entry.id)?.status,'processing');}
  finally {store.close();}
});
test('dashboard balances are exact native units, cached, and missing responses never show zero',async()=>{
  const cfg=config();cfg.entryWallets={bsc:'wallet',solana:'wallet',robinhood:'wallet'};
  let calls=0;
  const balances=new DashboardBalances(cfg,async chain=>{calls++;return {status:chain==='robinhood'?'unknown':'verified',
    amount:chain==='solana'?'2384971463':'445426950800606938',readStartedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),reasons:['RPC_UNAVAILABLE']};});
  try {
    assert.equal(balances.get()[0].status,'loading');await Promise.all([balances.runOnce(),balances.runOnce()]);
    assert.equal(calls,3);assert.equal(balances.get()[0].amount,'0.445426950800606938');assert.equal(balances.get()[1].amount,'2.384971463');
    assert.equal(balances.get()[2].status,'unavailable');assert.equal(balances.get()[2].amount,undefined);balances.get();assert.equal(calls,3);
  } finally {await balances.stop();}
});
test('dashboard settings preserve approved caps and order projection omits private details',()=>{
  const cfg=config();cfg.entryAmounts={bsc:'150000000000000000',solana:'1000000000',robinhood:'50000000000000000'};
  assert.deepEqual(dashboardSettings(cfg).caps.map(c=>c.maxPerOrder),['0.15','1','0.05']);
  const fake={list:()=>[{id:'order',chain:'bsc',tokenAddress:'token',createdAt:'now',updatedAt:'now',status:'confirmed',mode:'live',inputAmount:'150000000000000000',
    details:{apiKey:'secret',signature:'private'},wallet:'private-account'}]} as unknown as OrderStore;
  const result=dashboardOrders(fake);assert.equal(result.items[0].amountIn,'0.15');
  assert.doesNotMatch(JSON.stringify(result),/secret|private|apiKey|signature/);
  const partial={list:()=>[{...fake.list()[0],actualInputAmount:'100000000000000000'}]} as unknown as OrderStore;
  assert.equal(dashboardOrders(partial).items[0].amountIn,'0.1');
  assert.equal(dashboardOrders(partial).items[0].requestedAmount,'0.15');
  assert.equal(dashboardOrders(partial).items[0].amountBasis,'actual');
});
