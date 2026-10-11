import { z } from 'zod';
import {readFileSync} from 'node:fs';
import type { Chain } from './types.js';
import {parseExitPolicy,type ExitPolicy} from './exit-policy.js';

const schema = z.object({
  maxSignalAgeSec:z.coerce.number().int().min(10).max(86400).default(600),
  maxEvidenceAgeSec:z.coerce.number().int().min(60).max(604800).default(21600),
  decisionTtlSec:z.coerce.number().int().min(1).max(600).default(60),
  maxTaxRate:z.coerce.number().min(0).max(0.2).default(0.10),
  xDataProvider:z.enum(['x_official','fxembed','twitterapi_io']).default('x_official'),
  narrativeProvider:z.enum(['vendor','openai']).default('vendor'),
  gmgnMinIntervalMs:z.coerce.number().int().min(100).max(10000).default(350),
  walletMaxProfiles:z.coerce.number().int().min(1).max(5).default(3),
  minSmartWalletGroups:z.coerce.number().int().min(1).max(20).default(2),
  walletSupportRequired:z.enum(['true','false']).default('true').transform(v=>v==='true'),
  scannerEnabled:z.enum(['true','false']).default('false').transform(v=>v==='true'),
  scannerIntervalSec:z.coerce.number().int().min(15).max(3600).default(60),
  scannerMaxSignals:z.coerce.number().int().min(1).max(20).default(3),
  researchCacheMax:z.coerce.number().int().min(10).max(10000).default(200),
  researchCacheTtlSec:z.coerce.number().int().min(60).max(86400).default(1800),
  entryMode:z.enum(['off','paper','live']).default('off'),
  entrySizing:z.enum(['fixed','balance_cap']).default('fixed'),
  entrySlippagePct:z.coerce.number().int().min(0).max(50).default(5),
  entryMaxOpen:z.coerce.number().int().min(1).max(100).default(3),
  entryGasPriceBsc:z.string().regex(/^\d{1,12}$/).refine(v=>BigInt(v)>=50_000_000n&&BigInt(v)<=10_000_000_000n).default('50000000'),
  entryPriorityFeeSolana:z.string().regex(/^0\.\d{1,9}$/).refine(v=>Number(v)>=0.00001&&Number(v)<=0.01).default('0.00001'),
  entryTipFeeSolana:z.string().regex(/^0\.\d{1,9}$/).refine(v=>Number(v)>=0.00001&&Number(v)<=0.01).default('0.00001'),
});
export interface Config extends z.infer<typeof schema> {
  rpc: Partial<Record<Chain,string>>; goPlusToken?: string; etherscanKey?: string;
  xBearer?: string; twitterApiIoKey?: string; openaiKey?: string; openaiModel?: string;
  issuerIds: string[]; trackedIds: string[];
  ingestToken?:string; database:string; host:string; port:number;
  gmgnApiKey?:string; gmgnPrivateKey?:string; walletIdentitiesPath?:string;
  scannerChains:Chain[]; ordersDatabase:string;
  entryWallets:Partial<Record<Chain,string>>; entryAmounts:Partial<Record<Chain,string>>;
  entryInputTokens:Partial<Record<Chain,string>>;
  entryFeeReserves:Record<Chain,string>;
  exitPolicy?:ExitPolicy;
  dashboard:{enabled:boolean;host:string;port:number;token?:string;origin?:string;archivePath:string;retentionDays:number;trackingHours:number;sampleIntervalSec:number};
  walletResearch:{enabled:boolean;database:string;maxBytes:number;intervalSec:number;maxRequestsPerCycle:number};
  watch:{enabled:boolean;windowSec:number;intervalSec:number;maxPerCycle:number};
  exitShadow:{enabled:boolean;database:string;maxBytes:number;staleAfterSec:number;maxPositions:number};
  chainStream:{enabled:boolean;database:string;maxBytes:number;maxWallets:number;maxPools:number;
    endpoints:Partial<Record<Chain,{http:string;ws:string}>>};
}
export function isPersistentOrderPath(value:string):boolean {
  return typeof value==='string'&&value.trim().length>0&&value.trim()!==':memory:'&&
    !/^file:/i.test(value.trim())&&!value.includes('\0');
}
export function readConfig(env:NodeJS.ProcessEnv=process.env): Config {
  const reserve=(raw:string|undefined,fallback:string,max:bigint):string=>{
    const value=raw??fallback;
    if(!/^(0|[1-9]\d{0,77})$/.test(value)||BigInt(value)>max) throw new Error('ENTRY_FEE_RESERVE_INVALID');
    return value;
  };
  let exitPolicy:ExitPolicy|undefined;
  if(env.EXIT_POLICY_PATH?.trim()) {
    try {exitPolicy=parseExitPolicy(JSON.parse(readFileSync(env.EXIT_POLICY_PATH,'utf8')));}
    catch {throw new Error('EXIT_POLICY_CONFIG_INVALID');}
  }
  let gmgnPrivateKey=env.GMGN_PRIVATE_KEY?.trim();
  if(!gmgnPrivateKey&&env.GMGN_PRIVATE_KEY_FILE?.trim()) {
    try {gmgnPrivateKey=readFileSync(env.GMGN_PRIVATE_KEY_FILE,'utf8');}
    catch {throw new Error('GMGN_SIGNING_KEY_FILE_UNREADABLE');}
  }
  const streamEndpoints:Config['chainStream']['endpoints']={};
  for(const chain of ['bsc','solana','robinhood'] as const) {
    const prefix=chain.toUpperCase(),ws=env[`${prefix}_STREAM_WS_URL`],http=env[`${prefix}_STREAM_HTTP_URL`];
    if(!ws&&!http)continue;
    try {
      const w=new URL(ws!),h=new URL(http!);
      if(w.protocol!=='wss:'||h.protocol!=='https:'||(chain==='solana'&&w.hostname!==h.hostname)||w.username||w.password||h.username||h.password)throw new Error();
      streamEndpoints[chain]={ws:w.href,http:h.href};
    }catch {throw new Error('CHAIN_STREAM_ENDPOINT_INVALID');}
  }
  return {
    ...schema.parse({maxSignalAgeSec:env.MAX_SIGNAL_AGE_SEC, maxEvidenceAgeSec:env.MAX_EVIDENCE_AGE_SEC,
      decisionTtlSec:env.DECISION_TTL_SEC,maxTaxRate:env.MAX_TAX_RATE,xDataProvider:env.X_DATA_PROVIDER,narrativeProvider:env.NARRATIVE_PROVIDER,
      gmgnMinIntervalMs:env.GMGN_MIN_INTERVAL_MS,walletMaxProfiles:env.WALLET_MAX_PROFILES,minSmartWalletGroups:env.MIN_SMART_WALLET_GROUPS,walletSupportRequired:env.WALLET_SUPPORT_REQUIRED,
      scannerEnabled:env.SCANNER_ENABLED,scannerIntervalSec:env.SCANNER_INTERVAL_SEC,scannerMaxSignals:env.SCANNER_MAX_SIGNALS,
      researchCacheMax:env.RESEARCH_CACHE_MAX,researchCacheTtlSec:env.RESEARCH_CACHE_TTL_SEC,
      entryMode:env.ENTRY_MODE,entrySizing:env.ENTRY_SIZING,entrySlippagePct:env.ENTRY_SLIPPAGE_PCT,entryMaxOpen:env.ENTRY_MAX_OPEN,
      entryGasPriceBsc:env.ENTRY_GAS_PRICE_BSC_WEI,entryPriorityFeeSolana:env.ENTRY_PRIORITY_FEE_SOLANA,entryTipFeeSolana:env.ENTRY_TIP_FEE_SOLANA}),
    rpc:{bsc:env.BSC_RPC_URL,solana:env.SOLANA_RPC_URL,robinhood:env.ROBINHOOD_RPC_URL},
    chainStream:{enabled:z.enum(['true','false']).default('false').parse(env.CHAIN_STREAM_ENABLED)==='true',
      database:z.string().trim().refine(isPersistentOrderPath).parse(env.CHAIN_STREAM_DATABASE_PATH??'data/chain-stream.sqlite'),
      maxBytes:z.coerce.number().int().min(16).max(4096).parse(env.CHAIN_STREAM_MAX_MB??256)*1024*1024,
      maxWallets:z.coerce.number().int().min(1).max(30).parse(env.CHAIN_STREAM_MAX_WALLETS??10),
      maxPools:z.coerce.number().int().min(1).max(30).parse(env.CHAIN_STREAM_MAX_POOLS??8),endpoints:streamEndpoints},
    goPlusToken:env.GOPLUS_ACCESS_TOKEN,etherscanKey:env.ETHERSCAN_API_KEY,xBearer:env.X_BEARER_TOKEN,
    twitterApiIoKey:env.TWITTERAPI_IO_KEY,
    openaiKey:env.OPENAI_API_KEY,openaiModel:env.OPENAI_MODEL,
    issuerIds:(env.TRUSTED_ISSUER_X_IDS??'').split(',').filter(Boolean),
    trackedIds:(env.TRACKED_X_IDS??'').split(',').filter(Boolean),
    gmgnApiKey:env.GMGN_API_KEY,gmgnPrivateKey:gmgnPrivateKey?.replace(/\\n/g,'\n'),exitPolicy,
    walletIdentitiesPath:env.WALLET_IDENTITIES_PATH,
    scannerChains:z.array(z.enum(['bsc','solana','robinhood'])).min(1).parse([...new Set((env.SCANNER_CHAINS??'bsc,solana,robinhood').split(',').map(v=>v.trim()))]),
    // Raw research stays ephemeral; the dashboard retains only bounded compact summaries.
    ingestToken:env.INGEST_TOKEN,database:':memory:',
    ordersDatabase:z.string().trim().refine(isPersistentOrderPath,'Order storage requires a persistent file path').parse(env.ORDERS_DATABASE_PATH??'data/orders.sqlite'),
    entryWallets:{bsc:env.ENTRY_WALLET_BSC,solana:env.ENTRY_WALLET_SOLANA,robinhood:env.ENTRY_WALLET_ROBINHOOD},
    entryAmounts:{bsc:env.ENTRY_AMOUNT_BSC,solana:env.ENTRY_AMOUNT_SOLANA,robinhood:env.ENTRY_AMOUNT_ROBINHOOD},
    entryInputTokens:{bsc:env.ENTRY_INPUT_TOKEN_BSC,solana:env.ENTRY_INPUT_TOKEN_SOLANA,robinhood:env.ENTRY_INPUT_TOKEN_ROBINHOOD},
    entryFeeReserves:{bsc:reserve(env.ENTRY_FEE_RESERVE_BSC,'5000000000000000',(1n<<256n)-1n),
      solana:reserve(env.ENTRY_FEE_RESERVE_SOLANA,'20000000',(1n<<64n)-1n),
      robinhood:reserve(env.ENTRY_FEE_RESERVE_ROBINHOOD,'2000000000000000',(1n<<256n)-1n)},
    host:env.HOST??'127.0.0.1',port:z.coerce.number().int().min(1).max(65535).parse(env.PORT??8787),
    dashboard:{enabled:env.DASHBOARD_ENABLED==='true',host:env.DASHBOARD_HOST??'127.0.0.1',
      port:z.coerce.number().int().min(1).max(65535).parse(env.DASHBOARD_PORT??9528),
      token:env.DASHBOARD_ACCESS_TOKEN?.trim(),
      origin:env.DASHBOARD_PUBLIC_ORIGIN?z.url().parse(env.DASHBOARD_PUBLIC_ORIGIN):undefined,
      archivePath:z.string().trim().refine(isPersistentOrderPath).parse(env.SCAN_DATABASE_PATH??'data/scans.sqlite'),
      retentionDays:z.coerce.number().int().min(1).max(365).parse(env.SCAN_RETENTION_DAYS??30),
      trackingHours:z.coerce.number().int().min(1).max(168).parse(env.PRICE_TRACKING_HOURS??24),
      sampleIntervalSec:z.coerce.number().int().min(30).max(3600).parse(env.PRICE_SAMPLE_INTERVAL_SEC??60)},
    walletResearch:{enabled:z.enum(['true','false']).default('false').parse(env.WALLET_RESEARCH_ENABLED)==='true',
      database:z.string().trim().refine(isPersistentOrderPath).parse(env.WALLET_HISTORY_DATABASE_PATH??'data/wallet-history.sqlite'),
      maxBytes:z.coerce.number().int().min(16).max(16384).parse(env.WALLET_HISTORY_MAX_MB??512)*1024*1024,
      intervalSec:z.coerce.number().int().min(60).max(3600).parse(env.WALLET_OBSERVER_INTERVAL_SEC??300),
      maxRequestsPerCycle:z.coerce.number().int().min(1).max(10).parse(env.WALLET_OBSERVER_MAX_REQUESTS??9)},
    exitShadow:{enabled:z.enum(['true','false']).default('false').parse(env.EXIT_SHADOW_ENABLED)==='true',
      database:z.string().trim().refine(isPersistentOrderPath).parse(env.EXIT_SHADOW_DATABASE_PATH??'data/exit-shadow.sqlite'),
      maxBytes:z.coerce.number().int().min(16).max(4096).parse(env.EXIT_SHADOW_MAX_MB??128)*1024*1024,
      staleAfterSec:z.coerce.number().int().min(30).max(900).parse(env.EXIT_SHADOW_STALE_AFTER_SEC??180),
      maxPositions:z.coerce.number().int().min(10).max(10000).parse(env.EXIT_SHADOW_MAX_POSITIONS??1000)},
    watch:{enabled:z.enum(['true','false']).default('false').parse(env.WATCH_RECHECK_ENABLED)==='true',
      windowSec:z.coerce.number().int().min(60).max(3600).parse(env.WATCH_WINDOW_SEC??600),
      intervalSec:z.coerce.number().int().min(30).max(3600).parse(env.WATCH_RECHECK_INTERVAL_SEC??120),
      maxPerCycle:z.coerce.number().int().min(1).max(3).parse(env.WATCH_RECHECK_MAX_PER_CYCLE??1)},
  };
}
