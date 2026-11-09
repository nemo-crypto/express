import { AppError, listQuery, taskInput } from '../domain/task.js';

export class TaskService {
  constructor(repository) { this.repository = repository; }
  async list(query) {
    const { completed, limit, offset } = listQuery(query);
    const items = (await this.repository.list()).filter((task) => completed === undefined || task.completed === completed);
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  }
  async get(id) { const task = (await this.repository.list()).find((item) => item.id === id); if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在'); return task; }
  create(input) { return this.repository.create(taskInput(input)); }
  update(id, input) { return this.repository.update(id, taskInput(input, true)); }
  remove(id) { return this.repository.remove(id); }
}
