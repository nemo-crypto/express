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
