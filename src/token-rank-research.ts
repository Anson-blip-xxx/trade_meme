import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,mkdirSync,realpathSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import type {Chain} from './types.js';

type Row=Record<string,any>;
type Token={chain:Chain;address:string};
export interface TokenRankAnchor {
  eventAt:string;knownAt:string;evidenceId:string;scope:string;url?:string;fetchedAt?:string;
  status?:'current'|'retained'|'conflict';
}
export interface TokenRankObservation {observedAt:string;rank:number;source:string;evidenceId:string;}
export interface TokenRankComparison {
  position:'before'|'at_or_after'|'unknown';knowledge:'observed_before_anchor'|'historical_backfill'|'unknown';
  deltaSec:number|null;anchor?:TokenRankAnchor;
}
export interface TokenRankEntry {
  eventAt:string;observedAt:string;txHash:string;source:string;evidenceId:string;
  verification:'vendor_transaction_reference';retained?:boolean;
}
export interface TokenRankPnl {
  realizedProfitUsd:number|null;unrealizedProfitUsd:number|null;totalProfitUsd:number|null;
  observedAt:string;source:string;vendorRank:number;rankScope:string;
  verification:'vendor_claim';scope:'token_cumulative';vendorFirstAcquiredAt?:string;retained?:boolean;
}
export interface TokenRankWallet {
  chain:Chain;address:string;tokenAddress:string;entry?:TokenRankEntry;
  comparisons:{rank:TokenRankComparison;signal:TokenRankComparison;caPost:TokenRankComparison};
  pnl?:TokenRankPnl;limitations:string[];excludedBuyTransactions?:string[];
}
export interface TokenRankToken extends Token {
  name?:string;symbol?:string;
  firstRank:TokenRankObservation;latestRank:TokenRankObservation;registeredAt:string;computedAt:string;
  firstSignal?:TokenRankAnchor;caPost?:TokenRankAnchor;walletCount:number;entryCount:number;
  earliestEntry?:TokenRankEntry&{wallet:string};topRealized?:{wallet:string;realizedProfitUsd:number;observedAt:string};
  coverage:{rankSnapshots:number;traderRows:number;traderWallets:number;tradeRows:number;tradeWallets:number;
    postCount:number;truncated:boolean;limitations:string[]};
  researchOnly:true;scoreEffect:0;
}
export interface TokenRankWalletSummary extends Token {
  computedAt:string;tokenCount:number;entryTokenCount:number;earlyTokenCount:number;observedEarlyTokenCount:number;
  retrospectiveEarlyTokenCount:number;realizedCoverage:number;positiveRealizedTokens:number;negativeRealizedTokens:number;
  zeroRealizedTokens:number;unknownRealizedTokens:number;earlyPositiveRealizedTokens:number;
  realizedProfitUsd:number|null;unrealizedProfitUsd:number|null;totalProfitUsd:number|null;
  roiPct:null;largestPositiveRealizedShare:number|null;
  pnlWindow:{oldestAt:string;newestAt:string}|null;researchOnly:true;scoreEffect:0;limitations:string[];
}
export interface TokenRankResearchPage {chain?:Chain;limit?:number;offset?:number;asOf?:string;}
export interface TokenRankWalletPage extends TokenRankResearchPage {sort?:'early'|'realized';}
export interface TokenRankResearchOptions {
  database:string;historyDatabase:string;memeDatabase?:string;sourceDatabase?:string;maxBytes?:number;now?:()=>Date;
}
const KINDS=['token_rank','token_trader','trade'] as const,MAX_TOKEN_BATCH=8,MAX_SOURCE_ROWS=500,MAX_WALLETS=200;
const CAPACITY='TOKEN_RANK_RESEARCH_CAPACITY_REACHED';
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const parse=(v:unknown):any=>{try{return typeof v==='string'?JSON.parse(v):undefined;}catch{return undefined;}};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const canonical=(path:string)=>path===':memory:'?path:existsSync(path)?realpathSync(path):resolve(path);
const sameFile=(a:string,b:string)=>canonical(a)===canonical(b)||a!==':memory:'&&b!==':memory:'&&existsSync(a)&&existsSync(b)&&
  statSync(a).dev===statSync(b).dev&&statSync(a).ino===statSync(b).ino;
function stamp(value:unknown):value is string {
  return typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&
    Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
}
function address(value:unknown,chain:unknown,transaction=false):string|undefined {
  if(typeof value!=='string'||!['bsc','solana','robinhood'].includes(String(chain)))return;
  if(chain!=='solana')return new RegExp(`^0x[0-9a-f]{${transaction?64:40}}$`,'i').test(value)&&
    !/^0x0+$/i.test(value)?value.toLowerCase():undefined;
  try {const b=bs58.decode(value);return value.length<=(transaction?88:44)&&b.length===(transaction?64:32)&&b.some(n=>n)?value:undefined;}catch{return;}
}
function token(chain:unknown,value:unknown):Token|undefined {const a=address(value,chain);return a?{chain:chain as Chain,address:a}:undefined;}
function finite(value:unknown):number|null {
  if(typeof value!=='number'&&!(typeof value==='string'&&value.length<=100&&/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)))return null;
  const n=Number(value);return Number.isFinite(n)&&Math.abs(n)<=Number.MAX_SAFE_INTEGER?n:null;
}
function source(value:unknown):value is string {return typeof value==='string'&&/^[a-z][a-z0-9_.:-]{0,79}$/.test(value);}
function compare(entry:TokenRankEntry|undefined,anchor:TokenRankAnchor|undefined):TokenRankComparison {
  if(!entry||!anchor||anchor.status==='conflict')return {position:'unknown',knowledge:'unknown',deltaSec:null,...(anchor?{anchor}:{})};
  return {position:entry.eventAt<anchor.eventAt?'before':'at_or_after',
    knowledge:entry.observedAt<=anchor.eventAt?'observed_before_anchor':'historical_backfill',
    deltaSec:(Date.parse(entry.eventAt)-Date.parse(anchor.eventAt))/1000,anchor};
}
function rank(row:Row,now:string,target?:Token):TokenRankObservation|undefined {
  const d=parse(row.data),t=token(row.chain,row.token_address);
  if(!t||target&&(t.chain!==target.chain||t.address!==target.address)||!object(d)||d.chain!==t.chain||
    address(d.address,t.chain)!==t.address||d.interval!=='1h'||d.changeUnit!=='vendor_unspecified'||
    !Number.isInteger(d.rank)||d.rank<1||d.rank>200||!stamp(d.observedAt)||d.observedAt>now||
    row.observed_at!==d.observedAt||row.source!==d.source||!source(d.source))return;
  return {observedAt:d.observedAt,rank:d.rank,source:d.source,evidenceId:String(row.id)};
}
function entry(row:Row,target:Token,now:string):{wallet:string;entry:TokenRankEntry;eventKey:string}|undefined {
  const d=parse(row.data),wallet=object(d)?address(d.wallet,target.chain):undefined;
  const tx=object(d)?address(d.txHash,target.chain,true):undefined;
  if(!object(d)||!wallet||!tx||wallet===target.address||row.kind!=='trade'||row.chain!==target.chain||d.chain!==target.chain||
    address(row.wallet,target.chain)!==wallet||address(row.token_address,target.chain)!==target.address||
    address(d.tokenAddress,target.chain)!==target.address||d.side!=='buy'||!stamp(d.eventAt)||!stamp(d.observedAt)||
    d.eventAt>d.observedAt||d.observedAt>now||row.observed_at!==d.observedAt||row.source!==d.source||!source(d.source))return;
  return {wallet,entry:{eventAt:d.eventAt,observedAt:d.observedAt,txHash:tx,source:d.source,evidenceId:String(row.id),
    verification:'vendor_transaction_reference'},eventKey:JSON.stringify([wallet,tx])};
}
function pnl(row:Row,target:Token,now:string):{wallet:string;pnl:TokenRankPnl}|undefined {
  const d=parse(row.data),wallet=object(d)?address(d.wallet,target.chain):undefined;
  if(!object(d)||!wallet||wallet===target.address||row.chain!==target.chain||d.chain!==target.chain||
    address(row.wallet,target.chain)!==wallet||address(row.token_address,target.chain)!==target.address||
    address(d.tokenAddress,target.chain)!==target.address||d.scope!=='token_cumulative'||d.verification!=='vendor_claim'||
    !stamp(d.observedAt)||d.observedAt>now||row.observed_at!==d.observedAt||row.source!==d.source||!source(d.source)||
    !Number.isInteger(d.rank)||d.rank<1||d.rank>200)return;
  return {wallet,pnl:{realizedProfitUsd:finite(d.realizedProfitUsd),unrealizedProfitUsd:finite(d.unrealizedProfitUsd),
    totalProfitUsd:finite(d.profitUsd),observedAt:d.observedAt,source:d.source,vendorRank:d.rank,
    rankScope:['vendor_profit_order','vendor_unrealized_profit_order','vendor_buy_volume_order','vendor_sell_volume_order'].includes(d.rankScope)?d.rankScope:'vendor_order_unspecified',
    verification:'vendor_claim',scope:'token_cumulative',...(stamp(d.firstAcquiredAt)&&d.firstAcquiredAt<=d.observedAt?{vendorFirstAcquiredAt:d.firstAcquiredAt}:{})}};
}
function readonly(path:string):DatabaseSync {const db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');return db;}
const bytes=(db:DatabaseSync)=>Number(db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.prepare('PRAGMA page_size').get()!.page_size);
const bounds=(v:unknown,fallback:number,max:number)=>typeof v==='number'&&Number.isSafeInteger(v)?Math.max(1,Math.min(max,v)):fallback;

/** Derived research only. Sources are opened read-only; runBatch belongs in a worker. */
export class TokenRankResearch {
  private readonly history:DatabaseSync;private readonly db:DatabaseSync;private meme?:DatabaseSync;private signals?:DatabaseSync;
  private readonly now:()=>Date;private readonly maxBytes:number;private error?:string;private closed=false;
  constructor(private readonly options:TokenRankResearchOptions){
    this.now=options.now??(()=>new Date());this.maxBytes=options.maxBytes??256*1024*1024;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1048576||
      [options.historyDatabase,options.memeDatabase,options.sourceDatabase].some(p=>p&&sameFile(options.database,p)))throw new Error('TOKEN_RANK_RESEARCH_CONFIG_INVALID');
    this.history=readonly(options.historyDatabase);
    if(options.database!==':memory:')mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.database);if(options.database!==':memory:')chmodSync(options.database,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA wal_autocheckpoint=64;
      CREATE TABLE IF NOT EXISTS tr_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tr_tokens(chain TEXT,address TEXT,registered_at TEXT,first_rank TEXT,latest_rank TEXT,
        rank_count INTEGER DEFAULT 0,dirty INTEGER DEFAULT 1,refreshed_at TEXT,input_hash TEXT,PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS tr_tokens_dirty ON tr_tokens(dirty,refreshed_at);
      CREATE INDEX IF NOT EXISTS tr_tokens_first ON tr_tokens(registered_at,chain,address);
      CREATE TABLE IF NOT EXISTS tr_token_versions(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,computed_at TEXT,data TEXT NOT NULL,wallets TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tr_token_versions_lookup ON tr_token_versions(chain,address,computed_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS tr_wallet_current(chain TEXT,address TEXT,token_address TEXT,data TEXT NOT NULL,PRIMARY KEY(chain,address,token_address));
      CREATE INDEX IF NOT EXISTS tr_wallet_current_token ON tr_wallet_current(chain,token_address);
      CREATE TABLE IF NOT EXISTS tr_wallet_versions(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,computed_at TEXT,early_count INTEGER,
        realized REAL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tr_wallet_versions_lookup ON tr_wallet_versions(chain,address,computed_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS tr_wallets(chain TEXT,address TEXT,registered_at TEXT,PRIMARY KEY(chain,address));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS tr_wallet_tokens(chain TEXT,address TEXT,token_address TEXT,registered_at TEXT,PRIMARY KEY(chain,address,token_address));
      CREATE TABLE IF NOT EXISTS tr_wallet_token_versions(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,token_address TEXT,computed_at TEXT,present INTEGER,data TEXT);
      CREATE INDEX IF NOT EXISTS tr_wallet_token_versions_lookup ON tr_wallet_token_versions(chain,address,token_address,computed_at DESC,id DESC);`);
    const columns=this.db.prepare('PRAGMA table_info(tr_tokens)').all();
    if(!columns.some(c=>c.name==='dirty_live'))this.db.exec('ALTER TABLE tr_tokens ADD COLUMN dirty_live INTEGER NOT NULL DEFAULT 0');
    if(!columns.some(c=>c.name==='live_at'))this.db.exec('ALTER TABLE tr_tokens ADD COLUMN live_at TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS tr_tokens_live ON tr_tokens(dirty_live,live_at)');
    const oldMax=Number(this.meta('max_bytes'));this.setMeta('max_bytes',String(this.maxBytes));
    if(this.meta('error')===CAPACITY&&this.maxBytes>oldMax&&bytes(this.db)+65536<this.maxBytes)this.setMeta('error','');
    this.error=this.meta('error')||undefined;
    for(const kind of KINDS)if(!this.meta(`${kind}_ceiling`)){
      const max=Number(this.history.prepare('SELECT rowid AS id FROM wh_observations INDEXED BY wh_observations_kind WHERE kind=? ORDER BY rowid DESC LIMIT 1').get(kind)?.id??0);
      this.setMeta(`${kind}_ceiling`,String(max));this.setMeta(`${kind}_live`,String(max));this.setMeta(`${kind}_initial`,kind==='token_rank'?'0':String(max));
      if(kind!=='token_rank')this.setMeta(`${kind}_complete`,'1');
    }
    if(!this.meta('rank_history_total'))this.setMeta('rank_history_total',String(this.history.prepare(
      "SELECT count(*) AS n FROM wh_observations INDEXED BY wh_observations_kind WHERE kind='token_rank' AND rowid<=?").get(Number(this.meta('token_rank_ceiling')))!.n));
    this.openOptional();
  }
  private openOptional(){
    if(!this.meme&&this.options.memeDatabase&&existsSync(this.options.memeDatabase))this.meme=readonly(this.options.memeDatabase);
    if(!this.signals&&this.options.sourceDatabase&&existsSync(this.options.sourceDatabase))this.signals=readonly(this.options.sourceDatabase);
  }
  private meta(key:string){return String(this.db.prepare('SELECT value FROM tr_meta WHERE key=?').get(key)?.value??'');}
  private setMeta(key:string,value:string){this.db.prepare('INSERT INTO tr_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  runBatch(limit=500){
    if(this.closed)throw new Error('TOKEN_RANK_RESEARCH_CLOSED');if(this.error===CAPACITY)return this.status();
    this.openOptional();const now=this.now().toISOString(),n=bounds(limit,500,5000),perLane=Math.max(1,Math.floor(n/6));
    if(!stamp(now))throw new Error('TOKEN_RANK_RESEARCH_CLOCK_INVALID');
    const sources=[this.history,...(this.meme?[this.meme]:[]),...(this.signals?[this.signals]:[])];let writing=false;
    try {
      for(const db of sources)db.exec('BEGIN');
      this.db.exec('BEGIN IMMEDIATE');writing=true;
      const previousTokenVersion=Number(this.db.prepare('SELECT max(id) AS n FROM tr_token_versions').get()!.n??0),
        previousWalletVersion=Number(this.db.prepare('SELECT max(id) AS n FROM tr_wallet_versions').get()!.n??0),
        previousWalletTokenVersion=Number(this.db.prepare('SELECT max(id) AS n FROM tr_wallet_token_versions').get()!.n??0),
        previousToken=Number(this.db.prepare('SELECT max(rowid) AS n FROM tr_tokens').get()!.n??0),
        previousWallet=Number(this.db.prepare('SELECT max(rowid) AS n FROM tr_wallets').get()!.n??0),
        previousWalletToken=Number(this.db.prepare('SELECT max(rowid) AS n FROM tr_wallet_tokens').get()!.n??0);
      if(bytes(this.db)+65536>=this.maxBytes)throw new Error(CAPACITY);
      for(const kind of KINDS)for(const lane of ['live','initial'] as const){
        // Each token computation already reads its indexed historical trade/trader sample.
        // Only rank history discovers tokens; replaying every old global trade adds no coverage.
        if(lane==='initial'&&kind!=='token_rank')continue;
        const cursor=Number(this.meta(`${kind}_${lane}`)||0),ceiling=Number(this.meta(`${kind}_ceiling`));
        const laneLimit=lane==='initial'?Math.max(1,n-perLane*3):perLane;
        const rows=this.history.prepare(`SELECT rowid AS cursor,* FROM wh_observations INDEXED BY wh_observations_kind
          WHERE kind=? AND rowid>? ${lane==='initial'?'AND rowid<=?':''} ORDER BY rowid LIMIT ?`)
          .all(kind,cursor,...(lane==='initial'?[ceiling]:[]),laneLimit);
        for(const row of rows)this.ingest(row,now,lane==='live');
        if(kind==='token_rank'&&lane==='initial')this.setMeta('rank_history_processed',String(Number(this.meta('rank_history_processed')||0)+rows.length));
        if(rows.length)this.setMeta(`${kind}_${lane}`,String(rows.at(-1)!.cursor));
        if(lane==='initial'&&rows.length<laneLimit)this.setMeta(`${kind}_complete`,'1');
      }
      // Source post/signal arrivals have independent clocks. Revisit a small bounded due set as well.
      const due=new Date(Date.parse(now)-300000).toISOString();
      const candidates=new Map<string,Row>(),add=(rows:Row[])=>{for(const row of rows)if(candidates.size<MAX_TOKEN_BATCH)candidates.set(`${row.chain}:${row.address}`,row);};
      // Reserve independent work slots for new evidence, rank bootstrap and post/signal revisits.
      add(this.db.prepare('SELECT * FROM tr_tokens WHERE dirty_live=1 ORDER BY live_at,chain,address LIMIT 3').all());
      add(this.db.prepare("SELECT * FROM tr_tokens WHERE dirty=1 AND dirty_live=0 ORDER BY COALESCE(refreshed_at,''),registered_at,chain,address LIMIT 3").all());
      add(this.db.prepare('SELECT * FROM tr_tokens WHERE dirty=0 AND refreshed_at<=? ORDER BY refreshed_at,chain,address LIMIT 2').all(due));
      add(this.db.prepare("SELECT * FROM tr_tokens WHERE dirty=1 OR refreshed_at IS NULL OR refreshed_at<=? ORDER BY COALESCE(refreshed_at,''),chain,address LIMIT 24").all(due));
      const targets=[...candidates.values()];
      const touched=new Set<string>();let changed=0;
      for(const row of targets){
        const value=this.compute(row,now),fingerprint=hash({...value.token,computedAt:undefined,coverage:{...value.token.coverage,rankSnapshots:undefined},wallets:value.wallets,updates:value.updates});
        this.db.prepare('UPDATE tr_tokens SET dirty=0,dirty_live=0,live_at=NULL,refreshed_at=? WHERE chain=? AND address=?').run(now,row.chain,row.address);
        if(fingerprint===row.input_hash)continue;
        const encoded=JSON.stringify(value),room=Buffer.byteLength(encoded)*4+65536;
        if(bytes(this.db)+room>=this.maxBytes)throw new Error(CAPACITY);
        this.db.prepare('INSERT INTO tr_token_versions(chain,address,computed_at,data,wallets) VALUES(?,?,?,?,?)')
          .run(row.chain,row.address,now,JSON.stringify(value.token),JSON.stringify(value.wallets));
        this.db.prepare('UPDATE tr_tokens SET input_hash=? WHERE chain=? AND address=?').run(fingerprint,row.chain,row.address);
        // The bounded source/display windows must never delete accumulated wallet facts.
        for(const w of value.updates){
          this.db.prepare('INSERT OR IGNORE INTO tr_wallets VALUES(?,?,?)').run(w.chain,w.address,now);
          this.db.prepare('INSERT INTO tr_wallet_current VALUES(?,?,?,?) ON CONFLICT(chain,address,token_address) DO UPDATE SET data=excluded.data')
            .run(w.chain,w.address,w.tokenAddress,JSON.stringify(w));
          this.db.prepare('INSERT OR IGNORE INTO tr_wallet_tokens VALUES(?,?,?,?)').run(w.chain,w.address,w.tokenAddress,now);
          this.db.prepare('INSERT INTO tr_wallet_token_versions(chain,address,token_address,computed_at,present,data) VALUES(?,?,?,?,1,?)')
            .run(w.chain,w.address,w.tokenAddress,now,JSON.stringify(w));
          touched.add(`${w.chain}:${w.address}`);
        }
        changed++;
      }
      for(const key of touched){const split=key.indexOf(':'),chain=key.slice(0,split) as Chain,who=key.slice(split+1);
        const summary=this.summarize(chain,who,now),encoded=JSON.stringify(summary);
        if(bytes(this.db)+Buffer.byteLength(encoded)*4+65536>=this.maxBytes)throw new Error(CAPACITY);
        this.db.prepare('INSERT INTO tr_wallet_versions(chain,address,computed_at,early_count,realized,data) VALUES(?,?,?,?,?,?)')
          .run(chain,who,now,summary.earlyTokenCount,summary.realizedProfitUsd,encoded);
      }
      // A web reader during this batch must never see future committed findings at its earlier cutoff.
      const committedAt=this.now().toISOString();if(!stamp(committedAt)||committedAt<now)throw new Error('TOKEN_RANK_RESEARCH_CLOCK_INVALID');
      this.db.prepare("UPDATE tr_token_versions SET computed_at=?,data=json_set(data,'$.computedAt',?) WHERE id>?").run(committedAt,committedAt,previousTokenVersion);
      this.db.prepare("UPDATE tr_wallet_versions SET computed_at=?,data=json_set(data,'$.computedAt',?) WHERE id>?").run(committedAt,committedAt,previousWalletVersion);
      this.db.prepare('UPDATE tr_wallet_token_versions SET computed_at=? WHERE id>?').run(committedAt,previousWalletTokenVersion);
      this.db.prepare('UPDATE tr_tokens SET registered_at=? WHERE rowid>?').run(committedAt,previousToken);
      this.db.prepare('UPDATE tr_wallets SET registered_at=? WHERE rowid>?').run(committedAt,previousWallet);
      this.db.prepare('UPDATE tr_wallet_tokens SET registered_at=? WHERE rowid>?').run(committedAt,previousWalletToken);
      this.db.prepare("UPDATE tr_token_versions SET data=json_set(data,'$.registeredAt',?) WHERE id>? AND EXISTS(SELECT 1 FROM tr_tokens t WHERE t.chain=tr_token_versions.chain AND t.address=tr_token_versions.address AND t.rowid>?)")
        .run(committedAt,previousTokenVersion,previousToken);
      this.setMeta('last_run_at',committedAt);this.setMeta('processed',String(Number(this.meta('processed')||0)+targets.length));
      this.setMeta('changed',String(Number(this.meta('changed')||0)+changed));this.setMeta('error','');
      this.db.exec('COMMIT');writing=false;this.error=undefined;
    }catch(error){
      if(writing)this.db.exec('ROLLBACK');
      this.error=error instanceof Error&&(error.message===CAPACITY||/database or disk is full/.test(error.message))?CAPACITY:'TOKEN_RANK_RESEARCH_BATCH_FAILED';
      try{this.setMeta('error',this.error);}catch{/* Existing read models remain available. */}
    }finally{for(const db of sources){try{db.exec('ROLLBACK');}catch{/* Read transaction did not open. */}}}
    return this.status();
  }
  private ingest(row:Row,now:string,live:boolean){
    const target=token(row.chain,row.token_address);if(!target)return;
    if(row.kind!=='token_rank'){
      if(stamp(row.observed_at)&&row.observed_at<=now)this.db.prepare('UPDATE tr_tokens SET dirty=1,live_at=CASE WHEN dirty_live=0 AND ? THEN ? ELSE live_at END,dirty_live=MAX(dirty_live,?) WHERE chain=? AND address=?')
        .run(Number(live),now,Number(live),target.chain,target.address);return;
    }
    const observation=rank(row,now,target);if(!observation)return;
    let current=this.db.prepare('SELECT * FROM tr_tokens WHERE chain=? AND address=?').get(target.chain,target.address);
    if(!current){
      const earliest=this.history.prepare(`SELECT * FROM wh_observations INDEXED BY wh_exit_evidence
        WHERE chain=? AND token_address=? AND kind='token_rank' AND observed_at<=? ORDER BY observed_at,id LIMIT 20`).all(target.chain,target.address,now)
        .map(r=>rank(r,now,target)).find(Boolean)??observation;
      this.db.prepare('INSERT INTO tr_tokens(chain,address,registered_at,first_rank,latest_rank) VALUES(?,?,?,?,?)')
        .run(target.chain,target.address,now,JSON.stringify(earliest),JSON.stringify(observation));
      current=this.db.prepare('SELECT * FROM tr_tokens WHERE chain=? AND address=?').get(target.chain,target.address)!;
    }
    const latest=parse(current.latest_rank) as TokenRankObservation;
    this.db.prepare('UPDATE tr_tokens SET rank_count=rank_count+1,dirty=1,live_at=CASE WHEN dirty_live=0 AND ? THEN ? ELSE live_at END,dirty_live=MAX(dirty_live,?),latest_rank=? WHERE chain=? AND address=?')
      .run(Number(live),now,Number(live),JSON.stringify(observation.observedAt>latest.observedAt||observation.observedAt===latest.observedAt&&observation.evidenceId<latest.evidenceId?observation:latest),target.chain,target.address);
  }
  private observedRows(target:Token,kind:'trade'|'token_trader',now:string){
    const query=(direction:'ASC'|'DESC')=>this.history.prepare(`SELECT * FROM wh_observations INDEXED BY wh_exit_evidence
      WHERE chain=? AND token_address=? AND kind=? AND observed_at<=? ORDER BY observed_at ${direction},id ${direction} LIMIT ?`)
      .all(target.chain,target.address,kind,now,MAX_SOURCE_ROWS+1);
    const latest=query('DESC'),earliest=kind==='trade'?query('ASC'):[];
    const map=new Map([...earliest.slice(0,MAX_SOURCE_ROWS),...latest.slice(0,MAX_SOURCE_ROWS)].map(row=>[row.id,row]));
    return {rows:[...map.values()],truncated:latest.length>MAX_SOURCE_ROWS||earliest.length>MAX_SOURCE_ROWS};
  }
  private anchors(target:Token,now:string):{firstSignal?:TokenRankAnchor;caPost?:TokenRankAnchor;postCount:number;truncated:boolean;limitations:string[]}{
    const signals:TokenRankAnchor[]=[],posts:TokenRankAnchor[]=[],limits:string[]=[];let truncated=false;
    const previous=parse(this.db.prepare('SELECT data FROM tr_token_versions WHERE chain=? AND address=? AND computed_at<=? ORDER BY computed_at DESC,id DESC LIMIT 1')
      .get(target.chain,target.address,now)?.data) as TokenRankToken|undefined;
    if(this.signals)try{
      for(const provider of ['ave','debot','gmgn']){
        const rows=this.signals.prepare(`SELECT * FROM source_notifications WHERE chain=? AND address=? AND source=?
          AND first_observed_at<=? ORDER BY first_observed_at,event_id LIMIT 20`).all(target.chain,target.address,provider,now);
        for(const r of rows)if(stamp(r.occurred_at)&&stamp(r.first_observed_at)&&stamp(r.recorded_at)&&r.occurred_at<=r.first_observed_at&&
          r.first_observed_at<=r.recorded_at&&r.recorded_at<=now&&!r.conflict_at)
          signals.push({eventAt:r.occurred_at,knownAt:r.recorded_at,evidenceId:`${provider}:${r.event_id}`,scope:'first_retained_provider_notification'});
        if(rows.length===20)truncated=true;
      }
    }catch{limits.push('SOURCE_NOTIFICATION_ARCHIVE_UNAVAILABLE');}
    else limits.push('SOURCE_NOTIFICATION_ARCHIVE_UNAVAILABLE');
    if(this.meme)try{
      const rows=this.meme.prepare(`SELECT id,observed_at,data FROM meme_catalysts WHERE chain=? AND address=? AND observed_at<=?
        ORDER BY observed_at,id LIMIT 12`).all(target.chain,target.address,now);
      const tail=this.meme.prepare(`SELECT id,observed_at,data FROM meme_catalysts WHERE chain=? AND address=? AND observed_at<=?
        ORDER BY observed_at DESC,id DESC LIMIT 12`).all(target.chain,target.address,now);
      const unique=new Map([...rows,...tail].map(r=>[r.id,r]));truncated=truncated||unique.size>=24;
      for(const row of unique.values()){
        const d=parse(row.data);if(!stamp(row.observed_at)||!object(d)||d.token?.chain!==target.chain||address(d.token?.address,target.chain)!==target.address||!Array.isArray(d.posts))continue;
        for(const p of d.posts.slice(0,12)){
          if(!object(p)||p.mentionsExactCa!==true||p.relation!=='ca_mention'||!stamp(p.publishedAt)||!stamp(p.fetchedAt)||
            p.publishedAt>p.fetchedAt||p.fetchedAt>row.observed_at||row.observed_at>now||!/^x:\d{1,25}$/.test(p.id)||
            !/^\d{1,25}$/.test(p.authorId)||typeof p.text!=='string'||p.text.length>25000||
            !new RegExp(`(?<![A-Za-z0-9])${target.address}(?![A-Za-z0-9])`,target.chain==='solana'?'':'i').test(p.text))continue;
          if(!(p.provider==='x_official'&&p.verification==='first_party'||['fxembed','twitterapi_io'].includes(p.provider)&&p.verification==='third_party'))continue;
          let url:URL;try{url=new URL(p.url);}catch{continue;}
          if(url.protocol!=='https:'||url.username||url.password||url.port||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)||
            !new RegExp(`/status/${p.id.slice(2)}$`).test(url.pathname))continue;
          url.search='';url.hash='';
          posts.push({eventAt:p.publishedAt,knownAt:row.observed_at,fetchedAt:p.fetchedAt,evidenceId:p.id,scope:'earliest_retrieved_exact_ca_post',url:url.href});
        }
      }
    }catch{limits.push('CA_POST_ARCHIVE_UNAVAILABLE');}
    else limits.push('CA_POST_ARCHIVE_UNAVAILABLE');
    const sorted=(a:TokenRankAnchor,b:TokenRankAnchor)=>a.eventAt.localeCompare(b.eventAt)||a.knownAt.localeCompare(b.knownAt)||a.evidenceId.localeCompare(b.evidenceId);
    if(previous?.firstSignal){
      const old={...previous.firstSignal,status:'retained' as TokenRankAnchor['status']};
      if(previous.firstSignal.status==='conflict')old.status='conflict';
      if(this.signals)try{
        const split=old.evidenceId.indexOf(':'),r=this.signals.prepare('SELECT * FROM source_notifications WHERE source=? AND event_id=?')
          .get(old.evidenceId.slice(0,split),old.evidenceId.slice(split+1));
        if(r){old.status=r.conflict_at&&r.conflict_at<=now?'conflict':'current';
          if(r.chain!==target.chain||address(r.address,target.chain)!==target.address||r.occurred_at!==old.eventAt)old.status='conflict';}
      }catch{/* Previously retained proof remains separate from current source availability. */}
      if(old.status==='conflict')limits.push('FIRST_SIGNAL_ANCHOR_CONFLICTED');signals.push(old);
    }
    if(previous?.caPost)posts.push({...previous.caPost,status:previous.caPost.status==='conflict'?'conflict':'retained'});
    const postTimes=new Map<string,Set<string>>();
    for(const p of posts){const times=postTimes.get(p.evidenceId)??new Set<string>();times.add(p.eventAt);postTimes.set(p.evidenceId,times);}
    for(const p of posts)if(postTimes.get(p.evidenceId)!.size>1){p.status='conflict';limits.push('CA_POST_ANCHOR_TIMESTAMP_CONFLICTED');}
    const firstSignal=signals.sort(sorted)[0],caPost=posts.sort(sorted)[0];
    return {firstSignal,caPost,postCount:new Set(posts.map(p=>p.evidenceId)).size,truncated,limitations:[...new Set(limits)]};
  }
  private compute(row:Row,now:string):{token:TokenRankToken;wallets:TokenRankWallet[];updates:TokenRankWallet[]}{
    const target={chain:row.chain as Chain,address:String(row.address)},firstRank=parse(row.first_rank) as TokenRankObservation;
    const latestRank=this.history.prepare(`SELECT * FROM wh_observations INDEXED BY wh_exit_evidence
      WHERE chain=? AND token_address=? AND kind='token_rank' AND observed_at<=? ORDER BY observed_at DESC,id LIMIT 20`).all(target.chain,target.address,now)
      .map(r=>rank(r,now,target)).find(Boolean)??parse(row.latest_rank) as TokenRankObservation,anchors=this.anchors(target,now);
    const trades=this.observedRows(target,'trade',now),traders=this.observedRows(target,'token_trader',now);
    const previousRows=this.db.prepare('SELECT data FROM tr_wallet_current WHERE chain=? AND token_address=? ORDER BY address LIMIT 1001')
      .all(target.chain,target.address);
    const previous=previousRows.slice(0,1000).map(r=>parse(r.data) as TokenRankWallet);
    const groups=new Map<string,NonNullable<ReturnType<typeof entry>>[]>(),excluded=new Map<string,Set<string>>();
    const addEntry=(e:NonNullable<ReturnType<typeof entry>>)=>{const group=groups.get(e.eventKey)??[];group.push(e);groups.set(e.eventKey,group);};
    for(const raw of trades.rows){const e=entry(raw,target,now);if(e)addEntry(e);}
    const freshEntryWallets=new Set([...groups.values()].flatMap(g=>g.map(e=>e.wallet)));
    for(const old of previous){
      if(old.excludedBuyTransactions?.length)excluded.set(old.address,new Set(old.excludedBuyTransactions));
      if(old.entry)addEntry({wallet:old.address,entry:{...old.entry,retained:true},eventKey:JSON.stringify([old.address,old.entry.txHash])});
    }
    const entries=new Map<string,TokenRankEntry>(),conflicts=new Set<string>();
    for(const valid of groups.values()){
      const times=new Set(valid.map(e=>e.entry.eventAt)),who=valid[0].wallet,tx=valid[0].entry.txHash;
      if(times.size!==1||excluded.get(who)?.has(tx)){
        conflicts.add(who);const set=excluded.get(who)??new Set<string>();set.add(tx);excluded.set(who,set);continue;
      }
      for(const e of valid){const old=entries.get(e.wallet);
        if(!old||e.entry.eventAt<old.eventAt||e.entry.eventAt===old.eventAt&&e.entry.observedAt<old.observedAt)entries.set(e.wallet,e.entry);}
    }
    for(const who of excluded.keys())conflicts.add(who);
    const pnls=new Map<string,TokenRankPnl>(),freshPnlWallets=new Set<string>();
    for(const old of previous)if(old.pnl)pnls.set(old.address,{...old.pnl,retained:true});
    for(const raw of traders.rows){const p=pnl(raw,target,now);if(p){freshPnlWallets.add(p.wallet);const old=pnls.get(p.wallet);
      if(!old||p.pnl.observedAt>old.observedAt||p.pnl.observedAt===old.observedAt&&p.pnl.source<=old.source)pnls.set(p.wallet,p.pnl);}}
    const members=[...new Set([...entries.keys(),...pnls.keys(),...conflicts])].sort((a,b)=>
      (entries.get(a)?.eventAt??'z').localeCompare(entries.get(b)?.eventAt??'z')||a.localeCompare(b));
    const profitMembers=[...pnls.keys()].sort((a,b)=>(pnls.get(b)!.realizedProfitUsd??-Infinity)-(pnls.get(a)!.realizedProfitUsd??-Infinity)||a.localeCompare(b));
    // Keep both tails of the research question: the earliest actual transaction samples and
    // sampled realized-profit leaders. A busy buy stream must not hide the largest profit row.
    const selected=[...new Set([...members.filter(w=>entries.has(w)).slice(0,100),...profitMembers.slice(0,100),...members])]
      .slice(0,MAX_WALLETS).sort((a,b)=>(entries.get(a)?.eventAt??'z').localeCompare(entries.get(b)?.eventAt??'z')||a.localeCompare(b));
    const updates=members.map(who=>{
      const buy=entries.get(who),profit=pnls.get(who),limitations=['SAMPLED_TRANSACTIONS_NOT_FIRST_EVER_BUY','VENDOR_TX_REFERENCE_NOT_RECEIPT_VERIFIED'];
      if(conflicts.has(who))limitations.push('CONFLICTING_BUY_TIMESTAMPS_EXCLUDED');
      if(profit?.vendorFirstAcquiredAt)limitations.push('VENDOR_HOLDING_START_NOT_BUY_PROOF');
      if(buy?.retained||profit?.retained)limitations.push('PRIOR_VALID_SAMPLE_RETAINED_ORIGINAL_TIMESTAMP');
      return {chain:target.chain,address:who,tokenAddress:target.address,...(buy?{entry:buy}:{}),
        comparisons:{rank:compare(buy,{eventAt:firstRank.observedAt,knownAt:firstRank.observedAt,evidenceId:firstRank.evidenceId,scope:'first_locally_observed_rank'}),
          signal:compare(buy,anchors.firstSignal),caPost:compare(buy,anchors.caPost)},...(profit?{pnl:profit}:{}),limitations,
        ...(excluded.get(who)?.size?{excludedBuyTransactions:[...excluded.get(who)!].sort()}:{})} satisfies TokenRankWallet;
    });
    const displaySet=new Set(selected),wallets=updates.filter(w=>displaySet.has(w.address));
    const earliest=wallets.filter(w=>w.entry).sort((a,b)=>a.entry!.eventAt.localeCompare(b.entry!.eventAt)||a.address.localeCompare(b.address))[0];
    const top=wallets.filter(w=>w.pnl?.realizedProfitUsd!==null&&w.pnl?.realizedProfitUsd!==undefined)
      .sort((a,b)=>b.pnl!.realizedProfitUsd!-a.pnl!.realizedProfitUsd!||a.address.localeCompare(b.address))[0];
    const truncated=trades.truncated||traders.truncated||anchors.truncated||members.length>MAX_WALLETS||previousRows.length>1000;
    const limitations=['RETAINED_RANKED_TOKEN_SAMPLE_NOT_ALL_MARKET','PROFIT_RANK_SELECTION_BIAS','PNL_IS_VENDOR_CUMULATIVE_NOT_AUDITED',
      'POST_TIMING_NOT_NARRATIVE_CAUSATION_OR_OWNERSHIP','HISTORICAL_DISCOVERY_IS_NOT_FORWARD_PREDICTION',...anchors.limitations,
      ...(previousRows.length>1000?['BOUNDED_RETAINED_WALLET_REFRESH_OLDER_FACTS_PRESERVED']:[]),
      ...(truncated?['BOUNDED_SOURCE_COVERAGE_TRUNCATED']:[])];
    let display:Row|undefined;try{display=this.meme?.prepare('SELECT name,symbol FROM meme_tokens WHERE chain=? AND address=?').get(target.chain,target.address);}catch{/* Identity display is optional. */}
    const text=(v:unknown,n:number)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,n)||undefined:undefined;
    return {token:{...target,...(text(display?.name,100)?{name:text(display?.name,100)}:{}),...(text(display?.symbol,32)?{symbol:text(display?.symbol,32)}:{}),
      firstRank,latestRank,registeredAt:row.registered_at,computedAt:now,firstSignal:anchors.firstSignal,caPost:anchors.caPost,
      walletCount:wallets.length,entryCount:wallets.filter(w=>w.entry).length,
      ...(earliest?{earliestEntry:{...earliest.entry!,wallet:earliest.address}}:{}),
      ...(top?{topRealized:{wallet:top.address,realizedProfitUsd:top.pnl!.realizedProfitUsd!,observedAt:top.pnl!.observedAt}}:{}),
      coverage:{rankSnapshots:Number(row.rank_count),traderRows:traders.rows.length,traderWallets:freshPnlWallets.size,tradeRows:trades.rows.length,
        tradeWallets:freshEntryWallets.size,postCount:anchors.postCount,truncated,limitations},researchOnly:true,scoreEffect:0},wallets,updates};
  }
  private summarize(chain:Chain,who:string,now:string):TokenRankWalletSummary {
    const rows=this.db.prepare('SELECT data FROM tr_wallet_current WHERE chain=? AND address=? ORDER BY token_address LIMIT 1001').all(chain,who);
    const values=rows.slice(0,1000).map(row=>parse(row.data) as TokenRankWallet),early=values.filter(v=>v.comparisons.rank.position==='before'),
      realized=values.filter(v=>v.pnl?.realizedProfitUsd!==null&&v.pnl?.realizedProfitUsd!==undefined),times=values.flatMap(v=>v.pnl?[v.pnl.observedAt]:[]).sort();
    const sum=(key:'realizedProfitUsd'|'unrealizedProfitUsd'|'totalProfitUsd')=>{const selected=values.flatMap(v=>typeof v.pnl?.[key]==='number'?[v.pnl[key]!]:[]);
      if(!selected.length)return null;const total=selected.reduce((a,b)=>a+b,0);return Number.isFinite(total)&&Math.abs(total)<=Number.MAX_SAFE_INTEGER?total:null;};
    const positives=realized.map(v=>v.pnl!.realizedProfitUsd!).filter(n=>n>0),positiveTotal=positives.reduce((a,b)=>a+b,0);
    return {chain,address:who,computedAt:now,tokenCount:values.length,entryTokenCount:values.filter(v=>v.entry).length,
      earlyTokenCount:early.length,observedEarlyTokenCount:early.filter(v=>v.comparisons.rank.knowledge==='observed_before_anchor').length,
      retrospectiveEarlyTokenCount:early.filter(v=>v.comparisons.rank.knowledge==='historical_backfill').length,
      realizedCoverage:realized.length,positiveRealizedTokens:realized.filter(v=>v.pnl!.realizedProfitUsd!>0).length,
      negativeRealizedTokens:realized.filter(v=>v.pnl!.realizedProfitUsd!<0).length,zeroRealizedTokens:realized.filter(v=>v.pnl!.realizedProfitUsd===0).length,
      unknownRealizedTokens:values.length-realized.length,earlyPositiveRealizedTokens:early.filter(v=>typeof v.pnl?.realizedProfitUsd==='number'&&v.pnl.realizedProfitUsd>0).length,
      realizedProfitUsd:sum('realizedProfitUsd'),unrealizedProfitUsd:sum('unrealizedProfitUsd'),totalProfitUsd:sum('totalProfitUsd'),
      roiPct:null,largestPositiveRealizedShare:positiveTotal>0&&Number.isFinite(positiveTotal)?Math.max(...positives)/positiveTotal:null,
      pnlWindow:times.length?{oldestAt:times[0],newestAt:times.at(-1)!}:null,researchOnly:true,scoreEffect:0,
      limitations:['RANKED_TOKEN_SAMPLE_SELECTION_BIAS','PNL_SUM_IS_LATEST_PER_TOKEN_VENDOR_SNAPSHOTS_AT_DIFFERENT_TIMES',
        'NOT_ENTIRE_WALLET_RETURN_OR_WIN_RATE','NO_COMMON_OWNERSHIP_OR_PREDICTIVE_SKILL_PROVEN',...(rows.length>1000?['CROSS_TOKEN_SAMPLE_TRUNCATED']:[])]};
  }
  status(){return outputStatus(this.db,this.error,this.maxBytes);}
  close(){if(this.closed)return;this.closed=true;this.history.close();this.meme?.close();this.signals?.close();this.db.close();}
}

function outputStatus(db:DatabaseSync|undefined,error?:string,maxBytes?:number){
  const base={ready:!!db,researchOnly:true as const,tradingEnabled:false as const,scoreEffect:0 as const};
  if(!db)return {...base,tokens:0,wallets:0,pending:0,initialComplete:false,error,processed:0,changed:0,
    bootstrap:{rankRowsTotal:0,rankRowsProcessed:0,rankDiscoveryComplete:false,tradeHistoryMode:'indexed_per_ranked_token_sample' as const},
    lastRunAt:undefined as string|undefined,bytes:0,maxBytes:maxBytes??0,
    watermarks:Object.fromEntries(KINDS.map(k=>[k,{initial:0,live:0}])),maxTokensPerBatch:MAX_TOKEN_BATCH,
    scope:'retained_ranked_tokens_and_sampled_vendor_transactions' as const};
  const meta=(k:string)=>String(db.prepare('SELECT value FROM tr_meta WHERE key=?').get(k)?.value??'');
  return {...base,tokens:Number(db.prepare('SELECT count(*) AS n FROM tr_tokens').get()!.n),wallets:Number(db.prepare('SELECT count(*) AS n FROM tr_wallets').get()!.n),
    pending:Number(db.prepare('SELECT count(*) AS n FROM tr_tokens WHERE dirty=1').get()!.n),
    initialComplete:KINDS.every(k=>meta(`${k}_complete`)==='1'),processed:Number(meta('processed')||0),changed:Number(meta('changed')||0),
    bootstrap:{rankRowsTotal:Number(meta('rank_history_total')||0),rankRowsProcessed:Number(meta('rank_history_processed')||0),
      rankDiscoveryComplete:meta('token_rank_complete')==='1',tradeHistoryMode:'indexed_per_ranked_token_sample' as const},
    lastRunAt:meta('last_run_at')||undefined,bytes:bytes(db),maxBytes:maxBytes??Number(meta('max_bytes')||0),
    error:error??(meta('error')||undefined),watermarks:Object.fromEntries(KINDS.map(k=>[k,{initial:Number(meta(`${k}_initial`)||0),live:Number(meta(`${k}_live`)||0)}])),
    maxTokensPerBatch:MAX_TOKEN_BATCH,scope:'retained_ranked_tokens_and_sampled_vendor_transactions' as const};
}

/** Web/API reader: never opens source databases, never creates missing output files. */
export class TokenRankResearchReader {
  private db?:DatabaseSync;
  constructor(private readonly database:string,private readonly now:()=>Date=()=>new Date()){}
  private ready(){
    if(this.db)return this.db;if(!existsSync(this.database))return;
    let db:DatabaseSync|undefined;try{db=readonly(this.database);
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tr_token_versions'").get()){db.close();return;}
      this.db=db;return db;
    }catch{db?.close();return;}
  }
  private page(options:TokenRankResearchPage){
    const now=this.now().toISOString(),db=this.ready(),published=db?.prepare("SELECT value FROM tr_meta WHERE key='last_run_at'").get()?.value,
      asOf=options.asOf??(stamp(published)?published:'1970-01-01T00:00:00.000Z'),limit=options.limit??20,offset=options.offset??0;
    if(!stamp(asOf)||asOf>now||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000||
      options.chain&&!['bsc','solana','robinhood'].includes(options.chain))throw new Error('INVALID_FILTER');
    return {now,asOf,limit,offset};
  }
  status(){return outputStatus(this.ready());}
  list(options:TokenRankResearchPage={}){
    const page=this.page(options),db=this.ready(),where=`t.registered_at<=?${options.chain?' AND t.chain=?':''} AND EXISTS(
      SELECT 1 FROM tr_token_versions v WHERE v.chain=t.chain AND v.address=t.address AND v.computed_at<=?)`,
      args=[page.asOf,...(options.chain?[options.chain]:[]),page.asOf];
    if(!db)return {...page,ready:false,total:0,hasMore:false,items:[] as TokenRankToken[]};
    const total=Number(db.prepare(`SELECT count(*) AS n FROM tr_tokens t WHERE ${where}`).get(...args)!.n);
    const rows=db.prepare(`SELECT (SELECT v.data FROM tr_token_versions v WHERE v.chain=t.chain AND v.address=t.address AND v.computed_at<=?
      ORDER BY v.computed_at DESC,v.id DESC LIMIT 1) AS data FROM tr_tokens t WHERE ${where}
      ORDER BY t.registered_at DESC,t.chain,t.address LIMIT ? OFFSET ?`).all(page.asOf,...args,page.limit,page.offset);
    return {...page,ready:true,total,hasMore:page.offset+rows.length<total,items:rows.map(row=>parse(row.data) as TokenRankToken)};
  }
  detail(chain:Chain,value:string,options:TokenRankResearchPage={}){
    const target=token(chain,value);if(!target)throw new Error('INVALID_FILTER');
    const page=this.page(options),db=this.ready(),row=db?.prepare('SELECT data,wallets FROM tr_token_versions WHERE chain=? AND address=? AND computed_at<=? ORDER BY computed_at DESC,id DESC LIMIT 1')
      .get(target.chain,target.address,page.asOf);
    const all=(parse(row?.wallets)??[]) as TokenRankWallet[],items=all.slice(page.offset,page.offset+page.limit);
    return {...page,ready:!!db,token:parse(row?.data) as TokenRankToken|undefined,total:all.length,hasMore:page.offset+items.length<all.length,items};
  }
  wallets(options:TokenRankWalletPage={}){
    const page=this.page(options),db=this.ready(),sort=options.sort??'early';if(!['early','realized'].includes(sort))throw new Error('INVALID_FILTER');
    if(!db)return {...page,ready:false,total:0,hasMore:false,items:[] as TokenRankWalletSummary[]};
    const join=`FROM tr_wallets w JOIN tr_wallet_versions v ON v.id=(SELECT x.id FROM tr_wallet_versions x
      WHERE x.chain=w.chain AND x.address=w.address AND x.computed_at<=? ORDER BY x.computed_at DESC,x.id DESC LIMIT 1)
      WHERE w.registered_at<=?${options.chain?' AND w.chain=?':''}`,
      args=[page.asOf,page.asOf,...(options.chain?[options.chain]:[])],order=sort==='early'?'v.early_count DESC,v.realized DESC NULLS LAST':'v.realized DESC NULLS LAST,v.early_count DESC';
    const total=Number(db.prepare(`SELECT count(*) AS n ${join}`).get(...args)!.n);
    const rows=db.prepare(`SELECT v.data ${join} ORDER BY ${order},v.chain,v.address LIMIT ? OFFSET ?`).all(...args,page.limit,page.offset);
    return {...page,ready:true,total,hasMore:page.offset+rows.length<total,items:rows.map(r=>parse(r.data) as TokenRankWalletSummary)};
  }
  wallet(chain:Chain,value:string,options:TokenRankResearchPage={}){
    const target=token(chain,value);if(!target)throw new Error('INVALID_FILTER');
    const page=this.page(options),db=this.ready(),summary=db?.prepare('SELECT data FROM tr_wallet_versions WHERE chain=? AND address=? AND computed_at<=? ORDER BY computed_at DESC,id DESC LIMIT 1')
      .get(target.chain,target.address,page.asOf);
    if(!db)return {...page,ready:false,wallet:undefined as TokenRankWalletSummary|undefined,total:0,hasMore:false,items:[] as TokenRankWallet[]};
    const join=`FROM tr_wallet_tokens w JOIN tr_wallet_token_versions v ON v.id=(SELECT x.id FROM tr_wallet_token_versions x
      WHERE x.chain=w.chain AND x.address=w.address AND x.token_address=w.token_address AND x.computed_at<=? ORDER BY x.computed_at DESC,x.id DESC LIMIT 1)
      WHERE w.chain=? AND w.address=? AND w.registered_at<=? AND v.present=1`,args=[page.asOf,target.chain,target.address,page.asOf];
    const total=Number(db.prepare(`SELECT count(*) AS n ${join}`).get(...args)!.n),rows=db.prepare(`SELECT v.data ${join} ORDER BY w.token_address LIMIT ? OFFSET ?`).all(...args,page.limit,page.offset);
    return {...page,ready:true,wallet:parse(summary?.data) as TokenRankWalletSummary|undefined,total,hasMore:page.offset+rows.length<total,items:rows.map(r=>parse(r.data) as TokenRankWallet)};
  }
  close(){this.db?.close();this.db=undefined;}
}
