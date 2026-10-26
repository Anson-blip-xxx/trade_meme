import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {readConfig} from '../src/config.js';
import {readNativeBalance, nativeBalanceCoversOrder, nativeCurrency, NATIVE_INPUT_TOKENS, type NativeBalance} from '../src/native-balance.js';
import type {Fetcher} from '../src/http.js';
import type {Chain} from '../src/types.js';

const wallet = '0x' + '2'.repeat(40);
const solWallet = bs58.encode(new Uint8Array(32).fill(1));
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const config = {...readConfig({}), rpc: {bsc: 'https://bsc.invalid', robinhood: 'https://rh.invalid', solana: 'https://sol.invalid'}};
const evmResults = (balance: unknown = '0x0') => ({eth_chainId: '0x38', eth_blockNumber: '0xabc', eth_getBalance: balance});
const solResults = (value: unknown = 0) => ({getGenesisHash: genesis, getBalance: {context: {slot: 123}, value}});
function mocked(values: Record<string, unknown>) {
  const calls: {method: string; params: unknown[]; url: string; init?: RequestInit}[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({...body, url: String(input), init});
    if (!Object.hasOwn(values, body.method)) throw new Error('UNEXPECTED_RPC_METHOD');
    return Response.json({jsonrpc: '2.0', id: body.id, result: values[body.method]});
  };
  return {fetcher, calls};
}
function expectUnknown(result: NativeBalance, reason?: string) {
  assert.equal(result.status, 'unknown'); assert.equal(Object.hasOwn(result, 'amount'), false);
  assert.ok(Number.isFinite(Date.parse(result.readStartedAt)));
  assert.ok(Date.parse(result.checkedAt) >= Date.parse(result.readStartedAt));
  if (reason) assert.deepEqual(result.reasons, [reason]);
}

test('EVM reads exact wei on the verified chain at a pinned head block', async () => {
  for (const chain of ['bsc', 'robinhood'] as const) {
    const amount = 445426950800606938n;
    const ctx = mocked({...evmResults('0x' + amount.toString(16)), eth_chainId: chain === 'bsc' ? '0x38' : '0x1237'});
    const result = await readNativeBalance(chain, wallet, config, ctx.fetcher);
    assert.equal(result.status, 'verified'); assert.equal(result.amount, amount.toString());
    assert.equal(result.blockNumber, '0xabc'); assert.equal(result.slot, undefined);
    assert.deepEqual(ctx.calls.map(call => call.method), ['eth_chainId', 'eth_blockNumber', 'eth_getBalance']);
    assert.deepEqual(ctx.calls.at(-1)?.params, [wallet, '0xabc']);
    assert.ok(Date.parse(result.checkedAt) >= Date.parse(result.readStartedAt));
    for (const call of ctx.calls) {
      assert.equal(call.url, config.rpc[chain]); assert.equal(call.init?.method, 'POST');
      assert.equal(call.init?.redirect, 'error'); assert.ok(call.init?.signal instanceof AbortSignal);
      assert.equal(new Headers(call.init?.headers).has('authorization'), false);
    }
  }
});

test('EVM zero and full uint256 balances remain exact decimal strings', async () => {
  for (const amount of [0n, 9007199254740993n, (1n << 256n) - 1n]) {
    const result = await readNativeBalance('bsc', wallet, config, mocked(evmResults('0x' + amount.toString(16))).fetcher);
    assert.equal(result.status, 'verified'); assert.equal(result.amount, amount.toString());
  }
});

test('invalid chains, malformed addresses and zero wallets fail without RPC calls', async () => {
  const ctx = mocked({});
  for (const invalid of ['', '0x' + '0'.repeat(40), '0x1234', ' 0x' + '2'.repeat(40), '0x' + 'g'.repeat(40),
    '0x52908400098527886E0F7030069857D2E4169Ee7'])
    expectUnknown(await readNativeBalance('bsc', invalid, config, ctx.fetcher), 'NATIVE_WALLET_INVALID');
  for (const invalid of ['', '11111111111111111111111111111111', bs58.encode(new Uint8Array(31).fill(1)),
    '0'.repeat(44), solWallet + ' '])
    expectUnknown(await readNativeBalance('solana', invalid, config, ctx.fetcher), 'NATIVE_WALLET_INVALID');
  expectUnknown(await readNativeBalance('eth' as Chain, wallet, config, ctx.fetcher), 'NATIVE_WALLET_INVALID');
  assert.equal(ctx.calls.length, 0);
});

test('missing operator RPC never falls back to a provider or another chain', async () => {
  const ctx = mocked({});
  for (const chain of ['bsc', 'robinhood', 'solana'] as const)
    expectUnknown(await readNativeBalance(chain, chain === 'solana' ? solWallet : wallet,
      {...config, rpc: {}}, ctx.fetcher), 'NATIVE_RPC_NOT_CONFIGURED');
  assert.equal(ctx.calls.length, 0);
});

test('wrong or malformed EVM chain identity stops before reading head or balance', async () => {
  for (const id of ['0x1', '0x1237', '0x038', 56, null, '', '56']) {
    const ctx = mocked({...evmResults(), eth_chainId: id});
    expectUnknown(await readNativeBalance('bsc', wallet, config, ctx.fetcher), 'NATIVE_RPC_CHAIN_MISMATCH');
    assert.equal(ctx.calls.length, 1);
  }
});

test('malformed heads stop EVM balance reads and malformed quantities never become zero', async () => {
  const invalid = [null, undefined, '', '0x', '0x00', '-1', 0, '0x' + 'f'.repeat(65), '0xg', '1e18'];
  for (const value of invalid) {
    const head = mocked({...evmResults(), eth_blockNumber: value});
    expectUnknown(await readNativeBalance('bsc', wallet, config, head.fetcher));
    assert.equal(head.calls.some(call => call.method === 'eth_getBalance'), false);
    expectUnknown(await readNativeBalance('bsc', wallet, config, mocked({...evmResults(), eth_getBalance: value}).fetcher));
  }
});

test('SOL verifies the complete genesis and reads confirmed native lamports', async () => {
  for (const value of [0, 2384971463, Number.MAX_SAFE_INTEGER]) {
    const ctx = mocked(solResults(value));
    const result = await readNativeBalance('solana', solWallet, config, ctx.fetcher);
    assert.equal(result.status, 'verified'); assert.equal(result.amount, String(value));
    assert.equal(result.slot, 123); assert.equal(result.blockNumber, undefined);
    assert.deepEqual(ctx.calls.map(call => call.method), ['getGenesisHash', 'getBalance']);
    assert.deepEqual(ctx.calls[1].params, [solWallet, {commitment: 'confirmed'}]);
    assert.equal(ctx.calls[1].url, config.rpc.solana);
  }
  for (const wrong of [genesis.slice(0, 32), 'devnet', null, {}]) {
    const ctx = mocked({...solResults(), getGenesisHash: wrong});
    expectUnknown(await readNativeBalance('solana', solWallet, config, ctx.fetcher), 'NATIVE_RPC_CHAIN_MISMATCH');
    assert.equal(ctx.calls.length, 1);
  }
});

test('SOL rejects unsafe, missing, negative, fractional and string amounts instead of rounding', async () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, 0.1, '2384971463', null, undefined, {}, NaN, Infinity])
    expectUnknown(await readNativeBalance('solana', solWallet, config,
      mocked({...solResults(), getBalance: {context: {slot: 123}, value}}).fetcher),
      'NATIVE_BALANCE_RESPONSE_INVALID');
});

test('SOL rejects missing or malformed context even if the balance is zero', async () => {
  for (const value of [null, [], {value: 0}, {context: {}, value: 0}, {context: {slot: '123'}, value: 0},
    {context: {slot: -1}, value: 0}, {context: {slot: 1.1}, value: 0},
    {context: {slot: Number.MAX_SAFE_INTEGER + 1}, value: 0}])
    expectUnknown(await readNativeBalance('solana', solWallet, config,
      mocked({...solResults(), getBalance: value}).fetcher), 'NATIVE_BALANCE_RESPONSE_INVALID');
});

test('upstream errors, missing results, bad JSON and timeout never leak secrets or report zero', async () => {
  const secret = 'PRIVATE_RPC_URL_CREDENTIAL';
  for (const response of [Response.json({error: {code: -32000, message: secret}}), Response.json({}),
    new Response(secret)]) {
    const result = await readNativeBalance('bsc', wallet, config, async () => response);
    expectUnknown(result, 'NATIVE_RPC_UNAVAILABLE'); assert.equal(JSON.stringify(result).includes(secret), false);
  }
  const result = await readNativeBalance('bsc', wallet, config, async () => {throw new DOMException(secret, 'TimeoutError');});
  expectUnknown(result, 'NATIVE_RPC_TIMEOUT'); assert.equal(JSON.stringify(result).includes(secret), false);
});

test('transient RPC transport and throttle failures retry once without changing the chain or pinned block', async () => {
  for (const failure of [new TypeError('PRIVATE_NETWORK_FAILURE'), new DOMException('PRIVATE_TIMEOUT', 'TimeoutError'),
    408, 429, 502, 503, 504]) {
    const ctx = mocked({...evmResults('0x123'), eth_chainId: '0x1237'});
    let attempts = 0;
    const fetcher: Fetcher = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'eth_getBalance' && attempts++ === 0) {
        if (typeof failure === 'number') return new Response('PRIVATE_UPSTREAM_BODY', {status: failure});
        throw failure;
      }
      return ctx.fetcher(input, init);
    };
    const result = await readNativeBalance('robinhood', wallet, config, fetcher);
    assert.equal(result.status, 'verified'); assert.equal(result.amount, '291'); assert.equal(attempts, 2);
    assert.deepEqual(ctx.calls.at(-1)?.params, [wallet, '0xabc']);
    assert.equal(ctx.calls.every(call => call.url === config.rpc.robinhood), true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('retry budget is shared across the snapshot and final throttle never becomes zero', async () => {
  const calls: string[] = [];
  const ctx = mocked(evmResults());
  const fetcher: Fetcher = async (input, init) => {
    const {method} = JSON.parse(String(init?.body)); calls.push(method);
    if (calls.length === 1 || method === 'eth_getBalance') return new Response('PRIVATE_BODY', {status: 429});
    return ctx.fetcher(input, init);
  };
  const result = await readNativeBalance('bsc', wallet, config, fetcher);
  expectUnknown(result, 'NATIVE_RPC_RATE_LIMITED');
  assert.deepEqual(calls, ['eth_chainId', 'eth_chainId', 'eth_blockNumber', 'eth_getBalance']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('HTTP rate-limit Retry-After is respected and never waited beyond the read budget', async () => {
  for (const retryAfter of ['60', new Date(Date.now() + 60_000).toUTCString()]) {
    let calls = 0;
    const started = performance.now();
    expectUnknown(await readNativeBalance('bsc', wallet, config, async () => {
      calls++; return new Response(null, {status: 429, headers: {'retry-after': retryAfter}});
    }), 'NATIVE_RPC_RATE_LIMITED');
    assert.equal(calls, 1); assert.ok(performance.now() - started < 1_000);
  }
  const ctx = mocked(evmResults());
  let calls = 0;
  const started = performance.now();
  const result = await readNativeBalance('bsc', wallet, config, async (input, init) => {
    if (++calls === 1) return new Response(null, {status: 429, headers: {'retry-after': '0.4'}});
    return ctx.fetcher(input, init);
  });
  assert.equal(result.status, 'verified'); assert.equal(calls, 4);
  assert.ok(performance.now() - started >= 380, 'short Retry-After must be waited instead of the default 250ms');
});

test('permanent HTTP, RPC and JSON errors never retry or fall back', async () => {
  for (const response of [new Response('denied', {status: 401}), new Response('forbidden', {status: 403}),
    new Response('bad request', {status: 400}), Response.json({error: {code: -32000, message: 'bad block'}}),
    Response.json(null), Response.json([]), new Response('not json')]) {
    let calls = 0;
    expectUnknown(await readNativeBalance('bsc', wallet, config, async () => {calls++; return response;}),
      'NATIVE_RPC_UNAVAILABLE');
    assert.equal(calls, 1);
  }
  const ctx = mocked({...evmResults(), eth_chainId: '0x1'});
  expectUnknown(await readNativeBalance('robinhood', wallet, config, ctx.fetcher), 'NATIVE_RPC_CHAIN_MISMATCH');
  assert.equal(ctx.calls.length, 1);
});

test('the whole RPC snapshot has an eight-second deadline including earlier successful reads', async () => {
  const calls: string[] = [];
  const ctx = mocked(evmResults());
  const fetcher: Fetcher = async (input, init) => {
    const {method} = JSON.parse(String(init?.body)); calls.push(method);
    const signal = init?.signal;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, method === 'eth_getBalance' ? 20_000 : 2_800);
      signal?.addEventListener('abort', () => {clearTimeout(timer); reject(signal.reason);}, {once: true});
    });
    return ctx.fetcher(input, init);
  };
  const started = performance.now();
  expectUnknown(await readNativeBalance('bsc', wallet, config, fetcher), 'NATIVE_RPC_TIMEOUT');
  assert.ok(performance.now() - started < 9_500, 'snapshot should abort around the shared eight-second deadline');
  assert.deepEqual(calls, ['eth_chainId', 'eth_blockNumber', 'eth_getBalance']);
});

test('native currency metadata uses execution identifiers and is immutable', () => {
  assert.deepEqual(nativeCurrency('bsc'), {symbol: 'BNB', decimals: 18});
  assert.deepEqual(nativeCurrency('solana'), {symbol: 'SOL', decimals: 9});
  assert.deepEqual(nativeCurrency('robinhood'), {symbol: 'ETH', decimals: 18});
  assert.equal(NATIVE_INPUT_TOKENS.solana, 'So11111111111111111111111111111111111111112');
  assert.equal(NATIVE_INPUT_TOKENS.bsc, '0x' + '0'.repeat(40));
  assert.equal(NATIVE_INPUT_TOKENS.robinhood, '0x' + '0'.repeat(40));
  assert.ok(Object.isFrozen(NATIVE_INPUT_TOKENS)); assert.ok(Object.isFrozen(nativeCurrency('bsc')));
});

const transactionHash = '0x' + 'a'.repeat(64), blockHash = '0x' + 'b'.repeat(64);
const signature = bs58.encode(new Uint8Array(64).fill(3));
const snapshot = (overrides: Partial<NativeBalance> = {}): NativeBalance => ({status: 'verified', amount: '1000',
  checkedAt: '2026-10-09T00:00:01.000Z', readStartedAt: '2026-10-09T00:00:00.000Z',
  reasons: ['NATIVE_BALANCE_VERIFIED'], blockNumber: '0x10c', ...overrides});
const receipt = (blockNumber = '0x100') => ({status: '0x1', transactionHash, blockNumber, blockHash});
const coveredEvm = () => ({eth_getTransactionReceipt: receipt(), eth_getBlockByNumber: {number: '0x100', hash: blockHash}});
const statusResponse = () => ({context: {slot: 150}, value: [{slot: 100, err: null, confirmationStatus: 'finalized', status: {Ok: null}}]});

test('EVM budget coverage needs a canonical successful receipt at least twelve blocks before snapshot', async () => {
  for (const chain of ['bsc', 'robinhood'] as const) {
    for (const head of ['0x10c', '0x10d']) {
      const ctx = mocked(coveredEvm());
      assert.equal(await nativeBalanceCoversOrder({chain, transactionHash}, snapshot({blockNumber: head}), config, ctx.fetcher), true);
      assert.deepEqual(ctx.calls.map(call => call.method), ['eth_getTransactionReceipt', 'eth_getBlockByNumber']);
      assert.deepEqual(ctx.calls[0].params, [transactionHash]);
      assert.deepEqual(ctx.calls[1].params, ['0x100', false]);
      assert.equal(ctx.calls[0].url, config.rpc[chain]);
    }
    const fresh = mocked(coveredEvm());
    assert.equal(await nativeBalanceCoversOrder({chain, transactionHash}, snapshot({blockNumber: '0x10b'}), config, fresh.fetcher), false);
    assert.equal(fresh.calls.length, 1);
  }
});

test('unverified snapshots, absent receipt hash, invalid signatures and missing RPC cannot cover orders', async () => {
  const ctx = mocked({});
  const evmOrder = {chain: 'bsc', transactionHash} as const;
  for (const patch of [{status: 'unknown' as const}, {amount: undefined}, {amount: '-1'}, {blockNumber: undefined}, {blockNumber: 'latest'}])
    assert.equal(await nativeBalanceCoversOrder(evmOrder, snapshot(patch), config, ctx.fetcher), false);
  assert.equal(await nativeBalanceCoversOrder({...evmOrder, transactionHash: undefined}, snapshot(), config, ctx.fetcher), false);
  assert.equal(await nativeBalanceCoversOrder(evmOrder, snapshot(), {...config, rpc: {}}, ctx.fetcher), false);
  assert.equal(await nativeBalanceCoversOrder({chain: 'solana', transactionHash: solWallet},
    snapshot({slot: 100}), config, ctx.fetcher), false);
  assert.equal(await nativeBalanceCoversOrder({chain: 'solana', transactionHash: signature}, snapshot(), config, ctx.fetcher), false);
  assert.equal(ctx.calls.length, 0);
});

test('future, failed, mismatched and orphaned EVM buys remain reserved', async () => {
  for (const change of [{eth_getTransactionReceipt: null}, {eth_getTransactionReceipt: receipt('0x101')},
    {eth_getTransactionReceipt: {...receipt(), status: '0x0'}},
    {eth_getTransactionReceipt: {...receipt(), transactionHash: blockHash}},
    {eth_getTransactionReceipt: {...receipt(), blockNumber: null}},
    {eth_getTransactionReceipt: {...receipt(), blockHash: null}},
    {eth_getBlockByNumber: null}, {eth_getBlockByNumber: {number: '0x100', hash: transactionHash}},
    {eth_getBlockByNumber: {number: '0x101', hash: blockHash}}]) {
    const ctx = mocked({...coveredEvm(), ...change});
    assert.equal(await nativeBalanceCoversOrder({chain: 'bsc', transactionHash}, snapshot(), config, ctx.fetcher), false);
    if ('eth_getTransactionReceipt' in change) assert.equal(ctx.calls.length, 1);
  }
});

test('SOL snapshot covers only a successful finalized signature no later than its slot', async () => {
    for (const slot of [100, 101]) {
      const ctx = mocked({getSignatureStatuses: statusResponse()});
      assert.equal(await nativeBalanceCoversOrder({chain: 'solana', transactionHash: signature},
        snapshot({blockNumber: undefined, slot}), config, ctx.fetcher), true);
      assert.deepEqual(ctx.calls[0].params, [[signature], {searchTransactionHistory: true}]);
      assert.equal(ctx.calls[0].url, config.rpc.solana);
    }
});

test('unknown, later, failed, pending or malformed SOL signatures do not cover the budget', async () => {
  const tx = statusResponse().value[0];
  for (const value of [null, {value: []}, {value: [null]}, {value: [tx, tx]},
    {value: [{...tx, slot: 101}]}, {value: [{...tx, err: undefined}]}, {value: [{...tx, err: {InstructionError: []}}]},
    {value: [{...tx, slot: '100'}]}, {value: [{...tx, slot: Number.MAX_SAFE_INTEGER + 1}]},
    {value: [{...tx, confirmationStatus: 'processed'}]}, {value: [{...tx, confirmationStatus: ['confirmed']}]},
    {value: [{...tx, confirmationStatus: 'confirmed'}]},
    {value: [{...tx, status: {Err: 'contradiction', Ok: null}}]}])
    assert.equal(await nativeBalanceCoversOrder({chain: 'solana', transactionHash: signature},
      snapshot({slot: 100}), config, mocked({getSignatureStatuses: value}).fetcher), false);
});

test('order coverage fails closed on upstream failure without retries', async () => {
  let calls = 0;
  const fetcher: Fetcher = async () => {calls++; throw new Error('PRIVATE_RPC_URL_CREDENTIAL');};
  assert.equal(await nativeBalanceCoversOrder({chain: 'bsc', transactionHash}, snapshot(), config, fetcher), false);
  assert.equal(calls, 1);
});

test('order coverage obeys one caller deadline and never accepts a late RPC result', async () => {
  let aborted = false;
  const controller = new AbortController();
  const fetcher: Fetcher = async (_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    signal.addEventListener('abort', () => {aborted = true; reject(signal.reason);}, {once: true});
  });
  const pending = nativeBalanceCoversOrder({chain: 'solana', transactionHash: signature},
    snapshot({blockNumber: undefined, slot: 100}), config, fetcher, controller.signal);
  controller.abort(new DOMException('coverage deadline', 'TimeoutError'));
  assert.equal(await pending, false);
  assert.equal(aborted, true);
});
