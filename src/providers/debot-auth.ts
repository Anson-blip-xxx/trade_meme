import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import type {Fetcher} from '../http.js';

const ORIGIN='https://debot.ai',MAX_RESPONSE=256*1024,MAX_SESSION=64*1024,CHALLENGE_MS=300_000;
type Cookie={name:string;value:string;domain:string;path:string;expires:number;httpOnly:boolean;secure:boolean;sameSite:'Strict'|'Lax'|'None'};
type Challenge={id:string;expires:number;attempts:number;cookies:Cookie[]};
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const secret=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=8192&&!/[\u0000-\u0020\u007f]/.test(value);
// DeBot's web client accepts a truthy inviteCode and also uses it as a numeric account ID.
const inviteCode=(value:unknown):boolean=>secret(value)||typeof value==='number'&&Number.isSafeInteger(value)&&value>0;

export class DebotAuthError extends Error {
  constructor(readonly reason:string,readonly statusCode:number) {super(reason);this.name='DebotAuthError';}
}
const error=(code:string,statusCode=400)=>new DebotAuthError(`DEBOT_AUTH_${code}`,statusCode);
export interface DebotAuthOptions {
  email:string;sessionPath:string;fetcher?:Fetcher;now?:()=>Date;
  onAuthenticated?:()=>unknown|Promise<unknown>;
}
export interface DebotAuthStatus {
  enabled:boolean;email:string;state:'authenticated'|'required'|'unavailable';requiresTotp:true;
  challengeId?:string;challengeExpiresAt?:string;canSendAt?:string;lastError?:string;
}

function cookieHeader(cookies:Cookie[],url:URL,now:number):string {
  return cookies.filter(cookie=>(cookie.domain==='debot.ai'||cookie.domain==='.debot.ai')&&
    (cookie.expires===-1||cookie.expires*1000>now)&&
    (url.pathname===cookie.path||url.pathname.startsWith(cookie.path.endsWith('/')?cookie.path:`${cookie.path}/`)))
    .sort((a,b)=>b.path.length-a.path.length).map(cookie=>`${cookie.name}=${cookie.value}`).join('; ');
}
function updateCookies(cookies:Cookie[],headers:Headers,url:URL,now:number):void {
  const values=headers.getSetCookie();
  if(values.length>200||values.reduce((n,value)=>n+value.length,0)>MAX_SESSION)throw error('COOKIE_INVALID',502);
  for(const raw of values) {
    if(raw.length>12_000||/[\u0000-\u001f\u007f]/.test(raw))throw error('COOKIE_INVALID',502);
    const [pair,...attributes]=raw.split(';'),equals=pair.indexOf('=');
    if(equals<1)throw error('COOKIE_INVALID',502);
    const name=pair.slice(0,equals).trim();let value=pair.slice(equals+1).trim();
    if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1);
    if(name.length>256||!/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(name)||value.length>8192||
      !/^[\x21-\x7e]*$/.test(value)||/[";,\\]/.test(value))throw error('COOKIE_INVALID',502);
    const lastSlash=url.pathname.lastIndexOf('/');
    const cookie:Cookie={name,value,domain:'debot.ai',path:lastSlash>0?url.pathname.slice(0,lastSlash):'/',
      expires:-1,httpOnly:false,secure:false,sameSite:'Lax'};
    let maxAge:number|undefined,domainSet=false;
    const seen=new Set<string>();
    for(const attribute of attributes) {
      const at=attribute.indexOf('='),key=(at<0?attribute:attribute.slice(0,at)).trim().toLowerCase(),
        content=at<0?'':attribute.slice(at+1).trim();
      if(!['domain','path','expires','max-age','httponly','secure','samesite'].includes(key))continue;
      if(seen.has(key))throw error('COOKIE_INVALID',502);seen.add(key);
      if(key==='domain') {
        const domain=content.toLowerCase();if(domain!=='debot.ai'&&domain!=='.debot.ai')throw error('COOKIE_INVALID',502);
        cookie.domain=domain;domainSet=true;
      } else if(key==='path') {
        if(!content.startsWith('/')||content.length>2048||/[\u0000-\u0020\u007f]/.test(content))throw error('COOKIE_INVALID',502);
        cookie.path=content;
      } else if(key==='expires') {
        const expiry=Date.parse(content);if(!Number.isFinite(expiry))throw error('COOKIE_INVALID',502);cookie.expires=expiry/1000;
      } else if(key==='max-age') {
        if(!/^-?\d+$/.test(content)||!Number.isSafeInteger(Number(content)))throw error('COOKIE_INVALID',502);maxAge=Number(content);
      } else if(key==='httponly')cookie.httpOnly=true;
      else if(key==='secure')cookie.secure=true;
      else {
        const sameSite=content.toLowerCase();if(!['strict','lax','none'].includes(sameSite))throw error('COOKIE_INVALID',502);
        cookie.sameSite=sameSite==='strict'?'Strict':sameSite==='none'?'None':'Lax';
      }
    }
    if(maxAge!==undefined) {
      cookie.expires=maxAge<=0?0:Math.floor(now/1000)+maxAge;
      if(!Number.isSafeInteger(cookie.expires)||cookie.expires>8.64e12)throw error('COOKIE_INVALID',502);
    }
    if(cookie.sameSite==='None'&&!cookie.secure||name.startsWith('__Secure-')&&!cookie.secure||
      name.startsWith('__Host-')&&(!cookie.secure||domainSet||cookie.path!=='/'))throw error('COOKIE_INVALID',502);
    const index=cookies.findIndex(previous=>previous.name===cookie.name&&previous.path===cookie.path&&
      previous.domain.replace(/^\./,'')===cookie.domain.replace(/^\./,''));
    if(index>=0)cookies.splice(index,1);
    if(cookie.expires===-1||cookie.expires*1000>now)cookies.push(cookie);
    if(cookies.length>200)throw error('COOKIE_INVALID',502);
  }
}

export class DebotAuthManager {
  private readonly request:Fetcher;
  private readonly now:()=>Date;
  private readonly enabled:boolean;
  private readonly email:string;
  private challenge?:Challenge;
  private busy=false;
  private authenticated=false;
  private unavailable=false;
  private canSendAt=0;
  private lastError?:string;

  constructor(private readonly options:DebotAuthOptions) {
    this.request=options.fetcher??fetch;this.now=options.now??(()=>new Date());
    this.email=typeof options.email==='string'?options.email.trim():'';
    this.enabled=this.email.length<=320&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email)&&
      typeof options.sessionPath==='string'&&!!options.sessionPath.trim()&&!/[\u0000\r\n]/.test(options.sessionPath)&&
      options.sessionPath!==':memory:'&&!options.sessionPath.startsWith('file:');
    if(!this.enabled)this.lastError='DEBOT_AUTH_CONFIG_MISSING';
  }

  getStatus():DebotAuthStatus {
    if(this.challenge&&this.challenge.expires<=this.now().getTime())this.challenge=undefined;
    return {enabled:this.enabled,email:this.email,state:!this.enabled?'unavailable':this.authenticated?'authenticated':
      this.unavailable?'unavailable':'required',requiresTotp:true,
      ...(this.challenge?{challengeId:this.challenge.id,challengeExpiresAt:new Date(this.challenge.expires).toISOString()}:{}),
      ...(this.canSendAt?{canSendAt:new Date(this.canSendAt).toISOString()}:{}),...(this.lastError?{lastError:this.lastError}:{})};
  }

  /** Only the caller's verified session result can establish an existing login. */
  setAuthenticated(value:boolean):void {this.authenticated=value===true;this.unavailable=false;if(value)this.lastError=undefined;}

  async sendCode():Promise<DebotAuthStatus> {
    this.lock();
    try {
      const now=this.now().getTime();if(now<this.canSendAt)throw error('SEND_COOLDOWN',429);
      this.canSendAt=now+60_000;this.challenge=undefined;
      const cookies:Cookie[]=[];
      const methods=await this.call('/api/security/login/method','POST',{email:this.email},cookies,'methods');
      if(!object(methods.data)||!Array.isArray(methods.data.methods)||methods.data.methods.some(value=>typeof value!=='string')||
        !methods.data.methods.includes('email')||!methods.data.methods.includes('totp'))throw error('METHOD_UNSUPPORTED',409);
      await this.call('/api/login/code/send','POST',{email:this.email,lang:'cn'},cookies,'send');
      this.challenge={id:randomUUID(),expires:this.now().getTime()+CHALLENGE_MS,attempts:0,cookies};
      this.lastError=undefined;this.unavailable=false;return this.getStatus();
    } catch(cause) {throw this.recordError(cause);}
    finally {this.busy=false;}
  }

  async login(input:{challengeId:string;emailCode:string;totpCode:string}):Promise<DebotAuthStatus> {
    this.lock();
    try {
      if(!object(input)||typeof input.challengeId!=='string'||typeof input.emailCode!=='string'||
        typeof input.totpCode!=='string'||!/^\d{6}$/.test(input.emailCode)||!/^\d{6}$/.test(input.totpCode))throw error('INVALID_CODE');
      const challenge=this.challenge;
      if(!challenge||challenge.id!==input.challengeId)throw error('CHALLENGE_INVALID',409);
      if(challenge.expires<=this.now().getTime()){this.challenge=undefined;throw error('CHALLENGE_EXPIRED',409);}
      if(challenge.attempts>=5){this.challenge=undefined;throw error('ATTEMPTS_EXHAUSTED',429);}
      challenge.attempts++;
      const cookies=structuredClone(challenge.cookies);
      await this.call('/api/login/code/signIn','POST',{email:this.email,invite_code:null,login_code:input.emailCode,totp_code:input.totpCode,
        notification_lang:'zh-CN',notification_timezone:-480},cookies,'signin');
      if(!cookieHeader(cookies,new URL('/api/user/info',ORIGIN),this.now().getTime()))throw error('COOKIE_MISSING',502);
      const info=await this.call('/api/user/info','GET',undefined,cookies,'info');
      if(!object(info.data))throw error('USER_INFO_INVALID',401);
      if(!inviteCode(info.data.inviteCode))throw error('INVITE_CODE_INVALID',401);
      if(!secret(info.data.sub_token))throw error('SUB_TOKEN_INVALID',401);
      if(info.data.email!==undefined&&info.data.email!==this.email)throw error('ACCOUNT_MISMATCH',401);
      if(!cookieHeader(cookies,new URL('/api/user/info',ORIGIN),this.now().getTime()))throw error('COOKIE_MISSING',502);
      await this.save({version:1,createdAt:this.now().toISOString(),email:this.email,cookies: cookies.filter(cookie=>
        cookie.expires===-1||cookie.expires*1000>this.now().getTime()),subToken:info.data.sub_token});
      this.challenge=undefined;this.authenticated=true;this.unavailable=false;this.lastError=undefined;
      try {await this.options.onAuthenticated?.();}
      catch {this.lastError='DEBOT_AUTH_RECONNECT_FAILED';}
      return this.getStatus();
    } catch(cause) {
      if(this.challenge&&this.challenge.attempts>=5)this.challenge=undefined;
      throw this.recordError(cause);
    } finally {this.busy=false;}
  }

  private lock():void {
    if(!this.enabled)throw error('CONFIG_MISSING',503);
    if(this.busy)throw error('BUSY',409);
    this.busy=true;
  }
  private recordError(cause:unknown):DebotAuthError {
    const result=cause instanceof DebotAuthError?cause:error('REQUEST_FAILED',502);
    this.lastError=result.reason;this.unavailable=result.statusCode>=500;
    if(result.reason==='DEBOT_AUTH_RATE_LIMITED')this.canSendAt=Math.max(this.canSendAt,this.now().getTime()+60_000);
    return result;
  }

  private async call(path:string,method:'GET'|'POST',body:unknown,cookies:Cookie[],stage:'methods'|'send'|'signin'|'info'):Promise<Record<string,unknown>> {
    const url=new URL(path,ORIGIN);url.searchParams.set('request_id',randomUUID());
    const signal=AbortSignal.timeout(10_000),headers:Record<string,string>={accept:'application/json',origin:ORIGIN,referer:`${ORIGIN}/`};
    const cookie=cookieHeader(cookies,url,this.now().getTime());if(cookie)headers.cookie=cookie;
    if(method==='POST')headers['content-type']='application/json';
    try {
      const response=await this.request(url,{method,credentials:'omit',redirect:'error',headers,signal,
        ...(method==='POST'?{body:JSON.stringify(body)}:{})});
      if(response.redirected||response.status>=300&&response.status<400||response.url&&response.url!==url.href) {
        await response.body?.cancel().catch(()=>{});throw error('REDIRECT_REJECTED',502);
      }
      if(!response.ok) {
        await response.body?.cancel().catch(()=>{});
        throw error(response.status===429?'RATE_LIMITED':[401,403].includes(response.status)?'LOGIN_REJECTED':'HTTP_ERROR',
          response.status===429?429:[401,403].includes(response.status)?401:502);
      }
      updateCookies(cookies,response.headers,url,this.now().getTime());
      const declared=response.headers.get('content-length');
      if(declared&&/^\d+$/.test(declared)&&Number(declared)>MAX_RESPONSE){await response.body?.cancel().catch(()=>{});throw error('RESPONSE_TOO_LARGE',502);}
      if(!response.body)throw error('RESPONSE_INVALID',502);
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
      try {
        for(;;) {
          const part=await reader.read();if(part.done)break;length+=part.value.byteLength;
          if(length>MAX_RESPONSE){await reader.cancel().catch(()=>{});throw error('RESPONSE_TOO_LARGE',502);}
          chunks.push(part.value);
        }
      } finally {reader.releaseLock();}
      let value:unknown;try {value=JSON.parse(Buffer.concat(chunks,length).toString('utf8'));}catch {throw error('RESPONSE_INVALID',502);}
      if(!object(value)||typeof value.code!=='number')throw error('RESPONSE_INVALID',502);
      if(value.code!==0&&value.code!==200)throw error(stage==='signin'?'CODE_REJECTED':stage==='send'?'SEND_REJECTED':stage==='info'?'VERIFY_FAILED':'METHOD_UNSUPPORTED',stage==='signin'||stage==='info'?401:502);
      return value;
    } catch(cause) {
      if(cause instanceof DebotAuthError)throw cause;
      if(signal.aborted||cause instanceof Error&&['AbortError','TimeoutError'].includes(cause.name))throw error('REQUEST_TIMEOUT',504);
      throw error('REQUEST_FAILED',502);
    }
  }

  private async save(value:unknown):Promise<void> {
    const target=resolve(this.options.sessionPath),directory=dirname(target),temporary=join(directory,`.debot-session-${randomUUID()}.tmp`);
    let handle;
    try {
      const text=JSON.stringify(value);if(Buffer.byteLength(text)>MAX_SESSION)throw error('SESSION_TOO_LARGE',502);
      await mkdir(directory,{recursive:true,mode:0o700});
      const parent=await lstat(directory);
      if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o777)!==0o700)throw error('SESSION_PATH_UNSAFE',500);
      try {
        const current=await lstat(target);
        if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1)throw error('SESSION_PATH_UNSAFE',500);
      } catch(cause) {if(!object(cause)||cause.code!=='ENOENT')throw cause;}
      handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      await handle.writeFile(text,'utf8');await handle.sync();await handle.close();handle=undefined;
      await rename(temporary,target);
    } catch(cause) {if(cause instanceof DebotAuthError)throw cause;throw error('SAVE_FAILED',500);}
    finally {await handle?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
  }
}
