import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WalletHistory,type WalletTradeObservation} from '../src/wallet-history.js';
import {WalletProfiles,WalletProfileReader} from '../src/wallet-profiles.js';
import {ChainStreamStore,evmTransfers,TRANSFER_TOPIC} from '../src/chain-stream-store.js';

const base=Date.parse('2026-10-10T00:00:00Z'),iso=(s=0)=>new Date(base+s*1000).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
function fixture(options:{maxBytes?:number;refreshAfterSec?:number}={}){
  const root=mkdtempSync(join(tmpdir(),'wallet-profiles-'));let seconds=100;
  const historyPath=join(root,'history.sqlite'),chainPath=join(root,'chain.sqlite'),database=join(root,'profiles.sqlite');
  const now=()=>new Date(base+seconds*1000),history=new WalletHistory(historyPath,{now}),chain=new ChainStreamStore(chainPath);
  const raw=new DatabaseSync(historyPath);let engine=new WalletProfiles({database,historyDatabase:historyPath,chainDatabase:chainPath,now,refreshAfterSec:1,...options});
  const reader=new WalletProfileReader(database,now);
  const trade=(wallet=1,patch:Partial<WalletTradeObservation>={})=>history.recordTrade({chain:'bsc',wallet:address(wallet),tokenAddress:address(100),txHash:hash(wallet),side:'buy',eventAt:iso(10),observedAt:iso(20),source:'gmgn_wallet_activity',...patch});
  const batch=(n=100)=>engine.runBatch(n),groups=(wallet=1)=>reader.get('bsc',address(wallet))?.groups.map(g=>g.id)??[];
  return {root,historyPath,chainPath,database,history,chain,raw,reader,trade,batch,groups,setNow:(s:number)=>{seconds=s;},now,
    restart:(maxBytes?:number)=>{engine.close();engine=new WalletProfiles({database,historyDatabase:historyPath,chainDatabase:chainPath,now,refreshAfterSec:1,...(maxBytes?{maxBytes}:{})});},
    close:()=>{reader.close();engine.close();raw.close();chain.close();history.close();rmSync(root,{recursive:true,force:true});}};
}
function relation(f:ReturnType<typeof fixture>,tokens=[100],forward=false){
  const chain='bsc',leader=address(2),candidate=address(1),stamp=iso(50);
  f.raw.prepare(`INSERT INTO wh_assoc_relations(chain,leader,candidate,first_at,updated_at,token_count,forward_count,funding_count,dirty,data,funding_data,active_since) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chain,leader,candidate) DO UPDATE SET dirty=0,updated_at=excluded.updated_at,token_count=excluded.token_count`).run(chain,leader,candidate,iso(1),stamp,tokens.length,forward?tokens.length:0,0,0,'{}','[]',iso(1));
  for(const token of tokens){const data={tokenAddress:address(token),leaderBuy:{wallet:leader,eventAt:iso(30),observedAt:iso(31)},candidateBuy:{wallet:candidate,eventAt:iso(10),observedAt:iso(11)},firstDiscoveredAt:iso(40),updatedAt:stamp,leaderPublicObservedAt:iso(30),forwardValidated:forward};
    f.raw.prepare('INSERT OR REPLACE INTO wh_assoc_episodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(String(token),chain,leader,candidate,address(token),iso(40),stamp,1,1,forward?1:0,0,20,JSON.stringify(data));}
}
function profileMeta(path:string,key:string):string|undefined {const db=new DatabaseSync(path,{readOnly:true});try{
  return db.prepare('SELECT value FROM wp_meta WHERE key=?').get(key)?.value as string|undefined;
}finally{db.close();}}

test('reader does not create a missing database and can open it after the worker creates it',()=>{
  const root=mkdtempSync(join(tmpdir(),'wallet-profiles-reader-')),path=join(root,'missing.sqlite'),reader=new WalletProfileReader(path);
  try{assert.equal(reader.status().ready,false);assert.deepEqual(reader.list(),{ready:false,items:[],total:0});assert.equal(existsSync(path),false);}finally{reader.close();rmSync(root,{recursive:true,force:true});}
});

test('groups are nonexclusive, repeated timing counts distinct contracts, and dirty evidence is withdrawn',()=>{
  const f=fixture();try{
    f.trade();f.trade(2,{source:'gmgn_kol_feed'});relation(f,[100,101],true);f.batch();
    assert.ok(f.groups().includes('early_candidate'));assert.ok(f.groups().includes('repeated_early'));assert.ok(f.groups().includes('forward_validated'));
    assert.ok(f.groups(2).includes('public_kol'));const first=f.reader.get('bsc',address(1))!;assert.equal(first.groups[0].firstObservedAt,iso(100));assert.equal(first.metrics.associations.distinctTokens,2);
    f.raw.prepare('UPDATE wh_assoc_relations SET dirty=1').run();f.setNow(102);f.batch();
    assert.deepEqual(f.groups(),['insufficient_evidence']);const changed=f.reader.get('bsc',address(1))!;
    assert.equal(changed.status,'partial');assert.ok(changed.changes![0].removed.includes('repeated_early'));assert.equal(changed.ownership,'unknown');
    f.raw.prepare('UPDATE wh_assoc_relations SET dirty=0').run();f.setNow(104);f.batch();assert.equal(f.reader.get('bsc',address(1))!.groups[0].firstObservedAt,iso(100));
  }finally{f.close();}
});

test('duplicate refreshes and restart preserve first recognition and create no duplicate history',()=>{
  const f=fixture();try{f.trade();f.batch();const first=f.reader.get('bsc',address(1))!;f.setNow(102);f.batch();f.restart();f.setNow(104);f.batch();
    const after=f.reader.get('bsc',address(1))!;assert.equal(after.changes!.length,1);assert.equal(after.groups[0].firstObservedAt,first.computedAt);assert.equal(after.computedAt,iso(104));
    assert.equal(f.reader.getMany([{chain:'bsc',address:address(1)},{chain:'bsc',address:address(99)}]).length,1);
  }finally{f.close();}
});

test('historical repeated early and synchronized patterns persist without new activity, but dirty evidence is withdrawn',()=>{
  const f=fixture();try{f.trade();relation(f,[100,101]);f.raw.prepare('UPDATE wh_metrics SET coordination_dirty=0,coordination_checked_at=?,coordination_data=? WHERE chain=? AND address=?')
      .run(iso(90),JSON.stringify({sharedFunding:[],synchronized:[{wallet:address(2),tokenAddress:address(100),distinctTransactions:2,windowSeconds:120}]}),'bsc',address(1));
    f.batch();f.setNow(2*86_400+100);f.batch();let p=f.reader.get('bsc',address(1))!;
    assert.ok(f.groups().includes('repeated_early'));assert.ok(f.groups().includes('synchronized'));assert.ok(p.limitations.includes('HISTORICAL_ASSOCIATION_EVIDENCE'));assert.ok(p.limitations.includes('HISTORICAL_COORDINATION_EVIDENCE'));
    assert.equal(p.metrics.lastEventAt,iso(10));assert.equal(p.groups.find(g=>g.id==='repeated_early')!.firstObservedAt,iso(100));
    f.raw.prepare('UPDATE wh_assoc_relations SET dirty=1').run();f.raw.prepare('UPDATE wh_metrics SET coordination_dirty=1').run();f.setNow(2*86_400+102);f.batch();
    assert.ok(!f.groups().includes('repeated_early'));assert.ok(!f.groups().includes('synchronized'));
  }finally{f.close();}
});

test('fresh whole-wallet vendor profit and locally observed upside stay separate and profit expires',()=>{
  const f=fixture();try{f.trade();f.history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:'123'}],{source:'gmgn_stats',observedAt:iso(30)});
    const gain={tokenAddress:address(100),baselineAt:iso(20),baselinePriceUsd:1,peakAt:iso(25),peakPriceUsd:3,maxGainPct:200,latestAt:iso(25),latestPriceUsd:3,source:'gmgn_token_info_sample',kind:'first_post_observed_buy_quote'};
    f.raw.prepare('UPDATE wh_metrics SET gain_data=? WHERE chain=? AND address=?').run(JSON.stringify(gain),'bsc',address(1));f.batch();
    assert.ok(f.groups().includes('vendor_profit_positive'));assert.ok(f.groups().includes('observed_runner'));const p=f.reader.get('bsc',address(1))!;
    assert.equal(p.metrics.vendorProfit?.realizedProfitUsd,'123');assert.equal(p.metrics.observedGain?.maxGainPct,200);
    f.setNow(86_431);f.batch();assert.ok(!f.groups().includes('vendor_profit_positive'));assert.ok(f.groups().includes('observed_runner'));
    const fake={chain:'bsc',wallet:address(1),scope:'token_cumulative',period:'7d',verification:'vendor_claim',realizedProfitUsd:'9999',observedAt:iso(86_430)};
    f.raw.prepare('UPDATE wh_metrics SET profit_data=? WHERE chain=? AND address=?').run(JSON.stringify(fake),'bsc',address(1));f.setNow(86_433);f.batch();assert.equal(f.reader.get('bsc',address(1))!.metrics.vendorProfit,undefined);
  }finally{f.close();}
});

test('worker materializes a bounded durable profit cohort and expires it without a main-thread profile scan',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.trade(1,{source:'gmgn_kol_feed'});f.history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:'123'}],{source:'gmgn_stats',observedAt:iso(30)});
    f.batch();assert.deepEqual(f.reader.profitCohort('bsc',f.now()),[123]);
    f.reader.close();assert.deepEqual(f.reader.profitCohort('bsc',f.now()),[123],'compact snapshot survives reader restart');
    f.setNow(86_430);f.batch();f.reader.close();assert.deepEqual(f.reader.profitCohort('bsc',f.now()),[123],'the original +24h boundary remains inclusive');
    f.setNow(86_430.001);assert.deepEqual(f.reader.profitCohort('bsc',f.now()),[],'one more millisecond expires the snapshot');
    f.setNow(86_431);f.batch();assert.deepEqual(f.reader.profitCohort('bsc',f.now()),[]);
  }finally{f.close();}
});

test('reader refresh cadence never extends expiring vendor evidence',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.trade();f.history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:'123'}],
      {source:'gmgn_stats',observedAt:iso(30)});
    f.setNow(86_000);f.batch();
    let profile=f.reader.get('bsc',address(1))!;
    assert.equal(profile.freshUntil,new Date(base+(30+86_400)*1000+1).toISOString());
    assert.equal(profile.status,'current');
    f.setNow(86_430.001);profile=f.reader.get('bsc',address(1))!;
    assert.equal(profile.status,'stale','a six-hour recomputation window cannot extend 24-hour vendor evidence');
  }finally{f.close();}
});

test('profile status counters stay exact between bounded worker-side reconciliations',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.trade(1);f.batch();const first=f.reader.status();assert.equal(first.profiles,1);assert.equal(first.aggregatedAt,iso(100));
    f.setNow(101);f.trade(2,{txHash:hash(2)});f.batch();const incremental=f.reader.status();
    assert.equal(incremental.profiles,2);assert.equal(incremental.profiledSourceWallets,2);assert.equal(incremental.aggregatedAt,first.aggregatedAt);
    f.setNow(701);f.batch();assert.equal(f.reader.status().aggregatedAt,iso(701));
  }finally{f.close();}
});

test('future observations, stale caches and token-level profit cannot grant a group',()=>{
  const f=fixture();try{f.trade();relation(f,[100],true);f.raw.prepare('UPDATE wh_assoc_relations SET updated_at=?').run(iso(101));
    const future={chain:'bsc',wallet:address(1),scope:'entire_wallet',period:'7d',verification:'vendor_claim',realizedProfitUsd:'9999',observedAt:iso(101)};
    f.raw.prepare('UPDATE wh_metrics SET profit_data=?,coordination_dirty=0,coordination_checked_at=?,coordination_data=? WHERE chain=? AND address=?')
      .run(JSON.stringify(future),iso(101),JSON.stringify({sharedFunding:[],synchronized:[{wallet:address(2),tokenAddress:address(100),distinctTransactions:4,windowSeconds:120}]}),'bsc',address(1));
    f.batch();assert.deepEqual(f.groups(),['insufficient_evidence']);assert.equal(f.reader.get('bsc',address(1))!.metrics.vendorProfit,undefined);
  }finally{f.close();}
});

test('known public services do not establish shared funding, while synchronized evidence remains a separate clue',()=>{
  const f=fixture();try{f.trade();f.trade(500);f.raw.prepare('UPDATE wh_wallets SET profile=? WHERE chain=? AND address=?').run(JSON.stringify({labels:['exchange']}),'bsc',address(500));
    const evidence={sharedFunding:[{wallet:address(2),address:address(500),observedAt:iso(30)}],synchronized:[{wallet:address(2),tokenAddress:address(100),distinctTransactions:2,windowSeconds:120}]};
    f.raw.prepare('UPDATE wh_metrics SET coordination_dirty=0,coordination_checked_at=?,coordination_data=? WHERE chain=? AND address=?').run(iso(90),JSON.stringify(evidence),'bsc',address(1));f.batch();
    assert.ok(!f.groups().includes('shared_funding'));assert.ok(f.groups().includes('synchronized'));assert.equal(f.reader.get('bsc',address(1))!.counterparties[0].kind,'synchronized');
    f.raw.prepare('UPDATE wh_metrics SET coordination_dirty=1 WHERE chain=? AND address=?').run('bsc',address(1));f.setNow(102);f.batch();assert.ok(!f.groups().includes('synchronized'));
  }finally{f.close();}
});

test('inactivity uses sampled event time rather than repeated polling arrival time',()=>{
  const f=fixture();try{f.setNow(8*86_400);f.trade(1,{eventAt:iso(10),observedAt:iso(8*86_400)});f.batch();assert.ok(f.groups().includes('inactive_observed'));
    f.history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:null}],{source:'gmgn_stats',observedAt:iso(8*86_400+2)});
    f.setNow(8*86_400+3);f.batch();assert.ok(f.groups().includes('inactive_observed'));assert.equal(f.reader.get('bsc',address(1))!.metrics.lastEventAt,iso(10));
  }finally{f.close();}
});

test('new chain-only wallets are indexed, transfers are not trades, and removed logs are excluded on refresh',()=>{
  const f=fixture();try{
    const log={address:address(100),topics:[TRANSFER_TOPIC,'0x'+address(1).slice(2).padStart(64,'0'),'0x'+address(2).slice(2).padStart(64,'0')],data:'0x'+'1'.padStart(64,'0'),transactionHash:hash(100),blockHash:hash(200),blockNumber:'0x1',logIndex:'0x0'};
    const event=evmTransfers('bsc',log,new Set([address(1)]),'live',f.now())[0];f.chain.record(event);f.batch();let p=f.reader.get('bsc',address(1))!;
    assert.equal(p.metrics.chain.transactions,1);assert.equal(p.metrics.chain.transfers,1);assert.equal(p.metrics.buyEvents,0);assert.equal(p.metrics.distinctTokens,0);assert.deepEqual(p.groups.map(g=>g.id),['insufficient_evidence']);
    assert.equal(f.reader.status().profiledSourceWallets,0);assert.equal(f.reader.status().profiles,1);assert.equal(f.reader.status().initialComplete,true);
    f.chain.record({...event,removed:true});f.setNow(102);f.batch();p=f.reader.get('bsc',address(1))!;assert.equal(p.metrics.chain.transactions,0);assert.equal(p.metrics.chain.transfers,0);
  }finally{f.close();}
});

test('initial rowid ingestion, changed wallets and expiry progress across bounded batches',()=>{
  const f=fixture();try{for(let i=1;i<=30;i++)f.trade(i);for(let i=0;i<30;i++)f.batch(5);
    const status=f.reader.status();assert.equal(status.profiles,30);assert.equal(status.sourceWallets,30);assert.equal(status.profiledSourceWallets,30);assert.equal(status.initialComplete,true);
    f.setNow(102);f.trade(31,{observedAt:iso(102),eventAt:iso(101)});f.batch(5);assert.ok(f.reader.get('bsc',address(31)));
    assert.equal(f.reader.list({search:address(31)}).total,1);assert.equal(f.reader.list({group:'insufficient_evidence',chain:'bsc',limit:2}).items.length,2);
    f.setNow(200);assert.equal(f.reader.get('bsc',address(1))!.status,'stale');assert.ok(f.reader.status().staleProfiles>0);
  }finally{f.close();}
});

test('periodic reconciliation uses the configured window while source changes remain immediate',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.trade();f.batch();f.setNow(3699);
    assert.equal(f.reader.get('bsc',address(1))!.status,'current');
    assert.equal(f.reader.status().staleProfiles,0);
    f.setNow(3700);assert.equal(f.reader.get('bsc',address(1))!.status,'stale');
    assert.equal(f.reader.status().staleProfiles,1);
    f.history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:'5'}],{source:'gmgn_stats',observedAt:iso(3700)});
    f.batch();assert.equal(f.reader.get('bsc',address(1))!.status,'current');
  }finally{f.close();}
});

test('live wallet and coordination changes are consumed ahead of historical backfill, even before profile expiry',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    for(let i=1;i<=100;i++)f.trade(i);f.batch(5);assert.equal(f.reader.get('bsc',address(1))!.computedAt,iso(100));
    f.setNow(102);f.history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:'500'}],{source:'gmgn_stats',observedAt:iso(102)});
    f.batch(5);assert.equal(f.reader.get('bsc',address(1))!.computedAt,iso(102));assert.ok(f.groups().includes('vendor_profit_positive'));
    f.setNow(104);f.raw.prepare('UPDATE wh_metrics SET coordination_dirty=0,coordination_checked_at=?,coordination_data=? WHERE chain=? AND address=?')
      .run(iso(104),JSON.stringify({sharedFunding:[],synchronized:[{wallet:address(2),tokenAddress:address(100),distinctTransactions:2,windowSeconds:120}]}),'bsc',address(1));
    f.batch(5);assert.equal(f.reader.get('bsc',address(1))!.computedAt,iso(104));assert.ok(f.groups().includes('synchronized'));
    assert.equal(f.reader.status().initialComplete,false);
  }finally{f.close();}
});

test('new GMGN market first-seen intervals reclassify existing wallets without waiting for profile expiry',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(1000);
    for(let i=0;i<3;i++)f.trade(1,{tokenAddress:address(100+i),txHash:hash(7000+i),eventAt:iso(100+i*10),observedAt:iso(101+i*10)});
    f.batch();assert.equal(f.reader.get('bsc',address(1))!.initiatorAnalysis,undefined);
    for(let i=0;i<3;i++)f.history.captureMarketCandidate({chain:'bsc',address:address(100+i)},
      {source:'gmgn_market_discovery',observedAt:iso(220+i*10),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
        changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(210+i*10),firstSeenUpperBound:iso(220+i*10),leftCensored:false});
    f.setNow(1002);f.batch();let profile=f.reader.get('bsc',address(1))!,analysis=profile.initiatorAnalysis!;
    assert.equal(profile.computedAt,iso(1002));assert.equal(analysis.classification,'precursor');assert.equal(analysis.prospectivePreTokens,3);
    assert.equal(analysis.qualification?.knownAt,iso(1002));assert.equal(analysis.screeningEvidence,undefined);
    assert.ok(f.groups().includes('market_precursor_pattern'));assert.equal(profile.groups.find(group=>group.id==='market_precursor_pattern')!.evidenceCount,3);
    assert.equal(f.reader.status().groupCounts.market_precursor_pattern,1);
    assert.equal(f.reader.streamTargets('bsc',1)[0]?.address,address(1),'prospective precursors enter the bounded research stream cohort');
    const qualifiedAt=analysis.qualification!.knownAt;
    for(let i=0;i<3;i++)f.trade(1,{tokenAddress:address(100+i),txHash:hash(7100+i),side:'sell',eventAt:iso(300+i*10),observedAt:iso(301+i*10)});
    f.setNow(1004);f.batch();profile=f.reader.get('bsc',address(1))!;analysis=profile.initiatorAnalysis!;
    assert.equal(analysis.qualification?.knownAt,qualifiedAt,'later exits do not re-date the directional qualification');
    assert.equal(analysis.postActivationExitTokens,3);assert.ok(f.groups().includes('market_repeated_exit'));
  }finally{f.close();}
});

test('a prospective market precursor becomes a visible-start candidate only after pre-registered public wallets buy later',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(1000);
    for(let i=0;i<3;i++){
      f.trade(1,{tokenAddress:address(100+i),txHash:hash(7200+i),eventAt:iso(100+i*10),observedAt:iso(101+i*10)});
      f.trade(2,{tokenAddress:address(100+i),txHash:hash(7300+i),eventAt:iso(150+i*10),observedAt:iso(151+i*10),source:'gmgn_kol_feed'});
      f.history.captureMarketCandidate({chain:'bsc',address:address(100+i)},
        {source:'gmgn_market_discovery',observedAt:iso(220+i*10),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
          changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(210+i*10),firstSeenUpperBound:iso(220+i*10),leftCensored:false});
    }
    f.raw.prepare(`INSERT INTO wh_assoc_relations(chain,leader,candidate,first_at,updated_at,token_count,forward_count,funding_count,dirty,data,funding_data,active_since)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('bsc',address(2),address(1),iso(40),iso(300),3,3,0,0,'{}','[]',iso(50));
    f.batch(1000);const profile=f.reader.get('bsc',address(1))!,visible=profile.visibleStartAnalysis!;
    assert.equal(profile.initiatorAnalysis?.classification,'precursor');
    assert.equal(visible.classification,'visible_start_candidate');assert.equal(visible.status,'current');
    assert.equal(visible.directionalTokens.followed,3);assert.equal(visible.followShare,1);
    assert.equal(visible.qualification?.knownAt,iso(1000));assert.equal(visible.screeningEvidence,undefined);
    assert.ok(f.groups().includes('market_visible_start'));assert.equal(profile.groups.find(group=>group.id==='market_visible_start')!.evidenceCount,3);
    assert.equal(f.reader.streamTargets('bsc',1)[0]?.address,address(1));
  }finally{f.close();}
});

test('partial precursor coverage cannot be upgraded into a current visible-start qualification',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(2000);
    for(let i=0;i<3;i++){
      f.trade(1,{tokenAddress:address(100+i),txHash:hash(7400+i),eventAt:iso(100+i*10),observedAt:iso(101+i*10)});
      f.trade(2,{tokenAddress:address(100+i),txHash:hash(7500+i),eventAt:iso(150+i*10),observedAt:iso(151+i*10),source:'gmgn_kol_feed'});
      f.history.captureMarketCandidate({chain:'bsc',address:address(100+i)},
        {source:'gmgn_market_discovery',observedAt:iso(220+i*10),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
          changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(210+i*10),firstSeenUpperBound:iso(220+i*10),leftCensored:false});
    }
    f.raw.prepare(`INSERT INTO wh_assoc_relations(chain,leader,candidate,first_at,updated_at,token_count,forward_count,funding_count,dirty,data,funding_data,active_since)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('bsc',address(2),address(1),iso(40),iso(300),3,3,0,0,'{}','[]',iso(50));
    for(let i=0;i<500;i++)f.trade(1,{tokenAddress:address(2000+i),txHash:hash(20_000+i),eventAt:iso(300+i),observedAt:iso(301+i)});
    for(let i=0;i<10;i++)f.batch(20);
    const profile=f.reader.get('bsc',address(1))!,visible=profile.visibleStartAnalysis!;
    assert.equal(profile.initiatorAnalysis?.classification,'precursor');assert.equal(profile.initiatorAnalysis?.status,'partial');
    assert.equal(visible.status,'partial');assert.equal(visible.classification,'insufficient');assert.equal(visible.qualification,undefined);
    assert.ok(!f.groups().includes('market_visible_start'));
  }finally{f.close();}
});

test('a relation update immediately recomputes the candidate after its public peer buys',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(1000);
    for(let i=0;i<3;i++){
      f.trade(1,{tokenAddress:address(100+i),txHash:hash(7600+i),eventAt:iso(100+i*10),observedAt:iso(101+i*10)});
      f.history.captureMarketCandidate({chain:'bsc',address:address(100+i)},
        {source:'gmgn_market_discovery',observedAt:iso(220+i*10),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
          changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(210+i*10),firstSeenUpperBound:iso(220+i*10),leftCensored:false});
    }
    f.raw.prepare(`INSERT INTO wh_assoc_relations(chain,leader,candidate,first_at,updated_at,token_count,forward_count,funding_count,dirty,data,funding_data,active_since)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('bsc',address(2),address(1),iso(40),iso(300),3,0,0,0,'{}','[]',iso(50));
    f.batch(1000);const before=f.reader.get('bsc',address(1))!;
    assert.equal(before.visibleStartAnalysis?.classification,'insufficient');assert.ok(!f.groups().includes('market_visible_start'));
    f.setNow(1200);
    for(let i=0;i<3;i++)f.trade(2,{tokenAddress:address(100+i),txHash:hash(7700+i),eventAt:iso(500+i*10),observedAt:iso(501+i*10),source:'gmgn_kol_feed'});
    f.raw.prepare('UPDATE wh_assoc_relations SET updated_at=?,forward_count=3 WHERE chain=? AND leader=? AND candidate=?')
      .run(iso(1100),'bsc',address(2),address(1));
    f.batch(1000);const after=f.reader.get('bsc',address(1))!;
    assert.equal(after.computedAt,iso(1200));assert.equal(after.visibleStartAnalysis?.classification,'visible_start_candidate');
    assert.ok(f.groups().includes('market_visible_start'));
  }finally{f.close();}
});

test('a zero-token relation update immediately revokes a visible-start qualification and group',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(1000);
    for(let i=0;i<3;i++){
      f.trade(1,{tokenAddress:address(100+i),txHash:hash(7800+i*2),eventAt:iso(100+i*10),observedAt:iso(101+i*10)});
      f.trade(2,{tokenAddress:address(100+i),txHash:hash(7801+i*2),eventAt:iso(150+i*10),observedAt:iso(151+i*10),source:'gmgn_kol_feed'});
      f.history.captureMarketCandidate({chain:'bsc',address:address(100+i)},
        {source:'gmgn_market_discovery',observedAt:iso(220+i*10),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
          changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(210+i*10),firstSeenUpperBound:iso(220+i*10),leftCensored:false});
    }
    f.raw.prepare(`INSERT INTO wh_assoc_relations(chain,leader,candidate,first_at,updated_at,token_count,forward_count,funding_count,dirty,data,funding_data,active_since)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('bsc',address(2),address(1),iso(40),iso(300),3,3,0,0,'{}','[]',iso(50));
    f.batch(1000);let profile=f.reader.get('bsc',address(1))!;
    assert.equal(profile.visibleStartAnalysis?.classification,'visible_start_candidate');assert.ok(profile.visibleStartAnalysis?.qualification);
    assert.ok(f.groups().includes('market_visible_start'));
    f.setNow(1200);f.raw.prepare(`UPDATE wh_assoc_relations SET updated_at=?,token_count=0,forward_count=0,active_since=NULL
      WHERE chain=? AND leader=? AND candidate=?`).run(iso(1100),'bsc',address(2),address(1));
    f.batch(1000);profile=f.reader.get('bsc',address(1))!;
    assert.equal(profile.computedAt,iso(1200),'the relation cursor refreshes the candidate before periodic expiry');
    assert.equal(profile.visibleStartAnalysis?.classification,'insufficient');
    assert.equal(profile.visibleStartAnalysis?.qualificationState,'revoked');assert.equal(profile.visibleStartAnalysis?.qualification,undefined);
    assert.ok(!f.groups().includes('market_visible_start'));
    assert.ok(profile.changes?.some(change=>change.removed.includes('market_visible_start')));
  }finally{f.close();}
});

test('capacity interruption does not advance the relation cursor and recovery retries the candidate',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(1000);
    for(let i=0;i<3;i++){
      f.trade(1,{tokenAddress:address(100+i),txHash:hash(7900+i),eventAt:iso(100+i*10),observedAt:iso(101+i*10)});
      f.history.captureMarketCandidate({chain:'bsc',address:address(100+i)},
        {source:'gmgn_market_discovery',observedAt:iso(220+i*10),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
          changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(210+i*10),firstSeenUpperBound:iso(220+i*10),leftCensored:false});
    }
    f.raw.prepare(`INSERT INTO wh_assoc_relations(chain,leader,candidate,first_at,updated_at,token_count,forward_count,funding_count,dirty,data,funding_data,active_since)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('bsc',address(2),address(1),iso(40),iso(300),3,0,0,0,'{}','[]',iso(50));
    f.batch(1000);assert.equal(f.reader.get('bsc',address(1))!.visibleStartAnalysis?.classification,'insufficient');
    const before={at:profileMeta(f.database,'relation_changed_at'),row:profileMeta(f.database,'relation_changed_row')};
    f.setNow(1200);
    for(let i=0;i<3;i++)f.trade(2,{tokenAddress:address(100+i),txHash:hash(7950+i),eventAt:iso(500+i*10),observedAt:iso(501+i*10),source:'gmgn_kol_feed'});
    f.raw.prepare('UPDATE wh_assoc_relations SET updated_at=?,forward_count=3 WHERE chain=? AND leader=? AND candidate=?')
      .run(iso(1100),'bsc',address(2),address(1));
    f.restart(16_384);assert.equal(f.batch(1000).capacityReached,true);
    assert.deepEqual({at:profileMeta(f.database,'relation_changed_at'),row:profileMeta(f.database,'relation_changed_row')},before);
    f.restart(16*1024*1024);f.batch(1000);const profile=f.reader.get('bsc',address(1))!;
    assert.equal(profile.visibleStartAnalysis?.classification,'visible_start_candidate');assert.ok(profile.visibleStartAnalysis?.qualification);
    assert.ok(f.groups().includes('market_visible_start'));
    assert.equal(profileMeta(f.database,'relation_changed_at'),iso(1100));
  }finally{f.close();}
});

test('ordinary due profiles do not scan lifetime market tokens before a prospective nomination',()=>{
  const f=fixture();try{
    f.trade();f.batch();assert.equal(f.reader.get('bsc',address(1))!.initiatorAnalysis,undefined);
    f.raw.exec('DROP TABLE wh_wallet_tokens');f.setNow(102);
    assert.doesNotThrow(()=>f.batch());assert.equal(f.reader.get('bsc',address(1))!.initiatorAnalysis,undefined);
  }finally{f.close();}
});

test('market cursor skips empty observations and pages every buyer of a popular token without skipping the next token',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(1000);
    for(let wallet=1;wallet<=7;wallet++)f.trade(wallet,{tokenAddress:address(100),txHash:hash(8000+wallet),
      eventAt:iso(100+wallet),observedAt:iso(101+wallet)});
    f.trade(8,{tokenAddress:address(101),txHash:hash(8100),eventAt:iso(120),observedAt:iso(121)});
    f.batch(100);assert.ok(Array.from({length:8},(_,i)=>f.reader.get('bsc',address(i+1))).every(Boolean));
    f.history.captureMarketCandidate({chain:'bsc',address:address(999)},
      {source:'gmgn_market_discovery',observedAt:iso(200),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
        changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(190),firstSeenUpperBound:iso(200),leftCensored:false});
    for(const [token,at] of [[100,220],[101,230]] as const)f.history.captureMarketCandidate({chain:'bsc',address:address(token)},
      {source:'gmgn_market_discovery',observedAt:iso(at),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
        changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(at-10),firstSeenUpperBound:iso(at),leftCensored:false});
    f.setNow(1002);for(let i=0;i<9;i++)f.batch(5);
    for(let wallet=1;wallet<=8;wallet++)assert.ok(f.reader.get('bsc',address(wallet))!.initiatorAnalysis,
      `wallet ${wallet} must be nominated exactly through the durable market page`);
    assert.equal(profileMeta(f.database,'market_wallet'),'');
  }finally{f.close();}
});

test('legacy first-seen remains left-censored counterevidence when another feed later creates an interval',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(1000);f.trade(1,{eventAt:iso(100),observedAt:iso(101)});f.batch();
    f.history.captureMarketCandidate({chain:'bsc',address:address(100)},
      {source:'gmgn_market_discovery',observedAt:iso(150),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
        changeKind:'first_seen',category:'new_creation'});
    f.history.captureMarketCandidate({chain:'bsc',address:address(100)},
      {source:'gmgn_market_discovery',observedAt:iso(220),kind:'trending',reason:'first_seen:trending',window:'1h',
        changeKind:'first_seen',category:'trending',firstSeenLowerBound:iso(210),firstSeenUpperBound:iso(220),leftCensored:false});
    f.setNow(1002);f.batch();const profile=f.reader.get('bsc',address(1))!,analysis=profile.initiatorAnalysis!;
    assert.equal(analysis.classification,'insufficient');assert.equal(analysis.prospectivePreTokens,0);
    assert.equal(analysis.directionalTokens.ambiguous,1);assert.ok(!f.groups().includes('market_pre_candidate'));
    const output=new DatabaseSync(f.database,{readOnly:true});try{
      assert.equal(output.prepare('SELECT market_at FROM wp_initiator_tokens WHERE chain=? AND address=? AND token_address=?')
        .get('bsc',address(1),address(100))!.market_at,iso(150),'frame order freezes the canonical earliest first-seen');
    }finally{output.close();}
  }finally{f.close();}
});

test('a later wallet buy joins an existing prospective market cohort without another market notification',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(300);f.history.captureMarketCandidate({chain:'bsc',address:address(100)},
      {source:'gmgn_market_discovery',observedAt:iso(200),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
        changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(190),firstSeenUpperBound:iso(200),leftCensored:false});
    f.batch();
    f.setNow(400);f.trade(1,{eventAt:iso(250),observedAt:iso(251),txHash:hash(8200)});f.batch();
    const analysis=f.reader.get('bsc',address(1))!.initiatorAnalysis!;
    assert.equal(analysis.directionalTokens.post,1);assert.equal(analysis.classification,'insufficient');
    const output=new DatabaseSync(f.database,{readOnly:true});try{
      assert.equal(output.prepare('SELECT count(*) AS n FROM wp_initiator_tokens WHERE chain=? AND address=?').get('bsc',address(1))!.n,1);
    }finally{output.close();}
  }finally{f.close();}
});

test('global event cursor retains an older post-market buy after a busy wallet pushes it outside the recent 500 frame',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(300);f.history.captureMarketCandidate({chain:'bsc',address:address(100)},
      {source:'gmgn_market_discovery',observedAt:iso(200),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
        changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(190),firstSeenUpperBound:iso(200),leftCensored:false});
    f.batch(1000);assert.equal(f.reader.get('bsc',address(1)),undefined,'market page is exhausted before the wallet appears');
    f.setNow(2000);f.trade(1,{tokenAddress:address(100),txHash:hash(9000),eventAt:iso(250),observedAt:iso(251)});
    for(let i=0;i<500;i++)f.trade(1,{tokenAddress:address(2000+i),txHash:hash(10_000+i),eventAt:iso(300+i),observedAt:iso(301+i)});
    f.batch(1000);let profile=f.reader.get('bsc',address(1))!,analysis=profile.initiatorAnalysis!;
    assert.equal(profile.metrics.observedEvents,500,'the ordinary profile frame has dropped the older relevant buy');
    assert.equal(analysis.directionalTokens.post,1,'the independent event cursor still nominates the dropped buy');
    assert.equal(analysis.status,'partial','qualification stays conservative until the durable event cursor catches up');
    const output=new DatabaseSync(f.database,{readOnly:true});try{
      assert.equal(output.prepare('SELECT count(*) AS n FROM wp_initiator_tokens WHERE chain=? AND address=? AND token_address=?')
        .get('bsc',address(1),address(100))!.n,1);
    }finally{output.close();}
    f.batch(1000);f.batch(1000);assert.equal(Number(profileMeta(f.database,'initiator_event_cursor')),501);
    f.setNow(5601);f.batch(1000);profile=f.reader.get('bsc',address(1))!;analysis=profile.initiatorAnalysis!;
    assert.equal(analysis.status,'current');assert.equal(analysis.directionalTokens.post,1);
  }finally{f.close();}
});

test('tracked initiator refresh reads only the compact token ledger despite thousands of unrelated lifetime tokens',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(1000);f.trade(1,{eventAt:iso(100),observedAt:iso(101)});f.batch();
    f.history.captureMarketCandidate({chain:'bsc',address:address(100)},
      {source:'gmgn_market_discovery',observedAt:iso(220),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
        changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(210),firstSeenUpperBound:iso(220),leftCensored:false});
    f.setNow(1002);f.batch();assert.ok(f.reader.get('bsc',address(1))!.initiatorAnalysis);
    f.raw.exec('BEGIN');const insert=f.raw.prepare('INSERT OR IGNORE INTO wh_wallet_tokens VALUES (?,?,?)');
    for(let i=0;i<3000;i++)insert.run('bsc',address(1),address(10_000+i));f.raw.exec('COMMIT');
    f.raw.exec('DROP TABLE wh_wallet_tokens');f.setNow(5000);
    assert.doesNotThrow(()=>f.batch());const analysis=f.reader.get('bsc',address(1))!.initiatorAnalysis!;
    assert.equal(analysis.selectedTokens,1);assert.equal(analysis.totalCandidateTokens,1);
  }finally{f.close();}
});

test('capacity interruption preserves both levels of the market cursor and retries the nomination',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(1000);f.trade(1,{eventAt:iso(100),observedAt:iso(101)});f.batch();
    f.history.captureMarketCandidate({chain:'bsc',address:address(100)},
      {source:'gmgn_market_discovery',observedAt:iso(220),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
        changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(210),firstSeenUpperBound:iso(220),leftCensored:false});
    const before={cursor:profileMeta(f.database,'market_cursor'),wallet:profileMeta(f.database,'market_wallet')};
    f.restart(16_384);f.setNow(1002);assert.equal(f.batch().capacityReached,true);
    assert.deepEqual({cursor:profileMeta(f.database,'market_cursor'),wallet:profileMeta(f.database,'market_wallet')},before);
    f.restart(16*1024*1024);f.batch();assert.ok(f.reader.get('bsc',address(1))!.initiatorAnalysis);
  }finally{f.close();}
});

test('capacity interruption never advances the prospective wallet-event cursor',()=>{
  const f=fixture({refreshAfterSec:3600});try{
    f.setNow(300);f.history.captureMarketCandidate({chain:'bsc',address:address(100)},
      {source:'gmgn_market_discovery',observedAt:iso(200),kind:'trenches',reason:'first_seen:new_creation',window:'lifecycle',
        changeKind:'first_seen',category:'new_creation',firstSeenLowerBound:iso(190),firstSeenUpperBound:iso(200),leftCensored:false});
    f.batch();f.setNow(400);f.trade(1,{eventAt:iso(250),observedAt:iso(251),txHash:hash(8300)});
    const before=profileMeta(f.database,'initiator_event_cursor');f.restart(16_384);assert.equal(f.batch().capacityReached,true);
    assert.equal(profileMeta(f.database,'initiator_event_cursor'),before);
    f.restart(16*1024*1024);f.batch();assert.equal(f.reader.get('bsc',address(1))!.initiatorAnalysis!.directionalTokens.post,1);
  }finally{f.close();}
});

test('capacity stops derived writes without deleting source evidence, and expanding capacity resumes',()=>{
  const f=fixture({maxBytes:16_384});try{f.trade();const status=f.batch();assert.equal(status.capacityReached,true);assert.equal(f.reader.list().total,0);assert.equal(f.history.stats().wallets,1);
    f.restart();assert.equal(f.reader.status().capacityReached,false);f.batch();assert.equal(f.reader.list().total,1);assert.equal(f.history.stats().events,1);
  }finally{f.close();}
});

test('directional role backfill counts late buys as counterexamples instead of selecting only early winners',()=>{
  const f=fixture();try {
    f.setNow(1000);
    for(let i=0;i<23;i++){
      const at=100+i*20,tokenAddress=address(100+i);
      f.trade(2,{tokenAddress,txHash:hash(1000+i*2),eventAt:iso(at),observedAt:iso(at+1),source:'gmgn_kol_feed'});
      f.trade(1,{tokenAddress,txHash:hash(1001+i*2),eventAt:iso(at+(i<3?-5:5)),observedAt:iso(at+6)});
    }
    f.batch();const profile=f.reader.get('bsc',address(1))!,peer=profile.roleAnalysis!.peers[0];
    assert.equal(peer.address,address(2));assert.equal(peer.classification,'follower_pattern');
    assert.equal(peer.directionalTokens.lead,3);assert.equal(peer.directionalTokens.follow,20);assert.equal(peer.matchedTokens,23);
    assert.ok(f.groups().includes('follower_pattern'));assert.ok(!f.groups().includes('precursor_pattern'));
    assert.equal(f.reader.list({group:'follower_pattern'}).total,1);assert.equal(f.reader.status().rolePending,0);
    assert.equal(f.reader.status().roleProfiles,2);assert.ok(peer.counterEvidence.length>0);assert.equal(peer.ownership,'unknown');
  } finally {f.close();}
});

test('role analysis reads earlier local buys and conflicting source timestamps rather than trusting the recent winner snapshot',()=>{
  const f=fixture();try {
    f.setNow(1000);
    for(let i=0;i<3;i++){
      const tokenAddress=address(100+i),at=100+i*20;
      f.trade(1,{tokenAddress,txHash:hash(1000+i*3),eventAt:iso(at),observedAt:iso(at+1)});
      f.trade(2,{tokenAddress,txHash:hash(1001+i*3),eventAt:iso(at+10),observedAt:iso(at+11),source:'gmgn_kol_feed'});
    }
    f.batch();assert.ok(f.groups().includes('precursor_pattern'));
    assert.equal(f.reader.get('bsc',address(1))!.roleAnalysis!.peers[0].qualification!.knownAt,iso(1000));
    f.setNow(1601);
    for(let i=0;i<3;i++)f.trade(2,{tokenAddress:address(100+i),txHash:hash(2000+i),eventAt:iso(90+i*20),observedAt:iso(1600)});
    f.batch();assert.ok(f.groups().includes('follower_pattern'));assert.ok(!f.groups().includes('precursor_pattern'));
    assert.equal(f.reader.get('bsc',address(1))!.roleAnalysis!.peers[0].qualification,undefined);
    assert.ok(f.reader.get('bsc',address(1))!.changes!.some(c=>c.removed.includes('precursor_pattern')));
    // Canonical event still has its original timestamp; a different source has
    // a conflicting timestamp and must make that contract ambiguous.
    f.trade(1,{tokenAddress:address(100),txHash:hash(1000),eventAt:iso(95),observedAt:iso(1601),source:'gmgn_smartmoney_feed'});
    f.setNow(2202);f.batch();const peer=f.reader.get('bsc',address(1))!.roleAnalysis!.peers[0];
    assert.equal(peer.directionalTokens.ambiguous,1);assert.equal(peer.classification,'insufficient');
  } finally {f.close();}
});

test('peer screening qualification persists independently of current profile refresh time and survives restart',()=>{
  const f=fixture();try {
    f.setNow(1000);
    for(let i=0;i<4;i++){
      f.trade(1,{tokenAddress:address(100+i),txHash:hash(5000+i*2),eventAt:iso(100+i*20),observedAt:iso(101+i*20)});
      f.trade(2,{tokenAddress:address(100+i),txHash:hash(5001+i*2),eventAt:iso(110+i*20),observedAt:iso(111+i*20),source:'gmgn_kol_feed'});
    }
    f.batch();const frozen=structuredClone(f.reader.get('bsc',address(1))!.roleAnalysis!.peers[0].qualification);
    assert.equal(frozen!.knownAt,iso(1000));assert.equal(frozen!.evidence.length,4);
    f.setNow(1002);f.batch();let updated=f.reader.get('bsc',address(1))!;
    assert.equal(updated.computedAt,iso(1002));assert.equal(updated.roleAnalysis!.computedAt,iso(1002));
    assert.deepEqual(updated.roleAnalysis!.peers[0].qualification,frozen);
    f.restart();f.setNow(1004);f.batch();updated=f.reader.get('bsc',address(1))!;
    assert.equal(updated.computedAt,iso(1004));assert.deepEqual(updated.roleAnalysis!.peers[0].qualification,frozen);
  }finally{f.close();}
});

test('legacy roles without screening certificates are migrated at the actual new computation time, even with an unchanged cache key',()=>{
  const f=fixture({refreshAfterSec:3600});try {
    f.setNow(1000);
    for(let i=0;i<3;i++){
      f.trade(1,{tokenAddress:address(100+i),txHash:hash(6000+i*2),eventAt:iso(100+i*20),observedAt:iso(101+i*20)});
      f.trade(2,{tokenAddress:address(100+i),txHash:hash(6001+i*2),eventAt:iso(110+i*20),observedAt:iso(111+i*20),source:'gmgn_kol_feed'});
    }
    f.batch();const output=new DatabaseSync(f.database);
    output.prepare('UPDATE wp_profiles SET data=json_remove(data,?,?,?) WHERE chain=? AND address=?').run(
      '$.roleAnalysis.method.screeningEvidenceLimitPerPeer','$.roleAnalysis.peers[0].qualification','$.roleAnalysis.peers[0].screeningEvidence','bsc',address(1));output.close();
    f.setNow(1002);f.history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:'2000'}],{source:'gmgn_stats',observedAt:iso(1002)});f.batch();
    const role=f.reader.get('bsc',address(1))!.roleAnalysis!;
    assert.equal(role.computedAt,iso(1002));assert.equal(role.peers[0].qualification!.knownAt,iso(1002));
    assert.equal(role.peers[0].screeningEvidence,undefined);assert.equal(role.peers[0].qualification!.evidence.length,3);
  }finally{f.close();}
});

test('frozen leading proofs outside the current 30-token frame are rechecked before retaining the old qualification',()=>{
  const f=fixture();try {
    const pair=(token:number,at:number)=>{
      f.trade(1,{tokenAddress:address(token),txHash:hash(token*2),eventAt:iso(at),observedAt:iso(at+1)});
      f.trade(2,{tokenAddress:address(token),txHash:hash(token*2+1),eventAt:iso(at+10),observedAt:iso(at+11),source:'gmgn_kol_feed'});
    };
    f.setNow(1000);for(let i=0;i<3;i++)pair(100+i,100+i*20);f.batch();
    assert.equal(f.reader.get('bsc',address(1))!.roleAnalysis!.peers[0].qualification!.knownAt,iso(1000));
    f.setNow(2000);for(let i=0;i<30;i++)pair(200+i,1100+i*20);f.batch();
    let peer=f.reader.get('bsc',address(1))!.roleAnalysis!.peers[0];assert.equal(peer.totalCandidateTokens,30);
    assert.equal(peer.screeningEvidence,undefined);assert.equal(peer.qualification!.knownAt,iso(1000));
    f.setNow(2700);f.trade(2,{tokenAddress:address(100),txHash:hash(90000),eventAt:iso(90),observedAt:iso(2699)});f.batch();
    peer=f.reader.get('bsc',address(1))!.roleAnalysis!.peers[0];assert.equal(peer.classification,'precursor_pattern');
    assert.equal(peer.qualification!.knownAt,iso(2700));assert.ok(!peer.qualification!.evidence.some(row=>row.tokenAddress===address(100)));
  }finally{f.close();}
});

test('leader-only counterevidence inside the old role-cache window cannot preserve an invalid frozen qualification',()=>{
  const f=fixture({refreshAfterSec:3600});try {
    f.setNow(1000);
    for(let i=0;i<4;i++){
      f.trade(1,{tokenAddress:address(100+i),txHash:hash(7000+i*2),eventAt:iso(100+i*20),observedAt:iso(101+i*20)});
      f.trade(2,{tokenAddress:address(100+i),txHash:hash(7001+i*2),eventAt:iso(110+i*20),observedAt:iso(111+i*20),source:'gmgn_kol_feed'});
    }
    f.batch();assert.equal(f.reader.get('bsc',address(1))!.roleAnalysis!.peers[0].qualification!.knownAt,iso(1000));
    f.setNow(1002);f.trade(2,{tokenAddress:address(100),txHash:hash(99999),eventAt:iso(90),observedAt:iso(1001)});
    f.history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:'2000'}],{source:'gmgn_stats',observedAt:iso(1002)});f.batch();
    const peer=f.reader.get('bsc',address(1))!.roleAnalysis!.peers[0];
    assert.equal(peer.directionalTokens.lead,3);assert.equal(peer.directionalTokens.follow,1);assert.equal(peer.classification,'precursor_pattern');
    assert.equal(peer.qualification!.knownAt,iso(1002));
  }finally{f.close();}
});

test('new qualifications use actual batch completion time while transaction proofs remain bounded by the earlier read snapshot',()=>{
  const f=fixture();let engine:WalletProfiles|undefined;try {
    f.setNow(1020);
    for(let i=0;i<3;i++){
      f.trade(1,{tokenAddress:address(100+i),txHash:hash(8000+i*2),eventAt:iso(100+i*20),observedAt:iso(101+i*20)});
      f.trade(2,{tokenAddress:address(100+i),txHash:hash(8001+i*2),eventAt:iso(110+i*20),observedAt:iso(111+i*20),source:'gmgn_kol_feed'});
    }
    f.trade(1,{tokenAddress:address(999),txHash:hash(8998),eventAt:iso(1005),observedAt:iso(1006)});
    f.trade(2,{tokenAddress:address(999),txHash:hash(8999),eventAt:iso(1007),observedAt:iso(1008),source:'gmgn_kol_feed'});
    let calls=0,advancing=false;
    engine=new WalletProfiles({database:f.database,historyDatabase:f.historyPath,now:()=>new Date(iso(advancing&&calls++>0?1010:1000))});
    advancing=true;engine.runBatch(100);
    const profile=f.reader.get('bsc',address(1))!,role=profile.roleAnalysis!,qualification=role.peers[0].qualification!;
    assert.equal(qualification.knownAt,iso(1010));assert.equal(profile.computedAt,iso(1010));assert.equal(role.computedAt,iso(1010));
    assert.ok(qualification.knownAt>iso(1005),'a buy during computation cannot become a pre-known relationship trigger');
    assert.equal(qualification.evidence.length,3);assert.ok(!qualification.evidence.some(row=>row.tokenAddress===address(999)));
    assert.ok(qualification.evidence.every(row=>row.candidateBuy!.observedAt<=iso(1000)&&row.leaderBuy!.observedAt<=iso(1000)));
  }finally{engine?.close();f.close();}
});

test('different event indexes in the same transaction cannot hide canonical timing conflicts on either wallet',()=>{
  for(const conflictedWallet of [1,2]){
    const f=fixture();try {
      f.setNow(1000);
      for(let i=0;i<3;i++){
        const tokenAddress=address(100+i),at=100+i*100;
        f.trade(1,{tokenAddress,txHash:hash(1000+i*2),eventIndex:0,eventAt:iso(at),observedAt:iso(at+1)});
        f.trade(2,{tokenAddress,txHash:hash(1001+i*2),eventIndex:0,eventAt:iso(at+10),observedAt:iso(at+11),source:'gmgn_kol_feed'});
      }
      const conflictedHash=hash(conflictedWallet===1?1000:1001),originalAt=conflictedWallet===1?100:110;
      // Equal timestamps at different indexes, another wallet, another CA and
      // another transaction are not contradictory timing evidence for this buy.
      f.trade(conflictedWallet,{txHash:conflictedHash,eventIndex:1,eventAt:iso(originalAt),observedAt:iso(500)});
      f.trade(3,{txHash:conflictedHash,eventIndex:2,eventAt:iso(originalAt+30),observedAt:iso(500)});
      f.trade(conflictedWallet,{tokenAddress:address(999),txHash:conflictedHash,eventIndex:2,eventAt:iso(originalAt+30),observedAt:iso(500)});
      f.trade(conflictedWallet,{txHash:hash(9000),eventIndex:2,eventAt:iso(originalAt+30),observedAt:iso(500)});
      f.batch();assert.ok(f.groups().includes('precursor_pattern'));
      // This is a distinct wh_events row, so looking only at the earliest
      // canonical row's observation ID would miss the time disagreement.
      f.setNow(1601);
      f.trade(conflictedWallet,{txHash:conflictedHash,eventIndex:3,eventAt:iso(originalAt+20),observedAt:iso(1600)});
      f.batch();const role=f.reader.get('bsc',address(1))!.roleAnalysis!.peers.find(peer=>peer.address===address(2))!;
      assert.equal(role.directionalTokens.lead,2);assert.equal(role.directionalTokens.ambiguous,1);
      assert.equal(role.classification,'insufficient');assert.ok(!f.groups().includes('precursor_pattern'));
      assert.ok(role.evidence.some(row=>row.tokenAddress===address(100)&&row.direction==='ambiguous'));
    } finally {f.close();}
  }
});

test('old profiles acquire role analysis without new trades and common high-degree funders are excluded',()=>{
  const f=fixture();try {
    f.trade();f.batch();
    const output=new DatabaseSync(f.database);
    output.prepare('UPDATE wp_profiles SET role_computed_at=NULL,role_input_key=NULL,data=json_remove(data,?)').run('$.roleAnalysis');output.close();
    f.restart();
    assert.equal(f.reader.status().rolePending,1);f.batch(5);assert.ok(f.reader.get('bsc',address(1))!.roleAnalysis);
    assert.equal(f.reader.status().rolePending,0);
    for(let i=1;i<=21;i++)f.raw.prepare('INSERT INTO wh_funding(id,chain,wallet,funding_address,observed_at,shared,conflict,snapshot_at,data) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('hub-'+i,'bsc',address(i),address(500),iso(30),0,0,iso(30),'{}');
    f.raw.prepare('UPDATE wh_metrics SET coordination_dirty=0,coordination_checked_at=?,coordination_data=? WHERE chain=? AND address=?')
      .run(iso(90),JSON.stringify({sharedFunding:[{wallet:address(2),address:address(500),observedAt:iso(30)}],synchronized:[]}),'bsc',address(1));
    f.setNow(102);f.batch();assert.ok(!f.groups().includes('shared_funding'));
  } finally {f.close();}
});

test('existing profile databases migrate role columns without dropping profiles or first-recognition history',()=>{
  const f=fixture();try {
    f.trade();f.batch();const first=f.reader.get('bsc',address(1))!.groups[0].firstObservedAt;
    const output=new DatabaseSync(f.database);output.exec('DROP INDEX wp_profiles_roles; ALTER TABLE wp_profiles DROP COLUMN role_computed_at; ALTER TABLE wp_profiles DROP COLUMN role_input_key');output.close();
    f.restart();assert.equal(f.reader.status().profiles,1);assert.equal(f.reader.status().rolePending,1);
    f.batch();assert.equal(f.reader.status().rolePending,0);assert.equal(f.reader.get('bsc',address(1))!.groups[0].firstObservedAt,first);
    assert.equal(f.reader.get('bsc',address(1))!.changes!.length,1);assert.equal(f.history.stats().events,1);
  } finally {f.close();}
});
