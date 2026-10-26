/** Durations are diagnostic only and never authorize, retry, or sign a trade. */
export const NATIVE_EXECUTION_STAGES=['chainCheck','plan','tipAccount','blockhash','compile','feeCheck','balanceCheck',
  'simulation','broadcastQueue','finalGuard','sign','journalBeforeSend','broadcastRpc'] as const;
export type NativeExecutionStage=typeof NATIVE_EXECUTION_STAGES[number];
export interface NativeExecutionTiming {
  version:1;startedAt:string;
  /** Monotonic elapsed milliseconds for the first attempt of each stage, including a failed attempt. */
  stagesMs:Partial<Record<NativeExecutionStage,number>>;
  broadcastStartedAt?:string;acknowledgedAt?:string;submittedAfterMs?:number;
  /** First local observation of a verified receipt; includes polling and network delay,
   * and is not a precise timestamp of the transaction taking effect on chain. */
  confirmedObservedAt?:string;confirmedAfterMs?:number;
  finalizedObservedAt?:string;finalizedAfterMs?:number;
  /** Wall-clock totals cannot be compared if the clock moved backwards. Individual
   * stages remain monotonic; an invalid monotonic test clock also sets this flag. */
  clockInvalid?:true;
}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const timestamp=(value:unknown):number=>typeof value==='string'&&value.length<=32?Date.parse(value):NaN;
const iso=(value:unknown):value is string=>{const time=timestamp(value);return Number.isFinite(time)&&new Date(time).toISOString()===value;};
const elapsed=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

export function createNativeTiming(startedAt:string):NativeExecutionTiming {return {version:1,startedAt,stagesMs:{}};}
export function recordNativeStage(timing:NativeExecutionTiming|undefined,stage:NativeExecutionStage,start:number,end:number):void {
  if(!timing||timing.stagesMs[stage]!==undefined)return;
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start){timing.clockInvalid=true;return;}
  timing.stagesMs[stage]=end-start;
}

/** All *AfterMs totals use wall time so they remain meaningful across recovery.
 * First observation timestamps are immutable even if a later poll has a newer time. */
export function observeNativeTiming(timing:NativeExecutionTiming|undefined,event:'broadcast'|'acknowledged'|'confirmed'|'finalized',at:Date):void {
  if(!timing)return;
  const name=event==='broadcast'?'broadcastStartedAt':event==='acknowledged'?'acknowledgedAt':event==='confirmed'?'confirmedObservedAt':'finalizedObservedAt';
  if(timing[name]!==undefined)return;
  const now=at.getTime();if(!Number.isFinite(now)){timing.clockInvalid=true;return;}
  timing[name]=at.toISOString();
  const start=timestamp(timing.startedAt),previous=event==='acknowledged'?timing.broadcastStartedAt:
    event==='confirmed'?timing.acknowledgedAt:event==='finalized'?timing.confirmedObservedAt:undefined;
  if(!Number.isFinite(start)||now<start||previous!==undefined&&now<timestamp(previous)){timing.clockInvalid=true;return;}
  if(event==='acknowledged')timing.submittedAfterMs=now-start;
  if(event==='confirmed')timing.confirmedAfterMs=now-start;
  if(event==='finalized')timing.finalizedAfterMs=now-start;
}

/** Whitelist projection: journal extensions, signed bytes and arbitrary fields can
 * never leak into an HTTP/TG result through the timing object. */
export function publicNativeTiming(value:unknown):NativeExecutionTiming|undefined {
  if(!object(value)||value.version!==1||!iso(value.startedAt)||!object(value.stagesMs))return;
  const result=createNativeTiming(value.startedAt);
  for(const stage of NATIVE_EXECUTION_STAGES)if(elapsed(value.stagesMs[stage]))result.stagesMs[stage]=value.stagesMs[stage];
  if(value.clockInvalid===true)result.clockInvalid=true;
  const start=timestamp(result.startedAt);
  for(const name of ['broadcastStartedAt','acknowledgedAt','confirmedObservedAt','finalizedObservedAt'] as const){
    if(!iso(value[name]))continue;result[name]=value[name];
    if(timestamp(value[name])<start)result.clockInvalid=true;
  }
  for(const [name,observed,previous] of [
    ['submittedAfterMs','acknowledgedAt','broadcastStartedAt'],
    ['confirmedAfterMs','confirmedObservedAt','acknowledgedAt'],
    ['finalizedAfterMs','finalizedObservedAt','confirmedObservedAt'],
  ] as const){
    const end=timestamp(result[observed]),prior=result[previous]===undefined?start:timestamp(result[previous]);
    if(Number.isFinite(end)&&end<prior)result.clockInvalid=true;
    if(elapsed(value[name])&&Number.isFinite(end)&&end>=start&&end>=prior&&value[name]===end-start)result[name]=value[name];
  }
  return result;
}

/** Existing timing is append-only, like the immutable original transaction bytes.
 * A legacy record cannot acquire reconstructed timestamps after the fact. */
export function assertNativeTimingPreserved(old:NativeExecutionTiming|undefined,next:NativeExecutionTiming|undefined):void {
  if(!old){if(next)throw Error('NATIVE_TIMING_IMMUTABLE');return;}
  if(!next||old.version!==next.version||old.startedAt!==next.startedAt)throw Error('NATIVE_TIMING_IMMUTABLE');
  for(const stage of NATIVE_EXECUTION_STAGES)if(old.stagesMs[stage]!==undefined&&next.stagesMs[stage]!==old.stagesMs[stage])throw Error('NATIVE_TIMING_IMMUTABLE');
  for(const name of ['broadcastStartedAt','acknowledgedAt','submittedAfterMs','confirmedObservedAt','confirmedAfterMs',
    'finalizedObservedAt','finalizedAfterMs','clockInvalid'] as const)
    if(old[name]!==undefined&&next[name]!==old[name])throw Error('NATIVE_TIMING_IMMUTABLE');
}
