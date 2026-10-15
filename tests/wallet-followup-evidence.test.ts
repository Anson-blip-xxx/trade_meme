import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {WalletHistory,type WalletTradeObservation} from '../src/wallet-history.js';

const base=Date.parse('2026-10-15T00:00:00.000Z');
const iso=(seconds:number)=>new Date(base+seconds*1000).toISOString();
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const token={chain:'bsc' as const,address:address(100)};
const trade=(patch:Partial<WalletTradeObservation>={}):WalletTradeObservation=>({chain:'bsc',tokenAddress:token.address,
  wallet:address(1),txHash:hash(1),side:'buy',eventAt:iso(100),observedAt:iso(105),source:'gmgn_wallet_activity',usd:'200',...patch});
function fixture() {
  const history=new WalletHistory(':memory:',{now:()=>new Date(iso(2000))});
  return {history,db:(history as unknown as {db:DatabaseSync}).db};
}

test('follow-up evidence aggregates sampled buys and sells without writes or wallet ownership assumptions',()=>{
  const {history,db}=fixture();
  try {
    history.recordTrades([trade(),trade({txHash:hash(2),wallet:address(2),side:'sell',usd:'75',source:'gmgn_kol_feed'}),
      trade({txHash:hash(3),usd:'25',source:'analysis_report'})]);
    const before=db.prepare('SELECT total_changes() AS n').get()!.n;
    const result=history.followupEvidence(token,iso(0),iso(200));
    assert.equal(result.chain,token.chain);assert.equal(result.address,token.address);
    assert.equal(result.coverage,'sampled');assert.equal(result.evidenceCount,3);
    assert.equal(result.buyUsd,225);assert.equal(result.sellUsd,75);assert.equal(result.netBuyUsd,150);
    assert.equal(result.buyerCount,1);assert.equal(result.sellerCount,1);assert.equal(result.excludedCount,0);
    assert.ok(result.trades.every(row=>/^[a-f0-9]{64}$/.test(row.evidenceId)&&row.txHash.startsWith('0x')));
    assert.equal(result.trades.find(row=>row.wallet===address(2))?.source,'gmgn_kol_feed');
    assert.ok(result.limitations.includes('VENDOR_REPORTED_NOT_OWNERSHIP_PROOF'));
    assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,before);
  }finally {history.close();}
});

test('both event and local observation must fall within the review window, with chain and CA binding',()=>{
  const {history}=fixture();
  try {
    history.recordTrades([
      trade({txHash:hash(1),eventAt:iso(99),observedAt:iso(105)}),
      trade({txHash:hash(2),eventAt:iso(100),observedAt:iso(100),usd:'10'}),
      trade({txHash:hash(3),eventAt:iso(200),observedAt:iso(200),usd:'20'}),
      trade({txHash:hash(4),eventAt:iso(150),observedAt:iso(201)}),
      trade({txHash:hash(5),tokenAddress:address(101)}),
      trade({txHash:hash(6),chain:'robinhood'}),
    ]);
    const result=history.followupEvidence(token,iso(100),iso(200));
    assert.equal(result.buyUsd,30);assert.equal(result.evidenceCount,2);assert.equal(result.excludedCount,1);
    assert.deepEqual(result.trades.map(row=>row.eventAt),[iso(100),iso(200)]);
  }finally {history.close();}
});

test('invalid or future review windows return unavailable, while an empty monitored sample stays explicit',()=>{
  const {history}=fixture();
  try {
    for(const [from,to] of [['bad',iso(10)],[iso(20),iso(10)],[iso(0),iso(2001)]]) {
      const result=history.followupEvidence(token,from,to);
      assert.equal(result.coverage,'unavailable');assert.equal(result.netBuyUsd,null);
    }
    assert.equal(history.followupEvidence({...token,address:'bad'},iso(0),iso(10)).coverage,'unavailable');
    assert.equal(history.followupEvidence({...token,address:'bad'},iso(0),iso(10)).address,undefined);
    assert.equal(history.followupEvidence({...token,address:address(0)},iso(0),iso(10)).coverage,'unavailable');
    const empty=history.followupEvidence(token,iso(0),iso(10));
    assert.equal(empty.coverage,'sampled');assert.equal(empty.evidenceCount,0);assert.equal(empty.netBuyUsd,0);
    assert.ok(empty.limitations.includes('NO_OBSERVATION_DOES_NOT_MEAN_NO_TRADE'));
    assert.ok(empty.limitations.includes('MONITORED_WALLET_SAMPLE_NOT_WHOLE_MARKET'));
  }finally {history.close();}
});

test('equivalent vendor copies count once and indexed evidence retains the time it became known',()=>{
  const {history}=fixture();
  try {
    history.recordTrades([trade(),trade({source:'gmgn_smartmoney_feed',observedAt:iso(110)}),
      trade({eventIndex:7,source:'gmgn_association_candidate_activity',observedAt:iso(120)})]);
    const early=history.followupEvidence(token,iso(0),iso(115));
    assert.equal(early.evidenceCount,1);assert.equal(early.buyUsd,200);assert.equal(early.trades[0].observedAt,iso(105));
    const later=history.followupEvidence(token,iso(0),iso(200));
    assert.equal(later.evidenceCount,1);assert.equal(later.buyUsd,200);assert.equal(later.trades[0].observedAt,iso(120));
    assert.equal(later.trades[0].source,'gmgn_association_candidate_activity');
  }finally {history.close();}
});

test('later contradictory amount or timestamp evidence excludes the affected group only after discovery',()=>{
  for(const conflicting of [{usd:'300'},{eventAt:iso(101)}]) {
    const {history}=fixture();
    try {
      history.recordTrades([trade(),trade({source:'gmgn_kol_feed',observedAt:iso(120),...conflicting}),
        trade({txHash:hash(2),side:'sell',usd:'50'})]);
      assert.equal(history.followupEvidence(token,iso(0),iso(115)).netBuyUsd,150);
      const later=history.followupEvidence(token,iso(0),iso(200));
      assert.equal(later.evidenceCount,1);assert.equal(later.netBuyUsd,-50);assert.equal(later.excludedCount,2);
      assert.ok(later.limitations.includes('INVALID_OR_AMBIGUOUS_OBSERVATIONS_EXCLUDED'));
    }finally {history.close();}
  }
});

test('multiple indexed events remain distinct, but an unindexed copy makes that transaction group ambiguous',()=>{
  const {history}=fixture();
  try {
    history.recordTrades([trade({eventIndex:1}),trade({eventIndex:2})]);
    assert.equal(history.followupEvidence(token,iso(0),iso(200)).buyUsd,400);
    history.recordTrade(trade({source:'gmgn_kol_feed',observedAt:iso(120)}));
    const result=history.followupEvidence(token,iso(0),iso(200));
    assert.equal(result.evidenceCount,0);assert.equal(result.excludedCount,3);assert.equal(result.buyUsd,0);
  }finally {history.close();}
});

test('a contradictory event timestamp outside the requested window cannot make the in-window copy appear uncontested',()=>{
  const {history}=fixture();
  try {
    history.recordTrades([trade(),trade({eventAt:iso(99),observedAt:iso(120),source:'gmgn_kol_feed'})]);
    assert.equal(history.followupEvidence(token,iso(100),iso(115)).buyUsd,200);
    const result=history.followupEvidence(token,iso(100),iso(200));
    assert.equal(result.buyUsd,0);assert.equal(result.excludedCount,2);assert.equal(result.evidenceCount,0);
  }finally {history.close();}
});

test('transfers, missing USD and cumulative profit snapshots cannot become sampled buy flow',()=>{
  const {history}=fixture();
  try {
    history.recordTrades([trade({side:'transferIn'}),trade({txHash:hash(2),usd:undefined,amount:'50000',priceUsd:'20'}),
      trade({txHash:hash(3),usd:'0'}),trade({txHash:hash(4),usd:'1000000000001'})]);
    history.captureTokenTraders(token,[{address:address(1),rank:1,profitUsd:'10000',realizedProfitUsd:'2000',
      unrealizedProfitUsd:'8000',buyVolumeUsd:'99999'}],{source:'gmgn_top_traders',observedAt:iso(150)});
    const result=history.followupEvidence(token,iso(0),iso(200));
    assert.equal(result.evidenceCount,0);assert.equal(result.netBuyUsd,0);assert.equal(result.excludedCount,4);
  }finally {history.close();}
});

test('more than 500 observations withholds all net-flow conclusions instead of using a biased page',()=>{
  const {history}=fixture();
  try {
    history.recordTrades(Array.from({length:501},(_,index)=>trade({txHash:hash(index+1),eventAt:iso(index+1),
      observedAt:iso(index+2),side:index<500?'buy':'sell',usd:index<500?'1':'1000'})));
    const result=history.followupEvidence(token,iso(0),iso(1000));
    assert.equal(result.coverage,'truncated');assert.equal(result.buyUsd,null);assert.equal(result.sellUsd,null);
    assert.equal(result.netBuyUsd,null);assert.equal(result.buyerCount,null);assert.equal(result.sellerCount,null);
    assert.equal(result.trades.length,0);assert.ok(result.limitations.includes('WALLET_OBSERVATIONS_LIMIT_500'));
  }finally {history.close();}
});

test('the 40-row evidence preview explicitly distinguishes examples from the full bounded aggregate',()=>{
  const {history}=fixture();
  try {
    history.recordTrades(Array.from({length:45},(_,index)=>trade({txHash:hash(index+1),usd:'1'})));
    const result=history.followupEvidence(token,iso(0),iso(200));
    assert.equal(result.coverage,'sampled');assert.equal(result.buyUsd,45);assert.equal(result.evidenceCount,45);
    assert.equal(result.trades.length,40);assert.ok(result.limitations.includes('EVIDENCE_EXAMPLES_LIMIT_40'));
  }finally {history.close();}
});

test('malformed or token-mismatched stored content cannot impersonate scoped trade evidence',()=>{
  const {history,db}=fixture();
  try {
    history.recordTrades([trade(),trade({txHash:hash(2)}),trade({txHash:hash(3)})]);
    const rows=db.prepare("SELECT id FROM wh_observations WHERE kind='trade' ORDER BY id").all();
    db.prepare('UPDATE wh_observations SET data=? WHERE id=?').run('{',rows[0].id!);
    db.prepare('UPDATE wh_observations SET data=json_set(data,\'$.tokenAddress\',?) WHERE id=?').run(address(101),rows[1].id!);
    const result=history.followupEvidence(token,iso(0),iso(200));
    assert.equal(result.evidenceCount,1);assert.equal(result.excludedCount,2);assert.equal(result.buyUsd,200);
  }finally {history.close();}
});
