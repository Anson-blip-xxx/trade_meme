import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bs58 from 'bs58';
import {readConfig, type Config} from '../src/config.js';
import {EntryController} from '../src/entry.js';
import {OrderStore} from '../src/orders.js';
import {OrderReconciler} from '../src/reconcile.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import {parseExitPolicy} from '../src/exit-policy.js';
import type {Chain, Report} from '../src/types.js';
import {signal, token, pass, narrative, now} from './helpers.js';

const keyPair = generateKeyPairSync('ed25519');
const syntheticPem = keyPair.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
const policy = () => parseExitPolicy({enabled: true, sellRatioType: 'hold_amount',
  takeProfit: [{gainPct: 500, sellPct: 20}, {gainPct: 1000, sellPct: 10}], stopLoss: {dropPct: 40, sellPct: 100}})!;
const expectedConditions = [
  {order_type: 'profit_stop', side: 'sell', price_scale: '500', sell_ratio: '20'},
  {order_type: 'profit_stop', side: 'sell', price_scale: '1000', sell_ratio: '10'},
  {order_type: 'loss_stop', side: 'sell', price_scale: '40', sell_ratio: '100'},
];
const evmWallet = `0x${'2'.repeat(40)}`, zero = `0x${'0'.repeat(40)}`;
const evmHash = `0x${'a'.repeat(64)}`, blockHash = `0x${'b'.repeat(64)}`;
function identity(chain: Chain) {
  return chain === 'solana' ? {
    wallet: bs58.encode(new Uint8Array(32).fill(1)), token: bs58.encode(new Uint8Array(32).fill(2)),
    spend: 'So11111111111111111111111111111111111111112', hash: bs58.encode(new Uint8Array(64).fill(3)),
  } : {wallet: evmWallet, token, spend: zero, hash: evmHash};
}
function candidate(chain: Chain = 'bsc', event = 'exit-event'): Report {
  return {id: randomUUID(), policyVersion: 'exit-integration-test', mode: 'live',
    signal: signal({sourceEventId: event, token: {chain, address: identity(chain).token}}),
    receivedAt: now.toISOString(), evaluatedAt: now.toISOString(), validUntil: new Date(now.getTime() + 60_000).toISOString(),
    decision: 'BUY_CANDIDATE', buyEligible: true, executionEnabled: false, reasons: [],
    provenance: {...pass(), platform: 'flap'}, safety: pass(), narrative: narrative(), flow: pass()};
}
function execution(chain: Chain = 'bsc'): Record<string, unknown> {
  const item = identity(chain);
  return {order_id: 'opening-1', strategy_order_id: 'strategy-1', status: 'successful', state: 30, hash: item.hash,
    report: {input_token: item.spend, output_token: item.token, input_amount: '100000', output_amount: '1000000'}};
}
function strategyRow(chain: Chain = 'bsc'): Record<string, unknown> {
  const item = identity(chain);
  return {order_id: 'strategy-1', chain: chain === 'solana' ? 'sol' : chain,
    wallet_address: item.wallet, base_token: item.token, quote_token: item.spend,
    open_sign_hash: item.hash, status: 'closed', strategy_status: 'stopped',
    order_type: 'smart_trade', sub_order_type: 'mix_trade', sell_ratio_type: 'hold_amount',
    condition_orders: expectedConditions.map((condition, index) => ({...condition, cid: `condition-${index}`,
      status: index === 2 ? 'success' : 'cancel'}))};
}
type Captured = {url: URL; init?: RequestInit};
type TestCleanup = {after: (fn: () => void) => void};
function setup(t: TestCleanup, options: {
  chain?: Chain; config?: Partial<Config>; path?: string;
  swap?: () => unknown; query?: () => unknown; strategies?: (url: URL) => unknown;
  rpc?: (method: string) => unknown; rpcFails?: boolean;
} = {}) {
  const chain = options.chain ?? 'bsc', item = identity(chain);
  const config: Config = {...readConfig({}), entryBalanceBps: {}, entryMode: 'live', gmgnApiKey: `exit-test-${randomUUID()}`,
    gmgnPrivateKey: syntheticPem, gmgnMinIntervalMs: 0, exitPolicy: policy(),
    entryWallets: {[chain]: item.wallet}, entryInputTokens: {[chain]: item.spend}, entryAmounts: {[chain]: '100000'},
    rpc: {[chain]: `https://${chain}.invalid/rpc`}, ...options.config};
  const readCalls: Captured[] = [], signedCalls: Captured[] = [], rpcCalls: {method: string; params: unknown[]}[] = [];
  const client = new GmgnClient({apiKey: config.gmgnApiKey, minIntervalMs: 0, now: () => now.getTime(),
    fetcher: async (input, init) => {
      const url = new URL(String(input)); readCalls.push({url, init});
      assert.equal(url.pathname, '/v1/trade/quote');
      return Response.json({code: 0, data: {input_token: item.spend, output_token: url.searchParams.get('output_token'),
        input_amount: '100000', output_amount: '1000000', min_output_amount: '950000', slippage: 5}});
    }});
  const rpcResults: Record<string, unknown> = {
    eth_chainId: chain === 'robinhood' ? '0x1237' : '0x38',
    eth_getTransactionReceipt: {status: '0x1', transactionHash: item.hash, blockNumber: '0x64', blockHash},
    eth_blockNumber: '0x80', eth_getBlockByNumber: {number: '0x64', hash: blockHash}, eth_call: `0x${'0'.repeat(64)}`,
    getGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    getSignatureStatuses: {context: {slot: 110}, value: [{slot: 100, err: null, confirmationStatus: 'finalized', status: {Ok: null}}]},
    getTokenAccountsByOwner: {context: {slot: 110}, value: []},
  };
  const store = new OrderStore(options.path ?? ':memory:');
  let closed = false;
  const close = () => {if (!closed) {store.close(); closed = true;}};
  t.after(close);
  const controller = new EntryController(config, store, client, {now: () => now,
    // This test-only provider does not authenticate real autonomous execution.
    liveProtection: context => ({status:'verified',scope:'autonomous_exit_execution',chain:context.chain,wallet:context.wallet,
      checkedAt:now.toISOString(),validUntil:new Date(now.getTime()+30_000).toISOString()}),
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== 'openapi.gmgn.ai') {
        assert.equal(url.href, config.rpc[chain]);
        const request = JSON.parse(String(init?.body)); rpcCalls.push(request);
        assert.equal(new Headers(init?.headers).has('x-apikey'), false);
        assert.equal(new Headers(init?.headers).has('x-signature'), false);
        if (options.rpcFails) throw new Error('SYNTHETIC_RPC_SECRET');
        assert.ok(Object.hasOwn(rpcResults, request.method));
        return Response.json({jsonrpc: '2.0', id: request.id,
          result: options.rpc ? await options.rpc(request.method) : rpcResults[request.method]});
      }
      signedCalls.push({url, init});
      if (url.pathname === '/v1/trade/swap') {
        assert.equal(init?.method, 'POST');
        return Response.json({code: 0, data: options.swap ? options.swap() : execution(chain)});
      }
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      if (url.pathname === '/v1/trade/query_order')
        return Response.json({code: 0, data: options.query ? options.query() : execution(chain)});
      assert.equal(url.pathname, '/v1/trade/strategy/orders');
      return Response.json({code: 0, data: options.strategies ? await options.strategies(url) : {list: [strategyRow(chain)]}});
    }});
  return {config, store, controller, close, readCalls, signedCalls, rpcCalls, rpcResults};
}

test('live swap sends exactly the authorized hold_amount exits and chain-specific fee units', async t => {
  for (const chain of ['bsc', 'solana', 'robinhood'] as const) {
    const ctx = setup(t, {chain, config: {entryGasPriceBsc: '75000000', entryPriorityFeeSolana: '0.00002', entryTipFeeSolana: '0.00003'}});
    const result = await ctx.controller.consider(candidate(chain));
    assert.equal(result.order?.status, 'confirmed');
    const body = JSON.parse(String(ctx.signedCalls[0].init?.body));
    assert.deepEqual(body.condition_orders, expectedConditions);
    assert.equal(body.sell_ratio_type, 'hold_amount');
    assert.equal(body.gas_price, chain === 'bsc' ? '75000000' : undefined);
    assert.equal(body.priority_fee, chain === 'solana' ? '0.00002' : undefined);
    assert.equal(body.tip_fee, chain === 'solana' ? '0.00003' : undefined);
    assert.equal(body.chain, chain === 'solana' ? 'sol' : chain);
    assert.equal(result.order?.exit?.strategyOrderId, 'strategy-1');
    assert.equal(result.order?.exit?.state, 'unverified');
    assert.equal(result.order?.exit?.positionClosed, false);
    assert.equal(ctx.rpcCalls.length, 0);
  }
});

test('signal text and vendor material cannot override owner exits, ratio basis or fees', async t => {
  const ctx = setup(t);
  const report = candidate();
  const malicious = {condition_orders: [{order_type: 'profit_stop', side: 'buy', price_scale: '1', sell_ratio: '100'}],
    sell_ratio_type: 'buy_amount', gas_price: '1000000000000000', priority_fee: '99', tip_fee: '99'};
  report.signal.text = JSON.stringify(malicious);
  report.safety.facts = malicious;
  report.narrative.facts = malicious;
  report.gmgn = {token: report.signal.token, fetchedAt: now.toISOString(), diagnostics: [], info: malicious};
  const result = await ctx.controller.consider(report);
  assert.equal(result.order?.status, 'confirmed');
  const body = JSON.parse(String(ctx.signedCalls[0].init?.body));
  assert.deepEqual(body.condition_orders, expectedConditions);
  assert.equal(body.sell_ratio_type, 'hold_amount');
  assert.equal(body.gas_price, '50000000');
  assert.equal(body.priority_fee, undefined);
  assert.equal(body.tip_fee, undefined);
  assert.deepEqual(result.order?.exit?.policy, policy());
});

test('paper exits persist only the requested policy and never sign, submit, poll or claim protection', async t => {
  const ctx = setup(t, {config: {entryMode: 'paper', gmgnPrivateKey: undefined}});
  const result = await ctx.controller.consider(candidate());
  assert.equal(result.order?.status, 'paper_open');
  assert.equal(result.order?.exit?.state, 'paper');
  assert.equal(result.order?.exit?.strategyOrderId, undefined);
  assert.equal(result.order?.exit?.positionClosed, false);
  await ctx.controller.reconcile(result.order!.id);
  assert.equal(ctx.readCalls.length, 1);
  assert.equal(ctx.signedCalls.length, 0);
  assert.equal(ctx.rpcCalls.length, 0);
  assert.equal(ctx.store.pending().length, 0);
});

test('buy confirmation remains independent of strategy acknowledgement or a missing strategy ID', async t => {
  for (const strategyId of ['strategy-1', undefined, 'invalid/strategy']) {
    const ctx = setup(t, {swap: () => ({...execution(), strategy_order_id: strategyId}),
      query: () => ({...execution(), strategy_order_id: strategyId})});
    const result = await ctx.controller.consider(candidate());
    assert.equal(result.order?.status, 'confirmed');
    assert.equal(result.order?.outputAmount, '1000000');
    assert.equal(result.order?.exit?.positionClosed, false);
    assert.notEqual(result.order?.exit?.state, 'monitoring');
    assert.equal(ctx.store.pending().length, 1);
    if (strategyId !== 'strategy-1') {
      const reconciled = await ctx.controller.reconcile(result.order!.id);
      assert.equal(reconciled.order?.status, 'confirmed');
      assert.equal(reconciled.order?.exit?.state, 'attention');
      assert.deepEqual(reconciled.order?.exit?.reasons, ['EXIT_STRATEGY_ID_MISSING']);
      assert.equal(ctx.signedCalls.filter(call => call.url.pathname === '/v1/trade/swap').length, 1);
      assert.equal(ctx.signedCalls.some(call => call.url.pathname === '/v1/trade/strategy/orders'), false);
    }
  }
});

test('reconcile discovers the strategy through GET only and follows pagination while entry is off', async t => {
  const ctx = setup(t, {swap: () => ({order_id: 'opening-1', status: 'pending'}),
    strategies: url => url.searchParams.get('type') === 'history'
      ? {list: [strategyRow()]} : {list: [], next_page_token: url.searchParams.has('page_token') ? '' : 'next-page'}});
  const created = await ctx.controller.consider(candidate());
  ctx.config.entryMode = 'off';
  const result = await ctx.controller.reconcile(created.order!.id);
  assert.equal(result.order?.status, 'confirmed');
  assert.equal(result.order?.exit?.positionClosed, true);
  assert.deepEqual(ctx.signedCalls.map(call => [call.url.pathname, call.init?.method]), [
    ['/v1/trade/swap', 'POST'], ['/v1/trade/query_order', 'GET'],
    ['/v1/trade/strategy/orders', 'GET'], ['/v1/trade/strategy/orders', 'GET'], ['/v1/trade/strategy/orders', 'GET'],
  ]);
  assert.equal(ctx.signedCalls[3].url.searchParams.get('page_token'), 'next-page');
  assert.equal(ctx.signedCalls[4].url.searchParams.get('type'), 'history');
  assert.ok(ctx.rpcCalls.some(call => call.method === 'eth_call'));
});

test('missing, mismatched, malformed and unknown strategy data cannot close even a zero-balance position', async t => {
  const terminal = strategyRow();
  const conditions = terminal.condition_orders as Record<string, unknown>[];
  for (const payload of [null, {}, [], {list: []}, {list: [{...terminal, order_id: 'wrong-id'}]},
    {list: [{...terminal, wallet_address: `0x${'3'.repeat(40)}`}]}, {list: [{...terminal, chain: 'sol'}]},
    {list: [{...terminal, open_sign_hash: `0x${'c'.repeat(64)}`}]},
    {list: [{...terminal, condition_orders: conditions.slice(0, 2)}]},
    {list: [{...terminal, condition_orders: conditions.map(row => ({...row, status: 'pending'}))}]},
    {list: [{...terminal, status: 'open', strategy_status: 'running'}]},
    {list: [{...terminal, condition_orders: [conditions[0], conditions[0], conditions[2]]}]}]) {
    const ctx = setup(t, {strategies: () => payload});
    const created = await ctx.controller.consider(candidate());
    const result = await ctx.controller.reconcile(created.order!.id);
    assert.equal(result.order?.status, 'confirmed');
    assert.equal(result.order?.exit?.positionClosed, false);
    assert.notEqual(result.order?.exit?.state, 'closed');
    assert.equal(ctx.store.pending().length, 1);
  }
});

test('three terminal conditions plus verified zero balance close the position but never release permanent token identity', async t => {
  for (const chain of ['bsc', 'solana', 'robinhood'] as const) {
    const ctx = setup(t, {chain, config: {entryMaxOpen: 1}});
    const original = candidate(chain);
    original.signal.source='gmgn';
    const created = await ctx.controller.consider(original);
    const result = await ctx.controller.reconcile(created.order!.id);
    assert.equal(result.order?.exit?.state, 'closed');
    assert.equal(result.order?.exit?.positionClosed, true);
    assert.equal(result.order?.exit?.balance?.status, 'verified');
    assert.equal(result.order?.exit?.balance?.amount, '0');
    assert.equal(result.order?.status, 'confirmed');
    assert.equal(ctx.store.pending().length, 0);
    const replay = await ctx.controller.consider(original);
    assert.equal(replay.status, 'existing');
    assert.equal(replay.order?.id, created.order!.id);
    const nextReport=candidate(chain,'new-event');nextReport.signal.source='gmgn';
    const next = await ctx.controller.consider(nextReport);
    assert.equal(next.status, 'blocked');
    assert.equal(next.reason, 'ASSET_REENTRY_BLOCKED');
    assert.equal(ctx.signedCalls.filter(call => call.url.pathname === '/v1/trade/swap').length, 1);
  }
});

test('terminal strategy with nonzero, unavailable or unfinalized chain balance retains its position', async t => {
  for (const mode of ['nonzero', 'unavailable', 'unfinalized'] as const) {
    const ctx = setup(t, {rpcFails: mode === 'unavailable'});
    if (mode === 'nonzero') ctx.rpcResults.eth_call = `0x${'0'.repeat(63)}1`;
    if (mode === 'unfinalized') ctx.rpcResults.eth_blockNumber = '0x64';
    const created = await ctx.controller.consider(candidate());
    const result = await ctx.controller.reconcile(created.order!.id);
    assert.equal(result.order?.exit?.assessment?.terminal, true);
    assert.equal(result.order?.exit?.positionClosed, false);
    assert.equal(result.order?.exit?.state, 'attention');
    assert.equal((await ctx.controller.consider(candidate('bsc', 'different-event'))).reason, 'ASSET_ALREADY_OPEN');
    assert.equal(JSON.stringify(ctx.store.list()).includes('SYNTHETIC_RPC_SECRET'), false);
  }
});

test('unverified exit protection blocks another live asset before quote or submission', async t => {
  const ctx = setup(t);
  await ctx.controller.consider(candidate());
  const another = candidate('bsc', 'other-asset'); another.signal.token.address = `0x${'3'.repeat(40)}`;
  const result = await ctx.controller.consider(another);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'EXIT_PROTECTION_UNVERIFIED');
  assert.equal(ctx.readCalls.length, 1);
  assert.equal(ctx.signedCalls.filter(call => call.url.pathname === '/v1/trade/swap').length, 1);
});

test('disabling current exits cannot bypass an existing unverified exit position', async t => {
  const ctx = setup(t);
  await ctx.controller.consider(candidate());
  ctx.config.exitPolicy = undefined;
  const another = candidate('bsc', 'disabled-exits-other-asset');
  another.signal.token.address = `0x${'3'.repeat(40)}`;
  const result = await ctx.controller.consider(another);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'EXIT_PROTECTION_UNVERIFIED');
  assert.equal(ctx.readCalls.length, 1);
  assert.equal(ctx.signedCalls.filter(call => call.url.pathname === '/v1/trade/swap').length, 1);
});

test('stale, future or invalid monitoring evidence cannot authorize another opening', async t => {
  const fresh = now.toISOString(), stale = new Date(now.getTime() - 90_001).toISOString();
  const future=new Date(now.getTime()+5_001).toISOString();
  for (const [checkedAt, evidenceCheckedAt] of [[stale, fresh], [fresh, stale], [future,fresh], [fresh,future], ['invalid',fresh], [fresh,'invalid']]) {
    const ctx = setup(t);
    const created = await ctx.controller.consider(candidate());
    const snapshot = created.order!.exit!;
    // Seed a persisted protection claim to exercise expiry independently of which
    // active child-status enums the upstream parser can currently verify.
    ctx.store.updateExit(created.order!.id, snapshot, {...snapshot, state: 'monitoring', checkedAt,
      assessment: {status: 'verified', reasons: [], found: true, policyMatched: true, hasLiveStop: true,
        terminal: false, conditions: [], checkedAt: evidenceCheckedAt}}, now);
    const another = candidate('bsc', 'stale-protection-other-asset');
    another.signal.token.address = `0x${'3'.repeat(40)}`;
    const result = await ctx.controller.consider(another);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'EXIT_PROTECTION_UNVERIFIED');
    assert.equal(ctx.readCalls.length, 1);
    assert.equal(ctx.signedCalls.filter(call => call.init?.method === 'POST').length, 1);
  }
});

test('a delayed older observation cannot reopen a position closed by another reconciliation', {timeout: 5000}, async t => {
  let release!: () => void, entered!: () => void, firstRpc = true, strategyReads = 0;
  const rpcGate = new Promise<void>(resolve => {release = resolve;});
  const rpcEntered = new Promise<void>(resolve => {entered = resolve;});
  const ctx = setup(t, {
    strategies: () => ({list: [++strategyReads === 1
      ? {...strategyRow(), status: 'open', strategy_status: 'running'} : strategyRow()]}),
    rpc: async method => {
      if (firstRpc) {firstRpc = false; entered(); await rpcGate;}
      return ctx.rpcResults[method];
    },
  });
  const created = await ctx.controller.consider(candidate());
  const delayed = ctx.controller.reconcile(created.order!.id);
  await rpcEntered;
  const newer = await ctx.controller.reconcile(created.order!.id);
  assert.equal(newer.order?.exit?.state, 'closed');
  assert.equal(newer.order?.exit?.positionClosed, true);
  const proof = ctx.store.get(created.order!.id);
  release();
  const staleResult = await delayed;
  assert.deepEqual(staleResult.order, proof);
  assert.deepEqual(ctx.store.get(created.order!.id), proof);
  assert.equal(ctx.store.pending().length, 0);
  assert.equal(ctx.signedCalls.filter(call => call.init?.method === 'POST').length, 1);
});

test('restart keeps confirmed exits pending and reconciles saved policy even when current exits are disabled', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-entry-exits-'));
  const path = join(directory, 'orders.sqlite');
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const first = setup(t, {path});
  const created = await first.controller.consider(candidate());
  first.close();
  const restarted = setup(t, {path, config: {entryMode: 'off', exitPolicy: undefined}});
  assert.deepEqual(restarted.store.pending().map(order => order.id), [created.order!.id]);
  assert.deepEqual(restarted.store.get(created.order!.id)?.exit?.policy, policy());
  const reconciler = new OrderReconciler(restarted.store, restarted.controller);
  await reconciler.runOnce();
  await reconciler.stop();
  assert.equal(restarted.store.get(created.order!.id)?.exit?.positionClosed, true);
  assert.equal(restarted.store.pending().length, 0);
  assert.equal(restarted.readCalls.length, 0);
  assert.ok(restarted.signedCalls.every(call => call.init?.method === 'GET'));
  restarted.close();
});
