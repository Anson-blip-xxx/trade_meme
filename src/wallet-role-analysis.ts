import bs58 from 'bs58';
import type {Chain} from './types.js';
import type {WalletTradeObservation} from './wallet-history.js';

export type WalletRoleEvent=WalletTradeObservation;
export type WalletRolePattern='follower_pattern'|'precursor_pattern'|'mixed_pattern'|'insufficient';
export type WalletRoleDirection='lead'|'follow'|'ambiguous'|'unmatched'|'outsideWindow';
export interface WalletRoleFundingEvidence {
  kind:'direct'|'common';address?:string;observedAt:string;sharedService?:boolean;conflict?:boolean;
  verification?:'vendor_claim'|'rpc_confirmed'|'rpc_observed';
}
export interface WalletRolePeerInput {
  address:string;events:readonly WalletRoleEvent[];publicObservedAt?:string;relationshipKnownAt?:string;
  fundingEvidence?:readonly WalletRoleFundingEvidence[];
}
export interface AnalyzeWalletRolesInput {
  chain:Chain;wallet:string;asOf:string;walletEvents:readonly WalletRoleEvent[];peers:readonly WalletRolePeerInput[];truncated?:boolean;
  /** Only the previously persisted analysis for this same wallet. Never reconstruct a past qualification from old trades. */
  previous?:WalletRoleAnalysis;
}
export interface WalletRoleEventReference {
  wallet:string;txHash:string;eventAt:string;observedAt:string;source:string;eventIndex?:number;
}
export interface WalletRoleEvidence {
  tokenAddress:string;direction:WalletRoleDirection;candidateBuy?:WalletRoleEventReference;leaderBuy?:WalletRoleEventReference;
  candidateSellAfterLeader?:WalletRoleEventReference;lagSeconds?:number;reason:string;
}
export interface WalletRoleQualification {
  version:1;knownAt:string;
  /** Frozen bounded sampling frame, including opposing and uncertain directions. Separate from UI examples. */
  evidence:WalletRoleEvidence[];
}
export interface WalletRolePeerAnalysis {
  address:string;classification:WalletRolePattern;directionalPattern:WalletRolePattern;ownership:'unknown';
  directionalTokens:Record<WalletRoleDirection,number>;matchedTokens:number;totalCandidateTokens:number;
  leadShare?:number;followShare?:number;medianLagSeconds?:number;lagMadSeconds?:number;
  forwardObservedTokens:number;pendingTokens:number;unobservedTokens:number;evidence:WalletRoleEvidence[];
  reasons:string[];counterEvidence:string[];alternativeExplanations:string[];
  funding:{direct:number;common:number;excluded:number;ownership:'unknown'};
  screeningEvidence?:WalletRoleEvidence[];
  qualification?:WalletRoleQualification;
}
export interface WalletRoleAnalysis {
  version:1;computedAt:string;status:'current'|'partial';ownership:'unknown';sampleOnly:true;
  peers:WalletRolePeerAnalysis[];limitations:string[];
  method:{minimumDirectionalTokens:3;minimumDirectionShare:0.75;nearTimeSeconds:2;maximumLagSeconds:86400;evidenceLimitPerPeer:6;screeningEvidenceLimitPerPeer?:30};
}

const WINDOW=86_400,DEAD_ZONE=2;
const time=(value:unknown):number|undefined=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):undefined;
function address(chain:Chain,value:unknown):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-fA-F]{40}$/.test(value)?value.toLowerCase():undefined;
  try{return value.length<=44&&bs58.decode(value).length===32?value:undefined;}catch{return;}
}
function tx(chain:Chain,value:unknown):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-fA-F]{64}$/.test(value)?value.toLowerCase():undefined;
  try{return value.length<=88&&bs58.decode(value).length===64?value:undefined;}catch{return;}
}
const median=(values:number[]):number|undefined=>{if(!values.length)return;const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
const reference=(event:WalletRoleEvent):WalletRoleEventReference=>({wallet:event.wallet,txHash:event.txHash,eventAt:event.eventAt,observedAt:event.observedAt,source:event.source,...(event.eventIndex===undefined?{}:{eventIndex:event.eventIndex})});
interface Prepared {buys:Map<string,WalletRoleEvent>;tokens:Set<string>;uncertain:Set<string>;sells:Map<string,WalletRoleEvent[]>;rejected:number;}
function prepare(events:readonly WalletRoleEvent[],chain:Chain,wallet:string,asOf:number):Prepared {
  const result:Prepared={buys:new Map(),tokens:new Set(),uncertain:new Set(),sells:new Map(),rejected:0},groups=new Map<string,WalletRoleEvent[]>();
  for(const value of events){
    if(!value||!['buy','sell'].includes(value.side))continue;
    const token=address(chain,value.tokenAddress),hash=tx(chain,value.txHash),eventAt=time(value.eventAt),observedAt=time(value.observedAt);
    if(value.chain!==chain||address(chain,value.wallet)!==wallet||!token||!hash||eventAt===undefined||observedAt===undefined||eventAt>observedAt||observedAt>asOf||typeof value.source!=='string'||!value.source){result.rejected++;continue;}
    const event={...value,wallet,tokenAddress:token,txHash:hash,eventAt:new Date(eventAt).toISOString(),observedAt:new Date(observedAt).toISOString()};
    if(event.side==='buy')result.tokens.add(token);
    // Multiple swap rows in one transaction are not independent timing samples.
    const key=[token,hash,event.side].join(':');const group=groups.get(key)??[];group.push(event);groups.set(key,group);
  }
  for(const group of groups.values()){
    const first=group[0];
    if(new Set(group.map(item=>item.eventAt)).size>1){if(first.side==='buy')result.uncertain.add(first.tokenAddress);result.rejected+=group.length;continue;}
    group.sort((a,b)=>a.observedAt.localeCompare(b.observedAt));const event=group[0];
    if(event.side==='buy'){
      const old=result.buys.get(event.tokenAddress);if(!old||event.eventAt<old.eventAt||event.eventAt===old.eventAt&&event.txHash<old.txHash)result.buys.set(event.tokenAddress,event);
    }else{const sells=result.sells.get(event.tokenAddress)??[];sells.push(event);result.sells.set(event.tokenAddress,sells);}
  }
  for(const sells of result.sells.values())sells.sort((a,b)=>a.eventAt.localeCompare(b.eventAt)||a.txHash.localeCompare(b.txHash));
  return result;
}
function examples(rows:WalletRoleEvidence[]):WalletRoleEvidence[]{
  const chosen:WalletRoleEvidence[]=[];
  // Preserve contradictory directions before adding the most recent examples.
  for(const direction of ['follow','lead','ambiguous','unmatched','outsideWindow'] as const){const row=rows.find(item=>item.direction===direction);if(row)chosen.push(row);}
  for(const row of rows)if(chosen.length<6&&!chosen.includes(row))chosen.push(row);
  return chosen.slice(0,6);
}

/** Validate the original sampled qualification from its transaction proofs, not aggregate counts. */
export function qualifiedRoleEvidence(value:WalletRoleQualification|undefined,chain:Chain,wallet:string,peer:string,asOf:string):boolean {
  const known=time(value?.knownAt),now=time(asOf),candidateWallet=address(chain,wallet),leaderWallet=address(chain,peer);
  if(!value||value.version!==1||!candidateWallet||!leaderWallet||known===undefined||now===undefined||known>now||!Array.isArray(value.evidence)||value.evidence.length>30)return false;
  const tokens=new Set<string>();let lead=0,matched=0;
  for(const row of value.evidence){
    if(!row)return false;
    const token=address(chain,row.tokenAddress);if(!token||tokens.has(token)||!['lead','follow','ambiguous','unmatched','outsideWindow'].includes(row.direction))return false;
    tokens.add(token);
    for(const [event,who] of [[row.candidateBuy,candidateWallet],[row.leaderBuy,leaderWallet]] as const){
      if(!event)continue;
      const at=time(event.eventAt),observed=time(event.observedAt);
      if(address(chain,event.wallet)!==who||!tx(chain,event.txHash)||at===undefined||observed===undefined||at>observed||observed>known)return false;
    }
    if(row.direction!=='unmatched')matched++;
    if(row.direction==='lead'){
      const candidate=row.candidateBuy,leader=row.leaderBuy;
      if(!candidate||!leader||candidate.txHash===leader.txHash)return false;
      const lag=(time(leader.eventAt)!-time(candidate.eventAt)!)/1000;
      if(lag<=DEAD_ZONE||lag>WINDOW)return false;
      lead++;
    }
  }
  return lead>=3&&matched>0&&lead/matched>=0.75;
}

function qualification(input:AnalyzeWalletRolesInput,peer:string,rows:WalletRoleEvidence[],asOf:string):WalletRoleQualification|undefined {
  // The caller's full selected sampling frame must fit. A display slice may never establish a qualification.
  if(rows.length>30)return;
  const fresh:WalletRoleQualification={version:1,knownAt:asOf,evidence:structuredClone(rows)};
  if(!qualifiedRoleEvidence(fresh,input.chain,input.wallet,peer,asOf))return;
  const previous=input.previous,old=previous?.peers.find(row=>row.address===peer);
  if(old?.classification!=='precursor_pattern'||!qualifiedRoleEvidence(old.qualification,input.chain,input.wallet,peer,asOf)||
    time(previous?.computedAt)===undefined||time(previous!.computedAt)!>time(asOf)!||time(old.qualification!.knownAt)!>time(previous!.computedAt)!)return fresh;
  // Repeated observation timestamps may change, but a different earliest buy,
  // opposing direction or a timestamp conflict retracts the original proof.
  const same=(a:WalletRoleEventReference|undefined,b:WalletRoleEventReference|undefined)=>!!a&&!!b&&
    a.wallet===b.wallet&&a.txHash===b.txHash&&a.eventAt===b.eventAt&&a.eventIndex===b.eventIndex;
  for(const evidence of old.qualification!.evidence.filter(row=>row.direction==='lead')){
    const current=rows.find(row=>row.tokenAddress===evidence.tokenAddress);
    if(current&&(current.direction!=='lead'||!same(current.candidateBuy,evidence.candidateBuy)||!same(current.leaderBuy,evidence.leaderBuy)))return fresh;
  }
  return structuredClone(old.qualification!);
}

/** Directional research only. It never asserts common control, actual copying, or a trading recommendation. */
export function analyzeWalletRoles(input:AnalyzeWalletRolesInput):WalletRoleAnalysis {
  const asOf=time(input.asOf),wallet=address(input.chain,input.wallet);
  if(asOf===undefined||!wallet||!['bsc','solana','robinhood'].includes(input.chain))throw new Error('WALLET_ROLE_INPUT_INVALID');
  const output:WalletRoleAnalysis={version:1,computedAt:new Date(asOf).toISOString(),status:input.truncated?'partial':'current',ownership:'unknown',sampleOnly:true,peers:[],
    method:{minimumDirectionalTokens:3,minimumDirectionShare:0.75,nearTimeSeconds:2,maximumLagSeconds:86400,evidenceLimitPerPeer:6,screeningEvidenceLimitPerPeer:30},
    limitations:['只比较已采样的最早已知买入，不能保证是钱包真实首次买入。','公开标签与同步交易不能证明 KOL 身份、实际跟单或共同控制。','近时 2 秒是研究参数，不代表链上时间戳精度；未使用完整区块内交易顺序。','前向观察次数仅描述已有记录，没有完整预测分母，不是命中率。']};
  if(input.truncated)output.limitations.push('输入样本已截断；方向比例仅覆盖本次可比较的采样合约。');
  const candidate=prepare(input.walletEvents,input.chain,wallet,asOf),seenPeers=new Set<string>();
  if(candidate.rejected){output.status='partial';output.limitations.push('已排除无效、未来、错链、错钱包或时间冲突事件；冲突合约不形成确定先后。');}
  for(const raw of input.peers){
    const peer=address(input.chain,raw.address);if(!peer||peer===wallet||seenPeers.has(peer)){output.status='partial';continue;}seenPeers.add(peer);
    const prepared=prepare(raw.events,input.chain,peer,asOf);if(prepared.rejected)output.status='partial';
    const counters:WalletRolePeerAnalysis['directionalTokens']={lead:0,follow:0,ambiguous:0,unmatched:0,outsideWindow:0};
    const knownAt=time(raw.relationshipKnownAt),publicAt=time(raw.publicObservedAt),validKnownAt=knownAt!==undefined&&knownAt<=asOf?knownAt:undefined;
    const relation:WalletRolePeerAnalysis={address:peer,classification:'insufficient',directionalPattern:'insufficient',ownership:'unknown',directionalTokens:counters,matchedTokens:0,totalCandidateTokens:candidate.tokens.size,
      forwardObservedTokens:0,pendingTokens:0,unobservedTokens:0,evidence:[],reasons:[],counterEvidence:[],alternativeExplanations:['双方可能响应同一公开热点、上游钱包或独立信号。','持续提前仍可能来自独立策略；持续滞后也不能证明实际复制交易。'],funding:{direct:0,common:0,excluded:0,ownership:'unknown'}};
    if(raw.relationshipKnownAt&&(validKnownAt===undefined)||raw.publicObservedAt&&(publicAt===undefined||publicAt>asOf)){output.status='partial';relation.counterEvidence.push('关系或公开标签时间无效，不能作为前向观察依据。');}
    const lags:number[]=[],rows:WalletRoleEvidence[]=[];
    const tokens=[...candidate.tokens].sort((a,b)=>(candidate.buys.get(b)?.eventAt??'').localeCompare(candidate.buys.get(a)?.eventAt??'')||a.localeCompare(b));
    for(const token of tokens){
      const buy=candidate.buys.get(token),leader=prepared.buys.get(token);let direction:WalletRoleDirection,reason:string,lag:number|undefined;
      if(!prepared.tokens.has(token)){
        direction='unmatched';reason='采样中尚未观察到对方买入；缺失不能当作未买或预测失败。';
        if(buy&&asOf-Date.parse(buy.eventAt)<WINDOW*1000)relation.pendingTokens++;else relation.unobservedTokens++;
      }else if(!buy||!leader||candidate.uncertain.has(token)||prepared.uncertain.has(token)){
        direction='ambiguous';reason='相同交易的时间证据冲突，当前不能确定先后。';
      }else{
        lag=(Date.parse(buy.eventAt)-Date.parse(leader.eventAt))/1000;
        if(buy.txHash===leader.txHash){direction='ambiguous';reason='双方出现在同一交易中，不能据此建立跟随或提前关系。';}
        else if(Math.abs(lag)<=DEAD_ZONE){direction='ambiguous';reason='买入时间落在 2 秒近时范围，缺少足够精度确认方向。';}
        else if(Math.abs(lag)>WINDOW){direction='outsideWindow';reason='双方已知买入相隔超过 24 小时，不视为这次跟随或提前模式。';}
        else{direction=lag<0?'lead':'follow';reason=direction==='lead'?'该币最早已知买入早于对方。':'该币最早已知买入晚于对方。';lags.push(lag);}
      }
      counters[direction]++;
      const row:WalletRoleEvidence={tokenAddress:token,direction,reason,...(buy?{candidateBuy:reference(buy)}:{}),...(leader?{leaderBuy:reference(leader)}:{}),...(lag===undefined?{}:{lagSeconds:lag})};
      if(buy&&leader){
        const sell=candidate.sells.get(token)?.find(item=>item.eventAt>leader.eventAt&&Date.parse(item.eventAt)-Date.parse(leader.eventAt)<=WINDOW*1000&&item.txHash!==buy.txHash&&item.txHash!==leader.txHash);
        if(sell)row.candidateSellAfterLeader=reference(sell);
        if(direction==='lead'&&validKnownAt!==undefined&&validKnownAt<Date.parse(buy.eventAt)&&Date.parse(buy.observedAt)<Date.parse(leader.eventAt)&&(!raw.publicObservedAt||publicAt!==undefined&&publicAt<=asOf))relation.forwardObservedTokens++;
      }
      rows.push(row);
    }
    relation.matchedTokens=counters.lead+counters.follow+counters.ambiguous+counters.outsideWindow;
    if(relation.matchedTokens){relation.leadShare=counters.lead/relation.matchedTokens;relation.followShare=counters.follow/relation.matchedTokens;}
    if(counters.lead>=3&&relation.leadShare!>=0.75)relation.classification='precursor_pattern';
    else if(counters.follow>=3&&relation.followShare!>=0.75)relation.classification='follower_pattern';
    else if(counters.lead>=2&&counters.follow>=2)relation.classification='mixed_pattern';
    relation.directionalPattern=relation.classification;
    relation.medianLagSeconds=median(lags);
    if(relation.medianLagSeconds!==undefined)relation.lagMadSeconds=median(lags.map(value=>Math.abs(value-relation.medianLagSeconds!)));
    relation.reasons.push(`同一对钱包采样到 ${relation.totalCandidateTokens} 个候选合约，其中 ${relation.matchedTokens} 个共同合约：提前 ${counters.lead}、跟随 ${counters.follow}、方向不明 ${counters.ambiguous}、超出窗口 ${counters.outsideWindow}。`);
    if(relation.classification==='precursor_pattern')relation.reasons.push('同一钱包对至少 3 个合约提前，且占所有共同合约至少 75%；这仅支持提前行为模式。');
    else if(relation.classification==='follower_pattern')relation.reasons.push('同一钱包对至少 3 个合约滞后，且占所有共同合约至少 75%；这与跟随交易相容。');
    else if(relation.classification==='mixed_pattern')relation.reasons.push('至少 2 个合约提前、2 个合约滞后，方向混合，不能用少数早买概括此钱包。');
    else relation.reasons.push('独立合约数量或方向一致性不足，暂不形成稳定角色。');
    if(counters.follow)relation.counterEvidence.push(`${counters.follow} 个共同合约晚于对方买入，是“持续提前”假设的反例。`);
    if(counters.lead)relation.counterEvidence.push(`${counters.lead} 个共同合约早于对方买入，是“持续跟随”假设的反例。`);
    if(counters.ambiguous||counters.outsideWindow)relation.counterEvidence.push('近时、冲突及超出窗口的共同合约保留在方向占比的分母中。');
    if(counters.unmatched)relation.counterEvidence.push(`${counters.unmatched} 个候选合约未观察到对方；其中 ${relation.pendingTokens} 个尚在 24 小时观察窗内，不能当作预测失败。`);
    if(prepared.rejected)relation.counterEvidence.push('对方部分事件无效或时间冲突，结论仅适用于保留的采样证据。');
    if(relation.classification==='follower_pattern'&&relation.medianLagSeconds!==undefined&&relation.medianLagSeconds>0&&relation.medianLagSeconds<=30&&relation.lagMadSeconds!==undefined&&relation.lagMadSeconds<=5)relation.alternativeExplanations.push('重复的短延迟与自动跟随相容，也可能由共同信号或基础设施导致，不能据此识别机器人或所有人。');
    if(rows.some(row=>row.candidateSellAfterLeader))relation.reasons.push('观察到对方买入后的卖单，但没有完整成本与净头寸，不能据此声称出货或盈利。');
    for(const item of raw.fundingEvidence??[]){const observed=time(item.observedAt);if(!['direct','common'].includes(item.kind)||observed===undefined||observed>asOf||item.sharedService||item.conflict||item.address&&!address(input.chain,item.address)){relation.funding.excluded++;continue;}relation.funding[item.kind]++;}
    if(relation.funding.direct||relation.funding.common)relation.reasons.push('资金联系作为独立线索保留，不改变先后方向，也不证明同一控制人。');
    if(relation.funding.excluded)relation.counterEvidence.push('公共服务、冲突或无效资金证据已排除。');
    relation.evidence=examples(rows);relation.screeningEvidence=structuredClone(rows.slice(0,30));
    if(relation.classification==='precursor_pattern')relation.qualification=qualification(input,peer,rows,output.computedAt);
    output.peers.push(relation);
  }
  return output;
}
