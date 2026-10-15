import test from 'node:test';
import assert from 'node:assert/strict';
import {ScanArchive} from '../src/scan-archive.js';
import type {Report} from '../src/types.js';
import type {Stored} from '../src/store.js';

const start=Date.parse('2026-10-15T00:00:00Z'),iso=(ms=0)=>new Date(start+ms).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
function entry(n:number,decision:Report['decision']='WATCH',ms=0):Stored {
  const signal={source:'debot' as const,sourceEventId:String(n),token:{chain:'bsc' as const,address:address(n)},
    occurredAt:iso(ms),text:'',claim:'unspecified' as const,evidenceUrls:[]};
  const check={status:'pass' as const,reasons:[],facts:{},checkedAt:iso(ms)};
  const report:Report={id:'followup'+n,signal,receivedAt:iso(ms),evaluatedAt:iso(ms),validUntil:iso(ms+60000),
    mode:'live',policyVersion:'test-policy',decision,buyEligible:decision==='BUY_CANDIDATE',executionEnabled:false,
    reasons:decision==='WATCH'?['WALLET_SUPPORT_NOT_PASSED']:[],safety:check,provenance:check,
    flow:{...check,status:'unknown'},narrative:{...check,evidence:[]}};
  return {id:report.id,signal,receivedAt:report.receivedAt,status:'completed',report};
}
test('followup wiring reserves candidate requests, borrows idle slots, deduplicates and never creates entry eligibility',()=>{
  let ms=0;const archive=new ScanArchive(':memory:',{followupEnabled:true,now:()=>new Date(start+ms)});
  try {
    for(let n=1;n<=3;n++)archive.capture(entry(n));
    for(let n=4;n<=6;n++)archive.capture(entry(n,'REJECT'));
    assert.equal(archive.trackingTokens().length,3,'spare quote slots are used by observations');
    assert.equal(archive.streamingTokens().length,6);
    assert.equal(archive.stats().comparison!.registered,0,'no new redundant legacy controls');
    assert.equal(archive.pendingTokens().length,0);
    assert.equal(archive.exitObservationSeed({chain:'bsc',address:address(1)}),undefined);
    for(let n=7;n<=10;n++)archive.capture(entry(n,'BUY_CANDIDATE'));
    let selected=archive.trackingTokens();
    assert.equal(selected.length,3);
    assert.equal(selected.filter(t=>Number.parseInt(t.address.slice(2),16)>=7).length,2);
    const control=selected.find(t=>Number.parseInt(t.address.slice(2),16)<7)!;
    ms=1000;archive.recordPriceError(control,'GMGN_RATE_LIMITED');
    selected=archive.trackingTokens();
    assert.equal(selected.some(t=>t.address===control.address),false,'failed controls rotate rather than block the queue');
    const covered=new Set([address(7),address(8),address(9),address(10)]);
    assert.equal(archive.trackingTokens(3,new Date(start+ms),t=>covered.has(t.address)).length,3);
    assert.equal(new Set(archive.streamingTokens().map(t=>t.chain+':'+t.address)).size,10);
  }finally{archive.close();}
});
test('followup has independent forward baselines and preserves first WATCH when a token later qualifies',()=>{
  let ms=0;const archive=new ScanArchive(':memory:',{followupEnabled:true,now:()=>new Date(start+ms)});
  const token={chain:'bsc' as const,address:address(1)};
  try {
    archive.capture(entry(1));ms=1000;
    archive.recordPrice({...token,priceUsd:10,observedAt:iso(ms),source:'gmgn_token_info_sample'});
    assert.equal(archive.followupDetail(token)!.performance.baselinePriceUsd,10);
    assert.equal(archive.get('followup1')!.performance,undefined);
    ms=2000;archive.capture(entry(1,'BUY_CANDIDATE',ms));
    ms=32000;archive.recordPrice({...token,priceUsd:20,observedAt:iso(ms),source:'gmgn_token_info_sample'});
    assert.equal(archive.followupDetail(token)!.initial.decision,'WATCH');
    assert.equal(archive.followupDetail(token)!.performance.baselinePriceUsd,10);
    assert.equal(archive.get('followup1')!.performance!.baselinePriceUsd,20);
    assert.equal(archive.exitObservationSeed(token)!.eligibleAt,iso(2000));
    assert.equal(archive.trackingTokens().filter(t=>t.address===token.address).length,1);
  }finally{archive.close();}
});
test('selected followups survive deletion of short-lived scan summaries and request evidence only for new samples',()=>{
  let ms=0;const archive=new ScanArchive(':memory:',{followupEnabled:true,maxEntries:1,now:()=>new Date(start+ms)});
  const token={chain:'bsc' as const,address:address(1)};
  const price={...token,priceUsd:1,observedAt:iso(1000),source:'gmgn_token_info_sample'};
  try {
    archive.capture(entry(1));archive.capture(entry(2,'REJECT'));
    assert.equal(archive.stats().total,1);assert.ok(archive.followupDetail(token));
    ms=1000;assert.deepEqual(archive.followupEvidenceWindow(price),{fromAt:iso(),untilAt:iso(1000)});
    archive.recordPrice(price);assert.equal(archive.followupEvidenceWindow(price),undefined);
    ms=2000;assert.equal(archive.followupEvidenceWindow({...price,observedAt:iso(ms)}),undefined);
    ms=3600000;archive.recordPrice({...price,priceUsd:2,observedAt:iso(ms)});
    assert.equal(archive.followupDetail(token)!.horizons['3600'].gainPct,100);
    assert.equal(archive.get('followup1'),undefined);
  }finally{archive.close();}
});

test('new candidates evict observation-only subscription targets when per-chain pool capacity is full',()=>{
  const archive=new ScanArchive(':memory:',{followupEnabled:true,now:()=>new Date(start)});
  try {
    archive.capture(entry(1));archive.capture(entry(2,'REJECT'));
    assert.equal(archive.streamingTokens(new Date(start),1).length,1);
    archive.capture(entry(3,'BUY_CANDIDATE'));
    assert.deepEqual(archive.streamingTokens(new Date(start),1),[{chain:'bsc',address:address(3)}]);
    assert.equal(archive.trackingTokens().length,3,'evicted controls remain available to the bounded HTTP sampler');
  }finally{archive.close();}
});
