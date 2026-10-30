import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,verify} from 'node:crypto';
import {GmgnClient,GmgnError} from '../src/providers/gmgn-client.js';

const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
const rejects=(reason:string)=>(error:unknown)=>error instanceof GmgnError&&error.reason===reason;
const sol='11111111111111111111111111111111';

test('Plus research POSTs use fixed endpoint, exact grouped signal body and repeated wallet query values',async()=>{
  const requests:{url:URL;init?:RequestInit}[]=[];
  const client=new GmgnClient({apiKey:`plus-${randomUUID()}`,minIntervalMs:0,fetcher:async(input,init)=>{
    requests.push({url:new URL(String(input)),init});return response({code:0,data:[]});}});
  await client.getMemeMarketSignals('sol');await client.getWalletStats('sol',[sol,'22222222222222222222222222222222']);
  assert.equal(requests[0].url.pathname,'/v1/market/token_signal');assert.equal(requests[0].init?.method,'POST');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)),{chain:'sol',groups:[{signal_type:[12]},{signal_type:[20]},
    {signal_type:[13,19]},{signal_type:[6,7]},{signal_type:[10,11]},{signal_type:[17,18,21]}]});
  assert.equal(requests[1].url.pathname,'/v1/user/wallet_stats');
  assert.deepEqual(requests[1].url.searchParams.getAll('wallet_address'),[sol,'22222222222222222222222222222222']);
});

test('follow-wallet signature matches CLI canonical Ed25519 message and never exposes a generic signed route',async()=>{
  const pair=generateKeyPairSync('ed25519'),pem=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString();let checked=false;
  const client=new GmgnClient({apiKey:`signed-${randomUUID()}`,privateKeyPem:pem,minIntervalMs:0,now:()=>1_800_000_000_000,
    fetcher:async(input,init)=>{const url=new URL(String(input)),headers=new Headers(init?.headers),query:Record<string,string|string[]>={};
      for(const key of new Set(url.searchParams.keys())){const values=url.searchParams.getAll(key);query[key]=values.length===1?values[0]:values;}
      const sorted=Object.keys(query).sort().flatMap(key=>{const value=query[key],ek=encodeURIComponent(key);
        return Array.isArray(value)?[...value].sort().map(item=>`${ek}=${encodeURIComponent(item)}`):[`${ek}=${encodeURIComponent(value)}`];}).join('&');
      const message=`${url.pathname}:${sorted}::${url.searchParams.get('timestamp')}`;
      checked=verify(null,Buffer.from(message),pair.publicKey,Buffer.from(headers.get('x-signature')!,'base64'));
      return response({code:0,data:{list:null,next_page_token:''}});}});
  assert.deepEqual(await client.getFollowWallet('sol'),{list:null,next_page_token:''});assert.equal(checked,true);
  await assert.rejects(new GmgnClient({apiKey:`unsigned-${randomUUID()}`}).getFollowWallet('sol'),rejects('GMGN_SIGNING_KEY_MISSING'));
});

test('wallet holdings and callout records use fixed read-only routes and bounded pagination',async()=>{
  const pair=generateKeyPairSync('ed25519'),pem=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(),requests:{url:URL;init?:RequestInit}[]=[];
  const client=new GmgnClient({apiKey:`dossier-${randomUUID()}`,privateKeyPem:pem,minIntervalMs:0,fetcher:async(input,init)=>{
    requests.push({url:new URL(String(input)),init});return response({code:0,data:{list:[],next:''}});}});
  await client.getWalletHoldings('sol',sol,{limit:50,cursor:'next-page',closedOnly:true});
  await client.getCalloutRecord('sol',sol,{limit:50,pageToken:'call-page'});
  assert.equal(requests[0].url.pathname,'/v1/user/wallet_holdings');
  assert.equal(requests[0].url.searchParams.get('hide_closed'),'false');
  assert.equal(requests[0].url.searchParams.get('hide_open'),'true');
  assert.equal(requests[0].url.searchParams.get('cursor'),'next-page');
  assert.ok(new Headers(requests[0].init?.headers).get('x-signature'));
  assert.equal(requests[1].url.pathname,'/v1/callout/get_record');
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)),{chain:'sol',call_wallet:sol,limit:50,page_token:'call-page'});
  await assert.rejects(new GmgnClient({apiKey:`unsigned-holdings-${randomUUID()}`}).getWalletHoldings('sol',sol),
    rejects('GMGN_SIGNING_KEY_MISSING'));
});

test('live entry interrupts an in-flight archive HTTP read on the same credential lane',async()=>{
  const key=`priority-${randomUUID()}`;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let calls=0;
  const client=new GmgnClient({apiKey:key,minIntervalMs:0,fetcher:async(_input,init)=>{calls++;
    if(calls===1){entered();return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));}
    return response({code:0,data:'live'});}});
  const background=client.getMemeMarketSignals('sol');await started;
  const live=client.get('/v1/token/info',{chain:'sol',address:sol},1,{priority:'live_entry'});
  await assert.rejects(background,rejects('GMGN_REQUEST_ABORTED'));assert.equal(await live,'live');assert.equal(calls,2);
});

test('an expired callout cursor is classified without reflecting upstream response text',async()=>{
  const client=new GmgnClient({apiKey:`cursor-${randomUUID()}`,minIntervalMs:0,fetcher:async()=>response({message:'secret'},400)});
  await assert.rejects(client.getCalloutGlobal(['sol'],{pageToken:'expired'}),rejects('GMGN_CURSOR_INVALID'));
  await assert.rejects(client.getCalloutRecord('sol',sol,{pageToken:'expired'}),rejects('GMGN_CURSOR_INVALID'));
  await assert.rejects(client.getWalletActivity('sol',sol,'expired'),rejects('GMGN_CURSOR_INVALID'));
});
