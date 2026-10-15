import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {analyzeWallets} from '../src/research/wallets.js';
import {assessWalletSupport,researchProvider,type VendorWalletTargets} from '../src/research.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import {readConfig} from '../src/config.js';
import type {Signal} from '../src/types.js';
import type {WalletResearchTargets} from '../src/research/wallet-targets.js';

const now=new Date('2026-10-15T06:00:00.000Z'),stamp=(seconds=0)=>new Date(now.getTime()+seconds*1000).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),tx='0x'+'a'.repeat(64);
const token={chain:'bsc' as const,address:address(100)};
const signal:Signal={source:'debot',sourceEventId:'debot:signal:test',token,occurredAt:stamp(-30),text:'',evidenceUrls:[],claim:'unspecified'};
const nominate=(addresses:string[]):VendorWalletTargets=>({provider:'debot',token,checkedAt:stamp(),addresses});
const options={now:()=>now,maxWallets:3};
type Query=Record<string,string|number>;
class Client extends GmgnClient {
  calls:{path:string;query:Query;weight:number}[]=[];
  constructor(private rows:unknown[]=[],private modify?:(path:string,query:Query)=>unknown){super();}
  override async get(path:string,query:Query,weight=1):Promise<unknown> {
    this.calls.push({path,query,weight});
    const changed=this.modify?.(path,query);if(changed!==undefined)return changed;
    if(path.endsWith('token_top_holders'))return {list:this.rows};
    if(path.endsWith('wallet_token_balance'))return {balances:[{wallet_address:query.wallet_address,token_address:query.token_address,balance:'123'}]};
    if(path.endsWith('wallet_stats'))return {wallet_address:query.wallet_address,realized_profit:'5000',buy_count:4,sell_count:2};
    if(path.endsWith('wallet_activity'))return {wallet_address:query.wallet_address,activities:[{event_type:'buy',
      tx_hash:tx,timestamp:now.getTime()/1000-30,token:{address:query.token_address},token_amount:'100',cost_usd:'200'}],next:null};
    if(path.endsWith('/info'))return token;
    if(path.endsWith('/security')||path.endsWith('/pool_info'))return {};
    throw new Error('UNEXPECTED_ROUTE');
  }
}
const holder=(n:number)=>({address:address(n),balance:'50',tags:['smart_degen'],amount_percentage:'0.01'});
const enrichment=(client:Client)=>client.calls.filter(call=>!call.path.endsWith('token_top_holders'));

test('真实 DeBot 提名执行独立 GMGN 余额、统计和交易查询，但不会凭提名获得 smart 资格',async()=>{
  const client=new Client();
  const result=await analyzeWallets(signal,token,client,{...options,vendorWalletTargets:nominate([address(1)])});
  assert.deepEqual(enrichment(client).map(c=>c.path),['/v1/user/wallet_token_balance','/v1/user/wallet_stats','/v1/user/wallet_activity']);
  for(const call of enrichment(client))assert.equal(call.query.wallet_address,address(1));
  const wallet=result.wallets[0];
  assert.equal(wallet.holding.currentlyHolding,true);assert.equal(wallet.holding.amount,null);
  assert.equal(wallet.enrichment.activity?.events[0].txHash,tx);assert.equal(wallet.enrichment.status,'complete');
  assert.deepEqual(wallet.recognizedLabels,[]);assert.deepEqual(wallet.vendorLabels.platform,[]);
  assert.equal(wallet.attribution.status,'unknown');assert.equal(result.summary.qualifiedSmartWalletCount,0);
  assert.equal(assessWalletSupport(result,1,now).status,'unknown');
  const facts=result.facts.vendorWalletTargets as Record<string,unknown>;
  assert.equal(facts.scope,'research_nomination_only');assert.equal(facts.buyEvidence,false);
  assert.equal(facts.qualifiesAsSmart,false);assert.equal(facts.ownershipProven,false);
});

test('别名、计数、零地址和截断地址不能定向查询，失败数据不能产生买入事件',async()=>{
  const client=new Client();
  const nomination={...nominate(['SW-a','0x11...111',address(0),'']),walletCount:3,aliases:['SW-a','SW-b','SW-c']};
  const result=await analyzeWallets(signal,token,client,{...options,vendorWalletTargets:nomination});
  assert.equal(enrichment(client).length,0);assert.equal(result.wallets.length,0);
  assert.equal(result.summary.qualifiedSmartWalletCount,0);assert.equal(result.status,'unknown');
  const failed=new Client([],(path)=>path.endsWith('wallet_token_balance')?{balances:[]}:
    path.endsWith('wallet_stats')?{}:path.endsWith('wallet_activity')?{activities:[{alias:'SW-a',usd:500}],next:null}:undefined);
  const incomplete=await analyzeWallets(signal,token,failed,{...options,vendorWalletTargets:nominate([address(1)])});
  assert.equal(incomplete.status,'unknown');assert.equal(incomplete.wallets[0].holding.currentlyHolding,null);
  assert.deepEqual(incomplete.wallets[0].enrichment.activity?.events,[]);
  assert.equal(assessWalletSupport(incomplete,1,now).status,'unknown');
});

test('错链、错币、未来、过期及无效来源提名不会消耗定向查询预算',async()=>{
  const valid=nominate([address(9)]);
  const invalid:unknown[]=[{...valid,provider:'gmgn'},{...valid,token:{...token,chain:'robinhood'}},
    {...valid,token:{...token,address:address(101)}},{...valid,checkedAt:stamp(-121)},
    {...valid,checkedAt:stamp(1)},{...valid,checkedAt:'not-a-time'},{...valid,token:null},
    {...valid,addresses:null},{...valid,addresses:Array(101).fill(address(9))}];
  for(const nomination of invalid) {
    const client=new Client([holder(1)]);
    const result=await analyzeWallets(signal,token,client,{...options,vendorWalletTargets:nomination as VendorWalletTargets});
    assert.equal(client.calls.some(c=>c.query.wallet_address===address(9)),false);
    assert.equal(client.calls.some(c=>c.path.endsWith('wallet_token_balance')),false);
    assert.equal(result.wallets.length,1);
  }
  const client=new Client();
  await analyzeWallets(signal,token,client,{...options,vendorWalletTargets:{...valid,checkedAt:stamp(-120)}});
  assert.equal(client.calls.some(c=>c.query.wallet_address===address(9)),true,'exactly 120s remains fresh');
});

test('Solana 保留真实地址大小写并拒绝系统零公钥和 EVM 地址',async()=>{
  const mint=bs58.encode(Buffer.alloc(32,3)),wallet=bs58.encode(Buffer.alloc(32,4));
  const input:Signal={...signal,token:{chain:'solana',address:mint}};
  const client=new Client();
  const result=await analyzeWallets(input,input.token,client,{...options,vendorWalletTargets:{provider:'debot',
    token:input.token,checkedAt:stamp(),addresses:['11111111111111111111111111111111',address(1),wallet]}});
  assert.deepEqual(result.wallets.map(w=>w.address),[wallet]);
  assert.ok(enrichment(client).every(c=>c.query.chain==='sol'&&c.query.wallet_address===wallet));
});

test('本地画像优先，DeBot 提名去重并限制三个，不扩大六请求十八权重预算',async()=>{
  const local:WalletResearchTargets={source:'local_observations',token,checkedAt:stamp(),truncated:false,
    targets:[{address:address(1),triggerWallet:address(1),reason:'profiled_buy',txHash:tx,eventAt:stamp(-60),observedAt:stamp(-59)}]};
  const client=new Client([holder(8),holder(9),holder(10)]);
  const result=await analyzeWallets(signal,token,client,{...options,researchTargets:local,
    vendorWalletTargets:nominate([address(2),address(2),address(3),address(4),address(5)])});
  const calls=enrichment(client);
  assert.equal(calls.length,6);assert.equal(calls.reduce((total,call)=>total+call.weight,0),16);
  assert.equal(result.summary.enrichedWalletCount,2);
  assert.deepEqual(calls.filter(c=>c.path.endsWith('wallet_stats')).map(c=>c.query.wallet_address),[address(1),address(2)]);
  const vendor=result.facts.vendorWalletTargets as {requested:string[];selected:string[];deferred:string[]};
  assert.deepEqual(vendor.requested,[address(2),address(3),address(4)]);assert.deepEqual(vendor.selected,[address(2)]);
  assert.deepEqual(vendor.deferred,[address(3),address(4)]);
  const current=new Client([holder(1),holder(2),holder(3),holder(4)]);
  const existing=await analyzeWallets(signal,token,current,{...options,vendorWalletTargets:nominate([address(4),address(3),address(2)])});
  assert.equal(existing.summary.enrichedWalletCount,3);assert.equal(enrichment(current).length,6);
  assert.equal(enrichment(current).reduce((total,call)=>total+call.weight,0),18);
  assert.equal(enrichment(current).some(c=>c.path.endsWith('wallet_token_balance')),false);
});

test('GMGN 独立标签和活动仍需通过资金关联风险，供应商提名不能覆盖开发者关联',async()=>{
  const client=new Client([],(path)=>path.endsWith('wallet_stats')?{realized_profit:'5000',common:{tags:['smart_money'],fund_from_address:address(9)}}:undefined);
  const result=await analyzeWallets(signal,{...token,dev:{creator_address:address(9)}},client,
    {...options,vendorWalletTargets:nominate([address(1)])});
  assert.ok(result.wallets[0].recognizedLabels.includes('smart'));
  assert.ok(result.wallets[0].developerLinks.includes('DEVELOPER_DIRECT_FUNDING'));
  assert.equal(result.summary.qualifiedSmartWalletCount,0);assert.equal(assessWalletSupport(result,1,now).status,'unknown');
});

test('provider 回调拿到原信号且在币信息后读取，失败仅固定诊断而不泄漏异常',async()=>{
  const client=new Client();let invoked=0;
  const provider=researchProvider(readConfig({}),client,[],{vendorWalletTargets:input=>{
    invoked++;assert.equal(input,signal);assert.ok(client.calls.some(c=>c.path.endsWith('/info')));
    return {...nominate([address(1)]),checkedAt:new Date().toISOString()};
  }});
  await provider(signal);assert.equal(invoked,1);
  assert.equal(client.calls.some(c=>c.path.endsWith('wallet_token_balance')&&c.query.wallet_address===address(1)),true);
  const failing=researchProvider(readConfig({}),new Client(),[],{vendorWalletTargets:()=>{throw Error('private-secret');}});
  const result=await failing(signal);
  assert.equal(result.wallets.facts.vendorTargetSelectionError,'VENDOR_WALLET_TARGETS_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('private-secret'),false);
});
