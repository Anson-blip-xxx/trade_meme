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

test('capacity stops derived writes without deleting source evidence, and expanding capacity resumes',()=>{
  const f=fixture({maxBytes:16_384});try{f.trade();const status=f.batch();assert.equal(status.capacityReached,true);assert.equal(f.reader.list().total,0);assert.equal(f.history.stats().wallets,1);
    f.restart();assert.equal(f.reader.status().capacityReached,false);f.batch();assert.equal(f.reader.list().total,1);assert.equal(f.history.stats().events,1);
  }finally{f.close();}
});
