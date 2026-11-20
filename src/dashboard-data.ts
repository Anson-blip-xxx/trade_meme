import {formatUnits} from 'viem';
import type {Config} from './config.js';
import {readNativeBalance,nativeCurrency,type NativeBalance} from './native-balance.js';
import type {Chain} from './types.js';
import type {OrderStore,OpeningOrder} from './orders.js';
import {normalizeStoredEntryHolderRisk} from './entry-holder-risk.js';
import {NATIVE_ADAPTIVE_PROTECTION_POLICY} from './native-solana/adaptive-protection.js';

export interface DashboardBalance {
  chain:Chain;symbol:string;address?:string;amount?:string;
  status:'ok'|'stale'|'unavailable'|'loading';checkedAt?:string;lastAttemptAt?:string;reason?:string;
}
export function dashboardSettings(config:Config) {
  const native=config.solanaExecutionProvider==='pump_native'?NATIVE_ADAPTIVE_PROTECTION_POLICY:undefined;
  return {scanRetentionDays:config.dashboard.retentionDays,trackingHours:config.dashboard.trackingHours,
    watchRecheck:config.watch,
    sampleIntervalSec:config.dashboard.sampleIntervalSec,balanceIntervalSec:120,balanceRetryIntervalSec:30,
    caps:config.scannerChains.map(chain=>({chain,symbol:nativeCurrency(chain).symbol,
      sizing:config.entryBalanceBps?.[chain]===undefined?config.entrySizing:'balance_fraction',
      balanceBps:config.entryBalanceBps?.[chain]??null,
      balanceBasis:config.entryBalanceBps?.[chain]===undefined?null:'total_native_balance',
      maxPerOrder:config.entryBalanceBps?.[chain]===undefined&&config.entryAmounts[chain]?formatUnits(BigInt(config.entryAmounts[chain]!),nativeCurrency(chain).decimals):null,
      feeReserve:formatUnits(BigInt(config.entryFeeReserves[chain]),nativeCurrency(chain).decimals)})),
    exitPolicy:config.exitPolicy??null,
    exitPolicyScope:native?'gmgn_condition_orders':'configured_execution_provider',
    nativeExitPolicy:native?{enabled:true,version:native.version,mode:'peak_drawdown',
      activationGainPct:(Number(native.activationValueBps)-10000)/100,
      emergencyStopDropPct:(10000-Number(native.emergencyStopValueBps))/100,
      immediateBreachDepthPct:Number(native.immediateBreachDepthBps)/100,
      ordinaryBreachConfirmations:native.ordinaryBreachConfirmations,
      followThroughStrongGainPct:(Number(native.twoXFollowThroughStrongBps)-10000)/100,
      followThroughImmediateWeaknessPct:Number(native.twoXFollowThroughImmediateWeaknessBps)/100,
      runnerTailTargetPct:Number(native.runnerTailTargetOriginalBps)/100}:null};
}
function projectOrder(order:OpeningOrder) {
  const raw=order.details.token,token=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:undefined;
  const display=(value:unknown,max:number)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max)||undefined:undefined;
  const matched=token?.chain===order.chain&&token?.address===order.tokenAddress;
  const launcherRaw=order.details.launcherEntry,launcher=launcherRaw&&typeof launcherRaw==='object'&&!Array.isArray(launcherRaw)?launcherRaw as Record<string,unknown>:undefined;
  const launcherStatus=['head_confirmed','head_corroborating','head_weak','head_exited','none','unavailable'].includes(String(launcher?.status))?
    String(launcher!.status):undefined;
  const launcherEnvelope=launcher?.version==='third-signal-launcher-v1'&&launcher.tokenAddress===order.tokenAddress&&
    launcher.sampleOnly===true&&launcher.authorizesTrade===false&&!!launcherStatus&&Array.isArray(launcher.items)&&launcher.items.length<=50;
  const launcherRawItems=launcherEnvelope?launcher!.items as unknown[]:undefined;
  const launcherItems=launcherRawItems?launcherRawItems.slice(0,10).flatMap((value:unknown)=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return [];
      const item=value as Record<string,unknown>,wallet=display(item.wallet,60),txHash=display(item.txHash,100),
        tier=['direct_precursor','peer_precursor','direct_candidate'].includes(String(item.tier))?String(item.tier):undefined;
      const buyAt=display(item.buyAt,40),observedAt=display(item.observedAt,40),soldAt=display(item.soldAt,40),mature=tier!=='direct_candidate',
        tierMatches=launcherStatus==='head_weak'?!mature:['head_confirmed','head_corroborating','head_exited'].includes(launcherStatus!)?mature:true,
        exitMatches=launcherStatus==='head_exited'?!!soldAt:!soldAt;
      return wallet&&txHash&&tier&&buyAt&&observedAt&&tierMatches&&exitMatches?[{wallet,txHash,tier,buyAt,observedAt,...(soldAt?{soldAt}:{})}]:[];
    }):undefined;
  const launcherEntry=launcherEnvelope&&((launcherStatus==='none'||launcherStatus==='unavailable')?
    launcherRawItems!.length===0:!!launcherItems?.length)?{status:launcherStatus!,checkedAt:display(launcher!.checkedAt,40),
      firstSignalAt:display(launcher!.firstSignalAt,40),wallets:launcherItems??[]}:undefined;
  return {id:order.id,chain:order.chain,tokenAddress:order.tokenAddress,
    ...(matched?{name:display(token.name,80),symbol:display(token.symbol,40)}:{}),
    createdAt:order.createdAt,updatedAt:order.updatedAt,status:order.status,mode:order.mode,
    amountIn:formatUnits(BigInt(order.actualInputAmount??order.inputAmount),nativeCurrency(order.chain).decimals),
    requestedAmount:formatUnits(BigInt(order.inputAmount),nativeCurrency(order.chain).decimals),
    actualAmount:order.actualInputAmount?formatUnits(BigInt(order.actualInputAmount),nativeCurrency(order.chain).decimals):undefined,
    amountBasis:order.actualInputAmount?'actual':'requested',
    inputSymbol:nativeCurrency(order.chain).symbol,transactionHash:order.transactionHash,
    failureReason:order.failureReason,
    ...(launcherEntry?{launcherEntry}:{}),
    entryHolderRisk:normalizeStoredEntryHolderRisk(order.details.entryHolderRisk,{chain:order.chain,address:order.tokenAddress}),
    entryHolderRiskBlocked:order.status==='failed'&&!!order.failureReason?.startsWith('ENTRY_HOLDER_RISK_')&&!order.providerOrderId&&!order.transactionHash,
    // Explicit projection: never return the request body, signing material or raw provider response.
    exit:order.exit?{state:order.exit.state,reasons:order.exit.reasons,checkedAt:order.exit.checkedAt,
      positionClosed:order.exit.positionClosed,policy:order.exit.policy}:null};
}
type OrderPageOptions={limit?:number;offset?:number;chain?:Chain};
export function dashboardOrders(orders:OrderStore,options:OrderPageOptions):Omit<ReturnType<OrderStore['page']>,'items'>&{items:ReturnType<typeof projectOrder>[]};
export function dashboardOrders(orders:OrderStore):{items:ReturnType<typeof projectOrder>[];limit:number};
export function dashboardOrders(orders:OrderStore,options?:OrderPageOptions) {
  // Legacy callers can still project an explicit bounded list; the dashboard
  // passes page options so no unrequested order is materialized.
  const page=options?orders.page(options):{items:orders.list(200),limit:200};
  return {...page,items:page.items.map(projectOrder)};
}
/** Cached read-only RPC balances. Polling the page never multiplies RPC calls. */
export class DashboardBalances {
  private readonly chains:Chain[];
  private rows:DashboardBalance[];
  private inFlight?:Promise<void>;
  private timer?:ReturnType<typeof setTimeout>;
  private running=false;
  private nextDue=new Map<Chain,number>();
  private closed=false;
  constructor(private readonly config:Config,
    private readonly read:(chain:Chain,wallet:string,config:Config)=>Promise<NativeBalance>=readNativeBalance) {
    this.chains=[...new Set(config.scannerChains)];
    this.nextDue=new Map(this.chains.map(chain=>[chain,0]));
    this.rows=this.chains.map(chain=>({chain,symbol:nativeCurrency(chain).symbol,address:config.entryWallets[chain],status:'loading'}));
  }
  get():DashboardBalance[] {return structuredClone(this.rows);}
  runOnce():Promise<void> {return this.refresh(false);}
  private refresh(onlyDue:boolean):Promise<void> {
    if(this.inFlight) return this.inFlight;
    if(this.closed) return Promise.resolve();
    this.inFlight=Promise.all(this.chains.map(async(chain):Promise<DashboardBalance>=>{
      const previous=this.rows.find(row=>row.chain===chain)!;
      if(onlyDue&&(this.nextDue.get(chain)??0)>Date.now())return previous;
      const base={chain,symbol:nativeCurrency(chain).symbol,address:this.config.entryWallets[chain]};
      if(!base.address) {this.nextDue.set(chain,Date.now()+120000);return {...base,status:'unavailable',reason:'WALLET_NOT_CONFIGURED'};}
      const failed=(reason:string,lastAttemptAt=new Date().toISOString()):DashboardBalance=>{
        this.nextDue.set(chain,Date.now()+30000);
        // This cache is for presentation only. Entry sizing always reads a new
        // verified native-balance snapshot and cannot consume this stale amount.
        const stale=previous.address===base.address&&previous.amount!==undefined&&previous.checkedAt;
        return stale?{...base,status:'stale',amount:previous.amount,checkedAt:previous.checkedAt,lastAttemptAt,reason}:
          {...base,status:'unavailable',checkedAt:lastAttemptAt,lastAttemptAt,reason};
      };
      try {
        const result=await this.read(chain,base.address,this.config);
        if(result.status==='verified'&&result.amount&&/^\d+$/.test(result.amount)) {
          this.nextDue.set(chain,Date.now()+120000);
          return {...base,status:'ok',amount:formatUnits(BigInt(result.amount),nativeCurrency(chain).decimals),checkedAt:result.checkedAt,lastAttemptAt:result.checkedAt};
        }
        return failed(result.reasons[0]??'BALANCE_UNAVAILABLE',result.checkedAt);
      } catch {return failed('BALANCE_UNAVAILABLE');}
    })).then(rows=>{if(!this.closed)this.rows=rows;}).finally(()=>{this.inFlight=undefined;});
    return this.inFlight;
  }
  start():void {
    if(this.closed||this.running)return;
    this.running=true;this.tick();
  }
  private tick():void {
    if(this.closed)return;
    void this.refresh(true).finally(()=>{
      if(this.closed)return;
      const delay=Math.max(1000,Math.min(...this.nextDue.values())-Date.now());
      this.timer=setTimeout(()=>this.tick(),delay);this.timer.unref();
    });
  }
  async stop():Promise<void> {this.closed=true;this.running=false;clearTimeout(this.timer);await this.inFlight;}
}
