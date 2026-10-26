import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {readRecentExitPressure} from './wallet-exit-pressure.js';
import type {WalletHistoryToken} from './wallet-history.js';

const db=new DatabaseSync((workerData as {database:string}).database,{readOnly:true});
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
let stopping=false;
parentPort!.on('message',(message:{type:string;id?:number;token?:WalletHistoryToken;sampleAt?:string})=>{
  if(message.type==='stop'){stopping=true;db.close();parentPort!.close();return;}
  if(stopping||message.type!=='read'||!message.id||!message.token||!message.sampleAt)return;
  try {parentPort!.postMessage({type:'result',id:message.id,token:message.token,sampleAt:message.sampleAt,
    pressure:readRecentExitPressure(db,message.token,message.sampleAt)});}
  catch {parentPort!.postMessage({type:'failed',id:message.id});}
});
