import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {GmgnError} from './providers/gmgn-client.js';
import {parseSignal, type Chain, type Signal} from './types.js';

// Verified against GMGNAI/gmgn-skills: skills/gmgn-track/SKILL.md and
// src/client/OpenApiClient.ts. These routes query public, platform-tagged trades.
export type GmgnFeedKind = 'kol' | 'smartmoney';
export interface GmgnFeedPage {
  chain:Chain;kind:GmgnFeedKind;payload:unknown;fetchedAt:string;errorReason?:string;
}
export interface GmgnScannerClient {
  get(path:string, query:Record<string,string|number>, weight?:number):Promise<unknown>;
  readonly cooldownUntil?:number;
}
const GMGN_CHAINS:Record<Chain,string> = {bsc:'bsc',solana:'sol',robinhood:'robinhood'};
const PAGE_LIMIT = 100;
const MAX_RECORDS = 200;
const MAX_SEEN = 5_000;
const FUTURE_TOLERANCE_MS = 30_000;
const object = (v:unknown):v is Record<string,unknown> => v!==null && typeof v==='object' && !Array.isArray(v);

function address(value:unknown, chain:Chain, bytes=32):string|undefined {
  if(typeof value!=='string') return;
  if(chain!=='solana') {
    const length=bytes===64?64:40;
    return new RegExp(`^0x[0-9a-fA-F]{${length}}$`).test(value)?value.toLowerCase():undefined;
  }
  if(value.length>88 || value.length<32) return;
  try {if(bs58.decode(value).length===bytes) return value;} catch { /* Reject malformed base58. */ }
}

interface NormalizedTrades {
  signals:Signal[];received:number;rejected:number;duplicates:number;
  invalidReason?:'GMGN_FEED_SCHEMA_INVALID'|'GMGN_FEED_CHAIN_MISMATCH';
}
function normalize(payload:unknown, chain:Chain, now:Date, maxAgeSec:number):NormalizedTrades {
  const result:NormalizedTrades={signals:[],received:0,rejected:0,duplicates:0};
  if(!object(payload)||!Array.isArray(payload.list)) {
    result.invalidReason='GMGN_FEED_SCHEMA_INVALID';return result;
  }
  result.received=payload.list.length;
  const chainMatches=(v:Record<string,unknown>)=>!Object.hasOwn(v,'chain')||v.chain===GMGN_CHAINS[chain];
  if(!chainMatches(payload)) {
    result.invalidReason='GMGN_FEED_CHAIN_MISMATCH';result.rejected=result.received;return result;
  }
  const unique=new Set<string>();
  for(const trade of payload.list.slice(0,MAX_RECORDS)) {
    if(!object(trade)||!chainMatches(trade)||trade.side!=='buy'||
      (object(trade.base_token)&&!chainMatches(trade.base_token))) {result.rejected++;continue;}
    const token=address(trade.base_address,chain),maker=address(trade.maker,chain);
    const transaction=address(trade.transaction_hash,chain,64);
    // Unix seconds only; never substitute fetch time or infer milliseconds.
    const timestamp=typeof trade.timestamp==='number'?trade.timestamp:
      typeof trade.timestamp==='string'&&/^\d{1,11}$/.test(trade.timestamp)?Number(trade.timestamp):NaN;
    const eventMs=timestamp*1_000;
    if(!token||!maker||!transaction||!Number.isSafeInteger(timestamp)||timestamp<=0||
      eventMs>now.getTime()+FUTURE_TOLERANCE_MS||eventMs<now.getTime()-maxAgeSec*1_000) {
      result.rejected++;continue;
    }
    const sourceEventId='gmgn:trade:'+createHash('sha256')
      .update(JSON.stringify([chain,transaction,maker,token,'buy'])).digest('hex');
    if(unique.has(sourceEventId)) {result.duplicates++;continue;}
    unique.add(sourceEventId);
    // Identical records in KOL and smart-money feeds must have identical content,
    // so the persistent ingest layer can safely use sourceEventId for idempotency.
    result.signals.push(parseSignal({source:'gmgn',sourceEventId,token:{chain,address:token},
      occurredAt:new Date(eventMs).toISOString(),
      text:`GMGN 链上买入记录；交易 ${transaction}；钱包 ${maker}；CA ${token}。平台标签本身不证明名人身份、官方发行或买入价值。`,
      evidenceUrls:[],claim:'unspecified'}));
  }
  result.rejected+=Math.max(0,payload.list.length-MAX_RECORDS);
  return result;
}

/** Accepts unwrapped GMGN data: {list:[...]}; never follows pagination. */
export function normalizeGmgnTrades(payload:unknown, chain:Chain, kind:GmgnFeedKind,
  options:{now?:Date;maxAgeSec?:number}={}):Signal[] {
  const now=options.now??new Date(),maxAgeSec=options.maxAgeSec??600;
  if(!Object.hasOwn(GMGN_CHAINS,chain)||!['kol','smartmoney'].includes(kind)||
    !Number.isFinite(now.getTime())||!Number.isInteger(maxAgeSec)||maxAgeSec<1||maxAgeSec>86_400) return [];
  return normalize(payload,chain,now,maxAgeSec).signals;
}

export interface ScannerDiagnostic {
  chain:Chain;kind:GmgnFeedKind;
  status:'ok'|'empty'|'invalid_response'|'unavailable'|'rate_limited';
  received:number;accepted:number;reason?:string;cooldownUntil?:string;
}
export interface ScannerCycleReport {
  status:'ok'|'partial'|'cooldown'|'stopped';
  startedAt:string;completedAt:string;
  requests:number;received:number;accepted:number;rejected:number;emitted:number;
  duplicates:number;deferred:number;errors:number;
  reasons:string[];diagnostics:ScannerDiagnostic[];cooldownUntil?:string;
}
export interface GmgnScannerOptions {
  client:GmgnScannerClient;chains:Chain[];intervalMs:number;maxAgeSec:number;
  maxSignalsPerCycle?:number;onSignal:(signal:Signal)=>unknown|Promise<unknown>;now?:()=>Date;
  /** Observational only: receives every fetched page before buy/age/dedup/research-cap filters. */
  onFeed?:(page:GmgnFeedPage)=>unknown|Promise<unknown>;
}
export interface GmgnScannerStatus {
  running:boolean;inFlight:boolean;seenEntries:number;cooldownUntil?:string;lastCycle?:ScannerCycleReport;
}

/** Read-only polling. Callbacks run in sequence; this class never places orders. */
export class GmgnScanner {
  private readonly client:GmgnScannerClient;
  private readonly routes:{chain:Chain;kind:GmgnFeedKind}[];
  private readonly intervalMs:number;
  private readonly maxAgeSec:number;
  private readonly maxSignals:number;
  private readonly onSignal:GmgnScannerOptions['onSignal'];
  private readonly onFeed:GmgnScannerOptions['onFeed'];
  private readonly now:()=>Date;
  private readonly seen=new Map<string,number>();
  private running=false;
  private generation=0;
  private cursor=0;
  private cooldownUntil=0;
  private timer?:ReturnType<typeof setTimeout>;
  private inFlight?:Promise<ScannerCycleReport>;
  private lastCycle?:ScannerCycleReport;

  constructor(options:GmgnScannerOptions) {
    const maxSignals=options.maxSignalsPerCycle??3;
    if(!Array.isArray(options.chains)||options.chains.length===0||
      options.chains.some(chain=>!Object.hasOwn(GMGN_CHAINS,chain))||
      !Number.isSafeInteger(options.intervalMs)||options.intervalMs<1||options.intervalMs>3_600_000||
      !Number.isInteger(options.maxAgeSec)||options.maxAgeSec<1||options.maxAgeSec>86_400||
      !Number.isInteger(maxSignals)||maxSignals<1||maxSignals>200) throw new Error('GMGN_SCANNER_CONFIG_INVALID');
    this.client=options.client;this.intervalMs=options.intervalMs;this.maxAgeSec=options.maxAgeSec;
    this.maxSignals=maxSignals;this.onSignal=options.onSignal;this.onFeed=options.onFeed;this.now=options.now??(()=>new Date());
    this.routes=[...new Set(options.chains)].flatMap(chain=>
      (['kol','smartmoney'] as const).map(kind=>({chain,kind})));
  }

  getStatus():GmgnScannerStatus {
    this.prune();
    this.readClientCooldown();
    return {running:this.running,inFlight:!!this.inFlight,seenEntries:this.seen.size,
      ...(this.cooldownUntil>this.now().getTime()?{cooldownUntil:new Date(this.cooldownUntil).toISOString()}:{}),
      ...(this.lastCycle?{lastCycle:structuredClone(this.lastCycle)}:{})};
  }

  /** Concurrent callers share one operation, including its sequential callbacks. */
  runOnce():Promise<ScannerCycleReport> {
    if(this.inFlight) return this.inFlight;
    const cycle=this.executeCycle(this.generation);
    this.inFlight=cycle;
    void cycle.then(report=>{
      this.lastCycle=report;
      if(this.inFlight===cycle) this.inFlight=undefined;
    },()=>{if(this.inFlight===cycle) this.inFlight=undefined;});
    return cycle;
  }

  start():void {
    if(this.running) return;
    this.running=true;
    this.tick();
  }

  /** In-flight GETs cannot be unsent; their remaining work is discarded. */
  stop():void {
    this.running=false;this.generation++;
    if(this.timer) clearTimeout(this.timer);
    this.timer=undefined;
  }

  private tick():void {
    if(!this.running) return;
    const generation=this.generation;
    void this.runOnce().catch(()=>{}).finally(()=>{
      if(!this.running||generation!==this.generation) return;
      this.readClientCooldown();
      const wait=Math.max(this.intervalMs,this.cooldownUntil-this.now().getTime());
      // Long vendor cooldowns are rechecked without exceeding Node's timer range.
      this.timer=setTimeout(()=>this.tick(),Math.min(wait,2_147_483_647));
      this.timer.unref();
    });
  }

  private prune():void {
    const now=this.now().getTime();
    for(const [id,expiresAt] of this.seen) if(expiresAt<now) this.seen.delete(id);
  }

  private readClientCooldown():void {
    const value=this.client.cooldownUntil;
    if(typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=8.64e15)
      this.cooldownUntil=Math.max(this.cooldownUntil,value);
  }

  private async executeCycle(generation:number):Promise<ScannerCycleReport> {
    const startedAt=this.now().toISOString();
    const report:ScannerCycleReport={status:'ok',startedAt,completedAt:startedAt,requests:0,received:0,
      accepted:0,rejected:0,emitted:0,duplicates:0,deferred:0,errors:0,reasons:[],diagnostics:[]};
    this.prune();
    this.readClientCooldown();
    const finish=()=>{
      if(generation!==this.generation) report.status='stopped';
      else if(report.status==='ok'&&report.errors) report.status='partial';
      report.completedAt=this.now().toISOString();
      if(this.cooldownUntil>this.now().getTime()) report.cooldownUntil=new Date(this.cooldownUntil).toISOString();
      return report;
    };
    if(this.cooldownUntil>this.now().getTime()) {
      report.status='cooldown';report.reasons.push('GMGN_RATE_LIMITED');return finish();
    }
    const candidates:Signal[]=[];
    const unique=new Set<string>();
    // Rotate the first feed so the callback cap cannot permanently favour one chain.
    const offset=this.cursor++%this.routes.length;
    for(let i=0;i<this.routes.length;i++) {
      if(generation!==this.generation) break;
      const {chain,kind}=this.routes[(offset+i)%this.routes.length];
      try {
        report.requests++;
        const payload=await this.client.get(`/v1/user/${kind}`,{chain:GMGN_CHAINS[chain],limit:PAGE_LIMIT},1);
        if(generation!==this.generation) break;
        if(this.onFeed) {
          try {await this.onFeed({chain,kind,payload:structuredClone(payload),fetchedAt:this.now().toISOString()});}
          catch {report.errors++;if(!report.reasons.includes('GMGN_FEED_OBSERVATION_FAILED')) report.reasons.push('GMGN_FEED_OBSERVATION_FAILED');}
          if(generation!==this.generation) break;
        }
        const result=normalize(payload,chain,this.now(),this.maxAgeSec);
        report.received+=result.received;report.rejected+=result.rejected;report.duplicates+=result.duplicates;
        report.accepted+=result.signals.length;
        report.diagnostics.push({chain,kind,status:result.invalidReason?'invalid_response':result.signals.length?'ok':'empty',
          received:result.received,accepted:result.signals.length,...(result.invalidReason?{reason:result.invalidReason}:{})});
        if(result.invalidReason) report.errors++;
        for(const signal of result.signals) {
          if(unique.has(signal.sourceEventId)||this.seen.has(signal.sourceEventId)) {report.duplicates++;continue;}
          unique.add(signal.sourceEventId);candidates.push(signal);
        }
      } catch(error) {
        // Only locally defined, fixed error codes may leave this boundary.
        const reason=error instanceof GmgnError?error.reason:'GMGN_REQUEST_FAILED';
        if(this.onFeed&&generation===this.generation) {
          try {await this.onFeed({chain,kind,payload:undefined,fetchedAt:this.now().toISOString(),errorReason:reason});}
          catch {report.errors++;if(!report.reasons.includes('GMGN_FEED_OBSERVATION_FAILED')) report.reasons.push('GMGN_FEED_OBSERVATION_FAILED');}
        }
        const limited=reason==='GMGN_RATE_LIMITED';
        report.errors++;
        if(limited) {
          const expiry=error instanceof GmgnError&&error.cooldownUntil?Date.parse(error.cooldownUntil):NaN;
          const now=this.now().getTime();
          this.cooldownUntil=Math.max(this.cooldownUntil,Number.isFinite(expiry)&&expiry>now?expiry:now+60_000);
          report.status='cooldown';report.reasons.push('GMGN_RATE_LIMITED');
        }
        report.diagnostics.push({chain,kind,status:limited?'rate_limited':'unavailable',received:0,accepted:0,reason,
          ...(limited?{cooldownUntil:new Date(this.cooldownUntil).toISOString()}:{})});
        // Missing/invalid credentials apply to every route; do not repeat those calls.
        if(limited||reason==='GMGN_API_KEY_MISSING'||reason==='GMGN_AUTH_FAILED') break;
      }
    }
    if(report.status==='cooldown') {report.deferred=candidates.length;return finish();}
    let attempted=0;
    for(const signal of candidates) {
      if(generation!==this.generation) {report.deferred++;continue;}
      this.readClientCooldown();
      if(this.cooldownUntil>this.now().getTime()) {
        report.status='cooldown';report.deferred++;
        if(!report.reasons.includes('GMGN_RATE_LIMITED')) report.reasons.push('GMGN_RATE_LIMITED');
        continue;
      }
      if(attempted>=this.maxSignals) {report.deferred++;continue;}
      // Fetching and earlier callbacks may have consumed the remaining event lifetime.
      if(Date.parse(signal.occurredAt)<this.now().getTime()-this.maxAgeSec*1_000) {report.rejected++;continue;}
      this.prune();
      if(this.seen.size>=MAX_SEEN) {
        report.deferred++;
        if(!report.reasons.includes('GMGN_DEDUP_CAPACITY')) report.reasons.push('GMGN_DEDUP_CAPACITY');
        continue;
      }
      attempted++;
      try {
        await this.onSignal(signal);
        this.seen.set(signal.sourceEventId,Date.parse(signal.occurredAt)+this.maxAgeSec*1_000);
        report.emitted++;
      } catch {
        report.errors++;
        if(!report.reasons.includes('GMGN_SIGNAL_CALLBACK_FAILED')) report.reasons.push('GMGN_SIGNAL_CALLBACK_FAILED');
        // Failed callbacks are retried next cycle, at most once per event per cycle.
      }
    }
    return finish();
  }
}
