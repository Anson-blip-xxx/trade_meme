import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {ScanArchive,type ScanToken} from '../src/scan-archive.js';
import type {Stored} from '../src/store.js';
import type {Report,Signal} from '../src/types.js';

const start=Date.parse('2026-10-09T00:00:00.000Z');
const iso=(offset:number)=>new Date(start+offset).toISOString();
const address='0x'+'a'.repeat(40);
const check=()=>({status:'pass' as const,reasons:['CHECK_PASSED'],facts:{raw:'SECRET_BODY'},checkedAt:iso(1_000)});
function stored(id='scan-1',patch:Partial<Report>={}):Stored {
  const signal:Signal={source:'debot',sourceEventId:id,occurredAt:iso(0),token:{chain:'bsc',address},
    text:'SECRET_BODY',evidenceUrls:[],claim:'community'};
  const report:Report={id,mode:'live',policyVersion:'synthetic-test',signal,receivedAt:iso(0),evaluatedAt:iso(1_000),
    validUntil:iso(60_000),decision:'BUY_CANDIDATE',buyEligible:true,executionEnabled:false,reasons:['CHECK_PASSED'],
    provenance:check(),safety:check(),narrative:{...check(),evidence:[{id:'raw',text:'SECRET_BODY',authorId:'1',
      url:'https://x.com/i/web/status/1',publishedAt:iso(0),fetchedAt:iso(1_000),provider:'x_official',verification:'first_party',authority:'public'}],
      analysis:{thesis:'A compact analyst conclusion',catalyst:'SECRET_BODY',relation:'community',stage:'emerging',
        assessment:'favorable',confidence:'medium',supportingEvidenceIds:[],opposingEvidenceIds:[],reasons:[],uncertainties:[]},
      supplier:{provider:'debot',text:'SECRET_BODY',sourceUrl:'https://debot.ai/token/bsc/'+address+'?api_key=SECRET_BODY',
        verification:'vendor_endpoint',contentType:'vendor_ai_narrative'}},
    gmgn:{token:signal.token,fetchedAt:iso(1_000),diagnostics:[],info:{address,name:'Synthetic Name',symbol:'SYNTH',
      price_usd:'9999',historical_ath:'88888',raw:'SECRET_BODY'},security:{raw:'SECRET_BODY'}},...patch};
  return {id,status:'completed',signal:report.signal,receivedAt:iso(0),report};
}
function fixture() {
  let elapsed=1_000;
  const archive=new ScanArchive(':memory:',{now:()=>new Date(start+elapsed)});
  const price=(at:number,priceUsd:number,target:ScanToken={chain:'bsc',address})=>{
    elapsed=at;archive.recordPrice({...target,priceUsd,observedAt:iso(at),source:'gmgn_token_info'});
  };
  return {archive,price,setNow:(at:number)=>{elapsed=at;},now:()=>new Date(start+elapsed)};
}

test('基线来自首次符合条件之后实际采样，涨跌和最高涨幅只由已采样报价计算',()=>{
  const {archive,price}=fixture();
  try {
    archive.capture(stored());
    assert.equal(archive.get('scan-1')?.performance?.baselinePriceUsd,undefined);
    assert.equal(archive.stats().maxGainPct,undefined);
    price(2_000,10);price(3_000,8);
    let performance=archive.get('scan-1')!.performance!;
    assert.equal(performance.baselineAt,iso(2_000));assert.equal(performance.maxGainPct,0);
    assert.ok(Math.abs(performance.currentGainPct!+20)<1e-10);
    price(4_000,30);price(5_000,15);performance=archive.get('scan-1')!.performance!;
    assert.equal(performance.maxGainPct,200);assert.equal(performance.currentGainPct,50);
    assert.equal(performance.peakAt,iso(4_000));assert.equal(performance.peakPriceUsd,30);
    assert.equal(performance.samples,4);assert.equal(performance.points.length,4);
    assert.equal(archive.stats().maxGainPct,200);
  } finally {archive.close();}
});

test('未来、提前、等于eligible、重复、倒序、非正和无效价格都不制造采样',()=>{
  const {archive,setNow,price}=fixture();
  try {
    archive.capture(stored());setNow(10_000);
    const send=(observedAt:string,priceUsd:number)=>archive.recordPrice({chain:'bsc',address,priceUsd,observedAt,source:'gmgn'});
    for(const at of [iso(0),iso(1_000),iso(10_001),'invalid']) send(at,1);
    for(const n of [0,-1,NaN,Infinity]) send(iso(2_000),n);
    assert.equal(archive.get('scan-1')?.performance?.samples,0);
    price(10_000,2);send(iso(10_000),20);send(iso(9_000),200);
    assert.equal(archive.get('scan-1')?.performance?.samples,1);
    assert.equal(archive.get('scan-1')?.performance?.peakPriceUsd,2);
  } finally {archive.close();}
});

test('只有live BUY且buyEligible跟踪，demo或其他决策不进入候选表现',()=>{
  const {archive}=fixture();
  try {
    archive.capture(stored('live'));
    archive.capture(stored('demo',{mode:'demo'}));
    archive.capture(stored('watch',{decision:'WATCH'}));
    archive.capture(stored('reject',{decision:'REJECT'}));
    archive.capture(stored('ineligible',{buyEligible:false}));
    const processing=stored('processing');processing.status='processing';archive.capture(processing);
    assert.equal(archive.stats().total,6);assert.equal(archive.stats().eligible,1);
    assert.deepEqual(archive.list({eligible:true}).items.map(item=>item.id),['live']);
    assert.equal(archive.list({eligible:false}).total,5);
    assert.equal(archive.get('processing')?.performance,undefined);
    assert.deepEqual(archive.pendingTokens(),[{chain:'bsc',address}]);
  } finally {archive.close();}
});

test('重复capture、重试和较晚WATCH保留第一次eligible锚点与既有基线',()=>{
  const {archive,price,setNow}=fixture();
  try {
    const initial=stored();archive.capture(initial);price(2_000,10);price(3_000,20);
    const original=archive.get(initial.id)!.performance;
    archive.capture(initial);assert.deepEqual(archive.get(initial.id)?.performance,original);
    archive.capture({...initial,status:'processing',report:undefined});
    assert.equal(archive.get(initial.id)?.status,'processing');
    assert.deepEqual(archive.get(initial.id)?.performance,original);
    archive.capture({...initial,status:'interrupted',report:undefined});
    assert.equal(archive.get(initial.id)?.status,'interrupted');
    setNow(5_000);archive.capture(stored(initial.id,{evaluatedAt:iso(5_000),decision:'WATCH',buyEligible:false}));
    assert.equal(archive.get(initial.id)?.decision,'WATCH');
    assert.deepEqual(archive.get(initial.id)?.performance,original);
    assert.equal(archive.list({eligible:true}).total,1);
    assert.equal(archive.list({eligible:true,decision:'BUY_CANDIDATE'}).total,0);
    archive.capture(initial);assert.equal(archive.get(initial.id)?.decision,'WATCH');
  } finally {archive.close();}
});

test('摘要及价格重启可恢复，数据库只持久化允许字段并限制权限',()=>{
  const dir=mkdtempSync(join(tmpdir(),'meme-scan-')),path=join(dir,'scans.sqlite');let elapsed=1_000;
  let archive=new ScanArchive(path,{now:()=>new Date(start+elapsed)});
  try {
    archive.capture(stored());elapsed=2_000;
    archive.recordPrice({chain:'bsc',address,priceUsd:2,observedAt:iso(elapsed),source:'gmgn'});
    archive.close();archive=new ScanArchive(path,{now:()=>new Date(start+elapsed)});
    const record=archive.get('scan-1')!;
    assert.equal(record.performance?.baselinePriceUsd,2);assert.equal(record.name,'Synthetic Name');
    assert.equal(record.symbol,'SYNTH');assert.equal(record.address,address);
    assert.equal(record.narrative?.thesis,'A compact analyst conclusion');
    assert.equal(record.narrative?.sourceUrl,'https://debot.ai/token/bsc/'+address);
    const db=new DatabaseSync(path,{readOnly:true});
    const json=String(db.prepare('SELECT record FROM scan_summaries').get()!.record);db.close();
    assert.equal(json.includes('SECRET_BODY'),false);assert.equal(json.includes('historical_ath'),false);
    assert.equal(json.includes('88888'),false);assert.equal(statSync(path).mode&0o777,0o600);
  } finally {archive.close();rmSync(dir,{recursive:true,force:true});}
});

test('完整EVM地址规范化且去重，Solana大小写不同的有效地址严格区分',()=>{
  const {archive,price}=fixture();
  try {
    archive.capture(stored('evm-lower'));
    const evm=stored('evm-upper');evm.signal.token.address='0x'+'A'.repeat(40);archive.capture(evm);
    const sol=bs58.encode(new Uint8Array(32).fill(1)),solOther=sol.replace('J','j');
    assert.equal(bs58.decode(solOther).length,32);
    for(const [id,ca] of [['sol-1',sol],['sol-2',solOther]]) {
      const entry=stored(id);entry.signal.token={chain:'solana',address:ca};archive.capture(entry);
    }
    assert.equal(archive.pendingTokens().length,3);
    price(2_000,2,{chain:'bsc',address:'0x'+'A'.repeat(40)});
    assert.equal(archive.get('evm-lower')?.performance?.samples,1);
    assert.equal(archive.get('evm-upper')?.performance?.samples,1);
    price(3_000,3,{chain:'solana',address:sol});
    assert.equal(archive.get('sol-1')?.performance?.samples,1);
    assert.equal(archive.get('sol-2')?.performance?.samples,0);
    assert.equal(archive.get('sol-1')?.address,sol);assert.equal(archive.get('sol-2')?.address,solOther);
  } finally {archive.close();}
});

test('24小时后停止跟踪，失败不会抹除峰值或伪造零价，成功报价可恢复',()=>{
  const {archive,price,setNow,now}=fixture();
  try {
    archive.capture(stored());price(2_000,1);price(3_000,3);setNow(4_000);
    archive.recordPriceError({chain:'bsc',address},'GMGN_RATE_LIMITED',now());
    const failed=archive.get('scan-1')!.performance!;
    assert.equal(failed.status,'unavailable');assert.equal(failed.error,'GMGN_RATE_LIMITED');
    assert.equal(failed.errorCount,1);assert.equal(failed.lastErrorAt,iso(4_000));
    assert.equal(failed.samples,2);assert.equal(failed.peakPriceUsd,3);assert.equal(archive.pendingTokens().length,1);
    price(5_000,2);assert.equal(archive.get('scan-1')?.performance?.status,'tracking');
    assert.equal(archive.get('scan-1')?.performance?.error,undefined);
    const recovered=archive.get('scan-1')!.performance!;
    assert.equal(recovered.errorCount,1);assert.equal(recovered.lastError,'GMGN_RATE_LIMITED');
    assert.equal(recovered.lastErrorAt,iso(4_000));assert.equal(recovered.maxSampleGapSec,2);
    setNow(1_000+24*3_600_000);assert.equal(archive.pendingTokens().length,0);
    assert.equal(archive.get('scan-1')?.performance?.status,'ended');
    price(1_000+24*3_600_000+1,100);
    assert.equal(archive.get('scan-1')?.performance?.peakPriceUsd,3);
    assert.equal(archive.stats().tracking,0);
    archive.recordPriceError({chain:'bsc',address},'SECRET_BODY',now());
    assert.equal(archive.get('scan-1')?.performance?.status,'ended');
    assert.equal(archive.get('scan-1')?.performance?.errorCount,1);
  } finally {archive.close();}
});

test('持久化采样点有界且保留真实基线与峰值，samples保留完整计数',()=>{
  const {archive,price}=fixture();
  try {
    archive.capture(stored());
    for(let i=0;i<600;i++) price(2_000+i*1_000,i===19?999:10+i%7);
    const p=archive.get('scan-1')!.performance!;
    assert.equal(p.samples,600);assert.ok(p.points.length<=256);
    assert.equal(p.points[0].at,iso(2_000));assert.ok(p.points.some(point=>point.at===iso(21_000)&&point.priceUsd===999));
    assert.equal(p.points.at(-1)?.at,iso(601_000));assert.equal(p.peakPriceUsd,999);
    assert.ok(p.points.every((point,index)=>index===0||point.at>p.points[index-1].at));
  } finally {archive.close();}
});

test('条数、保留天数、查询过滤分页与地址搜索均按compact记录执行',()=>{
  let elapsed=1_000;const archive=new ScanArchive(':memory:',{maxEntries:3,retentionDays:1,now:()=>new Date(start+elapsed)});
  try {
    for(let i=1;i<=5;i++) {
      elapsed=i*1_000;
      const entry=stored(`scan-${i}`,{decision:i===4?'WATCH':'BUY_CANDIDATE',buyEligible:i!==4,evaluatedAt:iso(elapsed)});
      entry.receivedAt=iso((i-1)*1_000);archive.capture(entry);
    }
    assert.equal(archive.stats().total,3);assert.equal(archive.get('scan-1'),undefined);
    assert.deepEqual(archive.list({limit:1,offset:1}).items.map(item=>item.id),['scan-4']);
    assert.equal(archive.list({decision:'WATCH'}).total,1);assert.equal(archive.list({chain:'solana'}).total,0);
    assert.equal(archive.list({search:address}).total,3);assert.equal(archive.list({search:'SYNTH'}).total,3);
    assert.equal(archive.list({search:"%' OR 1=1 --"}).total,0);
    elapsed=86_400_000+5_000;archive.prune();assert.equal(archive.stats().total,0);
  } finally {archive.close();}
});

test('候选调度按上次实际尝试公平排序，错误仅保留代码且不影响基线',()=>{
  const {archive,setNow,now}=fixture();
  try {
    const a=stored('a'),b=stored('b');b.signal.token={chain:'bsc',address:'0x'+'b'.repeat(40)};
    archive.capture(a);archive.capture(b);
    const first=archive.pendingTokens(1)[0];setNow(2_000);
    archive.recordPriceError(first,'secret=https://example.com/key',now());
    assert.notEqual(archive.pendingTokens(1)[0].address,first.address);
    const failed=archive.list().items.find(item=>item.address===first.address)!.performance!;
    assert.equal(failed.error,'PRICE_SAMPLE_UNAVAILABLE');assert.equal(failed.baselinePriceUsd,undefined);
    assert.equal(failed.samples,0);
  } finally {archive.close();}
});

test('无效或未来报告、错币替换不能建立追踪或覆盖原始token身份',()=>{
  const {archive}=fixture();
  try {
    const future=stored('future',{evaluatedAt:iso(2_000)});archive.capture(future);
    assert.equal(archive.get('future')?.performance,undefined);
    const original=stored();archive.capture(original);
    const replacement=stored();replacement.signal.token={chain:'bsc',address:'0x'+'b'.repeat(40)};archive.capture(replacement);
    assert.equal(archive.get('scan-1')?.address,address);
    const bad=stored('bad');bad.signal.token.address='4444';archive.capture(bad);assert.equal(archive.get('bad'),undefined);
  } finally {archive.close();}
});

test('processing租约跨重启保留，到期变interrupted；旧摘要库可迁移',()=>{
  const dir=mkdtempSync(join(tmpdir(),'meme-scan-lease-')),path=join(dir,'scans.sqlite');let elapsed=1_000;
  // Previous compact schema before the lease column was added.
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE scan_summaries(id TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,status TEXT NOT NULL,
    received_at TEXT NOT NULL,decision TEXT,eligible_at TEXT,last_price_attempt_at TEXT,record TEXT NOT NULL)`);db.close();
  let archive=new ScanArchive(path,{now:()=>new Date(start+elapsed)});
  try {
    const processing=stored();processing.status='processing';processing.report=undefined;processing.leaseExpiresAt=iso(5_000);
    archive.capture(processing);assert.equal(archive.get(processing.id)?.status,'processing');
    archive.close();elapsed=3_000;archive=new ScanArchive(path,{now:()=>new Date(start+elapsed)});
    assert.equal(archive.get(processing.id)?.status,'processing');
    archive.close();elapsed=5_000;archive=new ScanArchive(path,{now:()=>new Date(start+elapsed)});
    assert.equal(archive.get(processing.id)?.status,'interrupted');
    archive.capture({...processing,leaseExpiresAt:iso(10_000)});
    assert.equal(archive.get(processing.id)?.status,'processing');
    archive.capture(stored());assert.equal(archive.get(processing.id)?.status,'completed');
    elapsed=11_000;archive.prune();assert.equal(archive.get(processing.id)?.status,'completed');
  } finally {archive.close();rmSync(dir,{recursive:true,force:true});}
});

test('钱包归属档案有界且明确供应商声明/人工未验证身份，不持久化完整画像或恶意长字段',()=>{
  const {archive}=fixture();
  const walletAddress=(id:number)=>`0x${id.toString(16).padStart(40,'0')}`;
  const marker='NEVER_PERSIST_PRIVATE_KEY_OR_RAW_WALLET_PAYLOAD';
  const wallets=Array.from({length:20},(_,index)=>({
    chain:'bsc',address:walletAddress(index+2),recognizedLabels:['smart','kol','malicious_label',...Array(30).fill('smart')],
    vendorIdentity:{name:'名\n\u202e'.repeat(500),twitterUsername:index===0?'https://evil.example/'+marker:'vendor_user',raw:marker},
    attribution:{status:'operator_supplied',verification:'unverified',identity:{chain:'bsc',
      address:index===1?walletAddress(99):walletAddress(index+2),label:'标\t'.repeat(500),category:'operator_defined',raw:marker}},
    funding:{address:walletAddress(40),label:'资\u202e'.repeat(500),source:'native_transfer',sharedService:true,conflict:false,
      privateKey:marker,raw:marker},
    risks:[...Array.from({length:30},(_,n)=>`WALLET_RISK_${n}`),marker.repeat(5)],
    stats:{raw:marker},enrichment:{activity:{events:[{text:marker}]}},privateKey:marker,
  }));
  const entry=stored();entry.report!.wallets={status:'pass',checkedAt:iso(1_000),reasons:['WALLET_SAMPLE_ONLY'],
    facts:{raw:marker},summary:{uniqueWalletCount:20,smartCurrentHolderCount:20},clusters:[],wallets:[
      {chain:'solana',address:bs58.encode(new Uint8Array(32).fill(1))},
      {chain:'bsc',address:'broken'},...wallets,
    ]} as unknown as NonNullable<Report['wallets']>;
  try {
    archive.capture(entry);
    const compact=archive.get(entry.id)!.wallets!,profiles=compact.profiles!;
    assert.equal(profiles.length,12);assert.equal(compact.summary.uniqueWalletCount,20);
    const first=profiles[0];assert.equal(first.address,walletAddress(2));
    assert.deepEqual(first.labels,['smart','kol']);assert.equal(first.vendorVerification,'vendor_claim');
    assert.equal(first.vendorName?.length,100);assert.equal(first.vendorTwitter,undefined);
    assert.equal(first.attribution.status,'operator_supplied');assert.equal(first.attribution.verification,'unverified');
    assert.equal(first.attribution.label?.length,100);assert.equal(first.attribution.category,'operator_defined');
    assert.equal(first.funding.address,walletAddress(40));assert.equal(first.funding.verification,'vendor_claim');
    assert.equal(first.funding.label?.length,100);assert.equal(first.risks.length,12);
    assert.equal(profiles[1].attribution.status,'unknown');assert.equal(profiles[1].attribution.label,undefined);
    assert.equal(profiles[1].vendorTwitter,'vendor_user');
    const json=JSON.stringify(compact);
    assert.equal(json.includes(marker),false);assert.equal(json.includes('privateKey'),false);
    assert.equal(json.includes('enrichment'),false);assert.equal(json.includes('\\n'),false);
    assert.equal(json.includes('\u202e'),false);
  } finally {archive.close();}
});
