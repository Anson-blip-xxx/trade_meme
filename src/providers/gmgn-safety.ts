import bs58 from 'bs58';
import type {Check, Signal} from '../types.js';
import {GmgnClient, GmgnError} from './gmgn-client.js';

export interface GmgnTokenDiagnostic {
  section: 'info' | 'security' | 'pool';
  status: 'ok' | 'unavailable';
  reason?: string;
  cooldownUntil?: string;
}
export interface GmgnTokenSnapshot {
  token: Signal['token'];
  fetchedAt: string;
  info?: unknown;
  security?: unknown;
  pool?: unknown;
  diagnostics: GmgnTokenDiagnostic[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function validToken(token: Signal['token']): boolean {
  try {
    return token.chain === 'solana' ? bs58.decode(token.address).length === 32 :
      ['bsc', 'robinhood'].includes(token.chain) && /^0x[0-9a-fA-F]{40}$/.test(token.address);
  } catch { return false; }
}
const sameAddress = (a: string, b: string, chain: Signal['token']['chain']) =>
  chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase();

/** Raw vendor evidence remains separate from the normalized safety decision. */
export async function collectGmgnToken(signal: Signal, client: GmgnClient): Promise<GmgnTokenSnapshot> {
  const token = {...signal.token};
  const snapshot: GmgnTokenSnapshot = {token, fetchedAt: new Date().toISOString(), diagnostics: []};
  const routes = {info: '/v1/token/info', security: '/v1/token/security', pool: '/v1/token/pool_info'} as const;
  if (!validToken(token)) {
    for (const section of Object.keys(routes) as (keyof typeof routes)[]) {
      snapshot.diagnostics.push({section, status: 'unavailable', reason: 'GMGN_TOKEN_INVALID'});
    }
    return snapshot;
  }
  for (const section of Object.keys(routes) as (keyof typeof routes)[]) {
    try {
      const raw = await client.get(routes[section], {chain: token.chain === 'solana' ? 'sol' : token.chain, address: token.address});
      snapshot[section] = raw;
      const address = object(raw) ? raw[section === 'pool' ? 'base_address' : 'address'] : undefined;
      if (!object(raw) || !Object.keys(raw).length) {
        snapshot.diagnostics.push({section, status: 'unavailable', reason: 'GMGN_RESPONSE_INVALID'});
      } else if (address !== undefined && (typeof address !== 'string' || !sameAddress(address, token.address, token.chain))) {
        snapshot.diagnostics.push({section, status: 'unavailable', reason: 'GMGN_TOKEN_MISMATCH'});
      } else { snapshot.diagnostics.push({section, status: 'ok'}); }
    } catch (error) {
      snapshot.diagnostics.push({section, status: 'unavailable',
        reason: error instanceof GmgnError ? error.reason : 'GMGN_REQUEST_FAILED',
        ...(error instanceof GmgnError && error.cooldownUntil ? {cooldownUntil: error.cooldownUntil} : {})});
    }
  }
  snapshot.fetchedAt = new Date().toISOString();
  return snapshot;
}

/** GMGN uses yes/no in docs and booleans/0/1 in real token-security responses. */
function boolean(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  return undefined;
}
function ratio(value: unknown): number | undefined {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}
function aliasedBoolean(row: Record<string, unknown>, keys: string[]): boolean | undefined {
  const values = keys.filter(key => Object.hasOwn(row, key)).map(key => boolean(row[key]));
  if (!values.length || values.some(value => value === undefined) || values.some(value => value !== values[0])) return undefined;
  return values[0];
}

/**
 * A pass covers only the explicitly returned GMGN flags, never the complete
 * permission/extension audit required by checkSafety. It must not replace an
 * unknown GoPlus or Solana RPC result. Soft wallet/holder scores are evidence,
 * not automatic vetoes.
 */
export function assessGmgnSafety(snapshot: GmgnTokenSnapshot, maxTaxRate: number): Check {
  const failures: string[] = [], missing: string[] = [];
  const normalized: Record<string, unknown> = {};
  const scope = 'gmgn_provider_flags_only';
  const unchecked = snapshot.token.chain === 'solana'
    ? ['raw_mint_account', 'token2022_extensions', 'transfer_hook', 'permanent_delegate', 'mutable_transfer_fee']
    : ['proxy_implementation', 'mutable_permissions', 'balance_rewrite', 'ownership_recovery', 'transfer_pause', 'sell_simulation'];
  const facts: Record<string, unknown> = {provider: 'gmgn', scope, coverage: 'partial',
    canReplacePrimary: false, unchecked, missingFields: missing, normalized,
    report: snapshot.security, diagnostics: snapshot.diagnostics};
  const result = (status: Check['status'], reasons: string[]): Check =>
    ({status, reasons, facts, checkedAt: snapshot.fetchedAt});
  if (!Number.isFinite(maxTaxRate) || maxTaxRate < 0 || maxTaxRate > 1) return result('unknown', ['GMGN_TAX_POLICY_INVALID']);
  const row = snapshot.security;
  if (!object(row) || !Object.keys(row).length) return result('unknown', ['GMGN_SECURITY_MISSING']);
  if (!validToken(snapshot.token) || typeof row.address !== 'string' || !sameAddress(row.address, snapshot.token.address, snapshot.token.chain))
    return result('unknown', ['GMGN_SECURITY_TOKEN_UNVERIFIED']);
  if (snapshot.diagnostics.some(d => d.section === 'security' && d.status === 'unavailable'))
    return result('unknown', ['GMGN_SECURITY_UNAVAILABLE']);

  function checkFlag(label: string, keys: string[], safeValue: boolean, block: boolean, failureReason?: string): void {
    const value = aliasedBoolean(row as Record<string, unknown>, keys);
    normalized[label] = value ?? null;
    // A contradictory alias must not hide an explicitly adverse detection.
    if (block && keys.some(key => boolean((row as Record<string, unknown>)[key]) === !safeValue)) {
      failures.push(failureReason ?? `GMGN_${label.toUpperCase()}`);
      return;
    }
    if (value === undefined) missing.push(label);
    else if (value !== safeValue) {
      if (block) failures.push(`GMGN_${label.toUpperCase()}`);
      else missing.push(`${label}_review`);
    }
  }
  if (snapshot.token.chain === 'solana') {
    checkFlag('mint_authority_renounced', ['renounced_mint'], true, true, 'GMGN_MINT_AUTHORITY_ACTIVE');
    checkFlag('freeze_authority_renounced', ['renounced_freeze_account'], true, true, 'GMGN_FREEZE_AUTHORITY_ACTIVE');
  } else {
    checkFlag('honeypot', ['is_honeypot', 'honeypot'], false, true);
    checkFlag('verified_source', ['is_open_source', 'open_source'], true, false);
    checkFlag('ownership_renounced', ['owner_renounced', 'is_renounced', 'renounced'], true, false);
    // Current samples return can_sell=0 together with can_not_sell=0. Their
    // semantics are not documented sufficiently to use either as a veto.
  }
  for (const key of ['buy_tax', 'sell_tax']) {
    const value = ratio(row[key]);
    normalized[key] = value ?? null;
    if (value === undefined) missing.push(key);
    else if (value > maxTaxRate) failures.push(`GMGN_EXCESSIVE_${key.toUpperCase()}`);
  }
  const observations: Record<string, unknown> = {};
  for (const key of ['rug_ratio', 'top_10_holder_rate', 'dev_team_hold_rate', 'creator_balance_rate',
    'suspected_insider_hold_rate', 'rat_trader_amount_rate', 'bundler_trader_amount_rate',
    'sniper_count', 'is_wash_trading', 'is_show_alert', 'flags', 'privileges', 'can_sell', 'can_not_sell', 'lock_summary']) {
    if (Object.hasOwn(row, key)) observations[key] = row[key];
  }
  facts.observations = observations;
  if (snapshot.token.chain === 'robinhood') missing.push('robinhood_security_detection_coverage');
  return result(failures.length ? 'fail' : missing.length ? 'unknown' : 'pass',
    failures.length ? failures : missing.length ? ['GMGN_SECURITY_FIELDS_UNVERIFIED'] : ['GMGN_REPORTED_FLAGS_CLEAR_PARTIAL_COVERAGE']);
}
