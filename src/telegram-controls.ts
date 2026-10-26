import {createHash} from 'node:crypto';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {telegramIpv4Fetch} from './telegram-transport.js';
import {TELEGRAM_CLOSE_UUID,TELEGRAM_SELL_REF,TELEGRAM_TOKEN_BUY_PRESETS,validateTelegramNotificationButtons,
  type TelegramCallbackButtons,type TelegramNotificationButtons,type TelegramTokenBuyPresetCode} from './telegram-format.js';

export type TelegramCountAction='start'|'stop'|'status';
export type TelegramCloseAction='preview'|'confirm'|'cancel';
/** Runtime-validated integer percentage in the inclusive 1..100 range. */
export type TelegramSellPct=number;
export type TelegramTokenBuyAction='preset'|'custom_start'|'custom_value'|'cancel';
export type TelegramTokenBuyCode=TelegramTokenBuyPresetCode|'legacy';
export {TELEGRAM_TOKEN_BUY_PRESETS};
export type {TelegramCallbackButtons,TelegramNotificationButtons,TelegramTokenBuyPresetCode} from './telegram-format.js';
export type TelegramControlReply=string|{text:string;buttons?:TelegramNotificationButtons};
export interface TelegramControlStatus {
  enabled:true;
  mode:'simulation_only'|'live_counting'|'counting_and_manual_positions';
  countingMode:'simulation'|'live';
  manualCloseEnabled:boolean;
  manualBuyEnabled:boolean;
  running:boolean;
  closed:boolean;
  blocked:boolean;
  lastError?:string;
  initialized?:boolean;
  offset?:number;
  lastPollAt?:string;
  lastActionAt?:string;
  processed?:number;
  interrupted?:number;
  pendingReplies?:number;
  pendingTokenCards?:number;
}
export interface TelegramControlsOptions {
  token:string;
  chatId:string;
  database:string;
  /** Configured strategy for explicit /count_start; this does not report whether a run is active. */
  countingMode?:'simulation'|'live';
  fetcher?:typeof globalThis.fetch;
  onAction:(action:TelegramCountAction)=>Promise<string>|string;
  onPositions?:(page:number)=>Promise<TelegramControlReply>|TelegramControlReply;
  onClose?:(action:TelegramCloseAction,ref:string)=>Promise<TelegramControlReply>|TelegramControlReply;
  /** The reference is an opaque server-side, single-use action; the handler accepts work quickly. */
  onSell?:(ref:string,pct:TelegramSellPct)=>Promise<TelegramControlReply>|TelegramControlReply;
  /**
   * Exact owner-operated card buy flow. Presets carry an allowlisted compact code;
   * custom values are strict decimal text and are authorized against pending state by the handler.
   */
  onTokenBuy?:(action:TelegramTokenBuyAction,address?:string,value?:string)=>Promise<TelegramControlReply>|TelegramControlReply;
  /** Exact Solana mint lookup. `refresh` bypasses the short data cache; lookup itself must never submit a trade. */
  onTokenCard?:(address:string,refresh:boolean)=>Promise<TelegramControlReply>|TelegramControlReply;
  enqueue:(notification:{key:string;text:string;buttons?:TelegramNotificationButtons})=>boolean;
  now?:()=>number;
}
type Row=Record<string,unknown>;
type ControlError='TELEGRAM_CONTROLS_AUTH_INVALID'|'TELEGRAM_CONTROLS_FORBIDDEN'|
  'TELEGRAM_CONTROLS_WEBHOOK_ACTIVE'|'TELEGRAM_CONTROLS_POLL_CONFLICT'|'TELEGRAM_CONTROLS_RATE_LIMITED'|
  'TELEGRAM_CONTROLS_UNAVAILABLE'|'TELEGRAM_CONTROLS_RESPONSE_INVALID'|'TELEGRAM_CONTROLS_NETWORK_ERROR'|
  'TELEGRAM_CONTROLS_REQUEST_TIMEOUT'|'TELEGRAM_CONTROLS_REQUEST_REJECTED'|'TELEGRAM_CONTROLS_ACTION_FAILED'|
  'TELEGRAM_CONTROLS_REPLY_INVALID'|'TELEGRAM_CONTROLS_QUEUE_FAILED'|'TELEGRAM_CONTROLS_STORAGE_ERROR';
class ApiError extends Error {
  constructor(readonly code:ControlError,readonly delay=5000,readonly blocked=false){super(code);}
}
type Command=({action:TelegramCountAction;help?:boolean}|{action:'positions';page:number;help?:never}|
  {action:'close';closeAction:TelegramCloseAction;ref:string;help?:never}|
  {action:'sell';pct:TelegramSellPct;ref:string;custom?:boolean;help?:never}|
  {action:'sell_custom';ref:string;help?:never}|
  {action:'token_card';address:string;refresh:boolean;help?:never}|
  {action:'token_buy';buyAction:TelegramTokenBuyAction;address?:string;value?:string;help?:never})&{callbackId?:string};
type AckOnly={action:'ack_only';callbackId:string;text:string};
type TokenCardCommand=Extract<Command,{action:'token_card'}>;
type TokenCardJob={updateId:number;command:TokenCardCommand};
const TOKEN_CARD_QUEUE_CAPACITY=16;
const object=(value:unknown):value is Row=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const positiveId=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const updateId=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
const forward=(value:Row)=>['forward_origin','forward_from','forward_from_chat','forward_sender_name','forward_date',
  'is_automatic_forward','via_bot','sender_chat','business_connection_id','sender_business_bot','edit_date'].some(key=>value[key]!==undefined);
const help=(mode:'simulation'|'live')=>`计数控制（${mode==='live'?'实盘策略':'仅模拟'}）：\n启动计数 /count_start${mode==='live'?'（后续达标自动买入）':''}\n停止计数 /count_stop${mode==='live'?'（持仓监控与保护继续）':''}\n计数状态 /count_status\n持仓查询 /positions（可加页码，如 /positions 2）\n代币查询：发送完整 CA，或 /token <CA>\n买入：先查询 CA，再使用代币卡片上的金额按钮\n/start 仅查询状态，不启动计数，不会触发买卖。`;
const positionsPage=(value:string):number|undefined=>/^[1-9]\d{0,4}$/.test(value)&&Number(value)<=10000?Number(value):undefined;
const closeConfirmedCallback=new RegExp(`^close:(confirm|cancel):(${TELEGRAM_CLOSE_UUID})$`);
const tokenCancelCallback=/^(?:token:cancel|nativebuy:cancel):([0-9a-f]{32})$/;
const removedNativeBuyCallback=/^nativebuy:confirm:[0-9a-f]{32}$/;
const tokenBuyCallback=/^token:buy:([abcde]):([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const legacyTokenBuyCallback=/^token:buy:([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const tokenCustomCallback=/^token:custom:([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const sellCallback=new RegExp(`^sell:(25|30|50|75|100):(${TELEGRAM_SELL_REF})$`);
const customSellCallback=new RegExp(`^sell:custom:(${TELEGRAM_SELL_REF})$`);
const TOKEN_SELL_CUSTOM_TTL_MS=5*60*1000;
const customSolAmount=(value:string):boolean=>{
  if(!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value))return false;
  return !/^0(?:\.0{1,9})?$/.test(value);
};
function solanaAddress(value:string):boolean {
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;
  try {const decoded=bs58.decode(value);return decoded.length===32&&decoded.some(byte=>byte!==0)&&bs58.encode(decoded)===value;}
  catch{return false;}
}
const customSellPercentage=(value:string):string|undefined=>value.match(/^([1-9]\d?|100)%$/)?.[1];

/**
 * Private-chat commands for configured signal strategies, read-only holdings queries and
 * optional explicit per-position close callbacks. Trading is delegated to the
 * caller; legacy confirmations require a fresh private own-bot message, while
 * direct sell buttons use server-owned single-use action references.
 * A single receiver should own a bot. Commands are durably claimed BEFORE actions
 * and never replayed after a crash. An interrupted action is reported as uncertain,
 * rather than invoking a potentially stateful start again. Replies use the existing
 * notifier outbox, so this class never competes with its sendMessage consumer.
 * https://core.telegram.org/bots/api#getupdates and #callbackquery
 */
export class TelegramControls {
  private readonly db:DatabaseSync;
  private readonly scope:string;
  private readonly token:string;
  private readonly chatId:string;
  private readonly botId:string;
  private readonly fetcher:typeof globalThis.fetch;
  private readonly now:()=>number;
  private running=false;
  private closed=false;
  private blocked=false;
  private stopping=false;
  private timer?:ReturnType<typeof setTimeout>;
  private readonly controllers=new Set<AbortController>();
  private readonly acknowledgements=new Set<Promise<void>>();
  private inFlight?:Promise<void>;
  private closing?:Promise<void>;
  private memoryError?:ControlError;
  private readonly tokenCardQueue:TokenCardJob[]=[];
  private tokenCardWorker?:Promise<void>;
  private tokenCardKick?:ReturnType<typeof setImmediate>;
  private tokenCardActive=0;

  constructor(private readonly options:TelegramControlsOptions) {
    this.token=options.token?.trim();this.chatId=options.chatId?.trim();
    if(!/^\d+:[A-Za-z0-9_-]+$/.test(this.token??'')||!/^\d+$/.test(this.chatId??'')||
      !positiveId(Number(this.chatId))||String(Number(this.chatId))!==this.chatId||
      typeof options.onAction!=='function'||(options.onPositions!==undefined&&typeof options.onPositions!=='function')||
      (options.onClose!==undefined&&typeof options.onClose!=='function')||
      (options.onSell!==undefined&&typeof options.onSell!=='function')||
      (options.onTokenBuy!==undefined&&typeof options.onTokenBuy!=='function')||
      (options.onTokenCard!==undefined&&typeof options.onTokenCard!=='function')||
      (options.countingMode!==undefined&&!['simulation','live'].includes(options.countingMode))||
      typeof options.enqueue!=='function'||!options.database)
      throw new Error('TELEGRAM_CONTROLS_CONFIG_INVALID');
    this.botId=this.token.split(':')[0];
    this.scope=createHash('sha256').update(this.botId+'\0'+this.chatId).digest('hex');
    this.now=options.now??Date.now;this.fetcher=options.fetcher??telegramIpv4Fetch;
    if(options.database!==':memory:')mkdirSync(dirname(options.database),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.database);
    if(options.database!==':memory:')chmodSync(options.database,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1500;
      CREATE TABLE IF NOT EXISTS telegram_control_state (
        scope TEXT PRIMARY KEY,initialized INTEGER NOT NULL DEFAULT 0,offset INTEGER NOT NULL DEFAULT 0,
        initialized_at INTEGER,last_poll_at INTEGER,last_action_at INTEGER,last_error TEXT,next_poll_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS telegram_control_events (
        scope TEXT NOT NULL,update_id INTEGER NOT NULL,action TEXT NOT NULL,state TEXT NOT NULL,
        created_at INTEGER NOT NULL,reply TEXT,queued INTEGER NOT NULL DEFAULT 0,reply_buttons TEXT,PRIMARY KEY(scope,update_id));
      CREATE TABLE IF NOT EXISTS telegram_control_pending_token_sell (
        scope TEXT PRIMARY KEY,ref TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(telegram_control_events)').all().some(row=>row.name==='reply_buttons'))
      this.db.exec('ALTER TABLE telegram_control_events ADD COLUMN reply_buttons TEXT');
    this.db.prepare('INSERT OR IGNORE INTO telegram_control_state(scope) VALUES(?)').run(this.scope);
    this.db.prepare(`UPDATE telegram_control_events SET state='interrupted',reply_buttons=NULL,
      reply=CASE WHEN action='positions' THEN ? WHEN action IN ('close','sell','sell_custom') THEN ? WHEN action IN ('native_buy','token_buy') THEN ? WHEN action='token_card' THEN ? ELSE ? END
      WHERE scope=? AND state='claimed'`).run('【持仓查询】\n上次查询时服务中断，请重新发送 /positions。',
        '【平仓操作】\n上次平仓操作时服务中断，结果待核对；不会自动重放。请查询持仓和订单状态。',
        '【测试买入】\n上次操作时服务中断。系统不会重复发送买单；请先查询持仓和订单状态，再重新打开测试买入。',
        '【代币详情】\n上次查询时服务中断，请重新发送完整 CA。',
        '【计数控制】\n上次计数指令执行时服务中断，状态尚待核对；不会自动重放。请发送 /count_status。',this.scope);
  }

  start():void {
    if(this.closed||this.closing||this.running||this.stopping)return;
    this.running=true;this.blocked=false;this.schedule();this.scheduleTokenCardWorker();
  }
  async stop():Promise<void> {
    this.running=false;this.stopping=true;if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    if(this.tokenCardKick)clearImmediate(this.tokenCardKick);this.tokenCardKick=undefined;
    for(const controller of this.controllers)controller.abort();
    await this.inFlight;await this.tokenCardWorker;await Promise.allSettled([...this.acknowledgements]);this.stopping=false;
  }
  close():Promise<void> {
    if(this.closing)return this.closing;if(this.closed)return Promise.resolve();
    this.closing=(async()=>{await this.stop();this.db.close();this.closed=true;})();return this.closing;
  }
  status():TelegramControlStatus {
    const countingMode=this.options.countingMode??'simulation';
    const manualCloseEnabled=!!(this.options.onClose||this.options.onSell);
    const manualBuyEnabled=!!this.options.onTokenBuy;
    const mode=manualCloseEnabled?'counting_and_manual_positions':countingMode==='live'?'live_counting':'simulation_only';
    const capability:Pick<TelegramControlStatus,'mode'|'countingMode'|'manualCloseEnabled'|'manualBuyEnabled'>=
      {mode,countingMode,manualCloseEnabled,manualBuyEnabled};
    if(this.closed)return {enabled:true,...capability,running:false,closed:true,blocked:this.blocked,lastError:this.memoryError};
    const state=this.state();
    const counts=this.db.prepare('SELECT state,count(*) n FROM telegram_control_events WHERE scope=? GROUP BY state').all(this.scope);
    return {enabled:true,...capability,running:this.running,closed:false,blocked:this.blocked,
      initialized:state.initialized===1,offset:Number(state.offset),
      lastError:this.memoryError??(typeof state.last_error==='string'?state.last_error:undefined),
      lastPollAt:iso(state.last_poll_at),lastActionAt:iso(state.last_action_at),
      processed:counts.reduce((n,row)=>n+Number(row.n),0),
      interrupted:counts.filter(row=>row.state==='interrupted').reduce((n,row)=>n+Number(row.n),0),
      pendingReplies:Number(this.db.prepare('SELECT count(*) n FROM telegram_control_events WHERE scope=? AND queued=0 AND reply IS NOT NULL').get(this.scope)?.n??0),
      pendingTokenCards:this.tokenCardQueue.length+this.tokenCardActive};
  }
  /** Wait for bounded read-only lookups without coupling them to the update consumer. */
  async waitForTokenCards():Promise<void> {
    if(this.closed)return;
    this.scheduleTokenCardWorker();
    while(this.tokenCardKick||this.tokenCardWorker||this.tokenCardQueue.length) {
      if(this.tokenCardKick&&!this.tokenCardWorker)await new Promise<void>(resolve=>setImmediate(resolve));
      const worker=this.tokenCardWorker;if(worker)await worker;
      else this.scheduleTokenCardWorker();
    }
  }
  /** One bounded poll, also useful for deterministic local tests; concurrent calls share one request. */
  pollOnce():Promise<void> {
    if(this.closed||this.closing||this.stopping||this.blocked)return Promise.resolve();
    if(this.inFlight)return this.inFlight;
    this.inFlight=this.poll().catch(error=>{
      const safe=error instanceof ApiError?error:new ApiError('TELEGRAM_CONTROLS_STORAGE_ERROR',5000,true);
      if(this.stopping)return;
      this.memoryError=safe.code;this.blocked=safe.blocked;
      if(this.blocked)this.running=false;
      try {this.db.prepare('UPDATE telegram_control_state SET last_error=?,next_poll_at=? WHERE scope=?')
        .run(safe.code,this.now()+safe.delay,this.scope);}catch {this.memoryError='TELEGRAM_CONTROLS_STORAGE_ERROR';this.running=false;this.blocked=true;}
    }).finally(()=>{this.inFlight=undefined;this.schedule();this.scheduleTokenCardWorker();});
    return this.inFlight;
  }
  private state():Row {return this.db.prepare('SELECT * FROM telegram_control_state WHERE scope=?').get(this.scope)!;}
  private schedule():void {
    if(!this.running||this.closed||this.closing||this.stopping||this.inFlight||this.blocked)return;
    if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.timer=undefined;void this.pollOnce();},Math.max(50,Number(this.state().next_poll_at)-this.now()));
    this.timer.unref();
  }
  private async poll():Promise<void> {
    this.flushReplies();
    const state=this.state();if(this.now()<Number(state.next_poll_at))return;
    const initialized=state.initialized===1,offset=Number(state.offset);
    const result=await this.api('getUpdates',{offset:initialized?offset:-1,limit:initialized?100:1,
      timeout:initialized?20:0,allowed_updates:['message','callback_query']});
    if(this.stopping)return;
    if(!Array.isArray(result)||result.length>100||result.some(row=>!object(row)||!updateId(row.update_id)))
      throw new ApiError('TELEGRAM_CONTROLS_RESPONSE_INVALID');
    const updates=(result as Row[]).sort((a,b)=>Number(a.update_id)-Number(b.update_id));
    if(this.memoryError!=='TELEGRAM_CONTROLS_QUEUE_FAILED')this.memoryError=undefined;
    this.db.prepare('UPDATE telegram_control_state SET last_poll_at=?,last_error=NULL,next_poll_at=? WHERE scope=?')
      .run(this.now(),this.now()+500,this.scope);
    if(!initialized) {
      this.db.prepare('UPDATE telegram_control_state SET initialized=1,initialized_at=?,offset=? WHERE scope=?')
        .run(this.now(),updates.length?Number(updates.at(-1)!.update_id)+1:0,this.scope);
      return;
    }
    for(const update of updates) {
      if(this.stopping)break;
      const id=Number(update.update_id);if(id<Number(this.state().offset))continue;
      const command=this.command(update);
      // Advance ignored updates too, so an unauthorized sender cannot stall the receiver.
      this.db.exec('BEGIN IMMEDIATE');let claimed=false;
      try {
        this.db.prepare('UPDATE telegram_control_state SET offset=MAX(offset,?) WHERE scope=?').run(id+1,this.scope);
        if(command&&command.action!=='ack_only')claimed=!!this.db.prepare(`INSERT OR IGNORE INTO telegram_control_events(scope,update_id,action,state,created_at) VALUES(?,?,?,'claimed',?)`)
          .run(this.scope,id,command.action,this.now()).changes;
        if(claimed&&command?.action==='sell'&&command.custom===true)
          this.db.prepare('DELETE FROM telegram_control_pending_token_sell WHERE scope=? AND ref=? AND expires_at>=?')
            .run(this.scope,command.ref,this.now());
        this.db.exec('COMMIT');
      }catch{this.db.exec('ROLLBACK');throw new Error('TELEGRAM_CONTROLS_STORAGE_ERROR');}
      if(command?.action==='ack_only') {
        if(!this.stopping)this.answerCallback(command.callbackId,command.text);
        continue;
      }
      if(!command||!claimed)continue;
      // Callback acknowledgement is best effort and independent. Telegram being
      // slow here must not leave an urgent sell/stop behind a read-only refresh.
      if(command.callbackId&&!this.stopping)this.acknowledge(command as Command&{callbackId:string});
      if(this.stopping)break;
      // Token details can spend several seconds on GMGN/RPC. Keep them on a bounded,
      // single-concurrency read queue so later stop/sell/buy controls in this batch
      // are consumed first and future getUpdates polls are never held by the lookup.
      if(command.action==='token_card') {
        if(this.tokenCardQueue.length+this.tokenCardActive>=TOKEN_CARD_QUEUE_CAPACITY)
          this.persistReply(id,'failed','【代币详情】\n查询队列已满，请稍后重新发送完整 CA。');
        else this.tokenCardQueue.push({updateId:id,command});
        continue;
      }
      await this.executeAndPersist(id,command);
    }
  }
  private scheduleTokenCardWorker():void {
    if(this.closed||this.closing||this.stopping||this.tokenCardKick||this.tokenCardWorker||!this.tokenCardQueue.length)return;
    this.tokenCardKick=setImmediate(()=>{
      this.tokenCardKick=undefined;
      if(this.closed||this.closing||this.stopping||this.tokenCardWorker||!this.tokenCardQueue.length)return;
      const worker=this.drainTokenCardQueue();this.tokenCardWorker=worker;
      void worker.then(()=>{
        if(this.tokenCardWorker===worker)this.tokenCardWorker=undefined;
        this.scheduleTokenCardWorker();
      },()=>{
        if(this.tokenCardWorker===worker)this.tokenCardWorker=undefined;
        this.memoryError='TELEGRAM_CONTROLS_STORAGE_ERROR';this.blocked=true;this.running=false;
      });
    });
    this.tokenCardKick.unref();
  }
  private async drainTokenCardQueue():Promise<void> {
    while(!this.closed&&!this.closing&&!this.stopping) {
      const job=this.tokenCardQueue.shift();if(!job)return;
      this.tokenCardActive=1;
      try {await this.executeAndPersist(job.updateId,job.command);}
      finally {this.tokenCardActive=0;}
      // Give Telegram update processing a turn before starting another low-priority lookup.
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
  }
  private async executeAndPersist(id:number,command:Command):Promise<void> {
    let reply:string,buttons:TelegramNotificationButtons|undefined,actionState='done';
    try {
      const response=command.action==='positions'?
        await (this.options.onPositions?.(command.page)??'【持仓查询】\n持仓查询暂不可用，请稍后重试。'):
        command.action==='close'?await (this.options.onClose?.(command.closeAction,command.ref)??
          '【平仓操作】\n平仓功能暂不可用，未提交平仓。'):
        command.action==='sell'?await (this.options.onSell?.(command.ref,command.pct)??
          '【平仓操作】\n平仓功能暂不可用，未提交平仓。'):
        command.action==='sell_custom'?'【卡片卖出】\n请在 5 分钟内发送 1%-100% 的整数卖出比例，例如 30%。':
          command.action==='token_buy'?await (this.options.onTokenBuy?.(command.buyAction,command.address,command.value)??
            '【卡片买入】\n卡片买入暂不可用，没有发送交易。'):
        command.action==='token_card'?await (this.options.onTokenCard?.(command.address,command.refresh)??
          '【代币详情】\n代币详情查询暂不可用，请稍后重试。'):
        await this.options.onAction(command.action);
      reply=typeof response==='string'?response:response?.text;
      if(typeof reply!=='string'||!reply.trim()||reply.length>4096)throw new ApiError('TELEGRAM_CONTROLS_REPLY_INVALID');
      try {buttons=typeof response==='string'?undefined:validateTelegramNotificationButtons(response.buttons);}
      catch {throw new ApiError('TELEGRAM_CONTROLS_REPLY_INVALID');}
      if(command.action==='sell_custom'&&this.options.onSell)
        this.db.prepare(`INSERT INTO telegram_control_pending_token_sell(scope,ref,created_at,expires_at) VALUES(?,?,?,?)
          ON CONFLICT(scope) DO UPDATE SET ref=excluded.ref,created_at=excluded.created_at,expires_at=excluded.expires_at`)
          .run(this.scope,command.ref,this.now(),this.now()+TOKEN_SELL_CUSTOM_TTL_MS);
      if(command.help){const description=help(this.options.countingMode??'simulation');
        if(reply.length+description.length+2<=4096)reply+='\n\n'+description;}
    }catch(error) {
      const code=error instanceof ApiError?error.code:'TELEGRAM_CONTROLS_ACTION_FAILED';
      this.memoryError=code;actionState='failed';
      buttons=undefined;
      reply=command.action==='positions'?'【持仓查询】\n暂时无法读取持仓，请稍后发送 /positions 重试。':
        command.action==='close'||command.action==='sell'||command.action==='sell_custom'?'【平仓操作】\n平仓操作或回复异常，结果待核对；不会自动重放。请查询持仓和订单状态。':
          command.action==='token_card'?'【代币详情】\n暂时无法读取代币详情，请稍后重新发送完整 CA。':
          command.action==='token_buy'?'【卡片买入】\n操作回复异常。系统不会自动重放买单，请查询持仓和订单状态。':
        '【计数控制】\n计数指令执行或回复异常；不会自动重放。请发送 /count_status 核对状态。';
      this.db.prepare('UPDATE telegram_control_state SET last_error=? WHERE scope=?').run(code,this.scope);
    }
    this.persistReply(id,actionState,reply,buttons);
  }
  private persistReply(id:number,state:string,reply:string,buttons?:TelegramNotificationButtons):void {
    this.db.prepare('UPDATE telegram_control_events SET state=?,reply=?,reply_buttons=? WHERE scope=? AND update_id=?')
      .run(state,reply,buttons?JSON.stringify(buttons):null,this.scope,id);
    this.db.prepare('UPDATE telegram_control_state SET last_action_at=? WHERE scope=?').run(this.now(),this.scope);
    this.flushReplies();
  }
  private acknowledge(command:Command&{callbackId:string}):void {
    const text=command.action==='positions'?'持仓查询已收到，请查看回复。':command.action==='close'||command.action==='sell'?
      '已收到平仓请求，请查看处理结果。':
      command.action==='sell_custom'?'请在 5 分钟内发送 1%-100% 的整数卖出比例。':
      command.action==='token_buy'?(command.buyAction==='custom_start'?'请输入自定义 SOL 买入金额。':
        command.buyAction==='cancel'?'已收到取消请求，请查看回复。':'买入请求已收到，请查看订单通知。'):
      command.action==='token_card'?'代币详情查询已收到，请查看回复。':'已收到指令，请查看回复。';
    this.answerCallback(command.callbackId,text);
  }
  private answerCallback(callbackId:string,text:string):void {
    const task=this.api('answerCallbackQuery',{callback_query_id:callbackId,text,cache_time:0}).then(()=>{},error=>{
      if(!this.stopping)this.memoryError=error instanceof ApiError?error.code:'TELEGRAM_CONTROLS_NETWORK_ERROR';
    });
    this.acknowledgements.add(task);void task.then(()=>this.acknowledgements.delete(task));
  }
  private command(update:Row):Command|AckOnly|undefined {
    if(update.edited_message||update.channel_post||update.edited_channel_post||update.business_message||update.edited_business_message)return;
    if(object(update.message)&&!update.callback_query) {
      const message=update.message;
      if(!this.privateMessage(message)||!this.user(message.from)||!positiveId(message.date)||
        message.date>Math.floor(this.now()/1000)||forward(message)||typeof message.text!=='string')return;
      const rawText=message.text,text=rawText.trim();
      if(text==='/start')return {action:'status',help:true};
      const explicitToken=text.match(/^\/(?:token|contract) ([1-9A-HJ-NP-Za-km-z]{32,44})$/)?.[1];
      if(explicitToken&&solanaAddress(explicitToken))return {action:'token_card',address:explicitToken,refresh:false};
      const sellPercentage=customSellPercentage(rawText);
      if(this.options.onSell&&sellPercentage&&this.fresh(message.date)) {
        this.db.prepare('DELETE FROM telegram_control_pending_token_sell WHERE scope=? AND expires_at<?')
          .run(this.scope,this.now());
        const pending=this.db.prepare(`SELECT ref FROM telegram_control_pending_token_sell
          WHERE scope=? AND expires_at>=?`).get(this.scope,this.now());
        if(typeof pending?.ref==='string'&&new RegExp(`^${TELEGRAM_SELL_REF}$`).test(pending.ref))
          return {action:'sell',pct:Number(sellPercentage),ref:pending.ref,custom:true};
      }
      // Do not normalize whitespace, signs or exponent notation. The stateful
      // handler owns the pending mint and rejects values when no custom prompt exists.
      if(this.options.onTokenBuy&&customSolAmount(rawText)&&this.fresh(message.date))
        return {action:'token_buy',buyAction:'custom_value',value:rawText};
      if(solanaAddress(text))return this.options.onTokenCard?{action:'token_card',address:text,refresh:false}:undefined;
      if(['持仓查询','持仓','💼 持仓查询','💼 持仓','📊 持仓查询','📊 持仓','/positions'].includes(text))return {action:'positions',page:1};
      const pageArgument=text.match(/^\/positions ([1-9]\d{0,4})$/)?.[1];
      const page=pageArgument===undefined?undefined:positionsPage(pageArgument);
      if(page!==undefined)return {action:'positions',page};
      const action=({'/count_start':'start','启动计数':'start','▶️ 启动计数':'start',
        '/count_stop':'stop','停止计数':'stop','⏹ 停止计数':'stop','⏹️ 停止计数':'stop',
        '/count_status':'status','计数状态':'status','状态':'status','📊 计数状态':'status','📊 状态':'status'} as Record<string,TelegramCountAction>)[text];
      if(action!=='status'&&!this.fresh(message.date))return;
      return ['start','stop','status'].includes(action)?{action}:undefined;
    }
    if(object(update.callback_query)&&!update.message) {
      const query=update.callback_query,message=query.message;
      if(!this.user(query.from)||!object(message)||!this.privateMessage(message)||!positiveId(message.date)||
        message.date>Math.floor(this.now()/1000)||forward(message)||
        !object(message.from)||message.from.is_bot!==true||String(message.from.id)!==this.botId||query.inline_message_id||
        typeof query.id!=='string'||!query.id||query.id.length>256||typeof query.data!=='string')return;
      const pageArgument=query.data.match(/^positions:([1-9]\d{0,4})$/)?.[1];
      const page=pageArgument===undefined?undefined:positionsPage(pageArgument);
      // Reading another holdings page remains safe after the original message ages.
      // Stateful counting controls retain their strict two-minute freshness window.
      if(page!==undefined)return {action:'positions',page,callbackId:query.id};
      if(query.data==='count:status')return {action:'status',callbackId:query.id};
      const tokenRefresh=query.data.match(/^token:refresh:([1-9A-HJ-NP-Za-km-z]{32,44})$/)?.[1];
      if(tokenRefresh&&solanaAddress(tokenRefresh))return {action:'token_card',address:tokenRefresh,refresh:true,callbackId:query.id};
      const tokenBuy=query.data.match(tokenBuyCallback);
      if(tokenBuy&&Object.hasOwn(TELEGRAM_TOKEN_BUY_PRESETS,tokenBuy[1])&&solanaAddress(tokenBuy[2]))
        return {action:'token_buy',buyAction:'preset',address:tokenBuy[2],
          value:tokenBuy[1] as TelegramTokenBuyPresetCode,callbackId:query.id};
      const legacyTokenBuy=query.data.match(legacyTokenBuyCallback)?.[1];
      if(legacyTokenBuy&&solanaAddress(legacyTokenBuy))return {action:'token_buy',buyAction:'preset',
        address:legacyTokenBuy,value:'legacy' satisfies TelegramTokenBuyCode,callbackId:query.id};
      const tokenCustom=query.data.match(tokenCustomCallback)?.[1];
      if(tokenCustom&&solanaAddress(tokenCustom))return {action:'token_buy',buyAction:'custom_start',
        address:tokenCustom,callbackId:query.id};
      const tokenCancel=query.data.match(tokenCancelCallback)?.[1];
      // Keep cancellation compatible with already-delivered custom-card prompts,
      // while removed native-buy confirmations can never reach a trade handler.
      if(tokenCancel)return {action:'token_buy',buyAction:'cancel',value:tokenCancel,callbackId:query.id};
      if(removedNativeBuyCallback.test(query.data))return {action:'ack_only',callbackId:query.id,
        text:'该测试买入入口已移除，请使用 CA 代币卡片买入。'};
      const sell=query.data.match(sellCallback);
      // Message creation time is not click time. The server-side single-use action
      // validates this sell; never revive expired actions or infer a token from a CA.
      if(sell)return {action:'sell',pct:Number(sell[1]) as TelegramSellPct,ref:sell[2],callbackId:query.id};
      const customSell=query.data.match(customSellCallback)?.[1];
      if(customSell)return {action:'sell_custom',ref:customSell,callbackId:query.id};
      const preview=query.data.match(/^close:preview:([0-9a-f]{32})$/);
      if(preview)return {action:'close',closeAction:'preview',ref:preview[1],callbackId:query.id};
      if(!this.fresh(message.date))return {action:'ack_only',callbackId:query.id,text:'按钮已过期，请刷新后重试。'};
      const close=query.data.match(closeConfirmedCallback);
      if(close)return {action:'close',closeAction:close[1] as 'confirm'|'cancel',ref:close[2],callbackId:query.id};
      const action=({'count:start':'start','count:stop':'stop','count:status':'status'} as Record<string,TelegramCountAction>)[query.data];
      return ['start','stop','status'].includes(action)?{action,callbackId:query.id}:undefined;
    }
  }
  private privateMessage(message:Row):boolean {
    return positiveId(message.message_id)&&object(message.chat)&&message.chat.type==='private'&&
      positiveId(message.chat.id)&&String(message.chat.id)===this.chatId;
  }
  private user(user:unknown):boolean {
    return object(user)&&user.is_bot===false&&positiveId(user.id)&&String(user.id)===this.chatId;
  }
  private fresh(date:unknown):boolean {
    if(!positiveId(date))return false;
    const age=Math.floor(this.now()/1000)-date;return age>=0&&age<=120;
  }
  private flushReplies():void {
    for(const row of this.db.prepare('SELECT update_id,reply,reply_buttons FROM telegram_control_events WHERE scope=? AND queued=0 AND reply IS NOT NULL ORDER BY update_id LIMIT 100').all(this.scope)) {
      try {
        const buttons=row.reply_buttons===null?undefined:validateTelegramNotificationButtons(JSON.parse(String(row.reply_buttons)));
        this.options.enqueue({key:`telegram:count:${this.scope}:${row.update_id}`,text:String(row.reply),...(buttons?{buttons}:{})});
      }
      catch{this.memoryError='TELEGRAM_CONTROLS_QUEUE_FAILED';return;}
      this.db.prepare('UPDATE telegram_control_events SET queued=1,reply=NULL,reply_buttons=NULL WHERE scope=? AND update_id=?').run(this.scope,row.update_id);
    }
    if(this.memoryError==='TELEGRAM_CONTROLS_QUEUE_FAILED')this.memoryError=undefined;
  }
  private async api(method:'getUpdates'|'answerCallbackQuery',body:Row):Promise<unknown> {
    const controller=new AbortController();this.controllers.add(controller);
    const timeout=setTimeout(()=>controller.abort(),method==='getUpdates'?30000:10000);
    try {
      const response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:controller.signal});
      const text=await response.text();if(Buffer.byteLength(text)>256*1024)throw new ApiError('TELEGRAM_CONTROLS_RESPONSE_INVALID');
      let parsed:unknown;try{parsed=JSON.parse(text);}catch{/* HTTP error classes remain available without JSON. */}
      const value=object(parsed)?parsed:undefined;
      if(controller.signal.aborted)throw new ApiError('TELEGRAM_CONTROLS_REQUEST_TIMEOUT');
      const code=response.ok&&value?.ok===false?Number(value.error_code):response.status;
      if(code===401)throw new ApiError('TELEGRAM_CONTROLS_AUTH_INVALID',60000,true);
      if(code===403)throw new ApiError('TELEGRAM_CONTROLS_FORBIDDEN',60000,true);
      if(code===409)throw new ApiError(typeof value?.description==='string'&&/webhook/i.test(value.description)?
        'TELEGRAM_CONTROLS_WEBHOOK_ACTIVE':'TELEGRAM_CONTROLS_POLL_CONFLICT',60000,true);
      if(code===429) {
        const seconds=object(value?.parameters)?Number(value.parameters.retry_after):NaN;
        throw new ApiError('TELEGRAM_CONTROLS_RATE_LIMITED',Number.isFinite(seconds)&&seconds>=0?Math.max(1000,Math.min(3600000,seconds*1000)):30000);
      }
      if(code>=500)throw new ApiError('TELEGRAM_CONTROLS_UNAVAILABLE',10000);
      if(code>=400)throw new ApiError('TELEGRAM_CONTROLS_REQUEST_REJECTED',60000,true);
      if(!response.ok||value?.ok!==true)throw new ApiError('TELEGRAM_CONTROLS_RESPONSE_INVALID');
      return value.result;
    }catch(error) {
      if(error instanceof ApiError)throw error;
      throw new ApiError(controller.signal.aborted?'TELEGRAM_CONTROLS_REQUEST_TIMEOUT':'TELEGRAM_CONTROLS_NETWORK_ERROR');
    }finally {clearTimeout(timeout);this.controllers.delete(controller);}
  }
}
function iso(value:unknown):string|undefined {return typeof value==='number'&&value>0?new Date(value).toISOString():undefined;}
