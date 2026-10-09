import bs58 from 'bs58';
import type {Config} from './config.js';
import type {OpeningOrder} from './orders.js';
import {rpc, type Fetcher} from './http.js';

export interface PositionBalance {
  status: 'verified' | 'unknown';
  amount?: string;
  checkedAt: string;
  reasons: string[];
}
type Position = Pick<OpeningOrder, 'chain' | 'wallet' | 'tokenAddress' | 'transactionHash'>;
const SOLANA_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const MAX_U64 = (1n << 64n) - 1n;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const quantity = (value: unknown): value is string =>
  typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value);
const evmHash = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const evmAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const slot = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function solanaBytes(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try {return bs58.decode(value).length === length;} catch {return false;}
}
function unknown(reason: string): PositionBalance {
  return {status: 'unknown', checkedAt: new Date().toISOString(), reasons: [reason]};
}
function verified(amount: bigint): PositionBalance {
  return {status: 'verified', amount: amount.toString(), checkedAt: new Date().toISOString(),
    reasons: ['POSITION_BALANCE_VERIFIED']};
}

/** Read-only chain evidence. A verified zero alone does not close an order or release its slot. */
export async function readPositionBalance(order: Position, config: Config, fetcher: Fetcher = fetch): Promise<PositionBalance> {
  if (!['bsc', 'robinhood', 'solana'].includes(order.chain)) return unknown('POSITION_ORDER_INVALID');
  const url = config.rpc[order.chain];
  if (!url) return unknown('POSITION_RPC_NOT_CONFIGURED');
  const solana = order.chain === 'solana';
  if (solana ? !solanaBytes(order.wallet, 32) || !solanaBytes(order.tokenAddress, 32) || !solanaBytes(order.transactionHash, 64)
    : !evmAddress(order.wallet) || !evmAddress(order.tokenAddress) || !evmHash(order.transactionHash))
    return unknown('POSITION_ORDER_INVALID');
  try {
    if (!solana) {
      const chainId: unknown = await rpc(url, 'eth_chainId', [], fetcher);
      if (!quantity(chainId) || BigInt(chainId) !== (order.chain === 'bsc' ? 56n : 4663n))
        return unknown('POSITION_RPC_CHAIN_MISMATCH');
      const receipt: unknown = await rpc(url, 'eth_getTransactionReceipt', [order.transactionHash], fetcher);
      if (!object(receipt) || receipt.status !== '0x1' || !evmHash(receipt.transactionHash) ||
          receipt.transactionHash.toLowerCase() !== order.transactionHash!.toLowerCase() ||
          !quantity(receipt.blockNumber) || !evmHash(receipt.blockHash))
        return unknown('POSITION_BUY_RECEIPT_UNVERIFIED');
      const head: unknown = await rpc(url, 'eth_blockNumber', [], fetcher);
      if (!quantity(head)) return unknown('POSITION_BALANCE_RESPONSE_INVALID');
      if (BigInt(head) < BigInt(receipt.blockNumber) + 12n) return unknown('POSITION_BUY_NOT_FINALIZED');
      // A receipt from an orphaned fork must never authorize a zero-balance release.
      const canonical: unknown = await rpc(url, 'eth_getBlockByNumber', [receipt.blockNumber, false], fetcher);
      if (!object(canonical) || !quantity(canonical.number) || BigInt(canonical.number) !== BigInt(receipt.blockNumber) ||
          !evmHash(canonical.hash) || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
        return unknown('POSITION_BUY_BLOCK_NOT_CANONICAL');
      const blockTag = '0x' + (BigInt(head) - 12n).toString(16);
      const balance: unknown = await rpc(url, 'eth_call', [{to: order.tokenAddress,
        data: '0x70a08231' + order.wallet.slice(2).toLowerCase().padStart(64, '0')}, blockTag], fetcher);
      // ABI uint256 is exactly one word; an empty return from a missing contract is not zero.
      if (typeof balance !== 'string' || !/^0x[0-9a-f]{64}$/i.test(balance))
        return unknown('POSITION_BALANCE_RESPONSE_INVALID');
      return verified(BigInt(balance));
    }

    if (await rpc(url, 'getGenesisHash', [], fetcher) !== SOLANA_GENESIS)
      return unknown('POSITION_RPC_CHAIN_MISMATCH');
    const statuses: unknown = await rpc(url, 'getSignatureStatuses',
      [[order.transactionHash], {searchTransactionHistory: true}], fetcher);
    if (!object(statuses) || !Array.isArray(statuses.value) || statuses.value.length !== 1 || !object(statuses.value[0]))
      return unknown('POSITION_BUY_RECEIPT_UNVERIFIED');
    const transaction = statuses.value[0];
    if (transaction.err !== null || !slot(transaction.slot)) return unknown('POSITION_BUY_RECEIPT_UNVERIFIED');
    if (transaction.confirmationStatus !== 'finalized') return unknown('POSITION_BUY_NOT_FINALIZED');
    if (transaction.status !== undefined && (!object(transaction.status) || transaction.status.Ok !== null ||
        Object.hasOwn(transaction.status, 'Err'))) return unknown('POSITION_BUY_RECEIPT_UNVERIFIED');
    const accounts: unknown = await rpc(url, 'getTokenAccountsByOwner', [order.wallet, {mint: order.tokenAddress},
      {encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: transaction.slot}], fetcher);
    if (!object(accounts) || !object(accounts.context) || !slot(accounts.context.slot) || !Array.isArray(accounts.value))
      return unknown('POSITION_BALANCE_RESPONSE_INVALID');
    if (accounts.context.slot < transaction.slot) return unknown('POSITION_BALANCE_SLOT_STALE');
    let total = 0n;
    const seen = new Set<string>();
    for (const row of accounts.value) {
      if (!object(row) || !solanaBytes(row.pubkey, 32) || seen.has(row.pubkey) || !object(row.account) ||
          typeof row.account.owner !== 'string' || !TOKEN_PROGRAMS.has(row.account.owner) || row.account.executable !== false ||
          !object(row.account.data) || !object(row.account.data.parsed) || row.account.data.parsed.type !== 'account' ||
          !object(row.account.data.parsed.info)) return unknown('POSITION_TOKEN_ACCOUNT_INVALID');
      seen.add(row.pubkey);
      const info = row.account.data.parsed.info;
      if (info.owner !== order.wallet || info.mint !== order.tokenAddress || !object(info.tokenAmount) ||
          typeof info.tokenAmount.amount !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(info.tokenAmount.amount))
        return unknown('POSITION_TOKEN_ACCOUNT_INVALID');
      total += BigInt(info.tokenAmount.amount);
      if (total > MAX_U64) return unknown('POSITION_AMOUNT_OVERFLOW');
    }
    return verified(total);
  } catch {
    return unknown('POSITION_RPC_UNAVAILABLE');
  }
}
