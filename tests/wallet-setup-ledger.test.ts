import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import bs58 from 'bs58';
import {WalletSetupLedger} from '../src/wallet-setup-ledger.js';
import type {WalletScreeningReport,WalletSetup} from '../src/wallet-screening.js';
import type {WalletTradeObservation} from '../src/wallet-history.js';

const epoch=Date.parse('2026-10-13T00:00:00Z'),iso=(n:number)=>new Date(epoch+n*1000).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const wallet=address(1),leader=address(2),token={chain:'bsc' as const,address:address(100)};
const event=(n=105,patch:Partial<WalletTradeObservation>={}):WalletTradeObservation=>({chain:'bsc',wallet:leader,tokenAddress:token.address,
  txHash:hash(n),side:'buy',eventAt:iso(n),observedAt:iso(n+1),source:'gmgn_wallet_activity',...patch});
function report(setup:Partial<WalletSetup>={},patch:Partial<WalletScreeningReport>={}):WalletScreeningReport {
  return {version:1,token,checkedAt:iso(100),validUntil:iso(200),status:'supported',priorityScore:80,scope:'research_priority',ownership:'unknown',sampleOnly:true,
    reasons:[],setups:[{id:'provider-identifier',route:'precursor',wallet,leader,trigger:event(90,{wallet}),status:'supported',stage:'awaiting_public_entry',priorityScore:80,
      reasons:['registered evidence'],counterEvidence:['sampled only'],profileComputedAt:iso(80),relationKnownAt:iso(70),followers:2,ownership:'unknown',...setup}],...patch};
}
function fixture(options:{maxBytes?:number;windowSec?:number}={}){
  let now=100;const ledger=new WalletSetupLedger(':memory:',{now:()=>new Date(iso(now)),...options});
  return {ledger,advance:(n:number)=>{now=n;},one:()=>ledger.list().items[0]};
}

test('wallet opportunity pages use filtered totals and retain all records across offsets',()=>{
  const f=fixture();try {
    for(let n=1;n<=5;n++){
      f.advance(100+n);f.ledger.record(report({trigger:event(90,{wallet,txHash:hash(n)})},{checkedAt:iso(100+n)}));
    }
    const first=f.ledger.list({chain:'bsc',address:token.address.toUpperCase().replace('0X','0x'),limit:2});
    assert.equal(first.total,5);assert.equal(first.limit,2);assert.equal(first.offset,0);assert.equal(first.hasMore,true);
    assert.deepEqual(first.items.map(r=>r.registeredAt),[iso(105),iso(104)]);
    const second=f.ledger.list({limit:2,offset:2});assert.equal(second.total,5);
    assert.deepEqual(second.items.map(r=>r.registeredAt),[iso(103),iso(102)]);
    assert.equal(f.ledger.list({limit:2,offset:4}).hasMore,false);
    const end=f.ledger.list({offset:10});assert.deepEqual(end.items,[]);assert.equal(end.total,5);assert.equal(end.hasMore,false);
    assert.equal(f.ledger.list({chain:'robinhood'}).total,0);assert.equal(f.ledger.list({chain:'bsc',address:address(999)}).total,0);
    assert.equal(f.ledger.status().records,5);
  }finally{f.ledger.close();}
});

test('registration freezes the initial proof and real registration time across refreshes and renamed setup IDs',()=>{
  const f=fixture();try{
    f.ledger.record(report());const first=f.one();assert.equal(first.registeredAt,iso(100));assert.equal(first.state,'awaiting_leader');assert.equal(first.proof.trigger.eventAt,iso(90));
    f.advance(110);f.ledger.record(report({id:'changed',priorityScore:99,reasons:['changed proof']},{checkedAt:iso(110)}));
    assert.deepEqual(f.one(),first);assert.equal(f.ledger.status().records,1);
    assert.throws(()=>{(first.proof.reasons as string[]).push('mutated');},TypeError);assert.equal(f.one().proof.reasons.length,1);
  }finally{f.ledger.close();}
});

test('withdrawal updates a separate review without changing the registration or its evidence',()=>{
  const f=fixture();try{
    f.ledger.record(report());f.advance(110);f.ledger.record(report({status:'withdrawn',priorityScore:0,reasons:['later sell']},{checkedAt:iso(110)}));
    assert.equal(f.one().review.status,'withdrawn');assert.equal(f.one().review.checkedAt,iso(110));assert.equal(f.one().proof.status,'supported');assert.equal(f.one().proof.priorityScore,80);
    assert.equal(f.one().registeredAt,iso(100));assert.equal(f.ledger.status().withdrawn,1);
    f.ledger.record(report({status:'supported'},{checkedAt:iso(110)}));assert.equal(f.one().review.status,'withdrawn');
  }finally{f.ledger.close();}
});

test('future, stale, invalid, zero priority and withdrawn-only reports do not create opportunities',()=>{
  const f=fixture();try{
    f.ledger.record(report({}, {checkedAt:iso(101)}));f.ledger.record(report({}, {validUntil:iso(99)}));
    f.ledger.record(report({trigger:event(101,{wallet})}));f.ledger.record(report({profileComputedAt:iso(101)}));
    f.ledger.record(report({priorityScore:0}));f.ledger.record(report({status:'withdrawn'}));
    f.ledger.record(report({leader:wallet}));f.ledger.record(report({trigger:event(90,{wallet,txHash:'invalid'})}));
    f.ledger.record(report({trigger:event(90,{wallet,observedAt:iso(89)})}));
    assert.equal(f.ledger.status().records,0);
  }finally{f.ledger.close();}
});

test('only a later observed and later executed leader buy can confirm precursor entry',()=>{
  const f=fixture();try{
    f.ledger.record(report());f.advance(120);
    f.ledger.observe(token,[event(80,{observedAt:iso(119)}),event(100),event(105,{chain:'robinhood'}),event(105,{wallet:address(30)}),event(105,{tokenAddress:address(999)})]);
    assert.equal(f.one().state,'awaiting_leader');
    f.ledger.observe(token,[event(105)]);assert.equal(f.one().state,'leader_entered');assert.equal(f.one().leaderEntry?.txHash,hash(105));
    assert.equal(f.one().ownership,'unknown');assert.equal(f.one().sampleOnly,true);
    f.ledger.observe(token,[event(105),event(105,{source:'gmgn_token_trades',observedAt:iso(119)})]);
    assert.equal(f.one().conflicts,0);assert.equal(f.one().leaderEntry?.observedAt,iso(106));
  }finally{f.ledger.close();}
});

test('sell and transfer-out take priority over leader entry without asserting liquidation',()=>{
  for(const side of ['sell','transferOut'] as const){const f=fixture();try{
    f.ledger.record(report());f.advance(120);f.ledger.observe(token,[event(105),event(110,{wallet,side})]);
    assert.equal(f.one().state,'reduced');assert.equal(f.one().leaderEntry?.eventAt,iso(105));assert.equal(f.one().reduction?.side,side);
    assert.equal('fullyExited' in f.one(),false);
  }finally{f.ledger.close();}}
});

test('same-transaction conflicts cannot produce success in either ordering and retract earlier confirmation',()=>{
  for(const reverse of [false,true]){const f=fixture();try{
    f.ledger.record(report());f.advance(120);
    const events=[event(105),event(95,{txHash:hash(105),observedAt:iso(110)})];
    f.ledger.observe(token,reverse?events.reverse():events);assert.equal(f.one().state,'awaiting_leader');
  }finally{f.ledger.close();}}
  const f=fixture();try{
    f.ledger.record(report());f.advance(120);f.ledger.observe(token,[event(105)]);assert.equal(f.one().state,'leader_entered');
    f.ledger.observe(token,[event(95,{txHash:hash(105),observedAt:iso(119)})]);assert.equal(f.one().state,'awaiting_leader');assert.equal(f.one().conflicts,1);
    f.ledger.observe(token,[event(105)]);assert.equal(f.one().state,'awaiting_leader');
  }finally{f.ledger.close();}
});

test('a side or indexed-event disagreement remains conflicted rather than choosing a convenient copy',()=>{
  const f=fixture();try{
    f.ledger.record(report());f.advance(120);
    f.ledger.observe(token,[event(105,{eventIndex:1}),event(105,{eventIndex:2}),event(110),event(110,{side:'sell'})]);
    assert.equal(f.one().state,'awaiting_leader');assert.equal(f.one().conflicts,2);
  }finally{f.ledger.close();}
});

test('missing optional fields cannot hide conflicting quantities supplied by later feeds',()=>{
  const f=fixture();try{
    f.ledger.record(report());f.advance(120);
    f.ledger.observe(token,[event(105),event(105,{amount:'1'}),event(105,{amount:'2'})]);
    assert.equal(f.one().state,'awaiting_leader');assert.equal(f.one().conflicts,1);
    f.ledger.observe(token,[event(110),event(110,{amount:'3'})]);assert.equal(f.one().state,'leader_entered');
    f.ledger.observe(token,[event(110,{amount:'4'})]);assert.equal(f.one().state,'awaiting_leader');assert.equal(f.one().conflicts,2);
  }finally{f.ledger.close();}
});

test('future caller times and future source observations cannot pull confirmations forward',()=>{
  const f=fixture();try{
    f.ledger.record(report());f.ledger.observe(token,[event(105)],new Date(iso(120)));assert.equal(f.one().state,'awaiting_leader');
    f.advance(120);f.ledger.observe(token,[event(105,{observedAt:iso(121)}),event(121)]);assert.equal(f.one().state,'awaiting_leader');
    f.ledger.observe(token,[event(105)],new Date(iso(99)));assert.equal(f.one().state,'awaiting_leader');
  }finally{f.ledger.close();}
});

test('a contradictory historical trigger copy withdraws the opportunity without a new screening assessment',()=>{
  const f=fixture();try{
    f.ledger.record(report());const proof=f.one().proof;f.advance(120);f.ledger.observe(token,[event(105)]);assert.equal(f.one().state,'leader_entered');
    f.ledger.observe(token,[event(91,{wallet,txHash:proof.trigger.txHash,observedAt:iso(119)})]);
    assert.equal(f.one().review.status,'withdrawn');assert.ok(f.one().review.reasons.includes('WALLET_TRIGGER_BUY_CONFLICT'));
    assert.equal(f.one().triggerConflicted,true);assert.ok(f.one().conflicts>=1);assert.equal(f.one().state,'awaiting_leader');assert.equal(f.one().leaderEntry,undefined);
    assert.deepEqual(f.one().proof,proof);assert.equal(f.ledger.status().withdrawn,1);
    f.ledger.observe(token,[event(110),proof.trigger]);assert.equal(f.one().leaderEntry,undefined);assert.equal(f.one().review.status,'withdrawn');
  }finally{f.ledger.close();}
});

test('more than 100 opportunities on one CA are processed in bounded fair batches',()=>{
  const f=fixture();try{
    for(let i=0;i<125;i++)f.ledger.record(report({trigger:event(90,{wallet,txHash:hash(9000+i)})}));
    assert.equal(f.ledger.status().records,125);f.advance(120);f.ledger.observe(token,[event(105)]);
    assert.equal(f.ledger.status().stateCounts.leader_entered,100);assert.equal(f.ledger.status().stateCounts.awaiting_leader,25);
    f.ledger.observe(token,[event(105)]);assert.equal(f.ledger.status().stateCounts.leader_entered,125);
    assert.equal(f.ledger.status().stateCounts.awaiting_leader,undefined);
  }finally{f.ledger.close();}
});

test('elapsed and unsampled windows close as unconfirmed, not failed predictions',()=>{
  const f=fixture({windowSec:30});try{
    f.ledger.record(report());f.advance(131);assert.equal(f.ledger.pending().length,1);
    f.ledger.observe(token,[],new Date(iso(131)),{truncated:true});assert.equal(f.one().state,'expired_unconfirmed');assert.equal(f.one().closedAt,iso(131));
    assert.equal(f.one().observationsTruncated,true);assert.equal(f.ledger.pending().length,0);assert.equal(f.ledger.status().pending,0);
    assert.equal('failed' in f.ledger.status(),false);assert.equal('hitRate' in f.ledger.status(),false);
    f.advance(140);f.ledger.observe(token,[event(105,{observedAt:iso(140)})]);assert.equal(f.one().state,'expired_unconfirmed');assert.equal(f.one().closedAt,iso(131));
  }finally{f.ledger.close();}
});

test('observed outcomes survive expiry but contradictory evidence can retract them afterward',()=>{
  const f=fixture({windowSec:30});try{
    f.ledger.record(report());f.advance(120);f.ledger.observe(token,[event(105)]);f.advance(131);f.ledger.observe(token,[]);
    assert.equal(f.one().state,'leader_entered');assert.equal(f.one().closedAt,iso(131));
    f.advance(140);f.ledger.observe(token,[event(95,{txHash:hash(105),observedAt:iso(139)})]);
    assert.equal(f.one().state,'expired_unconfirmed');assert.equal(f.one().conflicts,1);assert.equal(f.one().closedAt,iso(131));
  }finally{f.ledger.close();}
});

test('direct public entry has its own route and never invents follower success',()=>{
  const f=fixture({windowSec:30});try{
    f.ledger.record(report({route:'public_entry',wallet:leader,trigger:event(90),stage:'direct_entry'}));assert.equal(f.one().state,'direct_entry');
    f.advance(120);f.ledger.observe(token,[event(105)]);assert.equal(f.one().state,'direct_entry');assert.equal(f.one().leaderEntry,undefined);
    f.ledger.observe(token,[event(110,{side:'sell'})]);assert.equal(f.one().state,'reduced');
    f.advance(131);f.ledger.observe(token,[]);assert.equal(f.one().state,'reduced');assert.equal(f.one().closedAt,iso(131));
  }finally{f.ledger.close();}
});

test('direct public entry remains an entry fact after its observation window closes',()=>{
  const f=fixture({windowSec:30});try{
    f.ledger.record(report({route:'public_entry',wallet:leader,trigger:event(90),stage:'direct_entry'}));
    f.advance(131);f.ledger.observe(token,[]);assert.equal(f.one().state,'direct_entry');assert.equal(f.one().closedAt,iso(131));
    assert.equal(f.one().leaderEntry,undefined);assert.equal(f.ledger.status().pending,0);
  }finally{f.ledger.close();}
});

test('pending rotates fairly even at an unchanged clock and groups several routes for one token',()=>{
  const f=fixture();try{
    for(let i=100;i<104;i++)f.ledger.record(report({trigger:event(90,{wallet,tokenAddress:address(i)})},{token:{...token,address:address(i)}}));
    f.ledger.record(report({route:'public_entry',wallet:leader,trigger:event(90),stage:'direct_entry'}));
    const seen=new Set<string>();for(let i=0;i<4;i++){const next=f.ledger.pending(1)[0];seen.add(next.address);f.ledger.observe(next,[]);}
    assert.equal(seen.size,4);assert.equal(f.ledger.status().records,5);
  }finally{f.ledger.close();}
});

test('chain and CA identity are isolated while EVM casing is normalized',()=>{
  const f=fixture();try{
    f.ledger.record(report());f.ledger.record(report({trigger:event(90,{chain:'robinhood',wallet})},{token:{chain:'robinhood',address:token.address}}));
    f.ledger.record(report({wallet:wallet.toUpperCase().replace('0X','0x'),trigger:event(90,{wallet:wallet.toUpperCase().replace('0X','0x')})}));
    assert.equal(f.ledger.status().records,2);f.advance(120);f.ledger.observe(token,[event(105)]);
    assert.equal(f.ledger.list({chain:'bsc'}).items[0].state,'leader_entered');assert.equal(f.ledger.list({chain:'robinhood'}).items[0].state,'awaiting_leader');
  }finally{f.ledger.close();}
});

test('Solana addresses and signatures preserve their canonical case',()=>{
  const f=fixture();try{
    const wa=bs58.encode(new Uint8Array(32).fill(2)),le=bs58.encode(new Uint8Array(32).fill(3)),ca=bs58.encode(new Uint8Array(32).fill(4));
    const signature=(n:number)=>bs58.encode(new Uint8Array(64).fill(n));
    f.ledger.record(report({wallet:wa,leader:le,trigger:event(90,{chain:'solana',wallet:wa,tokenAddress:ca,txHash:signature(5)})},{token:{chain:'solana',address:ca}}));
    f.advance(120);f.ledger.observe({chain:'solana',address:ca},[event(105,{chain:'solana',wallet:le,tokenAddress:ca,txHash:signature(6)})]);
    assert.equal(f.one().state,'leader_entered');assert.equal(f.one().wallet,wa);assert.equal(f.one().leaderEntry?.txHash,signature(6));
  }finally{f.ledger.close();}
});

test('capacity stops new records while preserving room for existing opportunity observations',()=>{
  const f=fixture({maxBytes:262144});try{
    for(let i=0;i<20;i++)f.ledger.record(report({trigger:event(90,{wallet,txHash:hash(900+i)})}));
    const count=f.ledger.status().records;assert.ok(count>0&&count<20);assert.equal(f.ledger.status().capacityReached,true);
    f.advance(120);f.ledger.observe(token,[event(105),event(110,{wallet,side:'sell'})]);
    assert.equal(f.ledger.status().records,count);assert.equal(f.ledger.status().stateCounts.reduced,count);assert.ok(f.ledger.status().bytes<=262144);
  }finally{f.ledger.close();}
});

test('bounded evidence retains a later reduction when repeated leader buys fill the sample',()=>{
  const f=fixture();try{
    f.ledger.record(report());f.advance(200);f.ledger.observe(token,Array.from({length:30},(_,i)=>event(105+i)));
    assert.equal(f.one().state,'leader_entered');assert.equal(f.one().observationsTruncated,true);
    f.ledger.observe(token,[event(150,{wallet,side:'sell'})]);assert.equal(f.one().state,'reduced');assert.equal(f.one().reduction?.eventAt,iso(150));
  }finally{f.ledger.close();}
});

test('frozen proof, review, outcomes and conflict tombstones survive restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wallet-setups-')),database=join(dir,'ledger.sqlite');let now=100;
  const options={now:()=>new Date(iso(now))};let ledger=new WalletSetupLedger(database,options);
  try{
    ledger.record(report());now=120;ledger.observe(token,[event(105)]);ledger.record(report({status:'withdrawn'},{checkedAt:iso(120)}));
    const saved=ledger.list().items[0];ledger.close();ledger=new WalletSetupLedger(database,options);assert.deepEqual(ledger.list().items[0],saved);
    ledger.observe(token,[event(95,{txHash:hash(105),observedAt:iso(119)})]);ledger.close();ledger=new WalletSetupLedger(database,options);
    ledger.observe(token,[event(105)]);assert.equal(ledger.list().items[0].state,'awaiting_leader');assert.equal(ledger.list().items[0].review.status,'withdrawn');
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});
