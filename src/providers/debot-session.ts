import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import type {Fetcher} from '../http.js';

const ORIGIN='https://debot.ai';
const INFO='/api/user/info';
const PATHS=new Set([INFO,'/api/community/signal/channel/list',
  '/api/community/signal/channel/wallets/profit','/api/community/signal/channel/token/alerts']);
const MAX_FILE=64*1024,MAX_RESPONSE=1024*1024;
type Cookie={name:string;value:string;domain:string;path:string;expires:number;httpOnly:boolean;secure:boolean;sameSite:string};
type SessionFile={version:1;createdAt:string;email:string;cookies:Cookie[];subToken:string};
type Verified={fingerprint:string;until:number;subToken:string};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const secretString=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=8192&&!/[\u0000-\u0020\u007f]/.test(v);

export class DebotSessionError extends Error {
  constructor(readonly reason:string,readonly cooldownUntil?:number) {super(reason);this.name='DebotSessionError';}
}
const failure=(reason:string)=>new DebotSessionError(`DEBOT_SESSION_${reason}`);

function parseFile(value:unknown):SessionFile {
  if(!object(value)||value.version!==1||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||
    typeof value.email!=='string'||value.email.length>320||!value.email.includes('@')||
    !secretString(value.subToken)||!Array.isArray(value.cookies)||value.cookies.length>200)throw failure('FILE_INVALID');
  for(const c of value.cookies) {
    if(!object(c)||typeof c.name!=='string'||!c.name||c.name.length>256||!/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(c.name)||
      typeof c.value!=='string'||c.value.length>8192||!/^[\x21-\x7e]*$/.test(c.value)||/[";,\\]/.test(c.value)||
      typeof c.domain!=='string'||!/^\.?[A-Za-z0-9.-]{1,253}$/.test(c.domain)||
      typeof c.path!=='string'||!c.path.startsWith('/')||c.path.length>2048||/[\u0000-\u0020\u007f]/.test(c.path)||
      typeof c.expires!=='number'||!Number.isFinite(c.expires)||typeof c.httpOnly!=='boolean'||
      typeof c.secure!=='boolean'||!['Strict','Lax','None'].includes(String(c.sameSite)))throw failure('FILE_INVALID');
  }
  return value as unknown as SessionFile;
}

function cookiesFor(cookies:Cookie[],url:URL,now:number):string {
  return cookies.filter(c=>{
    const domain=c.domain.toLowerCase();
    if(domain!==url.hostname&&domain!==`.${url.hostname}`)return false;
    if(c.expires!==-1&&c.expires*1000<=now)return false;
    return url.pathname===c.path||url.pathname.startsWith(c.path.endsWith('/')?c.path:`${c.path}/`);
  }).sort((a,b)=>b.path.length-a.path.length).map(c=>`${c.name}=${c.value}`).join('; ');
}

export class DebotSessionClient {
  private readonly request:Fetcher;
  private readonly now:()=>Date;
  private verified?:Verified;
  private authRequired=false;
  readonly fetcher:Fetcher;
  constructor(private readonly options:{path:string;fetcher?:Fetcher;now?:()=>Date;
    onAuthRequired?:(reason:string)=>unknown|Promise<unknown>}) {
    this.request=options.fetcher??fetch;this.now=options.now??(()=>new Date());
    this.fetcher=async(input,init)=>{
      const url=this.allowed(input,init);
      await this.getSession();
      const file=await this.load();
      // A replaced session must be verified before any request uses its cookies.
      if(this.verified?.fingerprint!==file.fingerprint)await this.getSession();
      const current=await this.load();
      if(this.verified?.fingerprint!==current.fingerprint)throw failure('FILE_CHANGED');
      const cookieHeader=cookiesFor(current.data.cookies,url,this.now().getTime());
      if(!cookieHeader){const error=failure('AUTH_REQUIRED');this.notifyAuthRequired(error);throw error;}
      const signal=init?.signal??(input instanceof Request?input.signal:undefined);
      const result=await this.read(url,cookieHeader,signal??undefined);
      if(!object(result.value)||typeof result.value.code!=='number')throw failure('RESPONSE_INVALID');
      return new Response(result.text,{status:result.status,headers:{'content-type':'application/json'}});
    };
  }

  private notifyAuthRequired(error:DebotSessionError):void {
    this.verified=undefined;
    if(this.authRequired)return;
    this.authRequired=true;
    // A consumer may stop the stream and wait for this very request. Never await that callback here.
    try {void Promise.resolve(this.options.onAuthRequired?.(error.reason)).catch(()=>{});}catch {/* Diagnostics cannot block invalidation. */}
  }

  private allowed(input:Parameters<Fetcher>[0],init?:RequestInit):URL {
    try {
      const url=new URL(input instanceof Request?input.url:String(input));
      const method=init?.method??(input instanceof Request?input.method:'GET');
      if(url.origin!==ORIGIN||url.username||url.password||url.hash||!PATHS.has(url.pathname)||
        method.toUpperCase()!=='GET'||init?.body!=null||(input instanceof Request&&input.body!==null)||
        (init?.redirect!==undefined&&init.redirect!=='error'))throw failure('REQUEST_REJECTED');
      return url;
    } catch {throw failure('REQUEST_REJECTED');}
  }

  private async load():Promise<{data:SessionFile;fingerprint:string}> {
    let handle;
    try {
      handle=await open(this.options.path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=await handle.stat();
      if(!stat.isFile())throw failure('FILE_INVALID');
      if(![0o600,0o400].includes(stat.mode&0o777))throw failure('FILE_PERMISSIONS');
      if(stat.size>MAX_FILE)throw failure('FILE_TOO_LARGE');
      const buffer=Buffer.alloc(MAX_FILE+1);
      let length=0;
      while(length<buffer.length) {
        const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);
        if(!bytesRead)break;
        length+=bytesRead;
      }
      if(length>MAX_FILE)throw failure('FILE_TOO_LARGE');
      const after=await handle.stat();
      if(stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs||stat.size!==after.size)throw failure('FILE_CHANGED');
      let data:unknown;try {data=JSON.parse(buffer.subarray(0,length).toString('utf8'));}catch {throw failure('FILE_INVALID');}
      return {data:parseFile(data),fingerprint:[stat.dev,stat.ino,stat.mtimeMs,stat.ctimeMs,stat.size].join(':')};
    } catch(error) {
      this.verified=undefined;
      if(error instanceof DebotSessionError)throw error;
      if(object(error)&&error.code==='ENOENT')throw failure('FILE_MISSING');
      throw failure('FILE_UNREADABLE');
    } finally {await handle?.close().catch(()=>{});}
  }

  private async read(url:URL,cookieHeader:string,externalSignal?:AbortSignal):Promise<{value:unknown;text:string;status:number}> {
    const signal=externalSignal?AbortSignal.any([externalSignal,AbortSignal.timeout(10_000)]):AbortSignal.timeout(10_000);
    try {
      const response=await this.request(url,{method:'GET',credentials:'omit',redirect:'error',signal,
        headers:{accept:'application/json',cookie:cookieHeader,referer:`${ORIGIN}/`}});
      if(response.redirected||(response.status>=300&&response.status<400)||
        (response.url&&new URL(response.url).href!==url.href)) {
        await response.body?.cancel().catch(()=>{});throw failure('REDIRECT_REJECTED');
      }
      if(!response.ok) {
        let retryUntil:number|undefined;
        if(response.status===429) {
          const now=this.now().getTime(),raw=response.headers.get('retry-after');
          const seconds=raw!==null&&/^\d+$/.test(raw)?Number(raw):NaN;
          const delay=Number.isFinite(seconds)?seconds*1000:raw?Date.parse(raw)-now:60_000;
          retryUntil=now+Math.min(3_600_000,Math.max(60_000,Number.isFinite(delay)?delay:60_000));
        }
        await response.body?.cancel().catch(()=>{});
        throw new DebotSessionError(`DEBOT_SESSION_${[401,403].includes(response.status)?'AUTH_REQUIRED':
          response.status===429?'RATE_LIMITED':'HTTP_ERROR'}`,retryUntil);
      }
      const declared=response.headers.get('content-length');
      if(declared&&/^\d+$/.test(declared)&&Number(declared)>MAX_RESPONSE) {
        await response.body?.cancel().catch(()=>{});throw failure('RESPONSE_TOO_LARGE');
      }
      if(!response.body)throw failure('RESPONSE_INVALID');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];
      let size=0;
      try {
        for(;;) {
          const chunk=await reader.read();if(chunk.done)break;
          size+=chunk.value.byteLength;
          if(size>MAX_RESPONSE){await reader.cancel().catch(()=>{});throw failure('RESPONSE_TOO_LARGE');}
          chunks.push(chunk.value);
        }
      } finally {reader.releaseLock();}
      const text=Buffer.concat(chunks,size).toString('utf8');
      let value:unknown;try {value=JSON.parse(text);}catch {throw failure('RESPONSE_INVALID');}
      if(object(value)&&(value.code===101||value.code===401||value.code===403))throw failure('AUTH_REQUIRED');
      if(object(value)&&value.code===429)throw new DebotSessionError('DEBOT_SESSION_RATE_LIMITED',this.now().getTime()+60_000);
      return {value,text,status:response.status};
    } catch(error) {
      this.verified=undefined;
      if(error instanceof DebotSessionError) {
        if(error.reason==='DEBOT_SESSION_AUTH_REQUIRED')this.notifyAuthRequired(error);
        throw error;
      }
      if(signal.aborted||(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name)))throw failure('REQUEST_TIMEOUT');
      throw failure('REQUEST_FAILED');
    }
  }

  async getSession():Promise<{subToken:string;cookieHeader:string}> {
    const file=await this.load(),now=this.now().getTime();
    const url=new URL(INFO,ORIGIN),cookieHeader=cookiesFor(file.data.cookies,url,now);
    if(!cookieHeader){const error=failure('AUTH_REQUIRED');this.notifyAuthRequired(error);throw error;}
    const socketCookies=cookiesFor(file.data.cookies,new URL('/portal-ws/',ORIGIN),now);
    if(this.verified?.fingerprint===file.fingerprint&&this.verified.until>now) {
      return {subToken:this.verified.subToken,cookieHeader:socketCookies};
    }
    this.verified=undefined;
    const {value}=await this.read(url,cookieHeader);
    if(!object(value)||value.code!==0||!object(value.data))throw failure('RESPONSE_INVALID');
    // The web client treats a successful /user/info response without inviteCode as anonymous.
    if(!secretString(value.data.inviteCode)||!secretString(value.data.sub_token)) {
      const error=failure('AUTH_REQUIRED');this.notifyAuthRequired(error);throw error;
    }
    if((await this.load()).fingerprint!==file.fingerprint)throw failure('FILE_CHANGED');
    // Cache no longer than the first applicable persistent cookie's expiry.
    const expiries=file.data.cookies.filter(c=>c.expires!==-1&&cookiesFor([c],url,now)).map(c=>c.expires*1000);
    this.verified={fingerprint:file.fingerprint,until:Math.min(now+60_000,...expiries),subToken:value.data.sub_token};
    this.authRequired=false;
    return {subToken:value.data.sub_token,cookieHeader:socketCookies};
  }
}
