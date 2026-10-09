import {z} from 'zod';
import {createHash} from 'node:crypto';
import {Chain,Platform,parseSignal,type Signal} from './types.js';
import {normalizeDebotStory} from './providers/debot-story.js';

const schema=z.object({
  token:z.object({chain:Chain,address:z.string().min(32).max(44)}).strict(),
  sourceUrl:z.url().max(500),
  // The alert time must come from the alert. generated_at is the analysis version time.
  occurredAt:z.iso.datetime({offset:true}),
  sourceEventId:z.string().min(1).max(160).optional(),
  text:z.string().max(12000).default('用户导入的 DeBot 叙事接口响应'),
  claimedPlatform:Platform.optional(),creationTx:z.string().max(100).optional(),
  claim:z.enum(['community','official','unspecified']).default('unspecified'),
  payload:z.unknown(),
}).strict();

export function normalizeDebotImport(input:unknown):Signal {
  const data=schema.parse(input);
  const vendorNarrative=normalizeDebotStory(data.payload,data.token,data.sourceUrl);
  const occurredAt=new Date(data.occurredAt).toISOString();
  const key=createHash('sha256').update(JSON.stringify([data.token.chain,vendorNarrative.token.address,
    occurredAt,vendorNarrative.structured!.historyId])).digest('hex');
  return parseSignal({source:'debot',sourceEventId:data.sourceEventId??`manual-debot-story:${key}`,
    occurredAt,token:data.token,text:data.text,claim:data.claim,vendorNarrative,evidenceUrls:vendorNarrative.evidenceUrls,
    ...(data.claimedPlatform?{claimedPlatform:data.claimedPlatform}:{}),...(data.creationTx?{creationTx:data.creationTx}:{})});
}
