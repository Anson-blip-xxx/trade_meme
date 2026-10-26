import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {SourceCorroboration} from './source-corroboration.js';
import {registerMemeSignal} from './meme-observer.js';
import {WalletHistory} from './wallet-history.js';
import type {SourceObservationResult,SourceObservationRunnerOptions,SourceResearchObservation} from './source-observation-runner.js';
import type {AveSignalObservation} from './providers/ave-signals.js';
import {createHash} from 'node:crypto';

const options=workerData as SourceObservationRunnerOptions;
const source=options.source?new SourceCorroboration(options.source.database,
  {maxBytes:options.source.maxBytes,maxEvents:options.source.maxEvents}):undefined;
const memeDb=options.meme?new DatabaseSync(options.meme.database):undefined;
if(memeDb)memeDb.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
const wallet=options.wallet?new WalletHistory(options.wallet.database,{maxBytes:options.wallet.maxBytes}):undefined;
let stopping=false,tail=Promise.resolve();

async function observe(observation:SourceResearchObservation):Promise<SourceObservationResult>{
  if(options.testDelayMs)await new Promise(resolve=>setTimeout(resolve,options.testDelayMs));
  const result:SourceObservationResult={},signal=observation.signal;
  if(source){
    const recorded=source.record(signal,observation.observedAt,{name:observation.name,
      sourceUrl:signal.source==='ave'?'https://ave.ai/smart':'https://debot.ai/',
      deliveryKey:createHash('sha256').update(JSON.stringify(observation)).digest('hex')});
    if(!recorded.accepted)result.sourceError=recorded.reason??'SOURCE_EVIDENCE_CAPTURE_FAILED';
  }
  if(memeDb&&options.meme)try {
    registerMemeSignal(memeDb,signal,observation.observedAt,{now:new Date(),windowMs:options.meme.activeWindowSec*1000,
      chains:options.meme.chains,display:{name:observation.name,symbol:observation.symbol}});
  }catch{result.memeError='MEME_SIGNAL_CAPTURE_FAILED';}
  if(wallet&&signal.source==='ave')try {
    const ave=observation as AveSignalObservation;
    const captured=wallet.captureVendorNominations(signal.token,{source:'ave',eventId:signal.sourceEventId,
      occurredAt:signal.occurredAt,observedAt:observation.observedAt,wallets:ave.vendorWallets??[]});
    result.nominationError=captured.reason;
  }catch{result.nominationError='WALLET_NOMINATION_CAPTURE_FAILED';}
  return result;
}

parentPort!.on('message',(message:{type?:string;id?:number;observation?:SourceResearchObservation})=>{
  if(message?.type==='stop'){
    stopping=true;tail.finally(()=>{source?.close();memeDb?.close();wallet?.close();parentPort!.close();});return;
  }
  if(stopping||message?.type!=='observe'||!Number.isSafeInteger(message.id)||!message.observation)return;
  const {id,observation}=message;
  tail=tail.then(async()=>{
    try{parentPort!.postMessage({type:'done',id,result:await observe(observation)});}
    catch{parentPort!.postMessage({type:'failed',id});}
  });
});
parentPort!.postMessage({type:'ready'});
