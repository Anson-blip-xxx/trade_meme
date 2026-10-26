import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,statSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WalletHistory} from '../src/wallet-history.js';
import {SourceCorroboration} from '../src/source-corroboration.js';
import {TokenRankResearch,TokenRankResearchReader} from '../src/token-rank-research.js';
import type {Chain,Signal} from '../src/types.js';

const BASE=Date.parse('2026-10-16T00:00:00Z'),at=(sec:number)=>new Date(BASE+sec*1000).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),tx=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const token=(n=900,chain:Chain='bsc')=>({chain,address:address(n)});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'token-rank-research-')),historyPath=join(dir,'history.sqlite'),out=join(dir,'derived.sqlite'),
    sourcePath=join(dir,'sources.sqlite'),memePath=join(dir,'meme.sqlite');let clock=100;
  const now=()=>new Date(at(clock)),history=new WalletHistory(historyPath,{now}),sources=new SourceCorroboration(sourcePath,{now});
  const meme=new DatabaseSync(memePath);meme.exec(`CREATE TABLE meme_catalysts(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,observed_at TEXT,data TEXT);
    CREATE INDEX meme_catalysts_token ON meme_catalysts(chain,address,observed_at DESC);
    CREATE TABLE meme_tokens(chain TEXT,address TEXT,name TEXT,symbol TEXT,PRIMARY KEY(chain,address));`);
  const workers:TokenRankResearch[]=[],readers:TokenRankResearchReader[]=[];
  const options={database:out,historyDatabase:historyPath,sourceDatabase:sourcePath,memeDatabase:memePath,now};
  const create=(patch:Partial<typeof options>&{maxBytes?:number}={})=>{const worker=new TokenRankResearch({...options,...patch});workers.push(worker);return worker;};
  const reader=()=>{const r=new TokenRankResearchReader(out,now);readers.push(r);return r;};
  const rank=(sec=60,n=900,place=1)=>history.captureTokenRanks('bsc',[{address:address(n),rank:place,interval:'1h',changeMetric:'1.5',changeUnit:'vendor_unspecified'}],{source:'gmgn_change1h_rank',observedAt:at(sec)});
  const buy=(who=1,event=40,observed=45,n=900,hash=who)=>history.recordTrade({chain:'bsc',wallet:address(who),tokenAddress:address(n),txHash:tx(hash),side:'buy',eventAt:at(event),observedAt:at(observed),source:'gmgn_wallet_activity',usd:'10'});
  const profit=(who=1,realized:string|null='50',unrealized:string|null='20',total:string|null='70',observed=90,n=900,source='gmgn_token_profit_rank')=>history.captureTokenTraders(token(n),[
    {address:address(who),rank:1,profitUsd:total,realizedProfitUsd:realized,unrealizedProfitUsd:unrealized,firstAcquiredAt:at(10),rankScope:source.includes('buy_volume')?'vendor_buy_volume_order':'vendor_profit_order'}],{source,observedAt:at(observed)});
  const post=(published=50,fetched=95,recorded=96,id='2100000000000000001',extra:Record<string,unknown>={})=>{
    const p={id:`x:${id}`,url:`https://x.com/example/status/${id}`,authorId:'12345',text:`Watching ${address(900)}`,provider:'fxembed',verification:'third_party',
      publishedAt:at(published),fetchedAt:at(fetched),mentionsExactCa:true,relation:'ca_mention',...extra};
    meme.prepare('INSERT INTO meme_catalysts(chain,address,observed_at,data) VALUES(?,?,?,?)').run('bsc',address(900),at(recorded),JSON.stringify({token:token(),posts:[p],supplier:{generatedAt:at(1)}}));
  };
  return {dir,historyPath,out,sourcePath,memePath,history,sources,meme,now,advance:(sec:number)=>{clock=sec;},create,reader,rank,buy,profit,post,
    close:()=>{for(const r of readers)r.close();for(const w of workers)w.close();meme.close();sources.close();history.close();rmSync(dir,{recursive:true,force:true});}};
}

test('rank research separates early transaction references, later backfills and supplier holding-start claims',()=>{
  const f=fixture();try{
    f.rank(60,900,3);f.rank(90,900,1);f.buy(1,40,45);f.buy(2,30,95);f.profit(1);f.profit(2,'-10','40','30');f.profit(3,'100','0','100');f.post();
    f.meme.prepare('INSERT INTO meme_tokens VALUES(?,?,?,?)').run('bsc',address(900),'Example','EX');
    f.advance(55);const sig:Signal={source:'debot',sourceEventId:'first',token:token(),occurredAt:at(50),text:'signal',evidenceUrls:[],claim:'unspecified'};
    f.sources.record(sig,at(55));f.advance(100);
    const worker=f.create();assert.equal(worker.runBatch().error,undefined);const r=f.reader(),detail=r.detail('bsc',address(900));
    assert.equal(detail.token?.firstRank.rank,3);assert.equal(detail.token?.firstRank.observedAt,at(60));assert.equal(detail.token?.latestRank.rank,1);
    assert.equal(detail.token?.name,'Example');assert.equal(detail.token?.firstSignal?.eventAt,at(50));assert.equal(detail.token?.firstSignal?.knownAt,at(55));
    assert.equal(detail.token?.caPost?.eventAt,at(50));assert.equal(detail.token?.caPost?.knownAt,at(96));
    const a=detail.items.find(w=>w.address===address(1))!,b=detail.items.find(w=>w.address===address(2))!,claim=detail.items.find(w=>w.address===address(3))!;
    assert.equal(a.entry?.verification,'vendor_transaction_reference');assert.equal(a.comparisons.rank.position,'before');assert.equal(a.comparisons.rank.knowledge,'observed_before_anchor');
    assert.equal(b.comparisons.rank.knowledge,'historical_backfill');assert.equal(b.comparisons.rank.deltaSec,-30);
    assert.equal(claim.entry,undefined);assert.equal(claim.comparisons.rank.position,'unknown');assert.equal(claim.pnl?.vendorFirstAcquiredAt,at(10));
    assert.equal(detail.token?.earliestEntry?.wallet,address(2));assert.equal(detail.token?.topRealized?.wallet,address(3));
    assert.equal(a.pnl?.realizedProfitUsd,50);assert.equal(a.pnl?.unrealizedProfitUsd,20);assert.equal(a.pnl?.totalProfitUsd,70);
    assert.equal(detail.token?.scoreEffect,0);assert.equal(worker.status().tradingEnabled,false);
  }finally{f.close();}
});

test('first local rank is found from retained history even when a new live rank is ingested first',()=>{
  const f=fixture();try{
    f.rank(20,900,17);const worker=f.create();f.advance(120);f.rank(110,900,1);
    worker.runBatch(6);const result=f.reader().detail('bsc',address(900));
    assert.equal(result.token?.firstRank.observedAt,at(20));assert.equal(result.token?.firstRank.rank,17);assert.equal(result.token?.latestRank.rank,1);
    const old=JSON.stringify(result.token?.firstRank);f.advance(150);f.rank(10,900,19);worker.runBatch(6);
    assert.equal(JSON.stringify(f.reader().detail('bsc',address(900)).token?.firstRank),old);
  }finally{f.close();}
});

test('bootstrap skips global historical trades while reading existing ranked-token evidence through indexes',()=>{
  const f=fixture();try{
    for(let n=1;n<=600;n++)f.buy(n,30,40,900,n);f.rank();f.profit();
    const worker=f.create(),status=worker.runBatch(20),r=f.reader();
    assert.equal(status.error,undefined);assert.equal(status.initialComplete,true);
    assert.equal(status.watermarks?.trade.initial,status.watermarks?.trade.live);
    assert.equal(status.bootstrap?.tradeHistoryMode,'indexed_per_ranked_token_sample');
    assert.ok(r.detail('bsc',address(900)).token!.entryCount>0);assert.equal(r.detail('bsc',address(900)).token!.coverage.truncated,true);
  }finally{f.close();}
});

test('a batch computes at most eight tokens and independent live arrivals progress during historical rank backfill',()=>{
  const f=fixture();try{
    for(let n=900;n<930;n++)f.rank(20,n,n-899);
    const worker=f.create();let status=worker.runBatch(12);assert.ok(status.processed!<=8);
    f.advance(130);f.rank(125,999,1);status=worker.runBatch(12);
    assert.ok(status.tokens!>=7);assert.ok(status.watermarks!.token_rank.live>status.watermarks!.token_rank.initial);
    for(let n=0;n<10;n++)worker.runBatch(100);
    assert.equal(f.reader().list({limit:100}).total,31);assert.equal(worker.status().initialComplete,true);
  }finally{f.close();}
});

test('as-of token and wallet pages stay fixed when later profit rows change ordering and new tokens arrive',()=>{
  const f=fixture();try{
    f.rank();f.buy(1);f.buy(2);f.profit(1,'10');f.profit(2,'20');const worker=f.create();worker.runBatch();const r=f.reader();
    const page=r.wallets({sort:'realized',limit:1});assert.equal(page.items[0].address,address(2));
    const old=r.detail('bsc',address(900));f.advance(130);f.profit(1,'500',null,'500',125);f.rank(120,901);f.profit(4,'1000',null,'1000',125,901);worker.runBatch();
    assert.equal(r.wallets({sort:'realized',limit:1}).items[0].address,address(4));
    const second=r.wallets({sort:'realized',limit:1,offset:1,asOf:page.asOf});assert.equal(second.total,2);assert.equal(second.items[0].address,address(1));
    assert.equal(second.items[0].realizedProfitUsd,10);assert.equal(r.list({asOf:page.asOf}).total,1);
    const pages=new DatabaseSync(`${f.out}.wallet-pages.sqlite`,{readOnly:true});
    try {assert.equal(Number(pages.prepare('SELECT count(*) AS n FROM tr_wallet_latest WHERE computed_at>?').get(page.asOf)!.n),2,
      'a pinned page only needs historical versions for wallets changed or added after its anchor');}finally{pages.close();}
    assert.deepEqual({...r.detail('bsc',address(900),{asOf:page.asOf}),now:old.now},old);
    const wallet=r.wallet('bsc',address(1),{asOf:page.asOf});assert.equal(wallet.total,1);assert.equal(wallet.items[0].pnl?.realizedProfitUsd,10);
  }finally{f.close();}
});

test('wallet page index migrates from append-only versions and keeps current ordering indexable',()=>{
  const f=fixture();try{
    f.rank();for(const who of [1,2,3]){f.buy(who);f.profit(who,String(who*10));}
    const first=f.create();first.runBatch();const published=f.reader().wallets({sort:'realized'}).asOf;first.close();
    for(const suffix of ['', '-wal', '-shm'])rmSync(`${f.out}.wallet-pages.sqlite${suffix}`,{force:true});
    const migrated=f.create(),r=f.reader(),page=r.wallets({sort:'realized'});
    assert.equal(page.asOf,published);assert.deepEqual(page.items.map(item=>item.address),[address(3),address(2),address(1)]);
    const firstPage=r.wallets({sort:'realized',limit:2}),secondPage=r.wallets({sort:'realized',limit:2,offset:2,asOf:firstPage.asOf});
    assert.deepEqual([...firstPage.items,...secondPage.items].map(item=>item.address),[address(3),address(2),address(1)]);
    const pages=new DatabaseSync(`${f.out}.wallet-pages.sqlite`,{readOnly:true});
    try {
      assert.equal(Number(pages.prepare('SELECT count(*) AS n FROM tr_wallet_latest').get()!.n),3);
      assert.equal(pages.prepare("SELECT value FROM tr_wallet_page_meta WHERE key='published_at'").get()!.value,published);
      const plan=pages.prepare(`EXPLAIN QUERY PLAN SELECT version_id FROM tr_wallet_latest INDEXED BY tr_wallet_latest_realized
        ORDER BY realized DESC NULLS LAST,early_count DESC,chain,address LIMIT 20`).all().map(row=>String(row.detail));
      assert.ok(plan.some(line=>line.includes('tr_wallet_latest_realized')));assert.ok(plan.every(line=>!line.includes('TEMP B-TREE')));
    }finally{pages.close();}
    const evidence=new DatabaseSync(f.out,{readOnly:true});
    try {
      evidence.prepare('ATTACH DATABASE ? AS wallet_pages').run(`${f.out}.wallet-pages.sqlite`);
      const plan=evidence.prepare(`EXPLAIN QUERY PLAN WITH selected AS MATERIALIZED (
          SELECT l.* FROM wallet_pages.tr_wallet_latest l ORDER BY l.realized DESC NULLS LAST,l.early_count DESC,l.chain,l.address LIMIT 20 OFFSET 1000)
        SELECT v.data FROM selected s JOIN tr_wallet_versions v ON v.id=s.version_id
        ORDER BY s.realized DESC NULLS LAST,s.early_count DESC,s.chain,s.address`).all().map(row=>String(row.detail));
      assert.ok(plan.some(line=>line.includes('tr_wallet_latest_realized')));assert.ok(plan.some(line=>line.includes('INTEGER PRIMARY KEY')));
    }finally{evidence.close();}
    f.advance(130);f.profit(1,'100',null,'100',125);migrated.runBatch();
    assert.equal(r.wallets({sort:'realized'}).items[0].address,address(1),'incremental publication updates ordering atomically');
  }finally{f.close();}
});

test('new rank observations advance token history and checkpoints without duplicating unchanged wallet evidence',()=>{
  const f=fixture();try{
    f.rank();f.buy(1);f.buy(2);f.profit(1,'10');f.profit(2,'20');const worker=f.create();worker.runBatch();
    const r=f.reader(),first=r.wallet('bsc',address(1)),db=new DatabaseSync(f.out,{readOnly:true});
    try{
      const counts=()=>['tr_token_versions','tr_wallet_token_versions','tr_wallet_versions'].map(table=>
        Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n));
      assert.deepEqual(counts(),[1,2,2]);
      f.advance(130);f.rank(125,900,2);const status=worker.runBatch();
      assert.equal(status.error,undefined);assert.equal(status.lastRunAt,at(130));assert.deepEqual(counts(),[2,2,2]);
      assert.equal(r.detail('bsc',address(900)).token?.latestRank.observedAt,at(125));
      assert.equal(r.wallet('bsc',address(1)).wallet?.computedAt,at(100),'an unchanged summary retains its first-known version time');
      assert.deepEqual(r.wallet('bsc',address(1)).items,first.items);
      assert.deepEqual({...r.wallet('bsc',address(1),{asOf:first.asOf}),now:first.now},first);
      f.advance(431);assert.equal(worker.runBatch().lastRunAt,at(431));assert.deepEqual(counts(),[2,2,2]);
    }finally{db.close();}
  }finally{f.close();}
});

test('wallet deduplication preserves losses, evidence times and conflicts while omitting unchanged summaries',()=>{
  const f=fixture();try{
    f.rank();f.buy();f.profit();const worker=f.create();worker.runBatch();const r=f.reader(),initial=r.wallet('bsc',address(1)),
      db=new DatabaseSync(f.out,{readOnly:true});
    try{
      const counts=()=>['tr_wallet_token_versions','tr_wallet_versions'].map(table=>
        Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n));
      assert.deepEqual(counts(),[1,1]);
      f.advance(130);f.profit(1,'-5','0','-5',125);worker.runBatch();assert.deepEqual(counts(),[2,2]);
      assert.equal(r.wallet('bsc',address(1)).wallet?.realizedProfitUsd,-5);
      assert.equal(r.wallet('bsc',address(1),{asOf:initial.asOf}).wallet?.realizedProfitUsd,50);
      f.advance(160);f.profit(1,'-5','0','-5',155);worker.runBatch();assert.deepEqual(counts(),[3,3]);
      assert.equal(r.wallet('bsc',address(1)).items[0].pnl?.observedAt,at(155),'same amounts with newer evidence are not duplicates');
      const sig:Signal={source:'debot',sourceEventId:'dedup-anchor',token:token(),occurredAt:at(50),text:'signal',evidenceUrls:[],claim:'unspecified'};
      f.advance(190);f.sources.record(sig,at(190));f.rank(185);worker.runBatch();assert.deepEqual(counts(),[4,3]);
      const anchored=r.wallet('bsc',address(1));assert.equal(anchored.items[0].comparisons.signal.anchor?.knownAt,at(190));
      assert.equal(anchored.items[0].comparisons.signal.position,'before');assert.equal(anchored.wallet?.computedAt,at(160));
      f.advance(220);f.sources.record({...sig,occurredAt:at(49)},at(220));f.rank(215);worker.runBatch();assert.deepEqual(counts(),[5,3]);
      const conflict=r.wallet('bsc',address(1));assert.equal(conflict.items[0].comparisons.signal.anchor?.status,'conflict');
      assert.equal(conflict.items[0].comparisons.signal.position,'unknown');
      assert.equal(r.wallet('bsc',address(1),{asOf:anchored.asOf}).items[0].comparisons.signal.position,'before');
      f.advance(250);f.buy(1,70,245,900,1);worker.runBatch();assert.deepEqual(counts(),[6,4]);
      const revoked=r.wallet('bsc',address(1));assert.equal(revoked.items[0].entry,undefined);assert.equal(revoked.wallet?.earlyTokenCount,0);
      assert.ok(revoked.items[0].limitations.includes('CONFLICTING_BUY_TIMESTAMPS_EXCLUDED'));
      assert.deepEqual({...r.wallet('bsc',address(1),{asOf:anchored.asOf}),now:anchored.now},anchored);
    }finally{db.close();}
  }finally{f.close();}
});

test('batch results become visible at completion, not at their source-read cutoff',()=>{
  const f=fixture();try{
    f.rank();f.buy();let calls=0;const worker=f.create({now:()=>new Date(at(calls++===0?100:120))});worker.runBatch();
    f.advance(130);const r=f.reader();assert.equal(r.list({asOf:at(110)}).total,0);
    assert.equal(r.detail('bsc',address(900),{asOf:at(110)}).total,0);assert.equal(r.wallets({asOf:at(110)}).total,0);
    assert.equal(r.list({asOf:at(125)}).items[0].computedAt,at(120));
  }finally{f.close();}
});

test('cross-token wallet summaries keep losses and unknowns and never count cumulative snapshots as separate profit events',()=>{
  const f=fixture();try{
    for(const n of [900,901,902,903]){f.rank(60,n);f.buy(1,30,35,n,n);}
    f.profit(1,'100','20','120',70,900);f.profit(1,'150','30','180',90,900);
    f.profit(1,'-40','10','-30',90,901);f.profit(1,'0','5','5',90,902);f.profit(1,null,'10',null,90,903);
    const worker=f.create();worker.runBatch();const r=f.reader(),summary=r.wallet('bsc',address(1)).wallet!;
    assert.equal(summary.tokenCount,4);assert.equal(summary.realizedCoverage,3);assert.equal(summary.realizedProfitUsd,110);
    assert.equal(summary.positiveRealizedTokens,1);assert.equal(summary.negativeRealizedTokens,1);assert.equal(summary.zeroRealizedTokens,1);assert.equal(summary.unknownRealizedTokens,1);
    assert.equal(summary.earlyTokenCount,4);assert.equal(summary.observedEarlyTokenCount,4);assert.equal(summary.earlyPositiveRealizedTokens,1);
    assert.equal(summary.roiPct,null);assert.equal(summary.largestPositiveRealizedShare,1);
    assert.ok(summary.limitations.includes('NOT_ENTIRE_WALLET_RETURN_OR_WIN_RATE'));
  }finally{f.close();}
});

test('buy-volume ranks remain volume ranks; missing realized profit and supplier firstAcquired never become proof',()=>{
  const f=fixture();try{
    f.rank();f.profit(1,null,'900','900',90,900,'gmgn_token_buy_volume_cur_rank');
    f.history.captureVendorNominations(token(),{source:'ave',eventId:'ave:signal:'+'a'.repeat(64),occurredAt:at(10),observedAt:at(20),wallets:[{address:address(2),side:'buy'}]});
    const worker=f.create();worker.runBatch();const d=f.reader().detail('bsc',address(900));
    assert.equal(d.items.length,1);assert.equal(d.items[0].entry,undefined);assert.equal(d.items[0].pnl?.rankScope,'vendor_buy_volume_order');
    assert.equal(d.token?.topRealized,undefined);assert.equal(d.token?.entryCount,0);
  }finally{f.close();}
});

test('only retrieved exact-CA posts count: AI timestamps, reference inventory, foreign text and future fetches do not',()=>{
  const f=fixture();try{
    f.rank();f.buy();f.post(10,90,95,'2100000000000000001',{text:'foreign '+address(901)});
    f.post(15,110,95,'2100000000000000002');f.post(20,90,95,'2100000000000000003',{provider:'debot',verification:'vendor_endpoint'});
    f.post(30,90,95,'2100000000000000004',{relation:'referenced_context',mentionsExactCa:false});
    const worker=f.create();worker.runBatch();assert.equal(f.reader().detail('bsc',address(900)).token?.caPost,undefined);
    f.advance(130);f.post(50,120,125,'2100000000000000005');worker.runBatch();
    // Post arrival is independent of history cursors, so its bounded periodic revisit is due at 5 minutes.
    f.advance(401);worker.runBatch();assert.equal(f.reader().detail('bsc',address(900)).token?.caPost?.eventAt,at(50));
  }finally{f.close();}
});

test('retention pruning cannot erase a retained earliest signal or CA-post anchor, and later conflicts disable timing conclusions',()=>{
  const f=fixture();try{
    f.rank();f.buy();f.post();f.advance(55);
    const sig:Signal={source:'debot',sourceEventId:'anchor',token:token(),occurredAt:at(50),text:'signal',evidenceUrls:[],claim:'unspecified'};
    f.sources.record(sig,at(55));f.advance(100);const worker=f.create();worker.runBatch();const r=f.reader(),first=r.detail('bsc',address(900));
    f.meme.exec('DELETE FROM meme_catalysts');f.advance(401);worker.runBatch();
    assert.equal(r.detail('bsc',address(900)).token?.caPost?.eventAt,at(50));assert.equal(r.detail('bsc',address(900)).token?.caPost?.status,'retained');
    f.sources.record({...sig,occurredAt:at(49)},at(401));f.advance(702);worker.runBatch();
    const conflict=r.detail('bsc',address(900));assert.equal(conflict.token?.firstSignal?.status,'conflict');
    assert.equal(conflict.items[0].comparisons.signal.position,'unknown');
    assert.equal(r.detail('bsc',address(900),{asOf:first.asOf}).items[0].comparisons.signal.position,'before');
    const db=new DatabaseSync(f.sourcePath);db.exec('DELETE FROM source_notifications');db.close();f.advance(1003);worker.runBatch();
    assert.equal(r.detail('bsc',address(900)).token?.firstSignal?.status,'conflict');
  }finally{f.close();}
});

test('conflicting timestamps for one transaction are excluded rather than choosing the most attractive early time',()=>{
  const f=fixture();try{
    f.rank();f.buy(1,20,30,900,1);f.buy(1,70,80,900,1);f.profit();
    const worker=f.create();worker.runBatch();const row=f.reader().detail('bsc',address(900)).items[0];
    assert.equal(row.entry,undefined);assert.ok(row.limitations.includes('CONFLICTING_BUY_TIMESTAMPS_EXCLUDED'));
  }finally{f.close();}
});

test('bounded wallet selection preserves the largest realized sample alongside the earliest observed buys',()=>{
  const f=fixture();try{
    f.rank();for(let n=1;n<=250;n++)f.buy(n,10+n/10,40,900,n);f.profit(500,'9000');
    const worker=f.create();worker.runBatch();const r=f.reader(),d=r.detail('bsc',address(900),{limit:100});
    assert.equal(d.token?.walletCount,200);assert.equal(d.token?.topRealized?.wallet,address(500));assert.equal(d.token?.earliestEntry?.wallet,address(1));
    assert.equal(d.token?.coverage.truncated,true);assert.equal(r.wallet('bsc',address(500)).total,1);
  }finally{f.close();}
});

test('source databases remain read-only and restart retains watermarks and frozen research',()=>{
  const f=fixture();try{
    f.rank();f.buy();f.profit();const before=statSync(f.historyPath).mtimeMs,worker=f.create();worker.runBatch();const initial=worker.status();
    assert.equal(statSync(f.historyPath).mtimeMs,before);worker.close();
    f.advance(130);const restarted=f.create();restarted.runBatch();assert.equal(restarted.status().changed,initial.changed);
    assert.equal(f.reader().list().items[0].firstRank.observedAt,at(60));assert.equal(statSync(f.historyPath).mtimeMs,before);
    assert.throws(()=>f.create({database:f.historyPath}),/CONFIG_INVALID/);
    const hardlink=join(f.dir,'alias.sqlite');linkSync(f.historyPath,hardlink);assert.throws(()=>f.create({database:hardlink}),/CONFIG_INVALID/);
  }finally{f.close();}
});

test('reader never creates missing output and validates pagination before any query',()=>{
  const f=fixture();try{
    const r=f.reader();assert.equal(r.status().ready,false);assert.equal(r.list().total,0);assert.equal(r.wallets().total,0);assert.equal(existsSync(f.out),false);
    assert.equal(existsSync(`${f.out}.wallet-pages.sqlite`),false);
    for(const options of [{limit:0},{limit:101},{offset:-1},{asOf:at(101)},{asOf:'bad'},{chain:'eth'}])assert.throws(()=>r.list(options as never),/INVALID_FILTER/);
    assert.throws(()=>r.wallets({sort:'roi' as never}),/INVALID_FILTER/);assert.throws(()=>r.detail('bsc','0x123'),/INVALID_FILTER/);
    f.rank();f.create().runBatch();assert.equal(r.status().ready,true);assert.equal(r.list().total,1);
  }finally{f.close();}
});

test('capacity failure rolls back results and cursors while keeping existing versions available',()=>{
  const f=fixture();try{
    f.rank();f.buy();f.profit();const worker=f.create({maxBytes:1048576});worker.runBatch();const before=worker.status().watermarks;
    const db=new DatabaseSync(f.out);db.exec('CREATE TABLE capacity_padding(data BLOB)');db.prepare('INSERT INTO capacity_padding VALUES(?)').run(Buffer.alloc(1024*1024));db.close();
    f.advance(130);f.rank(125,901);const result=worker.runBatch();assert.equal(result.error,'TOKEN_RANK_RESEARCH_CAPACITY_REACHED');
    assert.deepEqual(result.watermarks,before);assert.equal(f.reader().list().total,1);assert.equal(f.reader().detail('bsc',address(900)).items[0].pnl?.realizedProfitUsd,50);
    worker.close();
    const stillFull=f.create({maxBytes:1048576});assert.equal(stillFull.runBatch().error,'TOKEN_RANK_RESEARCH_CAPACITY_REACHED');stillFull.close();
    const recovered=f.create({maxBytes:4*1048576});assert.equal(recovered.status().error,undefined);
    f.advance(140);assert.equal(recovered.runBatch().error,undefined);
    assert.equal(f.reader().list().total,2);
    assert.equal(f.reader().detail('bsc',address(901)).token?.computedAt,at(140),'recovered computation must not be backdated');
    assert.equal(f.reader().detail('bsc',address(900),{asOf:at(100)}).items[0].pnl?.realizedProfitUsd,50,'original frozen evidence survives recovery');
  }finally{f.close();}
});


test('default pagination anchor uses only the last committed batch even during an active write transaction',()=>{
  const f=fixture();try{
    f.rank();const worker=f.create();worker.runBatch();const r=f.reader();f.advance(200);
    const db=new DatabaseSync(f.out);db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE tr_meta SET value=? WHERE key='last_run_at'").run(at(199));
    const during=r.list();assert.equal(during.now,at(200));assert.equal(during.asOf,at(100));
    db.exec('COMMIT');db.close();assert.equal(r.list().asOf,at(199));
    assert.equal(r.list({asOf:during.asOf}).items[0].computedAt,at(100));
  }finally{f.close();}
});

test('a retained buy is revoked by a later contradictory timestamp and never revived by sample-window changes',()=>{
  const f=fixture();try{
    f.rank();f.buy(1,20,30,900,1);f.profit();const worker=f.create();worker.runBatch();const r=f.reader(),old=r.wallet('bsc',address(1));
    assert.equal(old.items[0].entry?.eventAt,at(20));
    const source=new DatabaseSync(f.historyPath);source.exec("DELETE FROM wh_observations WHERE kind='trade'");
    f.advance(130);f.buy(1,70,125,900,1);worker.runBatch();
    assert.equal(r.wallet('bsc',address(1)).items[0].entry,undefined);
    assert.equal(r.wallet('bsc',address(1),{asOf:old.asOf}).items[0].entry?.eventAt,at(20));
    source.exec("DELETE FROM wh_observations WHERE kind='trade'");f.advance(450);f.buy(1,20,440,900,1);worker.runBatch();
    assert.equal(r.wallet('bsc',address(1)).items[0].entry,undefined);
    f.advance(500);f.buy(1,25,490,900,2);worker.runBatch();
    assert.equal(r.wallet('bsc',address(1)).items[0].entry?.txHash,tx(2));source.close();
  }finally{f.close();}
});
