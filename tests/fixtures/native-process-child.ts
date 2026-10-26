import {appendFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {OrderStore} from '../../src/orders.js';
import {runNativeProcessWorker,type NativeWorkerRuntime} from '../../src/native-solana/process-worker-core.js';
import type {NativePositionState} from '../../src/native-solana/positions.js';

if(process.env.NATIVE_PROCESS_TEST_ONLY!=='1'||!process.send)throw Error('TEST_FIXTURE_ONLY');
const worker=runNativeProcessWorker({
  onMessage:listener=>process.on('message',listener),onDisconnect:listener=>process.once('disconnect',listener),
  send:message=>{if(!process.send||!process.connected)return false;process.send(message);return true;},exit:code=>process.exit(code),
},(config,enqueue)=>{
  const orders=new OrderStore(config.ordersDatabase,{busyTimeoutMs:5}),dir=dirname(config.ordersDatabase);let timer:ReturnType<typeof setInterval>|undefined;
  const fake={
    start(){timer=setInterval(()=>{
      appendFileSync(join(dir,'ticks'),Date.now()+'\n');
      if(process.env.NATIVE_PROCESS_FAKE_WRITE_PROBE==='1'){
        const order=orders.list(1)[0];if(order){const started=performance.now();
          try{orders.update(order.id,['prepared'],{details:{...order.details,probeAt:Date.now()}});}
          catch{appendFileSync(join(dir,'write-busy'),(performance.now()-started)+'\n');}
        }
      }
    },20);enqueue({key:'durable-test-notice',text:'Fixture notice'});},
    async stop(){clearInterval(timer);},readiness:()=>({ready:true}),
    status:()=>({provider:'pump_native',running:true,readiness:{ready:true},stream:{connected:true},protection:{active:1}}),
    get(orderId:string){const order=orders.get(orderId);return order?{
      buy:{orderId,wallet:order.wallet,mint:order.tokenAddress,tokenDecimals:6},state:'active',revision:1,
    } as NativePositionState:undefined;},
    async execute(order:any,beforeBroadcast:()=>Promise<void>){await beforeBroadcast();appendFileSync(join(dir,'executions'),order.id+'\n');return order;},
    createAction(orderId:string){appendFileSync(join(dir,'actions'),orderId+'\n');return 'fixture-'+orderId;},
    async submit(ref:string,percent:number){
      const delay=Number(process.env.NATIVE_PROCESS_FAKE_SUBMIT_DELAY_MS??0);
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));return {text:`accepted:${ref}:${percent}`};
    },
  } as unknown as NativeWorkerRuntime;
  return {orders,runtime:fake};
});
process.once('SIGTERM',()=>{void worker.stop();});
