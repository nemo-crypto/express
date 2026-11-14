import { AppError } from '../domain/task.js';

export const TOKENS = Object.freeze({ WETH: 18, USDC: 6 });
export const INITIAL_POOLS = [
  { id: 'pool-a', token0: 'WETH', token1: 'USDC', reserve0: '100000000000000000000', reserve1: '300000000000', feeBps: 30 },
  { id: 'pool-b', token0: 'WETH', token1: 'USDC', reserve0: '200000000000000000000', reserve1: '598000000000', feeBps: 5 },
];
export const DEFAULT_CONFIG = Object.freeze({
  tradingEnabled: true, rolloutPercent: 100, maxSlippageBps: 300,
  quoteTtlMs: 10000, maxGasWei: '500000000000000', maxAttempts: 3,
  retryBaseMs: 1000, confirmations: 2, stuckAfterMs: 30000,
});
export const SCENARIOS = ['normal', 'rpc-timeout', 'ack-lost', 'revert', 'stuck', 'slippage'];

export function fail(status, code, message) { throw new AppError(status, code, message); }

export function object(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))) fail(400, 'INVALID_INPUT', 'JSON 对象或字段不合法');
  return input;
}

export function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, 'INVALID_INPUT', `${name} 应为 ${min}–${max} 的整数`);
  return value;
}

export function uint(value, name = 'amount') {
  if (typeof value !== 'string' || !/^[1-9]\d{0,77}$/.test(value)) fail(400, 'INVALID_AMOUNT', `${name} 必须是正整数字符串`);
  return BigInt(value);
}

/** 金额只在字符串与 BigInt 之间转换，不经过 Number。 */
export function parseUnits(value, token) {
  const decimals = TOKENS[token];
  if (decimals === undefined || typeof value !== 'string' || value.length > 80 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    fail(400, 'INVALID_AMOUNT', '币种或金额不合法，请使用十进制字符串');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) fail(400, 'INVALID_PRECISION', `${token} 最多 ${decimals} 位小数`);
  const amount = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (amount <= 0n || amount >= 2n ** 256n) fail(400, 'INVALID_AMOUNT', '金额超出范围');
  return amount;
}

export function formatUnits(value, token) {
  const decimals = TOKENS[token];
  const digits = String(value).padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}

/** x*y=k，手续费与输出均向下取整。仅实现单池 swap 与并行候选池比价。 */
export function quotePool(pool, tokenIn, amountIn) {
  const forward = tokenIn === pool.token0;
  if (!forward && tokenIn !== pool.token1) fail(400, 'UNSUPPORTED_PAIR', '池不支持该币种');
  const reserveIn = BigInt(forward ? pool.reserve0 : pool.reserve1);
  const reserveOut = BigInt(forward ? pool.reserve1 : pool.reserve0);
  const net = amountIn * BigInt(10000 - pool.feeBps);
  return net * reserveOut / (reserveIn * 10000n + net);
}

export function configInput(body, current) {
  object(body, Object.keys(DEFAULT_CONFIG));
  const next = { ...current, ...body };
  if (typeof next.tradingEnabled !== 'boolean') fail(400, 'INVALID_CONFIG', 'tradingEnabled 必须为布尔值');
  integer(next.rolloutPercent, 'rolloutPercent', 0, 100);
  integer(next.maxSlippageBps, 'maxSlippageBps', 0, 1000);
  integer(next.quoteTtlMs, 'quoteTtlMs', 1000, 60000);
  uint(next.maxGasWei, 'maxGasWei');
  integer(next.maxAttempts, 'maxAttempts', 1, 5);
  integer(next.retryBaseMs, 'retryBaseMs', 100, 10000);
  integer(next.confirmations, 'confirmations', 1, 12);
  integer(next.stuckAfterMs, 'stuckAfterMs', 1000, 300000);
  return next;
}

export function paginate(items, query) {
  object(query, ['limit', 'offset', 'status']);
  const read = (value, fallback, max) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(400, 'INVALID_QUERY', '分页必须是整数');
    return integer(Number(value), 'pagination', 0, max);
  };
  const limit = read(query.limit, 20, 100);
  if (!limit) fail(400, 'INVALID_QUERY', 'limit 不能为零');
  const offset = read(query.offset, 0, 10000);
  if (query.status !== undefined && typeof query.status !== 'string') fail(400, 'INVALID_QUERY', 'status 必须是字符串');
  const filtered = query.status === undefined ? items : items.filter((item) => item.status === query.status);
  return { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
}
