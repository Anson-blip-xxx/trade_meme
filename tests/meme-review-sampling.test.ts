import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MemeObserver} from '../src/meme-observer.js';
import {buildReviewSamplingPlan,writeReviewSamplingPlan} from '../src/review-sampling.js';
import type {Signal} from '../src/types.js';
import type {MemeMarketSample} from '../src/meme-assessment.js';
const origin=Date.parse('2026-10-16T09:00:00.000Z'),at=(sec=0)=>new Date(origin+sec*1000).toISOString();
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const signal=(n:number,source:Signal['source']='debot',seconds=0):Signal=>({source,sourceEventId:`${n}-${seconds}`,token:{chain:'bsc',address:address(n)},occurredAt:at(seconds),text:'',claim:'unspecified',evidenceUrls:[]});
function fixture(maxActive=4){
  const dir=mkdtempSync(join(tmpdir(),'meme-plan-')),path=join(dir,'plan.json'),database=join(dir,'observer.sqlite');let seconds=100,fail=false;
  const calls:Signal['token'][][]=[],instances:MemeObserver[]=[];
  const create=()=>{const observer=new MemeObserver({database,samplingPlanPath:path,maxActive,activeWindowSec:86400,now:()=>new Date(at(seconds)),
    marketBatch:async tokens=>{calls.push(tokens);return fail?[]:tokens.map(token=>({version:1,token,observedAt:at(seconds),source:'dexscreener_pair',priceUsd:1,poolAddress:address(9999),windows:{}} satisfies MemeMarketSample));}});instances.push(observer);return observer;};
  const rows=(table:string)=>{const db=new DatabaseSync(database,{readOnly:true});try{return db.prepare(`SELECT * FROM ${table}`).all();}finally{db.close();}};
  const publish=(asOf=at())=>writeReviewSamplingPlan(path,buildReviewSamplingPlan({asOf,windowEndAt:new Date(Date.parse(asOf)-3600000).toISOString(),cohorts:[
    {chain:'bsc',source:'debot',total:100,covered:100},{chain:'bsc',source:'ave',total:100,covered:1}]}));
  return {path,database,create,publish,rows,calls,advance:(s:number)=>{seconds=s;},fail:()=>{fail=true;},close:async()=>{for(const o of instances)await o.close();rmSync(dir,{recursive:true,force:true});}};
}

test('fair old alerts and deficient cohorts share existing slots, with persistent forward-only selection audit',async()=>{
  const f=fixture();try{
    f.publish();const observer=f.create();for(let n=1;n<=8;n++)observer.register(signal(n,n<=6?'debot':'ave',n),at(n));
    assert.equal(observer.status().samplingPlan.status,'active');assert.equal(f.rows('meme_sampling_selections').length,0);
    await observer.runOnce();assert.deepEqual(new Set(f.calls[0].map(t=>t.address)),new Set([1,2,7,8].map(address)));
    const audits=f.rows('meme_sampling_selections');assert.equal(audits.length,4);
    assert.equal(audits.filter(r=>r.reason==='FAIR_ROTATION').length,2);assert.equal(audits.filter(r=>r.reason==='COVERAGE_DEFICIT').length,2);
    assert.ok(audits.every(r=>r.first_selected_at===at(100)));assert.equal(f.rows('meme_sampling_plans').length,1);
    const oldSnapshots=f.rows('meme_snapshots').map(r=>String(r.assessment));await observer.close();
    const restart=f.create();f.advance(131);await restart.runOnce();assert.ok(f.calls[1].some(t=>t.address===address(3)));
    assert.deepEqual(f.rows('meme_snapshots').slice(0,4).map(r=>String(r.assessment)),oldSnapshots);
    assert.equal(restart.detail({chain:'bsc',address:address(7)}).samplingAudit[0].firstSelectedAt,at(100));
    assert.deepEqual(restart.detail({chain:'bsc',address:address(7)},{asOf:at(99)}).samplingAudit,[]);
  }finally{await f.close();}
});
test('failed quote attempts rotate fair slots instead of trapping old targets forever',async()=>{
  const f=fixture(2);try{
    f.publish();f.fail();const observer=f.create();for(let n=1;n<=6;n++)observer.register(signal(n,n<=4?'debot':'ave',n),at(n));
    await observer.runOnce();f.advance(131);await observer.runOnce();f.advance(162);await observer.runOnce();f.advance(193);await observer.runOnce();
    const visited=new Set(f.calls.flat().map(t=>t.address));for(let n=1;n<=4;n++)assert.ok(visited.has(address(n)));
    assert.ok(f.calls.every(c=>c.length<=2));assert.equal(f.rows('meme_snapshots').length,0);assert.ok(f.rows('meme_sampling_selections').length>0);
  }finally{await f.close();}
});
test('missing, invalid, future and expired plans keep original latest-alert behavior and visible status',async()=>{
  for(const mode of ['missing','invalid','future','expired'] as const){
    const f=fixture(2);try{
      if(mode==='invalid')writeFileSync(f.path,'bad');if(mode==='future')f.publish(at(101));if(mode==='expired')f.publish(at(-48*3600));
      const observer=f.create();for(let n=1;n<=5;n++)observer.register(signal(n,'debot',n),at(n));
      assert.equal(observer.status().samplingPlan.status,mode);await observer.runOnce();
      assert.deepEqual(f.calls[0].map(t=>t.address),[address(5),address(4)]);assert.equal(f.rows('meme_sampling_selections').length,0);
    }finally{await f.close();}
  }
});
test('bounded candidate pools reach an old alert and a deficient alert beyond the first 600, without raising batch budgets',async()=>{
  const f=fixture(4);try{
    f.publish();const observer=f.create();for(let n=1;n<=1300;n++)observer.register(signal(n,n===1300?'ave':'debot',n/100),at(n/100));
    await observer.runOnce();const selected=f.calls[0].map(t=>t.address);
    assert.ok(selected.includes(address(1)));assert.ok(selected.includes(address(1300)));assert.equal(selected.length,4);
    assert.equal(observer.status().samplingPlan.candidateLimit,1200);
  }finally{await f.close();}
});
test('publication after a run changes subsequent selection only and original cadence is retained',async()=>{
  const f=fixture(4);try{
    const observer=f.create();for(let n=1;n<=8;n++)observer.register(signal(n,n===8?'ave':'debot',n),at(n));
    await observer.runOnce();assert.equal(f.rows('meme_sampling_selections').length,0);const original=f.rows('meme_snapshots').map(r=>String(r.assessment));
    f.publish(at(110));f.advance(130);await observer.runOnce();assert.equal(observer.status().samplingPlan.status,'active');
    assert.ok(f.rows('meme_sampling_selections').every(r=>String(r.first_selected_at)>=at(130)));
    assert.deepEqual(f.rows('meme_snapshots').slice(0,4).map(r=>String(r.assessment)),original);
    assert.ok(f.calls.every(c=>c.length<=4));const before=f.calls.length;await observer.runOnce();
    const again=f.calls.slice(before).flat();assert.ok(again.every(t=>!f.calls[before-1].some(p=>p.address===t.address)));
  }finally{await f.close();}
});
test('narrow active-set index preserves catalyst counts, detail evidence and selected pool metadata',async()=>{
  const f=fixture(4);try{
    f.publish();const observer=f.create();for(let n=1;n<=4;n++)observer.register(signal(n,'debot',n),at(n));
    const db=new DatabaseSync(f.database);try{
      const put=db.prepare('UPDATE meme_tokens SET catalyst=?,wallet_context=? WHERE address=?');
      for(let n=1;n<=3;n++)put.run(JSON.stringify({status:n===2?'unknown':'ready',observedAt:at(90),expiresAt:at(n===3?99:200),reasons:[],
        posts:[{text:'Retained detail evidence'}],sourceTweetCount:1,evidence:{requestedPostCount:1,retrievedPostCount:1}}),'W'.repeat(200000),address(n));
      const sql="SELECT chain,address,last_signal_at,first_seen_at,market_attempt_at,last_sample_at,catalyst_attempt_at,fallback_attempt_at,json_extract(signal,'$.source'),json_extract(catalyst,'$.status'),json_extract(catalyst,'$.expiresAt'),catalyst IS NULL FROM meme_tokens INDEXED BY meme_tokens_sampling WHERE last_signal_at>=? ORDER BY MAX(COALESCE(market_attempt_at,''),COALESCE(last_sample_at,'')),first_seen_at,chain,address LIMIT 600";
      assert.ok(db.prepare('EXPLAIN QUERY PLAN '+sql).all(at()).some(row=>String(row.detail).includes('USING COVERING INDEX meme_tokens_sampling')));
    }finally{db.close();}
    observer.recordMarket({version:1,token:signal(1).token,observedAt:at(90),source:'dexscreener_pair',priceUsd:2,poolAddress:address(8888),windows:{}});
    const status=observer.status();assert.equal(status.active,4);assert.equal(status.fresh,1);
    assert.equal(status.catalystFresh,1);assert.equal(status.catalystPending,1);assert.equal(status.catalystUnknown,1);assert.equal(status.catalystStale,1);
    const listed=observer.list().items.find(item=>item.address===address(1))!;assert.equal(listed.market?.priceUsd,2);assert.equal('catalyst' in listed?listed.catalyst?.status:undefined,'ready');
    const detail=observer.detail(signal(1).token);assert.equal((detail.token as any).catalyst.posts[0].text,'Retained detail evidence');
    await observer.runOnce();assert.equal((f.calls[0].find(token=>token.address===address(1)) as {poolAddress?:string}).poolAddress,address(8888));
  }finally{await f.close();}
});
test('catalyst scheduling loads the chosen signal and social context after selecting narrow candidates',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'meme-catalyst-plan-')),database=join(dir,'observer.sqlite'),path=join(dir,'plan.json');let captured:unknown;
  writeReviewSamplingPlan(path,buildReviewSamplingPlan({asOf:at(),windowEndAt:at(-1),cohorts:[{chain:'bsc',source:'debot',total:1,covered:0}]}));
  const observer=new MemeObserver({database,samplingPlanPath:path,now:()=>new Date(at(100)),marketBatch:async()=>[],catalyst:async(s,abort,context)=>{
    captured={signal:s,context};return {token:s.token,observedAt:at(100),expiresAt:at(200),status:'unknown'} as any;
  }});
  try {
    observer.register(signal(1),at());const context={token:signal(1).token,fetchedAt:at(1),diagnostics:[],info:{link:{twitter_username:'example'}}};
    const db=new DatabaseSync(database);try{db.prepare('UPDATE meme_tokens SET social_context=?').run(JSON.stringify(context));}finally{db.close();}
    await observer.runCatalystOnce();assert.deepEqual(captured,{signal:signal(1),context});assert.equal(observer.status().catalystUnknown,1);
  }finally{await observer.close();rmSync(dir,{recursive:true,force:true});}
});
test('byte-pressure recovery frees reusable pages before the row cap and allows new market samples',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'meme-space-')),database=join(directory,'observer.sqlite'),maxBytes=2*1024*1024;
  const observer=new MemeObserver({database,maxBytes,now:()=>new Date(at(100)),marketBatch:async tokens=>tokens.map(token=>({version:1,token,observedAt:at(100),source:'dexscreener_pair',priceUsd:1,poolAddress:address(9999),windows:{}}))});
  const db=new DatabaseSync(database);let seeded=0;
  const used=()=>Number(db.prepare('PRAGMA page_size').get()!.page_size)*(Number(db.prepare('PRAGMA page_count').get()!.page_count)-Number(db.prepare('PRAGMA freelist_count').get()!.freelist_count));
  try {
    const insert=db.prepare("INSERT INTO meme_snapshots(chain,address,observed_at,source,fingerprint,market,assessment) VALUES('bsc',?,?,'dexscreener_pair',?,NULL,?)");
    while(used()<maxBytes*0.85){insert.run(address(9000),at(seeded/100),`pressure-${seeded}`,JSON.stringify({padding:'X'.repeat(1800)}));seeded++;}
    assert.ok(seeded<250000);const initialPages=Number(db.prepare('PRAGMA page_count').get()!.page_count);
    observer.register(signal(1),at());await observer.runOnce();
    const deadline=Date.now()+5000;
    while(Date.now()<deadline&&!((observer.runtimeStatus().storage.maintenance?.value?.reclaimedSnapshots??0)>0))
      await new Promise(resolve=>setTimeout(resolve,20));
    await observer.runOnce();
    assert.equal(observer.status().storage.pressure,false);assert.ok(observer.status().storage.reclaimedSnapshots>0);
    assert.ok(observer.status().storage.usedBytes<=maxBytes*0.7);assert.equal(observer.status().fresh,1);
    assert.equal(Number(db.prepare('PRAGMA page_count').get()!.page_count),initialPages);
    assert.ok(Number(db.prepare('PRAGMA freelist_count').get()!.freelist_count)>0);
    assert.equal(db.prepare("SELECT 1 FROM meme_snapshots WHERE fingerprint='pressure-0'").get(),undefined);
  }finally{db.close();await observer.close();rmSync(directory,{recursive:true,force:true});}
});
test('startup recovery is bounded to ten thousand rows and pauses collection when other research data keeps space pressured',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'meme-space-bounded-')),database=join(directory,'observer.sqlite');let requests=0;
  const initial=new MemeObserver({database,maxBytes:32*1024*1024,now:()=>new Date(at(100)),marketBatch:async()=>[]});await initial.close();
  const db=new DatabaseSync(database);
  db.exec('BEGIN');try {
    const insert=db.prepare("INSERT INTO meme_snapshots(chain,address,observed_at,source,fingerprint,market,assessment) VALUES('bsc',?,?,'dexscreener_pair',?,NULL,?)");
    for(let n=0;n<11001;n++)insert.run(address(9000),at(n/1000),`bounded-${n}`,JSON.stringify({padding:'X'.repeat(400)}));
    db.prepare('INSERT INTO meme_meta VALUES(?,?)').run('retained-research', 'R'.repeat(900000));db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');db.close();rmSync(directory,{recursive:true,force:true});throw error;}
  const observer=new MemeObserver({database,maxBytes:1024*1024,now:()=>new Date(at(100)),marketBatch:async()=>{requests++;return [];}});
  try {
    assert.equal(observer.status().storage.reclaimedSnapshots,10000);assert.equal(observer.status().storage.pressure,true);
    assert.equal(Number(db.prepare('SELECT count(*) n FROM meme_snapshots').get()!.n),1001);
    await observer.runOnce();assert.equal(requests,0);assert.equal(observer.status().storage.pressure,true);
    assert.equal(observer.status().error,'MEME_OBSERVATION_STORAGE_PRESSURE');
    assert.equal(String(db.prepare("SELECT value FROM meme_meta WHERE key='retained-research'").get()!.value).length,900000);
  }finally{db.close();await observer.close();rmSync(directory,{recursive:true,force:true});}
});
test('row-budget maintenance skips deletion below the cap and removes only the oldest excess rows',async()=>{
  const f=fixture();try {
    const observer=f.create(),internal=observer as unknown as {db:DatabaseSync;trimRows:(table:'meme_snapshots',limit:number)=>void};
    const db=internal.db,insert=db.prepare("INSERT INTO meme_snapshots(chain,address,observed_at,source,fingerprint,market,assessment) VALUES('bsc',?,?,'dexscreener_pair',?,NULL,'{}')");
    for(let n=1;n<=4;n++)insert.run(address(1),at(n),`row-cap-${n}`);
    internal.trimRows('meme_snapshots',2);
    assert.deepEqual(db.prepare('SELECT fingerprint FROM meme_snapshots ORDER BY id').all().map(row=>row.fingerprint),['row-cap-3','row-cap-4']);
    const original=db.prepare.bind(db);db.prepare=((sql:string)=>{if(sql.startsWith('DELETE FROM meme_snapshots'))throw new Error('UNNECESSARY_CAP_DELETE');return original(sql);}) as typeof db.prepare;
    try{internal.trimRows('meme_snapshots',2);}finally{db.prepare=original;}
  }finally{await f.close();}
});
