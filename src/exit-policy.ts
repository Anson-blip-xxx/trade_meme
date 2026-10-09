import {z} from 'zod';

/** Owner-controlled settings only. Never derive this policy from a signal or report. */
export interface ExitPolicy {
  readonly enabled: true;
  readonly sellRatioType: 'hold_amount';
  readonly takeProfit: readonly [
    Readonly<{gainPct: 500; sellPct: 20}>,
    Readonly<{gainPct: 1000; sellPct: 10}>,
  ];
  readonly stopLoss: Readonly<{dropPct: 40; sellPct: 100}>;
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
  takeProfit: z.tuple([
    z.object({gainPct: z.literal(500), sellPct: z.literal(20)}).strict(),
    z.object({gainPct: z.literal(1000), sellPct: z.literal(10)}).strict(),
  ]),
  stopLoss: z.object({dropPct: z.literal(40), sellPct: z.literal(100)}).strict(),
}).strict();

/**
 * No settings disables exits. Explicitly disabled settings must contain only enabled:false.
 * An enabled policy must reproduce the three owner-authorized thresholds exactly;
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
      takeProfit: Object.freeze([
        Object.freeze({...parsed.data.takeProfit[0]}),
        Object.freeze({...parsed.data.takeProfit[1]}),
      ] as const),
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
