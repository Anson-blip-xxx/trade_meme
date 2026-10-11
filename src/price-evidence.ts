import bs58 from 'bs58';
import type {Chain} from './types.js';
export interface PriceEvidence {
  pool:string;protocol:string;quoteAddress:string;quotePriceUsd:number;anchorAt:string;anchorSource:'vendor_reference';confirmation?:'confirmed'|'rpc_observed';
  blockNumber?:string;blockHash?:string;slot?:number;blockTime:string;pricing:'spot_before_fees_and_slippage';
}
/** Keep a small allowlisted audit record. This validates shape/freshness; only the pool adapter authenticates a pool. */
export function priceEvidence(price:{chain:Chain;observedAt:string;metadata?:unknown}):PriceEvidence|undefined {
  const raw=price.metadata;if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
  const m=raw as Record<string,unknown>,observed=Date.parse(price.observedAt);
  const validAddress=(v:unknown)=>{if(typeof v!=='string')return false;
    if(price.chain==='solana')try{return bs58.decode(v).length===32;}catch{return false;}
    return /^0x[\da-f]{40}$/i.test(v);};
  const recent=(v:unknown)=>typeof v==='string'&&Number.isFinite(observed)&&Number.isFinite(Date.parse(v))&&observed-Date.parse(v)>=-5000&&observed-Date.parse(v)<=120000;
  if(!validAddress(m.pool)||!validAddress(m.quoteAddress)||typeof m.quotePriceUsd!=='number'||!Number.isFinite(m.quotePriceUsd)||m.quotePriceUsd<=0||
    !recent(m.anchorAt)||!recent(m.blockTime)||m.anchorSource!=='vendor_reference'||m.pricing!=='spot_before_fees_and_slippage')return;
  if(price.chain==='solana'?(m.protocol!=='pumpswap'||!Number.isSafeInteger(m.slot)||Number(m.slot)<0):
    price.chain!=='bsc'||!['pancake_v2','pancake_v3'].includes(String(m.protocol))||typeof m.blockNumber!=='string'||!/^0x[\da-f]{1,16}$/i.test(m.blockNumber))return;
  if(price.chain==='bsc'&&(typeof m.blockHash!=='string'||!/^0x[\da-f]{64}$/i.test(m.blockHash)))return;
  const confirmation=price.chain==='solana'?'confirmed':'rpc_observed';
  if(m.confirmation!==undefined&&m.confirmation!==confirmation)return;
  return {confirmation,pool:m.pool as string,protocol:m.protocol as string,quoteAddress:m.quoteAddress as string,quotePriceUsd:m.quotePriceUsd,
    anchorAt:new Date(m.anchorAt as string).toISOString(),anchorSource:'vendor_reference',blockTime:new Date(m.blockTime as string).toISOString(),
    pricing:'spot_before_fees_and_slippage',...(price.chain==='solana'?{slot:m.slot as number}:{blockNumber:m.blockNumber as string,...(m.blockHash?{blockHash:m.blockHash as string}:{})})};
}
