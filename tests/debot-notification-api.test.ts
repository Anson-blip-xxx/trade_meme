import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDashboard,type DashboardServices} from '../src/dashboard.js';
import {ScanArchive} from '../src/scan-archive.js';
import {config} from './helpers.js';

const password='notification-history-dashboard-private-test-token';
const ca='0x'+'abcdef1234'.repeat(4);
const path=(chain='bsc',address=ca)=>`/debot/tokens/${chain}/${address}/events`;
async function fixture(history?:DashboardServices['debotHistory']) {
  const directory=mkdtempSync(join(tmpdir(),'debot-history-api-'));
  for(const name of ['index.html','app.js','styles.css'])writeFileSync(join(directory,name),name);
  const cfg=config();cfg.dashboard.token=password;cfg.dashboard.origin='https://dashboard.example';
  const archive=new ScanArchive(':memory:');
  const server=buildDashboard(cfg,{archive,overview:()=>({entryMode:'off'}),orders:()=>({items:[]}),debotHistory:history},directory);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/dashboard/api`;
  const headers={'x-dashboard-access':password};
  return {base,headers,async login(){
    const response=await fetch(base+'/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
    assert.equal(response.status,200);return response.headers.get('set-cookie')!.split(';')[0];
  },async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));archive.close();rmSync(directory,{recursive:true,force:true});}};
}

test('notification history requires dashboard authentication for both proxy and session access and is read-only',async()=>{
  let reads=0;const result={total:0,limit:20,offset:0,hasMore:false,items:[]};
  const f=await fixture(()=>{reads++;return result;});
  try {
    const unauthorized:Record<string,string>[]=[{},{'x-dashboard-access':'wrong'}];
    for(const headers of unauthorized){
      const response=await fetch(f.base+path(),{headers});assert.equal(response.status,401);
      assert.deepEqual(await response.json(),{error:'UNAUTHORIZED'});
    }
    assert.equal(reads,0);const cookie=await f.login();
    for(const headers of [f.headers,{cookie}]) {
      const response=await fetch(f.base+path(),{headers});assert.equal(response.status,200);
      assert.deepEqual(await response.json(),result);assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(response.headers.get('www-authenticate'),null);assert.equal(response.headers.get('set-cookie'),null);
      for(const method of ['POST','PUT','PATCH','DELETE']) {
        const denied=await fetch(f.base+path(),{method,headers});assert.equal(denied.status,405);
        assert.deepEqual(await denied.json(),{error:'READ_ONLY'});
      }
    }
    assert.equal(reads,2);
    assert.equal((await fetch(f.base+'/logout',{method:'POST',headers:{cookie}})).status,200);
    assert.equal((await fetch(f.base+path(),{headers:{cookie}})).status,401);assert.equal(reads,2);
  }finally{await f.close();}
});

test('history path binds the exact chain and canonical CA before forwarding bounded pagination and timestamp options',async()=>{
  const calls:unknown[]=[];
  const f=await fixture((chain,address,options)=>{calls.push({chain,address,options});return {total:55,items:[{key:'example'}],...options,hasMore:true};});
  try {
    const asOf='2026-10-15T06:00:00.123Z',upper='0x'+ca.slice(2).toUpperCase();
    let response=await fetch(f.base+path('bsc',upper)+`?limit=7&offset=21&asOf=${encodeURIComponent(asOf)}`,{headers:f.headers});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{total:55,items:[{key:'example'}],limit:7,offset:21,asOf,hasMore:true});
    response=await fetch(f.base+path('robinhood',upper),{headers:f.headers});assert.equal(response.status,200);
    const sol='So11111111111111111111111111111111111111112';
    assert.equal((await fetch(f.base+path('solana',sol)+'?limit=100&offset=1000000',{headers:f.headers})).status,200);
    assert.deepEqual(calls,[{chain:'bsc',address:ca,options:{limit:7,offset:21,asOf}},
      {chain:'robinhood',address:ca,options:{limit:20,offset:0}},
      {chain:'solana',address:sol,options:{limit:100,offset:1000000}}]);
  }finally{await f.close();}
});

test('malformed chain, CA, URI, pagination or as-of timestamps never invoke the history reader',async()=>{
  let calls=0;const f=await fixture(()=>{calls++;return {items:[]};});
  try {
    const invalid=[path('eth'),path('BSC'),path('bsc','0x1'),path('bsc','0x'+'g'.repeat(40)),path('solana',ca),
      path('solana','invalid!'),path('solana','1'.repeat(45)),path('bsc','%ZZ'),path('bsc',encodeURIComponent(ca+'/unexpected'))];
    for(const route of invalid){const response=await fetch(f.base+route,{headers:f.headers});assert.equal(response.status,400,route);
      assert.deepEqual(await response.json(),{error:'INVALID_FILTER'});}
    for(const query of ['limit=0','limit=101','limit=1.1','offset=-1','offset=1000001','offset=1.2','chain=eth',
      'asOf=bad','asOf=2026-10-15','asOf=2026-10-15T06:00:00Z','asOf=2026-02-31T00:00:00.000Z']){
      const response=await fetch(f.base+path()+'?'+query,{headers:f.headers});assert.equal(response.status,400,query);
      assert.deepEqual(await response.json(),{error:'INVALID_FILTER'});
    }
    assert.equal(calls,0);
  }finally{await f.close();}
});

test('disabled notification history returns an empty bounded page without challenging an authenticated dashboard',async()=>{
  const f=await fixture();try {
    const asOf='2026-10-15T06:00:00.000Z';
    const response=await fetch(f.base+path()+`?limit=5&offset=10&asOf=${asOf}`,{headers:f.headers});assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{chain:'bsc',address:ca,total:0,items:[],limit:5,offset:10,asOf,hasMore:false});
    assert.equal(response.headers.get('www-authenticate'),null);assert.equal(response.headers.get('set-cookie'),null);
  }finally{await f.close();}
});

test('history failures expose no provider data and do not invalidate a valid dashboard session',async()=>{
  const f=await fixture(()=>{throw Object.assign(new Error('Cookie=private-cookie Authorization=private-token'),{status:401});});
  try {
    const cookie=await f.login(),response=await fetch(f.base+path(),{headers:{cookie}});
    assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'DASHBOARD_UNAVAILABLE'});
    assert.equal(response.headers.get('www-authenticate'),null);assert.equal(response.headers.get('set-cookie'),null);
    assert.equal((await fetch(f.base+'/session',{headers:{cookie}})).status,200);
  }finally{await f.close();}
});
