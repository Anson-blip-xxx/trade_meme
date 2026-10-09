import test from 'node:test';
import assert from 'node:assert/strict';
import {SystemMonitor,type HostSample} from '../src/system-monitor.js';

const sample=(idle=1000,total=2000,cores=2):HostSample=>({cpu:{idle,total,cores},
  memory:{totalBytes:8000,availableBytes:5000,usedBytes:3000,processRssBytes:200},
  disk:{totalBytes:10000,freeBytes:4000,usedBytes:6000},warnings:[]});
test('system metrics use CPU interval deltas, not lifetime averages, and page reads stay cached',async()=>{
  let at=Date.parse('2026-10-09T00:00:00Z'),reads=0,next=sample();
  const monitor=new SystemMonitor('unused',{read:async()=>{reads++;return next;},now:()=>new Date(at),uptime:()=>40});
  try {
    assert.equal(monitor.get().status,'loading');await monitor.runOnce();assert.equal(monitor.get().cpu.usagePct,null);
    at+=15000;next=sample(1300,2600);await monitor.runOnce();
    const result=monitor.get();assert.equal(result.cpu.usagePct,50);assert.equal(result.cpu.windowSec,15);assert.equal(result.uptimeSec,40);
    result.memory!.usedBytes=0;assert.equal(monitor.get().memory!.usedBytes,3000);assert.equal(reads,2);
    at+=15000;next=sample(10,20);await monitor.runOnce();assert.equal(monitor.get().cpu.usagePct,null);
    at+=15000;next=sample(100,200,4);await monitor.runOnce();assert.equal(monitor.get().cpu.usagePct,null);
  } finally {await monitor.stop();}
});
test('sampling coalesces overlap and failure preserves timestamp without exposing exception content',async()=>{
  let resolve!:(value:HostSample)=>void,fail=false,calls=0;
  const monitor=new SystemMonitor('private-path',{read:()=>{calls++;if(fail)throw new Error('SECRET_PRIVATE_PATH');return new Promise(done=>{resolve=done;});}});
  try {
    const a=monitor.runOnce(),b=monitor.runOnce();assert.equal(calls,1);resolve(sample());await Promise.all([a,b]);
    const at=monitor.get().sampledAt;fail=true;await monitor.runOnce();
    assert.equal(monitor.get().status,'partial');assert.equal(monitor.get().sampledAt,at);
    assert.deepEqual(monitor.get().warnings,['SYSTEM_STATS_UNAVAILABLE']);assert.doesNotMatch(JSON.stringify(monitor.get()),/SECRET|private-path/);
  } finally {await monitor.stop();}
});
test('unreadable storage reports a partial local sample and never fabricates free space',async()=>{
  const monitor=new SystemMonitor('/nonexistent-meme-test-storage-path');
  try {await monitor.runOnce();const state=monitor.get();assert.equal(state.status,'partial');assert.equal(state.disk,undefined);
    assert.deepEqual(state.warnings,['DISK_STATS_UNAVAILABLE']);assert.ok(state.memory!.totalBytes>0);assert.ok(state.memory!.availableBytes>=0);}
  finally {await monitor.stop();}
});
