import type {DatabaseSync} from 'node:sqlite';
import type {ScanArchiveStats} from './scan-archive.js';
import {readStrategyObservationSummary} from './strategy-observation.js';

export const SCAN_ARCHIVE_AGGREGATE_SQL=`SELECT count(*) AS total,
  SUM(eligible_at IS NOT NULL) AS eligible,
  SUM(eligible_at IS NOT NULL AND performance_status<>'ended') AS tracking,
  SUM(eligible_at>? AND eligible_at<=?) AS window_tracking,
  MAX(max_gain_pct) AS gain,
  SUM(status='processing') AS processing,SUM(status='completed') AS completed,
  SUM(status='interrupted') AS interrupted,SUM(decision='BUY_CANDIDATE') AS buy_candidate,
  SUM(decision='WATCH') AS watch,SUM(decision='REJECT') AS reject,SUM(decision IS NULL) AS pending
  FROM scan_summaries INDEXED BY scan_summaries_stats_cover`;

export interface ScanArchiveOverviewStats {
  total:number;eligible:number;tracking:number;maxGainPct?:number;computedAt:string;
}

export interface ScanArchiveStatsValues {
  stats:ScanArchiveStats;
  overview:ScanArchiveOverviewStats;
}

/** One narrow covering-index pass shared by both dashboard summaries. */
export function readScanArchiveStats(db:DatabaseSync,now:Date,trackingMs:number):ScanArchiveStatsValues {
  const nowIso=now.toISOString(),cutoff=new Date(now.getTime()-trackingMs).toISOString();
  const row=db.prepare(SCAN_ARCHIVE_AGGREGATE_SQL).get(cutoff,nowIso)!;
  const total=Number(row.total),eligible=Number(row.eligible??0),gain=typeof row.gain==='number'&&Number.isFinite(row.gain)?row.gain:undefined;
  const stats:ScanArchiveStats={total,eligible,tracking:Number(row.tracking??0),
    ...(gain===undefined?{}:{maxGainPct:gain}),
    byStatus:{processing:Number(row.processing??0),completed:Number(row.completed??0),interrupted:Number(row.interrupted??0)},
    byDecision:{BUY_CANDIDATE:Number(row.buy_candidate??0),WATCH:Number(row.watch??0),REJECT:Number(row.reject??0),PENDING:Number(row.pending??0)},
    comparison:readStrategyObservationSummary(db,now)};
  const overview:ScanArchiveOverviewStats={total,eligible,tracking:Number(row.window_tracking??0),
    ...(gain===undefined?{}:{maxGainPct:gain}),computedAt:nowIso};
  return {stats,overview};
}
