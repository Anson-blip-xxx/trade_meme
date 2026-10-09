import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Signal,Report} from './types.js';

export const PROCESSING_LEASE_MS=5*60*1000;
export interface Stored {
  id:string;status:'processing'|'completed'|'interrupted';signal:Signal;receivedAt:string;report?:Report;
  claimId?:string;leaseExpiresAt?:string;
}
export class Store {
  private db:DatabaseSync;
  observationError?:string;
  private notify(entry:Stored):void {
    try {this.onChange?.(entry);this.observationError=undefined;}
    catch {this.observationError='SCAN_ARCHIVE_WRITE_FAILED';}
  }
  constructor(path:string,private readonly onChange?:(entry:Stored)=>void) {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY;
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, event_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, signal TEXT NOT NULL, received_at TEXT NOT NULL,
        status TEXT NOT NULL, report TEXT, claim_id TEXT, lease_expires_at TEXT, UNIQUE(source,event_id)
      );
      CREATE TABLE IF NOT EXISTS evaluations (seq INTEGER PRIMARY KEY AUTOINCREMENT, signal_id TEXT NOT NULL,
        evaluated_at TEXT NOT NULL, report TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imports (seq INTEGER PRIMARY KEY AUTOINCREMENT, signal_id TEXT NOT NULL,
        channel TEXT NOT NULL, captured_at TEXT NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(signal_id,payload_hash));`);
    // Serialize migration with other process starts; older databases have neither column.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns=new Set(this.db.prepare('PRAGMA table_info(signals)').all().map(row=>String(row.name)));
      if(!columns.has('claim_id')) this.db.exec('ALTER TABLE signals ADD COLUMN claim_id TEXT');
      if(!columns.has('lease_expires_at')) this.db.exec('ALTER TABLE signals ADD COLUMN lease_expires_at TEXT');
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');this.db.close();throw e;}
  }
  recover(now:Date=new Date()):void {
    this.db.prepare(`UPDATE signals SET status='interrupted', claim_id=NULL, lease_expires_at=NULL
      WHERE status='processing' AND (claim_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)`)
      .run(now.toISOString());
  }
  reserve(signal:Signal,notificationPayload?:unknown,channel:'notification_copy'|'debot_story_response'='notification_copy'):{created:boolean;conflict:boolean;entry:Stored} {
    const payload=JSON.stringify(signal),hash=createHash('sha256').update(payload).digest('hex');
    const id=randomUUID(),now=new Date(),claimId=randomUUID();
    const leaseExpiresAt=new Date(now.getTime()+PROCESSING_LEASE_MS).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const write=this.db.prepare(`INSERT OR IGNORE INTO signals
        (id,source,event_id,payload_hash,signal,received_at,status,report,claim_id,lease_expires_at)
        VALUES (?,?,?,?,?,?,'processing',NULL,?,?)`)
        .run(id,signal.source,signal.sourceEventId,hash,payload,now.toISOString(),claimId,leaseExpiresAt);
      const row=this.db.prepare('SELECT * FROM signals WHERE source=? AND event_id=?').get(signal.source,signal.sourceEventId)!;
      const conflict=row.payload_hash!==hash,entry=this.decode(row);
      if(!conflict&&notificationPayload!==undefined) this.recordImport(entry.id,notificationPayload,channel);
      this.db.exec('COMMIT');
      if(Number(write.changes)>0) this.notify(entry);
      return {created:Number(write.changes)>0,conflict,entry};
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  finish(id:string,report:Report,claimId:string):boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const write=this.db.prepare(`UPDATE signals SET status='completed', report=?, claim_id=NULL, lease_expires_at=NULL
        WHERE id=? AND status='processing' AND claim_id=?`).run(JSON.stringify(report),id,claimId);
      if(Number(write.changes)) this.db.prepare('INSERT INTO evaluations(signal_id,evaluated_at,report) VALUES (?,?,?)').run(id,report.evaluatedAt,JSON.stringify(report));
      this.db.exec('COMMIT');
      if(Number(write.changes)>0) this.notify(this.get(id)!);
      return Number(write.changes)>0;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  interrupt(id:string,claimId:string):boolean {
    const write=this.db.prepare(`UPDATE signals SET status='interrupted', claim_id=NULL, lease_expires_at=NULL
      WHERE id=? AND status='processing' AND claim_id=?`).run(id,claimId);
    if(Number(write.changes)>0) this.notify(this.get(id)!);
    return Number(write.changes)>0;
  }
  retry(id:string,now:Date=new Date()):Stored|undefined {
    const claimId=randomUUID(),leaseExpiresAt=new Date(now.getTime()+PROCESSING_LEASE_MS).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const write=this.db.prepare(`UPDATE signals SET status='processing', claim_id=?, lease_expires_at=?
        WHERE id=? AND (status!='processing' OR claim_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)`)
        .run(claimId,leaseExpiresAt,id,now.toISOString());
      const entry=Number(write.changes)?this.get(id):undefined;
      this.db.exec('COMMIT');
      if(entry) this.notify(entry);
      return entry;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  get(id:string):Stored|undefined {const row=this.db.prepare('SELECT * FROM signals WHERE id=?').get(id);return row?this.decode(row):undefined;}
  list(limit=50):Stored[] {return this.db.prepare('SELECT * FROM signals ORDER BY rowid DESC LIMIT ?').all(limit).map(r=>this.decode(r));}
  history(id:string):Report[] {return this.db.prepare('SELECT report FROM evaluations WHERE signal_id=? ORDER BY seq').all(id).map(r=>JSON.parse(String(r.report)));}
  recordImport(id:string,payload:unknown,channel:'notification_copy'|'debot_story_response'):void {
    const json=JSON.stringify(payload),hash=createHash('sha256').update(json).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO imports(signal_id,channel,captured_at,payload_hash,payload) VALUES (?,?,?,?,?)')
      .run(id,channel,new Date().toISOString(),hash,json);
  }
  imports(id:string):{channel:string;capturedAt:string;payloadHash:string;verification:'user_supplied';payload:unknown}[] {
    return this.db.prepare('SELECT * FROM imports WHERE signal_id=? ORDER BY seq').all(id)
      .map(r=>({channel:String(r.channel),capturedAt:String(r.captured_at),payloadHash:String(r.payload_hash),verification:'user_supplied',payload:JSON.parse(String(r.payload))}));
  }
  prune(ttlSec:number,maxEntries:number,now=new Date()):void {
    const cutoff=new Date(now.getTime()-ttlSec*1000).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ids=this.db.prepare(`SELECT id FROM signals WHERE
        (status!='processing' OR lease_expires_at<=?) AND
        (received_at<? OR id NOT IN (SELECT id FROM signals ORDER BY rowid DESC LIMIT ?))`)
        .all(now.toISOString(),cutoff,maxEntries).map(r=>String(r.id));
      for(const id of ids) {
        this.db.prepare('DELETE FROM imports WHERE signal_id=?').run(id);
        this.db.prepare('DELETE FROM evaluations WHERE signal_id=?').run(id);
        this.db.prepare('DELETE FROM signals WHERE id=?').run(id);
      }
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  close():void {this.db.close();}
  private decode(row:Record<string,any>):Stored {
    return {id:row.id,status:row.status,signal:JSON.parse(row.signal),receivedAt:row.received_at,
      ...(row.claim_id?{claimId:String(row.claim_id)}:{}),
      ...(row.lease_expires_at?{leaseExpiresAt:String(row.lease_expires_at)}:{}),
      ...(row.status==='completed'&&row.report?{report:JSON.parse(row.report)}:{})};
  }
}
