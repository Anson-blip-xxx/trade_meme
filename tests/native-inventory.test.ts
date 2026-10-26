import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,SystemProgram,type AccountInfo} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ExtensionType,getAccountLen,getTypeLen,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {NativeInventoryCache} from '../src/native-solana/inventory.js';

const key=(n:number)=>new PublicKey(Buffer.alloc(32,n)),wallet=key(1),mint=key(2),otherMint=key(3),now=1_793_016_000_000;
const standard=TOKEN_PROGRAM_ID.toBase58(),token2022=TOKEN_2022_PROGRAM_ID.toBase58();
function token(amount:bigint,{program=TOKEN_PROGRAM_ID,owner=wallet,tokenMint=mint,extension,state=1}:{program?:PublicKey;owner?:PublicKey;tokenMint?:PublicKey;extension?:ExtensionType;state?:number}={}):AccountInfo<Buffer>{
  const data=Buffer.alloc(extension===undefined?165:getAccountLen([extension]));
  AccountLayout.encode({mint:tokenMint,owner,amount,delegateOption:0,delegate:PublicKey.default,state,
    isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  if(extension!==undefined){data[165]=2;data.writeUInt16LE(extension,166);data.writeUInt16LE(getTypeLen(extension),168);}
  return {data,owner:program,lamports:2039280,executable:false,rentEpoch:0};
}
const row=(pubkey:PublicKey,amount:bigint,options:Parameters<typeof token>[1]={})=>({pubkey,account:token(amount,options)});
function fixture(){const cache=new NativeInventoryCache(wallet.toBase58());cache.track(mint.toBase58(),6,standard);return cache;}
function ready(cache:NativeInventoryCache,rows:ReturnType<typeof row>[],slot=100){cache.install(standard,slot,rows,now);cache.install(token2022,slot,[],now);}

test('inventory sums all ATA and non-ATA balances exactly, without number precision loss',()=>{
  const cache=fixture(),ata=getAssociatedTokenAddressSync(mint,wallet,true),nonAta=key(4);
  ready(cache,[row(ata,9007199254740993n),row(nonAta,9007199254740995n),row(key(5),99n,{tokenMint:otherMint})]);
  const result=cache.read(mint.toBase58(),100,now);
  assert.deepEqual(cache.addresses(mint.toBase58()).sort(),[ata.toBase58(),nonAta.toBase58()].sort());
  assert.equal(result.amount,'18014398509481988');assert.equal(result.slot,100);assert.equal(result.commitment,'confirmed');assert.equal(result.tokenDecimals,6);assert.equal(cache.status().ready,true);
  cache.ingest(nonAta.toBase58(),token(9007199254740996n),103,now+1);
  assert.equal(cache.read(mint.toBase58(),103,now+2).amount,'18014398509481989');
  assert.throws(()=>cache.read(mint.toBase58(),104,now+2),/NATIVE_INVENTORY_BEFORE_FILL/);
});

test('stream updates and reads use the per-mint aggregate without enumerating the owner account map',()=>{
  const cache=fixture(),first=key(4),second=key(5);ready(cache,[row(first,100n),row(second,200n)]);
  const internal=cache as any;
  internal.rebuild=()=>{throw Error('FULL_MINT_REBUILD');};
  Object.defineProperty(internal.accounts,'values',{value:()=>{throw Error('FULL_OWNER_SCAN');}});
  cache.ingest(first.toBase58(),token(150n),101,now+1);
  assert.equal(cache.read(mint.toBase58(),101,now+2).amount,'350');
  assert.deepEqual(cache.addresses(mint.toBase58()).sort(),[first.toBase58(),second.toBase58()].sort());
  cache.ingest(second.toBase58(),null,102,now+3);
  assert.equal(cache.read(mint.toBase58(),102,now+4).amount,'150');
});

test('disconnect invalidates snapshot completeness until both token-program snapshots return',()=>{
  const cache=fixture();ready(cache,[row(key(4),100n)]);cache.invalidate();
  assert.equal(cache.status().ready,false);assert.throws(()=>cache.read(mint.toBase58(),100,now),/NATIVE_INVENTORY_NOT_READY/);
  cache.install(standard,101,[row(key(4),110n)],now+1);assert.equal(cache.status().ready,false);
  cache.install(token2022,101,[],now+1);assert.equal(cache.status().ready,true);assert.equal(cache.read(mint.toBase58(),101,now+1).amount,'110');
});

test('older or equal-slot HTTP account values never overwrite newer WS values',()=>{
  const cache=fixture();ready(cache,[row(key(4),100n)]);
  cache.ingest(key(4).toBase58(),token(300n),102,now+1);
  cache.install(standard,101,[row(key(4),200n)],now+2);
  cache.install(standard,102,[row(key(4),250n)],now+3);
  assert.equal(cache.read(mint.toBase58(),102,now+3).amount,'300');
  cache.ingest(key(4).toBase58(),token(50n),101,now+4);
  assert.equal(cache.read(mint.toBase58(),102,now+4).amount,'300');
});

test('same-slot older snapshot absence cannot delete a newly streamed non-ATA account',()=>{
  const cache=fixture();ready(cache,[]);
  cache.ingest(key(4).toBase58(),token(300n),102,now+1);
  cache.install(standard,102,[],now+2);
  assert.equal(cache.read(mint.toBase58(),102,now+2).amount,'300');
});

test('an observed account closure remains confirmed zero and cannot be resurrected by same-slot HTTP',()=>{
  const cache=fixture();ready(cache,[row(key(4),100n)]);
  assert.deepEqual(cache.ingest(key(4).toBase58(),null,102,now+1),[mint.toBase58()]);
  let result=cache.read(mint.toBase58(),102,now+1);assert.equal(result.amount,'0');assert.equal(result.commitment,'confirmed');assert.equal(result.slot,102);
  cache.install(standard,102,[row(key(4),100n)],now+2);
  result=cache.read(mint.toBase58(),102,now+2);assert.equal(result.amount,'0');assert.equal(result.commitment,'confirmed');
  cache.install(standard,103,[],now+3);assert.equal(cache.read(mint.toBase58(),103,now+3).amount,'0');
});

test('known zero-lamport empty System account closes inventory without waiting for HTTP',()=>{
  const cache=fixture();ready(cache,[row(key(4),100n)]);
  const closed={data:Buffer.alloc(0),lamports:0,executable:false,owner:SystemProgram.programId};
  assert.deepEqual(cache.ingest(key(4).toBase58(),closed,102,now+1),[mint.toBase58()]);
  assert.equal(cache.read(mint.toBase58(),102,now+1).amount,'0');
  assert.equal(cache.read(mint.toBase58(),102,now+1).commitment,'confirmed');
  const invalid=fixture();ready(invalid,[row(key(4),100n)]);
  invalid.ingest(key(4).toBase58(),{...closed,owner:key(9)},102,now+1);
  assert.throws(()=>invalid.read(mint.toBase58(),102,now+1),/NATIVE_INVENTORY_ACCOUNT_INVALID/);
});

test('Token-2022 inventory is separate, supports immutable-owner accounts and rejects unsupported extensions',()=>{
  const cache=fixture();cache.track(otherMint.toBase58(),9,token2022);
  cache.install(standard,100,[row(key(4),100n)],now);
  cache.install(token2022,101,[row(key(5),200n,{program:TOKEN_2022_PROGRAM_ID,tokenMint:otherMint,extension:ExtensionType.ImmutableOwner})],now);
  assert.equal(cache.read(otherMint.toBase58(),101,now).amount,'200');assert.equal(cache.read(otherMint.toBase58(),101,now).tokenDecimals,9);
  cache.ingest(key(5).toBase58(),token(300n,{program:TOKEN_2022_PROGRAM_ID,tokenMint:otherMint,extension:ExtensionType.TransferFeeAmount}),102,now+1);
  assert.throws(()=>cache.read(otherMint.toBase58(),102,now+1),/NATIVE_INVENTORY_TOKEN_UNSUPPORTED/);
});

test('known wallet account changing to a foreign program must invalidate balances rather than retain an old holding',()=>{
  const cache=fixture();ready(cache,[row(key(4),100n)]);
  cache.ingest(key(4).toBase58(),{...token(0n),owner:SystemProgram.programId},101,now+1);
  assert.throws(()=>cache.read(mint.toBase58(),100,now+1),/NATIVE_INVENTORY_ACCOUNT_INVALID/);
});

test('malformed or foreign-owner known accounts fail closed; unrelated pool accounts are ignored',()=>{
  for(const invalid of [token(1n,{owner:key(6)}),{...token(1n),data:Buffer.alloc(3)},token(1n,{state:0}),{...token(1n),executable:true}]){
    const cache=fixture();ready(cache,[row(key(4),100n)]);
    cache.ingest(key(4).toBase58(),invalid,101,now+1);
    assert.throws(()=>cache.read(mint.toBase58(),100,now+1),/NATIVE_INVENTORY_ACCOUNT_INVALID/);
  }
  const cache=fixture();ready(cache,[row(key(4),100n)]);
  assert.deepEqual(cache.ingest(key(5).toBase58(),token(1000n,{owner:key(6)}),101,now+1),[]);
  assert.deepEqual(cache.ingest(key(5).toBase58(),{...token(1000n),owner:SystemProgram.programId},101,now+1),[]);
  assert.equal(cache.read(mint.toBase58(),100,now+1).amount,'100');
});

test('snapshot rejects duplicate addresses, mismatched programs and foreign owners atomically',()=>{
  for(const rows of [[row(key(4),100n),row(key(4),200n)],[row(key(4),100n,{program:TOKEN_2022_PROGRAM_ID})],[row(key(4),100n,{owner:key(6)})]]){
    const cache=fixture();assert.throws(()=>cache.install(standard,100,rows,now));assert.equal(cache.status().ready,false);
    assert.throws(()=>cache.read(mint.toBase58(),100,now),/NATIVE_INVENTORY_NOT_READY/);
  }
});

test('an unrelated token-program snapshot cannot clear a corrupted tracked-account error',()=>{
  const cache=fixture();ready(cache,[row(key(4),100n)]);
  cache.ingest(key(4).toBase58(),{...token(0n),owner:SystemProgram.programId},101,now+1);
  cache.install(token2022,102,[],now+2);
  assert.throws(()=>cache.read(mint.toBase58(),100,now+2),/NATIVE_INVENTORY_ACCOUNT_INVALID/);
  cache.install(standard,102,[row(key(4),200n)],now+3);
  assert.equal(cache.read(mint.toBase58(),102,now+3).amount,'200');
});

test('older corrupt frames cannot lower the slot required to repair inventory',()=>{
  const cache=fixture();ready(cache,[row(key(4),100n)]);
  const broken={...token(0n),owner:SystemProgram.programId};
  cache.ingest(key(4).toBase58(),broken,105,now+1);
  cache.ingest(key(4).toBase58(),broken,102,now+2);
  cache.install(standard,104,[row(key(4),200n)],now+3);
  assert.throws(()=>cache.read(mint.toBase58(),104,now+3),/NATIVE_INVENTORY_ACCOUNT_INVALID/);
  cache.install(standard,106,[row(key(4),300n)],now+4);
  assert.equal(cache.read(mint.toBase58(),106,now+4).amount,'300');
});

test('retired mint releases all inventory rows and cannot return through snapshots or wallet frames',()=>{
  const cache=fixture();cache.track(otherMint.toBase58(),6,standard);
  ready(cache,[row(key(4),0n),row(key(5),20n,{tokenMint:otherMint})]);
  cache.retire(mint.toBase58());
  assert.equal(cache.status().trackedMints,1);assert.equal(cache.status().retiredMints,1);assert.equal(cache.status().accounts,1);
  assert.deepEqual(cache.addresses(mint.toBase58()),[]);
  assert.deepEqual(cache.ingest(key(4).toBase58(),token(100n),102,now+1),[]);
  cache.install(standard,103,[row(key(4),100n),row(key(5),30n,{tokenMint:otherMint})],now+2);
  assert.equal(cache.status().accounts,1);assert.deepEqual(cache.addresses(mint.toBase58()),[]);
  assert.equal(cache.read(otherMint.toBase58(),103,now+2).amount,'30');
  assert.throws(()=>cache.track(mint.toBase58(),6,standard),/NATIVE_INVENTORY_RETIRED/);
  assert.throws(()=>cache.read(mint.toBase58(),103,now+2),/NATIVE_INVENTORY_NOT_READY/);
  cache.invalidate();ready(cache,[row(key(4),200n),row(key(5),40n,{tokenMint:otherMint})],104);
  assert.deepEqual(cache.addresses(mint.toBase58()),[]);assert.equal(cache.read(otherMint.toBase58(),104,now+2).amount,'40');
});
