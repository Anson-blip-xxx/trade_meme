import test from 'node:test';
import assert from 'node:assert/strict';
import {PRICE_GAIN_MILESTONES, crossedPriceMilestones, crossedMilestoneLabel, MILESTONE_DESCRIPTION} from '../src/price-milestones.js';

test('new fixed gains start at fifty percent and a single jump returns every reached threshold', () => {
  assert.deepEqual(PRICE_GAIN_MILESTONES, [50, 100, 200, 500, 1000, 1500, 2000]);
  assert.deepEqual(crossedPriceMilestones(25, []), []);
  assert.deepEqual(crossedPriceMilestones(49.999, []), []);
  assert.deepEqual(crossedPriceMilestones(50, []), [50]);
  assert.deepEqual(crossedPriceMilestones(1500, []), [50, 100, 200, 500, 1000, 1500]);
  assert.deepEqual(crossedPriceMilestones(2000, []), PRICE_GAIN_MILESTONES);
});

test('after 21x entry price every additional entry-price unit alerts at 22x,23x,24x', () => {
  assert.deepEqual(crossedPriceMilestones(2099.99, PRICE_GAIN_MILESTONES), []);
  assert.deepEqual(crossedPriceMilestones(2100, PRICE_GAIN_MILESTONES), [2100]);
  assert.deepEqual(crossedPriceMilestones(2200, PRICE_GAIN_MILESTONES), [2100, 2200]);
  assert.deepEqual(crossedPriceMilestones(2300, PRICE_GAIN_MILESTONES), [2100, 2200, 2300]);
  const thresholds = crossedPriceMilestones(4000, PRICE_GAIN_MILESTONES);
  assert.deepEqual(thresholds, Array.from({length:20},(_,index)=>2100+index*100));
  let previousMultiple = 21;
  for (const threshold of thresholds) {
    const multiple = 1 + threshold / 100;assert.equal(multiple, previousMultiple+1);previousMultiple = multiple;
  }
  assert.ok(MILESTONE_DESCRIPTION.includes('21倍'));assert.ok(MILESTONE_DESCRIPTION.includes('+2100%'));
});

test('persisted earlier alerts deduplicate across upgrades, pullbacks and recrossings without mutating history', () => {
  const old = [10, 25, 50, 100, 200, 500, 1000];
  const saved = [...old];assert.deepEqual(crossedPriceMilestones(2050, old), [1500, 2000]);
  assert.deepEqual(old, saved);
  const seen = [...old, 1500, 2000, 4100];
  assert.deepEqual(crossedPriceMilestones(150, seen), []);
  assert.deepEqual(crossedPriceMilestones(4100, seen), []);
  assert.deepEqual(crossedPriceMilestones(8300, seen), Array.from({length:42},(_,index)=>4200+index*100));
  assert.deepEqual(crossedPriceMilestones(8300, [...seen, 8300, 8300]), []);
});

test('downward moves never produce Telegram milestones', () => {
  assert.deepEqual(crossedPriceMilestones(-9.99, []), []);
  assert.deepEqual(crossedPriceMilestones(-40, []), []);
  assert.deepEqual(crossedPriceMilestones(-70, [-10, -20, 50, 100]), []);
  assert.deepEqual(crossedPriceMilestones(-100, [-10, -20, -30, -40, -50, -70]), []);
});

test('nonfinite gains never produce alerts and finite extremes have bounded, unique, finite output', () => {
  for (const gain of [NaN, Infinity, -Infinity]) assert.deepEqual(crossedPriceMilestones(gain, []), []);
  assert.deepEqual(crossedPriceMilestones(50, [NaN, Infinity, -Infinity]), [50]);
  const thresholds = crossedPriceMilestones(Number.MAX_VALUE, []);
  assert.ok(thresholds.length <= PRICE_GAIN_MILESTONES.length + 1024);
  assert.ok(thresholds.length <= 11);assert.equal(new Set(thresholds).size, thresholds.length);
  assert.ok(thresholds.every((threshold, index) => Number.isFinite(threshold) && threshold <= Number.MAX_VALUE &&
    (index === 0 || threshold > thresholds[index - 1])));
  assert.deepEqual(crossedPriceMilestones(-Number.MAX_VALUE, []), []);
  assert.deepEqual(crossedPriceMilestones(Number.MAX_VALUE, thresholds), []);
  assert.ok(crossedMilestoneLabel(thresholds).includes('区间合并'));
});

test('up to 1024 dynamic crossings are returned individually; larger jumps retain a bounded prefix and high watermark',()=>{
  const ordinary=crossedPriceMilestones(2000+1024*100,PRICE_GAIN_MILESTONES);
  assert.equal(ordinary.length,1024);assert.equal(ordinary[0],2100);assert.equal(ordinary.at(-1),104400);
  assert.ok(!crossedMilestoneLabel(ordinary).includes('区间合并'));
  const compacted=crossedPriceMilestones(104599.9,PRICE_GAIN_MILESTONES);
  assert.deepEqual(compacted,[2100,2200,2300,104500]);
  assert.ok(crossedMilestoneLabel(compacted).includes('区间合并'));
  const history=[...PRICE_GAIN_MILESTONES,...compacted];
  assert.deepEqual(crossedPriceMilestones(5000,history),[]);
  assert.deepEqual(crossedPriceMilestones(104500,history),[]);
  assert.deepEqual(crossedPriceMilestones(104600,history),[104600]);
  assert.deepEqual(crossedPriceMilestones(104800,history),[104600,104700,104800]);
});
