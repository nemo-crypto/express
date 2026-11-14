# Node.js DEX 交易 Demo：实现与演练手册

## 1. 目标与范围

把招聘要求中的数据接入、交易执行、异常恢复、策略管理和可观测性串成一个能运行、能注入故障、能写测试的项目。保留原有 `/api/tasks` 教学接口，新增代码集中在 `src/dex`，默认不开启。

这是本地模拟系统：不需要钱包、私钥、RPC 服务或测试币，不会发送真实交易。WETH/USDC、池储备、签名、区块、gas 和回执都是演示数据。不能将本项目描述为已接入真实 DEX 或生产交易系统。

| 需求方向 | Demo 的具体实现 | 代码入口 |
| --- | --- | --- |
| 池/链上数据订阅与规范化 | 全量池快照、元数据/精度校验、连续序号、去重、断开后补数、浏览器 SSE | `src/dex/market.js`、`router.js` |
| 报价、路由、签名、广播、确认 | 双池比较、双向报价、恒定乘积算法、模拟签名、hash 核验、确认数 | `domain.js`、`trading.js`、`mock-chain.js` |
| 成功率、耗时、费用和故障 | 到期、滑点、回滚、超时、回执丢失、交易卡住 | `trading.js`、`runtime.js` |
| 可追踪、可重试、避免重复执行 | 幂等键、状态审计、广播前持久化、固定 hash 重播、指数退避 | `trading.js`、`store.js` |
| 管理 API 与策略 | 订单分页、暂停、灰度、gas/滑点限制、配置版本校验、历史回滚 | `router.js`、`runtime.js` |
| 测试与排障 | HTTP/领域/持久化/SSE 测试、一键故障演练、管理页面 | `tests/dex.test.js`、`scripts/dex-demo.mjs`、`public/` |

这里的“路由”是两个直接兑换池之间择优，不含多跳、拆单、聚合器或 MEV；上游是可控制的模拟事件源，不是真实 WebSocket 节点。

## 2. 启动与页面

需要 Node.js 22.12+，推荐 24；继续使用现有 Express 5，不新增依赖。

```sh
npm ci
DEX_DEMO_ENABLED=true npm start
```

访问 **http://127.0.0.1:3000/dex-demo/**。页面提供行情、报价、交易、故障注入、订单、配置和审计。默认每秒推进一个模拟区块并处理订单。`/health` 继续提供原健康检查。

想按步骤观察状态：

```sh
DEX_DEMO_ENABLED=true DEX_AUTO_TICK=false PORT=3001 npm start
```

此时通过页面“推进 1 个区块”或管理 API 推进。行情超过 5 秒未更新就不能报价，报价前可先推进区块。报价默认 10 秒过期；手动模式不要在获取报价后长时间停顿。

想演练正常重启恢复：

```sh
DEX_DEMO_ENABLED=true DEX_DATA_FILE=./data/dex-demo.json npm start
```

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DEX_DEMO_ENABLED` | 关闭 | 只有精确值 `true` 才挂载 DEX API、页面和运行时 |
| `DEX_DEMO_TOKEN` | `demo-local-token` | 本地管理 API Bearer token，12–256 字符 |
| `DEX_AUTO_TICK` | 开启 | 精确值 `false` 禁用自动推进 |
| `DEX_DATA_FILE` | 内存 | DEX JSON 快照文件；不要与任务 `DATA_FILE` 使用相同文件 |
| `PORT` | `3000` | 仅监听 `127.0.0.1` |

服务不会自动读取 `.env`。默认 token 是公开教学值；它不是生产认证。自定义后在页面 Token 输入框填写，页面不会写入 localStorage。

无需打开浏览器的一键演练：

```sh
npm run demo:dex
```

脚本启动自己的临时本地 HTTP 服务，用可控时钟验证正常交易、断线补数、回执丢失、RPC 重试、回滚、滑点失败、卡住恢复以及配置回滚，结束后关闭服务。故障场景出现 `failed` 是预期断言，不是脚本运行失败。输出不是性能测试结果。

## 3. 架构与数据流

```text
HTTP / 管理页面
       │
       ▼
Express：requestId / 同源检查 / JSON 限制 / 错误归一化
       │
       ▼
DexRouter ──────── MarketRuntime ── SSE → 浏览器
       │                ▲
       ▼                │池快照、序号、补数
TradingService ─── MockChain ← 每秒或手动 tick
       │                │
       ├── MockSigner   │模拟执行、gas、回执
       └────────┬───────┘
                ▼
             DexStore
       串行事务 / 内存或 JSON / 审计 / 配置
```

每次 tick 先产块并更新行情，再处理订单。因此通常需要 3 次 tick：第 1 次签名广播，第 2 次打包（第 1 个确认），第 3 次达到默认的 2 个确认。订单已创建不代表成交成功。

关键分工：

- `domain.js`：币种精度、金额转换、公式、参数和配置校验。
- `store.js`：数据事务、快照和文件锁，不发送交易。
- `market.js`：上游事件校验、游标、补数和消费者通知。
- `mock-chain.js`：模拟签名/节点/区块/执行结果。
- `trading.js`：报价、订单幂等、执行、追踪和恢复。
- `runtime.js`：定时器、配置、场景注入和监控汇总。
- `router.js`：HTTP 参数、认证与响应；`public/` 是无构建步骤的管理界面。

## 4. 金额与报价

金额 API 使用十进制字符串，如 `"0.1"`，不能传 JSON 数字。内部将 WETH 转为 18 位、USDC 转为 6 位的最小单位，通过 BigInt 运算，存储和响应仍用字符串，避免 `Number` 超过安全整数或小数精度丢失。

拒绝负数、零、科学计数法、超出币种小数位和超出 uint256 的输入。

假设输入量 `dx`、输入储备 `x`、输出储备 `y`、手续费 `feeBps`：

```text
net    = dx × (10000 - feeBps)
out    = floor(net × y / (x × 10000 + net))
minOut = floor(out × (10000 - slippageBps) / 10000)
```

对两个池分别计算，选择输出最多的池；`routes` 展示候选结果。报价记录生成时间、到期时间、行情序号、最小输出和模拟 gas。实际模拟执行重新按池储备计算输出，低于 minOut 就失败，而不是直接使用报价金额成交。

`100 bps = 1%`。默认最大允许滑点为 300 bps（3%）；页面不是行情价格预测器。

## 5. HTTP 完整示例

下面使用自动推进模式，命令连续执行，避免 10 秒报价过期。shell 示例需要 `curl` 和 Node.js，不需要 jq。

```sh
export DEX_BASE=http://127.0.0.1:3000
export DEX_TOKEN=demo-local-token

curl -s "$DEX_BASE/api/dex/market"

DEX_QUOTE=$(curl -sf "$DEX_BASE/api/dex/quotes" \
  -H "Authorization: Bearer $DEX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tokenIn":"WETH","tokenOut":"USDC","amountIn":"0.1","slippageBps":100}')
DEX_QUOTE_ID=$(printf '%s' "$DEX_QUOTE" | node --input-type=module -e \
  'let s=""; for await (const c of process.stdin) s+=c; console.log(JSON.parse(s).id)')

DEX_ORDER=$(curl -sf "$DEX_BASE/api/dex/orders" \
  -H "Authorization: Bearer $DEX_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: tutorial-order-0001' \
  -d "{\"quoteId\":\"$DEX_QUOTE_ID\",\"account\":\"demo\"}")
printf '%s\n' "$DEX_ORDER"

curl -s "$DEX_BASE/api/dex/orders?limit=20&offset=0" \
  -H "Authorization: Bearer $DEX_TOKEN"
```

重复提交**同一请求和同一 key**，返回原订单，HTTP 200、`reused:true`；第一次为 201。不同请求复用 key 返回 409 `IDEMPOTENCY_CONFLICT`。创建新交易必须换 key。报价即使后来过期，相同 key 的已有订单仍可查回。

页面提交结果未知时会保留该 key，直接重试原报价可查回原订单；不要在未核验时改参数、重新报价并当作新交易提交。真实客户端应跨刷新持久化请求标识，本 Demo 页面不保证刷新后保留它。

### API 清单

除两个行情 GET 外，下面的 API 都要求 Bearer token。

| 方法 | 路径（前缀 `/api/dex`） | 主要参数/行为 |
| --- | --- | --- |
| GET | `/market` | 当前全量快照、连接状态、年龄与计数 |
| GET | `/market/stream` | SSE 全量行情，最多 20 个并发连接 |
| POST | `/quotes` | `tokenIn, tokenOut, amountIn, slippageBps` |
| POST | `/orders` | `quoteId, account?`，要求 Idempotency-Key |
| GET | `/orders` | `limit(1–100), offset, status?` |
| GET | `/orders/:id` | 状态、hash、回执；隐藏签名原文 |
| POST | `/orders/:id/reconcile` | 仅 attention 订单，恢复原 hash 核验 |
| GET | `/admin/overview` | 行情/执行/订单汇总与告警 |
| GET | `/admin/config` | 当前版本和历史版本 |
| PATCH | `/admin/config` | `expectedVersion, patch` |
| POST | `/admin/config/rollback` | `expectedVersion, targetVersion` |
| GET | `/admin/audit` | `limit, offset`，最近操作在前 |
| POST | `/admin/scenarios` | `scenario`，下一次首次广播的故障 |
| POST | `/admin/tick` | 推进模拟区块和 worker |
| POST | `/admin/feed` | `connected:boolean`，断开/恢复上游 |
| POST | `/admin/events` | 事件重放/校验，仅供本地实验 |
| POST | `/admin/unstick` | `txHash`，解除模拟卡住 |

未知字段会拒绝。错误响应沿用 `{error:{code,message,requestId}}`；服务日志包含 requestId、方法、路径、状态、耗时，不输出签名或认证头。

## 6. 订单状态与幂等

```text
queued → signed → submitted → confirmed
   │        │         └────→ failed（回执失败）
   │        └→ attention（重试耗尽）
   │                  ▲
   └→ failed          └── submitted（长时间未打包）
     （执行前校验）

attention → 人工 reconcile → 按原 hash 继续追踪
```

- queued：接受订单，但尚未签名。再次检查暂停、灰度、滑点策略、gas 和到期时间。
- signed：已保存签名和 hash；还未确认节点接受。先 lookup，再考虑广播。
- submitted：节点已接受；即使暂停策略也继续查回执，不把已经接受的交易当作撤销。
- confirmed：回执成功且达到确认数。
- failed：已知执行前拒绝或回执失败；不能用“网络超时”直接推断失败。
- attention：卡住或重试耗尽，需要人工核验；可能已经存在交易，不能直接生成新 hash。

防重复分三层：创建订单用幂等键；进程内 workingSet 防同一订单并行执行；节点按已持久化的 hash 去重。同一签名重复发送不会生成第二笔模拟交易。

RPC 超时默认最多 3 次尝试，间隔 1 秒、2 秒，指数增长并封顶 10 秒。每次重发前都核验原 hash。回执丢失则能查到已接受交易，直接转 submitted。重试期间收紧暂停、灰度、gas 或滑点规则会暂缓未接受的广播；恢复策略后继续原 hash。

这不是分布式 exactly-once 保证。演示节点与订单共享快照，无法代替真实链上 nonce 管理、节点一致性与数据库事务设计。

## 7. 故障演练

先在页面设置场景，再报价、提交，观察订单与审计。场景是全局“下一次首次广播”，多个订单并发时不保证作用于指定订单。

| 场景 | 触发点 | 预期 |
| --- | --- | --- |
| `normal` | 正常接受 | 默认两次确认后 confirmed |
| `rpc-timeout` | 节点接受前超时，一次性 | signed → 退避重试同一 hash → confirmed |
| `ack-lost` | 已接受但广播响应丢失 | lookup 找回，唯一接受数不重复增加 |
| `revert` | 模拟执行失败 | failed / EXECUTION_REVERTED，仍消耗模拟 gas |
| `slippage` | 执行前 USDC 储备降低 20% | WETH→USDC、100 bps 时 failed / SLIPPAGE_EXCEEDED |
| `stuck` | 一直不打包 | 默认 30 秒后 attention / TRANSACTION_STUCK |

滑点场景对反向兑换可能成为更优价格，并不保证失败。报价到期优先判断，拖延操作也可能先得到 DEADLINE_EXCEEDED。

### 断线与补数

页面点“断开上游”，持续推进几个区块，再“重连补数”。上游仍产生区块，消费者游标停住；重连从最近 256 条历史补齐缺口，再应用当前事件。重复序号不重复生效；非法池、倒退时间或区块拒绝处理。

超过保留窗口返回 BACKFILL_UNAVAILABLE，不伪造连续性。Demo 未实现在线全量重建接口；可停止服务、换一个新的演示数据文件重新开始，保留旧文件供排查。

SSE 是到浏览器的下游传输，自动重连后发送最新全量快照，不承诺逐条重放所有 SSE 消息。慢客户端遇到写缓冲背压会断开，连接关闭清理监听器和心跳。

### 卡住与恢复

默认 stuckAfterMs=30000、quoteTtlMs=10000，卡住到需要人工介入时通常已过 deadline。解除模拟卡住并推进区块，再 reconcile，只会追踪原 hash，最终可能因 DEADLINE_EXCEEDED 失败，这是正确结果。若要演示卡住后仍成功，可先将 quoteTtlMs 调为 60000、stuckAfterMs 调为 1000，再快速操作。

手动 tick 不会加速真实时钟。RPC 退避、过期和卡住判定仍需实际经过对应毫秒；一键脚本和测试才使用可控时钟。

## 8. 策略配置、灰度与回滚

```sh
curl -s -X PATCH "$DEX_BASE/api/dex/admin/config" \
  -H "Authorization: Bearer $DEX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"expectedVersion":1,"patch":{"rolloutPercent":0}}'

curl -s -X POST "$DEX_BASE/api/dex/admin/config/rollback" \
  -H "Authorization: Bearer $DEX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"expectedVersion":2,"targetVersion":1}'
```

示例假设全新数据：初始 v1 → 修改 v2 → 回滚内容后生成 v3。版本不匹配返回 CONFIG_CONFLICT，重新读取后再决定更新，不覆盖其他操作。

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| tradingEnabled | true | 阻止新交易及未接受广播；已接受交易继续核验 |
| rolloutPercent | 100 | SHA256(account) 的稳定桶与百分比比较 |
| maxSlippageBps | 300 | 报价、提交、执行前/重发前检查 |
| quoteTtlMs | 10000 | 新报价 TTL；不延长旧订单 deadline |
| maxGasWei | `"500000000000000"` | 模拟 gas 成本上限，整数字符串 |
| maxAttempts | 3 | RPC 错误的自动尝试上限，1–5 |
| retryBaseMs | 1000 | 指数退避基数，100–10000 ms |
| confirmations | 2 | 确认数，1–12 |
| stuckAfterMs | 30000 | 未打包需人工核验阈值，1000–300000 ms |

这里的 account 只是用户可传的演示命名空间，不是认证身份，灰度也不是权限控制。配置历史保留最近 20 版，审计保留最近 500 条。配置回滚不会撤销已广播交易。服务代码版本回滚属于部署流程，本项目没有实现发布平台。

## 9. 监控口径与排障

管理页面每 2 秒查询汇总、订单和审计，行情使用 SSE。

- successRate = confirmed / (confirmed + failed)，包括执行前失败；没有已结束订单时为 null。不能把 pending/attention 计入失败。
- averageConfirmedLatencyMs 是成功订单从创建到满足确认数的平均耗时，不等同真实 RPC 延迟。
- totalGasWei 包括已完成核验的成功和失败回执；执行前失败没有 gas。
- broadcasts 是模拟节点唯一接受交易数，不是所有发送尝试数；每单 attempts 是广播尝试数。
- rpcErrors 计模拟 RPC_TIMEOUT 与 ACK_LOST；retries 计后续广播尝试。
- MARKET_STALE、RPC_RETRYING、ORDERS_NEED_ATTENTION、WORKER_ERROR 是本地告警码，没有接入外部告警平台。

| 现象 | 排查 |
| --- | --- |
| DEX 路径 404 | 检查 DEX_DEMO_ENABLED 是否为 true，重启进程 |
| 401 | 页面和 curl token 是否与服务配置一致 |
| MARKET_STALE | 手动模式先 tick；检查上游是否断开或缺口超限 |
| QUOTE_EXPIRED | 重新报价；不要把旧 key 改用于新 quoteId |
| TRADING_PAUSED / ROLLOUT_DISABLED | 查询配置和 account，不绕过保护 |
| GAS_LIMIT / SLIPPAGE_POLICY | 检查最新策略及报价；策略可在排队或重试期间改变 |
| attention | 查审计和 hash，先 reconcile，不直接新建替代交易 |
| CONFIG_CONFLICT | 读取最新版本，重新确认修改意图 |
| 文件锁 EEXIST | 确认是否已有进程；确认没有进程后再人工处理遗留锁 |
| 存储损坏拒绝启动 | 保留原文件排查，不自动清空重置 |

订单最多 1000 条、有效报价最多 500 条；达到容量会拒绝继续创建。长期运行需换新数据文件或实现归档，Demo 不自动删除订单来掩盖幂等历史丢失。

## 10. 验证与扩展练习

```sh
npm run check
npm run demo:dex
```

`node:test` + Supertest 覆盖金额精度、参数/认证、旧任务兼容、择优报价、确认数、并发幂等、行情补数与重复、过期行情、超时退避、回执丢失、卡住、滑点、配置 CAS/灰度/回滚、文件锁/损坏/重启、SSE 清理、UI 资源/CSP、排队后策略收紧。测试使用内存或临时文件，不依赖外部服务。

阅读建议：domain → store → mock-chain → market → trading → runtime → router → tests。随后自行练习加入第三个池、增加一次超时场景，先写失败测试再实现。

接真实链必须另行设计：ABI/log 解码和重组回退、RPC 超时/多节点切换、nonce 与替换交易、钱包/HSM 签名、余额与授权、真实 gas 估算、报价区块一致性、多进程数据库锁、身份权限与审计归档。当前 JSON 存储的串行写和 rename 不等同数据库或断电级持久性，不能直接承载真实资金。
