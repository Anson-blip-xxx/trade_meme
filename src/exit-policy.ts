import {z} from 'zod';

/** Owner-controlled settings only. Never derive this policy from a signal or report. */
export interface ExitPolicy {
  readonly enabled: true;
  readonly sellRatioType: 'hold_amount';
  readonly takeProfit: readonly Readonly<{gainPct:number;sellPct:number}>[];
  readonly stopLoss: Readonly<{dropPct: StopLossDropPct; sellPct: 100}>;
}

export const CURRENT_STOP_LOSS_DROP_PCT = 60 as const;
export const LEGACY_STOP_LOSS_DROP_PCT = 40 as const;
export type StopLossDropPct = typeof CURRENT_STOP_LOSS_DROP_PCT | typeof LEGACY_STOP_LOSS_DROP_PCT;

export function isCurrentExitPolicy(policy: ExitPolicy | undefined): policy is ExitPolicy {
  return !!policy && policy.sellRatioType === 'hold_amount' && policy.takeProfit.length === 1 &&
    policy.takeProfit[0]?.gainPct === 100 && policy.takeProfit[0].sellPct === 50 &&
    policy.stopLoss.dropPct === CURRENT_STOP_LOSS_DROP_PCT && policy.stopLoss.sellPct === 100;
}

export function stopLossPricePct(dropPct: StopLossDropPct): number {
  return 100 - dropPct;
}

export interface GmgnConditionOrder {
  order_type: 'profit_stop' | 'loss_stop';
  side: 'sell';
  price_scale: string;
  sell_ratio: string;
}

export type ExitPolicyErrorReason = 'EXIT_POLICY_INVALID' | 'EXIT_POLICY_FULL_STOP_REQUIRES_HOLD_AMOUNT';

/** Do not expose settings contents or upstream validation errors in logs. */
export class ExitPolicyError extends Error {
  constructor(readonly reason: ExitPolicyErrorReason) {
    super(reason);
    this.name = 'ExitPolicyError';
  }
}

const disabledSchema = z.object({enabled: z.literal(false)}).strict();
const enabledSchema = z.object({
  enabled: z.literal(true),
  // Recognize this spelling only to give a precise rejection of the unsupported basis.
  sellRatioType: z.enum(['hold_amount', 'buy_amount']),
  takeProfit: z.union([z.tuple([z.object({gainPct:z.literal(100),sellPct:z.literal(50)}).strict()]),z.tuple([
    z.object({gainPct: z.literal(500), sellPct: z.literal(20)}).strict(),
    z.object({gainPct: z.literal(1000), sellPct: z.literal(10)}).strict(),
  ])]),
  // 40 remains readable for immutable historical orders. New runtime config is
  // restricted to CURRENT_STOP_LOSS_DROP_PCT by readConfig.
  stopLoss: z.object({dropPct: z.union([z.literal(CURRENT_STOP_LOSS_DROP_PCT), z.literal(LEGACY_STOP_LOSS_DROP_PCT)]),
    sellPct: z.literal(100)}).strict(),
}).strict();

/**
 * No settings disables exits. Explicitly disabled settings must contain only enabled:false.
 * An enabled policy must reproduce either the current principal-recovery plan or the legacy owner plan exactly;
 * omitted fields, coercion, additional orders and alternate execution settings fail closed.
 */
export function parseExitPolicy(input: unknown): ExitPolicy | undefined {
  if (input === undefined) return undefined;
  try {
    if (disabledSchema.safeParse(input).success) return undefined;
    const parsed = enabledSchema.safeParse(input);
    if (!parsed.success) throw new ExitPolicyError('EXIT_POLICY_INVALID');
    if (parsed.data.sellRatioType !== 'hold_amount') {
      // Selling the original buy amount cannot express 100% of the remaining holding.
      throw new ExitPolicyError('EXIT_POLICY_FULL_STOP_REQUIRES_HOLD_AMOUNT');
    }
    return Object.freeze({
      enabled: true,
      sellRatioType: 'hold_amount',
      takeProfit: Object.freeze(parsed.data.takeProfit.map(tier=>Object.freeze({...tier}))) as ExitPolicy['takeProfit'],
      stopLoss: Object.freeze({...parsed.data.stopLoss}),
    });
  } catch (error) {
    if (error instanceof ExitPolicyError) throw error;
    throw new ExitPolicyError('EXIT_POLICY_INVALID');
  }
}

/** Percentages remain GMGN percentage strings: +500% is 6x, not 5x. */
export function buildExitConditions(policy: ExitPolicy): GmgnConditionOrder[] {
  // Revalidate at the transport boundary, including callers that bypass TypeScript types.
  const checked = parseExitPolicy(policy);
  if (!checked) throw new ExitPolicyError('EXIT_POLICY_INVALID');
  return [
    ...checked.takeProfit.map(tier => ({
      order_type: 'profit_stop' as const,
      side: 'sell' as const,
      price_scale: String(tier.gainPct),
      sell_ratio: String(tier.sellPct),
    })),
    {order_type: 'loss_stop', side: 'sell', price_scale: String(checked.stopLoss.dropPct),
      sell_ratio: String(checked.stopLoss.sellPct)},
  ];
}
