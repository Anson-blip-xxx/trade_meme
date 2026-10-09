import type {Report,Signal} from './types.js';
import type {ScanArchive,WatchQueueStatus} from './scan-archive.js';

export interface WatchRecheckerOptions {
  archive:ScanArchive;
  evaluate:(signal:Signal,identity:{id:string;receivedAt:string})=>Promise<Report>;
  entry?:(report:Report)=>Promise<unknown>;
  shouldDefer?:()=>boolean|string|undefined|Promise<boolean|string|undefined>;
  intervalMs?:number;maxPerCycle?:number;now?:()=>Date;
}
export interface WatchRecheckerStatus {
  running:boolean;inFlight:boolean;lastRunAt?:string;lastError?:string;deferredReason?:string;
  completed:number;queue:WatchQueueStatus;
}

/** One bounded global queue; refreshes the original research, never its event age. */
export class WatchRechecker {
  private readonly intervalMs:number;
  private readonly maxPerCycle:number;
  private readonly now:()=>Date;
  private timer?:ReturnType<typeof setTimeout>;
  private active?:Promise<void>;
  private stopped=false;
  private running=false;
  private generation=0;
  private nextAutomaticAt=0;
  private cycleAttempted=false;
  private lastRunAt?:string;
  private lastError?:string;
  private deferredReason?:string;
  private completed=0;

  constructor(private readonly options:WatchRecheckerOptions) {
    this.intervalMs=options.intervalMs??120_000;this.maxPerCycle=options.maxPerCycle??1;
    if(!Number.isSafeInteger(this.intervalMs)||this.intervalMs<1||
      !Number.isSafeInteger(this.maxPerCycle)||this.maxPerCycle<1||this.maxPerCycle>20)
      throw new Error('WATCH_RECHECKER_CONFIG_INVALID');
    this.now=options.now??(()=>new Date());
  }

  start():void {
    if(this.running)return;
    this.stopped=false;this.running=true;
    this.tick(this.generation);
  }

  runOnce():Promise<void> {
    if(this.active)return this.active;
    if(this.stopped)return Promise.resolve();
    const generation=this.generation;
    const work=Promise.resolve().then(()=>this.cycle(generation)).catch(()=>{this.lastError='WATCH_QUEUE_FAILED';})
      .finally(()=>{
        if(this.cycleAttempted)this.nextAutomaticAt=this.now().getTime()+this.intervalMs;
        if(this.active===work)this.active=undefined;
      });
    this.active=work;return work;
  }

  async stop():Promise<void> {
    this.stopped=true;this.running=false;this.generation++;
    if(this.timer)clearTimeout(this.timer);
    this.timer=undefined;
    await this.active;
  }

  getStatus():WatchRecheckerStatus {
    return {running:this.running,inFlight:!!this.active,lastRunAt:this.lastRunAt,lastError:this.lastError,
      deferredReason:this.deferredReason,completed:this.completed,queue:this.options.archive.watchStatus(this.now())};
  }

  private tick(generation:number):void {
    if(!this.running||this.stopped||generation!==this.generation)return;
    const remaining=this.nextAutomaticAt-this.now().getTime();
    if(remaining>0){this.schedule(generation,remaining);return;}
    void this.runOnce().finally(()=>{
      if(!this.running||this.stopped||generation!==this.generation)return;
      let delay=this.intervalMs;
      // Busy research is local contention, not a provider failure. Brief local
      // checks can use the scanner's idle window without raising API throughput.
      if(!this.cycleAttempted&&(this.deferredReason==='SCANNER_BUSY'||this.deferredReason==='RESEARCH_BUSY')) {
        try {if(this.options.archive.watchStatus(this.now()).due>0)delay=Math.min(10_000,this.intervalMs);}
        catch {this.lastError='WATCH_QUEUE_FAILED';}
      }
      this.schedule(generation,delay);
    });
  }

  private schedule(generation:number,delay:number):void {
    this.timer=setTimeout(()=>{this.timer=undefined;this.tick(generation);},Math.min(2_147_483_647,Math.max(1,delay)));
    this.timer.unref();
  }

  private async cycle(generation:number):Promise<void> {
    this.cycleAttempted=false;
    const interrupted=()=>this.stopped||generation!==this.generation;
    if(interrupted())return;
    this.lastRunAt=this.now().toISOString();
    this.deferredReason=undefined;
    for(let index=0;index<this.maxPerCycle&&!interrupted();index++) {
      let defer:boolean|string|undefined;
      try {defer=await this.options.shouldDefer?.();}
      catch {this.lastError='WATCH_DEFER_CHECK_FAILED';return;}
      if(interrupted())return;
      if(defer) {
        this.deferredReason=typeof defer==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(defer)?defer:'RECHECK_DEFERRED';
        return;
      }
      const claim=this.options.archive.claimWatch(this.now());if(!claim)return;
      try {
        this.cycleAttempted=true;
        const report=await this.options.evaluate(claim.signal,{id:claim.id,receivedAt:claim.receivedAt});
        if(interrupted()){this.options.archive.failWatch(claim.id,claim.claimId,'WORKER_STOPPED',this.now());return;}
        const result=this.options.archive.finishWatch(claim.id,claim.claimId,report,this.now());
        if(!result.accepted){this.lastError='RECHECK_RESULT_NOT_APPLIED';continue;}
        this.completed++;this.lastError=undefined;
        if(result.report&&this.options.entry&&this.options.archive.canEnterWatch(claim.id,claim.claimId,result.report,this.now())) {
          try {await this.options.entry(result.report);}
          catch {this.lastError='WATCH_ENTRY_FAILED';}
        }
      } catch {
        // Provider errors may contain credentials, URLs, or response bodies.
        // Expose a fixed reason while retaining the original bounded retry job.
        this.lastError='RECHECK_FAILED';
        this.options.archive.failWatch(claim.id,claim.claimId,'RECHECK_FAILED',this.now());
      }
    }
  }
}
