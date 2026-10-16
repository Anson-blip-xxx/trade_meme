import test from 'node:test';
import assert from 'node:assert/strict';
import {ScanArchive,type ScanPrice,type ScanToken} from '../src/scan-archive.js';
import {MarketPriceRouter} from '../src/market-price-router.js';
import type {Report} from '../src/types.js';
import type {Stored} from '../src/store.js';

const start=Date.parse('2026-10-14T00:00:00.000Z'),iso=(ms=0)=>new Date(start+ms).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
function entry(n:number,decision:'WATCH'|'REJECT',chain:ScanToken['chain']='bsc'):Stored {
  const signal={source:'debot' as const,sourceEventId:String(n),token:{chain,address:address(n)},
    occurredAt:iso(),text:'',claim:'unspecified' as const,evidenceUrls:[]};
  const pass={status:'pass' as const,reasons:[],facts:{},checkedAt:iso()};
  const report:Report={id:'scan'+n,signal,receivedAt:iso(),evaluatedAt:iso(),validUntil:iso(60000),mode:'live',policyVersion:'gate-sample',
    decision,buyEligible:false,executionEnabled:false,reasons:['WALLET_SUPPORT_NOT_PASSED'],provenance:pass,safety:pass,
    narrative:{...pass,evidence:[]},flow:{...pass,status:'unknown'}};
  return {id:report.id,signal,receivedAt:iso(),status:'completed',report};
}
const sources=['dexscreener_token_pairs_sample','ave_price_stream_sample','debot_token_info_sample'] as const;
const cases=[...sources.map(source=>({source,chain:'bsc' as const})),...sources.slice(1).map(source=>({source,chain:'robinhood' as const}))];
for(const {source,chain} of cases)test(`ScanArchive ${chain} WATCH/REJECT followups and legacy comparison consume router ${source} and clear prior errors`,async()=>{
  let elapsed=0,value=10;const now=()=>new Date(start+elapsed),tokens:ScanToken[]=[1,2].map(n=>({chain,address:address(n)})),foreignChain=chain==='bsc'?'robinhood':'bsc';
  const archive=new ScanArchive(':memory:',{now,followupEnabled:true}),legacy=new ScanArchive(':memory:',{now});
  const router=new MarketPriceRouter({now,maxGmgnPerBatch:0,fetcher:async input=>{
    const url=new URL(String(input));
    if(url.hostname==='api.dexscreener.com')return Response.json(source==='dexscreener_token_pairs_sample'?tokens.map(t=>({chainId:t.chain,
      baseToken:{address:t.address},pairAddress:address(99),priceUsd:String(value),liquidity:{usd:10000}})):[]);
    if(url.hostname==='debot.ai'&&source==='debot_token_info_sample')return Response.json({code:0,data:{
      meta:{chain:url.searchParams.get('chain'),address:url.searchParams.get('token')},market:{price:value}}});
    return Response.json([]);
  }});
  const publish=async()=>{
    if(source==='ave_price_stream_sample')assert.equal(router.ingestAvePriceFrame({result:{status:'ok',data:{event:'pricev2',prices:tokens.map(t=>({
      chain:t.chain,token:t.address,target_token:t.address,pair:address(99),is_main_pair:true,uprice:value,time:(start+elapsed)/1000}))}}},iso(elapsed)),2);
    const windows:{fromAt:string;untilAt:string}[]=[];
    const result=await router.read(tokens,{onSample:sample=>{
      assert.equal(sample.source,source);const window=archive.followupEvidenceWindow(sample);assert.ok(window);windows.push(window);
      archive.recordPrice(sample);legacy.recordPrice(sample);
    }});
    assert.equal(result.samples.length,2);assert.equal(windows.length,2);
    for(const window of windows)assert.deepEqual(window,{fromAt:iso(),untilAt:iso(elapsed)});
  };
  try{
    archive.capture(entry(1,'WATCH',chain));archive.capture(entry(2,'REJECT',chain));legacy.capture(entry(1,'WATCH',chain));
    elapsed=1000;for(const token of tokens){archive.recordPriceError(token,'PRICE_NO_FRESH_SOURCE');legacy.recordPriceError(token,'PRICE_NO_FRESH_SOURCE');}
    assert.equal(archive.followupDetail(tokens[0])!.performance.error,'PRICE_NO_FRESH_SOURCE');
    assert.equal(archive.followupDetail(tokens[1])!.performance.error,'PRICE_NO_FRESH_SOURCE');
    assert.equal(legacy.stats().comparison!.items[0].performance.error,'PRICE_NO_FRESH_SOURCE');
    elapsed=2000;await publish();
    for(const token of tokens){const p=archive.followupDetail(token)!.performance;
      assert.equal(p.samples,1);assert.equal(p.status,'tracking');assert.equal(p.source,source);assert.equal(p.latestAt,iso(elapsed));assert.equal(p.error,undefined);}
    elapsed=32000;for(const token of tokens){archive.recordPriceError(token,'PRICE_NO_FRESH_SOURCE');legacy.recordPriceError(token,'PRICE_NO_FRESH_SOURCE');}
    elapsed=33000;value=15;await publish();
    for(const token of tokens){const followup=archive.followupDetail(token)!,p=followup.performance;
      assert.equal(p.samples,2);assert.equal(p.source,source);assert.equal(p.latestPriceUsd,15);assert.equal(p.latestAt,iso(33000));assert.equal(p.error,undefined);
      assert.equal(followup.initial.buyEligible,false);assert.ok(['WATCH','REJECT'].includes(followup.initial.decision));}
    const comparison=legacy.stats().comparison!.items[0].performance;
    assert.equal(comparison.samples,2);assert.equal(comparison.source,source);assert.equal(comparison.latestPriceUsd,15);assert.equal(comparison.error,undefined);
    assert.equal(archive.stats().eligible,0);assert.equal(legacy.stats().eligible,0);
    // Each consumer still rejects stale prices, foreign-chain identities, and obsolete/untrusted source labels.
    elapsed=200000;
    const send=(patch:Partial<ScanPrice>)=>{const p:ScanPrice={...tokens[0],priceUsd:999,observedAt:iso(elapsed),source,...patch};archive.recordPrice(p);legacy.recordPrice(p);return p;};
    send({observedAt:iso(34000)});send({chain:foreignChain});send({source:'debot_price_stream_sample'});send({source:'historical_ath'});send({observedAt:iso(elapsed+1)});
    assert.equal(archive.followupEvidenceWindow({...tokens[0],chain:foreignChain,priceUsd:999,observedAt:iso(elapsed),source}),undefined);
    assert.equal(archive.followupDetail(tokens[0])!.performance.samples,2);assert.equal(legacy.stats().comparison!.items[0].performance.samples,2);
    elapsed=87_000_001;send({});
    assert.equal(archive.followupEvidenceWindow({...tokens[0],priceUsd:999,observedAt:iso(elapsed),source}),undefined);
    assert.equal(archive.followupDetail(tokens[0])!.performance.samples,2);assert.equal(archive.followupDetail(tokens[0])!.performance.status,'ended');
    assert.equal(legacy.stats().comparison!.items[0].performance.samples,2);
  }finally{router.close();archive.close();legacy.close();}
});
