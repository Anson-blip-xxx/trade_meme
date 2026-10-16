import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {WalletObserver, type WalletObserverOptions} from '../src/wallet-observer.js';
import {WalletHistory} from '../src/wallet-history.js';
import {parseWalletObserverCursor, type WalletObserverCursorState} from '../src/wallet-observer-state.js';
import {GmgnError} from '../src/providers/gmgn-client.js';

const epoch = Date.parse('2026-10-16T01:00:00.000Z');
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const state = (): WalletObserverCursorState => ({version: 1, chains: ['bsc'], cursor: 0,
  rank: [], market: [], associationRounds: [], wallets: [], associations: [], walletChecks: []});
function rig(history?: WalletHistory) {
  let clock = epoch, currentToken = addr(2), reverse = false;
  let throttle = false, hold: (() => Promise<unknown>) | undefined;
  const calls: {path: string; query: Record<string, string | number>; weight?: number}[] = [];
  const observed: {token: unknown; rows: any[]; context: any}[] = [], marked: unknown[] = [];
  let checkpoint: WalletObserverCursorState | undefined;
  const sink: WalletObserverOptions['history'] = {
    recordTrades: rows => history?.recordTrades(rows), captureAnalysis: (token, analysis, meta) => history?.captureAnalysis(token, analysis, meta),
    captureLeaders: (chain, rows, meta) => history?.captureLeaders(chain, rows, meta),
    captureTokenRanks: (chain, rows, meta) => history?.captureTokenRanks(chain, rows, meta),
    captureTokenTraders: (token, rows, context) => {observed.push({token, rows, context}); history?.captureTokenTraders(token, rows, context);},
    recordCollection: item => history?.recordCollection(item), watchTargets: () => [{chain: 'bsc', address: addr(2)}],
    markTargetChecked: (token, at) => {marked.push(token); history?.markTargetChecked(token, at);},
    recordPrice: (token, price, at, source) => history?.recordPrice(token, price, at, source), refreshCoordination: () => {},
    getWalletObserverCursor: () => history ? history.getWalletObserverCursor() : structuredClone(checkpoint),
    setWalletObserverCursor: value => history ? history.setWalletObserverCursor(value) : (checkpoint = structuredClone(value), true),
  };
  const client: WalletObserverOptions['client'] = {cooldownUntil: 0, async get(path, query, weight) {
    calls.push({path, query, weight});
    if (hold) return hold();
    if (throttle && path === '/v1/user/wallet_stats' && calls.filter(call => call.path === '/v1/user/wallet_stats').length === 2)
      throw new GmgnError('GMGN_RATE_LIMITED', clock + 60_000, clock);
    if (path === '/v1/market/rank') return {rank: [{address: currentToken, price: '2', price_change_percent1h: '4'}]};
    if (path === '/v1/market/token_top_traders') return {token_address: query.address,
      list: (reverse ? [6, 5, 4, 3] : [3, 4, 5, 6]).map(n => ({address: addr(n),
        profit: n === 3 ? '100' : '-1.000000000000000001', realized_profit: n === 3 ? '150' : '-4', unrealized_profit: n === 3 ? '-50' : '2.999999999999999999',
        start_holding_at: n === 5 ? epoch / 1000 - 3_600 : epoch / 1000 - 100 - n,
        last_active_timestamp: epoch / 1000 - 1, first_buy_time: epoch / 1000 - 9_000,
        balance: n === 5 ? '0' : '1', end_holding_at: n === 5 ? epoch / 1000 - 2 : null,
        buy_volume_cur: '20', sell_volume_cur: '25', tags: n === 6 ? ['transfer_in'] : []}))};
    if (path === '/v1/token/info') return {address: query.address, price: {price: '2'}};
    if (path === '/v1/market/token_top_holders') return {list: [{address: addr(3), balance: '1', tags: ['smart_degen']}]};
    if (path === '/v1/user/wallet_stats') return {wallet_address: query.wallet_address, realized_profit: '5', winrate: '0.5'};
    if (path === '/v1/user/wallet_activity') return {wallet_address: query.wallet_address, activities: [], next: ''};
    throw new Error('unexpected mock endpoint');
  }};
  return {history: sink, client, calls, observed, marked, now: () => new Date(clock),
    setTime(value: number) {clock = value;}, setReverse() {reverse = true;}, setToken(value: string) {currentToken = value;},
    setThrottle(value: boolean) {throttle = value;}, hold(fn: () => Promise<unknown>) {hold = fn;},
    get checkpoint() {return history ? history.getWalletObserverCursor() : checkpoint;}};
}

test('token samples retain acquisition/activity times and separate total, realized and unrealized PnL with exact rank scope', async () => {
  const history = new WalletHistory(':memory:', {now: () => new Date(epoch)}), f = rig(history);
  try {
    const observer = new WalletObserver({...f, chains: ['bsc']});
    await observer.runOnce();
    const rows = f.observed[0].rows, early = rows.find(row => row.address === addr(5));
    assert.equal(early.firstAcquiredAt, new Date(epoch - 3_600_000).toISOString());
    assert.equal(early.firstBuyAt, undefined); assert.equal(early.lastActiveAt, new Date(epoch - 1_000).toISOString());
    assert.equal(rows[0].profitUsd, '100'); assert.equal(rows[0].realizedProfitUsd, '150'); assert.equal(rows[0].unrealizedProfitUsd, '-50');
    assert.equal(early.realizedProfitUsd, '-4'); assert.equal(early.profitUsd, '-1.000000000000000001');
    assert.equal(early.rankScope, 'vendor_profit_order'); assert.equal(early.sampleLimit, 100);
    const snapshots = history.getWallet('bsc', addr(5))!.tokenTraderSnapshots as any[];
    assert.equal(snapshots[0].lastActiveAt, early.lastActiveAt); assert.equal(snapshots[0].rankScope, 'vendor_profit_order');
    assert.equal(snapshots[0].scope, 'token_cumulative'); assert.equal(history.getWallet('bsc', addr(5))!.wallet.buyEvents, 0);
    assert.equal(observer.getStatus().marketSampling.earliestScope, 'earliest_acquisition_in_sample_not_verified_buy');
  } finally {history.close();}
});

test('one trader page rotates documented sorts and least-checked wallets, including early exited wallets, without extra read weight', async () => {
  const f = rig(), observer = new WalletObserver({...f, chains: ['bsc']});
  const selected: string[] = [], sorts: unknown[] = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    f.calls.length = 0;
    const report = await observer.runOnce();
    assert.equal(report.status, 'ok'); assert.equal(report.requests, 9); assert.equal(f.calls.length, 9);
    assert.equal(f.calls.reduce((sum, call) => sum + (call.weight ?? 0), 0), 31);
    const page = f.calls.filter(call => call.path.endsWith('token_top_traders'));
    assert.equal(page.length, 1); assert.equal(page[0].query.limit, 100); assert.equal(page[0].query.tag, undefined);
    sorts.push(page[0].query.order_by); selected.push(String(f.calls[7].query.wallet_address));
    if (cycle === 1) {assert.equal(f.calls[7].query.token_address, addr(2)); assert.equal(f.calls[7].query.limit, 100);}
    f.setReverse();
  }
  assert.deepEqual(sorts, ['profit', 'unrealized_profit', 'buy_volume_cur', 'sell_volume_cur']);
  assert.equal(selected[0], addr(3)); assert.equal(selected[1], addr(5)); assert.equal(new Set(selected).size, 4);
  assert.equal(f.observed[1].rows[0].rankScope, 'vendor_unrealized_profit_order');
});

test('undocumented first-buy aliases and future activity times cannot manufacture an early acquisition or buy', async () => {
  const f = rig(), original = f.client.get;
  f.client.get = async (path, query, weight) => path.endsWith('token_top_traders') ? {list: [
    {address: addr(3), first_buy_time: epoch / 1000 - 9_000, last_active_timestamp: epoch / 1000 + 1},
    {address: addr(4), start_holding_at: epoch / 1000 + 1, end_holding_at: epoch / 1000 + 2},
    {address: addr(5), start_holding_at: 0, last_active_timestamp: 'not a timestamp'},
    {address: addr(6), start_holding_at: epoch / 1000 - 1, token: {chain: 'sol', address: addr(2)}},
  ]} : original(path, query, weight);
  const report = await new WalletObserver({...f, chains: ['bsc']}).runOnce();
  assert.ok(report.reasons.includes('GMGN_TRADERS_ROWS_INVALID'));
  assert.equal(f.observed[0].rows.length, 3);
  for (const row of f.observed[0].rows) {
    assert.equal(row.firstAcquiredAt, undefined); assert.equal(row.lastActiveAt, undefined);
    assert.equal(row.exitedAt, undefined); assert.equal(row.firstBuyAt, undefined);
  }
});

test('completed cursors survive a real database restart and do not restart wallet research at the profit leader', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-cursor-')), path = join(dir, 'history.sqlite');
  let history = new WalletHistory(path, {now: () => new Date(epoch)});
  try {
    let f = rig(history); await new WalletObserver({...f, chains: ['bsc']}).runOnce();
    assert.equal(history.getWalletObserverCursor()!.cursor, 1); history.close();
    history = new WalletHistory(path, {now: () => new Date(epoch)}); f = rig(history);
    await new WalletObserver({...f, chains: ['bsc']}).runOnce();
    assert.equal(f.calls[1].query.order_by, 'unrealized_profit'); assert.equal(f.calls[7].query.wallet_address, addr(5));
    assert.equal(history.getWalletObserverCursor()!.cursor, 2);
  } finally {history.close(); rmSync(dir, {recursive: true, force: true});}
});

test('rate limiting freezes the unfinished contract and selected wallet, including across restarts and rank changes', async () => {
  const f = rig(); f.setThrottle(true);
  let observer = new WalletObserver({...f, chains: ['bsc']});
  assert.equal((await observer.runOnce()).status, 'cooldown');
  assert.equal(f.checkpoint?.cursor, 1); assert.equal(f.checkpoint?.pending?.[0]?.address, addr(2));
  assert.equal(f.checkpoint?.pending?.[0]?.wallets?.[0], addr(3)); assert.equal(f.marked.length, 0);
  const requests = f.calls.length; await observer.runOnce(); assert.equal(f.calls.length, requests);
  f.setTime(epoch + 61_000); f.setThrottle(false); f.setToken(addr(9)); f.setReverse(); f.calls.length = 0;
  observer = new WalletObserver({...f, chains: ['bsc']});
  assert.equal((await observer.runOnce()).status, 'ok');
  assert.equal(f.calls[1].query.address, addr(2)); assert.equal(f.calls[7].query.wallet_address, addr(3));
  assert.equal(f.checkpoint?.cursor, 2); assert.equal(f.checkpoint?.pending, undefined); assert.equal(f.marked.length, 1);
});

test('association investigation preserves its selected wallet cohort and does not advance a throttled anchor', async () => {
  const f = rig(); let marked = 0;
  f.history.associationTargets = () => [{chain: 'bsc', address: addr(2), anchorWallet: addr(3),
    anchorEventAt: new Date(epoch - 60_000).toISOString(), anchorObservedAt: new Date(epoch).toISOString()}];
  f.history.markAssociationTargetChecked = () => {marked++;}; f.setThrottle(true);
  let observer = new WalletObserver({...f, chains: ['bsc']});
  assert.equal((await observer.runOnce()).status, 'cooldown');
  assert.equal(marked, 0); assert.equal(f.checkpoint?.cursor, 1);
  assert.deepEqual(f.checkpoint?.pending?.[0]?.wallets, [addr(3), addr(5), addr(6)]);
  f.calls.length = 0; f.setTime(epoch + 61_000); f.setThrottle(false); f.setReverse();
  // Even changing the available discovery anchor cannot replace unfinished work.
  f.history.associationTargets = () => [];
  observer = new WalletObserver({...f, chains: ['bsc']});
  const report = await observer.runOnce();
  assert.equal(report.collectionMode, 'kol_association'); assert.equal(report.status, 'ok');
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('wallet_activity')).map(call => call.query.wallet_address), [addr(3), addr(5), addr(6)]);
  assert.equal(marked, 1); assert.equal(f.checkpoint?.cursor, 2);
});

test('a repeatedly failing Robinhood chain retains its unfinished target while BSC and Solana continue fairly after restart', async () => {
  const f = rig(), original = f.client.get;
  let unavailable = true;
  const sol = (value: string) => bs58.encode(new Uint8Array(32).fill(Number(BigInt(value))));
  f.client.get = async (path, query, weight) => {
    if (query.chain === 'robinhood' && path.endsWith('token_top_traders') && unavailable) {
      f.calls.push({path, query, weight}); throw new GmgnError('GMGN_REQUEST_FAILED');
    }
    const raw = await original(path, query, weight);
    if (query.chain !== 'sol') return raw;
    return JSON.parse(JSON.stringify(raw, (_key, value) => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value) ? sol(value) : value));
  };
  let observer = new WalletObserver({...f, chains: ['bsc', 'solana', 'robinhood']});
  const reports = [];
  for (let index = 0; index < 6; index++) {
    if (index === 3) observer = new WalletObserver({...f, chains: ['bsc', 'solana', 'robinhood']});
    reports.push(await observer.runOnce());
  }
  assert.deepEqual(reports.map(row => row.chain), ['bsc', 'solana', 'robinhood', 'bsc', 'solana', 'robinhood']);
  assert.deepEqual(reports.map(row => row.status), ['ok', 'ok', 'partial', 'ok', 'ok', 'partial']);
  assert.equal(f.checkpoint?.pending?.find(row => row.chain === 'robinhood')?.address, addr(2));
  assert.equal(f.checkpoint?.wallets.some(([key]) => key.startsWith('robinhood:')), false);
  assert.equal(f.marked.filter((row: any) => row.chain === 'robinhood').length, 0);
  unavailable = false;
  for (let index = 0; index < 3; index++) await observer.runOnce();
  assert.equal(f.marked.filter((row: any) => row.chain === 'robinhood').length, 1);
  assert.equal(f.checkpoint?.pending, undefined); assert.equal(f.checkpoint?.cursor, 9);
});

test('a malformed full trader page stays unfinished; valid rows on a partially malformed page can complete', async () => {
  for (const entirePage of [true, false]) {
    const f = rig(), original = f.client.get;
    f.client.get = async (path, query, weight) => {
      const raw = await original(path, query, weight) as any;
      return path.endsWith('token_top_traders') ? entirePage ? {unrecognized_list: []} : {...raw, list: [...raw.list, {address: 'invalid'}]} : raw;
    };
    const report = await new WalletObserver({...f, chains: ['bsc']}).runOnce();
    assert.equal(report.status, 'partial');
    assert.equal(f.marked.length, entirePage ? 0 : 1);
    assert.equal(f.checkpoint?.pending?.length ?? 0, entirePage ? 1 : 0);
    assert.equal(f.checkpoint?.wallets.length, entirePage ? 0 : 1);
  }
});

test('stop and failed checkpoint persistence never commit staged cursor advances', async () => {
  const f = rig(); let finish!: (value: unknown) => void;
  f.hold(() => new Promise(resolve => {finish = resolve;}));
  const observer = new WalletObserver({...f, chains: ['bsc']});
  const work = observer.runOnce(), stopping = observer.stop();
  finish({rank: [{address: addr(2)}]}); await stopping; assert.equal((await work).status, 'stopped');
  assert.equal(f.checkpoint, undefined); assert.equal(f.marked.length, 0);
  const failed = rig(); failed.history.setWalletObserverCursor = () => false;
  const result = await new WalletObserver({...failed, chains: ['bsc']}).runOnce();
  assert.ok(result.reasons.includes('WALLET_HISTORY_WRITE_FAILED')); assert.equal(failed.calls.length, 1);
  assert.equal(failed.marked.length, 0); assert.equal(failed.checkpoint, undefined);
});

test('checkpoint schema is bounded, rejects extra payload/invalid scopes, and never changes wallet metrics', () => {
  const history = new WalletHistory(':memory:', {now: () => new Date(epoch)});
  try {
    const input = state(); assert.equal(history.setWalletObserverCursor(input), true);
    assert.deepEqual(history.getWalletObserverCursor(), input);
    for (const invalid of [{...input, version: 2}, {...input, apiKey: 'must not persist'}, {...input, cursor: -1},
      {...input, wallets: [[`bsc:${addr(2)}`, 1], [`bsc:${addr(2)}`, 2]]},
      {...input, walletChecks: Array.from({length: 2_001}, (_, i) => [`bsc:${addr(2)}:${addr(i + 3)}`, 1])},
      {...input, pending: [{chain: 'solana', address: addr(2), kind: 'market'}]},
      {...input, pending: [{chain: 'bsc', address: addr(2), kind: 'market', wallets: ['bad']}]}]) {
      assert.equal(parseWalletObserverCursor(invalid), undefined);
      assert.equal(history.setWalletObserverCursor(invalid as WalletObserverCursorState), false);
    }
    assert.deepEqual(history.getWalletObserverCursor(), input);
    assert.equal(history.stats().wallets, 0); assert.equal(history.stats().events, 0); assert.equal(history.stats().snapshots, 0);
  } finally {history.close();}
});

test('corrupt persisted state is ignored and capacity failure cannot overwrite the last completed cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-cursor-invalid-')), path = join(dir, 'history.sqlite');
  let history = new WalletHistory(path, {now: () => new Date(epoch)});
  try {
    assert.equal(history.setWalletObserverCursor(state()), true); history.close();
    const db = new DatabaseSync(path); db.prepare("UPDATE wh_meta SET value=? WHERE key='wallet_observer_cursor_v1'").run('{bad'); db.close();
    history = new WalletHistory(path, {now: () => new Date(epoch)}); assert.equal(history.getWalletObserverCursor(), undefined);
    assert.equal(history.setWalletObserverCursor(state()), true); history.close();
    history = new WalletHistory(path, {maxBytes: 16_384, now: () => new Date(epoch)});
    assert.equal(history.setWalletObserverCursor({...state(), cursor: 5}), false);
    assert.equal(history.getWalletObserverCursor()?.cursor, 0);
  } finally {history.close(); rmSync(dir, {recursive: true, force: true});}
});
