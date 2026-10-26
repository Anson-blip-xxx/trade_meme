import bs58 from 'bs58';
import {createHash} from 'node:crypto';
import type {Chain} from './types.js';
import {CURRENT_STOP_LOSS_DROP_PCT,LEGACY_STOP_LOSS_DROP_PCT} from './exit-policy.js';

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
  status: 'cancel' | 'success' | 'failed' | 'unknown' | 'check' | 'running';
}

export interface ExitStrategyAssessment {
  status: 'verified' | 'observed' | 'degraded' | 'unknown' | 'terminal';
  reasons: string[];
  found: boolean;
  policyMatched: boolean;
  hasLiveStop: boolean;
  /** Provider observation of the exact attached stop; not proof of future automatic execution. */
  observedLiveStop?: boolean;
  automaticTriggerVerified?: false;
  linkage?: 'transaction_hash' | 'amount_time_match';
  strategyOrderId?: string;
  parentFingerprint?: string;
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
      !Array.isArray(expected.policyConditions) || expected.policyConditions.length < 2 || expected.policyConditions.length > 9 ||
      expected.policyConditions.filter(c => object(c) && c.order_type === 'loss_stop').length !== 1 ||
      expected.policyConditions.filter(c => object(c) && c.order_type === 'profit_stop').length !== expected.policyConditions.length - 1 ||
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

/** A finalized chain transaction and an identity-matched GMGN fill; never an indicative quote. */
export interface ThirdSignalFill {
  source:'solana_finalized';transactionHash:string;wallet:string;tokenAddress:string;
  inputAmount:string;outputAmount:string;tokenDecimals:number;buySlot:number;confirmedAt:string;observedAt:string;
  priceUsd?:number;
}
export interface ObservedExitExpectation extends Omit<ExpectedExitStrategy,'strategyOrderId'> {
  strategyOrderId?:string;fill:ThirdSignalFill;
}
const positiveAtom=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v)&&BigInt(v)<=(1n<<64n)-1n;
export function validThirdSignalFill(fill:unknown,expected:Pick<ObservedExitExpectation,'chain'|'wallet'|'tokenAddress'|'inputToken'|'openingTransactionHash'>,
  now=new Date()):fill is ThirdSignalFill {
  if(!object(fill)||expected.chain!=='solana'||expected.inputToken!=='So11111111111111111111111111111111111111112'||fill.source!=='solana_finalized'||
    !validAddress(expected.wallet,'solana')||!validAddress(expected.tokenAddress,'solana')||!validHash(expected.openingTransactionHash,'solana')||
    fill.wallet!==expected.wallet||fill.tokenAddress!==expected.tokenAddress||fill.transactionHash!==expected.openingTransactionHash||
    !positiveAtom(fill.inputAmount)||!positiveAtom(fill.outputAmount)||!Number.isInteger(fill.tokenDecimals)||Number(fill.tokenDecimals)<0||Number(fill.tokenDecimals)>255||
    !Number.isSafeInteger(fill.buySlot)||Number(fill.buySlot)<=0||typeof fill.confirmedAt!=='string'||typeof fill.observedAt!=='string')return false;
  const confirmed=Date.parse(fill.confirmedAt),observed=Date.parse(fill.observedAt),current=now.getTime();
  return [confirmed,observed,current].every(Number.isFinite)&&confirmed<=observed+5000&&observed<=current+5000&&
    (fill.priceUsd===undefined||typeof fill.priceUsd==='number'&&Number.isFinite(fill.priceUsd)&&fill.priceUsd>0);
}

/** Strict observation for the owner's SOL third-notification policy only. Legacy assessment remains unchanged. */
export function assessObservedExitStrategy(payload:unknown,expected:ObservedExitExpectation,now=new Date()):ExitStrategyAssessment {
  const result:ExitStrategyAssessment={status:'unknown',found:false,policyMatched:false,hasLiveStop:false,observedLiveStop:false,
    automaticTriggerVerified:false,terminal:false,conditions:[],checkedAt:now.toISOString(),reasons:[]};
  const fail=(code:string,status:ExitStrategyAssessment['status']='unknown')=>{result.status=status;result.reasons.push(code);return result;};
  const policy=Array.isArray(expected.policyConditions)?expected.policyConditions:[];
  const expectedProfit=policy.find(c=>object(c)&&c.order_type==='profit_stop'),expectedStop=policy.find(c=>object(c)&&c.order_type==='loss_stop');
  const expectedKeys=policy.map(conditionKey),stopScale=expectedStop&&decimal(expectedStop.price_scale);
  const wanted=expectedKeys.every((key):key is string=>key!==undefined)?[...expectedKeys].sort():[];
  if(expected.chain!=='solana'||expected.sellRatioType!=='hold_amount'||expected.strategyOrderId!==undefined&&!identifier(expected.strategyOrderId)||
    !validThirdSignalFill(expected.fill,expected,now)||policy.length!==2||wanted.length!==2||new Set(wanted).size!==2||
    expectedProfit?.price_scale!=='100'||expectedProfit.sell_ratio!=='50'||expectedStop?.sell_ratio!=='100'||
    ![String(LEGACY_STOP_LOSS_DROP_PCT),String(CURRENT_STOP_LOSS_DROP_PCT)].includes(stopScale??''))
    return fail('EXIT_OBSERVATION_EXPECTATION_INVALID');
  if(!object(payload)||!Array.isArray(payload.list)||payload.list.length>1000||payload.list.some(row=>!object(row))||
    payload.next_page_token!==undefined&&payload.next_page_token!==''||payload.total!==undefined&&(!Number.isSafeInteger(payload.total)||Number(payload.total)!==payload.list.length))
    return fail('EXIT_OBSERVATION_PAGE_INCOMPLETE');
  const seen=new Set<string>(),candidates:{row:Record<string,unknown>;linkage:'transaction_hash'|'amount_time_match'}[]=[];
  for(const value of payload.list){const row=value as Record<string,unknown>;
    if(!identifier(row.order_id)||seen.has(row.order_id)||row.chain!=='sol'||row.wallet_address!==expected.wallet||row.base_token!==expected.tokenAddress)
      return fail('EXIT_OBSERVATION_RESPONSE_IDENTITY_INVALID');
    seen.add(row.order_id);
    const fill=expected.fill,created=typeof row.create_time==='number'?row.create_time:
      typeof row.create_time==='string'&&/^\d{13,16}$/.test(row.create_time)?Number(row.create_time):NaN;
    const amounts=row.quote_investment===fill.inputAmount&&row.open_amount===fill.outputAmount&&row.base_decimal===fill.tokenDecimals&&row.quote_decimal===9&&
      (!object(row.order_statistic)||row.order_statistic.buy_amount===undefined||row.order_statistic.buy_amount===fill.outputAmount);
    const time=Number.isSafeInteger(created)&&created>=1_000_000_000_000&&created<=now.getTime()+5000&&Math.abs(created-Date.parse(fill.confirmedAt))<=120000;
    const matchingHash=row.open_sign_hash===expected.openingTransactionHash;
    const missingHash=row.open_sign_hash===undefined||row.open_sign_hash===null||row.open_sign_hash==='';
    if(row.quote_token!==expected.inputToken||!amounts||!time||!matchingHash&&!missingHash){
      if(expected.strategyOrderId===row.order_id)return fail('EXIT_OBSERVATION_PARENT_BINDING_CHANGED');
      continue;
    }
    candidates.push({row,linkage:matchingHash?'transaction_hash':'amount_time_match'});
  }
  if(candidates.length!==1)return fail(candidates.length?'EXIT_OBSERVATION_PARENT_AMBIGUOUS':'EXIT_OBSERVATION_PARENT_NOT_OBSERVED');
  const {row,linkage}=candidates[0];
  if(expected.strategyOrderId!==undefined&&row.order_id!==expected.strategyOrderId)return fail('EXIT_OBSERVATION_PARENT_NOT_OBSERVED');
  result.found=true;result.strategyOrderId=row.order_id as string;result.linkage=linkage;
  if(row.order_type!=='smart_trade'||row.sub_order_type!=='mix_trade'||row.sell_ratio_type!=='hold_amount')return fail('EXIT_OBSERVATION_POLICY_MISMATCH','degraded');
  if(!Array.isArray(row.condition_orders)||row.condition_orders.length!==2)return fail('EXIT_CONDITIONS_INCOMPLETE','degraded');
  const keys=row.condition_orders.map(conditionKey);
  if(JSON.stringify(keys.sort())!==JSON.stringify(wanted))return fail('EXIT_CONDITION_POLICY_MISMATCH','degraded');
  const conditions=row.condition_orders as Record<string,unknown>[];
  if(conditions.some(c=>!identifier(c.cid))||new Set(conditions.map(c=>c.cid)).size!==2)return fail('EXIT_CONDITION_IDS_INVALID');
  if(expected.fill.priceUsd!==undefined&&conditions.some(c=>{
    if(!Object.hasOwn(c,'check_price'))return false;
    const price=Number(c.check_price),scale=Number(decimal(c.price_scale));
    const wantedPrice=expected.fill.priceUsd!*(c.order_type==='profit_stop'?1+scale/100:1-scale/100);
    return !['string','number'].includes(typeof c.check_price)||!Number.isFinite(price)||price<=0||Math.abs(price-wantedPrice)>wantedPrice*0.000001;
  }))return fail('EXIT_OBSERVATION_TRIGGER_PRICE_CONFLICT','degraded');
  result.policyMatched=true;
  result.conditions=conditions.map(c=>({cid:c.cid as string,orderType:c.order_type as ExitPolicyCondition['order_type'],
    priceScale:decimal(c.price_scale)!,sellRatio:decimal(c.sell_ratio)!,
    status:['check','running','success','cancel','failed'].includes(String(c.status))?c.status as ExitConditionObservation['status']:'unknown'}));
  result.parentFingerprint=createHash('sha256').update(JSON.stringify({id:row.order_id,wallet:row.wallet_address,token:row.base_token,
    quote:row.quote_token,created:Number(row.create_time),input:row.quote_investment,output:row.open_amount,
    decimals:row.base_decimal,conditions:result.conditions.map(({status,...condition})=>condition).sort((a,b)=>a.cid.localeCompare(b.cid))})).digest('hex');
  if(row.status==='open'||row.status==='closed')result.parentStatus=row.status;
  if(row.strategy_status==='running'||row.strategy_status==='stopped')result.strategyStatus=row.strategy_status;
  if(validHash(row.close_sign_hash,'solana'))result.closeTransactionHash=row.close_sign_hash;
  if(result.conditions.some(c=>c.status==='unknown'))return fail('EXIT_CONDITION_STATUS_UNKNOWN');
  const statistic=row.order_statistic,success=result.conditions.filter(c=>c.status==='success').length;
  // GMGN reports a manually cancelled parent as canceled/canceled. A failed
  // stop remains a failed attempt; cancellation never proves a successful sell.
  // This only permits the existing finalized zero-balance check to close it.
  const cancelled=row.status==='canceled'&&row.strategy_status==='canceled'&&
    result.conditions.every(c=>['cancel','success','failed'].includes(c.status));
  const failed=result.conditions.filter(c=>c.status==='failed').length;
  if(cancelled&&object(statistic)&&Number.isSafeInteger(statistic.success_sell_num)&&statistic.success_sell_num===success&&
    Number.isSafeInteger(statistic.sell_num)&&statistic.sell_num===success+failed&&
    (success>0||row.close_sign_hash===undefined||row.close_sign_hash===null||row.close_sign_hash==='')){
    result.parentStatus='closed';result.strategyStatus='stopped';result.reportedSuccessfulSellCount=success;
    result.status='terminal';result.terminal=true;result.reasons.push('EXIT_STRATEGY_CANCELED_BALANCE_CHECK_REQUIRED');return result;
  }
  if(!object(statistic)||!Number.isSafeInteger(statistic.success_sell_num)||statistic.success_sell_num!==success||
    statistic.sell_num!==undefined&&statistic.sell_num!==success||success>0&&statistic.sell_num!==success||
    success===0&&row.close_sign_hash!==undefined&&row.close_sign_hash!==null&&row.close_sign_hash!=='')return fail('EXIT_OBSERVATION_SELL_STATE_UNKNOWN');
  result.reportedSuccessfulSellCount=success;
  if(result.parentStatus==='closed'&&result.strategyStatus==='stopped'&&result.conditions.every(c=>['cancel','success','failed'].includes(c.status))){
    result.status='terminal';result.terminal=true;result.reasons.push('EXIT_STRATEGY_TERMINAL_BALANCE_CHECK_REQUIRED');return result;
  }
  const stop=result.conditions.find(c=>c.orderType==='loss_stop')!,profit=result.conditions.find(c=>c.orderType==='profit_stop')!;
  if(result.parentStatus!=='open'||result.strategyStatus!=='running'||!['check','running'].includes(stop.status)||!['check','running','success'].includes(profit.status))
    return fail('EXIT_OBSERVATION_STOP_NOT_ACTIVE','degraded');
  result.status='observed';result.observedLiveStop=true;
  result.reasons.push(linkage==='transaction_hash'?'EXIT_OBSERVATION_HASH_MATCH':'EXIT_OBSERVATION_AMOUNT_TIME_MATCH_ONLY','EXIT_PROVIDER_STOP_OBSERVED_TRIGGER_NOT_VERIFIED');
  return result;
}
