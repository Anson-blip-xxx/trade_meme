import {PublicKey} from '@solana/web3.js';
import {ExtensionType,getExtensionData,type Mint} from '@solana/spl-token';
import {unpack} from '@solana/spl-token-metadata';

export interface NativeTokenIdentity {
  /** Contract-bound display metadata only; never an execution identifier. */
  name?:string;
  symbol?:string;
  source:'token_2022_mint_extension';
}

const clean=(value:unknown,limit:number):string|undefined=>{
  if(typeof value!=='string')return;
  const normalized=value.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ')
    .replace(/\s+/g,' ').trim().slice(0,limit);
  return normalized||undefined;
};

/**
 * Reads Token-2022 metadata from the already verified mint snapshot used to
 * build the swap. This performs no extra request and binds the display name to
 * the exact mint in the transaction plan.
 */
export function nativeTokenIdentity(address:PublicKey,mint:Mint):NativeTokenIdentity|undefined {
  try {
    const data=getExtensionData(ExtensionType.TokenMetadata,mint.tlvData);
    if(!data)return;
    const metadata=unpack(data);
    if(!metadata.mint.equals(address))return;
    const name=clean(metadata.name,80),symbol=clean(metadata.symbol,32);
    if(!name&&!symbol)return;
    return {source:'token_2022_mint_extension',...(name?{name}:{}),...(symbol?{symbol}:{})};
  }catch{return;}
}

export function validNativeTokenIdentity(value:unknown):value is NativeTokenIdentity {
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const row=value as Record<string,unknown>;
  if(row.source!=='token_2022_mint_extension')return false;
  const name=clean(row.name,80),symbol=clean(row.symbol,32);
  return (!!name||!!symbol)&&
    (row.name===undefined||row.name===name)&&(row.symbol===undefined||row.symbol===symbol)&&
    Object.keys(row).every(key=>['name','symbol','source'].includes(key));
}
