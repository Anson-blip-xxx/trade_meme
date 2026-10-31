import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readConfig} from '../src/config.js';
import {buildDailyReview,readDailyReviewInput,reviewSchedule,reviewWindow,shanghaiDate,type ReviewInput,type ReviewDecision,type ReviewNotification,type ReviewPrice} from '../src/daily-review.js';
const origin=Date.parse('2026-10-15T00:00:00.000Z'),at=(minutes=0)=>new Date(origin+minutes*60000).toISOString();
const cutoff='2026-10-16T01:00:00.000Z',address=(n=1)=>`0x${n.toString(16).padStart(40,'0')}`;
const token=(n=1)=>({chain:'bsc' as const,address:address(n)}),poolA=address(100),poolB=address(200);
const notify=(extra:Partial<ReviewNotification>={}):ReviewNotification=>({...token(),id:'event-1',source:'debot',receivedAt:at(),occurredAt:at(),...extra});
const price=(minutes:number,value:number,extra:Partial<ReviewPrice>={}):ReviewPrice=>({...token(),at:at(minutes),price:value,source:'dexscreener_pair',pool:poolA,...extra});
const decision=(extra:Partial<ReviewDecision>={}):ReviewInput['decisions'][number]=>({...token(),scanId:'scan-1',decision:'WATCH',at:at(1),policyVersion:'entry-gate-v9',buyEligible:false,
  reasons:['WALLET_SUPPORT_NOT_PASSED'],checks:{safety:{status:'pass',reasons:[]},provenance:{status:'pass',reasons:[]}},frozen:true,...extra});
const input=(extra:Partial<ReviewInput>={}):ReviewInput=>({date:'2026-10-15',asOf:cutoff,entryMode:'off',notifications:[notify()],decisions:[],prices:[],vendor:[],orders:[],executions:[],limitations:[],datasetComplete:true,...extra});

test('Shanghai calendar windows and 09:00 next run cross year boundaries precisely; invalid dates and unclosed days fail',()=>{
  assert.equal(shanghaiDate(new Date('2026-12-31T16:00:00.000Z')),'2027-01-01');
  assert.deepEqual(reviewWindow('2026-12-31'),{start:'2026-12-30T16:00:00.000Z',end:'2026-12-31T16:00:00.000Z'});
  assert.equal(reviewSchedule(new Date('2026-12-31T00:59:59.999Z')).nextRunAt,'2026-12-31T01:00:00.000Z');
  assert.equal(reviewSchedule(new Date('2026-12-31T01:00:00.000Z')).nextRunAt,'2027-01-01T01:00:00.000Z');
  assert.equal(reviewSchedule(new Date('2026-12-31T16:00:00.000Z')).timezone,'Asia/Shanghai');
  assert.deepEqual(reviewWindow('2028-02-29'),{start:'2028-02-28T16:00:00.000Z',end:'2028-02-29T16:00:00.000Z'});
  for(const value of ['2026-02-29','2026-02-30','2026-13-01','2026-1-01','bad'])assert.throws(()=>reviewWindow(value),/REVIEW_DATE_INVALID/);
  assert.throws(()=>buildDailyReview(input({asOf:'2026-10-15T15:59:59.999Z'})),/REVIEW_PERIOD_NOT_CLOSED/);
  assert.throws(()=>buildDailyReview(input({asOf:'bad'})),/REVIEW_PERIOD_NOT_CLOSED/);
});
test('event replays deduplicate, independent providers retain evidence, and each chain/CA contributes one cohort unit',()=>{
  const notifications=[notify(),notify(),notify({id:'event-2',receivedAt:at(1)}),notify({source:'ave',receivedAt:at(2)}),
    notify({chain:'robinhood',source:'ave'}),notify({id:'future',receivedAt:'2026-10-17T00:00:00.000Z'})];
  const review=buildDailyReview(input({notifications}));
  assert.equal(review.counts.signals,4);assert.equal(review.counts.tokens,2);assert.equal(review.learning.priorities.reduce((n,c)=>n+c.total,0),2);
  const bsc=review.items.find(i=>i.chain==='bsc')!;assert.equal(bsc.signalCount,3);assert.deepEqual(bsc.sources,['debot','ave']);
  assert.equal(review.learning.priorities.find(c=>c.chain==='bsc')!.total,1);
});
test('local flat prices do not hide a supplier 900 percent report; the two evidence scopes stay distinct',()=>{
  const review=buildDailyReview(input({prices:[price(1,1),price(2,1)],vendor:[{...token(),source:'debot',reportedAt:at(3),firstSignalAt:at(-60),maxGainPct:900,scope:'vendor_reported_retrospective'}]}));
  assert.equal(review.items[0].localPerformance?.maxGainPct,0);assert.deepEqual(review.items[0].highGain,{localObserved:false,vendorReported:true});
  assert.equal(review.counts.highGainers,1);assert.equal(review.counts.missedHighGainers,1);
  assert.equal(review.items[0].vendorPerformance[0].scope,'vendor_reported_retrospective');assert.match(review.items[0].evidence.join('\n'),/供应商回溯/);
});
test('the first valid post-signal quote fixes the comparison pool regardless of later sample counts',()=>{
  const prices=[price(5,1000,{pool:poolB}),price(1,1),price(4,1000,{pool:poolB}),price(2,2),price(3,1000,{pool:poolB}),price(6,1e9,{pool:undefined})];
  const review=buildDailyReview(input({prices}));assert.equal(review.items[0].localPerformance?.poolAddress,poolA);
  assert.equal(review.items[0].localPerformance?.baselineAt,at(1));assert.equal(review.items[0].localPerformance?.peakAt,at(2));
  assert.equal(review.items[0].localPerformance?.maxGainPct,100);assert.equal(review.items[0].localPerformance?.samples,2);
  const unknown=buildDailyReview(input({prices:[price(1,1,{pool:undefined}),price(2,1000,{pool:undefined,source:'trusted_followup'})]}));
  assert.equal(unknown.items[0].localPerformance,undefined);assert.equal(unknown.counts.withPerformance,0);assert.equal(unknown.learning.priorities[0].covered,0);
});
test('a repeated CA starts each report day from that day first signal and ignores older decisions, orders and prices',()=>{
  const historical=notify({id:'historical',receivedAt:at(-500),occurredAt:at(-500)}),today=notify({id:'today'});
  const oldDecision=decision({at:at(-499),scanId:'old',decision:'BUY_CANDIDATE',buyEligible:true,reasons:[]});
  const currentDecision=decision({at:at(1),scanId:'current',frozen:false});
  const review=buildDailyReview(input({notifications:[historical,today],decisions:[oldDecision,currentDecision],
    prices:[price(-499,0.01),price(1,10),price(2,20)],orders:[{...token(),at:at(-498),status:'filled',mode:'live'}]}));
  const item=review.items[0];assert.equal(item.firstReceivedAt,today.receivedAt);assert.equal(item.signalCount,1);
  assert.equal(item.firstDecision?.scanId,'current');assert.equal(item.latestDecision?.scanId,'current');
  assert.equal(item.localPerformance?.baselineAt,at(1));assert.equal(item.localPerformance?.maxGainPct,100);
  assert.equal(item.funnel.hasOrder,false);assert.equal(review.counts.entered,0);
});
test('Ave-only high multiples remain focus cases without inventing a percentage return',()=>{
  const review=buildDailyReview(input({notifications:[notify(),notify({...token(2),id:'second'})],prices:[price(1,1),price(2,1.2)],
    vendor:[{...token(2),source:'ave',reportedAt:at(3),maxGainValue:96,maxGainUnit:'provider_display_ratio',display:'96x',scope:'vendor_reported_retrospective'}]}));
  assert.equal(review.items[0].address,address(2));assert.equal(review.items[0].vendorPerformance[0].maxGainPct,undefined);
  assert.equal(review.items[0].highGain.vendorReported,true);assert.equal(review.counts.highGainers,1);assert.equal(review.counts.missedHighGainers,1);
  assert.equal(review.findings[0].count,1);
});
test('future and pre-reception quotes, malformed values and future evaluations cannot influence the snapshot',()=>{
  const review=buildDailyReview(input({prices:[price(-1,0.0001),price(1,10),price(2,9),price(1501,100000),price(3,0),price(4,Infinity)],
    decisions:[decision({at:at(1501),decision:'BUY_CANDIDATE',buyEligible:true})]}));
  assert.equal(review.items[0].localPerformance?.baselineAt,at(1));assert.equal(review.items[0].localPerformance?.maxGainPct,0);
  assert.equal(review.items[0].localPerformance?.samples,2);assert.equal(review.items[0].firstDecision,undefined);assert.equal(review.items[0].eligibility.observedEligible,false);
  assert.equal(review.items[0].localPerformance?.lastSampleAt,at(2));assert.equal(review.items[0].localPerformance?.trailingGapSec,(Date.parse(cutoff)-Date.parse(at(2)))/1000);
});
test('execution audit must match both scan ID and exact evaluated decision time',()=>{
  const d=decision({decision:'BUY_CANDIDATE',buyEligible:true,reasons:[]});
  const review=buildDailyReview(input({decisions:[d],prices:[price(1,1),price(10,3)],executions:[
    {...token(),at:at(1.1),decisionAt:d.at,scanId:d.scanId,mode:'off',status:'skipped',reason:'ENTRY_DISABLED'},
    {...token(),at:at(2.1),decisionAt:at(2),scanId:d.scanId,mode:'off',status:'skipped',reason:'ENTRY_NOT_CANDIDATE'},
    {...token(),at:at(3),decisionAt:d.at,scanId:'unrelated',mode:'off',status:'blocked',reason:'ENTRY_LIMIT'},
  ]}));
  assert.equal(review.items[0].funnel.stage,'execution_disabled');assert.equal(review.items[0].funnel.execution?.at,at(1.1));
  assert.equal(review.items[0].funnel.execution?.decisionAt,d.at);
  const unmatched=buildDailyReview(input({decisions:[d],executions:[{...token(),at:at(3),scanId:'other',mode:'off',status:'skipped',reason:'ENTRY_DISABLED'}]}));
  assert.equal(unmatched.items[0].funnel.stage,'eligible_no_entry_record');assert.equal(unmatched.items[0].funnel.execution,undefined);
});
test('first WATCH remains frozen while a later pre-peak candidate and its execution are reported',()=>{
  const first=decision(),later=decision({at:at(5),scanId:'later',decision:'BUY_CANDIDATE',buyEligible:true,reasons:[],frozen:false});
  const review=buildDailyReview(input({decisions:[later,first],prices:[price(1,1),price(10,3)],executions:[{...token(),at:at(5.1),decisionAt:later.at,scanId:later.scanId,mode:'off',status:'skipped',reason:'ENTRY_DISABLED'}]}));
  const item=review.items[0];assert.equal(item.firstDecision?.decision,'WATCH');assert.equal(item.latestDecision?.decision,'BUY_CANDIDATE');
  assert.deepEqual(item.eligibility,{observedEligible:true,firstEligibleAt:at(5),beforeObservedPeak:true});assert.equal(item.funnel.stage,'execution_disabled');
});
test('a post-peak safety verdict cannot be retroactively blamed for missing the earlier peak',()=>{
  const review=buildDailyReview(input({prices:[price(1,1),price(10,3),price(11,1)],decisions:[decision({at:at(15),decision:'REJECT',reasons:['TECHNICAL_SAFETY_NOT_PASSED'],checks:{safety:{status:'fail',reasons:['TEST_RISK']},provenance:{status:'pass',reasons:[]}}})]}));
  assert.equal(review.items[0].funnel.stage,'decision_after_peak');assert.ok(review.items[0].funnel.reasonCodes.includes('DECISION_AFTER_OBSERVED_PEAK'));
  const late=buildDailyReview(input({prices:[price(1,1),price(10,3)],decisions:[decision(),decision({at:at(15),decision:'BUY_CANDIDATE',buyEligible:true,frozen:false})]}));
  assert.equal(late.items[0].eligibility.beforeObservedPeak,false);assert.equal(late.items[0].funnel.stage,'wallet_support');
});
test('unsupported execution paths and incomplete analysis remain distinct from wallet strategy thresholds',()=>{
  for(const [reason,stage] of [['LAUNCHPAD_MODE_NOT_SUPPORTED','execution_path'],['ANALYSIS_DEADLINE_EXCEEDED','analysis_incomplete']]){
    const report=buildDailyReview(input({decisions:[decision({reasons:[reason,'WALLET_SUPPORT_NOT_PASSED']})]}));
    assert.equal(report.items[0].funnel.stage,stage);
  }
});
test('missing and delayed baselines stay outside covered counts; incomplete input remains explicit',()=>{
  const review=buildDailyReview(input({notifications:[notify(),notify({...token(2),id:'second'})],prices:[price(20,1),price(21,2)],datasetComplete:false,limitations:['SOURCE_TRUNCATED']}));
  const missing=review.items.find(i=>i.address===address(2))!;assert.equal(missing.localPerformance,undefined);
  assert.equal(review.items.find(i=>i.address===address())!.localPerformance?.baselineDelayed,true);
  assert.equal(review.learning.priorities[0].total,2);assert.equal(review.learning.priorities[0].covered,0);assert.equal(review.learning.priorities[0].missing,2);
  assert.equal(review.datasetComplete,false);assert.ok(review.limitations.includes('SOURCE_TRUNCATED'));
});
test('new latest decision revisions do not change frozen first evidence or mutate an already built snapshot',()=>{
  const first=decision(),original=input({decisions:[first],prices:[price(1,1),price(2,1)]}),inputBefore=JSON.stringify(original);
  const saved=buildDailyReview(original),savedBefore=JSON.stringify(saved);assert.equal(JSON.stringify(original),inputBefore);
  const later=buildDailyReview({...original,decisions:[decision({at:at(5),decision:'BUY_CANDIDATE',buyEligible:true,frozen:false}),first]});
  assert.deepEqual(later.items[0].firstDecision,saved.items[0].firstDecision);assert.equal(JSON.stringify(saved),savedBefore);
  assert.equal(later.items[0].latestDecision?.decision,'BUY_CANDIDATE');assert.equal(saved.items[0].latestDecision?.decision,'WATCH');
});
test('a stage assessed after the peak cannot become pre-peak evidence through an older quote timestamp',()=>{
  const late=buildDailyReview(input({prices:[price(1,1,{stage:'accelerating',score:80,assessedAt:at(4)}),price(2,3),price(3,1)]}));
  assert.equal(late.items[0].evidence.some(s=>s.includes('峰值前已留存的市场阶段')),false);
  const early=buildDailyReview(input({prices:[price(1,1,{stage:'accelerating',score:80,assessedAt:at(1.5)}),price(2,3)]}));
  assert.ok(early.items[0].evidence.some(s=>s.includes(`accelerating，${at(1.5)}`)));
});

function databases(){
  const dir=mkdtempSync(join(tmpdir(),'daily-review-'));const config=readConfig({});
  config.dashboard.archivePath=join(dir,'scans.sqlite');config.debotSignalsDatabase=join(dir,'debot.sqlite');config.ordersDatabase=join(dir,'orders.sqlite');
  config.ave={enabled:true,database:join(dir,'ave.sqlite'),sessionPath:join(dir,'session.json')};
  config.meme={enabled:true,database:join(dir,'meme.sqlite'),maxBytes:1048576,maxActive:10,activeWindowSec:7200};
  const reviewPath=join(dir,'review.sqlite');const handles:DatabaseSync[]=[];
  const open=(path:string,sql:string)=>{const db=new DatabaseSync(path);db.exec(sql);handles.push(db);return db;};
  const provider=(name:string)=>open(name==='debot'?config.debotSignalsDatabase:config.ave!.database,`CREATE TABLE ${name}_signals(id TEXT,chain TEXT,address TEXT,occurred_at TEXT,observed_at TEXT,state TEXT,reason TEXT,payload TEXT)`);
  const debot=provider('debot'),ave=provider('ave');
  const scans=open(config.dashboard.archivePath,'CREATE TABLE scan_summaries(received_at TEXT,record TEXT); CREATE TABLE signal_followups(registered_at TEXT,record TEXT)');
  const meme=open(config.meme.database,'CREATE TABLE meme_snapshots(chain TEXT,address TEXT,observed_at TEXT,source TEXT,market TEXT,assessment TEXT)');
  open(config.ordersDatabase,'CREATE TABLE opening_orders(chain TEXT,token_address TEXT,created_at TEXT,status TEXT,mode TEXT)');
  open(reviewPath,'CREATE TABLE review_entry_attempts(at TEXT,data TEXT)');
  const notifyDb=(n=1)=>debot.prepare('INSERT INTO debot_signals VALUES(?,?,?,?,?,?,?,?)').run(String(n),'bsc',address(n),at(),at(),'submitted',null,'{}');
  const quote=(n:number,minutes:number,value:number,assessedAt=at(minutes),overrides:Record<string,unknown>={})=>meme.prepare('INSERT INTO meme_snapshots VALUES(?,?,?,?,?,?)')
    .run('bsc',address(n),at(minutes),'dexscreener_pair',JSON.stringify({version:1,token:token(n),observedAt:at(minutes),priceUsd:value,poolAddress:poolA,...overrides}),JSON.stringify({assessedAt,stage:'accelerating',score:70}));
  return {dir,config,reviewPath,debot,ave,scans,meme,notifyDb,quote,read:()=>readDailyReviewInput(config,'2026-10-15',cutoff,reviewPath),close:()=>{for(const db of handles)db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('read adapter omits future evaluations from historical stage evidence and rejects foreign token prices',()=>{
  const f=databases();try{
    f.notifyDb();f.quote(1,-1000,999);f.quote(1,1,1);f.quote(1,2,2,at(1501));f.quote(1,1501,1000);f.quote(1,3,1000,at(3),{token:token(2)});
    const before=readFileSync(f.config.meme!.database),raw=f.read();
    assert.equal(raw.datasetComplete,true);assert.equal(raw.prices.length,2);assert.equal(raw.prices.find(p=>p.at===at(2))!.stage,undefined);
    assert.equal(raw.prices.some(p=>p.at===at(-1000)),false);
    assert.equal(raw.prices.find(p=>p.at===at(2))!.score,undefined);assert.equal(raw.prices.find(p=>p.at===at(1))!.stage,'accelerating');
    assert.deepEqual(readFileSync(f.config.meme!.database),before);const review=buildDailyReview(raw);assert.equal(review.items[0].localPerformance?.maxGainPct,100);
    assert.ok(review.items[0].evidence.filter(s=>s.includes('市场阶段')).every(s=>!s.includes(at(2))));
  }finally{f.close();}
});
test('read adapter retains first followup verdict independently of a later scan and does not invent pools for old charts',()=>{
  const f=databases();try{
    f.notifyDb();const first=decision(),latest=decision({at:at(5),decision:'BUY_CANDIDATE',buyEligible:true,frozen:false});
    f.scans.prepare('INSERT INTO scan_summaries VALUES(?,?)').run(at(),JSON.stringify({...token(),id:latest.scanId,source:'debot',mode:'live',receivedAt:at(),occurredAt:at(),evaluatedAt:latest.at,decision:latest.decision,buyEligible:true,policyVersion:latest.policyVersion,reasons:[],checks:latest.checks}));
    f.scans.prepare('INSERT INTO signal_followups VALUES(?,?)').run(at(),JSON.stringify({...token(),initial:{scanId:first.scanId,decision:first.decision,evaluatedAt:first.at,policyVersion:first.policyVersion,reasons:first.reasons,checks:first.checks,buyEligible:false},performance:{points:[{at:at(1),priceUsd:1},{at:at(2),priceUsd:100}]}}));
    const raw=f.read();assert.equal(raw.notifications.length,1);assert.equal(raw.prices.length,0);const review=buildDailyReview(raw);
    assert.equal(review.items[0].firstDecision?.decision,'WATCH');assert.equal(review.items[0].latestDecision?.decision,'BUY_CANDIDATE');assert.equal(review.items[0].localPerformance,undefined);
  }finally{f.close();}
});
test('missing expected source tables and exhausted scan read capacity mark the dataset incomplete',()=>{
  const f=databases();try{
    f.notifyDb();f.ave.exec('DROP TABLE ave_signals');let raw=f.read();assert.equal(raw.datasetComplete,false);assert.match(raw.limitations.join('\n'),/ave/);
    f.scans.exec('BEGIN');const insert=f.scans.prepare('INSERT INTO scan_summaries VALUES(?,?)');for(let i=0;i<20002;i++)insert.run(at(-10000),'{}');f.scans.exec('COMMIT');
    // Recent rows must still be read even when historical evidence exceeds the bounded import.
    f.scans.prepare('INSERT INTO scan_summaries VALUES(?,?)').run(at(),JSON.stringify({...token(2),id:'latest',source:'manual',mode:'live',receivedAt:at(),occurredAt:at(),evaluatedAt:at(1),decision:'WATCH',buyEligible:false,policyVersion:'v9',reasons:[],checks:{}}));
    raw=f.read();assert.equal(raw.datasetComplete,false);assert.ok(raw.notifications.some(n=>n.id==='latest'));
    assert.ok(raw.limitations.some(s=>s.includes('scan_summaries')));
  }finally{f.close();}
});
test('a source prune watermark intersecting the report day prevents complete-denominator learning',()=>{
  const f=databases();try{
    f.notifyDb();f.debot.exec('CREATE TABLE review_retention_watermarks(source TEXT PRIMARY KEY,pruned_through TEXT NOT NULL)');
    f.debot.prepare('INSERT INTO review_retention_watermarks VALUES(?,?)').run('debot',at(-1));
    const raw=f.read();assert.equal(raw.datasetComplete,false);assert.ok(raw.limitations.some(s=>s.includes('debot源库已修剪')));
    f.debot.prepare('UPDATE review_retention_watermarks SET pruned_through=?').run('2026-10-13T00:00:00.000Z');
    assert.equal(f.read().datasetComplete,true);
  }finally{f.close();}
});
test('price reads are bounded to the report window and only that window can exhaust the read limit',()=>{
  const f=databases();try{
    f.notifyDb();f.quote(1,1,1);f.quote(1,2,2);f.quote(1,1501,3);
    f.meme.exec(`WITH digits(value) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9))
      INSERT INTO meme_snapshots(chain,address,observed_at,source,market,assessment)
      SELECT 'bsc','${address(1)}','${at(-1000)}','dexscreener_pair','{}','{}'
      FROM digits a,digits b,digits c,digits d,digits e,digits g LIMIT 250001`);
    let raw=f.read();
    assert.equal(raw.datasetComplete,true);assert.deepEqual(raw.prices.map(p=>p.at).sort(),[at(1),at(2)]);
    f.meme.prepare("UPDATE meme_snapshots SET observed_at=? WHERE market='{}'").run(at(3));
    raw=f.read();assert.equal(raw.datasetComplete,false);
    assert.ok(raw.limitations.some(s=>s.includes('独立价格样本达到读取上限')));
  }finally{f.close();}
});
