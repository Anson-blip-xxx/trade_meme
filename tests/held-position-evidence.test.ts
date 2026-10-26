import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {heldProtection, validatedHeldFill} from '../src/held-position-evidence.js';
import type {HeldPositionSeed} from '../src/held-position-source.js';

const SOL = 'So11111111111111111111111111111111111111112';
const wallet = 'whihCFMAG28yFv9ZijWroHz4opEkBfsXHPrTFdTzBhK';
const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const signature = '38QX9uviXmvbupeRfdtLBGziNFhjXEX6AZVqJxGEPwzVYUa5tcE819UDew9Ev7QN3dGWb6SNu4PSf9nZbSkfXUh3';
const now = new Date('2026-10-25T09:13:25.646Z');
const seed: HeldPositionSeed = {id: 'controlled-test:sample', source: 'controlled_test', chain: 'solana', wallet,
  tokenAddress: mint, providerOrderId: 'od10sol0000001a17251c82faefbb7be37cc8789', transactionHash: signature,
  inputAmount: '10000000', outputAmount: '33696514738', tokenDecimals: 5, buySlot: 461200851,
  confirmedAt: '2026-10-25T09:08:46.197Z', costBasis: 'requested_exact_in'};
function fill(): any {
  return {status: 'confirmed', hash: signature, order_id: seed.providerOrderId,
    report: {input_token: SOL, input_token_decimals: 9, swap_mode: 'ExactIn', input_amount: seed.inputAmount,
      output_token: mint, output_token_decimals: 5, output_amount: seed.outputAmount, quote_token: SOL, quote_decimals: 9,
      quote_amount: seed.inputAmount, base_token: mint, base_decimals: 5, base_amount: seed.outputAmount,
      price: '0.0000000296766597', price_usd: '0.000002994078197133', height: seed.buySlot}};
}
function parent(): any {
  return {order_id: '73920fa5-d438-448b-b236-962da2ed26b4', chain: 'sol', wallet_address: wallet,
    base_token: mint, quote_token: SOL, base_decimal: 5, quote_decimal: 9, quote_investment: seed.inputAmount,
    open_amount: seed.outputAmount, open_sign_hash: '', create_time: 1792919325387,
    order_type: 'smart_trade', sub_order_type: 'mix_trade', sell_ratio_type: 'hold_amount',
    status: 'open', strategy_status: 'running', order_statistic: {buy_amount: seed.outputAmount},
    custom_rpc: 'https://private-rpc.invalid/?secret=hidden',
    condition_orders: [
      {cid: 'tp-1', order_type: 'profit_stop', side: 'sell', price_scale: '100', sell_ratio: '50', status: 'check', check_price: '0.000005988156394266'},
      {cid: 'sl-1', order_type: 'loss_stop', side: 'sell', price_scale: '60', sell_ratio: '100', status: 'check', check_price: '0.0000011976312788532'},
    ]};
}
const page = (row = parent()) => ({list: [row], total: 1, next_page_token: ''});

test('actual BONK fill price is bound to the exact query-order receipt and rounded SOL price matches atomic ratio', () => {
  const result = validatedHeldFill(seed, fill());
  assert.ok(result); assert.equal(result.priceUsd, 0.000002994078197133);
  assert.equal(result.priceSol, 10000000 * 1e5 / (33696514738 * 1e9));
  assert.equal(result.verifiedAt, undefined);
  assert.equal(seed.entryPriceUsd, undefined, 'The pure validator must not mutate its input');
});

test('current token prices, missing receipts, mismatched identities and unconfirmed statuses cannot establish a fill baseline', () => {
  for (const patch of [{status: 'pending'}, {status: 'submitted'}, {status: 'success'}, {status: 'failed'}, {state: 10},
    {order_id: 'other'}, {hash: bs58.encode(new Uint8Array(64).fill(7))}, {report: undefined}])
    assert.equal(validatedHeldFill(seed, {...fill(), ...patch}), undefined);
  for (const raw of [null, [], {price: 1, price_usd: 2}, {token: {price: 2}}, {success: true, data: fill()}])
    assert.equal(validatedHeldFill(seed, raw), undefined);
  assert.equal(validatedHeldFill({...seed, providerOrderId: undefined}, fill()), undefined);
  assert.equal(validatedHeldFill({...seed, tokenDecimals: 256}, fill()), undefined);
  assert.ok(validatedHeldFill(seed, {...fill(), status: 'successful', state: 30}));
});

test('fill amounts, mint decimals, aliases and slot must all preserve the immutable chain evidence', () => {
  for (const patch of [{input_token: mint}, {output_token: SOL}, {input_amount: '9999999'}, {output_amount: '33696514739'},
    {input_amount: 10000000}, {output_amount: 33696514738}, {input_token_decimals: 8}, {output_token_decimals: 6},
    {quote_token: mint}, {quote_amount: '1'}, {base_token: SOL}, {base_amount: '1'}, {quote_decimals: 8},
    {base_decimals: 6}, {height: seed.buySlot + 1}, {swap_mode: 'ExactOut'}]) {
    const raw = fill(); Object.assign(raw.report, patch);
    assert.equal(validatedHeldFill(seed, raw), undefined, JSON.stringify(patch));
  }
});

test('SOL price mismatch and malformed or non-positive USD values are rejected rather than substituted with current prices', () => {
  for (const price of ['0.000000029', '0.00000003', '0', '-1', 'NaN', Infinity, {}, ' 0.0000000296766597']) {
    const raw = fill(); raw.report.price = price;
    assert.equal(validatedHeldFill(seed, raw), undefined);
  }
  for (const price of [undefined, null, 0, '-1', 'NaN', Infinity, {}, '1e999', '01']) {
    const raw = fill(); raw.report.price_usd = price; raw.token = {price: 1};
    assert.equal(validatedHeldFill(seed, raw), undefined);
  }
});

test('atomic quantity matching remains exact above Number.MAX_SAFE_INTEGER', () => {
  const large = {...seed, inputAmount: '9007199254740993', outputAmount: '18446744073709551615', tokenDecimals: 9};
  const raw = fill(); raw.report = {input_token: SOL, output_token: mint, input_token_decimals: 9, output_token_decimals: 9,
    swap_mode: 'ExactIn', input_amount: large.inputAmount, output_amount: large.outputAmount,
    price: '0.0004882812500000000542365786780395979', price_usd: '0.05'};
  assert.ok(validatedHeldFill(large, raw));
  raw.report.output_amount = '18446744073709551614';
  assert.equal(validatedHeldFill(large, raw), undefined);
});

test('blank opening hash uses a clearly labeled amount/time match and preserves the actual check statuses', () => {
  const result = heldProtection(seed, page(), now);
  assert.equal(result.status, 'observed'); assert.equal(result.linkage, 'amount_time_match');
  assert.equal(result.parentId, parent().order_id); assert.equal(result.parentStatus, 'open');
  assert.equal(result.strategyStatus, 'running'); assert.equal(result.policyMatched, true);
  assert.deepEqual(result.conditions.map(condition => condition.status), ['check', 'check']);
  assert.equal(result.automaticTriggerVerified, false);
  assert.ok(result.reasons.includes('HELD_PROTECTION_AMOUNT_TIME_MATCH_ONLY'));
  assert.doesNotMatch(JSON.stringify(result), /private-rpc|secret|hidden|foreign/i);
});

test('exact transaction hash yields stronger linkage while a nonmatching nonempty hash cannot fall back to amount/time', () => {
  const row = parent(); row.open_sign_hash = signature;
  assert.equal(heldProtection(seed, page(row), now).linkage, 'transaction_hash');
  row.open_sign_hash = bs58.encode(new Uint8Array(64).fill(9));
  const result = heldProtection(seed, page(row), now);
  assert.equal(result.status, 'not_observed'); assert.equal(result.linkage, 'none'); assert.equal(result.candidateCount, 0);
});

test('amount/time candidates require exact wallet, token, input/output quantities, decimals and a bounded creation time', () => {
  for (const patch of [{wallet_address: mint}, {base_token: SOL}, {quote_token: mint}, {chain: 'bsc'},
    {quote_investment: '9999999'}, {open_amount: '33696514739'}, {quote_investment: 10000000},
    {base_decimal: 6}, {quote_decimal: 8}, {create_time: 1792919325}, {create_time: undefined},
    {create_time: Date.parse(seed.confirmedAt) - 120001}, {create_time: now.getTime() + 6000},
    {order_statistic: {buy_amount: '1'}}]) {
    assert.equal(heldProtection(seed, page({...parent(), ...patch}), now).status, 'not_observed', JSON.stringify(patch));
  }
});

test('zero, multiple and incomplete candidate sets remain explicit and cannot claim a verified protection', () => {
  assert.equal(heldProtection(seed, {list: [], next_page_token: ''}, now).status, 'not_observed');
  const row = parent(), other = {...parent(), order_id: 'other-parent'};
  for (const list of [[row, other], [row, row]]) {
    const result = heldProtection(seed, {list, next_page_token: ''}, now);
    assert.equal(result.status, 'ambiguous'); assert.equal(result.candidateCount, 2); assert.equal(result.policyMatched, false);
  }
  for (const payload of [{list: [row], next_page_token: 'next'}, {list: [row], total: 2, next_page_token: ''}]) {
    const result = heldProtection(seed, payload, now);
    assert.equal(result.status, 'incomplete'); assert.equal(result.policyMatched, false);
  }
});

test('missing, duplicate, changed or malformed conditions are exposed as policy changes', () => {
  for (const mutate of [
    (r: any) => {r.condition_orders.pop();},
    (r: any) => {r.condition_orders[1].cid = r.condition_orders[0].cid;},
    (r: any) => {r.condition_orders[0].price_scale = '101';},
    (r: any) => {r.condition_orders[0].price_scale = '100.00000000000000001';},
    (r: any) => {r.condition_orders[0].sell_ratio = '100';},
    (r: any) => {r.condition_orders[1].side = 'buy';},
    (r: any) => {r.condition_orders[1].status = 0;},
    (r: any) => {r.sell_ratio_type = 'buy_amount';},
    (r: any) => {r.order_type = 'limit_order';},
  ]) {
    const row = parent(); mutate(row);
    const result = heldProtection(seed, page(row), now);
    assert.equal(result.status, 'conditions_changed'); assert.equal(result.policyMatched, false);
    assert.equal(result.automaticTriggerVerified, false);
  }
});

test('known entry USD basis additionally checks actual trigger prices without treating success/cancel as chain fill proof', () => {
  const enriched = {...seed, entryPriceUsd: 0.000002994078197133};
  assert.equal(heldProtection(enriched, page(), now).policyMatched, true);
  const wrongPrice = parent(); wrongPrice.condition_orders[0].check_price = '0.00001';
  assert.equal(heldProtection(enriched, page(wrongPrice), now).status, 'conditions_changed');
  const terminal = parent(); terminal.status = 'closed'; terminal.strategy_status = 'stopped';
  terminal.condition_orders[0].status = 'success'; terminal.condition_orders[1].status = 'cancel';
  const result = heldProtection(enriched, page(terminal), now);
  assert.deepEqual(result.conditions.map(condition => condition.status), ['success', 'cancel']);
  assert.equal(result.automaticTriggerVerified, false);
});

test('invalid response shapes and unsafe parent labels return bounded diagnostics without leaking raw metadata', () => {
  for (const payload of [null, [], {list: [null]}, {list: [], next_page_token: 123}, {list: [], total: -1},
    {list: [], next_page_token: 'x'.repeat(4097)}])
    assert.equal(heldProtection(seed, payload, now).status, 'invalid');
  const row = parent(); row.status = 'secret URL https://private.invalid/';
  const result = heldProtection(seed, page(row), now);
  assert.equal(result.status, 'invalid'); assert.doesNotMatch(JSON.stringify(result), /secret|private\.invalid/);
  assert.equal(heldProtection(seed, page(), new Date(NaN)).status, 'invalid');
});
