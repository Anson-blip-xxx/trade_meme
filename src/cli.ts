import {readFileSync} from 'node:fs';
import {readConfig} from './config.js';
import {parseSignal} from './types.js';
import {evaluate} from './engine.js';
import {normalizeNotification} from './notifications.js';
import {renderReport} from './report.js';
import {normalizeDebotImport} from './debot-import.js';
import {createRuntime} from './runtime.js';
import {localRequest} from './local-api.js';

async function main() {
  const args=process.argv.slice(2),path=args.find(a=>!a.startsWith('--'));
  const allowed=['--notification','--debot-story','--retry','--normalize-only','--text'];
  if(!path||args.some(a=>a.startsWith('--')&&!allowed.includes(a)))
    throw new Error('Usage: npm run analyze -- file.json [--notification|--debot-story] [--normalize-only|--text]; npm run retry -- <id>');
  if(['--retry','--notification','--debot-story'].filter(v=>args.includes(v)).length>1||args.includes('--retry')&&args.includes('--normalize-only')) throw new Error('INCOMPATIBLE_OPTIONS');
  const config=readConfig();
  if(args.includes('--retry')) {
    if(!/^[0-9a-f-]{36}$/.test(path)) throw new Error('INVALID_REPORT_ID');
    const result=await (await localRequest(config,`/v1/signals/${path}/retry`,'POST')).json();
    console.log(args.includes('--text')?renderReport(result.report):JSON.stringify(result,null,2));return;
  }
  const content=readFileSync(path,'utf8');if(Buffer.byteLength(content)>65536) throw new Error('INPUT_TOO_LARGE');
  const input:unknown=JSON.parse(content),signal=args.includes('--debot-story')?normalizeDebotImport(input):args.includes('--notification')?normalizeNotification(input):parseSignal(input);
  if(args.includes('--normalize-only')) {console.log(JSON.stringify(signal,null,2));return;}
  const runtime=createRuntime(config),store=runtime.store;
  try {
    const isDebot=args.includes('--debot-story');
    const result=store.reserve(signal,args.includes('--notification')||isDebot?input:undefined,isDebot?'debot_story_response':'notification_copy');
    if(result.conflict) throw new Error('EVENT_ID_PAYLOAD_CONFLICT');
    const entry=result.entry;
    try {
      const report=await evaluate(entry.signal,config,runtime.providers,{id:entry.id,receivedAt:entry.receivedAt});
      if(!store.finish(report.id,report,entry.claimId!)) throw new Error('PROCESSING_CLAIM_EXPIRED');
      const opening=await runtime.entry.consider(report);
      console.log(args.includes('--text')?renderReport(report)+`\n开单处理：${JSON.stringify(opening)}\n`:JSON.stringify({...report,opening},null,2));
    } catch(e) {store.interrupt(entry.id,entry.claimId!);throw e;}
  } finally {await runtime.close();}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Evaluation failed');process.exitCode=1;});
