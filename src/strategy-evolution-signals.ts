import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {chainAddress} from './chain-stream-store.js';
import type {Chain,Signal} from './types.js';

export interface EvolutionSignalEvent {
  source:'debot'|'ave';eventId:string;chain:Chain;address:string;occurredAt:string;observedAt:string;
  sessionId:string;ordinal:number;sessionExpiresAt:string;clusterKey:string;name?:string;symbol?:string;
}
type Row=Record<string,unknown>;
const WINDOW_MS=6*60*60_000;
const stamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
const text=(value:unknown,max:number)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max)||undefined:undefined;
const hash=(...values:string[])=>createHash('sha256').update(values.join('\0')).digest('hex');
export const strategyEvolutionDatabasePath=(archivePath:string)=>`${archivePath}.strategy-evolution.sqlite`;

/** Always-on DeBot/Ave research denominator. It has no count-control or order API. */
export class StrategyEvolutionSignalLedger {
  private readonly db:DatabaseSync;private readonly now:()=>Date;
  constructor(path:string,options:{now?:()=>Date}={}){
    if(!path||path.includes('\0'))throw new Error('STRATEGY_EVOLUTION_SIGNAL_STORE_INVALID');
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);this.now=options.now??(()=>new Date());
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS strategy_evolution_signal_events(
        source TEXT NOT NULL,event_id TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,
        occurred_at TEXT NOT NULL,observed_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,delivery_count INTEGER NOT NULL,
        session_id TEXT NOT NULL,ordinal INTEGER NOT NULL,session_expires_at TEXT NOT NULL,payload_hash TEXT NOT NULL,
        name TEXT,symbol TEXT,PRIMARY KEY(source,event_id));
      CREATE INDEX IF NOT EXISTS strategy_evolution_signal_session ON strategy_evolution_signal_events(source,chain,address,observed_at,event_id);
      CREATE INDEX IF NOT EXISTS strategy_evolution_signal_cohort ON strategy_evolution_signal_events(source,chain,session_id,observed_at);
      CREATE INDEX IF NOT EXISTS strategy_evolution_signal_time ON strategy_evolution_signal_events(observed_at,source,chain,address);
      CREATE TABLE IF NOT EXISTS strategy_evolution_signal_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.prepare("INSERT OR IGNORE INTO strategy_evolution_signal_meta VALUES('capture_started_at',?)").run(this.now().toISOString());
  }
  record(observation:{signal:Signal;observedAt:string;name?:string;symbol?:string}):{event:EvolutionSignalEvent;created:boolean}{
    const signal=observation?.signal,source=signal?.source,now=this.now();
    if(source!=='debot'&&source!=='ave'||!stamp(observation?.observedAt)||!stamp(signal?.occurredAt)||
      !Number.isFinite(now.getTime())||Date.parse(observation.observedAt)>now.getTime()+30_000||
      typeof signal.sourceEventId!=='string'||!/^[^\u0000-\u001f\u007f]{1,200}$/.test(signal.sourceEventId))
      throw new Error('STRATEGY_EVOLUTION_SIGNAL_INVALID');
    const chain=signal.token?.chain,address=chainAddress(chain,signal.token?.address);
    if(!address||!['bsc','solana','robinhood'].includes(chain))throw new Error('STRATEGY_EVOLUTION_SIGNAL_INVALID');
    const observedAt=new Date(observation.observedAt).toISOString(),occurredAt=new Date(signal.occurredAt).toISOString();
    // Display metadata may be enriched by a later durable-inbox replay. Keep
    // event identity tied to immutable vendor and token fields so enrichment
    // cannot turn an idempotent replay into a false conflict.
    const name=text(observation.name,100),symbol=text(observation.symbol,40),payloadHash=hash(source,signal.sourceEventId,chain,address,occurredAt);
    this.db.exec('BEGIN IMMEDIATE');try{
      const existing=this.db.prepare('SELECT * FROM strategy_evolution_signal_events WHERE source=? AND event_id=?').get(source,signal.sourceEventId) as Row|undefined;
      if(existing){
        if(existing.payload_hash!==payloadHash||existing.chain!==chain||existing.address!==address)throw new Error('STRATEGY_EVOLUTION_SIGNAL_CONFLICT');
        this.db.prepare(`UPDATE strategy_evolution_signal_events SET last_seen_at=MAX(last_seen_at,?),delivery_count=MIN(delivery_count+1,9007199254740991),
          name=COALESCE(name,?),symbol=COALESCE(symbol,?) WHERE source=? AND event_id=?`)
          .run(observedAt,name??null,symbol??null,source,signal.sourceEventId);
        const saved=this.db.prepare('SELECT * FROM strategy_evolution_signal_events WHERE source=? AND event_id=?').get(source,signal.sourceEventId) as Row;
        this.db.exec('COMMIT');return {event:this.project(saved),created:false};
      }
      const previous=this.db.prepare(`SELECT session_id,ordinal,observed_at FROM strategy_evolution_signal_events
        WHERE source=? AND chain=? AND address=? AND observed_at<=? ORDER BY observed_at DESC,rowid DESC LIMIT 1`)
        .get(source,chain,address,observedAt) as Row|undefined;
      const continues=!!previous&&Date.parse(observedAt)-Date.parse(String(previous.observed_at))<=WINDOW_MS;
      const sessionId=continues?String(previous!.session_id):hash('session-v1',source,chain,address,signal.sourceEventId,observedAt);
      const ordinal=continues?Number(this.db.prepare('SELECT MAX(ordinal) ordinal FROM strategy_evolution_signal_events WHERE session_id=?')
        .get(sessionId)!.ordinal)+1:1,expiresAt=new Date(Date.parse(observedAt)+WINDOW_MS).toISOString();
      this.db.prepare(`INSERT INTO strategy_evolution_signal_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source,signal.sourceEventId,
        chain,address,occurredAt,observedAt,observedAt,1,sessionId,ordinal,expiresAt,payloadHash,name??null,symbol??null);
      this.db.prepare("INSERT OR REPLACE INTO strategy_evolution_signal_meta VALUES('last_event_at',?)").run(observedAt);
      this.db.exec('COMMIT');return {event:{source,eventId:signal.sourceEventId,chain:chain as Chain,address,occurredAt,observedAt,
        sessionId,ordinal,sessionExpiresAt:expiresAt,clusterKey:`${chain}:${address}`,...(name?{name}:{}),...(symbol?{symbol}:{})},created:true};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private project(row:Row):EvolutionSignalEvent {return {source:String(row.source) as 'debot'|'ave',eventId:String(row.event_id),
    chain:String(row.chain) as Chain,address:String(row.address),occurredAt:String(row.occurred_at),observedAt:String(row.observed_at),
    sessionId:String(row.session_id),ordinal:Number(row.ordinal),sessionExpiresAt:String(row.session_expires_at),
    clusterKey:`${String(row.chain)}:${String(row.address)}`,...(row.name?{name:String(row.name)}:{}),...(row.symbol?{symbol:String(row.symbol)}:{})};}
  list(options:{source?:'debot'|'ave';chain?:Chain;limit?:number;offset?:number}={}){
    const limit=Number.isInteger(options.limit)?Math.max(1,Math.min(100,options.limit!)):20;
    const offset=Number.isInteger(options.offset)?Math.max(0,Math.min(1_000_000,options.offset!)):0,where:string[]=[],args:string[]=[];
    if(options.source){where.push('source=?');args.push(options.source);}if(options.chain){where.push('chain=?');args.push(options.chain);}
    const clause=where.length?'WHERE '+where.join(' AND '):'',total=Number(this.db.prepare(`SELECT count(*) n FROM strategy_evolution_signal_events ${clause}`).get(...args)!.n);
    const items=(this.db.prepare(`SELECT * FROM strategy_evolution_signal_events ${clause} ORDER BY observed_at DESC,source,event_id LIMIT ? OFFSET ?`)
      .all(...args,limit,offset) as Row[]).map(row=>this.project(row));return {total,limit,offset,hasMore:offset+items.length<total,items};
  }
  status(){const counts=this.db.prepare(`SELECT count(*) events,count(DISTINCT session_id) sessions,
      SUM(source='debot') debot,SUM(source='ave') ave,MAX(observed_at) last_event_at FROM strategy_evolution_signal_events`).get()!;
    const run=this.db.prepare("SELECT value FROM strategy_evolution_signal_meta WHERE key='last_daily_run'").get()?.value;
    return {enabled:true,scope:'research_only' as const,execution:'observation_only' as const,countingIndependent:true,
      events:Number(counts.events),sessions:Number(counts.sessions),bySource:{debot:Number(counts.debot??0),ave:Number(counts.ave??0)},
      captureStartedAt:this.db.prepare("SELECT value FROM strategy_evolution_signal_meta WHERE key='capture_started_at'").get()?.value,
      lastEventAt:counts.last_event_at?String(counts.last_event_at):undefined,
      lastDailyRun:typeof run==='string'?JSON.parse(run):undefined};}
  markDailyRun(input:{at:string;status:'succeeded'|'failed';error?:string}):void {
    if(!stamp(input?.at)||input.status!=='succeeded'&&input.status!=='failed'||
      input.error!==undefined&&(typeof input.error!=='string'||!/^[A-Z0-9_]{1,100}$/.test(input.error)))
      throw new Error('STRATEGY_EVOLUTION_RUN_STATUS_INVALID');
    this.db.prepare("INSERT OR REPLACE INTO strategy_evolution_signal_meta VALUES('last_daily_run',?)")
      .run(JSON.stringify({at:new Date(input.at).toISOString(),status:input.status,...(input.error?{error:input.error}:{})}));
  }
  acquireDailyLease(at:string,ttlMs=15*60_000):string {
    if(!stamp(at)||!Number.isSafeInteger(ttlMs)||ttlMs<60_000||ttlMs>60*60_000)throw new Error('STRATEGY_EVOLUTION_LEASE_INVALID');
    const owner=randomUUID(),expiresAt=new Date(Date.parse(at)+ttlMs).toISOString();this.db.exec('BEGIN IMMEDIATE');
    try {
      const raw=this.db.prepare("SELECT value FROM strategy_evolution_signal_meta WHERE key='daily_run_lease'").get()?.value;
      let current:{owner?:unknown;expiresAt?:unknown}|undefined;try{current=raw?JSON.parse(String(raw)):undefined;}catch{}
      if(typeof current?.owner==='string'&&stamp(current.expiresAt)&&String(current.expiresAt)>at)
        throw new Error('STRATEGY_EVOLUTION_RUN_LOCKED');
      this.db.prepare("INSERT OR REPLACE INTO strategy_evolution_signal_meta VALUES('daily_run_lease',?)")
        .run(JSON.stringify({owner,acquiredAt:new Date(at).toISOString(),expiresAt}));
      this.db.exec('COMMIT');return owner;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  releaseDailyLease(owner:string):void {
    if(!/^[0-9a-f-]{36}$/.test(owner))throw new Error('STRATEGY_EVOLUTION_LEASE_INVALID');
    const row=this.db.prepare("SELECT value FROM strategy_evolution_signal_meta WHERE key='daily_run_lease'").get();
    let current:{owner?:unknown}|undefined;try{current=row?JSON.parse(String(row.value)):undefined;}catch{}
    if(current?.owner===owner)this.db.prepare("DELETE FROM strategy_evolution_signal_meta WHERE key='daily_run_lease'").run();
  }
  prune(now=this.now(),days=180):number {if(!Number.isSafeInteger(days)||days<30||days>3650)throw new Error('STRATEGY_EVOLUTION_RETENTION_INVALID');
    return Number(this.db.prepare('DELETE FROM strategy_evolution_signal_events WHERE observed_at<?').run(new Date(now.getTime()-days*86400_000).toISOString()).changes);}
  close():void {this.db.close();}
}
