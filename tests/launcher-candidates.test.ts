import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {
  LauncherCandidates,type LauncherCandidateProfileRoute,type LauncherRealtimeObservation,type LauncherActivityObservation,
} from '../src/launcher-candidates.js';
import type {WalletProfile} from '../src/wallet-profiles.js';
import type {WalletRoleEvidence,WalletRoleQualification} from '../src/wallet-role-analysis.js';

const base=Date.parse('2026-11-18T00:00:00.000Z');
const iso=(seconds:number)=>new Date(base+seconds*1000).toISOString();
const address=(id:number)=>'0x'+id.toString(16).padStart(40,'0');
const tx=(id:number)=>'0x'+id.toString(16).padStart(64,'0');
const solAddress=(id:number)=>{const bytes=Buffer.alloc(32);bytes.writeUInt32BE(id,28);return bs58.encode(bytes);};
const solTx=(id:number)=>{const bytes=Buffer.alloc(64);bytes.writeUInt32BE(id,60);return bs58.encode(bytes);};

function roleQualification(wallet:string,peer:string,knownAt=iso(950),evidenceAt=iso(100),network:'bsc'|'robinhood'|'solana'='bsc'):WalletRoleQualification {
  const evidenceBase=(Date.parse(evidenceAt)-base)/1000;
  const evidence=Array.from({length:3},(_,index):WalletRoleEvidence=>({
    tokenAddress:network==='solana'?solAddress(100+index):address(100+index),direction:'lead',reason:'test lead',lagSeconds:20,
    candidateBuy:{wallet,txHash:network==='solana'?solTx(100+index):tx(100+index),eventAt:iso(evidenceBase+index*10),observedAt:iso(evidenceBase+1+index*10),source:'test'},
    leaderBuy:{wallet:peer,txHash:network==='solana'?solTx(200+index):tx(200+index),eventAt:iso(evidenceBase+20+index*10),observedAt:iso(evidenceBase+21+index*10),source:'test'},
  }));
  return {version:1,knownAt,evidence};
}

function profile(id:number,route:LauncherCandidateProfileRoute,options:{evidenceAt?:string;computedAt?:string;invalidQualification?:boolean;
  prospectivePreTokens?:number;selectedTokens?:number;forwardObservedTokens?:number;qualificationKnownAt?:string;
  chain?:'bsc'|'robinhood'|'solana';directPrecursor?:boolean}={}):WalletProfile {
  const network=options.chain??'bsc',wallet=network==='solana'?solAddress(id):address(id),peer=network==='solana'?solAddress(900+id):address(900+id),
    token=(value:number)=>network==='solana'?solAddress(value):address(value),hash=(value:number)=>network==='solana'?solTx(value):tx(value),
    evidenceAt=options.evidenceAt??iso(900),computedAt=options.computedAt??iso(1000);
  const value:WalletProfile={chain:network,address:wallet,version:1,computedAt,evidenceThroughAt:evidenceAt,
    freshUntil:iso(20_000),status:'current',source:'wallet_history',sampleOnly:true,ownership:'unknown',groups:[],
    metrics:{observedEvents:3,buyEvents:3,sellEvents:0,distinctTokens:3,lastEventAt:evidenceAt,
      associations:{leaders:1,distinctTokens:3,forwardTokens:route==='B'?1:0},chain:{transactions:0,transfers:0}},
    counterparties:[],limitations:[]};
  if(route==='A'){
    value.groups.push({id:options.directPrecursor?'market_precursor_pattern':'market_pre_candidate',firstObservedAt:iso(500),evidenceCount:1,reason:'test'});
    const prospectivePreTokens=options.prospectivePreTokens??(options.directPrecursor?3:1),selectedTokens=options.selectedTokens??(options.directPrecursor?3:1);
    const evidenceBase=(Date.parse(evidenceAt)-base)/1000;
    const screeningEvidence=Array.from({length:options.directPrecursor?3:1},(_,index)=>({tokenAddress:token(500+id+index),direction:'pre' as const,
      prospective:true,reason:'test',buy:{chain:network,wallet,tokenAddress:token(500+id+index),txHash:hash(500+id+index),side:'buy' as const,
        eventAt:iso(evidenceBase+index),observedAt:iso(evidenceBase+index),source:'test'},
      marketFirstSeen:{id:`market-${id}-${index}`,source:'gmgn_market_discovery' as const,kind:'first_seen' as const,chain:network,
        tokenAddress:token(500+id+index),firstSeenLowerBound:iso(evidenceBase+index+1),firstSeenUpperBound:iso(evidenceBase+index+2),
        feed:'trending' as const,window:'5m',leftCensored:false}}));
    value.initiatorAnalysis={version:1,chain:network,wallet,computedAt,status:'current',classification:options.directPrecursor?'precursor':'candidate',sampleOnly:true,
      ownership:'unknown',tradingEnabled:false,dumpAssessment:'unknown',directionalTokens:{pre:1,post:0,ambiguous:0,outsideWindow:0,unmatched:0},
      totalCandidateTokens:selectedTokens,selectedTokens,matchedTokens:selectedTokens,preShare:1,prospectivePreTokens,postActivationExitTokens:0,
      pendingTokens:0,unobservedTokens:0,evidence:[],screeningEvidence,
      reasons:[],counterEvidence:[],limitations:[],
      method:{minimumDirectionalTokens:3,minimumDirectionShare:.75,nearTimeSeconds:2,maximumLagSeconds:86400,evidenceLimit:6,qualificationEvidenceLimit:30}};
    if(options.directPrecursor)value.initiatorAnalysis.qualification={version:1,classification:'precursor',knownAt:iso(Math.max(900,evidenceBase+10)),
      proofHash:createHash('sha256').update(JSON.stringify(screeningEvidence)).digest('hex'),evidence:structuredClone(screeningEvidence)};
  }else{
    value.groups.push({id:'precursor_pattern',firstObservedAt:iso(500),evidenceCount:3,reason:'test'},
      {id:'forward_validated',firstObservedAt:iso(600),evidenceCount:1,reason:'test'});
    const qualification=roleQualification(wallet,peer,options.qualificationKnownAt,options.evidenceAt,network);
    if(options.invalidQualification)qualification.evidence[0].leaderBuy!.txHash=qualification.evidence[0].candidateBuy!.txHash;
    value.roleAnalysis={version:1,computedAt,status:'current',ownership:'unknown',sampleOnly:true,limitations:[],
      method:{minimumDirectionalTokens:3,minimumDirectionShare:.75,nearTimeSeconds:2,maximumLagSeconds:86400,evidenceLimitPerPeer:6,screeningEvidenceLimitPerPeer:30},
      peers:[{address:peer,classification:'precursor_pattern',directionalPattern:'precursor_pattern',ownership:'unknown',
        directionalTokens:{lead:3,follow:0,ambiguous:0,unmatched:0,outsideWindow:0},matchedTokens:3,totalCandidateTokens:3,
        leadShare:1,followShare:0,medianLagSeconds:20,lagMadSeconds:0,forwardObservedTokens:options.forwardObservedTokens??1,pendingTokens:0,unobservedTokens:0,
        evidence:qualification.evidence,reasons:[],counterEvidence:[],alternativeExplanations:[],
        funding:{direct:0,common:0,excluded:0,ownership:'unknown'},qualification}]};
  }
  return value;
}

function createProfiles(path:string,rows:{profile:WalletProfile;route:LauncherCandidateProfileRoute}[]):void {
  const db=new DatabaseSync(path);db.exec(`
    CREATE TABLE wp_profiles(chain TEXT,address TEXT,computed_at TEXT NOT NULL,fresh_until TEXT NOT NULL,data TEXT NOT NULL,source_wallet INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chain,address));
    CREATE TABLE wp_groups(chain TEXT,address TEXT,group_id TEXT,first_at TEXT NOT NULL,PRIMARY KEY(chain,address,group_id));
    CREATE INDEX wp_groups_filter ON wp_groups(group_id,chain,address);
  `);
  const insertProfile=db.prepare('INSERT INTO wp_profiles VALUES (?,?,?,?,?,1)'),insertGroup=db.prepare('INSERT INTO wp_groups VALUES (?,?,?,?)');
  for(const row of rows){insertProfile.run(row.profile.chain,row.profile.address,row.profile.computedAt,row.profile.freshUntil,JSON.stringify(row.profile));
    for(const group of row.profile.groups)insertGroup.run(row.profile.chain,row.profile.address,group.id,group.firstObservedAt);}
  db.close();
}

type FixtureOptions=Omit<Partial<ConstructorParameters<typeof LauncherCandidates>[0]>,'database'|'profileDatabase'|'now'>;
function fixture(rows:{profile:WalletProfile;route:LauncherCandidateProfileRoute}[],options:FixtureOptions={}){
  const dir=mkdtempSync(join(tmpdir(),'launcher-candidates-')),profiles=join(dir,'profiles.sqlite'),database=join(dir,'candidates.sqlite');
  createProfiles(profiles,rows);const clock={value:base+10_000_000};
  const store=new LauncherCandidates({database,profileDatabase:profiles,now:()=>new Date(clock.value),...options});
  return {dir,profiles,database,store,clock,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('indexed profile routes select A and validated B while rejecting malformed precursor proof',()=>{
  const a=profile(1,'A'),b=profile(2,'B'),invalid=profile(3,'B',{invalidQualification:true}),f=fixture([
    {profile:a,route:'A'},{profile:b,route:'B'},{profile:invalid,route:'B'},
  ]);
  try {
    const status=f.store.refresh();assert.equal(status.records,2);assert.deepEqual(status.routeCounts,{A:1,B:1});
    assert.equal(f.store.get('bsc',a.address)?.route,'A');assert.equal(f.store.get('bsc',b.address)?.route,'B');
    assert.equal(f.store.get('bsc',a.address)?.tier,'direct_candidate');assert.equal(f.store.get('bsc',b.address)?.tier,'peer_precursor');
    assert.equal(f.store.get('bsc',invalid.address),undefined);
  } finally {f.close();}
});

test('quality gates require prospective A share and recent same-peer forward evidence for B',()=>{
  const boundary=10_000-30*86_400,acceptedA=profile(1,'A',{prospectivePreTokens:1,selectedTokens:10}),
    weakA=profile(2,'A',{prospectivePreTokens:1,selectedTokens:11}),
    acceptedB=profile(3,'B',{qualificationKnownAt:iso(boundary),evidenceAt:iso(boundary-100)}),
    staleB=profile(4,'B',{qualificationKnownAt:iso(boundary-1),evidenceAt:iso(boundary-101)}),
    mismatchedB=profile(5,'B',{forwardObservedTokens:0});
  const f=fixture([{profile:acceptedA,route:'A'},{profile:weakA,route:'A'},{profile:acceptedB,route:'B'},
    {profile:staleB,route:'B'},{profile:mismatchedB,route:'B'}]);
  try {const status=f.store.refresh();assert.equal(status.records,2);
    assert.equal(f.store.get('bsc',acceptedA.address)?.route,'A');assert.equal(f.store.get('bsc',acceptedB.address)?.route,'B');
    assert.equal(f.store.get('bsc',weakA.address),undefined);assert.equal(f.store.get('bsc',staleB.address),undefined);
    assert.equal(f.store.get('bsc',mismatchedB.address),undefined);
  } finally {f.close();}
});

test('mature direct precursors are retained, explicitly tiered and win a one-slot pool over weak candidates',()=>{
  const weak=profile(1,'A',{chain:'solana'}),mature=profile(2,'A',{chain:'solana',directPrecursor:true}),
    f=fixture([{profile:weak,route:'A'},{profile:mature,route:'A'}],{cap:1});
  try {const status=f.store.refresh();assert.equal(status.records,1);
    const candidate=f.store.get('solana',mature.address)!;assert.equal(candidate.tier,'direct_precursor');
    assert.equal(candidate.route,'A');assert.equal(f.store.get('solana',weak.address),undefined);
    assert.deepEqual(f.store.streamTargets('solana',1),[mature.address]);assert.deepEqual(f.store.matureAddresses('solana'),[mature.address]);
  } finally {f.close();}
});

test('a self-consistent hash cannot promote a malformed market timing proof to mature precursor',()=>{
  const corrupt=profile(31,'A',{chain:'solana',directPrecursor:true}),qualification=corrupt.initiatorAnalysis!.qualification!;
  qualification.evidence[0].marketFirstSeen!.leftCensored=true;
  qualification.proofHash=createHash('sha256').update(JSON.stringify(qualification.evidence)).digest('hex');
  const f=fixture([{profile:corrupt,route:'A'}]);
  try {f.store.refresh();assert.equal(f.store.get('solana',corrupt.address),undefined);}
  finally {f.close();}
});

test('exact-token entry evidence is causal, retains earlier tokens and withdraws on a later observed sell',()=>{
  const mature=profile(1,'A',{chain:'solana',directPrecursor:true}),weak=profile(2,'A',{chain:'solana'}),
    f=fixture([{profile:mature,route:'A'},{profile:weak,route:'A'}]),tokenA=solAddress(700),tokenB=solAddress(701),
    decision=new Date(fixtureClock()).toISOString(),firstSignal=new Date(fixtureClock()-10_000).toISOString(),
    matureBuyAt=new Date(fixtureClock()-30_000).toISOString(),matureObservedAt=new Date(fixtureClock()-29_000).toISOString(),
    weakBuyAt=new Date(fixtureClock()-20_000).toISOString(),weakObservedAt=new Date(fixtureClock()-19_000).toISOString();
  function fixtureClock(){return base+10_000_000;}
  try {
    f.store.refresh();
    assert.equal(f.store.observeActivity({chain:'solana',wallet:mature.address,checkedAt:matureObservedAt,eventAt:matureBuyAt,
      classification:'buy',confirmation:'confirmed',txHash:solTx(700),tokenAddress:tokenA}),true);
    assert.equal(f.store.observeActivity({chain:'solana',wallet:mature.address,checkedAt:new Date(f.clock.value-15_000).toISOString(),
      eventAt:new Date(f.clock.value-16_000).toISOString(),classification:'buy',confirmation:'included',txHash:solTx(701),tokenAddress:tokenB}),true);
    assert.equal(f.store.observeActivity({chain:'solana',wallet:weak.address,checkedAt:weakObservedAt,eventAt:weakBuyAt,
      classification:'buy',confirmation:'included',txHash:solTx(702),tokenAddress:tokenA}),true);
    let evidence=f.store.entryEvidence({tokenAddress:tokenA,firstSignalAt:firstSignal,decisionAt:decision});
    assert.equal(evidence.status,'strong');assert.equal(evidence.authorizesTrade,false);assert.equal(evidence.sampleOnly,true);
    assert.deepEqual(evidence.items.map(item=>[item.wallet,item.route,item.tier]),[
      [mature.address,'A','direct_precursor'],[weak.address,'A','direct_candidate'],
    ]);
    assert.equal(evidence.items[0].qualifiedAt,mature.initiatorAnalysis!.qualification!.knownAt);assert.equal(evidence.items[0].buyAt,matureBuyAt);
    const sellAt=new Date(f.clock.value-5_000).toISOString(),sellObservedAt=new Date(f.clock.value-4_000).toISOString();
    assert.equal(f.store.observeActivity({chain:'solana',wallet:mature.address,checkedAt:sellObservedAt,eventAt:sellAt,
      classification:'sell',confirmation:'confirmed',txHash:solTx(703),tokenAddress:tokenA}),true);
    evidence=f.store.entryEvidence({tokenAddress:tokenA,firstSignalAt:firstSignal,decisionAt:decision});
    assert.equal(evidence.status,'withdrawn');assert.equal(evidence.items[0].soldAt,sellAt);
    assert.equal(f.store.retractActivity({chain:'solana',wallet:mature.address,checkedAt:decision,txHash:solTx(703)}),true);
    evidence=f.store.entryEvidence({tokenAddress:tokenA,firstSignalAt:firstSignal,decisionAt:decision});assert.equal(evidence.status,'strong');
    assert.equal(f.store.retractActivity({chain:'solana',wallet:mature.address,checkedAt:decision,txHash:solTx(700)}),true);
    evidence=f.store.entryEvidence({tokenAddress:tokenA,firstSignalAt:firstSignal,decisionAt:decision});assert.equal(evidence.status,'advisory');
    assert.equal(f.store.observeActivity({chain:'solana',wallet:weak.address,checkedAt:sellObservedAt,eventAt:sellAt,
      classification:'sell',confirmation:'confirmed',txHash:solTx(704),tokenAddress:tokenA}),true);
    evidence=f.store.entryEvidence({tokenAddress:tokenA,firstSignalAt:firstSignal,decisionAt:decision});assert.equal(evidence.status,'advisory');
    assert.equal(f.store.observeActivity({chain:'solana',wallet:mature.address,checkedAt:matureObservedAt,eventAt:matureBuyAt,
      classification:'buy',confirmation:'confirmed',txHash:solTx(700),tokenAddress:tokenA}),false);
  } finally {f.close();}
});

test('entry evidence preserves post-signal observations for controller timing checks and rejects malformed activity',()=>{
  const weak=profile(1,'A',{chain:'solana'}),f=fixture([{profile:weak,route:'A'}]),token=solAddress(800),other=solAddress(801),
    decision=new Date(f.clock.value).toISOString(),firstSignal=new Date(f.clock.value-10_000).toISOString();
  try {f.store.refresh();
    assert.equal(f.store.observeActivity({chain:'solana',wallet:weak.address,checkedAt:new Date(f.clock.value-5_000).toISOString(),
      eventAt:new Date(f.clock.value-30_000).toISOString(),classification:'buy',confirmation:'confirmed',txHash:solTx(800),tokenAddress:token}),true);
    const postSignal=f.store.entryEvidence({tokenAddress:token,firstSignalAt:firstSignal,decisionAt:decision});
    assert.equal(postSignal.status,'advisory');assert.ok(postSignal.items.every(item=>item.observedAt>firstSignal));
    assert.equal(f.store.entryEvidence({tokenAddress:token,decisionAt:decision}).status,'advisory');
    assert.equal(f.store.observeActivity({chain:'solana',wallet:weak.address,checkedAt:decision,eventAt:new Date(f.clock.value-2_000).toISOString(),
      classification:'buy',confirmation:'confirmed',txHash:solTx(801),tokenAddress:token,
      trades:[{tokenAddress:other,side:'buy'}]}),true);
    assert.equal(f.store.entryEvidence({tokenAddress:other,decisionAt:decision}).status,'none');
    assert.equal(f.store.observeActivity({chain:'solana',wallet:weak.address,checkedAt:decision,eventAt:decision,
      classification:'transfer',confirmation:'confirmed',txHash:solTx(802),tokenAddress:other}),false);
    assert.equal(f.store.entryEvidence({tokenAddress:token,decisionAt:decision,maxAgeMs:10_000}).status,'none');
  } finally {f.close();}
});

test('entry evidence keeps active mature support when another mature wallet sold the same token',()=>{
  const active=profile(11,'A',{chain:'solana',directPrecursor:true}),exited=profile(12,'A',{chain:'solana',directPrecursor:true}),
    f=fixture([{profile:active,route:'A'},{profile:exited,route:'A'}]),token=solAddress(811),decision=new Date(f.clock.value).toISOString();
  try {f.store.refresh();
    for(const [index,wallet] of [active.address,exited.address].entries())assert.equal(f.store.observeActivity({chain:'solana',wallet,
      eventAt:new Date(f.clock.value-30_000+index*1000).toISOString(),checkedAt:new Date(f.clock.value-29_000+index*1000).toISOString(),
      classification:'buy',confirmation:'confirmed',txHash:solTx(811+index),tokenAddress:token}),true);
    assert.equal(f.store.observeActivity({chain:'solana',wallet:exited.address,eventAt:new Date(f.clock.value-10_000).toISOString(),
      checkedAt:new Date(f.clock.value-9_000).toISOString(),classification:'sell',confirmation:'confirmed',txHash:solTx(813),tokenAddress:token}),true);
    const evidence=f.store.entryEvidence({tokenAddress:token,decisionAt:decision,maxAgeMs:6*60*60_000});
    assert.equal(evidence.status,'strong');assert.equal(evidence.items.length,2);
    assert.equal(evidence.items.find(item=>item.wallet===active.address)?.soldAt,undefined);
    assert.ok(evidence.items.find(item=>item.wallet===exited.address)?.soldAt);
    assert.ok(evidence.reasons.includes('OTHER_MATURE_LAUNCHER_SELL_OBSERVED'));
  } finally {f.close();}
});

test('entry evidence uses an inclusive six-hour lower bound and rejects a wider request',()=>{
  const boundary=profile(21,'A',{chain:'solana',directPrecursor:true}),older=profile(22,'A',{chain:'solana',directPrecursor:true}),
    f=fixture([{profile:boundary,route:'A'},{profile:older,route:'A'}]),token=solAddress(821);
  try {f.store.refresh();f.clock.value+=7*60*60_000;
    const decision=new Date(f.clock.value).toISOString(),lower=f.clock.value-6*60*60_000;
    assert.equal(f.store.observeActivity({chain:'solana',wallet:boundary.address,eventAt:new Date(lower).toISOString(),
      checkedAt:new Date(lower+1).toISOString(),classification:'buy',confirmation:'confirmed',txHash:solTx(821),tokenAddress:token}),true);
    assert.equal(f.store.observeActivity({chain:'solana',wallet:older.address,eventAt:new Date(lower-1).toISOString(),
      checkedAt:new Date(lower).toISOString(),classification:'buy',confirmation:'confirmed',txHash:solTx(822),tokenAddress:token}),true);
    const evidence=f.store.entryEvidence({tokenAddress:token,decisionAt:decision,maxAgeMs:6*60*60_000});
    assert.deepEqual(evidence.items.map(item=>item.wallet),[boundary.address]);
    assert.throws(()=>f.store.entryEvidence({tokenAddress:token,decisionAt:decision,maxAgeMs:6*60*60_000+1}),
      /LAUNCHER_ENTRY_EVIDENCE_QUERY_INVALID/);
  } finally {f.close();}
});

test('entry evidence never infers an observation time from legacy latest-side columns and the event ledger is bounded per wallet',()=>{
  const weak=profile(1,'A',{chain:'solana'}),f=fixture([{profile:weak,route:'A'}]),legacyToken=solAddress(900),
    db=()=>((f.store as unknown as {db:DatabaseSync}).db);
  try {f.store.refresh();const legacyAt=new Date(f.clock.value-20_000).toISOString();
    db().prepare(`UPDATE lc_candidates SET last_verified_buy_at=?,last_verified_buy_tx=?,last_verified_buy_token=?,
      last_verified_buy_observed_at=NULL WHERE chain='solana' AND address=?`).run(legacyAt,solTx(900),legacyToken,weak.address);
    assert.equal(f.store.entryEvidence(legacyToken,new Date(f.clock.value).toISOString()).status,'none');
    for(let index=0;index<70;index++)assert.equal(f.store.observeActivity({chain:'solana',wallet:weak.address,
      checkedAt:new Date(f.clock.value-(70-index)*1000).toISOString(),eventAt:new Date(f.clock.value-(70-index)*1000).toISOString(),
      classification:'buy',confirmation:'confirmed',txHash:solTx(1000+index),tokenAddress:solAddress(1000+index)}),true);
    assert.equal(Number((db().prepare("SELECT COUNT(*) AS n FROM lc_trade_events WHERE chain='solana' AND wallet=?").get(weak.address) as {n:number}).n),64);
    assert.equal(f.store.entryEvidence(solAddress(1000),new Date(f.clock.value).toISOString()).status,'none');
    assert.equal(f.store.entryEvidence(solAddress(1069),new Date(f.clock.value).toISOString()).status,'advisory');
  } finally {f.close();}
});

test('computedAt never promotes an old seed; evidence time alone establishes fresh_verified',()=>{
  const historical=profile(1,'A',{evidenceAt:iso(100),computedAt:iso(9990)}),fresh=profile(2,'A',{evidenceAt:iso(9950),computedAt:iso(200)}),
    f=fixture([{profile:historical,route:'A'},{profile:fresh,route:'A'}],{freshAfterSec:200});
  try {
    f.store.refresh();assert.equal(f.store.get('bsc',historical.address)?.state,'historical_seed');
    assert.equal(f.store.get('bsc',fresh.address)?.state,'fresh_verified');
  } finally {f.close();}
});

test('counterparty trades and generic chain observations cannot renew candidate freshness',()=>{
  const a=profile(1,'A',{evidenceAt:iso(100)}),b=profile(2,'B',{evidenceAt:iso(100)});
  a.metrics.chain.lastObservedAt=iso(9_990);
  const qualification=b.roleAnalysis!.peers[0].qualification!;qualification.knownAt=iso(9_995);
  b.roleAnalysis!.computedAt=iso(9_996);b.computedAt=iso(9_997);
  qualification.evidence.forEach((row,index)=>{row.leaderBuy!.eventAt=iso(9_950+index*10);row.leaderBuy!.observedAt=iso(9_951+index*10);});
  const f=fixture([{profile:a,route:'A'},{profile:b,route:'B'}],{freshAfterSec:200});
  try {f.store.refresh();assert.equal(f.store.get('bsc',a.address)?.state,'historical_seed');
    assert.equal(f.store.get('bsc',b.address)?.state,'historical_seed');}
  finally {f.close();}
});

test('realtime, verified activity and coverage are distinct persisted states with bounded freshness',()=>{
  const one=profile(1,'A',{evidenceAt:iso(100)}),two=profile(2,'B',{evidenceAt:iso(100)}),f=fixture([{profile:one,route:'A'},{profile:two,route:'B'}],
    {freshAfterSec:60,liveAfterSec:30,coverageAfterSec:20});
  try {
    f.store.refresh();
    const realtime:LauncherRealtimeObservation={chain:'bsc',wallet:one.address,observedAt:new Date(f.clock.value-5_000).toISOString(),source:'wallet_fast'};
    assert.equal(f.store.observeRealtime(realtime),true);assert.equal(f.store.get('bsc',one.address)?.state,'live_seen');
    const activity:LauncherActivityObservation={chain:'bsc',wallet:two.address,checkedAt:new Date(f.clock.value-4_000).toISOString(),
      eventAt:new Date(f.clock.value-6_000).toISOString(),classification:'buy',confirmation:'confirmed',txHash:tx(999)};
    assert.equal(f.store.observeActivity(activity),true);assert.equal(f.store.get('bsc',two.address)?.state,'fresh_verified');
    f.store.replaceCoverage('bsc',[one.address],new Date(f.clock.value-3_000).toISOString());
    assert.equal(f.store.get('bsc',one.address)?.state,'monitored');assert.equal(f.store.get('bsc',one.address)?.dimensions.realtimeReady,true);
    assert.equal(f.store.get('bsc',two.address)?.state,'fresh_verified');
    f.store.replaceCoverage('bsc',[two.address],new Date(f.clock.value-2_000).toISOString());
    assert.equal(f.store.get('bsc',one.address)?.state,'live_seen');assert.equal(f.store.get('bsc',two.address)?.state,'monitored');
    assert.equal(f.store.get('bsc',two.address)?.dimensions.verifiedTradeMonitored,true);
    f.store.close();const reopened=new LauncherCandidates({database:f.database,profileDatabase:f.profiles,now:()=>new Date(f.clock.value),freshAfterSec:60,liveAfterSec:30,coverageAfterSec:20});
    f.store=reopened;assert.equal(reopened.get('bsc',two.address)?.state,'monitored');
    f.clock.value+=31_000;assert.equal(reopened.get('bsc',one.address)?.state,'historical_seed');
    assert.equal(reopened.get('bsc',two.address)?.state,'fresh_verified');assert.equal(reopened.get('bsc',two.address)?.monitored,false);
  } finally {f.close();}
});

test('realtime batch deduplicates wallets, keeps the latest observation and never overwrites newer liveness',()=>{
  const one=profile(1,'A',{evidenceAt:iso(100)}),two=profile(2,'A',{evidenceAt:iso(100)}),
    f=fixture([{profile:one,route:'A'},{profile:two,route:'A'}],{freshAfterSec:60,liveAfterSec:30});
  try {
    f.store.refresh();const older=new Date(f.clock.value-8_000).toISOString(),newer=new Date(f.clock.value-2_000).toISOString(),
      stale=new Date(f.clock.value-5_000).toISOString();
    assert.equal(f.store.observeRealtimeBatch([
      {chain:'bsc',wallet:one.address,observedAt:older,source:'wallet_fast'},
      {chain:'bsc',wallet:one.address,observedAt:newer,source:'wallet_fast'},
      {chain:'bsc',wallet:two.address,observedAt:older,source:'wallet_fast'},
      {chain:'bsc',wallet:address(9999),observedAt:newer,source:'wallet_fast'},
    ]),2);
    assert.equal(f.store.get('bsc',one.address)?.liveSeenAt,newer);
    assert.equal(f.store.get('bsc',two.address)?.liveSeenAt,older);
    assert.equal(f.store.observeRealtimeBatch([{chain:'bsc',wallet:one.address,observedAt:stale,source:'wallet_fast'}]),0);
    assert.equal(f.store.get('bsc',one.address)?.liveSeenAt,newer);
    assert.throws(()=>f.store.observeRealtimeBatch([{chain:'bsc',wallet:one.address,observedAt:newer,checkedAt:newer,source:'wallet_fast'}]));
  } finally {f.close();}
});

test('coverage renews an unchanged ACK set and clears only the removed difference',()=>{
  const one=profile(1,'A'),two=profile(2,'A'),three=profile(3,'A'),f=fixture([
    {profile:one,route:'A'},{profile:two,route:'A'},{profile:three,route:'A'}],{coverageAfterSec:20});
  try {f.store.refresh();const first=new Date(f.clock.value-5_000).toISOString(),renewed=new Date(f.clock.value-3_000).toISOString(),
    changed=new Date(f.clock.value-1_000).toISOString();
    assert.equal(f.store.replaceCoverage('bsc',[one.address,two.address],first),2);
    assert.equal(f.store.replaceCoverage('bsc',[two.address,one.address],renewed),2);
    assert.equal(f.store.get('bsc',one.address)?.coverageAt,renewed);assert.equal(f.store.get('bsc',two.address)?.coverageAt,renewed);
    assert.equal(f.store.get('bsc',three.address)?.monitored,false);
    assert.equal(f.store.replaceCoverage('bsc',[two.address,three.address],changed),2);
    assert.equal(f.store.get('bsc',one.address)?.monitored,false);assert.equal(f.store.get('bsc',one.address)?.coverageAt,undefined);
    assert.equal(f.store.get('bsc',two.address)?.coverageAt,changed);assert.equal(f.store.get('bsc',three.address)?.coverageAt,changed);
  } finally {f.close();}
});

test('coverage set update matches candidates once and clears candidates absent from the selected set',()=>{
  const one=profile(1,'A'),two=profile(2,'A'),f=fixture([{profile:one,route:'A'},{profile:two,route:'A'}]);
  try {f.store.refresh();const first=new Date(f.clock.value-2_000).toISOString(),next=new Date(f.clock.value-1_000).toISOString();
    assert.equal(f.store.replaceCoverage('bsc',[one.address,two.address],first),2);
    assert.equal(f.store.replaceCoverage('bsc',[two.address,two.address,address(9999)],next),1,
      'duplicates and wallets outside the candidate table do not inflate the matched count');
    assert.equal(f.store.get('bsc',one.address)?.monitored,false);assert.equal(f.store.get('bsc',one.address)?.coverageAt,undefined);
    assert.equal(f.store.get('bsc',two.address)?.monitored,true);assert.equal(f.store.get('bsc',two.address)?.coverageAt,next);
    assert.equal(f.store.get('bsc',address(9999)),undefined);
  } finally {f.close();}
});

test('coverage batch commits chains together while an empty set clears only its own chain',()=>{
  const bsc=profile(1,'A'),robinhood=profile(2,'A',{chain:'robinhood'}),f=fixture([
    {profile:bsc,route:'A'},{profile:robinhood,route:'A'},
  ]);
  try {f.store.refresh();const at=new Date(f.clock.value-2_000).toISOString(),clearedAt=new Date(f.clock.value-1_000).toISOString();
    assert.deepEqual(f.store.replaceCoverageBatch([
      {chain:'bsc',wallets:[bsc.address],at},{chain:'robinhood',wallets:[robinhood.address],at},
    ]),{bsc:1,robinhood:1});
    assert.equal(f.store.get('bsc',bsc.address)?.coverageAt,at);assert.equal(f.store.get('robinhood',robinhood.address)?.coverageAt,at);
    assert.deepEqual(f.store.replaceCoverageBatch([{chain:'bsc',wallets:[],at:clearedAt}]),{bsc:0});
    assert.equal(f.store.get('bsc',bsc.address)?.monitored,false);assert.equal(f.store.get('bsc',bsc.address)?.coverageAt,undefined);
    assert.equal(f.store.get('robinhood',robinhood.address)?.monitored,true);
    assert.equal(f.store.get('robinhood',robinhood.address)?.coverageAt,at);
  } finally {f.close();}
});

test('coverage batch result distinguishes capacity failure from a successful zero-match update',()=>{
  const p=profile(1,'A'),f=fixture([{profile:p,route:'A'}]);
  try {f.store.refresh();const db=(f.store as unknown as {db:DatabaseSync}).db;
    db.exec(`CREATE TRIGGER lc_test_capacity BEFORE UPDATE ON lc_candidates
      BEGIN SELECT RAISE(ABORT,'database or disk is full'); END;`);
    const result=f.store.replaceCoverageBatchResult([{chain:'bsc',wallets:[p.address],at:new Date(f.clock.value).toISOString()}]);
    assert.deepEqual(result,{counts:{bsc:0},capacityReached:true});
    assert.equal(f.store.status().capacityReached,true);assert.equal(f.store.get('bsc',p.address)?.monitored,false);
  } finally {f.close();}
});

test('realtime batch result distinguishes a successful zero-match update from capacity failure',()=>{
  const p=profile(1,'A'),f=fixture([{profile:p,route:'A'}]);
  try {f.store.refresh();const observedAt=new Date(f.clock.value).toISOString();
    assert.deepEqual(f.store.observeRealtimeBatchResult([
      {chain:'bsc',wallet:address(9999),observedAt,source:'wallet_fast'},
    ]),{changed:0,capacityReached:false});
    const db=(f.store as unknown as {db:DatabaseSync}).db;
    db.exec(`CREATE TRIGGER lc_test_realtime_capacity BEFORE UPDATE ON lc_candidates
      BEGIN SELECT RAISE(ABORT,'database or disk is full'); END;`);
    assert.deepEqual(f.store.observeRealtimeBatchResult([
      {chain:'bsc',wallet:p.address,observedAt,source:'wallet_fast'},
    ]),{changed:0,capacityReached:true});
    assert.equal(f.store.get('bsc',p.address)?.liveSeenAt,undefined);
  } finally {f.close();}
});

test('a contended main-store write fails within its event-loop budget and succeeds on retry',()=>{
  const p=profile(1,'A'),f=fixture([{profile:p,route:'A'}],{busyTimeoutMs:25});
  const lock=new DatabaseSync(f.database);
  try {
    f.store.refresh();lock.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
    const started=performance.now();assert.throws(()=>f.store.replaceCoverage('bsc',[p.address],new Date(f.clock.value).toISOString()));
    assert.ok(performance.now()-started<100,'optional launcher write blocked the event loop');
    lock.exec('ROLLBACK');
    assert.equal(f.store.replaceCoverage('bsc',[p.address],new Date(f.clock.value).toISOString()),1);
    assert.equal(f.store.get('bsc',p.address)?.monitored,true);
  } finally {try{lock.exec('ROLLBACK');}catch{/* already released */}lock.close();f.close();}
});

test('only a verified buy renews hot freshness while sell evidence remains separate',()=>{
  const p=profile(1,'A',{evidenceAt:iso(100)}),f=fixture([{profile:p,route:'A'}],{freshAfterSec:60}),
    buyToken=address(701),sellToken=address(702);
  try {f.store.refresh();const oldBuyAt=new Date(f.clock.value-70_000).toISOString(),sellAt=new Date(f.clock.value-5_000).toISOString();
    assert.equal(f.store.observeActivity({chain:'bsc',wallet:p.address,checkedAt:new Date(f.clock.value-60_000).toISOString(),
      eventAt:oldBuyAt,classification:'buy',confirmation:'confirmed',txHash:tx(701),
      trades:[{tokenAddress:buyToken,side:'buy'}]}),true);
    assert.equal(f.store.observeActivity({chain:'bsc',wallet:p.address,checkedAt:new Date(f.clock.value).toISOString(),
      eventAt:sellAt,classification:'sell',confirmation:'confirmed',txHash:tx(702),tokenAddress:sellToken}),true);
    let candidate=f.store.get('bsc',p.address)!;
    assert.equal(candidate.lastVerifiedBuyAt,oldBuyAt);assert.equal(candidate.lastVerifiedBuyTx,tx(701));
    assert.equal(candidate.lastVerifiedBuyToken,buyToken);assert.equal(candidate.lastVerifiedSellAt,sellAt);
    assert.equal(candidate.lastVerifiedSellTx,tx(702));assert.equal(candidate.lastVerifiedSellToken,sellToken);
    assert.equal(candidate.dimensions.verifiedTradeFresh,false);assert.equal(candidate.state,'historical_seed');
    const freshBuyAt=new Date(f.clock.value-2_000).toISOString();
    assert.equal(f.store.observeActivity({chain:'bsc',wallet:p.address,checkedAt:new Date(f.clock.value).toISOString(),
      eventAt:freshBuyAt,classification:'buy',confirmation:'included',txHash:tx(703),tokenAddress:buyToken}),true);
    candidate=f.store.get('bsc',p.address)!;assert.equal(candidate.lastVerifiedBuyAt,freshBuyAt);
    assert.equal(candidate.lastVerifiedSellAt,sellAt);assert.equal(candidate.dimensions.verifiedTradeFresh,true);
    assert.equal(candidate.state,'fresh_verified');
  } finally {f.close();}
});

test('retraction clears only an exactly matching latest side and repeated delivery is idempotent',()=>{
  const p=profile(1,'A',{evidenceAt:iso(100)}),f=fixture([{profile:p,route:'A'}],{freshAfterSec:60}),
    checkedAt=new Date(f.clock.value).toISOString(),buyAt=new Date(f.clock.value-2_000).toISOString(),
    sellAt=new Date(f.clock.value-1_000).toISOString(),latestBuyAt=new Date(f.clock.value-500).toISOString();
  try {
    f.store.refresh();
    assert.equal(f.store.observeActivity({chain:'bsc',wallet:p.address,checkedAt,eventAt:buyAt,
      classification:'buy',confirmation:'confirmed',txHash:tx(901),tokenAddress:address(901)}),true);
    assert.equal(f.store.observeActivity({chain:'bsc',wallet:p.address,checkedAt,eventAt:sellAt,
      classification:'sell',confirmation:'confirmed',txHash:tx(902),tokenAddress:address(902)}),true);
    assert.equal(f.store.observeActivity({chain:'bsc',wallet:p.address,checkedAt,eventAt:latestBuyAt,
      classification:'buy',confirmation:'confirmed',txHash:tx(903),tokenAddress:address(903)}),true);
    assert.equal(f.store.retractActivity({chain:'bsc',wallet:p.address,checkedAt,txHash:tx(999)}),false);
    let candidate=f.store.get('bsc',p.address)!;
    assert.equal(candidate.lastVerifiedBuyTx,tx(903));assert.equal(candidate.lastVerifiedSellTx,tx(902));
    assert.equal(f.store.retractActivity({chain:'bsc',wallet:p.address,checkedAt,txHash:tx(901)}),true);
    assert.equal(f.store.get('bsc',p.address)!.lastVerifiedBuyTx,tx(903));
    assert.equal(f.store.retractActivity({chain:'bsc',wallet:p.address,checkedAt,txHash:tx(901)}),false);
    assert.equal(f.store.retractActivity({chain:'bsc',wallet:p.address,checkedAt,txHash:tx(903)}),true);
    candidate=f.store.get('bsc',p.address)!;assert.equal(candidate.lastVerifiedBuyTx,undefined);
    assert.equal(candidate.lastVerifiedSellTx,tx(902));assert.equal(candidate.verifiedActivityAt,sellAt);
    assert.equal(candidate.dimensions.verifiedTradeFresh,false);
    assert.equal(f.store.retractActivity({chain:'bsc',wallet:p.address,checkedAt,txHash:tx(903)}),false);
  } finally {f.close();}
});

test('stream targets prioritize latest verified buys over newer generic liveness',()=>{
  const live=profile(1,'A',{evidenceAt:iso(100)}),buyer=profile(2,'A',{evidenceAt:iso(100)}),
    f=fixture([{profile:live,route:'A'},{profile:buyer,route:'A'}],{freshAfterSec:60,liveAfterSec:60});
  try {f.store.refresh();assert.equal(f.store.observeRealtime({chain:'bsc',wallet:live.address,
    observedAt:new Date(f.clock.value-1_000).toISOString(),source:'wallet_fast'}),true);
    assert.equal(f.store.observeActivity({chain:'bsc',wallet:buyer.address,checkedAt:new Date(f.clock.value).toISOString(),
      eventAt:new Date(f.clock.value-10_000).toISOString(),classification:'buy',confirmation:'included',txHash:tx(800),
      tokenAddress:address(800)}),true);
    assert.deepEqual(f.store.streamTargets('bsc',1),[buyer.address]);
  } finally {f.close();}
});

test('a recent sell does not promote a candidate in the discovery rotation',()=>{
  const plain=profile(1,'A',{evidenceAt:iso(100)}),seller=profile(2,'A',{evidenceAt:iso(100)}),
    f=fixture([{profile:plain,route:'A'},{profile:seller,route:'A'}],{freshAfterSec:60});
  try {f.store.refresh();assert.equal(f.store.observeActivity({chain:'bsc',wallet:seller.address,
    checkedAt:new Date(f.clock.value).toISOString(),eventAt:new Date(f.clock.value-1_000).toISOString(),
    classification:'sell',confirmation:'confirmed',txHash:tx(801),tokenAddress:address(801)}),true);
    assert.deepEqual(f.store.streamTargets('bsc',2),[plain.address,seller.address]);
  } finally {f.close();}
});

test('unconfirmed activity cannot manufacture verified freshness',()=>{
  const p=profile(1,'A',{evidenceAt:iso(100)}),f=fixture([{profile:p,route:'A'}],{freshAfterSec:60});
  try {f.store.refresh();assert.equal(f.store.observeActivity({chain:'bsc',wallet:p.address,checkedAt:new Date(f.clock.value).toISOString(),
    classification:'buy',confirmation:'unknown',txHash:tx(88)}),false);assert.equal(f.store.get('bsc',p.address)?.state,'historical_seed');}
  finally {f.close();}
});

test('revalidation distinguishes a candidate removed by refresh from a real rejected write',()=>{
  const p=profile(1,'A'),f=fixture([{profile:p,route:'A'}]);
  try {
    f.store.refresh();const checkedAt=new Date(f.clock.value).toISOString();
    assert.equal(f.store.recordRevalidation({chain:'bsc',wallet:address(99),checkedAt,state:'empty',newSignature:false}),'stale');
    assert.equal(f.store.recordRevalidation({chain:'bsc',wallet:p.address,checkedAt:'invalid',state:'empty',newSignature:false}),false);
  } finally {f.close();}
});

test('revalidation persists RPC facts but an unclassified new signature is only live_seen',()=>{
  const p=profile(1,'A',{evidenceAt:iso(100)}),wallet='11111111111111111111111111111111',signature='1'.repeat(64);
  p.chain='solana';p.address=wallet;p.initiatorAnalysis!.chain='solana';p.initiatorAnalysis!.wallet=wallet;
  const f=fixture([{profile:p,route:'A'}],{freshAfterSec:60,liveAfterSec:30});
  try {f.store.refresh();const checkedAt=new Date(f.clock.value-2_000).toISOString(),blockTime=Math.floor((f.clock.value-5_000)/1000);
    assert.equal(f.store.recordRevalidation({chain:'solana',wallet,checkedAt,latestSignature:signature,blockTime,slot:123,
      state:'changed',newSignature:true,classification:'unknown'}),true);
    const candidate=f.store.get('solana',wallet)!;assert.equal(candidate.state,'live_seen');
    assert.deepEqual(candidate.revalidation,{checkedAt,latestSignature:signature,blockTime,eventAt:new Date(blockTime*1000).toISOString(),
      slot:123,state:'changed',classification:'unknown'});
    assert.deepEqual(f.store.listRevalidation('solana',10),[{wallet,latestSignature:signature}]);
    f.clock.value+=31_000;assert.equal(f.store.get('solana',wallet)?.state,'historical_seed');
    const baselineAt=new Date(f.clock.value-3_000).toISOString();assert.equal(f.store.recordRevalidation({chain:'solana',wallet,
      checkedAt:new Date(f.clock.value).toISOString(),latestSignature:signature,blockTime:Math.floor(Date.parse(baselineAt)/1000),slot:124,state:'baseline'}),true);
    assert.equal(f.store.get('solana',wallet)?.state,'live_seen');
    f.clock.value+=1_000;const failedAt=new Date(f.clock.value).toISOString();
    assert.equal(f.store.recordRevalidation({chain:'solana',wallet,checkedAt:failedAt,state:'error',newSignature:false,
      error:'LAUNCHER_RPC_UNAVAILABLE'}),true);
    assert.deepEqual(f.store.get('solana',wallet)?.revalidation,{checkedAt:failedAt,latestSignature:signature,
      blockTime:Math.floor(Date.parse(baselineAt)/1000),eventAt:new Date(Math.floor(Date.parse(baselineAt)/1000)*1000).toISOString(),
      slot:124,state:'error',error:'LAUNCHER_RPC_UNAVAILABLE'});
  } finally {f.close();}
});

test('cap is deterministic, mature peer evidence precedes weak A, and list/get/streamTargets expose only the compact pool',()=>{
  const rows=[{profile:profile(3,'B'),route:'B' as const},{profile:profile(2,'A'),route:'A' as const},{profile:profile(1,'A'),route:'A' as const}],
    f=fixture(rows,{cap:2});
  try {const status=f.store.refresh();assert.equal(status.records,2);assert.equal(status.cap,2);
    const page=f.store.list({limit:10});assert.equal(page.total,2);assert.deepEqual(page.items.map(x=>x.address),[address(3),address(1)]);
    assert.deepEqual(f.store.streamTargets('bsc',10),[address(3),address(1)]);assert.equal(f.store.get('bsc',address(2)),undefined);}
  finally {f.close();}
});

test('stream targets ignore old coverage priority and rotate historical pages every five minutes',()=>{
  const rows=Array.from({length:4},(_,index)=>({profile:profile(index+1,'A',{evidenceAt:iso(100)}),route:'A' as const})),
    f=fixture(rows,{cap:4,freshAfterSec:60});
  try {f.store.refresh();assert.deepEqual(f.store.streamTargets('bsc',2),[address(1),address(2)]);
    f.store.replaceCoverage('bsc',[address(1),address(2)],new Date(f.clock.value).toISOString());
    assert.deepEqual(f.store.streamTargets('bsc',2),[address(1),address(2)]);
    f.clock.value+=300_001;f.store.refresh();assert.deepEqual(f.store.streamTargets('bsc',2),[address(3),address(4)]);}
  finally {f.close();}
});

test('generic live candidates rotate instead of pinning the same subscription page',()=>{
  const rows=Array.from({length:4},(_,index)=>({profile:profile(index+1,'A',{evidenceAt:iso(100)}),route:'A' as const})),
    f=fixture(rows,{cap:4,freshAfterSec:60,liveAfterSec:1000});
  try {f.store.refresh();for(let index=0;index<4;index++)f.store.observeRealtime({chain:'bsc',wallet:address(index+1),
      observedAt:new Date(f.clock.value-index*1000).toISOString(),source:'wallet_fast'});
    const first=f.store.streamTargets('bsc',2);f.clock.value+=300_001;const second=f.store.streamTargets('bsc',2);
    assert.equal(first.some(wallet=>second.includes(wallet)),false);
  } finally {f.close();}
});

test('recently verified trades retain eighty percent of scarce stream slots while discovery rotates',()=>{
  const rows=Array.from({length:10},(_,index)=>({profile:profile(index+1,'A',{evidenceAt:iso(100)}),route:'A' as const})),
    f=fixture(rows,{cap:10,freshAfterSec:1000});
  try {f.store.refresh();for(let index=0;index<10;index++)assert.equal(f.store.observeActivity({chain:'bsc',wallet:address(index+1),
      checkedAt:new Date(f.clock.value-index*1000).toISOString(),eventAt:new Date(f.clock.value-index*1000).toISOString(),
      classification:'buy',confirmation:'included',txHash:tx(index+1)}),true);
    const first=f.store.streamTargets('bsc',5);assert.deepEqual(first.slice(0,4),[address(1),address(2),address(3),address(4)]);
    f.clock.value+=300_001;const second=f.store.streamTargets('bsc',5);
    assert.deepEqual(second.slice(0,4),[address(1),address(2),address(3),address(4)]);assert.notEqual(first[4],second[4]);
  } finally {f.close();}
});

test('capacity guard rolls back refresh rather than publishing a partial candidate set',()=>{
  const rows=Array.from({length:40},(_,i)=>({profile:profile(i+1,'A'),route:'A' as const})),f=fixture(rows,{cap:40,maxBytes:65_536});
  try {const status=f.store.refresh();assert.equal(status.capacityReached,true);assert.equal(status.records,0);assert.equal(f.store.list().items.length,0);}
  finally {f.close();}
});

test('legacy activity migrates without being reinterpreted as a verified buy',()=>{
  const dir=mkdtempSync(join(tmpdir(),'launcher-candidates-migration-')),profiles=join(dir,'profiles.sqlite'),database=join(dir,'candidates.sqlite'),
    p=profile(1,'A',{evidenceAt:iso(100)}),legacyActivity=iso(9_995);
  createProfiles(profiles,[{profile:p,route:'A'}]);const old=new DatabaseSync(database);
  old.exec(`CREATE TABLE lc_candidates(
    chain TEXT NOT NULL,address TEXT NOT NULL,route TEXT NOT NULL,qualified_at TEXT NOT NULL,profile_computed_at TEXT NOT NULL,
    last_evidence_at TEXT,verified_at TEXT,activity_at TEXT,live_seen_at TEXT,live_source TEXT,
    monitored INTEGER NOT NULL DEFAULT 0,coverage_at TEXT,revalidation_checked_at TEXT,latest_signature TEXT,
    block_time INTEGER,slot INTEGER,revalidation_state TEXT,revalidation_classification TEXT,revalidation_error TEXT,
    updated_at TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(chain,address));
    CREATE TABLE lc_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  old.prepare(`INSERT INTO lc_candidates(chain,address,route,qualified_at,profile_computed_at,last_evidence_at,verified_at,activity_at,
    live_seen_at,live_source,monitored,coverage_at,revalidation_checked_at,latest_signature,block_time,slot,revalidation_state,
    revalidation_classification,revalidation_error,updated_at,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'bsc',p.address,'A',iso(500),iso(1_000),null,legacyActivity,legacyActivity,null,null,0,null,null,null,null,null,null,'sell',null,
      legacyActivity,JSON.stringify({version:1,reasons:['LEGACY'],sampleOnly:true,tradingEnabled:false}));
  old.prepare('INSERT INTO lc_meta VALUES (?,?)').run('last_refresh_at',legacyActivity);old.close();
  const store=new LauncherCandidates({database,profileDatabase:profiles,now:()=>new Date(base+10_000_000),freshAfterSec:60});
  try {const candidate=store.get('bsc',p.address)!;assert.equal(candidate.verifiedActivityAt,legacyActivity);
    assert.equal(candidate.lastVerifiedBuyAt,undefined);assert.equal(candidate.lastVerifiedSellAt,undefined);
    assert.equal(candidate.dimensions.verifiedTradeFresh,false);assert.equal(candidate.state,'historical_seed');
  } finally {store.close();}
  const migrated=new DatabaseSync(database,{readOnly:true}),columns=new Set(migrated.prepare('PRAGMA table_info(lc_candidates)').all().map(row=>String(row.name)));
  for(const column of ['last_verified_buy_at','last_verified_buy_observed_at','last_verified_buy_tx','last_verified_buy_token',
    'last_verified_sell_at','last_verified_sell_observed_at','last_verified_sell_tx','last_verified_sell_token'])
    assert.equal(columns.has(column),true);
  assert.equal(!!migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lc_trade_events'").get(),true);
  migrated.close();rmSync(dir,{recursive:true,force:true});
});

test('database paths must be separate',()=>{
  const dir=mkdtempSync(join(tmpdir(),'launcher-candidates-path-')),profiles=join(dir,'profiles.sqlite');createProfiles(profiles,[]);
  try {assert.throws(()=>new LauncherCandidates({database:profiles,profileDatabase:profiles}),/LAUNCHER_CANDIDATE_DATABASE_MUST_BE_SEPARATE/);}
  finally {rmSync(dir,{recursive:true,force:true});}
});
