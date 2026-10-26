/** Fixed gain percentages, measured against the original entry price. */
export const PRICE_GAIN_MILESTONES: number[] = [50, 100, 200, 500, 1000, 1500, 2000];

const COMPARISON_EPSILON = 1e-9;
const MAX_DYNAMIC_TIERS = 1024;
const COMPACT_PREFIX_TIERS = 3;

export const MILESTONE_DESCRIPTION = '上涨提醒：+50%、+100%、+200%、+500%、+1000%、+1500%、+2000%；' +
  '此后价格每增加1倍买入价提醒：21倍 → 22倍（+2100%）→ 23倍（+2200%）→ 24倍（+2300%）……，' +
  '即涨幅每增加100个百分点提醒，同档去重；极端跳涨合并区间。';

/** Keep jumps readable and identify intervals represented by a highest-tier watermark. */
export function crossedMilestoneLabel(values:number[]):string {
  const pct=(value:number)=>`${value>=0?'+':''}${value.toFixed(2)}%`;
  const dynamic=values.filter(value=>value>=2100);
  const compacted=dynamic.some((value,index)=>!Number.isSafeInteger(value)||
    index>0&&value-dynamic[index-1]>100+COMPARISON_EPSILON);
  if(compacted)return `${values.slice(0,3).map(pct).join('、')} … ${pct(values.at(-1)!)}（区间合并，已覆盖至最高档）`;
  return values.length<=12?values.map(pct).join('、'):
    `${values.slice(0,3).map(pct).join('、')} … ${pct(values.at(-1)!)}（共 ${values.length} 档）`;
}

function wholeHundred(value:number):number {
  const rounded=Math.floor((value+COMPARISON_EPSILON)/100)*100;
  // At extreme exponents, IEEE-754 rounding can overflow the multiplication.
  return Number.isFinite(rounded)&&rounded<=value+COMPARISON_EPSILON?rounded:value-value%100;
}

/** Return all ordinary crossings; extreme jumps use a bounded prefix and highest-tier watermark. */
export function crossedPriceMilestones(gain: number, seen: number[]): number[] {
  if (!Number.isFinite(gain)) return [];
  const previous = new Set(seen);
  const crossed: number[] = [];
  for (const threshold of PRICE_GAIN_MILESTONES) {
    if (gain >= threshold - COMPARISON_EPSILON && !previous.has(threshold)) crossed.push(threshold);
  }
  // +2000% is 21*entry. The next levels are 22*,23*,24*..., not 42*,84*... .
  let watermark=2000;
  for(const value of seen)if(Number.isFinite(value)&&value>=2100)watermark=Math.max(watermark,wholeHundred(value));
  const highest=wholeHundred(gain);
  if(highest>watermark) {
    const count=(highest-watermark)/100;
    const limit=count>MAX_DYNAMIC_TIERS?COMPACT_PREFIX_TIERS:Math.min(MAX_DYNAMIC_TIERS,Math.floor(count));
    let last=watermark;
    for(let step=1;step<=limit;step++) {
      const threshold=watermark+step*100;
      // Adding 100 may cease to change a number at extreme magnitudes.
      if(Number.isFinite(threshold)&&threshold>last&&threshold<=highest) {crossed.push(threshold);last=threshold;}
    }
    if(highest>last)crossed.push(highest);
  }
  return crossed;
}
