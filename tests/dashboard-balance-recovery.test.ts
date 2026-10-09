import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {DashboardBalances} from '../src/dashboard-data.js';
import {config} from './helpers.js';

test('failed balance refresh retains explicitly stale value/time; subsequent success clears failure',async()=>{
  const cfg=config();cfg.entryWallets={bsc:'wallet',solana:'wallet',robinhood:'wallet'};
  const stamps=['2026-10-09T00:00:00Z','2026-10-09T00:01:00Z','2026-10-09T00:02:00Z'];let step=0;
  const balances=new DashboardBalances(cfg,async()=>({status:step===1?'unknown':'verified',amount:step===1?undefined:step===0?'100000000000000000':'0',
    checkedAt:stamps[step],readStartedAt:stamps[step],reasons:step===1?['NATIVE_RPC_TIMEOUT']:[]}));
  try {
    await balances.runOnce();assert.equal(balances.get()[2].amount,'0.1');step=1;await balances.runOnce();
    assert.deepEqual(balances.get()[2],{chain:'robinhood',symbol:'ETH',address:'wallet',status:'stale',amount:'0.1',
      checkedAt:stamps[0],lastAttemptAt:stamps[1],reason:'NATIVE_RPC_TIMEOUT'});
    step=2;await balances.runOnce();assert.equal(balances.get()[2].status,'ok');assert.equal(balances.get()[2].amount,'0');
    assert.equal(balances.get()[2].checkedAt,stamps[2]);assert.equal(balances.get()[2].reason,undefined);
  } finally {await balances.stop();}
});
test('background retry refreshes only failed chains after 30 seconds without polling healthy chains early',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-10-09T00:00:00Z')});
  const cfg=config();cfg.entryWallets={bsc:'wallet',solana:'wallet',robinhood:'wallet'};const calls:string[]=[];
  const balances=new DashboardBalances(cfg,async chain=>{calls.push(chain);return {status:chain==='robinhood'?'unknown':'verified',
    amount:chain==='robinhood'?undefined:'1',checkedAt:new Date().toISOString(),readStartedAt:new Date().toISOString(),reasons:['NATIVE_RPC_TIMEOUT']};});
  try {
    balances.start();await setImmediate();assert.deepEqual(calls,['bsc','solana','robinhood']);
    assert.equal(balances.get()[2].status,'unavailable');assert.equal(balances.get()[2].amount,undefined);
    t.mock.timers.tick(29999);await setImmediate();assert.equal(calls.length,3);
    t.mock.timers.tick(1);await setImmediate();assert.deepEqual(calls,['bsc','solana','robinhood','robinhood']);
    await balances.stop();t.mock.timers.tick(120000);await setImmediate();assert.equal(calls.length,4);
  } finally {await balances.stop();t.mock.timers.reset();}
});
test('an old wallet balance is not retained after configured wallet changes',async()=>{
  const cfg=config();cfg.entryWallets={robinhood:'old-wallet'};let fail=false;
  const balances=new DashboardBalances(cfg,async()=>({status:fail?'unknown':'verified',amount:fail?undefined:'1',
    checkedAt:new Date().toISOString(),readStartedAt:new Date().toISOString(),reasons:['NATIVE_RPC_UNAVAILABLE']}));
  try {await balances.runOnce();cfg.entryWallets.robinhood='new-wallet';fail=true;await balances.runOnce();
    assert.equal(balances.get()[2].status,'unavailable');assert.equal(balances.get()[2].amount,undefined);}
  finally {await balances.stop();}
});
