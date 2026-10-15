import bs58 from 'bs58';
import {chainAddress} from './chain-stream-store.js';
import type {Signal} from './types.js';
import type {DebotWalletDetails,DebotVendorWalletDetail} from './providers/debot-signals.js';
import type {FollowupWalletEvidence,WalletHistory} from './wallet-history.js';
import type {WalletResearchTarget,WalletResearchTargets} from './research/wallet-targets.js';

/** The caller binds the response to the actual request or persisted inbox row, never a display label. */
export type DebotScopedWalletDetails=DebotWalletDetails&{token?:Signal['token']};
export interface DebotRepeatEvidenceInput {
  token:Signal['token'];previousDetails?:DebotScopedWalletDetails;details?:DebotScopedWalletDetails;
  since:string;now:Date;history?:Pick<WalletHistory,'followupEvidence'>;walletTargets?:WalletResearchTargets;
}
export interface DebotRepeatVendorChange {
  address:string;kind:'new_address'|'last_trade_at'|'buy_amount'|'hold_amount';
  source:'debot';verification:'vendor_changed';observedAt:string;previousObservedAt?:string;
  eventAt?:string;previousValue?:string;value?:string;
}
export interface DebotRepeatEvidence {
  material:boolean;priority:'normal'|'wallet'|'risk';reasons:string[];
  evidence:{
    chain?:Signal['token']['chain'];address?:string;fromAt:string;untilAt:string;
    status:'changed'|'unchanged'|'unavailable';coverage:'sampled'|'truncated'|'unavailable';
    vendorChanges:DebotRepeatVendorChange[];
    observedTrades:(FollowupWalletEvidence['trades'][number]&{verification:'observed_trade'})[];
    researchTargets:(WalletResearchTarget&{source:'local_observations';verification:'research_priority'})[];
    limitations:string[];
  };
}
const MAX_AGE_MS=120_000;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function time(v:unknown):number|undefined {
  if(typeof v!=='string'||v.length>40||!/^\d{4}-\d\d-\d\dT/.test(v))return;
  const result=Date.parse(v);return Number.isFinite(result)?result:undefined;
}
function address(chain:Signal['token']['chain'],value:unknown):string|undefined {
  const result=chainAddress(chain,value);if(!result)return;
  return chain==='solana'?(bs58.decode(result).some(byte=>byte!==0)?result:undefined):!/^0x0+$/.test(result)?result:undefined;
}
function transaction(chain:Signal['token']['chain'],value:unknown):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[\da-f]{64}$/i.test(value)&&!/^0x0+$/i.test(value)?value.toLowerCase():undefined;
  try {const bytes=bs58.decode(value);return value.length<=88&&bytes.length===64&&bytes.some(byte=>byte!==0)?value:undefined;}catch{return;}
}
/** Exact comparison of token quantities; 1, 1.0 and 1e0 must not create different events. */
function decimal(value:unknown):string|undefined {
  if(typeof value!=='string'||value.length>100)return;
  const match=/^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);if(!match)return;
  const exponent=Number(match[3]??0)-(match[2]?.length??0);if(Math.abs(exponent)>300)return;
  let digits=(match[1]+(match[2]??'')).replace(/^0+/,'');if(!digits)return '0';
  let scale=exponent;while(digits.endsWith('0')){digits=digits.slice(0,-1);scale++;}
  if(scale>=0)return digits+'0'.repeat(scale);
  const point=digits.length+scale;return point>0?digits.slice(0,point)+'.'+digits.slice(point):'0.'+'0'.repeat(-point)+digits;
}
function compare(a:string,b:string):number {
  const [ai,af='']=a.split('.'),[bi,bf='']=b.split('.');
  if(ai.length!==bi.length)return ai.length>bi.length?1:-1;
  if(ai!==bi)return ai>bi?1:-1;
  const length=Math.max(af.length,bf.length),ap=af.padEnd(length,'0'),bp=bf.padEnd(length,'0');
  return ap===bp?0:ap>bp?1:-1;
}
function scoped(details:DebotScopedWalletDetails|undefined,token:Signal['token']):details is DebotScopedWalletDetails {
  return !!details&&details.token?.chain===token.chain&&address(token.chain,details.token?.address)===token.address&&
    Array.isArray(details.vendorWallets)&&details.vendorWallets.length<=20&&
    (details.reason===undefined||details.reason==='DEBOT_SIGNAL_RECORDS_REJECTED');
}
type Snapshot={address:string;lastTradeAt?:string;buyAmount?:string;holdAmount?:string};
function snapshots(details:DebotScopedWalletDetails,token:Signal['token'],at:number):{rows:Map<string,Snapshot>;invalid:number} {
  const rows=new Map<string,Snapshot>(),conflicts=new Set<string>();let invalid=0;
  for(const raw of details.vendorWallets) {
    const row=raw as DebotVendorWalletDetail,who=address(token.chain,row?.address);
    if(!who||row?.source!=='debot'||row.verification!=='vendor_report'){invalid++;continue;}
    const traded=time(row.lastTradeAt);
    // A future timestamp invalidates that entry; it cannot be converted to a fresh address observation.
    if(row.lastTradeAt!==undefined&&(traded===undefined||traded>at)){invalid++;continue;}
    const snapshot:Snapshot={address:who,...(traded===undefined?{}:{lastTradeAt:new Date(traded).toISOString()}),
      ...(decimal(row.profit?.buyAmount)===undefined?{}:{buyAmount:decimal(row.profit?.buyAmount)}),
      ...(decimal(row.profit?.holdAmount)===undefined?{}:{holdAmount:decimal(row.profit?.holdAmount)})};
    const prior=rows.get(who);
    if(prior&&JSON.stringify(prior)!==JSON.stringify(snapshot))conflicts.add(who);
    else rows.set(who,snapshot);
  }
  for(const who of conflicts){rows.delete(who);invalid++;}
  return {rows,invalid};
}

/** Read-only re-research trigger. Vendor changes, sampled transactions and identity heuristics stay distinct.
 * This never grants an entry permission, raises a trading score or infers a sale from a missing row. */
export function assessDebotRepeatEvidence(input:DebotRepeatEvidenceInput):DebotRepeatEvidence {
  const now=input.now.getTime(),since=time(input.since),ca=input.token&&address(input.token.chain,input.token.address);
  const from=since===undefined||!Number.isFinite(now)?undefined:Math.max(since+1,now-MAX_AGE_MS);
  const result:DebotRepeatEvidence={material:false,priority:'normal',reasons:[],evidence:{
    fromAt:from===undefined?'':new Date(from).toISOString(),untilAt:Number.isFinite(now)?input.now.toISOString():'',
    status:'unavailable',coverage:'unavailable',vendorChanges:[],observedTrades:[],researchTargets:[],
    limitations:['RESEARCH_TRIGGER_NOT_ENTRY_PERMISSION','VENDOR_REPORTS_NOT_OWNERSHIP_PROOF','MISSING_WALLET_NOT_A_SALE']}};
  const evidence=result.evidence;
  const reason=(value:string)=>{if(!result.reasons.includes(value))result.reasons.push(value);};
  const limitation=(value:string)=>{if(!evidence.limitations.includes(value))evidence.limitations.push(value);};
  if(!ca||!Number.isFinite(now)||since===undefined||since>=now||from===undefined||from>now) {
    reason('DEBOT_REPEAT_WINDOW_INVALID');return result;
  }
  const token={chain:input.token.chain,address:ca};evidence.chain=token.chain;evidence.address=ca;
  const current=input.details,previous=input.previousDetails,at=time(current?.fetchedAt),previousAt=time(previous?.fetchedAt);
  let compared=false;
  if(!scoped(current,token))reason(current?'DEBOT_REPEAT_DETAILS_SCOPE_OR_RESPONSE_INVALID':'DEBOT_REPEAT_DETAILS_UNAVAILABLE');
  else if(at===undefined||at<from||at>now||previous!==undefined&&
    (previousAt===undefined||previousAt>=at||previousAt>now))reason('DEBOT_REPEAT_DETAILS_STALE_OR_REPLAYED');
  else if(previous!==undefined&&!scoped(previous,token))reason('DEBOT_REPEAT_BASELINE_SCOPE_OR_RESPONSE_INVALID');
  else {
    const next=snapshots(current,token,at),prior=previous?snapshots(previous,token,previousAt!):{rows:new Map<string,Snapshot>(),invalid:0};
    if(next.invalid||prior.invalid)limitation('INVALID_OR_ALIAS_ONLY_WALLETS_IGNORED');
    if(current.rejected>0||current.received>current.vendorWallets.length||previous&&
      (previous.rejected>0||previous.received>previous.vendorWallets.length))limitation('PARTIAL_VENDOR_DETAILS');
    if(next.rows.size)compared=true;else reason('DEBOT_REPEAT_ACTUAL_ADDRESSES_UNAVAILABLE');
    for(const [who,row] of next.rows) {
      const old=prior.rows.get(who);
      const add=(kind:DebotRepeatVendorChange['kind'],value?:string,previousValue?:string)=>{
        if(evidence.vendorChanges.length>=24){limitation('VENDOR_CHANGE_EXAMPLES_LIMIT_24');return;}
        evidence.vendorChanges.push({address:who,kind,source:'debot',verification:'vendor_changed',observedAt:new Date(at).toISOString(),
          ...(previousAt===undefined?{}:{previousObservedAt:new Date(previousAt).toISOString()}),
          ...(row.lastTradeAt?{eventAt:row.lastTradeAt}:{}),...(value===undefined?{}:{value}),
          ...(previousValue===undefined?{}:{previousValue})});
      };
      if(!old){add('new_address');reason('DEBOT_REPEAT_NEW_ACTUAL_WALLET_PENDING_VERIFICATION');continue;}
      const traded=time(row.lastTradeAt),oldTraded=time(old.lastTradeAt);
      if(traded!==undefined&&oldTraded!==undefined&&traded<oldTraded) {
        limitation('REPLAYED_VENDOR_WALLET_IGNORED');continue;
      }
      if(traded!==undefined&&traded>=from&&(oldTraded===undefined||traded>oldTraded)) {
        add('last_trade_at',row.lastTradeAt,old.lastTradeAt);reason('DEBOT_REPEAT_VENDOR_ACTIVITY_PENDING_VERIFICATION');
      }
      for(const [field,kind] of [['buyAmount','buy_amount'],['holdAmount','hold_amount']] as const) {
        const value=row[field],oldValue=old[field];if(value===undefined||oldValue===undefined||compare(value,oldValue)===0)continue;
        add(kind,value,oldValue);reason('DEBOT_REPEAT_VENDOR_QUANTITY_PENDING_VERIFICATION');
        if(field==='holdAmount'&&compare(value,oldValue)<0){result.priority='risk';reason('DEBOT_REPEAT_VENDOR_HOLDING_DECREASE_PENDING_VERIFICATION');}
      }
    }
  }
  let local:FollowupWalletEvidence|undefined;
  if(input.history)try{local=input.history.followupEvidence(token,evidence.fromAt,evidence.untilAt);}catch{reason('DEBOT_REPEAT_LOCAL_EVIDENCE_UNAVAILABLE');}
  if(local) {
    if(local.chain!==token.chain||address(token.chain,local.address)!==ca||time(local.fromAt)!==from||time(local.untilAt)!==now||
      !Array.isArray(local.trades)||!['sampled','truncated','unavailable'].includes(local.coverage))reason('DEBOT_REPEAT_LOCAL_EVIDENCE_SCOPE_INVALID');
    else {
      evidence.coverage=local.coverage;
      if(local.coverage==='sampled') {
        const seen=new Set<string>();
        const trades=local.trades.slice(0,40).flatMap(row=>{
          if(!object(row))return [];
          const wallet=address(token.chain,row.wallet),tx=transaction(token.chain,row.txHash),event=time(row.eventAt),observed=time(row.observedAt);
          if(!wallet||!tx||typeof row.evidenceId!=='string'||!/^[a-f\d]{64}$/.test(row.evidenceId)||
            !['buy','sell'].includes(row.side)||!Number.isFinite(row.volumeUsd)||row.volumeUsd<=0||row.volumeUsd>1e12||
            typeof row.source!=='string'||!/^[a-z][a-z0-9_.:-]{0,79}$/.test(row.source)||
            event===undefined||observed===undefined||event<from||event>observed||observed>now||observed<from) {
            limitation('INVALID_LOCAL_TRADE_IGNORED');return [];
          }
          if(seen.has(row.evidenceId))return [];seen.add(row.evidenceId);
          return [{evidenceId:row.evidenceId,txHash:tx,wallet,side:row.side,volumeUsd:row.volumeUsd,
            eventAt:new Date(event).toISOString(),observedAt:new Date(observed).toISOString(),source:row.source,verification:'observed_trade' as const}];
        });
        // Keep sell counterevidence visible even when the bounded UI preview is full.
        trades.sort((a,b)=>Number(b.side==='sell')-Number(a.side==='sell')||a.observedAt.localeCompare(b.observedAt));
        evidence.observedTrades=trades.slice(0,20);
        if(local.evidenceCount>evidence.observedTrades.length)limitation('LOCAL_TRADE_EXAMPLES_LIMITED');
        if(evidence.observedTrades.some(row=>row.side==='sell')){result.priority='risk';reason('DEBOT_REPEAT_LOCAL_SELL_OBSERVED');}
        if(evidence.observedTrades.some(row=>row.side==='buy'))reason('DEBOT_REPEAT_LOCAL_BUY_OBSERVED');
        limitation('MONITORED_WALLET_SAMPLE_NOT_WHOLE_MARKET');
      }else reason('DEBOT_REPEAT_LOCAL_EVIDENCE_'+local.coverage.toUpperCase());
    }
  }else if(!input.history)reason('DEBOT_REPEAT_LOCAL_EVIDENCE_UNAVAILABLE');
  const plan=input.walletTargets,checked=time(plan?.checkedAt);
  if(plan&&plan.token?.chain===token.chain&&address(token.chain,plan.token.address)===ca&&plan.source==='local_observations'&&
    checked!==undefined&&checked>=now-MAX_AGE_MS&&checked<=now&&Array.isArray(plan.targets)) {
    const seen=new Set<string>();
    for(const row of plan.targets.slice(0,6)) {
      const who=address(token.chain,row?.address),trigger=address(token.chain,row?.triggerWallet),tx=transaction(token.chain,row?.txHash),
        event=time(row?.eventAt),observed=time(row?.observedAt);
      if(!who||!trigger||!tx||!['profiled_buy','precursor_leader'].includes(row.reason)||event===undefined||observed===undefined||
        observed>checked||seen.has(who)||!evidence.observedTrades.some(trade=>trade.side==='buy'&&trade.wallet===trigger&&
          trade.txHash===tx&&time(trade.eventAt)===event&&time(trade.observedAt)===observed))continue;
      seen.add(who);evidence.researchTargets.push({address:who,triggerWallet:trigger,reason:row.reason,txHash:tx,
        eventAt:new Date(event).toISOString(),observedAt:new Date(observed).toISOString(),source:'local_observations',verification:'research_priority'});
    }
    if(evidence.researchTargets.length){reason('DEBOT_REPEAT_PROFILED_WALLET_RESEARCH_PRIORITY');limitation('PROFILE_RELATION_NOT_OWNERSHIP_PROOF');}
    if(plan.truncated)limitation('RESEARCH_TARGETS_PARTIAL');
  }
  result.material=evidence.vendorChanges.length>0||evidence.observedTrades.length>0;
  if(result.material&&result.priority==='normal')result.priority='wallet';
  evidence.status=result.material?'changed':compared||evidence.coverage==='sampled'?'unchanged':'unavailable';
  if(!result.material&&evidence.status==='unchanged')reason('DEBOT_REPEAT_NO_NEW_WALLET_EVIDENCE');
  return result;
}
