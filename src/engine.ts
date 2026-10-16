import {randomUUID} from 'node:crypto';
import type {Config} from './config.js';
import {unknown,narrativeIdentityConflict,type Signal,type Report,type Provenance,type Check,type Evidence,type NarrativeReport} from './types.js';
import {checkProvenance} from './provenance/index.js';
import {checkSafety} from './providers/safety.js';
import {gatherEvidenceReport,xPostId} from './providers/evidence.js';
import type {EvidenceReport} from './providers/evidence-types.js';
import {analyzeNarrative} from './providers/narrative.js';
import {analyzeVendorNarrative} from './providers/vendor-narrative.js';
import {fetchDebotNarrative} from './providers/debot-client.js';
import {GmgnClient} from './providers/gmgn-client.js';
import {researchProvider,combineSafety,requiredSafetyEvidence,type GmgnResearch,type ResearchContext} from './research.js';
import {assessSocialSignals} from './social-signals.js';
import {qualifiedWalletWithdrawal,type WalletScreeningReport} from './wallet-screening.js';

import {scopedFetcher} from './http.js';
import {assessGmgnSafety,type GmgnTokenSnapshot} from './providers/gmgn-safety.js';
import {assessMarketRisk} from './market-risk.js';

type VendorFetch=Awaited<ReturnType<typeof fetchDebotNarrative>>;

export interface ProviderContext {signal?:AbortSignal;}
export interface EvaluationProgress {
  stage:'safety'|'provenance'|'wallets'|'market'|'narrative';checkedAt:string;elapsedMs:number;
  status:'pass'|'fail'|'unknown';reasons:string[];
}
export interface Providers {
  provenance:(signal:Signal,research?:Pick<GmgnResearch,'snapshot'>,context?:ProviderContext)=>Promise<Provenance>;
  safety:(signal:Signal,context?:ProviderContext)=>Promise<Check>;
  evidence:(signal:Signal,context?:ProviderContext)=>Promise<Evidence[]|EvidenceReport>;
  narrative:(signal:Signal,evidence:Evidence[],now:Date,context?:ProviderContext)=>Promise<NarrativeReport>;
  vendor?:(signal:Signal,context?:ProviderContext)=>Promise<VendorFetch>;
  research?:(signal:Signal,context?:ResearchContext)=>Promise<GmgnResearch>;
  walletScreening?:(signal:Signal,research:GmgnResearch|undefined,now:Date)=>WalletScreeningReport|Promise<WalletScreeningReport>;
}
function prioritizeVendorEvidence(signal:Signal):Signal {
  if(!signal.vendorNarrative) return signal;
  const vendorIds=[...new Set(signal.vendorNarrative.evidenceUrls.map(xPostId).filter((id):id is string=>!!id))];
  // The DeBot adapter supplies at most eight references, leaving four result slots for CA search.
  // Preserve larger explicitly supplied vendor lists rather than silently dropping required citations.
  const limit=Math.max(8,Math.min(vendorIds.length,12));
  const ids=[...new Set([...vendorIds,...signal.evidenceUrls.map(xPostId).filter((id):id is string=>!!id)])].slice(0,limit);
  return {...signal,evidenceUrls:ids.map(id=>`https://x.com/i/web/status/${id}`)};
}
export function liveProviders(config:Config,client=new GmgnClient({apiKey:config.gmgnApiKey,minIntervalMs:config.gmgnMinIntervalMs})):Providers {
  const fetchFor=(context?:ProviderContext)=>scopedFetcher(fetch,context?.signal);
  return {provenance:(s,r,c)=>checkProvenance(s,config,fetchFor(c),r?.snapshot.info),safety:(s,c)=>checkSafety(s,config,fetchFor(c)),
    evidence:(s,c)=>gatherEvidenceReport(prioritizeVendorEvidence(s),config,fetchFor(c)),
    narrative:(s,e,n,c)=>config.narrativeProvider==='vendor'?Promise.resolve(analyzeVendorNarrative(s,e,config,n)):analyzeNarrative(s,e,config,n,fetchFor(c)),
    research:researchProvider(config,client),
    ...(config.narrativeProvider==='vendor'?{vendor:(s:Signal,c?:ProviderContext)=>fetchDebotNarrative(s,fetchFor(c))}:{})};
}

export function decide(signal:Signal,receivedAt:string,config:Config,provenance:Provenance,safety:Check,narrative:NarrativeReport,
  now:Date,mode:'live'|'demo'='live',id:string=randomUUID(),research?:GmgnResearch,walletScreening?:WalletScreeningReport,marketRisk?:Check):Report {
  const reasons:string[]=[];
  const flow=mergeWalletSupport(research?.flow,walletScreening,signal,now);
  const age=now.getTime()-Date.parse(signal.occurredAt);
  if(age< -30_000) reasons.push('SIGNAL_TIME_IN_FUTURE');
  const maxSignalAgeSec=['debot','ave'].includes(signal.source)?Math.min(120,config.maxSignalAgeSec):config.maxSignalAgeSec;
  if(age>=maxSignalAgeSec*1000) reasons.push('SIGNAL_STALE');
  if(provenance.status!=='pass') reasons.push('PLATFORM_ORIGIN_NOT_VERIFIED');
  if(provenance.facts.modeSupported===false) reasons.push('LAUNCHPAD_MODE_NOT_SUPPORTED');
  if(safety.status!=='pass') reasons.push('TECHNICAL_SAFETY_NOT_PASSED');
  const identityConflict=narrativeIdentityConflict(signal,narrative);
  if(identityConflict) reasons.push('NARRATIVE_TOKEN_IDENTITY_CONFLICT');
  if(config.walletSupportRequired&&flow?.status!=='pass') reasons.push('WALLET_SUPPORT_NOT_PASSED');
  if(flow?.reasons.includes('WALLET_SETUP_SUPPORT_WITHDRAWN'))reasons.push('WALLET_SETUP_SUPPORT_WITHDRAWN');
  if(config.marketRiskRequired&&marketRisk?.status!=='pass')reasons.push('MARKET_RISK_NOT_PASSED');
  const required=[provenance,...requiredSafetyEvidence(safety),...(config.walletSupportRequired&&flow?[flow]:[]),...(config.marketRiskRequired&&marketRisk?[marketRisk]:[])];
  const proofMaxAgeMs=Math.min(120,config.maxSignalAgeSec)*1000;
  const invalidProof=required.some(c=>!Number.isFinite(Date.parse(c.checkedAt))||Date.parse(c.checkedAt)>now.getTime()+30_000||
    now.getTime()-Date.parse(c.checkedAt)>=proofMaxAgeMs);
  if(invalidProof)reasons.push('REQUIRED_EVIDENCE_STALE');
  const proofExpiry=invalidProof?now.getTime():Math.min(...required.map(c=>Date.parse(c.checkedAt)+proofMaxAgeMs));
  const fail=[provenance,safety,...(config.marketRiskRequired&&marketRisk?[marketRisk]:[])].some(c=>c.status==='fail')||identityConflict;
  const decision=fail?'REJECT':reasons.length?'WATCH':'BUY_CANDIDATE';
  return {id,policyVersion:'entry-gate-v9',mode,signal,receivedAt,evaluatedAt:now.toISOString(),
    validUntil:new Date(Math.min(now.getTime()+config.decisionTtlSec*1000,Date.parse(signal.occurredAt)+maxSignalAgeSec*1000,proofExpiry,
      flow?.reasons.includes('PROFILED_WALLET_SETUP_SUPPORTED')?Date.parse(walletScreening!.validUntil):Infinity)).toISOString(),
    decision,buyEligible:decision==='BUY_CANDIDATE'&&mode==='live',executionEnabled:false,
    reasons:[...reasons,...provenance.reasons,...safety.reasons,...(flow?.reasons??[]),...(marketRisk?.reasons??[])],
    advisoryReasons:[...new Set(narrative.reasons)],
    social:assessSocialSignals(signal,narrative.evidence,{snapshot:research?.snapshot,now,maxAgeSec:config.maxEvidenceAgeSec}),
    provenance,safety,narrative,
    ...(walletScreening?{walletScreening}:{}),
    ...(research?{gmgn:research.snapshot,wallets:research.wallets}:{}),
    ...(marketRisk?{marketRisk}:{}),
    ...(flow?{flow}:config.walletSupportRequired?{flow:unknown('GMGN_WALLET_RESEARCH_UNAVAILABLE')}: {})};
}

/** A route is an alternative source of wallet support, never an alternative safety check. */
export function mergeWalletSupport(primary:Check|undefined,screening:WalletScreeningReport|undefined,signal:Signal,now:Date):Check|undefined {
  if(!screening||screening.token.chain!==signal.token.chain||screening.token.address!==signal.token.address||
    !Number.isFinite(Date.parse(screening.checkedAt))||Date.parse(screening.checkedAt)>now.getTime()||
    !Number.isFinite(Date.parse(screening.validUntil))||Date.parse(screening.validUntil)<=now.getTime())return primary;
  if(primary?.status==='fail')return primary;
  const relevant=screening.setups.filter(s=>s.priorityScore>0),supported=relevant.filter(s=>s.status==='supported');
  const withdrawn=!supported.length&&screening.setups.some(qualifiedWalletWithdrawal);
  if(withdrawn)return {status:'unknown',reasons:['WALLET_SETUP_SUPPORT_WITHDRAWN'],checkedAt:screening.checkedAt,
    facts:{primary,scope:'wallet_setup_risk',walletScreening:screening,ownershipProven:false}};
  if(screening.status==='supported'&&supported.length)return {status:'pass',reasons:['PROFILED_WALLET_SETUP_SUPPORTED'],checkedAt:screening.checkedAt,
    facts:{primary,scope:'sampled_profiled_wallet_setup',routes:supported.map(s=>({id:s.id,route:s.route,wallet:s.wallet,leader:s.leader})),ownershipProven:false,independenceProven:false}};
  return primary;
}

export async function evaluate(signal:Signal,config:Config,providers=liveProviders(config),options:{
  id?:string;receivedAt?:string;now?:()=>Date;mode?:'live'|'demo';budgetMs?:number;
  walletTargetsReady?:Promise<unknown>;onProgress?:(progress:EvaluationProgress)=>void;
}={}):Promise<Report> {
  const clock=options.now??(()=>new Date()),start=clock(),receivedAt=options.receivedAt??start.toISOString();
  const age=start.getTime()-Date.parse(signal.occurredAt);
  const maxAgeSec=['debot','ave'].includes(signal.source)?Math.min(120,config.maxSignalAgeSec):config.maxSignalAgeSec;
  if(age>=maxAgeSec*1000||age< -30_000) {
    return decide(signal,receivedAt,config,unknown('SKIPPED_STALE_SIGNAL'),unknown('SKIPPED_STALE_SIGNAL'),
      {...unknown('SKIPPED_STALE_SIGNAL'),evidence:[]},start,options.mode,options.id);
  }
  const requestedBudget=options.budgetMs??config.evaluationTimeoutMs??30_000;
  const budgetMs=Number.isFinite(requestedBudget)?Math.max(1,Math.min(120_000,requestedBudget)):30_000;
  const controller=new AbortController(),optionalController=new AbortController();
  const context={signal:controller.signal},optionalContext={signal:AbortSignal.any([controller.signal,optionalController.signal])};
  const monotonicStart=performance.now();
  let ended=false,optionalEnded=false,narrativeDone=false,timedOut=false;
  let provenance:Provenance=unknown('PROVENANCE_PENDING'),primarySafety:Check=unknown('SAFETY_PENDING');
  let supplement:Check|undefined,research:GmgnResearch|undefined,snapshot:GmgnTokenSnapshot|undefined;
  let marketRisk:Check=unknown('MARKET_RISK_PENDING'),walletScreening:WalletScreeningReport|undefined;
  let narrative:NarrativeReport={...unknown('NARRATIVE_PENDING'),evidence:[]};
  let analysisSignal=signal,vendorFetch:VendorFetch|undefined;
  let safetyDone=false,provenanceDone=false,researchDone=!providers.research,marketDone=false;
  const progress=(stage:EvaluationProgress['stage'],check:Check)=>{
    if(ended)return;
    try {options.onProgress?.({stage,checkedAt:check.checkedAt,elapsedMs:Math.max(0,Math.round(performance.now()-monotonicStart)),
      status:check.status,reasons:[...check.reasons]});}catch {/* Observers cannot change the gate. */}
  };
  let rejectEarly!:()=>void;
  const blocked=new Promise<'blocked'>(resolve=>{rejectEarly=()=>resolve('blocked');});
  const veto=(check:Check|undefined)=>{if(check?.status==='fail')rejectEarly();};
  let releaseSnapshot!:(value:GmgnTokenSnapshot|undefined)=>void,snapshotReleased=false;
  const snapshotReady=new Promise<GmgnTokenSnapshot|undefined>(resolve=>{releaseSnapshot=resolve;});
  const receiveSnapshot=(value:GmgnTokenSnapshot|undefined)=>{
    if(ended||snapshotReleased)return;
    snapshotReleased=true;snapshot=value;
    if(value){supplement=assessGmgnSafety(value,config.maxTaxRate);veto(supplement);}
    marketRisk=assessMarketRisk(signal,value,clock(),{maxTaxRate:config.maxTaxRate,maxAgeSec:Math.min(120,config.maxSignalAgeSec)});marketDone=true;progress('market',marketRisk);
    if(config.marketRiskRequired)veto(marketRisk);
    releaseSnapshot(value);
  };
  let timeoutResolve!:(value:'timeout')=>void;
  const deadline=new Promise<'timeout'>(resolve=>{timeoutResolve=resolve;});
  const timer=setTimeout(()=>{timedOut=true;timeoutResolve('timeout');controller.abort(new Error('ANALYSIS_DEADLINE_EXCEEDED'));},budgetMs);
  const optionalTimer=setTimeout(()=>{optionalEnded=true;optionalController.abort(new Error('NARRATIVE_DEADLINE_EXCEEDED'));},Math.min(2000,budgetMs));
  // Advisory text starts concurrently. The required gate never waits for it.
  const optionalWork=(async()=>{
    if(!signal.vendorNarrative&&providers.vendor) {
      try {vendorFetch=await providers.vendor(signal,optionalContext);}
      catch {vendorFetch={status:'unavailable',reason:'DEBOT_REQUEST_FAILED',fetchedAt:clock().toISOString()};}
      if(ended||optionalEnded)return;
      if(vendorFetch.status==='ok'&&vendorFetch.snapshot)analysisSignal={...signal,vendorNarrative:vendorFetch.snapshot};
      // A concrete wrong-contract response is already known evidence. Do not lose
      // this veto merely because optional social lookup has not finished yet.
      const identityFacts={...(vendorFetch.identityConflict?{supplierAddressConflict:vendorFetch.identityConflict}:{}),
        ...(vendorFetch.snapshot?{supplierToken:vendorFetch.snapshot.token}:{}),
        vendorFetch:{status:vendorFetch.status,reason:vendorFetch.reason,sourceUrl:vendorFetch.sourceUrl,fetchedAt:vendorFetch.fetchedAt},
        ...(vendorFetch.rawResponse!==undefined?{vendorResponse:vendorFetch.rawResponse}:{})};
      const identityNarrative={...unknown('VENDOR_NARRATIVE_TOKEN_MISMATCH',identityFacts),evidence:[]};
      if(narrativeIdentityConflict(signal,identityNarrative)) {
        narrative=identityNarrative;narrativeDone=true;optionalEnded=true;clearTimeout(optionalTimer);
        progress('narrative',narrative);rejectEarly();return;
      }
    }
    let collected:Evidence[]|EvidenceReport;
    try {collected=await providers.evidence(analysisSignal,optionalContext);}
    catch {collected={evidence:[],diagnostics:[{operation:'search',status:'unavailable',reason:'EVIDENCE_PROVIDER_FAILED',returned:0}]};}
    if(ended||optionalEnded)return;
    const evidence=Array.isArray(collected)?collected:collected.evidence;
    try {narrative=await providers.narrative(analysisSignal,evidence,clock(),optionalContext);}
    catch {narrative={...unknown('NARRATIVE_PROVIDER_FAILED'),evidence};}
    if(ended||optionalEnded)return;
    narrative.facts={...narrative.facts,evidenceDiagnostics:Array.isArray(collected)?[]:collected.diagnostics};
    if(vendorFetch) {
      narrative.facts.vendorFetch={status:vendorFetch.status,reason:vendorFetch.reason,sourceUrl:vendorFetch.sourceUrl,fetchedAt:vendorFetch.fetchedAt};
      if(vendorFetch.rawResponse!==undefined)narrative.facts.vendorResponse=vendorFetch.rawResponse;
      if(vendorFetch.identityConflict) {
        narrative.facts.supplierAddressConflict=vendorFetch.identityConflict;
        if(narrativeIdentityConflict(signal,narrative))narrative.reasons=[...new Set([...narrative.reasons,'VENDOR_NARRATIVE_TOKEN_MISMATCH'])];
      }
      if(vendorFetch.status==='ok'&&vendorFetch.snapshot) {
        narrative.facts.ingestion='vendor_endpoint';narrative.facts.providerEndpointRetrieved=true;
        narrative.facts.nativeNarrativeApiStatus='observed_web_endpoint';narrative.facts.providerApiAuthenticated=false;
        if(narrative.supplier)narrative.supplier={...narrative.supplier,verification:'vendor_endpoint'};
      }
    }
    optionalEnded=true;narrativeDone=true;clearTimeout(optionalTimer);progress('narrative',narrative);
    if(narrativeIdentityConflict(signal,narrative))rejectEarly();
  })().catch(()=>{});
  const safetyWork=Promise.resolve().then(()=>providers.safety(signal,context)).then(value=>{
    if(ended)return;primarySafety=value;safetyDone=true;progress('safety',combineSafety(primarySafety,supplement));veto(value);
  },()=>{if(!ended){primarySafety=unknown('SAFETY_PROVIDER_FAILED');safetyDone=true;progress('safety',primarySafety);}});
  const researchWork=(async()=>{
    if(providers.research) {
      try {
        const value=await providers.research(signal,{signal:controller.signal,onSnapshot:receiveSnapshot,walletTargetsReady:options.walletTargetsReady});
        if(ended)return;research=value;researchDone=true;receiveSnapshot(value.snapshot);supplement=value.safety;veto(supplement);
      }catch {if(!ended){researchDone=true;receiveSnapshot(undefined);}}
    }else receiveSnapshot(undefined);
    if(ended)return;
    if(providers.walletScreening&&options.mode!=='demo')try {walletScreening=await providers.walletScreening(signal,research,clock());}
    catch {const at=clock();walletScreening={version:1,token:signal.token,checkedAt:at.toISOString(),validUntil:new Date(at.getTime()+60000).toISOString(),
      status:'unavailable',priorityScore:0,scope:'research_priority',ownership:'unknown',sampleOnly:true,setups:[],reasons:['WALLET_SCREENING_UNAVAILABLE']};}
    if(!ended)progress('wallets',mergeWalletSupport(research?.flow,walletScreening,signal,clock())??unknown('GMGN_WALLET_RESEARCH_UNAVAILABLE'));
  })().catch(()=>{});
  const provenanceWork=(async()=>{
    try {
      const value=signal.token.chain==='solana'||signal.creationTx?undefined:await snapshotReady;
      if(ended)return;
      const checked=await providers.provenance(signal,value?{snapshot:value}:undefined,context);
      if(ended)return;provenance=checked;provenanceDone=true;progress('provenance',checked);veto(checked);
    }catch {if(!ended){provenance=unknown('PROVENANCE_PROVIDER_FAILED');provenanceDone=true;progress('provenance',provenance);}}
  })();
  const completed=Promise.all([safetyWork,researchWork,provenanceWork]).then(()=>'complete' as const);
  const outcome=await Promise.race([completed,blocked,deadline]);
  // Freeze every publication before aborting. Late providers cannot mutate this decision or progress.
  ended=true;clearTimeout(timer);clearTimeout(optionalTimer);controller.abort(new Error('ANALYSIS_FINISHED'));optionalController.abort();
  void optionalWork;
  if(!safetyDone)primarySafety=unknown(timedOut?'SAFETY_DEADLINE_EXCEEDED':'SAFETY_NOT_COMPLETED');
  if(!provenanceDone)provenance=unknown(timedOut?'PROVENANCE_DEADLINE_EXCEEDED':'PROVENANCE_NOT_COMPLETED');
  if(!marketDone)marketRisk=unknown(timedOut?'MARKET_RISK_DEADLINE_EXCEEDED':'MARKET_RISK_NOT_COMPLETED');
  if(!narrativeDone)narrative={...unknown('NARRATIVE_NOT_COMPLETED'),evidence:[]};
  const safety=combineSafety(primarySafety,supplement);
  if(provenance.status==='fail'||safety.status==='fail')narrative={...unknown('SKIPPED_BLOCKED_ASSET'),evidence:narrative.evidence};
  const report=decide(signal,receivedAt,config,provenance,safety,narrative,clock(),options.mode,options.id,research,walletScreening,marketRisk);
  if(snapshot&&!report.gmgn)report.gmgn=snapshot;
  if(outcome==='timeout') {
    report.reasons=[...new Set(['ANALYSIS_DEADLINE_EXCEEDED',...report.reasons])];
    // Timeout cannot complete the required wallet/profile gate using an unfinished sample.
    if(report.decision!=='REJECT') {report.decision='WATCH';report.buyEligible=false;}
  }
  if(!researchDone&&config.walletSupportRequired)report.reasons=[...new Set([...report.reasons,'WALLET_RESEARCH_NOT_COMPLETED'])];
  return report;
}

export function effectiveReport(report:Report,now=new Date()):Report {
  if(report.buyEligible && Date.parse(report.validUntil)<=now.getTime())
    return {...report,buyEligible:false,decision:'WATCH',decisionAtEvaluation:report.decisionAtEvaluation??report.decision,reasons:['DECISION_EXPIRED',...report.reasons]};
  return report;
}
