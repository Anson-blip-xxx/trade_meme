import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ADAPTIVE_SHADOW_V3,stepAdaptiveExit,type AdaptiveExitState} from '../src/adaptive-exit.js';
import {ExitShadow,type ShadowEvent} from '../src/exit-shadow.js';
import {shadowReturn} from '../src/exit-shadow-return.js';
import {exitQuality,summarizeExitQuality,readExitQualityReview,type ExitQualityInput,type ExitQualitySample} from '../src/exit-quality.js';

const start=Date.parse('2026-10-18T00:00:00.000Z'),iso=(at:number)=>new Date(at).toISOString();
const address=`0x${'a'.repeat(40)}`,pool=`0x${'b'.repeat(40)}`,otherPool=`0x${'c'.repeat(40)}`;
const sample=(at:number,priceUsd:number,extra:Partial<ExitQualitySample>={}):ExitQualitySample=>({at:iso(at),priceUsd,source:'gmgn_token_info_sample',pool,...extra});
function episode(prices=[100,600,1100,800]):ExitQualityInput {
  let state:AdaptiveExitState|undefined;const events:ShadowEvent[]=[];
  const samples=prices.map((priceUsd,index)=>sample(start+index*60_000,priceUsd));
  for(const item of samples){
    const step=stepAdaptiveExit(state,{chain:'bsc',address,priceUsd:item.priceUsd,observedAt:item.at,evaluatedAt:item.at,source:item.source},undefined,ADAPTIVE_SHADOW_V3);
    state=step.state!;
    if(step.event){const e=step.event;events.push({at:e.observedAt,kind:e.kind,observationOnly:true,reason:e.reasons[0],priceUsd:e.observedPriceUsd,sellPct:e.sellPctRemaining,remainingPct:e.remainingPctOfInitial});}
  }
  return {asOf:iso(start+2*3600_000),baselineAt:iso(start),baselinePriceUsd:100,policyVersion:state!.policyVersion,
    returns:shadowReturn(state!,events,{priceUsd:state!.lastPriceUsd,at:state!.lastObservedAt,health:'fresh'}),
    preExitSamples:samples,preExitTruncated:false,exitSample:samples.at(-1),comparisonSamples:{}};
}

test('weighted equity peak respects sold initial stake rather than a whole-token maximum',()=>{
  const quality=exitQuality(episode());
  assert.equal(quality.status,'closed');assert.equal(quality.finalGainPct,684);
  assert.equal(quality.equityPeak.status,'valid');assert.equal(quality.equityPeak.gainPct,900);
  assert.equal(quality.equityPeak.givebackPct,216);assert.equal(quality.equityPeak.at,iso(start+120_000));
  assert.equal(quality.equityPeak.maxGapSec,60);assert.equal(quality.costsIncluded,false);
});

test('post-exit comparisons select the first compatible quote and weight only the final remaining stake',()=>{
  const input=episode(),exitAt=Date.parse(input.returns.closedAt!);
  input.comparisonSamples={5:{samples:[sample(exitAt+300_000,10000,{pool:otherPool}),sample(exitAt+301_000,900),sample(exitAt+302_000,5000)],truncated:false},
    15:{samples:[sample(exitAt+900_000,400)],truncated:false},60:{samples:[sample(exitAt+3600_000,800)],truncated:false}};
  const quality=exitQuality(input),[five,fifteen,hour]=quality.afterExit;
  assert.equal(five.status,'valid');assert.equal(five.tokenMovePct,12.5);assert.equal(five.impactOnInitialPrincipalPct,72);
  assert.equal(five.sampleAt,iso(exitAt+301_000));assert.equal(five.lateSec,1);assert.equal(five.direction,'continued_up');
  assert.equal(fifteen.impactOnInitialPrincipalPct,-288);assert.equal(fifteen.direction,'avoided_drawdown');
  assert.equal(hour.direction,'flat');assert.equal(quality.finalGainPct,684);assert.equal(quality.equityPeak.givebackPct,216);
});

test('future, too-early and late quotes cannot fill a horizon; a still-open window remains pending',()=>{
  const input=episode(),exitAt=Date.parse(input.returns.closedAt!),due=exitAt+300_000;
  input.comparisonSamples={5:{samples:[sample(due-1,900),sample(due+120_001,900),sample(due+2,900)],truncated:false}};
  assert.equal(exitQuality({...input,asOf:iso(due-1)}).afterExit[0].status,'not_due');
  assert.equal(exitQuality({...input,asOf:iso(due+1)}).afterExit[0].status,'awaiting_sample');
  input.comparisonSamples={5:{samples:[sample(due-1,900),sample(due+120_001,900)],truncated:false}};
  assert.equal(exitQuality(input).afterExit[0].status,'missing_price');
});

test('unknown pools, different pools and different providers stay out of success denominators',()=>{
  const input=episode(),exitAt=Date.parse(input.returns.closedAt!),due=exitAt+300_000;
  const unknown=exitQuality({...input,preExitSamples:input.preExitSamples.map(item=>({...item,pool:undefined})),exitSample:{...input.exitSample!,pool:undefined}});
  assert.equal(unknown.finalGainPct,684);assert.equal(unknown.equityPeak.reason,'POOL_PROVENANCE_UNKNOWN');
  assert.equal(unknown.afterExit[0].status,'provenance_unknown');assert.equal(unknown.afterExit[0].tokenMovePct,undefined);
  for(const changed of [{pool:otherPool},{source:'dexscreener_token_pairs_sample'}]){
    const result=exitQuality({...input,comparisonSamples:{5:{samples:[sample(due,900,changed)],truncated:false}}});
    assert.equal(result.afterExit[0].status,'provenance_mismatch');
  }
  const summary=summarizeExitQuality([unknown,exitQuality(input)]);
  assert.equal(summary.finalReturn.denominator,2);assert.equal(summary.equityGiveback.denominator,1);
  assert.equal(summary.afterExit[0].denominator,0);assert.equal(summary.afterExit[0].statuses.provenance_unknown,1);
  assert.equal(summary.afterExit[0].statuses.missing_price,1);assert.equal(summary.afterExit[0].continuedUp,0);
});

test('bounded and incomplete histories cannot synthesize a peak or a post-exit conclusion',()=>{
  const input=episode(),due=Date.parse(input.returns.closedAt!)+300_000;
  assert.equal(exitQuality({...input,preExitTruncated:true}).equityPeak.reason,'PRE_EXIT_SAMPLE_LIMIT');
  assert.equal(exitQuality({...input,preExitSamples:input.preExitSamples.filter((_,index)=>index!==1)}).equityPeak.reason,'PRE_EXIT_HISTORY_INCOMPLETE');
  assert.equal(exitQuality({...input,exitSample:undefined}).equityPeak.reason,'EXIT_SAMPLE_UNAVAILABLE');
  assert.equal(exitQuality({...input,comparisonSamples:{5:{samples:[sample(due,900,{pool:otherPool})],truncated:true}}}).afterExit[0].status,'sample_limit');
  assert.equal(exitQuality({...input,preExitSamples:[input.preExitSamples[0],input.preExitSamples[2],input.preExitSamples[1],input.preExitSamples[3]]}).equityPeak.status,'unknown');
});

test('open and invalid returns stay separately unknown, and losses use a zero initial equity peak',()=>{
  const open=exitQuality(episode([100,600]));assert.equal(open.status,'open');assert.equal(open.finalGainPct,undefined);
  assert.equal(open.afterExit[0].status,'open');
  const invalid=episode();invalid.returns={...invalid.returns,status:'unavailable',reason:'RETURN_HISTORY_INCOMPLETE'};
  const broken=exitQuality(invalid);assert.equal(broken.status,'unavailable');assert.equal(broken.finalGainPct,undefined);
  assert.equal(broken.afterExit[0].status,'return_unavailable');
  const stop=exitQuality(episode([100,45]));assert.equal(stop.equityPeak.gainPct,0);assert.ok(Math.abs(stop.equityPeak.givebackPct!-55)<1e-8);
  const summary=summarizeExitQuality([open,broken,stop]);assert.equal(summary.finalReturn.denominator,1);assert.equal(summary.open,1);assert.equal(summary.unavailable,1);
});

test('read-only review selects actual closures within the persisted time window and reports truncation',t=>{
  const dir=mkdtempSync(join(tmpdir(),'meme-exit-quality-')),path=join(dir,'shadow.sqlite');let now=start;
  const store=new ExitShadow(path,{now:()=>new Date(now)});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  for(const [index,priceUsd] of [100,600,1100,800].entries()){
    now=start+index*60_000;
    store.recordPrice({chain:'bsc',address,priceUsd,observedAt:iso(now),source:'gmgn_token_info_sample',market:{poolAddress:pool.toUpperCase().replace('0X','0x')}},
      index===0?{candidateId:'first',eligibleAt:iso(start),endsAt:iso(start+86400_000)}:undefined);
  }
  const closedAt=now,id=store.list().items[0].id;
  now=closedAt+300_000;store.recordPrice({chain:'bsc',address,priceUsd:900,observedAt:iso(now),source:'gmgn_token_info_sample',market:{poolAddress:pool}},undefined);
  const detail=store.detail(id)!;assert.equal(detail.quality.equityPeak.givebackPct,216);assert.equal(detail.quality.afterExit[0].impactOnInitialPrincipalPct,72);
  for(const [index,priceUsd] of [100,45].entries()){
    now=closedAt+400_000+index*60_000;
    store.recordPrice({chain:'bsc',address:otherPool,priceUsd,observedAt:iso(now),source:'gmgn_token_info_sample'},
      index===0?{candidateId:'second',eligibleAt:iso(now),endsAt:iso(now+86400_000)}:undefined);
  }
  const before=store.summary().status;
  const partial=readExitQualityReview(path,{asOf:iso(now+3600_000),sinceAt:iso(start),limit:1});
  assert.equal(partial.total,2);assert.equal(partial.reviewed,1);assert.equal(partial.truncated,true);
  const all=readExitQualityReview(path,{asOf:iso(now+3600_000),sinceAt:iso(start)});
  assert.equal(all.summary.finalReturn.denominator,2);assert.equal(all.summary.equityGiveback.denominator,1);
  assert.equal(all.byPolicy.length,1);assert.equal(all.byPolicy[0].summary.finalReturn.denominator,2);
  assert.equal(all.summaryBasis,'equal_weight_per_position_gross_simulation');
  assert.equal(all.cases[0].id,id);assert.equal(all.historyComplete,true);
  const earlier=readExitQualityReview(path,{asOf:iso(closedAt-1),sinceAt:iso(start)});assert.equal(earlier.total,0);
  const later=readExitQualityReview(path,{asOf:iso(now+3600_000),sinceAt:iso(closedAt+1)});assert.equal(later.total,1);
  assert.deepEqual(store.summary().status,before);
  for(const limit of [0,1001,NaN])assert.throws(()=>readExitQualityReview(path,{asOf:iso(now),sinceAt:iso(start),limit}),/OPTIONS_INVALID/);
  const db=new DatabaseSync(path,{readOnly:true});t.after(()=>db.close());
  assert.match(String(db.prepare("EXPLAIN QUERY PLAN SELECT id FROM exit_shadow_positions INDEXED BY exit_shadow_quality_closed_at WHERE phase='triggered' AND json_extract(state,'$.lastObservedAt')>=? AND json_extract(state,'$.lastObservedAt')<=? ORDER BY json_extract(state,'$.lastObservedAt') DESC,id LIMIT 1000").all(iso(start),iso(now))[0].detail),/exit_shadow_quality_closed_at/);
});

test('old missing-pool observations are not retroactively assigned a new provider pool',t=>{
  const dir=mkdtempSync(join(tmpdir(),'meme-exit-quality-old-')),path=join(dir,'shadow.sqlite');let now=start;
  const store=new ExitShadow(path,{now:()=>new Date(now)});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  for(const [index,priceUsd] of [100,45].entries()){
    now=start+index*60_000;store.recordPrice({chain:'bsc',address,priceUsd,observedAt:iso(now),source:'gmgn_token_info_sample'},
      index===0?{candidateId:'legacy',eligibleAt:iso(start),endsAt:iso(start+86400_000)}:undefined);
  }
  const id=store.list().items[0].id;now+=300_000;
  store.recordPrice({chain:'bsc',address,priceUsd:900,observedAt:iso(now),source:'gmgn_token_info_sample',market:{poolAddress:pool}},undefined);
  const quality=store.detail(id)!.quality;assert.ok(Math.abs(quality.finalGainPct!+55)<1e-8);assert.equal(quality.equityPeak.reason,'POOL_PROVENANCE_UNKNOWN');
  assert.equal(quality.afterExit[0].status,'provenance_unknown');assert.equal(quality.afterExit[0].impactOnInitialPrincipalPct,undefined);
});

test('the reader caps large pre-exit sample ranges without losing separately bounded horizon evidence',t=>{
  const dir=mkdtempSync(join(tmpdir(),'meme-exit-quality-cap-')),path=join(dir,'shadow.sqlite');let now=start;
  const store=new ExitShadow(path,{now:()=>new Date(now)});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.recordPrice({chain:'bsc',address,priceUsd:100,observedAt:iso(now),source:'gmgn_token_info_sample',market:{poolAddress:pool}},
    {candidateId:'many-samples',eligibleAt:iso(start),endsAt:iso(start+86400_000)});
  now=start+10_000;store.recordPrice({chain:'bsc',address,priceUsd:45,observedAt:iso(now),source:'gmgn_token_info_sample',market:{poolAddress:pool}},undefined);
  const id=store.list().items[0].id,db=new DatabaseSync(path);
  try {
    db.exec('BEGIN');const insert=db.prepare('INSERT INTO exit_shadow_samples VALUES(?,?,?,?,?)');
    for(let index=1;index<=2001;index++)insert.run(id,iso(start+index),100,'gmgn_token_info_sample',JSON.stringify({poolAddress:pool}));
    db.exec('COMMIT');
  }finally{db.close();}
  now+=300_000;store.recordPrice({chain:'bsc',address,priceUsd:90,observedAt:iso(now),source:'gmgn_token_info_sample',market:{poolAddress:pool}},undefined);
  const review=readExitQualityReview(path,{asOf:iso(now+3600_000),sinceAt:iso(start)}),quality=review.cases[0].quality;
  assert.equal(quality.equityPeak.samples,2000);assert.equal(quality.equityPeak.reason,'PRE_EXIT_SAMPLE_LIMIT');
  assert.equal(quality.afterExit[0].status,'valid');assert.equal(quality.afterExit[0].tokenMovePct,100);
  assert.equal(review.summary.equityGiveback.denominator,0);assert.equal(review.summary.afterExit[0].denominator,1);
});
