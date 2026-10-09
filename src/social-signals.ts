import profileConfig from '../config/social-profiles.json' with {type:'json'};
import type {Chain,Evidence,Signal,SocialReport,SocialSignal} from './types.js';
import type {GmgnTokenSnapshot} from './providers/gmgn-safety.js';
import {mentionsAddress,xPostId} from './providers/evidence.js';

export interface SocialProfile {
  person:string;label:string;chains:Chain[];handle:string;profileUrl:string;identitySources:string[];
  accountId:string|null;accountIdVerification:'primary'|'unverified';accountIdSource:string|null;
}
export interface SocialSignalOptions {
  snapshot?:GmgnTokenSnapshot;now?:Date;maxAgeSec?:number;profiles?:readonly SocialProfile[];
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hosts=new Set(['x.com','www.x.com','twitter.com','www.twitter.com']);
const sameAddress=(a:string,b:string,chain:Chain)=>chain==='solana'?a===b:a.toLowerCase()===b.toLowerCase();
const fullAddressMention=(text:string,signal:Signal)=>mentionsAddress(text,signal)&&
  new RegExp(`(?<![A-Za-z0-9])${signal.token.address}(?![A-Za-z0-9])`,signal.token.chain==='solana'?'':'i').test(text);
function safeUrl(value:unknown):URL|undefined {
  if(typeof value!=='string'||value.length>1000) return;
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port?url:undefined;} catch {return;}
}
function profileHandle(value:unknown,allowUsername=false):string|undefined {
  if(typeof value!=='string') return;
  if(allowUsername&&/^@?[A-Za-z0-9_]{1,15}$/.test(value)) return value.replace(/^@/,'').toLowerCase();
  const url=safeUrl(value);if(!url||!hosts.has(url.hostname)) return;
  return url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1].toLowerCase();
}
function metadataSocialLink(value:unknown,allowUsername=false):{handle:string;url:string}|undefined {
  const profile=profileHandle(value,allowUsername);
  if(profile) return {handle:profile,url:`https://x.com/${profile}`};
  const url=safeUrl(value);if(!url||!hosts.has(url.hostname)) return;
  const post=url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,20})\/?$/);
  return post?{handle:post[1].toLowerCase(),url:`https://x.com/${post[1].toLowerCase()}/status/${post[2]}`}:undefined;
}
function validProfiles(input:readonly SocialProfile[]):SocialProfile[] {
  const persons=new Set<string>(),handles=new Set<string>(),ids=new Set<string>();
  return input.slice(0,20).filter(profile=>{
    if(!object(profile)||typeof profile.person!=='string'||! /^[a-z][a-z0-9_]{0,39}$/.test(profile.person)||
      typeof profile.label!=='string'||profile.label.length>80||!Array.isArray(profile.chains)||!profile.chains.length||
      profile.chains.some(chain=>!['bsc','solana','robinhood'].includes(chain))||
      typeof profile.handle!=='string'||! /^[A-Za-z0-9_]{1,15}$/.test(profile.handle)||
      profileHandle(profile.profileUrl)!==profile.handle.toLowerCase()||!Array.isArray(profile.identitySources)||
      !profile.identitySources.length||profile.identitySources.some(url=>!safeUrl(url))||
      !['primary','unverified'].includes(profile.accountIdVerification)||
      profile.accountId!==null&&(typeof profile.accountId!=='string'||!/^\d{1,20}$/.test(profile.accountId))||
      profile.accountIdVerification==='primary'&&(!profile.accountId||!safeUrl(profile.accountIdSource))) return false;
    const handle=profile.handle.toLowerCase();
    if(persons.has(profile.person)||handles.has(handle)||profile.accountId!==null&&ids.has(profile.accountId)) return false;
    persons.add(profile.person);handles.add(handle);if(profile.accountId) ids.add(profile.accountId);
    return true;
  });
}
export const DEFAULT_SOCIAL_PROFILES:readonly SocialProfile[]=validProfiles(profileConfig.profiles as SocialProfile[]);

/** No requests, NLP, endorsement inference or trading permission: only bounded research priority. */
export function assessSocialSignals(signal:Signal,evidence:readonly Evidence[],options:SocialSignalOptions={}):SocialReport {
  const result:SocialReport={score:0,scope:'research_priority',signals:[],endorsementVerified:false};
  const now=(options.now??new Date()).getTime(),maxAgeSec=options.maxAgeSec??21_600;
  if(!Number.isFinite(now)||!Number.isFinite(maxAgeSec)||maxAgeSec<=0||maxAgeSec>604_800) return result;
  const profiles=validProfiles(options.profiles??DEFAULT_SOCIAL_PROFILES).filter(profile=>profile.chains.includes(signal.token.chain));
  const selected=new Map<string,SocialSignal>();
  const fresh=(stamp:unknown):stamp is string=>typeof stamp==='string'&&Number.isFinite(Date.parse(stamp))&&
    Date.parse(stamp)<=now&&now-Date.parse(stamp)<=maxAgeSec*1000;
  const snapshot=options.snapshot,info=snapshot?.info;
  // The official token schema documents link.twitter_username and link.website.
  // Metadata is project controlled even when it was retrieved by the GMGN API.
  const bound=snapshot&&snapshot.token.chain===signal.token.chain&&
    sameAddress(snapshot.token.address,signal.token.address,signal.token.chain)&&fresh(snapshot.fetchedAt)&&object(info)&&
    typeof info.address==='string'&&sameAddress(info.address,signal.token.address,signal.token.chain)&&
    (info.chain===undefined||info.chain===signal.token.chain||signal.token.chain==='solana'&&info.chain==='sol')&&
    !snapshot.diagnostics.some(item=>item.section==='info'&&item.status!=='ok');
  if(bound&&object(info.link)) {
    const links=[metadataSocialLink(info.link.twitter_username,true),metadataSocialLink(info.link.website)].filter(value=>!!value);
    for(const profile of profiles) {
      const linked=links.find(value=>value.handle===profile.handle.toLowerCase());
      if(linked) selected.set(profile.person,{person:profile.person,label:profile.label,kind:'profile_link',weight:5,
        sourceUrl:linked.url,verification:'project_link'});
    }
  }
  for(const post of evidence.slice(0,100)) {
    if(!post||typeof post.text!=='string'||!post.text.trim()||post.text.length>25_000||
      typeof post.authorId!=='string'||!/^\d{1,20}$/.test(post.authorId)||!fresh(post.publishedAt)||!fresh(post.fetchedAt)||
      Date.parse(post.publishedAt)>Date.parse(post.fetchedAt)||!fullAddressMention(post.text,signal)) continue;
    const id=xPostId(post.url),url=safeUrl(post.url);
    if(!id||post.id!==`x:${id}`||!url) continue;
    const accepted=post.provider==='x_official'?post.verification==='first_party':
      ['fxembed','twitterapi_io'].includes(post.provider)&&post.verification==='third_party';
    if(!accepted) continue;
    const profile=profiles.find(item=>item.accountIdVerification==='primary'&&item.accountId===post.authorId);
    if(!profile) continue;
    const urlAuthor=url.pathname.match(/^\/([A-Za-z0-9_]+)\/status\//)?.[1];
    if(urlAuthor&&urlAuthor.toLowerCase()!==profile.handle.toLowerCase()) continue;
    const existing=selected.get(profile.person);
    if(existing?.kind==='ca_post'&&(existing.verification==='first_party'||post.verification==='third_party')) continue;
    selected.set(profile.person,{person:profile.person,label:profile.label,kind:'ca_post',weight:20,
      sourceUrl:`https://x.com/i/web/status/${id}`,verification:post.verification,evidenceId:post.id});
  }
  result.signals=[...selected.values()];
  const profilesTotal=result.signals.filter(item=>item.kind==='profile_link').reduce((total,item)=>total+item.weight,0);
  const postsTotal=result.signals.filter(item=>item.kind==='ca_post').reduce((total,item)=>total+item.weight,0);
  result.score=Math.min(30,Math.min(10,profilesTotal)+postsTotal);
  return result;
}
