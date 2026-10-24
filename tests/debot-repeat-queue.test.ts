import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DebotScanner,type DebotScannerOptions} from '../src/debot-scanner.js';
import type {DebotSignalObservation,DebotVendorWalletDetail,DebotWalletDetails} from '../src/providers/debot-signals.js';
import type {Check,Report,Signal} from '../src/types.js';

const epoch=Date.parse('2026-10-15T06:00:00.000Z');
const at=(milliseconds=0)=>new Date(epoch+milliseconds).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function observation(id=1,milliseconds=0,aliases=['hint-one']):DebotSignalObservation {
  return {id:String(id),observedAt:at(milliseconds),name:'Example',symbol:'EX',walletCount:aliases.length,addressCount:0,aliases,
    vendorWallets:aliases.map(alias=>({alias,amount:'100',priceUsd:0.001})),alertPriceUsd:0.001,
    signal:{source:'debot',sourceEventId:`debot:repeat:${id}`,token:{chain:'bsc',address:address(100)},occurredAt:at(milliseconds-100),
      text:`vendor event ${id}`,claim:'unspecified',evidenceUrls:[]}};
}
const page=(...observations:DebotSignalObservation[])=>({observations,received:observations.length,rejected:0});
const wallet=(n:number):DebotVendorWalletDetail=>({address:address(n),alias:`resolved-${n}`,source:'debot',verification:'vendor_report',
  lastTradeAt:at(-500),profit:{buyAmount:'100',holdAmount:'100'}});
function details(milliseconds:number,rows:DebotVendorWalletDetail[]):DebotWalletDetails {
  return {fetchedAt:at(milliseconds),received:rows.length,rejected:0,vendorWallets:rows};
}
function report(signal:Signal,milliseconds:number,second=false):Report {
  const checked:Check={status:'pass',reasons:['TEST_PASSED'],checkedAt:at(milliseconds),facts:{}};
  return {id:second?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111',policyVersion:'repeat-test',mode:'live',
    signal,receivedAt:at(milliseconds),evaluatedAt:at(milliseconds),validUntil:at(milliseconds+30000),decision:second?'REJECT':'WATCH',
    buyEligible:false,executionEnabled:false,reasons:[second?'TEST_REASSESSMENT_REJECTED':'TEST_FIRST_WATCH'],
    safety:checked,provenance:checked,marketRisk:checked,flow:checked,narrative:{...checked,evidence:[]}};
}
function fixture(overrides:Partial<DebotScannerOptions>={}) {
  const directory=mkdtempSync(join(tmpdir(),'debot-repeat-queue-')),database=join(directory,'inbox.sqlite');let milliseconds=0;
  const calls:{signal:Signal;observedAt:string;repeat:boolean|undefined}[]=[],scanners:DebotScanner[]=[];
  const options:DebotScannerOptions={database,chains:['bsc','robinhood'],maxAgeSec:600,mode:'authenticated_stream',repeatCooldownSec:0,
    maxConcurrent:2,now:()=>new Date(at(milliseconds)),fetchDetails:async()=>details(milliseconds,[wallet(1)]),
    onSignal:async(signal,observedAt,context)=>{calls.push({signal,observedAt,repeat:context?.repeat});},...overrides};
  const create=()=>{const scanner=new DebotScanner(options);scanners.push(scanner);return scanner;};
  const rows=()=>{const db=new DatabaseSync(database,{readOnly:true});
    try{return db.prepare('SELECT * FROM debot_signals ORDER BY rowid').all();}finally{db.close();}};
  return {create,database,rows,calls,options,now:()=>milliseconds,advance:(value:number)=>{milliseconds=value;},
    close:async()=>{for(const scanner of scanners)await scanner.close();rmSync(directory,{recursive:true,force:true});}};
}

test('a revised vendor event reassesses only after fresh details reveal a new exact wallet and leaves the first report frozen',async()=>{
  const f=fixture();let scanner:DebotScanner,detailCalls=0;
  f.options.fetchDetails=async()=>details(f.now(),++detailCalls===1?[wallet(1)]:[wallet(1),wallet(2)]);
  f.options.onSignal=async(signal,observedAt,context)=>{
    f.calls.push({signal,observedAt,repeat:context?.repeat});
    const result=report(signal,f.now(),f.calls.length>1);scanner.bindReport(signal.sourceEventId,result.id);scanner.recordReport(signal.sourceEventId,result);
  };
  try {
    scanner=f.create();const original=observation();scanner.acceptPage(page(original));await scanner.dispatchOnce();
    const baseline=f.rows()[0];assert.equal(f.calls.length,1);assert.equal(f.calls[0].repeat,false);
    f.advance(1000);const updated={...observation(1,1000,['hint-one','hint-two']),signal:original.signal};
    scanner.acceptPage(page(updated));await scanner.dispatchOnce();
    assert.equal(f.calls.length,2);assert.equal(f.calls[1].repeat,true);assert.match(f.calls[1].signal.sourceEventId,/^debot:revision:/);
    assert.equal(f.calls[1].signal.occurredAt,original.signal.occurredAt);assert.equal(detailCalls,2);
    const rows=f.rows();assert.deepEqual(rows.find(row=>row.id===original.signal.sourceEventId),baseline);
    const grouped=scanner.list();assert.equal(grouped.total,1);assert.equal(grouped.items[0].decision,'REJECT');
    assert.equal(grouped.items[0].aggregation.firstSeenAt,at());assert.equal(grouped.items[0].aggregation.notificationCount,1);
    assert.equal(grouped.items[0].aggregation.analysisCount,2);
    const history=scanner.notificationHistory('bsc',address(100));assert.equal(history.total,2);
    const reassessment=history.items.find(item=>item.classification==='reassessment')!;
    assert.ok(reassessment);assert.equal(reassessment.evidence.vendorChanges[0].address,address(2));
    assert.equal(reassessment.evidence.vendorChanges[0].verification,'vendor_changed');assert.deepEqual(reassessment.evidence.observedTrades,[]);
  }finally{await f.close();}
});

test('same-event alias changes without resolved addresses stay pending evidence and never call the full evaluator again',async()=>{
  const f=fixture();let detailCalls=0;
  f.options.fetchDetails=async()=>{detailCalls++;return details(f.now(),[{alias:'unresolved-label',source:'debot',verification:'vendor_report'}]);};
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();assert.equal(f.calls.length,1);
    f.advance(1000);scanner.acceptPage(page({...observation(1,1000,['hint-one','new-kol-name']),signal:observation().signal}));await scanner.dispatchOnce();
    assert.equal(f.calls.length,1);assert.equal(detailCalls,2);
    const history=scanner.notificationHistory('bsc',address(100));assert.equal(history.aggregation?.notificationCount,1);
    assert.equal(history.items[0].classification,'evidence_pending');assert.equal(history.items[0].evidence.status,'unavailable');
    assert.deepEqual(history.items[0].evidence.vendorChanges,[]);
    await scanner.dispatchOnce();assert.equal(detailCalls,2);assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

test('same-event changed aliases with the same resolved addresses do not reassess, and mark the no-change evidence explicitly',async()=>{
  const f=fixture();try {
    const scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();
    f.advance(1000);scanner.acceptPage(page({...observation(1,1000,['a-new-display-name']),signal:observation().signal}));await scanner.dispatchOnce();
    assert.equal(f.calls.length,1);assert.equal(scanner.list().items[0].aggregation.analysisCount,1);
    const latest=scanner.notificationHistory('bsc',address(100)).items[0];assert.equal(latest.classification,'no_material_change');
    assert.equal(latest.evidence.status,'unchanged');assert.deepEqual(latest.evidence.vendorChanges,[]);
    assert.equal(scanner.list().items[0].eventId,'debot:repeat:1');
  }finally{await f.close();}
});

test('price-only updates, wallet ordering and reminders without a newer event time never rerun details or full analysis',async()=>{
  const f=fixture();let detailCalls=0;
  f.options.fetchDetails=async()=>{detailCalls++;return details(f.now(),[wallet(1),wallet(2)]);};
  try {
    const scanner=f.create(),source=observation(1,0,['one','two']);scanner.acceptPage(page(source));await scanner.dispatchOnce();
    f.advance(1000);const sorted=structuredClone(source);sorted.observedAt=at(1000);sorted.aliases.reverse();sorted.vendorWallets!.reverse();
    scanner.acceptPage(page(sorted));await scanner.dispatchOnce();
    f.advance(2000);const price=structuredClone(sorted);price.observedAt=at(2000);price.alertPriceUsd=0.01;
    price.vendorWallets!.forEach(row=>{row.priceUsd=0.01;});scanner.acceptPage(page(price));await scanner.dispatchOnce();
    f.advance(3000);const reminder={...price,id:'2',observedAt:at(3000),signal:{...price.signal,sourceEventId:'debot:repeat:2'}};
    scanner.acceptPage(page(reminder));await scanner.dispatchOnce();
    assert.equal(detailCalls,1);assert.equal(f.calls.length,1);assert.equal(scanner.list().total,1);
    const history=scanner.notificationHistory('bsc',address(100));assert.equal(history.total,3);
    assert.equal(history.aggregation?.notificationCount,2);assert.equal(history.aggregation?.deliveryCount,4);
    assert.equal(history.items[0].classification,'display_only');
  }finally{await f.close();}
});

test('updates arriving during a token analysis preserve that task and collapse all pending updates into one follow-up',async()=>{
  const release=deferred(),f=fixture();let active=0,maxActive=0,detailCalls=0;
  f.options.fetchDetails=async()=>details(f.now(),++detailCalls===1?[wallet(1)]:[wallet(1),wallet(4)]);
  f.options.onSignal=async(signal,observedAt,context)=>{
    active++;maxActive=Math.max(maxActive,active);f.calls.push({signal,observedAt,repeat:context?.repeat});
    if(f.calls.length===1)await release.promise;active--;
  };
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));const work=scanner.dispatchOnce();await turn();assert.equal(f.calls.length,1);
    for(let i=2;i<=6;i++){f.advance(i*1000);scanner.acceptPage(page(observation(i,i*1000,['hint-one',`hint-${i}`])));}
    const pending=f.rows().filter(row=>row.state==='pending');assert.equal(pending.length,1);assert.equal(pending[0].id,'debot:repeat:6');
    assert.equal(f.rows().filter(row=>row.state==='dispatching').length,1);assert.equal(f.calls.length,1);
    release.resolve();await work;await scanner.dispatchOnce();
    assert.equal(maxActive,1);assert.equal(f.calls.length,2);assert.equal(f.calls[1].signal.sourceEventId,'debot:repeat:6');
    // Every distinct intermediate notification may carry an otherwise lost wallet hint.
    assert.equal(detailCalls,6);
    const history=scanner.notificationHistory('bsc',address(100));assert.equal(history.total,6);assert.equal(history.aggregation?.notificationCount,6);
    assert.equal(history.items.filter(item=>item.classification==='coalesced').length,4);
    assert.equal(history.aggregation?.firstSeenAt,at());
  }finally{release.resolve();await f.close();}
});

test('a burst received before dispatch still evaluates the first snapshot before its single merged follow-up',async()=>{
  const f=fixture();let detailCalls=0;
  f.options.fetchDetails=async()=>{
    detailCalls++;return details(f.now(),detailCalls===1?[wallet(1)]:[wallet(1),wallet(2)]);
  };
  f.options.onSignal=async(signal,observedAt,context)=>{
    f.calls.push({signal,observedAt,repeat:context?.repeat});if(f.calls.length===1)f.advance(f.now()+1);
  };
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));
    f.advance(1000);scanner.acceptPage(page(observation(2,1000,['one','two'])));
    f.advance(2000);scanner.acceptPage(page(observation(3,2000,['one','three'])));
    assert.equal(f.rows().filter(row=>row.state==='pending').length,2);
    await scanner.dispatchOnce();assert.deepEqual(f.calls.map(call=>call.signal.sourceEventId),['debot:repeat:1','debot:repeat:3']);
    assert.equal(scanner.list().items[0].aggregation.notificationCount,3);assert.equal(scanner.list().items[0].aggregation.analysisCount,2);
  }finally{await f.close();}
});

test('restart preserves revision deduplication and does not replay completed analysis or count an internal revision as a vendor event',async()=>{
  const f=fixture();let detailCalls=0;
  f.options.fetchDetails=async()=>details(f.now(),++detailCalls===1?[wallet(1)]:[wallet(1),wallet(2)]);
  try {
    const first=f.create(),original=observation();first.acceptPage(page(original));await first.dispatchOnce();
    f.advance(1000);const updated={...observation(1,1000,['one','two']),signal:original.signal};
    first.acceptPage(page(updated));await first.dispatchOnce();assert.equal(f.calls.length,2);await first.close();
    const persisted=f.rows(),restarted=f.create();await restarted.dispatchOnce();assert.equal(f.calls.length,2);
    f.advance(2000);restarted.acceptPage(page({...updated,observedAt:at(2000)}));await restarted.dispatchOnce();
    assert.equal(f.calls.length,2);assert.equal(detailCalls,2);assert.deepEqual(f.rows(),persisted);
    const history=restarted.notificationHistory('bsc',address(100));assert.equal(history.total,2);assert.equal(history.aggregation?.notificationCount,1);
    assert.equal(history.aggregation?.deliveryCount,3);assert.equal(history.aggregation?.firstSeenAt,at());
  }finally{await f.close();}
});

test('the main list groups by chain and CA while notification history exposes stable paginated versions',async()=>{
  const f=fixture();try {
    const scanner=f.create();for(let i=1;i<=6;i++){f.advance(i*1000);scanner.acceptPage(page(observation(i,i*1000,[`alias-${i}`])));}
    await scanner.dispatchOnce();assert.equal(scanner.list().total,1);
    const first=scanner.notificationHistory('bsc',address(100),{limit:2});assert.equal(first.total,6);assert.equal(first.hasMore,true);
    assert.deepEqual(first.items.map(item=>item.vendorEventId),['6','5']);
    f.advance(7000);scanner.acceptPage(page(observation(7,7000,['alias-7'])));
    const second=scanner.notificationHistory('bsc',address(100),{limit:2,offset:2,asOf:first.asOf});
    assert.equal(second.total,6);assert.deepEqual(second.items.map(item=>item.vendorEventId),['4','3']);
    const crossChain=observation(8,7000);crossChain.signal.token.chain='robinhood';scanner.acceptPage(page(crossChain));
    assert.equal(scanner.list().total,2);assert.equal(scanner.list({chain:'bsc'}).total,1);assert.equal(scanner.list({chain:'robinhood'}).total,1);
    assert.equal(scanner.notificationHistory('robinhood',address(100)).total,1);
  }finally{await f.close();}
});

test('inbox insert failure rolls notification persistence back so the same delivery can be retried without losing its first analysis',async()=>{
  const f=fixture();try {
    const scanner=f.create();let db=new DatabaseSync(f.database);
    try {db.exec("CREATE TRIGGER reject_test_signal BEFORE INSERT ON debot_signals BEGIN SELECT RAISE(ABORT,'TEST_INBOX_WRITE_FAILURE'); END;");}finally{db.close();}
    assert.throws(()=>scanner.acceptPage(page(observation())),/DEBOT_SIGNAL_PERSIST_FAILED/);
    assert.equal(f.rows().length,0);assert.equal(scanner.notificationHistory('bsc',address(100)).total,0);
    assert.equal(scanner.notificationHistory('bsc',address(100)).aggregation?.firstSeenAt,undefined);
    assert.equal(scanner.notificationHistory('bsc',address(100)).aggregation?.notificationCount,undefined);
    db=new DatabaseSync(f.database);try{db.exec('DROP TRIGGER reject_test_signal');}finally{db.close();}
    scanner.acceptPage(page(observation()));await scanner.dispatchOnce();assert.equal(f.calls.length,1);
    assert.equal(scanner.notificationHistory('bsc',address(100)).aggregation?.notificationCount,1);
    assert.equal(scanner.notificationHistory('bsc',address(100)).aggregation?.deliveryCount,1);
  }finally{await f.close();}
});

test('a vendor timestamp rewrite cannot refresh a stale event into a new full analysis',async()=>{
  const f=fixture();let detailCalls=0;
  f.options.fetchDetails=async()=>details(f.now(),++detailCalls===1?[wallet(1)]:[wallet(1),wallet(2)]);
  try {
    const scanner=f.create(),original=observation();scanner.acceptPage(page(original));await scanner.dispatchOnce();
    f.advance(121_000);const rewritten=observation(1,121_000,['one','two']);scanner.acceptPage(page(rewritten));await scanner.dispatchOnce();
    assert.equal(f.calls.length,1);assert.equal(detailCalls,2);
    const revision=f.rows().find(row=>row.id!==original.signal.sourceEventId);
    assert.equal(revision?.state,'ignored');assert.equal(revision?.reason,'DEBOT_SIGNAL_STALE');assert.equal(revision?.occurred_at,original.signal.occurredAt);
    const history=scanner.notificationHistory('bsc',address(100));assert.equal(history.aggregation?.notificationCount,1);
    assert.equal(history.items[0].occurredAt,original.signal.occurredAt);assert.equal(history.items[0].delta.eventTimeConflict,true);
  }finally{await f.close();}
});

test('same-event revision jobs cannot bypass the bounded inbox or commit a ledger version without queue capacity',async()=>{
  const f=fixture();try {
    const scanner=f.create(),original=observation();scanner.acceptPage(page(original));await scanner.dispatchOnce();
    const db=new DatabaseSync(f.database);
    try {
      const insert=db.prepare(`INSERT INTO debot_signals(id,chain,address,occurred_at,observed_at,state,payload,reason)
        VALUES(?,'bsc',?, ?,?,'ignored',?,'TEST_CAPACITY_RECORD')`);
      db.exec('BEGIN');for(let i=0;i<9999;i++)insert.run(`capacity:${i}`,address(1000+i),at(-100),at(),JSON.stringify(original));db.exec('COMMIT');
    }finally{db.close();}
    assert.equal(scanner.getStatus().stored,10_000);f.advance(1000);
    assert.throws(()=>scanner.acceptPage(page({...observation(1,1000,['one','two']),signal:original.signal})),/DEBOT_SIGNAL_STORE_FULL/);
    assert.equal(scanner.getStatus().stored,10_000);assert.equal(scanner.notificationHistory('bsc',address(100)).total,1);
    assert.equal(scanner.notificationHistory('bsc',address(100)).aggregation?.deliveryCount,1);
  }finally{await f.close();}
});

test('new local sell evidence receives risk priority and bypasses the ordinary duplicate-notification cooldown',async()=>{
  const f=fixture({repeatCooldownSec:30});
  f.options.repeatEvidence=input=>({material:true,priority:'risk',reasons:['DEBOT_REPEAT_LOCAL_SELL_OBSERVED'],evidence:{
    chain:input.token.chain,address:input.token.address,fromAt:at(1),untilAt:input.now.toISOString(),status:'changed',coverage:'sampled',
    vendorChanges:[],observedTrades:[{evidenceId:'a'.repeat(64),txHash:'0x'+'b'.repeat(64),wallet:address(1),side:'sell',volumeUsd:500,
      eventAt:at(5),observedAt:at(6),source:'gmgn_wallet_activity',verification:'observed_trade'}],researchTargets:[],
    limitations:['RESEARCH_TRIGGER_NOT_ENTRY_PERMISSION']}});
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();
    f.advance(10);scanner.acceptPage(page(observation(2,10)));await scanner.dispatchOnce();
    assert.equal(f.calls.length,2);assert.equal(f.calls[1].repeat,true);
    const latest=scanner.notificationHistory('bsc',address(100)).items[0];assert.equal(latest.classification,'reassessment');
    assert.ok(latest.reasons.includes('DEBOT_REPEAT_LOCAL_SELL_OBSERVED'));assert.equal(latest.evidence.observedTrades[0].side,'sell');
  }finally{await f.close();}
});

test('an old card with a genuinely fresh wallet trade can reassess while original vendor and first-report timestamps stay immutable',async()=>{
  const f=fixture();let detailCalls=0;
  f.options.fetchDetails=async()=>details(f.now(),++detailCalls===1?[wallet(1)]:[
    {...wallet(1),lastTradeAt:at(140900),profit:{buyAmount:'150',holdAmount:'150'}}]);
  try {
    const scanner=f.create(),original=observation();scanner.acceptPage(page(original));await scanner.dispatchOnce();const baseline=f.rows()[0];
    f.advance(141000);const update={...observation(1,141000,['one','new-activity']),signal:original.signal};
    scanner.acceptPage(page(update));await scanner.dispatchOnce();
    assert.equal(f.calls.length,2);assert.equal(f.calls[1].repeat,true);assert.equal(f.calls[1].signal.occurredAt,at(140900));
    const rows=f.rows(),revision=rows.find(row=>row.id!==original.signal.sourceEventId)!;
    assert.equal(revision.occurred_at,original.signal.occurredAt);assert.equal(revision.analysis_occurred_at,at(140900));
    assert.deepEqual(rows.find(row=>row.id===original.signal.sourceEventId),baseline);
    const history=scanner.notificationHistory('bsc',address(100));assert.equal(history.aggregation.firstSeenAt,at());
    assert.equal(history.items[0].occurredAt,original.signal.occurredAt);assert.equal(history.items[0].classification,'reassessment');
    assert.ok(history.items[0].evidence.vendorChanges.some((change:{kind:string;eventAt:string})=>change.kind==='last_trade_at'&&change.eventAt===at(140900)));
  }finally{await f.close();}
});

test('coalescing retains a new wallet from an intermediate vendor event even when the latest event returns to the original wallet set',async()=>{
  const release=deferred(),f=fixture();let scanner:DebotScanner;const detailIds:string[]=[],targets:string[][]=[];
  f.options.fetchDetails=async observation=>{
    detailIds.push(observation.id);return details(f.now(),observation.id==='2'?[wallet(1),wallet(2)]:[wallet(1)]);
  };
  f.options.onSignal=async(signal,observedAt,context)=>{
    f.calls.push({signal,observedAt,repeat:context?.repeat});targets.push(scanner.vendorWalletTargets(signal)?.addresses??[]);
    if(f.calls.length===1)await release.promise;
  };
  try {
    scanner=f.create();scanner.acceptPage(page(observation()));const work=scanner.dispatchOnce();await turn();
    f.advance(1000);scanner.acceptPage(page(observation(2,1000,['hint-one','intermediate-wallet'])));
    f.advance(2000);scanner.acceptPage(page(observation(3,2000,['hint-one'])));
    assert.equal(f.rows().filter(row=>row.state==='pending').length,1);release.resolve();await work;await scanner.dispatchOnce();
    assert.deepEqual(detailIds,['1','2','3']);assert.equal(f.calls.length,2);assert.equal(f.calls[1].signal.sourceEventId,'debot:repeat:3');
    assert.ok(targets[1].includes(address(2)));const history=scanner.notificationHistory('bsc',address(100));
    assert.equal(history.total,3);assert.equal(history.items.find(item=>item.vendorEventId==='2')?.classification,'coalesced');
    assert.equal(history.items[0].classification,'reassessment');
    assert.ok(history.items[0].evidence.vendorChanges.some((change:{address:string})=>change.address===address(2)));
  }finally{release.resolve();await f.close();}
});

test('partially failed merged detail requests stay evidence-pending until expiry when successful responses show no changes',async()=>{
  const release=deferred(),f=fixture(),detailIds:string[]=[];
  f.options.fetchDetails=async observation=>{
    detailIds.push(observation.id);if(observation.id==='3')throw new Error('TEST_DETAIL_UNAVAILABLE');
    return details(f.now(),[wallet(1)]);
  };
  f.options.onSignal=async(signal,observedAt,context)=>{
    f.calls.push({signal,observedAt,repeat:context?.repeat});if(f.calls.length===1)await release.promise;
  };
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));const work=scanner.dispatchOnce();await turn();
    for(let i=2;i<=7;i++){f.advance(i*1000);const next=observation(i,i*1000,[`hint-${i}`]);next.signal.occurredAt=observation().signal.occurredAt;
      scanner.acceptPage(page(next));}
    release.resolve();await work;await scanner.dispatchOnce();
    assert.deepEqual(detailIds,['1','2','3','4','5','6','7']);assert.equal(f.calls.length,1);
    const pending=f.rows().find(row=>row.id==='debot:repeat:7');assert.equal(pending?.state,'pending');
    assert.equal(pending?.reason,'DEBOT_REPEAT_EVIDENCE_PENDING');
    let latest=scanner.notificationHistory('bsc',address(100)).items[0];assert.equal(latest.classification,'evidence_pending');
    assert.equal(latest.evidence.status,'unavailable');assert.deepEqual(latest.evidence.vendorChanges,[]);
    f.advance(128000);await scanner.dispatchOnce();assert.equal(f.calls.length,1);
    assert.equal(f.rows().find(row=>row.id==='debot:repeat:7')?.state,'ignored');
    latest=scanner.notificationHistory('bsc',address(100)).items[0];assert.equal(latest.classification,'stale');
  }finally{release.resolve();await f.close();}
});

test('a material merged reassessment discloses omitted hints when its bounded six detail requests truncate a larger burst',async()=>{
  const release=deferred(),f=fixture(),detailIds:string[]=[];
  f.options.fetchDetails=async observation=>{
    detailIds.push(observation.id);return details(f.now(),observation.id==='1'?[wallet(1)]:[wallet(1),wallet(Number(observation.id))]);
  };
  f.options.onSignal=async(signal,observedAt,context)=>{
    f.calls.push({signal,observedAt,repeat:context?.repeat});if(f.calls.length===1)await release.promise;
  };
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));const work=scanner.dispatchOnce();await turn();
    for(let i=2;i<=10;i++){f.advance(i*1000);scanner.acceptPage(page(observation(i,i*1000,[`hint-${i}`])));}
    release.resolve();await work;await scanner.dispatchOnce();assert.equal(f.calls.length,2);
    assert.equal(detailIds.length,7);assert.deepEqual(detailIds.slice(1),['5','6','7','8','9','10']);
    const history=scanner.notificationHistory('bsc',address(100));assert.equal(history.total,10);
    const latest=history.items[0];assert.equal(latest.vendorEventId,'10');assert.equal(latest.classification,'reassessment');
    assert.equal(latest.evidence.status,'changed');assert.ok(latest.evidence.vendorChanges.length>0);
    assert.ok(latest.evidence.limitations.includes('MERGED_HINTS_LIMIT_6'));
  }finally{release.resolve();await f.close();}
});

test('a queued reassessment preserves the latest completed verdict and score while exposing pending review separately',async()=>{
  const f=fixture({repeatCooldownSec:30});let scanner:DebotScanner;
  f.options.onSignal=async(signal,observedAt,context)=>{
    f.calls.push({signal,observedAt,repeat:context?.repeat});const result=report(signal,f.now());
    scanner.bindReport(signal.sourceEventId,result.id);scanner.recordReport(signal.sourceEventId,result);
  };
  try {
    scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();const baseline=scanner.list().items[0];
    assert.equal(baseline.state,'completed');assert.equal(baseline.decision,'WATCH');
    f.advance(1000);scanner.acceptPage(page(observation(2,1000,['new-wallet-hint'])));await scanner.dispatchOnce();
    const current=scanner.list().items[0];assert.equal(f.calls.length,1);assert.equal(current.state,'completed');
    assert.equal(current.eventId,baseline.eventId);assert.equal(current.reportId,baseline.reportId);assert.equal(current.decision,baseline.decision);
    assert.deepEqual(current.score,baseline.score);assert.deepEqual(current.checks,baseline.checks);assert.deepEqual(current.reasons,baseline.reasons);
    assert.equal(current.aggregation.reviewState,'pending');assert.equal(current.aggregation.reviewReason,'DEBOT_REPEAT_COOLDOWN');
    assert.equal(current.aggregation.analysisCount,1);assert.equal(current.aggregation.notificationCount,2);
  }finally{await f.close();}
});

test('a genuinely newer notification reassesses unchanged wallets without labeling it as new wallet evidence',async()=>{
  const f=fixture();let detailCalls=0;
  f.options.fetchDetails=async()=>{detailCalls++;return details(f.now(),[wallet(1)]);};
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();const baseline=f.rows()[0];
    f.advance(1000);const next=observation(2,1000);scanner.acceptPage(page(next));await scanner.dispatchOnce();
    assert.equal(f.calls.length,2);assert.equal(detailCalls,2);assert.equal(f.calls[1].repeat,true);
    assert.equal(f.calls[1].signal.sourceEventId,next.signal.sourceEventId);assert.equal(f.calls[1].signal.occurredAt,next.signal.occurredAt);
    assert.deepEqual(f.rows()[0],baseline);
    const latest=scanner.notificationHistory('bsc',address(100)).items[0];assert.equal(latest.classification,'reassessment');
    assert.ok(latest.reasons.includes('DEBOT_FRESH_NOTIFICATION_REASSESSMENT'));
    assert.equal(latest.evidence.status,'unchanged');assert.deepEqual(latest.evidence.vendorChanges,[]);assert.deepEqual(latest.evidence.observedTrades,[]);
    f.advance(2000);scanner.acceptPage(page({...next,observedAt:at(2000)}));await scanner.dispatchOnce();
    assert.equal(f.calls.length,2);assert.equal(detailCalls,2);
  }finally{await f.close();}
});

test('a fresh notification can request the full gate when optional wallet details are unavailable, without inventing wallet support',async()=>{
  const f=fixture();f.options.fetchDetails=async()=>{throw new Error('DETAILS_UNAVAILABLE');};
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();
    f.advance(1000);scanner.acceptPage(page(observation(2,1000)));await scanner.dispatchOnce();assert.equal(f.calls.length,2);
    const latest=scanner.notificationHistory('bsc',address(100)).items[0];assert.equal(latest.classification,'reassessment');
    assert.ok(latest.reasons.includes('DEBOT_FRESH_NOTIFICATION_REASSESSMENT'));assert.equal(latest.evidence.status,'unavailable');
    assert.deepEqual(latest.evidence.vendorChanges,[]);assert.deepEqual(latest.evidence.observedTrades,[]);
  }finally{await f.close();}
});

test('high-frequency new notifications respect the per-token cooldown and coalesce to the newest original event time',async()=>{
  const f=fixture({repeatCooldownSec:30});let detailCalls=0;
  f.options.fetchDetails=async()=>{detailCalls++;return details(f.now(),[wallet(1)]);};
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();
    for(const milliseconds of [1000,10_000,29_000]){
      f.advance(milliseconds);scanner.acceptPage(page(observation(milliseconds,milliseconds)));await scanner.dispatchOnce();
      assert.equal(f.calls.length,1);assert.equal(f.rows().filter(row=>row.state==='pending').length,1);
    }
    // A late older card and a future-dated card cannot displace the current head.
    f.advance(29_500);const older=observation(20_000,20_000);older.observedAt=at(29_500);
    const future=observation(40_000,40_000);future.observedAt=at(29_500);
    scanner.acceptPage(page(older,future));await scanner.dispatchOnce();
    assert.equal(f.rows().filter(row=>row.state==='pending').length,1);
    assert.equal(f.rows().find(row=>row.state==='pending')?.id,'debot:repeat:29000');
    assert.equal(detailCalls,1);
    f.advance(30_000);await scanner.dispatchOnce();assert.equal(f.calls.length,2);assert.equal(detailCalls,2);
    assert.equal(f.calls[1].signal.sourceEventId,'debot:repeat:29000');assert.equal(f.calls[1].signal.occurredAt,at(28_900));
    f.advance(31_000);scanner.acceptPage(page(observation(31_000,31_000)));await scanner.dispatchOnce();
    assert.equal(f.calls.length,2);assert.equal(f.rows().find(row=>row.state==='pending')?.reason,'DEBOT_REPEAT_COOLDOWN');
  }finally{await f.close();}
});

test('future, delayed and non-advancing event timestamps cannot acquire fresh-notification eligibility later',async()=>{
  const f=fixture();let detailCalls=0;
  f.options.fetchDetails=async()=>{detailCalls++;return details(f.now(),[wallet(1)]);};
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();
    f.advance(1000);
    const future=observation(2,1000);future.signal.occurredAt=at(2000);
    const futureReceipt=observation(3,2000);futureReceipt.signal.occurredAt=at(900);
    const sameTime=observation(4,1000);sameTime.signal.occurredAt=observation().signal.occurredAt;
    for(const value of [future,futureReceipt,sameTime]){scanner.acceptPage(page(value));await scanner.dispatchOnce();}
    assert.equal(f.calls.length,1);assert.equal(detailCalls,1);
    f.advance(5000);scanner.acceptPage(page({...future,observedAt:at(5000)},{...futureReceipt,observedAt:at(5000)}));await scanner.dispatchOnce();
    assert.equal(f.calls.length,1);
    f.advance(121_000);const delayed=observation(5,1000);delayed.observedAt=at(121_000);scanner.acceptPage(page(delayed));await scanner.dispatchOnce();
    assert.equal(f.calls.length,1);assert.equal(f.rows().find(row=>row.id==='debot:repeat:5')?.reason,'DEBOT_SIGNAL_STALE');
  }finally{await f.close();}
});

test('new notifications expire while waiting for details and never use their arrival time to refresh the event',async()=>{
  const f=fixture();let detailCalls=0;
  f.options.fetchDetails=async()=>{if(++detailCalls===2)f.advance(122_000);return details(f.now(),[wallet(1)]);};
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();
    f.advance(1000);scanner.acceptPage(page(observation(2,1000)));await scanner.dispatchOnce();assert.equal(f.calls.length,1);
    assert.equal(f.rows().find(row=>row.id==='debot:repeat:2')?.state,'ignored');
    assert.equal(scanner.notificationHistory('bsc',address(100)).items[0].reasons.includes('DEBOT_FRESH_NOTIFICATION_REASSESSMENT'),false);
  }finally{await f.close();}
});

test('restart preserves a fresh notification waiting in cooldown without replaying completed notifications',async()=>{
  const f=fixture({repeatCooldownSec:30});try {
    const first=f.create();first.acceptPage(page(observation()));await first.dispatchOnce();
    f.advance(1000);const next=observation(2,1000);first.acceptPage(page(next));await first.dispatchOnce();assert.equal(f.calls.length,1);
    await first.close();const restarted=f.create();await restarted.dispatchOnce();assert.equal(f.calls.length,1);
    f.advance(30_000);await restarted.dispatchOnce();assert.equal(f.calls.length,2);
    f.advance(31_000);restarted.acceptPage(page({...next,observedAt:at(31_000)}));await restarted.dispatchOnce();assert.equal(f.calls.length,2);
  }finally{await f.close();}
});

test('same-event price and name changes cannot displace a genuine new notification waiting in cooldown',async()=>{
  const f=fixture({repeatCooldownSec:30});try {
    const scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();
    f.advance(1000);const next=observation(2,1000);scanner.acceptPage(page(next));await scanner.dispatchOnce();
    f.advance(2000);const display={...next,observedAt:at(2000),name:'New display name',alertPriceUsd:2};
    scanner.acceptPage(page(display));await scanner.dispatchOnce();
    assert.equal(f.rows().length,2);assert.equal(f.rows().find(row=>row.state==='pending')?.id,next.signal.sourceEventId);
    assert.equal(f.calls.length,1);
    f.advance(30_000);await scanner.dispatchOnce();assert.equal(f.calls.length,2);
    assert.equal(f.calls[1].signal.sourceEventId,next.signal.sourceEventId);assert.equal(f.calls[1].signal.occurredAt,next.signal.occurredAt);
  }finally{await f.close();}
});

test('a wallet-hint revision preserves the pending original event eligibility without receiving eligibility itself',async()=>{
  const f=fixture({repeatCooldownSec:30});let detailCalls=0;
  f.options.fetchDetails=async()=>{detailCalls++;return details(f.now(),[wallet(1)]);};
  try {
    const scanner=f.create();scanner.acceptPage(page(observation()));await scanner.dispatchOnce();
    f.advance(1000);const next=observation(2,1000);scanner.acceptPage(page(next));await scanner.dispatchOnce();
    f.advance(2000);const revision={...observation(2,2000,['updated-wallet-label']),signal:next.signal};
    scanner.acceptPage(page(revision));await scanner.dispatchOnce();
    const pending=f.rows().filter(row=>row.state==='pending');assert.equal(pending.length,1);assert.equal(pending[0].id,next.signal.sourceEventId);
    assert.equal(pending[0].fresh_notification,1);assert.equal(pending[0].occurred_at,next.signal.occurredAt);assert.equal(pending[0].observed_at,next.observedAt);
    const revised=f.rows().find(row=>String(row.id).startsWith('debot:revision:'))!;
    assert.equal(revised.fresh_notification,0);assert.equal(revised.reason,'DEBOT_UPDATE_COALESCED');assert.equal(f.calls.length,1);
    f.advance(30_000);await scanner.dispatchOnce();assert.equal(f.calls.length,2);assert.equal(detailCalls,2);
    assert.equal(f.calls[1].signal.sourceEventId,next.signal.sourceEventId);assert.equal(f.calls[1].signal.occurredAt,next.signal.occurredAt);
    assert.ok(scanner.notificationHistory('bsc',address(100)).items.some(item=>item.eventId===next.signal.sourceEventId&&
      item.classification==='reassessment'&&item.reasons.includes('DEBOT_FRESH_NOTIFICATION_REASSESSMENT')));
  }finally{await f.close();}
});

test('a future first pending event is not protected ahead of a valid later arrival',async()=>{
  const f=fixture();try {
    const scanner=f.create(),future=observation();future.signal.occurredAt=at(1000);
    scanner.acceptPage(page(future,observation(2)));await scanner.dispatchOnce();
    assert.deepEqual(f.calls.map(call=>call.signal.sourceEventId),['debot:repeat:2']);
    assert.equal(f.rows().find(row=>row.id===future.signal.sourceEventId)?.reason,'DEBOT_UPDATE_COALESCED');
    f.advance(2000);scanner.acceptPage(page({...future,observedAt:at(2000)}));await scanner.dispatchOnce();assert.equal(f.calls.length,1);
  }finally{await f.close();}
});
