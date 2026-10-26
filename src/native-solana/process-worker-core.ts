import {createHash,randomUUID} from 'node:crypto';
import type {OpeningOrder,OrderStore} from '../orders.js';
import type {NativeTradingRuntime} from './runtime.js';
import type {TradeNotificationEvent} from '../trade-notifications.js';
import {NativeProcessStore} from './process-store.js';
import {isProtocolMessage,safeProcessError,type NativeParentMessage,type NativeWorkerConfig,type NativeWorkerMessage} from './process-protocol.js';

export type NativeWorkerRuntime=Pick<NativeTradingRuntime,'start'|'stop'|'readiness'|'status'|'get'|'execute'|'createAction'|'submit'>;
export interface NativeWorkerChannel {
  onMessage(listener:(message:unknown)=>void):void;
  onDisconnect(listener:()=>void):void;
  send(message:NativeWorkerMessage):boolean;
  exit(code:number):void;
}
export interface NativeWorkerFactoryResult {
  runtime:NativeWorkerRuntime;orders:Pick<OrderStore,'get'|'activePositions'|'subscribe'|'close'>&Partial<Pick<OrderStore,'activeNativePositions'>>;
}

/** Private-channel worker protocol, separate from signer construction so tests cannot accidentally trade. */
export function runNativeProcessWorker(channel:NativeWorkerChannel,
  create:(config:NativeWorkerConfig,enqueue:(event:TradeNotificationEvent)=>boolean)=>NativeWorkerFactoryResult){
  let runtime:NativeWorkerRuntime|undefined,orders:NativeWorkerFactoryResult['orders']|undefined,store:NativeProcessStore|undefined;
  let stopped=false,initialized=false,snapshotTimer:ReturnType<typeof setInterval>|undefined,outboxTimer:ReturnType<typeof setInterval>|undefined;
  let snapshotSequence=0,snapshotWaiting=0,guardTimeout=5000,unsubscribe:(()=>void)|undefined;
  let snapshotClosed:string[]=[],bridgeError:string|undefined,initFingerprint:string|undefined;
  const tracked=new Set<string>(),guards=new Map<string,{resolve:()=>void;reject:(error:Error)=>void;deadline:number;timer:ReturnType<typeof setTimeout>}>();
  const dirtyOrders=new Set<string>();
  const executions=new Map<string,Promise<OpeningOrder>>();
  const noticeSent=new Map<string,number>(),orderSent=new Map<string,number>();
  const send=(message:NativeWorkerMessage)=>{try{return channel.send(message);}catch{return false;}};
  const acknowledge=(write:()=>void)=>{
    try{write();return true;}catch{bridgeError='NATIVE_WORKER_OUTBOX_UNAVAILABLE';send({kind:'fatal',error:bridgeError});return false;}
  };
  const pump=()=>{
    if(stopped||!store)return;
    try{
      const now=Date.now();
      for(const orderId of dirtyOrders){store.changed(orderId);dirtyOrders.delete(orderId);}
      if(bridgeError)store.verifyWritable();
      for(const event of store.notices())if(now-(noticeSent.get(event.key)??0)>=2000&&send({kind:'notice',event}))noticeSent.set(event.key,now);
      for(const event of store.changedOrders()){
        const key=event.orderId+':'+event.version;
        if(now-(orderSent.get(key)??0)>=2000&&send({kind:'order',...event}))orderSent.set(key,now);
      }
      bridgeError=undefined;
    }catch{bridgeError='NATIVE_WORKER_OUTBOX_UNAVAILABLE';send({kind:'fatal',error:bridgeError});}
  };
  const snapshot=()=>{
    if(stopped||!runtime||snapshotWaiting)return;
    try{
      const positions=[...tracked].map(id=>runtime!.get(id)).filter((p):p is NonNullable<typeof p>=>!!p);
      snapshotWaiting=++snapshotSequence;
      snapshotClosed=positions.filter(p=>p.state==='closed').map(p=>p.buy.orderId);
      const status=runtime.status();
      if(!send({kind:'snapshot',value:{at:Date.now(),sequence:snapshotSequence,pid:process.pid,
        status:bridgeError?{...status,readiness:{ready:false,reason:bridgeError}}:status,positions}}))snapshotWaiting=0;
    }catch{send({kind:'fatal',error:'NATIVE_WORKER_SNAPSHOT_FAILED'});}
  };
  const stop=async()=>{
    if(stopped)return;stopped=true;clearInterval(snapshotTimer);clearInterval(outboxTimer);unsubscribe?.();
    for(const guard of guards.values()){clearTimeout(guard.timer);guard.reject(Error('NATIVE_PROTECTION_STOPPED'));}guards.clear();
    const deadline=setTimeout(()=>channel.exit(1),25000);deadline.unref();
    try{await runtime?.stop();await Promise.allSettled([...executions.values()]);store?.close();orders?.close();send({kind:'stopped'});}
    finally{clearTimeout(deadline);channel.exit(0);}
  };
  const guard=(callId:string):Promise<void>=>new Promise((resolve,reject)=>{
    if(stopped){reject(Error('NATIVE_PROTECTION_STOPPED'));return;}
    const id=randomUUID(),deadline=Date.now()+guardTimeout;
    const timer=setTimeout(()=>{guards.delete(id);reject(Error('NATIVE_GUARD_TIMEOUT'));},guardTimeout);
    guards.set(id,{resolve,reject,deadline,timer});
    if(!send({kind:'guard',id,callId,deadline})){clearTimeout(timer);guards.delete(id);reject(Error('NATIVE_PARENT_UNAVAILABLE'));}
  });
  const onCall=async(message:Extract<NativeParentMessage,{kind:'call'}>)=>{
    if(stopped||!runtime||!orders||!store)throw Error('NATIVE_WORKER_NOT_READY');
    if(message.method==='execute'){
      if(bridgeError)throw Error(bridgeError);
      const order=orders.get(message.orderId);if(!order||order.details.executionProvider!=='pump_native')throw Error('NATIVE_ORDER_MISSING');
      let flight=executions.get(order.id);
      if(!flight){
        const ready=runtime.readiness();if(!ready.ready)throw Error(ready.reason??'NATIVE_WORKER_NOT_READY');
        tracked.add(order.id);flight=runtime.execute(order,()=>guard(message.id));executions.set(order.id,flight);
        void flight.finally(()=>executions.delete(order.id)).catch(()=>{});
      }
      return flight;
    }
    if(message.method==='submit'){
      const action=store.action(message.ref);if(!action||action.expires<Date.now()||!Number.isSafeInteger(message.percent)||message.percent<1||message.percent>100)
        throw Error('NATIVE_SELL_BUTTON_EXPIRED');
      let nativeRef=action.nativeRef;
      if(!nativeRef){nativeRef=runtime.createAction(action.orderId);store.mapAction(message.ref,nativeRef);}
      return runtime.submit(nativeRef,message.percent);
    }
    throw Error('NATIVE_WORKER_METHOD_INVALID');
  };
  channel.onMessage(raw=>{
    if(!isProtocolMessage(raw))return;const message=raw as NativeParentMessage;
    if(message.kind==='stop'){void stop();return;}
    if(stopped)return;
    try{
      if(message.kind==='init'){
        const fingerprint=createHash('sha256').update(JSON.stringify(message)).digest('hex');
        if(initialized){if(fingerprint===initFingerprint)return;throw Error('NATIVE_WORKER_ALREADY_INITIALIZED');}
        initialized=true;initFingerprint=fingerprint;
        if(!Number.isSafeInteger(message.guardTimeoutMs)||message.guardTimeoutMs<50||message.guardTimeoutMs>30000)throw Error('NATIVE_GUARD_OPTIONS_INVALID');
        guardTimeout=message.guardTimeoutMs;store=new NativeProcessStore(message.storePath);
        const created=create(message.config,event=>{
          try{return store!.enqueue(event);}catch(error){bridgeError='NATIVE_WORKER_OUTBOX_UNAVAILABLE';throw error;}
        });runtime=created.runtime;orders=created.orders;
        const activeNative=orders.activeNativePositions?.()??orders.activePositions().filter(order=>order.details.executionProvider==='pump_native');
        for(const order of activeNative){tracked.add(order.id);store.changed(order.id);}
        unsubscribe=orders.subscribe(order=>{if(order.details.executionProvider==='pump_native'){
          tracked.add(order.id);dirtyOrders.add(order.id);
          try{store!.changed(order.id);dirtyOrders.delete(order.id);}catch{bridgeError='NATIVE_WORKER_OUTBOX_UNAVAILABLE';}
        }});
        runtime.start();snapshotTimer=setInterval(snapshot,250);outboxTimer=setInterval(pump,1000);pump();snapshot();return;
      }
      if(message.kind==='snapshot_ack'){
        if(message.sequence===snapshotWaiting){snapshotWaiting=0;for(const id of snapshotClosed)tracked.delete(id);snapshotClosed=[];}return;
      }
      if(message.kind==='notice_ack'){if(acknowledge(()=>store?.ackNotice(message.key)))noticeSent.delete(message.key);return;}
      if(message.kind==='order_ack'){
        if(acknowledge(()=>store?.ackOrder(message.orderId,message.version)))orderSent.delete(message.orderId+':'+message.version);return;
      }
      if(message.kind==='guard_result'){
        const pending=guards.get(message.id);if(!pending)return;guards.delete(message.id);clearTimeout(pending.timer);
        if(Date.now()>=pending.deadline)pending.reject(Error('NATIVE_GUARD_TIMEOUT'));
        else if(message.ok)pending.resolve();else pending.reject(Error(safeProcessError(new Error(message.error??''),'NATIVE_GUARD_REJECTED')));return;
      }
      if(message.kind==='call')void onCall(message).then(value=>send({kind:'result',id:message.id,ok:true,value}),
        error=>send({kind:'result',id:message.id,ok:false,error:safeProcessError(error)}));
    }catch(error){send({kind:'fatal',error:safeProcessError(error)});void stop();}
  });
  channel.onDisconnect(()=>{void stop();});
  return {stop,snapshot,pump};
}
