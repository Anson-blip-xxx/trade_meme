import bs58 from 'bs58';
import {chainAddress,object} from '../chain-stream-store.js';
import type {Chain,Signal} from '../types.js';
import type {WalletTradeObservation} from '../wallet-history.js';
import type {WalletProfile} from '../wallet-profiles.js';
import {qualifiedRoleEvidence} from '../wallet-role-analysis.js';

export interface WalletResearchTarget {
  address:string;reason:'profiled_buy'|'precursor_leader';triggerWallet:string;
  eventAt:string;observedAt:string;txHash:string;
}
export interface WalletResearchTargets {
  token:Signal['token'];checkedAt:string;source:'local_observations';
  targets:WalletResearchTarget[];truncated:boolean;
}
const time=(v:unknown):number|undefined=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):undefined;
const nonzeroAddress=(chain:Chain,v:unknown):string|undefined=>{
  const address=chainAddress(chain,v);if(!address)return;
  return chain==='solana'?(bs58.decode(address).some(byte=>byte!==0)?address:undefined):!/^0x0+$/i.test(address)?address:undefined;
};
function hash(chain:Chain,v:unknown):string|undefined {
  if(typeof v!=='string')return;
  if(chain!=='solana')return /^0x[\da-f]{64}$/i.test(v)&&!/^0x0+$/i.test(v)?v.toLowerCase():undefined;
  try{const bytes=bs58.decode(v);return v.length<=88&&bytes.length===64&&bytes.some(byte=>byte!==0)?v:undefined;}catch{return;}
}

/** Research priority only. Fresh profiles and existing profit/precursor qualification protect the limited request budget.
 * The entry model still independently checks its cohort rank, holdings, flow, risk and prices. */
export function selectWalletResearchTargets(input:{token:Signal['token'];now:Date;trades:readonly WalletTradeObservation[];
  profiles:readonly WalletProfile[];truncated?:boolean;maxTargets?:number}):WalletResearchTargets {
  const {token,now}=input,asOf=now.getTime(),ca=nonzeroAddress(token.chain,token.address);
  if(!Number.isFinite(asOf)||!ca)throw new Error('WALLET_TARGET_INPUT_INVALID');
  const result:WalletResearchTargets={token:{...token,address:ca},checkedAt:now.toISOString(),source:'local_observations',targets:[],
    truncated:input.truncated===true||input.trades.length>500||input.profiles.length>200};
  const limit=Number.isSafeInteger(input.maxTargets)?Math.max(1,Math.min(6,input.maxTargets!)):6;
  const profiles=new Map<string,WalletProfile>();
  for(const p of input.profiles.slice(0,200)){
    const a=nonzeroAddress(token.chain,p?.address),computed=time(p?.computedAt),fresh=time(p?.freshUntil);
    if(p?.version===1&&p.chain===token.chain&&a&&computed!==undefined&&computed<=asOf&&fresh!==undefined&&fresh>asOf&&p.status!=='stale')profiles.set(a,p);
  }
  const publicWallet=(p:WalletProfile|undefined)=>{
    const profit=p?.metrics.vendorProfit,snapshot=time(profit?.snapshotAt),observed=time(profit?.observedAt);
    return p?.groups.some(g=>g.id==='public_kol'&&time(g.firstObservedAt)!==undefined&&time(g.firstObservedAt)!<=asOf)===true&&
      profit?.verification==='vendor_claim'&&profit.period==='7d'&&typeof profit.realizedProfitUsd==='string'&&/^\d+(?:\.\d+)?$/.test(profit.realizedProfitUsd)&&
      Number.isFinite(Number(profit.realizedProfitUsd))&&Number(profit.realizedProfitUsd)>=1000&&snapshot!==undefined&&observed!==undefined&&
      snapshot<=observed&&observed<=time(p!.computedAt)!&&asOf-snapshot<=86400000;
  };
  const events=new Map<string,WalletTradeObservation[]>();
  for(const row of input.trades.slice(0,500)){
    const wallet=nonzeroAddress(token.chain,row?.wallet),tx=hash(token.chain,row?.txHash),at=time(row?.eventAt),observed=time(row?.observedAt);
    if(row?.chain!==token.chain||nonzeroAddress(token.chain,row.tokenAddress)!==ca||!wallet||!tx||at===undefined||observed===undefined||
      at>observed||observed>asOf||asOf-at>600000||typeof row.source!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(row.source)||
      !['buy','sell','transferOut'].includes(row.side))continue;
    const key=wallet+':'+tx,group=events.get(key)??[];
    group.push({...row,wallet,txHash:tx,eventAt:new Date(at).toISOString(),observedAt:new Date(observed).toISOString()});events.set(key,group);
  }
  const buys:WalletTradeObservation[]=[];
  for(const group of events.values()){
    if(group.some(row=>row.side!==group[0].side||row.eventAt!==group[0].eventAt))continue;
    // Conflicting copies cannot nominate a wallet; a more recent independent buy still can.
    if(group[0].side==='buy')buys.push(group.sort((a,b)=>a.observedAt.localeCompare(b.observedAt))[0]);
  }
  buys.sort((a,b)=>b.eventAt.localeCompare(a.eventAt)||a.wallet.localeCompare(b.wallet));
  const candidates:{targets:WalletResearchTarget[];score:number;eventAt:string}[]=[];
  for(const buy of buys){
    const p=profiles.get(buy.wallet);if(!p)continue;
    const roleAt=time(p.roleAnalysis?.computedAt),peers=roleAt!==undefined&&roleAt<=time(p.computedAt)!
      ?(p.roleAnalysis?.peers??[]).filter(peer=>peer.classification==='precursor_pattern'&&publicWallet(profiles.get(peer.address))&&
        time(peer.qualification?.knownAt)!<time(buy.eventAt)!&&time(peer.qualification?.knownAt)!<=roleAt&&
        qualifiedRoleEvidence(peer.qualification,token.chain,buy.wallet,peer.address,now.toISOString())&&
        new Set(peer.qualification?.evidence.filter(e=>e.direction==='lead'&&e.tokenAddress!==ca).map(e=>e.tokenAddress)).size>=3).slice(0,4):[];
    const direct=publicWallet(p);if(!direct&&!peers.length)continue;
    const target=(address:string,reason:WalletResearchTarget['reason']):WalletResearchTarget=>({address,reason,triggerWallet:buy.wallet,
      eventAt:buy.eventAt,observedAt:buy.observedAt,txHash:buy.txHash});
    candidates.push({targets:[target(buy.wallet,'profiled_buy'),...peers.map(peer=>target(peer.address,'precursor_leader'))],
      score:peers.length?30:20,eventAt:buy.eventAt});
  }
  candidates.sort((a,b)=>b.score-a.score||b.eventAt.localeCompare(a.eventAt)||a.targets[0].address.localeCompare(b.targets[0].address));
  const seen=new Set<string>();for(const target of candidates.flatMap(row=>row.targets)){
    if(seen.has(target.address))continue;seen.add(target.address);
    if(result.targets.length<limit)result.targets.push(target);else result.truncated=true;
  }
  return result;
}

export interface TargetTokenBalance {
  status:'confirmed'|'unknown';balance:string|null;currentlyHolding:boolean|null;reason:string;
}
/**
 * Official source verified 2026-10-14 at GMGNAI/gmgn-skills SHA 4575ef539e6a3115fa0481d41285cb79e77970bf:
 * https://github.com/GMGNAI/gmgn-skills/blob/4575ef539e6a3115fa0481d41285cb79e77970bf/src/client/OpenApiClient.ts
 * https://github.com/GMGNAI/gmgn-skills/blob/4575ef539e6a3115fa0481d41285cb79e77970bf/skills/gmgn-portfolio/SKILL.md
 * GET /v1/user/wallet_token_balance: API-key-only, chain + wallet_address + token_address, weight 2, no pagination.
 * A read-only public-wallet response confirmed balances:[{wallet_address,token_address,balance,decimal,height,tx_index}].
 * Balance units are not specified by that reference. Only zero versus positive is used; no unit/USD inference.
 * This is different from signed/paginated /wallet_holdings, where a missing row cannot imply zero.
 */
export function parseTargetTokenBalance(value:unknown,token:Signal['token'],wallet:string):TargetTokenBalance {
  const unknown=(reason='GMGN_TARGET_BALANCE_UNVERIFIED'):TargetTokenBalance=>({status:'unknown',balance:null,currentlyHolding:null,reason});
  const ca=nonzeroAddress(token.chain,token.address),who=nonzeroAddress(token.chain,wallet);
  if(!ca||!who||!object(value)||value.success===false||value.code!==undefined&&value.code!==0)return unknown();
  const body=object(value.data)?value.data:value;
  const matchesChain=(v:unknown)=>v===undefined||v===token.chain||token.chain==='solana'&&v==='sol';
  if(body.success===false||body.code!==undefined&&body.code!==0)return unknown();
  for(const envelope of [value,body])if(!matchesChain(envelope.chain)||
    envelope.wallet_address!==undefined&&nonzeroAddress(token.chain,envelope.wallet_address)!==who||
    envelope.token_address!==undefined&&nonzeroAddress(token.chain,envelope.token_address)!==ca)return unknown('GMGN_TARGET_BALANCE_SCOPE_MISMATCH');
  if(!Array.isArray(body.balances)||body.balances.length!==1||!object(body.balances[0]))return unknown();
  const row=body.balances[0];
  if(!matchesChain(row.chain)||nonzeroAddress(token.chain,row.wallet_address)!==who||nonzeroAddress(token.chain,row.token_address)!==ca)
    return unknown('GMGN_TARGET_BALANCE_SCOPE_MISMATCH');
  if(typeof row.balance!=='string'||row.balance.length>100||!/^\d+(?:\.\d+)?$/.test(row.balance))return unknown();
  return {status:'confirmed',balance:row.balance,currentlyHolding:/[1-9]/.test(row.balance),reason:'GMGN_TARGET_TOKEN_BALANCE_CONFIRMED'};
}
