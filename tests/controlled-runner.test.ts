import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {ControlledTradeRunner, newTestRun, TEST_AMOUNT, TEST_CONDITIONS, TEST_INPUT, TEST_MAX_DEBIT} from '../src/controlled-test/runner.js';
import {ControlledTestJournal} from '../src/controlled-test/journal.js';
import type {SolanaSnapshot, TestChainReader, TestNotifier, TestTradeClient, VerifiedSolanaTransaction} from '../src/controlled-test/types.js';

const wallet = bs58.encode(new Uint8Array(32).fill(10));
const buySignature = bs58.encode(new Uint8Array(64).fill(11));
const sellSignature = bs58.encode(new Uint8Array(64).fill(12));
const qty = '500000000';
interface Options {
  buyUnknown?: boolean; sellUnknown?: boolean; cancelUnknown?: boolean;
  notificationFailure?: 'start' | 'after_buy';
  initialBalance?: string; postCancelBalance?: string;
  mintAuthority?: string | null; existingStrategy?: boolean;
  badBuyQuote?: boolean; reverseQuoteUnavailable?: boolean;
  cancelChildren?: 'missing' | 'duplicate' | 'success' | 'changed';
  cancelCount?: number; buyOrderMismatch?: boolean; badFillMint?: boolean;
  queryErrorOnce?: boolean; cancellationNeverVisible?: boolean;
  initialPolicyMismatch?: boolean; buyNativeDelta?: string; buyTokenDelta?: string;
  queryOmitsStrategyId?: boolean;
}
function fixture(options: Options = {}) {
  const journal = new ControlledTestJournal(':memory:');
  const run = newTestRun(wallet); journal.create(run);
  const writes: {key: 'buy' | 'sell' | 'cancel'; body: Record<string, unknown>; clientId: string}[] = [];
  const notifications: {key: string; text: string}[] = [];
  const queries: string[] = [];
  let bought = false, sold = false, canceled = false, queryErrors = 0;
  const snapshot = (): SolanaSnapshot => ({wallet, mint: run.mint,
    nativeLamports: sold ? '999950000' : bought ? '989975000' : '1000000000',
    tokenAmount: sold ? '0' : bought ? canceled && options.postCancelBalance !== undefined ? options.postCancelBalance : qty : options.initialBalance ?? '0',
    decimals: 5, slot: 100, nativeSlot: 100, mintAuthority: options.mintAuthority ?? null,
    freezeAuthority: null, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', extensions: [], checkedAt: new Date().toISOString()});
  const fact = (side: 'buy' | 'sell'): VerifiedSolanaTransaction => ({signature: side === 'buy' ? buySignature : sellSignature,
    wallet, mint: run.mint, side, slot: side === 'buy' ? 101 : 103,
    tokenDelta: side === 'buy' ? options.buyTokenDelta ?? qty : '-' + qty,
    nativeDelta: side === 'buy' ? options.buyNativeDelta ?? '-10025000' : '9975000',
    feeLamports: '25000', preTokenAmount: side === 'buy' ? '0' : qty, postTokenAmount: side === 'buy' ? qty : '0',
    preNativeLamports: side === 'buy' ? '1000000000' : '989975000', postNativeLamports: side === 'buy' ? '989975000' : '999950000',
    decimals: 5, checkedAt: new Date().toISOString()});
  const parent = (closed: boolean): any => {
    let children = TEST_CONDITIONS.map((condition, i) => ({...condition, cid: 'child-' + i, status: closed ? 'cancel' : 'running'}));
    if (options.initialPolicyMismatch) children[0] = {...children[0], price_scale: '101'};
    if (closed && options.cancelChildren === 'missing') children = children.slice(0, 1);
    if (closed && options.cancelChildren === 'duplicate') children[1] = {...children[1], cid: children[0].cid};
    if (closed && options.cancelChildren === 'success') children[0] = {...children[0], status: 'success'};
    if (closed && options.cancelChildren === 'changed') children[0] = {...children[0], price_scale: '102'};
    return {order_id: 'strategy-1', chain: 'sol', wallet_address: wallet, base_token: run.mint,
      quote_token: TEST_INPUT, open_sign_hash: buySignature, order_type: 'smart_trade', sub_order_type: 'mix_trade',
      sell_ratio_type: 'hold_amount', status: closed ? 'closed' : 'open', strategy_status: closed ? 'stopped' : 'running',
      condition_orders: children, order_statistic: {success_sell_num: options.cancelCount ?? 0}};
  };
  const client: TestTradeClient = {
    quote: async request => {
      const buy = request.inputToken === TEST_INPUT;
      if (!buy && !bought && options.reverseQuoteUnavailable) throw new Error('NO_ROUTE');
      return {input_token: request.inputToken, output_token: request.outputToken,
        input_amount: request.inputAmount, output_amount: buy ? qty : TEST_AMOUNT,
        min_output_amount: options.badBuyQuote && buy ? '1' : buy ? '495000000' : '9900000', slippage: 1};
    },
    swap: async (body, clientId) => {
      const key = body.input_token === TEST_INPUT ? 'buy' : 'sell';
      const recorded = journal.operation(run.id, key);
      assert.equal(recorded?.state, 'submitting', 'Submission must be durable before external I/O');
      assert.equal(recorded?.clientId, clientId);
      assert.deepEqual(recorded?.body, body);
      writes.push({key, body: structuredClone(body), clientId});
      if (key === 'buy') {bought = true; if (options.buyUnknown) throw new Error('secret response lost');}
      else {sold = true; if (options.sellUnknown) throw new Error('secret response lost');}
      return {order_id: key + '-order', status: 'pending', ...(key === 'buy' ? {strategy_order_id: 'strategy-1'} : {})};
    },
    query: async orderId => {
      queries.push(orderId);
      if (options.queryErrorOnce && queryErrors++ === 0) throw new Error('temporary read failure');
      const buy = orderId === 'buy-order';
      return {order_id: options.buyOrderMismatch && buy ? 'foreign-order' : orderId, status: 'successful', state: 30,
        hash: buy ? buySignature : sellSignature, ...(buy && !options.queryOmitsStrategyId ? {strategy_order_id: 'strategy-1'} : {}),
        report: {input_token: buy ? TEST_INPUT : run.mint,
          output_token: buy ? options.badFillMint ? TEST_INPUT : run.mint : TEST_INPUT,
          input_amount: buy ? TEST_AMOUNT : qty, output_amount: buy ? qty : TEST_AMOUNT}};
    },
    strategies: async (_wallet, _mint, type) => {
      if (!bought) return {list: options.existingStrategy && type === 'open' ? [parent(false)] : []};
      const visibleClosed = canceled && !options.cancellationNeverVisible;
      return {list: type === 'open' ? visibleClosed ? [] : [parent(false)] : visibleClosed ? [parent(true)] : []};
    },
    cancel: async (_wallet, orderId, clientId) => {
      const recorded = journal.operation(run.id, 'cancel');
      assert.equal(recorded?.state, 'submitting'); assert.equal(recorded?.clientId, clientId);
      writes.push({key: 'cancel', body: {order_id: orderId}, clientId}); canceled = true;
      if (options.cancelUnknown) throw new Error('secret response lost');
      return {order_id: orderId, success: true};
    },
  };
  const chain: TestChainReader = {snapshot: async () => snapshot(), verifyTransaction: async request => {
    assert.equal(request.wallet, wallet); assert.equal(request.mint, run.mint);
    assert.equal(request.signature, request.side === 'buy' ? buySignature : sellSignature);
    assert.equal(request.expectedTokenAmount, qty);
    return fact(request.side);
  }};
  const notifier: TestNotifier = {notify: async (key, text) => {
    if (options.notificationFailure === 'start' || options.notificationFailure === 'after_buy' && bought)
      throw new Error('secret TG failure');
    notifications.push({key, text});
  }};
  const execute = () => new ControlledTradeRunner({journal, client, chain, notifier, sleep: async () => {}, pollAttempts: 2}).execute(run.id);
  return {journal, run, writes, notifications, queries, execute, client, chain, notifier};
}

test('fixed 0.01 SOL controlled roundtrip persists before each write and verifies protection/cancellation/closure', async t => {
  const ctx = fixture(); t.after(() => ctx.journal.close());
  assert.equal(ctx.run.amountLamports, '10000000'); assert.equal(ctx.run.maxDebitLamports, '20000000');
  const result = await ctx.execute();
  assert.equal(result.phase, 'complete', JSON.stringify(result.reasons));
  assert.deepEqual(ctx.writes.map(item => item.key), ['buy', 'cancel', 'sell']);
  const buy = ctx.writes[0].body, sell = ctx.writes[2].body;
  assert.equal(buy.input_amount, TEST_AMOUNT); assert.equal(buy.slippage, 1);
  assert.equal(buy.sell_ratio_type, 'hold_amount'); assert.deepEqual(buy.condition_orders, TEST_CONDITIONS);
  assert.equal(sell.input_amount, qty); assert.equal(sell.condition_orders, undefined);
  assert.equal(result.strategyMatched, true); assert.equal(result.strategyCanceled, true);
  assert.equal(result.finalSnapshot?.tokenAmount, '0'); assert.equal(result.netNativeLamports, '-50000');
  assert.equal(result.automaticTriggerVerified, false);
  assert.equal(ctx.notifications.length, 4);
  assert.ok(ctx.notifications.some(item => item.text.includes('自动触发成交未测试')));
  await ctx.execute(); assert.equal(ctx.writes.length, 3, 'A completed run must not submit again');
});

test('existing tokens, authorities, active strategies or missing bidirectional quotes fail before any POST', async t => {
  for (const options of [{initialBalance: '1'}, {mintAuthority: wallet}, {existingStrategy: true},
    {badBuyQuote: true}, {reverseQuoteUnavailable: true}]) {
    const ctx = fixture(options); t.after(() => ctx.journal.close());
    assert.equal((await ctx.execute()).phase, 'preflight_failed'); assert.equal(ctx.writes.length, 0);
  }
});

test('TG unavailable before buy stops the test before acquiring any market risk', async t => {
  const ctx = fixture({notificationFailure: 'start'}); t.after(() => ctx.journal.close());
  const result = await ctx.execute();
  assert.equal(result.phase, 'preflight_failed'); assert.ok(result.reasons.includes('TEST_TELEGRAM_UNAVAILABLE_BEFORE_BUY'));
  assert.equal(ctx.writes.length, 0);
});

test('TG failures after confirmed buy do not block cancellation, cleanup sell or durable completion', async t => {
  const ctx = fixture({notificationFailure: 'after_buy'}); t.after(() => ctx.journal.close());
  const result = await ctx.execute();
  assert.equal(result.phase, 'complete', JSON.stringify(result.reasons));
  assert.deepEqual(ctx.writes.map(item => item.key), ['buy', 'cancel', 'sell']);
  assert.ok(result.reasons.includes('TEST_TELEGRAM_PENDING'));
});

test('unknown buy submission is retained and never resent on repeated execution', async t => {
  const ctx = fixture({buyUnknown: true}); t.after(() => ctx.journal.close());
  const first = await ctx.execute(), second = await ctx.execute();
  assert.equal(first.phase, 'needs_attention'); assert.equal(second.phase, 'needs_attention');
  assert.equal(ctx.journal.operation(ctx.run.id, 'buy')?.state, 'unknown');
  assert.deepEqual(ctx.writes.map(item => item.key), ['buy']); assert.equal(ctx.queries.length, 0);
});

test('temporary query failure is recovered by reads, never a second buy submission', async t => {
  const ctx = fixture({queryErrorOnce: true}); t.after(() => ctx.journal.close());
  const result = await ctx.execute();
  assert.equal(result.phase, 'complete', JSON.stringify(result.reasons));
  assert.equal(ctx.writes.filter(item => item.key === 'buy').length, 1); assert.equal(ctx.queries.length, 3);
});

test('foreign order IDs and wrong fill mints cannot be promoted into confirmed purchases', async t => {
  for (const options of [{buyOrderMismatch: true}, {badFillMint: true}]) {
    const ctx = fixture(options); t.after(() => ctx.journal.close());
    const result = await ctx.execute();
    assert.equal(result.phase, 'needs_attention'); assert.equal(result.buy, undefined);
    assert.deepEqual(ctx.writes.map(item => item.key), ['buy']);
  }
});

test('a lost cancel acknowledgement is recovered from terminal strategy evidence, without resubmitting cancel', async t => {
  const ctx = fixture({cancelUnknown: true}); t.after(() => ctx.journal.close());
  const result = await ctx.execute();
  assert.equal(result.phase, 'complete', JSON.stringify(result.reasons));
  assert.equal(ctx.writes.filter(item => item.key === 'cancel').length, 1);
  assert.equal(ctx.journal.operation(ctx.run.id, 'cancel')?.state, 'acknowledged');
});

test('missing, duplicate or changed canceled children cannot authorize a cleanup sell', async t => {
  for (const cancelChildren of ['missing', 'duplicate', 'changed'] as const) {
    const ctx = fixture({cancelChildren}); t.after(() => ctx.journal.close());
    const result = await ctx.execute();
    assert.equal(result.phase, 'needs_attention'); assert.ok(result.buy);
    assert.deepEqual(ctx.writes.map(item => item.key), ['buy', 'cancel']);
    assert.notEqual(result.strategyCanceled, true);
  }
});

test('a complete but mismatched protection policy is reported as failure and its exact children are cleaned up', async t => {
  const ctx = fixture({initialPolicyMismatch: true}); t.after(() => ctx.journal.close());
  const result = await ctx.execute();
  assert.equal(result.phase, 'complete', JSON.stringify(result.reasons));
  assert.equal(result.strategyMatched, false); assert.equal(result.strategyCanceled, true);
  assert.ok(result.reasons.includes('TEST_ATTACHED_POLICY_MISMATCH'));
  assert.deepEqual(ctx.writes.map(item => item.key), ['buy', 'cancel', 'sell']);
  assert.equal(result.automaticTriggerVerified, false);
});

test('buy confirmation checks the minimum received quantity and at least the fixed principal native debit', async t => {
  for (const options of [{buyNativeDelta: '-9999999'}, {buyTokenDelta: '494999999'}]) {
    const ctx = fixture(options); t.after(() => ctx.journal.close());
    const result = await ctx.execute();
    assert.equal(result.phase, 'needs_attention'); assert.equal(result.buy, undefined);
    assert.ok(result.reasons.includes('TEST_BUY_DELTA_MISMATCH'));
    assert.deepEqual(ctx.writes.map(item => item.key), ['buy']);
  }
});

test('successful child orders, reported sells, still-open strategies or changed holdings prohibit competing manual sales', async t => {
  for (const options of [{cancelChildren: 'success' as const}, {cancelCount: 1},
    {cancellationNeverVisible: true}, {postCancelBalance: '1'}]) {
    const ctx = fixture(options); t.after(() => ctx.journal.close());
    const result = await ctx.execute();
    assert.equal(result.phase, 'needs_attention'); assert.ok(result.buy);
    assert.deepEqual(ctx.writes.map(item => item.key), ['buy', 'cancel']);
    assert.notEqual(result.strategyCanceled, true);
  }
});

test('unknown sell remains unresolved and repeated execution never sells twice', async t => {
  const ctx = fixture({sellUnknown: true}); t.after(() => ctx.journal.close());
  const first = await ctx.execute(), second = await ctx.execute();
  assert.equal(first.phase, 'needs_attention'); assert.equal(second.phase, 'needs_attention');
  assert.equal(ctx.journal.operation(ctx.run.id, 'sell')?.state, 'unknown');
  assert.deepEqual(ctx.writes.map(item => item.key), ['buy', 'cancel', 'sell']);
});

test('tampered run budget or amount never reaches a trade client', async t => {
  for (const patch of [{amountLamports: '10000001'}, {maxDebitLamports: '20000001'}]) {
    const ctx = fixture(); t.after(() => ctx.journal.close());
    const original = ctx.journal.get.bind(ctx.journal);
    ctx.journal.get = id => {const saved = original(id); return saved ? {...saved, ...patch} : undefined;};
    await assert.rejects(ctx.execute(), /TEST_RUN_SETTINGS_INVALID/); assert.equal(ctx.writes.length, 0);
  }
  assert.equal(TEST_AMOUNT, '10000000'); assert.equal(TEST_MAX_DEBIT, '20000000');
});

test('a completed run retries its failed final TG notification without any further quote or trading calls', async t => {
  const ctx = fixture(); t.after(() => ctx.journal.close());
  let failClosed = true, quoteCalls = 0, cancelCalls = 0;
  const notify = ctx.notifier.notify.bind(ctx.notifier), quote = ctx.client.quote.bind(ctx.client), cancel = ctx.client.cancel.bind(ctx.client);
  ctx.notifier.notify = async (key, text) => {
    if (failClosed && key.endsWith(':closed')) throw new Error('temporary notification failure');
    await notify(key, text);
  };
  ctx.client.quote = async request => {quoteCalls++; return quote(request);};
  ctx.client.cancel = async (...args) => {cancelCalls++; return cancel(...args);};
  const first = await ctx.execute();
  assert.equal(first.phase, 'complete'); assert.equal(ctx.notifications.filter(item => item.key.endsWith(':closed')).length, 0);
  const quotesBefore = quoteCalls, cancelsBefore = cancelCalls, queriesBefore = ctx.queries.length;
  assert.equal(ctx.writes.length, 3);
  failClosed = false;
  const resumed = await ctx.execute();
  assert.equal(resumed.phase, 'complete');
  assert.equal(ctx.notifications.filter(item => item.key.endsWith(':closed')).length, 1);
  assert.equal(ctx.writes.length, 3); assert.equal(quoteCalls, quotesBefore); assert.equal(cancelCalls, cancelsBefore);
  assert.equal(ctx.queries.length, queriesBefore);
  await ctx.execute();
  assert.equal(ctx.notifications.filter(item => item.key.endsWith(':closed')).length, 1);
  assert.equal(ctx.writes.length, 3);
});

test('a strategy ID from the initial swap acknowledgement survives a query response that omits it', async t => {
  const ctx = fixture({queryOmitsStrategyId: true}); t.after(() => ctx.journal.close());
  const result = await ctx.execute();
  assert.equal(result.phase, 'complete', JSON.stringify(result.reasons));
  assert.equal(result.strategyId, 'strategy-1'); assert.equal(result.strategyMatched, true);
  assert.equal(result.strategyCanceled, true);
  assert.equal((ctx.journal.operation(ctx.run.id, 'buy')?.response as any).strategy_order_id, 'strategy-1');
  assert.deepEqual(ctx.writes.map(item => item.key), ['buy', 'cancel', 'sell']);
});
