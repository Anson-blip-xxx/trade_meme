import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {chmodSync,mkdirSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import bs58 from 'bs58';
import {chainAddress} from './chain-stream-store.js';
import type {Chain} from './types.js';
import type {WalletTradeObservation} from './wallet-history.js';
import type {WalletScreeningReport,WalletSetup} from './wallet-screening.js';

export type WalletSetupLedgerState='awaiting_leader'|'direct_entry'|'leader_entered'|'reduced'|'expired_unconfirmed';
export interface WalletSetupLedgerProof {
  checkedAt:string;validUntil:string;status:'supported'|'watch';stage:string;priorityScore:number;
  trigger:WalletTradeObservation;profileComputedAt?:string;relationKnownAt?:string;
  reasons:string[];counterEvidence:string[];profit?:WalletSetup['profit'];chasePct?:number;followers:number;
}
export interface WalletSetupLedgerItem {
  id:string;chain:Chain;address:string;route:'precursor'|'public_entry';wallet:string;leader:string;
  registeredAt:string;expiresAt:string;lastCheckedAt:string;closedAt?:string;state:WalletSetupLedgerState;
  review:{status:'active'|'withdrawn';checkedAt:string;reasons:string[]};proof:WalletSetupLedgerProof;
  leaderEntry?:WalletTradeObservation;reduction?:WalletTradeObservation;
  conflicts:number;triggerConflicted?:boolean;observationsTruncated:boolean;sampleOnly:true;ownership:'unknown';
}
export interface WalletSetupLedgerStatus {
  records:number;pending:number;stateCounts:Partial<Record<WalletSetupLedgerState,number>>;withdrawn:number;
  bytes:number;maxBytes:number;capacityReached:boolean;sampleOnly:true;
}
export interface WalletSetupLedgerOptions {now?:()=>Date;maxBytes?:number;windowSec?:number;synchronous?:'full'|'normal';}
type Token={chain:Chain;address:string};
type StoredEvidence={key:string;event:WalletTradeObservation;conflict:boolean};
const EVENT_LIMIT=16,RECORD_BUDGET=32768,BASE_BUDGET=32768;
const OBSERVATION_WRITE_BATCH=4;
const stamp=(value:unknown):string|undefined=>{
  if(typeof value!=='string'||value.length>32||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))return;
  const normalized=new Date(value).toISOString();return normalized.slice(0,19)===value.slice(0,19)?normalized:undefined;
};
const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string').slice(0,6).map(v=>v.slice(0,160)):[];
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const validToken=(value:Token):Token|undefined=>{
  if(!value||!['bsc','solana','robinhood'].includes(value.chain))return;
  const address=chainAddress(value.chain,value.address);return address?{chain:value.chain,address}:undefined;
};
const txHash=(chain:Chain,value:unknown):string|undefined=>{
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[\da-f]{64}$/i.test(value)?value.toLowerCase():undefined;
  try{return value.length>=64&&value.length<=88&&bs58.decode(value).length===64?value:undefined;}catch{return;}
};
function trade(input:WalletTradeObservation,token:Token,now:string):WalletTradeObservation|undefined {
  if(!input||input.chain!==token.chain||chainAddress(token.chain,input.tokenAddress)!==token.address)return;
  const wallet=chainAddress(token.chain,input.wallet),hash=txHash(token.chain,input.txHash),eventAt=stamp(input.eventAt),observedAt=stamp(input.observedAt);
  if(!wallet||!hash||!eventAt||!observedAt||eventAt>now||observedAt>now||eventAt>observedAt||
    !['buy','sell','transferIn','transferOut','add','remove'].includes(input.side)||typeof input.source!=='string'||!/^[a-z][a-z0-9_.:-]{0,79}$/.test(input.source)||
    input.eventIndex!==undefined&&(!Number.isSafeInteger(input.eventIndex)||input.eventIndex<0))return;
  const result:WalletTradeObservation={chain:token.chain,wallet,tokenAddress:token.address,txHash:hash,side:input.side,eventAt,observedAt,source:input.source};
  if(input.eventIndex!==undefined)result.eventIndex=input.eventIndex;
  for(const key of ['amount','usd','priceUsd'] as const)if(typeof input[key]==='string'&&/^-?\d{1,80}(?:\.\d{1,40})?$/.test(input[key]))result[key]=input[key];
  if(['human','atomic','unknown','vendor_quantity'].includes(input.amountUnit??''))result.amountUnit=input.amountUnit;
  return result;
}
const eventKey=(event:WalletTradeObservation)=>`${event.wallet}:${event.txHash}`;
const conflicts=(a:WalletTradeObservation,b:WalletTradeObservation)=>['side','eventAt','eventIndex','amountUnit','amount','usd','priceUsd'].some(key=>{
  const first=a[key as keyof WalletTradeObservation],second=b[key as keyof WalletTradeObservation];
  return first!==undefined&&first!==null&&second!==undefined&&second!==null&&first!==second;
});
function mergeObservation(a:WalletTradeObservation,b:WalletTradeObservation):WalletTradeObservation {
  const merged={...a,observedAt:a.observedAt<b.observedAt?a.observedAt:b.observedAt};
  for(const key of ['eventIndex','amountUnit','amount','usd','priceUsd'] as const)if(merged[key]===undefined&&b[key]!==undefined)Object.assign(merged,{[key]:b[key]});
  return merged;
}
const identity=(token:Token,setup:Pick<WalletSetup,'route'|'wallet'|'leader'>,trigger:WalletTradeObservation)=>
  createHash('sha256').update(JSON.stringify([token.chain,token.address,setup.route,setup.wallet,setup.leader,trigger.txHash])).digest('hex');
function deepFreeze<T>(value:T):Readonly<T> {if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;}

/** Forward research opportunities. Frozen registration evidence never becomes a retrospective prediction. */
export class WalletSetupLedger {
  private readonly db:DatabaseSync;private readonly now:()=>Date;private readonly maxBytes:number;private readonly windowMs:number;
  constructor(private readonly database:string,options:WalletSetupLedgerOptions={}) {
    this.now=options.now??(()=>new Date());this.maxBytes=options.maxBytes??64*1024*1024;this.windowMs=(options.windowSec??86400)*1000;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<65536||!Number.isSafeInteger(this.windowMs)||this.windowMs<1000||this.windowMs>30*86400000)throw new Error('WALLET_SETUP_LEDGER_CONFIG_INVALID');
    if(database!==':memory:')mkdirSync(dirname(database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(database);if(database!==':memory:')chmodSync(database,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA wal_autocheckpoint=16;
      CREATE TABLE IF NOT EXISTS wsl_setups(id TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,
        registered_at TEXT NOT NULL,expires_at TEXT NOT NULL,last_checked_at TEXT NOT NULL,state TEXT NOT NULL,
        closed_at TEXT,review_withdrawn INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,evidence TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS wsl_due ON wsl_setups(closed_at,last_checked_at,registered_at,id);
      CREATE INDEX IF NOT EXISTS wsl_token ON wsl_setups(chain,address,registered_at DESC);
      CREATE INDEX IF NOT EXISTS wsl_page ON wsl_setups(registered_at DESC,id);
      CREATE INDEX IF NOT EXISTS wsl_chain_page ON wsl_setups(chain,registered_at DESC,id);
      CREATE INDEX IF NOT EXISTS wsl_token_page ON wsl_setups(chain,address,registered_at DESC,id);
      CREATE INDEX IF NOT EXISTS wsl_status_counts ON wsl_setups(closed_at,review_withdrawn);
      CREATE INDEX IF NOT EXISTS wsl_status_state ON wsl_setups(state);
      CREATE TABLE IF NOT EXISTS wsl_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.exec(`PRAGMA synchronous=${options.synchronous==='normal'?'NORMAL':'FULL'}`);
    if(!this.db.prepare('PRAGMA table_info(wsl_setups)').all().some(row=>row.name==='check_seq'))this.db.exec('ALTER TABLE wsl_setups ADD COLUMN check_seq INTEGER NOT NULL DEFAULT 0');
    const pageSize=Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    this.db.exec(`PRAGMA max_page_count=${Math.floor(this.maxBytes/pageSize)}`);
  }
  private time(input?:Date|string):string|undefined {
    const actual=this.now();if(!Number.isFinite(actual.getTime()))return;
    if(input===undefined)return actual.toISOString();
    const value=typeof input==='string'?stamp(input):Number.isFinite(input.getTime())?input.toISOString():undefined;
    return value&&value<=actual.toISOString()?value:undefined;
  }
  private full():void {this.db.prepare("INSERT INTO wsl_meta VALUES ('capacity','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();}
  private bytes():number {
    const logical=Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    if(this.database===':memory:')return logical;
    return Math.max(logical,[this.database,this.database+'-wal',this.database+'-shm'].reduce((n,path)=>{try{return n+statSync(path).size;}catch{return n;}},0));
  }
  record(report:WalletScreeningReport):void {
    const now=this.time(),token=validToken(report?.token),checkedAt=stamp(report?.checkedAt),validUntil=stamp(report?.validUntil);
    if(!now||!token||!checkedAt||!validUntil||checkedAt>now||validUntil<=now||validUntil<checkedAt||report.version!==1||!Array.isArray(report.setups))return;
    for(const setup of report.setups.slice(0,8)){
      if(!setup||!['precursor','public_entry'].includes(setup.route)||!['supported','watch','withdrawn'].includes(setup.status))continue;
      const wallet=chainAddress(token.chain,setup.wallet),leader=chainAddress(token.chain,setup.leader),trigger=trade(setup.trigger,token,now);
      if(!wallet||!leader||!trigger||trigger.wallet!==wallet||trigger.side!=='buy'||trigger.observedAt>checkedAt||trigger.eventAt>checkedAt||
        setup.route==='precursor'&&wallet===leader||setup.route==='public_entry'&&wallet!==leader)continue;
      const id=identity(token,{...setup,wallet,leader},trigger),old=this.db.prepare('SELECT data FROM wsl_setups WHERE id=?').get(id);
      if(old){
        // Observation refreshes run on a worker connection.  Preserve any
        // outcome written between this read and the review update instead of
        // replacing it with a stale JSON copy.
        if(setup.status==='withdrawn')for(let attempt=0;attempt<3;attempt++){
          const current=this.db.prepare('SELECT data FROM wsl_setups WHERE id=?').get(id);if(!current)break;
          const item=JSON.parse(String(current.data)) as WalletSetupLedgerItem;if(checkedAt<item.review.checkedAt)break;
          item.review={status:'withdrawn',checkedAt,reasons:strings(setup.reasons)};
          const saved=this.db.prepare('UPDATE wsl_setups SET data=?,review_withdrawn=1 WHERE id=? AND data=?')
            .run(JSON.stringify(item),id,String(current.data));
          if(Number(saved.changes))break;
        }
        continue;
      }
      if(setup.status==='withdrawn'||!finite(setup.priorityScore)||setup.priorityScore<=0||typeof setup.stage!=='string'||setup.stage.length>100)continue;
      const profileComputedAt=setup.profileComputedAt===undefined?undefined:stamp(setup.profileComputedAt),relationKnownAt=setup.relationKnownAt===undefined?undefined:stamp(setup.relationKnownAt);
      if(setup.profileComputedAt!==undefined&&(!profileComputedAt||profileComputedAt>checkedAt)||setup.relationKnownAt!==undefined&&(!relationKnownAt||relationKnownAt>checkedAt))continue;
      const item:WalletSetupLedgerItem={id,...token,route:setup.route,wallet,leader,registeredAt:now,expiresAt:new Date(Date.parse(now)+this.windowMs).toISOString(),lastCheckedAt:now,
        state:setup.route==='precursor'?'awaiting_leader':'direct_entry',review:{status:'active',checkedAt,reasons:[]},
        proof:{checkedAt,validUntil,status:setup.status,stage:setup.stage,priorityScore:setup.priorityScore,trigger,reasons:strings(setup.reasons),counterEvidence:strings(setup.counterEvidence),followers:Number.isSafeInteger(setup.followers)&&setup.followers>=0?setup.followers:0,
          ...(profileComputedAt?{profileComputedAt}:{}),...(relationKnownAt?{relationKnownAt}:{})},conflicts:0,observationsTruncated:false,sampleOnly:true,ownership:'unknown'};
      if(finite(setup.chasePct))item.proof.chasePct=setup.chasePct;
      const profit=setup.profit,profitTime=stamp(profit?.observedAt);
      if(profit&&finite(profit.realizedProfitUsd)&&finite(profit.percentile)&&profit.percentile>=0&&profit.percentile<=100&&Number.isSafeInteger(profit.cohortSize)&&profit.cohortSize>=0&&profitTime&&profitTime<=checkedAt&&profit.verification==='vendor_claim')
        item.proof.profit={realizedProfitUsd:profit.realizedProfitUsd,percentile:profit.percentile,cohortSize:profit.cohortSize,observedAt:profitTime,verification:'vendor_claim'};
      const count=Number(this.db.prepare('SELECT count(*) AS n FROM wsl_setups').get()!.n);
      // Reserve the worst-case bounded evidence/review growth for every accepted row.
      // Reaching capacity stops new rows, never silently deletes earlier opportunities.
      if(BASE_BUDGET+(count+1)*RECORD_BUDGET>this.maxBytes||this.bytes()+RECORD_BUDGET>this.maxBytes){this.full();continue;}
      this.db.prepare('INSERT INTO wsl_setups(id,chain,address,registered_at,expires_at,last_checked_at,state,data) VALUES (?,?,?,?,?,?,?,?)')
        .run(id,token.chain,token.address,now,item.expiresAt,now,item.state,JSON.stringify(item));
      // A larger budget may restore admission after a previous capacity stop.
      // Clear the persisted warning only after a new opportunity was accepted.
      this.db.prepare("DELETE FROM wsl_meta WHERE key='capacity'").run();
    }
  }
  pending(limit=20):Token[] {
    const take=Number.isSafeInteger(limit)?Math.max(1,Math.min(100,limit)):20;
    // No expiry predicate: every elapsed window must be observed once to close it.
    return this.db.prepare(`SELECT chain,address FROM wsl_setups WHERE closed_at IS NULL GROUP BY chain,address
      ORDER BY min(check_seq),min(last_checked_at),min(registered_at),min(id) LIMIT ?`).all(take).map(row=>({chain:row.chain as Chain,address:String(row.address)}));
  }
  observe(input:Token,trades:readonly WalletTradeObservation[],at?:Date|string,options:{truncated?:boolean}={}):void {
    const now=this.time(at),token=validToken(input);if(!now||!token||!Array.isArray(trades))return;
    const events=trades.slice(0,1000).map(e=>trade(e,token,now)).filter((e):e is WalletTradeObservation=>!!e);
    const groups=new Map<string,StoredEvidence>();
    for(const event of events){
      const key=eventKey(event),old=groups.get(key);
      if(old){if(conflicts(old.event,event))old.conflict=true;old.event=mergeObservation(old.event,event);}
      else groups.set(key,{key,event,conflict:false});
    }
    const rows=this.db.prepare(`SELECT * FROM wsl_setups WHERE chain=? AND address=?
      ORDER BY closed_at IS NOT NULL,check_seq,registered_at,id LIMIT 100`).all(token.chain,token.address);
    const sequence=Number(this.db.prepare("SELECT value FROM wsl_meta WHERE key='check_seq'").get()?.value??0)+1;
    const updates:{now:string;state:WalletSetupLedgerState;closedAt:string|null;data:string;evidence:string;withdrawn:number;id:string;
      oldData:string;oldEvidence:string;oldCheckedAt:string;oldSequence:number}[]=[];
    for(const row of rows){
      const item=JSON.parse(String(row.data)) as WalletSetupLedgerItem;if(now<item.registeredAt||now<item.lastCheckedAt)continue;
      if(options.truncated||trades.length>1000)item.observationsTruncated=true;
      const evidence=JSON.parse(String(row.evidence)) as StoredEvidence[],byKey=new Map(evidence.map(e=>[e.key,e]));
      for(const incoming of groups.values()){
        const event=incoming.event;
        if(event.wallet===item.proof.trigger.wallet&&event.txHash===item.proof.trigger.txHash){
          if(incoming.conflict||conflicts(item.proof.trigger,event)){
            item.triggerConflicted=true;
            item.review={status:'withdrawn',checkedAt:now,reasons:[...new Set(['WALLET_TRIGGER_BUY_CONFLICT',...item.review.reasons])].slice(0,6)};
          }
          // The trigger predates registration. A contradictory copy is audit
          // evidence, never a newly successful forward entry.
          continue;
        }
        if(event.wallet!==item.wallet&&event.wallet!==item.leader||!['buy','sell','transferOut'].includes(event.side))continue;
        const key=eventKey(event),previous=byKey.get(key);
        if(previous){
          if(incoming.conflict||conflicts(previous.event,event))previous.conflict=true;
          previous.event=mergeObservation(previous.event,event);
          continue;
        }
        if(item.closedAt)continue;
        // Past events only matter when they contradict an already accepted transaction.
        if(event.eventAt<=item.registeredAt||event.eventAt>item.expiresAt||event.observedAt<=item.registeredAt)continue;
        if(evidence.length>=EVENT_LIMIT){
          item.observationsTruncated=true;
          // Retain a newly seen reduction even if earlier leader additions filled
          // the sample. Existing conflict tombstones are never discarded.
          const victim=event.side!=='buy'&&!incoming.conflict?evidence.findLastIndex(e=>!e.conflict&&e.event.side==='buy'&&e.event.txHash!==item.leaderEntry?.txHash):-1;
          if(victim<0)continue;
          byKey.delete(evidence[victim].key);evidence.splice(victim,1);
        }
        const added={key,event,conflict:incoming.conflict||event.txHash===item.proof.trigger.txHash&&conflicts(item.proof.trigger,event)};evidence.push(added);byKey.set(key,added);
      }
      item.conflicts=evidence.filter(e=>e.conflict).length+(item.triggerConflicted?1:0);
      const eligible=evidence.filter(e=>!e.conflict&&e.event.eventAt>item.registeredAt&&e.event.observedAt>item.registeredAt&&e.event.eventAt<=item.expiresAt)
        .map(e=>e.event).sort((a,b)=>a.eventAt.localeCompare(b.eventAt)||a.txHash.localeCompare(b.txHash));
      item.leaderEntry=!item.triggerConflicted&&item.route==='precursor'?eligible.find(e=>e.wallet===item.leader&&e.side==='buy'):undefined;
      item.reduction=eligible.find(e=>e.side==='sell'||e.side==='transferOut');
      const expired=now>=item.expiresAt;
      item.state=item.reduction?'reduced':item.leaderEntry?'leader_entered':item.route==='public_entry'?'direct_entry':expired?'expired_unconfirmed':'awaiting_leader';
      item.lastCheckedAt=now;if(expired&&!item.closedAt)item.closedAt=now;
      // A concurrent assessment may retract support while this worker is
      // computing the forward outcome.  Compare the source columns so a stale
      // observation can never restore the older review; the unchanged row is
      // naturally retried by the durable pending query on the next cycle.
      updates.push({now,state:item.state,closedAt:item.closedAt??null,data:JSON.stringify(item),evidence:JSON.stringify(evidence),
        withdrawn:item.review.status==='withdrawn'?1:0,id:item.id,oldData:String(row.data),oldEvidence:String(row.evidence),
        oldCheckedAt:String(row.last_checked_at),oldSequence:Number(row.check_seq)});
    }
    const save=this.db.prepare(`UPDATE wsl_setups SET last_checked_at=?,state=?,closed_at=?,data=?,evidence=?,check_seq=?,review_withdrawn=?
      WHERE id=? AND data=? AND evidence=? AND last_checked_at=? AND check_seq=?`),
      saveSequence=this.db.prepare("INSERT INTO wsl_meta VALUES ('check_seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    for(let offset=0;offset<updates.length;offset+=OBSERVATION_WRITE_BATCH){
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if(offset===0)saveSequence.run(String(sequence));
        for(const update of updates.slice(offset,offset+OBSERVATION_WRITE_BATCH))save.run(update.now,update.state,update.closedAt,update.data,update.evidence,
          sequence,update.withdrawn,update.id,update.oldData,update.oldEvidence,update.oldCheckedAt,update.oldSequence);
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
  }
  list(options:{chain?:Chain;address?:string;limit?:number;offset?:number}={}):{
    items:Readonly<WalletSetupLedgerItem>[];sampleOnly:true;total:number;limit:number;offset:number;hasMore:boolean;
  } {
    const limit=Number.isSafeInteger(options.limit)?Math.max(1,Math.min(100,options.limit!)):20;
    const offset=Number.isSafeInteger(options.offset)?Math.max(0,Math.min(1000000,options.offset!)):0;
    const empty={items:[] as Readonly<WalletSetupLedgerItem>[],sampleOnly:true as const,total:0,limit,offset,hasMore:false};
    const filters:string[]=[],params:(string|number)[]=[];
    if(options.chain!==undefined){if(!['bsc','solana','robinhood'].includes(options.chain))return empty;filters.push('chain=?');params.push(options.chain);}
    if(options.address!==undefined){
      const address=options.chain?chainAddress(options.chain,options.address):/^0x[\da-f]{40}$/i.test(options.address)?options.address.toLowerCase():chainAddress('solana',options.address);
      if(!address)return empty;filters.push('address=?');params.push(address);
    }
    const where=filters.length?'WHERE '+filters.join(' AND '):'';
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM wsl_setups ${where}`).get(...params)!.n);
    const rows=this.db.prepare(`SELECT data FROM wsl_setups ${where} ORDER BY registered_at DESC,id LIMIT ? OFFSET ?`).all(...params,limit,offset);
    return {items:rows.map(row=>deepFreeze(JSON.parse(String(row.data)) as WalletSetupLedgerItem)),sampleOnly:true,total,limit,offset,hasMore:offset+rows.length<total};
  }
  status():WalletSetupLedgerStatus {
    const totals=this.db.prepare('SELECT count(*) AS records,sum(closed_at IS NULL) AS pending,sum(review_withdrawn) AS withdrawn FROM wsl_setups').get()!;
    const stateCounts:WalletSetupLedgerStatus['stateCounts']={};
    for(const row of this.db.prepare('SELECT state,count(*) AS n FROM wsl_setups GROUP BY state').all())stateCounts[row.state as WalletSetupLedgerState]=Number(row.n);
    return {records:Number(totals.records),pending:Number(totals.pending??0),withdrawn:Number(totals.withdrawn??0),stateCounts,bytes:this.bytes(),maxBytes:this.maxBytes,
      capacityReached:this.db.prepare("SELECT value FROM wsl_meta WHERE key='capacity'").get()?.value==='1',sampleOnly:true};
  }
  close():void {this.db.close();}
}
