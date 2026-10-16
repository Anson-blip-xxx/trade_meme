import {constants} from 'node:fs';
import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import {abortable,scopedFetcher,type Fetcher} from '../http.js';

const ORIGIN='https://yiyulu.com',FEED='/v2api/signals/v2/public/multi_chain/list';
const WALLETS='/botapi/user/getWalletsAllChain',USER='/botapi/user/getUserInfoByGuid',REFRESH='/botapi/user/refreshNewToken';
const MAX_FILE=64*1024,MAX_RESPONSE=2*1024*1024;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const secret=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=16384&&!/[\x00-\x20\x7f-\uffff]/.test(value);
const email=(value:unknown):value is string=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const sameEmail=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export interface AveSessionFile {
  version:1;email:string;savedAt:string;accessToken?:string;refreshToken?:string;xAuth?:string;
}
export interface AveSessionStatus {
  status:'authenticated'|'required'|'unavailable';authenticated:boolean;email:string;
  expiresAt?:string;verifiedAt?:string;reason?:string;cooldownUntil?:string;
}
export interface AveSessionOptions {path:string;email:string;fetcher?:Fetcher;now?:()=>Date;}
export class AveSessionError extends Error {
  constructor(readonly reason:string,readonly retryAfterSec?:number){super(reason);this.name='AveSessionError';}
}
const failure=(reason:string)=>new AveSessionError(`AVE_SESSION_${reason}`);
type Loaded={data:AveSessionFile;fingerprint:string};
type FeedChain='bsc'|'solana'|'robinhood';
function walletAddress(value:unknown,chain:FeedChain):string|undefined {
  if(typeof value!=='string')return;
  if(chain!=='solana')return /^0x[0-9a-f]{40}$/i.test(value)&&!/^0x0{40}$/i.test(value)?value.toLowerCase():undefined;
  try {const bytes=bs58.decode(value);return value.length<=44&&bytes.length===32&&bytes.some(byte=>byte!==0)?value:undefined;}catch{return;}
}

function parseFile(value:unknown):AveSessionFile {
  if(!object(value)||value.version!==1||!email(value.email)||typeof value.savedAt!=='string'||
    !/^\d{4}-\d\d-\d\dT/.test(value.savedAt)||!Number.isFinite(Date.parse(value.savedAt))||
    Object.keys(value).some(key=>!['version','email','savedAt','accessToken','refreshToken','xAuth'].includes(key))||
    ['accessToken','refreshToken','xAuth'].some(key=>value[key]!==undefined&&!secret(value[key]))||
    !value.accessToken&&!value.refreshToken&&!value.xAuth)throw failure('FILE_INVALID');
  return {version:1,email:value.email,savedAt:value.savedAt,
    ...(value.accessToken?{accessToken:value.accessToken as string}:{}),
    ...(value.refreshToken?{refreshToken:value.refreshToken as string}:{}),...(value.xAuth?{xAuth:value.xAuth as string}:{})};
}
async function checkDirectory(path:string,create=false):Promise<void> {
  if(create)await mkdir(dirname(path),{recursive:true,mode:0o700});
  const stat=await lstat(dirname(path));
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||
    process.getuid&&stat.uid!==process.getuid())throw failure('DIRECTORY_PERMISSIONS');
}
async function loadFile(path:string):Promise<Loaded> {
  let file;
  try {
    await checkDirectory(path);
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const before=await file.stat();
    if(!before.isFile())throw failure('FILE_INVALID');
    if((before.mode&0o777)!==0o600||process.getuid&&before.uid!==process.getuid())throw failure('FILE_PERMISSIONS');
    if(before.size>MAX_FILE)throw failure('FILE_TOO_LARGE');
    const buffer=Buffer.alloc(MAX_FILE+1);let length=0;
    while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
    if(length>MAX_FILE)throw failure('FILE_TOO_LARGE');
    const after=await file.stat();
    if(before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.size!==after.size)throw failure('FILE_CHANGED');
    const bytes=buffer.subarray(0,length);let raw:unknown;
    try{raw=JSON.parse(bytes.toString('utf8'));}catch{throw failure('FILE_INVALID');}
    return {data:parseFile(raw),fingerprint:createHash('sha256').update(bytes).digest('hex')};
  }catch(error){
    if(error instanceof AveSessionError)throw error;
    if(object(error)&&error.code==='ENOENT')throw failure('FILE_MISSING');
    throw failure('FILE_UNREADABLE');
  }finally{await file?.close().catch(()=>{});}
}

/** Persist only the narrowly typed session fields; saving a token is never authentication proof. */
export async function saveAveSession(path:string,value:AveSessionFile,expectedFingerprint?:string):Promise<void> {
  const data=parseFile(value);let temporary:string|undefined,file;
  try {
    await checkDirectory(path,true);
    try {const old=await lstat(path);if(old.isSymbolicLink()||!old.isFile())throw failure('FILE_INVALID');}
    catch(error){if(!(object(error)&&error.code==='ENOENT'))throw error;}
    temporary=`${path}.${randomUUID()}.tmp`;
    file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await file.writeFile(JSON.stringify(data));await file.sync();await file.close();file=undefined;
    if(expectedFingerprint&&(await loadFile(path)).fingerprint!==expectedFingerprint)throw failure('FILE_CHANGED');
    await checkDirectory(path);await rename(temporary,path);temporary=undefined;
  }catch(error){if(error instanceof AveSessionError)throw error;throw failure('FILE_WRITE_FAILED');}
  finally {await file?.close().catch(()=>{});if(temporary)await unlink(temporary).catch(()=>{});}
}

/** JWT timestamps schedule renewal only. No signature or account identity is inferred from this payload. */
function jwtTime(token:string|undefined):{expires?:number;issued?:number} {
  if(!token)return {};
  try {
    const part=token.split('.')[1];if(!part||part.length>16384||!/^[A-Za-z0-9_-]+$/.test(part))return {};
    const raw=JSON.parse(Buffer.from(part,'base64url').toString('utf8'));
    const at=(value:unknown)=>{const n=typeof value==='number'?value:NaN,ms=n>1e12?n:n*1000;return Number.isFinite(ms)&&ms>0&&ms<=8.64e15?ms:undefined;};
    return object(raw)?{expires:at(raw.exp),issued:at(raw.iat)}:{};
  }catch{return {};}
}
function envelope(value:unknown):unknown {
  if(!object(value))throw failure('RESPONSE_INVALID');
  if((value.status===1||value.status===0&&value.msg==='Success')&&Object.hasOwn(value,'data')) {
    if(value.data_type===1&&typeof value.data==='string') {
      try{return JSON.parse(value.data);}catch{throw failure('RESPONSE_INVALID');}
    }
    return value.data;
  }
  if(value.status===undefined)return value;
  throw failure('RESPONSE_INVALID');
}

export class AveSessionClient {
  private readonly request:Fetcher;private readonly now:()=>Date;
  private verified?:{fingerprint:string;until:number;at:string;expires?:number;wallets:Partial<Record<FeedChain,string>>};
  private status:AveSessionStatus;private invalidFingerprint?:string;private authWork?:Promise<Loaded>;
  private lastRefreshRef=0;private requestCooldownUntil=0;
  readonly fetcher:Fetcher;
  constructor(private readonly options:AveSessionOptions) {
    if(!email(options.email))throw failure('EMAIL_INVALID');
    this.request=options.fetcher??fetch;this.now=options.now??(()=>new Date());
    this.status={status:'required',authenticated:false,email:options.email,reason:'AVE_SESSION_NOT_VERIFIED'};
    this.fetcher=async(input,init)=>{
      const url=this.allowed(input,init),external=init?.signal??(input instanceof Request?input.signal:undefined);
      try{return await this.budget(external??undefined,async scope=>{
        const initial=await this.load();
        const file=initial.data.accessToken||initial.data.refreshToken?await this.ensure(scope):initial;
        if(!file.data.accessToken){this.mark('required','AVE_SESSION_PUBLIC_ONLY');}
        if((await this.load()).fingerprint!==file.fingerprint)throw failure('FILE_CHANGED');
        try {
          // The official public signal route uses X-Auth and the selected account's chain address;
          // access-token Bearer headers are reserved for the authenticated botapi identity routes.
          if(file.data.accessToken) {
            const firstChain=url.searchParams.get('chain')!.split(',')[0] as FeedChain;
            const address=this.verified?.fingerprint===file.fingerprint?this.verified.wallets[firstChain]:undefined;
            if(!address)throw failure('WALLET_UNAVAILABLE');
            url.searchParams.set('wallet_address',address);
          }
          const result=await this.read(url,file.data,'public',scope);
          return new Response(result.text,{status:200,headers:{'content-type':'application/json'}});
        }catch(error){if(error instanceof AveSessionError&&error.reason==='AVE_SESSION_AUTH_REQUIRED')this.invalidFingerprint=file.fingerprint;throw error;}
      });}catch(error){
        // Preserve the provider's bounded cooldown across the injected Fetcher interface.
        if(error instanceof AveSessionError&&error.reason==='AVE_SESSION_RATE_LIMITED')
          return new Response(null,{status:429,headers:{'retry-after':String(error.retryAfterSec??60)}});
        throw error;
      }
    };
  }
  getStatus():AveSessionStatus {
    if(this.verified&&this.verified.until<=this.now().getTime())this.mark('required','AVE_SESSION_VERIFICATION_EXPIRED');
    return {...this.status,...(this.requestCooldownUntil>this.now().getTime()?{cooldownUntil:new Date(this.requestCooldownUntil).toISOString()}:{})};
  }
  async saveSession(value:AveSessionFile):Promise<void> {
    if(!sameEmail(value.email,this.options.email))throw failure('EMAIL_MISMATCH');
    await saveAveSession(this.options.path,value);this.verified=undefined;this.invalidFingerprint=undefined;
    this.mark('required','AVE_SESSION_NOT_VERIFIED');
  }
  async verify(signal?:AbortSignal):Promise<AveSessionStatus> {
    try {await this.budget(signal,scope=>this.ensure(scope));}catch{/* Only fixed diagnostic status is returned. */}
    return this.getStatus();
  }
  private mark(status:AveSessionStatus['status'],reason:string):void {
    this.verified=undefined;this.status={status,authenticated:false,email:this.options.email,reason};
  }
  private async load():Promise<Loaded> {
    const file=await loadFile(this.options.path);
    if(!sameEmail(file.data.email,this.options.email))throw failure('EMAIL_MISMATCH');
    return file;
  }
  private allowed(input:Parameters<Fetcher>[0],init?:RequestInit):URL {
    try {
      const url=new URL(input instanceof Request?input.url:String(input)),method=init?.method??(input instanceof Request?input.method:'GET');
      if(url.origin!==ORIGIN||url.username||url.password||url.hash||url.pathname!==FEED||method.toUpperCase()!=='GET'||
        init?.body!=null||input instanceof Request&&input.body!==null||init?.redirect!==undefined&&init.redirect!=='error')throw failure('REQUEST_REJECTED');
      if([...url.searchParams.keys()].some(key=>!['chain','pageSize'].includes(key))||
        url.searchParams.getAll('chain').length!==1||url.searchParams.getAll('pageSize').length!==1||
        !/^(?:[1-9]|[1-9]\d|100)$/.test(url.searchParams.get('pageSize')??'')||
        !/^(?:bsc|solana|robinhood)(?:,(?:bsc|solana|robinhood)){0,2}$/.test(url.searchParams.get('chain')??''))throw failure('REQUEST_REJECTED');
      return url;
    }catch{throw failure('REQUEST_REJECTED');}
  }
  private async budget<T>(external:AbortSignal|undefined,work:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    const scope=external?AbortSignal.any([external,controller.signal]):controller.signal;
    try {scope.throwIfAborted();return await abortable(work(scope),scope);}
    catch(error){
      const known=error instanceof AveSessionError?error:failure(scope.aborted?'REQUEST_TIMEOUT':'REQUEST_FAILED');
      const required=/_(AUTH_REQUIRED|PUBLIC_ONLY|EMAIL_MISMATCH|FILE_MISSING|REFRESH_FAILED|REFRESH_EXPIRED)$/.test(known.reason);
      this.mark(required?'required':'unavailable',known.reason);throw known;
    }finally{clearTimeout(timer);}
  }
  private async read(url:URL,data:AveSessionFile,auth:'access'|'refresh'|'public',signal:AbortSignal):Promise<{value:unknown;text:string}> {
    if(this.requestCooldownUntil>this.now().getTime())
      throw new AveSessionError('AVE_SESSION_RATE_LIMITED',Math.ceil((this.requestCooldownUntil-this.now().getTime())/1000));
    const headers:Record<string,string>={accept:'application/json','Ave-Platform':'web',lang:'en','lang-zone':'en'};
    if(data.xAuth)headers['X-Auth']=data.xAuth;
    if(auth!=='public') {
      const token=auth==='access'?data.accessToken:data.refreshToken;if(!token)throw failure('AUTH_REQUIRED');
      headers.authorization=`Bearer ${token}`;
    }
    const response=await scopedFetcher(this.request,signal)(url,{method:'GET',credentials:'omit',redirect:'error',signal,headers});
    if(response.redirected||response.status>=300&&response.status<400||response.url&&new URL(response.url).href!==url.href) {
      void response.body?.cancel().catch(()=>{});throw failure('REDIRECT_REJECTED');
    }
    if(response.status===401) {void response.body?.cancel().catch(()=>{});this.verified=undefined;throw failure('AUTH_REQUIRED');}
    if(response.status===403){void response.body?.cancel().catch(()=>{});throw failure('X_AUTH_REQUIRED');}
    if(response.status===429){
      void response.body?.cancel().catch(()=>{});
      const value=response.headers.get('retry-after'),seconds=value!==null&&/^\d+$/.test(value)?Number(value):NaN;
      const delay=Number.isFinite(seconds)?seconds*1000:value?Date.parse(value)-this.now().getTime():60000;
      const retryAfterSec=Math.ceil(Math.min(3600000,Math.max(60000,Number.isFinite(delay)?delay:60000))/1000);
      this.requestCooldownUntil=this.now().getTime()+retryAfterSec*1000;
      throw new AveSessionError('AVE_SESSION_RATE_LIMITED',retryAfterSec);
    }
    if(!response.ok){void response.body?.cancel().catch(()=>{});throw failure('HTTP_ERROR');}
    const length=response.headers.get('content-length');
    if(length&&/^\d+$/.test(length)&&Number(length)>MAX_RESPONSE){void response.body?.cancel().catch(()=>{});throw failure('RESPONSE_TOO_LARGE');}
    const reader=response.body?.getReader();if(!reader)throw failure('RESPONSE_INVALID');
    const chunks:Uint8Array[]=[];let size=0,finished=false;
    try {
      for(;;){const chunk=await abortable(reader.read(),signal);if(chunk.done){finished=true;break;}
        size+=chunk.value.byteLength;if(size>MAX_RESPONSE||chunks.length>=65536)throw failure('RESPONSE_TOO_LARGE');chunks.push(chunk.value);}
    }finally{if(!finished)void reader.cancel().catch(()=>{});reader.releaseLock();}
    const text=Buffer.concat(chunks,size).toString('utf8');let value:unknown;
    try{value=JSON.parse(text);}catch{throw failure('RESPONSE_INVALID');}
    if(object(value)&&[10000,10001].includes(Number(value.status)))throw failure('X_AUTH_REQUIRED');
    return {value,text};
  }
  private async ensure(signal:AbortSignal):Promise<Loaded> {
    if(this.authWork)return abortable(this.authWork,signal);
    this.authWork=this.verifyFile(signal).finally(()=>{this.authWork=undefined;});return this.authWork;
  }
  private async renew(file:Loaded,type:'acc'|'ref',signal:AbortSignal):Promise<Loaded> {
    const refresh=file.data.refreshToken;if(!refresh)throw failure('AUTH_REQUIRED');
    const expires=jwtTime(refresh).expires;if(expires!==undefined&&expires<=this.now().getTime())throw failure('REFRESH_EXPIRED');
    try {
      const url=new URL(REFRESH,ORIGIN);url.searchParams.set('type',type);
      const result=envelope((await this.read(url,file.data,'refresh',signal)).value);
      if(!object(result)||(type==='acc'?!secret(result.accessToken):!secret(result.refreshToken))||
        result.accessToken!==undefined&&!secret(result.accessToken)||result.refreshToken!==undefined&&!secret(result.refreshToken))throw failure('REFRESH_FAILED');
      const updated:AveSessionFile={...file.data,savedAt:this.now().toISOString(),
        ...(result.accessToken?{accessToken:result.accessToken as string}:{}),...(result.refreshToken?{refreshToken:result.refreshToken as string}:{})};
      signal.throwIfAborted();await saveAveSession(this.options.path,updated,file.fingerprint);
      if(type==='ref')this.lastRefreshRef=this.now().getTime();
      return this.load();
    }catch(error){
      this.invalidFingerprint=file.fingerprint;
      if(error instanceof AveSessionError&&['AVE_SESSION_FILE_CHANGED','AVE_SESSION_AUTH_REQUIRED','AVE_SESSION_RATE_LIMITED'].includes(error.reason))throw error;
      throw failure('REFRESH_FAILED');
    }
  }
  private async verifyFile(signal:AbortSignal):Promise<Loaded> {
    let file=await this.load();const now=this.now().getTime();
    if(this.verified?.fingerprint===file.fingerprint&&this.verified.until>now)return file;
    this.verified=undefined;
    const refresh=jwtTime(file.data.refreshToken);
    if(refresh.expires!==undefined&&refresh.expires>now&&refresh.expires-now<=86400000&&now-this.lastRefreshRef>=600000)
      file=await this.renew(file,'ref',signal);
    const access=jwtTime(file.data.accessToken);
    const threshold=Math.min(120000,access.issued&&access.expires?Math.max(0,(access.expires-access.issued)/2):120000);
    const renewAccess=!file.data.accessToken||this.invalidFingerprint===file.fingerprint||access.expires!==undefined&&access.expires-now<=threshold;
    if(renewAccess) {
      if(!file.data.refreshToken)throw failure('AUTH_REQUIRED');
      try{file=await this.renew(file,'acc',signal);}catch(error){
        if(!(error instanceof AveSessionError)||error.reason!=='AVE_SESSION_AUTH_REQUIRED')throw error;
        file=await this.renew(file,'ref',signal);file=await this.renew(file,'acc',signal);
      }
    }
    if(!file.data.accessToken)throw failure('PUBLIC_ONLY');
    try {
      const walletsUrl=new URL(WALLETS,ORIGIN);walletsUrl.searchParams.set('chain','bsc,solana,robinhood');
      const wallets=envelope((await this.read(walletsUrl,file.data,'access',signal)).value);
      if(!Array.isArray(wallets)||!wallets.length||wallets.length>100)throw failure('AUTH_REQUIRED');
      const ids=[...new Set(wallets.map(row=>object(row)?row.tgUid:undefined).filter(id=>
        typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id)||typeof id==='number'&&Number.isSafeInteger(id)&&id>0).map(String))];
      if(!ids.length)throw failure('AUTH_REQUIRED');
      const url=new URL(USER,ORIGIN);url.searchParams.set('guid',ids[0]);
      const account=envelope((await this.read(url,file.data,'access',signal)).value);
      if(!object(account)||!email(account.emailAddress))throw failure('AUTH_REQUIRED');
      if(!sameEmail(account.emailAddress,this.options.email))throw failure('EMAIL_MISMATCH');
      if(account.tgUid!==undefined&&String(account.tgUid)!==ids[0])throw failure('AUTH_REQUIRED');
      // Retain only addresses owned by the exact identity just verified, never another row's guid.
      const bound=wallets.filter(row=>object(row)&&String(row.tgUid)===ids[0]);
      const selected=bound.find(row=>!row.risk)??bound[0],addresses:Partial<Record<FeedChain,string>>={};
      if(selected)for(const chain of ['bsc','solana','robinhood'] as const) {
        const raw=Array.isArray(selected.addresses)?selected.addresses.find((item:unknown)=>object(item)&&item.chain===chain)?.address:selected.evmAddress;
        const address=walletAddress(raw,chain);if(address)addresses[chain]=address;
      }
      if((await this.load()).fingerprint!==file.fingerprint)throw failure('FILE_CHANGED');
      const verifiedAt=this.now().toISOString(),expires=jwtTime(file.data.accessToken).expires;
      const until=Math.min(this.now().getTime()+60000,expires??Infinity);
      if(until<=this.now().getTime())throw failure('AUTH_REQUIRED');
      this.verified={fingerprint:file.fingerprint,until,at:verifiedAt,expires,wallets:addresses};this.invalidFingerprint=undefined;
      this.status={status:'authenticated',authenticated:true,email:this.options.email,verifiedAt,
        ...(expires?{expiresAt:new Date(expires).toISOString()}:{})};return file;
    }catch(error){if(error instanceof AveSessionError&&error.reason==='AVE_SESSION_AUTH_REQUIRED')this.invalidFingerprint=file.fingerprint;throw error;}
  }
}
