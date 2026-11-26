import test from 'node:test';
import assert from 'node:assert/strict';
import {createDexRuntime} from '../src/dex/runtime.js';
test('concurrent ticks share one block advance and return the same overview', async () => {
  const runtime = await createDexRuntime({now: () => 1000});
  try {
    const before = await runtime.overview();
    const results = await Promise.all([runtime.tick(), runtime.tick(), runtime.tick()]);
    for (const result of results) assert.equal(result?.block, before.block + 1);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
  } finally {await runtime.close();}
});
