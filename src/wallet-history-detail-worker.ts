import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {readWalletHistoryDetail,readWalletHistoryList,readWalletResearchSeedHints,type WalletHistoryListOptions} from './wallet-history.js';
import {readWalletAssociationDetail,readWalletAssociationList,type WalletAssociationListOptions} from './wallet-associations.js';
import {WalletProfileReader,type WalletProfile,type WalletProfileListOptions} from './wallet-profiles.js';
import type {ScanListOptions} from './scan-archive.js';
import {TokenRankResearchReader,type TokenRankResearchPage,type TokenRankWalletPage} from './token-rank-research.js';
import type {Chain} from './types.js';
import {MemeDashboardReader} from './meme-dashboard-reader.js';
import type {MemePage} from './meme-observer.js';
import {SourceCorroborationReader} from './source-corroboration.js';

const options=workerData as {database?:string;profileDatabase?:string;scanDatabase?:string;tokenRankDatabase?:string;memeDatabase?:string;
  memeMaxActive?:number;memeActiveWindowSec?:number;memeAllowedChains?:Chain[];memeSamplingPlanPath?:string;
  corroborationDatabase?:string;corroborationWindowSec?:number};
const db=options.database?new DatabaseSync(options.database,{readOnly:true}):undefined;
db?.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
const profiles=options.profileDatabase?new WalletProfileReader(options.profileDatabase):undefined;
const scans=options.scanDatabase?new DatabaseSync(options.scanDatabase,{readOnly:true}):undefined;
scans?.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
const tokenRank=options.tokenRankDatabase?new TokenRankResearchReader(options.tokenRankDatabase):undefined;
const source=options.corroborationDatabase?new SourceCorroborationReader(options.corroborationDatabase,options.corroborationWindowSec):undefined;
const memes=options.memeDatabase?new MemeDashboardReader({database:options.memeDatabase,maxActive:options.memeMaxActive??180,
  activeWindowSec:options.memeActiveWindowSec??7200,allowedChains:options.memeAllowedChains??['bsc','solana','robinhood'],
  samplingPlanPath:options.memeSamplingPlanPath,
  corroboration:source?(token,now)=>source.assess(token,now):undefined}):undefined;

const profileWithHints=(profile:WalletProfile|undefined)=>{
  if(!profile)return;const researchSeeds=db?readWalletResearchSeedHints(db,profile.chain,profile.address):[];
  return {...profile,...(researchSeeds.length?{researchSeeds}:{})};
};

const scanProjection=`json_object('id',id,'chain',chain,'address',address,'status',status,'decision',decision,
  'receivedAt',received_at,'occurredAt',json_extract(record,'$.occurredAt'),'evaluatedAt',json_extract(record,'$.evaluatedAt'),
  'source',json_extract(record,'$.source'),'name',json_extract(record,'$.name'),'symbol',json_extract(record,'$.symbol'),
  'validUntil',json_extract(record,'$.validUntil'),'buyEligible',CASE json_type(record,'$.buyEligible') WHEN 'true' THEN json('true') WHEN 'false' THEN json('false') END,
  'performance',json_remove(json_extract(record,'$.performance'),'$.points','$.priceEvidence'),
  'narrative',CASE WHEN json_type(record,'$.narrative')='object' THEN json_object(
    'thesis',substr(json_extract(record,'$.narrative.thesis'),1,240),'text',substr(json_extract(record,'$.narrative.text'),1,240),
    'textTruncated',json('true'),'listExcerpt',json('true'),'supplier',json_extract(record,'$.narrative.supplier'),
    'updatedAt',json_extract(record,'$.narrative.updatedAt'),'retained',CASE json_type(record,'$.narrative.retained') WHEN 'true' THEN json('true') WHEN 'false' THEN json('false') END) END,
  'social',CASE WHEN json_type(record,'$.social')='object' THEN json_object(
    'score',json_extract(record,'$.social.score'),'scope',json_extract(record,'$.social.scope')) END,
  'walletScreening',CASE WHEN json_type(record,'$.walletScreening')='object' THEN json_object(
    'scope',json_extract(record,'$.walletScreening.scope'),'status',json_extract(record,'$.walletScreening.status'),
    'validUntil',json_extract(record,'$.walletScreening.validUntil'),'priorityScore',json_extract(record,'$.walletScreening.priorityScore'),
    'setups',json((SELECT json_group_array(json_object('route',json_extract(value,'$.route'))) FROM json_each(record,'$.walletScreening.setups')))) END) AS record`;

type Row=Record<string,any>;
const scanSearch=(value:unknown)=>typeof value==='string'
  ?value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,200).toLowerCase():'';
function observation(row:Row|undefined){
  if(!row)return;
  return {state:row.state,firstReceivedAt:row.first_received_at,endsAt:row.ends_at,
    ...(row.next_check_at?{nextCheckAt:row.next_check_at}:{}),...(row.last_check_at?{lastCheckAt:row.last_check_at}:{}),
    attempts:row.attempts,...(row.end_reason?{endReason:row.end_reason}:{})};
}
function scanList(options:ScanListOptions={}){
  if(!scans)throw new Error('SCAN_DATABASE_UNAVAILABLE');
  const limit=Number.isSafeInteger(options.limit)?Math.max(1,Math.min(20,options.limit!)):20,
    offset=Number.isSafeInteger(options.offset)?Math.max(0,options.offset!):0,clauses:string[]=[],values:(string|number)[]=[];
  if(options.chain){clauses.push('chain=?');values.push(options.chain);}
  if(options.decision){clauses.push('decision=?');values.push(options.decision);}
  if(options.eligible!==undefined)clauses.push(`eligible_at IS ${options.eligible?'NOT ':''}NULL`);
  const search=scanSearch(options.search);
  if(search){clauses.push("(instr(lower(address),?)>0 OR instr(lower(COALESCE(json_extract(record,'$.name'),'')),?)>0 OR instr(lower(COALESCE(json_extract(record,'$.symbol'),'')),?)>0)");values.push(search,search,search);}
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'',total=Number(scans.prepare(`SELECT count(*) AS n FROM scan_summaries ${where}`).get(...values)!.n),
    rows=scans.prepare(`SELECT ${scanProjection} FROM scan_summaries ${where} ORDER BY received_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...values,limit,offset),
    records=rows.map(row=>JSON.parse(String(row.record)) as Row),ids=records.map(record=>record.id),watch=new Map<string,Row>();
  if(ids.length)for(const row of scans.prepare('SELECT * FROM watch_jobs WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)))watch.set(String(row.id),row);
  return {items:records.map(record=>{const state=observation(watch.get(String(record.id)));return state?{...record,observation:state}:record;}),total};
}
function scanDetail(id:string){
  if(!scans)throw new Error('SCAN_DATABASE_UNAVAILABLE');
  const row=scans.prepare('SELECT record FROM scan_summaries WHERE id=?').get(id);if(!row)return;
  const record=JSON.parse(String(row.record)) as Row,state=observation(scans.prepare('SELECT * FROM watch_jobs WHERE id=?').get(id));
  return state?{...record,observation:state}:record;
}

interface QueryMessage {
  type:string;id?:number;query?:'wallet-detail'|'wallet-list'|'profile-list'|'profile-detail'|'association-list'|'association-detail'|
    'scan-list'|'scan-detail'|'token-rank-list'|'token-rank-detail'|'token-rank-wallet-list'|'token-rank-wallet-detail'|'meme-list'|'meme-detail'|'meme-status';
  chain?:Chain;address?:string;leader?:string;candidate?:string;scanId?:string;options?:WalletHistoryListOptions|WalletProfileListOptions|
    WalletAssociationListOptions|ScanListOptions|TokenRankResearchPage|TokenRankWalletPage|MemePage;
  context?:{now:string;status?:unknown};
}

let stopping=false;
parentPort!.on('message',(message:QueryMessage)=>{
  if(message?.type==='stop'){
    stopping=true;memes?.close();source?.close();tokenRank?.close();profiles?.close();scans?.close();db?.close();parentPort!.close();return;
  }
  if(stopping||message?.type!=='query'||!Number.isSafeInteger(message.id)||!message.query)return;
  try {
    let value:unknown;
    switch(message.query) {
      case 'wallet-detail':
        value=db&&message.chain&&message.address?readWalletHistoryDetail(db,message.chain,message.address):undefined;break;
      case 'wallet-list':
        if(!db)throw new Error('WALLET_DATABASE_UNAVAILABLE');
        value=readWalletHistoryList(db,message.options as WalletHistoryListOptions|undefined);break;
      case 'profile-list': {
        const page=profiles?.list(message.options as WalletProfileListOptions|undefined)??{ready:false,items:[],total:0};
        value={...page,items:page.items.map(profileWithHints)};break;
      }
      case 'profile-detail':
        value=message.chain&&message.address?profileWithHints(profiles?.get(message.chain,message.address)):undefined;break;
      case 'association-list':
        if(!db)throw new Error('WALLET_DATABASE_UNAVAILABLE');
        value=readWalletAssociationList(db,message.options as WalletAssociationListOptions|undefined);break;
      case 'association-detail':
        value=db&&message.chain&&message.leader&&message.candidate?
          readWalletAssociationDetail(db,message.chain,message.leader,message.candidate):undefined;break;
      case 'scan-list':value=scanList(message.options as ScanListOptions|undefined);break;
      case 'scan-detail':value=message.scanId?scanDetail(message.scanId):undefined;break;
      case 'token-rank-list':
        if(!tokenRank)throw new Error('TOKEN_RANK_DATABASE_UNAVAILABLE');
        value=tokenRank.list(message.options as TokenRankResearchPage|undefined);break;
      case 'token-rank-detail':
        if(!tokenRank||!message.chain||!message.address)throw new Error('TOKEN_RANK_DATABASE_UNAVAILABLE');
        value=tokenRank.detail(message.chain,message.address,message.options as TokenRankResearchPage|undefined);break;
      case 'token-rank-wallet-list':
        if(!tokenRank)throw new Error('TOKEN_RANK_DATABASE_UNAVAILABLE');
        value=tokenRank.wallets(message.options as TokenRankWalletPage|undefined);break;
      case 'token-rank-wallet-detail':
        if(!tokenRank||!message.chain||!message.address)throw new Error('TOKEN_RANK_DATABASE_UNAVAILABLE');
        value=tokenRank.wallet(message.chain,message.address,message.options as TokenRankResearchPage|undefined);break;
      case 'meme-list':
        if(!memes||!message.context)throw new Error('MEME_DATABASE_UNAVAILABLE');
        value=memes.list(message.options as MemePage|undefined,{now:message.context.now,status:message.context.status});break;
      case 'meme-detail':
        if(!memes||!message.chain||!message.address||!message.context)throw new Error('MEME_DATABASE_UNAVAILABLE');
        value=memes.detail({chain:message.chain,address:message.address},message.options as MemePage|undefined,{now:message.context.now});break;
      case 'meme-status':
        if(!memes||!message.context)throw new Error('MEME_DATABASE_UNAVAILABLE');
        value=memes.status(new Date(message.context.now),message.context.status&&typeof message.context.status==='object'?
          message.context.status as Record<string,unknown>:{});break;
    }
    parentPort!.postMessage({type:'result',id:message.id,value});
  } catch {
    parentPort!.postMessage({type:'failed',id:message.id,error:'WALLET_HISTORY_DETAIL_READ_FAILED'});
  }
});
