const $ = (id) => document.getElementById(id);
let quote = null;
let quoteVersion = 0;
let submitting = false;
let orderKey = null;
let configVersion = null;
let busy = false;
let disposed = false;
const show = (id, value) => { $(id).textContent = JSON.stringify(value, null, 2); };
const notify = (message) => { $('notice').textContent = message; };
async function api(method, path, body, headers = {}) {
  const response = await fetch(`/api/dex${path}`, {
    method, headers: { Authorization: `Bearer ${$('token').value}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error?.code ?? response.status}：${result.error?.message ?? '请求失败'}`);
  return result;
}
async function action(button, operation) {
  if (button.disabled) return;
  button.disabled = true;
  try { await operation(); await refresh(); }
  catch (error) { notify(error.message); }
  finally { button.disabled = button.id === 'trade' && !quote; }
}
function renderOrders(items) {
  const fragment = document.createDocumentFragment();
  for (const order of items) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = order.id.slice(0, 8);
    button.addEventListener('click', () => { $('order-id').value = order.id; $('tx-hash').value = order.txHash ?? ''; notify(`已选择 ${order.id}`); });
    cell.append(button); row.append(cell);
    for (const value of [order.status, order.attempts, order.reason ?? '—', order.txHash ? `${order.txHash.slice(0, 14)}…` : '—']) {
      const field = document.createElement('td'); field.textContent = String(value); row.append(field);
    }
    fragment.append(row);
  }
  $('orders').replaceChildren(fragment);
}
async function refresh() {
  if (busy || disposed) return;
  busy = true;
  try {
    const [overview, orders, audit] = await Promise.all([api('GET', '/admin/overview'), api('GET', '/orders?limit=30'), api('GET', '/admin/audit?limit=12')]);
    if (disposed) return;
    show('overview', overview); show('audit', audit.items); renderOrders(orders.items);
  } catch (error) { if (!disposed) notify(error.message); }
  finally { busy = false; }
}
async function loadConfig() {
  const { current, history } = await api('GET', '/admin/config');
  configVersion = current.version;
  $('enabled').checked = current.tradingEnabled; $('rollout').value = current.rolloutPercent; $('max-slip').value = current.maxSlippageBps;
  $('config-version').textContent = `当前配置 v${current.version}；保存使用版本校验，回滚会创建新版本。`;
  $('versions').replaceChildren(...history.map((item) => {
    const option = document.createElement('option'); option.value = item.version; option.textContent = `版本 ${item.version}`; return option;
  }));
}
$('refresh').addEventListener('click', () => action($('refresh'), async () => { await loadConfig(); notify('已连接本地管理 API。'); }));
function invalidateQuote() {
  quoteVersion++; quote = null; orderKey = null; $('trade').disabled = true;
  show('quote', '参数已变更，请重新获取报价。');
}
for (const id of ['pair', 'amount', 'slippage']) $(id).addEventListener('input', invalidateQuote);
$('quote-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (submitting) return;
  action(event.submitter, async () => {
    invalidateQuote();
    const version = quoteVersion;
    const tokenIn = $('pair').value;
    const result = await api('POST', '/quotes', { tokenIn, tokenOut: tokenIn === 'WETH' ? 'USDC' : 'WETH', amountIn: $('amount').value, slippageBps: Number($('slippage').value) });
    if (version !== quoteVersion) return;
    quote = result;
    orderKey = crypto.randomUUID(); show('quote', quote); $('trade').disabled = false;
    notify(`报价已生成，最优池 ${quote.poolId}，有效期 ${new Date(quote.expiresAt).toLocaleTimeString()}。`);
  });
});
$('trade').addEventListener('click', () => action($('trade'), async () => {
  if (!quote) return;
  // 请求结果未知时保留原 key，重试不会自动创建另一笔订单。
  submitting = true;
  let result;
  try { result = await api('POST', '/orders', { quoteId: quote.id }, { 'Idempotency-Key': orderKey }); }
  finally { submitting = false; }
  $('order-id').value = result.order.id;
  quote = null; orderKey = null;
  notify(`订单 ${result.order.id} 已进入 ${result.order.status}；可观察后续确认状态。`);
}));
for (const [id, path, body] of [
  ['disconnect', '/admin/feed', { connected: false }], ['reconnect', '/admin/feed', { connected: true }], ['tick', '/admin/tick', {}],
]) $(id).addEventListener('click', () => action($(id), async () => { await api('POST', path, body); notify('操作完成。'); }));
$('inject').addEventListener('click', () => action($('inject'), async () => { await api('POST', '/admin/scenarios', { scenario: $('scenario').value }); notify('下一次首次广播使用已选场景。'); }));
$('unstick').addEventListener('click', () => action($('unstick'), async () => { await api('POST', '/admin/unstick', { txHash: $('tx-hash').value }); notify('已解除模拟卡住；推进区块后再恢复原 hash 追踪。'); }));
$('reconcile').addEventListener('click', () => action($('reconcile'), async () => { await api('POST', `/orders/${encodeURIComponent($('order-id').value)}/reconcile`, {}); notify('已按原 hash 恢复核验。'); }));
$('config-form').addEventListener('submit', (event) => {
  event.preventDefault(); action(event.submitter, async () => {
    await api('PATCH', '/admin/config', { expectedVersion: configVersion, patch: { tradingEnabled: $('enabled').checked, rolloutPercent: Number($('rollout').value), maxSlippageBps: Number($('max-slip').value) } });
    await loadConfig(); notify('策略已保存为新版本。');
  });
});
$('rollback').addEventListener('click', () => action($('rollback'), async () => {
  await api('POST', '/admin/config/rollback', { expectedVersion: configVersion, targetVersion: Number($('versions').value) });
  await loadConfig(); notify('已将所选历史配置恢复为新版本。');
}));
const stream = new EventSource('/api/dex/market/stream');
stream.addEventListener('market', (event) => { show('market', JSON.parse(event.data)); $('connection').textContent = 'SSE 行情流已连接'; });
stream.onerror = () => { $('connection').textContent = '行情流断开，浏览器将自动重连'; };
const timer = setInterval(refresh, 2000);
loadConfig().then(refresh).catch((error) => notify(error.message));
window.addEventListener('pagehide', () => { disposed = true; clearInterval(timer); stream.close(); }, { once: true });

// BFCache 恢复时重新建立轮询和 SSE，避免页面看似恢复但数据已停止。
window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });
