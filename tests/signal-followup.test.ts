import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SignalFollowup} from '../src/signal-followup.js';
import type {FollowupRecord} from '../src/signal-followup.js';
import type {Report} from '../src/types.js';
import type {ScanRecord,ScanPrice} from '../src/scan-archive.js';
import type {FollowupWalletEvidence} from '../src/wallet-history.js';

const start=Date.parse('2026-10-01T00:00:00Z'),iso=(ms=0)=>new Date(start+ms).toISOString(),date=(ms=0)=>new Date(start+ms);
const address=(n=1)=>'0x'+n.toString(16).padStart(40,'0');
function fixture(n=1,patch:Partial<Report>={},at=0):{report:Report;record:ScanRecord} {
  const signal={source:'debot' as const,sourceEventId:String(n),token:{chain:'bsc' as const,address:address(n)},occurredAt:iso(at),text:'',claim:'unspecified' as const,evidenceUrls:[]};
  const check={status:'pass' as const,reasons:[],facts:{},checkedAt:iso(at)};
  const report:Report={id:'scan'+n,signal,receivedAt:iso(at),evaluatedAt:iso(at),validUntil:iso(at+60000),mode:'live',policyVersion:'gate-v1',
    decision:'WATCH',buyEligible:false,executionEnabled:false,reasons:['WALLET_SUPPORT_NOT_PASSED'],provenance:check,safety:check,
    narrative:{...check,evidence:[]},flow:{...check,status:'unknown'},...patch};
  const record:ScanRecord={id:report.id,chain:signal.token.chain,address:signal.token.address,source:signal.source,status:'completed',
    receivedAt:iso(at),occurredAt:iso(at),name:'Token'+n,decision:report.decision,mode:'live',policyVersion:report.policyVersion,
    evaluatedAt:report.evaluatedAt,reasons:report.reasons,checks:{provenance:check,safety:check,market:check,narrative:check,wallets:check,flow:check},
    wallets:{sampleOnly:true,smartIndependenceProven:false,summary:{qualifiedSmartFundingClusterCount:1,recentNetBuyUsd:'10'},groups:[]}};
  return {report,record};
}
function price(n:number,at:number,p:number,extra:Partial<ScanPrice>={}):ScanPrice {
  return {chain:'bsc',address:address(n),observedAt:iso(at),priceUsd:p,source:'gmgn_token_info_sample',...extra};
}
function setup() {
  const db=new DatabaseSync(':memory:'),followup=new SignalFollowup(db);
  const capture=(n=1,patch:Partial<Report>={},at=0)=>{const f=fixture(n,patch,at);followup.capture(f.report,f.record,date(at));return f;};
  return {db,followup,capture,detail:(n=1,at=0)=>followup.detail('bsc',address(n),date(at))!};
}
test('dashboard followup pages retain every registration while excluding detailed evidence and pinning new arrivals',()=>{
  const {db,followup,capture,detail}=setup();try {
    for(let n=1;n<=8;n++)capture(n,{},n*1000);
    followup.price(price(1,10000,10),date(10000));
    const first=followup.list({limit:3},date(10000));assert.equal(first.total,8);assert.equal(first.hasMore,true);
    assert.deepEqual(first.items.map(r=>r.address),[address(8),address(7),address(6)]);
    capture(9,{},11000);
    const second=followup.list({limit:3,offset:3,asOf:first.asOf},date(12000));assert.equal(second.total,8);
    assert.deepEqual(second.items.map(r=>r.address),[address(5),address(4),address(3)]);
    assert.equal(followup.list({selected:true},date(12000)).total,3);
    assert.equal(followup.list({selected:false},date(12000)).total,6);
    assert.equal(followup.list({decision:'REJECT'},date(12000)).total,0);
    const slim=followup.list({selected:true},date(12000)).items.find(r=>r.address===address(1))!;
    assert.equal(slim.performance.samples,1);assert.ok(slim.horizons);
    for(const field of ['timeline','points','walletGroups','socialSignals','features','checks'])assert.equal(JSON.stringify(slim).includes('"'+field+'"'),false);
    assert.equal(detail().performance.points.length,1);assert.ok(detail().initial.checks);
    const end=followup.list({offset:50},date(12000));assert.equal(end.total,9);assert.equal(end.hasMore,false);assert.deepEqual(end.items,[]);
  }finally{db.close();}
});
test('dashboard summary and aggregate pages are independent, bounded and isolated from caller mutation',()=>{
  const {db,followup,capture}=setup();try {
    capture(1);capture(2,{decision:'REJECT'});capture(3,{decision:'BUY_CANDIDATE',buyEligible:true});
    const summary=followup.dashboardSummary(date());assert.equal(summary.total,3);assert.equal(summary.groupsTotal,3);assert.equal(summary.learningTotal,45);
    for(const field of ['items','groups','learning'])assert.equal(Object.hasOwn(summary,field),false);
    const groups=followup.groups({limit:1,offset:1},date());assert.equal(groups.total,3);assert.equal(groups.items.length,1);assert.equal(groups.hasMore,true);
    const learning=followup.learning({limit:4,offset:4,decision:'WATCH',status:'collecting'},date());
    assert.equal(learning.total,15);assert.equal(learning.items.length,4);learning.items[0].train.count=999;
    assert.notEqual(followup.learning({limit:4,offset:4,decision:'WATCH'},date()).items[0].train.count,999);
    assert.equal(followup.learning({status:'consistent_association'},date()).total,0);
    for(const options of [{limit:0},{limit:101},{offset:-1},{offset:1000001},{chain:'eth'},{decision:'BUY'},{selected:'true'},{status:'invalid'},{asOf:'bad'}])
      assert.throws(()=>followup.list(options as any,date()),/INVALID_FILTER/);
  }finally{db.close();}
});
test('freezes first verdict and features per chain/token, only fills missing display labels',()=>{
  const {db,followup,detail}=setup();try {
    const original=fixture();delete original.record.name;
    followup.capture(original.report,original.record,date());
    const later=fixture(1,{decision:'BUY_CANDIDATE',buyEligible:true},1000);
    later.record.wallets!.summary.qualifiedSmartFundingClusterCount=9;
    later.record.name='Later known name';followup.capture(later.report,later.record,date(1000));
    const row=detail();assert.equal(row.initial.decision,'WATCH');assert.equal(row.initial.qualifiedGroups,1);
    assert.equal(row.initial.features.two_wallet_groups,false);assert.equal(row.selection,'comparison');
    assert.equal(row.name,'Later known name');assert.equal(row.registeredAt,iso());
    const other=fixture(1,{...later.report,signal:{...later.report.signal,token:{chain:'robinhood',address:address()}}},1000);
    other.record.chain='robinhood';followup.capture(other.report,other.record,date(1000));
    assert.equal(followup.summary(date(1000)).total,2);
  }finally{db.close();}
});
test('registers capacity skips permanently and reserves three WATCH and three REJECT controls',()=>{
  const {db,followup,capture,detail}=setup();try {
    for(let n=1;n<=5;n++)capture(n);
    for(let n=6;n<=10;n++)capture(n,{decision:'REJECT'});
    for(let n=11;n<=14;n++)capture(n,{decision:'BUY_CANDIDATE',buyEligible:true});
    const s=followup.summary(date());assert.equal(s.total,14);assert.equal(s.selected,10);assert.equal(s.capacitySkipped,4);
    assert.equal(detail(4).performance.status,'not_selected');
    capture(4,{decision:'BUY_CANDIDATE',buyEligible:true},1000);assert.equal(detail(4).selected,false);
    assert.equal(followup.pending(date(),100).length,10);
    followup.price(price(4,1000,10),date(1000));assert.equal(detail(4).performance.samples,0);
  }finally{db.close();}
});
test('only complete recent live reports with matching identity register; no old report backfill',()=>{
  const {db,followup}=setup();try {
    for(const patch of [{mode:'demo' as const},{evaluatedAt:iso(1000)},{evaluatedAt:'bad'}]) {
      const f=fixture(1,patch);followup.capture(f.report,f.record,date());
    }
    let f=fixture();f.record.status='processing';followup.capture(f.report,f.record,date());
    f=fixture();f.record.address=address(2);followup.capture(f.report,f.record,date());
    f=fixture();followup.capture(f.report,f.record,date(120001));
    assert.equal(followup.summary(date()).total,0);
  }finally{db.close();}
});
test('unknown initial features remain unknown; empty social observations are a known absence',()=>{
  const {db,followup,detail}=setup();try {
    const f=fixture();delete f.record.wallets;f.record.social={score:0,scope:'research_priority',signals:[],endorsementVerified:false};
    followup.capture(f.report,f.record,date());
    assert.deepEqual(detail().initial.features,{two_wallet_groups:null,positive_net_buy:null,social_link:false,precursor_setup:null,public_entry_setup:null});
  }finally{db.close();}
});
test('baseline is a new observed quote, rejecting stale/future/invalid/history prices and repeated timestamps',()=>{
  const {db,followup,capture,detail}=setup();try {
    capture();
    const bad=[price(1,0,10),price(1,1000,0),price(1,1000,NaN),price(1,1000,10,{source:'ath_price'}),price(1,2001,10),price(1,1000,10,{observedAt:'2026-10-01'})];
    for(const p of bad)followup.price(p,date(2000));
    followup.price(price(1,1000,10),date(122000));assert.equal(detail().performance.samples,0);
    followup.price(price(1,1000,10),date(1000));followup.price(price(1,1000,99),date(1000));
    followup.price(price(1,30000,99),date(30000));assert.equal(detail().performance.samples,1);
    assert.equal(detail().performance.baselinePriceUsd,10);
  }finally{db.close();}
});
test('fixed horizons do not substitute peak prices and preserve true sampled drawdowns',()=>{
  const {db,followup,capture,detail}=setup();try {
    capture();for(const [at,p] of [[1000,10],[1800000,30],[3600000,15],[21600000,8],[86400000,12]])followup.price(price(1,at,p),date(at));
    const r=detail(1,86400000);assert.equal(r.performance.maxGainPct,200);assert.equal(r.horizons['3600'].gainPct,50);
    assert.equal(r.horizons['21600'].gainPct,-19.999999999999996);assert.equal(r.horizons['86400'].gainPct,19.999999999999996);
    assert.ok(r.performance.maxDrawdownPct!>73);assert.equal(r.performance.maxSampleGapSec,64800);
    assert.equal(r.timeline.filter(e=>e.kind==='gain_50').length,1);assert.equal(r.timeline.filter(e=>e.kind==='drawdown_30').length,1);
    assert.equal(r.timeline.find(e=>e.kind==='gain_100')!.at,iso(1800000));
  }finally{db.close();}
});
test('late first quote and missed horizon remain missing, not zero returns',()=>{
  const {db,followup,capture,detail}=setup();try {
    capture(1);capture(2);
    followup.price(price(1,600001,10),date(600001));followup.price(price(1,3600000,20),date(3600000));
    followup.price(price(2,1000,10),date(1000));followup.price(price(2,4200001,20),date(4200001));
    assert.equal(detail(1).performance.baselineDelayed,true);assert.deepEqual(detail(1).horizons,{});assert.deepEqual(detail(2).horizons,{});
    const horizon=followup.summary(date(5000000)).groups[0].horizons[0];assert.equal(horizon.mature,2);assert.equal(horizon.missing,2);
    assert.equal(horizon.covered,0);assert.equal(horizon.medianGainPct,null);assert.equal(horizon.upRatePct,null);
  }finally{db.close();}
});
test('mature coverage waits for horizon tolerance and chronological missingness is visible',()=>{
  const {db,followup,capture}=setup();try {
    capture();followup.price(price(1,1000,10),date(1000));followup.price(price(1,3600000,20),date(3600000));
    assert.equal(followup.summary(date(3600000)).groups[0].horizons[0].mature,0);
    const later=followup.summary(date(4200000)).groups[0].horizons[0];assert.equal(later.mature,1);assert.equal(later.covered,1);assert.equal(later.medianGainPct,100);
  }finally{db.close();}
});
test('error rotates attempts without changing observations and expiry stops sampling',()=>{
  const {db,followup,capture,detail}=setup();try {
    capture(1);capture(2);followup.error({chain:'bsc',address:address(1)},'GMGN_RATE_LIMITED',date(1000));
    assert.equal(followup.pending(date(1000))[0].address,address(2));assert.equal(detail().performance.error,'GMGN_RATE_LIMITED');
    followup.price(price(1,999,10),date(1000));assert.equal(detail().performance.samples,0);
    followup.price(price(1,1001,10),date(1001));assert.equal(detail().performance.error,undefined);
    followup.price(price(1,87000001,100),date(87000001));assert.equal(detail(1,87000001).performance.status,'ended');assert.equal(detail().performance.samples,1);
  }finally{db.close();}
});
function evidence(at:number):FollowupWalletEvidence {
  return {chain:'bsc',address:address(),fromAt:iso(),untilAt:iso(at),coverage:'sampled',trades:[{evidenceId:'e1',txHash:'0x'+'1'.repeat(64),wallet:address(9),
    side:'buy',volumeUsd:50,eventAt:iso(500),observedAt:iso(700),source:'gmgn_trades'}],
    buyUsd:50,sellUsd:0,netBuyUsd:50,buyerCount:1,sellerCount:0,evidenceCount:1,excludedCount:0,limitations:['OBSERVED_SAMPLE_ONLY']};
}
test('wallet context must be known by quote time and bound to same chain/CA; no later attribution leakage',()=>{
  const {db,followup,capture,detail}=setup();try {
    capture();const future=evidence(1000);future.trades[0].observedAt=iso(2000);
    followup.price(price(1,1000,10),date(1000),future);assert.equal(detail().timeline[0].walletEvidence,undefined);
    const wrong=evidence(32000);wrong.address=address(2);
    followup.price(price(1,32000,20),date(32000),wrong);assert.equal(detail().timeline.find(e=>e.kind==='gain_100')!.walletEvidence,undefined);
    followup.price(price(1,64000,10),date(64000),evidence(64000));
    assert.equal(detail().timeline.find(e=>e.kind==='drawdown_30')!.walletEvidence!.netBuyUsd,50);
    assert.equal(detail().initial.recentNetBuyUsd,10);
  }finally{db.close();}
});
test('evidenceWindow avoids queries for unselected, duplicate or expired prices',()=>{
  const {db,followup,capture}=setup();try {
    for(let i=1;i<=4;i++)capture(i);
    assert.equal(followup.evidenceWindow(price(4,1000,10),iso(1000)),undefined);
    assert.deepEqual(followup.evidenceWindow(price(1,1000,10),iso(1000)),{fromAt:iso(),untilAt:iso(1000)});
    followup.price(price(1,1000,10),date(1000));assert.equal(followup.evidenceWindow(price(1,30000,10),iso(30000)),undefined);
    assert.deepEqual(followup.evidenceWindow(price(1,900000,10),iso(900000)),{fromAt:iso(300000),untilAt:iso(900000)});
    assert.equal(followup.evidenceWindow(price(1,87000000,10),iso(87000000)),undefined);
  }finally{db.close();}
});
test('market context reflects post-decision observations and does not become an initial feature',()=>{
  const {db,followup,capture,detail}=setup();try {
    capture();followup.price(price(1,1000,10,{market:{liquidityUsd:1000,holderCount:10,poolAddress:address(20)}}),date(1000));
    followup.price(price(1,32000,20,{market:{liquidityUsd:2000,holderCount:15,poolAddress:address(20)}}),date(32000));
    const r=detail();assert.equal(r.performance.liquidityChangePct,100);assert.equal(r.performance.holderChangePct,50);
    assert.equal(r.timeline[0].market!.liquidityUsd,1000);assert.equal(r.performance.baselineMarketAt,iso(1000));
    assert.equal(Object.hasOwn(r.initial.features,'liquidity'),false);
  }finally{db.close();}
});
test('points and context are bounded while baseline, sampled peak and milestones survive',()=>{
  const {db,followup,capture,detail}=setup();try {
    capture();for(let i=0;i<1000;i++)followup.price(price(1,1000+i*60000,i===10?30:10,{market:{liquidityUsd:1000+i}}),date(1000+i*60000));
    const r=detail();assert.ok(r.performance.points.length<=256);assert.ok(r.timeline.length<=32);assert.equal(r.performance.samples,1000);
    assert.equal(r.performance.points[0].at,iso(1000));assert.ok(r.performance.points.some(p=>p.at===iso(601000)));
    assert.equal(r.timeline.filter(e=>e.kind==='gain_100').length,1);assert.equal(r.timeline.filter(e=>e.kind==='baseline').length,1);
    assert.equal(followup.summary(date(60000000)).items[0].performance.points,undefined);
  }finally{db.close();}
});
test('learning uses immutable first features, separate policy/decision groups and chronological holdout',()=>{
  const {db,followup,capture}=setup();try {
    // Separated registrations allow early outcomes to mature before validation starts.
    for(let n=1;n<=160;n++) {
      const at=n*120000,f=fixture(n,{decision:'BUY_CANDIDATE',buyEligible:true},at);
      f.record.wallets!.summary.qualifiedSmartFundingClusterCount=n%2?2:1;
      followup.capture(f.report,f.record,date(at));followup.price(price(n,at+1000,10),date(at+1000));
      followup.price(price(n,at+3600000,n%2?20:5),date(at+3600000));
      const later=fixture(n,{decision:'BUY_CANDIDATE',buyEligible:true},at+4000000);
      later.record.wallets!.summary.qualifiedSmartFundingClusterCount=99;followup.capture(later.report,later.record,date(at+4000000));
    }
    capture(161,{decision:'REJECT',policyVersion:'other-policy'});
    const s=followup.summary(date(30000000)),l=s.learning.find(x=>x.feature==='two_wallet_groups'&&x.seconds===3600&&x.decision==='BUY_CANDIDATE')!;
    assert.equal(s.groups.length,2);assert.equal(l.train.present.covered,39);assert.equal(l.train.absent.covered,39);
    assert.equal(l.validation.present.covered,24);assert.equal(l.validation.absent.covered,24);assert.equal(l.status,'consistent_association');
    assert.equal(l.train.medianDifferencePct,150);assert.equal(l.scope,'observational_correlation');assert.equal(l.splitAt,iso(113*120000));
    assert.equal(l.purgedTrainingCount,34);
    const unknown=s.learning.find(x=>x.feature==='social_link'&&x.seconds===3600&&x.decision==='BUY_CANDIDATE')!;
    assert.equal(unknown.train.unknown.count,78);assert.equal(unknown.status,'collecting');
  }finally{db.close();}
});
test('summary uses compact aggregates and caches for 60s without hiding detailed new samples',()=>{
  const {db,followup,capture,detail}=setup();try {
    capture();const s=followup.summary(date());followup.price(price(1,1000,10),date(1000));
    assert.equal(followup.summary(date(1000)).sampled,0);assert.equal(detail().performance.samples,1);
    assert.equal(followup.summary(date(60000)).sampled,1);s.items.length=0;assert.equal(followup.summary(date(60000)).items.length,1);
    const row=db.prepare('SELECT summary_record FROM signal_followups').get()!;
    assert.equal(String(row.summary_record).includes('points'),false);assert.equal(String(row.summary_record).includes('timeline'),false);
  }finally{db.close();}
});
test('training outcomes crossing validation registration are purged even with many winning samples',()=>{
  const {db,followup}=setup();try {
    for(let n=1;n<=160;n++) {
      const f=fixture(n,{decision:'BUY_CANDIDATE',buyEligible:true},n*1000);
      f.record.wallets!.summary.qualifiedSmartFundingClusterCount=n%2?2:1;
      followup.capture(f.report,f.record,date(n*1000));followup.price(price(n,n*1000+1000,10),date(n*1000+1000));
      followup.price(price(n,n*1000+3600000,n%2?20:5),date(n*1000+3600000));
    }
    const l=followup.summary(date(5000000)).learning.find(x=>x.feature==='two_wallet_groups'&&x.seconds===3600)!;
    assert.equal(l.purgedTrainingCount,112);assert.equal(l.train.count,0);assert.equal(l.validation.count,48);assert.equal(l.status,'collecting');
  }finally{db.close();}
});
test('active tracking stays visible when recent capacity exclusions would fill the list',()=>{
  const {db,followup,capture}=setup();try {
    for(let n=1;n<=40;n++)capture(n,{},n*1000);
    const s=followup.summary(date(60000));assert.equal(s.items.length,30);assert.equal(s.items.slice(0,3).every(r=>r.selected),true);
    assert.equal(s.capacitySkipped,37);assert.equal(s.groups[0].count,40);
  }finally{db.close();}
});
test('pool changes and partial market snapshots do not retain incomparable or stale deltas',()=>{
  const {db,followup,capture,detail}=setup();try {
    capture();followup.price(price(1,1000,10,{market:{liquidityUsd:1000,holderCount:10,poolAddress:address(20)}}),date(1000));
    followup.price(price(1,32000,20,{market:{liquidityUsd:2000,holderCount:15,poolAddress:address(20)}}),date(32000));
    followup.price(price(1,64000,20,{market:{liquidityUsd:3000,poolAddress:address(21)}}),date(64000));
    assert.equal(detail().performance.liquidityChangePct,undefined);assert.equal(detail().performance.holderChangePct,undefined);
    assert.deepEqual(detail().performance.marketLimitations,['POOL_CHANGED_LIQUIDITY_NOT_COMPARABLE']);
    followup.price(price(1,96000,20,{market:{liquidityUsd:3000,poolAddress:address(20)}}),date(96000));
    assert.equal(detail().performance.liquidityChangePct,200);assert.deepEqual(detail().performance.marketLimitations,[]);
  }finally{db.close();}
});
test('90 day retention survives scanner retention and capacity preferentially evicts unsampled exclusions',()=>{
  const {db,followup,capture}=setup();try {
    capture(1,{decision:'BUY_CANDIDATE',buyEligible:true});capture(2);
    followup.prune(date(31*86400000));assert.equal(followup.detail('bsc',address(1),date())?.selected,true);
    followup.prune(date(91*86400000));assert.equal(followup.summary(date(91*86400000)).total,0);
  }finally{db.close();}
});
test('maintenance persists compact review without dashboard requests and avoids repeated cached writes',()=>{
  const {db,followup,capture}=setup();try {
    capture();followup.refresh(date(1000));
    const value=String(db.prepare("SELECT value FROM signal_followup_meta WHERE key='last_review'").get()!.value),review=JSON.parse(value);
    assert.equal(review.total,1);assert.equal(review.computedAt,iso(1000));assert.equal(Object.hasOwn(review,'items'),false);
    followup.refresh(date(2000));assert.equal(db.prepare("SELECT value FROM signal_followup_meta WHERE key='last_review'").get()!.value,value);
    followup.refresh(date(61000));assert.equal(db.prepare("SELECT value FROM signal_followup_meta WHERE key='last_review_at'").get()!.value,iso(61000));
  }finally{db.close();}
});
