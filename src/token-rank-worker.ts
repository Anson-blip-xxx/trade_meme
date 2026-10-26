import {parentPort,workerData} from 'node:worker_threads';
import {TokenRankResearch} from './token-rank-research.js';

// Only persisted local evidence is exposed to this worker. No API credentials,
// vendor queries or trade submission are available through the research engine.
const {intervalSec,batchSize,livePriority:initialLivePriority,...options}=workerData;
const engine=new TokenRankResearch(options);
let stopping=false,livePriority=initialLivePriority===true,timer:ReturnType<typeof setTimeout>|undefined;
const schedule=(delay=intervalSec*1000)=>{
  clearTimeout(timer);timer=undefined;
  if(!stopping&&!livePriority)timer=setTimeout(()=>{timer=undefined;run();},delay);
};
const run=()=>{
  if(stopping||livePriority)return;parentPort!.postMessage({type:'working'});
  // runBatch already returns the status captured after the committed batch. Reusing it
  // avoids immediately repeating aggregate reads against the multi-gigabyte database.
  try{const status=engine.runBatch(batchSize);parentPort!.postMessage({type:'status',status});}
  catch{parentPort!.postMessage({type:'failed'});}
  schedule();
};
parentPort!.on('message',message=>{
  if(message==='stop'){
    stopping=true;clearTimeout(timer);timer=undefined;engine.close();parentPort!.close();return;
  }
  if(message?.type==='live-priority'&&typeof message.active==='boolean'){
    livePriority=message.active;clearTimeout(timer);timer=undefined;
    parentPort!.postMessage({type:'priority',livePriority});
    if(!livePriority)schedule(0);
  }
});
parentPort!.postMessage({type:'priority',livePriority});
if(!livePriority)run();
