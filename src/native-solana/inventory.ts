import {PublicKey,type AccountInfo} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackAccount,getExtensionTypes,ExtensionType} from '@solana/spl-token';
import type {NativePositionBalance} from './positions.js';

const programs=new Set([TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()]);
interface Holding {address:string;mint:string;program:string;amount:bigint;slot:number;receivedAtMs:number;unsupported:boolean;}
interface MintAggregate {amount:bigint;slot:number;unsupported:number;programs:Map<string,number>;addresses:Set<string>;}
/** A complete owner snapshot followed by continuous wallet account notifications.
 * Pool quotes cannot substitute for inventory. A disconnect invalidates completeness;
 * a late HTTP snapshot never overwrites a newer streamed account state. */
export class NativeInventoryCache {
  private accounts=new Map<string,Holding>();
  private mintAccounts=new Map<string,Map<string,Holding>>();
  private aggregates=new Map<string,MintAggregate>();
  private tombstones=new Map<string,{program:string;slot:number}>();
  private snapshots=new Map<string,{slot:number;receivedAtMs:number}>();
  private tracked=new Map<string,{decimals:number;program:string}>();
  private retired=new Set<string>();
  private invalid=new Map<string,{reason:string;slot:number}>();
  constructor(private wallet:string){new PublicKey(wallet);}
  track(mint:string,decimals:number,program:string){
    new PublicKey(mint);if(!Number.isInteger(decimals)||decimals<0||decimals>255||!programs.has(program))throw Error('NATIVE_INVENTORY_IDENTITY_INVALID');
    if(this.retired.has(mint))throw Error('NATIVE_INVENTORY_RETIRED');
    this.tracked.set(mint,{decimals,program});
  }
  private rebuild(mint:string):void {
    const rows=this.mintAccounts.get(mint);
    if(!rows?.size){this.mintAccounts.delete(mint);this.aggregates.delete(mint);return;}
    let amount=0n,slot=0,unsupported=0;const programs=new Map<string,number>(),addresses=new Set<string>();
    for(const row of rows.values()){amount+=row.amount;slot=Math.max(slot,row.slot);unsupported+=Number(row.unsupported);
      programs.set(row.program,(programs.get(row.program)??0)+1);addresses.add(row.address);}
    this.aggregates.set(mint,{amount,slot,unsupported,programs,addresses});
  }
  private put(entry:Holding,dirty=new Set<string>()):Set<string> {
    const old=this.accounts.get(entry.address);
    if(old){const rows=this.mintAccounts.get(old.mint);rows?.delete(old.address);dirty.add(old.mint);}
    this.accounts.set(entry.address,entry);const rows=this.mintAccounts.get(entry.mint)??new Map<string,Holding>();
    rows.set(entry.address,entry);this.mintAccounts.set(entry.mint,rows);dirty.add(entry.mint);return dirty;
  }
  private remove(address:string,dirty=new Set<string>()):Set<string> {
    const old=this.accounts.get(address);if(!old)return dirty;
    this.accounts.delete(address);const rows=this.mintAccounts.get(old.mint);rows?.delete(address);dirty.add(old.mint);return dirty;
  }
  private refresh(dirty:Set<string>):void {for(const mint of dirty)this.rebuild(mint);}
  /** Stream updates replace one known account. Maintain its mint aggregate without
   * enumerating the owner's other token accounts on the price-to-exit path. */
  private putStream(entry:Holding):void {
    const old=this.accounts.get(entry.address);
    if(old){
      const rows=this.mintAccounts.get(old.mint);rows?.delete(old.address);
      const aggregate=this.aggregates.get(old.mint);
      if(aggregate){aggregate.amount-=old.amount;aggregate.unsupported-=Number(old.unsupported);aggregate.addresses.delete(old.address);
        const count=(aggregate.programs.get(old.program)??1)-1;
        if(count)aggregate.programs.set(old.program,count);else aggregate.programs.delete(old.program);
        if(!aggregate.addresses.size){this.mintAccounts.delete(old.mint);this.aggregates.delete(old.mint);}}
    }
    this.accounts.set(entry.address,entry);
    const rows=this.mintAccounts.get(entry.mint)??new Map<string,Holding>();rows.set(entry.address,entry);this.mintAccounts.set(entry.mint,rows);
    const aggregate=this.aggregates.get(entry.mint)??{amount:0n,slot:0,unsupported:0,programs:new Map<string,number>(),addresses:new Set<string>()};
    aggregate.amount+=entry.amount;aggregate.slot=Math.max(aggregate.slot,entry.slot);aggregate.unsupported+=Number(entry.unsupported);
    aggregate.programs.set(entry.program,(aggregate.programs.get(entry.program)??0)+1);aggregate.addresses.add(entry.address);
    this.aggregates.set(entry.mint,aggregate);
  }
  /** Called only after authoritative position closure. Shared owner subscriptions
   * may still deliver this mint; those frames must not restart position work. */
  retire(mint:string){
    new PublicKey(mint);this.retired.add(mint);this.tracked.delete(mint);
    const rows=this.mintAccounts.get(mint);if(rows)for(const address of rows.keys()){this.accounts.delete(address);this.tombstones.delete(address);}
    this.mintAccounts.delete(mint);this.aggregates.delete(mint);
  }
  invalidate(){this.snapshots.clear();this.invalid.clear();}
  /** Only snapshots missing from the current complete-owner generation need an
   * RPC refresh. A successful program snapshot survives a sibling RPC failure,
   * while readiness remains false until both programs are complete. */
  programsNeedingRefresh():string[]{return [...programs].filter(program=>!this.snapshots.has(program)||this.invalid.has(program));}
  private decode(address:string,info:AccountInfo<Buffer>,slot:number,receivedAtMs:number):Holding {
    if(!Number.isSafeInteger(slot)||slot<0||!Number.isFinite(receivedAtMs)||receivedAtMs<0||info.executable||!programs.has(info.owner.toBase58()))throw Error('NATIVE_INVENTORY_ACCOUNT_INVALID');
    const a=unpackAccount(new PublicKey(address),info,info.owner);
    if(a.owner.toBase58()!==this.wallet||!a.isInitialized)throw Error('NATIVE_INVENTORY_OWNER_INVALID');
    const unsupported=getExtensionTypes(a.tlvData).some(t=>t!==ExtensionType.ImmutableOwner);
    return {address,mint:a.mint.toBase58(),program:info.owner.toBase58(),amount:a.amount,slot,receivedAtMs,unsupported};
  }
  install(program:string,slot:number,values:readonly {pubkey:PublicKey;account:AccountInfo<Buffer>}[],receivedAtMs:number){
    if(!programs.has(program)||!Number.isSafeInteger(slot)||slot<0||!Number.isFinite(receivedAtMs))throw Error('NATIVE_INVENTORY_SNAPSHOT_INVALID');
    const next=new Map<string,Holding>();
    for(const value of values){const entry=this.decode(value.pubkey.toBase58(),value.account,slot,receivedAtMs);
      if(entry.program!==program||next.has(entry.address))throw Error('NATIVE_INVENTORY_SNAPSHOT_INVALID');next.set(entry.address,entry);}
    const old=this.snapshots.get(program);if(old&&old.slot>slot)return;const dirty=new Set<string>();
    for(const [address,entry] of this.accounts)if(entry.program===program&&entry.slot<slot&&!next.has(address))this.remove(address,dirty);
    for(const [address,entry] of next){
      if(this.retired.has(entry.mint))continue;
      const previous=this.accounts.get(address),deleted=this.tombstones.get(address);
      // At an equal slot, streamed state can be later than an HTTP snapshot.
      if(previous&&previous.slot>=slot||deleted&&deleted.slot>=slot)continue;
      this.put(entry,dirty);
    }
    for(const [address,deleted] of this.tombstones)if(deleted.program===program&&deleted.slot<slot)this.tombstones.delete(address);
    this.refresh(dirty);this.snapshots.set(program,{slot,receivedAtMs});const problem=this.invalid.get(program);if(problem&&slot>problem.slot)this.invalid.delete(program);
  }
  ingest(address:string,info:AccountInfo<Buffer>|null,slot:number,receivedAtMs:number):string[]{
    const old=this.accounts.get(address);
    if(!Number.isSafeInteger(slot)||slot<0||!Number.isFinite(receivedAtMs))return [];
    if(old&&slot<old.slot)return [];
    if(!info||!info.executable&&info.lamports===0&&info.data.length===0&&info.owner.equals(PublicKey.default)){if(!old)return [];this.tombstones.set(address,{program:old.program,slot});
      // Keep a zero row so the aggregate carries the close slot until the next full snapshot.
      this.putStream({...old,amount:0n,slot,receivedAtMs});return [old.mint];}
    // Non-wallet pool/vault/mint events are intentionally not inventory updates.
    if(!programs.has(info.owner.toBase58())){if(old){this.invalidateProgram(old.program,slot);return [old.mint];}return [];}
    try {
      const entry=this.decode(address,info,slot,receivedAtMs);
      if(old&&(old.mint!==entry.mint||old.program!==entry.program))throw Error('NATIVE_INVENTORY_ACCOUNT_CHANGED');
      if(this.retired.has(entry.mint))return [];
      const baseline=this.snapshots.get(entry.program);if(baseline&&slot<baseline.slot)return [];
      this.putStream(entry);this.tombstones.delete(address);return [entry.mint];
    }catch{if(old){this.invalidateProgram(old.program,slot);return [old.mint];}return [];}
  }
  private invalidateProgram(program:string,slot:number){this.invalid.set(program,{reason:'NATIVE_INVENTORY_ACCOUNT_INVALID',slot:Math.max(slot,this.invalid.get(program)?.slot??0)});}
  read(mint:string,floorSlot:number,nowMs:number):NativePositionBalance {
    const meta=this.tracked.get(mint),snapshot=meta&&this.snapshots.get(meta.program);
    if(this.invalid.size)throw Error([...this.invalid.values()][0].reason);
    if(!meta||!snapshot)throw Error('NATIVE_INVENTORY_NOT_READY');
    const aggregate=this.aggregates.get(mint);
    if(aggregate&&(aggregate.unsupported>0||aggregate.programs.size!==1||!aggregate.programs.has(meta.program)))throw Error('NATIVE_INVENTORY_TOKEN_UNSUPPORTED');
    const amount=aggregate?.amount??0n,slot=Math.max(snapshot.slot,aggregate?.slot??0);
    if(slot<floorSlot)throw Error('NATIVE_INVENTORY_BEFORE_FILL');
    return {wallet:this.wallet,mint,amount:amount.toString(),tokenDecimals:meta.decimals,slot,commitment:'confirmed',observedAt:new Date(nowMs).toISOString()};
  }
  /** Direct watches also observe closures that no longer match programSubscribe owner filters. */
  addresses(mint:string):string[]{return [...(this.aggregates.get(mint)?.addresses??[])];}
  status(){const missingPrograms=this.programsNeedingRefresh();return {ready:missingPrograms.length===0,accounts:this.accounts.size,
    trackedMints:this.tracked.size,retiredMints:this.retired.size,error:[...this.invalid.values()][0]?.reason,
    missingPrograms,snapshotSlots:[...this.snapshots.values()].map(v=>v.slot)};}
}
