import {createHash} from 'node:crypto';
import {chmodSync} from 'node:fs';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import bs58 from 'bs58';
import {GmgnError,type GmgnClient} from './providers/gmgn-client.js';

export type GmgnArchiveChain='sol'|'bsc'|'robinhood';
export type GmgnCalloutFeed='global'|'declaration';
type Obj=Record<string,unknown>;
const object=(value:unknown):value is Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown,max=512):string|undefined=>typeof value==='string'&&value.length<=max?value:undefined;
const finite=(value:unknown):number|undefined=>{const n=typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value):NaN;
  return Number.isFinite(n)?n:undefined;};
const iso=(millis:number):string|undefined=>Number.isSafeInteger(millis)&&millis>=1_577_836_800_000&&millis<=8.64e15?
  new Date(millis).toISOString():undefined;
const rawJson=(value:unknown,max=262_144):string|undefined=>{try{const raw=JSON.stringify(value);return raw.length<=max?raw:undefined;}catch{return;}};
const chainAddress=(value:unknown,chain:GmgnArchiveChain):string|undefined=>{
  if(typeof value!=='string')return;
  if(chain!=='sol')return /^0x[0-9a-f]{40}$/i.test(value)&&!/^0x0+$/i.test(value)?value.toLowerCase():undefined;
  if(value.length<32||value.length>44)return;
  try{const bytes=bs58.decode(value);if(bytes.length===32&&bytes.some(byte=>byte!==0)&&bs58.encode(bytes)===value)return value;}catch{}
};
const txAddress=(value:unknown,chain:GmgnArchiveChain):string|undefined=>{
  if(typeof value!=='string')return;
  if(chain!=='sol')return /^0x[0-9a-f]{64}$/i.test(value)&&!/^0x0+$/i.test(value)?value.toLowerCase():undefined;
  try{const bytes=bs58.decode(value);if(bytes.length===64&&bytes.some(byte=>byte!==0))return value;}catch{}
};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const apiChain=(value:unknown):GmgnArchiveChain|undefined=>value==='sol'||value==='bsc'||value==='robinhood'?value:undefined;
const cursorToken=(value:unknown):value is string=>typeof value==='string'&&/^[\x21-\x7e]{1,512}$/.test(value);
const boundedScalar=(value:unknown,max=160):string=>typeof value==='string'&&value.length<=max?value:
  typeof value==='number'&&Number.isFinite(value)?String(value):'';
// Some portfolio routes retain exactly one successful service envelope after
// the OpenAPI envelope is removed. Never recursively unwrap arbitrary `data`.
const portfolioData=(value:unknown):unknown=>object(value)&&(value.code===0||value.code==='0')&&Object.hasOwn(value,'data')?
  value.data:value;

export interface GmgnPlusArchiveOptions {path:string;maxBytes:number;now?:()=>Date;maxCandidates?:number;}
export interface ArchiveWrite {received:number;accepted:number;rejected:number;candidates:number;capacityReached:boolean;}

/**
 * Research-only GMGN archive. Vendor rows remain data and are never promoted to
 * the entry pipeline. Primary keys deduplicate polling, while cursors and the
 * runner position are committed in the same small database for restart safety.
 */
export class GmgnPlusArchive {
  private readonly db:DatabaseSync;private readonly maxBytes:number;private readonly now:()=>Date;private readonly maxCandidates:number;
  private statusCountCache?:{at:number;counts:Record<string,number>};
  constructor(options:GmgnPlusArchiveOptions){
    if(!options.path||options.path===':memory:'||!Number.isSafeInteger(options.maxBytes)||options.maxBytes<16*1024*1024||
      options.maxBytes>4*1024*1024*1024||options.maxCandidates!==undefined&&(!Number.isSafeInteger(options.maxCandidates)||options.maxCandidates<100||options.maxCandidates>100_000))
      throw new Error('GMGN_PLUS_ARCHIVE_CONFIG_INVALID');
    this.maxBytes=options.maxBytes;this.now=options.now??(()=>new Date());this.maxCandidates=options.maxCandidates??20_000;
    this.db=new DatabaseSync(options.path);this.db.exec(`PRAGMA journal_mode=DELETE;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=100;
      PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;`);
    const pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    this.db.exec(`PRAGMA max_page_count=${Math.max(1,Math.floor(this.maxBytes/pageSize))};
      CREATE TABLE IF NOT EXISTS gpa_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gpa_events(
        event_key TEXT PRIMARY KEY,kind TEXT NOT NULL,feed TEXT,chain TEXT NOT NULL,upstream_id TEXT NOT NULL,
        token_address TEXT NOT NULL,wallet_address TEXT,event_at TEXT NOT NULL,signal_type INTEGER,symbol TEXT,
        trigger_market_cap REAL,call_market_cap REAL,call_price TEXT,multiplier REAL,is_kol INTEGER,
        is_declaration INTEGER,is_safe TEXT,source_text TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,
        seen_count INTEGER NOT NULL,raw_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gpa_events_time ON gpa_events(event_at DESC);
      CREATE INDEX IF NOT EXISTS gpa_events_token ON gpa_events(chain,token_address,event_at DESC);
      CREATE INDEX IF NOT EXISTS gpa_events_wallet ON gpa_events(chain,wallet_address,event_at DESC);
      CREATE TABLE IF NOT EXISTS gpa_wallet_candidates(
        chain TEXT NOT NULL,address TEXT NOT NULL,source_mask INTEGER NOT NULL,occurrences INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,last_stats_at TEXT,last_profits_at TEXT,last_activity_at TEXT,
        activity_cursor TEXT,activity_pages INTEGER NOT NULL DEFAULT 0,activity_truncated INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,retry_after TEXT,PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS gpa_candidates_stats ON gpa_wallet_candidates(last_stats_at,retry_after,occurrences DESC);
      CREATE INDEX IF NOT EXISTS gpa_candidates_profits ON gpa_wallet_candidates(last_profits_at,retry_after,occurrences DESC);
      CREATE INDEX IF NOT EXISTS gpa_candidates_activity ON gpa_wallet_candidates(last_activity_at,retry_after,occurrences DESC);
      CREATE TABLE IF NOT EXISTS gpa_wallet_snapshots(
        chain TEXT NOT NULL,address TEXT NOT NULL,kind TEXT NOT NULL,period TEXT NOT NULL,observed_at TEXT NOT NULL,
        normalized_json TEXT NOT NULL,raw_json TEXT NOT NULL,PRIMARY KEY(chain,address,kind,period));
      CREATE TABLE IF NOT EXISTS gpa_wallet_holding_pages(
        chain TEXT NOT NULL,address TEXT NOT NULL,mode TEXT NOT NULL,page INTEGER NOT NULL,observed_at TEXT NOT NULL,
        row_count INTEGER NOT NULL,next_cursor TEXT,raw_json TEXT NOT NULL,PRIMARY KEY(chain,address,mode,page));
      CREATE INDEX IF NOT EXISTS gpa_holding_pages_wallet ON gpa_wallet_holding_pages(chain,address,mode,page);
      CREATE TABLE IF NOT EXISTS gpa_event_wallets(
        event_key TEXT NOT NULL,chain TEXT NOT NULL,wallet_address TEXT NOT NULL,role TEXT NOT NULL,buy_at TEXT,buy_amount REAL,
        raw_json TEXT NOT NULL,PRIMARY KEY(event_key,wallet_address,role));
      CREATE INDEX IF NOT EXISTS gpa_event_wallets_wallet ON gpa_event_wallets(chain,wallet_address,buy_at);
      CREATE TABLE IF NOT EXISTS gpa_wallet_activity(
        event_key TEXT PRIMARY KEY,chain TEXT NOT NULL,wallet_address TEXT NOT NULL,tx_hash TEXT NOT NULL,event_type TEXT NOT NULL,
        token_address TEXT NOT NULL,event_at TEXT NOT NULL,amount_usd TEXT,observed_at TEXT NOT NULL,raw_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gpa_activity_wallet ON gpa_wallet_activity(chain,wallet_address,event_at DESC);
      CREATE INDEX IF NOT EXISTS gpa_activity_token ON gpa_wallet_activity(chain,token_address,event_at DESC);`);
    chmodSync(options.path,0o600);
  }
  close(){this.db.close();}
  meta(key:string):string|undefined{return this.db.prepare('SELECT value FROM gpa_meta WHERE key=?').get(key)?.value as string|undefined;}
  setMeta(key:string,value:string){if(!/^[a-z][a-z0-9_]{0,63}$/.test(key)||value.length>4096)throw new Error('GMGN_PLUS_ARCHIVE_META_INVALID');
    this.db.prepare('INSERT INTO gpa_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  storageBytes(){return Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size);}
  capacityReached(extraBytes=0){return this.storageBytes()+Math.max(0,extraBytes)+1_048_576>=this.maxBytes;}
  status(){
    const now=this.now().getTime();if(!this.statusCountCache||now-this.statusCountCache.at>=5_000){
      this.statusCountCache={at:now,counts:Object.fromEntries(['gpa_events','gpa_event_wallets','gpa_wallet_candidates','gpa_wallet_snapshots','gpa_wallet_holding_pages','gpa_wallet_activity'].map(table=>
        [table,Number(this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)]))};
    }
    const counts=this.statusCountCache.counts;
    return {enabled:true,maxBytes:this.maxBytes,storageBytes:this.storageBytes(),capacityReached:this.capacityReached(),
      events:counts.gpa_events,candidates:counts.gpa_wallet_candidates,walletSnapshots:counts.gpa_wallet_snapshots,
      walletHoldingPages:counts.gpa_wallet_holding_pages,candidateEvidence:counts.gpa_event_wallets,walletActivities:counts.gpa_wallet_activity,
      runnerCursor:Number(this.meta('runner_cursor')??0),lastSuccessAt:this.meta('last_success_at'),
      lastError:this.meta('last_error'),researchOnly:true,tradingEnabled:false};
  }

  recordMarketSignals(chain:GmgnArchiveChain,input:unknown):ArchiveWrite{
    const rows=Array.isArray(input)?input.slice(0,1000):[];return this.write(rows,chain,'market_signal',undefined,(row,at)=>{
      if(!object(row)||typeof row.id!=='string'||!/^[A-Za-z0-9-]{8,100}$/.test(row.id)||!object(row.data)||
        apiChain(row.data.chain)!==chain)return;
      const token=chainAddress(row.token_address,chain),when=iso(Number(row.trigger_at)*1000),type=finite(row.signal_type),raw=rawJson(row);
      if(!token||!when||type===undefined||!Number.isInteger(type)||type<1||type>99||!raw)return;
      const candidates:{address:string;mask:number;role:string;buyAt?:string;buyAmount?:number;raw?:string}[]=[];
      for(const [key,mask] of [['smart_degen_wallets',4],['kol_wallets',8]] as const)for(const item of Array.isArray(row.data[key])?row.data[key]!.slice(0,100):[]){
        const address=object(item)?chainAddress(item.address,chain):undefined;if(address)candidates.push({address,mask,
          role:key==='smart_degen_wallets'?'smart_degen':'kol',buyAt:iso(Number(item.buy_timestamp)*1000),
          buyAmount:finite(item.buy_amount),raw:rawJson(item,16_384)});}
      return {values:[`market:${chain}:${row.id}`,'market_signal',null,chain,row.id,token,null,when,type,
        text(row.data.symbol,128)??null,finite(row.trigger_mc)??null,null,null,null,null,null,null,null,at,at,1,raw],candidates};
    });
  }

  recordCallouts(feed:GmgnCalloutFeed,input:unknown):ArchiveWrite{
    const rows=object(input)&&Array.isArray(input.list)?input.list.slice(0,500):[];return this.write(rows,undefined,'callout',feed,(row,at)=>{
      if(!object(row)||typeof row.ulid!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(row.ulid))return;
      const chain=apiChain(row.chain),when=iso(Number(row.create_time)),raw=rawJson(row);if(!chain||!when||!raw)return;
      const token=chainAddress(row.call_token,chain),wallet=chainAddress(row.call_wallet,chain);if(!token||!wallet)return;
      const thesis=object(row.call_thesis)?text(row.call_thesis.source_content,4096):undefined;
      return {values:[`callout:${row.ulid}`,'callout',feed,chain,row.ulid,token,wallet,when,null,text(row.token_symbol,128)??null,
        null,finite(row.call_mc)??null,text(row.call_price,160)??null,finite(row.multiplier)??null,row.is_kol===true?1:0,
        row.is_declaration===true||feed==='declaration'?1:0,row.is_safe===true?'safe':row.is_safe===false?'risk':text(row.is_safe,32)??null,
        thesis??null,at,at,1,raw],
        candidates:[{address:wallet,mask:feed==='declaration'?3:1,role:'caller',raw:rawJson({wallet})}]};
    });
  }

  private write(rows:unknown[],expectedChain:GmgnArchiveChain|undefined,kind:string,feed:GmgnCalloutFeed|undefined,
    normalize:(row:unknown,at:string)=>{values:SQLInputValue[];candidates:{address:string;mask:number;role:string;buyAt?:string;buyAmount?:number;raw?:string}[]}|undefined):ArchiveWrite{
    const estimate=Math.min(8*1024*1024,rows.reduce<number>((sum,row)=>sum+(rawJson(row)?.length??0),0));
    if(this.capacityReached(estimate))return {received:rows.length,accepted:0,rejected:0,candidates:0,capacityReached:true};
    const at=this.now().toISOString(),event=this.db.prepare(`INSERT INTO gpa_events VALUES(${Array(22).fill('?').join(',')})
      ON CONFLICT(event_key) DO UPDATE SET feed=excluded.feed,symbol=excluded.symbol,trigger_market_cap=excluded.trigger_market_cap,
      call_market_cap=excluded.call_market_cap,call_price=excluded.call_price,multiplier=excluded.multiplier,is_kol=excluded.is_kol,
      is_declaration=excluded.is_declaration,is_safe=excluded.is_safe,source_text=excluded.source_text,last_seen_at=excluded.last_seen_at,
      seen_count=gpa_events.seen_count+1,raw_json=excluded.raw_json`),candidateUpdate=this.db.prepare(`UPDATE gpa_wallet_candidates SET
        source_mask=source_mask|?,occurrences=occurrences+?,last_seen_at=CASE WHEN ?=1 THEN ? ELSE last_seen_at END
        WHERE chain=? AND address=?`),candidateInsert=this.db.prepare(`INSERT INTO gpa_wallet_candidates(
        chain,address,source_mask,occurrences,first_seen_at,last_seen_at) VALUES(?,?,?,
        (SELECT count(DISTINCT event_key) FROM gpa_event_wallets WHERE chain=? AND wallet_address=?),?,?)`),
      eventWalletExists=this.db.prepare('SELECT 1 FROM gpa_event_wallets WHERE event_key=? AND wallet_address=? LIMIT 1'),
      evidenceInsert=this.db.prepare(`INSERT OR IGNORE INTO gpa_event_wallets VALUES(?,?,?,?,?,?,?)`),
      evidenceUpdate=this.db.prepare(`UPDATE gpa_event_wallets SET buy_at=?,buy_amount=?,raw_json=?
        WHERE event_key=? AND wallet_address=? AND role=?`);
    let accepted=0,rejected=0,candidates=0;
    try {this.db.exec('BEGIN IMMEDIATE');for(const row of rows){const value=normalize(row,at);if(!value){rejected++;continue;}
      event.run(...value.values);accepted++;const chain=String(value.values[3]) as GmgnArchiveChain,eventKey=String(value.values[0]);
      for(const seed of value.candidates){const raw=seed.raw??'{}',hadEventWallet=!!eventWalletExists.get(eventKey,seed.address),
        inserted=Number(evidenceInsert.run(eventKey,chain,seed.address,seed.role,seed.buyAt??null,seed.buyAmount??null,raw).changes)>0?1:0,
        newOccurrence=inserted&&!hadEventWallet?1:0;
        if(!inserted)evidenceUpdate.run(seed.buyAt??null,seed.buyAmount??null,raw,eventKey,seed.address,seed.role);
        const updated=candidateUpdate.run(seed.mask,newOccurrence,newOccurrence,at,chain,seed.address);
        if(!updated.changes)candidateInsert.run(chain,seed.address,seed.mask,chain,seed.address,at,at);
        candidates+=newOccurrence;}}
      this.pruneCandidates();this.setMeta('last_success_at',at);this.setMeta('last_error','');this.db.exec('COMMIT');this.invalidateStatusCounts();
      return {received:rows.length,accepted,rejected,candidates,capacityReached:false};
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}if(this.isFull(error))return {received:rows.length,accepted:0,rejected:0,candidates:0,capacityReached:true};throw error;}
  }
  private pruneCandidates(){const extra=Number(this.db.prepare('SELECT max(count(*)-?,0) AS n FROM gpa_wallet_candidates').get(this.maxCandidates)!.n);
    if(extra>0)this.db.prepare(`DELETE FROM gpa_wallet_candidates WHERE (chain,address) IN (
      SELECT chain,address FROM gpa_wallet_candidates ORDER BY occurrences,last_seen_at LIMIT ?)` ).run(extra);}
  private isFull(error:unknown){return error instanceof Error&&/(?:SQLITE_FULL|database or disk is full)/i.test(error.message);}
  private invalidateStatusCounts(){this.statusCountCache=undefined;}

  calloutCursor(feed:GmgnCalloutFeed){const value=this.meta(`callout_${feed}_backfill_cursor`);if(value===undefined||value==='')return;
    if(cursorToken(value))return value;this.resetCalloutCursor(feed);return this.calloutFrontier(feed);}
  calloutFrontier(feed:GmgnCalloutFeed){const value=this.meta(`callout_${feed}_frontier_cursor`);return cursorToken(value)?value:undefined;}
  calloutLatestCursor(feed:GmgnCalloutFeed){const value=this.meta(`callout_${feed}_latest_cursor`);if(value===undefined||value==='')return;
    if(cursorToken(value))return value;this.resetCalloutLatest(feed);}
  commitCalloutPage(feed:GmgnCalloutFeed,input:unknown,mode:'latest'|'backfill',pageToken?:string){
    if(!object(input)||!Array.isArray(input.list)||Object.hasOwn(input,'next_page_token')&&input.next_page_token!==null&&
      input.next_page_token!==undefined&&input.next_page_token!==''&&!cursorToken(input.next_page_token))
      throw new Error('GMGN_PLUS_ARCHIVE_CALLOUT_PAGE_INVALID');
    if(pageToken!==undefined&&!cursorToken(pageToken))throw new Error('GMGN_PLUS_ARCHIVE_CALLOUT_PAGE_INVALID');
    const known=mode==='latest'?this.meta(`callout_${feed}_latest_high_water`)??this.storedCalloutHighWater(feed):undefined;
    const result=this.recordCallouts(feed,input);if(result.capacityReached)return result;
    if(result.received>0&&result.accepted===0)throw new Error('GMGN_PLUS_ARCHIVE_CALLOUT_PAGE_REJECTED');
    const next=cursorToken(input.next_page_token)?input.next_page_token:'';
    if(mode==='latest'){
      const exists=this.db.prepare("SELECT 1 FROM gpa_events WHERE event_key=? AND kind='callout'");
      const ids=input.list.flatMap(row=>object(row)&&typeof row.ulid==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(row.ulid)&&
        exists.get(`callout:${row.ulid}`)?[row.ulid]:[]),head=ids[0];
      if(pageToken===undefined){
        this.setMeta(`callout_${feed}_frontier_cursor`,next);
        if(this.meta(`callout_${feed}_backfill_started`)!=='1'){
          this.setMeta(`callout_${feed}_backfill_cursor`,next);this.setMeta(`callout_${feed}_backfill_started`,'1');
        }
        if(!known){if(head)this.setMeta(`callout_${feed}_latest_high_water`,head);this.resetCalloutLatest(feed);}
        else if(ids.includes(known)||!next){this.resetCalloutLatest(feed);if(head)this.setMeta(`callout_${feed}_latest_high_water`,head);}
        else if(head){this.setMeta(`callout_${feed}_latest_pending_high_water`,head);this.setMeta(`callout_${feed}_latest_cursor`,next);}
      }else{
        const pending=this.meta(`callout_${feed}_latest_pending_high_water`);
        if(!pending)this.resetCalloutLatest(feed);
        else if(ids.includes(known??'')||!next){this.resetCalloutLatest(feed);this.setMeta(`callout_${feed}_latest_high_water`,pending);}
        else if(next===pageToken)throw new GmgnError('GMGN_CURSOR_INVALID');
        else this.setMeta(`callout_${feed}_latest_cursor`,next);
      }
    }else{
      this.setMeta(`callout_${feed}_backfill_cursor`,next);
      if(!next)this.setMeta(`callout_${feed}_backfill_complete`,'1');
    }
    return result;
  }
  resetCalloutCursor(feed:GmgnCalloutFeed){const frontier=this.calloutFrontier(feed)??'';
    this.setMeta(`callout_${feed}_backfill_cursor`,frontier);this.setMeta(`callout_${feed}_backfill_complete`,frontier?'0':'1');}
  resetCalloutLatest(feed:GmgnCalloutFeed){this.setMeta(`callout_${feed}_latest_cursor`,'');this.setMeta(`callout_${feed}_latest_pending_high_water`,'');}
  private storedCalloutHighWater(feed:GmgnCalloutFeed){return this.db.prepare(`SELECT upstream_id FROM gpa_events WHERE kind='callout'
    AND (?='global' OR is_declaration=1) ORDER BY event_at DESC,upstream_id DESC LIMIT 1`).get(feed)?.upstream_id as string|undefined;}

  candidateBatch(kind:'stats'|'profits'|'activity',limit:number,refreshMs:number):{chain:GmgnArchiveChain;addresses:string[]} {
    if(!Number.isSafeInteger(limit)||limit<1||limit>20)return {chain:'sol',addresses:[]};
    const column=kind==='stats'?'last_stats_at':kind==='profits'?'last_profits_at':'last_activity_at',cutoff=new Date(this.now().getTime()-refreshMs).toISOString(),now=this.now().toISOString();
    const extra=kind==='activity'?'AND ((source_mask & 15)!=0 OR occurrences>=2)':'',order=kind==='activity'?
      `CASE WHEN activity_cursor IS NOT NULL THEN 0 WHEN last_activity_at IS NULL THEN 1 ELSE 2 END,
       CASE WHEN activity_cursor IS NULL THEN last_activity_at END ASC,occurrences DESC,address ASC`:
      `CASE WHEN ${column} IS NULL THEN 0 ELSE 1 END,${column} ASC,occurrences DESC,address ASC`;
    const chain=this.db.prepare(`SELECT chain FROM gpa_wallet_candidates WHERE (retry_after IS NULL OR retry_after<=?)
      AND (${column} IS NULL OR ${column}<=?) ${extra} ORDER BY ${order} LIMIT 1`).get(now,cutoff)?.chain as GmgnArchiveChain|undefined;
    if(!chain)return {chain:'sol',addresses:[]};
    const rows=this.db.prepare(`SELECT address FROM gpa_wallet_candidates WHERE chain=? AND (retry_after IS NULL OR retry_after<=?)
      AND (${column} IS NULL OR ${column}<=?) ${extra} ORDER BY ${order} LIMIT ?`).all(chain,now,cutoff,kind==='activity'?1:limit);
    return {chain,addresses:rows.map(row=>String(row.address))};
  }

  recordWalletStats(chain:GmgnArchiveChain,requested:string[],input:unknown,period:'7d'|'30d'='7d'){
    const data=portfolioData(input),rows=Array.isArray(data)?data:object(data)?[data]:[];
    return this.recordWalletSnapshots(chain,requested,'stats',period,rows);
  }
  recordWalletProfits(chain:GmgnArchiveChain,requested:string[],input:unknown,period:'1d'|'7d'|'30d'|'all'='all'){
    const data=portfolioData(input),rows=object(data)&&Array.isArray(data.list)?data.list:Array.isArray(data)?data:object(data)?[data]:[];
    return this.recordWalletSnapshots(chain,requested,'profits',period,rows);
  }
  private recordWalletSnapshots(chain:GmgnArchiveChain,requested:string[],kind:'stats'|'profits',period:string,rows:unknown[]){
    const requestedSet=new Set(requested),acceptedAddresses=new Set<string>(),at=this.now().toISOString(),column=kind==='stats'?'last_stats_at':'last_profits_at';
    if(this.capacityReached(Math.min(4*1024*1024,rows.reduce<number>((n,row)=>n+(rawJson(row)?.length??0),0))))return {accepted:0,capacityReached:true};
    try{this.db.exec('BEGIN IMMEDIATE');for(const row of rows.slice(0,100)){if(!object(row))continue;
      const address=chainAddress(row.wallet_address??(object(row.common)?row.common.wallet_address:undefined),chain),raw=rawJson(row,1_048_576);
      if(!address||!requestedSet.has(address)||acceptedAddresses.has(address)||!raw)continue;
      const normalized=kind==='stats'?{realizedProfit:finite(row.realized_profit),realizedPnl:finite(row.realized_profit_pnl),buy:finite(row.buy),sell:finite(row.sell),
        winrate:object(row.pnl_stat)?finite(row.pnl_stat.winrate):undefined,tokenCount:object(row.pnl_stat)?finite(row.pnl_stat.token_num):undefined,
        averageHoldingSec:object(row.pnl_stat)?finite(row.pnl_stat.avg_holding_period):undefined,
        tags:object(row.common)&&Array.isArray(row.common.tags)?row.common.tags.filter(v=>typeof v==='string').slice(0,30):[],
        fundFrom:object(row.common)?text(row.common.fund_from,128):undefined,fundFromAddress:object(row.common)?text(row.common.fund_from_address,128):undefined}:
        {realizedProfit:finite(row.realized_profit??row.total_realized_profit),unrealizedProfit:finite(row.unrealized_profit),totalProfit:finite(row.total_profit),
          totalCost:finite(row.total_cost),buy:finite(row.buy),sell:finite(row.sell)};
      this.db.prepare(`INSERT INTO gpa_wallet_snapshots VALUES(?,?,?,?,?,?,?) ON CONFLICT(chain,address,kind,period) DO UPDATE SET
        observed_at=excluded.observed_at,normalized_json=excluded.normalized_json,raw_json=excluded.raw_json`).run(chain,address,kind,period,at,JSON.stringify(normalized),raw);
      this.db.prepare(`UPDATE gpa_wallet_candidates SET ${column}=?,failure_count=0,retry_after=NULL WHERE chain=? AND address=?`).run(at,chain,address);acceptedAddresses.add(address);}
      const missing=[...requestedSet].filter(address=>!acceptedAddresses.has(address));this.deferCandidatesAt(chain,missing,new Date(at));
      this.setMeta('last_success_at',at);this.db.exec('COMMIT');this.invalidateStatusCounts();return {accepted:acceptedAddresses.size,missing:missing.length,capacityReached:false};
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}if(this.isFull(error))return {accepted:0,capacityReached:true};throw error;}
  }

  recordWalletHoldingsPage(chain:GmgnArchiveChain,wallet:string,mode:'current'|'closed',page:number,input:unknown){
    if(!chainAddress(wallet,chain)||!Number.isSafeInteger(page)||page<1||page>10_000)
      throw new Error('GMGN_PLUS_ARCHIVE_HOLDINGS_PAGE_INVALID');
    const data=portfolioData(input);if(!object(data)||!Array.isArray(data.list)||Object.hasOwn(data,'next')&&data.next!==null&&
      data.next!==undefined&&data.next!==''&&!cursorToken(data.next))throw new Error('GMGN_PLUS_ARCHIVE_HOLDINGS_PAGE_INVALID');
    const raw=rawJson(input,8*1024*1024);if(!raw)throw new Error('GMGN_PLUS_ARCHIVE_HOLDINGS_PAGE_TOO_LARGE');
    if(this.capacityReached(raw.length))return {accepted:0,capacityReached:true};
    const at=this.now().toISOString(),next=cursorToken(data.next)?data.next:null;
    try{this.db.prepare(`INSERT INTO gpa_wallet_holding_pages VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(chain,address,mode,page) DO UPDATE SET
      observed_at=excluded.observed_at,row_count=excluded.row_count,next_cursor=excluded.next_cursor,raw_json=excluded.raw_json`)
      .run(chain,wallet,mode,page,at,data.list.length,next,raw);this.setMeta('last_success_at',at);this.invalidateStatusCounts();
      return {accepted:1,rows:data.list.length,capacityReached:false};
    }catch(error){if(this.isFull(error))return {accepted:0,capacityReached:true};throw error;}
  }

  recordWalletActivity(chain:GmgnArchiveChain,wallet:string,input:unknown){
    const data=portfolioData(input);if(!object(data)||!Array.isArray(data.activities))return {accepted:0,rejected:0,capacityReached:false};
    const expectedWallet=chainAddress(wallet,chain);if(!expectedWallet||!this.activityIdentityMatches(data,chain,expectedWallet)||
      data.activities.some(row=>object(row)&&!this.activityIdentityMatches(row,chain,expectedWallet)))
      throw new Error('GMGN_PLUS_ARCHIVE_ACTIVITY_IDENTITY_MISMATCH');
    if(Object.hasOwn(data,'next')&&data.next!==null&&data.next!==undefined&&data.next!==''&&!cursorToken(data.next))
      throw new GmgnError('GMGN_CURSOR_INVALID');
    const rows=data.activities.slice(0,50),at=this.now().toISOString();if(this.capacityReached(rows.reduce((n,row)=>n+(rawJson(row)?.length??0),0)))
      return {accepted:0,rejected:0,capacityReached:true};
    let accepted=0,rejected=0;
    try{this.db.exec('BEGIN IMMEDIATE');for(const row of rows){if(!object(row)||!object(row.token)){rejected++;continue;}
      const tx=txAddress(row.tx_hash,chain),token=chainAddress(row.token.address,chain),eventType=text(row.event_type??row.type,32),
        when=iso(Number(row.timestamp)*1000),raw=rawJson(row);if(!tx||!token||!eventType||!['buy','sell','transferIn','transferOut','add','remove','burn','launch'].includes(eventType)||!when||!raw){rejected++;continue;}
      // GMGN currently exposes no stable activity index. Keep exact repeated
      // rows idempotent while preserving multiple same-token legs in one tx.
      const stableIndex=boundedScalar(row.event_id??row.activity_id??row.log_index??row.event_index,128),discriminator=stableIndex||[
        boundedScalar(row.timestamp),boundedScalar(row.token_amount),boundedScalar(row.quote_amount),boundedScalar(row.from_address,128),
        boundedScalar(row.to_address,128),boundedScalar(row.is_open_or_close,16)].join('\0');
      this.db.prepare(`INSERT INTO gpa_wallet_activity VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET observed_at=excluded.observed_at,raw_json=excluded.raw_json`)
        .run(hash(`${chain}\0${wallet}\0${tx}\0${eventType}\0${token}\0${discriminator}`),chain,wallet,tx,eventType,token,when,text(row.cost_usd??row.buy_cost_usd,160)??null,at,raw);accepted++;}
      const next=cursorToken(data.next)?data.next:null,current=this.db.prepare('SELECT activity_pages FROM gpa_wallet_candidates WHERE chain=? AND address=?').get(chain,wallet),
        pages=Number(current?.activity_pages??0)+1,done=!next||pages>=2;
      this.db.prepare(`UPDATE gpa_wallet_candidates SET activity_cursor=?,activity_pages=?,activity_truncated=?,last_activity_at=?,failure_count=0,retry_after=NULL
        WHERE chain=? AND address=?`).run(done?null:next,done?0:pages,Number(!!next&&pages>=2),done?at:null,chain,wallet);
      this.setMeta('last_success_at',at);this.db.exec('COMMIT');this.invalidateStatusCounts();return {accepted,rejected,capacityReached:false};
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}if(this.isFull(error))return {accepted:0,rejected:0,capacityReached:true};throw error;}
  }
  activityCursor(chain:GmgnArchiveChain,wallet:string){const value=this.db.prepare('SELECT activity_cursor FROM gpa_wallet_candidates WHERE chain=? AND address=?').get(chain,wallet)?.activity_cursor;
    if(value===null||value===undefined)return;if(cursorToken(value))return value;
    this.db.prepare('UPDATE gpa_wallet_candidates SET activity_cursor=NULL,activity_pages=0 WHERE chain=? AND address=?').run(chain,wallet);
    throw new GmgnError('GMGN_CURSOR_INVALID');
  }
  resetActivityCursor(chain:GmgnArchiveChain,wallet:string){
    this.db.prepare('UPDATE gpa_wallet_candidates SET activity_cursor=NULL,activity_pages=0 WHERE chain=? AND address=?').run(chain,wallet);
    this.deferCandidates(chain,[wallet]);
  }
  deferCandidates(chain:GmgnArchiveChain,addresses:string[]){this.deferCandidatesAt(chain,addresses,this.now());}
  private deferCandidatesAt(chain:GmgnArchiveChain,addresses:string[],now:Date){const stmt=this.db.prepare(`UPDATE gpa_wallet_candidates SET failure_count=failure_count+1,
    retry_after=? WHERE chain=? AND address=?`);for(const address of addresses){const count=Number(this.db.prepare('SELECT failure_count FROM gpa_wallet_candidates WHERE chain=? AND address=?').get(chain,address)?.failure_count??0),
      delay=Math.min(6*60*60*1000,30_000*2**Math.min(count,8));stmt.run(new Date(now.getTime()+delay).toISOString(),chain,address);}}
  private activityIdentityMatches(value:Obj,chain:GmgnArchiveChain,wallet:string){
    if(Object.hasOwn(value,'chain')&&apiChain(value.chain)!==chain)return false;
    for(const key of ['wallet','wallet_address'] as const)if(Object.hasOwn(value,key)&&chainAddress(value[key],chain)!==wallet)return false;
    return true;
  }
}

export interface GmgnPlusArchiveRunnerOptions {archive:GmgnPlusArchive;client:Pick<GmgnClient,'getMemeMarketSignals'|'getCalloutGlobal'|'getWalletStats'|'getWalletProfits'|'getWalletActivity'|'cooldownUntil'>;
  chains:GmgnArchiveChain[];intervalMs:number;now?:()=>Date;}
type Task={kind:'market';chain:GmgnArchiveChain}|{kind:'callout_latest'|'callout_backfill';feed:GmgnCalloutFeed}|{kind:'stats'|'profits'|'activity'};

export class GmgnPlusArchiveRunner {
  private readonly tasks:Task[];private readonly now:()=>Date;private running=false;private inFlight?:Promise<void>;private timer?:ReturnType<typeof setTimeout>;
  private lastTask?:string;private lastError?:string;
  constructor(private readonly options:GmgnPlusArchiveRunnerOptions){
    if(!options.chains.length||options.chains.some(chain=>!['sol','bsc','robinhood'].includes(chain))||!Number.isSafeInteger(options.intervalMs)||options.intervalMs<5_000||options.intervalMs>3_600_000)
      throw new Error('GMGN_PLUS_ARCHIVE_RUNNER_CONFIG_INVALID');
    this.now=options.now??(()=>new Date());this.tasks=[...[...new Set(options.chains)].map(chain=>({kind:'market' as const,chain})),
      {kind:'callout_latest',feed:'global'},{kind:'callout_latest',feed:'declaration'},
      {kind:'callout_backfill',feed:'global'},{kind:'callout_backfill',feed:'declaration'},
      {kind:'stats'},{kind:'profits'},{kind:'activity'}];
  }
  status(){return {...this.options.archive.status(),running:this.running,inFlight:!!this.inFlight,lastTask:this.lastTask,lastError:this.lastError,
    intervalMs:this.options.intervalMs,tasks:this.tasks.length,coverage:'deduplicated_latest_feeds_plus_cursor_backfill',entryPipeline:false};}
  start(){if(this.running)return;this.running=true;this.tick(0);}
  async stop(){this.running=false;clearTimeout(this.timer);this.timer=undefined;await this.inFlight?.catch(()=>{});this.options.archive.close();}
  runOnce(){if(this.inFlight)return this.inFlight;const run=this.execute();this.inFlight=run;void run.then(
    ()=>{if(this.inFlight===run)this.inFlight=undefined;},()=>{if(this.inFlight===run)this.inFlight=undefined;});return run;}
  private tick(delay:number){if(!this.running)return;this.timer=setTimeout(()=>{this.timer=undefined;void this.runOnce().catch(()=>{}).finally(()=>{
    if(!this.running)return;const cooldown=Math.max(0,this.options.client.cooldownUntil-this.now().getTime());this.tick(Math.max(this.options.intervalMs,cooldown));});},delay);this.timer.unref();}
  private async execute(){
    if(this.options.archive.capacityReached()){this.lastError='GMGN_PLUS_ARCHIVE_CAPACITY_REACHED';return;}
    if(this.options.client.cooldownUntil>this.now().getTime()){this.lastError='GMGN_RATE_LIMITED';return;}
    let cursor=Number(this.options.archive.meta('runner_cursor')??0);if(!Number.isSafeInteger(cursor)||cursor<0)cursor=0;
    const task=this.tasks[cursor%this.tasks.length],taskId=task.kind+('chain'in task?`_${task.chain}`:'feed'in task?`_${task.feed}`:'');
    const breakerKey=`task_failure_${taskId}`;this.lastTask=task.kind+('chain'in task?`:${task.chain}`:'feed'in task?`:${task.feed}`:'');
    try{
      if(task.kind==='market')this.options.archive.recordMarketSignals(task.chain,await this.options.client.getMemeMarketSignals(task.chain));
      else if(task.kind==='callout_latest'){
        let page=this.options.archive.calloutLatestCursor(task.feed);for(let i=0;i<10;i++){
          this.options.archive.commitCalloutPage(task.feed,await this.options.client.getCalloutGlobal(this.options.chains,
            {limit:50,pageToken:page,onlyDeclaration:task.feed==='declaration'}),'latest',page);
          const next=this.options.archive.calloutLatestCursor(task.feed);if(!next)break;page=next;
        }
      }
      else if(task.kind==='callout_backfill'){
        const page=this.options.archive.calloutCursor(task.feed);
        if(page)this.options.archive.commitCalloutPage(task.feed,await this.options.client.getCalloutGlobal(this.options.chains,
          {limit:50,pageToken:page,onlyDeclaration:task.feed==='declaration'}),'backfill');
      }else if(task.kind==='stats'){
        const batch=this.options.archive.candidateBatch('stats',1,6*60*60*1000);if(batch.addresses.length){
          try{this.options.archive.recordWalletStats(batch.chain,batch.addresses,await this.options.client.getWalletStats(batch.chain,batch.addresses));}
          catch(error){this.options.archive.deferCandidates(batch.chain,batch.addresses);throw error;}}
      }else if(task.kind==='profits'){
        const batch=this.options.archive.candidateBatch('profits',20,6*60*60*1000);if(batch.addresses.length){
          try{this.options.archive.recordWalletProfits(batch.chain,batch.addresses,await this.options.client.getWalletProfits(batch.chain,batch.addresses));}
          catch(error){this.options.archive.deferCandidates(batch.chain,batch.addresses);throw error;}}
      }else{
        const batch=this.options.archive.candidateBatch('activity',1,24*60*60*1000),wallet=batch.addresses[0];if(wallet){
          try{this.options.archive.recordWalletActivity(batch.chain,wallet,await this.options.client.getWalletActivity(batch.chain,wallet,
            this.options.archive.activityCursor(batch.chain,wallet)));}
          catch(error){if(error instanceof GmgnError&&error.reason==='GMGN_CURSOR_INVALID')
            this.options.archive.resetActivityCursor(batch.chain,wallet);else this.options.archive.deferCandidates(batch.chain,batch.addresses);throw error;}}
      }
      this.options.archive.setMeta('runner_cursor',String(cursor+1));this.options.archive.setMeta('last_success_at',this.now().toISOString());
      this.options.archive.setMeta('last_error','');this.options.archive.setMeta(breakerKey,'0');this.lastError=undefined;
    }catch(error){
      if(error instanceof GmgnError&&error.reason==='GMGN_CURSOR_INVALID'&&'feed'in task){
        if(task.kind==='callout_latest')this.options.archive.resetCalloutLatest(task.feed);else this.options.archive.resetCalloutCursor(task.feed);
      }
      this.lastError=error instanceof GmgnError?error.reason:'GMGN_PLUS_ARCHIVE_REQUEST_FAILED';
      try{this.options.archive.setMeta('last_error',this.lastError);}catch{}
      // Rate/queue/preemption failures retry exactly. Bad cursors reset once;
      // other persistent endpoint failures trip a three-attempt task breaker
      // so one unavailable route cannot freeze all research feeds.
      if(error instanceof GmgnError&&error.reason==='GMGN_CURSOR_INVALID'){
        this.options.archive.setMeta(breakerKey,'0');this.options.archive.setMeta('runner_cursor',String(cursor+1));
      }else if(!(error instanceof GmgnError&&['GMGN_RATE_LIMITED','GMGN_QUEUE_TIMEOUT','GMGN_REQUEST_ABORTED'].includes(error.reason))){
        const failures=Math.min(3,Math.max(0,Number(this.options.archive.meta(breakerKey)??0)||0)+1);
        this.options.archive.setMeta(breakerKey,String(failures));if(failures>=3){
          this.options.archive.setMeta(breakerKey,'0');this.options.archive.setMeta('runner_cursor',String(cursor+1));
        }
      }
    }
  }
}
