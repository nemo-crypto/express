import { EventEmitter } from 'node:events';
import { INITIAL_POOLS, fail, integer, object, uint } from './domain.js';

function validateEvent(event, now) {
  object(event, ['sequence', 'block', 'timestamp', 'pools']);
  integer(event.sequence, 'sequence', 1, Number.MAX_SAFE_INTEGER);
  integer(event.block, 'block', 1, Number.MAX_SAFE_INTEGER);
  integer(event.timestamp, 'timestamp', 0, now + 5000);
  if (!Array.isArray(event.pools) || event.pools.length !== INITIAL_POOLS.length) fail(400, 'INVALID_EVENT', '行情必须包含完整池快照');
  const ids = new Set();
  for (const pool of event.pools) {
    object(pool, ['id', 'token0', 'token1', 'reserve0', 'reserve1', 'feeBps']);
    const expected = INITIAL_POOLS.find((item) => item.id === pool.id);
    if (!expected || ids.has(pool.id) || expected.token0 !== pool.token0 || expected.token1 !== pool.token1 || pool.feeBps !== expected.feeBps) {
      fail(400, 'INVALID_EVENT', '池元数据不匹配');
    }
    ids.add(pool.id);
    if (uint(pool.reserve0) >= 2n ** 256n || uint(pool.reserve1) >= 2n ** 256n) fail(400, 'INVALID_EVENT', '储备超出 uint256');
  }
}

/** 模拟上游订阅。断开时上游仍产块，重连从有界历史中补齐连续序号。 */
export class MarketRuntime extends EventEmitter {
  #pending = Promise.resolve();
  constructor(store, chain, now) { super(); this.store = store; this.chain = chain; this.now = now; this.connected = true; }
  ingest(event) {
    const operation = this.#pending.then(async () => {
      try {
        const applied = await this.store.change((state) => {
          validateEvent(event, this.now());
          if (event.sequence <= state.market.sequence) { state.market.duplicates++; return false; }
          let events = [event];
          if (event.sequence > state.market.sequence + 1) {
            const missing = state.feedHistory.filter((item) => item.sequence > state.market.sequence && item.sequence < event.sequence);
            if (missing.length !== event.sequence - state.market.sequence - 1) fail(409, 'BACKFILL_UNAVAILABLE', '缺口超出上游历史窗口，需要完整快照重新初始化');
            events = [...missing, event];
          }
          for (const item of events) {
            validateEvent(item, this.now());
            if (item.sequence !== state.market.sequence + 1 || item.block < (state.market.block ?? 0) || item.timestamp < state.market.updatedAt) {
              fail(409, 'OUT_OF_ORDER', '行情序号、区块或时间倒退');
            }
            state.market.sequence = item.sequence;
            state.market.block = item.block;
            state.market.updatedAt = item.timestamp;
            state.market.pools = item.pools;
          }
          state.market.backfilled += events.length - 1;
          return true;
        });
        if (applied) this.emit('snapshot', await this.snapshot());
        return this.snapshot();
      } catch (error) {
        await this.store.change((state) => { state.market.rejected++; });
        throw error;
      }
    });
    this.#pending = operation.catch(() => {});
    return operation;
  }
  async produce() {
    const mined = await this.chain.mine();
    const event = await this.store.change((state) => {
      const sequence = (state.feedHistory.at(-1)?.sequence ?? 0) + 1;
      const next = { sequence, block: mined.height, timestamp: this.now(), pools: mined.pools };
      state.feedHistory.push(next);
      state.feedHistory = state.feedHistory.slice(-256);
      return next;
    });
    if (this.connected) await this.ingest(event);
    return event;
  }
  async connect(connected) {
    this.connected = connected;
    if (connected) {
      const latest = (await this.store.read()).feedHistory.at(-1);
      if (latest) await this.ingest(latest);
    }
    return this.snapshot();
  }
  async snapshot() {
    const state = await this.store.read();
    return { ...state.market, connected: this.connected, ageMs: state.market.sequence ? Math.max(0, this.now() - state.market.updatedAt) : null };
  }
  async idle() { await this.#pending; }
}
