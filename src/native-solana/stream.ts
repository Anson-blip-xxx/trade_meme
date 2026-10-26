import {PublicKey,type AccountInfo} from '@solana/web3.js';

export interface NativeStreamAccountUpdate {
  address:string;info:AccountInfo<Buffer>|null;slot:number;receivedAtMs:number;
  kind:'account'|'wallet';generation:number;
}
export interface NativeStreamHead {slot:number;receivedAtMs:number;generation:number}
export interface NativeStreamReset {
  generation:number;reason:'connect'|'disconnect'|'head_stale'|'accounts_removed';accounts?:string[];
}
export interface NativeAccountStreamOptions {
  maxHeadAgeMs?:number;reconnectHeadAgeMs?:number;watchdogIntervalMs?:number;now?:()=>number;
}
const tokenPrograms=['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
type RequestInput={kind:'subscribe';label:string}|{kind:'unsubscribe';label:string;subscription:number};
type Request=({kind:'subscribe';label:string;sentAt:number})|{kind:'unsubscribe';label:string;subscription:number};
interface SubscriptionAttempt {count:number;lastSentAt:number;failed:boolean;}
const validSlot=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
function publicKey(value:unknown):PublicKey {
  if(typeof value!=='string')throw Error('NATIVE_STREAM_PUBLIC_KEY_INVALID');
  const key=new PublicKey(value);if(key.toBase58()!==value)throw Error('NATIVE_STREAM_PUBLIC_KEY_INVALID');return key;
}
function accountInfo(value:unknown):AccountInfo<Buffer>|null {
  if(value===null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('NATIVE_STREAM_ACCOUNT_INVALID');
  const v=value as Record<string,unknown>,data=v.data;
  if(!Array.isArray(data)||data.length!==2||data[1]!=='base64'||typeof data[0]!=='string'||data[0].length>900_000||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data[0])||
    typeof v.executable!=='boolean'||!Number.isSafeInteger(v.lamports)||Number(v.lamports)<0||
    v.rentEpoch!==undefined&&(typeof v.rentEpoch!=='number'||!Number.isFinite(v.rentEpoch)||!Number.isInteger(v.rentEpoch)||v.rentEpoch<0))
    throw Error('NATIVE_STREAM_ACCOUNT_INVALID');
  const decoded=Buffer.from(data[0],'base64');if(decoded.toString('base64')!==data[0])throw Error('NATIVE_STREAM_ACCOUNT_INVALID');
  return {owner:publicKey(v.owner),data:decoded,executable:v.executable,lamports:v.lamports as number,
    ...(v.rentEpoch!==undefined?{rentEpoch:v.rentEpoch as number}:{})};
}

/** Account bytes are delivered synchronously; the consumer can price without another RPC request. */
export class NativeAccountStream {
  private socket?:WebSocket;private timer?:ReturnType<typeof setInterval>;private next=0;private stopped=true;
  private wanted=new Set<string>();private requests=new Map<number,Request>();private subscriptions=new Map<number,string>();
  private attempts=new Map<string,SubscriptionAttempt>();
  private acknowledged=new Set<string>();private lastSlotAt?:number;private lastHeadSlot?:number;private retryAt=0;private openedAt=0;
  private accountSlots=new Map<string,number>();private knownWalletAccounts=new Map<string,string>();private generation=0;private staleReset=false;
  private published='';private readonly now:()=>number;private readonly maxHeadAgeMs:number;private readonly reconnectHeadAgeMs:number;
  private readonly watchdogIntervalMs:number;private readonly walletBytes:Buffer;
  constructor(private url:string,private wallet:string,private callbacks:{
    dirty:(account:string)=>void;state:(value:{connected:boolean;subscribedAccounts:string[]})=>void;
    account?:(value:NativeStreamAccountUpdate)=>void;head?:(value:NativeStreamHead)=>void;reset?:(value:NativeStreamReset)=>void;
  },private socketFactory:(url:string)=>WebSocket=url=>new WebSocket(url),options:NativeAccountStreamOptions={}){
    const u=new URL(url);if(u.protocol!=='wss:'||u.username||u.password||u.hash)throw Error('NATIVE_WS_URL_INVALID');
    this.walletBytes=publicKey(wallet).toBuffer();this.now=options.now??Date.now;
    this.maxHeadAgeMs=options.maxHeadAgeMs??1500;this.reconnectHeadAgeMs=options.reconnectHeadAgeMs??20_000;
    this.watchdogIntervalMs=options.watchdogIntervalMs??200;
    if(!Number.isFinite(this.maxHeadAgeMs)||this.maxHeadAgeMs<100||!Number.isFinite(this.reconnectHeadAgeMs)||
      this.reconnectHeadAgeMs<=this.maxHeadAgeMs||!Number.isFinite(this.watchdogIntervalMs)||this.watchdogIntervalMs<10||
      this.watchdogIntervalMs>this.maxHeadAgeMs)throw Error('NATIVE_STREAM_TIMING_INVALID');
  }
  setAccounts(accounts:string[]){
    const next=new Set(accounts);if(next.size>120)throw Error('NATIVE_SUBSCRIPTION_LIMIT');for(const a of next)publicKey(a);
    const removed=[...this.wanted].filter(a=>!next.has(a)),added=[...next].filter(a=>!this.wanted.has(a));
    if(!removed.length&&!added.length)return;this.wanted=next;
    for(const a of removed){this.acknowledged.delete(a);this.accountSlots.delete(a);this.attempts.delete(a);
      for(const [subscription,label]of this.subscriptions)if(label===a){this.subscriptions.delete(subscription);this.unsubscribe(subscription,label);}}
    // Removing one position must not interrupt the remaining positions' subscriptions.
    if(removed.length)this.callbacks.reset?.({generation:this.generation,reason:'accounts_removed',accounts:removed});
    if(this.socket?.readyState===1)for(const a of added)this.subscribeAccount(a);
    this.publish();
  }
  start(){if(!this.stopped)return;this.stopped=false;this.connect();this.timer=setInterval(()=>this.watchdog(),this.watchdogIntervalMs);this.timer.unref();}
  status(){const age=this.lastSlotAt===undefined?undefined:Math.max(0,this.now()-this.lastSlotAt);
    const transportHealthy=this.socket?.readyState===1&&this.acknowledged.has('@slots')&&
      tokenPrograms.every(p=>this.acknowledged.has('@wallet:'+p))&&age!==undefined&&age<=this.maxHeadAgeMs;
    const pending=[...this.wanted].filter(a=>!this.acknowledged.has(a)),labels=this.requiredLabels().filter(a=>!this.acknowledged.has(a));
    const failedAccounts=pending.filter(a=>this.attempts.get(a)?.failed).length,failedSubscriptions=labels.filter(a=>this.attempts.get(a)?.failed).length;
    return {transportHealthy,connected:transportHealthy&&[...this.wanted].every(a=>this.acknowledged.has(a)),
      subscribedAccounts:[...this.acknowledged].filter(a=>!a.startsWith('@')&&this.wanted.has(a)),requestedAccounts:this.wanted.size,
      pendingAccounts:pending.length-failedAccounts,failedAccounts,pendingSubscriptions:labels.length-failedSubscriptions,failedSubscriptions,
      generation:this.generation,lastHeadSlot:this.lastHeadSlot,headAgeMs:age};}
  /** A new position's pending ACK must not suspend already subscribed positions. */
  isSubscribed(accounts:string[]):boolean {return this.status().transportHealthy&&accounts.every(address=>this.wanted.has(address)&&this.acknowledged.has(address));}
  private publish(){const s=this.status(),signature=JSON.stringify([s.connected,s.transportHealthy,s.pendingSubscriptions,s.failedSubscriptions,[...s.subscribedAccounts].sort()]);
    if(signature===this.published)return;this.published=signature;this.callbacks.state({connected:s.connected,subscribedAccounts:s.subscribedAccounts});}
  private reset(reason:NativeStreamReset['reason']){this.generation++;
    if(reason!=='head_stale'){this.accountSlots.clear();this.knownWalletAccounts.clear();}
    this.callbacks.reset?.({generation:this.generation,reason});}
  private invalidateStaleHead(){const age=this.now()-(this.lastSlotAt??this.openedAt);
    if(this.socket&&age>this.maxHeadAgeMs&&!this.staleReset){this.staleReset=true;this.reset('head_stale');}}
  private watchdog(){if(this.stopped)return;const now=this.now(),age=now-(this.lastSlotAt??this.openedAt);
    this.invalidateStaleHead();
    if(this.socket&&age>this.reconnectHeadAgeMs){this.disconnect();this.retryAt=now+2000;}
    if(!this.socket&&now>=this.retryAt)this.connect();this.retryUnacknowledged();this.publish();}
  private requiredLabels():string[]{return ['@slots',...this.wanted,...tokenPrograms.map(program=>'@wallet:'+program)];}
  private retryUnacknowledged(){if(this.socket?.readyState!==1)return;
    for(const label of this.requiredLabels()){
      if(this.acknowledged.has(label))continue;
      const attempt=this.attempts.get(label);if(!attempt){this.subscribe(label);continue;}
      if(attempt.failed||this.now()-attempt.lastSentAt<3000)continue;
      if(attempt.count>=3){attempt.failed=true;continue;}
      this.sendSubscription(label);
    }
  }
  private request(method:string,params:unknown[],request:RequestInput){
    if(this.socket?.readyState!==1)return;
    if(this.requests.size>=1024){this.disconnect();this.retryAt=this.now()+3000;return;}
    const id=++this.next;
    if(request.kind==='subscribe'){
      const sentAt=this.now(),prior=this.attempts.get(request.label);
      this.attempts.set(request.label,{count:(prior?.count??0)+1,lastSentAt:sentAt,failed:false});
      this.requests.set(id,{...request,sentAt});
    }else this.requests.set(id,request);
    try{this.socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));}catch{this.disconnect();this.retryAt=this.now()+3000;}
  }
  private subscribe(label:string){
    if(this.acknowledged.has(label)||this.attempts.has(label))return;
    const pending=[...this.requests.values()].filter((r):r is Extract<Request,{kind:'subscribe'}>=>r.kind==='subscribe'&&r.label===label);
    if(pending.length){this.attempts.set(label,{count:Math.min(3,pending.length),lastSentAt:Math.max(...pending.map(r=>r.sentAt)),failed:false});return;}
    this.sendSubscription(label);
  }
  private subscribeAccount(account:string){this.subscribe(account);}
  private sendSubscription(label:string){
    if(label==='@slots')this.request('slotSubscribe',[],{kind:'subscribe',label});
    else if(label.startsWith('@wallet:'))this.request('programSubscribe',[label.slice('@wallet:'.length),{encoding:'base64',commitment:'confirmed',
      filters:[{memcmp:{offset:32,bytes:this.wallet}}]}],{kind:'subscribe',label});
    else this.request('accountSubscribe',[label,{encoding:'base64',commitment:'confirmed'}],{kind:'subscribe',label});
  }
  private unsubscribe(subscription:number,label:string){
    this.request(label==='@slots'?'slotUnsubscribe':label.startsWith('@wallet:')?'programUnsubscribe':'accountUnsubscribe',
      [subscription],{kind:'unsubscribe',label,subscription});
  }
  private connect(){
    if(this.stopped||this.socket)return;
    let ws:WebSocket;try{ws=this.socketFactory(this.url);}catch{this.retryAt=this.now()+5000;return;}
    this.socket=ws;this.openedAt=this.now();this.lastSlotAt=undefined;this.lastHeadSlot=undefined;this.staleReset=false;this.reset('connect');
    ws.addEventListener('open',()=>{
      if(this.socket!==ws)return;
      this.subscribe('@slots');
      for(const a of this.wanted)this.subscribeAccount(a);
      for(const program of tokenPrograms)this.subscribe('@wallet:'+program);
    });
    ws.addEventListener('message',event=>{
      if(this.socket!==ws||typeof event.data!=='string'||event.data.length>1_000_000)return;
      try{
        const m=JSON.parse(event.data);if(!m||typeof m!=='object'||Array.isArray(m)||m.jsonrpc!=='2.0')return;
        if(m.id!==undefined){if(!validSlot(m.id))return;const request=this.requests.get(m.id);if(!request)return;this.requests.delete(m.id);
          if(request.kind==='unsubscribe')return;
          // A missing/failed new subscription must not disconnect healthy positions.
          if(!validSlot(m.result)||m.error){const attempt=this.attempts.get(request.label);if(attempt&&attempt.count>=3)attempt.failed=true;this.publish();return;}
          const existingLabel=this.subscriptions.get(m.result);
          if(existingLabel!==undefined&&existingLabel!==request.label){this.disconnect();this.retryAt=this.now()+5000;return;}
          if(!request.label.startsWith('@')&&!this.wanted.has(request.label)){this.unsubscribe(m.result,request.label);return;}
          // Retries can return either the same subscription ID or another live ID.
          // Keep exactly one mapping per label; unsubscribe every surplus ID.
          if(this.acknowledged.has(request.label)){if(existingLabel!==request.label)this.unsubscribe(m.result,request.label);return;}
          this.subscriptions.set(m.result,request.label);this.acknowledged.add(request.label);this.publish();return;
        }
        if(!validSlot(m.params?.subscription))return;const label=this.subscriptions.get(m.params.subscription);if(!label)return;
        const result=m.params.result,receivedAtMs=this.now();
        if(label==='@slots'){
          if(m.method!=='slotNotification'||!validSlot(result?.slot)||!validSlot(result?.parent)||!validSlot(result?.root)||
            result.parent>result.slot||result.root>result.slot||this.lastHeadSlot!==undefined&&result.slot<=this.lastHeadSlot)return;
          // An arriving head must not hide a stale interval while the watchdog was delayed by the event loop.
          this.invalidateStaleHead();
          this.lastSlotAt=receivedAtMs;this.lastHeadSlot=result.slot;this.staleReset=false;
          this.callbacks.head?.({slot:result.slot,receivedAtMs,generation:this.generation});this.publish();return;
        }
        const kind=label.startsWith('@wallet:')?'wallet':'account';
        if(m.method!==(kind==='wallet'?'programNotification':'accountNotification')||!validSlot(result?.context?.slot))return;
        const slot=result.context.slot,address=kind==='wallet'?publicKey(result?.value?.pubkey).toBase58():label;
        if(kind==='account'&&!this.wanted.has(address))return;
        let info=accountInfo(kind==='wallet'?result?.value?.account:result?.value);
        if(kind==='wallet'){
          const expectedProgram=label.slice('@wallet:'.length),known=this.knownWalletAccounts.get(address)===expectedProgram;
          // Closing a token account may be encoded as a zero-lamport empty System
          // account rather than null. Only an account previously verified as ours
          // on this exact token-program subscription may become a deletion event.
          if(info&&known&&!info.executable&&info.lamports===0&&info.data.length===0&&info.owner.equals(PublicKey.default))info=null;
          if(info===null){if(!known)return;}
          else if(info.owner.toBase58()!==label.slice('@wallet:'.length)||info.data.length<165||
            !info.data.subarray(32,64).equals(this.walletBytes))return;
          this.knownWalletAccounts.set(address,expectedProgram);
        }else if(info&&tokenPrograms.includes(info.owner.toBase58())&&info.data.length>=165&&info.data.subarray(32,64).equals(this.walletBytes)){
          this.knownWalletAccounts.set(address,info.owner.toBase58());
        }
        this.invalidateStaleHead();
        const previous=this.accountSlots.get(address);if(previous!==undefined&&slot<previous)return;this.accountSlots.set(address,slot);
        this.callbacks.account?.({address,info,slot,receivedAtMs,kind,generation:this.generation});
        // Wallet program frames no longer invalidate every watched account (quadratic downstream work).
        if(kind==='account'||!this.callbacks.account)this.callbacks.dirty(address);
      }catch{/* Invalid or mismatched frames cannot refresh the head or invalidate unrelated accounts. */}
    });
    const lost=()=>{if(this.socket!==ws)return;this.disconnect();this.retryAt=this.now()+3000;};
    ws.addEventListener('error',lost);ws.addEventListener('close',lost);
  }
  private disconnect(){const old=this.socket;this.socket=undefined;this.requests.clear();this.subscriptions.clear();this.acknowledged.clear();this.attempts.clear();
    this.lastSlotAt=undefined;this.lastHeadSlot=undefined;if(old){this.reset('disconnect');try{old.close();}catch{}}this.publish();}
  stop(){this.stopped=true;clearInterval(this.timer);this.timer=undefined;this.disconnect();}
}
