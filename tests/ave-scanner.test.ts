import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AveScanner,type AveScannerOptions,type AveSocket} from '../src/ave-scanner.js';
import {normalizeAveSignals,type AveSignalObservation} from '../src/providers/ave-signals.js';
import type {Report,Signal} from '../src/types.js';

const base=Date.parse('2026-10-16T01:40:15Z'),ca='0x610a36f996650be0561f5d74d36b7e73520a7777';
const wallet='0xb2374d152cf495383421355f8672a668af6f8dc6',other='0x1111111111111111111111111111111111111111';
function raw(at=base-6000,token=ca,id=1){return {id,chain:'bsc',token,symbol:'TEST',tag:'smarter_buy',action_type:'buy',
  signal_time:at/1000,action_count:1,actions:[{id:100,wallet_address:wallet,action_time:at/1000,action_type:'buy'}]};}
function page(at=base-6000,token=ca,id=1,seen=base){return normalizeAveSignals({status:1,data:{list:[raw(at,token,id)]}},new Date(seen));}
class Socket implements AveSocket {
  readyState=0;sent:string[]=[];closed=false;listeners=new Map<string,Set<(e:any)=>void>>();
  send(data:string){this.sent.push(data);}close(){this.closed=true;this.readyState=3;}
  addEventListener(type:string,listener:(event:any)=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(listener);}
  removeEventListener(type:string,listener:(event:any)=>void){this.listeners.get(type)?.delete(listener);}
  emit(type:string,event:any={}){if(type==='open')this.readyState=1;for(const f of this.listeners.get(type)??[])f(event);}
}
/** The live Ave control proved pricev2 subscribe replaces all price topics.
 * Treat unsubscribe conservatively as clearing the price channel, so the test
 * also catches remove-only updates that fail to restore remaining holdings. */
class ReplacingPriceSocket extends Socket {
  priceTopics=new Set<string>();
  override send(data:string){
    super.send(data);const frame=JSON.parse(data);
    if(frame.params?.[0]!=='pricev2')return;
    if(frame.method==='subscribe')this.priceTopics=new Set(frame.params[1]);
    if(frame.method==='unsubscribe')this.priceTopics.clear();
  }
  quote(token:string,at:number){
    if(this.priceTopics.has(`${token}-bsc`))this.emit('message',{data:JSON.stringify(priceFrame([priceRow(token,at)]))});
  }
}
function setup(extra:Partial<AveScannerOptions>={}){
  let now=base;const observations:AveSignalObservation[]=[],signals:Signal[]=[];
  const scanner=new AveScanner({database:':memory:',chains:['bsc','solana','robinhood'],now:()=>new Date(now),
    onObservation:o=>{observations.push(o);},onSignal:async s=>{signals.push(s);},...extra});
  return {scanner,observations,signals,advance:(ms:number)=>{now+=ms;},time:()=>now};
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const priceFrame=(rows:unknown[])=>({jsonrpc:'2.0',result:{status:'ok',data:{event:'pricev2',prices:rows}}});
const priceRow=(token=ca,at=base,price=1)=>({chain:'bsc',token,target_token:token,is_main_pair:true,uprice:price,time:at/1000});

test('observations persist immediately, duplicate refreshes never requeue or change first timestamp',async()=>{
  const {scanner,observations,signals,advance}=setup();try{
    scanner.acceptPage(page());assert.equal(observations.length,1);assert.equal(signals.length,0);
    const item=scanner.list().items[0];assert.equal(item.firstObservedAt,new Date(base).toISOString());
    advance(5000);scanner.acceptPage(page(base-6000,ca,999,base+5000));
    assert.equal(observations.length,1);assert.equal(scanner.list().total,1);assert.equal(scanner.list().items[0].vendorId,'1');
    await scanner.dispatchOnce();assert.equal(signals.length,1);assert.equal(scanner.list().items[0].state,'completed');
    scanner.acceptPage(page());await scanner.dispatchOnce();assert.equal(signals.length,1);
  }finally{await scanner.close();}
});

test('SOL-only restart leaves BSC history readable without dispatching old pending observations',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ave-chain-scope-')),database=join(root,'ave.sqlite');
  const first=setup({database,chains:['bsc']});
  try {
    first.scanner.acceptPage(page());await first.scanner.close();
    const resumed=setup({database,chains:['solana']});
    try {
      await resumed.scanner.dispatchOnce();assert.equal(resumed.signals.length,0);
      assert.equal(resumed.scanner.list({chain:'bsc'}).total,1);
      assert.equal(resumed.scanner.list().items[0].state,'pending');
    }finally{await resumed.scanner.close();}
  }finally{await first.scanner.close();rmSync(root,{recursive:true,force:true});}
});

test('new alarms of same CA coalesce while safety jobs are pending; newer time wins late arrivals',async()=>{
  const {scanner,observations,signals}=setup();try{
    scanner.acceptPage(page(base-30_000));scanner.acceptPage(page(base-10_000,ca,2));scanner.acceptPage(page(base-20_000,ca,3));
    assert.equal(observations.length,3);assert.equal(scanner.getStatus().pending,1);
    await scanner.dispatchOnce();assert.equal(signals.length,1);assert.equal(signals[0].occurredAt,new Date(base-10_000).toISOString());
    assert.equal(scanner.list().items.filter(i=>i.reason==='AVE_SIGNAL_TOKEN_COALESCED').length,2);
  }finally{await scanner.close();}
});

test('same CA research is at least sixty seconds apart, other tokens respect one-second global dispatch',async()=>{
  const {scanner,signals,advance,time}=setup();try{
    scanner.acceptPage(page());await scanner.dispatchOnce();assert.equal(signals.length,1);
    advance(1000);scanner.acceptPage(page(time(),ca,2,time()));scanner.acceptPage(page(time(),other,3,time()));
    await scanner.dispatchOnce();assert.equal(signals.length,2);assert.equal(signals[1].token.address,other);
    await scanner.dispatchOnce();assert.equal(signals.length,2);
    advance(58_000);await scanner.dispatchOnce();assert.equal(signals.length,2);
    advance(1000);await scanner.dispatchOnce();assert.equal(signals.length,3);assert.equal(signals[2].token.address,ca);
  }finally{await scanner.close();}
});

test('GMGN deferral preserves observation flow; stale alarms never become new research events',async()=>{
  let defer='GMGN_BUSY';const {scanner,observations,signals,advance}=setup({shouldDefer:()=>defer||undefined});try{
    scanner.acceptPage(page());await scanner.dispatchOnce();assert.equal(signals.length,0);assert.equal(observations.length,1);
    assert.equal(scanner.getStatus().deferredReason,'GMGN_BUSY');
    advance(121_000);defer='';await scanner.dispatchOnce();assert.equal(signals.length,0);
    assert.equal(scanner.list().items[0].reason,'AVE_SIGNAL_STALE');
    scanner.acceptPage(page(base-300_000,other,2,base+121_000));assert.equal(observations.length,2);
    assert.equal(scanner.list().items[0].reason,'AVE_SIGNAL_STALE');
  }finally{await scanner.close();}
});

test('single inflight analysis cannot block immediate observations or exceed callback concurrency',async()=>{
  let resolve!:()=>void,count=0;const waiting=new Promise<void>(r=>{resolve=r;});
  const {scanner,observations,advance,time}=setup({onSignal:async()=>{count++;await waiting;}});try{
    scanner.acceptPage(page());const dispatch=scanner.dispatchOnce();await flush();assert.equal(count,1);
    advance(1000);scanner.acceptPage(page(time(),other,2,time()));assert.equal(observations.length,2);
    assert.equal(scanner.dispatchOnce(),dispatch);assert.equal(count,1);resolve();await dispatch;
    await scanner.dispatchOnce();assert.equal(count,2);
  }finally{resolve();await scanner.close();}
});

test('actual vendor wallet targets retain original observed time and expire; wrong-token requests cannot read them',async()=>{
  const {scanner,advance}=setup();try{
    const p=page();scanner.acceptPage(p);const signal=p.observations[0].signal;
    const targets=scanner.vendorWalletTargets(signal);assert.deepEqual(targets,{provider:'ave',token:signal.token,
      checkedAt:new Date(base).toISOString(),addresses:[wallet]});
    assert.equal(scanner.vendorWalletTargets({...signal,token:{...signal.token,address:other}}),undefined);
    advance(120_001);scanner.acceptPage(page(base-6000,ca,999,base+120_001));
    assert.equal(scanner.vendorWalletTargets(signal),undefined);
  }finally{await scanner.close();}
});

test('safety reports bind exact signal and token and are displayed separately from opportunity',async()=>{
  let scanner!:AveScanner;const p=page(),signal=p.observations[0].signal;
  const check={status:'pass' as const,reasons:[],checkedAt:new Date(base).toISOString(),facts:{secret:'not persisted'}};
  const report={id:'00000000-0000-0000-0000-000000000001',mode:'live',signal,evaluatedAt:new Date(base).toISOString(),
    validUntil:new Date(base+60_000).toISOString(),decision:'WATCH',buyEligible:false,reasons:['WALLET_DATA_UNKNOWN'],
    safety:check,provenance:check,marketRisk:check,flow:{...check,status:'unknown'}} as unknown as Report;
  ({scanner}=setup({onSignal:async()=>{scanner.recordReport(signal.sourceEventId,report);}}));try{
    scanner.acceptPage(p);await scanner.dispatchOnce();const item=scanner.list().items[0];
    assert.equal(item.reportId,report.id);assert.equal(item.decision,'WATCH');assert.equal(item.riskScore.value,60);
    assert.equal(JSON.stringify(item).includes('secret'),false);assert.equal(item.riskScore.version,'risk-evidence-v1');
    scanner.recordReport(signal.sourceEventId,{...report,signal:{...signal,token:{...signal.token,address:other}},decision:'REJECT'});
    assert.equal(scanner.list().items[0].decision,'WATCH');
  }finally{await scanner.close();}
});

test('stable pagination and chain filtering do not change historical baseline',async()=>{
  const {scanner,advance,time}=setup();try{
    scanner.acceptPage(page());const first=scanner.list({limit:1});advance(1000);
    scanner.acceptPage(page(time(),other,2,time()));
    const anchored=scanner.list({limit:1,asOf:first.asOf});assert.equal(anchored.total,1);assert.equal(anchored.items[0].address,ca);
    assert.equal(scanner.list({chain:'bsc',limit:1}).hasMore,true);assert.equal(scanner.list({chain:'solana'}).total,0);
    assert.equal(scanner.list({limit:1,offset:1}).items[0].address,ca);
    for(const opts of [{limit:0},{limit:101},{offset:-1},{asOf:'2026-02-30T00:00:00.000Z'}])assert.throws(()=>scanner.list(opts),/INVALID_FILTER/);
  }finally{await scanner.close();}
});

test('public websocket sends only observed subscription; other channels and malformed/large frames do not feed research',async()=>{
  const socket=new Socket();let url='';const {scanner,observations}=setup({socketFactory:u=>{url=u;return socket;},
    fetcher:async()=>Response.json({status:1,data:{list:[]}})});try{
    scanner.start();assert.equal(url,'wss://yiyulu.com/ws');socket.emit('open');
    assert.deepEqual(JSON.parse(socket.sent[0]),{jsonrpc:'2.0',method:'subscribe',params:['signalsv2_public_monitor','bsc,solana,robinhood'],id:1});
    assert.equal(scanner.getStatus().mode,'public_signal_stream');assert.equal(scanner.getStatus().connected,true);
    socket.emit('message',{data:'pong'});assert.equal(scanner.getStatus().lastMessageAt,new Date(base).toISOString());
    assert.equal(scanner.getStatus().lastError,undefined);
    const frame={jsonrpc:'2.0',result:{status:'ok',data:{event:'signalsv2_public_monitor',msg:raw()}}};
    socket.emit('message',{data:JSON.stringify(frame)});assert.equal(observations.length,1);
    socket.emit('message',{data:JSON.stringify({...frame,result:{status:'ok',data:{event:'pricev2',msg:raw(base,other)}}})});
    assert.equal(observations.length,1);socket.emit('message',{data:'not-json'});assert.equal(observations.length,1);
    socket.emit('message',{data:' '.repeat(2*1024*1024+1)});assert.equal(socket.closed,true);
    assert.equal(scanner.getStatus().connectionState,'backoff');assert.equal(scanner.getStatus().lastError,'AVE_STREAM_FRAME_INVALID');
  }finally{await scanner.close();}
});

test('stop cancels collection and research waits, removes listeners and suppresses late callbacks',async()=>{
  let release!:()=>void;const wait=new Promise<void>(r=>{release=r;}),socket=new Socket();
  const {scanner,observations}=setup({onSignal:async()=>wait,fetcher:async()=>new Promise(()=>{}),socketFactory:()=>socket});
  scanner.acceptPage(page());scanner.start();await flush();assert.equal(scanner.getStatus().pending,1);
  const stopped=scanner.stop();await stopped;assert.equal(scanner.getStatus().interrupted,1);assert.equal(socket.closed,true);
  socket.emit('message',{data:JSON.stringify({jsonrpc:'2.0',result:{status:'ok',data:{event:'signalsv2_public_monitor',msg:raw(base,other)}}})});
  assert.equal(observations.length,1);await scanner.close();release();await flush();
});

test('current-price subscriptions share signal socket, replace topics, and retain their provider frame clock',async()=>{
  const socket=new Socket(),prices:{raw:unknown;receivedAt:string}[]=[];
  const {scanner,observations}=setup({socketFactory:()=>socket,fetcher:async()=>Response.json({status:1,data:{list:[]}}),
    onPriceFrame:(raw,receivedAt)=>{prices.push({raw,receivedAt});}});
  try{
    scanner.setPriceTokens([{chain:'bsc',address:ca},{chain:'bsc',address:ca},{chain:'bsc',address:'invalid'}]);
    scanner.start();socket.emit('open');
    assert.deepEqual(JSON.parse(socket.sent[1]).params,['pricev2',[`${ca}-bsc`]]);
    scanner.setPriceTokens([{chain:'bsc',address:other}]);
    assert.equal(JSON.parse(socket.sent[2]).method,'unsubscribe');assert.deepEqual(JSON.parse(socket.sent[2]).params,['pricev2',[`${ca}-bsc`]]);
    assert.equal(JSON.parse(socket.sent[3]).method,'subscribe');assert.deepEqual(JSON.parse(socket.sent[3]).params,['pricev2',[`${other}-bsc`]]);
    const frame={jsonrpc:'2.0',result:{status:'ok',data:{event:'pricev2',prices:[{chain:'bsc',token:other,time:base/1000-1,uprice:1}]}}};
    socket.emit('message',{data:JSON.stringify(frame)});assert.deepEqual(prices,[{raw:frame,receivedAt:new Date(base).toISOString()}]);
    assert.equal(observations.length,0);await scanner.stop();
    socket.emit('message',{data:JSON.stringify(frame)});assert.equal(prices.length,1);
  }finally{await scanner.close();}
});

test('SOL-only new signals keep explicit BSC holding price topics alive',async()=>{
  const socket=new Socket(),prices:unknown[]=[];
  const {scanner}=setup({chains:['solana'],socketFactory:()=>socket,fetcher:async()=>Response.json({status:1,data:{list:[]}}),
    onPriceFrame:raw=>{prices.push(raw);}});
  try {
    scanner.setPriceTokens([{chain:'bsc',address:ca}]);scanner.start();socket.emit('open');
    assert.deepEqual(JSON.parse(socket.sent[0]).params,['signalsv2_public_monitor','solana']);
    assert.deepEqual(JSON.parse(socket.sent[1]).params,['pricev2',[`${ca}-bsc`]]);
    const frame={jsonrpc:'2.0',result:{status:'ok',data:{event:'pricev2',prices:[{chain:'bsc',token:ca,time:base/1000-1,uprice:1}]}}};
    socket.emit('message',{data:JSON.stringify(frame)});assert.deepEqual(prices,[frame]);
  }finally{await scanner.close();}
});

test('replacement-style pricev2 keeps existing holdings when adding topics, removing only, and clearing all',async()=>{
  const socket=new ReplacingPriceSocket(),f=setup({socketFactory:()=>socket,fetcher:async()=>Response.json({status:1,data:{list:[]}})});
  try{
    f.scanner.setPriceTokens([], [{chain:'bsc',address:ca}]);f.scanner.start();socket.emit('open');socket.quote(ca,f.time());
    assert.equal(f.scanner.getStatus().priceStream.priorityFreshTokens,1);
    const initialClock=f.scanner.getStatus().priceStream.lastPriceAt;
    f.advance(1000);f.scanner.setPriceTokens([{chain:'bsc',address:other}], [{chain:'bsc',address:ca}]);
    assert.deepEqual([...socket.priceTopics],[`${ca}-bsc`,`${other}-bsc`]);
    assert.equal(f.scanner.getStatus().priceStream.lastPriceAt,initialClock,'subscription changes must not fabricate a quote');
    socket.quote(ca,f.time());socket.quote(other,f.time());assert.equal(f.scanner.getStatus().priceStream.freshTokens,2);
    f.advance(1000);f.scanner.setPriceTokens([], [{chain:'bsc',address:ca}]);
    assert.deepEqual([...socket.priceTopics],[`${ca}-bsc`]);
    socket.quote(ca,f.time());assert.equal(f.scanner.getStatus().priceStream.lastPriceAt,new Date(f.time()).toISOString());
    assert.equal(f.scanner.hasPriceSubscription({chain:'bsc',address:other}),false);
    f.scanner.setPriceTokens([]);assert.equal(socket.priceTopics.size,0);
    assert.equal(f.scanner.getStatus().priceStream.sentTokens,0);assert.equal(f.scanner.getStatus().priceStream.state,'inactive');
    const sent=socket.sent.length;f.scanner.setPriceTokens([]);assert.equal(socket.sent.length,sent);
  }finally{await f.scanner.close();}
});

test('explicit holdings have priority over a full research price-topic budget and overflow is visible',async()=>{
  const socket=new Socket(),{scanner}=setup({chains:['solana'],socketFactory:()=>socket,
    fetcher:async()=>Response.json({status:1,data:{list:[]}})});
  try{
    const research=Array.from({length:205},(_,i)=>({chain:'bsc' as const,address:'0x'+(i+1).toString(16).padStart(40,'0')}));
    scanner.setPriceTokens(research,[{chain:'bsc',address:ca.toUpperCase().replace('0X','0x')},{chain:'bsc',address:ca},{chain:'bsc',address:other}]);
    scanner.start();socket.emit('open');
    const topics=JSON.parse(socket.sent[1]).params[1];
    assert.equal(topics.length,200);assert.deepEqual(topics.slice(0,2),[`${ca}-bsc`,`${other}-bsc`]);
    const status=scanner.getStatus().priceStream;
    assert.equal(status.priorityTokens,2);assert.equal(status.desiredPriorityTokens,2);assert.equal(status.desiredTokens,207);
    assert.equal(status.overflowTokens,7);assert.equal(status.sentTokens,200);assert.equal(status.subscriptionBasis,'request_sent');
    assert.equal(status.subscriptionAcknowledged,false);assert.equal(status.observedTokens,0);assert.equal(status.state,'waiting');
    const sent=socket.sent.length;scanner.setPriceTokens(research,[{chain:'bsc',address:ca},{chain:'bsc',address:other}]);assert.equal(socket.sent.length,sent);
  }finally{await scanner.close();}
});

test('reconnect restores the latest desired price topics before waiting for new quotes, without stale listeners',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});t.mock.method(Math,'random',()=>0.5);
  const sockets:Socket[]=[],received:unknown[]=[],f=setup({socketFactory:()=>{const s=new Socket();sockets.push(s);return s;},
    fetcher:async()=>Response.json({status:1,data:{list:[]}}),onPriceFrame:frame=>received.push(frame)});
  try{
    f.scanner.setPriceTokens([{chain:'bsc',address:ca}],[{chain:'bsc',address:ca}]);f.scanner.start();sockets[0].emit('open');await flush();
    sockets[0].emit('message',{data:JSON.stringify(priceFrame([priceRow()]))});assert.equal(f.scanner.getStatus().priceStream.state,'live');
    sockets[0].emit('close');assert.equal(f.scanner.getStatus().priceStream.sentTokens,0);
    assert.equal(f.scanner.getStatus().priceStream.state,'disconnected');
    f.scanner.setPriceTokens([{chain:'bsc',address:other}],[{chain:'bsc',address:other}]);
    f.advance(1000);t.mock.timers.tick(1000);await flush();assert.equal(sockets.length,2);sockets[1].emit('open');
    assert.deepEqual(JSON.parse(sockets[1].sent[1]).params,['pricev2',[`${other}-bsc`]]);
    assert.equal(f.scanner.getStatus().priceStream.state,'waiting');
    sockets[0].emit('message',{data:JSON.stringify(priceFrame([priceRow(other,f.time())]))});assert.equal(received.length,1);
    sockets[1].emit('message',{data:JSON.stringify(priceFrame([priceRow(other,f.time())]))});
    assert.equal(received.length,2);assert.equal(f.scanner.getStatus().priceStream.state,'live');
  }finally{await f.scanner.close();}
});

test('only valid main-pair prices for subscribed exact identities advance quote health; pongs and replays cannot freshen it',async()=>{
  const socket=new Socket(),f=setup({socketFactory:()=>socket,fetcher:async()=>Response.json({status:1,data:{list:[]}})});
  try{
    f.scanner.setPriceTokens([{chain:'bsc',address:ca}],[{chain:'bsc',address:ca}]);f.scanner.start();socket.emit('open');
    socket.emit('message',{data:'pong'});socket.emit('message',{data:JSON.stringify({jsonrpc:'2.0',id:11,result:{status:'ok'}})});
    assert.equal(f.scanner.getStatus().priceStream.lastFrameAt,undefined);assert.equal(f.scanner.getStatus().priceStream.lastPriceAt,undefined);
    const invalid=[priceRow(other),{...priceRow(),target_token:other},{...priceRow(),chain:'solana'},
      {...priceRow(),is_main_pair:false},{...priceRow(),uprice:'1'},{...priceRow(),uprice:0},{...priceRow(),time:base/1000+1},
      {...priceRow(),time:base/1000+0.1}];
    socket.emit('message',{data:JSON.stringify(priceFrame(invalid))});
    assert.equal(f.scanner.getStatus().priceStream.lastPriceAt,undefined);assert.equal(f.scanner.getStatus().priceStream.freshTokens,0);
    socket.emit('message',{data:JSON.stringify(priceFrame([priceRow(ca,base-1000)]))});
    const live=f.scanner.getStatus().priceStream;assert.equal(live.lastPriceAt,new Date(base-1000).toISOString());
    assert.equal(live.lastPriceReceivedAt,new Date(base).toISOString());assert.equal(live.priorityFreshTokens,1);
    f.advance(61_000);socket.emit('message',{data:'pong'});
    socket.emit('message',{data:JSON.stringify(priceFrame([priceRow(ca,base-1000)]))});
    const stale=f.scanner.getStatus().priceStream;assert.equal(stale.lastPriceReceivedAt,live.lastPriceReceivedAt);
    assert.equal(stale.lastFrameAt,new Date(f.time()).toISOString());assert.equal(stale.state,'stale');assert.equal(stale.freshTokens,0);
  }finally{await f.scanner.close();}
});

test('stalled holding recovery retains healthy holdings and research on replacement-style subscriptions without refreshing quote clocks',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const socket=new ReplacingPriceSocket();let httpRequests=0;
  const research='0x2222222222222222222222222222222222222222';
  const f=setup({chains:['bsc'],socketFactory:()=>socket,fetcher:async()=>{httpRequests++;return Response.json({status:1,data:{list:[]}});}});
  try{
    f.scanner.setPriceTokens([{chain:'bsc',address:research}], [{chain:'bsc',address:ca},{chain:'bsc',address:other}]);
    f.scanner.start();socket.emit('open');await flush();
    const advance=async()=>{f.advance(15000);socket.emit('message',{data:'pong'});
      socket.emit('message',{data:JSON.stringify(priceFrame([priceRow(other,f.time())]))});t.mock.timers.tick(15000);await flush();};
    for(let i=0;i<4;i++)await advance();
    const recovery=socket.sent.map(text=>JSON.parse(text)).filter(frame=>frame.method==='unsubscribe');
    assert.deepEqual(recovery.map(frame=>frame.params),[['pricev2',[`${ca}-bsc`]]]);
    assert.deepEqual([...socket.priceTopics],[`${ca}-bsc`,`${other}-bsc`,`${research}-bsc`]);
    assert.equal(f.scanner.getStatus().priceStream.recoveries,1);assert.equal(f.scanner.getStatus().priceStream.state,'partial');
    assert.equal(f.scanner.getStatus().priceStream.priorityFreshTokens,1);
    for(let i=0;i<7;i++)await advance();assert.equal(f.scanner.getStatus().priceStream.recoveries,1);
    await advance();assert.equal(f.scanner.getStatus().priceStream.recoveries,2);
    assert.deepEqual(socket.sent.map(text=>JSON.parse(text)).filter(frame=>frame.method==='unsubscribe').map(frame=>frame.params),
      [['pricev2',[`${ca}-bsc`]],['pricev2',[`${ca}-bsc`]]]);
    assert.deepEqual([...socket.priceTopics],[`${ca}-bsc`,`${other}-bsc`,`${research}-bsc`]);
    assert.equal(f.scanner.getStatus().priceStream.observedTokens,1,'resubscription cannot make the silent holding/research look observed');
    assert.ok(httpRequests<=4,'recovery must not add HTTP requests beyond the preexisting one-minute signal poll');
    socket.emit('message',{data:JSON.stringify(priceFrame([priceRow(ca,f.time())]))});
    assert.equal(f.scanner.getStatus().priceStream.state,'live');assert.equal(f.scanner.getStatus().priceStream.lastError,undefined);
    assert.equal(socket.closed,false);
  }finally{await f.scanner.close();}
});

test('a fully silent transport reconnects at the heartbeat deadline and reports price subscription rejection safely',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});t.mock.method(Math,'random',()=>0.5);
  const sockets:Socket[]=[],f=setup({socketFactory:()=>{const s=new Socket();sockets.push(s);return s;},fetcher:async()=>Response.json({status:1,data:{list:[]}})});
  try{
    f.scanner.setPriceTokens([{chain:'bsc',address:ca}]);f.scanner.start();sockets[0].emit('open');await flush();
    for(let i=0;i<3;i++){f.advance(15000);t.mock.timers.tick(15000);await flush();}
    assert.equal(sockets[0].closed,true);assert.equal(f.scanner.getStatus().lastError,'AVE_STREAM_HEARTBEAT_TIMEOUT');
    f.advance(1000);t.mock.timers.tick(1000);await flush();sockets[1].emit('open');
    const id=JSON.parse(sockets[1].sent[1]).id;
    sockets[1].emit('message',{data:JSON.stringify({jsonrpc:'2.0',id,error:{code:-1,message:'secret response'}})});
    assert.equal(f.scanner.getStatus().priceStream.lastError,'AVE_PRICE_SUBSCRIBE_REJECTED');
    assert.equal(sockets[1].closed,true);assert.ok(!JSON.stringify(f.scanner.getStatus()).includes('secret response'));
  }finally{await f.scanner.close();}
});

test('stop between queue claim and callback microtask never starts queued research',async()=>{
  let calls=0;const {scanner}=setup({onSignal:async()=>{calls++;}});
  try{
    scanner.acceptPage(page());const work=scanner.dispatchOnce();
    await Promise.resolve();await scanner.stop();await work;
    assert.equal(calls,0);assert.equal(scanner.getStatus().interrupted,1);
  }finally{await scanner.close();}
});

test('persistent inbox prevents crash replays and enforces its page budget',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'ave-scanner-')),database=join(folder,'signals.sqlite');
  let count=0;const options={database,chains:['bsc'] as const,now:()=>new Date(base),onObservation:()=>{},onSignal:async()=>{count++;}};
  let scanner=new AveScanner({...options,chains:[...options.chains]});
  try{
    scanner.acceptPage(page());await scanner.dispatchOnce();await scanner.close();
    scanner=new AveScanner({...options,chains:[...options.chains]});scanner.acceptPage(page());await scanner.dispatchOnce();
    assert.equal(count,1);assert.equal(scanner.list().total,1);
    const db=new DatabaseSync(database);try{
      assert.ok(Number(db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.prepare('PRAGMA page_size').get()!.page_size)<64*1024*1024);
    }finally{db.close();}
  }finally{await scanner.close();rmSync(folder,{recursive:true,force:true});}
});

test('HTTP polling honors retry-after and malformed errors cannot leak response secrets',async()=>{
  let calls=0;const {scanner,advance}=setup({fetcher:async()=>{calls++;return new Response('secret-value',{status:429,headers:{'retry-after':'120'}});}});
  try{await scanner.runOnce();await scanner.runOnce();assert.equal(calls,1);
    assert.equal(scanner.getStatus().lastError,'AVE_SIGNAL_HTTP_429');assert.equal(JSON.stringify(scanner.getStatus()).includes('secret-value'),false);
    advance(120_000);await scanner.runOnce();assert.equal(calls,2);
  }finally{await scanner.close();}
});
