import type {Chain, Signal} from '../types.js';
import type {WalletResearchTargets} from './wallet-targets.js';

/** Local operator configuration only. Never accept these assertions from a signal. */
export interface WalletIdentity {
  chain: Chain;
  address: string;
  label: string;
  entityId: string;
  category: 'exchange' | 'public_entity' | 'operator_defined' | 'unknown';
  reference: string;
}

export interface WalletActivity {
  txHash: string;
  type: 'buy' | 'sell' | 'transferIn' | 'transferOut' | 'add' | 'remove';
  timestamp: string;
  amount: string | null;
  usd: string | null;
}

export interface WalletRecord {
  chain: Chain;
  address: string;
  sources: ('top_holders' | 'smart_holders' | 'targeted_balance')[];
  vendorLabels: {provider: 'gmgn'; verification: 'vendor_claim'; platform: string[]; token: string[]};
  recognizedLabels: ('smart' | 'kol' | 'bundler' | 'rat_trader' | 'developer' | 'exchange_or_pool')[];
  vendorIdentity: {name?: string; twitterUsername?: string; verification: 'vendor_claim'};
  attribution: {status: 'unknown' | 'operator_supplied'; verification: 'unverified'; identity?: WalletIdentity};
  holding: {amount: string | null; usd: string | null; supplyRatio: number | null; currentlyHolding: boolean | null};
  cumulative: {
    scope: 'vendor_token_cumulative'; recentInflow: false;
    buyVolumeUsd: string | null; sellVolumeUsd: string | null;
    buyCount: number | null; sellCount: number | null;
    firstAcquiredAt: string | null; lastActiveAt: string | null; exitedAt: string | null;
  };
  funding: {
    address: string | null; label: string | null; verification: 'vendor_claim';
    source: 'native_transfer' | 'wallet_stats' | 'both' | 'unknown';
    amount: string | null; timestamp: string | null; txHash: string | null;
    sharedService: boolean; conflict: boolean;
  };
  developerLinks: string[];
  risks: string[];
  clusterId: string;
  enrichment: {
    status: 'not_requested' | 'complete' | 'partial';
    stats?: {period: '7d'; scope: 'entire_wallet'; realizedProfitUsd: string | null;
      winRate: number | null; totalBuyCostUsd: string | null; buyCount: number | null; sellCount: number | null};
    activity?: {
      scope: 'token_activity_page'; events: WalletActivity[]; hasMore: boolean | null;
      firstAt: string | null; lastAt: string | null;
      recent: {since: string; until: string; coverage: 'vendor_exhausted_feed' | 'vendor_window_covered' | 'partial';
        buyUsd: string | null; sellUsd: string | null; netBuyUsd: string | null; hasAccumulation: boolean | null};
    };
    reasons: string[];
  };
}

export interface WalletCluster {
  id: string;
  chain: Chain;
  wallets: string[];
  fundingAddresses: string[];
  basis: ('shared_funding' | 'funding_link' | 'operator_entity' | 'single_wallet')[];
  ownership: 'unknown';
  independenceProven: false;
  smartCurrentHolders: number;
  developerLinked: boolean;
}

export interface WalletAnalysis {
  /** Data availability only; pass does not certify ownership, safety, or profitability. */
  status: 'pass' | 'unknown';
  checkedAt: string;
  reasons: string[];
  facts: Record<string, unknown>;
  wallets: WalletRecord[];
  clusters: WalletCluster[];
  summary: {
    token: Signal['token'];
    sampleOnly: true;
    uniqueWalletCount: number;
    enrichedWalletCount: number;
    currentHolderCount: number;
    smartCurrentHolderCount: number;
    /** Observed funding components, an upper bound on independent participants. */
    smartFundingClusterCount: number;
    smartIndependenceProven: false;
    eligibleSmartWalletCount: number;
    qualifiedSmartWalletCount: number;
    qualifiedSmartFundingClusterCount: number;
    recentWindowSeconds: number;
    recentNetBuyUsd: string | null;
    hasRecentAccumulation: boolean | null;
    sampledHoldingRatio: number | null;
    cumulativeBuyUsd: string | null;
    cumulativeSellUsd: string | null;
    cumulativeCoverageWalletCount: number;
    cumulativeIsRecentInflow: false;
  };
}

export interface WalletAnalysisOptions {
  maxWallets?: number;
  identities?: readonly WalletIdentity[];
  recentWindowSec?: number;
  now?: () => Date;
  researchTargets?: WalletResearchTargets;
}
