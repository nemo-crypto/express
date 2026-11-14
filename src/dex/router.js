import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { fail, object, paginate } from './domain.js';
import { AppError } from '../domain/task.js';

export function createDexRouter(runtime, { token = 'demo-local-token' } = {}) {
  if (typeof token !== 'string' || token.length < 12 || token.length > 256) throw new Error('DEX_DEMO_TOKEN 应为 12–256 个字符');
  const router = express.Router();
  const authorize = (req, _res, next) => {
    const value = req.get('Authorization') ?? '';
    const expected = `Bearer ${token}`;
    if (Buffer.byteLength(value) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(value), Buffer.from(expected))) {
      return next(new AppError(401, 'DEMO_UNAUTHORIZED', '需要本地 Demo Bearer token'));
    }
    next();
  };
  router.use((req, _res, next) => {
    if (['/market', '/market/stream'].includes(req.path) && req.method === 'GET') return next();
    authorize(req, _res, next);
  });
  router.get('/market', async (_req, res) => res.json(await runtime.market.snapshot()));
  let streams = 0;
  router.get('/market/stream', async (req, res) => {
    if (streams >= 20) fail(429, 'STREAM_LIMIT', '最多 20 个行情流');
    const initial = await runtime.market.snapshot();
    // await 后再次检查，避免并行连接绕过上限。
    if (streams >= 20) fail(429, 'STREAM_LIMIT', '最多 20 个行情流');
    streams++;
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    let closed = false;
    const send = (snapshot) => {
      if (closed) return;
      // 慢客户端不无限积压；重连可从 GET /market 获取最新完整快照。
      if (!res.write(`id: ${snapshot.sequence}\nevent: market\ndata: ${JSON.stringify(snapshot)}\n\n`)) res.end();
    };
    const heartbeat = setInterval(() => { if (!closed && !res.write(': keep-alive\n\n')) res.end(); }, 15000);
    heartbeat.unref();
    const shutdown = () => res.end();
    runtime.market.on('snapshot', send);
    runtime.market.on('shutdown', shutdown);
    res.once('close', () => {
      closed = true; streams--; clearInterval(heartbeat);
      runtime.market.off('snapshot', send); runtime.market.off('shutdown', shutdown);
    });
    send(initial);
  });
  router.post('/quotes', async (req, res) => res.status(201).json(await runtime.trading.quote(req.body)));
  router.post('/orders', async (req, res) => {
    const result = await runtime.trading.create(req.body, req.get('Idempotency-Key'));
    res.status(result.reused ? 200 : 201).location(`/api/dex/orders/${result.order.id}`).json(result);
  });
  router.get('/orders', async (req, res) => res.json(paginate(await runtime.trading.list(), req.query)));
  router.get('/orders/:id', async (req, res) => res.json(await runtime.trading.get(req.params.id)));
  router.post('/orders/:id/reconcile', async (req, res) => res.json(await runtime.trading.reconcile(req.params.id)));
  router.get('/admin/overview', async (_req, res) => res.json(await runtime.overview()));
  router.get('/admin/config', async (_req, res) => res.json(await runtime.config()));
  router.patch('/admin/config', async (req, res) => res.json(await runtime.updateConfig(req.body)));
  router.post('/admin/config/rollback', async (req, res) => res.json(await runtime.updateConfig(req.body, true)));
  router.get('/admin/audit', async (req, res) => res.json(paginate((await runtime.store.read()).audit.reverse(), req.query)));
  router.post('/admin/scenarios', async (req, res) => res.json(await runtime.scenario(req.body)));
  router.post('/admin/tick', async (_req, res) => res.json(await runtime.tick()));
  router.post('/admin/feed', async (req, res) => {
    object(req.body, ['connected']);
    if (typeof req.body.connected !== 'boolean') fail(400, 'INVALID_INPUT', 'connected 必须是布尔值');
    res.json(await runtime.market.connect(req.body.connected));
  });
  router.post('/admin/events', async (req, res) => res.json(await runtime.market.ingest(req.body)));
  router.post('/admin/unstick', async (req, res) => {
    object(req.body, ['txHash']);
    if (typeof req.body.txHash !== 'string') fail(400, 'INVALID_INPUT', 'txHash 必须是字符串');
    res.json(await runtime.unstick(req.body.txHash));
  });
  return router;
}
