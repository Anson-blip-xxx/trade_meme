import bs58 from 'bs58';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Signal, Chain} from '../types.js';
import {GmgnError, type GmgnClient} from '../providers/gmgn-client.js';
import type {WalletAnalysis, WalletAnalysisOptions, WalletIdentity, WalletRecord, WalletCluster, WalletActivity} from './wallet-types.js';
import {parseTargetTokenBalance} from './wallet-targets.js';

export type {WalletAnalysis, WalletAnalysisOptions, WalletIdentity, VendorWalletTargets} from './wallet-types.js';
export const RECENT_WALLET_WINDOW_SECONDS = 3_600;
const HOLDERS = '/v1/market/token_top_holders';
const STATS = '/v1/user/wallet_stats';
const ACTIVITY = '/v1/user/wallet_activity';
const TOKEN_BALANCE = '/v1/user/wallet_token_balance';
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 160): string | undefined => typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
const labels = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(x)))].slice(0, 64) : [];
const ratio = (v: unknown): number | null => {
  const n = decimal(v); return n !== null && Number(n) >= 0 && Number(n) <= 1 ? Number(n) : null;
};
const count = (v: unknown): number | null => {const n = decimal(v); return n !== null && Number.isSafeInteger(Number(n)) && Number(n) >= 0 ? Number(n) : null;};

function address(value: unknown, chain: Chain): string | null {
  if (typeof value !== 'string') return null;
  if (chain !== 'solana') return /^0x[\da-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
  try {return value.length <= 44 && bs58.decode(value).length === 32 ? value : null;} catch {return null;}
}
function chainMatches(v: unknown, chain: Chain): boolean {return v === undefined || v === chain || (v === 'sol' && chain === 'solana');}
function tokenMatches(data: Obj, token: Signal['token'], requireAddress = false): boolean {
  if (!chainMatches(data.chain, token.chain)) return false;
  const candidates = [data.token_address, ...(requireAddress ? [data.address] : [])].filter(v => v !== undefined);
  return candidates.length ? candidates.every(v => address(v, token.chain) === address(token.address, token.chain)) : !requireAddress;
}
function date(v: unknown): string | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n < 8.64e12 ? new Date(n * 1_000).toISOString() : null;
}

/** Keep decimal USD totals exact, including large string amounts. */
function decimal(v: unknown, signed = false): string | null {
  if (!(typeof v === 'string' || typeof v === 'number') || (typeof v === 'number' && !Number.isFinite(v))) return null;
  const text = String(v);
  if (text.length > 240) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d{1,3}))?$/i.exec(text);
  if (!match || (!signed && match[1] === '-')) return null;
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '') || '0';
  if (digits === '0') return '0';
  let scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (Math.abs(scale) > 100) return null;
  if (scale < 0) {digits += '0'.repeat(-scale); scale = 0;}
  if (scale) digits = digits.padStart(scale + 1, '0');
  const result = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits;
  return match[1] && result !== '0' ? `-${result}` : result;
}
function sum(values: (string | null)[]): string | null {
  const known = values.filter((v): v is string => v !== null);
  if (!known.length) return null;
  const scale = Math.max(...known.map(v => v.split('.')[1]?.length ?? 0));
  const total = known.reduce((n, v) => {
    const [whole, fraction = ''] = v.replace('-', '').split('.');
    return n + BigInt(`${whole}${fraction.padEnd(scale, '0')}`) * (v.startsWith('-') ? -1n : 1n);
  }, 0n);
  const digits = (total < 0 ? -total : total).toString().padStart(scale + 1, '0');
  return decimal(`${total < 0 ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`, true);
}
const positive = (v: string | null) => v !== null && !v.startsWith('-') && v !== '0';
const negate = (v: string) => v === '0' ? v : v.startsWith('-') ? v.slice(1) : `-${v}`;

const IdentitySchema = z.object({chain: z.enum(['bsc', 'solana', 'robinhood']), address: z.string(),
  label: z.string().trim().min(1).max(160), entityId: z.string().trim().min(1).max(160),
  category: z.enum(['exchange', 'public_entity', 'operator_defined', 'unknown']), reference: z.string().trim().min(1).max(2_000),
}).strict().superRefine((item, ctx) => {
  if (!address(item.address, item.chain)) ctx.addIssue({code: 'custom', path: ['address'], message: '身份映射地址必须符合其明确指定的链'});
  let validRef = item.category === 'operator_defined';
  try {const u = new URL(item.reference); validRef ||= u.protocol === 'https:' && !u.username && !u.password && !u.port;} catch {}
  if (!validRef) ctx.addIssue({code: 'custom', path: ['reference'], message: '公开归属必须提供 HTTPS 来源；自定义归属请选择 operator_defined'});
});

/** Strict configuration parsing; this is not a source of verified personal identity. */
export function parseWalletIdentities(input: unknown): WalletIdentity[] {
  return z.array(IdentitySchema).max(5_000).superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const key = `${items[i].chain}:${address(items[i].address, items[i].chain)}`;
      if (seen.has(key)) ctx.addIssue({code: 'custom', path: [i, 'address'], message: '同一链的钱包归属只能配置一次'});
      seen.add(key);
    }
  }).parse(input).map(item => ({...item, address: address(item.address, item.chain)!}));
}
function exchangeLabel(value: unknown): boolean {
  return typeof value === 'string' && /^(binance|coinbase|okx|okex|bybit|kraken|kucoin|bitget|mexc|gate\.io|gate|htx|huobi|crypto\.com)(?:[\s_-]+(?:hot[\s_-]*wallet|exchange|wallet|cex))?(?:[\s_-]*#?\d+)?$/i.test(value.trim());
}
function recognize(platform: string[], token: string[]): WalletRecord['recognizedLabels'] {
  const out: WalletRecord['recognizedLabels'] = [];
  if (platform.some(v => v === 'smart_degen' || v === 'smart_money')) out.push('smart');
  if (platform.some(v => v === 'renowned' || v === 'kol')) out.push('kol');
  for (const [tag, label] of [['bundler', 'bundler'], ['rat_trader', 'rat_trader'], ['dev', 'developer']] as const)
    if (platform.includes(tag) || token.includes(tag)) out.push(label);
  if (platform.some(v => v === 'exchange' || v === 'cex')) out.push('exchange_or_pool');
  return out;
}
function rowToWallet(row: Obj, signal: Signal, source: WalletRecord['sources'][number], identities: Map<string, WalletIdentity>): WalletRecord | null {
  const chain = signal.token.chain, ca = address(row.address, chain);
  if (!ca || !tokenMatches(row, signal.token) || (object(row.token) && !tokenMatches(row.token, signal.token, true))) return null;
  const amount = decimal(row.balance) ?? decimal(row.amount_cur);
  const platform = labels(row.tags), token = labels(row.maker_token_tags);
  const recognized = recognize(platform, token);
  if (row.addr_type === 2 || row.addr_type === '2' || identities.get(ca)?.category === 'exchange') recognized.push('exchange_or_pool');
  const funding = object(row.native_transfer) ? row.native_transfer : {};
  // Live OpenAPI uses from_address; older official docs call it address.
  const funder = address(funding.from_address ?? funding.address, chain);
  const fundingConflict = funding.from_address !== undefined && funding.address !== undefined &&
    address(funding.from_address, chain) !== address(funding.address, chain);
  return {
    chain, address: ca, sources: [source], vendorLabels: {provider: 'gmgn', verification: 'vendor_claim', platform, token}, recognizedLabels: [...new Set(recognized)],
    vendorIdentity: {name: str(row.name), twitterUsername: str(row.twitter_username), verification: 'vendor_claim'},
    attribution: identities.has(ca) ? {status: 'operator_supplied', verification: 'unverified', identity: identities.get(ca)} : {status: 'unknown', verification: 'unverified'},
    holding: {amount, usd: decimal(row.usd_value), supplyRatio: ratio(row.amount_percentage), currentlyHolding: amount === null ? null : positive(amount)},
    cumulative: {scope: 'vendor_token_cumulative', recentInflow: false, buyVolumeUsd: decimal(row.buy_volume_cur), sellVolumeUsd: decimal(row.sell_volume_cur),
      buyCount: count(row.buy_tx_count_cur), sellCount: count(row.sell_tx_count_cur), firstAcquiredAt: date(row.start_holding_at),
      lastActiveAt: date(row.last_active_timestamp), exitedAt: date(row.end_holding_at)},
    funding: {address: funder, label: str(funding.name) ?? null, source: funder ? 'native_transfer' : 'unknown', verification: 'vendor_claim',
      amount: decimal(funding.amount), timestamp: date(funding.timestamp), txHash: str(funding.tx_hash, 128) ?? null,
      sharedService: exchangeLabel(funding.name) || (!!funder && identities.get(funder)?.category === 'exchange'), conflict: fundingConflict},
    developerLinks: [], risks: [...(row.is_suspicious === true ? ['VENDOR_SUSPICIOUS_WALLET'] : []), ...(fundingConflict ? ['FUNDING_SOURCE_CONFLICT'] : [])], clusterId: '',
    enrichment: {status: 'not_requested', reasons: []},
  };
}

function addStats(wallet: WalletRecord, payload: unknown, identities: Map<string, WalletIdentity>): boolean {
  // Single-wallet endpoint is a bare object. A batch array cannot safely be attributed without its own address.
  const data = object(payload) ? payload : Array.isArray(payload) && payload.length === 1 && object(payload[0]) &&
    address(payload[0].wallet_address ?? payload[0].address, wallet.chain) === wallet.address ? payload[0] as Obj : null;
  const wrongScope = (Array.isArray(payload) && payload.length > 0 && !data) || (!!data && (!chainMatches(data.chain, wallet.chain) ||
    (data.wallet_address !== undefined && address(data.wallet_address, wallet.chain) !== wallet.address) ||
    (data.address !== undefined && address(data.address, wallet.chain) !== wallet.address) ||
    (object(data.common) && data.common.wallet_address != null && data.common.wallet_address !== '' && address(data.common.wallet_address, wallet.chain) !== wallet.address)));
  if (wrongScope) wallet.enrichment.reasons.push('GMGN_WALLET_SCOPE_MISMATCH');
  if (!data || wrongScope ||
    !['realized_profit', 'total_cost', 'winrate', 'buy_count', 'sell_count', 'buy', 'sell', 'common'].some(k => data[k] !== undefined)) return false;
  const pnlStat = object(data.pnl_stat) ? data.pnl_stat : {};
  const stats: NonNullable<WalletRecord['enrichment']['stats']> = {period: '7d', scope: 'entire_wallet', realizedProfitUsd: decimal(data.realized_profit, true),
    winRate: ratio(data.winrate) ?? ratio(pnlStat.winrate), totalBuyCostUsd: decimal(data.total_cost),
    buyCount: count(data.buy_count) ?? count(data.buy), sellCount: count(data.sell_count) ?? count(data.sell)};
  if ([stats.realizedProfitUsd, stats.winRate, stats.totalBuyCostUsd, stats.buyCount, stats.sellCount].every(v => v === null)) return false;
  wallet.enrichment.stats = stats;
  if (object(data.common)) {
    const common = data.common;
    wallet.vendorLabels.platform = [...new Set([...wallet.vendorLabels.platform, ...labels(common.tags), ...labels([common.tag])])];
    wallet.recognizedLabels = [...new Set([...wallet.recognizedLabels, ...recognize(wallet.vendorLabels.platform, wallet.vendorLabels.token)])];
    wallet.vendorIdentity.name ??= str(common.name);
    wallet.vendorIdentity.twitterUsername ??= str(common.twitter_username);
    const funder = address(common.fund_from_address, wallet.chain);
    if (funder && wallet.funding.address && funder !== wallet.funding.address) {
      wallet.funding.conflict = true; wallet.risks.push('FUNDING_SOURCE_CONFLICT');
    } else if (funder) {
      wallet.funding.source = wallet.funding.address ? 'both' : 'wallet_stats';
      wallet.funding.address = funder;
      wallet.funding.label ??= str(common.fund_from) ?? null;
      wallet.funding.amount ??= decimal(common.fund_amount);
      wallet.funding.timestamp ??= date(common.fund_from_ts);
      wallet.funding.txHash ??= str(common.fund_tx_hash, 128) ?? null;
      wallet.funding.sharedService ||= exchangeLabel(common.fund_from) || identities.get(funder)?.category === 'exchange';
    }
  }
  return true;
}

function addActivity(wallet: WalletRecord, payload: unknown, signal: Signal, now: Date, windowSeconds: number): boolean {
  if (!object(payload)) return false;
  if (!tokenMatches(payload, signal.token) ||
    (payload.wallet_address !== undefined && address(payload.wallet_address, wallet.chain) !== wallet.address)) {
    wallet.enrichment.reasons.push('GMGN_WALLET_SCOPE_MISMATCH'); return false;
  }
  if (!Array.isArray(payload.activities) || payload.activities.length > 100) return false;
  const events: WalletActivity[] = [], seen = new Set<string>();
  let invalid = false;
  for (const raw of payload.activities) {
    if (!object(raw) || !chainMatches(raw.chain, wallet.chain) || !object(raw.token) || !tokenMatches(raw.token, signal.token, true) ||
      (raw.wallet !== undefined && address(raw.wallet, wallet.chain) !== wallet.address)) {
      invalid = true; wallet.enrichment.reasons.push('GMGN_WALLET_SCOPE_MISMATCH'); continue;
    }
    const type = raw.event_type ?? raw.type;
    const at = date(raw.timestamp), tx = str(raw.tx_hash, 128);
    if (!at || !tx || !['buy', 'sell', 'transferIn', 'transferOut', 'add', 'remove', 'launch'].includes(String(type)) || Date.parse(at) > now.getTime()) {invalid = true; continue;}
    // GMGN launch activity is a vendor-reported creator link, never buy flow.
    // Retain the raw event and exclude this wallet's entire funding component.
    if (type === 'launch') {
      if (!wallet.developerLinks.includes('VENDOR_TOKEN_LAUNCH_ACTIVITY')) wallet.developerLinks.push('VENDOR_TOKEN_LAUNCH_ACTIVITY');
      continue;
    }
    const event: WalletActivity = {txHash: tx, type: type as WalletActivity['type'], timestamp: at, amount: decimal(raw.token_amount), usd: decimal(raw.cost_usd)};
    const key = JSON.stringify(event);
    if (!seen.has(key)) {events.push(event); seen.add(key);}
  }
  const since = new Date(now.getTime() - windowSeconds * 1_000).toISOString();
  const recent = events.filter(v => v.timestamp >= since);
  const hasMore = payload.next === null || payload.next === '' ? false : typeof payload.next === 'string' && payload.next.length > 0 ? true : null;
  const descending = events.every((v, i) => i === 0 || events[i - 1].timestamp >= v.timestamp);
  const coveredStart = events.length > 0 && descending && events.at(-1)!.timestamp <= since;
  const complete = (hasMore === false || coveredStart) && !invalid && recent.every(v => !['buy', 'sell'].includes(v.type) || v.usd !== null);
  const buy = sum(recent.filter(v => v.type === 'buy').map(v => v.usd)) ?? '0';
  const sell = sum(recent.filter(v => v.type === 'sell').map(v => v.usd)) ?? '0';
  const net = sum([buy, negate(sell)])!;
  const times = events.map(v => v.timestamp).sort();
  wallet.enrichment.activity = {scope: 'token_activity_page', events, hasMore, firstAt: times[0] ?? null, lastAt: times.at(-1) ?? null,
    recent: {since, until: now.toISOString(), coverage: complete ? hasMore === false ? 'vendor_exhausted_feed' : 'vendor_window_covered' : 'partial',
      buyUsd: complete ? buy : null, sellUsd: complete ? sell : null, netBuyUsd: complete ? net : null, hasAccumulation: complete ? positive(net) : null}};
  if (invalid) wallet.enrichment.reasons.push('GMGN_ACTIVITY_ROWS_INVALID_OR_WRONG_TOKEN');
  if (!complete) wallet.enrichment.reasons.push('RECENT_ACTIVITY_COVERAGE_INCOMPLETE');
  return !invalid;
}

function makeClusters(wallets: WalletRecord[], chain: Chain, developer: string | null, developerFunder: string | null,
  identities: Map<string, WalletIdentity>): WalletCluster[] {
  const parent = new Map<string, string>();
  const root = (a: string): string => {if (!parent.has(a)) parent.set(a, a); const p = parent.get(a)!; if (p !== a) parent.set(a, root(p)); return parent.get(a)!;};
  const join = (a: string, b: string) => {const left = root(a), right = root(b); if (left !== right) parent.set(right, left);};
  const serviceAddresses = new Set([...identities.values()].filter(i => i.category === 'exchange').map(i => i.address));
  for (const w of wallets) {
    root(w.address);
    if (w.recognizedLabels.includes('exchange_or_pool')) serviceAddresses.add(w.address);
    if (w.funding.sharedService && w.funding.address) serviceAddresses.add(w.funding.address);
  }
  const entityFirst = new Map<string, string>();
  for (const w of wallets) {
    w.funding.sharedService ||= !!w.funding.address && serviceAddresses.has(w.funding.address);
    if (w.funding.address && !w.funding.sharedService && !w.funding.conflict && !serviceAddresses.has(w.address)) join(w.address, w.funding.address);
    const identity = identities.get(w.address);
    if (identity && ['public_entity', 'operator_defined'].includes(identity.category) && !serviceAddresses.has(w.address)) {
      const first = entityFirst.get(identity.entityId);
      if (first) join(first, w.address); else entityFirst.set(identity.entityId, w.address);
    }
  }
  if (developer && developerFunder && !serviceAddresses.has(developerFunder) && !serviceAddresses.has(developer)) join(developer, developerFunder);
  const groups = new Map<string, WalletRecord[]>();
  for (const w of wallets) {const id = root(w.address); groups.set(id, [...groups.get(id) ?? [], w]);}
  const clusters: WalletCluster[] = [];
  for (const members of groups.values()) {
    const addresses = members.map(v => v.address).sort();
    const id = `${chain}:${createHash('sha256').update(addresses.join('|')).digest('hex').slice(0, 16)}`;
    const funders = [...new Set(members.flatMap(v => v.funding.address && !v.funding.sharedService && !v.funding.conflict ? [v.funding.address] : []))];
    const linked = !!developer && root(members[0].address) === root(developer);
    const basis: WalletCluster['basis'] = [];
    if (members.length > 1 && members.some(w => members.some(other => other !== w && w.funding.address && w.funding.address === other.funding.address && !w.funding.sharedService))) basis.push('shared_funding');
    if (members.length > 1 && funders.some(f => addresses.includes(f))) basis.push('funding_link');
    if (members.length > 1 && members.some(w => w.attribution.identity && members.some(other => other !== w && other.attribution.identity?.entityId === w.attribution.identity!.entityId))) basis.push('operator_entity');
    if (!basis.length) basis.push('single_wallet');
    for (const w of members) {
      w.clusterId = id;
      if (developer === w.address) w.developerLinks.push('DEVELOPER_ADDRESS_MATCH');
      if (developer && w.funding.address === developer && !w.funding.sharedService && !w.funding.conflict) w.developerLinks.push('DEVELOPER_DIRECT_FUNDING');
      if (developerFunder && w.funding.address === developerFunder && !w.funding.sharedService && !w.funding.conflict) w.developerLinks.push('SHARED_DEVELOPER_FUNDING');
      if (linked && !w.developerLinks.length) w.developerLinks.push('DEVELOPER_FUNDING_CLUSTER');
      if (w.recognizedLabels.includes('developer')) w.developerLinks.push('VENDOR_DEVELOPER_TAG');
    }
    clusters.push({id, chain, wallets: addresses, fundingAddresses: funders, basis, ownership: 'unknown', independenceProven: false,
      smartCurrentHolders: members.filter(w => w.recognizedLabels.includes('smart') && w.holding.currentlyHolding === true).length,
      developerLinked: linked || members.some(w => w.developerLinks.length > 0)});
  }
  return clusters;
}

/** Official routes/fields: GMGNAI/gmgn-skills src/client/OpenApiClient.ts and
 * skills/gmgn-token/SKILL.md + skills/gmgn-portfolio/SKILL.md. All labels are claims. */
export async function analyzeWallets(signal: Signal, tokenInfo: unknown, client: GmgnClient,
  options: WalletAnalysisOptions = {}): Promise<WalletAnalysis> {
  const clock = options.now ?? (() => new Date()), startedAt = clock();
  const chain = signal.token.chain, apiChain = chain === 'solana' ? 'sol' : chain;
  const max = Number.isFinite(options.maxWallets) ? Math.max(1, Math.min(5, Math.floor(options.maxWallets!))) : 3;
  const windowSeconds = Number.isFinite(options.recentWindowSec) ? Math.max(60, Math.min(86_400, Math.floor(options.recentWindowSec!))) : RECENT_WALLET_WINDOW_SECONDS;
  const reasons = new Set<string>(), raw: Record<string, unknown> = {};
  const identities = new Map(parseWalletIdentities(options.identities ?? []).filter(v => v.chain === chain).map(v => [v.address, v]));
  const wallets = new Map<string, WalletRecord>();
  let unavailable = false;
  const validInfo = object(tokenInfo) && tokenMatches(tokenInfo, signal.token, true);
  if (!address(signal.token.address, chain) || !validInfo) {
    reasons.add('GMGN_WALLET_TOKEN_SCOPE_MISMATCH'); unavailable = true;
  }
  const request = async (key: string, path: string, query: Record<string, string | number>, weight: number): Promise<unknown> => {
    try {const data = await client.get(path, query, weight); raw[key] = data; return data;}
    catch (error) {
      unavailable = true;
      reasons.add(error instanceof GmgnError ? error.reason : 'GMGN_WALLET_REQUEST_FAILED');
      if (error instanceof GmgnError && error.cooldownUntil) raw.cooldownUntil = error.cooldownUntil;
      return undefined;
    }
  };
  if (validInfo && address(signal.token.address, chain)) {
    for (const source of ['top_holders', 'smart_holders'] as const) {
      const data = await request(source, HOLDERS, {chain: apiChain, address: signal.token.address, limit: 20,
        order_by: 'amount_percentage', direction: 'desc', ...(source === 'smart_holders' ? {tag: 'smart_degen'} : {})}, 5);
      if (!object(data) || !tokenMatches(data, signal.token, data.address !== undefined) || !Array.isArray(data.list) || data.list.length > 100) {
        unavailable = true; reasons.add('GMGN_HOLDERS_RESPONSE_INVALID'); continue;
      }
      for (const row of data.list) {
        const wallet = object(row) ? rowToWallet(row, signal, source, identities) : null;
        if (!wallet) {unavailable = true; reasons.add('GMGN_HOLDER_SCOPE_OR_ADDRESS_INVALID'); continue;}
        const existing = wallets.get(wallet.address);
        if (!existing) {wallets.set(wallet.address, wallet); continue;}
        if (existing.holding.amount !== wallet.holding.amount) {unavailable = true; reasons.add('GMGN_DUPLICATE_HOLDINGS_DIFFER');}
        existing.sources = [...new Set([...existing.sources, source])];
        existing.vendorLabels.platform = [...new Set([...existing.vendorLabels.platform, ...wallet.vendorLabels.platform])];
        existing.vendorLabels.token = [...new Set([...existing.vendorLabels.token, ...wallet.vendorLabels.token])];
        existing.recognizedLabels = [...new Set([...existing.recognizedLabels, ...wallet.recognizedLabels])];
        existing.risks = [...new Set([...existing.risks, ...wallet.risks])];
        if (!existing.funding.address && wallet.funding.address) existing.funding = wallet.funding;
        else if (existing.funding.address && wallet.funding.address && existing.funding.address !== wallet.funding.address) {
          existing.funding.conflict = true; existing.risks.push('FUNDING_SOURCE_CONFLICT');
        } else existing.funding.sharedService ||= wallet.funding.sharedService;
      }
    }
  }
  const info = validInfo ? tokenInfo as Obj : {}, dev = object(info.dev) ? info.dev : {};
  const developer = address(dev.creator_address, chain), developerFunder = address(dev.fund_from, chain);
  // Prioritize smart participants, then suspicious/developer wallets, before ordinary large holders.
  const priority = (w: WalletRecord) => (w.holding.currentlyHolding === true ? 200 : 0) + (w.recognizedLabels.includes('smart') ? 100 : 0) +
    (w.address === developer || w.recognizedLabels.some(t => ['bundler', 'rat_trader', 'developer'].includes(t)) ? 50 : 0) + (w.holding.supplyRatio ?? 0);
  const plan=options.researchTargets,planAt=Date.parse(plan?.checkedAt??''),targetAddresses:string[]=[];
  if(validInfo&&plan?.source==='local_observations'&&plan.token.chain===chain&&address(plan.token.address,chain)===address(signal.token.address,chain)&&
    Number.isFinite(planAt)&&planAt<=startedAt.getTime()&&startedAt.getTime()-planAt<=120000&&Array.isArray(plan.targets)) {
    for(const target of plan.targets.slice(0,6)){
      const who=address(target.address,chain),eventAt=Date.parse(target.eventAt),observedAt=Date.parse(target.observedAt);
      if(who&&!/^0x0+$/i.test(who)&&address(target.triggerWallet,chain)&&Number.isFinite(eventAt)&&Number.isFinite(observedAt)&&
        eventAt<=observedAt&&observedAt<=planAt&&planAt-eventAt<=600000&&!targetAddresses.includes(who))targetAddresses.push(who);
    }
  }
  const localTargetAddresses=[...targetAddresses],vendor=options.vendorWalletTargets,vendorAddresses:string[]=[];
  let vendorRejection:string|undefined;
  if(vendor!==undefined) {
    const checkedAt=object(vendor)&&typeof vendor.checkedAt==='string'?Date.parse(vendor.checkedAt):NaN;
    if(!validInfo||!object(vendor)||vendor.provider!=='debot'||!object(vendor.token)||vendor.token.chain!==chain||
      !address(vendor.token.address,chain)||address(vendor.token.address,chain)!==address(signal.token.address,chain)||
      /^0x0{40}$/i.test(signal.token.address)||signal.token.address==='11111111111111111111111111111111')
      vendorRejection='VENDOR_WALLET_TARGET_SCOPE_INVALID';
    else if(!Number.isFinite(checkedAt)||checkedAt>startedAt.getTime()||startedAt.getTime()-checkedAt>120_000)
      vendorRejection='VENDOR_WALLET_TARGET_TIME_INVALID';
    else if(!Array.isArray(vendor.addresses)||vendor.addresses.length>100)
      vendorRejection='VENDOR_WALLET_TARGET_ADDRESSES_INVALID';
    else {
      // Read at most a detail page and nominate three actual addresses. Aliases and counts are never inspected.
      for(const value of vendor.addresses.slice(0,20)) {
        const who=address(value,chain);
        if(!who||/^0x0{40}$/i.test(who)||who==='11111111111111111111111111111111'||vendorAddresses.includes(who))continue;
        vendorAddresses.push(who);if(vendorAddresses.length===3)break;
      }
      if(!vendorAddresses.length)vendorRejection='VENDOR_WALLET_TARGET_ADDRESSES_INVALID';
    }
    // Local qualifications keep priority. Vendor nominees consume the same existing research budget.
    for(const who of vendorAddresses)if(!targetAddresses.includes(who))targetAddresses.push(who);
  }
  const ranked=[...wallets.values()].filter(w=>!w.recognizedLabels.includes('exchange_or_pool')).sort((a,b)=>priority(b)-priority(a));
  const selected:WalletRecord[]=[],balanceNeeded=new Set<string>(),selectedAddresses=new Set<string>();
  let requestsRemaining=max*2,plannedWeight=0;
  // Preserve the old per-analysis cap: max wallets, 2*max requests and 6*max weighted units.
  // An off-list target costs balance + stats + activity, replacing existing slots rather than expanding the budget.
  for(const who of [...targetAddresses,...ranked.map(w=>w.address)]){
    if(selected.length>=max||selectedAddresses.has(who))continue;
    let wallet=wallets.get(who);if(wallet?.recognizedLabels.includes('exchange_or_pool'))continue;
    const balance=targetAddresses.includes(who)&&(!wallet||wallet.holding.currentlyHolding===null),cost=balance?3:2,weight=balance?8:6;
    if(cost>requestsRemaining||plannedWeight+weight>max*6)continue;
    if(!wallet){wallet=rowToWallet({address:who,token_address:signal.token.address,chain},signal,'targeted_balance',identities)!;wallets.set(who,wallet);}
    selected.push(wallet);selectedAddresses.add(who);requestsRemaining-=cost;plannedWeight+=weight;if(balance)balanceNeeded.add(who);
  }
  const list = [...wallets.values()];
  for (const wallet of selected) {
    if(balanceNeeded.has(wallet.address)){
      const payload=await request(`balance:${wallet.address}`,TOKEN_BALANCE,{chain:apiChain,wallet_address:wallet.address,token_address:signal.token.address},2);
      const balance=parseTargetTokenBalance(payload,signal.token,wallet.address);
      wallet.holding.currentlyHolding=balance.currentlyHolding;
      // The official token-balance reference does not define its amount units. Only zero/positive is portable.
      wallet.holding.amount=balance.currentlyHolding===false?'0':null;
      if(!wallet.sources.includes('targeted_balance'))wallet.sources.push('targeted_balance');
      if(balance.status!=='confirmed'){
        unavailable=true;reasons.add(balance.reason);wallet.enrichment.reasons.push(balance.reason);
        if(balance.reason==='GMGN_TARGET_BALANCE_SCOPE_MISMATCH'){wallet.risks.push(balance.reason);reasons.add('GMGN_WALLET_SCOPE_MISMATCH');}
      }
    }
    const stats = await request(`stats:${wallet.address}`, STATS, {chain: apiChain, wallet_address: wallet.address, period: '7d'}, 3);
    const statsOk = addStats(wallet, stats, identities);
    if (!statsOk) wallet.enrichment.reasons.push('GMGN_WALLET_STATS_INVALID');
    const activity = await request(`activity:${wallet.address}`, ACTIVITY, {chain: apiChain, wallet_address: wallet.address, token_address: signal.token.address, limit: 20}, 3);
    // A trade can occur while preceding holder/stats requests are in flight.
    // Validate against this response's receipt time, not research start time.
    const activityOk = addActivity(wallet, activity, signal, clock(), windowSeconds);
    if (!activityOk) wallet.enrichment.reasons.push('GMGN_WALLET_ACTIVITY_INVALID');
    wallet.enrichment.status = statsOk && activityOk ? 'complete' : 'partial';
    if (!statsOk || !activityOk) {unavailable = true; reasons.add('GMGN_WALLET_ENRICHMENT_PARTIAL');}
    if (wallet.enrichment.reasons.includes('GMGN_WALLET_SCOPE_MISMATCH')) reasons.add('GMGN_WALLET_SCOPE_MISMATCH');
    if (wallet.enrichment.reasons.includes('GMGN_ACTIVITY_ROWS_INVALID_OR_WRONG_TOKEN')) reasons.add('GMGN_WALLET_ACTIVITY_DATA_INVALID');
  }
  const clusters = makeClusters(list, chain, developer, developerFunder, identities);
  const smart = list.filter(w => w.recognizedLabels.includes('smart') && w.holding.currentlyHolding === true);
  const riskyClusters = new Set(list.filter(w => w.risks.length || w.recognizedLabels.some(t => ['bundler', 'rat_trader'].includes(t))).map(w => w.clusterId));
  const eligible = smart.filter(w => !w.developerLinks.length && !w.risks.length && !riskyClusters.has(w.clusterId) &&
    !w.recognizedLabels.some(t => ['bundler', 'rat_trader', 'developer', 'exchange_or_pool'].includes(t)) &&
    !clusters.find(c => c.id === w.clusterId)?.developerLinked);
  const qualified = eligible.filter(w => w.enrichment.status === 'complete' && w.enrichment.activity?.recent.hasAccumulation === true);
  const recentComplete = eligible.length > 0 && eligible.every(w => w.enrichment.activity && w.enrichment.activity.recent.coverage !== 'partial');
  if (!list.length) {unavailable = true; reasons.add('GMGN_HOLDERS_EMPTY');}
  if (list.some(w => w.developerLinks.length)) reasons.add('DEVELOPER_LINKED_WALLETS_OBSERVED');
  if (list.some(w => w.funding.sharedService)) reasons.add('EXCHANGE_FUNDING_NOT_OWNERSHIP_LINK');
  if (list.some(w => w.funding.conflict)) {unavailable = true; reasons.add('GMGN_FUNDING_CONFLICT');}
  if (list.some(w => w.holding.currentlyHolding === null)) {unavailable = true; reasons.add('GMGN_HOLDING_AMOUNT_MISSING');}
  if (!recentComplete && eligible.length) reasons.add('RECENT_SMART_FLOW_COVERAGE_INCOMPLETE');
  reasons.add('WALLET_TAGS_ARE_VENDOR_CLAIMS'); reasons.add('WALLET_OWNERSHIP_UNVERIFIED'); reasons.add('CUMULATIVE_VOLUMES_ARE_NOT_RECENT_FLOW');
  const cumulative = list.filter(w => w.cumulative.buyVolumeUsd !== null && w.cumulative.sellVolumeUsd !== null);
  const completedAt = clock();
  return {status: unavailable ? 'unknown' : 'pass', checkedAt: completedAt.toISOString(), reasons: [...reasons],
    facts: {provider: 'gmgn', source: 'openapi', token: signal.token, maxEnrichedWallets: max, holderLimitPerQuery: 20,
      collectionStartedAt: startedAt.toISOString(),
      ...(plan?{researchTargets:{source:'local_observations',requested:localTargetAddresses,selected:localTargetAddresses.filter(a=>selectedAddresses.has(a)),
        deferred:localTargetAddresses.filter(a=>!selectedAddresses.has(a)),balanceQueries:[...balanceNeeded].filter(a=>localTargetAddresses.includes(a)),truncated:plan.truncated,
        requestBudget:max*2,plannedRequests:max*2-requestsRemaining,weightedBudget:max*6,plannedWeight}}:{}),
      ...(vendor!==undefined?{vendorWalletTargets:{provider:'debot',scope:'research_nomination_only',requested:vendorAddresses,
        selected:vendorAddresses.filter(a=>selectedAddresses.has(a)),deferred:vendorAddresses.filter(a=>!selectedAddresses.has(a)),
        balanceQueries:[...balanceNeeded].filter(a=>vendorAddresses.includes(a)),
        ...(vendorRejection?{reason:vendorRejection}:{}),requestBudget:max*2,plannedRequests:max*2-requestsRemaining,
        weightedBudget:max*6,plannedWeight,ownershipProven:false,buyEvidence:false,qualifiesAsSmart:false,
        note:'DeBot 提名仅安排查询；钱包归属、聪明钱包资格及买入支持仍由独立研究判定。'}}:{}),
      sampleOnly: true, developerAddress: developer, developerFundingAddress: developerFunder, developerSource: 'vendor_claim',
      scopeBinding: 'chain_and_token_request_with_response_checks', realPersonIdentityVerified: false,
      rawResponses: raw, documentation: ['https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token/SKILL.md',
        'https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-portfolio/SKILL.md']}, wallets: list, clusters,
    summary: {token: signal.token, sampleOnly: true, uniqueWalletCount: list.length, enrichedWalletCount: selected.length,
      currentHolderCount: list.filter(w => w.holding.currentlyHolding === true).length, smartCurrentHolderCount: smart.length,
      smartFundingClusterCount: new Set(smart.map(w => w.clusterId)).size, smartIndependenceProven: false,
      eligibleSmartWalletCount: eligible.length, qualifiedSmartWalletCount: qualified.length,
      qualifiedSmartFundingClusterCount: new Set(qualified.map(w => w.clusterId)).size, recentWindowSeconds: windowSeconds,
      recentNetBuyUsd: recentComplete ? sum(eligible.map(w => w.enrichment.activity!.recent.netBuyUsd)) : null,
      hasRecentAccumulation: qualified.length > 0 ? true : eligible.length === 0 || recentComplete ? false : null,
      sampledHoldingRatio: list.some(w => w.holding.supplyRatio !== null) ? list.reduce((n, w) => n + (w.holding.supplyRatio ?? 0), 0) : null,
      cumulativeBuyUsd: sum(cumulative.map(w => w.cumulative.buyVolumeUsd)), cumulativeSellUsd: sum(cumulative.map(w => w.cumulative.sellVolumeUsd)),
      cumulativeCoverageWalletCount: cumulative.length, cumulativeIsRecentInflow: false}};
}
