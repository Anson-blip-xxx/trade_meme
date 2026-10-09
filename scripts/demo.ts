import {mkdirSync,writeFileSync} from 'node:fs';
import {readConfig} from '../src/config.js';
import {evaluate,type Providers} from '../src/engine.js';
import {unknown,type Signal,type Check,type NarrativeReport} from '../src/types.js';

// Entirely synthetic provider snapshots. Never exported to the live HTTP service.
const now=new Date();
const base:Signal={source:'manual',sourceEventId:'demo',occurredAt:now.toISOString(),
  token:{chain:'bsc',address:'0x1111111111111111111111111111111111114444'},claimedPlatform:'four',
  text:'虚构演示：社区活动引发的新梗，不是真实投资标的。',evidenceUrls:[],claim:'community'};
const pass=():Check=>({status:'pass',reasons:['SYNTHETIC_DEMO_EVIDENCE'],facts:{synthetic:true},checkedAt:now.toISOString()});
const narrative=():NarrativeReport=>({...pass(),evidence:[],analysis:{thesis:'虚构社区梗传播',catalyst:'虚构公开活动',
  relation:'community',stage:'spreading',assessment:'favorable',confidence:'medium',supportingEvidenceIds:[],opposingEvidenceIds:[],
  reasons:['仅演示决策组合，不是实际模型判断'],uncertainties:['所有数据均为模拟']}});
const cases=[
  {name:'01-candidate',safety:pass(),provenance:{...pass(),platform:'four' as const}},
  {name:'02-unknown-origin',safety:pass(),provenance:unknown('NO_MATCHING_OFFICIAL_CREATION')},
  {name:'03-unsafe-contract',safety:{...pass(),status:'fail' as const,reasons:['EVM_IS_HONEYPOT']},provenance:{...pass(),platform:'four' as const}},
  {name:'04-missing-security',safety:unknown('GOPLUS_UNAVAILABLE'),provenance:{...pass(),platform:'four' as const}},
];
mkdirSync('data/demo',{recursive:true});
for(const c of cases) {
  const providers:Providers={provenance:async()=>c.provenance,safety:async()=>c.safety,evidence:async()=>[],narrative:async()=>narrative()};
  const report=await evaluate({...base,sourceEventId:c.name},readConfig({WALLET_SUPPORT_REQUIRED:'false'}),providers,{mode:'demo',now:()=>now});
  writeFileSync(`data/demo/${c.name}.json`,JSON.stringify(report,null,2)+'\n');
  console.log(`${c.name}: ${report.decision}; mode=demo; buyEligible=${report.buyEligible}; executionEnabled=false`);
}
console.log('Synthetic reports saved to data/demo/. No external API or transaction was called.');
