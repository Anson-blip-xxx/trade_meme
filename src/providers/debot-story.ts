import bs58 from 'bs58';
import {z} from 'zod';
import {Chain,VendorNarrativeSchema,type Signal,type VendorNarrative} from '../types.js';
import {xPostId} from './evidence.js';

const Envelope=z.object({
  code:z.literal(0),success:z.literal(true),
  data:z.object({version:z.literal('v2'),history:z.object({
    id:z.string().min(1).max(160),
    ca_address:z.string().min(32).max(44),
    generated_at:z.iso.datetime({offset:true}),
    source_tweets:z.array(z.string().regex(/^\d{1,20}$/)).max(2000),
    story:z.object({
      project_name:z.string().min(1).max(500),
      contract_address:z.string().min(32).max(44),
      narrative_type:z.string().max(500),
      rating:z.object({score:z.string().min(1).max(40),reason:z.string().max(6000)}),
    }).catchall(z.unknown()),
  })}),
});
interface Section {path:string;text:string;reference:string;}
function invalid(message:string,path:(string|number)[]=[]):never {
  throw new z.ZodError([{code:'custom',path,message}]);
}
function sameAddress(a:string,b:string,chain:Signal['token']['chain']):boolean {
  return chain==='solana'?a===b:a.toLowerCase()===b.toLowerCase();
}
const labels:Record<string,string>={
  background:'背景',origin:'起源',narrative_type:'叙事类型',distribution:'传播与社区',
  celebrity_support:'名人支持',negative_incidents:'负面事件',developer_info:'开发者信息',
  identity:'身份',address_analysis:'地址分析',valuation:'估值描述',current_marketcap:'当前市值',
  benchmark_project:'对标项目',name:'名称',address:'地址',reason:'原因',
  narrative:'叙事',community:'社区',community_activity:'社区活跃度',social_media:'社交媒体',
  social_presence:'社交平台',community_size:'社区规模',engagement:'互动',
  max_views:'最高浏览量',max_likes:'最高点赞数',max_comments:'最高评论数',community_participation:'社区参与',
  concept:'概念',description:'描述',team:'团队',uniqueness:'独特性',
};

function collectSections(value:unknown,path:string,sections:Section[],depth=0,inheritedRef=''):void {
  if(depth>10||sections.length>=100) invalid('DeBot 叙事字段层级或数量超出限制',['data','history','story']);
  if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean') {
    sections.push({path,text:value===null?'':String(value),reference:inheritedRef});return;
  }
  if(Array.isArray(value)) {
    value.forEach((item,index)=>collectSections(item,`${path}[${index}]`,sections,depth+1,inheritedRef));return;
  }
  if(!value||typeof value!=='object') invalid('DeBot 叙事字段必须是 JSON 数据',['data','history','story',path]);
  const object=value as Record<string,unknown>;
  if(object.ref!==undefined&&typeof object.ref!=='string') invalid('DeBot 引用字段必须是字符串',['data','history','story',path,'ref']);
  const reference=typeof object.ref==='string'?object.ref:inheritedRef;
  if(Object.hasOwn(object,'text')) {
    if(typeof object.text!=='string') invalid('DeBot 叙事原文必须是字符串',['data','history','story',path,'text']);
    sections.push({path,text:object.text,reference});
  }
  for(const [key,child] of Object.entries(object)) {
    if(key!=='text'&&key!=='ref') collectSections(child,path?`${path}.${key}`:key,sections,depth+1,reference);
  }
}

function referenceIds(reference:string):string[] {
  const direct=xPostId(reference);
  if(direct) return [direct];
  return (reference.match(/https?:\/\/[^\s<>"'（）【】]+/g)??[])
    .map(url=>xPostId(url.replace(/[,.;!?，。；！？、:：)\]}]+$/g,'')))
    .filter((id):id is string=>!!id);
}

/** Parse a supplied DeBot response; this performs no request or vendor authentication. */
export function normalizeDebotStory(payload:unknown,token:Signal['token'],sourceUrl:string):VendorNarrative {
  const target=z.object({chain:Chain,address:z.string().min(32).max(44)}).strict().parse(token);
  let valid=false;
  try {valid=target.chain==='solana'?bs58.decode(target.address).length===32:/^0x[0-9a-fA-F]{40}$/.test(target.address);}
  catch {valid=false;}
  if(!valid) invalid('目标链和完整 CA 不匹配',['token','address']);
  const {history}=Envelope.parse(payload).data;
  for(const [field,address] of [['ca_address',history.ca_address],['story.contract_address',history.story.contract_address]]) {
    if(!sameAddress(address,target.address,target.chain)) invalid('DeBot history 和中文 story 的 CA 必须分别匹配目标',['data','history',field]);
  }
  let page:URL;
  try {page=new URL(sourceUrl);} catch {invalid('请提供对应 DeBot 代币页面',['sourceUrl']);}
  if(page.protocol!=='https:'||page.username||page.password||page.port||!['debot.ai','www.debot.ai'].includes(page.hostname)) {
    invalid('DeBot 来源必须是 debot.ai 的 HTTPS 页面',['sourceUrl']);
  }
  if(page.pathname==='/api/v1/nitter/story/latest') {
    // This endpoint has no chain parameter or chain field in its response.
    // Robinhood cannot be attributed safely from an EVM address alone.
    if(target.chain==='robinhood') invalid('DeBot 接口的 Robinhood 链范围未确认',['token','chain']);
    const addresses=page.searchParams.getAll('ca_address'),requests=page.searchParams.getAll('request_id');
    if(page.hostname!=='debot.ai'||page.hash||addresses.length!==1||requests.length!==1||
      !z.uuid().safeParse(requests[0]).success||!sameAddress(addresses[0],target.address,target.chain)||
      [...page.searchParams.keys()].some(key=>!['ca_address','request_id'].includes(key))) {
      invalid('DeBot API 来源必须包含唯一请求 ID 和匹配目标的完整 CA',['sourceUrl']);
    }
  } else {
    const path=page.pathname.match(/^\/token\/(bsc|solana|sol|robinhood)\/(?:\d+_)?([^/]+)\/?$/);
    const pageChain=path?.[1]==='sol'?'solana':path?.[1];
    if(!path||pageChain!==target.chain||!sameAddress(path[2],target.address,target.chain)) {
      invalid('DeBot 页面路径的链和 CA 必须匹配目标',['sourceUrl']);
    }
  }
  const story=history.story,sections:Section[]=[];
  // Only the Chinese story is used; translated copies never count as extra narratives.
  for(const [key,value] of Object.entries(story)) {
    if(!['project_name','contract_address','narrative_type','rating'].includes(key)) collectSections(value,key,sections);
  }
  const lines=[`项目：${story.project_name}`,`合约：${story.contract_address}`,`叙事类型：${story.narrative_type}`,
    '以下为 DeBot 供应商描述；市值、持仓和身份等内容未经本服务链上独立核验。'];
  for(const section of sections) {
    const label=section.path.split('.').map(part=>labels[part]??part).join(' / ');
    lines.push(`${label}：${section.text||'未提供'}`);
    if(section.reference) lines.push(`引用：${section.reference}`);
  }
  lines.push(`供应商原始评分：${story.rating.score}（评分满分未知，未归一化）`,`评分理由：${story.rating.reason}`);
  const ids=new Set<string>();
  for(const section of sections) for(const id of referenceIds(section.reference)) ids.add(id);
  for(const id of history.source_tweets) ids.add(id);
  return VendorNarrativeSchema.parse({
    provider:'debot',token:target,sourceUrl,text:lines.join('\n'),updatedAt:history.generated_at,
    evidenceUrls:[...ids].slice(0,8).map(id=>`https://x.com/i/web/status/${id}`),
    structured:{format:'debot_story_v2',historyId:history.id,projectName:story.project_name,
      narrativeType:story.narrative_type,rating:{...story.rating},sections,sourceTweetIds:[...history.source_tweets]},
  });
}
