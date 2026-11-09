import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError, taskInput } from '../domain/task.js';

// 同一存储契约：业务层不需要知道是否落盘。
export class TaskRepository {
  #tasks;
  #pending = Promise.resolve();
  #file;
  #lock;
  #closed = false;
  constructor(tasks = [], file = null, lock = null) { this.#tasks = tasks; this.#file = file; this.#lock = lock; }

  static async open(file) {
    if (!file) return new TaskRepository();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await open(`${file}.lock`, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('数据文件已被占用；若上次进程异常退出，请确认没有运行实例后移除 .lock 文件'); throw error; }
    try {
      let tasks = [];
      try {
        const state = JSON.parse(await readFile(file, 'utf8'));
        if (state.version !== 1 || !Array.isArray(state.tasks) || state.tasks.length > 1000) throw new Error('存储格式不支持');
        const seen = new Set();
        for (const task of state.tasks) {
          if (!task || typeof task.id !== 'string' || !/^[\da-f-]{36}$/.test(task.id) || seen.has(task.id) || typeof task.completed !== 'boolean' || !Number.isFinite(Date.parse(task.createdAt)) || !Number.isFinite(Date.parse(task.updatedAt))) throw new Error('存储记录无效');
          taskInput({ title: task.title }); seen.add(task.id);
        }
        tasks = state.tasks;
      } catch (error) { if (error.code !== 'ENOENT') throw new Error('存储文件损坏，拒绝自动覆盖', { cause: error }); }
      return new TaskRepository(tasks, file, lock);
    } catch (error) { await lock.close(); await unlink(`${file}.lock`); throw error; }
  }
  async list() { await this.#pending; return this.#tasks.map((task) => ({ ...task })); }
  async #persist(tasks) {
    if (!this.#file) return;
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, tasks }, null, 2)); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, this.#file);
    } finally {
      await handle?.close(); await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  #write(change) {
    if (this.#closed) return Promise.reject(new Error('存储已关闭'));
    const operation = this.#pending.then(async () => {
      const next = this.#tasks.map((task) => ({ ...task })); const result = change(next);
      await this.#persist(next); this.#tasks = next; return result;
    });
    this.#pending = operation.catch(() => {}); return operation;
  }
  create(input) {
    return this.#write((tasks) => {
      if (tasks.length >= 1000) throw new AppError(409, 'CAPACITY_REACHED', 'Demo 最多保存 1000 个任务');
      const now = new Date().toISOString(); const task = { id: randomUUID(), title: input.title, completed: false, createdAt: now, updatedAt: now };
      tasks.push(task); return { ...task };
    });
  }
  update(id, input) {
    return this.#write((tasks) => {
      const task = tasks.find((item) => item.id === id); if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
      Object.assign(task, input, { updatedAt: new Date().toISOString() }); return { ...task };
    });
  }
  remove(id) {
    return this.#write((tasks) => { const index = tasks.findIndex((task) => task.id === id); if (index < 0) throw new AppError(404, 'NOT_FOUND', '任务不存在'); tasks.splice(index, 1); });
  }
  async close() { this.#closed = true; await this.#pending; if (this.#lock) { await this.#lock.close(); this.#lock = null; await unlink(`${this.#file}.lock`); } }
}
