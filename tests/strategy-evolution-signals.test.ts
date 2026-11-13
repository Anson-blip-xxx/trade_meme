import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StrategyEvolutionSignalLedger} from '../src/strategy-evolution-signals.js';
import type {Signal} from '../src/types.js';

const address='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40),start=Date.parse('2026-11-13T00:00:00.000Z');
const at=(hours:number,ms=0)=>new Date(start+hours*3600_000+ms).toISOString();
function signal(source:'debot'|'ave',id:string,occurredAt:string,tokenAddress=address):Signal {return {
  source,sourceEventId:id,occurredAt,token:{chain:'bsc',address:tokenAddress},text:`${source}:${id}:${tokenAddress}`,
} as Signal;}

test('source-separated six-hour sessions continue on new events and replays never increment ordinals',()=>{
  let clock=start;const store=new StrategyEvolutionSignalLedger(':memory:',{now:()=>new Date(clock)});test.after(()=>store.close());
  let result=store.record({signal:signal('debot','d1',at(0)),observedAt:at(0),name:'Alpha'});
  assert.equal(result.created,true);assert.equal(result.event.ordinal,1);const firstSession=result.event.sessionId;
  clock=Date.parse(at(1));result=store.record({signal:signal('debot','d1',at(0)),observedAt:at(1),name:'Alpha',symbol:'ALPHA'});
  assert.equal(result.created,false);assert.equal(result.event.ordinal,1);assert.equal(result.event.name,'Alpha');assert.equal(result.event.symbol,'ALPHA');
  clock=Date.parse(at(2));result=store.record({signal:signal('debot','d2',at(2)),observedAt:at(2)});
  assert.equal(result.event.ordinal,2);assert.equal(result.event.sessionId,firstSession);
  result=store.record({signal:signal('ave','a1',at(2)),observedAt:at(2)});
  assert.equal(result.event.ordinal,1);assert.notEqual(result.event.sessionId,firstSession);
  clock=Date.parse(at(8));result=store.record({signal:signal('debot','d3',at(8)),observedAt:at(8)});
  assert.equal(result.event.ordinal,3);assert.equal(result.event.sessionId,firstSession);
  clock=Date.parse(at(14,1));result=store.record({signal:signal('debot','d4',at(14,1)),observedAt:at(14,1)});
  assert.equal(result.event.ordinal,1);assert.notEqual(result.event.sessionId,firstSession);
  assert.deepEqual(store.status().bySource,{debot:4,ave:1});assert.equal(store.status().events,5);
  store.markDailyRun({at:at(14,1),status:'succeeded'});assert.deepEqual(store.status().lastDailyRun,{at:at(14,1),status:'succeeded'});
});

test('event identity conflicts are rejected and source ledgers expose no execution controls',()=>{
  let clock=start;const store=new StrategyEvolutionSignalLedger(':memory:',{now:()=>new Date(clock)});test.after(()=>store.close());
  store.record({signal:signal('debot','same',at(0)),observedAt:at(0)});clock+=1000;
  assert.throws(()=>store.record({signal:signal('debot','same',at(0),other),observedAt:new Date(clock).toISOString()}),/SIGNAL_CONFLICT/);
  const methods=Object.getOwnPropertyNames(StrategyEvolutionSignalLedger.prototype);
  assert.equal(methods.some(name=>/buy|sell|trade|order|count.*start|enable/i.test(name)),false);
});

test('same-timestamp deliveries retain monotonic ordinals and a daily lease excludes overlapping evaluators',t=>{
  const dir=mkdtempSync(join(tmpdir(),'strategy-evolution-signals-')),path=join(dir,'evolution.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const first=new StrategyEvolutionSignalLedger(path,{now:()=>new Date(start)});
  for(const [index,id] of ['z','a','b'].entries())assert.equal(first.record({signal:signal('ave',id,at(0),other),observedAt:at(0)}).event.ordinal,index+1);
  const lease=first.acquireDailyLease(at(0)),second=new StrategyEvolutionSignalLedger(path,{now:()=>new Date(start)});
  assert.throws(()=>second.acquireDailyLease(at(0)),/RUN_LOCKED/);first.releaseDailyLease(lease);
  const next=second.acquireDailyLease(at(0));second.releaseDailyLease(next);second.close();first.close();
});
