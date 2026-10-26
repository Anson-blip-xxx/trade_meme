import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {listControlledHoldings, readControlledHoldings} from '../src/held-position-source.js';

const wallet = bs58.encode(new Uint8Array(32).fill(1));
const otherWallet = bs58.encode(new Uint8Array(32).fill(2));
const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const sol = 'So11111111111111111111111111111111111111112';
const signature = bs58.encode(new Uint8Array(64).fill(3));
const at = '2026-10-25T09:08:46.197Z';
function record(id = 'test-run'): Record<string, any> {
  return {id, wallet, mint, phase: 'needs_attention', amountLamports: '10000000',
    createdAt: '2026-10-25T09:08:33.425Z', updatedAt: '2026-10-25T09:09:04.359Z',
    buy: {signature, wallet, mint, side: 'buy', slot: 461200851, tokenDelta: '33696514738', nativeDelta: '-11613440',
      feeLamports: '15000', preTokenAmount: '0', postTokenAmount: '33696514738',
      preNativeLamports: '100000000', postNativeLamports: '88386560', decimals: 5, checkedAt: at}};
}
function operation(id = 'test-run'): Record<string, any> {
  return {runId: id, key: 'buy', state: 'acknowledged',
    body: {chain: 'sol', from_address: wallet, input_token: sol, output_token: mint,
      input_amount: '10000000', swap_mode: 'ExactIn'},
    response: {order_id: 'gmgn-buy-order', status: 'submitted', hash: signature}};
}
function finalSnapshot(tokenAmount = '0'): Record<string, unknown> {
  return {wallet, mint, tokenAmount, decimals: 5, slot: 461200900, nativeSlot: 461200900,
    checkedAt: '2026-10-25T09:09:04.359Z'};
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'held-source-')), path = join(dir, 'controlled.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE controlled_test_runs(id TEXT PRIMARY KEY,wallet TEXT,created_at TEXT,payload TEXT);
    CREATE TABLE controlled_test_operations(run_id TEXT,operation_key TEXT,payload TEXT,PRIMARY KEY(run_id,operation_key));`);
  const add = (run = record(), op: Record<string, any> | null = operation(run.id)) => {
    db.prepare('INSERT INTO controlled_test_runs VALUES(?,?,?,?)').run(run.id, run.wallet, run.createdAt, JSON.stringify(run));
    if (op) db.prepare('INSERT INTO controlled_test_operations VALUES(?,?,?)').run(run.id, 'buy', JSON.stringify(op));
  };
  return {path, db, dir, add, close: () => {db.close(); rmSync(dir, {recursive: true, force: true});}};
}

test('reads the actual submitted-receipt shape using its ExactIn basis, without treating rent as trade cost', () => {
  const f = fixture(); f.add();
  try {
    const result = readControlledHoldings(f.path, wallet);
    assert.deepEqual(result.reasons, ['CONTROLLED_HOLDING_REQUESTED_COST_BASIS']);
    assert.equal(result.items.length, 1);
    const seed = result.items[0];
    assert.equal(seed.id, 'controlled-test:test-run'); assert.equal(seed.source, 'controlled_test');
    assert.equal(seed.chain, 'solana'); assert.equal(seed.wallet, wallet); assert.equal(seed.tokenAddress, mint);
    assert.equal(seed.transactionHash, signature); assert.equal(seed.providerOrderId, 'gmgn-buy-order');
    assert.equal(seed.inputAmount, '10000000'); assert.equal(seed.outputAmount, '33696514738');
    assert.equal(seed.tokenDecimals, 5); assert.equal(seed.buySlot, 461200851); assert.equal(seed.confirmedAt, at);
    assert.equal(seed.costBasis, 'requested_exact_in'); assert.equal(seed.entryPriceUsd, undefined);
    assert.ok(Math.abs(seed.entryPriceSol! / (0.01 / 336965.14738) - 1) < 1e-14);
    assert.deepEqual(listControlledHoldings(f.path, wallet), result.items);
  } finally {f.close();}
});

test('matching confirmed fill report uses actual input and USD fill price only after all identities agree', () => {
  const f = fixture(), op = operation();
  op.response = {...op.response, status: 'successful', state: 30, report: {input_token: sol, output_token: mint,
    input_token_decimals: 9, output_token_decimals: 5, input_amount: '9900000', output_amount: '33696514738',
    price_usd: '0.000005123456'}};
  f.add(record(), op);
  try {
    const result = readControlledHoldings(f.path, wallet);
    assert.deepEqual(result.reasons, []); assert.equal(result.items.length, 1);
    assert.equal(result.items[0].inputAmount, '9900000'); assert.equal(result.items[0].costBasis, 'confirmed_fill');
    assert.equal(result.items[0].entryPriceUsd, 0.000005123456);
    assert.ok(Math.abs(result.items[0].entryPriceSol! / (0.0099 / 336965.14738) - 1) < 1e-14);
  } finally {f.close();}
});

test('a sell record or completed phase is retained until a matching fresh final zero balance is observed', () => {
  for (const patch of [{sell: {status: 'confirmed'}}, {phase: 'complete'},
    {sell: {status: 'confirmed'}, finalSnapshot: finalSnapshot('1')},
    {finalSnapshot: {...finalSnapshot(), wallet: otherWallet}},
    {finalSnapshot: {...finalSnapshot(), slot: 461200850}},
    {finalSnapshot: {...finalSnapshot(), checkedAt: '2026-10-25T08:00:00Z'}}]) {
    const f = fixture(); f.add({...record(), ...patch});
    try {assert.equal(readControlledHoldings(f.path, wallet).items.length, 1);}
    finally {f.close();}
  }
  const f = fixture(); f.add({...record(), sell: {status: 'confirmed'}, finalSnapshot: finalSnapshot()});
  try {assert.deepEqual(readControlledHoldings(f.path, wallet), {items: [], reasons: []});}
  finally {f.close();}
});

test('preflight rows with no buy are not holdings and expected wallet filtering is strict', () => {
  const f = fixture(), preflight = record('preflight'); delete preflight.buy;
  f.add(preflight); f.add({...record('other'), wallet: otherWallet}, operation('other'));
  try {assert.deepEqual(readControlledHoldings(f.path, wallet), {items: [], reasons: []});}
  finally {f.close();}
});

test('invalid base58, slot, side, quantity, decimals and inconsistent native evidence are skipped', () => {
  for (const patch of [{wallet: otherWallet}, {mint: sol}, {signature: 'invalid'}, {signature: wallet},
    {side: 'sell'}, {slot: 0}, {slot: 1.5}, {slot: Number.MAX_SAFE_INTEGER + 1},
    {tokenDelta: '1'}, {tokenDelta: 33696514738}, {tokenDelta: '033696514738'}, {tokenDelta: '-1'},
    {tokenDelta: '18446744073709551616'}, {postTokenAmount: '0'}, {nativeDelta: '-1'},
    {nativeDelta: '1'}, {preNativeLamports: '1.1'}, {feeLamports: '-1'}, {decimals: 256}, {decimals: -1},
    {checkedAt: 'not-a-date'}]) {
    const f = fixture(), run = record(); Object.assign(run.buy, patch); f.add(run);
    try {const result = readControlledHoldings(f.path, wallet); assert.equal(result.items.length, 0); assert.ok(result.reasons.length);}
    finally {f.close();}
  }
});

test('BigInt quantities above the safe Number range retain all original digits', () => {
  const f = fixture(), run = record();
  run.buy.tokenDelta = '9007199254740993'; run.buy.postTokenAmount = '9007199254740993'; f.add(run);
  try {assert.equal(listControlledHoldings(f.path, wallet)[0].outputAmount, '9007199254740993');}
  finally {f.close();}
});

test('missing or mismatched buy operation never lends another wallet or asset an entry basis', () => {
  for (const mutate of [
    (op: Record<string, any>) => {op.runId = 'different';},
    (op: Record<string, any>) => {op.key = 'sell';},
    (op: Record<string, any>) => {op.body.from_address = otherWallet;},
    (op: Record<string, any>) => {op.body.output_token = sol;},
    (op: Record<string, any>) => {op.body.input_amount = '20000000';},
    (op: Record<string, any>) => {op.body.swap_mode = 'ExactOut';},
    (op: Record<string, any>) => {op.response.hash = bs58.encode(new Uint8Array(64).fill(4));},
    (op: Record<string, any>) => {op.response.report = {price_usd: '100'};},
  ]) {
    const f = fixture(), op = operation(); mutate(op); f.add(record(), op);
    try {assert.equal(readControlledHoldings(f.path, wallet).items.length, 0);} finally {f.close();}
  }
  const f = fixture(); f.add(record(), null);
  try {assert.deepEqual(readControlledHoldings(f.path, wallet).reasons, ['CONTROLLED_HOLDING_OPERATION_INVALID']);}
  finally {f.close();}
});

test('malformed rows are skipped independently and diagnostics never contain payload text', () => {
  const f = fixture(); f.add();
  f.db.prepare('INSERT INTO controlled_test_runs VALUES(?,?,?,?)').run('bad', wallet, at, 'private-upstream-content');
  try {
    const result = readControlledHoldings(f.path, wallet);
    assert.equal(result.items.length, 1); assert.ok(result.reasons.includes('CONTROLLED_HOLDING_RUN_INVALID'));
    assert.equal(JSON.stringify(result).includes('private-upstream-content'), false);
  } finally {f.close();}
});

test('duplicate transaction evidence across runs produces one seed rather than double-counting a buy', () => {
  const f = fixture(); f.add(record('one'), operation('one')); f.add(record('two'), operation('two'));
  try {const result = readControlledHoldings(f.path, wallet); assert.equal(result.items.length, 1);
    assert.ok(result.reasons.includes('CONTROLLED_HOLDING_DUPLICATE_TRANSACTION'));}
  finally {f.close();}
});

test('reader leaves the database unchanged and never creates a missing journal or accesses the network', () => {
  const f = fixture(); f.add();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Network forbidden');};
  try {
    const contents = readFileSync(f.path), before = statSync(f.path);
    assert.equal(listControlledHoldings(f.path, wallet).length, 1);
    assert.deepEqual(readFileSync(f.path), contents); assert.equal(statSync(f.path).mtimeMs, before.mtimeMs);
    const missing = join(f.dir, 'missing.sqlite');
    assert.deepEqual(readControlledHoldings(missing, wallet), {items: [], reasons: []}); assert.equal(existsSync(missing), false);
    assert.deepEqual(readControlledHoldings(f.path, 'invalid'), {items: [], reasons: ['CONTROLLED_HOLDINGS_WALLET_INVALID']});
    const broken = join(f.dir, 'broken.sqlite'); writeFileSync(broken, 'not-sqlite-private-data');
    assert.deepEqual(readControlledHoldings(broken, wallet), {items: [], reasons: ['CONTROLLED_HOLDINGS_READ_FAILED']});
  } finally {globalThis.fetch = originalFetch; f.close();}
});
