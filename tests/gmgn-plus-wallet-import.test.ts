import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {importGmgnWalletArchive} from '../scripts/import-gmgn-plus-wallet-archive.js';

const wallet=(n:number)=>bs58.encode(Buffer.alloc(32,n));
const tx=(n:number)=>bs58.encode(Buffer.alloc(64,n));
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');

test('one-time wallet importer verifies manifests and is idempotent across every wallet dataset',()=>{
  const dir=mkdtempSync(join(tmpdir(),'gmgn-wallet-import-')),root=join(dir,'raw'),database=join(dir,'archive.sqlite'),who=wallet(3),token=wallet(4);
  mkdirSync(root,{recursive:true,mode:0o700});
  const write=(name:string,value:unknown)=>{const path=join(root,name);mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const bytes=Buffer.from(JSON.stringify(value));writeFileSync(path,bytes,{mode:0o600});chmodSync(path,0o600);return {bytes:bytes.length,sha256:digest(bytes)};};
  const request=(phase:'phase1'|'phase2',id:string,kind:string,file:string,value:unknown,period?:string)=>{
    const integrity=write(file,value);return {id:`request-${phase}-${file}`,endpoint:'/read-only',method:'GET',chain:'sol',kind,
      [phase==='phase1'?'walletIds':'candidateIds']:[id],period,success:true,file,...integrity};};
  const stats=(profit:string)=>({code:0,data:{wallet_address:who,realized_profit:profit,pnl_stat:{winrate:0.5}}});
  const profits=(profit:string)=>({code:0,data:{list:[{wallet_address:who,total_profit:profit}]}});
  const activity=(n:number,event_type:string)=>({code:0,data:{activities:[{chain:'sol',wallet:who,tx_hash:tx(n),timestamp:Date.parse('2026-10-30T12:00:00Z')/1000,
    event_type,token:{address:token},token_amount:'1'}],next:n===1?'next-page':''}});
  const holdings=(next:string)=>({code:0,data:{list:[{token:{address:token},balance:'1'}],next}});
  const phase1Requests=[
    request('phase1','w001','stats','responses/w001-stats-7d.json',stats('7'),'7d'),
    request('phase1','w001','stats','responses/w001-stats-30d.json',stats('30'),'30d'),
    ...(['1d','7d','30d','all'] as const).map(period=>request('phase1','w001','profits',`responses/profits-sol-${period}.json`,profits(period),period)),
    request('phase1','w001','activity','responses/w001-activity-p01.json',activity(1,'buy')),
    request('phase1','w001','activity','responses/w001-activity-p02.json',activity(2,'burn')),
    request('phase1','w001','holdings','responses/w001-holdings-current-p01.json',holdings('')),
    request('phase1','w001','holdings','responses/w001-holdings-closed-p01.json',holdings('closed-next'))];
  const phase2Requests=[
    {...request('phase2','c001','stats','phase2-responses/c001-stats-7d.json',stats('8'),'7d'),id:'c001-stats-7d',candidateIds:undefined},
    request('phase2','c001','stats','phase2-responses/c001-stats-30d.json',stats('31'),'30d'),
    ...(['1d','7d','30d','all'] as const).map(period=>request('phase2','c001','profits',`phase2-responses/profits-sol-${period}.json`,profits(`p-${period}`),period))];
  const dossierRequests=[
    request('phase2','c001','activity','phase2-dossiers/c001-activity-p01.json',activity(3,'sell')),
    request('phase2','c001','holdings','phase2-dossiers/c001-holdings-closed-p02.json',holdings(''))];
  write('selection.json',{version:1,phase1:[{chain:'solana',address:who,walletId:'w001',addressSha256:digest(`solana:${who}`)}],
    phase2:[{chain:'solana',address:who,candidateId:'c001',addressSha256:digest(`solana:${who}`)}]});
  write('manifest.json',{version:1,status:'complete',requests:phase1Requests});
  write('phase2-manifest.json',{version:1,status:'completed',requests:phase2Requests});
  write('phase2-dossiers/manifest.json',{version:1,status:'completed',requests:dossierRequests});
  try{const first=importGmgnWalletArchive({root,database,maxBytes:32*1024*1024,now:()=>new Date('2026-10-30T13:00:00Z')});
    assert.deepEqual(first,{phase1Wallets:1,phase2Wallets:1,uniqueWallets:1,requests:18,statsRows:4,profitRows:8,activityRows:3,holdingPages:3,holdingRows:3});
    const second=importGmgnWalletArchive({root,database,maxBytes:32*1024*1024,now:()=>new Date('2026-10-30T14:00:00Z')});assert.deepEqual(second,first);
    const db=new DatabaseSync(database,{readOnly:true});try{
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_wallet_snapshots').get()!.n),6);
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_wallet_activity').get()!.n),3);
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM gpa_wallet_holding_pages').get()!.n),3);
      assert.equal(db.prepare("SELECT count(*) AS n FROM gpa_wallet_activity WHERE event_type='burn'").get()!.n,1);
    }finally{db.close();}
    chmodSync(join(root,'responses/w001-stats-7d.json'),0o644);
    assert.throws(()=>importGmgnWalletArchive({root,database,maxBytes:32*1024*1024}),/FILE_SECURITY_INVALID/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
