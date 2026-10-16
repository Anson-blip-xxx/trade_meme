import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_SHADOW_V1,ADAPTIVE_SHADOW_V2,ADAPTIVE_SHADOW_V3,adaptiveExitDeadline,migrateAdaptiveExitV1,migrateAdaptiveExitToV3, stepAdaptiveExit,
  type AdaptiveExitState, type PriceObservation, type WalletPressure, type WalletPressureTrade,
} from '../src/adaptive-exit.js';

const TOKEN = `0x${'a'.repeat(40)}`;
const WALLET = `0x${'b'.repeat(40)}`;
const OTHER = `0x${'c'.repeat(40)}`;
const START = Date.parse('2026-10-11T00:00:00.000Z');
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
const observation = (priceUsd: number, minutes: number, extra: Partial<PriceObservation> = {}): PriceObservation => ({
  chain: 'bsc', address: TOKEN, priceUsd, observedAt: at(minutes), evaluatedAt: at(minutes),
  source: 'gmgn_token_info_sample', ...extra,
});
const seed = (price = 100) => stepAdaptiveExit(undefined, observation(price, 0)).state!;
const evolve = (prices: number[], spacing = 1): AdaptiveExitState => {
  let state: AdaptiveExitState | undefined;
  for (let i = 0; i < prices.length; i++) {
    const step = stepAdaptiveExit(state, observation(prices[i], i * spacing));
    assert.notEqual(step.status, 'ignored', step.ignoredReason ?? 'observation should be accepted');
    state = step.state;
  }
  return state!;
};
const trade = (minutes: number, extra: Partial<WalletPressureTrade> = {}): WalletPressureTrade => ({
  evidenceId: 'tx:1:0', wallet: WALLET, side: 'sell', volumeUsd: 1000,
  eventAt: at(minutes - 0.5), observedAt: at(minutes - 0.25), source: 'gmgn_wallet_activity', ...extra,
});
const pressure = (minutes: number, extra: Partial<WalletPressure> = {}): WalletPressure => ({
  chain: 'bsc', address: TOKEN, observedAt: at(minutes), windowStartAt: at(minutes - 2),
  windowEndAt: at(minutes), trades: [trade(minutes)], ...extra,
});
const approx = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('first fresh sample establishes a new shadow baseline without a historical peak or event', () => {
  const result = stepAdaptiveExit(undefined, observation(100, 0));
  assert.equal(result.status, 'initialized');
  assert.equal(result.event, undefined);
  assert.equal(result.state?.baselinePriceUsd, 100);
  assert.equal(result.state?.peakPriceUsd, 100);
  assert.equal(result.state?.hardStopPriceUsd, 60);
  assert.equal(result.state?.protectionPriceUsd, 60);
  assert.equal(result.state?.protectionActive, false);
  assert.equal(result.state?.remainingPctOfInitial, 100);
  assert.equal(result.state?.walletPressure, undefined);
  assert.equal(result.state?.policyVersion, 'adaptive-shadow-v1');
  assert.equal(result.state?.samples, 1);
});

test('hard stop remains 40 percent below baseline and reports the observed gap price, not a fill at the threshold', () => {
  const initial = seed();
  assert.equal(stepAdaptiveExit(initial, observation(60.01, 1)).event, undefined);
  for (const price of [60, 49]) {
    const result = stepAdaptiveExit(initial, observation(price, 1));
    assert.deepEqual(result.event?.reasons, ['HARD_STOP_OBSERVED']);
    assert.equal(result.event?.kind, 'full_exit');
    assert.equal(result.event?.observedPriceUsd, price);
    assert.equal(result.event?.observedAt, at(1));
    assert.equal(result.event?.sellPctRemaining, 100);
    assert.equal(result.event?.sellRatioType, 'remaining_holding');
    assert.equal(result.event?.execution, 'observation_only');
    assert.equal(result.event?.mode, 'shadow');
    assert.equal(result.state?.shadowClosed, true);
    assert.equal(result.state?.remainingPctOfInitial, 0);
    assert.ok(!Object.hasOwn(result.event!, 'fillPriceUsd'));
  }
  assert.equal(initial.remainingPctOfInitial, 100);
});

test('activation follows time-normalized observed volatility within policy bounds', () => {
  const quiet = evolve([1, Math.exp(0.05), Math.exp(0.10), Math.exp(0.15)]);
  const fast = evolve([1, Math.exp(0.50), Math.exp(1), Math.exp(1.5)]);
  approx(quiet.volatilityPctPerMinute, 5);
  approx(fast.volatilityPctPerMinute, 50);
  assert.equal(quiet.activationGainPct, 30);
  assert.equal(fast.activationGainPct, 80);
  assert.equal(quiet.protectionActive, false);
  assert.equal(fast.protectionActive, true);
});

test('the same absolute log growth per minute produces the same volatility at different sample intervals', () => {
  const oneMinute = evolve([1, Math.exp(0.1), Math.exp(0.2), Math.exp(0.3)], 1);
  const twoMinutes = evolve([1, Math.exp(0.2), Math.exp(0.4), Math.exp(0.6)], 2);
  approx(oneMinute.volatilityPctPerMinute, 10);
  approx(twoMinutes.volatilityPctPerMinute, 10);
  approx(oneMinute.activationGainPct, twoMinutes.activationGainPct);
});

test('activation is irreversible and protection never falls when the next volatility estimate widens', () => {
  let state = evolve([100, 110, 121, 134]);
  assert.equal(state.protectionActive, true);
  let previousProtection = state.protectionPriceUsd;
  for (let index = 1; index <= 15; index++) {
    const result = stepAdaptiveExit(state, observation(state.lastPriceUsd * (index % 2 ? 1.25 : 1.01), index + 3));
    assert.equal(result.status, 'observed');
    state = result.state!;
    assert.equal(state.protectionActive, true);
    assert.ok(state.protectionPriceUsd >= previousProtection);
    assert.ok(state.drawdownPct >= ADAPTIVE_SHADOW_V1.minDrawdownPct && state.drawdownPct <= ADAPTIVE_SHADOW_V1.maxDrawdownPct);
    previousProtection = state.protectionPriceUsd;
  }
  assert.equal(state.volatilityReturns.length, 12);
});

test('already-observed profit tightens the permitted drawdown as the peak grows', () => {
  const one = stepAdaptiveExit(seed(), observation(200, 1)).state!;
  const two = stepAdaptiveExit(seed(), observation(300, 1)).state!;
  const five = stepAdaptiveExit(seed(), observation(600, 1)).state!;
  assert.equal(one.drawdownPct, 32);
  assert.equal(two.drawdownPct, 29);
  assert.equal(five.drawdownPct, 25);
  assert.ok(one.protectionPriceUsd < two.protectionPriceUsd && two.protectionPriceUsd < five.protectionPriceUsd);
});

test('a long sampling gap resets volatility only and records an exit solely at the next real observation', () => {
  const initial = evolve([100, 110, 121, 150]);
  const result = stepAdaptiveExit(initial, observation(80, 11));
  assert.equal(result.state?.lastSampleGapMs, 480_000);
  assert.equal(result.state?.maxSampleGapMs, 480_000);
  assert.equal(result.state?.gapCount, 1);
  assert.deepEqual(result.state?.volatilityReturns, []);
  assert.equal(result.state?.volatilityPctPerMinute, 25);
  assert.equal(result.state?.peakPriceUsd, 150);
  assert.equal(result.event?.observedAt, at(11));
  assert.equal(result.event?.observedPriceUsd, 80);
  assert.deepEqual(result.event?.reasons, ['DYNAMIC_PROTECTION_OBSERVED']);
});

test('partial suggestions use remaining holdings, fire once, and leave 72 percent after the two original stages', () => {
  const first = stepAdaptiveExit(seed(1), observation(6, 1));
  assert.equal(first.event?.kind, 'partial_exit');
  assert.equal(first.event?.sellPctRemaining, 20);
  assert.equal(first.state?.remainingPctOfInitial, 80);
  assert.deepEqual(first.event?.stageGainsPct, [500]);
  const between = stepAdaptiveExit(first.state, observation(7, 2));
  assert.equal(between.event, undefined);
  const second = stepAdaptiveExit(between.state, observation(11, 3));
  assert.equal(second.event?.sellPctRemaining, 10);
  assert.equal(second.state?.remainingPctOfInitial, 72);
  assert.deepEqual(second.state?.suggestedStages, [500, 1000]);
  assert.equal(stepAdaptiveExit(second.state, observation(12, 4)).event, undefined);
  const stopped = stepAdaptiveExit(second.state, observation(0.5, 4));
  assert.equal(stopped.event?.sellPctRemaining, 100);
  assert.equal(stopped.event?.remainingPctOfInitial, 0);
});

test('crossing both partial stages in one sample combines sequential remaining-holding fractions', () => {
  const result = stepAdaptiveExit(seed(1), observation(11, 1));
  assert.equal(result.event?.sellPctRemaining, 28);
  assert.equal(result.state?.remainingPctOfInitial, 72);
  assert.deepEqual(result.event?.stageGainsPct, [500, 1000]);
});

test('a full protection suggestion after a partial stage closes all remaining hypothetical holdings', () => {
  const high = stepAdaptiveExit(seed(1), observation(10, 1)).state!;
  const result = stepAdaptiveExit(high, observation(6.5, 2));
  assert.equal(result.event?.kind, 'full_exit');
  assert.equal(result.event?.sellPctRemaining, 100);
  assert.deepEqual(result.event?.stageGainsPct, []);
});

test('identical samples are idempotent, conflicts do not rewrite history, and a closed shadow cannot suggest twice', () => {
  const initial = seed();
  const same = stepAdaptiveExit(initial, observation(100, 0));
  assert.equal(same.ignoredReason, 'DUPLICATE_SAMPLE');
  assert.equal(same.state, initial);
  const conflict = stepAdaptiveExit(initial, observation(200, 0));
  assert.equal(conflict.ignoredReason, 'SAMPLE_CONFLICT');
  assert.equal(conflict.state, initial);
  const closed = stepAdaptiveExit(initial, observation(50, 1)).state!;
  assert.equal(stepAdaptiveExit(closed, observation(50, 1)).ignoredReason, 'DUPLICATE_SAMPLE');
  assert.equal(stepAdaptiveExit(closed, observation(40, 2)).ignoredReason, 'SHADOW_CLOSED');
});

test('nonpositive, nonfinite and coerced prices cannot initialize, update a peak, or trigger', () => {
  const initial = seed();
  for (const priceUsd of [0, -1, NaN, Infinity, -Infinity, '1', null, undefined]) {
    const quote = observation(priceUsd as number, 1);
    assert.equal(stepAdaptiveExit(undefined, quote).ignoredReason, 'PRICE_INVALID');
    const result = stepAdaptiveExit(initial, quote);
    assert.equal(result.ignoredReason, 'PRICE_INVALID');
    assert.equal(result.state, initial);
    assert.equal(result.event, undefined);
  }
});

test('untrusted price source, malformed identity and different token or chain are rejected', () => {
  const initial = seed();
  for (const extra of [{source: 'historical_ath'}, {source: 'gmgn_narrative'}, {address: '0x7777'}, {address: `0x${'0'.repeat(40)}`}])
    assert.equal(stepAdaptiveExit(initial, observation(10, 1, extra)).ignoredReason, 'PRICE_INVALID');
  for (const extra of [{address: OTHER}, {chain: 'robinhood' as const}])
    assert.equal(stepAdaptiveExit(initial, observation(10, 1, extra)).ignoredReason, 'IDENTITY_MISMATCH');
  assert.equal(stepAdaptiveExit(initial, observation(110, 1, {address: TOKEN.toUpperCase().replace('0X', '0x')})).status, 'observed');
});

test('Solana addresses must decode to 32 nonzero bytes, including pressure wallets', () => {
  const sol = observation(1, 0, {chain: 'solana', address: 'So11111111111111111111111111111111111111112'});
  assert.equal(stepAdaptiveExit(undefined, sol).status, 'initialized');
  for (const address of ['1'.repeat(32), '2'.repeat(32), 'z'.repeat(44), '0'.repeat(44)])
    assert.equal(stepAdaptiveExit(undefined, {...sol, address}).ignoredReason, 'PRICE_INVALID');
  const invalidWallet = pressure(0, {chain: 'solana', address: sol.address,
    trades: [trade(0, {wallet: '2'.repeat(32)})]});
  assert.equal(stepAdaptiveExit(undefined, sol, invalidWallet).ignoredPressureReason, 'WALLET_PRESSURE_INVALID');
});

test('future, stale, invalid-calendar and reversed-clock samples preserve the exact prior state without an event', () => {
  const initial = seed();
  const cases: [Partial<PriceObservation>, string][] = [
    [{observedAt: at(2), evaluatedAt: at(1)}, 'PRICE_FROM_FUTURE'],
    [{observedAt: at(1), evaluatedAt: at(3.001)}, 'PRICE_STALE'],
    [{observedAt: '2026-02-30T00:00:00Z'}, 'TIME_INVALID'],
    [{observedAt: 'tomorrow'}, 'TIME_INVALID'],
    [{observedAt: at(-1), evaluatedAt: at(-1)}, 'TIME_REGRESSED'],
  ];
  for (const [extra, reason] of cases) {
    const result = stepAdaptiveExit(initial, observation(1_000_000, 1, extra));
    assert.equal(result.ignoredReason, reason);
    assert.equal(result.state, initial);
    assert.equal(result.event, undefined);
  }
  const delayed = stepAdaptiveExit(initial, observation(110, 1, {evaluatedAt: at(2)})).state!;
  assert.equal(stepAdaptiveExit(delayed, observation(20, 1.5)).ignoredReason, 'TIME_REGRESSED');
});

test('stale or future first observations cannot establish a retrospective shadow baseline', () => {
  for (const quote of [observation(100, 0, {evaluatedAt: at(5)}), observation(100, 1, {evaluatedAt: at(0)})]) {
    const result = stepAdaptiveExit(undefined, quote);
    assert.equal(result.status, 'ignored');
    assert.equal(result.state, undefined);
    assert.equal(result.event, undefined);
  }
});

test('valid structured net sells tighten protection, while missing evidence remains unknown', () => {
  const high = stepAdaptiveExit(seed(), observation(200, 1)).state!;
  const noEvidence = stepAdaptiveExit(high, observation(145, 2));
  const selling = stepAdaptiveExit(high, observation(145, 2), pressure(2));
  assert.equal(noEvidence.event, undefined);
  assert.equal(noEvidence.state?.walletPressure, undefined);
  assert.equal(selling.state?.walletPressure?.netSellRatio, 1);
  assert.equal(selling.state?.walletPressure?.verification, 'vendor_reported');
  assert.equal(selling.state?.walletPressure?.evidenceCount, 1);
  assert.equal(selling.event?.kind, 'full_exit');
  assert.deepEqual(selling.event?.reasons, ['DYNAMIC_PROTECTION_OBSERVED', 'WALLET_NET_SELLING_TIGHTENED']);
  assert.equal(selling.event?.observedPriceUsd, 145);
  assert.ok(selling.state!.protectionPriceUsd > noEvidence.state!.protectionPriceUsd);
});

test('known observed net buying is distinct from unknown, and does not loosen a previously raised protection', () => {
  const high = stepAdaptiveExit(seed(), observation(200, 1)).state!;
  const tightened = stepAdaptiveExit(high, observation(190, 2), pressure(2)).state!;
  const buying = stepAdaptiveExit(tightened, observation(195, 3), pressure(3, {trades: [trade(3, {side: 'buy'})]}));
  assert.equal(buying.state?.walletPressure?.status, 'observed_no_net_selling');
  assert.equal(buying.state?.walletPressure?.netSellRatio, 0);
  assert.ok(buying.state!.protectionPriceUsd >= tightened.protectionPriceUsd);
  const unknown = stepAdaptiveExit(tightened, observation(195, 3));
  assert.equal(unknown.state?.walletPressure, undefined);
  assert.ok(unknown.state!.protectionPriceUsd >= tightened.protectionPriceUsd);
});

test('pressure derives bounded net sell ratio from deduplicated evidence, not caller summary fields', () => {
  const sell = trade(1, {volumeUsd: 300});
  const buy = trade(1, {evidenceId: 'tx:2:0', side: 'buy', volumeUsd: 100});
  const data = {...pressure(1, {trades: [sell, {...sell}, buy]}), netSellRatio: 1};
  const summary = stepAdaptiveExit(seed(), observation(200, 1), data).state?.walletPressure;
  assert.equal(summary?.netSellRatio, 0.5);
  assert.equal(summary?.evidenceCount, 2);
  assert.equal(summary?.sellVolumeUsd, 300);
  assert.equal(summary?.buyVolumeUsd, 100);
  assert.deepEqual(summary?.evidenceIds, ['tx:1:0', 'tx:2:0']);
});

test('untrusted, conflicting, insufficient, wrong-token and overlong pressure never change price-only advice', () => {
  const high = stepAdaptiveExit(seed(), observation(200, 1)).state!;
  const sample = observation(145, 2);
  const bad: [WalletPressure, string][] = [
    [pressure(2, {address: OTHER}), 'WALLET_PRESSURE_IDENTITY_MISMATCH'],
    [pressure(2, {chain: 'robinhood'}), 'WALLET_PRESSURE_IDENTITY_MISMATCH'],
    [pressure(2, {trades: []}), 'WALLET_PRESSURE_INVALID'],
    [pressure(2, {trades: [trade(2, {source: 'ai_summary' as WalletPressureTrade['source']})]}), 'WALLET_PRESSURE_INVALID'],
    [pressure(2, {trades: [trade(2, {volumeUsd: 1})]}), 'WALLET_PRESSURE_VOLUME_INSUFFICIENT'],
    [pressure(2, {trades: [trade(2), trade(2, {side: 'buy'})]}), 'WALLET_PRESSURE_EVIDENCE_CONFLICT'],
    [pressure(2, {trades: Array.from({length: 101}, (_, i) => trade(2, {evidenceId: `tx:${i}`}))}), 'WALLET_PRESSURE_INVALID'],
  ];
  for (const [data, reason] of bad) {
    const result = stepAdaptiveExit(high, sample, data);
    assert.equal(result.ignoredPressureReason, reason);
    assert.equal(result.state?.walletPressure, undefined);
    assert.equal(result.event, undefined);
    assert.equal(result.state?.protectionPriceUsd, stepAdaptiveExit(high, sample).state?.protectionPriceUsd);
  }
});

test('pressure cannot use future observations, future trade timestamps, stale data or a retrospective long window', () => {
  const high = stepAdaptiveExit(seed(), observation(200, 1)).state!;
  const sample = observation(145, 2);
  const invalid: [WalletPressure, string][] = [
    [pressure(3), 'WALLET_PRESSURE_TIME_INVALID'],
    [pressure(-4), 'WALLET_PRESSURE_STALE'],
    [pressure(2, {windowStartAt: at(-20)}), 'WALLET_PRESSURE_TIME_INVALID'],
    [pressure(2, {trades: [trade(2, {observedAt: at(3)})]}), 'WALLET_PRESSURE_TIME_INVALID'],
    [pressure(2, {trades: [trade(2, {eventAt: at(3)})]}), 'WALLET_PRESSURE_TIME_INVALID'],
    [pressure(2, {trades: [trade(2, {eventAt: at(-1)})]}), 'WALLET_PRESSURE_TIME_INVALID'],
    [pressure(2, {trades: [trade(2, {eventAt: at(1.9), observedAt: at(1.8)})]}), 'WALLET_PRESSURE_TIME_INVALID'],
  ];
  for (const [data, reason] of invalid) {
    const result = stepAdaptiveExit(high, sample, data);
    assert.equal(result.ignoredPressureReason, reason);
    assert.equal(result.event, undefined);
    assert.equal(result.state?.walletPressure, undefined);
  }
});

test('all local structured feed sources retain provenance and do not become independently chain verified', () => {
  const sources: WalletPressureTrade['source'][] = ['gmgn_wallet_activity', 'gmgn_token_trades',
    'gmgn_kol_feed', 'gmgn_smartmoney_feed', 'gmgn_association_candidate_activity',
    'gmgn_association_leader_activity', 'gmgn_association_wallet_activity'];
  for (const source of sources) {
    const result = stepAdaptiveExit(seed(), observation(200, 1), pressure(1, {trades: [trade(1, {source})]}));
    assert.deepEqual(result.state?.walletPressure?.sources, [source]);
    assert.equal(result.state?.walletPressure?.verification, 'vendor_reported');
  }
  const chain = stepAdaptiveExit(seed(), observation(200, 1), pressure(1, {trades: [trade(1, {source: 'chain_transaction'})]}));
  assert.equal(chain.state?.walletPressure?.verification, 'chain_evidence');
});

test('no same-sample replay can retrospectively attach later wallet evidence or generate a second event', () => {
  const high = stepAdaptiveExit(seed(), observation(200, 1)).state!;
  const first = stepAdaptiveExit(high, observation(145, 2));
  const replay = stepAdaptiveExit(first.state, observation(145, 2), pressure(2));
  assert.equal(replay.ignoredReason, 'DUPLICATE_SAMPLE');
  assert.equal(replay.state, first.state);
  assert.equal(replay.event, undefined);
  assert.equal(replay.state?.walletPressure, undefined);
});

test('state survives JSON serialization without changing subsequent deterministic output or mutating inputs', () => {
  const high = stepAdaptiveExit(seed(), observation(200, 1), pressure(1)).state!;
  const before = JSON.stringify(high);
  const data = pressure(2), beforePressure = JSON.stringify(data), quote = observation(190, 2);
  assert.deepEqual(stepAdaptiveExit(high, quote, data), stepAdaptiveExit(JSON.parse(before), {...quote}, JSON.parse(beforePressure)));
  assert.equal(JSON.stringify(high), before);
  assert.equal(JSON.stringify(data), beforePressure);
});

test('corrupt state and silent policy changes do not emit suggestions', () => {
  const initial = seed();
  const invalid: Partial<AdaptiveExitState>[] = [
    {baselinePriceUsd: 0}, {hardStopPriceUsd: 50}, {protectionPriceUsd: 59}, {peakPriceUsd: 10},
    {lastObservedAt: at(1), lastEvaluatedAt: at(0)}, {samples: 0}, {remainingPctOfInitial: 20},
    {shadowClosed: true}, {suggestedStages: [123]}, {volatilityReturns: [1]}, {maxSampleGapMs: -1},
  ];
  for (const patch of invalid) {
    const result = stepAdaptiveExit({...initial, ...patch}, observation(10, 1));
    assert.equal(result.ignoredReason, 'STATE_INVALID');
    assert.equal(result.event, undefined);
  }
  assert.equal(stepAdaptiveExit({...initial, policyVersion: 'old'}, observation(10, 1)).ignoredReason, 'STATE_POLICY_MISMATCH');
  const changed = {...ADAPTIVE_SHADOW_V1, hardStopDropPct: 50};
  assert.equal(stepAdaptiveExit(initial, observation(10, 1), undefined, changed).ignoredReason, 'POLICY_UNSUPPORTED');
  assert.equal(stepAdaptiveExit(initial, observation(110, 1), undefined, JSON.parse(JSON.stringify(ADAPTIVE_SHADOW_V1))).status, 'observed');
});

test('unrepresentable price arithmetic cannot advance state or manufacture an infinite profit', () => {
  assert.equal(stepAdaptiveExit(undefined, observation(Number.MIN_VALUE, 0)).ignoredReason, 'ARITHMETIC_INVALID');
  const small = seed(1e-300);
  const result = stepAdaptiveExit(small, observation(1e300, 1));
  assert.equal(result.ignoredReason, 'ARITHMETIC_INVALID');
  assert.equal(result.state, small);
  assert.equal(result.event, undefined);
});


test('v2 closes the final 72 percent at its forward planned maximum holding time without claiming a fill',()=>{
  let state=stepAdaptiveExit(undefined,observation(1,0),undefined,ADAPTIVE_SHADOW_V2).state!;
  state=stepAdaptiveExit(state,observation(6,1),undefined,ADAPTIVE_SHADOW_V2).state!;
  state=stepAdaptiveExit(state,observation(11,2),undefined,ADAPTIVE_SHADOW_V2).state!;
  assert.equal(state.remainingPctOfInitial,72);assert.equal(adaptiveExitDeadline(state)?.dueAt,at(360));
  const step=stepAdaptiveExit(state,observation(12,360),undefined,ADAPTIVE_SHADOW_V2);
  assert.equal(step.event?.kind,'full_exit');assert.equal(step.event?.sellPctRemaining,100);
  assert.equal(step.event?.remainingPctOfInitial,0);assert.deepEqual(step.event?.reasons,['MAX_HOLDING_TIME_OBSERVED']);
  assert.equal(step.event?.observedPriceUsd,12);assert.equal(step.event?.execution,'observation_only');
});

test('v2 price-confirmed momentum exit needs continuous sufficiently long samples and does not infer stagnation across missing quotes',()=>{
  let state=stepAdaptiveExit(undefined,observation(100,0),undefined,ADAPTIVE_SHADOW_V2).state!;
  state=stepAdaptiveExit(state,observation(200,1),undefined,ADAPTIVE_SHADOW_V2).state!;
  const gap=stepAdaptiveExit(state,observation(185,32),undefined,ADAPTIVE_SHADOW_V2);
  assert.equal(gap.event,undefined);assert.equal(gap.state?.momentumObservations?.length,1);
  for(let n=2;n<=30;n++){
    const step=stepAdaptiveExit(state,observation(185,n),undefined,ADAPTIVE_SHADOW_V2);assert.equal(step.event,undefined);state=step.state!;
  }
  const exit=stepAdaptiveExit(state,observation(185,31),undefined,ADAPTIVE_SHADOW_V2);
  assert.equal(exit.event?.kind,'full_exit');assert.deepEqual(exit.event?.reasons,['MOMENTUM_STALLED_OBSERVED']);
});

test('v2 rising price is not stagnation, while a fixed observation deadline cannot be extended by later quotes',()=>{
  let state=stepAdaptiveExit(undefined,observation(100,0,{observationEndsAt:at(60)}),undefined,ADAPTIVE_SHADOW_V2).state!;
  for(let n=1;n<60;n++){
    const step=stepAdaptiveExit(state,observation(100+n,n,{observationEndsAt:at(1000)}),undefined,ADAPTIVE_SHADOW_V2);
    assert.equal(step.event,undefined);state=step.state!;
  }
  const end=stepAdaptiveExit(state,observation(160,60),undefined,ADAPTIVE_SHADOW_V2);
  assert.equal(end.event?.reasons[0],'OBSERVATION_WINDOW_END_OBSERVED');assert.equal(adaptiveExitDeadline(state)?.dueAt,at(60));
});

test('v1 policy remains unchanged and prospective migration cannot replay old quotations or extend an existing migrated deadline',()=>{
  const old=seed(),later=stepAdaptiveExit(old,observation(100,400));assert.equal(later.event,undefined);
  const before=JSON.stringify(later.state),migrated=migrateAdaptiveExitV1(later.state!,at(401),at(1000))!;
  assert.equal(JSON.stringify(later.state),before);assert.equal(migrated.policyVersion,'adaptive-shadow-v2');
  assert.equal(migrated.baselineAt,at(0));assert.equal(migrated.policyEffectiveAt,at(401));assert.equal(adaptiveExitDeadline(migrated)?.dueAt,at(761));
  assert.equal(stepAdaptiveExit(migrated,observation(100,400.5,{evaluatedAt:at(402)}),undefined,ADAPTIVE_SHADOW_V2).ignoredReason,'TIME_REGRESSED');
  assert.equal(migrateAdaptiveExitV1(migrated,at(402),at(1100)),undefined);
  assert.equal(stepAdaptiveExit(migrated,observation(101,402),undefined,ADAPTIVE_SHADOW_V2).event,undefined);
  assert.equal(stepAdaptiveExit(migrated,observation(101,761),undefined,ADAPTIVE_SHADOW_V2).event?.reasons[0],'MAX_HOLDING_TIME_OBSERVED');
});


test('v3 continuously rising observations remain open beyond six hours and the old observation horizon',()=>{
  let state=stepAdaptiveExit(undefined,observation(100,0,{observationEndsAt:at(60)}),undefined,ADAPTIVE_SHADOW_V3).state!;
  assert.equal(Object.hasOwn(ADAPTIVE_SHADOW_V3,'maxHoldingMs'),false);assert.equal(adaptiveExitDeadline(state),undefined);
  for(let minute=1;minute<=1500;minute++){
    const next=stepAdaptiveExit(state,observation(100+minute/10,minute,{observationEndsAt:at(60)}),undefined,ADAPTIVE_SHADOW_V3);
    assert.equal(next.status,'observed');assert.equal(next.event,undefined);assert.equal(next.state?.shadowClosed,false);state=next.state!;
  }
  assert.equal(state.remainingPctOfInitial,100);assert.equal(state.lastObservedAt,at(1500));assert.equal(state.peakPriceUsd,250);
});

test('v3 does not call a slow positive recovery below an old peak stalled momentum; v2 keeps its historical rule',()=>{
  for(const policy of [ADAPTIVE_SHADOW_V2,ADAPTIVE_SHADOW_V3]){
    let state=stepAdaptiveExit(undefined,observation(100,0),undefined,policy).state!;
    state=stepAdaptiveExit(state,observation(200,1),undefined,policy).state!;
    for(let minute=2;minute<=31;minute++){
      const price=182+(minute-2)*0.05;
      const next=stepAdaptiveExit(state,observation(price,minute),undefined,policy);
      assert.ok(next.state!.protectionPriceUsd<price);
      if(policy===ADAPTIVE_SHADOW_V2&&minute===31){
        assert.deepEqual(next.event?.reasons,['MOMENTUM_STALLED_OBSERVED']);
        assert.equal(next.state?.shadowClosed,true);
      }else{
        assert.equal(next.event,undefined);assert.equal(next.state?.shadowClosed,false);
      }
      state=next.state!;
    }
    assert.equal(state.lastPriceUsd,183.45);
    if(policy===ADAPTIVE_SHADOW_V3)assert.equal(state.remainingPctOfInitial,100);
  }
});

test('v3 still recognizes sustained slow decline below a quiet peak using fresh momentum evidence',()=>{
  let state=stepAdaptiveExit(undefined,observation(100,0),undefined,ADAPTIVE_SHADOW_V3).state!;
  state=stepAdaptiveExit(state,observation(200,1),undefined,ADAPTIVE_SHADOW_V3).state!;
  for(let minute=2;minute<=30;minute++){
    const next=stepAdaptiveExit(state,observation(185-(minute-2)*0.05,minute),undefined,ADAPTIVE_SHADOW_V3);
    assert.equal(next.event,undefined);state=next.state!;
  }
  const exit=stepAdaptiveExit(state,observation(183.55,31),undefined,ADAPTIVE_SHADOW_V3);
  assert.ok(exit.state!.protectionPriceUsd<183.55);
  assert.deepEqual(exit.event?.reasons,['MOMENTUM_STALLED_OBSERVED']);
  assert.equal(exit.event?.kind,'full_exit');assert.equal(exit.event?.sellPctRemaining,100);
  assert.equal(exit.event?.observedPriceUsd,183.55);assert.equal(exit.state?.remainingPctOfInitial,0);
});

test('v2 migration retains 72 percent and the past horizon only for audit; time cannot close the v3 remainder',()=>{
  let old=stepAdaptiveExit(undefined,observation(1,0,{observationEndsAt:at(60)}),undefined,ADAPTIVE_SHADOW_V2).state!;
  old=stepAdaptiveExit(old,observation(6,1),undefined,ADAPTIVE_SHADOW_V2).state!;
  old=stepAdaptiveExit(old,observation(11,2),undefined,ADAPTIVE_SHADOW_V2).state!;
  const before=JSON.stringify(old),migrated=migrateAdaptiveExitToV3(old,at(400))!;
  assert.ok(migrated);assert.equal(JSON.stringify(old),before);assert.equal(migrated.remainingPctOfInitial,72);
  for(const field of ['baselinePriceUsd','baselineAt','peakPriceUsd','peakAt','protectionPriceUsd','protectionActive','hardStopPriceUsd'] as const)
    assert.equal(migrated[field],old[field]);
  assert.deepEqual(migrated.suggestedStages,[500,1000]);assert.deepEqual(migrated.momentumObservations,old.momentumObservations);
  assert.equal(migrated.policyEffectiveAt,at(400));assert.equal(migrated.momentumEffectiveAt,at(0));assert.equal(migrated.observationEndsAt,at(60));
  assert.equal(adaptiveExitDeadline(migrated),undefined);
  const recovered=stepAdaptiveExit(migrated,observation(11.5,401),undefined,ADAPTIVE_SHADOW_V3);
  assert.equal(recovered.event,undefined);assert.equal(recovered.state?.remainingPctOfInitial,72);
  const later=stepAdaptiveExit(recovered.state,observation(12,1500),undefined,ADAPTIVE_SHADOW_V3);
  assert.equal(later.event,undefined);assert.equal(later.state?.shadowClosed,false);assert.equal(later.state?.remainingPctOfInitial,72);
  // Reading the original version still reproduces its historical rule without rewriting its state.
  assert.equal(stepAdaptiveExit(JSON.parse(before),observation(11.5,401),undefined,ADAPTIVE_SHADOW_V2).event?.reasons[0],'OBSERVATION_WINDOW_END_OBSERVED');
  assert.equal(JSON.stringify(old),before);
});

test('v3 still exits all remaining holdings on a real dynamic drawdown or hard-stop observation',()=>{
  let state=stepAdaptiveExit(undefined,observation(1,0),undefined,ADAPTIVE_SHADOW_V3).state!;
  state=stepAdaptiveExit(state,observation(6,1),undefined,ADAPTIVE_SHADOW_V3).state!;
  state=stepAdaptiveExit(state,observation(11,2),undefined,ADAPTIVE_SHADOW_V3).state!;
  assert.equal(state.remainingPctOfInitial,72);
  const retreat=stepAdaptiveExit(state,observation(8,3),undefined,ADAPTIVE_SHADOW_V3);
  assert.equal(retreat.event?.reasons[0],'DYNAMIC_PROTECTION_OBSERVED');assert.equal(retreat.event?.sellPctRemaining,100);
  assert.equal(retreat.event?.observedPriceUsd,8);assert.equal(retreat.state?.remainingPctOfInitial,0);
  const stop=stepAdaptiveExit(stepAdaptiveExit(undefined,observation(100,0),undefined,ADAPTIVE_SHADOW_V3).state,observation(50,1),undefined,ADAPTIVE_SHADOW_V3);
  assert.equal(stop.event?.reasons[0],'HARD_STOP_OBSERVED');assert.equal(stop.state?.shadowClosed,true);
});

test('v3 preserves existing v2 momentum evidence and requires a new quote before a behavior exit',()=>{
  let old=stepAdaptiveExit(undefined,observation(100,0),undefined,ADAPTIVE_SHADOW_V2).state!;
  old=stepAdaptiveExit(old,observation(200,1),undefined,ADAPTIVE_SHADOW_V2).state!;
  for(let minute=2;minute<=30;minute++)old=stepAdaptiveExit(old,observation(185,minute),undefined,ADAPTIVE_SHADOW_V2).state!;
  const before=JSON.stringify(old),migrated=migrateAdaptiveExitToV3(old,at(30.5))!;
  assert.equal(migrated.shadowClosed,false);assert.deepEqual(migrated.momentumObservations,old.momentumObservations);
  assert.equal(migrated.policyEffectiveAt,at(30.5));assert.equal(migrated.momentumEffectiveAt,at(0));
  const replay=stepAdaptiveExit(migrated,observation(185,30.25,{evaluatedAt:at(31)}),undefined,ADAPTIVE_SHADOW_V3);
  assert.equal(replay.ignoredReason,'TIME_REGRESSED');assert.equal(replay.event,undefined);
  const exit=stepAdaptiveExit(migrated,observation(185,31),undefined,ADAPTIVE_SHADOW_V3);
  assert.equal(exit.event?.reasons[0],'MOMENTUM_STALLED_OBSERVED');assert.equal(exit.event?.observedAt,at(31));
  assert.equal(JSON.stringify(old),before);
});

test('v1 to v3 migration invents no momentum samples and invalid or already-closed migrations are rejected',()=>{
  const old=seed(),migrated=migrateAdaptiveExitToV3(old,at(400))!;
  assert.equal(migrated.policyVersion,'adaptive-shadow-v3');assert.equal(migrated.momentumEffectiveAt,at(400));assert.deepEqual(migrated.momentumObservations,[]);
  assert.equal(stepAdaptiveExit(migrated,observation(101,401),undefined,ADAPTIVE_SHADOW_V3).event,undefined);
  assert.equal(migrateAdaptiveExitToV3(migrated,at(402)),undefined);
  assert.equal(migrateAdaptiveExitToV3(old,at(-1)),undefined);assert.equal(migrateAdaptiveExitToV3(old,'invalid'),undefined);
  assert.equal(migrateAdaptiveExitToV3({...old,remainingPctOfInitial:72},at(400)),undefined);
  const closed=stepAdaptiveExit(old,observation(50,1)).state!;assert.equal(migrateAdaptiveExitToV3(closed,at(400)),undefined);
  const corrupt={...migrated,momentumEffectiveAt:at(401)};
  assert.equal(stepAdaptiveExit(corrupt,observation(101,402),undefined,ADAPTIVE_SHADOW_V3).ignoredReason,'STATE_INVALID');
});
