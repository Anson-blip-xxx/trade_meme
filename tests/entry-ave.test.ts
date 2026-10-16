import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readConfig} from '../src/config.js';
import {EntryController} from '../src/entry.js';
import {OrderStore} from '../src/orders.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import type {Chain,Report} from '../src/types.js';
import {signal,pass,narrative,now} from './helpers.js';

test('Ave candidates remain research only in paper and live across all supported chains before any wallet or order IO',async()=>{
  for(const chain of ['bsc','solana','robinhood'] as Chain[])for(const mode of ['paper','live'] as const){
    const config=readConfig({ENTRY_MODE:mode,GMGN_API_KEY:'test-key-with-no-network'}),orders=new OrderStore(':memory:');
    let readCalls=0,signedCalls=0,protectionCalls=0,revalidationCalls=0;
    const client=new GmgnClient({apiKey:'test-key-with-no-network',fetcher:async()=>{readCalls++;throw Error('unexpected external read');}});
    const controller=new EntryController(config,orders,client,{now:()=>now,
      fetcher:async()=>{signedCalls++;throw Error('unexpected signed request');},
      walletEvidence:()=>{revalidationCalls++;return pass();},
      liveProtection:context=>{protectionCalls++;return {status:'verified',scope:'autonomous_exit_execution',
        chain:context.chain,wallet:context.wallet,checkedAt:now.toISOString(),validUntil:new Date(now.getTime()+30000).toISOString()};}});
    const report:Report={id:randomUUID(),mode:'live',policyVersion:'ave-research-test',
      signal:signal({source:'ave',sourceEventId:'ave:signal:'+('a'.repeat(64)),token:{chain,
        address:chain==='solana'?'DFMt2FyLpB6ekPNAzVErLXgpSnJ9CRf1VnxBAkTLpump':'0x'+'1'.repeat(40)}}),
      receivedAt:now.toISOString(),evaluatedAt:now.toISOString(),validUntil:new Date(now.getTime()+60000).toISOString(),
      decision:'BUY_CANDIDATE',buyEligible:true,executionEnabled:false,reasons:[],
      provenance:pass(),safety:pass(),marketRisk:pass(),flow:pass(),narrative:narrative()};
    try{
      assert.deepEqual(await controller.consider(report),{status:'skipped',reason:'ENTRY_SOURCE_RESEARCH_ONLY'});
      assert.equal(readCalls,0);assert.equal(signedCalls,0);assert.equal(protectionCalls,0);assert.equal(revalidationCalls,0);
      assert.equal(orders.list().length,0);
    }finally{orders.close();}
  }
});

test('entry mode off remains authoritative even when an Ave report claims every check passed',async()=>{
  const config=readConfig({ENTRY_MODE:'off'}),orders=new OrderStore(':memory:');
  const client=new GmgnClient({fetcher:async()=>{throw Error('unexpected external request');}});
  try{
    const controller=new EntryController(config,orders,client);
    const report={signal:signal({source:'ave'}),decision:'BUY_CANDIDATE',buyEligible:true} as Report;
    assert.deepEqual(await controller.consider(report),{status:'skipped',reason:'ENTRY_DISABLED'});
    assert.equal(orders.list().length,0);
  }finally{orders.close();}
});
