import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicKey, generateKeyPairSync} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/config.js';
import {buildExitConditions} from '../src/exit-policy.js';

const authorized = () => ({
  enabled: true,
  sellRatioType: 'hold_amount',
  takeProfit: [{gainPct: 100, sellPct: 50}],
  stopLoss: {dropPct: 60, sellPct: 100},
});

function temporaryDirectory(t: {after: (fn: () => void) => void}): string {
  const path = mkdtempSync(join(tmpdir(), 'meme-exit-config-'));
  t.after(() => rmSync(path, {recursive: true, force: true}));
  return path;
}

function redactedError(run: () => unknown, expected: string, forbidden: string[]): void {
  assert.throws(run, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expected);
    for (const text of forbidden) assert.equal(String(error).includes(text), false);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('explicit policy path loads the exact owner JSON and uses current-holding percentages', t => {
  const dir = temporaryDirectory(t);
  const path = join(dir, 'owner policy.json');
  writeFileSync(path, JSON.stringify(authorized()), {mode: 0o600});
  const config = readConfig({EXIT_POLICY_PATH: path});
  assert.deepEqual(config.exitPolicy, authorized());
  assert.equal(config.exitPolicy?.sellRatioType, 'hold_amount');
  assert.deepEqual(buildExitConditions(config.exitPolicy!).map(order => [order.price_scale, order.sell_ratio]),
    [['100', '50'], ['60', '100']]);
  assert.equal(config.entryMode, 'off');
  writeFileSync(path, JSON.stringify({enabled: false}), {mode: 0o600});
  assert.equal(readConfig({EXIT_POLICY_PATH: path}).exitPolicy, undefined);
  // Reading a disabled replacement does not mutate the already loaded owner's policy.
  assert.equal(config.exitPolicy?.takeProfit[0].sellPct, 50);
});

test('missing, malformed or unauthorized policy files fail startup with a redacted configuration error', t => {
  const dir = temporaryDirectory(t);
  const marker = 'PRIVATE_OWNER_SETTINGS_SENTINEL';
  const path = join(dir, `${marker}.json`);
  redactedError(() => readConfig({EXIT_POLICY_PATH: path}), 'EXIT_POLICY_CONFIG_INVALID', [marker, path]);
  redactedError(() => readConfig({EXIT_POLICY_PATH: dir}), 'EXIT_POLICY_CONFIG_INVALID', [dir]);
  for (const content of ['', '{', `{"secret":"${marker}"`, 'null', '[]', '{}',
    JSON.stringify({...authorized(), sellRatioType: 'buy_amount'}),
    JSON.stringify({...authorized(), stopLoss: {dropPct: 40, sellPct: 100}}),
    JSON.stringify({...authorized(), stopLoss: {dropPct: 60, sellPct: 99}}),
    JSON.stringify({...authorized(), apiKey: marker})]) {
    writeFileSync(path, content, {mode: 0o600});
    redactedError(() => readConfig({EXIT_POLICY_PATH: path}), 'EXIT_POLICY_CONFIG_INVALID', [marker, path]);
  }
});

test('no policy path leaves exits disabled and preserves the preexisting entry defaults', () => {
  for (const env of [{}, {EXIT_POLICY_PATH: ''}, {EXIT_POLICY_PATH: '   '},
    {EXIT_POLICY: JSON.stringify(authorized())}]) {
    const config = readConfig(env);
    assert.equal(config.exitPolicy, undefined);
    assert.equal(config.entryMode, 'off');
    assert.equal(config.entrySlippagePct, 5);
    assert.equal(config.entryMaxOpen, 3);
    assert.equal(config.gmgnPrivateKey, undefined);
    assert.equal(config.scannerEnabled, false);
    assert.deepEqual(Object.values(config.entryWallets), [undefined, undefined, undefined]);
    assert.deepEqual(Object.values(config.entryAmounts), [undefined, undefined, undefined]);
    assert.equal(config.entryGasPriceBsc, '50000000');
    assert.equal(config.entryPriorityFeeSolana, '0.00001');
    assert.equal(config.entryTipFeeSolana, '0.00001');
  }
});

test('signing PEM can be loaded from an explicit temporary file without reading the actual environment', t => {
  const dir = temporaryDirectory(t);
  const path = join(dir, 'synthetic signer.pem');
  const generated = generateKeyPairSync('ed25519');
  const pem = generated.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
  writeFileSync(path, pem, {mode: 0o600});
  const config = readConfig({GMGN_PRIVATE_KEY_FILE: path});
  assert.ok(config.gmgnPrivateKey);
  assert.equal(createPublicKey(config.gmgnPrivateKey!).equals(generated.publicKey), true);
  assert.equal(config.entryMode, 'off');
  assert.equal(config.exitPolicy, undefined);
  const blankInline = readConfig({GMGN_PRIVATE_KEY: '   ', GMGN_PRIVATE_KEY_FILE: path});
  assert.equal(createPublicKey(blankInline.gmgnPrivateKey!).equals(generated.publicKey), true);
});

test('inline signing key takes priority, restores escaped newlines and does not access a missing key file', t => {
  const dir = temporaryDirectory(t);
  const generated = generateKeyPairSync('ed25519');
  const pem = generated.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
  const config = readConfig({GMGN_PRIVATE_KEY: `  ${pem.replace(/\n/g, '\\n')}  `,
    GMGN_PRIVATE_KEY_FILE: join(dir, 'must-not-be-read.pem')});
  assert.equal(createPublicKey(config.gmgnPrivateKey!).equals(generated.publicKey), true);
});

test('unreadable signing-key files produce no filesystem path or underlying exception details', t => {
  const dir = temporaryDirectory(t);
  const marker = 'SYNTHETIC_SECRET_PATH_SENTINEL';
  const path = join(dir, `${marker}.pem`);
  redactedError(() => readConfig({GMGN_PRIVATE_KEY_FILE: path}), 'GMGN_SIGNING_KEY_FILE_UNREADABLE',
    [marker, path, 'ENOENT']);
  redactedError(() => readConfig({GMGN_PRIVATE_KEY_FILE: dir}), 'GMGN_SIGNING_KEY_FILE_UNREADABLE',
    [dir, 'EISDIR']);
});

test('BSC gas values are bounded integer wei and never interpreted as gwei or token amounts', () => {
  for (const value of ['50000000', '100000000', '10000000000']) {
    assert.equal(readConfig({ENTRY_GAS_PRICE_BSC_WEI: value}).entryGasPriceBsc, value);
  }
  for (const value of ['', '0', '-1', '49999999', '10000000001', '0.05', '0.00000000005',
    '5e7', '50000000.0', ' 50000000 ', 'NaN', 'Infinity', '1000000000000000000']) {
    assert.throws(() => readConfig({ENTRY_GAS_PRICE_BSC_WEI: value}));
  }
});

test('Solana priority and tip fees are decimal SOL with inclusive 0.00001 to 0.01 limits', () => {
  for (const name of ['ENTRY_PRIORITY_FEE_SOLANA', 'ENTRY_TIP_FEE_SOLANA'] as const) {
    for (const value of ['0.00001', '0.000010001', '0.001', '0.01', '0.010000000']) {
      const config = readConfig({[name]: value});
      assert.equal(name === 'ENTRY_PRIORITY_FEE_SOLANA' ? config.entryPriorityFeeSolana : config.entryTipFeeSolana,
        value);
    }
    for (const value of ['', '0', '-0.00001', '0.000009999', '0.010000001', '0.1', '1', '10000',
      '1e-5', '0.0000100001', '.00001', 'NaN', 'Infinity', ' 0.00001 ']) {
      assert.throws(() => readConfig({[name]: value}));
    }
  }
});
