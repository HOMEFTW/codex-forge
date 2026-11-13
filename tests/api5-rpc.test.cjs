const test = require('node:test');
const assert = require('node:assert/strict');
const { ForgeRPC } = require('../runtime/forge-rpc.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('API 5 RPC cancellation aborts the producer and consumes a late result', async () => {
  const rpc = new ForgeRPC(); let signal, finish;
  const pending = rpc.run('window/frame/plugin/thread', 1, received => { signal = received; return new Promise(resolve => { finish = resolve; }); });
  await tick();
  assert.equal(rpc.cancel('other-frame', 1), false);
  assert.equal(signal.aborted, false);
  assert.equal(rpc.cancel('window/frame/plugin/thread', 1), true);
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(signal.aborted, true);
  finish({ late: true }); await tick();
  assert.equal(rpc.pending.size, 0);
  assert.equal(rpc.cancel('window/frame/plugin/thread', 1), false);
  rpc.dispose();
});

test('cancelling before dispatch prevents the producer from starting', async () => {
  const rpc = new ForgeRPC(); let started = false;
  const pending = rpc.run('owner', 1, () => { started = true; return null; });
  rpc.cancel('owner', 1);
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(started, false); rpc.dispose();
});

test('API 5 RPC stream separates duplex input, completion and ownership', async () => {
  const rpc = new ForgeRPC(), inputs = []; let ended = false, signal;
  const { streamId } = rpc.open('a', received => {
    signal = received;
    return (async function* () { yield { phase: 'ready' }; yield inputs[0]; return 'finished'; })();
  }, { onInput: value => inputs.push(value), onEnd: () => { ended = true; } });
  await assert.rejects(rpc.next('b', streamId), error => error.code === 'STREAM_NOT_FOUND');
  await assert.rejects(rpc.send('b', streamId, 'bad'), error => error.code === 'STREAM_NOT_FOUND');
  await assert.rejects(rpc.close('b', streamId), error => error.code === 'STREAM_NOT_FOUND');
  assert.deepEqual(await rpc.next('a', streamId), { value: { phase: 'ready' }, done: false });
  assert.deepEqual(await rpc.send('a', streamId, { query: 1 }), { accepted: true });
  assert.deepEqual(await rpc.end('a', streamId), { ended: true });
  assert.equal(ended, true);
  await assert.rejects(rpc.send('a', streamId, 'late'), error => error.code === 'STREAM_CLOSED');
  assert.deepEqual(await rpc.next('a', streamId), { value: { query: 1 }, done: false });
  assert.deepEqual(await rpc.next('a', streamId), { value: 'finished', done: true });
  assert.equal(signal.aborted, true);
  assert.equal(rpc.streams.size, 0); rpc.dispose();
});

test('API 5 RPC rejects overlapping reads and closes an uncooperative producer promptly', async () => {
  const rpc = new ForgeRPC(); let returned = false, producerSignal;
  const { streamId } = rpc.open('owner', signal => { producerSignal = signal; return { next: () => new Promise(() => {}), return: () => { returned = true; return new Promise(() => {}); } }; });
  const pending = rpc.next('owner', streamId);
  await assert.rejects(rpc.next('owner', streamId), /一个待处理读取/);
  await rpc.close('owner', streamId);
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(producerSignal.aborted, true); assert.equal(returned, true);
  assert.deepEqual(await rpc.close('owner', streamId), { closed: true }); rpc.dispose();
});

test('API 5 RPC bounds traffic and preserves other owners when one plugin stops', async () => {
  const rpc = new ForgeRPC({ maxPending: 1, maxStreams: 1, maxBytes: 32 });
  const pending = rpc.run('a', 1, () => new Promise(() => {}));
  await assert.rejects(rpc.run('a', 2, () => null), error => error.code === 'RESOURCE_LIMIT');
  assert.deepEqual(await rpc.run('b', 1, () => ({ ok: true })), { ok: true });
  await assert.rejects(rpc.run('b', 2, () => 'x'.repeat(100)), error => error.code === 'RESOURCE_LIMIT');
  const first = rpc.open('a', [1]);
  assert.throws(() => rpc.open('a', [2]), error => error.code === 'RESOURCE_LIMIT');
  const second = rpc.open('b', [3]);
  rpc.disposeOwner('a');
  await assert.rejects(pending, error => error.code === 'PLUGIN_DISABLED');
  await assert.rejects(rpc.next('a', first.streamId), error => error.code === 'STREAM_NOT_FOUND');
  assert.deepEqual(await rpc.next('b', second.streamId), { value: 3, done: false }); rpc.dispose();
});

test('API 5 RPC signal and deadline terminate streams and pending producer work', async () => {
  const rpc = new ForgeRPC({ timeoutMs: 50 }), controller = new AbortController();
  const stream = rpc.open('a', [1, 2], { signal: controller.signal });
  controller.abort(); await tick();
  await assert.rejects(rpc.next('a', stream.streamId), error => error.code === 'STREAM_NOT_FOUND');
  const pending = rpc.run('a', 1, () => new Promise(() => {}), { timeoutMs: 5 });
  const keptAlive = new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(pending, error => error.code === 'TIMEOUT'); await keptAlive;
  assert.equal(rpc.pending.size, 0); rpc.dispose();
  await assert.rejects(rpc.run('a', 2, () => null), error => error.code === 'PLUGIN_DISABLED');
});

test('API 5 RPC refuses invalid IDs, unserializable data and oversized stream frames', async () => {
  const rpc = new ForgeRPC({ maxBytes: 16 });
  await assert.rejects(rpc.run('a', 0, () => null), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(rpc.run('a', 1, () => ({ bad: Infinity })), error => error.code === 'INVALID_ARGUMENT');
  const { streamId } = rpc.open('a', ['x'.repeat(17)]);
  await assert.rejects(rpc.next('a', streamId), error => error.code === 'RESOURCE_LIMIT');
  assert.equal(rpc.streams.size, 0); rpc.dispose();
});

test('RPC rejects invalid stream limits before activation and unwinds a failed factory', () => {
  const rpc=new ForgeRPC();let activated=false,signal;
  assert.throws(()=>rpc.open('a',()=>{activated=true;return [1];},{timeoutMs:0}),error=>error.code==='INVALID_ARGUMENT');
  assert.equal(activated,false);
  assert.throws(()=>rpc.open('a',received=>{signal=received;throw Error('fixture startup failure');}),/fixture startup failure/);
  assert.equal(signal.aborted,true);assert.equal(rpc.streams.size,0);rpc.dispose();
});
