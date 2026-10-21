import bs58 from 'bs58';
import {chainAddress,evmTransfers,object} from './chain-stream-store.js';
import type {Chain} from './types.js';
import type {RpcNotificationMeta} from './rpc-stream.js';

export interface FastWalletTarget {chain:Chain;wallet:string;groups:string[];profileUntil?:string;}
export interface FastTokenCheck {chain:Chain;address:string;state:'pass'|'fail'|'unknown';validUntil:string;}
export interface FastWalletSnapshot {at:string;validUntil:string;targets:FastWalletTarget[];tokens:FastTokenCheck[];}
export type FastVerdict='priority_review'|'review_activity'|'watch_outflow'|'blocked_cached_risk'|'refresh_profile'|'retracted';
export interface FastWalletEvent {
  id:string;chain:Chain;wallet:string;txHash:string;tokenAddress?:string;blockHash?:string;slot?:number;
  receivedAt:string;judgedAt:string;processingMs:number;kind:'wallet_mention'|'token_inflow'|'token_outflow';
  verdict:FastVerdict;groups:string[];profileFresh:boolean;cachedSafety:'pass'|'fail'|'unknown'|'expired';
  commitment:'processed'|'included';removed:boolean;buyVerified:false;tradingEnabled:false;
}
const priority=new Set(['forward_validated','repeated_early','precursor_pattern','public_kol']);
const validTime=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
/** Pins add observation targets after automatic selection; they grant no profile or trading qualification. */
export function mergePinnedWallets(chain:Chain,automatic:readonly string[],pinned:readonly string[]=[]):string[]{
  const targets=new Set<string>();
  for(const value of [...automatic,...pinned]){const wallet=chainAddress(chain,value);if(wallet)targets.add(wallet);}
  return [...targets];
}
/** Keep subscriptions stable while profile evidence continues to refresh every 30 seconds. */
export class WalletFastTargets {
  private selected=new Map<Chain,{wallets:string[];rotateAt:number}>();
  select(chain:Chain,candidates:readonly string[],limit:number,now:number):string[]{
    const cap=Math.max(1,Math.min(30,Math.trunc(limit)));
    const previous=this.selected.get(chain);
    const wallets=previous&&now<previous.rotateAt?previous.wallets.slice(0,cap):[];
    for(const value of candidates){const wallet=chainAddress(chain,value);if(wallet&&!wallets.includes(wallet)&&wallets.length<cap)wallets.push(wallet);}
    this.selected.set(chain,{wallets,rotateAt:previous&&now<previous.rotateAt?previous.rotateAt:now+300000});
    return [...wallets];
  }
}
export class LatencyWindow {
  private samples:number[]=[];private index=0;private total=0;private breaches=0;private maximum=0;
  add(ms:number){if(!Number.isFinite(ms)||ms<0)return;this.total++;if(ms>=100)this.breaches++;this.maximum=Math.max(this.maximum,ms);
    if(this.samples.length<2048)this.samples.push(ms);else this.samples[this.index++%2048]=ms;}
  summary(){const values=[...this.samples].sort((a,b)=>a-b),q=(p:number)=>values.length?values[Math.ceil(values.length*p)-1]:null;
    return {samples:this.total,windowSamples:values.length,p50Ms:q(.5),p95Ms:q(.95),p99Ms:q(.99),maxMs:this.total?this.maximum:null,over100Ms:this.breaches,
      targetMs:100,basis:'websocket_handler_entry_to_fast_verdict',window:'latest_2048',slaVerified:false};}
}
/** Bounded in-memory preview only. No database, network, signing or trade verdict. */
export class WalletFastJudge {
  private targets=new Map<string,FastWalletTarget>();private tokens=new Map<string,FastTokenCheck>();
  private expires=0;private dedup=new Map<string,number>();private snapshotAt?:string;
  readonly latency=new LatencyWindow();counts={notifications:0,accepted:0,duplicates:0,invalid:0,staleSnapshot:0,failedTransactions:0};
  constructor(private readonly now=()=>Date.now(),private readonly mono=()=>performance.now()){}
  update(snapshot:FastWalletSnapshot){
    const now=this.now(),expires=Date.parse(snapshot?.validUntil),at=Date.parse(snapshot?.at);
    if(!Number.isFinite(at)||at>now||now-at>120000||!Number.isFinite(expires)||expires<=now||expires-at>120000||
      !Array.isArray(snapshot.targets)||snapshot.targets.length>90||!Array.isArray(snapshot.tokens)||snapshot.tokens.length>500)throw new Error('FAST_WALLET_SNAPSHOT_INVALID');
    const targets=new Map<string,FastWalletTarget>(),tokens=new Map<string,FastTokenCheck>();
    for(const row of snapshot.targets){const wallet=chainAddress(row.chain,row.wallet);if(!wallet||!Array.isArray(row.groups))continue;
      targets.set(`${row.chain}:${wallet}`,{chain:row.chain,wallet,groups:row.groups.filter(g=>typeof g==='string'&&/^[a-z_]{1,40}$/.test(g)).slice(0,16),
        ...(validTime(row.profileUntil)?{profileUntil:row.profileUntil}:{})});}
    for(const row of snapshot.tokens){const address=chainAddress(row.chain,row.address);if(address&&['pass','fail','unknown'].includes(row.state)&&validTime(row.validUntil))tokens.set(`${row.chain}:${address}`,{...row,address});}
    this.targets=targets;this.tokens=tokens;this.expires=expires;this.snapshotAt=snapshot.at;
  }
  wallets(chain:Chain){return [...this.targets.values()].filter(t=>t.chain===chain).map(t=>t.wallet);}
  status(){return {snapshotAt:this.snapshotAt,snapshotFresh:this.now()<this.expires,targets:this.targets.size,
    watchedTargets:[...this.targets.values()].map(t=>({...t,profileFresh:!!t.profileUntil&&Date.parse(t.profileUntil)>this.now()})),
    counts:{...this.counts},latency:this.latency.summary()};}
  judge(chain:Chain,key:string,data:unknown,meta:RpcNotificationMeta):FastWalletEvent[]{
    const start=meta.receivedMonoAt??this.mono();this.counts.notifications++;
    try {
      const now=this.now();if(!Number.isFinite(meta.receivedAt)||meta.receivedAt>now||now-meta.receivedAt>2000){this.counts.invalid++;return [];}
      if(now>=this.expires){this.counts.staleSnapshot++;return [];}
      const previews:Omit<FastWalletEvent,'verdict'|'groups'|'profileFresh'|'cachedSafety'|'processingMs'|'judgedAt'>[]=[];
      if(chain==='solana'){
        const wallet=key.startsWith('wallet:')?chainAddress(chain,key.slice(7)):undefined;
        if(!wallet||!this.targets.has(`${chain}:${wallet}`)||!object(data)||!object(data.value)||!object(data.context)||
          !Number.isSafeInteger(data.context.slot)||data.context.slot<0||typeof data.value.signature!=='string'||data.value.signature.length>88){this.counts.invalid++;return [];}
        try {if(bs58.decode(data.value.signature).length!==64)throw new Error();}catch{this.counts.invalid++;return [];}
        if(data.value.err!==null){this.counts.failedTransactions++;return [];}
        previews.push({id:`solana:${wallet}:${data.value.signature}`,chain,wallet,txHash:data.value.signature,slot:data.context.slot,
          kind:'wallet_mention',receivedAt:new Date(meta.receivedAt).toISOString(),commitment:'processed',removed:false,buyVerified:false,tradingEnabled:false});
      }else{
        if(!['bsc','robinhood'].includes(chain)||!key.startsWith('wallet:')){this.counts.invalid++;return [];}
        const events=evmTransfers(chain,data,new Set(this.wallets(chain)),'live',new Date(meta.receivedAt));
        for(const e of events)if(e.from!==e.to&&e.amountAtomic!=='0')previews.push({id:e.id,chain,wallet:e.wallet,txHash:e.txHash,
          tokenAddress:e.tokenAddress,blockHash:e.blockHash,kind:e.to===e.wallet?'token_inflow':'token_outflow',receivedAt:e.observedAt,
          commitment:'included',removed:!!e.removed,buyVerified:false,tradingEnabled:false});
        if(!events.length)this.counts.invalid++;
      }
      const result:FastWalletEvent[]=[];
      for(const event of previews){
        const dedupKey=event.id+':'+event.removed,old=this.dedup.get(dedupKey);
        if(old!==undefined&&now-old<600000){this.counts.duplicates++;continue;}
        // Insertion order bounds memory even under a burst of distinct signatures.
        this.dedup.delete(dedupKey);this.dedup.set(dedupKey,now);
        if(this.dedup.size>10000)this.dedup.delete(this.dedup.keys().next().value!);
        const target=this.targets.get(`${chain}:${event.wallet}`)!;
        const profileFresh=!!target.profileUntil&&Date.parse(target.profileUntil)>now;
        const cached=event.tokenAddress?this.tokens.get(`${chain}:${event.tokenAddress}`):undefined;
        const cachedSafety=cached?(Date.parse(cached.validUntil)>now?cached.state:'expired'):'unknown';
        const verdict:FastVerdict=event.removed?'retracted':cachedSafety==='fail'?'blocked_cached_risk':event.kind==='token_outflow'?'watch_outflow':
          !profileFresh?'refresh_profile':target.groups.some(g=>priority.has(g))?'priority_review':'review_activity';
        const processingMs=Math.max(0,this.mono()-start);
        result.push({...event,verdict,groups:[...target.groups],profileFresh,cachedSafety,processingMs,judgedAt:new Date(this.now()).toISOString()});this.counts.accepted++;
      }
      return result;
    }finally{this.latency.add(this.mono()-start);}
  }
}
