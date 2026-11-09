import type {Chain} from './types.js';
import {DebotSignalError,fetchDebotSignalPage,type NormalizedDebotSignals} from './providers/debot-signals.js';

export interface DebotPublicFallbackOptions {
  chains:readonly Chain[];
  intervalMs:number;
  shouldPoll:()=>boolean;
  onPage:(page:NormalizedDebotSignals)=>unknown|Promise<unknown>;
  fetchPage?:(chain:Chain)=>Promise<NormalizedDebotSignals>;
  now?:()=>Date;
}

export class DebotPublicFallback {
  private readonly chains:Chain[];
  private readonly now:()=>Date;
  private timer?:ReturnType<typeof setTimeout>;
  private work?:Promise<void>;
  private running=false;
  private received=0;
  private polls=0;
  private lastPollAt?:string;
  private lastSignalAt?:string;
  private lastError?:string;
  private cooldownUntil=0;

  constructor(private readonly options:DebotPublicFallbackOptions) {
    this.chains=[...new Set(options.chains)];this.now=options.now??(()=>new Date());
    if(!this.chains.length||!Number.isInteger(options.intervalMs)||options.intervalMs<1000)
      throw new Error('DEBOT_PUBLIC_FALLBACK_CONFIG_INVALID');
  }

  status() {
    return {enabled:true,running:this.running,active:this.running&&this.options.shouldPoll(),
      mode:'public_delayed_research' as const,polls:this.polls,received:this.received,lastPollAt:this.lastPollAt,
      lastSignalAt:this.lastSignalAt,lastError:this.lastError,
      cooldownUntil:this.cooldownUntil>this.now().getTime()?new Date(this.cooldownUntil).toISOString():undefined};
  }

  start():void {
    if(this.running)return;
    this.running=true;this.schedule(0);
  }

  /** Wake the fallback immediately after a verified authentication failure. */
  poke():void {
    if(!this.running||this.work)return;
    clearTimeout(this.timer);this.timer=undefined;this.schedule(0);
  }

  async stop():Promise<void> {
    this.running=false;clearTimeout(this.timer);this.timer=undefined;await this.work;
  }

  private schedule(delay:number):void {
    if(!this.running||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=undefined;void this.tick();},delay);this.timer.unref();
  }

  private tick():Promise<void> {
    if(this.work)return this.work;
    const work=this.collect().finally(()=>{
      if(this.work===work)this.work=undefined;
      if(this.running)this.schedule(Math.max(this.options.intervalMs,this.cooldownUntil-this.now().getTime()));
    });
    this.work=work;return work;
  }

  private async collect():Promise<void> {
    if(!this.running||!this.options.shouldPoll()||this.cooldownUntil>this.now().getTime())return;
    this.polls++;this.lastPollAt=this.now().toISOString();this.lastError=undefined;
    for(const chain of this.chains) {
      if(!this.running||!this.options.shouldPoll())break;
      try {
        const page=await (this.options.fetchPage??(value=>fetchDebotSignalPage(value)))(chain);
        if(!this.running||!this.options.shouldPoll())break;
        const delayed:NormalizedDebotSignals={...page,observations:page.observations.map(observation=>
          ({...observation,delivery:'public_delayed_poll' as const}))};
        await this.options.onPage(delayed);
        this.received+=delayed.observations.length;
        if(delayed.observations.length)this.lastSignalAt=this.now().toISOString();
        if(delayed.reason&&delayed.reason!=='DEBOT_SIGNAL_RECORDS_REJECTED')this.lastError=delayed.reason;
      } catch(error) {
        const reason=error instanceof DebotSignalError?error.reason:'DEBOT_PUBLIC_FALLBACK_FAILED';
        this.lastError=reason;
        if(reason==='DEBOT_SIGNAL_HTTP_429')this.cooldownUntil=Math.max(this.now().getTime()+60_000,error instanceof DebotSignalError?error.cooldownUntil??0:0);
        else if(reason==='DEBOT_SIGNAL_HTTP_401'||reason==='DEBOT_SIGNAL_HTTP_403')this.cooldownUntil=this.now().getTime()+300_000;
        break;
      }
    }
  }
}
