import bs58 from 'bs58';
import {setTimeout as delay} from 'node:timers/promises';
import {isAddress} from 'viem';
import type {Config} from './config.js';
import {rpc, type Fetcher} from './http.js';
import type {Chain} from './types.js';
import type {OpeningOrder} from './orders.js';

export interface NativeBalance {
  status: 'verified' | 'unknown';
  /** Exact atomic units: lamports for SOL, wei for BNB and ETH. */
  amount?: string;
  checkedAt: string;
  readStartedAt: string;
  blockNumber?: string;
  slot?: number;
  reasons: string[];
}
export interface NativeCurrency {
  readonly symbol: 'BNB' | 'SOL' | 'ETH';
  readonly decimals: 9 | 18;
}
/** GMGN execution identifiers, not asset identifiers returned by portfolio info. */
export const NATIVE_INPUT_TOKENS: Readonly<Record<Chain, string>> = Object.freeze({
  bsc: '0x0000000000000000000000000000000000000000',
  solana: 'So11111111111111111111111111111111111111112',
  robinhood: '0x0000000000000000000000000000000000000000',
});
export const NATIVE_CURRENCIES: Readonly<Record<Chain, NativeCurrency>> = Object.freeze({
  bsc: Object.freeze({symbol: 'BNB', decimals: 18}),
  solana: Object.freeze({symbol: 'SOL', decimals: 9}),
  robinhood: Object.freeze({symbol: 'ETH', decimals: 18}),
});
export function nativeCurrency(chain: Chain): NativeCurrency {return NATIVE_CURRENCIES[chain];}

const SOLANA_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const BALANCE_READ_BUDGET_MS = 8_000;
const BALANCE_RPC_TIMEOUT_MS = 3_500;
const BALANCE_RETRY_DELAY_MS = 250;
class NativeRpcTransportError extends Error {}
class NativeRpcRateLimitError extends Error {
  constructor(readonly retryAfterMs?: number) {super('UPSTREAM_HTTP_429');}
}
function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}
function retryableReadError(error: unknown): boolean {
  return error instanceof NativeRpcTransportError || (error instanceof Error &&
    (error.name === 'TimeoutError' || /^UPSTREAM_HTTP_(?:408|429|502|503|504)$/.test(error.message)));
}
function readErrorReason(error: unknown): string {
  if (error instanceof Error && error.message === 'UPSTREAM_HTTP_429') return 'NATIVE_RPC_RATE_LIMITED';
  if (error instanceof Error && (error.name === 'TimeoutError' || error.message === 'UPSTREAM_HTTP_408'))
    return 'NATIVE_RPC_TIMEOUT';
  return 'NATIVE_RPC_UNAVAILABLE';
}
const quantity = (value: unknown): value is string =>
  typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeUnsigned = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const evmHash = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
function validSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 64 || value.length > 88) return false;
  try {return bs58.decode(value).length === 64;} catch {return false;}
}
function validWallet(chain: Chain, wallet: string): boolean {
  if (typeof wallet !== 'string') return false;
  if (chain !== 'solana') return isAddress(wallet, {strict: true}) && !/^0x0{40}$/i.test(wallet);
  if (wallet.length < 32 || wallet.length > 44) return false;
  try {
    const decoded = bs58.decode(wallet);
    return decoded.length === 32 && decoded.some(byte => byte !== 0);
  } catch {return false;}
}

/** Read-only wallet balance. It is a chain snapshot, not a reservation of spendable funds. */
export async function readNativeBalance(chain: Chain, wallet: string, config: Config,
  fetcher: Fetcher = fetch): Promise<NativeBalance> {
  const readStartedAt = new Date().toISOString();
  const unknown = (reason: string): NativeBalance => ({status: 'unknown', readStartedAt,
    checkedAt: new Date().toISOString(), reasons: [reason]});
  const verified = (amount: bigint): NativeBalance => ({status: 'verified', amount: amount.toString(), readStartedAt,
    checkedAt: new Date().toISOString(), reasons: ['NATIVE_BALANCE_VERIFIED']});
  if (!['bsc', 'solana', 'robinhood'].includes(chain) || !validWallet(chain, wallet))
    return unknown('NATIVE_WALLET_INVALID');
  // Capture operator configuration before any await; no response or signal supplies this URL.
  const url = config.rpc[chain];
  if (!url) return unknown('NATIVE_RPC_NOT_CONFIGURED');
  // Public RPCs can briefly throttle reads. One retry is shared by the whole
  // snapshot, with a total deadline so a slow provider cannot delay entry checks.
  // Neither a mismatched chain nor invalid response data is eligible for retry.
  const deadline = Date.now() + BALANCE_READ_BUDGET_MS;
  let retryAvailable = true;
  const read = async (method: string, params: unknown[]): Promise<unknown> => {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DOMException('Balance read deadline exceeded', 'TimeoutError');
      const boundedFetcher: Fetcher = async (input, init) => {
        try {
          const response = await fetcher(input, {...init,
          signal: AbortSignal.any([...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(Math.min(BALANCE_RPC_TIMEOUT_MS, remaining))])});
          if (response.status === 429) {
            void response.body?.cancel().catch(() => {});
            throw new NativeRpcRateLimitError(retryAfterMs(response.headers.get('retry-after')));
          }
          return response;
        }
        catch (error) {
          // JSON/protocol TypeErrors outside fetch are not network errors.
          if (error instanceof TypeError) throw new NativeRpcTransportError('NATIVE_RPC_TRANSPORT_ERROR');
          throw error;
        }
      };
      try {return await rpc(url, method, params, boundedFetcher);}
      catch (error) {
        const waitMs = Math.max(BALANCE_RETRY_DELAY_MS, error instanceof NativeRpcRateLimitError ? error.retryAfterMs ?? 0 : 0);
        if (!retryAvailable || !retryableReadError(error) || deadline - Date.now() <= waitMs)
          throw error;
        retryAvailable = false;
        await delay(waitMs);
      }
    }
  };
  try {
    if (chain !== 'solana') {
      const chainId: unknown = await read('eth_chainId', []);
      if (!quantity(chainId) || BigInt(chainId) !== (chain === 'bsc' ? 56n : 4663n))
        return unknown('NATIVE_RPC_CHAIN_MISMATCH');
      const head: unknown = await read('eth_blockNumber', []);
      if (!quantity(head)) return unknown('NATIVE_BALANCE_RESPONSE_INVALID');
      const balance: unknown = await read('eth_getBalance', [wallet, head]);
      if (!quantity(balance)) return unknown('NATIVE_BALANCE_RESPONSE_INVALID');
      return {...verified(BigInt(balance)), blockNumber: head};
    }
    if (await read('getGenesisHash', []) !== SOLANA_GENESIS)
      return unknown('NATIVE_RPC_CHAIN_MISMATCH');
    const balance: unknown = await read('getBalance', [wallet, {commitment: 'confirmed'}]);
    // The JSON number may already have lost precision before conversion to BigInt.
    if (!object(balance) || !object(balance.context) || !safeUnsigned(balance.context.slot) ||
        !safeUnsigned(balance.value)) return unknown('NATIVE_BALANCE_RESPONSE_INVALID');
    return {...verified(BigInt(balance.value)), slot: balance.context.slot};
  } catch (error) {
    return unknown(readErrorReason(error));
  }
}

/** Caller must match the snapshot's chain, wallet and RPC to the order before calling. */
export async function nativeBalanceCoversOrder(order: Pick<OpeningOrder, 'chain' | 'transactionHash'>,
  balance: NativeBalance, config: Config, fetcher: Fetcher = fetch): Promise<boolean> {
  const {chain, transactionHash} = order;
  if (!['bsc', 'solana', 'robinhood'].includes(chain) || balance.status !== 'verified' ||
      typeof balance.amount !== 'string' || !/^(?:0|[1-9]\d*)$/.test(balance.amount)) return false;
  const url = config.rpc[chain];
  if (!url) return false;
  try {
    if (chain !== 'solana') {
      if (!evmHash(transactionHash) || !quantity(balance.blockNumber)) return false;
      const snapshotBlock = BigInt(balance.blockNumber);
      const receipt: unknown = await rpc(url, 'eth_getTransactionReceipt', [transactionHash], fetcher);
      if (!object(receipt) || receipt.status !== '0x1' || !evmHash(receipt.transactionHash) ||
          receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
          !quantity(receipt.blockNumber) || BigInt(receipt.blockNumber) + 12n > snapshotBlock || !evmHash(receipt.blockHash)) return false;
      const block: unknown = await rpc(url, 'eth_getBlockByNumber', [receipt.blockNumber, false], fetcher);
      return object(block) && quantity(block.number) && BigInt(block.number) === BigInt(receipt.blockNumber) &&
        evmHash(block.hash) && block.hash.toLowerCase() === receipt.blockHash.toLowerCase();
    }
    if (!validSignature(transactionHash) || !safeUnsigned(balance.slot)) return false;
    const snapshotSlot = balance.slot;
    const statuses: unknown = await rpc(url, 'getSignatureStatuses',
      [[transactionHash], {searchTransactionHistory: true}], fetcher);
    if (!object(statuses) || !Array.isArray(statuses.value) || statuses.value.length !== 1 || !object(statuses.value[0])) return false;
    const transaction = statuses.value[0];
    if (transaction.err !== null || !safeUnsigned(transaction.slot) || transaction.slot > snapshotSlot ||
        transaction.confirmationStatus !== 'finalized') return false;
    if (transaction.status !== undefined && (!object(transaction.status) || transaction.status.Ok !== null ||
        Object.hasOwn(transaction.status, 'Err'))) return false;
    return true;
  } catch {return false;}
}
