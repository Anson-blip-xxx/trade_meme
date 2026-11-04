import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import type {Chain} from './types.js';
import type {
  WalletInitiatorEvidence,WalletInitiatorMarketReference,WalletInitiatorQualification,WalletInitiatorTradeReference,
} from './wallet-initiator-analysis.js';

export type WalletVisibleStartDirection='followed'|'counter'|'ambiguous'|'outsideWindow'|'unmatched';
export type WalletVisibleStartClassification='visible_start_candidate'|'insufficient';

/** A relation recorded locally before the candidate trade. The labels are inputs, not identity assertions. */
export interface WalletVisibleStartRelationReference {
  id:string;candidateWallet:string;peerWallet:string;peerClass:'public'|'independent';
  basis:'public_watchlist'|'prior_pair_history'|'independence_review';knownAt:string;source:string;conflict?:boolean;
}

export interface WalletVisibleStartFollowupInput {
  tokenAddress:string;relation:WalletVisibleStartRelationReference;peerBuy:WalletInitiatorTradeReference;
}

export interface WalletVisibleStartEvidence {
  tokenAddress:string;direction:WalletVisibleStartDirection;reason:string;
  candidateBuy:WalletInitiatorTradeReference;marketFirstSeen:WalletInitiatorMarketReference;
  relation?:WalletVisibleStartRelationReference;peerBuy?:WalletInitiatorTradeReference;
  lagSeconds?:number;localEvidenceLeadSeconds?:number;consideredFollowups:number;excludedFollowups:number;
}

export interface WalletVisibleStartQualification {
  version:1;classification:'visible_start_candidate';knownAt:string;prerequisiteKnownAt:string;
  prerequisiteProofHash:string;proofHash:string;evidence:WalletVisibleStartEvidence[];
}

export interface WalletVisibleStartAnalysis {
  version:1;chain:Chain;wallet:string;computedAt:string;status:'current'|'partial';
  classification:WalletVisibleStartClassification;sampleOnly:true;identity:'unknown';ownership:'unknown';
  profitAssessment:'not_assessed';tradingEnabled:false;
  prerequisite:{valid:boolean;knownAt?:string;proofHash?:string;prospectivePreTokens:number;matchedTokens:number;prospectivePreShare?:number};
  directionalTokens:Record<WalletVisibleStartDirection,number>;matchedTokens:number;followShare?:number;
  selectedTokens:number;rejectedFollowups:number;evidence:WalletVisibleStartEvidence[];
  screeningEvidence:WalletVisibleStartEvidence[];qualification?:WalletVisibleStartQualification;
  qualificationState:'none'|'issued'|'preserved'|'reissued'|'revoked';
  reasons:string[];counterEvidence:string[];limitations:string[];
  method:{minimumFollowTokens:3;minimumDirectionShare:0.75;nearTimeSeconds:2;maximumLagSeconds:86400;
    evidenceLimit:6;qualificationEvidenceLimit:30};
}

export interface AnalyzeWalletVisibleStartInput {
  chain:Chain;wallet:string;asOf:string;prospectiveMarketPreQualification:WalletInitiatorQualification;
  followups:readonly WalletVisibleStartFollowupInput[];previous?:WalletVisibleStartAnalysis;truncated?:boolean;
}

const DEAD_ZONE_SECONDS=2,WINDOW_SECONDS=86_400,FRAME_LIMIT=30,DISPLAY_LIMIT=6;
const DIRECTIONS:readonly WalletVisibleStartDirection[]=['followed','counter','ambiguous','outsideWindow','unmatched'];
const source=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_.:-]{0,79}$/.test(value);
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length<=240&&/^[A-Za-z0-9_.:-]+$/.test(value);
const instant=(value:unknown):number|undefined=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&
  Number.isFinite(Date.parse(value))?Date.parse(value):undefined;
const iso=(value:number)=>new Date(value).toISOString();
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function address(chain:Chain,value:unknown):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-fA-F]{40}$/.test(value)?value.toLowerCase():undefined;
  try{return value.length<=44&&bs58.decode(value).length===32?value:undefined;}catch{return;}
}

function transaction(chain:Chain,value:unknown):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-fA-F]{64}$/.test(value)?value.toLowerCase():undefined;
  try{return value.length<=88&&bs58.decode(value).length===64?value:undefined;}catch{return;}
}

function tradeReference(value:unknown,chain:Chain,wallet:string,token:string,side:'buy',asOf:number):WalletInitiatorTradeReference|undefined {
  if(!value||typeof value!=='object')return;
  const row=value as WalletInitiatorTradeReference,eventAt=instant(row.eventAt),observedAt=instant(row.observedAt),
    txHash=transaction(chain,row.txHash);
  if(row.chain!==chain||address(chain,row.wallet)!==wallet||address(chain,row.tokenAddress)!==token||!txHash||row.side!==side||
    eventAt===undefined||observedAt===undefined||eventAt>observedAt||observedAt>asOf||!source(row.source)||
    row.eventIndex!==undefined&&(!Number.isSafeInteger(row.eventIndex)||row.eventIndex<0))return;
  return {chain,wallet,tokenAddress:token,txHash,side,eventAt:iso(eventAt),observedAt:iso(observedAt),source:row.source,
    ...(row.eventIndex===undefined?{}:{eventIndex:row.eventIndex})};
}

function marketReference(value:unknown,chain:Chain,token:string,knownAt:number):WalletInitiatorMarketReference|undefined {
  if(!value||typeof value!=='object')return;
  const row=value as WalletInitiatorMarketReference,lower=instant(row.firstSeenLowerBound),upper=instant(row.firstSeenUpperBound);
  if(!identifier(row.id)||row.source!=='gmgn_market_discovery'||row.kind!=='first_seen'||row.chain!==chain||
    address(chain,row.tokenAddress)!==token||lower===undefined||upper===undefined||lower>upper||upper>knownAt||
    !['trending','trenches'].includes(row.feed)||!identifier(row.window)||row.leftCensored!==false)return;
  return {id:row.id,source:'gmgn_market_discovery',kind:'first_seen',chain,tokenAddress:token,
    firstSeenLowerBound:iso(lower),firstSeenUpperBound:iso(upper),feed:row.feed,window:row.window,leftCensored:false};
}

interface PreparedPrerequisite {
  valid:boolean;knownAt?:string;proofHash?:string;prospective:Map<string,{buy:WalletInitiatorTradeReference;market:WalletInitiatorMarketReference}>;
  prospectivePreTokens:number;matchedTokens:number;share?:number;reasons:string[];
}

function preparePrerequisite(value:WalletInitiatorQualification,chain:Chain,wallet:string,asOf:number):PreparedPrerequisite {
  const result:PreparedPrerequisite={valid:false,prospective:new Map(),prospectivePreTokens:0,matchedTokens:0,reasons:[]},
    knownAt=instant(value?.knownAt);
  if(!value||value.version!==1||value.classification!=='precursor'||knownAt===undefined||knownAt>asOf||
    !Array.isArray(value.evidence)||!value.evidence.length||value.evidence.length>FRAME_LIMIT||
    !/^[0-9a-f]{64}$/.test(value.proofHash)||value.proofHash!==digest(value.evidence)){
    result.reasons.push('prospective market-pre qualification 的版本、时间、边界或 proof hash 无效。');return result;
  }
  result.knownAt=iso(knownAt);result.proofHash=value.proofHash;
  const tokens=new Set<string>();let invalid=false;
  for(const raw of value.evidence){
    const token=address(chain,raw?.tokenAddress);
    if(!token||tokens.has(token)||!['pre','post','ambiguous','outsideWindow','unmatched'].includes(String(raw?.direction))||
      typeof raw.prospective!=='boolean'||typeof raw.reason!=='string'||raw.postActivationExit!==undefined){invalid=true;continue;}
    tokens.add(token);if(raw.direction!=='unmatched')result.matchedTokens++;
    if(raw.direction!=='pre'||!raw.prospective)continue;
    const buy=tradeReference(raw.buy,chain,wallet,token,'buy',knownAt),market=marketReference(raw.marketFirstSeen,chain,token,knownAt);
    if(!buy||!market||Date.parse(buy.eventAt)>=Date.parse(market.firstSeenLowerBound!)-DEAD_ZONE_SECONDS*1000||
      Date.parse(buy.observedAt)>=Date.parse(market.firstSeenLowerBound!)){invalid=true;continue;}
    result.prospective.set(token,{buy,market});result.prospectivePreTokens++;
  }
  result.share=result.matchedTokens?result.prospectivePreTokens/result.matchedTokens:undefined;
  if(invalid)result.reasons.push('market-pre 冻结帧含重复、冲突、非法或非前向证据。');
  if(result.prospectivePreTokens<3||result.share===undefined||result.share<0.75)
    result.reasons.push('prospective market-pre 证据未达到 3 个不同合约及 75% 方向占比。');
  result.valid=!invalid&&result.prospectivePreTokens>=3&&result.share!==undefined&&result.share>=0.75;
  return result;
}

interface PreparedFollowup {
  token:string;relation:WalletVisibleStartRelationReference;peerBuy:WalletInitiatorTradeReference;
}

function prepareFollowup(raw:WalletVisibleStartFollowupInput,chain:Chain,wallet:string,token:string,asOf:number):PreparedFollowup|undefined {
  if(!raw||typeof raw!=='object'||address(chain,raw.tokenAddress)!==token||!raw.relation||typeof raw.relation!=='object')return;
  const relation=raw.relation,peer=address(chain,relation.peerWallet),candidate=address(chain,relation.candidateWallet),
    knownAt=instant(relation.knownAt);
  if(!identifier(relation.id)||candidate!==wallet||!peer||peer===wallet||!['public','independent'].includes(relation.peerClass)||
    !['public_watchlist','prior_pair_history','independence_review'].includes(relation.basis)||knownAt===undefined||knownAt>asOf||
    !source(relation.source)||relation.conflict!==undefined&&typeof relation.conflict!=='boolean')return;
  const peerBuy=tradeReference(raw.peerBuy,chain,peer,token,'buy',asOf);if(!peerBuy)return;
  return {token,relation:{id:relation.id,candidateWallet:wallet,peerWallet:peer,peerClass:relation.peerClass,basis:relation.basis,
    knownAt:iso(knownAt),source:relation.source,...(relation.conflict===undefined?{}:{conflict:relation.conflict})},peerBuy};
}

function displayEvidence(rows:WalletVisibleStartEvidence[]):WalletVisibleStartEvidence[] {
  const selected:WalletVisibleStartEvidence[]=[];
  for(const direction of ['counter','followed','ambiguous','outsideWindow','unmatched'] as const){
    const row=rows.find(item=>item.direction===direction);if(row)selected.push(row);
  }
  for(const row of rows)if(selected.length<DISPLAY_LIMIT&&!selected.includes(row))selected.push(row);
  return structuredClone(selected.slice(0,DISPLAY_LIMIT));
}

function proofHash(prerequisiteProofHash:string,evidence:WalletVisibleStartEvidence[]):string {
  return digest({prerequisiteProofHash,evidence});
}

/** Validate a persisted certificate against its frozen frame and the currently expected prerequisite proof. */
export function qualifiedWalletVisibleStart(value:WalletVisibleStartQualification|undefined,chain:Chain,wallet:string,
  asOf:string,expectedPrerequisiteProofHash:string):boolean {
  const candidate=address(chain,wallet),now=instant(asOf),knownAt=instant(value?.knownAt),prerequisiteAt=instant(value?.prerequisiteKnownAt);
  if(!value||value.version!==1||value.classification!=='visible_start_candidate'||!candidate||now===undefined||knownAt===undefined||
    prerequisiteAt===undefined||prerequisiteAt>knownAt||knownAt>now||value.prerequisiteProofHash!==expectedPrerequisiteProofHash||
    !/^[0-9a-f]{64}$/.test(value.prerequisiteProofHash)||!Array.isArray(value.evidence)||!value.evidence.length||
    value.evidence.length>FRAME_LIMIT||value.proofHash!==proofHash(value.prerequisiteProofHash,value.evidence))return false;
  const tokens=new Set<string>();let followed=0,matched=0;
  for(const row of value.evidence){
    const token=address(chain,row?.tokenAddress);if(!token||tokens.has(token)||!DIRECTIONS.includes(row.direction)||
      !Number.isSafeInteger(row.consideredFollowups)||row.consideredFollowups<0||!Number.isSafeInteger(row.excludedFollowups)||
      row.excludedFollowups<0)return false;
    tokens.add(token);const buy=tradeReference(row.candidateBuy,chain,candidate,token,'buy',knownAt),
      market=marketReference(row.marketFirstSeen,chain,token,knownAt);
    if(!buy||!market||Date.parse(buy.eventAt)>=Date.parse(market.firstSeenLowerBound!)-DEAD_ZONE_SECONDS*1000||
      Date.parse(buy.observedAt)>=Date.parse(market.firstSeenLowerBound!))return false;
    if(row.direction!=='unmatched')matched++;
    if(row.direction==='followed'){
      const prepared=row.relation&&row.peerBuy?prepareFollowup({tokenAddress:token,relation:row.relation,peerBuy:row.peerBuy},
        chain,candidate,token,knownAt):undefined;
      if(!prepared||prepared.relation.conflict||Date.parse(prepared.relation.knownAt)>=Date.parse(buy.eventAt)||
        prepared.peerBuy.txHash===buy.txHash||Date.parse(prepared.peerBuy.eventAt)-Date.parse(buy.eventAt)<=DEAD_ZONE_SECONDS*1000||
        Date.parse(prepared.peerBuy.eventAt)-Date.parse(buy.eventAt)>WINDOW_SECONDS*1000||
        Date.parse(prepared.peerBuy.eventAt)-Date.parse(buy.observedAt)<=DEAD_ZONE_SECONDS*1000)return false;
      followed++;
    }
  }
  return followed>=3&&matched>0&&followed/matched>=0.75;
}

function previousQualification(input:AnalyzeWalletVisibleStartInput,wallet:string,asOf:number,proof:string,
  currentHash:string):WalletVisibleStartQualification|undefined {
  const previous=input.previous,computed=instant(previous?.computedAt),qualification=previous?.qualification;
  if(!previous||previous.version!==1||previous.chain!==input.chain||address(input.chain,previous.wallet)!==wallet||
    previous.classification!=='visible_start_candidate'||computed===undefined||computed>asOf||
    instant(qualification?.knownAt)===undefined||instant(qualification?.knownAt)!>computed||
    !qualifiedWalletVisibleStart(qualification,input.chain,wallet,iso(asOf),proof)||
    qualification!.proofHash!==currentHash)return;
  return structuredClone(qualification!);
}

/**
 * Prospective timing research only. It does not identify a deployer or owner,
 * prove that a peer copied a trade, measure profit, or authorize trading.
 */
export function analyzeWalletVisibleStart(input:AnalyzeWalletVisibleStartInput):WalletVisibleStartAnalysis {
  const asOf=instant(input.asOf),wallet=address(input.chain,input.wallet);
  if(asOf===undefined||!wallet||!['bsc','solana','robinhood'].includes(input.chain)||!Array.isArray(input.followups))
    throw new Error('WALLET_VISIBLE_START_INPUT_INVALID');
  const prerequisite=preparePrerequisite(input.prospectiveMarketPreQualification,input.chain,wallet,asOf),
    byToken=new Map<string,WalletVisibleStartFollowupInput[]>();let rejectedFollowups=0;
  for(const raw of input.followups){
    const token=address(input.chain,raw?.tokenAddress);
    if(!token||!prerequisite.prospective.has(token)){rejectedFollowups++;continue;}
    const rows=byToken.get(token)??[];rows.push(raw);byToken.set(token,rows);
  }
  const rows:WalletVisibleStartEvidence[]=[],counters:Record<WalletVisibleStartDirection,number>={
    followed:0,counter:0,ambiguous:0,outsideWindow:0,unmatched:0,
  };
  for(const [token,candidate] of prerequisite.prospective){
    const rawRows=byToken.get(token)??[],prepared:PreparedFollowup[]=[],groups=new Map<string,PreparedFollowup[]>();
    let excluded=0,conflict=false;
    for(const raw of rawRows){
      const item=prepareFollowup(raw,input.chain,wallet,token,asOf);
      if(!item){excluded++;rejectedFollowups++;continue;}
      const key=`${item.relation.peerWallet}:${item.peerBuy.txHash}`,group=groups.get(key)??[];group.push(item);groups.set(key,group);
    }
    for(const group of groups.values()){
      if(new Set(group.map(item=>item.peerBuy.eventAt)).size>1){conflict=true;excluded+=group.length;continue;}
      group.sort((a,b)=>a.peerBuy.observedAt.localeCompare(b.peerBuy.observedAt)||a.relation.id.localeCompare(b.relation.id));
      prepared.push(group[0]);excluded+=group.length-1;
    }
    prepared.sort((a,b)=>a.peerBuy.eventAt.localeCompare(b.peerBuy.eventAt)||a.peerBuy.txHash.localeCompare(b.peerBuy.txHash)||
      a.relation.peerWallet.localeCompare(b.relation.peerWallet));
    const eligible=prepared.filter(item=>!item.relation.conflict&&Date.parse(item.relation.knownAt)<Date.parse(candidate.buy.eventAt));
    let selected=eligible[0],direction:WalletVisibleStartDirection,reason:string,lag:number|undefined,localLead:number|undefined;
    if(!rawRows.length){direction='unmatched';reason='尚未提供该 prospective market-pre 合约的公开/独立钱包后续买入。';}
    else if(conflict||!selected){
      direction='ambiguous';reason=conflict?'同一 peer 交易出现冲突时间，不能选择有利版本。':
        '跟进记录的关系均未在候选买入前建立，不能作为前向启动证据。';
    }else {
      lag=(Date.parse(selected.peerBuy.eventAt)-Date.parse(candidate.buy.eventAt))/1000;
      localLead=(Date.parse(selected.peerBuy.eventAt)-Date.parse(candidate.buy.observedAt))/1000;
      if(selected.peerBuy.txHash===candidate.buy.txHash){direction='ambiguous';reason='候选与 peer 出现在同一交易，不能确认先后。';}
      else if(Math.abs(lag)<=DEAD_ZONE_SECONDS){direction='ambiguous';reason='候选与 peer 买入落在 2 秒近时范围。';}
      else if(Math.abs(lag)>WINDOW_SECONDS){direction='outsideWindow';reason='候选与 peer 买入相隔超过 24 小时。';}
      else if(lag<0){direction='counter';reason='预先建立关系的 peer 早于候选买入，是启动器假设的反例。';}
      else if(localLead<=DEAD_ZONE_SECONDS){direction='ambiguous';reason='候选买入虽在链上较早，但本机证据未领先 peer 买入超过 2 秒。';}
      else {direction='followed';reason='关系预先建立，本机先取得候选买入证据，随后 peer 在同一合约买入。';}
    }
    counters[direction]++;
    rows.push({tokenAddress:token,direction,reason,candidateBuy:structuredClone(candidate.buy),
      marketFirstSeen:structuredClone(candidate.market),...(selected?{relation:structuredClone(selected.relation),peerBuy:structuredClone(selected.peerBuy)}:{}),
      ...(lag===undefined?{}:{lagSeconds:lag}),...(localLead===undefined?{}:{localEvidenceLeadSeconds:localLead}),
      consideredFollowups:prepared.length,excludedFollowups:excluded});
  }
  const matchedTokens=counters.followed+counters.counter+counters.ambiguous+counters.outsideWindow,
    followShare=matchedTokens?counters.followed/matchedTokens:undefined,
    partial=!!input.truncated||!prerequisite.valid||rejectedFollowups>0,
    classification:WalletVisibleStartClassification=!partial&&counters.followed>=3&&followShare!==undefined&&followShare>=0.75?
      'visible_start_candidate':'insufficient',computedAt=iso(asOf),screeningEvidence=structuredClone(rows);
  const output:WalletVisibleStartAnalysis={version:1,chain:input.chain,wallet,computedAt,status:partial?'partial':'current',classification,
    sampleOnly:true,identity:'unknown',ownership:'unknown',profitAssessment:'not_assessed',tradingEnabled:false,
    prerequisite:{valid:prerequisite.valid,...(prerequisite.knownAt?{knownAt:prerequisite.knownAt}:{}),
      ...(prerequisite.proofHash?{proofHash:prerequisite.proofHash}:{}),prospectivePreTokens:prerequisite.prospectivePreTokens,
      matchedTokens:prerequisite.matchedTokens,...(prerequisite.share===undefined?{}:{prospectivePreShare:prerequisite.share})},
    directionalTokens:counters,matchedTokens,...(followShare===undefined?{}:{followShare}),selectedTokens:rows.length,
    rejectedFollowups,evidence:displayEvidence(rows),screeningEvidence,qualificationState:'none',
    reasons:[`prospective market-pre 帧中 ${rows.length} 个合约：后续跟进 ${counters.followed}、反例 ${counters.counter}、方向不明 ${counters.ambiguous}、超窗 ${counters.outsideWindow}、未匹配 ${counters.unmatched}。`],
    counterEvidence:[],limitations:[
      '这是本机前向时间证据形成的“可见启动候选”，不是部署者、项目方、KOL 身份或钱包所有权认定。',
      'public/independent 与关系标签来自输入证据；即使预先记录，也不能证明实际跟单、共同控制或相互知情。',
      '未使用完整头寸、成交成本或退出现金流，不评估盈利，也不推断未来收益。',
      '每个合约最多计一次，近时、反向、超窗和缺失样本均保留，不能用重复 peer 买入放大证据。',
    ],method:{minimumFollowTokens:3,minimumDirectionShare:0.75,nearTimeSeconds:2,maximumLagSeconds:86400,
      evidenceLimit:6,qualificationEvidenceLimit:30}};
  output.limitations.push(...prerequisite.reasons);
  if(input.truncated)output.limitations.push('跟进输入已截断，本轮不能签发资格。');
  if(rejectedFollowups)output.limitations.push(`已排除 ${rejectedFollowups} 条错链、错钱包、错合约、未来或非法跟进记录，本轮不能签发资格。`);
  if(counters.counter)output.counterEvidence.push(`${counters.counter} 个合约由预先建立关系的 peer 更早买入。`);
  if(counters.ambiguous||counters.outsideWindow)output.counterEvidence.push('近时、关系建立过晚、证据冲突及超出 24 小时的样本保留在方向占比分母中。');
  if(counters.unmatched)output.counterEvidence.push(`${counters.unmatched} 个 prospective market-pre 合约尚无可比较跟进；缺失不等于没有后续买入。`);
  const oldPresent=!!input.previous?.qualification;
  if(classification==='visible_start_candidate'&&prerequisite.proofHash&&prerequisite.knownAt){
    const hash=proofHash(prerequisite.proofHash,screeningEvidence),preserved=previousQualification(input,wallet,asOf,prerequisite.proofHash,hash);
    output.qualification=preserved??{version:1,classification:'visible_start_candidate',knownAt:computedAt,
      prerequisiteKnownAt:prerequisite.knownAt,prerequisiteProofHash:prerequisite.proofHash,proofHash:hash,evidence:structuredClone(screeningEvidence)};
    output.qualificationState=preserved?'preserved':oldPresent?'reissued':'issued';
  }else if(oldPresent)output.qualificationState='revoked';
  return output;
}
