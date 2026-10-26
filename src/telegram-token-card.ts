import bs58 from 'bs58';
import type {NativeBalance} from './native-balance.js';
import {GmgnError,type GmgnClient} from './providers/gmgn-client.js';
import {normalizeGmgnSolanaTokenCard,type GmgnSolanaTokenCardDto} from './providers/gmgn-solana-token-card.js';

const SOL='So11111111111111111111111111111111111111112';
const SYSTEM='11111111111111111111111111111111';
const CACHE_TTL_MS=10_000;
const MAX_CACHE_ITEMS=256;
const REQUEST_BUDGET_MS=7_000;
const BALANCE_BUDGET_MS=3_500;

type GmgnReader=Pick<GmgnClient,'get'> & Partial<Pick<GmgnClient,'withSignal'>>;
export interface TelegramTokenPosition {
  amountAtomic:string;
  decimals:number;
  sellQuote?:{inputAmount:string;outputAmount:string;quotedAt:string;expiresAt:string};
  costBasis?:{solLamports:string;tokenAtoms:string;excludesNetworkFees:true};
}
export interface TelegramTokenCardOptions {
  client:GmgnReader;
  wallet?:string;
  readBalance?:()=>Promise<NativeBalance>;
  position?:(mint:string)=>TelegramTokenPosition|undefined;
  /** Heavy Top5 read may yield to an active live-entry queue. Core card fields remain available. */
  includeHolders?:()=>boolean;
  now?:()=>Date;
  cacheTtlMs?:number;
}
export interface TelegramTokenCardResult {
  address:string;
  text:string;
  gmgnAvailable:boolean;
  partial:boolean;
}
interface Cached {expiresAt:number;result:TelegramTokenCardResult;}

export function canonicalSolanaTokenAddress(value:unknown):value is string {
  if(typeof value!=='string'||value.length<32||value.length>44||value===SOL||value===SYSTEM)return false;
  try {const decoded=bs58.decode(value);return decoded.length===32&&decoded.some(byte=>byte!==0)&&bs58.encode(decoded)===value;}
  catch{return false;}
}
const safeFailure=(error:unknown):string=>error instanceof GmgnError?error.reason:'GMGN_REQUEST_FAILED';
const bounded=<T>(promise:Promise<T>,milliseconds:number):Promise<T|undefined>=>new Promise(resolve=>{
  let complete=false;
  const timer=setTimeout(()=>{if(!complete){complete=true;resolve(undefined);}},milliseconds);timer.unref();
  promise.then(value=>{if(!complete){complete=true;clearTimeout(timer);resolve(value);}},()=>{if(!complete){complete=true;clearTimeout(timer);resolve(undefined);}});
});
function number(value:string|undefined):number|undefined {
  if(value===undefined||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))return;
  const parsed=Number(value);return Number.isFinite(parsed)?parsed:undefined;
}
function usd(value:string|undefined,compact=true):string {
  const parsed=number(value);if(parsed===undefined)return '未取得';
  if(compact&&parsed>=1_000_000_000)return `$${(parsed/1_000_000_000).toFixed(parsed>=10_000_000_000?1:2).replace(/\.0+$/,'')}B`;
  if(compact&&parsed>=1_000_000)return `$${(parsed/1_000_000).toFixed(parsed>=10_000_000?1:2).replace(/\.0+$/,'')}M`;
  if(compact&&parsed>=1_000)return `$${(parsed/1_000).toFixed(parsed>=10_000?1:2).replace(/\.0+$/,'')}K`;
  if(parsed>=1)return '$'+parsed.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(parsed===0)return '$0';
  return '$'+parsed.toPrecision(8).replace(/(?:\.0+|(?:(\.\d*?)0+))$/,'$1');
}
function percent(value:string|undefined):string {
  const parsed=number(value);return parsed===undefined?'未取得':`${parsed.toFixed(2)}%`;
}
function authorityState(value:'yes'|'no'|'unknown'):string {
  return value==='yes'?'✅ 已放弃':value==='no'?'⚠️ 未放弃':'未取得';
}
function liquidityState(card:GmgnSolanaTokenCardDto):string {
  const value=card.safety.liquidityBurned;
  if(value==='yes')return '✅ 已燃烧';
  if(value==='no')return '⚠️ 未确认';
  if(card.market.launchpad&&card.market.launchpadStatus!=='migrated')return '曲线阶段';
  return '未取得';
}
function duration(seconds:number|undefined):string {
  if(seconds===undefined||!Number.isSafeInteger(seconds)||seconds<0)return '未取得';
  if(seconds<60)return `${seconds} 秒`;
  if(seconds<3600)return `${Math.floor(seconds/60)} 分钟`;
  if(seconds<86400)return `${Math.floor(seconds/3600)} 小时`;
  return `${Math.floor(seconds/86400)} 天`;
}
function decimalAtomic(amount:string,decimals:number):string|undefined {
  if(!/^(?:0|[1-9]\d*)$/.test(amount)||!Number.isSafeInteger(decimals)||decimals<0||decimals>30)return;
  const padded=amount.padStart(decimals+1,'0');
  return decimals===0?padded:(padded.slice(0,-decimals)+'.'+padded.slice(-decimals)).replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1');
}
function positionGain(position:TelegramTokenPosition|undefined,now:number):number|undefined {
  const quote=position?.sellQuote,basis=position?.costBasis;
  if(!position||!quote||!basis||basis.excludesNetworkFees!==true||quote.inputAmount!==position.amountAtomic||
    ![position.amountAtomic,quote.inputAmount,quote.outputAmount,basis.solLamports,basis.tokenAtoms]
      .every(value=>/^[1-9]\d{0,77}$/.test(value)))return;
  const quotedAt=Date.parse(quote.quotedAt),expiresAt=Date.parse(quote.expiresAt);
  if(!Number.isFinite(now)||!Number.isFinite(quotedAt)||!Number.isFinite(expiresAt)||quotedAt>now||expiresAt<=now||expiresAt<quotedAt)return;
  const denominator=BigInt(quote.inputAmount)*BigInt(basis.solLamports);
  if(denominator===0n)return;
  const hundredths=BigInt(quote.outputAmount)*BigInt(basis.tokenAtoms)*10_000n/denominator-10_000n;
  if(hundredths>BigInt(Number.MAX_SAFE_INTEGER)||hundredths<BigInt(Number.MIN_SAFE_INTEGER))return;
  return Number(hundredths)/100;
}
function positionLine(position:TelegramTokenPosition|undefined,now:number):string|undefined {
  if(!position)return;
  const gain=positionGain(position,now);
  return gain===undefined?'持仓盈亏：暂不可用（报价待核验）':
    `持仓盈亏：${gain>=0?'+':''}${gain.toFixed(2)}%（当前可卖报价；未扣网络费和小费）`;
}
function solBalance(balance:NativeBalance|undefined):string {
  if(balance?.status!=='verified'||balance.amount===undefined)return '暂不可用';
  return `${decimalAtomic(balance.amount,9)??'暂不可用'} SOL`;
}
function poolRatio(card:GmgnSolanaTokenCardDto):string|undefined {
  const pool=number(card.pool?.liquidityUsd),cap=number(card.market.marketCapUsd);
  if(pool===undefined||cap===undefined||cap<=0)return;
  const result=pool/cap*100;return Number.isFinite(result)?result.toFixed(2):undefined;
}
function launchProgress(card:GmgnSolanaTokenCardDto):string|undefined {
  if(!card.market.launchpad||card.market.launchpadStatus==='migrated'||card.market.launchpadProgressPercent===undefined)return;
  return percent(card.market.launchpadProgressPercent);
}
function render(card:GmgnSolanaTokenCardDto,_wallet:string|undefined,balance:NativeBalance|undefined,
  position:TelegramTokenPosition|undefined,partial:boolean,now:number):string {
  const title=[card.token.name,card.token.symbol].filter((value,index,all)=>value&&all.indexOf(value)===index).join(' / ');
  const pool=card.pool?.liquidityUsd,ratio=poolRatio(card),progress=launchProgress(card);
  const positionAmount=position?decimalAtomic(position.amountAtomic,position.decimals):undefined;
  const account=[`SOL 余额：${solBalance(balance)}`,
    ...(positionAmount?[`本币持仓：${positionAmount} ${card.token.symbol}`]:[])].join(' ｜ ');
  const lines=[`【合约详情】${title} · Solana`,`CA：${card.address}`,'',
    '💼 账户',account,...(positionLine(position,now)?[positionLine(position,now)!]:[]),'',
    '📊 行情',`价格：${usd(card.market.priceUsd,false)}`,
    `估算市值：${usd(card.market.marketCapUsd)} ｜ 池子储备：${usd(pool)}${ratio?`（市值占比 ${ratio}%）`:''}`,
    `持有人：${card.market.holderCount??'未取得'} ｜ 币龄：${duration(card.market.ageSeconds)}`,
    ...(progress?[`内盘进度：${progress}`]:[]),'',
    '🛡 安全',`权限：铸币 ${authorityState(card.safety.mintAuthorityRenounced)} ｜ 冻结 ${authorityState(card.safety.freezeAuthorityRenounced)}`,
    `流动性：${liquidityState(card)}`,
    `Top10 持仓：${percent(card.holderRisk.top10HoldingPercent)} ｜ 捆绑：${percent(card.holderRisk.bundlerVolumePercent)} ｜ 老鼠仓：${percent(card.holderRisk.ratTraderVolumePercent)}`,
    `Top5 钱包持仓：${card.holders.topFive.length?card.holders.topFive.map(row=>percent(row.holdingPercent)).join(' · '):'未取得'}`,
    ...(partial?['','ℹ️ 部分 GMGN 数据暂未返回，缺失项已标为「未取得」。']:[])];
  return lines.join('\n');
}
function fallback(address:string,_wallet:string|undefined,balance:NativeBalance|undefined,position:TelegramTokenPosition|undefined,
  reason:string,now:number):string {
  const positionAmount=position?decimalAtomic(position.amountAtomic,position.decimals):undefined;
  return [`【合约详情】Solana`,`CA：${address}`,'',`💼 SOL 余额：${solBalance(balance)}`,
    ...(positionAmount?[`本币持仓：${positionAmount}`]:[]),...(positionLine(position,now)?[positionLine(position,now)!]:[]),'',
    '⚠️ GMGN 详情暂未返回',`状态码：${reason}`,'可点击刷新重试。'].join('\n');
}

/** Read-only GMGN/RPC card loader. It never creates, confirms or broadcasts an order. */
export class TelegramTokenCardService {
  private readonly now:()=>Date;
  private readonly ttl:number;
  private readonly cache=new Map<string,Cached>();
  private readonly inFlight=new Map<string,Promise<TelegramTokenCardResult>>();
  constructor(private readonly options:TelegramTokenCardOptions){
    if(!options?.client||typeof options.client.get!=='function'||options.wallet!==undefined&&!canonicalWallet(options.wallet)||
      options.readBalance!==undefined&&typeof options.readBalance!=='function'||options.position!==undefined&&typeof options.position!=='function')
      throw Error('TELEGRAM_TOKEN_CARD_CONFIG_INVALID');
    if(options.includeHolders!==undefined&&typeof options.includeHolders!=='function')throw Error('TELEGRAM_TOKEN_CARD_CONFIG_INVALID');
    this.now=options.now??(()=>new Date());this.ttl=Math.max(0,Math.min(60_000,Math.floor(options.cacheTtlMs??CACHE_TTL_MS)));
  }
  async get(address:string,refresh=false):Promise<TelegramTokenCardResult>{
    if(!canonicalSolanaTokenAddress(address))throw Error('TELEGRAM_TOKEN_CARD_ADDRESS_INVALID');
    const now=this.now().getTime();if(!Number.isFinite(now))throw Error('TELEGRAM_TOKEN_CARD_CLOCK_INVALID');
    const cached=this.cache.get(address);if(!refresh&&cached&&cached.expiresAt>now)return cached.result;
    const active=this.inFlight.get(address);if(active)return active;
    const job=this.load(address).then(result=>{
      this.cache.delete(address);this.cache.set(address,{result,expiresAt:this.now().getTime()+this.ttl});
      while(this.cache.size>MAX_CACHE_ITEMS)this.cache.delete(this.cache.keys().next().value!);
      return result;
    }).finally(()=>this.inFlight.delete(address));
    this.inFlight.set(address,job);return job;
  }
  private async load(address:string):Promise<TelegramTokenCardResult>{
    const balancePromise=this.options.readBalance?bounded(this.options.readBalance(),BALANCE_BUDGET_MS):Promise.resolve(undefined);
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),REQUEST_BUDGET_MS);timer.unref();
    const reader=typeof this.options.client.withSignal==='function'?this.options.client.withSignal(controller.signal):this.options.client;
    let info:unknown,reason='GMGN_REQUEST_FAILED';
    try {info=await reader.get('/v1/token/info',{chain:'sol',address},1);}
    catch(error){reason=safeFailure(error);}
    let security:unknown,holders:unknown,partial=false;
    if(info!==undefined){
      let includeHolders=false;try{includeHolders=this.options.includeHolders?.()??true;}catch{/* Fail light under uncertain live-entry state. */}
      const settled=await Promise.allSettled([reader.get('/v1/token/security',{chain:'sol',address},1),
        ...(includeHolders?[reader.get('/v1/market/token_top_holders',
          {chain:'sol',address,limit:10,order_by:'amount_percentage',direction:'desc'},5)]:[])]);
      if(settled[0].status==='fulfilled')security=settled[0].value;else partial=true;
      if(!includeHolders)partial=true;
      else if(settled[1]?.status==='fulfilled')holders=settled[1].value;else partial=true;
    }
    clearTimeout(timer);
    const balance=await balancePromise,position=this.options.position?.(address),now=this.now().getTime();
    if(info===undefined)return {address,text:fallback(address,this.options.wallet,balance,position,reason,now),gmgnAvailable:false,partial:true};
    const base={token:{chain:'solana',address},fetchedAt:this.now().toISOString(),info};
    let normalized=normalizeGmgnSolanaTokenCard({...base,...(security!==undefined?{security}:{}),
      ...(holders!==undefined?{topHolders:{chain:'sol',address,data:holders}}:{})});
    if(!normalized.ok&&holders!==undefined){partial=true;normalized=normalizeGmgnSolanaTokenCard({...base,...(security!==undefined?{security}:{})});}
    if(!normalized.ok&&security!==undefined){partial=true;normalized=normalizeGmgnSolanaTokenCard(base);}
    if(!normalized.ok)return {address,text:fallback(address,this.options.wallet,balance,position,normalized.reason,now),gmgnAvailable:false,partial:true};
    partial=partial||normalized.card.safety.coverage==='unavailable'||normalized.card.holders.coverage==='unavailable';
    return {address,text:render(normalized.card,this.options.wallet,balance,position,partial,now),gmgnAvailable:true,partial};
  }
}

function canonicalWallet(value:string):boolean {
  if(value.length<32||value.length>44)return false;
  try {const bytes=bs58.decode(value);return bytes.length===32&&bytes.some(byte=>byte!==0)&&bs58.encode(bytes)===value;}
  catch{return false;}
}
