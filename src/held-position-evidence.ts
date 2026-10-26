import bs58 from 'bs58';
import type {HeldPositionSeed} from './held-position-source.js';
import {CURRENT_STOP_LOSS_DROP_PCT,LEGACY_STOP_LOSS_DROP_PCT} from './exit-policy.js';

const SOL = 'So11111111111111111111111111111111111111112';
const U64 = (1n << 64n) - 1n;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const atom = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= U64;
function base58(value: unknown, size: number): boolean {
  if (typeof value !== 'string' || value.length > 100) return false;
  try {const bytes = bs58.decode(value); return bytes.length === size && bs58.encode(bytes) === value;} catch {return false;}
}
function validSeed(seed: HeldPositionSeed): boolean {
  return !!seed && seed.chain === 'solana' && base58(seed.wallet, 32) && base58(seed.tokenAddress, 32) &&
    seed.tokenAddress !== SOL && base58(seed.transactionHash, 64) && atom(seed.inputAmount) && atom(seed.outputAmount) &&
    Number.isInteger(seed.tokenDecimals) && seed.tokenDecimals >= 0 && seed.tokenDecimals <= 255 &&
    Number.isSafeInteger(seed.buySlot) && seed.buySlot > 0 && Number.isFinite(Date.parse(seed.confirmedAt));
}
/** Exact decimal rational; never coerce atomic strings through IEEE-754. */
function decimal(value: unknown): {numerator: bigint; denominator: bigint; number: number} | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'number' && !Number.isFinite(value)) return;
  const text = String(value);
  if (text.length > 100) return;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (!match) return;
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) return;
  const coefficient = BigInt(match[1] + (match[2] ?? ''));
  const power = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (Math.abs(power) > 400) return;
  return {numerator: power >= 0 ? coefficient * 10n ** BigInt(power) : coefficient,
    denominator: power < 0 ? 10n ** BigInt(-power) : 1n, number};
}
function ratioMatches(value: unknown, numerator: bigint, denominator: bigint): boolean {
  const observed = decimal(value); if (!observed || numerator <= 0n || denominator <= 0n) return false;
  const difference = observed.numerator * denominator - numerator * observed.denominator;
  // GMGN's quote-token price is rounded. Allow at most one part per million, tested with integer arithmetic.
  return (difference < 0n ? -difference : difference) * 1_000_000n <= numerator * observed.denominator;
}

/** Only a matching query_order fill report supplies an execution-price basis; spot prices are never inspected. */
export function validatedHeldFill(seed: HeldPositionSeed, payload: unknown): {priceUsd: number; priceSol: number; verifiedAt?: string} | undefined {
  if (!validSeed(seed) || !identifier(seed.providerOrderId) || !object(payload) || payload.order_id !== seed.providerOrderId ||
      payload.hash !== seed.transactionHash || !object(payload.report)) return;
  const confirmed = payload.status === 'confirmed' && (payload.state === undefined || payload.state === 30) ||
    payload.status === 'successful' && payload.state === 30;
  if (!confirmed) return;
  const report = payload.report;
  if (report.input_token !== SOL || report.output_token !== seed.tokenAddress || report.input_amount !== seed.inputAmount ||
      report.output_amount !== seed.outputAmount || report.input_token_decimals !== 9 || report.output_token_decimals !== seed.tokenDecimals ||
      report.swap_mode !== 'ExactIn') return;
  // Optional aliases may corroborate the fill, but may never contradict its immutable identity or quantity.
  for (const [key, expected] of Object.entries({quote_token: SOL, quote_decimals: 9, quote_amount: seed.inputAmount,
    base_token: seed.tokenAddress, base_decimals: seed.tokenDecimals, base_amount: seed.outputAmount, height: seed.buySlot}))
    if (Object.hasOwn(report, key) && report[key] !== expected) return;
  const numerator = BigInt(seed.inputAmount) * 10n ** BigInt(seed.tokenDecimals);
  const denominator = BigInt(seed.outputAmount) * 1_000_000_000n;
  if (!ratioMatches(report.price, numerator, denominator)) return;
  const usd = decimal(report.price_usd);
  const priceSol = Number(numerator) / Number(denominator);
  if (!usd || !Number.isFinite(priceSol) || priceSol <= 0) return;
  return {priceUsd: usd.number, priceSol};
}

export interface HeldProtectionCondition {
  cid?: string; orderType?: string; side?: string; priceScale?: string; sellRatio?: string;
  status: string; checkPriceUsd?: number;
}
export interface HeldProtectionObservation {
  status: 'observed' | 'conditions_changed' | 'not_observed' | 'ambiguous' | 'invalid' | 'incomplete';
  parentId?: string; parentStatus?: string; strategyStatus?: string;
  conditions: HeldProtectionCondition[];
  linkage: 'transaction_hash' | 'amount_time_match' | 'none';
  policyMatched: boolean; candidateCount: number; automaticTriggerVerified: false;
  checkedAt: string; reasons: string[];
}
const safeLabel = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(value) ? value : undefined;
function creationTime(value: unknown): number | undefined {
  const ms = typeof value === 'number' ? value : typeof value === 'string' && /^\d{13,16}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(ms) && ms >= 1_000_000_000_000 && ms <= 8.64e15 ? ms : undefined;
}
function amountsMatch(seed: HeldPositionSeed, row: Record<string, unknown>): boolean {
  return row.quote_investment === seed.inputAmount && row.open_amount === seed.outputAmount &&
    row.base_decimal === seed.tokenDecimals && row.quote_decimal === 9 &&
    (!object(row.order_statistic) || row.order_statistic.buy_amount === undefined || row.order_statistic.buy_amount === seed.outputAmount);
}

/** Supplier-observed strategy state. Neither matching a parent nor seeing "check" proves future execution. */
export function heldProtection(seed: HeldPositionSeed, payload: unknown, now = new Date()): HeldProtectionObservation {
  const current = now.getTime();
  const result: HeldProtectionObservation = {status: 'invalid', conditions: [], linkage: 'none', policyMatched: false,
    candidateCount: 0, automaticTriggerVerified: false, checkedAt: Number.isFinite(current) ? now.toISOString() : '', reasons: []};
  const invalid = (reason: string) => {result.reasons.push(reason); return result;};
  if (!validSeed(seed) || !Number.isFinite(current) || Date.parse(seed.confirmedAt) > current + 5000)
    return invalid('HELD_PROTECTION_SEED_INVALID');
  if (!object(payload) || !Array.isArray(payload.list) || payload.list.length > 1000 || payload.list.some(row => !object(row)) ||
      payload.next_page_token !== undefined && typeof payload.next_page_token !== 'string' ||
      typeof payload.next_page_token === 'string' && payload.next_page_token.length > 4096 ||
      payload.total !== undefined && (!Number.isSafeInteger(payload.total) || Number(payload.total) < 0))
    return invalid('HELD_PROTECTION_RESPONSE_INVALID');
  const candidates: {row: Record<string, unknown>; linkage: HeldProtectionObservation['linkage']}[] = [];
  for (const item of payload.list) {
    const row = item as Record<string, unknown>;
    if (row.chain !== 'sol' || row.wallet_address !== seed.wallet || row.base_token !== seed.tokenAddress || row.quote_token !== SOL ||
        !identifier(row.order_id)) continue;
    if (row.open_sign_hash === seed.transactionHash) {
      candidates.push({row, linkage: 'transaction_hash'}); continue;
    }
    if (row.open_sign_hash !== '' && row.open_sign_hash !== null && row.open_sign_hash !== undefined) continue;
    const created = creationTime(row.create_time);
    if (created === undefined || created > current + 5000 || Math.abs(created - Date.parse(seed.confirmedAt)) > 120_000 ||
        !amountsMatch(seed, row)) continue;
    candidates.push({row, linkage: 'amount_time_match'});
  }
  result.candidateCount = candidates.length;
  if (candidates.length > 1) {result.status = 'ambiguous'; return invalid('HELD_PROTECTION_MULTIPLE_CANDIDATES');}
  const incomplete = !!payload.next_page_token || typeof payload.total === 'number' && payload.total > payload.list.length;
  if (incomplete) {result.status = 'incomplete'; return invalid('HELD_PROTECTION_PAGE_INCOMPLETE');}
  if (!candidates.length) {result.status = 'not_observed'; return invalid('HELD_PROTECTION_NOT_OBSERVED');}
  const {row, linkage} = candidates[0];
  result.parentId = row.order_id as string; result.parentStatus = safeLabel(row.status);
  result.strategyStatus = safeLabel(row.strategy_status); result.linkage = linkage;
  result.reasons.push(linkage === 'transaction_hash' ? 'HELD_PROTECTION_HASH_MATCH' : 'HELD_PROTECTION_AMOUNT_TIME_MATCH_ONLY');
  let matches = row.order_type === 'smart_trade' && row.sub_order_type === 'mix_trade' && row.sell_ratio_type === 'hold_amount';
  if (linkage === 'transaction_hash' && ['quote_investment', 'open_amount', 'base_decimal', 'quote_decimal'].some(key => Object.hasOwn(row, key)) &&
      !amountsMatch(seed, row)) {matches = false; result.reasons.push('HELD_PROTECTION_FILL_FIELDS_MISMATCH');}
  if (!Array.isArray(row.condition_orders) || row.condition_orders.length !== 2) {
    result.status = 'conditions_changed'; return invalid('HELD_PROTECTION_CONDITIONS_INCOMPLETE');
  }
  const seen = new Set<string>(), rules = new Set<string>();
  for (const raw of row.condition_orders) {
    if (!object(raw)) {matches = false; continue;}
    const scale = decimal(raw.price_scale), ratio = decimal(raw.sell_ratio), status = safeLabel(raw.status);
    const condition: HeldProtectionCondition = {cid: identifier(raw.cid) ? raw.cid : undefined,
      orderType: safeLabel(raw.order_type), side: safeLabel(raw.side), priceScale: scale ? String(scale.number) : undefined,
      sellRatio: ratio ? String(ratio.number) : undefined, status: status ?? 'unknown'};
    const check = decimal(raw.check_price); if (check) condition.checkPriceUsd = check.number;
    result.conditions.push(condition);
    if (!condition.cid || seen.has(condition.cid) || !scale || !ratio || !status || condition.side !== 'sell') matches = false;
    if (condition.cid) seen.add(condition.cid);
    const key = `${condition.orderType}:${condition.priceScale}:${condition.sellRatio}`;
    const expectedScale=condition.orderType==='profit_stop'?[100n]:condition.orderType==='loss_stop'?
      [BigInt(LEGACY_STOP_LOSS_DROP_PCT),BigInt(CURRENT_STOP_LOSS_DROP_PCT)]:[];
    const expectedRatio=condition.orderType==='profit_stop'?50n:condition.orderType==='loss_stop'?100n:0n;
    if (rules.has(key) || !scale || !ratio || !expectedScale.some(value=>scale.numerator===value*scale.denominator) ||
        ratio.numerator!==expectedRatio*ratio.denominator) matches = false;
    rules.add(key);
    if (seed.entryPriceUsd !== undefined) {
      const entry = decimal(seed.entryPriceUsd);
      const direction=condition.orderType==='profit_stop'?1n:-1n;
      const numerator=entry&&scale?entry.numerator*(100n*scale.denominator+direction*scale.numerator):0n;
      const denominator=entry&&scale?entry.denominator*100n*scale.denominator:1n;
      if (!check || !ratioMatches(raw.check_price, numerator, denominator)) matches = false;
    }
  }
  result.policyMatched = matches && result.conditions.length === 2 && rules.size === 2;
  result.status = result.policyMatched ? 'observed' : 'conditions_changed';
  if (!result.policyMatched) result.reasons.push('HELD_PROTECTION_POLICY_MISMATCH');
  if (!result.parentStatus || !result.strategyStatus) {
    result.status = 'invalid'; result.reasons.push('HELD_PROTECTION_PARENT_STATUS_MISSING');
  }
  result.reasons.push('HELD_PROTECTION_TRIGGER_NOT_VERIFIED');
  return result;
}
