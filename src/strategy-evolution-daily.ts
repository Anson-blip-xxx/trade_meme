import {DatabaseSync} from 'node:sqlite';
import {assignStrategyArm,canonicalJson,type StrategyCandidate,type StrategyEpisodeResult} from './strategy-evolution.js';
import {StrategyEvolutionStore} from './strategy-evolution-store.js';
import {StrategyEvolutionSignalLedger,strategyEvolutionDatabasePath} from './strategy-evolution-signals.js';
import {ADAPTIVE_SHADOW_V5,stepAdaptiveExit,type AdaptiveExitState} from './adaptive-exit.js';
import {shadowReturn} from './exit-shadow-return.js';
import type {Chain} from './types.js';

const HORIZON_MS=6*60*60_000,TOLERANCE_MS=10*60_000,RETEST_COOLDOWN_MS=7*86400_000;
const QUOTE_ROUTE_VERSION='earliest-source-priority-v1';
const QUOTE_SOURCES=new Set(['chain_pool_sample','dexscreener_token_pairs_sample','ave_price_stream_sample',
  'gmgn_token_info_sample','debot_token_info_sample']);
const SOURCE_PRIORITY=new Map(['chain_pool_sample','dexscreener_token_pairs_sample','ave_price_stream_sample',
  'gmgn_token_info_sample','debot_token_info_sample'].map((source,index)=>[source,index]));
type Row=Record<string,unknown>;
const iso=(value:number)=>new Date(value).toISOString();
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);

function quoteResult(db:DatabaseSync,chain:Chain,address:string,triggerAt:string,matureAt:string,asOf:string):StrategyEpisodeResult {
  const invalid=(reason:string):StrategyEpisodeResult=>({status:'invalid',observedAt:matureAt,reason});
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meme_price_archive'").get())return invalid('PRICE_ARCHIVE_UNAVAILABLE');
  const rows=db.prepare(`SELECT observed_at,source,price_usd,pool_address FROM meme_price_archive
    WHERE chain=? AND address=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at,source LIMIT 20001`)
    .all(chain,address,triggerAt,iso(Math.min(Date.parse(asOf),Date.parse(matureAt)+TOLERANCE_MS))) as Row[];
  if(rows.length>20000)return invalid('PRICE_PATH_LIMIT_EXCEEDED');
  const baseline=rows.filter(row=>finite(row.price_usd)&&Number(row.price_usd)>0&&typeof row.pool_address==='string'&&
    Date.parse(String(row.observed_at))>=Date.parse(triggerAt)&&Date.parse(String(row.observed_at))-Date.parse(triggerAt)<=60_000)
    .sort((a,b)=>Date.parse(String(a.observed_at))-Date.parse(String(b.observed_at))||
      (SOURCE_PRIORITY.get(String(a.source))??99)-(SOURCE_PRIORITY.get(String(b.source))??99))[0];
  if(!baseline)return invalid('BASELINE_PRICE_UNAVAILABLE');
  const pool=String(baseline.pool_address),path=rows.filter(row=>row.pool_address===pool&&finite(row.price_usd)&&Number(row.price_usd)>0&&
    Date.parse(String(row.observed_at))>=Date.parse(String(baseline.observed_at))&&Date.parse(String(row.observed_at))<=Date.parse(matureAt)+TOLERANCE_MS);
  const endpoint=path.find(row=>Date.parse(String(row.observed_at))>=Date.parse(matureAt));
  if(!endpoint||path.length<10)return invalid('HORIZON_PRICE_UNAVAILABLE');
  let maxGap=0;for(let index=1;index<path.length;index++)maxGap=Math.max(maxGap,Date.parse(String(path[index].observed_at))-Date.parse(String(path[index-1].observed_at)));
  if(maxGap>120_000)return invalid('PRICE_PATH_NOT_DENSE');
  let state:AdaptiveExitState|undefined,returnPct=0,peakReturnPct=0,stopped=false;
  const events:{at:string;kind:'partial_exit'|'full_exit';observationOnly:true;sellPct:number;priceUsd:number;remainingPct:number}[]=[];
  for(const row of path){if(Date.parse(String(row.observed_at))>Date.parse(String(endpoint.observed_at)))break;
    const source=String(row.source);if(!QUOTE_SOURCES.has(source))return invalid('EXIT_POLICY_PRICE_SOURCE_UNSUPPORTED');
    const step=stepAdaptiveExit(state,{chain,address,priceUsd:Number(row.price_usd),observedAt:String(row.observed_at),
      evaluatedAt:String(row.observed_at),source,poolAddress:pool},undefined,ADAPTIVE_SHADOW_V5);
    if(step.status==='ignored')return invalid(`EXIT_POLICY_${step.ignoredReason??'UNKNOWN'}`);
    state=step.state;if(!state)return invalid('EXIT_POLICY_STATE_UNAVAILABLE');
    if(step.event){events.push({at:step.event.observedAt,kind:step.event.kind,observationOnly:true,
      sellPct:step.event.sellPctRemaining,priceUsd:step.event.observedPriceUsd,remainingPct:step.event.remainingPctOfInitial});
      if(step.event.reasons.includes('HARD_STOP_OBSERVED'))stopped=true;}
    const returns=shadowReturn(state,events,{priceUsd:state.lastPriceUsd,at:state.lastObservedAt,health:'fresh'});
    const value=returns.status==='closed'?returns.finalGainPct:returns.totalGainPct;
    if(!finite(value))return invalid(returns.reason??'EXIT_POLICY_RETURN_UNAVAILABLE');
    returnPct=value;peakReturnPct=Math.max(peakReturnPct,value);
    if(state.shadowClosed)break;
  }
  if(!state)return invalid('EXIT_POLICY_STATE_UNAVAILABLE');
  return {status:'valid',observedAt:String(endpoint.observed_at),returnPct,givebackPct:Math.max(0,peakReturnPct-returnPct),stopped};
}

function activeTriggerCandidate(store:StrategyEvolutionStore,source:'debot'|'ave',chain:Chain,asOf:string):StrategyCandidate {
  const scope={family:'notification_trigger_v1',source,chain,horizonSec:21600,outcomePolicyVersion:ADAPTIVE_SHADOW_V5.version,
    quoteRouteVersion:QUOTE_ROUTE_VERSION},all=store.listCandidates(1000).filter(row=>same(row.scope,scope));
  const active=all.find(row=>row.status==='collecting'||row.status==='forward_shadow');
  if(active)return active.status==='collecting'?store.beginForwardShadow(active.id,active.effectiveAt):active;
  const count=(policy:unknown)=>{const value=(policy as {triggerCount?:unknown})?.triggerCount;return Number.isSafeInteger(value)&&Number(value)>=2&&Number(value)<=6?Number(value):undefined;};
  const championCount=count(store.getResearchChampion(scope)?.policy)??3;
  const counterparts=new Set<number>();
  for(const row of all){const left=count(row.championPolicy),right=count(row.challengerPolicy);
    if(left===championCount&&right!==undefined)counterparts.add(right);else if(right===championCount&&left!==undefined)counterparts.add(left);}
  const order=[championCount+1,championCount-1,championCount+2,championCount-2,championCount+3,championCount-3]
    .filter((value,index,values)=>value>=2&&value<=6&&value!==championCount&&values.indexOf(value)===index);
  let challengerCount=order.find(value=>!counterparts.has(value));
  if(challengerCount===undefined){
    const eligible=all.flatMap(row=>{const left=count(row.championPolicy),right=count(row.challengerPolicy),other=left===championCount?right:right===championCount?left:undefined;
      if(other===undefined||row.status==='collecting'||row.status==='forward_shadow')return [];
      const decidedAt=store.listDecisions(row.id).at(-1)?.decidedAt??row.registeredAt;
      return Date.parse(asOf)-Date.parse(decidedAt)>=RETEST_COOLDOWN_MS?[{other,decidedAt}]:[];}).sort((a,b)=>a.decidedAt.localeCompare(b.decidedAt));
    challengerCount=eligible[0]?.other;
    if(challengerCount===undefined&&all[0])return all[0];
  }
  const championPolicy={family:'notification_trigger_v1',triggerCount:championCount,outcomePolicyVersion:ADAPTIVE_SHADOW_V5.version};
  const challengerPolicy={family:'notification_trigger_v1',triggerCount:challengerCount!,outcomePolicyVersion:ADAPTIVE_SHADOW_V5.version};
  const effectiveAt=asOf,candidate=store.registerCandidate({evidenceCutoff:iso(Date.parse(asOf)-1),effectiveAt,scope,championPolicy,challengerPolicy},asOf);
  return store.beginForwardShadow(candidate.id,effectiveAt);
}

/** Daily deterministic controller. It can only change the research champion ledger. */
export function runStrategyEvolutionDaily(input:{archivePath:string;memeDatabase:string;asOf:string;chains:readonly Chain[]}) {
  const path=strategyEvolutionDatabasePath(input.archivePath),bootstrap=new StrategyEvolutionSignalLedger(path,{now:()=>new Date(input.asOf)});
  let store:StrategyEvolutionStore|undefined,signals:DatabaseSync|undefined,prices:DatabaseSync|undefined,lease:string|undefined;
  const results:{candidateId:string;source:string;chain:Chain;enrolled:number;results:number;decision:string;reasons:string[]}[]=[];
  try {
    lease=bootstrap.acquireDailyLease(input.asOf);bootstrap.prune(new Date(input.asOf));
    store=new StrategyEvolutionStore(path,{now:()=>new Date(input.asOf)});signals=new DatabaseSync(path,{readOnly:true});prices=new DatabaseSync(input.memeDatabase,{readOnly:true});
    signals.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000');prices.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000');
    for(const source of ['debot','ave'] as const)for(const chain of input.chains){
      const candidate=activeTriggerCandidate(store,source,chain,input.asOf);let enrolled=0,recorded=0;
      if(candidate.status!=='forward_shadow'){
        results.push({candidateId:candidate.id,source,chain,enrolled,results:recorded,decision:candidate.status,reasons:['CANDIDATE_TERMINAL']});
        continue;
      }
      const championTrigger=Number(candidate.championPolicy.triggerCount),challengerTrigger=Number(candidate.challengerPolicy.triggerCount);
      if(!Number.isSafeInteger(championTrigger)||!Number.isSafeInteger(challengerTrigger)||championTrigger<2||championTrigger>6||
        challengerTrigger<2||challengerTrigger>6)throw new Error('STRATEGY_EVOLUTION_TRIGGER_POLICY_INVALID');
      const anchor=Math.min(championTrigger,challengerTrigger),anchorColumn=`n${anchor}_at`;
      const rows=signals.prepare(`SELECT session_id,address,MIN(observed_at) session_started_at,MAX(session_expires_at) session_expires_at,
          MAX(CASE WHEN ordinal=2 THEN observed_at END) n2_at,MAX(CASE WHEN ordinal=3 THEN observed_at END) n3_at,
          MAX(CASE WHEN ordinal=4 THEN observed_at END) n4_at,MAX(CASE WHEN ordinal=5 THEN observed_at END) n5_at,
          MAX(CASE WHEN ordinal=6 THEN observed_at END) n6_at
        FROM strategy_evolution_signal_events WHERE source=? AND chain=? AND observed_at<=?
        GROUP BY session_id,address HAVING session_started_at>=? AND ${anchorColumn} IS NOT NULL AND session_expires_at<=? ORDER BY ${anchorColumn} LIMIT 5001`)
        .all(source,chain,input.asOf,candidate.effectiveAt,input.asOf) as Row[];
      if(rows.length>5000)throw new Error('STRATEGY_EVOLUTION_SESSION_LIMIT_EXCEEDED');
      const known=new Map(store.listEpisodes(candidate.id).map(row=>[row.episodeKey,row]));
      for(const row of rows){const episodeKey=`${chain}:${String(row.address)}`,prior=known.get(episodeKey);if(prior?.result)continue;
        const arm=assignStrategyArm(candidate.id,episodeKey),triggerCount=arm==='champion'?championTrigger:challengerTrigger,
          triggerValue=row[`n${triggerCount}_at`],triggerAt=typeof triggerValue==='string'?triggerValue:undefined;
        const registeredAt=String(row[anchorColumn]),matureAt=triggerAt?iso(Date.parse(triggerAt)+HORIZON_MS):String(row.session_expires_at);
        if(Date.parse(matureAt)>Date.parse(input.asOf))continue;
        const episode=prior??store.registerEpisode(candidate.id,{episodeKey,registeredAt,matureAt,context:{source,chain,address:String(row.address),
          sessionId:String(row.session_id),triggerCount,
          triggerAt:triggerAt??null,outcomePolicyVersion:ADAPTIVE_SHADOW_V5.version,quoteRouteVersion:QUOTE_ROUTE_VERSION}});if(!prior)enrolled++;
        const sealedTrigger=typeof episode.context.triggerAt==='string'?episode.context.triggerAt:undefined;
        const result=sealedTrigger?quoteResult(prices,chain,String(row.address),sealedTrigger,episode.matureAt,input.asOf):
          {status:'valid' as const,observedAt:episode.matureAt,returnPct:0,givebackPct:0,stopped:false};
        if(store.recordEpisodeResult(episode.id,result))recorded++;
      }
      const evaluation=store.evaluate(candidate.id,input.asOf);results.push({candidateId:candidate.id,source,chain,enrolled,results:recorded,
        decision:evaluation.decision,reasons:evaluation.reasons});
    }
    bootstrap.markDailyRun({at:input.asOf,status:'succeeded'});
    return {enabled:true,mode:'research_only' as const,execution:'observation_only' as const,asOf:input.asOf,results};
  }catch(error){if(lease)bootstrap.markDailyRun({at:input.asOf,status:'failed',error:'STRATEGY_EVOLUTION_DAILY_FAILED'});throw error;}
  finally{prices?.close();signals?.close();store?.close();if(lease)bootstrap.releaseDailyLease(lease);bootstrap.close();}
}
