import {DatabaseSync} from 'node:sqlite';

export interface ResearchWalOptions {
  busyTimeoutMs:number;
  autoCheckpointPages:number;
  journalSizeLimitBytes?:number;
}

/** Research evidence never authorizes an order. WAL/NORMAL keeps transactions
 * atomic while avoiding a filesystem barrier on every hot-path commit. */
export function configureResearchWal(db:DatabaseSync,options:ResearchWalOptions):void {
  const {busyTimeoutMs,autoCheckpointPages,journalSizeLimitBytes}=options;
  if(!Number.isSafeInteger(busyTimeoutMs)||busyTimeoutMs<0||busyTimeoutMs>5_000||
    !Number.isSafeInteger(autoCheckpointPages)||autoCheckpointPages<1||autoCheckpointPages>100_000||
    journalSizeLimitBytes!==undefined&&(!Number.isSafeInteger(journalSizeLimitBytes)||journalSizeLimitBytes<0))
    throw new Error('RESEARCH_SQLITE_CONFIG_INVALID');
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=${busyTimeoutMs};
    PRAGMA wal_autocheckpoint=${autoCheckpointPages};${journalSizeLimitBytes===undefined?'':` PRAGMA journal_size_limit=${journalSizeLimitBytes};`}`);
  if(Number(db.prepare('PRAGMA synchronous').get()?.synchronous)!==1)throw new Error('RESEARCH_SQLITE_DURABILITY_UNAVAILABLE');
}
