import test from 'node:test';
import assert from 'node:assert/strict';
import {constants, generateKeyPairSync, randomUUID, verify} from 'node:crypto';
import {readConfig, type Config} from '../src/config.js';
import {EntryController, type LiveProtectionProvider} from '../src/entry.js';
import {OrderStore} from '../src/orders.js';
import {GmgnClient} from '../src/providers/gmgn-client.js';
import type {Report,Check} from '../src/types.js';
import {signal, token, pass, narrative} from './helpers.js';

const baseTime = Date.parse('2026-10-08T12:00:00.000Z');
const wallet = `0x${'2'.repeat(40)}`;
const inputToken = `0x${'0'.repeat(40)}`;
const hash = `0x${'a'.repeat(64)}`;
const keyPair = generateKeyPairSync('ed25519');
const pem = keyPair.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
function candidate(): Report {
  return {id: randomUUID(), policyVersion: 'entry-gate-test', mode: 'live', signal: signal(),
    receivedAt: new Date(baseTime).toISOString(), evaluatedAt: new Date(baseTime).toISOString(),
    validUntil: new Date(baseTime + 60_000).toISOString(), decision: 'BUY_CANDIDATE', buyEligible: true,
    executionEnabled: false, reasons: [], provenance: {...pass(), platform: 'flap'}, safety: pass(),
    narrative: narrative(), flow: pass()};
}
function profiledCandidate():Report {
  const report=candidate();report.flow!.reasons=['PROFILED_WALLET_SETUP_SUPPORTED'];
  report.walletScreening={version:1,token:report.signal.token,checkedAt:report.evaluatedAt,validUntil:report.validUntil,
    status:'supported',priorityScore:18,scope:'research_priority',ownership:'unknown',sampleOnly:true,reasons:[],setups:[{
      id:'test-route',route:'public_entry',wallet,leader:wallet,status:'supported',stage:'direct_entry',priorityScore:18,
      trigger:{chain:'bsc',wallet,tokenAddress:token,txHash:hash,side:'buy',eventAt:new Date(baseTime-20_000).toISOString(),observedAt:new Date(baseTime-10_000).toISOString(),source:'test'},
      reasons:[],counterEvidence:[],followers:2,ownership:'unknown'}]};
  return report;
}
function quote(amount = '1000000000000000', output = '123456789012345678901') {
  return {input_token: inputToken, output_token: token, input_amount: amount,
    output_amount: output, min_output_amount: (BigInt(output) * 95n / 100n).toString(), slippage: 5};
}
function setup(t: {after: (fn: () => void) => void}, options: {
  mode?: 'off' | 'paper' | 'live'; config?: Partial<Config>;
  quote?: (url: URL) => unknown | Promise<unknown>;
  signed?: typeof fetch;
  liveProtection?: LiveProtectionProvider | null;
  walletEvidence?:(report:Report,now:Date)=>Check;
} = {}) {
  const apiKey = `entry-test-${randomUUID()}`;
  const config: Config = {...readConfig({}), entryMode: options.mode ?? 'paper',
    gmgnApiKey: apiKey, gmgnPrivateKey: pem, gmgnMinIntervalMs: 0,
    entryWallets: {bsc: wallet}, entryAmounts: {bsc: '1000000000000000'}, entryInputTokens: {bsc: inputToken},
    ...options.config};
  const clock = {time: baseTime};
  const readCalls: URL[] = [], signedCalls: {url: URL; init?: RequestInit}[] = [];
  const client = new GmgnClient({apiKey, minIntervalMs: 0, now: () => clock.time,
    fetcher: async input => {
      const url = new URL(String(input)); readCalls.push(url);
      return Response.json({code: 0, data: options.quote ? await options.quote(url) : quote(config.entryAmounts.bsc)});
    }});
  const store = new OrderStore(':memory:'); t.after(() => store.close());
  const controller = new EntryController(config, store, client, {now: () => new Date(clock.time),
    walletEvidence:options.walletEvidence,
    // Transport tests use synthetic protection evidence. Production supplies no passing provider.
    liveProtection: options.liveProtection === null ? undefined : options.liveProtection ?? (context => ({
      status: 'verified', scope: 'autonomous_exit_execution', chain: context.chain, wallet: context.wallet,
      checkedAt: new Date(clock.time).toISOString(), validUntil: new Date(clock.time + 30_000).toISOString(),
    })),
    fetcher: async (input, init) => {
      signedCalls.push({url: new URL(String(input)), init});
      return options.signed ? options.signed(input, init) : Response.json({code: 0, data: {order_id: 'order-1', status: 'pending'}});
    }});
  return {config, clock, client, store, controller, readCalls, signedCalls};
}

test('live entry has no default readiness provider and cannot be enabled by mode, config or report claims', async t => {
  const ctx = setup(t, {mode:'live',liveProtection:null});
  Object.assign(ctx.config,{unattendedProtectionVerified:true,shadowExit:{enabled:true,status:'verified'}});
  const report=candidate();report.safety.facts={autonomousExitVerified:true,shadowSimulationPassed:true};
  const result=await ctx.controller.consider(report);
  assert.deepEqual(result,{status:'blocked',reason:'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED'});
  assert.equal(ctx.readCalls.length,0);assert.equal(ctx.signedCalls.length,0);assert.equal(ctx.store.list().length,0);
});

test('malformed, expired, mismatched or shadow-only capability evidence fails closed without exposing provider errors', async t => {
  const baseline={status:'verified',scope:'autonomous_exit_execution',chain:'bsc',wallet,
    checkedAt:new Date(baseTime).toISOString(),validUntil:new Date(baseTime+30_000).toISOString()};
  const invalid:unknown[]=[undefined,true,{...baseline,status:'unverified'}, {...baseline,scope:'shadow_simulation'},
    {...baseline,chain:'robinhood'},{...baseline,wallet:token}, {...baseline,validUntil:new Date(baseTime).toISOString()},
    {...baseline,checkedAt:new Date(baseTime-30_001).toISOString()},
    {...baseline,checkedAt:new Date(baseTime+5_001).toISOString()},
    {...baseline,validUntil:new Date(baseTime+30_001).toISOString()}];
  for(const value of invalid) {
    const ctx=setup(t,{mode:'live',liveProtection:(()=>value) as LiveProtectionProvider});
    assert.equal((await ctx.controller.consider(candidate())).reason,'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED');
    assert.equal(ctx.readCalls.length,0);assert.equal(ctx.signedCalls.length,0);assert.equal(ctx.store.list().length,0);
  }
  const thrown=setup(t,{mode:'live',liveProtection:()=>{throw new Error('PRIVATE_PROTECTION_SECRET');}});
  assert.deepEqual(await thrown.controller.consider(candidate()),{status:'blocked',reason:'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED'});
});

test('readiness is rechecked before quote and after the shared POST queue, with no retry after denial', async t => {
  for(const stopAt of ['before_quote','after_queue'] as const) {
    let valid=true;
    const ctx=setup(t,{mode:'live',liveProtection:context=>({status:valid&&!(stopAt==='before_quote'&&context.phase==='before_quote')?'verified':'unverified',
      scope:'autonomous_exit_execution',chain:context.chain,wallet:context.wallet,
      checkedAt:new Date(baseTime).toISOString(),validUntil:new Date(baseTime+30_000).toISOString()})});
    const schedule=ctx.client.scheduleRequest.bind(ctx.client);let calls=0;
    ctx.client.scheduleRequest=async<T>(weight:number,execute:()=>Promise<T>)=>{
      if(++calls===2&&stopAt==='after_queue') valid=false;
      return schedule(weight,execute);
    };
    const report=candidate(),result=await ctx.controller.consider(report);
    assert.equal(result.reason,'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED');assert.equal(result.order?.status,'failed');
    assert.equal(ctx.readCalls.length,stopAt==='before_quote'?0:1);assert.equal(ctx.signedCalls.length,0);
    assert.equal(ctx.store.list().length,1);
    await ctx.controller.consider(report);assert.equal(ctx.signedCalls.length,0);
  }
});

test('paper simulation never requests live capability evidence', async t => {
  const ctx=setup(t,{mode:'paper',liveProtection:()=>{throw new Error('PAPER_MUST_NOT_ASK_FOR_LIVE_PROTECTION');}});
  assert.equal((await ctx.controller.consider(candidate())).order?.status,'paper_open');
  assert.equal(ctx.signedCalls.length,0);
});

test('profile-supported entry rechecks its own expiry after a quote and refuses missing or withdrawn evidence',async t=>{
  const ctx=setup(t,{walletEvidence:(_report,now)=>({...pass(),checkedAt:now.toISOString()}),quote:()=>{ctx.clock.time+=20_000;return quote(ctx.config.entryAmounts.bsc);}});
  const r=candidate();r.flow!.reasons=['PROFILED_WALLET_SETUP_SUPPORTED'];
  r.walletScreening={version:1,token:r.signal.token,checkedAt:r.evaluatedAt,validUntil:new Date(baseTime+10_000).toISOString(),
    status:'supported',priorityScore:18,scope:'research_priority',ownership:'unknown',sampleOnly:true,reasons:[],setups:[{
      id:'test-route',route:'public_entry',wallet,leader:wallet,status:'supported',stage:'direct_entry',priorityScore:18,
      trigger:{chain:'bsc',wallet,tokenAddress:token,txHash:hash,side:'buy',eventAt:new Date(baseTime-20_000).toISOString(),observedAt:new Date(baseTime-10_000).toISOString(),source:'test'},
      reasons:[],counterEvidence:[],followers:2,ownership:'unknown'}]};
  const result=await ctx.controller.consider(r);assert.equal(result.reason,'ENTRY_CANDIDATE_EXPIRED');assert.equal(ctx.readCalls.length,1);assert.equal(ctx.signedCalls.length,0);
  const missing=setup(t),m=candidate();m.flow!.reasons=['PROFILED_WALLET_SETUP_SUPPORTED'];
  assert.equal((await missing.controller.consider(m)).reason,'ENTRY_FLOW_NOT_PASSED');assert.equal(missing.readCalls.length,0);
  const withdrawn=setup(t,{config:{walletSupportRequired:false}}),w=candidate();w.flow!.reasons=['WALLET_SETUP_SUPPORT_WITHDRAWN'];
  assert.equal((await withdrawn.controller.consider(w)).reason,'ENTRY_FLOW_NOT_PASSED');assert.equal(withdrawn.readCalls.length,0);
});

test('profile-supported entries require a local wallet-evidence provider before any quote or reservation',async t=>{
  const ctx=setup(t),result=await ctx.controller.consider(profiledCandidate());
  assert.equal(result.status,'blocked');assert.equal(result.reason,'ENTRY_WALLET_EVIDENCE_UNAVAILABLE');
  assert.equal(ctx.readCalls.length,0);assert.equal(ctx.signedCalls.length,0);assert.equal(ctx.store.list().length,0);
});

test('a local sell observed during the quote withdraws paper entry while the original report remains unexpired',async t=>{
  let reduced=false,checks=0;
  const ctx=setup(t,{walletEvidence:(_report,now)=>{checks++;return {...pass(),checkedAt:now.toISOString(),status:reduced?'unknown':'pass',
      reasons:reduced?['WALLET_SETUP_SUPPORT_WITHDRAWN']:[]};},
    quote:()=>{reduced=true;ctx.clock.time+=10_000;return quote(ctx.config.entryAmounts.bsc);}});
  const report=profiledCandidate(),result=await ctx.controller.consider(report);
  assert.equal(result.status,'blocked');assert.equal(result.reason,'ENTRY_FLOW_NOT_PASSED');assert.equal(result.order?.status,'failed');
  assert.equal(ctx.readCalls.length,1);assert.equal(ctx.signedCalls.length,0);assert.ok(checks>=3);
  assert.equal(report.walletScreening!.status,'supported');assert.ok(Date.parse(report.validUntil)>ctx.clock.time);
});

test('fresh local wallet evidence permits paper entry without modifying its original decision snapshot',async t=>{
  const ctx=setup(t,{walletEvidence:(report,now)=>{
    report.walletScreening!.setups[0].leader=token;report.flow!.reasons=[];
    return {...pass(),checkedAt:now.toISOString()};
  }});
  const report=profiledCandidate(),before=JSON.stringify(report),result=await ctx.controller.consider(report);
  assert.equal(result.order?.status,'paper_open');assert.equal(JSON.stringify(report),before);
  assert.equal((result.order?.details.walletScreening as Report['walletScreening'])?.setups[0].leader,wallet);
  assert.equal(ctx.signedCalls.length,0);
});

test('wallet-evidence failures before or after quoting fail closed without leaking provider exception text',async t=>{
  for(const late of [false,true]){
    let quoted=false;
    const ctx=setup(t,{walletEvidence:(_report,now)=>{
      if(!late||quoted)throw new Error('PRIVATE_WALLET_REVALIDATION_SECRET');return {...pass(),checkedAt:now.toISOString()};
    },quote:()=>{quoted=true;return quote(ctx.config.entryAmounts.bsc);}});
    const result=await ctx.controller.consider(profiledCandidate());assert.equal(result.status,'blocked');assert.equal(result.reason,'ENTRY_WALLET_EVIDENCE_UNAVAILABLE');
    assert.equal(ctx.readCalls.length,late?1:0);assert.equal(ctx.signedCalls.length,0);assert.ok(!JSON.stringify(result).includes('PRIVATE_WALLET_REVALIDATION_SECRET'));
    if(late)assert.equal(result.order?.status,'failed');else assert.equal(ctx.store.list().length,0);
  }
});

test('local wallet evidence must be current and cannot pass with a withdrawal reason',async t=>{
  for(const checkedAt of [new Date(baseTime-30_001).toISOString(),new Date(baseTime+1).toISOString(),'bad-time']){
    const ctx=setup(t,{walletEvidence:()=>({...pass(),checkedAt})}),result=await ctx.controller.consider(profiledCandidate());
    assert.equal(result.reason,'ENTRY_CANDIDATE_EXPIRED');assert.equal(ctx.readCalls.length,0);
  }
  for(const status of ['unknown','fail','pass'] as const){
    const ctx=setup(t,{walletEvidence:()=>({...pass(),status,reasons:['WALLET_SETUP_SUPPORT_WITHDRAWN']})});
    assert.equal((await ctx.controller.consider(profiledCandidate())).reason,'ENTRY_FLOW_NOT_PASSED');assert.equal(ctx.readCalls.length,0);
  }
  const malformed=setup(t,{walletEvidence:(()=>undefined) as unknown as (report:Report,now:Date)=>Check});
  assert.equal((await malformed.controller.consider(profiledCandidate())).reason,'ENTRY_WALLET_EVIDENCE_UNAVAILABLE');
});

test('a configured wallet revalidator can revoke legacy smart-wallet support even when the optional support gate is disabled',async t=>{
  for(const required of [false,true]){
    let reduced=false;
    const ctx=setup(t,{config:{walletSupportRequired:required},walletEvidence:(_report,now)=>({...pass(),checkedAt:now.toISOString(),
      status:reduced?'unknown':'pass',reasons:reduced?['WALLET_SETUP_SUPPORT_WITHDRAWN']:[]}),
      quote:()=>{reduced=true;return quote(ctx.config.entryAmounts.bsc);}});
    const result=await ctx.controller.consider(candidate());assert.equal(result.reason,'ENTRY_FLOW_NOT_PASSED');assert.equal(result.order?.status,'failed');
    assert.equal(ctx.signedCalls.length,0);
  }
});

test('wallet evidence is revalidated after the signed request queue before submission begins',async t=>{
  let reduced=false;
  const ctx=setup(t,{mode:'live',walletEvidence:(_report,now)=>({...pass(),checkedAt:now.toISOString(),status:reduced?'unknown':'pass',
    reasons:reduced?['WALLET_SETUP_SUPPORT_WITHDRAWN']:[]})});
  const schedule=ctx.client.scheduleRequest.bind(ctx.client);let calls=0;
  ctx.client.scheduleRequest=async<T>(weight:number,execute:()=>Promise<T>)=>{if(++calls===2)reduced=true;return schedule(weight,execute);};
  const result=await ctx.controller.consider(profiledCandidate());assert.equal(result.reason,'ENTRY_FLOW_NOT_PASSED');assert.equal(result.order?.status,'failed');
  assert.equal(ctx.readCalls.length,1);assert.equal(ctx.signedCalls.length,0);
});

test('a blocking local wallet revalidation cannot carry an expired candidate past the final submission gate',async t=>{
  let afterQueue=false;
  const ctx=setup(t,{mode:'live',walletEvidence:(_report,now)=>{
    if(afterQueue)ctx.clock.time+=61_000;
    return {...pass(),checkedAt:now.toISOString()};
  }});
  const schedule=ctx.client.scheduleRequest.bind(ctx.client);let calls=0;
  ctx.client.scheduleRequest=async<T>(weight:number,execute:()=>Promise<T>)=>{if(++calls===2)afterQueue=true;return schedule(weight,execute);};
  const result=await ctx.controller.consider(profiledCandidate());assert.equal(result.reason,'ENTRY_CANDIDATE_EXPIRED');assert.equal(result.order?.status,'failed');
  assert.equal(ctx.readCalls.length,1);assert.equal(ctx.signedCalls.length,0);
});

test('missing live readiness never prevents GET reconciliation of legacy accepted orders', async t => {
  const ctx=setup(t,{mode:'live',liveProtection:null,signed:async()=>Response.json({code:0,data:{
    order_id:'legacy-provider',status:'confirmed',hash,
    report:{input_token:inputToken,output_token:token,input_amount:'100',output_amount:'200'},
  }})});
  const saved=ctx.store.reserve({eventKey:'legacy-accepted',chain:'bsc',tokenAddress:token,mode:'live',
    wallet,inputToken,inputAmount:'100',slippagePct:5,details:{}},3,new Date(baseTime)).order!;
  ctx.store.update(saved.id,['prepared'],{status:'unknown',providerOrderId:'legacy-provider'},new Date(baseTime));
  const result=await ctx.controller.reconcile(saved.id);
  assert.equal(result.order?.status,'confirmed');assert.equal(result.order?.outputAmount,'200');
  assert.deepEqual(ctx.signedCalls.map(call=>[call.init?.method,call.url.pathname]),[['GET','/v1/trade/query_order']]);
  assert.equal(ctx.readCalls.length,0);
  assert.equal((await ctx.controller.consider(candidate())).reason,'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED');
  assert.equal(ctx.signedCalls.length,1);
});

test('a protection provider exception after quoting prevents POST and leaves a failed, non-retriable reservation', async t => {
  const ctx=setup(t,{mode:'live',liveProtection:context=>{
    if(context.phase==='before_submit') throw new Error('PRIVATE_PROTECTION_SECRET');
    return {status:'verified',scope:'autonomous_exit_execution',chain:context.chain,wallet:context.wallet,
      checkedAt:new Date(baseTime).toISOString(),validUntil:new Date(baseTime+30_000).toISOString()};
  }});
  const report=candidate(),result=await ctx.controller.consider(report);
  assert.equal(result.reason,'ENTRY_UNATTENDED_PROTECTION_UNVERIFIED');assert.equal(result.order?.status,'failed');
  assert.equal(ctx.signedCalls.length,0);assert.equal(ctx.readCalls.length,1);
  assert.equal((await ctx.controller.consider(report)).status,'existing');
  assert.equal(ctx.readCalls.length,1);assert.equal(ctx.signedCalls.length,0);
});

test('off/demo/noncandidate/unknown checks/stale reports never quote or reserve', async t => {
  const off = setup(t, {mode: 'off'});
  assert.equal((await off.controller.consider(candidate())).reason, 'ENTRY_DISABLED');
  assert.equal(off.store.list().length, 0);
  const ctx = setup(t);
  for (const mutate of [
    (r: Report) => {r.mode = 'demo';},
    (r: Report) => {r.decision = 'WATCH';},
    (r: Report) => {r.buyEligible = false;},
    (r: Report) => {r.safety.status = 'unknown';},
    (r: Report) => {r.provenance.status = 'fail';},
    (r: Report) => {r.narrative.facts.supplierToken = {chain: 'bsc', address: `0x${'f'.repeat(40)}`};},
    (r: Report) => {r.narrative.facts.supplierAddressConflict = {address: `0x${'f'.repeat(40)}`,field:'data.history.ca_address'};},
    (r: Report) => {r.flow!.status = 'unknown';},
    (r: Report) => {r.validUntil = new Date(baseTime).toISOString();},
    (r: Report) => {r.evaluatedAt = 'not a timestamp';},
    (r: Report) => {r.signal.occurredAt = new Date(baseTime - 700_000).toISOString();},
    (r: Report) => {r.safety.facts = {canReplacePrimary: false, scope: 'gmgn_provider_flags_only'};},
  ]) {
    const report = candidate(); mutate(report);
    assert.equal((await ctx.controller.consider(report)).status, 'skipped');
  }
  assert.equal(ctx.readCalls.length, 0); assert.equal(ctx.signedCalls.length, 0); assert.equal(ctx.store.list().length, 0);
});

test('missing or malformed operator amounts, wallet and input token block without guessing', async t => {
  for (const config of [
    {gmgnApiKey: undefined}, {entryWallets: {}}, {entryAmounts: {}}, {entryInputTokens: {}},
    {entryAmounts: {bsc: '1.1'}}, {entryAmounts: {bsc: '1e18'}}, {entryAmounts: {bsc: '0'}},
    {entryAmounts: {bsc: '01'}}, {entryWallets: {bsc: inputToken}},
    {entryInputTokens: {bsc: token}}, {entrySlippagePct: Number.NaN},
  ]) {
    const ctx = setup(t, {config});
    assert.equal((await ctx.controller.consider(candidate())).status, 'blocked');
    assert.equal(ctx.readCalls.length, 0); assert.equal(ctx.store.list().length, 0);
  }
  const live = setup(t, {mode: 'live', config: {gmgnPrivateKey: 'not a PEM'}});
  assert.equal((await live.controller.consider(candidate())).reason, 'ENTRY_SIGNING_KEY_INVALID');
  assert.equal(live.readCalls.length, 0);
});

test('paper uses a real quote with exact atomic strings, never POST or a fabricated fill', async t => {
  const amount = '900719925474099312345';
  const ctx = setup(t, {config: {entryAmounts: {bsc: amount}}});
  const report = candidate();
  report.signal.text = 'DO NOT PERSIST RAW ORIGINAL POST';
  report.narrative.facts = {rawResponse: 'DO NOT PERSIST RAW API BODY'};
  const result = await ctx.controller.consider(report);
  assert.equal(result.status, 'created'); assert.equal(result.order?.status, 'paper_open');
  assert.equal(result.order?.inputAmount, amount);
  assert.equal(ctx.readCalls[0].pathname, '/v1/trade/quote');
  assert.equal(ctx.readCalls[0].searchParams.get('input_amount'), amount);
  assert.equal(result.order?.outputAmount, undefined);
  assert.equal(result.order?.transactionHash, undefined);
  assert.equal(result.order?.details.execution, 'quote_only_no_fill');
  assert.equal((result.order?.details.quote as any).expectedOutputAmount, '123456789012345678901');
  assert.equal(ctx.signedCalls.length, 0);
  assert.equal(JSON.stringify(ctx.store.list()).includes('DO NOT PERSIST'), false);
});

test('reserve precedes IO and concurrent same event plus same asset are idempotent', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const ctx = setup(t, {quote: async () => {await gate; return quote();}});
  const report = candidate();
  const first = ctx.controller.consider(report);
  assert.equal(ctx.store.list()[0].status, 'prepared');
  const second = await ctx.controller.consider(report);
  assert.equal(second.status, 'existing');
  const otherEvent = candidate(); otherEvent.signal.sourceEventId = 'another-event';
  assert.equal((await ctx.controller.consider(otherEvent)).reason, 'ASSET_ALREADY_OPEN');
  release(); await first;
  assert.equal(ctx.readCalls.length, 1); assert.equal(ctx.store.list().length, 1);
});

test('maximum open positions is enforced before another asset is quoted', async t => {
  const ctx = setup(t, {config: {entryMaxOpen: 1}});
  await ctx.controller.consider(candidate());
  const report = candidate(); report.signal.sourceEventId = 'different';
  report.signal.token.address = `0x${'3'.repeat(40)}`;
  assert.equal((await ctx.controller.consider(report)).reason, 'OPENING_LIMIT_REACHED');
  assert.equal(ctx.readCalls.length, 1);
});

test('invalid quote amounts, changed token/amount/slippage or missing fields cannot open', async t => {
  for (const change of [{output_amount: 123}, {min_output_amount: '0'}, {output_token: wallet},
    {input_amount: '123'}, {slippage: 50}, {min_output_amount: '1'}, {output_amount: undefined}]) {
    const ctx = setup(t, {mode: 'live', quote: () => ({...quote(), ...change})});
    const result = await ctx.controller.consider(candidate());
    assert.equal(result.status, 'blocked'); assert.equal(result.order?.status, 'failed');
    assert.equal(ctx.signedCalls.length, 0);
  }
});

test('freshness is checked after quote and again after the signed-request queue', async t => {
  const ctx = setup(t, {mode: 'live', quote: () => {ctx.clock.time += 61_000; return quote();}});
  const result = await ctx.controller.consider(candidate());
  assert.equal(result.reason, 'ENTRY_CANDIDATE_EXPIRED'); assert.equal(ctx.signedCalls.length, 0);
  const late = setup(t, {mode: 'live'});
  const schedule = late.client.scheduleRequest.bind(late.client);
  let scheduled = 0;
  late.client.scheduleRequest = async <T>(weight: number, execute: () => Promise<T>) => {
    scheduled++; if (scheduled === 2) late.clock.time += 61_000;
    return schedule(weight, execute);
  };
  const lateResult = await late.controller.consider(candidate());
  assert.equal(lateResult.reason, 'ENTRY_CANDIDATE_EXPIRED');
  assert.equal(lateResult.order?.status, 'failed'); assert.equal(late.signedCalls.length, 0);
});

test('live signed parameters come only from operator config and verified report identity', async t => {
  const ctx = setup(t, {mode: 'live'});
  const report = candidate();
  report.safety.facts = {wallet: 'attacker', amount: '99999999', input_token: 'evil', slippage: 99};
  report.gmgn = {token: report.signal.token, fetchedAt: report.evaluatedAt, diagnostics: [], info: {
    from_address: 'attacker', input_amount: '9999999999', transaction: 'untrusted raw tx', endpoint: 'https://evil.test',
  }};
  const result = await ctx.controller.consider(report);
  assert.equal(result.order?.status, 'submitted'); assert.equal(ctx.signedCalls.length, 1);
  const {url, init} = ctx.signedCalls[0];
  assert.equal(url.origin, 'https://openapi.gmgn.ai'); assert.equal(url.pathname, '/v1/trade/swap');
  assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
  const body = JSON.parse(String(init?.body));
  assert.equal(body.from_address, wallet); assert.equal(body.input_amount, '1000000000000000');
  assert.equal(body.input_token, inputToken); assert.equal(body.output_token, token); assert.equal(body.slippage, 5);
  assert.equal(body.swap_mode, 'ExactIn'); assert.equal(body.is_anti_mev, true);
  assert.equal(body.transaction, undefined); assert.equal(body.endpoint, undefined);
  const sorted = [...url.searchParams.keys()].sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(url.searchParams.get(k)!)}`).join('&');
  const message = Buffer.from(`${url.pathname}:${sorted}:${init?.body}:${url.searchParams.get('timestamp')}`);
  assert.equal(verify(null, message, keyPair.publicKey, Buffer.from(new Headers(init?.headers).get('x-signature')!, 'base64')), true);
  assert.equal(JSON.stringify(ctx.store.list()).includes(pem), false);
});

test('ambiguous network submission never retries, reopens the asset, or queries without an ID', async t => {
  const ctx = setup(t, {mode: 'live', signed: async () => {throw new Error('secret API key and URL');}});
  const report = candidate();
  const result = await ctx.controller.consider(report);
  assert.equal(result.status, 'created'); assert.equal(result.order?.status, 'unknown');
  assert.equal(result.reason, 'ENTRY_REQUEST_FAILED');
  assert.equal((await ctx.controller.consider(report)).status, 'existing');
  const next = candidate(); next.signal.sourceEventId = 'next';
  assert.equal((await ctx.controller.consider(next)).reason, 'ASSET_ALREADY_OPEN');
  assert.equal((await ctx.controller.reconcile(result.order!.id)).reason, 'ENTRY_ORDER_ID_MISSING_NO_RESUBMIT');
  assert.equal(ctx.signedCalls.length, 1);
  assert.equal(JSON.stringify(ctx.store.list()).includes('secret'), false);
});

test('a timed out POST ignoring abort remains unknown and is submitted only once', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ctx = setup(t, {mode: 'live', signed: async () => new Promise<Response>(() => {})});
  const pending = ctx.controller.consider(candidate());
  for (let i = 0; i < 100 && !ctx.signedCalls.length; i++) await Promise.resolve();
  assert.equal(ctx.signedCalls.length, 1);
  t.mock.timers.tick(12_000);
  const result = await pending;
  assert.equal(result.order?.status, 'unknown'); assert.equal(result.reason, 'ENTRY_REQUEST_TIMEOUT');
  assert.equal((await ctx.controller.consider(candidate())).status, 'existing');
  assert.equal(ctx.signedCalls.length, 1);
});

test('reconcile makes only signed GET and preserves exact actual amounts after explicit success', async t => {
  let calls = 0;
  const ctx = setup(t, {mode: 'live', signed: async () => Response.json({code: 0, data: ++calls === 1
    ? {order_id: 'order-1', status: 'pending'}
    : {order_id: 'order-1', status: 'successful', state: 30, hash,
      report: {input_token: inputToken, output_token: token, input_amount: '1000000000000000', output_amount: '900719925474099312345'}}})});
  const created = await ctx.controller.consider(candidate());
  const result = await ctx.controller.reconcile(created.order!.id);
  assert.equal(ctx.signedCalls[1].init?.method, 'GET'); assert.equal(ctx.signedCalls[1].init?.body, undefined);
  assert.equal(ctx.signedCalls[1].url.pathname, '/v1/trade/query_order');
  assert.equal(ctx.signedCalls[1].url.searchParams.get('order_id'), 'order-1');
  assert.equal(result.order?.status, 'confirmed'); assert.equal(result.order?.transactionHash, hash);
  assert.equal(result.order?.actualInputAmount, '1000000000000000');
  assert.equal(result.order?.outputAmount, '900719925474099312345');
  await ctx.controller.reconcile(created.order!.id); assert.equal(ctx.signedCalls.length, 2);
});

test('confirmed orders without a receipt obtain actual amounts by GET only, even after entry is off', async t => {
  const report = {input_token: inputToken, output_token: token,
    input_amount: '1000000000000000', output_amount: '900719925474099312345'};
  const ctx = setup(t, {mode: 'live', signed: async (_input, init) => Response.json({code: 0, data: {
    order_id: 'order-1', status: 'confirmed', hash,
    ...(init?.method === 'GET' ? {report, raw_extra: 'DO NOT PERSIST RECEIPT BODY'} : {}),
  }})});
  const created = await ctx.controller.consider(candidate());
  assert.equal(created.order?.status, 'confirmed');
  assert.equal(created.order?.actualInputAmount, undefined); assert.equal(created.order?.outputAmount, undefined);
  ctx.config.entryMode = 'off'; ctx.clock.time += 1000;
  const completed = await ctx.controller.reconcile(created.order!.id);
  assert.equal(completed.order?.status, 'confirmed'); assert.equal(completed.order?.transactionHash, hash);
  assert.equal(completed.order?.providerOrderId, 'order-1');
  assert.equal(completed.order?.actualInputAmount, report.input_amount);
  assert.equal(completed.order?.outputAmount, report.output_amount);
  assert.deepEqual(ctx.signedCalls.map(call => call.init?.method), ['POST', 'GET']);
  assert.equal(ctx.signedCalls[1].url.pathname, '/v1/trade/query_order');
  assert.equal(ctx.signedCalls[1].init?.body, undefined);
  assert.equal(JSON.stringify(ctx.store.list()).includes('DO NOT PERSIST'), false);
  await ctx.controller.reconcile(created.order!.id);
  assert.equal(ctx.signedCalls.length, 2);
  ctx.config.entryMode = 'live';
  assert.equal((await ctx.controller.consider(candidate())).status, 'existing');
  assert.equal(ctx.signedCalls.filter(call => call.init?.method === 'POST').length, 1);
});

test('contradictory or malformed fill reads never downgrade confirmed orders or change their hash', async t => {
  const receipt = {input_token: inputToken, output_token: token,
    input_amount: '1000000000000000', output_amount: '900719925474099312345'};
  const confirmed = {order_id: 'order-1', status: 'confirmed', hash, report: receipt};
  for (const data of [
    null, 'malformed', {order_id: 'order-1', status: 'pending'}, {order_id: 'order-1', status: 'failed'},
    {...confirmed, order_id: 'different-order'}, {...confirmed, hash: `0x${'b'.repeat(64)}`},
    {...confirmed, hash: undefined}, {...confirmed, state: 10}, {...confirmed, status: 'pending'},
    {...confirmed, status: 'failed'}, {...confirmed, report: undefined},
    {...confirmed, report: {...receipt, output_token: wallet}},
    {...confirmed, report: {...receipt, input_amount: '1000000000000001'}},
    {...confirmed, report: {...receipt, output_amount: 9007199254740992}},
  ]) {
    const ctx = setup(t, {mode: 'live', signed: async (_input, init) => Response.json({code: 0,
      data: init?.method === 'POST' ? {order_id: 'order-1', status: 'confirmed', hash} : data})});
    const created = await ctx.controller.consider(candidate());
    const before = ctx.store.get(created.order!.id);
    ctx.clock.time += 1000;
    const result = await ctx.controller.reconcile(created.order!.id);
    assert.deepEqual(result.order, before);
    assert.deepEqual(ctx.store.get(created.order!.id), before);
    assert.deepEqual(ctx.signedCalls.map(call => call.init?.method), ['POST', 'GET']);
  }
});

test('confirmed fill completion preserves any known actual amount and rejects conflicting receipts', async t => {
  let actualInput = '999999999999999';
  const ctx = setup(t, {mode: 'live', signed: async (_input, init) => Response.json({code: 0, data: {
    order_id: 'order-1', status: 'successful', state: 30, hash,
    ...(init?.method === 'GET' ? {report: {input_token: inputToken, output_token: token,
      input_amount: actualInput, output_amount: '900719925474099312345'}} : {}),
  }})});
  const created = await ctx.controller.consider(candidate());
  const partial = ctx.store.update(created.order!.id, ['unknown'], {
    status: 'confirmed', actualInputAmount: '1000000000000000',
  })!;
  assert.equal(partial.transactionHash, hash);
  const conflict = await ctx.controller.reconcile(partial.id);
  assert.deepEqual(conflict.order, partial);
  actualInput = partial.actualInputAmount!;
  const completed = await ctx.controller.reconcile(partial.id);
  assert.equal(completed.order?.status, 'confirmed'); assert.equal(completed.order?.transactionHash, hash);
  assert.equal(completed.order?.actualInputAmount, partial.actualInputAmount);
  assert.equal(completed.order?.outputAmount, '900719925474099312345');
  assert.deepEqual(ctx.signedCalls.map(call => call.init?.method), ['POST', 'GET', 'GET']);
});

test('success messages, generic success booleans, wrong state/hash/receipt never imply confirmation', async t => {
  for (const data of [
    {order_id: 'order-1', message: 'success', success: true, hash},
    {order_id: 'order-1', status: 'successful', state: '30', hash},
    {order_id: 'order-1', status: 'confirmed', hash: 'not-a-hash'},
    {order_id: 'order-1', status: 'confirmed', state: 10, hash},
    {order_id: 'order-1', status: 'confirmed', hash, report: {input_token: wallet, output_token: token, input_amount: '1', output_amount: '1'}},
    {order_id: 'order-1', status: 'failed', state: 30, hash},
  ]) {
    const ctx = setup(t, {mode: 'live', signed: async () => Response.json({code: 0, data})});
    assert.equal((await ctx.controller.consider(candidate())).order?.status, 'unknown');
  }
});

test('explicit failed/expired orders are terminal, while failed status reads retain prior state', async t => {
  for (const status of ['failed', 'expired']) {
    const ctx = setup(t, {mode: 'live', signed: async () => Response.json({code: 0, data: {order_id: 'order-1', status}})});
    assert.equal((await ctx.controller.consider(candidate())).order?.status, 'failed');
  }
  let count = 0;
  const ctx = setup(t, {mode: 'live', signed: async () => ++count === 1
    ? Response.json({code: 0, data: {order_id: 'order-1', status: 'pending'}}) : new Response('down', {status: 503})});
  const created = await ctx.controller.consider(candidate());
  const result = await ctx.controller.reconcile(created.order!.id);
  assert.equal(result.status, 'blocked'); assert.equal(result.order?.status, 'submitted');
});

test('429 and malformed POST responses are unknown; POST cooldown also applies to reads', async t => {
  const rate = setup(t, {mode: 'live', signed: async () => new Response('rate', {status: 429,
    headers: {'x-ratelimit-reset': String(baseTime / 1000 + 60)}})});
  const result = await rate.controller.consider(candidate());
  assert.equal(result.order?.status, 'unknown'); assert.equal(rate.client.cooldownUntil, baseTime + 60_000);
  await assert.rejects(rate.client.get('/v1/token/info', {chain: 'bsc', address: token}));
  assert.equal(rate.readCalls.length, 1);
  const bad = setup(t, {mode: 'live', signed: async () => new Response('not JSON')});
  assert.equal((await bad.controller.consider(candidate())).order?.status, 'unknown');
});

test('signed HTTP 429 reset_at updates the shared read cooldown', async t => {
  const ctx = setup(t, {mode: 'live', signed: async () => Response.json(
    {error: 'RATE_LIMIT_BANNED', reset_at: baseTime / 1000 + 300}, {status: 429})});
  const result = await ctx.controller.consider(candidate());
  assert.equal(result.order?.status, 'unknown');
  assert.equal(result.reason, 'ENTRY_RATE_LIMITED');
  assert.equal(ctx.client.cooldownUntil, baseTime + 300_000);
});

test('Solana and Robinhood use explicit chain-specific config without guessing fee or MEV support', async t => {
  for (const chain of ['solana', 'robinhood'] as const) {
    const out = chain === 'solana' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : token;
    const spend = chain === 'solana' ? 'So11111111111111111111111111111111111111112' : inputToken;
    const from = chain === 'solana' ? '11111111111111111111111111111111' : wallet;
    const ctx = setup(t, {mode: 'live', config: {entryWallets: {[chain]: from}, entryAmounts: {[chain]: '100'}, entryInputTokens: {[chain]: spend}},
      quote: () => ({input_token: spend, output_token: out, input_amount: '100', output_amount: '1000', min_output_amount: '950', slippage: 5})});
    const report = candidate(); report.signal.token = {chain, address: out};
    const result = await ctx.controller.consider(report);
    assert.equal(result.order?.status, 'submitted');
    const body = JSON.parse(String(ctx.signedCalls[0].init?.body));
    assert.equal(body.chain, chain === 'solana' ? 'sol' : 'robinhood');
    assert.equal(body.from_address, from);
    assert.equal(body.is_anti_mev, chain === 'solana' ? true : undefined);
    assert.equal(body.gas_price, undefined); assert.equal(body.auto_slippage, undefined);
  }
});

test('RSA request signing follows the official SHA256/PSS format', async t => {
  const rsa = generateKeyPairSync('rsa', {modulusLength: 2048});
  const ctx = setup(t, {mode: 'live', config: {gmgnPrivateKey: rsa.privateKey.export({type: 'pkcs8', format: 'pem'}).toString()}});
  await ctx.controller.consider(candidate());
  const {url, init} = ctx.signedCalls[0];
  const sorted = [...url.searchParams.keys()].sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(url.searchParams.get(k)!)}`).join('&');
  const message = Buffer.from(`${url.pathname}:${sorted}:${init?.body}:${url.searchParams.get('timestamp')}`);
  assert.equal(verify('sha256', message, {key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32},
    Buffer.from(new Headers(init?.headers).get('x-signature')!, 'base64')), true);
});

test('optional narrative statuses and old narrative timestamps allow paper quotes when all hard checks pass',async t=>{
  for(const status of ['unknown','fail'] as const) {
    const ctx=setup(t),report=candidate();
    report.narrative.status=status; report.narrative.reasons=status==='unknown'?['VENDOR_NARRATIVE_MISSING']:['NARRATIVE_CONFLICT_OR_ADVERSE'];
    report.narrative.checkedAt='2020-01-01T00:00:00.000Z';report.narrative.evidence=[];
    const result=await ctx.controller.consider(report);
    assert.equal(result.status,'created');assert.equal(result.order?.status,'paper_open');
    assert.equal(ctx.readCalls.length,1);assert.equal(ctx.signedCalls.length,0);
    assert.equal((result.order?.details.checks as any).narrative.status,status);
  }
});

test('explicit narrative token mismatch remains blocked even with a full social research score',async t=>{
  const ctx=setup(t),report=candidate();
  report.narrative.facts.supplierToken={chain:'robinhood',address:report.signal.token.address};
  report.social={score:30,scope:'research_priority',signals:[],endorsementVerified:false};
  const result=await ctx.controller.consider(report);
  assert.equal(result.reason,'ENTRY_NARRATIVE_TOKEN_IDENTITY_CONFLICT');assert.equal(ctx.readCalls.length,0);
  assert.equal(ctx.signedCalls.length,0);assert.equal(ctx.store.list().length,0);
});
