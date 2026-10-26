import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {ManualCloseService,type ManualClosePosition,type ManualCloseOptions} from '../src/manual-close.js';
import type {TestTradeClient,TestChainReader,SolanaSnapshot,VerifiedSolanaTransaction} from '../src/controlled-test/types.js';

const SOL='So11111111111111111111111111111111111111112',mint='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const wallet=bs58.encode(new Uint8Array(32).fill(7)),buyHash=bs58.encode(new Uint8Array(64).fill(8)),sellHash=bs58.encode(new Uint8Array(64).fill(9));
const partialHash=bs58.encode(new Uint8Array(64).fill(10));
const epoch=Date.parse('2026-10-25T10:00:00.000Z'),quantity='500000000';
const conditions=[{order_type:'profit_stop',side:'sell',price_scale:'100',sell_ratio:'50'},{order_type:'loss_stop',side:'sell',price_scale:'40',sell_ratio:'100'}];
interface Changes {partial?:boolean;fallback?:boolean;sellUnknown?:boolean;cancelUnknown?:boolean;cancelVisible?:boolean;queryPending?:boolean;afterQuoteBalance?:string;afterCancelTrigger?:boolean;}
function fixture(changes:Changes={}) {
  const dir=mkdtempSync(join(tmpdir(),'manual-close-')),path=join(dir,'close.sqlite');let now=epoch,canceled=false,sold=false,quoted=false;
  const remaining=changes.partial?'250000000':quantity;
  const state={queryPending:changes.queryPending??false,cancelVisible:changes.cancelVisible??true,foreign:false,badOwnership:false};
  const writes:{kind:string;body:Record<string,unknown>;nonce:string}[]=[],reads:string[]=[],messages:{key:string;text:string}[]=[],instances:ManualCloseService[]=[];
  const p:ManualClosePosition={id:'controlled-test:known',chain:'solana',wallet,tokenAddress:mint,tokenDecimals:5,openingTransactionHash:buyHash,
    providerOrderId:'buy-order',name:'BONK',symbol:'BONK',openingOutputAmount:quantity,protectionExpected:true,
    ...(changes.fallback?{protectionEvidence:{inputAmount:'10000000',outputAmount:quantity,tokenDecimals:5,confirmedAt:new Date(epoch).toISOString(),conditions,sellRatioType:'hold_amount' as const}}:{})};
  const snap=():SolanaSnapshot=>({wallet,mint,tokenAmount:sold?'0':quoted&&changes.afterQuoteBalance!==undefined?changes.afterQuoteBalance:remaining,
    nativeLamports:sold?'1009950000':'1000000000',decimals:5,slot:sold?105:103,nativeSlot:sold?105:103,
    mintAuthority:null,freezeAuthority:null,tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',extensions:[],checkedAt:new Date(now).toISOString()});
  const parent=()=>({order_id:'strategy-1',chain:'sol',wallet_address:wallet,base_token:mint,quote_token:SOL,
    open_sign_hash:state.badOwnership?sellHash:changes.fallback?'':buyHash,create_time:epoch,quote_investment:'10000000',open_amount:quantity,
    base_decimal:5,quote_decimal:9,order_type:'smart_trade',sub_order_type:'mix_trade',sell_ratio_type:'hold_amount',
    status:canceled&&state.cancelVisible?'closed':'open',strategy_status:canceled&&state.cancelVisible?'stopped':'running',
    order_statistic:{success_sell_num:changes.partial||canceled&&changes.afterCancelTrigger?1:0,...changes.partial?{sell_num:1}:{}},condition_orders:conditions.map((c,i)=>({...c,cid:'child-'+i,
      status:changes.partial&&i===0?'success':canceled&&state.cancelVisible?changes.afterCancelTrigger&&i===0?'success':'cancel':'check'}))});
  function recorded(kind:string,body:Record<string,unknown>,nonce:string){const db=new DatabaseSync(path,{readOnly:true});try {
    const key=kind==='sell'?'sell':'cancel:'+body.order_id,row=db.prepare('SELECT payload FROM manual_close_operations WHERE operation_key=?').get(key)!;
    const op=JSON.parse(String(row.payload));assert.equal(op.state,'submitting');assert.equal(op.clientId,nonce);assert.deepEqual(op.body,body);
  }finally{db.close();}writes.push({kind,body:structuredClone(body),nonce});}
  const client:TestTradeClient={
    quote:async r=>{reads.push('quote');quoted=true;return {input_token:r.inputToken,output_token:r.outputToken,input_amount:r.inputAmount,output_amount:'10000000',min_output_amount:'9900000',slippage:1};},
    query:async orderId=>{reads.push('query:'+orderId);if(orderId==='buy-order')return {order_id:orderId,status:'successful',state:30,hash:buyHash,
      ...(changes.fallback?{}:{strategy_order_id:'strategy-1'}),report:{input_token:SOL,output_token:mint,input_amount:'10000000',output_amount:quantity,input_token_decimals:9,output_token_decimals:5}};
      return state.queryPending?{order_id:orderId,status:'pending'}:{order_id:orderId,status:'successful',state:30,hash:sellHash,
        report:{input_token:mint,output_token:SOL,input_amount:remaining,output_amount:'10000000'}};},
    strategies:async (_w,_m,type)=>{reads.push('strategies:'+type);const r=parent(),closed=r.status==='closed';
      return {list:type==='open'?(closed?[]:[r,...state.foreign?[{...r,order_id:'foreign-parent',open_sign_hash:sellHash}]:[]]):closed?[r]:[],next_page_token:''};},
    cancel:async(w,orderId,nonce)=>{assert.equal(w,wallet);recorded('cancel',{chain:'sol',from_address:w,order_id:orderId},nonce);canceled=true;
      if(changes.cancelUnknown)throw Error('PRIVATE_UPSTREAM_ERROR');return {success:true,order_id:orderId};},
    swap:async(body,nonce)=>{assert.equal(body.input_token,mint);assert.equal(body.output_token,SOL);recorded('sell',body,nonce);sold=true;
      if(changes.sellUnknown)throw Error('PRIVATE_UPSTREAM_ERROR');return {order_id:'sell-order',status:'pending'};}
  };
  const chain:TestChainReader={snapshot:async()=>{reads.push('snapshot');return snap();},verifyTransaction:async r=>{
    reads.push('verify:'+r.side);assert.equal(r.wallet,wallet);assert.equal(r.mint,mint);
    const buy=r.side==='buy',partial=r.signature===partialHash;const fact:VerifiedSolanaTransaction={signature:buy?buyHash:partial?partialHash:sellHash,wallet,mint,side:r.side,slot:buy?100:partial?101:104,
      tokenDelta:buy?quantity:partial?'-250000000':'-'+remaining,nativeDelta:buy?'-10025000':'9975000',feeLamports:'25000',preTokenAmount:buy?'0':partial?quantity:remaining,postTokenAmount:buy?quantity:partial?remaining:'0',
      preNativeLamports:buy?'1010025000':'1000000000',postNativeLamports:buy?'1000000000':'1009975000',decimals:5,checkedAt:new Date(now).toISOString()};return fact;}};
  const open=(extra:Partial<ManualCloseOptions>={})=>{const service=new ManualCloseService(path,{positions:()=>[p],client,chain,enqueue:e=>{messages.push(e);return true;},now:()=>now,sleep:async()=>{},pollAttempts:1,...changes.partial?{partialSellSignatures:async()=>[partialHash]}:{},...extra});instances.push(service);return service;};
  return {path,p,client,chain,state,writes,reads,messages,open,advance:(ms:number)=>{now+=ms;},now:()=>now,
    close:async()=>{for(const s of instances){await s.stop();s.close();}rmSync(dir,{recursive:true,force:true});}};
}

test('preview binds exact listed protection, formats human quantity and canceled/expired confirmations never write',async()=>{
  const f=fixture();try {
    const s=f.open(),preview=await s.preview(f.p.id);assert.ok(preview.token);assert.match(preview.text,/strategy-1/);assert.match(preview.text,/5000 BONK/);assert.doesNotMatch(preview.text,/原子量|精度/);
    assert.equal(f.writes.length,0);assert.equal((await s.cancel(preview.token!)).state,'canceled');await s.confirm(preview.token!);assert.equal(f.writes.length,0);
    const again=await s.preview(f.p.id);f.advance(120000);assert.match((await s.confirm(again.token!)).text,/过期/);assert.equal(f.writes.length,0);
    assert.equal(statSync(f.path).mode&0o777,0o600);
  }finally{await f.close();}
});

test('explicit confirmation cancels only the disclosed parent then sells all fresh remaining tokens once and verifies finalized zero balance',async()=>{
  const f=fixture();try {
    const a=f.open(),b=f.open(),preview=await a.preview(f.p.id);const results=await Promise.all([a.confirm(preview.token!),b.confirm(preview.token!)]);
    assert.equal(a.status().requests[0].state,'closed',JSON.stringify(results));assert.equal(a.isClosed(f.p.id),true);assert.equal(a.isClosed('other'),false);assert.deepEqual(f.writes.map(w=>w.kind),['cancel','sell']);
    assert.equal(f.writes[1].body.input_amount,quantity);assert.equal(f.writes[1].body.condition_orders,undefined);
    assert.equal(new Set(f.writes.map(w=>w.nonce)).size,2);assert.ok(f.messages.some(m=>m.text.includes('finalized')));
    await a.confirm(preview.token!);await b.resume();assert.equal(f.writes.length,2);
  }finally{await f.close();}
});

test('strict unique amount-time-condition fallback is disclosed and checked again at confirmation',async()=>{
  const f=fixture({fallback:true});try {
    const s=f.open(),preview=await s.preview(f.p.id);assert.ok(preview.token,preview.text);assert.match(preview.text,/平台未提供关联交易哈希/);
    assert.match(preview.text,/确认即授权撤销/);assert.equal((await s.confirm(preview.token!)).state,'closed');assert.equal(f.writes.length,2);
  }finally{await f.close();}
  const bad=fixture({fallback:true});try {
    bad.p.protectionEvidence!.conditions=[...conditions.map(c=>({...c}))];bad.p.protectionEvidence!.conditions[0].price_scale='101';
    const s=bad.open(),preview=await s.preview(bad.p.id);assert.equal(preview.token,undefined);assert.equal(bad.writes.length,0);
  }finally{await bad.close();}
});

test('foreign or changed protection after preview blocks cancellation, and a triggered cancellation blocks selling',async()=>{
  for(const mode of ['foreign','hash','trigger'] as const){const f=fixture({afterCancelTrigger:mode==='trigger'});try {
    const s=f.open(),preview=await s.preview(f.p.id);assert.ok(preview.token);if(mode==='foreign')f.state.foreign=true;if(mode==='hash')f.state.badOwnership=true;
    const result=await s.confirm(preview.token!);assert.equal(result.state,'attention');assert.equal(f.writes.filter(w=>w.kind==='sell').length,0);
    assert.equal(f.writes.filter(w=>w.kind==='cancel').length,mode==='trigger'?1:0);
  }finally{await f.close();}}
});

test('unknown sell submission never retries after duplicate callbacks, new previews or process restart',async()=>{
  const f=fixture({sellUnknown:true});try {
    const s=f.open(),p=await s.preview(f.p.id),r=await s.confirm(p.token!);assert.equal(r.state,'attention');assert.match(r.text,/未知/);
    await s.confirm(p.token!);const reopened=f.open();await reopened.resume();assert.equal((await reopened.preview(f.p.id)).token,undefined);
    assert.equal(f.writes.filter(w=>w.kind==='sell').length,1);assert.ok(f.messages.every(m=>!m.text.includes('PRIVATE_UPSTREAM_ERROR')));
  }finally{await f.close();}
});

test('known pending sell recovers with GET and chain reads only after restart',async()=>{
  const f=fixture({queryPending:true});try {
    const s=f.open(),p=await s.preview(f.p.id);assert.equal((await s.confirm(p.token!)).state,'attention');const count=f.writes.length;
    const reopened=f.open();f.state.queryPending=false;await reopened.resume();assert.equal(reopened.status().requests[0].state,'closed');assert.equal(f.writes.length,count);
  }finally{await f.close();}
});

test('uncertain cancellation resumes read-only and needs a new owner confirmation before the first sell',async()=>{
  const f=fixture({cancelUnknown:true,cancelVisible:false});try {
    const s=f.open(),p=await s.preview(f.p.id);assert.equal((await s.confirm(p.token!)).state,'attention');assert.deepEqual(f.writes.map(w=>w.kind),['cancel']);
    f.state.cancelVisible=true;const resumed=f.open();await resumed.resume();assert.equal(resumed.status().requests[0].state,'awaiting_confirmation');assert.equal(f.writes.length,1);
    await resumed.confirm(p.token!);assert.equal(f.writes.length,1);const next=await resumed.preview(f.p.id);assert.ok(next.token);
    assert.equal((await resumed.confirm(next.token!)).state,'closed');assert.deepEqual(f.writes.map(w=>w.kind),['cancel','sell']);
  }finally{await f.close();}
});

test('fresh balance change after quote refuses the sell and unsupported chains never request providers',async()=>{
  const f=fixture({afterQuoteBalance:'500000001'});try {
    const s=f.open(),p=await s.preview(f.p.id);assert.equal((await s.confirm(p.token!)).state,'attention');assert.deepEqual(f.writes.map(w=>w.kind),['cancel']);
  }finally{await f.close();}
  const other=fixture();try {other.p.chain='bsc';const s=other.open();assert.match((await s.preview(other.p.id)).text,/仅支持 SOL/);assert.equal(other.reads.length,0);}finally{await other.close();}
});

test('missing optional token decimals are derived from fresh chain balance and verified buy proof',async()=>{
  const f=fixture();try {delete f.p.tokenDecimals;const s=f.open(),p=await s.preview(f.p.id);assert.ok(p.token,p.text);assert.equal((await s.confirm(p.token!)).state,'closed');}finally{await f.close();}
});

test('fresh preview accepts enriched trusted receipt fields while invalidating the old confirmation',async()=>{
  const f=fixture();try {
    delete f.p.tokenDecimals;const s=f.open(),old=await s.preview(f.p.id);assert.ok(old.token);await s.cancel(old.token!);
    f.p.tokenDecimals=5;f.p.strategyOrderIds=['strategy-1'];const fresh=await s.preview(f.p.id);assert.ok(fresh.token,fresh.text);
    await s.confirm(old.token!);assert.equal(f.writes.length,0);assert.equal((await s.confirm(fresh.token!)).state,'closed');
  }finally{await f.close();}
});


test('finalized partial take profit is proven against every chain sale and stable remaining balance before closing only the remainder',async()=>{
  const f=fixture({partial:true});try {
    const s=f.open(),p=await s.preview(f.p.id);assert.ok(p.token,p.text);assert.match(p.text,/历史部分卖出 1 笔/);assert.match(p.text,/2500 BONK/);
    assert.equal(f.writes.length,0);assert.equal((await s.confirm(p.token!)).state,'closed');
    assert.equal(f.writes.find(w=>w.kind==='sell')?.body.input_amount,'250000000');assert.equal(s.isClosed(f.p.id),true);
  }finally{await f.close();}
});

test('missing history, unfinalized or mismatched partial sales preserve active protection without any POST',async()=>{
  for(const mode of ['missing','truncated','unfinalized','transfer','balance'] as const){const f=fixture({partial:true});try {
    const original=f.chain.verifyTransaction;f.chain.verifyTransaction=async request=>{const value=await original(request);
      if(request.signature===partialHash){if(mode==='unfinalized')throw Error('NOT_FINALIZED');
        if(mode==='transfer')return {...value,nativeDelta:'0'};if(mode==='balance')return {...value,postTokenAmount:'250000001'};}return value;};
    const s=f.open(mode==='missing'?{partialSellSignatures:undefined}:mode==='truncated'?{partialSellSignatures:async()=>[]}:{});
    const p=await s.preview(f.p.id);assert.equal(p.token,undefined,mode);assert.match(p.text,/尚不能完整核验/);assert.equal(f.writes.length,0);
  }finally{await f.close();}}
});

test('a partial sell which becomes unknown after preview blocks confirmation before cancellation',async()=>{
  const f=fixture({partial:true});try {
    let allowed=true;const s=f.open({partialSellSignatures:async()=>{if(!allowed)throw Error('HISTORY_UNKNOWN');return [partialHash];}});
    const p=await s.preview(f.p.id);assert.ok(p.token);allowed=false;const r=await s.confirm(p.token!);
    assert.equal(r.state,'attention');assert.equal(f.writes.length,0);assert.equal(s.isClosed(f.p.id),false);
  }finally{await f.close();}
});

test('a quote failure after verified cancellation clearly says protection is gone and no sell was submitted',async()=>{
  const f=fixture();try {
    f.client.quote=async()=>({});const s=f.open(),p=await s.preview(f.p.id),r=await s.confirm(p.token!);
    assert.equal(r.state,'attention');assert.match(r.text,/保护单已核验撤销，尚未提交卖单/);assert.deepEqual(f.writes.map(w=>w.kind),['cancel']);
  }finally{await f.close();}
});
