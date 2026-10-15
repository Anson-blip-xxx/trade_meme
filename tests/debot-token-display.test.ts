import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {DebotScanner,type DebotScannerOptions} from '../src/debot-scanner.js';
import {normalizeDebotSignals,type DebotSignalObservation} from '../src/providers/debot-signals.js';
import {tokenDisplayText} from '../src/token-display.js';
import {buildDashboard} from '../src/dashboard.js';
import {ScanArchive} from '../src/scan-archive.js';
import {readConfig} from '../src/config.js';
import type {Chain,Check,Report,Signal} from '../src/types.js';

const now=new Date('2026-10-15T08:00:00.000Z');
const stamp=now.toISOString();
const evm='0x1234567890123456789012345678901234567890';
const other='0x2345678901234567890123456789012345678901';
const sol='So11111111111111111111111111111111111111112';
const channel:Record<Chain,number>={bsc:2,solana:1,robinhood:83};
const tokenFor=(chain:Chain)=>chain==='solana'?sol:evm;
function raw(chain:Chain='bsc',name:unknown='宇宙科技 🪐',symbol:unknown='SPACE') {
  const address=tokenFor(chain);
  return {code:0,data:{results:[{id:'alert-1',chain,channel_id:channel[chain],token:address,
    create_time:Math.floor(now.getTime()/1000)-1,wallet_stats:[]}],
    meta:{tokens:{[`${chain}:${address}`]:{chain,address,name,symbol}}}}};
}
function observation(id='1',chain:Chain='bsc'):DebotSignalObservation {
  return {id,observedAt:stamp,walletCount:3,addressCount:0,aliases:['vendor wallet'],
    signal:{source:'debot',sourceEventId:`debot:display:${chain}:${id}`,token:{chain,address:tokenFor(chain)},
      occurredAt:new Date(now.getTime()-1000).toISOString(),text:'private signal text',claim:'unspecified',evidenceUrls:[]}};
}
const page=(...observations:DebotSignalObservation[])=>({observations,received:observations.length,rejected:0});
const check=():Check=>({status:'pass',reasons:['TEST_PASSED'],checkedAt:stamp,facts:{}});
function report(signal:Signal):Report {
  return {id:'11111111-1111-4111-8111-111111111111',policyVersion:'test',mode:'live',signal,
    receivedAt:stamp,evaluatedAt:stamp,validUntil:new Date(now.getTime()+30_000).toISOString(),
    decision:'BUY_CANDIDATE',buyEligible:true,executionEnabled:false,reasons:['TEST_PASSED'],
    safety:check(),provenance:check(),marketRisk:check(),flow:check(),narrative:{...check(),evidence:[]}};
}
function fixture(overrides:Partial<DebotScannerOptions>={}) {
  const directory=mkdtempSync(join(tmpdir(),'debot-token-display-')),database=join(directory,'inbox.sqlite');
  const options:DebotScannerOptions={database,chains:['bsc','solana','robinhood'],maxAgeSec:120,
    mode:'authenticated_stream',now:()=>now,onSignal:async()=>{},...overrides};
  const instances:DebotScanner[]=[];
  const create=()=>{const scanner=new DebotScanner(options);instances.push(scanner);return scanner;};
  const rows=()=>{const db=new DatabaseSync(database,{readOnly:true});
    try{return db.prepare('SELECT * FROM debot_signals ORDER BY id').all();}finally{db.close();}};
  return {directory,database,options,create,rows,close:async()=>{
    for(const scanner of instances)await scanner.close();rmSync(directory,{recursive:true,force:true});}};
}

test('DeBot display names stay attached to the exact chain and complete contract identity',()=>{
  for(const chain of ['bsc','solana','robinhood'] as const) {
    const result=normalizeDebotSignals(raw(chain,`${chain} token`,'SAME'),chain,now);
    assert.equal(result.observations.length,1);
    assert.equal(result.observations[0].name,`${chain} token`);
    assert.equal(result.observations[0].symbol,'SAME');
    assert.deepEqual(result.observations[0].signal.token,{chain,address:tokenFor(chain)});
    assert.equal(result.observations[0].signal.text.includes(`${chain} token`),false,
      'display labels must not become narrative or safety evidence');
  }
});

test('wrong-chain, wrong-address and contradictory metadata cannot label a valid-looking signal',()=>{
  for(const change of [{chain:'robinhood'},{address:other}]) {
    const payload=raw();Object.assign(payload.data.meta.tokens[`bsc:${evm}`],change);
    const result=normalizeDebotSignals(payload,'bsc',now);
    assert.equal(result.observations.length,0);assert.equal(result.rejected,1);
  }
  const payload=raw();
  Object.assign(payload.data.meta.tokens,{[evm]:{chain:'robinhood',address:evm,name:'Impostor',symbol:'FAKE'}});
  assert.equal(normalizeDebotSignals(payload,'bsc',now).observations.length,0);
  const unrelated=raw();
  unrelated.data.meta.tokens={[`bsc:${other}`]:{chain:'bsc',address:other,name:'Unrelated',symbol:'OTHER'}};
  const result=normalizeDebotSignals(unrelated,'bsc',now).observations[0];
  assert.equal(result.name,undefined);assert.equal(result.symbol,undefined);
});

test('display text removes control and bidi characters, limits Unicode length and preserves HTML as literal text',()=>{
  assert.equal(tokenDisplayText(' \u0000宇\u202e宙\u2069\n ',100),'宇宙');
  assert.equal(tokenDisplayText('\u0001\u009f\u202d\u2067',100),undefined);
  assert.equal(tokenDisplayText('a'.repeat(2001),100),undefined);
  for(const value of [null,4,{},['text']])assert.equal(tokenDisplayText(value,100),undefined);
  const name='🪐'.repeat(110),symbol='币'.repeat(40);
  const result=normalizeDebotSignals(raw('bsc',name,symbol),'bsc',now).observations[0];
  assert.equal(Array.from(result.name!).length,100);assert.equal(Array.from(result.symbol!).length,32);
  const html='<img src=x onerror=alert(1)>';
  assert.equal(normalizeDebotSignals(raw('bsc',html,'<b>X</b>'),'bsc',now).observations[0].name,html);
});

test('late names fill missing labels without refreshing evidence, changing score or redispatching an event',async()=>{
  let calls=0,scanner:DebotScanner;
  const f=fixture({onSignal:async signal=>{calls++;scanner.recordReport(signal.sourceEventId,report(signal));}});
  try {
    scanner=f.create();const alert=observation();scanner.acceptPage(page(alert));await scanner.dispatchOnce();
    const before=scanner.recent().items[0],storedBefore=f.rows()[0];
    scanner.acceptPage(page({...alert,name:'First label',symbol:'ONE',observedAt:new Date(now.getTime()+1000).toISOString()}));
    await scanner.dispatchOnce();
    const after=scanner.recent().items[0],storedAfter=f.rows()[0];
    assert.equal(after.name,'First label');assert.equal(after.symbol,'ONE');assert.equal(calls,1);
    assert.deepEqual(after.score,before.score);assert.deepEqual(after.checks,before.checks);
    for(const field of ['observed_at','occurred_at','dispatched_at','completed_at','payload','dedup_key','verdict'])
      assert.equal(storedAfter[field],storedBefore[field]);
    scanner.acceptPage(page({...alert,name:'Attempted replacement',symbol:'TWO'}));
    assert.equal(scanner.recent().items[0].name,'First label');assert.equal(scanner.recent().items[0].symbol,'ONE');
    const duplicate={...alert,id:'2',name:'Different label',symbol:'DIFF',
      signal:{...alert.signal,sourceEventId:'debot:display:bsc:2'}};
    scanner.acceptPage(page(duplicate));await scanner.dispatchOnce();
    assert.equal(calls,1);assert.equal(scanner.recent().items.length,1);assert.equal(scanner.getStatus().ignored,1);
  } finally {await f.close();}
});

test('same event ID cannot acquire a name from a different chain or CA',async()=>{
  const f=fixture();
  try {
    const scanner=f.create(),alert=observation();scanner.acceptPage(page(alert));
    for(const token of [{chain:'robinhood' as const,address:evm},{chain:'bsc' as const,address:other}])
      scanner.acceptPage(page({...alert,name:'Wrong token',symbol:'WRONG',signal:{...alert.signal,token}}));
    assert.equal(scanner.recent().items[0].name,undefined);assert.equal(scanner.getStatus().stored,1);
  } finally {await f.close();}
});

test('late verified labels fill earlier alerts for the same chain and CA without changing analysis or crossing chains',async()=>{
  let calls=0,scanner:DebotScanner;
  const f=fixture({onSignal:async signal=>{calls++;scanner.recordReport(signal.sourceEventId,report(signal));}});
  try {
    scanner=f.create();
    const earlier=observation('1'),later=observation('2'),otherChain=observation('1','robinhood');
    earlier.signal.occurredAt=new Date(now.getTime()-5000).toISOString();
    scanner.acceptPage(page(earlier,later,otherChain));await scanner.dispatchOnce();
    assert.equal(calls,2);assert.equal(scanner.getStatus().dispatched,2);
    const before=new Map(scanner.recent().items.map(item=>[item.eventId,item]));
    const storedBefore=new Map(f.rows().map(row=>[row.id,row]));
    scanner.acceptPage(page({...later,name:'BABA',symbol:'BABA'}));await scanner.dispatchOnce();
    assert.equal(calls,2);assert.equal(scanner.getStatus().stored,3);
    for(const item of scanner.recent().items) {
      const old=before.get(item.eventId)!;
      if(item.chain==='bsc'){assert.equal(item.name,'BABA');assert.equal(item.symbol,'BABA');}
      else {assert.equal(item.name,undefined);assert.equal(item.symbol,undefined);}
      assert.deepEqual(item.score,old.score);assert.deepEqual(item.checks,old.checks);
      assert.equal(item.decision,old.decision);assert.equal(item.buyEligible,old.buyEligible);
    }
    for(const row of f.rows())for(const field of ['state','payload','observed_at','occurred_at','dispatched_at','completed_at','dedup_key','verdict'])
      assert.equal(row[field],storedBefore.get(row.id)![field]);
  } finally {await f.close();}
});

test('GMGN display fallback requires snapshot, info and signal identities to agree',async t=>{
  const variants=[
    {label:'valid',token:{chain:'bsc' as const,address:evm},info:{chain:'bsc',address:evm,name:'Matched',symbol:'MATCH'},expected:'Matched'},
    {label:'snapshot chain',token:{chain:'robinhood' as const,address:evm},info:{address:evm,name:'Wrong'}},
    {label:'snapshot CA',token:{chain:'bsc' as const,address:other},info:{address:evm,name:'Wrong'}},
    {label:'info chain',token:{chain:'bsc' as const,address:evm},info:{chain:'robinhood',address:evm,name:'Wrong'}},
    {label:'info CA',token:{chain:'bsc' as const,address:evm},info:{address:other,name:'Wrong'}},
    {label:'unbound info',token:{chain:'bsc' as const,address:evm},info:{name:'Wrong'}},
  ];
  for(const variant of variants)await t.test(variant.label,async()=>{
    let scanner:DebotScanner;
    const f=fixture({onSignal:async signal=>{
      const result=report(signal);result.gmgn={token:variant.token,fetchedAt:stamp,diagnostics:[],info:variant.info};
      scanner.recordReport(signal.sourceEventId,result);
    }});
    try {scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();
      assert.equal(scanner.recent().items[0].name,variant.expected);
    } finally {await f.close();}
  });
});

test('GMGN can fill a missing symbol but cannot replace an already known DeBot name',async()=>{
  let scanner:DebotScanner;
  const f=fixture({onSignal:async signal=>{
    const result=report(signal);result.gmgn={token:signal.token,fetchedAt:stamp,diagnostics:[],
      info:{address:signal.token.address,name:'Different GMGN name',symbol:'SYMBOL'}};
    scanner.recordReport(signal.sourceEventId,result);
  }});
  try {scanner=f.create();scanner.acceptPage(page({...observation(),name:'DeBot name'}));await scanner.dispatchOnce();
    const item=scanner.recent().items[0];assert.equal(item.name,'DeBot name');assert.equal(item.symbol,'SYMBOL');
  } finally {await f.close();}
});

test('legacy inbox receives bound archive labels after restart without replaying completed signals',async()=>{
  let calls=0,lookups=0;
  const f=fixture({onSignal:async()=>{calls++;},lookupDisplay:()=>{lookups++;return {chain:'bsc',address:evm,name:'Archived',symbol:'OLD'};}});
  try {
    const db=new DatabaseSync(f.database),alert=observation();
    db.exec(`CREATE TABLE debot_signals(id TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,
      occurred_at TEXT NOT NULL,observed_at TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,
      reason TEXT,dispatched_at TEXT,completed_at TEXT,report_id TEXT)`);
    db.prepare('INSERT INTO debot_signals VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(alert.signal.sourceEventId,
      'bsc',evm,alert.signal.occurredAt,stamp,'completed',JSON.stringify(alert),null,stamp,stamp,report(alert.signal).id);
    db.close();
    let scanner=f.create();assert.equal(scanner.recent().items[0].name,'Archived');assert.equal(lookups,1);
    await scanner.dispatchOnce();assert.equal(calls,0);await scanner.close();
    scanner=f.create();assert.equal(scanner.recent().items[0].symbol,'OLD');assert.equal(lookups,1);
    await scanner.dispatchOnce();assert.equal(calls,0);
  } finally {await f.close();}
});

test('archive display migration rejects mismatched identities and tolerates unavailable history',async()=>{
  let scanner:DebotScanner;
  const f=fixture({onSignal:async signal=>{scanner.bindReport(signal.sourceEventId,report(signal).id);}});
  try {
    scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();await scanner.close();
    for(const lookupDisplay of [()=>({chain:'robinhood' as const,address:evm,name:'Wrong chain'}),
      ()=>({chain:'bsc' as const,address:other,name:'Wrong CA'}),()=>{throw new Error('unavailable history');}]) {
      f.options.lookupDisplay=lookupDisplay;scanner=f.create();
      assert.equal(scanner.recent().items[0].name,undefined);assert.equal(scanner.getStatus().dispatched,1);
      await scanner.close();
    }
  } finally {await f.close();}
});

test('authenticated risk endpoint exposes labels and score without raw signal, metadata or wallet payloads',async()=>{
  const secret='PRIVATE_METADATA_SENTINEL';
  const payload=raw('bsc','Public name','PUBLIC');
  Object.assign(payload.data.meta,{cookie:secret});
  Object.assign(payload.data.results[0],{private_note:secret});
  const alert=normalizeDebotSignals(payload,'bsc',now).observations[0];alert.aliases=[secret];alert.signal.text=secret;
  const f=fixture(),archive=new ScanArchive(':memory:'),password='test-metadata-dashboard-token-independent-12345';
  const config=readConfig({DASHBOARD_ACCESS_TOKEN:password,INGEST_TOKEN:'test-different-ingest-token-1234567890'});
  const scanner=f.create();scanner.acceptPage(page(alert));
  const server=buildDashboard(config,{archive,overview:()=>({entryMode:'off'}),orders:()=>({items:[]}),debotSignals:()=>scanner.recent()});
  try {
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/dashboard/api/debot/signals`;
    assert.equal((await fetch(url)).status,401);
    const response=await fetch(url,{headers:{'x-dashboard-access':password}});assert.equal(response.status,200);
    const result=await response.json() as {items:Record<string,unknown>[]};
    assert.equal(result.items[0].name,'Public name');assert.equal(result.items[0].symbol,'PUBLIC');
    assert.ok(result.items[0].score);assert.equal(JSON.stringify(result).includes(secret),false);
    for(const field of ['payload','vendorWallets','aliases','details','private_note','cookie'])
      assert.equal(Object.hasOwn(result.items[0],field),false);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));archive.close();await f.close();}
});
