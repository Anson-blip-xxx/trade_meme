import test from 'node:test';
import assert from 'node:assert/strict';
import {ADAPTIVE_SHADOW_V3,stepAdaptiveExit,type AdaptiveExitState} from '../src/adaptive-exit.js';
import {shadowReturn} from '../src/exit-shadow-return.js';
import type {ShadowEvent} from '../src/exit-shadow.js';

const origin=Date.parse('2026-10-18T00:00:00.000Z');
function episode(prices:number[]){
  let state:AdaptiveExitState|undefined;const events:ShadowEvent[]=[];
  for(const [index,priceUsd] of prices.entries()){
    const observedAt=new Date(origin+index*60_000).toISOString();
    const step=stepAdaptiveExit(state,{chain:'bsc',address:`0x${'a'.repeat(40)}`,priceUsd,observedAt,evaluatedAt:observedAt,source:'gmgn_token_info_sample'},undefined,ADAPTIVE_SHADOW_V3);
    state=step.state!;
    if(step.event){const e=step.event;events.push({at:e.observedAt,kind:e.kind,observationOnly:true,reason:e.reasons[0],priceUsd:e.observedPriceUsd,sellPct:e.sellPctRemaining,remainingPct:e.remainingPctOfInitial});}
  }
  return {state:state!,events};
}
function result(values:number[],health:'fresh'|'stale'|'unavailable'='fresh'){
  const {state,events}=episode(values);return shadowReturn(state,events,{priceUsd:state.lastPriceUsd,at:state.lastObservedAt,health});
}
const approx=(actual:number|undefined,expected:number)=>assert.ok(actual!==undefined&&Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);

test('remaining-balance stages produce initial-principal weighted realized, floating and total returns',()=>{
  const value=result([100,600,1100]);
  assert.equal(value.status,'open');assert.equal(value.basis,'initial_principal_pct');assert.equal(value.costsIncluded,false);
  approx(value.realizedGainPct,180);approx(value.unrealizedGainPct,720);approx(value.totalGainPct,900);
  approx(value.remainingPctOfInitial,72);approx(value.soldPctOfInitial,28);assert.equal(value.finalGainPct,undefined);
  assert.deepEqual(value.exits.map(exit=>exit.soldPctOfInitial),[20,8]);
});
test('a fully exited episode freezes its weighted final return independently of later comparison quotes',()=>{
  const {state,events}=episode([100,600,1100,800]);assert.equal(state.shadowClosed,true);
  const value=shadowReturn(state,events,{priceUsd:5000,at:new Date(origin+86400_000).toISOString(),health:'stale'});
  assert.equal(value.status,'closed');assert.equal(value.valuationStatus,'closed');approx(value.finalGainPct,684);
  approx(value.realizedGainPct,684);approx(value.unrealizedGainPct,0);assert.equal(value.closedAt,state.lastObservedAt);
  assert.equal(value.exits[2].soldPctOfInitial,72);
});
test('one quote jumping over both stages honors its combined 28 percent exit',()=>{
  const value=result([100,1100]);assert.equal(value.exits.length,1);
  approx(value.realizedGainPct,280);approx(value.unrealizedGainPct,720);approx(value.totalGainPct,1000);
  approx(value.exits[0].sellPctRemaining,28);approx(value.remainingPctOfInitial,72);
});
test('an all-position stop reports actual observed loss rather than the ideal stop trigger price',()=>{
  const value=result([100,45]);assert.equal(value.status,'closed');approx(value.finalGainPct,-55);approx(value.unrealizedGainPct,0);
});
test('no exit is a known zero realized return and a separately marked open floating return',()=>{
  const value=result([100,110]);assert.equal(value.status,'open');approx(value.realizedGainPct,0);approx(value.unrealizedGainPct,10);
  assert.equal(value.finalGainPct,undefined);assert.equal(value.exits.length,0);
});
test('missing or stale quotes preserve known partial exits but cannot create current floating or final returns',()=>{
  for(const health of ['stale','unavailable'] as const){
    const value=result([100,600],health);assert.equal(value.status,'open');approx(value.realizedGainPct,100);
    assert.equal(value.unrealizedGainPct,undefined);assert.equal(value.totalGainPct,undefined);assert.equal(value.finalGainPct,undefined);
    assert.equal(value.reason,'RETURN_QUOTE_UNAVAILABLE');
  }
});
test('duplicate identical events are idempotent and conflicting repeats are unavailable',()=>{
  const {state,events}=episode([100,600,1100]);const quote={priceUsd:state.lastPriceUsd,at:state.lastObservedAt,health:'fresh' as const};
  const duplicate=shadowReturn(state,[events[0],events[0],events[1]],quote);approx(duplicate.realizedGainPct,180);assert.equal(duplicate.exits.length,2);
  const conflict=shadowReturn(state,[events[0],{...events[0],priceUsd:601},events[1]],quote);
  assert.equal(conflict.status,'unavailable');assert.equal(conflict.realizedGainPct,undefined);
});
test('legacy or truncated histories cannot infer missing partial fills from the final exit alone',()=>{
  const {state,events}=episode([100,600,1100,800]);const quote={priceUsd:800,at:state.lastObservedAt,health:'fresh' as const};
  for(const incomplete of [[],events.slice(1),events.slice(-1)]){
    const value=shadowReturn(state,incomplete,quote);assert.equal(value.status,'unavailable');assert.equal(value.finalGainPct,undefined);
  }
});
test('malformed proportions, prices, future or reordered event times fail without emitting monetary values',()=>{
  const {state,events}=episode([100,600,1100]);const quote={priceUsd:1100,at:state.lastObservedAt,health:'fresh' as const};
  for(const patch of [{sellPct:0},{sellPct:101},{remainingPct:99},{priceUsd:0},{priceUsd:Infinity},{at:'invalid'},{at:new Date(origin+3600_000).toISOString()}]){
    const value=shadowReturn(state,[{...events[0],...patch},events[1]],quote);assert.equal(value.status,'unavailable');assert.equal(value.totalGainPct,undefined);
  }
  assert.equal(shadowReturn(state,[events[1],events[0]],quote).status,'unavailable');
});
test('arithmetic overflow and a falsely closed state cannot become a final gain',()=>{
  const {state,events}=episode([100,45]);const quote={priceUsd:45,at:state.lastObservedAt,health:'fresh' as const};
  assert.equal(shadowReturn({...state,baselinePriceUsd:Number.MIN_VALUE},events,quote).status,'unavailable');
  assert.equal(shadowReturn({...state,remainingPctOfInitial:72},events,quote).status,'unavailable');
});
test('tiny token prices must exactly match the persisted model observation rather than an absolute epsilon',()=>{
  const {state,events}=episode([1e-9,5e-10]);
  const quote={priceUsd:state.lastPriceUsd,at:state.lastObservedAt,health:'fresh' as const};
  approx(shadowReturn(state,events,quote).finalGainPct,-50);
  const changed=shadowReturn(state,[{...events[0],priceUsd:9e-9}],quote);
  assert.equal(changed.status,'unavailable');assert.equal(changed.finalGainPct,undefined);
  const open=episode([1e-9,1.1e-9]);
  const wrongQuote=shadowReturn(open.state,open.events,{priceUsd:9e-9,at:open.state.lastObservedAt,health:'fresh'});
  assert.equal(wrongQuote.unrealizedGainPct,undefined);assert.equal(wrongQuote.totalGainPct,undefined);
  assert.equal(wrongQuote.reason,'RETURN_QUOTE_UNAVAILABLE');
});
