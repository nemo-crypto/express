import { open, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, INITIAL_POOLS } from './domain.js';

export function initialState() {
  return {
    schemaVersion: 1, chain: { height: 1, pools: structuredClone(INITIAL_POOLS), transactions: {}, nextScenario: 'normal' },
    market: { sequence: 0, pools: [], updatedAt: 0, duplicates: 0, backfilled: 0, rejected: 0 },
    feedHistory: [], quotes: {}, orders: {}, audit: [],
    config: { version: 1, ...DEFAULT_CONFIG }, configHistory: [{ version: 1, ...DEFAULT_CONFIG }],
    metrics: { rpcErrors: 0, retries: 0, broadcasts: 0 },
  };
}

/** 单进程教学仓库；回调必须同步，状态先持久化再对外可见。 */
export class DexStore {
  #state; #pending = Promise.resolve(); #file; #lock; #closed = false;
  constructor(state, file, lock) { this.#state = state; this.#file = file; this.#lock = lock; }
  static async open(file) {
    if (!file) return new DexStore(initialState());
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const lock = await open(`${file}.lock`, 'wx', 0o600);
    try {
      let state = initialState();
      try {
        state = JSON.parse(await readFile(file, 'utf8'));
        if (state.schemaVersion !== 1 || !Array.isArray(state.chain?.pools) || !state.orders ||
          !state.config || !Array.isArray(state.audit) || !Array.isArray(state.feedHistory) || !state.market || !state.metrics) {
          throw new Error('DEX 存储结构不合法');
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return new DexStore(state, file, lock);
    } catch (error) { await lock.close(); await unlink(`${file}.lock`); throw error; }
  }
  async read() { await this.#pending; return structuredClone(this.#state); }
  change(callback) {
    if (this.#closed) return Promise.reject(new Error('DEX store 已关闭'));
    const operation = this.#pending.then(async () => {
      const next = structuredClone(this.#state);
      const result = callback(next);
      if (result instanceof Promise) throw new Error('存储事务不能包含异步副作用');
      if (this.#file) {
        const temporary = `${this.#file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
          await rename(temporary, this.#file);
        } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      }
      this.#state = next;
      return structuredClone(result);
    });
    this.#pending = operation.catch(() => {});
    return operation;
  }
  async close() {
    this.#closed = true;
    await this.#pending;
    if (this.#lock) { await this.#lock.close(); this.#lock = null; await unlink(`${this.#file}.lock`); }
  }
}

export function audit(state, now, action, details) {
  state.audit.push({ id: randomUUID(), at: now, actor: 'local-demo', action, ...details });
  state.audit = state.audit.slice(-500);
}
