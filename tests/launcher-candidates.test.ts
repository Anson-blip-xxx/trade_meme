import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  LauncherCandidates,type LauncherCandidateProfileRoute,type LauncherRealtimeObservation,type LauncherActivityObservation,
} from '../src/launcher-candidates.js';
import type {WalletProfile} from '../src/wallet-profiles.js';
import type {WalletRoleEvidence,WalletRoleQualification} from '../src/wallet-role-analysis.js';

const base=Date.parse('2026-11-18T00:00:00.000Z');
const iso=(seconds:number)=>new Date(base+seconds*1000).toISOString();
const address=(id:number)=>'0x'+id.toString(16).padStart(40,'0');
const tx=(id:number)=>'0x'+id.toString(16).padStart(64,'0');

function roleQualification(wallet:string,peer:string,knownAt=iso(1000)):WalletRoleQualification {
  const evidence=Array.from({length:3},(_,index):WalletRoleEvidence=>({
    tokenAddress:address(100+index),direction:'lead',reason:'test lead',lagSeconds:20,
    candidateBuy:{wallet,txHash:tx(100+index),eventAt:iso(100+index*10),observedAt:iso(101+index*10),source:'test'},
    leaderBuy:{wallet:peer,txHash:tx(200+index),eventAt:iso(120+index*10),observedAt:iso(121+index*10),source:'test'},
  }));
  return {version:1,knownAt,evidence};
}

function profile(id:number,route:LauncherCandidateProfileRoute,options:{evidenceAt?:string;computedAt?:string;invalidQualification?:boolean}={}):WalletProfile {
  const wallet=address(id),peer=address(900+id),evidenceAt=options.evidenceAt??iso(900),computedAt=options.computedAt??iso(1000);
  const value:WalletProfile={chain:'bsc',address:wallet,version:1,computedAt,evidenceThroughAt:evidenceAt,
    freshUntil:iso(20_000),status:'current',source:'wallet_history',sampleOnly:true,ownership:'unknown',groups:[],
    metrics:{observedEvents:3,buyEvents:3,sellEvents:0,distinctTokens:3,lastEventAt:evidenceAt,
      associations:{leaders:1,distinctTokens:3,forwardTokens:route==='B'?1:0},chain:{transactions:0,transfers:0}},
    counterparties:[],limitations:[]};
  if(route==='A'){
    value.groups.push({id:'market_pre_candidate',firstObservedAt:iso(500),evidenceCount:1,reason:'test'});
    value.initiatorAnalysis={version:1,chain:'bsc',wallet,computedAt,status:'current',classification:'candidate',sampleOnly:true,
      ownership:'unknown',tradingEnabled:false,dumpAssessment:'unknown',directionalTokens:{pre:1,post:0,ambiguous:0,outsideWindow:0,unmatched:0},
      totalCandidateTokens:1,selectedTokens:1,matchedTokens:1,preShare:1,prospectivePreTokens:1,postActivationExitTokens:0,
      pendingTokens:0,unobservedTokens:0,evidence:[],screeningEvidence:[],reasons:[],counterEvidence:[],limitations:[],
      method:{minimumDirectionalTokens:3,minimumDirectionShare:.75,nearTimeSeconds:2,maximumLagSeconds:86400,evidenceLimit:6,qualificationEvidenceLimit:30}};
  }else{
    value.groups.push({id:'precursor_pattern',firstObservedAt:iso(500),evidenceCount:3,reason:'test'},
      {id:'forward_validated',firstObservedAt:iso(600),evidenceCount:1,reason:'test'});
    const qualification=roleQualification(wallet,peer);
    if(options.invalidQualification)qualification.evidence[0].leaderBuy!.txHash=qualification.evidence[0].candidateBuy!.txHash;
    value.roleAnalysis={version:1,computedAt,status:'current',ownership:'unknown',sampleOnly:true,limitations:[],
      method:{minimumDirectionalTokens:3,minimumDirectionShare:.75,nearTimeSeconds:2,maximumLagSeconds:86400,evidenceLimitPerPeer:6,screeningEvidenceLimitPerPeer:30},
      peers:[{address:peer,classification:'precursor_pattern',directionalPattern:'precursor_pattern',ownership:'unknown',
        directionalTokens:{lead:3,follow:0,ambiguous:0,unmatched:0,outsideWindow:0},matchedTokens:3,totalCandidateTokens:3,
        leadShare:1,followShare:0,medianLagSeconds:20,lagMadSeconds:0,forwardObservedTokens:1,pendingTokens:0,unobservedTokens:0,
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

test('unconfirmed activity cannot manufacture verified freshness',()=>{
  const p=profile(1,'A',{evidenceAt:iso(100)}),f=fixture([{profile:p,route:'A'}],{freshAfterSec:60});
  try {f.store.refresh();assert.equal(f.store.observeActivity({chain:'bsc',wallet:p.address,checkedAt:new Date(f.clock.value).toISOString(),
    classification:'buy',confirmation:'unknown',txHash:tx(88)}),false);assert.equal(f.store.get('bsc',p.address)?.state,'historical_seed');}
  finally {f.close();}
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

test('capacity guard rolls back refresh rather than publishing a partial candidate set',()=>{
  const rows=Array.from({length:40},(_,i)=>({profile:profile(i+1,'A'),route:'A' as const})),f=fixture(rows,{cap:40,maxBytes:65_536});
  try {const status=f.store.refresh();assert.equal(status.capacityReached,true);assert.equal(status.records,0);assert.equal(f.store.list().items.length,0);}
  finally {f.close();}
});

test('database paths must be separate',()=>{
  const dir=mkdtempSync(join(tmpdir(),'launcher-candidates-path-')),profiles=join(dir,'profiles.sqlite');createProfiles(profiles,[]);
  try {assert.throws(()=>new LauncherCandidates({database:profiles,profileDatabase:profiles}),/LAUNCHER_CANDIDATE_DATABASE_MUST_BE_SEPARATE/);}
  finally {rmSync(dir,{recursive:true,force:true});}
});
