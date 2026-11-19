import {createHash} from 'node:crypto';
import type {FastWalletEvent} from './wallet-fast.js';
import {activityResult,type WalletActivity} from './wallet-activity.js';
import type {Chain,Signal} from './types.js';
import type {WalletTradeObservation} from './wallet-history.js';

interface Work {event:FastWalletEvent;attempts:number;due:number;cancelled:boolean;}
const QUEUE_CAPACITY=64;
const CHAINS:Chain[]=['solana','bsc','robinhood'];
const chainCounts=():Record<Chain,number>=>({solana:0,bsc:0,robinhood:0});
export interface FastResearchOptions {
  allowedChains?:Chain[];
  /** Chains allowed to enter the slower signal analysis path. Other allowed
   * chains still receive receipt classification and durable trade capture. */
  analysisChains?:Chain[];
  ready:()=>boolean;verify:(event:FastWalletEvent)=>Promise<WalletActivity>;
  onClassification:(result:WalletActivity)=>boolean|Promise<boolean>;
  onTrades:(trades:WalletTradeObservation[])=>unknown|Promise<unknown>;
  onSignal:(signal:Signal,receivedAt:string)=>Promise<void>;now?:()=>number;
}
/** Cheap chain classification and expensive screening have separate queues and budgets. */
export class WalletFastResearch {
  private queue=new Map<string,Work>();private seen=new Map<string,number>();private timer?:ReturnType<typeof setInterval>;
  private retracted=new Map<string,number>();
  private pendingAnalysis=new Map<string,{event:FastWalletEvent;result:WalletActivity}>();
  private persistence=new Set<Promise<boolean>>();
  private accepting=false;private stopping=false;private stopped=false;private running=false;private stopResult=true;private stopPromise?:Promise<boolean>;
  private work?:Promise<void>;private activeKey?:string;private analysis?:Promise<void>;private nextRequest=0;private nextAnalysis=0;private now:()=>number;
  private counts={queued:0,dropped:0,perWalletDropped:0,duplicates:0,expired:0,requests:0,matchedBuys:0,verifiedSells:0,filtered:0,unknown:0,
    dispatched:0,retracted:0,errors:0,analysisDropped:0,persistenceErrors:0,evicted:0,priorityEvicted:0,fairShareEvicted:0,
    rejectedClosed:0,droppedOnStop:0,unconfirmedOnStop:0};
  private rejectedByChain=chainCounts();private evictedByChain=chainCounts();
  private recent:WalletActivity[]=[];
  constructor(private readonly options:FastResearchOptions){this.now=options.now??(()=>Date.now());}
  private key(event:FastWalletEvent){return `${event.chain}:${event.wallet}:${event.txHash}`;}
  private configuredChains(){const configured=this.options.allowedChains?.length?this.options.allowedChains:CHAINS;
    return [...new Set(configured)];}
  private priority(event:FastWalletEvent){const analysis=this.options.analysisChains??['solana'];
    return Number(analysis.includes(event.chain))*4+Number(event.verdict==='priority_review')*2;}
  private queuedByChain(){const counts=chainCounts();for(const work of this.queue.values())counts[work.event.chain]++;return counts;}
  /** Keep the global queue bounded while reserving room for the analysis chain
   * and for high-confidence wallet profiles. Equal-priority chains share the
   * queue; lower-priority work can never displace stronger evidence. */
  private makeRoom(event:FastWalletEvent):'available'|'priority'|'fair'|undefined {
    if(this.queue.size<QUEUE_CAPACITY)return 'available';
    const incoming=this.priority(event),rows=[...this.queue].filter(([key])=>key!==this.activeKey);
    let lower:typeof rows[number]|undefined,lowerPriority=Infinity;
    for(const row of rows){const candidate=this.priority(row[1].event);
      if(candidate<incoming&&candidate<lowerPriority){lower=row;lowerPriority=candidate;}}
    if(lower){this.evict(lower[0],'priority');return 'priority';}
    const chains=this.configuredChains(),quota=Math.floor(QUEUE_CAPACITY/chains.length),counts=this.queuedByChain();
    if(counts[event.chain]>=quota)return;
    const donor=rows.find(([,work])=>work.event.chain!==event.chain&&counts[work.event.chain]>quota&&this.priority(work.event)===incoming);
    if(!donor)return;
    this.evict(donor[0],'fair');return 'fair';
  }
  private evict(key:string,reason:'priority'|'fair'){
    const work=this.queue.get(key);if(!work)return;
    this.queue.delete(key);this.counts.evicted++;this.evictedByChain[work.event.chain]++;
    if(reason==='priority')this.counts.priorityEvicted++;else this.counts.fairShareEvicted++;
  }
  enqueue(event:FastWalletEvent){
    if(!this.accepting){this.counts.rejectedClosed++;return;}const key=this.key(event);
    if(this.options.allowedChains&&!this.options.allowedChains.includes(event.chain))return;
    if(event.removed){const w=this.queue.get(key);if(w)w.cancelled=true;this.pendingAnalysis.delete(key);this.counts.retracted++;
      const result=activityResult(event,this.now(),'retracted',['CHAIN_EVENT_RETRACTED']),task=this.record(result);
      this.persistence.add(task);void task.finally(()=>this.persistence.delete(task));this.seen.set(key,this.now());this.retracted.set(key,this.now());return;}
    if(event.verdict==='blocked_cached_risk')return;
    if(this.queue.has(key)||this.seen.has(key)){this.counts.duplicates++;return;}
    if([...this.queue.values()].filter(w=>w.event.chain===event.chain&&w.event.wallet===event.wallet).length>=4){this.counts.perWalletDropped++;return;}
    if(!this.makeRoom(event)){this.counts.dropped++;this.rejectedByChain[event.chain]++;return;}
    this.queue.set(key,{event,attempts:0,due:this.now(),cancelled:false});this.counts.queued++;
    setImmediate(()=>this.tick());
  }
  private async record(result:WalletActivity){this.recent.unshift(result);this.recent=this.recent.slice(0,20);
    try{if(await this.options.onClassification(result))return true;}catch{}this.counts.persistenceErrors++;return false;}
  start(){if(this.stopped)throw new Error('WALLET_FAST_RESEARCH_STOPPED');if(this.running)return;
    this.accepting=true;this.stopping=false;this.running=true;this.timer=setInterval(()=>this.tick(),1000);this.timer.unref();}
  async runOnce(){this.tick();await this.work;this.dispatch();await this.analysis;
    if(this.persistence.size)await Promise.allSettled([...this.persistence]);}
  private tick(){if(!this.running)return;const now=this.now();
    if(!this.stopping)for(const [key,w]of this.queue)if(w.cancelled||now-Date.parse(w.event.receivedAt)>120000){this.queue.delete(key);this.counts.expired++;}
    for(const [key,at]of this.seen)if(now-at>600000)this.seen.delete(key);
    for(const [key,at]of this.retracted)if(now-at>600000)this.retracted.delete(key);
    this.dispatch();if(this.work||!this.stopping&&now<this.nextRequest)return;
    const analysisChains=this.options.analysisChains??this.options.allowedChains;
    const priority=(work:Work)=>this.priority(work.event)+Number(!analysisChains||analysisChains.includes(work.event.chain));
    const row=[...this.queue].filter(([,w])=>this.stopping||w.due<=now).sort((a,b)=>priority(b[1])-priority(a[1]))[0];
    if(!row)return;this.activeKey=row[0];if(!this.stopping)this.nextRequest=now+1000;
    this.work=this.process(...row).finally(()=>{this.work=undefined;this.activeKey=undefined;});
  }
  private async process(key:string,w:Work){
    const e=w.event;let retry=false;
    try {
      w.attempts++;this.counts.requests++;const result=await this.options.verify(e),now=this.now();
      if(this.stopped||w.cancelled||!this.stopping&&now-Date.parse(e.receivedAt)>120000)return;
      if(result.chain!==e.chain||result.wallet!==e.wallet||result.txHash!==e.txHash||!Array.isArray(result.trades))throw new Error();
      const persisted=await this.record(result);
      // A reorg notice can arrive while the durable classification ACK is in
      // flight. The retraction is serialized behind that write, so stop this
      // superseded result before it can create trades or a research signal.
      if(this.stopped||w.cancelled||this.retracted.has(key))return;
      if(result.classification==='unknown'){this.counts.unknown++;retry=result.retryable&&w.attempts<3;w.due=now+3000;return;}
      if(!['buy','sell'].includes(result.classification)){this.counts.filtered++;return;}
      if(!persisted||!result.eventAt||!['included','confirmed'].includes(result.confirmation))return;
      const trades=result.trades.filter(t=>t.side===result.classification);
      if(!trades.length)return;
      await this.options.onTrades(trades.map(t=>({chain:e.chain,wallet:e.wallet,txHash:e.txHash,tokenAddress:t.tokenAddress,side:t.side,
        amount:t.amountAtomic,amountUnit:'atomic',eventAt:result.eventAt!,observedAt:result.checkedAt,source:'chain_verified_swap'})));
      if(this.stopped||w.cancelled||this.retracted.has(key))return;
      if(result.classification==='sell'){this.counts.verifiedSells+=trades.length;return;}
      this.counts.matchedBuys+=trades.length;
      if(this.stopping||this.options.analysisChains&&!this.options.analysisChains.includes(e.chain))return;
      if(this.pendingAnalysis.size>=16){this.counts.analysisDropped++;return;}
      this.pendingAnalysis.set(key,{event:e,result});
    }catch{this.counts.errors++;}
    finally{if(!retry){this.queue.delete(key);this.seen.set(key,this.now());if(this.seen.size>2000)this.seen.delete(this.seen.keys().next().value!);}}
  }
  private dispatch(){
    const now=this.now();for(const [key,w]of this.pendingAnalysis)if(now-Date.parse(w.event.receivedAt)>120000){this.pendingAnalysis.delete(key);this.counts.expired++;}
    if(!this.running||this.stopping||this.analysis||now<this.nextAnalysis||!this.options.ready())return;
    const row=this.pendingAnalysis.entries().next().value;if(!row)return;
    const [key,{event:e,result}]=row;this.pendingAnalysis.delete(key);this.nextAnalysis=now+10000;
    this.analysis=(async()=>{
      for(const trade of result.trades.slice(0,2)){
        if(!this.running||this.stopping||this.retracted.has(key))break;
        const hash=createHash('sha256').update(JSON.stringify([e.chain,e.wallet,e.txHash,trade.tokenAddress])).digest('hex');
        await this.options.onSignal({source:'wallet',sourceEventId:'wallet:'+hash,occurredAt:result.eventAt!,token:{chain:e.chain,address:trade.tokenAddress},
          text:`钱包链上买入已核验；协议 ${trade.protocol}；钱包 ${e.wallet}；交易 ${e.txHash}。仅证明该次交换，不证明盈利或钱包归属。`,evidenceUrls:[],claim:'unspecified'},e.receivedAt);
        this.counts.dispatched++;
      }
    })().catch(()=>{this.counts.errors++;}).finally(()=>{this.analysis=undefined;});
  }
  status(){return {running:this.running,accepting:this.accepting,stopping:this.stopping,stopped:this.stopped,inFlight:!!this.work,
    analysisInFlight:!!this.analysis,queued:this.queue.size,analysisQueued:this.pendingAnalysis.size,
    persistenceInFlight:this.persistence.size,
    counts:{...this.counts},recent:this.recent,requestLimitPerMinute:60,analysisLimitPerMinute:6,maxPendingPerWallet:4,
    admission:{capacity:QUEUE_CAPACITY,queuedByChain:this.queuedByChain(),rejectedByChain:{...this.rejectedByChain},evictedByChain:{...this.evictedByChain},
      protectedChains:[...(this.options.analysisChains??['solana'])],fairSharePerChain:Math.floor(QUEUE_CAPACITY/this.configuredChains().length)},
    scope:'chain_receipt_and_wallet_flow_then_full_research',tradingEnabled:false};}
  async stop(drainMs=5000):Promise<boolean>{
    if(this.stopped)return this.stopResult;if(this.stopPromise)return this.stopPromise;
    this.accepting=false;this.stopping=true;clearInterval(this.timer);
    const finish=async()=>{
      const deadline=Date.now()+Math.max(0,drainMs);
      this.counts.analysisDropped+=this.pendingAnalysis.size;this.pendingAnalysis.clear();
      let drained=true;
      while(this.queue.size||this.work||this.persistence.size){
        if(!this.work&&this.queue.size)this.tick();
        const pending=[...(this.work?[this.work]:[]),...this.persistence];
        if(!pending.length){await new Promise<void>(resolve=>setImmediate(resolve));continue;}
        const remaining=deadline-Date.now();
        if(remaining<=0||!await this.wait(Promise.allSettled(pending),remaining)){drained=false;break;}
      }
      if(drained&&this.analysis){const remaining=deadline-Date.now();
        if(remaining<=0||!await this.wait(this.analysis,remaining))drained=false;}
      if(!drained){const active=this.work&&this.activeKey&&this.queue.has(this.activeKey)?1:0;
        this.counts.droppedOnStop+=Math.max(0,this.queue.size-active);
        this.counts.unconfirmedOnStop+=Number(!!this.work)+this.persistence.size+Number(!!this.analysis);}
      this.running=false;this.stopped=true;this.stopping=false;this.queue.clear();this.pendingAnalysis.clear();
      this.stopResult=drained;return drained;
    };
    this.stopPromise=finish();return this.stopPromise;
  }
  private wait(promise:Promise<unknown>,timeoutMs:number):Promise<boolean>{return new Promise(resolve=>{
    let settled=false;const done=(value:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>done(false),timeoutMs);void promise.then(()=>done(true),()=>done(true));
  });}
}
