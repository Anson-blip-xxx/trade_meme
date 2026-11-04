import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import type {Chain} from './types.js';
import type {WalletTradeObservation} from './wallet-history.js';

export type WalletInitiatorClassification='candidate'|'precursor'|'visible_start'|'follower'|'mixed'|'insufficient';
export type WalletInitiatorDirection='pre'|'post'|'ambiguous'|'outsideWindow'|'unmatched';

export interface GmgnMarketFirstSeen {
  id:string;source:'gmgn_market_discovery';kind:'first_seen';chain:Chain;tokenAddress:string;
  firstSeenLowerBound?:string;firstSeenUpperBound:string;feed:'trending'|'trenches';window:string;leftCensored?:boolean;
}

export interface WalletInitiatorTradeReference {
  chain:Chain;wallet:string;tokenAddress:string;txHash:string;side:'buy'|'sell';eventAt:string;observedAt:string;
  source:string;eventIndex?:number;
}

export interface WalletInitiatorMarketReference {
  id:string;source:'gmgn_market_discovery';kind:'first_seen';chain:Chain;tokenAddress:string;
  firstSeenLowerBound?:string;firstSeenUpperBound:string;feed:'trending'|'trenches';window:string;leftCensored:boolean;
}

export interface WalletInitiatorEvidence {
  tokenAddress:string;direction:WalletInitiatorDirection;prospective:boolean;reason:string;
  buy?:WalletInitiatorTradeReference;marketFirstSeen?:WalletInitiatorMarketReference;
  postActivationExit?:WalletInitiatorTradeReference;lagSeconds?:number;
}

export interface WalletInitiatorQualification {
  version:1;classification:Exclude<WalletInitiatorClassification,'candidate'|'insufficient'>;knownAt:string;
  proofHash:string;evidence:WalletInitiatorEvidence[];
}

export interface WalletInitiatorAnalysis {
  version:1;chain:Chain;wallet:string;computedAt:string;status:'current'|'partial';classification:WalletInitiatorClassification;
  sampleOnly:true;ownership:'unknown';tradingEnabled:false;dumpAssessment:'unknown';
  directionalTokens:Record<WalletInitiatorDirection,number>;totalCandidateTokens:number;selectedTokens:number;matchedTokens:number;
  preShare?:number;followShare?:number;prospectivePreTokens:number;postActivationExitTokens:number;
  pendingTokens:number;unobservedTokens:number;evidence:WalletInitiatorEvidence[];screeningEvidence:WalletInitiatorEvidence[];
  qualification?:WalletInitiatorQualification;reasons:string[];counterEvidence:string[];limitations:string[];
  method:{minimumDirectionalTokens:3;minimumDirectionShare:0.75;nearTimeSeconds:2;maximumLagSeconds:86400;
    evidenceLimit:6;qualificationEvidenceLimit:30};
}

export interface AnalyzeWalletInitiatorInput {
  chain:Chain;wallet:string;asOf:string;trades:readonly WalletTradeObservation[];
  marketFirstSeen:readonly GmgnMarketFirstSeen[];previous?:WalletInitiatorAnalysis;truncated?:boolean;
}

const WINDOW_SECONDS=86_400,DEAD_ZONE_SECONDS=2,FRAME_LIMIT=30,DISPLAY_LIMIT=6;
const source=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_.:-]{0,79}$/.test(value);
const time=(value:unknown):number|undefined=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):undefined;

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

const canonicalTime=(value:number)=>new Date(value).toISOString();
const tradeReference=(event:PreparedTrade):WalletInitiatorTradeReference=>({chain:event.chain,wallet:event.wallet,
  tokenAddress:event.tokenAddress,txHash:event.txHash,side:event.side,eventAt:event.eventAt,observedAt:event.observedAt,
  source:event.source,...(event.eventIndex===undefined?{}:{eventIndex:event.eventIndex})});
const marketReference=(event:PreparedMarket):WalletInitiatorMarketReference=>({...event});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface PreparedTrade extends WalletTradeObservation {
  side:'buy'|'sell';
}

interface PreparedTrades {
  buys:Map<string,PreparedTrade>;sells:Map<string,PreparedTrade[]>;tokens:Set<string>;recentAt:Map<string,string>;
  buyConflicts:Set<string>;sellConflicts:Set<string>;rejected:number;
}

function prepareTrades(input:AnalyzeWalletInitiatorInput,wallet:string,asOf:number):PreparedTrades {
  const prepared:PreparedTrades={buys:new Map(),sells:new Map(),tokens:new Set(),recentAt:new Map(),buyConflicts:new Set(),
    sellConflicts:new Set(),rejected:0};
  const groups=new Map<string,PreparedTrade[]>();
  for(const raw of input.trades){
    const token=address(input.chain,raw?.tokenAddress),who=address(input.chain,raw?.wallet),hash=transaction(input.chain,raw?.txHash),
      eventAt=time(raw?.eventAt),observedAt=time(raw?.observedAt),side=raw?.side;
    if(!raw||raw.chain!==input.chain||who!==wallet||!token||!hash||!['buy','sell'].includes(String(side))||
      eventAt===undefined||observedAt===undefined||eventAt>observedAt||observedAt>asOf||!source(raw.source)||
      raw.eventIndex!==undefined&&(!Number.isSafeInteger(raw.eventIndex)||raw.eventIndex<0)) {prepared.rejected++;continue;}
    const event:PreparedTrade={...raw,chain:input.chain,wallet,tokenAddress:token,txHash:hash,side:side as 'buy'|'sell',
      eventAt:canonicalTime(eventAt),observedAt:canonicalTime(observedAt)};
    if(event.side==='buy'){
      prepared.tokens.add(token);const recent=prepared.recentAt.get(token);
      if(!recent||event.eventAt>recent)prepared.recentAt.set(token,event.eventAt);
    }
    const key=[token,hash,event.side].join(':');const group=groups.get(key)??[];group.push(event);groups.set(key,group);
  }
  for(const group of groups.values()){
    const first=group[0],conflict=new Set(group.map(item=>item.eventAt)).size>1;
    if(conflict){(first.side==='buy'?prepared.buyConflicts:prepared.sellConflicts).add(first.tokenAddress);prepared.rejected+=group.length;continue;}
    group.sort((a,b)=>a.observedAt.localeCompare(b.observedAt)||String(a.eventIndex??-1).localeCompare(String(b.eventIndex??-1)));
    const event=group[0];
    if(event.side==='buy'){
      const old=prepared.buys.get(event.tokenAddress);
      if(!old||event.eventAt<old.eventAt||event.eventAt===old.eventAt&&event.txHash<old.txHash)prepared.buys.set(event.tokenAddress,event);
    }else {const rows=prepared.sells.get(event.tokenAddress)??[];rows.push(event);prepared.sells.set(event.tokenAddress,rows);}
  }
  for(const rows of prepared.sells.values())rows.sort((a,b)=>a.eventAt.localeCompare(b.eventAt)||a.txHash.localeCompare(b.txHash));
  return prepared;
}

interface PreparedMarket extends GmgnMarketFirstSeen {leftCensored:boolean;}
interface PreparedMarkets {first:Map<string,PreparedMarket>;conflicts:Set<string>;rejected:number;}

function prepareMarkets(input:AnalyzeWalletInitiatorInput,asOf:number):PreparedMarkets {
  const result:PreparedMarkets={first:new Map(),conflicts:new Set(),rejected:0},ids=new Map<string,{signature:string;token:string}>();
  for(const raw of input.marketFirstSeen){
    const token=address(input.chain,raw?.tokenAddress),lower=time(raw?.firstSeenLowerBound),upper=time(raw?.firstSeenUpperBound),
      id=typeof raw?.id==='string'&&raw.id.length<=240&&
      /^[A-Za-z0-9_.:-]+$/.test(raw.id)?raw.id:undefined,window=typeof raw?.window==='string'&&raw.window.length<=40&&
      /^[A-Za-z0-9_.:-]+$/.test(raw.window)?raw.window:undefined;
    if(!raw||raw.chain!==input.chain||raw.source!=='gmgn_market_discovery'||raw.kind!=='first_seen'||!token||!id||!window||
      !['trending','trenches'].includes(String(raw.feed))||upper===undefined||upper>asOf||
      raw.leftCensored!==undefined&&typeof raw.leftCensored!=='boolean'||
      raw.firstSeenLowerBound!==undefined&&(lower===undefined||lower>upper)) {result.rejected++;continue;}
    const leftCensored=lower===undefined||raw.leftCensored!==false;
    const event:PreparedMarket={id,source:'gmgn_market_discovery',kind:'first_seen',chain:input.chain,tokenAddress:token,
      ...(lower===undefined?{}:{firstSeenLowerBound:canonicalTime(lower)}),firstSeenUpperBound:canonicalTime(upper),
      feed:raw.feed,window,leftCensored};
    const signature=JSON.stringify(event),prior=ids.get(id);
    if(prior&&prior.signature!==signature){result.conflicts.add(prior.token);result.conflicts.add(token);result.rejected++;continue;}
    ids.set(id,{signature,token});
    const old=result.first.get(token);
    if(!old||event.firstSeenUpperBound<old.firstSeenUpperBound||
      event.firstSeenUpperBound===old.firstSeenUpperBound&&event.id<old.id)result.first.set(token,event);
  }
  for(const token of result.conflicts)result.first.delete(token);
  return result;
}

function displayEvidence(rows:WalletInitiatorEvidence[]):WalletInitiatorEvidence[] {
  const selected:WalletInitiatorEvidence[]=[];
  for(const direction of ['post','pre','ambiguous','outsideWindow','unmatched'] as const){
    const row=rows.find(item=>item.direction===direction);if(row)selected.push(row);
  }
  for(const row of rows)if(selected.length<DISPLAY_LIMIT&&!selected.includes(row))selected.push(row);
  return structuredClone(selected.slice(0,DISPLAY_LIMIT));
}

/** Exit facts evolve independently and are never part of a directional qualification proof. */
function qualificationEvidence(rows:WalletInitiatorEvidence[]):WalletInitiatorEvidence[] {
  return rows.map(row=>{const copy=structuredClone(row);delete copy.postActivationExit;return copy;});
}

const qualifying=(classification:WalletInitiatorClassification):classification is WalletInitiatorQualification['classification']=>
  ['precursor','visible_start','follower','mixed'].includes(classification);

function validPrevious(previous:WalletInitiatorAnalysis|undefined,chain:Chain,wallet:string,asOf:number,
  classification:WalletInitiatorClassification,evidence:WalletInitiatorEvidence[]):WalletInitiatorQualification|undefined {
  const qualification=previous?.qualification,computed=time(previous?.computedAt),known=time(qualification?.knownAt);
  if(!previous||previous.version!==1||previous.chain!==chain||address(chain,previous.wallet)!==wallet||computed===undefined||computed>asOf||
    !qualification||qualification.version!==1||qualification.classification!==classification||known===undefined||known>computed||
    qualification.evidence.length>FRAME_LIMIT||qualification.proofHash!==digest(qualification.evidence)||
    qualification.proofHash!==digest(evidence))return;
  const tokens=new Set<string>();
  for(const row of qualification.evidence){
    const token=address(chain,row?.tokenAddress);if(!token||tokens.has(token)||!['pre','post','ambiguous','outsideWindow','unmatched'].includes(row.direction))return;
    tokens.add(token);
    if(row.buy){const eventAt=time(row.buy.eventAt),observedAt=time(row.buy.observedAt);
      if(row.buy.chain!==chain||address(chain,row.buy.wallet)!==wallet||address(chain,row.buy.tokenAddress)!==token||
        !transaction(chain,row.buy.txHash)||!['buy','sell'].includes(row.buy.side)||eventAt===undefined||observedAt===undefined||
        eventAt>observedAt||observedAt>known||!source(row.buy.source))return;}
    if(row.marketFirstSeen){const lower=time(row.marketFirstSeen.firstSeenLowerBound),upper=time(row.marketFirstSeen.firstSeenUpperBound);
      if(row.marketFirstSeen.chain!==chain||address(chain,row.marketFirstSeen.tokenAddress)!==token||
        row.marketFirstSeen.source!=='gmgn_market_discovery'||row.marketFirstSeen.kind!=='first_seen'||upper===undefined||upper>known||
        typeof row.marketFirstSeen.leftCensored!=='boolean'||row.marketFirstSeen.firstSeenLowerBound!==undefined&&
          (lower===undefined||lower>upper)||!row.marketFirstSeen.leftCensored&&lower===undefined)return;}
    if(row.postActivationExit){const eventAt=time(row.postActivationExit.eventAt),observedAt=time(row.postActivationExit.observedAt);
      if(row.postActivationExit.side!=='sell'||row.postActivationExit.chain!==chain||address(chain,row.postActivationExit.wallet)!==wallet||
        address(chain,row.postActivationExit.tokenAddress)!==token||!transaction(chain,row.postActivationExit.txHash)||
        eventAt===undefined||observedAt===undefined||eventAt>observedAt||observedAt>known)return;}
  }
  return structuredClone(qualification);
}

/** Local timing research only. It does not identify an owner, a deployer, dumping intent, or future returns. */
export function analyzeWalletInitiator(input:AnalyzeWalletInitiatorInput):WalletInitiatorAnalysis {
  const asOf=time(input.asOf),wallet=address(input.chain,input.wallet);
  if(asOf===undefined||!wallet||!['bsc','solana','robinhood'].includes(input.chain)||!Array.isArray(input.trades)||
    !Array.isArray(input.marketFirstSeen))throw new Error('WALLET_INITIATOR_INPUT_INVALID');
  const trades=prepareTrades(input,wallet,asOf),markets=prepareMarkets(input,asOf),status=input.truncated||trades.rejected>0||markets.rejected>0?'partial':'current';
  const allTokens=[...trades.tokens].sort((a,b)=>(trades.recentAt.get(b)??'').localeCompare(trades.recentAt.get(a)??'')||a.localeCompare(b)),
    selected=allTokens.slice(0,FRAME_LIMIT),rows:WalletInitiatorEvidence[]=[];
  const counters:Record<WalletInitiatorDirection,number>={pre:0,post:0,ambiguous:0,outsideWindow:0,unmatched:0};
  let prospectivePreTokens=0,postActivationExitTokens=0,pendingTokens=0,unobservedTokens=0;
  for(const token of selected){
    const buy=trades.buys.get(token),market=markets.first.get(token);let direction:WalletInitiatorDirection,reason:string,lag:number|undefined;
    if(!market&&!markets.conflicts.has(token)){
      direction='unmatched';reason='本地尚未观察到该币的 GMGN market first-seen；缺失不等于尚未公开。';
      if(buy&&asOf-Date.parse(buy.eventAt)<WINDOW_SECONDS*1000)pendingTokens++;else unobservedTokens++;
    }else if(!buy||trades.buyConflicts.has(token)||markets.conflicts.has(token)){
      direction='ambiguous';reason='买入或 market first-seen 的身份/时间证据冲突，不能确定先后。';
    }else {
      const buyAt=Date.parse(buy.eventAt),lower=market!.firstSeenLowerBound?Date.parse(market!.firstSeenLowerBound):undefined,
        upper=Date.parse(market!.firstSeenUpperBound);
      if(lower!==undefined&&buyAt<lower-WINDOW_SECONDS*1000||buyAt>upper+WINDOW_SECONDS*1000){
        direction='outsideWindow';reason='买入与 market first-seen 区间相隔超过 24 小时。';
        lag=buyAt>upper?(buyAt-upper)/1000:(buyAt-(lower??upper))/1000;
      }else if(buyAt>upper+DEAD_ZONE_SECONDS*1000){
        direction='post';reason='最早已知买入晚于本地 GMGN market first-seen 区间。';lag=(buyAt-upper)/1000;
      }else if(!market!.leftCensored&&lower!==undefined&&buyAt<lower-DEAD_ZONE_SECONDS*1000){
        direction='pre';reason='最早已知买入早于本地 GMGN market first-seen 区间。';lag=(buyAt-lower)/1000;
      }else {
        direction='ambiguous';reason=market!.leftCensored||lower===undefined?
          'market first-seen 来自左删失覆盖窗口，不能确定买入是否前置。':
          '买入落在 market first-seen 区间或其 2 秒近时范围。';
      }
    }
    const prospective=direction==='pre'&&!!buy&&!!market&&!market.leftCensored&&!!market.firstSeenLowerBound&&
      buy.eventAt<market.firstSeenLowerBound&&buy.observedAt<market.firstSeenLowerBound;
    if(prospective)prospectivePreTokens++;
    let exit:PreparedTrade|undefined;
    if(buy&&market&&!trades.sellConflicts.has(token)){
      const activation=Math.max(Date.parse(buy.eventAt),Date.parse(market.firstSeenUpperBound));
      exit=trades.sells.get(token)?.find(item=>item.txHash!==buy.txHash&&Date.parse(item.eventAt)>activation+DEAD_ZONE_SECONDS*1000&&
        Date.parse(item.eventAt)<=activation+WINDOW_SECONDS*1000);
    }
    if(exit)postActivationExitTokens++;
    counters[direction]++;
    rows.push({tokenAddress:token,direction,prospective,reason,...(buy?{buy:tradeReference(buy)}:{}),
      ...(market?{marketFirstSeen:marketReference(market)}:{}),...(exit?{postActivationExit:tradeReference(exit)}:{}),
      ...(lag===undefined?{}:{lagSeconds:lag})});
  }
  const matchedTokens=counters.pre+counters.post+counters.ambiguous+counters.outsideWindow,
    preShare=matchedTokens?counters.pre/matchedTokens:undefined,followShare=matchedTokens?counters.post/matchedTokens:undefined;
  let classification:WalletInitiatorClassification='insufficient';
  if(counters.pre>=3&&preShare!>=0.75)classification='precursor';
  else if(counters.post>=3&&followShare!>=0.75)classification='follower';
  else if(counters.pre>=2&&counters.post>=2)classification='mixed';
  else if(counters.pre>0)classification='candidate';
  const computedAt=canonicalTime(asOf),screeningEvidence=structuredClone(rows),limitations=[
    'GMGN market first-seen 是本地首次观察时间，不是代币真实创建、开盘或首次公开时间。',
    '本模块没有冻结 peer/KOL 后续跟进证据，因此不会产出 visible_start；实时前置只能形成 precursor。',
    '仅使用最多 30 个最近采样买入合约；结果不是完整钱包历史。',
    '买卖先后不能证明钱包身份、项目所有权、共同控制、跟单意图或未来收益。',
    '卖单只证明采样中出现后续卖出；缺少完整头寸与价格冲击，不能判定砸盘或完整退出。',
  ];
  if(input.truncated||allTokens.length>FRAME_LIMIT)limitations.push('输入或 30-token 采样帧已截断，角色比例仅适用于保留样本。');
  if(trades.rejected||markets.rejected)limitations.push('已排除错链、错钱包、错 token、未来、非法或时间冲突证据。');
  const result:WalletInitiatorAnalysis={version:1,chain:input.chain,wallet,computedAt,
    status:status==='partial'||allTokens.length>FRAME_LIMIT?'partial':'current',classification,sampleOnly:true,ownership:'unknown',
    tradingEnabled:false,dumpAssessment:'unknown',directionalTokens:counters,totalCandidateTokens:allTokens.length,
    selectedTokens:selected.length,matchedTokens,...(preShare===undefined?{}:{preShare}),...(followShare===undefined?{}:{followShare}),
    prospectivePreTokens,postActivationExitTokens,pendingTokens,unobservedTokens,evidence:displayEvidence(rows),screeningEvidence,
    reasons:[`最多 30 个预先选定合约中，可比较 ${matchedTokens} 个：前置 ${counters.pre}、后置 ${counters.post}、方向不明 ${counters.ambiguous}、超窗 ${counters.outsideWindow}。`],
    counterEvidence:[],limitations,method:{minimumDirectionalTokens:3,minimumDirectionShare:0.75,nearTimeSeconds:2,
      maximumLagSeconds:86400,evidenceLimit:6,qualificationEvidenceLimit:30}};
  if(counters.post)result.counterEvidence.push(`${counters.post} 个后置样本是持续前置假设的反例。`);
  if(counters.pre)result.counterEvidence.push(`${counters.pre} 个前置样本是持续跟随假设的反例。`);
  if(counters.ambiguous||counters.outsideWindow)result.counterEvidence.push('近时、左删失、冲突和超出 24 小时的样本保留在方向占比分母中。');
  if(counters.unmatched)result.counterEvidence.push(`${counters.unmatched} 个合约缺少本地 GMGN first-seen，其中 ${pendingTokens} 个仍在 24 小时观察窗内。`);
  if(postActivationExitTokens)result.reasons.push(`观察到 ${postActivationExitTokens} 个合约在本地 market first-seen 与本钱包买入之后卖出；这不是砸盘或盈利证明。`);
  if(qualifying(classification)){
    const frozen=qualificationEvidence(screeningEvidence),preserved=validPrevious(input.previous,input.chain,wallet,asOf,classification,frozen);
    result.qualification=preserved??{version:1,classification,knownAt:computedAt,proofHash:digest(frozen),evidence:frozen};
  }
  return result;
}
