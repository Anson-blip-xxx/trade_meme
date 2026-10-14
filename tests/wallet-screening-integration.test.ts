import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {decide,evaluate,effectiveReport,mergeWalletSupport} from '../src/engine.js';
import {compactWalletScreening} from '../src/wallet-screening-summary.js';
import {ScanArchive} from '../src/scan-archive.js';
import {WalletSetupLedger} from '../src/wallet-setup-ledger.js';
import {buildDashboard} from '../src/dashboard.js';
import {unknown,type Check} from '../src/types.js';
import type {GmgnResearch} from '../src/research.js';
import type {WalletScreeningReport} from '../src/wallet-screening.js';
import {config,signal,now,pass,narrative,providers} from './helpers.js';

const stamp=(offset=0)=>new Date(now.getTime()+offset).toISOString();
const wallet='0x'+'2'.repeat(40);
function screening():WalletScreeningReport {
  return {version:1,token:signal().token,checkedAt:stamp(),validUntil:stamp(15_000),status:'supported',priorityScore:18,
    scope:'research_priority',ownership:'unknown',sampleOnly:true,reasons:[],setups:[{
      id:'fixture',route:'public_entry',wallet,leader:wallet,status:'supported',stage:'direct_entry',priorityScore:18,
      trigger:{chain:'bsc',wallet,tokenAddress:signal().token.address,txHash:'0x'+'3'.repeat(64),side:'buy',eventAt:stamp(-30_000),observedAt:stamp(-29_000),usd:'200',priceUsd:'1',source:'test'},
      reasons:['PUBLIC_ENTRY_FOLLOW_BUYS_OBSERVED'],counterEvidence:[],followers:2,ownership:'unknown',
      profit:{realizedProfitUsd:10_000,percentile:95,cohortSize:10,observedAt:stamp(-60_000),verification:'vendor_claim'},
    }]};
}
function research(flow:Check=unknown('SMART_LABELS_MISSING')):GmgnResearch {
  return {snapshot:{token:signal().token,fetchedAt:stamp(),diagnostics:[]},flow} as unknown as GmgnResearch;
}
function report(s=screening(),flow?:Check,safety=pass(),provenance=pass()) {
  const cfg=config();cfg.walletSupportRequired=true;
  return decide(signal(),stamp(),cfg,provenance,safety,narrative(),now,'live','fixture',research(flow),s);
}

test('profiled entry routes provide alternative flow while safety, origin, identity and age remain mandatory',()=>{
  for(const route of ['precursor','public_entry'] as const){const s=screening();s.setups[0].route=route;
    const r=report(s);assert.equal(r.decision,'BUY_CANDIDATE');assert.equal(r.policyVersion,'entry-gate-v8');
    assert.equal(r.flow?.facts.ownershipProven,false);assert.equal(r.validUntil,s.validUntil);
    assert.equal(effectiveReport(r,new Date(Date.parse(s.validUntil))).buyEligible,false);
    assert.equal(report(s,undefined,unknown('NO_SAFETY')).decision,'WATCH');
    assert.equal(report(s,undefined,pass(),unknown('NO_ORIGIN')).decision,'WATCH');
    assert.equal(report(s,undefined,{...pass(),status:'fail'}).decision,'REJECT');
    const n=narrative();n.facts.supplierAddressConflict={field:'data.history.ca_address',address:'0x'+'f'.repeat(40)};
    // Existing explicit identity veto must survive an otherwise supporting route.
    assert.equal(decide(signal(),stamp(),config(),pass(),pass(),n,now,'live','identity',research(),s).decision,'REJECT');
    const aged=signal({occurredAt:stamp(-601_000)});
    assert.equal(decide(aged,stamp(),config(),pass(),pass(),narrative(),now,'live','aged',research(),s).decision,'WATCH');
  }
  const fail={...pass(),status:'fail' as const,reasons:['FLOW_RISK']};assert.equal(mergeWalletSupport(fail,screening(),signal(),now),fail);
});

test('a qualified withdrawal removes prior smart-wallet support; unrelated low-profit or dust activity cannot veto it',()=>{
  const s=screening();s.status='watch';s.priorityScore=0;s.setups[0].status='withdrawn';s.setups[0].priorityScore=0;
  const blocked=report(s,pass());assert.equal(blocked.decision,'WATCH');assert.ok(blocked.reasons.includes('WALLET_SETUP_SUPPORT_WITHDRAWN'));
  for(const edit of [(v:WalletScreeningReport)=>{v.setups[0].trigger.usd='1';},(v:WalletScreeningReport)=>{v.setups[0].profit!.percentile=50;}]){
    const low=structuredClone(s);edit(low);assert.equal(report(low,pass()).decision,'BUY_CANDIDATE');
  }
  const other=structuredClone(screening().setups[0]);other.id='second-supported';s.setups.push(other);s.status='supported';
  assert.equal(report(s,pass()).decision,'BUY_CANDIDATE');
});

test('wrong-token, stale and future reports never provide profile support',()=>{
  for(const edit of [(s:WalletScreeningReport)=>{s.token.address='0x'+'a'.repeat(40);},
    (s:WalletScreeningReport)=>{s.validUntil=stamp();},(s:WalletScreeningReport)=>{s.checkedAt=stamp(1);}]){
    const s=screening();edit(s);assert.equal(report(s).decision,'WATCH');
  }
});

test('evaluator handles an unavailable local profile store and never calls the hook for demo or stale inputs',async()=>{
  const cfg=config();cfg.walletSupportRequired=true;const p=providers();let calls=0;
  p.walletScreening=async()=>{calls++;throw new Error('PRIVATE_ERROR');};
  const r=await evaluate(signal(),cfg,p,{now:()=>now});assert.equal(r.decision,'WATCH');
  assert.equal(r.walletScreening?.status,'unavailable');assert.ok(!JSON.stringify(r).includes('PRIVATE_ERROR'));assert.equal(calls,1);
  await evaluate(signal(),cfg,p,{now:()=>now,mode:'demo'});await evaluate(signal({occurredAt:stamp(-601_000)}),cfg,p,{now:()=>now});assert.equal(calls,1);
});

test('archived screening preserves decision evidence but excludes arbitrary provider payloads and future snapshots',()=>{
  const r=report();Object.assign(r.walletScreening!,{raw:'PRIVATE_VENDOR_BODY'});Object.assign(r.walletScreening!.setups[0],{raw:'PRIVATE_VENDOR_BODY'});
  const archive=new ScanArchive(':memory:',{now:()=>now});try{
    archive.capture({id:r.id,status:'completed',signal:r.signal,receivedAt:r.receivedAt,report:r});
    const stored=archive.get(r.id)!;assert.equal(stored.walletScreening?.setups[0].profit?.percentile,95);
    assert.ok(!JSON.stringify(stored).includes('PRIVATE_VENDOR_BODY'));
    r.walletScreening!.setups[0].profit!.percentile=0;
    assert.equal(archive.get(r.id)?.walletScreening?.setups[0].profit?.percentile,95);
    assert.equal(compactWalletScreening({...screening(),checkedAt:stamp(1)},r.signal.token,stamp()),undefined);
  }finally{archive.close();}
});

test('ledger dashboard is authenticated, read only, bound to token filters and rejects malformed selectors',async()=>{
  const cfg=config();cfg.dashboard.token='test-screening-dashboard-password';
  const archive=new ScanArchive(':memory:'),ledger=new WalletSetupLedger(':memory:',{now:()=>now});ledger.record(screening());
  const server=buildDashboard(cfg,{archive,overview:()=>({}),orders:()=>({}),walletScreening:ledger});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/dashboard/api/wallet-screening`,headers={'x-dashboard-access':cfg.dashboard.token};
  try{
    for(const url of [base,base+'/status'])assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(base,{method:'POST',headers})).status,405);
    for(const query of ['chain=eth','address='+signal().token.address,'chain=bsc&address=bad','limit=0','limit=101','limit=NaN'])
      assert.equal((await fetch(base+'?'+query,{headers})).status,400,query);
    const list=await (await fetch(base+'?chain=bsc&address='+signal().token.address,{headers})).json() as {items:unknown[]};assert.equal(list.items.length,1);
    const empty=await (await fetch(base+'?chain=robinhood&address='+signal().token.address,{headers})).json() as {items:unknown[]};assert.equal(empty.items.length,0);
    assert.equal((await fetch(base+'/status',{headers})).status,200);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));ledger.close();archive.close();}
});
