import type {DatabaseSync} from 'node:sqlite';
import type {DebotRepeatEvidence} from './debot-repeat-evidence.js';

export interface DebotRiskPromotionResult {
  checked:number;promoted:number;failed:number;
  reason?:'DEBOT_REPEAT_RISK_REVIEW_UNAVAILABLE'|'DEBOT_REPEAT_RISK_EVIDENCE_UNAVAILABLE';
}

/** Bounded local-only polling of queued repeats, including tasks in ordinary cooldown.
 * A promotion changes queue priority only; the normal analysis and freshness gates still run. */
export function promoteDebotRiskUpdates(db:DatabaseSync,options:{
  now:Date;assess:(row:Record<string,any>,previous:Record<string,any>)=>DebotRepeatEvidence;max?:number;
}):DebotRiskPromotionResult {
  const result:DebotRiskPromotionResult={checked:0,promoted:0,failed:0};
  if(!Number.isFinite(options.now.getTime())||options.max!==undefined&&(!Number.isSafeInteger(options.max)||options.max<0))
    return {...result,failed:1,reason:'DEBOT_REPEAT_RISK_REVIEW_UNAVAILABLE'};
  const limit=Math.min(8,options.max??8);if(!limit)return result;
  const now=options.now.toISOString();
  try {
    const rows=db.prepare(`WITH candidates AS (
      SELECT p.*,p.rowid AS queue_seq,
        ROW_NUMBER() OVER (PARTITION BY p.chain,p.address ORDER BY
          COALESCE(p.risk_checked_at,''),p.observed_at,p.rowid) AS token_position
      FROM debot_signals p WHERE p.state='pending'
        AND EXISTS (SELECT 1 FROM debot_signals a WHERE a.chain=p.chain AND a.address=p.address AND a.analyzed=1)
        AND NOT EXISTS (SELECT 1 FROM debot_signals a WHERE a.chain=p.chain AND a.address=p.address AND a.state='dispatching')
    ) SELECT * FROM candidates WHERE token_position=1
      ORDER BY COALESCE(risk_checked_at,''),observed_at,queue_seq LIMIT ?`).all(limit);
    const previous=db.prepare(`SELECT * FROM debot_signals WHERE chain=? AND address=? AND analyzed=1
      ORDER BY COALESCE(evidence_cutoff_at,dispatched_at,observed_at) DESC,rowid DESC LIMIT 1`);
    const checked=db.prepare("UPDATE debot_signals SET risk_checked_at=? WHERE id=? AND state='pending'");
    const promote=db.prepare("UPDATE debot_signals SET review_priority=100,review_after=NULL WHERE id=? AND state='pending'");
    const normal=db.prepare("UPDATE debot_signals SET review_priority=0 WHERE id=? AND state='pending'");
    for(const row of rows) {
      const prior=previous.get(row.chain!,row.address!);if(!prior)continue;
      if(!checked.run(now,row.id!).changes)continue;
      result.checked++;
      try {
        // No detail requests or snapshot mutation. The callback reads existing scoped wallet evidence.
        const evidence=options.assess(row,prior);
        if(!evidence||typeof evidence.material!=='boolean'||!['normal','wallet','risk'].includes(evidence.priority))
          throw new Error('DEBOT_REPEAT_RISK_EVIDENCE_UNAVAILABLE');
        if(evidence.material&&evidence.priority==='risk')result.promoted+=Number(promote.run(row.id!).changes);
        else normal.run(row.id!);
      }catch {
        // A failed candidate still rotates out and never retains an earlier unconfirmed promotion.
        normal.run(row.id!);result.failed++;result.reason='DEBOT_REPEAT_RISK_EVIDENCE_UNAVAILABLE';
      }
    }
  }catch {result.failed++;result.reason='DEBOT_REPEAT_RISK_REVIEW_UNAVAILABLE';}
  return result;
}
