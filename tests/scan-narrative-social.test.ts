import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ScanArchive} from '../src/scan-archive.js';
import type {Report} from '../src/types.js';
import {signal,pass,narrative,now} from './helpers.js';
import {readConfig} from '../src/config.js';

function report():Report {
 return {id:'presentation',mode:'live',policyVersion:'test',signal:signal(),receivedAt:now.toISOString(),evaluatedAt:now.toISOString(),
 validUntil:new Date(now.getTime()+60000).toISOString(),decision:'WATCH',buyEligible:false,executionEnabled:false,reasons:[],provenance:pass(),safety:pass(),narrative:narrative()};
}
const capture=(archive:ScanArchive,r:Report)=>archive.capture({id:r.id,signal:r.signal,status:'completed',receivedAt:r.receivedAt,report:r});
test('optional vendor narrative survives restart with line breaks, bounded content and a sanitized source link',()=>{
 const dir=mkdtempSync(join(tmpdir(),'narrative-display-')),path=join(dir,'scans.sqlite');let archive=new ScanArchive(path,{now:()=>now});
 try {
  const r=report();r.narrative={...narrative(),status:'unknown',reasons:['VENDOR_REFERENCE_MISSING'],supplier:{provider:'debot',text:'第一段\n第二段 <script>unsafe()</script>\u001b\u202e',sourceUrl:'https://debot.ai/token/bsc/'+r.signal.token.address+'?session=PRIVATE_SESSION',updatedAt:now.toISOString(),verification:'vendor_endpoint',contentType:'vendor_ai_narrative'}};
  capture(archive,r);archive.close();archive=new ScanArchive(path,{now:()=>now});
  const saved=archive.get(r.id)!;assert.equal(saved.narrative!.text,'第一段\n第二段 <script>unsafe()</script>');
  assert.equal(saved.narrative!.textTruncated,false);assert.equal(saved.narrative!.updatedAt,now.toISOString());
  assert.equal(saved.narrative!.sourceUrl!.includes('PRIVATE_SESSION'),false);assert.equal(saved.decision,'WATCH');
  const missing={...r,narrative:{...r.narrative,supplier:undefined,analysis:undefined,reasons:['VENDOR_NARRATIVE_MISSING']}};
  capture(archive,missing);assert.equal(archive.get(r.id)!.narrative!.text,saved.narrative!.text);
  assert.equal(archive.get(r.id)!.narrative!.retained,true);assert.equal(archive.get(r.id)!.narrative!.updatedAt,now.toISOString());
  r.narrative.supplier!.text='长'.repeat(13000);capture(archive,r);assert.equal(archive.get(r.id)!.narrative!.text!.length,12000);assert.equal(archive.get(r.id)!.narrative!.textTruncated,true);
  r.narrative.reasons=['VENDOR_NARRATIVE_TOKEN_MISMATCH'];capture(archive,r);assert.equal(archive.get(r.id)!.narrative!.text,undefined);
 }finally{archive.close();rmSync(dir,{recursive:true,force:true});}
});
test('social projection preserves bounded research weights and excludes unknown fields and unsafe URLs',()=>{
 const archive=new ScanArchive(':memory:',{now:()=>now});try {
  const r=report();r.social={score:999,scope:'research_priority',endorsementVerified:false,signals:[
   ...['cz','heyi','toly'].map(person=>({person,label:person,kind:'profile_link' as const,weight:5,sourceUrl:'https://x.com/'+person+'?token=PRIVATE_SESSION',verification:'project_link' as const})),
   {person:'bad',kind:'profile_link',weight:5,sourceUrl:'https://evil.example/x.com/elonmusk',verification:'project_link'},
  ]};capture(archive,r);
  let saved=archive.get(r.id)!.social!;assert.equal(saved.score,10);assert.equal(saved.signals.length,3);assert.equal(JSON.stringify(saved).includes('PRIVATE_SESSION'),false);
  r.social.signals.push({person:'elon',kind:'ca_post',weight:20,sourceUrl:'https://x.com/elonmusk/status/123',verification:'third_party',evidenceId:'x:123'});capture(archive,r);
  saved=archive.get(r.id)!.social!;assert.equal(saved.score,30);assert.equal(saved.endorsementVerified,false);
 }finally{archive.close();}
});
test('watch config bounds global work and does not enable live entry',()=>{
 const c=readConfig({WATCH_RECHECK_ENABLED:'true'});assert.equal(c.watch.enabled,true);assert.equal(c.watch.windowSec,600);assert.equal(c.watch.intervalSec,120);assert.equal(c.watch.maxPerCycle,1);assert.equal(c.entryMode,'off');
 for(const env of [{WATCH_RECHECK_MAX_PER_CYCLE:'4'},{WATCH_WINDOW_SEC:'-1'},{WATCH_RECHECK_INTERVAL_SEC:'0'},{WATCH_RECHECK_ENABLED:'yes'}])assert.throws(()=>readConfig(env));
});
