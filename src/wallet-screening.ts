import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import type {Chain,Signal} from './types.js';
import type {WalletTradeObservation} from './wallet-history.js';
import type {WalletProfile} from './wallet-profiles.js';
import type {WalletAnalysis,WalletRecord} from './research/wallet-types.js';
import type {GmgnTokenSnapshot} from './providers/gmgn-safety.js';
import {qualifiedRoleEvidence,type WalletRolePeerAnalysis} from './wallet-role-analysis.js';

export interface WalletScreeningInput {
  token:Signal['token'];now:string;trades:WalletTradeObservation[];profiles:WalletProfile[];
  wallets?:WalletAnalysis;snapshot?:GmgnTokenSnapshot;
  /** Fresh positive 7-day vendor profit values from the same chain, one per wallet. */
  profitCohort:number[];truncated?:boolean;
}
export interface WalletSetup {
  id:string;route:'precursor'|'public_entry';wallet:string;leader:string;trigger:WalletTradeObservation;
  status:'supported'|'watch'|'withdrawn';stage:'awaiting_public_entry'|'public_entry_observed'|'direct_entry';
  priorityScore:number;reasons:string[];counterEvidence:string[];
  /** Percentile is 0..100, with tied values assigned their midpoint rank. */
  profit?:{realizedProfitUsd:number;percentile:number;cohortSize:number;observedAt:string;verification:'vendor_claim'};
  profileComputedAt?:string;relationKnownAt?:string;chasePct?:number;followers:number;ownership:'unknown';
}
export interface WalletScreeningReport {
  version:1;token:Signal['token'];checkedAt:string;validUntil:string;status:'supported'|'watch'|'unavailable';
  priorityScore:number;scope:'research_priority';ownership:'unknown';sampleOnly:true;setups:WalletSetup[];reasons:string[];
}

const WINDOW=600_000,FRESH=120_000,DAY=86_400_000,MAX_TRADES=2000,MAX_PROFILES=400;
const RISK=new Set(['bundler','rat_trader','developer','exchange_or_pool']);
const time=(value:unknown):number|undefined=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):undefined;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function address(chain:Chain,value:unknown,hash=false):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return new RegExp(`^0x[0-9a-fA-F]{${hash?64:40}}$`).test(value)&&!/^0x0+$/i.test(value)?value.toLowerCase():undefined;
  try {const bytes=bs58.decode(value);return value.length<=88&&bytes.length===(hash?64:32)&&bytes.some(v=>v!==0)?value:undefined;}catch{return;}
}
function decimal(value:unknown):number|undefined {
  if(typeof value!=='string'||value.length>100||!/^\d+(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(value))return;
  const n=Number(value);return Number.isFinite(n)&&n>=0&&n<=1e12?n:undefined;
}
/** A low-qualification wallet's negative observation must not veto another entry route. */
export function qualifiedWalletWithdrawal(setup:WalletSetup):boolean {
  const profit=setup.profit;
  return setup.status==='withdrawn'&&!!profit&&profit.verification==='vendor_claim'&&Number.isFinite(profit.realizedProfitUsd)&&profit.realizedProfitUsd>=1000&&
    Number.isFinite(profit.percentile)&&profit.percentile>=75&&profit.percentile<=100&&Number.isSafeInteger(profit.cohortSize)&&profit.cohortSize>=10&&
    (decimal(setup.trigger.usd)??0)>=100&&!setup.reasons.some(reason=>[
      'WALLET_PROFILE_MISSING_OR_STALE','PUBLIC_WALLET_LABEL_UNVERIFIED','PRECURSOR_RELATION_NOT_KNOWN_BEFORE_BUY','PRECURSOR_PRIOR_LEAD_EVIDENCE_INSUFFICIENT',
    ].includes(reason));
}
const recent=(value:unknown,now:number,window=FRESH):boolean=>{const n=time(value);return n!==undefined&&n<=now&&now-n<=window;};
function validProfile(profile:WalletProfile|undefined,chain:Chain,wallet:string,now:number):profile is WalletProfile {
  return !!profile&&profile.version===1&&profile.chain===chain&&address(chain,profile.address)===wallet&&profile.status!=='stale'&&
    time(profile.computedAt)!==undefined&&time(profile.computedAt)!<=now&&time(profile.freshUntil)!==undefined&&time(profile.freshUntil)!>now;
}
function isPublic(profile:WalletProfile|undefined,now:number):boolean {
  return !!profile?.groups?.some(g=>g.id==='public_kol'&&time(g.firstObservedAt)!==undefined&&time(g.firstObservedAt)!<=now);
}
function safeRecord(wallet:WalletRecord|undefined):boolean {
  return !!wallet&&!wallet.risks.length&&!wallet.developerLinks.length&&!wallet.funding.conflict&&!wallet.recognizedLabels.some(t=>RISK.has(t));
}
interface Normalized {trades:WalletTradeObservation[];conflicts:Map<string,number>;conflictedBuys:WalletTradeObservation[];rejected:boolean;truncated:boolean;}
function normalize(input:WalletScreeningInput,now:number,target:string):Normalized {
  const groups=new Map<string,WalletTradeObservation[]>(),result:Normalized={trades:[],conflicts:new Map(),conflictedBuys:[],rejected:false,truncated:!!input.truncated||input.trades.length>MAX_TRADES};
  for(const raw of input.trades.slice(0,MAX_TRADES)){
    const who=address(input.token.chain,raw.wallet),txHash=address(input.token.chain,raw.txHash,true),eventAt=time(raw.eventAt),observedAt=time(raw.observedAt);
    if(raw.chain!==input.token.chain||address(raw.chain,raw.tokenAddress)!==target||!who||!txHash||eventAt===undefined||observedAt===undefined||
      eventAt>observedAt||observedAt>now||!['buy','sell','transferOut'].includes(raw.side)||
      typeof raw.source!=='string'||!/^[a-z][a-z0-9_.:-]{0,79}$/.test(raw.source)||
      raw.eventIndex!==undefined&&(!Number.isSafeInteger(raw.eventIndex)||raw.eventIndex<0)) {result.rejected=true;continue;}
    const event={...raw,wallet:who,tokenAddress:target,txHash,eventAt:new Date(eventAt).toISOString(),observedAt:new Date(observedAt).toISOString()};
    const key=who+':'+txHash,group=groups.get(key)??[];group.push(event);groups.set(key,group);
  }
  for(const group of groups.values()){
    // A side or index disagreement is not several independent buys. Retain its
    // latest possible event time as counterevidence, but never choose a copy.
    const conflicts=['side','eventAt','eventIndex','amountUnit','amount','usd','priceUsd'].some(key=>{
      const values=group.map(v=>v[key as keyof WalletTradeObservation]).filter(v=>v!==undefined&&v!==null);
      return new Set(values.map(v=>['amount','usd','priceUsd'].includes(key)&&decimal(v)!==undefined?String(decimal(v)):String(v))).size>1;
    });
    if(conflicts){const wallet=group[0].wallet;result.conflicts.set(wallet,Math.max(result.conflicts.get(wallet)??0,...group.map(v=>time(v.eventAt)!)));
      // A representative conflicting claim is retained only for withdrawal.
      // All explicit buy amounts must clear the dust floor; unknown/low claims
      // cannot be turned into a high-value trigger by selecting the best copy.
      const claims=group.filter(v=>v.side==='buy'),amounts=claims.filter(v=>v.usd!==undefined&&v.usd!==null);
      if(claims.length&&amounts.length&&claims.every(v=>recent(v.eventAt,now,WINDOW))&&amounts.every(v=>(decimal(v.usd)??0)>=100)){
        const representative=[...amounts].sort((a,b)=>a.observedAt.localeCompare(b.observedAt)||a.source.localeCompare(b.source))[0];
        result.conflictedBuys.push({...representative});
      }
      continue;
    }
    group.sort((a,b)=>a.observedAt.localeCompare(b.observedAt)||a.source.localeCompare(b.source));
    const first={...group[0]};
    for(const key of ['amount','amountUnit','usd','priceUsd'] as const)if(first[key]===undefined||first[key]===null){
      const value=group.find(v=>v[key]!==undefined&&v[key]!==null)?.[key];if(value!==undefined)Object.assign(first,{[key]:value});
    }
    result.trades.push(first);
  }
  result.trades.sort((a,b)=>a.eventAt.localeCompare(b.eventAt)||a.txHash.localeCompare(b.txHash)||a.wallet.localeCompare(b.wallet));
  return result;
}
function historicalLeads(peer:WalletRolePeerAnalysis,wallet:string,chain:Chain,target:string,triggerAt:number):number {
  const tokens=new Set<string>();
  if(!qualifiedRoleEvidence(peer.qualification,chain,wallet,peer.address,new Date(triggerAt).toISOString()))return 0;
  for(const row of peer.qualification!.evidence){
    const token=address(chain,row.tokenAddress),candidate=row.candidateBuy,leader=row.leaderBuy;
    if(row.direction!=='lead'||!token||token===target||!candidate||!leader||address(chain,candidate.wallet)!==wallet||address(chain,leader.wallet)!==peer.address||
      !address(chain,candidate.txHash,true)||!address(chain,leader.txHash,true)||candidate.txHash===leader.txHash)continue;
    const times=[candidate.eventAt,candidate.observedAt,leader.eventAt,leader.observedAt].map(time);
    if(times.some(v=>v===undefined||v>=triggerAt)||times[0]!>times[1]!||times[2]!>times[3]!||times[2]!-times[0]!<=2000||times[2]!-times[0]!>DAY)continue;
    tokens.add(token);
  }
  return tokens.size;
}

/** Pure local research. No score represents a probability, identity or permission to execute. */
export function analyzeWalletScreening(input:WalletScreeningInput):WalletScreeningReport {
  const now=time(input.now),chain=input.token.chain,target=address(chain,input.token.address),stamp=new Date(now??0).toISOString();
  const report:WalletScreeningReport={version:1,token:{...input.token},checkedAt:stamp,validUntil:stamp,status:'unavailable',priorityScore:0,
    scope:'research_priority',ownership:'unknown',sampleOnly:true,setups:[],reasons:['WALLET_SCREENING_RESEARCH_PARAMETERS','WALLET_SCREENING_NOT_PROBABILITY','WALLET_SCREENING_SAMPLED_OBSERVATIONS','WALLET_SCREENING_IDENTITY_UNVERIFIED']};
  if(now===undefined||!target||!['bsc','solana','robinhood'].includes(chain)){report.reasons.push('WALLET_SCREENING_INPUT_INVALID');return report;}
  report.token.address=target;report.validUntil=new Date(now+60_000).toISOString();
  const normalized=normalize(input,now,target),profiles=new Map<string,WalletProfile>();
  for(const profile of input.profiles.slice(0,MAX_PROFILES)){
    const who=address(chain,profile.address);if(profile.chain!==chain||!who)continue;
    const old=profiles.get(who);if(!old||profile.computedAt>old.computedAt)profiles.set(who,profile);
  }
  const truncated=normalized.truncated||input.profiles.length>MAX_PROFILES;
  if(truncated)report.reasons.push('WALLET_SCREENING_TRUNCATED');
  if(normalized.rejected)report.reasons.push('WALLET_SCREENING_INVALID_EVENTS_EXCLUDED');
  if(normalized.conflicts.size)report.reasons.push('WALLET_SCREENING_CONFLICTING_EVENTS_EXCLUDED');
  const buys=normalized.trades.filter(t=>t.side==='buy'&&recent(t.eventAt,now,WINDOW));
  if(!buys.length&&!normalized.conflictedBuys.length){report.reasons.push('WALLET_SCREENING_NO_RECENT_BUY');return report;}
  const analysis=input.wallets,analysisOk=!!analysis&&analysis.status==='pass'&&analysis.summary.token.chain===chain&&
    address(chain,analysis.summary.token.address)===target&&recent(analysis.checkedAt,now);
  const rows=new Map<string,WalletRecord>();
  if(analysisOk)for(const row of analysis!.wallets){const who=address(chain,row.address);if(row.chain===chain&&who)rows.set(who,row);}
  const cohort=input.profitCohort.filter(v=>Number.isFinite(v)&&v>0&&v<=1e12);
  function profitFor(profile:WalletProfile|undefined):WalletSetup['profit'] {
    const profit=profile?.metrics.vendorProfit,value=decimal(profit?.realizedProfitUsd);
    if(!profit||value===undefined||value<=0||profit.period!=='7d'||profit.verification!=='vendor_claim'||!recent(profit.snapshotAt,now!,DAY)||
      time(profile?.computedAt)===undefined||time(profit.observedAt)===undefined||time(profit.observedAt)!>now!||time(profit.observedAt)!>time(profile!.computedAt)!||time(profit.snapshotAt)!>time(profit.observedAt)!)return;
    const percentile=cohort.length?100*(cohort.filter(n=>n<value).length+cohort.filter(n=>n===value).length/2)/cohort.length:0;
    return {realizedProfitUsd:value,percentile,cohortSize:cohort.length,observedAt:profit.observedAt,verification:'vendor_claim'};
  }
  const snapshot=input.snapshot,info=snapshot?.info;
  const currentPrice=snapshot&&snapshot.token.chain===chain&&address(chain,snapshot.token.address)===target&&recent(snapshot.fetchedAt,now)&&
    snapshot.diagnostics.some(d=>d.section==='info'&&d.status==='ok')&&!snapshot.diagnostics.some(d=>d.section==='info'&&d.status==='unavailable')&&
    object(info)&&address(chain,info.address)===target&&(!Object.hasOwn(info,'chain')||info.chain===(chain==='solana'?'sol':chain))&&object(info.price)?decimal(info.price.price):undefined;
  const deadlines:number[]=[];
  const latestBuy=new Map<string,WalletTradeObservation>();
  // One setup per wallet / public counterparty. Repeated buys do not inflate support.
  for(const buy of buys)if(!latestBuy.has(buy.wallet))latestBuy.set(buy.wallet,buy);
  function followerGroups(trigger:WalletTradeObservation):number {
    const after=normalized.trades.filter(t=>t.side==='buy'&&t.wallet!==trigger.wallet&&t.txHash!==trigger.txHash&&
      time(t.eventAt)!>time(trigger.eventAt)!+2000&&(decimal(t.usd)??0)>=100);
    const addresses=[...new Set(after.map(t=>t.wallet))],parent=new Map<string,string>();
    const root=(who:string):string=>{const p=parent.get(who);if(!p||p===who){parent.set(who,who);return who;}const r=root(p);parent.set(who,r);return r;};
    const join=(a:string,b:string)=>{parent.set(root(a),root(b));};
    const triggerRow=rows.get(trigger.wallet),included:string[]=[];
    for(const who of addresses){
      if(normalized.conflicts.has(who))continue;
      const row=rows.get(who);if(!row||!safeRecord(row)||row.holding.currentlyHolding!==true)continue;
      if(normalized.trades.some(t=>t.wallet===who&&['sell','transferOut'].includes(t.side)&&recent(t.eventAt,now!,WINDOW))||
        recent(row.cumulative.exitedAt,now!,WINDOW)||row.enrichment.activity?.events.some(e=>['sell','transferOut'].includes(e.type)&&
          !!address(chain,e.txHash,true)&&recent(e.timestamp,now!,WINDOW)&&time(e.timestamp)!<=time(analysis!.checkedAt)!))continue;
      if(row&&triggerRow&&(row.clusterId&&row.clusterId===triggerRow.clusterId||
        row.funding.address&&row.funding.address===triggerRow.funding.address&&!row.funding.sharedService&&!triggerRow.funding.sharedService||
        row.funding.address===trigger.wallet||triggerRow.funding.address===who))continue;
      included.push(who);root(who);
    }
    const clusters=new Map<string,string>(),funders=new Map<string,string>(),members=new Set(included);
    for(const who of included){const row=rows.get(who);if(!row)continue;
      if(row.clusterId){const other=clusters.get(row.clusterId);if(other)join(who,other);else clusters.set(row.clusterId,who);}
      const funder=address(chain,row.funding.address);if(funder&&!row.funding.sharedService){
        const other=funders.get(funder);if(other)join(who,other);else funders.set(funder,who);
        if(members.has(funder))join(who,funder);
      }
    }
    return new Set(included.map(root)).size;
  }
  function make(trigger:WalletTradeObservation,route:WalletSetup['route'],leader:string,peer?:WalletRolePeerAnalysis){
    const profile=profiles.get(trigger.wallet),leaderProfile=profiles.get(leader),triggerAt=time(trigger.eventAt)!;
    const setup:WalletSetup={id:createHash('sha256').update(JSON.stringify([chain,target,route,trigger.wallet,leader,trigger.txHash])).digest('hex'),
      route,wallet:trigger.wallet,leader,trigger:{...trigger},status:'watch',stage:route==='public_entry'?'direct_entry':'awaiting_public_entry',
      priorityScore:2,reasons:[],counterEvidence:['WALLET_SCREENING_COVERAGE_NOT_COMPLETE','WALLET_SCREENING_FOLLOWERS_NOT_INDEPENDENCE_PROOF'],followers:0,ownership:'unknown',
      ...(profile?{profileComputedAt:profile.computedAt}:{})};
    let blocked=false;const stop=(code:string)=>{setup.reasons.push(code);blocked=true;};
    const triggerUsd=decimal(trigger.usd),dust=triggerUsd===undefined||triggerUsd<100;
    if(dust)stop('WALLET_TRIGGER_BUY_TOO_SMALL_OR_UNKNOWN');
    if(truncated)stop('WALLET_SCREENING_TRUNCATED');
    if(!validProfile(profile,chain,trigger.wallet,now!)||!validProfile(leaderProfile,chain,leader,now!))stop('WALLET_PROFILE_MISSING_OR_STALE');
    if(!isPublic(leaderProfile,now!))stop('PUBLIC_WALLET_LABEL_UNVERIFIED');
    const profit=profitFor(leaderProfile);
    if(profit){
      setup.profit=profit;
      if(cohort.length<10)stop('PUBLIC_WALLET_PROFIT_COHORT_INSUFFICIENT');
      else if(profit.realizedProfitUsd<1000||profit.percentile<75)stop('PUBLIC_WALLET_PROFIT_BELOW_RESEARCH_THRESHOLD');
      else {setup.reasons.push('PUBLIC_WALLET_PROFIT_TOP_QUARTILE');setup.priorityScore+=4;}
    }else stop('PUBLIC_WALLET_PROFIT_MISSING_OR_STALE');
    if(route==='precursor'){
      const role=profile?.roleAnalysis,roleAt=time(role?.computedAt),profileAt=time(profile?.computedAt),knownAt=time(peer?.qualification?.knownAt);
      if(!peer||peer.classification!=='precursor_pattern'||roleAt===undefined||profileAt===undefined||roleAt>profileAt||
        knownAt===undefined||knownAt>=triggerAt||knownAt>roleAt)
        stop('PRECURSOR_RELATION_NOT_KNOWN_BEFORE_BUY');
      else {setup.relationKnownAt=peer.qualification!.knownAt;
        if(historicalLeads(peer,trigger.wallet,chain,target!,triggerAt)<3)stop('PRECURSOR_PRIOR_LEAD_EVIDENCE_INSUFFICIENT');
        else {setup.reasons.push('PRECURSOR_PRIOR_PATTERN_SUPPORTED');setup.priorityScore+=4;}}
      if(peer){
        if(peer.directionalTokens.follow>0)setup.counterEvidence.push('PRECURSOR_HISTORICAL_FOLLOW_COUNTEREXAMPLES');
        if(peer.directionalTokens.ambiguous+peer.directionalTokens.outsideWindow>0)setup.counterEvidence.push('PRECURSOR_HISTORICAL_AMBIGUOUS_COUNTEREXAMPLES');
        if(peer.directionalTokens.unmatched>0)setup.counterEvidence.push('PRECURSOR_UNMATCHED_NOT_PREDICTION_FAILURES');
      }
      const leaderBuys=normalized.trades.filter(t=>t.wallet===leader&&t.side==='buy');
      if(leaderBuys.some(t=>time(t.eventAt)!>triggerAt+2000)){setup.stage='public_entry_observed';setup.reasons.push('PUBLIC_WALLET_LATER_BUY_OBSERVED');}
      if(leaderBuys.some(t=>time(t.eventAt)!<=triggerAt+2000))stop('PUBLIC_WALLET_ALREADY_ENTERED_OR_ORDER_UNCLEAR');
      if(!leaderBuys.length)setup.reasons.push('PUBLIC_WALLET_ENTRY_NOT_YET_OBSERVED');
    }else {
      setup.followers=followerGroups(trigger);
      if(setup.followers<2)stop('PUBLIC_ENTRY_FOLLOW_BUYS_INSUFFICIENT');
      else {setup.reasons.push('PUBLIC_ENTRY_FOLLOW_BUYS_OBSERVED');setup.priorityScore+=4;}
    }
    const row=rows.get(trigger.wallet);
    if(!analysisOk||!row)stop('WALLET_CURRENT_HOLDING_COVERAGE_MISSING');
    else if(!safeRecord(row))stop('WALLET_RISK_OR_DEVELOPER_LINK');
    else {
      const activity=row.enrichment.activity,recentActivity=activity?.recent;
      const until=time(recentActivity?.until),since=time(recentActivity?.since),net=decimal(recentActivity?.netBuyUsd);
      if(row.holding.currentlyHolding!==true||row.enrichment.status!=='complete'||!recentActivity||recentActivity.coverage==='partial'||
        !['vendor_exhausted_feed','vendor_window_covered'].includes(recentActivity.coverage)||until===undefined||since===undefined||
        since>triggerAt||until<triggerAt||until>time(analysis!.checkedAt)!||!recent(recentActivity.until,now!)||recentActivity.hasAccumulation!==true||net===undefined||net<=0)
        stop('WALLET_RECENT_ACCUMULATION_UNVERIFIED');
      else {setup.reasons.push('WALLET_CURRENT_ACCUMULATION_SUPPORTED');setup.priorityScore+=4;}
      if(row.cumulative.exitedAt&&time(row.cumulative.exitedAt)!>=triggerAt&&time(row.cumulative.exitedAt)!<=now!){setup.status='withdrawn';setup.counterEvidence.push('WALLET_EXIT_SNAPSHOT_AFTER_TRIGGER');}
    }
    const triggerPrice=decimal(trigger.priceUsd);
    if(currentPrice===undefined||currentPrice<=0||triggerPrice===undefined||triggerPrice<=0)stop('WALLET_ENTRY_PRICE_COVERAGE_MISSING');
    else {const chase=(currentPrice/triggerPrice-1)*100;
      if(!Number.isFinite(chase))stop('WALLET_ENTRY_PRICE_COVERAGE_MISSING');
      else {setup.chasePct=chase;
        if(chase>40+1e-9)stop('WALLET_ENTRY_CHASE_TOO_HIGH');
        else if(chase< -20-1e-9)stop('WALLET_ENTRY_PRICE_DROPPED');
        else {setup.reasons.push('WALLET_ENTRY_PRICE_WITHIN_RESEARCH_GUARD');setup.priorityScore+=4;}}
    }
    for(const who of new Set([trigger.wallet,leader])){
      if((normalized.conflicts.get(who)??-Infinity)>=triggerAt){setup.status='withdrawn';setup.counterEvidence.push(who===trigger.wallet?'WALLET_EVENT_CONFLICT_AFTER_TRIGGER':'PUBLIC_WALLET_EVENT_CONFLICT_AFTER_TRIGGER');}
      if(normalized.trades.some(t=>t.wallet===who&&['sell','transferOut'].includes(t.side)&&time(t.eventAt)!>=triggerAt)){
        setup.status='withdrawn';setup.counterEvidence.push(who===trigger.wallet?'WALLET_SELL_OR_TRANSFER_AFTER_TRIGGER':'PUBLIC_WALLET_SELL_OR_TRANSFER_AFTER_TRIGGER');}
      const current=rows.get(who);if(current&&(!safeRecord(current)||current.holding.currentlyHolding===false)){
        if(!safeRecord(current))stop(who===trigger.wallet?'WALLET_RISK_OR_DEVELOPER_LINK':'PUBLIC_WALLET_RISK_OR_DEVELOPER_LINK');
        if(current.holding.currentlyHolding===false&&(who===trigger.wallet||setup.stage==='public_entry_observed')){setup.status='withdrawn';setup.counterEvidence.push(who===trigger.wallet?'WALLET_CURRENT_POSITION_EMPTY':'PUBLIC_WALLET_CURRENT_POSITION_EMPTY');}
      }
      if(current?.enrichment.activity?.events.some(e=>['sell','transferOut'].includes(e.type)&&!!address(chain,e.txHash,true)&&
        time(e.timestamp)!>=triggerAt&&time(e.timestamp)!<=time(analysis!.checkedAt)!)){
        setup.status='withdrawn';setup.counterEvidence.push(who===trigger.wallet?'WALLET_SELL_OR_TRANSFER_AFTER_TRIGGER':'PUBLIC_WALLET_SELL_OR_TRANSFER_AFTER_TRIGGER');
      }
    }
    if(setup.status==='withdrawn'){setup.priorityScore=0;setup.reasons.push('WALLET_SETUP_WITHDRAWN');}
    else if(!blocked){setup.status='supported';setup.priorityScore=Math.min(20,setup.priorityScore);
      deadlines.push(triggerAt+WINDOW,time(profile!.freshUntil)!,time(leaderProfile!.freshUntil)!,time(analysis!.checkedAt)!+FRESH,
        time(snapshot!.fetchedAt)!+FRESH,time(leaderProfile!.metrics.vendorProfit!.snapshotAt)!+DAY);
    }else setup.priorityScore=dust?0:Math.min(12,setup.priorityScore);
    setup.reasons=[...new Set(setup.reasons)];setup.counterEvidence=[...new Set(setup.counterEvidence)];report.setups.push(setup);
  }
  for(const trigger of latestBuy.values()){
    const profile=profiles.get(trigger.wallet);if(!profile)continue;
    if(isPublic(profile,now))make(trigger,'public_entry',trigger.wallet);
    for(const peer of (profile.roleAnalysis?.peers??[]).slice(0,4)){
      const leader=address(chain,peer.address);if(peer.classification==='precursor_pattern'&&leader&&leader!==trigger.wallet)make(trigger,'precursor',leader,peer);
    }
  }
  for(const trigger of normalized.conflictedBuys){
    const profile=profiles.get(trigger.wallet);if(!validProfile(profile,chain,trigger.wallet,now))continue;
    const routes:{route:WalletSetup['route'];leader:string;peer?:WalletRolePeerAnalysis}[]=[];
    if(isPublic(profile,now))routes.push({route:'public_entry',leader:trigger.wallet});
    for(const peer of (profile.roleAnalysis?.peers??[]).slice(0,4)){
      const leader=address(chain,peer.address),at=time(trigger.eventAt)!;
      const roleAt=time(profile.roleAnalysis?.computedAt),knownAt=time(peer.qualification?.knownAt);
      if(peer.classification!=='precursor_pattern'||!leader||leader===trigger.wallet||roleAt===undefined||roleAt>time(profile.computedAt)!||
        knownAt===undefined||knownAt>=at||knownAt>roleAt||historicalLeads(peer,trigger.wallet,chain,target,at)<3)continue;
      routes.push({route:'precursor',leader,peer});
    }
    for(const {route,leader,peer} of routes){
      const leaderProfile=profiles.get(leader),profit=profitFor(leaderProfile);
      if(!validProfile(leaderProfile,chain,leader,now)||!isPublic(leaderProfile,now)||!profit||profit.cohortSize<10||profit.percentile<75||profit.realizedProfitUsd<1000)continue;
      const id=createHash('sha256').update(JSON.stringify([chain,target,route,trigger.wallet,leader,trigger.txHash])).digest('hex');
      if(report.setups.some(s=>s.id===id))continue;
      report.setups.push({id,route,wallet:trigger.wallet,leader,trigger:{...trigger},status:'withdrawn',
        stage:route==='public_entry'?'direct_entry':'awaiting_public_entry',priorityScore:0,followers:0,ownership:'unknown',profit,
        profileComputedAt:profile.computedAt,...(peer?{relationKnownAt:peer.qualification!.knownAt}:{}),
        reasons:['WALLET_TRIGGER_BUY_CONFLICT','WALLET_SETUP_WITHDRAWN'],
        counterEvidence:['WALLET_TRIGGER_BUY_CONFLICT','WALLET_SCREENING_COVERAGE_NOT_COMPLETE']});
      deadlines.push(time(trigger.eventAt)!+WINDOW,time(profile.freshUntil)!,time(leaderProfile.freshUntil)!,time(leaderProfile.metrics.vendorProfit!.snapshotAt)!+DAY);
    }
  }
  // The display bound must not drop relevant withdrawals behind many watch
  // rows and accidentally remove a veto from the entry engine.
  const tier=(s:WalletSetup)=>s.status==='supported'?0:qualifiedWalletWithdrawal(s)?1:s.status==='watch'?2:3;
  report.setups.sort((a,b)=>tier(a)-tier(b)||b.priorityScore-a.priorityScore||a.id.localeCompare(b.id));
  if(report.setups.length>8)report.reasons.push('WALLET_SCREENING_SETUPS_TRUNCATED');
  report.setups=report.setups.slice(0,8);
  report.status=report.setups.some(s=>s.status==='supported')?'supported':report.setups.length?'watch':'unavailable';
  report.priorityScore=report.setups.reduce((n,s)=>Math.max(n,s.priorityScore),0);
  if(!report.setups.length)report.reasons.push('WALLET_SCREENING_NO_MATCHING_PROFILE');
  if(deadlines.length)report.validUntil=new Date(Math.max(now,Math.min(now+60_000,...deadlines))).toISOString();
  return report;
}

export const assessWalletScreening=analyzeWalletScreening;
