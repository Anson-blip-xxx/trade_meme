import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import bs58 from 'bs58';
import {evaluate} from '../src/engine.js';
import {fetchDebotNarrative} from '../src/providers/debot-client.js';
import {analyzeVendorNarrative} from '../src/providers/vendor-narrative.js';
import {narrativeIdentityConflict,type Signal} from '../src/types.js';
import {signal,config,providers,now} from './helpers.js';

const other='0x'+'f'.repeat(40),mint='So11111111111111111111111111111111111111112';
function fixture(input=signal()) {
  const raw=JSON.parse(readFileSync(new URL('../fixtures/debot-story-v2.example.json',import.meta.url),'utf8'));
  raw.data.history.ca_address=input.token.address;raw.data.history.story.contract_address=input.token.address;
  return raw;
}
async function automatic(input:Signal,raw:unknown,options:{status?:number;narrativeThrows?:boolean;fetchThrows?:boolean}={}) {
  const p=providers();
  p.vendor=s=>fetchDebotNarrative(s,async()=>{
    if(options.fetchThrows)throw new Error('do not expose provider exception');
    return new Response(JSON.stringify(raw),{status:options.status??200});
  });
  p.narrative=async(s,e,n)=>{
    if(options.narrativeThrows)throw new Error('narrative unavailable');
    return analyzeVendorNarrative(s,e,config(),n);
  };
  return evaluate(input,config(),p,{now:()=>now});
}

test('automatic vendor response checks both explicit CA fields and rejects before optional narrative can erase the conflict',async()=>{
  for(const field of ['ca_address','contract_address'])for(const incomplete of [false,true]) {
    const input=signal(),raw=fixture(input);
    if(field==='ca_address')raw.data.history.ca_address=other;else raw.data.history.story.contract_address=other;
    if(incomplete){delete raw.data.history.generated_at;delete raw.data.history.story.rating;}
    const report=await automatic(input,raw,{narrativeThrows:incomplete});
    assert.equal(report.decision,'REJECT');assert.equal(report.buyEligible,false);
    assert.ok(report.reasons.includes('NARRATIVE_TOKEN_IDENTITY_CONFLICT'));
    assert.ok(report.narrative.reasons.includes('VENDOR_NARRATIVE_TOKEN_MISMATCH'));
    assert.deepEqual(report.narrative.facts.supplierAddressConflict,{address:other,
      field:field==='ca_address'?'data.history.ca_address':'data.history.story.contract_address'});
    assert.equal(report.narrative.supplier,undefined);
    assert.equal(narrativeIdentityConflict(report.signal,report.narrative),true);
  }
});

test('automatic cross-family address conflicts reject without guessing an EVM chain',async()=>{
  for(const input of [signal(),signal({token:{chain:'solana',address:mint}})]) {
    const raw=fixture(input),wrong=input.token.chain==='solana'?other:mint;
    raw.data.history.ca_address=wrong;
    const report=await automatic(input,raw);
    assert.equal(report.decision,'REJECT');assert.equal(report.buyEligible,false);
    assert.deepEqual(report.narrative.facts.supplierAddressConflict,{address:wrong,field:'data.history.ca_address'});
    assert.equal('chain' in (report.narrative.facts.supplierAddressConflict as object),false);
  }
});

test('EVM identity is case insensitive; valid Solana case changes remain distinct addresses',async()=>{
  const input=signal({token:{chain:'bsc',address:'0x'+'a'.repeat(40)}}),raw=fixture(input);
  raw.data.history.ca_address='0x'+'A'.repeat(40);raw.data.history.story.contract_address=raw.data.history.ca_address;
  const same=await automatic(input,raw);
  assert.equal(same.decision,'BUY_CANDIDATE');assert.equal(same.narrative.facts.supplierAddressConflict,undefined);
  const address=bs58.encode(Buffer.alloc(32,17)),index=[...address].findIndex((letter,i)=>i>0&&/[a-hj-km-np-zA-HJ-NP-Z]/.test(letter));
  const letter=address[index],changed=address.slice(0,index)+(letter===letter.toLowerCase()?letter.toUpperCase():letter.toLowerCase())+address.slice(index+1);
  assert.equal(bs58.decode(changed).length,32);assert.notEqual(changed,address);
  const sol=signal({token:{chain:'solana',address}}),solRaw=fixture(sol);solRaw.data.history.ca_address=changed;
  assert.equal((await automatic(sol,solRaw)).decision,'REJECT');
});

test('ordinary malformed, missing, error, failed-fetch and prose-only identity references remain advisory',async()=>{
  const input=signal();
  const cases:{raw:unknown;status?:number;fetchThrows?:boolean}[]=[{raw:null},{raw:{}},{raw:fixture(),status:429},{raw:fixture(),fetchThrows:true}];
  for(const invalid of ['short','0x123','1'.repeat(33),'https://example.test/'+other]) {
    const raw=fixture();raw.data.history.ca_address=invalid;raw.data.history.story.contract_address=invalid;cases.push({raw});
  }
  for(const modify of [
    (raw:any)=>{delete raw.data.history.generated_at;},
    (raw:any)=>{raw.data.version='v3';raw.data.history.ca_address=other;},
    (raw:any)=>{raw.code=404;raw.success=false;raw.data.history.ca_address=other;},
    (raw:any)=>{raw.data.history.story.rating.reason=`Bad sentiment about ${other}`;},
  ]) {const raw=fixture();modify(raw);cases.push({raw});}
  for(const entry of cases) {
    const report=await automatic(input,entry.raw,entry);
    assert.equal(report.decision,'BUY_CANDIDATE');assert.equal(report.buyEligible,true);
    assert.equal(report.narrative.facts.supplierAddressConflict,undefined);
    assert.equal(report.reasons.includes('NARRATIVE_TOKEN_IDENTITY_CONFLICT'),false);
  }
});
