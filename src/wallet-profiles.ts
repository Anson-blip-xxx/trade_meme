import {DatabaseSync, type StatementSync} from 'node:sqlite';
import {chmodSync,existsSync,mkdirSync,realpathSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chainAddress} from './chain-stream-store.js';
import type {Chain} from './types.js';
import {analyzeWalletRoles,type WalletRoleAnalysis,type WalletRoleEvent,type WalletRoleEventReference,type WalletRolePeerInput} from './wallet-role-analysis.js';

export const WALLET_PROFILE_GROUPS=['public_kol','early_candidate','repeated_early','forward_validated','shared_funding','synchronized','follower_pattern','precursor_pattern','mixed_pattern','vendor_profit_positive','observed_runner','insufficient_evidence','inactive_observed'] as const;
export type WalletProfileGroupId=typeof WALLET_PROFILE_GROUPS[number];
export interface WalletProfileGroup {id:WalletProfileGroupId;firstObservedAt:string;evidenceCount:number;reason:string;}
export interface WalletProfile {
  chain:Chain;address:string;version:1;computedAt:string;evidenceThroughAt?:string;freshUntil:string;status:'current'|'partial'|'stale';
  source:'wallet_history'|'chain_only';sampleOnly:true;ownership:'unknown';groups:WalletProfileGroup[];
  metrics:{observedEvents:number;buyEvents:number;sellEvents:number;distinctTokens:number;lastEventAt?:string;
    vendorProfit?:{realizedProfitUsd:string;period:'7d';observedAt:string;snapshotAt:string;verification:'vendor_claim'};
    observedGain?:{maxGainPct:number;tokenAddress:string;baselineAt:string;peakAt:string;source:string};
    associations:{leaders:number;distinctTokens:number;forwardTokens:number};chain:{transactions:number;transfers:number;lastObservedAt?:string}};
  counterparties:{address:string;kind:'leader'|'shared_funding'|'synchronized';evidenceCount:number}[];
  roleAnalysis?:WalletRoleAnalysis;
  limitations:string[];changes?:{at:string;added:WalletProfileGroupId[];removed:WalletProfileGroupId[]}[];
}
export interface WalletProfileStatus {ready:boolean;profiles:number;sourceWallets:number;profiledSourceWallets:number;initialComplete:boolean;processed:number;lastRunAt?:string;
  roleProfiles:number;rolePending:number;roleLastRunAt?:string;
  groupCounts:Partial<Record<WalletProfileGroupId,number>>;bytes:number;maxBytes:number;capacityReached:boolean;error?:string;sampleOnly:true;staleProfiles:number;}
export interface WalletProfileListOptions {chain?:Chain;group?:string;search?:string;limit?:number;offset?:number;}
export interface WalletProfilesOptions {database:string;historyDatabase:string;chainDatabase?:string;maxBytes?:number;now?:()=>Date;refreshAfterSec?:number;}
type Row=Record<string,any>;
const DAY=86_400_000,CAPACITY='WALLET_PROFILES_CAPACITY_REACHED',SERVICES=new Set(['exchange_or_pool','exchange','pool','router','bridge','cex']);
const parse=(value:unknown):any=>{try{return typeof value==='string'?JSON.parse(value):undefined;}catch{return undefined;}};
const stamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));
const validTime=(value:unknown,now:string):value is string=>stamp(value)&&value<=now;
const num=(value:unknown):number=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
const bounded=(value:unknown,fallback:number,max:number)=>typeof value==='number'&&Number.isSafeInteger(value)?Math.max(1,Math.min(max,value)):fallback;
const canonicalPath=(path:string)=>path===':memory:'?path:existsSync(path)?realpathSync(path):resolve(path);
const filesBytes=(path:string,db?:DatabaseSync)=>path===':memory:'&&db?Number(db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.prepare('PRAGMA page_size').get()!.page_size):
  [path,path+'-wal',path+'-shm'].reduce((n,p)=>{try{return n+statSync(p).size;}catch{return n;}},0);
const emptyStatus=():WalletProfileStatus=>({ready:false,profiles:0,sourceWallets:0,profiledSourceWallets:0,initialComplete:false,processed:0,roleProfiles:0,rolePending:0,groupCounts:{},bytes:0,maxBytes:0,capacityReached:false,sampleOnly:true,staleProfiles:0});

/** Independently persisted research classifications. Every source database is opened read-only. */
export class WalletProfiles {
  private readonly history:DatabaseSync;private chain?:DatabaseSync;private readonly db:DatabaseSync;
  private readonly now:()=>Date;private readonly maxBytes:number;private readonly refreshMs:number;
  private readonly sourceStatements=new Map<string,StatementSync>();private readonly outputStatements=new Map<string,StatementSync>();
  private sourceCount=0;private countedAt=0;
  private readonly roleKeys=new Map<string,string>();
  private readonly funderCache=new Map<string,boolean>();
  private readonly newQualifications=new Map<string,{profile:WalletProfile;peers:Set<string>}>();
  constructor(private readonly options:WalletProfilesOptions) {
    this.now=options.now??(()=>new Date());this.maxBytes=options.maxBytes??256*1024*1024;this.refreshMs=(options.refreshAfterSec??1800)*1000;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<16_384||!Number.isFinite(this.refreshMs)||this.refreshMs<1000||canonicalPath(options.database)===canonicalPath(options.historyDatabase)||
      options.chainDatabase&&canonicalPath(options.database)===canonicalPath(options.chainDatabase))throw new Error('WALLET_PROFILES_CONFIG_INVALID');
    this.history=new DatabaseSync(options.historyDatabase,{readOnly:true});this.history.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');
    if(options.chainDatabase&&existsSync(options.chainDatabase)){this.chain=new DatabaseSync(options.chainDatabase,{readOnly:true});this.chain.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');}
    if(options.database!==':memory:')mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.database);if(options.database!==':memory:')chmodSync(options.database,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA wal_autocheckpoint=64;
      CREATE TABLE IF NOT EXISTS wp_profiles(chain TEXT,address TEXT,computed_at TEXT NOT NULL,fresh_until TEXT NOT NULL,data TEXT NOT NULL,source_wallet INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS wp_profiles_due ON wp_profiles(fresh_until);
      CREATE INDEX IF NOT EXISTS wp_profiles_recent ON wp_profiles(computed_at DESC,chain,address);
      CREATE TABLE IF NOT EXISTS wp_groups(chain TEXT,address TEXT,group_id TEXT,first_at TEXT NOT NULL,PRIMARY KEY(chain,address,group_id));
      CREATE INDEX IF NOT EXISTS wp_groups_filter ON wp_groups(group_id,chain,address);
      CREATE TABLE IF NOT EXISTS wp_group_first(chain TEXT,address TEXT,group_id TEXT,first_at TEXT NOT NULL,PRIMARY KEY(chain,address,group_id));
      CREATE TABLE IF NOT EXISTS wp_changes(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,observed_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS wp_changes_wallet ON wp_changes(chain,address,id DESC);
      CREATE TABLE IF NOT EXISTS wp_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(wp_profiles)').all().some(column=>column.name==='source_wallet'))this.db.exec('ALTER TABLE wp_profiles ADD COLUMN source_wallet INTEGER NOT NULL DEFAULT 0');
    for(const column of ['role_computed_at','role_input_key'])if(!this.db.prepare('PRAGMA table_info(wp_profiles)').all().some(row=>row.name===column))this.db.exec(`ALTER TABLE wp_profiles ADD COLUMN ${column} TEXT`);
    this.db.exec('CREATE INDEX IF NOT EXISTS wp_profiles_source ON wp_profiles(source_wallet)');
    this.db.exec('CREATE INDEX IF NOT EXISTS wp_profiles_roles ON wp_profiles(role_computed_at)');
    const oldLimit=Number(this.meta('max_bytes'));this.setMeta('max_bytes',String(this.maxBytes));
    if(this.meta('error')===CAPACITY&&this.maxBytes>oldLimit&&filesBytes(options.database,this.db)+32768<this.maxBytes)this.setMeta('error','');
    // Historical coverage belongs to the rowid pass. Start update watermarks at
    // worker creation so live changes never queue behind the entire old corpus.
    if(!this.meta('changed_at'))this.setMeta('changed_at',this.now().toISOString());
    if(!this.meta('coordination_at'))this.setMeta('coordination_at',this.now().toISOString());
  }
  private hs(sql:string):StatementSync {let statement=this.sourceStatements.get(sql);if(!statement){statement=this.history.prepare(sql);this.sourceStatements.set(sql,statement);}return statement;}
  private os(sql:string):StatementSync {let statement=this.outputStatements.get(sql);if(!statement){statement=this.db.prepare(sql);this.outputStatements.set(sql,statement);}return statement;}
  private meta(key:string):string{return String(this.os('SELECT value FROM wp_meta WHERE key=?').get(key)?.value??'');}
  private setMeta(key:string,value:string):void {this.os('INSERT INTO wp_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  runBatch(limit=100):WalletProfileStatus {
    if(this.meta('error')===CAPACITY)return this.status();
    if(!this.chain&&this.options.chainDatabase&&existsSync(this.options.chainDatabase)){this.chain=new DatabaseSync(this.options.chainDatabase,{readOnly:true});this.chain.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');}
    let historyTransaction=false,chainTransaction=false;
    try {
      this.history.exec('BEGIN');historyTransaction=true;
      if(this.chain){this.chain.exec('BEGIN');chainTransaction=true;}
      return this.runSnapshot(limit);
    }finally{
      // Read snapshots must close even when malformed evidence, capacity or an
      // output failure interrupts a batch. The sources are never mutated.
      try{if(chainTransaction)this.chain!.exec('ROLLBACK');}finally{if(historyTransaction)this.history.exec('ROLLBACK');}
    }
  }
  private runSnapshot(limit:number):WalletProfileStatus {
    this.roleKeys.clear();this.funderCache.clear();this.newQualifications.clear();
    const now=this.now().toISOString(),n=bounded(limit,100,1000),targets=new Map<string,{chain:Chain;address:string}>();
    if(this.meta('error')===CAPACITY)return this.status();
    const add=(row:Row)=>{const chain=row.chain as Chain,address=chainAddress(chain,row.address??row.wallet);if(address)targets.set(chain+':'+address,{chain,address});};
    const initialCursor=Number(this.meta('initial_cursor')||0),initialLimit=Math.max(1,Math.ceil(n*0.6));
    const initial=this.hs('SELECT rowid AS cursor,chain,address FROM wh_wallets WHERE rowid>? ORDER BY rowid LIMIT ?').all(initialCursor,initialLimit);
    initial.forEach(add);
    // Stable timestamp/rowid cursor consumes changed wallets fairly; new rows have an independent cursor.
    const changedAt=this.meta('changed_at'),changedRow=Number(this.meta('changed_row')||0),changedLimit=Math.max(1,Math.ceil(n*0.1));
    const changed=this.hs('SELECT rowid AS cursor,chain,address,last_at FROM wh_wallets WHERE last_at>=? AND last_at<=? AND (last_at>? OR (last_at=? AND rowid>?)) ORDER BY last_at,rowid LIMIT ?').all(changedAt,now,changedAt,changedAt,changedRow,changedLimit);
    changed.forEach(add);
    const coordinationAt=this.meta('coordination_at'),coordinationRow=Number(this.meta('coordination_row')||0);
    const coordination=this.hs(`SELECT rowid AS cursor,chain,address,coordination_checked_at FROM wh_metrics WHERE coordination_dirty=0
      AND coordination_checked_at>=? AND coordination_checked_at<=? AND (coordination_checked_at>? OR (coordination_checked_at=? AND rowid>?))
      ORDER BY coordination_checked_at,rowid LIMIT ?`).all(coordinationAt,now,coordinationAt,coordinationAt,coordinationRow,changedLimit);
    coordination.forEach(add);
    // Existing profiles also receive the new model, independent of new events
    // or the original history cursor. The NULL index makes this bounded.
    this.os('SELECT chain,address FROM wp_profiles WHERE role_computed_at IS NULL LIMIT ?').all(Math.max(1,Math.ceil(n*0.2))).forEach(add);
    const due=this.os('SELECT chain,address FROM wp_profiles WHERE fresh_until<=? ORDER BY fresh_until LIMIT ?').all(now,Math.max(1,n-targets.size));due.forEach(add);
    const chainCursor=Number(this.meta('chain_cursor')||0);
    const chainRows=this.chain?.prepare('SELECT rowid AS cursor,chain,wallet FROM chain_events WHERE rowid>? ORDER BY rowid LIMIT ?').all(chainCursor,Math.max(1,Math.min(200,Math.floor(n*0.2))))??[];
    chainRows.forEach(add);
    this.db.exec('BEGIN');
    let processed=0,full=false;
    try {
      for(const target of targets.values()){
        const profile=this.compute(target.chain,target.address,now);if(!profile)continue;
        const size=Buffer.byteLength(JSON.stringify(profile));
        const logical=Number(this.os('PRAGMA page_count').get()!.page_count)*Number(this.os('PRAGMA page_size').get()!.page_size);
        if(Math.max(logical,filesBytes(this.options.database,this.db))+size*4+32768>this.maxBytes){full=true;break;}
        this.save(profile);processed++;
      }
      // Never advance input cursors over a capacity-truncated batch.
      if(!full){if(initial.length)this.setMeta('initial_cursor',String(initial.at(-1)!.cursor));
        this.setMeta('initial_complete',initial.length<initialLimit?'1':'0');
        if(changed.length){this.setMeta('changed_at',String(changed.at(-1)!.last_at));this.setMeta('changed_row',String(changed.at(-1)!.cursor));}
        if(coordination.length){this.setMeta('coordination_at',String(coordination.at(-1)!.coordination_checked_at));this.setMeta('coordination_row',String(coordination.at(-1)!.cursor));}
        if(chainRows.length)this.setMeta('chain_cursor',String(chainRows.at(-1)!.cursor));}
      // No reader can see any row until this transaction commits. Newly formed
      // peer qualifications therefore start at batch completion, never at the
      // earlier read-snapshot time or an intermediate per-wallet calculation.
      const registeredAt=this.now().toISOString();
      if(!validTime(now,registeredAt))throw new Error('WALLET_PROFILE_REGISTRATION_CLOCK_INVALID');
      for(const {profile,peers} of this.newQualifications.values()){
        profile.computedAt=registeredAt;profile.roleAnalysis!.computedAt=registeredAt;
        for(const peer of profile.roleAnalysis!.peers)if(peers.has(peer.address))peer.qualification!.knownAt=registeredAt;
        this.os('UPDATE wp_profiles SET computed_at=?,role_computed_at=?,data=? WHERE chain=? AND address=?')
          .run(registeredAt,registeredAt,JSON.stringify(profile),profile.chain,profile.address);
      }
      this.setMeta('processed',String(Number(this.meta('processed')||0)+processed));this.setMeta('last_run_at',registeredAt);
      if(full)this.setMeta('error',CAPACITY);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    if(!this.countedAt||this.now().getTime()-this.countedAt>=60_000){this.sourceCount=Number(this.hs('SELECT count(*) AS n FROM wh_wallets').get()!.n);this.countedAt=this.now().getTime();this.setMeta('source_wallets',String(this.sourceCount));}
    return this.status();
  }
  private compute(chain:Chain,address:string,now:string):WalletProfile|undefined {
    const wallet=this.hs('SELECT * FROM wh_wallets WHERE chain=? AND address=?').get(chain,address);
    const rawMetrics=this.hs('SELECT * FROM wh_metrics WHERE chain=? AND address=?').get(chain,address);
    const chainRows=this.chain?.prepare('SELECT data FROM chain_events WHERE chain=? AND wallet=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 501').all(chain,address,now)??[];
    if(!wallet&&!chainRows.length)return;
    const limitations=['SAMPLED_OBSERVATIONS_NOT_COMPLETE_HISTORY','ASSOCIATIONS_DO_NOT_PROVE_COMMON_OWNERSHIP','VENDOR_PROFIT_IS_NOT_LOCAL_REALIZED_PNL'];
    const profile:WalletProfile={chain,address,version:1,computedAt:now,freshUntil:new Date(Date.parse(now)+this.refreshMs).toISOString(),status:'current',source:wallet?'wallet_history':'chain_only',sampleOnly:true,ownership:'unknown',groups:[],
      metrics:{observedEvents:0,buyEvents:0,sellEvents:0,distinctTokens:0,associations:{leaders:0,distinctTokens:0,forwardTokens:0},chain:{transactions:0,transfers:0}},counterparties:[],limitations};
    const group=(id:WalletProfileGroupId,evidenceCount:number,reason:string)=>{if(!profile.groups.some(g=>g.id===id))profile.groups.push({id,firstObservedAt:now,evidenceCount,reason});};
    const seen=(value:unknown)=>{if(validTime(value,now)&&(!profile.evidenceThroughAt||value>profile.evidenceThroughAt))profile.evidenceThroughAt=value;};
    const partial=(reason:string)=>{profile.status='partial';if(!limitations.includes(reason))limitations.push(reason);};
    const addCounterparty=(other:unknown,kind:WalletProfile['counterparties'][number]['kind'],evidenceCount:number)=>{const value=chainAddress(chain,other);if(value&&value!==address&&profile.counterparties.length<50&&!profile.counterparties.some(p=>p.address===value&&p.kind===kind))profile.counterparties.push({address:value,kind,evidenceCount});};
    if(validTime(wallet?.last_at,now))seen(wallet!.last_at);
    const events=this.hs('SELECT data FROM wh_events WHERE chain=? AND wallet=? AND event_at<=? AND observed_at<=? ORDER BY event_at DESC LIMIT 501').all(chain,address,now,now);
    if(events.length>500)partial('EVENT_SAMPLE_LIMIT_500');
    const tokens=new Set<string>();
    for(const row of events.slice(0,500)){
      const event=parse(row.data);if(!event||!validTime(event.eventAt,now)||!validTime(event.observedAt,now)||event.eventAt>event.observedAt||event.chain!==chain||event.wallet!==address)continue;
      profile.metrics.observedEvents++;if(event.side==='buy')profile.metrics.buyEvents++;if(event.side==='sell')profile.metrics.sellEvents++;
      const token=chainAddress(chain,event.tokenAddress);if(token)tokens.add(token);seen(event.observedAt);
      if(!profile.metrics.lastEventAt||event.eventAt>profile.metrics.lastEventAt)profile.metrics.lastEventAt=event.eventAt;
    }
    profile.metrics.distinctTokens=tokens.size;
    const anchors=this.hs('SELECT public_observed_at FROM wh_assoc_anchors WHERE chain=? AND leader=? AND public_observed_at<=? LIMIT 101').all(chain,address,now);
    if(anchors.length)group('public_kol',Math.min(100,anchors.length),'供应商 KOL 信号曾公开标记此钱包；标签不等于身份已验证');
    anchors.forEach(a=>seen(a.public_observed_at));if(anchors.length>100)partial('PUBLIC_ANCHOR_SAMPLE_LIMIT_100');
    const relations=this.hs('SELECT * FROM wh_assoc_relations WHERE chain=? AND candidate=? AND token_count>0 LIMIT 21').all(chain,address);
    const earlyTokens=new Set<string>(),forwardTokens=new Set<string>();let leaders=0;
    if(relations.length>20)partial('RELATION_SAMPLE_LIMIT_20');
    for(const relation of relations.slice(0,20)){
      if(Number(relation.dirty)!==0||!validTime(relation.updated_at,now)){partial('RELATION_CACHE_PENDING_OR_STALE');continue;}
      if(Date.parse(now)-Date.parse(String(relation.updated_at))>DAY&&!limitations.includes('HISTORICAL_ASSOCIATION_EVIDENCE'))limitations.push('HISTORICAL_ASSOCIATION_EVIDENCE');
      const episodes=this.hs('SELECT data FROM wh_assoc_episodes WHERE chain=? AND leader=? AND candidate=? AND active=1 ORDER BY updated_at DESC LIMIT 101').all(chain,relation.leader!,address);
      let evidence=0;if(episodes.length>100)partial('EPISODE_SAMPLE_LIMIT_100');
      for(const row of episodes.slice(0,100)){
        const e=parse(row.data),token=e&&chainAddress(chain,e.tokenAddress);
        if(!token||!validTime(e.updatedAt,now)||!validTime(e.firstDiscoveredAt,now)||!validTime(e.leaderPublicObservedAt,now)||
          !e.candidateBuy||!e.leaderBuy||e.candidateBuy.wallet!==address||e.leaderBuy.wallet!==relation.leader||
          !validTime(e.candidateBuy.eventAt,now)||!validTime(e.candidateBuy.observedAt,now)||!validTime(e.leaderBuy.eventAt,now)||!validTime(e.leaderBuy.observedAt,now)||
          e.candidateBuy.eventAt>=e.leaderBuy.eventAt||e.candidateBuy.eventAt>e.candidateBuy.observedAt||e.leaderBuy.eventAt>e.leaderBuy.observedAt)continue;
        earlyTokens.add(token);evidence++;seen(e.candidateBuy.observedAt);seen(e.leaderBuy.observedAt);
        if(e.forwardValidated===true&&e.candidateBuy.observedAt<e.leaderBuy.eventAt&&validTime(relation.active_since,now)&&String(relation.active_since)<e.candidateBuy.eventAt)forwardTokens.add(token);
      }
      if(evidence){leaders++;addCounterparty(relation.leader,'leader',evidence);}
      const funding=parse(relation.funding_data);
      for(const evidence of (Array.isArray(funding)?funding:[]).slice(0,10)){
        if(evidence.kind!=='common'||!validTime(evidence.observedAt,now)||!Array.isArray(evidence.edges)||evidence.edges.length<2||!this.funderUsable(chain,evidence.address,now))continue;
        if(!evidence.edges.every((e:any)=>!e.sharedService&&!e.conflict&&validTime(e.observedAt,now)&&(!e.snapshotAt||validTime(e.snapshotAt,e.observedAt))))continue;
        group('shared_funding',1,'关联钱包存在共同资金来源线索，已排除已知交易所、桥、路由及公共池；不能据此认定同一控制人');addCounterparty(evidence.address,'shared_funding',1);seen(evidence.observedAt);
      }
    }
    profile.metrics.associations={leaders,distinctTokens:earlyTokens.size,forwardTokens:forwardTokens.size};
    if(earlyTokens.size)group('early_candidate',earlyTokens.size,'在采样交易中早于公开 KOL 钱包买入；历史回看与前向验证分开');
    if(earlyTokens.size>=2)group('repeated_early',earlyTokens.size,'历史上至少两个不同合约出现提前线索，可来自不同公开钱包；是否反复提前须看逐对行为判别及晚买反例');
    if(forwardTokens.size)group('forward_validated',forwardTokens.size,'关系先被记录，再观察到候选钱包买入，随后公开 KOL 买入');
    if(rawMetrics){
      const profit=parse(rawMetrics.profit_data),profitAt=profit?.snapshotAt??profit?.observedAt;
      if(profit?.period==='7d'&&profit.scope==='entire_wallet'&&profit.verification==='vendor_claim'&&profit.chain===chain&&profit.wallet===address&&
        typeof profit.realizedProfitUsd==='string'&&/^-?(0|[1-9]\d*)(\.\d+)?$/.test(profit.realizedProfitUsd)&&Number.isFinite(Number(profit.realizedProfitUsd))&&
        validTime(profit.observedAt,now)&&validTime(profitAt,profit.observedAt)&&Date.parse(now)-Date.parse(profitAt)<=DAY){
        profile.metrics.vendorProfit={realizedProfitUsd:profit.realizedProfitUsd,period:'7d',observedAt:profit.observedAt,snapshotAt:profitAt,verification:'vendor_claim'};seen(profit.observedAt);
        if(Number(profit.realizedProfitUsd)>0)group('vendor_profit_positive',1,'最近 24 小时内供应商报告的全钱包 7 日已实现利润为正；非本系统核算');
        profile.freshUntil=new Date(Math.min(Date.parse(profile.freshUntil),Date.parse(profitAt)+DAY+1)).toISOString();
      }else if(profit)limitations.push('VENDOR_PROFIT_MISSING_STALE_OR_INVALID');
      const gain=parse(rawMetrics.gain_data);
      if(gain?.kind==='first_post_observed_buy_quote'&&chainAddress(chain,gain.tokenAddress)&&typeof gain.maxGainPct==='number'&&Number.isFinite(gain.maxGainPct)&&gain.maxGainPct>=0&&
        validTime(gain.baselineAt,now)&&validTime(gain.peakAt,now)&&validTime(gain.latestAt,now)&&gain.baselineAt<=gain.peakAt&&gain.peakAt<=gain.latestAt&&
        typeof gain.source==='string'&&/^[a-z][a-z0-9_.:-]{0,79}$/.test(gain.source)){
        profile.metrics.observedGain={maxGainPct:gain.maxGainPct,tokenAddress:gain.tokenAddress,baselineAt:gain.baselineAt,peakAt:gain.peakAt,source:gain.source};seen(gain.latestAt);
        if(gain.maxGainPct>=100)group('observed_runner',1,'钱包买入被观察后，该币本地采样报价曾上涨至少 100%；不是该钱包实际盈利');
      }
      const coordination=parse(rawMetrics.coordination_data);
      if(coordination&&Number(rawMetrics.coordination_dirty)===0&&validTime(rawMetrics.coordination_checked_at,now)){
        if(Date.parse(now)-Date.parse(String(rawMetrics.coordination_checked_at))>DAY)limitations.push('HISTORICAL_COORDINATION_EVIDENCE');
        const shared=(Array.isArray(coordination.sharedFunding)?coordination.sharedFunding:[]).slice(0,50).filter((e:any)=>validTime(e.observedAt,now)&&this.funderUsable(chain,e.address,now));
        if(shared.length){group('shared_funding',shared.length,'采样资金来源重合，已排除已知公共服务；仅为关联线索');shared.forEach((e:any)=>{addCounterparty(e.address,'shared_funding',1);seen(e.observedAt);});}
        const sync=(Array.isArray(coordination.synchronized)?coordination.synchronized:[]).slice(0,50).filter((e:any)=>chainAddress(chain,e.wallet)&&chainAddress(chain,e.tokenAddress)&&Number.isSafeInteger(e.distinctTransactions)&&e.distinctTransactions>=2&&e.windowSeconds===120);
        if(sync.length){group('synchronized',sync.length,'相同代币、同方向的 120 秒窗口内重复出现；普通跟单也会产生这种现象，不证明共同控制');sync.forEach((e:any)=>addCounterparty(e.wallet,'synchronized',e.distinctTransactions));}
      }else if(coordination)partial('COORDINATION_CACHE_PENDING_OR_STALE');
    }
    if(chainRows.length>500)partial('CHAIN_EVENT_SAMPLE_LIMIT_500');
    let unknownChainEventTime=false;const txs=new Set<string>();
    for(const row of chainRows.slice(0,500)){
      const event=parse(row.data);if(!event||event.removed===true||event.chain!==chain||event.wallet!==address||!validTime(event.observedAt,now)||!['rpc_confirmed','rpc_observed'].includes(event.verification)||!['wallet_transaction','token_transfer','native_transfer'].includes(event.kind))continue;
      if(event.eventAt&&!validTime(event.eventAt,now))continue;
      txs.add(event.txHash);if(event.kind==='token_transfer'||event.kind==='native_transfer')profile.metrics.chain.transfers++;
      seen(event.observedAt);if(!profile.metrics.chain.lastObservedAt||event.observedAt>profile.metrics.chain.lastObservedAt)profile.metrics.chain.lastObservedAt=event.observedAt;
      if(event.eventAt){if(!profile.metrics.lastEventAt||event.eventAt>profile.metrics.lastEventAt)profile.metrics.lastEventAt=event.eventAt;}else if(Date.parse(now)-Date.parse(event.observedAt)<7*DAY)unknownChainEventTime=true;
    }
    profile.metrics.chain.transactions=txs.size;
    profile.roleAnalysis=this.roles(chain,address,events.slice(0,500).map(row=>parse(row.data)).filter(Boolean),events.length>500,relations,now);
    profile.freshUntil=new Date(Math.min(Date.parse(profile.freshUntil),Date.parse(profile.roleAnalysis.computedAt)+this.refreshMs)).toISOString();
    for(const peer of profile.roleAnalysis.peers)if(peer.classification!=='insufficient')
      group(peer.classification,peer.matchedTokens,`${peer.classification==='follower_pattern'?'跟随':peer.classification==='precursor_pattern'?'提前':'方向混合'}模式样本；按同一对钱包比较，详情保留所有共同合约及反例，不证明身份或预测能力`);
    if(txs.size)limitations.push('CHAIN_PARTICIPATION_OR_TRANSFER_IS_NOT_A_BUY_SELL_OR_HOLDING');
    if(unknownChainEventTime)limitations.push('CHAIN_EVENT_TIME_UNKNOWN');
    if(profile.metrics.lastEventAt&&Date.parse(now)-Date.parse(profile.metrics.lastEventAt)>=7*DAY&&!unknownChainEventTime)group('inactive_observed',1,'已采样交易的最后事件距今至少 7 天；数据覆盖不完整，不能认定钱包实际停止活动');
    if(!profile.groups.some(g=>g.id!=='inactive_observed'))group('insufficient_evidence',profile.metrics.observedEvents+profile.metrics.chain.transactions,'当前采样尚不足以归入行为分组；不会把链上参与或供应商标签当作收益证明');
    profile.groups.sort((a,b)=>WALLET_PROFILE_GROUPS.indexOf(a.id)-WALLET_PROFILE_GROUPS.indexOf(b.id));
    // Full current frames are needed while computing/rechecking, not as a
    // second durable copy. Persist UI examples plus qualified frozen proofs.
    for(const peer of profile.roleAnalysis.peers)delete peer.screeningEvidence;
    return profile;
  }
  private roles(chain:Chain,address:string,events:WalletRoleEvent[],truncated:boolean,relations:Row[],now:string):WalletRoleAnalysis {
    const key=chain+':'+address;
    const inputKey=createHash('sha256').update(JSON.stringify([events,relations.map(r=>[r.leader,r.updated_at,r.dirty,r.active_since])])).digest('hex');
    this.roleKeys.set(key,inputKey);
    const cached=this.os('SELECT role_input_key,data FROM wp_profiles WHERE chain=? AND address=?').get(chain,address);
    const old=parse(cached?.data)?.roleAnalysis as WalletRoleAnalysis|undefined;
    if(cached?.role_input_key===inputKey&&old?.version===1&&old.method?.screeningEvidenceLimitPerPeer===30&&
      !old.peers.some(peer=>peer.qualification)&&validTime(old.computedAt,now)&&
      Date.parse(now)-Date.parse(old.computedAt)<Math.min(600000,this.refreshMs))return old;
    // Choose recent candidate contracts before looking at the other wallet's
    // direction. The sampling frame cannot cherry-pick winning early trades.
    const tokens=[...new Set(events.filter(e=>e.side==='buy'&&e.chain===chain&&e.wallet===address&&
      validTime(e.eventAt,now)&&validTime(e.observedAt,now)&&e.eventAt<=e.observedAt).map(e=>chainAddress(chain,e.tokenAddress)).filter((v):v is string=>!!v))];
    if(tokens.length<3){const result=analyzeWalletRoles({chain,wallet:address,asOf:now,walletEvents:events,peers:[],truncated});
      result.limitations.push('候选买入合约少于 3 个，本轮不展开角色比较；不能据此认定没有关联。');return result;}
    const selected=tokens.slice(0,30),placeholders=selected.map(()=>'?').join(',');
    const discovery=this.hs(`SELECT leader,MIN(public_observed_at) AS public_at,COUNT(DISTINCT token_address) AS shared_tokens
      FROM wh_assoc_anchors WHERE chain=? AND token_address IN (${placeholders}) AND public_observed_at<=? AND leader<>?
      GROUP BY leader ORDER BY shared_tokens DESC,leader LIMIT 5`).all(chain,...selected,now,address);
    const firstBuys=(wallet:string,selection=selected):WalletRoleEvent[]=>{
      const rows=this.hs(`WITH tokens(token) AS (VALUES ${selection.map(()=>'(?)').join(',')})
        SELECT e.data,(SELECT o.data FROM wh_observations o INDEXED BY wh_observations_event WHERE o.event_id=e.id AND o.kind='trade'
          AND o.observed_at<=? AND json_extract(o.data,'$.eventAt')<>e.event_at LIMIT 1) AS conflict_data,
          (SELECT c.data FROM wh_events c INDEXED BY wh_assoc_wallet_buy
            WHERE c.chain=e.chain AND c.wallet=e.wallet AND c.token_address=e.token_address AND c.side='buy'
              AND c.tx_hash=e.tx_hash AND c.event_at<>e.event_at AND c.event_at<=? AND c.observed_at<=? LIMIT 1) AS canonical_conflict_data
        FROM tokens t CROSS JOIN wh_events e ON e.id=(SELECT x.id FROM wh_events x WHERE x.chain=? AND x.wallet=?
          AND x.token_address=t.token AND x.side='buy' AND x.event_at<=? AND x.observed_at<=? ORDER BY x.event_at,x.id LIMIT 1)`)
        .all(...selection,now,now,now,chain,wallet,now,now);
      // Event indexes produce separate canonical IDs. Pass one contradictory
      // row from the same wallet/token/transaction too, so choosing its earliest
      // row cannot hide incompatible timestamps from the pure timing analysis.
      return rows.flatMap(row=>[parse(row.data),parse(row.conflict_data),parse(row.canonical_conflict_data)].filter(Boolean));
    };
    const peers:WalletRolePeerInput[]=discovery.slice(0,4).flatMap(row=>{
      const peer=chainAddress(chain,row.leader);if(!peer)return [];
      const relation=relations.find(r=>r.leader===peer)??this.hs('SELECT * FROM wh_assoc_relations WHERE chain=? AND leader=? AND candidate=?').get(chain,peer,address);
      const validRelation=relation&&Number(relation.dirty)===0&&validTime(relation.updated_at,now);
      const funding=validRelation?parse(relation!.funding_data):[];
      return [{address:peer,publicObservedAt:String(row.public_at),events:firstBuys(peer),
        ...(validRelation&&validTime(relation!.active_since,now)?{relationshipKnownAt:String(relation!.active_since)}:{}),
        fundingEvidence:(Array.isArray(funding)?funding:[]).slice(0,10).filter(e=>['direct','common'].includes(e.kind)&&validTime(e.observedAt,now)).map(e=>({
          kind:e.kind,address:e.address,observedAt:e.observedAt,verification:'vendor_claim' as const,
          sharedService:!this.funderUsable(chain,e.address,now)||e.edges?.some((v:any)=>v.sharedService===true),
          conflict:!Array.isArray(e.edges)||!e.edges.length||e.edges.some((v:any)=>v.conflict===true||!validTime(v.observedAt,now)||
            v.snapshotAt&&!validTime(v.snapshotAt,v.observedAt)||v.eventAt&&!validTime(v.eventAt,v.snapshotAt??v.observedAt))}))}];
    });
    const previous=old?structuredClone(old):undefined;
    // Frozen proofs can outlive the moving 30-token comparison frame. Re-read
    // only those old leading contracts, so a newly discovered contradiction
    // cannot survive merely because that contract fell outside the UI sample.
    for(const peer of previous?.peers??[]){
      if(!peer.qualification||!peers.some(row=>row.address===peer.address))continue;
      const outside=peer.qualification.evidence.filter(row=>row.direction==='lead'&&!selected.includes(row.tokenAddress));
      const oldTokens=[...new Set(outside.map(row=>chainAddress(chain,row.tokenAddress)).filter((value):value is string=>!!value))].slice(0,30);
      if(!oldTokens.length)continue;
      const rechecked=analyzeWalletRoles({chain,wallet:address,asOf:now,walletEvents:firstBuys(address,oldTokens),
        peers:[{address:peer.address,events:firstBuys(peer.address,oldTokens)}]}).peers[0]?.screeningEvidence??[];
      const same=(a:WalletRoleEventReference|undefined,b:WalletRoleEventReference|undefined)=>!!a&&!!b&&
        a.wallet===b.wallet&&a.txHash===b.txHash&&a.eventAt===b.eventAt&&a.eventIndex===b.eventIndex;
      if(outside.some(prior=>{const current=rechecked.find(row=>row.tokenAddress===prior.tokenAddress);
        return !current||current.direction!=='lead'||!same(current.candidateBuy,prior.candidateBuy)||!same(current.leaderBuy,prior.leaderBuy);}))delete peer.qualification;
    }
    const own=[...firstBuys(address),...events.filter(e=>e.side==='sell'&&selected.includes(e.tokenAddress))];
    const result=analyzeWalletRoles({chain,wallet:address,asOf:now,walletEvents:own,peers,previous,truncated:truncated||tokens.length>30||discovery.length>4});
    result.limitations.push('先按本钱包最近采样买入选取最多 30 个合约，再按共同合约数选取最多 4 个公开标记钱包；双方最早买入从本地档案重新读取，不按提前结果筛选。');
    result.limitations.push('方向门槛是研究筛选参数，未校准为置信概率；真实预测能力仍需独立登记未来机会及覆盖缺口。');
    if(!peers.length)result.limitations.push('当前采样合约未找到可比较的公开标记钱包，不表示没有上游来源。');
    return result;
  }
  private funderUsable(chain:Chain,address:unknown,now:string):boolean {
    const value=chainAddress(chain,address);if(!value)return false;
    const key=chain+':'+value,cached=this.funderCache.get(key);if(cached!==undefined)return cached;
    const wallet=this.hs('SELECT profile FROM wh_wallets WHERE chain=? AND address=?').get(chain,value),labels=parse(wallet?.profile)?.labels;
    let usable=!(Array.isArray(labels)&&labels.some((v:unknown)=>SERVICES.has(String(v))))&&
      !this.hs('SELECT 1 FROM wh_funding WHERE chain=? AND funding_address=? AND shared=1 AND observed_at<=? LIMIT 1').get(chain,value,now);
    if(usable)usable=this.hs('SELECT DISTINCT wallet FROM wh_funding WHERE chain=? AND funding_address=? AND observed_at<=? LIMIT 21').all(chain,value,now).length<=20;
    this.funderCache.set(key,usable);return usable;
  }
  private save(profile:WalletProfile):void {
    const old=parse(this.os('SELECT data FROM wp_profiles WHERE chain=? AND address=?').get(profile.chain,profile.address)?.data) as WalletProfile|undefined;
    const peers=new Set((profile.roleAnalysis?.peers??[]).filter(peer=>peer.qualification&&
      JSON.stringify(peer.qualification)!==JSON.stringify(old?.roleAnalysis?.peers.find(previous=>previous.address===peer.address)?.qualification)).map(peer=>peer.address));
    if(peers.size)this.newQualifications.set(profile.chain+':'+profile.address,{profile,peers});
    const previous=new Set(old?.groups.map(g=>g.id)??[]),current=new Set(profile.groups.map(g=>g.id));
    for(const group of profile.groups){this.os('INSERT OR IGNORE INTO wp_group_first VALUES (?,?,?,?)').run(profile.chain,profile.address,group.id,profile.computedAt);
      group.firstObservedAt=String(this.os('SELECT first_at FROM wp_group_first WHERE chain=? AND address=? AND group_id=?').get(profile.chain,profile.address,group.id)!.first_at);}
    const added=profile.groups.map(g=>g.id).filter(id=>!previous.has(id)),removed=(old?.groups.map(g=>g.id)??[]).filter(id=>!current.has(id));
    if(added.length||removed.length)this.os('INSERT INTO wp_changes(chain,address,observed_at,data) VALUES (?,?,?,?)').run(profile.chain,profile.address,profile.computedAt,JSON.stringify({at:profile.computedAt,added,removed}));
    this.os(`INSERT INTO wp_profiles(chain,address,computed_at,fresh_until,data,source_wallet,role_computed_at,role_input_key) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(chain,address)
      DO UPDATE SET computed_at=excluded.computed_at,fresh_until=excluded.fresh_until,data=excluded.data,source_wallet=excluded.source_wallet,
        role_computed_at=excluded.role_computed_at,role_input_key=excluded.role_input_key`)
      .run(profile.chain,profile.address,profile.computedAt,profile.freshUntil,JSON.stringify(profile),profile.source==='wallet_history'?1:0,
        profile.roleAnalysis?.computedAt??null,this.roleKeys.get(profile.chain+':'+profile.address)??null);
    this.os('DELETE FROM wp_groups WHERE chain=? AND address=?').run(profile.chain,profile.address);
    for(const group of profile.groups)this.os('INSERT INTO wp_groups VALUES (?,?,?,?)').run(profile.chain,profile.address,group.id,group.firstObservedAt);
  }
  status():WalletProfileStatus{return readStatus(this.db,this.options.database,this.now().toISOString());}
  close():void {this.chain?.close();this.history.close();this.db.close();}
}
function readStatus(db:DatabaseSync,path:string,now:string):WalletProfileStatus {
  const meta=Object.fromEntries(db.prepare('SELECT key,value FROM wp_meta').all().map(r=>[String(r.key),String(r.value)]));
  const groupCounts:WalletProfileStatus['groupCounts']={};for(const row of db.prepare('SELECT group_id,count(*) AS n FROM wp_groups GROUP BY group_id').all())groupCounts[row.group_id as WalletProfileGroupId]=Number(row.n);
  const roles=db.prepare('SELECT COUNT(role_computed_at) AS n,MAX(role_computed_at) AS latest,COUNT(*)-COUNT(role_computed_at) AS pending FROM wp_profiles').get()!;
  return {ready:true,profiles:Number(db.prepare('SELECT count(*) AS n FROM wp_profiles').get()!.n),sourceWallets:Number(meta.source_wallets||0),
    roleProfiles:Number(roles.n),rolePending:Number(roles.pending),roleLastRunAt:roles.latest?String(roles.latest):undefined,
    profiledSourceWallets:Number(db.prepare('SELECT count(*) AS n FROM wp_profiles WHERE source_wallet=1').get()!.n),initialComplete:meta.initial_complete==='1',processed:Number(meta.processed||0),
    lastRunAt:meta.last_run_at||undefined,groupCounts,bytes:filesBytes(path,db),maxBytes:Number(meta.max_bytes||0),capacityReached:meta.error===CAPACITY,error:meta.error||undefined,sampleOnly:true,
    staleProfiles:Number(db.prepare('SELECT count(*) AS n FROM wp_profiles WHERE fresh_until<=?').get(now)!.n)};
}
/** The web process reads only this compact derived database, never the full research graph. */
export class WalletProfileReader {
  private db?:DatabaseSync;
  constructor(private readonly database:string,private readonly now:()=>Date=()=>new Date()){}
  private open():DatabaseSync|undefined {
    if(this.db)return this.db;if(!existsSync(this.database))return;
    try {const db=new DatabaseSync(this.database,{readOnly:true});db.exec('PRAGMA busy_timeout=500; PRAGMA query_only=ON');
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wp_profiles'").get()){db.close();return;}this.db=db;return db;
    }catch{return;}
  }
  status():WalletProfileStatus {const db=this.open();return db?readStatus(db,this.database,this.now().toISOString()):emptyStatus();}
  /** The cohort is local sampled public wallets, never a global profit leaderboard. */
  profitCohort(chain:Chain,now=new Date()):number[] {
    const db=this.open();if(!db)return [];
    return db.prepare(`SELECT json_extract(p.data,'$.chain') AS chain,json_extract(p.data,'$.metrics.vendorProfit') AS profit
      FROM wp_groups g INDEXED BY wp_groups_filter CROSS JOIN wp_profiles p ON p.chain=g.chain AND p.address=g.address
      WHERE g.group_id='public_kol' AND g.chain=? ORDER BY p.computed_at DESC LIMIT 2000`).all(chain).flatMap(row=>{
      const v=parse(row.profit) as WalletProfile['metrics']['vendorProfit'],n=Number(v?.realizedProfitUsd);
      return row.chain===chain&&v?.verification==='vendor_claim'&&v.period==='7d'&&Number.isFinite(n)&&n>0&&
        stamp(v.snapshotAt)&&stamp(v.observedAt)&&v.snapshotAt<=v.observedAt&&Date.parse(v.observedAt)<=now.getTime()&&
        now.getTime()-Date.parse(v.snapshotAt)<=86_400_000?[n]:[];
    });
  }
  private profile(data:unknown):WalletProfile {const profile=parse(data) as WalletProfile;if(profile.freshUntil<=this.now().toISOString())profile.status='stale';return profile;}
  list(options:WalletProfileListOptions={}):{ready:boolean;items:WalletProfile[];total:number} {
    const db=this.open();if(!db)return {ready:false,items:[],total:0};const where:string[]=[],args:(string|number)[]=[];
    if(options.chain){where.push('p.chain=?');args.push(options.chain);}if(options.group){where.push('EXISTS(SELECT 1 FROM wp_groups g WHERE g.chain=p.chain AND g.address=p.address AND g.group_id=?)');args.push(options.group);}
    if(options.search){where.push('instr(lower(p.address),?)>0');args.push(String(options.search).toLowerCase().slice(0,160));}
    const sql=where.length?' WHERE '+where.join(' AND '):'',limit=bounded(options.limit,50,200),offset=typeof options.offset==='number'&&Number.isSafeInteger(options.offset)?Math.max(0,options.offset):0;
    const total=Number(db.prepare('SELECT count(*) AS n FROM wp_profiles p'+sql).get(...args)!.n);
    const rows=db.prepare('SELECT p.data FROM wp_profiles p'+sql+' ORDER BY p.computed_at DESC,p.chain,p.address LIMIT ? OFFSET ?').all(...args,limit,offset);
    return {ready:true,items:rows.map(row=>this.profile(row.data)),total};
  }
  get(chain:Chain,address:string):WalletProfile|undefined {const db=this.open(),wallet=chainAddress(chain,address);if(!db||!wallet)return;const row=db.prepare('SELECT data FROM wp_profiles WHERE chain=? AND address=?').get(chain,wallet);if(!row)return;
    return {...this.profile(row.data),changes:db.prepare('SELECT data FROM wp_changes WHERE chain=? AND address=? ORDER BY id DESC LIMIT 20').all(chain,wallet).map(r=>parse(r.data))};}
  getMany(targets:{chain:Chain;address:string}[]):WalletProfile[]{const db=this.open();if(!db)return [];const statement=db.prepare('SELECT data FROM wp_profiles WHERE chain=? AND address=?');return targets.slice(0,200).flatMap(t=>{const wallet=chainAddress(t.chain,t.address);if(!wallet)return [];const row=statement.get(t.chain,wallet);return row?[this.profile(row.data)]:[];});}
  close():void {this.db?.close();this.db=undefined;}
}
