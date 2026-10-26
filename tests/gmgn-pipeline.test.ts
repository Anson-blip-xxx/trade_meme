import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readConfig, type Config} from '../src/config.js';
import {evaluate, type Providers} from '../src/engine.js';
import {EntryController} from '../src/entry.js';
import {OrderStore} from '../src/orders.js';
import {Store} from '../src/store.js';
import {researchProvider} from '../src/research.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import type {Report} from '../src/types.js';
import {signal, token, now, pass, evidence, narrative} from './helpers.js';

test('real-shaped GMGN research → candidate → durable paper order; replay never trades or stores raw research', async t => {
  t.mock.timers.enable({apis: ['Date'], now: now.getTime()});
  // Any forgotten provider injection is a test failure, never a real request.
  t.mock.method(globalThis, 'fetch', async () => {throw new Error('UNEXPECTED_NETWORK_ACCESS');});
  const dir = mkdtempSync(join(tmpdir(), 'meme-gmgn-pipeline-'));
  const path = join(dir, 'orders.sqlite');
  let cache: Store | undefined = new Store(':memory:');
  let orders: OrderStore | undefined = new OrderStore(path);
  t.after(() => {cache?.close(); orders?.close(); rmSync(dir, {recursive: true, force: true});});

  const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
  const smartWallets = [address(11), address(12)];
  const fundingWallets = [address(21), address(22)];
  const account = address(31), inputToken = address(0), amount = '1000000000000000';
  const apiKey = `synthetic-pipeline-key-${randomUUID()}`;
  const markers = {
    signal: 'RAW_SIGNAL_TEXT_MUST_STAY_IN_MEMORY',
    token: 'RAW_TOKEN_DESCRIPTION_MUST_STAY_IN_MEMORY',
    wallet: 'RAW_WALLET_PROFILE_MUST_STAY_IN_MEMORY',
    narrative: 'RAW_NARRATIVE_RESPONSE_MUST_STAY_IN_MEMORY',
    activity: 'RAW_ACTIVITY_PAYLOAD_MUST_STAY_IN_MEMORY',
  };
  const config: Config = {...readConfig({}), gmgnApiKey: apiKey, gmgnMinIntervalMs: 0,
    entryMode: 'paper', entrySizing: 'fixed', entryBalanceBps: {}, gmgnPrivateKey: undefined, walletSupportRequired: true,
    minSmartWalletGroups: 2, walletMaxProfiles: 2, entryWallets: {bsc: account},
    entryInputTokens: {bsc: inputToken}, entryAmounts: {bsc: amount}};
  const incoming = signal({sourceEventId: `pipeline-${randomUUID()}`, text: markers.signal});
  const seconds = (ago: number) => Math.floor(now.getTime() / 1_000) - ago;
  const calls: {url: URL; method: string}[] = [];
  let signedCalls = 0, socialCalls = 0, narrativeCalls = 0;

  // Response shapes follow the limited live OpenAPI check: native_transfer.from_address,
  // stats buy/sell + pnl_stat.winrate, blank common.wallet_address, and activity next=''.
  const client = new GmgnClient({apiKey, minIntervalMs: 0, fetcher: async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    calls.push({url, method});
    assert.equal(url.origin, 'https://openapi.gmgn.ai');
    assert.equal(method, 'GET');
    assert.equal(init?.credentials, 'omit');
    assert.equal(url.searchParams.get('chain'), 'bsc');
    let data: unknown;
    switch (url.pathname) {
      case '/v1/token/info':
        assert.equal(url.searchParams.get('address'), token);
        data = {address: token, chain: 'bsc', name: 'Synthetic integration token',
          price: {price: '0.001'}, holder_count: 20, creation_timestamp: seconds(86_400),
          dev: {creator_address: address(41), fund_from: address(42)},
          link: {description: markers.token}, wallet_tags_stat: {smart_wallets: 2}};
        break;
      case '/v1/token/security':
        data = {address: token, is_honeypot: 0, is_open_source: true, owner_renounced: 'yes', buy_tax: '0', sell_tax: '0'};
        break;
      case '/v1/token/pool_info':
        data = {base_address: token, pool_address: address(51), exchange: 'pancakeswap', liquidity: '100000'};
        break;
      case '/v1/market/token_top_holders':
        assert.equal(url.searchParams.get('address'), token);
        assert.ok([null, 'smart_degen'].includes(url.searchParams.get('tag')));
        data = {list: smartWallets.map((wallet, i) => ({address: wallet, addr_type: 0,
          balance: 100 + i, amount_cur: 100 + i, usd_value: 50, amount_percentage: 0.01,
          buy_volume_cur: 10000, sell_volume_cur: 2000, buy_tx_count_cur: 40, sell_tx_count_cur: 10,
          start_holding_at: seconds(86_400), last_active_timestamp: seconds(60), end_holding_at: 0,
          tags: ['smart_degen', 'kol'], maker_token_tags: [], is_suspicious: false,
          native_transfer: {from_address: fundingWallets[i], name: null, amount: '1.5',
            timestamp: seconds(100_000), tx_hash: `0x${'a'.repeat(64)}`}}))};
        break;
      case '/v1/user/wallet_stats': {
        const wallet = url.searchParams.get('wallet_address')!;
        const i = smartWallets.indexOf(wallet);
        assert.notEqual(i, -1); assert.equal(url.searchParams.get('period'), '7d');
        data = {wallet_address: wallet, realized_profit: '250.75', total_cost: '2000.25',
          buy: 164, sell: 160, pnl_stat: {winrate: 0.6, token_num: 77},
          common: {wallet_address: '', name: markers.wallet, twitter_description: markers.wallet.repeat(20),
            tags: ['smart_degen'], fund_from: '', fund_from_address: fundingWallets[i]}};
        break;
      }
      case '/v1/user/wallet_activity': {
        const wallet = url.searchParams.get('wallet_address')!;
        assert.ok(smartWallets.includes(wallet));
        assert.equal(url.searchParams.get('token_address'), token);
        data = {activities: [
          {wallet, chain: 'bsc', tx_hash: `0x${'b'.repeat(64)}`, event_type: 'sell', timestamp: seconds(60),
            token: {address: token, symbol: 'SYNTH'}, token_amount: '10', cost_usd: '20.25', vendor_note: markers.activity},
          {wallet, chain: 'bsc', tx_hash: `0x${'c'.repeat(64)}`, event_type: 'buy', timestamp: seconds(120),
            token: {address: token, symbol: 'SYNTH'}, token_amount: '50', cost_usd: '100.50'},
        ], next: ''};
        break;
      }
      case '/v1/trade/quote':
        assert.equal(url.searchParams.get('from_address'), account);
        assert.equal(url.searchParams.get('input_token'), inputToken);
        assert.equal(url.searchParams.get('output_token'), token);
        assert.equal(url.searchParams.get('input_amount'), amount);
        data = {input_token: inputToken, output_token: token, input_amount: amount,
          output_amount: '123456789012345678901', min_output_amount: '117283949561728394955', slippage: 5};
        break;
      default: assert.fail(`Unexpected GMGN path: ${url.pathname}`);
    }
    return Response.json({code: 0, data});
  }});
  const providers: Providers = {
    research: researchProvider(config, client, []),
    provenance: async (_signal, research) => {
      assert.equal((research?.snapshot.info as {address:string}|undefined)?.address, token);
      // Source checks receive the early token snapshot, without waiting for wallet enrichment.
      assert.equal(Object.hasOwn(research??{},'wallets'),false);
      return {...pass(), platform: 'four', facts: {creationTransactionVerified: true}};
    },
    safety: async () => ({...pass(), facts: {permissionsChecked: true}}),
    evidence: async () => {socialCalls++; return evidence();},
    narrative: async (_signal, posts) => {
      narrativeCalls++;
      assert.equal(posts.length, 1);
      return {...narrative(), evidence: posts, facts: {rawResponse: markers.narrative}};
    },
  };
  const controller = (store: OrderStore) => new EntryController(config, store, client, {
    now: () => new Date(), fetcher: async () => {signedCalls++; throw new Error('PAPER_MUST_NOT_SUBMIT');},
  });
  const reservation = cache.reserve(incoming);
  let report: Report | undefined = await evaluate(incoming, config, providers, {id: reservation.entry.id, now: () => new Date()});
  assert.equal(report.decision, 'BUY_CANDIDATE'); assert.equal(report.buyEligible, true);
  assert.equal(report.safety.status, 'pass'); assert.equal(report.provenance.status, 'pass');
  assert.equal(report.narrative.status, 'pass'); assert.equal(report.flow?.status, 'pass');
  assert.equal(report.wallets?.status, 'pass');
  assert.equal(report.wallets?.summary.smartCurrentHolderCount, 2);
  assert.equal(report.wallets?.summary.qualifiedSmartFundingClusterCount, 2);
  assert.equal(report.wallets?.summary.recentNetBuyUsd, '160.5');
  assert.equal(report.wallets?.summary.cumulativeBuyUsd, '20000');
  assert.equal(report.wallets?.summary.smartIndependenceProven, false);
  assert.ok(report.wallets?.wallets.every(w => w.enrichment.activity?.recent.coverage === 'vendor_exhausted_feed'));
  assert.equal(socialCalls, 1); assert.equal(narrativeCalls, 1);
  assert.equal(calls.length, 9); // info, security, pool, two holder queries, two stats, two activity queries.
  for (const marker of Object.values(markers)) assert.ok(JSON.stringify(report).includes(marker));
  assert.equal(cache.finish(reservation.entry.id, report, reservation.entry.claimId!), true);

  const entry = controller(orders);
  const [opened, duplicate] = await Promise.all([entry.consider(report), entry.consider(report)]);
  assert.equal(opened.status, 'created'); assert.equal(opened.order?.status, 'paper_open');
  assert.equal(duplicate.status, 'existing'); assert.equal(duplicate.order?.id, opened.order?.id);
  assert.equal(opened.order?.details.execution, 'quote_only_no_fill');
  assert.equal(opened.order?.transactionHash, undefined); assert.equal(opened.order?.outputAmount, undefined);
  assert.equal(calls.filter(call => call.url.pathname === '/v1/trade/quote').length, 1);
  assert.equal(signedCalls, 0); assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(orders.list().length, 1);

  const firstOrderId = opened.order!.id, firstReportId = report.id;
  report = undefined;
  cache.close(); cache = new Store(':memory:');
  orders.close(); orders = new OrderStore(path);
  assert.equal(cache.get(firstReportId), undefined); assert.deepEqual(cache.list(), []);
  assert.equal(orders.get(firstOrderId)?.status, 'paper_open');
  // A fresh research report after restart has a new report ID, but the same source event
  // must resolve to the durable order before requesting another quote.
  const replayReservation = cache.reserve(incoming);
  const replayReport = await evaluate(incoming, config, providers, {id: replayReservation.entry.id, now: () => new Date()});
  assert.notEqual(replayReport.id, firstReportId); assert.equal(replayReport.decision, 'BUY_CANDIDATE');
  const replay = await controller(orders).consider(replayReport);
  assert.equal(replay.status, 'existing'); assert.equal(replay.order?.id, firstOrderId);
  assert.equal(calls.filter(call => call.url.pathname === '/v1/trade/quote').length, 1);
  assert.equal(signedCalls, 0);

  const disk = new DatabaseSync(path, {readOnly: true});
  try {
    assert.deepEqual(disk.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name),
      ['opening_orders', 'opening_identity_claims']);
    const persistedRows = disk.prepare('SELECT * FROM opening_orders').all();
    assert.equal(persistedRows.length, 1);
    const persisted = JSON.stringify(persistedRows);
    for (const marker of [...Object.values(markers), apiKey, 'rawResponses', 'vendorIdentity', 'twitter_description', 'pnl_stat'])
      assert.equal(persisted.includes(marker), false, `Unexpected durable raw data: ${marker}`);
    const minimal = orders.get(firstOrderId)!;
    assert.equal(minimal.details.reportId, firstReportId);
    assert.deepEqual(minimal.details.evidenceLinks, ['https://x.com/i/web/status/1']);
    assert.equal((minimal.details.walletSummary as Record<string, unknown>).qualifiedSmartFundingClusterCount, 2);
    for (const wallet of minimal.details.wallets as Record<string, unknown>[]) {
      assert.deepEqual(Object.keys(wallet).sort(), ['address', 'clusterId', 'identityVerified', 'labels', 'vendorClaims']);
      assert.equal(wallet.identityVerified, false); assert.equal(wallet.vendorClaims, true);
    }
  } finally {disk.close();}
});
