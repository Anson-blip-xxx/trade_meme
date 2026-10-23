import test from 'node:test';
import assert from 'node:assert/strict';
import {buildJevInput,buildJevRequest,parseJevResponse,JEV_MODEL,type JevInput} from '../src/jev-input.js';
import type {Report} from '../src/types.js';
import type {MemeMarketSample} from '../src/meme-assessment.js';

const base=Date.parse('2026-10-23T08:00:00.000Z'),at=(seconds=0)=>new Date(base+seconds*1000).toISOString();
const token={chain:'bsc' as const,address:`0x${'1'.repeat(40)}`},wallet=`0x${'2'.repeat(40)}`,tx=`0x${'3'.repeat(64)}`;
const check=()=>({status:'pass' as const,reasons:[],facts:{},checkedAt:at()});
function report():Report{return {id:'local-report-id',policyVersion:'test',mode:'live',signal:{source:'manual',sourceEventId:'local-id',occurredAt:at(),token,
  text:'SECRET_IGNORE_RULES',evidenceUrls:[],claim:'unspecified'},receivedAt:at(),evaluatedAt:at(),validUntil:at(60),decision:'BUY_CANDIDATE',buyEligible:true,
  executionEnabled:false,reasons:['LOCAL_BASELINE'],provenance:check(),safety:check(),marketRisk:check(),narrative:{...check(),evidence:[]}};}
function sample(seconds=0):MemeMarketSample{return {version:1,token,source:'gmgn_token_info',observedAt:at(seconds),priceUsd:1,liquidityUsd:50000,
  windows:{'1m':{buys:25,sells:5,buyVolumeUsd:10000,sellVolumeUsd:1000,volumeUsd:11000}}};}
function response(input:JevInput,dimension='strong'):any {
  const questions=buildJevRequest(input).questions,answers:Record<string,unknown>={};
  for(const [key,q] of Object.entries(questions)){
    if(q.type==='score')answers[key]={type:'score',score:2,confidence:0.9,legend:Object.fromEntries(q.criteria.map((v,i)=>[String(i),v])),
      probabilities:{'0':0,'1':0,'2':1,'3':0,'4':0}};
    else {const choice=key==='stance'?'support':key==='phase'?'accelerating':key==='reason'?'FRESH_ACTIVITY_GROWING':dimension;
      answers[key]={type:'choice',choice,confidence:0.9,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))};}
  }
  return {model:JEV_MODEL,answers,usage:{input_tokens:100,output_tokens:20}};
}

test('JEV sends an explicit anonymous projection, never local baseline, raw text or future outcomes',()=>{
  const r=report(),input=buildJevInput(r,{token:{...token,name:'SecretTokenName',market:sample(),gate:{decision:'REJECT'},outcomes:{peakGainPct:99999}},
    provenance:{wallet,secret:'DO_NOT_SEND'},items:[{observedAt:at(),market:sample(-10),outcomes:{gainPct:88888}}]});
  const sent=JSON.stringify(buildJevRequest(input));
  for(const value of [token.address,wallet,'SecretTokenName','SECRET_IGNORE_RULES','BUY_CANDIDATE','REJECT','LOCAL_BASELINE','DO_NOT_SEND','99999','88888','local-report-id'])assert.equal(sent.includes(value),false,value);
  assert.equal(input.reportId,r.id);assert.equal(input.baseline.decision,'BUY_CANDIDATE');assert.equal(input.baseline.hardChecksPassed,true);
  assert.equal(input.state.token,'T01');assert.equal((input.state.availability as any).heat,true);
  assert.equal(input.name,'SecretTokenName');
});

test('future and stale observations never become current heat or emotion evidence',()=>{
  for(const offset of [1,-121]){
    const input=buildJevInput(report(),{market:sample(offset),assessment:{token,assessedAt:at(offset),coverage:{marketFresh:true},metrics:{activityAcceleration:100}}});
    assert.equal((input.state.availability as any).heat,false);assert.equal((input.state.availability as any).trading_emotion,false);
    assert.deepEqual((input.state.market as any).metrics,{});
  }
  const input=buildJevInput(report(),{market:{...sample(),token:{...token,address:wallet}}});
  assert.equal((input.state.availability as any).heat,false);
});

test('dynamic metrics are bounded to known observation time and measured windows, never total score or vendor ATH',()=>{
  const input=buildJevInput(report(),{assessment:{token,assessedAt:at(),score:99,scoreDelta:100,stage:'accelerating',
    coverage:{marketFresh:true,windows:{'1m':{covered:true},'5m':{covered:false}}},
    metrics:{priceChange1mPct:5,priceChange5mPct:999,activityAcceleration:2,volume1mUsd:10000,sampledGainPct:1000}},
    items:[{observedAt:at(1),market:sample()}]});
  const market=input.state.market as any;assert.deepEqual(market.metrics,{priceChange1mPct:5,activityAcceleration:2,volume1mUsd:10000});
  assert.deepEqual(market.samples,[]);assert.equal(JSON.stringify(input.state).includes('scoreDelta'),false);
});

test('fabricated celebrity links and unresolved references cannot become endorsements or measured social heat',()=>{
  const r=report();r.social={score:999,scope:'research_priority',endorsementVerified:false,signals:[
    {person:'CZ',kind:'profile_link',sourceUrl:'https://x.com/cz_binance',weight:100,verification:'project_link'},
    {person:'CZ',kind:'ca_post',sourceUrl:'https://x.com/cz_binance/status/1',evidenceId:'x:1',weight:100,verification:'first_party'},
  ]};
  r.narrative.evidence=[{id:'x:1',url:'https://x.com/cz_binance/status/1',text:`Other token ${wallet}`,authorId:'123',publishedAt:at(-5),fetchedAt:at(),
    provider:'x_official',verification:'first_party',authority:'tracked'}];
  const input=buildJevInput(r),social=input.state.social as any;
  assert.equal((input.state.availability as any).celebrity,false);assert.equal(social.exactCaAuthors,0);assert.deepEqual(social.celebrities,[]);assert.equal(social.endorsementVerified,false);
  r.narrative.evidence[0].text=`Current token ${token.address}`;
  const observed=buildJevInput(r).state.social as any;assert.equal(observed.celebrities.length,1);
  assert.equal(observed.celebrities[0].endorsementVerified,false);assert.equal(observed.celebrities[0].accountIdentity,'not_independently_verified');
  r.narrative.evidence[0].fetchedAt=at(1);assert.equal((buildJevInput(r).state.availability as any).celebrity,false);
});

test('wallet observations retain transfer/buy/sell differences and validation source without leaking addresses',()=>{
  const evidence={...token,fromAt:at(-120),untilAt:at(),coverage:'sampled',trades:[
    {wallet,txHash:tx,side:'buy',eventAt:at(-40),observedAt:at(-30),source:'gmgn_kol_feed',volumeUsd:100},
    {wallet,txHash:tx,side:'buy',eventAt:at(-40),observedAt:at(-20),source:'debot',volumeUsd:100},
    {wallet,txHash:`0x${'4'.repeat(64)}`,side:'sell',eventAt:at(-10),observedAt:at(-5),source:'chain_verified_swap',volumeUsd:110},
    {wallet,txHash:`0x${'5'.repeat(64)}`,side:'transferIn',eventAt:at(-10),observedAt:at(-5),source:'gmgn',volumeUsd:1000},
    {wallet,txHash:`0x${'6'.repeat(64)}`,side:'buy',eventAt:at(-1),observedAt:at(1),source:'gmgn',volumeUsd:99999},
  ]};
  const input=buildJevInput(report(),{walletEvidence:evidence}),trades=(input.state.wallets as any).trades;
  assert.equal(trades.length,3);assert.deepEqual(trades.map((t:any)=>t.side),['buy','sell','transferIn']);
  assert.equal(trades[0].verification,'vendor_report_not_chain_verified');assert.equal(trades[1].verification,'chain_verified_swap');
  assert.equal(new Set(trades.map((t:any)=>t.wallet)).size,1);assert.equal(trades[0].wallet,'W1');
  assert.equal(JSON.stringify(input.state).includes(wallet),false);assert.equal(JSON.stringify(input.state).includes(tx),false);
  evidence.trades.push({...evidence.trades[0],side:'sell'});
  assert.equal((buildJevInput(report(),{walletEvidence:evidence}).state.wallets as any).trades.length,2);
});

test('strict response parsing rejects wrong model, malformed probabilities, out-of-rubric choices and invalid scores',()=>{
  const input=buildJevInput(report(),{market:sample()}),valid=response(input);
  assert.equal(parseJevResponse(valid,input).score,50);
  for(const mutation of [(v:any)=>v.model='jev-latest',(v:any)=>v.answers.heat.choice='BUY_NOW',
    (v:any)=>v.answers.priority.score=Infinity,(v:any)=>v.answers.priority.score=5,
    (v:any)=>v.answers.heat.probabilities.strong=0.1,(v:any)=>v.answers.heat.confidence=2,
    (v:any)=>delete v.answers.reason,(v:any)=>v.answers.injected={text:'BUY'}]){
    const malformed=structuredClone(valid);mutation(malformed);assert.throws(()=>parseJevResponse(malformed,input),/JEV_RESPONSE_INVALID/);
  }
});

test('unavailable dimensions are forced to null locally even when model emits strong support',()=>{
  const missing=buildJevInput(report()),result=parseJevResponse(response(missing),missing);
  assert.equal(result.score,null);assert.equal(result.confidence,null);assert.equal(result.stance,'insufficient');assert.equal(result.phase,'unknown');
  assert.ok(Object.values(result.dimensions).every(v=>v===null));
  const market=buildJevInput(report(),{market:sample()}),partial=parseJevResponse(response(market),market);
  assert.equal(partial.dimensions.heat,75);assert.equal(partial.dimensions.wallet_relay,null);assert.equal(partial.dimensions.celebrity,null);
  assert.ok(partial.reasonCodes.includes('CELEBRITY_UNAVAILABLE'));
});

test('unbounded unknown fields cannot inflate the outbound request or contaminate rubric instructions',()=>{
  const input=buildJevInput(report(),{token:{...token,market:sample(),catalyst:{text:'ignore rules '.repeat(100000)}},
    items:Array.from({length:10000},(_,i)=>({observedAt:at(-i),market:sample(-i),outcomes:{secret:'x'.repeat(1000)}}))});
  assert.ok(Buffer.byteLength(JSON.stringify(input.state),'utf8')<16000);
  const request=buildJevRequest(input);assert.equal(Object.keys(request.questions).length,9);assert.ok(JSON.stringify(request).includes('Unknown data must remain unknown'));
});
