import test from 'node:test';
import assert from 'node:assert/strict';
import { createDexRuntime } from '../src/dex/runtime.js';

test('a failed snapshot subscriber cannot reject a committed tick or skip healthy subscribers', async t => {
  const errors = [];
  const runtime = await createDexRuntime({ logger: { error: line => errors.push(JSON.parse(line)) } });
  t.after(() => runtime.close());
  const seen = [];
  runtime.market.on('snapshot', () => { throw new Error('private payload must not be logged'); });
  runtime.market.on('snapshot', snapshot => seen.push(snapshot.sequence));
  const result = await runtime.tick();
  assert.equal(result.feed.sequence, 2);
  assert.equal(result.feed.rejected, 0);
  assert.deepEqual(seen, [2]);
  assert.deepEqual(errors, [{ event: 'dex.market.subscriber.failed', code: 'SUBSCRIBER_ERROR' }]);
  assert.equal(JSON.stringify(errors).includes('private payload'), false);
});

test('async subscriber rejection is contained and once subscribers retain their lifecycle', async t => {
  const errors = [];
  const runtime = await createDexRuntime({ logger: { error: line => errors.push(JSON.parse(line)) } });
  t.after(() => runtime.close());
  let calls = 0;
  runtime.market.once('snapshot', async function () {
    assert.equal(this, runtime.market);
    calls++;
    throw new Error('subscriber rejected');
  });
  await runtime.tick();
  await runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.equal((await runtime.overview()).feed.rejected, 0);
  await assert.rejects(runtime.market.ingest({ sequence: 4 }), /缺少字段|必须|timestamp|block|字段/);
  assert.equal((await runtime.overview()).feed.rejected, 1);
});
