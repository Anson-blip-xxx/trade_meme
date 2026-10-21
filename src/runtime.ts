import {DailyReviewStore} from './daily-review-store.js';
import {reviewDatabasePath,reviewSamplingPath} from './daily-review.js';
import {isPersistentOrderPath,type Config} from './config.js';
import type {Signal,Report} from './types.js';
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
import {WalletFastTargets,type FastWalletSnapshot,type FastWalletTarget,type FastTokenCheck} from './wallet-fast.js';

export function createRuntime(config:Config,dependencies:{priceFetcher?:Fetcher}={}) {
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
  let walletSeedsError:string|undefined;
  if(walletHistory)try {walletHistory.importResearchSeeds(loadBundledWalletResearchSeeds());}
  catch {walletSeedsError='WALLET_RESEARCH_SEEDS_IMPORT_FAILED';}
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
  const dailyReview=config.dashboard.enabled?new DailyReviewStore(reviewDatabasePath(config.dashboard.archivePath)):undefined;
  let entryAuditError:string|undefined;
  const exitShadow=config.exitShadow.enabled?new ExitShadow(config.exitShadow.database,config.exitShadow):undefined;
  const walletObserver=walletHistory?new WalletObserver({history:walletHistory,client,config,chains:config.scannerChains,
    intervalMs:config.walletResearch.intervalSec*1000,maxRequestsPerCycle:config.walletResearch.maxRequestsPerCycle}):undefined;
  let archiveCaptureError:string|undefined,walletCaptureError:string|undefined,walletIndexError:string|undefined,associationIndexError:string|undefined;
  let memeCaptureError:string|undefined;
  let sourceCaptureError:string|undefined,nominationCaptureError:string|undefined;
  const sourceEvidence=config.corroboration&&(config.meme?.enabled||config.ave?.enabled)
    ?new SourceCorroboration(config.corroboration.database,{maxBytes:config.corroboration.maxBytes}):undefined;
  let backgroundGmgnAbort:AbortController|undefined;
  const memeObserver=config.meme?.enabled?new MemeObserver({...config.meme,samplingPlanPath:reviewSamplingPath(config.dashboard.archivePath),marketBatch:fetchMemeMarkets,
    // Reuse a committed fresh market observation for research only. This path
    // cannot initialize a position, advance exit protection or submit an order.
    onMarketSample:sample=>{
      if(sample.priceUsd===undefined)return;
      const source=sample.source==='gmgn_token_info'?'gmgn_token_info_sample':sample.source==='dexscreener_pair'?'dexscreener_token_pairs_sample':undefined;
      if(source)archive?.recordFollowupPrice({...sample.token,priceUsd:sample.priceUsd,observedAt:sample.observedAt,source,
        market:{poolAddress:sample.poolAddress,liquidityUsd:sample.liquidityUsd,holderCount:sample.holderCount,top10HolderRate:sample.top10HolderRate}});
    },
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
  // This independent spot observer never waits behind signal research on the GMGN queue.
  const priceRouter=new MarketPriceRouter({client,fetcher:dependencies.priceFetcher,
    debotFetcher:dependencies.priceFetcher??((input,init)=>debotSession?debotSession.fetcher(input,init):fetch(input,init))});
  const mergeTokens=(...groups:ScanToken[][])=>[...new Map(groups.flat().map(t=>[`${t.chain}:${t.address}`,t])).values()];
  let priceTargetError:string|undefined;
  let subscribedPriceKeys=new Set<string>();
  const streamPriceTokens=()=>{
    const groups:ScanToken[][]=[];let failed:string|undefined;
    try{groups.push(exitShadow?.trackingTokens(180)??[]);}catch{failed='EXIT_PRICE_TARGETS_UNAVAILABLE';}
    try{groups.push(archive?.streamingTokens(new Date(),config.chainStream.maxPools)??[]);}catch{failed='ARCHIVE_PRICE_TARGETS_UNAVAILABLE';}
    priceTargetError=failed;return mergeTokens(...groups).slice(0,200);
  };
  const chainMonitor=config.chainStream.enabled?new ChainMonitor({config:config.chainStream,
    tokens:streamPriceTokens,wallets:(chain,limit)=>walletHistory?.streamWalletTargets(chain,limit)??[],onPrice:price=>{
      if(priceRouter.observeChainSample(price)){
        const route=priceRouter.latest(price);
        if(route.status==='available')recordPrice(price);
        else recordPriceError(price,route.reason??'PRICE_SOURCE_CONFLICT');
      }
    }}):undefined;
  const chainStreamStatus=()=>{try{return {...(chainMonitor?.getStatus()??{enabled:false,running:false,mode:'observation_only',chains:[],recentEvents:[]}),
    walletFast:walletFast?{...walletFast.status(),research:walletFastResearch?.status(),activity:walletActivity?.status()}:{enabled:false}};}
    catch{return {enabled:config.chainStream.enabled,mode:'observation_only',captureError:'CHAIN_STATUS_READ_FAILED',chains:[],recentEvents:[]};}};
  const tracking=archive?new PriceTracker({archive:{
    pendingTokens:(limit,now)=>mergeTokens(exitShadow?.trackingTokens(180,now)??[],
      archive.trackingTokens(20,now,t=>!!chainMonitor?.covers(t))).slice(0,limit??200),
    recordPrice,recordPriceError},client,router:priceRouter,priorityTokens:now=>exitShadow?.trackingTokens(20,now)??[],
    intervalMs:config.dashboard.sampleIntervalSec*1000,maxTokensPerCycle:30}):undefined;
  const balances=config.dashboard.enabled?new DashboardBalances(config):undefined;
  const system=config.dashboard.enabled?new SystemMonitor(dirname(config.ordersDatabase)):undefined;
  orders.recover();
  const entry=new EntryController(config,orders,client,{...(walletScreening?{walletEvidence:(report:Report,now:Date)=>walletScreening.revalidate(report,now)}:{}),
    onDecision:(report,result,at)=>{try{dailyReview?.recordEntry(report,result,config.entryMode,at);entryAuditError=undefined;}catch{entryAuditError='ENTRY_AUDIT_WRITE_FAILED';}}});
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
  if(config.walletFast?.enabled&&config.chainStream.enabled&&walletHistory){
    const fastTargets=new WalletFastTargets();
    const activityPath=config.walletFast.database??resolve(dirname(config.walletResearch.database),'wallet-activity.sqlite');
    if([...protectedPaths,config.database].some(path=>path&&sameDatabase(path,activityPath)))throw new Error('WALLET_ACTIVITY_DATABASE_MUST_BE_SEPARATE');
    walletActivity=new WalletActivityStore(activityPath,config.walletFast.maxBytes);walletVerifier=new WalletActivityVerifier(config.chainStream.endpoints);
    walletFastResearch=new WalletFastResearch({
      ready:()=>!closed&&active<2&&!!config.gmgnApiKey?.trim()&&client.cooldownUntil<=Date.now()&&!scanner.getStatus().inFlight,
      verify:event=>walletVerifier!.verify(event),onClassification:result=>walletActivity!.record(result),
      onTrades:trades=>walletHistory.recordTrades(trades),onSignal});
    walletFast=new WalletFastRunner({endpoints:config.chainStream.endpoints,maxWallets:config.chainStream.maxWallets,
      onEvent:event=>walletFastResearch?.enqueue(event),snapshot:()=>{
        const now=Date.now(),targets:FastWalletTarget[]=[],tokens:FastTokenCheck[]=[];
        for(const chain of ['bsc','solana','robinhood'] as const){
          if(!config.chainStream.endpoints[chain])continue;
          const addresses=new Set<string>();
          // Reserve room for multiple research cohorts rather than only the largest reported profits.
          for(const p of walletProfiles?.reader.streamTargets(chain,config.chainStream.maxWallets)??[])addresses.add(p.address);
          for(const address of walletHistory.streamWalletTargets(chain,config.chainStream.maxWallets))addresses.add(address);
          const selected=fastTargets.select(chain,[...addresses],config.chainStream.maxWallets,now),
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
      return {enabled:config.walletResearch.enabled,store:walletStats,seedsError:walletSeedsError,statsComputedAt:new Date(walletStatsAt).toISOString(),observer:walletObserver?.getStatus(),profiles:walletProfilesStatus(),screening:walletScreening?.status(),
        localIndex:{inFlight:!!walletIndexWork,...walletIndexTimings},captureError:walletCaptureError??walletIndexError??associationIndexError,
        settings:{intervalSec:config.walletResearch.intervalSec,maxRequestsPerCycle:config.walletResearch.maxRequestsPerCycle,
          maxBytes:config.walletResearch.maxBytes,retention:'persistent_no_expiry',scope:'vendor_pages_and_observed_wallet_snapshots'}};
    };
  const protectionSummary=()=>{
    if(!exitShadow)return {enabled:false,mode:'shadow',liveReady:false};
    try {return {...exitShadow.summary(),captureError:exitCaptureError};}
    catch {return {enabled:true,mode:'shadow',liveReady:false,captureError:'EXIT_SHADOW_READ_FAILED'};}
  };
  let exitMaintenanceTimer:ReturnType<typeof setInterval>|undefined;
  const maintainProtection=()=>{
    try{exitShadow?.tick();}catch{exitCaptureError='EXIT_SHADOW_MAINTENANCE_FAILED';}
    try{
      const targets=streamPriceTokens();
      // A transient archive failure must not discard existing current-price subscriptions.
      if(!priceTargetError){subscribedPriceKeys=new Set(targets.map(t=>`${t.chain}:${t.address}`));aveScanner?.setPriceTokens(targets);}
    }catch{priceTargetError='PRICE_STREAM_TARGET_REFRESH_FAILED';}
  };
  return {client,providers,store,orders,entry,dailyReview,scanner,debotScanner,debotStream,debotAuth,archive,tracking,priceRouter,walletHistory,walletObserver,walletResearchStatus,walletProfiles,walletProfilesStatus,walletScreening,watchRechecker,exitShadow,chainMonitor,chainStreamStatus,memeObserver,sourceEvidence,aveScanner,aveSession,tokenRankResearch,
    dashboardHome:()=>{
      const host=system?.get();
      return {now:new Date().toISOString(),entryMode:config.entryMode,stats:archive?.overviewStats(),
        status:{scannerRunning:scanner.getStatus().running,debotState:debotStream?.getStatus().state??'disabled',
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
    dashboardOverview:()=>({entryAuditError,now:new Date().toISOString(),entryMode:config.entryMode,scanner:scanner.getStatus(),
      debotScanner:debotScanner?.getStatus()??{enabled:false,running:false},
      debotStream:debotStream?.getStatus(),
      meme:memeObserver?{...memeObserver.status(),captureError:memeCaptureError}:{enabled:false},
      ave:aveScanner?{...aveScanner.getStatus(),nominationCaptureError,session:aveSession?.getStatus()??{status:'required',authenticated:false,reason:'AVE_LOGIN_EMAIL_NOT_CONFIGURED'}}:{enabled:false},
      tokenRankResearch:tokenRankResearch?.status()??{enabled:false},
      corroboration:sourceEvidence?{...sourceEvidence.status(),captureError:sourceCaptureError}:{enabled:false},
      tracking:tracking?.getStatus(),priceRouter:{...priceRouter.getStatus(),captureError:priceTargetError},stats:archive?.stats(),archiveError:archiveCaptureError??store.observationError??archiveMaintenanceError,
      settings:dashboardSettings(config),balances:balances?.get()??[],system:system?.get(),walletResearch:walletResearchStatus(),exitProtection:protectionSummary(),chainStream:chainStreamStatus(),
      watchRecheck:watchRechecker?{enabled:true,...watchRechecker.getStatus()}:{enabled:false}}),
    dashboardOrders:(options:DashboardPageOptions={limit:20,offset:0})=>dashboardOrders(orders,options),
    start(){
      if(closed) return;
      try{exitShadow?.migrateActiveToV3();}catch{exitCaptureError='EXIT_SHADOW_MIGRATION_FAILED';}
      maintainProtection();
      if(!exitMaintenanceTimer){exitMaintenanceTimer=setInterval(maintainProtection,15_000);exitMaintenanceTimer.unref();}
      if(memeObserver){
        for(const observation of debotScanner?.observationSeeds()??[])observeSignal(observation.signal,observation.observedAt,observation,false);
        memeObserver.start();
      }
      walletFastResearch?.start();walletFast?.start();
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
      if(closed) return;closed=true;scanner.stop();clearInterval(sweep);clearInterval(reconcileTimer);clearInterval(walletIndexTimer);clearInterval(debotSyncTimer);clearInterval(exitMaintenanceTimer);
      priceRouter.close();
      await walletFast?.stop();walletVerifier?.stop();await walletFastResearch?.stop();walletActivity?.close();
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
      store.close();orders.close();dailyReview?.close();archive?.close();walletHistory?.close();exitShadow?.close();
    }};
}
