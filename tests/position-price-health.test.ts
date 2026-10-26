import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {PositionPriceHealth,nativePositionHealthQuote,type PositionPriceHealthOptions,type PositionPriceHealthPosition} from '../src/position-price-health.js';
import type {NativePositionState} from '../src/native-solana/positions.js';

const epoch=Date.parse('2026-10-25T13:00:00Z');
const mint=bs58.encode(Buffer.alloc(32,51));
const wallet=bs58.encode(Buffer.alloc(32,52));
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'position-price-health-')),path=join(dir,'telegram.sqlite');
  const messages:Array<{key:string;text:string}>=[],instances:PositionPriceHealth[]=[];let now=epoch;
  const open=(overrides:Partial<PositionPriceHealthOptions>={})=>{
    const monitor=new PositionPriceHealth(path,{enqueue:event=>{if(messages.some(m=>m.key===event.key))return false;messages.push(event);return true;},now:()=>now,...overrides});
    instances.push(monitor);return monitor;
  };
  const position=(extra:Partial<PositionPriceHealthPosition>={}):PositionPriceHealthPosition=>
    ({id:'holding:1',chain:'solana',address:mint,name:'Meme',subscriptionSent:true,...extra});
  const price=(source='ave_price_stream_sample',age=0,validity=30_000)=>({source,
    observedAt:new Date(now-age).toISOString(),validUntil:new Date(now-age+validity).toISOString()});
  return {path,messages,open,position,price,at:()=>new Date(now).toISOString(),advance:(ms:number)=>{now+=ms;},
    close:()=>{for(const instance of instances)instance.close();rmSync(dir,{recursive:true,force:true});}};
}

function nativeState(extra:Partial<NativePositionState>={}):NativePositionState {
  const quotedAt=new Date(epoch).toISOString(),expiresAt=new Date(epoch+1000).toISOString();
  return {buy:{orderId:'holding:1',wallet,mint,inputAmount:'10000000',outputAmount:'123456',tokenDecimals:6,
      signature:bs58.encode(Buffer.alloc(64,53)),buySlot:100,subscriptionAccounts:[wallet]},
    state:'active',registeredAt:quotedAt,updatedAt:quotedAt,revision:1,
    costBasis:{solLamports:'10000000',tokenAtoms:'123456',excludesNetworkFees:true},
    balance:{amount:'123456',tokenDecimals:6,slot:101,commitment:'confirmed',observedAt:quotedAt,wallet,mint},
    quote:{wallet,mint,inputAmount:'123456',outputAmount:'9000000',minimumOutputAmount:'8500000',quotedAt,expiresAt,
      source:'solana_account_stream'},dirty:false,takeProfitDone:false,soldTokenAmount:'0',saleProceedsLamports:'0',
    realizedCostLamports:'0',externalReductionAmount:'0',externalIncreaseAmount:'0',expectedBalanceAmount:'123456',
    finalPnlKnown:false,...extra};
}

test('native health quotes require the exact active wallet, mint, balance and unexpired executable amount',()=>{
  const valid=nativeState();
  assert.deepEqual(nativePositionHealthQuote(valid,mint,epoch),{
    observedAt:new Date(epoch).toISOString(),validUntil:new Date(epoch+1000).toISOString(),source:'native_sol_sell_quote'});
  assert.equal(nativePositionHealthQuote({...valid,state:'closed'},mint,epoch),undefined);
  assert.equal(nativePositionHealthQuote(valid,bs58.encode(Buffer.alloc(32,54)),epoch),undefined);
  assert.equal(nativePositionHealthQuote({...valid,balance:{...valid.balance!,amount:'123455'}},mint,epoch),undefined);
  assert.equal(nativePositionHealthQuote({...valid,quote:{...valid.quote!,wallet:bs58.encode(Buffer.alloc(32,55))}},mint,epoch),undefined);
  assert.equal(nativePositionHealthQuote(valid,mint,epoch,bs58.encode(Buffer.alloc(32,56))),undefined);
  assert.equal(nativePositionHealthQuote({...valid,lastError:'NATIVE_QUOTE_UNAVAILABLE'},mint,epoch,wallet),undefined);
  assert.equal(nativePositionHealthQuote({...valid,balance:{...valid.balance!,provisionalZero:true}},mint,epoch,wallet),undefined);
  assert.equal(nativePositionHealthQuote({...valid,quote:{...valid.quote!,outputAmount:'0'}},mint,epoch,wallet),undefined);
  assert.equal(nativePositionHealthQuote(valid,mint,epoch+1000),undefined);
});

test('a valid backup price keeps a holding healthy while Ave is silent or disconnected',()=>{
  const f=fixture();try{
    const m=f.open();m.tick({positions:[f.position({price:f.price(),streamObservedAt:f.at()})],connected:true});
    for(let i=0;i<8;i++){
      f.advance(20_000);
      m.tick({positions:[f.position({price:f.price('dexscreener_token_pairs_sample'),streamObservedAt:new Date(epoch).toISOString(),subscriptionSent:false})],connected:false});
      assert.equal(m.status().degraded,0);
      assert.equal(m.status().positions[0].priceSource,'dexscreener_token_pairs_sample');
      assert.equal(m.status().positions[0].lastStreamAt,new Date(epoch).toISOString());
    }
    assert.equal(f.messages.length,0);
  }finally{f.close();}
});

test('a fresh native sell quote prevents false Ave alarms, but an expired quote does not',()=>{
  const f=fixture();try{
    const m=f.open();
    for(let i=0;i<60;i++){
      m.tick({positions:[f.position({price:f.price('native_sol_sell_quote',0,1000),subscriptionSent:false})],connected:false});
      f.advance(1000);
    }
    assert.equal(m.status().degraded,0);assert.equal(f.messages.length,0);
    const old=f.price('native_sol_sell_quote',60_000,1000);
    m.tick({positions:[f.position({price:old})],connected:false});
    f.advance(44_999);m.tick({positions:[f.position({price:old})],connected:false});assert.equal(f.messages.length,0);
    f.advance(1);m.tick({positions:[f.position({price:old})],connected:false});assert.equal(f.messages.length,1);
    assert.equal(m.status().positions[0].reason,'price_stale');
    assert.match(f.messages[0].text,/没有有效持仓报价/);
    assert.doesNotMatch(f.messages[0].text,/长连接报价延迟/);
  }finally{f.close();}
});

test('a new verified fallback quote recovers an incident; a recycled HTTP response or future timestamp cannot',()=>{
  const f=fixture();try{
    const m=f.open();m.tick({positions:[f.position({price:f.price()})],connected:true});
    f.advance(31_000);m.tick({positions:[f.position()],connected:true});
    f.advance(45_000);m.tick({positions:[f.position()],connected:true});assert.equal(f.messages.length,1);
    const old={source:'dexscreener_token_pairs_sample',observedAt:new Date(epoch+1000).toISOString(),validUntil:new Date(epoch+31_000).toISOString()};
    m.tick({positions:[f.position({price:old})],connected:true});assert.equal(f.messages.length,1);
    const future={source:'dexscreener_token_pairs_sample',observedAt:new Date(Date.parse(f.at())+1000).toISOString(),
      validUntil:new Date(Date.parse(f.at())+31_000).toISOString()};
    m.tick({positions:[f.position({price:future})],connected:true});assert.equal(f.messages.length,1);
    m.tick({positions:[f.position({price:f.price('debot_token_info_sample')})],connected:false});
    assert.equal(f.messages.length,2);assert.equal(m.status().degraded,0);
    assert.match(f.messages[1].text,/debot_token_info_sample/);
    m.tick({positions:[f.position({price:f.price('debot_token_info_sample')})],connected:false});assert.equal(f.messages.length,2);
  }finally{f.close();}
});

test('event keys survive restart and an obsolete holding discards undelivered events',()=>{
  const f=fixture();try{
    let fail=true;const attempts:string[]=[];
    const a=f.open({enqueue:event=>{attempts.push(event.key);if(fail)throw Error('QUEUE_UNAVAILABLE');f.messages.push(event);return true;}});
    a.tick({positions:[f.position()],connected:false});f.advance(45_000);a.tick({positions:[f.position()],connected:false});
    assert.equal(a.status().pending,1);assert.equal(a.status().lastError,'POSITION_PRICE_HEALTH_QUEUE_FAILED');
    fail=false;const b=f.open();b.tick({positions:[f.position()],connected:false});assert.equal(b.status().pending,0);assert.equal(f.messages.length,1);
    assert.equal(attempts.length,1);
    b.tick({positions:[],connected:false});assert.equal(b.status().monitored,0);
    b.tick({positions:[f.position()],connected:false});assert.equal(b.status().degraded,0);
  }finally{f.close();}
});

test('recovery supersedes an outage alert that never reached the Telegram outbox',()=>{
  const f=fixture();try{
    let available=false;
    const m=f.open({enqueue:event=>{if(!available)throw Error('QUEUE_UNAVAILABLE');f.messages.push(event);return true;}});
    m.tick({positions:[f.position()],connected:false});f.advance(45_000);m.tick({positions:[f.position()],connected:false});
    assert.equal(m.status().pending,1);available=true;
    m.tick({positions:[f.position({price:f.price('dexscreener_token_pairs_sample')})],connected:false});
    assert.equal(m.status().pending,0);assert.equal(f.messages.length,1);assert.match(f.messages[0].text,/已恢复/);
    assert.doesNotMatch(f.messages[0].text,/没有有效持仓报价/);
  }finally{f.close();}
});

test('invalid input and regressed clocks leave the previous valid quote intact',()=>{
  const f=fixture();try{
    const m=f.open(),p=f.position({price:f.price(),streamObservedAt:f.at()});m.tick({positions:[p],connected:true});
    assert.throws(()=>m.tick({positions:[p,p],connected:true}),/INPUT_INVALID/);
    assert.throws(()=>m.tick({positions:[f.position({price:{...f.price(),source:'bad source'}})],connected:true}),/INPUT_INVALID/);
    f.advance(1000);m.tick({positions:[f.position({price:f.price()})],connected:true});const last=m.status().positions[0].lastPriceAt;
    f.advance(-1000);assert.throws(()=>m.tick({positions:[],connected:false}),/CLOCK_REGRESSED/);
    assert.equal(m.status().positions[0].lastPriceAt,last);assert.equal(m.status().degraded,0);
  }finally{f.close();}
});

test('separate holdings retain independent incidents and preserve unrelated Telegram tables',()=>{
  const f=fixture();try{
    const db=new DatabaseSync(f.path);db.exec("CREATE TABLE telegram_marker(value TEXT); INSERT INTO telegram_marker VALUES('keep')");db.close();
    const m=f.open(),other=f.position({id:'holding:2',chain:'bsc',address:'0x'+'A'.repeat(40),name:'Other'});
    m.tick({positions:[f.position({price:f.price()}),other],connected:true});f.advance(45_000);
    m.tick({positions:[f.position({price:f.price('gmgn_token_info_sample')}),other],connected:false});
    assert.equal(f.messages.length,1);assert.equal(m.status().degraded,1);assert.match(f.messages[0].text,/Other · BSC/);
    const different={...other,address:'0x'+'b'.repeat(40)};
    m.tick({positions:[f.position({price:f.price('gmgn_token_info_sample')}),different],connected:true});
    assert.equal(m.status().degraded,0);
    const inspect=new DatabaseSync(f.path,{readOnly:true});
    assert.equal(inspect.prepare('SELECT value FROM telegram_marker').get()?.value,'keep');inspect.close();
  }finally{f.close();}
});

test('two monitors and restart cannot duplicate an incident or recovery',()=>{
  const f=fixture();try{
    const a=f.open();a.tick({positions:[f.position()],connected:false});f.advance(45_000);
    a.tick({positions:[f.position()],connected:false});assert.equal(f.messages.length,1);
    const b=f.open();b.tick({positions:[f.position()],connected:false});assert.equal(f.messages.length,1);
    const recovered=f.position({price:f.price('dexscreener_token_pairs_sample')});
    b.tick({positions:[recovered],connected:false});a.tick({positions:[recovered],connected:false});
    assert.equal(f.messages.length,2);assert.equal(a.status().degraded,0);
    a.close();b.close();const c=f.open();c.tick({positions:[recovered],connected:false});
    assert.equal(f.messages.length,2);
  }finally{f.close();}
});

test('a lost outbox acknowledgement retries the same durable key without duplicate delivery',()=>{
  const f=fixture();try{
    const a=f.open({enqueue:event=>{if(!f.messages.some(e=>e.key===event.key))f.messages.push(event);throw Error('ACK_LOST');}});
    a.tick({positions:[f.position()],connected:false});f.advance(45_000);a.tick({positions:[f.position()],connected:false});
    assert.equal(f.messages.length,1);assert.equal(a.status().pending,1);
    const b=f.open();b.tick({positions:[f.position()],connected:false});
    assert.equal(b.status().pending,0);assert.equal(f.messages.length,1);
  }finally{f.close();}
});

test('legacy row without effective price fields is migrated on the next observation',()=>{
  const f=fixture();try{
    const a=f.open();a.tick({positions:[f.position({streamObservedAt:f.at()})],connected:true});a.close();
    const db=new DatabaseSync(f.path),saved=db.prepare('SELECT payload FROM position_price_health_positions').get()!;
    const legacy=JSON.parse(String(saved.payload));delete legacy.priceAt;delete legacy.priceValidUntil;
    delete legacy.priceSource;delete legacy.missingSince;
    legacy.incident={id:'legacy-incident',reason:'disconnected',alertedAt:epoch,streamAt:epoch};
    db.prepare('UPDATE position_price_health_positions SET payload=?').run(JSON.stringify(legacy));db.close();
    f.advance(1000);const b=f.open();assert.equal(b.status().degraded,1);
    b.tick({positions:[f.position({price:f.price('dexscreener_token_pairs_sample')})],connected:false});
    assert.equal(b.status().degraded,0);assert.equal(b.status().positions[0].priceSource,'dexscreener_token_pairs_sample');
  }finally{f.close();}
});
