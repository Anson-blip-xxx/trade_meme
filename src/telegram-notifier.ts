import {createHash} from 'node:crypto';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {telegramIpv4Fetch} from './telegram-transport.js';
import {formatTelegramMessage,validateTelegramNotificationButtons,type TelegramNotificationButtons,type TelegramReplyMarkup} from './telegram-format.js';

export interface TelegramNotification {key:string;text:string;buttons?:TelegramNotificationButtons;}
export interface TelegramNotifierOptions {
  token:string;
  chatId:string;
  fetch?:typeof globalThis.fetch;
  now?:()=>number;
  /** Always clamped to at least one second, including manual flush calls. */
  intervalMs?:number;
  requestTimeoutMs?:number;
  retryBaseMs?:number;
  retryMaxMs?:number;
}
type DeliveryError='TELEGRAM_RATE_LIMITED'|'TELEGRAM_AUTH_INVALID'|'TELEGRAM_CHAT_FORBIDDEN'|
  'TELEGRAM_REQUEST_REJECTED'|'TELEGRAM_UNAVAILABLE'|'TELEGRAM_NETWORK_ERROR'|
  'TELEGRAM_REQUEST_TIMEOUT'|'TELEGRAM_RESPONSE_INVALID'|'TELEGRAM_STORAGE_ERROR';
interface PendingRow {id:number;key:string;text:string;buttons:string|null;attempts:number;next_at:number;}
interface Outcome {error?:DeliveryError;retryAt?:number;blocked?:boolean;permanent?:boolean;}

/**
 * A single-consumer durable outbox. A successfully acknowledged key is never sent again.
 * Telegram sendMessage has no idempotency key: a crash after Telegram accepts a request
 * but before SQLite records its acknowledgement can cause a duplicate after restart.
 * Network timeouts have the same ambiguity; delivery is at least once, not exactly once.
 * API contract: https://core.telegram.org/bots/api#sendmessage and #making-requests.
 * Credentials, destination, message bodies and upstream error descriptions are never
 * included in status or logs. Pending events are retained without an eviction limit.
 */
export class TelegramNotifier {
  private readonly db:DatabaseSync;
  private readonly token:string;
  private readonly chatId:string;
  private readonly configHash:string;
  private readonly request:typeof globalThis.fetch;
  private readonly now:()=>number;
  private readonly intervalMs:number;
  private readonly requestTimeoutMs:number;
  private readonly retryBaseMs:number;
  private readonly retryMaxMs:number;
  private timer?:ReturnType<typeof setTimeout>;
  private inFlight?:Promise<void>;
  private closing?:Promise<void>;
  private running=false;
  private closed=false;
  private memoryError?:DeliveryError;

  constructor(path:string,options:TelegramNotifierOptions) {
    this.token=options.token?.trim();this.chatId=options.chatId?.trim();
    if(!this.token||!this.chatId||/[\s/?#]/.test(this.token)||/[\r\n]/.test(this.chatId))throw new Error('TELEGRAM_CONFIG_INVALID');
    this.configHash=createHash('sha256').update(this.token+'\0'+this.chatId).digest('hex');
    this.request=options.fetch??telegramIpv4Fetch;this.now=options.now??Date.now;
    this.intervalMs=positive(options.intervalMs,1000,1000);
    this.requestTimeoutMs=positive(options.requestTimeoutMs,10000,1);
    this.retryBaseMs=positive(options.retryBaseMs,2000,1000);
    this.retryMaxMs=positive(options.retryMaxMs,300000,this.retryBaseMs);
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1500;
      CREATE TABLE IF NOT EXISTS telegram_outbox (
        id INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE,text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
        sent_at INTEGER,last_error TEXT,buttons TEXT);
      CREATE INDEX IF NOT EXISTS telegram_pending ON telegram_outbox(state,next_at,id);
      CREATE TABLE IF NOT EXISTS telegram_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(telegram_outbox)').all().some(row=>row.name==='buttons'))
      this.db.exec('ALTER TABLE telegram_outbox ADD COLUMN buttons TEXT');
    // A corrected bot token or destination explicitly unblocks the durable queue.
    const blocked=this.meta('blocked_config');
    if(blocked&&blocked!==this.configHash) {
      this.db.exec("DELETE FROM telegram_meta WHERE key IN ('blocked_config','last_error')");
    }
  }

  enqueue(notification:TelegramNotification):boolean {
    if(this.closed||this.closing)throw new Error('TELEGRAM_NOTIFIER_CLOSED');
    if(typeof notification.key!=='string'||!notification.key.trim()||notification.key.length>512)throw new Error('TELEGRAM_EVENT_KEY_INVALID');
    // UTF-16 length is conservative for astral characters and never splits a surrogate.
    // Reject instead of silently truncating trade amounts or protective order details.
    if(typeof notification.text!=='string'||!notification.text.trim()||notification.text.length>4096)throw new Error('TELEGRAM_MESSAGE_LENGTH_INVALID');
    const buttons=validateTelegramNotificationButtons(notification.buttons);
    const inserted=!!this.db.prepare('INSERT OR IGNORE INTO telegram_outbox(key,text,buttons,created_at) VALUES(?,?,?,?)')
      .run(notification.key,notification.text,buttons?JSON.stringify(buttons):null,this.now()).changes;
    if(inserted)this.schedule();return inserted;
  }

  start():void {if(this.closed||this.closing)return;this.running=true;this.schedule();}
  /** Stops scheduling new messages; an in-flight request is allowed to persist its result. */
  stop():void {this.running=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}

  /** Sends at most one due event; does not sleep or bypass rate limits. Safe to call concurrently. */
  flush():Promise<void> {
    if(this.closed||this.closing)return Promise.resolve();
    if(this.inFlight)return this.inFlight;
    const task=this.sendOne().catch(()=>{this.memoryError='TELEGRAM_STORAGE_ERROR';this.stop();});
    this.inFlight=task.finally(()=>{this.inFlight=undefined;this.schedule();});
    return this.inFlight;
  }

  status() {
    if(this.closed)return {enabled:true,running:false,closed:true,pending:0,sent:0,failed:0,blocked:false,lastError:this.memoryError,lastSuccessAt:undefined as string|undefined};
    const counts=this.db.prepare("SELECT state,count(*) AS n FROM telegram_outbox GROUP BY state").all();
    const count=(state:string)=>Number(counts.find(row=>row.state===state)?.n??0);
    const lastSuccess=Number(this.meta('last_success_at'));
    return {enabled:true,running:this.running,closed:false,pending:count('pending'),sent:count('sent'),failed:count('failed'),
      blocked:this.meta('blocked_config')===this.configHash,
      lastError:this.memoryError??safeError(this.meta('last_error')),
      lastSuccessAt:lastSuccess>0?new Date(lastSuccess).toISOString():undefined};
  }

  /** Await on graceful shutdown so acknowledgement never races database closure. */
  close():Promise<void> {
    if(this.closing)return this.closing;if(this.closed)return Promise.resolve();this.stop();
    this.closing=(async()=>{await this.inFlight;this.db.close();this.closed=true;})();return this.closing;
  }

  private meta(key:string):string|undefined {return this.db.prepare('SELECT value FROM telegram_meta WHERE key=?').get(key)?.value as string|undefined;}
  private setMeta(key:string,value:string):void {this.db.prepare('INSERT OR REPLACE INTO telegram_meta VALUES(?,?)').run(key,value);}
  private schedule():void {
    if(!this.running||this.closed||this.closing||this.inFlight)return;
    if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    if(this.meta('blocked_config')===this.configHash)return;
    const row=this.db.prepare("SELECT MIN(next_at) AS next_at FROM telegram_outbox WHERE state='pending'").get();
    if(row?.next_at===null||row?.next_at===undefined)return;
    const next=Math.max(Number(row.next_at),Number(this.meta('next_attempt_at')??0));
    this.timer=setTimeout(()=>{this.timer=undefined;void this.flush();},Math.min(2147483647,Math.max(0,next-this.now())));
    this.timer.unref();
  }

  private async sendOne():Promise<void> {
    if(this.meta('blocked_config')===this.configHash)return;
    const now=this.now();
    if(now<Number(this.meta('next_attempt_at')??0))return;
    const row=this.db.prepare("SELECT id,key,text,buttons,attempts,next_at FROM telegram_outbox WHERE state='pending' AND next_at<=? ORDER BY id LIMIT 1").get(now) as unknown as PendingRow|undefined;
    if(!row)return;
    // Persist a reservation before I/O. Restarting cannot burst through the send interval.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.setMeta('next_attempt_at',String(now+this.intervalMs));
      this.db.prepare('UPDATE telegram_outbox SET attempts=attempts+1,next_at=? WHERE id=?').run(now+this.intervalMs,row.id);
      this.db.exec('COMMIT');
    }catch {this.db.exec('ROLLBACK');throw new Error('TELEGRAM_STORAGE_ERROR');}
    const outcome=await this.deliver(row);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(!outcome.error) {
        const at=this.now();
        this.db.prepare("UPDATE telegram_outbox SET state='sent',text='',buttons=NULL,sent_at=?,last_error=NULL WHERE id=?").run(at,row.id);
        this.setMeta('last_success_at',String(at));this.db.exec("DELETE FROM telegram_meta WHERE key='last_error'");this.memoryError=undefined;
      } else {
        this.setMeta('last_error',outcome.error);
        this.db.prepare('UPDATE telegram_outbox SET state=?,next_at=?,last_error=? WHERE id=?')
          .run(outcome.permanent?'failed':'pending',outcome.retryAt??this.now()+this.intervalMs,outcome.error,row.id);
        if(outcome.blocked)this.setMeta('blocked_config',this.configHash);
        // Provider outages/rate limits must not turn a large backlog into one failed
        // request each second. Persist a global cooldown as well as the event retry.
        if(outcome.retryAt!==undefined)this.setMeta('next_attempt_at',String(outcome.retryAt));
      }
      this.db.exec('COMMIT');
    }catch {this.db.exec('ROLLBACK');throw new Error('TELEGRAM_STORAGE_ERROR');}
  }

  private async deliver(row:PendingRow):Promise<Outcome> {
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),this.requestTimeoutMs);
    let response:Response|undefined;
    try {
      let content:{text:string;link_preview_options:{is_disabled:true};parse_mode?:'HTML';reply_markup?:TelegramReplyMarkup};
      try {content=formatTelegramMessage(row.text);}catch {
        // A presentation failure must not prevent delivery of the original facts.
        content={text:row.text,link_preview_options:{is_disabled:true}};
      }
      if(row.buttons!==null) {
        try {
          const buttons=validateTelegramNotificationButtons(JSON.parse(row.buttons));
          if(!buttons)return {error:'TELEGRAM_REQUEST_REJECTED',permanent:true};
          content.reply_markup={inline_keyboard:buttons};
        }catch {return {error:'TELEGRAM_REQUEST_REJECTED',permanent:true};}
      }
      response=await this.request(`https://api.telegram.org/bot${this.token}/sendMessage`,{
        method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:controller.signal,
        body:JSON.stringify({chat_id:this.chatId,...content}),
      });
      let body:{ok?:boolean;error_code?:number;parameters?:{retry_after?:number}}|undefined;
      try {body=await response.json() as typeof body;}catch {/* Never store raw response bodies. */}
      if(controller.signal.aborted)return {error:'TELEGRAM_REQUEST_TIMEOUT',retryAt:this.now()+this.backoff(row.attempts)};
      const code=response.status===200&&body?.ok===false?body.error_code:response.status;
      if(response.ok&&body?.ok===true)return {};
      if(code===401)return {error:'TELEGRAM_AUTH_INVALID',blocked:true};
      if(code===403)return {error:'TELEGRAM_CHAT_FORBIDDEN',blocked:true};
      if(code===429) {
        const seconds=body?.parameters?.retry_after,header=response.headers.get('retry-after');
        const delay=typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0?seconds*1000:
          header&&Number.isFinite(Number(header))&&Number(header)>=0?Number(header)*1000:
          header&&Number.isFinite(Date.parse(header))?Math.max(0,Date.parse(header)-this.now()):undefined;
        return {error:'TELEGRAM_RATE_LIMITED',retryAt:this.now()+Math.max(this.intervalMs,delay??this.backoff(row.attempts))};
      }
      if(code&&code>=500)return {error:'TELEGRAM_UNAVAILABLE',retryAt:this.now()+this.backoff(row.attempts)};
      if(code&&code>=400&&code<500)return {error:'TELEGRAM_REQUEST_REJECTED',permanent:true};
      return {error:'TELEGRAM_RESPONSE_INVALID',retryAt:this.now()+this.backoff(row.attempts)};
    } catch {
      return {error:controller.signal.aborted?'TELEGRAM_REQUEST_TIMEOUT':'TELEGRAM_NETWORK_ERROR',retryAt:this.now()+this.backoff(row.attempts)};
    } finally {clearTimeout(timeout);}
  }
  private backoff(previousAttempts:number):number {return Math.min(this.retryMaxMs,this.retryBaseMs*2**Math.min(20,previousAttempts));}
}

function positive(value:number|undefined,fallback:number,minimum:number):number {
  if(value!==undefined&&(!Number.isFinite(value)||value<0))throw new Error('TELEGRAM_INTERVAL_INVALID');
  return Math.max(minimum,Math.floor(value??fallback));
}
function safeError(value:string|undefined):DeliveryError|undefined {
  return value&&['TELEGRAM_RATE_LIMITED','TELEGRAM_AUTH_INVALID','TELEGRAM_CHAT_FORBIDDEN','TELEGRAM_REQUEST_REJECTED',
    'TELEGRAM_UNAVAILABLE','TELEGRAM_NETWORK_ERROR','TELEGRAM_REQUEST_TIMEOUT','TELEGRAM_RESPONSE_INVALID','TELEGRAM_STORAGE_ERROR'].includes(value)?value as DeliveryError:undefined;
}
