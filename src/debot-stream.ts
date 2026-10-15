import {randomInt} from 'node:crypto';
import {io,type ManagerOptions,type SocketOptions} from 'socket.io-client';
import type {Chain} from './types.js';
import {normalizeDebotSignalPush,type NormalizedDebotSignals} from './providers/debot-signals.js';
import {DebotSessionError} from './providers/debot-session.js';

const CHANNELS:Record<Chain,string>={bsc:'community-signal-channel:2',solana:'community-signal-channel:1',robinhood:'community-signal-channel:83'};
const AUTH_TIMEOUT_MS=10_000,MAX_CALLBACKS=64;
export interface DebotSocket {
  on(event:string,listener:(...args:any[])=>void):unknown;
  emit(event:string,...args:unknown[]):unknown;
  connect():unknown;
  disconnect():unknown;
  removeAllListeners():unknown;
}
export type DebotSocketFactory=(url:string,options:Partial<ManagerOptions&SocketOptions>)=>DebotSocket;
export interface DebotStreamOptions {
  chains:Chain[];
  getSession:()=>Promise<{subToken:string;cookieHeader?:string}>;
  onPage:(page:NormalizedDebotSignals)=>unknown|Promise<unknown>;
  onAuthorized?:()=>unknown|Promise<unknown>;
  now?:()=>Date;
  socketFactory?:DebotSocketFactory;
}
export type DebotStreamState='auth_required'|'connecting'|'authorizing'|'live'|'disconnected'|'stopped'|'error';

/** Authenticated, read-only Socket.IO subscription. No anonymous transport fallback. */
export class DebotStream {
  private readonly chains:Chain[];
  private readonly now:()=>Date;
  private socket?:DebotSocket;
  private connectionWork?:Promise<void>;
  private readonly callbacks=new Set<Promise<void>>();
  private retryTimer?:ReturnType<typeof setTimeout>;
  private authTimer?:ReturnType<typeof setTimeout>;
  private running=false;
  private connected=false;
  private authorized=false;
  private state:DebotStreamState='stopped';
  private generation=0;
  private attempts=0;
  private failures=0;
  private received=0;
  private reconnects=0;
  private lastSignalAt?:string;
  private lastAuthorizedAt?:string;
  private lastSignalDelayMs?:number;
  private maxSignalDelayMs?:number;
  private messageSequence=0;
  private lastError?:string;
  private stopping?:Promise<void>;

  constructor(private readonly options:DebotStreamOptions) {
    this.chains=[...new Set(options.chains)];this.now=options.now??(()=>new Date());
    if(!this.chains.length||this.chains.some(chain=>!Object.hasOwn(CHANNELS,chain)))
      throw new Error('DEBOT_STREAM_CONFIG_INVALID');
  }

  getStatus() {
    return {enabled:true,running:this.running,connected:this.connected,authorized:this.authorized,state:this.state,
      mode:'authenticated_stream' as const,lastSignalAt:this.lastSignalAt,lastAuthorizedAt:this.lastAuthorizedAt,
      lastSignalDelayMs:this.lastSignalDelayMs,maxSignalDelayMs:this.maxSignalDelayMs,
      received:this.received,reconnects:this.reconnects,lastError:this.lastError};
  }

  /** A verified HTTP authentication failure also invalidates an open subscription. */
  invalidateSession():void {this.rejectAuthorization('DEBOT_SESSION_AUTH_REQUIRED');}

  async start():Promise<void> {
    if(this.stopping)await this.stopping;
    if(this.running)return this.connectionWork;
    this.running=true;this.failures=0;this.lastError=undefined;this.generation++;
    await this.begin();
  }

  stop():Promise<void> {
    if(this.stopping)return this.stopping;
    this.running=false;this.generation++;clearTimeout(this.retryTimer);this.retryTimer=undefined;
    this.detach();this.state='stopped';
    const work=(async()=>{
      await this.connectionWork;
      // Already accepted pages must finish durable collection before their caller closes its DB.
      while(this.callbacks.size)await Promise.all([...this.callbacks]);
    })().finally(()=>{if(this.stopping===work)this.stopping=undefined;});
    this.stopping=work;return work;
  }

  private active(generation:number,socket?:DebotSocket):boolean {
    return this.running&&generation===this.generation&&(!socket||socket===this.socket);
  }
  private detach():void {
    clearTimeout(this.authTimer);this.authTimer=undefined;
    const socket=this.socket;this.socket=undefined;this.connected=false;this.authorized=false;
    if(socket){socket.removeAllListeners();socket.disconnect();}
  }

  private begin():Promise<void> {
    if(this.connectionWork)return this.connectionWork;
    if(!this.running)return Promise.resolve();
    const generation=this.generation;
    const work=this.connect(generation).finally(()=>{if(this.connectionWork===work)this.connectionWork=undefined;});
    this.connectionWork=work;return work;
  }

  private async connect(generation:number):Promise<void> {
    this.state='connecting';
    if(this.attempts++)this.reconnects++;
    let session:Awaited<ReturnType<DebotStreamOptions['getSession']>>;
    try {
      // Refresh on every connection attempt; never retain a rejected token for retry.
      session=await this.options.getSession();
      if(!session||typeof session.subToken!=='string'||!session.subToken.trim()||session.subToken.length>16_384||
        /[\r\n\u0000]/.test(session.subToken)||session.cookieHeader!==undefined&&
        (typeof session.cookieHeader!=='string'||session.cookieHeader.length>16_384||/[\r\n\u0000]/.test(session.cookieHeader)))
        throw new DebotSessionError('DEBOT_SESSION_FILE_INVALID');
    } catch(error) {
      if(this.active(generation)) {
        const reason=error instanceof DebotSessionError?error.reason:undefined;
        if(reason&&['DEBOT_SESSION_FILE_MISSING','DEBOT_SESSION_FILE_PERMISSIONS','DEBOT_SESSION_FILE_INVALID',
          'DEBOT_SESSION_FILE_TOO_LARGE','DEBOT_SESSION_FILE_UNREADABLE','DEBOT_SESSION_AUTH_REQUIRED'].includes(reason))
          this.rejectAuthorization(reason);
        else {
          const transient=reason&&['DEBOT_SESSION_REQUEST_TIMEOUT','DEBOT_SESSION_REQUEST_FAILED','DEBOT_SESSION_HTTP_ERROR',
            'DEBOT_SESSION_RATE_LIMITED','DEBOT_SESSION_FILE_CHANGED','DEBOT_SESSION_RESPONSE_INVALID',
            'DEBOT_SESSION_RESPONSE_TOO_LARGE'].includes(reason)?reason:'DEBOT_STREAM_SESSION_FAILED';
          this.retry(transient,'error',transient==='DEBOT_SESSION_RATE_LIMITED'?60_000:0);
        }
      }
      return;
    }
    if(!this.active(generation))return;
    try {
      const socket=(this.options.socketFactory??((url,options)=>io(url,options)))('wss://debot.ai',{
        path:'/portal-ws',transports:['websocket'],query:{bid:String(randomInt(100000,1000000))},timeout:5000,
        autoConnect:false,forceNew:true,reconnection:false,autoUnref:true,
        ...(session.cookieHeader?{extraHeaders:{Cookie:session.cookieHeader}}:{})});
      this.socket=socket;
      socket.on('connect',()=>{
        if(!this.active(generation,socket))return;
        this.connected=true;this.authorized=false;this.state='authorizing';
        clearTimeout(this.authTimer);
        this.authTimer=setTimeout(()=>{
          if(this.active(generation,socket)&&!this.authorized)this.retry('DEBOT_STREAM_AUTH_TIMEOUT','error');
        },AUTH_TIMEOUT_MS);this.authTimer.unref();
        socket.emit('authorization',session.subToken);
      });
      socket.on('authorization',(result:unknown)=>{
        if(!this.active(generation,socket)||!this.connected)return;
        if(result!=='success'){this.rejectAuthorization('DEBOT_STREAM_AUTH_REJECTED');return;}
        if(this.authorized)return;
        clearTimeout(this.authTimer);this.authTimer=undefined;
        this.authorized=true;this.state='live';this.lastError=undefined;this.failures=0;
        this.lastAuthorizedAt=this.now().toISOString();
        socket.emit('subscribe',...this.chains.map(chain=>CHANNELS[chain]));
        if(this.options.onAuthorized)this.track(this.options.onAuthorized,'DEBOT_STREAM_SYNC_FAILED');
      });
      socket.on('community-signal-channel-new-notification',(raw:unknown)=>{
        if(!this.active(generation,socket)||!this.authorized)return;
        let page:NormalizedDebotSignals;
        const observedAt=this.now();
        try {page=normalizeDebotSignalPush(raw,observedAt);}
        catch {this.lastError='DEBOT_STREAM_MESSAGE_INVALID';this.state='error';return;}
        if(page.observations.some(item=>!this.chains.includes(item.signal.token.chain))) {
          this.lastError='DEBOT_STREAM_CHAIN_NOT_SUBSCRIBED';this.state='error';return;
        }
        if(page.reason){this.lastError='DEBOT_STREAM_MESSAGE_INVALID';this.state='error';}
        if(!page.observations.length)return;
        const eventTimes=page.observations.map(item=>Date.parse(item.signal.occurredAt));
        // Signed values expose any tolerated source clock skew instead of inventing zero latency.
        this.lastSignalDelayMs=observedAt.getTime()-Math.max(...eventTimes);
        this.maxSignalDelayMs=observedAt.getTime()-Math.min(...eventTimes);
        const delayed=this.maxSignalDelayMs>=30_000,sequence=++this.messageSequence;
        if(delayed&&!page.reason)this.lastError='DEBOT_STREAM_DELAYED';
        const accepted=page.observations.length;
        this.track(async()=>{
          await this.options.onPage(page);
          this.received+=accepted;
          const observed=observedAt.toISOString();
          if(!this.lastSignalAt||observed>this.lastSignalAt)this.lastSignalAt=observed;
          if(this.active(generation,socket)&&sequence===this.messageSequence&&!page.reason) {
            this.state='live';this.lastError=delayed?'DEBOT_STREAM_DELAYED':undefined;
          }
        },'DEBOT_STREAM_CAPTURE_FAILED');
      });
      socket.on('disconnect',()=>{if(this.active(generation,socket))this.retry('DEBOT_STREAM_DISCONNECTED','disconnected');});
      socket.on('connect_error',()=>{if(this.active(generation,socket))this.retry('DEBOT_STREAM_CONNECT_FAILED','error');});
      socket.on('error',()=>{if(this.active(generation,socket))this.retry('DEBOT_STREAM_TRANSPORT_ERROR','error');});
      socket.connect();
    } catch {if(this.active(generation))this.retry('DEBOT_STREAM_CONNECT_FAILED','error');}
  }

  private track(callback:()=>unknown|Promise<unknown>,failure:string):void {
    if(this.callbacks.size>=MAX_CALLBACKS){this.retry('DEBOT_STREAM_CAPTURE_BACKLOG','error');return;}
    let work:Promise<void>;
    work=(async()=>{
      try {await callback();}
      catch {if(this.running){this.lastError=failure;this.state='error';}}
    })().finally(()=>this.callbacks.delete(work));
    this.callbacks.add(work);
  }

  private rejectAuthorization(reason:string):void {
    this.running=false;this.generation++;clearTimeout(this.retryTimer);this.retryTimer=undefined;
    this.detach();this.state='auth_required';this.lastError=reason;
  }
  private retry(reason:string,state:'disconnected'|'error',minimumDelay=0):void {
    if(!this.running)return;
    this.detach();this.state=state;this.lastError=reason;
    if(this.retryTimer)return;
    const generation=this.generation,delay=Math.max(minimumDelay,Math.min(60_000,1000*2**Math.min(this.failures++,6)));
    this.retryTimer=setTimeout(()=>{
      this.retryTimer=undefined;
      if(this.active(generation))void this.begin();
    },delay);this.retryTimer.unref();
  }
}
