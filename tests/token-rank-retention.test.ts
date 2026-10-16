import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WalletHistory} from '../src/wallet-history.js';
import {SourceCorroboration} from '../src/source-corroboration.js';
import {TokenRankResearch, TokenRankResearchReader} from '../src/token-rank-research.js';

const origin = Date.parse('2026-10-16T02:00:00.000Z');
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'token-rank-retention-'));
  const historyDatabase = join(directory, 'history.sqlite'), sourceDatabase = join(directory, 'sources.sqlite'), database = join(directory, 'rank.sqlite');
  let clock = origin;
  const now = () => new Date(clock), stamp = () => now().toISOString();
  const history = new WalletHistory(historyDatabase, {now}), signals = new SourceCorroboration(sourceDatabase, {now});
  const engines: TokenRankResearch[] = [], readers: TokenRankResearchReader[] = [];
  const create = () => {
    const engine = new TokenRankResearch({database, historyDatabase, sourceDatabase, now, maxBytes: 32 * 1024 * 1024});
    const reader = new TokenRankResearchReader(database, now); engines.push(engine); readers.push(reader); return {engine, reader};
  };
  const rank = (tokens: number[]) => history.captureTokenRanks('bsc', tokens.map((n, index) => ({address: address(n), rank: index + 1,
    interval: '1h', changeMetric: '10', changeUnit: 'vendor_unspecified'})), {source: 'gmgn_change1h_rank', observedAt: stamp()});
  const trader = (token: number, wallet: number, realized: number) => history.captureTokenTraders({chain: 'bsc', address: address(token)},
    [{address: address(wallet), rank: 1, profitUsd: String(realized), realizedProfitUsd: String(realized), unrealizedProfitUsd: '0',
      rankScope: 'vendor_profit_order', sampleLimit: 100}], {source: 'gmgn_token_profit_rank', observedAt: stamp()});
  return {history, signals, now, stamp, rank, trader, create,
    advance(milliseconds = 1_000) {clock += milliseconds;},
    close() {readers.forEach(reader => reader.close()); engines.forEach(engine => engine.close()); history.close(); signals.close(); rmSync(directory, {recursive: true, force: true});}};
}

test('a previously learned token PnL survives rolling discovery windows; repeat snapshots never add profit and a real newer loss replaces it', () => {
  const f = fixture();
  try {
    f.rank([1]); f.trader(1, 2, 500);
    let {engine, reader} = f.create(); engine.runBatch(500);
    const firstAsOf = reader.wallet('bsc', address(2)).asOf;
    assert.equal(reader.wallet('bsc', address(2)).wallet?.realizedProfitUsd, 500);
    // This is just repeated coverage of another wallet; it says nothing new about wallet 2.
    for (let n = 0; n < 501; n++) {f.advance(); f.trader(1, 3, 10);}
    engine.runBatch(500);
    let old = reader.wallet('bsc', address(2));
    assert.equal(old.wallet?.tokenCount, 1, 'sliding out of a bounded discovery page cannot erase a learned token relation');
    assert.equal(old.wallet?.realizedProfitUsd, 500, 'no newer observation exists to replace the retained cumulative profit');
    assert.equal(old.items[0]?.pnl?.realizedProfitUsd, 500);
    assert.equal(reader.wallet('bsc', address(3)).wallet?.realizedProfitUsd, 10, '501 cumulative snapshots are still one token position');
    assert.equal(f.history.getWallet('bsc', address(2))?.tokenTraderSnapshots.length, 1);
    assert.equal(reader.detail('bsc', address(1)).token?.coverage.truncated, true);
    ({engine, reader} = f.create()); engine.runBatch(500);
    assert.equal(reader.wallet('bsc', address(2)).wallet?.realizedProfitUsd, 500, 'retention must survive engine restart');
    assert.equal(reader.wallet('bsc', address(3)).wallet?.realizedProfitUsd, 10);
    f.advance(); f.trader(1, 2, -5); engine.runBatch(500);
    old = reader.wallet('bsc', address(2));
    assert.equal(old.wallet?.realizedProfitUsd, -5, 'new negative evidence replaces the old cumulative snapshot instead of being added or ignored');
    assert.equal(old.wallet?.negativeRealizedTokens, 1); assert.equal(old.wallet?.tokenCount, 1);
    assert.equal(reader.wallet('bsc', address(2), {asOf: firstAsOf}).wallet?.realizedProfitUsd, 500, 'new evidence must not rewrite the older frozen page');
  } finally {f.close();}
});

test('continuously dirty hot tokens cannot starve a due clean token of new notification evidence', () => {
  const f = fixture();
  try {
    f.rank([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const {engine, reader} = f.create();
    engine.runBatch(500); f.advance(); engine.runBatch(500);
    assert.equal(reader.list({limit: 20}).total, 9);
    assert.equal(reader.detail('bsc', address(1)).token?.firstSignal, undefined);
    f.advance(301_000);
    const signalAt = f.stamp();
    assert.equal(f.signals.record({source: 'ave', sourceEventId: 'ave-cold-token-notification', occurredAt: signalAt,
      token: {chain: 'bsc', address: address(1)}, text: '', evidenceUrls: [], claim: 'unspecified'}).accepted, true);
    // Every round has at least as many dirty hot tokens as the eight-token computation budget.
    for (let round = 0; round < 6; round++) {
      f.advance(); f.rank([2, 3, 4, 5, 6, 7, 8, 9]); engine.runBatch(500);
    }
    const refreshed = reader.detail('bsc', address(1)).token;
    assert.equal(refreshed?.firstSignal?.eventAt, signalAt, 'bounded due work must keep progressing even while dirty inputs arrive');
    assert.equal(refreshed?.firstSignal?.evidenceId, 'ave:ave-cold-token-notification');
    assert.ok(refreshed!.computedAt >= signalAt);
    const status = engine.status(); assert.ok('maxTokensPerBatch' in status);
    assert.equal(status.maxTokensPerBatch, 8, 'fairness must reuse, not expand, the existing computation budget');
  } finally {f.close();}
});
