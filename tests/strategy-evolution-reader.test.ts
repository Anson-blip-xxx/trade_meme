import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StrategyEvolutionSignalLedger} from '../src/strategy-evolution-signals.js';
import {StrategyEvolutionStore} from '../src/strategy-evolution-store.js';
import {readStrategyEvolutionCandidates,readStrategyEvolutionStatus} from '../src/strategy-evolution-reader.js';
import type {Signal} from '../src/types.js';

test('read-only evolution views expose bounded research state without execution controls',t=>{
  const dir=mkdtempSync(join(tmpdir(),'strategy-evolution-reader-')),path=join(dir,'evolution.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const at='2026-11-13T00:00:00.000Z',ledger=new StrategyEvolutionSignalLedger(path,{now:()=>new Date(at)});
  ledger.record({signal:{source:'debot',sourceEventId:'event-1',occurredAt:at,token:{chain:'bsc',address:'0x'+'a'.repeat(40)},text:''} as Signal,observedAt:at});
  ledger.markDailyRun({at,status:'succeeded'});ledger.close();
  const store=new StrategyEvolutionStore(path,{now:()=>new Date(at)}),candidate=store.registerCandidate({evidenceCutoff:'2026-11-12T23:59:59.999Z',effectiveAt:at,
    scope:{family:'test',chain:'bsc'},championPolicy:{n:3},challengerPolicy:{n:4}},at);store.beginForwardShadow(candidate.id,at);store.close();
  const status=readStrategyEvolutionStatus(path);assert.equal(status.execution,'observation_only');assert.equal(status.liveMutation,'forbidden');
  assert.equal(status.signals.events,1);assert.equal(status.candidates.forwardShadow,1);assert.deepEqual(status.lastDailyRun,{at,status:'succeeded'});
  const page=readStrategyEvolutionCandidates(path,{limit:1,offset:0,chain:'bsc'});assert.equal(page.total,1);assert.equal(page.items[0].id,candidate.id);
  assert.equal(Object.keys(status).some(key=>/buy|sell|order|trade/i.test(key)),false);
});

test('missing evolution storage returns an explicit empty research view',t=>{
  const dir=mkdtempSync(join(tmpdir(),'strategy-evolution-missing-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const status=readStrategyEvolutionStatus(join(dir,'missing.sqlite'));assert.equal(status.enabled,false);assert.equal(status.signals.events,0);
});

test('corrupt evolution storage is reported as degraded rather than disabled',t=>{
  const dir=mkdtempSync(join(tmpdir(),'strategy-evolution-corrupt-')),path=join(dir,'broken.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(path,'not a sqlite database');
  const status=readStrategyEvolutionStatus(path);assert.equal(status.enabled,true);assert.equal(status.state,'degraded');
  assert.equal(status.error,'STRATEGY_EVOLUTION_READ_FAILED');
});
