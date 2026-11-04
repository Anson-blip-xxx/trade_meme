import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {
  analyzeWalletVisibleStart,qualifiedWalletVisibleStart,type AnalyzeWalletVisibleStartInput,
  type WalletVisibleStartFollowupInput,type WalletVisibleStartRelationReference,
} from '../src/wallet-visible-start-analysis.js';
import type {
  WalletInitiatorEvidence,WalletInitiatorQualification,WalletInitiatorTradeReference,
} from '../src/wallet-initiator-analysis.js';

const epoch=Date.parse('2026-11-04T00:00:00Z'),iso=(seconds:number)=>new Date(epoch+seconds*1000).toISOString();
const addr=(id:number)=>'0x'+id.toString(16).padStart(40,'0'),tx=(id:number)=>'0x'+id.toString(16).padStart(64,'0');
const wallet=addr(1),peer=addr(2);
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function prerequisite(count=3):WalletInitiatorQualification {
  const evidence=Array.from({length:count},(_,index):WalletInitiatorEvidence=>{
    const token=addr(100+index),marketAt=1000+index*100,buyAt=marketAt-20;
    return {tokenAddress:token,direction:'pre',prospective:true,reason:'prospective market-pre test proof',
      buy:{chain:'bsc',wallet,tokenAddress:token,txHash:tx(1000+index),side:'buy',eventAt:iso(buyAt),
        observedAt:iso(buyAt+1),source:'gmgn_wallet_activity'},
      marketFirstSeen:{id:`gmgn:first:${index}`,source:'gmgn_market_discovery',kind:'first_seen',chain:'bsc',
        tokenAddress:token,firstSeenLowerBound:iso(marketAt-10),firstSeenUpperBound:iso(marketAt),feed:'trenches',
        window:'lifecycle',leftCensored:false}};
  });
  return {version:1,classification:'precursor',knownAt:iso(2000),proofHash:digest(evidence),evidence};
}

function relation(index:number,patch:Partial<WalletVisibleStartRelationReference>={}):WalletVisibleStartRelationReference {
  return {id:`relation:${index}`,candidateWallet:wallet,peerWallet:peer,peerClass:'public',basis:'public_watchlist',
    knownAt:iso(100),source:'wallet_relation_store',...patch};
}

function follow(tokenIndex:number,lag=50,patch:{relation?:Partial<WalletVisibleStartRelationReference>;
  peerBuy?:Partial<WalletInitiatorTradeReference>}={}):WalletVisibleStartFollowupInput {
  const token=addr(100+tokenIndex),candidateAt=1000+tokenIndex*100-20;
  return {tokenAddress:token,relation:relation(tokenIndex,patch.relation),peerBuy:{chain:'bsc',wallet:peer,
    tokenAddress:token,txHash:tx(5000+tokenIndex),side:'buy',eventAt:iso(candidateAt+lag),observedAt:iso(candidateAt+lag+1),
    source:'gmgn_wallet_activity',...patch.peerBuy}};
}

function fixture(count=3):AnalyzeWalletVisibleStartInput {
  return {chain:'bsc',wallet,asOf:iso(5000),prospectiveMarketPreQualification:prerequisite(count),
    followups:Array.from({length:count},(_,index)=>follow(index))};
}

function rehash(value:WalletInitiatorQualification):void {value.proofHash=digest(value.evidence);}

test('three prospective locally observed starts followed by pre-related public wallets form only a visible-start candidate',()=>{
  const result=analyzeWalletVisibleStart(fixture());
  assert.equal(result.status,'current');assert.equal(result.classification,'visible_start_candidate');
  assert.equal(result.directionalTokens.followed,3);assert.equal(result.followShare,1);
  assert.equal(result.qualificationState,'issued');assert.equal(result.qualification?.knownAt,result.computedAt);
  assert.equal(result.sampleOnly,true);assert.equal(result.identity,'unknown');assert.equal(result.ownership,'unknown');
  assert.equal(result.profitAssessment,'not_assessed');assert.equal(result.tradingEnabled,false);
  assert.equal('profitUsd' in result,false);assert.ok(result.limitations.some(text=>text.includes('不是部署者')));
  assert.ok(qualifiedWalletVisibleStart(result.qualification,'bsc',wallet,result.computedAt,
    result.prerequisite.proofHash!));
  const persisted=JSON.parse(JSON.stringify(result));
  assert.ok(qualifiedWalletVisibleStart(persisted.qualification,'bsc',wallet,persisted.computedAt,
    persisted.prerequisite.proofHash));
});

test('a counterexample stays in the denominator and exactly 75 percent still meets the explicit threshold',()=>{
  const input=fixture(4);input.followups=[follow(0),follow(1),follow(2),follow(3,-10)];
  const result=analyzeWalletVisibleStart(input);
  assert.equal(result.directionalTokens.followed,3);assert.equal(result.directionalTokens.counter,1);
  assert.equal(result.followShare,0.75);assert.equal(result.classification,'visible_start_candidate');
  assert.ok(result.evidence.some(row=>row.direction==='counter'));
  assert.ok(result.counterEvidence.some(text=>text.includes('更早买入')));
  assert.equal(result.qualification?.evidence.length,4);
});

test('ambiguous and outside-window samples are retained and dilute rather than disappearing',()=>{
  const input=fixture(5);input.asOf=iso(100_000);
  input.followups=[follow(0),follow(1),follow(2),follow(3,2),follow(4,86_401)];
  const result=analyzeWalletVisibleStart(input);
  assert.equal(result.directionalTokens.followed,3);assert.equal(result.directionalTokens.ambiguous,1);
  assert.equal(result.directionalTokens.outsideWindow,1);assert.equal(result.followShare,0.6);
  assert.equal(result.classification,'insufficient');assert.equal(result.qualification,undefined);
  assert.deepEqual(new Set(result.evidence.map(row=>row.direction)),new Set(['followed','ambiguous','outsideWindow']));
});

test('a relationship learned after the candidate buy cannot be reconstructed as prospective support',()=>{
  const input=fixture();input.followups=input.followups.map((_,index)=>follow(index,50,{relation:{knownAt:iso(1500+index*100)}}));
  const result=analyzeWalletVisibleStart(input);
  assert.equal(result.directionalTokens.ambiguous,3);assert.equal(result.directionalTokens.followed,0);
  assert.equal(result.classification,'insufficient');
  assert.ok(result.screeningEvidence.every(row=>row.reason.includes('关系均未在候选买入前建立')));
});

test('on-chain lead is ambiguous when the local candidate observation arrived after the peer trade',()=>{
  const input=fixture();
  input.prospectiveMarketPreQualification.evidence=input.prospectiveMarketPreQualification.evidence.map((row,index)=>({
    ...row,buy:{...row.buy!,observedAt:iso(1000+index*100-12)},
  }));rehash(input.prospectiveMarketPreQualification);
  input.followups=[0,1,2].map(index=>follow(index,5));
  const result=analyzeWalletVisibleStart(input);
  assert.equal(result.prerequisite.valid,true);assert.equal(result.directionalTokens.ambiguous,3);
  assert.ok(result.screeningEvidence.every(row=>row.localEvidenceLeadSeconds===-3));
  assert.ok(result.screeningEvidence.every(row=>row.reason.includes('本机证据未领先')));
});

test('one token is counted once; the earliest eligible peer prevents cherry-picking a later favorable buy',()=>{
  const input=fixture(3),earlier=follow(0,-10,{relation:{id:'relation:counter',peerWallet:addr(9)},
    peerBuy:{wallet:addr(9),txHash:tx(9000)}}),duplicate=structuredClone(follow(1));
  input.followups=[follow(0),earlier,follow(1),duplicate,follow(2)];
  const result=analyzeWalletVisibleStart(input);
  assert.equal(result.selectedTokens,3);assert.equal(result.directionalTokens.counter,1);
  assert.equal(result.directionalTokens.followed,2);assert.equal(result.followShare,2/3);
  assert.equal(result.classification,'insufficient');
  assert.equal(result.screeningEvidence.find(row=>row.tokenAddress===addr(1+99))?.consideredFollowups,2);
  assert.equal(result.screeningEvidence.find(row=>row.tokenAddress===addr(101))?.excludedFollowups,1);
});

test('prospective market-pre prerequisite is verified from its frozen proof rather than trusted by name',()=>{
  const retrospective=fixture();retrospective.prospectiveMarketPreQualification.evidence[0].prospective=false;
  rehash(retrospective.prospectiveMarketPreQualification);
  let result=analyzeWalletVisibleStart(retrospective);
  assert.equal(result.prerequisite.valid,false);assert.equal(result.status,'partial');
  assert.equal(result.classification,'insufficient');assert.equal(result.qualification,undefined);
  const tampered=fixture();tampered.prospectiveMarketPreQualification.evidence[0].reason='changed without hash';
  result=analyzeWalletVisibleStart(tampered);
  assert.equal(result.prerequisite.valid,false);assert.equal(result.status,'partial');
  assert.ok(result.limitations.some(text=>text.includes('proof hash 无效')));
});

test('invalid followup identity cannot be ignored to sign a certificate',()=>{
  const input=fixture();input.followups=[...input.followups,{...follow(0),tokenAddress:addr(999)}];
  const result=analyzeWalletVisibleStart(input);
  assert.equal(result.rejectedFollowups,1);assert.equal(result.status,'partial');
  assert.equal(result.directionalTokens.followed,3);assert.equal(result.classification,'insufficient');
  assert.equal(result.qualification,undefined);
});

test('unchanged frozen proof preserves knownAt; changed proof is reissued or revoked immediately',()=>{
  const input=fixture(4),first=analyzeWalletVisibleStart(input);
  const unchanged=analyzeWalletVisibleStart({...input,asOf:iso(5100),previous:first});
  assert.equal(unchanged.qualificationState,'preserved');
  assert.equal(unchanged.qualification?.knownAt,first.qualification?.knownAt);
  const stillQualifies={...input,asOf:iso(5200),previous:unchanged,
    followups:[follow(0,60,{peerBuy:{txHash:tx(8000)}}),follow(1),follow(2),follow(3)]};
  const reissued=analyzeWalletVisibleStart(stillQualifies);
  assert.equal(reissued.classification,'visible_start_candidate');assert.equal(reissued.qualificationState,'reissued');
  assert.equal(reissued.qualification?.knownAt,iso(5200));assert.notEqual(reissued.qualification?.proofHash,first.qualification?.proofHash);
  const contradicted=analyzeWalletVisibleStart({...input,asOf:iso(5300),previous:reissued,
    followups:[follow(0,-10),follow(1,-10),follow(2),follow(3)]});
  assert.equal(contradicted.classification,'insufficient');assert.equal(contradicted.qualificationState,'revoked');
  assert.equal(contradicted.qualification,undefined);
});

test('same transaction and conflicting copies cannot create favorable timing',()=>{
  const input=fixture();input.followups=[
    follow(0,50,{peerBuy:{txHash:input.prospectiveMarketPreQualification.evidence[0].buy!.txHash}}),
    follow(1),follow(1,60,{peerBuy:{txHash:follow(1).peerBuy.txHash,observedAt:iso(1200)}}),follow(2),
  ];
  const result=analyzeWalletVisibleStart(input);
  assert.equal(result.directionalTokens.ambiguous,2);assert.equal(result.directionalTokens.followed,1);
  assert.equal(result.classification,'insufficient');assert.equal(result.status,'current');
});

test('Solana identities are preserved and evaluated with the same prospective rules',()=>{
  const solWallet=bs58.encode(new Uint8Array(32).fill(1)),solPeer=bs58.encode(new Uint8Array(32).fill(2));
  const evidence=Array.from({length:3},(_,index):WalletInitiatorEvidence=>{
    const token=bs58.encode(new Uint8Array(32).fill(10+index)),buyAt=1000+index*100;
    return {tokenAddress:token,direction:'pre',prospective:true,reason:'sol prospective proof',
      buy:{chain:'solana',wallet:solWallet,tokenAddress:token,txHash:bs58.encode(new Uint8Array(64).fill(30+index)),
        side:'buy',eventAt:iso(buyAt),observedAt:iso(buyAt+1),source:'solana_rpc'},
      marketFirstSeen:{id:`sol:first:${index}`,source:'gmgn_market_discovery',kind:'first_seen',chain:'solana',tokenAddress:token,
        firstSeenLowerBound:iso(buyAt+10),firstSeenUpperBound:iso(buyAt+20),feed:'trending',window:'5m',leftCensored:false}};
  }),qualification:WalletInitiatorQualification={version:1,classification:'precursor',knownAt:iso(2000),
    proofHash:digest(evidence),evidence};
  const followups=evidence.map((row,index):WalletVisibleStartFollowupInput=>({tokenAddress:row.tokenAddress,
    relation:{id:`sol:relation:${index}`,candidateWallet:solWallet,peerWallet:solPeer,peerClass:'independent',
      basis:'independence_review',knownAt:iso(100),source:'wallet_relation_store'},
    peerBuy:{chain:'solana',wallet:solPeer,tokenAddress:row.tokenAddress,txHash:bs58.encode(new Uint8Array(64).fill(50+index)),
      side:'buy',eventAt:iso(1050+index*100),observedAt:iso(1051+index*100),source:'solana_rpc'}}));
  const result=analyzeWalletVisibleStart({chain:'solana',wallet:solWallet,asOf:iso(5000),
    prospectiveMarketPreQualification:qualification,followups});
  assert.equal(result.classification,'visible_start_candidate');assert.equal(result.wallet,solWallet);
});

test('analysis is pure and rejects invalid top-level identity or time',()=>{
  const input=fixture(),snapshot=JSON.stringify(input);analyzeWalletVisibleStart(input);assert.equal(JSON.stringify(input),snapshot);
  assert.throws(()=>analyzeWalletVisibleStart({...input,wallet:'bad'}),/WALLET_VISIBLE_START_INPUT_INVALID/);
  assert.throws(()=>analyzeWalletVisibleStart({...input,asOf:'bad'}),/WALLET_VISIBLE_START_INPUT_INVALID/);
});
