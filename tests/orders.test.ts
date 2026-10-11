import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {OrderStore} from '../src/orders.js';
import {Store} from '../src/store.js';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {signal,token} from './helpers.js';

const input=(key='event-1')=>({eventKey:key,chain:'bsc' as const,tokenAddress:token,mode:'paper' as const,
  wallet:'0x'+'2'.repeat(40),inputToken:'0x'+'0'.repeat(40),inputAmount:'100000000000000000000',slippagePct:5,
  details:{reasonCodes:['SYNTHETIC_TEST_ONLY']}});

test('订单数据库仅有开单表，重启幂等和同币/持仓上限跨连接原子生效',()=>{
  const dir=mkdtempSync(join(tmpdir(),'meme-orders-')),path=join(dir,'orders.sqlite');
  const a=new OrderStore(path),b=new OrderStore(path);
  try {
    const first=a.reserve(input(),2);assert.equal(first.created,true);
    assert.equal(b.reserve(input(),2).order?.id,first.order?.id);
    assert.equal(b.reserve(input('second-event'),2).reason,'ASSET_ALREADY_OPEN');
    assert.equal(b.reserve({...input('other-token'),tokenAddress:'0x'+'3'.repeat(40)},2).created,true);
    assert.equal(a.reserve({...input('third-token'),tokenAddress:'0x'+'4'.repeat(40)},2).reason,'OPENING_LIMIT_REACHED');
    assert.equal(first.order?.inputAmount,'100000000000000000000');
    const db=new DatabaseSync(path,{readOnly:true});
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name);
    assert.deepEqual(tables,['opening_orders']);db.close();
    assert.equal(statSync(path).mode&0o777,0o600);
  } finally {a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('开单CAS防止重复提交，过期发送结果保持unknown且原event不能再次reserve',()=>{
  const store=new OrderStore(':memory:'),now=new Date('2026-10-08T12:00:00Z');
  try {
    const order=store.reserve({...input(),mode:'live'},3,now).order!;
    assert.equal(store.update(order.id,['prepared'],{status:'submitting'},now)?.status,'submitting');
    assert.equal(store.update(order.id,['prepared'],{status:'submitting'},now),undefined);
    store.recover(new Date(now.getTime()+1000));assert.equal(store.get(order.id)?.status,'submitting');
    store.recover(new Date(now.getTime()+300000));assert.equal(store.get(order.id)?.status,'unknown');
    assert.equal(store.get(order.id)?.failureReason,'SUBMISSION_OUTCOME_UNKNOWN');
    assert.equal(store.reserve({...input(),mode:'live'},3).created,false);
    assert.equal(store.reserve({...input('new-event'),mode:'live'},3).reason,'ASSET_ALREADY_OPEN');
  } finally {store.close();}
});

test('生产配置及运行时均拒绝临时订单数据库，防止重启丢失去重记录',()=>{
  for(const path of ['', '  ', ':memory:', 'file::memory:?cache=shared', 'file:temporary?mode=memory']) {
    assert.throws(()=>readConfig({ORDERS_DATABASE_PATH:path}));
    const config=readConfig({ENTRY_MODE:'live'});config.ordersDatabase=path;
    assert.throws(()=>createRuntime(config),/PERSISTENT_ORDER_DATABASE_REQUIRED/);
  }
});

test('恢复只改过期未提交/提交中记录，终态不退回；确认但缺成交详情仍可只读补全',()=>{
  const store=new OrderStore(':memory:'),now=new Date('2026-10-08T12:00:00Z');
  try {
    const prepared=store.reserve({...input('prepared'),mode:'live'},10,now).order!;
    store.update(prepared.id,['prepared'],{status:'failed'},now);
    const submitting=store.reserve({...input('submitting'),tokenAddress:'0x'+'5'.repeat(40),mode:'live'},10,now).order!;
    store.update(submitting.id,['prepared'],{status:'failed'},now);
    const confirmed=store.reserve({...input('confirmed'),tokenAddress:'0x'+'6'.repeat(40),mode:'live'},10,now).order!;
    store.update(confirmed.id,['prepared'],{status:'failed'},now);
    const failed=store.reserve({...input('failed'),tokenAddress:'0x'+'7'.repeat(40),mode:'live'},10,now).order!;
    store.update(failed.id,['prepared'],{status:'failed'},now);
    // Restore a legacy concurrent ledger; new live reservations cannot create this state.
    store.update(prepared.id,['failed'],{status:'prepared'},now);
    store.update(submitting.id,['failed'],{status:'submitting'},now);
    store.update(confirmed.id,['failed'],{status:'confirmed',providerOrderId:'confirmed-id'},now);
    store.recover(new Date(now.getTime()+300001));
    assert.equal(store.get(prepared.id)?.status,'failed');assert.equal(store.get(submitting.id)?.status,'unknown');
    assert.equal(store.get(confirmed.id)?.status,'confirmed');assert.equal(store.get(failed.id)?.status,'failed');
    assert.deepEqual(store.pending().map(o=>o.id),[confirmed.id]);
    store.update(confirmed.id,['confirmed'],{actualInputAmount:'99',outputAmount:'101'});
    assert.equal(store.pending().length,0);
    assert.equal(store.update(confirmed.id,['confirmed'],{actualInputAmount:'98'}),undefined);
    assert.equal(store.update(confirmed.id,['confirmed'],{status:'unknown'}),undefined);
    assert.equal(store.get(confirmed.id)?.actualInputAmount,'99');assert.equal(store.get(confirmed.id)?.status,'confirmed');
  } finally {store.close();}
});

test('旧账本中的未知、缺失退出及未保护已确认仓位，跨资产跨链封锁新实盘',()=>{
  const now=new Date('2026-10-11T00:00:00Z');
  for(const status of ['prepared','submitting','submitted','unknown','confirmed'] as const) {
    const store=new OrderStore(':memory:');
    try {
      const prior=store.reserve({...input('legacy'),mode:'live'},10,now).order!;
      if(status!=='prepared') store.update(prior.id,['prepared'],{status},now);
      const other=store.reserve({...input('new-asset'),chain:'robinhood',tokenAddress:'0x'+'9'.repeat(40),mode:'live'},10,now);
      assert.equal(other.reason,'EXIT_PROTECTION_UNVERIFIED',status);assert.equal(store.list().length,1);
      assert.equal(store.reserve({...input('paper-observation'),tokenAddress:'0x'+'9'.repeat(40)},10,now).created,true);
    } finally {store.close();}
  }
});

test('发送前事务再次核验其他仓位，阻止报价后新增的未知风险',()=>{
  const now=new Date('2026-10-11T00:00:00Z');
  const store=new OrderStore(':memory:');
  try {
    const prior=store.reserve({...input('legacy'),mode:'live'},10,now).order!;
    store.update(prior.id,['prepared'],{status:'failed'},now);
    const quoted=store.reserve({...input('quoted'),tokenAddress:'0x'+'9'.repeat(40),mode:'live'},10,now).order!;
    store.update(prior.id,['failed'],{status:'unknown'},now);
    assert.equal(store.beginSubmission(quoted.id,now).reason,'EXIT_PROTECTION_UNVERIFIED');
    assert.equal(store.get(quoted.id)?.status,'prepared');
    store.update(prior.id,['unknown'],{status:'failed'},now);
    assert.equal(store.beginSubmission(quoted.id,now).order?.status,'submitting');
    assert.equal(store.beginSubmission(quoted.id,now).reason,'ENTRY_ALREADY_HANDLED');
  } finally {store.close();}
});

test('研究缓存有时长/条数上限且保留活动租约；旧DATABASE_PATH不会恢复全文持久化',()=>{
  const config=readConfig({DATABASE_PATH:'/should-not-be-used.sqlite'});
  assert.equal(config.database,':memory:');
  const store=new Store(config.database);
  try {
    const active=store.reserve(signal()).entry;
    const old=store.reserve(signal({sourceEventId:'old'})).entry;store.interrupt(old.id,old.claimId!);
    const latest=store.reserve(signal({sourceEventId:'latest'})).entry;store.interrupt(latest.id,latest.claimId!);
    store.prune(1800,1);
    assert.ok(store.get(active.id));assert.equal(store.get(old.id),undefined);assert.ok(store.get(latest.id));
    store.prune(60,200,new Date(Date.now()+600000));assert.equal(store.list().length,0);
  } finally {store.close();}
});
