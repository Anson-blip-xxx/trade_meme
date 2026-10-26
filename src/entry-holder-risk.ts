import bs58 from 'bs58';

export const ENTRY_HOLDER_RISK_LIMITS={top10:25,bundler:40,ratTrader:30} as const;
export const ENTRY_HOLDER_RISK_MAX_AGE_MS=30_000;
export type EntryHolderRiskName=keyof typeof ENTRY_HOLDER_RISK_LIMITS;
export interface EntryHolderRiskValue {
  value:unknown;sourceField:string;coverage?:'complete'|'lower_bound';lowerBound?:string;
}
export interface EntryHolderRiskValues {
  provider:'gmgn';chain:'solana';address:string;checkedAt:string;completedAt?:string;
  values:Record<EntryHolderRiskName,EntryHolderRiskValue>;evidence?:unknown;
}
export interface EntryHolderRiskMetric {
  status:'available'|'missing'|'invalid';limitPct:number;sourceField:string;
  rate?:number;rateText?:string;percentage?:number;percentageText?:string;exceeded?:boolean;
  coverage?:'complete'|'lower_bound';lowerBound?:string;lowerBoundPercentageText?:string;
}
export interface EntryHolderRiskAssessment {
  provider:'gmgn';chain:'solana';address:string;checkedAt:string;completedAt?:string;
  status:'pass'|'blocked'|'unavailable';reasons:string[];
  metrics:Record<EntryHolderRiskName,EntryHolderRiskMetric>;evidence?:Record<string,unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const address=(v:unknown)=>{try{return typeof v==='string'&&bs58.decode(v).length===32&&bs58.encode(bs58.decode(v))===v;}catch{return false;}};
const names=Object.keys(ENTRY_HOLDER_RISK_LIMITS) as EntryHolderRiskName[];
const suffix=(name:EntryHolderRiskName)=>name==='top10'?'TOP10':name==='bundler'?'BUNDLER':'RAT_TRADER';
const safeReason=(v:unknown):v is string=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,119}$/.test(v);
const sourceField=(v:unknown)=>typeof v==='string'&&v.length<=200&&/^[A-Za-z0-9_.:[\] ,=()/+*-]*$/.test(v)?v:'';

/** Preserve exact string boundaries: 0.2500000000000000001 is above 25%. */
function rate(value:unknown):{ratio:number;text:string;numerator:bigint;denominator:bigint;percentageText:string}|undefined {
  if(typeof value!=='number'&&typeof value!=='string')return;
  if(typeof value==='number'&&(!Number.isFinite(value)||value<0))return;
  const text=String(value);if(text.length>80)return;
  const matched=/^(0|[1-9]\d{0,3})(?:\.(\d{1,30}))?(?:[eE]([+-]?\d{1,2}))?$/.exec(text);if(!matched)return;
  const fraction=matched[2]??'',power=Number(matched[3]??0)-fraction.length;
  let numerator=BigInt(matched[1]+fraction),denominator=1n;
  if(power>=0)numerator*=10n**BigInt(power);else denominator=10n**BigInt(-power);
  if(numerator>denominator)return;
  const places=Math.max(0,-power-2),percentageAtoms=numerator*100n;
  const whole=percentageAtoms/denominator,remainder=percentageAtoms%denominator;
  let percentageText=whole.toString();
  if(remainder){const decimals=(remainder*10n**BigInt(places)/denominator).toString().padStart(places,'0').replace(/0+$/,'');percentageText+='.'+decimals;}
  return {ratio:Number(value),text,numerator,denominator,percentageText};
}
function safeEvidence(raw:unknown):Record<string,unknown>|undefined {
  if(!object(raw))return;
  const result:Record<string,unknown>={};
  if(raw.requestedLimit===100)result.requestedLimit=100;
  if(sourceField(raw.top10Source))result.top10Source=sourceField(raw.top10Source);
  for(const key of ['identity','top10','topHolders']){
    const item=raw[key];if(!object(item))continue;
    const statuses=key==='identity'?['verified','invalid','unavailable']:['available','unavailable'];
    if(!statuses.includes(String(item.status)))continue;
    const value:Record<string,unknown>={status:item.status};
    if(Array.isArray(item.reasons))value.reasons=item.reasons.filter(safeReason).slice(0,20);
    if(key==='topHolders'){
      if(item.scope!=='visible_top10_not_aggregate')continue;value.scope=item.scope;
      if(Number.isSafeInteger(item.rows)&&Number(item.rows)>=0&&Number(item.rows)<=100)value.rows=item.rows;
      if(Array.isArray(item.list))value.list=item.list.slice(0,10).flatMap(row=>{
        if(!object(row)||!address(row.address)||!rate(row.amountPercentage)||typeof row.balance!=='string'||
          row.balance.length>100||!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(row.balance)||
          !['pool','burn','wallet','unknown'].includes(String(row.kind)))return [];
        return [{address:row.address,amountPercentage:rate(row.amountPercentage)!.text,balance:row.balance,kind:row.kind,
          ...(Number.isSafeInteger(row.addrType)&&Number(row.addrType)>=0&&Number(row.addrType)<=255?{addrType:row.addrType}:{})}];
      });
    }
    result[key]=value;
  }
  for(const key of ['bundler','ratTrader']){
    const item=raw[key];if(!object(item))continue;const value:Record<string,unknown>={};
    for(const count of ['rows','distinctWallets','positiveWallets','matchedWallets'])
      if(Number.isSafeInteger(item[count])&&Number(item[count])>=0&&Number(item[count])<=100)value[count]=item[count];
    if(['complete','lower_bound','unknown'].includes(String(item.coverage)))value.coverage=item.coverage;
    if(['less_than_limit','zero_tail','positive_tail'].includes(String(item.completionBasis)))value.completionBasis=item.completionBasis;
    if(rate(item.lowerBound))value.lowerBound=String(item.lowerBound);
    if(Array.isArray(item.reasons))value.reasons=item.reasons.filter(safeReason).slice(0,20);
    if(Object.keys(value).length)result[key]=value;
  }
  const entrapment=raw.entrapment;
  if(object(entrapment)&&entrapment.status==='unsupported'&&entrapment.documentedHoldingTag===false&&
    entrapment.sourceField==='info.stat.top_entrapment_trader_percentage'&&entrapment.scope==='vendor_trading_metric_not_holdings'){
    result.entrapment={status:'unsupported',documentedHoldingTag:false,sourceField:entrapment.sourceField,scope:entrapment.scope,
      ...(rate(entrapment.volumeRatio)?{volumeRatio:rate(entrapment.volumeRatio)!.text}:{})};
  }
  return Object.keys(result).length?result:undefined;
}

/** Vendor readers supply holding ratios only; trading-volume ratios must never be mapped here. */
export function assessEntryHolderRiskValues(input:EntryHolderRiskValues,now=new Date()):EntryHolderRiskAssessment {
  const metrics={} as EntryHolderRiskAssessment['metrics'],reasons:string[]=[],exceeded:string[]=[];
  for(const name of names){
    const source=input.values?.[name],limitPct=ENTRY_HOLDER_RISK_LIMITS[name],parsed=rate(source?.value);
    const status=source?.value===undefined||source.value===null?'missing':parsed?'available':'invalid';
    const metric:EntryHolderRiskMetric={status,limitPct,sourceField:sourceField(source?.sourceField)};
    if(source?.coverage==='complete'||source?.coverage==='lower_bound')metric.coverage=source.coverage;
    const lower=rate(source?.lowerBound);if(lower){metric.lowerBound=lower.text;metric.lowerBoundPercentageText=lower.percentageText;}
    if(parsed){metric.rate=parsed.ratio;metric.rateText=parsed.text;metric.percentage=Number(parsed.percentageText);metric.percentageText=parsed.percentageText;
      metric.exceeded=parsed.numerator*100n>BigInt(limitPct)*parsed.denominator;
      if(metric.exceeded)exceeded.push(`ENTRY_HOLDER_RISK_${suffix(name)}_EXCEEDED`);
    }else reasons.push(`ENTRY_HOLDER_RISK_${suffix(name)}_${status.toUpperCase()}`);
    if(source?.coverage==='lower_bound'&&!metric.exceeded)reasons.push(`ENTRY_HOLDER_RISK_${suffix(name)}_COVERAGE_INCOMPLETE`);
    else if(name!=='top10'&&source?.coverage!=='complete'&&!metric.exceeded)reasons.push(`ENTRY_HOLDER_RISK_${suffix(name)}_COVERAGE_UNVERIFIED`);
    if(!metric.sourceField)reasons.push(`ENTRY_HOLDER_RISK_${suffix(name)}_SOURCE_INVALID`);
    metrics[name]=metric;
  }
  const checked=Date.parse(input.checkedAt),current=now.getTime();
  if(input.provider!=='gmgn'||input.chain!=='solana'||!address(input.address))reasons.unshift('ENTRY_HOLDER_RISK_TOKEN_INVALID');
  if(!Number.isFinite(checked)||!Number.isFinite(current)||checked>current)reasons.unshift('ENTRY_HOLDER_RISK_TIME_INVALID');
  else if(current-checked>ENTRY_HOLDER_RISK_MAX_AGE_MS)reasons.unshift('ENTRY_HOLDER_RISK_STALE');
  if(input.completedAt!==undefined&&(!Number.isFinite(Date.parse(input.completedAt))||Date.parse(input.completedAt)<checked||Date.parse(input.completedAt)>current))
    reasons.unshift('ENTRY_HOLDER_RISK_TIME_INVALID');
  return {provider:'gmgn',chain:'solana',address:input.address,checkedAt:input.checkedAt,
    ...(input.completedAt?{completedAt:input.completedAt}:{}),status:exceeded.length?'blocked':reasons.length?'unavailable':'pass',
    reasons:[...new Set([...exceeded,...reasons])],metrics,...(safeEvidence(input.evidence)?{evidence:safeEvidence(input.evidence)}:{})};
}
export function unavailableEntryHolderRisk(address:string,checkedAt:string,reason:string):EntryHolderRiskAssessment {
  const values=Object.fromEntries(names.map(name=>[name,{value:undefined,sourceField:`gmgn.${name}.holding_rate`}]));
  const result=assessEntryHolderRiskValues({provider:'gmgn',chain:'solana',address,checkedAt,values:values as EntryHolderRiskValues['values']},new Date(checkedAt));
  result.reasons=[safeReason(reason)?reason:'ENTRY_HOLDER_RISK_READ_FAILED',...result.reasons];return result;
}

/** Safe persisted/UI projection; never retains vendor payloads, cookies, wallet records or credentials. */
export function normalizeStoredEntryHolderRisk(raw:unknown,expected?:{chain:string;address:string}):EntryHolderRiskAssessment|undefined {
  if(!object(raw)||raw.provider!=='gmgn'||raw.chain!=='solana'||!address(raw.address)||typeof raw.checkedAt!=='string'||
    !Number.isFinite(Date.parse(raw.checkedAt))||!['pass','blocked','unavailable'].includes(String(raw.status))||
    !Array.isArray(raw.reasons)||raw.reasons.length>30||raw.reasons.some(r=>!safeReason(r))||!object(raw.metrics)||
    expected&&(expected.chain!==raw.chain||expected.address!==raw.address))return;
  const metrics={} as EntryHolderRiskAssessment['metrics'];
  for(const name of names){
    const m=raw.metrics[name];if(!object(m)||!['available','missing','invalid'].includes(String(m.status))||m.limitPct!==ENTRY_HOLDER_RISK_LIMITS[name]||
      typeof m.sourceField!=='string'||sourceField(m.sourceField)!==m.sourceField)return;
    const metric:EntryHolderRiskMetric={status:m.status as EntryHolderRiskMetric['status'],limitPct:ENTRY_HOLDER_RISK_LIMITS[name],sourceField:m.sourceField};
    if(m.coverage!==undefined){if(!['complete','lower_bound'].includes(String(m.coverage)))return;metric.coverage=m.coverage as 'complete'|'lower_bound';}
    if(m.lowerBound!==undefined){const lower=rate(m.lowerBound);if(!lower||m.lowerBoundPercentageText!==lower.percentageText)return;
      metric.lowerBound=lower.text;metric.lowerBoundPercentageText=lower.percentageText;}
    if(m.status==='available'){
      const parsed=rate(m.rateText??m.rate);if(!parsed||m.rate!==parsed.ratio||m.percentage!==Number(parsed.percentageText)||
        m.percentageText!==parsed.percentageText||m.exceeded!==(parsed.numerator*100n>BigInt(metric.limitPct)*parsed.denominator))return;
      Object.assign(metric,{rate:parsed.ratio,rateText:parsed.text,percentage:Number(parsed.percentageText),percentageText:parsed.percentageText,exceeded:m.exceeded});
    }else if(['rate','rateText','percentage','percentageText','exceeded'].some(key=>Object.hasOwn(m,key)))return;
    metrics[name]=metric;
  }
  const over=names.some(name=>metrics[name].exceeded),complete=names.every(name=>metrics[name].status==='available'&&!!metrics[name].sourceField&&
    (name==='top10'?metrics[name].coverage!=='lower_bound':metrics[name].coverage==='complete'));
  if(raw.status==='pass'&&(over||!complete||raw.reasons.length!==0)||raw.status==='blocked'&&!over||raw.status==='unavailable'&&(over||!raw.reasons.length))return;
  if(raw.completedAt!==undefined&&(typeof raw.completedAt!=='string'||!Number.isFinite(Date.parse(raw.completedAt))||Date.parse(raw.completedAt)<Date.parse(raw.checkedAt)))return;
  return {provider:'gmgn',chain:'solana',address:raw.address as string,checkedAt:raw.checkedAt,
    ...(typeof raw.completedAt==='string'?{completedAt:raw.completedAt}:{}),status:raw.status as EntryHolderRiskAssessment['status'],
    reasons:[...raw.reasons] as string[],metrics,...(safeEvidence(raw.evidence)?{evidence:safeEvidence(raw.evidence)}:{})};
}
