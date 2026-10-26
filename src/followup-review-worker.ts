import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {SignalFollowup} from './signal-followup.js';

interface Options {database:string;intervalMs:number;}
const options=workerData as Options,db=new DatabaseSync(options.database);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
const followup=new SignalFollowup(db);
let stopping=false,timer:ReturnType<typeof setTimeout>|undefined;

const run=()=>{
  if(stopping)return;
  const at=new Date(),started=performance.now();parentPort!.postMessage({type:'working',at:at.toISOString()});
  try {
    followup.refresh(at);
    parentPort!.postMessage({type:'status',completedAt:new Date().toISOString(),elapsedMs:Math.max(0,Math.round(performance.now()-started))});
  }catch{parentPort!.postMessage({type:'failed'});}
  if(!stopping){timer=setTimeout(run,options.intervalMs);timer.unref();}
};

parentPort!.on('message',message=>{
  if(message!=='stop')return;stopping=true;clearTimeout(timer);db.close();parentPort!.close();
});
run();
