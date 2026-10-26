import {readConfig} from '../config.js';
import {OrderStore} from '../orders.js';
import {NativeTradingRuntime} from './runtime.js';
import {runNativeProcessWorker} from './process-worker-core.js';

// This entry point is private: no HTTP listener, public API, console logging, or Telegram credentials in IPC.
if(!process.send)throw Error('NATIVE_WORKER_REQUIRES_PRIVATE_IPC');
const worker=runNativeProcessWorker({
  onMessage:listener=>process.on('message',listener),onDisconnect:listener=>process.once('disconnect',listener),
  send:message=>{if(!process.connected||!process.send)return false;process.send(message,()=>{});return true;},
  exit:code=>process.exit(code),
},(input,enqueue)=>{
  const config=readConfig();Object.assign(config,input);
  if(config.telegram&&input.summaryIntervalMs!==undefined)config.telegram={...config.telegram,summaryIntervalMs:input.summaryIntervalMs};
  // Main-process ledger writes must never hold the price/exit event loop for seconds.
  const orders=new OrderStore(config.ordersDatabase,{busyTimeoutMs:5});
  try{return {runtime:new NativeTradingRuntime(config,orders,enqueue),orders};}
  catch(error){orders.close();throw error;}
});
process.once('SIGTERM',()=>{void worker.stop();});
process.once('SIGINT',()=>{void worker.stop();});
