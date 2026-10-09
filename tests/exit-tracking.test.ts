import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {assessExitStrategy, type ExpectedExitStrategy} from '../src/exit-tracking.js';

const now = new Date('2026-10-09T01:00:00Z');
const expected: ExpectedExitStrategy = {
  strategyOrderId: 'strategy-1', chain: 'bsc', wallet: '0x' + 'a'.repeat(40),
  tokenAddress: '0x' + 'b'.repeat(40), inputToken: '0x' + '0'.repeat(40),
  sellRatioType: 'hold_amount', openingTransactionHash: '0x' + 'c'.repeat(64),
  policyConditions: [
    {order_type: 'profit_stop', side: 'sell', price_scale: '500', sell_ratio: '20'},
    {order_type: 'profit_stop', side: 'sell', price_scale: '1000', sell_ratio: '10'},
    {order_type: 'loss_stop', side: 'sell', price_scale: '40', sell_ratio: '100'},
  ],
};
const row = () => ({
  order_id: expected.strategyOrderId, chain: 'bsc', wallet_address: expected.wallet,
  base_token: expected.tokenAddress, quote_token: expected.inputToken,
  open_sign_hash: expected.openingTransactionHash, order_type: 'smart_trade', sub_order_type: 'mix_trade',
  sell_ratio_type: 'hold_amount', status: 'closed', strategy_status: 'stopped', token_balance: '0',
  condition_orders: expected.policyConditions.map((condition, index) => ({...condition, cid: `child-${index}`, status: 'cancel'})),
});
const page = (entry: unknown = row()) => ({next_page_token: '', list: [entry]});

test('只确认准确匹配的终止策略，余额仍须独立核对；策略终止不改买单', () => {
  const input = page(), before = structuredClone(input);
  const result = assessExitStrategy(input, expected, now);
  assert.equal(result.status, 'terminal'); assert.equal(result.terminal, true);
  assert.equal(result.policyMatched, true); assert.equal(result.hasLiveStop, false);
  assert.equal(result.checkedAt, now.toISOString());
  assert.deepEqual(result.reasons, ['EXIT_STRATEGY_TERMINAL_BALANCE_CHECK_REQUIRED']);
  assert.deepEqual(input, before);
  assert.equal(Object.hasOwn(result, 'positionClosed'), false);
  assert.equal(Object.hasOwn(result, 'remainingAmount'), false);
});

test('子单未知状态、数字枚举或空状态不能猜为活跃或终止', () => {
  for (const state of [undefined, '', 0, 1, 2, 'pending', 'running', 'open']) {
    const entry = row();
    Object.assign(entry.condition_orders[2], {status: state});
    for (const parent of [{status: 'closed', strategy_status: 'stopped'}, {status: 'open', strategy_status: 'running'}]) {
      Object.assign(entry, parent);
      const result = assessExitStrategy(page(entry), expected, now);
      assert.equal(result.policyMatched, true); assert.equal(result.status, 'unknown');
      assert.equal(result.hasLiveStop, false); assert.equal(result.terminal, false);
      assert.deepEqual(result.reasons, ['EXIT_CONDITION_STATUS_UNKNOWN']);
    }
  }
});

test('零余额、卖出成功计数、全部子单success都不能代替父策略终止', () => {
  const entry = row(); Object.assign(entry, {status: 'open', strategy_status: 'running',
    order_statistic: {sell_num: 4, success_sell_num: 2, sell_amount: '999', success_sell_amount: '999'}});
  for (const child of entry.condition_orders) child.status = 'success';
  const result = assessExitStrategy(page(entry), expected, now);
  assert.equal(result.terminal, false); assert.equal(result.status, 'degraded');
  assert.equal(result.reportedSuccessfulSellCount, 2);
  assert.equal(Object.hasOwn(result, 'remainingAmount'), false);
});

test('精确策略ID、链、钱包、CA、计价币和买入哈希必须同时相符', () => {
  for (const patch of [
    {order_id: 'another-id'}, {chain: 'robinhood'}, {wallet_address: '0x' + 'd'.repeat(40)},
    {base_token: '0x' + 'd'.repeat(40)}, {quote_token: '0x' + 'd'.repeat(40)},
    {open_sign_hash: '0x' + 'd'.repeat(64)}, {open_sign_hash: ''},
  ]) {
    const result = assessExitStrategy(page({...row(), ...patch}), expected, now);
    assert.equal(result.found, false); assert.equal(result.terminal, false); assert.equal(result.policyMatched, false);
  }
  const entry = row(); entry.wallet_address = '0x' + 'A'.repeat(40); entry.base_token = '0x' + 'B'.repeat(40);
  assert.equal(assessExitStrategy(page(entry), expected, now).terminal, true);
});

test('缺页、空页和重复策略ID只表示未知，不触发补挂或关闭', () => {
  for (const payload of [null, [], {}, {list: []}, {next_page_token: 'next', list: []},
    {next_page_token: '', list: [row(), row()]}, {data: page()}]) {
    const result = assessExitStrategy(payload, expected, now);
    assert.equal(result.status, 'unknown'); assert.equal(result.terminal, false); assert.equal(result.hasLiveStop, false);
  }
});

test('三条规则按参数集合匹配，顺序无关；缺失、重复、改比例和错误基准均不通过', () => {
  const valid = row(); valid.condition_orders.reverse();
  valid.condition_orders[0].price_scale = '40.00';
  assert.equal(assessExitStrategy(page(valid), expected, now).terminal, true);
  for (const entry of [
    {...row(), sell_ratio_type: 'buy_amount'},
    {...row(), sub_order_type: 'take_profit'},
    {...row(), condition_orders: row().condition_orders.slice(0, 2)},
    {...row(), condition_orders: [...row().condition_orders, row().condition_orders[0]]},
    {...row(), condition_orders: [row().condition_orders[0], row().condition_orders[0], row().condition_orders[2]]},
  ]) assert.equal(assessExitStrategy(page(entry), expected, now).terminal, false);
  for (const patch of [{sell_ratio: '20'}, {price_scale: '-40'}, {price_scale: '0.4'}, {side: 'buy'}, {cid: 'child-0'}]) {
    const entry = row(); Object.assign(entry.condition_orders[2], patch);
    assert.equal(assessExitStrategy(page(entry), expected, now).terminal, false);
  }
});

test('Solana 地址必须区分大小写且为有效32字节地址；仅记录已验证格式的关闭哈希', () => {
  const wallet = bs58.encode(new Uint8Array(32).fill(1)), token = bs58.encode(new Uint8Array(32).fill(2));
  const quote = bs58.encode(new Uint8Array(32).fill(3)), hash = bs58.encode(new Uint8Array(64).fill(4));
  const solExpected: ExpectedExitStrategy = {...expected, chain: 'solana', wallet, tokenAddress: token,
    inputToken: quote, openingTransactionHash: hash};
  const entry = {...row(), chain: 'sol', wallet_address: wallet, base_token: token, quote_token: quote,
    open_sign_hash: hash, close_sign_hash: hash};
  const result = assessExitStrategy(page(entry), solExpected, now);
  assert.equal(result.terminal, true); assert.equal(result.closeTransactionHash, hash);
  assert.equal(assessExitStrategy(page({...entry, base_token: token.toLowerCase()}), solExpected, now).terminal, false);
  assert.equal(assessExitStrategy(page({...entry, close_sign_hash: 'untrusted\ntext'}), solExpected, now).closeTransactionHash, undefined);
});

test('未知父状态不能解释成关闭，任一取消或失败子单也不证明卖出成交', () => {
  for (const parent of [{status: 2, strategy_status: 0}, {status: 'closed', strategy_status: 'running'},
    {status: 'open', strategy_status: 'stopped'}]) {
    assert.equal(assessExitStrategy(page({...row(), ...parent}), expected, now).terminal, false);
  }
  const entry = row(); entry.condition_orders[0].status = 'failed';
  const result = assessExitStrategy(page(entry), expected, now);
  assert.equal(result.terminal, true); assert.equal(result.conditions[0].status, 'failed');
  assert.equal(result.reportedSuccessfulSellCount, undefined);
});
