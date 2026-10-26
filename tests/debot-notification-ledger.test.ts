import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DebotNotificationLedger} from '../src/debot-notification-ledger.js';
import type {DebotSignalObservation} from '../src/providers/debot-signals.js';

const epoch=Date.parse('2026-10-15T06:00:00Z');
const iso=(seconds=0)=>new Date(epoch+seconds*1000).toISOString();
const ca='0x'+'123456abcd'.repeat(4);
const wallet='0x'+'abcdef1234'.repeat(4);
const other='0x4444444444444444444444444444444444444444';
function observation(id=1,seconds=0):DebotSignalObservation {
  return {id:String(id),observedAt:iso(seconds),walletCount:1,addressCount:1,aliases:['known-wallet'],
    name:'Example',symbol:'EX',alertPriceUsd:0.001,averageWalletVolumeUsd:300,
    vendorWallets:[{alias:'known-wallet',address:wallet,lastTradeAt:iso(-10),amount:'100',volumeUsd:300,priceUsd:0.001}],
    signal:{source:'debot',sourceEventId:`debot:signal:${id}`,token:{chain:'bsc',address:ca},occurredAt:iso(seconds-5),
      text:'Provider claims only',claim:'unspecified',evidenceUrls:[]}};
}
function fixture() {
  const db=new DatabaseSync(':memory:');let seconds=0;
  const now=()=>new Date(iso(seconds));const ledger=new DebotNotificationLedger(db,now);
  return {db,ledger,now,advance:(value:number)=>{seconds=value;}};
}

test('notification ledger merges tokens, distinguishes vendor events from versions and retains original timestamps',()=>{
  const f=fixture();try {
    const first=observation(),a=f.ledger.record(first);
    assert.equal(a.kind,'first');assert.equal(a.notificationCount,1);assert.equal(a.deliveryCount,1);assert.equal(a.newEvent,true);
    f.advance(20);const repeat=f.ledger.record({...first,observedAt:iso(20)});
    assert.equal(repeat.key,a.key);assert.equal(repeat.kind,'replay');assert.equal(repeat.notificationCount,1);assert.equal(repeat.deliveryCount,2);assert.equal(repeat.newEvent,false);
    assert.equal(repeat.firstSeenAt,iso());assert.equal(repeat.lastSeenAt,iso(20));
    const changed={...first,observedAt:iso(20),vendorWallets:[...first.vendorWallets!,{address:other,amount:'30'}],walletCount:2,addressCount:2};
    const version=f.ledger.record(changed);assert.equal(version.kind,'wallet_hint');assert.equal(version.notificationCount,1);assert.equal(version.newEvent,false);
    const distinct=f.ledger.record({...changed,id:'2',signal:{...changed.signal,sourceEventId:'debot:signal:2',occurredAt:iso(19)}});
    assert.equal(distinct.kind,'display');assert.equal(distinct.notificationCount,2);assert.equal(distinct.deliveryCount,4);assert.equal(distinct.newEvent,true);
    const current=f.ledger.current('bsc',ca)!;assert.equal(current.retainedHistory,3);assert.equal(current.firstSeenAt,iso());
    assert.equal(current.deliveryCount,4);assert.equal(current.notificationCount,2);assert.equal(current.truncatedHistory,0);
    const history=f.ledger.history('bsc',ca);assert.equal(history.total,3);
    const original=history.items.find(item=>item.key===a.key)!;
    assert.equal(original.observedAt,iso());assert.equal(original.lastObservedAt,iso(20));assert.equal(original.occurredAt,iso(-5));
    assert.equal(original.deliveryCount,2);
    assert.deepEqual(history.items.find(item=>item.key===version.key)!.delta.addedAddresses,[other]);
  }finally{f.db.close();}
});

test('canonical ordering, EVM casing, alias order and observation delivery time never produce a new version',()=>{
  const f=fixture();try {
    const source=observation();source.aliases=['unknown-b','unknown-a','known-wallet'];
    source.vendorWallets!.push({alias:'unknown-a',amount:'5'},{alias:'unknown-b',amount:'6'});
    const first=f.ledger.record(source);f.advance(3);
    const shuffled=structuredClone(source);shuffled.observedAt=iso(3);shuffled.aliases.reverse();shuffled.vendorWallets!.reverse();
    shuffled.signal.token.address='0x'+ca.slice(2).toUpperCase();shuffled.vendorWallets!.find(item=>item.address)!.address='0x'+wallet.slice(2).toUpperCase();
    shuffled.vendorWallets!.find(item=>item.address)!.amount='000100.0000';
    const result=f.ledger.record(shuffled);assert.equal(result.kind,'replay');assert.equal(result.key,first.key);
    assert.equal(f.ledger.current('bsc',shuffled.signal.token.address)?.notificationCount,1);
    assert.equal(f.ledger.history('bsc',ca).total,1);
  }finally{f.db.close();}
});

test('prices, metadata and renaming a known address are display changes while alias-only and trade changes remain unverified hints',()=>{
  const f=fixture();try {
    const source=observation();f.ledger.record(source);f.advance(5);
    const display=structuredClone(source);display.observedAt=iso(5);display.alertPriceUsd=2;display.name='Renamed';
    display.vendorWallets![0].priceUsd=2;display.vendorWallets![0].alias='renamed-wallet';display.aliases=['renamed-wallet'];
    assert.equal(f.ledger.record(display).kind,'display');
    const alias=structuredClone(display);alias.observedAt=iso(6);alias.aliases.push('anonymous-hint');
    alias.vendorWallets!.push({alias:'anonymous-hint',amount:'50'});f.advance(6);
    const hint=f.ledger.record(alias);assert.equal(hint.kind,'wallet_hint');
    const changed=structuredClone(alias);changed.observedAt=iso(7);changed.vendorWallets![0].amount='125';changed.vendorWallets![0].lastTradeAt=iso(6);f.advance(7);
    const trade=f.ledger.record(changed);assert.equal(trade.kind,'wallet_hint');
    const history=f.ledger.history('bsc',ca).items;
    assert.deepEqual(history.find(item=>item.key===hint.key)!.delta.addedAliases,['anonymous-hint']);
    assert.equal(history.find(item=>item.key===trade.key)!.delta.verification,'vendor_report');
    assert.deepEqual(history.find(item=>item.key===trade.key)!.delta.changedWallets,[{identity:wallet,fields:['lastTradeAt','amount']}]);
  }finally{f.db.close();}
});

test('an older payload replay cannot replace the latest wallet change or rewrite the original event time',()=>{
  const f=fixture();try {
    const source=observation();const first=f.ledger.record(source);
    const changed=structuredClone(source);changed.observedAt=iso(2);changed.vendorWallets![0].amount='999';changed.signal.occurredAt=iso(1);f.advance(2);
    const latest=f.ledger.record(changed);f.advance(5);f.ledger.record({...source,observedAt:iso(5)});
    const current=f.ledger.current('bsc',ca)!;assert.equal(current.key,latest.key);assert.equal(current.lastChangeAt,iso(2));assert.equal(current.lastSeenAt,iso(5));
    const history=f.ledger.history('bsc',ca);assert.equal(history.items.find(item=>item.key===latest.key)!.occurredAt,iso(-5));
    assert.equal(history.items.find(item=>item.key===latest.key)!.delta.eventTimeConflict,true);
    assert.equal(history.items.find(item=>item.key===first.key)!.occurredAt,iso(-5));
  }finally{f.db.close();}
});

test('chain identity is separate and Solana addresses retain their case',()=>{
  const f=fixture();try {
    const bsc=observation(),rh=structuredClone(bsc);rh.signal.token.chain='robinhood';
    assert.notEqual(f.ledger.record(bsc).key,f.ledger.record(rh).key);
    const sol=structuredClone(bsc);sol.signal.token={chain:'solana',address:'So11111111111111111111111111111111111111112'};
    sol.vendorWallets=[{address:'11111111111111111111111111111111'}];f.ledger.record(sol);
    assert.equal(f.ledger.current('solana',sol.signal.token.address)?.address,sol.signal.token.address);
    assert.equal(f.ledger.history('bsc',ca).total,1);assert.equal(f.ledger.history('robinhood',ca).total,1);
    assert.throws(()=>f.ledger.current('solana',ca),/IDENTITY_INVALID/);
  }finally{f.db.close();}
});

test('history is SQL-paginated with an as-of anchor and explicit omitted history counts',()=>{
  const f=fixture();try {
    for(let i=0;i<6;i++){f.advance(i);f.ledger.record(observation(i+1,i));}
    const first=f.ledger.history('bsc',ca,{limit:2});assert.equal(first.total,6);assert.equal(first.hasMore,true);
    assert.deepEqual(first.items.map(item=>item.vendorEventId),['6','5']);
    f.advance(6);f.ledger.record(observation(7,6));
    const second=f.ledger.history('bsc',ca,{limit:2,offset:2,asOf:first.asOf});
    assert.equal(second.total,6);assert.deepEqual(second.items.map(item=>item.vendorEventId),['4','3']);
    assert.equal(f.ledger.history('bsc',ca,{limit:2,offset:20}).hasMore,false);
    assert.deepEqual(f.ledger.history('bsc',ca,{limit:2,offset:20}).items,[]);
    for(const options of [{limit:0},{limit:101},{offset:-1},{offset:1_000_001},{asOf:'bad'}])assert.throws(()=>f.ledger.history('bsc',ca,options),/INVALID_FILTER/);
    // A token's recent notification keeps its aggregate; aged versions become explicit omissions.
    f.advance(30*86400+3);f.ledger.record(observation(8,30*86400+3));
    const retained=f.ledger.history('bsc',ca);assert.equal(retained.total,5);assert.equal(retained.retainedHistory,5);assert.equal(retained.truncatedHistory,3);
    assert.equal(f.ledger.current('bsc',ca)?.notificationCount,8);assert.equal(f.ledger.current('bsc',ca)?.firstSeenAt,iso());
  }finally{f.db.close();}
});

test('mark stores only the explicit evidence projection and never original envelopes or authentication fields',()=>{
  const f=fixture();try {
    const result=f.ledger.record(observation());
    f.ledger.mark(result.key,{classification:'verified_change',reasons:['NEW_WALLET_TRADE','invalid reason','NEW_WALLET_TRADE'],evidence:{
      chain:'bsc',address:ca,fromAt:iso(-20),untilAt:iso(),status:'changed',coverage:'sampled',Cookie:'secret-cookie',raw:{bearer:'secret-auth'},
      vendorChanges:[{address:wallet,kind:'new_address',source:'debot',verification:'vendor_changed',observedAt:iso(),Authorization:'secret-header'}],
      observedTrades:[{evidenceId:'tx-1',txHash:'0x'+'a'.repeat(64),wallet,side:'buy',volumeUsd:500,eventAt:iso(-1),observedAt:iso(),source:'gmgn',verification:'observed_trade',rawResponse:'secret-raw'}],
      researchTargets:[{address:wallet,triggerWallet:other,reason:'precursor_leader',txHash:'0x'+'a'.repeat(64),eventAt:iso(-1),observedAt:iso(),source:'local_observations',verification:'research_priority'}],
      limitations:['SAMPLED_TRADES','invalid limitation'],
    }});
    const item=f.ledger.history('bsc',ca).items[0];assert.equal(item.classification,'verified_change');assert.deepEqual(item.reasons,['NEW_WALLET_TRADE']);
    assert.equal(item.evidence.observedTrades[0].volumeUsd,500);assert.equal(item.evidence.vendorChanges[0].verification,'vendor_changed');
    const serialized=JSON.stringify(item);for(const value of ['secret','Cookie','Authorization','rawResponse','Provider claims only'])assert.equal(serialized.includes(value),false);
    assert.throws(()=>f.ledger.mark('bad',{classification:'ok',reasons:[]}),/MARK_INVALID/);
  }finally{f.db.close();}
});

test('existing inbox migration is local, restart-idempotent and preserves original receipt plus source event times',()=>{
  const root=mkdtempSync(join(tmpdir(),'debot-ledger-')),path=join(root,'inbox.sqlite');
  let db=new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE debot_signals(id TEXT PRIMARY KEY,chain TEXT,address TEXT,occurred_at TEXT,observed_at TEXT,payload TEXT)');
    for(let id=1;id<=2;id++){
      const source=observation(id,id);source.observedAt=iso(500);source.signal.occurredAt=iso(499);
      db.prepare('INSERT INTO debot_signals VALUES(?,?,?,?,?,?)').run(source.signal.sourceEventId,'bsc',ca,iso(id-10),iso(id),JSON.stringify(source));
    }
    db.prepare('INSERT INTO debot_signals VALUES(?,?,?,?,?,?)').run('bad','bsc',ca,iso(),iso(),'malformed-json');
    const before=db.prepare('SELECT * FROM debot_signals ORDER BY id').all();
    const ledger=new DebotNotificationLedger(db,()=>new Date(iso(1000)));
    assert.equal(ledger.current('bsc',ca)?.firstSeenAt,iso(1));assert.equal(ledger.current('bsc',ca)?.notificationCount,2);
    assert.deepEqual(ledger.history('bsc',ca).items.map(item=>[item.observedAt,item.occurredAt]),[[iso(2),iso(-8)],[iso(1),iso(-9)]]);
    assert.deepEqual(db.prepare('SELECT * FROM debot_signals ORDER BY id').all(),before);
    db.close();db=new DatabaseSync(path);const restarted=new DebotNotificationLedger(db,()=>new Date(iso(1500)));
    assert.equal(restarted.current('bsc',ca)?.deliveryCount,2);assert.equal(restarted.history('bsc',ca).total,2);
    assert.deepEqual(db.prepare('SELECT * FROM debot_signals ORDER BY id').all(),before);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('ledger writes participate in the caller transaction and rollback without partial aggregate counts',()=>{
  const f=fixture();try {
    f.db.exec('BEGIN');f.ledger.record(observation());f.db.exec('ROLLBACK');
    assert.equal(f.ledger.current('bsc',ca),undefined);assert.equal(f.ledger.history('bsc',ca).total,0);
    const invalid=observation();invalid.id='bad event';
    assert.throws(()=>f.ledger.record(invalid),/EVENT_INVALID/);assert.equal(f.ledger.history('bsc',ca).total,0);
    assert.equal(f.ledger.record(observation()).deliveryCount,1);
  }finally{f.db.close();}
});

test('capacity pruning keeps 10000 versions and exposes omissions without discarding a token aggregate',()=>{
  const f=fixture();try {
    const first=f.ledger.record(observation());
    const insert=f.db.prepare(`INSERT INTO debot_notification_versions(key,chain,address,event_id,vendor_event_id,occurred_at,
      observed_at,last_observed_at,kind,notification_count,delivery_count,delta,reasons)
      SELECT ?,chain,address,event_id,vendor_event_id,occurred_at,?,?,kind,notification_count,delivery_count,delta,reasons
      FROM debot_notification_versions WHERE key=?`);
    f.db.exec('BEGIN');
    for(let i=1;i<10_000;i++)insert.run(i.toString(16).padStart(64,'0'),iso(i),iso(i),first.key);
    f.db.prepare('UPDATE debot_notification_groups SET version_count=10000').run();f.db.exec('COMMIT');
    f.advance(10_001);f.ledger.record({...observation(1,10_001),alertPriceUsd:3});
    const current=f.ledger.current('bsc',ca)!;
    assert.equal(current.notificationCount,1);assert.equal(current.retainedHistory,10_000);assert.equal(current.truncatedHistory,1);
    assert.equal(current.firstSeenAt,iso());assert.equal(f.ledger.history('bsc',ca).total,10_000);
    assert.equal(f.db.prepare('SELECT key FROM debot_notification_versions WHERE key=?').get(first.key),undefined);
  }finally{f.db.close();}
});

test('capacity overflow deletes only exact oldest versions and skips unrelated retention sweeps',()=>{
  const f=fixture(),originalPrepare=f.db.prepare.bind(f.db),deletes:string[]=[];try {
    const first=f.ledger.record(observation());
    const insert=f.db.prepare(`INSERT INTO debot_notification_versions(key,chain,address,event_id,vendor_event_id,occurred_at,
      observed_at,last_observed_at,kind,notification_count,delivery_count,delta,reasons)
      SELECT ?,chain,address,event_id,vendor_event_id,occurred_at,?,?,kind,notification_count,delivery_count,delta,reasons
      FROM debot_notification_versions WHERE key=?`);
    f.db.exec('BEGIN');
    for(let i=1;i<10_000;i++)insert.run(i.toString(16).padStart(64,'0'),iso(i),iso(i),first.key);
    f.db.prepare('UPDATE debot_notification_groups SET version_count=10000').run();f.db.exec('COMMIT');
    (f.ledger as unknown as {retainedVersions:number}).retainedVersions=10_000;
    f.db.prepare=((sql:string)=>{if(/^DELETE FROM debot_notification_/.test(sql))deletes.push(sql);return originalPrepare(sql);}) as typeof f.db.prepare;
    f.advance(1);f.ledger.record({...observation(1,1),alertPriceUsd:2});f.db.prepare=originalPrepare;
    assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM debot_notification_versions').get()!.n),10_000);
    assert.equal(deletes.length,1);assert.match(deletes[0],/^DELETE FROM debot_notification_versions/);
    const plan=f.db.prepare('EXPLAIN QUERY PLAN '+deletes[0]).all(1).map(row=>String(row.detail));
    assert.ok(plan.some(detail=>detail.includes('USING COVERING INDEX debot_notification_versions_prune')));
    assert.ok(plan.every(detail=>!detail.includes('TEMP B-TREE')));
  }finally{f.db.prepare=originalPrepare;f.db.close();}
});

test('migration does not count already-linked rows or internal analysis revision jobs as vendor notifications',()=>{
  const db=new DatabaseSync(':memory:');try {
    db.exec('CREATE TABLE debot_signals(id TEXT PRIMARY KEY,chain TEXT,address TEXT,occurred_at TEXT,observed_at TEXT,payload TEXT,notification_key TEXT)');
    const original=observation(),revision=observation(2),linked=observation(3);
    revision.signal.sourceEventId='debot:revision:'+'a'.repeat(64);
    for(const [source,key] of [[original,null],[revision,null],[linked,'b'.repeat(64)]] as const)
      db.prepare('INSERT INTO debot_signals VALUES(?,?,?,?,?,?,?)').run(source.signal.sourceEventId,'bsc',ca,source.signal.occurredAt,source.observedAt,JSON.stringify(source),key);
    const ledger=new DebotNotificationLedger(db,()=>new Date(iso()));
    assert.equal(ledger.current('bsc',ca)?.notificationCount,1);assert.equal(ledger.history('bsc',ca).items[0].eventId,original.signal.sourceEventId);
    assert.equal(db.prepare('SELECT count(*) AS n FROM debot_signals').get()!.n,3);
  }finally{db.close();}
});
