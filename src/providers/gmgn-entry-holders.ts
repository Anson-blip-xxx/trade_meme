import bs58 from 'bs58';
import {ENTRY_HOLDER_RISK_LIMITS, type EntryHolderRiskValue, type EntryHolderRiskValues} from '../entry-holder-risk.js';
import {GmgnError, type GmgnClient} from './gmgn-client.js';

const LIMIT = 100;
const INFO = '/v1/token/info';
const HOLDERS = '/v1/market/token_top_holders';
const TOP10_FIELD = 'info.stat.top_10_holder_rate';
const ENTRAPMENT_FIELD = 'info.stat.top_entrapment_trader_percentage';
type RiskTag = 'bundler' | 'rat_trader';
type Coverage = 'complete' | 'lower_bound' | 'unknown';
type Decimal = {atoms: bigint; scale: number};
interface Holder {
  address: string;
  ratio: Decimal;
  balance: Decimal;
  addrType?: number;
}
interface HolderEvidence {
  rows: number;
  distinctWallets: number;
  positiveWallets: number;
  matchedWallets: number;
  coverage: Coverage;
  completionBasis?: 'less_than_limit' | 'zero_tail' | 'positive_tail';
  lowerBound?: string;
  reasons: string[];
}
interface ParsedHolders {holders?: Holder[]; evidence: HolderEvidence;}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function address(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 44) return false;
  try {const bytes = bs58.decode(value); return bytes.length === 32 && bs58.encode(bytes) === value;}
  catch {return false;}
}

/** Exact decimals prevent a sum just above a limit being rounded down to it. */
function decimal(value: unknown): Decimal | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return;
  const text = String(value);
  if (text.length > 120) return;
  const match = /^(0|[1-9]\d{0,79})(?:\.(\d{1,80}))?(?:[eE]([+-]?\d{1,2}))?$/.exec(text);
  if (!match) return;
  const fraction = match[2] ?? '';
  let atoms = BigInt(match[1] + fraction), scale = fraction.length - Number(match[3] ?? 0);
  if (scale < 0) {atoms *= 10n ** BigInt(-scale); scale = 0;}
  while (scale > 0 && atoms % 10n === 0n) {atoms /= 10n; scale--;}
  // Bound evidence precision to the gate's documented exact-decimal parser.
  if (scale > 30 || atoms.toString().length > 100) return;
  return {atoms, scale};
}
const denominator = (value: Decimal) => 10n ** BigInt(value.scale);
const compare = (a: Decimal, b: Decimal) => a.atoms * denominator(b) - b.atoms * denominator(a);
function sameBalance(a: Decimal, b: Decimal, rawA: unknown, rawB: unknown): boolean {
  if (compare(a, b) === 0n) return true;
  // JSON numbers may round a redundant balance alias. Only this alias check may
  // compare their finite number representations; holding ratios stay exact.
  if (typeof rawA !== 'number' && typeof rawB !== 'number') return false;
  const first = Number(rawA), second = Number(rawB);
  return Number.isFinite(first) && Number.isFinite(second) && first === second;
}
function ratio(value: unknown): Decimal | undefined {
  const result = decimal(value);
  return result && result.atoms <= denominator(result) ? result : undefined;
}
function decimalText(value: Decimal): string {
  if (!value.scale) return value.atoms.toString();
  const padded = value.atoms.toString().padStart(value.scale + 1, '0');
  return `${padded.slice(0, -value.scale)}.${padded.slice(-value.scale)}`.replace(/0+$/, '').replace(/\.$/, '');
}
function sum(values: Decimal[]): Decimal {
  const scale = Math.max(0, ...values.map(value => value.scale));
  return {atoms: values.reduce((total, value) => total + value.atoms * 10n ** BigInt(scale - value.scale), 0n), scale};
}
const suffix = (tag: RiskTag | undefined) => tag === 'bundler' ? 'BUNDLER' : tag === 'rat_trader' ? 'RAT_TRADER' : 'TOP_HOLDERS';
const sourceField = (tag: RiskTag) => `token_top_holders[tag=${tag}].list[].amount_percentage`;
const requestReason = (error: unknown) => error instanceof GmgnError ? error.reason : 'GMGN_REQUEST_FAILED';
const unknownMetric = (field: string): EntryHolderRiskValue => ({value: undefined, sourceField: field});

function parseHolders(raw: unknown, tag?: RiskTag): ParsedHolders {
  const evidence: HolderEvidence = {rows: 0, distinctWallets: 0, positiveWallets: 0,
    matchedWallets: 0, coverage: 'unknown', reasons: []};
  const fail = (reason: string): ParsedHolders => {
    evidence.reasons.push(`ENTRY_HOLDER_RISK_${suffix(tag)}_${reason}`);
    return {evidence};
  };
  if (!object(raw) || !Array.isArray(raw.list) || raw.list.length > LIMIT) return fail('LIST_INVALID');
  evidence.rows = raw.list.length;
  const holders: Holder[] = [], wallets = new Set<string>();
  for (const item of raw.list) {
    if (!object(item) || !address(item.address)) return fail('WALLET_INVALID');
    if (wallets.has(item.address)) return fail('WALLET_DUPLICATE');
    wallets.add(item.address); evidence.distinctWallets = wallets.size;
    // Risk tags must describe this token, not a wallet's unrelated global label.
    if (tag && (!Array.isArray(item.maker_token_tags) || !item.maker_token_tags.includes(tag))) return fail('TAG_UNVERIFIED');
    if (tag) evidence.matchedWallets++;
    const holdingRatio = ratio(item.amount_percentage);
    const hasBalance = Object.hasOwn(item, 'balance'), hasAmount = Object.hasOwn(item, 'amount_cur');
    const balance = hasBalance ? decimal(item.balance) : hasAmount ? decimal(item.amount_cur) : undefined;
    const alias = hasAmount ? decimal(item.amount_cur) : undefined;
    if (!holdingRatio) return fail('RATIO_INVALID');
    if (!balance || hasAmount && (!alias || !sameBalance(balance, alias,
        hasBalance ? item.balance : item.amount_cur, item.amount_cur))) return fail('BALANCE_INVALID');
    if ((balance.atoms === 0n) !== (holdingRatio.atoms === 0n)) return fail('BALANCE_RATIO_INCONSISTENT');
    if (holders.length && compare(holders.at(-1)!.ratio, holdingRatio) < 0n) return fail('ORDER_INVALID');
    if (balance.atoms > 0n) evidence.positiveWallets++;
    holders.push({address: item.address, ratio: holdingRatio, balance,
      ...(Number.isSafeInteger(item.addr_type) && Number(item.addr_type) >= 0 ? {addrType: Number(item.addr_type)} : {})});
  }
  const total = sum(holders.map(holder => holder.ratio));
  if (total.atoms > denominator(total)) return fail('TOTAL_INVALID');
  evidence.lowerBound = decimalText(total);
  if (holders.length < LIMIT) {
    evidence.coverage = 'complete'; evidence.completionBasis = 'less_than_limit';
  } else if (holders.at(-1)!.ratio.atoms === 0n && holders.at(-1)!.balance.atoms === 0n) {
    evidence.coverage = 'complete'; evidence.completionBasis = 'zero_tail';
  } else {
    evidence.coverage = 'lower_bound'; evidence.completionBasis = 'positive_tail';
    evidence.reasons.push(`ENTRY_HOLDER_RISK_${suffix(tag)}_COVERAGE_INCOMPLETE`);
  }
  return {holders, evidence};
}

function tagMetric(parsed: ParsedHolders, tag: RiskTag): EntryHolderRiskValue {
  const result = unknownMetric(sourceField(tag));
  if (!parsed.holders || parsed.evidence.coverage === 'unknown') return result;
  const text = parsed.evidence.lowerBound!, total = ratio(text)!;
  result.coverage = parsed.evidence.coverage;
  result.lowerBound = text;
  const limit = tag === 'bundler' ? ENTRY_HOLDER_RISK_LIMITS.bundler : ENTRY_HOLDER_RISK_LIMITS.ratTrader;
  // A truncated list can prove an excess, but cannot certify a below-limit total.
  if (result.coverage === 'complete' || total.atoms * 100n > BigInt(limit) * denominator(total)) result.value = text;
  return result;
}

/** Read-only, per-opening evidence. The caller owns scheduling; this class never polls. */
export class GmgnEntryHolderReader {
  private readonly now: () => Date;
  constructor(private readonly client: Pick<GmgnClient, 'get'>, options: {now?: () => Date} = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async readHolderRisk(tokenAddress: string): Promise<EntryHolderRiskValues> {
    const checkedAt = this.now().toISOString();
    const evidence: Record<string, unknown> = {requestedLimit: LIMIT, top10Source: TOP10_FIELD,
      entrapment: {status: 'unsupported', documentedHoldingTag: false, sourceField: ENTRAPMENT_FIELD,
        scope: 'vendor_trading_metric_not_holdings'}};
    const result: EntryHolderRiskValues = {provider: 'gmgn', chain: 'solana', address: tokenAddress, checkedAt,
      values: {top10: unknownMetric(TOP10_FIELD), bundler: unknownMetric(sourceField('bundler')),
        ratTrader: unknownMetric(sourceField('rat_trader'))}, evidence};
    const complete = () => {result.completedAt = this.now().toISOString(); return result;};
    if (!address(tokenAddress)) {
      evidence.identity = {status: 'invalid', reasons: ['ENTRY_HOLDER_RISK_TOKEN_INVALID']};
      return complete();
    }
    let info: unknown;
    try {info = await this.client.get(INFO, {chain: 'sol', address: tokenAddress}, 1);}
    catch (error) {
      evidence.identity = {status: 'unavailable', reasons: ['ENTRY_HOLDER_RISK_INFO_REQUEST_FAILED', requestReason(error)]};
      return complete();
    }
    if (!object(info) || info.address !== tokenAddress ||
        info.chain !== undefined && info.chain !== 'sol' && info.chain !== 'solana') {
      evidence.identity = {status: 'invalid', reasons: ['ENTRY_HOLDER_RISK_TOKEN_UNVERIFIED']};
      return complete();
    }
    evidence.identity = {status: 'verified', reasons: []};
    const stat = object(info.stat) ? info.stat : undefined;
    const top10 = ratio(stat?.top_10_holder_rate);
    if (top10) result.values.top10 = {value: decimalText(top10), sourceField: TOP10_FIELD, coverage: 'complete'};
    evidence.top10 = {status: top10 ? 'available' : 'unavailable',
      reasons: top10 ? [] : ['ENTRY_HOLDER_RISK_TOP10_RATIO_INVALID']};
    const entrapmentVolume = ratio(stat?.top_entrapment_trader_percentage);
    if (entrapmentVolume) (evidence.entrapment as Record<string, unknown>).volumeRatio = decimalText(entrapmentVolume);

    // The shared client applies weighted pacing, cooldown and timeouts to all four reads.
    // No undocumented pagination or guessed entrapment tag is requested.
    const query = {chain: 'sol', address: tokenAddress, limit: LIMIT, order_by: 'amount_percentage', direction: 'desc'};
    const collected = await Promise.allSettled([
      this.client.get(HOLDERS, {...query, tag: 'bundler'}, 5),
      this.client.get(HOLDERS, {...query, tag: 'rat_trader'}, 5),
      this.client.get(HOLDERS, query, 5),
    ]);
    for (const [index, tag, key] of [[0, 'bundler', 'bundler'], [1, 'rat_trader', 'ratTrader']] as const) {
      const response = collected[index];
      if (response.status === 'rejected') {
        evidence[key] = {rows: 0, distinctWallets: 0, positiveWallets: 0, matchedWallets: 0, coverage: 'unknown',
          reasons: [`ENTRY_HOLDER_RISK_${suffix(tag)}_REQUEST_FAILED`, requestReason(response.reason)]};
      } else {
        const parsed = parseHolders(response.value, tag);
        evidence[key] = parsed.evidence; result.values[key] = tagMetric(parsed, tag);
      }
    }
    const topResponse = collected[2];
    if (topResponse.status === 'rejected') {
      evidence.topHolders = {status: 'unavailable', rows: 0, scope: 'visible_top10_not_aggregate', list: [],
        reasons: ['ENTRY_HOLDER_RISK_TOP_HOLDERS_REQUEST_FAILED', requestReason(topResponse.reason)]};
    } else {
      const parsed = parseHolders(topResponse.value);
      evidence.topHolders = {status: parsed.holders ? 'available' : 'unavailable', rows: parsed.evidence.rows,
        scope: 'visible_top10_not_aggregate', reasons: parsed.holders ? [] : parsed.evidence.reasons,
        list: (parsed.holders ?? []).slice(0, 10).map(holder => ({address: holder.address,
          amountPercentage: decimalText(holder.ratio), balance: decimalText(holder.balance),
          ...(holder.addrType !== undefined ? {addrType: holder.addrType} : {}),
          kind: holder.addrType === 2 ? 'pool' : holder.addrType === 0 ? 'wallet' : 'unknown'}))};
    }
    return complete();
  }
}
