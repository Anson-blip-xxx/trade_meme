import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureResearchWal} from '../src/research-sqlite.js';

test('research WAL uses NORMAL durability and bounded checkpoint settings',()=>{
  const dir=mkdtempSync(join(tmpdir(),'research-sqlite-')),path=join(dir,'research.sqlite');
  try {
    const db=new DatabaseSync(path);
    configureResearchWal(db,{busyTimeoutMs:25,autoCheckpointPages:32,journalSizeLimitBytes:4*1024*1024});
    assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode,'wal');
    assert.equal(db.prepare('PRAGMA synchronous').get()!.synchronous,1);
    assert.equal(db.prepare('PRAGMA busy_timeout').get()!.timeout,25);
    assert.equal(db.prepare('PRAGMA wal_autocheckpoint').get()!.wal_autocheckpoint,32);
    assert.equal(db.prepare('PRAGMA journal_size_limit').get()!.journal_size_limit,4*1024*1024);
    db.exec("CREATE TABLE evidence(value TEXT); BEGIN; INSERT INTO evidence VALUES ('kept'); COMMIT");db.close();
    const reopened=new DatabaseSync(path,{readOnly:true});
    assert.equal(reopened.prepare('SELECT value FROM evidence').get()!.value,'kept');reopened.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('research WAL rejects unsafe pragma parameters',()=>{
  const db=new DatabaseSync(':memory:');
  try {assert.throws(()=>configureResearchWal(db,{busyTimeoutMs:5001,autoCheckpointPages:32}),/RESEARCH_SQLITE_CONFIG_INVALID/);}
  finally {db.close();}
});
