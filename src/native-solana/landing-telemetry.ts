import bs58 from 'bs58';

export const SOLANA_BLOCK_TIME_PRECISION_MS=1000;
export type NativeLandingCommitment='processed'|'confirmed'|'finalized';

export interface NativeLandingObservation {
  commitment:NativeLandingCommitment;
  observedAt:string;
  observedAfterStartedMs:number;
  observedAfterBroadcastMs?:number;
  slot:number;
  failed:boolean;
  /** False means a WebSocket gap occurred, so this is only a late upper bound. */
  precise:boolean;
}

export interface NativeLandingSnapshot {
  version:1;
  source:'solana_signature_subscribe';
  startedAt:string;
  subscriptionArmedAt?:string;
  subscriptionArmAfterStartedMs?:number;
  broadcastStartedAt?:string;
  broadcastAfterStartedMs?:number;
  jitoAcknowledgedAt?:string;
  jitoAckAfterStartedMs?:number;
  jitoAckAfterBroadcastMs?:number;
  processed?:NativeLandingObservation;
  confirmed?:NativeLandingObservation;
  finalized?:NativeLandingObservation;
  transportGap?:true;
  clockInvalid?:true;
  /** Solana getBlockTime is deliberately excluded: it is second-resolution and cannot measure landing latency. */
  blockTimePrecisionMs:typeof SOLANA_BLOCK_TIME_PRECISION_MS;
}

export interface NativeLandingTelemetryOptions {
  now?:()=>Date;
  monotonicNow?:()=>number;
  armTimeoutMs?:number;
  reconnectMs?:number;
  onUpdate?:(snapshot:NativeLandingSnapshot)=>void;
}

type SocketFactory=(url:string)=>WebSocket;
type Pending={trace:Trace;commitment:NativeLandingCommitment;resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
type Subscription={trace:Trace;commitment:NativeLandingCommitment};
type ReadyWaiter={resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
const commitments:NativeLandingCommitment[]=['processed','confirmed','finalized'];
const finite=(value:number)=>Number.isFinite(value)&&value>=0;
const validSlot=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;

interface Trace {
  signature?:string;
  startedAt:string;
  startedMono:number;
  armedAt?:string;
  armedMono?:number;
  broadcastAt?:string;
  broadcastMono?:number;
  acknowledgedAt?:string;
  acknowledgedMono?:number;
  observations:Partial<Record<NativeLandingCommitment,NativeLandingObservation>>;
  pending:Set<NativeLandingCommitment>;
  subscriptions:Set<number>;
  transportGap:boolean;
  clockInvalid:boolean;
  closed:boolean;
}

/**
 * A persistent, read-only Solana WebSocket observer for transaction landing.
 *
 * `arm()` does not return until all three signature subscriptions have been
 * acknowledged. Callers can therefore arm immediately after signing and only
 * then broadcast, avoiding the common "send first, subscribe later" blind spot.
 */
export class NativeLandingTelemetry {
  private socket?:WebSocket;
  private stopped=false;
  private connecting=false;
  private healthy=false;
  private nextId=0;
  private healthRequest?:number;
  private healthSubscription?:number;
  private reconnectTimer?:ReturnType<typeof setTimeout>;
  private readonly pending=new Map<number,Pending>();
  private readonly subscriptions=new Map<number,Subscription>();
  private readonly waiters=new Set<ReadyWaiter>();
  private readonly traces=new Map<string,Trace>();
  private readonly now:()=>Date;
  private readonly mono:()=>number;
  private readonly armTimeoutMs:number;
  private readonly reconnectMs:number;

  constructor(private readonly url:string,private readonly socketFactory:SocketFactory=url=>new WebSocket(url),
    private readonly options:NativeLandingTelemetryOptions={}){
    const parsed=new URL(url);
    if(parsed.protocol!=='wss:'||parsed.username||parsed.password||parsed.hash)throw Error('NATIVE_LANDING_WS_URL_INVALID');
    this.now=options.now??(()=>new Date());
    this.mono=options.monotonicNow??(()=>performance.now());
    this.armTimeoutMs=options.armTimeoutMs??2500;
    this.reconnectMs=options.reconnectMs??500;
    if(!finite(this.armTimeoutMs)||this.armTimeoutMs<50||this.armTimeoutMs>15000||!finite(this.reconnectMs)||this.reconnectMs<10||this.reconnectMs>10000)
      throw Error('NATIVE_LANDING_OPTIONS_INVALID');
  }

  status(){return {connected:this.socket?.readyState===1,ready:this.healthy,active:this.traces.size};}

  async warmup():Promise<void>{
    if(this.stopped)throw Error('NATIVE_LANDING_STOPPED');
    this.connect();
    await this.waitReady();
  }

  begin(startedAt=this.now()):NativeLandingTrace {
    if(this.stopped)throw Error('NATIVE_LANDING_STOPPED');
    const startedMono=this.mono(),wall=startedAt.getTime();
    if(!Number.isFinite(wall)||!Number.isFinite(startedMono))throw Error('NATIVE_LANDING_CLOCK_INVALID');
    const trace:Trace={startedAt:startedAt.toISOString(),startedMono,observations:{},pending:new Set(),subscriptions:new Set(),
      transportGap:false,clockInvalid:false,closed:false};
    this.connect();
    return new NativeLandingTrace(this,trace);
  }

  private connect(){
    if(this.stopped||this.socket||this.connecting)return;
    this.connecting=true;
    let socket:WebSocket;
    try{socket=this.socketFactory(this.url);}catch{this.connecting=false;this.scheduleReconnect();return;}
    this.socket=socket;
    const lost=()=>{if(this.socket!==socket)return;this.disconnect(true);};
    socket.addEventListener('open',()=>{
      if(this.socket!==socket)return;
      this.connecting=false;
      const id=++this.nextId;this.healthRequest=id;
      this.send({jsonrpc:'2.0',id,method:'slotSubscribe',params:[]});
    });
    socket.addEventListener('message',event=>{if(this.socket===socket)this.message(event.data);});
    socket.addEventListener('error',lost);socket.addEventListener('close',lost);
  }

  private scheduleReconnect(){
    if(this.stopped||this.reconnectTimer)return;
    this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=undefined;this.connect();},this.reconnectMs);
    this.reconnectTimer.unref?.();
  }

  private disconnect(reconnect:boolean){
    const socket=this.socket;this.socket=undefined;this.connecting=false;this.healthy=false;this.healthRequest=undefined;this.healthSubscription=undefined;
    for(const [id,pending] of this.pending){clearTimeout(pending.timer);pending.reject(Error('NATIVE_LANDING_WS_DISCONNECTED'));this.pending.delete(id);}
    for(const trace of this.traces.values()){
      trace.pending.clear();trace.subscriptions.clear();
      if(trace.broadcastAt!==undefined){trace.transportGap=true;this.publish(trace);}
    }
    this.subscriptions.clear();
    try{if(socket&&socket.readyState<2)socket.close();}catch{}
    if(reconnect&&!this.stopped)this.scheduleReconnect();
  }

  private waitReady():Promise<void>{
    if(this.healthy&&this.socket?.readyState===1)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const waiter:ReadyWaiter={resolve:()=>{clearTimeout(waiter.timer);this.waiters.delete(waiter);resolve();},
        reject:error=>{clearTimeout(waiter.timer);this.waiters.delete(waiter);reject(error);},timer:undefined as never};
      waiter.timer=setTimeout(()=>waiter.reject(Error('NATIVE_LANDING_WS_TIMEOUT')),this.armTimeoutMs);waiter.timer.unref?.();this.waiters.add(waiter);
    });
  }

  private ready(){
    this.healthy=true;
    for(const waiter of [...this.waiters])waiter.resolve();
    for(const trace of this.traces.values())if(trace.broadcastAt!==undefined&&!trace.closed)
      for(const commitment of commitments)if(!trace.observations[commitment]&&!trace.pending.has(commitment))void this.subscribe(trace,commitment).catch(()=>{});
  }

  private send(value:unknown){
    if(this.socket?.readyState!==1)throw Error('NATIVE_LANDING_WS_UNAVAILABLE');
    try{this.socket.send(JSON.stringify(value));}catch{throw Error('NATIVE_LANDING_WS_UNAVAILABLE');}
  }

  private message(data:unknown){
    if(typeof data!=='string'||data.length>100_000)return;
    let raw:unknown;try{raw=JSON.parse(data);}catch{return;}
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
    const message=raw as Record<string,any>;
    if(message.jsonrpc!=='2.0')return;
    if(message.id!==undefined){
      if(!validSlot(message.id))return;
      if(message.id===this.healthRequest){
        this.healthRequest=undefined;
        if(message.error!==undefined||!validSlot(message.result)){this.disconnect(true);return;}
        this.healthSubscription=message.result;this.ready();return;
      }
      const pending=this.pending.get(message.id);if(!pending)return;
      this.pending.delete(message.id);clearTimeout(pending.timer);pending.trace.pending.delete(pending.commitment);
      if(message.error!==undefined||!validSlot(message.result)){pending.reject(Error('NATIVE_LANDING_SUBSCRIBE_REJECTED'));return;}
      const prior=this.subscriptions.get(message.result);
      if(prior&&(prior.trace!==pending.trace||prior.commitment!==pending.commitment)){pending.reject(Error('NATIVE_LANDING_SUBSCRIPTION_COLLISION'));this.disconnect(true);return;}
      this.subscriptions.set(message.result,{trace:pending.trace,commitment:pending.commitment});pending.trace.subscriptions.add(message.result);pending.resolve();return;
    }
    if(message.method==='slotNotification'&&validSlot(message.params?.subscription)&&message.params.subscription===this.healthSubscription)return;
    if(message.method!=='signatureNotification'||!validSlot(message.params?.subscription))return;
    const subscription=this.subscriptions.get(message.params.subscription);if(!subscription)return;
    const result=message.params.result,value=result?.value;
    if(!validSlot(result?.context?.slot)||!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'err'))return;
    const {trace,commitment}=subscription;if(trace.observations[commitment])return;
    this.subscriptions.delete(message.params.subscription);trace.subscriptions.delete(message.params.subscription);
    const now=this.now(),mono=this.mono(),afterStarted=this.duration(trace,trace.startedMono,mono);
    const afterBroadcast=trace.broadcastMono===undefined?undefined:this.duration(trace,trace.broadcastMono,mono);
    trace.observations[commitment]={commitment,observedAt:now.toISOString(),observedAfterStartedMs:afterStarted??0,
      ...(afterBroadcast===undefined?{}:{observedAfterBroadcastMs:afterBroadcast}),slot:result.context.slot,failed:value.err!==null,
      precise:!trace.transportGap&&trace.broadcastAt!==undefined&&afterBroadcast!==undefined};
    if(afterStarted===undefined)trace.observations[commitment]!.precise=false;
    this.publish(trace);
    if(commitment==='finalized')this.finish(trace);
  }

  private duration(trace:Trace,start:number,end:number):number|undefined{
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start){trace.clockInvalid=true;return;}
    return end-start;
  }

  private subscribe(trace:Trace,commitment:NativeLandingCommitment):Promise<void>{
    if(!trace.signature||trace.closed||trace.observations[commitment])return Promise.resolve();
    if(!this.healthy||this.socket?.readyState!==1)return Promise.reject(Error('NATIVE_LANDING_WS_UNAVAILABLE'));
    if(trace.pending.has(commitment)||[...this.subscriptions.values()].some(v=>v.trace===trace&&v.commitment===commitment))return Promise.resolve();
    const id=++this.nextId;trace.pending.add(commitment);
    return new Promise((resolve,reject)=>{
      const pending:Pending={trace,commitment,resolve,reject,timer:undefined as never};
      pending.timer=setTimeout(()=>{if(this.pending.delete(id)){trace.pending.delete(commitment);reject(Error('NATIVE_LANDING_SUBSCRIBE_TIMEOUT'));}},this.armTimeoutMs);
      pending.timer.unref?.();this.pending.set(id,pending);
      try{this.send({jsonrpc:'2.0',id,method:'signatureSubscribe',params:[trace.signature,{commitment,enableReceivedNotification:false}]});}
      catch(error){clearTimeout(pending.timer);this.pending.delete(id);trace.pending.delete(commitment);reject(error instanceof Error?error:Error('NATIVE_LANDING_WS_UNAVAILABLE'));}
    });
  }

  async arm(trace:Trace,signature:string):Promise<void>{
    if(trace.closed||trace.signature)throw Error('NATIVE_LANDING_TRACE_STATE_INVALID');
    let bytes:Uint8Array;try{bytes=bs58.decode(signature);}catch{throw Error('NATIVE_LANDING_SIGNATURE_INVALID');}
    if(bytes.length!==64||bs58.encode(bytes)!==signature)throw Error('NATIVE_LANDING_SIGNATURE_INVALID');
    await this.warmup();trace.signature=signature;this.traces.set(signature,trace);
    try{
      await Promise.all(commitments.map(commitment=>this.subscribe(trace,commitment)));
      const at=this.now(),mono=this.mono();trace.armedAt=at.toISOString();trace.armedMono=mono;
      if(this.duration(trace,trace.startedMono,mono)===undefined)trace.clockInvalid=true;this.publish(trace);
    }catch(error){this.finish(trace);throw error;}
  }

  markBroadcast(trace:Trace,at=this.now()):void{
    const armed=commitments.every(commitment=>[...this.subscriptions.values()].some(value=>value.trace===trace&&value.commitment===commitment));
    if(trace.closed||!trace.signature||!trace.armedAt||trace.broadcastAt||!this.healthy||this.socket?.readyState!==1||!armed||
      commitments.some(commitment=>trace.observations[commitment]))throw Error('NATIVE_LANDING_TRACE_STATE_INVALID');
    trace.broadcastAt=at.toISOString();trace.broadcastMono=this.mono();
    if(this.duration(trace,trace.startedMono,trace.broadcastMono)===undefined)trace.clockInvalid=true;this.publish(trace);
  }

  markAcknowledged(trace:Trace,at=this.now()):void{
    if(trace.closed||!trace.broadcastAt||trace.acknowledgedAt)throw Error('NATIVE_LANDING_TRACE_STATE_INVALID');
    trace.acknowledgedAt=at.toISOString();trace.acknowledgedMono=this.mono();
    if(this.duration(trace,trace.startedMono,trace.acknowledgedMono)===undefined||
      this.duration(trace,trace.broadcastMono!,trace.acknowledgedMono)===undefined)trace.clockInvalid=true;this.publish(trace);
  }

  snapshot(trace:Trace):NativeLandingSnapshot {
    const arm=trace.armedMono===undefined?undefined:this.duration(trace,trace.startedMono,trace.armedMono);
    const broadcast=trace.broadcastMono===undefined?undefined:this.duration(trace,trace.startedMono,trace.broadcastMono);
    const ackStarted=trace.acknowledgedMono===undefined?undefined:this.duration(trace,trace.startedMono,trace.acknowledgedMono);
    const ackBroadcast=trace.acknowledgedMono===undefined||trace.broadcastMono===undefined?undefined:this.duration(trace,trace.broadcastMono,trace.acknowledgedMono);
    return {version:1,source:'solana_signature_subscribe',startedAt:trace.startedAt,
      ...(trace.armedAt&&arm!==undefined?{subscriptionArmedAt:trace.armedAt,subscriptionArmAfterStartedMs:arm}:{}),
      ...(trace.broadcastAt&&broadcast!==undefined?{broadcastStartedAt:trace.broadcastAt,broadcastAfterStartedMs:broadcast}:{}),
      ...(trace.acknowledgedAt&&ackStarted!==undefined&&ackBroadcast!==undefined?{jitoAcknowledgedAt:trace.acknowledgedAt,
        jitoAckAfterStartedMs:ackStarted,jitoAckAfterBroadcastMs:ackBroadcast}:{}),
      ...(trace.observations.processed?{processed:{...trace.observations.processed}}:{}),
      ...(trace.observations.confirmed?{confirmed:{...trace.observations.confirmed}}:{}),
      ...(trace.observations.finalized?{finalized:{...trace.observations.finalized}}:{}),
      ...(trace.transportGap?{transportGap:true as const}:{}),...(trace.clockInvalid?{clockInvalid:true as const}:{}),
      blockTimePrecisionMs:SOLANA_BLOCK_TIME_PRECISION_MS};
  }

  private publish(trace:Trace){try{this.options.onUpdate?.(this.snapshot(trace));}catch{/* Telemetry cannot interrupt execution. */}}

  private finish(trace:Trace){
    trace.closed=true;if(trace.signature)this.traces.delete(trace.signature);
    for(const [id,pending] of this.pending)if(pending.trace===trace){clearTimeout(pending.timer);pending.reject(Error('NATIVE_LANDING_TRACE_CLOSED'));this.pending.delete(id);}
    for(const id of trace.subscriptions){this.subscriptions.delete(id);try{this.send({jsonrpc:'2.0',id:++this.nextId,method:'signatureUnsubscribe',params:[id]});}catch{}}
    trace.pending.clear();trace.subscriptions.clear();
  }

  close(trace:Trace){if(!trace.closed)this.finish(trace);}

  stop(){
    if(this.stopped)return;this.stopped=true;clearTimeout(this.reconnectTimer);this.reconnectTimer=undefined;
    for(const waiter of [...this.waiters])waiter.reject(Error('NATIVE_LANDING_STOPPED'));
    for(const trace of [...this.traces.values()])this.finish(trace);
    this.disconnect(false);
  }
}

export class NativeLandingTrace {
  constructor(private readonly owner:NativeLandingTelemetry,private readonly trace:Trace){}
  arm(signature:string){return this.owner.arm(this.trace,signature);}
  markBroadcast(at?:Date){this.owner.markBroadcast(this.trace,at);}
  markJitoAcknowledged(at?:Date){this.owner.markAcknowledged(this.trace,at);}
  snapshot(){return this.owner.snapshot(this.trace);}
  close(){this.owner.close(this.trace);}
}
