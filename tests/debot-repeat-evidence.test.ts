import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {assessDebotRepeatEvidence,type DebotScopedWalletDetails,type DebotRepeatEvidenceInput} from '../src/debot-repeat-evidence.js';
import {WalletHistory,type WalletTradeObservation,type FollowupWalletEvidence} from '../src/wallet-history.js';
import type {DebotVendorWalletDetail} from '../src/providers/debot-signals.js';
import type {WalletResearchTargets} from '../src/research/wallet-targets.js';

const base=Date.parse('2026-10-15T00:00:00.000Z');
const iso=(seconds:number)=>new Date(base+seconds*1000).toISOString();
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const token={chain:'bsc' as const,address:address(100)};
const wallet=(n=1,patch:Partial<DebotVendorWalletDetail>={}):DebotVendorWalletDetail=>({address:address(n),alias:'vendor label',
  source:'debot',verification:'vendor_report',lastTradeAt:iso(90),profit:{buyAmount:'100',holdAmount:'80'},...patch});
const details=(rows:DebotVendorWalletDetail[],seconds=200,patch:Partial<DebotScopedWalletDetails>={}):DebotScopedWalletDetails=>
  ({token,fetchedAt:iso(seconds),received:rows.length,rejected:0,vendorWallets:rows,...patch});
const input=(patch:Partial<DebotRepeatEvidenceInput>={}):DebotRepeatEvidenceInput=>({token,since:iso(100),now:new Date(iso(200)),
  previousDetails:details([wallet()],100),details:details([wallet()]),...patch});
const trade=(patch:Partial<WalletTradeObservation>={}):WalletTradeObservation=>({chain:token.chain,tokenAddress:token.address,
  wallet:address(1),txHash:hash(1),side:'buy',eventAt:iso(150),observedAt:iso(160),source:'gmgn_wallet_activity',usd:'100',...patch});
function fixture() {
  const history=new WalletHistory(':memory:',{now:()=>new Date(iso(300))});
  return {history,db:(history as unknown as {db:DatabaseSync}).db};
}

test('names, aliases, prices, profit marks and wallet order do not create incremental trading evidence',()=>{
  const previous=details([wallet(1),wallet(2)],100),next=details([
    wallet(2,{alias:'renamed',priceUsd:2,volumeUsd:999,profit:{buyAmount:'1e2',holdAmount:'80.00',unrealizedProfitUsd:'500'}}),
    wallet(1,{alias:'other name',profit:{buyAmount:'0100.0',holdAmount:'8e1',realizedProfitUsd:'5000'}}),
    wallet(3,{address:undefined,alias:'kol_new_alias'})]);
  const result=assessDebotRepeatEvidence(input({previousDetails:previous,details:next}));
  assert.equal(result.material,false);assert.equal(result.priority,'normal');assert.equal(result.evidence.status,'unchanged');
  assert.deepEqual(result.evidence.vendorChanges,[]);assert.deepEqual(result.evidence.observedTrades,[]);
});

test('a new exact address triggers research only and keeps original trade and observation times',()=>{
  const result=assessDebotRepeatEvidence(input({details:details([wallet(),wallet(2,{lastTradeAt:iso(175)})])}));
  assert.equal(result.material,true);assert.equal(result.priority,'wallet');
  assert.deepEqual(result.evidence.vendorChanges,[{address:address(2),kind:'new_address',source:'debot',verification:'vendor_changed',
    observedAt:iso(200),previousObservedAt:iso(100),eventAt:iso(175)}]);
  assert.deepEqual(result.evidence.observedTrades,[]);
  assert.ok(result.evidence.limitations.includes('RESEARCH_TRIGGER_NOT_ENTRY_PERMISSION'));
});

test('first detail baseline requires an actual nonzero address, never an alias or merely a wallet count',()=>{
  for(const value of [undefined,'kol123',address(0)]) {
    const result=assessDebotRepeatEvidence(input({previousDetails:undefined,details:details([wallet(1,{address:value})])}));
    assert.equal(result.material,false);assert.equal(result.evidence.status,'unavailable');
  }
  const result=assessDebotRepeatEvidence(input({previousDetails:undefined,details:details([wallet()])}));
  assert.equal(result.material,true);assert.equal(result.evidence.vendorChanges[0].kind,'new_address');
});

test('changed cumulative quantities and last trade time remain vendor claims without a transaction',()=>{
  const result=assessDebotRepeatEvidence(input({details:details([wallet(1,{lastTradeAt:iso(180),profit:{buyAmount:'101',holdAmount:'81'}})])}));
  assert.equal(result.material,true);assert.equal(result.priority,'wallet');
  assert.deepEqual(result.evidence.vendorChanges.map(row=>row.kind),['last_trade_at','buy_amount','hold_amount']);
  assert.ok(result.evidence.vendorChanges.every(row=>row.verification==='vendor_changed'));
  assert.deepEqual(result.evidence.observedTrades,[]);
});

test('quantity comparisons retain precision beyond Number and normalize decimal encodings',()=>{
  const before=wallet(1,{profit:{buyAmount:'9007199254740992',holdAmount:'0.00000000000000000000000001'}});
  const after=wallet(1,{profit:{buyAmount:'9007199254740993',holdAmount:'1e-26'}});
  const result=assessDebotRepeatEvidence(input({previousDetails:details([before],100),details:details([after])}));
  assert.deepEqual(result.evidence.vendorChanges.map(row=>row.kind),['buy_amount']);
  assert.equal(result.evidence.vendorChanges[0].value,'9007199254740993');
});

test('a disclosed holding decrease gives risk priority, but is not labeled an observed sale',()=>{
  const result=assessDebotRepeatEvidence(input({details:details([wallet(1,{profit:{buyAmount:'100',holdAmount:'0'}})])}));
  assert.equal(result.material,true);assert.equal(result.priority,'risk');
  assert.equal(result.evidence.vendorChanges[0].verification,'vendor_changed');assert.deepEqual(result.evidence.observedTrades,[]);
  assert.ok(result.reasons.includes('DEBOT_REPEAT_VENDOR_HOLDING_DECREASE_PENDING_VERIFICATION'));
});

test('partial or empty details never infer a sale from a missing wallet or missing quantity',()=>{
  const previous=details([wallet(),wallet(2)],100);
  for(const next of [details([wallet(1,{profit:{}})],200,{received:2,rejected:1,reason:'DEBOT_SIGNAL_RECORDS_REJECTED'}),details([])]) {
    const result=assessDebotRepeatEvidence(input({previousDetails:previous,details:next}));
    assert.equal(result.material,false);assert.equal(result.priority,'normal');assert.deepEqual(result.evidence.vendorChanges,[]);
  }
});

test('missing or contradictory chain and CA binding cannot turn other details into evidence',()=>{
  for(const wrong of [undefined,{...token,chain:'robinhood' as const},{...token,address:address(101)}]) {
    const result=assessDebotRepeatEvidence(input({details:details([wallet(2)],200,{token:wrong})}));
    assert.equal(result.material,false);assert.equal(result.evidence.status,'unavailable');
    const prior=assessDebotRepeatEvidence(input({previousDetails:details([wallet()],100,{token:wrong}),details:details([wallet(2)])}));
    assert.equal(prior.material,false);
  }
});

test('stale, future and same-time replayed detail responses cannot create new wallet evidence',()=>{
  for(const at of [79,100,201]) {
    const result=assessDebotRepeatEvidence(input({details:details([wallet(2)],at)}));
    assert.equal(result.material,false);assert.ok(result.reasons.includes('DEBOT_REPEAT_DETAILS_STALE_OR_REPLAYED'));
  }
  const futureTrade=assessDebotRepeatEvidence(input({details:details([wallet(2,{lastTradeAt:iso(201)})])}));
  assert.equal(futureTrade.material,false);
  const rollback=assessDebotRepeatEvidence(input({previousDetails:details([wallet(1,{lastTradeAt:iso(99)})],100),
    details:details([wallet(1,{lastTradeAt:iso(90),profit:{buyAmount:'10',holdAmount:'10'}})])}));
  assert.equal(rollback.material,false);assert.ok(rollback.evidence.limitations.includes('REPLAYED_VENDOR_WALLET_IGNORED'));
});

test('conflicting duplicate address entries are withheld regardless of vendor row ordering',()=>{
  const rows=[wallet(2),wallet(2,{profit:{buyAmount:'500',holdAmount:'400'}})];
  for(const ordered of [rows,[...rows].reverse()]) {
    const result=assessDebotRepeatEvidence(input({details:details(ordered)}));
    assert.equal(result.material,false);assert.ok(result.evidence.limitations.includes('INVALID_OR_ALIAS_ONLY_WALLETS_IGNORED'));
  }
});

test('local evidence is read-only, bounded to 120 seconds, and cross-source transaction copies count once',()=>{
  const {history,db}=fixture();
  try {
    history.recordTrades([trade(),trade({source:'gmgn_kol_feed',observedAt:iso(170)}),
      trade({txHash:hash(2),eventAt:iso(79),observedAt:iso(170)})]);
    const changes=db.prepare('SELECT total_changes() AS n').get()!.n;
    const result=assessDebotRepeatEvidence(input({history,since:iso(0),details:undefined,previousDetails:undefined}));
    assert.equal(result.material,true);assert.equal(result.priority,'wallet');assert.equal(result.evidence.fromAt,iso(80));
    assert.equal(result.evidence.observedTrades.length,1);
    assert.equal(result.evidence.observedTrades[0].txHash,hash(1));
    assert.equal(result.evidence.observedTrades[0].eventAt,iso(150));assert.equal(result.evidence.observedTrades[0].observedAt,iso(160));
    assert.equal(result.evidence.observedTrades[0].verification,'observed_trade');
    assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  }finally{history.close();}
});

test('fresh alerts cannot relabel old trades, old observations, cross-chain transactions or transfers as a new buy',()=>{
  const {history}=fixture();
  try {
    history.recordTrades([
      trade({txHash:hash(1),eventAt:iso(100),observedAt:iso(180)}),
      trade({txHash:hash(2),eventAt:iso(90),observedAt:iso(100)}),
      trade({txHash:hash(3),eventAt:iso(190),observedAt:iso(201)}),
      trade({txHash:hash(4),chain:'robinhood'}),trade({txHash:hash(5),tokenAddress:address(101)}),
      trade({txHash:hash(6),side:'transferIn'}),trade({txHash:hash(7),usd:undefined}),
    ]);
    const result=assessDebotRepeatEvidence(input({history}));
    assert.equal(result.material,false);assert.deepEqual(result.evidence.observedTrades,[]);
    assert.equal(result.evidence.fromAt,iso(100.001));
  }finally{history.close();}
});

test('observed sells outrank buy changes and remain visible in the bounded evidence preview',()=>{
  const {history}=fixture();
  try {
    history.recordTrades([...Array.from({length:22},(_,i)=>trade({txHash:hash(i+1),observedAt:iso(160+i)})),
      trade({txHash:hash(30),wallet:address(3),side:'sell',observedAt:iso(190)})]);
    const result=assessDebotRepeatEvidence(input({history,details:details([wallet(),wallet(2)])}));
    assert.equal(result.material,true);assert.equal(result.priority,'risk');assert.equal(result.evidence.observedTrades.length,20);
    assert.equal(result.evidence.observedTrades[0].side,'sell');assert.ok(result.evidence.limitations.includes('LOCAL_TRADE_EXAMPLES_LIMITED'));
  }finally{history.close();}
});

test('truncated or missing local evidence never manufactures a transaction or a passed safety check',()=>{
  const {history}=fixture();
  try {
    history.recordTrades(Array.from({length:501},(_,i)=>trade({txHash:hash(i+1)})));
    const result=assessDebotRepeatEvidence(input({history,details:undefined}));
    assert.equal(result.material,false);assert.equal(result.evidence.coverage,'truncated');assert.equal(result.evidence.status,'unavailable');
    assert.deepEqual(result.evidence.observedTrades,[]);
    const failed=assessDebotRepeatEvidence(input({history:{followupEvidence(){throw new Error('read error');}}}));
    assert.equal(failed.material,false);assert.ok(failed.reasons.includes('DEBOT_REPEAT_LOCAL_EVIDENCE_UNAVAILABLE'));
  }finally{history.close();}
});

test('local evidence requires exact scope and rejects malformed, zero-hash or future transactions',()=>{
  const {history}=fixture();
  try {
    history.recordTrade(trade());
    const good=history.followupEvidence(token,iso(100.001),iso(200));
    for(const patch of [{chain:'robinhood' as const},{address:address(101)},{fromAt:iso(0)}]) {
      assert.equal(assessDebotRepeatEvidence(input({history:{followupEvidence:()=>({...good,...patch})}})).material,false);
    }
    for(const patch of [{txHash:hash(0)},{wallet:address(0)},{observedAt:iso(201)},{eventAt:iso(190)},
      {source:'x<unsafe>'},{evidenceId:'invalid'},{volumeUsd:NaN}]) {
      const bad:FollowupWalletEvidence={...good,trades:[{...good.trades[0],...patch}]};
      const result=assessDebotRepeatEvidence(input({history:{followupEvidence:()=>bad}}));
      assert.equal(result.material,false);assert.deepEqual(result.evidence.observedTrades,[]);
    }
  }finally{history.close();}
});

test('profiled and precursor research nominations require the same observed buy and do not assert ownership',()=>{
  const {history}=fixture();
  try {
    history.recordTrade(trade());
    const targets:WalletResearchTargets={token,checkedAt:iso(190),source:'local_observations',truncated:false,targets:[
      {address:address(1),reason:'profiled_buy',triggerWallet:address(1),eventAt:iso(150),observedAt:iso(160),txHash:hash(1)},
      {address:address(2),reason:'precursor_leader',triggerWallet:address(1),eventAt:iso(150),observedAt:iso(160),txHash:hash(1)},
      {address:address(3),reason:'precursor_leader',triggerWallet:address(1),eventAt:iso(150),observedAt:iso(160),txHash:hash(99)},
    ]};
    const result=assessDebotRepeatEvidence(input({history,walletTargets:targets}));
    assert.equal(result.evidence.researchTargets.length,2);assert.equal(result.priority,'wallet');
    assert.ok(result.evidence.researchTargets.every(row=>row.verification==='research_priority'));
    assert.ok(result.evidence.limitations.includes('PROFILE_RELATION_NOT_OWNERSHIP_PROOF'));
    for(const patch of [{token:{...token,address:address(101)}},{checkedAt:iso(201)},{checkedAt:iso(79)}]) {
      const invalid=assessDebotRepeatEvidence(input({history,walletTargets:{...targets,...patch}}));
      assert.deepEqual(invalid.evidence.researchTargets,[]);
    }
    const noBuy=assessDebotRepeatEvidence(input({walletTargets:targets}));
    assert.equal(noBuy.material,false);assert.deepEqual(noBuy.evidence.researchTargets,[]);
  }finally{history.close();}
});

test('Solana addresses preserve case and require exactly 32 decoded bytes',()=>{
  const solToken={chain:'solana' as const,address:bs58.encode(new Uint8Array(32).fill(1))};
  const who=bs58.encode(new Uint8Array(32).fill(2));
  const result=assessDebotRepeatEvidence(input({token:solToken,previousDetails:undefined,
    details:details([wallet(1,{address:who})],200,{token:solToken})}));
  assert.equal(result.material,true);assert.equal(result.evidence.vendorChanges[0].address,who);
  for(const bad of ['1'.repeat(32),address(1),bs58.encode(new Uint8Array(31).fill(2))]) {
    const invalid=assessDebotRepeatEvidence(input({token:solToken,previousDetails:undefined,
      details:details([wallet(1,{address:bad})],200,{token:solToken})}));
    assert.equal(invalid.material,false);
  }
});

test('invalid token or time windows fail closed without querying history',()=>{
  let calls=0;
  const history={followupEvidence(){calls++;throw new Error('must not read');}};
  for(const patch of [{token:{...token,address:address(0)}},{since:'invalid'},{since:iso(200)},{since:iso(201)},{now:new Date('invalid')}]) {
    const result=assessDebotRepeatEvidence(input({...patch,history}));
    assert.equal(result.material,false);assert.equal(result.evidence.status,'unavailable');
  }
  assert.equal(calls,0);
});
