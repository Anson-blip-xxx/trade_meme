import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import type {HeldPositionSeed} from './held-position-source.js';
import type {SolanaSnapshot} from './controlled-test/types.js';
import {validatedHeldFill,heldProtection} from './held-position-evidence.js';
import type {ScanPrice,ScanToken} from './scan-archive.js';
import {priceEvidence} from './price-evidence.js';
import {PRICE_GAIN_MILESTONES,crossedPriceMilestones,crossedMilestoneLabel} from './price-milestones.js';

interface Point {usd:number;at:string;source:string;}
interface State {
  seed:HeldPositionSeed;registeredAt:number;fill?:NonNullable<ReturnType<typeof validatedHeldFill>>;
  balance?:SolanaSnapshot;protection?:ReturnType<typeof heldProtection>;latest?:Point;peak?:Point;
  milestones:number[];balanceAttempt?:number;protectionAttempt?:number;fillAttempt?:number;
  retiredAt?:string;
  errors:Record<string,string>;alerts:Record<string,number>;episodes:Record<string,number>;
}
export interface HeldPositionMonitorOptions {
  seeds:()=>HeldPositionSeed[];
  query:(seed:HeldPositionSeed)=>Promise<unknown>;
  strategies:(seed:HeldPositionSeed)=>Promise<unknown>;
  balance:(seed:HeldPositionSeed)=>Promise<SolanaSnapshot>;
  enqueue:(event:{key:string;text:string})=>boolean;
  now?:()=>number;
}
const SOURCES=new Set(['dexscreener_token_pairs_sample','gmgn_token_info_sample','ave_price_stream_sample',
  'debot_price_stream_sample','debot_token_info_sample','chain_pool_sample']);
const pct=(n:number)=>`${n>=0?'+':''}${n.toFixed(2)}%`;
const clean=(s:string)=>s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,160);
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,24);
const retired=(s:State)=>s.retiredAt!==undefined||s.balance?.tokenAmount==='0';
const display=(s:State)=>s.seed.name||s.seed.symbol||
  (s.seed.tokenAddress==='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'?'BONK':s.seed.tokenAddress.slice(0,8));
const quantity=(s:State)=>Number(s.balance?.tokenAmount??s.seed.outputAmount)/10**s.seed.tokenDecimals;
const money=(n:number)=>n.toLocaleString('en-US',{useGrouping:false,maximumSignificantDigits:9});
const units=(s:State)=>quantity(s).toLocaleString('en-US',{maximumFractionDigits:Math.min(20,s.seed.tokenDecimals)});

/** Observes already confirmed buys. It has no order submission/cancellation dependency. */
export class HeldPositionMonitor {
  private readonly db:DatabaseSync;
  private readonly now:()=>number;
  private states=new Map<string,State>();
  private timer?:ReturnType<typeof setInterval>;
  private inFlight?:Promise<void>;
  private running=false;
  private isClosed=false;
  private lastError?:string;
  constructor(path:string,private readonly options:HeldPositionMonitorOptions) {
    this.now=options.now??Date.now;
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=1500;
      CREATE TABLE IF NOT EXISTS held_positions(id TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS held_events(key TEXT PRIMARY KEY,text TEXT NOT NULL,queued INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS held_pending ON held_events(queued,created_at);`);
    for(const row of this.db.prepare('SELECT id,state FROM held_positions').all())
      this.states.set(String(row.id),JSON.parse(String(row.state)) as State);
    this.refreshSeeds();
  }
  private refreshSeeds():void {
    try {
      const seeds=this.options.seeds();
      const valid=new Set(seeds.map(s=>s.id));
      // Reconfiguration cannot keep observing/notifying for a previous wallet.
      for(const [id,state] of this.states)if(!valid.has(id)&&!retired(state))this.states.delete(id);
      for(const seed of seeds) {
        if(this.states.has(seed.id))continue;
        const state:State={seed,registeredAt:this.now(),milestones:[],errors:{},alerts:{},episodes:{}};
        this.states.set(seed.id,state);this.save(state);
      }
      this.lastError=undefined;
    }catch {this.lastError='HELD_SEEDS_UNAVAILABLE';}
  }
  private save(state:State):void {
    this.db.prepare('INSERT INTO held_positions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state')
      .run(state.seed.id,JSON.stringify(state));
  }
  private event(state:State,suffix:string,text:string):void {
    this.db.prepare('INSERT OR IGNORE INTO held_events VALUES (?,?,0,?)').run(`held:${state.seed.id}:${suffix}`,
      `【实盘持仓监控】${clean(display(state))} · Solana\n\n${text}\n\nCA：${state.seed.tokenAddress}\nhttps://gmgn.ai/sol/token/${state.seed.tokenAddress}`,this.now());
  }
  private flush():void {
    for(const row of this.db.prepare('SELECT key,text FROM held_events WHERE queued=0 ORDER BY created_at,rowid LIMIT 100').all()) {
      try {
        this.options.enqueue({key:String(row.key),text:String(row.text)});
        this.db.prepare('UPDATE held_events SET queued=1 WHERE key=?').run(row.key);
      }catch {this.lastError='HELD_TELEGRAM_QUEUE_UNAVAILABLE';break;}
    }
  }
  tokens():ScanToken[] {
    return [...new Map([...this.states.values()].filter(s=>!retired(s))
      .map(s=>[s.seed.tokenAddress,{chain:s.seed.chain,address:s.seed.tokenAddress}])).values()];
  }
  private priceText(s:State):string {
    if(!s.fill||!s.latest)return '成交基准或最新价格仍在查询。';
    const peak=s.peak?.usd??s.latest.usd;
    return `相对买入价：${pct((s.latest.usd/s.fill.priceUsd-1)*100)}\n`+
      `监控以来采样峰值：${pct((peak/s.fill.priceUsd-1)*100)}\n距峰值回撤：${((1-s.latest.usd/peak)*100).toFixed(2)}%\n\n`+
      `买入美元价：$${money(s.fill.priceUsd)}\n最新价格：$${money(s.latest.usd)}\n剩余数量：${units(s)}\n`+
      `报价时间：${new Date(s.latest.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）\n\n`+
      '口径：美元价格涨跌，未扣费用，不等于 SOL 净收益。';
  }
  observePrice(price:ScanPrice):boolean {
    if(this.isClosed)return false;
    const t=Date.parse(price.observedAt),now=this.now();
    const extra=price as ScanPrice&{conflict?:boolean;status?:string};
    if(!SOURCES.has(price.source)||!Number.isFinite(price.priceUsd)||price.priceUsd<=0||!Number.isFinite(t)||
      t>now||now-t>90_000||extra.conflict||extra.status==='conflict'||price.source==='chain_pool_sample'&&!priceEvidence(price))return false;
    let accepted=false;
    for(const s of this.states.values()) {
      if(retired(s)||s.seed.chain!==price.chain||s.seed.tokenAddress!==price.address||t<Date.parse(s.seed.confirmedAt)||
        s.latest&&t<=Date.parse(s.latest.at))continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const point={usd:price.priceUsd,at:price.observedAt,source:price.source};s.latest=point;
        if(!s.peak||point.usd>s.peak.usd)s.peak=point;
        delete s.errors.price;
        if(s.fill) {
          const gain=(price.priceUsd/s.fill.priceUsd-1)*100;
          const crossed=crossedPriceMilestones(gain,s.milestones);
          if(crossed.length) {
            s.milestones.push(...crossed);
            const key=crossed.join(',');
            this.event(s,`milestone:${key.length<=160?key:digest(crossed)}`,`价格越过 ${crossedMilestoneLabel(crossed)}\n\n${this.priceText(s)}`);
          }
        }
        if(now-t<=60_000)this.recover(s,'price','持仓报价已恢复。');
        this.save(s);this.db.exec('COMMIT');accepted=true;
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    this.flush();return accepted;
  }
  recordPriceError(token:ScanToken,_reason:string):void {
    if(this.isClosed)return;
    for(const s of this.states.values())if(!retired(s)&&s.seed.chain===token.chain&&s.seed.tokenAddress===token.address) {
      s.errors.price='HELD_PRICE_UNAVAILABLE';this.checkAlerts(s);this.save(s);
    }
    this.flush();
  }
  private alert(s:State,key:string,_message:string):void {
    if(s.alerts[key])return;
    const episode=(s.episodes[key]??0)+1;s.episodes[key]=episode;s.alerts[key]=episode;
  }
  private recover(s:State,key:string,_message:string):void {
    if(!s.alerts[key])return;
    delete s.alerts[key];
  }
  private checkAlerts(s:State):void {
    if(retired(s))return;
    const now=this.now();
    if(now-(s.latest?Date.parse(s.latest.at):s.registeredAt)>60_000)
      this.alert(s,'price','持仓报价超过 60 秒未更新，正在从备用来源继续查询。旧价格不作为当前行情。');
    if(now-(s.balance?Date.parse(s.balance.checkedAt):s.registeredAt)>90_000)
      this.alert(s,'balance','持仓余额超过 90 秒未能核验，正在重试；未将其当作已平仓。');
    if(now-(s.protection?Date.parse(s.protection.checkedAt):s.registeredAt)>120_000)
      this.alert(s,'protection','止盈止损状态超过 120 秒未能更新，正在重试；价格监控继续运行。');
  }
  private async checkBalance(s:State):Promise<void> {
    s.balanceAttempt=this.now();
    try {
      const b=await this.options.balance(s.seed),at=Date.parse(b.checkedAt);
      if(b.wallet!==s.seed.wallet||b.mint!==s.seed.tokenAddress||b.decimals!==s.seed.tokenDecimals||
        !/^\d{1,20}$/.test(b.tokenAmount)||!Number.isSafeInteger(b.slot)||b.slot<s.seed.buySlot||
        s.balance&&b.slot<s.balance.slot||!Number.isFinite(at)||at>this.now()||this.now()-at>60_000)
        throw new Error('HELD_BALANCE_INVALID');
      s.balance=b;if(b.tokenAmount==='0')s.retiredAt=b.checkedAt;
      delete s.errors.balance;this.recover(s,'balance','链上持仓余额核验已恢复。');
    }catch {s.errors.balance='HELD_BALANCE_UNAVAILABLE';}
    this.save(s);
  }
  private async checkFill(s:State):Promise<void> {
    s.fillAttempt=this.now();
    try {
      const fill=validatedHeldFill(s.seed,await this.options.query(s.seed));
      if(!fill)throw new Error('HELD_FILL_UNVERIFIED');
      s.fill=fill;delete s.errors.fill;
    }catch {s.errors.fill='HELD_FILL_UNVERIFIED';}
    this.save(s);
  }
  private async checkProtection(s:State):Promise<void> {
    s.protectionAttempt=this.now();
    try {
      const raw=await this.options.strategies(s.seed);
      const p=heldProtection({...s.seed,entryPriceUsd:s.fill?.priceUsd},raw,new Date(this.now()));
      s.protection=p;delete s.errors.protection;
      this.recover(s,'protection','已重新取得 GMGN 保护状态。');
    }catch {s.errors.protection='HELD_PROTECTION_UNAVAILABLE';}
    this.save(s);
  }
  runOnce():Promise<void> {
    if(this.isClosed)return Promise.resolve();
    if(this.inFlight)return this.inFlight;
    const work=this.cycle();this.inFlight=work;
    void work.finally(()=>{if(this.inFlight===work)this.inFlight=undefined;}).catch(()=>{});return work;
  }
  private async cycle():Promise<void> {
    this.refreshSeeds();
    await Promise.all([...this.states.values()].filter(s=>!retired(s)).slice(0,20).map(async s=>{
      const now=this.now();
      const tasks:Promise<void>[]=[];
      if(s.balanceAttempt===undefined||now-s.balanceAttempt>=30_000)tasks.push(this.checkBalance(s));
      if(!s.fill&&(s.fillAttempt===undefined||now-s.fillAttempt>=30_000))tasks.push(this.checkFill(s));
      if(s.protectionAttempt===undefined||now-s.protectionAttempt>=60_000)tasks.push(this.checkProtection(s));
      await Promise.all(tasks);
      this.checkAlerts(s);this.save(s);
    }));
    this.flush();
  }
  start():void {
    if(this.running||this.isClosed)return;this.running=true;
    void this.runOnce().catch(()=>{this.lastError='HELD_OBSERVER_CYCLE_FAILED';});
    this.timer=setInterval(()=>{void this.runOnce().catch(()=>{this.lastError='HELD_OBSERVER_CYCLE_FAILED';});},5000);this.timer.unref();
  }
  async stop():Promise<void> {
    this.running=false;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.inFlight?.catch(()=>{});
  }
  close():void {if(this.isClosed)return;this.isClosed=true;if(this.timer)clearInterval(this.timer);this.db.close();}
  status() {
    const now=this.now();
    return {enabled:true,mode:'observation_only',running:this.running,inFlight:!!this.inFlight,lastError:this.lastError,
      activePositions:[...this.states.values()].filter(s=>!retired(s)).length,
      milestones:[...PRICE_GAIN_MILESTONES],milestoneContinuation:{basis:'price_multiple',fromMultiple:21,stepMultiple:1},
      priceAlertAfterMs:60_000,balanceIntervalMs:30_000,protectionIntervalMs:60_000,
      pendingEvents:Number(this.db.prepare('SELECT count(*) AS n FROM held_events WHERE queued=0').get()?.n??0),
      positions:[...this.states.values()].map(s=>({id:s.seed.id,name:display(s),chain:s.seed.chain,address:s.seed.tokenAddress,wallet:s.seed.wallet,
        status:retired(s)?'balance_zero':'monitoring',terminal:retired(s),retiredAt:s.retiredAt??(s.balance?.tokenAmount==='0'?s.balance.checkedAt:undefined),
        quantity:quantity(s),balanceCheckedAt:s.balance?.checkedAt,
        quantityAtomic:s.balance?.tokenAmount,tokenDecimals:s.seed.tokenDecimals,
        balanceFresh:!!s.balance&&now-Date.parse(s.balance.checkedAt)<=90_000,entryPriceUsd:s.fill?.priceUsd,
        entryBasis:s.fill?'gmgn_confirmed_fill_usd':'pending_verification',latest:s.latest,peak:s.peak,
        priceFresh:!!s.latest&&now-Date.parse(s.latest.at)<=60_000,
        gainPct:s.fill&&s.latest?(s.latest.usd/s.fill.priceUsd-1)*100:undefined,
        protection:s.protection,milestones:s.milestones,errors:s.errors}))};
  }
}
