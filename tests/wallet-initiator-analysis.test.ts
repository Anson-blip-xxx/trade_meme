import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeWalletInitiator,type AnalyzeWalletInitiatorInput,type GmgnMarketFirstSeen,
} from '../src/wallet-initiator-analysis.js';
import type {WalletTradeObservation} from '../src/wallet-history.js';

const epoch=Date.parse('2026-11-04T00:00:00Z'),iso=(seconds:number)=>new Date(epoch+seconds*1000).toISOString();
const addr=(id:number)=>'0x'+id.toString(16).padStart(40,'0'),tx=(id:number)=>'0x'+id.toString(16).padStart(64,'0');
const wallet=addr(1);

function trade(token:number,when:number,patch:Partial<WalletTradeObservation>={}):WalletTradeObservation {
  return {chain:'bsc',wallet,tokenAddress:addr(token),txHash:tx(token*100+(patch.side==='sell'?2:1)),side:'buy',
    eventAt:iso(when),observedAt:iso(when+1),source:'gmgn_wallet_activity',...patch};
}

function market(token:number,when:number,patch:Partial<GmgnMarketFirstSeen>={}):GmgnMarketFirstSeen {
  return {id:`gmgn:first:${token}`,source:'gmgn_market_discovery',kind:'first_seen',chain:'bsc',tokenAddress:addr(token),
    firstSeenLowerBound:iso(when-10),firstSeenUpperBound:iso(when),feed:'trenches',window:'lifecycle',leftCensored:false,...patch};
}

function fixture(lags:number[],options:{retrospective?:boolean;asOf?:number}={}):AnalyzeWalletInitiatorInput {
  const trades=lags.map((lag,index)=>trade(100+index,1000+index*100+lag,
    options.retrospective&&lag<0?{observedAt:iso(1200+index*100)}:{}));
  return {chain:'bsc',wallet,asOf:iso(options.asOf??500_000),trades,
    marketFirstSeen:lags.map((_,index)=>market(100+index,1000+index*100))};
}

test('one early token is only an initiator candidate with fixed research safety boundaries',()=>{
  const result=analyzeWalletInitiator(fixture([-20]));
  assert.equal(result.classification,'candidate');assert.equal(result.directionalTokens.pre,1);assert.equal(result.preShare,1);
  assert.equal(result.sampleOnly,true);assert.equal(result.ownership,'unknown');assert.equal(result.tradingEnabled,false);
  assert.equal(result.dumpAssessment,'unknown');assert.equal(result.qualification,undefined);assert.equal('confidence' in result,false);
});

test('three retrospective early buys form a precursor but not a visible start',()=>{
  const result=analyzeWalletInitiator(fixture([-20,-30,-40],{retrospective:true}));
  assert.equal(result.classification,'precursor');assert.equal(result.prospectivePreTokens,0);assert.equal(result.preShare,1);
  assert.equal(result.qualification?.classification,'precursor');
  assert.ok(result.screeningEvidence.every(row=>row.direction==='pre'&&!row.prospective));
});

test('prospective early buys remain precursor without frozen peer follow-through evidence',()=>{
  const result=analyzeWalletInitiator(fixture([-20,-30,-40]));
  assert.equal(result.classification,'precursor');assert.equal(result.prospectivePreTokens,3);
  assert.equal(result.qualification?.evidence.length,3);assert.equal(result.qualification?.knownAt,result.computedAt);
  assert.ok(result.limitations.some(text=>text.includes('不会产出 visible_start')));
  assert.ok(result.limitations.some(text=>text.includes('不能证明钱包身份')));
});

test('repeated post-first-seen buys are follower timing while two directions each are mixed',()=>{
  const follower=analyzeWalletInitiator(fixture([20,30,40]));
  assert.equal(follower.classification,'follower');assert.equal(follower.followShare,1);assert.equal(follower.qualification?.classification,'follower');
  const mixed=analyzeWalletInitiator(fixture([-20,-30,20,30]));
  assert.equal(mixed.classification,'mixed');assert.equal(mixed.preShare,0.5);assert.equal(mixed.followShare,0.5);
});

test('all opposing tokens remain in the denominator instead of cherry-picking three early buys',()=>{
  const result=analyzeWalletInitiator(fixture([-20,-30,-40,...Array.from({length:20},()=>15)]));
  assert.equal(result.classification,'follower');assert.equal(result.matchedTokens,23);assert.equal(result.preShare,3/23);
  assert.equal(result.followShare,20/23);assert.ok(result.evidence.some(row=>row.direction==='pre'));
  assert.ok(result.evidence.some(row=>row.direction==='post'));assert.ok(result.counterEvidence.some(text=>text.includes('持续跟随')));
});

test('inclusive two-second ties, left-censored first-seen and over-24h gaps are counterevidence',()=>{
  const atThreshold=fixture([-20,-30,-40,-10]);
  let result=analyzeWalletInitiator(atThreshold);
  assert.equal(result.directionalTokens.ambiguous,1);assert.equal(result.preShare,0.75);assert.equal(result.classification,'precursor');
  const diluted=fixture([-20,-30,-40,-10,2]);result=analyzeWalletInitiator(diluted);
  assert.equal(result.preShare,0.6);assert.equal(result.classification,'candidate');
  const censored=fixture([-20,-30,-40]);censored.marketFirstSeen=censored.marketFirstSeen.map(row=>({...row,leftCensored:true}));
  result=analyzeWalletInitiator(censored);assert.equal(result.classification,'insufficient');assert.equal(result.directionalTokens.ambiguous,3);
  const legacy=fixture([-20]);legacy.marketFirstSeen=legacy.marketFirstSeen.map(row=>({...row,firstSeenLowerBound:undefined,leftCensored:undefined}));
  result=analyzeWalletInitiator(legacy);assert.equal(result.directionalTokens.ambiguous,1);
  assert.equal(result.screeningEvidence[0].marketFirstSeen?.leftCensored,true);
  const outside=fixture([-20,-30,-40,-86_411]);result=analyzeWalletInitiator(outside);
  assert.equal(result.directionalTokens.outsideWindow,1);assert.equal(result.preShare,0.75);
});

test('an earlier legacy feed observation prevents a later bounded feed from inventing prospective evidence',()=>{
  const input=fixture([-20,-30,-40]);
  input.marketFirstSeen=[...input.marketFirstSeen,...input.marketFirstSeen.map((row,index)=>({
    ...row,id:`legacy:${index}`,feed:'trenches' as const,firstSeenLowerBound:undefined,
    firstSeenUpperBound:iso(900+index*100),leftCensored:undefined,
  }))];
  const result=analyzeWalletInitiator(input);
  assert.equal(result.classification,'follower');
  assert.equal(result.directionalTokens.post,3);
  assert.equal(result.prospectivePreTokens,0);
  assert.ok(result.screeningEvidence.every(row=>row.marketFirstSeen?.leftCensored));
});

test('missing market first-seen stays unmatched and pending rather than becoming a success or failure',()=>{
  const input=fixture([-20],{asOf:1300});input.marketFirstSeen=[];
  let result=analyzeWalletInitiator(input);
  assert.equal(result.classification,'insufficient');assert.equal(result.matchedTokens,0);assert.equal(result.pendingTokens,1);
  result=analyzeWalletInitiator({...input,asOf:iso(100_000)});
  assert.equal(result.pendingTokens,0);assert.equal(result.unobservedTokens,1);assert.equal(result.preShare,undefined);
});

test('wrong identity, future time and conflicting transaction timestamps cannot create positive evidence',()=>{
  const input=fixture([-20]);
  input.trades=[...input.trades,trade(101,900,{wallet:addr(9)}),trade(102,900,{chain:'robinhood'}),
    trade(103,600_000),trade(104,1000,{observedAt:iso(900)})];
  input.marketFirstSeen=[...input.marketFirstSeen,market(101,1000,{chain:'robinhood'}),market(102,600_000,{firstSeenUpperBound:iso(600_000)})];
  let result=analyzeWalletInitiator(input);
  assert.equal(result.status,'partial');assert.equal(result.classification,'candidate');assert.equal(result.totalCandidateTokens,1);
  const conflicted=fixture([-20]);const original=conflicted.trades[0];
  conflicted.trades=[original,{...original,eventAt:iso(950),observedAt:iso(951)}];
  result=analyzeWalletInitiator(conflicted);
  assert.equal(result.classification,'insufficient');assert.equal(result.directionalTokens.ambiguous,1);assert.equal(result.status,'partial');
  assert.throws(()=>analyzeWalletInitiator({...input,wallet:'bad'}),/WALLET_INITIATOR_INPUT_INVALID/);
  assert.throws(()=>analyzeWalletInitiator({...input,asOf:'bad-time'}),/WALLET_INITIATOR_INPUT_INVALID/);
});

test('a reused first-seen id with conflicting token identity invalidates both market proofs',()=>{
  const input=fixture([-20,-20]);
  input.marketFirstSeen=[market(100,1000,{id:'gmgn:first:shared'}),market(101,1100,{id:'gmgn:first:shared'})];
  const result=analyzeWalletInitiator(input);
  assert.equal(result.status,'partial');assert.equal(result.classification,'insufficient');assert.equal(result.directionalTokens.ambiguous,2);
});

test('post-activation sell is a timestamped exit fact and never a dump assertion',()=>{
  const input=fixture([-20]);
  input.trades=[...input.trades,
    trade(100,1015,{side:'sell',wallet:addr(9),txHash:tx(998)}),
    trade(100,1010,{side:'sell',txHash:input.trades[0].txHash}),
    trade(100,1020,{side:'sell',txHash:tx(999)}),
    trade(100,1000+86_401,{side:'sell',txHash:tx(1000)})];
  const result=analyzeWalletInitiator(input),evidence=result.screeningEvidence[0];
  assert.equal(result.postActivationExitTokens,1);assert.equal(evidence.postActivationExit?.txHash,tx(999));
  assert.equal(evidence.postActivationExit?.wallet,wallet);
  assert.equal(result.dumpAssessment,'unknown');assert.ok(result.reasons.some(text=>text.includes('不是砸盘')));
  assert.equal('profitUsd' in result,false);
});

test('frozen 30-token proof retains knownAt only while the complete evidence frame is unchanged',()=>{
  const input=fixture([-20,-30,-40]),first=analyzeWalletInitiator(input);
  const repeated=analyzeWalletInitiator({...input,asOf:iso(500_100),previous:first});
  assert.equal(repeated.qualification?.knownAt,first.qualification?.knownAt);
  assert.notEqual(repeated.qualification,first.qualification);
  const changedMarkets=input.marketFirstSeen.map((row,index)=>index?row:{...row,firstSeenLowerBound:iso(992),firstSeenUpperBound:iso(1001)});
  const changed=analyzeWalletInitiator({...input,asOf:iso(500_200),marketFirstSeen:changedMarkets,previous:repeated});
  assert.equal(changed.classification,'precursor');assert.equal(changed.qualification?.knownAt,iso(500_200));
  const diluted=fixture([-20,-30,-40,-10,0,2]);
  const disqualified=analyzeWalletInitiator({...diluted,asOf:iso(500_300),previous:changed});
  assert.equal(disqualified.classification,'candidate');assert.equal(disqualified.qualification,undefined);
});

test('a later sell updates exit evidence without reissuing an unchanged directional qualification',()=>{
  const input=fixture([-20,-30,-40]),first=analyzeWalletInitiator(input),sell=trade(100,1020,{side:'sell',txHash:tx(999)});
  const updated=analyzeWalletInitiator({...input,asOf:iso(500_100),trades:[...input.trades,sell],previous:first});
  assert.equal(updated.classification,'precursor');assert.equal(updated.postActivationExitTokens,1);
  assert.equal(updated.qualification?.knownAt,first.qualification?.knownAt);
  assert.equal(updated.qualification?.proofHash,first.qualification?.proofHash);
  assert.ok(updated.screeningEvidence.some(row=>row.postActivationExit));
  assert.ok(updated.qualification?.evidence.every(row=>row.postActivationExit===undefined));
});

test('selection is bounded to the latest 30 tokens before directions are evaluated',()=>{
  const input=fixture(Array.from({length:35},()=>-20)),result=analyzeWalletInitiator(input);
  assert.equal(result.totalCandidateTokens,35);assert.equal(result.selectedTokens,30);assert.equal(result.screeningEvidence.length,30);
  assert.equal(result.qualification?.evidence.length,30);assert.equal(result.classification,'precursor');assert.equal(result.status,'partial');
  assert.ok(result.limitations.some(text=>text.includes('30-token')));
});

test('analysis never mutates source evidence',()=>{
  const input=fixture([-20,-30,20,30]),before=JSON.stringify(input);analyzeWalletInitiator(input);
  assert.equal(JSON.stringify(input),before);
});
