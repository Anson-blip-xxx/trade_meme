import {isPersistentOrderPath,type Config} from './config.js';
import type {Signal} from './types.js';
import {Store} from './store.js';
import {OrderStore} from './orders.js';
import {EntryController} from './entry.js';
import {GmgnClient} from './providers/gmgn-client.js';
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

export function createRuntime(config:Config) {
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
  const client=new GmgnClient({apiKey:config.gmgnApiKey,minIntervalMs:config.gmgnMinIntervalMs});
  if(config.meme?.enabled&&[config.ordersDatabase,config.dashboard.archivePath,config.walletResearch.database,
    config.walletProfiles.database,config.walletScreening.database,config.chainStream.database,config.exitShadow.database,
    config.debotSignalsDatabase,config.debotSessionPath].some(path=>sameDatabase(path,config.meme!.database)))
    throw new Error('MEME_DATABASE_CONFLICT');
  const protectedPaths=[config.ordersDatabase,config.dashboard.archivePath,config.walletResearch.database,config.walletProfiles.database,
    config.walletScreening.database,config.chainStream.database,config.exitShadow.database,config.debotSignalsDatabase,config.debotSessionPath,
    ...(config.meme?.enabled?[config.meme.database]:[])];
  for(const path of [...(config.corroboration&&(config.meme?.enabled||config.ave?.enabled)?[config.corroboration.database]:[]),
    ...(config.ave?.enabled?[config.ave.database,config.ave.sessionPath]:[])]){
    if(protectedPaths.some(existing=>sameDatabase(existing,path)))throw new Error('SOURCE_DATABASE_CONFLICT');
    protectedPaths.push(path);
  }
  if(config.tokenRankResearch?.enabled&&[...protectedPaths,
    ...(config.meme?[config.meme.database]:[]),...(config.corroboration?[config.corroboration.database]:[]),
    ...(config.ave?[config.ave.database,config.ave.sessionPath]:[])].some(path=>sameDatabase(path,config.tokenRankResearch!.database)))
    throw new Error('TOKEN_RANK_DATABASE_MUST_BE_SEPARATE');
  const providers=liveProviders(config,client);
  const archive=config.dashboard.enabled||config.watch.enabled||config.exitShadow.enabled||config.chainStream.enabled?new ScanArchive(config.dashboard.archivePath,{
    retentionDays:config.dashboard.retentionDays,trackingHours:config.dashboard.trackingHours,followupEnabled:true}):undefined;
  if(config.watch.enabled)archive?.configureWatch({windowSec:config.watch.windowSec,intervalSec:config.watch.intervalSec,maxSignalAgeSec:config.maxSignalAgeSec});
  const walletHistory=config.walletResearch.enabled?new WalletHistory(config.walletResearch.database,{maxBytes:config.walletResearch.maxBytes}):undefined;
  const walletProfiles=walletHistory&&config.walletProfiles.enabled?new WalletProfileRunner({
    ...config.walletProfiles,historyDatabase:config.walletResearch.database,
    ...(config.chainStream.enabled?{chainDatabase:config.chainStream.database}:{})}):undefined;
  const walletProfilesStatus=()=>walletProfiles?.status()??{enabled:false,running:false,ready:false};
  const walletScreening=walletHistory&&walletProfiles&&config.walletScreening.enabled?new WalletScreeningService(walletHistory,walletProfiles.reader,
    {...config.walletScreening,sourcePaths:[config.walletResearch.database,config.walletProfiles.database,config.ordersDatabase,config.dashboard.archivePath,
      config.chainStream.database,config.exitShadow.database]}):undefined;
  if(walletScreening){
    providers.walletScreening=(s,r,now)=>walletScreening.assess(s,r,now);
    providers.research=researchProvider(config,client,undefined,{walletTargets:signal=>walletScreening.researchTargets(signal)});
  }
  const exitShadow=config.exitShadow.enabled?new ExitShadow(config.exitShadow.database,config.exitShadow):undefined;
  const walletObserver=walletHistory?new WalletObserver({history:walletHistory,client,config,chains:config.scannerChains,
    intervalMs:config.walletResearch.intervalSec*1000,maxRequestsPerCycle:config.walletResearch.maxRequestsPerCycle}):undefined;
  let archiveCaptureError:string|undefined,walletCaptureError:string|undefined,walletIndexError:string|undefined,associationIndexError:string|undefined;
  let memeCaptureError:string|undefined;
  let sourceCaptureError:string|undefined,nominationCaptureError:string|undefined;
  const sourceEvidence=config.corroboration&&(config.meme?.enabled||config.ave?.enabled)
    ?new SourceCorroboration(config.corroboration.database,{maxBytes:config.corroboration.maxBytes}):undefined;
  let backgroundGmgnAbort:AbortController|undefined;
  const memeObserver=config.meme?.enabled?new MemeObserver({...config.meme,marketBatch:fetchMemeMarkets,
    ...(config.gmgnApiKey?.trim()?{marketFallback:async(token:Signal['token'],abort:AbortSignal)=>{
      if(active||scanner.getStatus().inFlight)return;
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
    if(signal.source==='manual'||signal.source==='gmgn'&&!signal.sourceEventId.startsWith('gmgn:trade:'))return;
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
  }),orders=new OrderStore(config.ordersDatabase);
  let exitCaptureError:string|undefined;
  const recordPrice=(price:ScanPrice)=>{
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
        let pressure;
        try {pressure=walletHistory?.recentExitPressure(price,price.observedAt);}
        catch {walletCaptureError='WALLET_EXIT_PRESSURE_READ_FAILED';}
        exitShadow.recordPrice(price,seed,pressure);exitCaptureError=undefined;
      }catch {exitCaptureError='EXIT_SHADOW_CAPTURE_FAILED';}
      if(archiveFailed)throw new Error('PRICE_ARCHIVE_WRITE_FAILED');
    };
  const recordPriceError=(token:ScanToken,reason:string,now?:Date)=>{
      let archiveFailed=false;
      try {archive?.recordPriceError(token,reason,now);}catch {archiveFailed=true;}
      if(exitShadow)try {exitShadow.recordError(token,reason,now);}catch {exitCaptureError='EXIT_SHADOW_CAPTURE_FAILED';}
      if(archiveFailed)throw new Error('PRICE_ARCHIVE_WRITE_FAILED');
    };
  const chainMonitor=config.chainStream.enabled?new ChainMonitor({config:config.chainStream,
    tokens:()=>archive?.streamingTokens(new Date(),config.chainStream.maxPools)??[],wallets:(chain,limit)=>walletHistory?.streamWalletTargets(chain,limit)??[],onPrice:recordPrice}):undefined;
  const chainStreamStatus=()=>{try{return chainMonitor?.getStatus()??{enabled:false,running:false,mode:'observation_only',chains:[],recentEvents:[]};}
    catch{return {enabled:config.chainStream.enabled,mode:'observation_only',captureError:'CHAIN_STATUS_READ_FAILED',chains:[],recentEvents:[]};}};
  const tracking=archive?new PriceTracker({archive:{
    pendingTokens:(limit,now)=>archive.trackingTokens(3,now,t=>!!chainMonitor?.covers(t)).slice(0,limit??3),
    recordPrice,recordPriceError},client,intervalMs:config.dashboard.sampleIntervalSec*1000,maxTokensPerCycle:3}):undefined;
  const balances=config.dashboard.enabled?new DashboardBalances(config):undefined;
  const system=config.dashboard.enabled?new SystemMonitor(dirname(config.ordersDatabase)):undefined;
  orders.recover();
  const entry=new EntryController(config,orders,client,walletScreening?{walletEvidence:(report,now)=>walletScreening.revalidate(report,now)}:{});
  const reconciler=new OrderReconciler(orders,entry);
  let closed=false,active=0,archiveMaintenanceError:string|undefined;
  const onSignal=async(signal:Signal,firstReceivedAt?:string,context?:{detailsReady:Promise<void>;repeat?:boolean}):Promise<void>=>{
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
    fetcher:aveSession?.fetcher,onObservation:observation=>{
      try {
        const captured=walletHistory?.captureVendorNominations(observation.signal.token,{source:'ave',
          eventId:observation.signal.sourceEventId,occurredAt:observation.signal.occurredAt,observedAt:observation.observedAt,
          wallets:observation.vendorWallets??[]});
        nominationCaptureError=captured?.reason;
      }catch{nominationCaptureError='WALLET_NOMINATION_CAPTURE_FAILED';}
      observeSignal(observation.signal,observation.observedAt,observation);
    },
    onSignal,shouldDefer:()=>closed?'SERVICE_STOPPING':!config.gmgnApiKey?.trim()?'GMGN_API_KEY_MISSING':
      client.cooldownUntil>Date.now()?'GMGN_RATE_LIMITED':active>=2?'RESEARCH_BUSY':scanner.getStatus().inFlight?'SCANNER_BUSY':undefined}):undefined;
  const debotSession=config.debotScannerEnabled&&config.debotTransport==='authenticated_stream'?new DebotSessionClient({
    path:config.debotSessionPath,onAuthRequired:()=>{debotAuth?.setAuthenticated(false);debotStream?.invalidateSession();}}):undefined;
  const debotScanner:DebotScanner|undefined=config.debotScannerEnabled?new DebotScanner({database:config.debotSignalsDatabase,mode:config.debotTransport,
    chains:config.scannerChains,intervalSec:config.debotScannerIntervalSec,
    maxConcurrent:debotSession?2:1,parallelDetails:!!debotSession,
    lookupDisplay:reportId=>archive?.tokenDisplay(reportId),
    maxAgeSec:debotSession?Math.min(120,config.maxSignalAgeSec):config.maxSignalAgeSec,onSignal,
    onObservation:observation=>observeSignal(observation.signal,observation.observedAt,observation),
    repeatEvidence:(input,signal)=>{
      // Optional profile lookup must not hide independently observed sell trades.
      const walletTargets=(()=>{try{return walletScreening?.researchTargets(signal);}catch{return undefined;}})();
      return assessDebotRepeatEvidence({...input,history:walletHistory,walletTargets});
    },
    ...(debotSession?{fetchPage:(chain:Signal['token']['chain'])=>fetchDebotSignalPage(chain,{fetcher:debotSession.fetcher}),
      fetchDetails:(observation:Parameters<typeof fetchDebotWalletDetails>[0])=>fetchDebotWalletDetails(observation,{fetcher:debotSession.fetcher,signal:AbortSignal.timeout(4000)})}:{}),
    shouldDefer:()=>closed?'SERVICE_STOPPING':!debotSession&&!config.gmgnApiKey?.trim()?'GMGN_API_KEY_MISSING':
      !debotSession&&client.cooldownUntil>Date.now()?'GMGN_RATE_LIMITED':active>=4?'RESEARCH_BUSY':
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
    shouldDefer:()=>closed?'SERVICE_STOPPING':!config.gmgnApiKey?.trim()?'GMGN_API_KEY_MISSING':
      client.cooldownUntil>Date.now()?'GMGN_RATE_LIMITED':active>=4?'RESEARCH_BUSY':scanner.getStatus().inFlight?'SCANNER_BUSY':undefined,
    evaluate:async(signal,options)=>{
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
    try {archive?.prune();archive?.refreshFollowup();archiveMaintenanceError=undefined;}
    catch {archiveMaintenanceError='SCAN_ARCHIVE_MAINTENANCE_FAILED';}
  },60000);sweep.unref();
  let reconcileTimer:ReturnType<typeof setInterval>|undefined;
  let debotSyncTimer:ReturnType<typeof setInterval>|undefined;
  let walletIndexTimer:ReturnType<typeof setInterval>|undefined;
  let walletIndexWork:Promise<void>|undefined;
  let walletStats:unknown,walletStatsAt=0;
  const walletIndexTimings={coordinationMs:0,associationMs:0};
  const refreshWalletIndexes=()=>{
    if(closed||!walletHistory||walletIndexWork)return;
    // Preserve the per-cycle quota, but return control between wallets so HTTP,
    // heartbeat and websocket callbacks are not held behind a whole graph batch.
    walletIndexWork=(async()=>{
      for(let i=0;i<10&&!closed;i++) {
        const started=performance.now();
        try {walletHistory.refreshCoordination(1);walletIndexError=undefined;}
        catch {walletIndexError='WALLET_COORDINATION_REFRESH_FAILED';}
        walletIndexTimings.coordinationMs=Math.round(performance.now()-started);
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
      for(let i=0;i<3&&!closed;i++) {
        const started=performance.now();
        try {walletHistory.refreshAssociations(1);associationIndexError=undefined;}
        catch {associationIndexError='WALLET_ASSOCIATION_REFRESH_FAILED';}
        walletIndexTimings.associationMs=Math.round(performance.now()-started);
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
    })().finally(()=>{walletIndexWork=undefined;});
  };
  const walletResearchStatus=()=>{
      // Overview and wallet panels request the same aggregate in parallel.
      // Count the large historical tables once per interval, not for every view.
      if(Date.now()-walletStatsAt>=30000) {
        try {walletStats=walletHistory?.stats();}catch {walletStats={error:'WALLET_HISTORY_READ_FAILED'};}
        walletStatsAt=Date.now();
      }
      return {enabled:config.walletResearch.enabled,store:walletStats,statsComputedAt:new Date(walletStatsAt).toISOString(),observer:walletObserver?.getStatus(),profiles:walletProfilesStatus(),screening:walletScreening?.status(),
        localIndex:{inFlight:!!walletIndexWork,...walletIndexTimings},captureError:walletCaptureError??walletIndexError??associationIndexError,
        settings:{intervalSec:config.walletResearch.intervalSec,maxRequestsPerCycle:config.walletResearch.maxRequestsPerCycle,
          maxBytes:config.walletResearch.maxBytes,retention:'persistent_no_expiry',scope:'vendor_pages_and_observed_wallet_snapshots'}};
    };
  const protectionSummary=()=>{
    if(!exitShadow)return {enabled:false,mode:'shadow',liveReady:false};
    try {return {...exitShadow.summary(),captureError:exitCaptureError};}
    catch {return {enabled:true,mode:'shadow',liveReady:false,captureError:'EXIT_SHADOW_READ_FAILED'};}
  };
  return {client,providers,store,orders,entry,scanner,debotScanner,debotStream,debotAuth,archive,tracking,walletHistory,walletObserver,walletResearchStatus,walletProfiles,walletProfilesStatus,walletScreening,watchRechecker,exitShadow,chainMonitor,chainStreamStatus,memeObserver,sourceEvidence,aveScanner,aveSession,tokenRankResearch,
    dashboardHome:()=>{
      const host=system?.get();
      return {now:new Date().toISOString(),entryMode:config.entryMode,stats:archive?.overviewStats(),
        status:{scannerRunning:scanner.getStatus().running,debotState:debotStream?.getStatus().state??'disabled',
          trackingRunning:tracking?.getStatus().running??false,startedAt:host?.startedAt,uptimeSec:host?.uptimeSec,
          archiveError:archiveCaptureError??store.observationError??archiveMaintenanceError},
        settings:{scanRetentionDays:config.dashboard.retentionDays,trackingHours:config.dashboard.trackingHours,
          sampleIntervalSec:config.dashboard.sampleIntervalSec}};
    },
    dashboardProtection:(options:DashboardPageOptions={limit:20,offset:0})=>exitShadow
      ?{...exitShadow.page(options),captureError:exitCaptureError}
      :{...protectionSummary(),items:[],total:0,limit:options.limit,offset:options.offset,hasMore:false},
    dashboardOverview:()=>({now:new Date().toISOString(),entryMode:config.entryMode,scanner:scanner.getStatus(),
      debotScanner:debotScanner?.getStatus()??{enabled:false,running:false},
      debotStream:debotStream?.getStatus(),
      meme:memeObserver?{...memeObserver.status(),captureError:memeCaptureError}:{enabled:false},
      ave:aveScanner?{...aveScanner.getStatus(),nominationCaptureError,session:aveSession?.getStatus()??{status:'required',authenticated:false,reason:'AVE_LOGIN_EMAIL_NOT_CONFIGURED'}}:{enabled:false},
      tokenRankResearch:tokenRankResearch?.status()??{enabled:false},
      corroboration:sourceEvidence?{...sourceEvidence.status(),captureError:sourceCaptureError}:{enabled:false},
      tracking:tracking?.getStatus(),stats:archive?.stats(),archiveError:archiveCaptureError??store.observationError??archiveMaintenanceError,
      settings:dashboardSettings(config),balances:balances?.get()??[],system:system?.get(),walletResearch:walletResearchStatus(),exitProtection:protectionSummary(),chainStream:chainStreamStatus(),
      watchRecheck:watchRechecker?{enabled:true,...watchRechecker.getStatus()}:{enabled:false}}),
    dashboardOrders:(options:DashboardPageOptions={limit:20,offset:0})=>dashboardOrders(orders,options),
    start(){
      if(closed) return;
      if(memeObserver){
        for(const observation of debotScanner?.observationSeeds()??[])observeSignal(observation.signal,observation.observedAt,observation,false);
        memeObserver.start();
      }
      chainMonitor?.start();tracking?.start();balances?.start();system?.start();walletProfiles?.start();tokenRankResearch?.start();walletScreening?.start(async signal=>{
        if(closed||active>=4||!config.gmgnApiKey?.trim()||client.cooldownUntil>Date.now()||scanner.getStatus().inFlight)return false;
        await onSignal(signal);
      });
      if(walletHistory&&!walletIndexTimer) {
        setImmediate(refreshWalletIndexes);
        walletIndexTimer=setInterval(refreshWalletIndexes,10000);walletIndexTimer.unref();
      }
      if(config.gmgnApiKey?.trim())walletObserver?.start();
      if(config.scannerEnabled&&config.gmgnApiKey?.trim()) scanner.start();
      debotScanner?.start();
      aveScanner?.start();
      if(debotStream) {
        void debotStream.start();
        debotSyncTimer=setInterval(()=>{if(debotStream.getStatus().authorized)void debotScanner?.runOnce();},60_000);
        debotSyncTimer.unref();
      }
      watchRechecker?.start();
      if(!reconcileTimer&&config.gmgnApiKey?.trim()&&config.gmgnPrivateKey?.trim()) {
        void reconciler.runOnce();
        reconcileTimer=setInterval(()=>{void reconciler.runOnce();},30000);reconcileTimer.unref();
      }
    },
    async close(){
      if(closed) return;closed=true;scanner.stop();clearInterval(sweep);clearInterval(reconcileTimer);clearInterval(walletIndexTimer);clearInterval(debotSyncTimer);
      await debotStream?.stop();
      await aveScanner?.stop();
      await Promise.all([chainMonitor?.stop(),tracking?.stop(),balances?.stop(),walletObserver?.stop(),system?.stop(),watchRechecker?.stop(),debotScanner?.stop()]);
      await walletIndexWork;
      await reconciler.stop();
      // Stop means no new work. Await current callback before closing its stores.
      while(active) await new Promise(resolve=>setTimeout(resolve,50));
      await tokenRankResearch?.stop();
      await memeObserver?.close();
      await aveScanner?.close();sourceEvidence?.close();
      await walletScreening?.close();
      await walletProfiles?.stop();
      await debotScanner?.close();
      store.close();orders.close();archive?.close();walletHistory?.close();exitShadow?.close();
    }};
}
