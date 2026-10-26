import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync,openSync,closeSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import bs58 from 'bs58';
import type {Chain} from './types.js';
import type {NativePositionState} from './native-solana/positions.js';

export interface PositionPriceHealthPosition {
  id:string;chain:Chain;address:string;name?:string;
  /** Diagnostic timestamp from a matched current-price WS frame. */
  streamObservedAt?:string;
  /** A verified, currently usable quote. Its source and original timestamps are preserved. */
  price?:{observedAt:string;validUntil:string;source:string};
  subscriptionSent:boolean;
}
export interface PositionPriceHealthOptions {
  enqueue:(event:{key:string;text:string})=>boolean;
  now?:()=>number;
  graceMs?:number;disconnectAfterMs?:number;subscriptionAfterMs?:number;staleAfterMs?:number;
}
type Reason='price_stale';
interface Incident {id:string;reason:Reason;alertedAt:number;priceAt?:number;streamAt?:number;}
interface Tracked {
  id:string;chain:Chain;address:string;name?:string;firstSeenAt:number;lastSeenAt:number;
  connected:boolean;subscriptionSent:boolean;disconnectedAt?:number;unsubscribedAt?:number;
  streamAt?:number;priceAt?:number;priceValidUntil?:number;priceSource?:string;missingSince?:number;incident?:Incident;
}
const names:Record<Chain,string>={solana:'SOL',bsc:'BSC',robinhood:'Robinhood'};
const clean=(value:string)=>value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,100);
const iso=(value:number|undefined)=>value===undefined?undefined:new Date(value).toISOString();
const clock=(value:number)=>Number.isSafeInteger(value)&&value>=0&&value<=8.64e15;
/** The Solana position's own executable sell quote takes priority over display prices. */
export function nativePositionHealthQuote(position:NativePositionState|undefined,mint:string,now:number,expectedWallet?:string):
  PositionPriceHealthPosition['price']|undefined {
  const balance=position?.balance,quote=position?.quote;
  if(position?.state!=='active'||!balance||!quote||quote.source!=='solana_account_stream'||
    position.lastError||balance.provisionalZero||expectedWallet!==undefined&&position.buy.wallet!==expectedWallet||
    position.buy.mint!==mint||balance.mint!==mint||quote.mint!==mint||
    position.buy.wallet!==balance.wallet||position.buy.wallet!==quote.wallet||
    !/^[1-9]\d{0,19}$/.test(balance.amount)||balance.amount!==quote.inputAmount||
    !/^[1-9]\d{0,19}$/.test(quote.outputAmount)||!/^(?:0|[1-9]\d{0,19})$/.test(quote.minimumOutputAmount)||
    BigInt(quote.minimumOutputAmount)>BigInt(quote.outputAmount))return;
  const observedAt=Date.parse(quote.quotedAt),validUntil=Date.parse(quote.expiresAt);
  if(!clock(now)||!clock(observedAt)||!clock(validUntil)||observedAt>now||validUntil<=now||
    validUntil-observedAt>10_000)return;
  return {observedAt:quote.quotedAt,validUntil:quote.expiresAt,source:'native_sol_sell_quote'};
}
function duration(value:number|undefined,fallback:number):number {
  if(value!==undefined&&(!Number.isSafeInteger(value)||value<1||value>86400000))throw Error('POSITION_PRICE_HEALTH_CONFIG_INVALID');
  return value??fallback;
}
function normalize(position:PositionPriceHealthPosition):PositionPriceHealthPosition {
  if(!position||typeof position!=='object'||typeof position.id!=='string'||!position.id||position.id.length>512||
    /[\x00-\x1f\x7f]/.test(position.id)||!Object.hasOwn(names,position.chain)||typeof position.address!=='string'||
    typeof position.subscriptionSent!=='boolean'||position.name!==undefined&&typeof position.name!=='string'||
    position.streamObservedAt!==undefined&&typeof position.streamObservedAt!=='string'||
    position.price!==undefined&&(!position.price||typeof position.price!=='object'||Array.isArray(position.price)||
      typeof position.price.observedAt!=='string'||typeof position.price.validUntil!=='string'||
      typeof position.price.source!=='string'||!/^[a-z][a-z0-9_]{1,79}$/.test(position.price.source)))
    throw Error('POSITION_PRICE_HEALTH_INPUT_INVALID');
  let address=position.address;
  if(position.chain==='solana'){
    try{if(bs58.decode(address).length!==32||bs58.encode(bs58.decode(address))!==address)throw Error();}
    catch{throw Error('POSITION_PRICE_HEALTH_INPUT_INVALID');}
  }else{
    if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw Error('POSITION_PRICE_HEALTH_INPUT_INVALID');
    address=address.toLowerCase();
  }
  return {...position,address,...(position.name!==undefined?{name:clean(position.name)}:{})};
}

/**
 * Durable observation of already-open holdings. The caller supplies only live
 * positions and timestamped quotes from independent sources. It does not fetch
 * prices; the caller keeps its bounded fallback running.
 * This component cannot fetch a price, subscribe a socket, or place an order.
 */
export class PositionPriceHealth {
  private readonly db:DatabaseSync;private readonly now:()=>number;
  private readonly grace:number;private readonly disconnectAfter:number;private readonly subscriptionAfter:number;private readonly staleAfter:number;
  private closed=false;private lastError?:string;
  constructor(path:string,private readonly options:PositionPriceHealthOptions){
    if(!path||path.startsWith('file:')||typeof options.enqueue!=='function')throw Error('POSITION_PRICE_HEALTH_CONFIG_INVALID');
    this.now=options.now??Date.now;this.grace=duration(options.graceMs,30000);
    this.disconnectAfter=duration(options.disconnectAfterMs,20000);this.subscriptionAfter=duration(options.subscriptionAfterMs,20000);
    this.staleAfter=duration(options.staleAfterMs,45000);
    if(path!==':memory:'){
      mkdirSync(dirname(path),{recursive:true,mode:0o700});const fd=openSync(path,'a',0o600);closeSync(fd);chmodSync(path,0o600);
    }
    this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS position_price_health_positions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS position_price_health_events(
        key TEXT PRIMARY KEY,position_id TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS position_price_health_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  private assertOpen(){if(this.closed)throw Error('POSITION_PRICE_HEALTH_CLOSED');}
  private rows():Tracked[]{return this.db.prepare('SELECT payload FROM position_price_health_positions ORDER BY id').all()
    .map(row=>JSON.parse(String(row.payload)) as Tracked);}
  private fresh(row:Tracked,at:number):boolean {
    return row.priceAt!==undefined&&row.priceAt<=at&&row.priceValidUntil!==undefined&&row.priceValidUntil>at;
  }
  private reason(row:Tracked,at:number):Reason|undefined {
    if(at-row.firstSeenAt<this.grace)return;
    if(!this.fresh(row,at)&&row.missingSince!==undefined&&at-row.missingSince>=this.staleAfter)return 'price_stale';
  }
  private event(row:Tracked,incident:Incident,recovered:boolean,at:number){
    const text=`【持仓报价监控】${clean(row.name||row.address.slice(0,8))} · ${names[row.chain]}\n`+
      (recovered?`✅ 持仓报价已恢复。来源：${row.priceSource}。`:
        `⚠️ 超过 ${Math.floor(this.staleAfter/1000)} 秒没有有效持仓报价，正在检查备用来源。`)+
      (row.priceAt!==undefined?`\n最近有效报价：${iso(row.priceAt)}`:'')+`\nCA：${row.address}`;
    this.db.prepare('INSERT OR IGNORE INTO position_price_health_events VALUES(?,?,?,\'pending\',?)')
      .run(`position-price-health:${incident.id}:${recovered?'recovered':'delayed'}`,row.id,text,at);
  }
  tick(input:{positions:PositionPriceHealthPosition[];connected:boolean}):void {
    this.assertOpen();
    if(!input||!Array.isArray(input.positions)||input.positions.length>2000||typeof input.connected!=='boolean')throw Error('POSITION_PRICE_HEALTH_INPUT_INVALID');
    const positions=input.positions.map(normalize),ids=new Set(positions.map(p=>p.id)),at=this.now();
    if(ids.size!==positions.length||!clock(at))throw Error('POSITION_PRICE_HEALTH_INPUT_INVALID');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previousTick=this.db.prepare("SELECT value FROM position_price_health_meta WHERE key='last_tick_at'").get();
      // A regressed local clock cannot reset outage timers or create false recovery.
      if(previousTick&&at<Number(previousTick.value))throw Error('POSITION_PRICE_HEALTH_CLOCK_REGRESSED');
      const previous=new Map(this.rows().map(p=>[p.id,p]));
      for(const old of previous.values())if(!ids.has(old.id)){
        this.db.prepare('DELETE FROM position_price_health_positions WHERE id=?').run(old.id);
        this.db.prepare("UPDATE position_price_health_events SET state='superseded' WHERE position_id=? AND state='pending'").run(old.id);
      }
      for(const position of positions){
        const saved=previous.get(position.id),same=saved?.chain===position.chain&&saved.address===position.address;
        const row:Tracked=same?saved!:{id:position.id,chain:position.chain,address:position.address,firstSeenAt:at,lastSeenAt:at,
          connected:input.connected,subscriptionSent:position.subscriptionSent};
        if(saved&&!same)this.db.prepare("UPDATE position_price_health_events SET state='superseded' WHERE position_id=? AND state='pending'").run(position.id);
        row.name=position.name??row.name;row.lastSeenAt=at;row.connected=input.connected;row.subscriptionSent=position.subscriptionSent;
        if(!input.connected)row.disconnectedAt??=at;else delete row.disconnectedAt;
        if(!position.subscriptionSent)row.unsubscribedAt??=at;else delete row.unsubscribedAt;
        const streamAt=position.streamObservedAt===undefined?NaN:Date.parse(position.streamObservedAt);
        if(clock(streamAt)&&streamAt<=at+1000&&(row.streamAt===undefined||streamAt>row.streamAt))row.streamAt=streamAt;
        const priceAt=position.price===undefined?NaN:Date.parse(position.price.observedAt),
          validUntil=position.price===undefined?NaN:Date.parse(position.price.validUntil);
        // Never roll an old HTTP response forward to the time of this check.
        // Native quotes expire after one second; router observations carry their own validity.
        const valid=clock(priceAt)&&clock(validUntil)&&priceAt<=at&&validUntil>at&&validUntil>priceAt&&
          validUntil-priceAt<=60_000;
        if(valid){row.priceAt=priceAt;row.priceValidUntil=validUntil;row.priceSource=position.price!.source;delete row.missingSince;}
        else {delete row.priceValidUntil;delete row.priceSource;row.missingSince??=at;}
        if(row.incident){
          // Recovery needs a new valid quote, not a reconnect or recycled observation.
          if(this.fresh(row,at)&&row.priceAt!>(row.incident.priceAt??row.incident.streamAt??-1)){
            this.db.prepare("UPDATE position_price_health_events SET state='superseded' WHERE key=? AND state='pending'")
              .run(`position-price-health:${row.incident.id}:delayed`);
            this.event(row,row.incident,true,at);delete row.incident;
          }
        }else{
          const reason=this.reason(row,at);
          if(reason){row.incident={id:randomUUID(),reason,alertedAt:at,...(row.priceAt!==undefined?{priceAt:row.priceAt}:{})};
            this.event(row,row.incident,false,at);}
        }
        this.db.prepare('INSERT INTO position_price_health_positions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
          .run(row.id,JSON.stringify(row));
      }
      this.db.prepare("INSERT INTO position_price_health_meta VALUES('last_tick_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(at));
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.flush();
  }
  private flush(){
    for(const row of this.db.prepare("SELECT key,text FROM position_price_health_events WHERE state='pending' ORDER BY rowid LIMIT 100").all())try{
      // A false result means this durable key was already accepted by the outbox.
      this.options.enqueue({key:String(row.key),text:String(row.text)});
      this.db.prepare("UPDATE position_price_health_events SET state='queued' WHERE key=? AND state='pending'").run(row.key);
    }catch{this.lastError='POSITION_PRICE_HEALTH_QUEUE_FAILED';return;}
    this.lastError=undefined;
  }
  status(){
    this.assertOpen();const at=this.now(),rows=this.rows();
    const tick=this.db.prepare("SELECT value FROM position_price_health_meta WHERE key='last_tick_at'").get();
    return {monitored:rows.length,degraded:rows.filter(row=>row.incident).length,lastTickAt:tick?iso(Number(tick.value)):undefined,
      pending:Number(this.db.prepare("SELECT count(*) n FROM position_price_health_events WHERE state='pending'").get()?.n??0),
      lastError:this.lastError,thresholds:{graceMs:this.grace,disconnectAfterMs:this.disconnectAfter,subscriptionAfterMs:this.subscriptionAfter,staleAfterMs:this.staleAfter},
      positions:rows.map(row=>({id:row.id,chain:row.chain,address:row.address,name:row.name,
        state:row.incident?'degraded':at-row.firstSeenAt<this.grace?'warming_up':this.fresh(row,at)?'healthy':'awaiting_price',
        reason:row.incident?.reason,firstSeenAt:iso(row.firstSeenAt),lastStreamAt:iso(row.streamAt),
        lastPriceAt:iso(row.priceAt),priceSource:this.fresh(row,at)?row.priceSource:undefined}))};
  }
  close(){if(!this.closed){this.db.close();this.closed=true;}}
}
