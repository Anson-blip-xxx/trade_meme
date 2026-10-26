import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {NativeLandingTelemetry,SOLANA_BLOCK_TIME_PRECISION_MS} from '../src/native-solana/landing-telemetry.js';

const signature=bs58.encode(new Uint8Array(64).fill(7));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

class Socket extends EventTarget {
  readyState=0;
  sent:Array<{jsonrpc:string;id:number;method:string;params:any[]}>=[];
  send(value:string){this.sent.push(JSON.parse(value));}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
  close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
  frame(value:object){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({jsonrpc:'2.0',...value})}));}
  ack(request:Socket['sent'][number],result=100+request.id){this.frame({id:request.id,result});}
  health(){const request=this.sent.find(row=>row.method==='slotSubscribe');assert.ok(request);this.ack(request);}
  signatureRequests(){return this.sent.filter(row=>row.method==='signatureSubscribe');}
  ackSignatures(){for(const request of this.signatureRequests())this.ack(request);}
  notify(commitment:string,slot:number,err:unknown=null){
    const request=this.signatureRequests().find(row=>row.params[1]?.commitment===commitment);assert.ok(request);
    this.frame({method:'signatureNotification',params:{subscription:100+request.id,result:{context:{slot},value:{err}}}});
  }
}

function fixture(){
  let wall=Date.parse('2026-10-26T03:00:00.000Z'),mono=100;
  const sockets:Socket[]=[],updates:unknown[]=[];
  const telemetry=new NativeLandingTelemetry('wss://rpc.test',()=>{const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;},
    {now:()=>new Date(wall),monotonicNow:()=>mono,armTimeoutMs:1000,reconnectMs:10,onUpdate:value=>updates.push(value)});
  return {telemetry,sockets,updates,set:(elapsed:number)=>{wall=Date.parse('2026-10-26T03:00:00.000Z')+elapsed;mono=100+elapsed;}};
}

test('arms processed, confirmed and finalized subscriptions before broadcast and measures first observations monotonically',async()=>{
  const f=fixture(),trace=f.telemetry.begin();
  const armed=trace.arm(signature),socket=f.sockets[0];socket.open();socket.health();await tick();
  assert.deepEqual(socket.signatureRequests().map(row=>row.params[1].commitment),['processed','confirmed','finalized']);
  assert.ok(socket.signatureRequests().every(row=>row.params[0]===signature&&row.params[1].enableReceivedNotification===false));
  assert.throws(()=>trace.markBroadcast(),/NATIVE_LANDING_TRACE_STATE_INVALID/,'broadcast cannot precede subscription ACKs');
  f.set(5);socket.ackSignatures();await armed;
  f.set(8);trace.markBroadcast();f.set(18);trace.markJitoAcknowledged();
  f.set(208);socket.notify('processed',901);f.set(408);socket.notify('confirmed',902);f.set(1208);socket.notify('finalized',903);
  const result=trace.snapshot();
  assert.deepEqual({arm:result.subscriptionArmAfterStartedMs,broadcast:result.broadcastAfterStartedMs,
    ackStart:result.jitoAckAfterStartedMs,ackBroadcast:result.jitoAckAfterBroadcastMs},{arm:5,broadcast:8,ackStart:18,ackBroadcast:10});
  assert.deepEqual([result.processed?.observedAfterBroadcastMs,result.confirmed?.observedAfterBroadcastMs,result.finalized?.observedAfterBroadcastMs],[200,400,1200]);
  assert.deepEqual([result.processed?.slot,result.confirmed?.slot,result.finalized?.slot],[901,902,903]);
  assert.ok([result.processed,result.confirmed,result.finalized].every(row=>row?.precise===true&&row.failed===false));
  assert.equal(result.blockTimePrecisionMs,SOLANA_BLOCK_TIME_PRECISION_MS);
  assert.equal(SOLANA_BLOCK_TIME_PRECISION_MS,1000);
  assert.equal(Object.hasOwn(result,'blockTime'),false,'second-resolution blockTime is never presented as landing latency');
  assert.equal(f.telemetry.status().active,0,'finalized one-shot watch is released');
  f.telemetry.stop();
});

test('a signature subscription rejection fails arming and leaves no active trace',async()=>{
  const f=fixture(),trace=f.telemetry.begin(),armed=trace.arm(signature),socket=f.sockets[0];socket.open();socket.health();await tick();
  const requests=socket.signatureRequests();assert.equal(requests.length,3);
  socket.ack(requests[0]);socket.frame({id:requests[1].id,error:{code:-32602,message:'invalid'}});socket.ack(requests[2]);
  await assert.rejects(armed,/NATIVE_LANDING_SUBSCRIBE_REJECTED/);
  assert.equal(f.telemetry.status().active,0);assert.throws(()=>trace.markBroadcast(),/NATIVE_LANDING_TRACE_STATE_INVALID/);
  f.telemetry.stop();
});

test('disconnect after broadcast marks later observations as upper bounds and rearms missing commitments',async()=>{
  const f=fixture(),trace=f.telemetry.begin(),armed=trace.arm(signature),first=f.sockets[0];first.open();first.health();await tick();first.ackSignatures();await armed;
  f.set(10);trace.markBroadcast();f.set(15);trace.markJitoAcknowledged();f.set(100);first.notify('processed',1000);
  first.close();assert.equal(trace.snapshot().transportGap,true);
  await new Promise(resolve=>setTimeout(resolve,20));const second=f.sockets[1];assert.ok(second);second.open();second.health();await tick();
  assert.deepEqual(second.signatureRequests().map(row=>row.params[1].commitment),['confirmed','finalized']);second.ackSignatures();
  f.set(500);second.notify('confirmed',1001);f.set(900);second.notify('finalized',1002);
  const result=trace.snapshot();assert.equal(result.processed?.precise,true);assert.equal(result.confirmed?.precise,false);assert.equal(result.finalized?.precise,false);
  assert.deepEqual([result.processed?.observedAfterBroadcastMs,result.confirmed?.observedAfterBroadcastMs,result.finalized?.observedAfterBroadcastMs],[90,490,890]);
  f.telemetry.stop();
});

test('backwards monotonic time is explicit and never emits a negative duration',async()=>{
  const f=fixture(),trace=f.telemetry.begin(),armed=trace.arm(signature),socket=f.sockets[0];socket.open();socket.health();await tick();
  f.set(5);socket.ackSignatures();await armed;f.set(10);trace.markBroadcast();f.set(-1);trace.markJitoAcknowledged();
  const result=trace.snapshot();assert.equal(result.clockInvalid,true);assert.equal(result.jitoAckAfterStartedMs,undefined);assert.equal(result.jitoAckAfterBroadcastMs,undefined);
  assert.ok(Object.values(result).every(value=>typeof value!=='number'||value>=0));trace.close();f.telemetry.stop();
});

test('invalid endpoint, signature and post-stop use fail closed without opening a broadcast window',async()=>{
  assert.throws(()=>new NativeLandingTelemetry('https://rpc.test'),/NATIVE_LANDING_WS_URL_INVALID/);
  const f=fixture(),trace=f.telemetry.begin();await assert.rejects(trace.arm('not-a-signature'),/NATIVE_LANDING_SIGNATURE_INVALID/);
  assert.throws(()=>trace.markBroadcast(),/NATIVE_LANDING_TRACE_STATE_INVALID/);f.telemetry.stop();
  assert.throws(()=>f.telemetry.begin(),/NATIVE_LANDING_STOPPED/);await assert.rejects(f.telemetry.warmup(),/NATIVE_LANDING_STOPPED/);
});
