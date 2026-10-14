import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {analyzeWalletScreening,qualifiedWalletWithdrawal,type WalletScreeningInput,type WalletSetup} from '../src/wallet-screening.js';
import {analyzeWalletRoles} from '../src/wallet-role-analysis.js';
import type {WalletProfile} from '../src/wallet-profiles.js';
import type {WalletTradeObservation} from '../src/wallet-history.js';
import type {WalletAnalysis,WalletRecord} from '../src/research/wallet-types.js';
import {mergeWalletSupport} from '../src/engine.js';
import {parseSignal,type Check} from '../src/types.js';

const base=Date.parse('2026-10-13T00:00:00Z'),iso=(s:number)=>new Date(base+s*1000).toISOString();
const addr=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const token={chain:'bsc' as const,address:addr(100)};
function trade(who:number,at:number,patch:Partial<WalletTradeObservation>={}):WalletTradeObservation {
  return {chain:'bsc',wallet:addr(who),tokenAddress:token.address,txHash:hash(who*10000+at),side:'buy',eventAt:iso(at),observedAt:iso(at+1),
    source:'gmgn_kol_feed',amount:'200',amountUnit:'vendor_quantity',usd:'200',priceUsd:'1',...patch};
}
function record(n:number):WalletRecord {
  return {chain:'bsc',address:addr(n),sources:['top_holders'],vendorLabels:{provider:'gmgn',verification:'vendor_claim',platform:[],token:[]},
    recognizedLabels:n===2?['kol']:[],vendorIdentity:{verification:'vendor_claim'},attribution:{status:'unknown',verification:'unverified'},
    holding:{amount:'200',usd:'200',supplyRatio:0.001,currentlyHolding:true},
    cumulative:{scope:'vendor_token_cumulative',recentInflow:false,buyVolumeUsd:'200',sellVolumeUsd:'0',buyCount:1,sellCount:0,firstAcquiredAt:iso(900),lastActiveAt:iso(900),exitedAt:null},
    funding:{address:null,label:null,verification:'vendor_claim',source:'unknown',amount:null,timestamp:null,txHash:null,sharedService:false,conflict:false},
    developerLinks:[],risks:[],clusterId:'wallet-'+n,enrichment:{status:'complete',reasons:[],activity:{scope:'token_activity_page',events:[],hasMore:false,
      firstAt:iso(800),lastAt:iso(995),recent:{since:iso(400),until:iso(995),coverage:'vendor_window_covered',buyUsd:'200',sellUsd:'0',netBuyUsd:'200',hasAccumulation:true}}}};
}
function analysis():WalletAnalysis {
  return {status:'pass',checkedAt:iso(995),reasons:[],facts:{},wallets:[record(1),record(2),record(3),record(4)],clusters:[],
    summary:{token,sampleOnly:true,uniqueWalletCount:4,enrichedWalletCount:4,currentHolderCount:4,smartCurrentHolderCount:0,smartFundingClusterCount:0,smartIndependenceProven:false,
      eligibleSmartWalletCount:0,qualifiedSmartWalletCount:0,qualifiedSmartFundingClusterCount:0,recentWindowSeconds:600,recentNetBuyUsd:'800',hasRecentAccumulation:true,
      sampledHoldingRatio:0.004,cumulativeBuyUsd:'800',cumulativeSellUsd:'0',cumulativeCoverageWalletCount:4,cumulativeIsRecentInflow:false}};
}
function profile(who:number):WalletProfile {
  return {version:1,chain:'bsc',address:addr(who),computedAt:iso(850),freshUntil:iso(2000),status:'current',source:'wallet_history',sampleOnly:true,ownership:'unknown',
    groups:who===2?[{id:'public_kol',firstObservedAt:iso(50),evidenceCount:3,reason:'vendor label'}]:[],limitations:[],counterparties:[],
    metrics:{observedEvents:6,buyEvents:6,sellEvents:0,distinctTokens:3,associations:{leaders:who===1?1:0,distinctTokens:3,forwardTokens:0},chain:{transactions:0,transfers:0},
      ...(who===2?{vendorProfit:{realizedProfitUsd:'10000',period:'7d' as const,observedAt:iso(840),snapshotAt:iso(830),verification:'vendor_claim' as const}}:{})}};
}
function fixture(route:'precursor'|'public_entry'='public_entry'):WalletScreeningInput {
  const a=profile(1),b=profile(2);
  a.roleAnalysis=analyzeWalletRoles({chain:'bsc',wallet:addr(1),asOf:iso(850),walletEvents:[0,1,2].map(i=>trade(1,100+i*100,{tokenAddress:addr(200+i)})),
    peers:[{address:addr(2),publicObservedAt:iso(50),relationshipKnownAt:iso(60),events:[0,1,2].map(i=>trade(2,130+i*100,{tokenAddress:addr(200+i)}))}]});
  return {token,now:iso(1000),trades:route==='precursor'?[trade(1,900)]:[trade(2,900),trade(3,910),trade(4,920)],profiles:[a,b],wallets:analysis(),
    snapshot:{token,fetchedAt:iso(995),diagnostics:[{section:'info',status:'ok'}],info:{address:token.address,chain:'bsc',price:{price:'1.1'}}},profitCohort:Array.from({length:10},(_,i)=>(i+1)*1000)};
}
const setup=(input:WalletScreeningInput,route:WalletSetup['route']='public_entry')=>analyzeWalletScreening(input).setups.find(s=>s.route===route)!;

test('direct public entry is supported without any precursor or smart label, with grouped subsequent buys',()=>{
  const input=fixture(),result=analyzeWalletScreening(input),s=result.setups[0];
  assert.equal(result.status,'supported');assert.equal(s.route,'public_entry');assert.equal(s.stage,'direct_entry');assert.equal(s.followers,2);
  assert.equal(s.profit?.realizedProfitUsd,10000);assert.equal(s.profit?.percentile,95);assert.equal(s.profit?.cohortSize,10);
  assert.equal(result.scope,'research_priority');assert.equal(result.ownership,'unknown');assert.equal(s.ownership,'unknown');assert.equal(result.priorityScore,18);
  assert.equal(result.validUntil,iso(1060));assert.ok(s.counterEvidence.includes('WALLET_SCREENING_FOLLOWERS_NOT_INDEPENDENCE_PROOF'));
  assert.equal('probability' in result,false);assert.equal('buyEligible' in result,false);
});

test('precursor can be supported before public entry when independently dated history predates the trigger',()=>{
  const input=fixture('precursor'),result=analyzeWalletScreening(input),s=setup(input,'precursor');
  assert.equal(result.status,'supported');assert.equal(s.stage,'awaiting_public_entry');assert.equal(s.followers,0);assert.equal(s.relationKnownAt,iso(850));
  assert.ok(s.reasons.includes('PRECURSOR_PRIOR_PATTERN_SUPPORTED'));assert.ok(s.reasons.includes('PUBLIC_WALLET_ENTRY_NOT_YET_OBSERVED'));
});

test('later public buy updates precursor stage, while a same-time or earlier public buy does not qualify it',()=>{
  const input=fixture('precursor');input.trades.push(trade(2,930));
  assert.equal(setup(input,'precursor').stage,'public_entry_observed');assert.equal(setup(input,'precursor').status,'supported');
  for(const at of [850,900,902]){const value=fixture('precursor');value.trades.push(trade(2,at));const s=setup(value,'precursor');
    assert.equal(s.status,'watch');assert.ok(s.reasons.includes('PUBLIC_WALLET_ALREADY_ENTERED_OR_ORDER_UNCLEAR'));}
});

test('a cohort is mandatory and positive profit alone is not a high-profit qualification',()=>{
  const cases:[string,(i:WalletScreeningInput)=>void][]=[
    ['small cohort',i=>{i.profitCohort=[1000,2000];}],['below USD floor',i=>{i.profiles[1].metrics.vendorProfit!.realizedProfitUsd='999';i.profitCohort=Array.from({length:10},(_,n)=>n+1);}],
    ['below quartile',i=>{i.profiles[1].metrics.vendorProfit!.realizedProfitUsd='3000';}],['zero profit',i=>{i.profiles[1].metrics.vendorProfit!.realizedProfitUsd='0';}],
    ['negative profit',i=>{i.profiles[1].metrics.vendorProfit!.realizedProfitUsd='-5';}],['old profit',i=>{i.profiles[1].metrics.vendorProfit!.snapshotAt=iso(-90000);}],
    ['future profit',i=>{i.profiles[1].metrics.vendorProfit!.observedAt=iso(1001);}],['profit newer than profile',i=>{i.profiles[1].metrics.vendorProfit!.observedAt=iso(900);}],
    ['observed upside is not PNL',i=>{delete i.profiles[1].metrics.vendorProfit;i.profiles[1].metrics.observedGain={maxGainPct:9000,tokenAddress:token.address,baselineAt:iso(5),peakAt:iso(30),source:'sample'};}],
  ];
  for(const [label,edit] of cases){const input=fixture();edit(input);assert.equal(setup(input).status,'watch',label);}
});

test('a frozen peer qualification survives profile refresh after the trigger, while a newly learned relation does not',()=>{
  const input=fixture('precursor');input.profiles[0].computedAt=iso(995);input.profiles[0].roleAnalysis!.computedAt=iso(994);
  assert.equal(setup(input,'precursor').status,'supported');assert.equal(setup(input,'precursor').relationKnownAt,iso(850));
  for(const knownAt of [iso(900),iso(950)]){const value=structuredClone(input);value.profiles[0].roleAnalysis!.peers[0].qualification!.knownAt=knownAt;
    const s=setup(value,'precursor');assert.equal(s.status,'watch');assert.ok(s.reasons.includes('PRECURSOR_RELATION_NOT_KNOWN_BEFORE_BUY'));}
  delete input.profiles[0].roleAnalysis!.peers[0].qualification;
  assert.equal(setup(input,'precursor').status,'watch');
});

test('display examples and aggregate lead counts cannot replace frozen transaction proofs',()=>{
  const input=fixture('precursor'),peer=input.profiles[0].roleAnalysis!.peers[0];
  peer.evidence=peer.evidence.slice(0,1);assert.equal(setup(input,'precursor').status,'supported');
  peer.qualification!.evidence=peer.qualification!.evidence.slice(0,2);peer.directionalTokens.lead=100;
  assert.equal(setup(input,'precursor').status,'watch');
});

test('role computation and qualification cannot be later than the persisted current profile',()=>{
  const input=fixture('precursor');input.profiles[0].roleAnalysis!.computedAt=iso(901);
  assert.ok(setup(input,'precursor').reasons.includes('PRECURSOR_RELATION_NOT_KNOWN_BEFORE_BUY'));
});

test('three distinct other-token lead examples are required; current-token, duplicates, late observations and reversed order do not count',()=>{
  const edits:((i:WalletScreeningInput)=>void)[]=[
    i=>{i.profiles[0].roleAnalysis!.peers[0].qualification!.evidence[0].tokenAddress=token.address;},
    i=>{const e=i.profiles[0].roleAnalysis!.peers[0].qualification!.evidence;e[1].tokenAddress=e[0].tokenAddress;},
    i=>{i.profiles[0].roleAnalysis!.peers[0].qualification!.evidence[0].leaderBuy!.observedAt=iso(905);},
    i=>{const e=i.profiles[0].roleAnalysis!.peers[0].qualification!.evidence[0];e.candidateBuy!.eventAt=e.leaderBuy!.eventAt;},
    i=>{const e=i.profiles[0].roleAnalysis!.peers[0].qualification!.evidence[0];e.candidateBuy!.txHash=e.leaderBuy!.txHash;},
    i=>{i.profiles[0].roleAnalysis!.peers[0].qualification!.evidence[0].leaderBuy!.observedAt=iso(875);},
  ];
  for(const edit of edits){const input=fixture('precursor');edit(input);const s=setup(input,'precursor');assert.equal(s.status,'watch');assert.ok(s.reasons.includes('PRECURSOR_PRIOR_LEAD_EVIDENCE_INSUFFICIENT'));}
});

test('a global repeated-early group or a follower classification cannot substitute for the specific precursor relationship',()=>{
  const input=fixture('precursor');input.profiles[0].groups.push({id:'repeated_early',firstObservedAt:iso(60),evidenceCount:30,reason:'cross-peer sample'});
  input.profiles[0].roleAnalysis!.peers[0].classification='follower_pattern';assert.equal(analyzeWalletScreening(input).setups.length,0);
});

test('historical following, ambiguity and unmatched tokens remain explicit counterevidence',()=>{
  const input=fixture('precursor'),peer=input.profiles[0].roleAnalysis!.peers[0];peer.directionalTokens.follow=1;peer.directionalTokens.ambiguous=1;peer.directionalTokens.unmatched=2;
  const s=setup(input,'precursor');assert.ok(s.counterEvidence.includes('PRECURSOR_HISTORICAL_FOLLOW_COUNTEREXAMPLES'));
  assert.ok(s.counterEvidence.includes('PRECURSOR_HISTORICAL_AMBIGUOUS_COUNTEREXAMPLES'));assert.ok(s.counterEvidence.includes('PRECURSOR_UNMATCHED_NOT_PREDICTION_FAILURES'));
});

test('both routes require current holdings and complete recent accumulation for the actual trigger wallet',()=>{
  const edits:((i:WalletScreeningInput,w:WalletRecord)=>void)[]=[
    i=>{i.wallets=undefined;},i=>{i.wallets!.status='unknown';},i=>{i.wallets!.summary.token={...token,address:addr(999)};},i=>{i.wallets!.checkedAt=iso(870);},
    (_,w)=>{w.holding.currentlyHolding=null;},(_,w)=>{w.enrichment.status='partial';},(_,w)=>{w.enrichment.activity!.recent.coverage='partial';},
    (_,w)=>{w.enrichment.activity!.recent.netBuyUsd='0';},(_,w)=>{w.enrichment.activity!.recent.netBuyUsd='-100';},(_,w)=>{w.enrichment.activity!.recent.hasAccumulation=null;},
    (_,w)=>{w.enrichment.activity!.recent.since=iso(950);},(_,w)=>{w.enrichment.activity!.recent.until=iso(899);},
    (_,w)=>{w.enrichment.activity!.recent.until=iso(998);},
  ];
  for(const route of ['precursor','public_entry'] as const)for(const edit of edits){const input=fixture(route),w=input.wallets!.wallets.find(w=>w.address===addr(route==='precursor'?1:2))!;edit(input,w);
    assert.notEqual(setup(input,route).status,'supported');}
});

test('unsafe wallet labels, conflicting funding and developer links reject support',()=>{
  for(const route of ['precursor','public_entry'] as const)for(const risk of ['bundler','rat_trader','developer','exchange_or_pool','conflict','developerLink','risk'] as const){
    const input=fixture(route),w=input.wallets!.wallets[route==='precursor'?0:1];
    if(risk==='conflict')w.funding.conflict=true;else if(risk==='developerLink')w.developerLinks=['same_funder'];else if(risk==='risk')w.risks=['VENDOR_SUSPICIOUS_WALLET'];else w.recognizedLabels.push(risk);
    assert.equal(setup(input,route).status,'watch');
  }
});

test('observed sell or transfer out withdraws only the affected route without asserting a full exit',()=>{
  for(const who of [1,2])for(const side of ['sell','transferOut'] as const){const input=fixture('precursor');input.trades.push(trade(who,940,{side}));const result=analyzeWalletScreening(input),s=setup(input,'precursor');
    assert.equal(s.status,'withdrawn');assert.equal(s.priorityScore,0);assert.equal(result.status,'watch');assert.ok(s.reasons.includes('WALLET_SETUP_WITHDRAWN'));assert.equal('realizedProfit' in s,false);}
});

test('an expected-not-yet-held leader in the precursor route is not mistaken for an exit',()=>{
  const input=fixture('precursor');input.wallets!.wallets[1].holding.currentlyHolding=false;
  assert.equal(setup(input,'precursor').status,'supported');
  input.trades.push(trade(2,930));assert.equal(setup(input,'precursor').status,'withdrawn');
});

test('a newer bound analysis with a sell retracts support even before that activity is persisted to trade history',()=>{
  const input=fixture('precursor');input.wallets!.wallets[1].enrichment.activity!.events.push({type:'sell',txHash:hash(888),timestamp:iso(940),amount:'10',usd:'10'});
  const s=setup(input,'precursor');assert.equal(s.status,'withdrawn');assert.ok(s.counterEvidence.includes('PUBLIC_WALLET_SELL_OR_TRANSFER_AFTER_TRIGGER'));
});

test('a current zero position or a vendor exit snapshot withdraws support',()=>{
  for(const mode of ['zero','exited']){const input=fixture();if(mode==='zero')input.wallets!.wallets[1].holding.currentlyHolding=false;else input.wallets!.wallets[1].cumulative.exitedAt=iso(940);
    assert.equal(setup(input).status,'withdrawn');}
});

test('duplicate vendor copies do not create followers, and missing values preserve explicit price and USD evidence',()=>{
  const input=fixture();const duplicate={...input.trades[0],source:'screening_current_analysis',priceUsd:undefined,usd:undefined,observedAt:iso(996)};
  input.trades.push(duplicate,{...input.trades[1],source:'gmgn_smartmoney_feed'});
  const s=setup(input);assert.equal(s.status,'supported');assert.equal(s.followers,2);assert.equal(s.trigger.priceUsd,'1');assert.equal(s.trigger.usd,'200');
  input.trades=input.trades.filter(t=>t.wallet!==addr(4));assert.equal(setup(input).status,'watch');assert.equal(setup(input).followers,1);
});

test('conflicting transaction copies are excluded instead of selecting the convenient price, amount or time',()=>{
  for(const patch of [{priceUsd:'2'},{usd:'201'},{eventAt:iso(899)},{side:'sell' as const}]){const input=fixture();input.trades.push({...input.trades[0],...patch,source:'gmgn_wallet_activity'});
    const result=analyzeWalletScreening(input);assert.equal(result.status,'watch');assert.equal(result.setups[0].status,'withdrawn');
    assert.ok(result.reasons.includes('WALLET_SCREENING_CONFLICTING_EVENTS_EXCLUDED'));assert.ok(result.setups[0].reasons.includes('WALLET_TRIGGER_BUY_CONFLICT'));}
  const input=fixture('precursor');input.trades.push(trade(2,940),trade(2,940,{usd:'201'}));assert.equal(setup(input,'precursor').status,'withdrawn');
});

test('followers from the same funding component count once, and followers linked to the trigger wallet count zero',()=>{
  const input=fixture();input.wallets!.wallets[2].clusterId='shared';input.wallets!.wallets[3].clusterId='shared';assert.equal(setup(input).followers,1);
  input.wallets!.wallets[3].clusterId='different';input.wallets!.wallets[2].funding.address=addr(88);input.wallets!.wallets[3].funding.address=addr(88);assert.equal(setup(input).followers,1);
  input.wallets!.wallets[1].funding.address=addr(88);assert.equal(setup(input).followers,0);
});

test('same public exchange funding is not counted as proof of a common owner',()=>{
  const input=fixture();for(const w of input.wallets!.wallets){w.funding.address=addr(88);w.funding.sharedService=true;}
  assert.equal(setup(input).followers,2);assert.equal(setup(input).status,'supported');
});

test('same-second trades, self trades and unsafe tagged wallets cannot satisfy two subsequent follower groups',()=>{
  const input=fixture();input.trades=[trade(2,900),trade(2,910),trade(3,902),trade(4,920)];assert.equal(setup(input).followers,1);
  input.wallets!.wallets[3].recognizedLabels.push('bundler');assert.equal(setup(input).followers,0);
});

test('unknown, dust or missing-USD followers do not count as subsequent qualifying buy groups',()=>{
  for(const edit of [(i:WalletScreeningInput)=>{i.wallets!.wallets=i.wallets!.wallets.filter(w=>w.address!==addr(3));},
    (i:WalletScreeningInput)=>{i.trades[1].usd='99.99';},(i:WalletScreeningInput)=>{delete i.trades[1].usd;},
    (i:WalletScreeningInput)=>{i.wallets!.wallets[2].holding.currentlyHolding=null;},(i:WalletScreeningInput)=>{i.wallets!.wallets[2].holding.currentlyHolding=false;}]){
    const input=fixture();edit(input);assert.equal(setup(input).followers,1);assert.equal(setup(input).status,'watch');}
  const input=fixture();input.trades[1].usd='100';input.trades[2].usd='100';assert.equal(setup(input).followers,2);
});

test('a follower selling, transferring out or carrying any transaction conflict in the window is excluded',()=>{
  for(const side of ['sell','transferOut'] as const){const input=fixture();input.trades.push(trade(3,930,{side}));assert.equal(setup(input).followers,1);}
  const beforeBuy=fixture();beforeBuy.trades.push(trade(3,890,{side:'sell'}));assert.equal(setup(beforeBuy).followers,1);
  const conflict=fixture();conflict.trades.push({...conflict.trades[1],usd:'201',source:'gmgn_wallet_activity'});assert.equal(setup(conflict).followers,1);
  const activity=fixture();activity.wallets!.wallets[2].enrichment.activity!.events.push({txHash:hash(888),type:'sell',timestamp:iso(930),amount:'20',usd:'20'});assert.equal(setup(activity).followers,1);
  const exited=fixture();exited.wallets!.wallets[2].cumulative.exitedAt=iso(930);assert.equal(setup(exited).followers,1);
});

test('a qualifying public trigger conflict withdraws the original setup and vetoes old smart-wallet support',()=>{
  const input=fixture(),original=setup(input);assert.equal(original.status,'supported');
  input.trades.push({...input.trades[0],priceUsd:'2',source:'screening_current_analysis'});
  const result=analyzeWalletScreening(input),s=result.setups[0];assert.equal(s.id,original.id);assert.equal(s.status,'withdrawn');assert.equal(s.priorityScore,0);
  assert.equal(s.followers,0);assert.equal(s.chasePct,undefined);assert.deepEqual(s.reasons,['WALLET_TRIGGER_BUY_CONFLICT','WALLET_SETUP_WITHDRAWN']);
  const primary:Check={status:'pass',reasons:['SMART_WALLET_ACCUMULATION_SUPPORTED'],checkedAt:input.now,facts:{}};
  const signal=parseSignal({source:'gmgn',sourceEventId:'conflict',token,occurredAt:iso(900)});
  const merged=mergeWalletSupport(primary,result,signal,new Date(input.now));assert.equal(merged?.status,'unknown');assert.ok(merged?.reasons.includes('WALLET_SETUP_SUPPORT_WITHDRAWN'));
});

test('a precursor trigger conflict creates a withdrawal only for a fully qualified pre-existing relation',()=>{
  const input=fixture('precursor'),original=setup(input,'precursor');input.trades.push({...input.trades[0],priceUsd:'2',source:'screening_current_analysis'});
  const s=setup(input,'precursor');assert.equal(s.id,original.id);assert.equal(s.status,'withdrawn');assert.equal(s.relationKnownAt,iso(850));
  input.profiles[0].roleAnalysis!.peers[0].qualification!.evidence.pop();assert.equal(analyzeWalletScreening(input).setups.length,0);
});

test('low-qualification trigger conflicts never veto an otherwise valid smart-wallet flow',()=>{
  const edits:((i:WalletScreeningInput)=>void)[]=[
    i=>{i.profiles[1].metrics.vendorProfit!.realizedProfitUsd='100';},i=>{i.profitCohort=[1,2,3];},
    i=>{i.profiles[1].freshUntil=iso(999);},i=>{i.profiles[1].groups=[];},i=>{i.profiles[1].metrics.vendorProfit!.snapshotAt=iso(-90000);},
    i=>{i.trades[0].usd='1';},i=>{delete i.trades[0].usd;},
  ];
  const signal=parseSignal({source:'gmgn',sourceEventId:'low-conflict',token,occurredAt:iso(900)});
  for(const edit of edits){const input=fixture();edit(input);input.trades.push({...input.trades[0],priceUsd:'2',source:'screening_current_analysis'});
    const result=analyzeWalletScreening(input);assert.ok(!result.setups.some(s=>s.status==='withdrawn'));
    const primary:Check={status:'pass',reasons:['SMART_WALLET_ACCUMULATION_SUPPORTED'],checkedAt:input.now,facts:{}};
    assert.strictEqual(mergeWalletSupport(primary,result,signal,new Date(input.now)),primary);
  }
  const conflictingAmount=fixture();conflictingAmount.trades.push({...conflictingAmount.trades[0],usd:'1',source:'screening_current_analysis'});
  assert.equal(analyzeWalletScreening(conflictingAmount).setups.length,0);
});

test('many lower-priority watch candidates cannot hide a qualifying trigger withdrawal at the display limit',()=>{
  const input=fixture();input.trades.push({...input.trades[0],priceUsd:'2',source:'screening_current_analysis'});
  for(let i=0;i<12;i++){const who=20+i,p=profile(who);p.groups=structuredClone(input.profiles[1].groups);p.metrics.vendorProfit={...input.profiles[1].metrics.vendorProfit!,realizedProfitUsd:'100'};
    input.profiles.push(p);input.trades.push(trade(who,905+i));input.wallets!.wallets.push(record(who));}
  const result=analyzeWalletScreening(input);assert.equal(result.setups.length,8);assert.ok(result.setups.some(s=>s.wallet===addr(2)&&s.status==='withdrawn'));
  const signal=parseSignal({source:'gmgn',sourceEventId:'bounded-withdrawal',token,occurredAt:iso(900)}),primary:Check={status:'pass',reasons:[],checkedAt:input.now,facts:{}};
  assert.equal(mergeWalletSupport(primary,result,signal,new Date(input.now))?.status,'unknown');
});

test('the withdrawal qualification helper rejects missing identity, stale profiles and unproven prior relations',()=>{
  const input=fixture();input.trades.push({...input.trades[0],priceUsd:'2',source:'screening_current_analysis'});const s=setup(input);assert.equal(qualifiedWalletWithdrawal(s),true);
  for(const reason of ['WALLET_PROFILE_MISSING_OR_STALE','PUBLIC_WALLET_LABEL_UNVERIFIED','PRECURSOR_RELATION_NOT_KNOWN_BEFORE_BUY','PRECURSOR_PRIOR_LEAD_EVIDENCE_INSUFFICIENT'])
    assert.equal(qualifiedWalletWithdrawal({...s,reasons:[...s.reasons,reason]}),false);
  for(const patch of [{realizedProfitUsd:999},{realizedProfitUsd:Infinity},{percentile:74.99},{percentile:Infinity},{percentile:101},{cohortSize:9},{cohortSize:NaN}])
    assert.equal(qualifiedWalletWithdrawal({...s,profit:{...s.profit!,...patch}}),false);
  assert.equal(qualifiedWalletWithdrawal({...s,status:'watch'}),false);assert.equal(qualifiedWalletWithdrawal({...s,trigger:{...s.trigger,usd:'99'}}),false);
});

test('unqualified precursor withdrawals cannot crowd out a qualified public withdrawal',()=>{
  const input=fixture();input.trades.push({...input.trades[0],priceUsd:'2',source:'screening_current_analysis'});
  for(let i=0;i<12;i++){const who=20+i,p=structuredClone(input.profiles[0]);p.address=addr(who);p.computedAt=iso(1000);
    input.profiles.push(p);input.trades.push(trade(who,905+i),trade(who,940+i,{side:'sell'}));input.wallets!.wallets.push(record(who));}
  const result=analyzeWalletScreening(input);assert.equal(result.setups.length,8);assert.equal(result.setups[0].wallet,addr(2));
  assert.equal(qualifiedWalletWithdrawal(result.setups[0]),true);assert.ok(result.setups.slice(1).every(s=>!qualifiedWalletWithdrawal(s)));
  assert.ok(result.setups.slice(1).every(s=>s.status==='withdrawn'));
});

test('missing, tiny or invalid USD trigger amount is watch with zero priority',()=>{
  for(const usd of [undefined,null,'0','99.99','-1','Infinity','1e13']){const input=fixture();input.trades[0].usd=usd;const s=setup(input);
    assert.equal(s.status,'watch');assert.equal(s.priorityScore,0);assert.ok(s.reasons.includes('WALLET_TRIGGER_BUY_TOO_SMALL_OR_UNKNOWN'));}
  const input=fixture();input.trades[0].usd='100';assert.equal(setup(input).status,'supported');
});

test('current price is bound to the token and fresh; historic highs or missing trade prices never substitute',()=>{
  const edits:((i:WalletScreeningInput)=>void)[]=[i=>{i.snapshot=undefined;},i=>{i.snapshot!.token={...token,address:addr(999)};},i=>{i.snapshot!.fetchedAt=iso(879);},
    i=>{(i.snapshot!.info as any).address=addr(999);},i=>{(i.snapshot!.info as any).chain='sol';},i=>{(i.snapshot!.info as any).price={ath_price:'1.1'};},
    i=>{i.snapshot!.diagnostics=[{section:'info',status:'unavailable'}];},i=>{delete i.trades[0].priceUsd;}];
  for(const edit of edits){const input=fixture();edit(input);const s=setup(input);assert.equal(s.status,'watch');assert.equal(s.chasePct,undefined);}
});

test('price guards include their boundaries and stop both chasing a jump and entering a sharp drop',()=>{
  for(const [price,status,reason] of [['1.4','supported',''],['0.8','supported',''],['1.401','watch','WALLET_ENTRY_CHASE_TOO_HIGH'],['0.799','watch','WALLET_ENTRY_PRICE_DROPPED']] as const){
    const input=fixture();(input.snapshot!.info as any).price.price=price;const s=setup(input);assert.equal(s.status,status);if(reason)assert.ok(s.reasons.includes(reason));}
});

test('future, wrong-chain, wrong-token, invalid-address, invalid-hash and stale buys cannot trigger setups',()=>{
  const patches:Partial<WalletTradeObservation>[]=[{eventAt:iso(1001),observedAt:iso(1002)},{observedAt:iso(899)},{chain:'robinhood'},{tokenAddress:addr(999)},
    {wallet:'invalid'},{txHash:'invalid'},{eventAt:iso(399),observedAt:iso(400)}];
  for(const patch of patches){const input=fixture();input.trades[0]={...input.trades[0],...patch};assert.equal(analyzeWalletScreening(input).setups.length,0);}
});

test('stale profiles and truncated input cannot issue support',()=>{
  for(const edit of [(i:WalletScreeningInput)=>{i.profiles[1].freshUntil=iso(999);},(i:WalletScreeningInput)=>{i.profiles[1].status='stale';},(i:WalletScreeningInput)=>{i.truncated=true;}]){
    const input=fixture();edit(input);assert.equal(setup(input).status,'watch');}
});

test('support expiry never extends beyond a required source or trigger deadline',()=>{
  const input=fixture();input.profiles[1].freshUntil=iso(1010);assert.equal(analyzeWalletScreening(input).validUntil,iso(1010));
  input.profiles[1].freshUntil=iso(2000);input.trades[0].eventAt=iso(420);input.trades[0].observedAt=iso(421);assert.equal(analyzeWalletScreening(input).validUntil,iso(1020));
});

test('one withdrawing public wallet does not reject an independent public entry',()=>{
  const input=fixture(),other=profile(5);other.groups=structuredClone(input.profiles[1].groups);other.metrics.vendorProfit=structuredClone(input.profiles[1].metrics.vendorProfit);
  input.profiles.push(other);input.wallets!.wallets.push(record(5));input.trades.push(trade(2,925,{side:'sell'}),trade(5,905));
  const result=analyzeWalletScreening(input);assert.equal(result.status,'supported');assert.equal(result.setups.find(s=>s.wallet===addr(2))!.status,'withdrawn');assert.equal(result.setups.find(s=>s.wallet===addr(5))!.status,'supported');
});

test('the same logic supports Solana base58 identities and EVM Robinhood without mixing chains',()=>{
  for(const chain of ['solana','robinhood'] as const){const input=fixture();const a=(n:number)=>chain==='solana'?bs58.encode(new Uint8Array(32).fill(n)):addr(n);
    input.token={chain,address:a(100)};input.profiles=input.profiles.slice(1);input.profiles[0].chain=chain;input.profiles[0].address=a(2);
    input.trades=input.trades.map((t,i)=>({...t,chain,wallet:a(i+2),tokenAddress:a(100),txHash:chain==='solana'?bs58.encode(new Uint8Array(64).fill(i+10)):t.txHash}));
    input.wallets!.summary.token=input.token;input.wallets!.wallets=input.wallets!.wallets.map((w,i)=>({...w,chain,address:a(i+1)}));
    input.snapshot!.token=input.token;input.snapshot!.info={chain:chain==='solana'?'sol':chain,address:a(100),price:{price:'1.1'}};
    assert.equal(analyzeWalletScreening(input).status,'supported');assert.equal(setup(input).wallet,a(2));}
});

test('deterministic setup IDs and bounded output do not mutate input or synthesize live execution permission',()=>{
  const input=fixture(),before=JSON.stringify(input),first=analyzeWalletScreening(input),second=analyzeWalletScreening(input);
  assert.deepEqual(first,second);assert.equal(JSON.stringify(input),before);assert.equal(first.setups[0].id.length,64);
  assert.ok(first.setups.length<=8);assert.ok(first.priorityScore<=20);assert.equal('executionEnabled' in first,false);
  const invalid=analyzeWalletScreening({...input,now:'bad'});assert.equal(invalid.status,'unavailable');assert.ok(invalid.reasons.includes('WALLET_SCREENING_INPUT_INVALID'));
});
