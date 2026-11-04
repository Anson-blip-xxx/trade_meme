import {performance} from 'node:perf_hooks';
import bs58 from 'bs58';
import {GmgnError,type GmgnRequestPriority} from './providers/gmgn-client.js';
import {parseSignal,type Signal} from './types.js';

export type GmgnMarketChain='sol'|'bsc'|'robinhood';
export type GmgnMarketSignalRoute='priority_analysis'|'narrative_analysis'|'conditional_analysis'|'negative_analysis'|'observation_only'|'unknown_research';
type Obj=Record<string,unknown>;
const object=(value:unknown):value is Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const API_TO_CHAIN:Record<GmgnMarketChain,Signal['token']['chain']>={sol:'solana',bsc:'bsc',robinhood:'robinhood'};
const SIGNAL_NAMES:Record<number,string>={1:'price_signal',2:'dex_ad',3:'dex_social_update',4:'dex_trending',5:'dex_boost',
  6:'price_spike',7:'ath',8:'market_cap_level',9:'live_stream',10:'bundler_sell',11:'cto',12:'smart_degen_buy',
  13:'platform_call',17:'claim',18:'claim',19:'platform_call',20:'kol_buy',21:'claim'};
const SEEN_TTL_MS=6*60*60*1000,MAX_SEEN=50_000,MAX_LATENCY_SAMPLES=256,MAX_RETRIES=8,
  MAX_ARCHIVE_RETRIES=3,MAX_ARCHIVE_QUEUE=8,RECENT_REPLAY_MS=30_000,
  LIVE_TIMESTAMP_TOLERANCE_MS=2_000,BASELINE_LIFETIME_LIMIT=4,OLD_REPLAY_LIFETIME_LIMIT=4,LATE_BACKFILL_CYCLE_LIMIT=4;
export type GmgnMarketArchiveTerminalReason='GMGN_MARKET_ARCHIVE_TERMINAL_CAPACITY'|
  'GMGN_MARKET_ARCHIVE_TERMINAL_SCHEMA'|'GMGN_MARKET_ARCHIVE_TERMINAL_PARTIAL_REJECTION';
export class GmgnMarketArchiveError extends Error {
  constructor(readonly reason:GmgnMarketArchiveTerminalReason){super(reason);this.name='GmgnMarketArchiveError';}
}

export interface GmgnMarketSignalClient {
  readonly cooldownUntil?:number;
  getMemeMarketSignals(chain:GmgnMarketChain,scheduling?:{priority?:GmgnRequestPriority;queueTimeoutMs?:number}):Promise<unknown>;
}
export interface GmgnMarketSignalObservation {id:string;chain:GmgnMarketChain;signalType:number;route:GmgnMarketSignalRoute;
  analysisEligible:boolean;name?:string;symbol?:string;raw:unknown;signal:Signal;}
export interface GmgnMarketSignalCycle {
  startedAt:string;responseAt?:string;completedAt:string;chain:GmgnMarketChain;status:'ok'|'cooldown'|'unavailable'|'stopped';
  received:number;accepted:number;rejected:number;stale:number;duplicates:number;newEvents:number;queued:number;queueDropped:number;
  liveNewEvents:number;backlogEvents:number;baselineEvents:number;lateBackfillEvents:number;replayCandidates:number;replayed:number;
  deferredBacklog:number;analysisSuppressed:number;
  routes:Record<GmgnMarketSignalRoute,number>;
  requestMs?:number;responseToObservationMs?:number;liveNewResponseToObservationMs?:number;newestSignalAgeMs?:number;reason?:string;
}
export interface LatencySummary {count:number;min?:number;p50?:number;p95?:number;max?:number;}
export interface GmgnMarketSignalScannerOptions {
  client:GmgnMarketSignalClient;chains:GmgnMarketChain[];intervalMs:number;maxAgeSec:number;
  dispatchConcurrency?:number;observationConcurrency?:number;dispatchCapacity?:number;now?:()=>Date;
  /** Raw archive membership. This suppresses only another archive write. */
  knownIds?:(chain:GmgnMarketChain,ids:readonly string[])=>ReadonlySet<string>|Promise<ReadonlySet<string>>;
  /** Durable completion membership. Only this may suppress research delivery. */
  knownProcessedIds?:(chain:GmgnMarketChain,ids:readonly string[])=>ReadonlySet<string>|Promise<ReadonlySet<string>>;
  markProcessed?:(chain:GmgnMarketChain,id:string)=>unknown|Promise<unknown>;
  onObservation?:(signal:Signal,receivedAt:string,observation:GmgnMarketSignalObservation)=>unknown|Promise<unknown>;
  onSignal:(signal:Signal,receivedAt:string)=>unknown|Promise<unknown>;
  onArchive?:(chain:GmgnMarketChain,rows:readonly unknown[])=>unknown|Promise<unknown>;
}

type WorkState='queued'|'active'|'done'|'failed';
type AnalysisState='not_required'|'queued'|'active'|'done'|'skipped_stale'|'failed'|'shutdown_deferred';
type ArrivalClass='live_new'|'baseline_backlog'|'late_backfill'|'replay';
interface MarketWorkItem {
  observation:GmgnMarketSignalObservation;receivedAt:string;receivedAtMs:number;receivedPerf:number;
  cycle:GmgnMarketSignalCycle;arrivalClass:ArrivalClass;observationState:WorkState;analysisState:AnalysisState;finalizing:boolean;
}
interface ArchiveBatch {chain:GmgnMarketChain;rows:readonly unknown[];sourceEventIds:readonly string[];}
interface NormalizedPage {received:number;rejected:number;observations:GmgnMarketSignalObservation[];}

function validAddress(chain:GmgnMarketChain,value:unknown):value is string {
  if(typeof value!=='string')return false;
  if(chain!=='sol')return /^0x[0-9a-f]{40}$/i.test(value)&&!/^0x0+$/i.test(value);
  if(value.length<32||value.length>44)return false;
  try{const bytes=bs58.decode(value);return bytes.length===32&&bytes.some(byte=>byte!==0)&&bs58.encode(bytes)===value;}catch{return false;}
}
function boundedText(value:unknown,max:number):string|undefined {
  if(typeof value!=='string')return;
  const clean=value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  return clean?clean.slice(0,max):undefined;
}
function finite(value:unknown):number|undefined {
  const result=typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value):NaN;
  return Number.isFinite(result)?result:undefined;
}
function sameAddress(chain:GmgnMarketChain,left:string,right:unknown):boolean {
  return typeof right==='string'&&(chain==='sol'?left===right:left.toLowerCase()===right.toLowerCase());
}
function vendorWalletCount(data:Obj,key:'smart_degen_wallets'|'kol_wallets',chain:GmgnMarketChain,triggerAt:number):number {
  const addresses=new Set<string>();
  for(const value of Array.isArray(data[key])?data[key]!.slice(0,100):[]){
    if(!object(value)||!validAddress(chain,value.address))continue;
    const boughtAt=finite(value.buy_timestamp),amount=finite(value.buy_amount);
    if(boughtAt===undefined||amount===undefined||amount<=0||boughtAt<triggerAt-30||boughtAt>triggerAt)continue;
    addresses.add(chain==='sol'?value.address:value.address.toLowerCase());
  }
  return addresses.size;
}
function signalRoute(type:number,signalTimes:number,vendorWallets:number):{route:GmgnMarketSignalRoute;analysisEligible:boolean}{
  // The platform label is only a trigger. Require the documented three
  // distinct, recent vendor wallet references before spending a full pass.
  if(type===12||type===20)return {route:'priority_analysis',analysisEligible:vendorWallets>=3};
  // CTO and platform calls are scarce, high-context meme events. They earn a
  // full research pass, while the vendor label remains an unverified claim.
  if(type===11||type===13||type===19)return {route:'narrative_analysis',analysisEligible:true};
  // A lone price pulse is retained for forward tracking. A repeated pulse
  // earns an independent price, liquidity and safety evaluation.
  if(type===6)return {route:'conditional_analysis',analysisEligible:signalTimes>=2};
  if(type===10)return {route:'negative_analysis',analysisEligible:true};
  // Attention mechanics are useful heat evidence, but a paid DEX placement,
  // social edit, boost, key level or live stream is not independent buy proof.
  if([1,2,3,4,5,7,8,9,17,18,21].includes(type))return {route:'observation_only',analysisEligible:false};
  return {route:'unknown_research',analysisEligible:false};
}

export function normalizeGmgnMarketSignals(input:unknown,chain:GmgnMarketChain):NormalizedPage {
  if(!Array.isArray(input))return {received:0,rejected:1,observations:[]};
  const rows=input.slice(0,1000),observations:GmgnMarketSignalObservation[]=[];let rejected=input.length>rows.length?input.length-rows.length:0;
  for(const raw of rows){
    if(!object(raw)||typeof raw.id!=='string'||!/^[A-Za-z0-9-]{8,100}$/.test(raw.id)||!object(raw.data)||
      raw.data.chain!==chain||!validAddress(chain,raw.token_address)||!sameAddress(chain,raw.token_address,raw.data.address)){rejected++;continue;}
    const signalType=finite(raw.signal_type),triggerAt=finite(raw.trigger_at);
    if(signalType===undefined||!Number.isInteger(signalType)||signalType<1||signalType>99||triggerAt===undefined||
      !Number.isSafeInteger(triggerAt)||triggerAt<1_577_836_800||triggerAt>8_640_000_000){rejected++;continue;}
    const symbol=boundedText(raw.data.symbol,100),name=boundedText(raw.data.name,100),marketCap=finite(raw.trigger_mc);
    const smartCount=signalType===12?vendorWalletCount(raw.data,'smart_degen_wallets',chain,triggerAt):0;
    const kolCount=signalType===20?vendorWalletCount(raw.data,'kol_wallets',chain,triggerAt):0;
    const signalTimes=Math.max(0,Math.floor(finite(raw.signal_times)??0)),routing=signalRoute(signalType,signalTimes,smartCount+kolCount);
    const label=SIGNAL_NAMES[signalType!]??'market_event',parts=[`GMGN 市场信号 ${label} (${signalType})`,
      ...(name||symbol?[`代币 ${name??symbol}${name&&symbol&&name!==symbol?` / ${symbol}`:''}`]:[]),
      `CA ${raw.token_address}`,...(marketCap!==undefined&&marketCap>=0?[`触发市值 ${marketCap}`]:[]),
      ...(smartCount?[`GMGN 标记聪明钱包引用 ${smartCount}`]:[]),...(kolCount?[`GMGN 标记 KOL 钱包引用 ${kolCount}`]:[])];
    try{
      const signal=parseSignal({source:'gmgn',sourceEventId:`gmgn:market:${chain}:${raw.id}`,
        occurredAt:new Date(triggerAt*1000).toISOString(),token:{chain:API_TO_CHAIN[chain],address:raw.token_address},
        text:parts.join('；'),evidenceUrls:[],claim:'unspecified'});
      observations.push({id:raw.id,chain,signalType,route:routing.route,analysisEligible:routing.analysisEligible,
        ...(name?{name}:{}),...(symbol?{symbol}:{}),raw,signal});
    }catch{rejected++;}
  }
  return {received:input.length,rejected,observations};
}

function summary(values:readonly number[]):LatencySummary {
  if(!values.length)return {count:0};
  const sorted=[...values].sort((a,b)=>a-b),at=(q:number)=>sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*q))];
  return {count:sorted.length,min:Math.round(sorted[0]),p50:Math.round(at(.5)),p95:Math.round(at(.95)),max:Math.round(sorted.at(-1)!)};
}

/**
 * Low-latency, read-only GMGN Market Signal polling. It records observations
 * immediately, then evaluates them on a bounded queue. Archive work is a
 * separate queue and can never delay the observation or evaluation handoff.
 */
export class GmgnMarketSignalScanner {
  private readonly now:()=>Date;private readonly chains:GmgnMarketChain[];private readonly intervalMs:number;private readonly maxAgeMs:number;
  private readonly analysisConcurrency:number;private readonly observationConcurrency:number;private readonly dispatchCapacity:number;
  private running=false;private generation=0;private cursor=0;private timer?:ReturnType<typeof setTimeout>;
  private inFlight?:Promise<GmgnMarketSignalCycle>;private activeObservation=0;private activeAnalysis=0;private archiveActive=false;
  private stopping=false;
  private readonly seen=new Map<string,number>();private readonly queuedIds=new Set<string>();
  private readonly previousSuccessfulPollStartedAt=new Map<GmgnMarketChain,number>();
  private readonly baselineAdmitted=new Map<GmgnMarketChain,number>();
  private readonly oldReplayAdmitted=new Map<GmgnMarketChain,number>();
  private readonly workItems=new Set<MarketWorkItem>();private readonly observationQueue:MarketWorkItem[]=[];
  private readonly analysisQueue:MarketWorkItem[]=[];private readonly archiveQueue:ArchiveBatch[]=[];
  private readonly pending=new Set<Promise<unknown>>();
  private lastCycle?:GmgnMarketSignalCycle;private lastError?:string;private errorVersion=0;private totals={polls:0,received:0,accepted:0,rejected:0,stale:0,
    duplicates:0,newEvents:0,queued:0,queueDropped:0,completed:0,processed:0,callbackErrors:0,observationErrors:0,
    checkpointErrors:0,workFailures:0,archiveErrors:0,archiveRejected:0,observationQueued:0,observationCompleted:0,
    analysisSkippedStale:0,shutdownDeferred:0,replayCandidates:0,replayed:0,liveNewEvents:0,backlogEvents:0,
    baselineEvents:0,lateBackfillEvents:0,deferredBacklog:0,analysisSuppressed:0};
  private archiveDisabledReason?:GmgnMarketArchiveTerminalReason;
  private readonly routeTotals:Record<GmgnMarketSignalRoute,number>={priority_analysis:0,narrative_analysis:0,conditional_analysis:0,negative_analysis:0,
    observation_only:0,unknown_research:0};
  private readonly latency={request:[] as number[],liveNewSourceToReceive:[] as number[],allSourceToReceive:[] as number[],
    backlogSourceToReceive:[] as number[],replaySourceToReceive:[] as number[],liveNewReceiveToObservation:[] as number[],
    allReceiveToObservation:[] as number[],backlogReceiveToObservation:[] as number[],replayReceiveToObservation:[] as number[],
    queueWait:[] as number[],observationQueueWait:[] as number[],analysisQueueWait:[] as number[],analysis:[] as number[],sourceToComplete:[] as number[]};

  constructor(private readonly options:GmgnMarketSignalScannerOptions){
    const chains=[...new Set(options.chains)],analysisConcurrency=options.dispatchConcurrency??4,capacity=options.dispatchCapacity??256,
      observationConcurrency=options.observationConcurrency??Math.min(16,capacity);
    if(!chains.length||chains.some(chain=>!['sol','bsc','robinhood'].includes(chain))||!Number.isSafeInteger(options.intervalMs)||
      options.intervalMs<1000||options.intervalMs>5000||!Number.isSafeInteger(options.maxAgeSec)||options.maxAgeSec<10||options.maxAgeSec>86400||
      !Number.isSafeInteger(analysisConcurrency)||analysisConcurrency<1||analysisConcurrency>8||
      !Number.isSafeInteger(observationConcurrency)||observationConcurrency<1||observationConcurrency>32||
      !Number.isSafeInteger(capacity)||capacity<Math.max(analysisConcurrency,observationConcurrency)||capacity>2000)
      throw new Error('GMGN_MARKET_SIGNAL_SCANNER_CONFIG_INVALID');
    this.now=options.now??(()=>new Date());this.chains=chains;this.intervalMs=options.intervalMs;this.maxAgeMs=options.maxAgeSec*1000;
    this.analysisConcurrency=analysisConcurrency;this.observationConcurrency=observationConcurrency;this.dispatchCapacity=capacity;
  }

  status(){this.pruneSeen();return {enabled:true,running:this.running,inFlight:!!this.inFlight,intervalMs:this.intervalMs,
    chains:[...this.chains],priority:'signal_poll' as const,entryPipeline:false,countingPipeline:false,
    dispatchConcurrency:this.analysisConcurrency,analysisConcurrency:this.analysisConcurrency,observationConcurrency:this.observationConcurrency,
    dispatchCapacity:this.dispatchCapacity,admittedWork:this.workItems.size,
    queueDepth:this.analysisQueue.length,activeDispatch:this.activeAnalysis,
    observationQueueDepth:this.observationQueue.length,activeObservation:this.activeObservation,
    analysisQueueDepth:this.analysisQueue.length,activeAnalysis:this.activeAnalysis,archiveQueueDepth:this.archiveQueue.length,
    archiveState:this.archiveDisabledReason?'degraded' as const:'active' as const,archiveDisabledReason:this.archiveDisabledReason,
    seenEntries:this.seen.size,lastError:this.lastError,totals:{...this.totals,routes:{...this.routeTotals}},lastCycle:this.lastCycle?structuredClone(this.lastCycle):undefined,
    metricScope:'live_new_only' as const,
    metricDefinitions:{
      liveNewRule:'raw ID was not archived, a successful baseline poll already exists for the chain, and trigger_at is within the previous successful poll window (two-second timestamp tolerance)',
      request:'successful poll scheduling wait plus HTTP response time; failed and cooldown cycles are excluded',
      sourceToReceive:'live-new trigger_at to local HTTP response',
      receiveToObservation:'live-new local HTTP response to successful observation callback completion',
      allSourceToReceive:'all age-admitted work, including baseline/backfill and replay',
      allReceiveToObservation:'all successfully observed work, including baseline/backfill and replay',
      completed:'successful full-analysis callbacks only',
      processed:'work reaching the completion fence after observation and analysis done, not required, or explicitly skipped stale; production persists this checkpoint',
      replayCandidates:'raw-archived IDs missing a completion checkpoint and eligible by age',
      replayed:'replay candidates admitted to the bounded work pipeline',
      deferredBacklog:'baseline, old replay or late-backfill rows retained in the raw archive but withheld from this process work pipeline',
      analysisPolicy:'full analysis is limited to live-new rows and replay rows received within 30 seconds of trigger_at'},
    latencyMs:{request:summary(this.latency.request),
      sourceToReceive:summary(this.latency.liveNewSourceToReceive),receiveToObservation:summary(this.latency.liveNewReceiveToObservation),
      liveNewSourceToReceive:summary(this.latency.liveNewSourceToReceive),
      liveNewReceiveToObservation:summary(this.latency.liveNewReceiveToObservation),
      allSourceToReceive:summary(this.latency.allSourceToReceive),allReceiveToObservation:summary(this.latency.allReceiveToObservation),
      backlogSourceToReceive:summary(this.latency.backlogSourceToReceive),replaySourceToReceive:summary(this.latency.replaySourceToReceive),
      backlogReceiveToObservation:summary(this.latency.backlogReceiveToObservation),
      replayReceiveToObservation:summary(this.latency.replayReceiveToObservation),
      queueWait:summary(this.latency.queueWait),observationQueueWait:summary(this.latency.observationQueueWait),
      analysisQueueWait:summary(this.latency.analysisQueueWait),analysis:summary(this.latency.analysis),sourceToComplete:summary(this.latency.sourceToComplete)}};}
  start(){if(this.running)return;this.stopping=false;this.running=true;this.generation++;this.schedule(0,this.generation);}
  async stop(){
    this.stopping=true;this.running=false;this.generation++;clearTimeout(this.timer);this.timer=undefined;
    // Do not make service shutdown proportional to a slow research backlog.
    // Work which has not entered the analysis lane remains deliberately
    // uncheckpointed, so raw-archive + missing-processing state replays it on
    // the next process. The fast observation lane is still drained.
    this.deferQueuedAnalysis();
    await this.inFlight?.catch(()=>{});
    this.pumpObservation();this.pumpArchive();
    await this.waitForIdle();
  }
  runOnce():Promise<GmgnMarketSignalCycle>{
    if(this.inFlight)return this.inFlight;const run=this.execute(this.generation);this.inFlight=run;
    void run.then(cycle=>{this.lastCycle=cycle;if(this.inFlight===run)this.inFlight=undefined;},()=>{if(this.inFlight===run)this.inFlight=undefined;});return run;
  }
  async waitForIdle(){while(this.observationQueue.length||this.activeObservation||this.analysisQueue.length||this.activeAnalysis||
    this.workItems.size||this.archiveQueue.length||this.archiveActive||this.pending.size)
    await Promise.allSettled([...this.pending,new Promise(resolve=>setTimeout(resolve,5))]);}

  private schedule(delay:number,generation:number){if(!this.running||generation!==this.generation)return;this.timer=setTimeout(()=>{
    this.timer=undefined;const started=performance.now();void this.runOnce().catch(()=>{}).finally(()=>{
      if(!this.running||generation!==this.generation)return;
      const cooldown=Math.max(0,(this.options.client.cooldownUntil??0)-this.now().getTime());
      this.schedule(Math.max(cooldown,this.intervalMs-(performance.now()-started)),generation);
    });},Math.max(0,delay));this.timer.unref();}
  private pruneSeen(){const now=this.now().getTime();for(const [id,expiry] of this.seen)if(expiry<=now)this.seen.delete(id);
    while(this.seen.size>MAX_SEEN)this.seen.delete(this.seen.keys().next().value!);}
  private sample(bucket:number[],value:number){if(!Number.isFinite(value)||value<0)return;bucket.push(value);if(bucket.length>MAX_LATENCY_SAMPLES)bucket.shift();}
  private reason(error:unknown){return error instanceof GmgnError?error.reason:'GMGN_MARKET_SIGNAL_REQUEST_FAILED';}
  private setError(reason:string){this.lastError=reason;this.errorVersion++;}

  private async execute(generation:number):Promise<GmgnMarketSignalCycle>{
    const started=this.now(),startedPerf=performance.now(),chain=this.chains[this.cursor++%this.chains.length];
    const cycle:GmgnMarketSignalCycle={startedAt:started.toISOString(),completedAt:started.toISOString(),chain,status:'ok',received:0,
      accepted:0,rejected:0,stale:0,duplicates:0,newEvents:0,queued:0,queueDropped:0,
      liveNewEvents:0,backlogEvents:0,baselineEvents:0,lateBackfillEvents:0,replayCandidates:0,replayed:0,
      deferredBacklog:0,analysisSuppressed:0,
      routes:{priority_analysis:0,narrative_analysis:0,conditional_analysis:0,negative_analysis:0,observation_only:0,unknown_research:0}};this.totals.polls++;
    if(this.stopping){cycle.status='stopped';cycle.completedAt=this.now().toISOString();return cycle;}
    const cooldown=this.options.client.cooldownUntil??0;
    if(cooldown>started.getTime()){cycle.status='cooldown';cycle.reason='GMGN_RATE_LIMITED';cycle.completedAt=this.now().toISOString();return cycle;}
    const errorVersion=this.errorVersion;
    try{
      // Polling has its own lane: it may pass queued research reads, while
      // live-entry requests still preempt it. A single already-running GMGN
      // read may use the full 12-second network budget, so the queue fence is
      // long enough to survive that request without dropping the signal page.
      const queueTimeoutMs=15_000;
      const payload=await this.options.client.getMemeMarketSignals(chain,{priority:'signal_poll',queueTimeoutMs});
      if(generation!==this.generation){cycle.status='stopped';cycle.completedAt=this.now().toISOString();return cycle;}
      const received=this.now(),receivedPerf=performance.now(),page=normalizeGmgnMarketSignals(payload,chain);
      const previousPollStartedAt=this.previousSuccessfulPollStartedAt.get(chain);
      this.previousSuccessfulPollStartedAt.set(chain,started.getTime());
      cycle.responseAt=received.toISOString();cycle.requestMs=Math.round(receivedPerf-startedPerf);this.sample(this.latency.request,receivedPerf-startedPerf);
      cycle.received=page.received;cycle.accepted=page.observations.length;cycle.rejected=page.rejected;this.totals.received+=cycle.received;
      this.totals.accepted+=cycle.accepted;this.totals.rejected+=cycle.rejected;this.pruneSeen();
      const pageIds=new Set<string>(),unique=page.observations.filter(item=>{
        if(pageIds.has(item.signal.sourceEventId))return false;pageIds.add(item.signal.sourceEventId);return true;});
      const unseen=unique.filter(item=>!this.seen.has(item.signal.sourceEventId)),ids=unseen.map(item=>item.id);
      let archived:ReadonlySet<string>=new Set(),processed:ReadonlySet<string>=new Set();
      if(ids.length){
        const [rawResult,processedResult]=await Promise.allSettled([
          this.options.knownIds?.(chain,ids)??new Set<string>(),
          this.options.knownProcessedIds?.(chain,ids)??new Set<string>()]);
        if(rawResult.status==='fulfilled')archived=rawResult.value;
        else this.setError('GMGN_MARKET_SIGNAL_ARCHIVE_DEDUP_UNAVAILABLE');
        if(processedResult.status==='fulfilled')processed=processedResult.value;
        else this.setError('GMGN_MARKET_SIGNAL_PROCESSING_DEDUP_UNAVAILABLE');
      }
      if(generation!==this.generation){cycle.status='stopped';cycle.completedAt=this.now().toISOString();return cycle;}
      // A raw row is not proof that observation and analysis completed. Raw
      // membership controls archive writes only; the durable processing
      // checkpoint is the sole research replay fence.
      const unarchived=unseen.filter(item=>!archived.has(item.id));
      const fresh=unseen.filter(item=>!processed.has(item.id));
      cycle.duplicates=page.observations.length-unarchived.length;cycle.newEvents=unarchived.length;
      this.totals.duplicates+=cycle.duplicates;this.totals.newEvents+=cycle.newEvents;
      for(const item of unseen.filter(item=>processed.has(item.id)))this.markSeen(item,received.getTime());
      const arrivals=new Map<string,ArrivalClass>();
      const admitted=fresh.filter(item=>{
        const occurredAt=Date.parse(item.signal.occurredAt),age=received.getTime()-occurredAt;
        if(age< -30_000||age>=this.maxAgeMs){cycle.stale++;this.totals.stale++;this.markSeen(item,received.getTime());return false;}
        const arrivalClass:ArrivalClass=archived.has(item.id)?'replay':previousPollStartedAt===undefined?'baseline_backlog':
          occurredAt>=previousPollStartedAt-LIVE_TIMESTAMP_TOLERANCE_MS?'live_new':'late_backfill';
        arrivals.set(item.signal.sourceEventId,arrivalClass);this.sample(this.latency.allSourceToReceive,Math.max(0,age));
        if(arrivalClass==='live_new'){
          cycle.liveNewEvents++;this.totals.liveNewEvents++;this.sample(this.latency.liveNewSourceToReceive,Math.max(0,age));
        }else if(arrivalClass==='replay'){
          cycle.replayCandidates++;this.totals.replayCandidates++;this.sample(this.latency.replaySourceToReceive,Math.max(0,age));
        }else {
          cycle.backlogEvents++;this.totals.backlogEvents++;this.sample(this.latency.backlogSourceToReceive,Math.max(0,age));
          if(arrivalClass==='baseline_backlog'){cycle.baselineEvents++;this.totals.baselineEvents++;}
          else {cycle.lateBackfillEvents++;this.totals.lateBackfillEvents++;}
        }
        return true;
      });
      for(const item of admitted){cycle.routes[item.route]++;this.routeTotals[item.route]++;}
      const routed=admitted.sort((a,b)=>{
        const arrivalRank=(value:GmgnMarketSignalObservation)=>{const arrival=arrivals.get(value.signal.sourceEventId)!;
          return arrival==='live_new'?0:arrival==='replay'&&received.getTime()-Date.parse(value.signal.occurredAt)<=RECENT_REPLAY_MS?1:2;};
        const rank=(value:GmgnMarketSignalRoute)=>value==='priority_analysis'?0:value==='narrative_analysis'?1:
          value==='conditional_analysis'?2:value==='negative_analysis'?3:4;
        return arrivalRank(a)-arrivalRank(b)||Number(b.analysisEligible)-Number(a.analysisEligible)||rank(a.route)-rank(b.route)||
          Date.parse(b.signal.occurredAt)-Date.parse(a.signal.occurredAt);});
      let lateBackfillAdmitted=0;
      for(const observation of routed){
        if(this.queuedIds.has(observation.signal.sourceEventId))continue;
        const arrivalClass=arrivals.get(observation.signal.sourceEventId)!,age=received.getTime()-Date.parse(observation.signal.occurredAt);
        const recentReplay=arrivalClass==='replay'&&age<=RECENT_REPLAY_MS;
        const reserve=Math.min(this.dispatchCapacity,Math.max(4,this.analysisConcurrency*2));
        const backlogCapacity=Math.max(0,this.dispatchCapacity-reserve);
        const backlogAllowed=arrivalClass==='baseline_backlog'?(this.baselineAdmitted.get(chain)??0)<BASELINE_LIFETIME_LIMIT:
          arrivalClass==='replay'&&!recentReplay?(this.oldReplayAdmitted.get(chain)??0)<OLD_REPLAY_LIFETIME_LIMIT:
          arrivalClass==='late_backfill'?lateBackfillAdmitted<LATE_BACKFILL_CYCLE_LIMIT:true;
        const priorityWork=arrivalClass==='live_new'||recentReplay;
        if(!backlogAllowed||!priorityWork&&this.workItems.size>=backlogCapacity){
          this.markSeen(observation,received.getTime());cycle.deferredBacklog++;this.totals.deferredBacklog++;continue;
        }
        if(this.workItems.size>=this.dispatchCapacity){cycle.queueDropped++;this.totals.queueDropped++;continue;}
        this.markSeen(observation,received.getTime());this.queuedIds.add(observation.signal.sourceEventId);
        if(arrivalClass==='baseline_backlog')this.baselineAdmitted.set(chain,(this.baselineAdmitted.get(chain)??0)+1);
        else if(arrivalClass==='replay'&&!recentReplay)this.oldReplayAdmitted.set(chain,(this.oldReplayAdmitted.get(chain)??0)+1);
        else if(arrivalClass==='late_backfill')lateBackfillAdmitted++;
        const shouldAnalyze=observation.analysisEligible&&(arrivalClass==='live_new'||recentReplay);
        if(observation.analysisEligible&&!shouldAnalyze){cycle.analysisSuppressed++;this.totals.analysisSuppressed++;}
        const item:MarketWorkItem={observation,receivedAt:received.toISOString(),receivedAtMs:received.getTime(),receivedPerf,cycle,
          arrivalClass,observationState:'queued',analysisState:shouldAnalyze?'queued':'not_required',finalizing:false};
        this.workItems.add(item);this.observationQueue.push(item);this.totals.observationQueued++;
        if(item.arrivalClass==='replay'){cycle.replayed++;this.totals.replayed++;}
        if(shouldAnalyze){this.analysisQueue.push(item);cycle.queued++;this.totals.queued++;}
      }
      this.pumpObservation();this.pumpAnalysis();
      if(admitted.length)cycle.newestSignalAgeMs=Math.max(0,received.getTime()-Math.max(...admitted.map(item=>Date.parse(item.signal.occurredAt))));
      if(unarchived.length&&this.options.onArchive)this.enqueueArchive(chain,unarchived);
      if(errorVersion===this.errorVersion&&!this.archiveDisabledReason)this.lastError=undefined;
    }catch(error){cycle.status=this.reason(error)==='GMGN_RATE_LIMITED'?'cooldown':'unavailable';cycle.reason=this.reason(error);this.setError(cycle.reason);}
    cycle.completedAt=this.now().toISOString();return cycle;
  }

  private markSeen(item:GmgnMarketSignalObservation,receivedAtMs:number){this.seen.set(item.signal.sourceEventId,
    Math.max(receivedAtMs+SEEN_TTL_MS,Date.parse(item.signal.occurredAt)+SEEN_TTL_MS));}

  private retryLimit(kind:'observation'|'analysis'|'checkpoint'){return kind==='analysis'?MAX_RETRIES:3;}
  private async retry(item:MarketWorkItem,kind:'observation'|'analysis'|'checkpoint',operation:()=>unknown|Promise<unknown>){
    const limit=this.retryLimit(kind);
    for(let attempt=0;attempt<limit;attempt++){
      // The stop fence waits for the analysis attempt which was already in
      // progress, but never starts another remote evaluation during shutdown.
      if(kind==='analysis'&&attempt>0&&this.stopping)return false;
      try{await operation();return true;}catch{
      if(kind==='observation'){this.totals.observationErrors++;this.setError('GMGN_MARKET_SIGNAL_OBSERVATION_FAILED');}
      else if(kind==='analysis'){this.totals.callbackErrors++;this.setError('GMGN_MARKET_SIGNAL_ANALYSIS_FAILED');}
      else {this.totals.checkpointErrors++;this.setError('GMGN_MARKET_SIGNAL_CHECKPOINT_FAILED');}
      if(attempt+1>=limit||(kind==='analysis'&&this.stopping)||
        this.now().getTime()-Date.parse(item.observation.signal.occurredAt)>=this.maxAgeMs)return false;
      await new Promise(resolve=>setTimeout(resolve,Math.min(kind==='analysis'?5000:500,250*2**attempt)));
      }
    }
    return false;
  }

  private pumpObservation(){
    while(this.activeObservation<this.observationConcurrency&&this.observationQueue.length){
      const item=this.observationQueue.shift()!;
      if(item.observationState!=='queued')continue;
      item.observationState='active';this.activeObservation++;
      this.sample(this.latency.observationQueueWait,performance.now()-item.receivedPerf);
      const task=Promise.resolve().then(async()=>{
        const done=!this.options.onObservation||await this.retry(item,'observation',()=>
          this.options.onObservation!(item.observation.signal,item.receivedAt,item.observation));
        item.observationState=done?'done':'failed';
        if(done){
          this.totals.observationCompleted++;
          const elapsed=performance.now()-item.receivedPerf;this.sample(this.latency.allReceiveToObservation,elapsed);
          if(item.arrivalClass==='live_new'){
            this.sample(this.latency.liveNewReceiveToObservation,elapsed);
            item.cycle.liveNewResponseToObservationMs=Math.max(item.cycle.liveNewResponseToObservationMs??0,Math.round(elapsed));
          }else if(item.arrivalClass==='replay')this.sample(this.latency.replayReceiveToObservation,elapsed);
          else this.sample(this.latency.backlogReceiveToObservation,elapsed);
          item.cycle.responseToObservationMs=Math.max(item.cycle.responseToObservationMs??0,Math.round(elapsed));
        }
        await this.finalizeIfReady(item);
      }).finally(()=>{this.activeObservation--;this.pending.delete(task);this.pumpObservation();});
      this.pending.add(task);
    }
  }

  private pumpAnalysis(){
    if(this.stopping){this.deferQueuedAnalysis();return;}
    while(this.activeAnalysis<this.analysisConcurrency&&this.analysisQueue.length){
      const item=this.analysisQueue.shift()!;
      if(item.analysisState!=='queued')continue;
      if(this.now().getTime()-Date.parse(item.observation.signal.occurredAt)>=this.maxAgeMs){
        item.analysisState='skipped_stale';this.totals.analysisSkippedStale++;
        this.trackFinalize(item);continue;
      }
      item.analysisState='active';this.activeAnalysis++;
      const queueWait=performance.now()-item.receivedPerf;
      this.sample(this.latency.queueWait,queueWait);this.sample(this.latency.analysisQueueWait,queueWait);
      const task=Promise.resolve().then(async()=>{
        const started=performance.now(),done=await this.retry(item,'analysis',()=>
          this.options.onSignal(item.observation.signal,item.receivedAt));
        item.analysisState=done?'done':'failed';
        if(done){this.totals.completed++;this.sample(this.latency.analysis,performance.now()-started);}
        await this.finalizeIfReady(item);
      }).finally(()=>{this.activeAnalysis--;this.pending.delete(task);this.pumpAnalysis();});
      this.pending.add(task);
    }
  }

  private trackFinalize(item:MarketWorkItem){
    const task=Promise.resolve().then(()=>this.finalizeIfReady(item)).finally(()=>{this.pending.delete(task);this.pumpAnalysis();});
    this.pending.add(task);
  }

  private deferQueuedAnalysis(){
    while(this.analysisQueue.length){
      const item=this.analysisQueue.shift()!;
      if(item.analysisState!=='queued')continue;
      item.analysisState='shutdown_deferred';this.totals.shutdownDeferred++;this.trackFinalize(item);
    }
  }

  private async finalizeIfReady(item:MarketWorkItem){
    if(item.finalizing||!this.workItems.has(item))return;
    const observationTerminal=item.observationState==='done'||item.observationState==='failed';
    const analysisTerminal=!['queued','active'].includes(item.analysisState);
    if(!observationTerminal||!analysisTerminal)return;
    item.finalizing=true;
    const analysisComplete=['not_required','done','skipped_stale'].includes(item.analysisState);
    let checkpointed=false;
    if(item.observationState==='done'&&analysisComplete){
      checkpointed=!this.options.markProcessed||await this.retry(item,'checkpoint',()=>
        this.options.markProcessed!(item.observation.chain,item.observation.id));
    }
    if(checkpointed){
      this.totals.processed++;
      this.sample(this.latency.sourceToComplete,Math.max(0,this.now().getTime()-Date.parse(item.observation.signal.occurredAt)));
    }else {
      this.totals.workFailures++;this.seen.delete(item.observation.signal.sourceEventId);
    }
    this.queuedIds.delete(item.observation.signal.sourceEventId);this.workItems.delete(item);
  }

  private enqueueArchive(chain:GmgnMarketChain,items:readonly GmgnMarketSignalObservation[]){
    const batch:ArchiveBatch={chain,rows:items.map(item=>item.raw),sourceEventIds:items.map(item=>item.signal.sourceEventId)};
    if(this.archiveDisabledReason){this.totals.archiveRejected+=batch.rows.length;return;}
    if(this.archiveQueue.length>=MAX_ARCHIVE_QUEUE){this.totals.archiveErrors++;this.totals.archiveRejected+=batch.rows.length;
      for(const id of batch.sourceEventIds)this.seen.delete(id);return;}
    this.archiveQueue.push(batch);setImmediate(()=>this.pumpArchive());}
  private pumpArchive(){if(this.archiveActive||!this.archiveQueue.length||!this.options.onArchive)return;this.archiveActive=true;
    const batch=this.archiveQueue.shift()!,task=Promise.resolve().then(async()=>{
      for(let attempt=0;attempt<MAX_ARCHIVE_RETRIES;attempt++)try{await this.options.onArchive!(batch.chain,batch.rows);return;}catch(error){
        this.totals.archiveErrors++;
        if(error instanceof GmgnMarketArchiveError){
          this.archiveDisabledReason=error.reason;this.setError(error.reason);
          this.totals.archiveRejected+=batch.rows.length+this.archiveQueue.reduce((sum,item)=>sum+item.rows.length,0);
          this.archiveQueue.length=0;return;
        }
        this.setError('GMGN_MARKET_SIGNAL_ARCHIVE_FAILED');
        if(attempt+1<MAX_ARCHIVE_RETRIES)await new Promise(resolve=>setTimeout(resolve,Math.min(1000,250*2**attempt)));
      }
      // Raw membership remains absent. Let the next poll retry this batch even
      // if its observation/analysis checkpoint has already completed.
      for(const id of batch.sourceEventIds)this.seen.delete(id);
    }).finally(()=>{this.archiveActive=false;this.pending.delete(task);this.pumpArchive();});this.pending.add(task);}
}
