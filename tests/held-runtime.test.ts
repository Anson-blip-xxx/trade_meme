import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';
import type {ScanPrice} from '../src/scan-archive.js';

const wallet=bs58.encode(new Uint8Array(32).fill(1)),mint=bs58.encode(new Uint8Array(32).fill(2));
const signature=bs58.encode(new Uint8Array(64).fill(3)),tokenAccount=bs58.encode(new Uint8Array(32).fill(4));
const sol='So11111111111111111111111111111111111111112';
const system='11111111111111111111111111111111',spl='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const privateKey=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString();
function fixture(extra:Record<string,string>={}) {
  const dir=mkdtempSync(join(tmpdir(),'held-runtime-'));
  const config=readConfig({ENTRY_MODE:'off',GMGN_BACKGROUND_RESEARCH_ENABLED:'false',SCANNER_ENABLED:'false',
    DASHBOARD_ENABLED:'true',WATCH_RECHECK_ENABLED:'false',EXIT_SHADOW_ENABLED:'false',CHAIN_STREAM_ENABLED:'false',
    WALLET_RESEARCH_ENABLED:'false',MEME_OBSERVER_ENABLED:'false',TELEGRAM_ENABLED:'false',
    ORDERS_DATABASE_PATH:join(dir,'orders.sqlite'),SCAN_DATABASE_PATH:join(dir,'scans.sqlite'),
    GMGN_API_KEY:'held-runtime-synthetic-key',GMGN_PRIVATE_KEY:privateKey,ENTRY_WALLET_SOLANA:wallet,
    SOLANA_RPC_URL:'https://held-rpc.invalid/',...extra});
  return {dir,config};
}
function source(dir:string) {
  const db=new DatabaseSync(join(dir,'controlled-trade-tests.sqlite'));
  db.exec(`CREATE TABLE controlled_test_runs(id TEXT PRIMARY KEY,wallet TEXT,created_at TEXT,payload TEXT);
    CREATE TABLE controlled_test_operations(run_id TEXT,operation_key TEXT,payload TEXT,PRIMARY KEY(run_id,operation_key));`);
  const at=new Date(Date.now()-10000).toISOString(),run={id:'runtime-fixture',wallet,mint,phase:'needs_attention',
    amountLamports:'10000000',createdAt:at,updatedAt:at,buy:{signature,wallet,mint,side:'buy',slot:10,
      tokenDelta:'1000000',nativeDelta:'-10005000',feeLamports:'5000',preTokenAmount:'0',postTokenAmount:'1000000',
      preNativeLamports:'100000000',postNativeLamports:'89995000',decimals:6,checkedAt:at}};
  const operation={runId:run.id,key:'buy',state:'acknowledged',body:{chain:'sol',from_address:wallet,input_token:sol,
    output_token:mint,input_amount:'10000000',swap_mode:'ExactIn'},
    response:{order_id:'runtime-buy',status:'submitted',hash:signature}};
  db.prepare('INSERT INTO controlled_test_runs VALUES(?,?,?,?)').run(run.id,wallet,at,JSON.stringify(run));
  db.prepare('INSERT INTO controlled_test_operations VALUES(?,?,?)').run(run.id,'buy',JSON.stringify(operation));db.close();
}

test('configured held monitor has no requests without a source, and never creates the controlled journal or enables entry',async()=>{
  const {dir,config}=fixture();let requests=0;
  const runtime=createRuntime(config,{heldFetcher:async()=>{requests++;throw new Error('NETWORK_FORBIDDEN');}});
  try {
    assert.ok(runtime.heldMonitor);assert.ok(runtime.heldTracking);
    await runtime.heldMonitor.runOnce();const cycle=await runtime.heldTracking.runOnce();
    assert.equal(requests,0);assert.equal(cycle.requests,0);assert.equal(cycle.activeTokens,0);
    assert.equal(existsSync(join(dir,'controlled-trade-tests.sqlite')),false);
    assert.equal(runtime.dashboardHome().entryMode,'off');assert.equal(runtime.dashboardOverview().entryMode,'off');
    assert.equal(runtime.dashboardOrders().total,0);
    assert.equal(runtime.heldTracking.getStatus().intervalMs,5000);
    assert.equal(runtime.dashboardHome().heldPositions.enabled,true);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('held and ordinary price loops share the complete price fan-out without losing a router sample',async()=>{
  const {dir,config}=fixture(),runtime=createRuntime(config,{heldFetcher:async()=>{throw new Error('NETWORK_FORBIDDEN');}});
  const prices:ScanPrice[]=[],tokens:{chain:'solana';address:string}[]=[{chain:'solana',address:mint}];
  try {
    runtime.heldMonitor!.tokens=()=>tokens;
    runtime.heldMonitor!.observePrice=price=>{prices.push(price);return true;};
    let archived=0;runtime.archive!.recordPrice=()=>{archived++;};
    runtime.priceRouter.read=async(selected,options)=>{
      const at=new Date().toISOString();
      const samples=selected.map(token=>({...token,priceUsd:1,observedAt:at,receivedAt:at,validUntil:new Date(Date.now()+30000).toISOString(),
        scope:'observed_spot_not_executable_quote' as const,timeBasis:'http_response' as const,source:'dexscreener_token_pairs_sample'}));
      for(const sample of samples)options?.onSample?.(sample);
      return {samples,gaps:[],requests:{dexscreener:1,gmgn:0,debot:0},sourceErrors:{}};
    };
    const heldCycle=await runtime.heldTracking!.runOnce();
    assert.equal(heldCycle.recorded,1);assert.equal(heldCycle.errors,0);assert.equal(prices.length,1);assert.equal(archived,1);
    assert.equal(runtime.dashboardOverview().priceCapacity.activeOrderTokens,1);
    // The ordinary observer uses the same public price callback as chain/Ave streams.
    await runtime.tracking!.runOnce();assert.equal(prices.length,2);assert.equal(archived,2);
    assert.equal(runtime.dashboardOrders().total,0);assert.equal(runtime.dashboardOverview().entryMode,'off');
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('seeded held observations use only signed GMGN reads and snapshot RPC; empty open strategies fall back to history',async()=>{
  const {dir,config}=fixture();source(dir);
  const gmgn:{path:string;type:string|null;method:string}[]=[],rpc:string[]=[];
  const runtime=createRuntime(config,{heldFetcher:async(input,init)=>{
    const url=new URL(String(input));
    if(url.origin==='https://openapi.gmgn.ai') {
      const method=init?.method??'GET';gmgn.push({path:url.pathname,type:url.searchParams.get('type'),method});
      assert.equal(method,'GET');assert.equal(init?.body,undefined);
      assert.ok(['/v1/trade/query_order','/v1/trade/strategy/orders'].includes(url.pathname));
      return Response.json({code:0,data:url.pathname.endsWith('query_order')?{
        order_id:'runtime-buy',status:'confirmed',hash:signature,
        report:{input_token:sol,output_token:mint,input_amount:'10000000',output_amount:'1000000',
          input_token_decimals:9,output_token_decimals:6,price_usd:'1'}}:{list:[],total:0,next_page_token:''}});
    }
    assert.equal(url.origin,'https://held-rpc.invalid');const body=JSON.parse(String(init?.body));rpc.push(body.method);
    let result:unknown;
    if(body.method==='getGenesisHash')result='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    else if(body.method==='getMultipleAccounts')result={context:{slot:20},value:[{owner:system,executable:false,lamports:89995000},
      {owner:spl,executable:false,data:{parsed:{type:'mint',info:{isInitialized:true,decimals:6,supply:'1000000000',mintAuthority:null,freezeAuthority:null}}}}]};
    else if(body.method==='getTokenAccountsByOwner')result={context:{slot:20},value:[{pubkey:tokenAccount,account:{owner:spl,executable:false,
      data:{parsed:{type:'account',info:{owner:wallet,mint,state:'initialized',tokenAmount:{amount:'1000000',decimals:6}}}}}}]};
    else assert.fail('RPC write or unrelated request');
    return Response.json({jsonrpc:'2.0',id:body.id,result});
  }});
  try {
    assert.ok(runtime.heldMonitor);await runtime.heldMonitor.runOnce();
    assert.ok(gmgn.some(request=>request.path.endsWith('query_order')));
    assert.deepEqual(gmgn.filter(request=>request.path.endsWith('strategy/orders')).map(request=>request.type),['open','history']);
    assert.deepEqual(rpc,['getGenesisHash','getMultipleAccounts','getTokenAccountsByOwner']);
    assert.deepEqual(runtime.heldMonitor.tokens(),[{chain:'solana',address:mint}]);
    assert.equal(runtime.dashboardOrders().total,0);assert.equal(runtime.dashboardOverview().entryMode,'off');
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('missing monitor configuration and observer startup failure remain read-only and do not stop the runtime',async()=>{
  const missing=fixture({GMGN_PRIVATE_KEY:''}),disabled=createRuntime(missing.config);
  try {assert.equal(disabled.heldMonitor,undefined);assert.equal(disabled.heldTracking,undefined);
    assert.equal(disabled.dashboardHome().heldPositions.enabled,false);}
  finally{await disabled.close();rmSync(missing.dir,{recursive:true,force:true});}
  const {dir,config}=fixture({GMGN_PRIVATE_KEY:'synthetic-invalid-pem'}),runtime=createRuntime(config);
  try {
    assert.equal(runtime.heldMonitor,undefined);
    assert.equal(runtime.dashboardOverview().heldPositions.captureError,'HELD_MONITOR_STARTUP_FAILED');
    assert.equal(runtime.dashboardOverview().entryMode,'off');
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('a transient source read failure preserves existing held price targets and shutdown drains them before closing',async()=>{
  const {dir,config}=fixture();source(dir);
  const runtime=createRuntime(config,{heldFetcher:async()=>{throw new Error('SYNTHETIC_READ_UNAVAILABLE');}});
  const sourceDb=new DatabaseSync(join(dir,'controlled-trade-tests.sqlite'));
  const stopped:string[]=[];
  try {
    assert.deepEqual(runtime.heldMonitor!.tokens(),[{chain:'solana',address:mint}]);
    sourceDb.exec('ALTER TABLE controlled_test_runs RENAME TO temporarily_unavailable');
    await runtime.heldMonitor!.runOnce();
    assert.deepEqual(runtime.heldMonitor!.tokens(),[{chain:'solana',address:mint}]);
    assert.equal(runtime.dashboardOverview().heldPositions.captureError,'CONTROLLED_HOLDINGS_READ_FAILED');
    sourceDb.exec('ALTER TABLE temporarily_unavailable RENAME TO controlled_test_runs');
    await runtime.heldMonitor!.runOnce();
    assert.notEqual(runtime.dashboardOverview().heldPositions.captureError,'CONTROLLED_HOLDINGS_READ_FAILED');
    const trackingStop=runtime.heldTracking!.stop.bind(runtime.heldTracking!);
    const monitorStop=runtime.heldMonitor!.stop.bind(runtime.heldMonitor!),monitorClose=runtime.heldMonitor!.close.bind(runtime.heldMonitor!);
    runtime.heldTracking!.stop=async()=>{stopped.push('prices');await trackingStop();};
    runtime.heldMonitor!.stop=async()=>{stopped.push('polls');await monitorStop();};
    runtime.heldMonitor!.close=()=>{stopped.push('close');monitorClose();};
    await runtime.close();assert.deepEqual(stopped,['prices','polls','close']);
  }finally{await runtime.close();sourceDb.close();rmSync(dir,{recursive:true,force:true});}
});
