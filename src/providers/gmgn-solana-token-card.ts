import {normalizePriceToken} from '../market-price-normalizers.js';

type ObjectRow=Record<string,unknown>;
type Decimal={atoms:bigint;scale:number};

export type GmgnSolanaCardRejectReason=
  |'GMGN_SOL_CARD_INPUT_INVALID'
  |'GMGN_SOL_CARD_TOKEN_INVALID'
  |'GMGN_SOL_CARD_INFO_INVALID'
  |'GMGN_SOL_CARD_TOKEN_MISMATCH'
  |'GMGN_SOL_CARD_SECURITY_MISMATCH'
  |'GMGN_SOL_CARD_POOL_MISMATCH'
  |'GMGN_SOL_CARD_HOLDERS_MISMATCH'
  |'GMGN_SOL_CARD_TEXT_INVALID'
  |'GMGN_SOL_CARD_NUMBER_INVALID'
  |'GMGN_SOL_CARD_NUMBER_CONFLICT'
  |'GMGN_SOL_CARD_HOLDERS_INVALID';

export type GmgnSolanaCardState='yes'|'no'|'unknown';
export type GmgnSolanaLaunchpad='pump'|'moonshot'|'ray_launchpad'|'meteora_virtual_curve'|'stonkfun';
export type GmgnSolanaVenue='pump_amm'|'raydium'|'raydium_cpmm'|'raydium_clmm'|'meteora_dlmm'|'meteora_damm'|'orca'|'orca_whirlpool'|'moonshot';

export interface GmgnSolanaScopedData {
  chain:unknown;
  address:unknown;
  data:unknown;
}

/**
 * Pure input boundary for already-decoded GMGN endpoint `data` values.
 * The holder endpoint does not bind its response to a token, so callers must
 * preserve the request scope beside that response.
 */
export interface GmgnSolanaTokenCardInput {
  token:unknown;
  fetchedAt:unknown;
  info:unknown;
  security?:unknown;
  pool?:unknown;
  topHolders?:GmgnSolanaScopedData;
}

export interface GmgnSolanaTokenCardDto {
  version:1;
  provider:'gmgn';
  chain:'solana';
  address:string;
  observedAt:string;
  token:{name:string;symbol:string;decimals?:number};
  market:{
    priceUsd:string;
    circulatingSupply?:string;
    marketCapUsd?:string;
    /** GMGN token-info aggregate; never used as the pool-reserve figure. */
    reportedLiquidityUsd?:string;
    holderCount?:number;
    createdAt?:string;
    ageSeconds?:number;
    openedAt?:string;
    mainPoolAddress?:string;
    launchpad?:GmgnSolanaLaunchpad;
    launchpadStatus?:'not_open'|'live'|'migrated';
    launchpadProgressPercent?:string;
  };
  pool?:{
    address:string;
    quoteAddress?:string;
    quoteSymbol?:string;
    venue?:GmgnSolanaVenue;
    liquidityUsd?:string;
    createdAt?:string;
    ageSeconds?:number;
  };
  safety:{
    coverage:'available'|'unavailable';
    mintAuthorityRenounced:GmgnSolanaCardState;
    freezeAuthorityRenounced:GmgnSolanaCardState;
    liquidityBurned:GmgnSolanaCardState;
    buyTaxPercent?:string;
    sellTaxPercent?:string;
  };
  holderRisk:{
    top10HoldingPercent?:string;
    creatorHoldingPercent?:string;
    developerTeamHoldingPercent?:string;
    suspectedInsiderHoldingPercent?:string;
    ratTraderVolumePercent?:string;
    bundlerVolumePercent?:string;
    entrapmentVolumePercent?:string;
    privateVaultHoldingPercent?:string;
    sniperHoldingPercent?:string;
  };
  holders:{
    coverage:'provided'|'unavailable';
    topFive:Array<{rank:number;address:string;holdingPercent:string;kind:'wallet'|'pool'|'unknown'}>;
  };
}

export type GmgnSolanaTokenCardResult=
  |{ok:true;card:GmgnSolanaTokenCardDto}
  |{ok:false;reason:GmgnSolanaCardRejectReason};

class Rejected extends Error {
  constructor(readonly reason:GmgnSolanaCardRejectReason){super(reason);}
}
function reject(reason:GmgnSolanaCardRejectReason):never {throw new Rejected(reason);}
const object=(value:unknown):value is ObjectRow=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(row:ObjectRow,key:string)=>Object.hasOwn(row,key);

function solAddress(value:unknown):string|undefined {
  if(typeof value!=='string')return;
  return normalizePriceToken({chain:'solana',address:value})?.address;
}
function chainMatches(value:unknown):boolean{return value===undefined||value==='sol'||value==='solana';}
function scoped(row:ObjectRow,address:string,addressKey:string,reason:GmgnSolanaCardRejectReason,required=true):void {
  const bound=solAddress(row[addressKey]);
  if(required&&!bound||bound&&bound!==address||!chainMatches(row.chain))reject(reason);
}

function instant(value:unknown):{iso:string;milliseconds:number}|undefined {
  if(typeof value!=='string'||!/^(?:19|20)\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value))return;
  const milliseconds=Date.parse(value);
  if(!Number.isFinite(milliseconds))return;
  return {iso:new Date(milliseconds).toISOString(),milliseconds};
}

function decimal(value:unknown):Decimal|undefined {
  if(typeof value!=='string'&&typeof value!=='number')return;
  if(typeof value==='number'&&(!Number.isFinite(value)||value<0||Object.is(value,-0)||Number.isInteger(value)&&!Number.isSafeInteger(value)))return;
  const text=String(value);
  if(text.length>128)return;
  const match=/^(0|[1-9]\d{0,99})(?:\.(\d{1,80}))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if(!match)return;
  const fraction=match[2]??'';
  const exponent=Number(match[3]??0);
  let atoms=BigInt(match[1]+fraction),scale=fraction.length-exponent;
  if(scale<0){
    if(-scale>80)return;
    atoms*=10n**BigInt(-scale);scale=0;
  }
  if(scale>80)return;
  while(scale>0&&atoms%10n===0n){atoms/=10n;scale--;}
  if(atoms.toString().length>120)return;
  return {atoms,scale};
}
const denominator=(value:Decimal)=>10n**BigInt(value.scale);
const compare=(a:Decimal,b:Decimal)=>a.atoms*denominator(b)-b.atoms*denominator(a);
function decimalText(value:Decimal):string {
  if(!value.scale)return value.atoms.toString();
  const padded=value.atoms.toString().padStart(value.scale+1,'0');
  return `${padded.slice(0,-value.scale)}.${padded.slice(-value.scale)}`.replace(/0+$/,'').replace(/\.$/,'');
}
const percentText=(value:Decimal)=>decimalText({atoms:value.atoms*100n,scale:value.scale});
const multiply=(left:Decimal,right:Decimal):Decimal=>{
  let value:Decimal={atoms:left.atoms*right.atoms,scale:left.scale+right.scale};
  while(value.scale>0&&value.atoms%10n===0n)value={atoms:value.atoms/10n,scale:value.scale-1};
  if(value.scale>80||value.atoms.toString().length>120)reject('GMGN_SOL_CARD_NUMBER_INVALID');
  return value;
};
const add=(left:Decimal,right:Decimal):Decimal=>{
  const scale=Math.max(left.scale,right.scale);
  return {atoms:left.atoms*10n**BigInt(scale-left.scale)+right.atoms*10n**BigInt(scale-right.scale),scale};
};

function optionalDecimal(row:ObjectRow|undefined,key:string,options:{ratio?:boolean;positive?:boolean}={}):Decimal|undefined {
  if(!row||!own(row,key)||row[key]===undefined||row[key]===null||row[key]==='')return;
  const value=decimal(row[key]);
  if(value===undefined)reject('GMGN_SOL_CARD_NUMBER_INVALID');
  if(options.positive&&value.atoms===0n||options.ratio&&compare(value,{atoms:1n,scale:0})>0)reject('GMGN_SOL_CARD_NUMBER_INVALID');
  return value;
}
function optionalInteger(row:ObjectRow|undefined,key:string,max=Number.MAX_SAFE_INTEGER):number|undefined {
  if(!row||!own(row,key)||row[key]===undefined||row[key]===null||row[key]==='')return;
  const value=decimal(row[key]);
  if(value===undefined)reject('GMGN_SOL_CARD_NUMBER_INVALID');
  if(value.scale!==0||value.atoms>BigInt(max))reject('GMGN_SOL_CARD_NUMBER_INVALID');
  return Number(value.atoms);
}
function unixTime(row:ObjectRow|undefined,key:string,observedMs:number):{iso:string;ageSeconds:number}|undefined {
  const seconds=optionalInteger(row,key,99_999_999_999);
  if(seconds===undefined||seconds===0)return;
  const milliseconds=seconds*1_000;
  if(!Number.isSafeInteger(milliseconds)||milliseconds>observedMs)reject('GMGN_SOL_CARD_NUMBER_INVALID');
  return {iso:new Date(milliseconds).toISOString(),ageSeconds:Math.floor((observedMs-milliseconds)/1_000)};
}

function text(value:unknown,maxLength:number,symbol=false):string {
  if(typeof value!=='string')reject('GMGN_SOL_CARD_TEXT_INVALID');
  if(value!==value.trim()||!value.length||[...value].length>maxLength||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufffd]/u.test(value)||symbol&&/[\s<>`]/u.test(value))
    reject('GMGN_SOL_CARD_TEXT_INVALID');
  return value.normalize('NFC');
}
function optionalSymbol(value:unknown):string|undefined {
  if(value===undefined||value===null||value==='')return;
  return text(value,20,true);
}
function state(row:ObjectRow|undefined,key:string):GmgnSolanaCardState {
  if(!row||!own(row,key)||row[key]===undefined||row[key]===null||row[key]==='')return 'unknown';
  const value=row[key];
  if(value===true||value===1||value==='1'||value==='true'||value==='yes')return 'yes';
  if(value===false||value===0||value==='0'||value==='false'||value==='no')return 'no';
  return reject('GMGN_SOL_CARD_INPUT_INVALID');
}
function fixed<T extends string>(value:unknown,allowed:readonly T[]):T|undefined {
  return typeof value==='string'&&(allowed as readonly string[]).includes(value)?value as T:undefined;
}
function ratioPercent(row:ObjectRow|undefined,key:string):string|undefined {
  const value=optionalDecimal(row,key,{ratio:true});return value?percentText(value):undefined;
}
function consensusInteger(values:Array<number|undefined>):number|undefined {
  const known=values.filter((value):value is number=>value!==undefined);
  // GMGN builds the top-level holder_count and stat holder_count from
  // independently refreshed aggregates. A newly active token can therefore
  // return adjacent snapshots in one otherwise well-bound token response.
  // Holder count is display-only, so omit it when the snapshots disagree;
  // token/pool/security address binding and every safety ratio remain strict.
  return known.every(value=>value===known[0])?known[0]:undefined;
}
function ratioFrom(primary:ObjectRow|undefined,primaryKey:string,fallback:ObjectRow|undefined,fallbackKey=primaryKey):string|undefined {
  const first=optionalDecimal(primary,primaryKey,{ratio:true});
  const second=optionalDecimal(fallback,fallbackKey,{ratio:true});
  // Several GMGN security responses use zero as a placeholder while info.stat
  // carries a real concentration. A non-zero info.stat value therefore wins;
  // two different non-zero readings remain ambiguous and are rejected.
  if(first&&second&&first.atoms!==0n&&second.atoms!==0n&&compare(first,second)!==0n)
    reject('GMGN_SOL_CARD_NUMBER_CONFLICT');
  const selected=first?.atoms?first:second?.atoms?second:first??second;
  return selected?percentText(selected):undefined;
}
function burnedState(security:ObjectRow|undefined,launchpad:GmgnSolanaLaunchpad|undefined,
  launchpadStatus:GmgnSolanaTokenCardDto['market']['launchpadStatus']):GmgnSolanaCardState {
  if(!security)return 'unknown';
  // A live/not-yet-open Pump bonding curve is not an LP burn assertion.
  if(launchpad==='pump'&&(launchpadStatus==='not_open'||launchpadStatus==='live'))return 'unknown';
  const ratio=optionalDecimal(security,'burn_ratio',{ratio:true});
  const status=typeof security.burn_status==='string'?security.burn_status:undefined;
  if(status==='burn'&&ratio&&compare(ratio,{atoms:1n,scale:0})===0n)return 'yes';
  if(ratio&&compare(ratio,{atoms:1n,scale:0})<0)return 'no';
  if(status==='not_burn'||status==='unburned'||status==='none')return 'no';
  return 'unknown';
}

function topFive(input:GmgnSolanaScopedData|undefined,address:string):GmgnSolanaTokenCardDto['holders'] {
  if(input===undefined)return {coverage:'unavailable',topFive:[]};
  if(!chainMatches(input.chain)||solAddress(input.address)!==address)reject('GMGN_SOL_CARD_HOLDERS_MISMATCH');
  const data=input.data;
  if(!object(data))reject('GMGN_SOL_CARD_HOLDERS_INVALID');
  const list=data.list;
  if(!Array.isArray(list)||list.length>100)reject('GMGN_SOL_CARD_HOLDERS_INVALID');
  if(own(data,'address')&&solAddress(data.address)!==address||!chainMatches(data.chain))
    reject('GMGN_SOL_CARD_HOLDERS_MISMATCH');
  const wallets=new Set<string>(),rows:Array<{address:string;ratio:Decimal;kind:'wallet'|'pool'|'unknown'}>=[];
  let total:Decimal={atoms:0n,scale:0};
  const burns=new Set(['11111111111111111111111111111111','1nc1nerator11111111111111111111111111111111']);
  for(const raw of list){
    if(!object(raw))reject('GMGN_SOL_CARD_HOLDERS_INVALID');
    const rawAddress=raw.address;
    const wallet=typeof rawAddress==='string'&&burns.has(rawAddress)?rawAddress:solAddress(rawAddress);
    const ratio=optionalDecimal(raw,'amount_percentage',{ratio:true});
    if(wallet===undefined||ratio===undefined||wallets.has(wallet))reject('GMGN_SOL_CARD_HOLDERS_INVALID');
    if(rows.length&&compare(rows.at(-1)!.ratio,ratio)<0)reject('GMGN_SOL_CARD_HOLDERS_INVALID');
    wallets.add(wallet);
    const addrType=optionalInteger(raw,'addr_type');
    const kind=addrType===0?'wallet':addrType===2?'pool':'unknown';
    const scale=Math.max(total.scale,ratio.scale);
    total={atoms:total.atoms*10n**BigInt(scale-total.scale)+ratio.atoms*10n**BigInt(scale-ratio.scale),scale};
    if(compare(total,{atoms:1n,scale:0})>0)reject('GMGN_SOL_CARD_HOLDERS_INVALID');
    rows.push({address:wallet,ratio,kind});
  }
  return {coverage:'provided',topFive:rows.filter(row=>row.kind!=='pool'&&!burns.has(row.address)).slice(0,5).map((row,index)=>({rank:index+1,address:row.address,
    holdingPercent:percentText(row.ratio),kind:row.kind}))};
}

const LAUNCHPADS=['pump','moonshot','ray_launchpad','meteora_virtual_curve','stonkfun'] as const;
const VENUES=['pump_amm','raydium','raydium_cpmm','raydium_clmm','meteora_dlmm','meteora_damm','orca','orca_whirlpool','moonshot'] as const;
const LAUNCHPAD_PLATFORM:Readonly<Record<string,GmgnSolanaLaunchpad>>={
  pump:'pump',pumpfun:'pump','pump.fun':'pump',moonshot:'moonshot',ray_launchpad:'ray_launchpad',
  raydium_launchlab:'ray_launchpad',meteora_virtual_curve:'meteora_virtual_curve',stonkfun:'stonkfun',
};

/**
 * Build the Telegram-facing contract-detail projection. The function never
 * returns raw response objects, arbitrary provider errors, descriptions,
 * social text, labels, URLs or wallet aliases.
 */
export function normalizeGmgnSolanaTokenCard(input:GmgnSolanaTokenCardInput):GmgnSolanaTokenCardResult {
  try {
    if(!object(input))reject('GMGN_SOL_CARD_INPUT_INVALID');
    const token=input.token;
    if(!object(token)||token.chain!=='solana')reject('GMGN_SOL_CARD_TOKEN_INVALID');
    const parsedAddress=solAddress(token.address),parsedObserved=instant(input.fetchedAt);
    if(parsedAddress===undefined||parsedObserved===undefined)reject('GMGN_SOL_CARD_TOKEN_INVALID');
    const address=parsedAddress,observed=parsedObserved;
    const rawInfo=input.info;
    if(!object(rawInfo))reject('GMGN_SOL_CARD_INFO_INVALID');
    const info=rawInfo;scoped(info,address,'address','GMGN_SOL_CARD_TOKEN_MISMATCH');
    const name=text(info.name,80),symbol=text(info.symbol,24,true);
    const rawPrice=info.price;
    if(!object(rawPrice))reject('GMGN_SOL_CARD_INFO_INVALID');
    const priceRow=rawPrice;scoped(priceRow,address,'address','GMGN_SOL_CARD_TOKEN_MISMATCH',false);
    const parsedPrice=optionalDecimal(priceRow,'price',{positive:true});
    if(parsedPrice===undefined)reject('GMGN_SOL_CARD_INFO_INVALID');
    const price=parsedPrice;

    const stat=object(info.stat)?info.stat:undefined,nestedPool=object(info.pool)?info.pool:undefined;
    if(nestedPool)scoped(nestedPool,address,'base_address','GMGN_SOL_CARD_POOL_MISMATCH',false);
    let security:ObjectRow|undefined;
    if(input.security!==undefined){if(!object(input.security))reject('GMGN_SOL_CARD_INPUT_INVALID');security=input.security;}
    if(security)scoped(security,address,'address','GMGN_SOL_CARD_SECURITY_MISMATCH');
    let pool:ObjectRow|undefined;
    if(input.pool!==undefined){if(!object(input.pool))reject('GMGN_SOL_CARD_INPUT_INVALID');pool=input.pool;}
    if(pool)scoped(pool,address,'base_address','GMGN_SOL_CARD_POOL_MISMATCH');

    const decimals=optionalInteger(info,'decimals',255);
    const circulating=optionalDecimal(info,'circulating_supply');
    const liquidity=optionalDecimal(info,'liquidity');
    const holderCount=consensusInteger([optionalInteger(info,'holder_count'),optionalInteger(stat,'holder_count')]);
    const created=unixTime(info,'creation_timestamp',observed.milliseconds),opened=unixTime(info,'open_timestamp',observed.milliseconds);
    const market:GmgnSolanaTokenCardDto['market']={priceUsd:decimalText(price)};
    if(circulating){market.circulatingSupply=decimalText(circulating);market.marketCapUsd=decimalText(multiply(price,circulating));}
    if(liquidity)market.reportedLiquidityUsd=decimalText(liquidity);
    if(holderCount!==undefined)market.holderCount=holderCount;
    if(created){market.createdAt=created.iso;market.ageSeconds=created.ageSeconds;}
    if(opened)market.openedAt=opened.iso;
    const mainPool=solAddress(info.biggest_pool_address);
    if(own(info,'biggest_pool_address')&&info.biggest_pool_address!==undefined&&info.biggest_pool_address!==null&&!mainPool)
      reject('GMGN_SOL_CARD_POOL_MISMATCH');
    if(mainPool){if(mainPool===address)reject('GMGN_SOL_CARD_POOL_MISMATCH');market.mainPoolAddress=mainPool;}
    const directLaunchpad=fixed(info.launchpad,LAUNCHPADS);
    const platformLaunchpad=typeof info.launchpad_platform==='string'?LAUNCHPAD_PLATFORM[info.launchpad_platform]:undefined;
    if(directLaunchpad&&platformLaunchpad&&directLaunchpad!==platformLaunchpad)reject('GMGN_SOL_CARD_INPUT_INVALID');
    const launchpad=directLaunchpad??platformLaunchpad;if(launchpad)market.launchpad=launchpad;
    const launchStatus=optionalInteger(info,'launchpad_status',2);
    if(launchStatus!==undefined)market.launchpadStatus=(['not_open','live','migrated'] as const)[launchStatus];
    const progress=optionalDecimal(info,'launchpad_progress',{ratio:true});if(progress)market.launchpadProgressPercent=percentText(progress);

    let poolDto:GmgnSolanaTokenCardDto['pool'];
    const nestedPoolAddress=nestedPool&&solAddress(nestedPool.pool_address),endpointPoolAddress=pool&&solAddress(pool.pool_address);
    if(nestedPool&&own(nestedPool,'pool_address')&&!nestedPoolAddress||pool&&own(pool,'pool_address')&&!endpointPoolAddress)
      reject('GMGN_SOL_CARD_POOL_MISMATCH');
    if(nestedPoolAddress&&endpointPoolAddress&&nestedPoolAddress!==endpointPoolAddress)reject('GMGN_SOL_CARD_POOL_MISMATCH');
    const poolAddress=endpointPoolAddress??nestedPoolAddress;
    if(poolAddress){
      if(poolAddress===address)reject('GMGN_SOL_CARD_POOL_MISMATCH');
      poolDto={address:poolAddress};
      const nestedQuote=nestedPool&&solAddress(nestedPool.quote_address),endpointQuote=pool&&solAddress(pool.quote_address);
      if(nestedPool&&own(nestedPool,'quote_address')&&!nestedQuote||pool&&own(pool,'quote_address')&&!endpointQuote||
        nestedQuote&&endpointQuote&&nestedQuote!==endpointQuote)reject('GMGN_SOL_CARD_POOL_MISMATCH');
      const quote=endpointQuote??nestedQuote;if(quote){if(quote===address)reject('GMGN_SOL_CARD_POOL_MISMATCH');poolDto.quoteAddress=quote;}
      const quoteSymbol=optionalSymbol(nestedPool?.quote_symbol);if(quoteSymbol)poolDto.quoteSymbol=quoteSymbol;
      const venue=fixed(pool?.exchange??nestedPool?.exchange,VENUES);if(venue)poolDto.venue=venue;
      const baseReserve=optionalDecimal(nestedPool,'base_reserve_value'),quoteReserve=optionalDecimal(nestedPool,'quote_reserve_value');
      const reserveTotal=baseReserve&&quoteReserve?add(baseReserve,quoteReserve):undefined;
      const poolLiquidity=reserveTotal??optionalDecimal(pool,'liquidity')??optionalDecimal(nestedPool,'liquidity');
      if(poolLiquidity)poolDto.liquidityUsd=decimalText(poolLiquidity);
      const poolCreated=unixTime(pool??nestedPool,'creation_timestamp',observed.milliseconds);
      if(poolCreated){poolDto.createdAt=poolCreated.iso;poolDto.ageSeconds=poolCreated.ageSeconds;}
    }

    const safety:GmgnSolanaTokenCardDto['safety']={coverage:security?'available':'unavailable',
      mintAuthorityRenounced:state(security,'renounced_mint'),freezeAuthorityRenounced:state(security,'renounced_freeze_account'),
      liquidityBurned:burnedState(security,market.launchpad,market.launchpadStatus)};
    const buyTax=ratioPercent(security,'buy_tax'),sellTax=ratioPercent(security,'sell_tax');
    if(buyTax!==undefined)safety.buyTaxPercent=buyTax;if(sellTax!==undefined)safety.sellTaxPercent=sellTax;
    const holderRisk:GmgnSolanaTokenCardDto['holderRisk']={};
    const risks:[keyof typeof holderRisk,string|undefined][]=[
      ['top10HoldingPercent',ratioFrom(stat,'top_10_holder_rate',security)],
      ['creatorHoldingPercent',ratioFrom(stat,'creator_hold_rate',security,'creator_balance_rate')],
      ['developerTeamHoldingPercent',ratioFrom(stat,'dev_team_hold_rate',security)],
      ['suspectedInsiderHoldingPercent',ratioPercent(security,'suspected_insider_hold_rate')],
      ['ratTraderVolumePercent',ratioFrom(stat,'top_rat_trader_percentage',security,'rat_trader_amount_rate')],
      ['bundlerVolumePercent',ratioFrom(stat,'top_bundler_trader_percentage',security,'bundler_trader_amount_rate')],
      ['entrapmentVolumePercent',ratioPercent(stat,'top_entrapment_trader_percentage')],
      ['privateVaultHoldingPercent',ratioPercent(stat,'private_vault_hold_rate')],
      ['sniperHoldingPercent',ratioPercent(stat,'top70_sniper_hold_rate')],
    ];
    for(const [key,value] of risks)if(value!==undefined)holderRisk[key]=value;
    const card:GmgnSolanaTokenCardDto={version:1,provider:'gmgn',chain:'solana',address,observedAt:observed.iso,
      token:{name,symbol,...(decimals!==undefined?{decimals}:{})},market,...(poolDto?{pool:poolDto}:{}),safety,holderRisk,
      holders:topFive(input.topHolders,address)};
    return {ok:true,card};
  }catch(error){
    return {ok:false,reason:error instanceof Rejected?error.reason:'GMGN_SOL_CARD_INPUT_INVALID'};
  }
}
