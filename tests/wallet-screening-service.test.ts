import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WalletHistory,type WalletTradeObservation} from '../src/wallet-history.js';
import {WalletProfiles,WalletProfileReader,type WalletProfile} from '../src/wallet-profiles.js';
import {WalletScreeningService} from '../src/wallet-screening-service.js';
import type {WalletAnalysis,WalletRecord} from '../src/research/wallet-types.js';
import type {GmgnResearch} from '../src/research.js';
import type {Signal,Report} from '../src/types.js';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import {decide} from '../src/engine.js';

const epoch=Date.parse('2026-10-13T00:00:00Z'),iso=(s:number)=>new Date(epoch+s*1000).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const token={chain:'bsc' as const,address:address(100)};
const signal:Signal={token,source:'gmgn',sourceEventId:'test-wallet-event',occurredAt:iso(900),claim:'unspecified',text:'',evidenceUrls:[]};
const trade=(wallet:number,at:number,patch:Partial<WalletTradeObservation>={}):WalletTradeObservation=>({chain:'bsc',wallet:address(wallet),tokenAddress:token.address,
  txHash:hash(wallet*10000+at),side:'buy',eventAt:iso(at),observedAt:iso(at+1),source:'gmgn_wallet_activity',amount:'200',amountUnit:'vendor_quantity',usd:'200',priceUsd:'1',...patch});
function wallet(n:number):WalletRecord {
  return {chain:'bsc',address:address(n),sources:['top_holders'],vendorLabels:{provider:'gmgn',verification:'vendor_claim',platform:[],token:[]},
    recognizedLabels:n===2?['kol']:[],vendorIdentity:{verification:'vendor_claim'},attribution:{status:'unknown',verification:'unverified'},
    holding:{amount:'200',usd:'200',supplyRatio:0.001,currentlyHolding:true},
    cumulative:{scope:'vendor_token_cumulative',recentInflow:false,buyVolumeUsd:'200',sellVolumeUsd:'0',buyCount:1,sellCount:0,firstAcquiredAt:iso(900),lastActiveAt:iso(900),exitedAt:null},
    funding:{address:null,label:null,verification:'vendor_claim',source:'unknown',amount:null,timestamp:null,txHash:null,sharedService:false,conflict:false},
    developerLinks:[],risks:[],clusterId:'wallet-'+n,enrichment:{status:'complete',reasons:[],activity:{scope:'token_activity_page',events:[],hasMore:false,
      firstAt:iso(800),lastAt:iso(995),recent:{since:iso(400),until:iso(995),coverage:'vendor_window_covered',buyUsd:'200',sellUsd:'0',netBuyUsd:'200',hasAccumulation:true}}}};
}
function research():GmgnResearch {
  const check={status:'pass' as const,checkedAt:iso(995),facts:{},reasons:[]};
  const wallets:WalletAnalysis={...check,wallets:[wallet(2),wallet(3),wallet(4)],clusters:[],
    summary:{token,sampleOnly:true,uniqueWalletCount:3,enrichedWalletCount:3,currentHolderCount:3,smartCurrentHolderCount:0,smartFundingClusterCount:0,smartIndependenceProven:false,
      eligibleSmartWalletCount:0,qualifiedSmartWalletCount:0,qualifiedSmartFundingClusterCount:0,recentWindowSeconds:600,recentNetBuyUsd:'600',hasRecentAccumulation:true,
      sampledHoldingRatio:0.003,cumulativeBuyUsd:'600',cumulativeSellUsd:'0',cumulativeCoverageWalletCount:3,cumulativeIsRecentInflow:false}};
  return {wallets,safety:check,flow:check,snapshot:{token,fetchedAt:iso(995),diagnostics:[{section:'info',status:'ok'}],
    info:{address:token.address,chain:'bsc',price:{price:'1.1'}}}};
}
function profile(n:number,profit=10000):WalletProfile {
  return {version:1,chain:'bsc',address:address(n),computedAt:iso(850),freshUntil:iso(2000),status:'current',source:'wallet_history',sampleOnly:true,ownership:'unknown',
    groups:[{id:'public_kol',firstObservedAt:iso(50),evidenceCount:3,reason:'vendor label'}],limitations:[],counterparties:[],
    metrics:{observedEvents:6,buyEvents:6,sellEvents:0,distinctTokens:3,associations:{leaders:0,distinctTokens:3,forwardTokens:0},chain:{transactions:0,transfers:0},
      vendorProfit:{realizedProfitUsd:String(profit),period:'7d',observedAt:iso(840),snapshotAt:iso(830),verification:'vendor_claim'}}};
}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'wallet-screening-service-')),historyPath=join(root,'history.sqlite'),profilePath=join(root,'profiles.sqlite'),ledgerPath=join(root,'setups.sqlite');
  let seconds=1000;const now=()=>new Date(iso(seconds));
  const history=new WalletHistory(historyPath,{now}),engine=new WalletProfiles({database:profilePath,historyDatabase:historyPath,now});engine.close();
  const db=new DatabaseSync(profilePath),reader=new WalletProfileReader(profilePath,now),written=new Map<string,WalletProfile>();
  const syncCohorts=()=>{
    const asOf=now().toISOString(),validUntil=new Date(now().getTime()+300_000).toISOString(),result:any={};
    for(const chain of ['bsc','solana','robinhood'] as const)result[chain]={asOf,validUntil,values:[...written.values()]
      .filter(p=>p.chain===chain&&p.groups.some(g=>g.id==='public_kol')).sort((a,b)=>b.computedAt.localeCompare(a.computedAt)).slice(0,2000).flatMap(p=>{
        const v=p.metrics.vendorProfit,n=Number(v?.realizedProfitUsd);return v?.verification==='vendor_claim'&&v.period==='7d'&&Number.isFinite(n)&&n>0&&
          v.snapshotAt<=v.observedAt&&Date.parse(v.observedAt)<=now().getTime()&&now().getTime()-Date.parse(v.snapshotAt)<=86_400_000?[n]:[];})};
    reader.replaceProfitCohorts(result);
  };
  const put=(p:WalletProfile)=>{
    db.prepare('INSERT OR REPLACE INTO wp_profiles(chain,address,computed_at,fresh_until,data) VALUES (?,?,?,?,?)').run(p.chain,p.address,p.computedAt,p.freshUntil,JSON.stringify(p));
    db.prepare('DELETE FROM wp_groups WHERE chain=? AND address=?').run(p.chain,p.address);
    for(const group of p.groups)db.prepare('INSERT INTO wp_groups VALUES (?,?,?,?)').run(p.chain,p.address,group.id,group.firstObservedAt);
    written.set(p.chain+':'+p.address,structuredClone(p));syncCohorts();
  };
  put(profile(2));for(let i=1;i<=9;i++)put(profile(10+i,i*1000));
  const service=new WalletScreeningService(history,reader,{database:ledgerPath,historyDatabase:historyPath,maxBytes:4*1024*1024,sourcePaths:[historyPath,profilePath]},now);
  return {root,historyPath,profilePath,ledgerPath,history,reader,service,put,now,advance:(n:number)=>{seconds=n;},
    close:async()=>{await service.close();reader.close();db.close();history.close();rmSync(root,{recursive:true,force:true});}};
}
async function waitFor(check:()=>boolean,timeoutMs=5000):Promise<void> {
  const deadline=Date.now()+timeoutMs;
  while(!check()){
    if(Date.now()>=deadline)throw new Error('WAIT_FOR_TIMEOUT');
    await new Promise<void>(resolve=>setTimeout(resolve,5));
  }
}
function entryReport(f:ReturnType<typeof fixture>,input=research(),profileSupport=true):Report {
  const checked={status:'pass' as const,checkedAt:f.now().toISOString(),facts:{},reasons:['TEST_CHECK_PASSED']};
  const config=readConfig({WALLET_SUPPORT_REQUIRED:'true',MAX_SIGNAL_AGE_SEC:'600'});
  const screened=profileSupport?f.service.assess(signal,input):undefined;
  return decide(signal,f.now().toISOString(),config,checked,checked,{...checked,evidence:[]},f.now(),'live','entry-recheck-fixture',input,screened);
}

test('entry revalidation reads newly collected sells and withdraws support while the original report is still valid',async()=>{
  const f=fixture();try{
    f.history.recordTrades([trade(2,900),trade(3,910),trade(4,920)]);const original=entryReport(f),frozen=structuredClone(original);
    assert.equal(original.buyEligible,true);assert.ok(original.flow?.reasons.includes('PROFILED_WALLET_SETUP_SUPPORTED'));
    assert.equal(f.service.revalidate(original).status,'pass');
    f.advance(1010);f.history.recordTrade(trade(2,1005,{side:'sell'}));assert.ok(Date.parse(original.validUntil)>f.now().getTime());
    const check=f.service.revalidate(original);assert.equal(check.status,'unknown');assert.ok(check.reasons.includes('WALLET_SETUP_SUPPORT_WITHDRAWN'));
    assert.deepEqual(original,frozen);assert.equal(f.service.ledger.list().items[0].review.status,'withdrawn');
  }finally{await f.close();}
});

test('missing current analysis or local evidence cannot reuse a frozen profiled pass',async t=>{
  const f=fixture();try{
    f.history.recordTrades([trade(2,900),trade(3,910),trade(4,920)]);const original=entryReport(f);assert.equal(original.buyEligible,true);
    for(const key of ['gmgn','wallets'] as const){
      const incomplete=structuredClone(original);delete incomplete[key];const check=f.service.revalidate(incomplete);
      assert.equal(check.status,'unknown',key);assert.ok(check.reasons.includes('WALLET_SETUP_SUPPORT_NOT_CURRENT'),key);
    }
    t.mock.method(f.history,'screeningEvidence',()=>({trades:[],truncated:false}));
    const check=f.service.revalidate(original);assert.equal(check.status,'unknown');assert.ok(check.reasons.includes('WALLET_SETUP_SUPPORT_NOT_CURRENT'));
  }finally{await f.close();}
});

test('a different currently supported public entry cannot replace the setup that originally authorized the report',async()=>{
  const f=fixture();try{
    f.put(profile(5));f.history.recordTrades([trade(2,900),trade(3,910),trade(4,920)]);
    const input=research();input.wallets.wallets.push(wallet(5));input.wallets.summary.uniqueWalletCount=4;input.wallets.summary.enrichedWalletCount=4;input.wallets.summary.currentHolderCount=4;
    const original=entryReport(f,input),expected=original.walletScreening!.setups.find(s=>s.status==='supported')!;
    assert.equal(expected.wallet,address(2));assert.equal(original.buyEligible,true);
    f.advance(1010);f.history.recordTrades([trade(2,1005,{side:'sell'}),trade(5,905,{observedAt:iso(1009)})]);
    const current=f.service.assess(signal,input),replacement=current.setups.find(s=>s.status==='supported');
    assert.equal(current.status,'supported');assert.equal(replacement?.wallet,address(5));assert.notEqual(replacement?.id,expected.id);
    const check=f.service.revalidate(original);assert.equal(check.status,'unknown');assert.ok(check.reasons.includes('WALLET_SETUP_SUPPORT_NOT_CURRENT'));
  }finally{await f.close();}
});

test('legacy wallet support tolerates absent profiles but is blocked by a qualified newly observed withdrawal',async()=>{
  const f=fixture();try{
    f.put(profile(20,500)); // Keep ten comparison wallets while the trigger profile is absent.
    f.history.recordTrades([trade(2,900),trade(3,910),trade(4,920)]);const original=entryReport(f,research(),false);
    assert.equal(original.buyEligible,true);assert.equal(original.walletScreening,undefined);assert.ok(!original.flow?.reasons.includes('PROFILED_WALLET_SETUP_SUPPORTED'));
    const absent=profile(2);absent.groups=[];f.put(absent);assert.equal(f.service.revalidate(original).status,'pass');
    f.put(profile(2));f.advance(1010);f.history.recordTrade(trade(2,1005,{side:'sell'}));
    const check=f.service.revalidate(original);assert.equal(check.status,'unknown');assert.ok(check.reasons.includes('WALLET_SETUP_SUPPORT_WITHDRAWN'));
  }finally{await f.close();}
});

test('service combines local history and current analysis into a durable public-entry opportunity',async()=>{
  const f=fixture();try{
    f.history.recordTrades([trade(2,900),trade(3,910)]);
    const input=research();input.wallets.wallets[2].enrichment.activity!.events.push({type:'buy',txHash:hash(40920),timestamp:iso(920),amount:'200',usd:'200'});
    const result=f.service.assess(signal,input);
    assert.equal(result.status,'supported');assert.equal(result.setups[0].route,'public_entry');assert.equal(result.setups[0].followers,2);
    assert.equal(result.setups[0].profit?.cohortSize,10);assert.equal(f.service.status().records,1);
    const stored=f.service.ledger.list().items[0];assert.equal(stored.registeredAt,iso(1000));assert.equal(stored.state,'direct_entry');
    assert.equal(stored.proof.trigger.priceUsd,'1');assert.equal(stored.proof.profit?.realizedProfitUsd,10000);
    // Analysis-only evidence does not invent an observation in the research source.
    assert.equal(f.history.screeningEvidence(token,f.now()).trades.length,2);
    f.service.assess(signal,input);assert.equal(f.service.status().records,1);
  }finally{await f.close();}
});

test('research target nomination reads local recent trade evidence without creating a setup or accepting signal text',async()=>{
  const f=fixture();try{
    assert.deepEqual(f.service.researchTargets({...signal,text:`KOL ${address(2)} bought this token`}).targets,[]);
    f.history.recordTrades([trade(2,900),trade(3,910)]);
    const targets=f.service.researchTargets(signal);
    assert.equal(targets.source,'local_observations');assert.deepEqual(targets.token,signal.token);
    assert.deepEqual(targets.targets.map(t=>t.address),[address(2)]);assert.equal(targets.targets[0].txHash,hash(20900));
    assert.equal(f.service.status().records,0,'nominating a request does not register a supported trading setup');
    assert.deepEqual(f.service.researchTargets({...signal,token:{...token,address:address(999)}}).targets,[]);
    f.advance(1601);assert.deepEqual(f.service.researchTargets(signal).targets,[]);
  }finally{await f.close();}
});

test('new current-analysis sell withdraws an existing registration without rewriting first proof',async()=>{
  const f=fixture();try{
    f.history.recordTrades([trade(2,900),trade(3,910),trade(4,920)]);f.service.assess(signal,research());
    const original=f.service.ledger.list().items[0].proof;
    f.advance(1010);const updated=research();updated.wallets.checkedAt=iso(1009);
    updated.wallets.wallets[0].enrichment.activity!.events.push({type:'sell',txHash:hash(99001),timestamp:iso(1005),amount:'10',usd:'10'});
    const result=f.service.assess(signal,updated);assert.equal(result.setups[0].status,'withdrawn');
    assert.equal(f.service.ledger.list().items[0].review.status,'withdrawn');assert.deepEqual(f.service.ledger.list().items[0].proof,original);
  }finally{await f.close();}
});

test('current-analysis activity is bound to its chain, CA and nonfuture snapshot timestamp',async()=>{
  const f=fixture();try{
    f.history.recordTrades([trade(2,900),trade(3,910)]);
    for(const variant of ['wrong_chain','wrong_ca','future'] as const){
      const input=research();input.wallets.wallets[2].enrichment.activity!.events.push({type:'buy',txHash:hash(40920),timestamp:iso(920),amount:'200',usd:'200'});
      if(variant==='wrong_chain')input.wallets.summary.token={chain:'robinhood',address:token.address};
      if(variant==='wrong_ca')input.wallets.summary.token={...token,address:address(999)};
      if(variant==='future')input.wallets.checkedAt=iso(1001);
      const result=f.service.assess(signal,input);assert.notEqual(result.status,'supported',variant);assert.ok(result.setups[0].followers<=1,variant);
      assert.ok(result.setups[0].reasons.includes('WALLET_CURRENT_HOLDING_COVERAGE_MISSING'),variant);
    }
  }finally{await f.close();}
});

test('raw conflicting vendor copies reach the screening model instead of only a canonical winner',async()=>{
  const f=fixture();try{
    f.history.recordTrades([trade(2,900),trade(3,910),trade(4,920)]);
    f.history.recordTrade(trade(2,900,{eventAt:iso(899),source:'gmgn_token_trades',observedAt:iso(990)}));
    const raw=f.history.screeningEvidence(token,f.now());assert.equal(raw.trades.filter(t=>t.wallet===address(2)).length,2);
    const result=f.service.assess(signal,research());assert.notEqual(result.status,'supported');assert.ok(result.reasons.includes('WALLET_SCREENING_CONFLICTING_EVENTS_EXCLUDED'));
    assert.equal(result.setups[0].status,'withdrawn');assert.equal(result.setups[0].priorityScore,0);
    assert.equal(f.service.status().records,0);
  }finally{await f.close();}
});

test('background observation advances registered opportunities and close stops its timer',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const f=fixture();let closed=false;
  try{
    f.history.recordTrades([trade(2,900),trade(3,910),trade(4,920)]);f.service.assess(signal,research());
    f.service.start();f.service.start();assert.equal(f.service.status().running,true);
    f.advance(1020);f.history.recordTrade(trade(2,1010,{side:'sell'}));t.mock.timers.tick(10000);
    await waitFor(()=>f.service.ledger.list().items[0].state==='reduced');
    assert.equal(f.service.ledger.list().items[0].state,'reduced');assert.equal(f.service.ledger.list().items[0].reduction?.eventAt,iso(1010));
    await f.close();closed=true;t.mock.timers.tick(30000);
  }finally{if(!closed)await f.close();t.mock.timers.reset();}
});

test('write-heavy opportunity refresh stays off the main loop and remains fairly retryable',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const f=fixture();let closed=false;
  try{
    f.history.recordTrades([trade(2,900),trade(3,910),trade(4,920)]);const screened=f.service.assess(signal,research());
    for(let i=1;i<110;i++){
      const copy=structuredClone(screened);copy.setups=[structuredClone(screened.setups[0])];copy.setups[0].trigger.txHash=hash(8_000_000+i);
      f.service.ledger.record(copy);
    }
    assert.equal(f.service.status().records,110);
    f.advance(1020);f.history.recordTrade(trade(2,1010,{side:'sell'}));
    t.mock.method(f.service.ledger,'observe',()=>{throw new Error('MAIN_THREAD_OBSERVE_CALLED');});
    f.service.start();const started=performance.now();t.mock.timers.tick(10000);const synchronousMs=performance.now()-started;
    assert.ok(synchronousMs<10,`timer callback blocked for ${synchronousMs.toFixed(1)}ms`);
    await waitFor(()=>Number(f.service.status().stateCounts.reduced??0)===100);
    await waitFor(()=>!f.service.status().observationWorker.inFlight);
    assert.equal(f.service.status().observationWorker.processedTokens,1);
    t.mock.timers.tick(10000);await waitFor(()=>Number(f.service.status().stateCounts.reduced??0)===110);
    assert.equal(f.service.status().error,undefined);
    await f.close();closed=true;
  }finally{if(!closed)await f.close();t.mock.timers.reset();}
});

test('a slow dispatched analysis does not block later observation ticks, and close awaits that analysis',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const f=fixture();let closed=false,dispatched=0,release:()=>void=()=>{};
  const deferred=new Promise<void>(resolve=>{release=resolve;});
  const flush=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));await new Promise<void>(resolve=>setImmediate(resolve));};
  try{
    f.history.recordTrades([trade(2,900),trade(3,910),trade(4,920)]);f.service.assess(signal,research());
    f.service.start(async()=>{dispatched++;await deferred;});t.mock.timers.tick(10000);await waitFor(()=>dispatched===1);assert.equal(dispatched,1);
    f.advance(1020);f.history.recordTrade(trade(2,1010,{side:'sell'}));t.mock.timers.tick(10000);await flush();
    await waitFor(()=>f.service.ledger.list().items[0].state==='reduced');assert.equal(dispatched,1);assert.equal(f.service.status().error,undefined);
    const closing=f.close().then(()=>{closed=true;});await flush();assert.equal(closed,false,'close must wait for the admitted analysis');
    release();await closing;t.mock.timers.tick(30000);await flush();assert.equal(dispatched,1);
  }finally{release();if(!closed)await f.close();t.mock.timers.reset();}
});

test('a deferred false dispatch is not recorded as an error or admitted signal and can be retried',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const f=fixture();let calls=0;
  const offsets:number[]=[];
  t.mock.method(f.history,'screeningWalletCandidates',(_now?:Date,offset=0)=>{offsets.push(offset);return [trade(2,900)];});
  const flush=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));await new Promise<void>(resolve=>setImmediate(resolve));};
  try{
    f.service.start(async()=>{calls++;return false;});t.mock.timers.tick(10000);await waitFor(()=>calls===1);
    assert.equal(calls,1);assert.equal(f.service.status().error,undefined);
    f.advance(1001);t.mock.timers.tick(10000);await waitFor(()=>calls===2);
    assert.equal(calls,2);assert.equal(f.service.status().error,undefined);assert.deepEqual(offsets,[0,40]);assert.equal(f.service.status().records,0);
  }finally{await f.close();t.mock.timers.reset();}
});

test('empty candidate pages still advance the discovery cursor',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const f=fixture();let calls=0;
  const offsets:number[]=[];
  t.mock.method(f.history,'screeningWalletCandidates',(_now?:Date,offset=0)=>{offsets.push(offset);return offset===0?[]:[trade(2,900)];});
  const flush=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));await new Promise<void>(resolve=>setImmediate(resolve));};
  try{
    f.service.start(async()=>{calls++;return true;});t.mock.timers.tick(10000);await waitFor(()=>offsets.length===1);assert.equal(calls,0);
    t.mock.timers.tick(10000);await waitFor(()=>calls===1);assert.equal(calls,1);assert.deepEqual(offsets,[0,40]);
  }finally{await f.close();t.mock.timers.reset();}
});

test('closing while observation yields cannot launch a new discovery analysis',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const f=fixture();let closed=false,calls=0;
  try{
    f.history.recordTrades([trade(2,900),trade(3,910),trade(4,920)]);f.service.assess(signal,research());
    f.service.start(async()=>{calls++;});t.mock.timers.tick(10000);
    await f.close();closed=true;assert.equal(calls,0);
  }finally{if(!closed)await f.close();t.mock.timers.reset();}
});

test('ledger source path collisions including symlink aliases are rejected before mutating source schemas',async()=>{
  const f=fixture();try{
    const alias=join(f.root,'history-alias.sqlite');symlinkSync(f.historyPath,alias);
    for(const path of [f.historyPath,join(f.root,'unused','..','history.sqlite'),alias])
      assert.throws(()=>new WalletScreeningService(f.history,f.reader,{database:path,historyDatabase:f.historyPath,maxBytes:1024*1024,sourcePaths:[f.historyPath,f.profilePath]},f.now),/MUST_BE_SEPARATE/);
    const raw=new DatabaseSync(f.historyPath,{readOnly:true});try{assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='wsl_setups'").get(),undefined);}finally{raw.close();}
  }finally{await f.close();}
});

test('history screening query bounds observations without merging copies or crossing chain and CA',async()=>{
  const f=fixture();try{
    f.history.recordTrades(Array.from({length:505},(_,i)=>trade(200+i,900,{observedAt:iso(901+i/1000)})));
    f.history.recordTrades([trade(3,900,{chain:'robinhood'}),trade(4,900,{tokenAddress:address(999)}),trade(5,-3000)]);
    const raw=f.history.screeningEvidence(token,f.now());assert.equal(raw.truncated,true);assert.equal(raw.trades.length,500);
    assert.ok(raw.trades.every(t=>t.chain==='bsc'&&t.tokenAddress===token.address));assert.ok(raw.trades.every(t=>Date.parse(t.observedAt)>=Date.parse(iso(-2600))));
    assert.equal(f.history.screeningEvidence({...token,address:'invalid'},f.now()).truncated,true);
  }finally{await f.close();}
});

test('profit cohort includes only same-chain public wallets with fresh positive supported vendor snapshots',async()=>{
  const f=fixture();try{
    for(const [n,edit] of [
      [40,(p:WalletProfile)=>{p.chain='robinhood';}],
      [41,(p:WalletProfile)=>{p.metrics.vendorProfit!.snapshotAt=iso(-90000);}],
      [42,(p:WalletProfile)=>{p.metrics.vendorProfit!.observedAt=iso(1001);}],
      [43,(p:WalletProfile)=>{p.metrics.vendorProfit!.snapshotAt=iso(841);}],
      [44,(p:WalletProfile)=>{p.metrics.vendorProfit!.realizedProfitUsd='-1';}],
      [45,(p:WalletProfile)=>{p.metrics.vendorProfit!.realizedProfitUsd='0';}],
      [46,(p:WalletProfile)=>{p.metrics.vendorProfit!.realizedProfitUsd='NaN';}],
      [47,(p:WalletProfile)=>{p.groups=[];}],
    ] as const){const p=profile(n,900000);edit(p);f.put(p);}
    const values=f.reader.profitCohort('bsc',f.now()).sort((a,b)=>a-b);assert.deepEqual(values,Array.from({length:10},(_,i)=>(i+1)*1000));
    assert.deepEqual(f.reader.profitCohort('robinhood',f.now()),[900000]);
    f.advance(90000);assert.deepEqual(f.reader.profitCohort('bsc',f.now()),[]);
  }finally{await f.close();}
});

test('screening disabled does not create its database or attach a provider',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wallet-screening-disabled-')),ledger=join(root,'setups.sqlite');
  const config=readConfig({WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'true',WALLET_SCREENING_ENABLED:'false',
    ORDERS_DATABASE_PATH:join(root,'orders.sqlite'),WALLET_HISTORY_DATABASE_PATH:join(root,'history.sqlite'),WALLET_PROFILES_DATABASE_PATH:join(root,'profiles.sqlite'),
    WALLET_SCREENING_DATABASE_PATH:ledger,SCAN_DATABASE_PATH:join(root,'scans.sqlite')});
  const runtime=createRuntime(config);try{
    assert.equal(runtime.walletScreening,undefined);assert.equal(runtime.providers.walletScreening,undefined);assert.equal(existsSync(ledger),false);assert.equal(runtime.orders.list().length,0);
  }finally{await runtime.close();rmSync(root,{recursive:true,force:true});}
});
