import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {runStrategyEvolutionDaily} from '../src/strategy-evolution-daily.js';
import {StrategyEvolutionSignalLedger,strategyEvolutionDatabasePath} from '../src/strategy-evolution-signals.js';
import {StrategyEvolutionStore} from '../src/strategy-evolution-store.js';
import {assignStrategyArm} from '../src/strategy-evolution.js';
import type {Signal} from '../src/types.js';

const origin=Date.parse('2026-11-01T00:00:00.000Z'),at=(minutes:number)=>new Date(origin+minutes*60_000).toISOString();
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const signal=(id:string,address:string,observedAt:string):Signal=>({source:'debot',sourceEventId:id,occurredAt:observedAt,
  token:{chain:'bsc',address},text:id} as Signal);

test('daily controller enrolls only post-effective mature sessions and keeps promotion research-only',t=>{
  const dir=mkdtempSync(join(tmpdir(),'strategy-evolution-daily-')),archive=join(dir,'scans.sqlite'),meme=join(dir,'meme.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const price=new DatabaseSync(meme);price.exec(`CREATE TABLE meme_price_archive(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,
    observed_at TEXT,source TEXT,pool_address TEXT,price_usd REAL)`);price.close();
  const firstAsOf=at(0),initial=runStrategyEvolutionDaily({archivePath:archive,memeDatabase:meme,asOf:firstAsOf,chains:['bsc']});
  assert.equal(initial.results.length,2);assert.ok(initial.results.every(row=>row.decision==='continue'));
  const evolutionPath=strategyEvolutionDatabasePath(archive),reader=new StrategyEvolutionStore(evolutionPath,{now:()=>new Date(at(1000))});
  const candidate=reader.listCandidates().find(row=>row.scope.source==='debot'&&row.scope.chain==='bsc')!;
  let championAddress='',challengerAddress='';for(let n=1;n<100&&(!championAddress||!challengerAddress);n++){
    const value=address(n),arm=assignStrategyArm(candidate.id,`bsc:${value}`);if(arm==='champion')championAddress=value;else challengerAddress=value;
  }reader.close();assert.ok(championAddress&&challengerAddress);
  const ledger=new StrategyEvolutionSignalLedger(evolutionPath,{now:()=>new Date(at(1000))});
  for(const [token,prefix] of [[championAddress,'c'],[challengerAddress,'x']] as const)for(let ordinal=1;ordinal<=3;ordinal++){
    const observed=at(10+ordinal);ledger.record({signal:signal(`${prefix}${ordinal}`,token,observed),observedAt:observed});
  }ledger.close();
  const writer=new DatabaseSync(meme),insert=writer.prepare('INSERT INTO meme_price_archive(chain,address,observed_at,source,pool_address,price_usd) VALUES(?,?,?,?,?,?)');
  for(let index=0;index<=180;index++)insert.run('bsc',championAddress,at(13+index*2),'dexscreener_token_pairs_sample',address(999),1+index/180);
  writer.close();
  const second=runStrategyEvolutionDaily({archivePath:archive,memeDatabase:meme,asOf:at(1000),chains:['bsc']});
  const debot=second.results.find(row=>row.source==='debot')!;assert.equal(debot.enrolled,2);assert.equal(debot.results,2);
  const verify=new StrategyEvolutionStore(evolutionPath,{now:()=>new Date(at(1000))}),episodes=verify.listEpisodes(candidate.id);t.after(()=>verify.close());
  assert.equal(episodes.length,2);assert.ok(episodes.every(row=>row.result?.status==='valid'),JSON.stringify(episodes));
  assert.equal(verify.getResearchChampion(candidate.scope),undefined);
  assert.equal(candidate.liveMutation,'forbidden');assert.equal(candidate.execution,'research_only');
});

test('a terminal experiment is retained while the research loop advances to an untested challenger',t=>{
  const dir=mkdtempSync(join(tmpdir(),'strategy-evolution-terminal-')),archive=join(dir,'scans.sqlite'),meme=join(dir,'meme.sqlite');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const price=new DatabaseSync(meme);price.exec(`CREATE TABLE meme_price_archive(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,
    observed_at TEXT,source TEXT,pool_address TEXT,price_usd REAL)`);price.close();
  runStrategyEvolutionDaily({archivePath:archive,memeDatabase:meme,asOf:at(0),chains:['bsc']});
  const path=strategyEvolutionDatabasePath(archive),store=new StrategyEvolutionStore(path,{now:()=>new Date(at(1))});
  const candidate=store.listCandidates().find(row=>row.scope.source==='debot')!;store.rejectCandidate(candidate.id,'TEST_TERMINAL',at(1));
  const before=store.listCandidates().length;store.close();
  const next=runStrategyEvolutionDaily({archivePath:archive,memeDatabase:meme,asOf:at(1440),chains:['bsc']});
  const verify=new StrategyEvolutionStore(path,{now:()=>new Date(at(1440))});t.after(()=>verify.close());const candidates=verify.listCandidates();
  assert.equal(candidates.length,before+1);assert.equal(candidates.filter(row=>row.scope.source==='debot'&&
    row.championPolicy.triggerCount===3&&row.challengerPolicy.triggerCount===4).length,1);
  const successor=candidates.find(row=>row.scope.source==='debot'&&row.status==='forward_shadow');assert.equal(successor?.championPolicy.triggerCount,3);
  assert.equal(successor?.challengerPolicy.triggerCount,2);assert.equal(next.results.find(row=>row.source==='debot')?.decision,'continue');
});

test('sessions that began before activation are excluded from the forward cohort',t=>{
  const dir=mkdtempSync(join(tmpdir(),'strategy-evolution-boundary-')),archive=join(dir,'scans.sqlite'),meme=join(dir,'meme.sqlite');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));const price=new DatabaseSync(meme);
  price.exec(`CREATE TABLE meme_price_archive(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,observed_at TEXT,source TEXT,pool_address TEXT,price_usd REAL)`);price.close();
  runStrategyEvolutionDaily({archivePath:archive,memeDatabase:meme,asOf:at(10),chains:['bsc']});
  const path=strategyEvolutionDatabasePath(archive),ledger=new StrategyEvolutionSignalLedger(path,{now:()=>new Date(at(1000))}),token=address(77);
  for(const [id,minute] of [['old-1',5],['old-2',11],['old-3',12]] as const)ledger.record({signal:signal(id,token,at(minute)),observedAt:at(minute)});
  ledger.close();runStrategyEvolutionDaily({archivePath:archive,memeDatabase:meme,asOf:at(1000),chains:['bsc']});
  const store=new StrategyEvolutionStore(path,{now:()=>new Date(at(1000))});t.after(()=>store.close());
  const candidate=store.listCandidates().find(row=>row.scope.source==='debot')!;assert.equal(store.listEpisodes(candidate.id).length,0);
});

test('a mature pending episode is recovered and a hard stop cannot become a rebound profit',t=>{
  const dir=mkdtempSync(join(tmpdir(),'strategy-evolution-recovery-')),archive=join(dir,'scans.sqlite'),meme=join(dir,'meme.sqlite');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));const price=new DatabaseSync(meme);
  price.exec(`CREATE TABLE meme_price_archive(id INTEGER PRIMARY KEY,chain TEXT,address TEXT,observed_at TEXT,source TEXT,pool_address TEXT,price_usd REAL)`);price.close();
  runStrategyEvolutionDaily({archivePath:archive,memeDatabase:meme,asOf:at(0),chains:['bsc']});
  const path=strategyEvolutionDatabasePath(archive),read=new StrategyEvolutionStore(path,{now:()=>new Date(at(1000))});
  const candidate=read.listCandidates().find(row=>row.scope.source==='debot')!;let token='';
  for(let n=100;n<300;n++){const value=address(n);if(assignStrategyArm(candidate.id,`bsc:${value}`)==='champion'){token=value;break;}}
  assert.ok(token);read.close();const ledger=new StrategyEvolutionSignalLedger(path,{now:()=>new Date(at(1000))});
  for(let ordinal=1;ordinal<=3;ordinal++){const observed=at(10+ordinal);ledger.record({signal:signal(`r${ordinal}`,token,observed),observedAt:observed});}ledger.close();
  const pendingStore=new StrategyEvolutionStore(path,{now:()=>new Date(at(1000))});
  pendingStore.registerEpisode(candidate.id,{episodeKey:`bsc:${token}`,registeredAt:at(13),matureAt:at(373),context:{source:'debot',chain:'bsc',address:token,
    sessionId:'recovered',triggerCount:3,triggerAt:at(13),outcomePolicyVersion:'adaptive-shadow-v5',quoteRouteVersion:'earliest-source-priority-v1'}});pendingStore.close();
  const writer=new DatabaseSync(meme),insert=writer.prepare('INSERT INTO meme_price_archive(chain,address,observed_at,source,pool_address,price_usd) VALUES(?,?,?,?,?,?)');
  for(let index=0;index<=180;index++)insert.run('bsc',token,at(13+index*2),'dexscreener_token_pairs_sample',address(999),index===0?1:index===1?0.3:3);
  writer.close();const run=runStrategyEvolutionDaily({archivePath:archive,memeDatabase:meme,asOf:at(1000),chains:['bsc']});
  assert.equal(run.results.find(row=>row.source==='debot')?.enrolled,0);assert.equal(run.results.find(row=>row.source==='debot')?.results,1);
  const verify=new StrategyEvolutionStore(path,{now:()=>new Date(at(1000))});t.after(()=>verify.close());
  const result=verify.listEpisodes(candidate.id)[0].result;assert.equal(result?.status,'valid',JSON.stringify(result));
  if(result?.status==='valid'){assert.equal(result.stopped,true);assert.ok(result.returnPct<0,'post-stop rebound must not overwrite the stopped result');}
});
