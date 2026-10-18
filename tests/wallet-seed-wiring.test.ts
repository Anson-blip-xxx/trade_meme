import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {WalletHistory} from '../src/wallet-history.js';
import {buildDashboard} from '../src/dashboard.js';
import {ScanArchive} from '../src/scan-archive.js';
import type {WalletProfile} from '../src/wallet-profiles.js';
import type {WalletResearchSeedHint} from '../src/wallet-research-seeds.js';

function runtimeConfig(directory:string){return readConfig({WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',
  TOKEN_RANK_RESEARCH_ENABLED:'false',WALLET_HISTORY_DATABASE_PATH:join(directory,'history.sqlite'),
  ORDERS_DATABASE_PATH:join(directory,'orders.sqlite')});}

test('runtime imports pinned auxiliary seeds without inventing observed wallets or enabling entry',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'seed-runtime-')),runtime=createRuntime(runtimeConfig(directory));
  try {
    const status=runtime.walletResearchStatus();
    assert.equal(status.seedsError,undefined);
    assert.equal(runtime.walletHistory!.stats().researchSeeds?.totalAddresses,449);
    assert.equal(runtime.walletHistory!.listWallets().total,0);
    assert.equal(runtime.dashboardHome().entryMode,'off');
  } finally {await runtime.close();rmSync(directory,{recursive:true,force:true});}
});

test('auxiliary import failure remains visible while core research and entry settings remain intact',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'seed-runtime-failure-'));
  const original=WalletHistory.prototype.importResearchSeeds;
  WalletHistory.prototype.importResearchSeeds=()=>{throw new Error('PRIVATE_INPUT_SHOULD_NOT_ESCAPE');};
  let runtime:ReturnType<typeof createRuntime>|undefined;
  try {
    runtime=createRuntime(runtimeConfig(directory));
    assert.equal(runtime.walletResearchStatus().seedsError,'WALLET_RESEARCH_SEEDS_IMPORT_FAILED');
    assert.equal(runtime.walletHistory!.listWallets().total,0);
    assert.equal(runtime.dashboardHome().entryMode,'off');
  } finally {WalletHistory.prototype.importResearchSeeds=original;await runtime?.close();rmSync(directory,{recursive:true,force:true});}
});

test('profile responses add auxiliary hints without mutating identity, groups or persisted profile data',async()=>{
  const address='0x1111111111111111111111111111111111111111',password='separate-dashboard-seed-testing-token-1234';
  const profile:WalletProfile={chain:'bsc',address,version:1,computedAt:'2026-10-18T00:00:00.000Z',freshUntil:'2026-10-18T01:00:00.000Z',
    status:'current',source:'wallet_history',sampleOnly:true,ownership:'unknown',groups:[],
    metrics:{observedEvents:1,buyEvents:1,sellEvents:0,distinctTokens:1,associations:{leaders:0,distinctTokens:0,forwardTokens:0},chain:{transactions:0,transfers:0}},
    counterparties:[],limitations:[]};
  const hint:WalletResearchSeedHint={sourceId:'oooooyoung_evm',sourceUrl:'https://github.com/nopapername/oooooyoung',commit:'a'.repeat(40),sha256:'b'.repeat(64),
    labels:['外部自称KOL'],groups:['聪明钱'],verification:'unverified_external_list',scope:'research_hint_only',ownershipProven:false,qualifiesAsSmart:false};
  const before=JSON.stringify(profile),archive=new ScanArchive(':memory:');
  const server=buildDashboard(readConfig({DASHBOARD_ACCESS_TOKEN:password}),{archive,overview:()=>null,orders:()=>null,
    walletProfiles:{list:()=>({ready:true,total:1,items:[profile]}),get:(chain,a)=>chain==='bsc'&&a===address?profile:undefined},
    walletResearchHints:()=>[hint]});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/dashboard/api`,headers={'x-dashboard-access':password};
  try {
    assert.equal((await fetch(base+'/wallet-profiles')).status,401);
    assert.equal((await fetch(base+'/wallet-profiles',{method:'POST',headers})).status,405);
    const page=await(await fetch(base+'/wallet-profiles?limit=20',{headers})).json();
    const detail=await(await fetch(base+'/wallet-profiles/bsc/'+address,{headers})).json();
    for(const value of [page.items[0],detail]){
      assert.equal(value.ownership,'unknown');assert.deepEqual(value.groups,[]);
      assert.equal(value.researchSeeds[0].qualifiesAsSmart,false);
      assert.equal(value.researchSeeds[0].ownershipProven,false);
    }
    assert.equal((await fetch(base+'/wallet-profiles/robinhood/'+address,{headers})).status,404,'list membership alone cannot create a chain profile');
    assert.equal(JSON.stringify(profile),before,'display decoration never writes back into the cached profile');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));archive.close();}
});
