/** Public JSON-RPC WebSocket transport. No price interpretation, transaction signing, or order submission. */
export interface RpcSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

export interface RpcStreamClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RpcSubscription {
  key: string;
  subscribeMethod: string;
  params: readonly unknown[];
  unsubscribeMethod: string;
  notificationMethod: string;
}

export type RpcHeartbeat =
  | {mode?: 'request'; method: string; params?: readonly unknown[]; intervalMs: number; timeoutMs?: number}
  | {mode: 'message_idle'; intervalMs: number; timeoutMs: number};

export type RpcStreamErrorCode = 'RPC_CONFIG_INVALID' | 'RPC_SUBSCRIPTION_INVALID' | 'RPC_REQUEST_INVALID' |
  'RPC_NOT_OPEN' | 'RPC_STOPPED' | 'RPC_CONNECT_FAILED' | 'RPC_CONNECT_TIMEOUT' | 'RPC_CONNECTION_CLOSED' |
  'RPC_CONNECTION_ERROR' | 'RPC_SEND_FAILED' | 'RPC_REQUEST_TIMEOUT' | 'RPC_REMOTE_ERROR' |
  'RPC_MESSAGE_INVALID' | 'RPC_MESSAGE_TOO_LARGE' | 'RPC_PENDING_LIMIT' | 'RPC_SUBSCRIBE_FAILED' |
  'RPC_SUBSCRIPTION_ID_INVALID' | 'RPC_SUBSCRIPTION_ID_CONFLICT' | 'RPC_UNSUBSCRIBE_FAILED' |
  'RPC_HEARTBEAT_TIMEOUT' | 'RPC_CONSUMER_ERROR' | 'RPC_RECONNECT_REQUESTED' | 'RPC_CHAIN_IDENTITY_MISMATCH';

/** Upstream URL, response text and raw exceptions must never become error messages. */
export class RpcStreamError extends Error {
  constructor(readonly code: RpcStreamErrorCode) {super(code); this.name = 'RpcStreamError';}
}

export interface RpcNotificationMeta {
  receivedAt: number;
  /** Monotonic timestamp at the WebSocket message handler entrance, before JSON decoding. */
  receivedMonoAt?:number;
  generation: number;
  subscriptionId: string | number;
}

export interface RpcStreamStatus {
  state: 'stopped' | 'connecting' | 'open' | 'backoff';
  generation: number;
  desiredSubscriptions: number;
  activeSubscriptions: number;
  activeKeys: string[];
  pendingRequests: number;
  /** Subscription requests sent but not yet acknowledged. */
  subscribingSubscriptions?: number;
  /** Desired revisions waiting for an acknowledgement-window slot. */
  queuedSubscriptions?: number;
  maxConcurrentSubscriptions?: number;
  peakConcurrentSubscriptions?: number;
  /** Unsubscribe requests sent but not yet acknowledged. */
  unsubscribingSubscriptions?:number;
  /** Retired subscriptions waiting for an unsubscribe-window slot. */
  queuedUnsubscriptions?:number;
  maxConcurrentUnsubscriptions?:number;
  peakConcurrentUnsubscriptions?:number;
  /** Explicit server rejections waiting for an isolated retry. */
  retryingSubscriptions?: number;
  /** Cumulative isolated retries; ambiguous failures still reconnect the socket. */
  subscriptionRetries?: number;
  /** Timed-out subscription requests still eligible for a same-generation late ACK. */
  lateSubscriptionAcksPending?:number;
  /** Cumulative late subscription responses matched to a retained tombstone. */
  lateSubscriptionAcksReceived?:number;
  /** Cumulative valid late IDs sent through the independent unsubscribe queue. */
  lateSubscriptionAcksRetired?:number;
  /** Late ACKs whose ID is already the current active subscription and must be preserved. */
  lateSubscriptionAcksMatchedActive?:number;
  /** Tombstone-capacity exhaustion forces a reconnect so unknown remote subscriptions are discarded. */
  lateSubscriptionAckOverflows?:number;
  maxLateSubscriptionAcks?:number;
  reconnectAttempt: number;
  reconnects: number;
  requestsSent: number;
  messagesReceived: number;
  notificationsReceived: number;
  connectedAt?: number;
  lastMessageAt?: number;
  lastHeartbeatAt?: number;
  nextReconnectAt?: number;
  lastError?: RpcStreamErrorCode;
}

export interface RpcStreamOptions {
  url: string;
  socketFactory?: (url: string) => RpcSocket;
  clock?: RpcStreamClock;
  random?: () => number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxMessageBytes?: number;
  maxSubscriptions?: number;
  /** Bound subscription requests; ordinary RPC requests remain independent. */
  maxConcurrentSubscriptions?: number;
  /** Bound unsubscribe requests during large target rotations. */
  maxConcurrentUnsubscriptions?:number;
  /** Retry explicit JSON-RPC subscription rejections without discarding healthy subscriptions. */
  retryRejectedSubscriptions?: boolean;
  /** Retry a bounded number of ambiguous subscription ACK timeouts in place. */
  retryTimedOutSubscriptions?:boolean;
  maxPendingRequests?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeat?: RpcHeartbeat;
  onNotification: (key: string, result: unknown, meta: RpcNotificationMeta) => void;
  onStatus?: (status: RpcStreamStatus) => void;
}

interface Desired extends RpcSubscription {revision: number; fingerprint: string;}
interface Active {desired: Desired; id: string | number; generation: number;}
interface Subscribing {desired: Desired; generation: number;}
interface SubscriptionRetry {desired: Desired; generation: number; attempt: number; timer?: unknown;}
interface LateSubscriptionAck {desired:Desired;generation:number;}
interface Pending {
  generation: number;
  timer: unknown;
  resolve(value: unknown): void;
  reject(error: RpcStreamError): void;
  onResult?: (result: unknown) => void;
  lateSubscription?:Desired;
}
interface Connection {socket: RpcSocket; generation: number; listeners: [string, (event: any) => void][];}

const nativeClock: RpcStreamClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => {const timer = setTimeout(callback, delay); timer.unref(); return timer;},
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const methodValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const idValid = (value: unknown): value is string | number =>
  typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0 :
    typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
const idKey = (id: string | number) => `${typeof id}:${id}`;
const boundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function copyParams(input: unknown): unknown[] {
  let nodes = 0;
  const check = (value: unknown, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 20) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(item => check(item, depth + 1));
    if (record(value) && Object.getPrototypeOf(value) === Object.prototype)
      return Object.values(value).every(item => check(item, depth + 1));
    return false;
  };
  try {
    if (!Array.isArray(input) || !check(input, 0)) throw new Error();
    return JSON.parse(JSON.stringify(input)) as unknown[];
  } catch {throw new RpcStreamError('RPC_REQUEST_INVALID');}
}

export class RpcStream {
  private readonly url: string;
  private readonly factory: (url: string) => RpcSocket;
  private readonly clock: RpcStreamClock;
  private readonly random: () => number;
  private readonly timeout: number;
  private readonly connectTimeout: number;
  private readonly maxBytes: number;
  private readonly maxSubscriptions: number;
  private readonly maxConcurrentSubscriptions: number;
  private readonly maxConcurrentUnsubscriptions:number;
  private readonly maxLateSubscriptionAcks:number;
  private readonly retryRejectedSubscriptions: boolean;
  private readonly retryTimedOutSubscriptions:boolean;
  private readonly maxPending: number;
  private readonly reconnectBase: number;
  private readonly reconnectMax: number;
  private readonly heartbeat?: RpcHeartbeat;
  private readonly onNotification: RpcStreamOptions['onNotification'];
  private readonly onStatus?: RpcStreamOptions['onStatus'];
  private readonly desired = new Map<string, Desired>();
  private readonly active = new Map<string, Active>();
  private readonly activeIds = new Map<string, Active>();
  private readonly retiredIds = new Set<string>();
  private readonly subscribing = new Set<Subscribing>();
  private readonly unsubscribeQueue=new Map<string,Active>();
  private readonly unsubscribing=new Map<string,Active>();
  private readonly subscriptionRetryState = new Map<string,SubscriptionRetry>();
  private readonly lateSubscriptionAcks=new Map<number,LateSubscriptionAck>();
  private readonly pending = new Map<number, Pending>();
  private connection?: Connection;
  private connectTimer?: unknown;
  private reconnectTimer?: unknown;
  private heartbeatTimer?: unknown;
  private running = false;
  private generation = 0;
  private revision = 0;
  private sequence = 0;
  private state: RpcStreamStatus['state'] = 'stopped';
  private reconnectAttempt = 0;
  private reconnects = 0;
  private requestsSent = 0;
  private messagesReceived = 0;
  private notificationsReceived = 0;
  private peakConcurrentSubscriptions = 0;
  private peakConcurrentUnsubscriptions=0;
  private subscriptionRetries = 0;
  private lateSubscriptionAcksReceived=0;
  private lateSubscriptionAcksRetired=0;
  private lateSubscriptionAcksMatchedActive=0;
  private lateSubscriptionAckOverflows=0;
  private connectedAt?: number;
  private lastMessageAt?: number;
  private lastHeartbeatAt?: number;
  private nextReconnectAt?: number;
  private lastError?: RpcStreamErrorCode;

  constructor(options: RpcStreamOptions) {
    try {
      const url = new URL(options.url);
      if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname ||
          options.url.length > 4096 || typeof options.onNotification !== 'function') throw new Error();
    } catch {throw new RpcStreamError('RPC_CONFIG_INVALID');}
    this.url = options.url;
    this.factory = options.socketFactory ?? (url => new WebSocket(url));
    this.clock = options.clock ?? nativeClock;
    this.random = options.random ?? Math.random;
    this.timeout = options.requestTimeoutMs ?? 10_000;
    this.connectTimeout = options.connectTimeoutMs ?? 15_000;
    this.maxBytes = options.maxMessageBytes ?? 1_048_576;
    this.maxSubscriptions = options.maxSubscriptions ?? 200;
    this.maxConcurrentSubscriptions = options.maxConcurrentSubscriptions ?? this.maxSubscriptions;
    this.maxConcurrentUnsubscriptions=options.maxConcurrentUnsubscriptions??this.maxSubscriptions;
    this.maxLateSubscriptionAcks=Math.min(4096,this.maxSubscriptions*3);
    this.retryRejectedSubscriptions = options.retryRejectedSubscriptions ?? false;
    this.retryTimedOutSubscriptions=options.retryTimedOutSubscriptions??false;
    this.maxPending = options.maxPendingRequests ?? 512;
    this.reconnectBase = options.reconnectBaseMs ?? 1000;
    this.reconnectMax = options.reconnectMaxMs ?? 30_000;
    if (!boundedInteger(this.timeout, 1, 300_000) || !boundedInteger(this.connectTimeout, 1, 300_000) ||
        !boundedInteger(this.maxBytes, 128, 8_388_608) || !boundedInteger(this.maxSubscriptions, 1, 2000) ||
        !boundedInteger(this.maxConcurrentSubscriptions, 1, this.maxSubscriptions) ||
        !boundedInteger(this.maxConcurrentUnsubscriptions,1,this.maxSubscriptions)||
        typeof this.retryRejectedSubscriptions !== 'boolean' ||
        typeof this.retryTimedOutSubscriptions!=='boolean'||
        !boundedInteger(this.maxPending, 1, 4096) || !boundedInteger(this.reconnectBase, 1, 300_000) ||
        !boundedInteger(this.reconnectMax, this.reconnectBase, 3_600_000)) throw new RpcStreamError('RPC_CONFIG_INVALID');
    if (options.heartbeat) {
      const h = options.heartbeat;
      if (!boundedInteger(h.intervalMs, 1, 300_000) || h.timeoutMs !== undefined && !boundedInteger(h.timeoutMs, 1, 300_000))
        throw new RpcStreamError('RPC_CONFIG_INVALID');
      if (h.mode === 'message_idle') this.heartbeat = {...h};
      else {
        if (h.mode !== undefined && h.mode !== 'request' || !methodValid(h.method)) throw new RpcStreamError('RPC_CONFIG_INVALID');
        try {this.heartbeat = {...h, params: copyParams(h.params ?? [])};}
        catch {throw new RpcStreamError('RPC_CONFIG_INVALID');}
      }
    }
    this.onNotification = options.onNotification;
    this.onStatus = options.onStatus;
  }

  getStatus(): RpcStreamStatus {
    return {state: this.state, generation: this.generation, desiredSubscriptions: this.desired.size,
      activeSubscriptions: this.active.size, activeKeys: [...this.active.keys()].sort(), pendingRequests: this.pending.size,
      subscribingSubscriptions: this.subscribing.size, queuedSubscriptions: this.queuedSubscriptions(),
      maxConcurrentSubscriptions: this.maxConcurrentSubscriptions,peakConcurrentSubscriptions:this.peakConcurrentSubscriptions,
      unsubscribingSubscriptions:this.unsubscribing.size,queuedUnsubscriptions:this.unsubscribeQueue.size,
      maxConcurrentUnsubscriptions:this.maxConcurrentUnsubscriptions,
      peakConcurrentUnsubscriptions:this.peakConcurrentUnsubscriptions,
      retryingSubscriptions:[...this.subscriptionRetryState.values()].filter(value=>value.timer!==undefined).length,
      subscriptionRetries:this.subscriptionRetries,
      lateSubscriptionAcksPending:this.lateSubscriptionAcks.size,
      lateSubscriptionAcksReceived:this.lateSubscriptionAcksReceived,
      lateSubscriptionAcksRetired:this.lateSubscriptionAcksRetired,
      lateSubscriptionAcksMatchedActive:this.lateSubscriptionAcksMatchedActive,
      lateSubscriptionAckOverflows:this.lateSubscriptionAckOverflows,
      maxLateSubscriptionAcks:this.maxLateSubscriptionAcks,
      reconnectAttempt: this.reconnectAttempt, reconnects: this.reconnects, requestsSent: this.requestsSent,
      messagesReceived: this.messagesReceived, notificationsReceived: this.notificationsReceived,
      ...(this.connectedAt === undefined ? {} : {connectedAt: this.connectedAt}),
      ...(this.lastMessageAt === undefined ? {} : {lastMessageAt: this.lastMessageAt}),
      ...(this.lastHeartbeatAt === undefined ? {} : {lastHeartbeatAt: this.lastHeartbeatAt}),
      ...(this.nextReconnectAt === undefined ? {} : {nextReconnectAt: this.nextReconnectAt}),
      ...(this.lastError ? {lastError: this.lastError} : {})};
  }

  start(): void {
    if (this.running) return;
    this.running = true; this.reconnectAttempt = 0; this.connect();
  }

  stop(): void {
    this.running = false; this.generation++;
    this.clearTimer('reconnectTimer'); this.nextReconnectAt = undefined;
    this.disconnect('RPC_STOPPED'); this.state = 'stopped'; this.emitStatus();
  }

  forceReconnect(reason: 'RPC_RECONNECT_REQUESTED' | 'RPC_CHAIN_IDENTITY_MISMATCH' = 'RPC_RECONNECT_REQUESTED'): void {
    const safeReason = reason === 'RPC_CHAIN_IDENTITY_MISMATCH' ? reason : 'RPC_RECONNECT_REQUESTED';
    if (this.running && this.connection) this.fail(safeReason);
  }

  setSubscriptions(subscriptions: readonly RpcSubscription[]): void {
    if (!Array.isArray(subscriptions) || subscriptions.length > this.maxSubscriptions) throw new RpcStreamError('RPC_SUBSCRIPTION_INVALID');
    const next = new Map<string, Desired>();
    for (const raw of subscriptions) {
      if (!record(raw) || typeof raw.key !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(raw.key) || next.has(raw.key) ||
          !methodValid(raw.subscribeMethod) || !methodValid(raw.unsubscribeMethod) || !methodValid(raw.notificationMethod))
        throw new RpcStreamError('RPC_SUBSCRIPTION_INVALID');
      let params: unknown[];
      try {params = copyParams(raw.params);} catch {throw new RpcStreamError('RPC_SUBSCRIPTION_INVALID');}
      const spec = {key: raw.key, subscribeMethod: raw.subscribeMethod, params,
        unsubscribeMethod: raw.unsubscribeMethod, notificationMethod: raw.notificationMethod};
      const fingerprint = JSON.stringify(spec);
      if (Buffer.byteLength(fingerprint) > this.maxBytes - 64) throw new RpcStreamError('RPC_SUBSCRIPTION_INVALID');
      const old = this.desired.get(raw.key);
      next.set(raw.key, old?.fingerprint === fingerprint ? old : {...spec, fingerprint, revision: ++this.revision});
    }
    this.desired.clear(); for (const [key, value] of next) this.desired.set(key, value);
    for(const [key,retry] of this.subscriptionRetryState)if(next.get(key)?.revision!==retry.desired.revision)
      this.clearSubscriptionRetry(key);
    for (const [key, active] of this.active) {
      if (next.get(key)?.revision !== active.desired.revision) this.retire(active);
    }
    if (this.state === 'open') this.pumpSubscriptions();
    this.emitStatus();
  }

  upsertSubscription(subscription: RpcSubscription): void {
    const next: RpcSubscription[] = [...this.desired.values()].filter(item => item.key !== subscription?.key);
    next.push(subscription);
    this.setSubscriptions(next);
  }

  removeSubscription(key: string): void {this.setSubscriptions([...this.desired.values()].filter(item => item.key !== key));}

  request<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    return this.sendRequest(method, params, this.timeout) as Promise<T>;
  }

  private connect(): void {
    if (!this.running) return;
    this.clearTimer('reconnectTimer'); this.nextReconnectAt = undefined;
    this.generation++; this.state = 'connecting';
    this.connectedAt = undefined; this.lastMessageAt = undefined; this.lastHeartbeatAt = undefined;
    this.emitStatus();
    if (!this.running || this.state !== 'connecting') return;
    let socket: RpcSocket;
    try {socket = this.factory(this.url);} catch {this.fail('RPC_CONNECT_FAILED'); return;}
    const connection: Connection = {socket, generation: this.generation, listeners: []};
    this.connection = connection;
    const listen = (name: string, callback: (event: any) => void) => {
      const guarded = (event: any) => {if (this.current(connection)) callback(event);};
      connection.listeners.push([name, guarded]); socket.addEventListener(name, guarded);
    };
    try {
      listen('open', () => this.open(connection));
      listen('message', event => this.message(connection, event?.data));
      listen('close', () => this.fail('RPC_CONNECTION_CLOSED'));
      listen('error', () => this.fail('RPC_CONNECTION_ERROR'));
      this.connectTimer = this.clock.setTimeout(() => {
        this.connectTimer = undefined;
        if (this.current(connection) && this.state === 'connecting') this.fail('RPC_CONNECT_TIMEOUT');
      }, this.connectTimeout);
      if (socket.readyState === 1) this.open(connection);
    } catch {this.fail('RPC_CONNECT_FAILED');}
  }

  private current(connection: Connection): boolean {
    return this.running && this.connection === connection && connection.generation === this.generation;
  }

  private open(connection: Connection): void {
    if (!this.current(connection) || this.state !== 'connecting') return;
    this.clearTimer('connectTimer'); this.state = 'open'; this.connectedAt = this.clock.now();
    // Consumers can issue a chain-identity request here before any subscription is sent.
    this.emitStatus();
    if (!this.current(connection) || this.state !== 'open') return;
    this.pumpSubscriptions();
    this.scheduleHeartbeat(connection);
  }

  private sendRequest(method: string, input: readonly unknown[], timeout: number, onResult?: (result: unknown) => void,
    lateSubscription?:Desired): Promise<unknown> {
    let params: unknown[];
    try {if (!methodValid(method)) throw new Error(); params = copyParams(input);}
    catch {return Promise.reject(new RpcStreamError('RPC_REQUEST_INVALID'));}
    const connection = this.connection;
    if (!connection || !this.current(connection) || this.state !== 'open' || connection.socket.readyState !== 1)
      return Promise.reject(new RpcStreamError('RPC_NOT_OPEN'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new RpcStreamError('RPC_PENDING_LIMIT'));
    const id = ++this.sequence;
    const payload = JSON.stringify({jsonrpc: '2.0', id, method, params});
    if (Buffer.byteLength(payload) > this.maxBytes) return Promise.reject(new RpcStreamError('RPC_MESSAGE_TOO_LARGE'));
    return new Promise((resolve, reject) => {
      const pending: Pending = {generation: connection.generation, resolve, reject, onResult,lateSubscription,
        timer: this.clock.setTimeout(() => {
          if (this.pending.get(id) !== pending) return;
          this.pending.delete(id); this.lastError = 'RPC_REQUEST_TIMEOUT';
          if(pending.lateSubscription)this.rememberLateSubscriptionAck(id,pending.generation,pending.lateSubscription);
          reject(new RpcStreamError('RPC_REQUEST_TIMEOUT')); this.emitStatus();
        }, timeout)};
      this.pending.set(id, pending);
      try {
        if ((connection.socket.bufferedAmount ?? 0) > this.maxBytes * 2) throw new Error();
        connection.socket.send(payload); this.requestsSent++;
      } catch {this.fail('RPC_SEND_FAILED');}
    });
  }

  private queuedSubscriptions():number {
    if(!this.running||this.state!=='open')return 0;
    let queued=0;
    for(const desired of this.desired.values())if(this.active.get(desired.key)?.desired.revision!==desired.revision&&
      !this.subscriptionPending(desired)&&!this.subscriptionRetryPending(desired))queued++;
    return queued;
  }

  private subscriptionPending(desired:Desired):boolean {
    for(const attempt of this.subscribing)if(attempt.generation===this.generation&&attempt.desired.key===desired.key&&
      attempt.desired.revision===desired.revision)return true;
    return false;
  }

  private subscriptionRetryPending(desired:Desired):boolean {
    const retry=this.subscriptionRetryState.get(desired.key);
    return retry?.generation===this.generation&&retry.desired.revision===desired.revision&&retry.timer!==undefined;
  }

  private pumpSubscriptions():void {
    if(!this.running||this.state!=='open')return;
    for(const desired of this.desired.values()){
      if(this.subscribing.size>=this.maxConcurrentSubscriptions)break;
      if(this.subscriptionRetryPending(desired))continue;
      this.subscribe(desired);
    }
  }

  private subscribe(desired: Desired): void {
    const generation = this.generation;
    if (!this.running || this.state !== 'open' || this.desired.get(desired.key)?.revision !== desired.revision ||
        this.active.get(desired.key)?.desired.revision === desired.revision ||
        this.subscriptionPending(desired)||this.subscriptionRetryPending(desired)||
        this.subscribing.size>=this.maxConcurrentSubscriptions) return;
    const attempt:Subscribing={desired,generation};this.subscribing.add(attempt);
    this.peakConcurrentSubscriptions=Math.max(this.peakConcurrentSubscriptions,this.subscribing.size);
    void this.sendRequest(desired.subscribeMethod, desired.params, this.timeout, result => {
      if (this.generation !== generation || !this.running || this.state !== 'open') return;
      if (!idValid(result)) throw new RpcStreamError('RPC_SUBSCRIPTION_ID_INVALID');
      const id = idKey(result);
      if (this.activeIds.has(id) || this.retiredIds.has(id)) throw new RpcStreamError('RPC_SUBSCRIPTION_ID_CONFLICT');
      const active: Active = {desired, id: result, generation};
      if (this.desired.get(desired.key)?.revision !== desired.revision) {
        this.unsubscribe(active); return;
      }
      this.clearSubscriptionRetry(desired.key);
      this.active.set(desired.key, active); this.activeIds.set(id, active); this.emitStatus();
    },this.retryTimedOutSubscriptions?desired:undefined).catch(error => {
      if (this.generation !== generation || !this.running || this.state !== 'open') return;
      if(this.retryRejectedSubscriptions&&error instanceof RpcStreamError&&error.code==='RPC_REMOTE_ERROR'){
        this.lastError='RPC_SUBSCRIBE_FAILED';this.scheduleSubscriptionRetry(desired,generation);return;
      }
      if(this.retryTimedOutSubscriptions&&error instanceof RpcStreamError&&error.code==='RPC_REQUEST_TIMEOUT'&&
          this.scheduleSubscriptionRetry(desired,generation,3)){
        this.lastError='RPC_SUBSCRIBE_FAILED';return;
      }
      this.fail(error instanceof RpcStreamError && ['RPC_SUBSCRIPTION_ID_INVALID', 'RPC_SUBSCRIPTION_ID_CONFLICT'].includes(error.code)
        ? error.code : 'RPC_SUBSCRIBE_FAILED');
    }).finally(()=>{this.subscribing.delete(attempt);this.pumpSubscriptions();this.emitStatus();});
  }

  private scheduleSubscriptionRetry(desired:Desired,generation:number,maxAttempts?:number):boolean {
    if(this.generation!==generation||this.desired.get(desired.key)?.revision!==desired.revision)return false;
    const previous=this.subscriptionRetryState.get(desired.key),attempt=previous?.desired.revision===desired.revision?
      previous.attempt:0;
    if(maxAttempts!==undefined&&attempt>=maxAttempts)return false;
    if(previous?.timer!==undefined)this.clock.clearTimeout(previous.timer);
    let random=.5;
    try {const value=this.random();if(Number.isFinite(value))random=Math.max(0,Math.min(1,value));}catch{/* deterministic fallback */}
    const base=Math.min(this.reconnectMax,this.reconnectBase*2**Math.min(attempt,30));
    const delay=Math.max(1,Math.min(this.reconnectMax,Math.round(base*(.8+random*.4))));
    const retry:SubscriptionRetry={desired,generation,attempt:attempt+1};
    retry.timer=this.clock.setTimeout(()=>{
      if(this.subscriptionRetryState.get(desired.key)!==retry)return;
      retry.timer=undefined;
      if(this.running&&this.state==='open'&&this.generation===generation&&
          this.desired.get(desired.key)?.revision===desired.revision)this.subscribe(desired);
      else this.subscriptionRetryState.delete(desired.key);
      this.emitStatus();
    },delay);
    this.subscriptionRetryState.set(desired.key,retry);this.subscriptionRetries++;this.emitStatus();return true;
  }

  private clearSubscriptionRetry(key:string):void {
    const retry=this.subscriptionRetryState.get(key);if(!retry)return;
    if(retry.timer!==undefined)this.clock.clearTimeout(retry.timer);
    this.subscriptionRetryState.delete(key);
  }

  private rememberLateSubscriptionAck(requestId:number,generation:number,desired:Desired):void {
    if(!this.running||this.state!=='open'||generation!==this.generation)return;
    if(this.lateSubscriptionAcks.size>=this.maxLateSubscriptionAcks){
      this.lateSubscriptionAckOverflows++;this.fail('RPC_RECONNECT_REQUESTED');return;
    }
    this.lateSubscriptionAcks.set(requestId,{desired,generation});
  }

  private handleLateSubscriptionAck(late:LateSubscriptionAck,result:unknown):void {
    if(late.generation!==this.generation||this.state!=='open'||!idValid(result)){
      if(!idValid(result))this.fail('RPC_SUBSCRIPTION_ID_INVALID');return;
    }
    const key=idKey(result);
    if(this.activeIds.has(key)){this.lateSubscriptionAcksMatchedActive++;return;}
    this.lateSubscriptionAcksRetired++;
    this.unsubscribe({desired:late.desired,id:result,generation:late.generation});
  }

  private retire(active: Active): void {
    if (this.active.get(active.desired.key) === active) this.active.delete(active.desired.key);
    this.activeIds.delete(idKey(active.id));
    this.unsubscribe(active);
  }

  private unsubscribe(active: Active): void {
    if (active.generation !== this.generation || this.state !== 'open') return;
    const key=idKey(active.id);this.retiredIds.add(key);
    if (this.retiredIds.size > 4096) {this.fail('RPC_RECONNECT_REQUESTED'); return;}
    if(this.unsubscribeQueue.has(key)||this.unsubscribing.has(key))return;
    this.unsubscribeQueue.set(key,active);this.pumpUnsubscriptions();
  }

  private pumpUnsubscriptions():void {
    if(!this.running||this.state!=='open')return;
    while(this.unsubscribing.size<this.maxConcurrentUnsubscriptions&&this.unsubscribeQueue.size){
      const entry=this.unsubscribeQueue.entries().next().value as [string,Active]|undefined;if(!entry)break;
      const [key,active]=entry;this.unsubscribeQueue.delete(key);
      if(active.generation!==this.generation)continue;
      this.unsubscribing.set(key,active);
      this.peakConcurrentUnsubscriptions=Math.max(this.peakConcurrentUnsubscriptions,this.unsubscribing.size);
      void this.sendRequest(active.desired.unsubscribeMethod,[active.id],this.timeout,result=>{
        if(result!==true)throw new RpcStreamError('RPC_UNSUBSCRIBE_FAILED');
      }).catch(()=>{
        if(this.running&&this.generation===active.generation&&this.state==='open')this.fail('RPC_UNSUBSCRIBE_FAILED');
      }).finally(()=>{
        this.unsubscribing.delete(key);this.pumpUnsubscriptions();this.emitStatus();
      });
    }
    this.emitStatus();
  }

  private message(connection: Connection, data: unknown): void {
    const receivedAt=this.clock.now(),receivedMonoAt=performance.now();
    if (typeof data !== 'string') {this.fail('RPC_MESSAGE_INVALID'); return;}
    if (Buffer.byteLength(data) > this.maxBytes) {this.fail('RPC_MESSAGE_TOO_LARGE'); return;}
    let decoded: unknown;
    try {decoded = JSON.parse(data);} catch {this.fail('RPC_MESSAGE_INVALID'); return;}
    const packets = Array.isArray(decoded) ? decoded : [decoded];
    if (!packets.length || packets.length > 100) {this.fail('RPC_MESSAGE_INVALID'); return;}
    this.messagesReceived++;
    for (const packet of packets) {
      if (!this.current(connection)) break;
      if (!record(packet) || packet.jsonrpc !== '2.0') {this.fail('RPC_MESSAGE_INVALID'); break;}
      if (Object.hasOwn(packet, 'id')) {
        if (typeof packet.id !== 'number') continue;
        const pending = this.pending.get(packet.id);
        if (!pending || pending.generation !== connection.generation) {
          const late=this.lateSubscriptionAcks.get(packet.id);
          if(!late||late.generation!==connection.generation)continue;
          const success=Object.hasOwn(packet,'result'),failed=Object.hasOwn(packet,'error');
          this.lateSubscriptionAcks.delete(packet.id);this.lateSubscriptionAcksReceived++;
          if(success===failed){this.fail('RPC_MESSAGE_INVALID');break;}
          this.lastMessageAt=this.clock.now();this.reconnectAttempt=0;
          if(success)this.handleLateSubscriptionAck(late,packet.result);
          this.emitStatus();continue;
        }
        const success = Object.hasOwn(packet, 'result'), failed = Object.hasOwn(packet, 'error');
        if (success === failed) {this.fail('RPC_MESSAGE_INVALID'); break;}
        this.pending.delete(packet.id); this.clock.clearTimeout(pending.timer); this.lastMessageAt = this.clock.now();
        if (failed) {this.lastError = 'RPC_REMOTE_ERROR'; pending.reject(new RpcStreamError('RPC_REMOTE_ERROR')); this.emitStatus(); continue;}
        this.reconnectAttempt = 0; this.lastError = undefined;
        try {pending.onResult?.(packet.result); pending.resolve(packet.result);}
        catch (error) {pending.reject(error instanceof RpcStreamError ? error : new RpcStreamError('RPC_CONSUMER_ERROR'));}
        this.emitStatus();
      } else if (typeof packet.method === 'string' && record(packet.params) && idValid(packet.params.subscription) && Object.hasOwn(packet.params, 'result')) {
        const active = this.activeIds.get(idKey(packet.params.subscription));
        if (!active || active.generation !== connection.generation || active.desired.notificationMethod !== packet.method ||
            this.desired.get(active.desired.key)?.revision !== active.desired.revision) continue;
        this.lastMessageAt = this.clock.now(); this.reconnectAttempt = 0; this.lastError = undefined; this.notificationsReceived++;
        try {this.onNotification(active.desired.key, packet.params.result, {receivedAt,receivedMonoAt,
          generation: connection.generation, subscriptionId: active.id});}
        catch {this.lastError = 'RPC_CONSUMER_ERROR';}
        this.emitStatus();
      }
    }
  }

  private scheduleHeartbeat(connection: Connection): void {
    if (!this.heartbeat || !this.current(connection) || this.state !== 'open') return;
    this.clearTimer('heartbeatTimer');
    const heartbeat = this.heartbeat;
    const wait = heartbeat.mode === 'message_idle' ? Math.min(heartbeat.intervalMs,
      Math.max(1, heartbeat.timeoutMs - (this.clock.now() - (this.lastMessageAt ?? this.connectedAt ?? this.clock.now())))) : heartbeat.intervalMs;
    this.heartbeatTimer = this.clock.setTimeout(() => {
      this.heartbeatTimer = undefined;
      if (!this.current(connection) || this.state !== 'open') return;
      if (heartbeat.mode === 'message_idle') {
        if (this.clock.now() - (this.lastMessageAt ?? this.connectedAt ?? this.clock.now()) >= heartbeat.timeoutMs) {
          this.fail('RPC_HEARTBEAT_TIMEOUT'); return;
        }
        this.scheduleHeartbeat(connection); return;
      }
      void this.sendRequest(heartbeat.method, heartbeat.params ?? [], heartbeat.timeoutMs ?? this.timeout).then(() => {
        if (!this.current(connection)) return;
        this.lastHeartbeatAt = this.clock.now(); this.emitStatus(); this.scheduleHeartbeat(connection);
      }, () => {if (this.current(connection)) this.fail('RPC_HEARTBEAT_TIMEOUT');});
    }, wait);
  }

  private fail(code: RpcStreamErrorCode): void {
    if (!this.running || this.state === 'backoff') return;
    this.lastError = code; this.disconnect(code); this.state = 'backoff';
    let random = 0.5;
    try {const value = this.random(); if (Number.isFinite(value)) random = Math.max(0, Math.min(1, value));} catch { /* deterministic fallback */ }
    const base = Math.min(this.reconnectMax, this.reconnectBase * 2 ** Math.min(this.reconnectAttempt, 30));
    const delay = Math.max(1, Math.min(this.reconnectMax, Math.round(base * (0.8 + random * 0.4))));
    this.reconnectAttempt++; this.reconnects++; this.nextReconnectAt = this.clock.now() + delay;
    this.reconnectTimer = this.clock.setTimeout(() => {this.reconnectTimer = undefined; this.connect();}, delay);
    this.emitStatus();
  }

  private disconnect(code: RpcStreamErrorCode): void {
    this.clearTimer('connectTimer'); this.clearTimer('heartbeatTimer');
    const connection = this.connection; this.connection = undefined;
    if (connection) {
      for (const [name, listener] of connection.listeners) try {connection.socket.removeEventListener(name, listener);} catch { /* no upstream error text */ }
      try {connection.socket.close(1000);} catch { /* already closed */ }
    }
    for (const pending of this.pending.values()) {this.clock.clearTimeout(pending.timer); pending.reject(new RpcStreamError(code));}
    for(const key of [...this.subscriptionRetryState.keys()])this.clearSubscriptionRetry(key);
    this.pending.clear(); this.active.clear(); this.activeIds.clear(); this.retiredIds.clear(); this.subscribing.clear();
    this.unsubscribeQueue.clear();this.unsubscribing.clear();this.lateSubscriptionAcks.clear();
  }

  private clearTimer(key: 'connectTimer' | 'heartbeatTimer' | 'reconnectTimer'): void {
    const timer = this[key]; if (timer !== undefined) this.clock.clearTimeout(timer); this[key] = undefined;
  }

  private emitStatus(): void {
    try {this.onStatus?.(this.getStatus());} catch {this.lastError = 'RPC_CONSUMER_ERROR';}
  }
}
