import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {assessSocialSignals,DEFAULT_SOCIAL_PROFILES,type SocialProfile} from '../src/social-signals.js';
import type {Evidence,Signal} from '../src/types.js';
import type {GmgnTokenSnapshot} from '../src/providers/gmgn-safety.js';
import {signal,now,token,evidence} from './helpers.js';

function snapshot(link:Record<string,unknown>,input=signal()):GmgnTokenSnapshot {
  return {token:input.token,fetchedAt:now.toISOString(),info:{address:input.token.address,chain:input.token.chain,link},diagnostics:[{section:'info',status:'ok'}]};
}
// Fixture IDs are deliberately artificial; production IDs remain unverified until backed by a primary source.
const profiles:SocialProfile[]=DEFAULT_SOCIAL_PROFILES.map((profile,index)=>({...profile,accountId:String(101+index),
  accountIdVerification:'primary',accountIdSource:'https://x.com/i/user/'+(101+index)}));
const post=(id='1',authorId='101',input=signal()):Evidence=>({...evidence()[0],id:`x:${id}`,url:`https://x.com/i/web/status/${id}`,
  authorId,text:`引用 ${input.token.address}`});
const assess=(link:Record<string,unknown>,posts:Evidence[]=[])=>assessSocialSignals(signal(),posts,{now,snapshot:snapshot(link),profiles});

test('verified organizational handles are chain scoped and numeric account IDs are not guessed',()=>{
  assert.deepEqual(DEFAULT_SOCIAL_PROFILES.map(item=>[item.person,item.handle,item.chains]),[
    ['cz','cz_binance',['bsc']],['he_yi','heyibinance',['bsc']],['toly','aeyakovenko',['solana']],['elon','elonmusk',['solana']]]);
  assert.ok(DEFAULT_SOCIAL_PROFILES.every(item=>item.accountId===null&&item.accountIdVerification==='unverified'));
  assert.equal(assess({twitter_username:'CZ_BINANCE',website:'https://twitter.com/heyibinance'}).score,10);
  assert.equal(assess({twitter_username:'elonmusk',website:'https://x.com/aeyakovenko'}).score,0);
  const sol=signal({token:{chain:'solana',address:bs58.encode(new Uint8Array(32).fill(7))}});
  const result=assessSocialSignals(sol,[],{now,snapshot:snapshot({twitter_username:'elonmusk',website:'https://x.com/aeyakovenko'},sol)});
  assert.equal(result.score,10); assert.equal(result.endorsementVerified,false); assert.equal(result.scope,'research_priority');
});

test('project-supplied profile links are weak signals, deduplicated per account, and never endorsements',()=>{
  const result=assess({twitter_username:'@cz_binance',website:'https://x.com/CZ_BINANCE?ref=project'});
  assert.equal(result.score,5); assert.equal(result.signals.length,1);
  assert.deepEqual(result.signals[0],{person:'cz',label:'CZ',kind:'profile_link',weight:5,
    sourceUrl:'https://x.com/cz_binance',verification:'project_link'});
  assert.equal(result.endorsementVerified,false);
});

test('forged domains, misleading paths and lookalike handles do not get priority',()=>{
  for(const value of ['https://x.com.evil.test/cz_binance','https://x.com@evil.test/cz_binance',
    'https://evil.test/?redirect=https://x.com/cz_binance','http://x.com/cz_binance','https://x.com:444/cz_binance',
    'https://x.com/cz_binance_fake','https://x.com/cz_binance/other','https://x.com/cz_bınance',
    'https://x.com/cz_binance/status/not-an-id','https://x.com/other?name=cz_binance','cz_binance_extra']) {
    assert.equal(assess({website:value,twitter_username:value}).score,0,value);
  }
});

test('metadata links to a celebrity post remain weak project claims and preserve the checkable post URL',()=>{
  for(const field of ['twitter_username','website']) {
    const result=assess({[field]:'https://twitter.com/CZ_BINANCE/status/123456?s=20'});
    assert.equal(result.score,5); assert.equal(result.signals[0].kind,'profile_link');
    assert.equal(result.signals[0].verification,'project_link');
    assert.equal(result.signals[0].sourceUrl,'https://x.com/cz_binance/status/123456');
    assert.equal(result.endorsementVerified,false);
  }
  for(const url of ['https://x.com/i/web/status/123456','https://x.com/cz_binance_fake/status/123456',
    'https://x.com.evil.test/cz_binance/status/123456','https://x.com/cz_binance/status/123456/more'])
    assert.equal(assess({website:url,twitter_username:url}).score,0);
});

test('AI narrative mentions, metadata descriptions and mere evidence links do not become celebrity signals',()=>{
  const input=signal({text:'CZ何一背书',evidenceUrls:['https://x.com/cz_binance/status/1']});
  const result=assessSocialSignals(input,[],{now,snapshot:snapshot({description:'CZ @cz_binance 何一 heyibinance 推荐',
    social_links:['https://x.com/cz_binance'],twitter:'https://x.com/cz_binance'})});
  assert.equal(result.score,0);
});

test('GMGN metadata requires bound chain, full contract, successful info and fresh snapshot',()=>{
  const base=snapshot({twitter_username:'cz_binance'});
  const patches:GmgnTokenSnapshot[]=[
    {...base,token:{chain:'robinhood',address:token}}, {...base,token:{chain:'bsc',address:`0x${'f'.repeat(40)}`}},
    {...base,info:{...(base.info as object),address:`0x${'f'.repeat(40)}`}}, {...base,info:{link:{twitter_username:'cz_binance'}}},
    {...base,info:{...(base.info as object),chain:'sol'}},
    {...base,fetchedAt:new Date(now.getTime()-21_601_000).toISOString()}, {...base,fetchedAt:new Date(now.getTime()+1).toISOString()},
    {...base,diagnostics:[{section:'info',status:'unavailable',reason:'GMGN_TOKEN_MISMATCH'}]},
  ];
  for(const value of patches) assert.equal(assessSocialSignals(signal(),[],{now,snapshot:value}).score,0);
});

test('pinned numeric author identity and original full-CA content replace weak links without duplicate rewards',()=>{
  const result=assess({twitter_username:'cz_binance'},[post(),post('2'),post('3')]);
  assert.equal(result.score,20); assert.equal(result.signals.length,1);
  assert.equal(result.signals[0].kind,'ca_post'); assert.equal(result.signals[0].verification,'first_party');
  assert.equal(result.signals[0].evidenceId,'x:1'); assert.equal(result.endorsementVerified,false);
  const both=assess({twitter_username:'cz_binance',website:'https://x.com/heyibinance'},[post(),post('4','102')]);
  assert.equal(both.score,30); assert.equal(both.signals.length,2);
});

test('third-party post copies stay explicitly third-party, with first-party evidence preferred for the same author',()=>{
  const copied:Evidence={...post(),provider:'fxembed',verification:'third_party'};
  const result=assess({},[copied]); assert.equal(result.score,20); assert.equal(result.signals[0].verification,'third_party');
  const upgraded=assess({},[copied,post('2')]); assert.equal(upgraded.score,20); assert.equal(upgraded.signals[0].verification,'first_party');
  assert.equal(upgraded.signals[0].evidenceId,'x:2');
});

test('unverified numeric IDs and handle-only post URLs cannot identify a celebrity author',()=>{
  const posts=[{...post(),url:'https://x.com/cz_binance/status/1'}];
  assert.equal(assessSocialSignals(signal(),posts,{now}).score,0);
  const unverified=profiles.map(item=>({...item,accountIdVerification:'unverified' as const}));
  assert.equal(assessSocialSignals(signal(),posts,{now,profiles:unverified}).score,0);
  assert.equal(assess({},[{...post(),authorId:'999',url:'https://x.com/cz_binance/status/1'}]).score,0);
});

test('stale, future, identity-mismatched and wrong-CA posts never earn stronger priority',()=>{
  const base=post();
  for(const invalid of [
    {...base,text:`other 0x${'f'.repeat(40)}`},{...base,text:`${token}0`},{...base,text:`${token}Z`},
    {...base,publishedAt:new Date(now.getTime()-21_601_000).toISOString()}, {...base,publishedAt:new Date(now.getTime()+1).toISOString()},
    {...base,fetchedAt:new Date(now.getTime()+1).toISOString()}, {...base,id:'x:999'},
    {...base,url:'https://evil.test/cz_binance/status/1'}, {...base,url:'https://x.com/heyibinance/status/1'},
    {...base,verification:'third_party' as const}, {...base,provider:'fxembed' as const,verification:'first_party' as const},
  ]) assert.equal(assess({},[invalid]).score,0);
});

test('Solana CA matching preserves case while EVM matching allows checksum casing',()=>{
  assert.equal(assess({},[{...post(),text:token.toUpperCase().replace('0X','0x')}]).score,20);
  const input:Signal=signal({token:{chain:'solana',address:bs58.encode(new Uint8Array(32).fill(3))}});
  const strong={...post('1','103',input),text:input.token.address};
  assert.equal(assessSocialSignals(input,[strong],{now,profiles}).score,20);
  assert.equal(assessSocialSignals(input,[{...strong,text:input.token.address.toLowerCase()}],{now,profiles}).score,0);
});
