import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const page=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const styles=readFileSync(new URL('../web/styles.css',import.meta.url),'utf8');

test('closed shadow positions separate held results from post-exit market tracking',()=>{
  assert.match(app,/numeric\(item\.triggerPeakGainPct\)/);
  assert.match(app,/权益最终收益（冻结）/);
  assert.match(app,/退出前策略峰值/);
  assert.match(app,/退出后追踪最高涨幅/);
  assert.match(app,/已无模拟仓位 · 非策略收益/);
  assert.match(app,/不表示策略曾持有到该高点/);
  assert.doesNotMatch(app,/观察档案累计峰值/);
  assert.match(page,/“退出前策略峰值”和“权益最终收益”属于策略持有结果/);
  assert.match(page,/“退出后追踪最高涨幅”属于清仓后的无仓位市场观察/);
  assert.match(app,/observed\.dataset\.label='退出后追踪最高涨幅'/);
  assert.match(styles,/@media\(max-width:760px\)\{\.protection-table\{display:block/);
});
