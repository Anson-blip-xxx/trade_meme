import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/config.js';
import {mergePinnedWallets,WalletFastTargets,WalletFastJudge} from '../src/wallet-fast.js';
import {WalletFastRunner,type WalletFastOptions} from '../src/wallet-fast-runner.js';
import {ChainMonitor,type ChainMonitorOptions} from '../src/chain-monitor.js';
import {PriceTracker} from '../src/price-tracker.js';
import {createRuntime} from '../src/runtime.js';

const pin='BNnN2MqfWLvgThYBsv6v8JQaYZXYKYahC5YCy27Ct1cX';
const pub=(n:number)=>bs58.encode(new Uint8Array(32).fill(n));

test('Solana watchlist is optional, trims and deduplicates full public keys without changing automatic capacity',()=>{
  assert.equal(readConfig({}).chainStream.pinnedWallets,undefined);
  assert.equal(readConfig({SOLANA_WALLET_WATCHLIST:'  '}).chainStream.pinnedWallets,undefined);
  const config=readConfig({SOLANA_WALLET_WATCHLIST:` ${pin}, ${pub(2)},${pin} `});
  assert.deepEqual(config.chainStream.pinnedWallets,{solana:[pin,pub(2)]});
  assert.equal(config.chainStream.maxWallets,10);assert.equal(config.entryMode,'off');
});

test('watchlist rejects invalid keys, empty members and excessive unique pins without echoing input',()=>{
  for(const value of ['private-marker',pin+',',','+pin,pin+',,'+pub(2),'0'.repeat(44),'1'.repeat(32),
    bs58.encode(new Uint8Array(31).fill(1)),bs58.encode(new Uint8Array(33).fill(1)),
    Array.from({length:6},(_,i)=>pub(i+1)).join(','),'x'.repeat(2049)]){
    assert.throws(()=>readConfig({SOLANA_WALLET_WATCHLIST:value}),{message:'SOLANA_WALLET_WATCHLIST_INVALID'});
  }
});

test('reserved pin capacity is bounded by thirty wallets, counting duplicate pins only once',()=>{
  const five=Array.from({length:5},(_,i)=>pub(i+1)).join(',');
  assert.equal(readConfig({CHAIN_STREAM_MAX_WALLETS:'25',SOLANA_WALLET_WATCHLIST:five}).chainStream.pinnedWallets?.solana?.length,5);
  assert.equal(readConfig({CHAIN_STREAM_MAX_WALLETS:'30'}).chainStream.maxWallets,30);
  assert.equal(readConfig({CHAIN_STREAM_MAX_WALLETS:'29',SOLANA_WALLET_WATCHLIST:`${pin},${pin}`}).chainStream.pinnedWallets?.solana?.length,1);
  assert.throws(()=>readConfig({CHAIN_STREAM_MAX_WALLETS:'30',SOLANA_WALLET_WATCHLIST:pin}),{message:'SOLANA_WALLET_WATCHLIST_CAPACITY'});
});

test('pin survives automatic refresh and rotation without displacing or qualifying any target',()=>{
  const picker=new WalletFastTargets(),at=Date.now(),automatic=[pub(1),pub(2)];
  const select=(candidates:string[],now:number)=>mergePinnedWallets('solana',picker.select('solana',candidates,2,now),[pin]);
  assert.deepEqual(select(automatic,at),[...automatic,pin]);
  assert.deepEqual(select([pub(3),pub(4)],at+30000),[...automatic,pin]);
  assert.deepEqual(select([pub(3),pub(4)],at+300000),[pub(3),pub(4),pin]);
  assert.deepEqual(mergePinnedWallets('solana',[pin,pub(3)],[pin]),[pin,pub(3)]);
  const judge=new WalletFastJudge(()=>at,()=>0);
  judge.update({at:new Date(at).toISOString(),validUntil:new Date(at+120000).toISOString(),targets:[{chain:'solana',wallet:pin,groups:[]}],tokens:[]});
  const event=judge.judge('solana','wallet:'+pin,{context:{slot:1},value:{signature:bs58.encode(new Uint8Array(64).fill(1)),err:null}},
    {receivedAt:at,receivedMonoAt:0,generation:1,subscriptionId:1})[0];
  assert.equal(event.verdict,'refresh_profile');assert.deepEqual(event.groups,[]);
  assert.equal(event.buyVerified,false);assert.equal(event.tradingEnabled,false);
});

test('runtime reserves the extra slot in both watchers while keeping automatic selection at its original cap',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-watchlist-'));
  const config=readConfig({CHAIN_STREAM_ENABLED:'true',WALLET_FAST_ENABLED:'true',SOLANA_WALLET_WATCHLIST:pin,
    SOLANA_STREAM_HTTP_URL:'https://rpc.invalid',SOLANA_STREAM_WS_URL:'wss://rpc.invalid',
    BSC_STREAM_HTTP_URL:'https://evm.invalid',BSC_STREAM_WS_URL:'wss://evm.invalid',
    WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'false',WALLET_SCREENING_ENABLED:'false',TOKEN_RANK_RESEARCH_ENABLED:'false',
    WALLET_HISTORY_DATABASE_PATH:join(dir,'wallets.sqlite'),WALLET_ACTIVITY_DATABASE_PATH:join(dir,'activity.sqlite'),
    CHAIN_STREAM_DATABASE_PATH:join(dir,'stream.sqlite'),SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),ORDERS_DATABASE_PATH:join(dir,'orders.sqlite')});
  let fast:WalletFastOptions|undefined,monitor:ChainMonitorOptions|undefined,requests=0,now=Date.now();
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('NETWORK_NOT_ALLOWED');});
  t.mock.method(WalletFastRunner.prototype,'start',function(this:WalletFastRunner){fast=(this as unknown as {options:WalletFastOptions}).options;});
  t.mock.method(ChainMonitor.prototype,'start',function(this:ChainMonitor){monitor=(this as unknown as {options:ChainMonitorOptions}).options;});
  t.mock.method(PriceTracker.prototype,'start',()=>{});
  const runtime=createRuntime(config);
  let automatic=Array.from({length:10},(_,i)=>pub(i+1));
  const evm=Array.from({length:10},(_,i)=>'0x'+(i+1).toString(16).padStart(40,'0'));
  const limits:number[]=[];
  runtime.walletHistory!.streamWalletTargets=(chain,limit=10)=>{limits.push(limit);return chain==='solana'?automatic:evm;};
  try {
    runtime.start();assert.ok(fast);assert.ok(monitor);
    assert.equal(fast.maxWallets,11);assert.equal(monitor.config.maxWallets,11);assert.equal(config.chainStream.maxWallets,10);
    assert.deepEqual(monitor.wallets('solana',11),[...automatic,pin]);
    assert.deepEqual(monitor.wallets('bsc',11),evm);
    const snapshot=fast.snapshot();
    assert.deepEqual(snapshot.targets.filter(t=>t.chain==='solana').map(t=>t.wallet),[...automatic,pin]);
    assert.equal(snapshot.targets.filter(t=>t.chain==='bsc').length,10);
    const pinned=snapshot.targets.find(t=>t.wallet===pin)!;
    assert.deepEqual(pinned.groups,[]);assert.equal(pinned.profileUntil,undefined);
    automatic=Array.from({length:10},(_,i)=>pub(i+20));now+=300000;
    assert.deepEqual(fast.snapshot().targets.filter(t=>t.chain==='solana').map(t=>t.wallet),[...automatic,pin]);
    assert.deepEqual(monitor.wallets('solana',11),[...automatic,pin]);
    assert.ok(limits.length>0&&limits.every(limit=>limit===10));
    assert.equal(runtime.dashboardOverview().entryMode,'off');assert.equal(runtime.dashboardOrders().items.length,0);
    assert.equal(requests,0);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
