import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import {ADAPTIVE_SHADOW_V1,stepAdaptiveExit,type AdaptiveExitState,type WalletPressure} from './adaptive-exit.js';
import type {Chain} from './types.js';
import type {ScanPrice,ScanToken} from './scan-archive.js';

export interface ExitObservationSeed {candidateId:string;eligibleAt:string;endsAt:string;symbol?:string;}
export interface ExitShadowOptions {maxBytes?:number;staleAfterSec?:number;maxPositions?:number;now?:()=>Date;}
interface ShadowRow {
  id:string;chain:Chain;address:string;candidate_id:string;eligible_at:string;ends_at:string;symbol:string|null;
  started_at:string;updated_at:string;phase:'tracking'|'triggered'|'ended';state:string;
  last_price_at:string;last_price:number;error:string|null;error_at:string|null;
}
export interface ShadowEvent {
  at:string;kind:string;reason:string;observationOnly:true;sellPct?:number;gainPct?:number;
  priceUsd?:number;protectionPriceUsd?:number;remainingPct?:number;
}
const stamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));
const clean=(value:unknown,max=80)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max):undefined;
const code=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(value)?value:'PRICE_SAMPLE_UNAVAILABLE';
function identity(value:ScanToken):ScanToken|undefined {
  if(!value||!['bsc','solana','robinhood'].includes(value.chain)||typeof value.address!=='string')return;
  if(value.chain==='solana')try {const decoded=bs58.decode(value.address);return decoded.length===32&&decoded.some(x=>x!==0)?{...value}:undefined;}catch{return;}
  return /^0x[0-9a-fA-F]{40}$/.test(value.address)&&!/^0x0{40}$/i.test(value.address)?{chain:value.chain,address:value.address.toLowerCase()}:undefined;
}

/** Forward-only research. This class cannot quote, sign, submit, or verify protection for a real holding. */
export class ExitShadow {
  private readonly db:DatabaseSync;
  private readonly now:()=>Date;
  private readonly maxBytes:number;
  private readonly staleMs:number;
  private readonly maxPositions:number;
  private lastError?:string;
  constructor(private readonly path:string,options:ExitShadowOptions={}) {
    this.now=options.now??(()=>new Date());this.maxBytes=options.maxBytes??128*1024*1024;
    this.staleMs=(options.staleAfterSec??180)*1000;this.maxPositions=options.maxPositions??1000;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<16384||!Number.isSafeInteger(this.staleMs)||this.staleMs<1000||
      !Number.isSafeInteger(this.maxPositions)||this.maxPositions<1||this.maxPositions>10000)throw new Error('EXIT_SHADOW_CONFIG_INVALID');
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=128;
      CREATE TABLE IF NOT EXISTS exit_shadow_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exit_shadow_positions(id TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,
        candidate_id TEXT NOT NULL,eligible_at TEXT NOT NULL,ends_at TEXT NOT NULL,symbol TEXT,started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,phase TEXT NOT NULL,state TEXT NOT NULL,last_price_at TEXT NOT NULL,last_price REAL NOT NULL,error TEXT,error_at TEXT,
        UNIQUE(chain,address,candidate_id));
      CREATE INDEX IF NOT EXISTS exit_shadow_token ON exit_shadow_positions(chain,address,started_at DESC);
      CREATE TABLE IF NOT EXISTS exit_shadow_samples(position_id TEXT NOT NULL,at TEXT NOT NULL,price REAL NOT NULL,
        source TEXT NOT NULL,context TEXT NOT NULL,PRIMARY KEY(position_id,at));
      CREATE TABLE IF NOT EXISTS exit_shadow_events(id INTEGER PRIMARY KEY,position_id TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS exit_shadow_event_position ON exit_shadow_events(position_id,id DESC);`);
    this.db.prepare('INSERT OR IGNORE INTO exit_shadow_meta VALUES (?,?)').run('started_at',this.now().toISOString());
    this.db.prepare('INSERT OR IGNORE INTO exit_shadow_meta VALUES (?,?)').run('history_complete','true');
  }

  recordPrice(price:ScanPrice,seed:ExitObservationSeed|undefined,pressure?:WalletPressure):void {
    const target=identity(price),now=this.now();
    if(!target||!Number.isFinite(price.priceUsd)||price.priceUsd<=0||!stamp(price.observedAt)||
      price.source!=='gmgn_token_info_sample'||Date.parse(price.observedAt)>now.getTime()||
      now.getTime()-Date.parse(price.observedAt)>ADAPTIVE_SHADOW_V1.maxPriceAgeMs||
      Date.parse(price.observedAt)<Date.parse(this.meta('started_at')!))return;
    const at=new Date(price.observedAt).toISOString();
    let previous=this.current(target);
    if(previous&&at<=previous.last_price_at)return;
    if(previous&&Date.parse(previous.ends_at)<=now.getTime()&&seed&&seed.candidateId!==previous.candidate_id&&
      stamp(seed.eligibleAt)&&Date.parse(seed.eligibleAt)>Date.parse(previous.eligible_at))previous=undefined;
    if(!previous&&(!seed||!stamp(seed.eligibleAt)||!stamp(seed.endsAt)||Date.parse(seed.eligibleAt)>Date.parse(at)||
      Date.parse(seed.endsAt)<=now.getTime()||typeof seed.candidateId!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(seed.candidateId)))return;
    // A finished observation is not silently reopened for the same old candidate.
    if(previous&&(previous.phase==='ended'||Date.parse(previous.ends_at)<=now.getTime()))return;
    const state=previous?JSON.parse(previous.state) as AdaptiveExitState:undefined;
    const observation={...target,priceUsd:price.priceUsd,observedAt:at,evaluatedAt:now.toISOString(),source:price.source};
    const result=stepAdaptiveExit(state,observation,pressure);
    if(result.status==='ignored'&&result.ignoredReason!=='SHADOW_CLOSED') {
      if(!['DUPLICATE_SAMPLE','TIME_REGRESSED','PRICE_STALE','PRICE_FROM_FUTURE'].includes(result.ignoredReason??''))
        this.fail('EXIT_SHADOW_STATE_INVALID');
      return;
    }
    const next=result.state??state;if(!next)return;
    // Closed simulations still collect comparison prices. Their arithmetic must
    // remain valid even though the model no longer advances its own state.
    if(!Number.isFinite((price.priceUsd/next.baselinePriceUsd-1)*100))this.fail('EXIT_SHADOW_PRICE_ARITHMETIC_INVALID');
    const context={policyVersion:next.policyVersion,protectionPriceUsd:next.protectionPriceUsd,
      protectionActive:next.protectionActive,activationGainPct:next.activationGainPct,trailPct:next.drawdownPct,
      remainingPct:next.remainingPctOfInitial,shadowClosed:next.shadowClosed,volatilityPctPerMinute:next.volatilityPctPerMinute,
      gapSec:previous?(Date.parse(at)-Date.parse(previous.last_price_at))/1000:0,
      walletPressure:next.walletPressure,pressureIgnoredReason:result.ignoredPressureReason};
    try {
      if(this.bytes()+JSON.stringify(context).length*3+JSON.stringify(next).length*3+16384>this.maxBytes)
        throw new Error('EXIT_SHADOW_CAPACITY_REACHED');
      if(!previous&&Number(this.db.prepare('SELECT count(*) AS n FROM exit_shadow_positions').get()!.n)>=this.maxPositions)
        throw new Error('EXIT_SHADOW_POSITION_CAPACITY_REACHED');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const id=previous?.id??randomUUID();
        if(!previous)this.db.prepare('INSERT INTO exit_shadow_positions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,target.chain,target.address,
          seed!.candidateId,new Date(seed!.eligibleAt).toISOString(),new Date(seed!.endsAt).toISOString(),clean(seed!.symbol)??null,
          at,at,'tracking',JSON.stringify(next),at,price.priceUsd,null,null);
        const inserted=this.db.prepare('INSERT OR IGNORE INTO exit_shadow_samples VALUES (?,?,?,?,?)')
          .run(id,at,price.priceUsd,price.source,JSON.stringify(context));
        if(!Number(inserted.changes)){this.db.exec('COMMIT');return;}
        const emit=(event:ShadowEvent)=>this.db.prepare('INSERT INTO exit_shadow_events(position_id,at,data) VALUES (?,?,?)').run(id,event.at,JSON.stringify(event));
        if(!previous)emit({at,kind:'initialized',reason:'SHADOW_STARTED',observationOnly:true,priceUsd:price.priceUsd,gainPct:0,remainingPct:100});
        else if(previous.error)emit({at,kind:'price_recovered',reason:'PRICE_SAMPLE_RECOVERED',observationOnly:true,priceUsd:price.priceUsd});
        if(state&&!state.shadowClosed&&next.protectionActive&&(!state.protectionActive||next.protectionPriceUsd>state.protectionPriceUsd))
          emit({at,kind:state.protectionActive?'protection_raised':'protection_armed',
            reason:state.protectionActive?'PROTECTION_LINE_RAISED':'DYNAMIC_PROTECTION_ARMED',observationOnly:true,
            priceUsd:price.priceUsd,protectionPriceUsd:next.protectionPriceUsd,gainPct:(price.priceUsd/next.baselinePriceUsd-1)*100});
        if(result.event) {
          const e=result.event;
          emit({at:e.observedAt,kind:e.kind,reason:e.reasons[0],observationOnly:true,
            sellPct:e.sellPctRemaining,gainPct:e.observedGainPct,priceUsd:e.observedPriceUsd,
            protectionPriceUsd:e.protectionPriceUsd,remainingPct:e.remainingPctOfInitial});
        }
        this.db.prepare('UPDATE exit_shadow_positions SET updated_at=?,phase=?,state=?,last_price_at=?,last_price=?,error=NULL,error_at=NULL WHERE id=?')
          .run(now.toISOString(),next.shadowClosed?'triggered':'tracking',JSON.stringify(next),at,price.priceUsd,id);
        this.db.prepare('INSERT OR REPLACE INTO exit_shadow_meta VALUES (?,?)').run('last_sample_at',
          [this.meta('last_sample_at')??'',at].sort().at(-1)!);
        this.db.prepare("DELETE FROM exit_shadow_meta WHERE key='last_error'").run();
        this.db.exec('COMMIT');this.lastError=undefined;
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }catch(error){this.fail(error instanceof Error&&/^EXIT_SHADOW_[A-Z_]+$/.test(error.message)?error.message:'EXIT_SHADOW_WRITE_FAILED');}
  }

  recordError(value:ScanToken,reason:string,now=this.now()):void {
    const target=identity(value);if(!target)return;
    if(!Number.isFinite(now.getTime())||now.getTime()>this.now().getTime())return;
    const row=this.current(target);if(!row||row.phase==='ended'||Date.parse(row.ends_at)<=now.getTime())return;
    if(now.getTime()<Date.parse(row.last_price_at)||row.error_at&&now.getTime()<=Date.parse(row.error_at))return;
    try {
      if(this.bytes()+16384>this.maxBytes)this.fail('EXIT_SHADOW_CAPACITY_REACHED');
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('UPDATE exit_shadow_positions SET error=?,error_at=?,updated_at=? WHERE id=?')
        .run(code(reason),now.toISOString(),now.toISOString(),row.id);
      if(!row.error)this.db.prepare('INSERT INTO exit_shadow_events(position_id,at,data) VALUES (?,?,?)').run(row.id,now.toISOString(),
        JSON.stringify({at:now.toISOString(),kind:'price_unavailable',reason:code(reason),observationOnly:true}));
      this.db.exec('COMMIT');
    }catch(error) {try {this.db.exec('ROLLBACK');}catch{}
      this.fail(error instanceof Error&&error.message==='EXIT_SHADOW_CAPACITY_REACHED'?error.message:'EXIT_SHADOW_WRITE_FAILED');}
  }

  summary(now=this.now()) {
    const rows=this.db.prepare('SELECT * FROM exit_shadow_positions ORDER BY started_at DESC,id LIMIT ?').all(this.maxPositions) as unknown as ShadowRow[];
    const active=rows.filter(x=>x.phase==='tracking'&&Date.parse(x.ends_at)>now.getTime());
    return {enabled:true,mode:'shadow' as const,liveReady:false,policyVersion:ADAPTIVE_SHADOW_V1.version,
      status:{positions:rows.length,active:active.length,triggered:rows.filter(x=>x.phase==='triggered').length,
        stale:active.filter(x=>!!x.error||now.getTime()-Date.parse(x.last_price_at)>this.staleMs).length,
        samples:Number(this.db.prepare('SELECT count(*) AS n FROM exit_shadow_samples').get()!.n),
        events:Number(this.db.prepare('SELECT count(*) AS n FROM exit_shadow_events').get()!.n),
        startedAt:this.meta('started_at'),lastSampleAt:this.meta('last_sample_at'),lastError:this.lastError??this.meta('last_error'),
        maxBytes:this.maxBytes,bytes:this.bytes(),historyComplete:this.meta('history_complete')==='true',
        staleAfterSec:this.staleMs/1000,execution:'observation_only',liveBlockReason:'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED'}};
  }
  list(limit=50,now=this.now()) {
    const take=Number.isSafeInteger(limit)?Math.max(1,Math.min(100,limit)):50;
    const rows=this.db.prepare('SELECT * FROM exit_shadow_positions ORDER BY started_at DESC,id LIMIT ?').all(take) as unknown as ShadowRow[];
    return {...this.summary(now),items:rows.map(row=>this.project(row,now)),limit:take};
  }
  detail(id:string,now=this.now()) {
    const row=this.db.prepare('SELECT * FROM exit_shadow_positions WHERE id=?').get(id) as unknown as ShadowRow|undefined;
    if(!row)return;
    const samples=this.db.prepare('SELECT at,price AS priceUsd,source,context FROM exit_shadow_samples WHERE position_id=? ORDER BY at LIMIT 2000').all(id);
    const count=Number(this.db.prepare('SELECT count(*) AS n FROM exit_shadow_samples WHERE position_id=?').get(id)!.n);
    return {item:this.project(row,now),samples:samples.map(r=>({...r,context:JSON.parse(String(r.context))})),sampleCount:count,
      responseTruncated:count>samples.length,storedSamplesThinned:false,mode:'shadow',liveReady:false};
  }
  close():void {this.db.close();}
  private project(row:ShadowRow,now:Date) {
    const state=JSON.parse(row.state) as AdaptiveExitState;
    const events=this.db.prepare('SELECT data FROM exit_shadow_events WHERE position_id=? ORDER BY id DESC LIMIT 5').all(row.id).map(x=>JSON.parse(String(x.data)) as ShadowEvent);
    const pressure=state.walletPressure;
    const rawPeak=Number(this.db.prepare('SELECT MAX(price) AS peak FROM exit_shadow_samples WHERE position_id=?').get(row.id)!.peak);
    const rawGap=this.db.prepare("SELECT MAX(json_extract(context,'$.gapSec')) AS gap FROM exit_shadow_samples WHERE position_id=?").get(row.id)!.gap;
    return {id:row.id,chain:row.chain,address:row.address,symbol:row.symbol??undefined,candidateId:row.candidate_id,
      eligibleAt:row.eligible_at,startedAt:row.started_at,updatedAt:row.updated_at,endsAt:row.ends_at,
      phase:row.phase==='triggered'?'triggered':Date.parse(row.ends_at)<=now.getTime()?'ended':row.phase,
      health:row.error?'unavailable':now.getTime()-Date.parse(row.last_price_at)>this.staleMs?'stale':'fresh',
      lastPriceAt:row.last_price_at,maxGapSec:Number(rawGap??0),baselinePriceUsd:state.baselinePriceUsd,
      latestPriceUsd:row.last_price,peakPriceUsd:rawPeak,gainPct:(row.last_price/state.baselinePriceUsd-1)*100,
      peakGainPct:(rawPeak/state.baselinePriceUsd-1)*100,triggerPeakGainPct:(state.peakPriceUsd/state.baselinePriceUsd-1)*100,
      protectionPriceUsd:state.protectionPriceUsd,
      protectionGainPct:(state.protectionPriceUsd/state.baselinePriceUsd-1)*100,activationGainPct:state.activationGainPct,
      protectionActive:state.protectionActive,trailPct:state.drawdownPct,remainingPct:state.remainingPctOfInitial,
      pressure:pressure?{status:'observed',tradeCount:pressure.evidenceCount,netSellRatio:pressure.netSellRatio,
        source:pressure.sources.join(', '),evidenceIds:pressure.evidenceIds,verification:pressure.verification}:{status:'unknown'},
      events,lastEvent:state.shadowClosed?this.lastExitEvent(row.id)??events[0]:events[0],lastError:row.error??undefined,mode:'shadow',liveReady:false};
  }
  private lastExitEvent(id:string):ShadowEvent|undefined {
    const row=this.db.prepare("SELECT data FROM exit_shadow_events WHERE position_id=? AND json_extract(data,'$.kind')='full_exit' ORDER BY id DESC LIMIT 1").get(id);
    return row?JSON.parse(String(row.data)) as ShadowEvent:undefined;
  }
  private current(value:ScanToken):ShadowRow|undefined {
    return this.db.prepare('SELECT * FROM exit_shadow_positions WHERE chain=? AND address=? ORDER BY started_at DESC,id LIMIT 1')
      .get(value.chain,value.address) as unknown as ShadowRow|undefined;
  }
  private meta(key:string):string|undefined {const row=this.db.prepare('SELECT value FROM exit_shadow_meta WHERE key=?').get(key);return row?String(row.value):undefined;}
  private bytes():number {
    if(this.path===':memory:')return Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    return [this.path,this.path+'-wal'].reduce((sum,path)=>{try{return sum+statSync(path).size;}catch{return sum;}},0);
  }
  private fail(reason:string):never {
    this.lastError=reason;
    try {this.db.prepare('INSERT OR REPLACE INTO exit_shadow_meta VALUES (?,?)').run('last_error',reason);
      this.db.prepare('INSERT OR REPLACE INTO exit_shadow_meta VALUES (?,?)').run('history_complete','false');}catch{}
    throw new Error(reason);
  }
}
