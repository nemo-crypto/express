import { createHash, createHmac } from 'node:crypto';
import { quotePool } from './domain.js';

export const DEMO_GAS_WEI = '180000000000000';
const hash = (value) => '0x' + createHash('sha256').update(value).digest('hex');

/** 教学用签名适配器：HMAC 信封不是 Ethereum 交易，也不能广播到真实节点。 */
export class MockSigner {
  sign(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', 'PUBLIC-LOCAL-DEMO-KEY').update(encoded).digest('hex');
    const raw = `${encoded}.${signature}`;
    return { raw, hash: hash(raw) };
  }
}

/** 模拟节点：相同 raw/hash 重播返回同一笔交易，接收后丢回执也不会创建第二笔。 */
export class MockChain {
  constructor(store, now) { this.store = store; this.now = now; }
  async broadcast(signed, payload) {
    const result = await this.store.change((state) => {
      if (hash(signed.raw) !== signed.hash) throw new Error('模拟交易 hash 不匹配');
      if (state.chain.transactions[signed.hash]) return { hash: signed.hash };
      const scenario = state.chain.nextScenario;
      state.chain.nextScenario = 'normal';
      if (scenario === 'rpc-timeout') return { error: 'RPC_TIMEOUT' };
      state.chain.transactions[signed.hash] = {
        hash: signed.hash, payload, scenario, acceptedAt: this.now(), block: null,
        receipt: null,
      };
      state.metrics.broadcasts++;
      return scenario === 'ack-lost' ? { error: 'ACK_LOST' } : { hash: signed.hash };
    });
    if (result.error) { const error = new Error(result.error); error.code = result.error; throw error; }
    return result.hash;
  }
  async lookup(txHash) { return (await this.store.read()).chain.transactions[txHash] ?? null; }
  async mine() {
    return this.store.change((state) => {
      state.chain.height++;
      for (const tx of Object.values(state.chain.transactions)) {
        if (tx.receipt || tx.scenario === 'stuck') continue;
        const pool = state.chain.pools.find((item) => item.id === tx.payload.poolId);
        const amount = BigInt(tx.payload.amountIn);
        // 模拟成交前池子变动，仍由真实的 minOut 检查决定成功与否。
        if (tx.scenario === 'slippage') pool.reserve1 = (BigInt(pool.reserve1) * 80n / 100n).toString();
        const amountOut = quotePool(pool, tx.payload.tokenIn, amount);
        const reason = this.now() >= tx.payload.expiresAt ? 'DEADLINE_EXCEEDED' : tx.scenario === 'revert' ? 'EXECUTION_REVERTED' : amountOut < BigInt(tx.payload.minOut) ? 'SLIPPAGE_EXCEEDED' : null;
        tx.block = state.chain.height;
        tx.receipt = { success: !reason, reason, amountOut: reason ? '0' : amountOut.toString(), gasWei: DEMO_GAS_WEI };
        if (!reason) {
          const forward = tx.payload.tokenIn === pool.token0;
          const inputKey = forward ? 'reserve0' : 'reserve1';
          const outputKey = forward ? 'reserve1' : 'reserve0';
          pool[inputKey] = (BigInt(pool[inputKey]) + amount).toString();
          pool[outputKey] = (BigInt(pool[outputKey]) - amountOut).toString();
        }
      }
      return { height: state.chain.height, pools: state.chain.pools };
    });
  }
}
