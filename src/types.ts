import { z } from 'zod';
import bs58 from 'bs58';
import type {WalletAnalysis} from './research/wallet-types.js';
import type {GmgnTokenSnapshot} from './providers/gmgn-safety.js';
import type {WalletScreeningReport} from './wallet-screening.js';

export const Chain = z.enum(['bsc', 'solana', 'robinhood']);
export type Chain = z.infer<typeof Chain>;
export const Platform = z.enum(['pump', 'bonk', 'four', 'flap']);
export type Platform = z.infer<typeof Platform>;
export const VendorNarrativeSchema=z.object({
  provider:z.enum(['gmgn','debot']),
  token:z.object({chain:Chain,address:z.string().min(32).max(44)}).strict(),
  sourceUrl:z.url().max(500),
  text:z.string().min(1).max(12000),
  updatedAt:z.iso.datetime({offset:true}).optional(),
  evidenceUrls:z.array(z.url().max(500)).max(12).default([]),
  structured:z.object({
    format:z.literal('debot_story_v2'),historyId:z.string().min(1).max(160),projectName:z.string().max(500),narrativeType:z.string().max(500),
    rating:z.object({score:z.string().max(40),reason:z.string().max(6000)}).strict(),
    sections:z.array(z.object({path:z.string().max(200),text:z.string().max(12000),reference:z.string().max(2000)}).strict()).max(100),
    sourceTweetIds:z.array(z.string().regex(/^\d{1,20}$/)).max(2000),
  }).strict().optional(),
}).strict().superRefine((v,ctx)=>{
  try {
    const u=new URL(v.sourceUrl),host=v.provider==='gmgn'?'gmgn.ai':'debot.ai';
    if(u.protocol!=='https:'||u.username||u.password||u.port||![host,`www.${host}`].includes(u.hostname)) throw new Error();
  } catch {ctx.addIssue({code:'custom',message:'叙事来源链接必须是对应平台的 HTTPS 页面',path:['sourceUrl']});}
});
export type VendorNarrative=z.infer<typeof VendorNarrativeSchema>;
export const SignalSchema = z.object({
  source: z.enum(['debot', 'gmgn', 'manual']),
  sourceEventId: z.string().min(1).max(160),
  occurredAt: z.iso.datetime(),
  token: z.object({ chain: Chain, address: z.string().min(32).max(44) }).strict(),
  claimedPlatform: Platform.optional(),
  creationTx: z.string().max(100).optional(),
  platformState: z.string().max(44).optional(),
  text: z.string().max(12000).default(''),
  evidenceUrls: z.array(z.url().max(500)).max(12).default([]),
  claim: z.enum(['community', 'official', 'unspecified']).default('unspecified'),
  vendorNarrative:VendorNarrativeSchema.optional(),
}).strict().superRefine((s, ctx) => {
  try {
    if (s.token.chain === 'solana') { if(bs58.decode(s.token.address).length!==32) throw new Error(); }
    else if (!/^0x[0-9a-fA-F]{40}$/.test(s.token.address)) throw new Error();
  } catch { ctx.addIssue({code:'custom', message:'链与合约地址格式不匹配', path:['token','address']}); }
  if (s.creationTx && !(s.token.chain === 'solana'
    ? /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s.creationTx) : /^0x[0-9a-fA-F]{64}$/.test(s.creationTx)))
    ctx.addIssue({code:'custom',message:'创建交易格式错误',path:['creationTx']});
  if(s.vendorNarrative) {
    const v=s.vendorNarrative.token;
    if(v.chain!==s.token.chain||(v.chain==='solana'?v.address!==s.token.address:v.address.toLowerCase()!==s.token.address.toLowerCase()))
      ctx.addIssue({code:'custom',message:'供应商叙事的链和 CA 必须匹配信号',path:['vendorNarrative','token']});
  }
});
export type Signal = z.infer<typeof SignalSchema>;
export function parseSignal(input: unknown): Signal {
  const signal = SignalSchema.parse(input);
  if (signal.token.chain !== 'solana') signal.token.address = signal.token.address.toLowerCase();
  return signal;
}
export type Status = 'pass' | 'fail' | 'unknown';
export interface Check {
  status: Status;
  reasons: string[];
  facts: Record<string, unknown>;
  checkedAt: string;
}
export interface Provenance extends Check { platform?: Platform; method?: string; }
export interface Evidence {
  id: string; url: string; text: string; authorId: string;
  publishedAt: string; fetchedAt: string;
  provider: 'x_official' | 'fxembed' | 'twitterapi_io';
  // Retrieval provenance, not proof that the post's claims are true or the author is endorsed.
  verification: 'first_party' | 'third_party';
  authority: 'issuer' | 'tracked' | 'public';
}
export const NarrativeSchema = z.object({
  thesis: z.string().max(2000),
  catalyst: z.string().max(2000),
  relation: z.enum(['official', 'community', 'unresolved', 'conflict']),
  stage: z.enum(['emerging', 'spreading', 'crowded', 'fading', 'unknown']),
  assessment: z.enum(['favorable', 'watch', 'adverse']),
  confidence: z.enum(['low', 'medium', 'high']),
  supportingEvidenceIds: z.array(z.string()).max(12),
  opposingEvidenceIds: z.array(z.string()).max(12),
  reasons: z.array(z.string()).max(12),
  uncertainties: z.array(z.string()).max(12),
}).strict();
export type Narrative = z.infer<typeof NarrativeSchema>;
export interface NarrativeReport extends Check {
  analysis?: Narrative; evidence: Evidence[]; model?: string;
  supplier?:{provider:'gmgn'|'debot';text:string;sourceUrl:string;updatedAt?:string;verification:'user_supplied'|'vendor_endpoint';contentType:'vendor_ai_narrative'};
}
export interface VendorAddressConflict {
  address:string;field:'data.history.ca_address'|'data.history.story.contract_address';
}
/** Complete address syntax only; this does not infer which EVM chain owns it. */
export function completeContractAddress(value:unknown):value is string {
  if(typeof value!=='string')return false;
  if(/^0x[0-9a-fA-F]{40}$/.test(value))return true;
  if(value.length<32||value.length>44)return false;
  try{return bs58.decode(value).length===32;}catch{return false;}
}
export interface SocialSignal {
  person:string;label?:string;kind:'profile_link'|'ca_post';weight:number;sourceUrl:string;
  verification:'project_link'|'first_party'|'third_party';evidenceId?:string;
}
export interface SocialReport {
  score:number;scope:'research_priority';signals:SocialSignal[];endorsementVerified:false;
}
export interface Report {
  marketRisk?:Check;
  id: string; policyVersion: string; mode: 'live' | 'demo';
  signal: Signal; receivedAt: string; evaluatedAt: string; validUntil: string;
  decision: 'BUY_CANDIDATE' | 'WATCH' | 'REJECT'; buyEligible: boolean;
  decisionAtEvaluation?: 'BUY_CANDIDATE' | 'WATCH' | 'REJECT';
  executionEnabled: false; reasons: string[];
  advisoryReasons?:string[];social?:SocialReport;
  walletScreening?:WalletScreeningReport;
  provenance: Provenance; safety: Check; narrative: NarrativeReport;
  gmgn?:GmgnTokenSnapshot;wallets?:WalletAnalysis;flow?:Check;
}

/** Only concrete token-identity contradictions are gates; narrative opinions are advisory. */
export function narrativeIdentityConflict(signal:Signal,narrative:NarrativeReport):boolean {
  const conflict=narrative.facts?.supplierAddressConflict;
  if(conflict&&typeof conflict==='object'&&!Array.isArray(conflict)) {
    const value=conflict as Record<string,unknown>;
    if(['data.history.ca_address','data.history.story.contract_address'].includes(String(value.field))&&completeContractAddress(value.address)&&
      (signal.token.chain==='solana'?value.address!==signal.token.address:value.address.toLowerCase()!==signal.token.address.toLowerCase()))return true;
  }
  const tokens:unknown[]=[signal.vendorNarrative?.token,narrative.facts?.supplierToken];
  return tokens.some(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)) return false;
    const token=value as Record<string,unknown>;
    if(!Chain.safeParse(token.chain).success||typeof token.address!=='string') return false;
    try {
      const valid=token.chain==='solana'?bs58.decode(token.address).length===32:/^0x[0-9a-fA-F]{40}$/.test(token.address);
      return valid&&(token.chain!==signal.token.chain||(token.chain==='solana'?token.address!==signal.token.address:
        token.address.toLowerCase()!==signal.token.address.toLowerCase()));
    } catch {return false;}
  });
}
export function unknown(reason: string, facts: Record<string, unknown> = {}): Check {
  return {status:'unknown', reasons:[reason], facts, checkedAt:new Date().toISOString()};
}
