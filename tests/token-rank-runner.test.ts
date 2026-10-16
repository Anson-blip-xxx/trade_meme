import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WalletHistory} from '../src/wallet-history.js';
import {TokenRankResearchRunner} from '../src/token-rank-runner.js';
import {readConfig} from '../src/config.js';
import {createRuntime} from '../src/runtime.js';

const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
async function until(check:()=>boolean){
  const deadline=Date.now()+20000;
  while(!check()){assert.ok(Date.now()<deadline,'token rank worker did not progress');await new Promise(r=>setTimeout(r,50));}
}
test('rank research runs without dashboard requests, processes new evidence and resumes after restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'token-rank-runner-'));
  const history=new WalletHistory(join(dir,'history.sqlite'));
  const options={database:join(dir,'rank.sqlite'),historyDatabase:join(dir,'history.sqlite'),maxBytes:16*1024*1024,intervalSec:1,batchSize:100};
  let runner=new TokenRankResearchRunner(options);
  const rank=(n:number)=>history.captureTokenRanks('bsc',[{address:address(n),rank:1,interval:'1h',changeMetric:'20',changeUnit:'vendor_unspecified'}],
    {source:'gmgn_change1h_rank',observedAt:new Date().toISOString()});
  try{
    rank(1);runner.start();runner.start();
    await until(()=>runner.reader.list({limit:20,offset:0}).total>=1);
    assert.equal(runner.status().restarts,0);assert.equal(runner.status().tradingEnabled,false);
    assert.ok(runner.reader.detail('bsc',address(1),{limit:20,offset:0}));
    rank(2);await until(()=>runner.reader.list({limit:20,offset:0}).total>=2);
    await runner.stop();assert.equal(runner.status().running,false);
    runner=new TokenRankResearchRunner(options);assert.equal(runner.reader.list({limit:20,offset:0}).total,2);
    runner.start();await until(()=>runner.status().ready===true);
    assert.equal(runner.reader.list({limit:20,offset:0}).total,2);
  }finally{await runner.stop();history.close();rmSync(dir,{recursive:true,force:true});}
});
test('rank research startup errors expose fixed diagnostics and stop cancels restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'token-rank-failure-'));
  const runner=new TokenRankResearchRunner({database:join(dir,'rank.sqlite'),historyDatabase:join(dir,'private-missing.sqlite'),
    maxBytes:16*1024*1024,intervalSec:1,batchSize:20});
  try{
    runner.start();await until(()=>runner.status().restarts===1);
    assert.equal(runner.status().running,false);assert.match(runner.status().error??'',/^TOKEN_RANK_WORKER_/);
    assert.doesNotMatch(JSON.stringify(runner.status()),/private-missing|sqlite|\/tmp\//);
    await runner.stop();assert.equal(runner.status().running,false);
  }finally{await runner.stop();rmSync(dir,{recursive:true,force:true});}
});
test('rank research default paths follow isolated history and never alias a business database or session',()=>{
  assert.equal(readConfig({}).tokenRankResearch!.enabled,false);
  const cfg=readConfig({WALLET_RESEARCH_ENABLED:'true',WALLET_HISTORY_DATABASE_PATH:'/tmp/custom-history.sqlite'});
  assert.equal(cfg.tokenRankResearch!.enabled,true);assert.equal(cfg.tokenRankResearch!.database,'/tmp/custom-history.sqlite.rank-research.sqlite');
  assert.equal(readConfig({WALLET_RESEARCH_ENABLED:'true',TOKEN_RANK_RESEARCH_ENABLED:'false'}).tokenRankResearch!.enabled,false);
  for(const bad of [{TOKEN_RANK_RESEARCH_DATABASE_PATH:':memory:'},{TOKEN_RANK_RESEARCH_INTERVAL_SEC:'0'},
    {TOKEN_RANK_RESEARCH_BATCH_SIZE:'2001'},{TOKEN_RANK_RESEARCH_MAX_MB:'1'}])assert.throws(()=>readConfig(bad));
  const dir=mkdtempSync(join(tmpdir(),'rank-path-')),path=join(dir,'private-session.json');writeFileSync(path,'unchanged');
  try{
    for(const [name,link] of [['symlink',symlinkSync],['hardlink',linkSync]] as const){
      const alias=join(dir,name);link(path,alias);
      assert.throws(()=>new TokenRankResearchRunner({database:alias,historyDatabase:path,maxBytes:16*1024*1024,intervalSec:1,batchSize:20}),/MUST_BE_SEPARATE/);
      assert.throws(()=>createRuntime(readConfig({TOKEN_RANK_RESEARCH_ENABLED:'true',TOKEN_RANK_RESEARCH_DATABASE_PATH:alias,AVE_SESSION_PATH:path})),/MUST_BE_SEPARATE/);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
