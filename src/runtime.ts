import {isPersistentOrderPath,type Config} from './config.js';
import type {Signal} from './types.js';
import {Store} from './store.js';
import {OrderStore} from './orders.js';
import {EntryController} from './entry.js';
import {GmgnClient} from './providers/gmgn-client.js';
import {GmgnScanner} from './scanner.js';
import {OrderReconciler} from './reconcile.js';
import {evaluate,liveProviders} from './engine.js';
import {ScanArchive} from './scan-archive.js';
import {PriceTracker} from './price-tracker.js';
import {DashboardBalances,dashboardOrders,dashboardSettings} from './dashboard-data.js';
import {WalletHistory} from './wallet-history.js';
import {WalletObserver} from './wallet-observer.js';
import {SystemMonitor} from './system-monitor.js';
import {dirname} from 'node:path';

export function createRuntime(config:Config) {
  if(!isPersistentOrderPath(config.ordersDatabase)) throw new Error('PERSISTENT_ORDER_DATABASE_REQUIRED');
  if(config.gmgnApiKey?.trim()==='gmgn_solbscbaseethmonadtron') throw new Error('GMGN_DEMO_KEY_TEST_ONLY');
  const client=new GmgnClient({apiKey:config.gmgnApiKey,minIntervalMs:config.gmgnMinIntervalMs});
  const providers=liveProviders(config,client);
  const archive=config.dashboard.enabled?new ScanArchive(config.dashboard.archivePath,{
    retentionDays:config.dashboard.retentionDays,trackingHours:config.dashboard.trackingHours}):undefined;
  const walletHistory=config.walletResearch.enabled?new WalletHistory(config.walletResearch.database,{maxBytes:config.walletResearch.maxBytes}):undefined;
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
  const tracking=archive?new PriceTracker({archive,client,intervalMs:config.dashboard.sampleIntervalSec*1000,maxTokensPerCycle:3}):undefined;
  const balances=config.dashboard.enabled?new DashboardBalances(config):undefined;
  const system=config.dashboard.enabled?new SystemMonitor(dirname(config.ordersDatabase)):undefined;
  orders.recover();
  const entry=new EntryController(config,orders,client);
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
  const sweep=setInterval(()=>{
    store.prune(config.researchCacheTtlSec,config.researchCacheMax);orders.recover();
    try {archive?.prune();archiveMaintenanceError=undefined;}
    catch {archiveMaintenanceError='SCAN_ARCHIVE_MAINTENANCE_FAILED';}
  },60000);sweep.unref();
  let reconcileTimer:ReturnType<typeof setInterval>|undefined;
  let walletIndexTimer:ReturnType<typeof setInterval>|undefined;
  const walletResearchStatus=()=>{
      let stats:unknown;
      try {stats=walletHistory?.stats();}catch {stats={error:'WALLET_HISTORY_READ_FAILED'};}
      return {enabled:config.walletResearch.enabled,store:stats,observer:walletObserver?.getStatus(),captureError:walletCaptureError??walletIndexError??associationIndexError,
        settings:{intervalSec:config.walletResearch.intervalSec,maxRequestsPerCycle:config.walletResearch.maxRequestsPerCycle,
          maxBytes:config.walletResearch.maxBytes,retention:'persistent_no_expiry',scope:'vendor_pages_and_observed_wallet_snapshots'}};
    };
  return {client,providers,store,orders,entry,scanner,archive,tracking,walletHistory,walletObserver,walletResearchStatus,
    dashboardOverview:()=>({now:new Date().toISOString(),entryMode:config.entryMode,scanner:scanner.getStatus(),
      tracking:tracking?.getStatus(),stats:archive?.stats(),archiveError:archiveCaptureError??store.observationError??archiveMaintenanceError,
      settings:dashboardSettings(config),balances:balances?.get()??[],system:system?.get(),walletResearch:walletResearchStatus()}),
    dashboardOrders:()=>dashboardOrders(orders),
    start(){
      if(closed) return;
      tracking?.start();balances?.start();system?.start();
      if(walletHistory&&!walletIndexTimer) {
        // Local evidence refresh is independent of the slow vendor request budget.
        // Bound each batch so a growing feed does not stall signal processing.
        try {walletHistory.refreshAssociations(3);associationIndexError=undefined;}
        catch {associationIndexError='WALLET_ASSOCIATION_REFRESH_FAILED';}
        walletIndexTimer=setInterval(()=>{
          try {walletHistory.refreshCoordination(10);walletIndexError=undefined;}
          catch {walletIndexError='WALLET_COORDINATION_REFRESH_FAILED';}
          try {walletHistory.refreshAssociations(3);associationIndexError=undefined;}
          catch {associationIndexError='WALLET_ASSOCIATION_REFRESH_FAILED';}
        },10000);walletIndexTimer.unref();
      }
      if(config.gmgnApiKey?.trim())walletObserver?.start();
      if(config.scannerEnabled&&config.gmgnApiKey?.trim()) scanner.start();
      if(!reconcileTimer&&config.gmgnApiKey?.trim()&&config.gmgnPrivateKey?.trim()) {
        void reconciler.runOnce();
        reconcileTimer=setInterval(()=>{void reconciler.runOnce();},30000);reconcileTimer.unref();
      }
    },
    async close(){
      if(closed) return;closed=true;scanner.stop();clearInterval(sweep);clearInterval(reconcileTimer);clearInterval(walletIndexTimer);
      await Promise.all([tracking?.stop(),balances?.stop(),walletObserver?.stop(),system?.stop()]);
      await reconciler.stop();
      // Stop means no new work. Await current callback before closing its stores.
      while(active) await new Promise(resolve=>setTimeout(resolve,50));
      store.close();orders.close();archive?.close();walletHistory?.close();
    }};
}
