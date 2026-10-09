import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {readConfig} from '../src/config.js';
import {readPositionBalance} from '../src/position-balance.js';
import type {OpeningOrder} from '../src/orders.js';
import type {Fetcher} from '../src/http.js';

const wallet = '0x' + '2'.repeat(40), token = '0x' + '3'.repeat(40);
const txHash = '0x' + 'a'.repeat(64), blockHash = '0x' + 'b'.repeat(64);
const config = {...readConfig({}), rpc: {bsc: 'https://bsc.invalid', robinhood: 'https://rh.invalid', solana: 'https://sol.invalid'}};
const evm = (chain: 'bsc' | 'robinhood' = 'bsc'): Pick<OpeningOrder, 'chain' | 'wallet' | 'tokenAddress' | 'transactionHash'> =>
  ({chain, wallet, tokenAddress: token, transactionHash: txHash});
const solWallet = bs58.encode(new Uint8Array(32).fill(1)), mint = bs58.encode(new Uint8Array(32).fill(2));
const signature = bs58.encode(new Uint8Array(64).fill(3));
const solOrder = {chain: 'solana', wallet: solWallet, tokenAddress: mint, transactionHash: signature} as const;
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const receipt = () => ({status: '0x1', transactionHash: txHash, blockNumber: '0x64', blockHash});
const statuses = () => ({context: {slot: 110}, value: [{slot: 100, err: null, confirmationStatus: 'finalized', status: {Ok: null}}]});
const account = (amount = '0', index = 4, program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') => ({
  pubkey: bs58.encode(new Uint8Array(32).fill(index)), account: {owner: program, executable: false,
    data: {program: 'spl-token', parsed: {type: 'account', info: {owner: solWallet, mint,
      tokenAmount: {amount, decimals: 9, uiAmount: 0, uiAmountString: '0'}}}}},
});
function mocked(values: Record<string, unknown>, error?: (method: string) => Response | undefined) {
  const calls: {method: string; params: unknown[]; url: string; init?: RequestInit}[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({...body, url: String(input), init});
    const failure = error?.(body.method); if (failure) return failure;
    if (!Object.hasOwn(values, body.method)) throw new Error('UNEXPECTED_RPC_METHOD');
    return Response.json({jsonrpc: '2.0', id: body.id, result: values[body.method]});
  };
  return {fetcher, calls};
}
const evmResults = (balance: unknown = word(0n)) => ({eth_chainId: '0x38', eth_getTransactionReceipt: receipt(),
  eth_blockNumber: '0x80', eth_getBlockByNumber: {number: '0x64', hash: blockHash}, eth_call: balance});
const solResults = (value: unknown[] = []) => ({getGenesisHash: genesis, getSignatureStatuses: statuses(),
  getTokenAccountsByOwner: {context: {slot: 110}, value}});
function expectUnknown(result: Awaited<ReturnType<typeof readPositionBalance>>, reason?: string) {
  assert.equal(result.status, 'unknown'); assert.equal(Object.hasOwn(result, 'amount'), false);
  assert.equal(Number.isFinite(Date.parse(result.checkedAt)), true);
  if (reason) assert.deepEqual(result.reasons, [reason]);
}

test('EVM zero is verified only after buy finality and uses a historical balanceOf block', async () => {
  const ctx = mocked(evmResults());
  const result = await readPositionBalance(evm(), config, ctx.fetcher);
  assert.equal(result.status, 'verified'); assert.equal(result.amount, '0');
  assert.deepEqual(ctx.calls.map(c => c.method), ['eth_chainId', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call']);
  assert.deepEqual(ctx.calls.at(-1)?.params, [{to: token, data: '0x70a08231' + wallet.slice(2).padStart(64, '0')}, '0x74']);
  for (const call of ctx.calls) {
    assert.equal(call.init?.redirect, 'error'); assert.ok(call.init?.signal instanceof AbortSignal);
    assert.equal(new Headers(call.init?.headers).has('authorization'), false);
  }
});

test('EVM balances preserve uint256 precision on BSC and Robinhood', async () => {
  const maximum = (1n << 256n) - 1n;
  for (const chain of ['bsc', 'robinhood'] as const) {
    const ctx = mocked({...evmResults(word(maximum)), eth_chainId: chain === 'bsc' ? '0x38' : '0x1237'});
    assert.equal((await readPositionBalance(evm(chain), config, ctx.fetcher)).amount, maximum.toString());
    assert.equal(ctx.calls[0].url, config.rpc[chain]);
  }
});

test('missing or malformed order identity and RPC configuration never issue RPCs', async () => {
  const ctx = mocked({});
  expectUnknown(await readPositionBalance(evm(), {...config, rpc: {}}, ctx.fetcher), 'POSITION_RPC_NOT_CONFIGURED');
  for (const patch of [{wallet: 'not-address'}, {wallet: '0x' + '0'.repeat(40)}, {tokenAddress: '0x' + '0'.repeat(40)},
    {transactionHash: undefined}, {transactionHash: '0x123'}])
    expectUnknown(await readPositionBalance({...evm(), ...patch}, config, ctx.fetcher), 'POSITION_ORDER_INVALID');
  expectUnknown(await readPositionBalance({...solOrder, transactionHash: solWallet}, config, ctx.fetcher), 'POSITION_ORDER_INVALID');
  assert.equal(ctx.calls.length, 0);
});

test('wrong chain, missing/failed/mismatched buy receipt never reach balanceOf', async () => {
  for (const change of [{eth_chainId: '0x1'}, {eth_chainId: 56}, {eth_getTransactionReceipt: null},
    {eth_getTransactionReceipt: {...receipt(), status: '0x0'}},
    {eth_getTransactionReceipt: {...receipt(), transactionHash: blockHash}},
    {eth_getTransactionReceipt: {...receipt(), blockNumber: '100'}},
    {eth_getTransactionReceipt: {...receipt(), blockHash: undefined}}]) {
    const ctx = mocked({...evmResults(), ...change});
    expectUnknown(await readPositionBalance(evm(), config, ctx.fetcher));
    assert.equal(ctx.calls.some(c => c.method === 'eth_call'), false);
  }
});

test('EVM buy needs twelve blocks and an unchanged canonical receipt block', async () => {
  for (const change of [{eth_blockNumber: '0x6f'}, {eth_blockNumber: '0x63'}, {eth_blockNumber: 128},
    {eth_getBlockByNumber: null}, {eth_getBlockByNumber: {number: '0x64', hash: txHash}},
    {eth_getBlockByNumber: {number: '0x65', hash: blockHash}}]) {
    const ctx = mocked({...evmResults(), ...change});
    expectUnknown(await readPositionBalance(evm(), config, ctx.fetcher));
    assert.equal(ctx.calls.some(c => c.method === 'eth_call'), false);
  }
  const ctx = mocked({...evmResults(), eth_blockNumber: '0x70'});
  assert.equal((await readPositionBalance(evm(), config, ctx.fetcher)).amount, '0');
  assert.equal(ctx.calls.at(-1)?.params[1], '0x64');
});

test('empty ABI return, truncated values and oversized integers are not zero balances', async () => {
  for (const value of ['0x', '0x0', '0x00', '0', 0, null, '0x' + 'f'.repeat(65), '0x' + 'g'.repeat(64)]) {
    const ctx = mocked(evmResults(value));
    expectUnknown(await readPositionBalance(evm(), config, ctx.fetcher), 'POSITION_BALANCE_RESPONSE_INVALID');
  }
});

test('RPC errors, HTTP failures and timeouts return fixed unknown reasons without secrets', async () => {
  for (const failure of [Response.json({error: {code: -32000, message: 'SECRET URL/key'}}),
    new Response('SECRET URL/key', {status: 429}), new Response('broken')]) {
    const ctx = mocked(evmResults(), () => failure);
    const result = await readPositionBalance(evm(), config, ctx.fetcher);
    expectUnknown(result, 'POSITION_RPC_UNAVAILABLE'); assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
  const result = await readPositionBalance(evm(), config, async () => {throw new DOMException('SECRET', 'TimeoutError');});
  expectUnknown(result, 'POSITION_RPC_UNAVAILABLE'); assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('Solana finalized empty owner list is zero and requests history with a finalized minimum slot', async () => {
  const ctx = mocked(solResults());
  const result = await readPositionBalance(solOrder, config, ctx.fetcher);
  assert.equal(result.status, 'verified'); assert.equal(result.amount, '0');
  assert.deepEqual(ctx.calls.map(c => c.method), ['getGenesisHash', 'getSignatureStatuses', 'getTokenAccountsByOwner']);
  assert.deepEqual(ctx.calls[1].params, [[signature], {searchTransactionHistory: true}]);
  assert.deepEqual(ctx.calls[2].params, [solWallet, {mint}, {encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: 100}]);
});

test('Solana sums all token accounts using exact amount strings including Token-2022', async () => {
  const ctx = mocked(solResults([account('9007199254740993'), account('999', 5,
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')]));
  const result = await readPositionBalance(solOrder, config, ctx.fetcher);
  assert.equal(result.status, 'verified'); assert.equal(result.amount, '9007199254741992');
});

test('Solana requires complete genesis, a successful finalized signature, and an integer slot', async () => {
  for (const change of [{getGenesisHash: genesis.slice(0, 32)}, {getGenesisHash: 'devnet'},
    {getSignatureStatuses: {value: [null]}}, {getSignatureStatuses: {value: []}},
    {getSignatureStatuses: {value: [{slot: 100, err: {}, confirmationStatus: 'finalized'}]}},
    {getSignatureStatuses: {value: [{slot: 100, confirmationStatus: 'finalized'}]}},
    {getSignatureStatuses: {value: [{slot: 100, err: null, confirmationStatus: 'confirmed'}]}},
    {getSignatureStatuses: {value: [{slot: 100.1, err: null, confirmationStatus: 'finalized'}]}},
    {getSignatureStatuses: {value: [{slot: 100, err: null, confirmationStatus: 'finalized', status: {Err: 'contradiction'}}]}}]) {
    const ctx = mocked({...solResults(), ...change});
    expectUnknown(await readPositionBalance(solOrder, config, ctx.fetcher));
    assert.equal(ctx.calls.some(c => c.method === 'getTokenAccountsByOwner'), false);
  }
});

test('stale or malformed Solana balance context cannot release a position from an empty result', async () => {
  for (const value of [{context: {slot: 99}, value: []}, {context: {slot: '110'}, value: []},
    {value: []}, {context: {slot: 110}, value: null}]) {
    const ctx = mocked({...solResults(), getTokenAccountsByOwner: value});
    expectUnknown(await readPositionBalance(solOrder, config, ctx.fetcher));
  }
});

test('Solana rejects mismatched owners/mints, malformed account schemas and duplicate accounts', async () => {
  const badOwner = account(); badOwner.account.data.parsed.info.owner = mint;
  const badMint = account(); badMint.account.data.parsed.info.mint = solWallet;
  const badType = account(); badType.account.data.parsed.type = 'mint';
  const executable = account(); executable.account.executable = true;
  for (const rows of [[badOwner], [badMint], [badType], [executable], [account('0', 4, solWallet)],
    [account(), account()], [{...account(), pubkey: 'invalid'}], [{...account(), account: {data: ['not parsed']}}]]) {
    const ctx = mocked(solResults(rows));
    expectUnknown(await readPositionBalance(solOrder, config, ctx.fetcher), 'POSITION_TOKEN_ACCOUNT_INVALID');
  }
});

test('Solana rejects malformed atomic amounts and uint64 total overflow', async () => {
  for (const amount of ['-1', '1.5', '1e9', '', '01']) {
    const ctx = mocked(solResults([account(amount)]));
    expectUnknown(await readPositionBalance(solOrder, config, ctx.fetcher), 'POSITION_TOKEN_ACCOUNT_INVALID');
  }
  const numeric = account(); (numeric.account.data.parsed.info.tokenAmount as Record<string, unknown>).amount = 0;
  expectUnknown(await readPositionBalance(solOrder, config, mocked(solResults([numeric])).fetcher), 'POSITION_TOKEN_ACCOUNT_INVALID');
  const max = (1n << 64n) - 1n;
  assert.equal((await readPositionBalance(solOrder, config, mocked(solResults([account(max.toString())])).fetcher)).amount, max.toString());
  for (const rows of [[account((max + 1n).toString())], [account(max.toString()), account('1', 5)]])
    expectUnknown(await readPositionBalance(solOrder, config, mocked(solResults(rows)).fetcher), 'POSITION_AMOUNT_OVERFLOW');
});
