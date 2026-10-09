import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDashboard,type DashboardServices} from '../src/dashboard.js';
import {ScanArchive} from '../src/scan-archive.js';
import {readConfig} from '../src/config.js';
import {config} from './helpers.js';

const token='independent-wallet-dashboard-access-token';
async function fixture(enabled=true) {
  const directory=mkdtempSync(join(tmpdir(),'wallet-dashboard-'));
  for(const name of ['index.html','app.js','styles.css'])writeFileSync(join(directory,name),name);
  const cfg=config();cfg.dashboard.token=token;
  const archive=new ScanArchive(':memory:');const calls:{method:string;input:unknown}[]=[];
  const services:DashboardServices={archive,overview:()=>({entryMode:'off'}),orders:()=>({items:[]}),
    ...(enabled?{walletResearchStatus:()=>({enabled:true,store:{wallets:2,events:5,sampleOnly:true,exactRealizedPnl:false}}),
      walletHistory:{listWallets:(input:unknown)=>{calls.push({method:'list',input});return {items:[],total:0};},
        getWallet:(chain:unknown,address:unknown)=>{calls.push({method:'get',input:{chain,address}});return address==='0x1111111111111111111111111111111111111111'?{chain,address}:undefined;}} as DashboardServices['walletHistory']}:{}),
  };
  const server=buildDashboard(cfg,services,directory);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/dashboard/api`;
  return {base,calls,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));archive.close();rmSync(directory,{recursive:true,force:true});}};
}
const headers={'x-dashboard-access':token};
test('wallet history API remains private and read-only',async()=>{
  const f=await fixture();try {
    for(const path of ['/wallet-research/status','/wallets','/wallets/bsc/0x1111111111111111111111111111111111111111'])
      assert.equal((await fetch(f.base+path)).status,401);
    assert.equal((await fetch(f.base+'/wallets',{method:'POST',headers})).status,405);
    const status=await(await fetch(f.base+'/wallet-research/status',{headers})).json();assert.equal(status.enabled,true);assert.equal(status.store.exactRealizedPnl,false);
    assert.equal(f.calls.length,0);
  } finally {await f.close();}
});
test('wallet filters are bounded and exact chain identity is required',async()=>{
  const f=await fixture();try {
    for(const query of ['chain=eth','sort=sql','limit=0','limit=101','offset=-1','search='+('x'.repeat(161))])
      assert.equal((await fetch(f.base+'/wallets?'+query,{headers})).status,400,query);
    assert.equal((await fetch(f.base+'/wallets?chain=bsc&sort=gain&limit=25&offset=5&search=abc',{headers})).status,200);
    assert.deepEqual(f.calls[0],{method:'list',input:{chain:'bsc',sort:'gain',limit:25,offset:5,search:'abc'}});
    for(const path of ['/wallets/solana/0x1111111111111111111111111111111111111111','/wallets/bsc/not-an-address','/wallets/eth/0x1111111111111111111111111111111111111111'])
      assert.equal((await fetch(f.base+path,{headers})).status,400,path);
    assert.equal((await fetch(f.base+'/wallets/bsc/0x1111111111111111111111111111111111111111',{headers})).status,200);
    assert.equal((await fetch(f.base+'/wallets/bsc/0x2222222222222222222222222222222222222222',{headers})).status,404);
  } finally {await f.close();}
});
test('disabled research shows an explicit empty state rather than fabricated rankings',async()=>{
  const f=await fixture(false);try {
    assert.deepEqual(await(await fetch(f.base+'/wallet-research/status',{headers})).json(),{enabled:false});
    assert.deepEqual(await(await fetch(f.base+'/wallets',{headers})).json(),{items:[],total:0});
  } finally {await f.close();}
});
test('wallet history config is independent of dashboard and bounded',()=>{
  const c=readConfig({WALLET_RESEARCH_ENABLED:'true',DASHBOARD_ENABLED:'false'});
  assert.equal(c.walletResearch.enabled,true);assert.equal(c.dashboard.enabled,false);
  assert.equal(c.walletResearch.intervalSec,300);assert.equal(c.walletResearch.maxRequestsPerCycle,9);
  assert.equal(c.walletResearch.maxBytes,512*1024*1024);
  for(const value of ['0','99999','NaN'])assert.throws(()=>readConfig({WALLET_HISTORY_MAX_MB:value}));
  assert.throws(()=>readConfig({WALLET_HISTORY_DATABASE_PATH:':memory:'}));
  assert.throws(()=>readConfig({WALLET_RESEARCH_ENABLED:'maybe'}));
});
