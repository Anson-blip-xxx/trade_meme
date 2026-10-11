import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID, verify} from 'node:crypto';
import bs58 from 'bs58';
import {readConfig, type Config} from '../src/config.js';
import {EntryController, type LiveProtectionProvider} from '../src/entry.js';
import {OrderStore} from '../src/orders.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import {NATIVE_INPUT_TOKENS} from '../src/native-balance.js';
import {parseExitPolicy} from '../src/exit-policy.js';
import type {Chain, Report} from '../src/types.js';

const caps: Record<Chain, string> = {bsc: '150000000000000000', solana: '1000000000', robinhood: '50000000000000000'};
const generated = generateKeyPairSync('ed25519');
const pem = generated.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
const wallet = (chain: Chain) => chain === 'solana' ? bs58.encode(new Uint8Array(32).fill(1)) : `0x${'2'.repeat(40)}`;
const token = (chain: Chain, n = 3) => chain === 'solana' ? bs58.encode(new Uint8Array(32).fill(n)) : `0x${String(n).repeat(40)}`;
const hash = `0x${'a'.repeat(64)}`, blockHash = `0x${'b'.repeat(64)}`;
const exitPolicy = () => parseExitPolicy({enabled: true, sellRatioType: 'hold_amount',
  takeProfit: [{gainPct: 500, sellPct: 20}, {gainPct: 1000, sellPct: 10}], stopLoss: {dropPct: 40, sellPct: 100}})!;
type Capture = {url: URL; init?: RequestInit};

function setup(t: {after: (fn: () => void) => void}, options: {
  chain?: Chain; config?: Partial<Config>; balances?: bigint[];
  beforeBalance?: (read: number, clock: {time: number}) => void | Promise<void>;
  rpcFailureAt?: number; unknownBalanceAt?: number; swapFails?: boolean;
  liveProtection?: LiveProtectionProvider | null;
} = {}) {
  const chain = options.chain ?? 'bsc', clock = {time: Date.now()};
  const config: Config = {...readConfig({}), entryMode: 'live', entrySizing: 'balance_cap',
    gmgnApiKey: `sizing-test-${randomUUID()}`, gmgnPrivateKey: pem, gmgnMinIntervalMs: 0,
    entryAmounts: {[chain]: caps[chain]}, entryWallets: {[chain]: wallet(chain)},
    entryInputTokens: {[chain]: NATIVE_INPUT_TOKENS[chain]}, rpc: {[chain]: `https://${chain}.invalid/native-rpc`},
    ...options.config};
  const readCalls: Capture[] = [], signedCalls: Capture[] = [], rpcCalls: {method: string; params: unknown[]}[] = [];
  let balanceReads = 0;
  const defaultBalance = BigInt(caps[chain]) * 4n + BigInt(config.entryFeeReserves[chain]);
  const balances = options.balances ?? [defaultBalance];
  const client = new GmgnClient({apiKey: config.gmgnApiKey, minIntervalMs: 0, now: () => clock.time,
    fetcher: async (input, init) => {
      const url = new URL(String(input)); readCalls.push({url, init});
      assert.equal(url.pathname, '/v1/trade/quote');
      return Response.json({code: 0, data: {input_token: url.searchParams.get('input_token'),
        output_token: url.searchParams.get('output_token'), input_amount: url.searchParams.get('input_amount'),
        output_amount: '1000000', min_output_amount: '950000', slippage: 5}});
    }});
  const orders = new OrderStore(':memory:'); t.after(() => orders.close());
  const controller = new EntryController(config, orders, client, {now: () => new Date(clock.time),
    // Synthetic readiness exists only to exercise the mocked transport and sizing below.
    liveProtection: options.liveProtection === null ? undefined : options.liveProtection ?? (context => ({
      status: 'verified', scope: 'autonomous_exit_execution', chain: context.chain, wallet: context.wallet,
      checkedAt: new Date(clock.time).toISOString(), validUntil: new Date(clock.time + 30_000).toISOString(),
    })),
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'openapi.gmgn.ai') {
        signedCalls.push({url, init});
        assert.equal(url.pathname, '/v1/trade/swap'); assert.equal(init?.method, 'POST');
        if (options.swapFails) throw new Error('SYNTHETIC_NETWORK_SECRET');
        return Response.json({code: 0, data: {order_id: `order-${signedCalls.length}`, status: 'pending'}});
      }
      assert.equal(url.href, config.rpc[chain]);
      assert.equal(new Headers(init?.headers).has('x-apikey'), false);
      assert.equal(new Headers(init?.headers).has('x-signature'), false);
      const request = JSON.parse(String(init?.body)); rpcCalls.push(request);
      let result: unknown;
      switch (request.method) {
        case 'eth_chainId': result = chain === 'robinhood' ? '0x1237' : '0x38'; break;
        case 'eth_blockNumber': result = '0x100'; break;
        case 'getGenesisHash': result = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; break;
        case 'eth_getBalance':
        case 'getBalance': {
          balanceReads++;
          await options.beforeBalance?.(balanceReads, clock);
          if (options.rpcFailureAt === balanceReads) throw new Error('SYNTHETIC_RPC_SECRET');
          const value = balances[Math.min(balanceReads - 1, balances.length - 1)];
          result = options.unknownBalanceAt === balanceReads ? null : chain === 'solana'
            ? {context: {slot: 1000}, value: Number(value)} : `0x${value.toString(16)}`;
          break;
        }
        case 'eth_getTransactionReceipt': result = {status: '0x1', transactionHash: hash, blockNumber: '0x80', blockHash}; break;
        case 'eth_getBlockByNumber': result = {number: '0x80', hash: blockHash}; break;
        default: throw new Error('UNEXPECTED_TEST_RPC_METHOD');
      }
      return Response.json({jsonrpc: '2.0', id: request.id, result});
    }});
  const candidate = (event = 'sizing-event', output = token(chain)): Report => {
    const checkedAt = new Date(clock.time).toISOString();
    const check = () => ({status: 'pass' as const, reasons: ['TEST_CHECK'], facts: {}, checkedAt});
    return {id: randomUUID(), policyVersion: 'sizing-integration-test', mode: 'live',
      signal: {source: 'manual', sourceEventId: event, occurredAt: checkedAt,
        token: {chain, address: output}, text: '', evidenceUrls: [], claim: 'community'},
      receivedAt: checkedAt, evaluatedAt: checkedAt,
      validUntil: new Date(clock.time + config.decisionTtlSec * 1000).toISOString(), decision: 'BUY_CANDIDATE',
      buyEligible: true, executionEnabled: false, reasons: [], provenance: {...check(), platform: 'flap'},
      safety: check(), narrative: {...check(), evidence: []}, flow: check()};
  };
  return {config, clock, controller, orders, candidate, readCalls, signedCalls, rpcCalls,
    balanceReads: () => balanceReads};
}

test('three-chain caps use exact native execution addresses and dynamic atomic amounts throughout quote and swap', async t => {
  const defaults = readConfig({});
  for (const chain of ['bsc', 'solana', 'robinhood'] as const) {
    const cap = BigInt(caps[chain]), reserve = BigInt(defaults.entryFeeReserves[chain]);
    const available = cap / 2n;
    const ctx = setup(t, {chain, balances: [available + reserve]});
    const result = await ctx.controller.consider(ctx.candidate());
    assert.equal(result.order?.status, 'submitted');
    assert.equal(result.order?.inputAmount, available.toString());
    assert.equal(ctx.readCalls[0].url.searchParams.get('input_amount'), available.toString());
    assert.equal(ctx.readCalls[0].url.searchParams.get('input_token'), NATIVE_INPUT_TOKENS[chain]);
    const body = JSON.parse(String(ctx.signedCalls[0].init?.body));
    assert.equal(body.input_amount, available.toString());
    assert.equal(body.input_token, NATIVE_INPUT_TOKENS[chain]);
    assert.equal(body.chain, chain === 'solana' ? 'sol' : chain);
    assert.equal(ctx.balanceReads(), 2);
    const funding = result.order!.details.funding as Record<string, unknown>;
    assert.equal(funding.cap, caps[chain]); assert.equal(funding.feeReserve, reserve.toString());
  }
});

test('default unavailable autonomous protection blocks before any native balance request', async t => {
  const ctx=setup(t,{liveProtection:null});
  const result=await ctx.controller.consider(ctx.candidate());
  assert.equal(result.reason,'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED');
  assert.equal(ctx.rpcCalls.length,0);assert.equal(ctx.readCalls.length,0);assert.equal(ctx.signedCalls.length,0);
  assert.equal(ctx.orders.list().length,0);
});

test('protection loss during final balance I/O prevents signing and submission', async t => {
  let protectedNow=true;
  const ctx=setup(t,{beforeBalance:read=>{if(read===2) protectedNow=false;},liveProtection:context=>({
    status:protectedNow?'verified':'unverified',scope:'autonomous_exit_execution',chain:context.chain,wallet:context.wallet,
    checkedAt:new Date(ctx.clock.time).toISOString(),validUntil:new Date(ctx.clock.time+30_000).toISOString(),
  })});
  const result=await ctx.controller.consider(ctx.candidate());
  assert.equal(result.reason,'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED');assert.equal(result.order?.status,'failed');
  assert.equal(ctx.balanceReads(),2);assert.equal(ctx.readCalls.length,1);assert.equal(ctx.signedCalls.length,0);
});

test('excess wallet funds never raise any order above its configured native cap', async t => {
  for (const chain of ['bsc', 'solana', 'robinhood'] as const) {
    const ctx = setup(t, {chain});
    const result = await ctx.controller.consider(ctx.candidate());
    assert.equal(result.order?.inputAmount, caps[chain]);
    assert.equal(ctx.readCalls[0].url.searchParams.get('input_amount'), caps[chain]);
    assert.equal(JSON.parse(String(ctx.signedCalls[0].init?.body)).input_amount, caps[chain]);
  }
});

test('balance sizing rejects non-native input currencies before RPC, quote or reservation', async t => {
  for (const chain of ['bsc', 'solana', 'robinhood'] as const) {
    const ctx = setup(t, {chain, config: {entryInputTokens: {[chain]: token(chain, 4)}}});
    const result = await ctx.controller.consider(ctx.candidate());
    assert.equal(result.reason, 'ENTRY_NATIVE_INPUT_REQUIRED');
    assert.equal(ctx.rpcCalls.length, 0); assert.equal(ctx.readCalls.length, 0);
    assert.equal(ctx.signedCalls.length, 0); assert.equal(ctx.orders.list().length, 0);
  }
});

test('zero spendable funds or an unknown balance never fall back to the fixed configured cap', async t => {
  const reserve = BigInt(readConfig({}).entryFeeReserves.bsc);
  for (const options of [{balances: [0n]}, {balances: [reserve]}, {balances: [reserve - 1n]},
    {rpcFailureAt: 1}, {unknownBalanceAt: 1}, {config: {rpc: {}}}]) {
    const ctx = setup(t, options);
    const result = await ctx.controller.consider(ctx.candidate());
    assert.equal(result.status, 'blocked');
    assert.ok(['ENTRY_INSUFFICIENT_BALANCE', 'ENTRY_BALANCE_UNAVAILABLE'].includes(result.reason!));
    assert.equal(ctx.readCalls.length, 0); assert.equal(ctx.signedCalls.length, 0);
    assert.equal(ctx.orders.list().length, 0);
  }
});

test('paper reads and reserves simulated native principal but never submits or performs a live preflight', async t => {
  const reserve = BigInt(readConfig({}).entryFeeReserves.bsc), cap = BigInt(caps.bsc);
  const ctx = setup(t, {balances: [cap + reserve], config: {entryMode: 'paper', gmgnPrivateKey: undefined}});
  const result = await ctx.controller.consider(ctx.candidate());
  assert.equal(result.order?.status, 'paper_open'); assert.equal(result.order?.inputAmount, caps.bsc);
  assert.equal(ctx.balanceReads(), 1); assert.equal(ctx.signedCalls.length, 0);
  const next = await ctx.controller.consider(ctx.candidate('another-paper-event', token('bsc', 4)));
  assert.equal(next.reason, 'ENTRY_INSUFFICIENT_BALANCE');
  assert.equal(ctx.readCalls.length, 1); assert.equal(ctx.signedCalls.length, 0);
});

test('a post-quote balance drop or read failure blocks the fixed quoted amount without requoting or submitting', async t => {
  const reserve = BigInt(readConfig({}).entryFeeReserves.bsc), cap = BigInt(caps.bsc);
  for (const extra of [{balances: [cap + reserve, cap + reserve - 1n]}, {rpcFailureAt: 2}, {unknownBalanceAt: 2}]) {
    const ctx = setup(t, extra);
    const result = await ctx.controller.consider(ctx.candidate());
    assert.equal(result.status, 'blocked'); assert.equal(result.order?.status, 'failed');
    assert.equal(result.order?.inputAmount, caps.bsc);
    assert.ok(['ENTRY_INSUFFICIENT_BALANCE', 'ENTRY_BALANCE_UNAVAILABLE'].includes(result.reason!));
    assert.equal(ctx.readCalls.length, 1); assert.equal(ctx.signedCalls.length, 0);
    assert.equal(ctx.balanceReads(), 2);
  }
});

test('candidate expiry during the second balance await is checked before signing and submission', async t => {
  const ctx = setup(t, {config: {decisionTtlSec: 1}, beforeBalance: async (read, clock) => {
    if (read === 2) {await Promise.resolve(); clock.time += 2000;}
  }});
  const result = await ctx.controller.consider(ctx.candidate());
  assert.equal(result.reason, 'ENTRY_CANDIDATE_EXPIRED');
  assert.equal(result.order?.status, 'failed');
  assert.equal(ctx.readCalls.length, 1); assert.equal(ctx.signedCalls.length, 0);
});

test('signed timestamp is generated after the balance preflight finishes', async t => {
  let preflightFinishedAt = 0;
  const ctx = setup(t, {beforeBalance: async (read, clock) => {
    if (read === 2) {await Promise.resolve(); clock.time += 2000; preflightFinishedAt = clock.time;}
  }});
  const started = ctx.clock.time;
  const result = await ctx.controller.consider(ctx.candidate());
  assert.equal(result.order?.status, 'submitted');
  const {url, init} = ctx.signedCalls[0];
  assert.equal(Number(url.searchParams.get('timestamp')), Math.floor(preflightFinishedAt / 1000));
  assert.ok(Number(url.searchParams.get('timestamp')) > Math.floor(started / 1000));
  const sorted = [...url.searchParams.keys()].sort().map(name => `${encodeURIComponent(name)}=${encodeURIComponent(url.searchParams.get(name)!)}`).join('&');
  const message = Buffer.from(`${url.pathname}:${sorted}:${init?.body}:${url.searchParams.get('timestamp')}`);
  assert.equal(verify(null, message, generated.publicKey,
    Buffer.from(new Headers(init?.headers).get('x-signature')!, 'base64')), true);
});

test('signals and vendor responses cannot choose caps, balance, fee reserves or execution fees', async t => {
  const reserve = BigInt(readConfig({}).entryFeeReserves.bsc), spendable = BigInt(caps.bsc) / 2n;
  const ctx = setup(t, {balances: [spendable + reserve], config: {exitPolicy: exitPolicy(), entryGasPriceBsc: '60000000'}});
  const report = ctx.candidate();
  const malicious = {input_amount: '999999999999999999999', entryAmounts: {bsc: '1'}, balance: '999999999999999999999',
    feeReserve: '0', entryFeeReserves: {bsc: '0'}, coveredOrderIds: ['fake'], gas_price: '10000000000'};
  report.signal.text = JSON.stringify(malicious); report.safety.facts = malicious; report.narrative.facts = malicious;
  report.gmgn = {token: report.signal.token, fetchedAt: report.evaluatedAt, diagnostics: [], info: malicious};
  const result = await ctx.controller.consider(report);
  assert.equal(result.order?.inputAmount, spendable.toString());
  assert.equal((result.order!.details.funding as Record<string, unknown>).feeReserve, reserve.toString());
  const body = JSON.parse(String(ctx.signedCalls[0].init?.body));
  assert.equal(body.input_amount, spendable.toString()); assert.equal(body.gas_price, '60000000');
});

test('pending and ambiguous submissions block additional live risk even with no exit and a known transaction hash', async t => {
  const cap = BigInt(caps.bsc), reserve = BigInt(readConfig({}).entryFeeReserves.bsc);
  for (const status of ['submitted', 'unknown'] as const) {
    const ctx = setup(t, {balances: [cap + 2n * reserve]});
    const prior = ctx.orders.reserve({eventKey: `prior-${status}`, chain: 'bsc', mode: 'live', tokenAddress: token('bsc', 4),
      wallet: wallet('bsc'), inputToken: NATIVE_INPUT_TOKENS.bsc, inputAmount: (cap / 2n).toString(), slippagePct: 5,
      details: {funding: {feeReserve: reserve.toString()}}}, 3, new Date(ctx.clock.time)).order!;
    ctx.orders.update(prior.id, ['prepared'], {status, transactionHash: hash, providerOrderId: 'prior-order'});
    const result = await ctx.controller.consider(ctx.candidate());
    assert.equal(result.status,'blocked');assert.equal(result.reason,'EXIT_PROTECTION_UNVERIFIED');
    assert.equal(ctx.orders.get(prior.id)?.inputAmount,(cap/2n).toString());
    assert.equal(ctx.rpcCalls.some(call => call.method === 'eth_getTransactionReceipt'), false);
    assert.equal(ctx.readCalls.length,0);assert.equal(ctx.signedCalls.length,0);
  }
});

test('parallel paper candidates share the same native budget and both retain their own fee buffer', async t => {
  const cap = BigInt(caps.bsc), reserve = BigInt(readConfig({}).entryFeeReserves.bsc);
  const balance = cap + cap / 2n + 2n * reserve;
  const ctx = setup(t, {balances: [balance],config:{entryMode:'paper'}});
  const results = await Promise.all([
    ctx.controller.consider(ctx.candidate('parallel-a')),
    ctx.controller.consider(ctx.candidate('parallel-b', token('bsc', 4))),
  ]);
  assert.ok(results.every(result => result.order?.status === 'paper_open'));
  const amounts = results.map(result => BigInt(result.order!.inputAmount)).sort((a, b) => a < b ? -1 : 1);
  assert.deepEqual(amounts, [cap / 2n, cap]);
  assert.equal(amounts[0] + amounts[1] + 2n * reserve, balance);
  assert.equal(ctx.signedCalls.length, 0);
});

test('parallel live candidates cannot create a second unprotected position', async t => {
  const ctx=setup(t);
  const results=await Promise.all([ctx.controller.consider(ctx.candidate('live-a')),
    ctx.controller.consider(ctx.candidate('live-b',token('bsc',4)))]);
  assert.equal(results.filter(r=>r.order?.status==='submitted').length,1);
  assert.equal(results.filter(r=>r.reason==='EXIT_PROTECTION_UNVERIFIED').length,1);
  assert.equal(ctx.readCalls.length,1);assert.equal(ctx.signedCalls.length,1);assert.equal(ctx.orders.list().length,1);
});
