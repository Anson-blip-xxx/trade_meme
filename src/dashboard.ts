import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Config} from './config.js';
import type {ScanArchive} from './scan-archive.js';
import type {WalletHistory} from './wallet-history.js';
import {WALLET_PROFILE_GROUPS,type WalletProfileReader} from './wallet-profiles.js';
import bs58 from 'bs58';
import type {WalletSetupLedger} from './wallet-setup-ledger.js';
import {DebotAuthError,type DebotAuthManager} from './providers/debot-auth.js';
import type {Chain} from './types.js';
import type {DebotSignalListOptions} from './debot-scanner.js';
import type {FollowupListOptions} from './signal-followup.js';

export interface DashboardPageOptions {limit:number;offset:number;chain?:Chain;}
function pageOptions(url:URL):DashboardPageOptions {
  const bounded=(name:string,def:number,max:number)=>{const raw=url.searchParams.get(name);if(raw===null)return def;
    if(!/^\d{1,8}$/.test(raw)||Number(raw)>max)throw new Error('INVALID_FILTER');return Number(raw);};
  const chain=url.searchParams.get('chain')||undefined,limit=bounded('limit',20,100),offset=bounded('offset',0,1000000);
  if(limit<1||chain&&!['bsc','solana','robinhood'].includes(chain))throw new Error('INVALID_FILTER');
  return {limit,offset,...(chain?{chain:chain as Chain}:{})};
}
function pageAsOf(url:URL):{asOf?:string} {
  const asOf=url.searchParams.get('asOf');if(asOf===null)return {};
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(asOf)||!Number.isFinite(Date.parse(asOf))||new Date(asOf).toISOString()!==asOf)throw new Error('INVALID_FILTER');
  return {asOf};
}
function followupOptions(url:URL):FollowupListOptions {
  const result:FollowupListOptions={...pageOptions(url),...pageAsOf(url)};
  const decision=url.searchParams.get('decision')||undefined,selected=url.searchParams.get('selected'),status=url.searchParams.get('status')||undefined;
  if(decision&&!['BUY_CANDIDATE','WATCH','REJECT'].includes(decision)||selected!==null&&selected!==''&&!['true','false'].includes(selected)||
    status&&!['collecting','needs_validation','consistent_association','not_replicated'].includes(status))throw new Error('INVALID_FILTER');
  if(decision)result.decision=decision as FollowupListOptions['decision'];
  if(selected!==null&&selected!=='')result.selected=selected==='true';
  if(status)result.status=status as FollowupListOptions['status'];return result;
}

export interface DashboardServices {
  archive:ScanArchive;
  overview:()=>unknown;
  home?:()=>unknown;
  orders:(options?:DashboardPageOptions)=>unknown;
  protection?:(options?:DashboardPageOptions)=>unknown;
  chainStream?:()=>unknown;
  debotAuth?:Pick<DebotAuthManager,'getStatus'|'sendCode'|'login'>;
  debotSignals?:(options?:DebotSignalListOptions)=>unknown;
  debotHistory?:(chain:Chain,address:string,options:{limit:number;offset:number;asOf?:string})=>unknown;
  aveSignals?:(options:DashboardPageOptions&{asOf?:string})=>unknown;
  sourceHistory?:(chain:Chain,address:string,options:{limit:number;offset:number;asOf?:string})=>unknown;
  memeSignals?:(options:DashboardPageOptions&{asOf?:string})=>unknown;
  memeDetail?:(chain:Chain,address:string,options:{limit:number;offset:number;asOf?:string})=>unknown;
  protectionDetail?:(id:string)=>unknown;
  walletHistory?:Pick<WalletHistory,'listWallets'|'getWallet'>;
  walletResearchStatus?:()=>unknown;
  walletAssociations?:Pick<WalletHistory,'listAssociations'|'getAssociation'|'associationStats'>;
  walletProfiles?:Pick<WalletProfileReader,'list'|'get'>;
  walletProfilesStatus?:()=>unknown;
  walletScreening?:Pick<WalletSetupLedger,'list'|'status'>;
}
function same(a:string,b:string):boolean {
  const left=createHash('sha256').update(a).digest(),right=createHash('sha256').update(b).digest();
  return timingSafeEqual(left,right);
}
const loopback=(value?:string)=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(value??'');
const cookieName='meme_dashboard_session';
const lifetime=12*60*60*1000;
export function buildDashboard(config:Config,services:DashboardServices,assetDirectory=resolve('web')) {
  const token=config.dashboard.token;
  if(!token||token.length<32||token===config.ingestToken||token===config.gmgnApiKey) throw new Error('DASHBOARD_SEPARATE_TOKEN_REQUIRED');
  const sessions=new Map<string,number>(),attempts=new Map<string,{count:number;expires:number}>();
  const assets=new Map(['/dashboard/','/dashboard/app.js','/dashboard/styles.css'].map((path,i)=>[path,{
    body:readFileSync(resolve(assetDirectory,['index.html','app.js','styles.css'][i])),
    type:['text/html; charset=utf-8','text/javascript; charset=utf-8','text/css; charset=utf-8'][i]}]));
  const send=(res:ServerResponse,status:number,data:unknown)=>{
    res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));
  };
  const sessionId=(req:IncomingMessage)=>{
    const raw=req.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    return raw&&/^[0-9a-f]{64}$/.test(raw)?createHash('sha256').update(raw).digest('hex'):undefined;
  };
  const proxyAuthenticated=(req:IncomingMessage)=>{
    // Only a local TLS/auth proxy may supply this header. Public clients cannot use it directly.
    const header=req.headers['x-dashboard-access'];
    return loopback(req.socket.remoteAddress)&&typeof header==='string'&&same(header,token);
  };
  const authenticated=(req:IncomingMessage)=>{
    if(proxyAuthenticated(req))return true;
    const id=sessionId(req),expires=id?sessions.get(id):undefined;
    return !!expires&&expires>Date.now();
  };
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url=new URL(req.url??'/','http://localhost');
      if(req.method==='GET'&&['/','/dashboard'].includes(url.pathname)) {res.writeHead(302,{location:'/dashboard/'});res.end();return;}
      const asset=assets.get(url.pathname);
      if(req.method==='GET'&&asset) {res.writeHead(200,{'content-type':asset.type});res.end(asset.body);return;}
      if(!url.pathname.startsWith('/dashboard/api/')) {send(res,404,{error:'NOT_FOUND'});return;}
      const now=Date.now();
      for(const [id,expires] of sessions) if(expires<=now) sessions.delete(id);
      for(const [ip,state] of attempts) if(state.expires<=now) attempts.delete(ip);
      if(req.method==='POST') {
        const origin=req.headers.origin;
        const own=`http://${req.headers.host}`;
        if(req.headers['sec-fetch-site']==='cross-site'||origin&&(origin!==config.dashboard.origin&&origin!==own)) {
          send(res,403,{error:'ORIGIN_REJECTED'});return;
        }
      }
      if(req.method==='POST'&&url.pathname==='/dashboard/api/login') {
        const ip=req.socket.remoteAddress??'unknown',attempt=attempts.get(ip);
        if((attempt?.count??0)>=10||attempts.size>=1000&&!attempt) {res.setHeader('retry-after','900');send(res,429,{error:'LOGIN_RATE_LIMITED'});return;}
        if(!req.headers['content-type']?.startsWith('application/json')) {send(res,415,{error:'JSON_REQUIRED'});return;}
        let size=0;const chunks:Buffer[]=[];
        for await(const part of req) {size+=part.length;if(size>1024){send(res,413,{error:'BODY_TOO_LARGE'});return;}chunks.push(part);}
        let password:unknown;
        try {password=JSON.parse(Buffer.concat(chunks).toString('utf8')).password;} catch {send(res,400,{error:'INVALID_JSON'});return;}
        attempts.set(ip,{count:(attempt?.count??0)+1,expires:attempt?.expires??now+900000});
        if(typeof password!=='string'||!same(password,token)) {send(res,401,{error:'UNAUTHORIZED'});return;}
        attempts.delete(ip);
        if(sessions.size>=1000) {send(res,503,{error:'SESSION_CAPACITY'});return;}
        const raw=randomBytes(32).toString('hex'),id=createHash('sha256').update(raw).digest('hex');
        sessions.set(id,now+lifetime);
        const secure=config.dashboard.origin?.startsWith('https:')&&(req.headers.origin===config.dashboard.origin||
          loopback(req.socket.remoteAddress)&&req.headers['x-forwarded-proto']==='https');
        res.setHeader('set-cookie',`${cookieName}=${raw}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=${lifetime/1000}${secure?'; Secure':''}`);
        send(res,200,{authenticated:true});return;
      }
      if(!authenticated(req)) {send(res,401,{error:'UNAUTHORIZED'});return;}
      if(req.method==='POST'&&url.pathname==='/dashboard/api/logout') {
        const id=sessionId(req);if(id)sessions.delete(id);
        res.setHeader('set-cookie',`${cookieName}=; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=0`);
        send(res,200,{ok:true});return;
      }
      if(req.method==='GET'&&url.pathname==='/dashboard/api/debot/auth') {
        send(res,200,services.debotAuth?.getStatus()??{enabled:false,state:'unavailable',requiresTotp:true});return;
      }
      if(req.method==='POST'&&['/dashboard/api/debot/auth/code','/dashboard/api/debot/auth/login'].includes(url.pathname)) {
        if(!services.debotAuth){send(res,503,{error:'DEBOT_AUTH_DISABLED'});return;}
        if(!req.headers['content-type']?.startsWith('application/json')){send(res,415,{error:'JSON_REQUIRED'});return;}
        let size=0;const chunks:Buffer[]=[];
        for await(const part of req){size+=part.length;if(size>1024){send(res,413,{error:'BODY_TOO_LARGE'});return;}chunks.push(part);}
        let input:Record<string,unknown>;
        try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw new Error();}
        catch{send(res,400,{error:'INVALID_JSON'});return;}
        const isCode=url.pathname.endsWith('/code');
        const keys=isCode?[]:['challengeId','emailCode','totpCode'];
        if(Object.keys(input).some(key=>!keys.includes(key))||!isCode&&keys.some(key=>typeof input[key]!=='string')) {
          send(res,400,{error:'DEBOT_AUTH_INPUT_INVALID'});return;
        }
        try {
          const status=isCode?await services.debotAuth.sendCode():await services.debotAuth.login({
            challengeId:input.challengeId as string,emailCode:input.emailCode as string,totpCode:input.totpCode as string});
          send(res,200,status);
        }catch(error){
          // This user is already authenticated to the dashboard. A vendor login
          // failure must not challenge the browser's HTTP Basic credentials.
          if(error instanceof DebotAuthError)send(res,[401,403].includes(error.statusCode)?422:error.statusCode,{error:error.reason});
          else send(res,503,{error:'DEBOT_AUTH_UNAVAILABLE'});
        }
        return;
      }
      if(req.method!=='GET') {send(res,405,{error:'READ_ONLY'});return;}
      if(url.pathname==='/dashboard/api/session') {send(res,200,{authenticated:true,readOnly:true,authentication:proxyAuthenticated(req)?'proxy':'session'});return;}
      if(url.pathname==='/dashboard/api/overview') {send(res,200,services.overview());return;}
      if(url.pathname==='/dashboard/api/home') {send(res,200,services.home?.()??{enabled:false});return;}
      if(url.pathname==='/dashboard/api/followup') {send(res,200,services.archive.followupDashboardSummary());return;}
      if(url.pathname==='/dashboard/api/followup/records') {send(res,200,services.archive.followupList(followupOptions(url)));return;}
      if(url.pathname==='/dashboard/api/followup/groups') {send(res,200,services.archive.followupGroups(followupOptions(url)));return;}
      if(url.pathname==='/dashboard/api/followup/learning') {send(res,200,services.archive.followupLearning(followupOptions(url)));return;}
      const followupMatch=url.pathname.match(/^\/dashboard\/api\/followup\/([^/]+)\/([^/]+)$/);
      if(followupMatch) {
        const chain=followupMatch[1];let address:string;
        try {
          address=decodeURIComponent(followupMatch[2]);
          if(!['bsc','solana','robinhood'].includes(chain))throw new Error();
          if(chain==='solana'){if(address.length>44||bs58.decode(address).length!==32)throw new Error();}
          else {if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw new Error();address=address.toLowerCase();}
        }catch {throw new Error('INVALID_FILTER');}
        const detail=services.archive.followupDetail({chain:chain as 'bsc'|'solana'|'robinhood',address});
        send(res,detail?200:404,detail??{error:'NOT_FOUND'});return;
      }
      if(url.pathname==='/dashboard/api/debot/signals') {
        const options:DebotSignalListOptions={...pageOptions(url),...pageAsOf(url)},state=url.searchParams.get('state')||undefined;
        if(state&&!['pending','dispatching','completed','failed','interrupted','ignored'].includes(state))throw new Error('INVALID_FILTER');
        if(state)options.state=state;
        send(res,200,services.debotSignals?.(options)??{now:new Date().toISOString(),asOf:options.asOf??new Date().toISOString(),
          total:0,limit:options.limit,offset:options.offset,hasMore:false,items:[]});return;
      }
      if(url.pathname==='/dashboard/api/meme'){
        const options={...pageOptions(url),...pageAsOf(url)};
        send(res,200,services.memeSignals?.(options)??{now:new Date().toISOString(),asOf:options.asOf??new Date().toISOString(),
          status:{enabled:false},total:0,items:[],...options,hasMore:false});return;
      }
      if(url.pathname==='/dashboard/api/ave/signals'){
        const options={...pageOptions(url),...pageAsOf(url)};
        if(options.asOf&&Date.parse(options.asOf)>Date.now())throw new Error('INVALID_FILTER');
        send(res,200,services.aveSignals?.(options)??{now:new Date().toISOString(),asOf:options.asOf??new Date().toISOString(),
          total:0,items:[],...options,hasMore:false});return;
      }
      const memeMatch=url.pathname.match(/^\/dashboard\/api\/meme\/([^/]+)\/([^/]+)$/);
      const sourceMatch=url.pathname.match(/^\/dashboard\/api\/sources\/([^/]+)\/([^/]+)\/events$/);
      const notificationMatch=memeMatch??sourceMatch??url.pathname.match(/^\/dashboard\/api\/debot\/tokens\/([^/]+)\/([^/]+)\/events$/);
      if(notificationMatch){
        const chain=notificationMatch[1];let address:string;
        if(!['bsc','solana','robinhood'].includes(chain))throw new Error('INVALID_FILTER');
        try {
          address=decodeURIComponent(notificationMatch[2]);
          if(chain==='solana'){if(address.length>44||bs58.decode(address).length!==32)throw new Error();}
          else {if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw new Error();address=address.toLowerCase();}
        }catch{throw new Error('INVALID_FILTER');}
        const options={...pageOptions(url),...pageAsOf(url)};
        if(memeMatch){send(res,200,services.memeDetail?.(chain as Chain,address,options)??{token:{chain,address},total:0,items:[],...options,hasMore:false});return;}
        if(sourceMatch){
          if(options.asOf&&Date.parse(options.asOf)>Date.now())throw new Error('INVALID_FILTER');
          send(res,200,services.sourceHistory?.(chain as Chain,address,options)??{token:{chain,address},asOf:options.asOf??new Date().toISOString(),
            total:0,items:[],...options,hasMore:false,scope:'source_notifications_not_independent_wallets'});return;
        }
        send(res,200,services.debotHistory?.(chain as Chain,address,options)??{chain,address,total:0,items:[],...options,hasMore:false});return;
      }
      if(url.pathname==='/dashboard/api/orders') {send(res,200,services.orders(pageOptions(url)));return;}
      if(url.pathname==='/dashboard/api/chain-stream') {send(res,200,services.chainStream?.()??{enabled:false,running:false,chains:[],recentEvents:[]});return;}
      if(url.pathname==='/dashboard/api/protection') {
        const options=pageOptions(url);
        send(res,200,services.protection?.(options)??{enabled:false,mode:'shadow',liveReady:false,items:[],total:0,...options,hasMore:false});return;
      }
      const protectionMatch=url.pathname.match(/^\/dashboard\/api\/protection\/([0-9a-f-]{36})$/);
      if(protectionMatch) {
        const detail=services.protectionDetail?.(protectionMatch[1]);send(res,detail?200:404,detail??{error:'NOT_FOUND'});return;
      }
      if(url.pathname==='/dashboard/api/wallet-research/status') {
        send(res,200,services.walletResearchStatus?.()??{enabled:false});return;
      }
      if(url.pathname==='/dashboard/api/wallet-profiles/status') {
        send(res,200,services.walletProfilesStatus?.()??{enabled:false,running:false,ready:false});return;
      }
      if(url.pathname==='/dashboard/api/wallet-screening/status') {send(res,200,services.walletScreening?.status()??{enabled:false});return;}
      if(url.pathname==='/dashboard/api/wallet-screening') {
        const options=pageOptions(url),chain=options.chain,address=url.searchParams.get('address')||undefined;
        if(address){if(!chain)throw new Error('INVALID_FILTER');try{if(chain==='solana'){if(address.length>44||bs58.decode(address).length!==32)throw new Error();}
          else if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw new Error();}catch{throw new Error('INVALID_FILTER');}}
        send(res,200,services.walletScreening?.list({...options,address})??{items:[],sampleOnly:true,total:0,...options,hasMore:false});return;
      }
      if(url.pathname==='/dashboard/api/wallet-profiles') {
        const chain=url.searchParams.get('chain')||undefined,group=url.searchParams.get('group')||undefined,search=url.searchParams.get('search')??'';
        const bounded=(name:string,def:number,max:number)=>{const raw=url.searchParams.get(name);if(raw===null)return def;
          if(!/^\d{1,8}$/.test(raw)||Number(raw)>max)throw new Error('INVALID_FILTER');return Number(raw);};
        if(chain&&!['bsc','solana','robinhood'].includes(chain)||search.length>160||group&&!(WALLET_PROFILE_GROUPS as readonly string[]).includes(group))throw new Error('INVALID_FILTER');
        const limit=bounded('limit',25,100),offset=bounded('offset',0,1000000);if(limit<1)throw new Error('INVALID_FILTER');
        send(res,200,services.walletProfiles?.list({chain:chain as any,group:group as any,search,limit,offset})??{ready:false,items:[],total:0});return;
      }
      const profileMatch=url.pathname.match(/^\/dashboard\/api\/wallet-profiles\/([^/]+)\/([^/]+)$/);
      if(profileMatch) {
        const chain=profileMatch[1];let address:string;
        try {address=decodeURIComponent(profileMatch[2]);
          if(!['bsc','solana','robinhood'].includes(chain))throw new Error();
          if(chain==='solana'){if(address.length>44||bs58.decode(address).length!==32)throw new Error();}
          else {if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw new Error();address=address.toLowerCase();}
        }catch {throw new Error('INVALID_FILTER');}
        const profile=services.walletProfiles?.get(chain as any,address);
        send(res,profile?200:404,profile??{error:'NOT_FOUND'});return;
      }
      if(url.pathname==='/dashboard/api/wallet-associations/status') {
        send(res,200,services.walletAssociations?{enabled:true,...services.walletAssociations.associationStats()}:{enabled:false});return;
      }
      if(url.pathname==='/dashboard/api/wallet-associations') {
        const chain=url.searchParams.get('chain')||undefined,search=url.searchParams.get('search')??'';
        const bounded=(name:string,defaultValue:number,max:number)=>{const raw=url.searchParams.get(name);if(raw===null)return defaultValue;
          if(!/^\d{1,8}$/.test(raw)||Number(raw)>max)throw new Error('INVALID_FILTER');return Number(raw);};
        if(chain&&!['bsc','solana','robinhood'].includes(chain)||search.length>160)throw new Error('INVALID_FILTER');
        const limit=bounded('limit',25,100),offset=bounded('offset',0,1000000);if(limit<1)throw new Error('INVALID_FILTER');
        send(res,200,services.walletAssociations?.listAssociations({chain:chain as any,search,limit,offset})??{items:[],total:0});return;
      }
      const associationMatch=url.pathname.match(/^\/dashboard\/api\/wallet-associations\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if(associationMatch) {
        const chain=associationMatch[1];let addresses:string[];
        try {
          if(!['bsc','solana','robinhood'].includes(chain))throw new Error();
          addresses=associationMatch.slice(2).map(value=>{
            const address=decodeURIComponent(value);
            if(chain==='solana'){if(address.length>44||bs58.decode(address).length!==32)throw new Error();return address;}
            if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw new Error();return address.toLowerCase();
          });
          if(addresses[0]===addresses[1])throw new Error();
        }catch{throw new Error('INVALID_FILTER');}
        const association=services.walletAssociations?.getAssociation(chain as any,addresses[0],addresses[1]);
        send(res,association?200:404,association??{error:'NOT_FOUND'});return;
      }
      if(url.pathname==='/dashboard/api/wallets') {
        if(!services.walletHistory) {send(res,200,{items:[],total:0});return;}
        const chain=url.searchParams.get('chain')||undefined,sort=url.searchParams.get('sort')||'recent';
        const search=url.searchParams.get('search')??'';
        const bounded=(name:string,defaultValue:number,max:number)=>{const raw=url.searchParams.get(name);if(raw===null)return defaultValue;
          if(!/^\d{1,8}$/.test(raw)||Number(raw)>max)throw new Error('INVALID_FILTER');return Number(raw);};
        if(chain&&!['bsc','solana','robinhood'].includes(chain)||!['profit','gain','coordination','recent'].includes(sort)||search.length>160)
          throw new Error('INVALID_FILTER');
        const limit=bounded('limit',25,100),offset=bounded('offset',0,1000000);if(limit<1)throw new Error('INVALID_FILTER');
        send(res,200,services.walletHistory.listWallets({chain:chain as any,sort:sort as any,search,limit,offset}));return;
      }
      const walletMatch=url.pathname.match(/^\/dashboard\/api\/wallets\/([^/]+)\/([^/]+)$/);
      if(walletMatch) {
        const chain=walletMatch[1];let address:string;
        try {address=decodeURIComponent(walletMatch[2]);
          if(!['bsc','solana','robinhood'].includes(chain))throw new Error();
          if(chain==='solana'){if(address.length>44||bs58.decode(address).length!==32)throw new Error();}
          else {if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw new Error();address=address.toLowerCase();}
        } catch {throw new Error('INVALID_FILTER');}
        const wallet=services.walletHistory?.getWallet(chain as any,address);
        send(res,wallet?200:404,wallet?{...wallet,behaviorProfile:services.walletProfiles?.get(chain as any,address)}:{error:'NOT_FOUND'});return;
      }
      if(url.pathname==='/dashboard/api/scans') {
        const chain=url.searchParams.get('chain')||undefined,decision=url.searchParams.get('decision')||undefined;
        const number=(name:string,def:number,max:number)=>{const raw=url.searchParams.get(name);if(raw===null)return def;
          if(!/^\d{1,8}$/.test(raw)||Number(raw)>max) throw new Error('INVALID_FILTER');return Number(raw);};
        if(chain&&!['bsc','solana','robinhood'].includes(chain)||decision&&!['BUY_CANDIDATE','WATCH','REJECT'].includes(decision)) throw new Error('INVALID_FILTER');
        const search=url.searchParams.get('search')??'';if(search.length>160) throw new Error('INVALID_FILTER');
        const eligible=url.searchParams.get('eligible');if(eligible!==null&&!['true','false'].includes(eligible))throw new Error('INVALID_FILTER');
        const limit=number('limit',20,200),offset=number('offset',0,100000);if(limit<1)throw new Error('INVALID_FILTER');
        send(res,200,services.archive.dashboardList({chain:chain as any,decision:decision as any,search,limit,offset,
          ...(eligible!==null?{eligible:eligible==='true'}:{})}));return;
      }
      const match=url.pathname.match(/^\/dashboard\/api\/scans\/([0-9a-f-]{36})$/);
      if(match) {const row=services.archive.get(match[1]);send(res,row?200:404,row??{error:'NOT_FOUND'});return;}
      send(res,404,{error:'NOT_FOUND'});
    } catch(error) {send(res,error instanceof Error&&error.message==='INVALID_FILTER'?400:500,
      {error:error instanceof Error&&error.message==='INVALID_FILTER'?'INVALID_FILTER':'DASHBOARD_UNAVAILABLE'});}
  });
  server.headersTimeout=10000;server.requestTimeout=15000;
  server.on('close',()=>{sessions.clear();attempts.clear();});
  return server;
}
