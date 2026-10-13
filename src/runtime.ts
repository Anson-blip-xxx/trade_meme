import {isPersistentOrderPath,type Config} from './config.js';
import type {Signal} from './types.js';
import {Store} from './store.js';
import {OrderStore} from './orders.js';
import {EntryController} from './entry.js';
import {GmgnClient} from './providers/gmgn-client.js';
import {GmgnScanner} from './scanner.js';
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
import {dirname} from 'node:path';

export function createRuntime(config:Config) {
  if(!isPersistentOrderPath(config.ordersDatabase)) throw new Error('PERSISTENT_ORDER_DATABASE_REQUIRED');
  if(config.gmgnApiKey?.trim()==='gmgn_solbscbaseethmonadtron') throw new Error('GMGN_DEMO_KEY_TEST_ONLY');
  const client=new GmgnClient({apiKey:config.gmgnApiKey,minIntervalMs:config.gmgnMinIntervalMs});
  const providers=liveProviders(config,client);
  const archive=config.dashboard.enabled||config.watch.enabled||config.exitShadow.enabled||config.chainStream.enabled?new ScanArchive(config.dashboard.archivePath,{
    retentionDays:config.dashboard.retentionDays,trackingHours:config.dashboard.trackingHours}):undefined;
  if(config.watch.enabled)archive?.configureWatch({windowSec:config.watch.windowSec,intervalSec:config.watch.intervalSec,maxSignalAgeSec:config.maxSignalAgeSec});
  const walletHistory=config.walletResearch.enabled?new WalletHistory(config.walletResearch.database,{maxBytes:config.walletResearch.maxBytes}):undefined;
  const walletProfiles=walletHistory&&config.walletProfiles.enabled?new WalletProfileRunner({
    ...config.walletProfiles,historyDatabase:config.walletResearch.database,
    ...(config.chainStream.enabled?{chainDatabase:config.chainStream.database}:{})}):undefined;
  const walletProfilesStatus=()=>walletProfiles?.status()??{enabled:false,running:false,ready:false};
  const walletScreening=walletHistory&&walletProfiles&&config.walletScreening.enabled?new WalletScreeningService(walletHistory,walletProfiles.reader,
    {...config.walletScreening,sourcePaths:[config.walletResearch.database,config.walletProfiles.database,config.ordersDatabase,config.dashboard.archivePath,
      config.chainStream.database,config.exitShadow.database]}):undefined;
  if(walletScreening)providers.walletScreening=(s,r,now)=>walletScreening.assess(s,r,now);
  const exitShadow=config.exitShadow.enabled?new ExitShadow(config.exitShadow.database,config.exitShadow):undefined;
  const walletObserver=walletHistory?new WalletObserver({history:walletHistory,client,config,chains:config.scannerChains,
    intervalMs:config.walletResearch.intervalSec*1000,maxRequestsPerCycle:config.walletResearch.maxRequestsPerCycle}):undefined;
  let archiveCaptureError:string|undefined,walletCaptureError:string|undefined,walletIndexError:string|undefined,associationIndexError:string|undefined;
  const store=new Store(':memory:',item=>{
    // The two research archives are independent observers; a failed archive must
    // neither suppress the other nor roll back the signal / affect order submission.
    if(archive)try {archive.capture(item);archiveCaptureError=undefined;}catch {archiveCaptureError='SCAN_ARCHIVE_WRITE_FAILED';}
    if(walletHistory&&item.status==='completed'&&item.report)try {
      walletHistory.captureReport(item.report);walletCaptureError=undefined;
    }catch {walletCaptureError='WALLET_HISTORY_WRITE_FAILED';}
  }),orders=new OrderStore(config.ordersDatabase);
  let exitCaptureError:string|undefined;
  const recordPrice=(price:ScanPrice)=>{
      let archiveFailed=false;
      try {archive?.recordPrice(price);}catch {archiveFailed=true;}
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
    tokens:()=>archive?.pendingTokens(200)??[],wallets:(chain,limit)=>walletHistory?.streamWalletTargets(chain,limit)??[],onPrice:recordPrice}):undefined;
  const chainStreamStatus=()=>{try{return chainMonitor?.getStatus()??{enabled:false,running:false,mode:'observation_only',chains:[],recentEvents:[]};}
    catch{return {enabled:config.chainStream.enabled,mode:'observation_only',captureError:'CHAIN_STATUS_READ_FAILED',chains:[],recentEvents:[]};}};
  const tracking=archive?new PriceTracker({archive:{
    pendingTokens:(limit,now)=>archive.pendingTokens(200,now).filter(t=>!chainMonitor?.covers(t)).slice(0,limit??200),
    recordPrice,recordPriceError},client,intervalMs:config.dashboard.sampleIntervalSec*1000,maxTokensPerCycle:3}):undefined;
  const balances=config.dashboard.enabled?new DashboardBalances(config):undefined;
  const system=config.dashboard.enabled?new SystemMonitor(dirname(config.ordersDatabase)):undefined;
  orders.recover();
  const entry=new EntryController(config,orders,client,walletScreening?{walletEvidence:(report,now)=>walletScreening.revalidate(report,now)}:{});
  const reconciler=new OrderReconciler(orders,entry);
  let closed=false,active=0,archiveMaintenanceError:string|undefined;
  const onSignal=async(signal:Signal)=>{
    if(closed||active>=4) throw new Error('RESEARCH_BUSY');
    store.prune(config.researchCacheTtlSec,config.researchCacheMax);
    const reserved=store.reserve(signal);
    if(reserved.conflict) throw new Error('EVENT_ID_PAYLOAD_CONFLICT');
    if(!reserved.created) return;
    const item=reserved.entry;active++;
    try {
      const report=await evaluate(signal,config,providers,{id:item.id,receivedAt:item.receivedAt});
      if(!store.finish(item.id,report,item.claimId!)) throw new Error('PROCESSING_CLAIM_EXPIRED');
      if(!closed) await entry.consider(report);
    } catch(error) {store.interrupt(item.id,item.claimId!);throw error;}
    finally {active--;}
  };
  const scanner=new GmgnScanner({client,chains:config.scannerChains,intervalMs:config.scannerIntervalSec*1000,
    maxAgeSec:config.maxSignalAgeSec,maxSignalsPerCycle:config.scannerMaxSignals,onSignal,
    ...(walletObserver?{onFeed:walletObserver.observeFeed.bind(walletObserver)}:{})});
  const watchRechecker=archive&&config.watch.enabled?new WatchRechecker({archive,
    intervalMs:config.watch.intervalSec*1000,maxPerCycle:config.watch.maxPerCycle,
    shouldDefer:()=>closed?'SERVICE_STOPPING':!config.gmgnApiKey?.trim()?'GMGN_API_KEY_MISSING':
      client.cooldownUntil>Date.now()?'GMGN_RATE_LIMITED':active>=4?'RESEARCH_BUSY':scanner.getStatus().inFlight?'SCANNER_BUSY':undefined,
    evaluate:async(signal,options)=>{
      if(closed||active>=4)throw new Error('RESEARCH_BUSY');
      active++;
      try {
        const report=await evaluate(signal,config,providers,options);
        if(walletHistory)try {walletHistory.captureReport(report);walletCaptureError=undefined;}
        catch {walletCaptureError='WALLET_HISTORY_WRITE_FAILED';}
        return report;
      } finally {active--;}
    },
    entry:async report=>{if(!closed)await entry.consider(report);},
  }):undefined;
  const sweep=setInterval(()=>{
    store.prune(config.researchCacheTtlSec,config.researchCacheMax);orders.recover();
    try {archive?.prune();archiveMaintenanceError=undefined;}
    catch {archiveMaintenanceError='SCAN_ARCHIVE_MAINTENANCE_FAILED';}
  },60000);sweep.unref();
  let reconcileTimer:ReturnType<typeof setInterval>|undefined;
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
  return {client,providers,store,orders,entry,scanner,archive,tracking,walletHistory,walletObserver,walletResearchStatus,walletProfiles,walletProfilesStatus,walletScreening,watchRechecker,exitShadow,chainMonitor,chainStreamStatus,
    dashboardProtection:()=>exitShadow?{...exitShadow.list(),captureError:exitCaptureError}:{...protectionSummary(),items:[]},
    dashboardOverview:()=>({now:new Date().toISOString(),entryMode:config.entryMode,scanner:scanner.getStatus(),
      tracking:tracking?.getStatus(),stats:archive?.stats(),archiveError:archiveCaptureError??store.observationError??archiveMaintenanceError,
      settings:dashboardSettings(config),balances:balances?.get()??[],system:system?.get(),walletResearch:walletResearchStatus(),exitProtection:protectionSummary(),chainStream:chainStreamStatus(),
      watchRecheck:watchRechecker?{enabled:true,...watchRechecker.getStatus()}:{enabled:false}}),
    dashboardOrders:()=>dashboardOrders(orders),
    start(){
      if(closed) return;
      chainMonitor?.start();tracking?.start();balances?.start();system?.start();walletProfiles?.start();walletScreening?.start(async signal=>{
        if(closed||active>=4||!config.gmgnApiKey?.trim()||client.cooldownUntil>Date.now()||scanner.getStatus().inFlight)return false;
        await onSignal(signal);
      });
      if(walletHistory&&!walletIndexTimer) {
        setImmediate(refreshWalletIndexes);
        walletIndexTimer=setInterval(refreshWalletIndexes,10000);walletIndexTimer.unref();
      }
      if(config.gmgnApiKey?.trim())walletObserver?.start();
      if(config.scannerEnabled&&config.gmgnApiKey?.trim()) scanner.start();
      watchRechecker?.start();
      if(!reconcileTimer&&config.gmgnApiKey?.trim()&&config.gmgnPrivateKey?.trim()) {
        void reconciler.runOnce();
        reconcileTimer=setInterval(()=>{void reconciler.runOnce();},30000);reconcileTimer.unref();
      }
    },
    async close(){
      if(closed) return;closed=true;scanner.stop();clearInterval(sweep);clearInterval(reconcileTimer);clearInterval(walletIndexTimer);
      await Promise.all([chainMonitor?.stop(),tracking?.stop(),balances?.stop(),walletObserver?.stop(),system?.stop(),watchRechecker?.stop()]);
      await walletIndexWork;
      await reconciler.stop();
      // Stop means no new work. Await current callback before closing its stores.
      while(active) await new Promise(resolve=>setTimeout(resolve,50));
      await walletScreening?.close();
      await walletProfiles?.stop();
      store.close();orders.close();archive?.close();walletHistory?.close();exitShadow?.close();
    }};
}
