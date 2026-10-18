import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WalletHistory,type WalletTradeObservation} from '../src/wallet-history.js';
import {WalletObserver} from '../src/wallet-observer.js';
import {loadBundledWalletResearchSeeds,normalizeWalletResearchSeeds} from '../src/wallet-research-seeds.js';

const snapshot=loadBundledWalletResearchSeeds(),a=snapshot.entries[0].address,b=snapshot.entries[1].address;
const start=Date.parse('2026-10-18T08:00:00.000Z'),iso=(delta=0)=>new Date(start+delta).toISOString();
const trade=(patch:Partial<WalletTradeObservation>={}):WalletTradeObservation=>({chain:'bsc',wallet:a,
  tokenAddress:'0x'+ 'a'.repeat(40),txHash:'0x'+'1'.repeat(64),side:'buy',eventAt:iso(-5000),observedAt:iso(-1000),
  source:'gmgn_wallet_activity',usd:'10',...patch});

test('pinned source snapshot validates 449 unique non-zero addresses; malformed rows rejected and aliases never infer identity',()=>{
  assert.equal(snapshot.received,449);assert.equal(snapshot.entries.length,449);assert.equal(snapshot.rejected,0);assert.equal(snapshot.duplicates,0);
  assert.equal(snapshot.commit,'2bae0bcfe62d4a32e11e5368fef37e5abf5d6f50');
  const raw=normalizeWalletResearchSeeds([{address:a,name:'KOL public wallet',groups:['same owner']},
    {address:a.toUpperCase().replace('0X','0x'),name:'another alias',groups:['same owner','smart']},
    {address:'0x'+'0'.repeat(40),name:'zero'},{address:'0x123'}, {address:b,groups:[1]}, {address:b,name:'\u202e alias\n'}]);
  assert.equal(raw.entries.length,2);assert.equal(raw.duplicates,1);assert.equal(raw.rejected,3);
  assert.deepEqual(raw.entries.find(v=>v.address===a)?.labels,['KOL public wallet','another alias']);
  assert.equal(raw.entries.find(v=>v.address===b)?.labels[0],'alias');
  assert.throws(()=>normalizeWalletResearchSeeds({address:a}),/WALLET_RESEARCH_SEEDS_INVALID/);
});

test('import is idempotent isolated metadata, creates no chain wallet, trade, funding, profile label, KOL relationship or profit',()=>{
  let now=start;const history=new WalletHistory(':memory:',{now:()=>new Date(now)});
  try {
    history.importResearchSeeds(snapshot);const first=history.researchSeedStatus();now+=60000;history.importResearchSeeds(snapshot);
    assert.deepEqual(history.researchSeedStatus(),first);assert.equal(first.totalAddresses,449);
    for(const k of ['wallets','events','observations','tokens','fundingLinks'] as const)assert.equal(history.stats()[k],0);
    assert.equal(history.getWallet('bsc',a),undefined);assert.equal(history.getWallet('robinhood',a),undefined);
    assert.equal(history.streamWalletTargets('bsc').length,0);assert.equal(history.researchSeedHints('solana',a).length,0);
    const hint=history.researchSeedHints('bsc',a)[0];assert.equal(hint.qualifiesAsSmart,false);assert.equal(hint.ownershipProven,false);
    assert.equal(hint.scope,'research_hint_only');assert.equal(hint.verification,'unverified_external_list');
    const tampered=structuredClone(snapshot);tampered.entries[0].labels=['public_kol'];
    assert.throws(()=>history.importResearchSeeds(tampered),/WALLET_RESEARCH_SEEDS_INVALID/);
  }finally{history.close();}
});

test('chain-local real trades are joined live without converting external aliases into labels or cross-chain relationships',()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(start)});
  try {
    history.importResearchSeeds(snapshot);history.recordTrade(trade());
    const wallet=history.getWallet('bsc',a)!.wallet;assert.equal(wallet.researchSeeds?.length,1);assert.deepEqual(wallet.labels,[]);
    assert.equal(wallet.name,undefined);assert.equal(wallet.profit,undefined);assert.equal(wallet.coordination.ownership,'unknown');
    let status=history.researchSeedStatus();assert.equal(status.chains[0].observedWallets,1);assert.equal(status.chains[0].withTrades,1);
    assert.equal(status.chains[1].observedWallets,0);assert.equal(history.researchSeedTarget('robinhood'),undefined);
    history.recordTrade(trade({chain:'robinhood',side:'transferIn'}));
    assert.equal(history.researchSeedStatus().chains[1].observedWallets,1);assert.equal(history.researchSeedStatus().chains[1].withTrades,0);
    assert.equal(history.researchSeedTarget('robinhood'),undefined);
    history.recordTrade(trade({chain:'robinhood',side:'sell'}));
    assert.deepEqual(history.researchSeedTarget('robinhood'),{chain:'robinhood',address:a});
    status=history.researchSeedStatus();assert.equal(status.chains[1].withTrades,1);assert.equal(status.chains[1].withBuys,0);
    assert.equal(history.getWallet('robinhood',a)!.wallet.coordination.score,0);
  }finally{history.close();}
});

test('rotation prioritizes unqueried observed traders, bounds queries per chain and persists scheduling across restart',()=>{
  let now=start;const dir=mkdtempSync(join(tmpdir(),'meme-seeds-')),path=join(dir,'history.sqlite');
  let history=new WalletHistory(path,{now:()=>new Date(now)});
  try {
    history.importResearchSeeds(snapshot);history.recordTrade(trade({wallet:b}));
    assert.deepEqual(history.researchSeedTarget('bsc'),{chain:'bsc',address:b});
    history.markResearchSeedChecked({chain:'bsc',address:b,status:'unavailable',accepted:0,reason:'GMGN_REQUEST_FAILED'});
    assert.equal(history.researchSeedTarget('bsc'),undefined);history.close();history=new WalletHistory(path,{now:()=>new Date(now)});
    assert.equal(history.researchSeedTarget('bsc'),undefined);now+=1_800_000;
    assert.deepEqual(history.researchSeedTarget('bsc'),{chain:'bsc',address:a});
    const state=history.researchSeedStatus().chains[0];assert.equal(state.checkedWallets,1);assert.equal(state.lastResult?.status,'unavailable');
    history.markResearchSeedChecked({chain:'solana',address:a,status:'ok',accepted:1});
    history.markResearchSeedChecked({chain:'bsc',address:a,status:'ok',accepted:101});
    assert.equal(history.researchSeedStatus().chains[0].checkedWallets,1);
  }finally{history.close();rmSync(dir,{recursive:true,force:true});}
});

test('capacity stops external probing instead of repeating candidates whose cooldown cannot persist',()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(start)});
  try {
    history.importResearchSeeds(snapshot);assert.ok(history.researchSeedTarget('bsc'));
    const internal=history as unknown as {maxBytes:number};internal.maxBytes=16384;
    history.markResearchSeedChecked({chain:'bsc',address:a,status:'ok',accepted:0});
    assert.equal(history.stats().error,'WALLET_HISTORY_CAPACITY_REACHED');
    assert.equal(history.researchSeedStatus().chains[0].checkedWallets,0);
    assert.equal(history.researchSeedTarget('bsc'),undefined);
  }finally{history.close();}
});

test('seed status and targets drive full chain/address indexed lookups from the bounded seed set',()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(start)}),db=(history as unknown as {db:DatabaseSync}).db;
  const original=db.prepare.bind(db),captured:string[]=[];
  try {
    history.importResearchSeeds(snapshot);
    db.prepare=((sql:string)=>{if(sql.includes('JOIN wh_metrics m'))captured.push(sql);return original(sql);}) as typeof db.prepare;
    history.researchSeedStatus();history.researchSeedTarget('bsc');db.prepare=original;
    assert.equal(captured.length,3);
    for(const sql of captured){
      const params=sql.includes('LEFT JOIN')?['bsc','bsc','bsc']:['bsc'];
      const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...params).map(v=>String(v.detail));
      const metrics=plan.filter(v=>v.startsWith('SEARCH m '));assert.equal(metrics.length,1);
      assert.match(metrics[0],/chain=\? AND address=\?/);assert.ok(!plan.some(v=>/^SCAN m\b/.test(v)));
    }
  }finally{db.prepare=original;history.close();}
});

test('observer substitutes one market turn with one bounded seed activity page, no signal or synthetic trade and no extra request budget',async()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(start)}),calls:{path:string;query:Record<string,string|number>}[]=[];
  const client={cooldownUntil:0,async get(path:string,query:Record<string,string|number>){calls.push({path,query});
    if(path==='/v1/market/rank')return {rank:[]};if(path==='/v1/user/wallet_activity')return {activities:[],next:''};throw new Error('unexpected');}};
  try {
    history.importResearchSeeds(snapshot);const observer=new WalletObserver({history,client,chains:['bsc'],maxRequestsPerCycle:1,now:()=>new Date(start)});
    for(let i=0;i<3;i++){const first=await observer.runOnce();assert.equal(first.collectionMode,'market_wallets');}
    const second=await observer.runOnce();assert.equal(second.collectionMode,'external_seed_research');assert.equal(second.requests,1);
    assert.equal(calls.length,4);assert.deepEqual(calls[3],{path:'/v1/user/wallet_activity',query:{chain:'bsc',wallet_address:a,limit:100}});
    assert.equal(history.stats().wallets,0);assert.equal(history.stats().events,0);
    assert.equal(history.researchSeedStatus().chains[0].checkedWallets,1);
    await observer.runOnce();const fourth=await observer.runOnce();assert.equal(fourth.collectionMode,'market_wallets');
    assert.equal(calls.filter(v=>v.path==='/v1/user/wallet_activity').length,1);
  }finally{history.close();}
});

test('malformed seed activity stays unavailable evidence and provider failures are bounded by persistent retry interval',async()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(start)});let activity=0;
  const client={cooldownUntil:0,async get(path:string){if(path==='/v1/market/rank')return {rank:[]};activity++;throw new Error('secret server detail');}};
  try {
    history.importResearchSeeds(snapshot);const observer=new WalletObserver({history,client,chains:['bsc'],maxRequestsPerCycle:1,now:()=>new Date(start)});
    for(let i=0;i<3;i++)await observer.runOnce();const report=await observer.runOnce();
    assert.equal(report.collectionMode,'external_seed_research');assert.equal(report.requests,1);
    assert.equal(history.researchSeedStatus().chains[0].lastResult?.reason,'GMGN_REQUEST_FAILED');
    for(let i=0;i<4;i++)await observer.runOnce();assert.equal(activity,1);
    assert.equal(history.stats().events,0);assert.ok(!JSON.stringify(observer.getStatus()).includes('secret'));
  }finally{history.close();}
});

test('seed activity persists only validated chain-local transactions and external aliases never create public-KOL anchors',async()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(start)});
  const row={wallet:a,token:{address:'0x'+'a'.repeat(40)},event_type:'buy',tx_hash:'0x'+'1'.repeat(64),timestamp:start/1000-1,token_amount:'2',cost_usd:'10'};
  const client={cooldownUntil:0,async get(path:string){if(path==='/v1/market/rank')return {rank:[]};
    return {activities:[row,{...row,chain:'robinhood'},{...row,token:{address:'bad'}},{...row,timestamp:start/1000+1}],next:''};}};
  try {
    history.importResearchSeeds(snapshot);const observer=new WalletObserver({history,client,chains:['bsc'],maxRequestsPerCycle:1,now:()=>new Date(start)});
    for(let i=0;i<4;i++)await observer.runOnce();
    assert.equal(history.stats().events,1);assert.equal(history.researchSeedStatus().chains[0].lastResult?.status,'partial');
    const detail=history.getWallet('bsc',a)!;assert.equal(detail.timeline[0].source,'gmgn_research_seed_activity');
    assert.equal(detail.wallet.buyEvents,1);assert.deepEqual(detail.wallet.labels,[]);assert.equal(detail.wallet.name,undefined);
    assert.equal(history.associationTargets('bsc').length,0);assert.equal(history.getWallet('robinhood',a),undefined);
  }finally{history.close();}
});

test('persistent four-round allocation preserves ordinary market research under continuously eligible and failed seed queries',async()=>{
  let now=start;const history=new WalletHistory(':memory:',{now:()=>new Date(now)}),paths:string[]=[];
  const client={cooldownUntil:0,async get(path:string){paths.push(path);if(path==='/v1/market/rank')return {rank:[]};throw new Error('seed unavailable');}};
  const options={history,client,chains:['bsc'] as ('bsc')[],maxRequestsPerCycle:1,now:()=>new Date(now)};
  try {
    history.importResearchSeeds(snapshot);let observer=new WalletObserver(options);const modes:string[]=[];
    for(let i=0;i<12;i++){
      now+=1_800_001;const report=await observer.runOnce();modes.push(report.collectionMode!);
      assert.equal(report.requests,1);
      // Reconstruct the observer between turns; this cannot reset the allocation.
      observer=new WalletObserver(options);
    }
    assert.deepEqual(modes,['market_wallets','market_wallets','market_wallets','external_seed_research',
      'market_wallets','market_wallets','market_wallets','external_seed_research',
      'market_wallets','market_wallets','market_wallets','external_seed_research']);
    assert.equal(paths.filter(p=>p==='/v1/market/rank').length,9);assert.equal(paths.filter(p=>p==='/v1/user/wallet_activity').length,3);
  }finally{history.close();}
});
