import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {NativeAccountStream,type NativeStreamAccountUpdate,type NativeStreamHead,type NativeStreamReset} from '../src/native-solana/stream.js';
const wallet='11111111111111111111111111111111',account='So11111111111111111111111111111111111111112';
const account2='ComputeBudget111111111111111111111111111111',tokenProgram='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
class Socket extends EventTarget {
  readyState=0;sent:Array<{id:number;method:string;params:unknown[]}>=[];
  send(text:string){this.sent.push(JSON.parse(text));}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
  frame(body:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({jsonrpc:'2.0',...body as object})}));}
  ack(request=this.sent.at(-1)!,result:unknown=100+request.id){this.frame({id:request.id,result});}
  ackAll(){for(const request of [...this.sent])if(request.method.endsWith('Subscribe'))this.ack(request);}
  subscription(method:string,which?:string){const request=this.sent.find(r=>r.method===method&&(which===undefined||r.params[0]===which));assert.ok(request);return 100+request.id;}
  head(slot:number){this.frame({method:'slotNotification',params:{subscription:this.subscription('slotSubscribe'),result:{slot,parent:slot-1,root:slot-2}}});}
  account(slot:number,value:unknown=info(),address=account){this.frame({method:'accountNotification',params:{subscription:this.subscription('accountSubscribe',address),result:{context:{slot},value}}});}
  program(slot:number,address=account2,owner=tokenProgram,tokenOwner=wallet){const bytes=Buffer.alloc(165);new PublicKey(tokenOwner).toBuffer().copy(bytes,32);
    this.frame({method:'programNotification',params:{subscription:this.subscription('programSubscribe',tokenProgram),result:{context:{slot},value:{pubkey:address,account:info(bytes,owner)}}}});}
}
function info(bytes=Buffer.from([1,2,3]),owner=tokenProgram){return {data:[bytes.toString('base64'),'base64'],owner,executable:false,lamports:2039280,rentEpoch:18446744073709551615};}
function fixture(options:{maxHeadAgeMs?:number;reconnectHeadAgeMs?:number;watchdogIntervalMs?:number;now?:()=>number}={},withAccountCallback=true){
  const sockets:Socket[]=[],changes:string[]=[],accounts:NativeStreamAccountUpdate[]=[],heads:NativeStreamHead[]=[],resets:NativeStreamReset[]=[];
  const stream=new NativeAccountStream('wss://rpc.test',wallet,{dirty:a=>changes.push(a),state:()=>{},
    ...(withAccountCallback?{account:(a:NativeStreamAccountUpdate)=>accounts.push(a)}:{}),head:h=>heads.push(h),reset:r=>resets.push(r)},()=>{
    const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;},options);
  return {stream,sockets,changes,accounts,heads,resets};
}

test('native websocket requires real advancing heads and subscription ACKs; pushes decoded bytes synchronously',()=>{
  const f=fixture({now:()=>1000});try{
    f.stream.setAccounts([account]);f.stream.start();const socket=f.sockets[0];socket.open();assert.equal(f.stream.status().connected,false);
    socket.ackAll();assert.equal(f.stream.status().connected,false);socket.head(100);assert.equal(f.stream.status().connected,true);
    socket.account(98);assert.equal(f.accounts.length,1);assert.deepEqual(f.accounts[0].info?.data,Buffer.from([1,2,3]));
    assert.deepEqual({...f.accounts[0],info:undefined},{address:account,info:undefined,slot:98,receivedAtMs:1000,kind:'account',generation:1});
    assert.deepEqual(f.changes,[account]);assert.deepEqual(f.heads,[{slot:100,receivedAtMs:1000,generation:1}]);
    assert.equal(socket.sent.find(r=>r.method==='accountSubscribe')?.params[1]&&
      (socket.sent.find(r=>r.method==='accountSubscribe')?.params[1] as {commitment:string}).commitment,'confirmed');
    socket.close();assert.equal(f.stream.status().connected,false);assert.deepEqual(f.stream.status().subscribedAccounts,[]);
    assert.equal(f.resets.at(-1)?.reason,'disconnect');
  }finally{f.stream.stop();}
});

test('adding and removing accounts preserves the existing websocket and suppresses removed frames',()=>{
  const f=fixture();try{
    f.stream.setAccounts([account]);f.stream.start();const s=f.sockets[0];s.open();s.ackAll();s.head(100);
    f.stream.setAccounts([account,account2]);assert.equal(f.sockets.length,1);assert.equal(f.stream.status().connected,false);
    const addition=s.sent.at(-1)!;assert.equal(addition.method,'accountSubscribe');s.ack(addition);assert.equal(f.stream.status().connected,true);
    f.stream.setAccounts([account2]);const removal=s.sent.at(-1)!;assert.equal(removal.method,'accountUnsubscribe');
    assert.equal(f.stream.status().connected,true);assert.deepEqual(f.stream.status().subscribedAccounts,[account2]);
    s.account(100);assert.equal(f.accounts.length,0);s.account(100,info(),account2);assert.equal(f.accounts.length,1);
    s.ack(removal,true);assert.equal(f.sockets.length,1);assert.equal(f.stream.status().connected,true);
    assert.deepEqual(f.resets.at(-1),{generation:1,reason:'accounts_removed',accounts:[account]});
  }finally{f.stream.stop();}
});

test('pending new subscriptions do not suspend existing positions, while stale transport suspends every position',()=>{
  let now=1000;const f=fixture({now:()=>now});try{
    f.stream.setAccounts([account]);f.stream.start();const s=f.sockets[0];s.open();s.ackAll();
    assert.equal(f.stream.status().transportHealthy,false);assert.equal(f.stream.isSubscribed([account]),false);
    s.head(100);assert.equal(f.stream.status().transportHealthy,true);assert.equal(f.stream.isSubscribed([account]),true);
    f.stream.setAccounts([account,account2]);assert.equal(f.stream.status().connected,false);
    assert.equal(f.stream.status().transportHealthy,true);assert.equal(f.stream.isSubscribed([account]),true);
    assert.equal(f.stream.isSubscribed([account2]),false);assert.equal(f.stream.isSubscribed([account,account2]),false);
    s.ack();assert.equal(f.stream.isSubscribed([account,account2]),true);
    now=2501;assert.equal(f.stream.status().transportHealthy,false);assert.equal(f.stream.isSubscribed([account]),false);
    assert.equal(f.stream.isSubscribed([account2]),false);assert.equal(f.stream.isSubscribed([]),false);
  }finally{f.stream.stop();}
});

test('late subscribe ACK after removal is unsubscribed and cannot restore a removed account',()=>{
  const f=fixture();try{
    f.stream.setAccounts([account]);f.stream.start();const s=f.sockets[0];s.open();
    const pending=s.sent.find(r=>r.method==='accountSubscribe')!;f.stream.setAccounts([]);s.ack(pending);
    assert.equal(s.sent.at(-1)?.method,'accountUnsubscribe');assert.deepEqual(f.stream.status().subscribedAccounts,[]);
    s.account(100);assert.equal(f.accounts.length,0);
  }finally{f.stream.stop();}
});

test('remove then re-add while ACK is pending creates only one active subscription',()=>{
  const f=fixture();try{
    f.stream.setAccounts([account]);f.stream.start();const s=f.sockets[0];s.open();f.stream.setAccounts([]);f.stream.setAccounts([account]);
    assert.equal(s.sent.filter(r=>r.method==='accountSubscribe').length,1);s.ackAll();s.head(100);
    assert.equal(f.stream.status().connected,true);assert.deepEqual(f.stream.status().subscribedAccounts,[account]);
  }finally{f.stream.stop();}
});

test('empty holding watch still delivers one newly created wallet token account without fan-out',()=>{
  const f=fixture();try{
    f.stream.start();const s=f.sockets[0];s.open();s.ackAll();s.head(100);s.program(98);
    assert.equal(f.accounts.length,1);assert.equal(f.accounts[0].kind,'wallet');assert.equal(f.accounts[0].address,account2);assert.deepEqual(f.changes,[]);
    f.stream.setAccounts([account,account2]);s.ack(s.sent.at(-2)!);s.ack(s.sent.at(-1)!);s.program(99);
    assert.equal(f.accounts.length,2);assert.deepEqual(f.changes,[]);
  }finally{f.stream.stop();}
});

test('legacy wallet callback invalidates only the changed token account once',()=>{
  const f=fixture({},false);try{f.stream.setAccounts([account,account2]);f.stream.start();const s=f.sockets[0];s.open();s.ackAll();s.program(98);
    assert.deepEqual(f.changes,[account2]);
  }finally{f.stream.stop();}
});

test('known wallet token closure normalizes empty zero-lamport System frames to null; unknown or malformed closures are ignored',()=>{
  const f=fixture();try{
    f.stream.start();const s=f.sockets[0];s.open();s.ackAll();s.head(100);
    const close=(slot:number,address=account2,value:unknown={...info(Buffer.alloc(0),wallet),lamports:0},program=tokenProgram)=>s.frame({method:'programNotification',
      params:{subscription:s.subscription('programSubscribe',program),result:{context:{slot},value:{pubkey:address,account:value}}}});
    close(99);assert.equal(f.accounts.length,0,'unseen empty accounts are not wallet inventory');
    s.program(100);assert.equal(f.accounts.length,1);
    close(101,account2,info(Buffer.alloc(0),wallet));assert.equal(f.accounts.length,1,'nonzero lamports are not a token closure');
    close(101,account2,{...info(Buffer.from([1]),wallet),lamports:0});assert.equal(f.accounts.length,1,'nonempty System data cannot close inventory');
    close(101,account2,{...info(Buffer.alloc(0),wallet),lamports:0,executable:true});assert.equal(f.accounts.length,1);
    close(101,account2,{...info(Buffer.alloc(0),wallet),lamports:0},'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');assert.equal(f.accounts.length,1,'closure must match the original token program');
    close(101);assert.equal(f.accounts.length,2);assert.equal(f.accounts[1].kind,'wallet');assert.equal(f.accounts[1].info,null);
    assert.equal(f.accounts[1].slot,101);assert.deepEqual(f.changes,[]);
    close(100);assert.equal(f.accounts.length,2,'a late closure cannot replace newer wallet state');
  }finally{f.stream.stop();}
});

test('a subscribed token account can establish ownership before its first wallet-program frame is a closure',()=>{
  const f=fixture();try{
    f.stream.setAccounts([account2]);f.stream.start();const s=f.sockets[0];s.open();s.ackAll();s.head(100);
    const bytes=Buffer.alloc(165);new PublicKey(wallet).toBuffer().copy(bytes,32);s.account(99,info(bytes),account2);
    s.frame({method:'programNotification',params:{subscription:s.subscription('programSubscribe',tokenProgram),
      result:{context:{slot:100},value:{pubkey:account2,account:{...info(Buffer.alloc(0),wallet),lamports:0}}}}});
    assert.equal(f.accounts.length,2);assert.equal(f.accounts[1].kind,'wallet');assert.equal(f.accounts[1].info,null);
  }finally{f.stream.stop();}
});

test('rejects mismatched methods, invalid owners/base64/slots, and wallet accounts owned by someone else',()=>{
  const f=fixture();try{f.stream.setAccounts([account]);f.stream.start();const s=f.sockets[0];s.open();s.ackAll();
    s.frame({method:'accountNotification',params:{subscription:s.subscription('slotSubscribe'),result:{slot:100,parent:99,root:98}}});
    assert.equal(f.stream.status().connected,false);
    const base={subscription:s.subscription('accountSubscribe',account),result:{context:{slot:100},value:info()}};
    s.frame({method:'programNotification',params:base});s.frame({method:'accountNotification',params:{...base,subscription:9999}});
    s.account(-1);s.account(100,{...info(),data:['%%%%','base64']});s.account(100,{...info(),data:['AQJ=','base64']});
    s.account(100,{...info(),owner:'invalid'});s.account(100,{...info(),lamports:NaN});s.account(100,{...info(),executable:'false'});
    s.program(100,account2,wallet);s.program(100,account2,tokenProgram,account);assert.equal(f.accounts.length,0);assert.equal(f.changes.length,0);
    s.account(100,null);assert.equal(f.accounts.length,1);assert.equal(f.accounts[0].info,null);
  }finally{f.stream.stop();}
});

test('older account slots cannot overwrite newer state and duplicate/older heads cannot renew freshness',()=>{
  let now=1000;const f=fixture({now:()=>now});try{f.stream.setAccounts([account]);f.stream.start();const s=f.sockets[0];s.open();s.ackAll();s.head(100);
    s.account(100);s.account(99);s.account(100,info(Buffer.from([4])));assert.equal(f.accounts.length,2);assert.equal(f.accounts.at(-1)?.info?.data[0],4);
    now=2600;s.head(100);s.head(99);assert.equal(f.heads.length,1);assert.equal(f.stream.status().connected,false);s.head(101);assert.equal(f.stream.status().connected,true);
    assert.equal(f.resets.at(-1)?.reason,'head_stale');assert.equal(f.heads.at(-1)?.generation,2);
  }finally{f.stream.stop();}
});

test('stale head invalidates caches quickly without reconnect churn; recovery advances generation',async()=>{
  let now=1000;const f=fixture({now:()=>now,maxHeadAgeMs:100,reconnectHeadAgeMs:1000,watchdogIntervalMs:10});try{
    f.stream.setAccounts([account]);f.stream.start();const s=f.sockets[0];s.open();s.ackAll();s.head(100);s.account(99);
    now=1101;await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.stream.status().connected,false);
    assert.equal(f.resets.filter(r=>r.reason==='head_stale').length,1);assert.equal(f.sockets.length,1);assert.equal(s.readyState,1);
    await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.resets.filter(r=>r.reason==='head_stale').length,1);
    now=1102;s.head(101);s.account(100);assert.equal(f.stream.status().connected,true);assert.equal(f.accounts.at(-1)?.generation,2);
  }finally{f.stream.stop();}
});

test('closed socket generations cannot supply prices; reconnection requires fresh ACKs and head',async()=>{
  let now=1000;const f=fixture({now:()=>now,watchdogIntervalMs:10});try{
    f.stream.setAccounts([account]);f.stream.start();const first=f.sockets[0];first.open();first.ackAll();first.head(100);first.close();
    now=4001;await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.sockets.length,2);const second=f.sockets[1];second.open();
    first.account(100);assert.equal(f.accounts.length,0);second.ackAll();assert.equal(f.stream.status().connected,false);
    second.head(101);assert.equal(f.stream.status().connected,true);second.account(100);assert.equal(f.accounts.at(-1)?.generation,3);
  }finally{f.stream.stop();}
});

test('failed subscription stays unhealthy without disconnecting; conflicting subscription identities disconnect',()=>{
  const f=fixture();try{f.stream.setAccounts([account]);f.stream.start();const s=f.sockets[0];s.open();
    s.frame({id:s.sent[0].id,error:{code:-32005}});assert.equal(f.stream.status().connected,false);assert.equal(s.readyState,1);
  }finally{f.stream.stop();}
  const other=fixture();try{other.stream.setAccounts([account]);other.stream.start();const s=other.sockets[0];s.open();s.ack(s.sent[0],100);s.ack(s.sent[1],100);
    assert.equal(s.readyState,3);assert.equal(other.stream.status().connected,false);
  }finally{other.stream.stop();}
});

test('a missing account ACK retries alone and late distinct IDs are unsubscribed without disturbing existing holdings',async()=>{
  let now=1000;const f=fixture({now:()=>now,maxHeadAgeMs:15000,reconnectHeadAgeMs:20000,watchdogIntervalMs:10});try{
    f.stream.setAccounts([account,account2]);f.stream.start();const s=f.sockets[0];s.open();
    const missed=s.sent.find(r=>r.method==='accountSubscribe'&&r.params[0]===account2)!;
    for(const r of s.sent)if(r.id!==missed.id)s.ack(r);s.head(100);
    assert.equal(f.stream.isSubscribed([account]),true);assert.equal(f.stream.isSubscribed([account2]),false);
    assert.equal(f.stream.status().pendingAccounts,1);assert.equal(f.stream.status().failedAccounts,0);
    now=4001;await new Promise(resolve=>setTimeout(resolve,25));
    const retry=s.sent.at(-1)!;assert.equal(retry.method,'accountSubscribe');assert.equal(retry.params[0],account2);
    assert.equal(s.sent.filter(r=>r.method==='accountSubscribe'&&r.params[0]===account).length,1);
    s.ack(retry,800);assert.equal(f.stream.status().connected,true);s.ack(missed,801);
    assert.equal(s.sent.at(-1)?.method,'accountUnsubscribe');assert.deepEqual(s.sent.at(-1)?.params,[801]);
    s.frame({id:s.sent.at(-1)?.id,error:{code:-32602}});
    assert.equal(f.stream.status().connected,true);assert.equal(f.sockets.length,1);assert.equal(s.readyState,1);
    s.frame({method:'accountNotification',params:{subscription:801,result:{context:{slot:100},value:info()}}});
    assert.equal(f.accounts.length,0,'extra subscription IDs cannot deliver duplicate updates');
    s.frame({method:'accountNotification',params:{subscription:800,result:{context:{slot:100},value:info()}}});assert.equal(f.accounts.length,1);
  }finally{f.stream.stop();}
});

test('retry responses for the same label and subscription ID are idempotent',async()=>{
  let now=1000;const f=fixture({now:()=>now,maxHeadAgeMs:15000,reconnectHeadAgeMs:20000,watchdogIntervalMs:10});try{
    f.stream.setAccounts([account]);f.stream.start();const s=f.sockets[0];s.open();
    const first=s.sent.find(r=>r.method==='accountSubscribe')!;
    for(const r of s.sent)if(r.id!==first.id)s.ack(r);s.head(100);
    now=4001;await new Promise(resolve=>setTimeout(resolve,25));const retry=s.sent.at(-1)!;
    s.ack(first,800);s.ack(retry,800);
    assert.equal(f.stream.status().connected,true);assert.deepEqual(f.stream.status().subscribedAccounts,[account]);
    assert.equal(s.sent.filter(r=>r.method.endsWith('Unsubscribe')).length,0);assert.equal(s.readyState,1);
  }finally{f.stream.stop();}
});

test('unanswered subscriptions stop after three attempts, expose failed counts, and accept a later genuine ACK',async()=>{
  let now=1000;const f=fixture({now:()=>now,maxHeadAgeMs:15000,reconnectHeadAgeMs:20000,watchdogIntervalMs:10});try{
    f.stream.setAccounts([account,account2]);f.stream.start();const s=f.sockets[0];s.open();
    const missed=s.sent.find(r=>r.method==='accountSubscribe'&&r.params[0]===account2)!;
    for(const r of s.sent)if(r.id!==missed.id)s.ack(r);s.head(100);
    for(const at of [4001,7002,10003,13004]){now=at;await new Promise(resolve=>setTimeout(resolve,25));}
    assert.equal(s.sent.filter(r=>r.method==='accountSubscribe'&&r.params[0]===account2).length,3);
    assert.equal(f.stream.status().failedAccounts,1);assert.equal(f.stream.status().pendingAccounts,0);
    assert.equal(f.stream.status().failedSubscriptions,1);assert.equal(f.stream.status().pendingSubscriptions,0);
    assert.equal(f.stream.isSubscribed([account]),true);assert.equal(f.stream.isSubscribed([account2]),false);assert.equal(s.readyState,1);
    s.ack(missed);assert.equal(f.stream.status().connected,true);assert.equal(f.stream.status().failedAccounts,0);
    assert.equal(f.stream.status().failedSubscriptions,0);
  }finally{f.stream.stop();}
});

test('slot and wallet program ACKs use the same bounded recovery and never count as healthy until acknowledged',async()=>{
  let now=1000;const f=fixture({now:()=>now,maxHeadAgeMs:15000,reconnectHeadAgeMs:20000,watchdogIntervalMs:10});try{
    f.stream.setAccounts([account]);f.stream.start();const s=f.sockets[0];s.open();
    const missed=s.sent.filter(r=>r.method==='slotSubscribe'||r.method==='programSubscribe'&&r.params[0]===tokenProgram);
    for(const r of s.sent)if(!missed.includes(r))s.ack(r);
    assert.equal(f.stream.status().transportHealthy,false);assert.equal(f.stream.status().pendingSubscriptions,2);
    assert.equal(f.stream.status().pendingAccounts,0);
    now=4001;await new Promise(resolve=>setTimeout(resolve,25));
    const retried=s.sent.filter(r=>r.id>4);assert.deepEqual(retried.map(r=>r.method),['slotSubscribe','programSubscribe']);
    for(const r of retried)s.ack(r);
    assert.equal(f.stream.status().transportHealthy,false,'ACKs alone are insufficient without a new head');
    const slotRetry=retried.find(r=>r.method==='slotSubscribe')!;
    s.frame({method:'slotNotification',params:{subscription:100+slotRetry.id,result:{slot:100,parent:99,root:98}}});
    assert.equal(f.stream.status().transportHealthy,true);assert.equal(f.stream.status().connected,true);
  }finally{f.stream.stop();}
});

test('subscription cap rejects excess accounts without changing the previous watch set',()=>{
  const f=fixture();try{f.stream.setAccounts([account]);const many=Array.from({length:121},(_,i)=>new PublicKey(Buffer.alloc(32,i+1)).toBase58());
    assert.throws(()=>f.stream.setAccounts(many),/NATIVE_SUBSCRIPTION_LIMIT/);assert.equal(f.stream.status().requestedAccounts,1);
  }finally{f.stream.stop();}
});
