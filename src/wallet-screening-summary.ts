import {chainAddress} from './chain-stream-store.js';
import type {Signal} from './types.js';
import type {WalletScreeningReport,WalletSetup} from './wallet-screening.js';
const stamp=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
const codes=(v:unknown)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(x)).slice(0,24):[];
/** Retain a small decision snapshot, never arbitrary vendor fields or nested response payloads. */
export function compactWalletScreening(value:WalletScreeningReport|undefined,token:Signal['token'],asOf:string):WalletScreeningReport|undefined {
 if(!value||value.version!==1||value.token?.chain!==token.chain||chainAddress(token.chain,value.token.address)!==token.address||
   !stamp(value.checkedAt)||value.checkedAt>asOf||!stamp(value.validUntil)||!['supported','watch','unavailable'].includes(value.status))return;
 const setups:WalletSetup[]=[];
 for(const s of (Array.isArray(value.setups)?value.setups:[]).slice(0,8)) {
  const t=s?.trigger;if(!s||!t||!['precursor','public_entry'].includes(s.route)||!['supported','watch','withdrawn'].includes(s.status)||
    !chainAddress(token.chain,s.wallet)||!chainAddress(token.chain,s.leader)||t.chain!==token.chain||t.tokenAddress!==token.address||
    !stamp(t.eventAt)||!stamp(t.observedAt)||t.eventAt>t.observedAt||t.observedAt>asOf||typeof t.txHash!=='string'||t.txHash.length>88)continue;
  const {chain,wallet,tokenAddress,txHash,side,eventAt,observedAt}=t;
  const numeric=(v:unknown)=>typeof v==='string'&&v.length<160&&Number.isFinite(Number(v))?v:undefined;
  const score=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)?Math.max(0,Math.min(20,n)):0;
  const p=s.profit;
  setups.push({id:String(s.id).slice(0,160),route:s.route,wallet:s.wallet,leader:s.leader,status:s.status,stage:s.stage,
    priorityScore:score(s.priorityScore),reasons:codes(s.reasons),counterEvidence:codes(s.counterEvidence),ownership:'unknown',
    trigger:{chain,wallet,tokenAddress,txHash,side,eventAt,observedAt,source:String(t.source).slice(0,80),usd:numeric(t.usd),priceUsd:numeric(t.priceUsd)},
    ...(p&&Number.isFinite(p.realizedProfitUsd)&&Number.isFinite(p.percentile)?{profit:{realizedProfitUsd:p.realizedProfitUsd,percentile:p.percentile,
      cohortSize:Math.min(2000,Math.max(0,p.cohortSize)),observedAt:p.observedAt,verification:'vendor_claim' as const}}:{}),
    ...(stamp(s.profileComputedAt)?{profileComputedAt:s.profileComputedAt}:{}),...(stamp(s.relationKnownAt)?{relationKnownAt:s.relationKnownAt}:{}),
    ...(Number.isFinite(s.chasePct)?{chasePct:s.chasePct}:{}),followers:Number.isSafeInteger(s.followers)?Math.max(0,s.followers):0});
 }
 return {version:1,token:{...token},checkedAt:value.checkedAt,validUntil:value.validUntil,status:value.status,
   priorityScore:Math.max(0,Math.min(20,Number(value.priorityScore)||0)),scope:'research_priority',ownership:'unknown',sampleOnly:true,setups,reasons:codes(value.reasons)};
}
