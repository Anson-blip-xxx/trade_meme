import bs58 from 'bs58';
import {abortable} from '../http.js';
import type {SolanaSnapshot, TestChainReader, VerifiedSolanaTransaction, VerifySolanaTransaction} from './types.js';

const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SYSTEM = '11111111111111111111111111111111';
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const PROGRAMS = new Set([SPL, TOKEN2022]);
const METHODS = new Set(['getGenesisHash', 'getMultipleAccounts', 'getTokenAccountsByOwner', 'getSignatureStatuses', 'getTransaction']);
const U64 = (1n << 64n) - 1n;
const MAX_BYTES = 2 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const decimals = (value: unknown): value is number => uint(value) && value <= 255;
const amount = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= U64;
function base58(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try {const bytes = bs58.decode(value); return bytes.length === length && bs58.encode(bytes) === value;}
  catch {return false;}
}
function identity(wallet: string, mint: string): boolean {
  return base58(wallet, 32) && wallet !== SYSTEM && base58(mint, 32) && mint !== SYSTEM && wallet !== mint;
}
export class ControlledSolanaError extends Error {
  constructor(readonly reason: string) {super(reason); this.name = 'ControlledSolanaError';}
}
function fail(reason: string): never {throw new ControlledSolanaError(reason);}
function extensionNames(info: Record<string, unknown>, program: string, kind: 'mint' | 'account'): string[] {
  if (info.extensions === undefined) {
    if (program === TOKEN2022) fail('TEST_SOLANA_EXTENSIONS_UNKNOWN');
    return [];
  }
  if (!Array.isArray(info.extensions)) fail('TEST_SOLANA_EXTENSIONS_UNKNOWN');
  // These metadata-only extensions do not alter balances, transfers or authorities.
  // Any transfer hook/fee/delegate/confidential or newly introduced extension fails closed.
  const allowed = kind === 'mint' ? new Set(['metadataPointer', 'tokenMetadata']) : new Set(['immutableOwner']);
  const result: string[] = [];
  for (const ext of info.extensions) {
    if (!object(ext) || typeof ext.extension !== 'string' || !allowed.has(ext.extension) || result.includes(ext.extension) ||
        !object(ext.state)) fail('TEST_SOLANA_EXTENSIONS_UNSUPPORTED');
    result.push(ext.extension);
  }
  if (program === SPL && result.length) fail('TEST_SOLANA_EXTENSIONS_UNSUPPORTED');
  return result;
}
function parsedInfo(value: unknown, type: string, expectedProgram?: string): {info: Record<string, unknown>; program: string} {
  if (!object(value) || typeof value.owner !== 'string' || !PROGRAMS.has(value.owner) ||
      expectedProgram !== undefined && value.owner !== expectedProgram || value.executable !== false ||
      !object(value.data) || !object(value.data.parsed) || value.data.parsed.type !== type || !object(value.data.parsed.info))
    fail('TEST_SOLANA_ACCOUNT_INVALID');
  return {info: value.data.parsed.info, program: value.owner};
}
function authority(value: unknown): string | null {
  if (value === null || base58(value, 32)) return value;
  return fail('TEST_SOLANA_MINT_AUTHORITY_INVALID');
}

/** Read-only RPC verifier. Every call is pinned to an operator RPC and a fixed method allowlist. */
export class ControlledSolanaReader implements TestChainReader {
  private readonly fetcher: typeof fetch;
  private readonly url: string;
  private id = 0;
  constructor(rpcUrl: string, options: {fetcher?: typeof fetch} = {}) {
    try {
      const url = new URL(rpcUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
        fail('TEST_SOLANA_RPC_URL_INVALID');
      this.url = url.href;
    } catch {fail('TEST_SOLANA_RPC_URL_INVALID');}
    this.fetcher = options.fetcher ?? fetch;
  }
  private async rpc(method: string, params: unknown[], signal: AbortSignal): Promise<unknown> {
    if (!METHODS.has(method)) fail('TEST_SOLANA_RPC_METHOD_DENIED');
    const id = ++this.id;
    try {
      signal.throwIfAborted();
      const response = await abortable(this.fetcher(this.url, {method: 'POST', redirect: 'error', credentials: 'omit', signal,
        headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id, method, params})}), signal);
      if (response.redirected || response.status >= 300 && response.status < 400) fail('TEST_SOLANA_RPC_REDIRECT_DENIED');
      if (!response.ok) fail(response.status === 429 ? 'TEST_SOLANA_RPC_RATE_LIMITED' : 'TEST_SOLANA_RPC_HTTP_ERROR');
      if (!response.body) fail('TEST_SOLANA_RPC_RESPONSE_INVALID');
      if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        void response.body.cancel().catch(() => {}); fail('TEST_SOLANA_RPC_RESPONSE_TOO_LARGE');
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const {done, value} = await abortable(reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) fail('TEST_SOLANA_RPC_RESPONSE_TOO_LARGE');
          chunks.push(value);
        }
      } catch (error) {void reader.cancel().catch(() => {}); throw error;}
      finally {reader.releaseLock();}
      let envelope: unknown;
      try {envelope = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));}
      catch {fail('TEST_SOLANA_RPC_RESPONSE_INVALID');}
      if(object(envelope)&&object(envelope.error)&&envelope.error.code===-32015)
        fail('TEST_SOLANA_TRANSACTION_VERSION_UNSUPPORTED');
      if (!object(envelope) || envelope.jsonrpc !== '2.0' || envelope.id !== id || envelope.error !== undefined ||
          !Object.hasOwn(envelope, 'result')) fail('TEST_SOLANA_RPC_RESPONSE_INVALID');
      return envelope.result;
    } catch (error) {
      if (error instanceof ControlledSolanaError) throw error;
      fail(signal.aborted || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
        ? 'TEST_SOLANA_RPC_TIMEOUT' : 'TEST_SOLANA_RPC_UNAVAILABLE');
    }
  }
  private async mainnet(signal: AbortSignal): Promise<void> {
    if (await this.rpc('getGenesisHash', [], signal) !== GENESIS) fail('TEST_SOLANA_CHAIN_MISMATCH');
  }
  async snapshot(wallet: string, mint: string): Promise<SolanaSnapshot> {
    if (!identity(wallet, mint)) fail('TEST_SOLANA_IDENTITY_INVALID');
    const signal = AbortSignal.timeout(12_000);
    await this.mainnet(signal);
    const raw = await this.rpc('getMultipleAccounts', [[wallet, mint], {encoding: 'jsonParsed', commitment: 'finalized'}], signal);
    if (!object(raw) || !object(raw.context) || !uint(raw.context.slot) || !Array.isArray(raw.value) || raw.value.length !== 2)
      fail('TEST_SOLANA_SNAPSHOT_INVALID');
    const nativeSlot = raw.context.slot, native = raw.value[0];
    if (!object(native) || native.owner !== SYSTEM || native.executable !== false || !uint(native.lamports))
      fail('TEST_SOLANA_NATIVE_BALANCE_INVALID');
    const {info, program} = parsedInfo(raw.value[1], 'mint');
    if (info.isInitialized !== true || !decimals(info.decimals) || !amount(info.supply)) fail('TEST_SOLANA_MINT_INVALID');
    const mintAuthority = authority(info.mintAuthority), freezeAuthority = authority(info.freezeAuthority);
    const extensions = new Set(extensionNames(info, program, 'mint'));
    const accounts = await this.rpc('getTokenAccountsByOwner', [wallet, {mint},
      {encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: nativeSlot}], signal);
    if (!object(accounts) || !object(accounts.context) || !uint(accounts.context.slot) || accounts.context.slot < nativeSlot ||
        !Array.isArray(accounts.value)) fail('TEST_SOLANA_TOKEN_BALANCE_INVALID');
    let tokenAmount = 0n;
    const seen = new Set<string>();
    for (const row of accounts.value) {
      if (!object(row) || !base58(row.pubkey, 32) || seen.has(row.pubkey)) fail('TEST_SOLANA_TOKEN_ACCOUNT_INVALID');
      seen.add(row.pubkey);
      const account = parsedInfo(row.account, 'account', program).info;
      if (account.owner !== wallet || account.mint !== mint || account.state !== 'initialized' ||
          !object(account.tokenAmount) || !amount(account.tokenAmount.amount) || account.tokenAmount.decimals !== info.decimals)
        fail('TEST_SOLANA_TOKEN_ACCOUNT_INVALID');
      for (const extension of extensionNames(account, program, 'account')) extensions.add(extension);
      tokenAmount += BigInt(account.tokenAmount.amount);
      if (tokenAmount > U64 || tokenAmount > BigInt(info.supply)) fail('TEST_SOLANA_TOKEN_BALANCE_INVALID');
    }
    return {wallet, mint, nativeLamports: String(native.lamports), tokenAmount: tokenAmount.toString(), decimals: info.decimals,
      slot: accounts.context.slot, nativeSlot, mintAuthority, freezeAuthority, tokenProgram: program,
      extensions: [...extensions].sort(), checkedAt: new Date().toISOString()};
  }
  async verifyTransaction(request: VerifySolanaTransaction): Promise<VerifiedSolanaTransaction> {
    const {wallet, mint, signature, side} = request;
    if (!identity(wallet, mint) || !base58(signature, 64) || !['buy', 'sell'].includes(side) ||
        request.expectedTokenAmount !== undefined && (!amount(request.expectedTokenAmount) || request.expectedTokenAmount === '0') ||
        request.maxNativeDebitLamports !== undefined && !amount(request.maxNativeDebitLamports)) fail('TEST_SOLANA_TRANSACTION_REQUEST_INVALID');
    const signal = AbortSignal.timeout(12_000);
    await this.mainnet(signal);
    const statuses = await this.rpc('getSignatureStatuses', [[signature], {searchTransactionHistory: true}], signal);
    if (!object(statuses) || !object(statuses.context) || !uint(statuses.context.slot) || !Array.isArray(statuses.value) ||
        statuses.value.length !== 1 || !object(statuses.value[0])) fail('TEST_SOLANA_TRANSACTION_UNVERIFIED');
    const status = statuses.value[0];
    if (status.err !== null || !uint(status.slot) || status.slot > statuses.context.slot || status.confirmationStatus !== 'finalized' ||
        status.status !== undefined && (!object(status.status) || status.status.Ok !== null || Object.hasOwn(status.status, 'Err')))
      fail('TEST_SOLANA_TRANSACTION_NOT_FINALIZED');
    const raw = await this.rpc('getTransaction', [signature, {encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1}], signal);
    // v1 retains the parsed account/meta representation verified below. Future
    // versions still require an explicit review before accepting their proof.
    if(object(raw)&&raw.version!==undefined&&raw.version!=='legacy'&&raw.version!==0&&raw.version!==1)
      fail('TEST_SOLANA_TRANSACTION_VERSION_UNSUPPORTED');
    if (!object(raw) || raw.slot !== status.slot || !object(raw.meta) || raw.meta.err !== null || !object(raw.transaction) ||
        !Array.isArray(raw.transaction.signatures) || raw.transaction.signatures[0] !== signature ||
        raw.transaction.signatures.some(value => !base58(value, 64)) || !object(raw.transaction.message) ||
        !Array.isArray(raw.transaction.message.accountKeys)) fail('TEST_SOLANA_TRANSACTION_INVALID');
    const keys = raw.transaction.message.accountKeys;
    const addresses = new Set<string>();
    for (const key of keys) {
      if (!object(key) || !base58(key.pubkey, 32) || typeof key.signer !== 'boolean' || typeof key.writable !== 'boolean' ||
          addresses.has(key.pubkey)) fail('TEST_SOLANA_TRANSACTION_KEYS_INVALID');
      addresses.add(key.pubkey);
    }
    if (!object(keys[0]) || keys[0].pubkey !== wallet || keys[0].signer !== true || keys[0].writable !== true)
      fail('TEST_SOLANA_TRANSACTION_PAYER_MISMATCH');
    const meta = raw.meta;
    if (!uint(meta.fee) || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) ||
        meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length ||
        !meta.preBalances.every(uint) || !meta.postBalances.every(uint)) fail('TEST_SOLANA_NATIVE_DELTA_INVALID');
    const before = this.tokenBalances(meta.preTokenBalances, keys.length, mint, wallet);
    const after = this.tokenBalances(meta.postTokenBalances, keys.length, mint, wallet);
    if (before.decimals !== undefined && after.decimals !== undefined && before.decimals !== after.decimals)
      fail('TEST_SOLANA_TOKEN_DECIMALS_MISMATCH');
    const tokenDecimals = before.decimals ?? after.decimals;
    if (tokenDecimals === undefined) fail('TEST_SOLANA_TOKEN_DELTA_INVALID');
    for (const index of new Set([...before.owners.keys(), ...after.owners.keys()])) {
      const a = before.owners.get(index), b = after.owners.get(index);
      if (a !== undefined && b !== undefined && a !== b && (a === wallet || b === wallet))
        fail('TEST_SOLANA_TOKEN_OWNER_CHANGED');
    }
    const tokenDelta = after.total - before.total;
    const nativeDelta = BigInt(meta.postBalances[0]) - BigInt(meta.preBalances[0]);
    if (side === 'buy' ? tokenDelta <= 0n || nativeDelta >= 0n : tokenDelta >= 0n || nativeDelta <= 0n)
      fail('TEST_SOLANA_TRADE_DIRECTION_MISMATCH');
    if (request.expectedTokenAmount !== undefined && (tokenDelta < 0n ? -tokenDelta : tokenDelta) !== BigInt(request.expectedTokenAmount))
      fail('TEST_SOLANA_TOKEN_AMOUNT_MISMATCH');
    if (request.maxNativeDebitLamports !== undefined && -nativeDelta > BigInt(request.maxNativeDebitLamports))
      fail('TEST_SOLANA_NATIVE_DEBIT_EXCEEDED');
    return {signature, wallet, mint, side, slot: status.slot, tokenDelta: tokenDelta.toString(), nativeDelta: nativeDelta.toString(),
      feeLamports: String(meta.fee), preTokenAmount: before.total.toString(), postTokenAmount: after.total.toString(),
      preNativeLamports: String(meta.preBalances[0]), postNativeLamports: String(meta.postBalances[0]),
      decimals: tokenDecimals, checkedAt: new Date().toISOString()};
  }
  private tokenBalances(value: unknown, keyCount: number, mint: string, wallet: string) {
    if (!Array.isArray(value)) fail('TEST_SOLANA_TOKEN_BALANCES_MISSING');
    const seen = new Set<number>(), owners = new Map<number, string>();
    let total = 0n, tokenDecimals: number | undefined;
    for (const row of value) {
      if (!object(row) || !uint(row.accountIndex) || row.accountIndex >= keyCount || seen.has(row.accountIndex) ||
          !base58(row.mint, 32) || !object(row.uiTokenAmount) || !amount(row.uiTokenAmount.amount) || !decimals(row.uiTokenAmount.decimals))
        fail('TEST_SOLANA_TOKEN_BALANCES_INVALID');
      seen.add(row.accountIndex);
      if (row.mint !== mint) continue;
      if (!base58(row.owner, 32) || typeof row.programId !== 'string' || !PROGRAMS.has(row.programId))
        fail('TEST_SOLANA_TOKEN_OWNER_UNVERIFIED');
      owners.set(row.accountIndex, row.owner);
      if (row.owner !== wallet) continue;
      if (tokenDecimals !== undefined && tokenDecimals !== row.uiTokenAmount.decimals) fail('TEST_SOLANA_TOKEN_DECIMALS_MISMATCH');
      tokenDecimals = row.uiTokenAmount.decimals;
      total += BigInt(row.uiTokenAmount.amount);
      if (total > U64) fail('TEST_SOLANA_TOKEN_BALANCES_INVALID');
    }
    return {total, decimals: tokenDecimals, owners};
  }
}
