import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DebotScanner,type DebotScannerOptions} from '../src/debot-scanner.js';
import {DebotSignalError,normalizeDebotSignals,type DebotSignalObservation,type NormalizedDebotSignals,type DebotWalletDetails} from '../src/providers/debot-signals.js';
import type {Signal} from '../src/types.js';

const epoch=Date.parse('2026-10-15T06:00:00Z');
const iso=(seconds:number)=>new Date(epoch+seconds*1000).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
function observation(id:number,occurred=990,observed=1000):DebotSignalObservation {
  return {id:String(id),observedAt:iso(observed),walletCount:3,addressCount:0,aliases:['platform-alias'],alertPriceUsd:0.001,
    signal:{source:'debot',sourceEventId:`debot:signal:${id}`,token:{chain:'bsc',address:address(id)},occurredAt:iso(occurred),
      text:`DeBot signal ${id}`,claim:'unspecified',evidenceUrls:[]}};
}
const page=(...observations:DebotSignalObservation[]):NormalizedDebotSignals=>({observations,received:observations.length,rejected:0});
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(r=>{resolve=r;});
  return {promise,resolve};
}
function fixture(overrides:Partial<DebotScannerOptions>={}) {
  const root=mkdtempSync(join(tmpdir(),'debot-scanner-')),database=join(root,'inbox.sqlite');
  let seconds=1000;
  const signals:Signal[]=[];
  const options:DebotScannerOptions={database,chains:['bsc'],maxAgeSec:600,now:()=>new Date(iso(seconds)),
    fetchPage:async()=>page(),onSignal:async signal=>{signals.push(signal);},...overrides};
  const scanners:DebotScanner[]=[];
  const create=()=>{const scanner=new DebotScanner(options);scanners.push(scanner);return scanner;};
  const rows=()=>{
    const db=new DatabaseSync(database,{readOnly:true});
    try {return db.prepare('SELECT * FROM debot_signals ORDER BY id').all();}finally{db.close();}
  };
  return {root,database,options,signals,create,rows,advance:(n:number)=>{seconds=n;},
    close:async()=>{for(const scanner of scanners)await scanner.close();rmSync(root,{recursive:true,force:true});}};
}

test('DeBot inbox survives restart and freezes the first observed payload while repeated card updates deduplicate',async()=>{
  let current=observation(1);
  const f=fixture({fetchPage:async()=>page(current)});
  try {
    const first=f.create();await first.runOnce();
    const before=f.rows()[0];assert.equal(before.observed_at,iso(1000));
    assert.equal(statSync(f.database).mode&0o777,0o600);
    await first.close();f.advance(1020);
    current={...current,observedAt:iso(1020),alertPriceUsd:999,aliases:['changed-alias'],
      signal:{...current.signal,text:'updated card text'}};
    const restarted=f.create();await restarted.runOnce();
    assert.equal(restarted.getStatus().stored,1);assert.equal(restarted.getStatus().lastCycle?.added,0);
    assert.deepEqual(f.rows()[0],before);
    await restarted.dispatchOnce();assert.equal(f.signals.length,1);
    assert.equal(f.signals[0].text,'DeBot signal 1');
    await restarted.close();
    const again=f.create();await again.runOnce();await again.dispatchOnce();
    assert.equal(f.signals.length,1);assert.equal(again.getStatus().dispatched,1);
  }finally{await f.close();}
});

test('old DeBot alerts remain ignored observations and are never refreshed into a new candidate',async()=>{
  const f=fixture({fetchPage:async()=>page(observation(1,399),observation(2,400))});
  try {
    const scanner=f.create();await scanner.runOnce();
    assert.equal(scanner.getStatus().ignored,1);assert.equal(scanner.getStatus().pending,1);
    await scanner.dispatchOnce();assert.deepEqual(f.signals.map(s=>s.sourceEventId),['debot:signal:2']);
    const ignored=f.rows().find(row=>row.id==='debot:signal:1');
    assert.equal(ignored?.reason,'DEBOT_SIGNAL_STALE');assert.equal(ignored?.occurred_at,iso(399));
  }finally{await f.close();}
});

test('a partially rejected page retains its valid alerts while reporting the rejected records',async()=>{
  const f=fixture({fetchPage:async()=>({...page(observation(1)),received:2,rejected:1,reason:'DEBOT_SIGNAL_RECORDS_REJECTED'})});
  try {
    const scanner=f.create();await scanner.runOnce();
    assert.equal(scanner.getStatus().stored,1);assert.equal(scanner.getStatus().lastCycle?.received,2);
    assert.ok(scanner.getStatus().lastCycle?.reasons.includes('DEBOT_SIGNAL_RECORDS_REJECTED'));
    await scanner.dispatchOnce();assert.equal(f.signals.length,1);
  }finally{await f.close();}
});

test('an alert that expires in the queue cannot be dispatched after the GMGN workload clears',async()=>{
  let busy=true;
  const f=fixture({fetchPage:async()=>page(observation(1,990)),shouldDefer:()=>busy?'SCANNER_BUSY':undefined});
  try {
    const scanner=f.create();await scanner.runOnce();await scanner.dispatchOnce();
    assert.equal(scanner.getStatus().pending,1);assert.equal(scanner.getStatus().deferredReason,'SCANNER_BUSY');
    f.advance(1591);busy=false;await scanner.dispatchOnce();
    assert.equal(f.signals.length,0);assert.equal(scanner.getStatus().pending,0);
    assert.equal(scanner.getStatus().ignored,1);assert.equal(f.rows()[0].reason,'DEBOT_SIGNAL_STALE');
  }finally{await f.close();}
});

test('GMGN busy, cooldown and research pressure defer analysis without blocking DeBot collection or consuming the queue',async()=>{
  let reason:string|undefined='SCANNER_BUSY',requested=0;
  const f=fixture({fetchPage:async()=>{requested++;return page(observation(1));},shouldDefer:()=>reason});
  try {
    const scanner=f.create();
    for(const deferredReason of ['SCANNER_BUSY','GMGN_RATE_LIMITED','RESEARCH_BUSY']) {
      reason=deferredReason;await scanner.runOnce();await scanner.dispatchOnce();
      assert.equal(scanner.getStatus().deferredReason,deferredReason);assert.equal(scanner.getStatus().pending,1);
      assert.equal(f.signals.length,0);assert.equal(f.rows()[0].state,'pending');
    }
    assert.equal(requested,3);
    reason=undefined;await scanner.dispatchOnce();
    assert.equal(f.signals.length,1);assert.equal(scanner.getStatus().deferredReason,undefined);
  }finally{await f.close();}
});

test('DeBot dispatches no more than one alert per minute and preserves that limit across restarts',async()=>{
  const f=fixture({fetchPage:async()=>page(observation(1,999),observation(2,998),observation(3,997))});
  try {
    let scanner=f.create();await scanner.runOnce();await scanner.dispatchOnce();await scanner.dispatchOnce();
    assert.equal(f.signals.length,1);assert.equal(f.signals[0].sourceEventId,'debot:signal:1');
    await scanner.close();f.advance(1059);scanner=f.create();await scanner.dispatchOnce();
    assert.equal(f.signals.length,1);assert.equal(scanner.getStatus().pending,2);
    f.advance(1060);await scanner.dispatchOnce();await scanner.dispatchOnce();assert.equal(f.signals.length,2);
    f.advance(1119);await scanner.dispatchOnce();assert.equal(f.signals.length,2);
    f.advance(1120);await scanner.dispatchOnce();assert.equal(f.signals.length,3);
  }finally{await f.close();}
});

test('DeBot HTTP 429 backs off all chains until the supplied retry deadline instead of retrying each run',async()=>{
  let calls=0;
  const f=fixture({chains:['bsc','robinhood'],fetchPage:async()=>{
    calls++;if(calls===1)throw new DebotSignalError('DEBOT_SIGNAL_HTTP_429',epoch+1120*1000);return page();
  }});
  try {
    const scanner=f.create();await scanner.runOnce();assert.equal(calls,1);
    assert.equal(scanner.getStatus().cooldownUntil,iso(1120));
    assert.equal(scanner.getStatus().lastCycle?.diagnostics[0].status,'rate_limited');
    for(const seconds of [1000,1060,1119]){f.advance(seconds);await scanner.runOnce();}
    assert.equal(calls,1);
    f.advance(1120);await scanner.runOnce();assert.equal(calls,3);
  }finally{await f.close();}
});

test('DeBot HTTP 401 and 403 expose authentication failure with a five-minute backoff',async t=>{
  for(const code of [401,403])await t.test(String(code),async()=>{
    let calls=0;
    const f=fixture({fetchPage:async()=>{calls++;throw new DebotSignalError(`DEBOT_SIGNAL_HTTP_${code}`);}});
    try {
      const scanner=f.create();await scanner.runOnce();await scanner.runOnce();
      assert.equal(calls,1);assert.equal(scanner.getStatus().cooldownUntil,iso(1300));
      assert.equal(scanner.getStatus().lastCycle?.diagnostics[0].status,'auth_required');
      f.advance(1299);await scanner.runOnce();assert.equal(calls,1);
      f.advance(1300);await scanner.runOnce();assert.equal(calls,2);
    }finally{await f.close();}
  });
});

test('slow analysis cannot block independent collection and concurrent dispatch calls share one analysis',async()=>{
  const analysis=deferred<void>(),entered=deferred<void>();let requests=0,attempts=0;
  const f=fixture({fetchPage:async()=>page(observation(++requests)),onSignal:async()=>{
    attempts++;entered.resolve();await analysis.promise;
  }});
  try {
    const scanner=f.create();await scanner.runOnce();
    const first=scanner.dispatchOnce();await entered.promise;
    const second=scanner.dispatchOnce();assert.equal(first,second);
    await scanner.runOnce();assert.equal(requests,2);assert.equal(scanner.getStatus().stored,2);
    assert.equal(scanner.getStatus().pending,2);assert.equal(attempts,1);
    analysis.resolve();await first;assert.equal(scanner.getStatus().dispatched,1);
  }finally{analysis.resolve();await f.close();}
});

test('concurrent DeBot collection calls share one network operation',async()=>{
  const response=deferred<NormalizedDebotSignals>(),entered=deferred<void>();let calls=0;
  const f=fixture({fetchPage:async()=>{calls++;entered.resolve();return response.promise;}});
  try {
    const scanner=f.create(),first=scanner.runOnce();await entered.promise;
    const second=scanner.runOnce();assert.equal(first,second);assert.equal(calls,1);
    response.resolve(page(observation(1)));await first;assert.equal(scanner.getStatus().stored,1);
  }finally{response.resolve(page());await f.close();}
});

test('stopping collection discards the response already in flight and prevents later collection or dispatch',async()=>{
  const response=deferred<NormalizedDebotSignals>(),entered=deferred<void>();let calls=0;
  const f=fixture({fetchPage:async()=>{calls++;entered.resolve();return response.promise;}});
  try {
    const scanner=f.create(),collecting=scanner.runOnce();await entered.promise;
    const stopping=scanner.stop();response.resolve(page(observation(1)));await Promise.all([stopping,collecting]);
    assert.equal(scanner.getStatus().stored,0);assert.equal(scanner.getStatus().inFlight,false);
    await scanner.runOnce();await scanner.dispatchOnce();assert.equal(calls,1);assert.equal(f.signals.length,0);
  }finally{response.resolve(page());await f.close();}
});

test('restart marks a previously claimed alert interrupted and never silently replays it',async()=>{
  const f=fixture({fetchPage:async()=>page(observation(1))});
  try {
    const first=f.create();await first.runOnce();await first.close();
    const db=new DatabaseSync(f.database);
    try {db.prepare("UPDATE debot_signals SET state='dispatching',dispatched_at=? WHERE id=?").run(iso(1000),'debot:signal:1');}
    finally{db.close();}
    f.advance(1061);const restarted=f.create();await restarted.runOnce();await restarted.dispatchOnce();
    assert.equal(f.signals.length,0);assert.equal(restarted.getStatus().interrupted,1);
    assert.equal(restarted.getStatus().pending,0);assert.equal(f.rows()[0].reason,'DEBOT_SIGNAL_INTERRUPTED');
  }finally{await f.close();}
});

test('a failed analysis is recorded once and cannot loop on the same alert',async()=>{
  let attempts=0;
  const f=fixture({fetchPage:async()=>page(observation(1)),onSignal:async()=>{attempts++;throw new Error('test failure');}});
  try {
    const scanner=f.create();await scanner.runOnce();await scanner.dispatchOnce();
    f.advance(1061);await scanner.runOnce();await scanner.dispatchOnce();
    assert.equal(attempts,1);assert.equal(scanner.getStatus().failed,1);
    assert.equal(f.rows()[0].reason,'DEBOT_SIGNAL_DISPATCH_FAILED');
  }finally{await f.close();}
});

test('the inbox stores normalized evidence only, without raw response, metadata secrets or invented wallet addresses',async()=>{
  const secret='SECRET_RAW_RESPONSE_SENTINEL';
  const raw={code:0,debug:{authorization:secret},data:{results:[{id:'alert-1',chain:'bsc',channel_id:2,token:address(1),
    create_time:(epoch+990*1000)/1000,wallet_stats:[{token:address(1),alias:'Smart 1',wallet:'not-an-address',private_note:secret}],
    avg_wallet_volume:'215.5',token_trading_stat:{price:'0.01'},cookie:secret}],meta:{private_data:secret}}};
  const normalized=normalizeDebotSignals(raw,'bsc',new Date(iso(1000)));
  assert.equal(normalized.observations.length,1);
  const f=fixture({fetchPage:async()=>normalized});
  try {
    const scanner=f.create();await scanner.runOnce();const rows=f.rows();assert.equal(rows.length,1);
    assert.ok(!JSON.stringify(rows).includes(secret));assert.ok(!JSON.stringify(rows).includes('rawResponse'));
    const payload=JSON.parse(String(rows[0].payload));assert.equal(payload.walletCount,1);assert.equal(payload.addressCount,0);
    assert.deepEqual(payload.aliases,['Smart 1']);assert.equal(payload.signal.vendorNarrative,undefined);
    assert.equal(payload.signal.creationTx,undefined);assert.ok(!payload.signal.text.includes('not-an-address'));
  }finally{await f.close();}
});

test('authenticated stream has a 120-second freshness ceiling and allows only explicitly injected catch-up reads',async()=>{
  let calls=0;
  const f=fixture({mode:'authenticated_stream',maxAgeSec:600,fetchPage:async()=>{
    calls++;return page(observation(1,879),observation(2,880));
  }});
  try {
    const scanner=f.create();await scanner.runOnce();assert.equal(calls,1);
    assert.equal(scanner.getStatus().ignored,1);assert.equal(scanner.getStatus().pending,1);
    await scanner.dispatchOnce();assert.deepEqual(f.signals.map(s=>s.sourceEventId),['debot:signal:2']);
  }finally{await f.close();}
  const noFallback=fixture({mode:'authenticated_stream',fetchPage:undefined});
  try {
    const scanner=noFallback.create();await scanner.runOnce();
    assert.equal(scanner.getStatus().lastCycle,undefined);assert.equal(scanner.getStatus().stored,0);
  }finally{await noFallback.close();}
});

test('stream arrivals begin immediately and queued arrivals drain serially when the active analysis finishes',async()=>{
  const started=deferred<void>(),release=deferred<void>();let active=0,maxActive=0;
  const received:string[]=[];
  const f=fixture({mode:'authenticated_stream',fetchPage:undefined,onSignal:async signal=>{
    active++;maxActive=Math.max(maxActive,active);received.push(signal.sourceEventId);
    if(received.length===1){started.resolve();await release.promise;}
    active--;
  }});
  try {
    const scanner=f.create();scanner.start();scanner.acceptPage(page(observation(1)));await started.promise;
    scanner.acceptPage(page(observation(2),observation(3)));
    const dispatch=scanner.dispatchOnce();assert.equal(received.length,1);
    release.resolve();await dispatch;
    assert.equal(received.length,3);assert.equal(maxActive,1);assert.equal(scanner.getStatus().pending,0);
    assert.equal(scanner.getStatus().dispatched,3);
  }finally{release.resolve();await f.close();}
});

test('stream dispatcher yields after twenty events and rechecks workload pressure between analyses',async()=>{
  let attempts=0,blocked=false;
  const f=fixture({mode:'authenticated_stream',shouldDefer:()=>blocked?'RESEARCH_BUSY':undefined,
    onSignal:async()=>{attempts++;if(attempts===1)blocked=true;}});
  try {
    const scanner=f.create();scanner.acceptPage(page(...Array.from({length:25},(_,i)=>observation(i+1))));
    await scanner.dispatchOnce();assert.equal(attempts,1);assert.equal(scanner.getStatus().pending,24);
    blocked=false;await scanner.dispatchOnce();assert.equal(attempts,21);assert.equal(scanner.getStatus().pending,4);
    await scanner.dispatchOnce();assert.equal(attempts,25);
  }finally{await f.close();}
});

test('detail retrieval that crosses the freshness deadline cannot dispatch the stale signal',async()=>{
  const entered=deferred<void>(),response=deferred<DebotWalletDetails>();let detailsCalls=0;
  const f=fixture({mode:'authenticated_stream',maxAgeSec:600,fetchDetails:async()=>{
    detailsCalls++;entered.resolve();return response.promise;
  }});
  try {
    const scanner=f.create();scanner.acceptPage(page(observation(1,990)));
    const dispatch=scanner.dispatchOnce();await entered.promise;f.advance(1111);
    response.resolve({fetchedAt:iso(1111),received:1,rejected:0,vendorWallets:[{
      alias:'a',address:address(2),source:'debot',verification:'vendor_report'}]});
    await dispatch;assert.equal(detailsCalls,1);assert.equal(f.signals.length,0);
    assert.equal(scanner.getStatus().ignored,1);assert.equal(f.rows()[0].reason,'DEBOT_SIGNAL_STALE');
  }finally{response.resolve({fetchedAt:iso(1000),received:0,rejected:0,vendorWallets:[]});await f.close();}
});

test('vendor research targets require fresh matching details and actual valid vendor-reported addresses',async()=>{
  const valid={source:'debot' as const,verification:'vendor_report' as const};
  const f=fixture({mode:'authenticated_stream',fetchDetails:async()=>({fetchedAt:iso(1000),received:8,rejected:0,
    vendorWallets:[{...valid,alias:address(9)},{...valid,address:'SW-alias'},{...valid,address:address(0)},
      {...valid,address:address(2)},{...valid,address:address(2)},{...valid,address:address(3)},
      {...valid,address:address(4)},{...valid,address:address(5)}]})});
  try {
    const scanner=f.create(),alert=observation(1);scanner.acceptPage(page(alert));await scanner.dispatchOnce();
    assert.deepEqual(scanner.vendorWalletTargets(alert.signal),{provider:'debot',token:alert.signal.token,
      checkedAt:iso(1000),addresses:[address(2),address(3),address(4)]});
    assert.equal(scanner.vendorWalletTargets({...alert.signal,token:{chain:'robinhood',address:address(1)}}),undefined);
    assert.equal(scanner.vendorWalletTargets({...alert.signal,token:{chain:'bsc',address:address(2)}}),undefined);
    f.advance(999);assert.equal(scanner.vendorWalletTargets(alert.signal),undefined);
    f.advance(1120);assert.ok(scanner.vendorWalletTargets(alert.signal));
    f.advance(1121);assert.equal(scanner.vendorWalletTargets(alert.signal),undefined);
    const db=new DatabaseSync(f.database);f.advance(1000);
    try {
      for(const details of ['not-json',JSON.stringify({fetchedAt:iso(1000),vendorWallets:[{address:address(9)}]}),
        JSON.stringify({fetchedAt:iso(1000),reason:'DEBOT_SIGNAL_RESPONSE_INVALID',vendorWallets:[{...valid,address:address(9)}]})]) {
        db.prepare('UPDATE debot_signals SET details=?').run(details);
        assert.equal(scanner.vendorWalletTargets(alert.signal),undefined);
      }
    }finally{db.close();}
    await scanner.close();assert.equal(scanner.vendorWalletTargets(alert.signal),undefined);
  }finally{await f.close();}
});

test('stop waits for detail retrieval and callbacks, prevents further queued callbacks, and keeps restart deduplication',async()=>{
  const entered=deferred<void>(),release=deferred<void>();let attempts=0;
  const f=fixture({mode:'authenticated_stream',onSignal:async()=>{attempts++;entered.resolve();await release.promise;}});
  try {
    const scanner=f.create();scanner.acceptPage(page(observation(1),observation(2)));
    const dispatch=scanner.dispatchOnce();await entered.promise;let stopped=false;
    const stop=scanner.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);
    release.resolve();await Promise.all([dispatch,stop]);assert.equal(attempts,1);
    assert.equal(scanner.getStatus().dispatched,1);assert.equal(scanner.getStatus().pending,1);
    await scanner.close();const restarted=f.create();restarted.acceptPage(page(observation(1),observation(2)));
    await restarted.dispatchOnce();assert.equal(attempts,2);assert.equal(restarted.getStatus().dispatched,2);
  }finally{release.resolve();await f.close();}
  const detailEntered=deferred<void>(),detailRelease=deferred<DebotWalletDetails>();
  const details=fixture({mode:'authenticated_stream',fetchDetails:async()=>{detailEntered.resolve();return detailRelease.promise;}});
  try {
    const scanner=details.create();scanner.acceptPage(page(observation(1)));const dispatch=scanner.dispatchOnce();
    await detailEntered.promise;let stopped=false;const stop=scanner.stop().then(()=>{stopped=true;});
    await Promise.resolve();assert.equal(stopped,false);
    detailRelease.resolve({fetchedAt:iso(1000),received:0,rejected:0,vendorWallets:[]});
    await Promise.all([dispatch,stop]);assert.equal(details.signals.length,0);assert.equal(scanner.getStatus().interrupted,1);
  }finally{detailRelease.resolve({fetchedAt:iso(1000),received:0,rejected:0,vendorWallets:[]});await details.close();}
});

test('a synchronous callback throw is captured once without blocking the next stream alert',async()=>{
  let attempts=0;
  const f=fixture({mode:'authenticated_stream',onSignal:()=>{attempts++;throw Error('secret callback exception');}});
  try {
    const scanner=f.create();scanner.acceptPage(page(observation(1),observation(2)));await scanner.dispatchOnce();
    assert.equal(attempts,2);assert.equal(scanner.getStatus().failed,2);await scanner.dispatchOnce();assert.equal(attempts,2);
    assert.equal(JSON.stringify(f.rows()).includes('secret callback exception'),false);
  }finally{await f.close();}
});

test('full push inbox exposes a fixed capacity reason, preserves recent deduplication and still drains stored work',async()=>{
  const f=fixture({mode:'authenticated_stream'});
  try {
    const scanner=f.create();scanner.acceptPage(page(observation(1)));
    const db=new DatabaseSync(f.database);
    try {
      db.exec('BEGIN');const insert=db.prepare("INSERT INTO debot_signals(id,chain,address,occurred_at,observed_at,state,payload) VALUES(?,'bsc',?,?,?,'ignored','{}')");
      for(let i=2;i<=10000;i++)insert.run(`seed:${i}`,address(i),iso(990),iso(1000));
      db.exec('COMMIT');
    }finally{db.close();}
    assert.throws(()=>scanner.acceptPage(page(observation(10001))),/DEBOT_SIGNAL_STORE_FULL/);
    assert.equal(scanner.getStatus().lastError,'DEBOT_SIGNAL_STORE_FULL');assert.equal(scanner.getStatus().stored,10000);
    assert.doesNotThrow(()=>scanner.acceptPage(page(observation(1))));
    await scanner.dispatchOnce();assert.equal(f.signals.length,1);assert.equal(scanner.getStatus().dispatched,1);
  }finally{await f.close();}
});
