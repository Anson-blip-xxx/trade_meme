import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DebotScanner,type DebotScannerOptions} from '../src/debot-scanner.js';
import {DebotNotificationLedger} from '../src/debot-notification-ledger.js';
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

test('DeBot pages are filtered in SQL with stable time anchors, bounded arguments and no inbox payloads',async()=>{
  const f=fixture({chains:['bsc','robinhood'],mode:'authenticated_stream'});
  try {
    const scanner=f.create();
    const items=Array.from({length:6},(_,i)=>observation(i+1));
    items[1].signal.token.chain='robinhood';scanner.acceptPage(page(...items,observation(20,1)));
    const first=scanner.list({limit:2});assert.equal(first.total,6);assert.equal(first.hasMore,true);
    assert.deepEqual(first.items.map(r=>r.eventId),['debot:signal:6','debot:signal:5']);
    f.advance(1001);const sameToken=observation(7,1000,1001);sameToken.signal.token.address=address(6);scanner.acceptPage(page(sameToken));
    assert.equal(scanner.list({limit:1}).items[0].eventId,'debot:signal:7');
    const next=scanner.list({limit:2,offset:2,asOf:first.asOf});assert.equal(next.total,6);
    assert.deepEqual(next.items.map(r=>r.eventId),['debot:signal:4','debot:signal:3']);
    assert.equal(scanner.list({limit:2,offset:20,asOf:first.asOf}).items.length,0);
    assert.equal(scanner.list({chain:'robinhood',state:'pending'}).total,1);
    assert.equal(scanner.list({state:'failed'}).total,0);
    const serialized=JSON.stringify(first);for(const secret of ['payload','details','platform-alias'])assert.equal(serialized.includes(secret),false);
    for(const options of [{limit:0},{limit:101},{offset:-1},{offset:1000001},{chain:'eth'},{state:'active'},{asOf:'bad'}])
      assert.throws(()=>scanner.list(options as any),/INVALID_FILTER/);
    const hidden=scanner as unknown as {eventList:()=>never};hidden.eventList=()=>{throw new Error('EVENT_LIST_MUST_NOT_RUN');};
    assert.doesNotThrow(()=>scanner.list({limit:1}));
    const db=new DatabaseSync(f.database,{readOnly:true});
    try {
      const legacy=db.prepare(`WITH visible AS (SELECT rowid seq,* FROM debot_signals WHERE observed_at<=? AND (reason IS NULL OR reason!='DEBOT_SIGNAL_STALE')),
        ranked AS (SELECT id,chain,address,MAX(observed_at) OVER (PARTITION BY chain,address) latest,MAX(seq) OVER (PARTITION BY chain,address) latest_seq,
          ROW_NUMBER() OVER (PARTITION BY chain,address ORDER BY CASE WHEN state='dispatching' THEN 0 WHEN analyzed=1 OR verdict IS NOT NULL THEN 1 WHEN state='pending' THEN 2 ELSE 3 END,
            observed_at DESC,seq DESC) position FROM visible)
        SELECT id,chain,address,latest,latest_seq FROM ranked WHERE position=1 ORDER BY latest DESC,latest_seq DESC,chain,address`).all(iso(1001));
      const materialized=db.prepare(`SELECT s.id,t.chain,t.address,t.latest_observed_at latest,t.latest_seq FROM debot_signal_tokens t
        JOIN debot_signals s ON s.id=t.display_id WHERE t.latest_observed_at<=? ORDER BY latest DESC,t.latest_seq DESC,t.chain,t.address`).all(iso(1001));
      assert.deepEqual(materialized,legacy);
      const probePlan=db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM debot_signals INDEXED BY debot_signals_pending_chain
        WHERE state='pending' AND chain IN (?,?) LIMIT 1`).all('bsc','robinhood').map(row=>String(row.detail));
      assert.ok(probePlan.some(detail=>detail.includes('debot_signals_pending_chain')));
      const listPlan=db.prepare(`EXPLAIN QUERY PLAN SELECT s.id FROM debot_signal_tokens t JOIN debot_signals s ON s.id=t.display_id
        WHERE t.latest_observed_at<=? ORDER BY t.latest_observed_at DESC,t.latest_seq DESC,t.chain,t.address LIMIT 20`).all(iso(1001)).map(row=>String(row.detail));
      assert.ok(listPlan.some(detail=>detail.includes('debot_signal_tokens_latest')));
      const anchorPlan=db.prepare(`EXPLAIN QUERY PLAN WITH affected AS MATERIALIZED
        (SELECT chain,address FROM debot_signal_tokens WHERE latest_observed_at>?)
        SELECT s.id FROM affected a JOIN debot_signals AS s INDEXED BY debot_signals_token_observed
          ON s.chain=a.chain AND s.address=a.address WHERE s.observed_at<=?`).all(first.asOf,first.asOf).map(row=>String(row.detail));
      assert.ok(anchorPlan.some(detail=>detail.includes('debot_signals_token_observed')));
    }finally{db.close();}
  }finally{await f.close();}
});

test('DeBot status caches database facts for five seconds and uses the latest-dispatch index',async()=>{
  const f=fixture({mode:'authenticated_stream'});
  try {
    const scanner=f.create();scanner.acceptPage(page(observation(1)));
    const first=scanner.getStatus();assert.equal(first.stored,1);assert.equal(first.pending,1);
    const db=new DatabaseSync(f.database);
    try {
      db.prepare(`UPDATE debot_signals SET state='completed',analyzed=1,details='{}',
        details_error='DEBOT_DETAILS_UNAVAILABLE',dispatched_at=?,completed_at=? WHERE id=?`)
        .run(iso(1002),iso(1002),'debot:signal:1');
      db.prepare(`INSERT INTO debot_signals(id,chain,address,occurred_at,observed_at,state,payload)
        VALUES('external:2','bsc',?,?,?,'ignored','{}')`).run(address(2),iso(1001),iso(1003));
      const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT observed_at,dispatched_at FROM debot_signals
        WHERE dispatched_at IS NOT NULL ORDER BY dispatched_at DESC LIMIT 1`).all().map(row=>String(row.detail));
      assert.ok(plan.some(detail=>detail.includes('debot_signals_dispatched_latest')),plan.join('\n'));
    }finally{db.close();}
    f.advance(1004);
    const cached=scanner.getStatus();assert.equal(cached.stored,1);assert.equal(cached.pending,1);assert.equal(cached.dispatched,0);
    f.advance(1005);
    const fresh=scanner.getStatus();assert.equal(fresh.stored,2);assert.equal(fresh.pending,0);assert.equal(fresh.dispatched,1);
    assert.equal(fresh.ignored,1);assert.equal(fresh.detailsReceived,1);assert.equal(fresh.detailsFailed,1);
    assert.equal(fresh.lastObservedAt,iso(1003));assert.equal(fresh.lastAnalysisQueueDelayMs,2000);
  }finally{await f.close();}
});

test('DeBot status reports runtime state immediately while database facts remain cached',async()=>{
  const response=deferred<NormalizedDebotSignals>();
  const f=fixture({fetchPage:async()=>response.promise});
  try {
    const scanner=f.create();const initial=scanner.getStatus();assert.equal(initial.running,false);assert.equal(initial.inFlight,false);
    const work=scanner.runOnce();assert.equal(scanner.getStatus().inFlight,true);
    response.resolve(page());await work;assert.equal(scanner.getStatus().inFlight,false);
    scanner.start();assert.equal(scanner.getStatus().running,true);
    await scanner.stop();assert.equal(scanner.getStatus().running,false);
  }finally{response.resolve(page());await f.close();}
});

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

test('pausing a chain preserves its inbox but prevents replay observations, details and pending research after restart',async()=>{
  let observed=0,details=0;
  const f=fixture({onObservation:()=>{observed++;},fetchDetails:async()=>{details++;throw Error('unexpected details');}});
  try {
    const first=f.create();first.acceptPage(page(observation(1)));await first.close();
    assert.equal(observed,1);f.options.chains=['solana'];const resumed=f.create();
    resumed.acceptPage(page(observation(1),observation(2)));await resumed.dispatchOnce();
    assert.equal(f.rows().length,1);assert.equal(observed,1);assert.equal(details,0);assert.equal(f.signals.length,0);
    assert.equal(resumed.list({chain:'bsc'}).total,1);
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

test('DeBot storage defaults to 64 MiB and rejects invalid byte budgets',async()=>{
  const f=fixture();
  try {
    const scanner=f.create();assert.equal(scanner.getStatus().maxBytes,64*1024*1024);
    assert.ok(scanner.getStatus().dbBytes>0);
    for(const maxBytes of [0,-1,1024*1024-1,1024*1024+0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
      assert.throws(()=>new DebotScanner({...f.options,database:':memory:',maxBytes}),/DEBOT_SCANNER_CONFIG_INVALID/);
  }finally{await f.close();}
});

test('a larger DeBot byte budget resumes a full database with its original events and deduplication',async()=>{
  const f=fixture({mode:'authenticated_stream',maxBytes:1024*1024+4095});
  try {
    // Existing databases may use a nondefault page size; bytes must remain the actual cap.
    const seed=new DatabaseSync(f.database);
    try{seed.exec('PRAGMA page_size=8192; VACUUM;');}finally{seed.close();}
    const scanner=f.create();let failed:DebotSignalObservation|undefined;
    for(let id=1;id<=1000;id++){
      const item=observation(id);item.signal.text+='x'.repeat(8192);
      try{scanner.acceptPage(page(item));}catch(error){
        assert.match(String(error),/DEBOT_SIGNAL_STORE_FULL/);failed=item;break;
      }
    }
    assert.ok(failed,'the small page budget must reject a new event before the event-count limit');
    const full=scanner.getStatus(),before=f.rows();
    assert.equal(full.lastError,'DEBOT_SIGNAL_STORE_FULL');assert.ok(full.stored>1&&full.stored<1000);
    assert.ok(full.dbBytes<=1024*1024);assert.equal(full.dbBytes%8192,0);
    assert.equal(scanner.notificationHistory('bsc',failed.signal.token.address).total,0);
    await scanner.close();f.options.maxBytes=4*1024*1024;
    const reopened=f.create();assert.equal(reopened.getStatus().maxBytes,4*1024*1024);
    assert.equal(reopened.getStatus().lastError,undefined);assert.deepEqual(f.rows(),before);
    const original=JSON.parse(String(before[0].payload)) as DebotSignalObservation;
    reopened.acceptPage(page(original));assert.deepEqual(f.rows(),before);
    assert.equal(reopened.notificationHistory('bsc',original.signal.token.address).aggregation?.notificationCount,1);
    reopened.acceptPage(page(failed));assert.equal(reopened.getStatus().stored,before.length+1);
    assert.equal(reopened.notificationHistory('bsc',failed.signal.token.address).total,1);
    assert.ok(reopened.getStatus().dbBytes>full.dbBytes);
    assert.ok(reopened.getStatus().dbBytes<=reopened.getStatus().maxBytes);
  }finally{await f.close();}
});

test('a full nested notification ledger preserves SQLITE_FULL and rolls back the failed event',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const ledger=new DebotNotificationLedger(db,()=>new Date(iso(1000)));
    db.exec('PRAGMA max_page_count=32');let saved=0,error:unknown;
    for(let id=1;id<=1000;id++){
      try{ledger.record(observation(id));saved++;}catch(value){error=value;break;}
    }
    assert.ok(saved>0&&saved<1000);assert.equal((error as {errcode?:number})?.errcode,13);
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM debot_notification_events').get()!.n),saved);
    assert.equal(ledger.history('bsc',address(saved+1)).total,0);
  }finally{db.close();}
});
