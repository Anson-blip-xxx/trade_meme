import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import type {Chain} from './types.js';

export const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function chainAddress(chain:Chain,v:unknown):string|undefined {
  if(typeof v!=='string')return;
  if(chain==='solana')try{return v.length>=32&&v.length<=44&&bs58.decode(v).length===32?v:undefined;}catch{return;}
  return (chain==='bsc'||chain==='robinhood')&&/^0x[\da-f]{40}$/i.test(v)?v.toLowerCase():undefined;
}
export const hexNumber=(v:unknown):number|undefined=>typeof v==='string'&&/^0x(?:0|[1-9a-f][\da-f]{0,13})$/i.test(v)&&Number.isSafeInteger(Number(v))?Number(v):undefined;
const natural=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[\da-f]{64}$/i.test(v);
const timestamp=(v:unknown):v is string=>typeof v==='string'&&v.length<=32&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,19)===v.slice(0,19);
function signature(v:unknown):v is string {try{return typeof v==='string'&&v.length>=64&&v.length<=88&&bs58.decode(v).length===64;}catch{return false;}}
export interface ChainEvent {
  id:string;chain:Chain;kind:'wallet_transaction'|'token_transfer'|'native_transfer';wallet:string;
  tokenAddress?:string;from?:string;to?:string;amountAtomic?:string;txHash:string;blockNumber?:number;slot?:number;
  blockHash?:string;eventIndex?:number;observedAt:string;eventAt?:string;source:'live'|'backfill';
  verification:'rpc_confirmed'|'rpc_observed';removed?:boolean;
}
export interface SolReplayProgress {until:string;latest:string;before:string;lastSlot:number;}
function solProgress(value:unknown):value is SolReplayProgress {
  return object(value)&&signature(value.until)&&signature(value.latest)&&signature(value.before)&&natural(value.lastSlot);
}
export function chainEventId(parts:unknown[]):string{return createHash('sha256').update(JSON.stringify(parts)).digest('hex');}
/** Keep only typed evidence fields; never persist an RPC envelope or arbitrary provider metadata. */
function validatedEvent(input:unknown):ChainEvent|undefined {
  if(!object(input)||!['bsc','solana','robinhood'].includes(input.chain))return;
  const e=input,chain=e.chain as Chain,wallet=chainAddress(chain,e.wallet);
  if(!wallet||typeof e.id!=='string'||!/^[a-f\d]{64}$/.test(e.id)||!timestamp(e.observedAt)||
    !['wallet_transaction','token_transfer','native_transfer'].includes(e.kind)||
    !['rpc_confirmed','rpc_observed'].includes(e.verification)||!['live','backfill'].includes(e.source)||
    (e.amountAtomic!==undefined&&(typeof e.amountAtomic!=='string'||!/^\d{1,100}$/.test(e.amountAtomic)))||
    (e.eventAt!==undefined&&!timestamp(e.eventAt))||(e.removed!==undefined&&typeof e.removed!=='boolean')||
    (e.eventIndex!==undefined&&!natural(e.eventIndex))||(e.blockHash!==undefined&&!hash(e.blockHash)))return;
  // These branches are explicit: EVM validity must never depend on the Solana ternary's precedence.
  if(chain==='solana') {if(!signature(e.txHash)||!natural(e.slot)||e.blockNumber!==undefined||e.blockHash!==undefined)return;}
  else if(!hash(e.txHash)||!natural(e.blockNumber)||e.slot!==undefined)return;
  const addresses:Partial<Pick<ChainEvent,'tokenAddress'|'from'|'to'>>={};
  for(const key of ['tokenAddress','from','to'] as const) {
    if(e[key]!==undefined) {const value=chainAddress(chain,e[key]);if(!value)return;addresses[key]=value;}
  }
  if(e.kind==='token_transfer'&&(!addresses.tokenAddress||!addresses.from||!addresses.to||e.amountAtomic===undefined||
    (chain!=='solana'&&(!e.blockHash||e.eventIndex===undefined))))return;
  if(e.kind==='native_transfer'&&(!addresses.from||!addresses.to||e.amountAtomic===undefined||e.tokenAddress!==undefined))return;
  if(e.kind!=='wallet_transaction'&&wallet!==addresses.from&&wallet!==addresses.to)return;
  return {id:e.id,chain,wallet,kind:e.kind,...addresses,txHash:chain==='solana'?e.txHash:e.txHash.toLowerCase(),
    ...(e.amountAtomic!==undefined?{amountAtomic:e.amountAtomic}:{}),
    ...(e.blockNumber!==undefined?{blockNumber:e.blockNumber}:{}),...(e.slot!==undefined?{slot:e.slot}:{}),
    ...(e.blockHash!==undefined?{blockHash:e.blockHash.toLowerCase()}:{}),...(e.eventIndex!==undefined?{eventIndex:e.eventIndex}:{}),
    observedAt:new Date(e.observedAt).toISOString(),...(e.eventAt!==undefined?{eventAt:new Date(e.eventAt).toISOString()}:{}),
    source:e.source,verification:e.verification,...(e.removed!==undefined?{removed:e.removed}:{})};
}
function cursorKey(key:unknown):boolean {
  if(typeof key!=='string'||key.length>100)return false;
  const [chain,wallet,...extra]=key.split(':');return extra.length===0&&typeof wallet==='string'&&chainAddress(chain as Chain,wallet)===wallet;
}
/** Durable observations and independent per-wallet cursors. Capacity stops collection; it never silently deletes evidence. */
export class ChainStreamStore {
  private db:DatabaseSync;private eventCount=0;
  constructor(private path:string,private maxBytes=256*1024*1024) {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw new Error('CHAIN_STORE_LIMIT_INVALID');
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=128;
      CREATE TABLE IF NOT EXISTS chain_events(id TEXT PRIMARY KEY,chain TEXT NOT NULL,wallet TEXT NOT NULL,observed_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chain_events_recent ON chain_events(observed_at DESC);
      CREATE INDEX IF NOT EXISTS chain_events_wallet ON chain_events(chain,wallet,observed_at);
      CREATE TABLE IF NOT EXISTS chain_cursors(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chain_sol_replays(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chain_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.eventCount=Number(this.db.prepare('SELECT count(*) AS n FROM chain_events').get()!.n);
  }
  record(input:ChainEvent):boolean {
    const event=validatedEvent(input);if(!event)return false;
    const previous=this.db.prepare('SELECT data FROM chain_events WHERE id=?').get(event.id);
    if(previous) {
      const old=JSON.parse(String(previous.data));
      // A removed notification is a tombstone. Backfill must never resurrect it.
      const sameIdentity=['chain','wallet','kind','txHash','blockHash','blockNumber','slot','eventIndex','tokenAddress','from','to','amountAtomic']
        .every(key=>old[key]===(event as unknown as Record<string,unknown>)[key]);
      if(sameIdentity&&event.removed&&!old.removed)this.db.prepare('UPDATE chain_events SET data=? WHERE id=?').run(JSON.stringify({...old,removed:true}),event.id);
      return false;
    }
    if(this.bytes()+JSON.stringify(event).length*3+16384>this.maxBytes){this.markIncomplete('CHAIN_STORE_CAPACITY');throw new Error('CHAIN_STORE_CAPACITY');}
    this.db.prepare('INSERT INTO chain_events VALUES (?,?,?,?,?)').run(event.id,event.chain,event.wallet,event.observedAt,JSON.stringify(event));this.eventCount++;return true;
  }
  cursor(key:string):string|undefined {if(!cursorKey(key))throw new Error('CHAIN_CURSOR_INVALID');return this.db.prepare('SELECT value FROM chain_cursors WHERE key=?').get(key)?.value as string|undefined;}
  checkpoint(key:string,value:string):void {
    if(!cursorKey(key)||typeof value!=='string'||(key.startsWith('solana:')?!signature(value):!/^(?:0|[1-9]\d{0,15})$/.test(value)||!natural(Number(value))))throw new Error('CHAIN_CURSOR_INVALID');
    if(this.cursor(key)===value)return;
    if(this.bytes()+16384>this.maxBytes){this.markIncomplete('CHAIN_STORE_CAPACITY');throw new Error('CHAIN_STORE_CAPACITY');}
    this.db.prepare('INSERT OR REPLACE INTO chain_cursors VALUES (?,?)').run(key,value);
  }
  replayProgress(key:string):SolReplayProgress|undefined {
    if(!cursorKey(key)||!key.startsWith('solana:'))throw new Error('CHAIN_CURSOR_INVALID');
    const row=this.db.prepare('SELECT data FROM chain_sol_replays WHERE key=?').get(key);if(!row)return;
    const data=JSON.parse(String(row.data));if(!solProgress(data))throw new Error('CHAIN_CURSOR_INVALID');return data;
  }
  saveReplayProgress(key:string,value:SolReplayProgress):void {
    if(!cursorKey(key)||!key.startsWith('solana:')||!solProgress(value)||value.until!==this.cursor(key))throw new Error('CHAIN_CURSOR_INVALID');
    if(this.bytes()+16384>this.maxBytes){this.markIncomplete('CHAIN_STORE_CAPACITY');throw new Error('CHAIN_STORE_CAPACITY');}
    const {until,latest,before,lastSlot}=value;
    this.db.prepare('INSERT OR REPLACE INTO chain_sol_replays VALUES (?,?)').run(key,JSON.stringify({until,latest,before,lastSlot}));
  }
  clearReplayProgress(key:string):void {
    if(!cursorKey(key)||!key.startsWith('solana:'))throw new Error('CHAIN_CURSOR_INVALID');
    this.db.prepare('DELETE FROM chain_sol_replays WHERE key=?').run(key);
  }
  markIncomplete(code:string):void {
    if(typeof code!=='string'||!/^CHAIN_[A-Z_]{1,70}$/.test(code))throw new Error('CHAIN_STORE_REASON_INVALID');
    this.db.prepare('INSERT OR REPLACE INTO chain_meta VALUES (?,?)').run('incomplete',code);
  }
  recent(limit=30):ChainEvent[]{
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('CHAIN_STORE_QUERY_INVALID');
    return this.db.prepare('SELECT data FROM chain_events ORDER BY observed_at DESC,id LIMIT ?').all(limit).map(r=>JSON.parse(String(r.data)));
  }
  stats(){return {events:this.eventCount,bytes:this.bytes(),maxBytes:this.maxBytes,
    incomplete:!!this.db.prepare("SELECT value FROM chain_meta WHERE key='incomplete'").get()};}
  close(){this.db.close();}
  private bytes(){return this.path===':memory:'?Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size):
    [this.path,this.path+'-wal',this.path+'-shm'].reduce((n,p)=>{try{return n+statSync(p).size;}catch{return n;}},0);}
}
export const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export function evmTransfers(chain:'bsc'|'robinhood',log:unknown,wallets:ReadonlySet<string>,source:'live'|'backfill',now=new Date()):ChainEvent[] {
  if(!['bsc','robinhood'].includes(chain)||!['live','backfill'].includes(source)||!Number.isFinite(now.getTime())||
    !object(log)||!Array.isArray(log.topics)||log.topics.length!==3||typeof log.topics[0]!=='string'||log.topics[0].toLowerCase()!==TRANSFER_TOPIC||
    !log.topics.slice(1).every((t:unknown)=>typeof t==='string'&&/^0x0{24}[\da-f]{40}$/i.test(t))||
    typeof log.data!=='string'||!/^0x[\da-f]{64}$/i.test(log.data)||!hash(log.transactionHash)||
    !hash(log.blockHash)||!chainAddress(chain,log.address)||(log.removed!==undefined&&typeof log.removed!=='boolean'))return [];
  const blockNumber=hexNumber(log.blockNumber),eventIndex=hexNumber(log.logIndex);if(blockNumber===undefined||eventIndex===undefined)return [];
  const from='0x'+log.topics[1].slice(-40).toLowerCase(),to='0x'+log.topics[2].slice(-40).toLowerCase();
  return [...new Set([from,to])].filter(w=>wallets.has(w)).map(wallet=>({chain,wallet,kind:'token_transfer',
    id:chainEventId([chain,log.blockHash.toLowerCase(),log.transactionHash.toLowerCase(),eventIndex,wallet]),
    txHash:log.transactionHash.toLowerCase(),blockHash:log.blockHash.toLowerCase(),blockNumber,eventIndex,
    from,to,tokenAddress:log.address.toLowerCase(),amountAtomic:BigInt(log.data).toString(),observedAt:now.toISOString(),
    source,verification:'rpc_observed',removed:log.removed===true}));
}
/** Logs mentioning a wallet prove only participation, not a buy, sell, owner identity or token profit. */
export function solWalletEvent(wallet:string,signature:string,slot:number,source:'live'|'backfill',now=new Date()):ChainEvent {
  if(!Number.isFinite(now.getTime()))throw new Error('CHAIN_EVENT_INVALID');
  const event=validatedEvent({id:chainEventId(['solana',wallet,signature]),chain:'solana',kind:'wallet_transaction',wallet,txHash:signature,slot,
    observedAt:now.toISOString(),source,verification:'rpc_confirmed'});
  if(!event)throw new Error('CHAIN_EVENT_INVALID');return event;
}
