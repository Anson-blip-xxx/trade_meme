import {readFileSync} from 'node:fs';
import type {Config} from './config.js';
import {unknown,type Check,type Signal} from './types.js';
import {GmgnClient} from './providers/gmgn-client.js';
import {collectGmgnToken,assessGmgnSafety,type GmgnTokenSnapshot} from './providers/gmgn-safety.js';
import {analyzeWallets,parseWalletIdentities} from './research/wallets.js';
import type {WalletAnalysis,WalletIdentity} from './research/wallet-types.js';

export interface GmgnResearch {snapshot:GmgnTokenSnapshot;safety:Check;wallets:WalletAnalysis;flow:Check;}
export function loadIdentities(path?:string):WalletIdentity[] {
  if(!path) return [];
  try {
    const content=readFileSync(path,'utf8');if(Buffer.byteLength(content)>1000000) throw new Error();
    return parseWalletIdentities(JSON.parse(content));
  } catch {throw new Error('WALLET_IDENTITIES_CONFIG_INVALID');}
}

export function assessWalletSupport(wallets:WalletAnalysis,minGroups:number,now=new Date()):Check {
  const summary=wallets.summary,reasons:string[]=[];
  if(wallets.status!=='pass') reasons.push('WALLET_SAMPLE_UNVERIFIED');
  if(summary.qualifiedSmartFundingClusterCount<minGroups) reasons.push('SMART_WALLET_GROUP_SUPPORT_INSUFFICIENT');
  if(summary.hasRecentAccumulation!==true) reasons.push('RECENT_SMART_ACCUMULATION_UNVERIFIED');
  return {status:reasons.length?'unknown':'pass',reasons:reasons.length?reasons:['SMART_WALLET_ACCUMULATION_SUPPORTED'],
    checkedAt:now.toISOString(),facts:{summary,minGroups,
      scope:'sampled_vendor_tagged_current_holders_and_observed_recent_trades',
      ownershipProven:false,groupCountIsUpperBound:true,
      note:'共同资金来源仅为关联线索；分组数量不证明彼此独立，GMGN 标签不代表身份或收益保证。'}};
}

export function researchProvider(config:Config,client:GmgnClient,identities=loadIdentities(config.walletIdentitiesPath)) {
  return async(signal:Signal):Promise<GmgnResearch>=>{
    const snapshot=await collectGmgnToken(signal,client);
    const wallets=await analyzeWallets(signal,snapshot.info,client,{maxWallets:config.walletMaxProfiles,identities});
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
