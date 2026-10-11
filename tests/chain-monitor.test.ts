import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {ChainMonitor,type ChainMonitorOptions,type ChainMonitorClock} from '../src/chain-monitor.js';
import {ChainStreamStore,TRANSFER_TOPIC} from '../src/chain-stream-store.js';
import type {Chain} from '../src/types.js';
import type {ScanPrice,ScanToken} from '../src/scan-archive.js';
import type {RpcStreamOptions,RpcStreamStatus,RpcSubscription} from '../src/rpc-stream.js';
import type {PoolDiscovery,PoolPriceResult,VerifiedPool} from '../src/chain-prices.js';

const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const evm=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const pub=(n:number)=>bs58.encode(Buffer.alloc(32,n));
const sig=(n:number)=>{const bytes=Buffer.alloc(64,1);bytes.writeUInt32BE(n,0);return bs58.encode(bytes);};
const W=evm(10),W2=evm(11),A=evm(20),B=evm(21),C=evm(22),SW=pub(5);
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
class Clock implements ChainMonitorClock {
  time=Date.parse('2026-10-11T12:00:00.000Z');callbacks=new Set<()=>void>();
  now=()=>this.time;
  setInterval=(cb:()=>void)=>{this.callbacks.add(cb);return cb;};
  clearInterval=(handle:unknown)=>{this.callbacks.delete(handle as ()=>void);};
  async tick(ms=5000){this.time+=ms;for(const cb of this.callbacks)cb();await flush();}
}
class Stream {
  specs:RpcSubscription[]=[];calls:{method:string;params:readonly unknown[]}[]=[];autoAck=true;reasons:string[]=[];
  state:RpcStreamStatus['state']='stopped';generation=0;activeKeys:string[]=[];
  handler:(method:string,params:readonly unknown[])=>unknown=()=> '0x38';
  constructor(readonly options:RpcStreamOptions){}
  start(){this.state='connecting';this.generation++;this.emit();}
  stop(){this.state='stopped';this.generation++;this.activeKeys=[];this.emit();}
  open(){this.state='open';this.emit();this.ack();}
  disconnect(){this.state='backoff';this.activeKeys=[];this.emit();}
  reconnect(){this.start();this.open();}
  emit(){this.options.onStatus?.(this.getStatus());}
  ack(){if(this.state==='open'&&this.autoAck)this.activeKeys=this.specs.map(s=>s.key);}
  setSubscriptions(specs:readonly RpcSubscription[]){this.specs=[...specs];this.ack();}
  async request<T=unknown>(method:string,params:readonly unknown[]=[]):Promise<T>{this.calls.push({method,params});return await this.handler(method,params) as T;}
  forceReconnect(reason:'RPC_RECONNECT_REQUESTED'|'RPC_CHAIN_IDENTITY_MISMATCH'='RPC_RECONNECT_REQUESTED'){this.reasons.push(reason);this.disconnect();}
  getStatus():RpcStreamStatus {return {state:this.state,generation:this.generation,activeKeys:[...this.activeKeys],activeSubscriptions:this.activeKeys.length,
    desiredSubscriptions:this.specs.length,pendingRequests:0,reconnectAttempt:0,reconnects:Math.max(0,this.generation-1),requestsSent:this.calls.length,messagesReceived:0,notificationsReceived:0};}
  notify(key:string,data:unknown,generation=this.generation){this.options.onNotification(key,data,{generation,receivedAt:0,subscriptionId:'s'});}
}
function fixture(t:TestContext,chain:Chain='bsc',opts:{tokens?:ScanToken[];wallets?:string[];maxPools?:number;autoAck?:boolean}={}){
  const clock=new Clock(),store=new ChainStreamStore(':memory:'),prices:ScanPrice[]=[],calls:{method:string;params:readonly unknown[]}[]=[],pairCalls:string[]=[];
  let tokens=opts.tokens??[],wallets=opts.wallets??[],rpcStopped=false,marketStopped=false;
  let handler:(method:string,params:readonly unknown[])=>unknown=method=>{
    if(method==='eth_chainId')return chain==='robinhood'?'0x1237':'0x38';
    if(method==='getGenesisHash')return GENESIS;
    if(method==='eth_blockNumber')return '0x100';
    if(method==='eth_getLogs'||method==='getSignaturesForAddress')return [];
    throw new Error('unexpected');
  };
  const rpc={request:async(method:string,params:readonly unknown[]=[])=>{calls.push({method,params});return await handler(method,params);},stop:()=>{rpcStopped=true;}};
  let pairs:(chain:Chain,address:string)=>Promise<Record<string,any>[]>=async(_chain,address)=>{pairCalls.push(address);return [{pairAddress:chain==='solana'?pub(9):evm(90)}];};
  let discover:NonNullable<ChainMonitorOptions['discoverPool']>=async token=>supported(token);
  let read:NonNullable<ChainMonitorOptions['readPoolPrice']>=async pool=>sample(pool,clock);
  let stream!:Stream;
  const monitor=new ChainMonitor({config:{enabled:true,database:':memory:',maxBytes:16*1024*1024,maxWallets:10,maxPools:opts.maxPools??2,
    endpoints:{[chain]:{http:'https://rpc.invalid',ws:'wss://rpc.invalid'}}},store,clock,tokens:()=>tokens,wallets:()=>wallets,onPrice:p=>prices.push(p),
    market:{pairs:(chain,address)=>pairs(chain,address),anchor:async(chain,address)=>({chain,address,priceUsd:1,observedAt:new Date(clock.now()).toISOString(),source:'vendor_reference'}),stop:()=>{marketStopped=true;}},
    httpFactory:()=>rpc,streamFactory:options=>{stream=new Stream(options);stream.handler=()=>chain==='robinhood'?'0x1237':'0x38';stream.autoAck=opts.autoAck??true;return stream;},
    discoverPool:(...args)=>discover(...args),readPoolPrice:(...args)=>read(...args)});
  t.after(()=>monitor.stop());
  return {monitor,clock,store,stream,prices,calls,pairCalls,
    setHandler:(fn:typeof handler)=>{handler=fn;},setPairs:(fn:typeof pairs)=>{pairs=fn;},setDiscover:(fn:typeof discover)=>{discover=fn;},setRead:(fn:typeof read)=>{read=fn;},
    setTokens:(next:ScanToken[])=>{tokens=next;},setWallets:(next:string[])=>{wallets=next;},stopped:()=>rpcStopped&&marketStopped,
    status:()=>monitor.getStatus().chains.find(c=>c.chain===chain)!,
    open:async()=>{monitor.start();stream.open();await flush();},head:()=>stream.notify('head',chain==='solana'?{slot:1000}:{number:'0x100'})};
}
function supported(token:ScanToken):PoolDiscovery {
  const pool:VerifiedPool={...token,poolAddress:token.chain==='solana'?pub(9):evm(90),protocol:token.chain==='solana'?'pumpswap':'pancake_v2',
    quoteAddress:token.chain==='solana'?pub(8):evm(80),baseDecimals:18,quoteDecimals:18};
  return {status:'supported',pool,subscriptions:[{key:'pool:'+token.address,subscribeMethod:'eth_subscribe',params:['logs',{}],unsubscribeMethod:'eth_unsubscribe',notificationMethod:'eth_subscription'}]};
}
function sample(pool:VerifiedPool,clock:Clock):PoolPriceResult {return {status:'sampled',price:{chain:pool.chain,address:pool.address,source:'chain_pool_sample',
  priceUsd:2,observedAt:new Date(clock.now()).toISOString(),metadata:{pool:pool.poolAddress,protocol:pool.protocol,quoteAddress:pool.quoteAddress,quotePriceUsd:1,
    anchorAt:new Date(clock.now()).toISOString(),anchorSource:'vendor_reference',blockTime:new Date(clock.now()).toISOString(),pricing:'spot_before_fees_and_slippage'}}};}
function log(wallet=W,direction:'from'|'to'='from',block=250){return {address:A,topics:[TRANSFER_TOPIC,
  '0x'+(direction==='from'?wallet:W2).slice(2).padStart(64,'0'),'0x'+(direction==='to'?wallet:W2).slice(2).padStart(64,'0')],
  data:'0x'+(5).toString(16).padStart(64,'0'),transactionHash:'0x'+'a'.repeat(64),blockHash:'0x'+'b'.repeat(64),blockNumber:'0x'+block.toString(16),logIndex:'0x0',removed:false};}
const row=(n:number,slot=1000-n)=>({signature:sig(n),slot,err:null,confirmationStatus:'finalized'});

test('HTTP and EVM websocket identities must both match; pre-identity notifications never write',async t=>{
  const f=fixture(t,'bsc',{wallets:[W]}),wait=deferred<unknown>();
  f.setHandler(method=>method==='eth_chainId'?wait.promise:[]);
  f.monitor.start();f.stream.open();f.stream.notify('wallet:from',log());assert.equal(f.store.stats().events,0);
  f.stream.handler=()=> '0x1'; // Already-issued request used 0x38; HTTP mismatch still rejects.
  wait.resolve('0x1');await flush();assert.equal(f.status().identityVerified,false);assert.equal(f.store.stats().events,0);
  assert.deepEqual(f.stream.reasons,['RPC_CHAIN_IDENTITY_MISMATCH']);assert.equal(f.pairCalls.length,0);
});

test('correct HTTP identity cannot make a websocket on another EVM chain trusted',async t=>{
  const f=fixture(t,'bsc',{wallets:[W]});f.stream.handler=()=> '0x1';await f.open();
  assert.equal(f.status().identityVerified,false);assert.deepEqual(f.stream.reasons,['RPC_CHAIN_IDENTITY_MISMATCH']);
  assert.ok(f.calls.every(c=>c.method==='eth_chainId'));
});

test('late identity results after disconnect or stop cannot launch discovery',async t=>{
  for(const stop of [false,true]){
    const f=fixture(t,'bsc',{tokens:[{chain:'bsc',address:A}]}),wait=deferred<unknown>();f.setHandler(()=>wait.promise);
    f.monitor.start();f.stream.open();const stopped=stop?f.monitor.stop():undefined;if(!stop)f.stream.disconnect();
    wait.resolve('0x38');await flush();if(stopped)await stopped;
    assert.equal(f.pairCalls.length,0);if(!stop)assert.equal(f.status().identityVerified,false);
  }
});

test('Solana uses the full mainnet genesis and explicitly limits identity scope to paired HTTP',async t=>{
  const f=fixture(t,'solana');await f.open();assert.equal(f.status().identityVerified,true);assert.equal(f.status().identityScope,'paired_http_rpc');
  const bad=fixture(t,'solana');bad.setHandler(()=>GENESIS.slice(0,32));await bad.open();assert.equal(bad.status().identityVerified,false);
  assert.equal(bad.status().lastError,'CHAIN_IDENTITY_MISMATCH');
});

test('Robinhood verifies chain 4663 on both transports',async t=>{
  const f=fixture(t,'robinhood');await f.open();assert.equal(f.status().identityVerified,true);assert.equal(f.status().identityScope,'http_rpc_and_evm_ws');
  assert.equal(f.calls[0].method,'eth_chainId');assert.equal(f.stream.calls[0].method,'eth_chainId');
});

test('discovery results from an old generation never install a pool or subscription',async t=>{
  const f=fixture(t,'bsc',{tokens:[{chain:'bsc',address:A}]}),wait=deferred<PoolDiscovery>();f.setDiscover(()=>wait.promise);
  await f.open();f.stream.disconnect();wait.resolve(supported({chain:'bsc',address:A}));await flush();
  assert.equal(f.status().watchedPools,0);assert.equal(f.prices.length,0);assert.ok(f.stream.specs.every(s=>!s.key.startsWith('pool:')));
});

test('in-flight price reads cannot write after disconnect even if a new identity is ready',async t=>{
  const token:ScanToken={chain:'bsc',address:A},f=fixture(t,'bsc',{tokens:[token]}),wait=deferred<PoolPriceResult>();
  f.setRead(()=>wait.promise);await f.open();f.stream.disconnect();f.stream.reconnect();await flush();
  const d=supported(token);assert.equal(d.status,'supported');if(d.status!=='supported')return;wait.resolve(sample(d.pool,f.clock));await flush();
  assert.equal(f.prices.length,0);assert.equal(f.monitor.covers(token),false);
  f.setRead(async pool=>sample(pool,f.clock));await f.clock.tick();f.head();assert.equal(f.prices.length,1);assert.equal(f.monitor.covers(token),true);
});

test('coverage requires current-generation sample, all pool ACKs, fresh head and fresh real price',async t=>{
  const token:ScanToken={chain:'bsc',address:A},f=fixture(t,'bsc',{tokens:[token],autoAck:false});await f.open();f.head();
  assert.equal(f.prices.length,0);assert.equal(f.monitor.covers(token),false);
  f.stream.autoAck=true;f.stream.ack();await f.clock.tick();f.head();assert.equal(f.monitor.covers(token),true);
  f.clock.time+=45000;assert.equal(f.monitor.covers(token),false);f.head();assert.equal(f.monitor.covers(token),true);
  f.clock.time+=45000;f.head();assert.equal(f.monitor.covers(token),false);
  f.stream.disconnect();assert.equal(f.monitor.covers(token),false);
});

test('coverage expires with the oldest block or USD anchor instead of renewing it at retrieval',async t=>{
  for(const field of ['blockTime','anchorAt'] as const){
    const token:ScanToken={chain:'bsc',address:A},f=fixture(t,'bsc',{tokens:[token]});
    f.setRead(async pool=>{const r=sample(pool,f.clock);if(r.status==='sampled')r.price.metadata[field]=new Date(f.clock.now()-89000).toISOString();return r;});
    await f.open();f.head();assert.equal(f.monitor.covers(token),true);
    f.clock.time+=1000;f.head();assert.equal(f.monitor.covers(token),false);
  }
});

test('wrong-token, future, stale, bad-price and unavailable results retain GMGN fallback',async t=>{
  const bads:((r:Extract<PoolPriceResult,{status:'sampled'}>,clock:Clock)=>void)[]=[
    r=>{r.price.address=B;},r=>{r.price.chain='solana';},r=>{r.price.priceUsd=NaN;},
    (r,c)=>{r.price.observedAt=new Date(c.now()+1).toISOString();},
    (r,c)=>{r.price.metadata.blockTime=new Date(c.now()-90001).toISOString();},
    (r,c)=>{r.price.metadata.anchorAt=new Date(c.now()-90001).toISOString();},
  ];
  for(const mutate of bads){const token:ScanToken={chain:'bsc',address:A},f=fixture(t,'bsc',{tokens:[token]});
    f.setRead(async pool=>{const r=sample(pool,f.clock);if(r.status==='sampled')mutate(r,f.clock);return r;});await f.open();f.head();
    assert.equal(f.prices.length,0);assert.equal(f.monitor.covers(token),false);assert.equal(f.status().lastError,'CHAIN_PRICE_INVALID');}
});

test('archive reordering preserves existing pool subscriptions; a removed token releases its slot',async t=>{
  const ta:ScanToken={chain:'bsc',address:A},tb:ScanToken={chain:'bsc',address:B},tc:ScanToken={chain:'bsc',address:C};
  const f=fixture(t,'bsc',{tokens:[ta,tb,tc],maxPools:2});await f.open();await f.clock.tick();assert.deepEqual(f.pairCalls,[A,B]);
  f.setTokens([tc,tb,ta]);await f.clock.tick(60000);assert.deepEqual(f.pairCalls,[A,B]);
  assert.ok(f.stream.specs.some(s=>s.key==='pool:'+A));assert.ok(!f.stream.specs.some(s=>s.key==='pool:'+C));
  f.setTokens([tc,tb]);await f.clock.tick(60000);assert.deepEqual(f.pairCalls,[A,B,C]);assert.ok(!f.stream.specs.some(s=>s.key==='pool:'+A));
});

test('unsupported pools retry only after ten minutes and discoveries remain one per cycle',async t=>{
  const f=fixture(t,'bsc',{tokens:[{chain:'bsc',address:A},{chain:'bsc',address:B}]});f.setDiscover(async()=>({status:'unsupported',reason:'POOL_PROTOCOL_UNSUPPORTED'}));
  await f.open();assert.deepEqual(f.pairCalls,[A]);await f.clock.tick();assert.deepEqual(f.pairCalls,[A,B]);
  await f.clock.tick(590000);assert.deepEqual(f.pairCalls,[A,B]);await f.clock.tick(5000);assert.deepEqual(f.pairCalls,[A,B,A]);
});

test('unsupported candidates use no subscription slots and cannot starve a later supported token',async t=>{
  const f=fixture(t,'bsc',{tokens:[A,B,C].map(address=>({chain:'bsc',address})),maxPools:1});
  f.setDiscover(async token=>token.address===C?supported(token):{status:'unsupported',reason:'POOL_PROTOCOL_UNSUPPORTED'});
  await f.open();await f.clock.tick();await f.clock.tick();assert.deepEqual(f.pairCalls,[A,B,C]);
  assert.equal(f.status().watchedPools,1);assert.ok(f.stream.specs.some(s=>s.key==='pool:'+C));
});

test('temporary discovery failures expose a safe reason and retry after 30 seconds',async t=>{
  const f=fixture(t,'bsc',{tokens:[{chain:'bsc',address:A}]});
  f.setDiscover(async()=>({status:'unsupported',reason:'CHAIN_PRICE_RPC_FAILED'}));await f.open();
  assert.equal(f.status().lastError,'CHAIN_PRICE_RPC_FAILED');await f.clock.tick(29999);assert.equal(f.pairCalls.length,1);
  f.setDiscover(async token=>supported(token));await f.clock.tick(1);assert.equal(f.pairCalls.length,2);assert.equal(f.status().watchedPools,1);
  assert.equal(f.status().lastError,undefined);
});

test('EVM bounded replay writes validated transfers and advances only after both directions finish',async t=>{
  const f=fixture(t,'bsc',{wallets:[W]});let directions=0;
  f.setHandler((method,params)=>method==='eth_chainId'?'0x38':method==='eth_blockNumber'?'0x100':++directions===1?[log()]:[]);
  await f.open();assert.equal(f.store.stats().events,1);assert.equal(f.store.cursor('bsc:'+W),'253');assert.equal(f.status().gap?.pending,false);
  const requests=f.calls.filter(c=>c.method==='eth_getLogs');assert.equal(requests.length,2);
  assert.equal((requests[0].params[0] as any).fromBlock,'0xed');assert.equal((requests[1].params[0] as any).toBlock,'0xfd');
  assert.equal(f.store.recent()[0].source,'backfill');
});

test('canonical NFT Transfers in mixed EVM pages do not block fungible records or the cursor',async t=>{
  const f=fixture(t,'bsc',{wallets:[W]});
  const nft=(direction:'from'|'to')=>{const event=log(W,direction);return {...event,topics:[...event.topics,'0x'+'0'.repeat(63)+'7'],data:'0x',logIndex:'0x1'};};
  f.setHandler((method,params)=>{
    if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x100';
    return (params[0] as any).topics.length===2?[nft('from'),log()]:[nft('to')];
  });
  await f.open();assert.equal(f.store.stats().events,1);assert.equal(f.store.recent()[0].amountAtomic,'5');
  assert.equal(f.store.recent()[0].eventIndex,0);assert.equal(f.store.cursor('bsc:'+W),'253');assert.equal(f.status().gap?.pending,false);
});

test('an NFT-looking log must still match wallet, range, hashes and full indexed token ID',async t=>{
  const base=log();const nft={...base,topics:[...base.topics,'0x'+'0'.repeat(64)],data:'0x'};
  for(const malformed of [
    {...nft,topics:[TRANSFER_TOPIC,nft.topics[2],nft.topics[1],nft.topics[3]]},
    {...nft,blockNumber:'0x999'}, {...nft,transactionHash:'0x123'}, {...nft,blockHash:'bad'},
    {...nft,topics:[...base.topics,'0x1']}, {...nft,data:'0x00'}, {...nft,removed:true},
    {...nft,topics:[TRANSFER_TOPIC,'0x'+'f'.repeat(64),base.topics[2],nft.topics[3]]},
  ]){
    const f=fixture(t,'bsc',{wallets:[W]});f.setHandler(method=>method==='eth_chainId'?'0x38':method==='eth_blockNumber'?'0x100':[malformed]);
    await f.open();assert.equal(f.store.stats().events,0);assert.equal(f.store.cursor('bsc:'+W),undefined);
    assert.equal(f.status().gap?.pending,true);assert.equal(f.status().lastError,'CHAIN_BACKFILL_INVALID');
  }
});

test('failed second EVM direction retains cursor and records an unresolved pass',async t=>{
  const f=fixture(t,'bsc',{wallets:[W]});let requests=0;
  f.setHandler(method=>{if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x100';if(++requests===1)return [log()];throw new Error('provider secret');});
  await f.open();assert.equal(f.store.stats().events,1);assert.equal(f.store.cursor('bsc:'+W),undefined);assert.equal(f.status().gap?.pending,true);
  assert.equal(f.status().gap?.lastCompletedAt,undefined);assert.equal(f.status().lastError,'CHAIN_COLLECTION_FAILED');
});

test('malformed, unrelated, out-of-range and truncated EVM logs cannot advance a checkpoint',async t=>{
  for(const logs of [[{...log(),data:'bad'}],[log(W2)],[log(W,'from',999)],Array.from({length:1000},()=>log())]){
    const f=fixture(t,'bsc',{wallets:[W]});f.setHandler(method=>method==='eth_chainId'?'0x38':method==='eth_blockNumber'?'0x100':logs);
    await f.open();assert.equal(f.store.cursor('bsc:'+W),undefined);assert.equal(f.status().gap?.pending,true);assert.equal(f.status().gap?.lastCompletedAt,undefined);
    if(logs.length===1000){assert.equal(f.status().gap?.incomplete,true);assert.equal(f.store.stats().incomplete,true);}
  }
});

test('large EVM gaps are explicit and never silently jump over old blocks',async t=>{
  const f=fixture(t,'bsc',{wallets:[W]});f.store.checkpoint('bsc:'+W,'10');
  f.setHandler(method=>method==='eth_chainId'?'0x38':method==='eth_blockNumber'?'0x2000':[]);await f.open();
  assert.equal(f.store.cursor('bsc:'+W),'522');assert.equal(f.status().gap?.pending,true);assert.equal(f.status().gap?.incomplete,true);
  assert.equal((f.calls.find(c=>c.method==='eth_getLogs')!.params[0] as any).fromBlock,'0xb');
});

test('disconnect while awaiting replay discards responses and does not advance the cursor',async t=>{
  const f=fixture(t,'bsc',{wallets:[W]}),wait=deferred<unknown>();
  f.setHandler(method=>method==='eth_chainId'?'0x38':method==='eth_blockNumber'?'0x100':wait.promise);
  await f.open();f.stream.disconnect();wait.resolve([log()]);await flush();assert.equal(f.store.stats().events,0);assert.equal(f.store.cursor('bsc:'+W),undefined);
});

test('one failed wallet cannot be hidden by the last wallet succeeding',async t=>{
  const f=fixture(t,'bsc',{wallets:[W,W2]});let first=true;
  f.setHandler(method=>{if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber'){if(first){first=false;throw new Error('offline');}return '0x100';}return [];});
  await f.open();assert.equal(f.status().gap?.pending,true);await f.clock.tick();assert.equal(f.store.cursor('bsc:'+W2),'253');
  assert.equal(f.status().gap?.pending,true);assert.equal(f.status().gap?.lastCompletedAt,undefined);
  await f.clock.tick();assert.equal(f.status().gap?.pending,false);assert.ok(f.status().gap?.lastCompletedAt);
});

test('Solana websocket mentions never write confirmed events or bypass the fixed HTTP cadence',async t=>{
  const f=fixture(t,'solana',{wallets:[SW]});await f.open();const before=f.calls.length;
  for(let i=0;i<100;i++)f.stream.notify('wallet:'+SW,{context:{slot:10},value:{signature:sig(i+1),err:null}});
  await flush();assert.equal(f.calls.length,before);assert.equal(f.store.stats().events,0);assert.equal(f.status().gap?.pending,true);
  f.setHandler(method=>method==='getGenesisHash'?GENESIS:[row(1)]);await f.clock.tick();
  assert.equal(f.store.stats().events,1);assert.equal(f.store.recent()[0].source,'backfill');assert.equal(f.store.recent()[0].verification,'rpc_confirmed');
});

test('Solana replay requires 64-byte signatures, finalized confirmation, integer slots and ordered unique rows',async t=>{
  const cases:unknown[][]=[[{...row(1),signature:pub(1)}],[{...row(1),confirmationStatus:'confirmed'}],[{...row(1),slot:-1}],
    [{...row(1),slot:1.5}],[row(1),row(1)],[row(2),row(1)],[{...row(1),err:undefined}]];
  for(const rows of cases){const f=fixture(t,'solana',{wallets:[SW]});f.setHandler(method=>method==='getGenesisHash'?GENESIS:rows);await f.open();
    assert.equal(f.store.stats().events,0);assert.equal(f.store.cursor('solana:'+SW),undefined);assert.equal(f.status().gap?.pending,true);
    assert.equal(f.status().lastError,'CHAIN_BACKFILL_INVALID');}
});

test('Solana replay skips failed transactions but advances the verified newest finalized cursor',async t=>{
  const f=fixture(t,'solana',{wallets:[SW]});f.setHandler(method=>method==='getGenesisHash'?GENESIS:[{...row(1),err:{InstructionError:[0,'InvalidArgument']}},row(2)]);
  await f.open();assert.equal(f.store.stats().events,1);assert.equal(f.store.recent()[0].txHash,sig(2));assert.equal(f.store.cursor('solana:'+SW),sig(1));
  assert.equal(f.status().gap?.pending,false);
});

test('Solana replay uses until/before cursors and never advances a truncated three-page range',async t=>{
  const f=fixture(t,'solana',{wallets:[SW]});f.store.checkpoint('solana:'+SW,sig(999));let pages=0;
  f.setHandler(method=>{if(method==='getGenesisHash')return GENESIS;const rows=Array.from({length:50},(_,i)=>row(1+pages*50+i));pages++;return rows;});
  await f.open();assert.equal(pages,3);assert.equal(f.store.stats().events,150);assert.equal(f.store.cursor('solana:'+SW),sig(999));
  assert.equal(f.status().gap?.pending,true);assert.equal(f.status().gap?.incomplete,true);assert.equal(f.status().gap?.lastCompletedAt,undefined);
  const calls=f.calls.filter(c=>c.method==='getSignaturesForAddress');assert.equal((calls[0].params[1] as any).until,sig(999));assert.equal((calls[1].params[1] as any).before,sig(50));
});

test('Solana initial recent-history baseline is explicit when its first page is full',async t=>{
  const f=fixture(t,'solana',{wallets:[SW]});f.setHandler(method=>method==='getGenesisHash'?GENESIS:Array.from({length:50},(_,i)=>row(i+1)));await f.open();
  assert.equal(f.store.cursor('solana:'+SW),sig(1));assert.equal(f.status().gap?.incomplete,true);assert.equal(f.status().lastError,'CHAIN_INITIAL_HISTORY_WINDOW');
  assert.equal(f.calls.filter(c=>c.method==='getSignaturesForAddress').length,1);
});

test('Solana second page failure preserves the prior cursor and prevents a false completion',async t=>{
  const f=fixture(t,'solana',{wallets:[SW]});f.store.checkpoint('solana:'+SW,sig(999));let count=0;
  f.setHandler(method=>{if(method==='getGenesisHash')return GENESIS;if(++count===1)return Array.from({length:50},(_,i)=>row(i+1));throw new Error('RPC credential');});
  await f.open();assert.equal(f.store.stats().events,50);assert.equal(f.store.cursor('solana:'+SW),sig(999));
  assert.equal(f.status().gap?.pending,true);assert.equal(f.status().gap?.lastCompletedAt,undefined);assert.equal(f.status().lastError,'CHAIN_COLLECTION_FAILED');
});

test('Solana late replay responses after stop cannot write or checkpoint',async t=>{
  const f=fixture(t,'solana',{wallets:[SW]});f.store.checkpoint('solana:'+SW,sig(999));const wait=deferred<unknown>();let count=0;
  let writes=0,checkpoints=0;const record=f.store.record.bind(f.store),checkpoint=f.store.checkpoint.bind(f.store);
  f.store.record=event=>{writes++;return record(event);};f.store.checkpoint=(key,value)=>{checkpoints++;return checkpoint(key,value);};
  f.setHandler(method=>method==='getGenesisHash'?GENESIS:++count===1?Array.from({length:50},(_,i)=>row(i+1)):wait.promise);
  await f.open();assert.equal(f.store.stats().events,50);const stopped=f.monitor.stop();wait.resolve([row(51)]);await flush();
  await stopped;assert.equal(writes,50);assert.equal(checkpoints,0);assert.equal(f.stopped(),true);assert.equal(f.clock.callbacks.size,0);
});

test('stop clears schedule, stops dependencies and ignores old-generation notifications',async t=>{
  const f=fixture(t,'bsc',{wallets:[W]});await f.open();const generation=f.stream.generation;await f.monitor.stop();
  assert.equal(f.clock.callbacks.size,0);assert.equal(f.stopped(),true);f.stream.notify('wallet:from',log(),generation);
  await f.clock.tick();assert.equal(f.stream.state,'stopped');
});
