import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import type {Chain} from './types.js';
import type {WalletTradeObservation,WalletFundingEdge} from './wallet-history.js';

export interface AssociationEvent {
  eventId:string;wallet:string;txHash:string;eventAt:string;observedAt:string;source:string;
}
export interface AssociationEpisode {
  tokenAddress:string;leaderBuy:AssociationEvent;candidateBuy:AssociationEvent;leadSeconds:number;
  firstDiscoveredAt:string;updatedAt:string;observationMode:'prospective'|'retrospective';forwardValidated:boolean;
  leaderPublicObservedAt:string;leaderPublicSource:'gmgn_kol_feed';candidateSellAfterLeader?:AssociationEvent;
}
export interface AssociationFundingEvidence {
  kind:'direct'|'common';address:string;observedAt:string;edges:WalletFundingEdge[];verification:'vendor_claim';
}
export interface WalletAssociationSummary {
  chain:Chain;leader:string;candidate:string;firstDiscoveredAt:string;updatedAt:string;
  distinctTokens:number;prospectiveTokens:number;retrospectiveTokens:number;forwardValidatedTokens:number;
  exitAfterLeaderTokens:number;medianLeadSeconds:number;fundingKinds:('direct'|'common')[];
  grade:'timing_only'|'repeated_timing'|'funding_supported';candidatePublic:boolean;
  verification:'vendor_claim';ownership:'unknown';status:'current'|'stale';
}
export interface WalletAssociationDetail {
  association:WalletAssociationSummary;episodes:AssociationEpisode[];fundingEvidence:AssociationFundingEvidence[];
  coverage:{sampleOnly:true;firstObservedBuy:true;leadWindowSeconds:86400;candidateEventLimit:400;
    candidateWalletLimit:40;episodeDisplayLimit:100;conflictingTimestampsExcluded:true;ownership:'unknown';exactRealizedPnl:false;
    prospectiveDefinition:'candidate_observed_before_leader_trade';forwardDefinition:'relation_known_before_candidate_trade_and_candidate_observed_before_leader_trade'};
}
export interface WalletAssociationTarget {
  chain:Chain;address:string;anchorWallet:string;anchorEventAt:string;anchorObservedAt:string;candidateWallet?:string;historicalRelationship?:boolean;
}
export interface WalletAssociationStats {
  anchors:number;relations:number;episodes:number;pending:number;indexedObservations:number;backfillPending:boolean;
  lastRefreshedAt?:string;sampleOnly:true;ownership:'unknown';tradingEnabled:false;
}
export interface WalletAssociationListOptions {chain?:Chain;search?:string;limit?:number;offset?:number;}

type Row=Record<string,any>;
type Write=(evidence:unknown,fn:()=>unknown)=>void;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LEAD_SECONDS=86400;
const event=(row:Row):AssociationEvent=>{const data=JSON.parse(String(row.data)) as WalletTradeObservation;return {
  eventId:String(row.id),wallet:String(row.wallet),txHash:String(row.tx_hash),eventAt:String(row.event_at),observedAt:String(row.observed_at),source:data.source};};
const coverage:WalletAssociationDetail['coverage']={sampleOnly:true,firstObservedBuy:true,leadWindowSeconds:86400,
  candidateEventLimit:400,candidateWalletLimit:40,episodeDisplayLimit:100,conflictingTimestampsExcluded:true,ownership:'unknown',exactRealizedPnl:false,
  prospectiveDefinition:'candidate_observed_before_leader_trade',forwardDefinition:'relation_known_before_candidate_trade_and_candidate_observed_before_leader_trade'};

/** Derived, bounded research indexes. No identity assertion, PnL reconstruction or trading permission. */
export class WalletAssociations {
  constructor(private readonly db:DatabaseSync,private readonly write:Write,private readonly now:()=>Date) {
    db.exec(`CREATE TABLE IF NOT EXISTS wh_assoc_anchors(chain TEXT,leader TEXT,token_address TEXT,public_observed_at TEXT,
      dirty INTEGER DEFAULT 1,checked_at TEXT,collection_checked_at TEXT,PRIMARY KEY(chain,leader,token_address));
      CREATE TABLE IF NOT EXISTS wh_assoc_relations(chain TEXT,leader TEXT,candidate TEXT,first_at TEXT,updated_at TEXT,
        token_count INTEGER DEFAULT 0,forward_count INTEGER DEFAULT 0,funding_count INTEGER DEFAULT 0,dirty INTEGER DEFAULT 1,data TEXT NOT NULL,funding_data TEXT NOT NULL,active_since TEXT,collection_checked_at TEXT,
        PRIMARY KEY(chain,leader,candidate));
      CREATE TABLE IF NOT EXISTS wh_assoc_episodes(id TEXT PRIMARY KEY,chain TEXT,leader TEXT,candidate TEXT,token_address TEXT,
        first_at TEXT,updated_at TEXT,active INTEGER,prospective INTEGER,forward_validated INTEGER,exited INTEGER,lead_seconds REAL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS wh_assoc_anchor_dirty ON wh_assoc_anchors(dirty,checked_at);
      CREATE INDEX IF NOT EXISTS wh_assoc_anchor_token ON wh_assoc_anchors(chain,token_address);
      CREATE INDEX IF NOT EXISTS wh_assoc_relation_rank ON wh_assoc_relations(token_count DESC,funding_count DESC,forward_count DESC);
      CREATE INDEX IF NOT EXISTS wh_assoc_relation_candidate ON wh_assoc_relations(chain,candidate);
      CREATE INDEX IF NOT EXISTS wh_assoc_episode_pair ON wh_assoc_episodes(chain,leader,candidate,active,updated_at DESC);
      CREATE INDEX IF NOT EXISTS wh_assoc_episode_anchor ON wh_assoc_episodes(chain,leader,token_address,active);
      CREATE INDEX IF NOT EXISTS wh_assoc_episode_token ON wh_assoc_episodes(chain,token_address,active,leader,candidate);
      CREATE INDEX IF NOT EXISTS wh_assoc_episode_candidate ON wh_assoc_episodes(chain,candidate,active,leader,token_address);
      CREATE INDEX IF NOT EXISTS wh_assoc_source_index ON wh_observations(source,kind);
      CREATE INDEX IF NOT EXISTS wh_assoc_wallet_buy ON wh_events(chain,wallet,token_address,side,event_at);
      CREATE INDEX IF NOT EXISTS wh_assoc_funding_latest ON wh_funding(chain,wallet,snapshot_at DESC,observed_at DESC);
      INSERT OR IGNORE INTO wh_meta VALUES ('association_cursor','0');
      INSERT OR IGNORE INTO wh_meta VALUES ('association_indexed_count','0');
      INSERT OR IGNORE INTO wh_meta VALUES ('association_refreshed_at','');`);
    if(!db.prepare('PRAGMA table_info(wh_assoc_relations)').all().some(row=>row.name==='active_since'))
      db.exec('ALTER TABLE wh_assoc_relations ADD COLUMN active_since TEXT; UPDATE wh_assoc_relations SET active_since=first_at WHERE token_count>0');
    if(!db.prepare('PRAGMA table_info(wh_assoc_relations)').all().some(row=>row.name==='collection_checked_at'))
      db.exec('ALTER TABLE wh_assoc_relations ADD COLUMN collection_checked_at TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS wh_assoc_relation_collection ON wh_assoc_relations(chain,collection_checked_at)');
  }

  recordTrade(value:WalletTradeObservation):void {
    if(value.side==='buy'&&value.source==='gmgn_kol_feed') {
      const alreadyPublic=!!this.db.prepare('SELECT 1 FROM wh_assoc_anchors WHERE chain=? AND leader=? LIMIT 1').get(value.chain,value.wallet);
      this.db.prepare(`INSERT INTO wh_assoc_anchors(chain,leader,token_address,public_observed_at)
        VALUES (?,?,?,?) ON CONFLICT(chain,leader,token_address) DO UPDATE SET public_observed_at=MIN(public_observed_at,excluded.public_observed_at),dirty=1`)
        .run(value.chain,value.wallet,value.tokenAddress,value.observedAt);
      if(!alreadyPublic) {
        this.db.prepare(`UPDATE wh_assoc_anchors SET dirty=1 WHERE chain=? AND (leader,token_address) IN
          (SELECT leader,token_address FROM wh_assoc_episodes WHERE chain=? AND candidate=? AND active=1)`).run(value.chain,value.chain,value.wallet);
        this.db.prepare('UPDATE wh_assoc_relations SET dirty=1 WHERE chain=? AND candidate=?').run(value.chain,value.wallet);
      }
    }
    this.db.prepare('UPDATE wh_assoc_anchors SET dirty=1 WHERE chain=? AND token_address=?').run(value.chain,value.tokenAddress);
    this.db.prepare(`UPDATE wh_assoc_relations SET dirty=1 WHERE chain=? AND (leader,candidate) IN
      (SELECT leader,candidate FROM wh_assoc_episodes WHERE chain=? AND token_address=? AND active=1)`).run(value.chain,value.chain,value.tokenAddress);
  }
  fundingChanged(chain:Chain,wallet:string):void {
    this.fundingChangedMany([{chain,wallet}]);
  }
  fundingChangedMany(changes:Iterable<{chain:Chain;wallet:string}>):void {
    for(const [chain,wallets] of this.group(changes,'wallet')) {
      const values=JSON.stringify(wallets);
      this.db.prepare(`UPDATE wh_assoc_anchors SET dirty=1 WHERE rowid IN (
        SELECT a.rowid FROM json_each(?) w JOIN wh_assoc_anchors a ON a.chain=? AND a.leader=w.value
        UNION SELECT a.rowid FROM json_each(?) w JOIN wh_assoc_episodes e INDEXED BY wh_assoc_episode_candidate
          ON e.chain=? AND e.candidate=w.value AND e.active=1
          JOIN wh_assoc_anchors a ON a.chain=e.chain AND a.leader=e.leader AND a.token_address=e.token_address)`).run(values,chain,values,chain);
      this.db.prepare(`UPDATE wh_assoc_relations SET dirty=1 WHERE rowid IN (
        SELECT r.rowid FROM json_each(?) w JOIN wh_assoc_relations r ON r.chain=? AND r.leader=w.value
        UNION SELECT r.rowid FROM json_each(?) w JOIN wh_assoc_relations r INDEXED BY wh_assoc_relation_candidate
          ON r.chain=? AND r.candidate=w.value)`).run(values,chain,values,chain);
    }
  }

  /** A rare service reclassification invalidates cached clues for every recipient; no evidence is erased. */
  publicServiceChanged(chain:Chain,funder:string):void {
    this.publicServiceChangedMany([{chain,funder}]);
  }
  publicServiceChangedMany(changes:Iterable<{chain:Chain;funder:string}>):void {
    for(const [chain,funders] of this.group(changes,'funder')) {
      const values=JSON.stringify(funders);
      const recipients=`SELECT f.wallet FROM wh_funding f INDEXED BY wh_funding_address
        JOIN json_each(?) s ON s.value=f.funding_address WHERE f.chain=?`;
      this.db.prepare(`WITH recipients(wallet) AS (${recipients}) UPDATE wh_assoc_relations SET dirty=1 WHERE rowid IN (
        SELECT r.rowid FROM recipients w JOIN wh_assoc_relations r ON r.chain=? AND r.leader=w.wallet
        UNION SELECT r.rowid FROM recipients w JOIN wh_assoc_relations r INDEXED BY wh_assoc_relation_candidate
          ON r.chain=? AND r.candidate=w.wallet)`).run(values,chain,chain,chain);
      this.db.prepare(`WITH recipients(wallet) AS (${recipients}) UPDATE wh_assoc_anchors SET dirty=1 WHERE rowid IN (
        SELECT a.rowid FROM recipients w JOIN wh_assoc_anchors a ON a.chain=? AND a.leader=w.wallet
        UNION SELECT a.rowid FROM recipients w JOIN wh_assoc_episodes e INDEXED BY wh_assoc_episode_candidate
          ON e.chain=? AND e.candidate=w.wallet AND e.active=1
          JOIN wh_assoc_anchors a ON a.chain=e.chain AND a.leader=e.leader AND a.token_address=e.token_address)`).run(values,chain,chain,chain);
    }
  }

  refresh(limit=3):void {
    const n=Number.isSafeInteger(limit)?Math.max(1,Math.min(5,limit)):3;
    const cursor=Number(this.db.prepare("SELECT value FROM wh_meta WHERE key='association_cursor'").get()?.value??0);
    // Only the indexed KOL source is scanned; existing raw history is never rewritten.
    const indexed=this.db.prepare(`SELECT rowid,data FROM wh_observations WHERE source='gmgn_kol_feed' AND kind='trade' AND rowid>? ORDER BY rowid LIMIT 200`).all(cursor);
    if(indexed.length) this.write(indexed.map(row=>row.rowid),()=>{
      for(const row of indexed) this.recordTrade(JSON.parse(String(row.data)) as WalletTradeObservation);
      this.db.prepare("UPDATE wh_meta SET value=? WHERE key='association_cursor'").run(String(indexed.at(-1)!.rowid));
      this.db.prepare("UPDATE wh_meta SET value=CAST(value AS INTEGER)+? WHERE key='association_indexed_count'").run(indexed.length);
    });
    const anchors=this.db.prepare(`SELECT * FROM wh_assoc_anchors WHERE dirty=1 ORDER BY COALESCE(checked_at,''),public_observed_at,chain,leader,token_address LIMIT ?`).all(n);
    for(const anchor of anchors) this.refreshAnchor(anchor);
  }

  list(options:WalletAssociationListOptions={}):{items:WalletAssociationSummary[];total:number} {
    const clauses=['r.token_count>0'],args:string[]=[];
    if(options.chain) {clauses.push('r.chain=?');args.push(options.chain);}
    if(options.search) {clauses.push('(instr(lower(r.leader),?)>0 OR instr(lower(r.candidate),?)>0)');const value=String(options.search).toLowerCase().slice(0,160);args.push(value,value);}
    const where=clauses.join(' AND '),limit=Number.isSafeInteger(options.limit)?Math.max(1,Math.min(100,options.limit!)):25,
      offset=Number.isSafeInteger(options.offset)?Math.max(0,options.offset!):0;
    const total=Number(this.db.prepare(`SELECT COUNT(*) AS n FROM wh_assoc_relations r WHERE ${where}`).get(...args)!.n);
    const rows=this.db.prepare(`SELECT r.* FROM wh_assoc_relations r WHERE ${where} ORDER BY r.token_count DESC,r.funding_count DESC,r.forward_count DESC,r.updated_at DESC,r.leader,r.candidate LIMIT ? OFFSET ?`).all(...args,limit,offset);
    return {items:rows.map(row=>this.summary(row)),total};
  }
  detail(chain:Chain,leader:string,candidate:string):WalletAssociationDetail|undefined {
    const row=this.db.prepare('SELECT * FROM wh_assoc_relations WHERE chain=? AND leader=? AND candidate=? AND token_count>0').get(chain,leader,candidate);if(!row) return;
    return {association:this.summary(row),episodes:this.db.prepare('SELECT data FROM wh_assoc_episodes WHERE chain=? AND leader=? AND candidate=? AND active=1 ORDER BY updated_at DESC LIMIT 100')
      .all(chain,leader,candidate).map(item=>JSON.parse(String(item.data))),fundingEvidence:JSON.parse(String(row.funding_data)),coverage};
  }
  stats():WalletAssociationStats {
    const n=(sql:string)=>Number(this.db.prepare(sql).get()!.n),cursor=Number(this.db.prepare("SELECT value FROM wh_meta WHERE key='association_cursor'").get()?.value??0),
      stamp=String(this.db.prepare("SELECT value FROM wh_meta WHERE key='association_refreshed_at'").get()?.value??'');
    return {anchors:n('SELECT COUNT(*) AS n FROM wh_assoc_anchors'),relations:n('SELECT COUNT(*) AS n FROM wh_assoc_relations WHERE token_count>0'),
      episodes:n('SELECT COUNT(*) AS n FROM wh_assoc_episodes WHERE active=1'),pending:n('SELECT COUNT(*) AS n FROM wh_assoc_anchors WHERE dirty=1'),
      indexedObservations:Number(this.db.prepare("SELECT value FROM wh_meta WHERE key='association_indexed_count'").get()?.value??0),backfillPending:!!this.db.prepare("SELECT 1 FROM wh_observations WHERE source='gmgn_kol_feed' AND kind='trade' AND rowid>? LIMIT 1").get(cursor),
      lastRefreshedAt:stamp||undefined,sampleOnly:true,ownership:'unknown',tradingEnabled:false};
  }
  targets(chain:Chain,limit=5,mode:'recent'|'known'='recent'):WalletAssociationTarget[] {
    const n=Number.isSafeInteger(limit)?Math.max(1,Math.min(20,limit)):5;
    if(mode==='known') return this.knownTargets(chain,n);
    const rows=this.db.prepare(`SELECT a.*,e.event_at,e.observed_at FROM wh_assoc_anchors a JOIN wh_events e ON e.id=(SELECT id FROM wh_events
        WHERE chain=a.chain AND wallet=a.leader AND token_address=a.token_address AND side='buy' ORDER BY event_at,id LIMIT 1)
      WHERE a.chain=? AND e.event_at>=? AND e.event_at<=? ORDER BY COALESCE(a.collection_checked_at,''),a.public_observed_at DESC,a.leader,a.token_address LIMIT ?`).all(chain,new Date(this.now().getTime()-LEAD_SECONDS*1000).toISOString(),this.now().toISOString(),n).map(row=>{
        const candidate=this.db.prepare(`SELECT candidate FROM wh_assoc_episodes WHERE chain=? AND leader=? AND token_address=? AND active=1 ORDER BY first_at DESC LIMIT 1`).get(chain,row.leader!,row.token_address!);
        return {chain,address:String(row.token_address),anchorWallet:String(row.leader),anchorEventAt:String(row.event_at),anchorObservedAt:String(row.observed_at),candidateWallet:candidate?String(candidate.candidate):undefined};
      });
    return rows.length?rows:this.knownTargets(chain,n);
  }
  private knownTargets(chain:Chain,limit:number):WalletAssociationTarget[] {
    return this.db.prepare(`SELECT r.*,e.token_address,e.data AS episode FROM wh_assoc_relations r JOIN wh_assoc_episodes e ON e.id=(
      SELECT id FROM wh_assoc_episodes WHERE chain=r.chain AND leader=r.leader AND candidate=r.candidate AND active=1 ORDER BY updated_at DESC,id LIMIT 1)
      WHERE r.chain=? AND r.token_count>0 ORDER BY COALESCE(r.collection_checked_at,''),r.token_count DESC,r.funding_count DESC,r.leader,r.candidate LIMIT ?`)
      .all(chain,limit).map(row=>{const episode=JSON.parse(String(row.episode)) as AssociationEpisode;return {chain,address:String(row.token_address),
        anchorWallet:String(row.leader),candidateWallet:String(row.candidate),anchorEventAt:episode.leaderBuy.eventAt,anchorObservedAt:episode.leaderBuy.observedAt,historicalRelationship:true};});
  }
  markTarget(target:Pick<WalletAssociationTarget,'chain'|'address'|'anchorWallet'|'candidateWallet'|'historicalRelationship'>,observedAt:string):void {
    this.write(target,()=>{this.db.prepare(`UPDATE wh_assoc_anchors SET collection_checked_at=MAX(COALESCE(collection_checked_at,?),?) WHERE chain=? AND leader=? AND token_address=?`)
      .run(observedAt,observedAt,target.chain,target.anchorWallet,target.address);
      if(target.historicalRelationship&&target.candidateWallet) this.db.prepare('UPDATE wh_assoc_relations SET collection_checked_at=? WHERE chain=? AND leader=? AND candidate=?')
        .run(observedAt,target.chain,target.anchorWallet,target.candidateWallet);
    });
  }

  private refreshAnchor(anchor:Row):void {
    const chain=anchor.chain as Chain,leader=String(anchor.leader),token=String(anchor.token_address),now=this.now().toISOString();
    const leaderRow=this.db.prepare("SELECT * FROM wh_events WHERE chain=? AND wallet=? AND token_address=? AND side='buy' ORDER BY event_at,id LIMIT 1").get(chain,leader,token);
    if(!leaderRow) return;
    const leaderBuy=event(leaderRow),leaderUsable=leaderBuy.eventAt<=now&&leaderBuy.observedAt<=now&&!this.timestampConflict(leaderBuy.eventId,leaderBuy.eventAt);
    const start=new Date(Date.parse(leaderBuy.eventAt)-LEAD_SECONDS*1000).toISOString();
    const candidates=leaderUsable?this.db.prepare(`SELECT e.* FROM wh_events e WHERE e.chain=? AND e.token_address=? AND e.side='buy' AND e.event_at>=? AND e.event_at<?
      AND e.wallet<>? AND e.tx_hash<>? AND NOT EXISTS(SELECT 1 FROM wh_observations o INDEXED BY wh_observations_event WHERE o.event_id=e.id AND o.kind='trade' AND json_extract(o.data,'$.eventAt')<>e.event_at)
      ORDER BY e.event_at,e.id LIMIT 400`).all(chain,token,start,leaderBuy.eventAt,leader,leaderBuy.txHash):[];
    const byWallet=new Map<string,Row>();for(const row of candidates) {if(!byWallet.has(String(row.wallet))&&byWallet.size<40) byWallet.set(String(row.wallet),row);}
    const priorCandidates=this.db.prepare('SELECT DISTINCT candidate FROM wh_assoc_episodes WHERE chain=? AND leader=? AND token_address=? AND active=1 LIMIT 40').all(chain,leader,token).map(row=>String(row.candidate));
    this.write([...byWallet.keys()],()=>{
      // Keep superseded evidence on disk; only the active derived view changes when an earlier leader trade is discovered.
      this.db.prepare('UPDATE wh_assoc_episodes SET active=0 WHERE chain=? AND leader=? AND token_address=? AND active=1').run(chain,leader,token);
      for(const [candidate,row] of byWallet) {
        const candidateBuy=event(row);if(candidateBuy.eventAt>now||candidateBuy.observedAt>now) continue;
        const id=hash([chain,leader,candidate,token,leaderBuy.eventId,candidateBuy.eventId]);
        const previous=this.db.prepare('SELECT first_at FROM wh_assoc_episodes WHERE id=?').get(id);
        const relation=this.db.prepare('SELECT first_at,token_count,active_since FROM wh_assoc_relations WHERE chain=? AND leader=? AND candidate=?').get(chain,leader,candidate);
        const sell=this.db.prepare(`SELECT e.* FROM wh_events e WHERE e.chain=? AND e.wallet=? AND e.token_address=? AND e.side='sell' AND e.event_at>? AND e.event_at<=?
          AND e.observed_at<=? AND e.tx_hash<>? AND e.tx_hash<>?
          AND NOT EXISTS(SELECT 1 FROM wh_observations o INDEXED BY wh_observations_event WHERE o.event_id=e.id AND o.kind='trade' AND json_extract(o.data,'$.eventAt')<>e.event_at)
          ORDER BY e.event_at,e.id LIMIT 1`).get(chain,candidate,token,leaderBuy.eventAt,
            new Date(Math.min(Date.parse(now),Date.parse(leaderBuy.eventAt)+LEAD_SECONDS*1000)).toISOString(),now,leaderBuy.txHash,candidateBuy.txHash);
        const prospective=candidateBuy.observedAt<leaderBuy.eventAt;
        const forward=prospective&&!!relation&&Number(relation.token_count)>0&&!!relation.active_since&&String(relation.active_since)<candidateBuy.eventAt;
        const episode:AssociationEpisode={tokenAddress:token,leaderBuy,candidateBuy,leadSeconds:(Date.parse(leaderBuy.eventAt)-Date.parse(candidateBuy.eventAt))/1000,
          firstDiscoveredAt:previous?String(previous.first_at):now,updatedAt:now,observationMode:prospective?'prospective':'retrospective',forwardValidated:forward,
          leaderPublicObservedAt:String(anchor.public_observed_at),leaderPublicSource:'gmgn_kol_feed',...(sell?{candidateSellAfterLeader:event(sell)}:{})};
        this.db.prepare(`INSERT INTO wh_assoc_episodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,
          active=1,prospective=excluded.prospective,forward_validated=excluded.forward_validated,exited=excluded.exited,data=excluded.data`)
          .run(id,chain,leader,candidate,token,episode.firstDiscoveredAt,now,1,prospective?1:0,forward?1:0,sell?1:0,episode.leadSeconds,JSON.stringify(episode));
      }
      this.db.prepare('UPDATE wh_assoc_anchors SET dirty=0,checked_at=? WHERE chain=? AND leader=? AND token_address=?').run(now,chain,leader,token);
      for(const candidate of new Set([...priorCandidates,...byWallet.keys()])) this.refreshRelation(chain,leader,candidate,now);
      this.db.prepare("UPDATE wh_meta SET value=? WHERE key='association_refreshed_at'").run(now);
    });
  }
  private refreshRelation(chain:Chain,leader:string,candidate:string,now:string):void {
    const old=this.db.prepare('SELECT first_at,token_count,active_since FROM wh_assoc_relations WHERE chain=? AND leader=? AND candidate=?').get(chain,leader,candidate);
    const totals=this.db.prepare(`SELECT COUNT(DISTINCT token_address) AS tokens,COALESCE(SUM(prospective),0) AS prospective,
      COALESCE(SUM(forward_validated),0) AS forward,COALESCE(SUM(exited),0) AS exited FROM wh_assoc_episodes WHERE chain=? AND leader=? AND candidate=? AND active=1`).get(chain,leader,candidate)!;
    const leads=this.db.prepare('SELECT lead_seconds FROM wh_assoc_episodes WHERE chain=? AND leader=? AND candidate=? AND active=1 ORDER BY updated_at DESC LIMIT 200')
      .all(chain,leader,candidate).map(row=>Number(row.lead_seconds)).sort((a,b)=>a-b),mid=Math.floor(leads.length/2),median=leads.length?(leads.length%2?leads[mid]:(leads[mid-1]+leads[mid])/2):0;
    const funding=this.funding(chain,leader,candidate),kinds=[...new Set(funding.map(item=>item.kind))];
    const summary:WalletAssociationSummary={chain,leader,candidate,firstDiscoveredAt:old?String(old.first_at):now,updatedAt:now,distinctTokens:Number(totals.tokens),
      prospectiveTokens:Number(totals.prospective),retrospectiveTokens:Number(totals.tokens)-Number(totals.prospective),forwardValidatedTokens:Number(totals.forward),
      exitAfterLeaderTokens:Number(totals.exited),medianLeadSeconds:median,fundingKinds:kinds,grade:funding.length?'funding_supported':Number(totals.tokens)>=2?'repeated_timing':'timing_only',
      candidatePublic:!!this.db.prepare('SELECT 1 FROM wh_assoc_anchors WHERE chain=? AND leader=? LIMIT 1').get(chain,candidate),verification:'vendor_claim',ownership:'unknown',status:'current'};
    const dirty=!!this.db.prepare(`SELECT 1 FROM wh_assoc_episodes e JOIN wh_assoc_anchors a ON a.chain=e.chain AND a.leader=e.leader AND a.token_address=e.token_address
      WHERE e.chain=? AND e.leader=? AND e.candidate=? AND e.active=1 AND a.dirty=1 LIMIT 1`).get(chain,leader,candidate);
    const activeSince=summary.distinctTokens>0?(old&&Number(old.token_count)>0&&old.active_since?String(old.active_since):now):null;
    this.db.prepare(`INSERT INTO wh_assoc_relations(chain,leader,candidate,first_at,updated_at,token_count,forward_count,funding_count,dirty,data,funding_data,active_since) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain,leader,candidate) DO UPDATE SET updated_at=excluded.updated_at,
      token_count=excluded.token_count,forward_count=excluded.forward_count,funding_count=excluded.funding_count,dirty=excluded.dirty,data=excluded.data,funding_data=excluded.funding_data,active_since=excluded.active_since`)
      .run(chain,leader,candidate,summary.firstDiscoveredAt,now,summary.distinctTokens,summary.forwardValidatedTokens,funding.length,dirty?1:0,JSON.stringify(summary),JSON.stringify(funding),activeSince);
  }
  private funding(chain:Chain,leader:string,candidate:string):AssociationFundingEvidence[] {
    const latest=(wallet:string):WalletFundingEdge[]=>{
      const rows=this.db.prepare('SELECT * FROM wh_funding WHERE chain=? AND wallet=? ORDER BY snapshot_at DESC,observed_at DESC,conflict DESC LIMIT 40').all(chain,wallet),seen=new Set<string>();
      // A later conflicting origin snapshot cannot leave an older different-origin claim in force.
      if(rows.length&&Number(rows[0].conflict)) return [];
      return rows.flatMap(row=>{
        const address=String(row.funding_address);if(seen.has(address)) return [];seen.add(address);
        if(Number(row.shared)||Number(row.conflict)||this.db.prepare('SELECT 1 FROM wh_funding WHERE chain=? AND funding_address=? AND shared=1 LIMIT 1').get(chain,address)) return [];
        const profile=this.db.prepare('SELECT profile FROM wh_wallets WHERE chain=? AND address=?').get(chain,address);
        if(profile&&JSON.parse(String(profile.profile)).labels.some((label:string)=>['exchange_or_pool','exchange','pool','router','bridge','cex'].includes(label))) return [];
        const edge=JSON.parse(String(row.data)) as WalletFundingEdge;
        if(edge.observedAt>this.now().toISOString()||edge.snapshotAt&&edge.snapshotAt>edge.observedAt||edge.eventAt&&edge.eventAt>(edge.snapshotAt??edge.observedAt)) return [];
        return [edge];
      });
    };
    const a=latest(leader),b=latest(candidate),result:AssociationFundingEvidence[]=[];
    for(const edge of a) if(edge.fundingAddress===candidate) result.push({kind:'direct',address:candidate,observedAt:edge.observedAt,edges:[edge],verification:'vendor_claim'});
    for(const edge of b) if(edge.fundingAddress===leader) result.push({kind:'direct',address:leader,observedAt:edge.observedAt,edges:[edge],verification:'vendor_claim'});
    for(const x of a) for(const y of b) if(x.fundingAddress===y.fundingAddress&&x.fundingAddress!==leader&&x.fundingAddress!==candidate)
      result.push({kind:'common',address:x.fundingAddress,observedAt:x.observedAt>y.observedAt?x.observedAt:y.observedAt,edges:[x,y],verification:'vendor_claim'});
    return result.slice(0,10);
  }
  private timestampConflict(id:string,eventAt:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM wh_observations INDEXED BY wh_observations_event WHERE event_id=? AND kind='trade' AND json_extract(data,'$.eventAt')<>? LIMIT 1").get(id,eventAt);
  }
  private group<K extends 'wallet'|'funder'>(changes:Iterable<{chain:Chain}&Record<K,string>>,key:K):Map<Chain,string[]> {
    const grouped=new Map<Chain,Set<string>>();
    for(const change of changes) {const values=grouped.get(change.chain)??new Set<string>();values.add(change[key]);grouped.set(change.chain,values);}
    return new Map([...grouped].map(([chain,values])=>[chain,[...values]]));
  }
  private summary(row:Row):WalletAssociationSummary {return {...JSON.parse(String(row.data)),status:Number(row.dirty)?'stale':'current'};}
}
