import bs58 from 'bs58';
import type {Check,Signal} from './types.js';
import {assessGmgnSafety,type GmgnTokenSnapshot} from './providers/gmgn-safety.js';

export interface MarketRiskPolicy {
  /** USD, not token reserves. Zero still requires strictly positive liquidity. */
  minLiquidityUsd?:number;
  /** May tighten, never extend the 120 second evidence limit. */
  maxAgeSec?:number;
  maxTaxRate?:number;
  /** Optional operator policy. These are vendor estimates, not proof of fraud. */
  maxDevTeamHoldRate?:number;
  maxInsiderHoldRate?:number;
  maxBundlerVolumeRate?:number;
}
type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const field=(row:Obj,key:string)=>Object.hasOwn(row,key)&&row[key]!==undefined&&row[key]!==null;
const number=(v:unknown):number|undefined=>{
  if(typeof v!=='number'&&typeof v!=='string'||typeof v==='string'&&(!v.trim()||v.length>120||!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v.trim())))return;
  const n=Number(v);return Number.isFinite(n)&&n>=0?n:undefined;
};
const ratio=(v:unknown)=>{const n=number(v);return n!==undefined&&n<=1?n:undefined;};
function address(v:unknown,chain:Signal['token']['chain']):string|undefined {
  if(typeof v!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-fA-F]{40}$/.test(v)?v.toLowerCase():undefined;
  try{return bs58.decode(v).length===32?v:undefined;}catch{return;}
}
const zero=(v:string)=>/^0x0{40}$/.test(v)||v==='11111111111111111111111111111111';
const chainMatches=(v:unknown,chain:Signal['token']['chain'])=>v===undefined||v===chain||chain==='solana'&&v==='sol';
const SOURCE='https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token/SKILL.md';

/** Bounded vendor market-data gate; a pass is neither a sell simulation nor a fill guarantee. */
export function assessMarketRisk(signal:Signal,snapshot:GmgnTokenSnapshot|undefined,now=new Date(),policy:MarketRiskPolicy={}):Check {
  const failures:string[]=[],technicalFailures:string[]=[],missing:string[]=[],warnings:string[]=[];
  const facts:Record<string,unknown>={provider:'gmgn',scope:'reported_pool_liquidity_and_market_data',
    token:{...signal.token},sellabilityVerified:false,executionVerified:false,ownershipProven:false,
    source:SOURCE,warnings,missingFields:missing,normalized:{},riskObservations:{},
    concentrationExcludesPools:false,nonAtomicSnapshot:true};
  let checkedAt=Number.isFinite(now.getTime())?now.toISOString():new Date(0).toISOString();
  const result=(status:Check['status'],reasons:string[]):Check=>({status,reasons:[...new Set(reasons)],checkedAt,facts});
  const min=policy.minLiquidityUsd??0,maxAge=policy.maxAgeSec??120,maxTax=policy.maxTaxRate??0.1;
  const caps=[policy.maxDevTeamHoldRate,policy.maxInsiderHoldRate,policy.maxBundlerVolumeRate];
  if(!Number.isFinite(now.getTime())||typeof min!=='number'||!Number.isFinite(min)||min<0||
    typeof maxAge!=='number'||!Number.isFinite(maxAge)||maxAge<=0||maxAge>120||
    typeof maxTax!=='number'||ratio(maxTax)===undefined||caps.some(v=>v!==undefined&&(typeof v!=='number'||ratio(v)===undefined)))
    return result('unknown',['MARKET_RISK_POLICY_INVALID']);
  facts.policy={minLiquidityUsd:min,maxAgeSec:maxAge,maxTaxRate:maxTax,
    ...(policy.maxDevTeamHoldRate!==undefined?{maxDevTeamHoldRate:policy.maxDevTeamHoldRate}:{}),
    ...(policy.maxInsiderHoldRate!==undefined?{maxInsiderHoldRate:policy.maxInsiderHoldRate}:{}),
    ...(policy.maxBundlerVolumeRate!==undefined?{maxBundlerVolumeRate:policy.maxBundlerVolumeRate}:{})};
  const token=address(signal.token.address,signal.token.chain);
  if(!token||zero(token)||!snapshot||snapshot.token?.chain!==signal.token.chain||address(snapshot.token?.address,signal.token.chain)!==token)
    return result('unknown',['MARKET_TOKEN_SCOPE_UNVERIFIED']);
  const stamp=Date.parse(snapshot.fetchedAt);
  if(!Number.isFinite(stamp)||stamp>now.getTime()||now.getTime()-stamp>maxAge*1000)
    return result('unknown',['MARKET_SNAPSHOT_STALE']);
  checkedAt=new Date(stamp).toISOString();
  const ok=(section:'info'|'pool'|'security')=>Array.isArray(snapshot.diagnostics)&&
    snapshot.diagnostics.some(d=>d.section===section&&d.status==='ok')&&
    !snapshot.diagnostics.some(d=>d.section===section&&d.status!=='ok');
  const info=object(snapshot.info)?snapshot.info:undefined,pool=object(snapshot.pool)?snapshot.pool:undefined;
  if(!info||!ok('info')||address(info.address,signal.token.chain)!==token||!chainMatches(info.chain,signal.token.chain))
    return result('unknown',['MARKET_INFO_SCOPE_UNVERIFIED']);
  if(object(info.price)&&(field(info.price,'address')&&address(info.price.address,signal.token.chain)!==token||!chainMatches(info.price.chain,signal.token.chain)))
    return result('unknown',['MARKET_PRICE_SCOPE_UNVERIFIED']);
  const nested=object(info.pool)?info.pool:undefined,security=object(snapshot.security)?snapshot.security:undefined;
  // A wrong-asset supplemental response cannot contribute either a safe value or an adverse claim.
  if(pool&&(!ok('pool')||address(pool.base_address,signal.token.chain)!==token||!chainMatches(pool.chain,signal.token.chain)))
    return result('unknown',['MARKET_POOL_SCOPE_UNVERIFIED']);
  if(security&&(!ok('security')||address(security.address,signal.token.chain)!==token||!chainMatches(security.chain,signal.token.chain)))
    return result('unknown',['MARKET_SECURITY_SCOPE_UNVERIFIED']);
  if(nested&&(field(nested,'base_address')&&address(nested.base_address,signal.token.chain)!==token||!chainMatches(nested.chain,signal.token.chain)))
    return result('unknown',['MARKET_POOL_SCOPE_UNVERIFIED']);
  if(security) {
    const supplement=assessGmgnSafety(snapshot,maxTax);
    facts.supplementalSafety={status:supplement.status,reasons:supplement.reasons};
    if(supplement.status==='fail')technicalFailures.push(...supplement.reasons);
  }
  const normalized=facts.normalized as Record<string,unknown>,observations=facts.riskObservations as Record<string,unknown>;
  const conflicts:string[]=[];
  const poolAddresses:[string,unknown][]=[];
  // The documentation calls pool.address a pool address, but live 2026-10-15 responses
  // put the token there. Only explicit pool_address fields can identify a pool.
  if(pool&&field(pool,'pool_address'))poolAddresses.push(['pool.pool_address',pool.pool_address]);
  if(nested&&field(nested,'pool_address'))poolAddresses.push(['info.pool.pool_address',nested.pool_address]);
  if(field(info,'biggest_pool_address'))poolAddresses.push(['info.biggest_pool_address',info.biggest_pool_address]);
  const parsedPools=poolAddresses.map(([key,value])=>({key,address:address(value,signal.token.chain)}));
  if(parsedPools.some(p=>!p.address))missing.push('pool_address_invalid');
  const uniquePools=[...new Set(parsedPools.flatMap(p=>p.address?[p.address]:[]))];
  if(uniquePools.length>1)conflicts.push('pool_address');
  if(uniquePools.length===1)normalized.poolAddress=uniquePools[0];
  if(pool&&uniquePools.length===1&&zero(uniquePools[0]))failures.push('MARKET_POOL_ADDRESS_ZERO');
  if(!pool)missing.push('pool_response');
  if(!poolAddresses.length)missing.push('pool_address');
  const quoteValues=[...(pool&&field(pool,'quote_address')?[pool.quote_address]:[]),...(nested&&field(nested,'quote_address')?[nested.quote_address]:[])];
  const quotes=quoteValues.map(v=>address(v,signal.token.chain));
  if(!quotes.length||quotes.some(v=>!v))missing.push('quote_address');
  const uniqueQuotes=[...new Set(quotes.filter((v):v is string=>!!v))];
  if(uniqueQuotes.length>1)conflicts.push('quote_address');
  if(uniqueQuotes.length===1)normalized.quoteAddress=uniqueQuotes[0];
  if(uniqueQuotes.length===1&&uniqueQuotes[0]===token)failures.push('MARKET_POOL_TOKEN_PAIR_INVALID');
  const marketNumbers=(name:string,values:[string,unknown][],required=true)=>{
    const parsed=values.map(([source,value])=>({source,value:number(value)}));
    if(required&&!parsed.length||parsed.some(v=>v.value===undefined))missing.push(name);
    const valid=parsed.filter((v):v is {source:string;value:number}=>v.value!==undefined);
    normalized[name]={observations:valid};
    if(valid.some(v=>v.value===0)&&valid.some(v=>v.value>0))conflicts.push(name);
    return valid.map(v=>v.value);
  };
  const liquidity=marketNumbers('liquidityUsd',[
    ...(field(info,'liquidity')?[['info.liquidity',info.liquidity] as [string,unknown]]:[]),
    ...(nested&&field(nested,'liquidity')?[['info.pool.liquidity',nested.liquidity] as [string,unknown]]:[]),
    ...(pool&&field(pool,'liquidity')?[['pool.liquidity',pool.liquidity] as [string,unknown]]:[])]);
  const price=marketNumbers('priceUsd',[
    ...(object(info.price)&&field(info.price,'price')?[['info.price.price',info.price.price] as [string,unknown]]:[]),
    ...(pool&&field(pool,'price')?[['pool.price',pool.price] as [string,unknown]]:[])]);
  const stage=number(info.launchpad_status);
  if(field(info,'launchpad_status')&&![0,1,2].includes(stage??-1))missing.push('launchpad_status');
  normalized.launchpadStatus=stage??null;
  // Live pump_amm responses still report launchpad_status=1. Do not infer executable
  // market mode (or an unopened market) from this field alone.
  if(stage===1&&!pool)missing.push('bonding_curve_liquidity_adapter');
  // Curves may use virtual reserves or omit AMM reserves entirely. Only reported USD liquidity is gated.
  if(liquidity.length&&liquidity.every(v=>v===0))failures.push('MARKET_LIQUIDITY_ZERO');
  else if(liquidity.length&&Math.min(...liquidity)<min)failures.push('MARKET_LIQUIDITY_BELOW_POLICY');
  if(price.length&&price.every(v=>v===0))missing.push('positive_price');
  if(liquidity.length)normalized.minimumObservedLiquidityUsd=Math.min(...liquidity);
  if(price.length)normalized.priceRangeUsd={minimum:Math.min(...price),maximum:Math.max(...price)};
  const stats=object(info.stat)?info.stat:undefined;
  const ratioFields:[string,Obj|undefined,string,string][]=[
    ['top10HolderRate',security,'top_10_holder_rate','supply_ratio'],['top10HolderRate',stats,'top_10_holder_rate','supply_ratio'],
    ['devTeamHoldRate',security,'dev_team_hold_rate','supply_ratio'],['devTeamHoldRate',stats,'dev_team_hold_rate','supply_ratio'],
    ['creatorHoldRate',security,'creator_balance_rate','supply_ratio'],['creatorHoldRate',stats,'creator_hold_rate','supply_ratio'],
    ['insiderHoldRate',security,'suspected_insider_hold_rate','supply_ratio'],
    ['bundlerVolumeRate',security,'bundler_trader_amount_rate','volume_ratio'],['bundlerVolumeRate',stats,'top_bundler_trader_percentage','volume_ratio'],
    ['insiderVolumeRate',security,'rat_trader_amount_rate','volume_ratio'],['insiderVolumeRate',stats,'top_rat_trader_percentage','volume_ratio'],
    ['rugScore',security,'rug_ratio','vendor_model_score']];
  for(const [name,row,key,unit] of ratioFields)if(row&&field(row,key)){
    const value=ratio(row[key]);
    if(value===undefined){missing.push(`risk.${key}`);continue;}
    const previous=observations[name] as {value:number;unit:string;observedValues:number[]}|undefined;
    // Endpoints are sampled at different instants. Keep the conservative estimate
    // and its range; a changing concentration is not proof of provider corruption.
    observations[name]={value:Math.max(previous?.value??0,value),unit,
      observedValues:[...new Set([...(previous?.observedValues??[]),value])]};
  }
  if(security&&field(security,'is_wash_trading')) {
    if(typeof security.is_wash_trading!=='boolean')missing.push('risk.is_wash_trading');
    else {observations.washTradingReported=security.is_wash_trading;if(security.is_wash_trading)warnings.push('MARKET_WASH_TRADING_REPORTED');}
  }
  for(const [name,cap] of [['devTeamHoldRate',policy.maxDevTeamHoldRate],['insiderHoldRate',policy.maxInsiderHoldRate],['bundlerVolumeRate',policy.maxBundlerVolumeRate]] as const){
    const observation=observations[name] as {value:number}|undefined;
    if(cap!==undefined){if(!observation)missing.push(`policy.${name}`);else if(observation.value>cap)failures.push(`MARKET_${name==='devTeamHoldRate'?'DEV_HOLD':name==='insiderHoldRate'?'INSIDER_HOLD':'BUNDLER_VOLUME'}_ABOVE_POLICY`);}
  }
  if(Object.hasOwn(observations,'top10HolderRate'))warnings.push('MARKET_TOP_HOLDERS_INCLUDE_UNCLASSIFIED_ACCOUNTS');
  if(Object.hasOwn(observations,'bundlerVolumeRate')||Object.hasOwn(observations,'insiderHoldRate')||Object.hasOwn(observations,'insiderVolumeRate'))warnings.push('MARKET_VENDOR_WALLET_RISK_ESTIMATES');
  if(conflicts.length)facts.conflictingFields=[...new Set(conflicts)];
  // A known technical danger is never hidden by missing market data. Conflicting market values cannot be a pass.
  if(technicalFailures.length)return result('fail',technicalFailures);
  if(conflicts.length)return result('unknown',['MARKET_DATA_CONFLICT']);
  if(failures.length)return result('fail',failures);
  if(missing.length)return result('unknown',[stage===1&&!pool?'MARKET_CURVE_POOL_UNVERIFIED':'MARKET_DATA_INCOMPLETE']);
  return result('pass',['MARKET_REPORTED_LIQUIDITY_PRESENT']);
}
