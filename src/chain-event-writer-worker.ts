import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {ChainStreamStore,type ChainEvent} from './chain-stream-store.js';
import type {Chain} from './types.js';

interface Options {database:string;maxBytes:number;busyTimeoutMs:number}
interface BatchMessage {type:'batch';batchId:number;events:ChainEvent[];incompleteReasons:string[]}

const options=workerData as Options;let store:ChainStreamStore|undefined,stopping=false,closed=false;
const close=()=>{if(closed)return;closed=true;try{store?.close();}catch{}store=undefined;parentPort!.close();};
const totals=()=>{const value=store!.stats();return {liveEvents:value.liveEvents,liveEventsByChain:value.liveEventsByChain};};

const run=(message:BatchMessage)=>{
  const started=performance.now(),failed:{index:number;reason:string;retryable:boolean}[]=[],markerFailures:string[]=[];
  let completed=0,inserted=0;const insertedByChain:Partial<Record<Chain,number>>={};
  for(const reason of message.incompleteReasons)try{store!.markIncomplete(reason);}catch{markerFailures.push(reason);}
  for(let index=0;index<message.events.length;index++)try {const event=message.events[index],changed=store!.record(event);
    completed++;if(changed){inserted++;insertedByChain[event.chain]=(insertedByChain[event.chain]??0)+1;}
  } catch(error){const capacity=error instanceof Error&&/CHAIN_STORE_CAPACITY/.test(error.message);
    failed.push({index,reason:capacity?'CHAIN_EVENT_WRITER_CAPACITY':'CHAIN_EVENT_WRITER_WRITE_FAILED',retryable:!capacity});}
  parentPort!.postMessage({type:'result',batchId:message.batchId,completed,inserted,insertedByChain,failed,markerFailures,totals:totals(),
    elapsedMs:Math.max(0,performance.now()-started)});
};

try {store=new ChainStreamStore(options.database,options.maxBytes,{busyTimeoutMs:options.busyTimeoutMs});parentPort!.on('message',(message:BatchMessage|'stop')=>{
  if(message==='stop'){stopping=true;close();return;}
  if(!stopping&&message?.type==='batch')run(message);
  });parentPort!.postMessage({type:'ready',totals:totals()});}catch{parentPort!.postMessage({type:'fatal',error:'CHAIN_EVENT_WRITER_STORE_OPEN_FAILED'});close();}
