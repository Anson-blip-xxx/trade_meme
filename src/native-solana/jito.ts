import {randomInt} from 'node:crypto';
import {PublicKey,SystemProgram,type TransactionInstruction} from '@solana/web3.js';
import bs58 from 'bs58';
export const JITO_DONT_FRONT='jitodontfront111111111111111111111111111111';
const hosts=new Set(['mainnet.block-engine.jito.wtf',...['amsterdam','dublin','frankfurt','london','ny','slc','singapore','tokyo'].map(x=>`${x}.mainnet.block-engine.jito.wtf`)]);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function jitoEndpoint(value:string):string {
  try{const url=new URL(value);if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.port||url.username||url.password||url.hash||url.search||
    !['/','/api/v1/transactions'].includes(url.pathname))throw Error();
    return `${url.origin}/api/v1/transactions?bundleOnly=true`;
  }catch{throw Error('NATIVE_JITO_URL_INVALID');}
}
export function jitoTipInstruction(wallet:string,recipient:string,lamports:string):TransactionInstruction {
  if(!/^[1-9]\d{0,7}$/.test(lamports)||BigInt(lamports)<1000n||BigInt(lamports)>10000000n)throw Error('NATIVE_TIP_INVALID');
  const ix=SystemProgram.transfer({fromPubkey:new PublicKey(wallet),toPubkey:new PublicKey(recipient),lamports:BigInt(lamports)});
  // Official Solana DontFront guidance: System Program ignores extra accounts.
  // Keep the marker on our own tip transfer, without changing DEX remaining-account layouts.
  ix.keys.push({pubkey:new PublicKey(JITO_DONT_FRONT),isSigner:false,isWritable:false});return ix;
}
export class JitoSender {
  private readonly url:string;private id=0;private cachedTips?:string[];
  private tail:Promise<void>=Promise.resolve();private nextAt=0;
  constructor(url:string,private readonly fetcher:typeof fetch=fetch,private readonly pacingMs=1100){
    this.url=jitoEndpoint(url);if(!Number.isInteger(pacingMs)||pacingMs<0||pacingMs>10000)throw Error('NATIVE_JITO_PACING_INVALID');
  }
  private async turn():Promise<()=>void>{
    const previous=this.tail;let release!:()=>void;this.tail=new Promise<void>(resolve=>{release=resolve;});
    await previous;const wait=this.nextAt-Date.now();if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
    let closed=false;return ()=>{if(!closed){closed=true;release();}};
  }
  /** Reserve before the final entry guard so no pacing wait separates the guard from broadcasting. */
  async reserveBroadcast():Promise<{broadcast:(rawTransaction:string,signature:string)=>Promise<void>;release:()=>void}>{
    const unlock=await this.turn();let used=false,released=false;
    const release=()=>{if(!released){released=true;unlock();}};
    return {release,broadcast:async(rawTransaction,signature)=>{
      if(used||released)throw Error('NATIVE_JITO_TURN_USED');used=true;
      try{await this.send(rawTransaction,signature);}finally{release();}
    }};
  }
  private async call(url:string,method:string,params:unknown[]):Promise<unknown>{
    const id=++this.id;
    this.nextAt=Date.now()+this.pacingMs;
    try{const response=await this.fetcher(url,{method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(12000),
      headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
      if(!response.ok||Number(response.headers.get('content-length'))>100000)throw Error();
      const text=await response.text();if(text.length>100000)throw Error();const raw:unknown=JSON.parse(text);
      if(!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==id||raw.error!==undefined||!Object.hasOwn(raw,'result'))throw Error();return raw.result;
    }catch{throw Error('NATIVE_JITO_UNAVAILABLE');}
  }
  async tipAccount():Promise<string>{
    if(!this.cachedTips){const release=await this.turn();try{if(!this.cachedTips){const raw=await this.call(new URL('/api/v1/getTipAccounts',this.url).href,'getTipAccounts',[]);
      if(!Array.isArray(raw)||raw.length<1||raw.length>32)throw Error('NATIVE_JITO_TIPS_INVALID');
      try{this.cachedTips=raw.map(v=>{if(typeof v!=='string'||new PublicKey(v).toBase58()!==v)throw Error();return v;});}
      catch{throw Error('NATIVE_JITO_TIPS_INVALID');}}}finally{release();}}
    return this.cachedTips[randomInt(this.cachedTips.length)];
  }
  /** Fetch the stable tip-account set and consume its regional rate-limit window
   * before execution is advertised as ready. This keeps the first live send from
   * waiting behind our own getTipAccounts request without weakening 1 req/s pacing. */
  async warmup():Promise<void>{
    await this.tipAccount();
    const release=await this.turn();release();
  }
  async broadcast(rawTransaction:string,expectedSignature:string):Promise<void>{
    const turn=await this.reserveBroadcast();try{await turn.broadcast(rawTransaction,expectedSignature);}finally{turn.release();}
  }
  private async send(rawTransaction:string,expectedSignature:string):Promise<void>{
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(rawTransaction)||Buffer.from(rawTransaction,'base64').length>1232||bs58.decode(expectedSignature).length!==64)
      throw Error('NATIVE_JITO_TRANSACTION_INVALID');
    const result=await this.call(this.url,'sendTransaction',[rawTransaction,{encoding:'base64'}]);
    if(result!==expectedSignature)throw Error('NATIVE_JITO_SIGNATURE_MISMATCH');
  }
}
