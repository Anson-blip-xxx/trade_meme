import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDashboard,type DashboardServices} from '../src/dashboard.js';
import {ScanArchive} from '../src/scan-archive.js';
import {config} from './helpers.js';

const token='independent-association-dashboard-access-token';
const leader='0x1111111111111111111111111111111111111111',candidate='0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const headers={'x-dashboard-access':token};
async function fixture(enabled=true) {
  const directory=mkdtempSync(join(tmpdir(),'association-dashboard-'));
  for(const name of ['index.html','app.js','styles.css'])writeFileSync(join(directory,name),name);
  const cfg=config();cfg.dashboard.token=token;
  const archive=new ScanArchive(':memory:');const calls:{method:string;input?:unknown}[]=[];
  const services:DashboardServices={archive,overview:()=>({entryMode:'off'}),orders:()=>({items:[]}),
    ...(enabled?{walletAssociationsStatus:()=>{calls.push({method:'cached-status'});return {relations:1,sampleOnly:true,tradingEnabled:false,state:'fresh'};}}:{}),
    ...(enabled?{walletAssociations:{
      associationStats:()=>{throw new Error('historical aggregate must not run in the HTTP loop');},
      listAssociations:(input:unknown)=>{calls.push({method:'list',input});return {items:[],total:0};},
      getAssociation:(chain:unknown,l:unknown,c:unknown)=>{calls.push({method:'get',input:{chain,leader:l,candidate:c}});return c===candidate?{association:{chain,leader:l,candidate:c,ownership:'unknown'}}:undefined;},
    } as unknown as DashboardServices['walletAssociations']}:{}),
  };
  const server=buildDashboard(cfg,services,directory);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/dashboard/api/wallet-associations`;
  return {base,calls,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));archive.close();rmSync(directory,{recursive:true,force:true});}};
}
test('association research endpoints require authentication and cannot submit orders',async()=>{
  const f=await fixture();try {
    for(const path of ['', '/status', `/bsc/${leader}/${candidate}`]) {
      assert.equal((await fetch(f.base+path)).status,401);
      assert.equal((await fetch(f.base+path,{method:'POST',headers})).status,405);
    }
    assert.equal(f.calls.length,0);
    const status=await(await fetch(f.base+'/status',{headers})).json();
    assert.equal(status.enabled,true);assert.equal(status.sampleOnly,true);assert.equal(status.tradingEnabled,false);
    assert.deepEqual(f.calls,[{method:'cached-status'}]);
  }finally{await f.close();}
});
test('association filters bound work and exact wallet identities stay chain scoped',async()=>{
  const f=await fixture();try {
    for(const query of ['chain=eth','limit=0','limit=101','offset=-1','offset=1000001','limit=1e2','search='+('x'.repeat(161))])
      assert.equal((await fetch(f.base+'?'+query,{headers})).status,400,query);
    assert.equal((await fetch(f.base+'?chain=bsc&search=abc&limit=20&offset=10',{headers})).status,200);
    assert.deepEqual(f.calls[0],{method:'list',input:{chain:'bsc',search:'abc',limit:20,offset:10}});
    for(const path of [`/solana/${leader}/${candidate}`,`/bsc/${leader}/${leader}`,`/bsc/not-address/${candidate}`,`/eth/${leader}/${candidate}`,`/bsc/${leader}/%zz`])
      assert.equal((await fetch(f.base+path,{headers})).status,400,path);
    assert.equal((await fetch(f.base+`/bsc/${leader}/${'0x'+candidate.slice(2).toUpperCase()}`,{headers})).status,200);
    assert.deepEqual(f.calls.at(-1),{method:'get',input:{chain:'bsc',leader,candidate}});
    assert.equal((await fetch(f.base+`/bsc/${candidate}/${leader}`,{headers})).status,404,'directed relation is not silently reversed');
  }finally{await f.close();}
});
test('disabled associations return explicit empty data',async()=>{
  const f=await fixture(false);try {
    assert.deepEqual(await(await fetch(f.base+'/status',{headers})).json(),{enabled:false});
    assert.deepEqual(await(await fetch(f.base,{headers})).json(),{items:[],total:0});
  }finally{await f.close();}
});
