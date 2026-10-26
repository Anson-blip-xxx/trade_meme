import test from 'node:test';import assert from 'node:assert/strict';import {Keypair,SystemInstruction,SystemProgram} from '@solana/web3.js';import bs58 from 'bs58';
import {JitoSender,jitoEndpoint,jitoTipInstruction,JITO_DONT_FRONT} from '../src/native-solana/jito.js';
const wallet=Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58(),tip=Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
test('Jito only accepts official mainnet HTTPS and forces bundleOnly',()=>{assert.equal(jitoEndpoint('https://tokyo.mainnet.block-engine.jito.wtf'),'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true');
 for(const url of ['http://mainnet.block-engine.jito.wtf','https://evil.test','https://mainnet.block-engine.jito.wtf.evil.test','https://mainnet.block-engine.jito.wtf:443/a','https://mainnet.block-engine.jito.wtf?bundleOnly=false'])assert.throws(()=>jitoEndpoint(url));});
test('tip and readonly nonsigner DontFront marker are in the same System transfer instruction',()=>{const ix=jitoTipInstruction(wallet,tip,'1000');assert.ok(ix.programId.equals(SystemProgram.programId));
 assert.equal(SystemInstruction.decodeTransfer(ix).lamports,1000n);const marker=ix.keys.find(k=>k.pubkey.toBase58()===JITO_DONT_FRONT)!;
 assert.equal(marker.isSigner,false);assert.equal(marker.isWritable,false);assert.throws(()=>jitoTipInstruction(wallet,tip,'999'));});
test('sender uses only protected endpoint and distinguishes signature mismatch from acceptance',async()=>{const sig=bs58.encode(new Uint8Array(64).fill(3)),calls:any[]=[];
 const sender=new JitoSender('https://mainnet.block-engine.jito.wtf',async(input,init)=>{const body=JSON.parse(String(init?.body));calls.push({url:String(input),body});return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='getTipAccounts'?[tip]:sig});},0);
 assert.equal(await sender.tipAccount(),tip);await sender.broadcast('AQID',sig);assert.equal(calls[1].url,'https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true');
 assert.deepEqual(calls[1].body.params,['AQID',{encoding:'base64'}]);await assert.rejects(()=>sender.broadcast('AQID',bs58.encode(new Uint8Array(64).fill(4))),/SIGNATURE_MISMATCH/);
});
test('tip reads and concurrent sends share pacing; reserved send has no post-guard queue wait',async()=>{
 const sig=bs58.encode(new Uint8Array(64).fill(3)),at:number[]=[];
 const sender=new JitoSender('https://mainnet.block-engine.jito.wtf',async(_input,init)=>{at.push(Date.now());const body=JSON.parse(String(init?.body));return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='getTipAccounts'?[tip]:sig});},25);
 await sender.tipAccount();const reserved=await sender.reserveBroadcast();const guarded=Date.now();await reserved.broadcast('AQID',sig);
 await Promise.all([sender.broadcast('AQID',sig),sender.broadcast('AQID',sig)]);
 assert.equal(at.length,4);for(let i=1;i<at.length;i++)assert.ok(at[i]-at[i-1]>=20);assert.ok(at[1]-guarded<20);
});
test('startup warmup fetches tips and consumes the pacing window before the first reserved send',async()=>{
 const sig=bs58.encode(new Uint8Array(64).fill(3)),at:number[]=[];
 const sender=new JitoSender('https://mainnet.block-engine.jito.wtf',async(_input,init)=>{at.push(Date.now());const body=JSON.parse(String(init?.body));
  return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='getTipAccounts'?[tip]:sig});},25);
 const started=Date.now();await sender.warmup();assert.ok(Date.now()-started>=20);
 const reserved=await sender.reserveBroadcast(),ready=Date.now();await reserved.broadcast('AQID',sig);
 assert.equal(at.length,2);assert.ok(at[1]-ready<20);
});
