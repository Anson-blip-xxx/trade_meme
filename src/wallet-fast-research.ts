import {createHash} from 'node:crypto';
import {normalizeWalletActivity} from './wallet-observer.js';
import type {FastWalletEvent} from './wallet-fast.js';
import type {Signal} from './types.js';
import type {WalletTradeObservation} from './wallet-history.js';

interface Work {event:FastWalletEvent;attempts:number;due:number;cancelled:boolean;}
export interface FastResearchOptions {
  ready:()=>boolean;
  activity:(event:FastWalletEvent)=>Promise<unknown>;
  onTrades:(trades:WalletTradeObservation[])=>void;
  onSignal:(signal:Signal,receivedAt:string)=>Promise<void>;
  now?:()=>number;
}
/** Slow validation is explicit and budgeted; the socket thread never waits for this queue. */
export class WalletFastResearch {
  private queue=new Map<string,Work>();private seen=new Map<string,number>();private timer?:ReturnType<typeof setInterval>;
  private running=false;private work?:Promise<void>;private nextRequest=0;private now:()=>number;
  private counts={queued:0,dropped:0,expired:0,requests:0,matchedBuys:0,dispatched:0,noMatchingBuy:0,retracted:0,errors:0};
  private recent:{chain:string;wallet:string;txHash:string;status:string;at:string;totalMs:number}[]=[];
  constructor(private readonly options:FastResearchOptions){this.now=options.now??(()=>Date.now());}
  enqueue(event:FastWalletEvent){
    if(!this.running)return;const key=`${event.chain}:${event.wallet}:${event.txHash}`;
    if(event.removed){const pending=this.queue.get(key);if(pending)pending.cancelled=true;this.counts.retracted++;return;}
    if(event.verdict==='blocked_cached_risk')return;
    if(this.queue.has(key)||this.seen.has(key))return;
    if(this.queue.size>=32){this.counts.dropped++;return;}
    this.queue.set(key,{event,attempts:0,due:this.now(),cancelled:false});this.counts.queued++;
    // Schedule, do not execute API or SQLite work from the event-delivery callback.
    setImmediate(()=>this.tick());
  }
  start(){if(this.running)return;this.running=true;this.timer=setInterval(()=>this.tick(),1000);this.timer.unref();}
  async runOnce(){this.tick();await this.work;}
  private tick(){if(!this.running||this.work)return;const now=this.now();
    for(const [k,w]of this.queue)if(w.cancelled||now-Date.parse(w.event.receivedAt)>120000){this.queue.delete(k);this.counts.expired++;}
    for(const [k,at]of this.seen)if(now-at>600000)this.seen.delete(k);
    if(now<this.nextRequest||!this.options.ready())return;
    const row=[...this.queue].filter(([,w])=>w.due<=now).sort((a,b)=>Number(b[1].event.verdict==='priority_review')-Number(a[1].event.verdict==='priority_review'))[0];
    if(!row)return;this.nextRequest=now+10000;this.work=this.process(...row).finally(()=>{this.work=undefined;});
  }
  private async process(key:string,w:Work){
    const e=w.event;let status='unavailable';
    try {
      w.attempts++;this.counts.requests++;
      const raw=await this.options.activity(e),now=this.now();
      if(!this.running||w.cancelled||now-Date.parse(e.receivedAt)>120000){status='expired_or_retracted';return;}
      const parsed=normalizeWalletActivity(raw,e.chain,e.wallet,new Date(now).toISOString(),undefined,'gmgn_wallet_activity');
      // Match the exact observed transaction and token, never the latest unrelated buy.
      const matched=parsed.trades.filter(t=>t.txHash===e.txHash&&(!e.tokenAddress||t.tokenAddress===e.tokenAddress)&&
        Date.parse(t.eventAt)>=Date.parse(e.receivedAt)-120000&&Date.parse(t.eventAt)<=now);
      if(matched.length)this.options.onTrades(matched);
      const buys=matched.filter(t=>t.side==='buy');
      if(!buys.length){this.counts.noMatchingBuy++;status='no_matching_buy';if(w.attempts<2){w.due=now+15000;return;}return;}
      this.counts.matchedBuys+=buys.length;
      for(const trade of buys.slice(0,2)){
        if(!this.running||w.cancelled)break;
        const hash=createHash('sha256').update(JSON.stringify([e.chain,e.wallet,e.txHash,trade.tokenAddress])).digest('hex');
        const signal:Signal={source:'wallet',sourceEventId:'wallet:'+hash,occurredAt:trade.eventAt,token:{chain:e.chain,address:trade.tokenAddress},
          text:`钱包链上直听触发；GMGN 明细匹配买入；钱包 ${e.wallet}；交易 ${e.txHash}。供应商买入分类，尚非独立链上成交证明。`,
          evidenceUrls:[],claim:'unspecified'};
        await this.options.onSignal(signal,e.receivedAt);this.counts.dispatched++;
      }
      status='analysis_dispatched';
    }catch{this.counts.errors++;status='research_failed';}
    finally{
      const retry=this.running&&!w.cancelled&&w.attempts<2&&status==='no_matching_buy';
      if(!retry){this.queue.delete(key);this.seen.set(key,this.now());if(this.seen.size>2000)this.seen.delete(this.seen.keys().next().value!);}
      this.recent.unshift({chain:e.chain,wallet:e.wallet,txHash:e.txHash,status,at:new Date(this.now()).toISOString(),totalMs:Math.max(0,this.now()-Date.parse(e.receivedAt))});this.recent=this.recent.slice(0,20);
    }
  }
  status(){return {running:this.running,inFlight:!!this.work,queued:this.queue.size,counts:{...this.counts},recent:this.recent,
    requestLimitPerMinute:6,scope:'exact_transaction_vendor_buy_match_then_full_research',tradingEnabled:false};}
  async stop(){this.running=false;clearInterval(this.timer);await this.work;this.queue.clear();}
}
