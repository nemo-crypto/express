import { configInput, fail, integer, object, SCENARIOS } from './domain.js';
import { DexStore, audit } from './store.js';
import { MockChain, MockSigner } from './mock-chain.js';
import { MarketRuntime } from './market.js';
import { TradingService } from './trading.js';

export async function createDexRuntime({ file, now = Date.now, logger = console } = {}) {
  const store = await DexStore.open(file);
  const chain = new MockChain(store, now);
  const market = new MarketRuntime(store, chain, now);
  market.setMaxListeners(20);
  const trading = new TradingService(store, chain, new MockSigner(), now);
  let timer = null;
  let running = null;
  let closed = false;
  let workerError = null;

  const runtime = {
    store, chain, market, trading,
    async tick() {
      if (closed) fail(503, 'RUNTIME_CLOSED', '运行时已停止');
      if (running) return running;
      running = (async () => {
        await market.produce();
        await trading.processAll();
        workerError = null;
      })();
      try { await running; } finally { running = null; }
      return runtime.overview();
    },
    start() {
      if (timer || closed) return;
      timer = setInterval(() => runtime.tick().catch((error) => {
        workerError = 'WORKER_ERROR';
        // 不打印交易签名、认证头或任意异常对象。
        logger.error?.(JSON.stringify({ event: 'dex.worker.failed', code: error.code || 'WORKER_ERROR' }));
      }), 1000);
      timer.unref();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      timer = null;
      if (running) await running.catch(() => {});
      await market.idle();
      market.emit('shutdown');
      market.removeAllListeners();
      await store.close();
    },
    async config() { const state = await store.read(); return { current: state.config, history: state.configHistory }; },
    async updateConfig(body, rollback = false) {
      object(body, rollback ? ['expectedVersion', 'targetVersion'] : ['expectedVersion', 'patch']);
      integer(body.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER);
      return store.change((state) => {
        if (body.expectedVersion !== state.config.version) fail(409, 'CONFIG_CONFLICT', '配置版本冲突，请重新读取');
        let patch = body.patch;
        if (rollback) {
          integer(body.targetVersion, 'targetVersion', 1, state.config.version);
          const target = state.configHistory.find((item) => item.version === body.targetVersion);
          if (!target) fail(404, 'CONFIG_NOT_FOUND', '目标配置已不在历史窗口');
          const { version, ...values } = target;
          patch = values;
        }
        object(patch, Object.keys(state.config).filter((key) => key !== 'version'));
        if (!Object.keys(patch).length) fail(400, 'EMPTY_CONFIG', '配置不能为空');
        const { version, ...current } = state.config;
        const values = configInput(patch, current);
        state.config = { version: version + 1, ...values };
        state.configHistory.push(state.config);
        state.configHistory = state.configHistory.slice(-20);
        audit(state, now(), rollback ? 'config.rollback' : 'config.updated', { version: version + 1, targetVersion: rollback ? body.targetVersion : null });
        return state.config;
      });
    },
    async scenario(body) {
      object(body, ['scenario']);
      if (!SCENARIOS.includes(body.scenario)) fail(400, 'INVALID_SCENARIO', '模拟场景不支持');
      return store.change((state) => {
        state.chain.nextScenario = body.scenario;
        audit(state, now(), 'demo.scenario', { scenario: body.scenario });
        return { nextScenario: body.scenario };
      });
    },
    async unstick(txHash) {
      return store.change((state) => {
        const tx = Object.hasOwn(state.chain.transactions, txHash) ? state.chain.transactions[txHash] : null;
        if (!tx || tx.scenario !== 'stuck') fail(404, 'TRANSACTION_NOT_STUCK', '未找到卡住的模拟交易');
        tx.scenario = 'normal';
        audit(state, now(), 'demo.unstick', { txHash });
        return { txHash };
      });
    },
    async overview() {
      const state = await store.read();
      const orders = Object.values(state.orders);
      const statuses = {};
      for (const order of orders) statuses[order.status] = (statuses[order.status] ?? 0) + 1;
      const completed = (statuses.confirmed ?? 0) + (statuses.failed ?? 0);
      const confirmed = orders.filter((item) => item.status === 'confirmed');
      const latency = confirmed.map((item) => item.confirmedAt - item.createdAt);
      const receipts = orders.flatMap((item) => item.receipt ? [item.receipt] : []);
      const gas = receipts.reduce((sum, receipt) => sum + BigInt(receipt.gasWei), 0n);
      const ageMs = state.market.sequence ? Math.max(0, now() - state.market.updatedAt) : null;
      const alerts = [];
      if (ageMs === null || ageMs > 5000) alerts.push('MARKET_STALE');
      if (statuses.attention) alerts.push('ORDERS_NEED_ATTENTION');
      if (orders.some((order) => order.status === 'signed' && order.reason === 'RPC_TIMEOUT')) alerts.push('RPC_RETRYING');
      if (workerError) alerts.push(workerError);
      return {
        mode: 'local-simulation', chainId: 'demo-local', block: state.chain.height,
        feed: { connected: market.connected, sequence: state.market.sequence, ageMs, duplicates: state.market.duplicates, backfilled: state.market.backfilled, rejected: state.market.rejected },
        orders: { total: orders.length, byStatus: statuses, successRate: completed ? (statuses.confirmed ?? 0) / completed : null,
          successRateDenominator: 'confirmed + failed (including preflight failures)',
          averageConfirmedLatencyMs: latency.length ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) : null },
        execution: { ...state.metrics, totalGasWei: gas.toString(), averageGasWei: receipts.length ? (gas / BigInt(receipts.length)).toString() : null },
        alerts, configVersion: state.config.version,
      };
    },
  };
  try { await market.produce(); } catch (error) { await runtime.close(); throw error; }
  return runtime;
}
