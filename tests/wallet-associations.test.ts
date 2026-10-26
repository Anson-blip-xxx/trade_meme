import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {WalletHistory,type WalletTradeObservation} from '../src/wallet-history.js';
import {WALLET_ASSOCIATION_INVALIDATION_SQL} from '../src/wallet-associations.js';

const base=Date.parse('2026-10-09T00:00:00Z'),iso=(n:number)=>new Date(base+n*1000).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const leader=address(1),candidate=address(2),token=address(100),chain='bsc' as const;
const trade=(patch:Partial<WalletTradeObservation>={}):WalletTradeObservation=>({chain,wallet:candidate,tokenAddress:token,txHash:hash(1),side:'buy',
  eventAt:iso(20),observedAt:iso(30),source:'gmgn_smartmoney_feed',...patch});
function fixture() {let now=100;const history=new WalletHistory(':memory:',{now:()=>new Date(base+now*1000)});return {history,setNow:(v:number)=>{now=v;}};}
function pair(history:WalletHistory,patch:{token?:string;candidateAt?:number;candidateObserved?:number;leaderAt?:number;leaderObserved?:number;n?:number}={}) {
  const n=patch.n??1;
  history.recordTrade(trade({tokenAddress:patch.token??token,eventAt:iso(patch.candidateAt??20),observedAt:iso(patch.candidateObserved??30),txHash:hash(n)}));
  history.recordTrade(trade({wallet:leader,tokenAddress:patch.token??token,eventAt:iso(patch.leaderAt??60),observedAt:iso(patch.leaderObserved??65),source:'gmgn_kol_feed',txHash:hash(n+1000)}));
}
function funding(history:WalletHistory,wallet:string,funder:string,patch:{sharedService?:boolean;conflict?:boolean;observedAt?:number;snapshotAt?:number}={}) {
  history.captureFunding({chain,address:token},wallet,{address:funder,sharedService:patch.sharedService,conflict:patch.conflict,timestamp:iso(0),txHash:hash(500)},
    {source:'gmgn_funding',observedAt:iso(patch.observedAt??80),snapshotAt:iso(patch.snapshotAt??70)});
}

test('existing histories gain the token invalidation covering index without changing evidence',()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-association-index-')),file=join(directory,'history.sqlite');
  let history:WalletHistory|undefined;
  try {
    history=new WalletHistory(file,{now:()=>new Date(base+100000)});
    pair(history);history.refreshAssociations();
    const original=history.getAssociation(chain,leader,candidate)!;
    history.close();history=undefined;
    const legacy=new DatabaseSync(file);
    legacy.exec('DROP INDEX wh_assoc_episode_token');legacy.close();
    history=new WalletHistory(file,{now:()=>new Date(base+100000)});
    assert.deepEqual(history.getAssociation(chain,leader,candidate),original);
    const reader=new DatabaseSync(file,{readOnly:true});
    try {
      assert.deepEqual(reader.prepare('PRAGMA index_info(wh_assoc_episode_token)').all().map(row=>row.name),
        ['chain','token_address','active','leader','candidate']);
      assert.deepEqual(reader.prepare('PRAGMA index_info(wh_assoc_anchor_recent)').all().map(row=>row.name),
        ['chain','public_observed_at','leader','token_address']);
      assert.deepEqual(reader.prepare('PRAGMA index_info(wh_assoc_relation_page)').all().map(row=>row.name),
        ['token_count','funding_count','forward_count','updated_at','leader','candidate']);
      assert.deepEqual(reader.prepare('PRAGMA index_info(wh_assoc_relation_chain_page)').all().map(row=>row.name),
        ['chain','token_count','funding_count','forward_count','updated_at','leader','candidate']);
      const lookup='SELECT leader,candidate FROM wh_assoc_episodes WHERE chain=? AND token_address=? AND active=1';
      const plan=reader.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all(chain,token).map(row=>String(row.detail));
      assert.ok(plan.some(detail=>detail.includes('COVERING INDEX wh_assoc_episode_token')&&detail.includes('chain=? AND token_address=? AND active=?')));
      const updatePlan=reader.prepare(`EXPLAIN QUERY PLAN UPDATE wh_assoc_relations SET dirty=1 WHERE chain=? AND (leader,candidate) IN (${lookup})`)
        .all(chain,chain,token).map(row=>String(row.detail));
      assert.ok(updatePlan.some(detail=>detail.includes('COVERING INDEX wh_assoc_episode_token')));
      const recentPlan=reader.prepare(`EXPLAIN QUERY PLAN SELECT chain,leader,token_address,public_observed_at,collection_checked_at
        FROM wh_assoc_anchors INDEXED BY wh_assoc_anchor_recent WHERE chain=? AND public_observed_at>=? AND public_observed_at<=?
        ORDER BY COALESCE(collection_checked_at,''),public_observed_at DESC,leader,token_address LIMIT 20`)
        .all(chain,iso(0),iso(100)).map(row=>String(row.detail));
      assert.ok(recentPlan.some(detail=>detail.includes('INDEX wh_assoc_anchor_recent')&&detail.includes('chain=? AND public_observed_at>?')));
      const knownPlan=reader.prepare(`EXPLAIN QUERY PLAN SELECT chain,leader,candidate,collection_checked_at,token_count,funding_count
        FROM wh_assoc_relations INDEXED BY wh_assoc_relation_targets WHERE chain=? AND token_count>0
        ORDER BY COALESCE(collection_checked_at,''),token_count DESC,funding_count DESC,leader,candidate LIMIT 20`)
        .all(chain).map(row=>String(row.detail));
      assert.ok(knownPlan.some(detail=>detail.includes('INDEX wh_assoc_relation_targets')&&detail.includes('chain=?')));
      const pages=[
        reader.prepare(`EXPLAIN QUERY PLAN SELECT r.* FROM wh_assoc_relations r INDEXED BY wh_assoc_relation_page
          WHERE r.token_count>0 ORDER BY r.token_count DESC,r.funding_count DESC,r.forward_count DESC,r.updated_at DESC,r.leader,r.candidate LIMIT 25 OFFSET 0`).all(),
        reader.prepare(`EXPLAIN QUERY PLAN SELECT r.* FROM wh_assoc_relations r INDEXED BY wh_assoc_relation_chain_page
          WHERE r.token_count>0 AND r.chain=? ORDER BY r.token_count DESC,r.funding_count DESC,r.forward_count DESC,r.updated_at DESC,r.leader,r.candidate LIMIT 25 OFFSET 0`).all(chain),
      ];
      for(const plan of pages)assert.ok(plan.every(row=>!String(row.detail).includes('USE TEMP B-TREE')),plan.map(row=>row.detail).join('\n'));
    } finally {reader.close();}
    history.recordTrade(trade({wallet:address(8),eventAt:iso(40),observedAt:iso(80),txHash:hash(800)}));
    assert.equal(history.getAssociation(chain,leader,candidate)!.association.status,'stale');
    assert.equal(history.getAssociation(chain,leader,candidate)!.episodes.length,original.episodes.length);
  } finally {history?.close();rmSync(directory,{recursive:true,force:true});}
});

test('KOL-directed lead episodes deduplicate feeds and same token, exclude same tx/time, retain full evidence',()=>{
  const {history}=fixture();try {
    pair(history);
    history.recordTrade(trade({source:'gmgn_association_wallet_activity',observedAt:iso(90)}));
    history.recordTrade(trade({wallet:leader,eventAt:iso(70),observedAt:iso(75),txHash:hash(2001),source:'gmgn_kol_feed'}));
    history.recordTrade(trade({wallet:address(3),eventAt:iso(60),txHash:hash(3),observedAt:iso(65)}));
    history.recordTrade(trade({wallet:address(4),eventAt:iso(30),txHash:hash(1001),observedAt:iso(35)}));
    history.refreshAssociations();
    const list=history.listAssociations();assert.equal(list.total,1);const item=list.items[0];
    assert.equal(item.leader,leader);assert.equal(item.candidate,candidate);assert.equal(item.distinctTokens,1);
    assert.equal(item.grade,'timing_only');assert.equal(item.prospectiveTokens,1);assert.equal(item.forwardValidatedTokens,0);
    const detail=history.getAssociation(chain,leader,candidate)!;assert.equal(detail.episodes[0].leadSeconds,40);
    assert.equal(detail.episodes[0].leaderBuy.txHash,hash(1001));assert.equal(detail.episodes[0].candidateBuy.txHash,hash(1));
    assert.equal(detail.episodes[0].leaderPublicSource,'gmgn_kol_feed');assert.equal(detail.association.ownership,'unknown');
    assert.equal(detail.coverage.firstObservedBuy,true);assert.equal(detail.coverage.exactRealizedPnl,false);
    history.refreshAssociations();assert.equal(history.associationStats().episodes,1);
  } finally {history.close();}
});

test('recurrence counts distinct coins; candidate exits after leader are evidence and not inferred profit',()=>{
  const {history}=fixture();try {
    pair(history);pair(history,{token:address(101),n:2});
    history.recordTrade(trade({side:'sell',eventAt:iso(80),observedAt:iso(85),txHash:hash(300)}));
    history.refreshAssociations(3);
    const detail=history.getAssociation(chain,leader,candidate)!;
    assert.equal(detail.association.distinctTokens,2);assert.equal(detail.association.grade,'repeated_timing');
    assert.equal(detail.association.exitAfterLeaderTokens,1);assert.equal(detail.association.forwardValidatedTokens,0);
    assert.equal(detail.episodes.find(item=>item.tokenAddress===token)!.candidateSellAfterLeader!.txHash,hash(300));
    assert.equal(JSON.stringify(detail).includes('realizedProfitUsd'),false);
  } finally {history.close();}
});

test('historical imports cannot become forward validation; future coins require a relationship known before candidate trade',()=>{
  const {history,setNow}=fixture();try {
    pair(history,{candidateObserved:90});history.refreshAssociations();
    let item=history.listAssociations().items[0];assert.equal(item.retrospectiveTokens,1);assert.equal(item.forwardValidatedTokens,0);
    setNow(260);pair(history,{token:address(101),candidateAt:200,candidateObserved:205,leaderAt:240,leaderObserved:250,n:2});
    history.refreshAssociations();item=history.listAssociations().items[0];assert.equal(item.forwardValidatedTokens,1);assert.equal(item.prospectiveTokens,1);
    setNow(400);pair(history,{token:address(102),candidateAt:120,candidateObserved:300,leaderAt:180,leaderObserved:350,n:3});
    history.refreshAssociations();item=history.listAssociations().items[0];assert.equal(item.distinctTokens,3);assert.equal(item.forwardValidatedTokens,1);
    assert.equal(item.retrospectiveTokens,2);assert.equal(item.firstDiscoveredAt,iso(100));
    history.recordTrade(trade({wallet:address(8),eventAt:iso(500),observedAt:iso(500)}));
    assert.equal(history.getWallet(chain,address(8)),undefined);
  } finally {history.close();}
});

test('discovering an earlier leader buy invalidates derived lead without deleting original evidence',()=>{
  const {history,setNow}=fixture();try {
    pair(history);history.refreshAssociations();assert.equal(history.listAssociations().total,1);
    setNow(200);history.recordTrade(trade({wallet:leader,eventAt:iso(10),observedAt:iso(180),txHash:hash(500),source:'gmgn_association_wallet_activity'}));
    history.refreshAssociations();assert.equal(history.listAssociations().total,0);assert.equal(history.getAssociation(chain,leader,candidate),undefined);
    assert.equal(history.stats().events,3);assert.equal(history.getWallet(chain,candidate)!.timeline.length,1);
  } finally {history.close();}
});

test('direct and common funding are vendor clues; shared services and latest conflict remove support',()=>{
  const {history,setNow}=fixture();try {
    pair(history);funding(history,candidate,leader);funding(history,leader,address(500));funding(history,candidate,address(500));
    history.refreshAssociations();let detail=history.getAssociation(chain,leader,candidate)!;
    assert.deepEqual(detail.association.fundingKinds.sort(),['common','direct']);assert.equal(detail.association.grade,'funding_supported');
    assert.equal(detail.fundingEvidence.every(item=>item.verification==='vendor_claim'),true);
    setNow(200);funding(history,candidate,leader,{conflict:true,observedAt:180,snapshotAt:170});
    funding(history,address(6),address(500),{sharedService:true,observedAt:180,snapshotAt:170});history.refreshAssociations();
    detail=history.getAssociation(chain,leader,candidate)!;assert.deepEqual(detail.association.fundingKinds,[]);assert.equal(detail.association.grade,'timing_only');
    assert.equal(history.getWallet(chain,candidate)!.fundingEdges.length,3);
  } finally {history.close();}
});

test('public exchange label excludes common funding even when provider omitted sharedService flag',()=>{
  const {history}=fixture();try {
    pair(history);history.captureLeaders(chain,[{address:address(500),period:'7d',labels:['exchange_or_pool']}],{source:'gmgn_stats',observedAt:iso(70)});
    funding(history,leader,address(500));funding(history,candidate,address(500));history.refreshAssociations();
    assert.deepEqual(history.listAssociations().items[0].fundingKinds,[]);
  } finally {history.close();}
});

test('recent association targets rotate by checked time and never cross chains',()=>{
  const {history,setNow}=fixture();try {
    pair(history);pair(history,{token:address(101),n:2});history.refreshAssociations();
    let target=history.associationTargets(chain,1)[0];assert.equal(target.anchorWallet,leader);
    history.markAssociationTargetChecked(target,iso(90));assert.notEqual(history.associationTargets(chain,1)[0].address,target.address);
    assert.equal(history.associationTargets('solana').length,0);
    setNow(90000);assert.equal(history.associationTargets(chain).length,1);assert.equal(history.associationTargets(chain)[0].historicalRelationship,true);
  } finally {history.close();}
});

test('incremental legacy indexing survives restart; refresh bounded and list pagination is independent of graph joins',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-associations-')),file=join(dir,'history.sqlite');
  try {
    let history=new WalletHistory(file,{now:()=>new Date(base+100000)});
    for(let n=0;n<9;n++) pair(history,{token:address(100+n),n:n+1});
    history.close();const db=new DatabaseSync(file);db.exec('DELETE FROM wh_assoc_anchors');db.close();
    history=new WalletHistory(file,{now:()=>new Date(base+100000)});
    history.refreshAssociations(2);assert.equal(history.associationStats().anchors,9);assert.equal(history.associationStats().pending,7);
    assert.equal(history.listAssociations().items[0].distinctTokens,2);
    history.close();history=new WalletHistory(file,{now:()=>new Date(base+110000)});
    history.refreshAssociations(2);assert.equal(history.associationStats().pending,5);assert.equal(history.listAssociations({limit:1}).items.length,1);
    assert.equal(history.listAssociations({offset:1}).items.length,0);assert.equal(history.listAssociations({search:leader.slice(-4)}).total,1);
    history.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('an orphan derived anchor is marked checked and cannot starve later valid anchors',()=>{
  const {history}=fixture(),db=(history as unknown as {db:DatabaseSync}).db;
  const orphanLeader=address(90),orphanToken=address(190);
  try {
    pair(history);
    db.prepare(`INSERT INTO wh_assoc_anchors(chain,leader,token_address,public_observed_at,dirty)
      VALUES (?,?,?,?,1)`).run(chain,orphanLeader,orphanToken,iso(1));
    assert.equal(history.associationStats().pending,2);
    history.refreshAssociations(1);
    assert.equal(Number(db.prepare(`SELECT dirty FROM wh_assoc_anchors WHERE chain=? AND leader=? AND token_address=?`)
      .get(chain,orphanLeader,orphanToken)!.dirty),0);
    assert.equal(history.associationStats().pending,1);
    history.refreshAssociations(1);
    assert.equal(history.associationStats().pending,0);
    assert.equal(history.listAssociations().total,1);

    history.recordTrade(trade({wallet:orphanLeader,tokenAddress:orphanToken,txHash:hash(9090),side:'buy',
      eventAt:iso(40),observedAt:iso(50),source:'gmgn_kol_feed'}));
    assert.equal(Number(db.prepare(`SELECT dirty FROM wh_assoc_anchors WHERE chain=? AND leader=? AND token_address=?`)
      .get(chain,orphanLeader,orphanToken)!.dirty),1,'later raw evidence reopens the derived anchor');
  } finally {history.close();}
});

test('repeating the same association invalidation does not rewrite rows already dirty',()=>{
  const {history}=fixture(),db=(history as unknown as {db:DatabaseSync}).db,values=JSON.stringify([candidate]);
  try {
    pair(history);history.refreshAssociations();
    const anchors=db.prepare(WALLET_ASSOCIATION_INVALIDATION_SQL.fundingAnchors);
    const relations=db.prepare(WALLET_ASSOCIATION_INVALIDATION_SQL.fundingRelations);
    assert.equal(Number(anchors.run(values,chain,values,chain).changes),1);
    assert.equal(Number(anchors.run(values,chain,values,chain).changes),0);
    assert.equal(Number(relations.run(values,chain,values,chain).changes),1);
    assert.equal(Number(relations.run(values,chain,values,chain).changes),0);
  } finally {history.close();}
});

test('candidate funds leader is direct vendor evidence and public funder reclassification invalidates old cached support',()=>{
  const {history,setNow}=fixture();try {
    pair(history);funding(history,leader,candidate);history.refreshAssociations();
    let detail=history.getAssociation(chain,leader,candidate)!;assert.equal(detail.fundingEvidence[0].kind,'direct');
    assert.equal(detail.fundingEvidence[0].edges[0].wallet,leader);assert.equal(detail.fundingEvidence[0].edges[0].fundingAddress,candidate);
    assert.equal(detail.fundingEvidence[0].observedAt,iso(80)); // Funding learned after leader trade is never backdated.
    setNow(200);history.captureLeaders(chain,[{address:candidate,period:'7d',labels:['exchange_or_pool']}],{source:'gmgn_stats',observedAt:iso(150)});
    for(let batch=0;batch<4&&history.associationInvalidationStatus().pending;batch++)history.flushAssociationInvalidations(64);
    assert.equal(history.getAssociation(chain,leader,candidate)!.association.status,'stale');history.refreshAssociations();
    detail=history.getAssociation(chain,leader,candidate)!;assert.equal(detail.fundingEvidence.length,0);assert.equal(detail.association.status,'current');
    assert.equal(detail.association.forwardValidatedTokens,0);
  } finally {history.close();}
});

test('future event observations are rejected and cannot produce association or after-leader exit',()=>{
  const {history}=fixture();try {
    pair(history);history.recordTrade(trade({side:'sell',txHash:hash(900),eventAt:iso(101),observedAt:iso(102)}));
    history.recordTrade(trade({wallet:address(9),source:'gmgn_kol_feed',eventAt:iso(105),observedAt:iso(110)}));
    history.refreshAssociations();assert.equal(history.listAssociations().total,1);
    assert.equal(history.getAssociation(chain,leader,candidate)!.association.exitAfterLeaderTokens,0);
  } finally {history.close();}
});

test('unrelated token activity does not strand relation stale; first KOL appearance refreshes candidate visibility',()=>{
  const {history,setNow}=fixture();try {
    pair(history);history.refreshAssociations();assert.equal(history.listAssociations().items[0].candidatePublic,false);
    setNow(200);history.recordTrade(trade({tokenAddress:address(101),txHash:hash(500),eventAt:iso(140),observedAt:iso(145)}));
    assert.equal(history.listAssociations().items[0].status,'current');
    history.recordTrade(trade({tokenAddress:address(101),txHash:hash(500),eventAt:iso(140),observedAt:iso(180),source:'gmgn_kol_feed'}));
    assert.equal(history.listAssociations().items[0].status,'stale');history.refreshAssociations(3);
    assert.equal(history.getAssociation(chain,leader,candidate)!.association.candidatePublic,true);
    assert.equal(history.getAssociation(chain,leader,candidate)!.association.status,'current');
  } finally {history.close();}
});

test('conflicting provider timestamps withdraw timing evidence; amount-only differences do not',()=>{
  const {history,setNow}=fixture();try {
    pair(history);history.refreshAssociations();assert.equal(history.listAssociations().total,1);
    history.recordTrade(trade({source:'gmgn_association_wallet_activity',observedAt:iso(80),amount:'9'}));
    history.refreshAssociations();assert.equal(history.listAssociations().total,1);
    setNow(200);history.recordTrade(trade({source:'gmgn_association_wallet_activity',observedAt:iso(190),eventAt:iso(120)}));
    history.refreshAssociations();assert.equal(history.listAssociations().total,0);
    assert.equal(history.getWallet(chain,candidate)!.timeline[0].evidence.length,3);
    pair(history,{token:address(101),n:2});history.refreshAssociations();assert.equal(history.listAssociations().total,1);
    history.recordTrade(trade({wallet:leader,tokenAddress:address(101),txHash:hash(1002),source:'gmgn_association_wallet_activity',eventAt:iso(10),observedAt:iso(180)}));
    history.refreshAssociations();assert.equal(history.listAssociations().total,0);
  } finally {history.close();}
});

test('a newer conflicting funding origin cannot leave an old different-origin association in force',()=>{
  const {history,setNow}=fixture();try {
    pair(history);funding(history,leader,address(500));funding(history,candidate,address(500));history.refreshAssociations();
    assert.equal(history.listAssociations().items[0].grade,'funding_supported');
    setNow(200);funding(history,candidate,address(501),{conflict:true,observedAt:180,snapshotAt:170});history.refreshAssociations();
    assert.deepEqual(history.listAssociations().items[0].fundingKinds,[]);
    funding(history,candidate,address(500),{observedAt:190,snapshotAt:70});history.refreshAssociations();
    assert.deepEqual(history.listAssociations().items[0].fundingKinds,[]);
  } finally {history.close();}
});

test('fully invalidated relationships must be rediscovered before future activity can count as forward validation',()=>{
  const {history,setNow}=fixture();try {
    pair(history);history.refreshAssociations();
    setNow(200);history.recordTrade(trade({source:'gmgn_association_wallet_activity',observedAt:iso(190),eventAt:iso(120)}));
    history.refreshAssociations();assert.equal(history.listAssociations().total,0);
    setNow(300);pair(history,{token:address(101),candidateAt:210,candidateObserved:220,leaderAt:240,leaderObserved:250,n:2});
    history.refreshAssociations();let item=history.listAssociations().items[0];assert.equal(item.firstDiscoveredAt,iso(100));assert.equal(item.forwardValidatedTokens,0);
    setNow(400);pair(history,{token:address(102),candidateAt:350,candidateObserved:360,leaderAt:380,leaderObserved:390,n:3});
    history.refreshAssociations();item=history.listAssociations().items[0];assert.equal(item.forwardValidatedTokens,1);
  } finally {history.close();}
});

test('known relationship polling survives old anchor age and fairly rotates individual candidates',()=>{
  const {history,setNow}=fixture();try {
    pair(history);history.recordTrade(trade({wallet:address(3),txHash:hash(3),eventAt:iso(25),observedAt:iso(30)}));
    history.refreshAssociations();let targets=history.associationTargets(chain,5,'known');assert.equal(targets.length,2);
    assert.equal(targets.every(item=>item.historicalRelationship),true);const first=targets[0];history.markAssociationTargetChecked(first,iso(90));
    assert.notEqual(history.associationTargets(chain,1,'known')[0].candidateWallet,first.candidateWallet);
    setNow(90000);targets=history.associationTargets(chain,5);assert.equal(targets.length,2);assert.equal(targets.every(item=>item.historicalRelationship),true);
    assert.equal(targets.every(item=>item.anchorEventAt===iso(60)),true); // Old anchor context does not masquerade as new activity.
  } finally {history.close();}
});
