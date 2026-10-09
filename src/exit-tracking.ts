import bs58 from 'bs58';
import type {Chain} from './types.js';

export interface ExitPolicyCondition {
  order_type: 'profit_stop' | 'loss_stop';
  side: 'sell';
  price_scale: string;
  sell_ratio: string;
}

export interface ExpectedExitStrategy {
  strategyOrderId: string;
  chain: Chain;
  wallet: string;
  tokenAddress: string;
  inputToken: string;
  policyConditions: readonly ExitPolicyCondition[];
  sellRatioType: 'hold_amount' | 'buy_amount';
  openingTransactionHash?: string;
}

export interface ExitConditionObservation {
  cid: string;
  orderType: ExitPolicyCondition['order_type'];
  priceScale: string;
  sellRatio: string;
  status: 'cancel' | 'success' | 'failed' | 'unknown';
}

export interface ExitStrategyAssessment {
  status: 'verified' | 'degraded' | 'unknown' | 'terminal';
  reasons: string[];
  found: boolean;
  policyMatched: boolean;
  hasLiveStop: boolean;
  terminal: boolean;
  conditions: ExitConditionObservation[];
  checkedAt: string;
  parentStatus?: 'open' | 'closed';
  strategyStatus?: 'running' | 'stopped';
  closeTransactionHash?: string;
  reportedSuccessfulSellCount?: number;
}

export type ExitAssessment = ExitStrategyAssessment;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);

function validAddress(value: unknown, chain: Chain): value is string {
  if (typeof value !== 'string') return false;
  if (chain !== 'solana') return /^0x[0-9a-fA-F]{40}$/.test(value);
  try {return bs58.decode(value).length === 32;} catch {return false;}
}

function sameAddress(value: unknown, expected: string, chain: Chain): boolean {
  return validAddress(value, chain) && validAddress(expected, chain) &&
    (chain === 'solana' ? value === expected : value.toLowerCase() === expected.toLowerCase());
}

function validHash(value: unknown, chain: Chain): value is string {
  if (typeof value !== 'string') return false;
  if (chain !== 'solana') return /^0x[0-9a-fA-F]{64}$/.test(value);
  try {return bs58.decode(value).length === 64;} catch {return false;}
}

function sameHash(value: unknown, expected: string, chain: Chain): boolean {
  return validHash(value, chain) && validHash(expected, chain) &&
    (chain === 'solana' ? value === expected : value.toLowerCase() === expected.toLowerCase());
}

/** Compare documented decimal strings without rounding or inventing alternative units. */
function decimal(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 80 || !/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return;
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function conditionKey(value: unknown): string | undefined {
  if (!object(value) || !['profit_stop', 'loss_stop'].includes(String(value.order_type)) || value.side !== 'sell') return;
  const price = decimal(value.price_scale), ratio = decimal(value.sell_ratio);
  if (price === undefined || ratio === undefined || price === '0' || ratio === '0' || Number(ratio) > 100) return;
  if (value.order_type === 'loss_stop' && Number(price) > 100) return;
  return JSON.stringify([value.order_type, value.side, price, ratio]);
}

/**
 * Parse only the unwrapped data from GET /v1/trade/strategy/orders.
 * Schema evidence: GMGNAI/gmgn-skills commit
 * 4575ef539e6a3115fa0481d41285cb79e77970bf, skills/gmgn-swap/SKILL.md,
 * "order strategy list Response Fields". No network, persistence, or order writes.
 *
 * The documented child statuses are cancel/success/failed. There is no documented
 * active-child enum, so a running parent alone NEVER proves hasLiveStop. Unknown
 * statuses remain unknown; numeric states and an empty status are not guessed.
 * terminal means only that this matched strategy and every child have stopped.
 * A caller must independently verify zero wallet balance before closing a position.
 */
export function assessExitStrategy(
  payload: unknown, expected: ExpectedExitStrategy, now = new Date(),
): ExitStrategyAssessment {
  const result: ExitStrategyAssessment = {status: 'unknown', reasons: [], found: false,
    policyMatched: false, hasLiveStop: false, terminal: false, conditions: [], checkedAt: now.toISOString()};
  const fail = (reason: string, status: ExitStrategyAssessment['status'] = 'unknown') => {
    result.status = status; result.reasons.push(reason); return result;
  };
  if (!identifier(expected.strategyOrderId) || !['bsc', 'solana', 'robinhood'].includes(expected.chain) ||
      !validAddress(expected.wallet, expected.chain) || !validAddress(expected.tokenAddress, expected.chain) ||
      !validAddress(expected.inputToken, expected.chain) || !['hold_amount', 'buy_amount'].includes(expected.sellRatioType) ||
      !Array.isArray(expected.policyConditions) || expected.policyConditions.length !== 3 ||
      expected.policyConditions.filter(c => c.order_type === 'loss_stop').length !== 1 ||
      expected.policyConditions.filter(c => c.order_type === 'profit_stop').length !== 2 ||
      expected.openingTransactionHash !== undefined && !validHash(expected.openingTransactionHash, expected.chain))
    return fail('EXIT_EXPECTATION_INVALID');
  const expectedKeys = expected.policyConditions.map(conditionKey);
  if (expectedKeys.some(key => key === undefined) || new Set(expectedKeys).size !== expectedKeys.length)
    return fail('EXIT_EXPECTATION_INVALID');
  if (!object(payload) || !Array.isArray(payload.list) || payload.list.length > 1_000 ||
      payload.next_page_token !== undefined && (typeof payload.next_page_token !== 'string' || payload.next_page_token.length > 4_096))
    return fail('EXIT_STRATEGY_RESPONSE_INVALID');
  const matches = payload.list.filter(row => object(row) && row.order_id === expected.strategyOrderId);
  // Absence on one page (including an empty page) never establishes missing or closed.
  if (matches.length === 0) return fail('EXIT_STRATEGY_NOT_OBSERVED');
  if (matches.length !== 1) return fail('EXIT_STRATEGY_ID_AMBIGUOUS');
  const row = matches[0] as Record<string, unknown>;
  if (row.chain !== (expected.chain === 'solana' ? 'sol' : expected.chain) ||
      !sameAddress(row.wallet_address, expected.wallet, expected.chain) ||
      !sameAddress(row.base_token, expected.tokenAddress, expected.chain) ||
      !sameAddress(row.quote_token, expected.inputToken, expected.chain))
    return fail('EXIT_STRATEGY_IDENTITY_MISMATCH');
  if (expected.openingTransactionHash !== undefined &&
      !sameHash(row.open_sign_hash, expected.openingTransactionHash, expected.chain))
    return fail('EXIT_OPENING_HASH_UNVERIFIED');
  result.found = true;
  if (row.status === 'open' || row.status === 'closed') result.parentStatus = row.status;
  if (row.strategy_status === 'running' || row.strategy_status === 'stopped') result.strategyStatus = row.strategy_status;
  if (row.order_type !== 'smart_trade' || row.sub_order_type !== 'mix_trade' || row.sell_ratio_type !== expected.sellRatioType)
    return fail('EXIT_STRATEGY_POLICY_MISMATCH', 'degraded');
  if (!Array.isArray(row.condition_orders) || row.condition_orders.length !== expected.policyConditions.length)
    return fail('EXIT_CONDITIONS_INCOMPLETE', 'degraded');
  const keys = row.condition_orders.map(conditionKey);
  if (keys.some(key => key === undefined) || new Set(keys).size !== keys.length ||
      !expectedKeys.every(key => keys.includes(key))) return fail('EXIT_CONDITION_POLICY_MISMATCH', 'degraded');
  const conditions = row.condition_orders as Record<string, unknown>[];
  if (conditions.some(condition => !identifier(condition.cid)) ||
      new Set(conditions.map(condition => condition.cid)).size !== conditions.length)
    return fail('EXIT_CONDITION_IDS_INVALID');
  result.policyMatched = true;
  result.conditions = conditions.map(condition => ({
    cid: condition.cid as string, orderType: condition.order_type as ExitPolicyCondition['order_type'],
    priceScale: decimal(condition.price_scale)!, sellRatio: decimal(condition.sell_ratio)!,
    status: condition.status === 'success' || condition.status === 'cancel' || condition.status === 'failed'
      ? condition.status : 'unknown',
  }));
  if (validHash(row.close_sign_hash, expected.chain)) result.closeTransactionHash = row.close_sign_hash;
  if (object(row.order_statistic) && typeof row.order_statistic.success_sell_num === 'number' &&
      Number.isSafeInteger(row.order_statistic.success_sell_num) && row.order_statistic.success_sell_num >= 0)
    result.reportedSuccessfulSellCount = row.order_statistic.success_sell_num;
  // Do not subtract sell_amount/success_sell_amount from the opening fill: the
  // upstream document does not specify their units. Counts are only vendor claims.
  if (!result.parentStatus || !result.strategyStatus) return fail('EXIT_PARENT_STATUS_UNKNOWN');
  if (result.conditions.some(condition => condition.status === 'unknown'))
    return fail('EXIT_CONDITION_STATUS_UNKNOWN');
  if (result.parentStatus === 'closed' && result.strategyStatus === 'stopped') {
    result.status = 'terminal'; result.terminal = true;
    result.reasons.push('EXIT_STRATEGY_TERMINAL_BALANCE_CHECK_REQUIRED');
    return result;
  }
  return fail('EXIT_PARENT_NOT_TERMINAL', 'degraded');
}
