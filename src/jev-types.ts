import type {Chain,Report} from './types.js';

export const JEV_MODEL='jev-1.13.0' as const;
export const JEV_RUBRIC_VERSION='meme-shadow-v1' as const;
/** Local baseline and identities are never part of the outbound model state. */
export interface JevInput {
  reportId:string;token:{chain:Chain;address:string};name?:string;asOf:string;
  baseline:{decision:Report['decision'];hardChecksPassed:boolean;reasons:string[]};
  state:Record<string,unknown>;
}
/** Advisory research priority. Confidence is model distribution confidence, never win probability. */
export interface JevResult {
  score:number|null;confidence:number|null;stance:'support'|'watch'|'avoid'|'insufficient';
  phase:string;dimensions:Record<string,number|null>;reasonCodes:string[];
  model:string;rubricVersion:string;
}
