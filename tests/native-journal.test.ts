import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {NativeJournal,type NativeJournalRecord} from '../src/native-solana/journal.js';
import {createNativeTiming} from '../src/native-solana/timing.js';
const now=Date.now();const row=(id='a'):NativeJournalRecord=>({intentId:id,orderId:'o',wallet:'w',mint:'m',side:'sell',amount:'9007199254740993',slippageBps:500,status:'prepared',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()});
test('same intent is idempotent and unresolved sell locks span database handles and restart',t=>{const dir=mkdtempSync(join(tmpdir(),'native-journal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'state.sqlite');
 const a=new NativeJournal(path),b=new NativeJournal(path);t.after(()=>b.close());assert.equal(a.reserve(row(),'owner',now).created,true);assert.equal(b.reserve(row(),'other',now).created,false);
 assert.throws(()=>b.reserve(row('b'),'other',now),/NATIVE_SELL_IN_PROGRESS/);assert.throws(()=>b.reserve({...row(),amount:'2'},'other',now),/MISMATCH/);
 const r=a.get('a')!;Object.assign(r,{armed:true,rawTransaction:'bytes',signature:'sig',status:'unknown'});a.save(r,'owner',now);a.release('a','owner');a.close();
 assert.equal(b.get('a')?.amount,'9007199254740993');assert.equal(b.listPending().length,1);assert.equal(b.acquire('a','other',now),true);
 assert.throws(()=>b.save({...r,rawTransaction:'different'},'other',now),/IMMUTABLE/);r.status='failed';b.save(r,'other',now);
 assert.equal(b.reserve(row('b'),'next',now).created,true);
});
test('lease loss prevents durable mutation',t=>{const db=new NativeJournal(':memory:');t.after(()=>db.close());db.reserve(row(),'a',now);
 assert.equal(db.acquire('a','b',now),false);assert.throws(()=>db.save(row(),'b',now),/LEASE_LOST/);assert.equal(db.acquire('a','b',now+120001),true);
 assert.throws(()=>db.save(row(),'a',now+120001),/LEASE_LOST/);
});
test('timing is append-only and legacy records cannot acquire fabricated start times',t=>{
 const db=new NativeJournal(':memory:');t.after(()=>db.close());const stamp=new Date(now).toISOString();
 const record={...row(),timing:createNativeTiming(stamp)};db.reserve(record,'owner',now);
 record.timing.stagesMs.plan=3;record.timing.confirmedObservedAt=new Date(now+1000).toISOString();record.timing.confirmedAfterMs=1000;db.save(record,'owner',now);
 for(const mutation of [
   {...record,timing:{...record.timing,startedAt:new Date(now+1).toISOString()}},
   {...record,timing:{...record.timing,stagesMs:{plan:4}}},
   {...record,timing:{...record.timing,confirmedObservedAt:new Date(now+2000).toISOString()}},
   {...record,timing:undefined},
 ])assert.throws(()=>db.save(mutation,'owner',now),/NATIVE_TIMING_IMMUTABLE/);
 record.timing.stagesMs.simulation=5;record.timing.finalizedObservedAt=new Date(now+3000).toISOString();record.timing.finalizedAfterMs=3000;
 db.save(record,'owner',now);assert.equal(db.get(record.intentId)?.timing?.confirmedAfterMs,1000);
 const legacy={...row('legacy'),side:'buy' as const};db.reserve(legacy,'legacy-owner',now);
 assert.throws(()=>db.save({...legacy,timing:createNativeTiming(stamp)},'legacy-owner',now),/NATIVE_TIMING_IMMUTABLE/);
});
