import {cpus,freemem,totalmem} from 'node:os';
import {readFile,statfs} from 'node:fs/promises';

export interface HostSample {
  cpu:{idle:number;total:number;cores:number};
  memory:{usedBytes:number;totalBytes:number;availableBytes:number;processRssBytes:number};
  disk?:{usedBytes:number;totalBytes:number;freeBytes:number};
  warnings:string[];
}
export interface SystemStatus {
  status:'loading'|'ok'|'partial';sampledAt?:string;startedAt:string;uptimeSec:number;
  cpu:{usagePct:number|null;cores:number;windowSec:number};
  memory?:HostSample['memory'];disk?:HostSample['disk'];warnings:string[];
}
async function readHost(storagePath:string):Promise<HostSample> {
  const processors=cpus(),totalBytes=totalmem();let availableBytes=freemem();
  // Linux MemAvailable includes reclaimable cache, unlike MemFree.
  try {
    const text=await readFile('/proc/meminfo','utf8'),match=text.match(/^MemAvailable:\s+(\d+) kB$/m);
    if(match) {const n=Number(match[1])*1024;if(Number.isSafeInteger(n)&&n>=0&&n<=totalBytes)availableBytes=n;}
  } catch { /* Other operating systems use the OS free-memory measurement. */ }
  const cpu=processors.reduce((value,processor)=>({idle:value.idle+processor.times.idle,
    total:value.total+Object.values(processor.times).reduce((a,b)=>a+b,0),cores:value.cores+1}),{idle:0,total:0,cores:0});
  const result:HostSample={cpu,memory:{totalBytes,availableBytes,usedBytes:Math.max(0,totalBytes-availableBytes),
    processRssBytes:process.memoryUsage().rss},warnings:[]};
  try {
    const disk=await statfs(storagePath);
    const totalBytes=disk.blocks*disk.bsize,freeBytes=disk.bavail*disk.bsize,usedBytes=(disk.blocks-disk.bfree)*disk.bsize;
    if(![totalBytes,freeBytes,usedBytes].every(value=>Number.isSafeInteger(value)&&value>=0)||totalBytes<=0||freeBytes>totalBytes||usedBytes>totalBytes)throw new Error();
    result.disk={totalBytes,freeBytes,usedBytes};
  } catch {result.warnings.push('DISK_STATS_UNAVAILABLE');}
  return result;
}

/** Cached local host measurements. No shell, external requests, paths or environment values enter the response. */
export class SystemMonitor {
  private state:SystemStatus;
  private previous?:{at:number;cpu:HostSample['cpu']};
  private readonly read:()=>Promise<HostSample>;
  private readonly now:()=>Date;
  private readonly uptime:()=>number;
  private inFlight?:Promise<void>;
  private timer?:ReturnType<typeof setInterval>;
  private closed=false;
  constructor(storagePath:string,options:{read?:()=>Promise<HostSample>;now?:()=>Date;uptime?:()=>number}={}) {
    this.read=options.read??(()=>readHost(storagePath));this.now=options.now??(()=>new Date());this.uptime=options.uptime??(()=>process.uptime());
    this.state={status:'loading',startedAt:new Date(this.now().getTime()-this.uptime()*1000).toISOString(),uptimeSec:0,
      cpu:{usagePct:null,cores:0,windowSec:0},warnings:[]};
  }
  get():SystemStatus {return {...structuredClone(this.state),uptimeSec:Math.max(0,Math.floor(this.uptime()))};}
  runOnce():Promise<void> {
    if(this.inFlight)return this.inFlight;
    if(this.closed)return Promise.resolve();
    this.inFlight=this.collect().finally(()=>{this.inFlight=undefined;});return this.inFlight;
  }
  private async collect():Promise<void> {
    try {
      const sample=await this.read();if(this.closed)return;
      const at=this.now(),previous=this.previous;
      const elapsed=previous?(at.getTime()-previous.at)/1000:0;
      const delta=previous?sample.cpu.total-previous.cpu.total:0,idle=previous?sample.cpu.idle-previous.cpu.idle:0;
      const usagePct=previous&&sample.cpu.cores===previous.cpu.cores&&sample.cpu.cores>0&&elapsed>=0.25&&delta>0&&idle>=0&&idle<=delta
        ?Math.round((1-idle/delta)*1000)/10:null;
      this.previous={at:at.getTime(),cpu:sample.cpu};
      this.state={status:sample.warnings.length?'partial':'ok',sampledAt:at.toISOString(),startedAt:this.state.startedAt,uptimeSec:0,
        cpu:{usagePct,cores:sample.cpu.cores,windowSec:usagePct===null?0:elapsed},memory:sample.memory,disk:sample.disk,warnings:sample.warnings};
    } catch {
      if(!this.closed)this.state={...this.state,status:'partial',warnings:['SYSTEM_STATS_UNAVAILABLE']};
    }
  }
  start():void {
    if(this.closed||this.timer)return;
    void this.runOnce();this.timer=setInterval(()=>{void this.runOnce();},15000);this.timer.unref();
  }
  async stop():Promise<void> {this.closed=true;clearInterval(this.timer);await this.inFlight;}
}
