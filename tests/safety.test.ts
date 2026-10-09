import test from 'node:test';
import assert from 'node:assert/strict';
import {assessGoPlus,assessSolanaMint,checkSafety} from '../src/providers/safety.js';
import {config,signal,fetchJson} from './helpers.js';
export function safeEvm() {return {is_open_source:'1',is_proxy:'0',is_honeypot:'0',cannot_buy:'0',cannot_sell_all:'0',
  is_mintable:'0',owner_change_balance:'0',hidden_owner:'0',can_take_back_ownership:'0',transfer_pausable:'0',
  is_blacklisted:'0',is_whitelisted:'0',slippage_modifiable:'0',buy_tax:'0',sell_tax:'0'};}
test('GoPlus明确字段通过；空值不能转为false或0',()=>{
  assert.equal(assessGoPlus('bsc',safeEvm(),0.1).status,'pass');
  for(const change of [{is_honeypot:null},{sell_tax:''},{buy_tax:undefined},{is_proxy:undefined}])
    assert.equal(assessGoPlus('bsc',{...safeEvm(),...change},0.1).status,'unknown');
});
test('蜜罐、可改余额、高税均拒绝',()=>{
  for(const change of [{is_honeypot:'1'},{owner_change_balance:'1'},{sell_tax:'0.5'}])
    assert.equal(assessGoPlus('bsc',{...safeEvm(),...change},0.1).status,'fail');
});
test('仅is_honeypot=0不足以放行，代理缺失须审查',()=>{
  assert.equal(assessGoPlus('robinhood',{is_honeypot:'0'},0.1).status,'unknown');
  assert.equal(assessGoPlus('bsc',{...safeEvm(),is_proxy:'1'},0.1).status,'unknown');
});
test('HTTP200中的供应商错误同样返回未知',async()=>{
  assert.equal((await checkSafety(signal(),config(),fetchJson({code:401,result:{}}))).status,'unknown');
});
const mint=(extensions:unknown[]=[])=>({owner:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',data:{parsed:{type:'mint',info:{
  isInitialized:true,mintAuthority:null,freezeAuthority:null,extensions}}}});
test('Token2022不一律拒绝，但永久委托与未知扩展不放行',()=>{
  assert.equal(assessSolanaMint(mint([{extension:'metadataPointer',state:{}}]),0.1).status,'pass');
  for(const extension of ['permanentDelegate','transferHook','brandNewExtension'])
    assert.equal(assessSolanaMint(mint([{extension,state:{}}]),0.1).status,'unknown');
});
test('Solana冻结/增发权限生效时拒绝',()=>{
  const a=mint();a.data.parsed.info.freezeAuthority='actor' as any;
  assert.equal(assessSolanaMint(a,0.1).status,'fail');
});
