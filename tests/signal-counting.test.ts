import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {generateKeyPairSync} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {ThirdSignalEntryController} from '../src/third-signal-entry.js';
import type {Config} from '../src/config.js';
import type {ThirdSignalExecution} from '../src/third-signal-strategy.js';
import {OrderStore} from '../src/orders.js';
import {SignalCounting,readControlledOpeningIdentities} from '../src/signal-counting.js';
import {parseSignal} from '../src/types.js';
import {createRuntime} from '../src/runtime.js';
import {readConfig} from '../src/config.js';
import {ControlledTestJournal} from '../src/controlled-test/journal.js';
import type {TestRun} from '../src/controlled-test/types.js';
import {TelegramNotifier} from '../src/telegram-notifier.js';

const ca='0x'+'a'.repeat(40),mint=bs58.encode(Buffer.alloc(32,1)),wallet=bs58.encode(Buffer.alloc(32,2));
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'signal-counting-')),orders=new OrderStore(join(dir,'orders.sqlite'));
 const messages:{key:string;text:string}[]=[];
 const options={database:join(dir,'counting.sqlite'),controlledJournal:join(dir,'controlled.sqlite'),orders,
   enqueue:(message:{key:string;text:string})=>{messages.push(message);return true;}};
 return {dir,orders,messages,options,close:()=>{orders.close();rmSync(dir,{recursive:true,force:true});}};
}
let seq=0;
function observation(source:'debot'|'ave'='debot',address=ca,chain:'bsc'|'solana'='bsc') {
 const at=new Date().toISOString();
 return {id:String(++seq),signal:parseSignal({source,sourceEventId:`${source}:signal:${seq.toString(16).padStart(64,'0')}`,
   token:{chain,address},occurredAt:at,text:'test',claim:'unspecified',evidenceUrls:[]}),observedAt:at,
   alertMarketCapUsd:99000,marketCapTiming:'event_snapshot' as const,walletCount:0,addressCount:0,aliases:[]};
}
function solanaBatch(size=20,source:'debot'|'ave'='ave') {
 return Array.from({length:size},(_,index)=>observation(source,bs58.encode(Buffer.alloc(32,index+10)),'solana'));
}
function journal(path:string,invalid=false) {
 const db=new DatabaseSync(path);
 db.exec('CREATE TABLE controlled_test_runs(id TEXT,wallet TEXT,payload TEXT); CREATE TABLE controlled_test_operations(run_id TEXT,operation_key TEXT,payload TEXT)');
 const run={id:'old-closed',wallet,mint,phase:'complete',finalSnapshot:{tokenAmount:'0'}};
 const operation={runId:run.id,key:'buy',state:'unknown',body:{chain:'sol',from_address:wallet,output_token:invalid?'bad':mint}};
 db.prepare('INSERT INTO controlled_test_runs VALUES(?,?,?)').run(run.id,wallet,JSON.stringify(run));
 db.prepare('INSERT INTO controlled_test_operations VALUES(?,?,?)').run(run.id,'buy',JSON.stringify(operation));db.close();
}

test('simulation counts stay separate, send once, and never reserve or submit an order',()=>{
 const f=fixture(),s=new SignalCounting(f.options);try {
   assert.equal(s.status().running,false);s.observe(observation());assert.equal(s.status().events,0);
   s.control('start','web');
   for(let i=0;i<2;i++){s.observe(observation('debot'));s.observe(observation('ave'));}
   const event=observation('debot');assert.equal(s.observe(event)?.status,'candidate');
   assert.equal(s.observe(event)?.reason,'DUPLICATE_EVENT');
   assert.equal(s.observe(observation('ave'))?.reason,'GLOBAL_TOKEN_ALREADY_CLAIMED');
   s.tick();s.tick();assert.equal(f.messages.length,1);assert.match(f.messages[0].text,/未下实盘单/);
   assert.equal(f.orders.list().length,0);assert.equal(s.page().total,2);
   s.control('stop','tg');s.observe(observation());assert.equal(s.status().events,6);
   s.control('start','web');assert.equal(s.status().events,0);assert.equal(s.status().globalClaims,1);
 }finally{s.close();f.close();}
});

test('unverified DeBot cap stays unknown and a fourth alert cannot repair the third',()=>{
 const f=fixture(),s=new SignalCounting(f.options);try {
   s.control('start','web');s.observe(observation());s.observe(observation());
   assert.equal(s.observe({...observation(),marketCapTiming:'unverified'})?.reason,'THIRD_MARKET_CAP_UNKNOWN');
   s.observe(observation());assert.equal(s.status().candidates,0);assert.equal(f.messages.length,0);
 }finally{s.close();f.close();}
});

test('priority observation only acknowledges a durable strategy write',()=>{
 const f=fixture(),s=new SignalCounting(f.options);try {
   s.control('start','web');const event=observation();
   const original=s.strategy.observe.bind(s.strategy);let attempts=0;
   s.strategy.observe=((input:Parameters<typeof original>[0])=>{
     if(++attempts===1)throw Error('SQLITE_BUSY');
     return original(input);
   }) as typeof s.strategy.observe;
   assert.throws(()=>s.observePriority(event),/SQLITE_BUSY/);
   assert.equal(s.status().events,0);assert.equal(s.status().captureError,'SIGNAL_COUNTING_CAPTURE_FAILED');
   assert.equal(s.observePriority(event)?.status,'counted');
   assert.equal(s.status().events,1);assert.equal(s.status().captureError,undefined);
 }finally{s.close();f.close();}
});

test('priority page commits twenty ordered observations once and stays below the 100ms fast-path budget',()=>{
 const f=fixture(),s=new SignalCounting({...f.options,allowedChains:['solana']});try {
   s.control('start','web');const page=solanaBatch(),started=performance.now();
   const results=s.observePriorityBatch(page),elapsed=performance.now()-started;
   assert.equal(results.length,20);assert.ok(results.every(result=>result.status==='counted'));
   assert.equal(s.status().events,20);assert.ok(elapsed<100,`twenty-signal batch took ${elapsed.toFixed(1)}ms`);
   const db=new DatabaseSync(f.options.database,{readOnly:true});try {
     assert.deepEqual(db.prepare('SELECT event_id FROM third_signal_events ORDER BY rowid').all().map(row=>row.event_id),
       page.map(item=>item.signal.sourceEventId));
   }finally{db.close();}
 }finally{s.close();f.close();}
});

test('priority page rolls back every observation when a middle durable write fails',()=>{
 const f=fixture(),s=new SignalCounting({...f.options,allowedChains:['solana']});try {
   s.control('start','web');const page=solanaBatch(),failedId=page[9].signal.sourceEventId;
   const db=new DatabaseSync(f.options.database);try {db.exec(`CREATE TRIGGER reject_middle_count BEFORE INSERT ON third_signal_events
     WHEN NEW.event_id='${failedId}' BEGIN SELECT RAISE(ABORT,'TEST_BATCH_FAILURE'); END;`);}finally{db.close();}
   assert.throws(()=>s.observePriorityBatch(page),/TEST_BATCH_FAILURE/);
   assert.equal(s.status().events,0);assert.equal(s.status().groups,0);
   const repair=new DatabaseSync(f.options.database);try{repair.exec('DROP TRIGGER reject_middle_count');}finally{repair.close();}
   assert.equal(s.observePriorityBatch(page).length,20);assert.equal(s.status().events,20);
 }finally{s.close();f.close();}
});

test('twenty simultaneous third candidates batch claims once, dispatch exactly once, and finish below 100ms',async()=>{
 const f=fixture();let calls=0,notifications=0;
 const notifier=new TelegramNotifier(join(f.dir,'telegram.sqlite'),{token:'12345:TEST',chatId:'1'});
 const s=new SignalCounting({...f.options,executionMode:'live',allowedChains:['solana'],dispatchConcurrency:1,dispatchCapacity:32,
   onCandidate:async()=>{calls++;},
   enqueue:event=>{notifications++;const until=performance.now()+10;while(performance.now()<until){/* slow durable notifier */}
     return notifier.enqueue(event);}});try {
   s.control('start','tg');const pages=[solanaBatch(),solanaBatch(),solanaBatch()];
   // Reuse token identities while keeping each source event distinct.
   for(let index=1;index<3;index++)for(let item=0;item<pages[index].length;item++)
     pages[index][item]={...pages[index][item],signal:{...pages[index][item].signal,token:pages[0][item].signal.token}};
   s.observePriorityBatch(pages[0]);s.observePriorityBatch(pages[1]);
   const started=performance.now(),results=s.observePriorityBatch(pages[2]),elapsed=performance.now()-started;
   assert.equal(results.filter(result=>result.status==='candidate').length,20);
   assert.ok(elapsed<100,`twenty-candidate batch took ${elapsed.toFixed(1)}ms`);
   await s.waitForDispatches();assert.equal(calls,20);assert.equal(notifications,20);assert.equal(s.status().candidates,20);
   assert.ok(s.page({limit:20}).items.every(item=>item.dispatchState==='handled'));
   s.observePriorityBatch(pages[2]);await s.waitForDispatches();assert.equal(calls,20,'committed duplicate page cannot replay dispatch');
 }finally{s.close();await notifier.close();f.close();}
});

test('batch queue saturation is failed durably after source ACK and never replays the overflow candidate',async()=>{
 const f=fixture();let pages:ReturnType<typeof solanaBatch>[]=[];
 let release!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
 const s=new SignalCounting({...f.options,executionMode:'live',allowedChains:['solana'],dispatchConcurrency:1,dispatchCapacity:2,
   onCandidate:async()=>{calls++;if(calls===1)await gate;}});try {
   s.control('start','tg');pages=[solanaBatch(3),solanaBatch(3),solanaBatch(3)];
   for(let index=1;index<3;index++)for(let item=0;item<pages[index].length;item++)
     pages[index][item]={...pages[index][item],signal:{...pages[index][item].signal,token:pages[0][item].signal.token}};
   s.observePriorityBatch(pages[0]);s.observePriorityBatch(pages[1]);
   const started=performance.now(),results=s.observePriorityBatch(pages[2]),elapsed=performance.now()-started;
   assert.equal(results.filter(result=>result.status==='candidate').length,3);
   assert.ok(elapsed<100,`saturated candidate batch ACK took ${elapsed.toFixed(1)}ms`);
   assert.equal(calls,1,'only the available worker starts in the source stack');
   release();await s.waitForDispatches();assert.equal(calls,2);
   const windows=s.page({limit:20}).items;
   assert.equal(windows.find(item=>item.address===pages[2][2].signal.token.address)?.dispatchReason,'THIRD_SIGNAL_DISPATCH_QUEUE_FULL');
   s.observePriorityBatch(pages[2]);await s.waitForDispatches();assert.equal(calls,2,'durably failed overflow cannot replay');
 }finally{release();s.close();f.close();}
});

test('post-commit batch dispatch failure does not reject the source ACK or replay candidates',async()=>{
 const f=fixture();let calls=0;const s=new SignalCounting({...f.options,executionMode:'live',allowedChains:['solana'],
   onCandidate:async()=>{calls++;}});try {
   s.control('start','tg');const pages=[solanaBatch(),solanaBatch(),solanaBatch()];
   for(let index=1;index<3;index++)for(let item=0;item<pages[index].length;item++)
     pages[index][item]={...pages[index][item],signal:{...pages[index][item].signal,token:pages[0][item].signal.token}};
   s.observePriorityBatch(pages[0]);s.observePriorityBatch(pages[1]);
   const claim=s.strategy.claimDispatchBatch.bind(s.strategy);
   s.strategy.claimDispatchBatch=(()=>{throw Error('SQLITE_BUSY');}) as typeof s.strategy.claimDispatchBatch;
   assert.doesNotThrow(()=>s.observePriorityBatch(pages[2]));assert.equal(s.status().events,60);assert.equal(calls,0);
   s.strategy.claimDispatchBatch=claim;s.observePriorityBatch(pages[2]);await s.waitForDispatches();
   assert.equal(calls,0);assert.equal(s.status().events,60);assert.equal(s.status().candidates,20);
 }finally{s.close();f.close();}
});

test('Solana-only counting ignores disabled chains without erasing historical opening claims',()=>{
 const f=fixture(),s=new SignalCounting({...f.options,allowedChains:['solana']});try {
   s.strategy.markOpened({chain:'bsc',address:ca,recordId:'historical-bsc'});
   s.control('start','tg');
   for(let i=0;i<3;i++){
     assert.equal(s.observe(observation('debot')),undefined);
     assert.equal(s.observe(observation('ave')),undefined);
     s.observe(observation('debot',mint,'solana'));
   }
   assert.equal(s.status().events,3);assert.equal(s.status().groups,1);
   assert.equal(s.status().candidates,1);assert.equal(s.status().globalClaims,2);
   assert.deepEqual(s.status().activeChains,['solana']);assert.match(s.controlText(),/处理链：SOL\n/);
   assert.equal(f.messages.length,1);assert.match(f.messages[0].text,/SOL/);
 }finally{s.close();f.close();}
});

test('closed and uncertain controlled buys import into both permanent deny stores',()=>{
 const f=fixture();journal(f.options.controlledJournal);const s=new SignalCounting(f.options);try {
   assert.equal(readControlledOpeningIdentities(f.options.controlledJournal).length,1);
   assert.equal(s.status().globalClaims,1);s.control('start','web');
   s.observe(observation('ave',mint,'solana'));s.observe(observation('ave',mint,'solana'));
   assert.equal(s.observe(observation('ave',mint,'solana'))?.reason,'GLOBAL_TOKEN_ALREADY_CLAIMED');
   const result=f.orders.reserve({eventKey:'new',chain:'solana',tokenAddress:mint,mode:'live',wallet,
     inputToken:mint,inputAmount:'1',slippagePct:1,details:{}},1);
   assert.equal(result.created,false);assert.match(result.reason??'',/ALREADY|REENTRY/);
 }finally{s.close();f.close();}
});

test('unreadable historical identity blocks starting counts instead of bypassing permanent dedup',()=>{
 const f=fixture();journal(f.options.controlledJournal,true);const s=new SignalCounting(f.options);try {
   assert.equal(s.status().historyError,'SIGNAL_COUNTING_OPENING_HISTORY_UNAVAILABLE');
   assert.throws(()=>s.control('start','web'),/OPENING_HISTORY_UNAVAILABLE/);assert.equal(s.status().running,false);
 }finally{s.close();f.close();}
});

test('runtime source callbacks feed simulation before research while existing entry mode remains off',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'signal-counting-runtime-'));
 const config=readConfig({ENTRY_MODE:'off',GMGN_BACKGROUND_RESEARCH_ENABLED:'false',
   DASHBOARD_ENABLED:'false',WATCH_RECHECK_ENABLED:'false',EXIT_SHADOW_ENABLED:'false',CHAIN_STREAM_ENABLED:'false',
   WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'true',WALLET_SCREENING_ENABLED:'false',TOKEN_RANK_RESEARCH_ENABLED:'true',
   MEME_OBSERVER_ENABLED:'true',DEBOT_SCANNER_ENABLED:'true',AVE_SCANNER_ENABLED:'true',
   DEBOT_TRANSPORT:'anonymous_poll',SCANNER_CHAINS:'bsc',
   ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),
   DEBOT_SIGNALS_DATABASE_PATH:join(dir,'debot.sqlite'),DEBOT_SESSION_PATH:join(dir,'debot.json'),
   AVE_SIGNALS_DATABASE_PATH:join(dir,'ave.sqlite'),AVE_SESSION_PATH:join(dir,'ave.json'),
   SOURCE_EVIDENCE_DATABASE_PATH:join(dir,'source.sqlite'),MEME_DATABASE_PATH:join(dir,'meme.sqlite'),WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),
   WALLET_PROFILES_DATABASE_PATH:join(dir,'profiles.sqlite'),TOKEN_RANK_RESEARCH_DATABASE_PATH:join(dir,'rank.sqlite')});
 const runtime=createRuntime(config);try {
   runtime.signalCountingControl('start','web');
   assert.equal(runtime.walletIndexRunner?.snapshot().livePriority,true);
   assert.equal(runtime.walletProfiles?.status().livePriority,true);
   assert.equal(runtime.tokenRankResearch?.status().livePriority,true);
   assert.equal(runtime.memeObserver?.status().livePriority,true);
   assert.equal(runtime.memeObserver?.status().marketBatchLimit,1);
   for(let i=0;i<3;i++){
     runtime.debotScanner!.acceptPage({observations:[observation()],received:1,rejected:0});
     runtime.aveScanner!.acceptPage({observations:[observation('ave')],received:1,rejected:0});
   }
   assert.equal(runtime.signalCountingPage().status.events,6);
   assert.equal(runtime.signalCountingPage().status.candidates,1);
   assert.equal(runtime.orders.list().length,0);assert.equal(runtime.dashboardOverview().entryMode,'off');
   runtime.signalCountingControl('stop','web');
   assert.equal(runtime.walletIndexRunner?.snapshot().livePriority,false);
   assert.equal(runtime.walletProfiles?.status().livePriority,false);
   assert.equal(runtime.tokenRankResearch?.status().livePriority,false);
   assert.equal(runtime.memeObserver?.status().livePriority,false);
   assert.equal(runtime.memeObserver?.status().marketBatchLimit,30);
   runtime.debotScanner!.acceptPage({observations:[observation()],received:1,rejected:0});
   assert.equal(runtime.signalCountingPage().status.events,6);
 }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('runtime restart restores research pause before workers process a persisted active count run',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'signal-counting-priority-restart-'));
 const config=readConfig({ENTRY_MODE:'off',GMGN_BACKGROUND_RESEARCH_ENABLED:'false',SCANNER_ENABLED:'false',
   DASHBOARD_ENABLED:'false',WATCH_RECHECK_ENABLED:'false',EXIT_SHADOW_ENABLED:'false',CHAIN_STREAM_ENABLED:'false',
   DEBOT_SCANNER_ENABLED:'false',AVE_SCANNER_ENABLED:'false',MEME_OBSERVER_ENABLED:'true',
   WALLET_RESEARCH_ENABLED:'true',WALLET_PROFILES_ENABLED:'true',WALLET_SCREENING_ENABLED:'false',TOKEN_RANK_RESEARCH_ENABLED:'true',
   ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),
   WALLET_HISTORY_DATABASE_PATH:join(dir,'history.sqlite'),WALLET_PROFILES_DATABASE_PATH:join(dir,'profiles.sqlite'),
   SOURCE_EVIDENCE_DATABASE_PATH:join(dir,'sources.sqlite'),MEME_DATABASE_PATH:join(dir,'meme.sqlite'),
   TOKEN_RANK_RESEARCH_DATABASE_PATH:join(dir,'rank.sqlite')});
 let runtime=createRuntime(config);
 try {
   runtime.signalCountingControl('start','web');await runtime.close();
   runtime=createRuntime(config);assert.equal(runtime.signalCounting.status().running,true);
   runtime.start();
   assert.equal(runtime.memeObserver?.status().livePriority,true);
   assert.equal(runtime.memeObserver?.status().marketBatchLimit,1);
   const deadline=Date.now()+15_000;
   while(runtime.walletIndexRunner?.snapshot().workerLivePriority!==true||
     runtime.walletProfiles?.status().workerLivePriority!==true||runtime.tokenRankResearch?.status().workerLivePriority!==true){
     assert.ok(Date.now()<deadline,'research workers did not acknowledge restored live priority');
     await new Promise(resolve=>setTimeout(resolve,50));
   }
   assert.equal(runtime.walletProfiles?.status().inFlight,false);
   assert.equal(runtime.tokenRankResearch?.status().inFlight,false);
 } finally {await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('regular orders and controlled tests atomically share one real token claim in both directions',()=>{
 const f=fixture();const makeRun=(id:string):TestRun=>({id,wallet,mint,phase:'created',amountLamports:'10000000',
   maxDebitLamports:'12000000',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
   reasons:[],automaticTriggerVerified:false,notificationKeys:[]});
 const guarded=(path:string)=>new ControlledTestJournal(path,{claimOpening:identity=>f.orders.claimExternalAttempt(identity)});
 let first:ControlledTestJournal|undefined,second:ControlledTestJournal|undefined;
 try {
   first=guarded(join(f.dir,'first.sqlite'));first.create(makeRun('first'));first.acquireLease('first','owner',10000);
   assert.equal(first.beginOperation('first','buy',{output_token:mint},'owner').created,true);
   assert.equal(first.beginOperation('first','buy',{output_token:mint},'owner').created,false);
   assert.equal(f.orders.reserve({eventKey:'regular',chain:'solana',tokenAddress:mint,mode:'live',wallet,
     inputToken:mint,inputAmount:'1',slippagePct:1,details:{}},1).reason,'ASSET_REENTRY_BLOCKED');
   second=guarded(join(f.dir,'second.sqlite'));second.create(makeRun('second'));second.acquireLease('second','owner',10000);
   assert.throws(()=>second!.beginOperation('second','buy',{output_token:mint},'owner'),/TOKEN_ALREADY_OPENED/);
   assert.equal(second.operation('second','buy'),undefined);
   const other=bs58.encode(Buffer.alloc(32,3));f.orders.markPreviouslyOpened({chain:'solana',address:other,recordId:'previous-real-order'});
   const thirdRun={...makeRun('third'),wallet:bs58.encode(Buffer.alloc(32,4)),mint:other};
   second.create(thirdRun);second.acquireLease('third','owner',10000);
   assert.throws(()=>second!.beginOperation('third','buy',{output_token:other},'owner'),/TOKEN_ALREADY_OPENED/);
 }finally{first?.close();second?.close();f.close();}
});

test('runtime Solana scope is shared by the two sources, counter and balance settings',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'signal-sol-scope-'));
 const config=readConfig({ENTRY_MODE:'off',GMGN_BACKGROUND_RESEARCH_ENABLED:'false',
   DASHBOARD_ENABLED:'false',WATCH_RECHECK_ENABLED:'false',EXIT_SHADOW_ENABLED:'false',CHAIN_STREAM_ENABLED:'false',
   WALLET_RESEARCH_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',DEBOT_SCANNER_ENABLED:'true',AVE_SCANNER_ENABLED:'true',
   DEBOT_TRANSPORT:'anonymous_poll',SCANNER_CHAINS:'solana',
   ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),
   DEBOT_SIGNALS_DATABASE_PATH:join(dir,'debot.sqlite'),DEBOT_SESSION_PATH:join(dir,'debot.json'),
   AVE_SIGNALS_DATABASE_PATH:join(dir,'ave.sqlite'),AVE_SESSION_PATH:join(dir,'ave.json'),
   SOURCE_EVIDENCE_DATABASE_PATH:join(dir,'source.sqlite')});
 const runtime=createRuntime(config);try {
   runtime.signalCountingControl('start','web');
   for(let i=0;i<3;i++){
     const debot=[observation(),observation('debot',mint,'solana')];
     const ave=[observation('ave'),observation('ave',mint,'solana')];
     runtime.debotScanner!.acceptPage({observations:debot,received:2,rejected:0});
     runtime.aveScanner!.acceptPage({observations:ave,received:2,rejected:0});
   }
   const state=runtime.signalCountingPage();
   assert.deepEqual(state.status.activeChains,['solana']);assert.equal(state.status.events,6);
   assert.equal(state.total,2);assert.ok(state.items.every(item=>item.chain==='solana'));
   assert.deepEqual(runtime.dashboardOverview().settings.caps.map(c=>c.chain),['solana']);
   assert.equal(runtime.orders.list().length,0);
 }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('explicit live start dispatches exactly one fresh third event and retains permanent actual protection',async()=>{
 const f=fixture();let calls=0;const s:SignalCounting=new SignalCounting({...f.options,executionMode:'live',allowedChains:['solana'],
   onCandidate:async candidate=>{calls++;assert.equal(s.isActive(candidate),true);s.recordExecution(candidate,{status:'submitted',orderId:'order-1'});}});
 try {
   assert.equal(s.status().executionReady,true);assert.equal(s.status().executionEnabled,false);
   s.control('start','tg');assert.equal(s.status().mode,'live');assert.match(s.controlText(),/达标自动实盘买入/);
   for(let i=0;i<2;i++){s.observe(observation('debot',mint,'solana'));s.observe(observation('ave',mint,'solana'));}
   const third=observation('debot',mint,'solana');s.observe(third);s.observe(third);
   s.observe(observation('ave',mint,'solana'));await s.waitForDispatches();
   assert.equal(calls,1);assert.equal(s.page().items.find(x=>x.source==='debot')?.executionStatus,'submitted');
   assert.equal(s.page().items.find(x=>x.source==='debot')?.dispatchState,'handled');
   s.tick();assert.equal(calls,1);assert.equal(f.orders.list().length,0);
   assert.match(f.messages[0].text,/成交结果另行通知/);assert.doesNotMatch(f.messages[0].text,/下单成功|成交成功/);
 }finally{s.close();f.close();}
});

test('live dispatch starts in the source stack, bounds bursts, and durably rejects overflow without replay',async()=>{
 const f=fixture(),addresses=[mint,bs58.encode(Buffer.alloc(32,3)),bs58.encode(Buffer.alloc(32,4))];
 let release!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
 let s=new SignalCounting({...f.options,executionMode:'live',allowedChains:['solana'],dispatchConcurrency:1,dispatchCapacity:2,
   onCandidate:async()=>{calls++;if(calls===1)await gate;}});
 try {
   s.control('start','tg');
   for(const [index,address] of addresses.entries()){
     for(let n=0;n<3;n++)s.observe(observation('debot',address,'solana'));
     assert.equal(calls,index===0?1:1,'only the first callback starts while its worker is occupied');
   }
   const overflow=s.page({limit:20}).items.find(item=>item.address===addresses[2]);
   assert.equal(overflow?.dispatchState,'failed');assert.equal(overflow?.dispatchReason,'THIRD_SIGNAL_DISPATCH_QUEUE_FULL');
   release();await s.waitForDispatches();assert.equal(calls,2);
   assert.equal(s.page({limit:20}).items.find(item=>item.address===addresses[1])?.dispatchState,'handled');
   s.close();s=new SignalCounting({...f.options,executionMode:'live',allowedChains:['solana'],onCandidate:()=>{calls++;}});
   s.tick();await s.waitForDispatches();assert.equal(calls,2,'a durably failed overflow candidate is never replayed');
 }finally{s.close();f.close();}
});

test('waitForDispatches follows callbacks enqueued while an active callback is settling',async()=>{
 const f=fixture(),next=bs58.encode(Buffer.alloc(32,9));
 let releaseFirst!:()=>void,releaseSecond!:()=>void,secondStarted!:()=>void,calls=0;
 const firstGate=new Promise<void>(resolve=>{releaseFirst=resolve;});
 const secondGate=new Promise<void>(resolve=>{releaseSecond=resolve;});
 const started=new Promise<void>(resolve=>{secondStarted=resolve;});
 const s:SignalCounting=new SignalCounting({...f.options,executionMode:'live',allowedChains:['solana'],
   dispatchConcurrency:1,dispatchCapacity:4,onCandidate:async()=>{
     calls++;
     if(calls===1){await firstGate;for(let n=0;n<3;n++)s.observe(observation('debot',next,'solana'));return;}
     secondStarted();await secondGate;
   }});
 try {
   s.control('start','tg');for(let n=0;n<3;n++)s.observe(observation('debot',mint,'solana'));
   let settled=false;const waiting=s.waitForDispatches().then(()=>{settled=true;});
   releaseFirst();await started;await Promise.resolve();
   assert.equal(calls,2);assert.equal(settled,false,'wait must include work admitted while its original snapshot settles');
   releaseSecond();await waiting;assert.equal(settled,true);
   assert.ok(s.page({limit:20}).items.every(item=>item.dispatchState==='handled'));
 }finally{s.close();f.close();}
});

test('queued stop, synchronous throw, and ordinary callback return all settle without leaking dispatches',async()=>{
 const f=fixture(),queued=bs58.encode(Buffer.alloc(32,10)),thrown=bs58.encode(Buffer.alloc(32,11)),plain=bs58.encode(Buffer.alloc(32,12));
 let release!:()=>void,queuedCalls=0,plainCalls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
 const s=new SignalCounting({...f.options,executionMode:'live',allowedChains:['solana'],dispatchConcurrency:1,dispatchCapacity:4,
   onCandidate:candidate=>{
     if(candidate.address===mint)return gate;
     if(candidate.address===queued){queuedCalls++;return;}
     if(candidate.address===thrown)throw Error('THIRD_SIGNAL_SYNC_FAILURE');
     if(candidate.address===plain){plainCalls++;return;}
   }});
 const emit=(address:string)=>{for(let n=0;n<3;n++)s.observe(observation('debot',address,'solana'));};
 try {
   s.control('start','tg');emit(mint);emit(queued);s.control('stop','web');release();await s.waitForDispatches();
   assert.equal(queuedCalls,0);
   assert.equal(s.page({limit:20}).items.find(item=>item.address===queued)?.dispatchReason,'THIRD_SIGNAL_RUN_STOPPED');
   s.control('start','tg');emit(thrown);emit(plain);await s.waitForDispatches();
   const page=s.page({limit:20}).items;
   assert.equal(page.find(item=>item.address===thrown)?.dispatchReason,'THIRD_SIGNAL_SYNC_FAILURE');
   assert.equal(page.find(item=>item.address===plain)?.dispatchState,'handled');assert.equal(plainCalls,1);
   await s.waitForDispatches();
 }finally{s.close();f.close();}
});

test('deployment with live configuration neither upgrades a simulation run nor replays historical candidates',async()=>{
 const f=fixture();let s=new SignalCounting(f.options),calls=0;
 try {
   s.control('start','web');for(let i=0;i<3;i++)s.observe(observation('debot',mint,'solana'));
   const oldRun=s.status().runId;s.close();
   s=new SignalCounting({...f.options,executionMode:'live',onCandidate:()=>{calls++;}});
   s.tick();await s.waitForDispatches();assert.equal(calls,0);assert.equal(s.status().mode,'simulation');
   assert.equal(s.status().executionEnabled,false);assert.equal(s.status().configuredExecutionMode,'live');
   s.control('start','tg');assert.notEqual(s.status().runId,oldRun);assert.equal(s.status().events,0);
   for(let i=0;i<3;i++)s.observe(observation('debot',mint,'solana'));
   await s.waitForDispatches();assert.equal(calls,1);s.close();
   s=new SignalCounting({...f.options,executionMode:'live',onCandidate:()=>{calls++;}});
   s.tick();await s.waitForDispatches();assert.equal(calls,1);assert.equal(s.status().mode,'live');
 }finally{s.close();f.close();}
});

test('stop after immediate dispatch start and during asynchronous preparation fences new submissions',async()=>{
 for(const stopBeforeCallback of [true,false]) {
   const f=fixture();let submitted=0,prepared=0,release!:()=>void;
   const gate=new Promise<void>(resolve=>{release=resolve;});
   const s:SignalCounting=new SignalCounting({...f.options,executionMode:'live',onCandidate:async candidate=>{
     prepared++;await gate;if(!s.isActive(candidate))throw Error('THIRD_SIGNAL_RUN_STOPPED');submitted++;
   }});
   try {
     s.control('start','tg');for(let i=0;i<3;i++)s.observe(observation('debot',mint,'solana'));
     if(!stopBeforeCallback)await new Promise(resolve=>setImmediate(resolve));
     s.control('stop','web');release();await s.waitForDispatches();
     assert.equal(submitted,0);assert.equal(prepared,1);
     assert.equal(s.page().items[0].dispatchState,'failed');assert.equal(s.page().items[0].dispatchReason,'THIRD_SIGNAL_RUN_STOPPED');
     s.control('start','tg');for(let i=0;i<3;i++)s.observe(observation('debot',mint,'solana'));
     await s.waitForDispatches();assert.equal(submitted,0);assert.equal(s.status().candidates,0);
   }finally{s.close();f.close();}
 }
});

test('live callback failure is durable, sanitized, and not retried by ticks or restart',async()=>{
 const f=fixture();let calls=0;let s=new SignalCounting({...f.options,executionMode:'live',onCandidate:()=>{calls++;throw Error('secret bearer token');}});
 try {
   s.control('start','web');for(let i=0;i<3;i++)s.observe(observation());await s.waitForDispatches();
   assert.equal(s.page().items[0].dispatchReason,'THIRD_SIGNAL_ENTRY_CALLBACK_FAILED');
   assert.doesNotMatch(JSON.stringify(f.messages),/secret bearer token/);s.tick();s.close();
   s=new SignalCounting({...f.options,executionMode:'live',onCandidate:()=>{calls++;}});
   s.tick();await s.waitForDispatches();assert.equal(calls,1);assert.equal(s.page().items[0].dispatchState,'failed');
 }finally{s.close();f.close();}
});

test('live start requires a ready execution callback and notification failure cannot suppress dispatch',async()=>{
 const f=fixture();let ready=false,calls=0;const s:SignalCounting=new SignalCounting({...f.options,executionMode:'live',
   executionReady:()=>({ready,reason:'SOLANA_RPC_MISSING'}),onCandidate:()=>{calls++;},enqueue:()=>{throw Error('outbox unavailable');}});
 try {
   assert.equal(s.status().executionReady,false);assert.throws(()=>s.control('start','tg'),/SOLANA_RPC_MISSING/);
   assert.equal(s.status().running,false);ready=true;s.control('start','web');
   for(let i=0;i<3;i++)s.observe(observation());await s.waitForDispatches();assert.equal(calls,1);
 }finally{s.close();f.close();}
});

function integratedLive(f:ReturnType<typeof fixture>,mode:'confirmed'|'unknown'|'stop_during_quote'|'holder_risk_blocked'='confirmed') {
 const sol='So11111111111111111111111111111111111111112',signature=bs58.encode(Buffer.alloc(64,7));
 const key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString();
 const config:Config={...readConfig({}),entryMode:'off',scannerChains:['solana'],gmgnApiKey:'mock-live-counting',gmgnPrivateKey:key,
   rpc:{solana:'https://counting-rpc.test'},entryWallets:{solana:wallet},entryInputTokens:{solana:sol},entryBalanceBps:{solana:300},
   entryFeeReserves:{bsc:'1',solana:'10000000',robinhood:'1'},exitPolicy:{enabled:true,sellRatioType:'hold_amount',
     takeProfit:[{gainPct:100,sellPct:50}],stopLoss:{dropPct:60,sellPct:100}}};
 const state={posts:0,quotes:0,balanceReads:0};let s:SignalCounting;
 const fetcher:typeof fetch=async(input,init)=>{
   const url=new URL(String(input));
   if(url.origin==='https://counting-rpc.test') {
     const rpc=JSON.parse(String(init?.body));
     if(rpc.method==='getGenesisHash')return Response.json({jsonrpc:'2.0',id:rpc.id,result:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'});
     if(rpc.method==='getBalance'){state.balanceReads++;return Response.json({jsonrpc:'2.0',id:rpc.id,result:{context:{slot:12345},value:1000000000}});}
     throw Error('UNEXPECTED_RPC');
   }
   assert.equal(url.origin,'https://openapi.gmgn.ai');
   if(url.pathname==='/v1/trade/quote') {
     state.quotes++;if(mode==='stop_during_quote')s.control('stop','tg');
     return Response.json({code:0,data:{input_token:sol,output_token:mint,input_amount:url.searchParams.get('input_amount'),
       output_amount:'10000000',min_output_amount:'9500000',slippage:5}});
   }
   assert.equal(url.pathname,'/v1/trade/swap');assert.equal(init?.method,'POST');state.posts++;
   const body=JSON.parse(String(init?.body)),order=f.orders.list()[0];
   assert.equal(order.status,'submitting');assert.equal(f.orders.hasAttemptedOpening('solana',mint),true);
   assert.equal(s.page().items.find(x=>x.source==='debot')?.claimPhase,'actual_opened_imported');
   assert.equal(body.input_amount,'30000000');assert.deepEqual(body.condition_orders,[
     {order_type:'profit_stop',side:'sell',price_scale:'100',sell_ratio:'50'},
     {order_type:'loss_stop',side:'sell',price_scale:'60',sell_ratio:'100'}]);
   if(mode==='unknown')throw Error('simulated lost connection');
   return Response.json({code:0,data:{order_id:'mock-buy-1',status:'confirmed',state:30,hash:signature,strategy_order_id:'mock-protection-1',
     report:{input_token:sol,output_token:mint,input_amount:body.input_amount,output_amount:'10000000'}}});
 };
 const entry=new ThirdSignalEntryController(config,f.orders,{enabled:true,fetcher,isActive:candidate=>s.isActive(candidate),
   readHolderRisk:async address=>({provider:'gmgn',chain:'solana',address,checkedAt:new Date().toISOString(),values:{
     top10:{value:mode==='holder_risk_blocked'?'0.26':'0.1',sourceField:'security.top_10_holder_rate'},
     bundler:{value:'0.2',sourceField:'holders.bundler.holding_ratio',coverage:'complete'},
     ratTrader:{value:'0.15',sourceField:'holders.rat_trader.holding_ratio',coverage:'complete'},
   }})});
 s=new SignalCounting({...f.options,allowedChains:['solana'],executionMode:'live',executionReady:()=>entry.readiness(),
   onCandidate:async candidate=>{
     const result=await entry.consider(candidate),status=result.order?.status;
     const execution:ThirdSignalExecution={status:status==='confirmed'||status==='submitted'||status==='unknown'||status==='failed'?status:'blocked',
       orderId:result.order?.id,reason:result.reason,holderRisk:result.order?.details.entryHolderRisk};
     s.recordExecution(candidate,execution);
   }});
 const unsubscribe=f.orders.subscribe(order=>s.captureOrder(order));
 return {s,entry,state,cleanup:async()=>{await entry.stop();await s.waitForDispatches();unsubscribe();s.close();}};
}

test('new source notifications reach the real entry controller with persistent order lifecycle and one signed mocked swap',async()=>{
 const f=fixture(),i=integratedLive(f);
 try {
   i.s.control('start','tg');
   for(let n=0;n<3;n++){
     i.s.observe(observation('debot',mint,'solana'));
     i.s.observe(observation('ave',mint,'solana'));
   }
   await i.s.waitForDispatches();assert.equal(i.state.posts,1);assert.equal(i.state.balanceReads,2);
   const item=i.s.page().items.find(x=>x.source==='debot')!;
   assert.equal(item.executionStatus,'confirmed');assert.equal(item.executionOrderId,f.orders.list()[0].id);
   assert.equal(item.holderRisk?.status,'pass');assert.equal(item.holderRisk?.metrics.bundler.percentageText,'20');
   assert.equal(item.dispatchState,'handled');assert.equal(item.claimPhase,'actual_opened_imported');
   assert.equal(f.orders.list()[0].outputAmount,'10000000');
   i.s.control('stop','web');i.s.control('start','tg');
   for(let n=0;n<3;n++)i.s.observe(observation('ave',mint,'solana'));
   await i.s.waitForDispatches();assert.equal(i.state.posts,1);assert.equal(i.s.status().candidates,0);
 }finally{await i.cleanup();f.close();}
});

test('source-driven holder-risk rejection persists the exact reason and metrics without any quote or swap request',async()=>{
 const f=fixture(),i=integratedLive(f,'holder_risk_blocked');
 try {
   i.s.control('start','tg');for(let n=0;n<3;n++)i.s.observe(observation('debot',mint,'solana'));
   await i.s.waitForDispatches();
   assert.equal(i.state.quotes,0);assert.equal(i.state.posts,0);
   const item=i.s.page().items[0];assert.equal(item.executionStatus,'failed');
   assert.equal(item.executionReason,'ENTRY_HOLDER_RISK_TOP10_EXCEEDED');assert.equal(item.holderRisk?.status,'blocked');
   assert.equal(item.holderRisk?.metrics.top10.percentageText,'26');assert.equal(item.holderRisk?.metrics.top10.limitPct,25);
   assert.equal(item.executionOrderId,f.orders.list()[0].id);assert.equal(f.orders.list()[0].providerOrderId,undefined);
   assert.equal(f.orders.hasAttemptedOpening('solana',mint),false);
   for(let n=0;n<3;n++)i.s.observe(observation('ave',mint,'solana'));
   i.s.observe(observation('debot',mint,'solana'));await i.s.waitForDispatches();
   assert.equal(f.orders.list().length,1);assert.equal(i.state.posts,0);
 }finally{await i.cleanup();f.close();}
});

test('source-to-controller unknown execution remains permanently blocked and does not appear confirmed',async()=>{
 const f=fixture(),i=integratedLive(f,'unknown');
 try {
   i.s.control('start','web');for(let n=0;n<3;n++)i.s.observe(observation('debot',mint,'solana'));
   await i.s.waitForDispatches();assert.equal(i.state.posts,1);assert.equal(i.s.page().items[0].executionStatus,'unknown');
   assert.equal(f.orders.list()[0].status,'unknown');i.s.tick();
   for(let n=0;n<3;n++)i.s.observe(observation('ave',mint,'solana'));
   await i.s.waitForDispatches();assert.equal(i.state.posts,1);
 }finally{await i.cleanup();f.close();}
});

test('owner stop during a source-driven quote prevents swap while preserving truthful unsubmitted result',async()=>{
 const f=fixture(),i=integratedLive(f,'stop_during_quote');
 try {
   i.s.control('start','web');for(let n=0;n<3;n++)i.s.observe(observation('debot',mint,'solana'));
   await i.s.waitForDispatches();assert.equal(i.state.quotes,1);assert.equal(i.state.posts,0);
   const item=i.s.page().items[0];assert.equal(item.executionStatus,'failed');
   assert.equal(item.executionReason,'THIRD_ENTRY_RUN_STOPPED');assert.equal(i.s.status().running,false);
   assert.equal(f.orders.hasAttemptedOpening('solana',mint),false);assert.equal(f.orders.list()[0].status,'failed');
 }finally{await i.cleanup();f.close();}
});
