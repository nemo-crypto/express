export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function taskInput(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'INVALID_INPUT', '请求体必须是 JSON 对象');
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => !['title', ...(partial ? ['completed'] : [])].includes(key))) throw new AppError(400, 'INVALID_INPUT', '存在未知字段或缺少修改内容');
  const output = {};
  if (!partial || Object.hasOwn(input, 'title')) {
    if (typeof input.title !== 'string' || !input.title.trim() || [...input.title.trim()].length > 100 || /[\u0000-\u001f\u007f]/.test(input.title)) throw new AppError(400, 'INVALID_TITLE', 'title 应为 1–100 个字符且不含控制字符');
    output.title = input.title.trim();
  }
  if (Object.hasOwn(input, 'completed')) {
    if (typeof input.completed !== 'boolean') throw new AppError(400, 'INVALID_COMPLETED', 'completed 必须是布尔值');
    output.completed = input.completed;
  }
  return output;
}

export function listQuery(query) {
  if (Object.keys(query).some((key) => !['completed', 'limit', 'offset'].includes(key))) throw new AppError(400, 'INVALID_QUERY', '查询参数不支持');
  const integer = (name, fallback, min, max) => {
    if (query[name] === undefined) return fallback;
    if (typeof query[name] !== 'string' || !/^\d+$/.test(query[name])) throw new AppError(400, 'INVALID_QUERY', `${name} 必须是整数`);
    const value = Number(query[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new AppError(400, 'INVALID_QUERY', `${name} 超出范围`);
    return value;
  };
  if (query.completed !== undefined && !['true', 'false'].includes(query.completed)) throw new AppError(400, 'INVALID_QUERY', 'completed 应为 true 或 false');
  return { limit: integer('limit', 20, 1, 100), offset: integer('offset', 0, 0, 1000000), completed: query.completed === undefined ? undefined : query.completed === 'true' };
}
