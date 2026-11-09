import test from 'node:test';
import assert from 'node:assert/strict';
import {DebotPublicFallback} from '../src/debot-public-fallback.js';
import type {DebotSignalObservation,NormalizedDebotSignals} from '../src/providers/debot-signals.js';

const at='2026-10-15T00:00:00.000Z';
const observation:DebotSignalObservation={id:'one',observedAt:at,walletCount:1,addressCount:0,aliases:[],
  signal:{source:'debot',sourceEventId:'debot:signal:one',token:{chain:'bsc',address:'0x'+'1'.repeat(40)},
    occurredAt:at,text:'test',claim:'unspecified',evidenceUrls:[]}};
const page:NormalizedDebotSignals={observations:[observation],received:1,rejected:0};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('public fallback runs only while authentication is required and labels every page research-only',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let authRequired=false,fetches=0;
  const pages:NormalizedDebotSignals[]=[];
  const fallback=new DebotPublicFallback({chains:['bsc'],intervalMs:30_000,shouldPoll:()=>authRequired,
    fetchPage:async()=>{fetches++;return page;},onPage:value=>{pages.push(value);}});
  try {
    fallback.start();t.mock.timers.tick(0);await flush();assert.equal(fetches,0);
    authRequired=true;fallback.poke();t.mock.timers.tick(0);await flush();
    assert.equal(fetches,1);assert.equal(pages.length,1);
    assert.equal(pages[0].observations[0].delivery,'public_delayed_poll');
    assert.equal(fallback.status().active,true);assert.equal(fallback.status().received,1);

    authRequired=false;t.mock.timers.tick(30_000);await flush();assert.equal(fetches,1);
    assert.equal(fallback.status().active,false);
  }finally{await fallback.stop();}
});
