import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chainAddress} from './chain-stream-store.js';
import {reviewSchedule,reviewWindow,shanghaiDate,type DailyReview,type ReviewExecution,type ReviewItem} from './daily-review.js';
import type {ExitQualityReview} from './exit-quality.js';
import type {Chain,Report} from './types.js';
import type {EntryResult} from './entry.js';
import {VendorPerformanceLedger} from './vendor-performance-ledger.js';
import type {NotificationTriggerOutcome} from './notification-outcomes.js';
import type {StoredShadowPolicyCandidate} from './shadow-policy-candidate-store.js';

export interface ReviewPageOptions {date?:string;runId?:string;chain?:Chain;limit?:number;offset?:number;}
/** Only curated review data and entry outcomes. No raw reports, sessions or signing material. */
export class DailyReviewStore {
  private readonly db:DatabaseSync;
  private readonly vendor:VendorPerformanceLedger;
  private readonly maxItems:number;
  constructor(path:string,options:{maxItems?:number}={}){
    this.maxItems=options.maxItems??50000;
    if(!Number.isInteger(this.maxItems)||this.maxItems<1||this.maxItems>50000)throw new Error('REVIEW_MAX_ITEMS_INVALID');
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1500; PRAGMA max_page_count=131072;
      CREATE TABLE IF NOT EXISTS review_runs(id TEXT PRIMARY KEY,date TEXT NOT NULL,generated_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_runs_date ON review_runs(date DESC,generated_at DESC);
      CREATE TABLE IF NOT EXISTS review_items(run_id TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,rank INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run_id,chain,address));
      CREATE INDEX IF NOT EXISTS review_items_page ON review_items(run_id,rank);
      CREATE INDEX IF NOT EXISTS review_items_chain ON review_items(run_id,chain,rank);
      CREATE TABLE IF NOT EXISTS review_entry_attempts(id TEXT PRIMARY KEY,scan_id TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_entry_token ON review_entry_attempts(chain,address,at);
      CREATE INDEX IF NOT EXISTS review_entry_time ON review_entry_attempts(at);
      CREATE TABLE IF NOT EXISTS review_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_exit_quality(date TEXT PRIMARY KEY,as_of TEXT NOT NULL,data TEXT NOT NULL);`);
    this.vendor=new VendorPerformanceLedger(this.db);
  }
  recordVendor(observation:Parameters<VendorPerformanceLedger['record']>[0]):boolean {return this.vendor.record(observation);}
  recordEntry(report:Report,result:EntryResult,mode:string,at:string):void {
    const chain=report.signal?.token?.chain,address=chainAddress(chain,report.signal?.token?.address);
    if(!address||!['bsc','solana','robinhood'].includes(chain)||!['off','paper','live'].includes(mode)||
      !['skipped','created','existing','blocked'].includes(result.status)||!Number.isFinite(Date.parse(at)))return;
    const scanId=typeof report.id==='string'&&/^[\w-]{1,200}$/.test(report.id)?report.id:undefined;if(!scanId)return;
    const reason=result.reason&&/^[A-Z][A-Z0-9_]{0,99}$/.test(result.reason)?result.reason:undefined;
    const data:ReviewExecution={chain,address,at,mode,status:result.status,reason,scanId,decisionAt:report.evaluatedAt};
    this.db.prepare('INSERT INTO review_entry_attempts VALUES(?,?,?,?,?,?)').run(randomUUID(),scanId,chain,address,at,JSON.stringify(data));
  }
  save(report:DailyReview,beforeCommit?:()=>void):boolean {
    const {items,...summary}=report;
    this.db.exec('BEGIN IMMEDIATE');try{
      const inserted=this.db.prepare('INSERT OR IGNORE INTO review_runs VALUES(?,?,?,?)').run(report.id,report.date,report.generatedAt,JSON.stringify(summary));
      if(!inserted.changes){this.db.exec('COMMIT');return false;}
      if(items.length>this.maxItems)throw new Error('REVIEW_ITEM_LIMIT_EXCEEDED');
      let retained=Number(this.db.prepare('SELECT count(*) n FROM review_items').get()!.n);
      if(retained+items.length>this.maxItems) {
        const oldest=this.db.prepare(`SELECT r.id,count(i.run_id) n FROM review_runs r LEFT JOIN review_items i ON i.run_id=r.id
          WHERE r.id<>? GROUP BY r.id ORDER BY r.generated_at,r.date,r.id`).all(report.id);
        for(const old of oldest){
          if(retained+items.length<=this.maxItems)break;
          this.db.prepare('DELETE FROM review_items WHERE run_id=?').run(old.id);
          this.db.prepare('DELETE FROM review_runs WHERE id=?').run(old.id);
          retained-=Number(old.n);
        }
      }
      const put=this.db.prepare('INSERT INTO review_items VALUES(?,?,?,?,?)');
      items.forEach((item,index)=>put.run(report.id,item.chain,item.address,index,JSON.stringify(item)));
      this.db.prepare("INSERT OR REPLACE INTO review_meta VALUES('last_success_at',?)").run(report.generatedAt);
      this.db.prepare("DELETE FROM review_meta WHERE key='last_error'").run();
      // Delay related file publication until every SQL write succeeds. The file and COMMIT
      // remain separate resources; this narrows the failure window without claiming atomicity.
      beforeCommit?.();
      this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  exists(id:string):boolean {return !!this.db.prepare('SELECT 1 FROM review_runs WHERE id=?').get(id);}
  hasExitQuality(date:string):boolean {reviewWindow(date);return !!this.db.prepare('SELECT 1 FROM review_exit_quality WHERE date=?').get(date);}
  /** Independent daily snapshot: never rewrites an earlier signal report or computes on an HTTP request. */
  saveExitQuality(review:ExitQualityReview):boolean {
    const asOf=new Date(review.asOf),since=Date.parse(review.sinceAt);
    if(!Number.isFinite(asOf.getTime())||!Number.isFinite(since)||since>asOf.getTime()||review.version!=='exit-quality-review-v1'||
      review.scope!=='closed_shadow_positions'||review.cases.length>10||review.reviewed>1000)throw new Error('EXIT_QUALITY_SNAPSHOT_INVALID');
    this.db.exec('BEGIN IMMEDIATE');try{
      const saved=!!this.db.prepare('INSERT OR IGNORE INTO review_exit_quality VALUES(?,?,?)').run(shanghaiDate(asOf),asOf.toISOString(),JSON.stringify(review)).changes;
      this.db.prepare("DELETE FROM review_meta WHERE key='exit_quality_error'").run();
      this.db.prepare("INSERT OR REPLACE INTO review_meta VALUES('exit_quality_attempt_at',?)").run(asOf.toISOString());
      this.db.exec('COMMIT');return saved;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  exitQualityFailure(at:string):void {
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare("INSERT OR REPLACE INTO review_meta VALUES('exit_quality_error','EXIT_QUALITY_REVIEW_FAILED')").run();
      this.db.prepare("INSERT OR REPLACE INTO review_meta VALUES('exit_quality_attempt_at',?)").run(at);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  failure(at:string):void {
    this.db.prepare("INSERT OR REPLACE INTO review_meta VALUES('last_error','DAILY_REVIEW_FAILED')").run();
    this.db.prepare("INSERT OR REPLACE INTO review_meta VALUES('last_attempt_at',?)").run(at);
  }
  markRunSucceeded(at:string):void {
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare("DELETE FROM review_meta WHERE key='last_error'").run();
      this.db.prepare("INSERT OR REPLACE INTO review_meta VALUES('last_attempt_at',?)").run(at);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  prune(now=new Date()):void {
    const cutoff=new Date(now.getTime()-90*86400_000).toISOString();
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare('DELETE FROM review_items WHERE run_id IN (SELECT id FROM review_runs WHERE generated_at<?)').run(cutoff);
      this.db.prepare('DELETE FROM review_runs WHERE generated_at<?').run(cutoff);
      this.db.prepare('DELETE FROM review_entry_attempts WHERE at<?').run(cutoff);
      this.db.prepare('DELETE FROM review_exit_quality WHERE as_of<?').run(cutoff);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Latest complete revision per report date; unknown or incomplete outcomes stay excluded. */
  notificationOutcomes(limit=100000):NotificationTriggerOutcome[] {
    const take=Number.isInteger(limit)?Math.max(1,Math.min(100000,limit)):100000;
    const rows=this.db.prepare(`WITH latest AS (
        SELECT id,date,generated_at,ROW_NUMBER() OVER(PARTITION BY date ORDER BY generated_at DESC,id DESC) position
        ,data FROM review_runs
      ) SELECT i.data FROM review_items i JOIN latest r ON r.id=i.run_id AND r.position=1
        AND json_extract(r.data,'$.datasetComplete')=1
      ORDER BY r.date,i.rank`).all();
    const output:NotificationTriggerOutcome[]=[],seen=new Set<string>();
    for(const row of rows){
      let item:ReviewItem;try{item=JSON.parse(String(row.data)) as ReviewItem;}
      catch{continue;/* Corrupt report evidence is missing, never a negative outcome. */}
      if(!Array.isArray(item.notificationOutcomes))continue;
      for(const outcome of item.notificationOutcomes){
        const identity=[outcome.source,outcome.chain,outcome.address,outcome.sessionFirstReceivedAt,outcome.notificationNumber].join(':');
        if(seen.has(identity))continue;seen.add(identity);output.push(outcome);
        if(output.length>take)throw new Error('REVIEW_NOTIFICATION_OUTCOME_LIMIT_EXCEEDED');
      }
    }
    return output;
  }
  page(options:ReviewPageOptions={},now=new Date()) {
    if(options.date)reviewWindow(options.date);
    const limit=Number.isInteger(options.limit)?Math.max(1,Math.min(100,options.limit!)):20;
    const offset=Number.isInteger(options.offset)?Math.max(0,Math.min(1000000,options.offset!)):0;
    const date=options.date,runId=options.runId;
    const run=runId?this.db.prepare('SELECT * FROM review_runs WHERE id=?').get(runId):date?
      this.db.prepare('SELECT * FROM review_runs WHERE date=? ORDER BY generated_at DESC LIMIT 1').get(date):
      this.db.prepare('SELECT * FROM review_runs ORDER BY date DESC,generated_at DESC LIMIT 1').get();
    const dates=this.db.prepare('SELECT date,MAX(generated_at) generatedAt FROM review_runs GROUP BY date ORDER BY date DESC LIMIT 90').all();
    const status=Object.fromEntries(this.db.prepare('SELECT key,value FROM review_meta').all().map(r=>[r.key,r.value]));
    const quality=this.db.prepare('SELECT data FROM review_exit_quality ORDER BY date DESC LIMIT 1').get();
    const exitQuality=quality?JSON.parse(String(quality.data)) as ExitQualityReview:undefined;
    const hasShadow=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_shadow_policy_candidates'").get();
    const shadowPolicies=hasShadow?{
      items:this.db.prepare(`WITH ranked AS (
        SELECT data,generated_at,id,ROW_NUMBER() OVER(PARTITION BY
          json_extract(data,'$.generatorVersion'),json_extract(data,'$.scope.chain'),
          COALESCE(json_extract(data,'$.scope.source'),''),COALESCE(json_extract(data,'$.scope.basePolicyVersion'),''),
          COALESCE(json_extract(data,'$.scope.decision'),''),COALESCE(json_extract(data,'$.scope.horizonSec'),0),
          json_extract(data,'$.change.parameter') ORDER BY generated_at DESC,id DESC) position
        FROM review_shadow_policy_candidates
        WHERE json_extract(data,'$.generatorVersion') IN ('daily-shadow-policy-v2','notification-trigger-shadow-v2')
      ) SELECT data FROM ranked WHERE position=1 ORDER BY generated_at DESC,id LIMIT 20`).all()
        .flatMap(row=>{try{return [JSON.parse(String(row.data)) as StoredShadowPolicyCandidate];}catch{return [];}}),
      status:Object.fromEntries(this.db.prepare("SELECT key,value FROM review_shadow_policy_meta").all().map(row=>[String(row.key),String(row.value)])),
    }:{items:[] as StoredShadowPolicyCandidate[],status:{}};
    const base={enabled:true,schedule:reviewSchedule(now),dates,status,limit,offset,exitQuality,shadowPolicies};
    if(!run)return {...base,report:undefined,total:0,hasMore:false,items:[] as ReviewItem[]};
    if(date&&run.date!==date)throw new Error('REVIEW_DATE_INVALID');
    const filter=options.chain?' AND chain=?':'',params=options.chain?[String(run.id),options.chain]:[String(run.id)];
    const total=Number(this.db.prepare(`SELECT count(*) n FROM review_items WHERE run_id=?${filter}`).get(...params)!.n);
    const items=this.db.prepare(`SELECT data FROM review_items WHERE run_id=?${filter} ORDER BY rank LIMIT ? OFFSET ?`).all(...params,limit,offset)
      .map(r=>JSON.parse(String(r.data)) as ReviewItem);
    return {...base,report:JSON.parse(String(run.data)) as Omit<DailyReview,'items'>,total,hasMore:offset+items.length<total,items};
  }
  close():void {this.db.close();}
}
