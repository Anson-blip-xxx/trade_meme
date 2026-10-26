import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ControlledTestNotifications} from '../src/controlled-test/notifications.js';

const epoch = Date.parse('2026-10-25T08:00:00.000Z');
function fixture(meta = false) {
  const dir = mkdtempSync(join(tmpdir(), 'meme-test-notifications-')), path = join(dir, 'notifications.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE trade_notification_events(event_key TEXT PRIMARY KEY,text TEXT NOT NULL,queued INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE telegram_outbox(id INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE,text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0,sent_at INTEGER,last_error TEXT);`);
  if (meta) db.exec('CREATE TABLE telegram_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const ack = (key = 'open', state = 'sent') => {
    const event = db.prepare('SELECT text,created_at FROM trade_notification_events WHERE event_key=?').get(key)!;
    db.prepare('INSERT OR IGNORE INTO telegram_outbox(key,text,state,created_at) VALUES (?,?,?,?)')
      .run(key, event.text, state, event.created_at);
    db.prepare('UPDATE trade_notification_events SET queued=1 WHERE event_key=?').run(key);
  };
  return {dir, path, db, ack, close: () => {db.close();rmSync(dir, {recursive: true, force: true});}};
}

test('controlled notifications only inserts a durable event and waits for the existing sender acknowledgement', async () => {
  const f = fixture();let time = epoch, sleeps = 0;
  const notifications = new ControlledTestNotifications(f.path, {now: () => time, sleep: async milliseconds => {
    assert.equal(milliseconds, 500);sleeps++;time += milliseconds;
    const event = f.db.prepare('SELECT * FROM trade_notification_events WHERE event_key=?').get('open')!;
    assert.equal(event.text, '开仓已确认');assert.equal(event.queued, 0);assert.equal(event.created_at, epoch);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM telegram_outbox').get()!.n, 0);
    f.ack();
  }});
  try {await notifications.notify('open', '开仓已确认');assert.equal(sleeps, 1);}
  finally {notifications.close();f.close();}
});

test('duplicate keys never create another send or overwrite the original message', async () => {
  const f = fixture();let sleeps = 0;
  const notifications = new ControlledTestNotifications(f.path, {now: () => epoch, sleep: async () => {sleeps++;f.ack();}});
  try {
    await notifications.notify('open', '开仓已确认');await notifications.notify('open', '开仓已确认');
    assert.equal(sleeps, 1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM trade_notification_events').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM telegram_outbox').get()!.n, 1);
    await assert.rejects(notifications.notify('open', '另一个开仓'), /TEST_TELEGRAM_EVENT_CONFLICT/);
    assert.equal(f.db.prepare('SELECT text FROM trade_notification_events').get()!.text, '开仓已确认');
  } finally {notifications.close();f.close();}
});

test('timeout is bounded, retains the queued event, and later recovery only waits for delivery', async () => {
  const f = fixture();let time = epoch;const sleeps: number[] = [];
  let notifications = new ControlledTestNotifications(f.path, {waitMs: 1200, now: () => time,
    sleep: async milliseconds => {sleeps.push(milliseconds);time += milliseconds;}});
  try {
    await assert.rejects(notifications.notify('open', '等待确认'), /^Error: TEST_TELEGRAM_DELIVERY_PENDING$/);
    assert.deepEqual(sleeps, [500, 500, 200]);
    assert.equal(f.db.prepare('SELECT queued FROM trade_notification_events').get()!.queued, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM telegram_outbox').get()!.n, 0);
    notifications.close();f.ack();
    notifications = new ControlledTestNotifications(f.path, {waitMs: 0});
    await notifications.notify('open', '等待确认');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM trade_notification_events').get()!.n, 1);
  } finally {notifications.close();f.close();}
});

test('failed or blocked delivery cannot be reported as sent and its durable record remains intact', async () => {
  const f = fixture(true);
  let notifications = new ControlledTestNotifications(f.path, {now: () => epoch, sleep: async () => {f.ack('open', 'failed');}});
  try {
    await assert.rejects(notifications.notify('open', '开仓已确认'), /TEST_TELEGRAM_DELIVERY_FAILED/);
    assert.equal(f.db.prepare('SELECT state FROM telegram_outbox').get()!.state, 'failed');
    notifications.close();
    f.db.prepare('INSERT INTO telegram_meta VALUES (?,?)').run('blocked_config', 'redacted-config-hash');
    notifications = new ControlledTestNotifications(f.path, {now: () => epoch, sleep: async () => assert.fail('must not poll a blocked sender')});
    await assert.rejects(notifications.notify('closed', '平仓已确认'), /TEST_TELEGRAM_DELIVERY_BLOCKED/);
    assert.equal(f.db.prepare("SELECT queued FROM trade_notification_events WHERE event_key='closed'").get()!.queued, 0);
    f.ack('closed');await notifications.notify('closed', '平仓已确认');
  } finally {notifications.close();f.close();}
});

test('default wait budget stays at fifteen seconds even with a frozen injected clock', async () => {
  const f = fixture();let waited = 0, polls = 0;
  const notifications = new ControlledTestNotifications(f.path, {now: () => epoch,
    sleep: async milliseconds => {waited += milliseconds;polls++;}});
  try {
    await assert.rejects(notifications.notify('open', '等待发送'), /TEST_TELEGRAM_DELIVERY_PENDING/);
    assert.equal(waited, 15_000);assert.equal(polls, 30);
  } finally {notifications.close();f.close();}
});

test('invalid messages and missing schema never create a new database or insert an event', async () => {
  const f = fixture();const missing = join(f.dir, 'missing.sqlite');
  const notifications = new ControlledTestNotifications(f.path, {waitMs: 0});
  try {
    assert.throws(() => new ControlledTestNotifications(missing), /TEST_TELEGRAM_DATABASE_UNAVAILABLE/);
    assert.equal(existsSync(missing), false);
    assert.throws(() => new ControlledTestNotifications(f.path, {waitMs: 15001}), /TEST_TELEGRAM_WAIT_INVALID/);
    for (const [key, text] of [['', 'hello'], ['\n', 'hello'], ['key', ''], ['key', 'x'.repeat(4001)]])
      await assert.rejects(notifications.notify(key, text), /TEST_TELEGRAM_(EVENT_KEY|MESSAGE_LENGTH)_INVALID/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM trade_notification_events').get()!.n, 0);
    const emptyPath = join(f.dir, 'empty.sqlite'), empty = new DatabaseSync(emptyPath);empty.close();
    assert.throws(() => new ControlledTestNotifications(emptyPath), /TEST_TELEGRAM_DATABASE_UNAVAILABLE/);
  } finally {notifications.close();f.close();}
});

test('producer does not read credentials or send network requests; closing preserves its event', async () => {
  const originalEnv = process.env, originalFetch = globalThis.fetch;
  let credentialReads = 0, networkCalls = 0;
  process.env = new Proxy(originalEnv, {get(target, key) {
    if (typeof key === 'string' && /TELEGRAM|TOKEN|SECRET|PRIVATE_KEY/.test(key)) {
      credentialReads++;throw new Error('CREDENTIAL_ACCESS_FORBIDDEN');
    }
    return Reflect.get(target, key);
  }});
  globalThis.fetch = async () => {networkCalls++;throw new Error('NETWORK_FORBIDDEN');};
  const f = fixture();
  const notifications: ControlledTestNotifications = new ControlledTestNotifications(f.path, {now: () => epoch,
    sleep: async (): Promise<void> => notifications.close()});
  try {
    await assert.rejects(notifications.notify('open', '开仓已确认'), /TEST_TELEGRAM_NOTIFICATIONS_CLOSED/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM trade_notification_events').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM telegram_outbox').get()!.n, 0);
    assert.equal(credentialReads, 0);assert.equal(networkCalls, 0);
  } finally {process.env = originalEnv;globalThis.fetch = originalFetch;notifications.close();f.close();}
});
