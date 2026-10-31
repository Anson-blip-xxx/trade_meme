import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MemeObserver} from '../src/meme-observer.js';

const origin=Date.parse('2026-10-01T00:00:00.000Z');
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const at=(n:number)=>new Date(origin+n).toISOString();
const waitFor=async(read:()=>boolean,timeoutMs=7000)=>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){if(read())return;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.fail('condition was not reached before timeout');
};

test('maintenance never deletes a full snapshot above the durable archive cursor',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'meme-price-migration-')),database=join(directory,'observer.sqlite');
  const seed=new DatabaseSync(database);seed.exec(`CREATE TABLE meme_snapshots(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,
    observed_at TEXT NOT NULL,source TEXT NOT NULL,fingerprint TEXT UNIQUE,market TEXT,assessment TEXT NOT NULL)`);
  const put=seed.prepare('INSERT INTO meme_snapshots VALUES(?,?,?,?,?,?,?,?)'),token=address(1),pool=address(2);
  seed.exec('BEGIN');try{
    for(let id=1;id<=701;id++)put.run(id,'bsc',token,at(id),'dexscreener_pair',String(id),JSON.stringify({
      version:1,token:{chain:'bsc',address:token},observedAt:at(id),source:'dexscreener_pair',poolAddress:pool,priceUsd:id,windows:{}}),'{}');
    seed.exec('COMMIT');
  }catch(error){seed.exec('ROLLBACK');seed.close();rmSync(directory,{recursive:true,force:true});throw error;}
  seed.close();
  const observer=new MemeObserver({database,maxBytes:64*1024**2,maxActive:1,now:()=>new Date('2026-10-31T00:00:00.000Z'),marketBatch:async()=>[]});
  const read=new DatabaseSync(database,{readOnly:true});
  try {
    await waitFor(()=>observer.runtimeStatus().storage.maintenance?.value?.priceArchive?.backfillPending===true&&
      observer.runtimeStatus().storage.maintenance?.value?.priceArchive?.backfilled===100);
    assert.ok(read.prepare('SELECT 1 FROM meme_snapshots WHERE id=601').get(),'unmigrated source row must survive age/cap cleanup');
    assert.equal(read.prepare('SELECT 1 FROM meme_price_archive WHERE observed_at=?').get(at(601)),undefined);
    await waitFor(()=>observer.runtimeStatus().storage.maintenance?.value?.priceArchive?.backfillPending===false);
    assert.ok(read.prepare('SELECT 1 FROM meme_price_archive WHERE observed_at=?').get(at(601)),
      'the source row becomes deletable only after its compact copy commits');
  }finally{read.close();await observer.close();rmSync(directory,{recursive:true,force:true});}
});
