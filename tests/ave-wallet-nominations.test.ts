import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import bs58 from 'bs58';
import {WalletHistory,type WalletVendorNominationInput} from '../src/wallet-history.js';

const base=Date.parse('2026-10-16T01:40:00Z'),at=(seconds=0)=>new Date(base+seconds*1000).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),event=(n=1)=>'ave:signal:'+n.toString(16).padStart(64,'0');
const token={chain:'bsc' as const,address:address(900)};
const input=(patch:Partial<WalletVendorNominationInput>={}):WalletVendorNominationInput=>({source:'ave',eventId:event(),
  occurredAt:at(-5),observedAt:at(),wallets:[{address:address(1),alias:'unverified KOL',side:'buy',lastTradeAt:at(-6)}],...patch});

test('all vendor nominees persist before research without creating trades, token holdings, smart labels, profit or ownership',()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(at())});
  try{
    const result=history.captureVendorNominations(token,input({wallets:[1,2,3,4,5].map(n=>({address:address(n),alias:'KOL',side:'buy'}))}));
    assert.equal(result.accepted,5);assert.equal(result.rejected,0);
    const stats=history.stats();assert.equal(stats.wallets,5);assert.equal(stats.nominations,5);
    for(const key of ['events','tokens','prices','snapshots','fundingLinks'] as const)assert.equal(stats[key],0,key);
    for(let n=1;n<=5;n++){
      const detail=history.getWallet('bsc',address(n))!;assert.equal(detail.coverage.nominationCount,1);
      assert.equal(detail.wallet.observedEventCount,0);assert.equal(detail.wallet.buyEvents,0);assert.equal(detail.wallet.sellEvents,0);
      assert.equal(detail.wallet.tokenCount,0);assert.equal(detail.wallet.name,undefined);assert.equal(detail.wallet.profit,undefined);
      assert.equal(detail.wallet.gain,undefined);assert.deepEqual(detail.wallet.labels,[]);
      assert.deepEqual(detail.timeline,[]);assert.deepEqual(detail.holdings,[]);assert.deepEqual(detail.fundingEdges,[]);
      assert.deepEqual(detail.vendorStats,[]);assert.equal(detail.wallet.coordination.score,0);
      const nomination=detail.vendorNominations![0];assert.equal(nomination.tokenAddress,token.address);
      assert.equal(nomination.alias,'KOL');assert.equal(nomination.side,'buy');assert.equal(nomination.buyEvidence,false);
      assert.equal(nomination.qualifiesAsSmart,false);assert.equal(nomination.ownershipProven,false);
      assert.equal(nomination.scope,'research_nomination_only');assert.equal(nomination.verification,'vendor_report');
    }
    assert.equal(history.screeningWalletCandidates(new Date(at()),0).length,0);
  }finally{history.close();}
});

test('same source event and wallet freeze first receipt, alias and side, and replay never refreshes wallet recency',()=>{
  let clock=0;const history=new WalletHistory(':memory:',{now:()=>new Date(at(clock))});
  try{
    history.captureVendorNominations(token,input());clock=60;
    const replay=history.captureVendorNominations(token,input({observedAt:at(60),wallets:[{address:address(1),alias:'changed',side:'sell'}]}));
    assert.equal(replay.duplicates,1);assert.equal(replay.accepted,0);
    const detail=history.getWallet('bsc',address(1))!;assert.equal(detail.wallet.firstObservedAt,at());assert.equal(detail.wallet.lastObservedAt,at());
    assert.equal(detail.vendorNominations![0].observedAt,at());assert.equal(detail.vendorNominations![0].alias,'unverified KOL');
    assert.equal(detail.vendorNominations![0].side,'buy');assert.equal(history.stats().nominations,1);
    history.captureVendorNominations(token,input({eventId:event(2),occurredAt:at(55),observedAt:at(60)}));
    assert.equal(history.stats().nominations,2);assert.equal(history.getWallet('bsc',address(1))!.wallet.lastObservedAt,at(60));
  }finally{history.close();}
});

test('a bound event cannot be reused on another token, chain or original alarm time',()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(at())});
  try{
    history.captureVendorNominations(token,input());
    for(const target of [{...token,address:address(901)},{...token,chain:'robinhood' as const}])
      assert.equal(history.captureVendorNominations(target,input()).reason,'WALLET_NOMINATION_EVENT_SCOPE_CONFLICT');
    assert.equal(history.captureVendorNominations(token,input({occurredAt:at(-10)})).reason,'WALLET_NOMINATION_EVENT_SCOPE_CONFLICT');
    assert.equal(history.stats().nominations,1);
  }finally{history.close();}
});

test('wrong identity, future or impossible timestamps, aliases without addresses and contradictory wallet scope are rejected',()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(at())});
  try{
    for(const patch of [{source:'debot'},{eventId:'raw-id'},{observedAt:at(1)},{occurredAt:at(1)},
      {observedAt:'2026-02-30T00:00:00.000Z'},{occurredAt:'not-a-date'},{wallets:null}] as any[]){
      assert.equal(history.captureVendorNominations(token,input(patch)).accepted,0);
    }
    const bad=[{address:''},{address:'0x12...7777'},{address:address(0)},{address:token.address},{alias:'KOL'},
      {address:address(1),chain:'solana'},{address:address(1),tokenAddress:address(901)},
      {address:address(1),side:'transfer'},{address:address(1),lastTradeAt:at(1)},
      {address:address(1),lastTradeAt:'2026-02-30T00:00:00.000Z'}];
    const result=history.captureVendorNominations(token,input({wallets:bad as any}));assert.equal(result.accepted,0);assert.equal(result.rejected,bad.length);
    assert.equal(history.stats().wallets,0);assert.equal(history.stats().nominations,0);
    assert.equal(history.captureVendorNominations({...token,address:address(0)},input()).accepted,0);
  }finally{history.close();}
});

test('three chains retain correct address identity, deduplicate case-insensitive EVM and keep Solana case',()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(at())});
  try{
    for(const [i,chain] of (['bsc','robinhood','solana'] as const).entries()){
      const mint=chain==='solana'?bs58.encode(Buffer.alloc(32,3)):token.address;
      const who=chain==='solana'?bs58.encode(Buffer.alloc(32,4)):'0xaBcD'+('1'.repeat(36));
      const result=history.captureVendorNominations({chain,address:mint},input({eventId:event(i+1),wallets:[{address:who}]}));
      assert.equal(result.accepted,1);assert.equal(history.getWallet(chain,who)?.vendorNominations![0].wallet,chain==='solana'?who:who.toLowerCase());
    }
    assert.equal(history.stats().nominations,3);assert.equal(history.stats().events,0);
  }finally{history.close();}
});

test('bounded batches and detail output preserve counts without deleting old nominations',()=>{
  const history=new WalletHistory(':memory:',{now:()=>new Date(at())});
  try{
    const result=history.captureVendorNominations(token,input({wallets:Array.from({length:105},(_,i)=>({address:address(i+1)}))}));
    assert.equal(result.accepted,100);assert.equal(result.rejected,5);assert.equal(history.stats().nominations,100);
    for(let n=2;n<=105;n++)history.captureVendorNominations(token,input({eventId:event(n)}));
    const detail=history.getWallet('bsc',address(1))!;assert.equal(detail.vendorNominations!.length,100);
    assert.equal(detail.coverage.nominationCount,105);assert.equal(history.stats().nominations,204);assert.equal(history.stats().events,0);
  }finally{history.close();}
});

test('nomination evidence survives restart beyond thirty days; capacity never evicts old evidence',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ave-nominations-')),path=join(dir,'wallets.sqlite');let clock=0;
  let history=new WalletHistory(path,{now:()=>new Date(at(clock))});
  try{
    history.captureVendorNominations(token,input());history.close();clock=60*86400;
    history=new WalletHistory(path,{now:()=>new Date(at(clock))});assert.equal(history.stats().nominations,1);
    assert.equal(history.getWallet('bsc',address(1))!.vendorNominations![0].observedAt,at());
    history.close();history=new WalletHistory(path,{maxBytes:16384,now:()=>new Date(at(clock))});
    const denied=history.captureVendorNominations(token,input({eventId:event(2),occurredAt:at(clock-5),observedAt:at(clock),wallets:[{address:address(2)}]}));
    assert.equal(denied.accepted,0);assert.equal(denied.reason,'WALLET_HISTORY_CAPACITY_REACHED');assert.equal(history.stats().nominations,1);
    assert.equal(history.getWallet('bsc',address(2)),undefined);
  }finally{history.close();rmSync(dir,{recursive:true,force:true});}
});
