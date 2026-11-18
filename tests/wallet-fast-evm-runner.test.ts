import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {WalletFastRunner} from '../src/wallet-fast-runner.js';

const {WebSocketServer}=createRequire(import.meta.url)('ws');
const until=async(check:()=>boolean,timeout=8000)=>{const end=Date.now()+timeout;while(!check()){
  if(Date.now()>end)throw new Error('TEST_WAIT_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,20));
}};
const evm=(value:number)=>'0x'+value.toString(16).padStart(40,'0');

test('EVM wallet subscriptions are chunked and coverage includes only fully acknowledged chunks',async t=>{
  const wallets=Array.from({length:135},(_,index)=>evm(index+1)),requests:any[]=[],coverage:string[][]=[];
  const server=createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
    const body=JSON.parse(raw);res.setHeader('content-type','application/json');
    res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:'0x38'}));
  });});
  const sockets=new WebSocketServer({server});let nextSubscription=1;
  sockets.on('connection',(socket:any)=>socket.on('message',(raw:Buffer)=>{
    const request=JSON.parse(raw.toString());requests.push(request);
    const result=request.method==='eth_chainId'?'0x38':request.method==='eth_unsubscribe'?true:'0x'+(nextSubscription++).toString(16);
    socket.send(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  }));
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
  const runner=new WalletFastRunner({endpoints:{bsc:{http:`http://127.0.0.1:${port}`,ws:`ws://127.0.0.1:${port}`}},
    maxWallets:29,maxWalletsByChain:{bsc:135},snapshot:()=>{const now=Date.now();return {at:new Date(now).toISOString(),
      validUntil:new Date(now+120000).toISOString(),targets:wallets.map(wallet=>({chain:'bsc' as const,wallet,groups:['launcher_candidate']})),tokens:[]};},
    onEvent:()=>{},onCoverage:(_chain,active)=>coverage.push(active)});
  t.after(async()=>{await runner.stop();for(const client of sockets.clients)client.terminate();await new Promise<void>(resolve=>sockets.close(()=>resolve()));
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  runner.start();await until(()=>coverage.some(row=>row.length===135));
  const status=runner.status(),chain=status.chains[0];assert.equal(chain.identityVerified,true);assert.equal(chain.activeWallets.length,135);
  assert.equal(chain.activeSubscriptions,7);assert.equal(chain.desiredSubscriptions,7);
  const logSubscriptions=requests.filter(request=>request.method==='eth_subscribe'&&request.params?.[0]==='logs');
  assert.equal(logSubscriptions.length,6);
  assert.deepEqual(logSubscriptions.map(request=>request.params[1].topics[1]?.length??request.params[1].topics[2]?.length),[50,50,50,50,35,35]);
});
