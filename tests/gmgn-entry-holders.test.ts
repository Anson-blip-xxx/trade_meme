import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {GmgnEntryHolderReader} from '../src/providers/gmgn-entry-holders.js';
import {GmgnError} from '../src/providers/gmgn-client.js';
import type {GmgnScheduleOptions} from '../src/providers/gmgn-client.js';
import {assessEntryHolderRiskValues, normalizeStoredEntryHolderRisk, type EntryHolderRiskValues} from '../src/entry-holder-risk.js';

const NOW = '2026-10-25T14:00:00.000Z';
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const wallet = (n: number) => {const bytes = Buffer.alloc(32, 7); bytes.writeUInt32BE(n, 28); return bs58.encode(bytes);};
const row = (n: number, percentage: unknown = '0.01', tag = 'bundler'): Record<string, unknown> => ({
  address: wallet(n), amount_percentage: percentage, balance: percentage === '0' || percentage === 0 ? '0' : '100',
  amount_cur: percentage === '0' || percentage === 0 ? 0 : 100,
  maker_token_tags: [tag], tags: ['axiom'], addr_type: 0,
});
const info = () => ({address: TOKEN, chain: 'sol', stat: {top_10_holder_rate: '0.2319'}});
type Fixture = {info?: unknown; bundler?: unknown; ratTrader?: unknown; topHolders?: unknown};
function setup(fixture: Fixture = {}, now: () => Date = () => new Date(NOW)) {
  const calls: {path: string; query: Record<string, string | number>; weight?: number; scheduling?: GmgnScheduleOptions}[] = [];
  const client = {async get(path: string, query: Record<string, string | number>, weight?: number,
    scheduling?: GmgnScheduleOptions): Promise<unknown> {
    calls.push({path, query, weight, scheduling});
    const key = path === '/v1/token/info' ? 'info' : query.tag === 'bundler' ? 'bundler' : query.tag === 'rat_trader' ? 'ratTrader' : 'topHolders';
    const defaults = {info: info(), bundler: {list: [row(1)]}, ratTrader: {list: [row(2, '0.02', 'rat_trader')]}, topHolders: {list: []}};
    const value = Object.hasOwn(fixture, key) ? fixture[key] : defaults[key];
    if (value instanceof Error) throw value;
    return value;
  }};
  return {reader: new GmgnEntryHolderReader(client, {now}), calls};
}
const evidence = (result: EntryHolderRiskValues) => result.evidence as Record<string, any>;
const assessment = (result: EntryHolderRiskValues) => assessEntryHolderRiskValues(result, new Date(result.completedAt!));

test('uses only verified read routes with weights, SOL identity and descending supply ratios', async () => {
  const {reader, calls} = setup();
  const result = await reader.readHolderRisk(TOKEN);
  assert.equal(result.provider, 'gmgn'); assert.equal(result.chain, 'solana'); assert.equal(result.address, TOKEN);
  const scheduling = {priority: 'live_entry', queueTimeoutMs: 20_000};
  assert.deepEqual(calls, [
    {path: '/v1/token/info', query: {chain: 'sol', address: TOKEN}, weight: 1, scheduling},
    ...['bundler', 'rat_trader', undefined].map(tag => ({path: '/v1/market/token_top_holders', weight: 5,
      query: {chain: 'sol', address: TOKEN, limit: 100, order_by: 'amount_percentage', direction: 'desc', ...(tag ? {tag} : {})},
      scheduling})),
  ]);
  assert.deepEqual(result.values.top10, {value: '0.2319', sourceField: 'info.stat.top_10_holder_rate', coverage: 'complete'});
  assert.equal(result.values.bundler.value, '0.01'); assert.equal(result.values.ratTrader.value, '0.02');
  assert.equal(assessment(result).status, 'pass');
});

test('observed zero holdings are valid even when history wallet counts disagree with returned lists', async () => {
  const metadata = {...info(), holder_count: 985, wallet_tags_stat: {bundler_wallets: 184, rat_trader_wallets: 1}};
  const {reader} = setup({info: metadata,
    bundler: {list: Array.from({length: 100}, (_, i) => row(i + 1, 0))},
    ratTrader: {list: Array.from({length: 5}, (_, i) => row(i + 1, '0', 'rat_trader'))},
  });
  const result = await reader.readHolderRisk(TOKEN);
  assert.equal(result.values.bundler.value, '0'); assert.equal(result.values.ratTrader.value, '0');
  assert.equal(result.values.bundler.coverage, 'complete');
  assert.equal(evidence(result).bundler.completionBasis, 'zero_tail');
  assert.equal(evidence(result).ratTrader.completionBasis, 'less_than_limit');
  assert.equal(evidence(result).bundler.positiveWallets, 0);
  assert.equal(evidence(result).ratTrader.distinctWallets, 5);
  assert.equal(assessment(result).status, 'pass');
  assert.ok(!JSON.stringify(result).includes('wallet_tags_stat'));
});

test('exhausted empty tag lists and zero Top10 are genuine zero, not missing', async () => {
  const {reader} = setup({info: {address: TOKEN, stat: {top_10_holder_rate: 0}}, bundler: {list: []}, ratTrader: {list: []}});
  const result = await reader.readHolderRisk(TOKEN);
  assert.deepEqual(Object.values(result.values).map(value => value.value), ['0', '0', '0']);
  assert.equal(assessment(result).status, 'pass');
});

test('100 rows with zero tail still cover positive current holdings', async () => {
  const {reader} = setup({bundler: {list: [row(1, '0.1'), ...Array.from({length: 99}, (_, i) => row(i + 2, 0))]}});
  const result = await reader.readHolderRisk(TOKEN);
  assert.equal(result.values.bundler.value, '0.1'); assert.equal(result.values.bundler.coverage, 'complete');
  assert.equal(evidence(result).bundler.positiveWallets, 1);
  assert.equal(assessment(result).status, 'pass');
});

test('a full positive tail below or exactly at the limit is only a lower bound', async () => {
  for (const first of ['0.001', '0.301']) {
    const {reader} = setup({bundler: {list: [row(1, first), ...Array.from({length: 99}, (_, i) => row(i + 2, '0.001'))]}});
    const result = await reader.readHolderRisk(TOKEN);
    assert.equal(result.values.bundler.value, undefined);
    assert.equal(result.values.bundler.coverage, 'lower_bound');
    assert.equal(result.values.bundler.lowerBound, first === '0.001' ? '0.1' : '0.4');
    assert.equal(assessment(result).status, 'unavailable');
    assert.ok(evidence(result).bundler.reasons.includes('ENTRY_HOLDER_RISK_BUNDLER_COVERAGE_INCOMPLETE'));
  }
});

test('a truncated lower bound strictly above either tag limit can block immediately', async () => {
  for (const [tag, key, first] of [['bundler', 'bundler', '0.3010000000000000001'], ['rat_trader', 'ratTrader', '0.2010000000000000001']] as const) {
    const {reader} = setup({[key]: {list: [row(1, first, tag), ...Array.from({length: 99}, (_, i) => row(i + 2, '0.001', tag))]}});
    const result = await reader.readHolderRisk(TOKEN);
    assert.equal(result.values[key].coverage, 'lower_bound');
    assert.equal(result.values[key].value, tag === 'bundler' ? '0.4000000000000000001' : '0.3000000000000000001');
    assert.equal(assessment(result).status, 'blocked');
  }
});

test('exact addition preserves strict threshold boundary without float rounding', async () => {
  for (const [amount, expected] of [['0.2', 'pass'], ['0.2000000000000000001', 'blocked']] as const) {
    const {reader} = setup({bundler: {list: [row(1, amount), row(2, '0.2')]}});
    const result = await reader.readHolderRisk(TOKEN);
    assert.equal(assessment(result).status, expected);
  }
  const tiny = await setup({bundler: {list: [row(1, '1e-12')]}}).reader.readHolderRisk(TOKEN);
  assert.equal(tiny.values.bundler.value, '0.000000000001');
});

test('malformed ratios, balances, identities, tags, duplicates and order never become zero', async () => {
  const invalid: unknown[] = [undefined, null, {}, {list: null}, {list: Array.from({length: 101}, (_, i) => row(i))},
    ...[undefined, null, '', false, -0.01, '1.01', 'NaN', '0x1'].map(value => ({list: [{...row(1), amount_percentage: value}]})),
    ...[-1, '-1', null, false, undefined].map(balance => ({list: [{...row(1), balance}]})),
    {list: [{...row(1), amount_cur: '99'}]},
    {list: [{...row(1), address: 'fake-wallet'}]},
    {list: [{...row(1), maker_token_tags: ['rat_trader']}]},
    {list: [{...row(1), maker_token_tags: undefined, tags: ['bundler']}]},
    {list: [row(1), row(1)]},
    {list: [row(1, '0.01'), row(2, '0.02')]},
    {list: [row(1, '0.7'), row(2, '0.4')]},
    {list: [{...row(1), balance: 0, amount_cur: 0}]},
    {list: [{...row(1, 0), balance: 1, amount_cur: 1}]},
  ];
  for (const list of invalid) {
    const result = await setup({bundler: list}).reader.readHolderRisk(TOKEN);
    assert.equal(result.values.bundler.value, undefined, JSON.stringify(list));
    assert.equal(evidence(result).bundler.coverage, 'unknown');
    assert.ok(evidence(result).bundler.reasons.length);
    assert.equal(assessment(result).status, 'unavailable');
  }
});

test('balance alias is accepted when it is the only present documented current balance', async () => {
  const holder = row(1); delete holder.balance;
  const result = await setup({bundler: {list: [holder]}}).reader.readHolderRisk(TOKEN);
  assert.equal(result.values.bundler.value, '0.01');
});

test('a redundant numeric balance alias may round only to the same finite number representation', async () => {
  for (const balances of [
    {balance: '123456789.123456789', amount_cur: 123456789.12345679},
    {balance: 123456789.12345679, amount_cur: '123456789.123456789'},
  ]) {
    const result = await setup({bundler: {list: [{...row(1), ...balances}]}}).reader.readHolderRisk(TOKEN);
    assert.equal(result.values.bundler.value, '0.01');
    assert.equal(assessment(result).status, 'pass');
  }
});

test('different numeric balances and unequal exact string aliases remain unavailable', async () => {
  for (const balances of [
    {balance: '123456789.123456789', amount_cur: 123456789.1234568},
    {balance: '123456789.123456789', amount_cur: '123456789.12345679'},
    {balance: '123456789.123456789', amount_cur: Number.POSITIVE_INFINITY},
  ]) {
    const result = await setup({bundler: {list: [{...row(1), ...balances}]}}).reader.readHolderRisk(TOKEN);
    assert.equal(result.values.bundler.value, undefined);
    assert.equal(assessment(result).status, 'unavailable');
    assert.ok(evidence(result).bundler.reasons.includes('ENTRY_HOLDER_RISK_BUNDLER_BALANCE_INVALID'));
  }
});

test('invalid or mismatched SOL identity stops all holder queries', async () => {
  for (const data of [undefined, null, {}, {address: wallet(90)}, {...info(), chain: 'bsc'}, {...info(), address: TOKEN.toLowerCase()}]) {
    const {reader, calls} = setup({info: data});
    const result = await reader.readHolderRisk(TOKEN);
    assert.equal(calls.length, 1);
    assert.ok(Object.values(result.values).every(value => value.value === undefined));
    assert.equal(assessment(result).status, 'unavailable');
    assert.equal(evidence(result).identity.status, 'invalid');
  }
  const {reader, calls} = setup();
  await reader.readHolderRisk('https://untrusted.invalid');
  assert.equal(calls.length, 0);
});

test('Top10 comes only from stat aggregate, never another security or visible-list value', async () => {
  for (const missing of [undefined, null, '', -0.1, 1.1]) {
    const {reader} = setup({info: {address: TOKEN, top_10_holder_rate: 0.01,
      security: {top_10_holder_rate: 0.01}, stat: {top_10_holder_rate: missing}}, topHolders: {list: [row(1, '0.01')]}});
    const result = await reader.readHolderRisk(TOKEN);
    assert.equal(result.values.top10.value, undefined);
    assert.equal(assessment(result).status, 'unavailable');
  }
});

test('request failures remain unknown, keep independent metrics and expose no upstream secrets', async () => {
  const failure = new Error('credential=do-not-persist-this-url-or-response');
  const allMissing = await setup({info: failure}).reader.readHolderRisk(TOKEN);
  assert.ok(Object.values(allMissing.values).every(value => value.value === undefined));
  const result = await setup({bundler: new GmgnError('GMGN_RATE_LIMITED'), topHolders: failure}).reader.readHolderRisk(TOKEN);
  assert.equal(result.values.bundler.value, undefined);
  assert.equal(result.values.ratTrader.value, '0.02');
  assert.equal(result.values.top10.value, '0.2319');
  assert.ok(evidence(result).bundler.reasons.includes('GMGN_RATE_LIMITED'));
  assert.ok(!JSON.stringify(result).includes('credential'));
  assert.ok(!JSON.stringify(allMissing).includes('credential'));
});

test('unfiltered audit failure does not prevent a complete three-metric pass', async () => {
  for (const topHolders of [new GmgnError('GMGN_REQUEST_TIMEOUT'), {list: [row(1, 'not-a-ratio')]}]) {
    const result = await setup({topHolders}).reader.readHolderRisk(TOKEN);
    assert.equal(assessment(result).status, 'pass');
    assert.equal(evidence(result).topHolders.status, 'unavailable');
  }
});

test('top10 audit caps safe projection at 10 and identifies pools without replacing the aggregate', async () => {
  const result = await setup({topHolders: {list: Array.from({length: 15}, (_, i) => ({...row(i, '0.01'),
    addr_type: i === 0 ? 2 : i === 1 ? 1 : 0, name: 'secret-name', tags: ['entrapment'],
    private_upstream_payload: 'must-not-survive'}))}}).reader.readHolderRisk(TOKEN);
  const audit = evidence(result).topHolders;
  assert.equal(audit.rows, 15); assert.equal(audit.list.length, 10);
  assert.equal(audit.scope, 'visible_top10_not_aggregate');
  assert.equal(audit.list[0].kind, 'pool'); assert.equal(audit.list[1].kind, 'unknown'); assert.equal(audit.list[2].kind, 'wallet');
  assert.equal(result.values.top10.value, '0.2319');
  assert.ok(!JSON.stringify(result).includes('must-not-survive'));
  assert.ok(!JSON.stringify(result).includes('secret-name'));
});

test('trading ratios and undocumented entrapment tags are audit-only, never holder gates', async () => {
  const {reader, calls} = setup({info: {...info(), security: {bundler_trader_amount_rate: 1, rat_trader_amount_rate: 1},
    stat: {...info().stat, top_bundler_trader_percentage: 1, top_rat_trader_percentage: 1, top_entrapment_trader_percentage: '0.99'}},
    bundler: {list: []}, ratTrader: {list: []}, topHolders: {list: [{...row(1, '0.5'), maker_token_tags: ['entrapment']}]},
  });
  const result = await reader.readHolderRisk(TOKEN);
  assert.equal(result.values.bundler.value, '0'); assert.equal(result.values.ratTrader.value, '0');
  assert.equal(assessment(result).status, 'pass');
  assert.deepEqual(evidence(result).entrapment, {status: 'unsupported', documentedHoldingTag: false,
    sourceField: 'info.stat.top_entrapment_trader_percentage', scope: 'vendor_trading_metric_not_holdings', volumeRatio: '0.99'});
  assert.ok(calls.every(call => call.query.tag !== 'entrapment'));
});

test('checkedAt starts before the first read, so slow collection cannot renew stale evidence', async () => {
  let milliseconds = Date.parse(NOW);
  const now = () => {const instant = new Date(milliseconds); milliseconds += 35_000; return instant;};
  const result = await setup({}, now).reader.readHolderRisk(TOKEN);
  assert.equal(result.checkedAt, NOW);
  assert.equal(result.completedAt, '2026-10-25T14:00:35.000Z');
  assert.equal(assessment(result).status, 'unavailable');
  assert.ok(assessment(result).reasons.includes('ENTRY_HOLDER_RISK_STALE'));
});

test('reader assessments survive the durable normalizer with audit metadata and exact lower bounds', async () => {
  const cases: [Fixture, string][] = [
    [{topHolders: {list: [{...row(99, '0.15'), addr_type: 2}]}}, 'pass'],
    [{bundler: {list: [row(1, '0.4000000000000000001')]}}, 'blocked'],
    [{bundler: {list: Array.from({length: 100}, (_, i) => row(i, '0.001'))}}, 'unavailable'],
    [{ratTrader: new GmgnError('GMGN_RATE_LIMITED')}, 'unavailable'],
  ];
  for (const [fixture, status] of cases) {
    const result = await setup(fixture).reader.readHolderRisk(TOKEN);
    const evaluated = assessment(result);
    const normalized = normalizeStoredEntryHolderRisk(JSON.parse(JSON.stringify(evaluated)), {chain: 'solana', address: TOKEN});
    assert.equal(normalized?.status, status);
    assert.deepEqual(normalized, evaluated);
  }
});
