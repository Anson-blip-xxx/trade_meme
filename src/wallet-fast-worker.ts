import {parentPort,workerData} from 'node:worker_threads';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {RpcStream} from './rpc-stream.js';
import {WalletFastJudge,type FastWalletSnapshot} from './wallet-fast.js';
import type {Chain} from './types.js';

const port=parentPort!;
const options=workerData as {endpoints:Partial<Record<Chain,{http:string;ws:string}>>;maxWallets:number;
  maxWalletsByChain?:Partial<Record<Chain,number>>};
const judge=new WalletFastJudge(),lag=monitorEventLoopDelay({resolution:10});lag.enable();
type Context={stream:RpcStream;verified?:number;checking?:number;httpVerified?:number;slotChecking?:number;
  error?:string;lastDisconnect?:{at:string;reason:string}};
const contexts=new Map<Chain,Context>();
const pending=new Set<number>();let sequence=0,statusPending=false,dropped=0,stopped=false,snapshotAccepted=false,snapshotExpiresAt=0;
const abort=new AbortController();
const expectedIdentity=(chain:Chain)=>chain==='solana'?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':chain==='bsc'?'0x38':'0x1237';
const walletLimit=(chain:Chain)=>{
  const value=options.maxWalletsByChain?.[chain]??options.maxWallets,maximum=chain==='solana'?30:200;
  return Number.isSafeInteger(value)&&value>0?Math.min(value,maximum):Math.min(Math.max(1,options.maxWallets),maximum);
};
const walletChunks=(wallets:string[])=>Array.from({length:Math.ceil(wallets.length/50)},(_,index)=>wallets.slice(index*50,index*50+50));
async function httpRpc(url:string,method:string){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,
    method,params:[]}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(8000)])});
  const text=await r.text();if(!r.ok||text.length>8192)throw new Error('IDENTITY_FAILED');const body=JSON.parse(text);
  if(body.error)throw new Error('IDENTITY_FAILED');return body.result;
}
async function identity(chain:Chain,url:string){
  if(await httpRpc(url,chain==='solana'?'getGenesisHash':'eth_chainId')!==expectedIdentity(chain))throw new Error('IDENTITY_FAILED');
}
function subscriptions(chain:Chain){
  const context=contexts.get(chain)!;
  const specs:Parameters<RpcStream['setSubscriptions']>[0][number][]=[chain==='solana'?
    {key:'head',subscribeMethod:'slotSubscribe',params:[],unsubscribeMethod:'slotUnsubscribe',notificationMethod:'slotNotification'}:
    {key:'head',subscribeMethod:'eth_subscribe',params:['newHeads'],unsubscribeMethod:'eth_unsubscribe',notificationMethod:'eth_subscription'}];
  const wallets=judge.wallets(chain).slice(0,walletLimit(chain));
  if(chain==='solana')for(const wallet of wallets)specs.push({key:'wallet:'+wallet,subscribeMethod:'logsSubscribe',
    params:[{mentions:[wallet]},{commitment:'processed'}],unsubscribeMethod:'logsUnsubscribe',notificationMethod:'logsNotification'});
  else if(wallets.length){
    const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    for(const [index,chunk] of walletChunks(wallets).entries()){
      const addresses=chunk.map(w=>'0x'+w.slice(2).padStart(64,'0'));
      for(const [direction,topics] of [['out',[transfer,addresses]],['in',[transfer,null,addresses]]] as const)
        specs.push({key:`wallet:${direction}:${index}`,subscribeMethod:'eth_subscribe',params:['logs',{topics}],
          unsubscribeMethod:'eth_unsubscribe',notificationMethod:'eth_subscription'});
    }
  }
  context.stream.setSubscriptions(specs);
}
for(const chain of ['bsc','solana','robinhood'] as const){
  const endpoint=options.endpoints[chain];if(!endpoint)continue;
  const context={} as Context;contexts.set(chain,context);
  context.stream=new RpcStream({url:endpoint.ws,maxSubscriptions:32,
    // Public Solana RPCs commonly reject a reconnect burst of head + 30 log
    // subscriptions. Advance the desired set through a four-ACK window while
    // leaving the smaller/chunked EVM subscription set fully concurrent.
    ...(chain==='solana'?{maxConcurrentSubscriptions:4,retryRejectedSubscriptions:true}:{}),maxMessageBytes:262144,
    heartbeat:chain==='solana'?{mode:'message_idle',intervalMs:15000,timeoutMs:45000}:{method:'eth_chainId',intervalMs:15000,timeoutMs:10000},
    onStatus:status=>{
      if(status.state==='backoff')context.lastDisconnect={at:new Date().toISOString(),reason:status.lastError??'RPC_CONNECTION_CLOSED'};
      if(status.state!=='open'){
        const wasVerified=context.verified!==undefined;context.verified=undefined;context.httpVerified=undefined;context.slotChecking=undefined;
        if(wasVerified&&!stopped)port.postMessage({type:'coverage_lost',chain,at:new Date().toISOString()});
        return;
      }
      if(context.verified===status.generation||context.checking===status.generation||chain==='solana'&&context.httpVerified===status.generation)return;
      context.checking=status.generation;
      void (async()=>{
        try {
          await identity(chain,endpoint.http);
          if(chain==='solana'){
            if(stopped||context.stream.getStatus().generation!==status.generation)return;
            // Solana WebSocket servers expose subscriptions only. Pair the
            // HTTP mainnet genesis with the live WS slot below instead of
            // requiring the unsupported getGenesisHash WS method.
            context.httpVerified=status.generation;return;
          }
          if(await context.stream.request('eth_chainId')!==expectedIdentity(chain))throw new Error();
          if(stopped||context.stream.getStatus().generation!==status.generation)return;
          context.verified=status.generation;context.error=undefined;
        }catch{if(!stopped&&context.stream.getStatus().generation===status.generation){context.error='FAST_WALLET_IDENTITY_FAILED';context.stream.forceReconnect('RPC_CHAIN_IDENTITY_MISMATCH');}}
        finally{if(context.checking===status.generation)context.checking=undefined;}
      })();
    },
    onNotification:(key,data,meta)=>{
      if(stopped)return;
      if(key==='head'){
        if(chain==='solana'&&context.httpVerified===meta.generation&&context.verified!==meta.generation&&context.slotChecking!==meta.generation){
          const wsSlot=typeof data==='object'&&data!==null?Number((data as {slot?:unknown}).slot):NaN;
          if(Number.isSafeInteger(wsSlot)&&wsSlot>=0){context.slotChecking=meta.generation;void (async()=>{
            try {const httpSlot=Number(await httpRpc(endpoint.http,'getSlot'));
              if(!Number.isSafeInteger(httpSlot)||httpSlot<0||Math.abs(httpSlot-wsSlot)>1024)throw new Error();
              if(stopped||context.stream.getStatus().generation!==meta.generation)return;
              context.verified=meta.generation;context.error=undefined;
            }catch{if(!stopped&&context.stream.getStatus().generation===meta.generation){
              context.error='FAST_WALLET_IDENTITY_FAILED';context.stream.forceReconnect('RPC_CHAIN_IDENTITY_MISMATCH');}}
            finally{if(context.slotChecking===meta.generation)context.slotChecking=undefined;}
          })();}
        }
        return;
      }
      if(context.verified!==meta.generation||!snapshotAccepted||Date.now()>=snapshotExpiresAt)return;
      const events=judge.judge(chain,key,data,meta);
      if(!events.length)return;
      if(pending.size>=64){dropped+=events.length;return;}
      const id=++sequence;pending.add(id);port.postMessage({type:'events',id,events});
    }});
}
const status=()=>{
  if(stopped||statusPending)return;statusPending=true;
  const judgeStatus=judge.status(),snapshotFresh=snapshotAccepted&&Date.now()<snapshotExpiresAt&&judgeStatus.snapshotFresh;
  port.postMessage({type:'status',status:{enabled:true,running:true,asOf:new Date().toISOString(),mode:'preview_only',...judgeStatus,snapshotFresh,
    droppedEvents:dropped,pendingDelivery:pending.size,eventLoopP99Ms:lag.percentile(99)/1e6,
    chains:[...contexts].map(([chain,c])=>{const s=c.stream.getStatus(),wallets=judge.wallets(chain).slice(0,walletLimit(chain)),activeKeys=new Set(s.activeKeys),
      identityVerified=c.verified===s.generation&&s.state==='open',activeWallets=!identityVerified||!snapshotFresh?[]:chain==='solana'?
        wallets.filter(wallet=>activeKeys.has('wallet:'+wallet)):
        walletChunks(wallets).flatMap((chunk,index)=>activeKeys.has(`wallet:out:${index}`)&&activeKeys.has(`wallet:in:${index}`)?chunk:[]);
      return {chain,state:s.state,identityVerified,
      identityScope:chain==='solana'?'http_genesis_and_ws_slot':'http_and_ws',watchedWallets:judge.wallets(chain).length,
      activeWallets,
      activeSubscriptions:s.activeSubscriptions,desiredSubscriptions:s.desiredSubscriptions,reconnects:s.reconnects,
      subscribingSubscriptions:s.subscribingSubscriptions,queuedSubscriptions:s.queuedSubscriptions,
      retryingSubscriptions:s.retryingSubscriptions,subscriptionRetries:s.subscriptionRetries,
      maxConcurrentSubscriptions:s.maxConcurrentSubscriptions,peakConcurrentSubscriptions:s.peakConcurrentSubscriptions,
      lastMessageAt:s.lastMessageAt?new Date(s.lastMessageAt).toISOString():undefined,lastDisconnect:c.lastDisconnect,error:c.error??s.lastError};}),
    coverage:'rpc_subscription_acknowledged_wallets',replay:'historical_observer_separate',buyVerified:false,tradingEnabled:false}});
};
const timer=setInterval(status,1000);
port.on('message',message=>{
  if(message?.type==='snapshot')try{judge.update(message.snapshot as FastWalletSnapshot);snapshotAccepted=true;
    snapshotExpiresAt=Date.parse((message.snapshot as FastWalletSnapshot).validUntil);
    for(const chain of contexts.keys())subscriptions(chain);port.postMessage({type:'snapshot_applied'});
  }catch{snapshotAccepted=false;snapshotExpiresAt=0;port.postMessage({type:'failed',reason:'FAST_WALLET_SNAPSHOT_INVALID'});}
  else if(message?.type==='ack')pending.delete(message.id);
  else if(message?.type==='status_ack')statusPending=false;
  else if(message==='stop'){
    stopped=true;clearInterval(timer);abort.abort();lag.disable();for(const c of contexts.values())c.stream.stop();port.close();
  }
});
for(const chain of contexts.keys()){subscriptions(chain);contexts.get(chain)!.stream.start();}
status();
