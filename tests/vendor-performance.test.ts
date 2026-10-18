import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeAvePerformance,normalizeDebotPerformance} from '../src/providers/vendor-performance.js';
import {normalizeAveSignals} from '../src/providers/ave-signals.js';
import {normalizeDebotSignals} from '../src/providers/debot-signals.js';
import {VendorPerformanceLedger} from '../src/vendor-performance-ledger.js';
import {AveScanner} from '../src/ave-scanner.js';
import {DebotScanner} from '../src/debot-scanner.js';

const epoch=Date.parse('2026-10-16T01:40:15.000Z'),ca='0x610a36f996650be0561f5d74d36b7e73520a7777';
const at=(offset=0)=>new Date(epoch+offset),iso=(offset=0)=>at(offset).toISOString();
function ave(gain='3.1654178952965631',offset=0){return normalizeAveSignals({status:1,data:{list:[{
  id:3257177,chain:'bsc',token:ca,symbol:'TEST',signal_time:1792114809,first_signal_time:1792114130,
  tag:'smarter_buy',action_type:'buy',action_count:2,current_price_usd:'0.0001536',max_price_change:gain,
  day_high_price:'0.00017234',actions:[]
}]}},at(offset));}
function debot(gain=.26896620488975265,offset=0){return normalizeDebotSignals({code:0,data:{
  meta:{tokens:{[ca]:{chain:'bsc',address:ca}},signals:{[ca]:{
    first_time:1792114130,first_price:.00001532648607871269,max_price:.00001944879287359967,max_price_gain:gain
  }}},results:[{id:'real-alarm',chain:'bsc',token:ca,channel_id:2,create_time:1792114809,wallet_stats:[],token_trading_stat:{price:.000015}}]
}},'bsc',at(offset));}
const values=(db:DatabaseSync)=>db.prepare('SELECT * FROM vendor_performance_snapshots ORDER BY reported_at,id').all();

test('vendor peak units and time scopes remain separate from local price/entry evidence',()=>{
  const a=ave().observations[0],d=debot().observations[0];
  assert.equal(a.vendorPerformance?.maxGainRaw,'3.1654178952965631');
  assert.equal(a.vendorPerformance?.maxGainDisplay,'3.17x');assert.equal(a.vendorPerformance?.maxGainPct,undefined);
  assert.equal(a.vendorPerformance?.maxGainUnit,'provider_display_ratio');
  assert.equal(a.vendorPerformance?.dayHighPriceUsd,.00017234);
  assert.equal(d.vendorPerformance?.maxGainPct,26.896620488975265);
  assert.equal(d.vendorPerformance?.maxGainUnit,'fractional_return');
  assert.equal(d.vendorPerformance?.firstSignalAt,'2026-10-16T01:28:50.000Z');
  assert.equal(d.vendorPerformance?.reportedAt,iso());assert.equal(d.alertPriceUsd,.000015);
  assert.equal(a.currentPriceUsd,.0001536);
  assert.deepEqual(a.signal,ave('10000',1000).observations[0].signal);
  assert.deepEqual(d.signal,debot(10000,1000).observations[0].signal);
  assert.equal(normalizeAvePerformance({max_price_change:'0.2'},at())?.maxGainDisplay,'20%');
  assert.equal(normalizeDebotPerformance({max_price_gain:0,max_price:.5,first_price:1},at())?.maxGainPct,0);
});

test('malformed, unbounded and future metrics cannot supply fabricated gains or timestamps',()=>{
  for(const value of [-1,'-1','Infinity','NaN',Infinity,NaN,true,null,{},' 2','1e999','9'.repeat(101)]){
    assert.equal(normalizeAvePerformance({max_price_change:value},at()),undefined);
    assert.equal(normalizeDebotPerformance({max_price_gain:value},at()),undefined);
  }
  const d=normalizeDebotPerformance({max_price_gain:2,first_time:epoch/1000+1,first_price:'bad',max_price:0},at());
  assert.equal(d?.firstSignalAt,undefined);assert.equal(d?.firstPriceUsd,undefined);assert.equal(d?.maxPriceUsd,undefined);
  assert.equal(normalizeAvePerformance({max_price_change:1},new Date('bad')),undefined);
});

test('DeBot metadata must bind exact chain and CA; conflicting lookup aliases cannot lend a peak',()=>{
  const raw:any={code:0,data:{meta:{signals:{[ca]:{max_price_gain:2,chain:'solana'}}},
    results:[{id:'alarm',chain:'bsc',token:ca,channel_id:2,create_time:1792114809}]}};
  assert.equal(normalizeDebotSignals(raw,'bsc',at()).observations[0].vendorPerformance,undefined);
  raw.data.meta.signals[ca]={max_price_gain:2,address:'0x1111111111111111111111111111111111111111'};
  assert.equal(normalizeDebotSignals(raw,'bsc',at()).observations[0].vendorPerformance,undefined);
  raw.data.meta.signals[ca]={max_price_gain:2};raw.data.meta.signals[`bsc:${ca}`]={max_price_gain:3};
  assert.equal(normalizeDebotSignals(raw,'bsc',at()).observations[0].vendorPerformance,undefined);
});

test('changed retrospective snapshots survive dedup, replay, restart and corrections with frozen receipt times',()=>{
  const db=new DatabaseSync(':memory:');let time=0;let ledger=new VendorPerformanceLedger(db,()=>at(time));
  try {
    assert.equal(ledger.record(ave().observations[0]),true);
    time=1000;assert.equal(ledger.record(ave(undefined,time).observations[0]),false);
    assert.equal(values(db)[0].reported_at,iso());
    time=2000;assert.equal(ledger.record(ave('8',time).observations[0]),true);
    time=3000;ledger=new VendorPerformanceLedger(db,()=>at(time));
    assert.equal(ledger.record(ave('3.1654178952965631',time).observations[0]),true);
    assert.equal(values(db).length,3);assert.equal(ledger.record(ave('100',1000).observations[0]),false);
    const rows=db.prepare('SELECT data FROM vendor_performance_snapshots WHERE reported_at<=? ORDER BY reported_at DESC,id DESC LIMIT 1').get(iso(2000));
    assert.equal(JSON.parse(String(rows?.data)).maxGainValue,8);
    assert.equal(JSON.parse(String(values(db).at(-1)?.data)).maxGainValue,3.1654178952965631);
    assert.equal(ledger.record(debot(10,time).observations[0]),true);assert.equal(values(db).length,4);
  }finally{db.close();}
});

test('ledger validates provenance, units and receipt times and strips arbitrary fields',()=>{
  const db=new DatabaseSync(':memory:'),ledger=new VendorPerformanceLedger(db,()=>at());
  try {
    for(const change of [(o:any)=>o.vendorPerformance.provider='debot',(o:any)=>o.vendorPerformance.maxGainPct=999,
      (o:any)=>o.vendorPerformance.maxGainUnit='fractional_return',(o:any)=>o.vendorPerformance.reportedAt=iso(-1000),
      (o:any)=>o.signal.token.chain='eth',(o:any)=>o.signal.token.address='0x61...7777',
      (o:any)=>o.signal.sourceEventId='ave:signal:bad',(o:any)=>o.vendorPerformance.firstSignalAt=iso(1000)]){
      const obs=ave().observations[0];change(obs);assert.equal(ledger.record(obs),false);
    }
    assert.equal(ledger.record(ave('1',1000).observations[0]),false);
    const old=ave('1').observations[0];old.observedAt=iso(-31*86400000);old.vendorPerformance!.reportedAt=old.observedAt;
    assert.equal(ledger.record(old),false);
    const clean:any=ave().observations[0];clean.vendorPerformance.secret='do-not-store';
    assert.equal(ledger.record(clean),true);assert.equal(String(values(db)[0].data).includes('secret'),false);
  }finally{db.close();}
});

test('ledger retention bounds changed frames and prunes old statistics without altering fresh snapshots',()=>{
  const db=new DatabaseSync(':memory:');let time=0;const ledger=new VendorPerformanceLedger(db,()=>at(time));
  try {
    db.exec('BEGIN');const insert=db.prepare(`INSERT INTO vendor_performance_snapshots(provider,chain,address,event_id,reported_at,fingerprint,data) VALUES('ave','bsc',?,'event',?,?,'{}')`);
    for(let i=0;i<20001;i++)insert.run(`0x${i.toString(16).padStart(40,'0')}`,iso(-i-1),String(i));
    insert.run('expired',iso(-31*86400000),'expired');db.exec('COMMIT');
    assert.equal(ledger.record(ave().observations[0]),true);assert.equal(values(db).length,20000);
    assert.equal(db.prepare("SELECT 1 FROM vendor_performance_snapshots WHERE address='expired'").get(),undefined);
    time=31*86400000;assert.equal(ledger.record(ave('9',time).observations[0]),true);
    assert.equal(values(db).length,1);assert.equal(JSON.parse(String(values(db)[0].data)).maxGainValue,9);
  }finally{db.close();}
});

test('Ave and DeBot repeated performance-only updates persist without new signals or research',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'vendor-performance-'));let time=0;
  try {
    for(const source of ['ave','debot'] as const){
      const database=join(directory,`${source}.sqlite`),signals:unknown[]=[];let callbacks=0;
      const scanner=source==='ave'?new AveScanner({database,chains:['bsc'],now:()=>at(time),onObservation:()=>{callbacks++;},onSignal:async s=>{signals.push(s);}}):
        new DebotScanner({database,chains:['bsc'],maxAgeSec:600,mode:'authenticated_stream',now:()=>at(time),onObservation:()=>{callbacks++;},onSignal:async s=>{signals.push(s);}});
      const db=new DatabaseSync(database);
      try {
        time=0;if(source==='ave')(scanner as AveScanner).acceptPage(ave());else (scanner as DebotScanner).acceptPage(debot());
        await scanner.dispatchOnce();assert.equal(signals.length,1);
        time=5000;if(source==='ave')(scanner as AveScanner).acceptPage(ave('8',time));else (scanner as DebotScanner).acceptPage(debot(8,time));
        await scanner.dispatchOnce();assert.equal(signals.length,1);assert.equal(scanner.getStatus().stored,1);
        assert.equal(values(db).length,2);assert.equal(values(db)[0].reported_at,iso());
        if(source==='ave')assert.equal(callbacks,1);
        else {assert.equal(db.prepare('SELECT notification_count FROM debot_notification_groups').get()?.notification_count,1);
          assert.equal(db.prepare('SELECT count(*) n FROM debot_notification_versions').get()?.n,1);}
        // Optional performance-storage faults do not roll back real notification intake.
        db.exec("CREATE TRIGGER reject_performance BEFORE INSERT ON vendor_performance_snapshots BEGIN SELECT RAISE(ABORT,'failure'); END");
        time=10000;if(source==='ave')(scanner as AveScanner).acceptPage(ave('9',time));else (scanner as DebotScanner).acceptPage(debot(9,time));
        assert.equal(scanner.getStatus().stored,1);assert.equal(scanner.getStatus().vendorPerformanceError,'VENDOR_PERFORMANCE_PERSIST_FAILED');
      }finally{db.close();await scanner.close();}
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});
