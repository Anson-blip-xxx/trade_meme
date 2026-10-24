import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {SourceCorroboration,assessSourceCorroboration,type SourceNotificationEvidence,type CorroborationSource} from '../src/source-corroboration.js';
import type {Signal} from '../src/types.js';

const origin=Date.parse('2026-10-16T10:00:00.000Z'),at=(seconds=0)=>new Date(origin+seconds*1000).toISOString();
const address=(n=1)=>`0x${n.toString(16).padStart(40,'0')}`,hash=(n=1)=>`0x${n.toString(16).padStart(64,'0')}`;
const token={chain:'bsc' as const,address:address()},other={chain:'bsc' as const,address:address(2)};
function signal(source:CorroborationSource='ave',seconds=0,id=`${source}-1`,target:Signal['token']=token):Signal {
  return {source,sourceEventId:id,occurredAt:at(seconds),token:target,text:'',claim:'unspecified',evidenceUrls:[]};
}
function evidence(source:CorroborationSource='ave',seconds=0,overrides:Partial<SourceNotificationEvidence>={}):SourceNotificationEvidence {
  return {source,eventId:`${source}-1`,token,occurredAt:at(seconds),firstObservedAt:at(seconds),recordedAt:at(seconds),
    lastDeliveryAt:at(seconds),lastRecordedAt:at(seconds),deliveryCount:1,txRefs:[],...overrides};
}
function fixture(maxBytes?:number){
  const directory=mkdtempSync(join(tmpdir(),'source-corroboration-')),database=join(directory,'sources.sqlite');let sec=0;
  const instances:SourceCorroboration[]=[];
  const create=(maxEvents?:number)=>{const ledger=new SourceCorroboration(database,{now:()=>new Date(at(sec)),maxBytes,maxEvents});instances.push(ledger);return ledger;};
  return {database,create,advance:(value:number)=>{sec=value;},close:()=>{instances.forEach(value=>value.close());rmSync(directory,{recursive:true,force:true});}};
}

test('pure comparison requires fresh same-chain full CA notifications from distinct providers and never adds score',()=>{
  const first=evidence(),second=evidence('debot',15),foreign=evidence('gmgn',15,{token:{...token,chain:'robinhood'}});
  const result=assessSourceCorroboration({token,now:new Date(at(20)),observations:[first,second,foreign]});
  assert.equal(result.classification,'cross_source');assert.deepEqual(result.freshSources,['ave','debot']);assert.equal(result.freshSourceCount,2);
  assert.equal(result.independentEvidence,'unknown');assert.equal(result.scoreEffect,0);assert.equal(result.researchOnly,true);
  assert.equal(result.activity,undefined); // A bounded caller sample cannot claim exact historical activity.
  const repeated=assessSourceCorroboration({token,now:new Date(at(20)),observations:[first,first,first]});
  assert.equal(repeated.classification,'single_source');assert.equal(repeated.sources[0].notificationCount,1);
});

test('future notification clocks and late backfills never become fresh when replayed later',()=>{
  const future=evidence('ave',10,{firstObservedAt:at(),recordedAt:at(),lastDeliveryAt:at(),lastRecordedAt:at()}),
    late=evidence('debot',-400,{firstObservedAt:at(),recordedAt:at(),lastDeliveryAt:at(),lastRecordedAt:at()});
  for(const sec of [20,250,500]){
    const result=assessSourceCorroboration({token,now:new Date(at(sec)),observations:[future,late]});
    assert.equal(result.classification,'none');assert.deepEqual(result.sources.map(value=>value.status),['future','late']);
  }
});

test('cross-source time window expires from first receipt and event time, not repeat delivery',()=>{
  const f=fixture();try {
    const ledger=f.create();ledger.record(signal());f.advance(100);ledger.record(signal('debot',100));
    assert.equal(ledger.assess(token).classification,'cross_source');
    f.advance(301);assert.deepEqual(ledger.record(signal(),at(301)),{accepted:true,duplicate:true});
    const current=ledger.assess(token);assert.equal(current.classification,'single_source');assert.deepEqual(current.freshSources,['debot']);
    const ave=current.sources.find(value=>value.source==='ave')!;assert.equal(ave.firstObservedAt,at());assert.equal(ave.deliveryCount,2);assert.equal(ave.status,'stale');
    f.advance(401);assert.equal(ledger.assess(token).classification,'none');
  }finally{f.close();}
});

test('event identity binds to chain and complete CA; canonical EVM case works but token swapping cannot alter prior evidence',()=>{
  const f=fixture();try {
    const ledger=f.create(),ca='0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const initial=signal('ave',0,'identity',{chain:'bsc',address:ca.toUpperCase().replace('0X','0x')});
    assert.equal(ledger.record(initial).accepted,true);
    assert.equal(ledger.record({...initial,token:{chain:'bsc',address:ca}}).duplicate,true);
    assert.equal(ledger.record({...initial,token:other}).reason,'SOURCE_EVENT_ID_CONFLICT');
    assert.equal(ledger.record({...initial,token:{chain:'robinhood',address:ca}}).reason,'SOURCE_EVENT_ID_CONFLICT');
    assert.equal(ledger.assess({chain:'bsc',address:ca}).freshSourceCount,1);assert.equal(ledger.assess({chain:'robinhood',address:ca}).freshSourceCount,0);
    assert.equal(ledger.status().events,1);
  }finally{f.close();}
});

test('new vendor notifications advance source evidence without rewriting the first one or using a different provider as a new wallet group',()=>{
  const f=fixture();try {
    const ledger=f.create();ledger.record(signal(),at(),{name:'original',txRefs:[{txHash:hash(),wallet:address(10),side:'buy'}]});
    f.advance(20);ledger.record(signal(),at(20),{name:'revised',txRefs:[{txHash:hash(2),wallet:address(11),side:'buy'}]});
    ledger.record(signal('ave',20,'ave-2'),at(20),{name:'second'});ledger.record(signal('gmgn',20));
    const history=ledger.history(token),original=history.items.find(value=>value.eventId==='ave-1')!;
    assert.equal(original.name,'original');assert.deepEqual(original.txRefs,[{txHash:hash(),wallet:address(10),side:'buy'}]);assert.equal(original.firstObservedAt,at());
    const result=ledger.assess(token);assert.equal(result.sources.find(value=>value.source==='ave')!.notificationCount,2);
    assert.equal(result.freshSourceCount,2);assert.equal(result.independentEvidence,'unknown');assert.equal(result.scoreEffect,0);
  }finally{f.close();}
});

test('same public transaction reported by two providers is shown as shared reference and not two independent trades',()=>{
  const f=fixture();try {
    const ledger=f.create(),refs=[{txHash:hash(),wallet:address(10),side:'buy' as const}];
    ledger.record(signal(),at(),{txRefs:refs});ledger.record(signal('debot'),at(),{txRefs:[...refs,...refs]});
    const result=ledger.assess(token);assert.equal(result.sharedTransactions.length,1);
    assert.deepEqual(result.sharedTransactions[0],{txHash:hash(),sources:['ave','debot'],wallets:[address(10)],sides:['buy'],verification:'vendor_reference'});
    assert.equal(result.sources[1].txReferenceCount,1);assert.equal(result.independentEvidence,'unknown');
    f.advance(1);ledger.record(signal('gmgn',1),at(1),{txRefs:[{txHash:hash(2),wallet:address(11),side:'buy'}]});
    assert.equal(ledger.assess(token).independentEvidence,'unknown');assert.equal(ledger.assess(token).sharedTransactions.length,1);
  }finally{f.close();}
});

test('source-specific safe metadata excludes query credentials, forged URLs, wallet aliases and malformed transaction hashes',()=>{
  const f=fixture();try {
    const ledger=f.create();ledger.record(signal(),at(),{sourceUrl:'https://ave.ai/smart?token=DO_NOT_PERSIST#secret',name:'Safe\u0000name',
      txRefs:[{txHash:hash(),wallet:'alias'},{txHash:'fake'},...Array.from({length:30},(_,n)=>({txHash:hash(n+2)}))]});
    const item=ledger.history(token).items[0];assert.equal(item.sourceUrl,'https://ave.ai/smart');assert.ok(item.txRefs.length<=20);assert.equal(item.name,'Safename');
    ledger.record(signal('debot'),at(),{sourceUrl:'https://debot.ai@evil.test/token'});
    assert.equal(ledger.history(token).items.find(value=>value.source==='debot')!.sourceUrl,undefined);
    const db=new DatabaseSync(f.database,{readOnly:true});try{assert.ok(!JSON.stringify(db.prepare('SELECT * FROM source_notifications').all()).includes('DO_NOT_PERSIST'));}finally{db.close();}
  }finally{f.close();}
});

test('as-of assessment and history exclude future knowledge including late recordings, time conflicts and repeat counters',()=>{
  const f=fixture();try {
    const ledger=f.create();ledger.record(signal());
    f.advance(30);ledger.record(signal('debot',10),at(10));
    assert.equal(ledger.assess(token,new Date(at(20))).classification,'single_source');assert.equal(ledger.history(token,{asOf:at(20)}).total,1);
    f.advance(40);ledger.record(signal(),at(40));
    const historical=ledger.history(token,{asOf:at(20)}).items[0];assert.equal(historical.deliveryCount,null);assert.equal(historical.lastDeliveryAt,undefined);
    f.advance(50);ledger.record(signal('ave',5),at(50));
    assert.equal(ledger.assess(token,new Date(at(20))).sources[0].status,'fresh');
    const current=ledger.assess(token);assert.equal(current.sources.find(value=>value.source==='ave')!.status,'conflict');
    assert.equal(current.classification,'single_source');assert.equal(ledger.history(token).items.find(value=>value.source==='ave')!.occurredAt,at());
    assert.throws(()=>ledger.history(token,{asOf:at(51)}),/INVALID_FILTER/);assert.throws(()=>ledger.assess(token,new Date(at(51))),/SOURCE_ASSESSMENT_INVALID/);
  }finally{f.close();}
});

test('stable as-of pagination survives new messages and duplicate deliveries; counters reveal historical uncertainty',()=>{
  const f=fixture();try {
    const ledger=f.create();for(let i=0;i<5;i++){f.advance(i);ledger.record(signal('ave',i,`event-${i}`));}
    const first=ledger.history(token,{limit:2,asOf:at(4)});assert.equal(first.total,5);assert.equal(first.hasMore,true);
    f.advance(5);ledger.record(signal('ave',5,'new'));ledger.record(signal('ave',4,'event-4'));
    const stable=ledger.history(token,{limit:2,asOf:first.asOf}),second=ledger.history(token,{limit:2,offset:2,asOf:first.asOf});
    assert.deepEqual(stable.items.map(item=>item.eventId),first.items.map(item=>item.eventId));assert.equal(stable.total,5);
    assert.deepEqual(second.items.map(item=>item.eventId),['event-2','event-1']);assert.equal(stable.items[0].deliveryCount,null);
    assert.equal(ledger.history(token,{limit:2,offset:4,asOf:first.asOf}).hasMore,false);
    for(const invalid of [{limit:0},{limit:101},{offset:-1},{asOf:'invalid'}])assert.throws(()=>ledger.history(token,invalid),/INVALID_FILTER/);
  }finally{f.close();}
});

test('durable reopen preserves original timestamps and immutable metadata while secrets stay outside the ledger',()=>{
  const f=fixture();try {
    let ledger=f.create();ledger.record(signal(),at(),{name:'first'});ledger.close();f.advance(120);ledger=f.create();
    assert.equal(ledger.assess(token).classification,'single_source');ledger.record(signal(),at(120),{name:'later'});
    const row=ledger.history(token).items[0];assert.equal(row.firstObservedAt,at());assert.equal(row.name,'first');assert.equal(row.deliveryCount,2);
    assert.equal(statSync(f.database).mode&0o777,0o600);assert.equal(ledger.status().events,1);assert.equal(ledger.status().deliveries,2);
  }finally{f.close();}
});

test('unsupported chains, incomplete addresses, manual sources, invalid references and future receive times cannot generate corroboration',()=>{
  const f=fixture();try {
    const ledger=f.create();for(const bad of [signal('ave',0,'bad',{chain:'bsc',address:'0x1234'}),signal('ave',0,'bad',{chain:'other',address:address()} as never),
      {...signal(),source:'manual' as const},signal('ave',0,'bad',{chain:'bsc',address:address(0)}),{...signal(),occurredAt:'not-a-date'}]){
      assert.equal(ledger.record(bad).accepted,false);
    }
    assert.equal(ledger.record(signal(),at(1)).accepted,false);assert.equal(ledger.status().events,0);
    ledger.record(signal('ave',1));assert.equal(ledger.assess(token).sources[0].status,'future');
    f.advance(3);assert.equal(ledger.assess(token).sources[0].status,'future');
  }finally{f.close();}
});

test('Solana addresses and signatures are validated without case folding',()=>{
  const f=fixture();try {
    const ledger=f.create(),target={chain:'solana' as const,address:bs58.encode(new Uint8Array(32).fill(9))},signature=bs58.encode(new Uint8Array(64).fill(8));
    ledger.record(signal('ave',0,'sol-ave',target),at(),{txRefs:[{txHash:signature,wallet:target.address}]});
    ledger.record(signal('debot',0,'sol-debot',target),at(),{txRefs:[{txHash:signature}]});
    const result=ledger.assess(target);assert.equal(result.classification,'cross_source');assert.equal(result.sharedTransactions[0].txHash,signature);
    assert.equal(ledger.assess(token).classification,'none');
  }finally{f.close();}
});

test('reference sampling is bounded without hiding fresh providers behind later stale alerts',()=>{
  const f=fixture();try {
    const ledger=f.create();ledger.record(signal());ledger.record(signal('debot'));
    for(let i=1;i<80;i++){f.advance(i);ledger.record(signal('debot',-400,`late-${i}`));}
    const result=ledger.assess(token);assert.equal(result.classification,'cross_source');
    assert.equal(result.sources.find(value=>value.source==='debot')!.status,'fresh');assert.equal(result.sources.find(value=>value.source==='debot')!.notificationCount,80);
    assert.ok(result.limitations.includes('SHARED_REFERENCE_COMPARISON_BOUNDED_SAMPLE'));
  }finally{f.close();}
});

test('retention drops expired history and refuses replay backdating beyond retained scope',()=>{
  const f=fixture();try {
    const ledger=f.create();ledger.record(signal());f.advance(30*86400+1);
    assert.equal(ledger.history(token).total,0);assert.equal(ledger.assess(token).classification,'none');
    assert.equal(ledger.record(signal(),at()).reason,'SOURCE_NOTIFICATION_OUTSIDE_RETENTION');
    ledger.record(signal('ave',30*86400+1,'new'));assert.equal(ledger.status().prunedEvents,1);assert.equal(ledger.status().events,1);
  }finally{f.close();}
});

test('database size limit fails closed with a bounded error and keeps previously recorded evidence readable',()=>{
  const f=fixture(1024*1024);try {
    const ledger=f.create(),refs=Array.from({length:20},(_,n)=>({txHash:hash(n+1),wallet:address(n+2),side:'buy' as const}));
    let full=false;
    for(let i=0;i<1000;i++){
      const result=ledger.record(signal('ave',0,`sized-${i}`),at(),{name:'x'.repeat(100),txRefs:refs});
      if(!result.accepted){assert.equal(result.reason,'SOURCE_LEDGER_CAPACITY_REACHED');full=true;break;}
    }
    assert.equal(full,true);assert.ok(ledger.status().bytes!<=1024*1024);assert.ok(ledger.history(token).total>0);
    assert.equal(ledger.assess(token).classification,'single_source');
  }finally{f.close();}
});

test('100000-event limit retains existing dedup identities instead of evicting them and treating replays as new alerts',()=>{
  const f=fixture();try {
    const ledger=f.create();ledger.record(signal('ave',0,'seed'));
    const db=new DatabaseSync(f.database);
    try {
      db.exec(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<99999)
        INSERT INTO source_notifications SELECT 'ave','filled-'||n,chain,address,occurred_at,first_observed_at,
          recorded_at,last_delivery_at,last_recorded_at,delivery_count,conflict_at,name,source_url,tx_refs
        FROM sequence CROSS JOIN source_notifications WHERE event_id='seed'`);
    }finally{db.close();}
    assert.equal(ledger.record(signal('debot')).reason,'SOURCE_LEDGER_CAPACITY_REACHED');
    assert.equal(ledger.record(signal('ave',0,'seed')).duplicate,true);
    assert.equal(ledger.status().events,100000);assert.equal(ledger.status().error,'SOURCE_LEDGER_CAPACITY_REACHED');assert.equal(ledger.status().maxEvents,100000);
    assert.equal(ledger.history(token,{limit:1}).total,100000);assert.equal(ledger.history(token,{limit:1}).maxEvents,100000);
  }finally{f.close();}
});

test('reopening a capped ledger with a larger event budget admits a new notification without evicting or reclassifying duplicates',()=>{
  const f=fixture();try {
    let ledger=f.create(1);
    const target={chain:'solana' as const,address:bs58.encode(new Uint8Array(32).fill(9))},
      wallet=bs58.encode(new Uint8Array(32).fill(7)),txHash=bs58.encode(new Uint8Array(64).fill(8)),
      initial=signal('ave',0,'ave:signal:'+ '1'.repeat(64),target);
    assert.deepEqual(ledger.record(initial,at(),{name:'first'}),{accepted:true,duplicate:false});
    f.advance(60);
    const fresh={...signal('gmgn',60,'gmgn:trade:'+ '2'.repeat(64),target),
      text:`GMGN 链上买入记录；交易 ${txHash}；钱包 ${wallet}；CA ${target.address}。`},
      metadata={txRefs:[{txHash,wallet,side:'buy' as const}],sourceUrl:'https://gmgn.ai/'};
    assert.equal(ledger.record(fresh,at(60),metadata).reason,'SOURCE_LEDGER_CAPACITY_REACHED');
    assert.deepEqual(ledger.record(initial,at(60),{name:'changed'}),{accepted:true,duplicate:true});
    assert.equal(ledger.status().events,1);assert.equal(ledger.status().error,'SOURCE_LEDGER_CAPACITY_REACHED');
    ledger.close();ledger=f.create(2);
    assert.deepEqual(ledger.record(fresh,at(60),metadata),{accepted:true,duplicate:false});
    assert.deepEqual(ledger.record(fresh,at(60),metadata),{accepted:true,duplicate:true});
    const history=ledger.history(target),first=history.items.find(item=>item.eventId===initial.sourceEventId)!,
      added=history.items.find(item=>item.eventId===fresh.sourceEventId)!;
    assert.equal(history.total,2);assert.equal(history.maxEvents,2);assert.equal(ledger.status().maxEvents,2);
    assert.equal(ledger.status().events,2);assert.equal(ledger.status().error,undefined);assert.equal(ledger.status().prunedEvents,0);
    assert.equal(first.firstObservedAt,at());assert.equal(first.name,'first');assert.equal(first.deliveryCount,2);
    assert.equal(added.firstObservedAt,at(60));assert.equal(added.deliveryCount,2);assert.deepEqual(added.txRefs,metadata.txRefs);
    assert.equal(ledger.record(signal('debot',60,'third',target)).reason,'SOURCE_LEDGER_CAPACITY_REACHED');
    ledger.close();ledger=f.create(1);
    assert.equal(ledger.status().events,2);assert.equal(ledger.record(initial,at(60)).duplicate,true);
    assert.equal(ledger.record(signal('debot',60,'third',target)).reason,'SOURCE_LEDGER_CAPACITY_REACHED');
  }finally{f.close();}
});

test('event budgets accept positive safe integers up to one million and reject invalid limits',()=>{
  for(const maxEvents of [0,-1,1.5,NaN,Infinity,-Infinity,1000001,Number.MAX_SAFE_INTEGER,'10' as never,null as never,false as never])
    assert.throws(()=>new SourceCorroboration(':memory:',{maxEvents}),/SOURCE_LEDGER_CONFIG_INVALID/);
  for(const maxEvents of [1,1000000]){
    const ledger=new SourceCorroboration(':memory:',{maxEvents});
    try{assert.equal(ledger.status().maxEvents,maxEvents);}finally{ledger.close();}
  }
});

test('notification activity uses mutually exclusive event-time five-minute buckets and an exclusive one-minute start',()=>{
  const f=fixture();try {
    const ledger=f.create();
    for(const seconds of [0,.001,299.999,300,300.001,540,540.001,600]){
      f.advance(seconds);assert.equal(ledger.record(signal('ave',seconds,`boundary-${seconds}`)).accepted,true);
    }
    const result=ledger.assess(token),activity=result.activity!;
    assert.equal(result.scoreEffect,0);assert.equal(result.researchOnly,true);
    assert.deepEqual(activity.sources,[{source:'ave',last1m:2,last5m:4,previous5m:3,change5m:1},
      {source:'debot',last1m:0,last5m:0,previous5m:0,change5m:0},{source:'gmgn',last1m:0,last5m:0,previous5m:0,change5m:0}]);
    assert.deepEqual(activity.windows,{last1m:{startExclusive:at(540),endInclusive:at(600)},
      last5m:{startExclusive:at(300),endInclusive:at(600)},previous5m:{startExclusive:at(),endInclusive:at(300)}});
    assert.equal(activity.bucketBy,'occurredAt');assert.equal(activity.historyComplete,false);
    assert.ok(activity.limitations.includes('ZERO_COUNT_DOES_NOT_PROVE_SOURCE_INACTIVE'));
  }finally{f.close();}
});

test('valid arrivals keep original event-time buckets; a replay or recording delay does not refresh activity',()=>{
  const f=fixture();try {
    const ledger=f.create();f.advance(400);
    assert.equal(ledger.record(signal('ave',300,'delayed'),at(400)).accepted,true); // Event exactly on previous-bucket end.
    f.advance(550);assert.equal(ledger.record(signal('ave',300,'delayed'),at(550)).duplicate,true);
    ledger.record(signal('debot',540,'recorded-later'),at(540));
    f.advance(600);const activity=ledger.assess(token).activity!;
    assert.deepEqual(activity.sources[0],{source:'ave',last1m:0,last5m:0,previous5m:1,change5m:-1});
    assert.deepEqual(activity.sources[1],{source:'debot',last1m:0,last5m:1,previous5m:0,change5m:1});
    assert.equal(ledger.history(token).items.find(row=>row.source==='ave')!.deliveryCount,2);
  }finally{f.close();}
});

test('activity excludes arrivals delayed over 120 seconds and future-dated originals even after the clock catches up',()=>{
  const f=fixture();try {
    const ledger=f.create();f.advance(300);
    ledger.record(signal('ave',180,'exact-delay'));ledger.record(signal('ave',179.999,'too-late'));
    ledger.record(signal('debot',301,'future'));
    f.advance(600);ledger.record(signal('debot',301,'future'));
    const activity=ledger.assess(token).activity!;
    assert.deepEqual(activity.sources[0],{source:'ave',last1m:0,last5m:0,previous5m:1,change5m:-1});
    assert.deepEqual(activity.sources[1],{source:'debot',last1m:0,last5m:0,previous5m:0,change5m:0});
    assert.equal(activity.maxArrivalDelaySec,120);
  }finally{f.close();}
});

test('later recordings and conflicts cannot rewrite activity known at an earlier as-of time',()=>{
  const f=fixture();try {
    const ledger=f.create();ledger.record(signal());f.advance(30);ledger.record(signal('debot',10),at(10));
    f.advance(40);ledger.record(signal(),at(40));f.advance(50);ledger.record(signal('ave',5),at(50));
    const historical=ledger.assess(token,new Date(at(20))).activity!;
    assert.deepEqual(historical.sources[0],{source:'ave',last1m:1,last5m:1,previous5m:0,change5m:1});
    assert.deepEqual(historical.sources[1],{source:'debot',last1m:0,last5m:0,previous5m:0,change5m:0});
    assert.equal(ledger.assess(token,new Date(at(49.999))).activity!.sources[0].last5m,1);
    const current=ledger.assess(token).activity!;
    assert.equal(current.sources[0].last5m,0);assert.equal(current.sources[1].last5m,1);
  }finally{f.close();}
});

test('exact activity is not truncated with reference samples and isolates sources, chains and full contract addresses',()=>{
  const f=fixture();try {
    const ledger=f.create();
    for(let i=0;i<80;i++){f.advance(i);ledger.record(signal('ave',i,`burst-${i}`));}
    ledger.record(signal('debot',79,'debot-good'));
    ledger.record(signal('ave',79,'other-token',other));
    ledger.record(signal('ave',79,'other-chain',{...token,chain:'robinhood'}));
    const result=ledger.assess(token),activity=result.activity!;
    assert.equal(activity.referenceSampleTruncated,true);assert.equal(activity.sources[0].last5m,80);
    assert.equal(activity.sources[0].last1m,60);assert.equal(activity.sources[1].last5m,1);
    assert.equal(activity.sources[2].last5m,0);assert.equal(ledger.assess(other).activity!.sources[0].last5m,1);
    assert.equal(ledger.assess({...token,chain:'robinhood'}).activity!.sources[0].last5m,1);
    assert.ok(activity.limitations.includes('REFERENCE_SAMPLE_LIMIT_DOES_NOT_TRUNCATE_ACTIVITY_COUNTS'));
  }finally{f.close();}
});

test('activity outside retained history reports unknown coverage rather than complete provider inactivity',()=>{
  const f=fixture();try {
    const ledger=f.create();ledger.record(signal());f.advance(30*86400+1);
    const historical=ledger.assess(token,new Date(at(20))).activity!;
    assert.equal(historical.sources[0].last5m,0);assert.equal(historical.historyComplete,false);
    assert.equal(historical.retainedFrom,at(1));assert.ok(historical.limitations.includes('ACTIVITY_WINDOW_OUTSIDE_RETENTION'));
    assert.equal(historical.counting,'exact_retained_events');assert.equal(historical.scope,'retained_valid_provider_events');
  }finally{f.close();}
});
