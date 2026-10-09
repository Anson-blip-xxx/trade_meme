import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {WalletObserver, normalizeWalletFeed, normalizeWalletActivity, type WalletObserverOptions} from '../src/wallet-observer.js';
import {GmgnScanner, type GmgnFeedPage} from '../src/scanner.js';
import {GmgnError} from '../src/providers/gmgn-client.js';
import {WalletHistory} from '../src/wallet-history.js';
import type {Chain} from '../src/types.js';

const nowMs = Date.parse('2026-10-09T01:00:00.000Z'), now = () => new Date(nowMs);
const address = (index: number, chain: Chain = 'bsc') => chain === 'solana'
  ? bs58.encode(new Uint8Array(32).fill(index)) : '0x' + index.toString(16).padStart(40, '0');
const tx = (index: number, chain: Chain = 'bsc') => chain === 'solana'
  ? bs58.encode(new Uint8Array(64).fill(index)) : '0x' + index.toString(16).padStart(64, '0');
const row = (side = 'buy', chain: Chain = 'bsc') => ({chain: chain === 'solana' ? 'sol' : chain,
  maker: address(3, chain), base_address: address(2, chain), transaction_hash: tx(side === 'sell' ? 2 : 1, chain),
  side, timestamp: nowMs / 1000 - 10, token_amount: '9007199254740993.001', amount_usd: '123.45', price_usd: '0.001'});
const page = (list: unknown[], kind: 'kol' | 'smartmoney' = 'kol'): GmgnFeedPage =>
  ({chain: 'bsc', kind, fetchedAt: now().toISOString(), payload: {list}});
function fixture() {
  const trades: any[] = [], ranks: any[] = [], traders: any[] = [], analyses: any[] = [], leaders: any[] = [], collections: any[] = [], prices: any[] = [], marked: any[] = [];
  const targets = ['bsc', 'solana', 'robinhood'].map(chain => ({chain: chain as Chain, address: address(2, chain as Chain)}));
  const history: WalletObserverOptions['history'] = {
    recordTrades: items => {trades.push(...structuredClone(items));},
    captureTokenRanks: (chain, items, meta) => {ranks.push({chain, items, meta});},
    captureTokenTraders: (token, items, meta) => {traders.push({token, items, meta});},
    captureAnalysis: (token, analysis, meta) => {analyses.push({token, analysis, meta});},
    captureLeaders: (chain, items, meta) => {leaders.push({chain, items, meta});},
    recordCollection: item => {collections.push(structuredClone(item));},
    watchTargets: () => targets,
    markTargetChecked: (token, at) => {marked.push({token, at});},
    recordPrice: (token, priceUsd, observedAt, source) => {prices.push({token, priceUsd, observedAt, source});},
    refreshCoordination: () => {},
  };
  return {history, targets, trades, ranks, traders, analyses, leaders, collections, prices, marked};
}
function provider() {
  const calls: {path: string; query: Record<string, string | number>; weight?: number}[] = [];
  let cooldown = 0;
  const client: WalletObserverOptions['client'] = {
    get cooldownUntil() {return cooldown;},
    async get(path, query, weight) {
      calls.push({path, query, weight});
      const chain: Chain = query.chain === 'sol' ? 'solana' : query.chain as Chain;
      const token = address(2, chain), wallet = address(3, chain);
      if (path === '/v1/market/rank') return {rank: [{chain: query.chain, address: token, price: '2', price_change_percent1h: '4.25'}]};
      if (path === '/v1/market/token_top_traders') return {list: [{address: wallet, profit: '50', realized_profit: '30', unrealized_profit: '20', tags: []}]};
      if (path === '/v1/token/info') return {address: token, price: {price: '2'}};
      if (path === '/v1/market/token_top_holders') return {list: [{address: wallet, balance: '1', amount_percentage: '0.01', tags: ['smart_degen']}]};
      if (path === '/v1/user/wallet_stats') return {wallet_address: wallet, realized_profit: '35', total_cost: '100', winrate: '0.75', buy: 2, sell: 1};
      if (path === '/v1/user/wallet_activity') return query.token_address ? {activities: [], next: ''} : {activities: [
        {chain: query.chain, wallet, token: {address: token}, event_type: 'sell', tx_hash: tx(2, chain), timestamp: nowMs / 1000 - 1,
          token_amount: '1.5', cost_usd: '3', price_usd: '2'},
        {chain: query.chain, wallet, token: {address: address(4, chain)}, event_type: 'transferIn', tx_hash: tx(3, chain),
          timestamp: nowMs / 1000 - 2, token_amount: '2', cost_usd: '4', price_usd: '2'},
      ], next: 'next-page-unfetched'};
      throw new Error('unexpected route');
    },
  };
  return {client, calls, setCooldown(value: number) {cooldown = value;}};
}

test('feed normalizer preserves buy and sell events before any research filter and preserves exact decimal amounts', () => {
  const parsed = normalizeWalletFeed(page([row(), row('sell'), {...row(), timestamp: 100}]));
  assert.equal(parsed.trades.length, 3); assert.deepEqual(parsed.trades.map(item => item.side), ['buy', 'sell', 'buy']);
  assert.equal(parsed.trades[0].amount, '9007199254740993.001'); assert.equal(parsed.trades[0].amountUnit, 'vendor_quantity');
  assert.equal(parsed.trades[0].priceUsd, '0.001'); assert.equal(parsed.trades[0].usd, '123.45');
  assert.equal(parsed.trades[2].eventAt, new Date(100_000).toISOString());
  assert.equal(parsed.trades[2].observedAt, now().toISOString()); assert.equal(parsed.hasMore, null);
});

test('wrong chains, mismatched scope, malformed transaction IDs and future timestamps are rejected', () => {
  const invalid = [{...row(), chain: 'sol'}, {...row(), maker: 'unverified'}, {...row(), transaction_hash: '0x123'},
    {...row(), timestamp: nowMs / 1000 + 1}, {...row(), side: ['buy']}, {...row(), maker_info: {address: address(8)}},
    {...row(), base_token: {address: address(8)}}];
  const parsed = normalizeWalletFeed(page(invalid)); assert.equal(parsed.trades.length, 0); assert.equal(parsed.rejected, invalid.length);
  const malformed = normalizeWalletFeed({...page([]), payload: {chain: 'sol', list: [row()]}});
  assert.equal(malformed.invalidReason, 'WALLET_FEED_SCHEMA_INVALID');
  const sol = normalizeWalletFeed({chain: 'solana', kind: 'smartmoney', fetchedAt: now().toISOString(), payload: {list: [row('buy', 'solana')]}});
  assert.equal(sol.trades.length, 1);
});

test('unknown numeric data remains null and input page processing is bounded', () => {
  const parsed = normalizeWalletFeed(page([{...row(), amount_usd: '', token_amount: true, price_usd: 'Infinity'},
    ...Array.from({length: 205}, () => row())]));
  assert.equal(parsed.trades[0].usd, null); assert.equal(parsed.trades[0].amount, null); assert.equal(parsed.trades[0].priceUsd, null);
  assert.equal(parsed.trades.length, 200); assert.equal(parsed.rejected, 6);
  const unsafe = normalizeWalletFeed(page([{...row(), token_amount: Number.MAX_SAFE_INTEGER + 1}]));
  assert.equal(unsafe.trades[0].amount, null);
});

test('feed persistence uses no network requests and records malformed-page coverage honestly', () => {
  const f = fixture(), p = provider(), observer = new WalletObserver({history: f.history, client: p.client, now});
  observer.observeFeed(page([row(), row('sell')])); observer.observeFeed(page([row()], 'smartmoney'));
  assert.equal(f.trades.length, 3); assert.equal(p.calls.length, 0);
  assert.equal(f.trades[2].source, 'gmgn_smartmoney_feed');
  const result = observer.observeFeed({...page([]), payload: {unexpected: []}});
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'WALLET_FEED_SCHEMA_INVALID');
  assert.equal(f.collections.at(-1).status, 'partial'); assert.equal(f.collections[0].coverage, 'one_page_sample');
  f.history.recordTrades = () => {throw new Error('SECRET database path');};
  assert.equal(observer.observeFeed(page([row()])).reason, 'WALLET_HISTORY_WRITE_FAILED');
  assert.equal(JSON.stringify(observer.getStatus()).includes('SECRET'), false);
});

test('scanner observation runs before buy/age/cap filtering and isolates callback mutation or failure', async () => {
  const seen: GmgnFeedPage[] = [], signals: unknown[] = [];
  const raw = {list: [row(), row('sell'), {...row(), transaction_hash: tx(3), timestamp: 100}]};
  const scanner = new GmgnScanner({client: {get: async () => raw}, chains: ['bsc'], intervalMs: 60000, maxAgeSec: 600,
    maxSignalsPerCycle: 1, now, onSignal: signal => {signals.push(signal);}, onFeed: input => {
      seen.push(input); (input.payload as any).list.length = 0; throw new Error('SECRET callback failure');
    }});
  const first = await scanner.runOnce(); const second = await scanner.runOnce();
  assert.equal(seen.length, 4); assert.equal(raw.list.length, 3); assert.equal(signals.length, 1);
  assert.equal(first.emitted, 1); assert.equal(second.emitted, 0);
  assert.ok(first.reasons.includes('GMGN_FEED_OBSERVATION_FAILED')); assert.equal(JSON.stringify(first).includes('SECRET'), false);
});

test('failed scanner pages become durable gap records without additional requests or signals', async () => {
  const f = fixture(); let requests = 0;
  const client = {cooldownUntil: 0, get: async () => {requests++; throw new GmgnError('GMGN_RATE_LIMITED', nowMs + 60000, nowMs);}};
  const observer = new WalletObserver({history: f.history, client, now});
  const scanner = new GmgnScanner({client, chains: ['bsc'], intervalMs: 60000, maxAgeSec: 600, now,
    onSignal: () => {throw new Error('must not emit');}, onFeed: value => observer.observeFeed(value)});
  const report = await scanner.runOnce();
  assert.equal(report.status, 'cooldown'); assert.equal(requests, 1); assert.equal(f.trades.length, 0);
  assert.equal(f.collections[0].status, 'partial'); assert.equal(f.collections[0].reason, 'GMGN_RATE_LIMITED');
});

test('collector stays within nine reads, discovers untagged profitable wallets and separates all snapshot scopes', async () => {
  const f = fixture(), p = provider(), observer = new WalletObserver({history: f.history, client: p.client, now});
  const cycle = await observer.runOnce();
  assert.equal(cycle.requests, 9); assert.equal(p.calls.length, 9); assert.equal(cycle.status, 'ok');
  assert.deepEqual(p.calls[0].query, {chain: 'bsc', interval: '1h', order_by: 'change1h', direction: 'desc', limit: 20});
  assert.equal(p.calls[0].weight, 3); assert.equal(p.calls[1].query.order_by, 'profit'); assert.equal(p.calls[1].query.tag, undefined);
  assert.equal(f.ranks[0].items[0].changeMetric, '4.25'); assert.equal(f.ranks[0].items[0].changeUnit, 'vendor_unspecified');
  assert.equal(f.traders[0].items[0].profitUsd, '50'); assert.equal(f.traders[0].items[0].realizedProfitUsd, '30');
  assert.equal(f.leaders[0].items[0].period, '7d'); assert.equal(f.leaders[0].items[0].realizedProfitUsd, '35');
  assert.equal(f.analyses.length, 1); assert.equal(f.prices[0].source, 'gmgn_token_info_sample');
  assert.deepEqual(f.trades.map(item => item.side), ['sell', 'transferIn']);
  assert.equal(p.calls[7].query.token_address, undefined); assert.equal(f.collections[0].hasMore, true);
  assert.equal(f.marked.length, 1); assert.equal(cycle.coverage, 'one_page_sample');
});

test('cycles fairly rotate BSC, SOL and Robinhood independent of candidate eligibility', async () => {
  const f = fixture(), p = provider(), observer = new WalletObserver({history: f.history, client: p.client, now});
  for (let i = 0; i < 3; i++) await observer.runOnce();
  assert.deepEqual(f.marked.map(item => item.token.chain), ['bsc', 'solana', 'robinhood']);
  assert.deepEqual(p.calls.filter(call => call.path === '/v1/market/rank').map(call => call.query.chain), ['bsc', 'sol', 'robinhood']);
});

test('new gain leaders alternate with old tracked tokens and per-chain lookup cannot be crowded out by BSC', async () => {
  const f = fixture(), p = provider(), original = p.client.get;
  const queriedChains: (Chain | undefined)[] = [];
  f.history.watchTargets = (_limit, _now, chain) => {
    queriedChains.push(chain);
    return [{chain: chain!, address: address(9, chain!)}];
  };
  p.client.get = async (path, query, weight) => {
    if (path === '/v1/market/rank') {
      const chain = query.chain === 'sol' ? 'solana' : query.chain as Chain;
      return {rank: [{address: address(2, chain), price_change_percent1h: '8'}, {address: address(8, chain), price_change_percent1h: '7'}]};
    }
    if (path === '/v1/token/info') return {address: query.address, price: {price: '2'}};
    return original(path, query, weight);
  };
  const observer = new WalletObserver({history: f.history, client: p.client, now});
  for (let i = 0; i < 9; i++) await observer.runOnce();
  assert.deepEqual(queriedChains, ['bsc', 'solana', 'robinhood', 'bsc', 'solana', 'robinhood', 'bsc', 'solana', 'robinhood']);
  assert.deepEqual(p.calls.filter(call => call.path === '/v1/market/token_top_traders').map(call => call.query.address),
    [2, 9, 8].flatMap(index => (['bsc', 'solana', 'robinhood'] as const).map(chain => address(index, chain))));
});

test('global stats accepts documented common wallet identity but rejects contradictory aliases', async () => {
  for (const conflict of [false, true]) {
    const f = fixture(), p = provider(), original = p.client.get;
    p.client.get = async (path, query, weight) => path === '/v1/user/wallet_stats'
      ? {wallet_address: conflict ? address(7) : '', common: {wallet_address: address(3)}, realized_profit: '5', winrate: '0.5'}
      : original(path, query, weight);
    await new WalletObserver({history: f.history, client: p.client, chains: ['bsc'], now}).runOnce();
    assert.equal(f.leaders.length, conflict ? 0 : 1);
  }
});

test('budget exhaustion never sends excess requests even inside analyzeWallets', async () => {
  for (const cap of [1, 3, 4, 6, 8]) {
    const f = fixture(), p = provider();
    const cycle = await new WalletObserver({history: f.history, client: p.client, maxRequestsPerCycle: cap, now}).runOnce();
    assert.equal(p.calls.length, cap); assert.equal(cycle.requests, cap);
    assert.ok(cycle.reasons.includes('WALLET_REQUEST_BUDGET_REACHED'));
  }
});

test('429 and known shared cooldown stop requests immediately and record collection gaps', async () => {
  const f = fixture(), p = provider();
  p.setCooldown(nowMs + 120000);
  const observer = new WalletObserver({history: f.history, client: p.client, now});
  assert.equal((await observer.runOnce()).status, 'cooldown'); assert.equal(p.calls.length, 0);
  assert.equal(f.collections.at(-1).reason, 'GMGN_RATE_LIMITED');
  let count = 0;
  const limited = new WalletObserver({history: f.history, now, client: {cooldownUntil: 0,
    get: async () => {count++; throw new GmgnError('GMGN_RATE_LIMITED', nowMs + 180000, nowMs);}}});
  await limited.runOnce(); await limited.runOnce(); assert.equal(count, 1);
  assert.equal(limited.getStatus().cooldownUntil, new Date(nowMs + 180000).toISOString());
});

test('invalid credentials stop the whole cycle without leaking upstream error text', async () => {
  const f = fixture(); let count = 0;
  const observer = new WalletObserver({history: f.history, now, client: {cooldownUntil: 0,
    get: async () => {count++; throw new GmgnError('GMGN_AUTH_FAILED');}}});
  const cycle = await observer.runOnce(); assert.equal(count, 1); assert.equal(cycle.status, 'partial');
  assert.deepEqual(cycle.reasons, ['GMGN_AUTH_FAILED']);
});

test('coordination cache refresh is bounded and failure still leaves a collection gap record', async () => {
  const f = fixture(), p = provider(); let limit: number | undefined;
  f.history.refreshCoordination = count => {limit = count; throw new Error('SECRET sqlite detail');};
  const report = await new WalletObserver({history: f.history, client: p.client, now}).runOnce();
  assert.equal(limit, 10); assert.equal(report.status, 'partial');
  assert.equal(f.collections.at(-1).reason, 'WALLET_COORDINATION_REFRESH_FAILED');
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
});

test('mismatched trader scope and stats cannot become attributed profit snapshots', async () => {
  const f = fixture(), p = provider(), original = p.client.get;
  p.client.get = async (path, query, weight) => {
    if (path === '/v1/market/token_top_traders') return {token_address: address(9), list: [{address: address(3), profit: '999'}]};
    return original(path, query, weight);
  };
  const cycle = await new WalletObserver({history: f.history, client: p.client, now}).runOnce();
  assert.equal(f.traders.length, 0); assert.equal(f.leaders.length, 0); assert.ok(cycle.reasons.includes('GMGN_TRADERS_SCHEMA_INVALID'));
});

test('malformed ranking rows are reported as partial coverage instead of a valid empty leaderboard', async () => {
  const f = fixture(), p = provider(), original = p.client.get;
  p.client.get = async (path, query, weight) => path === '/v1/market/rank' ? {rank: [{address: 'invalid'}]}
    : path === '/v1/market/token_top_traders' ? {list: [{address: 'invalid'}]} : original(path, query, weight);
  const cycle = await new WalletObserver({history: f.history, client: p.client, now}).runOnce();
  assert.equal(cycle.status, 'partial');
  assert.ok(cycle.reasons.includes('GMGN_RANK_ROWS_INVALID')); assert.ok(cycle.reasons.includes('GMGN_TRADERS_ROWS_INVALID'));
});

test('live rank service second envelope is accepted and supplies the gain discovery target', async () => {
  for (const code of [0, '0']) {
    const f = fixture(), p = provider(), original = p.client.get;
    p.client.get = async (path, query, weight) => path === '/v1/market/rank'
      ? {code, data: {rank: [{chain: 'bsc', address: address(8), price: 0.000012, price_change_percent1h: 4.25}]},
        message: 'vendor message must not be stored', reason: ''}
      : path === '/v1/token/info' ? {address: query.address, price: {price: '0.000012'}} : original(path, query, weight);
    const cycle = await new WalletObserver({history: f.history, client: p.client, chains: ['bsc'], now}).runOnce();
    assert.equal(cycle.reasons.includes('GMGN_RANK_SCHEMA_INVALID'), false);
    assert.equal(f.ranks[0].items[0].address, address(8));
    assert.equal(f.ranks[0].items[0].priceUsd, 0.000012);
    assert.equal(f.ranks[0].items[0].changeMetric, '4.25');
    assert.equal(f.ranks[0].items[0].changeUnit, 'vendor_unspecified');
    assert.equal(p.calls.find(call => call.path === '/v1/market/token_top_traders')!.query.address, address(8));
    assert.equal(JSON.stringify(f.ranks).includes('vendor message'), false);
    assert.equal(p.calls.length <= 9, true);
  }
});

test('rank compatibility does not unwrap failures, missing status, wrong chains, ambiguous or recursive envelopes', async () => {
  const rank = [{chain: 'bsc', address: address(8), price_change_percent1h: 4.25}];
  for (const response of [{code: 1, data: {rank}}, {data: {rank}},
    {code: 1, rank}, {code: 0, chain: 'sol', data: {rank}}, {code: 0, data: {chain: 'sol', rank}},
    {code: 0, rank, data: {rank}}, {code: 0, data: {code: 0, data: {rank}}}, {code: 0, data: rank},
    {code: 0, data: {rank: 'invalid'}}]) {
    const f = fixture(), p = provider(), original = p.client.get;
    p.client.get = async (path, query, weight) => path === '/v1/market/rank' ? response : original(path, query, weight);
    const cycle = await new WalletObserver({history: f.history, client: p.client, chains: ['bsc'], now}).runOnce();
    assert.equal(f.ranks.length, 0); assert.ok(cycle.reasons.includes('GMGN_RANK_SCHEMA_INVALID'));
    assert.equal(p.calls[1].query.address, address(2));
  }
});

test('nested rank rate limit stops the cycle and applies the shared client cooldown', async () => {
  const f = fixture(), p = provider(); let sharedReset: unknown;
  p.client.get = async (path, query, weight) => {
    p.calls.push({path, query, weight});
    return {code: 429, data: {rank: [{address: address(8)}]}, reset_at: nowMs / 1000 + 120};
  };
  p.client.recordRateLimit = (_headers, body) => {sharedReset = body; p.setCooldown(nowMs + 120000);};
  const observer = new WalletObserver({history: f.history, client: p.client, chains: ['bsc'], now});
  const cycle = await observer.runOnce();
  assert.equal(cycle.status, 'cooldown'); assert.equal(p.calls.length, 1); assert.equal(f.ranks.length, 0);
  assert.deepEqual(cycle.reasons, ['GMGN_RATE_LIMITED']); assert.ok(sharedReset);
  await observer.runOnce(); assert.equal(p.calls.length, 1);
});

test('stop waits for in-flight request and rejects late responses; concurrent cycles join one request', async () => {
  const f = fixture(); let done!: (value: unknown) => void;
  const response = new Promise<unknown>(resolve => {done = resolve;}); let count = 0;
  const observer = new WalletObserver({history: f.history, now, client: {cooldownUntil: 0, get: async () => {count++; return response;}}});
  const first = observer.runOnce(), second = observer.runOnce(); assert.equal(first, second); assert.equal(count, 1);
  let stopped = false; const stopping = observer.stop().then(() => {stopped = true;});
  await Promise.resolve(); assert.equal(stopped, false);
  done({rank: [{address: address(2), price: '5'}]}); await stopping;
  assert.equal(f.ranks.length, 0); assert.equal(f.traders.length, 0); assert.equal(count, 1);
  assert.equal(observer.getStatus().lastCycle?.status, 'stopped');
});

test('bounded timer runs autonomously and rejects invalid collector configuration', async () => {
  const f = fixture(), p = provider(); let cycles = 0;
  const original = f.history.recordCollection;
  let complete!: () => void; const twice = new Promise<void>(resolve => {complete = resolve;});
  f.history.recordCollection = value => {original(value); if (value.source === 'gmgn_wallet_observer' && ++cycles === 2) complete();};
  const observer = new WalletObserver({history: f.history, client: p.client, intervalMs: 5, maxRequestsPerCycle: 1, now});
  const guard = setTimeout(complete, 500); observer.start(); await twice; clearTimeout(guard); await observer.stop(); assert.ok(cycles >= 2);
  for (const patch of [{maxRequestsPerCycle: 11}, {intervalMs: 0}, {chains: []}])
    assert.throws(() => new WalletObserver({history: f.history, client: p.client, ...patch}), /WALLET_OBSERVER_CONFIG_INVALID/);
});

function associationFixture() {
  const f = fixture();
  const anchor = {chain: 'bsc' as const, address: address(2), anchorWallet: address(3),
    anchorEventAt: new Date(nowMs - 60_000).toISOString(), anchorObservedAt: now().toISOString()};
  const funding: any[] = [], associationMarked: any[] = [], calls: {path: string; query: Record<string, string | number>}[] = [];
  f.history.associationTargets = () => [anchor];
  f.history.markAssociationTargetChecked = (target, observedAt) => {associationMarked.push({target, observedAt});};
  f.history.captureFunding = (target, wallet, value, context) => {funding.push({target, wallet, value, context});};
  const client: WalletObserverOptions['client'] = {cooldownUntil: 0, async get(path, query) {
    calls.push({path, query});
    if (path === '/v1/market/token_top_traders') return {token_address: address(2), list: [5, 6, 7].map((index, rank) => ({
      address: address(index), balance: '0', profit: '50', realized_profit: '50', unrealized_profit: '0', tags: [],
      start_holding_at: nowMs / 1000 - 500 + rank * 10,
      native_transfer: {address: address(8), amount: '0.3', timestamp: nowMs / 1000 - 600, tx_hash: tx(index + 100)},
    }))};
    if (path === '/v1/token/info') return {address: address(2), price: {price: '2'}};
    if (path === '/v1/user/wallet_activity') return {wallet_address: query.wallet_address, token_address: query.token_address,
      activities: [{token: {address: address(2)}, event_type: 'buy', tx_hash: tx(Number(BigInt(String(query.wallet_address)))),
        timestamp: nowMs / 1000 - 300, token_amount: '1', cost_usd: '0.01', price_usd: '0.01'},
      {token: {address: address(2)}, event_type: 'sell', tx_hash: tx(Number(BigInt(String(query.wallet_address))) + 100),
        timestamp: nowMs / 1000 - 20, token_amount: '1', cost_usd: '1', price_usd: '1'}], next: 'older-pages-not-read'};
    if (path === '/v1/user/wallet_stats') return {wallet_address: query.wallet_address, realized_profit: '1', winrate: '0.5',
      common: {fund_from_address: address(8), fund_from: 'unknown', fund_amount: '0.3', tags: []}};
    if (path === '/v1/market/rank') return {rank: []};
    if (path === '/v1/market/token_top_holders') return {list: []};
    throw new Error('Unexpected route');
  }};
  return {...f, anchor, calls, funding, associationMarked, client};
}

test('KOL investigation uses nine read requests with unfiltered exited traders and real historical buy/sell observations', async () => {
  const f = associationFixture(), observer = new WalletObserver({history: f.history, client: f.client, chains: ['bsc'], now});
  const report = await observer.runOnce();
  assert.equal(report.collectionMode, 'kol_association'); assert.equal(report.status, 'ok');
  assert.equal(report.requests, 9); assert.equal(f.calls.length, 9);
  const traderCalls = f.calls.filter(call => call.path.endsWith('token_top_traders'));
  assert.deepEqual(traderCalls.map(call => call.query.order_by), ['sell_volume_cur', 'buy_volume_cur']);
  assert.ok(traderCalls.every(call => call.query.limit === 100 && call.query.tag === undefined));
  assert.deepEqual(f.traders.map(value => value.meta.source), ['gmgn_association_trader_sell_volume', 'gmgn_association_trader_buy_volume']);
  assert.equal(f.traders[0].items.length, 3); // zero current balance must not discard an earlier trader.
  const activity = f.calls.filter(call => call.path.endsWith('wallet_activity'));
  assert.deepEqual(activity.map(call => call.query.wallet_address), [address(3), address(5), address(6)]);
  assert.ok(activity.every(call => call.query.token_address === address(2) && call.query.limit === 100));
  assert.equal(f.trades.length, 6); assert.ok(f.trades.every(value => value.source === 'gmgn_association_wallet_activity'));
  assert.ok(f.trades.some(value => value.eventAt < f.anchor.anchorEventAt && value.side === 'buy'));
  assert.ok(f.trades.every(value => value.observedAt === now().toISOString()));
  assert.equal(f.associationMarked.length, 1); assert.equal(f.funding.length, 9);
  assert.ok(f.funding.every(value => value.value.address === address(8)));
  assert.ok(f.collections.filter(value => value.source === 'gmgn_association_wallet_activity').every(value => value.hasMore === true));
  assert.equal(observer.getStatus().associationSampling.wholeTokenTradeHistoryAvailable, false);
});

test('association rounds alternate with market research and candidate sampling rotates beyond the first rank', async () => {
  const f = associationFixture(), observer = new WalletObserver({history: f.history, client: f.client, chains: ['bsc'], now});
  assert.equal((await observer.runOnce()).collectionMode, 'kol_association');
  assert.equal((await observer.runOnce()).collectionMode, 'market_wallets');
  f.calls.length = 0;
  assert.equal((await observer.runOnce()).collectionMode, 'kol_association');
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('wallet_activity')).map(call => call.query.wallet_address),
    [address(3), address(7), address(5)]);
});

test('a known earlier-buy candidate gets a research slot even after disappearing from trader rankings', async () => {
  const f = associationFixture(), original = f.client.get;
  f.history.associationTargets = () => [{...f.anchor, candidateWallet: address(9)}];
  f.client.get = async (path, query, weight) => {
    const raw = await original(path, query, weight) as any;
    if (path.endsWith('wallet_activity') && query.wallet_address === address(9)) raw.activities[0].token.address = address(10);
    return raw;
  };
  await new WalletObserver({history: f.history, client: f.client, chains: ['bsc'], now}).runOnce();
  const activity = f.calls.filter(call => call.path.endsWith('wallet_activity'));
  assert.deepEqual(activity.map(call => call.query.wallet_address),
    [address(3), address(9), address(5)]);
  assert.equal(activity[1].query.token_address, undefined);
  assert.equal(activity[0].query.token_address, address(2)); assert.equal(activity[2].query.token_address, address(2));
  assert.ok(f.trades.some(value => value.wallet === address(9) && value.tokenAddress === address(10) &&
    value.source === 'gmgn_association_candidate_activity' && value.side === 'buy'));
});

test('missing or older-than-24h KOL anchors fall back to ordinary research', async () => {
  for (const stale of [false, true]) {
    const f = fixture(), p = provider();
    f.history.associationTargets = () => stale ? [{chain: 'bsc', address: address(2), anchorWallet: address(3),
      anchorEventAt: new Date(nowMs - 86_401_000).toISOString(), anchorObservedAt: now().toISOString()}] : [];
    const cycle = await new WalletObserver({history: f.history, client: p.client, chains: ['bsc'], now}).runOnce();
    assert.equal(cycle.collectionMode, 'market_wallets'); assert.equal(p.calls[0].path, '/v1/market/rank');
  }
});

test('association activity rejects mismatched tokens, identities and future trades, and does not turn transfers into buys', () => {
  const base = {token: {address: address(2)}, event_type: 'buy', tx_hash: tx(1), timestamp: nowMs / 1000 - 100};
  const parsed = normalizeWalletActivity({wallet_address: address(3), activities: [base,
    {...base, token: {address: address(4)}}, {...base, wallet: address(4)}, {...base, timestamp: nowMs / 1000 + 1},
    {...base, event_type: 'transferIn', tx_hash: tx(2)}]}, 'bsc', address(3), now().toISOString(), address(2));
  assert.equal(parsed.rejected, 3); assert.deepEqual(parsed.trades.map(value => value.side), ['buy', 'transferIn']);
  assert.equal(normalizeWalletActivity({wallet_address: address(4), activities: []}, 'bsc', address(3), now().toISOString(), address(2)).invalidReason,
    'WALLET_ACTIVITY_SCHEMA_INVALID');
});

test('association collection obeys lower request budgets and shared cooldown without making extra calls', async () => {
  for (const cap of [1, 3, 6, 8]) {
    const f = associationFixture();
    const report = await new WalletObserver({history: f.history, client: f.client, chains: ['bsc'], maxRequestsPerCycle: cap, now}).runOnce();
    assert.equal(report.requests, cap); assert.equal(f.calls.length, cap);
    assert.ok(report.reasons.includes('WALLET_REQUEST_BUDGET_REACHED'));
  }
  const f = associationFixture(); let count = 0;
  f.client.get = async () => {count++; throw new GmgnError('GMGN_RATE_LIMITED', nowMs + 120000, nowMs);};
  const report = await new WalletObserver({history: f.history, client: f.client, chains: ['bsc'], now}).runOnce();
  assert.equal(report.status, 'cooldown'); assert.equal(count, 1);
});

test('funding from services and contradictory native-transfer aliases is explicitly downgraded', async () => {
  const f = associationFixture(), original = f.client.get;
  f.client.get = async (path, query, weight) => {
    const raw = await original(path, query, weight) as any;
    if (path.endsWith('token_top_traders')) raw.list[0].native_transfer = {
      from_address: address(8), address: address(9), name: 'Binance exchange', amount: '0.1'};
    return raw;
  };
  await new WalletObserver({history: f.history, client: f.client, chains: ['bsc'], now}).runOnce();
  const sample = f.funding.find(value => value.wallet === address(5) && value.context.source === 'gmgn_association_trader_funding');
  assert.equal(sample.value.sharedService, true); assert.equal(sample.value.conflict, true);
  assert.equal(sample.value.txHash, null); assert.equal(sample.value.timestamp, null);
});

test('collector feeds durable association evidence without treating retrospective discovery as foresight', async () => {
  const history = new WalletHistory(':memory:', {now}), f = associationFixture(), original = f.client.get;
  try {
    f.client.get = async (path, query, weight) => {
      const raw = await original(path, query, weight) as any;
      if (path.endsWith('wallet_activity') && query.wallet_address === address(3)) raw.activities[0].timestamp = nowMs / 1000 - 60;
      return raw;
    };
    const observer = new WalletObserver({history, client: f.client, chains: ['bsc'], now});
    observer.observeFeed(page([{...row(), transaction_hash: tx(3), timestamp: nowMs / 1000 - 60}]));
    assert.equal((await observer.runOnce()).collectionMode, 'kol_association');
    history.refreshAssociations(3);
    const result = history.listAssociations();
    assert.equal(result.total, 2);
    assert.ok(result.items.every(value => value.retrospectiveTokens === 1 && value.forwardValidatedTokens === 0 && value.prospectiveTokens === 0));
    assert.ok(result.items.every(value => value.ownership === 'unknown' && value.fundingKinds.includes('common')));
    const detail = history.getAssociation('bsc', address(3), address(5));
    assert.equal(detail?.episodes[0].leadSeconds, 240);
    assert.equal(detail?.episodes[0].candidateBuy.source, 'gmgn_association_wallet_activity');
    assert.equal(detail?.episodes[0].candidateBuy.observedAt, now().toISOString());
    assert.equal(detail?.episodes[0].candidateSellAfterLeader?.wallet, address(5));
  } finally {history.close();}
});

test('known-candidate whole-wallet observation can validate a later new-token KOL entry without mixing contract addresses', async () => {
  let clock = nowMs;
  const history = new WalletHistory(':memory:', {now: () => new Date(clock)}), f = associationFixture(), original = f.client.get;
  const stamp = (offset: number) => new Date(nowMs + offset).toISOString();
  try {
    // This first episode was learned retrospectively, before the next token existed in our history.
    history.recordTrades([
      {chain: 'bsc', wallet: address(3), tokenAddress: address(2), txHash: tx(300), side: 'buy', eventAt: stamp(-60_000),
        observedAt: stamp(0), source: 'gmgn_kol_feed'},
      {chain: 'bsc', wallet: address(9), tokenAddress: address(2), txHash: tx(900), side: 'buy', eventAt: stamp(-300_000),
        observedAt: stamp(0), source: 'gmgn_association_wallet_activity'},
    ]);
    history.refreshAssociations(3);
    assert.equal(history.getAssociation('bsc', address(3), address(9))?.association.forwardValidatedTokens, 0);
    clock += 60_000;
    f.client.get = async (path, query, weight) => {
      const raw = await original(path, query, weight) as any;
      if (path.endsWith('wallet_activity') && query.wallet_address === address(9)) raw.activities = [
        {token: {address: address(10)}, event_type: 'buy', tx_hash: tx(901), timestamp: nowMs / 1000 + 30,
          token_amount: '1', cost_usd: '0.01', price_usd: '0.01'},
      ];
      if (path.endsWith('wallet_activity') && query.wallet_address === address(3)) raw.activities[0].timestamp = nowMs / 1000 - 60;
      return raw;
    };
    const observer = new WalletObserver({history, client: f.client, chains: ['bsc'], now: () => new Date(clock)});
    await observer.runOnce(); history.refreshAssociations(3);
    const before = history.getAssociation('bsc', address(3), address(9));
    assert.equal(before?.episodes.length, 1); assert.equal(before?.episodes[0].tokenAddress, address(2));
    assert.ok(history.getWallet('bsc', address(9))?.timeline.some(event => event.tokenAddress === address(10) &&
      event.observedAt === stamp(60_000) && event.eventAt === stamp(30_000)));
    clock = nowMs + 121_000;
    observer.observeFeed({chain: 'bsc', kind: 'kol', fetchedAt: stamp(121_000), payload: {list: [
      {...row(), base_address: address(10), transaction_hash: tx(301), timestamp: nowMs / 1000 + 120},
    ]}});
    history.refreshAssociations(3);
    const after = history.getAssociation('bsc', address(3), address(9));
    const newEpisode = after?.episodes.find(episode => episode.tokenAddress === address(10));
    assert.equal(after?.association.distinctTokens, 2); assert.equal(after?.association.forwardValidatedTokens, 1);
    assert.equal(newEpisode?.observationMode, 'prospective'); assert.equal(newEpisode?.forwardValidated, true);
    assert.equal(newEpisode?.leadSeconds, 90); assert.equal(newEpisode?.candidateBuy.observedAt, stamp(60_000));
    assert.equal(newEpisode?.candidateBuy.source, 'gmgn_association_candidate_activity');
  } finally {history.close();}
});

test('known relationships continue after the 24h anchor window using current whole-wallet reads', async () => {
  const f = associationFixture(), original = f.client.get;
  const historical = {...f.anchor, anchorEventAt: new Date(nowMs - 172_800_000).toISOString(),
    candidateWallet: address(9), historicalRelationship: true};
  f.history.associationTargets = () => [historical];
  f.client.get = async (path, query, weight) => {
    const raw = await original(path, query, weight) as any;
    if (path.endsWith('wallet_activity')) raw.activities[0].token.address = address(10);
    return raw;
  };
  const observer = new WalletObserver({history: f.history, client: f.client, chains: ['bsc'], now});
  const report = await observer.runOnce();
  assert.equal(report.collectionMode, 'kol_association'); assert.equal(report.status, 'ok');
  assert.equal(report.requests, 4); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('wallet_activity')).map(call => call.query.wallet_address),
    [address(9), address(3)]);
  assert.ok(f.calls.every(call => call.query.token_address === undefined));
  assert.ok(f.trades.some(value => value.wallet === address(9) && value.tokenAddress === address(10) &&
    value.source === 'gmgn_association_candidate_activity'));
  assert.ok(f.trades.some(value => value.wallet === address(3) && value.tokenAddress === address(10) &&
    value.source === 'gmgn_association_leader_activity'));
  assert.equal(f.associationMarked[0].target.historicalRelationship, true);
  assert.equal(f.associationMarked[0].target.candidateWallet, address(9));
});

test('old ordinary anchors and malformed historical relationships never bypass anchor validation', async () => {
  for (const patch of [{}, {historicalRelationship: true}, {historicalRelationship: true, candidateWallet: 'invalid'},
    {historicalRelationship: true, candidateWallet: address(3)}, {historicalRelationship: true, candidateWallet: address(9),
      anchorEventAt: new Date(nowMs + 1_000).toISOString()}]) {
    const f = fixture(), p = provider();
    f.history.associationTargets = () => [{chain: 'bsc', address: address(2), anchorWallet: address(3),
      anchorEventAt: new Date(nowMs - 172_800_000).toISOString(), anchorObservedAt: now().toISOString(), ...patch}];
    const cycle = await new WalletObserver({history: f.history, client: p.client, chains: ['bsc'], now}).runOnce();
    assert.equal(cycle.collectionMode, 'market_wallets'); assert.equal(p.calls[0].path, '/v1/market/rank');
  }
});

test('every third association round prioritizes known relationships and falls back to recent targets when none exist', async () => {
  for (const hasKnown of [true, false]) {
    const f = associationFixture(), modes: string[] = [];
    f.history.associationTargets = (_chain, _limit, mode = 'recent') => {
      modes.push(mode);
      return mode === 'known' ? hasKnown ? [{...f.anchor, historicalRelationship: true, candidateWallet: address(9)}] : [] : [f.anchor];
    };
    const observer = new WalletObserver({history: f.history, client: f.client, chains: ['bsc'], now});
    const reports = [];
    for (let index = 0; index < 5; index++) reports.push(await observer.runOnce());
    assert.deepEqual(reports.map(report => report.collectionMode), ['kol_association', 'market_wallets', 'kol_association', 'market_wallets', 'kol_association']);
    assert.deepEqual(modes, hasKnown ? ['recent', 'recent', 'known'] : ['recent', 'recent', 'known', 'recent']);
    assert.equal(reports[4].requests, hasKnown ? 4 : 9);
    assert.ok(reports.every(report => report.requests <= 9));
  }
});
