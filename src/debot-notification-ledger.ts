import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import type {Chain} from './types.js';
import type {DebotSignalObservation,DebotVendorWalletSnapshot} from './providers/debot-signals.js';
import {tokenDisplayText} from './token-display.js';

export type DebotNotificationKind='first'|'replay'|'display'|'wallet_hint';
export interface DebotNotificationResult {
  key:string;kind:DebotNotificationKind;firstSeenAt:string;lastSeenAt:string;notificationCount:number;deliveryCount:number;
  /** A distinct provider event, separate from changed wallet evidence or a card revision. */
  newEvent:boolean;
}
interface Snapshot {
  occurredAt:string;name?:string;symbol?:string;claimedPlatform?:string;walletCount:number;addressCount:number;
  aliases:string[];wallets:DebotVendorWalletSnapshot[];alertPriceUsd?:number;averageWalletVolumeUsd?:number;
}
interface GroupRow {
  chain:Chain;address:string;first_seen_at:string;last_seen_at:string;notification_count:number;delivery_count:number;
  version_count:number;latest_key:string;last_change_at:string;last_change_kind:DebotNotificationKind;
  snapshot:string;delta:string;reasons:string;
}
interface VersionRow {
  key:string;chain:Chain;address:string;event_id:string;vendor_event_id:string;occurred_at:string;observed_at:string;
  last_observed_at:string;kind:DebotNotificationKind;notification_count:number;delivery_count:number;
  delta:string;classification:string|null;reasons:string;evidence:string|null;
}
export interface DebotNotificationDelta {
  walletCount:{before:number;after:number};addressCount:{before:number;after:number};
  addedAddresses:string[];removedAddresses:string[];addedAliases:string[];removedAliases:string[];
  changedWallets:{identity:string;fields:string[]}[];displayFields:string[];eventTimeConflict?:boolean;
  verification:'vendor_report';
}
const MAX_VERSIONS=10_000,RETENTION_DAYS=30;
const recordObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const iso=(value:unknown):string|undefined=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():undefined;
const finite=(value:unknown):number|undefined=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:undefined;
const count=(value:unknown):number=>Number.isInteger(value)&&Number(value)>=0?Math.min(10_000,Number(value)):0;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const codes=(value:unknown):string[]=>Array.isArray(value)?[...new Set(value.filter((v):v is string=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(v)))].slice(0,24):[];
const sorted=(values:string[]):string[]=>[...new Set(values)].sort();
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function amount(value:unknown):string|undefined {
  if(typeof value!=='string'||value.length>100||!/^\d+(?:\.\d+)?$/.test(value))return;
  const [integer,fraction='']=value.split('.'),whole=integer.replace(/^0+(?=\d)/,''),tail=fraction.replace(/0+$/,'');
  return tail?`${whole}.${tail}`:whole;
}
function address(value:unknown,chain:Chain):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-f]{40}$/i.test(value)?value.toLowerCase():undefined;
  try {if(value.length>=32&&value.length<=44&&bs58.decode(value).length===32)return value;}catch {/* Invalid identity. */}
}
function identity(chain:Chain,ca:string):{chain:Chain;address:string} {
  const normalized=['bsc','solana','robinhood'].includes(chain)?address(ca,chain):undefined;
  if(!normalized)throw new Error('DEBOT_NOTIFICATION_IDENTITY_INVALID');
  return {chain,address:normalized};
}
function snapshot(observation:DebotSignalObservation):Snapshot {
  const chain=observation.signal.token.chain,occurredAt=iso(observation.signal.occurredAt);
  if(!occurredAt)throw new Error('DEBOT_NOTIFICATION_TIME_INVALID');
  const aliases=sorted((Array.isArray(observation.aliases)?observation.aliases:[])
    .map(value=>tokenDisplayText(value,80)).filter((v):v is string=>!!v)).slice(0,20);
  const wallets=(Array.isArray(observation.vendorWallets)?observation.vendorWallets:[]).slice(0,20).flatMap(wallet=>{
    if(!recordObject(wallet))return [];
    const alias=tokenDisplayText(wallet.alias,80),walletAddress=address(wallet.address,chain);
    if(!alias&&!walletAddress)return [];
    const lastTradeAt=iso(wallet.lastTradeAt),walletAmount=amount(wallet.amount);
    const volumeUsd=finite(wallet.volumeUsd),priceUsd=finite(wallet.priceUsd);
    return [{...(alias?{alias}:{}),...(walletAddress?{address:walletAddress}:{}),...(lastTradeAt?{lastTradeAt}:{}),
      ...(walletAmount?{amount:walletAmount}:{}),...(volumeUsd!==undefined?{volumeUsd}:{}),...(priceUsd!==undefined?{priceUsd}:{})}];
  });
  const uniqueWallets=[...new Map(wallets.map(wallet=>[JSON.stringify(wallet),wallet])).values()]
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {occurredAt,name:tokenDisplayText(observation.name,100),symbol:tokenDisplayText(observation.symbol,32),
    claimedPlatform:observation.signal.claimedPlatform,walletCount:count(observation.walletCount),addressCount:count(observation.addressCount),
    aliases,wallets:uniqueWallets,alertPriceUsd:finite(observation.alertPriceUsd),averageWalletVolumeUsd:finite(observation.averageWalletVolumeUsd)};
}
function material(value:Snapshot) {
  // A known wallet's alias may change without its identity changing. Alias-only
  // records remain unverified hints and can request a bounded details check.
  const namedAddresses=new Set(value.wallets.filter(wallet=>wallet.address).map(wallet=>wallet.alias));
  const aliases=value.aliases.filter(alias=>!namedAddresses.has(alias));
  const entries=value.wallets.map(wallet=>({identity:wallet.address??`alias:${wallet.alias}`,lastTradeAt:wallet.lastTradeAt,
    amount:wallet.amount,volumeUsd:wallet.volumeUsd}));
  const wallets=[...new Map(entries.map(wallet=>[JSON.stringify(wallet),wallet])).values()]
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {walletCount:value.walletCount,addressCount:value.addressCount,aliases,wallets};
}
function difference(before:Snapshot|undefined,after:Snapshot):{kind:Exclude<DebotNotificationKind,'replay'>;delta:DebotNotificationDelta;reasons:string[]} {
  const prior=before??{...after,walletCount:0,addressCount:0,aliases:[],wallets:[]};
  const beforeMaterial=material(prior),afterMaterial=material(after);
  const oldAddresses=sorted(prior.wallets.flatMap(w=>w.address?[w.address]:[])),newAddresses=sorted(after.wallets.flatMap(w=>w.address?[w.address]:[]));
  const oldWallets=new Map(beforeMaterial.wallets.map(wallet=>[wallet.identity,wallet]));
  const changedWallets=afterMaterial.wallets.flatMap(wallet=>{
    const previous=oldWallets.get(wallet.identity);if(!previous)return [];
    const fields=(['lastTradeAt','amount','volumeUsd'] as const).filter(field=>previous[field]!==wallet[field]);
    return fields.length?[{identity:wallet.identity,fields}]:[];
  });
  const displayFields=(['name','symbol','alertPriceUsd','averageWalletVolumeUsd','claimedPlatform'] as const)
    .filter(field=>!equal(prior[field],after[field])) as string[];
  if(!equal(prior.wallets.map(w=>[w.address??w.alias,w.priceUsd,w.alias]),after.wallets.map(w=>[w.address??w.alias,w.priceUsd,w.alias])))displayFields.push('walletDisplay');
  const delta:DebotNotificationDelta={walletCount:{before:prior.walletCount,after:after.walletCount},
    addressCount:{before:prior.addressCount,after:after.addressCount},addedAddresses:newAddresses.filter(a=>!oldAddresses.includes(a)),
    removedAddresses:oldAddresses.filter(a=>!newAddresses.includes(a)),addedAliases:afterMaterial.aliases.filter(a=>!beforeMaterial.aliases.includes(a)),
    removedAliases:beforeMaterial.aliases.filter(a=>!afterMaterial.aliases.includes(a)),changedWallets,displayFields,verification:'vendor_report'};
  const kind=!before?'first':!equal(beforeMaterial,afterMaterial)?'wallet_hint':'display';
  const reasons=kind==='first'?['DEBOT_FIRST_NOTIFICATION']:kind==='wallet_hint'?['DEBOT_VENDOR_WALLET_HINT_CHANGED']:displayFields.length?['DEBOT_DISPLAY_CHANGED']:['DEBOT_REPEAT_NOTIFICATION'];
  return {kind,delta,reasons};
}

/** Only named evidence fields reach the dashboard; raw vendor envelopes and credentials never do. */
function safeEvidence(value:unknown):Record<string,unknown>|undefined {
  if(!recordObject(value))return;
  const scalar=(source:Record<string,unknown>,fields:string[]):Record<string,unknown>=>{
    const result:Record<string,unknown>={};
    for(const key of fields){const item=source[key];
      if(typeof item==='string'&&item.length<=512&&!/[\u0000-\u001f\u007f]/.test(item)||
        typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))result[key]=item;
    }return result;
  };
  const result=scalar(value,['chain','address','fromAt','untilAt','status','coverage']);
  const sets:[string,number,string[]][]=[
    ['vendorChanges',24,['address','kind','source','verification','observedAt','previousObservedAt','eventAt','previousValue','value']],
    ['observedTrades',20,['evidenceId','txHash','wallet','side','volumeUsd','eventAt','observedAt','source','verification']],
    ['researchTargets',6,['address','triggerWallet','reason','txHash','eventAt','observedAt','source','verification']],
  ];
  for(const [key,limit,fields] of sets)if(Array.isArray(value[key]))result[key]=value[key].slice(0,limit).filter(recordObject).map(item=>scalar(item,fields));
  if(Array.isArray(value.limitations))result.limitations=codes(value.limitations);
  return Object.keys(result).length?result:undefined;
}

/** Bounded, local notification history; this class never submits or replays analysis. */
export class DebotNotificationLedger {
  private nextPruneAt=0;
  private retainedVersions=-1;
  constructor(private readonly db:DatabaseSync,private readonly now:()=>Date=()=>new Date()) {
    db.exec(`CREATE TABLE IF NOT EXISTS debot_notification_groups (
      chain TEXT NOT NULL,address TEXT NOT NULL,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,
      notification_count INTEGER NOT NULL,delivery_count INTEGER NOT NULL,version_count INTEGER NOT NULL,
      latest_key TEXT NOT NULL,last_change_at TEXT NOT NULL,last_change_kind TEXT NOT NULL,
      snapshot TEXT NOT NULL,delta TEXT NOT NULL,reasons TEXT NOT NULL,PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS debot_notification_groups_seen ON debot_notification_groups(last_seen_at);
      CREATE TABLE IF NOT EXISTS debot_notification_events (
        chain TEXT NOT NULL,address TEXT NOT NULL,event_id TEXT NOT NULL,vendor_event_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(chain,address,event_id));
      CREATE INDEX IF NOT EXISTS debot_notification_events_seen ON debot_notification_events(observed_at);
      CREATE TABLE IF NOT EXISTS debot_notification_versions (
        key TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,event_id TEXT NOT NULL,vendor_event_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,observed_at TEXT NOT NULL,last_observed_at TEXT NOT NULL,kind TEXT NOT NULL,
        notification_count INTEGER NOT NULL,delivery_count INTEGER NOT NULL,delta TEXT NOT NULL,
        classification TEXT,reasons TEXT NOT NULL,evidence TEXT);
      CREATE INDEX IF NOT EXISTS debot_notification_versions_history ON debot_notification_versions(chain,address,observed_at DESC,key DESC);
      CREATE INDEX IF NOT EXISTS debot_notification_versions_seen ON debot_notification_versions(observed_at);
      CREATE INDEX IF NOT EXISTS debot_notification_versions_prune ON debot_notification_versions(observed_at,key);
      CREATE TABLE IF NOT EXISTS debot_notification_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.migrate();this.prune(true);
  }

  record(observation:DebotSignalObservation):DebotNotificationResult {
    this.db.exec('SAVEPOINT debot_notification_record');
    try {
      const result=this.write(observation);
      // At the hard cap, remove only the exact overflow through the oldest-row
      // index. Running all three retention sweeps for every incoming card made
      // the live signal callback pause for hundreds of milliseconds.
      if(this.retainedVersions>MAX_VERSIONS)this.trimVersions(this.retainedVersions-MAX_VERSIONS);
      this.prune();this.db.exec('RELEASE debot_notification_record');return result;
    }
    catch(error){
      // SQLITE_FULL can roll back the outer inbox transaction as well as this savepoint.
      try{this.db.exec('ROLLBACK TO debot_notification_record; RELEASE debot_notification_record');}catch{/* Already rolled back. */}
      this.retainedVersions=-1;this.nextPruneAt=0;
      throw error;
    }
  }

  current(chain:Chain,ca:string) {
    const token=identity(chain,ca),row=this.group(token.chain,token.address);if(!row)return;
    const retained=Number(this.db.prepare('SELECT count(*) AS n FROM debot_notification_versions WHERE chain=? AND address=?').get(chain,token.address)!.n);
    return {key:row.latest_key,kind:row.last_change_kind,chain,address:token.address,firstSeenAt:row.first_seen_at,lastSeenAt:row.last_seen_at,
      notificationCount:Number(row.notification_count),deliveryCount:Number(row.delivery_count),lastChangeAt:row.last_change_at,
      lastChange:{kind:row.last_change_kind,reasons:JSON.parse(row.reasons) as string[],delta:JSON.parse(row.delta) as DebotNotificationDelta},
      retainedHistory:retained,truncatedHistory:Math.max(0,Number(row.version_count)-retained),retentionDays:RETENTION_DAYS};
  }

  mark(key:string,value:{classification:string;reasons:string[];evidence?:unknown}):void {
    if(!/^[a-f0-9]{64}$/.test(key)||!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(value.classification))throw new Error('DEBOT_NOTIFICATION_MARK_INVALID');
    const evidence=safeEvidence(value.evidence);
    this.db.prepare('UPDATE debot_notification_versions SET classification=?,reasons=?,evidence=? WHERE key=?')
      .run(value.classification,JSON.stringify(codes(value.reasons)),evidence?JSON.stringify(evidence):null,key);
  }

  history(chain:Chain,ca:string,options:{limit?:number;offset?:number;asOf?:string}={}) {
    const token=identity(chain,ca),limit=options.limit??20,offset=options.offset??0,asOf=options.asOf??this.now().toISOString();
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1_000_000||iso(asOf)!==asOf)
      throw new Error('INVALID_FILTER');
    const total=Number(this.db.prepare('SELECT count(*) AS n FROM debot_notification_versions WHERE chain=? AND address=? AND observed_at<=?').get(chain,token.address,asOf)!.n);
    const rows=this.db.prepare('SELECT * FROM debot_notification_versions WHERE chain=? AND address=? AND observed_at<=? ORDER BY observed_at DESC,key DESC LIMIT ? OFFSET ?')
      .all(chain,token.address,asOf,limit,offset) as unknown as VersionRow[];
    const group=this.current(chain,token.address);
    return {asOf,total,limit,offset,hasMore:offset+rows.length<total,retainedHistory:group?.retainedHistory??0,truncatedHistory:group?.truncatedHistory??0,
      retentionDays:RETENTION_DAYS,items:rows.map(row=>({key:row.key,eventId:row.event_id,vendorEventId:row.vendor_event_id,
        occurredAt:row.occurred_at,observedAt:row.observed_at,lastObservedAt:row.last_observed_at,kind:row.kind,
        notificationCount:Number(row.notification_count),deliveryCount:Number(row.delivery_count),delta:JSON.parse(row.delta) as DebotNotificationDelta,
        classification:row.classification??undefined,reasons:JSON.parse(row.reasons) as string[],evidence:row.evidence?JSON.parse(row.evidence):undefined}))};
  }

  private group(chain:Chain,ca:string):GroupRow|undefined {
    return this.db.prepare('SELECT * FROM debot_notification_groups WHERE chain=? AND address=?').get(chain,ca) as unknown as GroupRow|undefined;
  }
  private write(observation:DebotSignalObservation):DebotNotificationResult {
    const token=identity(observation.signal.token.chain,observation.signal.token.address),observedAt=iso(observation.observedAt);
    const eventId=observation.signal.sourceEventId;
    if(!observedAt)throw new Error('DEBOT_NOTIFICATION_TIME_INVALID');
    if(typeof eventId!=='string'||!/^[a-zA-Z0-9:_-]{1,200}$/.test(eventId)||typeof observation.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(observation.id))
      throw new Error('DEBOT_NOTIFICATION_EVENT_INVALID');
    const next=snapshot(observation),key=hash([token.chain,token.address,eventId,next]),group=this.group(token.chain,token.address);
    const priorVersion=this.db.prepare('SELECT key FROM debot_notification_versions WHERE key=?').get(key);
    const firstSeenAt=group?.first_seen_at??observedAt,lastSeenAt=group&&group.last_seen_at>observedAt?group.last_seen_at:observedAt;
    const deliveryCount=Number(group?.delivery_count??0)+1;
    if(priorVersion&&group) {
      this.db.prepare('UPDATE debot_notification_versions SET delivery_count=delivery_count+1,last_observed_at=MAX(last_observed_at,?) WHERE key=?').run(observedAt,key);
      this.db.prepare('UPDATE debot_notification_groups SET delivery_count=?,last_seen_at=? WHERE chain=? AND address=?')
        .run(deliveryCount,lastSeenAt,token.chain,token.address);
      return {key,kind:'replay',firstSeenAt,lastSeenAt,notificationCount:Number(group.notification_count),deliveryCount,newEvent:false};
    }
    const event=this.db.prepare('SELECT occurred_at FROM debot_notification_events WHERE chain=? AND address=? AND event_id=?')
      .get(token.chain,token.address,eventId) as {occurred_at:string}|undefined;
    const notificationCount=Number(group?.notification_count??0)+(event?0:1),occurredAt=event?.occurred_at??next.occurredAt;
    this.db.prepare('INSERT OR IGNORE INTO debot_notification_events(chain,address,event_id,vendor_event_id,occurred_at,observed_at) VALUES(?,?,?,?,?,?)')
      .run(token.chain,token.address,eventId,observation.id,occurredAt,observedAt);
    const change=difference(group?JSON.parse(group.snapshot) as Snapshot:undefined,next);
    if(occurredAt!==next.occurredAt){change.delta.eventTimeConflict=true;change.reasons.push('DEBOT_EVENT_TIME_CONFLICT');}
    this.db.prepare(`INSERT INTO debot_notification_versions(key,chain,address,event_id,vendor_event_id,occurred_at,observed_at,last_observed_at,
      kind,notification_count,delivery_count,delta,reasons) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(key,token.chain,token.address,eventId,observation.id,occurredAt,observedAt,observedAt,change.kind,notificationCount,1,JSON.stringify(change.delta),JSON.stringify(change.reasons));
    if(this.retainedVersions>=0)this.retainedVersions++;
    this.db.prepare(`INSERT INTO debot_notification_groups(chain,address,first_seen_at,last_seen_at,notification_count,delivery_count,version_count,
      latest_key,last_change_at,last_change_kind,snapshot,delta,reasons) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(chain,address) DO UPDATE SET last_seen_at=excluded.last_seen_at,notification_count=excluded.notification_count,
        delivery_count=excluded.delivery_count,version_count=excluded.version_count,latest_key=excluded.latest_key,last_change_at=excluded.last_change_at,
        last_change_kind=excluded.last_change_kind,snapshot=excluded.snapshot,delta=excluded.delta,reasons=excluded.reasons`)
      .run(token.chain,token.address,firstSeenAt,lastSeenAt,notificationCount,deliveryCount,Number(group?.version_count??0)+1,
        key,observedAt,change.kind,JSON.stringify(next),JSON.stringify(change.delta),JSON.stringify(change.reasons));
    return {key,kind:change.kind,firstSeenAt,lastSeenAt,notificationCount,deliveryCount,newEvent:!event};
  }
  private prune(force=false):void {
    const now=this.now().getTime();
    if(!Number.isFinite(now))throw new Error('DEBOT_NOTIFICATION_TIME_INVALID');
    // Retention cannot change between notifications within the same minute.
    // Capacity remains strict: the in-memory exact version count forces an
    // immediate sweep on the first row beyond MAX_VERSIONS.
    if(!force&&now<this.nextPruneAt)return;
    const cutoff=new Date(now-RETENTION_DAYS*86400_000).toISOString();
    this.db.prepare('DELETE FROM debot_notification_versions WHERE observed_at<?').run(cutoff);
    this.retainedVersions=Number(this.db.prepare('SELECT count(*) AS n FROM debot_notification_versions').get()!.n);
    if(this.retainedVersions>MAX_VERSIONS)this.trimVersions(this.retainedVersions-MAX_VERSIONS);
    // Identity tombstones survive version pruning while they remain inside the
    // bounded deduplication horizon. Aggregates preserve the number omitted.
    this.db.prepare('DELETE FROM debot_notification_events WHERE observed_at<?').run(cutoff);
    const events=Number(this.db.prepare('SELECT count(*) AS n FROM debot_notification_events').get()!.n);
    if(events>MAX_VERSIONS)this.db.prepare(`DELETE FROM debot_notification_events WHERE rowid IN
      (SELECT rowid FROM debot_notification_events INDEXED BY debot_notification_events_seen ORDER BY observed_at,rowid LIMIT ?)`).run(events-MAX_VERSIONS);
    this.db.prepare('DELETE FROM debot_notification_groups WHERE last_seen_at<?').run(cutoff);
    const groups=Number(this.db.prepare('SELECT count(*) AS n FROM debot_notification_groups').get()!.n);
    if(groups>MAX_VERSIONS)this.db.prepare(`DELETE FROM debot_notification_groups WHERE rowid IN
      (SELECT rowid FROM debot_notification_groups INDEXED BY debot_notification_groups_seen ORDER BY last_seen_at,rowid LIMIT ?)`).run(groups-MAX_VERSIONS);
    this.nextPruneAt=now+60_000;
  }
  private trimVersions(limit:number):void {
    if(!Number.isSafeInteger(limit)||limit<=0)return;
    const removed=this.db.prepare(`DELETE FROM debot_notification_versions WHERE key IN
      (SELECT key FROM debot_notification_versions INDEXED BY debot_notification_versions_prune ORDER BY observed_at,key LIMIT ?)`).run(limit);
    if(this.retainedVersions>=0)this.retainedVersions=Math.max(0,this.retainedVersions-Number(removed.changes));
  }
  private migrate():void {
    if(this.db.prepare("SELECT 1 FROM debot_notification_meta WHERE key='inbox_migration_v1'").get())return;
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='debot_signals'").get())return;
    this.db.exec('SAVEPOINT debot_notification_migrate');
    try {
      // Existing inbox is already bounded. Read its persisted first receipt and
      // event time; never replace either with the service restart timestamp.
      const columns=new Set(this.db.prepare('PRAGMA table_info(debot_signals)').all().map(row=>String(row.name)));
      const associated=columns.has('notification_key')?' AND notification_key IS NULL':'';
      const rows=this.db.prepare(`SELECT id,chain,address,occurred_at,observed_at,payload FROM debot_signals
        WHERE id NOT LIKE 'debot:revision:%'${associated} ORDER BY observed_at,id LIMIT 10000`).all();
      let migrated=0;
      for(const row of rows) {
        let observation:DebotSignalObservation;
        try {
          observation=JSON.parse(String(row.payload)) as DebotSignalObservation;
          if(!recordObject(observation)||!recordObject(observation.signal)||!recordObject(observation.signal.token)||
            observation.signal.sourceEventId!==row.id||observation.signal.token.chain!==row.chain||
            address(observation.signal.token.address,row.chain as Chain)!==address(row.address,row.chain as Chain))continue;
          // Validate before writing; malformed historical records cannot undo a migration.
          identity(row.chain as Chain,String(row.address));snapshot(observation);
          if(!iso(row.observed_at)||!iso(row.occurred_at)||!/^[a-zA-Z0-9:_-]{1,200}$/.test(observation.signal.sourceEventId)||
            typeof observation.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(observation.id))continue;
        }catch {continue;}
        this.write({...observation,observedAt:String(row.observed_at),signal:{...observation.signal,occurredAt:String(row.occurred_at)}});migrated++;
      }
      this.db.prepare("INSERT INTO debot_notification_meta(key,value) VALUES('inbox_migration_v1',?)").run(String(migrated));
      this.db.exec('RELEASE debot_notification_migrate');
    }catch(error){this.db.exec('ROLLBACK TO debot_notification_migrate; RELEASE debot_notification_migrate');throw error;}
  }
}
