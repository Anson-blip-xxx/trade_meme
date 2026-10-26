import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import type {TradeNotificationEvent} from '../trade-notifications.js';

/** A small, separate IPC journal. Never share a connection with research databases. */
export class NativeProcessStore {
  private db:DatabaseSync;
  constructor(path:string){
    mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5;
      CREATE TABLE IF NOT EXISTS process_actions(ref TEXT PRIMARY KEY,order_id TEXT NOT NULL,expires INTEGER NOT NULL,native_ref TEXT);
      CREATE INDEX IF NOT EXISTS process_actions_reusable ON process_actions(order_id,expires) WHERE native_ref IS NULL;
      CREATE INDEX IF NOT EXISTS process_actions_expired ON process_actions(expires);
      CREATE TABLE IF NOT EXISTS process_notices(key TEXT PRIMARY KEY,text TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS process_notices_pending ON process_notices(delivered) WHERE delivered=0;
      CREATE TABLE IF NOT EXISTS process_orders(order_id TEXT PRIMARY KEY,version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS process_health(id INTEGER PRIMARY KEY,checked INTEGER NOT NULL);`);
  }
  createAction(orderId:string,now=Date.now()):string{
    this.db.exec('BEGIN IMMEDIATE');
    try{
      // Keep deletion work bounded. New rows are rare because an unconsumed
      // capability is reused until it expires or is mapped to a native action.
      this.db.prepare('DELETE FROM process_actions WHERE rowid IN (SELECT rowid FROM process_actions WHERE expires<=? LIMIT 128)').run(now);
      const current=this.db.prepare(`SELECT ref FROM process_actions
        WHERE order_id=? AND native_ref IS NULL AND expires>? ORDER BY expires DESC LIMIT 1`).get(orderId,now);
      if(current){this.db.exec('COMMIT');return String(current.ref);}
      const ref='np'+randomBytes(15).toString('hex');
      this.db.prepare('INSERT INTO process_actions VALUES(?,?,?,NULL)').run(ref,orderId,now+86400000);
      this.db.exec('COMMIT');return ref;
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  action(ref:string):{ref:string;orderId:string;expires:number;nativeRef?:string}|undefined{
    if(!/^np[0-9a-f]{30}$/.test(ref))return;
    const r=this.db.prepare('SELECT * FROM process_actions WHERE ref=?').get(ref);
    return r?{ref,orderId:String(r.order_id),expires:Number(r.expires),nativeRef:r.native_ref?String(r.native_ref):undefined}:undefined;
  }
  mapAction(ref:string,nativeRef:string):void{this.db.prepare('UPDATE process_actions SET native_ref=? WHERE ref=? AND native_ref IS NULL').run(nativeRef,ref);}
  enqueue(event:TradeNotificationEvent):boolean{
    return Number(this.db.prepare('INSERT OR IGNORE INTO process_notices(key,text) VALUES(?,?)').run(event.key,event.text).changes)>0;
  }
  notices(limit=20):TradeNotificationEvent[]{return this.db.prepare('SELECT key,text FROM process_notices WHERE delivered=0 ORDER BY rowid LIMIT ?').all(limit).map(r=>({key:String(r.key),text:String(r.text)}));}
  ackNotice(key:string):void{this.db.prepare('UPDATE process_notices SET delivered=1 WHERE key=?').run(key);}
  changed(orderId:string):void{this.db.prepare('INSERT INTO process_orders VALUES(?,?) ON CONFLICT(order_id) DO UPDATE SET version=excluded.version').run(orderId,randomUUID());}
  changedOrders(limit=20):{orderId:string;version:string}[]{return this.db.prepare('SELECT * FROM process_orders LIMIT ?').all(limit).map(r=>({orderId:String(r.order_id),version:String(r.version)}));}
  ackOrder(orderId:string,version:string):void{this.db.prepare('DELETE FROM process_orders WHERE order_id=? AND version=?').run(orderId,version);}
  /** Used only after a storage failure; successful reads alone cannot prove that notifications can be persisted. */
  verifyWritable():void{this.db.prepare('INSERT INTO process_health VALUES(1,?) ON CONFLICT(id) DO UPDATE SET checked=excluded.checked').run(Date.now());}
  close(){this.db.close();}
}
