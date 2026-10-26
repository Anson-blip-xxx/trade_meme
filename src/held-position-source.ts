import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';

const SOL = 'So11111111111111111111111111111111111111112';
const MAX_ROWS = 1_000;
const MAX_PAYLOAD_BYTES = 1_000_000;
const MAX_U64 = (1n << 64n) - 1n;

/** An observation seed, never an execution order or proof of the current wallet balance. */
export interface HeldPositionSeed {
  id: string;
  source: 'controlled_test';
  chain: 'solana';
  wallet: string;
  tokenAddress: string;
  name?: string;
  symbol?: string;
  providerOrderId?: string;
  transactionHash: string;
  inputAmount: string;
  outputAmount: string;
  tokenDecimals: number;
  confirmedAt: string;
  entryPriceUsd?: number;
  entryPriceSol?: number;
  buySlot: number;
  /** Both bases exclude fees and rent; a requested ExactIn amount is not a verified fill report. */
  costBasis: 'confirmed_fill' | 'requested_exact_in';
}
export interface ControlledHoldingsReadResult {items: HeldPositionSeed[]; reasons: string[];}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
function base58(value: unknown, size: number): value is string {
  if (typeof value !== 'string' || value.length > size * 2) return false;
  try {const bytes = bs58.decode(value); return bytes.length === size && bs58.encode(bytes) === value;}
  catch {return false;}
}
function amount(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(value)) return;
  const n = BigInt(value); return n <= MAX_U64 ? n : undefined;
}
function signedAmount(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^(?:0|-?[1-9]\d{0,19})$/.test(value)) return;
  const n = BigInt(value); return n >= -MAX_U64 && n <= MAX_U64 ? n : undefined;
}
const slot = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const decimals = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}
function parse(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_PAYLOAD_BYTES) return;
  try {const parsed: unknown = JSON.parse(value); return object(parsed) ? parsed : undefined;} catch {return;}
}
function positivePrice(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.length > 80 ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))) return;
  const n = Number(value); return Number.isFinite(n) && n > 0 ? n : undefined;
}

function seed(row: Record<string, unknown>, expectedWallet: string, reasons: Set<string>): HeldPositionSeed | undefined {
  const reject = (reason: string) => {reasons.add(reason); return undefined;};
  const run = parse(row.run_payload);
  if (!run || run.id !== row.row_id || run.wallet !== row.row_wallet || run.wallet !== expectedWallet ||
      !identifier(run.id) || !base58(run.mint, 32) || run.mint === SOL)
    return reject('CONTROLLED_HOLDING_RUN_INVALID');
  if (run.buy === undefined) return; // Normal preflight/failed runs are not holdings.
  const buy = run.buy;
  if (!object(buy) || buy.side !== 'buy' || buy.wallet !== expectedWallet || buy.mint !== run.mint ||
      !base58(buy.signature, 64) || !slot(buy.slot) || !decimals(buy.decimals) || !timestamp(buy.checkedAt) ||
      !timestamp(run.createdAt) || Date.parse(buy.checkedAt) < Date.parse(run.createdAt))
    return reject('CONTROLLED_HOLDING_BUY_INVALID');
  const before = amount(buy.preTokenAmount), after = amount(buy.postTokenAmount), quantity = amount(buy.tokenDelta);
  const nativeBefore = amount(buy.preNativeLamports), nativeAfter = amount(buy.postNativeLamports);
  const nativeDelta = signedAmount(buy.nativeDelta), fee = amount(buy.feeLamports);
  if (before === undefined || after === undefined || quantity === undefined || quantity <= 0n || after - before !== quantity ||
      nativeBefore === undefined || nativeAfter === undefined || nativeDelta === undefined || nativeDelta >= 0n ||
      nativeAfter - nativeBefore !== nativeDelta || fee === undefined)
    return reject('CONTROLLED_HOLDING_AMOUNTS_INVALID');

  // An acknowledged sell (or merely phase=complete) is not proof that the current holding is zero.
  const final = run.finalSnapshot;
  if (final !== undefined) {
    const validFinal = object(final) && final.wallet === expectedWallet && final.mint === run.mint &&
      final.decimals === buy.decimals && slot(final.slot) && final.slot >= buy.slot &&
      slot(final.nativeSlot) && final.nativeSlot >= buy.slot && timestamp(final.checkedAt) &&
      Date.parse(final.checkedAt) >= Date.parse(buy.checkedAt) && amount(final.tokenAmount) !== undefined;
    if (validFinal && final.tokenAmount === '0') return;
    if (!validFinal) reasons.add('CONTROLLED_HOLDING_FINAL_BALANCE_UNVERIFIED');
  }
  if (run.sell !== undefined) reasons.add('CONTROLLED_HOLDING_SELL_REQUIRES_BALANCE_CHECK');

  const operation = parse(row.buy_payload);
  if (!operation || operation.runId !== run.id || operation.key !== 'buy' ||
      !['submitting', 'acknowledged', 'unknown'].includes(String(operation.state)) || !object(operation.body))
    return reject('CONTROLLED_HOLDING_OPERATION_INVALID');
  const body = operation.body;
  const requested = amount(body.input_amount);
  if (body.chain !== 'sol' || body.from_address !== expectedWallet || body.input_token !== SOL || body.output_token !== run.mint ||
      body.swap_mode !== 'ExactIn' || requested === undefined || requested <= 0n ||
      amount(run.amountLamports) !== requested)
    return reject('CONTROLLED_HOLDING_REQUEST_MISMATCH');
  const response = object(operation.response) ? operation.response : undefined;
  if (response?.hash !== undefined && response.hash !== buy.signature)
    return reject('CONTROLLED_HOLDING_RECEIPT_MISMATCH');
  let input = requested, basis: HeldPositionSeed['costBasis'] = 'requested_exact_in', entryPriceUsd: number | undefined;
  if (response?.report !== undefined) {
    const report = response.report;
    if (!object(report) || report.input_token !== SOL || report.output_token !== run.mint || report.input_token_decimals !== 9 ||
        report.output_token_decimals !== buy.decimals || amount(report.output_amount) !== quantity ||
        amount(report.input_amount) === undefined || amount(report.input_amount)! <= 0n || amount(report.input_amount)! > requested ||
        response.hash !== buy.signature || !(response.status === 'confirmed' || response.status === 'successful' && response.state === 30))
      return reject('CONTROLLED_HOLDING_RECEIPT_MISMATCH');
    input = amount(report.input_amount)!; basis = 'confirmed_fill'; entryPriceUsd = positivePrice(report.price_usd);
  } else reasons.add('CONTROLLED_HOLDING_REQUESTED_COST_BASIS');
  const entryPriceSol = Number(input) * 10 ** buy.decimals / (1e9 * Number(quantity));
  return {id: `controlled-test:${run.id}`, source: 'controlled_test', chain: 'solana', wallet: expectedWallet,
    tokenAddress: run.mint, transactionHash: buy.signature, inputAmount: input.toString(), outputAmount: quantity.toString(),
    tokenDecimals: buy.decimals, confirmedAt: new Date(buy.checkedAt).toISOString(), buySlot: buy.slot, costBasis: basis,
    ...(response && identifier(response.order_id) ? {providerOrderId: response.order_id} : {}),
    ...(entryPriceUsd !== undefined ? {entryPriceUsd} : {}),
    ...(Number.isFinite(entryPriceSol) && entryPriceSol > 0 ? {entryPriceSol} : {})};
}

/** Open an existing journal read-only. No migrations, WAL writes, orders, network calls, or execution imports. */
export function readControlledHoldings(path: string, expectedWallet: string): ControlledHoldingsReadResult {
  const result: ControlledHoldingsReadResult = {items: [], reasons: []};
  if (!base58(expectedWallet, 32)) return {...result, reasons: ['CONTROLLED_HOLDINGS_WALLET_INVALID']};
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:'))
    return {...result, reasons: ['CONTROLLED_HOLDINGS_PATH_INVALID']};
  if (!existsSync(path)) return result;
  let db: DatabaseSync | undefined;
  const reasons = new Set<string>();
  try {
    db = new DatabaseSync(path, {readOnly: true});
    const rows = db.prepare(`SELECT r.id AS row_id,r.wallet AS row_wallet,r.payload AS run_payload,o.payload AS buy_payload
      FROM controlled_test_runs r LEFT JOIN controlled_test_operations o ON o.run_id=r.id AND o.operation_key='buy'
      WHERE r.wallet=? ORDER BY r.created_at DESC,r.id LIMIT ?`).all(expectedWallet, MAX_ROWS + 1);
    if (rows.length > MAX_ROWS) reasons.add('CONTROLLED_HOLDINGS_LIMIT_REACHED');
    const seen = new Set<string>();
    for (const row of rows.slice(0, MAX_ROWS)) {
      const value = seed(row, expectedWallet, reasons); if (!value) continue;
      const identity = `${value.wallet}:${value.tokenAddress}:${value.transactionHash}`;
      if (seen.has(identity)) {reasons.add('CONTROLLED_HOLDING_DUPLICATE_TRANSACTION'); continue;}
      seen.add(identity); result.items.push(value);
    }
  } catch {reasons.add('CONTROLLED_HOLDINGS_READ_FAILED');}
  finally {try {db?.close();} catch {reasons.add('CONTROLLED_HOLDINGS_READ_FAILED');}}
  result.reasons = [...reasons]; return result;
}

export function listControlledHoldings(path: string, expectedWallet: string): HeldPositionSeed[] {
  return readControlledHoldings(path, expectedWallet).items;
}
