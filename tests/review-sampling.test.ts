import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,readdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildReviewSamplingPlan,validateReviewSamplingPlan,writeReviewSamplingPlan,ReviewSamplingPlanReader} from '../src/review-sampling.js';
const origin=Date.parse('2026-10-16T09:00:00.000Z'),at=(sec=0)=>new Date(origin+sec*1000).toISOString();
const input=()=>({asOf:at(),windowEndAt:at(-3600),cohorts:[{chain:'bsc' as const,source:'debot' as const,total:100,covered:10},{chain:'solana' as const,source:'ave' as const,total:20,covered:20}]});

test('plans use complete coverage gaps only, canonical order and a fixed 48-hour forward lifetime',()=>{
  const plan=buildReviewSamplingPlan(input());assert.equal(plan.scope,'research_sampling_only');assert.equal(plan.effectiveAt,at());assert.equal(plan.expiresAt,at(48*3600));
  assert.deepEqual(plan.cohorts.map(c=>[c.missing,c.weight]),[[90,2],[0,1]]);
  assert.deepEqual(buildReviewSamplingPlan({...input(),cohorts:input().cohorts.reverse()}),plan);
  assert.deepEqual(buildReviewSamplingPlan({...input(),cohorts:input().cohorts.map(c=>({...c,maxGainPct:100000,score:100}))}),plan);
  assert.deepEqual(buildReviewSamplingPlan({...input(),cohorts:input().cohorts.map(c=>({...c,maxGainPct:-100,score:0}))}),plan);
  assert.deepEqual(validateReviewSamplingPlan(JSON.parse(JSON.stringify(plan))),plan);
  assert.equal(buildReviewSamplingPlan({...input(),cohorts:[{chain:'bsc',source:'manual',total:0,covered:0}]}).cohorts[0].weight,1);
});
test('invalid counts, duplicate cohorts, future input windows and altered derived fields are rejected',()=>{
  for(const c of [{total:-1,covered:0},{total:10,covered:11},{total:1.5,covered:1},{total:NaN,covered:0}])
    assert.throws(()=>buildReviewSamplingPlan({...input(),cohorts:[{chain:'bsc',source:'debot',...c}]}));
  assert.throws(()=>buildReviewSamplingPlan({...input(),windowEndAt:at(1)}));
  assert.throws(()=>buildReviewSamplingPlan({...input(),asOf:'2026-02-30T00:00:00.000Z'}));
  assert.throws(()=>buildReviewSamplingPlan({...input(),cohorts:[input().cohorts[0],input().cohorts[0]]}));
  const plan=buildReviewSamplingPlan(input());
  for(const changed of [{...plan,fairShare:0},{...plan,scope:'trading'},{...plan,expiresAt:at(48*3600+1)},
    {...plan,entryMode:'live'},{...plan,id:'forged'},{...plan,cohorts:plan.cohorts.map(c=>({...c,weight:1}))}])assert.equal(validateReviewSamplingPlan(changed),undefined);
});
test('atomic private publication, bounded cached reads and immediate clock validity checks',()=>{
  const dir=mkdtempSync(join(tmpdir(),'review-plan-')),path=join(dir,'private','plan.json');let seconds=0;
  try{
    const reader=new ReviewSamplingPlanReader(path,{now:()=>new Date(at(seconds))});assert.equal(reader.read().status,'missing');
    const plan=buildReviewSamplingPlan(input());writeReviewSamplingPlan(path,plan);assert.equal(statSync(path).mode&0o777,0o600);assert.equal(statSync(join(dir,'private')).mode&0o777,0o700);
    assert.equal(reader.read().status,'missing');seconds=30;assert.deepEqual(reader.read().plan,plan);
    const returned=reader.read();returned.plan!.cohorts[0].total=999;assert.equal(reader.read().plan!.cohorts[0].total,100);
    writeFileSync(path,'broken');seconds=59;assert.equal(reader.read().status,'active');seconds=60;assert.equal(reader.read().status,'invalid');
    writeReviewSamplingPlan(path,plan);seconds=90;assert.equal(reader.read().status,'active');
    seconds=48*3600-1;assert.equal(reader.read().status,'active');seconds=48*3600;assert.equal(reader.read().status,'expired');
    seconds=-1;assert.equal(reader.read().status,'future');seconds=0;assert.equal(reader.read().status,'active');
    assert.deepEqual(readdirSync(join(dir,'private')),['plan.json']);assert.equal(JSON.parse(readFileSync(path,'utf8')).id,plan.id);
    assert.throws(()=>writeReviewSamplingPlan(path,{...plan,fairShare:0} as never));assert.equal(JSON.parse(readFileSync(path,'utf8')).id,plan.id);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('oversized and symlinked plans fail closed; no path is a disabled feature',()=>{
  const dir=mkdtempSync(join(tmpdir(),'review-plan-')),path=join(dir,'plan');
  try{
    assert.equal(new ReviewSamplingPlanReader().read().status,'disabled');writeFileSync(path,'x'.repeat(65537));
    assert.equal(new ReviewSamplingPlanReader(path).read().status,'invalid');symlinkSync(path,join(dir,'link'));
    assert.equal(new ReviewSamplingPlanReader(join(dir,'link')).read().status,'unavailable');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
