import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import bs58 from 'bs58';
import {WalletHistory,WALLET_COORDINATION_INVALIDATION_SQL,type WalletTradeObservation} from '../src/wallet-history.js';
import {WALLET_ASSOCIATION_INVALIDATION_SQL} from '../src/wallet-associations.js';
import type {WalletAnalysis,WalletRecord} from '../src/research/wallet-types.js';
import type {Report} from '../src/types.js';

const base=Date.parse('2026-10-09T00:00:00Z'),iso=(n=0)=>new Date(base+n*1_000).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const token={chain:'bsc' as const,address:address(9000)};
const trade=(patch:Partial<WalletTradeObservation>={}):WalletTradeObservation=>({chain:'bsc',wallet:address(1),tokenAddress:token.address,
  txHash:hash(1),side:'buy',eventAt:iso(1),observedAt:iso(10),source:'gmgn_kol',amount:'10',amountUnit:'vendor_quantity',usd:'20',...patch});
const wallet=(n=1,patch:Partial<WalletRecord>={}):WalletRecord=>({chain:'bsc',address:address(n),sources:['top_holders'],
  vendorLabels:{provider:'gmgn',verification:'vendor_claim',platform:[],token:[]},recognizedLabels:['smart'],
  vendorIdentity:{name:'Synthetic wallet',twitterUsername:'sample',verification:'vendor_claim'},
  attribution:{status:'unknown',verification:'unverified'},holding:{amount:'10',usd:'20',supplyRatio:0.01,currentlyHolding:true},
  cumulative:{scope:'vendor_token_cumulative',recentInflow:false,buyVolumeUsd:'20',sellVolumeUsd:'0',buyCount:1,sellCount:0,
    firstAcquiredAt:iso(1),lastActiveAt:iso(1),exitedAt:null},
  funding:{address:address(500),label:'Unverified origin',verification:'vendor_claim',source:'native_transfer',amount:'1',timestamp:iso(0),
    txHash:hash(50),sharedService:false,conflict:false},developerLinks:['DEVELOPER_DIRECT_FUNDING'],risks:['VENDOR_SUSPICIOUS_WALLET'],
  clusterId:'test',enrichment:{status:'complete',reasons:[],stats:{period:'7d',scope:'entire_wallet',realizedProfitUsd:'50',winRate:0.5,
    totalBuyCostUsd:'100',buyCount:2,sellCount:1},activity:{scope:'token_activity_page',events:[{txHash:hash(n),type:'buy',timestamp:iso(1),amount:'10',usd:'20'}],
    hasMore:true,firstAt:iso(1),lastAt:iso(1),recent:{since:iso(0),until:iso(10),coverage:'partial',buyUsd:'20',sellUsd:'0',netBuyUsd:'20',hasAccumulation:true}}},...patch});
const analysis=(wallets:WalletRecord[]=[wallet()],checkedAt=iso(10)):WalletAnalysis=>({status:'pass',checkedAt,reasons:[],facts:{secret:'RAW_SHOULD_NEVER_PERSIST'},wallets,clusters:[],
  summary:{token,sampleOnly:true,uniqueWalletCount:wallets.length,enrichedWalletCount:wallets.length,currentHolderCount:wallets.length,
    smartCurrentHolderCount:wallets.length,smartFundingClusterCount:1,smartIndependenceProven:false,eligibleSmartWalletCount:0,qualifiedSmartWalletCount:0,
    qualifiedSmartFundingClusterCount:0,recentWindowSeconds:300,recentNetBuyUsd:'20',hasRecentAccumulation:true,sampledHoldingRatio:0.01,
    cumulativeBuyUsd:'20',cumulativeSellUsd:'0',cumulativeCoverageWalletCount:wallets.length,cumulativeIsRecentInflow:false}});
const report=(mode:Report['mode']='live',decision:Report['decision']='WATCH'):Report=>({id:'report-1',mode,decision,buyEligible:false,
  evaluatedAt:iso(10),wallets:analysis(),signal:{token}} as Report);
function fixture() {
  let now=100;const history=new WalletHistory(':memory:',{now:()=>new Date(base+now*1_000)});
  return {history,setNow:(n:number)=>{now=n;}};
}

test('跨feed重复交易只计一次，独立来源及冲突证据保留，无索引记录明确标heuristic',()=>{
  const {history}=fixture();
  try {
    history.recordTrade(trade());history.recordTrade(trade({observedAt:iso(20)}));
    history.recordTrade(trade({source:'gmgn_smartmoney',observedAt:iso(15)}));
    history.recordTrade(trade({source:'gmgn_activity',observedAt:iso(30),amount:'11'}));
    const detail=history.getWallet('bsc',address(1))!;
    assert.equal(history.stats().events,1);assert.equal(history.stats().observations,3);
    assert.equal(detail.wallet.buyEvents,1);assert.equal(detail.timeline[0].evidence.length,3);
    assert.equal(detail.timeline[0].scope,'transaction_wallet_token_side');assert.equal(detail.timeline[0].ambiguous,true);
    assert.equal(detail.timeline[0].amount,'10');assert.equal(detail.timeline[0].observedAt,iso(10));
    assert.equal(detail.coverage.exactRealizedPnl,false);
  } finally {history.close();}
});

test('live WATCH/REJECT同样入库，重复报告跨时间幂等；旧snapshot与本地导入时间分开',()=>{
  const {history,setNow}=fixture();
  try {
    history.captureReport(report('demo'));assert.equal(history.stats().wallets,0);
    history.captureReport(report());const counts=history.stats();
    const detail=history.getWallet('bsc',address(1))!;
    assert.equal(detail.holdings[0].observedAt,iso(100));assert.equal(detail.holdings[0].snapshotAt,iso(10));
    assert.equal(detail.timeline[0].eventAt,iso(1));assert.equal(detail.timeline[0].observedAt,iso(100));
    setNow(200);history.captureReport(report());assert.equal(history.stats().observations,counts.observations);
    history.captureReport({...report('live','REJECT'),id:'report-2'});
    assert.equal(history.stats().observations,counts.observations); // Same original snapshot is not a fresh historical observation.
    assert.deepEqual(detail.holdings[0].risks,['VENDOR_SUSPICIOUS_WALLET']);
    assert.deepEqual(detail.holdings[0].developerLinks,['DEVELOPER_DIRECT_FUNDING']);
  } finally {history.close();}
});

test('拒绝错链/错币或未来analysis，以及未来交易观察和事件时间',()=>{
  const {history}=fixture();
  try {
    history.captureAnalysis({...token,address:address(9001)},analysis(),{source:'gmgn_analysis',observedAt:iso(100)});
    history.captureAnalysis(token,analysis(undefined,iso(101)),{source:'gmgn_analysis',observedAt:iso(100)});
    for(const patch of [{eventAt:iso(101)},{observedAt:iso(101)},{wallet:'bad'},{txHash:'bad'}]) history.recordTrade(trade(patch));
    assert.equal(history.stats().events,0);assert.equal(history.stats().snapshots,0);
    history.recordTrade(trade({eventAt:iso(-86_400),observedAt:iso(100)}));
    assert.equal(history.stats().events,1);assert.equal(history.getWallet('bsc',address(1))?.timeline[0].observedAt,iso(100));
  } finally {history.close();}
});

test('7d全钱包利润只取最新vendor snapshot，不累计；token累计利润单独保存',()=>{
  const {history}=fixture();
  try {
    history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:'100'}],{source:'gmgn_stats',observedAt:iso(30)});
    history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:'80'}],{source:'gmgn_stats',observedAt:iso(40)});
    history.captureLeaders('bsc',[{address:address(1),period:'7d',realizedProfitUsd:'900'}],{source:'gmgn_stats',observedAt:iso(20)});
    history.captureTokenTraders(token,[{address:address(1),rank:1,profitUsd:'5000',realizedProfitUsd:'4000',unrealizedProfitUsd:'1000'}],{source:'gmgn_top_traders',observedAt:iso(50)});
    const detail=history.getWallet('bsc',address(1))!;
    assert.equal(detail.wallet.profit?.realizedProfitUsd,'80');assert.equal(detail.vendorStats.length,3);
    assert.equal(detail.tokenTraderSnapshots[0].scope,'token_cumulative');assert.equal(detail.tokenTraderSnapshots[0].profitUsd,'5000');
    assert.equal(detail.wallet.profit?.verification,'vendor_claim');assert.equal(detail.wallet.profit?.scope,'entire_wallet');
  } finally {history.close();}
});

test('涨幅以首次已观察买入之后的实际价格为基线，不用未知单位或倒序价伪造历史高点',()=>{
  const {history,setNow}=fixture();
  try {
    history.recordTrade(trade({priceUsd:'0.01',amountUnit:'atomic'}));
    history.recordPrice(token,0.001,iso(9),'gmgn_info');history.recordPrice(token,0.001,iso(10),'gmgn_info');
    assert.equal(history.getWallet('bsc',address(1))?.wallet.gain,undefined);
    history.recordPrice(token,2,iso(20),'gmgn_info');history.recordPrice(token,6,iso(30),'gmgn_info');
    history.recordPrice(token,60,iso(25),'gmgn_info');history.recordPrice(token,3,iso(40),'gmgn_info');
    history.recordPrice(token,-1,iso(50),'gmgn_info');history.recordPrice(token,100,iso(101),'gmgn_info');
    const gain=history.getWallet('bsc',address(1))!.wallet.gain!;
    assert.equal(gain.baselinePriceUsd,2);assert.equal(gain.maxGainPct,200);assert.equal(gain.peakPriceUsd,6);
    assert.equal(gain.baselineAt,iso(20));assert.equal(gain.kind,'first_post_observed_buy_quote');
    setNow(40*86_400);history.recordPrice(token,8,iso(40*86_400),'gmgn_info');
    assert.equal(history.getWallet('bsc',address(1))!.wallet.gain!.maxGainPct,300);
    assert.equal(history.stats().events,1); // No 30-day research pruning.
  } finally {history.close();}
});

test('共同资金来源排除公共服务/冲突，协同行为至少双方各两笔独立交易且仅是线索',()=>{
  const {history}=fixture();
  try {
    history.captureAnalysis(token,analysis([wallet(1),wallet(2)]),{source:'gmgn_analysis',observedAt:iso(100)});
    history.refreshCoordination(20);assert.equal(history.getWallet('bsc',address(1))!.wallet.coordination.sharedFundingPeers,1);
    assert.equal(history.getWallet('bsc',address(1))!.wallet.coordination.synchronizedPeers,0);
    history.recordTrade(trade({txHash:hash(11),eventAt:iso(50),observedAt:iso(100)}));
    history.recordTrade(trade({wallet:address(2),txHash:hash(12),eventAt:iso(51),observedAt:iso(100)}));
    history.refreshCoordination(20);
    const detail=history.getWallet('bsc',address(1))!;
    assert.equal(detail.wallet.coordination.synchronizedPeers,1);assert.equal(detail.wallet.coordination.ownership,'unknown');
    assert.equal(detail.coordinationEvidence.synchronized[0].distinctTransactions,2);
    const publicWallet=wallet(3);publicWallet.funding.sharedService=true;
    history.captureAnalysis(token,analysis([publicWallet]),{source:'gmgn_analysis',observedAt:iso(100)});
    history.refreshCoordination(20);assert.equal(history.getWallet('bsc',address(1))!.wallet.coordination.sharedFundingPeers,0);
  } finally {history.close();}
});

test('批量报告对重复资金来源只做一次关联失效且完整保存每个钱包证据',()=>{
  const {history,setNow}=fixture(),db=(history as unknown as {db:DatabaseSync}).db;
  const queued=()=>Object.fromEntries(db.prepare('SELECT kind,count(*) AS n FROM wh_association_invalidations GROUP BY kind').all()
    .map(row=>[String(row.kind),Number(row.n)]));
  try {
    const wallets=Array.from({length:200},(_,index)=>{
      const value=wallet(index+1,{enrichment:{status:'complete',reasons:[]}});
      value.funding={...value.funding,sharedService:true};return value;
    });
    history.captureAnalysis(token,analysis(wallets),{source:'gmgn_analysis',observedAt:iso(100)});
    assert.equal(history.stats().wallets,200);assert.equal(history.stats().fundingLinks,200);
    assert.equal(history.associationInvalidationStatus().pending,202);
    assert.deepEqual(queued(),{funding_address:1,funding_wallet:200,public_service:1});
    // A later vendor snapshot creates new evidence rows, but a funder already
    // known as a shared service must not invalidate all historical recipients
    // again on the latency-sensitive report path.
    setNow(200);history.captureAnalysis(token,analysis(wallets,iso(200)),{source:'gmgn_analysis',observedAt:iso(200)});
    assert.equal(history.stats().fundingLinks,400);
    assert.equal(history.associationInvalidationStatus().pending,202,'the durable queue deduplicates repeated vendor refreshes');
    assert.deepEqual(queued(),{funding_address:1,funding_wallet:200,public_service:1});
    for(let batch=0;batch<32&&history.associationInvalidationStatus().pending;batch++)history.flushAssociationInvalidations(64);
    assert.equal(history.associationInvalidationStatus().pending,0);
    history.refreshCoordination(20);
    assert.equal(history.getWallet('bsc',address(1))!.wallet.coordination.sharedFundingPeers,0);
  } finally {history.close();}
});

test('200钱包报告在密集关联表上保持有界，不按钱包重复扫描全表',()=>{
  const {history}=fixture(),db=(history as unknown as {db:DatabaseSync}).db;
  try {
    db.exec('BEGIN');
    const insert=db.prepare(`INSERT INTO wh_assoc_relations(chain,leader,candidate,first_at,updated_at,token_count,forward_count,funding_count,dirty,data,funding_data)
      VALUES ('bsc',?,?,?,?,1,0,0,0,'{}','[]')`);
    for(let index=0;index<5_000;index++) insert.run(address(index%200+1),address(20_000+index),iso(1),iso(1));
    db.exec('COMMIT');
    const wallets=Array.from({length:200},(_,index)=>{
      const value=wallet(index+1,{enrichment:{status:'complete',reasons:[]}});
      value.funding={...value.funding,sharedService:true};return value;
    });
    const started=performance.now();
    history.captureAnalysis(token,analysis(wallets),{source:'gmgn_analysis',observedAt:iso(100)});
    const elapsed=performance.now()-started;
    assert.ok(elapsed<300,`main-loop batch capture took ${elapsed.toFixed(1)}ms`);
    assert.equal(history.associationInvalidationStatus().pending,202);
    const batches:number[]=[];
    for(let batch=0;batch<200&&history.associationInvalidationStatus().pending;batch++){
      const began=performance.now(),result=history.flushAssociationInvalidations(64);batches.push(performance.now()-began);
      assert.ok(result.touched<=64,'one transaction exceeded its target-row budget');
    }
    assert.equal(history.associationInvalidationStatus().pending,0);
    assert.ok(Math.max(...batches)<50,`slowest invalidation transaction took ${Math.max(...batches).toFixed(1)}ms`);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM wh_assoc_relations WHERE dirty=1').get()!.n),5_000);
  } finally {history.close();}
});

test('批量关联失效由json_each驱动，并按完整链和地址键精确查索引',()=>{
  const {history}=fixture(),db=(history as unknown as {db:DatabaseSync}).db;
  const values=JSON.stringify([address(1),address(2)]),targetChain='bsc';
  const explain=(sql:string,args:SQLInputValue[])=>db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row=>String(row.detail));
  const before=(plan:string[],first:RegExp,second:RegExp)=>{
    const left=plan.findIndex(detail=>first.test(detail)),right=plan.findIndex(detail=>second.test(detail));
    assert.ok(left>=0,`missing ${first} in\n${plan.join('\n')}`);
    assert.ok(right>left,`${second} must follow ${first} in\n${plan.join('\n')}`);
  };
  try {
    const fundingAnchors=explain(WALLET_ASSOCIATION_INVALIDATION_SQL.fundingAnchors,[values,targetChain,values,targetChain]);
    before(fundingAnchors,/SCAN w VIRTUAL TABLE/,/SEARCH a .*\(chain=\? AND leader=\?\)/);
    assert.ok(fundingAnchors.filter(detail=>/SCAN w VIRTUAL TABLE/.test(detail)).length===2);
    assert.ok(fundingAnchors.some(detail=>/SEARCH e .*\(chain=\? AND candidate=\? AND active=\?\)/.test(detail)));
    assert.ok(fundingAnchors.some(detail=>/SEARCH a .*\(chain=\? AND leader=\? AND token_address=\?\)/.test(detail)));

    const fundingRelations=explain(WALLET_ASSOCIATION_INVALIDATION_SQL.fundingRelations,[values,targetChain,values,targetChain]);
    before(fundingRelations,/SCAN w VIRTUAL TABLE/,/SEARCH r .*\(chain=\? AND leader=\?\)/);
    assert.ok(fundingRelations.some(detail=>/SEARCH r .*\(chain=\? AND candidate=\?\)/.test(detail)));

    for(const sql of [WALLET_ASSOCIATION_INVALIDATION_SQL.publicRelations,WALLET_ASSOCIATION_INVALIDATION_SQL.publicAnchors]) {
      const publicPlan=explain(sql,[values,targetChain,targetChain,targetChain]);
      assert.ok(publicPlan.some(detail=>detail==='MATERIALIZE recipients'));
      before(publicPlan,/SCAN s VIRTUAL TABLE/,/SEARCH f .*\(chain=\? AND funding_address=\?\)/);
      assert.ok(publicPlan.every(detail=>!/^SEARCH f .*\(chain=\?\)$/.test(detail)));
    }

    const coordination=explain(WALLET_COORDINATION_INVALIDATION_SQL,[values,targetChain]);
    before(coordination,/SCAN a VIRTUAL TABLE/,/SEARCH f .*\(chain=\? AND funding_address=\?\)/);
    before(coordination,/SEARCH f .*\(chain=\? AND funding_address=\?\)/,
      /SEARCH m .*\(chain=\? AND address=\?\)/);
  } finally {history.close();}
});

test('coordination funding checks use covering scalar indexes and dirty queue selection does not sort all wallets',()=>{
  const {history}=fixture(),db=(history as unknown as {db:DatabaseSync}).db;
  const original=db.prepare.bind(db),captured:string[]=[];
  try {
    history.captureAnalysis(token,analysis([wallet(1),wallet(2)]),{source:'gmgn_analysis',observedAt:iso(100)});
    db.prepare=((sql:string)=>{if(sql.includes('FROM wh_funding a')||sql.includes('INDEXED BY wh_metrics_coord_queue'))captured.push(sql);return original(sql);}) as typeof db.prepare;
    history.refreshCoordination(1);db.prepare=original;
    const funding=captured.find(sql=>sql.includes('FROM wh_funding a'))!;
    const plan=db.prepare('EXPLAIN QUERY PLAN '+funding).all('bsc',address(1)).map(row=>String(row.detail));
    assert.equal(plan.filter(detail=>/^SEARCH [absx] /.test(detail)).length,5);
    assert.ok(plan.filter(detail=>/^SEARCH [absx] /.test(detail)).every(detail=>detail.includes('USING COVERING INDEX wh_funding_coord_')));
    const queue=captured.find(sql=>sql.includes('INDEXED BY wh_metrics_coord_queue'))!;
    const queuePlan=db.prepare('EXPLAIN QUERY PLAN '+queue).all(1).map(row=>String(row.detail));
    assert.ok(queuePlan.some(detail=>detail.includes('USING COVERING INDEX wh_metrics_coord_queue')));
    assert.ok(queuePlan.every(detail=>!detail.includes('TEMP B-TREE')));
    assert.equal(history.getWallet('bsc',address(1))!.wallet.coordination.sharedFundingPeers,1);
  }finally{db.prepare=original;history.close();}
});

test('关联失效队列跨重启保留，派生更新失败时原子回滚并可重试',()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-invalidation-')),path=join(directory,'history.sqlite');
  let history=new WalletHistory(path,{now:()=>new Date(base+100_000)});
  try {
    history.captureFunding(token,address(1),{address:address(500),timestamp:iso(50),txHash:hash(500)},
      {source:'gmgn_funding',observedAt:iso(80),snapshotAt:iso(70)});
    assert.equal(history.associationInvalidationStatus().pending,2);
    history.close();history=new WalletHistory(path,{now:()=>new Date(base+100_000)});
    assert.equal(history.associationInvalidationStatus().pending,2);
    const db=(history as unknown as {db:DatabaseSync}).db;
    db.exec(`CREATE TRIGGER reject_wallet_invalidation BEFORE UPDATE OF coordination_dirty ON wh_metrics
      BEGIN SELECT RAISE(ABORT,'test failure'); END`);
    assert.throws(()=>history.flushAssociationInvalidations(64));
    assert.equal(history.associationInvalidationStatus().pending,2,'failed derived update keeps every queue row');
    db.exec('DROP TRIGGER reject_wallet_invalidation');
    const result=history.flushAssociationInvalidations(64);
    assert.equal(result.completed,2);assert.equal(result.remaining,false);
    assert.equal(history.associationInvalidationStatus().pending,0);
  } finally {history.close();rmSync(directory,{recursive:true,force:true});}
});

test('旧关联失效队列启动时补齐分片进度列且不丢待办',()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-invalidation-migrate-')),path=join(directory,'history.sqlite');
  const legacy=new DatabaseSync(path);
  legacy.exec(`CREATE TABLE wh_association_invalidations(
    kind TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,enqueued_at TEXT NOT NULL,
    PRIMARY KEY(kind,chain,address));`);
  legacy.prepare('INSERT INTO wh_association_invalidations VALUES (?,?,?,?)')
    .run('funding_wallet','bsc',address(1),iso(1));legacy.close();
  const history=new WalletHistory(path,{now:()=>new Date(base+100_000)});
  try {
    const columns=new Set(((history as unknown as {db:DatabaseSync}).db)
      .prepare('PRAGMA table_info(wh_association_invalidations)').all().map(row=>String(row.name)));
    assert.equal(columns.has('stage'),true);assert.equal(columns.has('cursor'),true);
    assert.equal(history.associationInvalidationStatus().pending,1);
    assert.equal(history.flushAssociationInvalidations().remaining,false);
    assert.equal(history.associationInvalidationStatus().pending,0);
  } finally {history.close();rmSync(directory,{recursive:true,force:true});}
});

test('stream wallet targets preserve relationship priority and recent fallback through covering ordered indexes',()=>{
  const {history}=fixture(),db=(history as unknown as {db:DatabaseSync}).db;
  const original=db.prepare.bind(db),captured:string[]=[];
  try {
    history.captureAnalysis(token,analysis([wallet(1),wallet(2)]),{source:'gmgn_analysis',observedAt:iso(100)});
    db.prepare=((sql:string)=>{if(sql.includes('INDEXED BY wh_stream_'))captured.push(sql);return original(sql);}) as typeof db.prepare;
    assert.deepEqual(new Set(history.streamWalletTargets('bsc',2)),new Set([address(1),address(2)]));db.prepare=original;
    assert.equal(captured.length,2);
    for(const sql of captured){const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all('bsc',2).map(row=>String(row.detail));
      assert.ok(plan.some(detail=>detail.includes('USING COVERING INDEX wh_stream_')));
      assert.ok(plan.every(detail=>!detail.includes('TEMP B-TREE')));
    }
    db.prepare(`INSERT INTO wh_assoc_relations(chain,leader,candidate,first_at,updated_at,token_count,forward_count,funding_count,dirty,data,funding_data)
      VALUES('bsc',?,?,?, ?,5,1,0,0,'{}','[]')`).run(address(3),address(4),iso(1),iso(2));
    assert.deepEqual(history.streamWalletTargets('bsc',2),[address(4),address(3)]);
  }finally{db.prepare=original;history.close();}
});

test('晚导入旧正常资金快照不能覆盖更晚时点的冲突证据',()=>{
  const {history}=fixture();
  try {
    const conflicted=wallet(1);conflicted.funding.conflict=true;
    history.captureAnalysis(token,analysis([conflicted],iso(50)),{source:'gmgn_analysis',observedAt:iso(60)});
    history.captureAnalysis(token,analysis([wallet(2)],iso(50)),{source:'gmgn_analysis',observedAt:iso(60)});
    history.refreshCoordination(20);assert.equal(history.getWallet('bsc',address(1))!.wallet.coordination.sharedFundingPeers,0);
    history.captureAnalysis(token,analysis([wallet(1)],iso(30)),{source:'bootstrap_import',observedAt:iso(90)});
    history.refreshCoordination(20);
    const detail=history.getWallet('bsc',address(1))!;
    assert.equal(detail.fundingEdges.length,2);assert.equal(detail.wallet.coordination.sharedFundingPeers,0);
    assert.equal(detail.coordinationEvidence.sharedFunding.length,0);
  } finally {history.close();}
});

test('协同缓存区分pending/current/stale，详情即时计算且保持数据库只读',()=>{
  const {history,setNow}=fixture();
  try {
    history.captureAnalysis(token,analysis([wallet(1),wallet(2)]),{source:'gmgn_analysis',observedAt:iso(100)});
    const cached=()=>history.listWallets({search:address(1)}).items[0].coordination;
    const db=(history as unknown as {db:DatabaseSync}).db;
    const changes=()=>Number(db.prepare('SELECT total_changes() AS n').get()!.n);
    assert.equal(cached().status,'pending');assert.equal(cached().checkedAt,undefined);
    assert.equal(history.stats().coordinationPending,2);
    const before=changes(),detail=history.getWallet('bsc',address(1))!;
    assert.equal(detail.wallet.coordination.status,'current');assert.equal(detail.wallet.coordination.checkedAt,iso(100));
    assert.equal(detail.wallet.coordination.score,10);assert.equal(detail.wallet.coordination.sharedFundingPeers,1);
    assert.equal(changes(),before);assert.equal(cached().status,'pending');assert.equal(history.stats().coordinationPending,2);
    history.refreshCoordination(20);
    assert.equal(cached().status,'current');assert.equal(cached().checkedAt,iso(100));assert.equal(history.stats().coordinationPending,0);
    setNow(110);history.recordTrade(trade({txHash:hash(99),eventAt:iso(101),observedAt:iso(110)}));
    assert.equal(cached().status,'stale');assert.equal(cached().checkedAt,iso(100));assert.equal(history.stats().coordinationPending,2);
    const beforeSecondRead=changes();
    assert.equal(history.getWallet('bsc',address(1))!.wallet.coordination.checkedAt,iso(110));
    assert.equal(changes(),beforeSecondRead);assert.equal(cached().status,'stale');assert.equal(history.stats().coordinationPending,2);
  } finally {history.close();}
});

test('持久化完整身份、风险证据和sample metadata，重启不重计事件且不保存raw payload',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-history-')),path=join(dir,'research.sqlite');
  let history=new WalletHistory(path,{now:()=>new Date(base+100_000)});
  try {
    history.captureReport(report());history.recordCollection({source:'gmgn_observer',chain:'bsc',startedAt:iso(90),completedAt:iso(100),
      status:'partial',requests:3,accepted:1,coverage:'one_page_sample',hasMore:true,reason:'GMGN_RATE_LIMITED'});
    const stats=history.stats();history.close();history=new WalletHistory(path,{now:()=>new Date(base+100_000)});
    history.captureReport(report());assert.equal(history.stats().events,stats.events);assert.equal(history.stats().observations,stats.observations);
    assert.equal(history.stats().collections,1);assert.equal(history.getWallet('bsc',address(1))!.wallet.address,address(1));
    const db=new DatabaseSync(path,{readOnly:true});const data=db.prepare('SELECT data FROM wh_observations').all().map(row=>String(row.data)).join('');db.close();
    assert.equal(data.includes('RAW_SHOULD_NEVER_PERSIST'),false);assert.equal(statSync(path).mode&0o777,0o600);
  } finally {history.close();rmSync(dir,{recursive:true,force:true});}
});

test('旧库重启补齐统计窄索引，计数与筛选走覆盖索引且保留原记录',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-stats-index-')),path=join(dir,'research.sqlite');
  let history=new WalletHistory(path,{now:()=>new Date(base+100_000)});
  try {
    history.captureReport(report());
    history.recordCollection({source:'gmgn_observer',chain:'bsc',startedAt:iso(90),completedAt:iso(100),
      status:'partial',requests:3,accepted:1,coverage:'one_page_sample',hasMore:true,reason:'GMGN_RATE_LIMITED'});
    const {bytes:beforeBytes,...before}=history.stats();
    history.close();
    const legacy=new DatabaseSync(path);
    legacy.exec('DROP INDEX wh_events_side; DROP INDEX wh_observations_kind;');legacy.close();
    history=new WalletHistory(path,{now:()=>new Date(base+100_000)});
    const {bytes:afterBytes,...after}=history.stats();
    assert.deepEqual(after,before);
    const db=(history as unknown as {db:DatabaseSync}).db;
    for(const [sql,index] of [
      ['SELECT count(*) AS n FROM wh_events','wh_events_side'],
      ['SELECT count(*) AS n FROM wh_observations','wh_observations_kind'],
      ["SELECT count(*) AS n FROM wh_observations WHERE kind IN ('holding','stats','token_trader','token_rank')",'wh_observations_kind'],
      ["SELECT count(*) AS n FROM wh_observations WHERE kind='collection'",'wh_observations_kind']
    ]) {
      const plan=db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row=>String(row.detail)).join('\n');
      assert.match(plan,new RegExp(`USING COVERING INDEX ${index}\\b`));
    }
  } finally {history.close();rmSync(dir,{recursive:true,force:true});}
});

test('统计窄索引不能抢占逐事件证据、关联冲突及逐币买入聚合查询',()=>{
  const {history}=fixture();
  try {
    history.recordTrade(trade({eventAt:iso(10),observedAt:iso(15)}));
    history.recordTrade(trade({wallet:address(2),txHash:hash(2),eventAt:iso(30),observedAt:iso(35),source:'gmgn_kol_feed'}));
    const db=(history as unknown as {db:DatabaseSync}).db;
    const prepare=db.prepare.bind(db),queries:{sql:string;plan:string}[]=[];
    // Inspect statements actually issued by the history and association paths,
    // so removing their event index constraint is detected by this regression.
    db.prepare=(sql:string)=>{
      if(sql.includes('wh_observations')&&/\bevent_id\s*=\s*(?:\?|e\.id)/.test(sql)||sql.startsWith('SELECT wallet,MIN(observed_at)')) {
        const plan=prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g)||[]).length).fill(null))
          .map(row=>String(row.detail)).join('\n');
        queries.push({sql,plan});
      }
      return prepare(sql);
    };
    try {
      history.refreshAssociations(1);
      history.getWallet('bsc',address(1));
      history.recordPrice(token,1,iso(50),'gmgn_token_info');
    } finally {db.prepare=prepare;}
    assert.ok(queries.some(({sql})=>sql.includes('event_id=?')),'direct event evidence lookup was exercised');
    assert.ok(queries.some(({sql})=>sql.includes('event_id=e.id')),'correlated timestamp conflict lookup was exercised');
    for(const {plan} of queries.filter(({sql})=>sql.includes('wh_observations'))) {
      assert.match(plan,/USING INDEX wh_observations_event \(event_id=\?\)/);
      assert.doesNotMatch(plan,/USING INDEX wh_observations_kind/);
    }
    const buyerQuery=queries.find(({sql})=>sql.startsWith('SELECT wallet,MIN(observed_at)'));
    assert.ok(buyerQuery,'actual per-token price attribution aggregation was exercised');
    assert.match(buyerQuery.plan,/USING INDEX wh_events_token \(chain=\? AND token_address=\? AND side=\?\)/);
    assert.doesNotMatch(buyerQuery.plan,/USING INDEX wh_events_wallet/);
  } finally {history.close();}
});

test('容量达到后停止追加并保留旧研究，重启仍报错，增大预算才恢复',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-budget-')),path=join(dir,'research.sqlite');
  let history=new WalletHistory(path,{maxBytes:1_000_000,now:()=>new Date(base+100_000)});
  try {
    history.recordTrade(trade());assert.equal(history.stats().events,1);
    history.recordTrades(Array.from({length:2000},(_,n)=>trade({wallet:address(n+10),txHash:hash(n+100),amount:'9'.repeat(90),usd:'9'.repeat(90)})));
    assert.equal(history.stats().error,'WALLET_HISTORY_CAPACITY_REACHED');assert.equal(history.stats().events,1);
    history.recordTrade(trade({txHash:hash(2)}));assert.equal(history.stats().events,1);
    history.close();history=new WalletHistory(path,{maxBytes:1_000_000,now:()=>new Date(base+100_000)});
    assert.equal(history.stats().error,'WALLET_HISTORY_CAPACITY_REACHED');assert.equal(history.stats().events,1);
    history.close();history=new WalletHistory(path,{maxBytes:8_000_000,now:()=>new Date(base+100_000)});
    assert.equal(history.stats().error,undefined);history.recordTrade(trade({txHash:hash(2)}));assert.equal(history.stats().events,2);
  } finally {history.close();rmSync(dir,{recursive:true,force:true});}
});

test('至少1000钱包排序先SQL分页，未知利润/涨幅排最后且列表不触发图自连接',()=>{
  const {history}=fixture();
  try {
    for(let start=1;start<=1000;start+=200) history.captureLeaders('bsc',Array.from({length:200},(_,i)=>({
      address:address(start+i),period:'7d' as const,realizedProfitUsd:String(start+i)})),{source:'gmgn_stats',observedAt:iso(20)});
    history.recordTrade(trade({wallet:address(1001),observedAt:iso(100)}));
    // A full-graph query here would throw; listing must use the materialized cache.
    const internals=history as unknown as {coordination:()=>never};internals.coordination=()=>{throw new Error('UNBOUNDED_GRAPH_QUERY');};
    let result=history.listWallets({sort:'profit',limit:10,offset:10});
    assert.equal(result.total,1001);assert.equal(result.items.length,10);assert.equal(result.items[0].address,address(990));
    assert.equal(history.listWallets({sort:'profit',limit:1}).items[0].address,address(1000));
    history.recordPrice(token,1,iso(101),'gmgn_info'); // future is ignored
    result=history.listWallets({sort:'profit',offset:1000,limit:10});assert.equal(result.items[0].address,address(1001));
    assert.equal(history.listWallets({search:"%' OR 1=1 --"}).total,0);
  } finally {history.close();}
});

test('钱包列表四种排序使用覆盖分页索引，链过滤、深分页和三字符搜索保持精确',()=>{
  const {history}=fixture();
  try {
    history.captureLeaders('bsc',[
      {address:address(1),period:'7d',realizedProfitUsd:'50',name:'Alpha Smart'},
      {address:address(2),period:'7d',realizedProfitUsd:'50',name:'Beta'},
      {address:address(3),period:'7d',realizedProfitUsd:null,name:'Gamma Smart'},
    ],{source:'gmgn_stats',observedAt:iso(20)});
    history.captureLeaders('solana',[],{source:'gmgn_stats',observedAt:iso(20)}); // Valid empty cross-chain sample.
    history.recordTrade(trade({wallet:address(2),txHash:hash(2),observedAt:iso(30)}));
    history.recordTrade(trade({wallet:address(4),txHash:hash(4),observedAt:iso(40)}));
    const db=(history as unknown as {db:DatabaseSync}).db;
    const gain=(value:number)=>JSON.stringify({tokenAddress:token.address,baselineAt:iso(1),baselinePriceUsd:1,
      peakAt:iso(2),peakPriceUsd:1+value/100,maxGainPct:value,latestAt:iso(2),latestPriceUsd:1,source:'test',
      kind:'first_post_observed_buy_quote'});
    db.prepare('UPDATE wh_metrics SET gain_pct=?,gain_data=?,coordination_score=? WHERE chain=? AND address=?').run(90,gain(90),40,'bsc',address(1));
    db.prepare('UPDATE wh_metrics SET gain_pct=?,gain_data=?,coordination_score=? WHERE chain=? AND address=?').run(90,gain(90),40,'bsc',address(2));
    db.prepare('UPDATE wh_metrics SET coordination_score=? WHERE chain=? AND address=?').run(100,'bsc',address(4));

    assert.deepEqual(history.listWallets({sort:'profit'}).items.map(item=>item.address),
      [address(2),address(1),address(4),address(3)]);
    assert.deepEqual(history.listWallets({sort:'gain'}).items.map(item=>item.address),
      [address(2),address(1),address(4),address(3)]);
    assert.deepEqual(history.listWallets({sort:'coordination',limit:2}).items.map(item=>item.address),[address(4),address(2)]);
    assert.equal(history.listWallets({sort:'recent',offset:1,limit:2}).items[0].address,address(2));
    assert.deepEqual(history.listWallets({search:'smart'}).items.map(item=>item.address),[address(1),address(3)]);
    assert.equal(history.listWallets({chain:'bsc',search:'alpha smart'}).total,1);
    assert.equal(history.listWallets({chain:'solana',search:'alpha smart'}).total,0);
    assert.equal(history.listWallets({search:'ma'}).total,2); // Short literals retain the original instr semantics.

    const prepare=db.prepare.bind(db),plans:{sql:string;plan:string}[]=[];
    db.prepare=(sql:string)=>{
      if(sql.startsWith('WITH page AS MATERIALIZED'))plans.push({sql,plan:prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array((sql.match(/\?/g)||[]).length).fill(null)).map(row=>String(row.detail)).join('\n')});
      return prepare(sql);
    };
    try {
      for(const sort of ['profit','gain','coordination','recent'] as const) {
        history.listWallets({sort,limit:1});history.listWallets({sort,chain:'bsc',limit:1});
      }
    } finally {db.prepare=prepare;}
    for(const name of ['profit','gain','coordination']) {
      assert.ok(plans.some(item=>item.plan.includes(`COVERING INDEX wh_metrics_${name}_page`)),`${name} global index`);
      assert.equal(plans.filter(item=>item.plan.includes(`COVERING INDEX wh_metrics_${name}_page`)).length,2,
        `${name} global and chain-filtered pages share the ordered covering index`);
    }
    assert.ok(plans.some(item=>item.plan.includes('COVERING INDEX wh_wallets_recent_page')));
    assert.ok(plans.some(item=>item.plan.includes('COVERING INDEX wh_stream_recent_wallets')));
    const ftsPlan=db.prepare(`EXPLAIN QUERY PLAN SELECT count(*) FROM wh_wallet_search s
      CROSS JOIN wh_wallets w ON w.rowid=s.rowid WHERE wh_wallet_search MATCH ?
      AND (instr(lower(w.address),?)>0 OR instr(lower(w.profile),?)>0) AND w.chain=?`)
      .all('"missing smart"','missing smart','missing smart','bsc').map(row=>String(row.detail)).join('\n');
    assert.match(ftsPlan,/SCAN s VIRTUAL TABLE/);assert.match(ftsPlan,/SEARCH w USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    assert.doesNotMatch(ftsPlan,/SEARCH w USING INDEX .*\(chain=\?\)/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM wh_metrics m JOIN wh_wallets w USING(chain,address) WHERE m.last_at=w.last_at').get()!.n,4);
  } finally {history.close();}
});

test('旧钱包库启动时原子补齐列表时间、排序索引和搜索索引',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-list-migrate-')),path=join(dir,'research.sqlite');
  const legacy=new DatabaseSync(path);
  legacy.exec(`CREATE TABLE wh_wallets(chain TEXT,address TEXT,first_at TEXT,last_at TEXT,profile TEXT NOT NULL,PRIMARY KEY(chain,address));
    CREATE TABLE wh_metrics(chain TEXT,address TEXT,event_count INTEGER DEFAULT 0,buy_count INTEGER DEFAULT 0,sell_count INTEGER DEFAULT 0,
      token_count INTEGER DEFAULT 0,profit_usd REAL,profit_at TEXT,profit_observed_at TEXT,profit_data TEXT,gain_pct REAL,gain_data TEXT,
      coordination_score INTEGER DEFAULT 0,coordination_data TEXT,coordination_checked_at TEXT,coordination_dirty INTEGER DEFAULT 1,PRIMARY KEY(chain,address));
    INSERT INTO wh_wallets VALUES ('bsc','${address(1)}','${iso(1)}','${iso(20)}','{"labels":[],"name":"Legacy Smart"}');
    INSERT INTO wh_metrics(chain,address,profit_usd) VALUES ('bsc','${address(1)}',123);`);
  legacy.close();
  const history=new WalletHistory(path,{now:()=>new Date(base+100_000)});
  try {
    const db=(history as unknown as {db:DatabaseSync}).db;
    assert.equal(db.prepare('SELECT last_at FROM wh_metrics WHERE chain=? AND address=?').get('bsc',address(1))!.last_at,iso(20));
    assert.equal(history.listWallets({sort:'profit'}).items[0].address,address(1));
    assert.equal(history.listWallets({search:'legacy smart'}).total,1);
    const indexes=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row=>String(row.name)));
    assert.ok(indexes.has('wh_metrics_profit_page'));assert.ok(indexes.has('wh_metrics_coordination_page'));
    assert.equal(db.prepare("SELECT value FROM wh_meta WHERE key='wallet_search_schema_v1'").get()!.value,'1');
  } finally {history.close();rmSync(dir,{recursive:true,force:true});}
});

test('同链token轮询公平且链过滤不被200个BSC目标阻塞，Solana保持大小写',()=>{
  const {history}=fixture();
  try {
    history.captureTokenRanks('bsc',Array.from({length:200},(_,i)=>({address:address(10000+i),rank:i+1,interval:'1h' as const,
      changeMetric:'100',changeUnit:'vendor_unspecified' as const})),{source:'gmgn_rank',observedAt:iso(20)});
    const sol=bs58.encode(new Uint8Array(32).fill(1)),other=sol.replace('J','j');
    const solHash=bs58.encode(new Uint8Array(64).fill(2));
    history.recordTrades([trade({chain:'solana',wallet:sol,tokenAddress:other,txHash:solHash}),
      trade({chain:'solana',wallet:other,tokenAddress:sol,txHash:solHash})]);
    assert.equal(history.watchTargets(200,new Date(base+100_000),'solana').length,2);
    const first=history.watchTargets(1,undefined,'solana')[0];history.markTargetChecked(first,iso(100));
    assert.notEqual(history.watchTargets(1,undefined,'solana')[0].address,first.address);
    assert.equal(history.listWallets({chain:'solana'}).total,2);
    assert.ok(history.getWallet('solana',sol));assert.ok(history.getWallet('solana',other));
  } finally {history.close();}
});
