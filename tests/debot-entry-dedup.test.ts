import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {OrderStore} from '../src/orders.js';
import {EntryController} from '../src/entry.js';
import {readConfig,type Config} from '../src/config.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import type {Report,Signal} from '../src/types.js';
import {signal,token,pass,narrative,now} from './helpers.js';

const wallet='0x'+'2'.repeat(40),spend='0x'+'0'.repeat(40);
const opening=(eventKey='prior')=>({eventKey,chain:'bsc' as const,tokenAddress:token,mode:'paper' as const,
  wallet,inputToken:spend,inputAmount:'1000',slippagePct:5,details:{}});
/** Synthetic previously validated terminal ledger, so tests never create or close a real position. */
function seedClosed(store:OrderStore,key='prior') {
  const prior=store.reserve(opening(key),10,now).order!;
  const closed={...prior,status:'confirmed',exit:{state:'closed',positionClosed:true}};
  const db=(store as unknown as {db:DatabaseSync}).db;
  db.prepare("UPDATE opening_orders SET status='confirmed',details=? WHERE id=?").run(JSON.stringify(closed),prior.id);
  return prior.id;
}
const candidate=(source:Signal['source']='debot',event='new-notification'):Report=>({id:randomUUID(),policyVersion:'repeat-entry-test',mode:'live',
  signal:signal({source,sourceEventId:event}),receivedAt:now.toISOString(),evaluatedAt:now.toISOString(),
  validUntil:new Date(now.getTime()+60_000).toISOString(),decision:'BUY_CANDIDATE',buyEligible:true,executionEnabled:false,reasons:[],
  provenance:{...pass(),platform:'flap'},safety:pass(),flow:pass(),narrative:narrative()});
function fixture(mode:Config['entryMode']='paper') {
  const config:Config={...readConfig({}),entryBalanceBps:{},entryMode:mode,entrySizing:'fixed',gmgnApiKey:'synthetic-repeat-key',gmgnMinIntervalMs:0,
    entryWallets:{bsc:wallet},entryAmounts:{bsc:'1000'},entryInputTokens:{bsc:spend},entrySlippagePct:5,entryMaxOpen:10};
  let requests=0;
  const client=new GmgnClient({apiKey:config.gmgnApiKey!,minIntervalMs:0,now:()=>now.getTime(),fetcher:async()=>{
    requests++;return Response.json({code:0,data:{input_token:spend,output_token:token,input_amount:'1000',
      output_amount:'1000',min_output_amount:'950',slippage:5}});
  }});
  const store=new OrderStore(':memory:');
  const controller=new EntryController(config,store,client,{now:()=>now});
  return {config,store,controller,requests:()=>requests};
}

test('DeBot cannot re-enter a closed token through a new notification, revision or WATCH evaluation',async()=>{
  const f=fixture();
  try {
    seedClosed(f.store);
    for(const id of ['debot:signal:another','debot:revision:'+'a'.repeat(64),'watch-recheck-original']) {
      const result=await f.controller.consider(candidate('debot',id));
      assert.deepEqual(result,{status:'blocked',reason:'DEBOT_REENTRY_BLOCKED'});
    }
    assert.equal(f.requests(),0);assert.equal(f.store.list().length,1);
  }finally{f.store.close();}
});

test('the no-reentry check is atomic with reservation when another connection opens and closes after an earlier lookup',()=>{
  const root=mkdtempSync(join(tmpdir(),'debot-entry-dedup-')),path=join(root,'orders.sqlite');
  const first=new OrderStore(path),second=new OrderStore(path);
  try {
    assert.equal(first.hasOpeningHistory('bsc',token,'paper'),false);
    seedClosed(second);
    const result=first.reserve(opening('debot-new-event'),10,now,undefined,{preventReentry:true});
    assert.deepEqual(result,{created:false,reason:'DEBOT_REENTRY_BLOCKED'});assert.equal(first.list().length,1);
  }finally{first.close();second.close();rmSync(root,{recursive:true,force:true});}
});

test('same event reservation stays idempotent and active positions retain the existing duplicate reason',()=>{
  const store=new OrderStore(':memory:');
  try {
    const first=store.reserve(opening(),10,now,undefined,{preventReentry:true});
    assert.equal(store.reserve(opening(),10,now,undefined,{preventReentry:true}).order?.id,first.order?.id);
    assert.equal(store.reserve(opening('new-event'),10,now,undefined,{preventReentry:true}).reason,'ASSET_ALREADY_OPEN');
  }finally{store.close();}
});

test('failed attempts do not prevent a new independently eligible DeBot entry',async()=>{
  const f=fixture();
  try {
    const prior=f.store.reserve(opening(),10,now).order!;f.store.update(prior.id,['prepared'],{status:'failed'},now);
    const result=await f.controller.consider(candidate());
    assert.equal(result.status,'created');assert.equal(result.order?.status,'paper_open');assert.equal(f.requests(),1);
  }finally{f.store.close();}
});

test('GMGN and manual sources retain the existing ability to re-enter a genuinely closed token',async()=>{
  for(const source of ['gmgn','manual'] as const) {
    const f=fixture();
    try {
      seedClosed(f.store);
      const result=await f.controller.consider(candidate(source));
      assert.equal(result.status,'created');assert.equal(result.order?.status,'paper_open');assert.equal(f.requests(),1);
    }finally{f.store.close();}
  }
});

test('disabled entry remains disabled and no mode or persisted exit history can enable submission',async()=>{
  const f=fixture('off');
  try {
    const result=await f.controller.consider(candidate());
    assert.deepEqual(result,{status:'skipped',reason:'ENTRY_DISABLED'});assert.equal(f.store.list().length,0);assert.equal(f.requests(),0);
  }finally{f.store.close();}
});

test('DeBot reservation guard matches EVM casing and separates mode plus chain',()=>{
  const store=new OrderStore(':memory:');
  try {
    seedClosed(store);
    assert.equal(store.hasOpeningHistory('bsc',token.toUpperCase().replace('0X','0x'),'paper'),true);
    const upper={...opening('upper'),tokenAddress:token.toUpperCase().replace('0X','0x')};
    assert.equal(store.reserve(upper,10,now,undefined,{preventReentry:true}).reason,'DEBOT_REENTRY_BLOCKED');
    const differentChain=store.reserve({...opening('other-chain'),chain:'robinhood'},10,now,undefined,{preventReentry:true});
    assert.equal(differentChain.created,true);
    assert.equal(store.hasOpeningHistory('bsc',token,'live'),false);
  }finally{store.close();}
});
