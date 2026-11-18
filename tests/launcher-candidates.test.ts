import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {
  LauncherCandidates,type LauncherCandidateProfileRoute,type LauncherRealtimeObservation,type LauncherActivityObservation,
} from '../src/launcher-candidates.js';
import type {WalletProfile} from '../src/wallet-profiles.js';
import type {WalletRoleEvidence,WalletRoleQualification} from '../src/wallet-role-analysis.js';

const base=Date.parse('2026-11-18T00:00:00.000Z');
const iso=(seconds:number)=>new Date(base+seconds*1000).toISOString();
const address=(id:number)=>'0x'+id.toString(16).padStart(40,'0');
const tx=(id:number)=>'0x'+id.toString(16).padStart(64,'0');

function roleQualification(wallet:string,peer:string,knownAt=iso(9_990),evidenceAt=iso(100)):WalletRoleQualification {
  const evidenceBase=(Date.parse(evidenceAt)-base)/1000;
  const evidence=Array.from({length:3},(_,index):WalletRoleEvidence=>({
    tokenAddress:address(100+index),direction:'lead',reason:'test lead',lagSeconds:20,
    candidateBuy:{wallet,txHash:tx(100+index),eventAt:iso(evidenceBase+index*10),observedAt:iso(evidenceBase+1+index*10),source:'test'},
    leaderBuy:{wallet:peer,txHash:tx(200+index),eventAt:iso(evidenceBase+20+index*10),observedAt:iso(evidenceBase+21+index*10),source:'test'},
  }));
  return {version:1,knownAt,evidence};
}

function profile(id:number,route:LauncherCandidateProfileRoute,options:{evidenceAt?:string;computedAt?:string;invalidQualification?:boolean;
  prospectivePreTokens?:number;selectedTokens?:number;forwardObservedTokens?:number;qualificationKnownAt?:string;
  chain?:'bsc'|'robinhood'}={}):WalletProfile {
  const network=options.chain??'bsc',wallet=address(id),peer=address(900+id),evidenceAt=options.evidenceAt??iso(900),computedAt=options.computedAt??iso(1000);
  const value:WalletProfile={chain:network,address:wallet,version:1,computedAt,evidenceThroughAt:evidenceAt,
    freshUntil:iso(20_000),status:'current',source:'wallet_history',sampleOnly:true,ownership:'unknown',groups:[],
    metrics:{observedEvents:3,buyEvents:3,sellEvents:0,distinctTokens:3,lastEventAt:evidenceAt,
      associations:{leaders:1,distinctTokens:3,forwardTokens:route==='B'?1:0},chain:{transactions:0,transfers:0}},
    counterparties:[],limitations:[]};
  if(route==='A'){
    value.groups.push({id:'market_pre_candidate',firstObservedAt:iso(500),evidenceCount:1,reason:'test'});
    const prospectivePreTokens=options.prospectivePreTokens??1,selectedTokens=options.selectedTokens??1;
    value.initiatorAnalysis={version:1,chain:network,wallet,computedAt,status:'current',classification:'candidate',sampleOnly:true,
      ownership:'unknown',tradingEnabled:false,dumpAssessment:'unknown',directionalTokens:{pre:1,post:0,ambiguous:0,outsideWindow:0,unmatched:0},
      totalCandidateTokens:selectedTokens,selectedTokens,matchedTokens:selectedTokens,preShare:1,prospectivePreTokens,postActivationExitTokens:0,
      pendingTokens:0,unobservedTokens:0,evidence:[],screeningEvidence:[{tokenAddress:address(500+id),direction:'pre',prospective:true,reason:'test',
        buy:{chain:network,wallet,tokenAddress:address(500+id),txHash:tx(500+id),side:'buy',eventAt:evidenceAt,observedAt:evidenceAt,source:'test'}}],
      reasons:[],counterEvidence:[],limitations:[],
      method:{minimumDirectionalTokens:3,minimumDirectionShare:.75,nearTimeSeconds:2,maximumLagSeconds:86400,evidenceLimit:6,qualificationEvidenceLimit:30}};
  }else{
    value.groups.push({id:'precursor_pattern',firstObservedAt:iso(500),evidenceCount:3,reason:'test'},
      {id:'forward_validated',firstObservedAt:iso(600),evidenceCount:1,reason:'test'});
    const qualification=roleQualification(wallet,peer,options.qualificationKnownAt,options.evidenceAt);
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
    assert.equal(f.store.retractActivity({chain:'bsc',wallet:p.address,checkedAt,txHash:tx(901)}),false);
    assert.equal(f.store.get('bsc',p.address)!.lastVerifiedBuyTx,tx(903));
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

test('cap is deterministic, A precedes B, and list/get/streamTargets expose only the compact pool',()=>{
  const rows=[{profile:profile(3,'B'),route:'B' as const},{profile:profile(2,'A'),route:'A' as const},{profile:profile(1,'A'),route:'A' as const}],
    f=fixture(rows,{cap:2});
  try {const status=f.store.refresh();assert.equal(status.records,2);assert.equal(status.cap,2);
    const page=f.store.list({limit:10});assert.equal(page.total,2);assert.deepEqual(page.items.map(x=>x.address),[address(1),address(2)]);
    assert.deepEqual(f.store.streamTargets('bsc',10),[address(1),address(2)]);assert.equal(f.store.get('bsc',address(3)),undefined);}
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
  for(const column of ['last_verified_buy_at','last_verified_buy_tx','last_verified_buy_token','last_verified_sell_at','last_verified_sell_tx','last_verified_sell_token'])
    assert.equal(columns.has(column),true);
  migrated.close();rmSync(dir,{recursive:true,force:true});
});

test('database paths must be separate',()=>{
  const dir=mkdtempSync(join(tmpdir(),'launcher-candidates-path-')),profiles=join(dir,'profiles.sqlite');createProfiles(profiles,[]);
  try {assert.throws(()=>new LauncherCandidates({database:profiles,profileDatabase:profiles}),/LAUNCHER_CANDIDATE_DATABASE_MUST_BE_SEPARATE/);}
  finally {rmSync(dir,{recursive:true,force:true});}
});
