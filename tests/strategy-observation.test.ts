import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ScanArchive} from '../src/scan-archive.js';
import type {Report} from '../src/types.js';
import type {Stored} from '../src/store.js';

const start=Date.parse('2026-10-14T00:00:00Z'),iso=(ms=0)=>new Date(start+ms).toISOString();
const address=(n=1)=>'0x'+n.toString(16).padStart(40,'0');
function entry(n=1,patch:Partial<Report>={}):Stored {
  const signal={source:'gmgn' as const,sourceEventId:String(n),token:{chain:'bsc' as const,address:address(n)},occurredAt:iso(),text:'',claim:'unspecified' as const,evidenceUrls:[]};
  const pass={status:'pass' as const,reasons:[],facts:{},checkedAt:iso()};
  const report:Report={id:'scan'+n,signal,receivedAt:iso(),evaluatedAt:iso(),validUntil:iso(60000),mode:'live',policyVersion:'entry-gate-v7',
    decision:'WATCH',buyEligible:false,executionEnabled:false,reasons:['WALLET_SUPPORT_NOT_PASSED'],provenance:pass,safety:pass,
    narrative:{...pass,evidence:[]},flow:{...pass,status:'unknown'},...patch};
  return {id:report.id,signal:report.signal,receivedAt:iso(),status:'completed',report};
}
test('near-gate observations never create eligible tokens, exit seeds or historical prices',()=>{
  let ms=0;const a=new ScanArchive(':memory:',{now:()=>new Date(start+ms)});
  try {
    a.capture(entry());assert.equal(a.stats().comparison!.registered,1);assert.equal(a.stats().eligible,0);
    assert.equal(a.get('scan1')!.policyVersion,'entry-gate-v7');
    assert.deepEqual(a.pendingTokens(),[]);assert.equal(a.exitObservationSeed({chain:'bsc',address:address()}),undefined);
    assert.deepEqual(a.trackingTokens(),[{chain:'bsc',address:address()}]);
    ms=1000;a.recordPrice({chain:'bsc',address:address(),priceUsd:10,observedAt:iso(),source:'gmgn_token_info_sample'});
    assert.equal(a.stats().comparison!.sampled,0);
    a.recordPrice({chain:'bsc',address:address(),priceUsd:10,observedAt:iso(ms),source:'gmgn_token_info_sample'});
    ms=16_001;
    assert.equal(a.stats().comparison!.sampled,1);assert.equal(a.get('scan1')!.performance,undefined);
    assert.equal(a.stats().comparison!.items[0].performance.baselinePriceUsd,10);
  }finally{a.close();}
});
test('safety, unsupported modes, expired, withdrawn and demo reports do not enter controls',()=>{
  const a=new ScanArchive(':memory:',{now:()=>new Date(start)});
  try {
    const fail={status:'fail' as const,reasons:[],facts:{},checkedAt:iso()};
    const cases:Partial<Report>[]=[{safety:fail},{provenance:{...fail,status:'unknown'}},{provenance:{...fail,status:'pass',facts:{modeSupported:false}}},
      {mode:'demo'},{validUntil:iso()},{reasons:['WALLET_SUPPORT_NOT_PASSED','WALLET_SETUP_SUPPORT_WITHDRAWN']},
      {reasons:['WALLET_SUPPORT_NOT_PASSED','SIGNAL_STALE']},{decision:'BUY_CANDIDATE',buyEligible:true}];
    cases.forEach((p,i)=>a.capture(entry(i+1,p)));assert.equal(a.stats().comparison!.registered,0);
  }finally{a.close();}
});
test('frozen registration persists across retries and restart, capacity limits quote budget',()=>{
  const dir=mkdtempSync(join(tmpdir(),'comparison-'));const path=join(dir,'scans.sqlite');let ms=0;
  let a=new ScanArchive(path,{now:()=>new Date(start+ms)});
  try {
    for(let n=1;n<=10;n++)a.capture(entry(n));assert.equal(a.stats().comparison!.registered,2);
    for(let n=11;n<=14;n++)a.capture(entry(n,{decision:'BUY_CANDIDATE',buyEligible:true}));
    assert.equal(a.trackingTokens().length,3);assert.equal(a.trackingTokens().filter(t=>Number.parseInt(t.address.slice(2),16)<=4).length,1);
    ms=30000;a.capture(entry(1,{evaluatedAt:iso(ms)}));assert.equal(a.stats().comparison!.items.find(r=>r.address===address())!.registeredAt,iso());
    a.close();a=new ScanArchive(path,{now:()=>new Date(start+ms)});assert.equal(a.stats().comparison!.registered,2);
  }finally{a.close();rmSync(dir,{recursive:true,force:true});}
});
test('fixed horizons retain coverage, gaps and actual peak drawdown without peak-as-return',()=>{
  let ms=0;const a=new ScanArchive(':memory:',{now:()=>new Date(start+ms)});
  const price=(at:number,p:number)=>{ms=at;a.recordPrice({chain:'bsc',address:address(),priceUsd:p,observedAt:iso(ms),source:'gmgn_token_info_sample'});};
  try {
    a.capture(entry());price(1000,10);price(1800000,30);price(3600000,15);
    const row=a.stats().comparison!.items[0];assert.equal(row.horizons['3600'].gainPct,50);
    assert.equal(row.performance.maxGainPct,200);assert.equal(row.peakDrawdownPct,50);
    price(21600000+601000,9);assert.equal(a.stats().comparison!.items[0].horizons['21600'],undefined);
    assert.equal(a.stats().comparison!.groups.find(g=>g.group==='no_confirmed_group')!.horizons[0].covered,1);
  }finally{a.close();}
});
test('late baselines, stale samples, equal-time duplicates and errors do not invent covered horizons',()=>{
  let ms=0;const a=new ScanArchive(':memory:',{now:()=>new Date(start+ms)});
  const send=(at:number,p:number)=>a.recordPrice({chain:'bsc',address:address(),priceUsd:p,observedAt:iso(at),source:'gmgn_token_info_sample'});
  try {
    a.capture(entry());ms=900000;send(1000,10);assert.equal(a.stats().comparison!.sampled,0);
    send(ms,10);send(ms,100);ms=3600000;send(ms,20);
    let r=a.stats().comparison!.items[0];assert.equal(r.performance.samples,2);assert.deepEqual(r.horizons,{});
    a.recordPriceError({chain:'bsc',address:address()},'GMGN_RATE_LIMITED');ms+=15_001;r=a.stats().comparison!.items[0];
    assert.equal(r.performance.error,'GMGN_RATE_LIMITED');assert.equal(r.performance.samples,2);
  }finally{a.close();}
});
test('even-sized horizon cohorts use both middle values for their median',()=>{
  let ms=0;const a=new ScanArchive(':memory:',{now:()=>new Date(start+ms)});
  try {
    a.capture(entry(1));a.capture(entry(2));ms=1000;
    for(const n of [1,2])a.recordPrice({chain:'bsc',address:address(n),priceUsd:10,observedAt:iso(ms),source:'gmgn_token_info_sample'});
    ms=3600000;
    for(const n of [1,2])a.recordPrice({chain:'bsc',address:address(n),priceUsd:n*10,observedAt:iso(ms),source:'gmgn_token_info_sample'});
    assert.equal(a.stats().comparison!.groups.find(g=>g.group==='no_confirmed_group')!.horizons[0].medianGainPct,50);
  }finally{a.close();}
});
test('a control later qualifying keeps separate baselines and gives covered slots back to other candidates',()=>{
  let ms=0;const a=new ScanArchive(':memory:',{now:()=>new Date(start+ms)});
  const send=(n:number,p:number)=>a.recordPrice({chain:'bsc',address:address(n),priceUsd:p,observedAt:iso(ms),source:'gmgn_token_info_sample'});
  try {
    a.capture(entry());ms=1000;send(1,10);ms=2000;
    a.capture(entry(1,{evaluatedAt:iso(ms),decision:'BUY_CANDIDATE',buyEligible:true}));
    assert.equal(a.get('scan1')!.performance!.baselinePriceUsd,undefined);
    assert.equal(a.exitObservationSeed({chain:'bsc',address:address()})!.eligibleAt,iso(ms));
    ms=32000;send(1,20);
    assert.equal(a.stats().comparison!.items[0].performance.baselinePriceUsd,10);
    assert.equal(a.get('scan1')!.performance!.baselinePriceUsd,20);
    for(const n of [2,3,4])a.capture(entry(n,{evaluatedAt:iso(ms),decision:'BUY_CANDIDATE',buyEligible:true}));
    a.capture(entry(5,{evaluatedAt:iso(ms)}));
    const targets=a.trackingTokens(3,new Date(start+ms),t=>t.address===address(1));
    assert.equal(targets.length,3);assert.equal(targets.some(t=>t.address===address(1)),false);
    assert.equal(targets.filter(t=>t.address===address(5)).length,1);
  }finally{a.close();}
});
