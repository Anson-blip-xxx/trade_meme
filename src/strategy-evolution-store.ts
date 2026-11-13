import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {assignStrategyArm,canonicalJson,canTransitionStrategyCandidate,createStrategyCandidateSeal,evaluateStrategyCandidate,
  normalizeJsonObject,strategyEpisodeId,validateStrategyCandidateSeal,validateStrategyEpisodeResult,
  type JsonObject,type StrategyCandidate,type StrategyCandidateSeal,type StrategyCandidateStatus,type StrategyEpisode,
  type StrategyEpisodeResult,type StrategyEvolutionEvaluation} from './strategy-evolution.js';

export interface StrategyEvolutionDecision {
  id:string;candidateId:string;decidedAt:string;action:'registered'|'activated'|'continued'|'promoted'|'rejected'|'rolled_back';
  fromStatus:StrategyCandidateStatus|null;toStatus:StrategyCandidateStatus;reason:string;data:JsonObject;
}
type Row=Record<string,unknown>;
const iso=(value:string):boolean=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const hash=(value:unknown):string=>createHash('sha256').update(canonicalJson(value)).digest('hex');

export class StrategyEvolutionStore {
  private readonly db:DatabaseSync;private readonly now:()=>Date;
  constructor(path:string,options:{now?:()=>Date}={}){
    if(!path||path.includes('\0'))throw new Error('STRATEGY_EVOLUTION_STORE_INVALID');
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);this.now=options.now??(()=>new Date());
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS strategy_evolution_candidates(
        id TEXT PRIMARY KEY,registered_at TEXT NOT NULL,evidence_cutoff TEXT NOT NULL,effective_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('collecting','forward_shadow','shadow_champion','rejected','rolled_back')),
        scope_json TEXT NOT NULL,champion_policy_json TEXT NOT NULL,challenger_policy_json TEXT NOT NULL,sealed_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS strategy_evolution_episodes(
        id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,episode_key TEXT NOT NULL,arm TEXT NOT NULL CHECK(arm IN ('champion','challenger')),
        registered_at TEXT NOT NULL,mature_at TEXT NOT NULL,context_json TEXT NOT NULL,result_json TEXT,
        UNIQUE(candidate_id,episode_key),FOREIGN KEY(candidate_id) REFERENCES strategy_evolution_candidates(id));
      CREATE INDEX IF NOT EXISTS strategy_evolution_episode_maturity ON strategy_evolution_episodes(candidate_id,mature_at,registered_at);
      CREATE TABLE IF NOT EXISTS strategy_evolution_decisions(
        id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,decided_at TEXT NOT NULL,action TEXT NOT NULL,
        from_status TEXT,to_status TEXT NOT NULL,reason TEXT NOT NULL,data_json TEXT NOT NULL,
        FOREIGN KEY(candidate_id) REFERENCES strategy_evolution_candidates(id));
      CREATE INDEX IF NOT EXISTS strategy_evolution_decision_history ON strategy_evolution_decisions(candidate_id,decided_at,id);
      CREATE TABLE IF NOT EXISTS strategy_evolution_research_champions(
        scope_hash TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,policy_json TEXT NOT NULL,promoted_at TEXT NOT NULL,
        FOREIGN KEY(candidate_id) REFERENCES strategy_evolution_candidates(id));`);
  }
  private at(value?:string):string {
    const at=value??this.now().toISOString();if(!iso(at))throw new Error('STRATEGY_EVOLUTION_TIME_INVALID');return at;
  }
  private row(value:Row):StrategyCandidate {
    const seal=JSON.parse(String(value.sealed_json)) as StrategyCandidateSeal;
    if(!validateStrategyCandidateSeal(seal))throw new Error('STRATEGY_EVOLUTION_CANDIDATE_CORRUPT');
    return {...seal,registeredAt:String(value.registered_at),status:String(value.status) as StrategyCandidateStatus};
  }
  private candidate(id:string):StrategyCandidate {
    if(!/^[a-f0-9]{64}$/.test(id))throw new Error('STRATEGY_EVOLUTION_CANDIDATE_ID_INVALID');
    const value=this.db.prepare('SELECT * FROM strategy_evolution_candidates WHERE id=?').get(id) as Row|undefined;
    if(!value)throw new Error('STRATEGY_EVOLUTION_CANDIDATE_NOT_FOUND');return this.row(value);
  }
  private audit(input:Omit<StrategyEvolutionDecision,'id'>):void {
    const body={...input,data:normalizeJsonObject(input.data,'decision_data',true)},id=hash(body);
    this.db.prepare('INSERT OR IGNORE INTO strategy_evolution_decisions VALUES(?,?,?,?,?,?,?,?)')
      .run(id,input.candidateId,input.decidedAt,input.action,input.fromStatus,input.toStatus,input.reason,canonicalJson(body.data));
  }
  registerCandidate(input:{evidenceCutoff:string;effectiveAt:string;scope:unknown;championPolicy:unknown;challengerPolicy:unknown},registeredAt?:string):StrategyCandidate {
    const at=this.at(registeredAt),seal=createStrategyCandidateSeal(input);
    const prior=this.getCandidate(seal.id);
    if(prior){const {registeredAt:ignoredRegistered,status:ignoredStatus,...priorSeal}=prior;void ignoredRegistered;void ignoredStatus;
      if(canonicalJson(priorSeal)!==canonicalJson(seal))throw new Error('STRATEGY_EVOLUTION_CANDIDATE_CONFLICT');return prior;}
    if(seal.evidenceCutoff>at||seal.effectiveAt<at)throw new Error('STRATEGY_EVOLUTION_FORWARD_BOUNDARY_INVALID');
    this.db.exec('BEGIN IMMEDIATE');try{
      const saved=this.db.prepare(`INSERT OR IGNORE INTO strategy_evolution_candidates VALUES(?,?,?,?,?,?,?,?,?)`).run(seal.id,at,
        seal.evidenceCutoff,seal.effectiveAt,'collecting',canonicalJson(seal.scope),canonicalJson(seal.championPolicy),canonicalJson(seal.challengerPolicy),canonicalJson(seal));
      const candidate=this.candidate(seal.id);
      const {registeredAt:ignoredRegistered,status:ignoredStatus,...storedSeal}=candidate;void ignoredRegistered;void ignoredStatus;
      if(canonicalJson(storedSeal)!==canonicalJson(seal))
        throw new Error('STRATEGY_EVOLUTION_CANDIDATE_CONFLICT');
      if(saved.changes)this.audit({candidateId:seal.id,decidedAt:at,action:'registered',fromStatus:null,toStatus:'collecting',
        reason:'SEALED_FORWARD_CANDIDATE_REGISTERED',data:{evidenceCutoff:seal.evidenceCutoff,effectiveAt:seal.effectiveAt}});
      this.db.exec('COMMIT');return candidate;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  getCandidate(id:string):StrategyCandidate|undefined {
    if(!/^[a-f0-9]{64}$/.test(id))return undefined;
    const value=this.db.prepare('SELECT * FROM strategy_evolution_candidates WHERE id=?').get(id) as Row|undefined;return value?this.row(value):undefined;
  }
  listCandidates(limit=100):StrategyCandidate[] {
    const take=Number.isInteger(limit)?Math.max(1,Math.min(1000,limit)):100;
    return (this.db.prepare('SELECT * FROM strategy_evolution_candidates ORDER BY registered_at DESC,id LIMIT ?').all(take) as Row[]).map(row=>this.row(row));
  }
  beginForwardShadow(id:string,at?:string):StrategyCandidate {
    const decidedAt=this.at(at);return this.transition(id,'forward_shadow',decidedAt,'FORWARD_SHADOW_STARTED',{});
  }
  rejectCandidate(id:string,reason:string,at?:string):StrategyCandidate {
    if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw new Error('STRATEGY_EVOLUTION_REASON_INVALID');
    const decidedAt=this.at(at);return this.transition(id,'rejected',decidedAt,reason.trim(),{});
  }
  private transition(id:string,to:StrategyCandidateStatus,at:string,reason:string,data:JsonObject):StrategyCandidate {
    this.db.exec('BEGIN IMMEDIATE');try{
      const current=this.candidate(id);if(current.status===to){this.db.exec('COMMIT');return current;}
      if(!canTransitionStrategyCandidate(current.status,to))throw new Error('STRATEGY_EVOLUTION_TRANSITION_INVALID');
      if(to==='forward_shadow'&&at<current.effectiveAt)throw new Error('STRATEGY_EVOLUTION_NOT_EFFECTIVE');
      const changed=this.db.prepare('UPDATE strategy_evolution_candidates SET status=? WHERE id=? AND status=?').run(to,id,current.status);
      if(changed.changes!==1)throw new Error('STRATEGY_EVOLUTION_TRANSITION_CONFLICT');
      const action=to==='forward_shadow'?'activated':to==='shadow_champion'?'promoted':to==='rolled_back'?'rolled_back':'rejected';
      this.audit({candidateId:id,decidedAt:at,action,fromStatus:current.status,toStatus:to,reason,data});
      this.db.exec('COMMIT');return this.candidate(id);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  registerEpisode(candidateId:string,input:{episodeKey:string;registeredAt:string;matureAt:string;context?:unknown}):StrategyEpisode {
    const candidate=this.candidate(candidateId),now=this.at();
    if(candidate.status!=='forward_shadow')throw new Error('STRATEGY_EVOLUTION_CANDIDATE_NOT_ACTIVE');
    if(typeof input?.episodeKey!=='string'||!input.episodeKey.trim()||input.episodeKey.length>256||!iso(input.registeredAt)||
      !iso(input.matureAt)||input.registeredAt<candidate.effectiveAt||input.registeredAt>now||input.matureAt<=input.registeredAt)
      throw new Error('STRATEGY_EVOLUTION_EPISODE_INVALID');
    const episodeKey=input.episodeKey,context=input.context===undefined?{}:normalizeJsonObject(input.context,'episode_context',true);
    const arm=assignStrategyArm(candidateId,episodeKey),id=strategyEpisodeId(candidateId,episodeKey),sealed=canonicalJson({id,candidateId,episodeKey,arm,
      registeredAt:input.registeredAt,matureAt:input.matureAt,context});
    this.db.prepare('INSERT OR IGNORE INTO strategy_evolution_episodes VALUES(?,?,?,?,?,?,?,NULL)')
      .run(id,candidateId,episodeKey,arm,input.registeredAt,input.matureAt,canonicalJson(context));
    const saved=this.episode(id),{result:ignoredResult,...savedSeal}=saved;void ignoredResult;
    if(canonicalJson(savedSeal)!==sealed)throw new Error('STRATEGY_EVOLUTION_EPISODE_CONFLICT');return saved;
  }
  private episode(id:string):StrategyEpisode {
    const row=this.db.prepare('SELECT * FROM strategy_evolution_episodes WHERE id=?').get(id) as Row|undefined;
    if(!row)throw new Error('STRATEGY_EVOLUTION_EPISODE_NOT_FOUND');
    const result=row.result_json?JSON.parse(String(row.result_json)) as StrategyEpisodeResult:undefined;
    return {id:String(row.id),candidateId:String(row.candidate_id),episodeKey:String(row.episode_key),arm:String(row.arm) as 'champion'|'challenger',
      registeredAt:String(row.registered_at),matureAt:String(row.mature_at),context:JSON.parse(String(row.context_json)) as JsonObject,...(result?{result}:{})};
  }
  recordEpisodeResult(episodeId:string,result:StrategyEpisodeResult):boolean {
    if(!/^[a-f0-9]{64}$/.test(episodeId)||!validateStrategyEpisodeResult(result))throw new Error('STRATEGY_EVOLUTION_RESULT_INVALID');
    const episode=this.episode(episodeId),now=this.at();
    if(now<episode.matureAt||result.observedAt<episode.matureAt||result.observedAt>now)throw new Error('STRATEGY_EVOLUTION_RESULT_NOT_MATURE');
    const encoded=canonicalJson(result),changed=this.db.prepare('UPDATE strategy_evolution_episodes SET result_json=? WHERE id=? AND result_json IS NULL').run(encoded,episodeId);
    if(changed.changes)return true;
    const stored=this.episode(episodeId).result;if(canonicalJson(stored)!==encoded)throw new Error('STRATEGY_EVOLUTION_RESULT_CONFLICT');return false;
  }
  listEpisodes(candidateId:string):StrategyEpisode[] {
    this.candidate(candidateId);return (this.db.prepare('SELECT id FROM strategy_evolution_episodes WHERE candidate_id=? ORDER BY registered_at,id').all(candidateId) as Row[])
      .map(row=>this.episode(String(row.id)));
  }
  evaluate(candidateId:string,at?:string):StrategyEvolutionEvaluation {
    const evaluatedAt=this.at(at),candidate=this.candidate(candidateId);
    if(candidate.status==='collecting')throw new Error('STRATEGY_EVOLUTION_CANDIDATE_NOT_ACTIVE');
    const evaluation=evaluateStrategyCandidate(candidate,this.listEpisodes(candidateId),evaluatedAt);
    if(candidate.status!=='forward_shadow')return evaluation;
    const to=evaluation.decision==='promote'?'shadow_champion':evaluation.decision==='reject'?'rejected':evaluation.decision==='rollback'?'rolled_back':undefined;
    this.db.exec('BEGIN IMMEDIATE');try{
      if(!to){this.audit({candidateId,decidedAt:evaluatedAt,action:'continued',fromStatus:'forward_shadow',toStatus:'forward_shadow',
        reason:evaluation.reasons.join(',')||'FORWARD_EVIDENCE_COLLECTING',data:evaluation as unknown as JsonObject});this.db.exec('COMMIT');return evaluation;}
      const changed=this.db.prepare("UPDATE strategy_evolution_candidates SET status=? WHERE id=? AND status='forward_shadow'").run(to,candidateId);
      if(changed.changes!==1)throw new Error('STRATEGY_EVOLUTION_TRANSITION_CONFLICT');
      if(to==='shadow_champion'){
        const scopeHash=hash(candidate.scope),previous=this.db.prepare('SELECT candidate_id FROM strategy_evolution_research_champions WHERE scope_hash=?').get(scopeHash) as Row|undefined;
        if(previous&&String(previous.candidate_id)!==candidateId){
          const old=this.getCandidate(String(previous.candidate_id));if(old?.status==='shadow_champion'){
            this.db.prepare("UPDATE strategy_evolution_candidates SET status='rolled_back' WHERE id=? AND status='shadow_champion'").run(old.id);
            this.audit({candidateId:old.id,decidedAt:evaluatedAt,action:'rolled_back',fromStatus:'shadow_champion',toStatus:'rolled_back',
              reason:'SUPERSEDED_BY_RESEARCH_CHAMPION',data:{replacementCandidateId:candidateId}});
          }
        }
        this.db.prepare('INSERT OR REPLACE INTO strategy_evolution_research_champions VALUES(?,?,?,?)')
          .run(scopeHash,candidateId,canonicalJson(candidate.challengerPolicy),evaluatedAt);
      }
      const action=to==='shadow_champion'?'promoted':to==='rolled_back'?'rolled_back':'rejected';
      this.audit({candidateId,decidedAt:evaluatedAt,action,fromStatus:'forward_shadow',toStatus:to,
        reason:evaluation.reasons.join(',')||(to==='shadow_champion'?'FORWARD_SHADOW_PROMOTED':'FORWARD_SHADOW_DECIDED'),data:evaluation as unknown as JsonObject});
      this.db.exec('COMMIT');return evaluation;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  getResearchChampion(scope:unknown):{candidateId:string;policy:JsonObject;promotedAt:string}|undefined {
    const normalized=normalizeJsonObject(scope,'scope'),row=this.db.prepare('SELECT * FROM strategy_evolution_research_champions WHERE scope_hash=?').get(hash(normalized)) as Row|undefined;
    return row?{candidateId:String(row.candidate_id),policy:JSON.parse(String(row.policy_json)) as JsonObject,promotedAt:String(row.promoted_at)}:undefined;
  }
  listDecisions(candidateId:string):StrategyEvolutionDecision[] {
    this.candidate(candidateId);return (this.db.prepare('SELECT * FROM strategy_evolution_decisions WHERE candidate_id=? ORDER BY decided_at,id').all(candidateId) as Row[]).map(row=>({
      id:String(row.id),candidateId:String(row.candidate_id),decidedAt:String(row.decided_at),action:String(row.action) as StrategyEvolutionDecision['action'],
      fromStatus:row.from_status===null?null:String(row.from_status) as StrategyCandidateStatus,toStatus:String(row.to_status) as StrategyCandidateStatus,
      reason:String(row.reason),data:JSON.parse(String(row.data_json)) as JsonObject}));
  }
  close():void {this.db.close();}
}
