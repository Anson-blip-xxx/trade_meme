import test from 'node:test';
import assert from 'node:assert/strict';
import {RpcStream, RpcStreamError, type RpcStreamClock, type RpcSocket, type RpcSubscription,
  type RpcStreamOptions, type RpcStreamStatus, type RpcNotificationMeta} from '../src/rpc-stream.js';

const flush = async () => {for (let i = 0; i < 5; i++) await Promise.resolve();};
class FakeClock implements RpcStreamClock {
  current = 0;
  sequence = 0;
  tasks = new Map<number, {at: number; run: () => void}>();
  now = () => this.current;
  setTimeout = (run: () => void, delayMs: number) => {const id = ++this.sequence; this.tasks.set(id, {at: this.current + delayMs, run}); return id;};
  clearTimeout = (id: unknown) => {this.tasks.delete(id as number);};
  async advance(ms: number) {
    const end = this.current + ms;
    let count = 0;
    while (true) {
      const next = [...this.tasks].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++count < 1000, 'timer loop should remain bounded');
      this.current = next[1].at; this.tasks.delete(next[0]); next[1].run(); await flush();
    }
    this.current = end; await flush();
  }
}
class FakeSocket implements RpcSocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: {jsonrpc: string; id: number; method: string; params: unknown[]}[] = [];
  closed = 0;
  sendFailure = false;
  listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void) {let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(listener);}
  removeEventListener(type: string, listener: (event: any) => void) {this.listeners.get(type)?.delete(listener);}
  emit(type: string, event: any = {}) {for (const listener of [...this.listeners.get(type) ?? []]) listener(event);}
  open() {this.readyState = 1; this.emit('open');}
  send(data: string) {if (this.sendFailure) throw new Error('secret-provider-url/API_KEY'); this.sent.push(JSON.parse(data));}
  close() {this.closed++; this.readyState = 3; this.emit('close', {reason: 'secret-provider-url/API_KEY'});}
  message(data: unknown) {this.emit('message', {data: JSON.stringify(data)});}
  response(index: number, result: unknown) {this.message({jsonrpc: '2.0', id: this.sent[index].id, result});}
  errorResponse(index: number) {this.message({jsonrpc: '2.0', id: this.sent[index].id, error: {code: -32000, message: 'secret-provider-url/API_KEY'}});}
  notification(subscription: string | number, result: unknown, method = 'eth_subscription') {
    this.message({jsonrpc: '2.0', method, params: {subscription, result}});
  }
}
const sub = (key = 'bsc:token', params: unknown[] = ['logs', {address: `0x${'a'.repeat(40)}`} ]): RpcSubscription => ({
  key, params, subscribeMethod: 'eth_subscribe', unsubscribeMethod: 'eth_unsubscribe', notificationMethod: 'eth_subscription',
});
function fixture(extra: Partial<RpcStreamOptions> = {}) {
  const clock = new FakeClock(), sockets: FakeSocket[] = [], statuses: RpcStreamStatus[] = [];
  const events: {key: string; result: unknown; meta: RpcNotificationMeta}[] = [];
  const stream = new RpcStream({url: 'wss://provider.invalid/?apikey=secret-provider-url/API_KEY', clock,
    socketFactory: () => {const socket = new FakeSocket(); sockets.push(socket); return socket;},
    random: () => 0.5, requestTimeoutMs: 50, connectTimeoutMs: 1000,
    reconnectBaseMs: 100, reconnectMaxMs: 400, maxMessageBytes: 4096,
    onNotification: (key, result, meta) => events.push({key, result, meta}), onStatus: status => statuses.push(status), ...extra});
  return {clock, sockets, events, statuses, stream, open: () => {stream.start(); sockets.at(-1)!.open(); return sockets.at(-1)!;}};
}
const code = (error: unknown, expected: string) => error instanceof RpcStreamError && error.code === expected && error.message === expected;

test('constructor rejects invalid settings with fixed codes and never echoes endpoint secrets', () => {
  for (const extra of [{url: 'https://provider.invalid/secret'}, {url: 'wss://user:secret@provider.invalid'},
    {url: 'wss://provider.invalid/#secret'}, {requestTimeoutMs: 0}, {maxMessageBytes: 1}, {reconnectMaxMs: 1},
    {heartbeat: {mode: 'request', method: 'bad/method/secret', intervalMs: 100} as const}])
    assert.throws(() => fixture(extra), error => code(error, 'RPC_CONFIG_INVALID'));
});

test('desired subscriptions stay inactive before open and before a matching subscription ACK', async () => {
  const f = fixture(); f.stream.setSubscriptions([sub()]);
  assert.equal(f.stream.getStatus().desiredSubscriptions, 1); assert.equal(f.stream.getStatus().activeSubscriptions, 0);
  f.stream.start(); assert.equal(f.sockets[0].sent.length, 0); f.sockets[0].open();
  const socket = f.sockets[0]; assert.equal(socket.sent[0].method, 'eth_subscribe');
  socket.notification('sub-1', {ignored: true}); assert.equal(f.events.length, 0);
  socket.response(0, 'sub-1');
  assert.deepEqual(f.stream.getStatus().activeKeys, ['bsc:token']);
  socket.notification('sub-1', {blockNumber: '0x1'});
  assert.equal(f.events.length, 1); assert.deepEqual(f.events[0].result, {blockNumber: '0x1'});
  assert.equal(f.events[0].meta.generation, f.stream.getStatus().generation);
  assert.equal(f.events[0].meta.subscriptionId, 'sub-1');
  f.stream.stop(); await flush(); assert.equal(f.clock.tasks.size, 0);
});

test('open status allows an identity request before subscriptions are sent', async () => {
  let stream: RpcStream | undefined, identity: Promise<unknown> | undefined;
  const f = fixture({onStatus: status => {if (status.state === 'open' && !identity) identity = stream!.request('eth_chainId');}});
  stream = f.stream; stream.setSubscriptions([sub()]); const socket = f.open();
  assert.deepEqual(socket.sent.map(item => item.method), ['eth_chainId', 'eth_subscribe']);
  socket.response(0, '0x38'); assert.equal(await identity, '0x38');
  socket.response(1, 'sub-1'); stream.stop(); await flush();
});

test('an ACK and its first notification in one batch are applied in protocol order', async () => {
  const f = fixture(); f.stream.setSubscriptions([sub()]); const socket = f.open();
  socket.message([{jsonrpc: '2.0', id: socket.sent[0].id, result: 'sub-1'},
    {jsonrpc: '2.0', method: 'eth_subscription', params: {subscription: 'sub-1', result: {first: true}}}]);
  assert.equal(f.events.length, 1); assert.deepEqual(f.events[0].result, {first: true});
  f.stream.stop(); await flush();
});

test('numeric Solana subscription IDs including zero are distinct from string IDs and method matched', async () => {
  const f = fixture(); f.stream.setSubscriptions([{...sub('sol:slot', []), subscribeMethod: 'slotSubscribe',
    unsubscribeMethod: 'slotUnsubscribe', notificationMethod: 'slotNotification'}]);
  const socket = f.open(); socket.response(0, 0);
  socket.notification('0', {slot: 1}, 'slotNotification');
  socket.notification(0, {slot: 2}, 'logsNotification');
  socket.notification(999, {slot: 3}, 'slotNotification');
  assert.equal(f.events.length, 0);
  socket.notification(0, {slot: 4}, 'slotNotification');
  assert.equal(f.events.length, 1); assert.deepEqual(f.events[0].result, {slot: 4});
  f.stream.stop(); await flush();
});

test('subscriptions snapshot their params, unchanged updates are idempotent, invalid replacement is atomic', async () => {
  const f = fixture(), desired = sub(); f.stream.setSubscriptions([desired]);
  (desired.params[1] as {address: string}).address = 'mutated';
  const socket = f.open(); assert.equal((socket.sent[0].params[1] as {address: string}).address, `0x${'a'.repeat(40)}`);
  socket.response(0, 'sub-1'); f.stream.setSubscriptions([sub()]); assert.equal(socket.sent.length, 1);
  assert.throws(() => f.stream.setSubscriptions([sub(), sub()]), error => code(error, 'RPC_SUBSCRIPTION_INVALID'));
  assert.throws(() => f.stream.upsertSubscription({...sub('bad/key'), params: []}), error => code(error, 'RPC_SUBSCRIPTION_INVALID'));
  assert.deepEqual(f.stream.getStatus().activeKeys, ['bsc:token']); assert.equal(socket.sent.length, 1);
  f.stream.stop(); await flush();
});

test('upserting a changed target retires the old subscription immediately and waits for the new ACK', async () => {
  const f = fixture(); f.stream.setSubscriptions([sub()]); const socket = f.open(); socket.response(0, 'old');
  f.stream.upsertSubscription(sub('bsc:token', ['newHeads']));
  assert.deepEqual(socket.sent.slice(1).map(item => item.method), ['eth_unsubscribe', 'eth_subscribe']);
  assert.deepEqual(socket.sent[1].params, ['old']); assert.equal(f.stream.getStatus().activeSubscriptions, 0);
  socket.notification('old', {stale: true}); socket.response(1, true); socket.response(2, 'new');
  socket.notification('old', {stale: true}); socket.notification('new', {block: 2});
  assert.equal(f.events.length, 1); assert.deepEqual(f.events[0].result, {block: 2});
  f.stream.removeSubscription('bsc:token'); assert.equal(f.stream.getStatus().activeSubscriptions, 0);
  assert.equal(socket.sent[3].method, 'eth_unsubscribe'); socket.response(3, true);
  socket.notification('new', {late: true}); assert.equal(f.events.length, 1);
  f.stream.stop(); await flush();
});

test('removing an unacknowledged subscription unsubscribes its late ACK without admitting notifications', async () => {
  const f = fixture(); f.stream.setSubscriptions([sub()]); const socket = f.open();
  f.stream.removeSubscription('bsc:token'); socket.response(0, 'late-id');
  assert.equal(f.stream.getStatus().activeSubscriptions, 0);
  assert.equal(socket.sent[1].method, 'eth_unsubscribe'); assert.deepEqual(socket.sent[1].params, ['late-id']);
  socket.notification('late-id', {ignored: true}); assert.equal(f.events.length, 0); socket.response(1, true);
  f.stream.stop(); await flush();
});

test('superseded pending subscriptions cannot overwrite a newer subscription under the same key', async () => {
  const f = fixture(); f.stream.setSubscriptions([sub()]); const socket = f.open();
  f.stream.upsertSubscription(sub('bsc:token', ['newHeads']));
  socket.response(1, 'new'); socket.response(0, 'old');
  assert.equal(socket.sent[2].method, 'eth_unsubscribe'); socket.response(2, true);
  socket.notification('old', 1); socket.notification('new', 2);
  assert.deepEqual(f.events.map(item => item.result), [2]);
  f.stream.stop(); await flush();
});

test('reconnect backs off exponentially to a cap and resends only the latest desired subscriptions', async () => {
  const f = fixture(); f.stream.setSubscriptions([sub()]); f.open().close();
  assert.equal(f.stream.getStatus().nextReconnectAt, 100); await f.clock.advance(99); assert.equal(f.sockets.length, 1);
  await f.clock.advance(1); assert.equal(f.sockets.length, 2); f.sockets[1].open(); f.sockets[1].close();
  assert.equal(f.stream.getStatus().nextReconnectAt, 300); await f.clock.advance(200);
  f.sockets[2].open(); f.sockets[2].close(); assert.equal(f.stream.getStatus().nextReconnectAt, 700);
  f.stream.setSubscriptions([sub('bsc:replacement', ['newHeads'])]); await f.clock.advance(400);
  f.sockets[3].open(); assert.deepEqual(f.sockets[3].sent[0].params, ['newHeads']);
  f.sockets[3].close(); assert.equal(f.stream.getStatus().nextReconnectAt, 1100);
  f.stream.stop(); await flush(); assert.equal(f.clock.tasks.size, 0);
});

test('backoff jitter is bounded and successful acknowledgements reset consecutive failures', async () => {
  for (const [random, delay] of [[0, 80], [1, 120]]) {
    const f = fixture({random: () => random}); f.stream.setSubscriptions([sub()]); f.open().close();
    assert.equal(f.stream.getStatus().nextReconnectAt, delay); await f.clock.advance(delay);
    const socket = f.sockets[1]; socket.open(); socket.response(0, 'healthy');
    assert.equal(f.stream.getStatus().reconnectAttempt, 0); socket.close();
    assert.equal(f.stream.getStatus().nextReconnectAt, delay * 2);
    f.stream.stop(); await flush();
  }
});

test('old socket callbacks cannot resolve requests or deliver notifications into a new generation', async () => {
  const f = fixture(); f.stream.setSubscriptions([sub()]); const old = f.open(); old.response(0, 'id');
  const oldHandler = [...old.listeners.get('message')!][0], oldGeneration = f.stream.getStatus().generation;
  const request = f.stream.request('eth_chainId'); const rejected = assert.rejects(request, error => code(error, 'RPC_CONNECTION_CLOSED'));
  old.close(); await rejected; await f.clock.advance(100);
  const current = f.sockets[1]; current.open(); current.response(0, 'id');
  oldHandler({data: JSON.stringify({jsonrpc: '2.0', method: 'eth_subscription', params: {subscription: 'id', result: 'stale'}})});
  current.notification('id', 'fresh');
  assert.deepEqual(f.events.map(item => item.result), ['fresh']);
  assert.ok(f.events[0].meta.generation > oldGeneration);
  f.stream.stop(); await flush();
});

test('connect timeout and factory failures reconnect using fixed errors without exposing connection details', async () => {
  const f = fixture(); f.stream.start(); await f.clock.advance(1000);
  assert.equal(f.stream.getStatus().state, 'backoff'); assert.equal(f.stream.getStatus().lastError, 'RPC_CONNECT_TIMEOUT');
  f.stream.stop();
  const broken = fixture({socketFactory: () => {throw new Error('secret-provider-url/API_KEY');}});
  broken.stream.start(); assert.equal(broken.stream.getStatus().lastError, 'RPC_CONNECT_FAILED');
  assert.ok(!JSON.stringify(broken.statuses).includes('secret-provider-url'));
  broken.stream.stop(); await flush();
});

test('ordinary requests correlate out-of-order numeric IDs and ignore mismatched echoed types', async () => {
  const f = fixture(), socket = f.open();
  const first = f.stream.request('eth_chainId'), second = f.stream.request('eth_blockNumber');
  socket.message({jsonrpc: '2.0', id: String(socket.sent[0].id), result: 'wrong'});
  assert.equal(f.stream.getStatus().pendingRequests, 2);
  socket.response(1, '0x10'); socket.response(0, '0x38');
  assert.equal(await first, '0x38'); assert.equal(await second, '0x10');
  assert.equal(f.stream.getStatus().pendingRequests, 0); f.stream.stop();
});

test('request timeouts reject once, discard late responses and do not retry arbitrary RPC requests', async () => {
  const f = fixture(), socket = f.open();
  const rejected = assert.rejects(f.stream.request('eth_chainId'), error => code(error, 'RPC_REQUEST_TIMEOUT'));
  await f.clock.advance(50); await rejected;
  assert.equal(socket.sent.length, 1); assert.equal(f.stream.getStatus().state, 'open');
  socket.response(0, 'late'); assert.equal(f.stream.getStatus().pendingRequests, 0);
  assert.equal(f.stream.getStatus().lastMessageAt, undefined); f.stream.stop();
});

test('RPC errors redact provider message, payload and URL and never produce notifications', async () => {
  const f = fixture(), socket = f.open(); const promise = f.stream.request('eth_chainId');
  socket.errorResponse(0); await assert.rejects(promise, error => code(error, 'RPC_REMOTE_ERROR'));
  assert.equal(f.stream.getStatus().lastError, 'RPC_REMOTE_ERROR');
  assert.ok(!JSON.stringify(f.statuses).includes('API_KEY')); assert.equal(f.events.length, 0); f.stream.stop();
});

test('malformed, binary and oversized UTF-8 messages close the stream with bounded safe errors', async () => {
  for (const [data, expected] of [['not-json', 'RPC_MESSAGE_INVALID'], [new Uint8Array([1]), 'RPC_MESSAGE_INVALID'],
    ['"' + '中'.repeat(100) + '"', 'RPC_MESSAGE_TOO_LARGE'],
    [JSON.stringify([]), 'RPC_MESSAGE_INVALID'], [JSON.stringify({jsonrpc: '1.0'}), 'RPC_MESSAGE_INVALID']]) {
    const f = fixture({maxMessageBytes: 128}), socket = f.open(); socket.emit('message', {data});
    assert.equal(f.stream.getStatus().lastError, expected); assert.equal(f.stream.getStatus().state, 'backoff');
    assert.equal(f.events.length, 0); f.stream.stop(); await flush();
  }
});

test('excessive batches and ambiguous responses are rejected rather than partially trusted', async () => {
  const f = fixture(), socket = f.open();
  socket.message(Array.from({length: 101}, () => ({jsonrpc: '2.0'})));
  assert.equal(f.stream.getStatus().lastError, 'RPC_MESSAGE_INVALID'); f.stream.stop();
  const g = fixture(), other = g.open();
  const rejected = assert.rejects(g.stream.request('eth_chainId'), error => code(error, 'RPC_MESSAGE_INVALID'));
  other.message({jsonrpc: '2.0', id: other.sent[0].id, result: '0x38', error: {code: 1}});
  await rejected; assert.equal(g.stream.getStatus().state, 'backoff'); g.stream.stop();
});

test('outgoing parameter and pending limits are checked before any additional send', async () => {
  const f = fixture({maxPendingRequests: 1}), socket = f.open();
  const cyclic: unknown[] = []; cyclic.push(cyclic);
  for (const params of [[Infinity], [undefined], [() => 1], cyclic])
    await assert.rejects(f.stream.request('eth_call', params), error => code(error, 'RPC_REQUEST_INVALID'));
  await assert.rejects(f.stream.request('bad/method', []), error => code(error, 'RPC_REQUEST_INVALID'));
  await assert.rejects(f.stream.request('eth_call', ['x'.repeat(5000)]), error => code(error, 'RPC_MESSAGE_TOO_LARGE'));
  const first = f.stream.request('eth_chainId');
  await assert.rejects(f.stream.request('eth_blockNumber'), error => code(error, 'RPC_PENDING_LIMIT'));
  assert.equal(socket.sent.length, 1); socket.response(0, '0x38'); await first; f.stream.stop();
  await assert.rejects(f.stream.request('eth_chainId'), error => code(error, 'RPC_NOT_OPEN'));
});

test('invalid subscription ACKs and same-generation ID reuse trigger a fresh connection', async () => {
  for (const result of [null, {}, true, -1, 1.5, '', 'https://secret.invalid']) {
    const f = fixture(); f.stream.setSubscriptions([sub()]); const socket = f.open(); socket.response(0, result); await flush();
    assert.equal(f.stream.getStatus().lastError, 'RPC_SUBSCRIPTION_ID_INVALID');
    assert.equal(f.stream.getStatus().activeSubscriptions, 0); f.stream.stop();
  }
  const f = fixture(); f.stream.setSubscriptions([sub()]); const socket = f.open(); socket.response(0, 'id');
  f.stream.upsertSubscription(sub('bsc:token', ['newHeads'])); socket.response(1, true); socket.response(2, 'id'); await flush();
  assert.equal(f.stream.getStatus().lastError, 'RPC_SUBSCRIPTION_ID_CONFLICT');
  assert.equal(f.stream.getStatus().activeSubscriptions, 0); f.stream.stop();
});

test('two targets cannot share an acknowledged subscription ID', async () => {
  const f = fixture(); f.stream.setSubscriptions([sub('one'), sub('two')]); const socket = f.open();
  socket.response(0, 'same'); socket.response(1, 'same'); await flush();
  assert.equal(f.stream.getStatus().lastError, 'RPC_SUBSCRIPTION_ID_CONFLICT');
  assert.equal(f.stream.getStatus().state, 'backoff'); f.stream.stop();
});

test('failed or timed out subscriptions and failed unsubscribe ACKs do not masquerade as active', async () => {
  const f = fixture(); f.stream.setSubscriptions([sub()]); const socket = f.open(); socket.errorResponse(0); await flush();
  assert.equal(f.stream.getStatus().lastError, 'RPC_SUBSCRIBE_FAILED'); assert.equal(f.stream.getStatus().activeSubscriptions, 0);
  await f.clock.advance(100); f.sockets[1].open(); await f.clock.advance(50);
  assert.equal(f.stream.getStatus().lastError, 'RPC_SUBSCRIBE_FAILED'); f.stream.stop();
  const g = fixture(); g.stream.setSubscriptions([sub()]); const other = g.open(); other.response(0, 'id');
  g.stream.removeSubscription('bsc:token'); other.response(1, false); await flush();
  assert.equal(g.stream.getStatus().lastError, 'RPC_UNSUBSCRIBE_FAILED'); assert.equal(g.stream.getStatus().activeSubscriptions, 0);
  g.stream.stop();
});

test('slot notifications sustain idle heartbeat without any target-wallet transactions; unsolicited traffic cannot', async () => {
  const f = fixture({heartbeat: {mode: 'message_idle', intervalMs: 10, timeoutMs: 45}});
  f.stream.setSubscriptions([{...sub('sol:slot', []), subscribeMethod: 'slotSubscribe', unsubscribeMethod: 'slotUnsubscribe', notificationMethod: 'slotNotification'}]);
  const socket = f.open(); socket.response(0, 7);
  await f.clock.advance(20); socket.notification(7, {slot: 1}, 'slotNotification');
  await f.clock.advance(20); socket.notification(7, {slot: 2}, 'slotNotification');
  await f.clock.advance(44); assert.equal(f.stream.getStatus().state, 'open');
  socket.notification(999, {slot: 3}, 'slotNotification'); socket.notification(7, {wrong: true}, 'logsNotification');
  await f.clock.advance(1); assert.equal(f.stream.getStatus().state, 'backoff');
  assert.equal(f.stream.getStatus().lastError, 'RPC_HEARTBEAT_TIMEOUT'); f.stream.stop();
});

test('request heartbeats wait for responses, never overlap and reconnect on a missed deadline', async () => {
  const f = fixture({heartbeat: {method: 'eth_blockNumber', intervalMs: 20, timeoutMs: 15}}), socket = f.open();
  await f.clock.advance(20); assert.deepEqual(socket.sent.map(item => item.method), ['eth_blockNumber']);
  socket.response(0, '0x1'); await flush(); assert.equal(f.stream.getStatus().lastHeartbeatAt, 20);
  await f.clock.advance(20); assert.equal(socket.sent.length, 2);
  await f.clock.advance(14); assert.equal(socket.sent.length, 2); assert.equal(f.stream.getStatus().state, 'open');
  await f.clock.advance(1); assert.equal(f.stream.getStatus().lastError, 'RPC_HEARTBEAT_TIMEOUT');
  assert.equal(f.stream.getStatus().state, 'backoff'); f.stream.stop();
});

test('lack of target trades alone never declares a connection dead when no heartbeat policy is configured', async () => {
  const f = fixture(); f.stream.setSubscriptions([sub()]); const socket = f.open(); socket.response(0, 'id');
  await f.clock.advance(3_600_000); assert.equal(f.stream.getStatus().state, 'open'); assert.equal(f.sockets.length, 1);
  f.stream.stop();
});

test('stop cancels every timer and request; restart and stale callbacks cannot create duplicate connections', async () => {
  const f = fixture({heartbeat: {mode: 'message_idle', intervalMs: 10, timeoutMs: 45}});
  f.stream.setSubscriptions([sub()]); const socket = f.open(); socket.response(0, 'id');
  const handler = [...socket.listeners.get('message')!][0];
  const rejected = assert.rejects(f.stream.request('eth_chainId'), error => code(error, 'RPC_STOPPED'));
  f.stream.stop(); await rejected; assert.equal(f.clock.tasks.size, 0);
  handler({data: JSON.stringify({jsonrpc: '2.0', method: 'eth_subscription', params: {subscription: 'id', result: 'late'}})});
  await f.clock.advance(1000); assert.equal(f.events.length, 0); assert.equal(f.sockets.length, 1);
  f.stream.start(); f.stream.start(); assert.equal(f.sockets.length, 2); f.sockets[1].open(); f.sockets[1].response(0, 'fresh');
  assert.equal(f.sockets[1].sent.length, 1); f.stream.stop(); await flush(); assert.equal(f.clock.tasks.size, 0);
});

test('a stopped backoff cannot reconnect and a force-reconnect reason never includes arbitrary text', async () => {
  const f = fixture(); f.open();
  f.stream.forceReconnect('RPC_CHAIN_IDENTITY_MISMATCH'); assert.equal(f.stream.getStatus().lastError, 'RPC_CHAIN_IDENTITY_MISMATCH');
  f.stream.stop(); await f.clock.advance(1000); assert.equal(f.sockets.length, 1);
  const g = fixture(); g.open(); g.stream.forceReconnect('secret-provider-url/API_KEY' as 'RPC_RECONNECT_REQUESTED');
  assert.equal(g.stream.getStatus().lastError, 'RPC_RECONNECT_REQUESTED'); assert.ok(!JSON.stringify(g.statuses).includes('API_KEY'));
  g.stream.stop();
});

test('consumer exceptions are contained and raw callback or socket error messages are never reported', async () => {
  const f = fixture({onNotification: () => {throw new Error('secret-provider-url/API_KEY');}});
  f.stream.setSubscriptions([sub()]); const socket = f.open(); socket.response(0, 'id');
  socket.notification('id', {}); assert.equal(f.stream.getStatus().lastError, 'RPC_CONSUMER_ERROR');
  assert.equal(f.stream.getStatus().state, 'open'); assert.ok(!JSON.stringify(f.statuses).includes('API_KEY'));
  socket.emit('error', new Error('secret-provider-url/API_KEY')); assert.equal(f.stream.getStatus().lastError, 'RPC_CONNECTION_ERROR');
  f.stream.stop(); await flush();
});

test('send failures reject pending requests with a fixed code and dispose the connection', async () => {
  const f = fixture(), socket = f.open(); socket.sendFailure = true;
  await assert.rejects(f.stream.request('eth_chainId'), error => code(error, 'RPC_SEND_FAILED'));
  assert.equal(f.stream.getStatus().state, 'backoff'); assert.equal(f.stream.getStatus().pendingRequests, 0);
  assert.ok(!JSON.stringify(f.statuses).includes('API_KEY')); f.stream.stop();
});

test('a reentrant stop during connecting status prevents the socket from being created', () => {
  let stream: RpcStream;
  const f = fixture({onStatus: status => {if (status.state === 'connecting') stream.stop();}});
  stream = f.stream; stream.start(); assert.equal(f.sockets.length, 0); assert.equal(f.clock.tasks.size, 0);
  assert.equal(stream.getStatus().state, 'stopped');
});
