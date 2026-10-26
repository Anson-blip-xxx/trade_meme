import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExitConditions, ExitPolicyError, parseExitPolicy, type ExitPolicy,
} from '../src/exit-policy.js';

const settings = () => ({
  enabled: true,
  sellRatioType: 'hold_amount',
  takeProfit: [{gainPct: 500, sellPct: 20}, {gainPct: 1000, sellPct: 10}],
  stopLoss: {dropPct: 40, sellPct: 100},
});
const invalid = (input: unknown, reason = 'EXIT_POLICY_INVALID') => {
  assert.throws(() => parseExitPolicy(input), error => error instanceof ExitPolicyError && error.reason === reason);
};

test('missing settings or an explicit disabled policy cannot create condition orders', () => {
  assert.equal(parseExitPolicy(undefined), undefined);
  assert.equal(parseExitPolicy({enabled: false}), undefined);
  for (const value of [null, false, '', '{}', {}, [], {enabled: true}, {enabled: 'false'},
    {...settings(), enabled: false}]) invalid(value);
  for (const value of [undefined, {enabled: false}]) {
    assert.throws(() => buildExitConditions(value as ExitPolicy), /EXIT_POLICY_INVALID/);
  }
});

test('authorized thresholds preserve gains and drops, with each sell measured against current holdings', () => {
  const policy = parseExitPolicy(settings())!;
  assert.equal(policy.sellRatioType, 'hold_amount');
  const conditions = buildExitConditions(policy);
  assert.deepEqual(conditions, [
    {order_type: 'profit_stop', side: 'sell', price_scale: '500', sell_ratio: '20'},
    {order_type: 'profit_stop', side: 'sell', price_scale: '1000', sell_ratio: '10'},
    {order_type: 'loss_stop', side: 'sell', price_scale: '40', sell_ratio: '100'},
  ]);
  const entryPrice = 10;
  assert.equal(entryPrice * (1 + Number(conditions[0].price_scale) / 100), 60);
  assert.equal(entryPrice * (1 + Number(conditions[1].price_scale) / 100), 110);
  assert.equal(entryPrice * (1 - Number(conditions[2].price_scale) / 100), 6);
  let remaining = 100;
  const sold = conditions.slice(0, 2).map(condition => {
    const amount = remaining * Number(condition.sell_ratio) / 100;
    remaining -= amount;
    return amount;
  });
  assert.deepEqual(sold, [20, 8]);
  assert.equal(remaining, 72);
  // A full stop must sell everything whether it fires before, between or after the profit tiers.
  for (const holding of [100, 80, remaining, 123]) {
    assert.equal(holding - holding * Number(conditions[2].sell_ratio) / 100, 0);
  }
});

test('current owner plan recovers principal at double and stops all remaining tokens at minus60',()=>{
 const policy=parseExitPolicy({enabled:true,sellRatioType:'hold_amount',takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}})!;
 assert.deepEqual(buildExitConditions(policy),[
   {order_type:'profit_stop',side:'sell',price_scale:'100',sell_ratio:'50'},
   {order_type:'loss_stop',side:'sell',price_scale:'60',sell_ratio:'100'}]);
 assert.equal(100*2*0.5,100);
 for(const takeProfit of [[{gainPct:100,sellPct:49}],[{gainPct:100,sellPct:50},{gainPct:500,sellPct:20}]])
   invalid({enabled:true,sellRatioType:'hold_amount',takeProfit,stopLoss:{dropPct:60,sellPct:100}});
});

test('original-buy basis is explicitly rejected rather than weakening the full remaining-position stop', () => {
  invalid({...settings(), sellRatioType: 'buy_amount'}, 'EXIT_POLICY_FULL_STOP_REQUIRES_HOLD_AMOUNT');
  for (const basis of ['HOLD_AMOUNT', 'balance', '', null, 1]) invalid({...settings(), sellRatioType: basis});
});

test('missing, extra, reordered and unauthorized thresholds fail closed without numeric coercion', () => {
  const original = settings();
  for (const takeProfit of [[], original.takeProfit.slice(0, 1), [...original.takeProfit].reverse(),
    [...original.takeProfit, {gainPct: 2000, sellPct: 100}]]) invalid({...settings(), takeProfit});
  for (const value of [0, -1, 100, 499, 501, 500.01, Number.NaN, Infinity, '500', null, undefined]) {
    const input = settings();
    invalid({...input, takeProfit: [{gainPct: value, sellPct: 20}, input.takeProfit[1]]});
  }
  for (const value of [0, -1, 10, 19, 21, 100, 101, '20', Number.NaN]) {
    const input = settings();
    invalid({...input, takeProfit: [{gainPct: 500, sellPct: value}, input.takeProfit[1]]});
  }
  for (const dropPct of [0, -40, 39, 41, 59, 61, 100, 101, '40', undefined]) {
    invalid({...settings(), stopLoss: {dropPct, sellPct: 100}});
  }
  for (const sellPct of [0, 40, 72, 99, 101, '100', undefined]) {
    invalid({...settings(), stopLoss: {dropPct: 40, sellPct}});
  }
});

test('settings cannot inject a wallet, contract, endpoint, signature or arbitrary condition orders', () => {
  for (const extra of [
    {wallet: `0x${'1'.repeat(40)}`}, {tokenAddress: `0x${'2'.repeat(40)}`},
    {endpoint: 'https://attacker.invalid'}, {apiKey: 'must-not-appear-in-error'},
    {privateKey: 'must-not-appear-in-error'}, {condition_orders: [{side: 'buy'}]},
  ]) invalid({...settings(), ...extra});
  const input = settings();
  invalid({...input, takeProfit: [{...input.takeProfit[0], order_type: 'profit_stop_trace'}, input.takeProfit[1]]});
  invalid({...settings(), stopLoss: {dropPct: 40, sellPct: 100, side: 'buy'}});
  try {
    parseExitPolicy({...settings(), apiKey: 'must-not-appear-in-error'});
    assert.fail('expected rejection');
  } catch (error) {
    assert.ok(error instanceof ExitPolicyError);
    assert.equal(String(error), 'ExitPolicyError: EXIT_POLICY_INVALID');
  }
});

test('parsed owner policy is an immutable snapshot and transport construction revalidates its input', () => {
  const input = settings();
  const policy = parseExitPolicy(input)!;
  input.takeProfit[0].sellPct = 100;
  input.stopLoss.dropPct = 99;
  assert.equal(policy.takeProfit[0].sellPct, 20);
  assert.equal(policy.stopLoss.dropPct, 40);
  assert.throws(() => { (policy.takeProfit[0] as {sellPct: number}).sellPct = 100; }, TypeError);
  assert.throws(() => { (policy as {sellRatioType: string}).sellRatioType = 'buy_amount'; }, TypeError);
  const first = buildExitConditions(policy);
  first[0].sell_ratio = '100';
  assert.equal(buildExitConditions(policy)[0].sell_ratio, '20');
  assert.throws(() => buildExitConditions(input as unknown as ExitPolicy), /EXIT_POLICY_INVALID/);
  assert.throws(() => buildExitConditions({...settings(), sellRatioType: 'buy_amount'} as unknown as ExitPolicy),
    /EXIT_POLICY_FULL_STOP_REQUIRES_HOLD_AMOUNT/);
});
