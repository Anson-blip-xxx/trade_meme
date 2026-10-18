import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {Chain} from './types.js';

const SOURCE={sourceId:'oooooyoung_evm',sourceUrl:'https://github.com/nopapername/oooooyoung/blob/2bae0bcfe62d4a32e11e5368fef37e5abf5d6f50/oooooyoung%20evm%E8%81%AA%E6%98%8E%E9%92%B1.json',
  commit:'2bae0bcfe62d4a32e11e5368fef37e5abf5d6f50',sha256:'ca163beacb5a4153821199ad7eb14e65b5c0adc1e2f60a9267effb94dc5d8b15'} as const;
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
const clean=(v:unknown,n=100)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,n):'';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const validAddress=(v:unknown):v is string=>typeof v==='string'&&ADDRESS.test(v)&&!/^0x0{40}$/i.test(v);
export interface WalletResearchSeedHint {
  sourceId:string;sourceUrl:string;commit:string;sha256:string;labels:string[];groups:string[];
  verification:'unverified_external_list';scope:'research_hint_only';ownershipProven:false;qualifiesAsSmart:false;
}
export interface WalletResearchSeedSnapshot {
  sourceId:string;sourceUrl:string;commit:string;sha256:string;received:number;rejected:number;duplicates:number;
  entries:{address:string;labels:string[];groups:string[]}[];
}
export interface WalletResearchSeedCheck {
  chain:Chain;address:string;status:'ok'|'partial'|'unavailable';accepted:number;reason?:string;
}
export interface WalletResearchSeedStatus {
  scope:'research_hint_only';verification:'unverified_external_list';ownershipProven:false;qualifiesAsSmart:false;
  totalAddresses:number;sources:(Omit<WalletResearchSeedSnapshot,'entries'>&{importedAt:string;addresses:number})[];
  sampling:{maxRequestsPerTurn:1;minChainIntervalSec:1800;eligibleEveryChainTurns:4;withinExistingObserverBudget:true;robinhoodRequiresObservedTrades:true};
  chains:{chain:'bsc'|'robinhood';observedWallets:number;withTrades:number;withBuys:number;withVendorProfit:number;withSampledGain:number;
    checkedWallets:number;lastCheckedAt?:string;lastResult?:{status:string;accepted:number;reason?:string}}[];
}

/** Project only address and unverified aliases; vendor group names never become ownership or skill labels. */
export function normalizeWalletResearchSeeds(raw:unknown):WalletResearchSeedSnapshot {
  if(!Array.isArray(raw)||raw.length>5000)throw new Error('WALLET_RESEARCH_SEEDS_INVALID');
  const entries=new Map<string,WalletResearchSeedSnapshot['entries'][number]>();let rejected=0,duplicates=0;
  for(const row of raw){
    if(!object(row)||!validAddress(row.address)||row.name!==undefined&&typeof row.name!=='string'||
      row.groups!==undefined&&(!Array.isArray(row.groups)||row.groups.some(v=>typeof v!=='string'))){rejected++;continue;}
    const address=row.address.toLowerCase(),label=clean(row.name),groups=(row.groups as string[]|undefined??[]).slice(0,20).map(v=>clean(v,80)).filter(Boolean);
    const previous=entries.get(address);if(previous)duplicates++;
    entries.set(address,{address,labels:[...new Set([...(previous?.labels??[]),...(label?[label]:[])])].slice(0,20),
      groups:[...new Set([...(previous?.groups??[]),...groups])].slice(0,20)});
  }
  return {...SOURCE,received:raw.length,rejected,duplicates,entries:[...entries.values()].sort((a,b)=>a.address.localeCompare(b.address))};
}

/** No remote startup dependency: both src and dist resolve the tracked, hash-pinned source snapshot. */
export function loadBundledWalletResearchSeeds():WalletResearchSeedSnapshot {
  const here=dirname(fileURLToPath(import.meta.url)),name='config/research/oooooyoung-evm-2bae0bc.json';
  const path=[resolve(here,'..',name),resolve(here,'../..',name)].find(v=>existsSync(v));
  if(!path)throw new Error('WALLET_RESEARCH_SEEDS_SNAPSHOT_MISSING');
  const bytes=readFileSync(path);if(bytes.length>1_000_000||createHash('sha256').update(bytes).digest('hex')!==SOURCE.sha256)
    throw new Error('WALLET_RESEARCH_SEEDS_HASH_MISMATCH');
  const snapshot=normalizeWalletResearchSeeds(JSON.parse(bytes.toString('utf8')));
  if(snapshot.rejected||snapshot.entries.length!==449)throw new Error('WALLET_RESEARCH_SEEDS_INVALID');
  return snapshot;
}

/** Stored apart from wh_wallets/profile/metrics: membership itself creates no chain evidence. */
export class WalletResearchSeeds {
  constructor(private readonly db:DatabaseSync,private readonly write:(evidence:unknown,operation:()=>unknown)=>void,
    private readonly now:()=>Date){
    db.exec(`CREATE TABLE IF NOT EXISTS wh_research_seed_sources(source_id TEXT PRIMARY KEY,commit_hash TEXT,sha256 TEXT,imported_at TEXT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wh_research_seeds(source_id TEXT,address TEXT,data TEXT NOT NULL,PRIMARY KEY(source_id,address));
      CREATE INDEX IF NOT EXISTS wh_research_seeds_address ON wh_research_seeds(address,source_id);
      CREATE TABLE IF NOT EXISTS wh_research_seed_checks(chain TEXT,address TEXT,checked_at TEXT,status TEXT,accepted INTEGER,reason TEXT,PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS wh_research_seed_checks_time ON wh_research_seed_checks(chain,checked_at DESC);`);
  }
  import(snapshot:WalletResearchSeedSnapshot):void {
    // Only the pinned repository is currently enabled. Reconstruct and compare
    // the normalized data so callers cannot attach verified labels to the list.
    const expected=loadBundledWalletResearchSeeds();
    if(JSON.stringify(snapshot)!==JSON.stringify(expected))throw new Error('WALLET_RESEARCH_SEEDS_INVALID');
    const saved=this.db.prepare('SELECT commit_hash,sha256 FROM wh_research_seed_sources WHERE source_id=?').get(snapshot.sourceId);
    if(saved?.commit_hash===snapshot.commit&&saved.sha256===snapshot.sha256)return;
    const {entries,...meta}=snapshot;
    this.write(snapshot,()=>{
      const put=this.db.prepare('INSERT OR REPLACE INTO wh_research_seeds VALUES(?,?,?)');
      this.db.prepare('DELETE FROM wh_research_seeds WHERE source_id=?').run(snapshot.sourceId);
      for(const entry of entries)put.run(snapshot.sourceId,entry.address,JSON.stringify(entry));
      this.db.prepare('INSERT OR REPLACE INTO wh_research_seed_sources VALUES(?,?,?,?,?)')
        .run(snapshot.sourceId,snapshot.commit,snapshot.sha256,this.now().toISOString(),JSON.stringify(meta));
    });
    if(!this.db.prepare('SELECT 1 FROM wh_research_seed_sources WHERE source_id=? AND sha256=?').get(snapshot.sourceId,snapshot.sha256))
      throw new Error('WALLET_RESEARCH_SEEDS_IMPORT_FAILED');
  }
  hints(chain:Chain,address:string):WalletResearchSeedHint[]{
    if(!['bsc','robinhood'].includes(chain)||!validAddress(address))return [];
    return this.db.prepare(`SELECT s.data AS source,e.data AS entry FROM wh_research_seeds e JOIN wh_research_seed_sources s ON s.source_id=e.source_id
      WHERE e.address=? LIMIT 10`).all(address.toLowerCase()).map(row=>{
      const s=JSON.parse(String(row.source)),e=JSON.parse(String(row.entry));
      return {sourceId:s.sourceId,sourceUrl:s.sourceUrl,commit:s.commit,sha256:s.sha256,labels:e.labels,groups:e.groups,
        verification:'unverified_external_list',scope:'research_hint_only',ownershipProven:false,qualifiesAsSmart:false};
    });
  }
  target(chain:Chain):{chain:Chain;address:string}|undefined {
    if(!['bsc','robinhood'].includes(chain))return;
    const last=this.db.prepare('SELECT checked_at FROM wh_research_seed_checks WHERE chain=? ORDER BY checked_at DESC LIMIT 1').get(chain);
    if(last&&Date.parse(String(last.checked_at))>this.now().getTime()-1_800_000)return;
    // The small imported set drives indexed lookups. Never scan the multi-GB
    // event history. Unknown addresses are BSC research probes only; Robinhood
    // candidates need an already observed trade on that exact chain.
    const row=this.db.prepare(`SELECT e.address FROM (SELECT DISTINCT address FROM wh_research_seeds) e
      LEFT JOIN wh_metrics m ON m.chain=? AND m.address=e.address
      LEFT JOIN wh_research_seed_checks c ON c.chain=? AND c.address=e.address
      WHERE (?='bsc' OR m.buy_count+m.sell_count>0)
      ORDER BY COALESCE(c.checked_at,''),CASE WHEN m.buy_count+m.sell_count>0 THEN 0 ELSE 1 END,e.address LIMIT 1`).get(chain,chain,chain);
    return row?{chain,address:String(row.address)}:undefined;
  }
  checked(check:WalletResearchSeedCheck):void {
    if(!['bsc','robinhood'].includes(check.chain)||!validAddress(check.address)||!['ok','partial','unavailable'].includes(check.status)||
      !Number.isSafeInteger(check.accepted)||check.accepted<0||check.accepted>100||
      check.reason!==undefined&&!/^[A-Z][A-Z0-9_]{0,99}$/.test(check.reason)||
      !this.db.prepare('SELECT 1 FROM wh_research_seeds WHERE address=? LIMIT 1').get(check.address.toLowerCase()))return;
    const stamp=this.now().toISOString();
    this.write(check,()=>this.db.prepare(`INSERT INTO wh_research_seed_checks VALUES(?,?,?,?,?,?) ON CONFLICT(chain,address) DO UPDATE
      SET checked_at=excluded.checked_at,status=excluded.status,accepted=excluded.accepted,reason=excluded.reason`)
      .run(check.chain,check.address.toLowerCase(),stamp,check.status,check.accepted,check.reason??null));
  }
  status():WalletResearchSeedStatus {
    const sources=this.db.prepare('SELECT * FROM wh_research_seed_sources').all().map(row=>({...JSON.parse(String(row.data)),importedAt:String(row.imported_at),
      addresses:Number(this.db.prepare('SELECT count(*) AS n FROM wh_research_seeds WHERE source_id=?').get(row.source_id!)!.n)}));
    const chains=(['bsc','robinhood'] as const).map(chain=>{
      const rows=this.db.prepare(`SELECT m.event_count,m.buy_count,m.sell_count,m.profit_usd,m.gain_pct FROM (SELECT DISTINCT address FROM wh_research_seeds) e
        CROSS JOIN wh_metrics m ON m.chain=? AND m.address=e.address`).all(chain);
      const last=this.db.prepare('SELECT * FROM wh_research_seed_checks WHERE chain=? ORDER BY checked_at DESC LIMIT 1').get(chain);
      return {chain,observedWallets:rows.length,withTrades:rows.filter(v=>Number(v.buy_count)+Number(v.sell_count)>0).length,withBuys:rows.filter(v=>Number(v.buy_count)>0).length,
        withVendorProfit:rows.filter(v=>v.profit_usd!==null).length,withSampledGain:rows.filter(v=>v.gain_pct!==null).length,
        checkedWallets:Number(this.db.prepare('SELECT count(*) AS n FROM wh_research_seed_checks WHERE chain=?').get(chain)!.n),
        ...(last?{lastCheckedAt:String(last.checked_at),lastResult:{status:String(last.status),accepted:Number(last.accepted),...(last.reason?{reason:String(last.reason)}:{})}}:{})};
    });
    return {scope:'research_hint_only',verification:'unverified_external_list',ownershipProven:false,qualifiesAsSmart:false,
      totalAddresses:Number(this.db.prepare('SELECT count(DISTINCT address) AS n FROM wh_research_seeds').get()!.n),sources,chains,
      sampling:{maxRequestsPerTurn:1,minChainIntervalSec:1800,eligibleEveryChainTurns:4,withinExistingObserverBudget:true,robinhoodRequiresObservedTrades:true}};
  }
}
