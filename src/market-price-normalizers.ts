import bs58 from 'bs58';
import type {ScanToken,ScanPrice} from './scan-archive.js';
import type {Chain} from './types.js';
export const GMGN_PRICE_CHAINS:Record<Chain,string>={bsc:'bsc',solana:'sol',robinhood:'robinhood'};
const GMGN_CHAINS=GMGN_PRICE_CHAINS;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function normalizePriceToken(value: unknown): ScanToken | undefined {
  if (!object(value) || typeof value.chain !== 'string' || !Object.hasOwn(GMGN_CHAINS, value.chain) ||
      typeof value.address !== 'string') return;
  const chain = value.chain as Chain;
  if (chain === 'solana') {
    if (value.address.length < 32 || value.address.length > 44) return;
    try {
      const bytes = bs58.decode(value.address);
      if (bytes.length !== 32 || !bytes.some(byte => byte !== 0)) return;
    } catch {return;}
    return {chain, address: value.address};
  }
  if (!/^0x[0-9a-f]{40}$/i.test(value.address) || /^0x0{40}$/i.test(value.address)) return;
  return {chain, address: value.address.toLowerCase()};
}

export function priceFromInfo(raw: unknown, token: ScanToken): {priceUsd: number;market?:ScanPrice['market']} | {reason: string} {
  if (!object(raw)) return {reason: 'PRICE_SCHEMA_INVALID'};
  const returned = normalizePriceToken({chain: token.chain, address: raw.address});
  if (!returned || returned.address !== token.address ||
      (Object.hasOwn(raw, 'chain') && raw.chain !== GMGN_CHAINS[token.chain])) return {reason: 'PRICE_TOKEN_MISMATCH'};
  if (!object(raw.price) || typeof raw.price.price !== 'string' || raw.price.price.length > 128 ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(raw.price.price)) return {reason: 'PRICE_SCHEMA_INVALID'};
  const priceUsd = Number(raw.price.price);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return {reason: 'PRICE_VALUE_INVALID'};
  if (Object.hasOwn(raw.price,'address')&&normalizePriceToken({chain:token.chain,address:raw.price.address})?.address!==token.address||
      Object.hasOwn(raw.price,'chain')&&raw.price.chain!==GMGN_CHAINS[token.chain]) return {reason:'PRICE_TOKEN_MISMATCH'};
  // Reuse the current info response for follow-up context. Field meanings are
  // documented in GMGNAI/gmgn-skills skills/gmgn-token/SKILL.md (2026-10-15).
  // Unknown/invalid fields remain absent, rather than becoming zero observations.
  const numeric=(value:unknown):number|undefined=>{
    if(typeof value!=='number'&&(typeof value!=='string'||value.length>128||!/^\d+(?:\.\d+)?(?:e[+-]?\d{1,3})?$/i.test(value)))return;
    const n=Number(value);return Number.isFinite(n)&&n>=0&&n<=1e15?n:undefined;
  };
  const liquidity=numeric(raw.liquidity),holders=numeric(raw.holder_count);
  const concentration=object(raw.stat)?numeric(raw.stat.top_10_holder_rate):undefined;
  const pool=normalizePriceToken({chain:token.chain,address:raw.biggest_pool_address});
  const market:NonNullable<ScanPrice['market']>={
    ...(liquidity!==undefined?{liquidityUsd:liquidity}:{}),
    ...(holders!==undefined&&Number.isSafeInteger(holders)?{holderCount:holders}:{}),
    ...(concentration!==undefined&&concentration<=1?{top10HolderRate:concentration}:{}),
    ...(pool&&pool.address!==token.address?{poolAddress:pool.address}:{})};
  return {priceUsd,...(Object.keys(market).length?{market}:{})};
}


export interface DexSpotSample {
  token:ScanToken;observedAt:string;priceUsd:number;poolKey:string;
  /** V4 pool IDs identify pools but are not contract addresses. */
  poolAddress?:string;liquidityUsd?:number;
}
/** Current base-token USD observation only. Robinhood's official DEX Screener
 * response was verified on 2026-10-16: Uniswap v4 pairAddress is a bytes32 pool ID.
 * Keep that identifier internal; never expose it as an EVM contract address.
 */
export function normalizeDexSpot(raw:unknown,input:ScanToken,observedAt:string):DexSpotSample|undefined {
  const token=normalizePriceToken(input);
  if(!token||!object(raw)||raw.chainId!==token.chain||!object(raw.baseToken)||
    normalizePriceToken({chain:token.chain,address:raw.baseToken.address})?.address!==token.address||
    !Number.isFinite(Date.parse(observedAt)))return;
  if(typeof raw.priceUsd!=='string'||raw.priceUsd.length>128||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(raw.priceUsd))return;
  const priceUsd=Number(raw.priceUsd);if(!Number.isFinite(priceUsd)||priceUsd<=0)return;
  const pool=normalizePriceToken({chain:token.chain,address:raw.pairAddress});
  const poolId=token.chain!=='solana'&&typeof raw.pairAddress==='string'&&/^0x[0-9a-f]{64}$/i.test(raw.pairAddress)&&
    !/^0x0{64}$/i.test(raw.pairAddress)?raw.pairAddress.toLowerCase():undefined;
  if((!pool&&!poolId)||pool?.address===token.address)return;
  const liquidity=object(raw.liquidity)&&typeof raw.liquidity.usd==='number'&&Number.isFinite(raw.liquidity.usd)&&raw.liquidity.usd>=0
    ?raw.liquidity.usd:undefined;
  return {token,observedAt:new Date(observedAt).toISOString(),priceUsd,poolKey:pool?.address??poolId!,
    ...(pool?{poolAddress:pool.address}:{}),...(liquidity!==undefined?{liquidityUsd:liquidity}:{})};
}
