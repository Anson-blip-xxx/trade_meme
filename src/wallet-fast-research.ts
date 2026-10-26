import {createHash} from 'node:crypto';
import type {FastWalletEvent} from './wallet-fast.js';
import {activityResult,type WalletActivity} from './wallet-activity.js';
import type {Chain,Signal} from './types.js';
import type {WalletTradeObservation} from './wallet-history.js';

interface Work {event:FastWalletEvent;attempts:number;due:number;cancelled:boolean;}
export interface FastResearchOptions {
  allowedChains?:Chain[];
  ready:()=>boolean;verify:(event:FastWalletEvent)=>Promise<WalletActivity>;
  onClassification:(result:WalletActivity)=>boolean;
  onTrades:(trades:WalletTradeObservation[])=>void;
  onSignal:(signal:Signal,receivedAt:string)=>Promise<void>;now?:()=>number;
}
/** Cheap chain classification and expensive screening have separate queues and budgets. */
export class WalletFastResearch {
  private queue=new Map<string,Work>();private seen=new Map<string,number>();private timer?:ReturnType<typeof setInterval>;
  private pendingAnalysis=new Map<string,{event:FastWalletEvent;result:WalletActivity}>();
  private running=false;private work?:Promise<void>;private analysis?:Promise<void>;private nextRequest=0;private nextAnalysis=0;private now:()=>number;
  private counts={queued:0,dropped:0,perWalletDropped:0,duplicates:0,expired:0,requests:0,matchedBuys:0,verifiedSells:0,filtered:0,unknown:0,
    dispatched:0,retracted:0,errors:0,analysisDropped:0,persistenceErrors:0};
  private recent:WalletActivity[]=[];
  constructor(private readonly options:FastResearchOptions){this.now=options.now??(()=>Date.now());}
  private key(event:FastWalletEvent){return `${event.chain}:${event.wallet}:${event.txHash}`;}
  enqueue(event:FastWalletEvent){
    if(!this.running)return;const key=this.key(event);
    if(this.options.allowedChains&&!this.options.allowedChains.includes(event.chain))return;
    if(event.removed){const w=this.queue.get(key);if(w)w.cancelled=true;this.pendingAnalysis.delete(key);this.counts.retracted++;
      const result=activityResult(event,this.now(),'retracted',['CHAIN_EVENT_RETRACTED']);this.record(result);this.seen.set(key,this.now());return;}
    if(event.verdict==='blocked_cached_risk')return;
    if(this.queue.has(key)||this.seen.has(key)){this.counts.duplicates++;return;}
    if([...this.queue.values()].filter(w=>w.event.chain===event.chain&&w.event.wallet===event.wallet).length>=4){this.counts.perWalletDropped++;return;}
    if(this.queue.size>=64){this.counts.dropped++;return;}
    this.queue.set(key,{event,attempts:0,due:this.now(),cancelled:false});this.counts.queued++;
    setImmediate(()=>this.tick());
  }
  private record(result:WalletActivity){this.recent.unshift(result);this.recent=this.recent.slice(0,20);
    try{if(this.options.onClassification(result))return true;}catch{}this.counts.persistenceErrors++;return false;}
  start(){if(this.running)return;this.running=true;this.timer=setInterval(()=>this.tick(),1000);this.timer.unref();}
  async runOnce(){this.tick();await this.work;this.dispatch();await this.analysis;}
  private tick(){if(!this.running)return;const now=this.now();
    for(const [key,w]of this.queue)if(w.cancelled||now-Date.parse(w.event.receivedAt)>120000){this.queue.delete(key);this.counts.expired++;}
    for(const [key,at]of this.seen)if(now-at>600000)this.seen.delete(key);
    this.dispatch();if(this.work||now<this.nextRequest)return;
    const row=[...this.queue].filter(([,w])=>w.due<=now).sort((a,b)=>Number(b[1].event.verdict==='priority_review')-Number(a[1].event.verdict==='priority_review'))[0];
    if(!row)return;this.nextRequest=now+1000;this.work=this.process(...row).finally(()=>{this.work=undefined;});
  }
  private async process(key:string,w:Work){
    const e=w.event;let retry=false;
    try {
      w.attempts++;this.counts.requests++;const result=await this.options.verify(e),now=this.now();
      if(!this.running||w.cancelled||now-Date.parse(e.receivedAt)>120000)return;
      if(result.chain!==e.chain||result.wallet!==e.wallet||result.txHash!==e.txHash||!Array.isArray(result.trades))throw new Error();
      const persisted=this.record(result);
      if(result.classification==='unknown'){this.counts.unknown++;retry=result.retryable&&w.attempts<3;w.due=now+3000;return;}
      if(!['buy','sell'].includes(result.classification)){this.counts.filtered++;return;}
      if(!persisted||!result.eventAt||!['included','confirmed'].includes(result.confirmation))return;
      const trades=result.trades.filter(t=>t.side===result.classification);
      if(!trades.length)return;
      this.options.onTrades(trades.map(t=>({chain:e.chain,wallet:e.wallet,txHash:e.txHash,tokenAddress:t.tokenAddress,side:t.side,
        amount:t.amountAtomic,amountUnit:'atomic',eventAt:result.eventAt!,observedAt:result.checkedAt,source:'chain_verified_swap'})));
      if(result.classification==='sell'){this.counts.verifiedSells+=trades.length;return;}
      this.counts.matchedBuys+=trades.length;
      if(this.pendingAnalysis.size>=16){this.counts.analysisDropped++;return;}
      this.pendingAnalysis.set(key,{event:e,result});
    }catch{this.counts.errors++;}
    finally{if(!retry){this.queue.delete(key);this.seen.set(key,this.now());if(this.seen.size>2000)this.seen.delete(this.seen.keys().next().value!);}}
  }
  private dispatch(){
    const now=this.now();for(const [key,w]of this.pendingAnalysis)if(now-Date.parse(w.event.receivedAt)>120000){this.pendingAnalysis.delete(key);this.counts.expired++;}
    if(!this.running||this.analysis||now<this.nextAnalysis||!this.options.ready())return;
    const row=this.pendingAnalysis.entries().next().value;if(!row)return;
    const [key,{event:e,result}]=row;this.pendingAnalysis.delete(key);this.nextAnalysis=now+10000;
    this.analysis=(async()=>{
      for(const trade of result.trades.slice(0,2)){
        if(!this.running)break;
        const hash=createHash('sha256').update(JSON.stringify([e.chain,e.wallet,e.txHash,trade.tokenAddress])).digest('hex');
        await this.options.onSignal({source:'wallet',sourceEventId:'wallet:'+hash,occurredAt:result.eventAt!,token:{chain:e.chain,address:trade.tokenAddress},
          text:`钱包链上买入已核验；协议 ${trade.protocol}；钱包 ${e.wallet}；交易 ${e.txHash}。仅证明该次交换，不证明盈利或钱包归属。`,evidenceUrls:[],claim:'unspecified'},e.receivedAt);
        this.counts.dispatched++;
      }
    })().catch(()=>{this.counts.errors++;}).finally(()=>{this.analysis=undefined;});
  }
  status(){return {running:this.running,inFlight:!!this.work,analysisInFlight:!!this.analysis,queued:this.queue.size,analysisQueued:this.pendingAnalysis.size,
    counts:{...this.counts},recent:this.recent,requestLimitPerMinute:60,analysisLimitPerMinute:6,maxPendingPerWallet:4,
    scope:'chain_receipt_and_wallet_flow_then_full_research',tradingEnabled:false};}
  async stop(){this.running=false;clearInterval(this.timer);await Promise.all([this.work,this.analysis]);this.queue.clear();this.pendingAnalysis.clear();}
}
