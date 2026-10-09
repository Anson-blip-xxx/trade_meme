import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import {assessGmgnSafety, collectGmgnToken, type GmgnTokenSnapshot} from '../src/providers/gmgn-safety.js';
import {signal, token} from './helpers.js';

// The bool/number aliases and simultaneous zero can_sell/can_not_sell reproduce
// the official read-only Umi security schema observed on 2026-10-08.
const safe = () => ({address: token, is_open_source: true, open_source: 1,
  is_honeypot: false, honeypot: 0, is_renounced: true, renounced: 1,
  renounced_freeze_account: false, renounced_mint: false, can_sell: 0, can_not_sell: 0,
  buy_tax: '0', sell_tax: '0.01', privileges: null, flags: []});
const snapshot = (security: unknown = safe(), chain: 'bsc' | 'solana' | 'robinhood' = 'bsc'): GmgnTokenSnapshot =>
  ({token: {chain, address: token}, fetchedAt: '2026-10-08T12:00:00.000Z', security,
    diagnostics: [{section: 'security', status: 'ok'}]});

test('real GMGN booleans/numeric aliases yield only explicitly limited coverage', () => {
  const result = assessGmgnSafety(snapshot(), 0.1);
  assert.equal(result.status, 'pass');
  assert.equal(result.facts.scope, 'gmgn_provider_flags_only');
  assert.equal(result.facts.coverage, 'partial');
  assert.equal(result.facts.canReplacePrimary, false);
  assert.ok((result.facts.unchecked as string[]).includes('proxy_implementation'));
  assert.deepEqual(result.reasons, ['GMGN_REPORTED_FLAGS_CLEAR_PARTIAL_COVERAGE']);
});

test('documented yes/no and string true/false are normalized without truthiness coercion', () => {
  const row = {address: token, is_honeypot: 'false', open_source: 'yes', owner_renounced: 'true', buy_tax: 0, sell_tax: '0.03'};
  assert.equal(assessGmgnSafety(snapshot(row), 0.1).status, 'pass');
  assert.equal(assessGmgnSafety(snapshot({...row, is_honeypot: 'no'}), 0.1).status, 'pass');
  assert.equal(assessGmgnSafety(snapshot({...row, is_honeypot: 'yes'}), 0.1).status, 'fail');
});

test('missing, unknown, null, blank, out-of-range taxes and contradictory safe aliases do not pass', () => {
  for (const change of [{buy_tax: ''}, {sell_tax: null}, {is_honeypot: undefined}, {sell_tax: '10%'},
    {buy_tax: true}, {sell_tax: 1.5}, {open_source: 'unknown'}, {renounced: 0}]) {
    assert.equal(assessGmgnSafety(snapshot({...safe(), ...change}), 0.1).status, 'unknown', JSON.stringify(change));
  }
  assert.equal(assessGmgnSafety(snapshot({}), 0.1).status, 'unknown');
  assert.equal(assessGmgnSafety(snapshot(safe()), Number.NaN).status, 'unknown');
  assert.equal(assessGmgnSafety(snapshot({address: token, is_honeypot: false}), 0.1).status, 'unknown');
});

test('hard risk signals veto even if other fields are missing or an alias contradicts them', () => {
  for (const row of [{address: token, is_honeypot: true}, {...safe(), is_honeypot: 'yes'}, {...safe(), sell_tax: '0.2'}])
    assert.equal(assessGmgnSafety(snapshot(row), 0.1).status, 'fail');
});

test('bundlers, concentration, wash trading and provider alert scores stay observations', () => {
  const row = {...safe(), rug_ratio: 1, bundler_trader_amount_rate: 0.99, top_10_holder_rate: 0.99,
    suspected_insider_hold_rate: 0.9, is_wash_trading: true, is_show_alert: true};
  const result = assessGmgnSafety(snapshot(row), 0.1);
  assert.equal(result.status, 'pass');
  assert.equal((result.facts.observations as any).is_wash_trading, true);
});

test('an absent/mismatched token binding and unknown Robinhood detection coverage cannot pass', () => {
  assert.equal(assessGmgnSafety(snapshot({...safe(), address: undefined}), 0.1).status, 'unknown');
  assert.equal(assessGmgnSafety(snapshot({...safe(), address: `0x${'2'.repeat(40)}`}), 0.1).status, 'unknown');
  assert.equal(assessGmgnSafety(snapshot(safe(), 'robinhood'), 0.1).status, 'unknown');
  assert.equal(assessGmgnSafety(snapshot({...safe(), is_honeypot: true}, 'robinhood'), 0.1).status, 'fail');
});

test('Solana authority checks use renounced booleans, never EVM placeholder fields', () => {
  const address = 'So11111111111111111111111111111111111111112';
  const base = snapshot({address, renounced_mint: 'true', renounced_freeze_account: 'yes', buy_tax: 0, sell_tax: 0}, 'solana');
  base.token.address = address;
  assert.equal(assessGmgnSafety(base, 0.1).status, 'pass');
  for (const field of ['renounced_mint', 'renounced_freeze_account']) {
    const result = assessGmgnSafety({...base, security: {...base.security as object, [field]: false}}, 0.1);
    assert.equal(result.status, 'fail');
  }
  const noAuthority = {...base, security: {address, buy_tax: 0, sell_tax: 0}};
  assert.equal(assessGmgnSafety(noAuthority, 0.1).status, 'unknown');
});

test('collector preserves successful raw sections when one endpoint fails', async () => {
  const calls: string[] = [];
  const client = new GmgnClient({apiKey: randomUUID(), minIntervalMs: 0, fetcher: async input => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.pathname.endsWith('/security')) return new Response('no', {status: 503});
    const data = url.pathname.endsWith('/info') ? {address: token, symbol: 'fixture'} : {base_address: token, liquidity: '1234'};
    return Response.json({code: 0, data});
  }});
  const result = await collectGmgnToken(signal(), client);
  assert.deepEqual(calls, ['/v1/token/info', '/v1/token/security', '/v1/token/pool_info']);
  assert.deepEqual(result.info, {address: token, symbol: 'fixture'});
  assert.deepEqual(result.pool, {base_address: token, liquidity: '1234'});
  assert.equal(result.security, undefined);
  assert.deepEqual(result.diagnostics.map(d => d.status), ['ok', 'unavailable', 'ok']);
  assert.equal(assessGmgnSafety(result, 0.1).status, 'unknown');
});

test('collector retains malformed/mismatched raw data for diagnostics but will not certify it', async () => {
  const client = new GmgnClient({apiKey: randomUUID(), minIntervalMs: 0, fetcher: async () =>
    Response.json({code: 0, data: {...safe(), address: `0x${'f'.repeat(40)}`}})});
  const result = await collectGmgnToken(signal(), client);
  assert.equal(result.diagnostics.find(d => d.section === 'security')?.reason, 'GMGN_TOKEN_MISMATCH');
  assert.ok(result.security);
  assert.equal(assessGmgnSafety(result, 0.1).status, 'unknown');
});

test('collector maps solana to sol and rejects invalid token identifiers without requests', async () => {
  const chains: string[] = [];
  const client = new GmgnClient({apiKey: randomUUID(), minIntervalMs: 0, fetcher: async input => {
    chains.push(new URL(String(input)).searchParams.get('chain')!);
    return Response.json({code: 0, data: {symbol: 'sample'}});
  }});
  await collectGmgnToken(signal({token: {chain: 'solana', address: 'So11111111111111111111111111111111111111112'}}), client);
  assert.deepEqual(chains, ['sol', 'sol', 'sol']);
  const invalid = await collectGmgnToken(signal({token: {chain: 'bsc', address: 'https://evil.test'}}), client);
  assert.equal(chains.length, 3);
  assert.ok(invalid.diagnostics.every(d => d.reason === 'GMGN_TOKEN_INVALID'));
});
