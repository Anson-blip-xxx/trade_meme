import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {buildShadowPolicyCandidates,readMatureFollowupSamples,type ShadowPolicySample} from '../src/shadow-policy-candidate.js';
import {ShadowPolicyCandidateStore} from '../src/shadow-policy-candidate-store.js';
import {buildNotificationTriggerCandidates} from '../src/notification-trigger-candidate.js';
import type {NotificationTriggerOutcome} from '../src/notification-outcomes.js';

const origin=Date.parse('2026-01-01T00:00:00.000Z'),iso=(ms:number)=>new Date(origin+ms).toISOString();
function sample(n:number,options:{spacingHours?:number;covered?:boolean;reverseValidation?:boolean}={}):ShadowPolicySample {
  const spacing=(options.spacingHours??8)*3600_000,registered=origin+n*spacing,feature=n%2===0;
  const late=options.reverseValidation&&n>=240,gain=feature?(late?-50:50):0;
  return {id:`sample-${n}`,chain:'solana',decision:'BUY_CANDIDATE',policyVersion:'entry-v1',registeredAt:new Date(registered).toISOString(),
    matureAt:new Date(registered+(21600+600)*1000).toISOString(),
    ...(options.covered===false?{}:{outcomeAt:new Date(registered+21600_000).toISOString(),gainPct:gain}),
    features:{two_wallet_groups:feature,positive_net_buy:feature,social_link:feature,precursor_setup:feature,public_entry_setup:feature}};
}
const asOf=(rows:ShadowPolicySample[])=>new Date(Date.parse(rows.at(-1)!.matureAt)+1000).toISOString();

test('a versioned candidate uses mature forward samples, a chronological holdout and exactly one shadow-only change',()=>{
  const rows=Array.from({length:300},(_,n)=>sample(n,{covered:n%20!==0}));
  const candidates=buildShadowPolicyCandidates({asOf:asOf(rows),samples:rows});
  const value=candidates.find(candidate=>candidate.change.parameter==='entry.require_positive_net_buy')!;
  assert.equal(candidates.length,4);assert.equal(value.status,'shadow_ready');assert.equal(value.evidence.mature,300);
  assert.equal(value.evidence.coveragePct,95);assert.equal(value.evidence.train.total,240);assert.equal(value.evidence.validation.total,60);
  assert.equal(value.evidence.purgedTraining,0);assert.equal(value.change.from,false);assert.equal(value.change.to,true);
  assert.equal(Object.keys(value.change).length,4);assert.equal(value.mode,'shadow');assert.equal(value.execution,'observation_only');
  assert.equal(value.livePolicyMutation,'forbidden');assert.equal(value.promotion,'manual_review_only_after_forward_shadow');
  assert.match(value.candidatePolicyVersion,/^shadow-entry-[a-f0-9]{16}$/);assert.match(value.id,/^[a-f0-9]{64}$/);
  assert.ok(value.evidence.validation.deltas.medianGainPct!>0);assert.ok(value.evidence.validation.deltas.p10GainPct!>=-5);
});

test('minimum 200 and 90% coverage gates collect instead of inventing a policy result',()=>{
  const small=Array.from({length:199},(_,n)=>sample(n));
  const a=buildShadowPolicyCandidates({asOf:asOf(small),samples:small})[0];
  assert.equal(a.status,'collecting');assert.ok(a.reasons.includes('MINIMUM_MATURE_SAMPLES_NOT_MET'));
  const sparse=Array.from({length:300},(_,n)=>sample(n,{covered:n%10!==0&&n%10!==1}));
  const b=buildShadowPolicyCandidates({asOf:asOf(sparse),samples:sparse})[0];
  assert.equal(b.evidence.coveragePct,80);assert.equal(b.status,'collecting');assert.ok(b.reasons.includes('MINIMUM_COVERAGE_NOT_MET'));
});

test('a chronological reversal is not promoted and overlapping training outcomes are purged',()=>{
  const reversed=Array.from({length:300},(_,n)=>sample(n,{reverseValidation:true}));
  const value=buildShadowPolicyCandidates({asOf:asOf(reversed),samples:reversed})[0];
  assert.equal(value.status,'not_replicated');assert.ok(value.reasons.includes('VALIDATION_IMPROVEMENT_NOT_OBSERVED'));
  const dense=Array.from({length:300},(_,n)=>sample(n,{spacingHours:1/60}));
  const purged=buildShadowPolicyCandidates({asOf:asOf(dense),samples:dense})[0];
  assert.equal(purged.evidence.purgedTraining,240);assert.equal(purged.evidence.train.total,0);assert.equal(purged.status,'collecting');
});

test('reader accepts only mature compact first-feature evidence and never converts missing outcomes to losses',t=>{
  const dir=mkdtempSync(join(tmpdir(),'shadow-policy-reader-')),path=join(dir,'archive.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=new DatabaseSync(path);db.exec(`CREATE TABLE signal_followups(chain TEXT,address TEXT,registered_at TEXT,summary_record TEXT)`);
  const insert=db.prepare('INSERT INTO signal_followups VALUES(?,?,?,?)'),registered=iso(0),base={
    initial:{decision:'BUY_CANDIDATE',policyVersion:'entry-v1',features:{two_wallet_groups:true,positive_net_buy:true,social_link:false,precursor_setup:null,public_entry_setup:false}},
    performance:{baselineDelayed:false},horizons:{'21600':{at:iso(21600_000),gainPct:25}}};
  insert.run('solana','one',registered,JSON.stringify(base));
  insert.run('solana','missing',registered,JSON.stringify({...base,horizons:{}}));
  insert.run('solana','delayed',registered,JSON.stringify({...base,performance:{baselineDelayed:true}}));
  insert.run('solana','future',iso(24*3600_000),JSON.stringify(base));db.close();
  const rows=readMatureFollowupSamples(path,iso((21600+600)*1000));
  assert.equal(rows.length,3);assert.equal(rows.find(row=>row.id.endsWith(':one'))?.gainPct,25);
  assert.equal(rows.find(row=>row.id.endsWith(':missing'))?.gainPct,undefined);
  assert.equal(rows.find(row=>row.id.endsWith(':delayed'))?.gainPct,undefined);
  assert.equal(rows.find(row=>row.id.endsWith(':future')),undefined);
});

test('candidate ledger is private, immutable and contains no active policy interface',t=>{
  const dir=mkdtempSync(join(tmpdir(),'shadow-policy-store-')),path=join(dir,'review.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const rows=Array.from({length:300},(_,n)=>sample(n)),candidate=buildShadowPolicyCandidates({asOf:asOf(rows),samples:rows})[0];
  const store=new ShadowPolicyCandidateStore(path);t.after(()=>store.close());
  const triggerAt=iso(0),endsAt=iso(21600_000),triggerRows=[3,4].map(notificationNumber=>({source:'debot',chain:'solana',address:'token',
    sessionFirstReceivedAt:triggerAt,sessionExpiresAt:endsAt,notificationNumber,triggerEventId:String(notificationNumber),triggerAt,
    triggerOrderAmbiguous:false,horizons:[{seconds:21600,endsAt,mature:true,status:'covered',maxGainPct:10,minGainPct:-10,endGainPct:5,
      sampledBarrierOrder:'neither'}]})) as NotificationTriggerOutcome[];
  const trigger=buildNotificationTriggerCandidates({asOf:iso(21601_000),outcomes:triggerRows})[0];
  assert.equal(store.saveAll([candidate,trigger]),2);assert.equal(store.saveAll([candidate,trigger]),0);assert.equal(statSync(path).mode&0o777,0o600);
  const page=store.latest();assert.equal(page.items.length,2);assert.ok(page.items.some(row=>row.id===candidate.id));assert.ok(page.items.some(row=>row.id===trigger.id));
  assert.equal('activate' in store,false);assert.equal('apply' in store,false);assert.equal('currentPolicy' in store,false);
  assert.throws(()=>store.saveAll([{...candidate,mode:'live'} as never]),/SHADOW_POLICY_STORE_INVALID/);
});
