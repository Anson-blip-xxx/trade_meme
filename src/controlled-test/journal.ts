import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync, openSync, closeSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {TestJournal, TestOperation, TestOperationKey, TestRun} from './types.js';

const phases = new Set(['created', 'buy_pending', 'verify_protection', 'cancel_pending', 'sell_pending',
  'complete', 'preflight_failed', 'needs_attention']);
const operationKeys = new Set<TestOperationKey>(['buy', 'cancel', 'sell']);
function fail(reason: string): never {throw new Error(reason);}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const amount = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,39})$/.test(value);

/** JSON with sorted object keys: key order cannot mint another submission identity. */
function canonical(value: unknown, parents = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('CONTROLLED_JOURNAL_JSON_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || parents.has(value)) return fail('CONTROLLED_JOURNAL_JSON_INVALID');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return fail('CONTROLLED_JOURNAL_JSON_INVALID');
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) return fail('CONTROLLED_JOURNAL_JSON_INVALID');
      return '[' + value.map(item => canonical(item, parents)).join(',') + ']';
    }
    const fields = Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort();
    return '{' + fields.map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], parents)).join(',') + '}';
  } finally {parents.delete(value);}
}

function payload(value: unknown): string {
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded) > 1_000_000) return fail('CONTROLLED_JOURNAL_RECORD_TOO_LARGE');
  return encoded;
}

function validateRun(run: TestRun): void {
  if (!run || !text(run.id) || !text(run.wallet) || !text(run.mint) || !amount(run.amountLamports) ||
    BigInt(run.amountLamports) <= 0n || !amount(run.maxDebitLamports) || BigInt(run.maxDebitLamports) < BigInt(run.amountLamports) ||
    !timestamp(run.createdAt) || !timestamp(run.updatedAt) || Date.parse(run.updatedAt) < Date.parse(run.createdAt) ||
    !phases.has(run.phase) || run.automaticTriggerVerified !== false || !Array.isArray(run.reasons) ||
    !run.reasons.every(text) || !Array.isArray(run.notificationKeys) || !run.notificationKeys.every(text) ||
    new Set(run.notificationKeys).size !== run.notificationKeys.length) fail('CONTROLLED_JOURNAL_RUN_INVALID');
}

/** Only this journal's committed beginOperation result may authorize a first POST. */
export class ControlledTestJournal implements TestJournal {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly claimOpening?: (identity:{chain:'solana';address:string;recordId:string})=>boolean;
  private closed = false;

  constructor(path: string, options: {now?: () => Date;
    claimOpening?: (identity:{chain:'solana';address:string;recordId:string})=>boolean} = {}) {
    this.now = options.now ?? (() => new Date());
    this.claimOpening=options.claimOpening;
    if (!path || path.startsWith('file:')) fail('CONTROLLED_JOURNAL_PATH_INVALID');
    if (path !== ':memory:') {
      mkdirSync(dirname(path), {recursive: true, mode: 0o700});
      // Create privately before SQLite opens the file or creates WAL sidecars.
      const fd = openSync(path, 'a', 0o600);closeSync(fd);chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS controlled_test_runs (
        id TEXT PRIMARY KEY, wallet TEXT NOT NULL, unfinished INTEGER NOT NULL CHECK(unfinished IN (0,1)),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS controlled_test_one_unfinished_wallet
        ON controlled_test_runs(wallet) WHERE unfinished=1;
      CREATE TABLE IF NOT EXISTS controlled_test_operations (
        run_id TEXT NOT NULL REFERENCES controlled_test_runs(id), operation_key TEXT NOT NULL,
        client_id TEXT NOT NULL UNIQUE, body_hash TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(run_id,operation_key)
      );
      CREATE TABLE IF NOT EXISTS controlled_test_leases (
        run_id TEXT PRIMARY KEY REFERENCES controlled_test_runs(id), owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );`);
  }

  private checkOpen(): void {if (this.closed) fail('CONTROLLED_JOURNAL_CLOSED');}
  private clock(): number {
    const at = this.now().getTime();
    if (!Number.isSafeInteger(at) || at < 0) return fail('CONTROLLED_JOURNAL_CLOCK_INVALID');
    return at;
  }
  private transaction<T>(work: () => T): T {
    this.checkOpen();this.db.exec('BEGIN IMMEDIATE');
    try {const result = work();this.db.exec('COMMIT');return result;}
    catch (error) {this.db.exec('ROLLBACK');throw error;}
  }
  private leaseInput(runId: string, owner: string, ttlMs?: number): void {
    if (!text(runId) || !text(owner) || ttlMs !== undefined &&
      (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3_600_000)) fail('CONTROLLED_JOURNAL_LEASE_INVALID');
  }

  create(run: TestRun): void {
    validateRun(run);
    if (run.phase !== 'created' || run.baseline !== undefined || run.buy !== undefined || run.sell !== undefined ||
      run.finalSnapshot !== undefined) fail('CONTROLLED_JOURNAL_INITIAL_STATE_INVALID');
    const encoded = payload(run);
    this.transaction(() => {
      if (this.get(run.id)) fail('CONTROLLED_JOURNAL_RUN_EXISTS');
      if (this.db.prepare('SELECT 1 FROM controlled_test_runs WHERE wallet=? AND unfinished=1').get(run.wallet))
        fail('CONTROLLED_JOURNAL_WALLET_BUSY');
      this.db.prepare('INSERT INTO controlled_test_runs(id,wallet,unfinished,created_at,updated_at,payload) VALUES (?,?,1,?,?,?)')
        .run(run.id, run.wallet, run.createdAt, run.updatedAt, encoded);
    });
  }

  get(id: string): TestRun | undefined {
    this.checkOpen();
    const row = this.db.prepare('SELECT payload FROM controlled_test_runs WHERE id=?').get(id);
    return row ? JSON.parse(String(row.payload)) as TestRun : undefined;
  }

  list(): TestRun[] {
    this.checkOpen();
    return this.db.prepare('SELECT payload FROM controlled_test_runs ORDER BY created_at DESC,id').all()
      .map(row => JSON.parse(String(row.payload)) as TestRun);
  }

  acquireLease(runId: string, owner: string, ttlMs: number): void {
    this.leaseInput(runId, owner, ttlMs);
    this.transaction(() => {
      if (!this.get(runId)) fail('CONTROLLED_JOURNAL_RUN_NOT_FOUND');
      const at = this.clock(), row = this.db.prepare('SELECT expires_at FROM controlled_test_leases WHERE run_id=?').get(runId);
      if (row && Number(row.expires_at) > at) fail('CONTROLLED_JOURNAL_LEASE_BUSY');
      this.db.prepare(`INSERT INTO controlled_test_leases(run_id,owner,expires_at) VALUES (?,?,?)
        ON CONFLICT(run_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at`).run(runId, owner, at + ttlMs);
    });
  }

  assertOwned(runId: string, owner: string): void {
    this.checkOpen();this.leaseInput(runId, owner);
    const row = this.db.prepare('SELECT owner,expires_at FROM controlled_test_leases WHERE run_id=?').get(runId);
    if (!row || row.owner !== owner || Number(row.expires_at) <= this.clock()) fail('CONTROLLED_JOURNAL_LEASE_LOST');
  }

  renewLease(runId: string, owner: string, ttlMs: number): void {
    this.leaseInput(runId, owner, ttlMs);
    this.transaction(() => {
      this.assertOwned(runId, owner);
      this.db.prepare('UPDATE controlled_test_leases SET expires_at=MAX(expires_at,?) WHERE run_id=? AND owner=?')
        .run(this.clock() + ttlMs, runId, owner);
    });
  }

  releaseLease(runId: string, owner: string): void {
    this.transaction(() => {
      this.assertOwned(runId, owner);
      this.db.prepare('DELETE FROM controlled_test_leases WHERE run_id=? AND owner=?').run(runId, owner);
    });
  }

  save(run: TestRun, owner: string): void {
    validateRun(run);const encoded = payload(run);
    this.transaction(() => {
      this.assertOwned(run.id, owner);
      const previous = this.get(run.id);
      if (!previous) fail('CONTROLLED_JOURNAL_RUN_NOT_FOUND');
      for (const field of ['id', 'wallet', 'mint', 'amountLamports', 'maxDebitLamports', 'createdAt'] as const)
        if (run[field] !== previous[field]) fail('CONTROLLED_JOURNAL_IDENTITY_IMMUTABLE');
      if (Date.parse(run.updatedAt) < Date.parse(previous.updatedAt)) fail('CONTROLLED_JOURNAL_TIME_REGRESSION');
      for (const field of ['baseline', 'buy', 'sell'] as const)
        if (previous[field] !== undefined && (run[field] === undefined || payload(previous[field]) !== payload(run[field])))
          fail('CONTROLLED_JOURNAL_EVIDENCE_IMMUTABLE');
      if (previous.phase === 'complete' && (run.phase !== 'complete' ||
        payload(run.finalSnapshot) !== payload(previous.finalSnapshot) || run.netNativeLamports !== previous.netNativeLamports))
        fail('CONTROLLED_JOURNAL_TERMINAL_IMMUTABLE');
      if (previous.phase === 'preflight_failed' && run.phase !== 'preflight_failed') fail('CONTROLLED_JOURNAL_TERMINAL_IMMUTABLE');
      if (previous.notificationKeys.some(key => !run.notificationKeys.includes(key))) fail('CONTROLLED_JOURNAL_NOTIFICATION_REGRESSION');
      const operations = this.db.prepare('SELECT payload FROM controlled_test_operations WHERE run_id=?').all(run.id)
        .map(row => JSON.parse(String(row.payload)) as TestOperation);
      if (run.phase === 'complete' && (!run.baseline || !run.buy || !run.sell || !run.finalSnapshot ||
        operations.some(operation => operation.state !== 'acknowledged'))) fail('CONTROLLED_JOURNAL_COMPLETION_UNVERIFIED');
      const unfinished = run.phase === 'complete' || run.phase === 'preflight_failed' && !operations.length ? 0 : 1;
      this.db.prepare('UPDATE controlled_test_runs SET updated_at=?,unfinished=?,payload=? WHERE id=?')
        .run(run.updatedAt, unfinished, encoded, run.id);
    });
  }

  operation(runId: string, key: TestOperationKey): TestOperation | undefined {
    this.checkOpen();
    if (!operationKeys.has(key)) fail('CONTROLLED_JOURNAL_OPERATION_INVALID');
    const row = this.db.prepare('SELECT payload FROM controlled_test_operations WHERE run_id=? AND operation_key=?').get(runId, key);
    return row ? JSON.parse(String(row.payload)) as TestOperation : undefined;
  }

  beginOperation(runId: string, key: TestOperationKey, body: Record<string, unknown>, owner: string): {created: boolean; operation: TestOperation} {
    if (!operationKeys.has(key) || !body || typeof body !== 'object' || Array.isArray(body)) fail('CONTROLLED_JOURNAL_OPERATION_INVALID');
    const encoded = payload(body), bodyHash = createHash('sha256').update(encoded).digest('hex');
    return this.transaction(() => {
      this.assertOwned(runId, owner);
      const previous = this.operation(runId, key);
      if (previous) {
        if (previous.bodyHash !== bodyHash) fail('CONTROLLED_JOURNAL_OPERATION_BODY_MISMATCH');
        return {created: false, operation: previous};
      }
      const run = this.get(runId);
      if (!run || run.phase === 'complete' || run.phase === 'preflight_failed') fail('CONTROLLED_JOURNAL_OPERATION_RUN_CLOSED');
      // A different test run or wallet must not authorize buying an already attempted mint again.
      // Unknown receipts and completed/zero-balance runs retain this permanent exclusion.
      if (key === 'buy' && this.db.prepare(`SELECT 1 FROM controlled_test_runs r
        JOIN controlled_test_operations o ON o.run_id=r.id AND o.operation_key='buy'
        WHERE r.id<>? AND json_extract(r.payload,'$.mint')=? LIMIT 1`).get(runId,run.mint))
        fail('CONTROLLED_JOURNAL_TOKEN_ALREADY_OPENED');
      // Production uses the same atomic identity claim as regular orders. Commit that
      // deny record before this write-ahead operation: interruption can never free a token.
      if(key==='buy'&&this.claimOpening&&!this.claimOpening({chain:'solana',address:run.mint,recordId:`controlled-test:${run.id}`}))
        fail('CONTROLLED_JOURNAL_TOKEN_ALREADY_OPENED');
      const at = new Date(this.clock()).toISOString();
      const operation: TestOperation = {runId, key, clientId: randomUUID(), bodyHash, body: JSON.parse(encoded),
        state: 'submitting', createdAt: at, updatedAt: at};
      this.db.prepare('INSERT INTO controlled_test_operations(run_id,operation_key,client_id,body_hash,payload) VALUES (?,?,?,?,?)')
        .run(runId, key, operation.clientId, bodyHash, payload(operation));
      return {created: true, operation};
    });
  }

  finishOperation(runId: string, key: TestOperationKey, state: 'acknowledged' | 'unknown', response: unknown, owner: string): void {
    if (state !== 'acknowledged' && state !== 'unknown') fail('CONTROLLED_JOURNAL_OPERATION_STATE_INVALID');
    // Undefined means no response was received; never store a fabricated response.
    const encodedResponse = response === undefined ? undefined : payload(response);
    this.transaction(() => {
      this.assertOwned(runId, owner);
      const operation = this.operation(runId, key);
      if (!operation) fail('CONTROLLED_JOURNAL_OPERATION_NOT_FOUND');
      if (operation.state === 'acknowledged') {
        if (state !== 'acknowledged') fail('CONTROLLED_JOURNAL_OPERATION_STATE_REGRESSION');
        if (encodedResponse !== (operation.response === undefined ? undefined : payload(operation.response)))
          fail('CONTROLLED_JOURNAL_OPERATION_RESPONSE_IMMUTABLE');
        return;
      }
      operation.state = state;operation.updatedAt = new Date(this.clock()).toISOString();
      if (encodedResponse !== undefined) operation.response = JSON.parse(encodedResponse);
      this.db.prepare('UPDATE controlled_test_operations SET payload=? WHERE run_id=? AND operation_key=?')
        .run(payload(operation), runId, key);
    });
  }

  close(): void {if (!this.closed) {this.db.close();this.closed = true;}}
}
