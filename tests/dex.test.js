import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { TaskRepository } from '../src/repositories/task-repository.js';
import { createDexRuntime } from '../src/dex/runtime.js';
import { DexStore } from '../src/dex/store.js';
import { INITIAL_POOLS, parseUnits, formatUnits, quotePool } from '../src/dex/domain.js';

const quiet = { info() {}, error() {} };
const input = { tokenIn: 'WETH', tokenOut: 'USDC', amountIn: '0.1', slippageBps: 100 };
async function fixture(t, file) {
  let time = 1_000_000;
  const runtime = await createDexRuntime({ file, now: () => time, logger: quiet });
  t.after(() => runtime.close());
  const app = createApp({ repository: new TaskRepository(), dexRuntime: runtime, logger: quiet });
  return {
    runtime, app, advance(ms) { time += ms; },
    api(method, path) { return request(app)[method](`/api/dex${path}`).set('Authorization', 'Bearer demo-local-token'); },
    async order(key = randomUUID()) {
      const quote = await runtime.trading.quote(input);
      return (await runtime.trading.create({ quoteId: quote.id }, key)).order;
    },
    async tick() { time += 1000; return runtime.tick(); },
  };
}

test('BigInt 金额保持高精度、拒绝多余小数与科学计数法', () => {
  const amount = parseUnits('9007199254740993.123456', 'USDC');
  assert.equal(formatUnits(amount, 'USDC'), '9007199254740993.123456');
  assert.equal(parseUnits('0.1', 'WETH'), 100000000000000000n);
  for (const value of ['1e3', '-1', '0', '0.0000001', 1, '01']) assert.throws(() => parseUnits(value, 'USDC'));
  const pool = INITIAL_POOLS[0];
  const quantity = 100000000000000000n;
  const net = quantity * 9970n;
  assert.equal(quotePool(pool, 'WETH', quantity), net * 300000000000n / (100000000000000000000n * 10000n + net));
});

test('默认关闭 DEX；开启后认证与参数边界保持原有任务接口兼容', async (t) => {
  const { app, api } = await fixture(t);
  await request(createApp({ repository: new TaskRepository(), logger: quiet })).get('/api/dex/market').expect(404);
  await request(app).get('/api/dex/market').expect(200);
  await request(app).post('/api/dex/quotes').send(input).expect(401);
  await api('post', '/quotes').send({ ...input, amountIn: 1 }).expect(400);
  await api('post', '/quotes').send({ ...input, slippageBps: 9999 }).expect(400);
  await api('get', '/orders/constructor').expect(404);
  await api('post', '/orders').set('Idempotency-Key', 'safe-key-123').send({ quoteId: '__proto__' }).expect(409);
  await api('get', '/orders?limit=0').expect(400);
  await request(app).post('/api/tasks').send({ title: '原任务接口' }).expect(201);
});

test('报价选择输出更优的池，反向交易按币种精度工作', async (t) => {
  const { runtime } = await fixture(t);
  const quote = await runtime.trading.quote(input);
  const amounts = quote.routes.map((item) => BigInt(item.amountOut));
  assert.equal(BigInt(quote.amountOut), amounts.reduce((a, b) => a > b ? a : b));
  assert.equal(BigInt(quote.minOut), BigInt(quote.amountOut) * 9900n / 10000n);
  const reverse = await runtime.trading.quote({ tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '100', slippageBps: 50 });
  assert.ok(BigInt(reverse.amountOut) > 0n);
});

test('HTTP 完整交易流：报价、提交、两次确认、查询与审计；不泄露签名', async (t) => {
  const f = await fixture(t);
  const quote = await f.api('post', '/quotes').send(input).expect(201);
  const response = await f.api('post', '/orders').set('Idempotency-Key', 'http-demo-123').send({ quoteId: quote.body.id }).expect(201);
  const id = response.body.order.id;
  assert.equal(response.body.order.status, 'queued');
  await f.tick();
  assert.equal((await f.runtime.trading.get(id)).status, 'submitted');
  await f.tick();
  assert.equal((await f.runtime.trading.get(id)).status, 'submitted');
  await f.tick();
  const order = await f.api('get', `/orders/${id}`).expect(200);
  assert.equal(order.body.status, 'confirmed');
  assert.equal(Object.hasOwn(order.body, 'signed'), false);
  assert.equal(Object.hasOwn(order.body, 'payload'), false);
  assert.equal(order.body.receipt.gasWei, '180000000000000');
  const audit = await f.api('get', '/admin/audit?limit=100').expect(200);
  assert.ok(audit.body.items.some((item) => item.action === 'order.finalized'));
  const overview = await f.api('get', '/admin/overview').expect(200);
  assert.equal(overview.body.orders.successRate, 1);
  assert.equal(overview.body.execution.broadcasts, 1);
});

test('并发相同幂等键只创建一笔；不同请求使用同键返回冲突', async (t) => {
  const { runtime } = await fixture(t);
  const quote = await runtime.trading.quote(input);
  const orders = await Promise.all(Array.from({ length: 15 }, () => runtime.trading.create({ quoteId: quote.id }, 'concurrent-123')));
  assert.equal(new Set(orders.map((item) => item.order.id)).size, 1);
  assert.equal((await runtime.trading.list()).length, 1);
  const other = await runtime.trading.quote(input);
  await assert.rejects(runtime.trading.create({ quoteId: other.id }, 'concurrent-123'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('行情断线补齐、去重与过期保护；非法事件不改行情游标', async (t) => {
  const f = await fixture(t);
  await f.runtime.market.connect(false);
  await f.tick(); await f.tick(); await f.tick();
  assert.equal((await f.runtime.market.snapshot()).sequence, 1);
  const recovered = await f.runtime.market.connect(true);
  assert.equal(recovered.sequence, 4);
  assert.equal(recovered.backfilled, 2);
  const latest = (await f.runtime.store.read()).feedHistory.at(-1);
  await f.runtime.market.ingest(latest);
  assert.equal((await f.runtime.market.snapshot()).duplicates, 1);
  await assert.rejects(f.runtime.market.ingest({ ...latest, sequence: 5, pools: [] }), { code: 'INVALID_EVENT' });
  assert.equal((await f.runtime.market.snapshot()).sequence, 4);
  f.advance(5001);
  await assert.rejects(f.runtime.trading.quote(input), { code: 'MARKET_STALE' });
});

test('缺口超出保留窗口不会伪造补数或向前推进游标', async (t) => {
  const { runtime } = await fixture(t);
  const latest = (await runtime.store.read()).feedHistory.at(-1);
  await assert.rejects(runtime.market.ingest({ ...latest, sequence: 999 }), { code: 'BACKFILL_UNAVAILABLE' });
  assert.equal((await runtime.market.snapshot()).sequence, 1);
});

test('广播回执丢失：按保存的 hash 核验，不重复执行', async (t) => {
  const f = await fixture(t);
  await f.runtime.scenario({ scenario: 'ack-lost' });
  const order = await f.order();
  await Promise.all([f.runtime.trading.process(order.id), f.runtime.trading.process(order.id)]);
  const hash = (await f.runtime.trading.get(order.id)).txHash;
  await f.tick(); await f.tick();
  const state = await f.runtime.store.read();
  assert.equal(state.orders[order.id].status, 'confirmed');
  assert.equal(state.orders[order.id].txHash, hash);
  assert.equal(Object.keys(state.chain.transactions).length, 1);
  assert.equal(state.metrics.broadcasts, 1);
  assert.equal(state.metrics.retries, 0);
  assert.equal(state.metrics.rpcErrors, 1);
});

test('RPC 超时指数退避，重试保持原始签名/hash', async (t) => {
  const f = await fixture(t);
  await f.runtime.scenario({ scenario: 'rpc-timeout' });
  const order = await f.order();
  await f.runtime.trading.process(order.id);
  const original = await f.runtime.trading.get(order.id);
  assert.equal(original.status, 'signed');
  f.advance(999);
  await f.runtime.trading.process(order.id);
  assert.equal((await f.runtime.trading.get(order.id)).attempts, 1);
  f.advance(1);
  await f.runtime.trading.process(order.id);
  assert.equal((await f.runtime.trading.get(order.id)).txHash, original.txHash);
  await f.tick(); await f.tick();
  assert.equal((await f.runtime.trading.get(order.id)).status, 'confirmed');
  assert.equal((await f.runtime.overview()).execution.retries, 1);
});

test('重试耗尽进入 attention，不把未知交易直接当作执行失败', async (t) => {
  const f = await fixture(t);
  const order = await f.order();
  for (let attempt = 0; attempt < 3; attempt++) {
    await f.runtime.scenario({ scenario: 'rpc-timeout' });
    await f.runtime.trading.process(order.id);
    f.advance(1000 * 2 ** attempt);
  }
  const latest = await f.runtime.trading.get(order.id);
  assert.equal(latest.status, 'attention');
  assert.equal(latest.reason, 'RETRIES_EXHAUSTED');
  assert.equal((await f.runtime.overview()).alerts.includes('ORDERS_NEED_ATTENTION'), true);
});

test('报价到期、策略暂停与 gas 成本在提交/执行阶段拦截', async (t) => {
  const f = await fixture(t);
  const quote = await f.runtime.trading.quote(input);
  f.advance(10000);
  await assert.rejects(f.runtime.trading.create({ quoteId: quote.id }, randomUUID()), { code: 'QUOTE_EXPIRED' });
  await f.tick();
  const order = await f.order();
  await f.runtime.updateConfig({ expectedVersion: 1, patch: { tradingEnabled: false } });
  await f.runtime.trading.process(order.id);
  assert.equal((await f.runtime.trading.get(order.id)).reason, 'TRADING_PAUSED');
  await f.runtime.updateConfig({ expectedVersion: 2, patch: { tradingEnabled: true, maxGasWei: '1' } });
  const fresh = await f.runtime.trading.quote(input);
  await assert.rejects(f.runtime.trading.create({ quoteId: fresh.id }, randomUUID()), { code: 'GAS_LIMIT' });
});

for (const [scenario, reason] of [['revert', 'EXECUTION_REVERTED'], ['slippage', 'SLIPPAGE_EXCEEDED']]) {
  test(`${scenario} 返回链上失败原因且计入失败率`, async (t) => {
    const f = await fixture(t);
    await f.runtime.scenario({ scenario });
    const order = await f.order();
    await f.tick(); await f.tick(); await f.tick();
    const result = await f.runtime.trading.get(order.id);
    assert.equal(result.status, 'failed'); assert.equal(result.reason, reason);
    assert.equal((await f.runtime.overview()).orders.successRate, 0);
  });
}

test('卡住交易告警；人工恢复沿用同一 hash，过期交易在模拟链失败', async (t) => {
  const f = await fixture(t);
  await f.runtime.scenario({ scenario: 'stuck' });
  const order = await f.order();
  await f.tick();
  const hash = (await f.runtime.trading.get(order.id)).txHash;
  f.advance(30001); await f.tick();
  assert.equal((await f.runtime.trading.get(order.id)).reason, 'TRANSACTION_STUCK');
  await f.runtime.unstick(hash);
  await f.tick();
  await f.runtime.trading.reconcile(order.id);
  await f.tick();
  const result = await f.runtime.trading.get(order.id);
  assert.equal(result.txHash, hash);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'DEADLINE_EXCEEDED');
  assert.equal((await f.runtime.overview()).execution.broadcasts, 1);
});

test('配置乐观版本、灰度与回滚保留审计，非法更新不污染状态', async (t) => {
  const { runtime } = await fixture(t);
  await assert.rejects(runtime.updateConfig({ expectedVersion: 1, patch: { maxSlippageBps: 9999 } }));
  assert.equal((await runtime.config()).current.version, 1);
  await runtime.updateConfig({ expectedVersion: 1, patch: { rolloutPercent: 0 } });
  const quote = await runtime.trading.quote(input);
  await assert.rejects(runtime.trading.create({ quoteId: quote.id }, randomUUID()), { code: 'ROLLOUT_DISABLED' });
  await assert.rejects(runtime.updateConfig({ expectedVersion: 1, patch: { tradingEnabled: false } }), { code: 'CONFIG_CONFLICT' });
  const restored = await runtime.updateConfig({ expectedVersion: 2, targetVersion: 1 }, true);
  assert.equal(restored.version, 3); assert.equal(restored.rolloutPercent, 100);
  assert.equal((await runtime.store.read()).audit.at(-1).action, 'config.rollback');
});

test('文件锁、损坏保护与重启恢复：已接收的交易不会重新创建', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dex-demo-'));
  const file = join(directory, 'dex.json');
  let runtime;
  try {
    runtime = await createDexRuntime({ file, now: () => 1000000, logger: quiet });
    await assert.rejects(DexStore.open(file), { code: 'EEXIST' });
    const quote = await runtime.trading.quote(input);
    const { order } = await runtime.trading.create({ quoteId: quote.id }, 'persistent-123');
    await runtime.scenario({ scenario: 'ack-lost' });
    await runtime.trading.process(order.id);
    const hash = (await runtime.trading.get(order.id)).txHash;
    await runtime.close(); runtime = null;
    runtime = await createDexRuntime({ file, now: () => 1000000, logger: quiet });
    await runtime.tick();
    const result = await runtime.trading.get(order.id);
    assert.equal(result.status, 'confirmed'); assert.equal(result.txHash, hash);
    assert.equal((await runtime.store.read()).metrics.broadcasts, 1);
    assert.equal((await runtime.trading.create({ quoteId: quote.id }, 'persistent-123')).reused, true);
    await runtime.close(); runtime = null;
    await writeFile(file, 'broken');
    await assert.rejects(DexStore.open(file));
    assert.equal(await readFile(file, 'utf8'), 'broken');
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SSE 输出真实事件并在客户端关闭后清理订阅', async (t) => {
  const f = await fixture(t);
  const server = createServer(f.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dex/market/stream`);
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: market/);
  assert.equal(f.runtime.market.listenerCount('snapshot'), 1);
  await f.tick();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"sequence":2/);
  await reader.cancel();
  for (let count = 0; count < 20 && f.runtime.market.listenerCount('snapshot'); count++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(f.runtime.market.listenerCount('snapshot'), 0);
});


test('管理页面仅在开启 Demo 时可访问，脚本外置且带 CSP', async (t) => {
  const { app } = await fixture(t);
  await request(app).get('/dex-demo/').expect(200).expect('Content-Security-Policy', /script-src 'self'/).expect(/DEX 交易实验室/);
  await request(app).get('/dex-demo/app.js').expect(200);
  await request(createApp({ repository: new TaskRepository(), logger: quiet })).get('/dex-demo/').expect(404);
});

test('创建后收紧滑点策略，排队订单不签名；已签名未接受的订单暂停广播', async (t) => {
  const f = await fixture(t);
  const first = await f.order();
  await f.runtime.updateConfig({ expectedVersion: 1, patch: { maxSlippageBps: 50 } });
  await f.tick();
  assert.equal((await f.runtime.trading.get(first.id)).reason, 'SLIPPAGE_POLICY');
  assert.equal((await f.runtime.trading.get(first.id)).txHash, null);
  await f.runtime.updateConfig({ expectedVersion: 2, patch: { maxSlippageBps: 300 } });
  const second = await f.order();
  await f.runtime.scenario({ scenario: 'rpc-timeout' });
  await f.tick();
  const signed = await f.runtime.trading.get(second.id);
  assert.equal(signed.status, 'signed');
  await f.runtime.updateConfig({ expectedVersion: 3, patch: { maxSlippageBps: 50 } });
  await f.tick();
  assert.equal((await f.runtime.trading.get(second.id)).reason, 'SLIPPAGE_POLICY');
  assert.equal((await f.runtime.overview()).execution.broadcasts, 0);
  await f.runtime.updateConfig({ expectedVersion: 4, patch: { maxSlippageBps: 300 } });
  await f.tick();
  assert.equal((await f.runtime.trading.get(second.id)).txHash, signed.txHash);
  assert.equal((await f.runtime.overview()).execution.broadcasts, 1);
});
