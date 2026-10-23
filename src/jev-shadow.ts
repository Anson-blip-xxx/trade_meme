import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {buildJevRequest,parseJevResponse,JEV_MODEL,JEV_RUBRIC_VERSION,type JevInput,type JevResult} from './jev-input.js';
import type {Chain} from './types.js';

export interface JevShadowOptions {
  enabled:boolean;database:string;maxBytes:number;timeoutMs:number;minIntervalMs:number;perTokenIntervalMs:number;
  maxCallsPerDay:number;maxTokensPerDay:number;clientPath:string;now?:()=>number;startupError?:string;
  invoke?:(request:unknown,options:{signal:AbortSignal;timeout:number;retry:{maxRetries:0}})=>Promise<unknown>;
}
interface Horizon {status:'pending'|'complete'|'missed';at?:string;priceUsd?:number;grossReturnPct?:number;}
export interface JevComparison {
  eligible:boolean;selected:boolean|null;excludedReason?:string;baselineAt?:string;baselinePriceUsd?:number;
  sampleCount:number;sampledMaxGainPct?:number;sampledMaxDrawdownPct?:number;
  horizons:Record<'5'|'15'|'60',Horizon>;
  /** Observed market prices, with no fill, fee or slippage assumption. */
  method:'observed_price_gross';lastSampleAt?:string;peakPriceUsd?:number;
  baselineSource?:string;baselinePoolAddress?:string;seriesMismatchCount?:number;trackingUnavailableReason?:string;
}
export interface JevPriceSample {token:{chain:Chain;address:string};observedAt:string;priceUsd?:number;source?:string;poolAddress?:string;}
export interface JevShadowItem {
  id:string;reportId:string;token:{chain:Chain;address:string};name?:string;inputHash:string;asOf:string;
  receivedAt:string;completedAt:string|null;latencyMs:number|null;status:'pending'|'available'|'unavailable';
  reason:string|null;retryAt:string|null;model:string;rubricVersion:string;result:JevResult|null;baseline:JevInput['baseline'];comparison:JevComparison;
}
export interface JevShadowPage {items:JevShadowItem[];total:number;limit:number;offset:number;}
interface Budget {day:string;calls:number;knownTokens:number;unknownUsageCalls:number;reservedTokens:number;}
interface Circuit {reason:string|null;retryAt:string|null;failures:number;}
export interface JevShadowStatus {
  enabled:boolean;mode:'shadow';running:boolean;available:boolean;model:string;rubricVersion:string;
  queueDepth:number;inFlight:boolean;providerPending:boolean;lastError:string|null;lastCompletedAt:string|null;
  circuit:Circuit;budget:Budget&{maxCalls:number;maxTokens:number;accountBalanceKnown:false;timezone:'Asia/Shanghai'};
  counts:{total:number;available:number;unavailable:number;pending:number};
  comparison:{eligible:number;selected:number;rejected:number;excluded:number;priced:number;horizons:{minutes:number;pairs:number;baselineMeanGrossPct:number|null;jevSelectedMeanGrossPct:number|null;selectedCount:number;rejectedCount:number}[]};
  storage:{usedBytes:number;maxBytes:number;prunedRecords:number;retentionDays:number;maxRecords:number};
  limits:{timeoutMs:number;minIntervalMs:number;perTokenIntervalMs:number;queueLimit:number;queueExpiryMs:number;baselineWaitMs:number;horizonLateToleranceMs:number};
}
type Row=Record<string,any>;
interface Pending {id:string;input:JevInput;request:unknown;receivedAt:number;hash:string;}
const QUEUE_LIMIT=32,QUEUE_EXPIRY_MS=30_000,BASELINE_WAIT_MS=120_000,LATE_MS=120_000,MAX_RECORDS=20_000,RETENTION_MS=14*86_400_000;
const iso=(n:number)=>new Date(n).toISOString();
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const obj=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const parse=<T>(v:unknown,fallback:T):T=>{try{return typeof v==='string'?JSON.parse(v):fallback;}catch{return fallback;}};
const day=(at:number)=>iso(at+8*3_600_000).slice(0,10);
const nextDay=(at:number)=>Date.parse(`${day(at)}T00:00:00+08:00`)+86_400_000;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const coded=(code:string)=>Object.assign(new Error(code),{code});
const tokenKey=(input:JevInput)=>`${input.token.chain}:${input.token.address}`;
const emptyComparison=(input:JevInput):JevComparison=>({eligible:input.baseline.hardChecksPassed&&input.baseline.decision==='BUY_CANDIDATE',
  selected:null,sampleCount:0,method:'observed_price_gross',horizons:{'5':{status:'pending'},'15':{status:'pending'},'60':{status:'pending'}}});

/** This runner owns no order adapter, signer, strategy gate or control-wallet capability.
 * Every unavailable result preserves the original decision and has a null model score.
 * API errors are classified using allowlisted fields, never persisted verbatim. */
export class JevShadow {
  private db?:DatabaseSync;private readonly now:()=>number;private running=false;private closed=false;
  private queue:Pending[]=[];private work?:Promise<void>;private timer?:ReturnType<typeof setTimeout>;
  private abort?:AbortController;private providerPending=false;private lastError:string|null=null;
  private lastCompletedAt:string|null=null;private circuit:Circuit={reason:null,retryAt:null,failures:0};
  private budget:Budget;private lastDispatchAt=0;private nextPrune=0;private prunedRecords=0;
  private reservationBlockedDay:string|null=null;
  private invoke?:JevShadowOptions['invoke'];
  constructor(private readonly options:JevShadowOptions) {
    this.now=options.now??Date.now;this.budget={day:day(this.now()),calls:0,knownTokens:0,unknownUsageCalls:0,reservedTokens:0};
    this.invoke=options.invoke;
    if(options.startupError){this.lastError=options.startupError==='JEV_DATABASE_CONFLICT'?options.startupError:'JEV_STORAGE_UNAVAILABLE';return;}
    if(!Number.isSafeInteger(options.maxBytes)||options.maxBytes<262144||
      !Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>30_000||
      !Number.isSafeInteger(options.minIntervalMs)||options.minIntervalMs<0||
      !Number.isSafeInteger(options.perTokenIntervalMs)||options.perTokenIntervalMs<0||
      !Number.isSafeInteger(options.maxCallsPerDay)||options.maxCallsPerDay<1||
      !Number.isSafeInteger(options.maxTokensPerDay)||options.maxTokensPerDay<1)throw coded('JEV_CONFIG_INVALID');
    try {
      if(options.database!==':memory:')mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
      this.db=new DatabaseSync(options.database);
      if(options.database!==':memory:')chmodSync(options.database,0o600);
      const pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
      // DELETE journaling bounds disk usage without an ever-growing WAL sidecar.
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=50; PRAGMA max_page_count=${Math.floor(options.maxBytes/pageSize)};
        CREATE TABLE IF NOT EXISTS jev_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jev_results(id TEXT PRIMARY KEY,report_id TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,name TEXT,
          input_hash TEXT NOT NULL,as_of TEXT NOT NULL,received_at TEXT NOT NULL,completed_at TEXT,latency_ms REAL,status TEXT NOT NULL,
          reason TEXT,retry_at TEXT,input TEXT NOT NULL,request TEXT NOT NULL,baseline TEXT NOT NULL,result TEXT,comparison TEXT NOT NULL,
          model TEXT NOT NULL,rubric_version TEXT NOT NULL,dedup_hash TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS jev_page ON jev_results(received_at DESC,id);
        CREATE INDEX IF NOT EXISTS jev_token ON jev_results(chain,address,received_at DESC);
        CREATE INDEX IF NOT EXISTS jev_hash ON jev_results(input_hash);
        CREATE INDEX IF NOT EXISTS jev_chain_page ON jev_results(chain,received_at DESC,id);
        CREATE INDEX IF NOT EXISTS jev_track ON jev_results(chain,address,completed_at) WHERE status='available';`);
      this.circuit=parse(this.meta('circuit'),this.circuit);this.prunedRecords=Number(this.meta('pruned_records')??0);
      this.budget=parse(this.meta('budget'),this.budget);this.lastCompletedAt=this.meta('last_completed_at')??null;
      this.reservationBlockedDay=this.meta('reservation_blocked_day')??null;
      this.lastDispatchAt=Number(this.meta('last_dispatch_at')??0);this.refreshBudget();
      // A restart cannot complete or silently replay a request whose response was lost.
      this.db.prepare(`UPDATE jev_results SET status='unavailable',reason='JEV_INTERRUPTED',completed_at=?,
        comparison=json_set(comparison,'$.excludedReason','JEV_INTERRUPTED') WHERE status='pending'`).run(iso(this.now()));
    }catch {this.storageFailure();}
  }
  start():void {if(this.closed)return;this.running=true;this.schedule();}
  async stop():Promise<void> {
    if(this.closed)return;this.running=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    this.abort?.abort();for(const pending of this.queue.splice(0))this.finish(pending,null,'JEV_STOPPED');
    await this.work;this.closed=true;try{this.db?.close();}catch{}this.db=undefined;
  }
  private meta(key:string):string|undefined {return this.db?.prepare('SELECT value FROM jev_meta WHERE key=?').get(key)?.value as string|undefined;}
  private setMeta(key:string,value:unknown):void {this.db?.prepare('INSERT OR REPLACE INTO jev_meta VALUES (?,?)').run(key,typeof value==='string'?value:JSON.stringify(value));}
  private storageFailure():void {this.lastError='JEV_STORAGE_UNAVAILABLE';try{this.db?.close();}catch{}this.db=undefined;this.queue=[];}
  private refreshBudget():void {
    if(this.budget.day!==day(this.now())){
      this.budget={day:day(this.now()),calls:0,knownTokens:0,unknownUsageCalls:0,reservedTokens:0};this.setMeta('budget',this.budget);
      this.reservationBlockedDay=null;this.setMeta('reservation_blocked_day','');
      if(this.lastError==='JEV_DAILY_TOKEN_BUDGET'||this.lastError==='JEV_DAILY_CALL_BUDGET')this.lastError=null;
    }
  }
  /** Snapshot caller-owned data now. Mutations after enqueue cannot change model inputs. */
  enqueue(input:JevInput):void {
    if(this.closed||!this.options.enabled||!this.db)return;
    let frozen:JevInput,request:unknown,encoded:string,requestText:string;
    try {
      encoded=JSON.stringify(input);if(encoded.length>100_000)return;
      frozen=JSON.parse(encoded) as JevInput;const asOf=Date.parse(frozen.asOf),now=this.now();
      if(!Number.isFinite(asOf)||asOf>now||now-asOf>QUEUE_EXPIRY_MS||!obj(frozen.token)||
        !['bsc','solana','robinhood'].includes(frozen.token.chain)||typeof frozen.token.address!=='string'||!obj(frozen.baseline))return;
      request=buildJevRequest(frozen);requestText=JSON.stringify(request);if(requestText.length>100_000)return;
    }catch {this.lastError='JEV_INPUT_INVALID';return;}
    try {
      const now=this.now();
      // asOf is excluded only from dedup identity. A later genuine state change creates a fresh version.
      const fingerprint=hash([JEV_MODEL,JEV_RUBRIC_VERSION,frozen.token,frozen.state,frozen.baseline]);
      const last=this.db.prepare('SELECT received_at,dedup_hash FROM jev_results WHERE chain=? AND address=? ORDER BY received_at DESC LIMIT 1')
        .get(frozen.token.chain,frozen.token.address);
      if(last&&(last.dedup_hash===fingerprint||now-Date.parse(String(last.received_at))<this.options.perTokenIntervalMs))return;
      this.prune();
      const pending:Pending={id:randomUUID(),input:frozen,request,receivedAt:now,hash:hash({input:frozen,request})};
      const comparison=emptyComparison(frozen);
      this.db.prepare('INSERT INTO jev_results VALUES (?,?,?,?,?,?,?,?,NULL,NULL,\'pending\',NULL,NULL,?,?,?,?,?,?,?,?)')
        .run(pending.id,frozen.reportId,frozen.token.chain,frozen.token.address,frozen.name??null,pending.hash,frozen.asOf,iso(now),
          encoded,requestText,JSON.stringify(frozen.baseline),null,JSON.stringify(comparison),JEV_MODEL,JEV_RUBRIC_VERSION,fingerprint);
      const availability=frozen.state.availability;
      if(obj(availability)&&['heat','trading_emotion','wallet_relay','catalyst','celebrity'].every(key=>availability[key]===false)){
        this.finish(pending,null,'JEV_EVIDENCE_INSUFFICIENT');return;
      }
      const blocked=this.blockReason();
      if(blocked){this.finish(pending,null,blocked);return;}
      const old=this.queue.findIndex(item=>tokenKey(item.input)===tokenKey(frozen));
      if(old>=0)this.finish(this.queue.splice(old,1)[0],null,'JEV_SUPERSEDED');
      if(this.queue.length>=QUEUE_LIMIT){this.finish(pending,null,'JEV_QUEUE_FULL');return;}
      this.queue.push(pending);this.schedule();
    }catch {this.storageFailure();}
  }
  private blockReason():string|undefined {
    this.refreshBudget();
    if(!this.running)return 'JEV_STOPPED';
    if(!this.db)return 'JEV_STORAGE_UNAVAILABLE';
    if(this.circuit.retryAt&&Date.parse(this.circuit.retryAt)>this.now())return this.circuit.reason??'JEV_CIRCUIT_OPEN';
    if(this.providerPending&&!this.work)return 'JEV_PROVIDER_STILL_PENDING';
    if(this.budget.calls>=this.options.maxCallsPerDay)return 'JEV_DAILY_CALL_BUDGET';
    if(this.reservationBlockedDay===this.budget.day||this.budget.knownTokens+this.budget.reservedTokens>=this.options.maxTokensPerDay)return 'JEV_DAILY_TOKEN_BUDGET';
    return;
  }
  private schedule():void {
    if(!this.running||this.closed||this.work||this.timer||!this.queue.length)return;
    const delay=Math.max(0,this.options.minIntervalMs-(this.now()-this.lastDispatchAt));
    this.timer=setTimeout(()=>{this.timer=undefined;if(!this.running)return;
      this.work=this.drainOne().catch(()=>{this.storageFailure();}).finally(()=>{this.work=undefined;this.schedule();});
    },Math.min(delay,QUEUE_EXPIRY_MS));this.timer.unref();
  }
  private async loadInvoke():Promise<NonNullable<JevShadowOptions['invoke']>> {
    if(this.invoke)return this.invoke;
    let module:any;try{module=await import(this.options.clientPath);}catch{throw coded('JEV_CLIENT_UNAVAILABLE');}
    if(typeof module.createJevClient!=='function')throw coded('JEV_CLIENT_UNAVAILABLE');
    const client=module.createJevClient({model:JEV_MODEL});
    this.invoke=(request,options)=>client.systemOne(request,options);return this.invoke!;
  }
  private async drainOne():Promise<void> {
    const pending=this.queue.shift();if(!pending||!this.db)return;
    if(this.now()-pending.receivedAt>=QUEUE_EXPIRY_MS){this.finish(pending,null,'JEV_QUEUE_EXPIRED');return;}
    const blocked=this.blockReason();if(blocked){this.finish(pending,null,blocked);return;}
    if(this.now()-this.lastDispatchAt<this.options.minIntervalMs){this.queue.unshift(pending);return;}
    // Reserve a deliberately conservative request-size allowance. Unknown usage
    // never becomes free usage after a timeout or restart. This is not account balance.
    const reserved=JSON.stringify(pending.request).length+2048;
    if(this.budget.knownTokens+this.budget.reservedTokens+reserved>this.options.maxTokensPerDay){
      this.reservationBlockedDay=this.budget.day;this.setMeta('reservation_blocked_day',this.budget.day);
      this.lastError='JEV_DAILY_TOKEN_BUDGET';this.finish(pending,null,'JEV_DAILY_TOKEN_BUDGET');return;
    }
    const budgetDay=this.budget.day;
    this.budget.calls++;this.budget.unknownUsageCalls++;this.budget.reservedTokens+=reserved;
    this.lastDispatchAt=this.now();this.setMeta('budget',this.budget);this.setMeta('last_dispatch_at',String(this.lastDispatchAt));
    const started=performance.now(),controller=new AbortController();this.abort=controller;
    let timer:ReturnType<typeof setTimeout>|undefined;let timedOut=false;
    const interrupted=new Promise<never>((_,reject)=>{
      controller.signal.addEventListener('abort',()=>reject(coded(timedOut?'JEV_TIMEOUT':'JEV_STOPPED')),{once:true});
      timer=setTimeout(()=>{timedOut=true;controller.abort();},this.options.timeoutMs);
    });
    this.providerPending=true;
    const provider=(async()=>{const invoke=await this.loadInvoke();if(controller.signal.aborted)throw coded('JEV_STOPPED');
      return invoke(pending.request,{signal:controller.signal,timeout:this.options.timeoutMs,retry:{maxRetries:0}});})();
    // Attach both settlement handlers so an ignored abort cannot create an unhandled
    // rejection. Until settlement, new calls remain disabled, even after cooldown.
    void provider.then(()=>{this.providerPending=false;},()=>{this.providerPending=false;});
    try {
      const raw=await Promise.race([provider,interrupted]);
      this.recordUsage(raw,budgetDay,reserved);
      let result:JevResult;try{result=parseJevResponse(raw,pending.input);}catch{throw coded('JEV_RESPONSE_INVALID');}
      this.circuit={reason:null,retryAt:null,failures:0};this.setMeta('circuit',this.circuit);this.lastError=null;
      this.finish(pending,result,null,Math.round(performance.now()-started));
    }catch(error) {
      const failure=this.failure(error);this.lastError=failure.reason;
      if(!this.options.invoke&&['JEV_AUTH_UNAVAILABLE','JEV_KEY_MISSING','JEV_CLIENT_UNAVAILABLE'].includes(failure.reason))this.invoke=undefined;
      if(failure.reason!=='JEV_STOPPED'){
        this.circuit={reason:failure.reason,retryAt:iso(this.now()+failure.cooldownMs),failures:this.circuit.failures+1};
        this.setMeta('circuit',this.circuit);
      }
      this.finish(pending,null,failure.reason,Math.round(performance.now()-started));
      for(const next of this.queue.splice(0))this.finish(next,null,failure.reason);
    }finally {if(timer)clearTimeout(timer);this.abort=undefined;}
  }
  private recordUsage(raw:unknown,budgetDay:string,reserved:number):void {
    if(!obj(raw)||!obj(raw.usage))return;
    const input=raw.usage.input_tokens,output=raw.usage.output_tokens;
    if(!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0)return;
    // Attribute the call to its dispatch day, including responses straddling midnight.
    if(this.budget.day!==budgetDay)return;
    this.budget.knownTokens+=input+output;this.budget.unknownUsageCalls--;
    this.budget.reservedTokens=Math.max(0,this.budget.reservedTokens-reserved);this.setMeta('budget',this.budget);
  }
  private failure(error:unknown):{reason:string;cooldownMs:number} {
    const value=obj(error)?error:{};
    const codes=[value.code,value.error?.code,value.error?.type,value.body?.error?.code,value.body?.error?.type,value.body?.code,value.body?.type,value.body?.detail?.code]
      .filter((v):v is string=>typeof v==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(v)).map(v=>v.toLowerCase());
    const status=Number(value.status??value.statusCode);
    if(status===402||codes.some(v=>['insufficient_quota','insufficient_tokens','insufficient_credits','quota_exceeded','credit_balance_exhausted','out_of_credits','billing_hard_limit_reached'].includes(v)))
      return {reason:'JEV_QUOTA_EXHAUSTED',cooldownMs:3_600_000};
    if(status===401||status===403)return {reason:'JEV_AUTH_UNAVAILABLE',cooldownMs:3_600_000};
    if(codes.includes('jev_missing_api_key')||codes.includes('jev_config_error')||codes.includes('jev_client_unavailable'))
      return {reason:codes.includes('jev_missing_api_key')?'JEV_KEY_MISSING':'JEV_CLIENT_UNAVAILABLE',cooldownMs:3_600_000};
    if(status===429){
      let delay=value.retryAfterMs;
      if(!finite(delay)&&obj(value.headers)){
        const raw=typeof value.headers.get==='function'?value.headers.get('retry-after'):value.headers['retry-after'];
        if(typeof raw==='string'&&/^\d+(?:\.\d+)?$/.test(raw))delay=Number(raw)*1000;
        else if(typeof raw==='string'&&Number.isFinite(Date.parse(raw)))delay=Date.parse(raw)-this.now();
      }
      return {reason:'JEV_RATE_LIMITED',cooldownMs:finite(delay)?Math.min(3_600_000,Math.max(30_000,delay)):60_000};
    }
    if(codes.includes('jev_stopped'))return {reason:'JEV_STOPPED',cooldownMs:0};
    const reason=codes.includes('jev_timeout')||value.name==='APITimeoutError'?'JEV_TIMEOUT':
      codes.includes('jev_response_invalid')?'JEV_RESPONSE_INVALID':status>=400&&status<500?'JEV_REQUEST_REJECTED':
      status>=500?'JEV_PROVIDER_ERROR':'JEV_NETWORK_UNAVAILABLE';
    return {reason,cooldownMs:Math.min(900_000,30_000*2**Math.min(this.circuit.failures,5))};
  }
  private finish(pending:Pending,result:JevResult|null,reason:string|null,latencyMs:number|null=null):void {
    if(!this.db)return;
    try {
      const completedAt=iso(this.now()),comparison=emptyComparison(pending.input);
      const evidenceAvailable=result&&result.score!==null&&result.stance!=='insufficient';
      comparison.selected=evidenceAvailable&&comparison.eligible?result.stance==='support':null;
      if(!result)comparison.excludedReason=reason??'JEV_UNAVAILABLE';
      else if(!comparison.eligible)comparison.excludedReason='BASELINE_NOT_ELIGIBLE';
      else if(!evidenceAvailable)comparison.excludedReason='JEV_EVIDENCE_INSUFFICIENT';
      const retryAt=reason==='JEV_DAILY_CALL_BUDGET'||reason==='JEV_DAILY_TOKEN_BUDGET'?iso(nextDay(this.now())):reason?this.circuit.retryAt:null;
      this.db.prepare(`UPDATE jev_results SET completed_at=?,latency_ms=?,status=?,reason=?,retry_at=?,result=?,comparison=? WHERE id=? AND status='pending'`)
        .run(completedAt,latencyMs,result?'available':'unavailable',reason,retryAt,result?JSON.stringify(result):null,JSON.stringify(comparison),pending.id);
      this.lastCompletedAt=completedAt;this.setMeta('last_completed_at',completedAt);
    }catch {this.storageFailure();}
  }
  private prune():void {
    if(!this.db||this.now()<this.nextPrune)return;this.nextPrune=this.now()+60_000;
    const removed=this.db.prepare(`DELETE FROM jev_results WHERE status!='pending' AND (received_at<? OR id IN
      (SELECT id FROM jev_results ORDER BY received_at DESC,id LIMIT -1 OFFSET ?))`).run(iso(this.now()-RETENTION_MS),MAX_RECORDS-1);
    this.prunedRecords+=Number(removed.changes);this.setMeta('pruned_records',String(this.prunedRecords));
  }
  private item(row:Row,comparisonAt=this.now()):JevShadowItem {
    const comparison=parse<JevComparison>(row.comparison,{eligible:false,selected:null,sampleCount:0,method:'observed_price_gross',horizons:{'5':{status:'pending'},'15':{status:'pending'},'60':{status:'pending'}}});
    if(!comparison.excludedReason||comparison.excludedReason==='BASELINE_NOT_ELIGIBLE'){
      if(!comparison.baselineAt&&row.completed_at&&comparisonAt>Date.parse(row.completed_at)+BASELINE_WAIT_MS){
        comparison.trackingUnavailableReason='JEV_BASELINE_PRICE_MISSING';
        if(comparison.eligible)comparison.excludedReason='JEV_BASELINE_PRICE_MISSING';
      }
      if(comparison.baselineAt)for(const minutes of ['5','15','60'] as const)
        if(comparison.horizons[minutes].status==='pending'&&comparisonAt>Date.parse(comparison.baselineAt)+Number(minutes)*60_000+LATE_MS)
          comparison.horizons[minutes]={status:'missed'};
    }
    return {id:row.id,reportId:row.report_id,token:{chain:row.chain,address:row.address},...(row.name?{name:row.name}:{}),inputHash:row.input_hash,
      asOf:row.as_of,receivedAt:row.received_at,completedAt:row.completed_at,latencyMs:row.latency_ms,status:row.status,reason:row.reason,
      retryAt:row.retry_at,model:row.model,rubricVersion:row.rubric_version,result:parse<JevResult|null>(row.result,null),baseline:parse(row.baseline,{} as JevInput['baseline']),comparison};
  }
  list(options:{limit?:number;offset?:number;chain?:Chain}={}):JevShadowPage {
    const limit=Math.min(100,Math.max(1,Math.floor(options.limit??20))),offset=Math.max(0,Math.min(1_000_000,Math.floor(options.offset??0)));
    if(!this.db)return {items:[],total:0,limit,offset};
    try {
      const chain=['bsc','solana','robinhood'].includes(options.chain??'')?options.chain:undefined,where=chain?' WHERE chain=?':'',params=chain?[chain]:[];
      const total=Number(this.db.prepare(`SELECT count(*) AS n FROM jev_results${where}`).get(...params)!.n);
      const items=this.db.prepare(`SELECT * FROM jev_results${where} ORDER BY received_at DESC,id LIMIT ? OFFSET ?`).all(...params,limit,offset).map(row=>this.item(row));
      return {items,total,limit,offset};
    }catch {this.storageFailure();return {items:[],total:0,limit,offset};}
  }
  detail(id:string):(JevShadowItem&{input:JevInput;request:unknown})|undefined {
    if(!this.db||!/^[-A-Za-z0-9_]{1,128}$/.test(id))return;
    try {const row=this.db.prepare('SELECT * FROM jev_results WHERE id=?').get(id);return row?{...this.item(row),input:parse(row.input,{} as JevInput),request:parse(row.request,null)}:undefined;}
    catch {this.storageFailure();return;}
  }
  observePrice(sample:JevPriceSample):void {
    if(!this.db||this.closed)return;
    try {
      const now=this.now(),at=Date.parse(sample.observedAt),price=sample.priceUsd;
      if(!Number.isFinite(at)||at>now||now-at>BASELINE_WAIT_MS||!finite(price)||price<=0||price>1e15)return;
      const rows=this.db.prepare(`SELECT * FROM jev_results WHERE chain=? AND address=? AND status='available' AND completed_at<=?
        AND completed_at>=? ORDER BY completed_at,id LIMIT 120`).all(sample.token.chain,sample.token.address,iso(at),iso(now-4_020_000));
      for(const row of rows){
        const {comparison}=this.item(row,at);if(comparison.excludedReason&&comparison.excludedReason!=='BASELINE_NOT_ELIGIBLE'||
          comparison.trackingUnavailableReason||comparison.lastSampleAt&&at<=Date.parse(comparison.lastSampleAt))continue;
        if(comparison.baselineAt&&((comparison.baselineSource??null)!==(sample.source??null)||
          (comparison.baselinePoolAddress??null)!==(sample.poolAddress??null))){
          comparison.seriesMismatchCount=(comparison.seriesMismatchCount??0)+1;
          this.db.prepare('UPDATE jev_results SET comparison=? WHERE id=?').run(JSON.stringify(comparison),row.id);continue;
        }
        if(!comparison.baselineAt){
          if(at>Date.parse(String(row.completed_at))+BASELINE_WAIT_MS)continue;
          comparison.baselineAt=iso(at);comparison.baselinePriceUsd=price;comparison.peakPriceUsd=price;
          comparison.sampledMaxGainPct=0;comparison.sampledMaxDrawdownPct=0;
          comparison.baselineSource=sample.source;comparison.baselinePoolAddress=sample.poolAddress;
        }
        const elapsed=at-Date.parse(comparison.baselineAt),gain=(price/comparison.baselinePriceUsd!-1)*100;
        if(elapsed>3_600_000+LATE_MS){this.db.prepare('UPDATE jev_results SET comparison=? WHERE id=?').run(JSON.stringify(comparison),row.id);continue;}
        if(!Number.isFinite(gain))continue;
        comparison.peakPriceUsd=Math.max(comparison.peakPriceUsd!,price);
        comparison.sampledMaxGainPct=Math.max(comparison.sampledMaxGainPct!,gain);
        comparison.sampledMaxDrawdownPct=Math.max(comparison.sampledMaxDrawdownPct!,(1-price/comparison.peakPriceUsd)*100);
        comparison.sampleCount++;comparison.lastSampleAt=iso(at);
        for(const minutes of ['5','15','60'] as const){
          if(comparison.horizons[minutes].status!=='pending')continue;
          const due=Number(minutes)*60_000;
          if(elapsed>due+LATE_MS)comparison.horizons[minutes]={status:'missed'};
          else if(elapsed>=due)comparison.horizons[minutes]={status:'complete',at:iso(at),priceUsd:price,grossReturnPct:gain};
        }
        this.db.prepare('UPDATE jev_results SET comparison=? WHERE id=?').run(JSON.stringify(comparison),row.id);
      }
    }catch {this.storageFailure();}
  }
  status():JevShadowStatus {
    let usedBytes=0;const counts={total:0,available:0,unavailable:0,pending:0};
    const comparison:JevShadowStatus['comparison']={eligible:0,selected:0,rejected:0,excluded:0,priced:0,horizons:[]};
    try {
      this.refreshBudget();
      if(this.db){
        usedBytes=Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
        for(const row of this.db.prepare('SELECT status,count(*) AS n FROM jev_results GROUP BY status').all()){
          counts.total+=Number(row.n);if(row.status==='available'||row.status==='unavailable'||row.status==='pending')counts[row.status]+=Number(row.n);
        }
        const rows=this.db.prepare('SELECT comparison,completed_at FROM jev_results').all().map(row=>this.item(row).comparison);
        comparison.eligible=rows.filter(row=>row.eligible).length;
        comparison.selected=rows.filter(row=>row.eligible&&row.selected===true&&!row.excludedReason).length;
        comparison.rejected=rows.filter(row=>row.eligible&&row.selected===false&&!row.excludedReason).length;
        comparison.excluded=rows.filter(row=>!!row.excludedReason).length;comparison.priced=rows.filter(row=>!!row.baselineAt).length;
        for(const minutes of ['5','15','60'] as const){
          const paired=rows.filter(row=>row.eligible&&!row.excludedReason&&row.selected!==null&&row.horizons[minutes].status==='complete');
          const selected=paired.filter(row=>row.selected),mean=(items:JevComparison[])=>items.length?items.reduce((sum,row)=>sum+row.horizons[minutes].grossReturnPct!,0)/items.length:null;
          comparison.horizons.push({minutes:Number(minutes),pairs:paired.length,baselineMeanGrossPct:mean(paired),jevSelectedMeanGrossPct:mean(selected),
            selectedCount:selected.length,rejectedCount:paired.length-selected.length});
        }
      }
    }catch {this.storageFailure();}
    const budgetReason=this.budget.calls>=this.options.maxCallsPerDay?'JEV_DAILY_CALL_BUDGET':
      this.reservationBlockedDay===this.budget.day||this.budget.knownTokens+this.budget.reservedTokens>=this.options.maxTokensPerDay?'JEV_DAILY_TOKEN_BUDGET':null;
    const effectiveCircuit=budgetReason?{reason:budgetReason,retryAt:iso(nextDay(this.now())),failures:0}:{...this.circuit};
    const activeCircuit=effectiveCircuit.retryAt&&Date.parse(effectiveCircuit.retryAt)>this.now();
    return {enabled:this.options.enabled,mode:'shadow',running:this.running,available:!!this.db&&this.options.enabled&&this.running&&!activeCircuit&&
      !(this.providerPending&&!this.work)&&this.budget.calls<this.options.maxCallsPerDay&&this.budget.knownTokens+this.budget.reservedTokens<this.options.maxTokensPerDay,
      model:JEV_MODEL,rubricVersion:JEV_RUBRIC_VERSION,queueDepth:this.queue.length,inFlight:!!this.work,providerPending:this.providerPending,lastError:this.lastError,
      lastCompletedAt:this.lastCompletedAt,circuit:effectiveCircuit,budget:{...this.budget,maxCalls:this.options.maxCallsPerDay,maxTokens:this.options.maxTokensPerDay,accountBalanceKnown:false,timezone:'Asia/Shanghai'},
      counts,comparison,storage:{usedBytes,maxBytes:this.options.maxBytes,prunedRecords:this.prunedRecords,retentionDays:RETENTION_MS/86_400_000,maxRecords:MAX_RECORDS},
      limits:{timeoutMs:this.options.timeoutMs,minIntervalMs:this.options.minIntervalMs,perTokenIntervalMs:this.options.perTokenIntervalMs,queueLimit:QUEUE_LIMIT,
        queueExpiryMs:QUEUE_EXPIRY_MS,baselineWaitMs:BASELINE_WAIT_MS,horizonLateToleranceMs:LATE_MS}};
  }
}
