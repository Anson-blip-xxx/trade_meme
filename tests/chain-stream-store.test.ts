import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bs58 from 'bs58';
import {ChainStreamStore,chainAddress,hexNumber,evmTransfers,solWalletEvent,TRANSFER_TOPIC,type ChainEvent} from '../src/chain-stream-store.js';
import type {Chain} from '../src/types.js';

const from='0x'+'a'.repeat(40),to='0x'+'b'.repeat(40),token='0x'+'c'.repeat(40);
const sol=bs58.encode(new Uint8Array(32).fill(1)),sig=bs58.encode(new Uint8Array(64).fill(2));
const at=new Date('2026-10-11T10:00:00.000Z');
function log(overrides:Record<string,unknown>={}) {return {address:token,topics:[TRANSFER_TOPIC,'0x'+'0'.repeat(24)+from.slice(2),'0x'+'0'.repeat(24)+to.slice(2)],
  data:'0x'+'f'.repeat(64),transactionHash:'0x'+'d'.repeat(64),blockHash:'0x'+'e'.repeat(64),blockNumber:'0x38',logIndex:'0x1',removed:false,...overrides};}
const transfer=()=>evmTransfers('bsc',log(),new Set([from]),'live',at)[0];
function memory(t:{after:(fn:()=>void)=>void},max?:number) {const store=new ChainStreamStore(':memory:',max);t.after(()=>store.close());return store;}

test('addresses and JSON-RPC quantities reject unsupported chains, coercions and unsafe values',()=>{
  assert.equal(chainAddress('bsc',from.toUpperCase()),from);assert.equal(chainAddress('solana',sol),sol);
  for(const [chain,value] of [['other',from],['solana','1'.repeat(100000)],['solana','0'.repeat(44)],['bsc',{toString:()=>from}],['bsc',' '+from]] as const)
    assert.equal(chainAddress(chain as Chain,value),undefined);
  assert.equal(hexNumber('0x0'),0);assert.equal(hexNumber('0x38'),56);assert.equal(hexNumber('0x1fffffffffffff'),Number.MAX_SAFE_INTEGER);
  for(const n of ['0x00','0x038','0x20000000000000','0x'+'f'.repeat(100000),56,null,'-1','0x'])assert.equal(hexNumber(n),undefined);
});

test('EVM transfer evidence is exact, targeted and distinct per watched participant and reorg block',t=>{
  const store=memory(t),events=evmTransfers('bsc',log(),new Set([from,to]),'live',at);
  assert.equal(events.length,2);assert.notEqual(events[0].id,events[1].id);
  assert.equal(events[0].amountAtomic,((1n<<256n)-1n).toString());assert.equal(events[0].verification,'rpc_observed');
  assert.equal(events[0].kind,'token_transfer');assert.equal(events[0].observedAt,at.toISOString());
  assert.equal(evmTransfers('bsc',log(),new Set([token]),'live',at).length,0);
  const replacement=evmTransfers('bsc',log({blockHash:'0x'+'1'.repeat(64)}),new Set([from]),'live',at)[0];
  assert.notEqual(events[0].id,replacement.id);assert.ok(store.record(events[0]));assert.ok(store.record(replacement));
  const self=evmTransfers('bsc',log({topics:[TRANSFER_TOPIC,'0x'+'0'.repeat(24)+from.slice(2),'0x'+'0'.repeat(24)+from.slice(2)]}),new Set([from]),'live',at);
  assert.equal(self.length,1);
});

test('malformed/pending/non-ERC20 logs never become zero-value transfer evidence',()=>{
  for(const patch of [{transactionHash:null},{transactionHash:'0x123'},{blockHash:undefined},{blockNumber:'0x038'},
    {logIndex:'0x00'},{data:'0x'},{removed:'false'},{address:'bad'},{topics:[TRANSFER_TOPIC,'0x1','0x2']},
    {topics:[TRANSFER_TOPIC,'0x'+'0'.repeat(24)+from.slice(2),'0x'+'0'.repeat(24)+to.slice(2),'0x1']}])
    assert.deepEqual(evmTransfers('bsc',log(patch),new Set([from]),'live',at),[]);
  assert.deepEqual(evmTransfers('bsc',log(),new Set([from]),'live',new Date(NaN)),[]);
});

test('both chain validation branches reject invalid signatures, slots, blocks and typed optional fields',t=>{
  const store=memory(t),evm=transfer(),solEvent=solWalletEvent(sol,sig,123,'live',at);
  assert.ok(store.record(evm));assert.ok(store.record(solEvent));
  const malformed:unknown[]=[null,[],{...evm,chain:'other'},{...evm,txHash:sig},{...evm,blockNumber:undefined},
    {...evm,blockNumber:-1},{...evm,blockNumber:Number.MAX_SAFE_INTEGER+1},{...evm,slot:1},
    {...evm,tokenAddress:'bad'},{...evm,from:'bad'},{...evm,to:undefined},{...evm,wallet:token},
    {...evm,amountAtomic:1},{...evm,amountAtomic:'-1'},{...evm,amountAtomic:'1e18'},
    {...evm,removed:'true'},{...evm,eventIndex:1.5},{...evm,observedAt:'2026-02-30T10:00:00.000Z'},
    {...evm,eventAt:42},{...evm,observedAt:0},{...evm,id:'x'.repeat(64)},{...evm,verification:'buy'},
    {...solEvent,txHash:evm.txHash},{...solEvent,txHash:'1'.repeat(100000)},{...solEvent,slot:-1},
    {...solEvent,slot:undefined},{...solEvent,blockNumber:1}];
  for(const item of malformed)assert.equal(store.record(item as ChainEvent),false);
  assert.equal(store.stats().events,2);
  for(const [signature,slot] of [['bad',1],[sig,-1],[sig,NaN]] as const)
    assert.throws(()=>solWalletEvent(sol,signature,slot,'live',at),/^Error: CHAIN_EVENT_INVALID$/);
});

test('duplicate backfill cannot resurrect tombstones and an ID collision cannot remove another observation',t=>{
  const store=memory(t),event=transfer();assert.ok(store.record(event));
  assert.equal(store.record({...event,removed:true,txHash:'0x'+'1'.repeat(64)}),false);
  assert.equal(store.recent()[0].removed,false);
  assert.equal(store.record({...event,removed:true}),false);assert.equal(store.recent()[0].removed,true);
  assert.equal(store.record({...event,source:'backfill',removed:false}),false);
  assert.equal(store.stats().events,1);assert.equal(store.recent()[0].removed,true);
});

test('durable store keeps only bounded typed evidence and independent validated cursors',t=>{
  const directory=mkdtempSync(join(tmpdir(),'meme-chain-store-')),path=join(directory,'events.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new ChainStreamStore(path),event={...transfer(),rawRpc:{url:'https://vendor.invalid/private-secret'},apiKey:'private-secret'};
  assert.ok(store.record(event));assert.equal(JSON.stringify(store.recent()).includes('private-secret'),false);
  store.checkpoint('bsc:'+from,'56');store.checkpoint('robinhood:'+from,'4663');store.checkpoint('solana:'+sol,sig);
  for(const [key,value] of [['unknown:'+from,'1'],['bsc:'+from,'01'],['bsc:'+from,sig],['solana:'+sol,'bad'],['bsc:'+from,'9007199254740992']])
    assert.throws(()=>store.checkpoint(key,value),/^Error: CHAIN_CURSOR_INVALID$/);
  assert.equal(statSync(path).mode&0o777,0o600);store.close();
  const reopened=new ChainStreamStore(path);t.after(()=>reopened.close());
  assert.equal(reopened.cursor('bsc:'+from),'56');assert.equal(reopened.cursor('robinhood:'+from),'4663');
  assert.equal(reopened.cursor('solana:'+sol),sig);assert.equal(reopened.stats().events,1);
  for(const key of ['bsc','unknown','bsc:',':'+from,'bsc:'+from+':extra'])assert.throws(()=>reopened.cursor(key),/^Error: CHAIN_CURSOR_INVALID$/);
  for(const limit of [-1,0,101,NaN,1.2])assert.throws(()=>reopened.recent(limit),/^Error: CHAIN_STORE_QUERY_INVALID$/);
});

test('capacity exhaustion is durable missing-history state and never deletes accepted observations',t=>{
  const store=memory(t,1);
  assert.throws(()=>store.record(transfer()),/^Error: CHAIN_STORE_CAPACITY$/);
  assert.throws(()=>store.checkpoint('bsc:'+from,'56'),/^Error: CHAIN_STORE_CAPACITY$/);
  assert.deepEqual(store.recent(),[]);assert.equal(store.stats().incomplete,true);
  assert.throws(()=>store.markIncomplete('https://private-secret.invalid'),/^Error: CHAIN_STORE_REASON_INVALID$/);
});

test('Solana replay pagination survives restart independently from the completed cursor',()=>{
  const dir=mkdtempSync(join(tmpdir(),'chain-replay-')),path=join(dir,'events.sqlite'),key='solana:'+sol;
  const latest=bs58.encode(Buffer.alloc(64,3)),before=bs58.encode(Buffer.alloc(64,4));
  let store=new ChainStreamStore(path);
  try {
    store.checkpoint(key,sig);store.saveReplayProgress(key,{until:sig,latest,before,lastSlot:123});
    store.close();store=new ChainStreamStore(path);
    assert.deepEqual(store.replayProgress(key),{until:sig,latest,before,lastSlot:123});assert.equal(store.cursor(key),sig);
    for(const patch of [{until:latest},{lastSlot:-1},{before:'fake'},{latest:'fake'}])
      assert.throws(()=>store.saveReplayProgress(key,{until:sig,latest,before,lastSlot:123,...patch}),/CHAIN_CURSOR_INVALID/);
    assert.throws(()=>store.replayProgress('bsc:'+from),/CHAIN_CURSOR_INVALID/);
    store.checkpoint(key,latest);store.clearReplayProgress(key);assert.equal(store.replayProgress(key),undefined);
    assert.equal(store.cursor(key),latest);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
