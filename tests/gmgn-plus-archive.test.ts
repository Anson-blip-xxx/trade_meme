import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {GmgnPlusArchive,GmgnPlusArchiveRunner} from '../src/gmgn-plus-archive.js';
import {GmgnError} from '../src/providers/gmgn-client.js';

const wallet=(n:number)=>bs58.encode(Buffer.alloc(32,n));
const tx=(n:number)=>bs58.encode(Buffer.alloc(64,n));
const at=Date.parse('2026-10-30T12:00:00Z');
function fixture(){const dir=mkdtempSync(join(tmpdir(),'gmgn-plus-')),path=join(dir,'archive.sqlite');let clock=at;const now=()=>new Date(clock);
  const create=()=>new GmgnPlusArchive({path,maxBytes:16*1024*1024,maxCandidates:100,now});
  return {dir,path,now,advance:(ms:number)=>{clock+=ms;},create,close:()=>rmSync(dir,{recursive:true,force:true})};}
const signal=(id='signal-0001')=>({id,token_address:wallet(1),signal_type:12,ath:3,market_cap:20000,trigger_at:at/1000,
  trigger_mc:10000,first_trigger_mc:9000,signal_times:1,signal_times_by_type:{12:1},data:{chain:'sol',address:wallet(1),symbol:'SIG',
    smart_degen_wallets:[{address:wallet(2),buy_timestamp:at/1000,buy_amount:30}],
    kol_wallets:[{address:wallet(2),buy_timestamp:at/1000,buy_amount:30}]},cur_data:{holder_count:20}});
const callout=(id='01M66CJD4D4TV7X5D2T1AEKA8R')=>({ulid:id,chain:'sol',call_wallet:wallet(3),call_token:wallet(1),
  call_price:'0.00001',call_mc:'10000',call_thesis:{source_content:'plain research text'},create_time:at,
  token_symbol:'CALL',multiplier:'2.1',is_safe:'safe',is_kol:true,is_declaration:false});

test('market and callout rows are normalized, deduplicated and seed bounded wallet candidates',()=>{
  const f=fixture();try{const archive=f.create();
    assert.deepEqual(archive.recordMarketSignals('sol',[signal()]),{received:1,accepted:1,rejected:0,candidates:1,capacityReached:false});
    f.advance(1_000);assert.equal(archive.recordMarketSignals('sol',[{...signal(),market_cap:99999}]).candidates,0);
    archive.commitCalloutPage('global',{list:[callout()],next_page_token:'cursor-one'},'latest');
    archive.commitCalloutPage('global',{list:[{...callout(),multiplier:'3'}],next_page_token:'cursor-two'},'latest');
    archive.recordCallouts('declaration',{list:[{...callout(),is_declaration:true}]});
    const db=new DatabaseSync(f.path,{readOnly:true});
    try{
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_events').get()!.n),2);
      assert.equal(Number(db.prepare("SELECT seen_count FROM gpa_events WHERE kind='market_signal'").get()!.seen_count),2);
      assert.equal(Number(db.prepare("SELECT seen_count FROM gpa_events WHERE kind='callout'").get()!.seen_count),3);
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_wallet_candidates').get()!.n),2);
      assert.equal(Number(db.prepare('SELECT sum(occurrences) AS n FROM gpa_wallet_candidates').get()!.n),2,
        'candidate occurrences equal unique event-wallet evidence, not poll count');
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_event_wallets').get()!.n),3,'roles remain available as separate evidence rows');
      const caller=db.prepare('SELECT source_mask,occurrences FROM gpa_wallet_candidates WHERE address=?').get(wallet(3))!;
      assert.deepEqual({sourceMask:Number(caller.source_mask),occurrences:Number(caller.occurrences)},{sourceMask:3,occurrences:1});
      const signalWallet=db.prepare('SELECT source_mask,occurrences FROM gpa_wallet_candidates WHERE address=?').get(wallet(2))!;
      assert.deepEqual({sourceMask:Number(signalWallet.source_mask),occurrences:Number(signalWallet.occurrences)},{sourceMask:12,occurrences:1},
        'the same event+wallet counts once even when it has two roles');
      assert.equal(db.prepare('SELECT last_seen_at FROM gpa_wallet_candidates WHERE address=?').get(wallet(2))!.last_seen_at,
        new Date(at).toISOString(),'re-polling stale evidence does not make the candidate look recent');
      assert.equal(archive.calloutCursor('global'),'cursor-one','the first latest page freezes the historical frontier');
      assert.equal(archive.calloutFrontier('global'),'cursor-two');
    }finally{db.close();archive.close();}
  }finally{f.close();}
});

test('callout cursor advances only for a structurally usable page and accepts an empty terminal page',()=>{
  const f=fixture();try{const archive=f.create();archive.commitCalloutPage('global',{list:[callout()],next_page_token:'history'},'latest');
    assert.throws(()=>archive.commitCalloutPage('global',{},'backfill'),/CALLOUT_PAGE_INVALID/);
    assert.throws(()=>archive.commitCalloutPage('global',{list:[{bad:true}],next_page_token:'skip-me'},'backfill'),/CALLOUT_PAGE_REJECTED/);
    assert.throws(()=>archive.commitCalloutPage('global',{list:[],next_page_token:' bad '},'backfill'),/CALLOUT_PAGE_INVALID/);
    assert.equal(archive.calloutCursor('global'),'history');
    archive.commitCalloutPage('global',{list:[],next_page_token:''},'backfill');
    assert.equal(archive.calloutCursor('global'),undefined);assert.equal(archive.meta('callout_global_backfill_complete'),'1');
    archive.setMeta('callout_global_backfill_cursor','\ninvalid');assert.equal(archive.calloutCursor('global'),'history',
      'a malformed persisted cursor resets to the validated latest frontier');archive.close();
  }finally{f.close();}
});

test('latest callouts page forward until the previous high water is found when more than 50 arrive',async()=>{
  const f=fixture();try{const archive=f.create(),known=callout('known-callout-000000000001');
    archive.commitCalloutPage('global',{list:[known],next_page_token:'historical-page'},'latest');archive.setMeta('runner_cursor','1');
    const incoming=Array.from({length:60},(_,i)=>callout(`overflow-callout-${String(i).padStart(3,'0')}`)),requested:(string|undefined)[]=[];
    const client={cooldownUntil:0,getMemeMarketSignals:async()=>[],
      getCalloutGlobal:async(_chains:unknown,options:{pageToken?:string})=>{requested.push(options.pageToken);return options.pageToken?
        {list:[...incoming.slice(50),known],next_page_token:'historical-page'}:
        {list:incoming.slice(0,50),next_page_token:'overflow-page-2'};},
      getWalletStats:async()=>({}),getWalletProfits:async()=>({list:[]}),getWalletActivity:async()=>({activities:[]})};
    const runner=new GmgnPlusArchiveRunner({archive,client:client as never,chains:['sol'],intervalMs:5000,now:f.now});await runner.runOnce();
    assert.deepEqual(requested,[undefined,'overflow-page-2']);assert.equal(archive.calloutLatestCursor('global'),undefined);
    assert.equal(archive.meta('callout_global_latest_high_water'),incoming[0]!.ulid);
    assert.equal(archive.calloutCursor('global'),'historical-page','incremental catch-up does not move the independent history cursor');
    const db=new DatabaseSync(f.path,{readOnly:true});try{
      assert.equal(Number(db.prepare("SELECT count(*) AS n FROM gpa_events WHERE kind='callout'").get()!.n),61);
    }finally{db.close();await runner.stop();}
  }finally{f.close();}
});

test('a pruned candidate is rehydrated from distinct durable event evidence without inflating occurrences',()=>{
  const f=fixture();try{const archive=f.create();archive.recordMarketSignals('sol',[signal()]);
    const db=new DatabaseSync(f.path);db.prepare('DELETE FROM gpa_wallet_candidates WHERE address=?').run(wallet(2));db.close();f.advance(60_000);
    assert.equal(archive.recordMarketSignals('sol',[signal()]).candidates,0);
    const check=new DatabaseSync(f.path,{readOnly:true});try{const row=check.prepare('SELECT source_mask,occurrences FROM gpa_wallet_candidates WHERE address=?').get(wallet(2))!;
      assert.deepEqual({sourceMask:Number(row.source_mask),occurrences:Number(row.occurrences)},{sourceMask:12,occurrences:1});
    }finally{check.close();archive.close();}
  }finally{f.close();}
});

test('candidate scheduling finishes cursors, samples unseen wallets, then refreshes the oldest',()=>{
  const f=fixture();try{const archive=f.create();archive.recordMarketSignals('sol',[signal()]);archive.recordCallouts('global',{list:[
    callout('caller-event-00000000000001'),{...callout('caller-event-00000000000002'),call_wallet:wallet(4)}]});
    const db=new DatabaseSync(f.path);try{
      db.prepare('UPDATE gpa_wallet_candidates SET activity_cursor=?,activity_pages=1 WHERE address=?').run('page-two',wallet(2));
      db.prepare('UPDATE gpa_wallet_candidates SET last_activity_at=? WHERE address=?').run(new Date(at-25*60*60*1000).toISOString(),wallet(3));
      assert.deepEqual(archive.candidateBatch('activity',20,24*60*60*1000).addresses,[wallet(2)],'unfinished cursor wins');
      db.prepare('UPDATE gpa_wallet_candidates SET activity_cursor=NULL,activity_pages=0,last_activity_at=? WHERE address=?').run(new Date(at).toISOString(),wallet(2));
      assert.deepEqual(archive.candidateBatch('activity',20,24*60*60*1000).addresses,[wallet(4)],'never sampled wins over refresh');
      db.prepare('UPDATE gpa_wallet_candidates SET last_activity_at=? WHERE address=?').run(new Date(at-26*60*60*1000).toISOString(),wallet(4));
      assert.deepEqual(archive.candidateBatch('activity',20,24*60*60*1000).addresses,[wallet(4)],'oldest sample wins');
      db.prepare('UPDATE gpa_wallet_candidates SET last_stats_at=? WHERE address IN (?,?)').run(new Date(at-2*60*60*1000).toISOString(),wallet(2),wallet(4));
      db.prepare('UPDATE gpa_wallet_candidates SET last_stats_at=? WHERE address=?').run(null,wallet(3));
      assert.ok(archive.candidateBatch('stats',20,1).addresses.includes(wallet(3)),'an unseen stats candidate is not starved by occurrences');
    }finally{db.close();archive.close();}
  }finally{f.close();}
});

test('successful partial stats and profits responses back off omitted wallets',()=>{
  const f=fixture();try{const archive=f.create(),a=wallet(3),b=wallet(4);archive.recordCallouts('global',{list:[callout(),
    {...callout('caller-event-00000000000003'),call_wallet:b}]});
    const profit=archive.recordWalletProfits('sol',[a,b],{code:0,data:{list:[{wallet_address:a,total_profit:'20'}]}});
    assert.deepEqual({accepted:profit.accepted,missing:profit.missing},{accepted:1,missing:1});
    archive.recordWalletStats('sol',[b],{code:0,data:{unrelated:true}});
    const db=new DatabaseSync(f.path,{readOnly:true});try{const row=db.prepare('SELECT failure_count,retry_after FROM gpa_wallet_candidates WHERE address=?').get(b)!;
      assert.equal(Number(row.failure_count),2);assert.equal(row.retry_after,new Date(at+60_000).toISOString());
      assert.equal(archive.candidateBatch('profits',20,1).addresses.includes(b),false,'omitted wallet is not retried immediately');
    }finally{db.close();archive.close();}
  }finally{f.close();}
});

test('callout cursor and runner task position survive restart',async()=>{
  const f=fixture();try{let archive=f.create();archive.commitCalloutPage('declaration',
    {list:[{...callout(),is_declaration:true}],next_page_token:'history-page'},'latest');archive.setMeta('runner_cursor','7');archive.close();
    archive=f.create();assert.equal(archive.calloutCursor('declaration'),'history-page');assert.equal(archive.status().runnerCursor,7);archive.close();
  }finally{f.close();}
});

test('wallet backfill stores compact latest stats/profits and at most 50 activity rows per page',()=>{
  const f=fixture();try{const archive=f.create(),who=wallet(3);archive.recordCallouts('global',{list:[callout()]});
    assert.deepEqual(archive.candidateBatch('stats',20,1).addresses,[who]);
    assert.equal(archive.recordWalletStats('sol',[who],{code:0,data:{wallet_address:who,realized_profit:'12',realized_profit_pnl:'0.5',buy:4,sell:3,
      pnl_stat:{token_num:7,winrate:0.6,avg_holding_period:120},common:{tags:['smart'],fund_from:'exchange'}}}).accepted,1);
    assert.equal(archive.recordWalletProfits('sol',[who],{code:0,data:{list:[{wallet_address:who,total_profit:'20',total_cost:'40',buy:5,sell:4}]}}).accepted,1);
    const activities=Array.from({length:60},(_,i)=>({tx_hash:tx(i+1),event_type:i%2?'buy':'transferIn',token:{address:wallet(4)},
      token_amount:'1',cost_usd:'2',price_usd:'2',timestamp:at/1000-i}));
    const result=archive.recordWalletActivity('sol',who,{code:0,data:{activities,next:'next-page'}});assert.equal(result.accepted,50);
    const db=new DatabaseSync(f.path,{readOnly:true});try{
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_wallet_snapshots').get()!.n),2);
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_wallet_activity').get()!.n),50);
      assert.equal(Number(db.prepare("SELECT count(*) AS n FROM gpa_wallet_activity WHERE event_type='transferIn'").get()!.n),25);
    }finally{db.close();archive.close();}
  }finally{f.close();}
});

test('wallet snapshot periods remain independent and holdings retain every raw page',()=>{
  const f=fixture();try{const archive=f.create(),who=wallet(3);archive.recordCallouts('global',{list:[callout()]});
    const stats=(profit:string)=>({code:0,data:{wallet_address:who,realized_profit:profit,pnl_stat:{winrate:0.5}}});
    const profits=(profit:string)=>({code:0,data:{list:[{wallet_address:who,total_profit:profit}]}});
    archive.recordWalletStats('sol',[who],stats('7'),'7d');archive.recordWalletStats('sol',[who],stats('30'),'30d');
    archive.recordWalletProfits('sol',[who],profits('1'),'1d');archive.recordWalletProfits('sol',[who],profits('7'),'7d');
    archive.recordWalletProfits('sol',[who],profits('30'),'30d');archive.recordWalletProfits('sol',[who],profits('99'));
    archive.recordWalletHoldingsPage('sol',who,'closed',1,{code:0,data:{list:[{token:{address:wallet(4)}}],next:'page-two'}});
    archive.recordWalletHoldingsPage('sol',who,'closed',2,{code:0,data:{list:[],next:''}});
    archive.recordWalletHoldingsPage('sol',who,'closed',1,{code:0,data:{list:[{token:{address:wallet(5)}}],next:'page-two'}});
    const db=new DatabaseSync(f.path,{readOnly:true});try{
      assert.deepEqual(db.prepare("SELECT kind,period FROM gpa_wallet_snapshots ORDER BY kind,period").all().map(row=>({...row})),[
        {kind:'profits',period:'1d'},{kind:'profits',period:'30d'},{kind:'profits',period:'7d'},{kind:'profits',period:'all'},
        {kind:'stats',period:'30d'},{kind:'stats',period:'7d'}]);
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_wallet_holding_pages').get()!.n),2);
      assert.deepEqual(db.prepare('SELECT page,row_count,next_cursor FROM gpa_wallet_holding_pages ORDER BY page').all().map(row=>({...row})),[
        {page:1,row_count:1,next_cursor:'page-two'},{page:2,row_count:0,next_cursor:null}]);
      assert.equal(archive.status().walletHoldingPages,2);
    }finally{db.close();archive.close();}
  }finally{f.close();}
});

test('activity identity keeps same-transaction legs distinct without depending on revised USD valuation',()=>{
  const f=fixture();try{const archive=f.create(),who=wallet(3);archive.recordCallouts('global',{list:[callout()]});
    const base={tx_hash:tx(1),event_type:'buy',token:{address:wallet(4)},timestamp:at/1000,token_amount:'10',quote_amount:'2',
      cost_usd:'20',price_usd:'2',from_address:'',to_address:'',is_open_or_close:1};
    archive.recordWalletActivity('sol',who,{activities:[base,{...base,token_amount:'11'},
      {...base,cost_usd:'21',price_usd:'2.1'}],next:null});
    const db=new DatabaseSync(f.path,{readOnly:true});try{
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_wallet_activity').get()!.n),2,
        'different exact token legs survive, while a valuation-only revision updates the same event');
    }finally{db.close();archive.close();}
  }finally{f.close();}
});

test('activity pages with an explicit foreign chain or wallet are rejected before any write',()=>{
  const f=fixture();try{const archive=f.create(),who=wallet(3),other=wallet(5);archive.recordCallouts('global',{list:[callout()]});
    const row={wallet:who,chain:'sol',tx_hash:tx(1),event_type:'buy',token:{address:wallet(4)},timestamp:at/1000,token_amount:'1'};
    assert.throws(()=>archive.recordWalletActivity('sol',who,{activities:[{...row,wallet:other}],next:'next-page'}),/ACTIVITY_IDENTITY_MISMATCH/);
    assert.throws(()=>archive.recordWalletActivity('sol',who,{chain:'bsc',wallet_address:who,activities:[row],next:'next-page'}),/ACTIVITY_IDENTITY_MISMATCH/);
    const db=new DatabaseSync(f.path,{readOnly:true});try{
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_wallet_activity').get()!.n),0);
      const candidate=db.prepare('SELECT activity_cursor,activity_pages,last_activity_at FROM gpa_wallet_candidates WHERE address=?').get(who)!;
      assert.deepEqual({...candidate},{activity_cursor:null,activity_pages:0,last_activity_at:null});
    }finally{db.close();archive.close();}
  }finally{f.close();}
});

test('invalid activity cursor resets with backoff and advances the runner',async()=>{
  const f=fixture();try{const archive=f.create();archive.recordMarketSignals('sol',[signal()]);archive.setMeta('runner_cursor','7');
    const db=new DatabaseSync(f.path);db.prepare('UPDATE gpa_wallet_candidates SET activity_cursor=?,activity_pages=1 WHERE address=?').run('expired',wallet(2));db.close();
    let requested:string|undefined;const client={cooldownUntil:0,getMemeMarketSignals:async()=>[],getCalloutGlobal:async()=>({list:[]}),
      getWalletStats:async()=>({}),getWalletProfits:async()=>({list:[]}),getWalletActivity:async(_chain:string,_wallet:string,cursor?:string)=>{
        requested=cursor;throw new GmgnError('GMGN_CURSOR_INVALID');}};
    const runner=new GmgnPlusArchiveRunner({archive,client:client as never,chains:['sol'],intervalMs:5000,now:f.now});await runner.runOnce();
    const check=new DatabaseSync(f.path,{readOnly:true});try{const row=check.prepare('SELECT activity_cursor,activity_pages,failure_count,retry_after FROM gpa_wallet_candidates WHERE address=?').get(wallet(2))!;
      assert.equal(requested,'expired');assert.equal(row.activity_cursor,null);assert.equal(Number(row.activity_pages),0);
      assert.equal(Number(row.failure_count),1);assert.equal(row.retry_after,new Date(at+30_000).toISOString());assert.equal(runner.status().runnerCursor,8);
    }finally{check.close();await runner.stop();}
  }finally{f.close();}
});

test('per-task breaker advances after persistent endpoint failures but retries queue preemption',async()=>{
  const f=fixture();try{const archive=f.create();let reason:'GMGN_AUTH_FAILED'|'GMGN_REQUEST_ABORTED'='GMGN_AUTH_FAILED';
    const client={cooldownUntil:0,getMemeMarketSignals:async()=>{throw new GmgnError(reason);},getCalloutGlobal:async()=>({list:[]}),
      getWalletStats:async()=>({}),getWalletProfits:async()=>({list:[]}),getWalletActivity:async()=>({activities:[]})};
    const runner=new GmgnPlusArchiveRunner({archive,client:client as never,chains:['sol'],intervalMs:5000,now:f.now});
    await runner.runOnce();await runner.runOnce();assert.equal(runner.status().runnerCursor,0);await runner.runOnce();assert.equal(runner.status().runnerCursor,1);
    archive.setMeta('runner_cursor','0');reason='GMGN_REQUEST_ABORTED';await runner.runOnce();await runner.runOnce();await runner.runOnce();
    assert.equal(runner.status().runnerCursor,0,'live-entry preemption retries the exact archive task');await runner.stop();
  }finally{f.close();}
});

test('runner advances one durable low-volume task at a time and never sends archive events to entry',async()=>{
  const f=fixture();try{const archive=f.create(),calls:string[]=[];
    const client={cooldownUntil:0,
      getMemeMarketSignals:async(chain:string)=>{calls.push(`market:${chain}`);return [signal(`signal-${chain}`)];},
      getCalloutGlobal:async(_chains:unknown,options:{onlyDeclaration?:boolean;pageToken?:string})=>{calls.push(`callout:${!!options.onlyDeclaration}:${options.pageToken??'latest'}`);
        return {list:[],next_page_token:options.pageToken?'':'next'};},
      getWalletStats:async()=>({}),getWalletProfits:async()=>({list:[]}),getWalletActivity:async()=>({activities:[],next:''})};
    const runner=new GmgnPlusArchiveRunner({archive,client:client as never,chains:['sol','bsc','robinhood'],intervalMs:5000,now:f.now});
    for(let i=0;i<7;i++)await runner.runOnce();
    assert.deepEqual(calls,['market:sol','market:bsc','market:robinhood','callout:false:latest','callout:true:latest','callout:false:next','callout:true:next']);
    assert.equal(runner.status().runnerCursor,7);assert.equal(runner.status().entryPipeline,false);await runner.stop();
  }finally{f.close();}
});

test('capacity guard refuses a batch before writing and leaves existing rows readable',()=>{
  const f=fixture();try{const archive=f.create();archive.recordMarketSignals('sol',[signal()]);
    const before=archive.status().events;assert.equal(archive.capacityReached(16*1024*1024),true);
    const huge=Array.from({length:100},(_,i)=>({...signal(`large-${String(i).padStart(4,'0')}`),data:{...signal().data,padding:'x'.repeat(200_000)}}));
    const result=archive.recordMarketSignals('sol',huge);assert.equal(result.capacityReached,true);
    assert.equal(archive.status().events,before,'a full batch rolls back without losing prior rows');archive.close();
  }finally{f.close();}
});
