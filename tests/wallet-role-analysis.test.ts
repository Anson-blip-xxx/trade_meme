import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {analyzeWalletRoles,type AnalyzeWalletRolesInput,type WalletRoleEvent,type WalletRolePeerAnalysis} from '../src/wallet-role-analysis.js';

const epoch=Date.parse('2026-10-12T00:00:00Z'),iso=(seconds:number)=>new Date(epoch+seconds*1000).toISOString();
const addr=(id:number)=>'0x'+id.toString(16).padStart(40,'0'),tx=(id:number)=>'0x'+id.toString(16).padStart(64,'0');
const wallet=addr(1),peer=addr(2);
function event(token:number,who:string,when:number,patch:Partial<WalletRoleEvent>={}):WalletRoleEvent{return {chain:'bsc',wallet:who,tokenAddress:addr(token),txHash:tx(token*100+(who===wallet?1:2)),side:'buy',eventAt:iso(when),observedAt:iso(when+1),source:'gmgn_wallet_activity',...patch};}
function fixture(lags:number[],extra:Partial<AnalyzeWalletRolesInput>={}):AnalyzeWalletRolesInput{return {chain:'bsc',wallet,asOf:iso(500000),walletEvents:lags.map((lag,i)=>event(100+i,wallet,1000+i*100+lag)),peers:[{address:peer,events:lags.map((_,i)=>event(100+i,peer,1000+i*100)),publicObservedAt:iso(1)}],...extra};}
const relation=(input:AnalyzeWalletRolesInput):WalletRolePeerAnalysis=>analyzeWalletRoles(input).peers[0];

test('persistent short positive lag is a following pattern, never control or confirmed copying',()=>{
  const result=analyzeWalletRoles(fixture([5,6,7,8]));const r=result.peers[0];
  assert.equal(r.classification,'follower_pattern');assert.equal(r.directionalPattern,r.classification);assert.equal(r.directionalTokens.follow,4);
  assert.equal(r.followShare,1);assert.equal(r.medianLagSeconds,6.5);assert.equal(r.lagMadSeconds,1);assert.equal(r.ownership,'unknown');assert.equal(result.ownership,'unknown');
  assert.ok(r.alternativeExplanations.some(text=>text.includes('自动跟随')));assert.ok(r.counterEvidence.some(text=>text.includes('持续提前')));
});

test('3 earlier entries cannot hide 20 later entries; all distinct common tokens form the denominator',()=>{
  const r=relation(fixture([-20,-30,-40,...Array.from({length:20},()=>15)]));
  assert.equal(r.classification,'follower_pattern');assert.equal(r.matchedTokens,23);assert.equal(r.leadShare,3/23);assert.equal(r.followShare,20/23);
  assert.ok(r.evidence.some(row=>row.direction==='lead'));assert.ok(r.evidence.some(row=>row.direction==='follow'));assert.ok(r.evidence.length<=6);
});

test('2 leading and 2 following independent tokens yield mixed direction',()=>{
  const r=relation(fixture([-20,-30,20,30]));assert.equal(r.classification,'mixed_pattern');assert.equal(r.leadShare,0.5);assert.equal(r.followShare,0.5);
});

test('separate peers never pool one-off earlier observations into a repeated role',()=>{
  const input=fixture([-20,-20,-20]);input.peers=input.peers[0].events.map((e,i)=>({address:addr(20+i),events:[{...e,wallet:addr(20+i)}]}));
  const result=analyzeWalletRoles(input);assert.equal(result.peers.length,3);
  for(const r of result.peers){assert.equal(r.directionalTokens.lead,1);assert.equal(r.classification,'insufficient');assert.equal(r.directionalTokens.unmatched,2);}
});

test('ties and the inclusive 2-second dead zone remain unknown and in the denominator',()=>{
  const r=relation(fixture([-20,-20,-20,0,1,-2]));assert.equal(r.classification,'insufficient');assert.equal(r.directionalTokens.ambiguous,3);assert.equal(r.leadShare,0.5);
  assert.ok(r.evidence.some(row=>row.direction==='ambiguous'));
});

test('a timing difference just outside the dead zone can be directional but not itself a role',()=>{
  const r=relation(fixture([-2.001,2.001]));assert.equal(r.directionalTokens.lead,1);assert.equal(r.directionalTokens.follow,1);assert.equal(r.classification,'insufficient');
});

test('same transaction wallet appearances cannot establish a leading or following role',()=>{
  const input=fixture([-20,-20,-20]);input.peers[0].events=input.peers[0].events.map((e,i)=>({...e,txHash:input.walletEvents[i].txHash}));
  const r=relation(input);assert.equal(r.directionalTokens.ambiguous,3);assert.equal(r.classification,'insufficient');assert.equal(r.forwardObservedTokens,0);
});

test('future, wrong-chain, wrong-wallet and conflicting observed timestamps cannot create positive samples',()=>{
  const input=fixture([-20]);input.walletEvents=[...input.walletEvents,event(101,wallet,600000),event(102,wallet,1000,{chain:'robinhood'}),event(103,addr(99),1000),event(104,wallet,1000,{observedAt:iso(900)})];
  input.peers[0].events=[...input.peers[0].events,event(101,peer,600020),event(102,peer,1020),event(103,peer,1020),event(104,peer,1020)];
  const result=analyzeWalletRoles(input),r=result.peers[0];assert.equal(result.status,'partial');assert.equal(r.totalCandidateTokens,1);assert.equal(r.directionalTokens.lead,1);assert.equal(r.classification,'insufficient');
});

test('conflicting timestamps for one transaction keep that token uncertain instead of selecting a convenient row',()=>{
  const input=fixture([-20,-20,-20]);const buy=input.walletEvents[0];input.walletEvents=[...input.walletEvents,{...buy,eventAt:iso(1050),observedAt:iso(1060)}];
  const result=analyzeWalletRoles(input),r=result.peers[0];assert.equal(result.status,'partial');assert.equal(r.directionalTokens.lead,2);assert.equal(r.directionalTokens.ambiguous,1);assert.equal(r.classification,'insufficient');
});

test('later valid buys do not erase an earlier transaction timestamp conflict on the same token',()=>{
  const input=fixture([-20]);const buy=input.walletEvents[0];input.walletEvents=[...input.walletEvents,{...buy,eventAt:iso(1020),observedAt:iso(1030)},{...buy,txHash:tx(900),eventAt:iso(990),observedAt:iso(991)}];
  const r=relation(input);assert.equal(r.directionalTokens.ambiguous,1);assert.equal(r.directionalTokens.lead,0);
});

test('duplicate feeds and repeat buys on one CA never count as additional role samples',()=>{
  const input=fixture([-20]);const original=input.walletEvents[0];input.walletEvents=Array.from({length:20},(_,i)=>({...original,source:i%2?'gmgn_kol_feed':'gmgn_wallet_activity',observedAt:iso(2000+i)}));
  input.walletEvents=[...input.walletEvents,{...original,txHash:tx(999),eventAt:iso(1010),observedAt:iso(1011)}];
  const r=relation(input);assert.equal(r.totalCandidateTokens,1);assert.equal(r.directionalTokens.lead,1);assert.equal(r.classification,'insufficient');
});

test('no common tokens remain unmatched; recent observation windows are pending rather than failures',()=>{
  const input=fixture([-20,-20,-20],{asOf:iso(1300)});input.peers[0].events=[event(999,peer,1000)];
  const r=relation(input);assert.equal(r.matchedTokens,0);assert.equal(r.directionalTokens.unmatched,3);assert.equal(r.pendingTokens,3);assert.equal(r.unobservedTokens,0);assert.equal(r.classification,'insufficient');assert.equal(r.followShare,undefined);
  input.asOf=iso(500000);const older=relation(input);assert.equal(older.pendingTokens,0);assert.equal(older.unobservedTokens,3);assert.ok(older.counterEvidence.some(text=>text.includes('不能当作预测失败')));
});

test('common tokens beyond 24 hours stay in the denominator but are not counted as directional successes',()=>{
  const input=fixture([-20,-20,-20,86401]);const r=relation(input);assert.equal(r.directionalTokens.outsideWindow,1);assert.equal(r.matchedTokens,4);assert.equal(r.leadShare,0.75);assert.equal(r.classification,'precursor_pattern');
  input.walletEvents=[...input.walletEvents,event(105,wallet,1000+86402)];input.peers[0].events=[...input.peers[0].events,event(105,peer,1000)];
  const diluted=relation(input);assert.equal(diluted.leadShare,0.6);assert.equal(diluted.classification,'insufficient');
});

test('shared funding never overturns following evidence, and public or conflicted funding is excluded',()=>{
  const input=fixture([10,10,10]);input.peers[0].fundingEvidence=[{kind:'common',address:addr(800),observedAt:iso(100)},{kind:'direct',address:peer,observedAt:iso(100)},{kind:'common',address:addr(801),observedAt:iso(100),sharedService:true},{kind:'common',address:addr(802),observedAt:iso(100),conflict:true},{kind:'common',address:addr(803),observedAt:iso(600000)}];
  const r=relation(input);assert.equal(r.classification,'follower_pattern');assert.deepEqual(r.funding,{direct:1,common:1,excluded:3,ownership:'unknown'});assert.equal(r.ownership,'unknown');
});

test('forward observations require earlier known relationships and earlier observation; they are not prediction hit rates',()=>{
  const input=fixture([-20,-20,-20]);input.peers[0].relationshipKnownAt=iso(500);
  let result=analyzeWalletRoles(input);assert.equal(result.peers[0].forwardObservedTokens,3);assert.ok(result.limitations.some(text=>text.includes('不是命中率')));
  input.walletEvents=input.walletEvents.map(event=>({...event,observedAt:iso(4000)}));assert.equal(relation(input).forwardObservedTokens,0);
  input.walletEvents=fixture([-20,-20,-20]).walletEvents;input.peers[0].relationshipKnownAt=iso(500000);assert.equal(relation(input).forwardObservedTokens,0);
});

test('a later-discovered earlier peer buy retracts the precursor pattern',()=>{
  const input=fixture([-20,-20,-20]);assert.equal(relation(input).classification,'precursor_pattern');
  input.peers[0].events=[...input.peers[0].events,...input.peers[0].events.map((e,i)=>({...e,txHash:tx(90000+i),eventAt:iso(900+i*100),observedAt:iso(2000)}))];
  const r=relation(input);assert.equal(r.classification,'follower_pattern');assert.equal(r.directionalTokens.lead,0);
});

test('a post-peer sell remains a timestamped fact, never inferred profit or dumping',()=>{
  const input=fixture([-20,-20,-20]);input.walletEvents=[...input.walletEvents,event(100,wallet,1020,{txHash:tx(800),side:'sell'})];
  const r=relation(input);assert.ok(r.evidence.some(row=>row.candidateSellAfterLeader));assert.ok(r.reasons.some(text=>text.includes('不能据此声称出货或盈利')));assert.equal('profitUsd' in r,false);
});

test('profile evidence remains bounded and preserves opposing cases as well as unclear and missing cases',()=>{
  const input=fixture([-20,30,0,86401,...Array.from({length:40},()=>-20)]);input.walletEvents=[...input.walletEvents,event(900,wallet,1000)];
  const r=relation(input);assert.equal(r.evidence.length,6);
  assert.deepEqual(new Set(r.evidence.map(item=>item.direction)),new Set(['lead','follow','ambiguous','outsideWindow','unmatched']));assert.equal(r.totalCandidateTokens,45);
});

test('screening retains the full bounded frame when UI examples omit enough leading cases',()=>{
  const input=fixture([30,0,86401,...Array.from({length:9},()=>-20)]);
  input.walletEvents=[...input.walletEvents,event(900,wallet,1000)];
  const r=relation(input);assert.equal(r.classification,'precursor_pattern');assert.equal(r.evidence.length,6);
  assert.ok(r.evidence.filter(row=>row.direction==='lead').length<3);
  assert.equal(r.screeningEvidence!.length,13);assert.equal(r.qualification!.knownAt,input.asOf);
  assert.equal(r.qualification!.evidence.filter(row=>row.direction==='lead').length,9);
  assert.deepEqual(new Set(r.qualification!.evidence.map(row=>row.direction)),new Set(['lead','follow','ambiguous','outsideWindow','unmatched']));
  r.evidence[0].reason='display changed';assert.notEqual(r.qualification!.evidence[0].reason,'display changed');
});

test('persisted peer qualification keeps its actual discovery time across current refreshes and a restart',()=>{
  const input=fixture([-20,-20,-20,-20]),first=analyzeWalletRoles(input);
  const original=JSON.stringify(first.peers[0].qualification);
  const updated=analyzeWalletRoles({...input,asOf:iso(500100),previous:JSON.parse(JSON.stringify(first)),
    walletEvents:[...input.walletEvents,event(900,wallet,500050)]});
  assert.equal(JSON.stringify(updated.peers[0].qualification),original);assert.equal(updated.computedAt,iso(500100));
  assert.notEqual(updated.peers[0].qualification,first.peers[0].qualification);
  const oldWithoutProof=structuredClone(first);delete oldWithoutProof.peers[0].qualification;
  assert.equal(analyzeWalletRoles({...input,asOf:iso(500100),previous:oldWithoutProof}).peers[0].qualification!.knownAt,iso(500100));
});

test('a changed frozen earliest-buy proof resets discovery time even if the current pair still qualifies',()=>{
  const input=fixture(Array.from({length:9},()=>-20)),first=analyzeWalletRoles(input);
  const fresh=analyzeWalletRoles({...input,asOf:iso(500100),previous:first,peers:[{...input.peers[0],events:[...input.peers[0].events,
    event(100,peer,900,{txHash:tx(999999),observedAt:iso(500050)})]}]});
  assert.equal(fresh.peers[0].classification,'precursor_pattern');assert.equal(fresh.peers[0].directionalTokens.follow,1);
  assert.equal(fresh.peers[0].qualification!.knownAt,iso(500100));
  assert.ok(fresh.peers[0].qualification!.evidence.some(row=>row.tokenAddress===addr(100)&&row.direction==='follow'));
});

test('disqualification drops the prior certificate and requalification starts from the new observation time',()=>{
  const input=fixture([-20,-20,-20]),first=analyzeWalletRoles(input);
  const follow=analyzeWalletRoles({...fixture([20,20,20]),asOf:iso(500100),previous:first});
  assert.equal(follow.peers[0].qualification,undefined);
  const recovered=analyzeWalletRoles({...input,asOf:iso(500200),previous:follow});
  assert.equal(recovered.peers[0].qualification!.knownAt,iso(500200));
  const absent=analyzeWalletRoles({...input,asOf:iso(500100),previous:first,peers:[]});
  assert.equal(analyzeWalletRoles({...input,asOf:iso(500200),previous:absent}).peers[0].qualification!.knownAt,iso(500200));
});

test('future or wrong-wallet frozen certificates cannot backdate a current relationship',()=>{
  const input=fixture([-20,-20,-20]),first=analyzeWalletRoles(input);
  for(const edit of [(p:typeof first)=>{p.peers[0].qualification!.knownAt=iso(600000);},
    (p:typeof first)=>{p.peers[0].qualification!.evidence[0].candidateBuy!.wallet=addr(99);},
    (p:typeof first)=>{p.peers[0].qualification!.evidence[0].leaderBuy!.observedAt=iso(500010);}]){
    const previous=structuredClone(first);edit(previous);
    assert.equal(analyzeWalletRoles({...input,asOf:iso(500100),previous}).peers[0].qualification!.knownAt,iso(500100));
  }
});

test('truncated samples explicitly remain partial without inventing a confidence or ownership score',()=>{
  const result=analyzeWalletRoles(fixture([-20,-20,-20],{truncated:true}));assert.equal(result.status,'partial');assert.ok(result.limitations.some(text=>text.includes('截断')));assert.equal('confidence' in result,false);assert.equal(result.peers[0].ownership,'unknown');
});

test('Solana keeps address case and uses the same directional evidence requirements',()=>{
  const solWallet=bs58.encode(new Uint8Array(32).fill(1)),solPeer=bs58.encode(new Uint8Array(32).fill(2));
  const events=(who:string,lag:number)=>[3,4,5].map((n,i):WalletRoleEvent=>({chain:'solana',wallet:who,tokenAddress:bs58.encode(new Uint8Array(32).fill(n)),txHash:bs58.encode(new Uint8Array(64).fill(n+(who===solWallet?10:20))),side:'buy',eventAt:iso(1000+i*100+lag),observedAt:iso(1001+i*100+lag),source:'gmgn_wallet_activity'}));
  const result=analyzeWalletRoles({chain:'solana',wallet:solWallet,asOf:iso(3000),walletEvents:events(solWallet,10),peers:[{address:solPeer,events:events(solPeer,0)}]});assert.equal(result.peers[0].classification,'follower_pattern');assert.equal(result.peers[0].address,solPeer);
});

test('input evidence is not mutated and invalid analysis identities fail explicitly',()=>{
  const input=fixture([-20,-20,-20]);const snapshot=JSON.stringify(input);analyzeWalletRoles(input);assert.equal(JSON.stringify(input),snapshot);
  assert.throws(()=>analyzeWalletRoles({...input,wallet:'not-a-wallet'}),/WALLET_ROLE_INPUT_INVALID/);assert.throws(()=>analyzeWalletRoles({...input,asOf:'bad-date'}),/WALLET_ROLE_INPUT_INVALID/);
});
