import {priceEvidence,type PriceEvidence} from './price-evidence.js';
import type {Chain} from './types.js';
import bs58 from 'bs58';

/** Research-only policy. These constants have not been validated as trading parameters. */
export interface AdaptiveExitPolicy {
  readonly version: string;
  readonly hardStopDropPct: number;
  readonly maxPriceAgeMs: number;
  readonly volatilityWindow: number;
  readonly minimumVolatilitySamples: number;
  readonly maxVolatilityGapMs: number;
  readonly fallbackVolatilityPctPerMinute: number;
  readonly activationVolatilityMultiplier: number;
  readonly minActivationGainPct: number;
  readonly maxActivationGainPct: number;
  readonly baseDrawdownPct: number;
  readonly volatilityDrawdownMultiplier: number;
  readonly maxVolatilityWideningPct: number;
  readonly minDrawdownPct: number;
  readonly maxDrawdownPct: number;
  readonly gainTightening: readonly Readonly<{gainPct: number; tightenPct: number}>[];
  readonly walletMaxTighteningPct: number;
  readonly walletMinVolumeUsd: number;
  readonly maxWalletAgeMs: number;
  readonly maxWalletWindowMs: number;
  readonly maxWalletTrades: number;
  readonly maxHoldingMs?:number;
  readonly momentumMinimumHoldMs?:number;
  readonly momentumPeakQuietMs?:number;
  readonly momentumWindowMs?:number;
  readonly momentumMinimumSpanMs?:number;
  readonly momentumMinimumSamples?:number;
  readonly momentumMaxChangePct?:number;
  readonly momentumMinDrawdownPct?:number;
  readonly partialExits: readonly Readonly<{gainPct: number; sellPctRemaining: number}>[];
}

export const ADAPTIVE_SHADOW_V1: AdaptiveExitPolicy = Object.freeze({
  version: 'adaptive-shadow-v1', hardStopDropPct: 40, maxPriceAgeMs: 120_000,
  volatilityWindow: 12, minimumVolatilitySamples: 3, maxVolatilityGapMs: 300_000,
  fallbackVolatilityPctPerMinute: 25,
  activationVolatilityMultiplier: 2, minActivationGainPct: 30, maxActivationGainPct: 80,
  baseDrawdownPct: 25, volatilityDrawdownMultiplier: 0.5, maxVolatilityWideningPct: 10,
  minDrawdownPct: 12, maxDrawdownPct: 35,
  gainTightening: Object.freeze([
    Object.freeze({gainPct: 100, tightenPct: 3}),
    Object.freeze({gainPct: 200, tightenPct: 6}),
    Object.freeze({gainPct: 500, tightenPct: 10}),
  ]),
  walletMaxTighteningPct: 8, walletMinVolumeUsd: 100,
  maxWalletAgeMs: 300_000, maxWalletWindowMs: 600_000, maxWalletTrades: 100,
  partialExits: Object.freeze([
    Object.freeze({gainPct: 500, sellPctRemaining: 20}),
    Object.freeze({gainPct: 1000, sellPctRemaining: 10}),
  ]),
});

/** New episodes only, or an explicit prospective migration; v1 observations are never replayed. */
export const ADAPTIVE_SHADOW_V2:AdaptiveExitPolicy=Object.freeze({...ADAPTIVE_SHADOW_V1,
  version:'adaptive-shadow-v2',maxHoldingMs:6*60*60_000,
  momentumMinimumHoldMs:30*60_000,momentumPeakQuietMs:30*60_000,
  momentumWindowMs:20*60_000,momentumMinimumSpanMs:15*60_000,momentumMinimumSamples:6,
  momentumMaxChangePct:3,momentumMinDrawdownPct:5,
});
/** Behavior-only policy: elapsed time and an observation horizon never close a v3 position. */
export const ADAPTIVE_SHADOW_V3:AdaptiveExitPolicy=(()=>{
  const {maxHoldingMs:_retiredHoldingDeadline,...behavior}=ADAPTIVE_SHADOW_V2;
  return Object.freeze({...behavior,version:'adaptive-shadow-v3'});
})();
export function adaptiveExitPolicy(version:string):AdaptiveExitPolicy|undefined {
  return version===ADAPTIVE_SHADOW_V1.version?ADAPTIVE_SHADOW_V1:version===ADAPTIVE_SHADOW_V2.version?ADAPTIVE_SHADOW_V2:
    version===ADAPTIVE_SHADOW_V3.version?ADAPTIVE_SHADOW_V3:undefined;
}
const momentumPolicy=(policy:AdaptiveExitPolicy)=>policy.version===ADAPTIVE_SHADOW_V2.version||policy.version===ADAPTIVE_SHADOW_V3.version;
export interface AdaptiveExitDeadline {dueAt:string;reason:'MAX_HOLDING_TIME_OBSERVED'|'OBSERVATION_WINDOW_END_OBSERVED';}

export interface PriceObservation {
  chain: Chain;
  address: string;
  priceUsd: number;
  /** Time this quote was actually observed, not a historical candle or historical high. */
  observedAt: string;
  /** Injected current clock, making freshness checks deterministic and free of IO. */
  evaluatedAt: string;
  source: string;
  metadata?:PriceEvidence;
  /** Legacy v2 only. V3 ignores observation horizons when deciding exits. */
  observationEndsAt?:string;
}

export type WalletTradeSource = 'gmgn_wallet_activity' | 'gmgn_token_trades' |
  'gmgn_kol_feed' | 'gmgn_smartmoney_feed' | 'gmgn_association_candidate_activity' |
  'gmgn_association_leader_activity' | 'gmgn_association_wallet_activity' | 'chain_transaction';

export interface WalletPressureTrade {
  evidenceId: string;
  wallet: string;
  side: 'buy' | 'sell';
  volumeUsd: number;
  eventAt: string;
  observedAt: string;
  source: WalletTradeSource;
}

/** Caller must supply locally retained, token-bound trade evidence, never an AI score. */
export interface WalletPressure {
  chain: Chain;
  address: string;
  observedAt: string;
  windowStartAt: string;
  windowEndAt: string;
  trades: WalletPressureTrade[];
}

export interface WalletPressureSummary {
  status: 'observed_net_selling' | 'observed_no_net_selling';
  netSellRatio: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  evidenceCount: number;
  evidenceIds: string[];
  sources: WalletTradeSource[];
  /** Vendor trade observations are not independently verified chain transactions. */
  verification: 'vendor_reported' | 'chain_evidence' | 'mixed';
}

/** JSON-only state; no positions, orders, signing material, or executable instructions. */
export interface AdaptiveExitState {
  schemaVersion: 1;
  policyVersion: string;
  chain: Chain;
  address: string;
  baselinePriceUsd: number;
  baselineAt: string;
  lastPriceUsd: number;
  lastObservedAt: string;
  lastEvaluatedAt: string;
  peakPriceUsd: number;
  peakAt: string;
  hardStopPriceUsd: number;
  protectionPriceUsd: number;
  protectionActive: boolean;
  activationGainPct: number;
  drawdownPct: number;
  volatilityPctPerMinute: number;
  /** Absolute log returns per minute; only already-observed adjacent prices. */
  volatilityReturns: number[];
  lastSampleGapMs: number;
  maxSampleGapMs: number;
  gapCount: number;
  samples: number;
  suggestedStages: number[];
  /** Hypothetical remaining fraction after suggestions, not the wallet's balance. */
  remainingPctOfInitial: number;
  shadowClosed: boolean;
  walletPressure?: WalletPressureSummary;
  /** Activation time of this version; no pre-activation quotation can be replayed into it. */
  policyEffectiveAt?:string;
  /** V3 preserves the start of already-observed momentum evidence independently of version activation. */
  momentumEffectiveAt?:string;
  /** Historical v2 audit field; never an exit deadline under v3. */
  observationEndsAt?:string;
  momentumObservations?:{observedAt:string;priceUsd:number}[];
}

export type AdaptiveExitReason = 'HARD_STOP_OBSERVED' | 'DYNAMIC_PROTECTION_OBSERVED' |
  'PARTIAL_PROFIT_STAGE_OBSERVED' | 'WALLET_NET_SELLING_TIGHTENED' |
  'MOMENTUM_STALLED_OBSERVED' | 'MAX_HOLDING_TIME_OBSERVED' | 'OBSERVATION_WINDOW_END_OBSERVED';

export interface AdaptiveExitEvent {
  policyVersion: string;
  mode: 'shadow';
  execution: 'observation_only';
  kind: 'partial_exit' | 'full_exit';
  observedAt: string;
  evaluatedAt: string;
  /** First fresh sampled price that satisfies the rule; never a claimed fill price. */
  observedPriceUsd: number;
  baselinePriceUsd: number;
  observedGainPct: number;
  peakPriceUsd: number;
  protectionPriceUsd: number;
  sellRatioType: 'remaining_holding';
  sellPctRemaining: number;
  remainingPctOfInitial: number;
  reasons: AdaptiveExitReason[];
  stageGainsPct: number[];
  walletPressure?: WalletPressureSummary;
}

export type AdaptiveExitIgnoredReason = 'POLICY_UNSUPPORTED' | 'STATE_INVALID' | 'STATE_POLICY_MISMATCH' |
  'PRICE_INVALID' | 'TIME_INVALID' | 'PRICE_FROM_FUTURE' | 'PRICE_STALE' | 'IDENTITY_MISMATCH' |
  'TIME_REGRESSED' | 'DUPLICATE_SAMPLE' | 'SAMPLE_CONFLICT' | 'SHADOW_CLOSED' | 'ARITHMETIC_INVALID';

export interface AdaptiveExitStep {
  status: 'initialized' | 'observed' | 'ignored';
  state?: AdaptiveExitState;
  event?: AdaptiveExitEvent;
  ignoredReason?: AdaptiveExitIgnoredReason;
  ignoredPressureReason?: 'WALLET_PRESSURE_INVALID' | 'WALLET_PRESSURE_IDENTITY_MISMATCH' |
    'WALLET_PRESSURE_TIME_INVALID' | 'WALLET_PRESSURE_STALE' | 'WALLET_PRESSURE_EVIDENCE_CONFLICT' |
    'WALLET_PRESSURE_VOLUME_INSUFFICIENT';
}

const sourceSet = new Set<WalletTradeSource>(['gmgn_wallet_activity', 'gmgn_token_trades',
  'gmgn_kol_feed', 'gmgn_smartmoney_feed', 'gmgn_association_candidate_activity',
  'gmgn_association_leader_activity', 'gmgn_association_wallet_activity', 'chain_transaction']);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const time = (value: unknown): number => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  const expected = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, fraction: string) => `.${fraction.padEnd(3, '0')}Z`) : value.replace(/Z$/, '.000Z');
  return new Date(parsed).toISOString() === expected ? parsed : NaN;
};
const address = (value: unknown, chain: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (chain === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
    try {const bytes = bs58.decode(value); return bytes.length === 32 && bytes.some(byte => byte !== 0);} catch {return false;}
  }
  return (chain === 'bsc' || chain === 'robinhood') && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
};
const normalized = (value: string, chain: Chain) => chain === 'solana' ? value : value.toLowerCase();
const sameToken = (a: {chain: Chain; address: string}, b: {chain: Chain; address: string}) =>
  a.chain === b.chain && normalized(a.address, a.chain) === normalized(b.address, b.chain);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Exact, named versions prevent silent changes to the meaning of persisted observations.
function supportedPolicy(policy: AdaptiveExitPolicy): boolean {
  if(!object(policy))return false;
  const expected=adaptiveExitPolicy(policy.version);
  if(!expected||Object.keys(policy).length!==Object.keys(expected).length)return false;
  try {return Object.entries(expected).every(([key,value])=>JSON.stringify(policy[key as keyof AdaptiveExitPolicy])===JSON.stringify(value));}
  catch{return false;}
}

function validPressureSummary(value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value) || !['observed_net_selling', 'observed_no_net_selling'].includes(String(value.status)) ||
      !nonnegative(value.netSellRatio) || value.netSellRatio > 1 || !nonnegative(value.buyVolumeUsd) ||
      !nonnegative(value.sellVolumeUsd) || !integer(value.evidenceCount) || value.evidenceCount < 1 || value.evidenceCount > 100 ||
      !Array.isArray(value.evidenceIds) || value.evidenceIds.length !== value.evidenceCount ||
      value.evidenceIds.some(id => typeof id !== 'string' || !id || id.length > 200) ||
      !Array.isArray(value.sources) || !value.sources.length || value.sources.some(source => !sourceSet.has(source)) ||
      !['vendor_reported', 'chain_evidence', 'mixed'].includes(String(value.verification))) return false;
  return true;
}

function validState(state: AdaptiveExitState, policy: AdaptiveExitPolicy): boolean {
  if (!object(state) || state.schemaVersion !== 1 || typeof state.policyVersion !== 'string' ||
      !address(state.address, state.chain) || !positive(state.baselinePriceUsd) || !positive(state.lastPriceUsd) ||
      !positive(state.peakPriceUsd) || !positive(state.hardStopPriceUsd) || !positive(state.protectionPriceUsd) ||
      state.hardStopPriceUsd !== state.baselinePriceUsd * (1 - policy.hardStopDropPct / 100) ||
      state.protectionPriceUsd < state.hardStopPriceUsd || state.protectionPriceUsd > state.peakPriceUsd ||
      state.peakPriceUsd < Math.max(state.baselinePriceUsd, state.lastPriceUsd) ||
      typeof state.protectionActive !== 'boolean' || typeof state.shadowClosed !== 'boolean' ||
      !nonnegative(state.activationGainPct) || state.activationGainPct < policy.minActivationGainPct || state.activationGainPct > policy.maxActivationGainPct ||
      !nonnegative(state.drawdownPct) || state.drawdownPct < policy.minDrawdownPct || state.drawdownPct > policy.maxDrawdownPct ||
      !nonnegative(state.volatilityPctPerMinute) || !Array.isArray(state.volatilityReturns) ||
      state.volatilityReturns.length > policy.volatilityWindow || state.volatilityReturns.some(value => !nonnegative(value)) ||
      !integer(state.samples) || state.samples < 1 || !integer(state.gapCount) || state.gapCount >= state.samples ||
      state.volatilityReturns.length >= state.samples ||
      !nonnegative(state.lastSampleGapMs) || !nonnegative(state.maxSampleGapMs) || state.maxSampleGapMs < state.lastSampleGapMs ||
      !nonnegative(state.remainingPctOfInitial) || state.remainingPctOfInitial > 100 ||
      (state.remainingPctOfInitial === 0) !== state.shadowClosed || !Array.isArray(state.suggestedStages) ||
      state.suggestedStages.some(gain => !policy.partialExits.some(stage => stage.gainPct === gain)) ||
      new Set(state.suggestedStages).size !== state.suggestedStages.length || !validPressureSummary(state.walletPressure)) return false;
  const baseline = time(state.baselineAt), last = time(state.lastObservedAt), peak = time(state.peakAt), evaluated = time(state.lastEvaluatedAt);
  if (![baseline, last, peak, evaluated].every(Number.isFinite) || baseline > peak || peak > last || last > evaluated) return false;
  if (!state.protectionActive && state.protectionPriceUsd !== state.hardStopPriceUsd) return false;
  if (!state.shadowClosed) {
    let remaining = 100;
    for (const stage of policy.partialExits) if (state.suggestedStages.includes(stage.gainPct)) remaining *= 1 - stage.sellPctRemaining / 100;
    if (Math.abs(remaining - state.remainingPctOfInitial) > 1e-9) return false;
  }
  if(momentumPolicy(policy)){
    const effective=time(state.policyEffectiveAt),momentumEffective=policy.version===ADAPTIVE_SHADOW_V3.version?time(state.momentumEffectiveAt):effective;
    if(!Number.isFinite(effective)||effective<baseline||effective>evaluated||
      !Number.isFinite(momentumEffective)||momentumEffective<baseline||momentumEffective>effective||
      state.observationEndsAt!==undefined&&(!Number.isFinite(time(state.observationEndsAt))||
        (policy.version===ADAPTIVE_SHADOW_V2.version?time(state.observationEndsAt)<=effective:time(state.observationEndsAt)<=baseline))||
      !Array.isArray(state.momentumObservations)||state.momentumObservations.length>32)return false;
    let previous=-Infinity;
    for(const sample of state.momentumObservations){const at=time(sample.observedAt);
      if(!positive(sample.priceUsd)||!Number.isFinite(at)||at<momentumEffective||at>last||at<=previous)return false;previous=at;}
  }
  return true;
}

/** A deadline is an intent, never an execution or an observed price. */
export function adaptiveExitDeadline(state:AdaptiveExitState):AdaptiveExitDeadline|undefined {
  if(state.policyVersion!==ADAPTIVE_SHADOW_V2.version||!validState(state,ADAPTIVE_SHADOW_V2))return;
  const max=time(state.policyEffectiveAt!)+ADAPTIVE_SHADOW_V2.maxHoldingMs!,end=time(state.observationEndsAt);
  return Number.isFinite(end)&&end<=max?{dueAt:new Date(end).toISOString(),reason:'OBSERVATION_WINDOW_END_OBSERVED'}:
    {dueAt:new Date(max).toISOString(),reason:'MAX_HOLDING_TIME_OBSERVED'};
}

/** Explicit migration changes only future decisions and preserves old peaks/partial stages. */
export function migrateAdaptiveExitV1(state:AdaptiveExitState,effectiveAt:string,endsAt:string):AdaptiveExitState|undefined {
  const effective=time(effectiveAt),end=time(endsAt);
  if(state.policyVersion!==ADAPTIVE_SHADOW_V1.version||!validState(state,ADAPTIVE_SHADOW_V1)||state.shadowClosed||
    !Number.isFinite(effective)||effective<time(state.lastEvaluatedAt)||!Number.isFinite(end)||end<=effective)return;
  return {...state,policyVersion:ADAPTIVE_SHADOW_V2.version,policyEffectiveAt:new Date(effective).toISOString(),
    lastEvaluatedAt:new Date(effective).toISOString(),observationEndsAt:new Date(end).toISOString(),momentumObservations:[]};
}

/** Preserve learned price state and prior v2 momentum, but accept only new quotations after activation. */
export function migrateAdaptiveExitToV3(state:AdaptiveExitState,effectiveAt:string):AdaptiveExitState|undefined {
  const policy=adaptiveExitPolicy(state?.policyVersion),effective=time(effectiveAt);
  if(!policy||policy.version===ADAPTIVE_SHADOW_V3.version||!validState(state,policy)||state.shadowClosed||
    !Number.isFinite(effective)||effective<time(state.lastEvaluatedAt))return;
  const hasMomentum=policy.version===ADAPTIVE_SHADOW_V2.version;
  return {...state,policyVersion:ADAPTIVE_SHADOW_V3.version,policyEffectiveAt:new Date(effective).toISOString(),
    lastEvaluatedAt:new Date(effective).toISOString(),volatilityReturns:[...state.volatilityReturns],suggestedStages:[...state.suggestedStages],
    momentumEffectiveAt:hasMomentum?state.policyEffectiveAt:new Date(effective).toISOString(),
    momentumObservations:hasMomentum?state.momentumObservations!.map(sample=>({...sample})):[]};
}

function pressureSummary(pressure: WalletPressure | undefined, observation: PriceObservation, policy: AdaptiveExitPolicy):
  {summary?: WalletPressureSummary; reason?: AdaptiveExitStep['ignoredPressureReason']} {
  if (pressure === undefined) return {};
  const fail = (reason: AdaptiveExitStep['ignoredPressureReason']) => ({reason});
  if (!object(pressure) || !address(pressure.address, pressure.chain) || !Array.isArray(pressure.trades) ||
      !pressure.trades.length || pressure.trades.length > policy.maxWalletTrades) return fail('WALLET_PRESSURE_INVALID');
  if (!sameToken(pressure, observation)) return fail('WALLET_PRESSURE_IDENTITY_MISMATCH');
  const at = time(pressure.observedAt), start = time(pressure.windowStartAt), end = time(pressure.windowEndAt), sampleAt = time(observation.observedAt);
  if (![at, start, end].every(Number.isFinite) || start > end || end > at || at > sampleAt ||
      end - start > policy.maxWalletWindowMs) return fail('WALLET_PRESSURE_TIME_INVALID');
  if (sampleAt - at > policy.maxWalletAgeMs || sampleAt - end > policy.maxWalletAgeMs)
    return fail('WALLET_PRESSURE_STALE');
  const unique = new Map<string, WalletPressureTrade>();
  for (const trade of pressure.trades) {
    if (!object(trade) || typeof trade.evidenceId !== 'string' || !/^[\w.:/-]{1,200}$/.test(trade.evidenceId) ||
        !address(trade.wallet, observation.chain) || !['buy', 'sell'].includes(trade.side) ||
        !positive(trade.volumeUsd) || !sourceSet.has(trade.source)) return fail('WALLET_PRESSURE_INVALID');
    const eventAt = time(trade.eventAt), observedAt = time(trade.observedAt);
    if (![eventAt, observedAt].every(Number.isFinite) || eventAt < start || eventAt > end ||
        eventAt > observedAt || observedAt > at) return fail('WALLET_PRESSURE_TIME_INVALID');
    const previous = unique.get(trade.evidenceId);
    if (previous) {
      if (normalized(previous.wallet, observation.chain) !== normalized(trade.wallet, observation.chain) ||
          previous.side !== trade.side || previous.volumeUsd !== trade.volumeUsd || previous.eventAt !== trade.eventAt)
        return fail('WALLET_PRESSURE_EVIDENCE_CONFLICT');
      continue;
    }
    unique.set(trade.evidenceId, trade);
  }
  let buy = 0, sell = 0;
  const sources = new Set<WalletTradeSource>();
  for (const trade of unique.values()) {
    if (trade.side === 'buy') buy += trade.volumeUsd; else sell += trade.volumeUsd;
    sources.add(trade.source);
  }
  const total = buy + sell;
  if (!Number.isFinite(total)) return fail('WALLET_PRESSURE_INVALID');
  if (total < policy.walletMinVolumeUsd) return fail('WALLET_PRESSURE_VOLUME_INSUFFICIENT');
  const netSellRatio = Math.max(0, (sell - buy) / total);
  return {summary: {status: netSellRatio > 0 ? 'observed_net_selling' : 'observed_no_net_selling', netSellRatio,
    buyVolumeUsd: buy, sellVolumeUsd: sell, evidenceCount: unique.size, evidenceIds: [...unique.keys()], sources: [...sources],
    verification: sources.has('chain_transaction') ? sources.size === 1 ? 'chain_evidence' : 'mixed' : 'vendor_reported'}};
}

/** Pure forward-only shadow calculation. It never submits an order or claims a fill. */
export function stepAdaptiveExit(
  state: AdaptiveExitState | undefined, observation: PriceObservation,
  pressure?: WalletPressure, policy: AdaptiveExitPolicy = ADAPTIVE_SHADOW_V1,
): AdaptiveExitStep {
  const ignore = (ignoredReason: AdaptiveExitIgnoredReason): AdaptiveExitStep => ({status: 'ignored', state, ignoredReason});
  if (!supportedPolicy(policy)) return ignore('POLICY_UNSUPPORTED');
  if (state !== undefined && !validState(state, policy)) return ignore('STATE_INVALID');
  if (state && state.policyVersion !== policy.version) return ignore('STATE_POLICY_MISMATCH');
  if (!object(observation) || !address(observation.address, observation.chain) || !positive(observation.priceUsd) ||
      !['gmgn_token_info_sample','chain_pool_sample','dexscreener_token_pairs_sample','ave_price_stream_sample','debot_token_info_sample'].includes(observation.source)) return ignore('PRICE_INVALID');
  if (observation.source==='chain_pool_sample'&&!priceEvidence(observation)) return ignore('PRICE_INVALID');
  const observed = time(observation.observedAt), evaluated = time(observation.evaluatedAt);
  if (![observed, evaluated].every(Number.isFinite)) return ignore('TIME_INVALID');
  if (observed > evaluated) return ignore('PRICE_FROM_FUTURE');
  if (evaluated - observed > policy.maxPriceAgeMs) return ignore('PRICE_STALE');
  if (state) {
    if (!sameToken(state, observation)) return ignore('IDENTITY_MISMATCH');
    const previousAt = time(state.lastObservedAt);
    if (observed < previousAt || evaluated < time(state.lastEvaluatedAt) ||
      momentumPolicy(policy)&&observed<time(state.policyEffectiveAt)) return ignore('TIME_REGRESSED');
    if (observed === previousAt) return ignore(state.lastPriceUsd === observation.priceUsd ? 'DUPLICATE_SAMPLE' : 'SAMPLE_CONFLICT');
    if (state.shadowClosed) return ignore('SHADOW_CLOSED');
  }
  const wallet = pressureSummary(pressure, observation, policy);
  const common = wallet.reason ? {ignoredPressureReason: wallet.reason} : {};
  if (!state) {
    const hardStopPriceUsd = observation.priceUsd * (1 - policy.hardStopDropPct / 100);
    if (!positive(hardStopPriceUsd) || hardStopPriceUsd >= observation.priceUsd) return ignore('ARITHMETIC_INVALID');
    if(policy.version===ADAPTIVE_SHADOW_V2.version&&observation.observationEndsAt!==undefined&&
      (!Number.isFinite(time(observation.observationEndsAt))||time(observation.observationEndsAt)<=observed))return ignore('TIME_INVALID');
    const initial: AdaptiveExitState = {
      schemaVersion: 1, policyVersion: policy.version, chain: observation.chain,
      address: normalized(observation.address, observation.chain), baselinePriceUsd: observation.priceUsd,
      baselineAt: observation.observedAt, lastPriceUsd: observation.priceUsd,
      lastObservedAt: observation.observedAt, lastEvaluatedAt: observation.evaluatedAt,
      peakPriceUsd: observation.priceUsd, peakAt: observation.observedAt, hardStopPriceUsd,
      protectionPriceUsd: hardStopPriceUsd, protectionActive: false,
      activationGainPct: clamp(policy.fallbackVolatilityPctPerMinute * policy.activationVolatilityMultiplier,
        policy.minActivationGainPct, policy.maxActivationGainPct),
      drawdownPct: clamp(policy.baseDrawdownPct + Math.min(policy.maxVolatilityWideningPct,
        policy.fallbackVolatilityPctPerMinute * policy.volatilityDrawdownMultiplier), policy.minDrawdownPct, policy.maxDrawdownPct),
      volatilityPctPerMinute: policy.fallbackVolatilityPctPerMinute, volatilityReturns: [],
      lastSampleGapMs: 0, maxSampleGapMs: 0, gapCount: 0, samples: 1,
      suggestedStages: [], remainingPctOfInitial: 100, shadowClosed: false,
      ...(wallet.summary ? {walletPressure: wallet.summary} : {}),
      ...(momentumPolicy(policy)?{policyEffectiveAt:observation.observedAt,
        ...(policy.version===ADAPTIVE_SHADOW_V2.version?{observationEndsAt:observation.observationEndsAt}:{momentumEffectiveAt:observation.observedAt}),
        momentumObservations:[{observedAt:observation.observedAt,priceUsd:observation.priceUsd}]}:{}),
    };
    return {status: 'initialized', state: initial, ...common};
  }
  const gap = observed - time(state.lastObservedAt), longGap = gap > policy.maxVolatilityGapMs;
  const rate = Math.abs(Math.log(observation.priceUsd) - Math.log(state.lastPriceUsd)) * 100 / (gap / 60_000);
  if (!Number.isFinite(rate)) return ignore('ARITHMETIC_INVALID');
  const returns = longGap ? [] : [...state.volatilityReturns, rate].slice(-policy.volatilityWindow);
  const volatility = returns.length >= policy.minimumVolatilitySamples ? median(returns) : policy.fallbackVolatilityPctPerMinute;
  const peak = Math.max(state.peakPriceUsd, observation.priceUsd);
  const gain = (observation.priceUsd / state.baselinePriceUsd - 1) * 100;
  const peakGain = (peak / state.baselinePriceUsd - 1) * 100;
  if (![gain, peakGain].every(Number.isFinite)) return ignore('ARITHMETIC_INVALID');
  const activation = clamp(volatility * policy.activationVolatilityMultiplier, policy.minActivationGainPct, policy.maxActivationGainPct);
  const active = state.protectionActive || peakGain >= activation;
  const gainTightening = policy.gainTightening.reduce((maximum, tier) => peakGain >= tier.gainPct ? Math.max(maximum, tier.tightenPct) : maximum, 0);
  const walletTightening = (wallet.summary?.netSellRatio ?? 0) * policy.walletMaxTighteningPct;
  const drawdown = clamp(policy.baseDrawdownPct + Math.min(policy.maxVolatilityWideningPct,
    volatility * policy.volatilityDrawdownMultiplier) - gainTightening - walletTightening,
    policy.minDrawdownPct, policy.maxDrawdownPct);
  const protection = Math.max(state.protectionPriceUsd, state.hardStopPriceUsd, active ? peak * (1 - drawdown / 100) : 0);
  const drawdownWithoutWallet = clamp(policy.baseDrawdownPct + Math.min(policy.maxVolatilityWideningPct,
    volatility * policy.volatilityDrawdownMultiplier) - gainTightening, policy.minDrawdownPct, policy.maxDrawdownPct);
  const protectionWithoutWallet = Math.max(state.protectionPriceUsd, state.hardStopPriceUsd,
    active ? peak * (1 - drawdownWithoutWallet / 100) : 0);
  if (!positive(protection)) return ignore('ARITHMETIC_INVALID');
  const next: AdaptiveExitState = {...state, lastPriceUsd: observation.priceUsd,
    lastObservedAt: observation.observedAt, lastEvaluatedAt: observation.evaluatedAt,
    peakPriceUsd: peak, peakAt: observation.priceUsd > state.peakPriceUsd ? observation.observedAt : state.peakAt,
    protectionPriceUsd: protection, protectionActive: active, activationGainPct: activation, drawdownPct: drawdown,
    volatilityPctPerMinute: volatility, volatilityReturns: returns, lastSampleGapMs: gap,
    maxSampleGapMs: Math.max(state.maxSampleGapMs, gap), gapCount: state.gapCount + (longGap ? 1 : 0), samples: state.samples + 1,
    suggestedStages: [...state.suggestedStages], walletPressure: wallet.summary};
  let momentumStalled=false;
  if(momentumPolicy(policy)){
    const samples=longGap?[]:[...(state.momentumObservations??[])].filter(p=>time(p.observedAt)>=observed-policy.momentumWindowMs!);
    const last=samples.at(-1);
    if(last&&Math.floor(time(last.observedAt)/60_000)===Math.floor(observed/60_000))samples.pop();
    samples.push({observedAt:observation.observedAt,priceUsd:observation.priceUsd});
    next.momentumObservations=samples.slice(-32);
    const first=next.momentumObservations[0],span=observed-time(first.observedAt);
    const windowChangePct=(observation.priceUsd/first.priceUsd-1)*100;
    momentumStalled=observed-time(policy.version===ADAPTIVE_SHADOW_V3.version?state.momentumEffectiveAt:state.policyEffectiveAt)>=policy.momentumMinimumHoldMs!&&
      observed-time(next.peakAt)>=policy.momentumPeakQuietMs!&&next.momentumObservations.length>=policy.momentumMinimumSamples!&&
      span>=policy.momentumMinimumSpanMs!&&peakGain>=policy.minActivationGainPct&&
      (1-observation.priceUsd/peak)*100>=policy.momentumMinDrawdownPct!&&
      Math.abs(windowChangePct)<=policy.momentumMaxChangePct!&&
      // V3 lets a recovery keep running, even when it remains below an earlier peak.
      (policy.version!==ADAPTIVE_SHADOW_V3.version||windowChangePct<=0);
  }
  const deadline=adaptiveExitDeadline(next),deadlineReached=!!deadline&&observed>=time(deadline.dueAt);
  const hardStop = observation.priceUsd <= state.hardStopPriceUsd;
  const protectionHit = active && observation.priceUsd <= protection;
  const stages = policy.partialExits.filter(stage => gain >= stage.gainPct && !state.suggestedStages.includes(stage.gainPct));
  if (!hardStop && !protectionHit && !deadlineReached && !momentumStalled && !stages.length) return {status: 'observed', state: next, ...common};
  const reasons: AdaptiveExitReason[] = [];
  let sellPctRemaining: number;
  if (hardStop || protectionHit || deadlineReached || momentumStalled) {
    reasons.push(hardStop ? 'HARD_STOP_OBSERVED' : protectionHit ? 'DYNAMIC_PROTECTION_OBSERVED' : deadlineReached ? deadline!.reason : 'MOMENTUM_STALLED_OBSERVED');
    sellPctRemaining = 100; next.remainingPctOfInitial = 0; next.shadowClosed = true;
  } else {
    reasons.push('PARTIAL_PROFIT_STAGE_OBSERVED');
    let retained = 1;
    for (const stage of stages) {retained *= 1 - stage.sellPctRemaining / 100; next.suggestedStages.push(stage.gainPct);}
    sellPctRemaining = Number(((1 - retained) * 100).toFixed(10));
    next.remainingPctOfInitial = Number((next.remainingPctOfInitial * retained).toFixed(10));
  }
  if (!hardStop && protection > protectionWithoutWallet) reasons.push('WALLET_NET_SELLING_TIGHTENED');
  const event: AdaptiveExitEvent = {policyVersion: policy.version, mode: 'shadow', execution: 'observation_only',
    kind: next.shadowClosed ? 'full_exit' : 'partial_exit', observedAt: observation.observedAt, evaluatedAt: observation.evaluatedAt,
    observedPriceUsd: observation.priceUsd, baselinePriceUsd: state.baselinePriceUsd, observedGainPct: gain,
    peakPriceUsd: peak, protectionPriceUsd: protection, sellRatioType: 'remaining_holding', sellPctRemaining,
    remainingPctOfInitial: next.remainingPctOfInitial, reasons, stageGainsPct: next.shadowClosed ? [] : stages.map(stage => stage.gainPct),
    ...(wallet.summary ? {walletPressure: wallet.summary} : {})};
  return {status: 'observed', state: next, event, ...common};
}
