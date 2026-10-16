import bs58 from 'bs58';
import type {Chain,Signal} from './types.js';
import type {FollowupWalletEvidence} from './wallet-history.js';
import {qualifiedWalletWithdrawal,type WalletScreeningReport} from './wallet-screening.js';
import type {MemeCatalystSnapshot} from './meme-catalyst.js';
export type {MemeCatalystSnapshot} from './meme-catalyst.js';

/** Experimental research points, never a probability, project quality rating, or trade permission. */
export const MEME_RULE_VERSION='meme-research-v1' as const;
export interface MemeMarketWindow {
  /** GMGN price_1m/5m are historical window-start prices, not percentage changes or local observations. */
  startPriceUsd?:number;buys?:number;sells?:number;buyVolumeUsd?:number;sellVolumeUsd?:number;volumeUsd?:number;
}
export interface MemeMarketSample {
  version:1;token:Signal['token'];observedAt:string;source:'gmgn_token_info'|'dexscreener_pair';priceUsd?:number;
  liquidityUsd?:number;holderCount?:number;top10HolderRate?:number;poolAddress?:string;paidBoostActive?:number;
  windows:{'1m'?:MemeMarketWindow;'5m'?:MemeMarketWindow};
}
export type MemeStage='warming'|'accelerating'|'contested'|'crowded'|'fading'|'quiet'|'insufficient';
export interface MemeComponent {
  id:'market_heat'|'trading_emotion'|'wallet_relay'|'catalyst';label:string;
  score:number|null;maxScore:number;knownPoints:number;reasons:string[];
}
export interface MemeWindowCoverage {covered:boolean;spanSec:number;sampleCount:number;}
export interface MemeMetrics {
  latestPriceUsd?:number;liquidityUsd?:number;holderCount?:number;top10HolderRate?:number;
  priceChange1mPct?:number;priceChange5mPct?:number;priceChange15mPct?:number;
  sampledGainPct?:number;sampledDrawdownPct?:number;sampledRecoveryPct?:number;
  holderChange?:number;liquidityChangePct?:number;activityAcceleration?:number;
  buys1m?:number;sells1m?:number;buyShare1m?:number;previousBuyShare1m?:number;volume1mUsd?:number;
  buys5m?:number;sells5m?:number;buyCountShare5m?:number;previousBuyCountShare5m?:number;volume5mUsd?:number;
  walletBuyUsd?:number;walletSellUsd?:number;walletBuyerCount?:number;walletSellerCount?:number;
  supportedWalletSetups?:number;withdrawnWalletSetups?:number;
  socialAuthors5m?:number;socialAuthorsPrevious5m?:number;exactCaAuthors?:number;
}
export interface MemeAssessment {
  version:1;ruleVersion:typeof MEME_RULE_VERSION;token:Signal['token'];assessedAt:string;
  score:number|null;scoreDelta:number|null;stage:MemeStage;experimental:true;researchOnly:true;
  components:MemeComponent[];
  coverage:{knownPoints:number;maxPoints:100;samples:number;observedSpanSec:number;marketFresh:boolean;
    windows:Record<'1m'|'5m'|'15m',MemeWindowCoverage>};
  metrics:MemeMetrics;reasons:string[];limitations:string[];changeReasons:string[];
}
export interface MemeAssessmentInput {
  token:Signal['token'];now:Date;samples:readonly MemeMarketSample[];catalyst?:MemeCatalystSnapshot;
  walletEvidence?:FollowupWalletEvidence;walletSetups?:WalletScreeningReport;previous?:MemeAssessment;
}
const FRESH_MS=120_000,HISTORY_MS=15*60_000,MAX_SAMPLES=512;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const time=(v:unknown):number|undefined=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):undefined;
function addr(chain:Chain,v:unknown,hash=false):string|undefined {
  if(typeof v!=='string')return;
  if(chain!=='solana')return new RegExp(`^0x[0-9a-fA-F]{${hash?64:40}}$`).test(v)&&!/^0x0+$/i.test(v)?v.toLowerCase():undefined;
  try{const bytes=bs58.decode(v);return v.length<=88&&bytes.length===(hash?64:32)&&bytes.some(b=>b!==0)?v:undefined;}catch{return;}
}
function tokenOf(v:unknown):Signal['token']|undefined {
  if(!object(v)||!['bsc','solana','robinhood'].includes(String(v.chain)))return;
  const chain=v.chain as Chain,address=addr(chain,v.address);return address?{chain,address}:undefined;
}
const sameToken=(a:unknown,b:Signal['token'])=>{const t=tokenOf(a);return !!t&&t.chain===b.chain&&t.address===b.address;};
const gmgnChain=(chain:Chain)=>chain==='solana'?'sol':chain;
function numeric(v:unknown,integer=false,positive=false):number|undefined {
  if(typeof v!=='number'&&(typeof v!=='string'||v.length>128||!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d{1,3})?$/i.test(v)))return;
  const n=Number(v);return Number.isFinite(n)&&n>=0&&n<=1e15&&(!positive||n>0)&&(!integer||Number.isSafeInteger(n))?n:undefined;
}
const round=(n:number)=>Math.round(n*100)/100;
const change=(a:number|undefined,b:number|undefined)=>a!==undefined&&b!==undefined&&a>0?round((b/a-1)*100):undefined;
const share=(buy:number|undefined,sell:number|undefined)=>buy!==undefined&&sell!==undefined&&buy+sell>0?buy/(buy+sell):undefined;
const unique=(rows:string[])=>[...new Set(rows)];

/** Only the documented token-info schema is accepted. No ATH, guessed units, or security inference. */
export function normalizeMemeMarket(raw:unknown,token:Signal['token'],observedAt:string):MemeMarketSample|undefined {
  const target=tokenOf(token),at=time(observedAt);if(!target||at===undefined||!object(raw))return;
  if(addr(target.chain,raw.address)!==target.address||Object.hasOwn(raw,'chain')&&raw.chain!==gmgnChain(target.chain))return;
  const p=raw.price;
  if(!object(p)||typeof p.price!=='string'||numeric(p.price,false,true)===undefined)return;
  if(Object.hasOwn(p,'address')&&addr(target.chain,p.address)!==target.address||Object.hasOwn(p,'chain')&&p.chain!==gmgnChain(target.chain))return;
  const sample:MemeMarketSample={version:1,token:target,observedAt:new Date(at).toISOString(),source:'gmgn_token_info',priceUsd:numeric(p.price,false,true),windows:{}};
  const liquidity=numeric(raw.liquidity),holders=numeric(raw.holder_count,true),top=object(raw.stat)?numeric(raw.stat.top_10_holder_rate):undefined;
  const pool=addr(target.chain,raw.biggest_pool_address);
  if(liquidity!==undefined)sample.liquidityUsd=liquidity;
  if(holders!==undefined)sample.holderCount=holders;
  if(top!==undefined&&top<=1)sample.top10HolderRate=top;
  if(pool&&pool!==target.address)sample.poolAddress=pool;
  for(const window of ['1m','5m'] as const){
    const result:MemeMarketWindow={};
    for(const [field,key,integer,positive] of [
      ['startPriceUsd',`price_${window}`,false,true],['buys',`buys_${window}`,true,false],['sells',`sells_${window}`,true,false],
      ['buyVolumeUsd',`buy_volume_${window}`,false,false],['sellVolumeUsd',`sell_volume_${window}`,false,false],['volumeUsd',`volume_${window}`,false,false],
    ] as const){const n=numeric(p[key],integer,positive);if(n!==undefined)result[field]=n;}
    if(Object.keys(result).length)sample.windows[window]=result;
  }
  return sample;
}

/** DEX Screener's USD price is for baseToken only; quote-token matches must not reuse that price. */
export function normalizeDexMemeMarket(raw:unknown,token:Signal['token'],observedAt:string):MemeMarketSample|undefined {
  const target=tokenOf(token),at=time(observedAt);if(!target||at===undefined||!object(raw))return;
  if(!['bsc','solana'].includes(target.chain)||raw.chainId!==target.chain||!object(raw.baseToken)||addr(target.chain,raw.baseToken.address)!==target.address)return;
  const pool=addr(target.chain,raw.pairAddress),price=typeof raw.priceUsd==='string'?numeric(raw.priceUsd,false,true):undefined;
  if(!pool||pool===target.address||price===undefined)return;
  const sample:MemeMarketSample={version:1,token:target,observedAt:new Date(at).toISOString(),source:'dexscreener_pair',priceUsd:price,poolAddress:pool,windows:{}};
  const liquidity=object(raw.liquidity)?numeric(raw.liquidity.usd):undefined;
  if(liquidity!==undefined)sample.liquidityUsd=liquidity;
  const boosts=object(raw.boosts)?numeric(raw.boosts.active,true):undefined;if(boosts!==undefined)sample.paidBoostActive=boosts;
  const window:MemeMarketWindow={},txns=object(raw.txns)&&object(raw.txns.m5)?raw.txns.m5:undefined;
  const buys=txns?numeric(txns.buys,true):undefined,sells=txns?numeric(txns.sells,true):undefined;
  if(buys!==undefined)window.buys=buys;if(sells!==undefined)window.sells=sells;
  const volume=object(raw.volume)?numeric(raw.volume.m5):undefined;if(volume!==undefined)window.volumeUsd=volume;
  // No derived start price is needed: historical percentages never substitute for local samples.
  if(Object.keys(window).length)sample.windows['5m']=window;
  return sample;
}
export function sanitizeMemeMarketSample(raw:MemeMarketSample,target:Signal['token'],now:number):MemeMarketSample|undefined {
  if(!object(raw)||raw.version!==1||!['gmgn_token_info','dexscreener_pair'].includes(raw.source)||!sameToken(raw.token,target)||!object(raw.windows))return;
  const at=time(raw.observedAt);if(at===undefined||at>now||now-at>HISTORY_MS+FRESH_MS)return;
  const result:MemeMarketSample={version:1,source:raw.source,token:target,observedAt:new Date(at).toISOString(),windows:{}};
  for(const name of ['priceUsd','liquidityUsd','holderCount','top10HolderRate','paidBoostActive'] as const){
    const n=numeric(raw[name],name==='holderCount'||name==='paidBoostActive',name==='priceUsd');
    if(n!==undefined&&(name!=='top10HolderRate'||n<=1))result[name]=n;
  }
  const pool=addr(target.chain,raw.poolAddress);if(pool&&pool!==target.address)result.poolAddress=pool;
  for(const name of ['1m','5m'] as const){
    const window=raw.windows[name];if(!object(window))continue;
    const parsed:MemeMarketWindow={};
    for(const field of ['startPriceUsd','buys','sells','buyVolumeUsd','sellVolumeUsd','volumeUsd'] as const){
      const n=numeric(window[field],field==='buys'||field==='sells',field==='startPriceUsd');if(n!==undefined)parsed[field]=n;
    }
    if(Object.keys(parsed).length)result.windows[name]=parsed;
  }
  return result;
}

/** All calculations use what was observed by now; a supplier's historical start price never fills a local gap. */
export function assessMeme(input:MemeAssessmentInput):MemeAssessment {
  const now=input.now.getTime(),target=tokenOf(input.token),validNow=Number.isFinite(now);
  const components:MemeComponent[]=[
    {id:'market_heat',label:'市场活跃度',score:null,maxScore:30,knownPoints:0,reasons:[]},
    {id:'trading_emotion',label:'交易情绪代理',score:null,maxScore:25,knownPoints:0,reasons:[]},
    {id:'wallet_relay',label:'钱包接力',score:null,maxScore:25,knownPoints:0,reasons:[]},
    {id:'catalyst',label:'叙事与传播证据',score:null,maxScore:20,knownPoints:0,reasons:[]},
  ];
  const [heat,emotion,wallet,catalyst]=components,reasons:string[]=[],limits=['EXPERIMENTAL_UNCALIBRATED_RESEARCH_POINTS','MARKET_ACTIVITY_IS_NOT_SOCIAL_SENTIMENT','SAMPLED_PEAK_NOT_MARKET_ATH','NO_PROFIT_PREDICTION','ACTIVITY_CAN_INCLUDE_WASH_TRADING'],metrics:MemeMetrics={};
  const add=(c:MemeComponent,known:number,score:number,reason?:string)=>{c.knownPoints+=known;c.score=(c.score??0)+Math.min(known,Math.max(0,score));if(reason)c.reasons.push(reason);};
  const baseToken=target??input.token;
  const byAt=new Map<string,MemeMarketSample|null>();
  if(target&&validNow)for(const raw of input.samples.slice(-MAX_SAMPLES)){
    const sample=sanitizeMemeMarketSample(raw,target,now);if(!sample)continue;
    const key=`${sample.observedAt}:${sample.source}:${sample.poolAddress??''}`,existing=byAt.get(key);
    if(existing===undefined)byAt.set(key,sample);
    else if(existing&&JSON.stringify(existing)!==JSON.stringify(sample)){byAt.set(key,null);limits.push('CONFLICTING_SAME_TIME_MARKET_SAMPLE');}
  }
  if(input.samples.length>MAX_SAMPLES)limits.push('MARKET_SAMPLES_TRUNCATED');
  const samples=[...byAt.values()].filter((v):v is MemeMarketSample=>!!v).sort((a,b)=>a.observedAt.localeCompare(b.observedAt));
  const latest=samples.at(-1),first=samples[0],latestMs=latest?time(latest.observedAt)!:0;
  const fresh=!!latest&&now-latestMs<=FRESH_MS;
  const span=latest&&first?(latestMs-time(first.observedAt)!)/1000:0;
  // A pool change starts a new comparable segment. Returning to an old pool does not bridge the gap.
  let segment:MemeMarketSample[]=[];
  if(latest?.poolAddress){
    for(let i=samples.length-1;i>=0;i--){if(samples[i].poolAddress!==latest.poolAddress||samples[i].source!==latest.source)break;segment.unshift(samples[i]);}
    if(segment.length<samples.length)limits.push('POOL_OR_SOURCE_CHANGE_COMPARISONS_RESET');
  }else if(latest)limits.push('POOL_IDENTITY_MISSING_PRICE_TREND_UNAVAILABLE');
  const coverage={} as MemeAssessment['coverage']['windows'];
  for(const [name,ms] of [['1m',60_000],['5m',300_000],['15m',900_000]] as const){
    const threshold=latestMs-ms,anchor=segment.filter(s=>time(s.observedAt)!<=threshold&&threshold-time(s.observedAt)!<=FRESH_MS).at(-1);
    const rows=anchor?segment.filter(s=>s.observedAt>=anchor.observedAt):[];
    const covered=!!anchor&&rows.length>=2&&rows.every((s,i)=>!i||time(s.observedAt)!-time(rows[i-1].observedAt)!<=FRESH_MS);
    coverage[name]={covered,spanSec:anchor?(latestMs-time(anchor.observedAt)!)/1000:0,sampleCount:rows.length};
    if(covered){const delta=change(anchor!.priceUsd,latest?.priceUsd);if(delta!==undefined)metrics[`priceChange${name}Pct` as 'priceChange1mPct']=delta;}
  }
  if(latest){
    if(latest.priceUsd!==undefined)metrics.latestPriceUsd=latest.priceUsd;
    if(latest.liquidityUsd!==undefined)metrics.liquidityUsd=latest.liquidityUsd;
    if(latest.holderCount!==undefined)metrics.holderCount=latest.holderCount;
    if(latest.top10HolderRate!==undefined)metrics.top10HolderRate=latest.top10HolderRate;
  }
  const recentPrevious=samples.slice(0,-1).filter(s=>s.source===latest?.source&&latestMs-time(s.observedAt)!>=20_000&&latestMs-time(s.observedAt)!<=FRESH_MS).at(-1);
  const poolPrevious=recentPrevious&&latest?.poolAddress&&recentPrevious.poolAddress===latest.poolAddress&&segment.includes(recentPrevious)?recentPrevious:undefined;
  const priced=segment.filter(s=>s.priceUsd!==undefined),peak=priced.length?Math.max(...priced.map(s=>s.priceUsd!)):undefined;
  if(priced.length>=2&&latest?.priceUsd!==undefined&&peak!==undefined){
    metrics.sampledGainPct=change(priced[0].priceUsd,latest.priceUsd);
    metrics.sampledDrawdownPct=round((1-latest.priceUsd/peak)*100);
    const peakIndex=priced.findIndex(s=>s.priceUsd===peak),afterPeak=priced.slice(peakIndex),trough=Math.min(...afterPeak.map(s=>s.priceUsd!));
    if(afterPeak.length>=3&&trough<peak)metrics.sampledRecoveryPct=round((latest.priceUsd-trough)/(peak-trough)*100);
  }
  if(fresh&&latest){
    const one=latest.windows['1m'],five=latest.windows['5m'];
    if(latest.source==='dexscreener_pair')limits.push('SINGLE_POOL_ACTIVITY_NOT_WHOLE_TOKEN');
    else limits.push('VENDOR_TOKEN_ACTIVITY_SCOPE');
    if(latest.paidBoostActive)limits.push('PAID_BOOST_NOT_ORGANIC_PROPAGATION');
    if(one?.buys!==undefined)metrics.buys1m=one.buys;if(one?.sells!==undefined)metrics.sells1m=one.sells;
    if(one?.volumeUsd!==undefined)metrics.volume1mUsd=one.volumeUsd;
    if(five?.buys!==undefined)metrics.buys5m=five.buys;if(five?.sells!==undefined)metrics.sells5m=five.sells;
    if(five?.volumeUsd!==undefined)metrics.volume5mUsd=five.volumeUsd;
    if(one?.buys!==undefined&&one.sells!==undefined){
      const trades=one.buys+one.sells;add(heat,8,trades>=50?8:trades>=20?6:trades>=5?3:trades>0?1:0,trades>=20?'MARKET_TRADING_ACTIVE':'MARKET_TRADING_THIN');
    }else if(five?.buys!==undefined&&five.sells!==undefined){
      const trades=(five.buys+five.sells)/5;add(heat,8,trades>=50?8:trades>=20?6:trades>=5?3:trades>0?1:0,trades>=20?'MARKET_TRADING_ACTIVE':'MARKET_TRADING_THIN');
      limits.push('ACTIVITY_FROM_FIVE_MINUTE_WINDOW');
    }
    if(one?.volumeUsd!==undefined&&five?.volumeUsd!==undefined&&five.volumeUsd>=one.volumeUsd){
      const preceding=(five.volumeUsd-one.volumeUsd)/4;
      // A zero preceding window is a new activity burst, not infinite acceleration.
      const acceleration=preceding>0?one.volumeUsd/preceding:one.volumeUsd>0?4:0;
      metrics.activityAcceleration=round(Math.min(acceleration,100));
      add(heat,10,acceleration>=2?10:acceleration>=1.25?7:acceleration>=0.8?4:acceleration>0?1:0,
        acceleration>=1.25?'ACTIVITY_ACCELERATING':acceleration<0.8?'ACTIVITY_COOLING':'ACTIVITY_STEADY');
    }else if(one?.volumeUsd!==undefined&&five?.volumeUsd!==undefined)limits.push('VENDOR_OVERLAPPING_VOLUME_INCONSISTENT');
    else if(five?.volumeUsd!==undefined&&poolPrevious?.windows['5m']?.volumeUsd!==undefined){
      const oldVolume=poolPrevious.windows['5m']!.volumeUsd!;
      const acceleration=oldVolume>0?five.volumeUsd/oldVolume:five.volumeUsd>0?4:0;
      metrics.activityAcceleration=round(Math.min(acceleration,100));
      add(heat,10,acceleration>=1.5?10:acceleration>=1.1?7:acceleration>=0.9?4:acceleration>0?1:0,
        acceleration>=1.1?'ACTIVITY_ACCELERATING':acceleration<0.9?'ACTIVITY_COOLING':'ACTIVITY_STEADY');
      limits.push('ROLLING_VOLUME_WINDOWS_OVERLAP_NOT_ADDITIVE');
    }
    if(recentPrevious?.holderCount!==undefined&&latest.holderCount!==undefined){
      metrics.holderChange=latest.holderCount-recentPrevious.holderCount;
      const growth=recentPrevious.holderCount>0?metrics.holderChange/recentPrevious.holderCount:0;
      add(heat,6,growth>=0.05?6:growth>0?4:growth===0?2:0,growth>0?'HOLDER_BASE_GROWING':growth<0?'HOLDER_BASE_SHRINKING':'HOLDER_BASE_STABLE');
    }
    if(poolPrevious?.liquidityUsd!==undefined&&latest.liquidityUsd!==undefined&&poolPrevious.liquidityUsd>0){
      metrics.liquidityChangePct=change(poolPrevious.liquidityUsd,latest.liquidityUsd);
      add(heat,6,metrics.liquidityChangePct!>=5?6:metrics.liquidityChangePct!>=-2?4:metrics.liquidityChangePct!>=-10?2:0,
        metrics.liquidityChangePct!< -10?'LIQUIDITY_WITHDRAWING':'LIQUIDITY_COMPARABLE');
    }
    const buyShare=share(one?.buyVolumeUsd,one?.sellVolumeUsd);
    if(buyShare!==undefined){
      metrics.buyShare1m=round(buyShare);
      add(emotion,12,buyShare>=0.7?12:buyShare>=0.58?9:buyShare>=0.45?5:buyShare>=0.3?2:0,
        buyShare>=0.58?'BUY_FLOW_DOMINANT':buyShare<0.45?'SELL_FLOW_DOMINANT':'FLOW_CONTESTED');
    }else if(one?.buyVolumeUsd===0&&one.sellVolumeUsd===0)add(emotion,12,0,'NO_RECENT_TRADING_FLOW');
    else if(five?.buys!==undefined&&five.sells!==undefined){
      const countShare=share(five.buys,five.sells);metrics.buyCountShare5m=countShare===undefined?undefined:round(countShare);
      add(emotion,6,countShare===undefined?0:countShare>=0.7?6:countShare>=0.58?4:countShare>=0.45?2:0,
        countShare===undefined?'NO_RECENT_TRADING_FLOW':countShare>=0.58?'BUY_COUNT_DOMINANT':countShare<0.45?'SELL_COUNT_DOMINANT':'TRADE_COUNT_CONTESTED');
      const oldFive=poolPrevious?.windows['5m'],oldCount=share(oldFive?.buys,oldFive?.sells);
      if(oldCount!==undefined){metrics.previousBuyCountShare5m=round(oldCount);
        if(countShare!==undefined&&countShare<oldCount-0.15)reasons.push('BUY_COUNT_DETERIORATING');}
      limits.push('TRADE_COUNT_IMBALANCE_NOT_DOLLAR_FLOW');
    }
    const oldOne=recentPrevious?.windows['1m'],oldShare=share(oldOne?.buyVolumeUsd,oldOne?.sellVolumeUsd);
    if(oldShare!==undefined){metrics.previousBuyShare1m=round(oldShare);
      if(buyShare!==undefined&&buyShare<oldShare-0.15)reasons.push('BUY_FLOW_DETERIORATING');}
    if(metrics.sampledDrawdownPct!==undefined)add(emotion,6,metrics.sampledDrawdownPct<=5?6:metrics.sampledDrawdownPct<=15?4:metrics.sampledDrawdownPct<=30?2:0,
      metrics.sampledDrawdownPct>15?'SAMPLED_PEAK_PULLBACK':'PRICE_HOLDING_SAMPLED_HIGH');
    if(metrics.sampledRecoveryPct!==undefined)add(emotion,4,metrics.sampledRecoveryPct>=70?4:metrics.sampledRecoveryPct>=30?2:0,
      metrics.sampledRecoveryPct>=30?'PULLBACK_RECOVERY_OBSERVED':'PULLBACK_RECOVERY_WEAK');
    if(metrics.priceChange1mPct!==undefined)add(emotion,3,metrics.priceChange1mPct>0?3:metrics.priceChange1mPct>=-5?1:0,
      metrics.priceChange1mPct>0?'OBSERVED_PRICE_RISING':'OBSERVED_PRICE_SOFTENING');
  }else limits.push(latest?'MARKET_SAMPLE_STALE':'MARKET_SAMPLE_UNAVAILABLE');

  // Wallet volumes are recomputed from deduplicated, scoped transactions. Vendor totals and labels earn no points.
  const evidence=input.walletEvidence,validEvidence=target&&evidence&&sameToken({chain:evidence.chain,address:evidence.address},target)&&
    time(evidence.fromAt)!<=now&&time(evidence.untilAt)!<=now&&time(evidence.untilAt)!>=now-FRESH_MS&&evidence.coverage!=='unavailable';
  if(validEvidence){
    const trades=new Map<string,NonNullable<typeof evidence>['trades'][number]|null>();
    for(const row of evidence.trades.slice(0,500)){
      const event=time(row.eventAt),observed=time(row.observedAt),who=addr(target!.chain,row.wallet),tx=addr(target!.chain,row.txHash,true),usd=numeric(row.volumeUsd);
      if(event===undefined||observed===undefined||event>now||observed>now||event<now-FRESH_MS||event<time(evidence.fromAt)!||
        event>time(evidence.untilAt)!||observed>time(evidence.untilAt)!||observed<event||!who||!tx||usd===undefined||!['buy','sell'].includes(row.side))continue;
      const key=`${tx}:${who}`,existing=trades.get(key);
      if(existing===undefined)trades.set(key,row);else if(existing&&(existing.side!==row.side||existing.volumeUsd!==usd))trades.set(key,null);
    }
    const values=[...trades.values()].filter((v):v is NonNullable<typeof v>=>!!v),buys=values.filter(t=>t.side==='buy'),sells=values.filter(t=>t.side==='sell');
    if(values.length){
      metrics.walletBuyUsd=buys.reduce((n,t)=>n+t.volumeUsd,0);metrics.walletSellUsd=sells.reduce((n,t)=>n+t.volumeUsd,0);
      metrics.walletBuyerCount=new Set(buys.map(t=>addr(target!.chain,t.wallet))).size;
      metrics.walletSellerCount=new Set(sells.map(t=>addr(target!.chain,t.wallet))).size;
      const flow=share(metrics.walletBuyUsd,metrics.walletSellUsd);
      if(flow!==undefined)add(wallet,12,flow>=0.75?12:flow>=0.55?8:flow>=0.4?4:0,flow<0.4?'SAMPLED_WALLETS_SELLING':'SAMPLED_WALLET_BUY_SUPPORT');
      add(wallet,5,metrics.walletBuyerCount>=5?5:metrics.walletBuyerCount>=3?3:metrics.walletBuyerCount?1:0,'WALLET_DIVERSITY_IS_SAMPLED');
    }else limits.push('NO_FRESH_WALLET_TRANSACTIONS');
    limits.push('WALLET_SAMPLE_NOT_WHOLE_MARKET','WALLET_ASSOCIATION_NOT_OWNERSHIP_PROOF');
    if(evidence.coverage==='truncated')limits.push('WALLET_EVIDENCE_TRUNCATED');
  }else limits.push('WALLET_EVIDENCE_UNAVAILABLE_OR_STALE');
  const setups=input.walletSetups;
  if(target&&setups&&setups.version===1&&setups.scope==='research_priority'&&setups.ownership==='unknown'&&setups.sampleOnly&&
    sameToken(setups.token,target)&&time(setups.checkedAt)!<=now&&time(setups.checkedAt)!>=now-FRESH_MS&&time(setups.validUntil)!>=now){
    const valid=setups.setups.filter(s=>s.trigger.chain===target.chain&&addr(target.chain,s.trigger.tokenAddress)===target.address&&
      !!addr(target.chain,s.wallet)&&addr(target.chain,s.wallet)===addr(target.chain,s.trigger.wallet)&&
      time(s.trigger.eventAt)!<=now&&time(s.trigger.eventAt)!>=now-FRESH_MS&&time(s.trigger.observedAt)!<=now&&
      time(s.trigger.observedAt)!>=time(s.trigger.eventAt)!&&addr(target.chain,s.trigger.txHash,true));
    const supported=valid.filter(s=>s.status==='supported'),withdrawn=valid.filter(s=>qualifiedWalletWithdrawal(s));
    metrics.supportedWalletSetups=new Set(supported.map(s=>addr(target.chain,s.wallet))).size;metrics.withdrawnWalletSetups=new Set(withdrawn.map(s=>addr(target.chain,s.wallet))).size;
    if(valid.length)add(wallet,8,withdrawn.length?0:supported.some(s=>s.route==='precursor'&&s.stage==='public_entry_observed')?8:supported.length?5:1,
      withdrawn.length?'PROFILED_WALLET_WITHDRAWAL':supported.length?'PROFILED_RELAY_OBSERVED':'PROFILED_RELAY_PENDING');
  }

  scoreCatalyst(input.catalyst,target,now,catalyst,metrics,limits,add);
  components.forEach(c=>{if(c.score!==null)c.score=round(c.score);});
  const known=components.reduce((sum,c)=>sum+c.knownPoints,0);
  let score:number|null=fresh&&samples.length>=2&&span>=20&&known>=30?Math.round(components.reduce((sum,c)=>sum+(c.score??0),0)):null;
  let stage:MemeStage='insufficient';
  const deterioration=reasons.includes('BUY_FLOW_DETERIORATING')||reasons.includes('BUY_COUNT_DETERIORATING'),selling=(metrics.buyShare1m!==undefined&&metrics.buyShare1m<0.4)||
    (metrics.buyCountShare5m!==undefined&&metrics.buyCountShare5m<0.4)||
    (metrics.walletSellUsd!==undefined&&metrics.walletBuyUsd!==undefined&&metrics.walletSellUsd>metrics.walletBuyUsd*1.5)||!!metrics.withdrawnWalletSetups;
  if(score!==null){
    const drawdown=metrics.sampledDrawdownPct??0,acceleration=metrics.activityAcceleration;
    if(selling&&(drawdown>=15||acceleration!==undefined&&acceleration<0.8))stage='fading';
    else if((metrics.sampledGainPct??0)>=100&&(latest?.top10HolderRate??0)>=0.5)stage='crowded';
    else if(selling||deterioration||drawdown>=15)stage='contested';
    else if(acceleration!==undefined&&acceleration>=1.25&&(metrics.buyShare1m??metrics.buyCountShare5m??0)>=0.58&&
      ((metrics.holderChange??0)>0||(metrics.priceChange1mPct??0)>0))stage='accelerating';
    else if((acceleration??0)>=1||(metrics.buyShare1m??metrics.buyCountShare5m??0)>=0.58||metrics.supportedWalletSetups)stage='warming';
    else stage='quiet';
  }else reasons.push(!fresh?'WAITING_FOR_FRESH_MARKET':samples.length<2||span<20?'WAITING_FOR_COMPARABLE_SAMPLES':'INSUFFICIENT_MEASURED_COVERAGE');
  // Market fragility affects research reliability; contract safety remains a separate eligibility gate.
  if(fresh&&latest?.liquidityUsd!==undefined&&latest.liquidityUsd<5000){
    reasons.push('THIN_LIQUIDITY_SCORE_CAPPED');if(score!==null)score=Math.min(score,29);if(stage==='accelerating'||stage==='warming')stage='contested';
  }else if(latest?.liquidityUsd===undefined){
    limits.push('LIQUIDITY_UNKNOWN_SCORE_CAPPED');if(score!==null)score=Math.min(score,39);
  }
  if(fresh&&latest?.top10HolderRate!==undefined&&latest.top10HolderRate>0.8){
    reasons.push('EXTREME_CONCENTRATION_SCORE_CAPPED');if(score!==null)score=Math.min(score,39);if(stage==='accelerating')stage='crowded';
  }
  if(known<100)limits.push('MISSING_DIMENSIONS_ARE_NOT_RENORMALIZED');
  const previous=input.previous,comparable=target&&previous?.ruleVersion===MEME_RULE_VERSION&&sameToken(previous.token,target)&&time(previous.assessedAt)!<=now;
  const scoreDelta=comparable&&previous.score!==null&&score!==null?score-previous.score:null,changeReasons:string[]=[];
  if(comparable){
    if(previous.stage!==stage)changeReasons.push(`STAGE_${previous.stage.toUpperCase()}_TO_${stage.toUpperCase()}`);
    for(const component of components){const old=previous.components.find(c=>c.id===component.id);
      if(old?.score!==component.score)changeReasons.push(`${component.id.toUpperCase()}_${component.score===null?'UNAVAILABLE':old?.score===null||old?.score===undefined?'NOW_MEASURED':component.score>old.score?'IMPROVED':'WEAKENED'}`);}
    if(previous.coverage.knownPoints!==known)changeReasons.push('EVIDENCE_COVERAGE_CHANGED');
  }
  return {version:1,ruleVersion:MEME_RULE_VERSION,token:baseToken,assessedAt:validNow?input.now.toISOString():'1970-01-01T00:00:00.000Z',
    score,scoreDelta,stage,experimental:true,researchOnly:true,components,coverage:{knownPoints:known,maxPoints:100,samples:samples.length,observedSpanSec:span,marketFresh:fresh,windows:coverage},
    metrics,reasons:unique(reasons),limitations:unique(limits),changeReasons};
}

function scoreCatalyst(snapshot:MemeCatalystSnapshot|undefined,target:Signal['token']|undefined,now:number,component:MemeComponent,metrics:MemeMetrics,limits:string[],
  add:(c:MemeComponent,known:number,score:number,reason?:string)=>void):void {
  if(!Number.isFinite(now)||!snapshot||!target||!sameToken(snapshot.token,target)||time(snapshot.observedAt)===undefined||time(snapshot.observedAt)!>now||
    time(snapshot.expiresAt)===undefined||time(snapshot.expiresAt)!<now){limits.push('CATALYST_UNAVAILABLE_OR_STALE');return;}
  const posts=snapshot.posts.filter(p=>time(p.publishedAt)!<=now&&time(p.fetchedAt)!<=now&&time(p.publishedAt)!>=now-30*60_000);
  // We use the retained post evidence, never source-tweet inventories, notification counts, or supplier scores.
  const uniquePosts=[...new Map(posts.map(p=>[p.id,p])).values()],caPosts=uniquePosts.filter(p=>p.mentionsExactCa),recent=caPosts.filter(p=>time(p.publishedAt)!>=now-5*60_000),
    prior=caPosts.filter(p=>time(p.publishedAt)!<now-5*60_000&&time(p.publishedAt)!>=now-10*60_000);
  const recentAuthors=new Set(recent.map(p=>p.authorId)),priorAuthors=new Set(prior.map(p=>p.authorId));
  if(uniquePosts.length){
    metrics.socialAuthors5m=recentAuthors.size;metrics.socialAuthorsPrevious5m=priorAuthors.size;metrics.exactCaAuthors=new Set(caPosts.map(p=>p.authorId)).size;
    add(component,10,recentAuthors.size>=5?10:recentAuthors.size>=3?7:recentAuthors.size?3:0,recentAuthors.size>priorAuthors.size?'SAMPLED_CA_PROPAGATION_GROWING':'SAMPLED_CA_PROPAGATION_LIMITED');
    limits.push('SOCIAL_SAMPLE_NOT_COMPLETE_SEARCH');
  }else limits.push('SOCIAL_POST_EVIDENCE_MISSING');
  const celebritySignals=snapshot.celebrities.signals.filter(s=>s.kind==='ca_post'&&s.evidenceId&&
    caPosts.some(p=>p.id===s.evidenceId&&time(p.publishedAt)!>=now-15*60_000));
  if(celebritySignals.length){
    const newest=Math.max(...caPosts.filter(p=>celebritySignals.some(s=>s.evidenceId===p.id)).map(p=>time(p.publishedAt)!));
    // Retrieved author identity remains only partial unless the catalyst collector separately verifies it.
    const verified=snapshot.celebrities.accountIdentityCoverage==='verified';
    add(component,6,(verified?6:2)*Math.max(0,1-(now-newest)/(15*60_000)),'CELEBRITY_CA_MENTION_OBSERVED');
    limits.push('CA_MENTION_IS_NOT_ENDORSEMENT');
  }else if(snapshot.celebrities.signals.some(s=>s.kind==='profile_link'&&s.relation==='project_link'&&s.verification==='project_link')){
    // Token-scoped project metadata is a weak research association only. Multiple profiles never stack.
    add(component,2,1,'PROJECT_CELEBRITY_ASSOCIATION_UNVERIFIED');limits.push('CELEBRITY_PROFILE_LINK_NOT_BACKING');
  }
  const supplier=snapshot.supplier,generated= supplier?time(supplier.generatedAt):undefined;
  if(supplier&&supplier.identityMatches&&supplier.fresh&&generated!==undefined&&generated<=now&&now-generated<=30*60_000){
    add(component,4,2*Math.max(0,1-(now-generated)/(30*60_000)),'SUPPLIER_NARRATIVE_CONTEXT_ONLY');
    limits.push('SUPPLIER_AI_CLAIMS_UNVERIFIED');
  }
}
