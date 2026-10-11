import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {WalletHistory, type WalletTradeObservation} from '../src/wallet-history.js';
import {stepAdaptiveExit} from '../src/adaptive-exit.js';
import type {WalletAnalysis, WalletRecord} from '../src/research/wallet-types.js';

const base = Date.parse('2026-10-11T00:00:00.000Z');
const iso = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const token = {chain: 'bsc' as const, address: address(100)};
const otherToken = address(101), leader = address(1), candidate = address(2);
const trade = (patch: Partial<WalletTradeObservation> = {}): WalletTradeObservation => ({
  chain: 'bsc', tokenAddress: token.address, wallet: leader, txHash: hash(1), side: 'sell',
  eventAt: iso(900), observedAt: iso(905), source: 'gmgn_kol_feed', usd: '500', ...patch,
});
function fixture() {
  let now = 1800;
  const history = new WalletHistory(':memory:', {now: () => new Date(base + now * 1000)});
  return {history, setNow: (seconds: number) => {now = seconds;}};
}
function association(history: WalletHistory, tokenAddress = otherToken, offset = 0) {
  history.recordTrade(trade({wallet: candidate, tokenAddress, source: 'gmgn_association_wallet_activity', side: 'buy',
    txHash: hash(100 + offset), eventAt: iso(20 + offset), observedAt: iso(30 + offset), usd: undefined}));
  history.recordTrade(trade({wallet: leader, tokenAddress, side: 'buy', txHash: hash(1000 + offset),
    eventAt: iso(60 + offset), observedAt: iso(65 + offset), usd: undefined}));
  history.refreshAssociations(5);
}

test('exit pressure is a read-only, token-bound projection of qualified recent buy and sell amounts', () => {
  const {history} = fixture();
  try {
    history.recordTrades([trade(), trade({txHash: hash(2), side: 'buy', usd: '100', source: 'gmgn_smartmoney_feed'})]);
    const db = (history as unknown as {db: DatabaseSync}).db;
    const before = db.prepare('SELECT total_changes() AS n').get()!.n;
    const result = history.recentExitPressure(token, iso(1000))!;
    assert.equal(result.chain, 'bsc'); assert.equal(result.address, token.address);
    assert.equal(result.windowStartAt, iso(400)); assert.equal(result.windowEndAt, iso(1000));
    assert.equal(result.observedAt, iso(1000));
    assert.equal(result.trades.length, 2);
    assert.deepEqual(result.trades.map(item => item.volumeUsd).sort((a, b) => a - b), [100, 500]);
    assert.ok(result.trades.every(item => item.eventAt === iso(900) && item.observedAt === iso(905)));
    assert.ok(result.trades.every(item => /^[a-f0-9]{64}$/.test(item.evidenceId)));
    const summary = stepAdaptiveExit(undefined, {...token, priceUsd: 1, observedAt: iso(1000),
      evaluatedAt: iso(1000), source: 'gmgn_token_info_sample'}, result).state?.walletPressure;
    assert.equal(summary?.verification, 'vendor_reported');
    assert.equal(summary?.netSellRatio, 2 / 3);
    assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, before);
  } finally {history.close();}
});

test('ordinary wallet activity needs public trade evidence known by the quote time; later labels cannot qualify it', () => {
  const {history} = fixture();
  try {
    history.recordTrade(trade({wallet: candidate, source: 'gmgn_association_candidate_activity'}));
    history.captureLeaders('bsc', [{address: candidate, period: '7d', labels: ['smart', 'kol'], realizedProfitUsd: '90000'}],
      {source: 'gmgn_wallet_stats', observedAt: iso(800)});
    assert.equal(history.recentExitPressure(token, iso(1000)), undefined);
    history.recordTrade(trade({wallet: candidate, tokenAddress: otherToken, txHash: hash(2), side: 'buy',
      eventAt: iso(1090), observedAt: iso(1100), source: 'gmgn_smartmoney_feed'}));
    assert.equal(history.recentExitPressure(token, iso(1000)), undefined);
    const later = history.recentExitPressure(token, iso(1200))!;
    assert.equal(later.trades.length, 1);
    assert.equal(later.trades[0].source, 'gmgn_association_candidate_activity');
  } finally {history.close();}
});

test('an already-discovered candidate relationship admits new-token activity without a public wallet label', () => {
  const {history, setNow} = fixture();
  try {
    setNow(100); association(history);
    assert.equal(history.getAssociation('bsc', leader, candidate)?.association.status, 'current');
    setNow(1800);
    history.recordTrade(trade({wallet: candidate, source: 'gmgn_association_candidate_activity'}));
    const result = history.recentExitPressure(token, iso(1000))!;
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].wallet, candidate);
    assert.equal(result.trades[0].source, 'gmgn_association_candidate_activity');
    assert.equal(history.getWallet('bsc', candidate)?.wallet.labels.length, 0);
  } finally {history.close();}
});

test('future relationship discovery cannot qualify an earlier quote even if the underlying buys were historical', () => {
  const {history, setNow} = fixture();
  try {
    history.recordTrade(trade({wallet: candidate, source: 'gmgn_association_candidate_activity'}));
    setNow(1100); association(history);
    assert.equal(history.getAssociation('bsc', leader, candidate)?.association.firstDiscoveredAt, iso(1100));
    assert.equal(history.recentExitPressure(token, iso(1000)), undefined);
    assert.equal(history.recentExitPressure(token, iso(1100))?.trades.length, 1);
  } finally {history.close();}
});

test('a dirty candidate relationship is withheld until refreshed evidence validates it', () => {
  const {history, setNow} = fixture();
  try {
    setNow(100); association(history);
    setNow(200);
    history.recordTrade(trade({wallet: candidate, source: 'gmgn_association_candidate_activity', eventAt: iso(180), observedAt: iso(190)}));
    history.recordTrade(trade({wallet: leader, tokenAddress: otherToken, txHash: hash(9999), side: 'buy',
      source: 'gmgn_association_leader_activity', eventAt: iso(10), observedAt: iso(195), usd: undefined}));
    assert.equal(history.getAssociation('bsc', leader, candidate)?.association.status, 'stale');
    assert.equal(history.recentExitPressure(token, iso(200)), undefined);
    history.refreshAssociations(5);
    assert.equal(history.getAssociation('bsc', leader, candidate), undefined);
    assert.equal(history.recentExitPressure(token, iso(200)), undefined);
  } finally {history.close();}
});

test('a reactivated relationship cannot backdate eligibility into its invalid interval', () => {
  const {history, setNow} = fixture();
  try {
    setNow(100); association(history);
    setNow(200);
    history.recordTrade(trade({wallet: leader, tokenAddress: otherToken, txHash: hash(9999), side: 'buy',
      source: 'gmgn_association_leader_activity', eventAt: iso(10), observedAt: iso(190), usd: undefined}));
    history.refreshAssociations(5);
    assert.equal(history.getAssociation('bsc', leader, candidate), undefined);
    setNow(300);
    history.recordTrade(trade({wallet: candidate, source: 'gmgn_association_candidate_activity', eventAt: iso(250), observedAt: iso(260)}));
    assert.equal(history.recentExitPressure(token, iso(270)), undefined);
    setNow(400); association(history, address(102), 300);
    assert.equal(history.getAssociation('bsc', leader, candidate)?.association.firstDiscoveredAt, iso(100));
    assert.equal(history.recentExitPressure(token, iso(270)), undefined);
    assert.equal(history.recentExitPressure(token, iso(400))?.trades.length, 1);
  } finally {history.close();}
});

test('holding balances, token cumulative buys and sells, profit ranks and absent USD never become recent flow', () => {
  const {history} = fixture();
  try {
    history.recordTrade(trade({tokenAddress: otherToken, eventAt: iso(100), observedAt: iso(110), usd: undefined}));
    history.captureTokenTraders(token, [{address: leader, rank: 1, profitUsd: '500000', realizedProfitUsd: '400000',
      unrealizedProfitUsd: '100000', buyVolumeUsd: '10000', sellVolumeUsd: '90000', balance: '0', exitedAt: iso(890)}],
      {source: 'gmgn_top_traders', observedAt: iso(900)});
    const wallet = {chain: 'bsc', address: leader, recognizedLabels: ['smart'], risks: [], developerLinks: [],
      holding: {amount: '0', usd: '0', currentlyHolding: false, supplyRatio: 0},
      cumulative: {scope: 'vendor_token_cumulative', recentInflow: false, buyVolumeUsd: '10000', sellVolumeUsd: '999999',
        buyCount: 200, sellCount: 50, firstAcquiredAt: iso(0), lastActiveAt: iso(890), exitedAt: iso(890)},
      enrichment: {status: 'complete', reasons: []}} as unknown as WalletRecord;
    const analysis = {checkedAt: iso(890), summary: {token}, wallets: [wallet]} as unknown as WalletAnalysis;
    history.captureAnalysis(token, analysis, {source: 'gmgn_analysis', observedAt: iso(900)});
    history.recordTrades([trade({source: 'gmgn_wallet_activity', usd: undefined, amount: '999999', priceUsd: '100', amountUnit: 'atomic'}),
      trade({txHash: hash(2), source: 'gmgn_wallet_activity', usd: '0'}),
      trade({txHash: hash(3), source: 'gmgn_wallet_activity', usd: '1000000000001'})]);
    assert.ok(history.getWallet('bsc', leader)!.holdings.length > 0);
    assert.ok(history.getWallet('bsc', leader)!.tokenTraderSnapshots.length > 0);
    assert.equal(history.recentExitPressure(token, iso(1000)), undefined);
  } finally {history.close();}
});

test('ten-minute event and observation boundaries exclude delayed backfills and data not yet locally observed', () => {
  const {history} = fixture();
  try {
    history.recordTrades([
      trade({txHash: hash(1), eventAt: iso(399), observedAt: iso(905)}),
      trade({txHash: hash(2), eventAt: iso(399), observedAt: iso(399)}),
      trade({txHash: hash(3), eventAt: iso(900), observedAt: iso(1001)}),
      trade({txHash: hash(4), eventAt: iso(1001), observedAt: iso(1002)}),
      trade({txHash: hash(5), eventAt: iso(400), observedAt: iso(400), usd: '401'}),
      trade({txHash: hash(6), eventAt: iso(1000), observedAt: iso(1000), usd: '1001'}),
    ]);
    const result = history.recentExitPressure(token, iso(1000))!;
    assert.deepEqual(result.trades.map(item => item.volumeUsd).sort((a, b) => a - b), [401, 1001]);
    assert.equal(history.recentExitPressure(token, iso(1801)), undefined);
    assert.equal(history.recentExitPressure(token, 'not-a-timestamp'), undefined);
  } finally {history.close();}
});

test('same-transaction copies count once without backdating the later indexed evidence provenance', () => {
  const {history} = fixture();
  try {
    history.recordTrades([trade(), trade({source: 'gmgn_wallet_activity', observedAt: iso(910)}),
      trade({source: 'gmgn_association_leader_activity', observedAt: iso(920), eventIndex: 7})]);
    const earlier = history.recentExitPressure(token, iso(915))!;
    assert.equal(earlier.trades.length, 1);
    assert.equal(earlier.trades[0].observedAt, iso(905)); assert.equal(earlier.trades[0].source, 'gmgn_kol_feed');
    const result = history.recentExitPressure(token, iso(1000))!;
    assert.equal(result.trades.length, 1); assert.equal(result.trades[0].volumeUsd, 500);
    assert.equal(result.trades[0].observedAt, iso(920)); assert.equal(result.trades[0].source, 'gmgn_association_leader_activity');
  } finally {history.close();}
});

test('conflicting amount or timestamp evidence excludes the affected trade only after that evidence arrives', () => {
  for (const conflicting of [{usd: '600'}, {eventAt: iso(901)}]) {
    const {history} = fixture();
    try {
      history.recordTrades([trade(), trade({source: 'gmgn_wallet_activity', observedAt: iso(920), ...conflicting}),
        trade({txHash: hash(2), usd: '200'})]);
      assert.equal(history.recentExitPressure(token, iso(915))?.trades.length, 2);
      const result = history.recentExitPressure(token, iso(925))!;
      assert.equal(result.trades.length, 1); assert.equal(result.trades[0].volumeUsd, 200);
    } finally {history.close();}
  }
});

test('distinct explicitly indexed trades in the same transaction remain separate monetary observations', () => {
  const {history} = fixture();
  try {
    history.recordTrades([trade({eventIndex: 1}), trade({eventIndex: 2}),
      trade({eventIndex: 1, source: 'gmgn_wallet_activity', observedAt: iso(910)})]);
    const result = history.recentExitPressure(token, iso(1000))!;
    assert.equal(result.trades.length, 2);
    assert.equal(result.trades.reduce((sum, item) => sum + item.volumeUsd, 0), 1000);
  } finally {history.close();}
});

test('an unindexed copy cannot be assigned across multiple indexed events in the same transaction', () => {
  const {history} = fixture();
  try {
    history.recordTrades([trade({eventIndex: 1}), trade({eventIndex: 2}),
      trade({source: 'gmgn_wallet_activity', observedAt: iso(910)})]);
    assert.equal(history.recentExitPressure(token, iso(1000)), undefined);
  } finally {history.close();}
});

test('a conflict within an indexed event excludes its transaction group instead of reporting a biased partial sum', () => {
  const {history} = fixture();
  try {
    history.recordTrades([trade({eventIndex: 1}), trade({eventIndex: 2}),
      trade({eventIndex: 1, source: 'gmgn_wallet_activity', observedAt: iso(920), usd: '600'}),
      trade({txHash: hash(2), eventIndex: 1, usd: '300'})]);
    assert.equal(history.recentExitPressure(token, iso(915))?.trades.length, 3);
    const result = history.recentExitPressure(token, iso(1000))!;
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].volumeUsd, 300);
  } finally {history.close();}
});

test('wrong chains, other tokens, transfers, unsupported sources and unrelated wallets are not sell pressure', () => {
  const {history} = fixture();
  try {
    history.recordTrades([
      trade({chain: 'robinhood'}), trade({tokenAddress: otherToken}),
      trade({txHash: hash(2), side: 'transferOut'}), trade({txHash: hash(3), side: 'remove'}),
      trade({txHash: hash(4), source: 'gmgn_profit_ranking'}),
      trade({txHash: hash(5), wallet: candidate, source: 'gmgn_wallet_activity'}),
    ]);
    assert.equal(history.recentExitPressure(token, iso(1000)), undefined);
    assert.equal(history.recentExitPressure({chain: 'bsc', address: '0x7777'}, iso(1000)), undefined);
    history.recordTrade(trade({txHash: hash(6), source: 'gmgn_association_leader_activity'}));
    const result = history.recentExitPressure(token, iso(1000))!;
    assert.equal(result.trades.length, 1); assert.equal(result.trades[0].source, 'gmgn_association_leader_activity');
  } finally {history.close();}
});

test('bounded projection refuses an incomplete busy window instead of manufacturing net flow from one side', () => {
  for (const count of [101, 501]) {
    const {history} = fixture();
    try {
      history.recordTrades(Array.from({length: count}, (_, index) => trade({txHash: hash(index + 1),
        side: index % 2 ? 'buy' : 'sell', usd: String(index + 100)})));
      assert.equal(history.recentExitPressure(token, iso(1000)), undefined);
    } finally {history.close();}
  }
});
