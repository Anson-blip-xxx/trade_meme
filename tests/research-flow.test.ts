import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.js';
import {assessWalletSupport,combineSafety,type GmgnResearch} from '../src/research.js';
import type {WalletAnalysis} from '../src/research/wallet-types.js';
import {config,providers,signal,now,pass} from './helpers.js';

function wallets():WalletAnalysis {
  return {status:'pass',checkedAt:now.toISOString(),reasons:[],facts:{},wallets:[],clusters:[],summary:{
    token:signal().token,sampleOnly:true,uniqueWalletCount:2,enrichedWalletCount:2,currentHolderCount:2,
    smartCurrentHolderCount:2,smartFundingClusterCount:2,smartIndependenceProven:false,eligibleSmartWalletCount:2,
    qualifiedSmartWalletCount:2,qualifiedSmartFundingClusterCount:2,recentWindowSeconds:3600,
    recentNetBuyUsd:'300',hasRecentAccumulation:true,sampledHoldingRatio:0.01,cumulativeBuyUsd:'500',
    cumulativeSellUsd:'200',cumulativeCoverageWalletCount:2,cumulativeIsRecentInflow:false}};
}
function research():GmgnResearch {
  const w=wallets();return {snapshot:{token:signal().token,fetchedAt:now.toISOString(),diagnostics:[]},
    safety:pass(),wallets:w,flow:assessWalletSupport(w,2,now)};
}
test('聪明钱包门槛使用已覆盖近期活动及关联分组，样本冲突不能被正向数字掩盖',()=>{
  const w=wallets();assert.equal(assessWalletSupport(w,2,now).status,'pass');
  w.status='unknown';assert.equal(assessWalletSupport(w,2,now).status,'unknown');
  w.status='pass';w.summary.qualifiedSmartFundingClusterCount=1;
  assert.equal(assessWalletSupport(w,2,now).status,'unknown');
  w.summary.qualifiedSmartFundingClusterCount=2;w.summary.hasRecentAccumulation=null;
  assert.equal(assessWalletSupport(w,2,now).status,'unknown');
});
test('GMGN局部安全通过不能覆盖主安全未知，明确GMGN风险仍阻断',()=>{
  assert.equal(combineSafety({...pass(),status:'unknown'},pass()).status,'unknown');
  assert.equal(combineSafety(pass(),{...pass(),status:'fail'}).status,'fail');
  assert.equal(combineSafety(pass(),{...pass(),status:'unknown'}).status,'pass');
});
test('完整研究链需钱包支持，API/资料失败WATCH，明确技术风险REJECT',async()=>{
  const c=config();c.walletSupportRequired=true;const p=providers();
  assert.equal((await evaluate(signal(),c,p,{now:()=>now})).decision,'WATCH');
  p.research=async()=>research();
  const accepted=await evaluate(signal(),c,p,{now:()=>now});assert.equal(accepted.decision,'BUY_CANDIDATE');
  assert.equal(accepted.wallets?.summary.qualifiedSmartFundingClusterCount,2);
  p.research=async()=>({...research(),safety:{...pass(),status:'fail',reasons:['GMGN_HONEYPOT']}});
  assert.equal((await evaluate(signal(),c,p,{now:()=>now})).decision,'REJECT');
  p.research=async()=>{throw new Error('sensitive upstream message');};
  const missing=await evaluate(signal(),c,p,{now:()=>now});assert.equal(missing.decision,'WATCH');
  assert.equal(JSON.stringify(missing).includes('sensitive'),false);
});
