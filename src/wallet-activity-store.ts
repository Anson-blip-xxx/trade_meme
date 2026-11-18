import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {chainAddress} from './chain-stream-store.js';
import type {WalletActivity,ActivityKind} from './wallet-activity.js';
import {configureResearchWal} from './research-sqlite.js';

const kinds:ActivityKind[]=['buy','sell','received_purchase','distribution','transfer','self_transfer','approval','liquidity','wrap','failed','retracted','no_change','unknown'];
const lowValueKinds=['unknown','transfer','no_change'] as const satisfies readonly ActivityKind[];
const lowValue=new Set<ActivityKind>(lowValueKinds);
const CAPACITY='WALLET_ACTIVITY_CAPACITY_REACHED';
const LOW_VALUE_TTL_MS=24*60*60*1000;
const LOW_VALUE_MAX_ROWS=10_000;
const MAINTENANCE_BATCH=1_000;
const MAINTENANCE_INTERVAL_MS=30_000;
const LOW_VALUE_RETENTION_QUERY=`SELECT id,kind,checked_at FROM wallet_activity INDEXED BY wallet_activity_low_value_recent
  WHERE kind IN ('unknown','transfer','no_change') ORDER BY checked_at ASC LIMIT ?`;

export interface WalletActivityStoreOptions {
  now?:()=>number;
  lowValueTtlMs?:number;
  lowValueMaxRows?:number;
  maintenanceBatchSize?:number;
  maintenanceIntervalMs?:number;
}

export interface WalletActivityMaintenance {
  deleted:number;lowValueRows:number;usedBytes:number;freePages:number;completedAt:string;
}

const bounded=(value:number|undefined,fallback:number,min:number,max:number)=>
  value===undefined?fallback:Number.isSafeInteger(value)&&value>=min&&value<=max?value:(()=>{throw new Error('WALLET_ACTIVITY_RETENTION_INVALID');})();
const sqliteFull=(error:unknown)=>error instanceof Error&&/(?:SQLITE_FULL|database or disk is full)/i.test(error.message);
const priority=(kind:ActivityKind)=>kind==='retracted'?100:kind==='buy'||kind==='sell'?90:kind==='received_purchase'?80:
  kind==='distribution'||kind==='liquidity'?70:lowValue.has(kind)?10:50;

/**
 * Classification evidence stays separate from buy metrics and vendor profit
 * claims. Confirmed trade/retraction evidence is durable. Diagnostic noise is a
 * short-lived, bounded sample whose pages are reused in place; hot maintenance
 * never runs VACUUM.
 */
export class WalletActivityStore {
  private db:DatabaseSync;private error?:string;private readonly counts:Partial<Record<ActivityKind,number>>={};
  private readonly now:()=>number;private readonly lowValueTtlMs:number;private readonly lowValueMaxRows:number;
  private readonly maintenanceBatchSize:number;private readonly maintenanceIntervalMs:number;
  private readonly pageSize:number;private readonly reserveBytes:number;
  private lowValueRows=0;private nextMaintenanceAt=0;private lastMaintenanceAt?:string;private maintenanceDeleted=0;
  private readonly shed:Partial<Record<ActivityKind,number>>={};

  constructor(private path:string,private maxBytes=128*1024*1024,options:WalletActivityStoreOptions={}){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<64*1024)throw new Error('WALLET_ACTIVITY_LIMIT_INVALID');
    this.now=options.now??Date.now;
    this.lowValueTtlMs=bounded(options.lowValueTtlMs,LOW_VALUE_TTL_MS,1_000,30*24*60*60*1000);
    this.lowValueMaxRows=bounded(options.lowValueMaxRows,LOW_VALUE_MAX_ROWS,1,100_000);
    this.maintenanceBatchSize=bounded(options.maintenanceBatchSize,MAINTENANCE_BATCH,1,10_000);
    this.maintenanceIntervalMs=bounded(options.maintenanceIntervalMs,MAINTENANCE_INTERVAL_MS,1_000,60*60*1000);
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    configureResearchWal(this.db,{busyTimeoutMs:1000,autoCheckpointPages:1000});
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_activity(id TEXT PRIMARY KEY,chain TEXT,wallet TEXT,tx_hash TEXT,kind TEXT,checked_at TEXT,data TEXT);
      CREATE INDEX IF NOT EXISTS wallet_activity_recent ON wallet_activity(checked_at DESC);
      CREATE INDEX IF NOT EXISTS wallet_activity_kind ON wallet_activity(kind);
      CREATE INDEX IF NOT EXISTS wallet_activity_low_value_recent ON wallet_activity(checked_at)
        WHERE kind IN ('unknown','transfer','no_change');
      CREATE TABLE IF NOT EXISTS wallet_activity_meta(key TEXT PRIMARY KEY,value TEXT);`);
    this.pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    if(!Number.isSafeInteger(this.pageSize)||this.pageSize<=0)throw new Error('WALLET_ACTIVITY_STORAGE_INVALID');
    // SQLite enforces the durable main-file ceiling. WAL bytes are transient and
    // must not make a reusable database look full merely because it is awaiting a checkpoint.
    this.db.exec(`PRAGMA max_page_count=${Math.max(16,Math.floor(this.maxBytes/this.pageSize))}`);
    this.reserveBytes=Math.max(this.pageSize*8,Math.min(16*1024*1024,Math.floor(this.maxBytes*.1)));
    const storedError=this.db.prepare("SELECT value FROM wallet_activity_meta WHERE key='error'").get()?.value;
    this.error=typeof storedError==='string'&&storedError?storedError:undefined;
    for(const row of this.db.prepare('SELECT kind,count(*) AS n FROM wallet_activity GROUP BY kind').all())
      if(kinds.includes(row.kind as ActivityKind)){const kind=row.kind as ActivityKind,count=Number(row.n);this.counts[kind]=count;if(lowValue.has(kind))this.lowValueRows+=count;}
    // One bounded startup pass starts reclaiming legacy noise without delaying
    // service startup with a table-wide rewrite. A checkpoint also collapses a
    // stale WAL after a clean restart; it does not rewrite the main database.
    this.runMaintenance(this.maintenanceBatchSize,false);this.checkpointWal();
    // A previous full-disk marker is diagnostic state, not a permanent latch.
    // Clear it after startup retention has restored the reserved write space.
    if(this.error===CAPACITY&&this.storage().usedBytes<this.maxBytes-this.reserveBytes)this.setError(undefined);
  }

  record(input:WalletActivity):boolean {
    const wallet=chainAddress(input.chain,input.wallet);if(!wallet||!kinds.includes(input.classification)||input.version!==1)return false;
    try{if(input.chain==='solana'?bs58.decode(input.txHash).length!==64:!/^0x[0-9a-f]{64}$/.test(input.txHash))return false;}catch{return false;}
    if(![input.receivedAt,input.checkedAt,...(input.eventAt?[input.eventAt]:[])].every(t=>typeof t==='string'&&Number.isFinite(Date.parse(t))))return false;
    if(!Array.isArray(input.reasons)||!Array.isArray(input.trades))return false;
    this.maybeMaintain();
    const data:WalletActivity={version:1,chain:input.chain,wallet,txHash:input.txHash,
      receivedAt:new Date(input.receivedAt).toISOString(),checkedAt:new Date(input.checkedAt).toISOString(),
      classification:input.classification,reasons:input.reasons.filter(r=>/^[A-Z_]{1,80}$/.test(r)).slice(0,12),
      trades:input.trades.slice(0,4).filter(t=>chainAddress(input.chain,t.tokenAddress)&&['buy','sell'].includes(t.side)&&/^\d{1,80}$/.test(t.amountAtomic)&&/^[a-z0-9_]{1,40}$/.test(t.protocol))
        .map(t=>({tokenAddress:t.tokenAddress,side:t.side,amountAtomic:t.amountAtomic,protocol:t.protocol,
          ...(t.quoteAddress&&chainAddress(input.chain,t.quoteAddress)?{quoteAddress:t.quoteAddress}:{}),
          ...(t.quoteAmountAtomic&&/^\d{1,80}$/.test(t.quoteAmountAtomic)?{quoteAmountAtomic:t.quoteAmountAtomic}:{})})),
      retryable:input.retryable===true,confirmation:['confirmed','included'].includes(input.confirmation)?input.confirmation:'unknown',
      transferCount:Number.isSafeInteger(input.transferCount)&&input.transferCount>=0?input.transferCount:0,tradingEnabled:false,
      ...(chainAddress(input.chain,input.initiator)?{initiator:input.initiator}:{}),
      transfers:(input.transfers??[]).slice(0,32).filter(t=>chainAddress(input.chain,t.from)&&chainAddress(input.chain,t.to)&&/^\d{1,80}$/.test(t.amountAtomic)&&(!t.tokenAddress||chainAddress(input.chain,t.tokenAddress)))
        .map(t=>({from:t.from,to:t.to,amountAtomic:t.amountAtomic,...(t.tokenAddress?{tokenAddress:t.tokenAddress}:{})})),
      ...(input.eventAt?{eventAt:new Date(input.eventAt).toISOString()}:{}),...(input.blockHash&&/^0x[0-9a-f]{64}$/i.test(input.blockHash)?{blockHash:input.blockHash}:{}),
      ...(Number.isSafeInteger(input.slot)&&input.slot!>=0?{slot:input.slot}:{})};
    const id=createHash('sha256').update(JSON.stringify([data.chain,wallet,data.txHash])).digest('hex'),serialized=JSON.stringify(data);
    const old=this.db.prepare('SELECT kind FROM wallet_activity WHERE id=?').get(id),oldKind=old?.kind as ActivityKind|undefined;
    let persistedOldKind=oldKind;
    if(oldKind==='retracted')return data.classification==='retracted';
    // A retry that degrades to unknown/transfer cannot erase an already verified
    // buy, sell or other stronger classification for the same transaction.
    if(oldKind&&priority(data.classification)<priority(oldKind))return true;
    if(!old&&lowValue.has(data.classification)){
      if(this.lowValueRows>=this.lowValueMaxRows){
        if(this.now()>=this.nextMaintenanceAt)this.runMaintenance(this.maintenanceBatchSize,false);
        if(this.lowValueRows===this.lowValueMaxRows)this.reclaimLowValue(1,this.lowValueMaxRows-1);
        if(this.lowValueRows>=this.lowValueMaxRows){this.shed[data.classification]=(this.shed[data.classification]??0)+1;return true;}
      }
      const estimate=16_384+serialized.length*3;
      if(this.storage().usedBytes+estimate>this.maxBytes-this.reserveBytes){
        this.reclaimLowValue(this.maintenanceBatchSize,Math.max(0,this.lowValueRows-this.maintenanceBatchSize));
        if(this.storage().usedBytes+estimate>this.maxBytes-this.reserveBytes){this.shed[data.classification]=(this.shed[data.classification]??0)+1;return true;}
      }
    }
    const write=()=>this.db.prepare('INSERT INTO wallet_activity VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,checked_at=excluded.checked_at,data=excluded.data')
      .run(id,data.chain,wallet,data.txHash,data.classification,data.checkedAt,serialized);
    try {write();}
    catch(error){
      if(!sqliteFull(error))throw error;
      // High-value evidence may evict diagnostic samples. If no such pages are
      // reclaimable, the durable store is genuinely full and reports that fact.
      if(!this.reclaimLowValue(this.maintenanceBatchSize,Math.max(0,this.lowValueRows-this.maintenanceBatchSize))){this.setError(CAPACITY);return false;}
      // Reclaim may have deleted the very low-value row being upgraded. Base the
      // successful retry's counters on what still exists, not on the stale
      // pre-reclaim lookup, otherwise that row is subtracted twice.
      persistedOldKind=this.db.prepare('SELECT kind FROM wallet_activity WHERE id=?').get(id)?.kind as ActivityKind|undefined;
      try{write();}catch(retry){if(sqliteFull(retry)){this.setError(CAPACITY);return false;}throw retry;}
    }
    if(persistedOldKind!==data.classification){
      if(persistedOldKind&&this.counts[persistedOldKind]!==undefined){const next=this.counts[persistedOldKind]!-1;if(next>0)this.counts[persistedOldKind]=next;else delete this.counts[persistedOldKind];if(lowValue.has(persistedOldKind))this.lowValueRows--;}
      this.counts[data.classification]=(this.counts[data.classification]??0)+1;if(lowValue.has(data.classification))this.lowValueRows++;
    }
    this.setError(undefined);return true;
  }

  /** Bounded online retention pass. Deleted pages remain on SQLite's freelist for immediate reuse. */
  maintain(maxDelete=this.maintenanceBatchSize):WalletActivityMaintenance {
    return this.runMaintenance(maxDelete,true);
  }

  private runMaintenance(maxDelete:number,checkpoint:boolean):WalletActivityMaintenance {
    const limit=bounded(maxDelete,this.maintenanceBatchSize,1,10_000),deleted=this.reclaimLowValue(limit,this.lowValueMaxRows),storage=this.storage();
    // Automatic retention runs inline with activity ingestion, so it only
    // returns pages to the freelist. Explicit maintenance may checkpoint after
    // deletion; WAL auto-checkpointing is deliberately kept at SQLite's 1000-page default.
    if(deleted&&checkpoint)this.checkpointWal();
    const completedAt=new Date(this.now()).toISOString();this.lastMaintenanceAt=completedAt;this.nextMaintenanceAt=this.now()+this.maintenanceIntervalMs;
    return {deleted,lowValueRows:this.lowValueRows,usedBytes:storage.usedBytes,freePages:storage.freePages,completedAt};
  }

  private maybeMaintain():void {if(this.now()>=this.nextMaintenanceAt)this.runMaintenance(this.maintenanceBatchSize,false);}

  private reclaimLowValue(maxDelete:number,targetRows:number):number {
    if(this.lowValueRows<=0||maxDelete<=0)return 0;
    // The partial time index contains only disposable diagnostics. This keeps
    // synchronous maintenance proportional to the bounded noise sample instead
    // of scanning durable buy/sell history to find sparse low-value rows.
    const cutoff=new Date(this.now()-this.lowValueTtlMs).toISOString(),rows=this.db.prepare(LOW_VALUE_RETENTION_QUERY)
      .all(maxDelete) as {id:string;kind:ActivityKind;checked_at:string}[];
    const selected:typeof rows=[];let remaining=this.lowValueRows;
    for(const row of rows){if(String(row.checked_at)<cutoff||remaining>targetRows){selected.push(row);remaining--;}else break;}
    if(!selected.length)return 0;
    const remove=this.db.prepare("DELETE FROM wallet_activity WHERE id=? AND kind IN ('unknown','transfer','no_change')");let deleted=0;
    this.db.exec('BEGIN IMMEDIATE');try{
      for(const row of selected)if(Number(remove.run(row.id).changes)){deleted++;const next=(this.counts[row.kind]??0)-1;
        if(next>0)this.counts[row.kind]=next;else delete this.counts[row.kind];}
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.lowValueRows=Math.max(0,this.lowValueRows-deleted);this.maintenanceDeleted+=deleted;return deleted;
  }

  private storage(){const pageCount=Number(this.db.prepare('PRAGMA page_count').get()!.page_count),freePages=Number(this.db.prepare('PRAGMA freelist_count').get()!.freelist_count);
    return {pageCount,freePages,allocatedBytes:pageCount*this.pageSize,usedBytes:Math.max(0,pageCount-freePages)*this.pageSize};}
  private fileBytes(path:string){try{return statSync(path).size;}catch{return 0;}}
  private physicalStorage(){if(this.path===':memory:'){const mainBytes=this.storage().allocatedBytes;return {mainBytes,walBytes:0,shmBytes:0,physicalBytes:mainBytes};}
    const mainBytes=this.fileBytes(this.path),walBytes=this.fileBytes(this.path+'-wal'),shmBytes=this.fileBytes(this.path+'-shm');
    return {mainBytes,walBytes,shmBytes,physicalBytes:mainBytes+walBytes+shmBytes};}
  private checkpointWal(){try{const checkpoint=this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    // TRUNCATE only after PASSIVE proves that no reader is retaining frames, so
    // startup or explicit maintenance never waits for a dashboard reader.
    if(Number(checkpoint?.busy)===0&&Number(checkpoint?.log)===Number(checkpoint?.checkpointed))
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }catch{/* A concurrent reader may defer checkpointing; freelist pages remain reusable. */}}
  private setError(value:string|undefined){if(this.error===value)return;this.error=value;try{
    if(value)this.db.prepare("INSERT INTO wallet_activity_meta VALUES ('error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
    else this.db.prepare("DELETE FROM wallet_activity_meta WHERE key='error'").run();
  }catch{/* A full database can still expose the in-memory error without allocating a meta page. */}}

  status(){const storage={...this.storage(),...this.physicalStorage()};return {persisted:true,counts:{...this.counts},
    recent:this.db.prepare('SELECT data FROM wallet_activity ORDER BY checked_at DESC LIMIT 20').all().map(r=>JSON.parse(String(r.data)) as WalletActivity),
    error:this.error,maxBytes:this.maxBytes,bytes:storage.physicalBytes,physicalBytes:storage.physicalBytes,storage,
    retention:{lowValueKinds:[...lowValueKinds],ttlSec:this.lowValueTtlMs/1000,maxRows:this.lowValueMaxRows,lowValueRows:this.lowValueRows,
      shed:{...this.shed},maintenanceDeleted:this.maintenanceDeleted,lastMaintenanceAt:this.lastMaintenanceAt,
      strategy:'bounded_delete_and_freelist_reuse',checkpointMode:'startup_explicit_or_1000_page_autocheckpoint',vacuumOnHotPath:false},
    scope:'transaction_classification_not_profit_or_ownership'};}
  close(){this.db.close();}
}
