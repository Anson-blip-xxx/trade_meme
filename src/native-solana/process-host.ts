import {spawn,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import type {Config} from '../config.js';
import type {OpeningOrder,OrderStore} from '../orders.js';
import type {TradeNotificationEvent} from '../trade-notifications.js';
import type {NativePositionState} from './positions.js';
import type {SellPercentage} from '../direct-sell.js';
import {NativeProcessStore} from './process-store.js';
import {isProtocolMessage,safeProcessError,type NativeParentMessage,type NativeWorkerMessage,type NativeWorkerSnapshot} from './process-protocol.js';

interface Pending {resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;guard?:()=>Promise<void>;guardStarted?:boolean;}
interface ReadinessObservation {ready:boolean;reason?:string;changedAt:number;}
export interface NativeProcessOptions {
  /** Main-process observers read the authoritative shared order ledger after this callback. */
  onOrderUpdate?:(order:OpeningOrder)=>void|Promise<void>;
  snapshotStaleMs?:number;guardTimeoutMs?:number;requestTimeoutMs?:number;restartDelayMs?:number;maxPendingRequests?:number;
  /** Test seam; production always starts the pinned local worker under an exclusive kernel lock. */
  spawnWorker?:(lockPath:string)=>ChildProcess;
}

/** The main process never loads the native signer or runs a position polling loop. */
export class ProcessNativeTradingRuntime {
  private store:NativeProcessStore;private child?:ChildProcess;private running=false;private stopping?:Promise<void>;
  private snapshot?:NativeWorkerSnapshot;private snapshots=new Map<string,NativePositionState>();
  private pending=new Map<string,Pending>();private error?:string;private retry?:ReturnType<typeof setTimeout>;
  private readinessObservation?:ReadinessObservation;private readinessTransitions=0;
  private lastFalseReason?:string;private lastFalseAt?:number;private lastRecoveredAt?:number;private lastFalseDurationMs?:number;
  private maxSnapshotAgeMs=0;
  private readonly storePath:string;private readonly staleMs:number;private readonly guardMs:number;private readonly requestMs:number;
  private readonly pendingLimit:number;
  constructor(private config:Config,private orders:OrderStore,private enqueue:(event:TradeNotificationEvent)=>boolean,
    private options:NativeProcessOptions={}){
    if(!config.nativeSolana?.positionsPath||config.ordersDatabase===':memory:')throw Error('NATIVE_PROCESS_REQUIRES_DURABLE_DATABASE');
    this.staleMs=options.snapshotStaleMs??1500;this.guardMs=options.guardTimeoutMs??5000;this.requestMs=options.requestTimeoutMs??120000;
    this.pendingLimit=options.maxPendingRequests??64;
    if([this.staleMs,this.guardMs,this.requestMs].some(v=>!Number.isSafeInteger(v)||v<50)||this.guardMs>30000||
      !Number.isSafeInteger(this.pendingLimit)||this.pendingLimit<1||this.pendingLimit>1000||
      options.restartDelayMs!==undefined&&(!Number.isSafeInteger(options.restartDelayMs)||options.restartDelayMs<10||options.restartDelayMs>60000))throw Error('NATIVE_PROCESS_OPTIONS_INVALID');
    this.storePath=config.nativeSolana.positionsPath+'.process.sqlite';this.store=new NativeProcessStore(this.storePath);
  }
  start(){if(this.running||this.stopping)return;this.running=true;this.launch();this.readiness();}
  private scheduleRestart(){
    if(!this.running||this.child)return;clearTimeout(this.retry);
    this.retry=setTimeout(()=>this.launch(),this.options.restartDelayMs??1000);this.retry.unref();
  }
  private launch(){
    if(!this.running||this.child)return;
    try{
      // flock -F execs Node in place. The kernel releases the lock on every crash, including SIGKILL.
      const worker=fileURLToPath(new URL('./process-worker.js',import.meta.url));
      const execArgs=import.meta.url.endsWith('.ts')?['--import','tsx',worker.replace(/\.js$/,'.ts')]:[worker];
      const child=this.options.spawnWorker?.(this.storePath+'.lock')??spawn('/usr/bin/flock',
        ['--nonblock','--no-fork',this.storePath+'.lock',process.execPath,...execArgs],
        {cwd:process.cwd(),env:process.env,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced'});
      this.child=child;this.snapshot=undefined;this.error=undefined;
      child.on('message',message=>{if(this.child===child)void this.receive(message).catch(()=>{this.error='NATIVE_WORKER_IPC_FAILED';this.readiness();});});
      const exited=(reason:string)=>{
        if(this.child!==child)return;this.child=undefined;this.snapshot=undefined;this.error=reason;
        for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error(reason));}this.pending.clear();
        this.readiness();this.scheduleRestart();
      };
      child.once('error',()=>{this.error='NATIVE_WORKER_START_FAILED';this.readiness();if(!child.pid)exited('NATIVE_WORKER_START_FAILED');});
      child.once('exit',()=>exited('NATIVE_WORKER_EXITED'));
      this.send({kind:'init',storePath:this.storePath,guardTimeoutMs:this.guardMs,config:{
        nativeSolana:this.config.nativeSolana,entryWallets:this.config.entryWallets,entrySlippagePct:this.config.entrySlippagePct,
        ordersDatabase:this.config.ordersDatabase,summaryIntervalMs:this.config.telegram?.summaryIntervalMs}});
    }catch{this.error='NATIVE_WORKER_START_FAILED';this.readiness();this.scheduleRestart();}
  }
  private send(message:NativeParentMessage):boolean{
    if(!this.child?.connected)return false;
    try{this.child.send(message,error=>{if(error){this.error='NATIVE_WORKER_IPC_FAILED';this.readiness();}});return true;}catch{return false;}
  }
  private async receive(raw:unknown){
    if(!isProtocolMessage(raw))return;const message=raw as NativeWorkerMessage;
    if(message.kind==='snapshot'){
      const value=message.value;if(!Number.isSafeInteger(value.at)||!Number.isSafeInteger(value.sequence)||!Array.isArray(value.positions))return;
      if(!this.snapshot||value.sequence>this.snapshot.sequence){
        this.snapshot=value;for(const p of value.positions)this.snapshots.set(p.buy.orderId,p);
        // Historical closure remains in the shared authoritative order ledger.
        if(this.snapshots.size>1000)for(const [id,p] of this.snapshots){if(p.state==='closed')this.snapshots.delete(id);if(this.snapshots.size<=1000)break;}
        this.error=undefined;
      }
      this.readiness();
      this.send({kind:'snapshot_ack',sequence:value.sequence});return;
    }
    if(message.kind==='result'){
      const p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);
      message.ok?p.resolve(message.value):p.reject(Error(safeProcessError(new Error(message.error??''))));return;
    }
    if(message.kind==='guard'){
      const p=this.pending.get(message.callId);
      if(!p?.guard||p.guardStarted||!this.running||Date.now()>=message.deadline){this.send({kind:'guard_result',id:message.id,ok:false,error:'NATIVE_GUARD_EXPIRED'});return;}
      p.guardStarted=true;
      try{await p.guard();if(this.pending.get(message.callId)!==p||Date.now()>=message.deadline||!this.running)throw Error('NATIVE_GUARD_EXPIRED');
        this.send({kind:'guard_result',id:message.id,ok:true});
      }catch(error){this.send({kind:'guard_result',id:message.id,ok:false,error:safeProcessError(error,'NATIVE_GUARD_REJECTED')});}return;
    }
    if(message.kind==='notice'){
      // enqueue(false) means the idempotent Telegram queue already contains this key.
      try{this.enqueue(message.event);this.send({kind:'notice_ack',key:message.event.key});}catch{}return;
    }
    if(message.kind==='order'){
      try{const order=this.orders.get(message.orderId);if(order)await this.options.onOrderUpdate?.(order);
        this.send({kind:'order_ack',orderId:message.orderId,version:message.version});}catch{}return;
    }
    if(message.kind==='fatal'){this.error=safeProcessError(new Error(message.error));this.readiness();}
  }
  readiness():{ready:boolean;reason?:string}{
    const now=Date.now(),age=this.snapshot?Math.max(0,now-this.snapshot.at):undefined;
    if(age!==undefined)this.maxSnapshotAgeMs=Math.max(this.maxSnapshotAgeMs,age);
    const result=!this.running?{ready:false as const,reason:'NATIVE_PROTECTION_STOPPED'}:
      this.error?{ready:false as const,reason:this.error}:
      !this.child?.connected||!this.snapshot?{ready:false as const,reason:'NATIVE_WORKER_STARTING'}:
      now-this.snapshot.at>this.staleMs||this.snapshot.at>now+1000?{ready:false as const,reason:'NATIVE_WORKER_SNAPSHOT_STALE'}:
      this.snapshot.status.readiness;
    this.observeReadiness(result,now);return result;
  }
  private observeReadiness(value:{ready:boolean;reason?:string},now:number):void{
    const previous=this.readinessObservation;
    if(previous&&previous.ready===value.ready&&previous.reason===value.reason)return;
    this.readinessTransitions++;
    if(value.ready){
      if(previous&&!previous.ready){this.lastRecoveredAt=now;this.lastFalseDurationMs=Math.max(0,now-(this.lastFalseAt??previous.changedAt));}
    }else{
      if(!previous||previous.ready)this.lastFalseAt=now;
      this.lastFalseReason=value.reason??'NATIVE_WORKER_UNAVAILABLE';
    }
    this.readinessObservation={...value,changedAt:now};
  }
  status(){const readiness=this.readiness(),snapshotAgeMs=this.snapshot?Math.max(0,Date.now()-this.snapshot.at):undefined;
    if(snapshotAgeMs!==undefined)this.maxSnapshotAgeMs=Math.max(this.maxSnapshotAgeMs,snapshotAgeMs);
    return {...(this.snapshot?.status??{provider:'pump_native',running:false}),readiness,
    process:{isolated:true,pid:this.snapshot?.pid,connected:!!this.child?.connected,snapshotAt:this.snapshot?new Date(this.snapshot.at).toISOString():undefined,
      snapshotAgeMs,maxSnapshotAgeMs:this.maxSnapshotAgeMs,readinessTransitions:this.readinessTransitions,
      lastReadinessTransitionAt:this.readinessObservation?new Date(this.readinessObservation.changedAt).toISOString():undefined,
      lastFalseReason:this.lastFalseReason,lastFalseAt:this.lastFalseAt?new Date(this.lastFalseAt).toISOString():undefined,
      lastRecoveredAt:this.lastRecoveredAt?new Date(this.lastRecoveredAt).toISOString():undefined,
      lastFalseDurationMs:this.lastFalseDurationMs,error:this.error}};}
  get(orderId:string){const p=this.snapshots.get(orderId);return p?structuredClone(p):undefined;}
  isClosed(orderId:string){return this.snapshots.get(orderId)?.state==='closed'||!!this.orders.get(orderId)?.exit?.positionClosed;}
  ownsAction(ref:string){return !!this.store.action(ref);}
  createAction(orderId:string){
    const p=this.get(orderId);if(!p||p.state==='closed'||p.pendingExit)throw Error('NATIVE_POSITION_UNAVAILABLE');
    // Creating an opaque button is not a sell authorization. Keep the control
    // visible across a brief IPC snapshot gap; submit() and the worker re-read
    // and validate the live position before any transaction can be built.
    return this.store.createAction(orderId);
  }
  private request(message:Extract<NativeParentMessage,{kind:'call'}>,guard?:()=>Promise<void>):Promise<any>{
    if(this.pending.size>=this.pendingLimit)return Promise.reject(Error('NATIVE_WORKER_REQUEST_BACKLOG'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(message.id);reject(Error('NATIVE_WORKER_RESPONSE_TIMEOUT'));},this.requestMs);timer.unref();
      this.pending.set(message.id,{resolve,reject,timer,guard});
      if(!this.send(message)){clearTimeout(timer);this.pending.delete(message.id);reject(Error('NATIVE_WORKER_UNAVAILABLE'));}
    });
  }
  async execute(order:OpeningOrder,beforeBroadcast:()=>Promise<void>):Promise<OpeningOrder>{
    const ready=this.readiness();if(!ready.ready)throw Error(ready.reason??'NATIVE_WORKER_UNAVAILABLE');
    return this.request({kind:'call',id:randomUUID(),method:'execute',orderId:order.id},beforeBroadcast);
  }
  async submit(ref:string,percent:SellPercentage):Promise<{text:string}>{
    if(!this.running||!this.child?.connected)return {text:'原生交易进程暂时不可用，请稍后刷新。'};
    try{return await this.request({kind:'call',id:randomUUID(),method:'submit',ref,percent});}
    catch(error){
      const reason=safeProcessError(error);
      if(reason==='NATIVE_SELL_BUTTON_EXPIRED')return {text:'卖出未提交：按钮已过期，请刷新持仓。'};
      if(reason==='NATIVE_WORKER_REQUEST_BACKLOG')return {text:'卖出未提交：原生交易请求繁忙，请稍后刷新持仓再试。'};
      // Losing an IPC reply cannot prove that the child did not durably accept or send the sell.
      return {text:'⏳ 卖出请求的回执暂未返回，成交状态待确认。请刷新持仓；重复点击原按钮不会重复提交卖单。'};
    }
  }
  async stop(){
    if(this.stopping)return this.stopping;this.running=false;this.readiness();clearTimeout(this.retry);
    this.stopping=(async()=>{
      const child=this.child;
      if(child&&child.exitCode===null){this.send({kind:'stop'});await new Promise<void>(resolve=>{
        const timer=setTimeout(()=>{child.kill('SIGTERM');resolve();},25000);timer.unref();
        child.once('exit',()=>{clearTimeout(timer);resolve();});
      });}
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('NATIVE_PROTECTION_STOPPED'));}this.pending.clear();this.store.close();
    })();return this.stopping;
  }
}
