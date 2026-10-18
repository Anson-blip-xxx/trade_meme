import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DebotScanner} from '../src/debot-scanner.js';
import {AveScanner} from '../src/ave-scanner.js';
import {ScanArchive} from '../src/scan-archive.js';
import type {DebotSignalObservation} from '../src/providers/debot-signals.js';

const origin=Date.parse('2026-10-18T01:00:00.000Z'),day=86400_000;
const at=(offset=0)=>new Date(origin+offset).toISOString();
const address=(n=1)=>`0x${n.toString(16).padStart(40,'0')}`;
const watermark=(db:DatabaseSync,source:string)=>db.prepare('SELECT pruned_through FROM review_retention_watermarks WHERE source=?').get(source)?.pruned_through;
function fixture(){const directory=mkdtempSync(join(tmpdir(),'review-retention-'));return {path:join(directory,'source.sqlite'),clean:()=>rmSync(directory,{recursive:true,force:true})};}
function seedSignals(db:DatabaseSync,source:'debot'|'ave',rows:Array<{id:string;at:string}>){
  db.exec('BEGIN');try {const put=db.prepare(`INSERT INTO ${source}_signals(id,chain,address,occurred_at,observed_at,state,payload) VALUES(?,'bsc',?,?,?,'completed','{"private":"NOT_RETAINED"}')`);
    for(const row of rows)put.run(row.id,address(),row.at,row.at);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

test('DeBot age and single-row capacity pruning preserve monotonic actual-deletion watermarks',async()=>{
  const f=fixture(),scanner=new DebotScanner({database:f.path,chains:['bsc'],maxAgeSec:600,now:()=>new Date(origin),onSignal:async()=>{},fetchPage:async()=>({observations:[],received:0,rejected:0})});
  const db=new DatabaseSync(f.path);
  try {
    assert.equal(watermark(db,'debot'),undefined);
    seedSignals(db,'debot',[{id:'expired-1',at:at(-32*day)},{id:'expired-2',at:at(-31*day)}]);
    await scanner.runOnce();assert.equal(watermark(db,'debot'),at(-31*day));
    seedSignals(db,'debot',[{id:'capacity-oldest',at:at(-2*day)},...Array.from({length:9999},(_,i)=>({id:`recent-${i}`,at:at(-1000)}))]);
    const observation:DebotSignalObservation={id:'20001',observedAt:at(),walletCount:3,addressCount:0,aliases:[],
      signal:{source:'debot',sourceEventId:'debot:signal:20001',token:{chain:'bsc',address:address(20001)},occurredAt:at(),text:'',claim:'unspecified',evidenceUrls:[]}};
    scanner.acceptPage({observations:[observation],received:1,rejected:0});
    assert.equal(db.prepare("SELECT 1 FROM debot_signals WHERE id='capacity-oldest'").get(),undefined);
    assert.equal(watermark(db,'debot'),at(-2*day));assert.equal(Number(db.prepare('SELECT count(*) n FROM debot_signals').get()!.n),10000);
    await scanner.runOnce();assert.equal(watermark(db,'debot'),at(-2*day));
    assert.deepEqual(db.prepare('SELECT * FROM review_retention_watermarks').all().map(row=>({...row})),[{source:'debot',pruned_through:at(-2*day)}]);
  }finally{db.close();await scanner.close();f.clean();}
});

test('Ave age and capacity pruning watermark only removed rows, survive restart, and roll back with deletion',async()=>{
  const f=fixture();let now=origin;
  const options={database:f.path,chains:['bsc' as const],now:()=>new Date(now),onObservation:()=>{},onSignal:async()=>{}};
  let scanner=new AveScanner(options);const db=new DatabaseSync(f.path);
  try {
    assert.equal(watermark(db,'ave'),undefined);
    seedSignals(db,'ave',[{id:'age-old',at:at(-32*day)},{id:'age-later',at:at(-31*day)},
      ...Array.from({length:10002},(_,i)=>({id:`capacity-${i}`,at:at(-20000+i)}))]);
    now+=60001;scanner.acceptPage({observations:[],received:0,rejected:0});
    assert.equal(Number(db.prepare('SELECT count(*) n FROM ave_signals').get()!.n),10000);
    assert.equal(watermark(db,'ave'),at(-19999));
    const before=watermark(db,'ave');db.exec('BEGIN');db.prepare("DELETE FROM ave_signals WHERE id='capacity-10001'").run();
    assert.equal(watermark(db,'ave'),at(-9999));db.exec('ROLLBACK');assert.equal(watermark(db,'ave'),before);
    db.prepare("DELETE FROM ave_signals WHERE id='not-present'").run();assert.equal(watermark(db,'ave'),before);
    await scanner.close();scanner=new AveScanner(options);assert.equal(watermark(db,'ave'),before);
  }finally{db.close();await scanner.close();f.clean();}
});

test('scan archive capacity and time pruning use received times and never move a watermark backward',()=>{
  const f=fixture();let now=origin;
  const archive=new ScanArchive(f.path,{maxEntries:2,retentionDays:1,now:()=>new Date(now)}),db=new DatabaseSync(f.path);
  const insert=db.prepare("INSERT INTO scan_summaries(id,chain,address,status,received_at,record) VALUES(?,'bsc',?,'completed',?,'{}')");
  try {
    assert.equal(watermark(db,'scans'),undefined);
    for(let i=0;i<4;i++)insert.run(`scan-${i}`,address(i+1),at(-4000+i*1000));
    archive.prune();assert.equal(watermark(db,'scans'),at(-3000));
    insert.run('late-old',address(5),at(-2*day));archive.prune();assert.equal(watermark(db,'scans'),at(-3000));
    now+=2*day;archive.prune();assert.equal(watermark(db,'scans'),at(-1000));
    assert.equal(Number(db.prepare('SELECT count(*) n FROM scan_summaries').get()!.n),0);
    archive.prune();assert.deepEqual(db.prepare('SELECT * FROM review_retention_watermarks').all().map(row=>({...row})),[{source:'scans',pruned_through:at(-1000)}]);
  }finally{db.close();archive.close();f.clean();}
});
