import {statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import type {TestNotifier} from './types.js';

export interface ControlledTestNotificationsOptions {
  waitMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

function fail(reason: string): never {throw new Error(reason);}

/**
 * Producer only. The existing service remains the sole Telegram sender and owns
 * credentials, delivery retries and acknowledgement. This class never calls TG.
 */
export class ControlledTestNotifications implements TestNotifier {
  private readonly db: DatabaseSync;
  private readonly waitMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly hasMeta: boolean;
  private closed = false;

  constructor(path: string, options: ControlledTestNotificationsOptions = {}) {
    this.waitMs = options.waitMs ?? 15_000;
    if (!Number.isSafeInteger(this.waitMs) || this.waitMs < 0 || this.waitMs > 15_000)
      fail('TEST_TELEGRAM_WAIT_INVALID');
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
    // Never create a parallel notification database or schema by accident.
    try {
      if (!path || path === ':memory:' || path.startsWith('file:') || !statSync(path).isFile())
        fail('TEST_TELEGRAM_DATABASE_UNAVAILABLE');
    } catch {fail('TEST_TELEGRAM_DATABASE_UNAVAILABLE');}
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      db.exec('PRAGMA busy_timeout=500;');
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map(row => String(row.name)));
      if (!tables.has('trade_notification_events') || !tables.has('telegram_outbox')) fail('TEST_TELEGRAM_DATABASE_UNAVAILABLE');
      this.db = db;
      this.hasMeta = tables.has('telegram_meta');
    } catch {
      try {db?.close();} catch { /* Preserve the fixed error below. */ }
      fail('TEST_TELEGRAM_DATABASE_UNAVAILABLE');
    }
  }

  private checkOpen(): void {if (this.closed) fail('TEST_TELEGRAM_NOTIFICATIONS_CLOSED');}
  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) fail('TEST_TELEGRAM_CLOCK_INVALID');
    return now;
  }
  private storage<T>(work: () => T): T {
    this.checkOpen();
    try {return work();}
    catch (error) {
      if (error instanceof Error && /^TEST_TELEGRAM_[A-Z_]+$/.test(error.message)) throw error;
      fail('TEST_TELEGRAM_DATABASE_UNAVAILABLE');
    }
  }

  async notify(key: string, text: string): Promise<void> {
    this.checkOpen();
    if (typeof key !== 'string' || !key.trim() || key.length > 512 || /[\x00-\x1f\x7f]/.test(key))
      fail('TEST_TELEGRAM_EVENT_KEY_INVALID');
    // Reject instead of truncating a trade amount or transaction reference.
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) fail('TEST_TELEGRAM_MESSAGE_LENGTH_INVALID');
    const began = this.clock();
    this.storage(() => {
      this.db.prepare(`INSERT OR IGNORE INTO trade_notification_events(event_key,text,queued,created_at)
        VALUES (?,?,0,?)`).run(key, text, began);
      const existing = this.db.prepare('SELECT text FROM trade_notification_events WHERE event_key=?').get(key);
      if (!existing || existing.text !== text) fail('TEST_TELEGRAM_EVENT_CONFLICT');
    });
    let slept = 0;
    for (;;) {
      const delivered = this.storage(() => {
        const row = this.db.prepare('SELECT state FROM telegram_outbox WHERE key=?').get(key);
        // Acknowledged delivery remains true even if the sender is now blocked.
        if (row?.state === 'sent') return true;
        if (row?.state === 'failed') fail('TEST_TELEGRAM_DELIVERY_FAILED');
        if (row && row.state !== 'pending') fail('TEST_TELEGRAM_DELIVERY_STATE_INVALID');
        if (this.hasMeta && this.db.prepare("SELECT value FROM telegram_meta WHERE key='blocked_config'").get()?.value)
          fail('TEST_TELEGRAM_DELIVERY_BLOCKED');
        return false;
      });
      if (delivered) return;
      const elapsed = this.clock() - began;
      if (elapsed < 0) fail('TEST_TELEGRAM_CLOCK_INVALID');
      const remaining = this.waitMs - Math.max(elapsed, slept);
      if (remaining <= 0) fail('TEST_TELEGRAM_DELIVERY_PENDING');
      const delay = Math.min(500, remaining);
      await this.sleep(delay);slept += delay;
    }
  }

  close(): void {if (!this.closed) {this.db.close();this.closed = true;}}
}
