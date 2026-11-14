import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { TaskRepository } from '../src/repositories/task-repository.js';
import { createDexRuntime } from '../src/dex/runtime.js';

// 使用真实本地 HTTP + 可推进时钟，几秒内重现 30 秒超时，不等待真实时间。
let time = 1_000_000;
const quiet = { info() {}, error() {} };
const runtime = await createDexRuntime({ now: () => time, logger: quiet });
const repository = new TaskRepository();
const server = createServer(createApp({ repository, dexRuntime: runtime, logger: quiet }));
const input = { tokenIn: 'WETH', tokenOut: 'USDC', amountIn: '0.1', slippageBps: 100 };
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}/api/dex`;
  const api = async (method, path, body, headers = {}, expected = 200) => {
    const response = await fetch(base + path, {
      method, headers: { Authorization: 'Bearer demo-local-token', 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  const tick = async () => { time += 1000; return api('POST', '/admin/tick', {}); };
  const submit = async (scenario) => {
    await tick();
    await api('POST', '/admin/scenarios', { scenario });
    const quote = await api('POST', '/quotes', input, {}, 201);
    const key = randomUUID();
    const result = await api('POST', '/orders', { quoteId: quote.id }, { 'Idempotency-Key': key }, 201);
    const repeated = await api('POST', '/orders', { quoteId: quote.id }, { 'Idempotency-Key': key });
    assert.equal(repeated.order.id, result.order.id);
    for (let index = 0; index < 4; index++) await tick();
    return api('GET', `/orders/${result.order.id}`);
  };
  console.log('1. 行情断线与补数');
  await api('POST', '/admin/feed', { connected: false });
  await tick(); await tick(); await tick();
  const recovered = await api('POST', '/admin/feed', { connected: true });
  assert.equal(recovered.backfilled, 2);
  console.log(JSON.stringify({ sequence: recovered.sequence, backfilled: recovered.backfilled }));

  console.log('\n2. 真实 HTTP 演练：正常、丢回执、RPC 超时、链上回滚、滑点失败');
  for (const [scenario, expected] of [['normal', 'confirmed'], ['ack-lost', 'confirmed'], ['rpc-timeout', 'confirmed'], ['revert', 'failed'], ['slippage', 'failed']]) {
    const order = await submit(scenario);
    assert.equal(order.status, expected);
    console.log(JSON.stringify({ scenario, orderId: order.id, status: order.status, reason: order.reason, attempts: order.attempts }));
  }

  console.log('\n3. 交易卡住 → attention → 按原 hash 人工核验');
  let order = await submit('stuck');
  const hash = order.txHash;
  time += 31000;
  await tick();
  order = await api('GET', `/orders/${order.id}`);
  assert.equal(order.status, 'attention');
  await api('POST', '/admin/unstick', { txHash: hash });
  await tick();
  await api('POST', `/orders/${order.id}/reconcile`, {});
  await tick();
  order = await api('GET', `/orders/${order.id}`);
  assert.equal(order.txHash, hash);
  assert.equal(order.reason, 'DEADLINE_EXCEEDED');
  console.log(JSON.stringify({ status: order.status, reason: order.reason, sameHash: order.txHash === hash }));

  console.log('\n4. 配置灰度、版本冲突与回滚');
  await api('PATCH', '/admin/config', { expectedVersion: 1, patch: { rolloutPercent: 0 } });
  const quote = await api('POST', '/quotes', input, {}, 201);
  await api('POST', '/orders', { quoteId: quote.id }, { 'Idempotency-Key': randomUUID() }, 403);
  await api('PATCH', '/admin/config', { expectedVersion: 1, patch: { tradingEnabled: false } }, {}, 409);
  const config = await api('POST', '/admin/config/rollback', { expectedVersion: 2, targetVersion: 1 });
  assert.equal(config.version, 3);
  console.log(JSON.stringify({ restoredVersion: config.version, rolloutPercent: config.rolloutPercent }));

  console.log('\n5. 监控概览（所有金额为字符串；失败样例是预期演示结果）');
  const overview = await api('GET', '/admin/overview');
  assert.equal(overview.orders.total, 6);
  assert.equal(overview.execution.broadcasts, 6);
  console.log(JSON.stringify(overview, null, 2));
  console.log('\nDEX Demo 完成：HTTP 接口、故障场景和防重复执行断言全部通过。');
} finally {
  await runtime.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await repository.close();
}
