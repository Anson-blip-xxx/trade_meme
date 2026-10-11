import {constants, createHash, createPrivateKey, randomUUID, sign, type KeyObject} from 'node:crypto';
import bs58 from 'bs58';
import type {Config} from './config.js';
import {OrderStore, type OpeningOrder, type OpeningStatus,type ExitTracking,type FundingSnapshot} from './orders.js';
import {parseSignal,narrativeIdentityConflict, type Check, type Report, type Chain} from './types.js';
import {GmgnClient, GmgnError} from './providers/gmgn-client.js';
import {buildExitConditions,parseExitPolicy} from './exit-policy.js';
import {assessExitStrategy} from './exit-tracking.js';
import {readPositionBalance} from './position-balance.js';
import {readNativeBalance,nativeBalanceCoversOrder,NATIVE_INPUT_TOKENS} from './native-balance.js';

export interface EntryResult {
  status: 'skipped' | 'created' | 'existing' | 'blocked';
  reason?: string;
  order?: OpeningOrder;
}
/** Internal capability evidence, never a user setting, signal assertion, or shadow result. */
export interface LiveProtectionReadiness {
  status: 'verified' | 'unverified';
  scope: 'autonomous_exit_execution';
  chain: Chain;
  wallet: string;
  checkedAt: string;
  validUntil: string;
}
export type LiveProtectionProvider = (context: Readonly<{
  chain: Chain; wallet: string; phase: 'before_balance' | 'before_quote' | 'before_submit';
}>) => LiveProtectionReadiness;
interface QuoteSummary {
  inputToken: string; outputToken: string; inputAmount: string;
  expectedOutputAmount: string; minOutputAmount: string; slippagePct: number; quotedAt: string;
}
type Patch = Parameters<OrderStore['update']>[2];
const HOST = 'https://openapi.gmgn.ai';
const DEADLINE_MS = 12_000;
const MAX_BYTES = 256 * 1024;
const ACTIVE: OpeningStatus[] = ['submitting', 'submitted', 'unknown'];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const addressEqual = (a: string, b: string, chain: Chain) => chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase();
const chainName = (chain: Chain) => chain === 'solana' ? 'sol' : chain;
const zeroEvm = /^0x0{40}$/i;
function address(v: unknown, chain: Chain): v is string {
  if (typeof v !== 'string') return false;
  try { return chain === 'solana' ? bs58.decode(v).length === 32 : /^0x[0-9a-fA-F]{40}$/.test(v); }
  catch { return false; }
}
function atomic(v: unknown, chain: Chain): v is string {
  return typeof v === 'string' && /^[1-9]\d{0,77}$/.test(v) &&
    BigInt(v) <= (chain === 'solana' ? (1n << 64n) - 1n : (1n << 256n) - 1n);
}
function txHash(v: unknown, chain: Chain): v is string {
  if (typeof v !== 'string') return false;
  if (chain !== 'solana') return /^0x[0-9a-fA-F]{64}$/.test(v);
  try { return bs58.decode(v).length === 64; } catch { return false; }
}
function orderId(v: unknown): v is string { return typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v); }
class EntryError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'EntryError'; }
}
function reason(error: unknown): string {
  return error instanceof EntryError || error instanceof GmgnError ? error.reason : 'ENTRY_REQUEST_FAILED';
}

function eligibility(report: Report, config: Config, now: Date): string | undefined {
  if (report.mode !== 'live') return 'ENTRY_DEMO_DISABLED';
  if (report.decision !== 'BUY_CANDIDATE' || report.buyEligible !== true) return 'ENTRY_NOT_CANDIDATE';
  const checks: Check[] = [report.provenance, report.safety];
  if(narrativeIdentityConflict(report.signal,report.narrative)) return 'ENTRY_NARRATIVE_TOKEN_IDENTITY_CONFLICT';
  if (config.walletSupportRequired) {
    if (!report.flow || report.flow.status !== 'pass') return 'ENTRY_FLOW_NOT_PASSED';
    checks.push(report.flow);
  } else if (report.flow?.status === 'fail') return 'ENTRY_FLOW_NOT_PASSED';
  if (checks.some(check => !check || check.status !== 'pass')) return 'ENTRY_CHECKS_NOT_PASSED';
  if (report.provenance.facts.modeSupported === false || report.safety.facts.canReplacePrimary === false ||
      report.safety.facts.scope === 'gmgn_provider_flags_only') return 'ENTRY_REQUIRED_COVERAGE_MISSING';
  const evaluated = Date.parse(report.evaluatedAt), validUntil = Date.parse(report.validUntil);
  const occurred = Date.parse(report.signal.occurredAt), current = now.getTime();
  if (![evaluated, validUntil, occurred, current].every(Number.isFinite) || validUntil <= current ||
      evaluated > current + 30_000 || current - evaluated > config.decisionTtlSec * 1_000 ||
      occurred > current + 30_000 || current - occurred > config.maxSignalAgeSec * 1_000 ||
      checks.some(check => !Number.isFinite(Date.parse(check.checkedAt)) || Date.parse(check.checkedAt) > current + 30_000 ||
        current - Date.parse(check.checkedAt) > config.maxSignalAgeSec * 1_000)) return 'ENTRY_CANDIDATE_EXPIRED';
  return undefined;
}

const codes = (values: string[]) => values.filter(v => /^[A-Z][A-Z0-9_]{0,100}$/.test(v)).slice(0, 12);
function briefCheck(check?: Check): unknown {
  return check ? {status: check.status, reasons: codes(check.reasons), checkedAt: check.checkedAt} : undefined;
}
function entryDetails(report: Report): Record<string, unknown> {
  const links = [...new Set(report.narrative.evidence.map(e => {
    try {
      const url = new URL(e.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) return undefined;
      const id = url.pathname.match(/\/status\/(\d{1,20})(?:\/|$)/)?.[1];
      return id ? `https://x.com/i/web/status/${id}` : undefined;
    } catch { return undefined; }
  }).filter((v): v is string => !!v))].slice(0, 8);
  const summary = report.wallets?.summary;
  return {
    reportId: report.id.slice(0, 200), policyVersion: report.policyVersion.slice(0, 100),
    signal: {source: report.signal.source, eventId: report.signal.sourceEventId, occurredAt: report.signal.occurredAt},
    evaluatedAt: report.evaluatedAt, validUntil: report.validUntil,
    checks: {provenance: briefCheck(report.provenance), safety: briefCheck(report.safety),
      narrative: briefCheck(report.narrative), flow: briefCheck(report.flow)},
    evidenceLinks: links,
    ...(summary ? {walletSummary: {
      sampleOnly: true, smartIndependenceProven: false,
      uniqueWalletCount: summary.uniqueWalletCount, smartCurrentHolderCount: summary.smartCurrentHolderCount,
      qualifiedSmartFundingClusterCount: summary.qualifiedSmartFundingClusterCount,
      recentWindowSeconds: summary.recentWindowSeconds, recentNetBuyUsd: summary.recentNetBuyUsd,
      hasRecentAccumulation: summary.hasRecentAccumulation,
    }} : {}),
    wallets: (report.wallets?.wallets ?? []).filter(w => address(w.address, report.signal.token.chain)).slice(0, 5).map(w => ({
      address: w.address, labels: w.recognizedLabels.slice(0, 8), clusterId: w.clusterId.slice(0, 100),
      vendorClaims: true, identityVerified: false,
    })),
  };
}

function quoteSummary(raw: unknown, order: OpeningOrder, now: Date): QuoteSummary {
  if (!object(raw) || !address(raw.input_token, order.chain) || !address(raw.output_token, order.chain) ||
      !addressEqual(raw.input_token, order.inputToken, order.chain) || !addressEqual(raw.output_token, order.tokenAddress, order.chain) ||
      !atomic(raw.input_amount, order.chain) || raw.input_amount !== order.inputAmount ||
      !atomic(raw.output_amount, order.chain) || !atomic(raw.min_output_amount, order.chain) ||
      typeof raw.slippage !== 'number' || !Number.isInteger(raw.slippage) || raw.slippage < 0 || raw.slippage > order.slippagePct)
    throw new EntryError('ENTRY_QUOTE_INVALID');
  const output = BigInt(raw.output_amount), minimum = BigInt(raw.min_output_amount);
  if (minimum > output || minimum < output * BigInt(100 - raw.slippage) / 100n)
    throw new EntryError('ENTRY_QUOTE_SLIPPAGE_MISMATCH');
  return {inputToken: order.inputToken, outputToken: order.tokenAddress, inputAmount: order.inputAmount,
    expectedOutputAmount: raw.output_amount, minOutputAmount: raw.min_output_amount,
    slippagePct: raw.slippage, quotedAt: now.toISOString()};
}

/** Server-internal entry gate. Do not expose consider() as an API accepting external reports. */
export class EntryController {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly liveProtection?: LiveProtectionProvider;
  constructor(private readonly config: Config, private readonly orders: OrderStore,
    private readonly client: GmgnClient, options: {fetcher?: typeof fetch; now?: () => Date;
      liveProtection?: LiveProtectionProvider} = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.liveProtection = options.liveProtection;
  }

  async consider(input: Report): Promise<EntryResult> {
    if (this.config.entryMode === 'off') return {status: 'skipped', reason: 'ENTRY_DISABLED'};
    let report: Report;
    try { report = structuredClone(input); report.signal = parseSignal(report.signal); }
    catch { return {status: 'blocked', reason: 'ENTRY_REPORT_INVALID'}; }
    let ineligible: string | undefined;
    try { ineligible = eligibility(report, this.config, this.now()); }
    catch { return {status: 'blocked', reason: 'ENTRY_REPORT_INVALID'}; }
    if (ineligible) return {status: 'skipped', reason: ineligible};
    const chain = report.signal.token.chain, target = report.signal.token.address;
    const wallet = this.config.entryWallets[chain], amount = this.config.entryAmounts[chain], inputToken = this.config.entryInputTokens[chain];
    if (this.config.entryMode === 'live') {
      try {this.requireLiveProtection(chain, wallet ?? '', 'before_balance');}
      catch (error) {return {status: 'blocked', reason: reason(error)};}
    }
    if (!this.config.gmgnApiKey || !wallet || !inputToken || !amount) return {status: 'blocked', reason: 'ENTRY_CONFIG_MISSING'};
    if (!address(wallet, chain) || zeroEvm.test(wallet) || !address(inputToken, chain) || !atomic(amount, chain) ||
        zeroEvm.test(target) || addressEqual(inputToken, target, chain) ||
        !Number.isInteger(this.config.entrySlippagePct) || this.config.entrySlippagePct < 0 || this.config.entrySlippagePct > 50 ||
        !Number.isInteger(this.config.entryMaxOpen) || this.config.entryMaxOpen < 1)
      return {status: 'blocked', reason: 'ENTRY_CONFIG_INVALID'};
    let signingKey: KeyObject | undefined;
    if (this.config.entryMode === 'live') {
      try { signingKey = this.signingKey(); }
      catch (error) { return {status: 'blocked', reason: reason(error)}; }
    }
    const eventKey = createHash('sha256').update(JSON.stringify([report.signal.source, report.signal.sourceEventId, chain, target])).digest('hex');
    let details: Record<string, unknown>;
    try { details = entryDetails(report); }
    catch { return {status: 'blocked', reason: 'ENTRY_REPORT_INVALID'}; }
    let exit:ExitTracking|undefined;
    try {
      const policy=parseExitPolicy(this.config.exitPolicy);
      if(policy) exit={policy,state:'awaiting_swap',reasons:[],checkedAt:this.now().toISOString(),positionClosed:false};
    } catch {return {status:'blocked',reason:'EXIT_POLICY_INVALID'};}
    let funding:FundingSnapshot|undefined;
    if(this.config.entrySizing==='balance_cap') {
      if(!addressEqual(inputToken,NATIVE_INPUT_TOKENS[chain],chain)) return {status:'blocked',reason:'ENTRY_NATIVE_INPUT_REQUIRED'};
      try {funding=await this.fundingSnapshot(chain,wallet,inputToken,this.config.entryMode);}
      catch(error) {return {status:'blocked',reason:reason(error)};}
      const expired=eligibility(report,this.config,this.now());
      if(expired) return {status:'skipped',reason:expired};
      if(this.isDisabled()) return {status:'skipped',reason:'ENTRY_DISABLED_BEFORE_SUBMIT'};
    }
    const reservation = this.orders.reserve({eventKey, chain, tokenAddress: target, mode: this.config.entryMode,
      wallet: chain === 'solana' ? wallet : wallet.toLowerCase(),
      inputToken: chain === 'solana' ? inputToken : inputToken.toLowerCase(), inputAmount: amount,
      slippagePct: this.config.entrySlippagePct, details,...(exit?{exit}:{})}, this.config.entryMaxOpen, this.now(),funding);
    if (!reservation.created) return reservation.order ? {status: 'existing', order: reservation.order} :
      {status: 'blocked', reason: reservation.reason};
    let order = reservation.order!;
    let attempted = false;
    try {
      if (order.mode === 'live') this.requireLiveProtection(chain, order.wallet, 'before_quote');
      const raw = await this.client.get('/v1/trade/quote', {chain: chainName(chain), from_address: order.wallet,
        input_token: order.inputToken, output_token: target, input_amount: order.inputAmount, slippage: order.slippagePct}, 10);
      const quote = quoteSummary(raw, order, this.now());
      const expired = eligibility(report, this.config, this.now());
      if (expired) throw new EntryError(expired);
      if (this.isDisabled()) throw new EntryError('ENTRY_DISABLED_BEFORE_SUBMIT');
      const prepared = this.orders.update(order.id, ['prepared'], {details: {...order.details, quote}}, this.now());
      if (!prepared) return {status: 'existing', order: this.orders.get(order.id)};
      order = prepared;
      if (order.mode === 'paper') {
        const paper = this.orders.update(order.id, ['prepared'], {status: 'paper_open',
          details: {...order.details, execution: 'quote_only_no_fill'}}, this.now());
        if(paper?.exit) this.orders.updateExit(paper.id,paper.exit,{...paper.exit,state:'paper',reasons:['EXIT_NOT_SUBMITTED_PAPER'],checkedAt:this.now().toISOString()},this.now());
        return {status: paper ? 'created' : 'existing', order: this.orders.get(order.id)};
      }
      const body = {chain: chainName(chain), from_address: order.wallet, input_token: order.inputToken,
        output_token: target, input_amount: order.inputAmount, swap_mode: 'ExactIn',
        slippage: order.slippagePct, min_output_amount: quote.minOutputAmount,
        ...(order.exit?{condition_orders:buildExitConditions(order.exit.policy),sell_ratio_type:order.exit.policy.sellRatioType,
          ...(chain==='bsc'?{gas_price:this.config.entryGasPriceBsc}:{}),
          ...(chain==='solana'?{priority_fee:this.config.entryPriorityFeeSolana,tip_fee:this.config.entryTipFeeSolana}:{})}:{}),
        ...(chain === 'solana' || chain === 'bsc' ? {is_anti_mev: true} : {})};
      const result = await this.signedRequest('POST', '/v1/trade/swap', {}, body, signingKey!, async () => {
        this.requireLiveProtection(order.chain, order.wallet, 'before_submit');
        if(funding) {
          const latest=await this.fundingSnapshot(order.chain,order.wallet,order.inputToken,order.mode);
          const checked=this.orders.checkFunding(order.id,latest,this.now());
          if(!checked.ok) throw new EntryError(checked.reason??'ENTRY_INSUFFICIENT_BALANCE');
        }
        const expiredNow = eligibility(report, this.config, this.now());
        if (expiredNow) throw new EntryError(expiredNow);
        if (this.config.entryMode !== 'live') throw new EntryError('ENTRY_DISABLED_BEFORE_SUBMIT');
        // Balance I/O and the shared request queue can outlive the protection evidence.
        this.requireLiveProtection(order.chain, order.wallet, 'before_submit');
        const submitting = this.orders.beginSubmission(order.id, this.now());
        if (!submitting.order) throw new EntryError(submitting.reason ?? 'ENTRY_ALREADY_HANDLED');
        attempted = true;
      });
      const updated = this.applyExecution(order, result);
      return {status: 'created', order: updated};
    } catch (error) {
      const failureReason = reason(error);
      const updated = this.orders.update(order.id, [attempted ? 'submitting' : 'prepared'],
        {status: attempted ? 'unknown' : 'failed', failureReason}, this.now()) ?? this.orders.get(order.id);
      return {status: attempted ? 'created' : 'blocked', reason: failureReason, order: updated};
    }
  }

  async reconcile(id: string): Promise<EntryResult> {
    const order = this.orders.get(id);
    if (!order) return {status: 'blocked', reason: 'ENTRY_ORDER_NOT_FOUND'};
    const needsFillDetails = order.status === 'confirmed' && (!order.actualInputAmount || !order.outputAmount);
    const needsExit=order.status==='confirmed'&&!!order.exit&&!order.exit.positionClosed;
    if (order.mode !== 'live' || (!ACTIVE.includes(order.status) && !needsFillDetails&&!needsExit)) return {status: 'existing', order};
    if (!order.providerOrderId) return {status: 'blocked', reason: 'ENTRY_ORDER_ID_MISSING_NO_RESUBMIT', order};
    try {
      let updated=order;
      if(ACTIVE.includes(order.status)||needsFillDetails||order.exit&&!order.exit.strategyOrderId) {
        const raw = await this.signedRequest('GET', '/v1/trade/query_order',
          {chain: chainName(order.chain), order_id: order.providerOrderId}, null, this.signingKey());
        updated=this.applyExecution(order,raw);
      }
      if(updated.status==='confirmed'&&updated.exit&&!updated.exit.positionClosed) updated=await this.reconcileExit(updated);
      return {status: 'existing', order: updated};
    } catch (error) {
      // A failed read is not evidence that a previously accepted order failed.
      return {status: 'blocked', reason: reason(error), order: this.orders.get(id)};
    }
  }

  private signingKey(): KeyObject {
    if (!this.config.gmgnApiKey || !this.config.gmgnPrivateKey) throw new EntryError('ENTRY_SIGNING_CONFIG_MISSING');
    try {
      const key = createPrivateKey(this.config.gmgnPrivateKey.replace(/\\n/g, '\n'));
      if (!['ed25519', 'rsa'].includes(key.asymmetricKeyType ?? '')) throw new Error();
      return key;
    } catch { throw new EntryError('ENTRY_SIGNING_KEY_INVALID'); }
  }

  private isDisabled(): boolean { return this.config.entryMode === 'off'; }

  private requireLiveProtection(chain: Chain, wallet: string,
    phase: Parameters<LiveProtectionProvider>[0]['phase']): void {
    const fail = () => {throw new EntryError('ENTRY_UNATTENDED_PROTECTION_UNVERIFIED');};
    try {
      const proof = this.liveProtection?.(Object.freeze({chain, wallet, phase}));
      const current = this.now().getTime(), checked = Date.parse(proof?.checkedAt ?? ''), until = Date.parse(proof?.validUntil ?? '');
      if (!proof || proof.status !== 'verified' || proof.scope !== 'autonomous_exit_execution' ||
          proof.chain !== chain || !address(proof.wallet, chain) || !addressEqual(proof.wallet, wallet, chain) ||
          ![current, checked, until].every(Number.isFinite) || checked > current + 5_000 ||
          current - checked > 30_000 || until <= current || until < checked || until - checked > 30_000) fail();
    } catch {fail();}
  }

  private async fundingSnapshot(chain:Chain,wallet:string,inputToken:string,mode:'live'|'paper'):Promise<FundingSnapshot> {
    const balance=await readNativeBalance(chain,wallet,this.config,this.fetcher);
    if(balance.status!=='verified'||balance.amount===undefined) throw new EntryError('ENTRY_BALANCE_UNAVAILABLE');
    const coveredOrderIds:string[]=[];
    if(mode==='live') for(const previous of this.orders.fundingOrders({chain,mode,wallet,inputToken})) {
      if(previous.chain!==chain||previous.mode!==mode||previous.status!=='confirmed'||!previous.transactionHash||
        !addressEqual(previous.wallet,wallet,chain)||!addressEqual(previous.inputToken,inputToken,chain)) continue;
      const cache=previous.details.nativeDebitCoverage;
      const cached=object(cache)&&cache.transactionHash===previous.transactionHash&&
        (chain==='solana'?typeof cache.slot==='number'&&Number.isSafeInteger(cache.slot)&&cache.slot>=0&&typeof balance.slot==='number'&&balance.slot>=cache.slot:
          typeof cache.blockNumber==='string'&&/^0x[0-9a-f]+$/i.test(cache.blockNumber)&&typeof balance.blockNumber==='string'&&BigInt(balance.blockNumber)>=BigInt(cache.blockNumber));
      if(cached) {coveredOrderIds.push(previous.id);continue;}
      // Each successful proof is cached with its snapshot height on the opening record.
      // A stale node cannot reuse that proof until it catches up to the recorded height.
      if(await nativeBalanceCoversOrder(previous,balance,this.config,this.fetcher)) {
        coveredOrderIds.push(previous.id);
        const current=this.orders.get(previous.id);
        if(current?.status==='confirmed') this.orders.update(previous.id,['confirmed'],{details:{...current.details,
          nativeDebitCoverage:{transactionHash:current.transactionHash,blockNumber:balance.blockNumber,slot:balance.slot,checkedAt:balance.checkedAt}}},this.now());
      }
      if(this.now().getTime()-Date.parse(balance.readStartedAt)>25_000) break;
    }
    return {...balance,balance:balance.amount,feeReserve:this.config.entryFeeReserves[chain],coveredOrderIds};
  }

  private async reconcileExit(order:OpeningOrder):Promise<OpeningOrder> {
    const previous=order.exit!;
    const save=(next:ExitTracking)=>this.orders.updateExit(order.id,previous,next,this.now())??this.orders.get(order.id)!;
    if(!previous.strategyOrderId) return save({...previous,state:'attention',reasons:['EXIT_STRATEGY_ID_MISSING'],checkedAt:this.now().toISOString()});
    try {
      const expected={strategyOrderId:previous.strategyOrderId,chain:order.chain,wallet:order.wallet,
        tokenAddress:order.tokenAddress,inputToken:order.inputToken,openingTransactionHash:order.transactionHash,
        sellRatioType:previous.policy.sellRatioType,policyConditions:buildExitConditions(previous.policy)};
      let assessment=assessExitStrategy({list:[]},expected,this.now());
      let found=false;
      // Bounded pagination; absence in these pages is never proof of cancellation.
      for(const type of ['open','history']) {
        let page:string|undefined;
        for(let count=0;count<2;count++) {
          const raw=await this.signedRequest('GET','/v1/trade/strategy/orders',
            {chain:chainName(order.chain),group_tag:'STMix',type,from_address:order.wallet,base_token:order.tokenAddress,limit:'50',...(page?{page_token:page}:{})},null,this.signingKey());
          assessment=assessExitStrategy(raw,expected,this.now());
          if(object(raw)&&Array.isArray(raw.list)&&raw.list.some(row=>object(row)&&row.order_id===previous.strategyOrderId)) {found=true;break;}
          if(!object(raw)||typeof raw.next_page_token!=='string'||!raw.next_page_token||raw.next_page_token.length>2000||raw.next_page_token===page) break;
          page=raw.next_page_token;
        }
        if(found) break;
      }
      const balance=await readPositionBalance(order,this.config,this.fetcher);
      const closed=assessment.terminal&&balance.status==='verified'&&balance.amount==='0';
      return save({...previous,assessment,balance,positionClosed:closed,state:closed?'closed':assessment.hasLiveStop?'monitoring':assessment.terminal||assessment.status==='degraded'?'attention':'unverified',
        reasons:closed?['EXIT_POSITION_CLOSED']:assessment.reasons,checkedAt:this.now().toISOString()});
    } catch(error) {
      return save({...previous,state:'unverified',reasons:[reason(error)],checkedAt:this.now().toISOString()});
    }
  }

  private async signedRequest(method: 'GET' | 'POST', path: '/v1/trade/swap' | '/v1/trade/query_order' | '/v1/trade/strategy/orders',
    query: Record<string, string>, body: Record<string, unknown> | null, key: KeyObject, beforeSend?: () => void|Promise<void>): Promise<unknown> {
    return this.client.scheduleRequest(method === 'POST' ? 10 : path==='/v1/trade/strategy/orders'?1:5, async () => {
      await beforeSend?.();
      const timestamp = Math.floor(this.now().getTime() / 1000);
      const params: Record<string, string> = {...query, timestamp: String(timestamp), client_id: randomUUID()};
      const sorted = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
      const bodyText = body === null ? '' : JSON.stringify(body);
      const message = Buffer.from(`${path}:${sorted}:${bodyText}:${timestamp}`, 'utf8');
      const signature = (key.asymmetricKeyType === 'ed25519' ? sign(null, message, key) :
        sign('sha256', message, {key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32})).toString('base64');
      const url = new URL(path, HOST); url.search = new URLSearchParams(params).toString();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new EntryError('ENTRY_REQUEST_TIMEOUT'));
      }, DEADLINE_MS); });
      const run = async (): Promise<unknown> => {
        const response = await this.fetcher(url, {method, redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: {'X-APIKEY': this.config.gmgnApiKey!, 'X-Signature': signature, 'content-type': 'application/json'},
          ...(method === 'POST' ? {body: bodyText} : {})});
        if (response.status === 429) this.client.recordRateLimit(response.headers);
        if (!response.ok && response.status !== 429) {
          void response.body?.cancel().catch(() => {});
          throw new EntryError('ENTRY_HTTP_ERROR');
        }
        if (!response.body || Number(response.headers.get('content-length')) > MAX_BYTES) {
          void response.body?.cancel().catch(() => {}); throw new EntryError('ENTRY_RESPONSE_INVALID');
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const {done, value} = await reader.read(); if (done) break;
            size += value.byteLength; if (size > MAX_BYTES) throw new EntryError('ENTRY_RESPONSE_TOO_LARGE');
            chunks.push(value);
          }
        } catch (error) { void reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        let envelope: unknown;
        try { envelope = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
        catch { throw new EntryError(response.status === 429 ? 'ENTRY_RATE_LIMITED' : 'ENTRY_RESPONSE_INVALID'); }
        if (!object(envelope)) throw new EntryError('ENTRY_RESPONSE_INVALID');
        if (response.status === 429 || envelope.code === 429 || envelope.code === '429' ||
            ['RATE_LIMIT_EXCEEDED', 'RATE_LIMIT_BANNED', 'ERROR_RATE_LIMIT_BLOCKED'].includes(String(envelope.error))) {
          this.client.recordRateLimit(response.headers, envelope); throw new EntryError('ENTRY_RATE_LIMITED');
        }
        if (envelope.code !== 0 && envelope.code !== '0') throw new EntryError('ENTRY_API_ERROR');
        if (!Object.hasOwn(envelope, 'data')) throw new EntryError('ENTRY_RESPONSE_INVALID');
        return envelope.data;
      };
      try { return await Promise.race([run(), timeout]); }
      catch (error) {
        if (error instanceof EntryError) throw error;
        if (controller.signal.aborted || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
          throw new EntryError('ENTRY_REQUEST_TIMEOUT');
        throw new EntryError('ENTRY_REQUEST_FAILED');
      } finally { clearTimeout(timer!); }
    });
  }

  private applyExecution(order: OpeningOrder, raw: unknown): OpeningOrder {
    // The swap acknowledgement proves neither that exits are running nor that a sell filled.
    const stored=this.orders.get(order.id)!;
    if(stored.exit&&object(raw)&&((stored.providerOrderId&&raw.order_id===stored.providerOrderId)||(!stored.providerOrderId&&orderId(raw.order_id)))) {
      const snapshot=stored.exit!;
      if(orderId(raw.strategy_order_id)&&(!snapshot.strategyOrderId||snapshot.strategyOrderId===raw.strategy_order_id)) {
        this.orders.updateExit(order.id,snapshot,{...snapshot,strategyOrderId:raw.strategy_order_id,state:'unverified',reasons:['EXIT_STRATEGY_NOT_YET_VERIFIED'],checkedAt:this.now().toISOString()},this.now());
      }
    }
    const patch: Patch = {status: 'unknown', failureReason: 'ENTRY_EXECUTION_UNVERIFIED'};
    if (object(raw)) {
      if (orderId(raw.order_id) && (!order.providerOrderId || raw.order_id === order.providerOrderId)) {
        patch.providerOrderId = raw.order_id;
        if (txHash(raw.hash, order.chain)) patch.transactionHash = raw.hash;
        const receipt = raw.report;
        let receiptValid = false;
        if (object(receipt) && address(receipt.input_token, order.chain) && address(receipt.output_token, order.chain) &&
            addressEqual(receipt.input_token, order.inputToken, order.chain) && addressEqual(receipt.output_token, order.tokenAddress, order.chain) &&
            atomic(receipt.input_amount, order.chain) && atomic(receipt.output_amount, order.chain) &&
            BigInt(receipt.input_amount) <= BigInt(order.inputAmount)) {
          receiptValid = true;
        }
        const explicitSuccess = raw.status === 'confirmed' && (raw.state === undefined || raw.state === 30) ||
          raw.status === 'successful' && raw.state === 30 && receiptValid;
        if (explicitSuccess && patch.transactionHash && (receipt === undefined || receiptValid)) {
          patch.status = 'confirmed'; patch.failureReason = undefined;
          if (receiptValid && object(receipt)) {
            patch.actualInputAmount = receipt.input_amount as string; patch.outputAmount = receipt.output_amount as string;
          }
        } else if ((raw.status === 'failed' || raw.status === 'expired') && raw.state !== 30 && !receiptValid) {
          patch.status = 'failed'; patch.failureReason = raw.status === 'expired' ? 'ENTRY_ORDER_EXPIRED' : 'ENTRY_ORDER_FAILED';
        } else if ((raw.status === 'pending' || raw.status === 'processed') && raw.state !== 30 && !receiptValid) {
          patch.status = 'submitted'; patch.failureReason = undefined;
        }
      }
    }
    if (order.status === 'confirmed') {
      // A confirmed transaction stays confirmed. Later reads may only fill its
      // missing atomic amounts, using the same order ID and transaction hash.
      const current = this.orders.get(order.id)!;
      if (current.status !== 'confirmed' || patch.status !== 'confirmed' ||
          !patch.actualInputAmount || !patch.outputAmount ||
          patch.providerOrderId !== current.providerOrderId || !current.transactionHash || !patch.transactionHash ||
          !addressEqual(patch.transactionHash, current.transactionHash, current.chain) ||
          (current.actualInputAmount !== undefined && current.actualInputAmount !== patch.actualInputAmount) ||
          (current.outputAmount !== undefined && current.outputAmount !== patch.outputAmount)) return current;
      const amounts: Patch = {};
      if (current.actualInputAmount === undefined) amounts.actualInputAmount = patch.actualInputAmount;
      if (current.outputAmount === undefined) amounts.outputAmount = patch.outputAmount;
      if (!Object.keys(amounts).length) return current;
      return this.orders.update(order.id, ['confirmed'], amounts, this.now()) ?? this.orders.get(order.id)!;
    }
    return this.orders.update(order.id, ACTIVE, patch, this.now()) ?? this.orders.get(order.id)!;
  }
}
