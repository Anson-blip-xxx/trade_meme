import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {z} from 'zod';
import {Chain,Platform,VendorNarrativeSchema,parseSignal,type Chain as ChainName,type Signal} from './types.js';
import {xPostId} from './providers/evidence.js';

export class NotificationError extends Error {
  constructor(public readonly code:string,message:string) {
    super(message);
    this.name='NotificationError';
  }
}

function validAddress(address:string,chain:ChainName):boolean {
  if(chain!=='solana') return /^0x[0-9a-fA-F]{40}$/.test(address);
  try {return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)&&bs58.decode(address).length===32;}
  catch {return false;}
}
const canonicalAddress=(address:string,chain:ChainName)=>chain==='solana'?address:address.toLowerCase();

// This is an operator-supplied notification, not a vendor-authenticated webhook.
// Chain and original occurrence time are mandatory; neither can be inferred safely.
const NotificationSchema=z.object({
  source:z.enum(['debot','gmgn','ave','manual']),
  chain:Chain,
  occurredAt:z.iso.datetime({offset:true}),
  text:z.string().min(1).max(12000).refine(v=>v.trim().length>0,'请提供通知原文'),
  sourceEventId:z.string().min(1).max(160).refine(v=>v.trim().length>0,'事件 ID 不能为空').optional(),
  address:z.string().min(32).max(44).optional(),
  evidenceUrls:z.array(z.url().max(500).refine(url=>!!xPostId(url),'证据链接必须是 https://x.com 或 twitter.com 上的原始帖子 URL')).max(12).optional(),
  claimedPlatform:Platform.optional(),
  creationTx:z.string().max(100).optional(),
  claim:z.enum(['community','official','unspecified']).optional(),
  vendorNarrative:VendorNarrativeSchema.optional(),
}).strict().superRefine((notification,ctx)=>{
  if(notification.address&&!validAddress(notification.address,notification.chain)) {
    ctx.addIssue({code:'custom',path:['address'],message:'请提供所选链的完整合法合约地址'});
  }
});

function addressesIn(text:string,chain:ChainName):string[] {
  // Alphanumeric boundaries prevent accepting a valid prefix of a malformed CA.
  const matches=chain==='solana'
    ?text.match(/(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g)
    :text.match(/(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g);
  return [...new Set((matches??[]).filter(a=>validAddress(a,chain)).map(a=>canonicalAddress(a,chain)))];
}

function postUrlsIn(text:string):string[] {
  const links=text.match(/https?:\/\/[^\s<>"'（）【】「」『』]+/g)??[];
  // Copy/pasted prose and Markdown often place punctuation just after a URL.
  return links.map(url=>url.replace(/[,.;!?，。；！？、:：)\]}]+$/g,''));
}

/** Normalize a copied notification. `source` remains the submitter's claim only. */
export function normalizeNotification(input:unknown):Signal {
  const notification=NotificationSchema.parse(input);
  const candidates=addressesIn(notification.text,notification.chain);
  let address=notification.address&&canonicalAddress(notification.address,notification.chain);
  if(address&&candidates.length&&!candidates.includes(address)) {
    throw new NotificationError('ADDRESS_MISMATCH','填写的地址与通知正文中的合约地址不符，请核对原告警并选择正文中的目标地址。');
  }
  if(!address) {
    if(!candidates.length) throw new NotificationError('ADDRESS_MISSING','通知中没有所选链的完整合法合约地址，请填写 address，不能使用简称或截断地址。');
    if(candidates.length>1) throw new NotificationError('ADDRESS_AMBIGUOUS','通知中存在多个合约地址，请通过 address 明确选择要分析的一个地址。');
    address=candidates[0];
  }
  const occurredAt=new Date(notification.occurredAt).toISOString();
  const ids=new Set<string>();
  for(const url of [...(notification.evidenceUrls??[]),...postUrlsIn(notification.text),
    ...(notification.vendorNarrative?.evidenceUrls??[])]) {
    const id=xPostId(url);
    if(id) ids.add(id);
  }
  const textHash=createHash('sha256').update(notification.text).digest('hex');
  const localHash=createHash('sha256').update(JSON.stringify([
    notification.source,notification.chain,address,occurredAt,textHash,
  ])).digest('hex');
  return parseSignal({
    source:notification.source,
    // This prefix identifies a local deduplication ID, never a DeBot/GMGN event ID.
    sourceEventId:notification.sourceEventId??`manual-import:${localHash}`,
    occurredAt,
    token:{chain:notification.chain,address},
    text:notification.text,
    evidenceUrls:[...ids].map(id=>`https://x.com/i/web/status/${id}`),
    ...(notification.claimedPlatform?{claimedPlatform:notification.claimedPlatform}:{}),
    ...(notification.creationTx?{creationTx:notification.creationTx}:{}),
    ...(notification.claim?{claim:notification.claim}:{}),
    // Keep the supplier's original text/time. Missing update time remains unknown.
    ...(notification.vendorNarrative?{vendorNarrative:notification.vendorNarrative}:{}),
  });
}
