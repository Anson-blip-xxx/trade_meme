import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WalletHistory} from '../src/wallet-history.js';
import {WalletProfileRunner} from '../src/wallet-profile-runner.js';
import {buildDashboard} from '../src/dashboard.js';
import {ScanArchive} from '../src/scan-archive.js';
import {readConfig} from '../src/config.js';

const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
async function until(check:()=>boolean) {
  const deadline=Date.now()+15000;
  while(!check()) {assert.ok(Date.now()<deadline,'background worker did not progress');await new Promise(r=>setTimeout(r,50));}
}
test('profile worker continuously processes new evidence without web requests and resumes persisted profiles after restart',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-profile-worker-'));
  const history=new WalletHistory(join(directory,'history.sqlite'));
  const options={database:join(directory,'profiles.sqlite'),historyDatabase:join(directory,'history.sqlite'),maxBytes:16*1024*1024,intervalSec:1,batchSize:10};
  let runner=new WalletProfileRunner(options);
  const trade=(n:number)=>history.recordTrade({chain:'bsc',wallet:address(n),tokenAddress:address(99),
    txHash:'0x'+n.toString(16).padStart(64,'0'),side:'buy',eventAt:new Date(Date.now()-2000).toISOString(),
    observedAt:new Date(Date.now()-1000).toISOString(),source:'gmgn_kol_feed'});
  try {
    trade(1);runner.start();runner.start();
    await until(()=>Number(runner.status().profiles)>=1);
    assert.equal(runner.status().restarts,0);assert.equal(runner.reader.get('bsc',address(1))?.metrics.buyEvents,1);
    trade(2);await until(()=>Number(runner.status().profiles)>=2);
    assert.equal(runner.status().tradingEnabled,false);assert.equal(runner.reader.get('bsc',address(2))?.ownership,'unknown');
    await runner.stop();assert.equal(runner.status().running,false);
    runner=new WalletProfileRunner(options);assert.equal(runner.reader.get('bsc',address(1))?.metrics.buyEvents,1);
    runner.start();await until(()=>runner.status().ready===true);
    assert.equal(runner.reader.get('bsc',address(1))?.changes?.length,1);
  } finally {await runner.stop();history.close();rmSync(directory,{recursive:true,force:true});}
});

test('background worker persists frozen peer qualification and retains it when a later buy refreshes the current profile',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-profile-qualification-worker-'));
  const history=new WalletHistory(join(directory,'history.sqlite'));
  const options={database:join(directory,'profiles.sqlite'),historyDatabase:join(directory,'history.sqlite'),maxBytes:16*1024*1024,intervalSec:1,batchSize:10};
  const runner=new WalletProfileRunner(options),base=Date.now()-120000;
  const pair=(wallet:number,token:number,when:number,source:string)=>history.recordTrade({chain:'bsc',wallet:address(wallet),tokenAddress:address(token),
    txHash:'0x'+(wallet*1000+token).toString(16).padStart(64,'0'),side:'buy',eventAt:new Date(when).toISOString(),observedAt:new Date(when+1).toISOString(),source});
  try {
    for(let i=0;i<3;i++){pair(1,100+i,base+i*20000,'gmgn_wallet_activity');pair(2,100+i,base+i*20000+10000,'gmgn_kol_feed');}
    runner.start();await until(()=>!!runner.reader.get('bsc',address(1))?.roleAnalysis?.peers[0]?.qualification);
    const frozen=structuredClone(runner.reader.get('bsc',address(1))!.roleAnalysis!.peers[0].qualification!);
    assert.equal(frozen.evidence.length,3);assert.ok(Date.parse(frozen.knownAt)>base+120000-1000);
    await new Promise(r=>setTimeout(r,5));pair(1,900,Date.now()-2,'gmgn_wallet_activity');
    await until(()=>runner.reader.get('bsc',address(1))?.metrics.buyEvents===4);
    const updated=runner.reader.get('bsc',address(1))!;assert.ok(updated.computedAt>frozen.knownAt);
    assert.deepEqual(updated.roleAnalysis!.peers[0].qualification,frozen);
    assert.equal(updated.roleAnalysis!.peers[0].totalCandidateTokens,4);
    assert.equal(updated.roleAnalysis!.peers[0].screeningEvidence,undefined,'temporary comparison frames are not duplicated in durable profiles');
    assert.equal(runner.status().error,undefined);assert.equal(runner.status().tradingEnabled,false);
  }finally{await runner.stop();history.close();rmSync(directory,{recursive:true,force:true});}
});

test('derived profile APIs require authentication, bound filters and never allow writes',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-profile-api-')),password='independent-profile-api-test-access-123456';
  const config=readConfig({DASHBOARD_ACCESS_TOKEN:password});
  const archive=new ScanArchive(':memory:');const calls:unknown[]=[];
  const server=buildDashboard(config,{archive,overview:()=>null,orders:()=>null,walletProfilesStatus:()=>({enabled:true,ready:true,profiles:2}),
    walletProfiles:{list:input=>{calls.push(input);return {ready:true,items:[],total:2};},get:(chain,addr)=>undefined}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/dashboard/api`,headers={'x-dashboard-access':password};
  try {
    for(const path of ['/wallet-profiles/status','/wallet-profiles','/wallet-profiles/bsc/'+address(1)])
      assert.equal((await fetch(base+path)).status,401);
    assert.equal((await fetch(base+'/wallet-profiles',{method:'POST',headers})).status,405);
    assert.equal((await(await fetch(base+'/wallet-profiles/status',{headers})).json()).profiles,2);
    for(const query of ['chain=eth','group=owner','limit=0','limit=101','offset=-1','search='+('x'.repeat(161))])
      assert.equal((await fetch(base+'/wallet-profiles?'+query,{headers})).status,400,query);
    assert.equal((await fetch(base+'/wallet-profiles?chain=bsc&group=repeated_early&limit=20&offset=2&search=abc',{headers})).status,200);
    assert.deepEqual(calls,[{chain:'bsc',group:'repeated_early',limit:20,offset:2,search:'abc'}]);
    assert.equal((await fetch(base+'/wallet-profiles/solana/'+address(1),{headers})).status,400);
    assert.equal((await fetch(base+'/wallet-profiles/bsc/'+address(1),{headers})).status,404);
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));archive.close();rmSync(directory,{recursive:true,force:true});}
});

test('profiles follow research enablement by default, allow explicit disabling and reject source/output path collisions',()=>{
  assert.equal(readConfig({WALLET_RESEARCH_ENABLED:'true'}).walletProfiles.enabled,true);
  assert.equal(readConfig({WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false'}).walletProfiles.enabled,false);
  assert.equal(readConfig({}).walletProfiles.enabled,false);
  for(const values of [{WALLET_PROFILES_INTERVAL_SEC:'0'},{WALLET_PROFILES_BATCH_SIZE:'501'},{WALLET_PROFILES_DATABASE_PATH:':memory:'}])
    assert.throws(()=>readConfig(values));
  assert.throws(()=>new WalletProfileRunner({database:'/tmp/a.sqlite',historyDatabase:'/tmp/../tmp/a.sqlite',
    maxBytes:16*1024*1024,intervalSec:2,batchSize:10}),/MUST_BE_SEPARATE/);
});

test('worker startup failure is visible with fixed diagnostics and shutdown cancels the retry',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-profile-failure-'));
  const runner=new WalletProfileRunner({database:join(directory,'profiles.sqlite'),historyDatabase:join(directory,'missing-private-source.sqlite'),
    maxBytes:16*1024*1024,intervalSec:1,batchSize:10});
  try {
    runner.start();await until(()=>runner.status().restarts===1);
    assert.equal(runner.status().running,false);assert.equal(runner.status().error,'WALLET_PROFILE_WORKER_FAILED');
    assert.doesNotMatch(JSON.stringify(runner.status()),/missing-private-source|sqlite|\/tmp\//);
    await runner.stop();assert.equal(runner.status().running,false);
  } finally {await runner.stop();rmSync(directory,{recursive:true,force:true});}
});
