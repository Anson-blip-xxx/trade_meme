import {readFileSync} from 'node:fs';
import type {Config} from './config.js';
import {unknown,type Check,type Signal} from './types.js';
import {GmgnClient} from './providers/gmgn-client.js';
import {collectGmgnToken,assessGmgnSafety,type GmgnTokenSnapshot} from './providers/gmgn-safety.js';
import {analyzeWallets,parseWalletIdentities} from './research/wallets.js';
import type {WalletAnalysis,WalletIdentity,WalletRecord,VendorWalletTargets} from './research/wallet-types.js';
import type {WalletResearchTargets} from './research/wallet-targets.js';
export type {VendorWalletTargets} from './research/wallet-types.js';

export interface GmgnResearch {snapshot:GmgnTokenSnapshot;safety:Check;wallets:WalletAnalysis;flow:Check;}
export function loadIdentities(path?:string):WalletIdentity[] {
  if(!path) return [];
  try {
    const content=readFileSync(path,'utf8');if(Buffer.byteLength(content)>1000000) throw new Error();
    return parseWalletIdentities(JSON.parse(content));
  } catch {throw new Error('WALLET_IDENTITIES_CONFIG_INVALID');}
}

// Only a missing enrichment on another sampled wallet may be isolated. Scope,
// malformed activities, holdings/funding conflicts, failed holder requests and
// every new/unrecognized diagnostic remain a whole-sample blocker.
const PARTIAL_SUPPORT_REASONS = new Set(['GMGN_WALLET_ENRICHMENT_PARTIAL',
  'DEVELOPER_LINKED_WALLETS_OBSERVED','EXCHANGE_FUNDING_NOT_OWNERSHIP_LINK','RECENT_SMART_FLOW_COVERAGE_INCOMPLETE',
  'WALLET_TAGS_ARE_VENDOR_CLAIMS','WALLET_OWNERSHIP_UNVERIFIED','CUMULATIVE_VOLUMES_ARE_NOT_RECENT_FLOW']);
function completeSupportGroups(wallets:WalletAnalysis,now:Date):string[] {
  const target=wallets.summary.token,checked=Date.parse(wallets.checkedAt),stamp=now.getTime();
  const bound=wallets.facts.token as Signal['token']|undefined;
  if(wallets.facts.provider!=='gmgn'||wallets.facts.source!=='openapi'||!bound||bound.chain!==target.chain||bound.address!==target.address||
    !Number.isFinite(checked)||checked>stamp||stamp-checked>120_000||wallets.wallets.length>200||wallets.clusters.length>200)return [];
  const byAddress=new Map(wallets.wallets.map(w=>[w.address,w]));
  if(byAddress.size!==wallets.wallets.length||wallets.wallets.some(w=>w.chain!==target.chain))return [];
  const unsafe=(w:WalletRecord)=>w.risks.length>0||w.developerLinks.length>0||w.funding.conflict||
    w.recognizedLabels.some(v=>['bundler','rat_trader','developer','exchange_or_pool'].includes(v));
  const positive=(v:string|null)=>v!==null&&v.trim()!==''&&Number.isFinite(Number(v))&&Number(v)>0;
  const groups=new Set<string>();
  for(const w of wallets.wallets) {
    const recent=w.enrichment.activity?.recent;
    if(unsafe(w)||!w.recognizedLabels.includes('smart')||w.holding.currentlyHolding!==true||!positive(w.holding.amount)||
      w.enrichment.status!=='complete'||!w.enrichment.stats||!recent||recent.coverage==='partial'||recent.hasAccumulation!==true||
      !positive(recent.netBuyUsd)||!Number.isFinite(Date.parse(recent.since))||!Number.isFinite(Date.parse(recent.until))||
      Date.parse(recent.since)>=Date.parse(recent.until)||Date.parse(recent.until)>checked||stamp-Date.parse(recent.until)>120_000)continue;
    const cluster=wallets.clusters.find(c=>c.id===w.clusterId);
    if(!cluster||cluster.chain!==target.chain||cluster.developerLinked||!cluster.wallets.includes(w.address)||
      cluster.wallets.some(a=>!byAddress.has(a)||byAddress.get(a)!.clusterId!==cluster.id||unsafe(byAddress.get(a)!)))continue;
    groups.add(cluster.id);
  }
  return [...groups];
}

export function assessWalletSupport(wallets:WalletAnalysis,minGroups:number,now=new Date()):Check {
  const summary=wallets.summary,reasons:string[]=[];
  const groups=wallets.status==='unknown'&&wallets.reasons.includes('GMGN_WALLET_ENRICHMENT_PARTIAL')&&
    wallets.reasons.every(r=>PARTIAL_SUPPORT_REASONS.has(r))?completeSupportGroups(wallets,now):[];
  const isolatedPartial=Number.isInteger(minGroups)&&minGroups>=1&&groups.length>=minGroups;
  if(wallets.status!=='pass'&&!isolatedPartial) reasons.push('WALLET_SAMPLE_UNVERIFIED');
  if(summary.qualifiedSmartFundingClusterCount<minGroups) reasons.push('SMART_WALLET_GROUP_SUPPORT_INSUFFICIENT');
  if(summary.hasRecentAccumulation!==true) reasons.push('RECENT_SMART_ACCUMULATION_UNVERIFIED');
  return {status:reasons.length?'unknown':'pass',reasons:reasons.length?reasons:['SMART_WALLET_ACCUMULATION_SUPPORTED'],
    checkedAt:now.toISOString(),facts:{summary,minGroups,
      ...(isolatedPartial?{partialSampleIsolated:true,completeSupportGroups:groups,excludedPartialWallets:
        wallets.wallets.filter(w=>w.enrichment.status==='partial').map(w=>w.address)}:{}),
      scope:'sampled_vendor_tagged_current_holders_and_observed_recent_trades',
      ownershipProven:false,groupCountIsUpperBound:true,
      note:'共同资金来源仅为关联线索；分组数量不证明彼此独立，GMGN 标签不代表身份或收益保证。'}};
}

export function researchProvider(config:Config,client:GmgnClient,identities=loadIdentities(config.walletIdentitiesPath),
  options:{walletTargets?:(signal:Signal)=>WalletResearchTargets;
    vendorWalletTargets?:(signal:Signal)=>VendorWalletTargets|undefined}={}) {
  return async(signal:Signal):Promise<GmgnResearch>=>{
    const snapshot=await collectGmgnToken(signal,client);
    let researchTargets:WalletResearchTargets|undefined,vendorWalletTargets:VendorWalletTargets|undefined,targetError=false,vendorTargetError=false;
    try{researchTargets=options.walletTargets?.(signal);}catch{targetError=true;}
    try{vendorWalletTargets=options.vendorWalletTargets?.(signal);}catch{vendorTargetError=true;}
    const wallets=await analyzeWallets(signal,snapshot.info,client,{maxWallets:config.walletMaxProfiles,identities,researchTargets,vendorWalletTargets});
    if(targetError)wallets.facts.targetSelectionError='LOCAL_WALLET_TARGETS_UNAVAILABLE';
    if(vendorTargetError)wallets.facts.vendorTargetSelectionError='VENDOR_WALLET_TARGETS_UNAVAILABLE';
    return {snapshot,safety:assessGmgnSafety(snapshot,config.maxTaxRate),wallets,
      flow:assessWalletSupport(wallets,config.minSmartWalletGroups)};
  };
}

export function combineSafety(primary:Check,supplement?:Check):Check {
  if(!supplement) return primary;
  return {status:primary.status==='fail'||supplement.status==='fail'?'fail':primary.status,
    checkedAt:new Date().toISOString(),reasons:[...primary.reasons,...supplement.reasons],
    facts:{primary,gmgn:supplement,scope:'primary_permission_checks_with_supplemental_gmgn_flags'}};
}
