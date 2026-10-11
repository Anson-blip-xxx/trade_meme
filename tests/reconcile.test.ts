import test from 'node:test';
import assert from 'node:assert/strict';
import {OrderStore} from '../src/orders.js';
import {OrderReconciler} from '../src/reconcile.js';

const input=(n:number)=>({eventKey:`event-${n}`,chain:'bsc' as const,tokenAddress:`0x${String(n).padStart(40,'0')}`,
  mode:'live' as const,wallet:'0x'+'1'.repeat(40),inputToken:'0x'+'0'.repeat(40),inputAmount:'100',slippagePct:5,details:{}});

test('自动对账只轮询已有订单ID，排除无ID unknown、paper和已完成；批次轮转',async()=>{
  const orders=new OrderStore(':memory:');
  try {
    const ids:string[]=[];
    for(let n=1;n<=5;n++) {
      const order=orders.reserve(input(n),10).order!;ids.push(order.id);
      orders.update(order.id,['prepared'],{status:'failed',providerOrderId:`provider-${n}`});
    }
    const unknown=orders.reserve(input(6),10).order!;
    orders.update(unknown.id,['prepared'],{status:'failed'});
    const confirmed=orders.reserve(input(7),10).order!;
    orders.update(confirmed.id,['prepared'],{status:'confirmed',providerOrderId:'done',actualInputAmount:'100',outputAmount:'200'});
    // Legacy outstanding submissions survive an upgrade even though new live admission is blocked.
    for(const id of ids) orders.update(id,['failed'],{status:'submitted'});
    orders.update(unknown.id,['failed'],{status:'unknown'});
    const paper=orders.reserve({...input(8),mode:'paper'},10).order!;
    orders.update(paper.id,['prepared'],{status:'paper_open',providerOrderId:'not-a-real-order'});
    const calls:string[]=[];
    const reconciler=new OrderReconciler(orders,{reconcile:async(id)=>{calls.push(id);return {status:'existing',order:orders.get(id)};}});
    await reconciler.runOnce();assert.deepEqual(calls,ids.slice(0,3));
    await reconciler.runOnce();assert.deepEqual(calls,[...ids,ids[0]]);
    assert.equal(orders.get(unknown.id)?.status,'unknown');await reconciler.stop();
  } finally {orders.close();}
});

test('对账重入不重复查询，读失败不改状态，停止等待当前GET但不继续后续订单',async()=>{
  const orders=new OrderStore(':memory:');
  try {
    const ids:string[]=[];
    for(let n=1;n<=2;n++) {const item=orders.reserve(input(n),3).order!;ids.push(item.id);orders.update(item.id,['prepared'],{status:'failed',providerOrderId:`p${n}`});}
    for(const id of ids) orders.update(id,['failed'],{status:'submitted'});
    let release!:()=>void,calls=0;
    const reconciler=new OrderReconciler(orders,{reconcile:async()=>{
      calls++;await new Promise<void>(resolve=>{release=resolve;});throw new Error('read-only network failure');
    }});
    const first=reconciler.runOnce(),second=reconciler.runOnce();assert.equal(first,second);assert.equal(calls,1);
    let stopped=false;const stopping=reconciler.stop().then(()=>{stopped=true;});
    await Promise.resolve();assert.equal(stopped,false);release();await Promise.all([first,second,stopping]);
    assert.equal(calls,1);assert.equal(orders.pending().length,2);await reconciler.runOnce();assert.equal(calls,1);
  } finally {orders.close();}
});
