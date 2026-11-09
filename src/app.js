import express from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from './domain/task.js';
import { TaskService } from './services/task-service.js';

export function createApp({ repository, logger = console } = {}) {
  if (!repository) throw new Error('必须注入 repository');
  const app = express(); const service = new TaskService(repository);
  app.disable('x-powered-by'); app.set('query parser', 'simple');
  app.use((req, res, next) => {
    req.requestId = randomUUID(); res.set('X-Request-ID', req.requestId); res.set('X-Content-Type-Options', 'nosniff'); res.set('Cache-Control', 'no-store');
    const start = performance.now(); res.on('finish', () => logger.info?.(JSON.stringify({ requestId: req.requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Math.round(performance.now() - start) })));
    if (req.get('Sec-Fetch-Site') === 'cross-site') return next(new AppError(403, 'CROSS_SITE', '不接受跨站请求'));
    if (req.get('Origin')) { try { if (new URL(req.get('Origin')).host !== req.get('host')) return next(new AppError(403, 'CROSS_ORIGIN', '不接受跨源请求')); } catch { return next(new AppError(403, 'CROSS_ORIGIN', '来源无效')); } }
    next();
  });
  app.use((req, _res, next) => { if (['POST', 'PATCH'].includes(req.method) && !req.is('application/json')) return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json')); next(); });
  app.use(express.json({ limit: '16kb', strict: true }));
  app.get('/', (_req, res) => res.json({ name: 'Express Learning API', version: 1, documentation: '/api', health: '/health' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api', (_req, res) => res.json({ endpoints: ['GET /api/tasks', 'GET /api/tasks/:id', 'POST /api/tasks', 'PATCH /api/tasks/:id', 'DELETE /api/tasks/:id'] }));
  app.get('/api/tasks', async (req, res) => res.json(await service.list(req.query)));
  app.get('/api/tasks/:id', async (req, res) => res.json(await service.get(req.params.id)));
  app.post('/api/tasks', async (req, res) => { const task = await service.create(req.body); res.status(201).location(`/api/tasks/${task.id}`).json(task); });
  app.patch('/api/tasks/:id', async (req, res) => res.json(await service.update(req.params.id, req.body)));
  app.delete('/api/tasks/:id', async (req, res) => { await service.remove(req.params.id); res.status(204).end(); });
  app.use((_req, _res, next) => next(new AppError(404, 'ROUTE_NOT_FOUND', '接口不存在')));
  app.use((error, req, res, _next) => {
    if (res.headersSent) return _next(error);
    let status = 500; let code = 'INTERNAL_ERROR'; let message = '服务暂时不可用';
    if (error instanceof AppError) ({ status, code, message } = error);
    else if (error.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'JSON 格式无效'; }
    else if (error.type === 'entity.too.large') { status = 413; code = 'BODY_TOO_LARGE'; message = '请求体不能超过 16KB'; }
    if (status === 500) logger.error?.(JSON.stringify({ requestId: req.requestId, event: 'request_failed' }));
    res.status(status).json({ error: { code, message, requestId: req.requestId } });
  });
  return app;
}
