import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');

test('wallet fast page renders each main-thread latency boundary and snapshot phase',()=>{
  for(const field of ['mainThreadHandoff','mainThreadCallback','workerAck','snapshotBuild'])
    assert.match(app,new RegExp(`data\\.${field.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
  for(const phase of ['launcherTargets','walletHistoryTargets','profileMetadata','targetAssembly','storeTokens','postMessage'])
    assert.match(app,new RegExp(`phases\\.${phase}`));
  assert.match(app,/单事件主线程回调 P99/);
  assert.match(app,/整批回调至 Worker ACK P99/);
  assert.match(app,/快照阶段 P99/);
});

test('wallet worker queues, drops, rejections, restarts and errors participate in dashboard health',()=>{
  for(const field of ['pending','pendingChains','pendingTargets','pendingFeeds','droppedAfterRetries','droppedOnStop',
    'droppedFeeds','rejectedCapacity','rejectedClosed','networkRejectedCapacity','pricesRejected',
    'error','targetError','shutdownError','closeError','workerError'])assert.match(app,new RegExp(`['"]${field}['"]`));
  assert.match(app,/value\.restarts/);
  assert.match(app,/value\.activity\?\.error/);
  for(const field of ['persistence','launcherLiveness','launcherCoverage','realtimeWriter','coverageWriter','priceWriter'])
    assert.match(app,new RegExp(`\\.${field}`));
  assert.match(app,/observer\.worker/);
  assert.match(app,/workerHealth\(value\)\.problem/);
  assert.match(app,/GMGN_BACKGROUND_RESEARCH_DISABLED/);
  assert.match(app,/按配置暂停/);
  assert.match(app,/后台 Worker 需关注/);
  assert.match(app,/未就绪、有丢弃\/拒绝或发生过重启/);
});

test('chain event writer readiness and backpressure participate in chain health',()=>{
  assert.match(app,/stream\?\.liveEventWriter/);
  assert.match(app,/data\?\.liveEventWriter/);
  assert.match(app,/streamWriterHealth\.problem/);
  assert.match(app,/实时事件写入/);
  assert.match(app,/实时写入/);
});
