import bs58 from 'bs58';
import {GmgnError, type GmgnClient} from './providers/gmgn-client.js';
import type {ScanArchive, ScanToken} from './scan-archive.js';
import type {Chain} from './types.js';

// Verified 2026-10-09 against GMGNAI/gmgn-skills commit
// 4575ef539e6a3115fa0481d41285cb79e77970bf/skills/gmgn-token/SKILL.md#L267-L272:
// token info's current USD price is the STRING at price.price. Window prices
// and ath_price describe earlier history and must never become our samples.
const GMGN_CHAINS: Record<Chain, string> = {bsc: 'bsc', solana: 'sol', robinhood: 'robinhood'};
const MAX_ACTIVE_TOKENS = 200;
const SOURCE = 'gmgn_token_info_sample';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (token: ScanToken) => `${token.chain}:${token.address}`;

export interface PriceTrackerOptions {
  archive: Pick<ScanArchive, 'pendingTokens' | 'recordPrice' | 'recordPriceError'>;
  client: Pick<GmgnClient, 'get' | 'cooldownUntil'>;
  intervalMs?: number;
  maxTokensPerCycle?: number;
  now?: () => Date;
}
export interface PriceTrackerCycle {
  status: 'ok' | 'partial' | 'cooldown' | 'stopped';
  startedAt: string;
  completedAt: string;
  activeTokens: number;
  requests: number;
  recorded: number;
  errors: number;
  deferred: number;
  reasons: string[];
  cooldownUntil?: string;
}
export interface PriceTrackerStatus {
  running: boolean;
  inFlight: boolean;
  intervalMs: number;
  maxTokensPerCycle: number;
  trackedTokens: number;
  cooldownUntil?: string;
  lastCycle?: PriceTrackerCycle;
}

function normalizeToken(value: unknown): ScanToken | undefined {
  if (!object(value) || typeof value.chain !== 'string' || !Object.hasOwn(GMGN_CHAINS, value.chain) ||
      typeof value.address !== 'string') return;
  const chain = value.chain as Chain;
  if (chain === 'solana') {
    if (value.address.length < 32 || value.address.length > 44) return;
    try {
      const bytes = bs58.decode(value.address);
      if (bytes.length !== 32 || !bytes.some(byte => byte !== 0)) return;
    } catch {return;}
    return {chain, address: value.address};
  }
  if (!/^0x[0-9a-f]{40}$/i.test(value.address) || /^0x0{40}$/i.test(value.address)) return;
  return {chain, address: value.address.toLowerCase()};
}

function priceFromInfo(raw: unknown, token: ScanToken): {priceUsd: number} | {reason: string} {
  if (!object(raw)) return {reason: 'PRICE_SCHEMA_INVALID'};
  const returned = normalizeToken({chain: token.chain, address: raw.address});
  if (!returned || returned.address !== token.address ||
      (Object.hasOwn(raw, 'chain') && raw.chain !== GMGN_CHAINS[token.chain])) return {reason: 'PRICE_TOKEN_MISMATCH'};
  if (!object(raw.price) || typeof raw.price.price !== 'string' || raw.price.price.length > 128 ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(raw.price.price)) return {reason: 'PRICE_SCHEMA_INVALID'};
  const priceUsd = Number(raw.price.price);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return {reason: 'PRICE_VALUE_INVALID'};
  return {priceUsd};
}

/** Backend-only observation loop; does not quote a trade, sign, or submit orders. */
export class PriceTracker {
  private readonly archive: PriceTrackerOptions['archive'];
  private readonly client: PriceTrackerOptions['client'];
  private readonly intervalMs: number;
  private readonly maxTokens: number;
  private readonly now: () => Date;
  private running = false;
  private generation = 0;
  private cooldownUntil = 0;
  private queue: ScanToken[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<PriceTrackerCycle>;
  private lastCycle?: PriceTrackerCycle;

  constructor(options: PriceTrackerOptions) {
    const interval = options.intervalMs ?? 60_000;
    const maxTokens = options.maxTokensPerCycle ?? 10;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 3_600_000 ||
        !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_ACTIVE_TOKENS)
      throw new Error('PRICE_TRACKER_CONFIG_INVALID');
    this.archive = options.archive; this.client = options.client;
    this.intervalMs = interval; this.maxTokens = maxTokens; this.now = options.now ?? (() => new Date());
  }

  getStatus(): PriceTrackerStatus {
    this.readCooldown();
    return {running: this.running, inFlight: !!this.inFlight, intervalMs: this.intervalMs,
      maxTokensPerCycle: this.maxTokens, trackedTokens: this.queue.length,
      ...(this.cooldownUntil > this.now().getTime() ? {cooldownUntil: new Date(this.cooldownUntil).toISOString()} : {}),
      ...(this.lastCycle ? {lastCycle: structuredClone(this.lastCycle)} : {})};
  }

  /** Concurrent callers join the same bounded cycle, rather than making duplicate GETs. */
  runOnce(): Promise<PriceTrackerCycle> {
    if (this.inFlight) return this.inFlight;
    const operation = this.execute(this.generation);
    this.inFlight = operation;
    void operation.then(cycle => {
      this.lastCycle = cycle;
      if (this.inFlight === operation) this.inFlight = undefined;
    }, () => {if (this.inFlight === operation) this.inFlight = undefined;});
    return operation;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  /** Runtime shutdown waits for the bounded shared-client GET and discards its late result. */
  async stop(): Promise<void> {
    this.running = false; this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => {});
  }

  private tick(): void {
    if (!this.running) return;
    const generation = this.generation;
    void this.runOnce().catch(() => {}).finally(() => {
      if (!this.running || generation !== this.generation) return;
      this.readCooldown();
      const wait = Math.max(this.intervalMs, this.cooldownUntil - this.now().getTime());
      this.timer = setTimeout(() => this.tick(), Math.min(wait, 2_147_483_647));
      this.timer.unref();
    });
  }

  private readCooldown(): void {
    const until = this.client.cooldownUntil;
    if (typeof until === 'number' && Number.isFinite(until) && until > 0 && until <= 8.64e15)
      this.cooldownUntil = Math.max(this.cooldownUntil, until);
  }

  private async execute(generation: number): Promise<PriceTrackerCycle> {
    const startedAt = this.now().toISOString();
    const report: PriceTrackerCycle = {status: 'ok', startedAt, completedAt: startedAt,
      activeTokens: 0, requests: 0, recorded: 0, errors: 0, deferred: 0, reasons: []};
    const reason = (value: string) => {if (!report.reasons.includes(value)) report.reasons.push(value);};
    const finish = () => {
      if (generation !== this.generation) report.status = 'stopped';
      else if (report.status === 'ok' && report.errors) report.status = 'partial';
      report.completedAt = this.now().toISOString();
      this.readCooldown();
      if (this.cooldownUntil > this.now().getTime()) report.cooldownUntil = new Date(this.cooldownUntil).toISOString();
      return report;
    };
    let active: ScanToken[];
    try {active = this.archive.pendingTokens(MAX_ACTIVE_TOKENS, this.now());}
    catch {report.errors++; reason('PRICE_ARCHIVE_UNAVAILABLE'); return finish();}
    const pending = new Map<string, ScanToken>();
    for (const raw of active.slice(0, MAX_ACTIVE_TOKENS)) {
      const token = normalizeToken(raw);
      if (token) pending.set(key(token), token);
      else {report.errors++; reason('PRICE_TOKEN_INVALID');}
    }
    // Preserve the unvisited portion of the ring when archive sorting changes.
    // Across the 200-token bound, archive's oldest-attempt order brings older tokens back in.
    this.queue = this.queue.filter(token => pending.has(key(token)));
    const queued = new Set(this.queue.map(key));
    for (const token of pending.values()) if (!queued.has(key(token))) this.queue.push(token);
    report.activeTokens = this.queue.length;
    const selected = this.queue.slice(0, this.maxTokens);
    report.deferred = this.queue.length - selected.length;
    const recordError = (token: ScanToken, code: string): boolean => {
      report.errors++; reason(code);
      try {this.archive.recordPriceError(token, code, this.now()); return true;}
      catch {reason('PRICE_ARCHIVE_WRITE_FAILED'); return false;}
    };
    for (let index = 0; index < selected.length; index++) {
      if (generation !== this.generation) {report.deferred += selected.length - index; break;}
      const token = selected[index];
      // Move each attempted/deferred token exactly once so a failing token cannot starve the ring.
      const position = this.queue.findIndex(candidate => key(candidate) === key(token));
      if (position >= 0) this.queue.push(...this.queue.splice(position, 1));
      this.readCooldown();
      if (this.cooldownUntil > this.now().getTime()) {
        report.status = 'cooldown'; report.deferred++;
        if (!recordError(token, 'GMGN_RATE_LIMITED')) {report.deferred += selected.length - index - 1; break;}
        continue;
      }
      const requestStartedAt = this.now().getTime();
      let data: unknown;
      try {
        report.requests++;
        data = await this.client.get('/v1/token/info', {chain: GMGN_CHAINS[token.chain], address: token.address}, 1);
      } catch (error) {
        if (generation !== this.generation) {report.deferred += selected.length - index; break;}
        const code = error instanceof GmgnError ? error.reason : 'GMGN_REQUEST_FAILED';
        if (code === 'GMGN_RATE_LIMITED') {
          const expiry = error instanceof GmgnError && error.cooldownUntil ? Date.parse(error.cooldownUntil) : NaN;
          this.cooldownUntil = Math.max(this.cooldownUntil,
            Number.isFinite(expiry) && expiry > this.now().getTime() ? expiry : this.now().getTime() + 60_000);
          report.status = 'cooldown';
        }
        if (!recordError(token, code)) {report.deferred += selected.length - index - 1; break;}
        if (code === 'GMGN_API_KEY_MISSING' || code === 'GMGN_AUTH_FAILED') {
          report.deferred += selected.length - index - 1; break;
        }
        continue;
      }
      if (generation !== this.generation) {report.deferred += selected.length - index; break;}
      const price = priceFromInfo(data, token);
      if ('reason' in price) {
        if (!recordError(token, price.reason)) {report.deferred += selected.length - index - 1; break;}
        continue;
      }
      const observedAt = this.now();
      if (observedAt.getTime() < requestStartedAt) {
        if (!recordError(token, 'PRICE_CLOCK_REGRESSED')) {report.deferred += selected.length - index - 1; break;}
        continue;
      }
      try {
        // Archive binds this completion-time sample to eligible candidates and sets
        // the first post-decision sample as baseline. No pre-signal price is fetched.
        this.archive.recordPrice({...token, priceUsd: price.priceUsd, observedAt: observedAt.toISOString(), source: SOURCE});
        report.recorded++;
      } catch {
        report.errors++; reason('PRICE_ARCHIVE_WRITE_FAILED');
        report.deferred += selected.length - index - 1; break;
      }
    }
    return finish();
  }
}
