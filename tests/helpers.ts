import type {Check,Signal,Provenance,Evidence,Narrative,NarrativeReport} from '../src/types.js';
import {readConfig} from '../src/config.js';
import type {Providers} from '../src/engine.js';
export const now=new Date('2026-10-08T12:00:00.000Z');
export const token='0x1111111111111111111111111111111111114444';
export const config=()=>readConfig({MAX_SIGNAL_AGE_SEC:'600',INGEST_TOKEN:'test-token-with-at-least-24-characters',WALLET_SUPPORT_REQUIRED:'false'});
export const signal=(overrides:Partial<Signal>={}):Signal=>({source:'debot',sourceEventId:'test-1',occurredAt:now.toISOString(),
  token:{chain:'bsc',address:token},text:'虚构社区叙事测试，不是真实市场信号',evidenceUrls:[],claim:'community',...overrides});
export const pass=():Check=>({status:'pass',reasons:['TEST_CHECK'],facts:{},checkedAt:now.toISOString()});
export const evidence=():Evidence[]=>[
  {id:'x:1',url:'https://x.com/i/web/status/1',text:`社区为真实事件创作了一个新梗，社区代币地址 ${token}`,
    authorId:'101',publishedAt:now.toISOString(),fetchedAt:now.toISOString(),provider:'x_official',verification:'first_party',authority:'tracked'},
];
export const analysis=():Narrative=>({thesis:'虚构测试叙事',catalyst:'社区事件',relation:'community',stage:'spreading',assessment:'favorable',
  confidence:'medium',supportingEvidenceIds:['x:1'],opposingEvidenceIds:[],reasons:['测试证据支持'],uncertainties:['非收益预测']});
export const narrative=():NarrativeReport=>({...pass(),evidence:evidence(),analysis:analysis()});
export const providers=():Providers=>({provenance:async()=>({...pass(),platform:'four'} as Provenance),
  safety:async()=>pass(),evidence:async()=>evidence(),narrative:async()=>narrative()});
export const fetchJson=(payload:unknown,status=200):typeof fetch=>async()=>new Response(JSON.stringify(payload),{status});
