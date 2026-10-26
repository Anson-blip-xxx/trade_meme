import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {WalletPressure} from './adaptive-exit.js';
import type {WalletHistoryToken} from './wallet-history.js';

interface Request {id:number;key:string;token:WalletHistoryToken;sampleAt:string;}
interface Cached {sampleAt:string;pressure?:WalletPressure;}
export interface WalletExitPressureRunnerOptions {database:string;capacity?:number;maxAgeMs?:number;refreshMs?:number;}

/** Serializes the expensive 9 GB wallet-evidence read outside the event loop. */
export class WalletExitPressureRunner {
  private readonly capacity:number;private readonly cacheCapacity:number;private readonly maxAgeMs:number;private readonly refreshMs:number;
  private worker?:Worker;private running=false;private stopping=false;private active?:Request;private sequence=0;
  private pending=new Map<string,Request>();private order:string[]=[];private cache=new Map<string,Cached>();
  private lastError?:string;private restarts=0;private stopPromise?:Promise<void>;
  constructor(private readonly options:WalletExitPressureRunnerOptions){
    this.capacity=options.capacity??64;this.cacheCapacity=this.capacity*4;
    this.maxAgeMs=options.maxAgeMs??300_000;this.refreshMs=options.refreshMs??30_000;
    if(!Number.isSafeInteger(this.capacity)||this.capacity<1||this.capacity>1000||
      !Number.isSafeInteger(this.maxAgeMs)||this.maxAgeMs<1000||!Number.isSafeInteger(this.refreshMs)||this.refreshMs<1000)
      throw Error('WALLET_EXIT_PRESSURE_OPTIONS_INVALID');
  }
  start(){if(this.running||this.stopping)return;this.running=true;this.launch();}
  private launch(){
    if(!this.running||this.stopping)return;
    try {
      const source=import.meta.url.endsWith('.ts'),entry=new URL(`./wallet-exit-pressure-worker.${source?'ts':'js'}`,import.meta.url);
      const url=source?new URL('data:text/javascript,'+encodeURIComponent(
        `import {register} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};register();await import(${JSON.stringify(entry.href)});`)):entry;
      const worker=new Worker(url,{workerData:{database:this.options.database},env:{},execArgv:[]});this.worker=worker;
      worker.on('message',message=>{
        if(this.worker!==worker||!this.active||message?.id!==this.active.id)return;
        const job=this.active;this.active=undefined;
        if(message.type==='result'&&message.sampleAt===job.sampleAt){
          const pressure=message.pressure as WalletPressure|undefined;
          if(!pressure||pressure.chain===job.token.chain&&pressure.address===job.token.address&&pressure.observedAt===job.sampleAt&&pressure.windowEndAt===job.sampleAt)
            this.putCache(job.key,{sampleAt:job.sampleAt,pressure});
          this.lastError=undefined;
        }else this.lastError='WALLET_EXIT_PRESSURE_READ_FAILED';
        this.drain();
      });
      worker.on('error',()=>{if(this.worker===worker)this.lastError='WALLET_EXIT_PRESSURE_WORKER_FAILED';});
      worker.on('exit',()=>{if(this.worker!==worker)return;this.worker=undefined;
        if(this.active){this.pending.set(this.active.key,this.active);if(!this.order.includes(this.active.key))this.order.unshift(this.active.key);this.active=undefined;}
        if(this.running&&!this.stopping){this.restarts++;this.lastError='WALLET_EXIT_PRESSURE_WORKER_EXITED';setTimeout(()=>this.launch(),1000).unref();}
      });
      this.drain();
    }catch{this.lastError='WALLET_EXIT_PRESSURE_WORKER_START_FAILED';}
  }
  request(token:WalletHistoryToken,sampleAt:string):boolean {
    if(!this.running||this.stopping||!Number.isFinite(Date.parse(sampleAt)))return false;
    const key=`${token.chain}:${token.address}`,cached=this.cache.get(key);
    if(cached&&Date.parse(sampleAt)>=Date.parse(cached.sampleAt)&&Date.parse(sampleAt)-Date.parse(cached.sampleAt)<this.refreshMs)return true;
    if(this.active?.key===key&&this.active.sampleAt>=sampleAt)return true;
    const old=this.pending.get(key);if(old&&old.sampleAt>=sampleAt)return true;
    if(!old&&this.pending.size+(this.active?1:0)>=this.capacity)return false;
    const request={id:++this.sequence,key,token:{...token},sampleAt};this.pending.set(key,request);
    if(!old)this.order.push(key);this.drain();return true;
  }
  read(token:WalletHistoryToken,quoteAt:string):WalletPressure|undefined {
    const cached=this.cache.get(`${token.chain}:${token.address}`),quote=Date.parse(quoteAt);
    if(!cached||!Number.isFinite(quote))return;
    const sample=Date.parse(cached.sampleAt),pressure=cached.pressure;
    if(sample>quote||quote-sample>this.maxAgeMs||!pressure||Date.parse(pressure.observedAt)>quote||Date.parse(pressure.windowEndAt)>quote)return;
    return structuredClone(pressure);
  }
  private putCache(key:string,value:Cached):void {
    this.cache.delete(key);this.cache.set(key,value);
    while(this.cache.size>this.cacheCapacity)this.cache.delete(this.cache.keys().next().value!);
  }
  private drain(){
    if(this.active||!this.worker)return;
    const key=this.order.shift();if(!key){if(this.stopping)this.worker.postMessage({type:'stop'});return;}
    const job=this.pending.get(key);this.pending.delete(key);if(!job){this.drain();return;}
    if(Date.now()-Date.parse(job.sampleAt)>this.maxAgeMs){this.drain();return;}
    this.active=job;this.worker.postMessage({type:'read',id:job.id,token:job.token,sampleAt:job.sampleAt});
  }
  status(){return {running:this.running&&!!this.worker,inFlight:!!this.active,pending:this.pending.size,restarts:this.restarts,error:this.lastError};}
  stop():Promise<void>{
    if(this.stopPromise)return this.stopPromise;this.stopping=true;this.running=false;
    const worker=this.worker;if(!worker)return Promise.resolve();this.drain();
    this.stopPromise=new Promise<void>(done=>{let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);this.worker=undefined;done();};
      const timeout=setTimeout(()=>{void worker.terminate().then(finish,finish);},3000);worker.once('exit',finish);
      if(!this.active&&!this.pending.size)worker.postMessage({type:'stop'});
    });return this.stopPromise;
  }
}
