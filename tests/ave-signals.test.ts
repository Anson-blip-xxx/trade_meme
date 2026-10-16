import test from 'node:test';
import assert from 'node:assert/strict';
import {AveSignalError,fetchAveSignalPage,normalizeAveSignalPush,normalizeAveSignals} from '../src/providers/ave-signals.js';
import type {Chain} from '../src/types.js';

const now=new Date('2026-10-16T01:40:15Z'),ca='0x610a36f996650be0561f5d74d36b7e73520a7777';
const wallet='0xb2374d152cf495383421355f8672a668af6f8dc6';
const sol='DFMt2FyLpB6ekPNAzVErLXgpSnJ9CRf1VnxBAkTLpump';
function row(chain:Chain='bsc'):Record<string,any> {
  return {id:3257177,chain,token:chain==='solana'?sol:ca,symbol:'特斯拉能飞',signal_time:1792114809,
    first_signal_time:1792114130,history_count:6,tag:'smarter_buy',action_type:'buy',action_count:2,
    issue_platform:chain==='solana'?'pump.fun':'flap.sh',headline:'供应商叙事不是已核实的名人背书',
    twitter_url:'https://x.com/zerohedge/status/2088251202056176024',mc:'160910',current_price_usd:'0.0001536',
    max_price_change:'3.1654178952965631',day_high_price:'0.00017234',
    actions:[{id:2414815,wallet_address:chain==='solana'?sol:wallet,wallet_alias:'test',
      action_time:1792114802,quote_token_volume:'360.7927069125',target_token_price:'0.00016091',action_type:'buy'}]};
}
const payload=(rows:unknown[]=[row()])=>({status:1,msg:'SUCCESS',data:{list:rows,page_token:'page_token_next'}});

test('Ave real observed envelope binds alarm time, CA, public wallet attribution and display context',()=>{
  const result=normalizeAveSignals(payload(),now),o=result.observations[0];
  assert.equal(result.received,1);assert.equal(result.rejected,0);assert.equal(result.next,'page_token_next');
  assert.equal(o.id,'3257177');assert.equal(o.signal.source,'ave');assert.equal(o.signal.claim,'unspecified');
  assert.equal(o.signal.occurredAt,'2026-10-16T01:40:09.000Z');assert.equal(o.observedAt,now.toISOString());
  assert.equal(o.firstSignalAt,'2026-10-16T01:28:50.000Z');assert.equal(o.kind,'smarter_buy');
  assert.equal(o.signal.claimedPlatform,'flap');assert.equal(o.vendorHistoryCount,6);assert.equal(o.vendorWalletCount,2);
  assert.deepEqual(o.vendorWallets,[{source:'ave',verification:'vendor_report',id:'2414815',address:wallet,
    alias:'test',side:'buy',lastTradeAt:'2026-10-16T01:40:02.000Z',volumeUsd:360.7927069125,priceUsd:0.00016091}]);
  assert.equal(o.alertMarketCapUsd,160910);assert.equal(o.currentPriceUsd,.0001536);
  assert.match(o.signal.evidenceUrls[0],/^https:\/\/ave\.ai\/token\//);
  assert.equal(o.signal.vendorNarrative,undefined);assert.equal('txRefs' in o,false);assert.equal('max_price_change' in o,false);
  assert.equal(o.signal.text.includes('供应商叙事'),false);assert.equal(o.socialUrl,row().twitter_url);
});

test('all three chains retain exact full address, Solana case, and cross-chain filtering',()=>{
  for(const chain of ['bsc','solana','robinhood'] as const){
    const o=normalizeAveSignals(payload([row(chain)]),now,[chain]).observations[0];
    assert.equal(o.signal.token.chain,chain);assert.equal(o.signal.token.address,chain==='solana'?sol:ca);
  }
  assert.equal(normalizeAveSignals(payload([row('solana')]),now,['bsc']).rejected,1);
  const upper=row();upper.token='0x'+ca.slice(2).toUpperCase();upper.actions[0].wallet_address='0x'+wallet.slice(2).toUpperCase();
  const o=normalizeAveSignals(payload([upper]),now).observations[0];assert.equal(o.signal.token.address,ca);
  assert.equal(o.vendorWallets?.[0].address,wallet);
});

test('refreshes, vendor id revisions, prices, ATH and repeats cannot manufacture a new event',()=>{
  const before=normalizeAveSignals(payload(),now).observations[0],changed=row();
  changed.id++;changed.history_count=100;changed.mc_cur='9999999';changed.max_price_change='10000';
  changed.current_price_usd='100';changed.headline='different narrative';changed.twitter_url='https://x.com/elonmusk';
  changed.symbol='renamed';changed.actions.push({...changed.actions[0],id:9999});
  const after=normalizeAveSignals(payload([changed]),new Date(now.getTime()+60_000)).observations[0];
  assert.deepEqual(before.signal,after.signal);assert.notEqual(before.currentPriceUsd,after.currentPriceUsd);
  assert.equal(normalizeAveSignals(payload([row(),changed]),now).observations.length,1);
  changed.signal_time++;const newEvent=normalizeAveSignals(payload([changed]),now).observations[0];
  assert.notEqual(newEvent.signal.sourceEventId,before.signal.sourceEventId);
  changed.tag='kol_buy';assert.notEqual(normalizeAveSignals(payload([changed]),now).observations[0].signal.sourceEventId,newEvent.signal.sourceEventId);
});

test('malformed/unsupported identities, time units and false direction are rejected without fetch-time substitution',()=>{
  const edits:((row:any)=>void)[]=[r=>delete r.id,r=>r.id='secret',r=>r.id=1.25,r=>r.id=Number.MAX_SAFE_INTEGER+1,
    r=>delete r.token,r=>r.token='0x61...7777',r=>r.token=sol,r=>r.chain='sol',r=>r.chain='eth',
    r=>delete r.signal_time,r=>r.signal_time=now.getTime(),r=>r.signal_time=1792114809.5,r=>r.signal_time=0,
    r=>r.signal_time=now.getTime()/1000+31,r=>r.signal_time='2026-10-16',r=>r.tag='smarter_buy\nsecret',
    r=>delete r.tag,r=>r.action_type='sell',r=>delete r.action_type];
  for(const edit of edits){const r=row();edit(r);const result=normalizeAveSignals(payload([r]),now);
    assert.equal(result.observations.length,0,JSON.stringify(r));assert.equal(result.rejected,1);}
  const r=row();r.signal_time='1792114809';assert.equal(normalizeAveSignals(payload([r]),now).observations.length,1);
  r.signal_time=1700000000;assert.equal(normalizeAveSignals(payload([r]),now).observations[0].signal.occurredAt,'2023-11-14T22:13:20.000Z');
  assert.equal(normalizeAveSignals(payload(),new Date('bad')).reason,'AVE_SIGNAL_INPUT_INVALID');
  assert.equal(normalizeAveSignals(payload(),now,[]).reason,'AVE_SIGNAL_INPUT_INVALID');
});

test('wallets without full addresses, contradictory token/chain or future times cannot be attributed',()=>{
  const r=row(),valid=r.actions[0];r.actions=[valid,valid,{...valid,wallet_address:''},
    {...valid,wallet_address:'0xb2...dc6'},{...valid,chain:'solana'},{...valid,token:wallet},
    {...valid,action_time:now.getTime()},{...valid,action_time:now.getTime()/1000+31}];
  const o=normalizeAveSignals(payload([r]),now).observations[0];assert.equal(o.vendorWallets?.length,1);
  r.actions=[{wallet_address:wallet,wallet_alias:'name',quote_token_volume:'Infinity',target_token_price:'-1'}];
  assert.deepEqual(normalizeAveSignals(payload([r]),now).observations[0].vendorWallets,
    [{source:'ave',verification:'vendor_report',address:wallet,alias:'name'}]);
});

test('public links cannot introduce credentials, HTTP or untrusted social hosts',()=>{
  for(const link of ['http://x.com/elonmusk','https://x.com.evil.test/elonmusk','https://secret@x.com/elonmusk',
    'https://x.com:8443/elonmusk','javascript:alert(1)']){
    const r=row();r.twitter_url=link;assert.equal(normalizeAveSignals(payload([r]),now).observations[0].socialUrl,undefined);
  }
});

test('only observed JSON-RPC signal push shape is accepted; heartbeat and price do not become alarms',()=>{
  const frame={jsonrpc:'2.0',id:86986,result:{status:'ok',data:{event:'signalsv2_public_monitor',msg:row()}}};
  const result=normalizeAveSignalPush(frame,now);assert.deepEqual(result.observations,normalizeAveSignals(payload(),now).observations);
  for(const wrong of [null,{},row(),{...frame,jsonrpc:'1.0'},
    {...frame,result:{...frame.result,status:'error'}},
    {...frame,result:{status:'ok',data:{event:'sub_tokens_extra',msg:row()}}},
    {...frame,result:{status:'ok',data:{event:'signalsv2_public_monitor',msg:[row()]}}}])
    assert.equal(normalizeAveSignalPush(wrong,now).reason,'AVE_SIGNAL_PUSH_INVALID');
});

test('bounded first-page normalization does not follow pagination or accept failure envelopes',()=>{
  const many=Array.from({length:25},(_,i)=>({...row(),signal_time:1792114809-i}));
  const result=normalizeAveSignals(payload(many),now);assert.equal(result.received,25);
  assert.equal(result.observations.length,20);assert.equal(result.rejected,5);
  for(const bad of [{...payload(),status:0},{...payload(),status:'1'},null,{status:1,data:{list:{}}}])
    assert.equal(normalizeAveSignals(bad,now).reason,'AVE_SIGNAL_RESPONSE_INVALID');
});

test('public HTTP uses fixed GET endpoint, bounded chain query, no credentials, no redirect or second page',async()=>{
  let calls=0;const result=await fetchAveSignalPage(['bsc','solana','bsc'],{now:()=>now,fetcher:async(input,init)=>{
    calls++;const u=new URL(String(input));assert.equal(u.origin,'https://yiyulu.com');
    assert.equal(u.pathname,'/v2api/signals/v2/public/multi_chain/list');
    assert.equal(u.searchParams.get('chain'),'bsc,solana');assert.equal(u.searchParams.get('pageSize'),'20');
    assert.equal(init?.method,'GET');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
    const h=new Headers(init?.headers);assert.equal(h.has('Authorization'),false);assert.equal(h.has('X-Auth'),false);
    assert.ok(init?.signal);return Response.json(payload());
  }});assert.equal(calls,1);assert.equal(result.observations.length,1);
  await assert.rejects(fetchAveSignalPage(['eth' as Chain],{fetcher:async()=>{throw Error('must not fetch');}}),/AVE_SIGNAL_INPUT_INVALID/);
});

test('HTTP failures retain only safe reasons and rate-limit cooldowns',async()=>{
  for(const status of [401,403,429,500])await assert.rejects(fetchAveSignalPage(['bsc'],{now:()=>now,
    fetcher:async()=>new Response('secret-cookie-and-token',{status,headers:{'retry-after':'120'}})}),error=>{
    assert.ok(error instanceof AveSignalError);assert.equal(error.reason,status===500?'AVE_SIGNAL_HTTP_ERROR':`AVE_SIGNAL_HTTP_${status}`);
    assert.equal(error.cooldownUntil,status===429?now.getTime()+120000:undefined);return true;
  });
  await assert.rejects(fetchAveSignalPage(['bsc'],{fetcher:async()=>{throw Error('secret https://credential@evil.test');}}),/^(AveSignalError: )?AVE_SIGNAL_REQUEST_FAILED$/);
  await assert.rejects(fetchAveSignalPage(['bsc'],{fetcher:async()=>new Response('<html>login</html>')}),/AVE_SIGNAL_INVALID_JSON/);
});

test('oversized and aborted responses stop before normalizing',async()=>{
  await assert.rejects(fetchAveSignalPage(['bsc'],{fetcher:async()=>new Response('{}',{headers:{'content-length':String(3*1024*1024)}})}),/AVE_SIGNAL_RESPONSE_TOO_LARGE/);
  await assert.rejects(fetchAveSignalPage(['bsc'],{fetcher:async()=>new Response(' '.repeat(2*1024*1024+1))}),/AVE_SIGNAL_RESPONSE_TOO_LARGE/);
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(fetchAveSignalPage(['bsc'],{signal:controller.signal,fetcher:async()=>{calls++;return Response.json(payload());}}),/AVE_SIGNAL_REQUEST_TIMEOUT/);
  assert.equal(calls,0);
  const delayed=new AbortController();const request=fetchAveSignalPage(['bsc'],{signal:delayed.signal,fetcher:async()=>new Promise(()=>{})});
  delayed.abort();await assert.rejects(request,/AVE_SIGNAL_REQUEST_TIMEOUT/);
});
