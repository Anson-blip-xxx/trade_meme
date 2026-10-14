import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {parseTargetTokenBalance,selectWalletResearchTargets,type WalletResearchTargets} from '../src/research/wallet-targets.js';
import {analyzeWallets} from '../src/research/wallets.js';
import {researchProvider} from '../src/research.js';
import {readConfig} from '../src/config.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import type {WalletProfile} from '../src/wallet-profiles.js';
import type {WalletTradeObservation} from '../src/wallet-history.js';
import type {Signal} from '../src/types.js';

const now=new Date('2026-10-14T00:00:00.000Z'),stamp=(delta=0)=>new Date(now.getTime()+delta*1000).toISOString();
const ca=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),tx=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const token={chain:'bsc' as const,address:ca(100)};
const signal:Signal={token,source:'gmgn',sourceEventId:'wallet-target-test',occurredAt:stamp(-30),text:'',claim:'unspecified',evidenceUrls:[]};
function profile(n:number,publicWallet=true):WalletProfile {
  return {version:1,chain:'bsc',address:ca(n),computedAt:stamp(-30),freshUntil:stamp(1800),status:'current',source:'wallet_history',sampleOnly:true,ownership:'unknown',
    groups:publicWallet?[{id:'public_kol',firstObservedAt:stamp(-3600),evidenceCount:3,reason:'vendor label'}]:[],
    metrics:{observedEvents:4,buyEvents:3,sellEvents:1,distinctTokens:3,associations:{leaders:0,distinctTokens:0,forwardTokens:0},chain:{transactions:0,transfers:0},
      vendorProfit:{realizedProfitUsd:'5000',period:'7d',snapshotAt:stamp(-120),observedAt:stamp(-100),verification:'vendor_claim'}},
    counterparties:[],limitations:[]};
}
const trade=(n:number,at=-60,patch:Partial<WalletTradeObservation>={}):WalletTradeObservation=>({chain:'bsc',wallet:ca(n),tokenAddress:token.address,
  txHash:tx(n),side:'buy',eventAt:stamp(at),observedAt:stamp(at+1),source:'gmgn_kol_feed',usd:'200',...patch});
const targets=(addresses:number[]):WalletResearchTargets=>({token,checkedAt:stamp(),source:'local_observations',truncated:false,
  targets:addresses.map(n=>({address:ca(n),reason:'profiled_buy',triggerWallet:ca(n),eventAt:stamp(-60),observedAt:stamp(-59),txHash:tx(n)}))});
function balance(wallet=ca(1),value='1',tokenAddress=token.address){return {balances:[{wallet_address:wallet,token_address:tokenAddress,balance:value,decimal:6,height:123,tx_index:0}]};}

test('token balance binds wallet, chain and CA and uses only a confirmed zero versus positive balance',()=>{
  assert.deepEqual(parseTargetTokenBalance(balance(ca(1),'0'),token,ca(1)),{status:'confirmed',balance:'0',currentlyHolding:false,reason:'GMGN_TARGET_TOKEN_BALANCE_CONFIRMED'});
  for(const v of ['0.000001','100000000000000000000000000000','0001'])assert.equal(parseTargetTokenBalance(balance(ca(1),v),token,ca(1)).currentlyHolding,true);
  assert.equal(parseTargetTokenBalance({data:balance(ca(1),'1')},token,ca(1)).status,'confirmed');
  const uppercase={chain:'bsc',address:token.address.toUpperCase().replace('0X','0x')} as const;
  assert.equal(parseTargetTokenBalance(balance(ca(1),'1'),uppercase,ca(1)).status,'confirmed');
});

test('missing, malformed, multiple or mismatched balance rows remain unknown and never imply zero',()=>{
  const invalid:unknown[]=[null,{},[],{balances:[]},{balances:[{}]},balance(ca(2)),balance(ca(1),'1',ca(101)),
    {chain:'robinhood',...balance()},{balances:[{...balance().balances[0],chain:'sol'}]},
    {wallet_address:ca(2),...balance()},{data:{token_address:ca(101),...balance()}},{data:{success:false,...balance()}},
    {balances:[...balance().balances,...balance().balances]},...['','-1','NaN','Infinity','1e10'].map(v=>balance(ca(1),v)),
    {balances:[{...balance().balances[0],balance:0}]},{success:false,...balance()},{code:401,...balance()}];
  for(const value of invalid){const result=parseTargetTokenBalance(value,token,ca(1));assert.equal(result.status,'unknown');assert.equal(result.currentlyHolding,null);assert.equal(result.balance,null);}
  const solToken={chain:'solana' as const,address:bs58.encode(Buffer.alloc(32,3))},who=bs58.encode(Buffer.alloc(32,4));
  assert.equal(parseTargetTokenBalance({chain:'sol',balances:[{chain:'sol',wallet_address:who,token_address:solToken.address,balance:'1'}]},solToken,who).status,'confirmed');
});

test('targets require an observed recent same-token buy and a local public profile, not signal text or labels alone',()=>{
  const base={token,now,profiles:[profile(1)],trades:[trade(1)]};
  assert.equal(selectWalletResearchTargets(base).targets[0].address,ca(1));
  for(const patch of [{side:'sell' as const},{chain:'robinhood' as const},{tokenAddress:ca(101)},{eventAt:stamp(1),observedAt:stamp(2)},
    {eventAt:stamp(-601)},{observedAt:stamp(1)},{txHash:'invalid'},{wallet:ca(0)},{source:''}])
    assert.equal(selectWalletResearchTargets({...base,trades:[trade(1,-60,patch)]}).targets.length,0);
  assert.equal(selectWalletResearchTargets({...base,profiles:[profile(1,false)]}).targets.length,0);
  assert.equal(selectWalletResearchTargets({...base,profiles:[{...profile(1),chain:'robinhood'}]}).targets.length,0);
  assert.equal(selectWalletResearchTargets({...base,profiles:[{...profile(1),computedAt:stamp(1)}]}).targets.length,0);
  assert.equal(selectWalletResearchTargets({...base,trades:[trade(1),trade(1,-61)]}).targets.length,0);
});

test('precursor nomination includes its public peer, deduplicates wallets and bounds output',()=>{
  const p=profile(1,false);p.roleAnalysis={version:1,computedAt:stamp(-30),status:'current',ownership:'unknown',sampleOnly:true,limitations:[],
    method:{minimumDirectionalTokens:3,minimumDirectionShare:0.75,nearTimeSeconds:2,maximumLagSeconds:86400,evidenceLimitPerPeer:6},
    peers:[{address:ca(2),classification:'precursor_pattern',directionalPattern:'precursor_pattern',ownership:'unknown',directionalTokens:{lead:3,follow:0,ambiguous:0,unmatched:0,outsideWindow:0},
      matchedTokens:3,totalCandidateTokens:3,forwardObservedTokens:0,pendingTokens:0,unobservedTokens:0,evidence:[],reasons:[],counterEvidence:[],alternativeExplanations:[],funding:{direct:0,common:0,excluded:0,ownership:'unknown'},
      qualification:{version:1,knownAt:stamp(-90),evidence:[1,2,3].map(n=>({tokenAddress:ca(200+n),direction:'lead' as const,lagSeconds:10,reason:'earlier observed buy',
        candidateBuy:{wallet:ca(1),txHash:tx(100+n),eventAt:stamp(-300),observedAt:stamp(-299),source:'gmgn_kol_feed'},
        leaderBuy:{wallet:ca(2),txHash:tx(200+n),eventAt:stamp(-290),observedAt:stamp(-289),source:'gmgn_kol_feed'}}))}}]};
  const selected=selectWalletResearchTargets({token,now,trades:[trade(1),trade(2),trade(3)],profiles:[p,profile(2),profile(3)],maxTargets:2});
  assert.deepEqual(selected.targets.map(t=>[t.address,t.reason]),[[ca(1),'profiled_buy'],[ca(2),'precursor_leader']]);assert.equal(selected.truncated,true);
  const withoutPublicPeer=selectWalletResearchTargets({token,now,trades:[trade(1)],profiles:[p,profile(2,false)]});assert.equal(withoutPublicPeer.targets.length,0);
  p.roleAnalysis.peers[0].qualification!.knownAt=stamp(-50);
  assert.equal(selectWalletResearchTargets({token,now,trades:[trade(1)],profiles:[p,profile(2)]}).targets.length,0,'qualification learned after this buy cannot take priority');
});

test('stale, unprofitable or missing-profit public tags leave ordinary smart collection budget available',()=>{
  const edits:((p:WalletProfile)=>void)[]=[p=>{p.freshUntil=stamp(-1);},p=>{p.status='stale';},p=>{delete p.metrics.vendorProfit;},
    p=>{p.metrics.vendorProfit!.realizedProfitUsd='999';},p=>{p.metrics.vendorProfit!.realizedProfitUsd='-1000';},
    p=>{p.metrics.vendorProfit!.snapshotAt=stamp(-86401);},p=>{p.metrics.vendorProfit!.observedAt=stamp(-29);},
    p=>{p.metrics.vendorProfit!.snapshotAt=stamp(-99);}];
  for(const edit of edits){const p=profile(1);edit(p);assert.deepEqual(selectWalletResearchTargets({token,now,trades:[trade(1)],profiles:[p]}).targets,[]);}
  const p=profile(1);p.metrics.vendorProfit!.realizedProfitUsd='1000';
  assert.equal(selectWalletResearchTargets({token,now,trades:[trade(1)],profiles:[p]}).targets.length,1,'same profit threshold as screening; this only prioritizes requests');
});

type Query=Record<string,string|number>;
class FakeClient extends GmgnClient {
  calls:{path:string;query:Query;weight?:number}[]=[];
  constructor(private resolver:(path:string,query:Query)=>unknown){super();}
  override async get(path:string,query:Query,weight?:number){this.calls.push({path,query,weight});return this.resolver(path,query);}
}
const holder=(n:number)=>({address:ca(n),balance:'50',tags:['smart_degen'],amount_percentage:'0.01'});
function fake(rows:unknown[],modify?:(path:string,query:Query)=>unknown){return new FakeClient((path,query)=>{
  const modified=modify?.(path,query);if(modified!==undefined)return modified;
  if(path.endsWith('token_top_holders'))return {list:rows};
  if(path.endsWith('wallet_token_balance'))return balance(String(query.wallet_address),'10000000000');
  if(path.endsWith('wallet_stats'))return {wallet_address:query.wallet_address,realized_profit:'2000',total_cost:'1000',winrate:'0.6',buy_count:10,sell_count:4};
  if(path.endsWith('wallet_activity'))return {wallet_address:query.wallet_address,activities:[{event_type:'buy',tx_hash:tx(9),timestamp:Date.parse(stamp(-30))/1000,token:{address:token.address},token_amount:'10',cost_usd:'200'}],next:null};
  if(path.endsWith('/info'))return {address:token.address,chain:'bsc'};
  if(path.endsWith('/security')||path.endsWith('/pool_info'))return {};
  throw Error('UNEXPECTED_TEST_ROUTE');
});}
const opts={now:()=>now,maxWallets:3};

test('existing holder targets take priority in the same three slots without extra balance requests',async()=>{
  const client=fake([holder(1),holder(2),holder(3),{...holder(4),tags:[]}]);
  const out=await analyzeWallets(signal,{address:token.address,chain:'bsc'},client,{...opts,researchTargets:targets([4])});
  assert.equal(out.wallets.find(w=>w.address===ca(4))?.enrichment.status,'complete');
  assert.equal(out.summary.enrichedWalletCount,3);assert.equal(client.calls.length,8);assert.equal(client.calls.some(c=>c.path.endsWith('wallet_token_balance')),false);
  assert.equal(client.calls.filter(c=>c.path.endsWith('wallet_stats'))[0].query.wallet_address,ca(4));
});

test('off-list targets use exact current balances and replace slots within six requests and eighteen weighted units',async()=>{
  const client=fake([holder(1),holder(2),holder(3)]);
  const out=await analyzeWallets(signal,{address:token.address,chain:'bsc'},client,{...opts,researchTargets:targets([4,5,6])});
  const enrichment=client.calls.filter(c=>!c.path.endsWith('token_top_holders'));
  assert.equal(enrichment.length,6);assert.equal(enrichment.reduce((n,c)=>n+(c.weight??0),0),16);assert.equal(out.summary.enrichedWalletCount,2);
  for(const n of [4,5]){const row=out.wallets.find(w=>w.address===ca(n))!;assert.equal(row.holding.currentlyHolding,true);assert.equal(row.holding.amount,null);
    assert.equal(row.holding.usd,null);assert.equal(row.enrichment.status,'complete');assert.deepEqual(row.sources,['targeted_balance']);}
  assert.equal(out.wallets.some(w=>w.address===ca(6)),false);
  for(const call of enrichment.filter(c=>c.path.endsWith('wallet_token_balance')))assert.deepEqual(call.query,{chain:'bsc',wallet_address:call.query.wallet_address,token_address:token.address});
});

test('bounded target collection preserves every configured wallet, request and weighted cap',async()=>{
  for(const maxWallets of [1,2,3,5]){
    const client=fake([holder(1),holder(2),holder(3)]);
    const out=await analyzeWallets(signal,{address:token.address,chain:'bsc'},client,{...opts,maxWallets,researchTargets:targets([4,5,6,7,8,9])});
    const requests=client.calls.filter(c=>!c.path.endsWith('token_top_holders'));
    assert.ok(out.summary.enrichedWalletCount<=maxWallets);assert.ok(requests.length<=maxWallets*2);
    assert.ok(requests.reduce((n,c)=>n+(c.weight??0),0)<=maxWallets*6);
  }
  const p=profile(4);delete p.metrics.vendorProfit;
  const plan=selectWalletResearchTargets({token,now,trades:[trade(4)],profiles:[p]}),client=fake([holder(1),holder(2),holder(3)]);
  const out=await analyzeWallets(signal,{address:token.address,chain:'bsc'},client,{...opts,researchTargets:plan});
  assert.equal(out.summary.enrichedWalletCount,3);assert.equal(client.calls.length,8);
  assert.equal(client.calls.some(c=>c.path.endsWith('wallet_token_balance')),false);
});

test('zero balance is observed empty while a missing or wrong-wallet balance stays unknown and blocks target support',async()=>{
  for(const kind of ['zero','empty','wrong'] as const){
    const client=fake([holder(1)],(path,query)=>path.endsWith('wallet_token_balance')?kind==='zero'?balance(String(query.wallet_address),'0'):
      kind==='empty'?{balances:[]}:balance(ca(999),'1'):undefined);
    const out=await analyzeWallets(signal,{address:token.address,chain:'bsc'},client,{...opts,researchTargets:targets([4])});
    const row=out.wallets.find(w=>w.address===ca(4))!;assert.equal(row.holding.currentlyHolding,kind==='zero'?false:null);
    if(kind!=='zero')assert.equal(out.status,'unknown');
    if(kind==='wrong'){assert.ok(out.reasons.includes('GMGN_WALLET_SCOPE_MISMATCH'));assert.ok(row.risks.includes('GMGN_TARGET_BALANCE_SCOPE_MISMATCH'));}
  }
});

test('stale or wrong-chain target plans cannot redirect bounded collection',async()=>{
  for(const plan of [{...targets([4]),token:{...token,chain:'robinhood' as const}},{...targets([4]),checkedAt:stamp(-121)},
    {...targets([4]),checkedAt:stamp(1)},{...targets([4]),token:{...token,address:ca(101)}}]){
    const client=fake([holder(1)]);await analyzeWallets(signal,{address:token.address,chain:'bsc'},client,{...opts,researchTargets:plan});
    assert.equal(client.calls.some(c=>c.query.wallet_address===ca(4)),false);
  }
});

test('research provider reads the local callback after token context and safely falls back on callback failure',async()=>{
  const client=fake([holder(1)]);let calls=0;
  const provider=researchProvider(readConfig({}),client,[],{walletTargets:s=>{calls++;assert.equal(s,signal);assert.ok(client.calls.some(c=>c.path.endsWith('/info')));throw Error('LOCAL_FAILURE');}});
  const out=await provider(signal);assert.equal(calls,1);assert.equal(out.wallets.facts.targetSelectionError,'LOCAL_WALLET_TARGETS_UNAVAILABLE');
  assert.equal(client.calls.some(c=>c.path.endsWith('wallet_token_balance')),false);
});
