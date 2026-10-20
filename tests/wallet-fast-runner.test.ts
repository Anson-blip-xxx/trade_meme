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
test('independent worker subscribes processed, verifies the endpoint and judges while the HTTP thread is blocked',async t=>{
  const wallet=bs58.encode(new Uint8Array(32).fill(9)),signature=bs58.encode(new Uint8Array(64).fill(8));
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'}));});
  const sockets=new WebSocketServer({server}),requests:any[]=[];let socket:any,sub:number|undefined;
  sockets.on('connection',(s:any)=>{socket=s;s.on('message',(raw:Buffer)=>{const req=JSON.parse(raw.toString());requests.push(req);
    const id=requests.length;if(req.method==='logsSubscribe')sub=id;s.send(JSON.stringify({jsonrpc:'2.0',id:req.id,result:req.method.endsWith('Unsubscribe')?true:id}));});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port,events:FastWalletEvent[]=[];
  const runner=new WalletFastRunner({endpoints:{solana:{http:`http://127.0.0.1:${port}`,ws:`ws://127.0.0.1:${port}`}},maxWallets:10,
    snapshot:()=>{const now=Date.now();return {at:new Date(now).toISOString(),validUntil:new Date(now+120000).toISOString(),targets:[{chain:'solana',wallet,groups:['forward_validated'],profileUntil:new Date(now+120000).toISOString()}],tokens:[]};},
    onEvent:e=>events.push(e)});
  t.after(async()=>{await runner.stop();for(const client of sockets.clients)client.terminate();await new Promise<void>(r=>sockets.close(()=>r()));server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  runner.start();await until(()=>sub!==undefined&&runner.status().chains?.[0]?.identityVerified).catch(()=>{throw new Error(JSON.stringify({status:runner.status(),requests}));});
  assert.equal(requests.find(r=>r.method==='logsSubscribe').params[1].commitment,'processed');
  socket.send(JSON.stringify({jsonrpc:'2.0',method:'logsNotification',params:{subscription:sub,result:{context:{slot:123},value:{signature,err:null,logs:[]}}}}));
  const end=Date.now()+350;while(Date.now()<end){Math.sqrt(913);}
  await until(()=>events.length===1);
  assert.equal(events[0].verdict,'priority_review');assert.equal(events[0].buyVerified,false);
  assert.ok(Date.parse(events[0].judgedAt)<end,'worker produces the verdict without waiting for the main event loop');
  assert.ok(runner.status().mainThreadHandoff.maxMs>=0);
  const encoded=JSON.stringify(runner.status());assert.equal(encoded.includes('127.0.0.1'),false);
});
