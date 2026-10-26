import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ControlledTestJournal} from '../src/controlled-test/journal.js';
import type {SolanaSnapshot, TestRun, VerifiedSolanaTransaction} from '../src/controlled-test/types.js';

const epoch = Date.parse('2026-10-25T08:00:00.000Z');
const iso = (offset = 0) => new Date(epoch + offset).toISOString();
const run = (id = 'test-run', wallet = 'test-wallet'): TestRun => ({id, wallet, mint: 'test-mint',
  amountLamports: '10000000', maxDebitLamports: '12000000', createdAt: iso(), updatedAt: iso(), phase: 'created',
  reasons: [], automaticTriggerVerified: false, notificationKeys: []});
const snapshot = (tokenAmount = '0'): SolanaSnapshot => ({wallet: 'test-wallet', mint: 'test-mint',
  nativeLamports: '100000000', tokenAmount, decimals: 6, slot: 1, nativeSlot: 1,
  mintAuthority: null, freezeAuthority: null, tokenProgram: 'token-program', extensions: [], checkedAt: iso()});
const transaction = (side: 'buy' | 'sell'): VerifiedSolanaTransaction => ({signature: 'signature-' + side,
  wallet: 'test-wallet', mint: 'test-mint', side, slot: side === 'buy' ? 2 : 3,
  tokenDelta: side === 'buy' ? '500' : '-500', nativeDelta: side === 'buy' ? '-10005000' : '9000000',
  feeLamports: '5000', preTokenAmount: side === 'buy' ? '0' : '500', postTokenAmount: side === 'buy' ? '500' : '0',
  preNativeLamports: '100000000', postNativeLamports: '89995000', decimals: 6, checkedAt: iso()});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'meme-controlled-journal-')), path = join(dir, 'journal.sqlite');
  let time = epoch;
  const journals: ControlledTestJournal[] = [];
  const open = () => {const journal = new ControlledTestJournal(path, {now: () => new Date(time)});journals.push(journal);return journal;};
  return {dir, path, open, advance: (ms: number) => {time += ms;}, close: () => {
    for (const journal of journals) journal.close();rmSync(dir, {recursive: true, force: true});
  }};
}

test('controlled journal persists private WAL records and an unfinished wallet is unique across connections', () => {
  const f = fixture();
  try {
    const first = f.open(), second = f.open();first.create(run());
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    const db = new DatabaseSync(f.path, {readOnly: true});
    try {assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');}
    finally {db.close();}
    assert.equal((first as unknown as {db: DatabaseSync}).db.prepare('PRAGMA synchronous').get()!.synchronous, 2);
    for (const suffix of ['-wal', '-shm']) assert.equal(statSync(f.path + suffix).mode & 0o777, 0o600);
    assert.throws(() => second.create(run('second')), /CONTROLLED_JOURNAL_WALLET_BUSY/);
    assert.throws(() => second.create(run()), /CONTROLLED_JOURNAL_RUN_EXISTS/);
    second.create(run('other', 'other-wallet'));assert.equal(first.list().length, 2);
    first.close();assert.deepEqual(second.get('test-run'), run());
  } finally {f.close();}
});

test('an unexpired lease cannot be acquired twice, renewed by another owner, or released by a stale runner', () => {
  const f = fixture();
  try {
    const a = f.open(), b = f.open();a.create(run());a.acquireLease('test-run', 'owner-a', 1000);
    assert.throws(() => b.acquireLease('test-run', 'owner-b', 1000), /LEASE_BUSY/);
    assert.throws(() => a.acquireLease('test-run', 'owner-a', 1000), /LEASE_BUSY/);
    assert.throws(() => b.renewLease('test-run', 'owner-b', 1000), /LEASE_LOST/);
    assert.throws(() => b.releaseLease('test-run', 'owner-b'), /LEASE_LOST/);
    f.advance(500);a.renewLease('test-run', 'owner-a', 1000);f.advance(600);a.assertOwned('test-run', 'owner-a');
    f.advance(400);assert.throws(() => a.assertOwned('test-run', 'owner-a'), /LEASE_LOST/);
    b.acquireLease('test-run', 'owner-b', 1000);
    for (const action of [() => a.save(run(), 'owner-a'), () => a.beginOperation('test-run', 'buy', {}, 'owner-a'),
      () => a.renewLease('test-run', 'owner-a', 1000), () => a.releaseLease('test-run', 'owner-a')])
      assert.throws(action, /LEASE_LOST/);
    b.assertOwned('test-run', 'owner-b');b.releaseLease('test-run', 'owner-b');
    a.acquireLease('test-run', 'owner-c', 1000);a.assertOwned('test-run', 'owner-c');
  } finally {f.close();}
});

test('submitting survives a crash window and recovery never authorizes the same POST again', () => {
  const f = fixture();
  try {
    const a = f.open();a.create(run());a.acquireLease('test-run', 'before-crash', 1000);
    const first = a.beginOperation('test-run', 'buy', {wallet: 'test-wallet', amount: '10000000', nested: {b: 2, a: 1}}, 'before-crash');
    assert.equal(first.created, true);assert.equal(first.operation.state, 'submitting');
    assert.match(first.operation.clientId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    a.close();f.advance(1000);
    const recovered = f.open();recovered.acquireLease('test-run', 'recovery', 1000);
    const retry = recovered.beginOperation('test-run', 'buy', {nested: {a: 1, b: 2}, amount: '10000000', wallet: 'test-wallet'}, 'recovery');
    assert.equal(retry.created, false);assert.equal(retry.operation.clientId, first.operation.clientId);
    assert.equal(retry.operation.state, 'submitting');assert.equal(retry.operation.bodyHash, first.operation.bodyHash);
    assert.throws(() => recovered.beginOperation('test-run', 'buy', {amount: '20000000'}, 'recovery'), /OPERATION_BODY_MISMATCH/);
    assert.equal(recovered.operation('test-run', 'buy')!.clientId, first.operation.clientId);
  } finally {f.close();}
});

test('write-ahead operation snapshots are detached and each buy/cancel/sell identity is stable', () => {
  const f = fixture();
  try {
    const journal = f.open();journal.create(run());journal.acquireLease('test-run', 'owner', 1000);
    const ids = new Set<string>();
    for (const key of ['buy', 'cancel', 'sell'] as const) {
      const body = {key, amount: '10000000', omitted: undefined};
      const result = journal.beginOperation('test-run', key, body, 'owner');ids.add(result.operation.clientId);
      body.amount = '999';result.operation.body.amount = '888';
      const stored = journal.operation('test-run', key)!;assert.equal(stored.body.amount, '10000000');
      assert.equal('omitted' in stored.body, false);
      assert.equal(journal.beginOperation('test-run', key, {amount: '10000000', key}, 'owner').created, false);
    }
    assert.equal(ids.size, 3);
  } finally {f.close();}
});

test('unknown outcomes can be confirmed by readback but can never erase acknowledged results', () => {
  const f = fixture();
  try {
    const journal = f.open();journal.create(run());journal.acquireLease('test-run', 'owner', 1000);
    journal.beginOperation('test-run', 'buy', {amount: '10000000'}, 'owner');
    journal.finishOperation('test-run', 'buy', 'unknown', undefined, 'owner');
    assert.equal(journal.operation('test-run', 'buy')!.state, 'unknown');
    assert.equal(journal.beginOperation('test-run', 'buy', {amount: '10000000'}, 'owner').created, false);
    journal.finishOperation('test-run', 'buy', 'acknowledged', {orderId: 'read-back-order'}, 'owner');
    journal.finishOperation('test-run', 'buy', 'acknowledged', {orderId: 'read-back-order'}, 'owner');
    assert.throws(() => journal.finishOperation('test-run', 'buy', 'unknown', null, 'owner'), /STATE_REGRESSION/);
    assert.throws(() => journal.finishOperation('test-run', 'buy', 'acknowledged', {orderId: 'different-order'}, 'owner'), /RESPONSE_IMMUTABLE/);
    assert.deepEqual(journal.operation('test-run', 'buy')!.response, {orderId: 'read-back-order'});
    f.advance(1000);
    assert.throws(() => journal.finishOperation('test-run', 'buy', 'acknowledged', {}, 'owner'), /LEASE_LOST/);
  } finally {f.close();}
});

test('run identity, timestamps and committed chain evidence cannot be rewritten or removed', () => {
  const f = fixture();
  try {
    const journal = f.open();journal.create(run());journal.acquireLease('test-run', 'owner', 1000);
    for (const changed of [{wallet: 'different'}, {mint: 'different'}, {amountLamports: '9000000'},
      {maxDebitLamports: '11000000'}, {createdAt: iso(-1000)}])
      assert.throws(() => journal.save({...run(), ...changed}, 'owner'), /IDENTITY_IMMUTABLE/);
    const evidence = {...run(), baseline: snapshot(), buy: transaction('buy'), sell: transaction('sell'), updatedAt: iso(100)};
    journal.save(evidence, 'owner');
    for (const field of ['baseline', 'buy', 'sell'] as const) {
      assert.throws(() => journal.save({...evidence, [field]: undefined}, 'owner'), /EVIDENCE_IMMUTABLE/);
      assert.throws(() => journal.save({...evidence, [field]: {...evidence[field], checkedAt: iso(1)}}, 'owner'), /EVIDENCE_IMMUTABLE/);
    }
    assert.throws(() => journal.save({...evidence, updatedAt: iso()}, 'owner'), /TIME_REGRESSION/);
    assert.deepEqual(journal.get('test-run'), evidence);
  } finally {f.close();}
});

test('preflight failure releases a wallet only if no submitting operation ever existed', () => {
  const f = fixture();
  try {
    const journal = f.open();journal.create(run());journal.acquireLease('test-run', 'owner', 1000);
    journal.save({...run(), phase: 'preflight_failed', reasons: ['BALANCE_LOW']}, 'owner');
    journal.create(run('second'));journal.acquireLease('second', 'owner-2', 1000);
    journal.beginOperation('second', 'buy', {amount: '10000000'}, 'owner-2');
    journal.save({...run('second'), phase: 'preflight_failed', reasons: ['TRANSPORT_UNKNOWN']}, 'owner-2');
    assert.throws(() => journal.create(run('third')), /WALLET_BUSY/);
    assert.throws(() => journal.save(run(), 'owner'), /TERMINAL_IMMUTABLE/);
    assert.throws(() => journal.beginOperation('test-run', 'buy', {}, 'owner'), /OPERATION_RUN_CLOSED/);
  } finally {f.close();}
});

test('completion requires final evidence and settled operations, then permits notification bookkeeping only', () => {
  const f = fixture();
  try {
    const journal = f.open();journal.create(run());journal.acquireLease('test-run', 'owner', 1000);
    assert.throws(() => journal.save({...run(), phase: 'complete'}, 'owner'), /COMPLETION_UNVERIFIED/);
    const complete: TestRun = {...run(), phase: 'complete', baseline: snapshot(), buy: transaction('buy'), sell: transaction('sell'),
      finalSnapshot: snapshot(), netNativeLamports: '-1005000'};
    journal.beginOperation('test-run', 'buy', {amount: '10000000'}, 'owner');
    assert.throws(() => journal.save(complete, 'owner'), /COMPLETION_UNVERIFIED/);
    journal.finishOperation('test-run', 'buy', 'unknown', null, 'owner');
    assert.throws(() => journal.save(complete, 'owner'), /COMPLETION_UNVERIFIED/);
    journal.finishOperation('test-run', 'buy', 'acknowledged', {}, 'owner');
    journal.save(complete, 'owner');
    journal.save({...complete, notificationKeys: ['closed']}, 'owner');
    assert.throws(() => journal.save(complete, 'owner'), /NOTIFICATION_REGRESSION/);
    assert.throws(() => journal.save({...complete, phase: 'created', notificationKeys: ['closed']}, 'owner'), /TERMINAL_IMMUTABLE/);
    assert.throws(() => journal.save({...complete, netNativeLamports: '9000000', notificationKeys: ['closed']}, 'owner'), /TERMINAL_IMMUTABLE/);
    assert.throws(() => journal.beginOperation('test-run', 'sell', {}, 'owner'), /OPERATION_RUN_CLOSED/);
    journal.create(run('next-run'));
  } finally {f.close();}
});

test('invalid serialized bodies and lease inputs fail with fixed codes and commit no operation', () => {
  const f = fixture();
  try {
    const journal = f.open();journal.create(run());
    assert.throws(() => journal.acquireLease('test-run', 'owner', 0), /LEASE_INVALID/);
    assert.throws(() => journal.acquireLease('missing', 'owner', 1000), /RUN_NOT_FOUND/);
    journal.acquireLease('test-run', 'owner', 1000);
    const cyclic: Record<string, unknown> = {};cyclic.self = cyclic;
    for (const body of [cyclic, {unsafe: BigInt(1)}, {unsafe: NaN}, {unsafe: new Date()}, {unsafe: [, 1]}]) {
      assert.throws(() => journal.beginOperation('test-run', 'buy', body, 'owner'), /^Error: CONTROLLED_JOURNAL_JSON_INVALID$/);
      assert.equal(journal.operation('test-run', 'buy'), undefined);
    }
    assert.throws(() => journal.finishOperation('test-run', 'buy', 'unknown', null, 'owner'), /OPERATION_NOT_FOUND/);
    journal.close();assert.throws(() => journal.get('test-run'), /CONTROLLED_JOURNAL_CLOSED/);
  } finally {f.close();}
});

test('a different wallet and run cannot buy a previously attempted mint after an unknown receipt or restart',()=>{
  const f=fixture();try {
    const a=f.open();a.create(run('original','first-wallet'));a.acquireLease('original','owner',10000);
    a.beginOperation('original','buy',{output_token:'test-mint'},'owner');
    a.finishOperation('original','buy','unknown',undefined,'owner');a.close();
    const b=f.open();b.create(run('retry','second-wallet'));b.acquireLease('retry','retry-owner',10000);
    assert.throws(()=>b.beginOperation('retry','buy',{output_token:'test-mint'},'retry-owner'),/TOKEN_ALREADY_OPENED/);
    assert.equal(b.operation('retry','buy'),undefined);
    assert.equal(b.beginOperation('retry','sell',{output_token:'native'},'retry-owner').created,true);
  }finally{f.close();}
});
