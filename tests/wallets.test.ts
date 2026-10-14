import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {z} from 'zod';
import {analyzeWallets, parseWalletIdentities} from '../src/research/wallets.js';
import type {WalletIdentity} from '../src/research/wallet-types.js';
import {GmgnClient, GmgnError} from '../src/providers/gmgn-client.js';
import {assessWalletSupport} from '../src/research.js';
import {signal, now, token} from './helpers.js';

const ca = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const a = ca(1), b = ca(2), c = ca(3), funder = ca(4), developer = ca(5);
const time = (deltaSeconds: number) => (now.getTime() + deltaSeconds * 1_000) / 1_000;
const info = (dev: Record<string, unknown> = {}) => ({address: token, chain: 'bsc', dev});
const holder = (address = a, extra: Record<string, unknown> = {}) => ({address, balance: '100', usd_value: '25', amount_percentage: '0.01',
  tags: ['smart_degen'], maker_token_tags: [], buy_volume_cur: '1000.01', sell_volume_cur: '250.02',
  start_holding_at: time(-86_400), last_active_timestamp: time(-60), end_holding_at: null,
  buy_tx_count_cur: 10, sell_tx_count_cur: 2, ...extra});
const event = (event_type: string, cost_usd = '10', seconds = -60, extra: Record<string, unknown> = {}) => ({
  tx_hash: ca(Math.abs(seconds)), event_type, cost_usd, timestamp: time(seconds), token: {address: token}, token_amount: '1', ...extra});
type Query = Record<string, string | number>;
type Resolver = (path: string, query: Query) => unknown;
class FakeClient extends GmgnClient {
  calls: {path: string; query: Query; weight?: number}[] = [];
  constructor(private resolver: Resolver) {super();}
  override async get(path: string, query: Query, weight?: number): Promise<unknown> {
    this.calls.push({path, query, weight}); return this.resolver(path, query);
  }
}
function clientFor(rows: unknown[], options: {smart?: unknown[]; stats?: Resolver; activity?: Resolver} = {}) {
  return new FakeClient((path, query) => {
    if (path.endsWith('token_top_holders')) return {list: query.tag ? options.smart ?? rows : rows};
    if (path.endsWith('wallet_stats')) return options.stats?.(path, query) ?? {realized_profit: '123.1', total_cost: '1000', winrate: '0.6', buy_count: 10, sell_count: 4};
    if (path.endsWith('wallet_activity')) return options.activity?.(path, query) ?? {activities: [event('buy')], next: null};
    throw Error('unexpected route');
  });
}
const opts = {now: () => now};

test('uses official chain+CA holder and wallet routes, exact units and recent/cumulative scopes', async () => {
  const client = clientFor([holder()]);
  const result = await analyzeWallets(signal(), info(), client, opts);
  assert.equal(result.status, 'pass');
  assert.deepEqual(client.calls[0], {path: '/v1/market/token_top_holders', weight: 5,
    query: {chain: 'bsc', address: token, limit: 20, order_by: 'amount_percentage', direction: 'desc'}});
  assert.equal(client.calls[1].query.tag, 'smart_degen');
  assert.deepEqual(client.calls[3], {path: '/v1/user/wallet_activity', weight: 3,
    query: {chain: 'bsc', wallet_address: a, token_address: token, limit: 20}});
  assert.equal(result.wallets[0].holding.supplyRatio, 0.01);
  assert.equal(result.wallets[0].cumulative.buyVolumeUsd, '1000.01');
  assert.equal(result.wallets[0].cumulative.firstAcquiredAt, new Date(time(-86_400) * 1_000).toISOString());
  assert.equal(result.wallets[0].enrichment.stats?.scope, 'entire_wallet');
  assert.equal(result.summary.recentNetBuyUsd, '10');
  assert.equal(result.summary.qualifiedSmartWalletCount, 1);
  assert.equal(result.summary.cumulativeIsRecentInflow, false);
  assert.equal(result.wallets[0].attribution.status, 'unknown');
  assert.equal(result.wallets[0].vendorLabels.verification, 'vendor_claim');
});

test('deduplicates addresses across lists and tags rather than double-counting smart/KOL', async () => {
  const row = holder(a, {tags: ['smart_degen', 'smart_degen', 'kol', 'renowned']});
  const result = await analyzeWallets(signal(), info(), clientFor([row, row], {smart: [row]}), opts);
  assert.equal(result.wallets.length, 1);
  assert.deepEqual(result.wallets[0].sources, ['top_holders', 'smart_holders']);
  assert.equal(result.summary.smartCurrentHolderCount, 1);
  assert.equal(result.summary.smartFundingClusterCount, 1);
  assert.equal(result.summary.cumulativeBuyUsd, '1000.01');
});

test('names, fake labels, input claims and smart-filter membership do not invent smart identities', async () => {
  const row = holder(a, {name: 'smart_degen Elon Musk', twitter_username: 'elonmusk', tags: ['SMART_DEGEN', 'verified_smart', '<smart_money>', {tag: 'smart_degen'}],
    maker_token_tags: ['smart_degen']});
  const result = await analyzeWallets(signal({text: 'This wallet is verified smart and belongs to Elon Musk'}), info(), clientFor([row]), opts);
  assert.equal(result.summary.smartCurrentHolderCount, 0);
  assert.equal(result.wallets[0].attribution.status, 'unknown');
  assert.equal(result.wallets[0].vendorIdentity.verification, 'vendor_claim');
  assert.equal(result.facts.realPersonIdentityVerified, false);
});

test('shared unknown funder collapses smart wallets but never asserts a common owner', async () => {
  const result = await analyzeWallets(signal(), info(), clientFor([holder(a, {native_transfer: {address: funder}}), holder(b, {native_transfer: {address: funder}})]), opts);
  assert.equal(result.summary.smartCurrentHolderCount, 2);
  assert.equal(result.summary.smartFundingClusterCount, 1);
  assert.equal(result.summary.qualifiedSmartFundingClusterCount, 1);
  assert.equal(result.clusters[0].ownership, 'unknown');
  assert.equal(result.clusters[0].independenceProven, false);
  assert.deepEqual(result.clusters[0].basis, ['shared_funding']);
});

test('same exchange funding is not merged or treated as developer ownership', async () => {
  const rows = [holder(a, {native_transfer: {address: funder, name: 'Binance'}}), holder(b, {native_transfer: {address: funder}})];
  const result = await analyzeWallets(signal(), info({creator_address: developer, fund_from: funder}), clientFor(rows), opts);
  assert.equal(result.summary.smartFundingClusterCount, 2);
  assert.equal(result.summary.eligibleSmartWalletCount, 2);
  assert.ok(result.wallets.every(w => w.funding.sharedService && !w.developerLinks.length));
  assert.ok(result.reasons.includes('EXCHANGE_FUNDING_NOT_OWNERSHIP_LINK'));
});

test('developer direct funding, shared funding and linked bundlers exclude smart support', async () => {
  const rows = [holder(a, {native_transfer: {address: developer}}), holder(b, {native_transfer: {address: funder}}),
    holder(c, {native_transfer: {address: funder}, maker_token_tags: ['bundler']})];
  const result = await analyzeWallets(signal(), info({creator_address: developer, fund_from: funder}), clientFor(rows), opts);
  assert.equal(result.summary.eligibleSmartWalletCount, 0);
  assert.equal(result.summary.qualifiedSmartWalletCount, 0);
  assert.ok(result.wallets[0].developerLinks.includes('DEVELOPER_DIRECT_FUNDING'));
  assert.ok(result.wallets[1].developerLinks.includes('SHARED_DEVELOPER_FUNDING'));
  assert.equal(result.clusters.length, 1);
});

test('rat and bundler tags contaminate their funding cluster, not just one address', async () => {
  const result = await analyzeWallets(signal(), info(), clientFor([holder(a, {native_transfer: {address: funder}}),
    holder(b, {native_transfer: {address: funder}, tags: [], maker_token_tags: ['rat_trader']})]), opts);
  assert.equal(result.summary.smartCurrentHolderCount, 1);
  assert.equal(result.summary.eligibleSmartWalletCount, 0);
});

test('exchange/pool addresses and exited holders are not counted as smart support', async () => {
  const result = await analyzeWallets(signal(), info(), clientFor([holder(a, {addr_type: 2}), holder(b, {balance: '0', amount_percentage: '0', end_holding_at: time(-10)})]), opts);
  assert.equal(result.summary.eligibleSmartWalletCount, 0);
  assert.equal(result.wallets[1].holding.currentlyHolding, false);
  assert.equal(result.wallets[1].cumulative.exitedAt, new Date(time(-10) * 1_000).toISOString());
});

test('locally configured attribution is explicit, chain-scoped and unverified', async () => {
  const entries: WalletIdentity[] = [{chain: 'robinhood', address: a, label: 'Different chain', entityId: 'other', category: 'public_entity', reference: 'https://example.org/proof'},
    {chain: 'bsc', address: b, label: 'Operator label', entityId: 'group', category: 'operator_defined', reference: 'My unverified research note'}];
  const result = await analyzeWallets(signal(), info(), clientFor([holder(a), holder(b)]), {...opts, identities: entries});
  assert.equal(result.wallets[0].attribution.status, 'unknown');
  assert.equal(result.wallets[1].attribution.status, 'operator_supplied');
  assert.equal(result.wallets[1].attribution.verification, 'unverified');
  assert.equal(result.wallets[1].attribution.identity?.label, 'Operator label');
});

test('strict identity parser rejects fake public sources, injected fields and conflicting duplicates', () => {
  const entry = {chain: 'bsc', address: a, label: 'label', entityId: 'entity', category: 'public_entity', reference: 'https://example.org/public'};
  assert.throws(() => parseWalletIdentities({...entry}), z.ZodError);
  assert.throws(() => parseWalletIdentities([{...entry, reference: 'I know him'}]), z.ZodError);
  assert.throws(() => parseWalletIdentities([{...entry, reference: 'https://user:password@example.org'}]), z.ZodError);
  assert.throws(() => parseWalletIdentities([{...entry, verified: true}]), z.ZodError);
  assert.throws(() => parseWalletIdentities([entry, entry]), z.ZodError);
  assert.throws(() => parseWalletIdentities([{...entry, chain: 'solana'}]), z.ZodError);
  assert.equal(parseWalletIdentities([entry, {...entry, chain: 'robinhood'}]).length, 2);
});

test('local exchange mapping suppresses shared-funding edges, local entity mapping only groups claims', async () => {
  const entries: WalletIdentity[] = [a, b].map(address => ({chain: 'bsc', address, label: 'Research group', entityId: 'one', category: 'operator_defined', reference: 'local note'}));
  const grouped = await analyzeWallets(signal(), info(), clientFor([holder(a), holder(b)]), {...opts, identities: entries});
  assert.equal(grouped.summary.smartFundingClusterCount, 1);
  assert.ok(grouped.clusters[0].basis.includes('operator_entity'));
  const exchange = {chain: 'bsc', address: funder, label: 'CEX', entityId: 'cex', category: 'exchange', reference: 'https://example.org/exchange'} as const;
  const result = await analyzeWallets(signal(), info(), clientFor([holder(a, {native_transfer: {address: funder}}), holder(b, {native_transfer: {address: funder}})]), {...opts, identities: [exchange]});
  assert.equal(result.summary.smartFundingClusterCount, 2);
});

test('Solana maps API chain to sol and preserves case with bs58 32-byte validation', async () => {
  const mint = bs58.encode(new Uint8Array(32).fill(11));
  const wallet = bs58.encode(new Uint8Array(32).fill(3));
  const s = signal({token: {chain: 'solana', address: mint}});
  const client = clientFor([holder(wallet), holder(a), holder('not-base58')], {smart: []});
  const result = await analyzeWallets(s, {address: mint, chain: 'sol'}, client, opts);
  assert.equal(result.wallets.length, 1);
  assert.equal(result.wallets[0].address, wallet);
  assert.equal(client.calls[0].query.chain, 'sol');
  assert.equal(result.status, 'unknown'); // The intentionally wrong-chain activity is also rejected.
});

test('token info CA/chain mismatch prevents any wallet requests', async () => {
  for (const value of [{...info(), address: a}, {...info(), chain: 'robinhood'}, {...info(), token_address: a}, null]) {
    const client = clientFor([holder()]);
    const result = await analyzeWallets(signal(), value, client, opts);
    assert.equal(client.calls.length, 0);
    assert.equal(result.status, 'unknown');
    assert.equal(result.wallets.length, 0);
  }
});

test('mismatched holder scopes and activity CAs are dropped instead of contributing purchases', async () => {
  const client = clientFor([holder(a, {chain: 'robinhood'}), holder(b, {token_address: a}), holder(c)],
    {smart: [], activity: () => ({activities: [event('buy', '1000000', -5, {token: {address: a}})], next: null})});
  const result = await analyzeWallets(signal(), info(), client, opts);
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.wallets.map(w => w.address), [c]);
  assert.equal(result.summary.hasRecentAccumulation, null);
  assert.equal(result.summary.qualifiedSmartWalletCount, 0);
});

test('token-address mismatch on the holders envelope is rejected', async () => {
  const client = new FakeClient(() => ({address: a, list: [holder()]}));
  const result = await analyzeWallets(signal(), info(), client, opts);
  assert.equal(result.wallets.length, 0);
  assert.equal(result.status, 'unknown');
});

test('empty/malformed/error responses stay unknown and preserve partial evidence', async () => {
  const empty = await analyzeWallets(signal(), info(), clientFor([]), opts);
  assert.equal(empty.status, 'unknown');
  assert.ok(empty.reasons.includes('GMGN_HOLDERS_EMPTY'));
  const client = clientFor([holder()], {stats: () => {throw Error('secret upstream message');}});
  const result = await analyzeWallets(signal(), info(), client, opts);
  assert.equal(result.status, 'unknown');
  assert.equal(result.wallets.length, 1);
  assert.equal(result.wallets[0].enrichment.status, 'partial');
  assert.ok((result.facts.rawResponses as Record<string, unknown>).top_holders);
  assert.ok(!JSON.stringify(result).includes('secret upstream'));
});

test('explicit rate-limit reasons and cooldown survive without leaking errors', async () => {
  const client = new FakeClient(() => {throw new GmgnError('GMGN_RATE_LIMITED', now.getTime() + 60_000, now.getTime());});
  const result = await analyzeWallets(signal(), info(), client, opts);
  assert.ok(result.reasons.includes('GMGN_RATE_LIMITED'));
  assert.equal((result.facts.rawResponses as Record<string, unknown>).cooldownUntil, new Date(now.getTime() + 60_000).toISOString());
});

test('cumulative amounts never qualify as recent flow; transfers and old buys are excluded', async () => {
  const client = clientFor([holder()], {activity: () => ({activities: [event('transferIn', '999999', -5), event('buy', '99999', -7200)], next: null})});
  const result = await analyzeWallets(signal(), info(), client, opts);
  assert.equal(result.summary.cumulativeBuyUsd, '1000.01');
  assert.equal(result.summary.recentNetBuyUsd, '0');
  assert.equal(result.summary.hasRecentAccumulation, false);
  assert.equal(result.summary.qualifiedSmartWalletCount, 0);
});

test('decimal arithmetic is exact, duplicate activity is not counted twice and sells subtract', async () => {
  const buy = event('buy', '0.1', -60);
  const client = clientFor([holder(a, {buy_volume_cur: '9007199254740993.01', sell_volume_cur: '0'})], {
    activity: () => ({activities: [buy, buy, event('buy', '0.2', -100), event('sell', '0.05', -110)], next: null})});
  const result = await analyzeWallets(signal(), info(), client, opts);
  assert.equal(result.summary.recentNetBuyUsd, '0.25');
  assert.equal(result.summary.cumulativeBuyUsd, '9007199254740993.01');
  assert.equal(result.wallets[0].enrichment.activity?.events.length, 3);
});

test('partial pages and missing pagination cannot prove recent accumulation', async () => {
  for (const cursor of ['more', undefined]) {
    const result = await analyzeWallets(signal(), info(), clientFor([holder()], {activity: () => ({activities: [event('buy')], next: cursor})}), opts);
    assert.equal(result.summary.recentNetBuyUsd, null);
    assert.equal(result.summary.hasRecentAccumulation, null);
    assert.equal(result.summary.qualifiedSmartFundingClusterCount, 0);
  }
});

test('descending activity covering the window boundary suffices even with older pages left', async () => {
  const result = await analyzeWallets(signal(), info(), clientFor([holder()], {
    activity: () => ({activities: [event('buy', '10', -10), event('sell', '3', -100), event('sell', '1000', -3601)], next: 'older'})}), opts);
  assert.equal(result.summary.recentNetBuyUsd, '7');
  assert.equal(result.wallets[0].enrichment.activity?.recent.coverage, 'vendor_window_covered');
});

test('out-of-order, future or missing-price rows cannot provide a complete recent window', async () => {
  for (const activities of [[event('buy', '10', -4000), event('buy', '10', -10)],
    [event('buy', '10', 20), event('buy', '10', -4000)], [event('buy', '10', -10, {cost_usd: null}), event('sell', '1', -4000)]]) {
    const result = await analyzeWallets(signal(), info(), clientFor([holder()], {activity: () => ({activities, next: 'more'})}), opts);
    assert.equal(result.summary.hasRecentAccumulation, null);
  }
});

test('enrichment is capped at five and defaults to three while retaining unsampled holders', async () => {
  const rows = Array.from({length: 8}, (_, i) => holder(ca(100 + i)));
  for (const [maxWallets, expected] of [[undefined, 3], [100, 5]] as const) {
    const client = clientFor(rows);
    const result = await analyzeWallets(signal(), info(), client, {...opts, maxWallets});
    assert.equal(result.wallets.length, 8);
    assert.equal(result.summary.enrichedWalletCount, expected);
    assert.equal(client.calls.filter(c => c.path.endsWith('wallet_stats')).length, expected);
    assert.equal(result.summary.qualifiedSmartWalletCount, expected);
    assert.equal(result.summary.recentNetBuyUsd, null);
  }
});

test('stats funding enriches missing sources, conflicting funding cannot become independent support', async () => {
  const stats = (_: string, q: Query) => ({winrate: 0.5, common: {fund_from_address: funder, fund_from: 'unknown', tags: ['smart_money'], name: 'Vendor display'}});
  const result = await analyzeWallets(signal(), info(), clientFor([holder(a, {tags: []}), holder(b, {native_transfer: {address: c}})], {stats}), opts);
  assert.equal(result.wallets[0].funding.source, 'wallet_stats');
  assert.equal(result.wallets[0].recognizedLabels.includes('smart'), true);
  assert.equal(result.wallets[1].funding.conflict, true);
  assert.equal(result.summary.eligibleSmartWalletCount, 1);
});

test('stats for another wallet and ambiguous batch results are not attributed to the requested holder', async () => {
  for (const stats of [{wallet_address: b, common: {tags: ['smart_money']}}, [{winrate: 1}], {common: {tags: ['smart_money']}}]) {
    const result = await analyzeWallets(signal(), info(), clientFor([holder(a, {tags: []})], {stats: () => stats}), opts);
    assert.equal(result.wallets[0].enrichment.status, 'partial');
    assert.equal(result.summary.smartCurrentHolderCount, 0);
  }
});

test('conflicting snapshots and missing balances are unknown, never silently zero holdings', async () => {
  const result = await analyzeWallets(signal(), info(), clientFor([holder(a)], {smart: [holder(a, {balance: '0'})]}), opts);
  assert.equal(result.status, 'unknown');
  assert.ok(result.reasons.includes('GMGN_DUPLICATE_HOLDINGS_DIFFER'));
  const missing = await analyzeWallets(signal(), info(), clientFor([holder(a, {balance: null})]), opts);
  assert.equal(missing.wallets[0].holding.currentlyHolding, null);
  assert.equal(missing.summary.smartCurrentHolderCount, 0);
});

test('live GMGN field shapes: native_transfer.from_address, stats buy/sell, pnl_stat.winrate and activity wallet', async () => {
  const client = clientFor([holder(a, {native_transfer: {from_address: funder, name: null, amount: '1.25', timestamp: time(-5000), tx_hash: '0xfunding'}})], {
    stats: () => ({wallet_address: a, buy: 164, sell: 160, total_cost: '99355.65968703012111667831', realized_profit: '2',
      pnl_stat: {winrate: 0.628571}, common: {wallet_address: '', fund_from_address: funder, tags: ['smart_degen']}}),
    activity: () => ({activities: [event('buy', '10', -60, {wallet: a, chain: 'bsc'})], next: ''}),
  });
  const result = await analyzeWallets(signal(), info(), client, opts);
  assert.equal(result.status, 'pass');
  assert.equal(result.wallets[0].funding.address, funder);
  assert.equal(result.wallets[0].funding.source, 'both');
  assert.equal(result.wallets[0].funding.amount, '1.25');
  assert.equal(result.wallets[0].enrichment.stats?.buyCount, 164);
  assert.equal(result.wallets[0].enrichment.stats?.sellCount, 160);
  assert.equal(result.wallets[0].enrichment.stats?.winRate, 0.628571);
  assert.equal(result.summary.qualifiedSmartWalletCount, 1);
});

test('contradictory funding aliases and wrong activity wallet cannot qualify', async () => {
  const conflict = await analyzeWallets(signal(), info(), clientFor([holder(a, {native_transfer: {from_address: funder, address: b}})]), opts);
  assert.equal(conflict.wallets[0].funding.conflict, true);
  assert.equal(conflict.status, 'unknown');
  assert.equal(conflict.summary.eligibleSmartWalletCount, 0);
  const wrongWallet = await analyzeWallets(signal(), info(), clientFor([holder(a)], {activity: () => ({activities: [event('buy', '10', -60, {wallet: b})], next: ''})}), opts);
  assert.equal(wrongWallet.status, 'unknown');
  assert.equal(wrongWallet.summary.qualifiedSmartWalletCount, 0);
});

test('activity received after research starts uses its own receipt clock; genuinely future rows stay invalid', async () => {
  for(const future of [false,true]) {
    let clockMs=now.getTime();
    const client=new FakeClient((path)=>{
      clockMs+=2_000;
      if(path.endsWith('token_top_holders'))return {list:[holder()]};
      if(path.endsWith('wallet_stats'))return {realized_profit:'20'};
      if(path.endsWith('wallet_activity'))return {activities:[event('buy','10',0,{timestamp:(clockMs+(future?1_000:-1_000))/1_000})],next:null};
      throw new Error('unexpected route');
    });
    const result=await analyzeWallets(signal(),info(),client,{now:()=>new Date(clockMs)});
    assert.equal(result.checkedAt,new Date(now.getTime()+8_000).toISOString());
    assert.equal(result.facts.collectionStartedAt,now.toISOString());
    assert.equal(result.wallets[0].enrichment.activity?.recent.until,result.checkedAt);
    assert.equal(result.summary.qualifiedSmartFundingClusterCount,future?0:1);
    assert.equal(result.reasons.includes('GMGN_WALLET_ACTIVITY_DATA_INVALID'),future);
  }
});

test('launch activity is retained as a vendor developer link, excluded from flow and contaminates its funding group', async () => {
  for(const shared of [false,true]) {
    const rows=[holder(a),holder(b,shared?{native_transfer:{address:funder}}:{}),holder(c,{native_transfer:{address:funder}})];
    const client=clientFor(rows,{activity:(_,query)=>({activities:query.wallet_address===c?[event('buy'),event('launch','900000',-100)]:[event('buy')],next:null})});
    const result=await analyzeWallets(signal(),info(),client,opts),launched=result.wallets.find(w=>w.address===c)!;
    assert.equal(result.status,'pass');
    assert.deepEqual(launched.developerLinks,['VENDOR_TOKEN_LAUNCH_ACTIVITY']);
    assert.equal(launched.enrichment.activity?.events.length,1);
    assert.equal(launched.enrichment.activity?.recent.netBuyUsd,'10');
    assert.equal(result.summary.qualifiedSmartFundingClusterCount,shared?1:2);
    assert.equal(assessWalletSupport(result,2,now).status,shared?'unknown':'pass');
    assert.equal((result.facts.rawResponses as Record<string,any>)[`activity:${c}`].activities[1].event_type,'launch');
  }
});

test('two complete safe groups can support despite a third missing enrichment, without changing sample availability', async () => {
  const result=await analyzeWallets(signal(),info(),clientFor([holder(a),holder(b),holder(c)],{
    stats:(_,query)=>query.wallet_address===c?{}:{realized_profit:'20'}}),opts);
  assert.equal(result.status,'unknown');
  assert.equal(result.summary.qualifiedSmartFundingClusterCount,2);
  const flow=assessWalletSupport(result,2,now);
  assert.equal(flow.status,'pass');assert.equal(flow.facts.partialSampleIsolated,true);
  assert.deepEqual(flow.facts.excludedPartialWallets,[c]);
  assert.equal((flow.facts.completeSupportGroups as string[]).length,2);
  assert.equal(assessWalletSupport(result,3,now).status,'unknown');
  assert.equal(assessWalletSupport(result,2,new Date(now.getTime()+120_001)).status,'unknown');
});

test('partial-sample support cannot bypass malformed identities, activities, conflicting holdings/funding or new diagnostics', async () => {
  for(const issue of ['stats_scope','activity_scope','future','holdings','funding','unknown_reason'] as const) {
    const rows=[holder(a),holder(b),holder(c,issue==='funding'?{native_transfer:{address:b}}:{})];
    const client=clientFor(rows,{
      smart:issue==='holdings'?[holder(a),holder(b),holder(c,{balance:'0'})]:rows,
      stats:(_,query)=>query.wallet_address!==c?{realized_profit:'20'}:issue==='stats_scope'?{wallet_address:b,realized_profit:'20'}:
        issue==='funding'?{realized_profit:'20',common:{fund_from_address:a}}:{},
      activity:(_,query)=>({activities:query.wallet_address===c&&issue==='activity_scope'?[event('buy','10',-1,{token:{address:ca(999)}})]:
        query.wallet_address===c&&issue==='future'?[event('buy','10',1)]:[event('buy')],next:null})});
    const result=await analyzeWallets(signal(),info(),client,opts);
    if(issue==='unknown_reason')result.reasons.push('FUTURE_PROVIDER_VALIDATION_FAILURE');
    assert.equal(result.status,'unknown',issue);
    assert.equal(assessWalletSupport(result,2,now).status,'unknown',issue);
  }
});

test('partial-sample support still collapses funding groups and verifies the supporting wallet evidence', async () => {
  const result=await analyzeWallets(signal(),info(),clientFor([holder(a),holder(b),holder(c)],{
    stats:(_,query)=>query.wallet_address===c?{}:{realized_profit:'20'}}),opts);
  for(const invalidate of [
    (r:typeof result)=>{r.wallets[0].holding.currentlyHolding=false;},
    (r:typeof result)=>{r.wallets[0].funding.conflict=true;},
    (r:typeof result)=>{r.wallets[0].developerLinks.push('VENDOR_TOKEN_LAUNCH_ACTIVITY');},
    (r:typeof result)=>{r.wallets[0].enrichment.activity!.recent.coverage='partial';},
    (r:typeof result)=>{r.wallets[0].enrichment.activity!.recent.netBuyUsd='-1';},
    (r:typeof result)=>{r.facts.token={chain:'solana',address:token};},
  ]) {
    const changed=structuredClone(result);invalidate(changed);assert.equal(assessWalletSupport(changed,2,now).status,'unknown');
  }
  const merged=await analyzeWallets(signal(),info(),clientFor([holder(a,{native_transfer:{address:funder}}),holder(b,{native_transfer:{address:funder}}),holder(c)],{
    stats:(_,query)=>query.wallet_address===c?{}:{realized_profit:'20'}}),opts);
  assert.equal(merged.summary.qualifiedSmartFundingClusterCount,1);assert.equal(assessWalletSupport(merged,2,now).status,'unknown');
});
