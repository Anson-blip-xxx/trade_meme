import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {chmodSync,closeSync,mkdirSync,openSync} from 'node:fs';
import {dirname} from 'node:path';
import bs58 from 'bs58';
import {normalizeStoredEntryHolderRisk,type EntryHolderRiskAssessment} from './entry-holder-risk.js';

export type ThirdSignalSource='debot'|'ave';
export type ThirdSignalChain='bsc'|'solana'|'robinhood';
export type ThirdSignalActor='web'|'tg';
export type ThirdSignalMode='simulation'|'live';
export interface ThirdSignalInput {
  source:ThirdSignalSource;chain:ThirdSignalChain;address:string;eventId:string;
  occurredAt:string;receivedAt:string;marketCapUsd?:number;name?:string;symbol?:string;
  /** Capture the run at signal arrival, before any asynchronous detail lookup. */
  runId?:string;
}
export interface ThirdSignalCandidate {
  id:string;runId:string;windowId:string;source:ThirdSignalSource;chain:ThirdSignalChain;address:string;
  eventId:string;count:3;marketCapUsd:number;occurredAt:string;receivedAt:string;createdAt:string;
  name?:string;symbol?:string;mode:ThirdSignalMode;executionEnabled:boolean;phase:'simulation_candidate'|'live_candidate';
}
export interface ThirdSignalExecution {
  status:'submitted'|'confirmed'|'unknown'|'blocked'|'failed';orderId?:string;reason?:string;
  /** Only the normalized assessment for this candidate is persisted; raw provider data is discarded. */
  holderRisk?:unknown;
}
export interface ThirdSignalResult {
  status:'ignored'|'counted'|'candidate'|'unknown'|'rejected';reason:string;count?:number;
  repeatBlocked?:boolean;candidate?:ThirdSignalCandidate;
}
export interface ThirdSignalPageOptions {limit?:number;offset?:number;}
export interface ThirdSignalWindow {
  runId:string;windowId:string;source:ThirdSignalSource;chain:ThirdSignalChain;address:string;count:number;
  firstReceivedAt:string;lastReceivedAt:string;expiresAt:string;expired:boolean;marketCapUsd?:number;
  thirdMarketCapUsd?:number;name?:string;symbol?:string;decision:string;reason?:string;repeatBlocked:boolean;
  claimPhase?:'simulation_candidate'|'live_candidate'|'actual_opened_imported';candidateId?:string;
  dispatchState?:'claimed'|'dispatched'|'handled'|'failed';dispatchReason?:string;
  executionStatus?:ThirdSignalExecution['status'];executionOrderId?:string;executionReason?:string;
  holderRisk?:EntryHolderRiskAssessment;
}
export interface ThirdSignalStatus {
  mode:ThirdSignalMode;executionEnabled:boolean;running:boolean;runId?:string;startedAt?:string;stoppedAt?:string;
  startActor?:ThirdSignalActor;stopActor?:ThirdSignalActor;ttlMs:number;maxSignalAgeMs:number;
  triggerCount:3;maxMarketCapUsd:100000;groups:number;events:number;candidates:number;repeatBlocked:number;globalClaims:number;
}
interface Run {mode:ThirdSignalMode;id:string;started_at:number;stopped_at:number|null;running:number;start_actor:ThirdSignalActor;stop_actor:ThirdSignalActor|null;}
interface WindowRow {
  run_id:string;window_id:string;source:ThirdSignalSource;chain:ThirdSignalChain;address:string;count:number;
  first_at:number;last_at:number;expires_at:number;market_cap:number|null;third_cap:number|null;
  name:string|null;symbol:string|null;decision:string;reason:string|null;candidate_id:string|null;repeat_blocked:number;
}
const TTL=6*60*60*1000,MAX_SIGNAL_AGE=120000,CAP=100000;
const iso=(at:number)=>new Date(at).toISOString();
const identifier=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\x00-\x1f\x7f]/.test(v);
const time=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)?Date.parse(v):NaN;
const label=(v:unknown,max:number)=>typeof v==='string'?v.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max)||undefined:undefined;
const cap=(v:unknown):number|undefined=>typeof v==='number'&&Number.isFinite(v)&&v>0?v:undefined;
function fail(reason:string):never {throw new Error(reason);}
function normalize(chain:ThirdSignalChain,address:unknown):string|undefined {
  if(typeof address!=='string')return;
  if(chain==='bsc'||chain==='robinhood')return /^0x[0-9a-fA-F]{40}$/.test(address)?address.toLowerCase():undefined;
  if(chain==='solana')try {const raw=bs58.decode(address);if(raw.length===32&&bs58.encode(raw)===address)return address;}catch{}
}
function actor(value:unknown):ThirdSignalActor {
  if(value==='web'||value==='tg')return value;return fail('THIRD_SIGNAL_ACTOR_INVALID');
}
function page(options:ThirdSignalPageOptions={}) {
  const limit=options.limit??20,offset=options.offset??0;
  if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0)
    fail('THIRD_SIGNAL_PAGE_INVALID');
  return {limit,offset};
}

/** Durable signal counting and write-ahead live candidate claims; no network or trade submission here. */
export class ThirdSignalStrategy {
  private readonly db:DatabaseSync;
  private readonly now:()=>number;
  private closed=false;
  constructor(path:string,options:{now?:()=>number}={}) {
    this.now=options.now??Date.now;
    if(!path||path.startsWith('file:'))fail('THIRD_SIGNAL_DATABASE_INVALID');
    if(path!==':memory:'){
      mkdirSync(dirname(path),{recursive:true,mode:0o700});const fd=openSync(path,'a',0o600);closeSync(fd);chmodSync(path,0o600);
    }
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS third_signal_runs(id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,stopped_at INTEGER,
        running INTEGER NOT NULL,start_actor TEXT NOT NULL,stop_actor TEXT);
      CREATE TABLE IF NOT EXISTS third_signal_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS third_signal_windows(run_id TEXT NOT NULL REFERENCES third_signal_runs(id),
        source TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,window_id TEXT NOT NULL,count INTEGER NOT NULL,
        first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,market_cap REAL,third_cap REAL,
        name TEXT,symbol TEXT,decision TEXT NOT NULL,reason TEXT,candidate_id TEXT,repeat_blocked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(run_id,source,chain,address));
      CREATE TABLE IF NOT EXISTS third_signal_events(run_id TEXT NOT NULL REFERENCES third_signal_runs(id),
        source TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,event_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,received_at INTEGER NOT NULL,count INTEGER NOT NULL,result TEXT NOT NULL,
        PRIMARY KEY(run_id,source,chain,address,event_id));
      CREATE TABLE IF NOT EXISTS third_signal_candidates(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,
        window_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS third_signal_candidate_run ON third_signal_candidates(run_id,created_at,id);
      CREATE TABLE IF NOT EXISTS third_signal_claims(chain TEXT NOT NULL,address TEXT NOT NULL,
        phase TEXT NOT NULL,claimed_at INTEGER NOT NULL,record_id TEXT NOT NULL,source TEXT,opened_record_id TEXT,
        PRIMARY KEY(chain,address));
      CREATE TABLE IF NOT EXISTS third_signal_dispatch(candidate_id TEXT PRIMARY KEY REFERENCES third_signal_candidates(id),
        state TEXT NOT NULL,reason TEXT,updated_at INTEGER NOT NULL);`);
    const runColumns=this.db.prepare('PRAGMA table_info(third_signal_runs)').all();
    if(!runColumns.some(row=>row.name==='mode'))this.db.exec("ALTER TABLE third_signal_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'simulation'");
    const dispatchColumns=this.db.prepare('PRAGMA table_info(third_signal_dispatch)').all();
    for(const column of ['execution_status','execution_order_id','execution_reason','execution_holder_risk'])if(!dispatchColumns.some(row=>row.name===column))
      this.db.exec(`ALTER TABLE third_signal_dispatch ADD COLUMN ${column} TEXT`);
  }
  private clock():number {
    const at=this.now();if(!Number.isSafeInteger(at)||at<0||at>8.64e15-TTL)fail('THIRD_SIGNAL_CLOCK_INVALID');return at;
  }
  private open():void {if(this.closed)fail('THIRD_SIGNAL_CLOSED');}
  private transaction<T>(work:()=>T):T {
    this.open();this.db.exec('BEGIN IMMEDIATE');
    try {const result=work();this.db.exec('COMMIT');return result;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private current():Run|undefined {
    return this.db.prepare(`SELECT r.* FROM third_signal_runs r JOIN third_signal_meta m
      ON m.key='current_run' AND m.value=r.id`).get() as unknown as Run|undefined;
  }
  start(by:ThirdSignalActor='web',mode:ThirdSignalMode='simulation'):ThirdSignalStatus {
    const who=actor(by);if(mode!=='live'&&mode!=='simulation')fail('THIRD_SIGNAL_MODE_INVALID');
    return this.transaction(()=>{
      const at=this.clock(),previous=this.current();
      if(previous?.running&&previous.mode===mode)return this.status();
      // Only an explicit start can change modes; a fresh run never inherits simulated counts.
      if(previous?.running)this.db.prepare('UPDATE third_signal_runs SET running=0,stopped_at=?,stop_actor=? WHERE id=?').run(at,who,previous.id);
      const id=randomUUID();this.db.prepare('INSERT INTO third_signal_runs(id,started_at,stopped_at,running,start_actor,stop_actor,mode) VALUES (?,?,NULL,1,?,NULL,?)').run(id,at,who,mode);
      this.db.prepare("INSERT INTO third_signal_meta VALUES ('current_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
      return this.status();
    });
  }
  stop(by:ThirdSignalActor='web'):ThirdSignalStatus {
    const who=actor(by);
    return this.transaction(()=>{
      const run=this.current();if(run?.running)this.db.prepare('UPDATE third_signal_runs SET running=0,stopped_at=?,stop_actor=? WHERE id=?')
        .run(this.clock(),who,run.id);
      return this.status();
    });
  }
  status():ThirdSignalStatus {
    this.open();const run=this.current();
    const count=(table:string)=>run?Number(this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE run_id=?`).get(run.id)!.n):0;
    return {mode:run?.mode??'simulation',executionEnabled:!!run?.running&&run.mode==='live',running:!!run?.running,
      ...(run?{runId:run.id,startedAt:iso(run.started_at),startActor:run.start_actor,
        ...(run.stopped_at!==null?{stoppedAt:iso(run.stopped_at),stopActor:run.stop_actor??undefined}:{})}:{}),
      ttlMs:TTL,maxSignalAgeMs:MAX_SIGNAL_AGE,triggerCount:3,maxMarketCapUsd:CAP,
      groups:count('third_signal_windows'),events:count('third_signal_events'),candidates:count('third_signal_candidates'),
      repeatBlocked:run?Number(this.db.prepare('SELECT count(*) AS n FROM third_signal_windows WHERE run_id=? AND repeat_blocked=1').get(run.id)!.n):0,
      globalClaims:Number(this.db.prepare(run?.mode==='live'?"SELECT count(*) AS n FROM third_signal_claims WHERE phase!='simulation_candidate'":'SELECT count(*) AS n FROM third_signal_claims').get()!.n)};
  }
  /** Import historical execution identity only. No submission or financial action occurs here. */
  markOpened(input:{chain:ThirdSignalChain;address:string;recordId:string;source?:string}):{created:boolean;phase:'actual_opened_imported'} {
    const address=normalize(input.chain,input.address);
    if(!address||!identifier(input.recordId)||input.source!==undefined&&(!identifier(input.source)||input.source.length>64))
      fail('THIRD_SIGNAL_OPENED_IMPORT_INVALID');
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT 1 FROM third_signal_claims WHERE chain=? AND address=?').get(input.chain,address);
      this.db.prepare(`INSERT INTO third_signal_claims(chain,address,phase,claimed_at,record_id,source,opened_record_id)
        VALUES (?,?,'actual_opened_imported',?,?,?,?) ON CONFLICT(chain,address) DO UPDATE SET
        phase='actual_opened_imported',opened_record_id=COALESCE(third_signal_claims.opened_record_id,excluded.opened_record_id)`)
        .run(input.chain,address,this.clock(),input.recordId,input.source??null,input.recordId);
      return {created:!existing,phase:'actual_opened_imported'};
    });
  }
  observe(input:ThirdSignalInput):ThirdSignalResult {
    return this.transaction(()=>{
      const run=this.current();if(!run?.running)return {status:'ignored',reason:'STRATEGY_STOPPED'};
      const now=this.clock(),address=normalize(input.chain,input.address),occurred=time(input.occurredAt),received=time(input.receivedAt);
      if(!['debot','ave'].includes(input.source)||!address||!identifier(input.eventId)||!Number.isFinite(occurred)||!Number.isFinite(received))
        return {status:'ignored',reason:'SIGNAL_INVALID'};
      if(input.runId!==undefined&&input.runId!==run.id)return {status:'ignored',reason:'RUN_MISMATCH'};
      if(occurred<run.started_at||received<run.started_at)return {status:'ignored',reason:'BEFORE_RUN_START'};
      if(received>now||occurred>received)return {status:'ignored',reason:'SIGNAL_TIME_INVALID'};
      const identity=[run.id,input.source,input.chain,address] as const;
      const prior=this.db.prepare('SELECT * FROM third_signal_windows WHERE run_id=? AND source=? AND chain=? AND address=?')
        .get(...identity) as unknown as WindowRow|undefined;
      if(this.db.prepare('SELECT 1 FROM third_signal_events WHERE run_id=? AND source=? AND chain=? AND address=? AND event_id=?')
        .get(...identity,input.eventId))return {status:'ignored',reason:'DUPLICATE_EVENT',count:prior?.count};
      if(now-received>MAX_SIGNAL_AGE||received-occurred>MAX_SIGNAL_AGE)return {status:'ignored',reason:'SIGNAL_STALE'};
      if(prior&&received<prior.last_at)return {status:'ignored',reason:'OUT_OF_ORDER_EVENT',count:prior.count};
      const reset=!prior||received-prior.last_at>=TTL;
      const count=reset?1:prior.count+1,windowId=reset?randomUUID():prior.window_id;
      if(!Number.isSafeInteger(count))fail('THIRD_SIGNAL_COUNT_OVERFLOW');
      const marketCap=cap(input.marketCapUsd),name=label(input.name,120)??prior?.name??null,symbol=label(input.symbol,40)??prior?.symbol??null;
      let decision=reset?'waiting':prior.decision,reason=reset?null:prior.reason,thirdCap=reset?null:prior.third_cap;
      let candidateId=reset?null:prior.candidate_id,repeatBlocked=reset?0:prior.repeat_blocked;
      let result:ThirdSignalResult={status:'counted',reason:count<3?'WAITING_FOR_THIRD_NOTIFICATION':'AFTER_THIRD_NOTIFICATION',count};
      if(count===3) {
        const existing=this.db.prepare("SELECT 1 FROM third_signal_claims WHERE chain=? AND address=? AND (?='simulation' OR phase!='simulation_candidate')").get(input.chain,address,run.mode);
        thirdCap=marketCap??null;
        if(existing){decision='rejected';reason='GLOBAL_TOKEN_ALREADY_CLAIMED';repeatBlocked=1;result={status:'rejected',reason,count,repeatBlocked:true};}
        else if(marketCap===undefined){decision='unknown';reason='THIRD_MARKET_CAP_UNKNOWN';result={status:'unknown',reason,count};}
        else if(marketCap>CAP){decision='rejected';reason='THIRD_MARKET_CAP_OVER_LIMIT';result={status:'rejected',reason,count};}
        else {
          candidateId=randomUUID();decision=run.mode==='live'?'live_candidate':'simulation_candidate';
          reason=run.mode==='live'?'THIRD_SIGNAL_LIVE_CANDIDATE':'THIRD_SIGNAL_SIMULATION_CANDIDATE';
          const candidate:ThirdSignalCandidate={id:candidateId,runId:run.id,windowId,source:input.source,chain:input.chain,address,
            eventId:input.eventId,count:3,marketCapUsd:marketCap,occurredAt:iso(occurred),receivedAt:iso(received),createdAt:iso(now),
            ...(name?{name}:{}),...(symbol?{symbol}:{}),mode:run.mode,executionEnabled:run.mode==='live',phase:run.mode==='live'?'live_candidate':'simulation_candidate'};
          this.db.prepare('INSERT INTO third_signal_candidates VALUES (?,?,?,?,?)').run(candidateId,run.id,windowId,now,JSON.stringify(candidate));
          this.db.prepare(`INSERT INTO third_signal_claims(chain,address,phase,claimed_at,record_id,source)
            VALUES (?,?,?,?,?,?) ON CONFLICT(chain,address) DO UPDATE SET phase=excluded.phase,claimed_at=excluded.claimed_at,
            record_id=excluded.record_id,source=excluded.source WHERE third_signal_claims.phase='simulation_candidate'`)
            .run(input.chain,address,candidate.phase,now,candidateId,input.source);
          if(run.mode==='live')this.db.prepare("INSERT INTO third_signal_dispatch(candidate_id,state,reason,updated_at) VALUES (?,'claimed',NULL,?)").run(candidate.id,now);
          result={status:'candidate',reason,count,candidate};
        }
      }
      this.db.prepare(`INSERT INTO third_signal_windows(run_id,source,chain,address,window_id,count,first_at,last_at,expires_at,
        market_cap,third_cap,name,symbol,decision,reason,candidate_id,repeat_blocked) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(run_id,source,chain,address) DO UPDATE SET window_id=excluded.window_id,count=excluded.count,
        first_at=excluded.first_at,last_at=excluded.last_at,expires_at=excluded.expires_at,market_cap=excluded.market_cap,
        third_cap=excluded.third_cap,name=excluded.name,symbol=excluded.symbol,decision=excluded.decision,reason=excluded.reason,
        candidate_id=excluded.candidate_id,repeat_blocked=excluded.repeat_blocked`)
        .run(...identity,windowId,count,reset?received:prior.first_at,received,received+TTL,marketCap??null,thirdCap,
          name,symbol,decision,reason,candidateId,repeatBlocked);
      this.db.prepare('INSERT INTO third_signal_events VALUES (?,?,?,?,?,?,?,?,?)')
        .run(...identity,input.eventId,occurred,received,count,JSON.stringify(result));
      return result;
    });
  }
  list(options:ThirdSignalPageOptions={}) {
    this.open();const {limit,offset}=page(options),run=this.current(),now=this.clock();
    const total=run?Number(this.db.prepare('SELECT count(*) AS n FROM third_signal_windows WHERE run_id=?').get(run.id)!.n):0;
    const rows=run?this.db.prepare(`SELECT w.*,c.phase AS claim_phase,d.state AS dispatch_state,d.reason AS dispatch_reason,d.execution_status,d.execution_order_id,d.execution_reason,d.execution_holder_risk FROM third_signal_windows w LEFT JOIN third_signal_claims c
      ON c.chain=w.chain AND c.address=w.address AND (?='simulation' OR c.phase!='simulation_candidate')
      LEFT JOIN third_signal_dispatch d ON d.candidate_id=w.candidate_id WHERE w.run_id=? ORDER BY w.last_at DESC,w.source,w.chain,w.address LIMIT ? OFFSET ?`)
      .all(run.mode,run.id,limit,offset):[];
    const items:ThirdSignalWindow[]=rows.map(raw=>{
      const row=raw as unknown as WindowRow&{claim_phase?:ThirdSignalWindow['claimPhase'];dispatch_state?:ThirdSignalWindow['dispatchState'];dispatch_reason?:string;execution_status?:ThirdSignalExecution['status'];execution_order_id?:string;execution_reason?:string;execution_holder_risk?:string};
      let holderRisk:EntryHolderRiskAssessment|undefined;
      if(row.execution_holder_risk)try{holderRisk=normalizeStoredEntryHolderRisk(JSON.parse(row.execution_holder_risk),{chain:row.chain,address:row.address});}catch{/* Historical malformed data never becomes dashboard output. */}
      return {runId:row.run_id,windowId:row.window_id,source:row.source,chain:row.chain,address:row.address,count:row.count,
        firstReceivedAt:iso(row.first_at),lastReceivedAt:iso(row.last_at),expiresAt:iso(row.expires_at),expired:now>=row.expires_at,
        ...(row.market_cap!==null?{marketCapUsd:row.market_cap}:{}),...(row.third_cap!==null?{thirdMarketCapUsd:row.third_cap}:{}),
        ...(row.name?{name:row.name}:{}),...(row.symbol?{symbol:row.symbol}:{}),decision:row.decision,
        ...(row.reason?{reason:row.reason}:{}),repeatBlocked:!!row.repeat_blocked||!!row.claim_phase,
        ...(row.execution_status?{executionStatus:row.execution_status}:{}),...(row.execution_order_id?{executionOrderId:row.execution_order_id}:{}),
        ...(row.execution_reason?{executionReason:row.execution_reason}:{}),
        ...(holderRisk?{holderRisk}:{}),
        ...(row.dispatch_state?{dispatchState:row.dispatch_state}:{}),...(row.dispatch_reason?{dispatchReason:row.dispatch_reason}:{}),
        ...(row.claim_phase?{claimPhase:row.claim_phase}:{}),...(row.candidate_id?{candidateId:row.candidate_id}:{})};
    });
    return {mode:run?.mode??'simulation',executionEnabled:!!run?.running&&run.mode==='live',runId:run?.id,items,total,limit,offset,hasMore:offset+items.length<total};
  }
  candidates(options:ThirdSignalPageOptions={}) {
    this.open();const {limit,offset}=page(options),run=this.current();
    const total=run?Number(this.db.prepare('SELECT count(*) AS n FROM third_signal_candidates WHERE run_id=?').get(run.id)!.n):0;
    const items:ThirdSignalCandidate[]=run?this.db.prepare('SELECT payload FROM third_signal_candidates WHERE run_id=? ORDER BY created_at,id LIMIT ? OFFSET ?')
      .all(run.id,limit,offset).map(row=>JSON.parse(String(row.payload)) as ThirdSignalCandidate):[];
    return {mode:run?.mode??'simulation',executionEnabled:!!run?.running&&run.mode==='live',runId:run?.id,items,total,limit,offset,hasMore:offset+items.length<total};
  }
  /** Fence delayed callbacks against stop/new-run and the durable global token claim. */
  isActive(candidate:ThirdSignalCandidate):boolean {
    this.open();const run=this.current();
    if(!run?.running||run.mode!=='live'||candidate.mode!=='live'||run.id!==candidate.runId)return false;
    return !!this.db.prepare(`SELECT 1 FROM third_signal_claims c JOIN third_signal_candidates a ON a.id=c.record_id
      JOIN third_signal_dispatch d ON d.candidate_id=a.id WHERE c.chain=? AND c.address=? AND c.record_id=?
      AND c.phase='live_candidate' AND a.run_id=? AND d.state IN ('claimed','dispatched')`)
      .get(candidate.chain,candidate.address,candidate.id,candidate.runId);
  }
  /** Persist dispatch ownership before invoking any asynchronous execution callback. Never replay it. */
  claimDispatch(candidate:ThirdSignalCandidate):boolean {
    return this.transaction(()=>{
      if(!this.isActive(candidate))return false;
      return this.db.prepare("UPDATE third_signal_dispatch SET state='dispatched',updated_at=? WHERE candidate_id=? AND state='claimed'")
        .run(this.clock(),candidate.id).changes===1;
    });
  }
  finishDispatch(candidate:ThirdSignalCandidate,reason?:string):void {
    const safeReason=reason&&/^[A-Z][A-Z0-9_]{1,100}$/.test(reason)?reason:reason?'THIRD_SIGNAL_ENTRY_CALLBACK_FAILED':undefined;
    this.transaction(()=>{
      this.db.prepare("UPDATE third_signal_dispatch SET state=?,reason=?,updated_at=? WHERE candidate_id=? AND state='dispatched'")
        .run(safeReason?'failed':'handled',safeReason??null,this.clock(),candidate.id);
      if(safeReason)this.db.prepare("UPDATE third_signal_windows SET reason=? WHERE candidate_id=?").run(safeReason,candidate.id);
    });
  }
  recordExecution(candidate:ThirdSignalCandidate,execution:ThirdSignalExecution):void {
    if(candidate.mode!=='live'||!['submitted','confirmed','unknown','blocked','failed'].includes(execution.status)||
      execution.orderId!==undefined&&!identifier(execution.orderId)||
      execution.reason!==undefined&&!/^[A-Z][A-Z0-9_]{1,100}$/.test(execution.reason))fail('THIRD_SIGNAL_EXECUTION_INVALID');
    const holderRisk=normalizeStoredEntryHolderRisk(execution.holderRisk,{chain:candidate.chain,address:candidate.address});
    this.transaction(()=>{
      this.db.prepare(`UPDATE third_signal_dispatch SET execution_status=?,execution_order_id=COALESCE(?,execution_order_id),
        execution_reason=?,execution_holder_risk=COALESCE(?,execution_holder_risk),updated_at=? WHERE candidate_id=? AND EXISTS(SELECT 1 FROM third_signal_candidates WHERE id=? AND run_id=?)`)
        .run(execution.status,execution.orderId??null,execution.reason??null,holderRisk?JSON.stringify(holderRisk):null,this.clock(),candidate.id,candidate.id,candidate.runId);
    });
  }
  close():void {if(!this.closed){this.db.close();this.closed=true;}}
}
