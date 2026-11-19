import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import type {Worker} from 'node:worker_threads';
import {WalletHistory,WALLET_PRICE_BUYER_PAGE_SQL,WALLET_PRICE_HIGH_WATER_SQL,type WalletTradeObservation} from '../src/wallet-history.js';
import {WalletPriceWriterRunner} from '../src/wallet-price-writer.js';

const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const now=Date.now(),at=(offset:number)=>new Date(now+offset).toISOString();
const token={chain:'bsc' as const,address:address(9_000)};
const trade=(n:number,wallet=n):WalletTradeObservation=>({chain:'bsc',wallet:address(wallet),tokenAddress:token.address,
  txHash:hash(n),side:'buy',eventAt:at(-20_000+n),observedAt:at(-10_000+n),source:'test_buy'});

function fileFixture(){const dir=mkdtempSync(join(tmpdir(),'wallet-price-writer-'));return {dir,path:join(dir,'history.sqlite')};}

test('price admission reads its indexed high-water before taking the WAL writer lock',()=>{
  const f=fileFixture(),history=new WalletHistory(f.path,{maxBytes:32*1024*1024,now:()=>new Date(now+10_000)}),
    concurrent=new WalletHistory(f.path,{maxBytes:32*1024*1024,now:()=>new Date(now+10_000)});
  try {
    history.recordTrade(trade(1));
    const db=(history as unknown as {db:DatabaseSync}).db,
      concurrentDb=(concurrent as unknown as {db:DatabaseSync}).db,
      plan=db.prepare(`EXPLAIN QUERY PLAN ${WALLET_PRICE_HIGH_WATER_SQL}`).all(token.chain,token.address)
        .map(row=>String(row.detail)).join('\n');
    assert.match(plan,/USING COVERING INDEX wh_events_token \(chain=\? AND token_address=\? AND side=\?\)/);
    assert.doesNotMatch(plan,/wh_events_side/);

    concurrentDb.exec('PRAGMA busy_timeout=1');
    const originalPrepare=db.prepare.bind(db);let concurrentWrite=false;
    db.prepare=((sql:string)=>{
      const statement=originalPrepare(sql);
      if(sql!==WALLET_PRICE_HIGH_WATER_SQL)return statement;
      return {get:(chain:string,tokenAddress:string)=>{
        // This fails with SQLITE_BUSY if admission has already opened BEGIN
        // IMMEDIATE around the historical high-water read.
        concurrent.recordTrade({...trade(2,2),tokenAddress:address(9_001)});concurrentWrite=true;
        return statement.get(chain,tokenAddress);
      }} as ReturnType<DatabaseSync['prepare']>;
    }) as DatabaseSync['prepare'];
    try {
      const result=history.admitPriceProjection(token,2,at(-1_000),'gmgn_token_info_sample');
      assert.equal(result.accepted,true);assert.equal(result.priceStored,true);assert.equal(concurrentWrite,true);
    } finally {db.prepare=originalPrepare;}
  } finally {concurrent.close();history.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('incremental projection uses bounded short batches and replay is idempotent',async()=>{
  const history=new WalletHistory(':memory:',{maxBytes:32*1024*1024,now:()=>new Date(now+10_000)});
  try{
    history.recordTrades(Array.from({length:5},(_,index)=>trade(index+1)));
    let yields=0;
    const first=await history.recordPriceIncremental(token,2,at(-1_000),'gmgn_token_info_sample',{
      batchSize:2,yieldBetweenBatches:async()=>{yields++;}});
    assert.deepEqual({accepted:first.accepted,stored:first.priceStored,events:first.buyerEventsScanned,
      projected:first.buyerWalletsProjected,batches:first.batches,stopped:first.stopped,capacity:first.capacityReached},
    {accepted:true,stored:true,events:5,projected:5,batches:3,stopped:false,capacity:false});
    assert.equal(yields,2);assert.equal(history.stats().prices,1);
    const replay=await history.recordPriceIncremental(token,2,at(-1_000),'gmgn_token_info_sample',{batchSize:2});
    assert.equal(replay.priceStored,false);
    assert.equal(replay.buyerEventsScanned,0);assert.equal(replay.buyerWalletsProjected,0);
    assert.equal(history.stats().prices,1);
    const db=(history as unknown as {db:DatabaseSync}).db;
    const high=Number(db.prepare('SELECT MAX(rowid) AS high FROM wh_events').get()!.high);
    const plan=db.prepare(`EXPLAIN QUERY PLAN ${WALLET_PRICE_BUYER_PAGE_SQL}`).all(token.chain,token.address,high,'',0,2)
      .map(row=>String(row.detail)).join('\n');
    assert.match(plan,/USING INDEX wh_events_token \(chain=\? AND token_address=\? AND side=\? AND event_at>\?\)/);
  }finally{history.close();}
});

test('a durable cursor resumes after an abrupt process exit when a new worker starts',async()=>{
  const f=fileFixture(),seed=new WalletHistory(f.path,{maxBytes:32*1024*1024,now:()=>new Date(now+10_000)});
  try{
    seed.recordTrades(Array.from({length:5},(_,index)=>trade(index+1)));
  }finally{seed.close();}
  const moduleUrl=new URL('../src/wallet-history.ts',import.meta.url).href;
  const script=`import {WalletHistory} from ${JSON.stringify(moduleUrl)};
    const history=new WalletHistory(${JSON.stringify(f.path)},{maxBytes:${32*1024*1024}});
    await history.recordPriceIncremental(${JSON.stringify(token)},2,${JSON.stringify(at(-1_000))},'gmgn_token_info_sample',{
      batchSize:2,yieldBetweenBatches:async()=>process.exit(23)});
    process.exit(0);`;
  const interrupted=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{timeout:10_000});
  assert.equal(interrupted.status,23,String(interrupted.stderr));
  const interruptedDb=new DatabaseSync(f.path);
  try{
    const row=interruptedDb.prepare("SELECT value FROM wh_meta WHERE key GLOB 'price_projection_job_v1:*'").get()!,
      job=JSON.parse(String(row.value));
    assert.ok(Number(job.cursorEventRowid)>0);assert.ok(Number(job.cursorEventRowid)<Number(job.highEventRowid));
  }finally{interruptedDb.close();}

  const writer=new WalletPriceWriterRunner({database:f.path,maxBytes:32*1024*1024,buyerBatchSize:1,restartDelayMs:10});
  try{
    writer.start();
    assert.equal(writer.status().recovering,true);
    assert.equal(writer.recordPrice(token,3,at(-500),'gmgn_token_info_sample'),true);
    assert.equal(await writer.stop(5_000),true,'stop must drain durable startup recovery before terminating the worker');
    assert.equal(writer.status().recovering,false);assert.equal(writer.status().restarts,0);
    const read=new WalletHistory(f.path,{maxBytes:32*1024*1024});
    try{
      const db=(read as unknown as {db:DatabaseSync}).db;
      assert.equal(Number(db.prepare("SELECT count(*) AS n FROM wh_meta WHERE key GLOB 'price_projection_job_v1:*'").get()!.n),0);
      for(let wallet=1;wallet<=5;wallet++){
        const gain=read.getWallet('bsc',address(wallet))!.wallet.gain!;
        assert.equal(gain.baselinePriceUsd,2);assert.equal(gain.latestPriceUsd,3);
      }
    }finally{read.close();}
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('a durable quote high-water excludes later backfills and a retracted pending event cannot be projected',async()=>{
  const f=fileFixture(),history=new WalletHistory(f.path,{maxBytes:32*1024*1024,now:()=>new Date(now+10_000)});
  try{
    history.recordTrades([trade(1,1),trade(2,2)]);
    let yielded=false;
    const result=await history.recordPriceIncremental(token,2,at(-1_000),'gmgn_token_info_sample',{
      batchSize:1,yieldBetweenBatches:async()=>{
        if(yielded)return;yielded=true;
        const concurrent=new WalletHistory(f.path,{maxBytes:32*1024*1024,now:()=>new Date(now+10_000)});
        try{
          concurrent.recordTrade({...trade(99,3),eventAt:at(-30_000),observedAt:at(-9_000)});
          assert.equal(concurrent.retractVerifiedTrade({chain:'bsc',wallet:address(2),txHash:hash(2),checkedAt:at(-500)}),true);
        }finally{concurrent.close();}
      }});
    assert.equal(result.stopped,false);assert.equal(result.buyerEventsScanned,1);
    assert.ok(history.getWallet('bsc',address(1))!.wallet.gain);
    assert.equal(history.getWallet('bsc',address(2))!.wallet.gain,undefined);
    assert.equal(history.getWallet('bsc',address(3))!.wallet.gain,undefined);
  }finally{history.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('a repeated wallet on a later page can supply the earlier eligible observation without being skipped',async()=>{
  const history=new WalletHistory(':memory:',{maxBytes:32*1024*1024,now:()=>new Date(now+10_000)}),wallet=address(77);
  try{
    history.recordTrades([
      {...trade(701,77),wallet,eventAt:at(-20_000),observedAt:at(-500)},
      {...trade(702,77),wallet,eventAt:at(-10_000),observedAt:at(-2_000)},
    ]);
    const result=await history.recordPriceIncremental(token,2,at(-1_000),'gmgn_token_info_sample',{batchSize:1});
    assert.deepEqual({events:result.buyerEventsScanned,projected:result.buyerWalletsProjected},{events:2,projected:1});
    assert.equal(history.getWallet('bsc',wallet)!.wallet.gain!.baselinePriceUsd,2);
  }finally{history.close();}
});

test('out-of-order quotes independently repair baseline, peak, latest, and the wallet best-gain metric',async()=>{
  const history=new WalletHistory(':memory:',{maxBytes:32*1024*1024,now:()=>new Date(now+10_000)}),wallet=address(88),
    second={chain:'bsc' as const,address:address(9_001)};
  try {
    history.recordTrades([{...trade(801,88),wallet},{...trade(802,88),wallet,tokenAddress:second.address}]);
    await history.recordPriceIncremental(token,2,at(-3_000),'gmgn_token_info_sample');
    await history.recordPriceIncremental(token,3,at(-1_000),'gmgn_token_info_sample');
    await history.recordPriceIncremental(token,10,at(-2_000),'dexscreener_token_pairs_sample');
    let gain=history.getWallet('bsc',wallet)!.gains.find(item=>item.tokenAddress===token.address)!;
    assert.deepEqual({baseline:gain.baselinePriceUsd,peak:gain.peakPriceUsd,latest:gain.latestPriceUsd,max:gain.maxGainPct},
      {baseline:2,peak:10,latest:3,max:400});
    await history.recordPriceIncremental(token,1,at(-4_000),'gmgn_token_info_sample');
    gain=history.getWallet('bsc',wallet)!.gains.find(item=>item.tokenAddress===token.address)!;
    assert.deepEqual({baseline:gain.baselinePriceUsd,peak:gain.peakPriceUsd,latest:gain.latestPriceUsd,max:gain.maxGainPct},
      {baseline:1,peak:10,latest:3,max:900});

    await history.recordPriceIncremental(second,1,at(-3_000),'gmgn_token_info_sample');
    await history.recordPriceIncremental(second,10,at(-1_000),'gmgn_token_info_sample');
    await history.recordPriceIncremental(token,20,at(-5_000),'gmgn_token_info_sample');
    const detail=history.getWallet('bsc',wallet)!;
    gain=detail.gains.find(item=>item.tokenAddress===token.address)!;
    assert.equal(gain.maxGainPct,0,'an earlier high baseline can reduce the token gain');
    assert.equal(detail.wallet.gain!.tokenAddress,second.address);
    assert.equal(detail.wallet.gain!.maxGainPct,900,'wallet metric must be reselected from all token gains');
  } finally {history.close();}
});

test('worker durably preserves distinct same-token quotes and drains before shutdown',async()=>{
  const f=fileFixture();
  const seed=new WalletHistory(f.path,{maxBytes:32*1024*1024});
  seed.recordTrades([trade(1,1),trade(2,2),trade(3,1)]);seed.close();
  const writer=new WalletPriceWriterRunner({database:f.path,maxBytes:32*1024*1024,buyerBatchSize:1,restartDelayMs:10});
  try{
    assert.equal(writer.recordPrice(token,1,at(-2_000),'gmgn_token_info_sample'),true);
    assert.equal(writer.recordPrice(token,2,at(-1_000),'gmgn_token_info_sample'),true);
    assert.equal(writer.status().pendingTargets,2);assert.equal(writer.status().coalesced,0);
    writer.start();assert.equal(await writer.flush(5_000),true);assert.equal(await writer.stop(),true);
    const status=writer.status();
    assert.equal(status.state,'stopped');assert.equal(status.recovering,false);assert.equal(status.completed,2);assert.equal(status.priceRowsStored,2);
    assert.equal(status.durableIngressAccepted,2);assert.equal(status.buyerEventsScanned,6);assert.equal(status.buyerWalletsProjected,4);
    const read=new WalletHistory(f.path,{maxBytes:32*1024*1024});
    try{
      assert.equal(read.stats().prices,2);
      assert.equal(read.getWallet('bsc',address(1))!.wallet.gain!.baselinePriceUsd,1);
      assert.equal(read.getWallet('bsc',address(1))!.wallet.gain!.maxGainPct,100);
      assert.equal(read.getWallet('bsc',address(2))!.wallet.gain!.baselinePriceUsd,1);
    }finally{read.close();}
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('durable admission resolves only after worker ingress commit and coalesced callers share that boundary',async()=>{
  const f=fileFixture(),writer=new WalletPriceWriterRunner({database:f.path,maxBytes:32*1024*1024,batchSize:1,restartDelayMs:10});
  try {
    const first=writer.recordPriceDurable(token,7,at(-1_000),'gmgn_token_info_sample');
    const second=writer.recordPriceDurable(token,7,at(-1_000),'gmgn_token_info_sample');
    let settled=false;void first.then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);
    assert.deepEqual(await first,{accepted:true});assert.deepEqual(await second,{accepted:true});
    assert.equal(writer.status().durableIngressAccepted,1);assert.equal(writer.status().coalesced,1);
    assert.equal(await writer.stop(5_000),true);
    const read=new WalletHistory(f.path,{maxBytes:32*1024*1024});
    try {assert.equal(read.stats().prices,1);}finally{read.close();}
  } finally {await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('durable admission waiters settle on terminal failure and forced stop',async()=>{
  const full=fileFixture(),fullWriter=new WalletPriceWriterRunner({database:full.path,maxBytes:16_384,restartDelayMs:10});
  try {
    assert.deepEqual(await fullWriter.recordPriceDurable(token,8,at(-1_000),'gmgn_token_info_sample'),
      {accepted:false,reason:'WALLET_PRICE_WRITE_FAILED'});
  } finally {await fullWriter.stop();rmSync(full.dir,{recursive:true,force:true});}

  const stopped=fileFixture(),stoppedWriter=new WalletPriceWriterRunner({database:stopped.path,maxBytes:32*1024*1024,restartDelayMs:10});
  try {
    const pending=stoppedWriter.recordPriceDurable(token,9,at(-1_000),'gmgn_token_info_sample');
    assert.equal(await stoppedWriter.stop(1),false);
    assert.deepEqual(await pending,{accepted:false,reason:'WALLET_PRICE_WRITER_UNAVAILABLE'});
  } finally {await stoppedWriter.stop();rmSync(stopped.dir,{recursive:true,force:true});}
});

test('concurrent price-writer stop calls share one final drain',async()=>{
  const f=fileFixture(),writer=new WalletPriceWriterRunner({database:f.path,maxBytes:32*1024*1024,restartDelayMs:10});
  try {
    assert.equal(writer.recordPrice(token,4,at(-1_000),'gmgn_token_info_sample'),true);
    const first=writer.stop(5_000),second=writer.stop(1);
    assert.strictEqual(first,second);assert.deepEqual(await Promise.all([first,second]),[true,true]);
    assert.equal(writer.status().state,'stopped');assert.equal(writer.status().durableIngressAccepted,1);
  } finally {await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('a queued middle peak survives backlog instead of being overwritten by the latest token quote',async()=>{
  const f=fileFixture(),seed=new WalletHistory(f.path,{maxBytes:32*1024*1024});
  seed.recordTrade(trade(1,1));seed.close();
  const writer=new WalletPriceWriterRunner({database:f.path,maxBytes:32*1024*1024,buyerBatchSize:1,restartDelayMs:10});
  try{
    assert.equal(writer.recordPrice(token,1,at(-3_000),'gmgn_token_info_sample'),true);
    assert.equal(writer.recordPrice(token,10,at(-2_000),'gmgn_token_info_sample'),true);
    assert.equal(writer.recordPrice(token,2,at(-1_000),'gmgn_token_info_sample'),true);
    writer.start();assert.equal(await writer.stop(5_000),true);
    const read=new WalletHistory(f.path,{maxBytes:32*1024*1024});
    try{
      const gain=read.getWallet('bsc',address(1))!.wallet.gain!;
      assert.equal(read.stats().prices,3);assert.equal(gain.baselinePriceUsd,1);
      assert.equal(gain.peakPriceUsd,10);assert.equal(gain.maxGainPct,900);assert.equal(gain.latestPriceUsd,2);
    }finally{read.close();}
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('worker-acknowledged ingress and its middle peak survive an abrupt runner process exit',async()=>{
  const f=fileFixture(),seed=new WalletHistory(f.path,{maxBytes:32*1024*1024});
  try {seed.recordTrades(Array.from({length:120},(_,index)=>trade(index+1,index+1)));}finally{seed.close();}
  const writerUrl=new URL('../src/wallet-price-writer.ts',import.meta.url).href;
  const script=`import {WalletPriceWriterRunner} from ${JSON.stringify(writerUrl)};
    const writer=new WalletPriceWriterRunner({database:${JSON.stringify(f.path)},maxBytes:${32*1024*1024},batchSize:3,buyerBatchSize:1});
    const token=${JSON.stringify(token)};
    writer.recordPrice(token,1,${JSON.stringify(at(-3_000))},'gmgn_token_info_sample');
    writer.recordPrice(token,10,${JSON.stringify(at(-2_000))},'gmgn_token_info_sample');
    writer.recordPrice(token,2,${JSON.stringify(at(-1_000))},'gmgn_token_info_sample');
    writer.start();
    const deadline=Date.now()+5000;
    const poll=()=>{if(writer.status().durableIngressAccepted===3)process.exit(23);
      if(Date.now()>deadline)process.exit(24);setImmediate(poll);};poll();`;
  const interrupted=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{timeout:10_000});
  assert.equal(interrupted.status,23,String(interrupted.stderr));
  const interruptedDb=new DatabaseSync(f.path);
  try {assert.ok(Number(interruptedDb.prepare("SELECT count(*) AS n FROM wh_meta WHERE key GLOB 'price_projection_job_v1:*'").get()!.n)>0);}
  finally {interruptedDb.close();}
  const writer=new WalletPriceWriterRunner({database:f.path,maxBytes:32*1024*1024,buyerBatchSize:8,restartDelayMs:10});
  try {
    assert.equal(await writer.stop(5_000),true);
    const read=new WalletHistory(f.path,{maxBytes:32*1024*1024});
    try {
      const gain=read.getWallet('bsc',address(1))!.wallet.gain!;
      assert.equal(read.stats().prices,3);assert.equal(gain.baselinePriceUsd,1);
      assert.equal(gain.peakPriceUsd,10);assert.equal(gain.maxGainPct,900);assert.equal(gain.latestPriceUsd,2);
    } finally {read.close();}
  } finally {await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('quote FIFO is bounded, coalesces only exact duplicates, and rejects writes after stop',async()=>{
  const f=fileFixture(),writer=new WalletPriceWriterRunner({database:f.path,maxBytes:32*1024*1024,
    maxPendingTargets:2,batchSize:1,restartDelayMs:10});
  const first={chain:'bsc' as const,address:address(9_001)},second={chain:'bsc' as const,address:address(9_002)},
    third={chain:'bsc' as const,address:address(9_003)};
  try{
    assert.equal(writer.recordPrice(first,1,at(-2_000),'gmgn_token_info_sample'),true);
    assert.equal(writer.recordPrice(second,1,at(-2_000),'gmgn_token_info_sample'),true);
    assert.equal(writer.recordPrice(third,1,at(-2_000),'gmgn_token_info_sample'),false);
    assert.equal(writer.recordPrice(first,1,at(-2_000),'gmgn_token_info_sample'),true);
    assert.equal(writer.recordPrice(first,3,at(-1_000),'gmgn_token_info_sample'),false);
    assert.deepEqual({pending:writer.status().pendingTargets,rejected:writer.status().rejectedCapacity,
      coalesced:writer.status().coalesced},{pending:2,rejected:2,coalesced:1});
    assert.equal(await writer.stop(5_000),true);
    assert.equal(writer.recordPrice(first,4,at(-500),'gmgn_token_info_sample'),false);
    assert.equal(writer.status().rejectedClosed,1);
    const read=new WalletHistory(f.path,{maxBytes:32*1024*1024});
    try{assert.equal(read.stats().prices,2);}finally{read.close();}
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('a shutdown drain timeout abandons bounded work without resurrecting it on worker exit',async()=>{
  const f=fileFixture(),writer=new WalletPriceWriterRunner({database:f.path,maxBytes:32*1024*1024,restartDelayMs:10});
  try{
    assert.equal(writer.recordPrice(token,1,at(-1_000),'gmgn_token_info_sample'),true);
    assert.equal(await writer.stop(1),false);
    await new Promise(resolve=>setTimeout(resolve,20));
    const status=writer.status();
    assert.equal(status.state,'stopped');assert.equal(status.pendingTargets,0);assert.equal(status.inFlight,0);
    assert.equal(status.droppedOnStop,1);assert.equal(status.unconfirmedOnStop,0);
    assert.equal(status.retainedRecoverableOnStop,0);assert.equal(status.closeError,'WALLET_PRICE_WRITER_STOP_TIMEOUT');
    assert.equal(status.durabilityBoundary,'worker_ack');assert.equal(status.durableInventoryUnconfirmedOnStop,false);
  }finally{await writer.stop();rmSync(f.dir,{recursive:true,force:true});}
});

test('a native-blocked worker has one termination request and cannot hold shutdown open',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fileFixture(),writer=new WalletPriceWriterRunner({database:f.path,maxBytes:32*1024*1024,workerTimeoutMs:100});
  class NativeBlockedWorker extends EventEmitter {
    terminateCalls=0;
    postMessage():void {}
    unref():void {}
    terminate():Promise<number>{this.terminateCalls++;
      return new Promise(resolve=>this.once('exit',()=>resolve(1)));}
  }
  const worker=new NativeBlockedWorker(),item={key:'blocked',sequence:1,target:token,priceUsd:1,
    observedAt:at(-1_000),provider:'gmgn_token_info_sample',attempts:0,enqueuedAt:Date.now()};
  const internal=writer as unknown as {
    worker:Worker;ready:boolean;state:string;inFlight:{id:number;items:(typeof item)[];startedAt:number};
    terminateWorker:(worker:Worker)=>Promise<void>;
  };
  internal.worker=worker as unknown as Worker;internal.ready=true;internal.state='ready';
  internal.inFlight={id:1,items:[item],startedAt:Date.now()-1_000};
  try {
    const terminations=Array.from({length:12},()=>internal.terminateWorker(worker as unknown as Worker));
    assert.ok(terminations.every(promise=>promise===terminations[0]));
    assert.equal(worker.terminateCalls,1);assert.equal(worker.listenerCount('exit'),1,
      'repeated watchdog ticks must not add Worker.terminate exit listeners');
    const stopping=writer.stop(1);
    t.mock.timers.tick(1);await new Promise<void>(resolve=>setImmediate(resolve));
    t.mock.timers.tick(3_000);assert.equal(await stopping,false);
    assert.equal(writer.status().state,'stopped');assert.equal(worker.terminateCalls,1,
      'the stop deadline must reuse an in-progress termination');
    assert.equal(worker.listenerCount('exit'),1,'the bounded stop listener must be removed after its deadline');
  } finally {t.mock.timers.reset();rmSync(f.dir,{recursive:true,force:true});}
});
