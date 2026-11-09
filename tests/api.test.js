import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { TaskRepository } from '../src/repositories/task-repository.js';
const quiet = { info() {}, error() {} };
const fixture = () => createApp({ repository: new TaskRepository(), logger: quiet });

test('CRUD 与分页筛选闭环', async () => {
 const app = fixture(); const created = await request(app).post('/api/tasks').send({ title: ' 学习路由 ' }).expect(201);
 assert.equal(created.body.title, '学习路由'); assert.ok(created.headers.location); assert.ok(created.headers['x-request-id']);
 const id = created.body.id;
 await request(app).get(`/api/tasks/${id}`).expect(200);
 const changed = await request(app).patch(`/api/tasks/${id}`).send({ completed: true }).expect(200); assert.equal(changed.body.completed, true);
 const filtered = await request(app).get('/api/tasks?completed=false&limit=1&offset=0').expect(200); assert.equal(filtered.body.total, 0);
 await request(app).delete(`/api/tasks/${id}`).expect(204); await request(app).get(`/api/tasks/${id}`).expect(404);
});
test('校验、JSON 错误、体积和未知路由', async () => {
 const app = fixture();
 for (const body of [{ title: '' }, { title: 'A', admin: true }, { title: 1 }, []]) await request(app).post('/api/tasks').send(body).expect(400);
 await request(app).patch('/api/tasks/missing').send({ completed: 'yes' }).expect(400);
 await request(app).get('/api/tasks?limit=-1').expect(400);
 await request(app).get('/api/tasks?completed=maybe').expect(400);
 await request(app).post('/api/tasks').type('json').send('{').expect(400);
 await request(app).post('/api/tasks').send({ title: 'a'.repeat(20000) }).expect(413);
 await request(app).post('/api/tasks').type('text').send('hello').expect(415);
 const bad = await request(app).get('/unknown').expect(404); assert.equal(bad.body.error.code, 'ROUTE_NOT_FOUND'); assert.ok(bad.body.error.requestId);
 await request(app).post('/api/tasks').set('Origin', 'https://evil.example').send({ title: 'A' }).expect(403);
});
test('Express 5 自动转交异步异常，不暴露内部错误', async () => {
 const app = createApp({ repository: { async list() { throw new Error('database-secret'); } }, logger: quiet });
 const res = await request(app).get('/api/tasks').expect(500); assert.equal(res.body.error.code, 'INTERNAL_ERROR'); assert.ok(!JSON.stringify(res.body).includes('database-secret'));
});
test('文件存储串行写入、进程锁、重启和损坏保护', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'express-teaching-')); const file = join(dir, 'tasks.json'); let repo;
 try {
  repo = await TaskRepository.open(file); await assert.rejects(TaskRepository.open(file), /占用/);
  await Promise.all(Array.from({ length: 15 }, (_, i) => repo.create({ title: `任务 ${i}` })));
  assert.equal((await repo.list()).length, 15); await repo.close(); repo = null;
  repo = await TaskRepository.open(file); assert.equal((await repo.list()).length, 15); const first = (await repo.list())[0]; await repo.remove(first.id); await repo.close(); repo = null;
  assert.equal(JSON.parse(await readFile(file, 'utf8')).tasks.length, 14);
  await writeFile(file, 'broken'); await assert.rejects(TaskRepository.open(file), /损坏/); assert.equal(await readFile(file, 'utf8'), 'broken');
 } finally { await repo?.close(); await rm(dir, { recursive: true, force: true }); }
});
test('读取快照不能改变仓库内部状态，失败后队列继续', async () => {
 const repo = new TaskRepository(); const task = await repo.create({ title: 'Original' }); const snapshot = await repo.list(); snapshot[0].title = 'changed';
 assert.equal((await repo.list())[0].title, 'Original'); await assert.rejects(repo.update('missing', { completed: true })); await repo.update(task.id, { completed: true }); assert.equal((await repo.list())[0].completed, true);
});
