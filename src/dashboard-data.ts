import {formatUnits} from 'viem';
import type {Config} from './config.js';
import {readNativeBalance,nativeCurrency,type NativeBalance} from './native-balance.js';
import type {Chain} from './types.js';
import type {OrderStore,OpeningOrder} from './orders.js';

const chains:Chain[]=['bsc','solana','robinhood'];
export interface DashboardBalance {
  chain:Chain;symbol:string;address?:string;amount?:string;
  status:'ok'|'stale'|'unavailable'|'loading';checkedAt?:string;lastAttemptAt?:string;reason?:string;
}
export function dashboardSettings(config:Config) {
  return {scanRetentionDays:config.dashboard.retentionDays,trackingHours:config.dashboard.trackingHours,
    watchRecheck:config.watch,
    sampleIntervalSec:config.dashboard.sampleIntervalSec,balanceIntervalSec:120,balanceRetryIntervalSec:30,
    caps:chains.map(chain=>({chain,symbol:nativeCurrency(chain).symbol,
      sizing:config.entryBalanceBps?.[chain]===undefined?config.entrySizing:'balance_fraction',
      balanceBps:config.entryBalanceBps?.[chain]??null,
      maxPerOrder:config.entryBalanceBps?.[chain]===undefined&&config.entryAmounts[chain]?formatUnits(BigInt(config.entryAmounts[chain]!),nativeCurrency(chain).decimals):null,
      feeReserve:formatUnits(BigInt(config.entryFeeReserves[chain]),nativeCurrency(chain).decimals)})),
    exitPolicy:config.exitPolicy??null};
}
function projectOrder(order:OpeningOrder) {
  return {id:order.id,chain:order.chain,tokenAddress:order.tokenAddress,
    createdAt:order.createdAt,updatedAt:order.updatedAt,status:order.status,mode:order.mode,
    amountIn:formatUnits(BigInt(order.actualInputAmount??order.inputAmount),nativeCurrency(order.chain).decimals),
    requestedAmount:formatUnits(BigInt(order.inputAmount),nativeCurrency(order.chain).decimals),
    actualAmount:order.actualInputAmount?formatUnits(BigInt(order.actualInputAmount),nativeCurrency(order.chain).decimals):undefined,
    amountBasis:order.actualInputAmount?'actual':'requested',
    inputSymbol:nativeCurrency(order.chain).symbol,transactionHash:order.transactionHash,
    failureReason:order.failureReason,
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
  private rows:DashboardBalance[];
  private inFlight?:Promise<void>;
  private timer?:ReturnType<typeof setTimeout>;
  private running=false;
  private nextDue=new Map<Chain,number>(chains.map(chain=>[chain,0]));
  private closed=false;
  constructor(private readonly config:Config,
    private readonly read:(chain:Chain,wallet:string,config:Config)=>Promise<NativeBalance>=readNativeBalance) {
    this.rows=chains.map(chain=>({chain,symbol:nativeCurrency(chain).symbol,address:config.entryWallets[chain],status:'loading'}));
  }
  get():DashboardBalance[] {return structuredClone(this.rows);}
  runOnce():Promise<void> {return this.refresh(false);}
  private refresh(onlyDue:boolean):Promise<void> {
    if(this.inFlight) return this.inFlight;
    if(this.closed) return Promise.resolve();
    this.inFlight=Promise.all(chains.map(async(chain):Promise<DashboardBalance>=>{
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
