import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WalletHistory,type WalletTradeObservation} from '../src/wallet-history.js';
import {WalletExitPressureRunner} from '../src/wallet-exit-pressure-runner.js';

const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const waitFor=async(check:()=>boolean,timeoutMs=8_000)=>{const end=Date.now()+timeoutMs;
  while(!check()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(check(),true,'timed out waiting for wallet exit-pressure worker');};

test('exit-pressure worker keeps future evidence out of its bounded five-minute cache',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-exit-pressure-worker-')),database=join(directory,'history.sqlite');
  const history=new WalletHistory(database),runner=new WalletExitPressureRunner({database,capacity:2,refreshMs:1_000});
  const token={chain:'bsc' as const,address:address(100)},wallet=address(1),sampleMs=Date.now()-60_000;
  const trade=(patch:Partial<WalletTradeObservation>={}):WalletTradeObservation=>({chain:'bsc',tokenAddress:token.address,
    wallet,txHash:hash(1),side:'buy',eventAt:new Date(sampleMs-20_000).toISOString(),
    observedAt:new Date(sampleMs-10_000).toISOString(),source:'gmgn_kol_feed',usd:'100',...patch});
  try {
    history.recordTrades([trade(),trade({txHash:hash(2),side:'sell',usd:'900',eventAt:new Date(sampleMs+10_000).toISOString(),
      observedAt:new Date(sampleMs+20_000).toISOString()})]);
    const sampleAt=new Date(sampleMs).toISOString();runner.start();assert.equal(runner.request(token,sampleAt),true);
    await waitFor(()=>!!runner.read(token,sampleAt));
    const pressure=runner.read(token,sampleAt)!;
    assert.equal(pressure.observedAt,sampleAt);assert.equal(pressure.windowEndAt,sampleAt);
    assert.deepEqual(pressure.trades.map(value=>value.volumeUsd),[100]);
    assert.equal(runner.read(token,new Date(sampleMs-1).toISOString()),undefined);
    assert.ok(runner.read(token,new Date(sampleMs+300_000).toISOString()));
    assert.equal(runner.read(token,new Date(sampleMs+300_001).toISOString()),undefined);
    assert.equal(runner.status().pending,0);
  } finally {await runner.stop();history.close();rmSync(directory,{recursive:true,force:true});}
});

test('exit-pressure queue is bounded, coalesces a token and drains during shutdown',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wallet-exit-pressure-queue-')),database=join(directory,'history.sqlite');
  const history=new WalletHistory(database),runner=new WalletExitPressureRunner({database,capacity:1,refreshMs:1_000});
  const at=new Date(Date.now()-1_000).toISOString(),first={chain:'bsc' as const,address:address(1)},second={chain:'bsc' as const,address:address(2)};
  try {
    runner.start();assert.equal(runner.request(first,at),true);assert.equal(runner.request(first,at),true);
    assert.equal(runner.request(second,at),false);await runner.stop();
    assert.equal(runner.status().running,false);assert.equal(runner.status().pending,0);
  } finally {await runner.stop();history.close();rmSync(directory,{recursive:true,force:true});}
});
