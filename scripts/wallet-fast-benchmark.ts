import bs58 from 'bs58';
import {RpcStream,type RpcSocket} from '../src/rpc-stream.js';
import {WalletFastJudge} from '../src/wallet-fast.js';
import {TRANSFER_TOPIC} from '../src/chain-stream-store.js';

/** Deterministic synthetic transport replay: no network, wallet key or trade API. */
class ReplaySocket implements RpcSocket {
  readyState=1;listeners=new Map<string,((event:any)=>void)[]>();
  send(raw:string){const p=JSON.parse(raw);queueMicrotask(()=>this.emit('message',{data:JSON.stringify({jsonrpc:'2.0',id:p.id,result:'subscription'})}));}
  close(){this.readyState=3;}
  addEventListener(type:string,fn:(event:any)=>void){this.listeners.set(type,[...(this.listeners.get(type)??[]),fn]);}
  removeEventListener(type:string,fn:(event:any)=>void){this.listeners.set(type,(this.listeners.get(type)??[]).filter(f=>f!==fn));}
  emit(type:string,event:any={}){for(const fn of this.listeners.get(type)??[])fn(event);}
}
const output=[];
for(const chain of ['solana','bsc','robinhood'] as const){
  const now=Date.now(),wallet=chain==='solana'?bs58.encode(new Uint8Array(32).fill(9)):'0x'+'1'.repeat(40),judge=new WalletFastJudge();
  judge.update({at:new Date(now).toISOString(),validUntil:new Date(now+120000).toISOString(),targets:[{chain,wallet,groups:['forward_validated'],profileUntil:new Date(now+120000).toISOString()}],tokens:[]});
  const socket=new ReplaySocket(),key=chain==='solana'?'wallet:'+wallet:'wallet:in';
  const stream=new RpcStream({url:'wss://synthetic.invalid',socketFactory:()=>socket,onNotification:(k,data,meta)=>{judge.judge(chain,k,data,meta);}});
  stream.setSubscriptions([{key,subscribeMethod:chain==='solana'?'logsSubscribe':'eth_subscribe',params:[],unsubscribeMethod:'unsubscribe',notificationMethod:'notice'}]);
  stream.start();socket.emit('open');await new Promise(r=>setImmediate(r));
  for(let i=0;i<10000;i++){
    const sig=new Uint8Array(64).fill(8);new DataView(sig.buffer).setUint32(0,i);
    const result=chain==='solana'?{context:{slot:i},value:{signature:bs58.encode(sig),err:null,logs:[]}}:{address:'0x'+'3'.repeat(40),
      topics:[TRANSFER_TOPIC,'0x'+'2'.repeat(64),'0x'+wallet.slice(2).padStart(64,'0')],data:'0x'+'0'.repeat(63)+'1',
      transactionHash:'0x'+(i+1).toString(16).padStart(64,'0'),blockHash:'0x'+'5'.repeat(64),blockNumber:'0x100',logIndex:'0x0'};
    // EVM topic uses canonical 12-byte zero padding, just like node logs.
    if('topics' in result)result.topics![1]='0x'+'2'.repeat(40).padStart(64,'0');
    socket.emit('message',{data:JSON.stringify({jsonrpc:'2.0',method:'notice',params:{subscription:'subscription',result}})});
  }
  output.push({chain,...judge.status().counts,...judge.status().latency});stream.stop();
}
console.log(JSON.stringify({scope:'synthetic_websocket_json_replay_not_network_or_order_latency',results:output},null,2));
