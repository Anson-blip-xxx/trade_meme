import {DailyReviewStore} from './daily-review-store.js';
import {reviewDatabasePath,reviewSamplingPath} from './daily-review.js';
import {isPersistentOrderPath,type Config} from './config.js';
import type {Signal,Report} from './types.js';
import {Store} from './store.js';
import {OrderStore} from './orders.js';
import {EntryController} from './entry.js';
import {ThirdSignalEntryController} from './third-signal-entry.js';
import {ProcessNativeTradingRuntime} from './native-solana/process-host.js';
import type {ThirdSignalCandidate} from './third-signal-strategy.js';
import {validThirdSignalFill} from './exit-tracking.js';
import {buildExitConditions} from './exit-policy.js';
import {GmgnClient} from './providers/gmgn-client.js';
import {GmgnEntryHolderReader} from './providers/gmgn-entry-holders.js';
import {GmgnScanner,normalizeGmgnTrades} from './scanner.js';
import {DebotScanner} from './debot-scanner.js';
import {DebotStream} from './debot-stream.js';
import {DebotSessionClient,DebotSessionError} from './providers/debot-session.js';
import {DebotAuthManager} from './providers/debot-auth.js';
import {fetchDebotSignalPage,fetchDebotWalletDetails} from './providers/debot-signals.js';
import {OrderReconciler} from './reconcile.js';
import {evaluate,liveProviders} from './engine.js';
import {ScanArchive,type ScanPrice,type ScanToken} from './scan-archive.js';
import {ChainMonitor} from './chain-monitor.js';
import {PriceTracker} from './price-tracker.js';
import {DashboardBalances,dashboardOrders,dashboardSettings} from './dashboard-data.js';
import {WalletHistory} from './wallet-history.js';
import {WalletHistoryStatsRunner} from './wallet-history-stats.js';
import {WalletIndexRunner} from './wallet-index-runner.js';
import {WalletExitPressureRunner} from './wallet-exit-pressure-runner.js';
import {FollowupReviewRunner} from './followup-review-runner.js';
import {loadBundledWalletResearchSeeds} from './wallet-research-seeds.js';
import {WalletObserver} from './wallet-observer.js';
import {WalletProfileRunner} from './wallet-profile-runner.js';
import {WalletScreeningService} from './wallet-screening-service.js';
import {SystemMonitor} from './system-monitor.js';
import {WatchRechecker} from './watch-rechecker.js';
import {ExitShadow} from './exit-shadow.js';
import {dirname,resolve} from 'node:path';
import {existsSync,realpathSync,statSync} from 'node:fs';
import {researchProvider} from './research.js';
import type {DashboardPageOptions} from './dashboard.js';
import {assessDebotRepeatEvidence} from './debot-repeat-evidence.js';
import {MemeObserver} from './meme-observer.js';
import {normalizeMemeMarket} from './meme-assessment.js';
import {collectMemeCatalyst} from './meme-catalyst.js';
import {fetchMemeMarkets} from './meme-market-provider.js';
import {SourceCorroboration} from './source-corroboration.js';
import {AveScanner} from './ave-scanner.js';
import {AveSessionClient} from './providers/ave-session.js';
import {TokenRankResearchRunner} from './token-rank-runner.js';
import {MarketPriceRouter} from './market-price-router.js';
import type {Fetcher} from './http.js';
import {WalletFastRunner} from './wallet-fast-runner.js';
import {WalletFastResearch} from './wallet-fast-research.js';
import {WalletActivityVerifier} from './wallet-activity.js';
import {WalletActivityStore} from './wallet-activity-store.js';
import {WalletFastTargets,mergePinnedWallets,type FastWalletSnapshot,type FastWalletTarget,type FastTokenCheck} from './wallet-fast.js';
import {JevShadow,type JevShadowOptions} from './jev-shadow.js';
import {JevStatusRunner} from './jev-status.js';
import {buildJevInput} from './jev-input.js';
import {TelegramNotifier} from './telegram-notifier.js';
import {TradeNotifications} from './trade-notifications.js';
import {createHash} from 'node:crypto';
import {HeldPositionMonitor} from './held-position-monitor.js';
import {readControlledHoldings} from './held-position-source.js';
import {GmgnTestClient} from './controlled-test/gmgn.js';
import {ControlledSolanaReader} from './controlled-test/solana.js';
import {SignalCounting} from './signal-counting.js';
import {TELEGRAM_TOKEN_BUY_PRESETS,TelegramControls,type TelegramTokenBuyAction,type TelegramTokenBuyCode} from './telegram-controls.js';
import {TelegramPositions,type TelegramPosition} from './telegram-positions.js';
import {ManualCloseService,type ManualClosePosition} from './manual-close.js';
import {DirectSellService} from './direct-sell.js';
import {PositionPriceHealth,nativePositionHealthQuote} from './position-price-health.js';
import {readControlledManualPositions,ManualCloseSolanaHistory} from './manual-close-source.js';
import {ManualNativeTestController,type ManualNativeBuyResult} from './manual-native-buy.js';
import {validNativeTokenIdentity} from './native-solana/identity.js';
import {readNativeBalance} from './native-balance.js';
import {canonicalSolanaTokenAddress,TelegramTokenCardService} from './telegram-token-card.js';
import type {TelegramNotificationButtons} from './telegram-format.js';

export function createRuntime(config:Config,dependencies:{priceFetcher?:Fetcher;jevInvoke?:JevShadowOptions['invoke'];telegramFetcher?:typeof fetch;
  heldFetcher?:typeof fetch;entryFetcher?:typeof fetch;gmgnFetcher?:typeof fetch}={}) {
  const acceptsChain=(chain:Signal['token']['chain'])=>config.scannerChains.includes(chain);
  const backgroundGmgnEnabled=config.gmgnBackgroundResearchEnabled!==false;
  const backgroundGmgnPausedReason=backgroundGmgnEnabled?undefined:'GMGN_BACKGROUND_RESEARCH_DISABLED';
  let walletFast:WalletFastRunner|undefined,walletFastResearch:WalletFastResearch|undefined;
  let walletActivity:WalletActivityStore|undefined,walletVerifier:WalletActivityVerifier|undefined;
  if(!isPersistentOrderPath(config.ordersDatabase)) throw new Error('PERSISTENT_ORDER_DATABASE_REQUIRED');
  if(config.gmgnApiKey?.trim()==='gmgn_solbscbaseethmonadtron') throw new Error('GMGN_DEMO_KEY_TEST_ONLY');
  const sameDatabase=(a:string,b:string)=>{
    if(resolve(a)===resolve(b))return true;
    if(!existsSync(a)||!existsSync(b))return false;
    const left=statSync(a),right=statSync(b);
    return realpathSync(a)===realpathSync(b)||left.dev===right.dev&&left.ino===right.ino;
  };
  if(config.debotScannerEnabled&&(!isPersistentOrderPath(config.debotSignalsDatabase)||
    [config.ordersDatabase,config.dashboard.archivePath,config.walletResearch.database,config.walletProfiles.database,
      config.walletScreening.database,config.chainStream.database,config.exitShadow.database]
      .some(path=>sameDatabase(path,config.debotSignalsDatabase))))throw new Error('DEBOT_SIGNAL_DATABASE_CONFLICT');
  if(config.debotScannerEnabled&&[config.ordersDatabase,config.dashboard.archivePath,config.walletResearch.database,
    config.walletProfiles.database,config.walletScreening.database,config.chainStream.database,config.exitShadow.database,
    config.debotSignalsDatabase].some(path=>sameDatabase(path,config.debotSessionPath)))throw new Error('DEBOT_SESSION_PATH_CONFLICT');
  const client=new GmgnClient({apiKey:config.gmgnApiKey,minIntervalMs:config.gmgnMinIntervalMs,fetcher:dependencies.gmgnFetcher});
  const entryHolderReader=new GmgnEntryHolderReader(client);
  if(config.meme?.enabled&&[config.ordersDatabase,config.dashboard.archivePath,config.walletResearch.database,
    config.walletProfiles.database,config.walletScreening.database,config.chainStream.database,config.exitShadow.database,
    config.debotSignalsDatabase,config.debotSessionPath].some(path=>sameDatabase(path,config.meme!.database)))
    throw new Error('MEME_DATABASE_CONFLICT');
  const protectedPaths=[config.ordersDatabase,config.dashboard.archivePath,config.walletResearch.database,config.walletProfiles.database,
    config.walletScreening.database,config.chainStream.database,config.exitShadow.database,config.debotSignalsDatabase,config.debotSessionPath,
    ...(config.meme?.enabled?[config.meme.database]:[])];
  if(config.telegram?.enabled&&config.telegram.token&&config.telegram.chatId&&
    [...protectedPaths,'.env',config.ave?.database,config.ave?.sessionPath,config.corroboration?.database,
      config.jev?.database,config.tokenRankResearch?.database,config.walletFast?.database].filter((path):path is string=>!!path)
      .some(path=>sameDatabase(path,config.telegram!.database)))throw new Error('TELEGRAM_DATABASE_CONFLICT');
  for(const path of [...(config.corroboration&&(config.meme?.enabled||config.ave?.enabled)?[config.corroboration.database]:[]),
    ...(config.ave?.enabled?[config.ave.database,config.ave.sessionPath]:[])]){
    if(protectedPaths.some(existing=>sameDatabase(existing,path)))throw new Error('SOURCE_DATABASE_CONFLICT');
    protectedPaths.push(path);
  }
  if(config.tokenRankResearch?.enabled&&[...protectedPaths,
    ...(config.meme?[config.meme.database]:[]),...(config.corroboration?[config.corroboration.database]:[]),
    ...(config.ave?[config.ave.database,config.ave.sessionPath]:[])].some(path=>sameDatabase(path,config.tokenRankResearch!.database)))
    throw new Error('TOKEN_RANK_DATABASE_MUST_BE_SEPARATE');
  // Optional model storage must never touch an execution/session database. A
  // conflict disables only this observer, leaving the established strategy up.
  let jevStartupError:string|undefined;
  if(config.jev?.enabled)try {
    if([...protectedPaths,reviewDatabasePath(config.dashboard.archivePath),reviewSamplingPath(config.dashboard.archivePath),
      ...(config.tokenRankResearch?[config.tokenRankResearch.database]:[]),
      ...(config.walletFast?.database?[config.walletFast.database]:[]),
      ...(config.meme?[config.meme.database]:[]),...(config.corroboration?[config.corroboration.database]:[]),
      ...(config.ave?[config.ave.database,config.ave.sessionPath]:[])].some(path=>sameDatabase(path,config.jev!.database)))
      jevStartupError='JEV_DATABASE_CONFLICT';
  }catch {jevStartupError='JEV_STORAGE_UNAVAILABLE';}
  const jevShadow=config.jev?.enabled?new JevShadow({...config.jev,startupError:jevStartupError,invoke:dependencies.jevInvoke}):undefined;
  const jevStatusRunner=config.jev?.enabled&&!jevStartupError?new JevStatusRunner({database:config.jev.database}):undefined;
  let jevCaptureError:string|undefined;
  const jevPending=new Set<ReturnType<typeof setImmediate>>();
  const providers=liveProviders(config,client);
  const archive=config.dashboard.enabled||config.watch.enabled||config.exitShadow.enabled||config.chainStream.enabled?new ScanArchive(config.dashboard.archivePath,{
    retentionDays:config.dashboard.retentionDays,trackingHours:config.dashboard.trackingHours,followupEnabled:true}):undefined;
  const followupReview=archive?new FollowupReviewRunner({database:config.dashboard.archivePath,intervalMs:60_000}):undefined;
  if(config.watch.enabled)archive?.configureWatch({windowSec:config.watch.windowSec,intervalSec:config.watch.intervalSec,maxSignalAgeSec:config.maxSignalAgeSec});
  const walletHistory=config.walletResearch.enabled?new WalletHistory(config.walletResearch.database,{maxBytes:config.walletResearch.maxBytes}):undefined;
  const walletStatsRunner=walletHistory?new WalletHistoryStatsRunner({database:config.walletResearch.database,
    maxBytes:config.walletResearch.maxBytes}):undefined;
  const walletIndexRunner=walletHistory?new WalletIndexRunner({database:config.walletResearch.database,
    maxBytes:config.walletResearch.maxBytes}):undefined;
  let walletSeedsError:string|undefined;
  if(walletHistory)try {walletHistory.importResearchSeeds(loadBundledWalletResearchSeeds());}
  catch {walletSeedsError='WALLET_RESEARCH_SEEDS_IMPORT_FAILED';}
  const walletProfiles=walletHistory&&config.walletProfiles.enabled?new WalletProfileRunner({
    ...config.walletProfiles,historyDatabase:config.walletResearch.database,
    ...(config.chainStream.enabled?{chainDatabase:config.chainStream.database}:{})}):undefined;
  const walletProfilesStatus=()=>walletProfiles?.status()??{enabled:false,running:false,ready:false};
  const walletScreening=walletHistory&&walletProfiles&&config.walletScreening.enabled?new WalletScreeningService(walletHistory,walletProfiles.reader,
    {...config.walletScreening,historyDatabase:config.walletResearch.database,sourcePaths:[config.walletResearch.database,config.walletProfiles.database,config.ordersDatabase,config.dashboard.archivePath,
      config.chainStream.database,config.exitShadow.database]}):undefined;
  if(walletScreening){
    providers.walletScreening=(s,r,now)=>walletScreening.assess(s,r,now);
    providers.research=researchProvider(config,client,undefined,{walletTargets:signal=>walletScreening.researchTargets(signal)});
  }
  const dailyReview=config.dashboard.enabled?new DailyReviewStore(reviewDatabasePath(config.dashboard.archivePath)):undefined;
  let entryAuditError:string|undefined;
  const exitShadow=config.exitShadow.enabled?new ExitShadow(config.exitShadow.database,config.exitShadow):undefined;
  const walletExitPressure=exitShadow&&walletHistory?new WalletExitPressureRunner({database:config.walletResearch.database}):undefined;
  const walletObserver=walletHistory&&backgroundGmgnEnabled?new WalletObserver({history:walletHistory,client,config,chains:config.scannerChains,
    intervalMs:config.walletResearch.intervalSec*1000,maxRequestsPerCycle:config.walletResearch.maxRequestsPerCycle}):undefined;
  let archiveCaptureError:string|undefined,walletCaptureError:string|undefined;
  let memeCaptureError:string|undefined;
  let sourceCaptureError:string|undefined,nominationCaptureError:string|undefined;
  const sourceEvidence=config.corroboration&&(config.meme?.enabled||config.ave?.enabled)
    ?new SourceCorroboration(config.corroboration.database,{maxBytes:config.corroboration.maxBytes,maxEvents:config.corroboration.maxEvents}):undefined;
  let backgroundGmgnAbort:AbortController|undefined;
  const memeObserver=config.meme?.enabled?new MemeObserver({...config.meme,allowedChains:config.scannerChains,samplingPlanPath:reviewSamplingPath(config.dashboard.archivePath),
    marketBatch:(tokens,signal)=>fetchMemeMarkets(tokens.filter(t=>acceptsChain(t.chain)),signal),
    // Reuse a committed fresh market observation for research only. This path
    // cannot initialize a position, advance exit protection or submit an order.
    onMarketSample:sample=>{
      if(sample.priceUsd===undefined)return;
      try{jevShadow?.observePrice(sample);}catch{jevCaptureError='JEV_PRICE_CAPTURE_FAILED';}
      const source=sample.source==='gmgn_token_info'?'gmgn_token_info_sample':sample.source==='dexscreener_pair'?'dexscreener_token_pairs_sample':undefined;
      if(source)archive?.recordFollowupPrice({...sample.token,priceUsd:sample.priceUsd,observedAt:sample.observedAt,source,
        market:{poolAddress:sample.poolAddress,liquidityUsd:sample.liquidityUsd,holderCount:sample.holderCount,top10HolderRate:sample.top10HolderRate}});
    },
    ...(backgroundGmgnEnabled&&config.gmgnApiKey?.trim()?{marketFallback:async(token:Signal['token'],abort:AbortSignal)=>{
      if(!acceptsChain(token.chain)||active||scanner.getStatus().inFlight)return;
      backgroundGmgnAbort=new AbortController();
      try {
        const raw=await client.withSignal(AbortSignal.any([abort,backgroundGmgnAbort.signal,AbortSignal.timeout(1000)]))
          .get('/v1/token/info',{chain:token.chain==='solana'?'sol':token.chain,address:token.address},1);
        return normalizeMemeMarket(raw,token,new Date().toISOString());
      }finally{backgroundGmgnAbort=undefined;}
    }}:{}),cooldownUntil:()=>client.cooldownUntil,
    catalyst:(signal,abort,snapshot)=>collectMemeCatalyst(signal,config,{signal:abort,snapshot}),
    corroboration:sourceEvidence?(token,now)=>sourceEvidence.assess(token,now):undefined,
    walletEvidence:(token,now)=>({evidence:walletHistory?.followupEvidence(token,new Date(now.getTime()-120000).toISOString(),now.toISOString())})}):undefined;
  const tokenRankResearch=walletHistory&&config.tokenRankResearch?.enabled?new TokenRankResearchRunner({
    ...config.tokenRankResearch,historyDatabase:config.walletResearch.database,
    ...(memeObserver?{memeDatabase:config.meme!.database}:{}),
    ...(sourceEvidence?{sourceDatabase:config.corroboration!.database}:{})}):undefined;
  const captureSource=(signal:Signal,at?:string,display?:{name?:string})=>{
    if(!acceptsChain(signal.token.chain))return;
    if(signal.source==='manual'||signal.source==='wallet'||signal.source==='gmgn'&&!signal.sourceEventId.startsWith('gmgn:trade:'))return;
    try {
      // This exact template is emitted by normalizeGmgnTrades only. The source
      // ledger validates reference formats again and never promotes ownership.
      const trade=signal.source==='gmgn'?/^GMGN 链上买入记录；交易 ([A-Za-z0-9]+)；钱包 ([A-Za-z0-9]+)；CA /.exec(signal.text):null;
      const capture=sourceEvidence?.record(signal,at,{name:display?.name,
        ...(trade?{txRefs:[{txHash:trade[1],wallet:trade[2],side:'buy' as const}]}:{}),
        sourceUrl:signal.source==='ave'?'https://ave.ai/smart':signal.source==='debot'?'https://debot.ai/':'https://gmgn.ai/'});
      sourceCaptureError=capture?.accepted===false?capture.reason:undefined;
    }catch{sourceCaptureError='SOURCE_EVIDENCE_CAPTURE_FAILED';}
  };
  const observeSignal=(signal:Signal,at?:string,display?:{name?:string;symbol?:string},recordSource=true)=>{
    if(!acceptsChain(signal.token.chain))return;
    if(recordSource)captureSource(signal,at,display);
    try{memeObserver?.register(signal,at,display);memeCaptureError=undefined;}catch{memeCaptureError='MEME_SIGNAL_CAPTURE_FAILED';}
  };
  const store=new Store(':memory:',item=>{
    // The two research archives are independent observers; a failed archive must
    // neither suppress the other nor roll back the signal / affect order submission.
    if(archive)try {archive.capture(item);archiveCaptureError=undefined;}catch {archiveCaptureError='SCAN_ARCHIVE_WRITE_FAILED';}
    if(walletHistory&&item.status==='completed'&&item.report)try {
      walletHistory.captureReport(item.report);walletCaptureError=undefined;
    }catch {walletCaptureError='WALLET_HISTORY_WRITE_FAILED';}
    if(item.status==='completed'&&item.report)try{memeObserver?.captureReport(item.report);memeCaptureError=undefined;}
    catch{memeCaptureError='MEME_REPORT_CAPTURE_FAILED';}
    if(jevShadow&&item.status==='completed'&&item.report?.mode==='live'){
      if(jevPending.size>=32){jevCaptureError='JEV_CAPTURE_QUEUE_FULL';return;}
      // Complete the existing decision first. The detached research task never
      // waits in the order path and reads only evidence known at evaluatedAt.
      const report=item.report;
      const task=setImmediate(()=>{
        jevPending.delete(task);if(closed)return;
        try{
          let context:Record<string,unknown>={};
          try{context=memeObserver?.researchSnapshot(report.signal.token,report.evaluatedAt)??{};}catch{/* Missing optional evidence stays unknown. */}
          try{context.walletEvidence=walletHistory?.followupEvidence(report.signal.token,
            new Date(Date.parse(report.evaluatedAt)-120000).toISOString(),report.evaluatedAt);}catch{/* Independent evidence read. */}
          jevShadow.enqueue(buildJevInput(report,context));jevCaptureError=undefined;
        }catch{jevCaptureError='JEV_INPUT_CAPTURE_FAILED';}
      });jevPending.add(task);
    }
  }),orders=new OrderStore(config.ordersDatabase);
  let telegramCaptureError:string|undefined;
  let telegram:TelegramNotifier|undefined,tradeNotifications:TradeNotifications|undefined;
  let manualClose:ManualCloseService|undefined,manualCloseError:string|undefined;
  let directSell:DirectSellService|undefined,directSellError:string|undefined;
  let nativeTrading:ProcessNativeTradingRuntime|undefined,nativeTradingError:string|undefined;
  let manualNativeBuy:ManualNativeTestController|undefined,manualNativeBuyError:string|undefined;
  let telegramTokenCard:TelegramTokenCardService|undefined,telegramTokenCardError:string|undefined;
  let positionPriceHealth:PositionPriceHealth|undefined,positionPriceHealthError:string|undefined;
  let refreshPriceSubscriptions:()=>void=()=>{};
  const positionClosed=(id:string)=>(nativeTrading?.isClosed(id)??false)||(directSell?.isClosed(id)??false)||(manualClose?.isClosed(id)??false);
  const saleInProgress=(id:string)=>['accepted','executing','submitting','pending','unknown']
    .includes(directSell?.positionState(id)?.state??'');
  const syncDirectClosures=()=>{
    if(!directSell)return;
    try{
      for(const order of orders.activePositions()){
        const proof=directSell.closureEvidence(order.id);
        if(proof&&!orders.markDirectSellClosed(order.id,proof))throw Error('DIRECT_SELL_CLOSE_SYNC_FAILED');
      }
      if(directSellError==='DIRECT_SELL_CLOSE_SYNC_FAILED')directSellError=undefined;
    }catch{directSellError='DIRECT_SELL_CLOSE_SYNC_FAILED';}
  };
  const orderDisplay=(order:ReturnType<OrderStore['list']>[number]):{name?:string;symbol?:string}|undefined=>{
    const token=order.details.token;
    const native=order.details.nativeTokenIdentity;
    // The mint extension is bound to the exact address used by the native swap;
    // prefer it over an Ave/DeBot label that can be stale or simply wrong.
    if(validNativeTokenIdentity(native))return {name:native.name,symbol:native.symbol};
    const source=typeof order.details.reportId==='string'?archive?.tokenDisplay(order.details.reportId):undefined;
    if(source)return source;
    if(token&&typeof token==='object'&&!Array.isArray(token)){
      const value=token as Record<string,unknown>;
      return {name:typeof value.name==='string'?value.name:undefined,symbol:typeof value.symbol==='string'?value.symbol:undefined};
    }
  };
  try {
    if(config.telegram?.enabled&&config.telegram.token&&config.telegram.chatId){
      telegram=new TelegramNotifier(config.telegram.database,{
        token:config.telegram.token,chatId:config.telegram.chatId,fetch:dependencies.telegramFetcher});
      tradeNotifications=new TradeNotifications(config.telegram.database,{
        enqueue:event=>telegram!.enqueue(event),summaryIntervalMs:config.telegram.summaryIntervalMs,
        isClosed:positionClosed,
        display:orderDisplay});
    }
  }catch{telegramCaptureError='TELEGRAM_STORAGE_UNAVAILABLE';}
  const signalCountingPath=resolve(dirname(config.ordersDatabase),'third-signal-strategy.sqlite');
  const controlledJournal=resolve(dirname(config.ordersDatabase),'controlled-trade-tests.sqlite');
  if([...protectedPaths,controlledJournal,config.telegram?.database,config.ave?.database,config.ave?.sessionPath,
    config.corroboration?.database,config.jev?.database,config.walletFast?.database,config.tokenRankResearch?.database]
    .filter((path):path is string=>!!path).some(path=>sameDatabase(path,signalCountingPath)))
    throw new Error('SIGNAL_COUNTING_DATABASE_CONFLICT');
  let thirdEntry:ThirdSignalEntryController|undefined;
  const signalCounting=new SignalCounting({database:signalCountingPath,controlledJournal,orders,allowedChains:config.scannerChains,
    executionMode:config.thirdSignalExecutionMode,
    // Let each available live position slot begin its asynchronous preflight.
    // ThirdSignalEntry still performs the durable capacity and re-entry checks.
    dispatchConcurrency:Math.max(1,Math.min(3,config.entryMaxOpen)),dispatchCapacity:32,
    executionReady:()=>thirdEntry?.readiness()??{ready:false,reason:'THIRD_SIGNAL_EXECUTION_UNAVAILABLE'},
    onCandidate:async candidate=>{
      if(!thirdEntry)throw Error('THIRD_SIGNAL_EXECUTION_UNAVAILABLE');
      const result=await thirdEntry.consider(candidate);
      if(result.order){
        captureOrder(orders.get(result.order.id)??result.order);
        // Query accepted orders immediately; reconciliation is GET-only and never repeats a swap.
        if(result.order.providerOrderId&&['submitted','confirmed','unknown'].includes(result.order.status))
          try{await entry.reconcile(result.order.id);}catch{/* The durable reconciler continues on its normal timer. */}
      }else{
        const reason=result.reason&&/^[A-Z][A-Z0-9_]{1,100}$/.test(result.reason)?result.reason:'THIRD_SIGNAL_ENTRY_NOT_SUBMITTED';
        signalCounting.recordExecution(candidate,{status:'blocked',reason});
        telegram?.enqueue({key:`third-signal:blocked:${candidate.id}`,text:
          `【开仓未提交】\n${candidate.name??candidate.symbol??'未命名'} · SOL\nCA：${candidate.address}\n原因：${reason}\n本次未发送买单，已有持仓继续监控。`});
      }
    },
    enqueue:telegram?event=>telegram!.enqueue(event):undefined});
  let telegramControls:TelegramControls|undefined,telegramControlError:string|undefined;
  let heldMonitor:HeldPositionMonitor|undefined,heldCaptureError:string|undefined;
  const heldWallet=config.entryWallets.solana;
  if(heldWallet&&config.gmgnApiKey&&config.gmgnPrivateKey&&config.rpc.solana)try {
    const heldPath=resolve(dirname(config.ordersDatabase),'held-positions.sqlite');
    const sourcePath=resolve(dirname(config.ordersDatabase),'controlled-trade-tests.sqlite');
    if([...protectedPaths,sourcePath,config.telegram?.database,config.ave?.database,config.ave?.sessionPath,
      config.corroboration?.database,config.jev?.database,config.walletFast?.database,config.tokenRankResearch?.database]
      .filter((path):path is string=>!!path).some(path=>sameDatabase(path,heldPath)))throw new Error('HELD_DATABASE_CONFLICT');
    const transport=dependencies.heldFetcher??fetch;
    const readOnlyGmgn:typeof fetch=async(input,init)=>{
      const request=input instanceof Request?input:undefined,url=new URL(request?.url??String(input));
      const method=(init?.method??request?.method??'GET').toUpperCase();
      if(method!=='GET'||init?.body!=null||request?.body!=null||url.origin!=='https://openapi.gmgn.ai'||
        url.username||url.password||!['/v1/trade/query_order','/v1/trade/strategy/orders'].includes(url.pathname))
        throw new Error('HELD_GMGN_READ_ONLY');
      return transport(input,init);
    };
    const heldClient=new GmgnTestClient({apiKey:config.gmgnApiKey,privateKeyPem:config.gmgnPrivateKey,
      fetcher:readOnlyGmgn,minIntervalMs:Math.max(1200,config.gmgnMinIntervalMs)});
    const heldChain=new ControlledSolanaReader(config.rpc.solana,{fetcher:transport});
    heldMonitor=new HeldPositionMonitor(heldPath,{
      seeds:()=>{
        const result=readControlledHoldings(sourcePath,heldWallet);
        if(result.reasons.includes('CONTROLLED_HOLDINGS_READ_FAILED')){
          heldCaptureError='CONTROLLED_HOLDINGS_READ_FAILED';throw new Error('CONTROLLED_HOLDINGS_READ_FAILED');
        }
        if(heldCaptureError==='CONTROLLED_HOLDINGS_READ_FAILED')heldCaptureError=undefined;
        return result.items.filter(seed=>!positionClosed(seed.id));
      },
      query:seed=>seed.providerOrderId?heldClient.query(seed.providerOrderId):Promise.reject(new Error('HELD_ORDER_ID_UNAVAILABLE')),
      strategies:async seed=>{
        const raw=await heldClient.strategies(seed.wallet,seed.tokenAddress,'open');
        if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
          const page=raw as Record<string,unknown>;
          if(Array.isArray(page.list)&&page.list.length===0&&page.total===0&&
            (page.next_page_token===undefined||page.next_page_token===null||page.next_page_token===''))
            return heldClient.strategies(seed.wallet,seed.tokenAddress,'history');
        }
        return raw;
      },
      balance:seed=>heldChain.snapshot(seed.wallet,seed.tokenAddress),
      enqueue:event=>{if(!telegram)throw new Error('HELD_TELEGRAM_UNAVAILABLE');return telegram.enqueue(event);},
    });
  }catch{heldCaptureError='HELD_MONITOR_STARTUP_FAILED';}
  const heldStatus=()=>{
    try{return {enabled:!!heldMonitor,...heldMonitor?.status(),tracking:heldTracking?.getStatus(),captureError:heldCaptureError,
      ...(!heldMonitor?{mode:'observation_only',state:heldCaptureError?'error':'awaiting_configuration'}:{})};}
    catch{return {enabled:!!heldMonitor,mode:'observation_only',state:'error',captureError:'HELD_STATUS_UNAVAILABLE'};}
  };
  let manualCloseTimer:ReturnType<typeof setInterval>|undefined,manualCloseRecovery:Promise<void>|undefined;
  let directSellRecovery:Promise<void>|undefined;
  const manualPositions=():ManualClosePosition[]=>{
    const display=new Map(heldMonitor?.status().positions.map(p=>[p.id,p])??[]);
    const controlled=heldWallet?readControlledManualPositions(controlledJournal,heldWallet):[];
    const registered:ManualClosePosition[]=orders.activePositions().filter(o=>o.details.executionProvider!=='pump_native'&&o.chain==='solana'&&o.wallet===heldWallet&&o.status==='confirmed'&&o.transactionHash)
      .map(o=>{
        const fill=o.details.thirdSignalFill;
        const bound=validThirdSignalFill(fill,{chain:o.chain,wallet:o.wallet,tokenAddress:o.tokenAddress,inputToken:o.inputToken,
          openingTransactionHash:o.transactionHash})&&fill.inputAmount===o.actualInputAmount&&fill.outputAmount===o.outputAmount;
        return {id:o.id,chain:o.chain,wallet:o.wallet,tokenAddress:o.tokenAddress,openingTransactionHash:o.transactionHash!,
        providerOrderId:o.providerOrderId,openingOutputAmount:o.outputAmount,
        strategyOrderIds:o.exit?.strategyOrderId?[o.exit.strategyOrderId]:[],protectionExpected:!!o.exit,
        ...(bound&&o.exit?{tokenDecimals:fill.tokenDecimals,protectionEvidence:{inputAmount:fill.inputAmount,outputAmount:fill.outputAmount,
          tokenDecimals:fill.tokenDecimals,confirmedAt:fill.confirmedAt,conditions:buildExitConditions(o.exit.policy),sellRatioType:'hold_amount' as const}}:{}),
        ...orderDisplay(o)};});
    return [...controlled,...registered].filter(p=>!positionClosed(p.id)).map(p=>({...p,name:display.get(p.id)?.name??p.name}));
  };
  if(telegram&&heldWallet&&config.gmgnApiKey&&config.gmgnPrivateKey&&config.rpc.solana)try {
    const path=resolve(dirname(config.ordersDatabase),'manual-close.sqlite');
    if([...protectedPaths,controlledJournal,signalCountingPath,config.telegram?.database,config.ave?.database,
      config.ave?.sessionPath,config.corroboration?.database,config.jev?.database,
      resolve(dirname(config.ordersDatabase),'held-positions.sqlite')]
      .filter((p):p is string=>!!p).some(p=>sameDatabase(p,path)))throw Error('MANUAL_CLOSE_DATABASE_CONFLICT');
    const transport=dependencies.heldFetcher??fetch;
    const legacyReadOnlyGmgn:typeof fetch=async(input,init)=>{
      const request=input instanceof Request?input:undefined,url=new URL(request?.url??String(input));
      const method=(init?.method??request?.method??'GET').toUpperCase();
      if(url.origin!=='https://openapi.gmgn.ai'||url.username||url.password||method!=='GET'||init?.body!=null||request?.body!=null||
        !['/v1/trade/query_order','/v1/trade/strategy/orders'].includes(url.pathname))throw Error('LEGACY_MANUAL_CLOSE_READ_ONLY');
      return transport(input,init);
    };
    const history=new ManualCloseSolanaHistory(config.rpc.solana,{fetcher:transport});
    manualClose=new ManualCloseService(path,{positions:manualPositions,
      client:new GmgnTestClient({apiKey:config.gmgnApiKey,privateKeyPem:config.gmgnPrivateKey,
        fetcher:legacyReadOnlyGmgn,minIntervalMs:Math.max(1200,config.gmgnMinIntervalMs)}),
      chain:new ControlledSolanaReader(config.rpc.solana,{fetcher:transport}),
      partialSellSignatures:(p,opening,snapshot)=>history.signatures(p,opening,snapshot),enqueue:event=>telegram!.enqueue(event)});
  }catch{manualCloseError='MANUAL_CLOSE_STARTUP_UNAVAILABLE';}
  if(telegram&&heldWallet&&config.gmgnApiKey&&config.gmgnPrivateKey&&config.rpc.solana)try {
    const path=resolve(dirname(config.ordersDatabase),'direct-sell.sqlite');
    if([...protectedPaths,controlledJournal,signalCountingPath,config.telegram?.database,config.ave?.database,
      config.ave?.sessionPath,config.corroboration?.database,config.jev?.database,
      resolve(dirname(config.ordersDatabase),'held-positions.sqlite'),resolve(dirname(config.ordersDatabase),'manual-close.sqlite')]
      .filter((p):p is string=>!!p).some(p=>sameDatabase(p,path)))throw Error('DIRECT_SELL_DATABASE_CONFLICT');
    const transport=dependencies.heldFetcher??fetch;
    const sellOnlyGmgn:typeof fetch=async(input,init)=>{
      const request=input instanceof Request?input:undefined,url=new URL(request?.url??String(input));
      const method=(init?.method??request?.method??'GET').toUpperCase();
      if(url.origin!=='https://openapi.gmgn.ai'||url.username||url.password)throw Error('DIRECT_SELL_REQUEST_INVALID');
      if(method==='GET'){
        if(!['/v1/trade/quote','/v1/trade/query_order'].includes(url.pathname)||init?.body!=null||request?.body!=null)
          throw Error('DIRECT_SELL_REQUEST_INVALID');
      }else if(method==='POST'&&url.pathname==='/v1/trade/swap'){
        const body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
        if(!body||body.chain!=='sol'||body.from_address!==heldWallet||
          body.output_token!=='So11111111111111111111111111111111111111112'||
          body.input_token==='So11111111111111111111111111111111111111112'||body.condition_orders!==undefined)
          throw Error('DIRECT_SELL_REQUEST_INVALID');
      }else throw Error('DIRECT_SELL_REQUEST_INVALID');
      return transport(input,init);
    };
    directSell=new DirectSellService(path,{positions:manualPositions,
      client:new GmgnTestClient({apiKey:config.gmgnApiKey,privateKeyPem:config.gmgnPrivateKey,
        fetcher:sellOnlyGmgn,minIntervalMs:Math.max(1200,config.gmgnMinIntervalMs)}),
      chain:new ControlledSolanaReader(config.rpc.solana,{fetcher:transport}),
      slippagePct:config.entrySlippagePct,
      isLegacySalePending:id=>manualClose?.hasPendingSale(id)??!!manualCloseError,
      enqueue:event=>{syncDirectClosures();return telegram!.enqueue({...event,
        buttons:[[{text:'查看最新持仓 / 卖出状态',callback_data:'positions:1'}]]});}});
  }catch{directSellError='DIRECT_SELL_STARTUP_UNAVAILABLE';}
  if(config.solanaExecutionProvider==='pump_native')try{
    const paths=[config.nativeSolana!.journalPath,config.nativeSolana!.positionsPath,config.nativeSolana!.positionsPath+'.actions.sqlite',
      config.nativeSolana!.positionsPath+'.process.sqlite',...(config.telegram?.database?[config.telegram.database+'.manual-native-buy.sqlite']:[])];
    const existing=[...protectedPaths,controlledJournal,signalCountingPath,config.telegram?.database,config.ave?.database,
      config.corroboration?.database,config.jev?.database,config.walletFast?.database,config.tokenRankResearch?.database,
      resolve(dirname(config.ordersDatabase),'manual-close.sqlite'),resolve(dirname(config.ordersDatabase),'direct-sell.sqlite')]
      .filter((p):p is string=>!!p);
    if(paths.some((p,index)=>[...existing,...paths.slice(0,index)].some(q=>sameDatabase(p,q))))throw Error('NATIVE_DATABASE_CONFLICT');
    nativeTrading=new ProcessNativeTradingRuntime(config,orders,event=>{if(!telegram)throw Error('TELEGRAM_UNAVAILABLE');return telegram.enqueue(event);},
      {onOrderUpdate:order=>captureOrder(order)});
  }catch{nativeTradingError='NATIVE_RUNTIME_STARTUP_UNAVAILABLE';}
  if(nativeTrading&&telegram&&config.telegram?.token&&config.telegram.chatId)try{
    manualNativeBuy=new ManualNativeTestController(config,orders,{
      database:config.telegram.database+'.manual-native-buy.sqlite',fetcher:dependencies.entryFetcher,
      native:{readiness:()=>nativeTrading!.readiness(),execute:(order,guard)=>nativeTrading!.execute(order,guard)},
      readHolderRisk:address=>entryHolderReader.readHolderRisk(address),
      enqueue:event=>telegram!.enqueue(event)});
  }catch{manualNativeBuyError='MANUAL_NATIVE_BUY_STARTUP_UNAVAILABLE';}
  if(telegram)try{
    const wallet=heldWallet&&canonicalSolanaTokenAddress(heldWallet)?heldWallet:undefined;
    telegramTokenCard=new TelegramTokenCardService({client,wallet,
      ...(wallet&&config.rpc.solana?{readBalance:()=>readNativeBalance('solana',wallet,config,dependencies.entryFetcher??fetch)}:{}),
      position:mint=>{
        for(const order of orders.activePositions()){
          if(order.chain!=='solana'||order.tokenAddress!==mint)continue;
          const position=nativeTrading?.get(order.id);
          if(position?.state==='active'&&position.balance)return {amountAtomic:position.balance.amount,decimals:position.buy.tokenDecimals,
            ...(position.externalIncreaseAmount==='0'&&position.quote?{
              sellQuote:{inputAmount:position.quote.inputAmount,outputAmount:position.quote.outputAmount,
                quotedAt:position.quote.quotedAt,expiresAt:position.quote.expiresAt},
              costBasis:{solLamports:position.costBasis.solLamports,tokenAtoms:position.costBasis.tokenAtoms,
                excludesNetworkFees:true as const},
            }:{}),
          };
        }
      }});
  }catch{telegramTokenCardError='TELEGRAM_TOKEN_CARD_STARTUP_UNAVAILABLE';}
  const telegramPositions=new TelegramPositions(()=>{
    syncDirectClosures();
    const held=heldMonitor?.status().positions??[],seeds=heldWallet?readControlledHoldings(controlledJournal,heldWallet).items:[];
    const seedMap=new Map(seeds.map(p=>[p.id,p]));
    const views=new Map(tradeNotifications?.positionViews().map(p=>[p.id,p])??[]);
    let closable=new Set<string>();try{if(directSell)closable=new Set(manualPositions().map(p=>p.id));}catch{directSellError='DIRECT_SELL_SOURCE_UNAVAILABLE';}
    const rows:TelegramPosition[]=held.filter(p=>(p.status!=='balance_zero'||saleInProgress(p.id))&&!positionClosed(p.id)).flatMap(p=>{
      const seed=seedMap.get(p.id);if(!seed)return [];
      return [{id:p.id,chain:p.chain,wallet:seed.wallet,address:p.address,name:p.name,quantity:p.quantity,
        quantityAtomic:p.quantityAtomic,tokenDecimals:p.tokenDecimals,
        balanceCheckedAt:p.balanceCheckedAt,balanceFresh:p.balanceFresh,priceUsd:p.latest?.usd,priceAt:p.latest?.at,
        priceFresh:p.priceFresh,gainPct:p.gainPct,gainBasis:'fill',
        protection:p.protection?.policyMatched?'已观察到止盈 / 止损条件':'状态待核验',canClose:closable.has(p.id)}];
    });
    for(const o of orders.activePositions()){
      if(o.status!=='confirmed'||positionClosed(o.id))continue;
      const view=views.get(o.id),route=priceRouter.latest({chain:o.chain,address:o.tokenAddress});
      const price=route.status==='available'?route.sample:undefined;
      const checked=o.exit?.balance?.checkedAt;
      const fill=o.details.thirdSignalFill;
      const tokenDecimals=validThirdSignalFill(fill,{chain:o.chain,wallet:o.wallet,tokenAddress:o.tokenAddress,inputToken:o.inputToken,
        openingTransactionHash:o.transactionHash})?fill.tokenDecimals:undefined;
      if(o.exit?.balance?.status==='verified'&&o.exit.balance.amount==='0'&&!saleInProgress(o.id))continue;
      rows.push({id:o.id,chain:o.chain,wallet:o.wallet,address:o.tokenAddress,name:view?.name,symbol:view?.symbol,
        quantityAtomic:o.exit?.balance?.status==='verified'?o.exit.balance.amount:undefined,tokenDecimals,
        balanceCheckedAt:checked,balanceFresh:!!checked&&Date.now()-Date.parse(checked)<=90000,
        priceUsd:price?.priceUsd??view?.latest?.usd,priceAt:price?.observedAt??view?.latest?.at,
        priceFresh:!!price&&Date.parse(price.validUntil)>Date.now(),gainPct:view?.gainPct,gainBasis:view?.gainBasis??'observation',
        protection:o.exit?.assessment?.hasLiveStop||o.exit?.assessment?.observedLiveStop?'已观察到止损条件':'状态待核验',canClose:closable.has(o.id)});
    }
    return rows.map(row=>{
      const native=nativeTrading?.get(row.id);
      if(native){
        row.quantityAtomic=native.balance?.amount;row.tokenDecimals=native.buy.tokenDecimals;
        row.balanceCheckedAt=native.balance?.observedAt;row.balanceFresh=!!row.balanceCheckedAt&&Date.now()-Date.parse(row.balanceCheckedAt)<15000;
        row.protection=native.lastError?'原生保护异常：'+native.lastError:native.pendingExit?'原生卖单确认中':'原生止盈止损监控';
        row.canClose=native.state==='active'&&!native.pendingExit;
        if(row.canClose)try{row.sellActionRef=nativeTrading!.createAction(row.id);}catch{row.canClose=false;}
        return row;
      }
      row.sellStatus=directSell?.positionState(row.id);
      if(saleInProgress(row.id))row.canClose=false;
      const latest=directSell?.latestBalance(row.id);
      if(latest&&(!row.balanceCheckedAt||Date.parse(latest.checkedAt)>Date.parse(row.balanceCheckedAt))){
        row.quantityAtomic=latest.tokenAmount;row.tokenDecimals=latest.decimals;
        row.quantity=Number(latest.tokenAmount)/10**latest.decimals;
        row.balanceCheckedAt=latest.checkedAt;row.balanceFresh=Date.now()-Date.parse(latest.checkedAt)<=90000;
      }
      if(row.canClose)try{row.sellActionRef=directSell!.createAction(row.id);}catch{row.canClose=false;}
      return row;
    });
  },{pending:()=>orders.activePositions().filter(o=>o.status!=='confirmed').length});
  const manualBuyScope=config.telegram?.token&&config.telegram.chatId?
    createHash('sha256').update(config.telegram.token+'\0'+config.telegram.chatId).digest('hex'):undefined;
  const solToLamports=(value:string):string|undefined=>{
    if(value.length>32||!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value))return;
    const [whole,fraction='']=value.split('.');
    const amount=BigInt(whole)*1_000_000_000n+BigInt(fraction.padEnd(9,'0'));
    return amount>0n&&amount<=(1n<<64n)-1n?amount.toString():undefined;
  };
  const lamportsToSol=(value:string|undefined):string=>{
    if(!value||! /^[1-9]\d*$/.test(value))return '待输入';
    const amount=BigInt(value),whole=amount/1_000_000_000n;
    const fraction=(amount%1_000_000_000n).toString().padStart(9,'0').replace(/0+$/,'');
    return `${whole}${fraction?`.${fraction}`:''} SOL`;
  };
  const manualCardBuyReply=(result:ManualNativeBuyResult,request:{address?:string;amountLamports?:string},action:TelegramTokenBuyAction)=>{
    const address=result.action?.mint??request.address;
    const amountLamports=result.action?.amountLamports??request.amountLamports;
    const amount=lamportsToSol(amountLamports);
    const orderId=result.order?.id??result.action?.orderId;
    if(result.status==='blocked')return {text:`【卡片买入】\n未发送交易。${amountLamports?`\n金额：${amount}`:''}${address?`\nCA：${address}`:''}\n原因：${result.reason}`};
    if(action==='custom_start'&&(result.status==='created'||result.status==='existing')&&result.action.state==='awaiting_amount'&&address)
      return {text:`【自定义买入】\nCA：${address}\n请在 5 分钟内直接发送 SOL 数量，例如：0.25\n发送后立即实盘执行，不再二次确认，也不使用自动信号风控。`,
        buttons:[[{text:'取消自定义买入',callback_data:`token:cancel:${result.action.ref}`}]]};
    if(action==='cancel'&&result.status==='canceled')return {text:'【自定义买入】\n已取消，没有发送交易。'};
    if(result.status==='accepted')return {text:`【买入已接收】\n${amount} · Solana · Jito${address?`\nCA：${address}`:''}\n成交后发送最终结果和实际耗时。`};
    if(result.status==='existing')return {text:`【卡片买入】\n该操作已经处理，不会重复发送买单。\n金额：${amount}${address?`\nCA：${address}`:''}${orderId?`\n开仓单：${orderId}`:''}`};
    return {text:`【卡片买入】\n操作状态：${result.status}\n金额：${amount}${address?`\nCA：${address}`:''}${orderId?`\n开仓单：${orderId}`:''}`};
  };
  const tokenCardReply=async(address:string,refresh:boolean)=>{
    if(!telegramTokenCard)return {text:'【合约详情】\n代币详情查询暂不可用，请稍后重试。'};
    const card=await telegramTokenCard.get(address,refresh);
    // GMGN detail reads can take several seconds. Resolve the sell capability
    // afterwards so the buttons reflect the newest native-position snapshot at
    // the moment the card is sent, rather than its state when refresh started.
    const sellable=telegramPositions.findSellableSolanaMint(address);
    const links:TelegramNotificationButtons[number]=[
      {text:'GMGN',url:`https://gmgn.ai/sol/token/${address}`},
      {text:'Dex',url:`https://dexscreener.com/solana/${address}`},
      {text:'Solscan',url:`https://solscan.io/token/${address}`},
      ...(address.endsWith('pump')?[{text:'Pump',url:`https://pump.fun/coin/${address}`}]:[]),
    ];
    const buttons:TelegramNotificationButtons=[
      ...(manualNativeBuy&&manualBuyScope?[
        [{text:'🟣 0.1',callback_data:`token:buy:a:${address}`},{text:'🟣 0.5',callback_data:`token:buy:b:${address}`},
          {text:'🟣 1',callback_data:`token:buy:c:${address}`}],
        [{text:'🟣 3',callback_data:`token:buy:d:${address}`},{text:'🟣 5',callback_data:`token:buy:e:${address}`},
          {text:'✏️ 自定义',callback_data:`token:custom:${address}`}],
      ]:[]),
      ...(sellable?.sellActionRef?[[
        {text:'🔴 卖30%',callback_data:`sell:30:${sellable.sellActionRef}`},
        {text:'🔴 卖50%',callback_data:`sell:50:${sellable.sellActionRef}`},
        {text:'🔴 卖100%',callback_data:`sell:100:${sellable.sellActionRef}`},
        {text:'🔴 卖X%',callback_data:`sell:custom:${sellable.sellActionRef}`},
      ]]:[]),
      links,
      [{text:'🔄 刷新详情',callback_data:`token:refresh:${address}`}],
    ];
    return {text:card.text,buttons};
  };
  if(telegram&&config.telegram?.token&&config.telegram.chatId)try {
    telegramControls=new TelegramControls({token:config.telegram.token,chatId:config.telegram.chatId,
      database:config.telegram.database,fetcher:dependencies.telegramFetcher,enqueue:event=>telegram!.enqueue(event),
      countingMode:config.thirdSignalExecutionMode,
      onAction:action=>{
        if(action!=='status')signalCounting.control(action,'tg');
        return signalCounting.controlText();
      },onPositions:page=>telegramPositions.page(page),
      ...((manualClose||directSell||nativeTrading)?{onClose:()=>({text:'【持仓卖出】\n平仓操作已更新，请刷新持仓，直接选择 25%、50%、75% 或 100%。',
        buttons:[[{text:'刷新持仓',callback_data:'positions:1'}]]})}:{}),
      ...((directSell||nativeTrading)?{onSell:async(ref:string,pct:number)=>{
        if(!Number.isSafeInteger(pct)||pct<1||pct>100)return {text:'【持仓卖出】\n卖出比例必须是 1% 至 100% 的整数。'};
        const reply=nativeTrading?.ownsAction(ref)?await nativeTrading.submit(ref,pct):
          directSell?await directSell.submit(ref,pct):{text:'卖出按钮已失效，请刷新持仓。'};
        return {text:'【持仓卖出】\n'+reply.text,buttons:[[{text:'刷新持仓',callback_data:'positions:1'}]]};
      }}:{}),
      ...(manualNativeBuy&&manualBuyScope?{onTokenBuy:(action:TelegramTokenBuyAction,address?:string,value?:string)=>{
        const actor={scope:manualBuyScope,owner:config.telegram!.chatId!};
        let result:ManualNativeBuyResult,amountLamports:string|undefined;
        if(action==='preset'&&address&&value){
          const amountSol=value==='legacy'?'0.01':Object.hasOwn(TELEGRAM_TOKEN_BUY_PRESETS,value)?
            TELEGRAM_TOKEN_BUY_PRESETS[value as Exclude<TelegramTokenBuyCode,'legacy'>]:undefined;
          amountLamports=amountSol?solToLamports(amountSol):undefined;
          result=amountLamports?manualNativeBuy!.triggerCard({...actor,mint:address,amountLamports}):
            {status:'blocked',reason:'MANUAL_NATIVE_AMOUNT_INVALID'};
        }else if(action==='custom_start'&&address){
          result=manualNativeBuy!.beginCardCustom({...actor,mint:address});
        }else if(action==='custom_value'&&value){
          amountLamports=solToLamports(value);
          result=amountLamports?manualNativeBuy!.submitCardCustom({...actor,amountLamports}):
            {status:'blocked',reason:'MANUAL_NATIVE_AMOUNT_INVALID'};
        }else if(action==='cancel'&&value){
          result=manualNativeBuy!.cancel({...actor,ref:value});
        }else result={status:'blocked',reason:'MANUAL_NATIVE_BUY_ACTION_INVALID'};
        return manualCardBuyReply(result,{address,amountLamports},action);
      }}:{}),
      ...(telegramTokenCard?{onTokenCard:tokenCardReply}:{})});
  }catch{telegramControlError='TELEGRAM_CONTROLS_UNAVAILABLE';}
  const recoverManualClose=()=>{
    if(!manualClose||manualCloseRecovery)return;
    manualCloseRecovery=manualClose.resume({onlySubmittedSells:true}).catch(()=>{manualCloseError='MANUAL_CLOSE_RECOVERY_UNAVAILABLE';})
      .finally(()=>{manualCloseRecovery=undefined;});
  };
  const recoverDirectSell=()=>{
    if(!directSell||directSellRecovery)return;
    directSellRecovery=directSell.resume().catch(()=>{directSellError='DIRECT_SELL_RECOVERY_UNAVAILABLE';})
      .finally(()=>{syncDirectClosures();directSellRecovery=undefined;});
  };
  const captureOrderFacts=(order:ReturnType<OrderStore['list']>[number])=>{
    try{signalCounting.captureOrder(order);}catch{telegramControlError='SIGNAL_COUNTING_HISTORY_CAPTURE_FAILED';}
    if(order.details.executionStrategy==='third_signal_v1'&&order.details.candidate&&
      ['submitted','confirmed','unknown','failed'].includes(order.status))try{
      signalCounting.recordExecution(order.details.candidate as ThirdSignalCandidate,{
        status:order.status as 'submitted'|'confirmed'|'unknown'|'failed',orderId:order.id,
        ...(order.details.entryHolderRisk?{holderRisk:order.details.entryHolderRisk}:{}),
        ...(order.failureReason?{reason:order.failureReason}:{})});
    }catch{telegramControlError='SIGNAL_COUNTING_EXECUTION_CAPTURE_FAILED';}
    if(!tradeNotifications)return;
    try{tradeNotifications.observeOrder(order);telegramCaptureError=undefined;}catch{telegramCaptureError='TELEGRAM_ORDER_CAPTURE_FAILED';}
  };
  const captureOrder=(order:ReturnType<OrderStore['list']>[number])=>{
    captureOrderFacts(order);refreshPriceSubscriptions();
  };
  const unsubscribeOrderNotifications=orders.subscribe(captureOrder);
  const positionPriceTokens=()=>{
    const tokens:ScanToken[]=orders.activePositions().filter(order=>!positionClosed(order.id)).map(order=>({chain:order.chain,address:order.tokenAddress}));
    try{tokens.push(...heldMonitor?.tokens()??[]);}catch{heldCaptureError='HELD_PRICE_TARGETS_UNAVAILABLE';}
    return [...new Map(tokens.map(token=>[`${token.chain}:${token.address}`,token])).values()];
  };
  const telegramStatus=()=>{
    try{return {enabled:config.telegram?.enabled??false,configured:!!telegram,
      ...telegram?.status(),events:tradeNotifications?.status(),captureError:telegramCaptureError,
      controls:telegramControls?.status(),controlError:telegramControlError,
      tokenCard:{enabled:!!telegramTokenCard,error:telegramTokenCardError},
      manualNativeBuy:{enabled:!!manualNativeBuy,readiness:manualNativeBuy?.readiness(),error:manualNativeBuyError},
      manualClose:{enabled:!!directSell,...directSell?.status(),error:directSellError},
      legacyManualClose:{enabled:!!manualClose,mode:'read_only_recovery',...manualClose?.status(),error:manualCloseError},
      ...(!telegram?{state:config.telegram?.enabled?'awaiting_configuration':'disabled'}:{})};}
    catch{return {enabled:config.telegram?.enabled??false,configured:!!telegram,state:'error',captureError:'TELEGRAM_STATUS_UNAVAILABLE'};}
  };
  let telegramTimer:ReturnType<typeof setInterval>|undefined;
  const syncTradeNotifications=()=>{
    syncDirectClosures();
    refreshPriceSubscriptions();
    signalCounting.tick();
    if(!tradeNotifications)return;
    try {
      // Recover current durable order state after restart; outbox keys suppress replay.
      const recent=orders.list(100),active=orders.activePositions();
      for(const order of new Map([...recent,...active].map(order=>[order.id,order])).values())captureOrderFacts(order);
      tradeNotifications.tick();
    }catch{telegramCaptureError='TELEGRAM_STATE_CAPTURE_FAILED';}
  };
  let exitCaptureError:string|undefined;
  const recordPrice=(price:ScanPrice)=>{
      try{heldMonitor?.observePrice(price);}catch{heldCaptureError='HELD_PRICE_CAPTURE_FAILED';}
      try{tradeNotifications?.observePrice(price);}catch{telegramCaptureError='TELEGRAM_PRICE_CAPTURE_FAILED';}
      try{jevShadow?.observePrice({token:{chain:price.chain,address:price.address},priceUsd:price.priceUsd,
        observedAt:price.observedAt,source:price.source,poolAddress:price.market?.poolAddress});}catch{jevCaptureError='JEV_PRICE_CAPTURE_FAILED';}
      let archiveFailed=false;
      let walletEvidence;
      // Join only already-observed local transactions at this sample's cutoff.
      // The follow-up store suppresses old/high-frequency ticks before the DB read.
      try {
        const window=archive?.followupEvidenceWindow(price);
        if(window&&walletHistory)walletEvidence=walletHistory.followupEvidence(price,window.fromAt,window.untilAt);
      }catch {walletCaptureError='WALLET_FOLLOWUP_EVIDENCE_READ_FAILED';}
      try {archive?.recordPrice(price,walletEvidence);}catch {archiveFailed=true;}
      if(exitShadow)try {
        // Reuse only newly returned prices. Old archive peaks cannot initialize a shadow position.
        let seed;
        try {seed=archive?.exitObservationSeed(price);}catch {archiveFailed=true;}
        // Optional wallet flow research never blocks a real-time quote. The
        // worker is admitted only for a new or already-open shadow position;
        // this callback consumes a strictly historical, five-minute cache.
        const pressure=walletExitPressure?.read(price,price.observedAt);
        if(seed||exitShadow.tracks(price))walletExitPressure?.request(price,price.observedAt);
        exitShadow.recordPrice(price,seed,pressure);exitCaptureError=undefined;
      }catch {exitCaptureError='EXIT_SHADOW_CAPTURE_FAILED';}
      if(archiveFailed)throw new Error('PRICE_ARCHIVE_WRITE_FAILED');
    };
  const recordPriceError=(token:ScanToken,reason:string,now?:Date)=>{
      try{heldMonitor?.recordPriceError(token,reason);}catch{heldCaptureError='HELD_PRICE_ERROR_CAPTURE_FAILED';}
      try{tradeNotifications?.recordPriceError(token,reason);}catch{telegramCaptureError='TELEGRAM_PRICE_ERROR_CAPTURE_FAILED';}
      let archiveFailed=false;
      try {archive?.recordPriceError(token,reason,now);}catch {archiveFailed=true;}
      if(exitShadow)try {exitShadow.recordError(token,reason,now);}catch {exitCaptureError='EXIT_SHADOW_CAPTURE_FAILED';}
      if(archiveFailed)throw new Error('PRICE_ARCHIVE_WRITE_FAILED');
    };
  // This independent spot observer never waits behind signal research on the GMGN queue.
  const priceRouter=new MarketPriceRouter({client,fetcher:dependencies.priceFetcher,preferStreams:true,minHttpIntervalMs:30000,
    debotFetcher:dependencies.priceFetcher??((input,init)=>debotSession?debotSession.fetcher(input,init):fetch(input,init))});
  const mergeTokens=(...groups:ScanToken[][])=>[...new Map(groups.flat().map(t=>[`${t.chain}:${t.address}`,t])).values()];
  let priceTargetError:string|undefined;
  let subscribedPriceKeys=new Set<string>();
  let backgroundPriceTokens:ScanToken[]=[];
  const streamPriceTokens=()=>{
    const groups:ScanToken[][]=[];let failed:string|undefined;
    try{groups.push(positionPriceTokens());}catch{failed='POSITION_PRICE_TARGETS_UNAVAILABLE';}
    try{groups.push((exitShadow?.trackingTokens(180)??[]).filter(t=>acceptsChain(t.chain)));}catch{failed='EXIT_PRICE_TARGETS_UNAVAILABLE';}
    try{groups.push((archive?.streamingTokens(new Date(),config.chainStream.maxPools)??[]).filter(t=>acceptsChain(t.chain)));}catch{failed='ARCHIVE_PRICE_TARGETS_UNAVAILABLE';}
    priceTargetError=failed;return mergeTokens(...groups).slice(0,200);
  };
  // Reserve pin capacity without changing the automatic selection budget on any chain.
  const streamWalletCapacity=config.chainStream.maxWallets+Math.max(0,...Object.values(config.chainStream.pinnedWallets??{}).map(wallets=>wallets.length));
  const monitoredChains=new Set([...config.scannerChains,...positionPriceTokens().map(t=>t.chain)]);
  const monitorEndpoints=Object.fromEntries(Object.entries(config.chainStream.endpoints).filter(([chain])=>monitoredChains.has(chain as Signal['token']['chain'])));
  const chainMonitor=config.chainStream.enabled?new ChainMonitor({config:{...config.chainStream,endpoints:monitorEndpoints,maxWallets:streamWalletCapacity},
    tokens:streamPriceTokens,wallets:chain=>acceptsChain(chain)?mergePinnedWallets(chain,walletHistory?.streamWalletTargets(chain,config.chainStream.maxWallets)??[],config.chainStream.pinnedWallets?.[chain]):[],onPrice:price=>{
      if(priceRouter.observeChainSample(price)){
        const route=priceRouter.latest(price);
        if(route.status==='available'&&route.sample)recordPrice(route.sample);
        else recordPriceError(price,route.reason??'PRICE_SOURCE_CONFLICT');
      }
    }}):undefined;
  const chainStreamStatus=()=>{try{return {...(chainMonitor?.getStatus()??{enabled:false,running:false,mode:'observation_only',chains:[],recentEvents:[]}),
    walletFast:walletFast?{...walletFast.status(),research:{...walletFastResearch?.status(),
      fullResearchEnabled:backgroundGmgnEnabled,pausedReason:backgroundGmgnPausedReason},activity:walletActivity?.status()}:{enabled:false}};}
    catch{return {enabled:config.chainStream.enabled,mode:'observation_only',captureError:'CHAIN_STATUS_READ_FAILED',chains:[],recentEvents:[]};}};
  const tracking=archive?new PriceTracker({archive:{
    pendingTokens:(limit,now)=>mergeTokens(positionPriceTokens(),(exitShadow?.trackingTokens(180,now)??[]).filter(t=>acceptsChain(t.chain)),
      archive.trackingTokens(20,now,t=>!acceptsChain(t.chain)||!!chainMonitor?.covers(t))).slice(0,limit??200),
    recordPrice,recordPriceError},client,router:priceRouter,priorityTokens:now=>mergeTokens(positionPriceTokens(),(exitShadow?.trackingTokens(20,now)??[]).filter(t=>acceptsChain(t.chain))),
    intervalMs:config.dashboard.sampleIntervalSec*1000,maxTokensPerCycle:30}):undefined;
  // Held positions have their own short observation loop, independent of archive/research work.
  const heldTracking=heldMonitor?new PriceTracker({archive:{
    pendingTokens:limit=>heldMonitor!.tokens().slice(0,limit??200),
    recordPrice,recordPriceError,
  },client,router:priceRouter,intervalMs:5000,maxTokensPerCycle:30}):undefined;
  const balances=config.dashboard.enabled?new DashboardBalances(config):undefined;
  const system=config.dashboard.enabled?new SystemMonitor(dirname(config.ordersDatabase)):undefined;
  orders.recover();
  const entry=new EntryController(config,orders,client,{fetcher:dependencies.entryFetcher,
    ...(walletScreening?{walletEvidence:(report:Report,now:Date)=>walletScreening.revalidate(report,now)}:{}),
    onDecision:(report,result,at)=>{try{dailyReview?.recordEntry(report,result,config.entryMode,at);entryAuditError=undefined;}catch{entryAuditError='ENTRY_AUDIT_WRITE_FAILED';}}});
  thirdEntry=new ThirdSignalEntryController(config,orders,{enabled:config.thirdSignalExecutionMode==='live',
    isActive:candidate=>!closed&&signalCounting.isActive(candidate),fetcher:dependencies.entryFetcher,
    // Holder risk is fetched only for a prepared opening, never by price/research timers.
    readHolderRisk:address=>entryHolderReader.readHolderRisk(address),
    ...(config.solanaExecutionProvider==='pump_native'?{native:{
      readiness:()=>nativeTrading?.readiness()??{ready:false,reason:nativeTradingError??'NATIVE_EXECUTOR_UNAVAILABLE'},
      execute:(order,guard)=>{if(!nativeTrading)throw Error('NATIVE_EXECUTOR_UNAVAILABLE');return nativeTrading.execute(order,guard);}}}:{}),
    scheduleRequest:(weight,execute)=>client.scheduleRequest(weight,execute),
    recordRateLimit:(headers,payload)=>client.recordRateLimit(headers,payload)});
  thirdEntry.recoverPrepared();
  const reconciler=new OrderReconciler(orders,entry);
  let closed=false,active=0,archiveMaintenanceError:string|undefined;
  const onSignal=async(signal:Signal,firstReceivedAt?:string,context?:{detailsReady:Promise<void>;repeat?:boolean}):Promise<void>=>{
    if(!acceptsChain(signal.token.chain))return;
    backgroundGmgnAbort?.abort();
    if(closed||active>=4) throw new Error('RESEARCH_BUSY');
    observeSignal(signal,firstReceivedAt,undefined,false);
    store.prune(config.researchCacheTtlSec,config.researchCacheMax);
    const reserved=store.reserve(signal,undefined,'notification_copy',firstReceivedAt);
    if(reserved.conflict) throw new Error('EVENT_ID_PAYLOAD_CONFLICT');
    if(!reserved.created) return;
    const item=reserved.entry;active++;
    try {
      if(signal.source==='debot')debotScanner?.bindReport(signal.sourceEventId,item.id);
      const report=await evaluate(signal,config,providers,{id:item.id,receivedAt:item.receivedAt,
        walletTargetsReady:context?.detailsReady,
        ...(signal.source==='debot'?{onProgress:progress=>debotScanner?.recordProgress(signal.sourceEventId,progress)}:{})});
      if(!store.finish(item.id,report,item.claimId!)) throw new Error('PROCESSING_CLAIM_EXPIRED');
      if(signal.source==='debot')debotScanner?.recordReport(signal.sourceEventId,report);
      if(signal.source==='ave')aveScanner?.recordReport(signal.sourceEventId,report);
      if(!closed)await entry.consider(report);
    } catch(error) {store.interrupt(item.id,item.claimId!);throw error;}
    finally {active--;}
  };
  if(config.walletFast?.enabled&&config.chainStream.enabled&&walletHistory){
    const fastTargets=new WalletFastTargets();
    const activityPath=config.walletFast.database??resolve(dirname(config.walletResearch.database),'wallet-activity.sqlite');
    if([...protectedPaths,config.database].some(path=>path&&sameDatabase(path,activityPath)))throw new Error('WALLET_ACTIVITY_DATABASE_MUST_BE_SEPARATE');
    walletActivity=new WalletActivityStore(activityPath,config.walletFast.maxBytes);walletVerifier=new WalletActivityVerifier(config.chainStream.endpoints);
    walletFastResearch=new WalletFastResearch({
      allowedChains:config.scannerChains,
      // Chain receipt classification and durable buy/sell observations continue
      // independently; only the optional full GMGN research dispatch is paused.
      ready:()=>backgroundGmgnEnabled&&!closed&&active<2&&!!config.gmgnApiKey?.trim()&&client.cooldownUntil<=Date.now()&&!scanner.getStatus().inFlight,
      verify:event=>walletVerifier!.verify(event),onClassification:result=>walletActivity!.record(result),
      onTrades:trades=>walletHistory.recordTrades(trades),onSignal});
    walletFast=new WalletFastRunner({endpoints:Object.fromEntries(Object.entries(config.chainStream.endpoints).filter(([chain])=>acceptsChain(chain as Signal['token']['chain']))),maxWallets:streamWalletCapacity,
      onEvent:event=>walletFastResearch?.enqueue(event),snapshot:()=>{
        const now=Date.now(),targets:FastWalletTarget[]=[],tokens:FastTokenCheck[]=[];
        for(const chain of config.scannerChains){
          if(!config.chainStream.endpoints[chain])continue;
          const addresses=new Set<string>();
          // Reserve room for multiple research cohorts rather than only the largest reported profits.
          for(const p of walletProfiles?.reader.streamTargets(chain,config.chainStream.maxWallets)??[])addresses.add(p.address);
          for(const address of walletHistory.streamWalletTargets(chain,config.chainStream.maxWallets))addresses.add(address);
          const selected=mergePinnedWallets(chain,fastTargets.select(chain,[...addresses],config.chainStream.maxWallets,now),config.chainStream.pinnedWallets?.[chain]),
            profiles=new Map((walletProfiles?.reader.getMany(selected.map(address=>({chain,address})))??[]).map(p=>[p.address,p]));
          for(const wallet of selected){
            const p=profiles.get(wallet);
            targets.push({chain,wallet,groups:p?.groups.map(g=>g.id)??[],profileUntil:p?.freshUntil});
          }
        }
        const cachedTokens=new Set<string>();
        for(const item of store.list().slice(0,500).sort((a,b)=>(b.report?.evaluatedAt??'').localeCompare(a.report?.evaluatedAt??'')))if(item.report){const r=item.report;
          const key=`${r.signal.token.chain}:${r.signal.token.address}`;if(cachedTokens.has(key))continue;cachedTokens.add(key);
          tokens.push({...r.signal.token,state:r.safety.status==='fail'||r.provenance.status==='fail'?'fail':
            r.safety.status==='pass'&&r.provenance.status==='pass'?'pass':'unknown',validUntil:r.validUntil});}
        return {at:new Date(now).toISOString(),validUntil:new Date(now+120000).toISOString(),targets,tokens} satisfies FastWalletSnapshot;
      }});
  }
  const scanner=new GmgnScanner({client,chains:config.scannerChains,intervalMs:config.scannerIntervalSec*1000,
    maxAgeSec:config.maxSignalAgeSec,maxSignalsPerCycle:config.scannerMaxSignals,onSignal,
    onFeed:page=>{
      if(!page.errorReason)for(const signal of normalizeGmgnTrades(page.payload,page.chain,page.kind,
        {now:new Date(page.fetchedAt),maxAgeSec:config.maxSignalAgeSec}))captureSource(signal,page.fetchedAt);
      walletObserver?.observeFeed(page);
    }});
  let debotAuth:DebotAuthManager|undefined;
  const aveSession=config.ave?.enabled&&config.ave.email?new AveSessionClient({path:config.ave.sessionPath,email:config.ave.email}):undefined;
  const aveScanner=config.ave?.enabled?new AveScanner({database:config.ave.database,chains:config.scannerChains,
    onPriceFrame:(payload,receivedAt)=>{priceRouter.ingestAvePriceFrame(payload,receivedAt,sample=>{
      if(subscribedPriceKeys.has(`${sample.chain}:${sample.address}`))recordPrice(sample);
    });},
    fetcher:aveSession?.fetcher,onObservation:observation=>{
      signalCounting.observe(observation);
      try {
        const captured=walletHistory?.captureVendorNominations(observation.signal.token,{source:'ave',
          eventId:observation.signal.sourceEventId,occurredAt:observation.signal.occurredAt,observedAt:observation.observedAt,
          wallets:observation.vendorWallets??[]});
        nominationCaptureError=captured?.reason;
      }catch{nominationCaptureError='WALLET_NOMINATION_CAPTURE_FAILED';}
      observeSignal(observation.signal,observation.observedAt,observation);
    },
    // In focused mode an unavailable GMGN check remains unknown in evaluation;
    // it must not stop independent source delivery or local evidence collection.
    onSignal,shouldDefer:()=>closed?'SERVICE_STOPPING':backgroundGmgnEnabled&&!config.gmgnApiKey?.trim()?'GMGN_API_KEY_MISSING':
      backgroundGmgnEnabled&&client.cooldownUntil>Date.now()?'GMGN_RATE_LIMITED':active>=2?'RESEARCH_BUSY':scanner.getStatus().inFlight?'SCANNER_BUSY':undefined}):undefined;
  const debotSession=config.debotScannerEnabled&&config.debotTransport==='authenticated_stream'?new DebotSessionClient({
    path:config.debotSessionPath,onAuthRequired:()=>{debotAuth?.setAuthenticated(false);debotStream?.invalidateSession();}}):undefined;
  const debotScanner:DebotScanner|undefined=config.debotScannerEnabled?new DebotScanner({database:config.debotSignalsDatabase,mode:config.debotTransport,
    maxBytes:config.debotSignalsMaxBytes,
    chains:config.scannerChains,intervalSec:config.debotScannerIntervalSec,
    maxConcurrent:debotSession?2:1,parallelDetails:!!debotSession,
    lookupDisplay:reportId=>archive?.tokenDisplay(reportId),
    maxAgeSec:debotSession?Math.min(120,config.maxSignalAgeSec):config.maxSignalAgeSec,onSignal,
    onObservation:observation=>{
      signalCounting.observe(observation);
      observeSignal(observation.signal,observation.observedAt,observation);
    },
    repeatEvidence:(input,signal)=>{
      // Optional profile lookup must not hide independently observed sell trades.
      const walletTargets=(()=>{try{return walletScreening?.researchTargets(signal);}catch{return undefined;}})();
      return assessDebotRepeatEvidence({...input,history:walletHistory,walletTargets});
    },
    ...(debotSession?{fetchPage:(chain:Signal['token']['chain'])=>fetchDebotSignalPage(chain,{fetcher:debotSession.fetcher}),
      fetchDetails:(observation:Parameters<typeof fetchDebotWalletDetails>[0])=>fetchDebotWalletDetails(observation,{fetcher:debotSession.fetcher,signal:AbortSignal.timeout(4000)})}:{}),
    shouldDefer:()=>closed?'SERVICE_STOPPING':backgroundGmgnEnabled&&!debotSession&&!config.gmgnApiKey?.trim()?'GMGN_API_KEY_MISSING':
      backgroundGmgnEnabled&&!debotSession&&client.cooldownUntil>Date.now()?'GMGN_RATE_LIMITED':active>=4?'RESEARCH_BUSY':
        !debotSession&&scanner.getStatus().inFlight?'SCANNER_BUSY':undefined}):undefined;
  const debotStream=debotSession&&debotScanner?new DebotStream({chains:config.scannerChains,
    getSession:async()=>{
      try{const session=await debotSession.getSession();debotAuth?.setAuthenticated(true);return session;}
      catch(error){
        if(error instanceof DebotSessionError&&['DEBOT_SESSION_FILE_MISSING','DEBOT_SESSION_FILE_INVALID',
          'DEBOT_SESSION_FILE_PERMISSIONS','DEBOT_SESSION_AUTH_REQUIRED'].includes(error.reason))debotAuth?.setAuthenticated(false);
        throw error;
      }
    },onPage:page=>debotScanner.acceptPage(page),onAuthorized:()=>debotScanner.runOnce()}):undefined;
  if(debotStream&&config.debotLoginEmail)debotAuth=new DebotAuthManager({email:config.debotLoginEmail,
    sessionPath:config.debotSessionPath,onAuthenticated:async()=>{
      await debotStream.stop();if(!closed)void debotStream.start();
    }});
  if(debotScanner||aveScanner)providers.research=researchProvider(config,client,undefined,{
    ...(walletScreening?{walletTargets:(signal:Signal)=>walletScreening.researchTargets(signal)}:{}),
    vendorWalletTargets:signal=>signal.source==='ave'?aveScanner?.vendorWalletTargets(signal):debotScanner?.vendorWalletTargets(signal)});
  const watchRechecker=archive&&config.watch.enabled?new WatchRechecker({archive,
    intervalMs:config.watch.intervalSec*1000,maxPerCycle:config.watch.maxPerCycle,
    shouldDefer:()=>closed?'SERVICE_STOPPING':!backgroundGmgnEnabled?backgroundGmgnPausedReason:!config.gmgnApiKey?.trim()?'GMGN_API_KEY_MISSING':
      client.cooldownUntil>Date.now()?'GMGN_RATE_LIMITED':active>=4?'RESEARCH_BUSY':scanner.getStatus().inFlight?'SCANNER_BUSY':undefined,
    evaluate:async(signal,options)=>{
      if(!acceptsChain(signal.token.chain))throw new Error('CHAIN_DISABLED');
      backgroundGmgnAbort?.abort();
      if(closed||active>=4)throw new Error('RESEARCH_BUSY');
      active++;
      try {
        const report=await evaluate(signal,config,providers,options);
        try{memeObserver?.captureReport(report);memeCaptureError=undefined;}catch{memeCaptureError='MEME_REPORT_CAPTURE_FAILED';}
        if(walletHistory)try {walletHistory.captureReport(report);walletCaptureError=undefined;}
        catch {walletCaptureError='WALLET_HISTORY_WRITE_FAILED';}
        return report;
      } finally {active--;}
    },
    entry:async report=>{if(!closed)await entry.consider(report);},
  }):undefined;
  const sweep=setInterval(()=>{
    store.prune(config.researchCacheTtlSec,config.researchCacheMax);orders.recover();
    try {archive?.maintenance();archiveMaintenanceError=undefined;}
    catch {archiveMaintenanceError='SCAN_ARCHIVE_MAINTENANCE_FAILED';}
  },60000);sweep.unref();
  let reconcileTimer:ReturnType<typeof setInterval>|undefined;
  let debotSyncTimer:ReturnType<typeof setInterval>|undefined;
  const walletResearchStatus=()=>{
      // This is an O(1) memory read. Large historical COUNT queries belong to
      // the dedicated worker and must never run in the HTTP / stream loop.
      const stats=walletStatsRunner?.snapshot();
      const index=walletIndexRunner?.snapshot();
      return {enabled:config.walletResearch.enabled,store:stats?.store,seedsError:walletSeedsError,
        statsComputedAt:stats?.computedAt,statsLastAttemptAt:stats?.lastAttemptAt,
        statsStale:stats?.stale??false,statsState:stats?.state??'disabled',statsError:stats?.error,statsWorker:stats?.worker,
        observer:walletObserver?.getStatus()??{enabled:false,running:false,pausedReason:backgroundGmgnPausedReason},
        profiles:walletProfilesStatus(),screening:walletScreening?{...walletScreening.status(),discoveryEnabled:backgroundGmgnEnabled}:undefined,
        localIndex:index??{running:false,inFlight:false,invalidationMs:0,invalidationProcessed:0,invalidationPending:0,coordinationMs:0,associationMs:0,restarts:0},
        captureError:walletCaptureError??index?.workerError??index?.invalidationError??index?.coordinationError??index?.associationError,
        settings:{intervalSec:config.walletResearch.intervalSec,maxRequestsPerCycle:config.walletResearch.maxRequestsPerCycle,
          maxBytes:config.walletResearch.maxBytes,retention:'persistent_no_expiry',scope:'vendor_pages_and_observed_wallet_snapshots'}};
    };
  const walletAssociationsStatus=()=>{
    const snapshot=walletIndexRunner?.snapshot(),stats=snapshot?.associationStats;
    return stats?{...stats,state:'fresh',computedAt:snapshot?.completedAt}:{sampleOnly:true,ownership:'unknown',tradingEnabled:false,
      state:'loading',computedAt:snapshot?.completedAt,error:snapshot?.associationError??snapshot?.workerError};
  };
  const protectionSummary=()=>{
    if(!exitShadow)return {enabled:false,mode:'shadow',liveReady:false};
    try {return {...exitShadow.summary(),walletPressure:walletExitPressure?.status(),captureError:exitCaptureError};}
    catch {return {enabled:true,mode:'shadow',liveReady:false,captureError:'EXIT_SHADOW_READ_FAILED'};}
  };
  let exitMaintenanceTimer:ReturnType<typeof setInterval>|undefined;
  if(telegram&&config.telegram)try{
    positionPriceHealth=new PositionPriceHealth(config.telegram.database,{enqueue:event=>telegram!.enqueue(event)});
  }catch{positionPriceHealthError='POSITION_PRICE_HEALTH_STARTUP_FAILED';}
  refreshPriceSubscriptions=()=>{
    if(closed)return;
    try{
      const positions=positionPriceTokens(),targets=mergeTokens(positions,backgroundPriceTokens).slice(0,200);
      subscribedPriceKeys=new Set(targets.map(token=>`${token.chain}:${token.address}`));
      aveScanner?.setPriceTokens(targets,positions);
      const candidates=[...orders.activePositions().filter(order=>order.status==='confirmed'&&!positionClosed(order.id))
        .map(order=>({id:order.id,chain:order.chain,address:order.tokenAddress,wallet:order.wallet,name:orderDisplay(order)?.name})),
        ...(heldMonitor?.status().positions??[]).filter(p=>p.status!=='balance_zero'&&!positionClosed(p.id))
          .map(p=>({id:p.id,chain:p.chain,address:p.address,wallet:p.wallet,name:p.name}))];
      // A native order can also appear in the recovered-holdings reader. Health
      // is keyed by the financial position id, so keep one exact observation.
      let identityConflict=false;const unique=new Map<string,typeof candidates[number]>();
      for(const position of candidates){const prior=unique.get(position.id);
        if(!prior)unique.set(position.id,position);
        else if(prior.chain!==position.chain||prior.address!==position.address||prior.wallet!==position.wallet)identityConflict=true;}
      const tracked=[...unique.values()];
      positionPriceHealth?.tick({connected:aveScanner?.getStatus().connected??false,positions:tracked.map(p=>{
        const stream=priceRouter.latestStream(p);
        const route=priceRouter.latest(p),now=Date.now();
        const native=nativeTrading?.get(p.id);
        const observed=nativePositionHealthQuote(native,p.address,now,p.wallet)??(
          route.status==='available'&&stream?.source==='ave_price_stream_sample'&&
          Date.parse(stream.observedAt)<=now&&Date.parse(stream.validUntil)>now?
            {observedAt:stream.observedAt,validUntil:stream.validUntil,source:stream.source}:
            route.status==='available'&&route.sample?
              {observedAt:route.sample.observedAt,validUntil:route.sample.validUntil,source:route.sample.source}:undefined);
        return {...p,subscriptionSent:aveScanner?.hasPriceSubscription(p)??false,
          streamObservedAt:stream?.source==='ave_price_stream_sample'?stream.observedAt:undefined,
          ...(observed?{price:observed}:{})};
      })});
      if(positionPriceHealthError!=='POSITION_PRICE_HEALTH_STARTUP_FAILED')
        positionPriceHealthError=identityConflict?'POSITION_PRICE_IDENTITY_CONFLICT':undefined;
    }catch{positionPriceHealthError='POSITION_PRICE_SUBSCRIPTION_REFRESH_FAILED';}
  };
  const positionPriceStreamStatus=()=>{
    const nativeStatus=nativeTrading?.status();
    return {mode:'multi_source_position_quotes',scope:'market_observation',primary:'native_sol_sell_quote',
      fallbacks:['ave_pricev2','dexscreener','debot','gmgn'],httpFallbackMinIntervalMs:30000,
      executableProtection:nativeStatus&&'protection' in nativeStatus?nativeStatus.protection:undefined,
      health:positionPriceHealth?.status(),stream:aveScanner?.getStatus().priceStream,
      error:positionPriceHealthError};
  };
  const maintainProtection=()=>{
    try{exitShadow?.tick();}catch{exitCaptureError='EXIT_SHADOW_MAINTENANCE_FAILED';}
    try{
      const targets=streamPriceTokens();
      // Keep research failures from blocking the immediate subscription of a new holding.
      if(!priceTargetError){const heldKeys=new Set(positionPriceTokens().map(t=>`${t.chain}:${t.address}`));
        backgroundPriceTokens=targets.filter(t=>!heldKeys.has(`${t.chain}:${t.address}`));}
      refreshPriceSubscriptions();
    }catch{priceTargetError='PRICE_STREAM_TARGET_REFRESH_FAILED';}
  };
  return {client,providers,store,orders,entry,dailyReview,scanner,debotScanner,debotStream,debotAuth,archive,followupReview,tracking,priceRouter,walletHistory,walletIndexRunner,walletObserver,walletResearchStatus,walletAssociationsStatus,walletProfiles,walletProfilesStatus,walletScreening,watchRechecker,exitShadow,chainMonitor,chainStreamStatus,memeObserver,sourceEvidence,aveScanner,aveSession,tokenRankResearch,jevShadow,telegram,tradeNotifications,telegramStatus,heldMonitor,heldTracking,
    signalCounting,telegramControls,telegramPositions,manualClose,directSell,manualNativeBuy,telegramTokenCard,
    executionStatus:()=>{const counting=signalCounting.status();return {
      configuredEntryMode:config.entryMode,configuredThirdSignalMode:config.thirdSignalExecutionMode,
      solanaExecutionProvider:config.solanaExecutionProvider,native:nativeTrading?.status(),nativeError:nativeTradingError,
      manualNativeBuy:{enabled:!!manualNativeBuy,readiness:manualNativeBuy?.readiness(),error:manualNativeBuyError},
      executionEnabled:counting.executionEnabled,countingRunning:counting.running,executionReady:counting.executionReady};},
    signalCountingPage:(options:{limit?:number;offset?:number}={})=>({...signalCounting.page(options),controls:telegramControls?.status()}),
    signalCountingControl:(action:'start'|'stop',actor:'web')=>signalCounting.control(action,actor),
    jevStatus:()=>{const summary=jevStatusRunner?.snapshot();return {...jevShadow?.status(summary?.aggregate??null),captureError:jevCaptureError,
      summaryState:summary?.state??'disabled',summaryComputedAt:summary?.aggregate?.computedAt,summaryStale:summary?.stale??false,
      summaryError:summary?.error,summaryWorker:summary?.worker};},
    dashboardHome:()=>{
      const host=system?.get();
      const nativeStatus=nativeTrading?.status();
      const nativeDetails=nativeStatus&&'stream' in nativeStatus?nativeStatus:undefined;
      return {now:new Date().toISOString(),entryMode:config.thirdSignalExecutionMode==='live'?'live':config.entryMode,
        researchEntryMode:config.entryMode,signalCounting:signalCounting.status(),stats:archive?.overviewStats(),heldPositions:heldStatus(),
        status:{scannerRunning:scanner.getStatus().running,debotState:debotStream?.getStatus().state??'disabled',
          nativeExecution:config.solanaExecutionProvider==='pump_native'?{provider:'pump_native',
            readiness:nativeTrading?.readiness()??{ready:false,reason:nativeTradingError},antiMev:'Jito 私有发送 · 不回退公开广播',
            process:nativeStatus?.process,prices:nativeDetails?.prices,inventory:nativeDetails?.inventory,
            protection:nativeDetails?.protection,orderSyncPending:nativeDetails?.orderSyncPending,
            stream:nativeDetails?.stream?{connected:nativeDetails.stream.connected,transportHealthy:nativeDetails.stream.transportHealthy,
              headAgeMs:nativeDetails.stream.headAgeMs,lastHeadSlot:nativeDetails.stream.lastHeadSlot,
              requestedAccounts:nativeDetails.stream.requestedAccounts,subscribedAccounts:nativeDetails.stream.subscribedAccounts.length,
              pendingSubscriptions:nativeDetails.stream.pendingSubscriptions,failedSubscriptions:nativeDetails.stream.failedSubscriptions}:undefined}:undefined,
          scannerPausedReason:backgroundGmgnPausedReason,
          trackingRunning:tracking?.getStatus().running??false,startedAt:host?.startedAt,uptimeSec:host?.uptimeSec,
          archiveError:archiveCaptureError??store.observationError??archiveMaintenanceError},
        settings:{scanRetentionDays:config.dashboard.retentionDays,trackingHours:config.dashboard.trackingHours,
          sampleIntervalSec:config.dashboard.sampleIntervalSec}};
    },
    dashboardProtection:(options:DashboardPageOptions={limit:20,offset:0})=>{
      if(!exitShadow)return {...protectionSummary(),items:[],total:0,limit:options.limit,offset:options.offset,hasMore:false,priceRouter:priceRouter.getStatus()};
      const page=exitShadow.page(options);
      return {...page,items:page.items.map(item=>({...item,priceRoute:priceRouter.latest(item)})),captureError:exitCaptureError,priceRouter:{...priceRouter.getStatus(),captureError:priceTargetError}};
    },
    dashboardOverview:()=>({entryAuditError,now:new Date().toISOString(),entryMode:config.thirdSignalExecutionMode==='live'?'live':config.entryMode,
      positionPriceStream:positionPriceStreamStatus(),
      researchEntryMode:config.entryMode,telegram:telegramStatus(),heldPositions:heldStatus(),signalCounting:signalCounting.status(),
      priceCapacity:{observationTargetLimit:200,maxTokensPerCycle:30,intervalMs:config.dashboard.sampleIntervalSec*1000,
        activeOrderTokens:new Set(positionPriceTokens().map(token=>`${token.chain}:${token.address}`)).size,
        maxOpenPositions:config.entryMaxOpen,priority:'bot_live_orders_first',scope:'observation_capacity_not_live_exit_guarantee'},
      gmgnUsage:{mode:backgroundGmgnEnabled?'full_research':'trade_and_on_demand',backgroundResearchEnabled:backgroundGmgnEnabled,
        label:backgroundGmgnEnabled?'行情研究与交易':'交易与按需查询',pausedReason:backgroundGmgnPausedReason,
        pausedTasks:backgroundGmgnEnabled?[]:['market_scanner','wallet_enrichment_polling','meme_gmgn_sampling',
          'wallet_discovery_research','wallet_fast_full_research','watch_rechecks'],
        retainedTasks:['signal_details_and_safety','positions','price_fallback','trading',
          'debot_ave_signals','chain_trade_classification','local_wallet_profiles_and_indexes']},
      scanner:{...scanner.getStatus(),enabled:backgroundGmgnEnabled&&config.scannerEnabled,pausedReason:backgroundGmgnPausedReason},
      debotScanner:debotScanner?.getStatus()??{enabled:false,running:false},
      debotStream:debotStream?.getStatus(),
      meme:memeObserver?{...memeObserver.status(),captureError:memeCaptureError}:{enabled:false},
      ave:aveScanner?{...aveScanner.getStatus(),nominationCaptureError,session:aveSession?.getStatus()??{status:'required',authenticated:false,reason:'AVE_LOGIN_EMAIL_NOT_CONFIGURED'}}:{enabled:false},
      tokenRankResearch:tokenRankResearch?.status()??{enabled:false},
      corroboration:sourceEvidence?{...sourceEvidence.status(),captureError:sourceCaptureError}:{enabled:false},
      tracking:tracking?.getStatus(),priceRouter:{...priceRouter.getStatus(),captureError:priceTargetError},stats:archive?.stats(),archiveError:archiveCaptureError??store.observationError??archiveMaintenanceError,
      settings:dashboardSettings(config),balances:balances?.get()??[],system:system?.get(),walletResearch:walletResearchStatus(),exitProtection:protectionSummary(),chainStream:chainStreamStatus(),
      watchRecheck:watchRechecker?{enabled:backgroundGmgnEnabled,...watchRechecker.getStatus(),pausedReason:backgroundGmgnPausedReason}:{enabled:false}}),
    dashboardOrders:(options:DashboardPageOptions={limit:20,offset:0})=>dashboardOrders(orders,options),
    start(){
      if(closed) return;
      walletStatsRunner?.start();
      walletIndexRunner?.start();
      followupReview?.start();
      jevStatusRunner?.start();
      nativeTrading?.start();
      if(telegram&&tradeNotifications&&config.telegram){
        try {
          const destination=createHash('sha256').update(config.telegram.token!+'\0'+config.telegram.chatId!).digest('hex');
          telegram.enqueue({key:`connected:${destination}`,text:`Meme 交易通知已连接\n通知范围：开单状态、止盈止损状态、持仓价格观察及报价异常。\n研究开仓入口：${config.entryMode==='off'?'关闭':config.entryMode==='paper'?'模拟':'实盘'}\n第三次通知策略：${config.thirdSignalExecutionMode==='live'?'实盘':'模拟'} · ${signalCounting.status().running?'计数运行中':'等待启动计数'}\n此消息为连接测试，不代表已下单。`});
          telegram.enqueue({key:`signal-counting-controls:v2:${destination}`,text:signalCounting.controlText()});
          telegram.enqueue({key:`telegram-position-menu:v3:${destination}`,text:signalCounting.controlText()+
            '\n\n「持仓查询」每页 5 个，支持翻页和刷新；Solana 持仓可点击 25%、50%、75%、100% 直接卖出。'+
            '\n发送完整 CA 可打开代币卡片，再选择卡片上的买入金额。'+
            '\n信号策略开仓金额仍为原生币总余额的 3%，另预留手续费及待结算占用。'});
          if(config.thirdSignalExecutionMode==='live')telegram.enqueue({key:`third-signal-live-controls:v3:${config.solanaExecutionProvider}:${destination}`,
            text:signalCounting.controlText()+`\n\n每单按 SOL 总余额的 3%；翻倍卖出 50%、跌 ${config.exitPolicy?.stopLoss.dropPct??60}% 卖出余仓。`+
              (config.solanaExecutionProvider==='pump_native'?'\n执行方式：Pump / PumpSwap 原生交易，Jito 防夹；保护由本机持仓服务执行。签名器或监控未就绪时禁止开仓。':'\n执行方式：GMGN 买单附带条件单。')+
              '\n点击「启动计数」开始接收新信号；点击「停止计数」停止新开仓，持仓监控继续。'});
          if(directSell){
            const reply=telegramPositions.page(1);
            telegram.enqueue({key:`telegram-direct-sell-menu:v1:${destination}`,
              ...(typeof reply==='string'?{text:reply}:reply)});
          }
          syncTradeNotifications();telegram.start();telegramControls?.start();
        }catch{telegramCaptureError='TELEGRAM_START_FAILED';}
        if(!telegramTimer){telegramTimer=setInterval(syncTradeNotifications,5000);telegramTimer.unref();}
      }
      try{heldMonitor?.start();heldTracking?.start();}catch{heldCaptureError='HELD_MONITOR_START_FAILED';}
      recoverManualClose();recoverDirectSell();
      if((manualClose||directSell)&&!manualCloseTimer){manualCloseTimer=setInterval(()=>{recoverManualClose();recoverDirectSell();},15000);manualCloseTimer.unref();}
      jevShadow?.start();
      walletExitPressure?.start();
      try{exitShadow?.migrateActiveToV3();}catch{exitCaptureError='EXIT_SHADOW_MIGRATION_FAILED';}
      maintainProtection();
      if(!exitMaintenanceTimer){exitMaintenanceTimer=setInterval(maintainProtection,15_000);exitMaintenanceTimer.unref();}
      if(memeObserver){
        for(const observation of debotScanner?.observationSeeds()??[])observeSignal(observation.signal,observation.observedAt,observation,false);
        memeObserver.start();
      }
      walletFastResearch?.start();walletFast?.start();
      chainMonitor?.start();tracking?.start();balances?.start();system?.start();walletProfiles?.start();tokenRankResearch?.start();walletScreening?.start(backgroundGmgnEnabled?async signal=>{
        if(closed||active>=4||!config.gmgnApiKey?.trim()||client.cooldownUntil>Date.now()||scanner.getStatus().inFlight)return false;
        await onSignal(signal);
      }:undefined);
      if(config.gmgnApiKey?.trim())walletObserver?.start();
      if(backgroundGmgnEnabled&&config.scannerEnabled&&config.gmgnApiKey?.trim()) scanner.start();
      debotScanner?.start();
      aveScanner?.start();
      if(debotStream) {
        void debotStream.start();
        debotSyncTimer=setInterval(()=>{if(debotStream.getStatus().authorized)void debotScanner?.runOnce();},60_000);
        debotSyncTimer.unref();
      }
      if(backgroundGmgnEnabled)watchRechecker?.start();
      if(!reconcileTimer&&config.gmgnApiKey?.trim()&&config.gmgnPrivateKey?.trim()) {
        void reconciler.runOnce();
        reconcileTimer=setInterval(()=>{void reconciler.runOnce();},30000);reconcileTimer.unref();
      }
    },
    async close(){
      if(closed) return;closed=true;scanner.stop();clearInterval(sweep);clearInterval(reconcileTimer);clearInterval(debotSyncTimer);clearInterval(exitMaintenanceTimer);clearInterval(telegramTimer);
      await telegramControls?.close();
      // Fence both sources before draining third-signal callbacks. Otherwise a
      // final socket/page event can be admitted after waitForDispatches returns.
      await debotStream?.stop();
      await Promise.all([aveScanner?.stop(),debotScanner?.stop()]);
      await thirdEntry?.stop();await signalCounting.waitForDispatches();
      await manualNativeBuy?.close();
      await nativeTrading?.stop();
      clearInterval(manualCloseTimer);await directSell?.stop();await directSellRecovery;
      await manualClose?.stop();await manualCloseRecovery;
      for(const task of jevPending)clearImmediate(task);jevPending.clear();
      await jevStatusRunner?.stop();
      await jevShadow?.stop();
      await heldTracking?.stop();await heldMonitor?.stop();
      priceRouter.close();
      await walletFast?.stop();walletVerifier?.stop();await walletFastResearch?.stop();walletActivity?.close();
      await Promise.all([chainMonitor?.stop(),tracking?.stop(),balances?.stop(),walletObserver?.stop(),system?.stop(),watchRechecker?.stop()]);
      await walletExitPressure?.stop();
      await walletIndexRunner?.stop();
      await followupReview?.stop();
      await reconciler.stop();
      // Stop means no new work. Await current callback before closing its stores.
      while(active) await new Promise(resolve=>setTimeout(resolve,50));
      await tokenRankResearch?.stop();
      await memeObserver?.close();
      await aveScanner?.close();sourceEvidence?.close();
      await walletScreening?.close();
      await walletProfiles?.stop();
      await debotScanner?.close();
      await walletStatsRunner?.stop();
      heldMonitor?.close();
      unsubscribeOrderNotifications();positionPriceHealth?.close();tradeNotifications?.close();await telegram?.close();
      directSell?.close();manualClose?.close();
      signalCounting.close();
      store.close();orders.close();dailyReview?.close();archive?.close();walletHistory?.close();exitShadow?.close();
    }};
}
