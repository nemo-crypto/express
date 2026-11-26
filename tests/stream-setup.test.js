import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {createServer, get} from 'node:http';
import {createApp} from '../src/app.js';
import {TaskRepository} from '../src/repositories/task-repository.js';
const quiet = {info() {}, error() {}};
async function fixture(snapshot) {
  const market = new EventEmitter();
  market.snapshot = snapshot;
  const server = createServer(createApp({repository: new TaskRepository(), logger: quiet, dexRuntime: {market}}));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {market, server, url: `http://127.0.0.1:${server.address().port}/api/dex/market/stream`,
    close() {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));}};
}
test('disconnecting while the initial snapshot loads leaves no stream subscriptions', async () => {
  let begin, release;
  const started = new Promise(resolve => {begin = resolve;});
  const f = await fixture(() => {begin(); return new Promise(resolve => {release = resolve;});});
  let responseClosed;
  const closed = new Promise(resolve => {responseClosed = resolve;});
  f.server.on('request', (_req, res) => res.once('close', responseClosed));
  const req = get(f.url);
  req.on('error', () => {});
  try {
    await started;
    req.destroy();
    await closed;
    release({sequence: 1});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.market.listenerCount('snapshot'), 0);
    assert.equal(f.market.listenerCount('shutdown'), 0);
  } finally {req.destroy(); f.market.removeAllListeners(); await f.close();}
});
