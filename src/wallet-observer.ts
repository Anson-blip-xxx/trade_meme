import bs58 from 'bs58';
import type {Config} from './config.js';
import type {Chain, Signal} from './types.js';
import type {GmgnFeedPage} from './scanner.js';
import {GmgnError, type GmgnClient} from './providers/gmgn-client.js';
import {analyzeWallets} from './research/wallets.js';
import type {WalletHistory, WalletTradeObservation, WalletTokenTraderObservation} from './wallet-history.js';
import {parseWalletObserverCursor, type WalletObserverCursorState, type WalletObserverPending} from './wallet-observer-state.js';

// Primary schemas: GMGNAI/gmgn-skills at 4575ef539e6a3115fa0481d41285cb79e77970bf:
// gmgn-track/SKILL.md L259-278; gmgn-market/SKILL.md L134-141,L366-400;
// gmgn-token/SKILL.md L374-424; gmgn-portfolio/SKILL.md L253-269.
// Rechecked official gmgn-token/SKILL.md on 2026-10-16: limit<=100;
// profit/unrealized_profit/buy_volume_cur/sell_volume_cur are documented sorts.
// start_holding_at is acquisition, not first_buy_time. The response defines
// profit as total PnL; ambiguous vendor ordering must not be renamed realized rank.
const CHAINS: Chain[] = ['bsc', 'solana', 'robinhood'];
const apiChain = (chain: Chain) => chain === 'solana' ? 'sol' : chain;
type Token = {chain: Chain; address: string};
type AssociationTarget = Token & {anchorWallet: string; anchorEventAt: string; anchorObservedAt: string; candidateWallet?: string;
  historicalRelationship?: boolean};
type ReadRequest = (path: string, query: Record<string, string | number>, weight?: number) => Promise<unknown>;
type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
function address(value: unknown, chain: Chain, transaction = false): string | undefined {
  if (typeof value !== 'string') return;
  if (chain !== 'solana') return new RegExp(`^0x[0-9a-f]{${transaction ? 64 : 40}}$`, 'i').test(value)
    && !/^0x0+$/i.test(value) ? value.toLowerCase() : undefined;
  if (value.length > (transaction ? 88 : 44) || value.length < 32) return;
  try {const bytes = bs58.decode(value); if (bytes.length === (transaction ? 64 : 32) && bytes.some(byte => byte !== 0)) return value;} catch {}
}
function decimal(value: unknown, signed = false): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'number' &&
      (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return null;
  const text = String(value);
  if (text.length > 160) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d{1,3}))?$/i.exec(text);
  if (!match || !signed && match[1]) return null;
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '') || '0';
  if (digits === '0') return '0';
  let scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (Math.abs(scale) > 100) return null;
  if (scale < 0) {digits += '0'.repeat(-scale); scale = 0;}
  digits = digits.padStart(scale + 1, '0');
  return match[1] + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits);
}
const labels = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(item)))].slice(0, 30) : [];
const matchesChain = (row: Obj, chain: Chain) => row.chain === undefined || row.chain === apiChain(chain);
function rankPayload(raw: unknown, chain: Chain): Obj | undefined {
  if (!object(raw) || !matchesChain(raw, chain)) return;
  const hasCode = Object.hasOwn(raw, 'code'), successful = raw.code === 0 || raw.code === '0';
  if (hasCode && !successful) return;
  if (Array.isArray(raw.rank)) {
    // Do not choose between conflicting direct and nested ranking sources.
    if (Object.hasOwn(raw, 'data')) return;
    return raw;
  }
  // A 2026-10-09 read-only BSC sample retained this second service envelope
  // after GmgnClient had already removed the outer OpenAPI envelope.
  // Accept one explicit successful envelope, never arbitrary recursive data.
  if (!successful || !object(raw.data) || !matchesChain(raw.data, chain) ||
      Object.hasOwn(raw.data, 'code') || !Array.isArray(raw.data.rank)) return;
  return raw.data;
}
function walletResponseMatches(row: Obj, chain: Chain, wallet: string): boolean {
  const identities = [row.wallet_address, row.address, ...(object(row.common) ? [row.common.wallet_address] : [])]
    .filter(value => value !== undefined && value !== '');
  return matchesChain(row, chain) && identities.length > 0 && identities.every(value => address(value, chain) === wallet);
}
function eventTime(value: unknown, observedAt: string): string | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,11}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds * 1000 > Date.parse(observedAt)) return;
  return new Date(seconds * 1000).toISOString();
}
const hasMore = (raw: Obj): boolean | null => raw.next === '' || raw.next === null ? false : typeof raw.next === 'string' ? true : null;
interface ParsedTrades {trades: WalletTradeObservation[]; received: number; rejected: number; hasMore: boolean | null; invalidReason?: string;}
type TraderSort = 'profit' | 'unrealized_profit' | 'buy_volume_cur' | 'sell_volume_cur';
const TRADER_SORTS: TraderSort[] = ['profit', 'unrealized_profit', 'buy_volume_cur', 'sell_volume_cur'];
const TRADER_SCOPE = {profit: 'vendor_profit_order', unrealized_profit: 'vendor_unrealized_profit_order',
  buy_volume_cur: 'vendor_buy_volume_order', sell_volume_cur: 'vendor_sell_volume_order'} as const;

/** Documented acquisition time can include transfers. It is never a verified first buy. */
function traderRow(row: unknown, target: Token, rank: number, observedAt: string, sort: TraderSort, limit: 20 | 100):
  (WalletTokenTraderObservation & {researchCandidate: boolean}) | undefined {
  if (!object(row) || !matchesChain(row, target.chain) ||
      row.token_address !== undefined && address(row.token_address, target.chain) !== target.address ||
      object(row.token) && (!matchesChain(row.token, target.chain) || address(row.token.address, target.chain) !== target.address)) return;
  const wallet = address(row.address, target.chain); if (!wallet || wallet === target.address) return;
  return {address: wallet, rank, profitUsd: decimal(row.profit, true), realizedProfitUsd: decimal(row.realized_profit, true),
    unrealizedProfitUsd: decimal(row.unrealized_profit, true), labels: [...new Set([...labels(row.tags), ...labels(row.maker_token_tags)])],
    firstAcquiredAt: eventTime(row.start_holding_at, observedAt), lastActiveAt: eventTime(row.last_active_timestamp, observedAt),
    exitedAt: eventTime(row.end_holding_at, observedAt), buyVolumeUsd: decimal(row.buy_volume_cur),
    sellVolumeUsd: decimal(row.sell_volume_cur), balance: decimal(row.balance ?? row.amount_cur), rankScope: TRADER_SCOPE[sort], sampleLimit: limit,
    researchCandidate: row.addr_type !== 2 && row.addr_type !== '2' && !row.exchange};
}

/** Latest fetched page only; observedAt is not the historical trade timestamp. */
export function normalizeWalletFeed(page: GmgnFeedPage): ParsedTrades {
  const result: ParsedTrades = {trades: [], received: 0, rejected: 0, hasMore: null};
  const {chain, payload, fetchedAt} = page;
  if (page.errorReason !== undefined) return {...result, invalidReason:
    /^GMGN_(API_KEY_MISSING|RATE_LIMITED|QUEUE_TIMEOUT|REQUEST_TIMEOUT|REQUEST_FAILED|RESPONSE_TOO_LARGE|RESPONSE_INVALID|INVALID_JSON|AUTH_FAILED|HTTP_ERROR|API_ERROR)$/.test(page.errorReason)
      ? page.errorReason : 'GMGN_REQUEST_FAILED'};
  if (!CHAINS.includes(chain) || !['kol', 'smartmoney'].includes(page.kind) || !Number.isFinite(Date.parse(fetchedAt)) ||
      !object(payload) || !matchesChain(payload, chain) || !Array.isArray(payload.list)) return {...result, invalidReason: 'WALLET_FEED_SCHEMA_INVALID'};
  result.received = payload.list.length; result.hasMore = hasMore(payload);
  for (const row of payload.list.slice(0, 200)) {
    if (!object(row) || !matchesChain(row, chain) || (row.side !== 'buy' && row.side !== 'sell')) {result.rejected++; continue;}
    const wallet = address(row.maker, chain), tokenAddress = address(row.base_address, chain);
    const txHash = address(row.transaction_hash, chain, true), eventAt = eventTime(row.timestamp, fetchedAt);
    if (!wallet || !tokenAddress || !txHash || !eventAt ||
        object(row.maker_info) && row.maker_info.address !== undefined && address(row.maker_info.address, chain) !== wallet ||
        object(row.base_token) && (!matchesChain(row.base_token, chain) ||
          row.base_token.address !== undefined && address(row.base_token.address, chain) !== tokenAddress)) {result.rejected++; continue;}
    result.trades.push({chain, wallet, tokenAddress, txHash, side: row.side as 'buy' | 'sell', eventAt, observedAt: fetchedAt,
      amount: decimal(row.token_amount), amountUnit: 'vendor_quantity', usd: decimal(row.amount_usd),
      priceUsd: decimal(row.price_usd), source: `gmgn_${page.kind}_feed`});
  }
  result.rejected += Math.max(0, payload.list.length - 200);
  return result;
}

export function normalizeWalletActivity(raw: unknown, chain: Chain, wallet: string, observedAt: string,
  tokenAddressFilter?: string, source = 'gmgn_wallet_activity'): ParsedTrades {
  const result: ParsedTrades = {trades: [], received: 0, rejected: 0, hasMore: null};
  if (!object(raw) || !matchesChain(raw, chain) || !Array.isArray(raw.activities) ||
      raw.wallet_address !== undefined && address(raw.wallet_address, chain) !== wallet ||
      tokenAddressFilter !== undefined && (!address(tokenAddressFilter, chain) || object(raw) && raw.token_address !== undefined &&
        address(raw.token_address, chain) !== tokenAddressFilter)) return {...result, invalidReason: 'WALLET_ACTIVITY_SCHEMA_INVALID'};
  result.received = raw.activities.length; result.hasMore = hasMore(raw);
  for (const row of raw.activities.slice(0, 100)) {
    if (!object(row) || !matchesChain(row, chain) || !object(row.token) || !matchesChain(row.token, chain) ||
        row.wallet !== undefined && address(row.wallet, chain) !== wallet) {result.rejected++; continue;}
    const tokenAddress = address(row.token.address, chain), txHash = address(row.tx_hash, chain, true);
    const eventAt = eventTime(row.timestamp, observedAt), side = row.event_type ?? row.type;
    if (!tokenAddress || tokenAddressFilter !== undefined && tokenAddress !== tokenAddressFilter || !txHash || !eventAt ||
        typeof side !== 'string' || !['buy', 'sell', 'transferIn', 'transferOut', 'add', 'remove'].includes(side)) {
      result.rejected++; continue;
    }
    result.trades.push({chain, wallet, tokenAddress, txHash, eventAt, observedAt, side: side as WalletTradeObservation['side'],
      amount: decimal(row.token_amount), amountUnit: 'vendor_quantity', usd: decimal(row.cost_usd),
      priceUsd: decimal(row.price_usd), source});
  }
  result.rejected += Math.max(0, raw.activities.length - 100);
  return result;
}

export interface WalletObserverOptions {
  history: Pick<WalletHistory, 'recordTrades' | 'captureAnalysis' | 'captureLeaders' | 'captureTokenRanks' |
    'captureTokenTraders' | 'recordCollection' | 'watchTargets' | 'markTargetChecked' | 'recordPrice'> &
    Partial<Pick<WalletHistory, 'associationTargets' | 'markAssociationTargetChecked' | 'captureFunding' |
      'getWalletObserverCursor' | 'setWalletObserverCursor' | 'researchSeedTarget' | 'markResearchSeedChecked'>>;
  client: Pick<GmgnClient, 'get' | 'cooldownUntil'> & Partial<Pick<GmgnClient, 'recordRateLimit'>>;
  config?: Config;
  chains?: Chain[];
  intervalMs?: number;
  maxRequestsPerCycle?: number;
  now?: () => Date;
}
export interface WalletObserverCycle {
  chain: Chain; status: 'ok' | 'partial' | 'cooldown' | 'stopped'; startedAt: string; completedAt: string;
  requests: number; accepted: number; reasons: string[]; coverage: 'one_page_sample';
  collectionMode?: 'market_wallets' | 'kol_association' | 'external_seed_research';
}
class ObserverHalt extends Error {}

/** Persistent observational research only; never gates or initiates a trade. */
export class WalletObserver {
  private readonly history: WalletObserverOptions['history'];
  private readonly client: WalletObserverOptions['client'];
  private readonly now: () => Date;
  private readonly interval: number;
  private readonly maxRequests: number;
  private readonly chains: Chain[];
  private cursor = 0;
  private running = false;
  private generation = 0;
  private cooldown = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<WalletObserverCycle>;
  private lastCycle?: WalletObserverCycle;
  private lastFeedError?: string;
  private walletCursor = new Map<string, number>();
  private rankCursor = new Map<Chain, number>();
  private marketCursor = new Map<Chain, number>();
  private associationCursor = new Map<string, number>();
  private associationRounds = new Map<Chain, number>();
  private walletChecks = new Map<string, number>();
  private pending?: WalletObserverPending;
  private pendingByChain = new Map<Chain, WalletObserverPending>();
  private checkpoint?: WalletObserverCursorState;
  private cursorError?: string;

  constructor(options: WalletObserverOptions) {
    this.interval = options.intervalMs ?? 300_000; this.maxRequests = options.maxRequestsPerCycle ?? 9;
    if (!Number.isSafeInteger(this.interval) || this.interval < 1 || this.interval > 3_600_000 ||
        !Number.isSafeInteger(this.maxRequests) || this.maxRequests < 1 || this.maxRequests > 10)
      throw new Error('WALLET_OBSERVER_CONFIG_INVALID');
    const chains = options.chains ?? CHAINS;
    if (!Array.isArray(chains) || !chains.length || chains.some(chain => !CHAINS.includes(chain))) throw new Error('WALLET_OBSERVER_CONFIG_INVALID');
    this.chains = [...new Set(chains)];
    this.history = options.history; this.client = options.client; this.now = options.now ?? (() => new Date());
    try {
      const saved = parseWalletObserverCursor(this.history.getWalletObserverCursor?.());
      if (saved && JSON.stringify(saved.chains) === JSON.stringify(this.chains)) this.restoreCursor(saved);
    } catch {this.cursorError = 'WALLET_OBSERVER_CURSOR_READ_FAILED';}
  }

  observeFeed(page: GmgnFeedPage) {
    const parsed = normalizeWalletFeed(page);
    const report = {status: (parsed.invalidReason ? 'unavailable' : parsed.rejected ? 'partial' : 'ok') as 'unavailable' | 'partial' | 'ok',
      received: parsed.received, accepted: parsed.trades.length, rejected: parsed.rejected, hasMore: parsed.hasMore,
      coverage: 'one_page_sample' as const, reason: parsed.invalidReason as string | undefined};
    try {
      this.history.recordTrades(parsed.trades);
      this.history.recordCollection({source: `gmgn_${page.kind}_feed`, chain: page.chain,
        startedAt: page.fetchedAt, completedAt: page.fetchedAt, status: parsed.invalidReason || parsed.rejected ? 'partial' : 'ok',
        requests: 0, accepted: parsed.trades.length, rejected: parsed.rejected, coverage: 'one_page_sample', hasMore: parsed.hasMore,
        reason: parsed.invalidReason});
      this.lastFeedError = undefined;
    } catch {this.lastFeedError = 'WALLET_HISTORY_WRITE_FAILED'; report.status = 'unavailable'; report.reason = this.lastFeedError;}
    return report;
  }

  getStatus() {
    return {running: this.running, inFlight: !!this.inFlight, intervalMs: this.interval,
      maxRequestsPerCycle: this.maxRequests, coverage: 'one_page_sample' as const,
      marketSampling: {traderSorts: [...TRADER_SORTS], tradersPerPage: 100, walletSelection: 'least_checked_then_profit_or_early_acquisition',
        earliestScope: 'earliest_acquisition_in_sample_not_verified_buy', acquisitionIncludesTransfers: true,
        persistentCursor: !!this.history.getWalletObserverCursor && !!this.history.setWalletObserverCursor,
        pendingTargets: [...this.pendingByChain.values()].map(value => ({chain: value.chain, address: value.address, kind: value.kind}))},
      ...(this.cursorError ? {cursorError: this.cursorError} : {}),
      associationSampling: {enabled: !!this.history.associationTargets, alternatePerChain: true,
        anchorWindowHours: 24, traderPages: 2, tradersPerPage: 100, candidateWallets: 2,
        knownRelationshipPriorityEvery: 3, knownRelationshipsContinueAfterAnchorWindow: true,
        activityRowsPerWallet: 100, knownCandidateScope: 'whole_wallet_latest_page', wholeTokenTradeHistoryAvailable: false},
      researchSeedSampling:{enabled:!!this.history.researchSeedTarget,scope:'research_hint_only',maxRequestsPerTurn:1,
        eligibleEveryChainTurns:4,preservesAlternatingMarketTurn:true,minChainIntervalSec:1800},
      ...(this.resetAt() > this.now().getTime() ? {cooldownUntil: new Date(this.resetAt()).toISOString()} : {}),
      ...(this.lastFeedError ? {feedError: this.lastFeedError} : {}),
      ...(this.lastCycle ? {lastCycle: structuredClone(this.lastCycle)} : {})};
  }
  runOnce(): Promise<WalletObserverCycle> {
    if (this.inFlight) return this.inFlight;
    const operation = this.execute(this.generation); this.inFlight = operation;
    void operation.then(report => {this.lastCycle = report; if (this.inFlight === operation) this.inFlight = undefined;},
      () => {if (this.inFlight === operation) this.inFlight = undefined;});
    return operation;
  }
  start(): void {if (!this.running) {this.running = true; this.tick();}}
  async stop(): Promise<void> {
    this.running = false; this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    await this.inFlight?.catch(() => {});
  }
  private resetAt(): number {
    const reset = this.client.cooldownUntil;
    if (Number.isFinite(reset) && reset > 0 && reset <= 8.64e15) this.cooldown = Math.max(this.cooldown, reset);
    return this.cooldown;
  }
  private tick(): void {
    if (!this.running) return;
    const generation = this.generation;
    void this.runOnce().catch(() => {}).finally(() => {
      if (!this.running || generation !== this.generation) return;
      this.timer = setTimeout(() => this.tick(), Math.min(2_147_483_647,
        Math.max(this.interval, this.resetAt() - this.now().getTime()))); this.timer.unref();
    });
  }

  private cursorState(): WalletObserverCursorState {
    return {version: 1, chains: [...this.chains], cursor: this.cursor, rank: [...this.rankCursor], market: [...this.marketCursor],
      associationRounds: [...this.associationRounds], wallets: [...this.walletCursor], associations: [...this.associationCursor],
      walletChecks: [...this.walletChecks], ...(this.pendingByChain.size ? {pending: structuredClone([...this.pendingByChain.values()])} : {})};
  }
  private restoreCursor(state: WalletObserverCursorState): void {
    this.cursor = state.cursor; this.rankCursor = new Map(state.rank); this.marketCursor = new Map(state.market);
    this.associationRounds = new Map(state.associationRounds); this.walletCursor = new Map(state.wallets);
    this.associationCursor = new Map(state.associations); this.walletChecks = new Map(state.walletChecks);
    this.pendingByChain = new Map((state.pending ?? []).map(value => [value.chain, value]));
    this.pending = this.pendingByChain.get(this.chains[this.cursor % this.chains.length]);
  }
  private saveCursor(state: WalletObserverCursorState): void {
    try {
      if (this.history.setWalletObserverCursor?.(state) === false) throw new Error('WALLET_OBSERVER_CURSOR_WRITE_FAILED');
      this.cursorError = undefined;
    } catch {this.cursorError = 'WALLET_OBSERVER_CURSOR_WRITE_FAILED'; throw new Error(this.cursorError);}
  }
  private retainPending(pending: WalletObserverPending): void {
    this.pending = pending; this.pendingByChain.set(pending.chain, pending);
    // Before the next asynchronous read, freeze the unfinished target without
    // committing any counters staged by this cycle.
    if (this.checkpoint) this.saveCursor({...this.checkpoint, pending: structuredClone([...this.pendingByChain.values()])});
  }
  private async execute(generation: number): Promise<WalletObserverCycle> {
    const checkpoint = this.cursorState(); this.checkpoint = checkpoint;
    this.pending = this.pendingByChain.get(this.chains[this.cursor % this.chains.length]);
    const report = await this.executeCycle(generation);
    const retry = generation !== this.generation || report.status === 'cooldown' || report.reasons.some(value =>
      /(?:_FAILED|_TIMEOUT|_MISSING|_ABORTED|_BUDGET_REACHED|_SCHEMA_INVALID)$/.test(value));
    if (retry) {
      const unfinished = new Map(this.pendingByChain); this.restoreCursor(checkpoint); this.pendingByChain = unfinished;
      // A failed chain keeps its target, but cannot monopolize the scheduler.
      // Shared cooldown with no request and cancelled cycles do not consume a turn.
      if (generation === this.generation && report.requests > 0) {
        this.cursor = checkpoint.cursor + 1;
        try {this.saveCursor(this.cursorState());}
        catch {this.cursor = checkpoint.cursor; if (!report.reasons.includes('WALLET_OBSERVER_CURSOR_WRITE_FAILED')) report.reasons.push('WALLET_OBSERVER_CURSOR_WRITE_FAILED');}
      }
    } else {
      const completedPending = this.pending;
      try {
        if (this.pending) {
          this.history.markTargetChecked(this.pending, this.now().toISOString());
          if (this.pending.kind === 'association') this.history.markAssociationTargetChecked?.(this.pending as AssociationTarget, this.now().toISOString());
        }
        this.pendingByChain.delete(report.chain); this.pending = undefined; this.saveCursor(this.cursorState());
      } catch {
        this.restoreCursor(checkpoint);
        if (completedPending) this.pendingByChain.set(report.chain, completedPending);
        this.cursorError = 'WALLET_OBSERVER_CURSOR_WRITE_FAILED';
        if (!report.reasons.includes(this.cursorError)) report.reasons.push(this.cursorError);
      }
    }
    this.checkpoint = undefined;
    return this.finish(report, generation);
  }
  private async executeCycle(generation: number): Promise<WalletObserverCycle> {
    const turn = this.cursor++, chain = this.chains[turn % this.chains.length], startedAt = this.now().toISOString();
    const associationTurn = Math.floor(turn / this.chains.length) % 2 === 0;
    const marketTurn = this.marketCursor.get(chain) ?? 0, preferRank = marketTurn % 2 === 0;
    const report: WalletObserverCycle = {chain, startedAt, completedAt: startedAt, status: 'ok', requests: 0,
      accepted: 0, reasons: [], coverage: 'one_page_sample', collectionMode: 'market_wallets'};
    const reason = (value: string) => {if (!report.reasons.includes(value)) report.reasons.push(value);};
    let halted = false;
    const request = async (path: string, query: Record<string, string | number>, weight?: number): Promise<unknown> => {
      if (generation !== this.generation || halted) throw new ObserverHalt();
      if (this.resetAt() > this.now().getTime()) {report.status = 'cooldown'; reason('GMGN_RATE_LIMITED'); halted = true; throw new ObserverHalt();}
      if (report.requests >= this.maxRequests) {reason('WALLET_REQUEST_BUDGET_REACHED'); halted = true; throw new ObserverHalt();}
      try {report.requests++; const raw = await this.client.get(path, query, weight);
        if (generation !== this.generation) throw new ObserverHalt();
        if (path === '/v1/market/rank' && object(raw) && (raw.code === 429 || raw.code === '429' ||
            ['RATE_LIMIT_EXCEEDED', 'RATE_LIMIT_BANNED', 'ERROR_RATE_LIMIT_BLOCKED'].includes(String(raw.error)))) {
          // A nested service error must participate in the same shared cooldown.
          this.client.recordRateLimit?.(new Headers(), raw);
          const reset = typeof raw.reset_at === 'number' || typeof raw.reset_at === 'string' && /^\d+(?:\.\d+)?$/.test(raw.reset_at)
            ? Number(raw.reset_at) * 1000 : NaN;
          const until = Number.isFinite(reset) && reset > this.now().getTime() && reset <= 8.64e15 ? reset : this.now().getTime() + 60_000;
          throw new GmgnError('GMGN_RATE_LIMITED', Math.max(this.resetAt(), until), this.now().getTime());
        }
        return raw;
      } catch (error) {
        if (error instanceof ObserverHalt) throw error;
        const code = error instanceof GmgnError ? error.reason : 'GMGN_REQUEST_FAILED'; reason(code);
        if (code === 'GMGN_RATE_LIMITED') {
          const until = error instanceof GmgnError && error.cooldownUntil ? Date.parse(error.cooldownUntil) : NaN;
          this.cooldown = Math.max(this.cooldown, Number.isFinite(until) && until > this.now().getTime() ? until : this.now().getTime() + 60_000);
          report.status = 'cooldown'; halted = true;
        }
        if (code === 'GMGN_AUTH_FAILED' || code === 'GMGN_API_KEY_MISSING') halted = true;
        throw error;
      }
    };
    const attempt = async (path: string, query: Record<string, string | number>, weight?: number) => {
      try {return await request(path, query, weight);} catch {return undefined;}
    };
    let target: Token | undefined;
    try {
      // One existing market turn can research one imported lead. The list is
      // not a smart/KOL classification, does not emit a signal, and never adds
      // requests above the observer budget or interrupts an unfinished target.
      // Cursor is persisted across restarts, including failed requested turns.
      // Reserve the other market round for ordinary discovery even if every
      // external query fails or the configured interval is very long.
      const seedTurn=Math.floor(turn/this.chains.length)%4===3;
      const seed=seedTurn&&!this.pending?this.history.researchSeedTarget?.(chain):undefined;
      if(seed&&seed.chain===chain&&address(seed.address,chain)&&chain!=='solana'){
        report.collectionMode='external_seed_research';
        const raw=await attempt('/v1/user/wallet_activity',{chain:apiChain(chain),wallet_address:seed.address,limit:100},3);
        if(generation!==this.generation)throw new ObserverHalt();
        const observedAt=this.now().toISOString(),parsed=raw===undefined?undefined:
          normalizeWalletActivity(raw,chain,seed.address,observedAt,undefined,'gmgn_research_seed_activity');
        const invalidReason=parsed?.invalidReason??(parsed?.rejected?'WALLET_ACTIVITY_ROWS_INVALID':undefined)??
          (raw===undefined?report.reasons.at(-1)??'GMGN_REQUEST_FAILED':undefined);
        if(parsed){this.history.recordTrades(parsed.trades);report.accepted+=parsed.trades.length;}
        if(invalidReason)reason(invalidReason);
        const status=raw===undefined?'unavailable' as const:invalidReason?'partial' as const:'ok' as const;
        if(report.requests>0)this.history.markResearchSeedChecked?.({...seed,status,accepted:parsed?.trades.length??0,reason:invalidReason});
        this.history.recordCollection({source:'gmgn_research_seed_activity',chain,startedAt,completedAt:observedAt,
          status:invalidReason?'partial':'ok',requests:report.requests,accepted:parsed?.trades.length??0,rejected:parsed?.rejected,
          coverage:'one_page_sample',hasMore:parsed?.hasMore,reason:invalidReason});
        return report;
      }
      // Public KOL activity is an investigation anchor, not an endorsement. In
      // alternating rounds query past traders too, including untagged/exited
      // wallets, then verify their actual transactions before any inference.
      let anchors: AssociationTarget[] = [];
      if (associationTurn && this.pending?.kind !== 'market') {
        const round = this.associationRounds.get(chain) ?? 0;
        const mode = round % 3 === 2 ? 'known' : 'recent';
        anchors = this.history.associationTargets?.(chain, 5, mode) ?? [];
        if (mode === 'known' && !anchors.length) anchors = this.history.associationTargets?.(chain, 5, 'recent') ?? [];
      }
      const anchor = this.pending?.kind === 'association' && this.pending.chain === chain ? this.pending as AssociationTarget : anchors.find(value => {
        const historical = value.historicalRelationship === true;
        const candidate = address(value.candidateWallet, chain), leader = address(value.anchorWallet, chain);
        return value.chain === chain && address(value.address, chain) && leader &&
          Number.isFinite(Date.parse(value.anchorEventAt)) && Date.parse(value.anchorEventAt) <= this.now().getTime() &&
          (!historical || !!candidate && candidate !== leader) &&
          (historical || Date.parse(value.anchorEventAt) >= this.now().getTime() - 86_400_000);
      });
      if (anchor) {
        this.associationRounds.set(chain, (this.associationRounds.get(chain) ?? 0) + 1);
        report.collectionMode = 'kol_association'; target = {chain, address: anchor.address};
        this.retainPending({...anchor, kind: 'association', ...(this.pending?.wallets ? {wallets: this.pending.wallets} : {})});
        await this.collectAssociation(anchor, report, attempt, reason, generation);
        return report;
      }
      this.marketCursor.set(chain, marketTurn + 1);
      let rankedTargets: Token[] = [];
      const rankResponse = await attempt('/v1/market/rank', {chain: apiChain(chain), interval: '1h', order_by: 'change1h', direction: 'desc', limit: 20}, 3);
      const ranked = rankPayload(rankResponse, chain);
      if (object(ranked) && matchesChain(ranked, chain) && Array.isArray(ranked.rank)) {
        const ranks = ranked.rank.slice(0, 20).flatMap((row, index) => {
          if (!object(row) || !matchesChain(row, chain)) return [];
          const ca = address(row.address, chain); if (!ca) return [];
          const price = decimal(row.price), priceUsd = price !== null ? Number(price) : NaN;
          return [{address: ca, rank: index + 1, interval: '1h' as const, changeMetric: decimal(row.price_change_percent1h, true),
            changeUnit: 'vendor_unspecified' as const, ...(Number.isFinite(priceUsd) && priceUsd > 0 ? {priceUsd} : {})}];
        });
        if (ranks.length !== Math.min(ranked.rank.length, 20)) reason('GMGN_RANK_ROWS_INVALID');
        this.history.captureTokenRanks(chain, ranks, {source: 'gmgn_change1h_rank', observedAt: this.now().toISOString()});
        rankedTargets = ranks.map(row => ({chain, address: row.address}));
        report.accepted += ranks.length;
      } else if (!halted && generation === this.generation) reason('GMGN_RANK_SCHEMA_INVALID');
      if (halted || generation !== this.generation) throw new ObserverHalt();
      const oldest = this.history.watchTargets(200, this.now(), chain).find(token => token.chain === chain && address(token.address, chain));
      if (rankedTargets.length && (preferRank || !oldest)) {
        const rankIndex = this.rankCursor.get(chain) ?? 0;
        target = rankedTargets[rankIndex % rankedTargets.length]; this.rankCursor.set(chain, rankIndex + 1);
      } else target = oldest;
      if (this.pending?.kind === 'market' && this.pending.chain === chain) target = this.pending;
      if (!target) return report;
      target = {chain, address: address(target.address, chain)!};
      this.retainPending({...target, kind: 'market', ...(this.pending?.wallets ? {wallets: this.pending.wallets} : {})});
      const targetKey = `${chain}:${target.address}`, offset = this.walletCursor.get(targetKey) ?? 0;
      const traderSort = TRADER_SORTS[offset % TRADER_SORTS.length], earlyTurn = offset % 2 === 1;
      const tradersRaw = await attempt('/v1/market/token_top_traders', {chain: apiChain(chain), address: target.address,
        order_by: traderSort, direction: 'desc', limit: 100}, 5);
      let traders: (WalletTokenTraderObservation & {researchCandidate: boolean})[] = [];
      if (object(tradersRaw) && matchesChain(tradersRaw, chain) && Array.isArray(tradersRaw.list) &&
          (tradersRaw.token_address === undefined || address(tradersRaw.token_address, chain) === target.address) &&
          (tradersRaw.address === undefined || address(tradersRaw.address, chain) === target.address)) {
        const observedAt = this.now().toISOString();
        traders = tradersRaw.list.slice(0, 100).flatMap((row, index) => {
          const normalized = traderRow(row, target!, index + 1, observedAt, traderSort, 100); return normalized ? [normalized] : [];
        });
        if (traders.length !== Math.min(tradersRaw.list.length, 100)) reason('GMGN_TRADERS_ROWS_INVALID');
        this.history.captureTokenTraders(target, traders, {source: `gmgn_token_${traderSort === 'profit' ? 'profit' : traderSort}_rank`, observedAt});
        report.accepted += traders.length;
      } else if (!halted && generation === this.generation) reason('GMGN_TRADERS_SCHEMA_INVALID');
      const info = await attempt('/v1/token/info', {chain: apiChain(chain), address: target.address}, 1);
      if (object(info) && matchesChain(info, chain) && address(info.address, chain) === target.address) {
        const price = object(info.price) ? decimal(info.price.price) : null;
        if (price !== null && Number.isFinite(Number(price)) && Number(price) > 0)
          this.history.recordPrice(target, Number(price), this.now().toISOString(), 'gmgn_token_info_sample');
        const signal: Signal = {source: 'gmgn', sourceEventId: 'wallet-observer', occurredAt: this.now().toISOString(),
          token: target, text: '', evidenceUrls: [], claim: 'unspecified'};
        const scopedClient = {get: request} as unknown as GmgnClient;
        const analysis = await analyzeWallets(signal, info, scopedClient, {maxWallets: 1, now: this.now});
        if (generation !== this.generation) throw new ObserverHalt();
        if (analysis.status !== 'pass') reason('WALLET_ANALYSIS_PARTIAL');
        // Store projects the normalized analysis; never persist facts.rawResponses.
        this.history.captureAnalysis(target, analysis, {source: 'gmgn_wallet_observer', observedAt: this.now().toISOString()});
      } else if (!halted && generation === this.generation) reason('GMGN_TOKEN_INFO_SCHEMA_INVALID');
      if (halted || generation !== this.generation) throw new ObserverHalt();
      const candidates = traders.filter(row => row.researchCandidate).sort((a, b) => {
        const checked = (row: WalletTokenTraderObservation) => this.walletChecks.get(`${targetKey}:${row.address}`) ?? -1;
        return checked(a) - checked(b) || (earlyTurn ? (a.firstAcquiredAt ?? 'z').localeCompare(b.firstAcquiredAt ?? 'z') : 0) || a.rank - b.rank;
      });
      const wallet = this.pending?.wallets?.[0] ?? candidates[0]?.address;
      if (wallet) {
        this.retainPending({...target, kind: 'market', wallets: [wallet]});
        this.walletCursor.delete(targetKey); this.walletCursor.set(targetKey, offset + 1);
        if (this.walletCursor.size > 200) this.walletCursor.delete(this.walletCursor.keys().next().value!);
        const checkKey = `${targetKey}:${wallet}`;
        this.walletChecks.delete(checkKey); this.walletChecks.set(checkKey, this.cursor);
        if (this.walletChecks.size > 2_000) this.walletChecks.delete(this.walletChecks.keys().next().value!);
        const activity = await attempt('/v1/user/wallet_activity', {chain: apiChain(chain), wallet_address: wallet,
          ...(earlyTurn ? {token_address: target.address} : {}), limit: earlyTurn ? 100 : 20}, 3);
        if (activity !== undefined) {
          const observedAt = this.now().toISOString(), parsed = normalizeWalletActivity(activity, chain, wallet, observedAt,
            earlyTurn ? target.address : undefined, earlyTurn ? 'gmgn_early_candidate_activity' : 'gmgn_wallet_activity');
          this.history.recordTrades(parsed.trades); report.accepted += parsed.trades.length;
          if (parsed.invalidReason) reason(parsed.invalidReason);
          else if (parsed.rejected) reason('WALLET_ACTIVITY_ROWS_INVALID');
          this.history.recordCollection({source: 'gmgn_wallet_activity', chain, startedAt, completedAt: observedAt,
            status: parsed.invalidReason || parsed.rejected ? 'partial' : 'ok', requests: 1, accepted: parsed.trades.length, rejected: parsed.rejected,
            coverage: 'one_page_sample', hasMore: parsed.hasMore, reason: parsed.invalidReason});
        }
        const stats = await attempt('/v1/user/wallet_stats', {chain: apiChain(chain), wallet_address: wallet, period: '7d'}, 3);
        if (object(stats) && walletResponseMatches(stats, chain, wallet)) {
          const win = decimal(stats.winrate ?? (object(stats.pnl_stat) ? stats.pnl_stat.winrate : undefined));
          this.history.captureLeaders(chain, [{address: wallet, period: '7d', realizedProfitUsd: decimal(stats.realized_profit, true),
            winRate: win !== null && Number(win) <= 1 ? Number(win) : null,
            labels: object(stats.common) ? labels(stats.common.tags) : []}],
          {source: 'gmgn_wallet_stats_7d', observedAt: this.now().toISOString()});
        } else if (!halted && generation === this.generation) reason('GMGN_WALLET_STATS_SCHEMA_INVALID');
      }
    } catch (error) {if (!(error instanceof ObserverHalt)) reason('WALLET_HISTORY_WRITE_FAILED');}
    return report;
  }

  private async collectAssociation(anchor: AssociationTarget, report: WalletObserverCycle, request: ReadRequest,
    reason: (value: string) => void, generation: number): Promise<void> {
    const {chain} = anchor, target: Token = {chain, address: anchor.address};
    const active = () => {if (generation !== this.generation) throw new ObserverHalt();};
    const candidates = new Map<string, {wallet: string; firstAcquiredAt?: string}>();
    // GMGN's documented API has no token-wide transaction-history route.
    // These two top-trader pages are explicitly bounded discovery samples;
    // rank, zero current holdings, and firstAcquiredAt never prove an early buy.
    // Existing relationships outlive their original token. Spend these rounds
    // on current wallet activity instead of repeatedly researching a stale coin.
    const discoverySorts: ('sell_volume_cur' | 'buy_volume_cur')[] = anchor.historicalRelationship ? [] : ['sell_volume_cur', 'buy_volume_cur'];
    for (const sort of discoverySorts) {
      const raw = await request('/v1/market/token_top_traders', {chain: apiChain(chain), address: target.address,
        order_by: sort, direction: 'desc', limit: 100}, 5);
      active();
      if (raw === undefined) continue;
      const source = sort === 'sell_volume_cur' ? 'gmgn_association_trader_sell_volume' : 'gmgn_association_trader_buy_volume';
      const observedAt = this.now().toISOString();
      let rejected = 0;
      const valid = object(raw) && matchesChain(raw, chain) && Array.isArray(raw.list) &&
        (raw.token_address === undefined || address(raw.token_address, chain) === target.address) &&
        (raw.address === undefined || address(raw.address, chain) === target.address);
      const rows = valid ? (raw.list as unknown[]).slice(0, 100) : [];
      const traders = rows.flatMap((row, index) => {
        const normalized = traderRow(row, target, index + 1, observedAt, sort, 100);
        if (!normalized || !object(row)) {rejected++; return [];}
        const wallet = normalized.address;
        if (wallet !== anchor.anchorWallet && normalized.researchCandidate)
          candidates.set(wallet, {wallet, firstAcquiredAt: normalized.firstAcquiredAt});
        if (object(row.native_transfer)) this.captureFunding(target, wallet, row.native_transfer, observedAt, 'native_transfer');
        return [normalized];
      });
      if (valid) rejected += Math.max(0, (raw.list as unknown[]).length - 100);
      this.history.captureTokenTraders(target, traders, {source, observedAt}); report.accepted += traders.length;
      const invalidReason = !valid ? 'GMGN_ASSOCIATION_TRADERS_SCHEMA_INVALID' : rejected ? 'GMGN_ASSOCIATION_TRADERS_ROWS_INVALID' : undefined;
      if (invalidReason) reason(invalidReason);
      this.history.recordCollection({source, chain, startedAt: report.startedAt, completedAt: observedAt,
        status: invalidReason ? 'partial' : 'ok', requests: 1, accepted: traders.length, rejected,
        coverage: 'one_page_sample', hasMore: valid ? hasMore(raw) : null, reason: invalidReason});
    }
    if (!anchor.historicalRelationship) {
      const info = await request('/v1/token/info', {chain: apiChain(chain), address: target.address}, 1);
      active();
      if (object(info) && matchesChain(info, chain) && address(info.address, chain) === target.address) {
        const price = object(info.price) ? decimal(info.price.price) : null;
        if (price !== null && Number.isFinite(Number(price)) && Number(price) > 0)
          this.history.recordPrice(target, Number(price), this.now().toISOString(), 'gmgn_token_info_sample');
      } else if (info !== undefined) reason('GMGN_TOKEN_INFO_SCHEMA_INVALID');
    }

    const key = `${chain}:${target.address}:${anchor.anchorWallet}`, offset = this.associationCursor.get(key) ?? 0;
    const ranked = [...candidates.values()].sort((a, b) => {
      const earlierA = a.firstAcquiredAt && a.firstAcquiredAt < anchor.anchorEventAt ? 0 : 1;
      const earlierB = b.firstAcquiredAt && b.firstAcquiredAt < anchor.anchorEventAt ? 0 : 1;
      return earlierA - earlierB || (a.firstAcquiredAt ?? 'z').localeCompare(b.firstAcquiredAt ?? 'z') || a.wallet.localeCompare(b.wallet);
    });
    // A previously discovered earlier buyer gets one slot; the second rotates
    // over all sampled candidates so rank position cannot monopolize research.
    const selected: string[] = [];
    const previous = address(anchor.candidateWallet, chain);
    if (previous && previous !== anchor.anchorWallet) selected.push(previous);
    for (let i = 0; i < ranked.length && selected.length < 2; i++) {
      const wallet = ranked[(offset + i) % ranked.length].wallet;
      if (!selected.includes(wallet)) selected.push(wallet);
    }
    this.associationCursor.delete(key); this.associationCursor.set(key, offset + Math.max(1, selected.length));
    if (this.associationCursor.size > 200) this.associationCursor.delete(this.associationCursor.keys().next().value!);
    const wallets = this.pending?.wallets ?? (anchor.historicalRelationship ? [...selected, anchor.anchorWallet] : [anchor.anchorWallet, ...selected]);
    this.retainPending({...anchor, kind: 'association', wallets});
    for (const wallet of wallets) {
      // Once a candidate relation exists, observing its whole-wallet page can
      // discover a new token before a future public KOL buy. Keeping a token
      // filter here forever would only backfill the original episode.
      const followKnownCandidate = previous === wallet;
      const wholeWallet = followKnownCandidate || anchor.historicalRelationship === true;
      const raw = await request('/v1/user/wallet_activity', {chain: apiChain(chain), wallet_address: wallet,
        ...(wholeWallet ? {} : {token_address: target.address}), limit: 100}, 3);
      active();
      if (raw !== undefined) {
        const observedAt = this.now().toISOString(), source = followKnownCandidate ? 'gmgn_association_candidate_activity'
          : anchor.historicalRelationship ? 'gmgn_association_leader_activity' : 'gmgn_association_wallet_activity';
        const parsed = normalizeWalletActivity(raw, chain, wallet, observedAt, wholeWallet ? undefined : target.address, source);
        this.history.recordTrades(parsed.trades); report.accepted += parsed.trades.length;
        const invalidReason = parsed.invalidReason ?? (parsed.rejected ? 'WALLET_ACTIVITY_ROWS_INVALID' : undefined);
        if (invalidReason) reason(invalidReason);
        this.history.recordCollection({source, chain, startedAt: report.startedAt, completedAt: observedAt,
          status: invalidReason ? 'partial' : 'ok', requests: 1, accepted: parsed.trades.length, rejected: parsed.rejected,
          coverage: 'one_page_sample', hasMore: parsed.hasMore, reason: invalidReason});
      }
      const stats = await request('/v1/user/wallet_stats', {chain: apiChain(chain), wallet_address: wallet, period: '7d'}, 3);
      active();
      if (object(stats) && walletResponseMatches(stats, chain, wallet)) {
        const observedAt = this.now().toISOString(), common = object(stats.common) ? stats.common : {};
        const win = decimal(stats.winrate ?? (object(stats.pnl_stat) ? stats.pnl_stat.winrate : undefined));
        this.history.captureLeaders(chain, [{address: wallet, period: '7d', realizedProfitUsd: decimal(stats.realized_profit, true),
          winRate: win !== null && Number(win) <= 1 ? Number(win) : null, labels: labels(common.tags),
          ...(typeof common.name === 'string' ? {name: common.name} : {}),
          ...(typeof common.twitter_username === 'string' ? {twitter: common.twitter_username} : {})}],
        {source: 'gmgn_association_stats_7d', observedAt});
        this.captureFunding(target, wallet, common, observedAt, 'wallet_stats');
      } else if (stats !== undefined) reason('GMGN_WALLET_STATS_SCHEMA_INVALID');
    }
  }

  private captureFunding(target: Token, wallet: string, raw: Obj, observedAt: string,
    kind: 'native_transfer' | 'wallet_stats'): void {
    if (!matchesChain(raw, target.chain)) return;
    const first = kind === 'native_transfer' ? raw.from_address ?? raw.address : raw.fund_from_address;
    const fundingAddress = address(first, target.chain); if (!fundingAddress) return;
    const label = kind === 'native_transfer' ? raw.name : raw.fund_from;
    const conflictingAliases = kind === 'native_transfer' && raw.from_address !== undefined && raw.address !== undefined &&
      address(raw.from_address, target.chain) !== address(raw.address, target.chain);
    const sharedService = typeof label === 'string' &&
      /(?:exchange|binance|coinbase|okx|kraken|bybit|kucoin|gate\.io|mexc|bitget|htx|huobi|bridge|跨链|交易所)/i.test(label);
    this.history.captureFunding?.(target, wallet, {address: fundingAddress,
      label: typeof label === 'string' ? label : null, sharedService, conflict: conflictingAliases,
      amount: decimal(kind === 'native_transfer' ? raw.amount : raw.fund_amount),
      // Stats documents a source address/amount but no funding transaction ID.
      timestamp: kind === 'native_transfer' ? eventTime(raw.timestamp, observedAt) ?? null : null,
      txHash: kind === 'native_transfer' ? address(raw.tx_hash, target.chain, true) ?? null : null},
    {source: kind === 'native_transfer' ? 'gmgn_association_trader_funding' : 'gmgn_association_wallet_funding', observedAt});
  }

  private finish(report: WalletObserverCycle, generation: number): WalletObserverCycle {
    report.completedAt = this.now().toISOString();
    if (generation !== this.generation) report.status = 'stopped';
    else if (report.status === 'ok' && report.reasons.length) report.status = 'partial';
    // Coordination contains graph joins over the growing wallet corpus. The
    // dedicated WalletIndexRunner owns that work in a worker thread; doing it
    // here after a vendor response stalls the HTTP, signal and Telegram loop.
    try {this.history.recordCollection({...report, source: 'gmgn_wallet_observer', reason: report.reasons[0]});}
    catch {if (!report.reasons.includes('WALLET_HISTORY_WRITE_FAILED')) report.reasons.push('WALLET_HISTORY_WRITE_FAILED'); if (report.status === 'ok') report.status = 'partial';}
    return report;
  }
}
