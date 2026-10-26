import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {ControlledSolanaError, ControlledSolanaReader} from '../src/controlled-test/solana.js';

const address = (byte: number) => bs58.encode(new Uint8Array(32).fill(byte));
const wallet = address(1), mint = address(2), tokenAccount = address(3), secondAccount = address(4), other = address(5);
const signature = bs58.encode(new Uint8Array(64).fill(6));
const SYSTEM = '11111111111111111111111111111111';
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const url = 'https://rpc.invalid/?api-key=secret';
const request = {signature, wallet, mint, side: 'buy' as const, expectedTokenAmount: '1000000', maxNativeDebitLamports: '10005000'};
const error = (code: string) => (value: unknown) => value instanceof ControlledSolanaError && value.reason === code;
function mintAccount(program = SPL): any {
  return {owner: program, executable: false, data: {parsed: {type: 'mint', info: {
    isInitialized: true, decimals: 6, supply: '18446744073709551615', mintAuthority: other, freezeAuthority: null,
    ...(program === TOKEN2022 ? {extensions: []} : {})}}}};
}
function account(amount = '100', pubkey = tokenAccount, program = SPL): any {
  return {pubkey, account: {owner: program, executable: false, data: {parsed: {type: 'account', info: {
    owner: wallet, mint, state: 'initialized', tokenAmount: {amount, decimals: 6},
    ...(program === TOKEN2022 ? {extensions: []} : {})}}}}};
}
function snapshotValues(): Record<string, any> {
  return {getGenesisHash: genesis,
    getMultipleAccounts: {context: {slot: 100}, value: [{owner: SYSTEM, executable: false, lamports: 123456789}, mintAccount()]},
    getTokenAccountsByOwner: {context: {slot: 101}, value: [account('9007199254740993'), account('8', secondAccount)]}};
}
function tokenBalance(amount: string, accountIndex = 1, owner = wallet): any {
  return {accountIndex, mint, owner, programId: SPL, uiTokenAmount: {amount, decimals: 6, uiAmount: 0}};
}
function transactionValues(side: 'buy' | 'sell' = 'buy'): Record<string, any> {
  const buy = side === 'buy';
  return {getGenesisHash: genesis,
    getSignatureStatuses: {context: {slot: 110}, value: [{slot: 100, err: null, confirmationStatus: 'finalized', status: {Ok: null}}]},
    getTransaction: {slot: 100, transaction: {signatures: [signature], message: {accountKeys: [
      {pubkey: wallet, signer: true, writable: true}, {pubkey: tokenAccount, signer: false, writable: true},
      {pubkey: other, signer: false, writable: true}]}}, meta: {err: null, fee: 5000,
      preBalances: [buy ? 100000000 : 89995000, 2039280, 0],
      postBalances: [buy ? 89995000 : 99990000, 2039280, 0],
      preTokenBalances: [tokenBalance(buy ? '10' : '1000010')],
      postTokenBalances: [tokenBalance(buy ? '1000010' : '10')]}}};
}
function mocked(values: Record<string, unknown>, respond?: (method: string, id: number) => Response | undefined) {
  const calls: {method: string; params: any[]; init?: RequestInit; url: string}[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({...body, init, url: String(input)});
    const response = respond?.(body.method, body.id); if (response) return response;
    assert.ok(Object.hasOwn(values, body.method), 'Unexpected RPC method');
    return Response.json({jsonrpc: '2.0', id: body.id, result: values[body.method]});
  };
  return {calls, reader: new ControlledSolanaReader(url, {fetcher})};
}

test('snapshot verifies mainnet and exact aggregate token amounts across all owner accounts', async () => {
  const ctx = mocked(snapshotValues());
  const result = await ctx.reader.snapshot(wallet, mint);
  assert.equal(result.nativeLamports, '123456789');
  assert.equal(result.tokenAmount, '9007199254741001');
  assert.equal(result.nativeSlot, 100); assert.equal(result.slot, 101);
  assert.equal(result.decimals, 6); assert.equal(result.mintAuthority, other); assert.equal(result.freezeAuthority, null);
  assert.deepEqual(ctx.calls.map(call => call.method), ['getGenesisHash', 'getMultipleAccounts', 'getTokenAccountsByOwner']);
  assert.deepEqual(ctx.calls[2].params, [wallet, {mint}, {encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: 100}]);
  for (const call of ctx.calls) {
    assert.equal(call.url, url); assert.equal(call.init?.redirect, 'error'); assert.equal(call.init?.credentials, 'omit');
    assert.ok(call.init?.signal); assert.equal(call.init?.method, 'POST');
    assert.ok(!['sendTransaction', 'requestAirdrop', 'simulateTransaction'].includes(call.method));
  }
});

test('snapshot supports an empty balance and metadata-only known Token-2022 extensions', async () => {
  const values = snapshotValues(); values.getTokenAccountsByOwner.value = [];
  assert.equal((await mocked(values).reader.snapshot(wallet, mint)).tokenAmount, '0');
  values.getMultipleAccounts.value[1] = mintAccount(TOKEN2022);
  values.getMultipleAccounts.value[1].data.parsed.info.extensions = [{extension: 'metadataPointer', state: {authority: other}}];
  values.getTokenAccountsByOwner.value = [account('7', tokenAccount, TOKEN2022)];
  values.getTokenAccountsByOwner.value[0].account.data.parsed.info.extensions = [{extension: 'immutableOwner', state: {}}];
  const result = await mocked(values).reader.snapshot(wallet, mint);
  assert.equal(result.tokenAmount, '7'); assert.equal(result.tokenProgram, TOKEN2022);
  assert.deepEqual(result.extensions, ['immutableOwner', 'metadataPointer']);
});

test('snapshot rejects unknown extensions, uninitialized mints, incomplete authorities and unsafe native numbers', async () => {
  for (const mutate of [
    (v: any) => {v.getMultipleAccounts.value[1].data.parsed.info.isInitialized = false;},
    (v: any) => {delete v.getMultipleAccounts.value[1].data.parsed.info.mintAuthority;},
    (v: any) => {v.getMultipleAccounts.value[1].data.parsed.info.decimals = 256;},
    (v: any) => {v.getMultipleAccounts.value[0].lamports = Number.MAX_SAFE_INTEGER + 1;},
    (v: any) => {v.getMultipleAccounts.value[1] = mintAccount(TOKEN2022); delete v.getMultipleAccounts.value[1].data.parsed.info.extensions;},
    (v: any) => {v.getMultipleAccounts.value[1] = mintAccount(TOKEN2022); v.getMultipleAccounts.value[1].data.parsed.info.extensions = [{extension: 'transferHook', state: {}}];},
    (v: any) => {v.getMultipleAccounts.value[1].owner = wallet;},
  ]) {
    const values = snapshotValues(); mutate(values);
    await assert.rejects(mocked(values).reader.snapshot(wallet, mint), ControlledSolanaError);
  }
});

test('snapshot rejects duplicate accounts, wrong ownership/mint/program, frozen state, stale contexts and overflow', async () => {
  for (const mutate of [
    (v: any) => {v.getTokenAccountsByOwner.value = [account(), account()];},
    (v: any) => {v.getTokenAccountsByOwner.value[0].pubkey = 'invalid';},
    (v: any) => {v.getTokenAccountsByOwner.value[0].account.data.parsed.info.owner = other;},
    (v: any) => {v.getTokenAccountsByOwner.value[0].account.data.parsed.info.mint = other;},
    (v: any) => {v.getTokenAccountsByOwner.value[0].account.owner = TOKEN2022;},
    (v: any) => {v.getTokenAccountsByOwner.value[0].account.data.parsed.info.state = 'frozen';},
    (v: any) => {v.getTokenAccountsByOwner.context.slot = 99;},
    (v: any) => {v.getTokenAccountsByOwner.value[0].account.data.parsed.info.tokenAmount.amount = '18446744073709551616';},
    (v: any) => {v.getTokenAccountsByOwner.value = [account('18446744073709551615'), account('1', secondAccount)];},
    (v: any) => {v.getTokenAccountsByOwner.value[0].account.data.parsed.info.tokenAmount.amount = 7;},
    (v: any) => {v.getTokenAccountsByOwner.value[0].account.data.parsed.info.tokenAmount.decimals = 9;},
  ]) {
    const values = snapshotValues(); mutate(values);
    await assert.rejects(mocked(values).reader.snapshot(wallet, mint), ControlledSolanaError);
  }
});

test('transaction proof binds finalized signature, payer, successful receipt and exact buy/sell deltas', async () => {
  for (const side of ['buy', 'sell'] as const) {
    const ctx = mocked(transactionValues(side));
    const result = await ctx.reader.verifyTransaction({...request, side});
    assert.equal(result.signature, signature); assert.equal(result.slot, 100);
    assert.equal(result.tokenDelta, side === 'buy' ? '1000000' : '-1000000');
    assert.equal(result.nativeDelta, side === 'buy' ? '-10005000' : '9995000');
    assert.equal(result.feeLamports, '5000');
    assert.equal(result.postTokenAmount, side === 'buy' ? '1000010' : '10');
    assert.deepEqual(ctx.calls.map(call => call.method), ['getGenesisHash', 'getSignatureStatuses', 'getTransaction']);
    assert.deepEqual(ctx.calls[2].params, [signature, {encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1}]);
  }
});

test('parsed v1 transactions preserve every sell proof check and future versions are rejected',async()=>{
  const values=transactionValues('sell') as any;values.getTransaction.version=1;
  const result=await mocked(values).reader.verifyTransaction({...request,side:'sell'});
  assert.equal(result.tokenDelta,'-1000000');assert.equal(result.signature,signature);
  for(const version of [2,'1','future']){
    const bad=transactionValues('sell') as any;bad.getTransaction.version=version;
    await assert.rejects(mocked(bad).reader.verifyTransaction({...request,side:'sell'}),/TEST_SOLANA_TRANSACTION_VERSION_UNSUPPORTED/);
  }
  const bad=transactionValues('sell') as any;bad.getTransaction.version=1;bad.getTransaction.transaction.message.accountKeys[0].signer=false;
  await assert.rejects(mocked(bad).reader.verifyTransaction({...request,side:'sell'}),/TEST_SOLANA_TRANSACTION_PAYER_MISMATCH/);
});

test('new or closed token accounts are treated as zero only on the absent side and exact large token strings survive', async () => {
  const buy = transactionValues(); buy.getTransaction.meta.preTokenBalances = [];
  buy.getTransaction.meta.postTokenBalances = [tokenBalance('9007199254740993')];
  assert.equal((await mocked(buy).reader.verifyTransaction({...request, expectedTokenAmount: '9007199254740993'})).tokenDelta, '9007199254740993');
  const sell = transactionValues('sell'); sell.getTransaction.meta.postTokenBalances = [];
  sell.getTransaction.meta.preTokenBalances = [tokenBalance('1000000')];
  assert.equal((await mocked(sell).reader.verifyTransaction({...request, side: 'sell'})).postTokenAmount, '0');
});

test('failed, unfinalized or mismatched transaction evidence never produces a fill proof', async () => {
  for (const mutate of [
    (v: any) => {v.getSignatureStatuses.value[0].confirmationStatus = 'confirmed';},
    (v: any) => {v.getSignatureStatuses.value[0].err = {InstructionError: 'failed'};},
    (v: any) => {v.getSignatureStatuses.value[0].status = {Err: 'failed'};},
    (v: any) => {v.getSignatureStatuses.context.slot = 99;},
    (v: any) => {v.getTransaction.slot = 101;},
    (v: any) => {v.getTransaction.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(7));},
    (v: any) => {v.getTransaction.meta.err = {InstructionError: 'failed'};},
    (v: any) => {v.getTransaction.transaction.message.accountKeys[0].pubkey = other;},
    (v: any) => {v.getTransaction.transaction.message.accountKeys[0].signer = false;},
    (v: any) => {v.getTransaction.transaction.message.accountKeys[0].writable = false;},
    (v: any) => {v.getTransaction.transaction.message.accountKeys[1].pubkey = wallet;},
  ]) {
    const values = transactionValues(); mutate(values);
    await assert.rejects(mocked(values).reader.verifyTransaction(request), ControlledSolanaError);
  }
});

test('trade direction, amount and total native debit bounds must match the caller request', async () => {
  await assert.rejects(mocked(transactionValues()).reader.verifyTransaction({...request, side: 'sell'}), error('TEST_SOLANA_TRADE_DIRECTION_MISMATCH'));
  await assert.rejects(mocked(transactionValues()).reader.verifyTransaction({...request, expectedTokenAmount: '999999'}), error('TEST_SOLANA_TOKEN_AMOUNT_MISMATCH'));
  await assert.rejects(mocked(transactionValues()).reader.verifyTransaction({...request, maxNativeDebitLamports: '10004999'}), error('TEST_SOLANA_NATIVE_DEBIT_EXCEEDED'));
  const transferredOnly = transactionValues(); transferredOnly.getTransaction.meta.postBalances[0] = 100000000;
  await assert.rejects(mocked(transferredOnly).reader.verifyTransaction(request), error('TEST_SOLANA_TRADE_DIRECTION_MISMATCH'));
});

test('token metadata cannot attribute other wallets or mints, missing owners, duplicated indices or authority transfers to our trade', async () => {
  for (const mutate of [
    (v: any) => {delete v.getTransaction.meta.postTokenBalances[0].owner;},
    (v: any) => {v.getTransaction.meta.postTokenBalances[0].owner = other;},
    (v: any) => {v.getTransaction.meta.postTokenBalances[0].mint = other;},
    (v: any) => {v.getTransaction.meta.postTokenBalances[0].programId = other;},
    (v: any) => {v.getTransaction.meta.postTokenBalances.push(v.getTransaction.meta.postTokenBalances[0]);},
    (v: any) => {v.getTransaction.meta.postTokenBalances[0].accountIndex = 1000;},
    (v: any) => {v.getTransaction.meta.postTokenBalances[0].uiTokenAmount.decimals = 9;},
    (v: any) => {v.getTransaction.meta.postTokenBalances[0].uiTokenAmount.amount = '01';},
    (v: any) => {delete v.getTransaction.meta.preTokenBalances;},
    (v: any) => {v.getTransaction.meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1;},
    (v: any) => {v.getTransaction.meta.postBalances.pop();},
    (v: any) => {v.getTransaction.meta.fee = 0.1;},
  ]) {
    const values = transactionValues(); mutate(values);
    await assert.rejects(mocked(values).reader.verifyTransaction(request), ControlledSolanaError);
  }
});

test('wrong cluster and invalid input fail before later network operations', async () => {
  const ctx = mocked({...snapshotValues(), getGenesisHash: 'devnet'});
  await assert.rejects(ctx.reader.snapshot(wallet, mint), error('TEST_SOLANA_CHAIN_MISMATCH'));
  assert.equal(ctx.calls.length, 1);
  for (const pair of [[SYSTEM, mint], [wallet, SYSTEM], ['bad', mint], [wallet, wallet]])
    await assert.rejects(ctx.reader.snapshot(pair[0], pair[1]), error('TEST_SOLANA_IDENTITY_INVALID'));
  for (const patch of [{signature: wallet}, {expectedTokenAmount: '0'}, {maxNativeDebitLamports: '-1'}, {side: 'transfer'}])
    await assert.rejects(ctx.reader.verifyTransaction({...request, ...patch} as any), error('TEST_SOLANA_TRANSACTION_REQUEST_INVALID'));
  assert.equal(ctx.calls.length, 1);
});

test('fixed method whitelist prohibits broadcast even if private RPC helper is reached at runtime', async () => {
  const ctx = mocked({});
  await assert.rejects((ctx.reader as any).rpc('sendTransaction', ['signed-secret'], AbortSignal.timeout(100)),
    error('TEST_SOLANA_RPC_METHOD_DENIED'));
  assert.equal(ctx.calls.length, 0);
  for (const bad of ['file:///secret', 'https://user:password@rpc.invalid/', 'https://rpc.invalid/#fragment', 'bad'])
    assert.throws(() => new ControlledSolanaReader(bad), error('TEST_SOLANA_RPC_URL_INVALID'));
});

test('RPC timeout, provider errors, redirects and malformed envelopes are bounded and redacted', async () => {
  for (const response of [new Response('secret', {status: 429}), new Response('secret', {status: 502}),
    new Response('{}', {status: 302, headers: {location: 'https://secret.invalid'}}),
    Response.json({jsonrpc: '2.0', id: 1, error: {message: 'secret'}}),
    Response.json({jsonrpc: '2.0', id: 99, result: genesis}), new Response('secret')]) {
    const ctx = mocked(snapshotValues(), () => response);
    await assert.rejects(ctx.reader.snapshot(wallet, mint), value => {
      assert.ok(value instanceof ControlledSolanaError); assert.ok(!value.message.includes('secret')); return true;
    });
  }
  const reader = new ControlledSolanaReader(url, {fetcher: async () => {throw new DOMException('secret', 'TimeoutError');}});
  await assert.rejects(reader.snapshot(wallet, mint), error('TEST_SOLANA_RPC_TIMEOUT'));
});

test('response size limits bound both announced and streamed bodies', async () => {
  for (const response of [new Response('{}', {headers: {'content-length': String(2 * 1024 * 1024 + 1)}}),
    new Response(new Uint8Array(2 * 1024 * 1024 + 1))])
    await assert.rejects(mocked(snapshotValues(), () => response).reader.snapshot(wallet, mint),
      error('TEST_SOLANA_RPC_RESPONSE_TOO_LARGE'));
});
