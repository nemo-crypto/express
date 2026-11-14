import { createHash, randomUUID } from 'node:crypto';
import { TOKENS, fail, formatUnits, integer, object, parseUnits, quotePool } from './domain.js';
import { DEMO_GAS_WEI } from './mock-chain.js';
import { audit } from './store.js';

const TERMINAL = new Set(['confirmed', 'failed']);
const publicOrder = ({ signed, payload, fingerprint, ...order }) => order;

function tradingAllowed(state, account) {
  if (!state.config.tradingEnabled) fail(409, 'TRADING_PAUSED', '策略已暂停');
  const bucket = createHash('sha256').update(account).digest().readUInt32BE(0) % 100;
  if (bucket >= state.config.rolloutPercent) fail(403, 'ROLLOUT_DISABLED', '当前模拟账号未进入策略灰度');
}

export class TradingService {
  #working = new Set();
  constructor(store, chain, signer, now) { Object.assign(this, { store, chain, signer, now }); }
  async quote(body) {
    object(body, ['tokenIn', 'tokenOut', 'amountIn', 'slippageBps']);
    if (!(Object.hasOwn(TOKENS, body.tokenIn)) || !(Object.hasOwn(TOKENS, body.tokenOut)) || body.tokenIn === body.tokenOut) {
      fail(400, 'UNSUPPORTED_PAIR', '仅支持 WETH ↔ USDC');
    }
    const amountIn = parseUnits(body.amountIn, body.tokenIn);
    return this.store.change((state) => {
      if (!state.market.sequence || this.now() - state.market.updatedAt > 5000) fail(503, 'MARKET_STALE', '行情未就绪或超过 5 秒未更新');
      const slippageBps = integer(body.slippageBps ?? 100, 'slippageBps', 0, state.config.maxSlippageBps);
      const routes = state.market.pools.map((pool) => ({ poolId: pool.id, amountOut: quotePool(pool, body.tokenIn, amountIn).toString() }))
        .sort((a, b) => BigInt(a.amountOut) > BigInt(b.amountOut) ? -1 : BigInt(a.amountOut) < BigInt(b.amountOut) ? 1 : 0);
      const best = routes[0];
      if (BigInt(best.amountOut) <= 0n) fail(400, 'AMOUNT_TOO_SMALL', '报价输出为零');
      const minOut = (BigInt(best.amountOut) * BigInt(10000 - slippageBps) / 10000n).toString();
      if (BigInt(minOut) === 0n) fail(400, 'AMOUNT_TOO_SMALL', '最小输出为零');
      // 过期报价可淘汰，订单保存自己的完整执行载荷。
      for (const [id, quote] of Object.entries(state.quotes)) if (quote.expiresAt <= this.now()) delete state.quotes[id];
      if (Object.keys(state.quotes).length >= 500) fail(429, 'CAPACITY_REACHED', '有效报价过多');
      const quote = {
        id: randomUUID(), tokenIn: body.tokenIn, tokenOut: body.tokenOut,
        amountIn: amountIn.toString(), amountOut: best.amountOut, minOut, slippageBps,
        poolId: best.poolId, routes, gasWei: DEMO_GAS_WEI, marketSequence: state.market.sequence,
        createdAt: this.now(), expiresAt: this.now() + state.config.quoteTtlMs,
        display: { amountIn: formatUnits(amountIn, body.tokenIn), amountOut: formatUnits(best.amountOut, body.tokenOut) },
      };
      state.quotes[quote.id] = quote;
      return quote;
    });
  }
  async create(body, key) {
    object(body, ['quoteId', 'account']);
    const account = body.account ?? 'demo';
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key) || typeof account !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(account) || typeof body.quoteId !== 'string') {
      fail(400, 'INVALID_ORDER', '需要有效 Idempotency-Key、quoteId 与模拟账号');
    }
    const fingerprint = `${account}:${body.quoteId}`;
    return this.store.change((state) => {
      const existing = Object.values(state.orders).find((order) => order.key === key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同请求');
        return { order: publicOrder(existing), reused: true };
      }
      tradingAllowed(state, account);
      const quote = Object.hasOwn(state.quotes, body.quoteId) ? state.quotes[body.quoteId] : null;
      if (!quote || quote.expiresAt <= this.now()) fail(409, 'QUOTE_EXPIRED', '报价已过期，请重新报价');
      if (BigInt(quote.gasWei) > BigInt(state.config.maxGasWei)) fail(409, 'GAS_LIMIT', '模拟 gas 成本超过策略上限');
      if (quote.slippageBps > state.config.maxSlippageBps) fail(409, 'SLIPPAGE_POLICY', '报价超出当前滑点策略');
      if (Object.keys(state.orders).length >= 1000) fail(429, 'CAPACITY_REACHED', '最多保存 1000 笔模拟订单');
      const order = {
        id: randomUUID(), key, account, fingerprint, quoteId: quote.id,
        status: 'queued', createdAt: this.now(), updatedAt: this.now(), attempts: 0,
        nextAttemptAt: 0, txHash: null, reason: null, configVersion: state.config.version,
        slippageBps: quote.slippageBps,
        payload: { poolId: quote.poolId, tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, amountIn: quote.amountIn, minOut: quote.minOut, expiresAt: quote.expiresAt },
      };
      state.orders[order.id] = order;
      audit(state, this.now(), 'order.created', { orderId: order.id, status: 'queued' });
      return { order: publicOrder(order), reused: false };
    });
  }
  async list() { return Object.values((await this.store.read()).orders).reverse().map(publicOrder); }
  async get(id) {
    const orders = (await this.store.read()).orders;
    const order = Object.hasOwn(orders, id) ? orders[id] : null;
    if (!order) fail(404, 'ORDER_NOT_FOUND', '模拟订单不存在');
    return publicOrder(order);
  }
  async #update(id, patch, action) {
    return this.store.change((state) => {
      Object.assign(state.orders[id], patch, { updatedAt: this.now() });
      audit(state, this.now(), action, { orderId: id, status: state.orders[id].status, reason: state.orders[id].reason });
      return state.orders[id];
    });
  }
  async process(id) {
    if (this.#working.has(id)) return;
    this.#working.add(id);
    try {
      let state = await this.store.read();
      let order = state.orders[id];
      if (!order || TERMINAL.has(order.status) || order.status === 'attention') return;
      if (order.status === 'queued') {
        try {
          tradingAllowed(state, order.account);
          if (order.slippageBps > state.config.maxSlippageBps) fail(409, 'SLIPPAGE_POLICY', '执行前滑点策略已收紧');
          if (this.now() >= order.payload.expiresAt) fail(409, 'QUOTE_EXPIRED', '执行前报价已过期');
          if (BigInt(DEMO_GAS_WEI) > BigInt(state.config.maxGasWei)) fail(409, 'GAS_LIMIT', '执行前 gas 策略已收紧');
          const signed = this.signer.sign({ ...order.payload, orderId: id });
          order = await this.#update(id, { status: 'signed', signed, txHash: signed.hash }, 'order.signed');
        } catch (error) {
          if (!error.code) throw error;
          await this.#update(id, { status: 'failed', reason: error.code }, 'order.blocked');
          return;
        }
      }
      // 先按已保存 hash 查询，处理“节点已接受，但广播响应丢失”。
      const tx = order.txHash ? await this.chain.lookup(order.txHash) : null;
      if (tx) {
        if (tx.receipt) {
          state = await this.store.read();
          if (state.chain.height - tx.block + 1 >= state.config.confirmations) {
            await this.#update(id, {
              status: tx.receipt.success ? 'confirmed' : 'failed', receipt: tx.receipt,
              reason: tx.receipt.reason, confirmedAt: this.now(),
            }, 'order.finalized');
            return;
          }
        }
        if (this.now() - tx.acceptedAt >= state.config.stuckAfterMs && !tx.receipt) {
          await this.#update(id, { status: 'attention', reason: 'TRANSACTION_STUCK' }, 'order.attention');
        } else if (order.status !== 'submitted') {
          await this.#update(id, { status: 'submitted', reason: null }, 'order.submitted');
        }
        return;
      }
      if (order.nextAttemptAt > this.now()) return;
      // 暂停/灰度关闭阻止尚未被节点接受的广播；不阻止已广播订单的回执核对。
      try {
        state = await this.store.read();
        tradingAllowed(state, order.account);
        if (order.slippageBps > state.config.maxSlippageBps) fail(409, 'SLIPPAGE_POLICY', '广播前滑点策略已收紧');
        if (BigInt(DEMO_GAS_WEI) > BigInt(state.config.maxGasWei)) fail(409, 'GAS_LIMIT', '广播前 gas 超出策略上限');
      }
      catch (error) { await this.#update(id, { reason: error.code }, 'order.broadcast-paused'); return; }
      order = await this.#update(id, { attempts: order.attempts + 1 }, 'order.broadcast-attempt');
      if (order.attempts > 1) await this.store.change((next) => { next.metrics.retries++; });
      try {
        await this.chain.broadcast(order.signed, order.payload);
        await this.#update(id, { status: 'submitted', reason: null }, 'order.submitted');
      } catch (error) {
        if (!['RPC_TIMEOUT', 'ACK_LOST'].includes(error.code)) throw error;
        await this.store.change((next) => { next.metrics.rpcErrors++; });
        // 最后一次响应丢失也不能直接判失败：下一轮先按 hash 核验。
        const exhausted = order.attempts >= state.config.maxAttempts;
        const accepted = await this.chain.lookup(order.txHash);
        await this.#update(id, {
          status: accepted ? 'submitted' : exhausted ? 'attention' : 'signed',
          reason: accepted ? null : exhausted ? 'RETRIES_EXHAUSTED' : error.code,
          nextAttemptAt: this.now() + Math.min(10000, state.config.retryBaseMs * 2 ** (order.attempts - 1)),
        }, accepted ? 'order.broadcast-reconciled' : 'order.retry-scheduled');
      }
    } finally { this.#working.delete(id); }
  }
  async processAll() {
    for (const order of await this.list()) await this.process(order.id);
  }
  /** 人工核验只恢复原签名/hash 的追踪，不创建替换交易。 */
  async reconcile(id) {
    const order = await this.get(id);
    if (order.status !== 'attention') fail(409, 'INVALID_STATE', '仅 attention 订单可人工恢复追踪');
    await this.#update(id, { status: order.txHash ? 'signed' : 'queued', reason: null, attempts: 0, nextAttemptAt: 0 }, 'order.reconcile');
    await this.process(id);
    return this.get(id);
  }
}
