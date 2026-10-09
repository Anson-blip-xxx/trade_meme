import type {Evidence} from '../types.js';

export interface EvidenceDiagnostic {
  operation:'lookup'|'search';
  status:'ok'|'empty'|'unavailable'|'not_configured';
  reason?:string;
  // Valid, unique posts from this operation before cross-operation deduplication and the total cap.
  returned:number;
}

export interface EvidenceReport {
  evidence:Evidence[];
  diagnostics:EvidenceDiagnostic[];
}
