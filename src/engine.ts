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
import {researchProvider,combineSafety,type GmgnResearch} from './research.js';
import {assessSocialSignals} from './social-signals.js';
import {qualifiedWalletWithdrawal,type WalletScreeningReport} from './wallet-screening.js';

type VendorFetch=Awaited<ReturnType<typeof fetchDebotNarrative>>;

export interface Providers {
  provenance:(signal:Signal,research?:GmgnResearch)=>Promise<Provenance>;
  safety:(signal:Signal)=>Promise<Check>;
  evidence:(signal:Signal)=>Promise<Evidence[]|EvidenceReport>;
  narrative:(signal:Signal,evidence:Evidence[],now:Date)=>Promise<NarrativeReport>;
  vendor?:(signal:Signal)=>Promise<VendorFetch>;
  research?:(signal:Signal)=>Promise<GmgnResearch>;
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
  return {provenance:(s,r)=>checkProvenance(s,config,fetch,r?.snapshot.info),safety:s=>checkSafety(s,config),
    evidence:s=>gatherEvidenceReport(prioritizeVendorEvidence(s),config),
    narrative:(s,e,n)=>config.narrativeProvider==='vendor'?Promise.resolve(analyzeVendorNarrative(s,e,config,n)):analyzeNarrative(s,e,config,n),
    research:researchProvider(config,client),
    ...(config.narrativeProvider==='vendor'?{vendor:(s:Signal)=>fetchDebotNarrative(s)}:{})};
}

export function decide(signal:Signal,receivedAt:string,config:Config,provenance:Provenance,safety:Check,narrative:NarrativeReport,
  now:Date,mode:'live'|'demo'='live',id:string=randomUUID(),research?:GmgnResearch,walletScreening?:WalletScreeningReport):Report {
  const reasons:string[]=[];
  const flow=mergeWalletSupport(research?.flow,walletScreening,signal,now);
  const age=now.getTime()-Date.parse(signal.occurredAt);
  if(age< -30_000) reasons.push('SIGNAL_TIME_IN_FUTURE');
  if(age>config.maxSignalAgeSec*1000) reasons.push('SIGNAL_STALE');
  if(provenance.status!=='pass') reasons.push('PLATFORM_ORIGIN_NOT_VERIFIED');
  if(provenance.facts.modeSupported===false) reasons.push('LAUNCHPAD_MODE_NOT_SUPPORTED');
  if(safety.status!=='pass') reasons.push('TECHNICAL_SAFETY_NOT_PASSED');
  const identityConflict=narrativeIdentityConflict(signal,narrative);
  if(identityConflict) reasons.push('NARRATIVE_TOKEN_IDENTITY_CONFLICT');
  if(config.walletSupportRequired&&flow?.status!=='pass') reasons.push('WALLET_SUPPORT_NOT_PASSED');
  if(flow?.reasons.includes('WALLET_SETUP_SUPPORT_WITHDRAWN'))reasons.push('WALLET_SETUP_SUPPORT_WITHDRAWN');
  const fail=[provenance,safety].some(c=>c.status==='fail')||identityConflict;
  const decision=fail?'REJECT':reasons.length?'WATCH':'BUY_CANDIDATE';
  return {id,policyVersion:walletScreening?'entry-gate-v7':'entry-gate-v6',mode,signal,receivedAt,evaluatedAt:now.toISOString(),
    validUntil:new Date(Math.min(now.getTime()+config.decisionTtlSec*1000,Date.parse(signal.occurredAt)+config.maxSignalAgeSec*1000,
      flow?.reasons.includes('PROFILED_WALLET_SETUP_SUPPORTED')?Date.parse(walletScreening!.validUntil):Infinity)).toISOString(),
    decision,buyEligible:decision==='BUY_CANDIDATE'&&mode==='live',executionEnabled:false,
    reasons:[...reasons,...provenance.reasons,...safety.reasons,...(flow?.reasons??[])],
    advisoryReasons:[...new Set(narrative.reasons)],
    social:assessSocialSignals(signal,narrative.evidence,{snapshot:research?.snapshot,now,maxAgeSec:config.maxEvidenceAgeSec}),
    provenance,safety,narrative,
    ...(walletScreening?{walletScreening}:{}),
    ...(research?{gmgn:research.snapshot,wallets:research.wallets}:{}),
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

export async function evaluate(signal:Signal,config:Config,providers=liveProviders(config),options:{id?:string;receivedAt?:string;now?:()=>Date;mode?:'live'|'demo'}={}):Promise<Report> {
  const clock=options.now??(()=>new Date()),start=clock(),receivedAt=options.receivedAt??start.toISOString();
  const age=start.getTime()-Date.parse(signal.occurredAt);
  if(age>config.maxSignalAgeSec*1000 || age< -30_000) {
    return decide(signal,receivedAt,config,unknown('SKIPPED_STALE_SIGNAL'),unknown('SKIPPED_STALE_SIGNAL'),
      {...unknown('SKIPPED_STALE_SIGNAL'),evidence:[]},start,options.mode,options.id);
  }
  let analysisSignal=signal,vendorFetch:VendorFetch|undefined;
  const collect=async()=>{
    // Imported snapshots keep their original version. Automatic reads only fill missing narratives.
    if(!signal.vendorNarrative&&providers.vendor) {
      try {vendorFetch=await providers.vendor(signal);}
      catch {vendorFetch={status:'unavailable',reason:'DEBOT_REQUEST_FAILED',fetchedAt:clock().toISOString()};}
      if(vendorFetch.status==='ok'&&vendorFetch.snapshot) analysisSignal={...signal,vendorNarrative:vendorFetch.snapshot};
    }
    return providers.evidence(analysisSignal);
  };
  const researchPromise=providers.research?providers.research(signal).catch(()=>undefined):Promise.resolve(undefined);
  // GMGN creation time is a bounded RPC-log lookup hint, never source proof by itself.
  const checks=await Promise.allSettled([researchPromise.then(r=>providers.provenance(signal,r)),providers.safety(signal),collect()]);
  const research=await researchPromise;
  const provenance=checks[0].status==='fulfilled'?checks[0].value:unknown('PROVENANCE_PROVIDER_FAILED');
  const safety=combineSafety(checks[1].status==='fulfilled'?checks[1].value:unknown('SAFETY_PROVIDER_FAILED'),research?.safety);
  const collected=checks[2].status==='fulfilled'?checks[2].value:{evidence:[],diagnostics:[{operation:'search',status:'unavailable',reason:'EVIDENCE_PROVIDER_FAILED',returned:0}]};
  const evidence=Array.isArray(collected)?collected:collected.evidence;
  const diagnostics=Array.isArray(collected)?[]:collected.diagnostics;
  let narrative:NarrativeReport;
  if(provenance.status==='fail'||safety.status==='fail') narrative={...unknown('SKIPPED_BLOCKED_ASSET'),evidence};
  else try {narrative=await providers.narrative(analysisSignal,evidence,clock());}
  catch {narrative={...unknown('NARRATIVE_PROVIDER_FAILED'),evidence};}
  narrative.facts={...narrative.facts,evidenceDiagnostics:diagnostics};
  if(vendorFetch) {
    narrative.facts.vendorFetch={status:vendorFetch.status,reason:vendorFetch.reason,
      sourceUrl:vendorFetch.sourceUrl,fetchedAt:vendorFetch.fetchedAt};
    // Invalid payloads (including wrong-CA responses) are just as important to retain for audit.
    if(vendorFetch.rawResponse!==undefined) narrative.facts.vendorResponse=vendorFetch.rawResponse;
    if(vendorFetch.identityConflict) {
      narrative.facts.supplierAddressConflict=vendorFetch.identityConflict;
      if(narrativeIdentityConflict(signal,narrative))
        narrative.reasons=[...new Set([...narrative.reasons,'VENDOR_NARRATIVE_TOKEN_MISMATCH'])];
    }
    if(vendorFetch.status==='ok'&&vendorFetch.snapshot) {
      narrative.facts.ingestion='vendor_endpoint';
      narrative.facts.providerEndpointRetrieved=true;
      narrative.facts.nativeNarrativeApiStatus='observed_web_endpoint';
      narrative.facts.providerApiAuthenticated=false;
      if(narrative.supplier) narrative.supplier={...narrative.supplier,verification:'vendor_endpoint'};
    }
  }
  // Re-evaluate freshness after RPC/model latency; a fresh arrival can become stale during analysis.
  let walletScreening:WalletScreeningReport|undefined;
  if(providers.walletScreening&&options.mode!=='demo')try {walletScreening=await providers.walletScreening(signal,research,clock());}
  catch {const at=clock();walletScreening={version:1,token:signal.token,checkedAt:at.toISOString(),validUntil:new Date(at.getTime()+60000).toISOString(),
    status:'unavailable',priorityScore:0,scope:'research_priority',ownership:'unknown',sampleOnly:true,setups:[],reasons:['WALLET_SCREENING_UNAVAILABLE']};}
  return decide(signal,receivedAt,config,provenance,safety,narrative,clock(),options.mode,options.id,research,walletScreening);
}

export function effectiveReport(report:Report,now=new Date()):Report {
  if(report.buyEligible && Date.parse(report.validUntil)<=now.getTime())
    return {...report,buyEligible:false,decision:'WATCH',decisionAtEvaluation:report.decisionAtEvaluation??report.decision,reasons:['DECISION_EXPIRED',...report.reasons]};
  return report;
}
