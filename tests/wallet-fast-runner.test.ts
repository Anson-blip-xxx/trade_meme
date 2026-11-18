import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import bs58 from 'bs58';
import {WalletFastRunner} from '../src/wallet-fast-runner.js';
import type {FastWalletEvent} from '../src/wallet-fast.js';

// ws is already pinned by socket.io-client's engine.io-client dependency.
const {WebSocketServer}=createRequire(import.meta.url)('ws');
async function until(check:()=>boolean,timeout=8000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error('TEST_WAIT_TIMEOUT');await new Promise(r=>setTimeout(r,20));}}

test('one worker status publishes all due chain coverage through one batch callback',()=>{
  const batches:{chain:string;wallets:string[];at:string}[][]=[],now=new Date().toISOString(),runner=new WalletFastRunner({
    endpoints:{bsc:{http:'http://127.0.0.1:1',ws:'ws://127.0.0.1:1'},robinhood:{http:'http://127.0.0.1:2',ws:'ws://127.0.0.1:2'}},
    maxWallets:10,snapshot:()=>({at:now,validUntil:new Date(Date.now()+60_000).toISOString(),targets:[],tokens:[]}),onEvent:()=>{},
    onCoverageBatch:updates=>batches.push(updates.map(update=>({...update,wallets:[...update.wallets]}))),
  });
  (runner as any).snapshotHealthy=true;
  const status={asOf:now,snapshotFresh:true,chains:[{chain:'bsc',activeWallets:['0x'+'1'.repeat(40)]},
    {chain:'robinhood',activeWallets:['0x'+'2'.repeat(40)]}]};
  assert.equal((runner as any).acceptCoverageStatus(status),true);assert.equal(batches.length,1);assert.deepEqual(
    batches[0].map(update=>update.chain),['bsc','robinhood']);
  assert.equal((runner as any).acceptCoverageStatus(status),true);assert.equal(batches.length,1,'unchanged coverage waits for the heartbeat');
  for(const value of (runner as any).coverage.values())value.sentAt=0;
  assert.equal((runner as any).acceptCoverageStatus(status),true);assert.equal(batches.length,2,'both heartbeat renewals share one callback');
});

test('independent worker subscribes processed, verifies the endpoint and judges while the HTTP thread is blocked',async t=>{
  const wallet=bs58.encode(new Uint8Array(32).fill(9)),signature=bs58.encode(new Uint8Array(64).fill(8));
  const server=createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{const body=JSON.parse(raw);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,
      result:body.method==='getSlot'?123:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'}));});});
  const sockets=new WebSocketServer({server}),requests:any[]=[];let socket:any,sub:number|undefined;
  sockets.on('connection',(s:any)=>{socket=s;s.on('message',(raw:Buffer)=>{const req=JSON.parse(raw.toString());requests.push(req);
    const id=requests.length;if(req.method==='logsSubscribe')sub=id;
    const result=req.method.endsWith('Unsubscribe')?true:id;s.send(JSON.stringify({jsonrpc:'2.0',id:req.id,result}));
    if(req.method==='slotSubscribe')for(const delay of [50,200])setTimeout(()=>{if(s.readyState===1)s.send(JSON.stringify({jsonrpc:'2.0',method:'slotNotification',
      params:{subscription:id,result:{slot:123,parent:122,root:120}}}));},delay);});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port,events:FastWalletEvent[]=[],
    coverage:{wallets:string[];at:string}[]=[];let snapshotFails=false;
  const runner=new WalletFastRunner({endpoints:{solana:{http:`http://127.0.0.1:${port}`,ws:`ws://127.0.0.1:${port}`}},maxWallets:10,
    snapshot:()=>{if(snapshotFails)throw new Error('test snapshot failure');const now=Date.now();return {at:new Date(now).toISOString(),validUntil:new Date(now+3500).toISOString(),targets:[{chain:'solana',wallet,groups:['forward_validated'],profileUntil:new Date(now+120000).toISOString()}],tokens:[]};},
    onEvent:e=>events.push(e),onCoverage:(_chain,wallets,at)=>coverage.push({wallets,at})});
  t.after(async()=>{await runner.stop();for(const client of sockets.clients)client.terminate();await new Promise<void>(r=>sockets.close(()=>r()));server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  runner.start();await until(()=>sub!==undefined&&runner.status().chains?.[0]?.identityVerified).catch(()=>{throw new Error(JSON.stringify({status:runner.status(),requests}));});
  assert.equal(requests.find(r=>r.method==='logsSubscribe').params[1].commitment,'processed');
  await until(()=>coverage.some(row=>row.wallets.includes(wallet)));
  assert.ok(runner.status().chains[0].activeWallets.includes(wallet));
  const coverageWrites=coverage.length;await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal(coverage.length,coverageWrites,'unchanged ACK coverage is heartbeated every 30 seconds instead of every status tick');
  socket.send(JSON.stringify({jsonrpc:'2.0',method:'logsNotification',params:{subscription:sub,result:{context:{slot:123},value:{signature,err:null,logs:[]}}}}));
  const end=Date.now()+350;while(Date.now()<end){Math.sqrt(913);}
  await until(()=>events.length===1);
  assert.equal(events[0].verdict,'priority_review');assert.equal(events[0].buyVerified,false);
  assert.ok(Date.parse(events[0].judgedAt)<end,'worker produces the verdict without waiting for the main event loop');
  assert.ok(runner.status().mainThreadHandoff.maxMs>=0);
  assert.ok(runner.status().recentEvents[0].handoffMs>=300);
  assert.ok(Number.isFinite(Date.parse(runner.status().recentEvents[0].mainThreadReceivedAt)));
  const encoded=JSON.stringify(runner.status());assert.equal(encoded.includes('127.0.0.1'),false);
  await until(()=>runner.status().snapshotFresh===false&&coverage.at(-1)?.wallets.length===0,6000);
  assert.deepEqual(runner.status().chains[0].activeWallets,[],'expired snapshots cannot advertise ACK coverage');
  (runner as any).refresh();await until(()=>coverage.at(-1)?.wallets.includes(wallet)===true);
  snapshotFails=true;(runner as any).refresh();await until(()=>coverage.at(-1)?.wallets.length===0);
  assert.equal(runner.status().error,'FAST_WALLET_TARGET_REFRESH_FAILED');
  socket.close();await until(()=>coverage.at(-1)?.wallets.length===0);
});

test('Solana coverage requires the WebSocket live slot to match the verified HTTP mainnet endpoint',async t=>{
  const wallet=bs58.encode(new Uint8Array(32).fill(7));
  const server=createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{const body=JSON.parse(raw);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,
      result:body.method==='getSlot'?100:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'}));});});
  const sockets=new WebSocketServer({server});let requests=0;
  sockets.on('connection',(socket:any)=>socket.on('message',(raw:Buffer)=>{const req=JSON.parse(raw.toString());requests++;
    const result=req.method.endsWith('Unsubscribe')?true:requests;socket.send(JSON.stringify({jsonrpc:'2.0',id:req.id,result}));
    if(req.method==='slotSubscribe')setTimeout(()=>{if(socket.readyState===1)socket.send(JSON.stringify({jsonrpc:'2.0',method:'slotNotification',
      params:{subscription:result,result:{slot:10_000,parent:9_999,root:9_990}}}));},50);}));
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port,coverage:string[][]=[];
  const runner=new WalletFastRunner({endpoints:{solana:{http:`http://127.0.0.1:${port}`,ws:`ws://127.0.0.1:${port}`}},maxWallets:10,
    snapshot:()=>{const now=Date.now();return {at:new Date(now).toISOString(),validUntil:new Date(now+120000).toISOString(),
      targets:[{chain:'solana',wallet,groups:['launcher_candidate'],profileUntil:new Date(now+120000).toISOString()}],tokens:[]};},
    onEvent:()=>{},onCoverage:(_chain,wallets)=>coverage.push(wallets)});
  t.after(async()=>{await runner.stop();for(const client of sockets.clients)client.terminate();await new Promise<void>(r=>sockets.close(()=>r()));
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  runner.start();await until(()=>runner.status().chains?.[0]?.error==='FAST_WALLET_IDENTITY_FAILED');
  assert.equal(runner.status().chains[0].identityVerified,false);assert.equal(coverage.some(wallets=>wallets.includes(wallet)),false);
});

test('a recovered event callback clears current error but retains the last diagnostic',async t=>{
  const wallet=bs58.encode(new Uint8Array(32).fill(6)),signatures=[8,9].map(n=>bs58.encode(new Uint8Array(64).fill(n)));
  const server=createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{const body=JSON.parse(raw);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,
      result:body.method==='getSlot'?123:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'}));});});
  const sockets=new WebSocketServer({server});let socket:any,subscription:number|undefined,sequence=0;
  sockets.on('connection',(value:any)=>{socket=value;value.on('message',(raw:Buffer)=>{const req=JSON.parse(raw.toString()),id=++sequence;
    if(req.method==='logsSubscribe')subscription=id;const result=req.method.endsWith('Unsubscribe')?true:id;
    value.send(JSON.stringify({jsonrpc:'2.0',id:req.id,result}));
    if(req.method==='slotSubscribe')for(const delay of [50,200])setTimeout(()=>{if(value.readyState===1)value.send(JSON.stringify({jsonrpc:'2.0',method:'slotNotification',
      params:{subscription:id,result:{slot:123,parent:122,root:120}}}));},delay);});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;let delivered=0;
  const runner=new WalletFastRunner({endpoints:{solana:{http:`http://127.0.0.1:${port}`,ws:`ws://127.0.0.1:${port}`}},maxWallets:10,
    snapshot:()=>{const now=Date.now();return {at:new Date(now).toISOString(),validUntil:new Date(now+120000).toISOString(),
      targets:[{chain:'solana',wallet,groups:['launcher_candidate'],profileUntil:new Date(now+120000).toISOString()}],tokens:[]};},
    onEvent:()=>{if(++delivered===1)throw new Error('private callback detail');}});
  t.after(async()=>{await runner.stop();for(const client of sockets.clients)client.terminate();await new Promise<void>(r=>sockets.close(()=>r()));
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  runner.start();await until(()=>subscription!==undefined&&runner.status().chains?.[0]?.identityVerified);
  const emit=(signature:string)=>socket.send(JSON.stringify({jsonrpc:'2.0',method:'logsNotification',params:{subscription,
    result:{context:{slot:123},value:{signature,err:null,logs:[]}}}}));
  emit(signatures[0]);await until(()=>runner.status().error==='FAST_WALLET_RESEARCH_ENQUEUE_FAILED');
  emit(signatures[1]);await until(()=>delivered===2&&runner.status().error===undefined);
  assert.equal(runner.status().lastError,'FAST_WALLET_RESEARCH_ENQUEUE_FAILED');assert.ok(runner.status().lastErrorAt);
  assert.doesNotMatch(JSON.stringify(runner.status()),/private callback detail/);
});

test('Solana wallet-fast advances 31 subscriptions through four-ACK windows across reconnects',async t=>{
  const wallets=Array.from({length:30},(_,index)=>bs58.encode(new Uint8Array(32).fill(index+1)));
  const server=createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{const body=JSON.parse(raw);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,
      result:body.method==='getSlot'?123:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'}));});});
  const sockets=new WebSocketServer({server}),connections:{socket:any;inFlight:number;peak:number;subscribeMethods:string[];nextId:number}[]=[];
  sockets.on('connection',(socket:any)=>{const state={socket,inFlight:0,peak:0,subscribeMethods:[] as string[],nextId:0};connections.push(state);
    socket.on('message',(raw:Buffer)=>{const request=JSON.parse(raw.toString());
      if(request.method.endsWith('Unsubscribe')){socket.send(JSON.stringify({jsonrpc:'2.0',id:request.id,result:true}));return;}
      if(!request.method.endsWith('Subscribe'))return;
      state.inFlight++;state.peak=Math.max(state.peak,state.inFlight);state.subscribeMethods.push(request.method);const subscription=++state.nextId;
      setTimeout(()=>{state.inFlight--;if(socket.readyState!==1)return;
        socket.send(JSON.stringify({jsonrpc:'2.0',id:request.id,result:subscription}));
        if(request.method==='slotSubscribe')for(const delay of [30,150])setTimeout(()=>{if(socket.readyState===1)
          socket.send(JSON.stringify({jsonrpc:'2.0',method:'slotNotification',params:{subscription,result:{slot:123,parent:122,root:120}}}));},delay);
      },25);
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port,coverage:string[][]=[];
  const runner=new WalletFastRunner({endpoints:{solana:{http:`http://127.0.0.1:${port}`,ws:`ws://127.0.0.1:${port}`}},maxWallets:30,
    snapshot:()=>{const now=Date.now();return {at:new Date(now).toISOString(),validUntil:new Date(now+120000).toISOString(),
      targets:wallets.map(wallet=>({chain:'solana' as const,wallet,groups:['launcher_candidate']})),tokens:[]};},
    onEvent:()=>{},onCoverage:(_chain,active)=>coverage.push(active)});
  t.after(async()=>{await runner.stop();for(const client of sockets.clients)client.terminate();await new Promise<void>(resolve=>sockets.close(()=>resolve()));
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  runner.start();await until(()=>coverage.some(active=>active.length===30),10000);
  let chain=runner.status().chains[0];assert.equal(connections[0].peak,4);assert.equal(connections[0].subscribeMethods.length,31);
  assert.equal(chain.maxConcurrentSubscriptions,4);assert.equal(chain.peakConcurrentSubscriptions,4);
  assert.equal(chain.subscribingSubscriptions,0);assert.equal(chain.queuedSubscriptions,0);assert.equal(chain.activeSubscriptions,31);
  const firstFull=coverage.findIndex(active=>active.length===30);connections[0].socket.close();
  await until(()=>coverage.slice(firstFull+1).some(active=>active.length===0));
  await until(()=>connections.length>=2&&coverage.slice(firstFull+1).some(active=>active.length===30),12000);
  chain=runner.status().chains[0];assert.equal(connections[1].peak,4);assert.equal(connections[1].subscribeMethods.length,31);
  assert.equal(chain.state,'open');assert.equal(chain.activeSubscriptions,31);assert.notEqual(chain.error,'RPC_SUBSCRIBE_FAILED');
});
