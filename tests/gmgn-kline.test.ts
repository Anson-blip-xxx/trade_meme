import assert from 'node:assert/strict';
import test from 'node:test';
import {gmgnKlineBarrierOrder,gmgnKlineMomentum,normalizeGmgnKline} from '../src/gmgn-kline.js';

const token={chain:'solana' as const,address:'So11111111111111111111111111111111111111112'};
const request={token,resolution:'30s' as const,fromAt:'2026-11-04T00:00:00.000Z',untilAt:'2026-11-04T00:03:00.000Z',
  receivedAt:'2026-11-04T00:03:01.000Z'};
const row=(time:number,open:string,high:string,low:string,close:string)=>({time,open,high,low,close,volume:'12.5',amount:'30000',source:''});

test('normalizes real GMGN millisecond candles, sorts and keeps raw ambiguous volume fields',()=>{
  const window=normalizeGmgnKline({list:[
    row(Date.parse('2026-11-04T00:00:30Z'),'2','2.2','1.9','2.1'),
    row(Date.parse('2026-11-04T00:00:00Z'),'1','2','0.9','2'),
    row(Date.parse('2026-11-04T00:01:00Z'),'2.1','2.1','2','2'),
  ]},request);
  assert.deepEqual(window.candles.map(candle=>candle.openAt),[
    '2026-11-04T00:00:00.000Z','2026-11-04T00:00:30.000Z','2026-11-04T00:01:00.000Z']);
  assert.equal(window.candles[0].reportedVolume,12.5);assert.equal(window.candles[0].reportedAmount,30000);
  assert.equal(window.diagnostics.invalidRows,0);
});

test('also accepts documented epoch seconds and excludes partial or boundary-straddling candles',()=>{
  const window=normalizeGmgnKline({list:[
    row(Date.parse('2026-11-03T23:59:30Z')/1000,'1','1','1','1'),
    row(Date.parse('2026-11-04T00:00:00Z')/1000,'1','1.1','0.9','1'),
    row(Date.parse('2026-11-04T00:02:30Z')/1000,'1','1.1','0.9','1'),
  ]},{...request,receivedAt:'2026-11-04T00:02:45.000Z',untilAt:'2026-11-04T00:02:45.000Z'});
  assert.deepEqual(window.candles.map(candle=>candle.openAt),['2026-11-04T00:00:00.000Z']);
  assert.equal(window.diagnostics.outsideRows,1);assert.equal(window.diagnostics.openRows,1);
});

test('drops malformed OHLC and divergent duplicate timestamps without choosing a value',()=>{
  const at=Date.parse('2026-11-04T00:00:00Z');
  const window=normalizeGmgnKline({list:[
    row(at,'1','0.9','0.8','1'),
    row(at+30_000,'1','1.2','0.9','1.1'),
    row(at+30_000,'1','1.3','0.9','1.1'),
    row(at+60_000,'1.1','1.2','1','1.15'),
    row(at+60_000,'1.1','1.2','1','1.15'),
  ]},request);
  assert.deepEqual(window.candles.map(candle=>candle.openAt),['2026-11-04T00:01:00.000Z']);
  assert.equal(window.diagnostics.invalidRows,1);assert.equal(window.diagnostics.conflictRows,1);assert.equal(window.diagnostics.duplicateRows,1);
});

test('rejects response and request shapes outside bounded historical use',()=>{
  assert.throws(()=>normalizeGmgnKline({},request),/GMGN_KLINE_RESPONSE_INVALID/);
  assert.throws(()=>normalizeGmgnKline({list:[]},{...request,untilAt:'2026-11-04T00:04:00Z'}),/GMGN_KLINE_REQUEST_INVALID/);
  assert.throws(()=>normalizeGmgnKline({list:Array(5001).fill({})},request),/GMGN_KLINE_RESPONSE_INVALID/);
});

test('retrospective barriers preserve target/stop order and same-candle ambiguity',()=>{
  const at=Date.parse('2026-11-04T00:00:00Z');
  const target=normalizeGmgnKline({list:[
    row(at,'1','1.2','0.8','1.1'),row(at+30_000,'1.1','2.1','1','2'),row(at+60_000,'2','2.2','0.3','1'),
  ]},request);
  assert.equal(gmgnKlineBarrierOrder(target,{baselinePrice:1,fromAt:request.fromAt,untilAt:request.untilAt}).order,'target_first');
  const ambiguous=normalizeGmgnKline({list:[row(at,'1','2.1','0.3','1')]},request);
  assert.equal(gmgnKlineBarrierOrder(ambiguous,{baselinePrice:1,fromAt:request.fromAt,untilAt:request.untilAt}).order,'same_candle_ambiguous');
});

test('barrier result stays unknown when an earlier coverage gap could reverse the order',()=>{
  const at=Date.parse('2026-11-04T00:00:00Z');
  const window=normalizeGmgnKline({list:[row(at,'1','1.1','0.9','1'),row(at+60_000,'1','2.1','0.9','2')]},request);
  const result=gmgnKlineBarrierOrder(window,{baselinePrice:1,fromAt:request.fromAt,untilAt:request.untilAt});
  assert.equal(result.order,'unknown');assert.equal(result.reason,'COVERAGE_GAP');
});

test('momentum uses only candles closed by its as-of cutoff',()=>{
  const at=Date.parse('2026-11-04T00:00:00Z');
  const window=normalizeGmgnKline({list:[
    row(at,'1','1.1','0.9','1'),row(at+30_000,'1','1.3','1','1.2'),row(at+60_000,'1.2','10','1','9'),
  ]},request);
  const momentum=gmgnKlineMomentum(window,'2026-11-04T00:01:00.000Z');
  assert.ok(momentum);assert.equal(momentum.candles,2);assert.ok(Math.abs(momentum.changePct-20)<1e-9);
});
