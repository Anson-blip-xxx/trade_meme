import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {WalletHistory} from '../src/wallet-history.js';
import type {Chain} from '../src/types.js';

const base = Date.parse('2026-10-11T00:00:00.000Z');
const iso = (n: number) => new Date(base + n * 1000).toISOString();
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const token = {chain: 'bsc' as const, address: address(9000)};
function funding(history: WalletHistory, wallet: number, funder: number, patch: {
  chain?: Chain; snapshot?: number; observed?: number; sharedService?: boolean; conflict?: boolean;
} = {}) {
  const chain = patch.chain ?? 'bsc';
  history.captureFunding({...token, chain}, address(wallet), {
    address: address(funder), timestamp: iso(0), sharedService: patch.sharedService, conflict: patch.conflict,
  }, {source: 'gmgn_funding', observedAt: iso(patch.observed ?? 20), snapshotAt: iso(patch.snapshot ?? 10)});
}
function captureSharedQuery(history: WalletHistory) {
  const db = (history as unknown as {db: DatabaseSync}).db;
  const original = db.prepare.bind(db);
  let query: string | undefined;
  db.prepare = ((sql: string) => {
    if (sql.includes('SELECT DISTINCT b.wallet,a.funding_address')) query = sql;
    return original(sql);
  }) as typeof db.prepare;
  return {db, prepare: original, query: () => {assert.ok(query, 'public wallet detail should run the actual shared funding query'); return query;}};
}

test('the production coordination query searches the target wallet before looking up related funders', () => {
  const history = new WalletHistory(':memory:', {now: () => new Date(base + 1000_000)});
  try {
    // Irrelevant same-chain wallets cannot become an outer scan for each target.
    for (let n = 0; n < 120; n++) funding(history, 100 + n, 1000 + n);
    funding(history, 1, 500); funding(history, 2, 500);
    history.captureLeaders('bsc', [{address: address(3), period: '7d'}], {source: 'gmgn_stats', observedAt: iso(20)});
    const captured = captureSharedQuery(history);
    assert.equal(history.getWallet('bsc', address(1))!.coordinationEvidence.sharedFunding.length, 1);
    const plan = captured.prepare(`EXPLAIN QUERY PLAN ${captured.query()}`).all('bsc', address(1));
    const outer = plan.filter(row => row.parent === 0 && /^SEARCH [ab] /.test(String(row.detail))).map(row => String(row.detail));
    assert.equal(outer.length, 2);
    // Covering indexes can also apply shared/conflict exclusions; retain the
    // essential wallet-first and exact-funder lookup checks for either form.
    assert.match(outer[0], /^SEARCH a USING (?:COVERING )?INDEX \w+ \(chain=\? AND wallet=\?(?: AND [^)]+)?\)$/);
    assert.match(outer[1], /^SEARCH b USING (?:COVERING )?INDEX \w+ \(chain=\? AND funding_address=\?(?: AND [^)]+)?\)$/);
    assert.ok(!outer.some(detail => /^SEARCH b .*\(chain=\?\)$/.test(detail)));
    assert.deepEqual(history.getWallet('bsc', address(3))!.coordinationEvidence.sharedFunding, []);
  } finally {history.close();}
});

test('forcing the wallet-first loop preserves latest-snapshot conflicts, shared-service exclusions and chain identity', () => {
  const history = new WalletHistory(':memory:', {now: () => new Date(base + 1000_000)});
  try {
    funding(history, 1, 100); funding(history, 2, 100, {observed: 25});
    funding(history, 3, 100, {observed: 27});
    funding(history, 3, 100, {snapshot: 30, observed: 40, conflict: true});
    funding(history, 4, 101);
    funding(history, 5, 100, {chain: 'robinhood'});
    funding(history, 1, 200); funding(history, 6, 200);
    funding(history, 7, 200, {sharedService: true});
    funding(history, 1, 300); funding(history, 8, 300);
    funding(history, 1, 300, {snapshot: 50, observed: 60, conflict: true});
    const captured = captureSharedQuery(history);
    const result = history.getWallet('bsc', address(1))!.coordinationEvidence.sharedFunding;
    assert.deepEqual(result, [{address: address(100), wallet: address(2), observedAt: iso(25)}]);
    const current = captured.query();
    // A small in-memory semantic comparison protects this strictly scheduling-oriented change.
    const original = current.replace('CROSS JOIN wh_funding b', 'JOIN wh_funding b');
    const rows = (sql: string) => captured.prepare(sql).all('bsc', address(1)).map(row => ({...row}));
    assert.deepEqual(rows(current), rows(original));
  } finally {history.close();}
});
