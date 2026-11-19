import {parentPort,workerData} from 'node:worker_threads';
import {WalletHistory} from './wallet-history.js';
import type {WalletMarketCandidateWrite,WalletMarketCandidateWriterOptions} from './wallet-market-candidate-writer.js';

const options=workerData as WalletMarketCandidateWriterOptions;
let history:WalletHistory;
try {history=new WalletHistory(options.database,{maxBytes:options.maxBytes});}
catch {parentPort!.postMessage({type:'fatal'});parentPort!.close();throw new Error('WALLET_MARKET_CANDIDATE_STORE_OPEN_FAILED');}

let stopping=false,tail=Promise.resolve();
const capture=async(id:number,write:WalletMarketCandidateWrite)=>{
  const started=Date.now();
  if(options.testDelayMs)await new Promise(resolve=>setTimeout(resolve,options.testDelayMs));
  try {const accepted=history.captureMarketCandidate(write.token,write.context);
    parentPort!.postMessage({type:'result',id,accepted,elapsedMs:Date.now()-started,
      ...(accepted?{}:{error:'WALLET_MARKET_CANDIDATE_WRITE_REJECTED'})});
  }catch(error){const message=error instanceof Error?error.message:'',capacity=/(SQLITE_FULL|database or disk is full)/i.test(message),
    busy=/(SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked|database is busy)/i.test(message);
    parentPort!.postMessage({type:'result',id,accepted:false,elapsedMs:Date.now()-started,
      error:capacity?'WALLET_MARKET_CANDIDATE_CAPACITY_REACHED':busy?'WALLET_MARKET_CANDIDATE_STORE_BUSY':
        'WALLET_MARKET_CANDIDATE_WRITE_FAILED'});}
};

parentPort!.on('message',(message:{type?:string;id?:number;write?:WalletMarketCandidateWrite})=>{
  if(message?.type==='stop'){
    stopping=true;tail.finally(()=>{history.close();parentPort!.close();});return;
  }
  if(stopping||message?.type!=='capture'||!Number.isSafeInteger(message.id)||!message.write)return;
  const id=message.id!,write=message.write;tail=tail.then(()=>capture(id,write));
});
parentPort!.postMessage({type:'ready'});
