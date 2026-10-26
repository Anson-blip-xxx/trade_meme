import bs58 from 'bs58';

export type TelegramReplyMarkup=
  | {inline_keyboard:TelegramInlineButton[][];keyboard?:never}
  | {keyboard:{text:string}[][];resize_keyboard:true;is_persistent:true;one_time_keyboard:false;input_field_placeholder:string;inline_keyboard?:never};
export type TelegramCallbackButton={text:string;callback_data:string;url?:never};
export type TelegramUrlButton={text:string;url:string;callback_data?:never};
export type TelegramInlineButton=TelegramCallbackButton|TelegramUrlButton;
export type TelegramCallbackButtons=Array<Array<TelegramCallbackButton>>;
export type TelegramNotificationButtons=Array<Array<TelegramInlineButton>>;
export const TELEGRAM_CLOSE_UUID='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
/** Direct-sell capabilities are either legacy hex or the native-position `np` namespace. */
export const TELEGRAM_SELL_REF='(?:[0-9a-f]{32}|np[0-9a-f]{30})';
/** Compact, server-owned codes keep token buy callbacks below Telegram's 64-byte limit. */
export const TELEGRAM_TOKEN_BUY_PRESETS={a:'0.1',b:'0.5',c:'1',d:'3',e:'5'} as const;
export type TelegramTokenBuyPresetCode=keyof typeof TELEGRAM_TOKEN_BUY_PRESETS;
const closeCallback=new RegExp(`^close:(?:preview:[0-9a-f]{32}|(?:confirm|cancel):${TELEGRAM_CLOSE_UUID})$`);
const sellCallback=new RegExp(`^sell:(25|30|50|75|100):(${TELEGRAM_SELL_REF})$`);
const customSellCallback=new RegExp(`^sell:custom:(${TELEGRAM_SELL_REF})$`);
const nativeBuyCallback=/^nativebuy:(?:confirm|cancel):[0-9a-f]{32}$/;
const tokenRefreshCallback=/^token:refresh:([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const legacyTokenBuyCallback=/^token:buy:([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const tokenBuyCallback=/^token:buy:([abcde]):([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const tokenCustomCallback=/^token:custom:([1-9A-HJ-NP-Za-km-z]{32,44})$/;

/** Only generated application callbacks are accepted by interactive control replies. */
export function validateTelegramCallbackButtons(value:unknown):TelegramCallbackButtons|undefined {
  return validateButtons(value,false) as TelegramCallbackButtons|undefined;
}

/**
 * Durable notifications may combine application callbacks with exact official
 * Solana token links. The closed URL allowlist deliberately excludes generic
 * website paths, redirects, credentials, ports, queries and fragments.
 */
export function validateTelegramNotificationButtons(value:unknown):TelegramNotificationButtons|undefined {
  return validateButtons(value,true);
}

function validateButtons(value:unknown,allowUrls:boolean):TelegramNotificationButtons|undefined {
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length<1||value.length>10)throw new Error('TELEGRAM_BUTTONS_INVALID');
  return value.map(row=>{
    if(!Array.isArray(row)||row.length<1||row.length>4)throw new Error('TELEGRAM_BUTTONS_INVALID');
    // Four columns are reserved for position sells, token-card sells, or the
    // exact official-link row; retain the existing three-button bound for
    // pagination and legacy confirmation rows.
    if(row.length===4&&!validFourButtonSellRow(row)&&
      !(allowUrls&&row.every(button=>button&&typeof button==='object'&&typeof button.url==='string'&&safeSolanaTokenUrl(button.url))))
      throw new Error('TELEGRAM_BUTTONS_INVALID');
    return row.map(button=>{
      if(typeof button!=='object'||button===null||Array.isArray(button)||
        Object.keys(button).length!==2||typeof button.text!=='string'||!button.text.trim()||button.text.length>64||
        /[\r\n\x00-\x1f\x7f]/.test(button.text))throw new Error('TELEGRAM_BUTTONS_INVALID');
      if('url' in button) {
        if(!allowUrls||typeof button.url!=='string'||!safeSolanaTokenUrl(button.url)||'callback_data' in button)
          throw new Error('TELEGRAM_BUTTONS_INVALID');
        return {text:button.text,url:button.url};
      }
      if(typeof button.callback_data!=='string'||'url' in button||Buffer.byteLength(button.callback_data)>64)
        throw new Error('TELEGRAM_BUTTONS_INVALID');
      const page=button.callback_data.match(/^positions:([1-9]\d{0,4})$/)?.[1];
      const token=button.callback_data.match(tokenRefreshCallback)?.[1];
      const buyToken=button.callback_data.match(tokenBuyCallback)?.[2]??
        button.callback_data.match(legacyTokenBuyCallback)?.[1];
      const customToken=button.callback_data.match(tokenCustomCallback)?.[1];
      if(!(page&&Number(page)<=10000)&&!closeCallback.test(button.callback_data)&&!sellCallback.test(button.callback_data)&&
        !nativeBuyCallback.test(button.callback_data)&&!(token&&validAddress('sol',token))&&
        !(buyToken&&validAddress('sol',buyToken))&&!(customToken&&validAddress('sol',customToken))&&
        !customSellCallback.test(button.callback_data))
        throw new Error('TELEGRAM_BUTTONS_INVALID');
      return {text:button.text,callback_data:button.callback_data};
    });
  });
}

function validFourButtonSellRow(row:unknown[]):boolean {
  const callbacks=row.map(button=>button&&typeof button==='object'&&!Array.isArray(button)&&
    typeof (button as Record<string,unknown>).callback_data==='string'?
    String((button as Record<string,unknown>).callback_data):undefined);
  if(callbacks.some(value=>value===undefined))return false;
  const first=callbacks[0]!.match(sellCallback),ref=first?.[2];
  if(!ref)return false;
  return [
    ['25','50','75','100'].map(pct=>`sell:${pct}:${ref}`),
    ['30','50','100'].map(pct=>`sell:${pct}:${ref}`).concat(`sell:custom:${ref}`),
  ].some(expected=>expected.every((value,index)=>callbacks[index]===value));
}

function safeSolanaTokenUrl(value:string):boolean {
  const match=value.match(/^https:\/\/(?:gmgn\.ai\/sol\/token|dexscreener\.com\/solana|solscan\.io\/token|pump\.fun\/coin)\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  return !!match&&validAddress('sol',match[1]);
}
export interface TelegramFormattedMessage {
  text:string;
  parse_mode:'HTML';
  link_preview_options:{is_disabled:true};
  reply_markup?:TelegramReplyMarkup;
}
interface Line {html:string;plain:string;}
type Chain='sol'|'bsc'|'robinhood';

function positionsNavigation(lines:string[]):TelegramReplyMarkup|undefined {
  if(lines[0]!=='【持仓查询】')return;
  const match=lines[1]?.match(/^第 ([1-9]\d{0,4}) \/ ([1-9]\d{0,4}) 页 · 共 (0|[1-9]\d*) 个持仓$/);
  if(!match)return;
  const page=Number(match[1]),pages=Number(match[2]),total=Number(match[3]);
  if(page>pages||pages>10000||!Number.isSafeInteger(total))return;
  const buttons:TelegramInlineButton[]=[];
  if(page>1)buttons.push({text:'‹ 上一页',callback_data:`positions:${page-1}`});
  buttons.push({text:'刷新',callback_data:`positions:${page}`});
  if(page<pages)buttons.push({text:'下一页 ›',callback_data:`positions:${page+1}`});
  return {inline_keyboard:[buttons]};
}

function escape(value:string):string {
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function validAddress(chain:Chain,value:string):boolean {
  if(chain!=='sol')return /^0x[\da-fA-F]{40}$/.test(value);
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;
  try {const decoded=bs58.decode(value);return decoded.length===32&&decoded.some(byte=>byte!==0)&&bs58.encode(decoded)===value;}catch{return false;}
}
function chainName(value:string):Chain|undefined {
  const names:Record<string,Chain>={sol:'sol',solana:'sol',bsc:'bsc','bnb chain':'bsc',robinhood:'robinhood','robinhood chain':'robinhood'};
  return Object.hasOwn(names,value.trim().toLowerCase())?names[value.trim().toLowerCase()]:undefined;
}

/** Only a standalone, exact HTTPS token URL matching this message's chain and CA becomes a button. */
function gmgnButton(lines:string[]):{url:string;indexes:Set<number>}|undefined {
  const chains=new Set<Chain>();
  for(const [index,line] of lines.entries()) {
    const label=line.match(/^链[：:]\s*(.+)$/)?.[1];
    const title=index===0?line.match(/^【[^】]+】.* · ([^·]+)$/)?.[1]:undefined;
    const chain=chainName(label??title??'');
    if((label||title)&&!chain)return;
    if(chain)chains.add(chain);
  }
  if(chains.size!==1)return;
  const chain=[...chains][0];
  const addresses=lines.flatMap(line=>line.match(/^CA[：:]\s*(\S+)\s*$/)?.[1]??[]);
  if(!addresses.length||addresses.some(value=>!validAddress(chain,value)))return;
  const normalize=(address:string)=>chain==='sol'?address:address.toLowerCase();
  const unique=new Set(addresses.map(normalize));
  if(unique.size!==1)return;
  const indexes=new Set<number>();let url:string|undefined;
  for(const [index,line] of lines.entries()) {
    const match=line.match(/^(?:GMGN[：:]\s*)?(https:\/\/gmgn\.ai\/(sol|bsc|robinhood)\/token\/([A-Za-z0-9]+))$/);
    if(!match||match[2]!==chain||!validAddress(chain,match[3])||!unique.has(normalize(match[3])))continue;
    indexes.add(index);url??=match[1];
  }
  return url?{url,indexes}:undefined;
}

function percentages(value:string):string {
  // Match raw text, then escape each segment: user-supplied HTML never becomes markup.
  let out='',start=0;
  for(const match of value.matchAll(/[+−-]?(?:\d+(?:\.\d+)?|\.\d+)%/g)) {
    out+=escape(value.slice(start,match.index))+`<b>${escape(match[0])}</b>`;
    start=match.index!+match[0].length;
  }
  return out+escape(value.slice(start));
}
function renderLine(line:string,index:number):Line {
  const title=index===0?line.match(/^【([^】\r\n]{1,80})】(.*)$/):undefined;
  if(title) {
    const icon=line.startsWith('【实盘持仓监控】')?'📊':line.startsWith('【实盘订单】')?'🧾':
      line.startsWith('【模拟持仓')||line.startsWith('【测试买入】')?'🧪':line.startsWith('【计数控制】')?'🎛':line.startsWith('【持仓查询】')?'💼':'📌';
    if(title[1]==='实盘持仓监控'&&title[2].trim())return {
      html:`${icon} <b>${escape(title[2].trim())}</b>\n${escape(title[1])}`,
      plain:`${icon} ${title[2].trim()}\n${title[1]}`,
    };
    const value=title[1]+(title[2]?' · '+title[2]:'');
    return {html:`${icon} <b>${escape(value)}</b>`,plain:`${icon} ${value}`};
  }
  if(/^(?:价格越过|价格涨跌观察)/.test(line)) {
    const signs=[...line.matchAll(/([+−-])\d+(?:\.\d+)?%/g)].map(match=>match[1]);
    const icon=signs.length&&signs.every(sign=>sign==='+')?'📈':signs.length&&signs.every(sign=>sign!=='+')?'📉':'📊';
    return {html:`${icon} <b>${escape(line)}</b>`,plain:`${icon} ${line}`};
  }
  if(/^(?:通知设置更新|监控档位已更新|涨幅提醒档位已更新)/.test(line)) {
    return {html:`🔔 <b>${escape(line)}</b>`,plain:`🔔 ${line}`};
  }
  const field=line.match(/^([^：:\r\n]{1,40})([：:])(.*)$/);
  if(field) {
    const [,label,colon,value]=field;
    const isCode=/^(?:CA|开仓单|订单号?|GMGN\s*单号|策略单|条件单|开仓交易|平仓交易|交易哈希|交易签名|Hash|hash|Signature|signature)$/.test(label);
    const isKey=/^(?:代币|名称|链|相对买入价|相对观察基准|监控以来采样峰值|观察峰值|距峰值回撤|从峰值回撤|当前参考价|买入美元价|最新价格|剩余数量|最终收益|实际收益|累计收益|当前涨幅|最高涨幅|涨跌幅|涨幅|收益率)$/.test(label);
    if(isCode)return {html:`${escape(label+colon)}<code>${escape(value)}</code>`,plain:line};
    if(isKey)return {html:`<b>${escape(label)}</b>${escape(colon)}${percentages(value)}`,plain:line};
  }
  if(/^(?:价格越过|价格涨跌观察|涨幅提醒|止盈|止损|相对|监控以来采样峰值|距峰值回撤)/.test(line)) {
    return {html:percentages(line),plain:line};
  }
  return {html:escape(line),plain:line};
}

/**
 * Persist plaintext; apply presentation only at delivery. Telegram's 4096 limit is
 * measured after entity parsing, not the escaped wire length. UTF-16 counting is
 * conservative for emoji. If added decoration exceeds the limit, retain the full
 * original message with escaping only; never truncate amounts, errors or caveats.
 * https://core.telegram.org/bots/api#sendmessage and #html-style
 */
export function formatTelegramMessage(text:string):TelegramFormattedMessage {
  if(typeof text!=='string'||!text.trim()||text.length>4096)throw new Error('TELEGRAM_MESSAGE_LENGTH_INVALID');
  const controls=text.startsWith('【计数控制】');
  const lines=text.split('\n'),positions=lines[0]==='【持仓查询】';
  const button=controls||positions?undefined:gmgnButton(lines),rendered:Line[]=[];
  const reply_markup:TelegramReplyMarkup|undefined=controls?{
    keyboard:[[{text:'启动计数'},{text:'停止计数'}],[{text:'计数状态'},{text:'持仓查询'}],[{text:'🧪 0.01 SOL 测试买入'}]],
    resize_keyboard:true,is_persistent:true,one_time_keyboard:false,input_field_placeholder:'计数 · 持仓 · 0.01 SOL 测试买入',
  }:positions?positionsNavigation(lines):button?{inline_keyboard:[[{text:'查看 GMGN',url:button.url}]]}:undefined;
  for(const [index,line] of lines.entries()) {
    if(button?.indexes.has(index))continue;
    if(rendered.length&&line&&rendered.at(-1)!.plain&&
      ((index===1&&/^【[^】]+】/.test(lines[0]))||/^CA[：:]/.test(line)))rendered.push({html:'',plain:''});
    rendered.push(renderLine(line,index));
  }
  const visible=rendered.map(line=>line.plain).join('\n');
  if(!visible.trim()||visible.length>4096)return {text:escape(text),parse_mode:'HTML',link_preview_options:{is_disabled:true},
    ...((controls||positions)&&reply_markup?{reply_markup}:{})};
  return {
    text:rendered.map(line=>line.html).join('\n'),parse_mode:'HTML',link_preview_options:{is_disabled:true},
    ...(reply_markup?{reply_markup}:{}),
  };
}
