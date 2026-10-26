import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import type {Chain} from './types.js';
import type {TelegramCallbackButtons} from './telegram-format.js';

export interface TelegramPosition {
  id:string;chain:Chain;wallet:string;address:string;name?:string;symbol?:string;
  quantity?:number;balanceCheckedAt?:string;balanceFresh?:boolean;
  /** Raw token units and mint decimals; these preserve quantities beyond Number precision. */
  quantityAtomic?:string;tokenDecimals?:number;
  priceUsd?:number;priceAt?:string;priceFresh?:boolean;gainPct?:number;
  gainBasis?:'fill'|'observation';protection?:string;canClose?:boolean;
  /** Selects the sell service without creating an action for off-page rows. */
  sellProvider?:'native'|'direct';
  /** Fresh opaque single-use action supplied by the sell service for this page. */
  sellActionRef?:string;
  /** Latest durable sale for this holding; never infer its outcome from a balance alone. */
  sellStatus?:{state:string;percentage:number;requestId:string;reason?:string};
}
const PAGE_SIZE=5,MAX_PAGE=10000;
const activeSellStates=new Set(['accepted','executing','submitting','pending','unknown']);
const directSellRef=/^[0-9a-f]{32}$/;
const nativeSellRef=/^np[0-9a-f]{30}$/;
const validSellRef=(value:unknown):value is string=>typeof value==='string'&&(directSellRef.test(value)||nativeSellRef.test(value));
const preSubmitFailures:Record<string,string>={
  DIRECT_SELL_POSITION_INVALID:'持仓地址无效',DIRECT_SELL_IDENTITY_CHANGED:'持仓地址已改变',
  DIRECT_SELL_POSITION_UNAVAILABLE:'持仓暂不可用',DIRECT_SELL_CHAIN_UNSUPPORTED:'暂不支持该链',
  DIRECT_SELL_NO_BALANCE:'持仓余额为零',DIRECT_SELL_DUST:'数量小于最小交易单位',
  DIRECT_SELL_BALANCE_UNVERIFIED:'暂未取得最新持仓',DIRECT_SELL_GAS_BALANCE_LOW:'手续费余额不足',
  DIRECT_SELL_QUOTE_UNAVAILABLE:'暂未取得有效报价',DIRECT_SELL_BALANCE_CHANGED:'报价期间持仓变化',
  DIRECT_SELL_QUOTE_STALE:'报价已过期',DIRECT_SELL_STOPPED:'服务重启',
  DIRECT_SELL_INTERRUPTED_BEFORE_SUBMIT:'提交前服务中断',DIRECT_SELL_READ_UNAVAILABLE:'行情或链上读取失败',
};
const chainNames:Record<Chain,string>={solana:'SOL',bsc:'BSC',robinhood:'Robinhood'};
const clean=(v:unknown,max=64)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max):'';
const number=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const decimal=(n:number,max=8)=>n.toLocaleString('en-US',{maximumFractionDigits:max});
const stamp=(at:string|undefined)=>at&&Number.isFinite(Date.parse(at))?new Date(at).toLocaleString('zh-CN',{
  timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'未取得';
function saleSummary(sale:NonNullable<TelegramPosition['sellStatus']>):string {
  const pct=`${sale.percentage}%`,request=clean(sale.requestId,12)||'待核对';
  let description:string;
  switch(sale.state){
    case 'accepted':case 'executing':description=`${pct}卖出正在处理`;break;
    case 'submitting':description=`${pct}卖出正在提交，提交结果待确认`;break;
    case 'pending':description=`${pct}卖出已提交待确认`;break;
    case 'unknown':description=`${pct}卖出提交结果待核对`;break;
    case 'completed':description=`最近${pct}卖出已成交`;break;
    case 'closed':description=`最近${pct}卖出已成交，已清仓`;break;
    case 'failed':{
      const before=sale.reason&&Object.hasOwn(preSubmitFailures,sale.reason)?preSubmitFailures[sale.reason]:undefined;
      description=before?`${pct}卖出未提交（${before}）`:sale.reason==='DIRECT_SELL_PROVIDER_FAILED'?
        `${pct}卖出平台确认失败或过期`:`${pct}卖出未完成，失败原因待核对`;
      break;
    }
    default:description=`${pct}卖出状态待核对`;
  }
  return `卖出状态：${description} · 请求 ${request}`;
}
function exactQuantity(p:TelegramPosition):string|undefined {
  if(typeof p.quantityAtomic!=='string'||!/^(0|[1-9]\d{0,79})$/.test(p.quantityAtomic)||
    !Number.isInteger(p.tokenDecimals)||p.tokenDecimals!<0||p.tokenDecimals!>255)return;
  const digits=p.quantityAtomic.padStart(p.tokenDecimals!+1,'0');
  const whole=p.tokenDecimals===0?digits:digits.slice(0,-p.tokenDecimals!);
  const fraction=p.tokenDecimals===0?'':digits.slice(-p.tokenDecimals!).replace(/0+$/,'');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');
}
function identity(p:TelegramPosition){return `${p.chain}:${p.wallet}:${p.chain==='solana'?p.address:p.address.toLowerCase()}`;}
function solanaMint(value:string):boolean {
  if(value.length<32||value.length>44)return false;
  try {const bytes=bs58.decode(value);return bytes.length===32&&bytes.some(byte=>byte!==0)&&bs58.encode(bytes)===value;}
  catch{return false;}
}
export function positionReference(p:TelegramPosition):string {
  return createHash('sha256').update(JSON.stringify([p.id,p.chain,p.wallet,p.address])).digest('hex').slice(0,32);
}

/** Cached registered real holdings only; pagination does not multiply upstream API requests. */
export class TelegramPositions {
  constructor(private readonly rows:()=>TelegramPosition[],private readonly options:{pending?:()=>number;now?:()=>number;
    action?:(position:TelegramPosition)=>string|undefined}={}){}
  private list() {
    const unique=new Map<string,TelegramPosition>();
    for(const row of this.rows()){
      if(!row.id||!row.wallet||!row.address||!Object.hasOwn(chainNames,row.chain)||
        ((exactQuantity(row)!==undefined?row.quantityAtomic==='0':row.quantity===0)&&
          !(row.sellStatus&&activeSellStates.has(row.sellStatus.state))))continue;
      const key=identity(row),current=unique.get(key);
      // The isolated native/Jito runtime issues `np...` capabilities. If a
      // legacy observer exposes the same wallet/mint too, retain the native
      // capability so one holding never renders two competing sell paths.
      const native=row.sellProvider==='native'||nativeSellRef.test(row.sellActionRef??'');
      const currentNative=current&&(current.sellProvider==='native'||nativeSellRef.test(current.sellActionRef??''));
      if(!current||native&&!currentNative)unique.set(key,row);
    }
    return [...unique.values()].sort((a,b)=>identity(a).localeCompare(identity(b)));
  }
  find(ref:string):TelegramPosition|undefined {
    if(!/^[a-f0-9]{32}$/.test(ref))return;
    return this.list().find(p=>positionReference(p)===ref);
  }
  /** Exact current holding for a token card; ambiguity or an in-flight sell is never actionable. */
  findSellableSolanaMint(mint:string):TelegramPosition|undefined {
    if(!solanaMint(mint))return;
    const matches=this.list().filter(p=>p.chain==='solana'&&p.address===mint&&p.canClose===true&&
      !(p.sellStatus&&activeSellStates.has(p.sellStatus.state)));
    if(matches.length!==1)return;
    const match=structuredClone(matches[0]);
    if(!validSellRef(match.sellActionRef))try{match.sellActionRef=this.options.action?.(match);}catch{return;}
    return validSellRef(match.sellActionRef)?match:undefined;
  }
  page(requested:number):{text:string;buttons:TelegramCallbackButtons} {
    if(!Number.isSafeInteger(requested)||requested<1||requested>MAX_PAGE)throw Error('TELEGRAM_POSITION_PAGE_INVALID');
    const rows=this.list(),total=rows.length,pages=Math.max(1,Math.ceil(total/PAGE_SIZE)),page=Math.min(requested,pages);
    const items=rows.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE).map(row=>{
      const item=structuredClone(row),active=!!item.sellStatus&&activeSellStates.has(item.sellStatus.state);
      if(!active&&item.canClose&&!validSellRef(item.sellActionRef))try{item.sellActionRef=this.options.action?.(item);}catch{item.canClose=false;}
      return item;
    });
    const text=[`【持仓查询】`,`第 ${page} / ${pages} 页 · 共 ${total} 个持仓`,
      `更新时间：${stamp(new Date((this.options.now??Date.now)()).toISOString())}（北京时间）`];
    const buttons:TelegramCallbackButtons=[];
    if(!items.length)text.push('\n暂无已登记的实盘持仓。');
    for(let i=0;i<items.length;i++){
      const p=items[i],label=clean(p.name||p.symbol)||'未命名',index=(page-1)*PAGE_SIZE+i+1;
      const quantity=exactQuantity(p);
      const validPrice=number(p.priceUsd)&&p.priceUsd>0;
      const value=validPrice&&number(p.quantity)&&p.quantity>0?p.quantity*p.priceUsd!:undefined;
      text.push(`\n${index}. ${label} · ${chainNames[p.chain]}`,`CA：${clean(p.address,80)}`,
        `持仓：${quantity??(number(p.quantity)&&p.quantity>=0?decimal(p.quantity):'数量待核验')}${p.balanceFresh?'':'（余额待刷新）'}`,
        `现价：${validPrice?'$'+decimal(p.priceUsd!,12):'暂不可用'}${number(value)?' · 估值 $'+decimal(value,2):''}`,
        `涨幅：${number(p.gainPct)?(p.gainPct>=0?'+':'')+decimal(p.gainPct,2)+'%（'+(p.gainBasis==='fill'?'成交价基准':'观察价基准')+'）':'成本或价格待核验'}`,
        `报价：${stamp(p.priceAt)}${p.priceFresh?'':' · 非实时'}`,
        `保护：${clean(p.protection,100)||'状态待核验'}`);
      const activeSale=!!p.sellStatus&&activeSellStates.has(p.sellStatus.state);
      if(p.sellStatus)text.push(saleSummary(p.sellStatus));
      if(activeSale)text.push('本笔卖出仍在处理，暂不重复提交；点击刷新查看结果。');
      if(!activeSale&&p.canClose&&validSellRef(p.sellActionRef))
        buttons.push(([25,50,75,100] as const).map(pct=>({
          text:`${index}·${clean(label,10)} ${pct}%`,callback_data:`sell:${pct}:${p.sellActionRef}`,
        })));
    }
    const pending=this.options.pending?.()??0;
    if(pending>0)text.push(`\n另有 ${pending} 笔开仓成交状态待核验，未计为持仓。`);
    text.push('\n范围：系统已登记的实盘持仓；估值不含费用。',
      '卖出 25% / 50% / 75% / 100%：按点击时最新持仓数量计算，点击即卖出，无需再次确认。',
      '每行按钮对应上方同序号代币；一次操作后请刷新持仓。');
    const navigation:TelegramCallbackButtons[number]=[];
    if(page>1)navigation.push({text:'⬅️ 上一页',callback_data:`positions:${page-1}`});
    navigation.push({text:'🔄 刷新',callback_data:`positions:${page}`});
    if(page<pages)navigation.push({text:'下一页 ➡️',callback_data:`positions:${page+1}`});
    buttons.push(navigation);
    return {text:text.join('\n'),buttons};
  }
}
