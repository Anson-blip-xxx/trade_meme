import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {LauncherRevalidator,type LauncherRevalidationCandidate,type LauncherRevalidationResult} from '../src/launcher-revalidator.js';
import {activityResult,type ActivityRpc,type WalletActivity} from '../src/wallet-activity.js';
import type {FastWalletEvent} from '../src/wallet-fast.js';

const wallet=(n:number)=>bs58.encode(new Uint8Array(32).fill(n));
const signature=(n:number)=>bs58.encode(new Uint8Array(64).fill(n));
const until=async(check:()=>boolean,timeout=1000)=>{const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error('TEST_WAIT_TIMEOUT');await new Promise(r=>setTimeout(r,2));}};
const verified=(event:FastWalletEvent):WalletActivity=>activityResult(event,Date.parse('2026-11-18T12:00:01.000Z'),'buy',['SUPPORTED_SWAP_AND_WALLET_FLOW_CONFIRMED'],{
  confirmation:'confirmed',eventAt:'2026-11-18T12:00:00.000Z',slot:event.slot,trades:[{tokenAddress:wallet(30),side:'buy',amountAtomic:'1',protocol:'pump'}]});

test('launcher revalidator baselines once, then verifies and reports a new finalized signature',async()=>{
  const address=wallet(1),first=signature(1),second=signature(2),requests:{method:string;params:unknown[]}[]=[];
  let latest:string|undefined,index=0;const saved:LauncherRevalidationResult[]=[],activities:WalletActivity[]=[],events:FastWalletEvent[]=[];
  const rows=[[{signature:first,slot:10,blockTime:1_795_000_000}],[{signature:second,slot:11,blockTime:1_795_000_001}]];
  const runner=new LauncherRevalidator({endpoint:'https://private-rpc.invalid/secret',requestIntervalMs:1,now:()=>Date.parse('2026-11-18T12:00:02.000Z'),
    source:{listCandidates:()=>[{wallet:address,...(latest?{latestSignature:latest}:{})}],recordResult:result=>{saved.push(result);latest=result.latestSignature;},onActivity:a=>{activities.push(a);}},
    rpcFactory:()=>({request:async(method,params)=>{requests.push({method,params});return rows[index++];}}),
    verifier:{verify:async event=>{events.push(event);return verified(event);}}});
  try {
    assert.deepEqual(await runner.runOnce(),{accepted:1,checked:1,changed:0,classified:1,errors:0});
    assert.equal(saved[0].state,'baseline');assert.equal(saved[0].latestSignature,first);assert.equal(saved[0].blockTime,1_795_000_000);assert.equal(events.length,1);
    assert.deepEqual(saved[0].observations,[{signature:first,slot:10,blockTime:1_795_000_000,classification:'buy',eventAt:'2026-11-18T12:00:00.000Z'}]);
    assert.deepEqual(await runner.runOnce(),{accepted:1,checked:1,changed:1,classified:1,errors:0});
    assert.equal(saved[1].state,'changed');assert.equal(saved[1].newSignature,true);assert.equal(saved[1].classification,'buy');
    assert.equal(saved[1].latestSignature,second);assert.equal(saved[1].blockTime,1_795_000_001);assert.equal(saved[1].slot,11);
    assert.equal(events[1].wallet,address);assert.equal(events[1].txHash,second);assert.equal(events[1].slot,11);assert.equal(events[1].commitment,'included');
    assert.equal(events[1].tradingEnabled,false);assert.equal(activities.length,2);
    assert.deepEqual(requests.map(r=>r.method),['getSignaturesForAddress','getSignaturesForAddress']);
    assert.deepEqual(requests[0].params,[address,{commitment:'finalized',limit:3}]);
  } finally {await runner.stop();}
});

test('a changed cursor classifies every new page row before the prior signature',async()=>{
  const address=wallet(11),old=signature(11),buy=signature(12),transfer=signature(13),saved:LauncherRevalidationResult[]=[],seen:string[]=[];
  const runner=new LauncherRevalidator({endpoint:'http://rpc.invalid',requestIntervalMs:1,
    source:{listCandidates:()=>[{wallet:address,latestSignature:old}],recordResult:r=>{saved.push(r);},onActivity:a=>{seen.push(a.txHash);}},
    rpcFactory:()=>({request:async()=>[
      {signature:transfer,slot:103,blockTime:1_795_000_003},{signature:buy,slot:102,blockTime:1_795_000_002},{signature:old,slot:101,blockTime:1_795_000_001}
    ]}),verifier:{verify:async event=>activityResult(event,Date.parse('2026-11-18T12:00:04.000Z'),event.txHash===buy?'buy':'transfer',
      [event.txHash===buy?'SUPPORTED_SWAP_AND_WALLET_FLOW_CONFIRMED':'TOKEN_TRANSFER_ONLY'],{confirmation:'confirmed',eventAt:new Date(((event.slot!-100)+1_795_000_000)*1000).toISOString(),slot:event.slot})}});
  try {
    assert.deepEqual(await runner.runOnce(),{accepted:1,checked:1,changed:1,classified:2,errors:0});
    assert.deepEqual(seen,[buy,transfer]);assert.equal(saved[0].observations?.length,2);assert.equal(saved[0].observations?.[0].classification,'buy');
    assert.equal(saved[0].observations?.[1].classification,'transfer');assert.equal(saved[0].classification,'transfer');
  } finally {await runner.stop();}
});

test('launcher revalidator bounds concurrency and stop aborts the admitted batch promptly',async()=>{
  const candidates:LauncherRevalidationCandidate[]=Array.from({length:4},(_,i)=>({wallet:wallet(i+2)}));
  const pending:{resolve:(value:unknown)=>void}[]=[],saved:LauncherRevalidationResult[]=[];let active=0,maximum=0,stopped=false;
  const rpc:ActivityRpc={request:async()=>{active++;maximum=Math.max(maximum,active);return new Promise(resolve=>pending.push({resolve:value=>{active--;resolve(value);}}));},
    stop:()=>{stopped=true;for(const request of pending.splice(0))request.resolve([]);}};
  const runner=new LauncherRevalidator({endpoint:'http://rpc.invalid',concurrency:2,requestIntervalMs:1,source:{listCandidates:()=>candidates,recordResult:r=>{saved.push(r);}},
    rpcFactory:()=>rpc,verifier:{verify:async e=>verified(e)}});
  const run=runner.runOnce();await until(()=>pending.length===2);await runner.stop();
  assert.deepEqual(await run,{accepted:4,checked:0,changed:0,classified:0,errors:0});
  assert.equal(maximum,2);assert.equal(saved.length,0);assert.equal(stopped,true);
  await assert.rejects(runner.runOnce(),/LAUNCHER_REVALIDATOR_STOPPED/);
});

test('launcher revalidator exposes only fixed error codes when an RPC error contains its private URL',async()=>{
  const address=wallet(9),saved:LauncherRevalidationResult[]=[];
  const runner=new LauncherRevalidator({endpoint:'https://rpc.invalid/private-key',requestIntervalMs:1,
    source:{listCandidates:()=>[{wallet:address}],recordResult:r=>{saved.push(r);}},
    rpcFactory:()=>({request:async()=>{throw new Error('fetch https://rpc.invalid/private-key failed');}}),verifier:{verify:async e=>verified(e)}});
  try {
    const result=await runner.runOnce();assert.equal(result.errors,1);assert.equal(saved[0].error,'LAUNCHER_RPC_UNAVAILABLE');
    const encoded=JSON.stringify(runner.status());assert.equal(encoded.includes('rpc.invalid'),false);assert.equal(encoded.includes('private-key'),false);
  } finally {await runner.stop();}
});

test('malformed signature pages are persisted as a safe response error without invoking the verifier',async()=>{
  const saved:LauncherRevalidationResult[]=[];let verifiedCount=0;
  const runner=new LauncherRevalidator({endpoint:'http://rpc.invalid',requestIntervalMs:1,
    source:{listCandidates:()=>[{wallet:wallet(8)}],recordResult:r=>{saved.push(r);}},rpcFactory:()=>({request:async()=>[{signature:'bad',slot:1,blockTime:1}]}),
    verifier:{verify:async e=>{verifiedCount++;return verified(e);}}});
  try {assert.equal((await runner.runOnce()).errors,1);assert.equal(saved[0].error,'LAUNCHER_RPC_RESPONSE_INVALID');assert.equal(verifiedCount,0);}
  finally {await runner.stop();}
});

test('a candidate removed by a concurrent shortlist refresh is skipped without a false persistence error',async()=>{
  const address=wallet(19),runner=new LauncherRevalidator({endpoint:'http://rpc.invalid',requestIntervalMs:1,
    source:{listCandidates:()=>[{wallet:address}],recordResult:()=> 'stale'},rpcFactory:()=>({request:async()=>[]}),
    verifier:{verify:async event=>verified(event)}});
  try {
    assert.deepEqual(await runner.runOnce(),{accepted:1,checked:1,changed:0,classified:0,errors:0});
    const status=runner.status();assert.equal(status.error,undefined);assert.deepEqual(status.recent,[]);
  } finally {await runner.stop();}
});

test('retryable verification keeps the prior cursor and replays the same signature next run',async()=>{
  const address=wallet(20),next=signature(20),saved:LauncherRevalidationResult[]=[];let latest:string|undefined,attempts=0;
  const runner=new LauncherRevalidator({endpoint:'http://rpc.invalid',requestIntervalMs:1,
    source:{listCandidates:()=>[{wallet:address,...(latest?{latestSignature:latest}:{})}],recordResult:result=>{
      saved.push(result);if(result.latestSignature)latest=result.latestSignature;
    }},rpcFactory:()=>({request:async()=>[{signature:next,slot:20,blockTime:1_795_000_000}]}),verifier:{verify:async event=>{
      attempts++;return attempts===1?activityResult(event,Date.parse('2026-11-18T12:00:01.000Z'),'unknown',['TRANSACTION_RPC_UNAVAILABLE'],{retryable:true}):verified(event);
    }}});
  try {
    assert.deepEqual(await runner.runOnce(),{accepted:1,checked:1,changed:0,classified:1,errors:1});
    assert.equal(saved[0].state,'error');assert.equal(saved[0].error,'LAUNCHER_ACTIVITY_VERIFY_FAILED');
    assert.equal(saved[0].latestSignature,undefined);assert.equal(latest,undefined);
    assert.deepEqual(await runner.runOnce(),{accepted:1,checked:1,changed:0,classified:1,errors:0});
    assert.equal(saved[1].latestSignature,next);assert.equal(attempts,2);
  } finally {await runner.stop();}
});

test('activity callback failure does not advance the cursor and is retried durably',async()=>{
  const address=wallet(21),next=signature(21),saved:LauncherRevalidationResult[]=[];let latest:string|undefined,calls=0;
  const runner=new LauncherRevalidator({endpoint:'http://rpc.invalid',requestIntervalMs:1,
    source:{listCandidates:()=>[{wallet:address,...(latest?{latestSignature:latest}:{})}],recordResult:result=>{
      saved.push(result);if(result.latestSignature)latest=result.latestSignature;
    },onActivity:()=>{if(++calls===1)throw new Error('private storage detail');}},
    rpcFactory:()=>({request:async()=>[{signature:next,slot:21,blockTime:1_795_000_000}]}),verifier:{verify:async event=>verified(event)}});
  try {
    assert.equal((await runner.runOnce()).errors,1);assert.equal(saved[0].error,'LAUNCHER_ACTIVITY_CALLBACK_FAILED');
    assert.equal(saved[0].latestSignature,undefined);assert.equal(latest,undefined);
    assert.equal((await runner.runOnce()).errors,0);assert.equal(saved[1].latestSignature,next);assert.equal(calls,2);
    assert.doesNotMatch(JSON.stringify(runner.status()),/private storage detail/);
  } finally {await runner.stop();}
});
