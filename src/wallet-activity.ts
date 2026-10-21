import {ChainHttp} from './chain-data.js';
import {chainAddress,object} from './chain-stream-store.js';
import type {Chain} from './types.js';
import type {FastWalletEvent} from './wallet-fast.js';
import {classifySolanaActivity} from './wallet-activity-solana.js';
import {classifyEvmActivity,loadSwapPools,type EvmActivityBundle} from './wallet-activity-evm.js';

export type ActivityKind='buy'|'sell'|'received_purchase'|'distribution'|'transfer'|'self_transfer'|'approval'|'liquidity'|'wrap'|'failed'|'retracted'|'no_change'|'unknown';
export interface ActivityTrade {tokenAddress:string;side:'buy'|'sell';amountAtomic:string;protocol:string;quoteAmountAtomic?:string;quoteAddress?:string;}
export interface ActivityTransfer {from:string;to:string;tokenAddress?:string;amountAtomic:string;}
export interface WalletActivity {
  version:1;chain:Chain;wallet:string;txHash:string;receivedAt:string;checkedAt:string;eventAt?:string;
  classification:ActivityKind;reasons:string[];trades:ActivityTrade[];retryable:boolean;
  confirmation:'confirmed'|'included'|'unknown';blockHash?:string;slot?:number;
  transferCount:number;transfers?:ActivityTransfer[];initiator?:string;tradingEnabled:false;
}
export function activityResult(event:FastWalletEvent,now:number,classification:ActivityKind,reasons:string[],extra:Partial<WalletActivity>={}):WalletActivity {
  return {version:1,chain:event.chain,wallet:event.wallet,txHash:event.txHash,receivedAt:event.receivedAt,checkedAt:new Date(now).toISOString(),
    classification,reasons,trades:[],retryable:false,confirmation:'unknown',transferCount:0,tradingEnabled:false,...extra};
}
export interface ActivityRpc {request(method:string,params:unknown[],signal?:AbortSignal):Promise<any>;stop?():void;}
/** Separate read-only RPC budget. Provider labels cannot authorize a trade classification. */
export class WalletActivityVerifier {
  private clients=new Map<Chain,ActivityRpc>();private identities=new Map<Chain,number>();private stopped=false;
  private cache=new Map<string,{until:number;data:any}>();private pending=new Map<string,Promise<any>>();
  constructor(endpoints:Partial<Record<Chain,{http:string}>>,private now=()=>Date.now(),factory:(url:string)=>ActivityRpc=url=>new ChainHttp(url,fetch,350,6000)){
    for(const chain of ['bsc','solana','robinhood'] as const)if(endpoints[chain])this.clients.set(chain,factory(endpoints[chain]!.http));
  }
  async verify(event:FastWalletEvent):Promise<WalletActivity>{
    if(event.removed)return activityResult(event,this.now(),'retracted',['CHAIN_EVENT_RETRACTED']);
    const transport=this.clients.get(event.chain);
    if(!transport||this.stopped)return activityResult(event,this.now(),'unknown',['TRANSACTION_RPC_UNAVAILABLE']);
    const started=performance.now(),deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),12000);let calls=0;
    const rpc:ActivityRpc={request:(method,params)=>{
      if(this.stopped||++calls>20||performance.now()-started>12000)return Promise.reject(new Error('TRANSACTION_RPC_BUDGET'));
      return transport.request(method,params,deadline.signal);
    }};
    try {
      if((this.identities.get(event.chain)??0)<=this.now()){
        const id=await rpc.request(event.chain==='solana'?'getGenesisHash':'eth_chainId',[]);
        if(id!==(event.chain==='solana'?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':event.chain==='bsc'?'0x38':'0x1237'))
          return activityResult(event,this.now(),'unknown',['TRANSACTION_CHAIN_MISMATCH']);
        this.identities.set(event.chain,this.now()+300000);
      }
      const key=event.chain+':'+event.txHash,hit=this.cache.get(key);
      let data=hit&&hit.until>this.now()?hit.data:undefined;
      if(!data){
        let work=this.pending.get(key);
        if(!work){work=(async()=>{
          if(event.chain==='solana')return rpc.request('getTransaction',[event.txHash,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
          const receipt=await rpc.request('eth_getTransactionReceipt',[event.txHash]);if(!receipt)return null;
          const transaction=await rpc.request('eth_getTransactionByHash',[event.txHash]);
          const block=typeof receipt.blockNumber==='string'?await rpc.request('eth_getBlockByNumber',[receipt.blockNumber,false]):null;
          return {receipt,transaction,block} satisfies EvmActivityBundle;
        })().finally(()=>this.pending.delete(key));this.pending.set(key,work);}
        data=await work;
        if(data){if(this.cache.size>=256)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,{data,until:this.now()+30000});}
      }
      if(this.stopped)return activityResult(event,this.now(),'unknown',['TRANSACTION_RPC_STOPPED']);
      if(event.chain==='solana')return classifySolanaActivity(event,data,this.now());
      if(data&&object(data.receipt)&&data.receipt.status==='0x1'&&chainAddress(event.chain,data.transaction?.from)===event.wallet)
        data={...data,pools:await loadSwapPools(event,data,rpc)};
      return classifyEvmActivity(event,data,this.now());
    }catch{return activityResult(event,this.now(),'unknown',['TRANSACTION_RPC_UNAVAILABLE'],{retryable:!this.stopped});}
    finally{clearTimeout(timer);}
  }
  stop(){this.stopped=true;for(const rpc of this.clients.values())rpc.stop?.();this.cache.clear();}
}
