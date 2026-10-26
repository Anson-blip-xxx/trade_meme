import type {Config} from '../config.js';
import type {NativePositionState} from './positions.js';
import type {NativeTradingRuntime} from './runtime.js';
import type {TradeNotificationEvent} from '../trade-notifications.js';

export type NativeWorkerConfig=Pick<Config,'nativeSolana'|'entryWallets'|'entrySlippagePct'|'ordersDatabase'> & {summaryIntervalMs?:number};
export interface NativeWorkerSnapshot {
  at:number;sequence:number;pid:number;status:ReturnType<NativeTradingRuntime['status']>;positions:NativePositionState[];
}
export type NativeParentMessage=
  |{kind:'init';config:NativeWorkerConfig;storePath:string;guardTimeoutMs:number}
  |{kind:'call';id:string;method:'execute';orderId:string}
  |{kind:'call';id:string;method:'submit';ref:string;percent:number}
  |{kind:'guard_result';id:string;ok:boolean;error?:string}
  |{kind:'snapshot_ack';sequence:number}
  |{kind:'notice_ack';key:string}
  |{kind:'order_ack';orderId:string;version:string}
  |{kind:'stop'};
export type NativeWorkerMessage=
  |{kind:'snapshot';value:NativeWorkerSnapshot}
  |{kind:'result';id:string;ok:boolean;value?:unknown;error?:string}
  |{kind:'guard';id:string;callId:string;deadline:number}
  |{kind:'notice';event:TradeNotificationEvent}
  |{kind:'order';orderId:string;version:string}
  |{kind:'fatal';error:string}
  |{kind:'stopped'};
export const safeProcessError=(error:unknown,fallback='NATIVE_WORKER_UNAVAILABLE')=>error instanceof Error&&/^[A-Z][A-Z0-9_]{0,119}$/.test(error.message)?error.message:fallback;
export const isProtocolMessage=(v:unknown):v is {kind:string}=>!!v&&typeof v==='object'&&'kind' in v&&typeof v.kind==='string';
