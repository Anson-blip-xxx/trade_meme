import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {assignStrategyArm,canonicalJson,createStrategyCandidateSeal,evaluateStrategyCandidate,strategyEpisodeId,
  type StrategyArm,type StrategyCandidateSeal,type StrategyEpisode,type StrategyEpisodeResult} from '../src/strategy-evolution.js';
import {StrategyEvolutionStore} from '../src/strategy-evolution-store.js';

const at=(day:number,hour=0,minute=0)=>`2026-01-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00.000Z`;
const definition=(effectiveAt=at(1))=>({evidenceCutoff:'2025-12-31T23:59:00.000Z',effectiveAt,scope:{chain:'solana',source:'debot'},
  championPolicy:{version:'v5',hardStopPct:-60},challengerPolicy:{version:'v6',hardStopPct:-60,tailPct:12}});
const result=(observedAt:string,returnPct:number,givebackPct:number,stopped=false):StrategyEpisodeResult=>
  ({status:'valid',observedAt,returnPct,givebackPct,stopped});

function fixture(t:TestContext,start=at(1)){
  const dir=mkdtempSync(join(tmpdir(),'strategy-evolution-')),path=join(dir,'evolution.sqlite');let now=Date.parse(start);
  const store=new StrategyEvolutionStore(path,{now:()=>new Date(now)});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,path,get now(){return now;},set now(value:number){now=value;}};
}

test('candidate policy, scope and forward boundary are sealed with an idempotent canonical hash',t=>{
  const f=fixture(t),first=f.store.registerCandidate(definition());
  const same=f.store.registerCandidate({...definition(),scope:{source:'debot',chain:'solana'},
    championPolicy:{hardStopPct:-60,version:'v5'},challengerPolicy:{tailPct:12,hardStopPct:-60,version:'v6'}});
  assert.equal(same.id,first.id);assert.equal(f.store.listCandidates().length,1);assert.equal(first.status,'collecting');
  assert.equal(first.execution,'research_only');assert.equal(first.liveMutation,'forbidden');
  assert.equal(statSync(f.path).mode&0o777,0o600);
  const db=new DatabaseSync(f.path,{readOnly:true});t.after(()=>db.close());
  assert.equal(db.prepare('SELECT count(*) n FROM strategy_evolution_candidates').get()!.n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM strategy_evolution_decisions').get()!.n,1);
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT challenger_policy_json p FROM strategy_evolution_candidates').get()!.p)),
    {hardStopPct:-60,tailPct:12,version:'v6'});
});

test('candidate validation rejects retrospective, unchanged, non-finite and cyclic definitions',t=>{
  const f=fixture(t,at(2));
  assert.throws(()=>f.store.registerCandidate(definition(at(1))),/FORWARD_BOUNDARY/);
  assert.throws(()=>createStrategyCandidateSeal({...definition(),challengerPolicy:{version:'v5',hardStopPct:-60}}),/POLICY_UNCHANGED/);
  assert.throws(()=>createStrategyCandidateSeal({...definition(),challengerPolicy:{version:'v6',x:NaN}}),/JSON_NUMBER/);
  const cyclic:Record<string,unknown>={version:'v6'};cyclic.self=cyclic;
  assert.throws(()=>createStrategyCandidateSeal({...definition(),challengerPolicy:cyclic}),/JSON_CYCLE/);
  assert.throws(()=>createStrategyCandidateSeal({...definition(),evidenceCutoff:at(1),effectiveAt:at(1)}),/CANDIDATE_TIME/);
});

test('forward episodes require activation and effective time, and assignment is deterministic and immutable',t=>{
  const f=fixture(t),candidate=f.store.registerCandidate(definition(at(1,1)));
  assert.throws(()=>f.store.registerEpisode(candidate.id,{episodeKey:'one',registeredAt:at(1,1),matureAt:at(1,2)}),/NOT_ACTIVE/);
  assert.throws(()=>f.store.beginForwardShadow(candidate.id),/NOT_EFFECTIVE/);
  f.now=Date.parse(at(1,1));f.store.beginForwardShadow(candidate.id);
  assert.throws(()=>f.store.registerEpisode(candidate.id,{episodeKey:'old',registeredAt:at(1),matureAt:at(1,2)}),/EPISODE_INVALID/);
  const saved=f.store.registerEpisode(candidate.id,{episodeKey:'one',registeredAt:at(1,1),matureAt:at(1,2),context:{signal:'third'}});
  assert.equal(saved.arm,assignStrategyArm(candidate.id,'one'));assert.equal(saved.id,strategyEpisodeId(candidate.id,'one'));
  assert.deepEqual(f.store.registerEpisode(candidate.id,{episodeKey:'one',registeredAt:at(1,1),matureAt:at(1,2),context:{signal:'third'}}),saved);
  assert.throws(()=>f.store.registerEpisode(candidate.id,{episodeKey:'one',registeredAt:at(1,1),matureAt:at(1,3),context:{signal:'third'}}),/EPISODE_CONFLICT/);
});

test('results cannot be written before maturity and conflicting rewrites are rejected',t=>{
  const f=fixture(t),candidate=f.store.registerCandidate(definition());f.store.beginForwardShadow(candidate.id);
  const episode=f.store.registerEpisode(candidate.id,{episodeKey:'result-test',registeredAt:at(1),matureAt:at(1,1)});
  assert.throws(()=>f.store.recordEpisodeResult(episode.id,result(at(1,1),20,5)),/NOT_MATURE/);
  f.now=Date.parse(at(1,1));assert.equal(f.store.recordEpisodeResult(episode.id,result(at(1,1),20,5)),true);
  assert.equal(f.store.recordEpisodeResult(episode.id,result(at(1,1),20,5)),false);
  assert.throws(()=>f.store.recordEpisodeResult(episode.id,result(at(1,1),21,5)),/RESULT_CONFLICT/);
  assert.throws(()=>f.store.recordEpisodeResult(episode.id,result(at(1,1),-101,5)),/RESULT_INVALID/);
});

function keysFor(candidateId:string,countPerArm:number):Record<StrategyArm,string[]> {
  const output:Record<StrategyArm,string[]>={champion:[],challenger:[]};
  for(let index=0;output.champion.length<countPerArm||output.challenger.length<countPerArm;index++){
    const key=`episode-${index}`,arm=assignStrategyArm(candidateId,key);if(output[arm].length<countPerArm)output[arm].push(key);
  }return output;
}
function addArm(store:StrategyEvolutionStore,candidate:StrategyCandidateSeal,arm:StrategyArm,keys:string[],values:{returnPct:number;givebackPct:number;stopped?:boolean},invalid=0):void {
  keys.forEach((key,index)=>{
    const day=1+index%3,registeredAt=at(day,index%20),matureAt=at(day,index%20,30);
    const episode=store.registerEpisode(candidate.id,{episodeKey:key,registeredAt,matureAt,context:{armExpected:arm}});
    assert.equal(episode.arm,arm);
    if(index<keys.length-invalid)store.recordEpisodeResult(episode.id,result(matureAt,values.returnPct,values.givebackPct,values.stopped));
    else store.recordEpisodeResult(episode.id,{status:'invalid',observedAt:matureAt,reason:'QUOTE_GAP'});
  });
}

test('thirty covered samples per arm across three UTC dates promote only a research shadow champion',t=>{
  const f=fixture(t),candidate=f.store.registerCandidate(definition());f.store.beginForwardShadow(candidate.id);f.now=Date.parse(at(5));
  const keys=keysFor(candidate.id,30);addArm(f.store,candidate,'champion',keys.champion,{returnPct:10,givebackPct:40});
  addArm(f.store,candidate,'challenger',keys.challenger,{returnPct:12,givebackPct:25});
  const evaluation=f.store.evaluate(candidate.id,at(5));assert.equal(evaluation.decision,'promote');
  assert.equal(evaluation.champion.valid,30);assert.equal(evaluation.challenger.valid,30);assert.equal(evaluation.deltas.meanReturnPct,2);
  assert.equal(f.store.getCandidate(candidate.id)?.status,'shadow_champion');
  assert.deepEqual(f.store.getResearchChampion({source:'debot',chain:'solana'})?.policy,{hardStopPct:-60,tailPct:12,version:'v6'});
  assert.equal(f.store.listDecisions(candidate.id).at(-1)?.action,'promoted');
  const db=new DatabaseSync(f.path,{readOnly:true});t.after(()=>db.close());
  const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
  assert.deepEqual(tables,['strategy_evolution_candidates','strategy_evolution_decisions','strategy_evolution_episodes','strategy_evolution_research_champions']);
});

test('coverage below 90 percent or fewer than three dates keeps forward collection active',t=>{
  const f=fixture(t),candidate=f.store.registerCandidate(definition());f.store.beginForwardShadow(candidate.id);f.now=Date.parse(at(5));
  const keys=keysFor(candidate.id,35);addArm(f.store,candidate,'champion',keys.champion,{returnPct:10,givebackPct:30},5);
  addArm(f.store,candidate,'challenger',keys.challenger,{returnPct:12,givebackPct:20},5);
  const evaluation=f.store.evaluate(candidate.id,at(5));assert.equal(evaluation.decision,'continue');
  assert.equal(evaluation.champion.coveragePct,85.714286);assert.ok(evaluation.reasons.includes('MINIMUM_COVERAGE_NOT_MET'));
  assert.equal(f.store.getCandidate(candidate.id)?.status,'forward_shadow');assert.equal(f.store.listDecisions(candidate.id).at(-1)?.action,'continued');
});

test('a mature challenger with worse mean or median is rejected after complete forward evidence',t=>{
  const seal=createStrategyCandidateSeal(definition()),keys=keysFor(seal.id,30),episodes:StrategyEpisode[]=[];
  for(const arm of ['champion','challenger'] as const)keys[arm].forEach((key,index)=>{
    const registeredAt=at(1+index%3,index%20),matureAt=at(1+index%3,index%20,30);
    episodes.push({id:strategyEpisodeId(seal.id,key),candidateId:seal.id,episodeKey:key,arm,registeredAt,matureAt,context:{},
      result:result(matureAt,arm==='champion'?20:5,arm==='champion'?25:15)});
  });
  const evaluation=evaluateStrategyCandidate(seal,episodes,at(5));assert.equal(evaluation.decision,'reject');
  assert.ok(evaluation.reasons.includes('MEAN_RETURN_REGRESSION'));assert.ok(evaluation.reasons.includes('MEDIAN_RETURN_REGRESSION'));
  assert.equal(evaluation.deltas.meanGivebackPct,-10);
});

test('severe p10 and stop regression in the first twenty valid samples rolls back early',t=>{
  const f=fixture(t),candidate=f.store.registerCandidate(definition());f.store.beginForwardShadow(candidate.id);f.now=Date.parse(at(2));
  const keys=keysFor(candidate.id,10);
  for(let index=0;index<10;index++)for(const arm of ['champion','challenger'] as const){
    const key=keys[arm][index],registeredAt=at(1,0,index*2+(arm==='challenger'?1:0)),matureAt=at(1,1,index);
    const episode=f.store.registerEpisode(candidate.id,{episodeKey:key,registeredAt,matureAt});
    f.store.recordEpisodeResult(episode.id,result(matureAt,arm==='champion'?0:-80,arm==='champion'?5:90,arm==='challenger'));
  }
  const evaluation=f.store.evaluate(candidate.id,at(2));assert.equal(evaluation.decision,'rollback');
  assert.equal(evaluation.earlyWindow.considered,20);assert.ok((evaluation.earlyWindow.p10RegressionPct??0)<-15);
  assert.equal(f.store.getCandidate(candidate.id)?.status,'rolled_back');assert.equal(f.store.getResearchChampion(candidate.scope),undefined);
});

test('canonical JSON is stable and rejects executable or oversized input',()=>{
  assert.equal(canonicalJson({b:2,a:1}),'{"a":1,"b":2}');
  assert.throws(()=>canonicalJson({fn:()=>1}),/JSON_TYPE/);
  assert.throws(()=>canonicalJson({payload:'x'.repeat(70_000)}),/JSON_LIMIT/);
});
