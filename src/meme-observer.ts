import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {chainAddress} from './chain-stream-store.js';
import {tokenDisplayText} from './token-display.js';
import type {Chain,Signal,Report} from './types.js';
import type {FollowupWalletEvidence} from './wallet-history.js';
import type {WalletScreeningReport} from './wallet-screening.js';
import {assessMeme,normalizeMemeMarket,sanitizeMemeMarketSample,type MemeMarketSample,type MemeAssessment} from './meme-assessment.js';
import type {MemeCatalystSnapshot} from './meme-catalyst.js';
import type {GmgnTokenSnapshot} from './providers/gmgn-safety.js';
import type {SourceCorroborationAssessment} from './source-corroboration.js';

type Token=Signal['token'];
type Row=Record<string,any>;
export interface MemePage {limit?:number;offset?:number;chain?:Chain;asOf?:string;}
export interface MemeObserverOptions {
  database:string;now?:()=>Date;maxActive?:number;activeWindowSec?:number;maxBytes?:number;
  marketBatch:(tokens:(Token&{poolAddress?:string})[],signal:AbortSignal)=>Promise<MemeMarketSample[]>;
  marketFallback?:(token:Token,signal:AbortSignal)=>Promise<MemeMarketSample|undefined>;
  catalyst?:(signal:Signal,abort:AbortSignal,context?:GmgnTokenSnapshot)=>Promise<MemeCatalystSnapshot>;
  walletEvidence?:(token:Token,now:Date,signal:Signal)=>{evidence?:FollowupWalletEvidence;setups?:WalletScreeningReport};
  cooldownUntil?:()=>number;
  corroboration?:(token:Token,now:Date)=>SourceCorroborationAssessment;
}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const parse=<T>(v:unknown):T|undefined=>{try{return v?JSON.parse(String(v)) as T:undefined;}catch{return;}};
const tokenKey=(t:Token)=>`${t.chain}:${t.address}`;
function validToken(token:Token):Token|undefined {
  if(!token||!['bsc','solana','robinhood'].includes(token.chain))return;
  const address=chainAddress(token.chain,token.address);
  if(!address||/^0x0{40}$/.test(address)||address==='11111111111111111111111111111111')return;
  return {chain:token.chain,address};
}
function time(value:unknown):number {return typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)?Date.parse(value):NaN;}
const iso=(n:number)=>new Date(n).toISOString();

/** Continuous observation, independent of entry eligibility and the control cohort.
 * Only supplied read functions are available. This class cannot place an order. */
export class MemeObserver {
  private readonly db:DatabaseSync;private readonly now:()=>Date;
  private readonly maxActive:number;private readonly windowMs:number;
  private running=false;private closed=false;private marketWork?:Promise<void>;private catalystWork?:Promise<void>;
  private timer?:ReturnType<typeof setTimeout>;private socialTimer?:ReturnType<typeof setTimeout>;
  private marketAbort?:AbortController;private socialAbort?:AbortController;
  private lastCycleAt?:string;private error?:string;private catalystError?:string;private nextPrune=0;private dexCooldown=0;
  constructor(private readonly options:MemeObserverOptions){
    this.now=options.now??(()=>new Date());this.maxActive=options.maxActive??180;this.windowMs=(options.activeWindowSec??7200)*1000;
    const maxBytes=options.maxBytes??1024*1024*1024;
    if(!Number.isInteger(this.maxActive)||this.maxActive<1||this.maxActive>300||this.windowMs<60000||this.windowMs>86400000||maxBytes<1048576)
      throw new Error('MEME_OBSERVER_CONFIG_INVALID');
    if(options.database!==':memory:')mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.database);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1500;
      CREATE TABLE IF NOT EXISTS meme_tokens(chain TEXT,address TEXT,first_seen_at TEXT NOT NULL,last_signal_at TEXT NOT NULL,
        signal TEXT NOT NULL,name TEXT,symbol TEXT,market_attempt_at TEXT,fallback_attempt_at TEXT,catalyst_attempt_at TEXT,last_sample_at TEXT,
        sample_count INTEGER NOT NULL DEFAULT 0,market TEXT,assessment TEXT,catalyst TEXT,social_context TEXT,wallet_context TEXT,gate TEXT,error TEXT,
        PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS meme_tokens_active ON meme_tokens(last_signal_at DESC);
      CREATE TABLE IF NOT EXISTS meme_signals(id TEXT PRIMARY KEY,observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meme_snapshots(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,observed_at TEXT NOT NULL,
        source TEXT NOT NULL,fingerprint TEXT UNIQUE,market TEXT,assessment TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS meme_snapshots_token ON meme_snapshots(chain,address,observed_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS meme_snapshots_time ON meme_snapshots(observed_at);
      CREATE TABLE IF NOT EXISTS meme_catalysts(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,observed_at TEXT NOT NULL,
        data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS meme_catalysts_token ON meme_catalysts(chain,address,observed_at DESC);
      CREATE TABLE IF NOT EXISTS meme_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(meme_snapshots)').all().some(row=>row.name==='corroboration'))
      this.db.exec('ALTER TABLE meme_snapshots ADD COLUMN corroboration TEXT');
    const pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    this.db.exec(`PRAGMA max_page_count=${Math.floor(maxBytes/pageSize)}`);
    if(options.database!==':memory:')chmodSync(options.database,0o600);
  }
  register(signal:Signal,receivedAt=this.now().toISOString(),display:{name?:string;symbol?:string}={}):boolean {
    if(this.closed)return false;
    const token=validToken(signal.token),at=time(receivedAt),now=this.now().getTime(),eventAt=time(signal.occurredAt);
    if(!token||!Number.isFinite(at)||at>now||!Number.isFinite(eventAt)||eventAt>now+30000||eventAt<now-this.windowMs)return false;
    const key=hash([signal.source,signal.sourceEventId,token]);
    this.db.exec('SAVEPOINT meme_register');
    try {
      const inserted=this.db.prepare('INSERT OR IGNORE INTO meme_signals VALUES (?,?)').run(key,receivedAt);
      if(!inserted.changes){this.db.exec('RELEASE meme_register');return false;}
      const clean:Signal={...signal,token,text:signal.text.slice(0,4000),evidenceUrls:signal.evidenceUrls.slice(0,12)};
      // Do not persist large optional raw narrative material in the discovery queue.
      delete clean.vendorNarrative;
      this.db.prepare(`INSERT INTO meme_tokens(chain,address,first_seen_at,last_signal_at,signal,name,symbol) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(chain,address) DO UPDATE SET last_signal_at=MAX(last_signal_at,excluded.last_signal_at),
        signal=CASE WHEN excluded.last_signal_at>=last_signal_at THEN excluded.signal ELSE signal END,
        name=COALESCE(excluded.name,name),symbol=COALESCE(excluded.symbol,symbol)`)
        .run(token.chain,token.address,receivedAt,receivedAt,JSON.stringify(clean),tokenDisplayText(display.name,100)??null,tokenDisplayText(display.symbol,32)??null);
      this.db.exec('RELEASE meme_register');return true;
    }catch(error){this.db.exec('ROLLBACK TO meme_register; RELEASE meme_register');throw error;}
  }
  captureReport(report:Report):void {
    if(this.closed||report.mode!=='live')return;
    this.register(report.signal,report.receivedAt);
    const token=validToken(report.signal.token);if(!token||!this.row(token))return;
    const gate={decision:report.decision,checkedAt:report.evaluatedAt,validUntil:report.validUntil,
      safety:report.safety.status,provenance:report.provenance.status,reasons:report.reasons.slice(0,12),reportId:report.id};
    this.db.prepare('UPDATE meme_tokens SET gate=? WHERE chain=? AND address=?').run(JSON.stringify(gate),token.chain,token.address);
    if(report.walletScreening)this.db.prepare('UPDATE meme_tokens SET wallet_context=? WHERE chain=? AND address=?')
      .run(JSON.stringify(report.walletScreening),token.chain,token.address);
    const info=report.gmgn?.info;
    if(report.gmgn?.token.chain===token.chain&&chainAddress(token.chain,report.gmgn.token.address)===token.address&&info){
      // Only bounded identity-bound project metadata is needed for weak social references.
      const raw=info as Record<string,unknown>,link=raw.link as Record<string,unknown>|undefined;
      if(typeof raw.address==='string'&&chainAddress(token.chain,raw.address)===token.address&&
        (raw.chain===undefined||raw.chain===(token.chain==='solana'?'sol':token.chain))&&link&&typeof link==='object'){
        const context:GmgnTokenSnapshot={token,fetchedAt:report.gmgn.fetchedAt,diagnostics:report.gmgn.diagnostics,
          info:{address:token.address,chain:token.chain==='solana'?'sol':token.chain,link:Object.fromEntries(
            ['twitter_username','website'].filter(key=>typeof link[key]==='string'&&(link[key] as string).length<=1000).map(key=>[key,link[key]]))}};
        this.db.prepare('UPDATE meme_tokens SET social_context=? WHERE chain=? AND address=?').run(JSON.stringify(context),token.chain,token.address);
      }
      const sample=normalizeMemeMarket(info,token,report.gmgn.fetchedAt);
      const previous=parse<MemeMarketSample>(this.row(token)?.market);
      if(sample&&(!previous||previous.source!=='dexscreener_pair'||this.now().getTime()-time(previous.observedAt)>120000))this.recordMarket(sample);
      if(sample)this.db.prepare('UPDATE meme_tokens SET name=COALESCE(?,name),symbol=COALESCE(?,symbol) WHERE chain=? AND address=?')
        .run(tokenDisplayText((info as any).name,100)??null,tokenDisplayText((info as any).symbol,32)??null,token.chain,token.address);
    }
  }
  private row(token:Token):Row|undefined {return this.db.prepare('SELECT * FROM meme_tokens WHERE chain=? AND address=?').get(token.chain,token.address);}
  private activeRows():Row[] {return this.db.prepare('SELECT * FROM meme_tokens WHERE last_signal_at>=? ORDER BY last_signal_at DESC,chain,address LIMIT ?')
    .all(iso(this.now().getTime()-this.windowMs),this.maxActive);}
  recordMarket(sample:MemeMarketSample):boolean {
    if(this.closed)return false;
    const token=validToken(sample.token),at=time(sample.observedAt),now=this.now().getTime();
    if(!token||!Number.isFinite(at)||at>now||now-at>120000||!Number.isFinite(sample.priceUsd)||(sample.priceUsd??0)<=0)return false;
    const validated=sanitizeMemeMarketSample(sample,token,now);if(!validated?.priceUsd)return false;sample=validated;
    const row=this.row(token);if(!row||row.last_sample_at&&row.last_sample_at>=sample.observedAt)return false;
    if(row.last_sample_at&&at-time(row.last_sample_at)<5000)return false;
    const samples=this.db.prepare('SELECT market FROM meme_snapshots WHERE chain=? AND address=? AND observed_at>=? AND observed_at<=? AND market IS NOT NULL ORDER BY observed_at DESC,id DESC LIMIT 120')
      .all(token.chain,token.address,iso(now-1800000),sample.observedAt).map(r=>parse<MemeMarketSample>(r.market)).filter((s):s is MemeMarketSample=>!!s).reverse();
    let evidence:ReturnType<NonNullable<MemeObserverOptions['walletEvidence']>>={};
    try {evidence=this.options.walletEvidence?.(token,this.now(),JSON.parse(row.signal))??{};}catch {/* Missing local evidence stays unknown. */}
    const assessment=assessMeme({token,now:this.now(),samples:[...samples,sample],
      catalyst:parse<MemeCatalystSnapshot>(row.catalyst),walletEvidence:evidence.evidence,walletSetups:evidence.setups??parse<WalletScreeningReport>(row.wallet_context),
      previous:parse<MemeAssessment>(row.assessment)});
    const fingerprint=hash([token,sample.source,sample.observedAt]);
    let corroboration:SourceCorroborationAssessment|undefined;
    try{corroboration=this.options.corroboration?.(token,new Date(assessment.assessedAt));}catch{/* Unknown source coverage never alters safety or score. */}
    this.db.exec('SAVEPOINT meme_market');
    try {
      this.db.prepare('INSERT INTO meme_snapshots(chain,address,observed_at,source,fingerprint,market,assessment,corroboration) VALUES(?,?,?,?,?,?,?,?)')
        .run(token.chain,token.address,sample.observedAt,sample.source,fingerprint,JSON.stringify(sample),JSON.stringify(assessment),corroboration?JSON.stringify(corroboration):null);
      this.db.prepare('UPDATE meme_tokens SET market=?,assessment=?,last_sample_at=?,sample_count=sample_count+1,error=NULL WHERE chain=? AND address=?')
        .run(JSON.stringify(sample),JSON.stringify(assessment),sample.observedAt,token.chain,token.address);
      this.db.exec('RELEASE meme_market');return true;
    }catch(error){this.db.exec('ROLLBACK TO meme_market; RELEASE meme_market');throw error;}
  }
  recordCatalyst(snapshot:MemeCatalystSnapshot):void {
    const token=validToken(snapshot.token),at=time(snapshot.observedAt),now=this.now().getTime();
    if(this.closed||!token||!this.row(token)||!Number.isFinite(at)||at>now||now-at>120000||!Number.isFinite(time(snapshot.expiresAt))||time(snapshot.expiresAt)<=now)return;
    const previous=parse<MemeCatalystSnapshot>(this.row(token)?.catalyst);if(previous&&time(previous.observedAt)>=at)return;
    this.db.exec('SAVEPOINT meme_catalyst');
    try {
      this.db.prepare('INSERT INTO meme_catalysts(chain,address,observed_at,data) VALUES(?,?,?,?)').run(token.chain,token.address,this.now().toISOString(),JSON.stringify(snapshot));
      this.db.prepare('UPDATE meme_tokens SET catalyst=? WHERE chain=? AND address=?').run(JSON.stringify(snapshot),token.chain,token.address);
      this.db.exec('RELEASE meme_catalyst');
    }catch(error){this.db.exec('ROLLBACK TO meme_catalyst; RELEASE meme_catalyst');throw error;}
  }
  private project(row:Row,active:Set<string>,full=false){
    const token={chain:row.chain as Chain,address:String(row.address)},now=this.now().getTime();
    const catalyst=parse<MemeCatalystSnapshot>(row.catalyst);
    let corroboration:SourceCorroborationAssessment|undefined;
    try{corroboration=this.options.corroboration?.(token,this.now());}catch{/* Independent source history remains optional. */}
    return {...token,name:row.name??undefined,symbol:row.symbol??undefined,firstSeenAt:row.first_seen_at,lastSignalAt:row.last_signal_at,
      corroboration,
      lastSampleAt:row.last_sample_at??undefined,nextSampleAt:row.market_attempt_at?iso(time(row.market_attempt_at)+30000):undefined,
      observationState:time(row.last_signal_at)<now-this.windowMs?'expired':active.has(tokenKey(token))?'active':'waiting',
      sampleCount:Number(row.sample_count),stale:!row.last_sample_at||now-time(row.last_sample_at)>120000,
      assessment:parse<MemeAssessment>(row.assessment),market:parse<MemeMarketSample>(row.market),gate:parse(row.gate),
      ...(full?{catalyst}:catalyst?{catalyst:{status:catalyst.status,observedAt:catalyst.observedAt,expiresAt:catalyst.expiresAt,reasons:catalyst.reasons,
        supplier:catalyst.supplier?{provider:catalyst.supplier.provider,summary:catalyst.supplier.summary,fresh:catalyst.supplier.fresh,generatedAt:catalyst.supplier.generatedAt}:undefined,
        diffusion:catalyst.diffusion,celebrities:catalyst.celebrities,sourceTweetCount:catalyst.sourceTweetCount,
        evidence:{requestedPostCount:catalyst.evidence.requestedPostCount,retrievedPostCount:catalyst.evidence.retrievedPostCount}}}:{}),error:row.error??undefined};
  }
  private pageArgs(options:MemePage){
    const {limit=20,offset=0,asOf=this.now().toISOString(),chain}=options;
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000||!Number.isFinite(time(asOf))||iso(time(asOf))!==asOf||chain&&!['bsc','solana','robinhood'].includes(chain))throw new Error('INVALID_FILTER');
    return {limit,offset,asOf,chain};
  }
  list(options:MemePage={}) {
    const {limit,offset,asOf,chain}=this.pageArgs(options),args=[asOf,...(chain?[chain]:[])],where='first_seen_at<=?'+(chain?' AND chain=?':'');
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM meme_tokens WHERE ${where}`).get(...args)!.n);
    // first_seen_at is immutable, so arriving alerts cannot reshuffle historical pages.
    const rows=this.db.prepare(`SELECT * FROM meme_tokens WHERE ${where} ORDER BY first_seen_at DESC,chain,address LIMIT ? OFFSET ?`).all(...args,limit,offset);
    const active=new Set(this.activeRows().map(row=>tokenKey({chain:row.chain,address:row.address})));
    return {now:this.now().toISOString(),asOf,total,limit,offset,hasMore:offset+rows.length<total,status:this.status(),items:rows.map(row=>this.project(row,active))};
  }
  detail(input:Token,options:MemePage={}) {
    const token=validToken(input);if(!token)throw new Error('INVALID_FILTER');
    const {limit,offset,asOf}=this.pageArgs(options),row=this.row(token);
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM meme_snapshots WHERE chain=? AND address=? AND observed_at<=? AND json_extract(assessment,'$.assessedAt')<=?`).get(token.chain,token.address,asOf,asOf)!.n);
    const rows=this.db.prepare(`SELECT * FROM meme_snapshots WHERE chain=? AND address=? AND observed_at<=? AND json_extract(assessment,'$.assessedAt')<=? ORDER BY observed_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(token.chain,token.address,asOf,asOf,limit,offset);
    const active=new Set(this.activeRows().map(r=>tokenKey({chain:r.chain,address:r.address})));
    return {token:row?this.project(row,active,true):{...token,observationState:'waiting',sampleCount:0},asOf,total,limit,offset,hasMore:offset+rows.length<total,
      items:rows.map(r=>({id:r.id,observedAt:r.observed_at,source:r.source,market:parse(r.market),assessment:parse(r.assessment),
        corroboration:parse<SourceCorroborationAssessment>(r.corroboration),
        outcomes:this.outcomes(r,asOf)})),catalystHistory:this.db.prepare('SELECT observed_at,data FROM meme_catalysts WHERE chain=? AND address=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 6')
        .all(token.chain,token.address,asOf).map(r=>({observedAt:r.observed_at,snapshot:parse(r.data)}))};
  }
  private outcomes(row:Row,asOf:string){
    const market=parse<MemeMarketSample>(row.market),result:{horizonSec:number;returnPct:number|null;observedAt?:string}[]=[];
    for(const seconds of [300,900,3600]){
      const target=time(parse<MemeAssessment>(row.assessment)?.assessedAt??row.observed_at)+seconds*1000;
      const future=this.db.prepare(`SELECT observed_at,market FROM meme_snapshots WHERE chain=? AND address=? AND source=? AND observed_at>=? AND observed_at<=? AND observed_at<=? AND json_extract(assessment,'$.assessedAt')<=? ORDER BY observed_at LIMIT 1`)
        .get(row.chain,row.address,row.source,iso(target),iso(target+120000),asOf,asOf);
      const sample=parse<MemeMarketSample>(future?.market);
      const pct=sample&&market?.priceUsd&&sample.priceUsd&&!!market.poolAddress&&sample.poolAddress===market.poolAddress?(sample.priceUsd/market.priceUsd-1)*100:null;
      result.push({horizonSec:seconds,returnPct:pct!==null&&Number.isFinite(pct)?pct:null,...(pct!==null?{observedAt:String(future!.observed_at)}:{})});
    }
    return {scope:'subsequent_observed_prices',notTradingReturn:true,items:result};
  }
  status(){
    const recent=Number(this.db.prepare('SELECT count(*) AS n FROM meme_tokens WHERE last_signal_at>=?').get(iso(this.now().getTime()-this.windowMs))!.n);
    const active=this.activeRows(),fresh=active.filter(row=>row.last_sample_at&&this.now().getTime()-time(row.last_sample_at)<=120000).length;
    const catalysts=active.map(row=>parse<MemeCatalystSnapshot>(row.catalyst)),now=this.now().getTime();
    const catalystFresh=catalysts.filter(c=>c&&c.status!=='unknown'&&time(c.expiresAt)>now).length;
    const catalystPending=catalysts.filter(c=>!c).length,catalystUnknown=catalysts.filter(c=>c?.status==='unknown').length;
    return {enabled:true,running:this.running,active:active.length,waiting:Math.max(0,recent-active.length),fresh,stale:active.length-fresh,
      catalystFresh,catalystPending,catalystUnknown,catalystStale:active.length-catalystFresh-catalystPending-catalystUnknown,
      catalystMinRetrySec:600,catalystQueueIntervalSec:15,
      maxActive:this.maxActive,activeWindowSec:this.windowMs/1000,intervalSec:5,targetSampleIntervalSec:30,
      lastCycleAt:this.lastCycleAt,error:this.catalystError??this.error,marketInFlight:!!this.marketWork,catalystInFlight:!!this.catalystWork,
      experimental:true,tradingEnabled:false,retentionDays:30,maxSnapshots:250000,learningScope:'frozen_features_and_subsequent_sampled_returns'};
  }
  runOnce():Promise<void>{
    if(this.marketWork)return this.marketWork;if(this.closed)return Promise.resolve();
    this.marketAbort=new AbortController();const signal=this.marketAbort.signal;
    this.marketWork=this.collect(signal).catch(()=>{this.error='MEME_OBSERVATION_UNAVAILABLE';})
      .finally(()=>{this.marketWork=undefined;this.marketAbort=undefined;});return this.marketWork;
  }
  private async collect(signal:AbortSignal){
    const now=this.now().getTime();this.prune();if(this.dexCooldown>now)return;
    const due=this.activeRows().filter(r=>!r.market_attempt_at||now-time(r.market_attempt_at)>=30000)
      .sort((a,b)=>String(a.market_attempt_at??'').localeCompare(String(b.market_attempt_at??''))||String(b.last_signal_at).localeCompare(String(a.last_signal_at)));
    const first=due[0];if(!first)return;
    const rows=due.filter(row=>row.chain===first.chain).slice(0,30);
    for(const row of rows)this.db.prepare('UPDATE meme_tokens SET market_attempt_at=? WHERE chain=? AND address=?').run(iso(now),row.chain,row.address);
    let samples:MemeMarketSample[]=[];
    try {samples=await this.options.marketBatch(rows.map(row=>({chain:row.chain,address:row.address,poolAddress:parse<MemeMarketSample>(row.market)?.poolAddress})),signal);}
    catch(error){if(error instanceof Error&&error.message==='MEME_MARKET_RATE_LIMITED')this.dexCooldown=now+60000;this.error='MEME_MARKET_BATCH_UNAVAILABLE';}
    if(signal.aborted||this.closed)return;
    const requested=new Set(rows.map(row=>tokenKey({chain:row.chain,address:row.address}))),received=new Set<string>();
    for(const sample of samples){
      if(requested.has(tokenKey(sample.token))){if(this.recordMarket(sample))received.add(tokenKey(sample.token));}
      await new Promise<void>(resolve=>setImmediate(resolve));if(signal.aborted||this.closed)return;
    }
    const missing=rows.filter(row=>!received.has(tokenKey({chain:row.chain,address:row.address})));
    if(missing.length&&this.options.marketFallback&&(this.options.cooldownUntil?.()??0)<=this.now().getTime()){
      const row=missing.sort((a,b)=>String(a.fallback_attempt_at??'').localeCompare(String(b.fallback_attempt_at??'')))[0];
      this.db.prepare('UPDATE meme_tokens SET fallback_attempt_at=? WHERE chain=? AND address=?').run(this.now().toISOString(),row.chain,row.address);
      try {const sample=await this.options.marketFallback({chain:row.chain,address:row.address},signal);if(!signal.aborted&&sample&&sample.token.chain===row.chain&&sample.token.address===row.address&&this.recordMarket(sample))received.add(tokenKey(sample.token));}
      catch {/* Shared GMGN budget or unsupported assets remain explicitly uncovered. */}
    }
    if(signal.aborted||this.closed)return;
    for(const row of rows)if(!received.has(tokenKey({chain:row.chain,address:row.address})))
      this.db.prepare("UPDATE meme_tokens SET error='MEME_MARKET_UNAVAILABLE' WHERE chain=? AND address=?").run(row.chain,row.address);
    if(received.size)this.error=undefined;
    this.lastCycleAt=this.now().toISOString();this.prune();
  }
  runCatalystOnce():Promise<void>{
    if(this.catalystWork)return this.catalystWork;if(this.closed||!this.options.catalyst)return Promise.resolve();
    this.socialAbort=new AbortController();const abort=this.socialAbort.signal;
    this.catalystWork=this.collectCatalyst(abort).catch(()=>{this.catalystError='MEME_CATALYST_UNAVAILABLE';})
      .finally(()=>{this.catalystWork=undefined;this.socialAbort=undefined;});
    return this.catalystWork;
  }
  private async collectCatalyst(abort:AbortSignal):Promise<void>{
    const now=this.now().getTime(),row=this.activeRows().filter(r=>!r.catalyst_attempt_at||now-time(r.catalyst_attempt_at)>=600000)
      .sort((a,b)=>String(a.catalyst_attempt_at??'').localeCompare(String(b.catalyst_attempt_at??''))||String(b.last_signal_at).localeCompare(String(a.last_signal_at)))[0];
    if(!row)return;
    this.db.prepare('UPDATE meme_tokens SET catalyst_attempt_at=? WHERE chain=? AND address=?').run(iso(now),row.chain,row.address);
    const snapshot=await this.options.catalyst!(JSON.parse(row.signal),abort,parse<GmgnTokenSnapshot>(row.social_context));
    if(!abort.aborted&&!this.closed&&snapshot.token.chain===row.chain&&snapshot.token.address===row.address){
      this.recordCatalyst(snapshot);this.catalystError=undefined;
    }
  }
  private prune(){
    const now=this.now().getTime();if(now<this.nextPrune)return;this.nextPrune=now+60000;
    this.db.prepare('DELETE FROM meme_snapshots WHERE observed_at<?').run(iso(now-30*86400000));
    this.db.exec('DELETE FROM meme_snapshots WHERE id IN (SELECT id FROM meme_snapshots ORDER BY id DESC LIMIT -1 OFFSET 250000)');
    this.db.prepare('DELETE FROM meme_catalysts WHERE observed_at<?').run(iso(now-30*86400000));
    this.db.exec('DELETE FROM meme_catalysts WHERE id IN (SELECT id FROM meme_catalysts ORDER BY id DESC LIMIT -1 OFFSET 20000)');
    this.db.prepare('DELETE FROM meme_signals WHERE observed_at<?').run(iso(now-30*86400000));
    this.db.prepare('DELETE FROM meme_tokens WHERE last_signal_at<?').run(iso(now-30*86400000));
  }
  start(){
    if(this.running||this.closed)return;this.running=true;
    const tick=()=>{if(!this.running)return;void this.runOnce().finally(()=>{if(this.running){this.timer=setTimeout(tick,5000);this.timer.unref();}});};
    const social=()=>{if(!this.running)return;void this.runCatalystOnce().finally(()=>{if(this.running){this.socialTimer=setTimeout(social,15000);this.socialTimer.unref();}});};
    tick();social();
  }
  async close(){if(this.closed)return;this.running=false;clearTimeout(this.timer);clearTimeout(this.socialTimer);
    this.marketAbort?.abort();this.socialAbort?.abort();await Promise.all([this.marketWork,this.catalystWork]);this.closed=true;this.db.close();}
}
