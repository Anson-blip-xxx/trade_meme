import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import bs58 from 'bs58';
import {createHash} from 'node:crypto';
import type {Chain,Signal,Report,Status} from './types.js';
import {fetchDebotSignalPage,DebotSignalError,type DebotSignalObservation,type DebotWalletDetails} from './providers/debot-signals.js';
import {tokenDisplayText} from './token-display.js';
import {scoreDebotRisk} from './debot-risk-score.js';
import {DebotNotificationLedger} from './debot-notification-ledger.js';
import {assessDebotRepeatEvidence,type DebotRepeatEvidence,type DebotRepeatEvidenceInput,type DebotScopedWalletDetails} from './debot-repeat-evidence.js';
import {promoteDebotRiskUpdates} from './debot-repeat-scheduler.js';
import {VendorPerformanceLedger} from './vendor-performance-ledger.js';

type Page=Awaited<ReturnType<typeof fetchDebotSignalPage>>;
interface Cycle {
  startedAt:string;completedAt:string;requests:number;received:number;added:number;errors:number;
  reasons:string[];diagnostics:{chain:Chain;status:'ok'|'unavailable'|'rate_limited'|'auth_required'|'invalid_response';received:number;reason?:string}[];
}
export interface DebotScannerOptions {
  database:string;chains:Chain[];intervalSec?:number;maxAgeSec:number;maxBytes?:number;
  mode?:'anonymous_poll'|'authenticated_stream';
  onSignal:(signal:Signal,observedAt:string,context?:{detailsReady:Promise<void>;repeat?:boolean})=>Promise<unknown>;shouldDefer?:()=>string|undefined;
  repeatCooldownSec?:number;
  onObservation?:(observation:DebotSignalObservation)=>void;
  repeatEvidence?:(input:DebotRepeatEvidenceInput,signal:Signal)=>DebotRepeatEvidence;
  maxConcurrent?:number;parallelDetails?:boolean;
  lookupDisplay?:(reportId:string)=>{chain:Chain;address:string;name?:string;symbol?:string}|undefined;
  fetchPage?:(chain:Chain)=>Promise<Page>;now?:()=>Date;
  fetchDetails?:(observation:DebotSignalObservation)=>Promise<DebotWalletDetails>;
}
export interface DebotRiskProgress {
  stage:'safety'|'provenance'|'wallets'|'market'|'narrative';checkedAt:string;elapsedMs:number;status:Status;reasons:string[];
}
export interface DebotSignalListOptions {
  limit?:number;offset?:number;chain?:Chain;state?:string;asOf?:string;
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
  private readonly maxBytes:number;
  private readonly pageSize:number;
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
  private readonly notifications:DebotNotificationLedger;
  private nextRiskCheckAt=0;
  private readonly performance:VendorPerformanceLedger;private vendorPerformanceError?:string;

  constructor(private readonly options:DebotScannerOptions) {
    this.now=options.now??(()=>new Date());this.intervalSec=options.intervalSec??30;
    this.chains=[...new Set(options.chains)];this.maxBytes=options.maxBytes??64*1024*1024;
    if(!this.chains.length||this.chains.some(c=>!['bsc','solana','robinhood'].includes(c))||
      !Number.isSafeInteger(this.maxBytes)||this.maxBytes<1024*1024||
      !Number.isInteger(this.intervalSec)||this.intervalSec<15||this.intervalSec>3600||
      !Number.isInteger(options.maxAgeSec)||options.maxAgeSec<10||options.maxAgeSec>86400||
      options.maxConcurrent!==undefined&&![1,2].includes(options.maxConcurrent)||
      options.repeatCooldownSec!==undefined&&(!Number.isInteger(options.repeatCooldownSec)||options.repeatCooldownSec<0||options.repeatCooldownSec>300))
      throw new Error('DEBOT_SCANNER_CONFIG_INVALID');
    if(options.database!==':memory:')mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.database);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2500;');
    this.pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    this.db.exec(`PRAGMA max_page_count=${Math.floor(this.maxBytes/this.pageSize)};
      CREATE TABLE IF NOT EXISTS debot_signals (
        id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL, occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT,
        dispatched_at TEXT, completed_at TEXT,details TEXT,details_error TEXT
      );
      CREATE INDEX IF NOT EXISTS debot_signals_queue ON debot_signals(state,occurred_at);
      CREATE INDEX IF NOT EXISTS debot_signals_observed ON debot_signals(observed_at);
      CREATE TABLE IF NOT EXISTS review_retention_watermarks(source TEXT PRIMARY KEY,pruned_through TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS debot_review_retention AFTER DELETE ON debot_signals BEGIN
        INSERT INTO review_retention_watermarks(source,pruned_through) VALUES('debot',OLD.observed_at)
          ON CONFLICT(source) DO UPDATE SET pruned_through=MAX(pruned_through,excluded.pruned_through);
      END;
      UPDATE debot_signals SET state='interrupted',reason='DEBOT_SIGNAL_INTERRUPTED' WHERE state='dispatching';`);
    const columns=new Set(this.db.prepare('PRAGMA table_info(debot_signals)').all().map(row=>String(row.name)));
    if(!columns.has('details'))this.db.exec('ALTER TABLE debot_signals ADD COLUMN details TEXT');
    if(!columns.has('details_error'))this.db.exec('ALTER TABLE debot_signals ADD COLUMN details_error TEXT');
    for(const column of ['report_id','progress','verdict','dedup_key','token_name','token_symbol'])if(!columns.has(column))this.db.exec(`ALTER TABLE debot_signals ADD COLUMN ${column} TEXT`);
    this.db.exec('CREATE INDEX IF NOT EXISTS debot_signals_dedup ON debot_signals(dedup_key)');
    this.db.exec('CREATE INDEX IF NOT EXISTS debot_signals_token ON debot_signals(chain,address)');
    for(const column of ['notification_key','hint_kind','review_after','probed_at','evidence_cutoff_at','merged_payloads','risk_checked_at','analysis_occurred_at','review_wallets'])
      if(!columns.has(column))this.db.exec(`ALTER TABLE debot_signals ADD COLUMN ${column} TEXT`);
    if(!columns.has('review_priority'))this.db.exec('ALTER TABLE debot_signals ADD COLUMN review_priority INTEGER NOT NULL DEFAULT 0');
    if(!columns.has('merged_truncated'))this.db.exec('ALTER TABLE debot_signals ADD COLUMN merged_truncated INTEGER NOT NULL DEFAULT 0');
    if(!columns.has('analyzed'))this.db.exec("ALTER TABLE debot_signals ADD COLUMN analyzed INTEGER NOT NULL DEFAULT 0; UPDATE debot_signals SET analyzed=1 WHERE state='completed' AND dispatched_at IS NOT NULL");
    this.db.exec('CREATE INDEX IF NOT EXISTS debot_signals_notification ON debot_signals(notification_key)');
    this.notifications=new DebotNotificationLedger(this.db,this.now);
    this.performance=new VendorPerformanceLedger(this.db,this.now);
    if(options.database!==':memory:')chmodSync(options.database,0o600);
    // A claimed event is never silently replayed after a crash. Its incomplete
    // analysis remains visible instead of creating another signal/order attempt.
    const prior=this.db.prepare('SELECT max(dispatched_at) AS at FROM debot_signals').get() as {at:string|null};
    if(prior.at)this.nextDispatchAt=Date.parse(prior.at)+this.dispatchIntervalMs();
    // Bounded local-only migration. Names never require another vendor request.
    if(options.lookupDisplay)for(const row of this.db.prepare(`SELECT id,report_id,chain,address FROM debot_signals
      WHERE report_id IS NOT NULL AND (token_name IS NULL OR token_symbol IS NULL) ORDER BY observed_at DESC LIMIT 50`).all()){
      try {
        const display=options.lookupDisplay(String(row.report_id));
        const expected=walletAddress(row.address,row.chain as Chain);
        if(expected&&display&&display.chain===row.chain&&walletAddress(display.address,display.chain)===expected)
          this.storeDisplay(String(row.id),String(row.chain),String(row.address),display);
      }catch {/* Missing historical labels cannot stop live capture. */}
    }
  }

  private storeDisplay(id:string,chain:string,address:string,value:{name?:unknown;symbol?:unknown}):void {
    const name=tokenDisplayText(value.name,100),symbol=tokenDisplayText(value.symbol,32);
    if(!(name||symbol)||!this.db.prepare('SELECT 1 FROM debot_signals WHERE id=? AND chain=? AND address=?').get(id,chain,address))return;
    // A later bound label can fill older alerts for the same token. Existing labels and every decision stay immutable.
    this.db.prepare(`UPDATE debot_signals SET token_name=COALESCE(token_name,?),token_symbol=COALESCE(token_symbol,?)
      WHERE chain=? AND address=? AND (token_name IS NULL OR token_symbol IS NULL)`).run(name??null,symbol??null,chain,address);
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
    const snapshot=report.gmgn,info=snapshot?.info,expected=walletAddress(row.address,row.chain);
    if(expected&&snapshot?.token.chain===row.chain&&walletAddress(snapshot.token.address,row.chain)===expected&&
      object(info)&&walletAddress(info.address,row.chain)===expected&&
      (info.chain===undefined||info.chain===row.chain||row.chain==='solana'&&info.chain==='sol'))
      this.storeDisplay(eventId,row.chain,row.address,info);
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
    const {now,items}=this.eventList({limit});return {now,items};
  }
  private eventList(options:DebotSignalListOptions={}) {
    const limit=options.limit??20,offset=options.offset??0;
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000||
      options.chain&&!['bsc','solana','robinhood'].includes(options.chain)||
      options.state&&!['pending','dispatching','completed','failed','interrupted','ignored'].includes(options.state)||
      options.asOf&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(options.asOf)||!Number.isFinite(Date.parse(options.asOf))||new Date(options.asOf).toISOString()!==options.asOf))
      throw new Error('INVALID_FILTER');
    const now=this.now();
    const asOf=options.asOf??now.toISOString(),clauses=["(reason IS NULL OR reason NOT IN ('DEBOT_SIGNAL_STALE','DEBOT_DUPLICATE_TOKEN_ALERT'))",'observed_at<=?'];
    const values:(string|number)[]=[asOf];
    if(options.chain){clauses.push('chain=?');values.push(options.chain);}
    if(options.state){clauses.push('state=?');values.push(options.state);}
    const where=clauses.join(' AND ');
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM debot_signals WHERE ${where}`).get(...values)!.n);
    const rows=this.db.prepare(`SELECT id,report_id,chain,address,token_name,token_symbol,occurred_at,observed_at,state,reason,dispatched_at,completed_at,progress,verdict
      FROM debot_signals WHERE ${where} ORDER BY observed_at DESC,id DESC LIMIT ? OFFSET ?`).all(...values,limit,offset);
    return {now:now.toISOString(),asOf,total,limit,offset,hasMore:offset+rows.length<total,items:rows.map(row=>this.project(row,now))};
  }
  private project(row:Record<string,any>,now:Date) {
      const receivedAt=String(row.observed_at),startedAt=row.dispatched_at?String(row.dispatched_at):undefined;
      const endedAt=row.completed_at?String(row.completed_at):row.state==='dispatching'?now.toISOString():undefined;
      const verdict=row.verdict?JSON.parse(String(row.verdict)):{};
      const checks=row.progress?JSON.parse(String(row.progress)):{};
      const reasons=[...reasonCodes(verdict.reasons),...reasonCodes(row.reason?[row.reason]:[])];
      return {eventId:String(row.id),reportId:row.report_id??undefined,chain:row.chain,address:row.address,
        name:tokenDisplayText(row.token_name,100),symbol:tokenDisplayText(row.token_symbol,32),
        occurredAt:row.occurred_at,receivedAt,state:row.state,startedAt,completedAt:row.completed_at??undefined,
        signalDelayMs:Date.parse(receivedAt)-Date.parse(String(row.occurred_at)),
        queueMs:startedAt?Math.max(0,Date.parse(startedAt)-Date.parse(receivedAt)):undefined,
        analysisMs:startedAt&&endedAt?Math.max(0,Date.parse(endedAt)-Date.parse(startedAt)):undefined,
        ...verdict,buyEligible:row.state==='completed'&&verdict.buyEligible===true&&Date.parse(verdict.validUntil)>now.getTime(),
        reasons,checks,score:scoreDebotRisk({state:String(row.state),checks,decision:verdict.decision,validUntil:verdict.validUntil,reasons},now)};
  }
  /** One row per chain + CA. Display updates never replace an actual risk verdict. */
  list(options:DebotSignalListOptions={}) {
    const {limit=20,offset=0}=options;
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000)throw new Error('INVALID_FILTER');
    // Reuse public filter validation without materializing any event payloads.
    this.eventList({...options,limit:1,offset:0});
    const now=this.now(),asOf=options.asOf??now.toISOString(),args:(string|number)[]=[asOf];
    const chain=options.chain?'AND chain=?':'';if(options.chain)args.push(options.chain);
    const cte=`WITH visible AS (SELECT rowid AS seq,id,chain,address,observed_at,occurred_at,state,reason,analyzed,
      report_id,token_name,token_symbol,dispatched_at,completed_at,progress,verdict FROM debot_signals WHERE observed_at<=? ${chain}
      AND (reason IS NULL OR reason!='DEBOT_SIGNAL_STALE')),
      ranked AS (SELECT *,MAX(observed_at) OVER (PARTITION BY chain,address) AS latest,
        SUM(analyzed) OVER (PARTITION BY chain,address) AS analyses,MAX(seq) OVER (PARTITION BY chain,address) AS latest_seq,
        FIRST_VALUE(state) OVER (PARTITION BY chain,address ORDER BY
          CASE WHEN state='dispatching' THEN 0 WHEN state='pending' THEN 1 ELSE 2 END,observed_at DESC,seq DESC) AS review_state,
        FIRST_VALUE(reason) OVER (PARTITION BY chain,address ORDER BY
          CASE WHEN state='dispatching' THEN 0 WHEN state='pending' THEN 1 ELSE 2 END,observed_at DESC,seq DESC) AS review_reason,
        ROW_NUMBER() OVER (PARTITION BY chain,address ORDER BY
          CASE WHEN state='dispatching' THEN 0 WHEN analyzed=1 OR verdict IS NOT NULL THEN 1 WHEN state='pending' THEN 2 ELSE 3 END,
          observed_at DESC,seq DESC) AS position FROM visible)
      `;
    const filter=options.state?' AND state=?':'';if(options.state)args.push(options.state);
    const total=Number(this.db.prepare(cte+`SELECT count(*) AS n FROM ranked WHERE position=1${filter}`).get(...args)!.n);
    const rows=this.db.prepare(cte+`SELECT * FROM ranked WHERE position=1${filter} ORDER BY latest DESC,latest_seq DESC,chain,address LIMIT ? OFFSET ?`)
      .all(...args,limit,offset);
    return {now:now.toISOString(),asOf,total,limit,offset,hasMore:offset+rows.length<total,items:rows.map(row=>({
      ...this.project(row,now),aggregation:{...this.notificationSummary(row.chain as Chain,String(row.address)),
        analysisCount:Number(row.analyses),reviewState:row.review_state,reviewReason:row.review_reason??undefined}}))};
  }
  notificationHistory(chain:Chain,address:string,options:{limit?:number;offset?:number;asOf?:string}={}) {
    const analyses=Number(this.db.prepare('SELECT count(*) AS n FROM debot_signals WHERE chain=? AND address=? AND analyzed=1').get(chain,address)!.n);
    return {chain,address,aggregation:{...this.notifications.current(chain,address),analysisCount:analyses},...this.notifications.history(chain,address,options)};
  }
  private notificationSummary(chain:Chain,address:string) {
    const current=this.notifications.current(chain,address);if(!current)return;
    const {delta,...change}=current.lastChange;
    return {...current,lastChange:{...change,delta:{walletCount:delta.walletCount,addressCount:delta.addressCount,
      addedAddressCount:delta.addedAddresses.length,addedAliasCount:delta.addedAliases.length}}};
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
      maxBytes:this.maxBytes,dbBytes:Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*this.pageSize,
      intervalSec:this.intervalSec,stored:rows.reduce((n,r)=>n+Number(r.n),0),pending:(counts.pending??0)+(counts.dispatching??0),
      dispatched:counts.completed??0,ignored:counts.ignored??0,failed:counts.failed??0,interrupted:counts.interrupted??0,
      lastObservedAt:latest.at??undefined,lastCycle:this.lastCycle?structuredClone(this.lastCycle):undefined,
      lastError:this.lastError,deferredReason:this.deferredReason,vendorPerformanceError:this.vendorPerformanceError,
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
    const row=this.db.prepare('SELECT chain,address,details,review_wallets FROM debot_signals WHERE id=?').get(signal.sourceEventId) as {chain:Chain;address:string;details:string|null;review_wallets:string|null}|undefined;
    if(!row?.details||row.details.length>64_000||row.chain!==signal.token.chain||walletAddress(row.address,row.chain)!==tokenAddress)return;
    let details:unknown;try{details=JSON.parse(row.details);}catch{return;}
    if(!object(details)||typeof details.fetchedAt!=='string'||!Array.isArray(details.vendorWallets)||details.vendorWallets.length>20||
      (details.reason!==undefined&&details.reason!=='DEBOT_SIGNAL_RECORDS_REJECTED'))return;
    const checkedAt=Date.parse(details.fetchedAt),now=this.now().getTime();
    if(!Number.isFinite(checkedAt)||checkedAt>now||now-checkedAt>120_000)return;
    const addresses:string[]=[];
    if(row.review_wallets)try {
      const changes=JSON.parse(row.review_wallets);
      if(Array.isArray(changes))for(const change of changes.slice(0,24)){
        const at=Date.parse(change.observedAt),address=walletAddress(change.address,row.chain);
        if(address&&Number.isFinite(at)&&at<=now&&at>=now-120_000&&!addresses.includes(address))addresses.push(address);
        if(addresses.length===3)break;
      }
    }catch {/* An unavailable hint cannot replace the bound current detail response. */}
    for(const wallet of details.vendorWallets) {
      if(addresses.length===3)break;
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
    // Thirty-day retention, 10k events, and the configured SQLite page ceiling.
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
    this.db.exec('SAVEPOINT debot_inbox_record');
    let result:number;
    try {result=this.recordAtomic(observation);this.db.exec('RELEASE debot_inbox_record');}
    catch(error){
      // SQLITE_FULL may already have rolled back the savepoint. Keep its capacity reason.
      try{this.db.exec('ROLLBACK TO debot_inbox_record; RELEASE debot_inbox_record');}catch{/* Already rolled back. */}
      throw error;
    }
    // Observation is independent of dispatch/dedup decisions, and cannot roll back the inbox.
    const bound=this.db.prepare('SELECT chain,address FROM debot_signals WHERE id=?').get(observation.signal.sourceEventId);
    if(bound&&bound.chain===observation.signal.token.chain&&bound.address===observation.signal.token.address){
      if(observation.vendorPerformance)try{this.performance.record(observation);this.vendorPerformanceError=undefined;}
      catch{this.vendorPerformanceError='VENDOR_PERFORMANCE_PERSIST_FAILED';}
      try{this.options.onObservation?.(observation);}catch{/* Optional observer failure is isolated. */}
    }
    return result;
  }
  /** Resume only recent real notifications; their original timestamps remain unchanged. */
  observationSeeds(limit=300):DebotSignalObservation[]{
    if(this.closed)return [];
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('INVALID_FILTER');
    return this.db.prepare('SELECT payload FROM debot_signals WHERE observed_at>=? ORDER BY observed_at DESC LIMIT ?')
      .all(new Date(this.now().getTime()-7200000).toISOString(),limit)
      .flatMap(row=>{try{return [JSON.parse(String(row.payload)) as DebotSignalObservation];}catch{return [];}}).reverse();
  }
  private recordAtomic(observation:DebotSignalObservation):number {
    let signal=observation.signal;
    if(!this.chains.includes(signal.token.chain))return 0;
    const existing=this.db.prepare('SELECT chain,address,occurred_at FROM debot_signals WHERE id=?').get(signal.sourceEventId);
    if(existing&&(existing.chain!==signal.token.chain||existing.address!==signal.token.address))return 0;
    const update=this.notifications.record(observation);
    if(existing){
      this.storeDisplay(signal.sourceEventId,signal.token.chain,signal.token.address,observation);
      if(this.options.mode!=='authenticated_stream'||update.kind==='replay'||update.kind==='display')return 0;
      // A changed card keeps its original vendor id for the detail request; the
      // immutable analysis snapshot gets a separate, deterministic revision id.
      signal={...signal,occurredAt:String(existing.occurred_at),sourceEventId:`debot:revision:${update.key}`};
      if(this.db.prepare('SELECT 1 FROM debot_signals WHERE id=?').get(signal.sourceEventId))return 0;
      observation={...observation,signal};
    }
    if(update.kind==='replay')return 0;
    const count=Number(this.db.prepare('SELECT count(*) AS n FROM debot_signals').get()!.n);
    if(count>=10000){
      const oldest=this.db.prepare("SELECT id FROM debot_signals WHERE state NOT IN ('pending','dispatching') AND observed_at<? ORDER BY observed_at LIMIT 1")
        .get(new Date(this.now().getTime()-86400_000).toISOString());
      if(!oldest)throw new Error('DEBOT_SIGNAL_STORE_FULL');this.db.prepare('DELETE FROM debot_signals WHERE id=?').run(oldest.id!);
    }
    const previous=this.db.prepare('SELECT 1 FROM debot_signals WHERE chain=? AND address=? AND analyzed=1 LIMIT 1').get(signal.token.chain,signal.token.address);
    const stale=Date.parse(signal.occurredAt)<this.now().getTime()-this.maxAgeSec()*1000&&!(previous&&update.kind==='wallet_hint');
    const dedupKey=update.key;
    this.db.prepare('INSERT INTO debot_signals(id,chain,address,occurred_at,observed_at,state,payload,reason,dedup_key,notification_key,hint_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(signal.sourceEventId,signal.token.chain,signal.token.address,signal.occurredAt,observation.observedAt,
        stale?'ignored':'pending',JSON.stringify(observation),stale?'DEBOT_SIGNAL_STALE':null,dedupKey,update.key,update.kind);
    this.storeDisplay(signal.sourceEventId,signal.token.chain,signal.token.address,observation);
    if(stale)this.notifications.mark(update.key,{classification:'stale',reasons:['DEBOT_SIGNAL_STALE']});
    else {
      // Preserve the first pending assessment. Subsequent updates collapse to
      // one latest task while every notification remains in the audit ledger.
      this.coalescePending(signal.token);
    }
    return 1;
  }

  private coalescePending(token:Signal['token']):void {
    const rows=this.db.prepare("SELECT * FROM debot_signals WHERE chain=? AND address=? AND state='pending' ORDER BY rowid")
      .all(token.chain,token.address);
    if(rows.length<2)return;
    const started=this.db.prepare("SELECT 1 FROM debot_signals WHERE chain=? AND address=? AND (analyzed=1 OR state='dispatching') LIMIT 1").get(token.chain,token.address);
    const protectedId=started?undefined:rows[0].id,latest=rows.at(-1)!;
    const merging=rows.filter(row=>row.id!==protectedId&&row.id!==latest.id);
    if(!merging.length)return;
    const payloads:DebotSignalObservation[]=[];
    for(const row of [...merging,latest]) {
      if(row.merged_payloads)payloads.push(...JSON.parse(String(row.merged_payloads)));
      if(row.hint_kind==='wallet_hint')payloads.push(JSON.parse(String(row.payload)));
    }
    const unique=[...new Map(payloads.map(value=>[createHash('sha256').update(JSON.stringify([value.id,value.vendorWallets,value.aliases])).digest('hex'),value])).values()];
    const truncated=unique.length>6||[...merging,latest].some(row=>row.merged_truncated===1);
    // Keep each intermediate wallet hint, rather than replacing its evidence
    // with the final card. Details calls are bounded; the ledger retains overflow.
    this.db.prepare('UPDATE debot_signals SET merged_payloads=?,merged_truncated=?,hint_kind=?,review_after=NULL WHERE id=?')
      .run(JSON.stringify(unique.slice(-6)),truncated?1:0,unique.length?'wallet_hint':latest.hint_kind,latest.id!);
    for(const row of merging){
      this.db.prepare("UPDATE debot_signals SET state='ignored',reason='DEBOT_UPDATE_COALESCED' WHERE id=?").run(row.id!);
      if(row.notification_key)this.notifications.mark(String(row.notification_key),{classification:'coalesced',
        reasons:['DEBOT_UPDATE_COALESCED',...(truncated?['DEBOT_MERGED_HINTS_LIMIT_6']:[])]});
    }
  }

  private expire():void {
    const cutoff=new Date(this.now().getTime()-this.maxAgeSec()*1000).toISOString();
    const expiry=`state='pending' AND (observed_at<? OR (occurred_at<? AND NOT EXISTS
      (SELECT 1 FROM debot_signals prior WHERE prior.chain=debot_signals.chain AND prior.address=debot_signals.address AND prior.analyzed=1)))`;
    const expired=this.db.prepare(`SELECT notification_key FROM debot_signals WHERE ${expiry}`).all(cutoff,cutoff);
    this.db.prepare(`UPDATE debot_signals SET state='ignored',reason='DEBOT_SIGNAL_STALE' WHERE ${expiry}`).run(cutoff,cutoff);
    for(const row of expired)if(row.notification_key)this.notifications.mark(String(row.notification_key),{classification:'stale',reasons:['DEBOT_SIGNAL_STALE']});
  }

  private scopedDetails(row:Record<string,any>|undefined,token:Signal['token']):DebotScopedWalletDetails|undefined {
    if(!row?.details||row.chain!==token.chain||row.address!==token.address)return;
    try {return {...JSON.parse(String(row.details)),token};}catch{return;}
  }
  private repeatCheck(observation:DebotSignalObservation,previous:Record<string,any>,details?:DebotWalletDetails):DebotRepeatEvidence {
    const input:DebotRepeatEvidenceInput={token:observation.signal.token,
      previousDetails:this.scopedDetails(previous,observation.signal.token),
      ...(details?{details:{...details,token:observation.signal.token}}:{}),
      since:String(previous.evidence_cutoff_at??previous.dispatched_at??previous.observed_at),now:this.now()};
    try {return (this.options.repeatEvidence??assessDebotRepeatEvidence)(input,observation.signal);}
    catch {const result=assessDebotRepeatEvidence(input);return {...result,material:false,priority:'normal',
      reasons:['DEBOT_REPEAT_LOCAL_EVIDENCE_UNAVAILABLE']};}
  }

  private async dispatch(generation:number):Promise<boolean> {
    if(this.interrupted(generation))return false;
    this.expire();this.deferredReason=undefined;
    if(this.nextDispatchAt>this.now().getTime())return false;
    this.deferredReason=this.options.shouldDefer?.();
    if(this.deferredReason)return false;
    // Revisit priority between completed tasks too, rather than waiting for the
    // entire worker batch to drain while new ordinary alerts keep arriving.
    if(this.now().getTime()>=this.nextRiskCheckAt){
      this.nextRiskCheckAt=this.now().getTime()+1000;
      const result=promoteDebotRiskUpdates(this.db,{now:this.now(),assess:(row,previous)=>
        this.repeatCheck(JSON.parse(String(row.payload)),previous)});
      if(result.reason)this.lastError=result.reason;
    }
    const row=this.db.prepare(`SELECT * FROM debot_signals p WHERE state='pending' AND (review_after IS NULL OR review_after<=?)
      AND NOT EXISTS (SELECT 1 FROM debot_signals a WHERE a.state='dispatching' AND a.chain=p.chain AND a.address=p.address)
      ORDER BY review_priority DESC,CASE WHEN NOT EXISTS (SELECT 1 FROM debot_signals b WHERE b.chain=p.chain AND b.address=p.address AND b.analyzed=1) THEN 0 ELSE 1 END,
        CASE WHEN hint_kind='first' THEN 0 ELSE 1 END,occurred_at DESC,id LIMIT 1`)
      .get(this.now().toISOString()) as Record<string,any>|undefined;
    if(!row)return false;
    const observation=JSON.parse(row.payload) as DebotSignalObservation;
    const previous=this.db.prepare('SELECT * FROM debot_signals WHERE chain=? AND address=? AND analyzed=1 ORDER BY dispatched_at DESC,rowid DESC LIMIT 1')
      .get(row.chain,row.address);
    const mark=(classification:string,reasons:string[],evidence?:unknown)=>{
      if(row.notification_key)this.notifications.mark(row.notification_key,{classification,reasons,evidence});
    };
    const ignore=(reason:string,classification:string,evidence?:unknown,reasons=[reason])=>{
      this.db.prepare("UPDATE debot_signals SET state='ignored',reason=? WHERE id=?").run(reason,row.id);mark(classification,reasons,evidence);
    };
    let incremental=previous?this.repeatCheck(observation,previous):undefined;
    if(previous&&!incremental?.material&&row.hint_kind==='display') {
      ignore('DEBOT_DUPLICATE_TOKEN_ALERT','display_only',incremental?.evidence,['DEBOT_NO_MATERIAL_CHANGE']);return true;
    }
    if(previous&&incremental?.priority!=='risk') {
      const latest=this.db.prepare('SELECT MAX(COALESCE(probed_at,dispatched_at)) AS at FROM debot_signals WHERE chain=? AND address=?')
        .get(row.chain,row.address)?.at;
      const next=latest?Date.parse(String(latest))+(this.options.repeatCooldownSec??30)*1000:0;
      if(next>this.now().getTime()){
        this.db.prepare("UPDATE debot_signals SET review_after=?,reason='DEBOT_REPEAT_COOLDOWN' WHERE id=?").run(new Date(next).toISOString(),row.id);
        mark('evidence_pending',['DEBOT_REPEAT_COOLDOWN']);return true;
      }
    }
    const at=this.now().toISOString();
    const changed=this.db.prepare("UPDATE debot_signals SET state='dispatching',dispatched_at=?,reason=NULL WHERE id=? AND state='pending'")
      .run(at,row.id);
    if(!changed.changes)return false;
    this.nextDispatchAt=this.now().getTime()+this.dispatchIntervalMs();
    const fetched:DebotWalletDetails[]=[];
    let detailsFailed=0;
    const detailsReady=(async()=>{
      if(this.options.fetchDetails){
        try {
          this.db.prepare('UPDATE debot_signals SET probed_at=? WHERE id=?').run(this.now().toISOString(),row.id);
          const merged:DebotSignalObservation[]=row.merged_payloads?JSON.parse(row.merged_payloads):[];
          const requests=[...new Map([...merged.filter(value=>value.id!==observation.id),observation].map(value=>[value.id,value])).values()].slice(-6);
          for(const request of requests){
            if(this.interrupted(generation))break;
            try {fetched.push(await this.options.fetchDetails(request));}
            catch {detailsFailed++;this.db.prepare("UPDATE debot_signals SET details_error='DEBOT_DETAILS_UNAVAILABLE' WHERE id=?").run(row.id);}
          }
          // Preserve intermediate notification details separately. Only the latest
          // response becomes the next baseline; no synthetic merged wallet holdings.
          const details=fetched.at(-1);
          if(details)this.db.prepare('UPDATE debot_signals SET details=?,details_error=? WHERE id=?')
            .run(JSON.stringify(details),detailsFailed?'DEBOT_DETAILS_PARTIAL':details.reason??null,row.id);
        }catch {detailsFailed++;this.db.prepare("UPDATE debot_signals SET details_error='DEBOT_DETAILS_UNAVAILABLE' WHERE id=?").run(row.id);}
      }
    })();
    try {
      if(!this.options.parallelDetails||previous&&!incremental?.material)await detailsReady;
      if(this.interrupted(generation)) {
        this.db.prepare("UPDATE debot_signals SET state='interrupted',reason='DEBOT_SIGNAL_INTERRUPTED',completed_at=? WHERE id=?")
          .run(this.now().toISOString(),row.id);mark('interrupted',['DEBOT_SIGNAL_INTERRUPTED']);return false;
      }
      if(previous&&!incremental?.material) {
        const candidates=(fetched.length?fetched:[undefined]).map(details=>this.repeatCheck(observation,previous,details));
        incremental=candidates.find(value=>value.material&&value.priority==='risk')??candidates.find(value=>value.material)??candidates.at(-1)!;
        const changed=candidates.filter(value=>value.material).sort((a,b)=>Number(b.priority==='risk')-Number(a.priority==='risk'));
        if(changed.length>1){
          const unique=<T>(items:T[])=>[...new Map(items.map(item=>[JSON.stringify(item),item])).values()];
          incremental={...incremental,reasons:unique(changed.flatMap(value=>value.reasons)),evidence:{...incremental.evidence,
            vendorChanges:unique(changed.flatMap(value=>value.evidence.vendorChanges)).slice(0,24),
            observedTrades:unique(changed.flatMap(value=>value.evidence.observedTrades)).slice(0,20),
            researchTargets:unique(changed.flatMap(value=>value.evidence.researchTargets)).slice(0,6),
            limitations:unique(changed.flatMap(value=>value.evidence.limitations).concat('MERGED_NOTIFICATION_DETAIL_SAMPLES'))}};
        }
        if(detailsFailed){
          incremental.reasons.push('DEBOT_REPEAT_DETAILS_PARTIAL');
          incremental.evidence.limitations.push('MERGED_DETAILS_UNAVAILABLE');
          if(!incremental.material)incremental.evidence.status='unavailable';
        }
        if(row.merged_truncated===1)incremental.evidence.limitations.push('MERGED_HINTS_LIMIT_6');
        if(!incremental.material){
          if(incremental.evidence.status==='unavailable'){
            const after=new Date(this.now().getTime()+Math.max(5,this.options.repeatCooldownSec??30)*1000).toISOString();
            this.db.prepare("UPDATE debot_signals SET state='pending',reason='DEBOT_REPEAT_EVIDENCE_PENDING',review_after=? WHERE id=?").run(after,row.id);
            mark('evidence_pending',incremental.reasons,incremental.evidence);
            this.coalescePending(observation.signal.token);
          }else ignore('DEBOT_NO_MATERIAL_CHANGE','no_material_change',incremental.evidence,incremental.reasons);
          return true;
        }
      }
      let evaluationSignal=observation.signal;
      if(Date.parse(evaluationSignal.occurredAt)<this.now().getTime()-this.maxAgeSec()*1000){
        // An old card may contain a genuinely new trade. Its original alert time
        // remains immutable; only a bounded, explicit trade timestamp can anchor
        // a new assessment. Arrival time or a new alias can never refresh it.
        const since=previous?Date.parse(String(previous.evidence_cutoff_at??previous.dispatched_at??previous.observed_at)):Infinity;
        const proof=incremental?.material?[...incremental.evidence.observedTrades,...incremental.evidence.vendorChanges]
          .map(item=>Date.parse(item.eventAt??'')).filter(time=>time>since&&time<=this.now().getTime()&&
            time>=this.now().getTime()-this.maxAgeSec()*1000).sort((a,b)=>b-a)[0]:undefined;
        if(proof===undefined){ignore('DEBOT_SIGNAL_STALE','stale',incremental?.evidence);return true;}
        evaluationSignal={...evaluationSignal,occurredAt:new Date(proof).toISOString()};
      }
      this.db.prepare('UPDATE debot_signals SET evidence_cutoff_at=?,analysis_occurred_at=? WHERE id=?')
        .run(this.now().toISOString(),evaluationSignal.occurredAt,row.id);
      if(incremental)this.db.prepare('UPDATE debot_signals SET review_wallets=? WHERE id=?')
        .run(JSON.stringify(incremental.evidence.vendorChanges.map(({address,observedAt})=>({address,observedAt}))),row.id);
      mark(previous?'reassessment':'first_analysis',incremental?.reasons??['DEBOT_INITIAL_ANALYSIS'],incremental?.evidence);
      await this.options.onSignal(evaluationSignal,observation.observedAt,{detailsReady,repeat:!!previous});
      this.db.prepare("UPDATE debot_signals SET state='completed',analyzed=1,completed_at=? WHERE id=?")
        .run(this.now().toISOString(),row.id);
    } catch {
      this.db.prepare("UPDATE debot_signals SET state='failed',reason='DEBOT_SIGNAL_DISPATCH_FAILED',completed_at=? WHERE id=?")
        .run(this.now().toISOString(),row.id);
      mark('failed',['DEBOT_SIGNAL_DISPATCH_FAILED']);
      this.lastError='DEBOT_SIGNAL_DISPATCH_FAILED';
    }finally{await detailsReady;}
    return true;
  }
}
