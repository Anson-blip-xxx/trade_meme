import {DatabaseSync} from 'node:sqlite';
import {readControlledHoldings} from './held-position-source.js';
import type {ManualClosePosition} from './manual-close.js';
import type {SolanaSnapshot,VerifiedSolanaTransaction} from './controlled-test/types.js';
import type {FastWalletEvent} from './wallet-fast.js';
import {classifySolanaActivity} from './wallet-activity-solana.js';
import {abortable} from './http.js';
import bs58 from 'bs58';

const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);

/** Trusted local evidence only. Reads the existing journal, never migrates or modifies it. */
export function readControlledManualPositions(path:string,expectedWallet:string):ManualClosePosition[] {
  const read=readControlledHoldings(path,expectedWallet);
  if(read.reasons.some(r=>r.includes('READ_FAILED')||r.includes('INVALID')||r.includes('LIMIT_REACHED')))throw Error('MANUAL_CLOSE_SOURCE_UNAVAILABLE');
  if(!read.items.length)return [];
  let db:DatabaseSync|undefined;
  try {
    db=new DatabaseSync(path,{readOnly:true});
    return read.items.map(seed=>{
      const runId=seed.id.replace(/^controlled-test:/,'');
      const row=db!.prepare(`SELECT r.payload run,o.payload operation FROM controlled_test_runs r JOIN controlled_test_operations o
        ON o.run_id=r.id AND o.operation_key='buy' WHERE r.id=?`).get(runId);
      if(!row)throw Error();const run:unknown=JSON.parse(String(row.run)),op:unknown=JSON.parse(String(row.operation));
      if(!object(run)||!object(op)||!object(op.body)||run.id!==runId||run.wallet!==expectedWallet||run.mint!==seed.tokenAddress||
        op.runId!==runId||op.body.from_address!==expectedWallet||op.body.output_token!==seed.tokenAddress||
        op.body.sell_ratio_type!=='hold_amount'||!Array.isArray(op.body.condition_orders)||!op.body.condition_orders.length||op.body.condition_orders.length>20)throw Error();
      const conditions=op.body.condition_orders.map(c=>{
        if(!object(c)||!['profit_stop','loss_stop'].includes(String(c.order_type))||c.side!=='sell'||typeof c.price_scale!=='string'||typeof c.sell_ratio!=='string')throw Error();
        return {order_type:String(c.order_type),side:c.side,price_scale:c.price_scale,sell_ratio:c.sell_ratio};
      });
      const response=object(op.response)?op.response:undefined,ids=[run.strategyId,response?.strategy_order_id].filter(id);
      if(new Set(ids).size>1)throw Error();
      return {id:seed.id,chain:'solana',wallet:seed.wallet,tokenAddress:seed.tokenAddress,tokenDecimals:seed.tokenDecimals,
        openingTransactionHash:seed.transactionHash,openingOutputAmount:seed.outputAmount,providerOrderId:seed.providerOrderId,
        strategyOrderIds:[...new Set(ids)],name:seed.name,symbol:seed.symbol,protectionExpected:true,
        protectionEvidence:{inputAmount:seed.inputAmount,outputAmount:seed.outputAmount,tokenDecimals:seed.tokenDecimals,
          confirmedAt:seed.confirmedAt,conditions,sellRatioType:'hold_amount'}};
    });
  }catch{throw Error('MANUAL_CLOSE_SOURCE_UNAVAILABLE');}finally{db?.close();}
}

const base58=(value:unknown,size:number)=>{try{return typeof value==='string'&&bs58.decode(value).length===size&&bs58.encode(bs58.decode(value))===value;}catch{return false;}};
const atomic=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9]\d{0,19})$/.test(value)&&BigInt(value)<=(1n<<64n)-1n;
const historyFailure=()=>new Error('MANUAL_CLOSE_PARTIAL_HISTORY_UNVERIFIED');
/** Bounded read-only history discovery; unsupported swaps and transfers are never sell proofs.
 * Coverage is deliberately limited to 3 x 100 signatures / 60 transactions / 20 seconds,
 * and to the instruction/flow protocols supported by classifySolanaActivity. We must reach
 * the opening signature: a truncated RPC history is not evidence that no other sale exists.
 */
export class ManualCloseSolanaHistory {
  private readonly url:string;private readonly fetcher:typeof fetch;private readonly now:()=>number;
  private sequence=0;private readonly cache=new Map<string,Record<string,unknown>>();
  constructor(rpcUrl:string,options:{fetcher?:typeof fetch;now?:()=>number}={}){
    const url=new URL(rpcUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw historyFailure();
    this.url=url.href;this.fetcher=options.fetcher??fetch;this.now=options.now??Date.now;
  }
  private async rpc(method:'getGenesisHash'|'getSignaturesForAddress'|'getTransaction',params:unknown[],signal:AbortSignal):Promise<unknown>{
    signal.throwIfAborted();const id=++this.sequence;
    const response=await abortable(this.fetcher(this.url,{method:'POST',redirect:'error',credentials:'omit',signal,
      headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})}),signal);
    if(!response.ok||response.redirected||!response.body)throw historyFailure();
    if(Number(response.headers.get('content-length'))>2*1024*1024){void response.body.cancel().catch(()=>{});throw historyFailure();}
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await abortable(reader.read(),signal);if(done)break;size+=value.byteLength;if(size>2*1024*1024)throw historyFailure();chunks.push(value);}}
    catch(e){void reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
    const result:unknown=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
    if(!object(result)||result.jsonrpc!=='2.0'||result.id!==id||result.error!==undefined||!Object.hasOwn(result,'result'))throw historyFailure();
    return result.result;
  }
  async signatures(position:ManualClosePosition,opening:VerifiedSolanaTransaction,snapshot:SolanaSnapshot):Promise<string[]> {
    const signal=AbortSignal.timeout(20000);
    try {
      if(position.chain!=='solana'||!base58(position.wallet,32)||!base58(position.tokenAddress,32)||!base58(position.openingTransactionHash,64)||
        opening.signature!==position.openingTransactionHash||opening.wallet!==position.wallet||opening.mint!==position.tokenAddress||opening.side!=='buy'||
        !Number.isSafeInteger(opening.slot)||opening.slot<1||snapshot.wallet!==position.wallet||snapshot.mint!==position.tokenAddress||
        !Number.isSafeInteger(snapshot.slot)||snapshot.slot<opening.slot)throw historyFailure();
      if(await this.rpc('getGenesisHash',[],signal)!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw historyFailure();
      const seen=new Set<string>(),entries:Array<{signature:string;slot:number}>=[];let before:string|undefined,reached=false,previous=Infinity;
      for(let page=0;page<3&&!reached;page++){
        const rows=await this.rpc('getSignaturesForAddress',[position.wallet,{commitment:'finalized',limit:100,minContextSlot:snapshot.slot,...before?{before}:{}}],signal);
        if(!Array.isArray(rows)||rows.length>100)throw historyFailure();
        for(const row of rows){
          if(!object(row)||!base58(row.signature,64)||!Number.isSafeInteger(row.slot)||Number(row.slot)<1||Number(row.slot)>previous||
            seen.has(String(row.signature))||row.confirmationStatus!=='finalized'||!Object.hasOwn(row,'err'))throw historyFailure();
          previous=Number(row.slot);seen.add(String(row.signature));
          if(row.signature===opening.signature){if(row.slot!==opening.slot||row.err!==null)throw historyFailure();reached=true;break;}
          if(Number(row.slot)<opening.slot)throw historyFailure();
          if(row.err===null&&Number(row.slot)<=snapshot.slot)entries.push({signature:String(row.signature),slot:Number(row.slot)});
        }
        if(reached)break;if(rows.length<100)throw historyFailure();before=String(rows[rows.length-1].signature);
      }
      if(!reached||entries.length>60)throw historyFailure();
      const signatures:string[]=[];
      for(const entry of entries.reverse()){
        signal.throwIfAborted();let raw=this.cache.get(entry.signature);
        if(!raw){const value=await this.rpc('getTransaction',[entry.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}],signal);
          if(!object(value))throw historyFailure();raw=value;}
        if(raw.slot!==entry.slot||!object(raw.meta)||raw.meta.err!==null||!object(raw.transaction)||!Array.isArray(raw.transaction.signatures)||
          raw.transaction.signatures[0]!==entry.signature)throw historyFailure();
        const total=(value:unknown)=>{if(!Array.isArray(value)||value.length>256)throw historyFailure();let sum=0n;
          for(const row of value){if(!object(row)||!base58(row.mint,32))throw historyFailure();if(row.mint!==position.tokenAddress)continue;
            if(!base58(row.owner,32)||!object(row.uiTokenAmount)||!atomic(row.uiTokenAmount.amount)||row.uiTokenAmount.decimals!==snapshot.decimals)throw historyFailure();
            if(row.owner===position.wallet)sum+=BigInt(row.uiTokenAmount.amount);}
          return sum;};
        const delta=total(raw.meta.postTokenBalances)-total(raw.meta.preTokenBalances);
        if(delta!==0n){
          const at=new Date(this.now()).toISOString();const event:FastWalletEvent={id:'manual-history:'+entry.signature,chain:'solana',wallet:position.wallet,
            txHash:entry.signature,tokenAddress:position.tokenAddress,slot:entry.slot,receivedAt:at,judgedAt:at,processingMs:0,kind:'wallet_mention',
            verdict:'review_activity',groups:[],profileFresh:false,cachedSafety:'unknown',commitment:'included',removed:false,buyVerified:false,tradingEnabled:false};
          const activity=classifySolanaActivity(event,raw,this.now());
          if(delta>=0n||activity.classification!=='sell'||activity.trades.length!==1||activity.trades[0].tokenAddress!==position.tokenAddress||
            activity.trades[0].side!=='sell'||activity.trades[0].amountAtomic!==String(-delta)||
            activity.trades[0].quoteAddress!=='So11111111111111111111111111111111111111112')throw historyFailure();
          signatures.push(entry.signature);
        }
        if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value!);this.cache.set(entry.signature,raw);
      }
      return signatures;
    }catch{throw historyFailure();}
  }
}
