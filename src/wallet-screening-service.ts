import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {existsSync,realpathSync,statSync} from 'node:fs';
import type {Chain,Signal,Report,Check} from './types.js';
import type {GmgnResearch} from './research.js';
import {chainAddress} from './chain-stream-store.js';
import {WalletHistory,type WalletTradeObservation} from './wallet-history.js';
import {WalletProfileReader} from './wallet-profiles.js';
import {analyzeWalletScreening,qualifiedWalletWithdrawal,type WalletScreeningReport} from './wallet-screening.js';
import {WalletSetupLedger} from './wallet-setup-ledger.js';

/** No vendor requests: combines already collected current evidence with bounded local profiles. */
export class WalletScreeningService {
  readonly ledger:WalletSetupLedger;
  private timer?:ReturnType<typeof setInterval>;
  private work?:Promise<void>;
  private dispatchWork?:Promise<void>;
  private stopped=false;
  private error?:string;
  private cohorts=new Map<Chain,{at:number;values:number[]}>();
  private dispatch?: (signal:Signal)=>Promise<void|boolean>;
  private emitted=new Map<string,number>();private discoveryOffset=0;private lastDispatch=0;
  constructor(private readonly history:WalletHistory,private readonly profiles:WalletProfileReader,
    options:{database:string;maxBytes:number;sourcePaths:string[]},private readonly now:()=>Date=()=>new Date()) {
    const sameFile=(a:string,b:string)=>{
      if(resolve(a)===resolve(b))return true;
      if(!existsSync(a)||!existsSync(b))return false;
      const sa=statSync(a),sb=statSync(b);
      return realpathSync(a)===realpathSync(b)||sa.dev===sb.dev&&sa.ino===sb.ino;
    };
    if(options.sourcePaths.some(p=>sameFile(p,options.database)))throw new Error('WALLET_SCREENING_DATABASE_MUST_BE_SEPARATE');
    this.ledger=new WalletSetupLedger(options.database,{maxBytes:options.maxBytes,now});
  }
  assess(signal:Signal,research:Pick<GmgnResearch,'wallets'|'snapshot'>|undefined,now=this.now()):WalletScreeningReport {
    const raw=this.history.screeningEvidence(signal.token,now),analysis=research?.wallets;
    const extras:WalletTradeObservation[]=[];
    if(analysis?.summary.token.chain===signal.token.chain&&analysis.summary.token.address===signal.token.address&&
      Number.isFinite(Date.parse(analysis.checkedAt))&&Date.parse(analysis.checkedAt)<=now.getTime()) {
      for(const w of analysis.wallets.slice(0,100))for(const e of (w.enrichment.activity?.events??[]).slice(0,100))
        extras.push({chain:signal.token.chain,wallet:w.address,tokenAddress:signal.token.address,txHash:e.txHash,
          side:e.type,eventAt:e.timestamp,observedAt:analysis.checkedAt,amount:e.amount,usd:e.usd,source:'screening_current_analysis'});
    }
    const trades=[...raw.trades,...extras];
    const addresses=[...new Set(trades.filter(t=>t.side==='buy'&&Date.parse(t.eventAt)>=now.getTime()-600000)
      .map(t=>chainAddress(signal.token.chain,t.wallet)).filter((a):a is string=>!!a))];
    const first=this.profiles.getMany(addresses.slice(0,64).map(address=>({chain:signal.token.chain,address})));
    const peers=[...new Set(first.flatMap(p=>(p.roleAnalysis?.peers??[]).map(r=>r.address)))].filter(a=>!first.some(p=>p.address===a));
    const profiles=[...first,...this.profiles.getMany(peers.slice(0,128).map(address=>({chain:signal.token.chain,address})))];
    let cohort=this.cohorts.get(signal.token.chain);
    if(!cohort||now.getTime()-cohort.at>=60000||now.getTime()<cohort.at){cohort={at:now.getTime(),values:this.profiles.profitCohort(signal.token.chain,now)};this.cohorts.set(signal.token.chain,cohort);}
    const result=analyzeWalletScreening({token:signal.token,now:now.toISOString(),trades,profiles,wallets:analysis,
      snapshot:research?.snapshot,profitCohort:cohort.values,truncated:raw.truncated||addresses.length>64||peers.length>128});
    // A failed durable registration cannot masquerade as a recorded forward observation.
    this.ledger.record(result);this.error=undefined;
    return result;
  }
  /** Re-read local counterevidence after quote/queue waits; the frozen report is never authority for later events. */
  revalidate(report:Report,now=this.now()):Check {
    const check=(status:Check['status'],reason:string):Check=>({status,reasons:[reason],checkedAt:now.toISOString(),
      facts:{scope:'local_wallet_counterevidence_recheck',ownershipProven:false}});
    if(this.stopped)return check('unknown','WALLET_SCREENING_UNAVAILABLE');
    const current=this.assess(report.signal,report.gmgn&&report.wallets?{snapshot:report.gmgn,wallets:report.wallets}:undefined,now);
    const supported=current.setups.filter(s=>s.status==='supported');
    if(!supported.length&&current.setups.some(qualifiedWalletWithdrawal))return check('unknown','WALLET_SETUP_SUPPORT_WITHDRAWN');
    if(report.flow?.reasons.includes('PROFILED_WALLET_SETUP_SUPPORTED')) {
      const expected=new Set(report.walletScreening?.setups.filter(s=>s.status==='supported').map(s=>s.id));
      if(current.status!=='supported'||Date.parse(current.validUntil)<=now.getTime()||!supported.some(s=>expected.has(s.id)))
        return check('unknown','WALLET_SETUP_SUPPORT_NOT_CURRENT');
    }
    return check('pass','WALLET_LOCAL_COUNTEREVIDENCE_RECHECKED');
  }
  start(dispatch?:(signal:Signal)=>Promise<void|boolean>):void {if(this.timer||this.stopped)return;this.dispatch=dispatch;this.timer=setInterval(()=>this.tick(),10000);this.timer.unref();}
  private tick():void {
    if(this.work||this.stopped)return;
    this.work=(async()=>{
      for(const token of this.ledger.pending(10)) {
        if(this.stopped)break;
        const now=this.now(),evidence=this.history.screeningEvidence(token,now);
        this.ledger.observe(token,evidence.trades,now,{truncated:evidence.truncated});
        await new Promise<void>(r=>setImmediate(r));
      }
      if(!this.stopped&&this.dispatch&&!this.dispatchWork&&this.now().getTime()-this.lastDispatch>=60000){
        const now=this.now(),trades=this.history.screeningWalletCandidates(now,this.discoveryOffset);
        // Empty trade pages can still contain recently updated holding-only wallets.
        this.discoveryOffset=(this.discoveryOffset+40)%2000;
        const profiles=this.profiles.getMany(trades.map(t=>({chain:t.chain,address:t.wallet})));
        for(const [key,at] of this.emitted)if(now.getTime()-at>600000)this.emitted.delete(key);
        for(const t of trades){
          const p=profiles.find(p=>p.chain===t.chain&&p.address===t.wallet);
          if(!p?.groups.some(g=>g.id==='precursor_pattern'||g.id==='public_kol'))continue;
          const id='wallet-setup:trade:'+createHash('sha256').update(JSON.stringify([t.chain,t.wallet,t.tokenAddress,t.txHash])).digest('hex');
          if(this.emitted.has(id))continue;
          this.dispatchWork=this.dispatch({source:'gmgn',sourceEventId:id,token:{chain:t.chain,address:t.tokenAddress},occurredAt:t.eventAt,
            text:'本地已采样钱包买入触发的画像筛选；身份与后续进场仍待验证。',evidenceUrls:[],claim:'unspecified'})
            .then(accepted=>{if(accepted!==false){this.emitted.set(id,now.getTime());this.lastDispatch=now.getTime();}})
            .catch(()=>{this.error='WALLET_SETUP_RESEARCH_FAILED';}).finally(()=>{this.dispatchWork=undefined;});break;
        }
      }
      this.error=undefined;
    })().catch(()=>{this.error='WALLET_SETUP_OBSERVATION_FAILED';}).finally(()=>{this.work=undefined;});
  }
  status(){return {enabled:true,running:!!this.timer,error:this.error,...this.ledger.status()};}
  async close():Promise<void>{this.stopped=true;clearInterval(this.timer);this.timer=undefined;await this.work;await this.dispatchWork;this.ledger.close();}
}
