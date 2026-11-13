import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import type {Chain} from './types.js';

type Row=Record<string,unknown>;
export interface StrategyEvolutionStatusView {
  enabled:boolean;state:'ready'|'missing'|'degraded';mode:'research_only';execution:'observation_only';liveMutation:'forbidden';
  countingIndependent:true;error?:'STRATEGY_EVOLUTION_READ_FAILED';
  signals:{events:number;sessions:number;bySource:{debot:number;ave:number};lastEventAt?:string};
  candidates:{total:number;forwardShadow:number;champions:number;rejected:number;rolledBack:number};
  episodes:{total:number;mature:number;valid:number};latestDecision?:{at:string;action:string;reason:string};lastDailyRun?:unknown;
}
export interface StrategyEvolutionCandidateView extends Record<string,unknown> {id:string;status:string;registeredAt:string;episodes:number;mature:number;}
export interface StrategyEvolutionCandidatePage {
  enabled:boolean;state:'ready'|'missing'|'degraded';error?:'STRATEGY_EVOLUTION_READ_FAILED';total:number;
  items:StrategyEvolutionCandidateView[];limit:number;offset:number;chain?:Chain;hasMore:boolean;
}
const table=(db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const parse=(value:unknown)=>{try{return JSON.parse(String(value));}catch{return undefined;}};
function open<T extends object>(path:string,read:(db:DatabaseSync)=>T,fallback:T):T {
  if(!existsSync(path))return fallback;let db:DatabaseSync|undefined;
  try{db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500; BEGIN');const value=read(db);db.exec('COMMIT');return value;}
  catch{try{db?.exec('ROLLBACK');}catch{}return {...fallback,enabled:true,state:'degraded',
    error:'STRATEGY_EVOLUTION_READ_FAILED'} as unknown as T;}finally{db?.close();}
}

export function readStrategyEvolutionStatus(path:string):StrategyEvolutionStatusView{return open<StrategyEvolutionStatusView>(path,db=>{
  const signals=table(db,'strategy_evolution_signal_events')?db.prepare(`SELECT count(*) events,count(DISTINCT session_id) sessions,
    SUM(source='debot') debot,SUM(source='ave') ave,MAX(observed_at) last_event_at FROM strategy_evolution_signal_events`).get()!:{};
  const candidates=table(db,'strategy_evolution_candidates')?db.prepare(`SELECT count(*) candidates,
    SUM(status='forward_shadow') forward_shadow,SUM(status='shadow_champion') champions,SUM(status='rejected') rejected,
    SUM(status='rolled_back') rolled_back FROM strategy_evolution_candidates`).get()!:{};
  const episodes=table(db,'strategy_evolution_episodes')?db.prepare(`SELECT count(*) episodes,SUM(result_json IS NOT NULL) mature,
    SUM(json_extract(result_json,'$.status')='valid') valid FROM strategy_evolution_episodes`).get()!:{};
  const latest=table(db,'strategy_evolution_decisions')?db.prepare('SELECT decided_at,action,reason FROM strategy_evolution_decisions ORDER BY decided_at DESC,id DESC LIMIT 1').get():undefined;
  const daily=table(db,'strategy_evolution_signal_meta')?db.prepare("SELECT value FROM strategy_evolution_signal_meta WHERE key='last_daily_run'").get()?.value:undefined;
  return {enabled:true,state:'ready' as const,mode:'research_only' as const,execution:'observation_only' as const,liveMutation:'forbidden' as const,
    countingIndependent:true,signals:{events:Number(signals.events??0),sessions:Number(signals.sessions??0),
      bySource:{debot:Number(signals.debot??0),ave:Number(signals.ave??0)},lastEventAt:signals.last_event_at?String(signals.last_event_at):undefined},
    candidates:{total:Number(candidates.candidates??0),forwardShadow:Number(candidates.forward_shadow??0),champions:Number(candidates.champions??0),
      rejected:Number(candidates.rejected??0),rolledBack:Number(candidates.rolled_back??0)},
    episodes:{total:Number(episodes.episodes??0),mature:Number(episodes.mature??0),valid:Number(episodes.valid??0)},
    latestDecision:latest?{at:String(latest.decided_at),action:String(latest.action),reason:String(latest.reason)}:undefined,
    lastDailyRun:daily?parse(daily):undefined};
  },{enabled:false,state:'missing',mode:'research_only',execution:'observation_only',liveMutation:'forbidden',countingIndependent:true,
    signals:{events:0,sessions:0,bySource:{debot:0,ave:0},lastEventAt:undefined},candidates:{total:0,forwardShadow:0,champions:0,rejected:0,rolledBack:0},
    episodes:{total:0,mature:0,valid:0},latestDecision:undefined,lastDailyRun:undefined});
}

export function readStrategyEvolutionCandidates(path:string,options:{limit:number;offset:number;chain?:Chain}):StrategyEvolutionCandidatePage{
  return open<StrategyEvolutionCandidatePage>(path,db=>{
  if(!table(db,'strategy_evolution_candidates'))return {enabled:true,state:'ready' as const,total:0,items:[],...options,hasMore:false};
  const where=options.chain?"WHERE json_extract(scope_json,'$.chain')=?":'',args=options.chain?[options.chain]:[];
  const total=Number(db.prepare(`SELECT count(*) n FROM strategy_evolution_candidates ${where}`).get(...args)!.n);
  const rows=db.prepare(`SELECT c.*,(SELECT count(*) FROM strategy_evolution_episodes e WHERE e.candidate_id=c.id) episodes,
      (SELECT count(*) FROM strategy_evolution_episodes e WHERE e.candidate_id=c.id AND e.result_json IS NOT NULL) mature,
      (SELECT data_json FROM strategy_evolution_decisions d WHERE d.candidate_id=c.id ORDER BY decided_at DESC,id DESC LIMIT 1) latest_evaluation
    FROM strategy_evolution_candidates c ${where} ORDER BY registered_at DESC,id LIMIT ? OFFSET ?`).all(...args,options.limit,options.offset) as Row[];
  const items=rows.map(row=>{const seal=parse(row.sealed_json) as Record<string,unknown>|undefined;return {...seal,id:String(seal?.id??row.id),status:String(row.status),registeredAt:String(row.registered_at),
    episodes:Number(row.episodes),mature:Number(row.mature),latestEvaluation:parse(row.latest_evaluation)};});
  return {enabled:true,state:'ready' as const,total,items,...options,hasMore:options.offset+items.length<total};
  },{enabled:false,state:'missing',total:0,items:[],...options,hasMore:false});
}
