import test from 'node:test';
import assert from 'node:assert/strict';
import {DexStore} from '../src/dex/store.js';
test('transaction input references cannot mutate committed state afterwards', async () => {
  const store = await DexStore.open();
  const pools = [{id: 'external'}];
  await store.change(state => {state.market.pools = pools;});
  pools[0].id = 'mutated';
  assert.equal((await store.read()).market.pools[0].id, 'external');
  await store.close();
});
test('uncloneable results reject before committing transaction state', async () => {
  const store = await DexStore.open();
  await assert.rejects(store.change(state => {state.market.sequence = 9; return () => {};}));
  assert.equal((await store.read()).market.sequence, 0);
  await store.close();
});
