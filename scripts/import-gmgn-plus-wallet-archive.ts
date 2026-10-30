import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import bs58 from 'bs58';
import {GmgnPlusArchive,type GmgnArchiveChain} from '../src/gmgn-plus-archive.js';

type JsonObject=Record<string,unknown>;
type SelectionRow={chain:GmgnArchiveChain;address:string;id:string};
type RequestRow={id:string;kind:'stats'|'profits'|'activity'|'holdings'|'callout'|'created_tokens';chain:GmgnArchiveChain;period?:string;
  ids:string[];file:string;bytes:number;sha256:string;success:boolean};
export interface GmgnWalletArchiveImportOptions {root:string;database:string;maxBytes?:number;now?:()=>Date;}
export interface GmgnWalletArchiveImportSummary {phase1Wallets:number;phase2Wallets:number;uniqueWallets:number;requests:number;
  statsRows:number;profitRows:number;activityRows:number;holdingPages:number;holdingRows:number;}

const object=(value:unknown):value is JsonObject=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const chain=(value:unknown):GmgnArchiveChain|undefined=>value==='sol'||value==='solana'?'sol':value==='bsc'||value==='robinhood'?value:undefined;
const sha256=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const secureFile=(path:string)=>{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)
  throw new Error('GMGN_WALLET_IMPORT_FILE_SECURITY_INVALID');};
const parseJson=(buffer:Buffer):unknown=>{try{return JSON.parse(buffer.toString('utf8'));}catch{throw new Error('GMGN_WALLET_IMPORT_JSON_INVALID');}};
const readSecureJson=(path:string)=>{secureFile(path);return parseJson(readFileSync(path));};
const inside=(root:string,file:string)=>{if(!file||file.startsWith('/')||file.includes('\0'))throw new Error('GMGN_WALLET_IMPORT_PATH_INVALID');
  const target=resolve(root,file),rel=relative(root,target);if(rel===''||rel.startsWith('..')||rel.startsWith('/'))throw new Error('GMGN_WALLET_IMPORT_PATH_INVALID');
  secureFile(target);const real=realpathSync(target),realRel=relative(realpathSync(root),real);
  if(realRel.startsWith('..')||realRel.startsWith('/'))throw new Error('GMGN_WALLET_IMPORT_PATH_INVALID');return target;};
const validAddress=(value:string,c:GmgnArchiveChain)=>{if(c!=='sol')return /^0x[0-9a-f]{40}$/i.test(value)&&!/^0x0+$/i.test(value);
  try{const bytes=bs58.decode(value);return value.length>=32&&value.length<=44&&bytes.length===32&&bytes.some(byte=>byte!==0)&&bs58.encode(bytes)===value;}catch{return false;}};
const responseData=(value:unknown)=>{if(!object(value)||(value.code!==0&&value.code!=='0')||!Object.hasOwn(value,'data'))
  throw new Error('GMGN_WALLET_IMPORT_RESPONSE_INVALID');return value.data;};
const responseAddress=(row:unknown)=>object(row)?row.wallet_address??(object(row.common)?row.common.wallet_address:undefined):undefined;

function selections(value:unknown,phase:'phase1'|'phase2'):{rows:SelectionRow[];byId:Map<string,SelectionRow>} {
  if(!object(value)||value.version!==1||!Array.isArray(value[phase]))throw new Error('GMGN_WALLET_IMPORT_SELECTION_INVALID');
  const rows:SelectionRow[]=[],byId=new Map<string,SelectionRow>();
  for(const raw of value[phase]){if(!object(raw))throw new Error('GMGN_WALLET_IMPORT_SELECTION_INVALID');
    const rawChain=typeof raw.chain==='string'?raw.chain:'',c=chain(rawChain),address=typeof raw.address==='string'?raw.address:'',id=typeof raw[phase==='phase1'?'walletId':'candidateId']==='string'?
      String(raw[phase==='phase1'?'walletId':'candidateId']):'',expected=typeof raw.addressSha256==='string'?raw.addressSha256:'';
    if(!c||!validAddress(address,c)||!/^w\d{3}$/.test(id)&&!/^c\d{3}$/.test(id)||sha256(`${rawChain}:${address}`)!==expected||byId.has(id))
      throw new Error('GMGN_WALLET_IMPORT_SELECTION_INVALID');
    const row={chain:c,address:c==='sol'?address:address.toLowerCase(),id};rows.push(row);byId.set(id,row);
  }
  return {rows,byId};
}

function requests(value:unknown,phase:'phase1'|'phase2',allowFailed=false):RequestRow[] {
  if(!object(value)||value.version!==1||!['complete','completed'].includes(String(value.status))||!Array.isArray(value.requests))
    throw new Error('GMGN_WALLET_IMPORT_MANIFEST_INCOMPLETE');
  const result:RequestRow[]=[];
  for(const raw of value.requests){if(!object(raw))throw new Error('GMGN_WALLET_IMPORT_MANIFEST_INVALID');
    if(raw.success!==true){if(allowFailed)continue;throw new Error('GMGN_WALLET_IMPORT_MANIFEST_FAILED_REQUEST');}
    const c=chain(raw.chain),kind=raw.kind,requestId=typeof raw.id==='string'?raw.id:'',rawIds=raw[phase==='phase1'?'walletIds':'candidateIds'],
      inferredId=phase==='phase2'&&kind==='stats'?new RegExp(`^(c\\d{3})-stats-${String(raw.period)}$`).exec(requestId)?.[1]:undefined,
      ids=Array.isArray(rawIds)?rawIds:inferredId?[inferredId]:rawIds;
    if(!c||!['stats','profits','activity','holdings','callout','created_tokens'].includes(String(kind))||!Array.isArray(ids)||ids.some(id=>typeof id!=='string')||
      typeof raw.file!=='string'||!Number.isSafeInteger(raw.bytes)||Number(raw.bytes)<2||typeof raw.sha256!=='string'||!/^[0-9a-f]{64}$/.test(raw.sha256))
      throw new Error('GMGN_WALLET_IMPORT_MANIFEST_INVALID');
    result.push({id:requestId,kind:kind as RequestRow['kind'],chain:c,period:typeof raw.period==='string'?raw.period:undefined,
      ids:ids as string[],file:raw.file,bytes:Number(raw.bytes),sha256:raw.sha256,success:true});
  }
  return result;
}

function verifiedResponse(root:string,request:RequestRow){const path=inside(root,request.file),buffer=readFileSync(path);
  if(buffer.length!==request.bytes||sha256(buffer)!==request.sha256)throw new Error('GMGN_WALLET_IMPORT_RESPONSE_INTEGRITY_INVALID');
  const parsed=parseJson(buffer);responseData(parsed);return parsed;}

function requestedRows(request:RequestRow,byId:Map<string,SelectionRow>){if(request.ids.length<1)throw new Error('GMGN_WALLET_IMPORT_REQUEST_IDENTITY_INVALID');
  const rows=request.ids.map(id=>byId.get(id));if(rows.some(row=>!row)||rows.some(row=>row!.chain!==request.chain))
    throw new Error('GMGN_WALLET_IMPORT_REQUEST_IDENTITY_INVALID');return rows as SelectionRow[];}

function validateResponseIdentities(input:unknown,expected:SelectionRow[],kind:'stats'|'profits'){
  const data=responseData(input),rows=kind==='profits'&&object(data)&&Array.isArray(data.list)?data.list:Array.isArray(data)?data:[data],
    wanted=new Set(expected.map(row=>row.address)),seen=new Set<string>();
  for(const row of rows){const raw=responseAddress(row),c=expected[0]?.chain,address=typeof raw==='string'&&c?(c==='sol'?raw:raw.toLowerCase()):'';
    if(!c||!validAddress(address,c)||!wanted.has(address)||seen.has(address))throw new Error('GMGN_WALLET_IMPORT_RESPONSE_IDENTITY_INVALID');seen.add(address);}
  if(seen.size!==wanted.size)throw new Error('GMGN_WALLET_IMPORT_RESPONSE_IDENTITY_INCOMPLETE');
}

function validateActivity(input:unknown,expected:SelectionRow){const data=responseData(input);
  if(!object(data)||!Array.isArray(data.activities))throw new Error('GMGN_WALLET_IMPORT_ACTIVITY_INVALID');
  for(const row of data.activities){const raw=object(row)&&typeof row.wallet==='string'?row.wallet:'',address=expected.chain==='sol'?raw:raw.toLowerCase();
    if(!object(row)||chain(row.chain)!==expected.chain||address!==expected.address)throw new Error('GMGN_WALLET_IMPORT_ACTIVITY_CHAIN_INVALID');}
}

const phase1Canonical=(request:RequestRow)=>request.kind!=='stats'||/^responses\/w\d{3}-stats-(?:7d|30d)\.json$/.test(request.file);
const phase1ActivityPage=(request:RequestRow)=>request.kind!=='activity'||/^responses\/w\d{3}-activity-p0[12]\.json$/.test(request.file);

export function importGmgnWalletArchive(options:GmgnWalletArchiveImportOptions):GmgnWalletArchiveImportSummary {
  const root=resolve(options.root),database=resolve(options.database),selectionValue=readSecureJson(inside(root,'selection.json')),
    phase1=selections(selectionValue,'phase1'),phase2=selections(selectionValue,'phase2'),
    phase1Manifest=requests(readSecureJson(inside(root,'manifest.json')),'phase1').filter(phase1Canonical).filter(phase1ActivityPage),
    phase2Manifest=requests(readSecureJson(inside(root,'phase2-manifest.json')),'phase2'),dossierPath=resolve(root,'phase2-dossiers/manifest.json'),
    dossierManifest=existsSync(dossierPath)?requests(readSecureJson(inside(root,'phase2-dossiers/manifest.json')),'phase2',true)
      .filter(request=>request.kind==='activity'||request.kind==='holdings'):[];
  const archive=new GmgnPlusArchive({path:database,maxBytes:options.maxBytes??1024*1024*1024,maxCandidates:100_000,now:options.now});
  const summary:GmgnWalletArchiveImportSummary={phase1Wallets:phase1.rows.length,phase2Wallets:phase2.rows.length,
    uniqueWallets:new Set([...phase1.rows,...phase2.rows].map(row=>`${row.chain}:${row.address}`)).size,requests:0,
    statsRows:0,profitRows:0,activityRows:0,holdingPages:0,holdingRows:0};
  try{for(const [phase,manifest] of [[phase1,phase1Manifest],[phase2,phase2Manifest],[phase2,dossierManifest]] as const){for(const request of manifest){
      const expected=requestedRows(request,phase.byId),input=verifiedResponse(root,request);summary.requests++;
      if(request.kind==='stats'){
        if(request.period!=='7d'&&request.period!=='30d')throw new Error('GMGN_WALLET_IMPORT_PERIOD_INVALID');validateResponseIdentities(input,expected,'stats');
        const result=archive.recordWalletStats(request.chain,expected.map(row=>row.address),input,request.period);
        if(result.capacityReached||result.accepted!==expected.length)throw new Error('GMGN_WALLET_IMPORT_WRITE_FAILED');summary.statsRows+=result.accepted;
      }else if(request.kind==='profits'){
        if(!request.period||!['1d','7d','30d','all'].includes(request.period))throw new Error('GMGN_WALLET_IMPORT_PERIOD_INVALID');validateResponseIdentities(input,expected,'profits');
        const result=archive.recordWalletProfits(request.chain,expected.map(row=>row.address),input,request.period as '1d'|'7d'|'30d'|'all');
        if(result.capacityReached||result.accepted!==expected.length)throw new Error('GMGN_WALLET_IMPORT_WRITE_FAILED');summary.profitRows+=result.accepted;
      }else if(request.kind==='activity'){
        if(expected.length!==1)throw new Error('GMGN_WALLET_IMPORT_REQUEST_IDENTITY_INVALID');validateActivity(input,expected[0]);
        const result=archive.recordWalletActivity(request.chain,expected[0].address,input);
        if(result.capacityReached)throw new Error('GMGN_WALLET_IMPORT_WRITE_FAILED');summary.activityRows+=result.accepted;
      }else if(request.kind==='holdings'){
        if(expected.length!==1)throw new Error('GMGN_WALLET_IMPORT_REQUEST_IDENTITY_INVALID');
        const match=/^(?:responses\/w\d{3}|phase2-dossiers\/c\d{3})-holdings-(current|closed)-p(\d{2})\.json$/.exec(request.file);
        if(!match)throw new Error('GMGN_WALLET_IMPORT_HOLDINGS_FILE_INVALID');const page=Number(match[2]),data=responseData(input);
        if(!object(data)||!Array.isArray(data.list))throw new Error('GMGN_WALLET_IMPORT_HOLDINGS_RESPONSE_INVALID');
        const result=archive.recordWalletHoldingsPage(request.chain,expected[0].address,match[1] as 'current'|'closed',page,input);
        if(result.capacityReached||result.accepted!==1||result.rows===undefined)throw new Error('GMGN_WALLET_IMPORT_WRITE_FAILED');
        summary.holdingPages++;summary.holdingRows+=result.rows;
      }else throw new Error('GMGN_WALLET_IMPORT_KIND_INVALID');
    }}
    archive.setMeta('wallet_archive_import_version','1');archive.setMeta('wallet_archive_import_completed_at',(options.now?.()??new Date()).toISOString());
    return summary;
  }finally{archive.close();}
}

function argument(name:string,fallback:string){const prefix=`--${name}=`;return process.argv.find(value=>value.startsWith(prefix))?.slice(prefix.length)||fallback;}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const summary=importGmgnWalletArchive({root:argument('root','data/gmgn-plus-archive/wallets/20261030T123117Z'),
    database:argument('database','data/gmgn-plus-archive.sqlite')});
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
