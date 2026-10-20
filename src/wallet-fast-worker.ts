import {parentPort,workerData} from 'node:worker_threads';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {RpcStream} from './rpc-stream.js';
import {WalletFastJudge,type FastWalletSnapshot} from './wallet-fast.js';
import type {Chain} from './types.js';

const port=parentPort!;
const options=workerData as {endpoints:Partial<Record<Chain,{http:string;ws:string}>>;maxWallets:number};
const judge=new WalletFastJudge(),lag=monitorEventLoopDelay({resolution:10});lag.enable();
type Context={stream:RpcStream;verified?:number;checking?:number;error?:string;lastDisconnect?:{at:string;reason:string}};
const contexts=new Map<Chain,Context>();
const pending=new Set<number>();let sequence=0,statusPending=false,dropped=0,stopped=false;
const abort=new AbortController();
async function identity(chain:Chain,url:string){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,
    method:chain==='solana'?'getGenesisHash':'eth_chainId',params:[]}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(8000)])});
  const text=await r.text();if(!r.ok||text.length>8192)throw new Error('IDENTITY_FAILED');const body=JSON.parse(text);
  const expected=chain==='solana'?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':chain==='bsc'?'0x38':'0x1237';
  if(body.error||body.result!==expected)throw new Error('IDENTITY_FAILED');
}
function subscriptions(chain:Chain){
  const context=contexts.get(chain)!;
  const specs:Parameters<RpcStream['setSubscriptions']>[0][number][]=[chain==='solana'?
    {key:'head',subscribeMethod:'slotSubscribe',params:[],unsubscribeMethod:'slotUnsubscribe',notificationMethod:'slotNotification'}:
    {key:'head',subscribeMethod:'eth_subscribe',params:['newHeads'],unsubscribeMethod:'eth_unsubscribe',notificationMethod:'eth_subscription'}];
  const wallets=judge.wallets(chain).slice(0,options.maxWallets);
  if(chain==='solana')for(const wallet of wallets)specs.push({key:'wallet:'+wallet,subscribeMethod:'logsSubscribe',
    params:[{mentions:[wallet]},{commitment:'processed'}],unsubscribeMethod:'logsUnsubscribe',notificationMethod:'logsNotification'});
  else if(wallets.length){const addresses=wallets.map(w=>'0x'+w.slice(2).padStart(64,'0'));
    const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    for(const [key,topics] of [['wallet:out',[transfer,addresses]],['wallet:in',[transfer,null,addresses]]] as const)
      specs.push({key,subscribeMethod:'eth_subscribe',params:['logs',{topics}],unsubscribeMethod:'eth_unsubscribe',notificationMethod:'eth_subscription'});
  }
  context.stream.setSubscriptions(specs);
}
for(const chain of ['bsc','solana','robinhood'] as const){
  const endpoint=options.endpoints[chain];if(!endpoint)continue;
  const context={} as Context;contexts.set(chain,context);
  context.stream=new RpcStream({url:endpoint.ws,maxSubscriptions:32,maxMessageBytes:262144,
    heartbeat:chain==='solana'?{mode:'message_idle',intervalMs:15000,timeoutMs:45000}:{method:'eth_chainId',intervalMs:15000,timeoutMs:10000},
    onStatus:status=>{
      if(status.state==='backoff')context.lastDisconnect={at:new Date().toISOString(),reason:status.lastError??'RPC_CONNECTION_CLOSED'};
      if(status.state!=='open'){context.verified=undefined;return;}
      if(context.verified===status.generation||context.checking===status.generation)return;
      context.checking=status.generation;
      void (async()=>{
        try {
          await identity(chain,endpoint.http);
          if(chain!=='solana'&&await context.stream.request('eth_chainId')!==(chain==='bsc'?'0x38':'0x1237'))throw new Error();
          if(stopped||context.stream.getStatus().generation!==status.generation)return;
          context.verified=status.generation;context.error=undefined;
        }catch{if(!stopped&&context.stream.getStatus().generation===status.generation){context.error='FAST_WALLET_IDENTITY_FAILED';context.stream.forceReconnect('RPC_CHAIN_IDENTITY_MISMATCH');}}
        finally{if(context.checking===status.generation)context.checking=undefined;}
      })();
    },
    onNotification:(key,data,meta)=>{
      if(stopped||key==='head'||context.verified!==meta.generation)return;
      const events=judge.judge(chain,key,data,meta);
      if(!events.length)return;
      if(pending.size>=64){dropped+=events.length;return;}
      const id=++sequence;pending.add(id);port.postMessage({type:'events',id,events});
    }});
}
const status=()=>{
  if(stopped||statusPending)return;statusPending=true;
  port.postMessage({type:'status',status:{enabled:true,running:true,asOf:new Date().toISOString(),mode:'preview_only',...judge.status(),
    droppedEvents:dropped,pendingDelivery:pending.size,eventLoopP99Ms:lag.percentile(99)/1e6,
    chains:[...contexts].map(([chain,c])=>{const s=c.stream.getStatus();return {chain,state:s.state,identityVerified:c.verified===s.generation&&s.state==='open',
      identityScope:chain==='solana'?'paired_http_rpc':'http_and_ws',watchedWallets:judge.wallets(chain).length,
      activeSubscriptions:s.activeSubscriptions,desiredSubscriptions:s.desiredSubscriptions,reconnects:s.reconnects,
      lastMessageAt:s.lastMessageAt?new Date(s.lastMessageAt).toISOString():undefined,lastDisconnect:c.lastDisconnect,error:c.error??s.lastError};}),
    coverage:'selected_wallets_live_only',replay:'historical_observer_separate',buyVerified:false,tradingEnabled:false}});
};
const timer=setInterval(status,1000);
port.on('message',message=>{
  if(message?.type==='snapshot')try{judge.update(message.snapshot as FastWalletSnapshot);for(const chain of contexts.keys())subscriptions(chain);}catch{port.postMessage({type:'failed',reason:'FAST_WALLET_SNAPSHOT_INVALID'});}
  else if(message?.type==='ack')pending.delete(message.id);
  else if(message?.type==='status_ack')statusPending=false;
  else if(message==='stop'){
    stopped=true;clearInterval(timer);abort.abort();lag.disable();for(const c of contexts.values())c.stream.stop();port.close();
  }
});
for(const chain of contexts.keys()){subscriptions(chain);contexts.get(chain)!.stream.start();}
status();
