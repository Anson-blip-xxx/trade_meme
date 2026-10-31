import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {assertMemePriceArchiveCapacity,backfillMemePriceArchive,initializeMemePriceArchive,memePriceArchiveCapacity,memePriceArchiveDeletionCeiling,
  MEME_PRICE_ARCHIVE_SOURCE,pruneMemePriceArchive} from '../src/meme-price-archive.js';
import type {MemeMarketSample} from '../src/meme-assessment.js';

const origin=Date.parse('2026-10-31T01:00:00.000Z'),DAY=86_400_000;
const at=(offset=0)=>new Date(origin+offset).toISOString();
const address=(n=1)=>`0x${n.toString(16).padStart(40,'0')}`;
const sample=(observedAt:string,price=1):MemeMarketSample=>({version:1,token:{chain:'bsc',address:address()},observedAt,
  source:'dexscreener_pair',poolAddress:address(999),priceUsd:price,windows:{}});
function snapshots(db:DatabaseSync):void {
  db.exec(`CREATE TABLE meme_snapshots(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,observed_at TEXT NOT NULL,
    source TEXT NOT NULL,fingerprint TEXT UNIQUE,market TEXT,assessment TEXT NOT NULL)`);
}
const insert=(db:DatabaseSync,id:number,value:MemeMarketSample)=>db.prepare('INSERT INTO meme_snapshots VALUES(?,?,?,?,?,?,?,?)')
  .run(id,value.token.chain,value.token.address,value.observedAt,value.source,String(id),JSON.stringify(value),'{}');

test('first enable keeps a conservative boundary while bounded legacy backfill records its real earliest row',()=>{
  const db=new DatabaseSync(':memory:');try {
    snapshots(db);insert(db,1,sample(at(-2*DAY),1));insert(db,2,sample(at(-DAY),2));
    initializeMemePriceArchive(db,at());
    let state=db.prepare('SELECT * FROM meme_price_archive_state').get()!;
    assert.equal(state.continuous_from_at,at());assert.equal(state.initial_snapshot_oldest_at,at(-2*DAY));
    assert.equal(state.backfill_upper_id,2);assert.equal(state.backfill_cursor_id,0);
    assert.equal(memePriceArchiveDeletionCeiling(db),0);
    assert.equal(db.prepare('SELECT pruned_through FROM review_retention_watermarks WHERE source=?').get(MEME_PRICE_ARCHIVE_SOURCE)!.pruned_through,at());
    assert.deepEqual(backfillMemePriceArchive(db,at(),1),{inserted:1,pending:true});
    assert.equal(memePriceArchiveDeletionCeiling(db),1);
    assert.equal(Number(db.prepare('SELECT count(*) n FROM meme_price_archive').get()!.n),1);
    assert.deepEqual(backfillMemePriceArchive(db,at(),1),{inserted:1,pending:false});
    state=db.prepare('SELECT * FROM meme_price_archive_state').get()!;
    assert.equal(memePriceArchiveDeletionCeiling(db),undefined);
    assert.equal(state.earliest_observed_at,at(-2*DAY));assert.equal(state.backfill_completed_at,at());
    assert.equal(db.prepare('SELECT pruned_through FROM review_retention_watermarks WHERE source=?').get(MEME_PRICE_ARCHIVE_SOURCE)!.pruned_through,at(),
      'backfill must not move the conservative continuous-coverage boundary backwards');
    const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT chain,address,observed_at,source,price_usd price,pool_address pool
      FROM meme_price_archive WHERE chain=? AND address=? AND observed_at>=? AND observed_at<=?
      ORDER BY observed_at,source LIMIT 50001`).all('bsc',address(),at(-2*DAY),at());
    const details=plan.map(row=>String(row.detail)).join(' ');
    assert.match(details,/meme_price_archive_token_time/);assert.doesNotMatch(details,/TEMP B-TREE/);
  }finally{db.close();}
});

test('seven-day capacity admits the production 2 GiB / 180-token plan and rejects an undersized deployment',()=>{
  const ready=memePriceArchiveCapacity(180,2*1024**3);
  assert.equal(ready.plannedRows,3_628_800);assert.equal(ready.status,'ready');assert.ok(ready.headroomBytes>0);
  assert.equal(ready.nonArchiveReserveBytes,512*1024**2);
  const small=memePriceArchiveCapacity(180,1024**3);assert.equal(small.status,'insufficient');assert.ok(small.headroomBytes<0);
  assert.equal(memePriceArchiveCapacity(180,4*1024**3).nonArchiveReserveBytes,1024**3);
  assert.doesNotThrow(()=>assertMemePriceArchiveCapacity(180,2*1024**3));
  assert.throws(()=>assertMemePriceArchiveCapacity(180,1024**3),/MEME_PRICE_ARCHIVE_CAPACITY_INSUFFICIENT/);
});

test('seven-day retention is bounded and advances a monotonic deletion watermark',()=>{
  const db=new DatabaseSync(':memory:');try {
    snapshots(db);initializeMemePriceArchive(db,at(-10*DAY));
    const put=db.prepare(`INSERT INTO meme_price_archive(chain,address,observed_at,source,pool_address,price_usd)
      VALUES('bsc',?,?,'dexscreener_pair',?,1)`);
    put.run(address(),at(-9*DAY),address(999));put.run(address(),at(-8*DAY),address(999));put.run(address(),at(-6*DAY),address(999));
    assert.deepEqual(pruneMemePriceArchive(db,origin,1),{deleted:1,backlog:true});
    assert.equal(db.prepare('SELECT pruned_through FROM review_retention_watermarks WHERE source=?').get(MEME_PRICE_ARCHIVE_SOURCE)!.pruned_through,at(-9*DAY));
    assert.deepEqual(pruneMemePriceArchive(db,origin,10),{deleted:1,backlog:false});
    assert.equal(db.prepare('SELECT pruned_through FROM review_retention_watermarks WHERE source=?').get(MEME_PRICE_ARCHIVE_SOURCE)!.pruned_through,at(-8*DAY));
    assert.deepEqual(db.prepare('SELECT observed_at FROM meme_price_archive ORDER BY observed_at').all().map(row=>row.observed_at),[at(-6*DAY)]);
    db.exec('BEGIN');db.prepare('DELETE FROM meme_price_archive').run();assert.equal(db.prepare('SELECT pruned_through FROM review_retention_watermarks WHERE source=?').get(MEME_PRICE_ARCHIVE_SOURCE)!.pruned_through,at(-6*DAY));
    db.exec('ROLLBACK');assert.equal(db.prepare('SELECT pruned_through FROM review_retention_watermarks WHERE source=?').get(MEME_PRICE_ARCHIVE_SOURCE)!.pruned_through,at(-8*DAY));
  }finally{db.close();}
});
