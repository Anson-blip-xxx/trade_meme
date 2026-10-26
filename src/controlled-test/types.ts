export interface TestQuoteRequest {
  wallet: string; inputToken: string; outputToken: string; inputAmount: string; slippagePct: number;
}
export interface TestTradeClient {
  quote(request: TestQuoteRequest): Promise<unknown>;
  swap(body: Record<string, unknown>, clientId: string): Promise<unknown>;
  query(orderId: string): Promise<unknown>;
  strategies(wallet: string, mint: string, type: 'open' | 'history', pageToken?: string): Promise<unknown>;
  cancel(wallet: string, orderId: string, clientId: string): Promise<unknown>;
}
export interface SolanaSnapshot {
  wallet: string; mint: string; nativeLamports: string; tokenAmount: string; decimals: number;
  slot: number; nativeSlot: number; mintAuthority: string | null; freezeAuthority: string | null;
  tokenProgram: string; extensions: string[]; checkedAt: string;
}
export interface VerifySolanaTransaction {
  signature: string; wallet: string; mint: string; side: 'buy' | 'sell';
  expectedTokenAmount?: string; maxNativeDebitLamports?: string;
}
export interface VerifiedSolanaTransaction {
  signature: string; wallet: string; mint: string; side: 'buy' | 'sell'; slot: number;
  tokenDelta: string; nativeDelta: string; feeLamports: string;
  preTokenAmount: string; postTokenAmount: string; preNativeLamports: string; postNativeLamports: string;
  decimals: number; checkedAt: string;
}
export interface TestChainReader {
  snapshot(wallet: string, mint: string): Promise<SolanaSnapshot>;
  verifyTransaction(request: VerifySolanaTransaction): Promise<VerifiedSolanaTransaction>;
}
export type TestPhase = 'created' | 'buy_pending' | 'verify_protection' | 'cancel_pending' | 'sell_pending'
  | 'complete' | 'preflight_failed' | 'needs_attention';
export interface TestRun {
  id: string; wallet: string; mint: string; amountLamports: string; maxDebitLamports: string;
  createdAt: string; updatedAt: string; phase: TestPhase;
  baseline?: SolanaSnapshot; buy?: VerifiedSolanaTransaction; sell?: VerifiedSolanaTransaction;
  strategyId?: string; strategyMatched?: boolean; strategyCanceled?: boolean;
  strategyChildStatuses?: string[]; strategyChildrenFingerprint?: string;
  finalSnapshot?: SolanaSnapshot; netNativeLamports?: string;
  reasons: string[]; automaticTriggerVerified: false;
  notificationKeys: string[];
}
export type TestOperationKey = 'buy' | 'cancel' | 'sell';
export interface TestOperation {
  runId: string; key: TestOperationKey; clientId: string; bodyHash: string; body: Record<string, unknown>;
  state: 'submitting' | 'acknowledged' | 'unknown'; response?: unknown;
  createdAt: string; updatedAt: string;
}
export interface TestJournal {
  create(run: TestRun): void;
  get(id: string): TestRun | undefined;
  acquireLease(runId: string, owner: string, ttlMs: number): void;
  renewLease(runId: string, owner: string, ttlMs: number): void;
  releaseLease(runId: string, owner: string): void;
  assertOwned(runId: string, owner: string): void;
  save(run: TestRun, owner: string): void;
  operation(runId: string, key: TestOperationKey): TestOperation | undefined;
  beginOperation(runId: string, key: TestOperationKey, body: Record<string, unknown>, owner: string): {created: boolean; operation: TestOperation};
  finishOperation(runId: string, key: TestOperationKey, state: 'acknowledged' | 'unknown', response: unknown, owner: string): void;
  close(): void;
}
export interface TestNotifier {
  notify(key: string, text: string): Promise<void>;
}
