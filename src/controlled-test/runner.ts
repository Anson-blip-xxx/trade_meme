import {randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import {inspectTestQuote} from '../trade-interface-check.js';
import {assessExitStrategy, type ExpectedExitStrategy} from '../exit-tracking.js';
import type {TestChainReader, TestJournal, TestNotifier, TestOperationKey, TestRun, TestTradeClient, VerifiedSolanaTransaction} from './types.js';

export const TEST_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
export const TEST_INPUT = 'So11111111111111111111111111111111111111112';
export const TEST_AMOUNT = '10000000'; // Exactly 0.01 SOL, fixed by the owner.
export const TEST_MAX_DEBIT = '20000000'; // Principal plus reserved rent/network costs, checked before writes.
export const TEST_CONDITIONS = [
  {order_type: 'profit_stop' as const, side: 'sell' as const, price_scale: '100', sell_ratio: '50'},
  {order_type: 'loss_stop' as const, side: 'sell' as const, price_scale: '60', sell_ratio: '100'},
];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const uint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v);
const address = (v: string) => {try {return bs58.decode(v).length === 32;} catch {return false;}};
const hash = (v: unknown): v is string => {try {return typeof v === 'string' && bs58.decode(v).length === 64;} catch {return false;}};
function childrenFingerprint(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 2 || value.some(c => !object(c) || !id(c.cid)) ||
      new Set(value.map(c => c.cid)).size !== value.length) return;
  return JSON.stringify(value.map(c => ({cid: c.cid, order_type: c.order_type, side: c.side,
    price_scale: String(c.price_scale), sell_ratio: String(c.sell_ratio)})).sort((a, b) => a.cid.localeCompare(b.cid)));
}
class TestFailure extends Error {constructor(readonly reason: string) {super(reason);}}
function fail(code: string): never {throw new TestFailure(code);}

export function newTestRun(wallet: string, mint = TEST_MINT, now = new Date()): TestRun {
  if (!address(wallet) || !address(mint) || wallet === mint || mint === TEST_INPUT) fail('TEST_IDENTITY_INVALID');
  return {id: randomUUID(), wallet, mint, amountLamports: TEST_AMOUNT, maxDebitLamports: TEST_MAX_DEBIT,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), phase: 'created', reasons: [],
    automaticTriggerVerified: false, notificationKeys: []};
}
export interface ControlledRunnerOptions {
  journal: TestJournal; client: TestTradeClient; chain: TestChainReader; notifier: TestNotifier;
  sleep?: (ms: number) => Promise<void>; now?: () => Date; pollAttempts?: number;
}

/** Only the explicit operator CLI constructs this runner; it is never wired to the daemon. */
export class ControlledTradeRunner {
  private readonly owner = randomUUID();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly attempts: number;
  private run!: TestRun;
  constructor(private readonly o: ControlledRunnerOptions) {
    this.sleep = o.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = o.now ?? (() => new Date()); this.attempts = o.pollAttempts ?? 30;
    if (!Number.isInteger(this.attempts) || this.attempts < 1 || this.attempts > 60) fail('TEST_POLL_LIMIT_INVALID');
  }
  private save() {this.run.updatedAt = this.now().toISOString(); this.o.journal.save(this.run, this.owner);}
  private own() {this.o.journal.assertOwned(this.run.id, this.owner);}
  private async notify(stage: string, text: string, required = false) {
    const key = `controlled-trade:${this.run.id}:${stage}`;
    if (this.run.notificationKeys.includes(key)) return;
    try {
      await this.o.notifier.notify(key, ['【0.01 SOL 接口实测】', text,
        '链：Solana', `CA：${this.run.mint}`, `测试编号：${this.run.id}`].join('\n'));
      this.run.notificationKeys.push(key); this.save();
    } catch {
      if (required) fail('TEST_TELEGRAM_UNAVAILABLE_BEFORE_BUY');
      if (!this.run.reasons.includes('TEST_TELEGRAM_PENDING')) this.run.reasons.push('TEST_TELEGRAM_PENDING');
      this.save(); // Notification failure must not prevent cleanup of a confirmed buy.
    }
  }
  private expected(strategyId: string): ExpectedExitStrategy {
    return {strategyOrderId: strategyId, chain: 'solana', wallet: this.run.wallet, tokenAddress: this.run.mint,
      inputToken: TEST_INPUT, sellRatioType: 'hold_amount', openingTransactionHash: this.run.buy?.signature,
      policyConditions: TEST_CONDITIONS};
  }
  private async notifyClosed() {
    await this.notify('closed', `平仓成交已由链上 finalized 确认，目标代币余额为 0。\n随单保护核验：${this.run.strategyMatched ? '参数匹配' : '失败，已清理'}\n交易：https://solscan.io/tx/${this.run.sell!.signature}\n钱包 SOL 净变化（含手续费及账户租金）：${Number(this.run.netNativeLamports) / 1e9} SOL\n本次测试结束；自动触发成交未测试。`);
  }
  private async strategies(type: 'open' | 'history'): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [], seen = new Set<string>(); let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      this.own(); const raw = await this.o.client.strategies(this.run.wallet, this.run.mint, type, token);
      if (!object(raw) || !Array.isArray(raw.list) || raw.list.length > 100 || raw.list.some(row => !object(row)))
        fail('TEST_STRATEGY_PAGE_INVALID');
      for (const row of raw.list as Record<string, unknown>[]) {
        // A mismatched response is not an empty set for this wallet.
        if (row.chain !== 'sol' || row.wallet_address !== this.run.wallet || row.base_token !== this.run.mint || !id(row.order_id))
          fail('TEST_STRATEGY_IDENTITY_MISMATCH');
        if (seen.has(row.order_id)) fail('TEST_STRATEGY_DUPLICATE');
        seen.add(row.order_id); rows.push(row);
      }
      if (raw.next_page_token === '' || raw.next_page_token === undefined) return rows;
      if (typeof raw.next_page_token !== 'string' || raw.next_page_token.length > 4096 || raw.next_page_token === token)
        fail('TEST_STRATEGY_PAGE_INVALID');
      token = raw.next_page_token;
    }
    return fail('TEST_STRATEGY_PAGINATION_INCOMPLETE');
  }
  private async submit(key: TestOperationKey, body: Record<string, unknown>) {
    this.own(); const reservation = this.o.journal.beginOperation(this.run.id, key, body, this.owner);
    if (!reservation.created) return reservation.operation; // Never replay a previously reserved POST.
    try {
      this.own();
      const raw = key === 'cancel' ? await this.o.client.cancel(this.run.wallet, body.order_id as string, reservation.operation.clientId)
        : await this.o.client.swap(body, reservation.operation.clientId);
      this.o.journal.finishOperation(this.run.id, key, 'acknowledged', raw, this.owner);
    } catch {
      this.o.journal.finishOperation(this.run.id, key, 'unknown', null, this.owner);
    }
    return this.o.journal.operation(this.run.id, key)!;
  }
  private async quote(side: 'buy' | 'sell', amount: string) {
    const input = side === 'buy' ? TEST_INPUT : this.run.mint, output = side === 'buy' ? this.run.mint : TEST_INPUT;
    const raw = await this.o.client.quote({wallet: this.run.wallet, inputToken: input, outputToken: output, inputAmount: amount, slippagePct: 1});
    const result = inspectTestQuote(raw, {input, output, amount, slippage: 1});
    if (result.status !== 'available') return fail('TEST_EXECUTABLE_QUOTE_INVALID');
    return result;
  }
  private body(side: 'buy' | 'sell', amount: string, minimum: string): Record<string, unknown> {
    return {chain: 'sol', from_address: this.run.wallet, input_token: side === 'buy' ? TEST_INPUT : this.run.mint,
      output_token: side === 'buy' ? this.run.mint : TEST_INPUT, input_amount: amount, swap_mode: 'ExactIn',
      min_output_amount: minimum, slippage: 1, priority_fee: '0.00001', tip_fee: '0.00001', is_anti_mev: true,
      ...(side === 'buy' ? {condition_orders: TEST_CONDITIONS, sell_ratio_type: 'hold_amount'} : {})};
  }
  private async confirm(key: 'buy' | 'sell'): Promise<{fact: VerifiedSolanaTransaction; raw: Record<string, unknown>}> {
    const operation = this.o.journal.operation(this.run.id, key);
    if (!operation || !object(operation.response) || !id(operation.response.order_id)) return fail('TEST_SUBMISSION_UNKNOWN_NO_REPLAY');
    if (key === 'buy' && id(operation.response.strategy_order_id)) {
      if (this.run.strategyId && this.run.strategyId !== operation.response.strategy_order_id) fail('TEST_STRATEGY_ID_CHANGED');
      this.run.strategyId = operation.response.strategy_order_id; this.save();
    }
    const orderId = operation.response.order_id; let last = operation.response;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      this.own();
      try {
        const raw = await this.o.client.query(orderId);
        if (!object(raw) || raw.order_id !== orderId) fail('TEST_ORDER_ID_MISMATCH');
        last = raw;
        // The immutable submit response remains separate from the finalized chain facts.
        if (key === 'buy' && id(raw.strategy_order_id)) {
          if (this.run.strategyId && this.run.strategyId !== raw.strategy_order_id) fail('TEST_STRATEGY_ID_CHANGED');
          this.run.strategyId = raw.strategy_order_id; this.save();
        }
        if (['failed', 'expired'].includes(String(raw.status)) && raw.state !== 30) fail('TEST_TRADE_FAILED');
        const report = raw.report;
        if (object(report) && (report.input_token !== operation.body.input_token || report.output_token !== operation.body.output_token ||
          !uint(report.input_amount) || BigInt(report.input_amount) <= 0n || BigInt(report.input_amount) > BigInt(String(operation.body.input_amount)) ||
          !uint(report.output_amount) || BigInt(report.output_amount) <= 0n)) fail('TEST_FILL_IDENTITY_MISMATCH');
        const confirmed = raw.status === 'confirmed' && (raw.state === undefined || raw.state === 30) ||
          raw.status === 'successful' && raw.state === 30 && object(report);
        if (confirmed && hash(raw.hash)) {
          const fact = await this.o.chain.verifyTransaction({signature: raw.hash, wallet: this.run.wallet, mint: this.run.mint, side: key,
            ...(object(report) ? {expectedTokenAmount: String(key === 'buy' ? report.output_amount : report.input_amount)} : {}),
            maxNativeDebitLamports: key === 'buy' ? this.run.maxDebitLamports : '1000000'});
          if (key === 'buy' && (BigInt(fact.tokenDelta) < BigInt(String(operation.body.min_output_amount)) ||
              -BigInt(fact.nativeDelta) < BigInt(this.run.amountLamports))) fail('TEST_BUY_DELTA_MISMATCH');
          if (key === 'sell' && BigInt(fact.tokenDelta) !== -BigInt(String(operation.body.input_amount))) fail('TEST_SELL_DELTA_MISMATCH');
          return {fact, raw};
        }
      } catch (error) {
        if (error instanceof TestFailure) throw error;
        // RPC indexing / temporary status errors only cause further reads, never a second POST.
      }
      if (attempt + 1 < this.attempts) await this.sleep(2000);
    }
    if (id(last.strategy_order_id)) {this.run.strategyId = last.strategy_order_id; this.save();}
    return fail('TEST_CONFIRMATION_PENDING');
  }
  private async prepare() {
    const snap = await this.o.chain.snapshot(this.run.wallet, this.run.mint);
    if (snap.tokenAmount !== '0') fail('TEST_EXISTING_TOKEN_HOLDING');
    if (snap.mintAuthority !== null || snap.freezeAuthority !== null || snap.extensions.length) fail('TEST_MINT_AUTHORITY_OR_EXTENSION');
    if (BigInt(snap.nativeLamports) < BigInt(this.run.maxDebitLamports) + 1000000n) fail('TEST_NATIVE_BALANCE_TOO_LOW');
    if ((await this.strategies('open')).length) fail('TEST_EXISTING_STRATEGY');
    const buyQuote = await this.quote('buy', this.run.amountLamports);
    // A buy quote alone does not establish a sell route. This only checks the returned route, not a future fill.
    await this.quote('sell', buyQuote.outputAmount);
    const freshQuote = await this.quote('buy', this.run.amountLamports);
    const fresh = await this.o.chain.snapshot(this.run.wallet, this.run.mint);
    if (fresh.tokenAmount !== '0' || BigInt(fresh.nativeLamports) < BigInt(this.run.maxDebitLamports) + 1000000n)
      fail('TEST_PREFLIGHT_BALANCE_CHANGED');
    if (this.run.baseline && (this.run.baseline.nativeLamports !== fresh.nativeLamports || this.run.baseline.tokenAmount !== fresh.tokenAmount))
      fail('TEST_PREFLIGHT_BALANCE_CHANGED');
    this.run.baseline ??= fresh; this.run.phase = 'buy_pending'; this.save();
    await this.submit('buy', this.body('buy', this.run.amountLamports, freshQuote.minimumOutputAmount));
  }
  private async protection(buyRaw: Record<string, unknown>) {
    this.run.phase = 'verify_protection'; this.save();
    const parentId = id(buyRaw.strategy_order_id) ? buyRaw.strategy_order_id : this.run.strategyId;
    for (let attempt = 0; attempt < Math.min(this.attempts, 6); attempt++) {
      const open = await this.strategies('open');
      if (open.some(row => row.open_sign_hash !== this.run.buy!.signature)) fail('TEST_FOREIGN_STRATEGY_APPEARED');
      const rows = [...open, ...await this.strategies('history')];
      const matches = rows.filter(row => parentId ? row.order_id === parentId : row.open_sign_hash === this.run.buy!.signature);
      if (matches.length > 1) fail('TEST_STRATEGY_AMBIGUOUS');
      if (matches.length === 1) {
        const row = matches[0]; this.run.strategyId = String(row.order_id);
        const assessment = assessExitStrategy({list: [row]}, this.expected(this.run.strategyId), this.now());
        if (!assessment.found) fail('TEST_ATTACHED_STRATEGY_IDENTITY_MISMATCH');
        const fingerprint = childrenFingerprint(row.condition_orders);
        if (!fingerprint) fail('TEST_ATTACHED_CHILDREN_INCOMPLETE');
        this.run.strategyMatched = assessment.policyMatched;
        this.run.strategyChildStatuses = assessment.conditions.map(c => c.status);
        this.run.strategyChildrenFingerprint = fingerprint;
        if (!assessment.policyMatched) this.run.reasons.push('TEST_ATTACHED_POLICY_MISMATCH');
        this.save();
        await this.notify('protection', `随单止盈止损：${assessment.policyMatched ? '策略及两档参数已核对' : '参数不匹配，执行清理'}。\n策略单号：${this.run.strategyId}\n+100% 卖出剩余持仓 50%；-60% 卖出剩余持仓 100%。\n本次不等待价格触发，不宣称已验证自动触发成交。`);
        return;
      }
      if (attempt + 1 < Math.min(this.attempts, 6)) await this.sleep(2000);
    }
    // No documented consistency bound: an empty page does not rule out a late attached strategy.
    // Retain the bought amount and stop further writes until the same run can discover/cancel it.
    if (!parentId) fail('TEST_ATTACHED_STRATEGY_MISSING_UNVERIFIED');
    fail('TEST_STRATEGY_NOT_OBSERVED');
  }
  private async cancel() {
    if (!this.run.strategyId || this.run.strategyCanceled) return;
    this.run.phase = 'cancel_pending'; this.save();
    const existing = this.o.journal.operation(this.run.id, 'cancel');
    if (!existing) await this.submit('cancel', {chain: 'sol', from_address: this.run.wallet, order_id: this.run.strategyId});
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const open = await this.strategies('open');
      if (open.some(row => row.order_id !== this.run.strategyId)) fail('TEST_FOREIGN_STRATEGY_APPEARED');
      const rows = [...open, ...await this.strategies('history')];
      const matches = rows.filter(row => row.order_id === this.run.strategyId);
      if (matches.length === 1) {
        const row = matches[0];
        // A terminal parent is necessary but not sufficient: only canceled children allow our manual cleanup.
        const identity = row.chain === 'sol' && row.wallet_address === this.run.wallet && row.base_token === this.run.mint &&
          row.quote_token === TEST_INPUT && row.open_sign_hash === this.run.buy!.signature;
        if (!identity) fail('TEST_CANCEL_IDENTITY_MISMATCH');
        const children = row.condition_orders;
        if (!open.length && row.status === 'closed' && row.strategy_status === 'stopped' && Array.isArray(children) &&
            this.run.strategyChildrenFingerprint && childrenFingerprint(children) === this.run.strategyChildrenFingerprint &&
            children.every(c => object(c) && c.status === 'cancel' && id(c.cid)) &&
            !row.close_sign_hash && object(row.order_statistic) && row.order_statistic.success_sell_num === 0) {
          const first = await this.o.chain.snapshot(this.run.wallet, this.run.mint);
          await this.sleep(2000);
          const second = await this.o.chain.snapshot(this.run.wallet, this.run.mint);
          if (first.tokenAmount !== this.run.buy!.postTokenAmount || second.tokenAmount !== first.tokenAmount)
            fail('TEST_POSITION_CHANGED_DURING_CANCEL');
          if (this.o.journal.operation(this.run.id, 'cancel')!.state !== 'acknowledged')
            this.o.journal.finishOperation(this.run.id, 'cancel', 'acknowledged', {cancellationVerified: true, order_id: this.run.strategyId}, this.owner);
          this.run.strategyCanceled = true; this.save(); return;
        }
      }
      if (attempt + 1 < this.attempts) await this.sleep(2000);
    }
    fail('TEST_CANCEL_OR_INFLIGHT_SELL_UNVERIFIED');
  }
  private async closePosition() {
    if (this.o.journal.operation(this.run.id, 'sell')) {
      if (!this.run.sell) {this.run.sell = (await this.confirm('sell')).fact; this.save();} return;
    }
    if ((await this.strategies('open')).length) fail('TEST_STRATEGY_STILL_OPEN');
    const balance = await this.o.chain.snapshot(this.run.wallet, this.run.mint);
    if (balance.tokenAmount !== this.run.buy!.postTokenAmount || BigInt(balance.tokenAmount) !== BigInt(this.run.buy!.tokenDelta))
      fail('TEST_POSITION_CHANGED_BEFORE_SELL');
    if (BigInt(this.run.baseline!.nativeLamports) - BigInt(balance.nativeLamports) + 1000000n > BigInt(this.run.maxDebitLamports))
      fail('TEST_COST_BUDGET_EXCEEDED');
    const quote = await this.quote('sell', balance.tokenAmount);
    const current = await this.o.chain.snapshot(this.run.wallet, this.run.mint);
    if (current.tokenAmount !== balance.tokenAmount || BigInt(current.nativeLamports) < 1000000n) fail('TEST_POSITION_CHANGED_BEFORE_SELL');
    this.run.phase = 'sell_pending'; this.save();
    await this.submit('sell', this.body('sell', balance.tokenAmount, quote.minimumOutputAmount));
    this.run.sell = (await this.confirm('sell')).fact; this.save();
  }
  async execute(runId: string): Promise<TestRun> {
    const saved = this.o.journal.get(runId); if (!saved) return fail('TEST_RUN_NOT_FOUND');
    this.run = saved;
    if (saved.phase === 'preflight_failed') return saved;
    if (saved.amountLamports !== TEST_AMOUNT || saved.maxDebitLamports !== TEST_MAX_DEBIT || !address(saved.wallet) || !address(saved.mint))
      return fail('TEST_RUN_SETTINGS_INVALID');
    this.o.journal.acquireLease(runId, this.owner, 60000);
    const heartbeat = setInterval(() => {try {this.o.journal.renewLease(runId, this.owner, 60000);} catch {/* assertOwned gates each write. */}}, 10000);
    heartbeat.unref();
    try {
      if (this.run.phase === 'complete') {await this.notifyClosed(); return this.run;}
      await this.notify('start', '开始一次性测试：买入 0.01 SOL，随单附带止盈止损，核验后撤单并平仓。', !this.o.journal.operation(runId, 'buy'));
      if (!this.o.journal.operation(runId, 'buy')) await this.prepare();
      let buyRaw: Record<string, unknown>;
      if (!this.run.buy) {
        const confirmed = await this.confirm('buy'); this.run.buy = confirmed.fact; buyRaw = confirmed.raw;
        if (id(buyRaw.strategy_order_id)) this.run.strategyId = buyRaw.strategy_order_id;
        this.save();
      } else {
        const operation = this.o.journal.operation(runId, 'buy')!;
        if (!object(operation.response)) return fail('TEST_BUY_RECEIPT_MISSING');
        buyRaw = operation.response;
      }
      await this.notify('opened', `开仓成交已由链上 finalized 确认。\n委托买入：0.01 SOL\n收到代币原子量：${this.run.buy.tokenDelta}\n交易：https://solscan.io/tx/${this.run.buy.signature}`);
      if (this.run.strategyMatched === undefined) await this.protection(buyRaw);
      await this.cancel();
      await this.closePosition();
      const final = await this.o.chain.snapshot(this.run.wallet, this.run.mint);
      if (final.tokenAmount !== '0' || (await this.strategies('open')).length) fail('TEST_FINAL_POSITION_NOT_CLOSED');
      this.run.finalSnapshot = final;
      this.run.netNativeLamports = (BigInt(final.nativeLamports) - BigInt(this.run.baseline!.nativeLamports)).toString();
      this.run.phase = 'complete'; this.save();
      await this.notifyClosed();
      return this.run;
    } catch (error) {
      const reason = error instanceof TestFailure ? error.reason : 'TEST_READ_OR_STORAGE_FAILED';
      this.run.phase = this.o.journal.operation(runId, 'buy') ? 'needs_attention' : 'preflight_failed';
      if (!this.run.reasons.includes(reason)) this.run.reasons.push(reason);
      this.save();
      await this.notify(`attention-${reason}`, `测试未完成：${reason}。\n已买入：${!!this.run.buy}；已平仓：${!!this.run.sell}。\n结果不明的提交不会自动重发，检查本次记录后可用同一编号恢复查询。`);
      return this.run;
    } finally {clearInterval(heartbeat); try {this.o.journal.releaseLease(runId, this.owner);} catch {/* Lost ownership cannot be reclaimed here. */}}
  }
}
