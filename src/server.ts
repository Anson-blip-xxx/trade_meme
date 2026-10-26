import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {ZodError} from 'zod';
import {readConfig,type Config} from './config.js';
import {parseSignal} from './types.js';
import {Store,type Stored} from './store.js';
import {evaluate,effectiveReport,liveProviders,type Providers} from './engine.js';
import {normalizeNotification,NotificationError} from './notifications.js';
import {runDoctor} from './doctor.js';
import {renderReport} from './report.js';
import {normalizeDebotImport} from './debot-import.js';
import type {OrderStore} from './orders.js';
import type {EntryController} from './entry.js';
import type {GmgnScanner} from './scanner.js';
import {createRuntime} from './runtime.js';
import {buildDashboard} from './dashboard.js';
import {WalletHistoryDetailRunner} from './wallet-history-detail.js';
import {reviewSamplingPath} from './daily-review.js';

function send(res:ServerResponse,status:number,data:unknown) {res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data,null,2));}
function authorized(req:IncomingMessage,token:string):boolean {
  const provided=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${token}`);
  return provided.length===expected.length&&timingSafeEqual(provided,expected);
}
async function body(req:IncomingMessage):Promise<unknown> {
  if(!req.headers['content-type']?.startsWith('application/json')) throw new Error('CONTENT_TYPE');
  const chunks:Buffer[]=[];let size=0;
  for await(const part of req) {size+=part.length;if(size>65536) throw new Error('BODY_TOO_LARGE');chunks.push(part);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const view=(entry:Stored)=>{const {claimId,...visible}=entry;return {...visible,...(entry.report?{report:effectiveReport(entry.report)}:{})};};
export interface ServerExecutionStatus {
  configuredEntryMode:Config['entryMode'];
  configuredThirdSignalMode:Config['thirdSignalExecutionMode'];
  executionEnabled:boolean;
  countingRunning:boolean;
  /** Local configuration readiness, not proof of successful platform protection triggers. */
  executionReady:boolean;
}
export interface ServerServices {
  orders?:OrderStore;entry?:Pick<EntryController,'consider'|'reconcile'>;scanner?:GmgnScanner;
  executionStatus?:()=>ServerExecutionStatus;
}
export function buildServer(config:Config,store:Store,providers:Providers=liveProviders(config),services:ServerServices={}) {
  if(!config.ingestToken||config.ingestToken.length<24) throw new Error('INGEST_TOKEN must be at least 24 characters');
  let active=0;
  const executionStatus=()=>{
    const current=services.executionStatus?.();
    return {configuredEntryMode:current?.configuredEntryMode??config.entryMode,
      configuredThirdSignalMode:current?.configuredThirdSignalMode??config.thirdSignalExecutionMode,
      executionEnabled:current?.executionEnabled===true,countingRunning:current?.countingRunning===true,
      executionReady:current?.executionReady===true,executionStatusAvailable:!!current};
  };
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url??'/', 'http://localhost');
      if(req.method==='GET'&&url.pathname==='/health') {send(res,200,{status:'ok',version:'0.2.0',...executionStatus(),
        unattendedProtectionReady:false});return;}
      if(!authorized(req,config.ingestToken!)) {send(res,401,{error:'UNAUTHORIZED'});return;}
      store.prune(config.researchCacheTtlSec,config.researchCacheMax);
      if(req.method==='GET'&&url.pathname==='/v1/status') {send(res,200,await runDoctor(config));return;}
      if(req.method==='GET'&&url.pathname==='/v1/orders'&&services.orders) {send(res,200,services.orders.list());return;}
      if(req.method==='GET'&&url.pathname==='/v1/exits'&&services.orders) {
        const execution=executionStatus();
        send(res,200,{policy:config.exitPolicy??null,execution:execution.executionEnabled?'live':config.entryMode,
          ...execution,unattendedProtectionReady:false,monitor:'gmgn_server_conditions_local_readback',
          orders:services.orders.list().filter(order=>order.exit).map(order=>({id:order.id,chain:order.chain,tokenAddress:order.tokenAddress,
            openingStatus:order.status,exit:order.exit}))});return;
      }
      const orderMatch=url.pathname.match(/^\/v1\/orders\/([0-9a-f-]{36})(?:\/(reconcile))?$/);
      if(orderMatch&&services.orders) {
        if(req.method==='GET'&&!orderMatch[2]) {const order=services.orders.get(orderMatch[1]);send(res,order?200:404,order??{error:'NOT_FOUND'});return;}
        if(req.method==='POST'&&orderMatch[2]==='reconcile'&&services.entry) {send(res,200,await services.entry.reconcile(orderMatch[1]));return;}
      }
      if(url.pathname==='/v1/scanner'&&req.method==='GET') {send(res,200,{
        ...(services.scanner?.getStatus()??{running:false,configured:false}),
        ...(config.gmgnBackgroundResearchEnabled===false?{enabled:false,pausedReason:'GMGN_BACKGROUND_RESEARCH_DISABLED'}:{})});return;}
      if(url.pathname==='/v1/scanner/run'&&req.method==='POST'&&services.scanner) {
        if(config.gmgnBackgroundResearchEnabled===false){send(res,409,{error:'GMGN_BACKGROUND_RESEARCH_DISABLED'});return;}
        send(res,200,await services.scanner.runOnce());return;
      }
      if(req.method==='GET'&&url.pathname==='/v1/signals') {send(res,200,store.list().map(view));return;}
      const match=url.pathname.match(/^\/v1\/signals\/([0-9a-f-]{36})(?:\/(retry|history|report|imports))?$/);
      if(req.method==='GET'&&match&&!match[2]) {const e=store.get(match[1]);send(res,e?200:404,e?view(e):{error:'NOT_FOUND'});return;}
      if(req.method==='GET'&&match&&['history','report','imports'].includes(match[2])) {
        const e=store.get(match[1]);
        if(!e) {send(res,404,{error:'NOT_FOUND'});return;}
        if(match[2]==='history') send(res,200,store.history(e.id).map(r=>effectiveReport(r)));
        else if(match[2]==='imports') send(res,200,store.imports(e.id));
        else if(!e.report) send(res,409,{error:'REPORT_NOT_READY',status:e.status});
        else {res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end(renderReport(e.report));}
        return;
      }
      if(req.method==='POST'&&(['/v1/signals','/v1/notifications','/v1/debot/stories'].includes(url.pathname)||match?.[2]==='retry')) {
        if(active>=4) {res.setHeader('retry-after','5');send(res,429,{error:'BUSY'});return;}
        let entry:Stored;
        if(match?.[2]==='retry') {
          const previous=store.get(match[1]);
          if(previous&&!config.scannerChains.includes(previous.signal.token.chain)) {
            send(res,409,{error:'SIGNAL_CHAIN_DISABLED',chain:previous.signal.token.chain,allowedChains:config.scannerChains});return;
          }
          const retried=store.retry(match[1]);
          if(!retried) {send(res,409,{error:'NOT_FOUND_OR_PROCESSING'});return;} entry=retried;
        } else {
          const input=await body(req),notification=url.pathname==='/v1/notifications',debot=url.pathname==='/v1/debot/stories';
          const signal=debot?normalizeDebotImport(input):notification?normalizeNotification(input):parseSignal(input);
          if(!config.scannerChains.includes(signal.token.chain)) {
            send(res,409,{error:'SIGNAL_CHAIN_DISABLED',chain:signal.token.chain,allowedChains:config.scannerChains});return;
          }
          if(active>=4) {res.setHeader('retry-after','5');send(res,429,{error:'BUSY'});return;}
          const reserved=store.reserve(signal,notification||debot?input:undefined,debot?'debot_story_response':'notification_copy');
          if(reserved.conflict) {send(res,409,{error:'EVENT_ID_PAYLOAD_CONFLICT',id:reserved.entry.id});return;}
          if(!reserved.created) {send(res,200,{...view(reserved.entry),duplicate:true});return;}
          entry=reserved.entry;
        }
        active++;
        try {
          const report=await evaluate(entry.signal,config,providers,{id:entry.id,receivedAt:entry.receivedAt});
          if(!store.finish(entry.id,report,entry.claimId!)) {send(res,409,{error:'PROCESSING_CLAIM_EXPIRED',id:entry.id});return;}
          const opening=services.entry?await services.entry.consider(report):undefined;
          send(res,201,{id:entry.id,status:'completed',report:effectiveReport(report),...(opening?{opening}:{})});
        } catch {store.interrupt(entry.id,entry.claimId!);send(res,500,{error:'EVALUATION_INTERRUPTED',id:entry.id});}
        finally {active--;}
        return;
      }
      send(res,404,{error:'NOT_FOUND'});
    } catch(e) {
      if(e instanceof ZodError) send(res,400,{error:'INVALID_SIGNAL',issues:e.issues.map(i=>({path:i.path,message:i.message}))});
      else if(e instanceof NotificationError) send(res,400,{error:e.code,message:e.message});
      else if(e instanceof SyntaxError) send(res,400,{error:'INVALID_JSON'});
      else if(e instanceof Error&&e.message==='BODY_TOO_LARGE') send(res,413,{error:'BODY_TOO_LARGE'});
      else if(e instanceof Error&&e.message==='CONTENT_TYPE') send(res,415,{error:'JSON_REQUIRED'});
      else send(res,500,{error:'INTERNAL_ERROR'});
    }
  });
  server.headersTimeout=10000;server.requestTimeout=90000;
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const config=readConfig(),runtime=createRuntime(config);
  const server=buildServer(config,runtime.store,runtime.providers,runtime);
  const walletQueries=config.dashboard.enabled&&runtime.archive?new WalletHistoryDetailRunner({
    database:runtime.walletHistory?config.walletResearch.database:undefined,
    profileDatabase:runtime.walletProfiles?config.walletProfiles.database:undefined,
    scanDatabase:config.dashboard.archivePath,
    tokenRankDatabase:runtime.tokenRankResearch?config.tokenRankResearch?.database:undefined,
    memeDatabase:runtime.memeObserver?config.meme?.database:undefined,memeMaxActive:config.meme?.maxActive,
    memeActiveWindowSec:config.meme?.activeWindowSec,memeAllowedChains:config.scannerChains,
    memeSamplingPlanPath:reviewSamplingPath(config.dashboard.archivePath),
    corroborationDatabase:runtime.sourceEvidence?config.corroboration?.database:undefined}):undefined;
  walletQueries?.start();
  const dashboard=config.dashboard.enabled&&runtime.archive?buildDashboard(config,{
    archive:runtime.archive,home:runtime.dashboardHome,overview:async()=>{
      const value=runtime.dashboardOverview();
      if(!runtime.memeObserver||!walletQueries)return value;
      const current=value as typeof value&{meme:unknown};
      return {...current,meme:await walletQueries.getMemeStatus({now:new Date().toISOString(),status:current.meme})};
    },orders:runtime.dashboardOrders,
    signalCountingPage:runtime.signalCountingPage,signalCountingControl:runtime.signalCountingControl,
    dailyReview:options=>runtime.dailyReview?.page(options),
    jev:runtime.jevShadow?{status:runtime.jevStatus,list:options=>runtime.jevShadow!.list(options),detail:id=>runtime.jevShadow!.detail(id)}:undefined,
    debotAuth:runtime.debotAuth,
    debotSignals:options=>runtime.debotScanner?.list(options)??{now:new Date().toISOString(),items:[],total:0,
      limit:options?.limit??20,offset:options?.offset??0,hasMore:false},
    debotHistory:(chain,address,options)=>runtime.debotScanner?.notificationHistory(chain,address,options),
    aveSignals:options=>runtime.aveScanner?.list(options),
    sourceHistory:(chain,address,options)=>runtime.sourceEvidence?.history({chain,address},options),
    tokenRankResearch:runtime.tokenRankResearch&&walletQueries?async options=>({...await walletQueries.listTokenRank(options),status:runtime.tokenRankResearch!.status()}):undefined,
    tokenRankResearchDetail:runtime.tokenRankResearch&&walletQueries?(chain,address,options)=>walletQueries.getTokenRank(chain,address,options):undefined,
    tokenRankWallets:runtime.tokenRankResearch&&walletQueries?async options=>({...await walletQueries.listTokenRankWallets(options),status:runtime.tokenRankResearch!.status()}):undefined,
    tokenRankWallet:runtime.tokenRankResearch&&walletQueries?(chain,address,options)=>walletQueries.getTokenRankWallet(chain,address,options):undefined,
    memeSignals:runtime.memeObserver&&walletQueries?options=>walletQueries.listMeme(options,
      {now:new Date().toISOString(),status:runtime.memeObserver!.runtimeStatus()}):undefined,
    memeDetail:runtime.memeObserver&&walletQueries?(chain,address,options)=>walletQueries.getMeme(chain,address,options,
      {now:new Date().toISOString()}):undefined,
    scanList:walletQueries?options=>walletQueries.listScans(options):undefined,
    scanDetail:walletQueries?id=>walletQueries.getScan(id):undefined,
    chainStream:runtime.chainStreamStatus,protection:runtime.dashboardProtection,protectionDetail:id=>{
      const detail=runtime.exitShadow?.detail(id);if(!detail)return;
      return {...detail,priceRouter:runtime.priceRouter.getStatus(),item:{...detail.item,priceRoute:runtime.priceRouter.latest(detail.item)}};
    },
    walletHistory:walletQueries?{listWallets:options=>walletQueries.listWallets(options)}:undefined,
    walletDetail:walletQueries?(chain,address)=>walletQueries.getWallet(chain,address):undefined,
    walletResearchStatus:runtime.walletResearchStatus,walletAssociations:walletQueries?{
      listAssociations:options=>walletQueries.listAssociations(options),
      getAssociation:(chain,leader,candidate)=>walletQueries.getAssociation(chain,leader,candidate)}:undefined,
    walletAssociationsStatus:runtime.walletAssociationsStatus,
    walletProfiles:walletQueries&&runtime.walletProfiles?{list:options=>walletQueries.listProfiles(options),
      get:(chain,address)=>walletQueries.getProfile(chain,address)}:undefined,
    walletProfilesStatus:runtime.walletProfilesStatus,walletScreening:runtime.walletScreening?.ledger}):undefined;
  const fatal=()=>{console.error('SERVICE_LISTEN_FAILED');process.exit(1);};
  server.on('error',fatal);dashboard?.on('error',fatal);
  dashboard?.listen(config.dashboard.port,config.dashboard.host,()=>console.log(`Dashboard listening at http://${config.dashboard.host}:${config.dashboard.port}/dashboard/`));
  server.listen(config.port,config.host,()=>{runtime.start();console.log(`Signal gate listening at http://${config.host}:${config.port}; entry=${config.entryMode}; compact_scans=${config.dashboard.enabled}`);});
  let stopping=false;
  for(const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>{
    if(stopping)return;stopping=true;
    runtime.scanner.stop();dashboard?.close();
    server.close(()=>{void (async()=>{await walletQueries?.stop();await runtime.close();process.exit(0);})();});
  });
}
