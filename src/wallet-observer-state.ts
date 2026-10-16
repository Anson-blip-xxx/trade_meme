import bs58 from 'bs58';
import type {Chain} from './types.js';

/** Scheduling checkpoints only: never trading, ownership or performance evidence. */
export interface WalletObserverCursorState {
  version: 1;
  chains: Chain[];
  cursor: number;
  rank: [Chain, number][];
  market: [Chain, number][];
  associationRounds: [Chain, number][];
  wallets: [string, number][];
  associations: [string, number][];
  walletChecks: [string, number][];
  pending?: WalletObserverPending[];
}
export interface WalletObserverPending {
  chain: Chain; address: string; kind: 'market' | 'association';
  anchorWallet?: string; anchorEventAt?: string; anchorObservedAt?: string;
  candidateWallet?: string; historicalRelationship?: boolean;
  wallets?: string[];
}
const CHAINS: Chain[] = ['bsc', 'solana', 'robinhood'];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const counter = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 1_000_000_000;
function address(v: unknown, chain: Chain): boolean {
  if (typeof v !== 'string') return false;
  if (chain !== 'solana') return /^0x[0-9a-f]{40}$/.test(v) && !/^0x0+$/.test(v);
  try {const b = bs58.decode(v); return v.length <= 44 && b.length === 32 && b.some(n => n !== 0);} catch {return false;}
}
const iso = (v: unknown): boolean => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

export function parseWalletObserverCursor(value: unknown): WalletObserverCursorState | undefined {
  if (!object(value) || value.version !== 1 || !counter(value.cursor) ||
      Object.keys(value).some(key => !['version', 'chains', 'cursor', 'rank', 'market', 'associationRounds', 'wallets', 'associations', 'walletChecks', 'pending'].includes(key)) ||
      !Array.isArray(value.chains) || !value.chains.length || value.chains.length > 3 ||
      Array.from(value.chains).some(chain => !CHAINS.includes(chain)) || new Set(value.chains).size !== value.chains.length) return;
  const maps = [['rank', 3, 1], ['market', 3, 1], ['associationRounds', 3, 1],
    ['wallets', 200, 2], ['associations', 200, 3], ['walletChecks', 2_000, 3]] as const;
  for (const [name, limit, parts] of maps) {
    const rows = value[name];
    if (!Array.isArray(rows) || rows.length > limit) return;
    const seen = new Set<string>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !counter(row[1]) || seen.has(row[0])) return;
      seen.add(row[0]);
      const pieces = row[0].split(':'), chain = pieces[0] as Chain;
      if (!value.chains.includes(chain) || pieces.length !== parts || pieces.slice(1).some(who => !address(who, chain))) return;
    }
  }
  if (value.pending !== undefined) {
    if (!Array.isArray(value.pending) || value.pending.length > value.chains.length) return;
    const chains = new Set<unknown>();
    for (const p of value.pending) {
      if (!object(p) || Object.keys(p).some(key => !['chain', 'address', 'kind', 'anchorWallet', 'anchorEventAt', 'anchorObservedAt', 'candidateWallet', 'historicalRelationship', 'wallets'].includes(key)) ||
          !value.chains.includes(p.chain) || chains.has(p.chain) ||
          !address(p.address, p.chain as Chain) || !['market', 'association'].includes(String(p.kind)) ||
          p.wallets !== undefined && (!Array.isArray(p.wallets) || p.wallets.length > (p.kind === 'market' ? 1 : 3) ||
            Array.from(p.wallets).some(who => !address(who, p.chain as Chain)) || new Set(p.wallets).size !== p.wallets.length)) return;
      if (p.kind === 'association') {
        if (!address(p.anchorWallet, p.chain as Chain) || !iso(p.anchorEventAt) || !iso(p.anchorObservedAt) ||
            String(p.anchorEventAt) > String(p.anchorObservedAt) ||
            p.candidateWallet !== undefined && (!address(p.candidateWallet, p.chain as Chain) || p.candidateWallet === p.anchorWallet) ||
            p.historicalRelationship !== undefined && typeof p.historicalRelationship !== 'boolean' ||
            p.historicalRelationship === true && p.candidateWallet === undefined) return;
      } else if (['anchorWallet', 'anchorEventAt', 'anchorObservedAt', 'candidateWallet', 'historicalRelationship'].some(key => p[key] !== undefined)) return;
      chains.add(p.chain);
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 400_000) return;
  return structuredClone(value) as unknown as WalletObserverCursorState;
}
