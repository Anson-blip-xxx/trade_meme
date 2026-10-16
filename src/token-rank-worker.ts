import {parentPort,workerData} from 'node:worker_threads';
import {TokenRankResearch} from './token-rank-research.js';

// Only persisted local evidence is exposed to this worker. No API credentials,
// vendor queries or trade submission are available through the research engine.
const {intervalSec,batchSize,...options}=workerData;
const engine=new TokenRankResearch(options);
let stopping=false,timer:ReturnType<typeof setTimeout>|undefined;
const run=()=>{
  if(stopping)return;parentPort!.postMessage({type:'working'});
  try{engine.runBatch(batchSize);parentPort!.postMessage({type:'status',status:engine.status()});}
  catch{parentPort!.postMessage({type:'failed'});}
  if(!stopping)timer=setTimeout(run,intervalSec*1000);
};
parentPort!.on('message',message=>{
  if(message!=='stop')return;stopping=true;clearTimeout(timer);engine.close();parentPort!.close();
});
run();
