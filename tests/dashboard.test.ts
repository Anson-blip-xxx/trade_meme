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

test('signal counting uses authenticated bounded pages and strict configured-mode controls without touching trading services',async()=>{
  const calls:unknown[]=[],headers={'x-dashboard-access':password,'content-type':'application/json'};
  const f=await fixture({signalCountingPage:options=>{calls.push({page:options});return {status:{running:true,mode:'simulation',executionEnabled:false},...options,items:[],total:0};},
    signalCountingControl:(action,actor)=>{calls.push({action,actor});return {running:action==='start',mode:'simulation',executionEnabled:false};},
    orders:()=>{throw new Error('COUNTING_MUST_NOT_TRADE');}});
  try {
    for(const [route,method] of [['signal-counting','GET'],['signal-counting/control','POST']])
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}`,{method})).status,401);
    const result=await fetch(`${f.base}/dashboard/api/signal-counting?limit=7&offset=14`,{headers});
    assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
    const page=await result.json();assert.equal(page.mode,'simulation');assert.equal(page.executionEnabled,false);assert.equal(page.status.running,true);
    assert.deepEqual(calls,[{page:{limit:7,offset:14}}]);
    for(const query of ['limit=0','limit=101','offset=-1','offset=1000001','chain=bsc','limit=1&limit=2','mode=live'])
      assert.equal((await fetch(`${f.base}/dashboard/api/signal-counting?${query}`,{headers})).status,400,query);
    const control=`${f.base}/dashboard/api/signal-counting/control`;
    for(const method of ['GET','PUT','DELETE'])assert.equal((await fetch(control,{method,headers})).status,405);
    assert.equal((await fetch(control,{method:'POST',headers:{...headers,origin:'https://evil.invalid'},body:'{"action":"start"}'})).status,403);
    assert.equal((await fetch(control,{method:'POST',headers:{...headers,'sec-fetch-site':'cross-site'},body:'{"action":"start"}'})).status,403);
    assert.equal((await fetch(control,{method:'POST',headers:{...headers,'content-type':'text/plain'},body:'{"action":"start"}'})).status,415);
    assert.equal((await fetch(control,{method:'POST',headers,body:'x'.repeat(257)})).status,413);
    assert.equal((await fetch(control,{method:'POST',headers,body:'{'})).status,400);
    for(const body of ['null','[]','{}','{"action":"buy"}','{"action":"start","actor":"tg"}','{"action":["start"]}'])
      assert.equal((await fetch(control,{method:'POST',headers,body})).status,400,body);
    assert.equal(calls.length,1);
    for(const action of ['start','start','stop']){
      const response=await fetch(control,{method:'POST',headers,body:JSON.stringify({action})});assert.equal(response.status,200);
      const status=await response.json();assert.equal(status.running,action==='start');assert.equal(status.mode,'simulation');assert.equal(status.executionEnabled,false);
    }
    assert.deepEqual(calls.slice(1),[{action:'start',actor:'web'},{action:'start',actor:'web'},{action:'stop',actor:'web'}]);
  }finally{await f.close();}
});

test('live counting routes preserve running, stopped and readiness status instead of rewriting it to simulation',async()=>{
  let running=false;
  const status=()=>({enabled:true,mode:'live',configuredExecutionMode:'live',running,executionEnabled:running,
    executionReady:true,activeChains:['solana']});
  const f=await fixture({signalCountingPage:options=>({status:status(),...options,items:[],total:0}),
    signalCountingControl:action=>{running=action==='start';return status();}});
  const headers={'x-dashboard-access':password,'content-type':'application/json'};
  try {
    const session=await(await fetch(`${f.base}/dashboard/api/session`,{headers})).json();
    assert.equal(session.readOnly,false);assert.equal(session.signalCountingControlEnabled,true);
    let page=await(await fetch(`${f.base}/dashboard/api/signal-counting`,{headers})).json();
    assert.equal(page.mode,'live');assert.equal(page.executionEnabled,false);assert.equal(page.status.executionReady,true);
    for(const action of ['start','stop']){
      const response=await fetch(`${f.base}/dashboard/api/signal-counting/control`,{method:'POST',headers,body:JSON.stringify({action})});
      assert.equal(response.status,200);assert.deepEqual(await response.json(),status());
      page=await(await fetch(`${f.base}/dashboard/api/signal-counting`,{headers})).json();
      assert.equal(page.mode,'live');assert.equal(page.executionEnabled,action==='start');assert.deepEqual(page.status,status());
    }
  }finally{await f.close();}
});

test('signal counting supports dashboard session authentication and disabled services never expose execution',async()=>{
  const f=await fixture();try {
    const response=await login(f.base),cookie=response.headers.get('set-cookie')!.split(';')[0];
    const page=await(await fetch(`${f.base}/dashboard/api/signal-counting?limit=5&offset=10`,{headers:{cookie}})).json();
    assert.deepEqual(page,{status:{enabled:false,running:false,mode:'simulation',executionEnabled:false},items:[],total:0,limit:5,offset:10,hasMore:false,mode:'simulation',executionEnabled:false});
    const result=await fetch(`${f.base}/dashboard/api/signal-counting/control`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{"action":"start"}'});
    assert.equal(result.status,503);assert.equal((await result.json()).executionEnabled,false);
  }finally{await f.close();}
});

test('JEV parallel records require authentication and bounded read-only paging without invoking scoring',async()=>{
  const calls:unknown[]=[],headers={'x-dashboard-access':password};
  const f=await fixture({jev:{status:()=>({enabled:true,mode:'shadow',available:false,circuit:{reason:'JEV_QUOTA_EXHAUSTED'}}),
    list:options=>{calls.push(options);return {...options,total:1,items:[{id:'sample-1',status:'unavailable',result:null}]};},
    detail:id=>id==='sample-1'?{id,result:null}:undefined},orders:()=>{throw new Error('JEV_MUST_NOT_TRADE');}});
  try{
    for(const route of ['jev','jev/status','jev/sample-1']){
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}`)).status,401);
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}`,{method:'POST',headers})).status,405);
    }
    const response=await fetch(`${f.base}/dashboard/api/jev?limit=7&offset=14&chain=solana`,{headers});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const page=await response.json();assert.equal(page.items[0].result,null);assert.deepEqual(calls,[{limit:7,offset:14,chain:'solana'}]);
    const status=await(await fetch(`${f.base}/dashboard/api/jev/status`,{headers})).json();assert.equal(status.circuit.reason,'JEV_QUOTA_EXHAUSTED');
    assert.equal((await fetch(`${f.base}/dashboard/api/jev/sample-1`,{headers})).status,200);
    assert.equal((await fetch(`${f.base}/dashboard/api/jev/missing`,{headers})).status,404);
    for(const suffix of ['?limit=0','?limit=101','?offset=-1','?chain=eth','/%22secret','/'+ 'a'.repeat(129)])
      assert.equal((await fetch(`${f.base}/dashboard/api/jev${suffix}`,{headers})).status,400,suffix);
    assert.equal(calls.length,1);
  }finally{await f.close();}
});

test('disabled JEV supplies empty pages and the homepage never loads its records',async()=>{
  const headers={'x-dashboard-access':password},f=await fixture();
  try{
    const status=await(await fetch(`${f.base}/dashboard/api/jev/status`,{headers})).json();assert.equal(status.enabled,false);
    const page=await(await fetch(`${f.base}/dashboard/api/jev?limit=5&offset=10`,{headers})).json();
    assert.deepEqual(page,{enabled:false,items:[],total:0,limit:5,offset:10,hasMore:false});
    assert.equal((await fetch(`${f.base}/dashboard/api/jev/missing`,{headers})).status,404);
  }finally{await f.close();}
  const unexpected=()=>{throw new Error('JEV_MUST_BE_LAZY');};
  const isolated=await fixture({home:()=>({compact:true}),jev:{status:unexpected,list:unexpected,detail:unexpected}});
  try{assert.deepEqual(await(await fetch(`${isolated.base}/dashboard/api/home`,{headers})).json(),{compact:true});}finally{await isolated.close();}
});

test('ranking research is authenticated and read-only with chain scoped stable pagination for tokens and wallets',async()=>{
  const calls:unknown[]=[],headers={'x-dashboard-access':password},stamp='2026-10-15T08:00:00.000Z',address='0x'+'A'.repeat(40);
  const page=(kind:string)=>async(options:unknown)=>{calls.push({kind,options});return {items:[],total:0};};
  const detail=(kind:string)=>async(chain:string,address:string,options:unknown)=>{calls.push({kind,chain,address,options});return {items:[]};};
  const f=await fixture({tokenRankResearch:page('tokens'),tokenRankWallets:page('wallets'),tokenRankResearchDetail:detail('token'),tokenRankWallet:detail('wallet'),
    orders:()=>{throw new Error('RESEARCH_MUST_NOT_ACCESS_ORDERS');}});
  try {
    const routes=['token-rank-research','token-rank-research/wallets',`token-rank-research/bsc/${address}`,`token-rank-research/wallets/bsc/${address}`];
    for(const route of routes){
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}`)).status,401);
      for(const method of ['POST','PATCH','DELETE'])assert.equal((await fetch(`${f.base}/dashboard/api/${route}`,{method,headers})).status,405);
      const res=await fetch(`${f.base}/dashboard/api/${route}?limit=7&offset=14&asOf=${stamp}${route===routes[0]?'&chain=bsc':route===routes[1]?'&chain=solana&sort=realized':''}`,{headers});
      assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
    }
    assert.deepEqual(calls,[{kind:'tokens',options:{limit:7,offset:14,chain:'bsc',asOf:stamp}},
      {kind:'wallets',options:{limit:7,offset:14,chain:'solana',asOf:stamp,sort:'realized'}},
      {kind:'token',chain:'bsc',address:address.toLowerCase(),options:{limit:7,offset:14,asOf:stamp}},
      {kind:'wallet',chain:'bsc',address:address.toLowerCase(),options:{limit:7,offset:14,asOf:stamp}}]);
    for(const route of routes)for(const query of ['limit=0','limit=101','offset=-1','offset=1000001','chain=eth','asOf=invalid','asOf=2999-01-01T00:00:00.000Z'])
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}?${query}`,{headers})).status,400,`${route}?${query}`);
    for(const route of ['token-rank-research?sort=realized','token-rank-research/wallets?sort=profit','token-rank-research/bsc/incomplete',`token-rank-research/wallets/eth/${address}`,`token-rank-research/solana/${address}`])
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}`,{headers})).status,400,route);
    assert.equal(calls.length,4);
  }finally{await f.close();}
});

test('unconfigured ranking research gives bounded empty pages and is not invoked by home',async()=>{
  const headers={'x-dashboard-access':password},address='0x'+'1'.repeat(40),f=await fixture();
  try {
    for(const route of ['token-rank-research','token-rank-research/wallets',`token-rank-research/bsc/${address}`,`token-rank-research/wallets/bsc/${address}`]){
      const data=await(await fetch(`${f.base}/dashboard/api/${route}?limit=5&offset=10`,{headers})).json();
      assert.equal(data.ready,false);assert.deepEqual(data.items,[]);assert.equal(data.total,0);assert.equal(data.offset,10);assert.equal(data.limit,5);assert.equal(data.hasMore,false);assert.ok(Number.isFinite(Date.parse(data.asOf)));
    }
  }finally{await f.close();}
  const isolated=await fixture({home:()=>({compact:true}),tokenRankResearch:()=>{throw new Error('MUST_BE_LAZY');},tokenRankWallets:()=>{throw new Error('MUST_BE_LAZY');}});
  try{assert.deepEqual(await(await fetch(`${isolated.base}/dashboard/api/home`,{headers})).json(),{compact:true});}finally{await isolated.close();}
});

test('asynchronous ranking, scan, meme and overview reads leave lightweight dashboard requests responsive',async()=>{
  const headers={'x-dashboard-access':password};let releaseRank:(value:{items:never[];total:number})=>void=()=>{},
    releaseScan:(value:{items:never[];total:number})=>void=()=>{},releaseMeme:(value:{items:never[];total:number})=>void=()=>{},
    rankEntered:()=>void=()=>{},scanEntered:()=>void=()=>{},memeEntered:()=>void=()=>{},overviewEntered:()=>void=()=>{};
  const rankStarted=new Promise<void>(resolve=>{rankEntered=resolve;}),scanStarted=new Promise<void>(resolve=>{scanEntered=resolve;}),
    memeStarted=new Promise<void>(resolve=>{memeEntered=resolve;}),rankPage=new Promise<{items:never[];total:number}>(resolve=>{releaseRank=resolve;}),
    scanPage=new Promise<{items:never[];total:number}>(resolve=>{releaseScan=resolve;}),memePage=new Promise<{items:never[];total:number}>(resolve=>{releaseMeme=resolve;}),
    overviewStarted=new Promise<void>(resolve=>{overviewEntered=resolve;});let releaseOverview:(value:{ready:boolean})=>void=()=>{};
  const overviewPage=new Promise<{ready:boolean}>(resolve=>{releaseOverview=resolve;});
  const f=await fixture({tokenRankResearch:async()=>{rankEntered();return rankPage;},scanList:async()=>{scanEntered();return scanPage;},
    memeSignals:async()=>{memeEntered();return memePage;},overview:async()=>{overviewEntered();return overviewPage;}});
  try {
    const rank=fetch(`${f.base}/dashboard/api/token-rank-research`,{headers});await rankStarted;
    assert.equal((await Promise.race([fetch(`${f.base}/dashboard/api/session`,{headers}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('LIGHT_REQUEST_BLOCKED')),250))])).status,200);
    releaseRank({items:[],total:0});assert.equal((await rank).status,200);
    const scan=fetch(`${f.base}/dashboard/api/scans?search=z`,{headers});await scanStarted;
    assert.equal((await Promise.race([fetch(`${f.base}/dashboard/api/session`,{headers}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('LIGHT_REQUEST_BLOCKED')),250))])).status,200);
    releaseScan({items:[],total:0});assert.equal((await scan).status,200);
    const meme=fetch(`${f.base}/dashboard/api/meme`,{headers});await memeStarted;
    assert.equal((await Promise.race([fetch(`${f.base}/dashboard/api/session`,{headers}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('LIGHT_REQUEST_BLOCKED')),250))])).status,200);
    releaseMeme({items:[],total:0});assert.equal((await meme).status,200);
    const overview=fetch(`${f.base}/dashboard/api/overview`,{headers});await overviewStarted;
    assert.equal((await Promise.race([fetch(`${f.base}/dashboard/api/session`,{headers}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('LIGHT_REQUEST_BLOCKED')),250))])).status,200);
    releaseOverview({ready:true});assert.equal((await overview).status,200);
  } finally {await f.close();}
});

test('Ave signal pages and token source history are authenticated read-only bounded routes with stable filters',async()=>{
  const calls:unknown[]=[],headers={'x-dashboard-access':password},stamp='2026-10-15T08:00:00.000Z',address='0x'+'A'.repeat(40);
  const f=await fixture({aveSignals:options=>{calls.push({kind:'ave',...options});return {items:[],total:0};},
    sourceHistory:(chain,address,options)=>{calls.push({kind:'sources',chain,address,...options});return {items:[],token:{chain,address}};},
    orders:()=>{throw new Error('SOURCE_ROUTES_MUST_NOT_TOUCH_ORDERS');}});
  try {
    for(const route of ['ave/signals',`sources/bsc/${address}/events`]){
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}`)).status,401);
      for(const method of ['POST','PATCH','DELETE'])assert.equal((await fetch(`${f.base}/dashboard/api/${route}`,{method,headers})).status,405);
    }
    const ave=await fetch(`${f.base}/dashboard/api/ave/signals?limit=7&offset=14&chain=bsc&asOf=${stamp}`,{headers});
    assert.equal(ave.status,200);assert.equal(ave.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(`${f.base}/dashboard/api/sources/bsc/${address}/events?limit=7&offset=14&asOf=${stamp}`,{headers})).status,200);
    assert.deepEqual(calls,[{kind:'ave',limit:7,offset:14,chain:'bsc',asOf:stamp},{kind:'sources',chain:'bsc',address:address.toLowerCase(),limit:7,offset:14,asOf:stamp}]);
    for(const path of ['ave/signals?limit=101','ave/signals?offset=-1','ave/signals?chain=eth','ave/signals?asOf=invalid','ave/signals?asOf=2999-01-01T00:00:00.000Z',
      `sources/bsc/${address}/events?asOf=2999-01-01T00:00:00.000Z`,`sources/bsc/${address}/events?offset=1000001`,
      `sources/eth/${address}/events`,'sources/bsc/incomplete/events',`sources/solana/${address}/events`])
      assert.equal((await fetch(`${f.base}/dashboard/api/${path}`,{headers})).status,400,path);
    assert.equal(calls.length,2);
  }finally{await f.close();}
});

test('unconfigured Ave and source history provide valid empty pages without making provider calls',async()=>{
  const f=await fixture(),headers={'x-dashboard-access':password};
  try {
    for(const route of ['ave/signals?limit=5&offset=10','sources/bsc/0x1111111111111111111111111111111111111111/events?limit=5&offset=10']){
      const result=await (await fetch(`${f.base}/dashboard/api/${route}`,{headers})).json();
      assert.deepEqual(result.items,[]);assert.equal(result.total,0);assert.equal(result.limit,5);assert.equal(result.offset,10);assert.equal(result.hasMore,false);
      assert.ok(Number.isFinite(Date.parse(result.asOf)));
    }
  }finally{await f.close();}
});

test('Meme research pages validate scoped identity and stable pagination without touching orders',async()=>{
  const calls:unknown[]=[];
  const f=await fixture({memeSignals:options=>{calls.push(options);return {items:[],status:{researchOnly:true}};},
    memeDetail:(chain,address,options)=>{calls.push({chain,address,...options});return {items:[],token:{chain,address}};},
    orders:()=>{throw new Error('MUST_NOT_TOUCH_ORDERS');}});
  const headers={'x-dashboard-access':password},stamp='2026-10-16T08:00:00.000Z',address='0x'+'A'.repeat(40);
  try {
    assert.equal((await fetch(`${f.base}/dashboard/api/meme?limit=7&offset=14&chain=bsc&asOf=${stamp}`,{headers})).status,200);
    assert.deepEqual(calls[0],{limit:7,offset:14,chain:'bsc',asOf:stamp});
    const detail=await (await fetch(`${f.base}/dashboard/api/meme/bsc/${address}?limit=7&offset=14&asOf=${stamp}`,{headers})).json();
    assert.equal(detail.token.address,address.toLowerCase());
    assert.deepEqual(calls[1],{chain:'bsc',address:address.toLowerCase(),limit:7,offset:14,asOf:stamp});
    for(const path of ['meme?asOf=2026-02-31T00:00:00.000Z','meme/eth/'+address,'meme/bsc/invalid',
      'meme/solana/'+address,'meme?limit=21','meme/bsc/'+address+'?offset=-1','meme/bsc/'+address+'?limit=21'])
      assert.equal((await fetch(`${f.base}/dashboard/api/${path}`,{headers})).status,400,path);
    assert.equal(calls.length,2);
  }finally{await f.close();}
});

test('dashboard page routes enforce authentication, validate filters and pass bounded options to read-only services',async()=>{
  const calls:unknown[]=[];
  const service=(options:unknown)=>{calls.push(options);return {items:[],total:0};};
  const f=await fixture({home:()=>({entryMode:'off',compact:true}),debotSignals:service,memeSignals:service,orders:service,protection:service});
  try {
    const headers={'x-dashboard-access':password};
    for(const route of ['home','meme','meme/bsc/0x1111111111111111111111111111111111114444','debot/signals','followup/records','followup/groups','followup/learning','orders','protection','wallet-screening']) {
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}`)).status,401,route);
      assert.equal((await fetch(`${f.base}/dashboard/api/${route}`,{method:'POST',headers})).status,405,route);
    }
    assert.deepEqual(await (await fetch(`${f.base}/dashboard/api/home`,{headers})).json(),{entryMode:'off',compact:true});
    for(const route of ['meme','debot/signals','followup/records','followup/groups','followup/learning','orders','protection','wallet-screening'])
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
    for(const query of ['limit=-1','limit=0','limit=21','limit=201','offset=nan','chain=eth','decision=EXECUTE','eligible=yes'])
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
  const cfg=config();cfg.entryBalanceBps={};cfg.entryAmounts={bsc:'150000000000000000',solana:'1000000000',robinhood:'50000000000000000'};
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

test('dashboard fraction sizing suppresses retired fixed SOL cap while exposing its precise percentage',()=>{
  const cfg=config();cfg.entryAmounts={bsc:'150000000000000000',solana:'1000000000',robinhood:'50000000000000000'};
  cfg.entryBalanceBps={solana:1000};
  const caps=dashboardSettings(cfg).caps;
  assert.deepEqual(caps.map(c=>c.maxPerOrder),['0.15',null,'0.05']);
  assert.equal(caps[1].sizing,'balance_fraction');assert.equal(caps[1].balanceBps,1000);
  assert.equal(caps[0].balanceBps,null);assert.equal(caps[2].balanceBps,null);
});

test('dashboard defaults show total-native-balance 3 percent on every chain with old fixed caps suppressed',()=>{
  const cfg=config();cfg.entryAmounts={bsc:'150000000000000000',solana:'1000000000',robinhood:'50000000000000000'};
  const caps=dashboardSettings(cfg).caps;
  assert.deepEqual(caps.map(c=>c.maxPerOrder),[null,null,null]);
  assert.deepEqual(caps.map(c=>c.balanceBps),[300,300,300]);
  assert.deepEqual(caps.map(c=>c.balanceBasis),['total_native_balance','total_native_balance','total_native_balance']);
});

test('SOL-only settings and cached balances do not query disabled chains',async()=>{
  const cfg=config();cfg.scannerChains=['solana'];cfg.entryWallets={bsc:'bsc-wallet',solana:'sol-wallet',robinhood:'rb-wallet'};
  const queried:string[]=[],balances=new DashboardBalances(cfg,async(chain)=>{
    queried.push(chain);return {status:'verified',amount:'1000000000',readStartedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),reasons:[]};
  });
  try {
    await balances.runOnce();assert.deepEqual(queried,['solana']);
    assert.deepEqual(balances.get().map(row=>row.chain),['solana']);
    assert.deepEqual(dashboardSettings(cfg).caps.map(row=>row.chain),['solana']);
  }finally{await balances.stop();}
});
