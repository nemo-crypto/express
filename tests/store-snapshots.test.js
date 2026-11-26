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

test('failed result cloning leaves persisted state unchanged after reopening', async () => {
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'dex-snapshot-'));
  const file = join(directory, 'state.json');
  let store = await DexStore.open(file);
  try {
    await store.change(state => {state.market.sequence = 1;});
    await assert.rejects(store.change(state => {state.market.sequence = 2; return () => {};}));
    await store.close();
    store = await DexStore.open(file);
    assert.equal((await store.read()).market.sequence, 1);
  } finally {await store.close(); await rm(directory, {recursive: true, force: true});}
});
