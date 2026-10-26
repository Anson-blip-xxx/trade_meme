import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {chainAddress} from './chain-stream-store.js';
import type {WalletActivity,ActivityKind} from './wallet-activity.js';
const kinds:ActivityKind[]=['buy','sell','received_purchase','distribution','transfer','self_transfer','approval','liquidity','wrap','failed','retracted','no_change','unknown'];
/** Classification evidence stays separate from buy metrics and vendor profit claims. */
export class WalletActivityStore {
  private db:DatabaseSync;private error?:string;private readonly counts:Partial<Record<ActivityKind,number>>={};
  constructor(private path:string,private maxBytes=128*1024*1024){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS wallet_activity(id TEXT PRIMARY KEY,chain TEXT,wallet TEXT,tx_hash TEXT,kind TEXT,checked_at TEXT,data TEXT);
      CREATE INDEX IF NOT EXISTS wallet_activity_recent ON wallet_activity(checked_at DESC);
      CREATE INDEX IF NOT EXISTS wallet_activity_kind ON wallet_activity(kind);
      CREATE TABLE IF NOT EXISTS wallet_activity_meta(key TEXT PRIMARY KEY,value TEXT);`);
    this.error=this.db.prepare("SELECT value FROM wallet_activity_meta WHERE key='error'").get()?.value as string|undefined;
    for(const row of this.db.prepare('SELECT kind,count(*) AS n FROM wallet_activity GROUP BY kind').all())
      if(kinds.includes(row.kind as ActivityKind))this.counts[row.kind as ActivityKind]=Number(row.n);
  }
  record(input:WalletActivity):boolean {
    const wallet=chainAddress(input.chain,input.wallet);if(!wallet||!kinds.includes(input.classification)||input.version!==1)return false;
    try{if(input.chain==='solana'?bs58.decode(input.txHash).length!==64:!/^0x[0-9a-f]{64}$/.test(input.txHash))return false;}catch{return false;}
    if(![input.receivedAt,input.checkedAt,...(input.eventAt?[input.eventAt]:[])].every(t=>typeof t==='string'&&Number.isFinite(Date.parse(t))))return false;
    if(!Array.isArray(input.reasons)||!Array.isArray(input.trades))return false;
    const data:WalletActivity={version:1,chain:input.chain,wallet,txHash:input.txHash,receivedAt:input.receivedAt,checkedAt:input.checkedAt,
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
      ...(input.eventAt?{eventAt:input.eventAt}:{}),...(input.blockHash&&/^0x[0-9a-f]{64}$/i.test(input.blockHash)?{blockHash:input.blockHash}:{}),
      ...(Number.isSafeInteger(input.slot)&&input.slot!>=0?{slot:input.slot}:{})};
    const id=createHash('sha256').update(JSON.stringify([data.chain,wallet,data.txHash])).digest('hex');
    const old=this.db.prepare('SELECT kind FROM wallet_activity WHERE id=?').get(id);
    if(old?.kind==='retracted')return false;
    if(!old&&this.bytes()+16384+JSON.stringify(data).length*3>this.maxBytes){this.error='WALLET_ACTIVITY_CAPACITY_REACHED';
      this.db.prepare("INSERT INTO wallet_activity_meta VALUES ('error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.error);return false;}
    this.db.prepare('INSERT INTO wallet_activity VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,checked_at=excluded.checked_at,data=excluded.data')
      .run(id,data.chain,wallet,data.txHash,data.classification,data.checkedAt,JSON.stringify(data));
    const oldKind=old?.kind as ActivityKind|undefined;
    if(oldKind!==data.classification){
      if(oldKind&&this.counts[oldKind]!==undefined){const next=this.counts[oldKind]!-1;if(next>0)this.counts[oldKind]=next;else delete this.counts[oldKind];}
      this.counts[data.classification]=(this.counts[data.classification]??0)+1;
    }
    return true;
  }
  private bytes(){return this.path===':memory:'?Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size):
    [this.path,this.path+'-wal',this.path+'-shm'].reduce((n,p)=>{try{return n+statSync(p).size;}catch{return n;}},0);}
  status(){return {persisted:true,counts:{...this.counts},
    recent:this.db.prepare('SELECT data FROM wallet_activity ORDER BY checked_at DESC LIMIT 20').all().map(r=>JSON.parse(String(r.data)) as WalletActivity),
    error:this.error,maxBytes:this.maxBytes,bytes:this.bytes(),scope:'transaction_classification_not_profit_or_ownership'};}
  close(){this.db.close();}
}
