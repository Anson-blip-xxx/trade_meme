import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {validateShadowPolicyCandidate,type ShadowPolicyCandidate} from './shadow-policy-candidate.js';
import {validateNotificationTriggerCandidate,type NotificationTriggerCandidate} from './notification-trigger-candidate.js';

export type StoredShadowPolicyCandidate=ShadowPolicyCandidate|NotificationTriggerCandidate;

/** Immutable research ledger. It exposes no active-policy or execution API. */
export class ShadowPolicyCandidateStore {
  private readonly db:DatabaseSync;
  constructor(path:string){
    if(!path||path.includes('\0'))throw new Error('SHADOW_POLICY_STORE_INVALID');
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1500;
      CREATE TABLE IF NOT EXISTS review_shadow_policy_candidates(
        id TEXT PRIMARY KEY,generated_at TEXT NOT NULL,chain TEXT NOT NULL,scope_key TEXT NOT NULL,
        parameter TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_shadow_policy_latest ON review_shadow_policy_candidates(generated_at DESC,id);
      CREATE INDEX IF NOT EXISTS review_shadow_policy_scope ON review_shadow_policy_candidates(chain,scope_key,parameter,generated_at DESC);
      CREATE TABLE IF NOT EXISTS review_shadow_policy_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  saveAll(candidates:readonly StoredShadowPolicyCandidate[]):number {
    if(!Array.isArray(candidates)||candidates.length>100)throw new Error('SHADOW_POLICY_STORE_INVALID');
    this.db.exec('BEGIN IMMEDIATE');try{
      const insert=this.db.prepare('INSERT OR IGNORE INTO review_shadow_policy_candidates VALUES(?,?,?,?,?,?,?)');let saved=0;
      for(const value of candidates){
        const entry=value.generatorVersion==='daily-shadow-policy-v1';
        if(entry?!validateShadowPolicyCandidate(value):!validateNotificationTriggerCandidate(value as NotificationTriggerCandidate))throw new Error('SHADOW_POLICY_STORE_INVALID');
        const scopeKey=entry?value.scope.basePolicyVersion:`${String(value.scope.source)}:trigger-count-3`;
        saved+=Number(insert.run(value.id,value.generatedAt,value.scope.chain,scopeKey,value.change.parameter,value.status,JSON.stringify(value)).changes);
      }
      if(candidates.length){this.db.prepare("INSERT OR REPLACE INTO review_shadow_policy_meta VALUES('last_generated_at',?)").run(candidates[0].generatedAt);
        this.db.prepare("DELETE FROM review_shadow_policy_meta WHERE key='last_error'").run();}
      this.db.exec('COMMIT');return saved;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  failure(at:string):void {
    if(!Number.isFinite(Date.parse(at)))return;
    this.db.prepare("INSERT OR REPLACE INTO review_shadow_policy_meta VALUES('last_error',?)").run(`SHADOW_POLICY_CANDIDATE_FAILED:${at}`);
  }
  latest(limit=20):{items:StoredShadowPolicyCandidate[];status:Record<string,string>} {
    const take=Number.isInteger(limit)?Math.max(1,Math.min(100,limit)):20;
    const items=this.db.prepare('SELECT data FROM review_shadow_policy_candidates ORDER BY generated_at DESC,id LIMIT ?').all(take)
      .map(row=>JSON.parse(String(row.data)) as StoredShadowPolicyCandidate);
    const status=Object.fromEntries(this.db.prepare('SELECT key,value FROM review_shadow_policy_meta').all().map(row=>[String(row.key),String(row.value)]));
    return {items,status};
  }
  prune(now=new Date()):void {
    this.db.prepare('DELETE FROM review_shadow_policy_candidates WHERE generated_at<?').run(new Date(now.getTime()-180*86400_000).toISOString());
  }
  close():void {this.db.close();}
}
