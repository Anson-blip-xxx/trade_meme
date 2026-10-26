import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,openSync,closeSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {assertNativeTimingPreserved,type NativeExecutionTiming} from './timing.js';
export type NativeStatus='prepared'|'submitted'|'confirmed'|'failed'|'unknown';
export interface NativeJournalRecord {
  intentId:string;orderId:string;wallet:string;mint:string;side:'buy'|'sell';amount:string;slippageBps:number;
  status:NativeStatus;createdAt:string;updatedAt:string;failureReason?:string;venue?:string;
  signature?:string;rawTransaction?:string;blockhash?:string;lastValidBlockHeight?:number;contextSlot?:number;
  armed?:boolean;
  tokenDecimals?:number;minimumOutputAmount?:string;expectedOutputAmount?:string;subscriptionAccounts?:string[];
  quotedAt?:string;tipLamports?:string;tipAccount?:string;priorityFeeLamports?:string;computeUnitLimit?:number;
  inputAmount?:string;outputAmount?:string;actualNativeAmount?:string;networkFeeLamports?:string;slot?:number;
  trade?:unknown;provisional?:unknown;lastBroadcastAt?:string;broadcastCount?:number;
  timing?:NativeExecutionTiming;
}
const active="'prepared','submitted','unknown'";
/** Signed bytes are durable recovery material and never projected into HTTP/TG status. */
export class NativeJournal {
  private db:DatabaseSync;
  constructor(path:string){
    if(!path||path.startsWith('file:'))throw Error('NATIVE_JOURNAL_PATH_INVALID');
    if(path!==':memory:'){mkdirSync(dirname(path),{recursive:true,mode:0o700});const fd=openSync(path,'a',0o600);closeSync(fd);chmodSync(path,0o600);}
    this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS native_execution(intent_id TEXT PRIMARY KEY,identity TEXT NOT NULL,side TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS native_active_sell ON native_execution(identity) WHERE side='sell' AND status IN (${active});
      CREATE TABLE IF NOT EXISTS native_execution_leases(intent_id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
  }
  private tx<T>(work:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const r=work();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  get(id:string):NativeJournalRecord|undefined {const row=this.db.prepare('SELECT payload FROM native_execution WHERE intent_id=?').get(id);return row?JSON.parse(String(row.payload)):undefined;}
  listPending():NativeJournalRecord[]{return this.db.prepare(`SELECT payload FROM native_execution WHERE status IN (${active}) ORDER BY rowid`).all().map(r=>JSON.parse(String(r.payload)));}
  reserve(record:NativeJournalRecord,owner:string,now:number):{created:boolean;record:NativeJournalRecord}{return this.tx(()=>{
    const old=this.get(record.intentId);if(old){
      if(['orderId','wallet','mint','side','amount','slippageBps'].some(k=>(old as any)[k]!== (record as any)[k]))throw Error('NATIVE_INTENT_MISMATCH');
      return {created:false,record:old};
    }
    if(record.side==='sell'&&this.db.prepare(`SELECT 1 FROM native_execution WHERE identity=? AND side='sell' AND status IN (${active})`).get(`${record.wallet}:${record.mint}`))
      throw Error('NATIVE_SELL_IN_PROGRESS');
    this.db.prepare('INSERT INTO native_execution VALUES(?,?,?,?,?)').run(record.intentId,`${record.wallet}:${record.mint}`,record.side,record.status,JSON.stringify(record));
    this.db.prepare('INSERT INTO native_execution_leases VALUES(?,?,?)').run(record.intentId,owner,now+120000);return {created:true,record};
  });}
  acquire(id:string,owner:string,now:number):boolean{return this.tx(()=>{
    const lease=this.db.prepare('SELECT owner,expires_at FROM native_execution_leases WHERE intent_id=?').get(id);
    if(lease&&lease.owner!==owner&&Number(lease.expires_at)>now)return false;
    this.db.prepare('INSERT INTO native_execution_leases VALUES(?,?,?) ON CONFLICT(intent_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at')
      .run(id,owner,now+120000);return true;
  });}
  save(record:NativeJournalRecord,owner:string,now:number):void{this.tx(()=>{
    const lease=this.db.prepare('SELECT owner,expires_at FROM native_execution_leases WHERE intent_id=?').get(record.intentId);
    if(!lease||lease.owner!==owner||Number(lease.expires_at)<=now)throw Error('NATIVE_LEASE_LOST');
    const old=this.get(record.intentId);if(!old)throw Error('NATIVE_INTENT_MISSING');
    for(const key of ['orderId','wallet','mint','side','amount','slippageBps','signature','rawTransaction','blockhash','lastValidBlockHeight'] as const)
      if(old[key]!==undefined&&old[key]!==record[key])throw Error('NATIVE_INTENT_IMMUTABLE');
    assertNativeTimingPreserved(old.timing,record.timing);
    if(['confirmed','failed'].includes(old.status)&&JSON.stringify(old)!==JSON.stringify(record))throw Error('NATIVE_INTENT_TERMINAL');
    record.updatedAt=new Date(now).toISOString();
    this.db.prepare('UPDATE native_execution SET status=?,payload=? WHERE intent_id=?').run(record.status,JSON.stringify(record),record.intentId);
    this.db.prepare('UPDATE native_execution_leases SET expires_at=? WHERE intent_id=? AND owner=?').run(now+120000,record.intentId,owner);
  });}
  release(id:string,owner:string):void{this.db.prepare('DELETE FROM native_execution_leases WHERE intent_id=? AND owner=?').run(id,owner);}
  close(){this.db.close();}
}
