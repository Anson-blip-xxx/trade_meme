import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import bs58 from 'bs58';
import {createHash} from 'node:crypto';
import type {Chain,Signal,Report,Status} from './types.js';
import {fetchDebotSignalPage,DebotSignalError,type DebotSignalObservation,type DebotWalletDetails} from './providers/debot-signals.js';

type Page=Awaited<ReturnType<typeof fetchDebotSignalPage>>;
interface Cycle {
  startedAt:string;completedAt:string;requests:number;received:number;added:number;errors:number;
  reasons:string[];diagnostics:{chain:Chain;status:'ok'|'unavailable'|'rate_limited'|'auth_required'|'invalid_response';received:number;reason?:string}[];
}
export interface DebotScannerOptions {
  database:string;chains:Chain[];intervalSec?:number;maxAgeSec:number;
  mode?:'anonymous_poll'|'authenticated_stream';
  onSignal:(signal:Signal,observedAt:string,context?:{detailsReady:Promise<void>})=>Promise<unknown>;shouldDefer?:()=>string|undefined;
  maxConcurrent?:number;parallelDetails?:boolean;
  fetchPage?:(chain:Chain)=>Promise<Page>;now?:()=>Date;
  fetchDetails?:(observation:DebotSignalObservation)=>Promise<DebotWalletDetails>;
}
export interface DebotRiskProgress {
  stage:'safety'|'provenance'|'wallets'|'market'|'narrative';checkedAt:string;elapsedMs:number;status:Status;reasons:string[];
}
const reasonCodes=(value:unknown)=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(v)).slice(0,24):[];
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function walletAddress(value:unknown,chain:Chain):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-fA-F]{40}$/.test(value)&&!/^0x0{40}$/i.test(value)?value.toLowerCase():undefined;
  if(value.length<32||value.length>44||value==='11111111111111111111111111111111')return;
  try {if(bs58.decode(value).length===32)return value;}catch {/* Invalid base58 cannot identify a wallet. */}
}
function persistReason(error:unknown):string {
  return error instanceof Error&&(error.message==='DEBOT_SIGNAL_STORE_FULL'||
    ('errcode' in error&&error.errcode===13))?'DEBOT_SIGNAL_STORE_FULL':'DEBOT_SIGNAL_PERSIST_FAILED';
}
/** Read-only collection. Durable, bounded inbox; no credentials or raw responses. */
export class DebotScanner {
  private readonly db:DatabaseSync;
  private readonly now:()=>Date;
  private readonly intervalSec:number;
  private readonly chains:Chain[];
  private running=false;
  private stopped=false;
  private generation=0;
  private cursor=0;
  private timer?:ReturnType<typeof setTimeout>;
  private dispatchTimer?:ReturnType<typeof setTimeout>;
  private collecting?:Promise<void>;
  private dispatching?:Promise<void>;
  private readonly workers=new Set<Promise<void>>();
  private lastCycle?:Cycle;
  private lastError?:string;
  private deferredReason?:string;
  private cooldownUntil=0;
  private nextDispatchAt=0;
  private closed=false;

  constructor(private readonly options:DebotScannerOptions) {
    this.now=options.now??(()=>new Date());this.intervalSec=options.intervalSec??30;
    this.chains=[...new Set(options.chains)];
    if(!this.chains.length||this.chains.some(c=>!['bsc','solana','robinhood'].includes(c))||
      !Number.isInteger(this.intervalSec)||this.intervalSec<15||this.intervalSec>3600||
      !Number.isInteger(options.maxAgeSec)||options.maxAgeSec<10||options.maxAgeSec>86400||
      options.maxConcurrent!==undefined&&![1,2].includes(options.maxConcurrent))
      throw new Error('DEBOT_SCANNER_CONFIG_INVALID');
    if(options.database!==':memory:')mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.database);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2500;
      PRAGMA max_page_count=16384;
      CREATE TABLE IF NOT EXISTS debot_signals (
        id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL, occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT,
        dispatched_at TEXT, completed_at TEXT,details TEXT,details_error TEXT
      );
      CREATE INDEX IF NOT EXISTS debot_signals_queue ON debot_signals(state,occurred_at);
      CREATE INDEX IF NOT EXISTS debot_signals_observed ON debot_signals(observed_at);
      UPDATE debot_signals SET state='interrupted',reason='DEBOT_SIGNAL_INTERRUPTED' WHERE state='dispatching';`);
    const columns=new Set(this.db.prepare('PRAGMA table_info(debot_signals)').all().map(row=>String(row.name)));
    if(!columns.has('details'))this.db.exec('ALTER TABLE debot_signals ADD COLUMN details TEXT');
    if(!columns.has('details_error'))this.db.exec('ALTER TABLE debot_signals ADD COLUMN details_error TEXT');
    for(const column of ['report_id','progress','verdict','dedup_key'])if(!columns.has(column))this.db.exec(`ALTER TABLE debot_signals ADD COLUMN ${column} TEXT`);
    this.db.exec('CREATE INDEX IF NOT EXISTS debot_signals_dedup ON debot_signals(dedup_key)');
    if(options.database!==':memory:')chmodSync(options.database,0o600);
    // A claimed event is never silently replayed after a crash. Its incomplete
    // analysis remains visible instead of creating another signal/order attempt.
    const prior=this.db.prepare('SELECT max(dispatched_at) AS at FROM debot_signals').get() as {at:string|null};
    if(prior.at)this.nextDispatchAt=Date.parse(prior.at)+this.dispatchIntervalMs();
  }

  bindReport(eventId:string,reportId:string):void {
    if(this.closed||!/^[0-9a-f-]{36}$/.test(reportId))return;
    this.db.prepare("UPDATE debot_signals SET report_id=? WHERE id=? AND state='dispatching'").run(reportId,eventId);
  }
  recordProgress(eventId:string,progress:DebotRiskProgress):void {
    if(this.closed||!['safety','provenance','market','wallets','narrative'].includes(progress.stage)||
      !['pass','fail','unknown'].includes(progress.status)||!Number.isFinite(Date.parse(progress.checkedAt))||
      !Number.isFinite(progress.elapsedMs)||progress.elapsedMs<0||progress.elapsedMs>600_000)return;
    const row=this.db.prepare("SELECT progress FROM debot_signals WHERE id=? AND state='dispatching'").get(eventId) as {progress:string|null}|undefined;
    if(!row)return;
    const checks=row.progress?JSON.parse(row.progress):{};
    const previous=checks[progress.stage];
    checks[progress.stage]={status:progress.status,reasons:reasonCodes(progress.reasons),checkedAt:progress.checkedAt,
      firstResultMs:previous?.firstResultMs??Math.round(progress.elapsedMs),elapsedMs:Math.round(progress.elapsedMs)};
    this.db.prepare("UPDATE debot_signals SET progress=? WHERE id=? AND state='dispatching'").run(JSON.stringify(checks),eventId);
  }
  recordReport(eventId:string,report:Report):void {
    if(this.closed)return;
    const row=this.db.prepare("SELECT chain,address,dispatched_at,progress FROM debot_signals WHERE id=? AND state='dispatching'").get(eventId) as {chain:Chain;address:string;dispatched_at:string;progress:string|null}|undefined;
    if(!row||report.signal.sourceEventId!==eventId||report.signal.token.chain!==row.chain||report.signal.token.address!==row.address)return;
    const checks={safety:report.safety,provenance:report.provenance,market:report.marketRisk,wallets:report.flow,narrative:report.narrative};
    const previous=row.progress?JSON.parse(row.progress):{};
    for(const [stage,check] of Object.entries(checks))if(check){
      const prior=previous[stage];
      // Final publication must not replace an unchanged early result's actual latency with the full evaluation duration.
      if(prior?.status===check.status&&prior.checkedAt===check.checkedAt&&JSON.stringify(prior.reasons)===JSON.stringify(reasonCodes(check.reasons)))continue;
      this.recordProgress(eventId,{stage:stage as DebotRiskProgress['stage'],status:check.status,reasons:check.reasons,
        checkedAt:check.checkedAt,elapsedMs:Math.max(0,Date.parse(report.evaluatedAt)-Date.parse(row.dispatched_at))});
    }
    this.db.prepare("UPDATE debot_signals SET verdict=? WHERE id=? AND state='dispatching'").run(JSON.stringify({decision:report.decision,
      buyEligible:report.buyEligible,validUntil:report.validUntil,reasons:reasonCodes(report.reasons)}),eventId);
  }
  recent(limit=12) {
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('DEBOT_SIGNAL_LIMIT_INVALID');
    const now=this.now();
    const rows=this.db.prepare(`SELECT id,report_id,chain,address,occurred_at,observed_at,state,reason,dispatched_at,completed_at,progress,verdict
      FROM debot_signals WHERE reason IS NULL OR reason NOT IN ('DEBOT_SIGNAL_STALE','DEBOT_DUPLICATE_TOKEN_ALERT')
      ORDER BY observed_at DESC LIMIT ?`).all(limit);
    return {now:now.toISOString(),items:rows.map(row=>{
      const receivedAt=String(row.observed_at),startedAt=row.dispatched_at?String(row.dispatched_at):undefined;
      const endedAt=row.completed_at?String(row.completed_at):row.state==='dispatching'?now.toISOString():undefined;
      const verdict=row.verdict?JSON.parse(String(row.verdict)):{};
      return {eventId:String(row.id),reportId:row.report_id??undefined,chain:row.chain,address:row.address,
        occurredAt:row.occurred_at,receivedAt,state:row.state,startedAt,completedAt:row.completed_at??undefined,
        signalDelayMs:Date.parse(receivedAt)-Date.parse(String(row.occurred_at)),
        queueMs:startedAt?Math.max(0,Date.parse(startedAt)-Date.parse(receivedAt)):undefined,
        analysisMs:startedAt&&endedAt?Math.max(0,Date.parse(endedAt)-Date.parse(startedAt)):undefined,
        ...verdict,buyEligible:row.state==='completed'&&verdict.buyEligible===true&&Date.parse(verdict.validUntil)>now.getTime(),
        reasons:[...reasonCodes(verdict.reasons),...reasonCodes(row.reason?[row.reason]:[])],checks:row.progress?JSON.parse(String(row.progress)):{}};
    })};
  }
  private dispatchIntervalMs():number {return this.options.mode==='authenticated_stream'?0:60_000;}
  private maxAgeSec():number {return this.options.mode==='authenticated_stream'?Math.min(120,this.options.maxAgeSec):this.options.maxAgeSec;}

  getStatus() {
    const rows=this.db.prepare('SELECT state,count(*) AS n FROM debot_signals GROUP BY state').all() as {state:string;n:number}[];
    const counts=Object.fromEntries(rows.map(row=>[row.state,Number(row.n)]));
    const latest=this.db.prepare('SELECT max(observed_at) AS at FROM debot_signals').get() as {at:string|null};
    const detailStats=this.db.prepare('SELECT count(details) AS received,count(details_error) AS failed FROM debot_signals').get() as {received:number;failed:number};
    const latestDispatch=this.db.prepare('SELECT observed_at,dispatched_at FROM debot_signals WHERE dispatched_at IS NOT NULL ORDER BY dispatched_at DESC LIMIT 1').get() as {observed_at:string;dispatched_at:string}|undefined;
    return {enabled:true,running:this.running,inFlight:!!this.collecting||!!this.dispatching,mode:this.options.mode??'anonymous_poll',
      intervalSec:this.intervalSec,stored:rows.reduce((n,r)=>n+Number(r.n),0),pending:(counts.pending??0)+(counts.dispatching??0),
      dispatched:counts.completed??0,ignored:counts.ignored??0,failed:counts.failed??0,interrupted:counts.interrupted??0,
      lastObservedAt:latest.at??undefined,lastCycle:this.lastCycle?structuredClone(this.lastCycle):undefined,
      lastError:this.lastError,deferredReason:this.deferredReason,
      detailsReceived:Number(detailStats.received),detailsFailed:Number(detailStats.failed),
      lastAnalysisQueueDelayMs:latestDispatch?Math.max(0,Date.parse(latestDispatch.dispatched_at)-Date.parse(latestDispatch.observed_at)):undefined,
      cooldownUntil:this.cooldownUntil>this.now().getTime()?new Date(this.cooldownUntil).toISOString():undefined};
  }

  start():void {
    if(this.running||this.closed)return;
    this.running=true;this.stopped=false;
    if(this.options.mode!=='authenticated_stream')this.collectTick();
    this.dispatchTick();
  }

  /** Socket callbacks persist immediately; slow research never blocks the subscription. */
  acceptPage(page:Page):void {
    if(this.stopped||this.closed)return;
    if(page.reason&&page.reason!=='DEBOT_SIGNAL_RECORDS_REJECTED')throw new Error('DEBOT_SIGNAL_RESPONSE_INVALID');
    try {for(const observation of page.observations)this.record(observation);}
    catch(error){this.lastError=persistReason(error);throw new Error(this.lastError);}
    finally {if(this.running)void this.dispatchOnce();}
  }

  vendorWalletTargets(signal:Signal) {
    if(this.closed||signal.source!=='debot'||!this.chains.includes(signal.token.chain))return;
    const tokenAddress=walletAddress(signal.token.address,signal.token.chain);
    if(!tokenAddress)return;
    const row=this.db.prepare('SELECT chain,address,details FROM debot_signals WHERE id=?').get(signal.sourceEventId) as {chain:Chain;address:string;details:string|null}|undefined;
    if(!row?.details||row.details.length>64_000||row.chain!==signal.token.chain||walletAddress(row.address,row.chain)!==tokenAddress)return;
    let details:unknown;try{details=JSON.parse(row.details);}catch{return;}
    if(!object(details)||typeof details.fetchedAt!=='string'||!Array.isArray(details.vendorWallets)||details.vendorWallets.length>20||
      (details.reason!==undefined&&details.reason!=='DEBOT_SIGNAL_RECORDS_REJECTED'))return;
    const checkedAt=Date.parse(details.fetchedAt),now=this.now().getTime();
    if(!Number.isFinite(checkedAt)||checkedAt>now||now-checkedAt>120_000)return;
    const addresses:string[]=[];
    for(const wallet of details.vendorWallets) {
      if(!object(wallet)||wallet.source!=='debot'||wallet.verification!=='vendor_report')continue;
      const address=walletAddress(wallet.address,row.chain);
      if(address&&!addresses.includes(address))addresses.push(address);
      if(addresses.length===3)break;
    }
    if(!addresses.length)return;
    return {provider:'debot' as const,token:{chain:row.chain,address:tokenAddress},checkedAt:new Date(checkedAt).toISOString(),addresses};
  }

  runOnce():Promise<void> {
    if(this.collecting)return this.collecting;
    if(this.stopped||this.closed)return Promise.resolve();
    // Authenticated catch-up is permitted only through the caller's session-aware reader.
    if(this.options.mode==='authenticated_stream'&&!this.options.fetchPage)return Promise.resolve();
    const generation=this.generation;
    const work=Promise.resolve().then(()=>this.collect(generation)).catch(()=>{this.lastError='DEBOT_SIGNAL_PERSIST_FAILED';})
      .finally(()=>{if(this.collecting===work)this.collecting=undefined;
        if(this.running&&this.options.mode==='authenticated_stream')void this.dispatchOnce();});
    this.collecting=work;return work;
  }

  dispatchOnce():Promise<void> {
    const concurrency=this.options.mode==='authenticated_stream'?(this.options.maxConcurrent??1):1;
    if(this.workers.size>=concurrency&&this.dispatching)return this.dispatching;
    if(this.stopped||this.closed)return Promise.resolve();
    const generation=this.generation;
    for(let slot=this.workers.size;slot<concurrency;slot++){
      const worker=Promise.resolve().then(async()=>{
      // Drain arrivals behind an active analysis without a one-second delay per event.
      // A bounded turn yields to timers and shutdown even for synchronous callbacks.
      const limit=this.options.mode==='authenticated_stream'?20:1;
      for(let i=0;i<limit&&!this.interrupted(generation);i++)if(!await this.dispatch(generation))break;
      }).catch(()=>{this.lastError='DEBOT_SIGNAL_DISPATCH_FAILED';}).finally(()=>this.workers.delete(worker));
      this.workers.add(worker);
    }
    const work=Promise.all([...this.workers]).then(()=>{}).finally(()=>{if(this.dispatching===work)this.dispatching=undefined;});
    this.dispatching=work;return work;
  }

  async stop():Promise<void> {
    this.running=false;this.stopped=true;this.generation++;
    clearTimeout(this.timer);clearTimeout(this.dispatchTimer);
    await Promise.all([this.collecting,...this.workers]);
  }

  async close():Promise<void> {
    if(this.closed)return;
    await this.stop();this.closed=true;this.db.close();
  }

  private collectTick():void {
    if(!this.running)return;
    const generation=this.generation;
    void this.runOnce().finally(()=>{
      if(!this.running||generation!==this.generation)return;
      this.timer=setTimeout(()=>this.collectTick(),Math.max(this.intervalSec*1000,this.cooldownUntil-this.now().getTime()));
      this.timer.unref();
    });
  }
  private dispatchTick():void {
    if(!this.running)return;
    const generation=this.generation;
    void this.dispatchOnce().finally(()=>{
      if(!this.running||generation!==this.generation)return;
      this.dispatchTimer=setTimeout(()=>this.dispatchTick(),this.options.mode==='authenticated_stream'?1000:10_000);this.dispatchTimer.unref();
    });
  }
  private interrupted(generation:number):boolean {return this.stopped||generation!==this.generation;}

  private async collect(generation:number):Promise<void> {
    if(this.interrupted(generation)||this.cooldownUntil>this.now().getTime())return;
    const at=this.now().toISOString();
    const cycle:Cycle={startedAt:at,completedAt:at,requests:0,received:0,added:0,errors:0,reasons:[],diagnostics:[]};
    this.lastError=undefined;
    // Thirty-day retention, 10k events, and SQLite's 64 MiB hard page ceiling.
    this.db.prepare("DELETE FROM debot_signals WHERE state NOT IN ('pending','dispatching') AND observed_at<?")
      .run(new Date(this.now().getTime()-30*86400_000).toISOString());
    this.expire();
    const offset=this.cursor++%this.chains.length;
    for(let i=0;i<this.chains.length&&!this.interrupted(generation);i++) {
      const chain=this.chains[(offset+i)%this.chains.length];
      try {
        cycle.requests++;
        const page=await (this.options.fetchPage??(c=>fetchDebotSignalPage(c)))(chain);
        if(this.interrupted(generation))break;
        cycle.received+=page.received;
        if(page.reason) {
          cycle.errors++;cycle.reasons.push(page.reason);
          this.lastError=page.reason;
          cycle.diagnostics.push({chain,status:'invalid_response',received:page.received,reason:page.reason});
          if(page.reason!=='DEBOT_SIGNAL_RECORDS_REJECTED')continue;
        }
        for(const observation of page.observations)cycle.added+=this.record(observation);
        if(!page.reason)cycle.diagnostics.push({chain,status:'ok',received:page.received});
      } catch(error) {
        const reason=error instanceof DebotSignalError?error.reason:
          error instanceof Error&&error.message==='DEBOT_SIGNAL_STORE_FULL'?error.message:'DEBOT_SIGNAL_COLLECTION_FAILED';
        cycle.errors++;cycle.reasons.push(reason);this.lastError=reason;
        const limited=reason==='DEBOT_SIGNAL_HTTP_429',auth=reason==='DEBOT_SIGNAL_HTTP_401'||reason==='DEBOT_SIGNAL_HTTP_403';
        cycle.diagnostics.push({chain,status:limited?'rate_limited':auth?'auth_required':'unavailable',received:0,reason});
        if(limited||auth) {
          this.cooldownUntil=Math.max(this.now().getTime()+(auth?300_000:60_000),
            error instanceof DebotSignalError?error.cooldownUntil??0:0);break;
        }
      }
    }
    cycle.reasons=[...new Set(cycle.reasons)];cycle.completedAt=this.now().toISOString();this.lastCycle=cycle;
  }

  private record(observation:DebotSignalObservation):number {
    const signal=observation.signal;
    if(!this.chains.includes(signal.token.chain))return 0;
    if(this.db.prepare('SELECT 1 FROM debot_signals WHERE id=?').get(signal.sourceEventId))return 0;
    const count=this.db.prepare('SELECT count(*) AS n FROM debot_signals').get() as {n:number};
    if(count.n>=10_000) {
      // Preserve a recent deduplication horizon even when traffic exceeds capacity.
      const oldest=this.db.prepare("SELECT id FROM debot_signals WHERE state NOT IN ('pending','dispatching') AND observed_at<? ORDER BY observed_at LIMIT 1")
        .get(new Date(this.now().getTime()-86400_000).toISOString()) as {id:string}|undefined;
      if(!oldest)throw new Error('DEBOT_SIGNAL_STORE_FULL');
      this.db.prepare('DELETE FROM debot_signals WHERE id=?').run(oldest.id);
    }
    const stale=Date.parse(signal.occurredAt)<this.now().getTime()-this.maxAgeSec()*1000;
    const dedupKey=createHash('sha256').update(JSON.stringify([signal.token,signal.occurredAt,observation.walletCount,observation.addressCount,
      [...observation.aliases].sort(),observation.averageWalletVolumeUsd,observation.vendorWallets])).digest('hex');
    const duplicate=this.options.mode==='authenticated_stream'&&!!this.db.prepare('SELECT 1 FROM debot_signals WHERE dedup_key=?').get(dedupKey);
    this.db.prepare('INSERT INTO debot_signals(id,chain,address,occurred_at,observed_at,state,payload,reason,dedup_key) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(signal.sourceEventId,signal.token.chain,signal.token.address,signal.occurredAt,observation.observedAt,
        stale||duplicate?'ignored':'pending',JSON.stringify(observation),stale?'DEBOT_SIGNAL_STALE':duplicate?'DEBOT_DUPLICATE_TOKEN_ALERT':null,dedupKey);
    return 1;
  }

  private expire():void {
    this.db.prepare("UPDATE debot_signals SET state='ignored',reason='DEBOT_SIGNAL_STALE' WHERE state='pending' AND occurred_at<?")
      .run(new Date(this.now().getTime()-this.maxAgeSec()*1000).toISOString());
  }

  private async dispatch(generation:number):Promise<boolean> {
    if(this.interrupted(generation))return false;
    this.expire();this.deferredReason=undefined;
    if(this.nextDispatchAt>this.now().getTime())return false;
    this.deferredReason=this.options.shouldDefer?.();
    if(this.deferredReason)return false;
    const row=this.db.prepare(`SELECT id,payload FROM debot_signals p WHERE state='pending'
      AND NOT EXISTS (SELECT 1 FROM debot_signals a WHERE a.state='dispatching' AND a.chain=p.chain AND a.address=p.address)
      ORDER BY occurred_at DESC,id LIMIT 1`)
      .get() as {id:string;payload:string}|undefined;
    if(!row)return false;
    const observation=JSON.parse(row.payload) as DebotSignalObservation;
    const at=this.now().toISOString();
    const changed=this.db.prepare("UPDATE debot_signals SET state='dispatching',dispatched_at=? WHERE id=? AND state='pending'")
      .run(at,row.id);
    if(!changed.changes)return false;
    this.nextDispatchAt=this.now().getTime()+this.dispatchIntervalMs();
    const detailsReady=(async()=>{
      if(this.options.fetchDetails){
        try {
          const details=await this.options.fetchDetails(observation);
          this.db.prepare('UPDATE debot_signals SET details=?,details_error=? WHERE id=?')
            .run(JSON.stringify(details),details.reason??null,row.id);
        }catch {this.db.prepare("UPDATE debot_signals SET details_error='DEBOT_DETAILS_UNAVAILABLE' WHERE id=?").run(row.id);}
      }
    })();
    try {
      if(!this.options.parallelDetails)await detailsReady;
      if(this.interrupted(generation)) {
        this.db.prepare("UPDATE debot_signals SET state='interrupted',reason='DEBOT_SIGNAL_INTERRUPTED',completed_at=? WHERE id=?")
          .run(this.now().toISOString(),row.id);return false;
      }
      if(Date.parse(observation.signal.occurredAt)<this.now().getTime()-this.maxAgeSec()*1000) {
        this.db.prepare("UPDATE debot_signals SET state='ignored',reason='DEBOT_SIGNAL_STALE' WHERE id=?").run(row.id);return true;
      }
      await this.options.onSignal(observation.signal,observation.observedAt,{detailsReady});
      this.db.prepare("UPDATE debot_signals SET state='completed',completed_at=? WHERE id=?")
        .run(this.now().toISOString(),row.id);
    } catch {
      this.db.prepare("UPDATE debot_signals SET state='failed',reason='DEBOT_SIGNAL_DISPATCH_FAILED',completed_at=? WHERE id=?")
        .run(this.now().toISOString(),row.id);
      this.lastError='DEBOT_SIGNAL_DISPATCH_FAILED';
    }finally{await detailsReady;}
    return true;
  }
}
