import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import bs58 from 'bs58';
import {HeldPositionMonitor, type HeldPositionMonitorOptions} from '../src/held-position-monitor.js';
import type {HeldPositionSeed} from '../src/held-position-source.js';
import type {SolanaSnapshot} from '../src/controlled-test/types.js';
import type {ScanPrice} from '../src/scan-archive.js';

const epoch = Date.parse('2026-10-25T10:00:00.000Z');
const sol = 'So11111111111111111111111111111111111111112';
const wallet = bs58.encode(new Uint8Array(32).fill(1));
const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const signature = bs58.encode(new Uint8Array(64).fill(2));
const seed = (): HeldPositionSeed => ({id: 'controlled-test:monitor-fixture', source: 'controlled_test', chain: 'solana',
  wallet, tokenAddress: mint, symbol: 'BONK', providerOrderId: 'buy-order', transactionHash: signature,
  inputAmount: '10000000', outputAmount: '1000000', tokenDecimals: 6,
  confirmedAt: new Date(epoch - 60_000).toISOString(), buySlot: 100, costBasis: 'requested_exact_in'});
const fill = () => ({order_id: 'buy-order', hash: signature, status: 'confirmed', state: 30,
  report: {input_token: sol, output_token: mint, input_amount: '10000000', output_amount: '1000000',
    input_token_decimals: 9, output_token_decimals: 6, swap_mode: 'ExactIn', price: '0.01', price_usd: '1', height: 100}});
const protection = () => ({list: [{chain: 'sol', wallet_address: wallet, base_token: mint, quote_token: sol,
  order_id: 'protection-order', open_sign_hash: signature, order_type: 'smart_trade', sub_order_type: 'mix_trade',
  sell_ratio_type: 'hold_amount', status: 'open', strategy_status: 'running',
  condition_orders: [
    {cid: 'take-profit', order_type: 'profit_stop', side: 'sell', price_scale: '100', sell_ratio: '50', status: 'check', check_price: '2'},
    {cid: 'stop-loss', order_type: 'loss_stop', side: 'sell', price_scale: '60', sell_ratio: '100', status: 'check', check_price: '0.4'},
  ]}], next_page_token: ''});
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {promise: new Promise<T>(r => {resolve = r;}), resolve: (value: T) => resolve(value)};
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(initialSeed: HeldPositionSeed = seed()) {
  const dir = mkdtempSync(join(tmpdir(), 'held-monitor-')), path = join(dir, 'monitor.sqlite');
  let now = epoch, quantity = '1000000', slot = 110, enqueueFails = false;
  let seeds = [initialSeed];
  let query: HeldPositionMonitorOptions['query'] = async () => fill();
  let strategies: HeldPositionMonitorOptions['strategies'] = async () => protection();
  const defaultBalance = (): SolanaSnapshot => ({wallet, mint, nativeLamports: '1000000000', tokenAmount: quantity,
    decimals: 6, slot, nativeSlot: slot, mintAuthority: null, freezeAuthority: null,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', extensions: [], checkedAt: new Date(now).toISOString()});
  let balance: HeldPositionMonitorOptions['balance'] = async () => defaultBalance();
  const events: {key: string; text: string}[] = [], seen = new Set<string>();
  const calls = {query: 0, strategies: 0, balance: 0, enqueue: 0};
  const options: HeldPositionMonitorOptions = {now: () => now, seeds: () => seeds,
    query: async value => {calls.query++; return query(value);},
    strategies: async value => {calls.strategies++; return strategies(value);},
    balance: async value => {calls.balance++; return balance(value);},
    enqueue: event => {
      calls.enqueue++;
      if (enqueueFails) throw new Error('mock-private-queue-error');
      // Mirrors TelegramNotifier: false means this event already exists durably.
      if (seen.has(event.key)) return false;
      seen.add(event.key); events.push({...event}); return true;
    }};
  let monitor = new HeldPositionMonitor(path, options);
  return {get monitor() {return monitor;}, calls, events,
    advance(ms: number) {now += ms;}, now: () => now,
    setQuery(value: typeof query) {query = value;}, setStrategies(value: typeof strategies) {strategies = value;},
    setBalance(value: typeof balance) {balance = value;}, defaultBalance,
    setQuantity(value: string) {quantity = value; slot++;}, failQueue(value: boolean) {enqueueFails = value;},
    setSeeds(value: HeldPositionSeed[]) {seeds = value;},
    price(usd: number, patch: Partial<ScanPrice> & {conflict?: boolean; status?: string} = {}): ScanPrice {
      return {chain: 'solana', address: mint, priceUsd: usd, observedAt: new Date(now).toISOString(),
        source: 'debot_price_stream_sample', ...patch};
    },
    observe(usd: number) {now++; return monitor.observePrice(this.price(usd));},
    restart() {monitor.close(); monitor = new HeldPositionMonitor(path, options);},
    async close() {await monitor.stop(); monitor.close(); rmSync(dir, {recursive: true, force: true});}};
}
const milestones = (events: {key: string; text: string}[]) => events.filter(event => event.key.includes(':milestone:'));

test('held price gains use the confirmed fill, never the first sampled price', async () => {
  const f = fixture();
  try {
    assert.equal(f.observe(3), true);
    assert.equal(f.monitor.status().positions[0].entryPriceUsd, undefined);
    assert.equal(f.monitor.status().positions[0].gainPct, undefined);
    assert.equal(milestones(f.events).length, 0);
    await f.monitor.runOnce();
    const position = f.monitor.status().positions[0];
    assert.equal(position.entryPriceUsd, 1); assert.equal(position.gainPct, 200);
    assert.equal(position.entryBasis, 'gmgn_confirmed_fill_usd');
    assert.equal(position.protection?.policyMatched, true);
    assert.equal(position.protection?.automaticTriggerVerified, false);
    assert.equal(f.observe(3.1), true);
    const alert = milestones(f.events).at(-1)!;
    assert.match(alert.text, /相对买入价：\+210\.00%/);
    assert.match(alert.text, /买入美元价：\$1\n最新价格：\$3\.1/);
    assert.match(alert.text, /不等于 SOL 净收益/);
  } finally {await f.close();}
});

test('an invalid GMGN fill leaves the baseline unknown while other source prices continue accumulating', async () => {
  const f = fixture({...seed(), entryPriceUsd: 999});
  f.setQuery(async () => ({...fill(), hash: bs58.encode(new Uint8Array(64).fill(5))}));
  try {
    await f.monitor.runOnce(); assert.equal(f.observe(1.5), true);
    const position = f.monitor.status().positions[0];
    assert.equal(position.entryBasis, 'pending_verification'); assert.equal(position.gainPct, undefined);
    assert.equal(position.latest?.usd, 1.5); assert.equal(milestones(f.events).length, 0);
    f.setQuery(async () => fill()); f.advance(30_001); await f.monitor.runOnce();
    assert.equal(f.monitor.status().positions[0].gainPct, 50);
    assert.equal(f.monitor.status().positions[0].entryPriceUsd, 1);
  } finally {await f.close();}
});

test('one price jump combines gain thresholds, stays silent on loss, and survives restart without duplicates', async () => {
  const f = fixture();
  try {
    await f.monitor.runOnce();
    f.observe(1.6);
    assert.equal(milestones(f.events).length, 1);
    assert.match(milestones(f.events)[0].text, /价格越过 \+50\.00%/);
    f.observe(1.7); assert.equal(milestones(f.events).length, 1);
    f.observe(0.55);
    assert.equal(milestones(f.events).length, 1);
    assert.ok(Math.abs(f.monitor.status().positions[0].gainPct! + 45) < 1e-9);
    f.observe(1.6); assert.equal(milestones(f.events).length, 1);
    f.observe(2.1); assert.equal(milestones(f.events).length, 2);
    assert.match(milestones(f.events)[1].text, /价格越过 \+100\.00%/);
    f.restart(); await f.monitor.runOnce(); f.observe(2.2);
    assert.equal(milestones(f.events).length, 2);
    f.observe(4);
    assert.equal(milestones(f.events).length, 3);
    assert.match(milestones(f.events)[2].text, /价格越过 \+200\.00%/);
    assert.deepEqual(f.monitor.status().positions[0].milestones, [50, 100, 200]);
  } finally {await f.close();}
});

test('balance failures preserve monitoring; an authoritative zero permanently retires polling and price observation', async () => {
  const f = fixture();
  try {
    await f.monitor.runOnce();
    f.setBalance(async () => {throw new Error('private-node-url');});
    f.advance(30_001); await f.monitor.runOnce();
    assert.equal(f.monitor.status().activePositions, 1); assert.equal(f.monitor.tokens().length, 1);
    assert.equal(f.monitor.status().positions[0].errors.balance, 'HELD_BALANCE_UNAVAILABLE');
    assert.equal(f.observe(1.5), true); assert.equal(milestones(f.events).length, 1);
    f.setBalance(async () => f.defaultBalance()); f.setQuantity('0'); f.advance(30_001); await f.monitor.runOnce();
    assert.equal(f.monitor.status().activePositions, 0); assert.deepEqual(f.monitor.tokens(), []);
    assert.equal(f.monitor.status().positions[0].status, 'balance_zero');
    assert.equal(f.monitor.status().positions[0].terminal, true);
    assert.equal(f.monitor.status().positions[0].retiredAt, new Date(f.now()).toISOString());
    assert.equal(f.observe(3), false); assert.equal(milestones(f.events).length, 1);
    assert.equal(f.events.filter(event => /余额已核验为 0/.test(event.text)).length, 0);
    const callsAtRetirement = {...f.calls};
    f.setQuantity('500000'); f.advance(30_001); await f.monitor.runOnce();
    assert.deepEqual(f.calls, callsAtRetirement);
    assert.equal(f.monitor.status().activePositions, 0); assert.deepEqual(f.monitor.tokens(), []);
    assert.equal(f.observe(2), false); assert.equal(milestones(f.events).length, 1);
    f.restart(); f.advance(30_001); await f.monitor.runOnce();
    assert.deepEqual(f.calls, callsAtRetirement);
    assert.equal(f.monitor.status().positions[0].terminal, true);
    f.setSeeds([]); await f.monitor.runOnce(); f.setSeeds([seed()]); await f.monitor.runOnce();
    assert.deepEqual(f.calls, callsAtRetirement);
    assert.equal(f.monitor.status().activePositions, 0);
  } finally {await f.close();}
});

test('stale or mismatched zero balances cannot close a position', async () => {
  const f = fixture();
  try {
    await f.monitor.runOnce();
    for (const patch of [{slot: 99}, {wallet: bs58.encode(new Uint8Array(32).fill(8))},
      {decimals: 5}, {checkedAt: new Date(epoch - 61_000).toISOString()}]) {
      f.setBalance(async () => ({...f.defaultBalance(), tokenAmount: '0', ...patch}));
      f.advance(30_001); await f.monitor.runOnce();
      assert.equal(f.monitor.status().activePositions, 1); assert.equal(f.monitor.tokens().length, 1);
    }
    assert.equal(f.events.some(event => /余额已核验为 0/.test(event.text)), false);
  } finally {await f.close();}
});

test('GMGN errors and a pending strategy read do not block independent stream price updates', async () => {
  const f = fixture();
  try {
    await f.monitor.runOnce(); f.observe(1);
    f.setStrategies(async () => {throw new Error('GMGN-429-private-response');});
    f.advance(60_001); await f.monitor.runOnce();
    assert.equal(f.monitor.status().positions[0].errors.protection, 'HELD_PROTECTION_UNAVAILABLE');
    assert.equal(f.observe(1.5), true); assert.equal(milestones(f.events).length, 1);
    const pending = deferred<unknown>(); f.setStrategies(async () => pending.promise);
    f.advance(60_001); const cycle = f.monitor.runOnce(); await flush();
    assert.equal(f.monitor.status().inFlight, true);
    assert.equal(f.observe(2), true); assert.equal(milestones(f.events).length, 2);
    pending.resolve(protection()); await cycle;
    assert.equal(f.monitor.status().positions[0].errors.protection, undefined);
    assert.equal(f.monitor.status().positions[0].protection?.policyMatched, true);
  } finally {await f.close();}
});

test('stale, future, conflicting, wrong-identity and unsupported prices never generate gain alerts', async () => {
  const f = fixture();
  try {
    await f.monitor.runOnce(); f.observe(1);
    const count = f.events.length, initial = structuredClone(f.monitor.status().positions[0].latest);
    f.advance(1); // Otherwise a duplicate timestamp would mask failures in conflict/source validation.
    for (const patch of [
      {observedAt: new Date(f.now() - 90_001).toISOString()}, {observedAt: new Date(f.now() + 1).toISOString()},
      {observedAt: 'invalid-date'}, {conflict: true}, {status: 'conflict'},
      {source: 'untrusted_spot'}, {source: 'chain_pool_sample'}, {chain: 'bsc' as const},
      {address: sol}, {priceUsd: 0}, {priceUsd: -1}, {priceUsd: NaN}, {priceUsd: Infinity},
    ]) assert.equal(f.monitor.observePrice(f.price(100, patch)), false);
    assert.equal(f.events.length, count);
    assert.deepEqual(f.monitor.status().positions[0].latest, initial);
    assert.equal(milestones(f.events).length, 0);
    assert.equal(f.observe(0.75), true); assert.equal(milestones(f.events).length, 0);
    assert.equal(f.monitor.status().positions[0].gainPct, -25);
  } finally {await f.close();}
});

test('failed Telegram queue writes survive restart and recover without losing or replaying milestone events', async () => {
  const f = fixture(); f.failQueue(true);
  try {
    await f.monitor.runOnce(); f.observe(1.6);
    assert.equal(f.events.length, 0); assert.equal(f.monitor.status().pendingEvents, 1);
    assert.equal(f.monitor.status().lastError, 'HELD_TELEGRAM_QUEUE_UNAVAILABLE');
    f.restart(); f.failQueue(false); await f.monitor.runOnce();
    assert.equal(f.monitor.status().pendingEvents, 0); assert.equal(f.events.length, 1);
    assert.equal(milestones(f.events).length, 1);
    const keys = f.events.map(event => event.key);
    f.restart(); await f.monitor.runOnce(); f.observe(1.7);
    assert.deepEqual(f.events.map(event => event.key), keys);
  } finally {await f.close();}
});

test('recordPriceError sanitizes state and recovery without Telegram noise', async () => {
  const f = fixture(), secret = 'secret-api-key https://rpc.invalid/private-query';
  try {
    await f.monitor.runOnce(); f.observe(1);
    f.advance(60_001);
    const token = {chain: 'solana' as const, address: mint};
    f.monitor.recordPriceError(token, secret); f.monitor.recordPriceError(token, secret);
    assert.equal(f.monitor.status().positions[0].errors.price, 'HELD_PRICE_UNAVAILABLE');
    assert.equal(f.events.filter(event => event.key.includes(':alert:price:')).length, 0);
    assert.equal(JSON.stringify({status: f.monitor.status(), events: f.events}).includes(secret), false);
    assert.equal(f.observe(1.12), true);
    assert.equal(f.monitor.status().positions[0].errors.price, undefined);
    assert.equal(f.events.filter(event => event.key.includes(':recovered:price:')).length, 0);
    f.advance(60_001); f.monitor.recordPriceError(token, secret);
    assert.equal(f.events.filter(event => event.key.includes(':alert:price:')).length, 0);
    assert.equal(JSON.stringify({status: f.monitor.status(), events: f.events}).includes(secret), false);
  } finally {await f.close();}
});

test('updated live tiers start at 50%, persist new tiers, then notify each additional entry-price multiple',async()=>{
  const f=fixture();
  try {
    await f.monitor.runOnce();f.observe(1.1);f.observe(1.25);f.observe(1.49);
    assert.equal(milestones(f.events).length,0);
    f.observe(21);
    assert.deepEqual(f.monitor.status().positions[0].milestones,[50,100,200,500,1000,1500,2000]);
    assert.match(milestones(f.events)[0].text,/\+1500\.00%、\+2000\.00%/);
    f.restart();await f.monitor.runOnce();f.observe(21.99);
    assert.equal(milestones(f.events).length,1);
    f.observe(22);assert.match(milestones(f.events)[1].text,/\+2100\.00%/);
    f.observe(23);assert.match(milestones(f.events)[2].text,/\+2200\.00%/);
    assert.equal(milestones(f.events).length,3);
    f.observe(1e200);
    const event=milestones(f.events).at(-1)!;
    assert.ok(event.key.length<=512);assert.ok(event.text.length<=4096);
  }finally {await f.close();}
});
